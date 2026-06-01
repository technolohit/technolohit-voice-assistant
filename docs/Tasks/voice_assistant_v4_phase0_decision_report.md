# TechnoloHit Voice Assistant v4 — Phase 0 Decision Report

Date: 2026-06-01  
Status: **Blocked for acceptance** (documentation complete; partial live/sysadmin validation found blocking issues)
Blueprint: [voice_assistant_v4_realtime_tenant_ready_blueprint.md](./voice_assistant_v4_realtime_tenant_ready_blueprint.md)

---

## 1. Executive Summary

### What v4 is trying to achieve

v4 replaces the current **turn-based** voice assistant (`listen → write WAV → batch STT → LLM → full TTS → blocking playback`) with a **real-time, low-latency runtime** that still serves TechnoloHit production first, but is **tenant-ready by design** for a future second customer.

Phase 1 targets:

- Streaming or incremental STT with partial transcripts
- Fast, configurable endpointing (VAD-backed, not RMS-only)
- Streaming or sentence-chunk low-latency TTS
- Barge-in validation (caller interrupts assistant; playback stops)
- Structured `CallSessionMemory` and deterministic state machine
- Rule/validator-based lead creation (not LLM/RAG-driven)
- RAG scoped to product/sales Q&A only
- Reliable post-call summary/lead/notification pipeline
- Usage/quality events and tenant/agent/version fields

### What must not be implemented yet

Per blueprint non-goals for Phase 1:

- Billing, public signup, customer self-service UI, white-label builder
- Enterprise installer, Kubernetes/Helm requirement
- Full multi-tenant SaaS control plane
- LLM/RAG creating callback-ready leads, validating phones, or granting permission

**No Phase 1 implementation should start until this report is accepted and sysadmin blockers in §11 are resolved.**

### Is the repo ready for Phase 1 after Phase 0?

| Area | Ready? | Evidence |
|------|--------|----------|
| Telephony path (Asterisk + AudioSocket) | Yes (production) | `voice-bridge/src/audiosocket.js`, `media-outbound.js` |
| Persistence / post-call / leads / dashboard | Yes (foundation) | `persist.js`, `post-call-*.js`, `db/voice/migrations/*.sql`, `lead-dashboard/` |
| RAG API with tenant scoping | Partially ready | RAG is reachable from voice-bridge via host-local URL `http://127.0.0.1:8080`; `tenant_id` exists, `agent_id` still missing |
| Real-time STT/TTS/barge-in | **No** | Turn-based only; no playback cancel |
| Tenant-ready voice schema | **No** | Migrations not written yet |
| Agent config model | **No** | Business logic still in `turn-assistant.js` (~4,332 lines) |
| Barge-in feasibility | **Conditionally feasible via AudioSocket** | v3 default failed, but Phase 0B repeatability QA produced repeated `immediate_stop` results |
| Concurrency capacity | **Partially ready** | Server has enough initial CPU/RAM headroom; operational target still unconfirmed |

**Verdict:** Repository is **not ready to start Phase 1 implementation yet**, but the Phase 0B media-path blocker has been downgraded. Repeatability QA showed that bridge-side AudioSocket playback cancellation can reliably produce audible `immediate_stop` behavior with no call drops or garbled audio. The recommended v4 media path is now **AudioSocket, conditionally accepted for playback cancellation**. Full barge-in behavior is **not accepted yet** — Phase 0C interruption recovery is implemented behind a disabled flag; live QA is required before accepting post-interruption dialogue correctness. RAG is reachable via `http://127.0.0.1:8080`, not Docker DNS. Remaining blockers include Phase 0C live QA and operational/security acceptance items.

---

## 2. Existing Architecture Evidence

### Asterisk / AudioSocket path

- TCP server binds `VOICE_BRIDGE_HOST` / `VOICE_BRIDGE_PORT` (default `0.0.0.0:9092`) — `voice-bridge/src/config.js`, `voice-bridge/src/index.js`.
- Frame protocol: 1-byte type + 2-byte BE length + payload — `voice-bridge/src/audiosocket-protocol.js`.
- Inbound audio types `0x10–0x18`; outbound uses `AUDIO_SLIN16_8K` (`0x10`) — signed 16-bit LE mono **8 kHz**.
- Call lifecycle: UUID frame → DB session → greeting playback → silence writer → turn assistant — `voice-bridge/src/audiosocket.js` lines 170–189, 193–206.
- Caller ID optionally embedded in UUID payload (JSON or KV) — `audiosocket.js` `parseIdentityPayload()`.
- Production env authority: `/opt/technolohit-voice/voice-bridge/.env` — `docs/voice-bridge-runtime-env.md`.

### voice-bridge turn-based runtime

- Explicitly documented as **not full realtime** — `voice-bridge/README.md` § "Turn-Based Assistant MVP".
- Flow: greeting → `startOneTurnAssistant()` → per-turn `listenForTurn()` → WAV write → batch STT → response → `playAssistantAudio()` → repeat — `media-outbound.js`, `turn-assistant.js`.
- Monolith: `turn-assistant.js` (~4,332 lines) owns intake, sales, RAG hooks, TTS, playback orchestration, templates, and persistence callbacks.
- Endpointing: RMS threshold (`speechRmsThreshold`, default 450) + silence window (`VOICE_ASSISTANT_END_SILENCE_MS`, default 900 ms) — `turn-assistant.js` `captureAssistantTurnAudio()`, `listenForTurn()`.
- No streaming STT, no streaming LLM, no streaming TTS, no barge-in.

### STT/TTS current model

| Component | Current | Config |
|-----------|---------|--------|
| STT | Batch file upload to OpenAI `audio.transcriptions.create` | `VOICE_TRANSCRIPTION_MODEL` default `gpt-4o-mini-transcribe`, language `de` |
| TTS | Batch `audio.speech.create` → WAV → ffmpeg → PCM | `VOICE_ASSISTANT_TTS_MODEL` default `gpt-4o-mini-tts`, voice `marin` |
| LLM | `gpt-4o-mini` chat completions | `VOICE_ASSISTANT_MODEL` |
| Assistant gate | `VOICE_ASSISTANT_ENABLED` default **false** | `config.js` |

Playback streams pre-generated PCM in **20 ms frames** with fixed `sleep(config.frameMs)` — `media-outbound.js` `streamPcmToSocket()`.

### State / memory currently available

In-call state is spread across `ctx.assistantTurn`:

- `intake` — contact preference, permission, soft intake milestones
- `product` — product selection, sales context, dialogue state
- `history` — compact turn history
- Metadata persisted per turn in `voice.call_transcripts.metadata` and `voice.call_events` — `persist.js`

No unified `CallSessionMemory` model. No `tenant_id` / `agent_id` on sessions.

### RAG API

- FastAPI service: `/v1/retrieve`, `/v1/ingest/document` — `rag-api/app/main.py`.
- Retrieval filtered by `tenant_id`; embeddings in `knowledge.*` tables — `rag-api/app/retrieval.py`, `db/knowledge/migrations/001_knowledge_schema.sql`.
- `RetrieveRequest` has `tenant_id` but **no `agent_id`** — `rag-api/app/models.py`.
- voice-bridge RAG client: timeout defaults 700 ms (1200 ms QA mode) — `config.js`.
- Production default: `VOICE_RAG_ENABLED=false` — `docs/voice-bridge-runtime-env.md`.
- Production networking note: `technolohit-voice-bridge` currently runs on Docker host network while `technolohit-rag-api` is on `asterisk_default`; therefore voice-bridge must use `http://127.0.0.1:8080` for RAG health/retrieve calls unless networking is changed.

### PostgreSQL voice schema

Migrations: `db/voice/migrations/001`–`005`.

Core tables:

- `voice.call_sessions` — external_call_id, caller phones, status, metadata JSONB
- `voice.call_events` — timeline
- `voice.call_transcripts` — speaker, text, sequence_number, metadata (turn scope, intents, intake fields)
- `voice.call_summaries` — post-call auto summary
- `voice.leads` — phone, status, metadata JSONB (no `custom_fields` column yet)
- `voice.lead_access_audit`, `voice.lead_followup_status` — dashboard support

No `tenant_id`, `agent_id`, version columns, or `call_quality_events` table yet.

### Post-call pipeline

- Triggered on socket close — `audiosocket.js` `finish()` → `runPostCallProcessing()`.
- Summary: deterministic fields from turn transcripts — `post-call-summary.js`, `lead-policy.js`.
- Lead extraction: validator guards (`shouldCreateCallbackReadyLead`) — `post-call-lead.js`.
- Events: `post_call_summary_created`, `post_call_lead_processed`, notification webhook — `persist.js`.
- Independent of realtime turn path (safe for v3/v4 flag split).

### Lead dashboard / privacy

- FastAPI + Basic Auth, WireGuard-only deployment pattern — `lead-dashboard/app/main.py`.
- Phone masked by default; explicit reveal with audit — `reveal-phone` route, `voice.lead_access_audit`.
- Status workflow: new / contacted / not_reachable / done.
- Privacy headers, redaction filters — `privacy.py`, middleware.

### CI/CD

- **CI** (`.github/workflows/ci.yml`): JS syntax, voice-bridge unit tests, 24 dialogue QA scenarios, RAG contract tests, secret/artifact guard.
- **Docker publish** (`.github/workflows/docker-publish.yml`): semver tags → `thnhit/technhvoice:voice-bridge-*`, `rag-api-*`.
- **Deploy** (`.github/workflows/deploy.yml`): manual dispatch, immutable image tag, optional v3 env verification.
- Rollback pattern documented — `docs/release-and-cicd.md` § Rollback.

---

## 3. AudioSocket Barge-In Feasibility

### Required behavior (from blueprint)

```text
TTS playing → caller speaks → VAD detects → playback stops → STT listens → interruption context → state machine
```

### Code evidence

#### Is playback currently cancellable?

**No.** `streamPcmToSocket()` runs a sequential loop with no abort signal, cancellation token, or external stop hook:

```23:40:voice-bridge/src/media-outbound.js
export async function streamPcmToSocket(socket, pcm, config, label) {
  // ...
  for (const chunk of iteratePcmChunks(pcm, chunkBytes)) {
    if (!socket.writable) break;
    await writeFrame(socket, frameType, chunk);
    // ...
    await sleep(config.frameMs);
  }
}
```

`playAssistantAudio()` awaits full completion before returning — `turn-assistant.js` ~4056–4078. There is no `AbortController`, playback session object, or concurrent monitor task.

#### Is inbound audio still captured while assistant audio is playing?

**Partially.**

| Capture path | During TTS playback? | Notes |
|--------------|---------------------|-------|
| `captureInboundAudio()` (full-call recording) | **Yes** | Always called on inbound frames — `audiosocket.js` line 197 |
| `captureAssistantTurnAudio()` (turn VAD buffer) | **No** | Requires `state.active === true` — only set during `listenForTurn()` — `turn-assistant.js` 3532–3537, 3580–3588 |

Inbound frames **continue to arrive** at the TCP handler during playback (`audiosocket.js` 193–206), but the turn assistant **does not process them for speech detection** until playback finishes and the next `listenForTurn()` starts.

#### Can current `streamPcmToSocket` be interrupted safely?

**Not as implemented.** To interrupt safely later, code would need:

1. **Playback controller** — abort flag checked each frame iteration; optional `stopSilenceWriter` coordination.
2. **Concurrent inbound monitor** — VAD on inbound frames during playback (reuse or replace RMS heuristic).
3. **Asterisk-side behavior validation** — stopping outbound frames may leave buffered audio playing on the PSTN leg; unknown without live test.
4. **State handoff** — record interrupted text, stage, approximate playback position, partial caller audio for STT.
5. **No double-writer race** — silence writer vs playback writer already toggled in `playAssistantAudio()`; barge-in must avoid overlapping outbound sources.

#### What code changes would be needed later (Phase 2–3)?

- Refactor `streamPcmToSocket` → `PlaybackSession` with `cancel()`, `onFrame`, position tracking.
- Always-on inbound tap (or parallel VAD task) active during playback.
- Streaming STT buffer fed from interruption audio, not only post-turn WAV.
- Event: `barge_in_detected` in quality events + orchestrator interruption context.
- Feature flag: `VOICE_V4_BARGE_IN_ENABLED`.

#### What server/live tests are required?

Sysadmin must run on production or QA Asterisk host:

```bash
# 1. Confirm AudioSocket / telephony modules
docker exec technolohit-asterisk asterisk -rx "core show applications" | egrep -i "AudioSocket|ExternalMedia|ARI|Stasis"
docker exec technolohit-asterisk asterisk -rx "module show like res_audiosocket"
docker exec technolohit-asterisk asterisk -rx "module show like ari"
docker exec technolohit-asterisk asterisk -rx "module show like external"

# 2. During a test call with long TTS playing, sysadmin interrupts speech and observes:
#    - Does caller hear assistant stop within ~300-500 ms?
#    - Does bridge log show inbound frames continuing during outbound?
docker logs -f technolohit-voice-bridge | egrep -i "inbound audio|finished sending|assistant response"

# 3. After v4 prototype (Phase 3): measure time from caller speech onset to playback stop
#    Target: ≤400 ms (see §5)
```

**Questions for sysadmin:**

1. When voice-bridge stops sending outbound AudioSocket frames mid-utterance, does Asterisk immediately stop audio to the caller, or does it play out an internal buffer?
2. Is `ExternalMedia` or ARI available as fallback if AudioSocket stop is unreliable?
3. Is there a dedicated QA DID or internal extension for non-production v4 tests?

### Decision

| Status | **Failed with current live/manual behavior** |
|--------|------------------------------------------|

**Code analysis:** Architecture is **plausibly extensible** (inbound frames already received during playback; outbound is bridge-controlled), but **barge-in is not implemented**. Partial live validation showed that caller interruption did **not** stop current assistant playback, so current AudioSocket/v3 playback behavior is not acceptable for v4 barge-in as-is.

**Conditional path (aligned with blueprint):**

- Do **not** assume the current AudioSocket path is sufficient.
- Either prove that AudioSocket playback cancellation can be implemented reliably, or escalate to **ARI/ExternalMedia / new realtime media bridge** rather than patching v3 indefinitely.

---

## 3B. Phase 0B Media-Path Feasibility Spike

Date: 2026-06-01  
Runbook: [voice_assistant_v4_phase0b_playback_cancel_spike_runbook.md](./voice_assistant_v4_phase0b_playback_cancel_spike_runbook.md)

### Files inspected

| File | Role |
|------|------|
| `voice-bridge/src/media-outbound.js` | Outbound PCM frame loop, silence writer |
| `voice-bridge/src/turn-assistant.js` | `playAssistantAudio()`, RMS listen path, turn capture |
| `voice-bridge/src/audiosocket.js` | Inbound frame dispatch during playback |
| `voice-bridge/src/config.js` | Env flag loading |
| `voice-bridge/src/playback-session.js` | **New** — spike playback session + inbound monitor |

### Minimal cancellable playback path (implemented)

| Component | Implementation |
|-----------|----------------|
| Playback session | `createPlaybackSession()` with `cancelled`, `cancelReason`, frame counters |
| Cancel signal | `requestPlaybackCancel()` sets `session.cancelled = true` |
| Stop in frame loop | `streamPcmToSocket()` checks `playbackSession?.cancelled` before/after each frame |
| Inbound speech during playback | `monitorInboundDuringPlayback()` on inbound AudioSocket frames when `ctx.activePlaybackSession` is set |
| Silence writer coordination | Unchanged: `stopSilenceWriter` before playback, `startSilenceWriter` after (including cancel exit) |
| Double-writer prevention | Silence writer stopped for entire playback/cancel window |
| Socket safety | Loop breaks on `!socket.writable`; no write after break |

### Spike feature flag (default off)

```env
VOICE_V4_PLAYBACK_CANCEL_SPIKE_ENABLED=false   # default — no production change
VOICE_V4_PLAYBACK_CANCEL_SPIKE_RMS_THRESHOLD=450
VOICE_V4_PLAYBACK_CANCEL_SPIKE_SPEECH_FRAMES=3   # ~60 ms at 20 ms frames
```

When **disabled** (default): `playAssistantAudio()` uses the original `streamPcmToSocket()` path with no session and no inbound monitor.

When **enabled** (QA only): assistant TTS playback attaches a session; inbound RMS speech triggers cancel; spike logs emitted.

### Spike logging (flag enabled only)

| Event | Log prefix |
|-------|------------|
| `playback_started` | `[v4-playback-spike]` |
| `playback_cancel_requested` | includes `cancellation_reason`, `frames_sent_before_cancel` |
| `playback_cancelled` | includes `cancel_latency_ms` |
| Frame loop stop | `[voice-bridge] cancelled sending ...` |

No secrets, phone numbers, or transcript previews in spike logs.

### Unit tests added

File: `voice-bridge/tests/playback-cancel-spike.test.js`

- Default flag off in `loadConfig()`
- Full playback without session unchanged
- Cancel signal stops frame loop early
- No writes after socket closed
- Inbound monitor triggers cancel when spike enabled
- Monitor inactive when spike disabled

All 57 voice-bridge tests pass (`npm test`).

### Risks and limits

| Risk | Mitigation / note |
|------|-------------------|
| Asterisk buffers outbound audio after bridge stops sending | **Live test required** — code cancel ≠ audible stop |
| RMS false positives (line noise) | Tunable threshold/frame count; not production VAD |
| Spike only covers assistant TTS | Greeting playback unchanged |
| No dialogue recovery after cancel | Out of spike scope |
| Prior live test failed on **v3 default** (flag off) | Expected — spike not active in that test |

### Phase 0B decision status

| Layer | Status |
|-------|--------|
| Bridge code cancellation | **Implemented behind disabled flag** |
| Inbound monitor during playback | **Implemented behind disabled flag** |
| Audible/PSTN stop | **Repeatability QA passed: repeated immediate_stop** |
| Implementation path (AudioSocket vs ARI/ExternalMedia) | **AudioSocket conditionally accepted for playback cancellation** |

### First spike live QA result

Date: 2026-06-01
Image: `thnhit/technhvoice:voice-bridge-v1.3.3`
Spike env:

```env
VOICE_V4_PLAYBACK_CANCEL_SPIKE_ENABLED=true
VOICE_V4_PLAYBACK_CANCEL_SPIKE_RMS_THRESHOLD=450
VOICE_V4_PLAYBACK_CANCEL_SPIKE_SPEECH_FRAMES=3
```

Classification: **immediate_stop**

Human observation:

- Caller interrupted while assistant was speaking.
- Assistant audibly stopped when caller said "Stop".
- Caller was then able to ask the next question normally.
- Assistant answered the next question correctly.
- No call drop observed.
- No garbled audio observed.
- Playback stop felt immediate from caller perspective.

Redacted log evidence:

```text
[v4-playback-spike] playback_started bridge_call_id=969901eb-0183-411b-8030-abb1b5289d76 turn_index=1 label=assistant response pcm_bytes=167200
[v4-playback-spike] playback_cancel_requested bridge_call_id=969901eb-0183-411b-8030-abb1b5289d76 turn_index=1 label=assistant response cancellation_reason=inbound_speech_detected frames_sent_before_cancel=194
[voice-bridge] cancelled sending assistant response frames=194 bytes=62080 reason=inbound_speech_detected
[v4-playback-spike] playback_cancelled bridge_call_id=969901eb-0183-411b-8030-abb1b5289d76 turn_index=1 label=assistant response cancellation_reason=inbound_speech_detected frames_sent_before_cancel=194 cancel_latency_ms=21
[v4-playback-spike] playback_started bridge_call_id=969901eb-0183-411b-8030-abb1b5289d76 turn_index=2 label=assistant response pcm_bytes=86400
[voice-bridge] finished sending assistant response frames=270 bytes=86400
```

Interpretation: AudioSocket playback cancellation is feasible in principle, but the result must be repeated before Phase 0 accepts AudioSocket as the v4 media path.

### Repeatability validation result

Date: 2026-06-01
Image: `thnhit/technhvoice:voice-bridge-v1.3.3`
Spike env:

```env
VOICE_V4_PLAYBACK_CANCEL_SPIKE_ENABLED=true
VOICE_V4_PLAYBACK_CANCEL_SPIKE_RMS_THRESHOLD=450
VOICE_V4_PLAYBACK_CANCEL_SPIKE_SPEECH_FRAMES=3
```

Post-test state:

```env
VOICE_V4_PLAYBACK_CANCEL_SPIKE_ENABLED=false
```

Classification: **PASS for playback cancellation feasibility**

Observed cancel latencies:

- 8 ms
- 21 ms
- 20 ms
- 20 ms
- 20 ms
- 19 ms
- 20 ms
- 18 ms

Human observation:

- On interruption, the assistant audibly stopped.
- No call drop observed.
- No garbled audio observed.
- Caller could continue the call.

Important behavior issue:

- Media cancellation works.
- After interruption and a product/topic change, the assistant sometimes answers with the wrong context or continues the previous topic.
- Therefore AudioSocket playback cancellation is feasible, but **full barge-in dialogue behavior is not correct yet**.

Redacted log evidence:

```text
[v4-playback-spike] playback_started bridge_call_id=d28ffcfa-5139-42e6-b405-f03113045443 turn_index=1 label=assistant response pcm_bytes=168800
[v4-playback-spike] playback_cancel_requested bridge_call_id=d28ffcfa-5139-42e6-b405-f03113045443 turn_index=1 label=assistant response cancellation_reason=inbound_speech_detected frames_sent_before_cancel=218
[voice-bridge] cancelled sending assistant response frames=218 bytes=69760 reason=inbound_speech_detected
[v4-playback-spike] playback_cancelled bridge_call_id=d28ffcfa-5139-42e6-b405-f03113045443 turn_index=1 label=assistant response cancellation_reason=inbound_speech_detected frames_sent_before_cancel=218 cancel_latency_ms=8
[v4-playback-spike] playback_cancelled bridge_call_id=d28ffcfa-5139-42e6-b405-f03113045443 turn_index=2 cancellation_reason=inbound_speech_detected frames_sent_before_cancel=177 cancel_latency_ms=21
[v4-playback-spike] playback_cancelled bridge_call_id=d28ffcfa-5139-42e6-b405-f03113045443 turn_index=3 cancellation_reason=inbound_speech_detected frames_sent_before_cancel=178 cancel_latency_ms=20
[v4-playback-spike] playback_cancelled bridge_call_id=d28ffcfa-5139-42e6-b405-f03113045443 turn_index=4 cancellation_reason=inbound_speech_detected frames_sent_before_cancel=266 cancel_latency_ms=20
[v4-playback-spike] playback_cancelled bridge_call_id=d28ffcfa-5139-42e6-b405-f03113045443 turn_index=5 cancellation_reason=inbound_speech_detected frames_sent_before_cancel=147 cancel_latency_ms=20
[v4-playback-spike] playback_cancelled bridge_call_id=ef9dbf0b-04a4-4095-8b3a-0afcb0d147e9 turn_index=1 cancellation_reason=inbound_speech_detected frames_sent_before_cancel=288 cancel_latency_ms=19
[v4-playback-spike] playback_cancelled bridge_call_id=ef9dbf0b-04a4-4095-8b3a-0afcb0d147e9 turn_index=2 cancellation_reason=inbound_speech_detected frames_sent_before_cancel=262 cancel_latency_ms=20
[v4-playback-spike] playback_cancelled bridge_call_id=ef9dbf0b-04a4-4095-8b3a-0afcb0d147e9 turn_index=3 cancellation_reason=inbound_speech_detected frames_sent_before_cancel=329 cancel_latency_ms=18
```

### Exact live validation commands (spike enabled on QA host)

```bash
# Enable on test host only — see runbook
docker exec technolohit-voice-bridge sh -lc 'printenv | sort | egrep "^VOICE_V4_PLAYBACK_CANCEL_SPIKE_"'

# During test call
docker logs -f technolohit-voice-bridge 2>&1 | egrep -i "v4-playback-spike|cancelled sending assistant"

# Collect evidence
docker logs --since=10m technolohit-voice-bridge 2>&1 | egrep -i "v4-playback-spike|cancelled sending|playback_cancel" > /tmp/v4-playback-spike-evidence.txt
```

Classify per runbook: **immediate_stop** / **delayed_stop** / **no_stop** / **unsafe**.

### Media path recommendation (interim)

| Path | When |
|------|------|
| **A) Continue AudioSocket** | Only if spike live QA shows **immediate_stop** (bridge cancel logs + caller hears stop ≤ ~500 ms) on QA/PSTN |
| **B) ARI/ExternalMedia / new realtime media bridge** | If **no_stop**, **unsafe**, or **delayed_stop** that cannot be tuned acceptably |

**Media-path decision:** continue with AudioSocket for v4 playback cancellation. Do not move to ARI/ExternalMedia as the next work item. Full v4 barge-in acceptance remains pending interruption-context/dialogue correctness live QA.

---

## 3C. Phase 0C Interruption-Context And Dialogue Recovery Spike

Date: 2026-06-01  
Runbook: [voice_assistant_v4_phase0c_interruption_recovery_spike_runbook.md](./voice_assistant_v4_phase0c_interruption_recovery_spike_runbook.md)

### Problem (from Phase 0B repeatability QA)

Playback cancellation works (8–21 ms cancel latency, audible immediate stop), but after interruption the assistant could answer with **stale product/topic context** when the caller switched products or asked a new product question.

### Files inspected

| File | Role |
|------|------|
| `voice-bridge/src/playback-session.js` | Playback cancel session (Phase 0B) |
| `voice-bridge/src/turn-assistant.js` | Turn loop, `createAssistantResponse`, `maybeCreateProductResponse`, `playAssistantAudio` |
| `voice-bridge/src/audiosocket.js` | Inbound monitor during playback |
| `voice-bridge/src/sales-dialogue-manager.js` | Sales-stage RAG/product answers |
| `voice-bridge/src/rag-sales-answerer.js` | RAG product Q&A adapter |
| `voice-bridge/src/product-intake-policy.js` | Product alias detection |
| `voice-bridge/src/interruption-recovery.js` | **New** — interruption context + repair |

### Interruption context captured (on playback cancel)

When `VOICE_V4_INTERRUPTION_CONTEXT_SPIKE_ENABLED=true` and Phase 0B cancels playback:

| Field | Source |
|-------|--------|
| `turn_index` | Playback session |
| `assistantText` | Last assistant response text (truncated 500 chars) |
| `interruptedProductId` / `interruptedSalesStage` | Product state at cancel |
| `cancellationReason` | Playback session |
| `framesSentBeforeCancel` | Playback session |
| `cancelLatencyMs` | Playback session |
| `recordedAt` | Timestamp |
| `pendingCallerTurn` | true until next caller utterance processed |

Stored in `ctx.pendingInterruptionContext`. Logged as `[v4-interruption-spike] interruption_recorded`.

### Dialogue recovery behavior (next caller turn)

When spike flag enabled and pending interruption exists:

1. **Product switch detected** — caller mentions different product (policy aliases) → reset product state, force product-selection intent, answer new product (explanation or compact pitch).
2. **Stop/repair phrase** — e.g. `Stopp, ich meine …` → topic reset if no product detected.
3. **Active sales dialogue product switch** — bypasses `activeSalesDialogue` block that previously prevented product change mid-flow.
4. **RAG product Q&A** — `answerProductQuestionWithRag` prefers caller-detected product over stale `productState.selectedProduct` when spike enabled.

### Spike feature flag (default off, separate from Phase 0B)

```env
VOICE_V4_INTERRUPTION_CONTEXT_SPIKE_ENABLED=false
```

Requires Phase 0B cancel to occur in live calls:

```env
VOICE_V4_PLAYBACK_CANCEL_SPIKE_ENABLED=true
```

Both flags must be enabled on QA host for end-to-end interruption recovery testing. Production default: both **false**.

### Unit tests added

File: `voice-bridge/tests/interruption-recovery-spike.test.js`

- Interrupt Digitale Rezeption context → ask Smart Website → answers Smart Website, switches product
- Interrupt Smart Website → ask AI Voice Assistant → switches to voice_agent
- `Stopp, ich meine Smart Website` → product repair
- RAG/playbook uses caller product, not stale product
- Spike inactive when flag off
- Existing dialogue QA tests still pass

All **67** voice-bridge tests pass (`npm test`).

### Phase 0C decision status

| Layer | Status |
|-------|--------|
| Interruption context capture | **Implemented behind disabled flag** |
| Product/topic repair on next turn | **Implemented behind disabled flag** |
| RAG product scoping fix | **Implemented behind disabled flag** |
| Full barge-in acceptance | **Not accepted** — live QA pending |
| Phase 1 | **Not approved** |

### Remaining risks

| Risk | Note |
|------|------|
| RMS-based cancel still not production VAD | Phase 0B unchanged |
| Repair uses policy aliases, not full semantic intent | May miss unusual STT product names |
| Not a full v4 state machine | Minimal spike only; no CallSessionMemory yet |
| Live QA may reveal edge cases | e.g. mid-intake interruption, post-capture Q&A |

### Phase 0C ready for live QA?

**Yes — code and unit tests complete; live QA required before accepting interruption recovery.**

QA host env (test only):

```env
VOICE_V4_PLAYBACK_CANCEL_SPIKE_ENABLED=true
VOICE_V4_INTERRUPTION_CONTEXT_SPIKE_ENABLED=true
```

Log tail:

```bash
docker logs -f technolohit-voice-bridge 2>&1 | egrep -i "v4-playback-spike|v4-interruption-spike|interruption_product_switch|cancelled sending"
```

---

## 4. Streaming STT/TTS Provider Decision

Current production assumptions: OpenAI API key, German-first, 8 kHz PSTN PCM, existing batch models in `config.js`.

### Option A: Current OpenAI transcription + TTS upgraded incrementally

| Dimension | Assessment |
|-----------|------------|
| **Pros** | Same vendor/account; matches existing code paths; lowest migration risk; batch STT/TTS already in production config |
| **Cons** | Batch STT adds full-turn latency; no native partial transcripts in current integration; TTS waits for full text |
| **Integration complexity** | Low–medium: add chunk/stream adapters, keep `turn-assistant` replacement modular |
| **Latency** | Moderate: STT limited by turn length unless chunked; TTS can improve with sentence-level synthesis |
| **Production risk** | Low |
| **Tenant-ready impact** | Neutral; provider keys stay in `.env`, per-tenant routing later via config |
| **Privacy** | Audio sent to OpenAI; document in retention/DPA; no change from today |

**Incremental upgrade path:** local VAD endpointing → send audio chunks or use OpenAI streaming transcription API → sentence-chunk TTS with phrase cache.

### Option B: OpenAI Realtime / unified streaming voice runtime

| Dimension | Assessment |
|-----------|------------|
| **Pros** | Single session for STT+LLM+TTS; best theoretical latency; partial transcripts native |
| **Cons** | Major rewrite; sample-rate / telephony bridging complexity (8 kHz PSTN vs Realtime expectations); harder to keep deterministic lead/RAG boundaries; couples dialogue to one session |
| **Integration complexity** | High |
| **Latency** | Potentially best |
| **Production risk** | High for Phase 1 |
| **Tenant-ready impact** | Medium: session-per-call maps cleanly, but config/version pinning harder mid-session |
| **Privacy** | Continuous audio stream to OpenAI |

### Option C: External STT/TTS provider split (e.g. Deepgram + ElevenLabs / Azure)

| Dimension | Assessment |
|-----------|------------|
| **Pros** | Best-in-class streaming STT/TTS; Deepgram strong on partials and telephony |
| **Cons** | New vendors, keys, billing, DPA review; more moving parts; German accent QA needed |
| **Integration complexity** | Medium–high |
| **Latency** | Potentially excellent |
| **Production risk** | Medium (new dependencies) |
| **Tenant-ready impact** | Good if adapters are per-tenant configurable |
| **Privacy** | Split across vendors; more compliance surface |

### Option D: Local VAD + remote STT/TTS

| Dimension | Assessment |
|-----------|------------|
| **Pros** | Fast endpointing and barge-in detection without API round-trip; reduces cut-off errors |
| **Cons** | Adds CPU/memory on voice server; VAD tuning for noisy PSTN; still needs remote STT/TTS for quality German |
| **Integration complexity** | Medium |
| **Latency** | Improves endpointing and barge-in detection; STT/TTS still remote |
| **Production risk** | Low–medium |
| **Tenant-ready impact** | VAD params can live in `agent_config` |
| **Privacy** | Raw audio stays local until STT upload |

### Final recommendation

**Primary: Option A + Option D hybrid**

| Layer | Provider / approach |
|-------|---------------------|
| VAD + endpointing + barge-in detection | **Local** (Option D) — lightweight energy/VAD module on 8 kHz frames; configurable thresholds in agent config |
| STT | **OpenAI streaming/incremental** (Option A upgrade) — move from batch WAV to streaming or short-chunk transcription using existing `gpt-4o-mini-transcribe` / Realtime transcription session; confirm API capability with sysadmin |
| TTS | **OpenAI sentence-chunk TTS** (Option A) — `gpt-4o-mini-tts` per sentence with **static phrase cache** for greetings, clarifications, closings |
| LLM | Keep **chat completions** (`gpt-4o-mini`) for dialogue orchestrator; not full Realtime agent |

**Explicitly defer Option B** (full OpenAI Realtime voice agent) to a later evaluation unless streaming STT chunk path fails accented-German QA.

**Fallback:** Option C with **Deepgram streaming STT** + OpenAI TTS if OpenAI streaming STT latency or quality fails PSTN QA.

**Sysadmin confirmation needed:**

```bash
# Confirm OpenAI project has access to streaming/realtime transcription (no secrets printed)
docker exec technolohit-voice-bridge sh -lc 'test -n "$OPENAI_API_KEY" && echo openai_key_present=yes || echo openai_key_present=no'
# Product owner: confirm OpenAI usage tier / RPM limits for expected concurrent calls (see §9)
```

---

## 5. Latency Targets

Targets are for **PSTN 8 kHz**, German-first, single-region deployment. Values are Phase 1 **design targets**; validation via `voice.call_quality_events` in Phase 7.

| Metric | Target | Rationale |
|--------|--------|-----------|
| Speech start detection (VAD) | **≤150 ms** after caller energy rise | Local VAD on 20 ms frames |
| Endpointing (normal turn) | **400–800 ms** silence after speech | Blueprint; avoid cutting slow speakers |
| Endpointing (yes/no, contact route) | **300–600 ms** silence | Faster prompts |
| First partial transcript | **500–900 ms** after speech start | Provider-dependent; log if unavailable |
| Final transcript after endpoint | **300–900 ms** | Chunk/stream STT goal |
| First assistant audio (TTS) | **≤800 ms** after final transcript ready | Sentence-chunk + cache for common phrases |
| End-to-end caller stop → assistant first audio | **≤2.5 s** (normal turn) | STT + LLM + TTS budget |
| Barge-in playback stop | **≤400 ms** from VAD trigger | Requires live validation (§3) |
| RAG timeout | **700 ms** default / **1200 ms** QA (`VOICE_RAG_TIMEOUT_MS`) | Existing config; fail-closed |
| LLM timeout | **2500 ms** hard cap per turn | New infra default in `.env` |
| TTS timeout (first chunk) | **2000 ms** | Per sentence synthesis |

**Measurement method:** emit `call_quality_events` with `metric_name` + `metric_value` per turn; compare with existing `turn_transcribed` / `assistant_response_played` event timings in `persist.js`.

---

## 6. Retention Owner And Values

**Not legal approval.** Proposed technical defaults for responsible-person review.

| Data class | Proposed retention | Notes |
|------------|-------------------|-------|
| Raw audio (`.slin`/`.wav` in `VOICE_RECORDING_DIR`) | **21 days** (range 14–30) | Align with blueprint; cron cleanup job |
| Turn transcripts (`voice.call_transcripts`) | **90 days** | Extend only if linked active lead / legal hold |
| Call summaries (`voice.call_summaries`) | **90 days** (same as transcripts) | Derived data |
| Lead records (`voice.leads`) | **Until resolved + 24 months** | Operational default; anonymize phone after closure + period |
| Lead reveal audit (`voice.lead_access_audit`) | **12 months** minimum | Accountability |
| Quality events (future table) | **90 days** | Aggregates exported before purge |
| Knowledge / RAG logs | **90 days** query logs; documents indefinite until version superseded | `knowledge.retrieval_logs` |

| Responsibility | Proposed owner |
|----------------|----------------|
| Retention policy approval | **TechnoloHit managing director / DPO** (name TBD by sysadmin) |
| Backup encryption | **Sysadmin / hosting provider** — confirm PostgreSQL and recording volume encryption at rest |
| Dashboard access list review | **Operations lead** — WireGuard + Basic Auth users documented |

**Approval gate:** Production v4 rollout blocked until written sign-off on retention values (blueprint § Privacy).

---

## 7. Implementation Path Decision

### Option 1: v4 inside existing `voice-bridge` behind flags

| Factor | Assessment |
|--------|------------|
| Deployment risk | **Low** — same container, same AudioSocket port, same post-call |
| Rollback | **Fast** — flip `VOICE_RUNTIME_VERSION=v3`, redeploy previous image |
| Monolith risk | **High if mishandled** — must **not** grow `turn-assistant.js` |
| Shadow test | Possible — dual interpretation logging without controlling playback |
| Future productization | Medium — extract modules later into package boundaries |
| Tenant-ready | Good — shared DB/persist layer |
| Operational complexity | **Lowest** |

### Option 2: New `voice-runtime-v4` service

| Factor | Assessment |
|--------|------------|
| Deployment risk | **Medium–high** — new container, networking, Asterisk routing change |
| Rollback | Medium — dialplan/route switch back to v3 bridge |
| Monolith risk | **Low** — clean slate |
| Shadow test | Harder — needs traffic duplication |
| Future productization | **Best** long-term |
| Tenant-ready | Good |
| Operational complexity | Higher |

### Current decision status

**Selected for playback cancellation after Phase 0B repeatability validation.** Implement v4 media cancellation inside `voice-bridge` behind feature flags, with **strict modular boundaries**:

```text
voice-bridge/src/
  v4/
    audio-session.js
    vad-endpointing.js
    playback-controller.js
    stt-adapter.js
    tts-adapter.js
    dialogue-orchestrator.js
    call-session-memory.js
    state-machine.js
  runtime-router.js   # selects v3 vs v4 from flags
```

This remains the preferred path for non-media foundation work only if the team explicitly accepts that Phase 1 will not touch realtime playback/barge-in yet.

**Do not add v4 logic to `turn-assistant.js`.** Keep v3 path untouched for rollback.

**Escalation trigger has fired:** The AudioSocket barge-in live/manual test failed (§3, §11A) on **v3 default behavior** (spike flag off).

**Phase 0B spike (§3B):** Minimal cancellable playback is now implemented behind `VOICE_V4_PLAYBACK_CANCEL_SPIKE_ENABLED=false`. Re-test with spike enabled before choosing media path.

Before implementation starts, the team must:

1. Use AudioSocket as the selected playback-cancellation media path, and
2. Complete Phase 0C interruption recovery live QA before full barge-in acceptance.

**Agent config source of truth (Phase 1):** **Versioned JSON file** seed at `voice-bridge/config/agents/technolohit.main_voice_sales.v4.json`; DB-backed config deferred to post–Phase 1.

---

## 8. Rollback Plan

### Keep v3 production safe

1. Default all v4 flags **off** in production `.env`.
2. Deploy v4-capable images while runtime remains v3 until supervised enablement.

### Feature flags (`.env` — infrastructure only)

```env
VOICE_RUNTIME_VERSION=v3
VOICE_V4_REALTIME_ENABLED=false
VOICE_V4_BARGE_IN_ENABLED=false
VOICE_V4_STREAMING_STT_ENABLED=false
VOICE_V4_STREAMING_TTS_ENABLED=false
VOICE_TENANT_ID=technolohit
VOICE_AGENT_ID=main_voice_sales
VOICE_AGENT_CONFIG_PATH=/app/config/agents/technolohit.main_voice_sales.v4.json
```

### Deploy image rollback

```bash
cd /opt/technolohit-voice/asterisk
VOICE_BRIDGE_IMAGE=thnhit/technhvoice:voice-bridge-<previous-tag> \
  docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d voice-bridge
docker inspect technolohit-voice-bridge --format 'running_image={{.Config.Image}}'
```

Documented in `docs/release-and-cicd.md` § Rollback.

### Database migration strategy

- **Forward-only** migrations with `DEFAULT 'technolohit'` on new columns — no breaking change for v3 reads.
- v3 runtime **ignores** new columns; v4 runtime **writes** them.
- **No rollback migration** required for Phase 1; if catastrophic, v4 flags off and v3 continues (nullable/extra columns harmless).

### Disable v4 without breaking post-call / lead / dashboard

Post-call pipeline is **runtime-version agnostic** — triggered on socket close regardless of v3/v4 path (`audiosocket.js`). Disabling v4 returns turn flow to v3; summaries/leads/notifications unchanged.

### Return to v3 quickly (< 5 minutes)

1. Set `VOICE_V4_REALTIME_ENABLED=false` and `VOICE_RUNTIME_VERSION=v3`.
2. Redeploy last known-good v3 image tag if new code is suspect.
3. `docker compose up -d voice-bridge` — no Asterisk dialplan change required for flag-only rollback.

---

## 9. Concurrency And Overload Policy

### Expected normal concurrent calls (TechnoloHit)

**Assumption (no repo evidence):** **0–2** concurrent inbound calls typical for current marketing/reception volume. **Peak marketing campaign:** **3–5** (unconfirmed).

### Maximum safe concurrent calls

**Unknown until sysadmin test.** Each realtime call may hold:

- 1 TCP socket + inbound buffer
- VAD + STT stream + LLM request + TTS synthesis
- Disk I/O for recordings
- Shared OpenAI rate limits

### Recommended initial concurrency limit

| Parameter | Initial value |
|-----------|---------------|
| `VOICE_MAX_CONCURRENT_CALLS` | **3** (conservative) |
| Soft warning threshold | 2 active v4 sessions |
| Per-process OpenAI parallel STT/TTS | **2** (semaphore) |

### Overload behavior (recommended)

| Condition | Behavior |
|-----------|----------|
| At capacity | **Reject new AudioSocket sessions** with log event `call_rejected_overload`; Asterisk should route to voicemail/human fallback (dialplan change — sysadmin) |
| Provider 429 / rate limit | Exponential backoff **once**; then template fallback response; emit `provider_rate_limited` event |
| RAG timeout | Fail-closed to playbook (existing behavior) |
| LLM timeout | Short deterministic apology + contact route prompt |
| One long call (>10 min) | `VOICE_RECORDING_MAX_SECONDS=300` already caps buffer; v4 should cap turn count and STT stream duration |

### Per-call resource estimate methodology

Sysadmin benchmark script (after v4 Phase 2 prototype):

```bash
# Baseline idle
docker stats technolohit-voice-bridge --no-stream

# During N simultaneous test calls (QA route)
for i in 1 2 3; do docker stats technolohit-voice-bridge --no-stream; sleep 30; done

# Host headroom
free -h
nproc
df -h /opt/technolohit-voice
```

Record: CPU %, MEM usage / limit, load average, OpenAI 429 counts in logs.

### Backpressure strategy

- Global semaphore for outbound API calls (STT, TTS, LLM, RAG).
- Queue depth **0** for telephony (reject rather than queue — PSTN callers cannot wait).
- Priority: **active call audio path > RAG > non-critical logging**.

### Sysadmin questions

1. What CPU/RAM does the voice host have? (`free -h`, `nproc`)
2. Expected peak concurrent calls in next 12 months?
3. Fallback destination if voice-bridge rejects (voicemail extension, mobile, human)?
4. OpenAI organization RPM/TPM limits for the production key?

---

## 10. Tenant-Ready Phase 1 Foundation

### Recommended identifiers (defaults)

```text
tenant_id              = technolohit
agent_id               = main_voice_sales
agent_config_version   = technolohit-main-v4-YYYYMMDD
prompt_playbook_version = technolohit-sales-v4-YYYYMMDD
knowledge_version      = technolohit-knowledge-vYYYYMMDD
runtime_version        = voice-runtime-v4.x.x
```

### agent_config source of truth

- **Phase 1:** versioned JSON file mounted in container (`VOICE_AGENT_CONFIG_PATH`).
- **Phase 2+:** optional DB table `voice.agent_configs` (not Phase 1).

### Tenant/agent scoped RAG

- Extend `RetrieveRequest` / retrieval SQL with optional `agent_id` filter in document metadata.
- voice-bridge RAG client passes `tenant_id` + `agent_id` on every request.

### Proposed migrations (filenames only — do not apply yet)

| File | Changes |
|------|---------|
| `db/voice/migrations/006_v4_tenant_agent_session_fields.sql` | Add `tenant_id`, `agent_id`, `agent_config_version`, `prompt_playbook_version`, `knowledge_version`, `runtime_version` to `voice.call_sessions` |
| `db/voice/migrations/007_v4_tenant_agent_transcripts_events.sql` | Same identifiers on `voice.call_transcripts`, `voice.call_events`, `voice.call_summaries` |
| `db/voice/migrations/008_v4_leads_custom_fields.sql` | Add `tenant_id`, `agent_id`, `custom_fields JSONB` to `voice.leads`; indexes `(tenant_id, agent_id, status, created_at DESC)` |
| `db/voice/migrations/009_v4_call_quality_events.sql` | Create `voice.call_quality_events` per blueprint |
| `db/knowledge/migrations/003_knowledge_agent_scope.sql` | Optional `agent_id` on documents metadata index; ingestion script update |

### Affected tables summary

- `voice.call_sessions`, `voice.call_transcripts`, `voice.call_events`, `voice.call_summaries`, `voice.leads`, `voice.lead_access_audit` (read scoping), new `voice.call_quality_events`
- `knowledge.documents`, `knowledge.chunks`, `knowledge.embeddings`, `knowledge.retrieval_logs`

### Usage/quality events (minimal schema)

Per blueprint: `event_type`, `event_stage`, `metric_name`, `metric_value`, `payload JSONB`, scoped by `tenant_id`, `agent_id`, `call_session_id`.

---

## 11. Sysadmin Required Inputs

Copy-paste commands (**no secrets**). Run on production or staging host.

### AudioSocket / ARI / ExternalMedia capability

```bash
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}'
docker exec technolohit-asterisk asterisk -rx "core show applications" | egrep -i "AudioSocket|ExternalMedia|ARI|Stasis"
docker exec technolohit-asterisk asterisk -rx "module show like audiosocket"
docker exec technolohit-asterisk asterisk -rx "module show like res_audiosocket"
docker exec technolohit-asterisk asterisk -rx "module show like ari"
docker exec technolohit-asterisk asterisk -rx "module show like external"
```

### Server CPU/RAM headroom

```bash
free -h
nproc
uptime
docker stats --no-stream technolohit-voice-bridge technolohit-asterisk technolohit-rag-api 2>/dev/null || docker stats --no-stream
df -h /opt/technolohit-voice
```

### Concurrent call expectations

**Questions:**

1. Average and peak inbound calls per hour/day?
2. Longest typical call duration?
3. Acceptable busy signal behavior?

### Provider/API constraints

```bash
docker exec technolohit-voice-bridge sh -lc 'test -n "$OPENAI_API_KEY" && echo openai_configured=yes || echo openai_configured=no'
docker exec technolohit-voice-bridge sh -lc 'wget -qO- http://technolohit-rag-api:8080/healthz 2>/dev/null || echo rag_api_unreachable'
docker exec technolohit-voice-bridge sh -lc 'wget -qO- http://127.0.0.1:8080/healthz 2>/dev/null || echo host_local_rag_api_unreachable'
```

**Expected current RAG URL:** Because `technolohit-voice-bridge` runs on Docker host network and `technolohit-rag-api` is on `asterisk_default`, Docker DNS `http://technolohit-rag-api:8080` is not expected to work from voice-bridge. Use `http://127.0.0.1:8080` from voice-bridge unless networking is changed.

**Questions:** OpenAI tier RPM/TPM; approved vendors if Deepgram fallback needed; data processing agreement status.

### Retention owner confirmation

**Questions:** Who approves §6 retention values? Is phone recording disclosure current for v4 streaming retention?

### Backup encryption confirmation

```bash
# PostgreSQL — adjust container name if different
docker ps --format '{{.Names}}' | grep -i postgres
# Confirm with host provider: volume encryption at rest for Postgres data dir and recording mount
ls -la /opt/technolohit-voice/voice-bridge/recordings 2>/dev/null | head -5
```

### QA phone route availability

**Questions:** Dedicated QA DID? Internal extension? Can dialplan branch to v4 flag without affecting main DID?

### Docker/network constraints

```bash
docker network ls
docker inspect technolohit-voice-bridge --format '{{json .NetworkSettings.Networks}}' | python3 -m json.tool 2>/dev/null || true
docker inspect technolohit-voice-bridge --format 'running_image={{.Config.Image}}'
docker logs --tail=50 technolohit-voice-bridge 2>&1 | tail -20
```

---

## 11A. Partial Sysadmin Validation Results

Date: 2026-06-01

### AudioSocket availability

**Result: PASS for availability only.**

- Asterisk has `app_audiosocket.so`, `chan_audiosocket.so`, and `res_audiosocket.so` loaded and running.
- The AudioSocket application is visible in `core show applications`.
- This confirms that the current AudioSocket path exists.
- This does **not** prove reliable barge-in support.

### ARI / ExternalMedia fallback

**Result: BLOCKED / not currently available.**

- ARI is not loaded: `module show like ari` returns `0 modules loaded`.
- External check only shows `app_externalivr.so`.
- No clear ARI/ExternalMedia realtime fallback path is currently confirmed.
- If AudioSocket playback cancellation cannot be made reliable, sysadmin must validate/setup ARI, ExternalMedia, or a new realtime media bridge path.

### Server capacity

**Result: PASS for initial v4 testing.**

- Server has 12 CPU cores, 23 GiB RAM, about 20 GiB available, low load average, and 678 GiB disk free.
- Current voice/RAG/Asterisk containers use very low CPU/RAM.
- Keep the initial recommendation: 3 concurrent calls normal target, 5 calls stretch target only after real load tests.

### OpenAI / RAG readiness

**Result: PASS with host-local RAG URL.**

- OpenAI is configured in voice-bridge without exposing secrets.
- RAG API is running and healthy on the host.
- `http://127.0.0.1:8080/healthz` returns `{"ok":true,"service":"technolohit-rag-api","environment":"development"}` from the host.
- `http://127.0.0.1:8080/healthz` also works from inside `technolohit-voice-bridge`.
- `http://technolohit-rag-api:8080/healthz` does not work because voice-bridge runs on Docker host network while RAG API is on `asterisk_default`.
- RAG readiness is no longer a Phase 0 blocker, but v4 config/docs must use the correct base URL: `VOICE_RAG_API_URL=http://127.0.0.1:8080`.

### Barge-in feasibility

**Result: FAIL with current live/manual behavior.**

- Test result: no stop.
- Caller interrupted while assistant was speaking, but assistant playback continued.
- Current AudioSocket/v3 playback behavior is not acceptable for v4 barge-in as-is.
- Do not proceed under the assumption that upgraded current AudioSocket is enough.

Decision impact:

1. Prove AudioSocket playback cancellation can be implemented reliably, or
2. Move toward a new realtime media bridge / ARI / ExternalMedia path.

### Remaining operational blockers

- QA route confirmation is missing.
- Overload fallback behavior is missing.
- Encryption at rest confirmation is missing.
- Retention owner/sign-off is missing.
- Expected/max concurrent call target still needs operational confirmation.

---

## 12. Phase 0 Recommendation

### Go / no-go for Phase 1 implementation

| Decision | Detail |
|----------|--------|
| **No-go for now** | Phase 1 implementation is paused until the blocking Phase 0 validation items below are resolved |
| **Conditional go later** | Phase 1 foundation can start after team acceptance, media/runtime path decision, and operational/security blockers are recorded |
| **No-go until resolved** | Phase 2-3 realtime audio/barge-in, production v4 enablement, retention sign-off, concurrency benchmark |

### Preferred architecture path

**Media path selected for playback cancellation.** Keep v3 `turn-assistant.js` frozen and keep post-call/persistence shared. The selected next path is AudioSocket playback cancellation inside voice-bridge. ARI/ExternalMedia remains a fallback only if future QA shows AudioSocket cancellation is unsafe or unreliable.

### Remaining blockers

1. Phase 0C interruption recovery **live QA pending** — unit tests pass; PSTN validation required.
2. Full v4 barge-in behavior is **not accepted yet** until interruption recovery live QA passes.
3. ARI/ExternalMedia fallback is **not needed as the next work item**, but remains an architectural fallback if future AudioSocket tests regress.
4. Retention **owner sign-off** (§6)
5. **Concurrent call capacity** operational confirmation (§9)
6. **QA phone route** confirmation (§11)
7. OpenAI **streaming STT** API/limit confirmation (§4)
8. Backup encryption confirmation (§11)

### Exact next step

1. **Do not start Phase 1 implementation yet.**
2. **Run Phase 0C live QA** per [Phase 0C runbook](./voice_assistant_v4_phase0c_interruption_recovery_spike_runbook.md) with both spike flags enabled on QA host.
3. **Keep AudioSocket as the selected media path** for playback cancellation; keep spikes disabled by default outside supervised QA.
4. **Do not pursue ARI/ExternalMedia as the next task** unless AudioSocket cancellation regresses or becomes unsafe.
5. **Document RAG config:** use `VOICE_RAG_API_URL=http://127.0.0.1:8080` from voice-bridge unless container networking changes.
6. **Assign retention/privacy owner** and confirm backup encryption.
7. After blockers are resolved, update this report to `Accepted for Phase 1 foundation`.

---

## 13. Checklist

Phase 0 documentation (this report):

- [x] Successful: Phase 0 decision report created (`voice_assistant_v4_phase0_decision_report.md`)
- [x] Successful: Existing architecture evidence documented with file references
- [x] Successful: AudioSocket barge-in feasibility documented (code analysis + live test requirements)
- [x] Successful: Streaming STT/TTS provider decision documented (Option A+D hybrid recommended)
- [x] Successful: Latency targets documented
- [x] Successful: Retention owner and proposed values documented (approval pending)
- [x] Successful: Media path selected for playback cancellation (AudioSocket, conditional)
- [x] Successful: Rollback plan documented
- [x] Successful: Concurrency and overload policy documented (limits pending sysadmin data)
- [x] Successful: Tenant-ready Phase 1 foundation documented (migration filenames proposed)
- [x] Successful: Sysadmin required inputs listed with commands

- [x] Successful: Phase 0B playback cancel spike implemented (flag off by default)
- [x] Successful: Phase 0B unit tests added and passing
- [x] Successful: Phase 0B manual QA runbook added
- [x] Successful: Phase 0B first spike live QA completed (`immediate_stop`)
- [x] Successful: Phase 0B repeatability QA completed
- [x] Successful: Media path selected after repeatability QA
- [ ] Successful: Interruption-context/dialogue handling task completed

- [x] Successful: Phase 0C interruption-context spike implemented (flag off by default)
- [x] Successful: Phase 0C unit tests added and passing
- [x] Successful: Phase 0C manual QA runbook added
- [ ] Successful: Phase 0C interruption recovery live QA completed
- [ ] Successful: Full barge-in behavior accepted

Pending acceptance / validation (leave unchecked):

- [ ] Successful: Phase 0 decision report **accepted** by team
- [x] Successful: AudioSocket barge-in feasibility **live-tested** (failed current behavior)
- [ ] Successful: Retention policy **approved** by responsible person
- [ ] Successful: Backup encryption **confirmed**
- [x] Successful: Server CPU/RAM headroom **confirmed** for initial v4 testing
- [ ] Successful: Expected/max concurrent calls **confirmed**
- [ ] Successful: QA phone route **confirmed**
- [ ] Successful: OpenAI streaming STT limits **confirmed**
- [ ] Successful: Open decisions resolved → **implementation approved**

---

## Appendix: Open Decisions Resolved In Phase 0

| # | Question | Phase 0 answer |
|---|----------|----------------|
| 1 | AudioSocket barge-in? | **Media cancellation feasible** — v3 default failed, but Phase 0B repeatability QA passed; full dialogue recovery still pending |
| 2 | STT/TTS provider? | **OpenAI incremental + local VAD**; Deepgram fallback |
| 3 | Latency targets? | §5 |
| 4 | Retention? | §6 proposed defaults — approval pending |
| 5 | voice-bridge vs new service? | **AudioSocket selected for playback cancellation**; no ARI/ExternalMedia next unless future QA regresses |
| 6 | Agent config source? | **File seed Phase 1**; DB later |
| 7 | QA phone route? | **Required** — sysadmin to confirm |
| 8 | Max concurrent calls? | **Initial limit 3** — server headroom OK, operational confirmation still pending |
| 9 | RAG readiness? | **Ready via host-local URL** — use `http://127.0.0.1:8080` from voice-bridge; Docker DNS name is not valid in current network mode |
