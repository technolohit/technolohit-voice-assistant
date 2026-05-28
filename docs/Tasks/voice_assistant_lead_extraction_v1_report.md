# Voice Assistant Lead Extraction v1 Report

Date: 2026-05-21

## Summary

Implemented Phase 6 (Lead Extraction v1) on top of stable post-call summary. Extraction/enrichment runs only in post-call flow, not in realtime assistant turns, and uses explicit guards to avoid noisy or duplicate lead rows.

## Files Changed

- `voice-bridge/src/config.js`
- `voice-bridge/src/db.js`
- `voice-bridge/src/post-call.js`
- `voice-bridge/src/post-call-lead.js` (new)
- `voice-bridge/src/persist.js`
- `voice-bridge/.env.example`
- `voice-bridge/README.md`
- `docs/Tasks/technolohit_voice_agent_productization_blueprint.md`

## Runtime Behavior

Post-call pipeline now:

1. recording/transcription (existing)
2. deterministic post-call summary (Phase 5)
3. lead extraction/enrichment (Phase 6)

### Guardrails

- Prefer updating existing `voice.leads` row for the same `call_session_id`.
- Create new lead only when no lead exists and guard conditions pass.
- Guard conditions include:
  - explicit contact route (`phone` / `email`)
  - valid permission path
  - acceptable summary quality signal
- No raw transcript text is stored in lead metadata.

## Metadata Added To Leads

- `summary_id`
- `summary_type`
- `post_call_lead_extraction_v1`
- `product_interest`
- `caller_need`
- `contact_preference`
- `permission`
- `phone_present`
- `email_directed`
- `next_action`
- `confidence`
- `transcript_quality_notes`

## Observability

New call events:

- `post_call_lead_processed` (created / updated / skipped + reason)
- `post_call_lead_failed`

## Config

New env flag:

```env
VOICE_POST_CALL_LEAD_EXTRACTION_ENABLED=true
```

## Scope Control (No Overlap)

- No notification dispatch added (Phase 7 remains separate).
- No realtime path write amplification.
- No RAG/pgvector infra changes.
