/**
 * v4 lead candidate — deterministic object from CallSessionMemory (no side effects).
 */

import { normalizeText } from "./redaction.js";
import { maskPhoneForExternal } from "./privacy-sanitize.js";
import {
  validateCallbackReadyLead,
  validatePhoneForCallback,
  isRagLeadSource
} from "./lead-validator.js";
import { deriveLeadNextAction } from "../lead-policy.js";
import { resolvePostCallLeadSkipReason } from "./callback-flow-policy.js";

export const INCOMPLETE_SPOKEN_PHONE_EXAMPLES = ["0170", "123", "+49 170", "null"];

export function buildLeadCandidateFromMemory(memory = {}, options = {}) {
  const source = normalizeText(options.source ?? "v4_call_session_memory");
  const preference = normalizeText(memory.contact_preference).toLowerCase() || null;
  const permission = normalizeText(memory.callback_permission).toLowerCase() || null;
  const callerPhoneNormalized = normalizeText(
    options.callerPhoneNormalized ?? options.caller_phone_normalized ?? ""
  );
  const spokenPhone = normalizeText(options.spokenPhone ?? "");

  const phoneCheck = validatePhoneForCallback({
    callerPhoneNormalized,
    callerPhoneRaw: options.callerPhoneRaw,
    spokenPhone
  });

  const callbackValidation = validateCallbackReadyLead(memory, {
    source,
    callerPhoneNormalized,
    callerPhoneRaw: options.callerPhoneRaw,
    spokenPhone,
    explicitUserPermission: options.explicitUserPermission ?? true,
    llmGrantedPermission: options.llmGrantedPermission ?? false
  });

  const sessionRow = {
    caller_phone_normalized: callerPhoneNormalized,
    caller_phone_raw: options.callerPhoneRaw ?? ""
  };
  const assistantMeta = {
    contact_detail_valid: phoneCheck.ok && Boolean(spokenPhone || callerPhoneNormalized)
  };

  let nextAction = "manual_review";
  if (isRagLeadSource(source)) {
    nextAction = preference === "email" ? "await_customer_email" : "manual_followup";
  } else if (preference === "email" || memory.email_present) {
    nextAction = "await_customer_email";
  } else {
    const derived = deriveLeadNextAction({
      productInterest: memory.product_interest ?? memory.selected_product_id ?? "none",
      contact: {
        preference: preference ?? "unknown",
        permission: permission ?? "unknown",
        emailDirected: Boolean(memory.email_present || preference === "email")
      },
      sessionRow,
      assistantMeta
    });
    nextAction = derived.next_action;
  }

  const callbackReady = callbackValidation.allowed && nextAction === "team_callback";
  const validationReason = callbackValidation.allowed
    ? callbackValidation.reason
    : resolvePostCallLeadSkipReason(memory, callbackValidation, phoneCheck);

  return {
    tenant_id: memory.tenant_id ?? null,
    agent_id: memory.agent_id ?? null,
    bridge_call_id: memory.bridge_call_id ?? null,
    call_session_id: memory.call_session_id ?? null,
    product_interest: memory.product_interest ?? memory.selected_product_id ?? null,
    customer_type: memory.customer_type ?? null,
    contact_preference: preference,
    callback_permission: permission,
    phone_present: Boolean(callbackValidation.phone_present ?? phoneCheck.phone_present ?? memory.phone_present),
    email_present: Boolean(memory.email_present),
    lead_ready: Boolean(memory.lead_ready && callbackReady),
    callback_ready: callbackReady,
    next_action: nextAction,
    validation: {
      allowed: callbackValidation.allowed,
      reason: validationReason
    },
    source,
    phone_masked: callerPhoneNormalized ? maskPhoneForExternal(callerPhoneNormalized) : null,
    creates_lead: callbackReady,
    rag_blocked: isRagLeadSource(source)
  };
}

export function leadCandidateMustNotUseTeamCallback(candidate = {}) {
  if (candidate.contact_preference === "email") {
    return candidate.next_action !== "team_callback";
  }
  if (!candidate.phone_present) {
    return candidate.next_action !== "team_callback";
  }
  return true;
}
