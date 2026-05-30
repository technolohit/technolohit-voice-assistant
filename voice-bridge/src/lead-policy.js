/**
 * Deterministic lead metadata policy: stable context, strict callback-ready guards.
 */

function normalizeText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function asConfidenceNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Merge customer_type into sales context without letting noisy late turns overwrite stronger signals.
 */
export function mergeCustomerTypeContext(existingContext, incoming) {
  const base = existingContext && typeof existingContext === "object" ? { ...existingContext } : {};
  const nextType = normalizeText(incoming?.customer_type);
  const nextConfidence = asConfidenceNumber(incoming?.customer_type_confidence);
  const prevType = normalizeText(base.customer_type);
  const prevConfidence = asConfidenceNumber(base.customer_type_confidence) ?? 0;

  if (!nextType) return base;

  if (!prevType) {
    return {
      ...base,
      customer_type: nextType,
      customer_type_confidence: nextConfidence,
      customer_type_evidence: incoming?.customer_type_evidence || null
    };
  }

  if (nextConfidence != null && nextConfidence >= prevConfidence) {
    return {
      ...base,
      customer_type: nextType,
      customer_type_confidence: nextConfidence,
      customer_type_evidence: incoming?.customer_type_evidence || base.customer_type_evidence || null
    };
  }

  return base;
}

export function hasValidCallbackPhone(sessionRow, assistantMeta) {
  const callerPhone = normalizeText(
    sessionRow?.caller_phone_normalized || sessionRow?.caller_phone_raw
  );
  if (!callerPhone || /^anonymous$/i.test(callerPhone)) return false;
  if (assistantMeta?.contact_detail_valid === true) return true;
  return callerPhone.replace(/[^\d+]/g, "").length >= 8;
}

/**
 * Derive next_action with strict callback-ready rules (no fake phone/permission).
 */
export function deriveLeadNextAction({ productInterest, contact, sessionRow, assistantMeta }) {
  const preference = normalizeText(contact?.preference).toLowerCase();
  const permission = normalizeText(contact?.permission).toLowerCase();
  const phonePresent = hasValidCallbackPhone(sessionRow, assistantMeta);

  if (preference === "phone" && permission === "granted" && phonePresent) {
    return { next_action: "team_callback", phone_present: true, permission: "granted" };
  }
  if (preference === "phone" && permission === "granted" && !phonePresent) {
    return { next_action: "manual_review", phone_present: false, permission: "unknown" };
  }
  if (contact?.emailDirected) {
    return { next_action: "await_customer_email", phone_present: false, permission };
  }
  if (productInterest && productInterest !== "none") {
    return { next_action: "manual_followup", phone_present: false, permission };
  }
  return { next_action: "manual_review", phone_present: false, permission };
}

export function shouldCreateCallbackReadyLead(summaryMeta) {
  const contactPreference = normalizeText(summaryMeta?.contact_preference).toLowerCase();
  const permission = normalizeText(summaryMeta?.permission).toLowerCase();
  const phonePresent =
    summaryMeta?.phone_present === true || String(summaryMeta?.phone_present ?? "") === "true";
  const nextAction = normalizeText(summaryMeta?.next_action);

  if (nextAction === "team_callback") {
    if (contactPreference !== "phone" || permission !== "granted" || !phonePresent) {
      return false;
    }
  }
  if (contactPreference === "phone" && permission === "granted" && !phonePresent) {
    return false;
  }
  return true;
}

export function enrichSummaryMetadata(metadata, salesContext) {
  const merged = mergeCustomerTypeContext(
    {
      customer_type: metadata?.customer_type,
      customer_type_confidence: metadata?.customer_type_confidence,
      customer_type_evidence: metadata?.customer_type_evidence
    },
    salesContext
  );
  return {
    ...metadata,
    customer_type: merged.customer_type || metadata?.customer_type || null,
    customer_type_confidence: merged.customer_type_confidence ?? metadata?.customer_type_confidence ?? null,
    customer_type_evidence: merged.customer_type_evidence ?? metadata?.customer_type_evidence ?? null
  };
}
