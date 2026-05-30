import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { hasUsableCallerId, isAnonymousCallerPhone, normalizeCallerPhone } from "../src/caller-id.js";
import { matchProductPolicyFromText, validateProductIntakePolicy } from "../src/product-intake-policy.js";
import { retrieveRagContext } from "../src/rag-client.js";

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

test("validateProductIntakePolicy passes", () => {
  assert.doesNotThrow(() => validateProductIntakePolicy());
});

test("voice agent synonyms map to digital_assistant policy", () => {
  const phrases = [
    "AI Assistant",
    "KI Assistent",
    "Telefonassistent",
    "Voice Assistant",
    "digitale Rezeption"
  ];
  for (const phrase of phrases) {
    const match = matchProductPolicyFromText(phrase);
    assert.equal(match?.key, "digital_assistant", `expected digital_assistant for ${phrase}`);
  }
});

test("hasUsableCallerId accepts normalized inbound numbers", () => {
  assert.equal(
    hasUsableCallerId({ callerPhoneNormalized: "+491701234567", callerPhoneRaw: "+49 170 1234567" }),
    true
  );
});

test("hasUsableCallerId rejects anonymous caller ID", () => {
  assert.equal(hasUsableCallerId({ callerPhoneNormalized: "anonymous", callerPhoneRaw: "anonymous" }), false);
  assert.equal(isAnonymousCallerPhone("anonymous", "anonymous"), true);
});

test("hasUsableCallerId rejects missing caller ID", () => {
  assert.equal(hasUsableCallerId({ callerPhoneNormalized: "", callerPhoneRaw: "" }), false);
});

test("normalizeCallerPhone keeps E164-style values", () => {
  assert.equal(normalizeCallerPhone("+49 170 1234567"), "+491701234567");
});

test("retrieveRagContext fails closed without API URL", async () => {
  const result = await retrieveRagContext({ rag: { apiUrl: "" } }, { query: "Was ist LokalKI?" });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "rag_api_url_missing");
});

test("retrieveRagContext fails closed on timeout", async () => {
  const server = createServer((_req, _res) => {
    // Deliberately never respond before client abort.
  });
  const port = await listen(server);
  try {
    const result = await retrieveRagContext(
      { rag: { apiUrl: `http://127.0.0.1:${port}`, timeoutMs: 120 } },
      { query: "Was ist LokalKI?", timeoutMs: 120 }
    );
    assert.equal(result.ok, false);
    assert.equal(result.reason, "timeout");
    assert.ok(Number(result.latencyMs) >= 80);
  } finally {
    await closeServer(server);
  }
});

test("retrieveRagContext fails closed when API is unreachable", async () => {
  const result = await retrieveRagContext(
    { rag: { apiUrl: "http://127.0.0.1:1", timeoutMs: 400 } },
    { query: "Was ist LokalKI?", timeoutMs: 400 }
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, "request_failed");
});
