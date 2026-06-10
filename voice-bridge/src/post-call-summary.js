import * as db from "./db.js";
import { deriveLeadNextAction, enrichSummaryMetadata } from "./lead-policy.js";
import { mergeV4SummaryMetadataPatch } from "./v4/post-call-bridge.js";

function normalizeText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function isClosingOnlyCallerText(text) {
  const lower = normalizeText(text).toLowerCase();
  if (!lower) return false;
  return (
    /^danke[.!]?$/.test(lower) ||
    /\b(danke[, ]+das reicht|das reicht erstmal|reicht erstmal|danke[, ]+das war alles|das war alles|auf wiederh[oö]ren|auf wiedersehen|tsch[uü]ss|tschuess|sch[oö]nen tag)\b/i.test(lower)
  );
}

// Phase 10AT/10AU: bare permission/acknowledgement/attention answers ("Ja.",
// "okay", "Hallo?", "Dankeschön, telefonisch bitte.") are not a caller need —
// the permission/contact state fields already carry that information.
const ACK_ONLY_PHRASE =
  "(ja|ja gerne|ja bitte|ja klar|gerne|okay|ok|einverstanden|in ordnung|alles klar|klar|genau|passt|super|gut|nein|nein danke|lieber nicht|hallo|huhu|sind sie noch da|noch da|h[oö]ren sie mich|danke|danke ?sch[oö]n|dankesch[oö]n|vielen dank|bitte|telefonisch|telefonisch bitte|bitte telefonisch|per telefon|per e-?mail)";
const ACK_ONLY_SEQUENCE = new RegExp(`^${ACK_ONLY_PHRASE}( ${ACK_ONLY_PHRASE})*$`, "i");

function isAcknowledgementOnlyCallerText(text) {
  const lower = normalizeText(text)
    .toLowerCase()
    .replace(/[.!?,;:]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!lower) return false;
  if (lower.length > 80) return false;
  return ACK_ONLY_SEQUENCE.test(lower);
}

function isUnusableCallerNeedText(text) {
  return isClosingOnlyCallerText(text) || isAcknowledgementOnlyCallerText(text);
}

function metadataField(metadata, key) {
  if (!metadata || typeof metadata !== "object") return "";
  return normalizeText(metadata[key]);
}

function parseMetadata(row) {
  const metadata = row?.metadata;
  if (!metadata) return {};
  if (typeof metadata === "object") return metadata;
  try {
    return JSON.parse(String(metadata));
  } catch {
    return {};
  }
}

function latestAssistantMetadata(turnRows) {
  const assistants = turnRows
    .filter((row) => String(row.speaker ?? "") === "assistant")
    .map((row) => parseMetadata(row));
  for (let i = assistants.length - 1; i >= 0; i -= 1) {
    if (assistants[i] && typeof assistants[i] === "object") return assistants[i];
  }
  return {};
}

function firstCallerNeed(turnRows) {
  const callerRows = turnRows.filter((row) => String(row.speaker ?? "") === "caller");
  if (!callerRows.length) return "";
  for (const row of callerRows) {
    const candidate = normalizeText(row.text);
    if (!candidate || isUnusableCallerNeedText(candidate)) continue;
    return candidate.slice(0, 220);
  }
  return "";
}

function findLastIntent(turnRows) {
  for (let i = turnRows.length - 1; i >= 0; i -= 1) {
    const metadata = parseMetadata(turnRows[i]);
    const intent = normalizeText(metadata.detected_intent ?? "");
    if (intent) return intent;
  }
  return "unknown";
}

function findProductInterest(turnRows, assistantMeta) {
  const fromLast = normalizeText(assistantMeta.product_interest_name || assistantMeta.product_interest);
  if (fromLast) return fromLast;
  for (let i = turnRows.length - 1; i >= 0; i -= 1) {
    const metadata = parseMetadata(turnRows[i]);
    const value = normalizeText(metadata.product_interest_name || metadata.product_interest);
    if (value) return value;
  }
  return "none";
}

function qualityNotes(turnRows) {
  const counters = {
    unclear: 0,
    incomplete: 0,
    malformed: 0
  };
  for (const row of turnRows) {
    if (String(row.speaker ?? "") !== "caller") continue;
    const quality = normalizeText(parseMetadata(row).transcript_quality).toLowerCase();
    if (quality in counters) counters[quality] += 1;
  }
  const total = counters.unclear + counters.incomplete + counters.malformed;
  if (!total) return "clear";
  return `unclear=${counters.unclear}, incomplete=${counters.incomplete}, malformed=${counters.malformed}`;
}

function deriveContact(assistantMeta, sessionRow) {
  const preference = normalizeText(
    assistantMeta.contact_preference_detected ||
      assistantMeta.contact_preference ||
      assistantMeta.contact_route
  ).toLowerCase();
  const route = normalizeText(assistantMeta.contact_route).toLowerCase();
  const permissionRaw = assistantMeta.contact_permission_granted;
  const permission =
    typeof permissionRaw === "boolean"
      ? permissionRaw
        ? "granted"
        : "denied"
      : "unknown";
  const callerPhone = normalizeText(sessionRow?.caller_phone_normalized || sessionRow?.caller_phone_raw);
  const phonePresent = Boolean(callerPhone || assistantMeta.contact_detail_valid);
  const emailDirected =
    Boolean(assistantMeta.email_direct_offered) || route === "email_direct" || preference === "email";

  return {
    preference: preference || "unknown",
    route: route || "unknown",
    permission,
    phonePresent,
    emailDirected
  };
}

function deriveNextActionLegacy(productInterest, contact) {
  if (contact.preference === "phone" && contact.permission === "granted" && contact.phonePresent) {
    return "team_callback";
  }
  if (contact.preference === "phone" && contact.permission === "granted") return "manual_review";
  if (contact.emailDirected) return "await_customer_email";
  if (productInterest !== "none") return "manual_followup";
  return "manual_review";
}

function deriveNextAction(productInterest, contact, sessionRow, assistantMeta, config) {
  if (config?.leadPolicy?.strictCallback === false) {
    return deriveNextActionLegacy(productInterest, contact);
  }
  const derived = deriveLeadNextAction({
    productInterest,
    contact,
    sessionRow,
    assistantMeta
  });
  return derived.next_action;
}

function deriveConfidence(qualityNote, lastIntent) {
  if (qualityNote === "clear" && lastIntent !== "unknown") return "high";
  if (qualityNote.includes("unclear=0") && !qualityNote.includes("malformed=1")) return "medium";
  return "low";
}

function buildSummaryText(fields) {
  return [
    `Product interest: ${fields.productInterest}`,
    `Caller need: ${fields.callerNeed || "not clearly stated"}`,
    `Preferred contact: ${fields.contactPreference}`,
    `Permission: ${fields.permission}`,
    `Next action: ${fields.nextAction}`
  ].join("\n");
}

export function callerNeedFromV4Metadata(v4Metadata) {
  const memory = v4Metadata?.v4_memory_snapshot;
  if (memory && typeof memory === "object") {
    for (const value of [
      memory.use_case_summary,
      memory.current_problem,
      memory.last_user_utterance
    ]) {
      const fromMemory = normalizeText(value);
      if (fromMemory && !isUnusableCallerNeedText(fromMemory)) return fromMemory.slice(0, 220);
    }
  }
  const fromMetadata = normalizeText(v4Metadata?.caller_need);
  return isUnusableCallerNeedText(fromMetadata) ? "" : fromMetadata.slice(0, 220);
}

function productInterestFromV4Metadata(v4Metadata) {
  const value = normalizeText(v4Metadata?.product_interest);
  return value || "none";
}

export async function generatePostCallSummaryFromV4Metadata(
  config,
  ctx,
  sessionRow,
  v4Metadata,
  options = {},
  fullCallRow = null
) {
  const callSessionId = String(ctx?.callSessionId ?? sessionRow?.id ?? "").trim();
  if (!callSessionId || !v4Metadata?.v4_runtime) return null;

  const productInterest = productInterestFromV4Metadata(v4Metadata);
  const callerNeed = callerNeedFromV4Metadata(v4Metadata);
  const contactPreference = normalizeText(v4Metadata?.contact_preference) || "unknown";
  const permission = normalizeText(v4Metadata?.permission) || "unknown";
  const nextAction = normalizeText(v4Metadata?.next_action) || "manual_review";
  const confidence = normalizeText(v4Metadata?.confidence) || "medium";
  const qualityNote =
    normalizeText(v4Metadata?.transcript_quality_notes) || "v4_canary_memory";

  const summaryFields = {
    productInterest,
    callerNeed,
    contactPreference,
    permission,
    nextAction
  };
  const summaryText = buildSummaryText(summaryFields);

  const metadata = mergeV4SummaryMetadataPatch(
    {
      product_interest: productInterest,
      customer_type: v4Metadata?.customer_type ?? null,
      caller_need: callerNeed,
      contact_preference: contactPreference,
      permission,
      phone_present: Boolean(v4Metadata?.phone_present),
      email_directed: Boolean(v4Metadata?.email_directed),
      next_action: nextAction,
      confidence,
      transcript_quality_notes: qualityNote,
      last_detected_intent: "unknown",
      has_full_call_transcript: Boolean(options.fullTranscript || fullCallRow?.text),
      full_call_transcript_length: normalizeText(options.fullTranscript || fullCallRow?.text).length,
      lead_policy_strict_callback: config?.leadPolicy?.strictCallback !== false,
      summary_source: "v4_post_call_handoff"
    },
    v4Metadata
  );

  const summaryId = await db.upsertCallSummary(config, {
    callSessionId,
    summaryType: "auto",
    model: "deterministic-post-call-v1",
    summaryText,
    metadata
  });

  return summaryId
    ? {
        summaryId,
        summaryText,
        metadata
      }
    : null;
}

export async function generatePostCallSummary(config, ctx, options = {}) {
  if (!config?.postCallSummary?.enabled) return null;
  if (!db.isDbConfigured(config)) return null;
  const callSessionId = String(ctx?.callSessionId ?? "").trim();
  if (!callSessionId) return null;

  const [sessionRow, turnRows, fullCallRow] = await Promise.all([
    db.getCallSessionSnapshot(config, callSessionId),
    db.listTurnTranscripts(config, callSessionId),
    db.getLatestFullCallTranscript(config, callSessionId)
  ]);
  if (!sessionRow) return null;

  if (!turnRows.length) {
    const v4Metadata = ctx?.v4PostCallMetadata;
    if (v4Metadata?.v4_runtime) {
      return generatePostCallSummaryFromV4Metadata(
        config,
        ctx,
        sessionRow,
        v4Metadata,
        options,
        fullCallRow
      );
    }
    return null;
  }

  const assistantMeta = latestAssistantMetadata(turnRows);
  const productInterest = findProductInterest(turnRows, assistantMeta);
  const callerNeed = firstCallerNeed(turnRows);
  const lastIntent = findLastIntent(turnRows);
  const qualityNote = qualityNotes(turnRows);
  const contact = deriveContact(assistantMeta, sessionRow);
  const useStrictLeadPolicy = config?.leadPolicy?.strictCallback !== false;
  const leadDerived = useStrictLeadPolicy
    ? deriveLeadNextAction({
        productInterest,
        contact,
        sessionRow,
        assistantMeta
      })
    : {
        next_action: deriveNextActionLegacy(productInterest, contact),
        phone_present: contact.phonePresent,
        permission: contact.permission
      };
  const nextAction = leadDerived.next_action;
  const confidence = deriveConfidence(qualityNote, lastIntent);

  const summaryFields = {
    productInterest,
    callerNeed,
    contactPreference: contact.preference,
    permission: contact.permission,
    nextAction
  };

  const summaryText = buildSummaryText(summaryFields);
  const metadataBase = {
    product_interest: productInterest,
    customer_type: metadataField(assistantMeta, "customer_type") || null,
    customer_type_confidence: assistantMeta.customer_type_confidence ?? null,
    customer_type_evidence: assistantMeta.customer_type_evidence ?? null,
    sales_stage: metadataField(assistantMeta, "sales_stage") || null,
    current_problem: metadataField(assistantMeta, "current_problem") || null,
    caller_need: callerNeed,
    contact_preference: contact.preference,
    contact_route: contact.route,
    permission: leadDerived.permission || contact.permission,
    phone_present: useStrictLeadPolicy ? leadDerived.phone_present : contact.phonePresent,
    email_directed: contact.emailDirected,
    next_action: nextAction,
    confidence,
    transcript_quality_notes: qualityNote,
    last_detected_intent: lastIntent,
    has_full_call_transcript: Boolean(options.fullTranscript || fullCallRow?.text),
    full_call_transcript_length: normalizeText(options.fullTranscript || fullCallRow?.text).length,
    lead_policy_strict_callback: useStrictLeadPolicy
  };

  const metadata = useStrictLeadPolicy
    ? enrichSummaryMetadata(metadataBase, {
        customer_type: metadataField(assistantMeta, "customer_type") || null,
        customer_type_confidence: assistantMeta.customer_type_confidence ?? null,
        customer_type_evidence: assistantMeta.customer_type_evidence ?? null
      })
    : metadataBase;

  const mergedMetadata = mergeV4SummaryMetadataPatch(metadata, ctx?.v4PostCallMetadata);

  const summaryId = await db.upsertCallSummary(config, {
    callSessionId,
    summaryType: "auto",
    model: "deterministic-post-call-v1",
    summaryText,
    metadata: mergedMetadata
  });

  return summaryId
    ? {
        summaryId,
        summaryText,
        metadata: mergedMetadata
      }
    : null;
}
