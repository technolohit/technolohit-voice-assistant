import test from "node:test";
import assert from "node:assert/strict";
import {
  isExplicitPhoneHandoffRequest,
  isV3SalesFlowEnabled,
  handleSalesCustomerTypeTurn,
  shouldDeferToPhoneIntake,
  SALES_STAGES
} from "../src/sales-dialogue-manager.js";
import { createProductState } from "./helpers/product-state.js";

test("isV3SalesFlowEnabled is false by default", () => {
  assert.equal(isV3SalesFlowEnabled({}), false);
  assert.equal(isV3SalesFlowEnabled({ semanticIntent: { enabled: true } }), true);
});

test("handleSalesCustomerTypeTurn accepts Eigenunternehmen without menu loop", async () => {
  const productState = createProductState();
  productState.selectedProduct = "voice_agent";
  productState.productDialogueState = "sales_customer_type";
  productState.awaitingInterestConfirmation = true;

  const config = {
    semanticIntent: { enabled: true, minAccept: 0.75, minSoft: 0.45, mode: "deterministic" },
    conversationRepair: { enabled: true },
    rag: { enabled: false, salesAnswererEnabled: false }
  };

  const result = await handleSalesCustomerTypeTurn({
    config,
    productState,
    callerText: "Eigenunternehmen.",
    intent: "unknown",
    turnIndex: 2,
    normalizeResponse: (t) => t
  });

  assert.equal(result.detectedIntent, "sales_customer_type_new_prospect");
  assert.match(result.text, /eigenes unternehmen/i);
  assert.equal(/sagen sie bitte kurz: eigenes unternehmen, kundenprojekt/i.test(result.text.toLowerCase()), false);
  assert.equal(productState.salesContext.sales_stage, SALES_STAGES.NEED_DISCOVERY);
});

test("shouldDeferToPhoneIntake after product explanation", () => {
  const productState = createProductState();
  productState.productDialogueState = "sales_customer_type";
  productState.salesContext = { sales_stage: SALES_STAGES.VALUE_ANSWER };
  assert.equal(isExplicitPhoneHandoffRequest("Telefonisch bitte.", "contact_preference_phone"), true);
  assert.equal(shouldDeferToPhoneIntake(productState, "Telefonisch bitte.", "contact_preference_phone"), true);
});

test("handleSalesCustomerTypeTurn answers Kurze Erklärung with product explanation", async () => {
  const productState = createProductState();
  productState.selectedProduct = "voice_agent";
  productState.productDialogueState = "sales_customer_type";
  productState.awaitingInterestConfirmation = true;

  const result = await handleSalesCustomerTypeTurn({
    config: {
      semanticIntent: { enabled: true, minAccept: 0.75, minSoft: 0.45 },
      conversationRepair: { enabled: true },
      rag: { enabled: false }
    },
    productState,
    callerText: "Kurze Erklaerung bitte.",
    intent: "product_more_detail_request",
    turnIndex: 2,
    normalizeResponse: (t) => t
  });

  assert.equal(result.detectedIntent, "sales_product_explanation");
  assert.match(result.text, /rezeption|anrufe/i);
});
