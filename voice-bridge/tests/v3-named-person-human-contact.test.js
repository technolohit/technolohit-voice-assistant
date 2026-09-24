/**
 * IR-2026-09-24 Increment A — v3 named-person / human-contact intent.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  detectHumanContactIntent,
  isGenericHumanContactRequest,
  isNamedPersonContactRequest,
} from "../src/human-contact-intent.js";
import { loadConfig } from "../src/config.js";
import { createQaDialogueContext, processTextTurn } from "../src/turn-assistant.js";
import { responsesAreNearDuplicate } from "../src/v3/product-question-routing.js";

const SYNTHETIC_SURNAME = "Neumann";
const SYNTHETIC_FIRST = "Martin";
const UNKNOWN_PERSON = "Ziegler";

const APPROVED_PREFERENCE =
  /Natürlich\. Möchten Sie lieber per E-Mail schreiben oder telefonisch kontaktiert werden\?/i;

function qaConfigV3() {
  process.env.VOICE_ASSISTANT_ENABLED = "true";
  process.env.VOICE_RAG_ENABLED = "false";
  process.env.VOICE_RAG_SALES_ANSWERER_ENABLED = "false";
  process.env.VOICE_RUNTIME_VERSION = "v3";
  const config = loadConfig();
  config.assistant.enabled = true;
  config.assistant.qaTextMode = true;
  return config;
}

async function runTurns(transcripts) {
  const config = qaConfigV3();
  const ctx = createQaDialogueContext();
  const results = [];
  for (let i = 0; i < transcripts.length; i += 1) {
    results.push(
      await processTextTurn({
        state: ctx,
        transcript: transcripts[i],
        config,
        turnIndex: i + 1,
        qaMode: true,
      })
    );
  }
  return results;
}

function assertNoAcousticOrProduct(responseText) {
  const lower = String(responseText || "").toLowerCase();
  assert.doesNotMatch(lower, /akustisch/);
  assert.doesNotMatch(lower, /nicht verstanden/);
  assert.doesNotMatch(lower, /smart website|aiseoq|botinteg|lokalki|worum geht es|welche lösung|produkt/i);
}

test("IR: Herr + synthetic surname maps to handoff_requested", () => {
  const text = `Ich möchte mit Herrn ${SYNTHETIC_SURNAME} sprechen.`;
  assert.equal(isNamedPersonContactRequest(text), true);
  assert.equal(detectHumanContactIntent(text), "handoff_requested");
});

test("IR: Frau + synthetic surname maps to handoff_requested", () => {
  const text = `Kann ich Frau ${SYNTHETIC_SURNAME} erreichen?`;
  assert.equal(isNamedPersonContactRequest(text), true);
  assert.equal(detectHumanContactIntent(text), "handoff_requested");
});

test("IR: titleless first+surname maps to handoff_requested", () => {
  const text = `Ich möchte mit ${SYNTHETIC_FIRST} ${SYNTHETIC_SURNAME} sprechen.`;
  assert.equal(isNamedPersonContactRequest(text), true);
  assert.equal(detectHumanContactIntent(text), "handoff_requested");
});

test("IR: single first name alone after mit is not handoff", () => {
  const text = `Ich möchte mit ${SYNTHETIC_FIRST} sprechen.`;
  assert.equal(isNamedPersonContactRequest(text), false);
  assert.equal(detectHumanContactIntent(text), null);
});

test("IR: single name with strong connect phrase maps to handoff_requested", () => {
  const text = `Verbinden Sie mich bitte mit ${SYNTHETIC_FIRST}.`;
  assert.equal(isNamedPersonContactRequest(text), true);
  assert.equal(detectHumanContactIntent(text), "handoff_requested");
});

test("IR: unknown person name still maps to safe handoff (no directory check)", () => {
  const text = `Bitte verbinden Sie mich mit Herrn ${UNKNOWN_PERSON}.`;
  assert.equal(detectHumanContactIntent(text), "handoff_requested");
});

test("IR: mixed named-person + pricing resolves to handoff_requested", async () => {
  const text = `Ich möchte mit Herrn ${SYNTHETIC_SURNAME} über den Preis sprechen.`;
  assert.equal(detectHumanContactIntent(text), "handoff_requested");
  const [turn] = await runTurns([text]);
  assert.equal(turn.normalizedIntent, "handoff_requested");
  assert.notEqual(turn.normalizedIntent, "pricing_question");
  assert.match(turn.responseText, APPROVED_PREFERENCE);
  assertNoAcousticOrProduct(turn.responseText);
});

test("IR: generic mit jemandem sprechen regression", () => {
  assert.equal(isGenericHumanContactRequest("Ich möchte mit jemandem sprechen."), true);
  assert.equal(detectHumanContactIntent("Ich möchte mit jemandem sprechen."), "handoff_requested");
});

test("IR: detector does not return or embed the person name", () => {
  const text = `Ich möchte mit Herrn ${SYNTHETIC_SURNAME} sprechen.`;
  const intent = detectHumanContactIntent(text);
  assert.equal(intent, "handoff_requested");
  assert.doesNotMatch(intent, new RegExp(SYNTHETIC_SURNAME, "i"));
});

test("IR: processTextTurn quality evidence is handoff_requested not unknown", async () => {
  const [turn] = await runTurns([`Ich möchte mit Herrn ${SYNTHETIC_SURNAME} sprechen.`]);
  assert.equal(turn.normalizedIntent, "handoff_requested");
  assert.match(turn.responseText, APPROVED_PREFERENCE);
});

test("IR: no live-transfer claim in assistant response", async () => {
  const [turn] = await runTurns([`Ich möchte mit Frau ${SYNTHETIC_SURNAME} sprechen.`]);
  assert.equal(turn.normalizedIntent, "handoff_requested");
  const lower = String(turn.responseText || "").toLowerCase();
  assert.doesNotMatch(lower, /verbinde sie (jetzt|sofort)/i);
  assert.doesNotMatch(lower, /ich stelle (sie|dich) durch/i);
  assert.doesNotMatch(lower, /live[ -]?transfer/i);
  assert.doesNotMatch(turn.responseText, new RegExp(SYNTHETIC_SURNAME, "i"));
});

test("IR: repeated named-person request restates approved preference wording", async () => {
  const results = await runTurns([
    `Ich möchte mit Herrn ${SYNTHETIC_SURNAME} sprechen.`,
    `Ich möchte nochmal mit Herrn ${SYNTHETIC_SURNAME} sprechen.`,
  ]);
  assert.equal(results[0].normalizedIntent, "handoff_requested");
  assert.equal(results[1].normalizedIntent, "handoff_requested");
  assert.match(results[0].responseText, APPROVED_PREFERENCE);
  assert.match(results[1].responseText, APPROVED_PREFERENCE);
  assertNoAcousticOrProduct(results[1].responseText);
});

test("IR: repeated pricing still uses product repeat guard", async () => {
  const results = await runTurns([
    "Ich interessiere mich für die Smart Website.",
    "Was kostet das?",
    "Was kostet das?",
  ]);
  assert.equal(results[1].normalizedIntent, "pricing_question");
  assert.equal(responsesAreNearDuplicate(results[1].responseText, results[2].responseText), false);
  assert.equal(results[2].metadata.final_response_template, "product_question_repeat_guard");
});

test("IR: explicit callback while preference pending selects phone path", async () => {
  const results = await runTurns([
    `Ich möchte mit Herrn ${SYNTHETIC_SURNAME} sprechen.`,
    "Bitte einen Rückruf.",
  ]);
  assert.equal(results[0].normalizedIntent, "handoff_requested");
  assert.match(
    results[1].responseText,
    /telefonnummer|unter der nummer telefonisch kontaktieren/i
  );
  assert.doesNotMatch(results[1].responseText, APPROVED_PREFERENCE);
  assert.doesNotMatch(String(results[1].responseText || "").toLowerCase(), /akustisch/);
  assert.notEqual(results[1].normalizedIntent, "handoff_requested");
});

test("IR: closing remains highest priority over named-person phrasing", async () => {
  assert.equal(detectHumanContactIntent("Danke, das reicht erstmal. Auf Wiederhören."), null);
  assert.equal(detectHumanContactIntent("Auf Wiederhören."), null);
  assert.equal(detectHumanContactIntent("Nein danke."), null);
  const [goodbye] = await runTurns(["Auf Wiederhören."]);
  assert.notEqual(goodbye.normalizedIntent, "handoff_requested");
  assert.doesNotMatch(goodbye.responseText, /herrn|frau|verbinde sie jetzt/i);
});

test("IR: product-only utterance is not classified as human contact", () => {
  assert.equal(detectHumanContactIntent("Was kostet Smart Website?"), null);
  assert.equal(detectHumanContactIntent("Ich interessiere mich für AI Assistant."), null);
});

test("IR: titleless product/role phrases are not handoff_requested", () => {
  const negatives = [
    "Ich möchte mit Smart Website sprechen.",
    "Kann ich mit SEO sprechen?",
    "Ich möchte mit Neukunden sprechen.",
    "Kann der Voice Agent Kunden anrufen?",
    "Ich möchte mit AI Assistant sprechen.",
    "Ich möchte mit digitaler Rezeption sprechen.",
    "Ich möchte mit Marketing Automation sprechen.",
    "Ich möchte mit KI Chatbot sprechen.",
  ];
  for (const text of negatives) {
    assert.equal(detectHumanContactIntent(text), null, `expected null for: ${text}`);
    assert.equal(isNamedPersonContactRequest(text), false, `expected not named-person: ${text}`);
  }
});

test("IR: product alias utterances route to product path not handoff", async () => {
  const cases = [
    {
      text: "Ich möchte mit AI Assistant sprechen.",
      intent: "product_selection_voice_agent",
    },
    {
      text: "Ich möchte mit digitale Rezeption sprechen.",
      intent: "product_selection_voice_agent",
    },
    {
      text: "Ich möchte mit Marketing Automation sprechen.",
      intent: "product_selection_botinteg",
    },
    {
      text: "Ich möchte mit KI Chatbot sprechen.",
      intent: "product_selection_botinteg",
    },
    {
      text: "Ich möchte mit Smart Website sprechen.",
      intent: "product_selection_smart_website",
    },
    {
      text: "Ich möchte mit SEO sprechen.",
      intent: "product_selection_aiseoq",
    },
  ];
  for (const { text, intent } of cases) {
    const [turn] = await runTurns([text]);
    assert.notEqual(turn.normalizedIntent, "handoff_requested", text);
    assert.equal(turn.normalizedIntent, intent, text);
  }
});
