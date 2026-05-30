import test from "node:test";
import assert from "node:assert/strict";
import {
  buildEmailDirectIntakeClosingSuffix,
  buildEmailDirectIntakeConfirmationText
} from "../src/email-intake-closing.js";

function configWithEmail(email) {
  return { assistant: { contactEmail: email } };
}

test("email direct closing uses short question when address already in body", () => {
  const suffix = buildEmailDirectIntakeClosingSuffix(configWithEmail("info@technolohit.com"), {
    emailAddressInBody: true
  });
  assert.match(suffix, /kurze frage/i);
  assert.match(suffix, /verabschieden/i);
  assert.doesNotMatch(suffix, /ruckruf|rueckruf/i);
});

test("email direct confirmation includes guidance and closing follow-up", () => {
  const text = buildEmailDirectIntakeConfirmationText(configWithEmail("info@technolohit.com"), "Kurz Ihr Ziel.");
  assert.match(text, /info@technolohit\.com/);
  assert.match(text, /kurze frage|kurz ihr ziel/i);
  assert.doesNotMatch(text, /ruckruf|rueckruf/i);
});

test("email direct confirmation without configured email still asks closing question", () => {
  const text = buildEmailDirectIntakeConfirmationText({ assistant: {} }, "Kurz Ihr Ziel.");
  assert.match(text, /website/i);
  assert.match(text, /kurze frage|verabschieden/i);
});
