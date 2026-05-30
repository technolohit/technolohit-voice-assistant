import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  interpretSemanticIntent,
  customerTypeMenuContext,
  validateSemanticIntentResult,
  shouldAcceptSemanticIntent
} from "../src/semantic-intent.js";

const fixturePath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../fixtures/live-call-failures/v1_2_1_customer_type_loop.json"
);

test("interpretSemanticIntent maps Eigenunternehmen to new_prospect", () => {
  const result = interpretSemanticIntent("Eigenunternehmen.", customerTypeMenuContext());
  validateSemanticIntentResult(result);
  assert.equal(result.intent, "customer_type");
  assert.equal(result.value, "new_prospect");
  assert.ok(result.confidence >= 0.75);
});

test("interpretSemanticIntent maps Eigene Unternehmen to new_prospect", () => {
  const result = interpretSemanticIntent("Eigene Unternehmen.", customerTypeMenuContext());
  assert.equal(result.value, "new_prospect");
  assert.ok(result.confidence >= 0.75);
});

test("interpretSemanticIntent maps für meine Firma to new_prospect", () => {
  const result = interpretSemanticIntent("für meine Firma", customerTypeMenuContext());
  assert.equal(result.value, "new_prospect");
});

test("interpretSemanticIntent maps Kundenprojekt to agency_partner", () => {
  const result = interpretSemanticIntent("Kundenprojekt", customerTypeMenuContext());
  assert.equal(result.value, "agency_partner");
});

test("interpretSemanticIntent maps rough STT Kundenprojekt fragment", () => {
  const result = interpretSemanticIntent("konnen dann projekt.", customerTypeMenuContext());
  assert.equal(result.value, "agency_partner");
  assert.ok(result.confidence >= 0.45);
});

test("interpretSemanticIntent maps Bereits Kunde to existing_customer", () => {
  const result = interpretSemanticIntent("Bereits Kunde", customerTypeMenuContext());
  assert.equal(result.value, "existing_customer");
});

test("die erste maps to new_prospect only with menu context", () => {
  const withMenu = interpretSemanticIntent("die erste", customerTypeMenuContext());
  assert.equal(withMenu.value, "new_prospect");
  const withoutMenu = interpretSemanticIntent("die erste", {});
  assert.notEqual(withoutMenu.value, "new_prospect");
});

test("live failure fixture semantic expectations pass", () => {
  const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
  const context = fixture.context || customerTypeMenuContext();
  for (const turn of fixture.turns) {
    if (!turn.expected_customer_type) continue;
    const result = interpretSemanticIntent(turn.caller, context);
    assert.equal(
      result.value,
      turn.expected_customer_type,
      `caller="${turn.caller}" expected ${turn.expected_customer_type} got ${result.value}`
    );
    if (turn.expected_min_confidence != null) {
      assert.ok(
        result.confidence >= turn.expected_min_confidence,
        `low confidence for "${turn.caller}": ${result.confidence}`
      );
    }
  }
});

test("shouldAcceptSemanticIntent respects config threshold", () => {
  const result = interpretSemanticIntent("Eigenunternehmen", customerTypeMenuContext());
  assert.equal(shouldAcceptSemanticIntent(result, { semanticIntent: { minAccept: 0.75 } }), true);
  assert.equal(shouldAcceptSemanticIntent(result, { semanticIntent: { minAccept: 0.99 } }), false);
});
