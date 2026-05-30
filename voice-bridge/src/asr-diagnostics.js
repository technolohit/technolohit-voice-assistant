/**
 * ASR / semantic diagnostics for offline evaluation (QA-safe; no full phone numbers in logs).
 */

function redactPhoneLike(text) {
  return String(text ?? "").replace(/\b(\+?\d[\d\s\-().]{6,}\d)\b/g, "[phone-redacted]");
}

export function createAsrDiagnosticRecord({
  callSessionId = "",
  turnIndex = 0,
  transcript = "",
  expectedIntent = "",
  actualIntent = "",
  semanticConfidence = null,
  stage = "",
  asrProvider = "",
  asrModel = "",
  snippetId = null
}) {
  return {
    call_session_id: String(callSessionId || "").slice(0, 64),
    turn_index: Number(turnIndex) || 0,
    transcript_preview: redactPhoneLike(transcript).slice(0, 200),
    expected_intent: String(expectedIntent || ""),
    actual_intent: String(actualIntent || ""),
    semantic_confidence: Number.isFinite(Number(semanticConfidence)) ? Number(semanticConfidence) : null,
    stage: String(stage || ""),
    asr_provider: String(asrProvider || ""),
    asr_model: String(asrModel || ""),
    audio_snippet_id: snippetId ? String(snippetId).slice(0, 64) : null,
    captured_at: new Date().toISOString()
  };
}

export function logAsrDiagnostic(record) {
  if (!record) return;
  console.log(
    `[voice-asr-diag] turn=${record.turn_index} stage=${record.stage} expected=${record.expected_intent} actual=${record.actual_intent} semantic_conf=${record.semantic_confidence ?? "n/a"} provider=${record.asr_provider || "unknown"}`
  );
}

/**
 * Replay fixture turns and compare expected vs interpreted customer_type intent.
 */
export function evaluateTranscriptFixture(fixture, interpretFn) {
  const turns = Array.isArray(fixture?.turns) ? fixture.turns : [];
  const results = [];
  const context = fixture?.context || {};

  for (let i = 0; i < turns.length; i += 1) {
    const turn = turns[i];
    const transcript = String(turn?.caller || turn?.transcript || "");
    const expected = turn?.expected_intent || turn?.expected_customer_type || "";
    if (!expected) continue;
    const interpreted = interpretFn(transcript, context);
    const actual =
      interpreted?.intent === "customer_type" ? interpreted.value : interpreted?.intent || "unknown";
    const match =
      expected === actual ||
      (expected === "customer_type:new_prospect" && actual === "new_prospect") ||
      (expected === "customer_type:agency_partner" && actual === "agency_partner") ||
      (expected === "customer_type:existing_customer" && actual === "existing_customer");
    results.push({
      turn: i + 1,
      transcript,
      expected,
      actual,
      confidence: interpreted?.confidence ?? null,
      match
    });
  }
  return results;
}
