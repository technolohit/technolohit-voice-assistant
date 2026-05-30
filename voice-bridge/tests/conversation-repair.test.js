import test from "node:test";
import assert from "node:assert/strict";
import {
  createRepairState,
  isCustomerTypeMenuPrompt,
  resolveCustomerTypeResponse,
  wouldRepeatPrompt,
  recordPrompt,
  PROMPT_KEYS
} from "../src/conversation-repair.js";
import { buildCustomerTypeResponse } from "../src/sales-policy.js";

test("isCustomerTypeMenuPrompt detects standard menu wording", () => {
  const menu = buildCustomerTypeResponse("unknown", "voice_agent");
  assert.equal(isCustomerTypeMenuPrompt(menu), true);
});

test("resolveCustomerTypeResponse avoids repeating same menu prompt", () => {
  const productState = { repair: createRepairState(), selectedProduct: "voice_agent" };
  const menu = buildCustomerTypeResponse("unknown", "voice_agent");
  recordPrompt(productState.repair, PROMPT_KEYS.CUSTOMER_TYPE_MENU, menu);
  assert.equal(wouldRepeatPrompt(productState.repair, PROMPT_KEYS.CUSTOMER_TYPE_MENU, menu), true);

  const resolved = resolveCustomerTypeResponse({
    productState,
    productId: "voice_agent",
    semanticResult: { intent: "unclear", value: "unknown", confidence: 0.3 },
    accept: false,
    softConfirm: false
  });
  assert.equal(resolved.avoidedRepeat || resolved.usedFallback, true);
  assert.equal(isCustomerTypeMenuPrompt(resolved.text), false);
});

test("accepted new_prospect uses acknowledgment not menu", () => {
  const productState = { repair: createRepairState(), selectedProduct: "voice_agent" };
  const resolved = resolveCustomerTypeResponse({
    productState,
    productId: "voice_agent",
    semanticResult: { intent: "customer_type", value: "new_prospect", confidence: 0.82 },
    accept: true,
    softConfirm: false
  });
  assert.match(resolved.text, /eigenes unternehmen/i);
  assert.equal(isCustomerTypeMenuPrompt(resolved.text), false);
});
