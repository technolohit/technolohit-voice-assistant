# Phase 10Z — Gate 2 v4 Post-Call Summary Fix

Date: 2026-06-03  
Target release: **`voice-bridge-v1.34.1`**

## Gate 2 failure (observed)

Live v4/RAG-off canary passed runtime/quality checks but post-call pipeline emitted:

- `post_call_summary_failed` → `summary_not_created`
- `call_summaries` row missing for the session
- lead + notification skipped downstream

## Root cause

v3 post-call summary reads persisted **turn transcripts** (`voice.call_transcripts`).

The **live v4 canary path** does not write turn transcripts; it builds outcome metadata in the dialogue orchestrator at call close (`finalizeV4PostCallHandoff`). Two wiring gaps:

1. `finishLiveCanaryCall` flushed quality events but **never closed the orchestrator** or set `ctx.v4PostCallMetadata` before `runPostCallProcessing`.
2. `generatePostCallSummary` returned `null` when `listTurnTranscripts()` was empty, even if v4 handoff metadata was available.

## Fix

| File | Change |
|------|--------|
| `voice-bridge/src/v4/live-audiosocket-handler.js` | `attachLiveV4PostCallHandoff()` closes orchestrator and sets `ctx.v4PostCallMetadata` during live call finish |
| `voice-bridge/src/post-call-summary.js` | `generatePostCallSummaryFromV4Metadata()` builds summary from v4 handoff when turn rows are absent |

## Gate 2 re-test (sysadmin)

After deploying **`voice-bridge-v1.34.1`** with same safe v4/RAG-off canary flags:

1. Run supervised Gate 2 live call (same allowlist/window as before).
2. Confirm session completes and production restored to v3/RAG-off.
3. Verify DB for the session:

```sql
SELECT COUNT(*) FROM voice.call_summaries WHERE call_session_id = '<session_id>';
SELECT event_type, payload->>'reason' AS reason
FROM voice.call_events
WHERE call_session_id = '<session_id>'
  AND event_type LIKE 'post_call_%'
ORDER BY created_at;
```

**Pass:** `call_summaries` count ≥ 1, `post_call_summary_created` present, no `summary_not_created`.

## Non-blocking functional note (Gate 1)

Pricing answer was acceptable but should **briefly explain Smart Website before price**. Track separately in response-planner tuning; not a Gate 2/3 blocker.

## Gate status after fix

| Gate | Status |
|------|--------|
| Stage A baseline | PASS (v1.34.0+) |
| Gate 1 v3/RAG-off | PASS (functional polish optional) |
| Gate 2 v4/RAG-off | **Re-test required** on v1.34.1 |
| Gate 3 v4/RAG-on | Blocked until Gate 2 post-call summary passes |
