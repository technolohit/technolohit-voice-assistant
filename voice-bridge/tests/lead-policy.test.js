import test from "node:test";
import assert from "node:assert/strict";
import {
  mergeCustomerTypeContext,
  deriveLeadNextAction,
  shouldCreateCallbackReadyLead,
  hasValidCallbackPhone
} from "../src/lead-policy.js";

test("mergeCustomerTypeContext keeps higher-confidence earlier type", () => {
  const merged = mergeCustomerTypeContext(
    { customer_type: "new_prospect", customer_type_confidence: 0.82, customer_type_evidence: "first" },
    { customer_type: "agency_partner", customer_type_confidence: 0.4, customer_type_evidence: "noise" }
  );
  assert.equal(merged.customer_type, "new_prospect");
});

test("mergeCustomerTypeContext accepts stronger later signal", () => {
  const merged = mergeCustomerTypeContext(
    { customer_type: "new_prospect", customer_type_confidence: 0.5 },
    { customer_type: "existing_customer", customer_type_confidence: 0.9, customer_type_evidence: "kundennummer" }
  );
  assert.equal(merged.customer_type, "existing_customer");
});

test("deriveLeadNextAction blocks team_callback without valid phone", () => {
  const derived = deriveLeadNextAction({
    productInterest: "voice_agent",
    contact: { preference: "phone", permission: "granted" },
    sessionRow: { caller_phone_normalized: "", caller_phone_raw: "" },
    assistantMeta: { contact_detail_valid: false }
  });
  assert.equal(derived.next_action, "manual_review");
  assert.equal(derived.phone_present, false);
});

test("deriveLeadNextAction allows team_callback with valid caller ID", () => {
  const derived = deriveLeadNextAction({
    productInterest: "voice_agent",
    contact: { preference: "phone", permission: "granted" },
    sessionRow: { caller_phone_normalized: "+491701234567" },
    assistantMeta: {}
  });
  assert.equal(derived.next_action, "team_callback");
  assert.equal(derived.phone_present, true);
});

test("shouldCreateCallbackReadyLead rejects phone granted without phone_present", () => {
  assert.equal(
    shouldCreateCallbackReadyLead({
      contact_preference: "phone",
      permission: "granted",
      phone_present: false,
      next_action: "team_callback"
    }),
    false
  );
});

test("hasValidCallbackPhone rejects anonymous", () => {
  assert.equal(hasValidCallbackPhone({ caller_phone_normalized: "anonymous" }, {}), false);
});
