/**
 * Phase 10S — persist current_product_context after interrupt product switch.
 */

import { normalizeText } from "./redaction.js";
import { detectShortFollowUpCategory } from "./playbook-short-answer.js";

const GENERIC_SCOPED_QUESTION =
  /\b(was kostet das|wie funktioniert das|was kann das|was ist das|kannst du das erkl[aä]ren|erkl[aä]r mir das|erkl[aä]ren sie das|kurz erkl[aä]ren|mehr dazu|mehr darueber|mehr darüber)\b/i;

const SALES_QUALIFICATION =
  /\b(neukunde|neu kunde|bestandskunde|bestehend|eigene firma|unternehmen|zurueckrufen|zurückrufen|rueckruf|rückruf|kontakt aufnehmen|angebot anfordern|projekt besprechen|implementierung)\b/i;

export function resolveCurrentProductContext(memory = {}) {
  return (
    memory?.current_product_context ??
    memory?.selected_product_id ??
    memory?.product_interest ??
    null
  );
}

export function resolvePreviousProductContext(memory = {}) {
  return (
    memory?.previous_product_context ??
    memory?.interruption_context?.interrupted_product_id ??
    null
  );
}

export function isGenericScopedProductQuestion(transcript = "") {
  const lower = normalizeText(transcript).toLowerCase();
  if (!lower) return false;
  if (GENERIC_SCOPED_QUESTION.test(lower)) return true;
  if (detectShortFollowUpCategory(transcript)) return true;
  if (/\b(was kostet|wie funktioniert|was kann|was macht)\b/i.test(lower) && /\b(das|es)\b/i.test(lower)) {
    return true;
  }
  return false;
}

export function shouldEnterSalesQualification(transcript = "", resolvedIntent = null) {
  if (resolvedIntent === "sales_customer_type" || resolvedIntent === "product_selection") {
    return true;
  }
  if (resolvedIntent === "contact_email" || resolvedIntent === "contact_phone") {
    return true;
  }
  const lower = normalizeText(transcript).toLowerCase();
  return SALES_QUALIFICATION.test(lower);
}

export function isScopedProductQaTurn(memory = {}, transcript = "", closedDomain = null) {
  const productId = resolveCurrentProductContext(memory);
  if (!productId) return false;
  if (shouldEnterSalesQualification(transcript)) return false;
  if (isGenericScopedProductQuestion(transcript)) return true;
  if (
    closedDomain?.intent === "pricing" ||
    closedDomain?.intent === "capability" ||
    closedDomain?.intent === "product_question"
  ) {
    return true;
  }
  if (detectShortFollowUpCategory(transcript)) return true;
  return false;
}

export function persistProductContextSwitch(memory = {}, productId, previousId = null) {
  const id = productId ? normalizeText(productId) : null;
  const prev =
    previousId ??
    memory?.selected_product_id ??
    memory?.current_product_context ??
    null;
  return {
    ...memory,
    selected_product_id: id,
    product_interest: id,
    current_product_context: id,
    previous_product_context: prev,
    interruption_context: null,
    updated_at: Date.now(),
  };
}

export function resolveInterruptSequenceId(runtime) {
  if (!runtime) return null;
  if (runtime.activeInterruptSequenceId) return runtime.activeInterruptSequenceId;
  const cycle =
    runtime.interruptFollowup?.interruptCycle ??
    runtime.interruptFollowupCycleCount ??
    null;
  if (!cycle) return null;
  return `interrupt-${cycle}`;
}

export function planContextQualityPayload(memory = {}, closedDomain = null, plan = null, runtime = null) {
  const current = resolveCurrentProductContext(memory);
  return {
    interrupt_sequence_id: resolveInterruptSequenceId(runtime),
    current_product_context: current,
    previous_product_context: resolvePreviousProductContext(memory),
    matched_product: closedDomain?.matched_product ?? current ?? null,
    response_type: plan?.response_type ?? null,
    plan_reason: plan?.plan_reason ?? null,
  };
}
