# Voice Assistant Soft Intake Turn Budget Bugfix v1 Report

## Files Changed
- `voice-bridge/src/turn-assistant.js`
- `voice-bridge/src/persist.js`
- `voice-bridge/src/config.js`
- `voice-bridge/src/index.js`
- `voice-bridge/.env.example`
- `.env.example`
- `voice-bridge/README.md`
- `docs/voice-database.md`

## Root Cause
The assistant loop used `VOICE_ASSISTANT_MAX_TURNS` as a hard cap for all calls.  
When Soft Intake asked for contact detail/permission close to turn 3, the conversation could hit generic max-turn close before processing the next caller answer.

## Fix Summary
- Added explicit intake waiting-state handling (`contact_preference`, `contact_detail`, `permission`) in `turn-assistant`.
- Ensured detail/permission waiting is processed before generic max-turn close logic.
- Added intake-only max-turn extension with new config `VOICE_ASSISTANT_MAX_TURNS_WITH_INTAKE` (default `5`).
- Added deterministic, intake-safe max-turn close texts so callback-time prompts are not used while detail/permission is still missing.
- Added one retry for unclear email/phone detail capture, then safe fallback to `info@technolohit.com`.

## Intake State Priority Changes
- Priority now enforces:
  1. waiting for contact detail -> process detail attempt first
  2. waiting for permission -> process yes/no first
  3. generic max-turn close only after intake is complete/declined/failed
- Added state fields:
  - `soft_intake_waiting_for`
  - `contact_detail_retry_count`
  - `soft_intake_completed`
  - `max_turns_extended_for_intake`
  - `max_turns_blocked_by_active_intake`

## Max Turn / Turn Budget Changes
- Base cap remains `VOICE_ASSISTANT_MAX_TURNS` (default `3`).
- New intake cap `VOICE_ASSISTANT_MAX_TURNS_WITH_INTAKE` (default `5`) is used only while soft intake is active and incomplete.
- Normal non-intake calls are unchanged.

## Template Changes
- Added deterministic retry prompts for unclear detail turn:
  - email unclear -> retry once with `info@technolohit.com` fallback hint
  - phone unclear -> retry once with `info@technolohit.com` fallback hint
- Added intake-safe max-turn close variants:
  - missing email detail
  - missing phone detail
  - missing permission
- Prevented callback-time prompt during active, incomplete soft intake.

## Metadata / Events
- No schema migration.
- Extended existing transcript/event JSONB payloads via `persist.js` to include:
  - `soft_intake_waiting_for`
  - `contact_detail_retry_count`
  - `soft_intake_completed`
  - `max_turns_extended_for_intake`
  - `max_turns_blocked_by_active_intake`
- Existing soft-intake event types remain in use; no lead extraction or lead-table writes were added.

## Docker Image Built And Pushed
- Repository: `thnhit/technhvoice`
- Required release tag: `voice-bridge-soft-intake-turn-budget-v1-20260521-005742`
- Also pushed: `voice-bridge-latest`
- Also pushed SHA tag: `voice-bridge-85dbb09`
- Digest: `sha256:5563cf362ee7417c340ec45a07cc7d23b60f8c9609387f069b8ba514845a1d4c`
- Build command:
  - `npm run docker:build:voice-bridge -- voice-bridge-soft-intake-turn-budget-v1-20260521-005742 voice-bridge-latest voice-bridge-85dbb09`
- Push command:
  - `npm run docker:push:voice-bridge -- voice-bridge-soft-intake-turn-budget-v1-20260521-005742 voice-bridge-latest voice-bridge-85dbb09`
- Local image sanity check:
  - `docker image inspect thnhit/technhvoice:voice-bridge-soft-intake-turn-budget-v1-20260521-005742 --format "image_id={{.Id}}"`
  - Result: `image_id=sha256:5563cf362ee7417c340ec45a07cc7d23b60f8c9609387f069b8ba514845a1d4c`

## Validation Results
- `node --check voice-bridge/src/config.js` -> pass
- `node --check voice-bridge/src/index.js` -> pass
- `node --check voice-bridge/src/turn-assistant.js` -> pass
- `node --check voice-bridge/src/persist.js` -> pass
- `npm run validate` -> pass

## Manual QA Matrix
| Scenario | Expected | Result (code-path validation) |
|---|---|---|
| Email asked -> next caller turn | Next turn processed as detail attempt before max-turn close | Pass |
| Phone asked -> next caller turn | Next turn processed as detail attempt before max-turn close | Pass |
| Permission asked -> next caller turn | Next turn processed as yes/no before generic max-turn close | Pass |
| Active soft intake at base turn cap | Intake gets extended cap (default 5) | Pass |
| Missing detail/permission near cap | Intake-safe close message (no callback-time ask) | Pass |
| Unclear detail input | One short retry, then safe fallback | Pass |

## Sysadmin Deployment Guide
See `docs/Tasks/sysadmin_voice_bridge_soft_intake_turn_budget_v1.md`.

## Out-of-Scope Confirmed
- No lead extraction
- No writes to `voice.leads`
- No writes to `voice.call_summaries`
- No n8n/notification/Botinteg/CRM/calendar integration
- No caller ID capture
- No DB migration
- No major architecture refactor

## Deferred Follow-ups
- Live-call QA on cloud should confirm STT behavior for heavily spelled email/phone utterances.
- If needed later, tune regex heuristics for edge dialect/staccato phone spelling while keeping deterministic flow.
