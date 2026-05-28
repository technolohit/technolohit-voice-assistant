import * as db from "./db.js";

function normalizeText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
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
  const candidate = normalizeText(callerRows[0].text);
  return candidate.slice(0, 220);
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
  const phonePresent = Boolean(callerPhone || assistantMeta.contact_detail_attempted);
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

function deriveNextAction(productInterest, contact) {
  if (contact.preference === "phone" && contact.permission === "granted") return "team_callback";
  if (contact.emailDirected) return "await_customer_email";
  if (productInterest !== "none") return "manual_followup";
  return "manual_review";
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
  if (!sessionRow || !turnRows.length) return null;

  const assistantMeta = latestAssistantMetadata(turnRows);
  const productInterest = findProductInterest(turnRows, assistantMeta);
  const callerNeed = firstCallerNeed(turnRows);
  const lastIntent = findLastIntent(turnRows);
  const qualityNote = qualityNotes(turnRows);
  const contact = deriveContact(assistantMeta, sessionRow);
  const nextAction = deriveNextAction(productInterest, contact);
  const confidence = deriveConfidence(qualityNote, lastIntent);

  const summaryFields = {
    productInterest,
    callerNeed,
    contactPreference: contact.preference,
    permission: contact.permission,
    nextAction
  };

  const summaryText = buildSummaryText(summaryFields);
  const metadata = {
    product_interest: productInterest,
    caller_need: callerNeed,
    contact_preference: contact.preference,
    contact_route: contact.route,
    permission: contact.permission,
    phone_present: contact.phonePresent,
    email_directed: contact.emailDirected,
    next_action: nextAction,
    confidence,
    transcript_quality_notes: qualityNote,
    last_detected_intent: lastIntent,
    has_full_call_transcript: Boolean(options.fullTranscript || fullCallRow?.text),
    full_call_transcript_length: normalizeText(options.fullTranscript || fullCallRow?.text).length
  };

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
