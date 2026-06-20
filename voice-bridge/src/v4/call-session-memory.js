/**
 * v4 structured call session memory — pure update helpers, no side effects.
 */

import { normalizeText, redactPhoneLikeText, sanitizeCustomFields } from "./redaction.js";
import { sanitizePhoneCaptureTranscriptForPersistence } from "./phone-capture-privacy.js";

function cloneMemory(memory) {
  return {
    ...memory,
    interruption_context: memory?.interruption_context
      ? { ...memory.interruption_context }
      : null,
    custom_fields: { ...(memory?.custom_fields ?? {}) }
  };
}

function touch(memory) {
  return { ...memory, updated_at: Date.now() };
}

export function createCallSessionMemory({
  bridgeCallId,
  callSessionId = null,
  tenantId = "technolohit",
  agentId = "main_voice_sales",
  currentState = "idle"
} = {}) {
  const now = Date.now();
  return {
    tenant_id: String(tenantId).trim(),
    agent_id: String(agentId).trim(),
    bridge_call_id: String(bridgeCallId ?? "pending").trim(),
    call_session_id: callSessionId ? String(callSessionId).trim() : null,
    caller_name: null,
    company_name: null,
    customer_type: null,
    selected_product_id: null,
    product_interest: null,
    current_problem: null,
    use_case_summary: null,
    contact_preference: null,
    callback_permission: null,
    phone_present: false,
    email_present: false,
    lead_ready: false,
    handoff_choice: null,
    current_state: String(currentState ?? "idle"),
    last_user_utterance: null,
    last_assistant_text: null,
    interruption_context: null,
    turn_count: 0,
    created_at: now,
    updated_at: now,
    custom_fields: {}
  };
}

export function updateMemoryFromIntent(memory, intent = {}) {
  const next = touch(cloneMemory(memory));
  const intentName = normalizeText(intent.normalized_intent ?? intent.intent ?? intent.name);
  const slots = intent.slots && typeof intent.slots === "object" ? intent.slots : {};

  if (slots.customer_type) next.customer_type = normalizeText(slots.customer_type) || next.customer_type;
  if (slots.product_id) {
    next.selected_product_id = normalizeText(slots.product_id);
    next.product_interest = next.selected_product_id;
  }
  if (slots.contact_preference) next.contact_preference = normalizeText(slots.contact_preference);
  if (slots.handoff_choice) next.handoff_choice = normalizeText(slots.handoff_choice);
  if (slots.use_case_summary) next.use_case_summary = normalizeText(slots.use_case_summary);
  if (slots.current_problem) next.current_problem = normalizeText(slots.current_problem);
  if (intentName.includes("product_selection_")) {
    const productId = intentName.replace("product_selection_", "");
    if (productId) {
      next.selected_product_id = productId;
      next.product_interest = productId;
    }
  }
  if (intentName.includes("sales_customer_type_")) {
    next.customer_type = intentName.replace("sales_customer_type_", "") || next.customer_type;
  }
  return next;
}

export function updateMemoryFromUserTurn(memory, callerText = "") {
  const next = touch(cloneMemory(memory));
  const text = normalizeText(callerText);
  const phoneCaptureText = sanitizePhoneCaptureTranscriptForPersistence(memory, text);
  next.last_user_utterance = phoneCaptureText ?? (text ? redactPhoneLikeText(text) : null);
  next.turn_count = Number(next.turn_count ?? 0) + 1;
  return next;
}

export function updateMemoryFromAssistantTurn(memory, assistantText = "") {
  const next = touch(cloneMemory(memory));
  const text = normalizeText(assistantText);
  next.last_assistant_text = text ? redactPhoneLikeText(text) : null;
  return next;
}

export function setSelectedProduct(memory, productId) {
  const next = touch(cloneMemory(memory));
  const id = productId ? normalizeText(productId) : null;
  const prev = next.selected_product_id ?? next.current_product_context ?? null;
  next.selected_product_id = id;
  next.product_interest = id;
  if (id) {
    next.current_product_context = id;
    if (prev && prev !== id) next.previous_product_context = prev;
  }
  return next;
}

export function setCustomerType(memory, customerType) {
  const next = touch(cloneMemory(memory));
  next.customer_type = customerType ? normalizeText(customerType) : null;
  return next;
}

export function setContactPreference(memory, { preference, permission, emailPresent = false, phonePresent = false } = {}) {
  const next = touch(cloneMemory(memory));
  if (preference != null) next.contact_preference = normalizeText(preference) || null;
  if (permission != null) next.callback_permission = normalizeText(permission) || null;
  if (emailPresent === true) next.email_present = true;
  if (phonePresent === true) next.phone_present = true;
  if (phonePresent === false && preference !== "phone") {
    // keep explicit phone_present true if already validated elsewhere
  }
  return next;
}

export function markLeadReady(memory, leadReady = true) {
  const next = touch(cloneMemory(memory));
  next.lead_ready = Boolean(leadReady);
  return next;
}

export function attachInterruptionContext(memory, context = {}) {
  const next = touch(cloneMemory(memory));
  next.interruption_context = {
    recorded_at: Date.now(),
    turn_index: context.turn_index ?? context.turnIndex ?? null,
    interrupted_product_id: context.interrupted_product_id ?? context.interruptedProductId ?? null,
    cancellation_reason: normalizeText(context.cancellation_reason ?? context.cancellationReason ?? ""),
    assistant_text_preview: redactPhoneLikeText(
      normalizeText(context.assistant_text ?? context.assistantText ?? "")
    ).slice(0, 200)
  };
  next.current_state = "interrupted";
  return next;
}

export function clearInterruptionContext(memory) {
  const next = touch(cloneMemory(memory));
  next.interruption_context = null;
  return next;
}

export function summarizeMemoryForPrompt(memory) {
  return {
    tenant_id: memory?.tenant_id ?? null,
    agent_id: memory?.agent_id ?? null,
    customer_type: memory?.customer_type ?? null,
    selected_product_id: memory?.selected_product_id ?? null,
    product_interest: memory?.product_interest ?? null,
    use_case_summary: memory?.use_case_summary ?? null,
    contact_preference: memory?.contact_preference ?? null,
    callback_permission: memory?.callback_permission ?? null,
    phone_present: Boolean(memory?.phone_present),
    email_present: Boolean(memory?.email_present),
    lead_ready: Boolean(memory?.lead_ready),
    handoff_choice: memory?.handoff_choice ?? null,
    current_state: memory?.current_state ?? null,
    turn_count: Number(memory?.turn_count ?? 0),
    has_interruption: Boolean(memory?.interruption_context)
  };
}

export function serializeMemoryForPersistence(memory) {
  const summary = summarizeMemoryForPrompt(memory);
  return {
    ...summary,
    bridge_call_id: memory?.bridge_call_id ?? null,
    call_session_id: memory?.call_session_id ?? null,
    caller_name: memory?.caller_name ? redactPhoneLikeText(memory.caller_name) : null,
    company_name: memory?.company_name ?? null,
    current_problem: memory?.current_problem ?? null,
    last_user_utterance: memory?.last_user_utterance ?? null,
    last_assistant_text: memory?.last_assistant_text ?? null,
    interruption_context: memory?.interruption_context
      ? {
          ...memory.interruption_context,
          assistant_text_preview: redactPhoneLikeText(
            memory.interruption_context.assistant_text_preview ?? ""
          )
        }
      : null,
    custom_fields: sanitizeCustomFields(memory?.custom_fields),
    created_at: memory?.created_at ?? null,
    updated_at: memory?.updated_at ?? null
  };
}

/** @deprecated use createCallSessionMemory */
export function advanceTurn(memory) {
  return updateMemoryFromUserTurn(memory, memory?.last_user_utterance ?? "");
}
