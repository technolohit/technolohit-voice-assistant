# Phase 10AJ - RAG Answer Quality And QA Evidence

Date: 2026-06-09  
Target release: `voice-bridge-v1.34.11`

## Status

Implemented in repo for Codex review. Production remains v3 / RAG-off by default.

## Trigger

`voice-bridge-v1.34.10` technically passed Gate 3 live RAG:

- `rag_retrieval_completed=1`
- `used_rag=true`
- `rag_result_count=1`
- `rag_product_scope=smart_website`
- post-call summary created
- rollback safe

Human QA still rejected the result because the combined Smart Website answer was too short and robotic, and SQL evidence did not include a safe response/context preview. Post-call summary also treated a closing phrase such as `Danke, das reicht erstmal` as caller need.

## Changes

### RAG answer synthesis

- Smart Website `combined_product_inquiry` now uses a richer phone-ready RAG answer:
  - definition
  - value / what it does
  - scope-based pricing language
- The answer stays bounded for phone calls and avoids exact price invention.
- Unsafe RAG context is still rejected before a synthesized answer can be marked `used_rag=true`.

### Live TTS length

- v4 plans may set `max_spoken_chars`.
- `prepareLiveAssistantSpeechText()` accepts a per-plan max, capped at 320 chars.
- v3/global `VOICE_ASSISTANT_MAX_RESPONSE_CHARS` default is unchanged.

### QA evidence

Quality events now include privacy-safe previews:

- `response_plan_created.payload.assistant_response_preview`
- `rag_retrieval_completed.payload.rag_answer_preview`
- `rag_retrieval_completed.payload.answer_context_preview`
- `rag_retrieval_completed.payload.rag_source_title_preview`

No raw transcript, raw query, phone number, email, or secret is stored.

### Post-call summary hygiene

- Closing-only caller text such as `Danke`, `Danke, das reicht erstmal`, `Auf Wiederhoeren`, or `das war alles` is not used as `caller_need`.

## Verification

Targeted tests:

```bash
cd voice-bridge
node --test tests/v4-phase10aj-rag-answer-quality-evidence.test.js tests/v4-phase10ah-live-rag-path-equivalence.test.js
```

Result: pass.

Full suite to run before release:

```bash
cd voice-bridge && npm test
python -m pytest rag-api/tests
node --check voice-bridge/src/v4/rag-orchestrator.js voice-bridge/src/v4/response-planner.js voice-bridge/src/v4/live-tts-playback-endpoint.js voice-bridge/src/v4/dialogue-orchestrator.js voice-bridge/src/v4/rag-quality-diagnostics.js voice-bridge/src/post-call-summary.js
.\voice-bridge\scripts\run-ci-dialogue-scenarios.ps1
git diff --check
```

## Gate 3 expectation

Next supervised Gate 3 call should be classified as pass only if:

- `rag_retrieval_completed >= 1`
- `rag_used=true`
- `rag_product_scope=smart_website`
- `rag_result_count > 0`
- `response_type=product_question_answer`
- `plan_reason=combined_product_inquiry`
- caller hears definition + value + scoped pricing without truncation
- safe response/context preview fields are present in SQL
- post-call summary does not classify closing thanks as caller need
- privacy scan remains 0 rows
- rollback to v3/RAG-off succeeds

Production v4 remains blocked until a content-quality Gate 3 pass is recorded and broader production-readiness blockers are closed.
