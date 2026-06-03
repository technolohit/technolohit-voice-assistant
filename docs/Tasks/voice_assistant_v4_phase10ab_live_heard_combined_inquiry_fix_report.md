# Phase 10AB — Live-Heard Combined Inquiry Fix

Date: 2026-06-03  
Target release: **`voice-bridge-v1.34.3`**

## Blocker confirmed on v1.34.2

Combined Smart Website answer: **413 chars** raw plan text.  
Default live path: `prepareLiveAssistantSpeechText(loadConfig(), plan.text)` trims at
**160 chars** (`VOICE_ASSISTANT_MAX_RESPONSE_CHARS` default). Pricing was cut off
before callers heard it.

## Fix summary

| # | Fix |
|---|-----|
| 1 | Phone-ready combined answer **≤160 chars** with definition + value + scope-based pricing |
| 2 | No env override required for audibility |
| 3 | Tests use real live speech prep path (`prepareLiveAssistantSpeechText`) |
| 4 | `sanitizeResponseText`: `einen Rückruf` → `eine Kontaktaufnahme` (not `einen Kontaktaufnahme`) |
| 5 | Reverted shared `sales-policy.js` Smart Website explanation (v3 unchanged) |
| 6 | Transcript variants covered in tests |
| 7 | Docs + 10H Gate 2 scenario + SQL evidence |
| 8 | First named-product question gets `smart_website` RAG scope before retrieval; a later Gate 3 RAG hit is not replaced by the RAG-off playbook answer |

## Canonical live answer (Smart Website, RAG-off)

```text
Smart Website ist eine moderne Firmenwebsite mit Leistungsseiten und lokaler Sichtbarkeit. Sie bereitet Anfragen besser vor. Der Preis hängt vom Umfang ab.
```

Length: **155 characters** (within default 160 limit).

Callback/consultation offer **omitted** intentionally to preserve audibility.

## Code changes

| File | Change |
|------|--------|
| `voice-bridge/src/v4/playbook-short-answer.js` | `SMART_WEBSITE_COMBINED_LIVE_ANSWER`, `COMBINED_LIVE_TTS_CHAR_LIMIT=160` |
| `voice-bridge/src/v4/transcript-intent.js` | Article-safe Rückruf sanitization |
| `voice-bridge/src/sales-policy.js` | Reverted v3 shared Smart Website explanation |
| `voice-bridge/src/v4/live-tts-playback-endpoint.js` | Reverted 300-char fallback (uses config default again) |
| `voice-bridge/src/v4/dialogue-orchestrator.js` | Derive retrieval-only product scope from the current closed-domain match before first-turn RAG retrieval |
| `voice-bridge/src/v4/response-planner.js` | Preserve a real RAG answer for combined inquiries when RAG is enabled |
| `voice-bridge/tests/v4-phase10ab-combined-inquiry-live-tts.test.js` | Live TTS path tests + 3 transcript variants |
| `voice-bridge/tests/v4-phase10u-rag-live-canary-readiness.test.js` | First named combined inquiry is product-scoped and uses the RAG answer |

## Gate 2 combined-inquiry pass criteria (functional)

After **v1.34.3** deploy (same v4/RAG-off Gate 2 window as before):

**Utterance variants (any one):**

- `Was ist Smart Website, was macht sie und was kostet sie?`
- `Was ist die Smart-Webseite und was kostet sie?`
- `Was macht die smarte Webseite und wie viel kostet das?`

**Live pass:**

- Caller hears definition, value, and pricing (no mid-sentence truncation)
- No immediate Neukunde / `collect_sales_context`
- Post-call summary still required. The v1.34.1 fix must be verified with live DB evidence.

## SQL evidence (Gate 2 combined inquiry)

```sql
SELECT created_at,
       payload->>'response_type' AS response_type,
       payload->>'plan_reason' AS plan_reason,
       payload->>'current_product_context' AS current_product_context,
       payload->>'matched_product' AS matched_product
FROM voice.call_quality_events
WHERE call_session_id = '<CALL_SESSION_ID>'::uuid
  AND event_type = 'response_plan_created'
ORDER BY created_at;
```

**Pass:**

- `response_type=product_question_answer`
- `plan_reason=combined_product_inquiry`
- `current_product_context=smart_website`
- No row with `response_type=collect_sales_context` for the combined-inquiry turn

**Fail query (must return 0 rows for combined turn):**

```sql
SELECT created_at, payload->>'response_type', payload->>'plan_reason'
FROM voice.call_quality_events
WHERE call_session_id = '<CALL_SESSION_ID>'::uuid
  AND event_type = 'response_plan_created'
  AND payload->>'response_type' = 'collect_sales_context';
```

## Post-call summary (still required)

```sql
SELECT COUNT(*) AS summary_count
FROM voice.call_summaries
WHERE call_session_id = '<CALL_SESSION_ID>'::uuid;

SELECT event_type, payload->>'reason' AS reason
FROM voice.call_events
WHERE call_session_id = '<CALL_SESSION_ID>'::uuid
  AND event_type LIKE 'post_call_%'
ORDER BY created_at;
```

**Pass:** `summary_count >= 1`, `post_call_summary_created` present (v1.34.1+).

## Local verification (2026-06-03)

| Check | Result |
|-------|--------|
| `cd voice-bridge && npm test` | **442/442 pass** |
| `python -m pytest rag-api/tests` (repo root) | **7/7 pass** |
| `node --check` on changed JS | pass |
| `git diff --check` | pass (CRLF warnings only) |
| `voice-bridge/scripts/run-ci-dialogue-scenarios.ps1` | **26/26 pass** |

**Default prepared live TTS text** (`prepareLiveAssistantSpeechText(loadConfig(), SMART_WEBSITE_COMBINED_LIVE_ANSWER)`):

```text
Smart Website ist eine moderne Firmenwebsite mit Leistungsseiten und lokaler Sichtbarkeit. Sie bereitet Anfragen besser vor. Der Preis hängt vom Umfang ab.
```

**Length: 155 characters** (max configured: 160). No ellipsis, no truncation.

## Gate status

| Gate | Status |
|------|--------|
| Stage A | PASS |
| Gate 1 v3/RAG-off | PASS |
| Gate 2 infra | PASS |
| Gate 2 functional | Pending **v1.34.3** live re-test after Codex review |
| Gate 3 | Blocked |

Production remains **v3 / RAG-off** between windows.
