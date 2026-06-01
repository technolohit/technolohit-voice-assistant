# TechnoloHit Voice Assistant v4 — Phase 0 Decision Report

Date: 2026-06-01  
Status: **Draft for acceptance** (documentation complete; live/sysadmin validations pending)  
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
| RAG API with tenant scoping | Partial | `tenant_id` in RAG; no `agent_id` yet |
| Real-time STT/TTS/barge-in | **No** | Turn-based only; no playback cancel |
| Tenant-ready voice schema | **No** | Migrations not written yet |
| Agent config model | **No** | Business logic still in `turn-assistant.js` (~4,332 lines) |
| Barge-in feasibility | **Unknown** | Code gap + live test required |
| Concurrency capacity | **Unknown** | No server benchmarks in repo |

**Verdict:** Repository is ready for **Phase 1 foundation work** (schema, config, modular runtime skeleton) **after** acceptance of this report. **Phase 2–3 realtime audio and barge-in** should proceed only after sysadmin confirms AudioSocket playback-stop behavior (§3, §11).

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

| Status | **Unknown — pending sysadmin/live test** |
|--------|------------------------------------------|

**Code analysis:** Architecture is **plausibly extensible** (inbound frames already received during playback; outbound is bridge-controlled), but **barge-in is not implemented** and **Asterisk buffer behavior is unproven**.

**Conditional path (aligned with blueprint):**

- **Prototype barge-in on current AudioSocket first** (recommended).
- If live test shows **>500 ms stop latency** or **unreliable stop**, escalate to **ARI/ExternalMedia realtime media bridge** (separate worker or service) rather than patching v3 indefinitely.

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

### Recommendation

**Implement v4 inside `voice-bridge` behind feature flags**, with **strict modular boundaries**:

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

**Do not add v4 logic to `turn-assistant.js`.** Keep v3 path untouched for rollback.

**Escalation trigger:** If AudioSocket barge-in live test fails (§3), introduce a **separate realtime media worker** (Option 2 partial) for media only; voice-bridge retains persistence/post-call.

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
```

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

## 12. Phase 0 Recommendation

### Go / no-go for Phase 1 implementation

| Decision | Detail |
|----------|--------|
| **Go** | Phase 1 **foundation** (schema, agent config, runtime router skeleton, quality events schema, RAG agent scope) |
| **Conditional go** | Phase 2–3 realtime audio + barge-in after sysadmin AudioSocket stop test |
| **No-go until resolved** | Production v4 enablement, retention sign-off, concurrency benchmark |

### Preferred architecture path

**v4 inside `voice-bridge` behind flags**, modular `src/v4/*`, v3 `turn-assistant.js` frozen, post-call pipeline shared.

### Remaining blockers

1. AudioSocket barge-in **live validation** (§3)
2. Retention **owner sign-off** (§6)
3. **Concurrent call capacity** benchmark (§9)
4. **QA phone route** confirmation (§11)
5. OpenAI **streaming STT** API/limit confirmation (§4)

### Exact next step

1. **Team accepts this Phase 0 report.**
2. **Sysadmin completes §11 checklist** and records results in a short addendum (or ticket).
3. **Begin Phase 1** per blueprint: migrations 006–009 (when approved), agent config JSON seed, runtime router stub — **no realtime audio yet**.

---

## 13. Checklist

Phase 0 documentation (this report):

- [x] Successful: Phase 0 decision report created (`voice_assistant_v4_phase0_decision_report.md`)
- [x] Successful: Existing architecture evidence documented with file references
- [x] Successful: AudioSocket barge-in feasibility documented (code analysis + live test requirements)
- [x] Successful: Streaming STT/TTS provider decision documented (Option A+D hybrid recommended)
- [x] Successful: Latency targets documented
- [x] Successful: Retention owner and proposed values documented (approval pending)
- [x] Successful: Implementation path selected (v4 in voice-bridge behind flags, modular)
- [x] Successful: Rollback plan documented
- [x] Successful: Concurrency and overload policy documented (limits pending sysadmin data)
- [x] Successful: Tenant-ready Phase 1 foundation documented (migration filenames proposed)
- [x] Successful: Sysadmin required inputs listed with commands

Pending acceptance / validation (leave unchecked):

- [ ] Successful: Phase 0 decision report **accepted** by team
- [ ] Successful: AudioSocket barge-in feasibility **live-tested**
- [ ] Successful: Retention policy **approved** by responsible person
- [ ] Successful: Backup encryption **confirmed**
- [ ] Successful: Server CPU/RAM headroom **confirmed**
- [ ] Successful: Expected/max concurrent calls **confirmed**
- [ ] Successful: QA phone route **confirmed**
- [ ] Successful: OpenAI streaming STT limits **confirmed**
- [ ] Successful: Open decisions resolved → **implementation approved**

---

## Appendix: Open Decisions Resolved In Phase 0

| # | Question | Phase 0 answer |
|---|----------|----------------|
| 1 | AudioSocket barge-in? | **Unknown** — prototype on AudioSocket; live test required |
| 2 | STT/TTS provider? | **OpenAI incremental + local VAD**; Deepgram fallback |
| 3 | Latency targets? | §5 |
| 4 | Retention? | §6 proposed defaults — approval pending |
| 5 | voice-bridge vs new service? | **voice-bridge behind flags** |
| 6 | Agent config source? | **File seed Phase 1**; DB later |
| 7 | QA phone route? | **Required** — sysadmin to confirm |
| 8 | Max concurrent calls? | **Initial limit 3** — benchmark pending |
