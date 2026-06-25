import * as db from "./db.js";
import { shouldCreateCallbackReadyLead } from "./lead-policy.js";
import { sanitizeOutboundObject } from "./v4/privacy-sanitize.js";
import { normalizeCallerPhone } from "./caller-id.js";

function normalizeText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function normalizePhone(value) {
  return normalizeCallerPhone(value);
}

/**
 * Protected phone for voice.leads: v4 spoken capture lives on post-call handoff;
 * caller-ID path may still use call_sessions columns.
 */
export function resolveLeadNormalizedPhoneForPostCall(ctx, session) {
  const handoffPhone = normalizePhone(ctx?.v4PostCallHandoff?.protectedNormalizedPhone ?? "");
  if (handoffPhone) return handoffPhone;
  return normalizePhone(session?.caller_phone_normalized || session?.caller_phone_raw);
}

function summaryField(metadata, key) {
  if (!metadata || typeof metadata !== "object") return "";
  return normalizeText(metadata[key]);
}

function shouldCreateLead(summaryMeta, config, normalizedPhone) {
  const contactPreference = summaryField(summaryMeta, "contact_preference");
  const permission = summaryField(summaryMeta, "permission");
  const emailDirected = String(summaryMeta?.email_directed ?? "") === "true";
  const nextAction = summaryField(summaryMeta, "next_action");
  const confidence = summaryField(summaryMeta, "confidence");
  const productInterest = summaryField(summaryMeta, "product_interest");
  const explicitRoute = contactPreference === "phone" || contactPreference === "email";
  const phonePresent = summaryMeta?.phone_present === true || String(summaryMeta?.phone_present ?? "") === "true";

  if (!explicitRoute) return false;
  if (contactPreference === "phone" && permission !== "granted") return false;
  if (contactPreference === "phone" && !phonePresent) return false;
  if (contactPreference === "phone" && phonePresent && !normalizedPhone) return false;
  if (config?.leadPolicy?.strictCallback !== false && !shouldCreateCallbackReadyLead(summaryMeta)) {
    return false;
  }
  if (contactPreference === "email" && nextAction === "team_callback") return false;
  if (contactPreference === "email" && !emailDirected && nextAction !== "await_customer_email") return false;

  const qualityOk = confidence === "high" || confidence === "medium" || productInterest !== "none";
  return qualityOk;
}

function leadStatusFromSummary(summaryMeta) {
  const nextAction = summaryField(summaryMeta, "next_action");
  if (nextAction === "team_callback" || nextAction === "await_customer_email") return "qualified";
  return "new";
}

export async function runPostCallLeadExtraction(config, ctx, summary) {
  if (!config?.postCallLeadExtraction?.enabled) {
    return { action: "skipped", reason: "feature_disabled" };
  }
  if (!db.isDbConfigured(config)) {
    return { action: "skipped", reason: "db_disabled" };
  }

  const callSessionId = String(ctx?.callSessionId ?? "").trim();
  if (!callSessionId) {
    return { action: "skipped", reason: "missing_call_session_id" };
  }

  const summaryMeta = summary?.metadata && typeof summary.metadata === "object" ? summary.metadata : {};
  const session = await db.getCallSessionSnapshot(config, callSessionId);
  if (!session) return { action: "skipped", reason: "missing_call_session" };

  const existingLead = await db.getLeadByCallSessionId(config, callSessionId);
  const normalizedPhone = resolveLeadNormalizedPhoneForPostCall(ctx, session);
  const metadataPatch = sanitizeOutboundObject({
    summary_id: summary?.summaryId ?? "",
    summary_type: "auto",
    post_call_lead_extraction_v1: true,
    product_interest: summaryField(summaryMeta, "product_interest") || null,
    customer_type: summaryField(summaryMeta, "customer_type") || null,
    sales_stage: summaryField(summaryMeta, "sales_stage") || null,
    current_problem: summaryField(summaryMeta, "current_problem") || null,
    caller_need: summaryField(summaryMeta, "caller_need") || null,
    contact_preference: summaryField(summaryMeta, "contact_preference") || null,
    permission: summaryField(summaryMeta, "permission") || null,
    phone_present: summaryMeta?.phone_present ?? null,
    email_directed: summaryMeta?.email_directed ?? null,
    next_action: summaryField(summaryMeta, "next_action") || null,
    confidence: summaryField(summaryMeta, "confidence") || null,
    transcript_quality_notes: summaryField(summaryMeta, "transcript_quality_notes") || null,
    tenant_id: summaryField(summaryMeta, "tenant_id") || null,
    agent_id: summaryField(summaryMeta, "agent_id") || null,
    runtime_version: summaryField(summaryMeta, "runtime_version") || null,
    agent_config_version: summaryField(summaryMeta, "agent_config_version") || null
  });

  if (existingLead?.id) {
    const updatedLeadId = await db.updateVoiceLead(config, {
      leadId: existingLead.id,
      status: leadStatusFromSummary(summaryMeta),
      normalizedPhone,
      notes: "Lead enriched by post-call summary extraction.",
      metadataPatch
    });
    return updatedLeadId
      ? { action: "updated", leadId: updatedLeadId, reason: "existing_lead_enriched" }
      : { action: "skipped", reason: "lead_update_failed" };
  }

  if (!shouldCreateLead(summaryMeta, config, normalizedPhone)) {
    return { action: "skipped", reason: "guard_not_met" };
  }

  const createdLeadId = await db.insertVoiceLead(config, {
    callSessionId,
    normalizedPhone,
    status: leadStatusFromSummary(summaryMeta),
    source: "voice_post_call",
    notes: "Lead created by post-call summary extraction.",
    metadata: metadataPatch
  });

  if (!createdLeadId) {
    return { action: "skipped", reason: "lead_create_failed" };
  }

  return { action: "created", leadId: createdLeadId, reason: "summary_guard_passed" };
}
