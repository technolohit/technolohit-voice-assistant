/**
 * v4 lead validation — deterministic guards for callback-ready leads.
 */

import { hasUsableCallerId, normalizeCallerPhone } from "../caller-id.js";
import { normalizeText, sanitizeCustomFields } from "./redaction.js";

const RAG_ONLY_SOURCES = new Set(["rag", "rag_answer", "rag_sales_answerer", "knowledge_retrieval"]);

export function isRagLeadSource(source) {
  return RAG_ONLY_SOURCES.has(normalizeText(source).toLowerCase());
}

export function validatePhoneForCallback({ callerPhoneRaw = "", callerPhoneNormalized = "", spokenPhone = "" } = {}) {
  const ctx = {
    callerPhoneRaw,
    callerPhoneNormalized: callerPhoneNormalized || normalizeCallerPhone(spokenPhone)
  };
  if (!hasUsableCallerId(ctx)) {
    return { ok: false, reason: "no_valid_phone_source", phone_present: false };
  }
  const normalized = normalizeCallerPhone(callerPhoneNormalized || callerPhoneRaw || spokenPhone);
  const digits = normalized.replace(/\D/g, "");
  if (spokenPhone && digits.length < 8) {
    return { ok: false, reason: "incomplete_spoken_phone", phone_present: false };
  }
  return { ok: true, reason: "valid_phone", phone_present: true };
}

export function validateCallbackReadyLead(memory = {}, options = {}) {
  const source = normalizeText(options.source);
  const preference = normalizeText(memory.contact_preference).toLowerCase();
  const permission = normalizeText(memory.callback_permission).toLowerCase();

  if (isRagLeadSource(source)) {
    return { allowed: false, reason: "rag_cannot_mark_lead_ready" };
  }
  if (options.llmGrantedPermission === true && !options.explicitUserPermission) {
    return { allowed: false, reason: "llm_cannot_grant_callback_permission" };
  }
  if (preference === "email") {
    return { allowed: false, reason: "email_path_no_phone_callback" };
  }
  if (preference !== "phone" || permission !== "granted") {
    return { allowed: false, reason: "callback_permission_missing" };
  }

  const phoneCheck = validatePhoneForCallback({
    callerPhoneRaw: options.callerPhoneRaw,
    callerPhoneNormalized: options.callerPhoneNormalized,
    spokenPhone: options.spokenPhone
  });
  if (!phoneCheck.ok) {
    return { allowed: false, reason: phoneCheck.reason, phone_present: false };
  }

  return { allowed: true, reason: "callback_ready_allowed", phone_present: true };
}

export function validateLeadReadyTransition(memory = {}, options = {}) {
  return validateCallbackReadyLead(memory, options);
}

export function validateCustomFields(customFields) {
  try {
    const sanitized = sanitizeCustomFields(customFields);
    JSON.stringify(sanitized);
    return { ok: true, custom_fields: sanitized };
  } catch {
    return { ok: false, reason: "custom_fields_not_json_safe" };
  }
}

export function applyLeadValidationToMemory(memory, options = {}) {
  const result = validateCallbackReadyLead(memory, options);
  if (!result.allowed) {
    return {
      memory: { ...memory, lead_ready: false, phone_present: Boolean(result.phone_present) },
      validation: result
    };
  }
  return {
    memory: { ...memory, lead_ready: true, phone_present: true },
    validation: result
  };
}

export function ragAnswerMustNotCreateLead(ragUsed = false) {
  if (ragUsed) {
    return { createsLead: false, reason: "rag_product_qa_only" };
  }
  return { createsLead: false, reason: "not_applicable" };
}

export function assertRagCannotSetLeadReady(memory = {}, source = "rag") {
  if (memory?.lead_ready && isRagLeadSource(source)) {
    return { ok: false, reason: "rag_cannot_set_lead_ready" };
  }
  return { ok: true, reason: "allowed" };
}
