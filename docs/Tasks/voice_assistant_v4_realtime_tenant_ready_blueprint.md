# TechnoloHit Voice Assistant v4 Realtime Tenant-Ready Blueprint

Date: 2026-06-01

## Purpose

Design v4 of the TechnoloHit Voice Assistant as a production-grade, real-time voice agent.

v4 is not another patch cycle for the current turn-based assistant. It is a deliberate architecture step toward a professional voice AI system that can eventually become a product.

Primary target:

```text
Build one excellent production voice agent for TechnoloHit first,
but design the core runtime so customer #2 can be added later without rewriting the system.
```

Productization decision:

```text
TechnoloHit-first production system, tenant-ready by design.
```

Phase 1 must not build a full SaaS platform. It must build a high-quality TechnoloHit production agent with the right foundations for later managed multi-customer rollout.

- [x] Successful: Team accepts v4 as a real-time runtime architecture project, not another v3 hotfix.
- [x] Successful: Team accepts TechnoloHit-first, tenant-ready-by-design direction.
- [ ] Successful: Cursor reads this blueprint before implementation.
- [x] Successful: Phase 0 decision document is completed before implementation.
- [x] Successful: No implementation starts before Phase 0 decisions are confirmed.

## Current Project Status

Last updated: 2026-06-01

| Item | Status |
|------|--------|
| **Current completed phase** | **Phase 10E — Live TTS/playback plumbing** |
| **Current production runtime** | **v3** (`VOICE_RUNTIME_VERSION=v3`) on `voice-bridge-v1.11.0` |
| **v4 production status** | **Not enabled** — gated canary has mock-safe TTS/playback plumbing; real intelligible live-call TTS still requires Phase 10E2; **production v4 not approved** |
| **Phase 9 dry run** | **Passed** (2026-06-01) |
| **Next step** | **Phase 10E2 — Real provider-backed TTS for intelligible live-call answers** |

Completed foundation work (do not re-implement):

- Phase 0 / 0B / 0C accepted for foundation planning (AudioSocket playback cancel + interruption recovery QA)
- Phase 1 tenant-ready data/config foundation (tagged `v1.4.0`)
- Phase 2 runtime foundation: `CallSessionMemory`, state machine, runtime router/context, quality event builders, lead validator, RAG scope guardrails, agent config helpers (tagged `v1.5.0`)
- Phase 3 media foundation: audio session, VAD/endpointing, STT/TTS adapter interfaces, TTS phrase cache, canary-safe AudioSocket routing skeleton, media quality event builders (tagged `v1.6.0`)
- Phase 4 barge-in foundation: playback controller, barge-in detector, interruption context, canary barge-in harness (tagged `v1.7.0`)
- Phase 5 dialogue orchestrator: turn lifecycle, response planner, canary runtime loop, quality event sink (canary/test-harness only)
- Phase 6 RAG product/sales Q&A: v4 RAG orchestrator, state-gated retrieval, fail-closed fallbacks, canary harness tests (canary/test-harness only)
- Phase 7 lead/post-call/privacy: lead candidate object, post-call metadata bridge, privacy sanitize, notification idempotency (canary/test-harness only)
- Phase 8 observability/quality analytics: persistence flush, per-call summary rollups, SQL runbook (canary/test-harness only)
- Phase 9 rollout preparation: sysadmin runbook, v1.11.0 deploy procedure, acceptance checklist (**dry run passed**; production v4 still disabled)
- Phase 9b supervised canary: blueprint + sysadmin canary runbook (validation plan only; **not executed**)
- Phase 10 live AudioSocket wiring: Phase 10A–10C implemented (route, VAD, STT on endpoint); **live PSTN does not answer turns yet**

Production rollout blockers (tracked; **do not block app implementation**):

- Final retention approval — Mojtaba, Founder of TechnoloHit
- Backup/encryption confirmation
- Dedicated QA route
- Overload fallback destination
- OpenAI streaming/realtime limits

Phase numbering in this blueprint:

```text
Phase 0  — Architecture And Runtime Feasibility
Phase 1  — Tenant-Ready Data And Config Foundation
Phase 2  — Runtime Foundation / Application Layer          [completed]
Phase 3  — Realtime Audio Foundation / Media Layer         [completed]
Phase 4  — Barge-In And Interruption Runtime Implementation [completed]
Phase 5  — Live Dialogue Orchestrator Integration         [completed]
Phase 6  — RAG Product/Sales Q&A Integration              [completed]
Phase 7  — Lead Policy, Post-Call Reliability, And Privacy [completed]
Phase 8  — Observability And Quality Analytics            [completed]
Phase 9  — Production Rollout Preparation                 [completed — dry run passed]
Phase 9b — Supervised Canary Validation                 [completed — docs/runbook; execution blocked]
Phase 10 — Live AudioSocket → v4 Canary Wiring          [in progress — 10A–10C complete]
Phase 9c — Supervised production v4 enablement          [blocked — see blockers]
```

## Current System Baseline

The repository already contains valuable production foundations. These should be kept and evolved, not thrown away.

Keep:

- Asterisk call handling
- AudioSocket integration
- `voice-bridge` call lifecycle and persistence foundation
- PostgreSQL voice schema
- RAG API and knowledge tables
- post-call transcript, summary, lead, and notification pipeline
- n8n Telegram/email notification without full phone numbers
- Lead Dashboard with WireGuard-only access, Basic Auth, phone masking, reveal audit, and status tracking
- Docker build/publish/deploy workflows
- dialogue QA harness and live-call evidence workflow

Current v3 limitations:

- The assistant is still mostly turn-based:
  `listen -> write audio -> STT -> response text -> full TTS -> playback`.
- There is no true streaming STT with partial transcripts.
- There is no streaming LLM response path.
- There is no streaming TTS path.
- There is no reliable barge-in/interruption handling.
- Endpointing is RMS/silence-based and useful, but not production-grade VAD.
- Session memory exists, but is spread across `intake`, `product`, `history`, and metadata rather than a clean domain memory model.
- RAG exists, but it is not yet the primary product/sales answer layer.
- `turn-assistant.js` still carries too many responsibilities.
- Tenant/product configuration is still partly hardcoded.

- [ ] Successful: Existing useful production assets are listed.
- [ ] Successful: Current runtime limitations are accepted.
- [ ] Successful: Team agrees not to delete stable persistence/dashboard/notification work.

## Non-Goals For Phase 1

Do not build:

- billing system
- public signup
- customer self-service UI
- white-label builder
- enterprise installer
- Kubernetes or Helm requirement
- full multi-tenant SaaS control plane
- customer-facing agent builder
- multi-region deployment platform

Do not let LLM/RAG directly:

- create callback-ready leads
- validate phone numbers
- grant contact permission
- bypass DSGVO/GDPR rules
- expose full phone numbers in notifications
- choose cross-tenant knowledge
- invent prices, guarantees, legal claims, implementation timelines, or contract terms

- [ ] Successful: Phase 1 non-goals accepted.
- [ ] Successful: LLM/RAG safety boundaries accepted.

## Phase 1 Goals

Phase 1 focuses on TechnoloHit production quality.

Must improve:

- streaming STT or equivalent low-latency incremental transcription
- fast endpointing
- streaming or low-latency TTS
- barge-in validation and interruption handling
- structured customer memory
- deterministic state machine
- rule/validator-based lead creation
- RAG only for product/sales Q&A
- post-call pipeline reliability
- usage and quality events

Must introduce tenant-ready foundations:

- `tenant_id`
- `agent_id`
- `agent_config_version`
- `prompt_playbook_version`
- `knowledge_version`
- `runtime_version`
- tenant/agent-scoped RAG
- config-driven agent behavior
- generic lead schema with `custom_fields JSONB`
- usage/quality events per call

- [ ] Successful: Phase 1 functional goals accepted.
- [ ] Successful: Phase 1 tenant-ready foundations accepted.

## Configuration Rule

Hard rule:

```text
.env is only for infrastructure and secrets.
agent_config is for business behavior and assistant behavior.
```

Examples for `.env`:

- database URLs/passwords
- OpenAI/API keys
- Docker image tags
- host/port bindings
- feature flags
- infrastructure timeouts
- recording directories
- provider endpoints

Examples for `agent_config`:

- company name
- assistant name
- default language
- opening message
- privacy greeting wording
- products
- sales playbooks
- business hours
- callback rules
- handoff numbers/email
- forbidden claims
- lead fields
- pronunciation hints
- voice style
- escalation rules

- [ ] Successful: `.env` vs `agent_config` boundary accepted.
- [ ] Successful: No new business wording is added directly to runtime code unless it is generic fallback text.

## Recommended v4 Architecture

Target architecture:

```text
Asterisk
  -> Audio/Media Adapter
  -> Realtime Audio Session
  -> VAD + Endpointing + Barge-in Controller
  -> Streaming STT
  -> CallSessionMemory + Deterministic State Machine
  -> RAG Product/Sales Answerer
  -> Lead Policy Validators
  -> Streaming/Low-latency TTS
  -> Playback Controller
  -> PostgreSQL Events/Transcripts/Summary/Lead
  -> Notification + Dashboard
```

Separation of responsibilities:

| Component | Responsibility |
|---|---|
| Asterisk | SIP, call routing, AudioSocket/ExternalMedia path |
| Media adapter | audio frames in/out, playback stop, buffering |
| VAD/endpointing | speech start/end detection, silence decisions |
| STT adapter | streaming/partial/final transcripts |
| Dialogue orchestrator | state transitions and turn policy |
| Memory store | structured in-call facts |
| RAG answerer | scoped product/company answers only |
| Lead policy | deterministic validation and DB write readiness |
| TTS adapter | low-latency speech generation |
| Event logger | usage, quality, errors, timings |
| Post-call pipeline | final summary, lead extraction, notification |

- [ ] Successful: v4 component boundaries accepted.
- [ ] Successful: `turn-assistant.js` is not expanded further as a monolith.

## Realtime Runtime Strategy

Phase 0 must validate the safest runtime path before coding the full v4 runtime.

Candidate A: Keep Asterisk + AudioSocket, upgrade `voice-bridge`.

Pros:

- keeps existing telephony stack
- less deployment risk
- reuses current persistence and post-call pipeline
- can be introduced behind flags

Risks:

- AudioSocket may not give perfect playback interruption semantics
- barge-in may require careful buffering and playback cancellation
- streaming STT/TTS integration may still be custom

Candidate B: Keep Asterisk, introduce a new realtime media bridge/runtime.

Examples:

- Asterisk ARI / ExternalMedia style media path
- dedicated realtime voice worker
- WebSocket bridge to realtime STT/LLM/TTS provider

Pros:

- cleaner realtime design
- better barge-in and streaming control
- easier future productization

Risks:

- more infrastructure work
- bigger deployment change
- requires deeper telephony validation

Recommended Phase 0 decision:

```text
Keep Asterisk.
Prototype barge-in and streaming with the current AudioSocket path first.
If interruption/playback stop cannot be made reliable, introduce a v4 realtime media bridge rather than patching v3 forever.
```

- [x] Successful: AudioSocket playback-cancel feasibility repeatability QA passed; Phase 0C interruption recovery live QA passed sufficiently to continue.
- [x] Successful: Decision recorded: upgraded `voice-bridge` vs new realtime media bridge.
- [x] Successful: Rollback path documented before production rollout.

## Realtime Voice Requirements

### Streaming STT

Target behavior:

- receive audio frames continuously
- detect speech start quickly
- produce partial transcript while caller is speaking
- produce final transcript after endpointing
- tolerate accented/non-native German
- support German-first, with English/fallback language detection later

Acceptance targets:

- first partial transcript visible within 500-900 ms after speech begins, where provider supports it
- final transcript available within 300-900 ms after endpoint
- language default is German
- no transcript preview logging unless QA flag explicitly enables it

- [ ] Successful: STT provider/adapter selected.
- [ ] Successful: Partial/final transcript model implemented.
- [ ] Successful: Accented German QA set created.

### Fast Endpointing

Target behavior:

- avoid cutting off slow/non-native speakers too aggressively
- avoid long silence after caller finishes
- use VAD rather than only simple RMS where possible

Initial target:

```text
end_of_speech after 400-800 ms of silence in normal turns
end_of_speech after 300-600 ms in yes/no/contact-route turns
```

- [ ] Successful: VAD/endpointing thresholds are configurable.
- [ ] Successful: Endpointing metrics are logged per turn.
- [ ] Successful: Slow-speaker and noisy-line QA scenarios pass.

### Streaming Or Low-Latency TTS

Target behavior:

- begin playback before full long response is generated where possible
- keep responses short by policy
- support pre-generated phrases for common prompts
- cache deterministic phrases

Phase 1 acceptable path:

- streaming TTS if provider/runtime supports it safely
- otherwise sentence-level low-latency TTS chunks with cache

- [ ] Successful: TTS adapter supports cache for static prompts.
- [ ] Successful: Common prompts do not call TTS every time.
- [ ] Successful: First audio latency measured.

### Barge-In / Interruption Handling

Required behavior:

```text
TTS is playing
  -> caller starts speaking
  -> VAD detects speech
  -> playback stops
  -> caller audio is captured
  -> STT receives interruption audio
  -> dialogue orchestrator receives interruption context
```

Interruption context should include:

- interrupted assistant text
- interrupted stage
- playback position if available
- caller partial/final transcript
- whether assistant was asking a question

Acceptance:

- caller can interrupt a long explanation
- playback stops quickly
- assistant does not continue talking over caller
- next answer acknowledges the caller's new intent, not the old prompt

- [ ] Successful: Playback stop/cancel mechanism implemented or proven impossible with current AudioSocket.
- [ ] Successful: Interruption events are stored in usage/quality events.
- [ ] Successful: Barge-in live-call QA passes.

## Structured CallSessionMemory

Create a single structured in-call memory model. It may be in-memory during the call and persisted through events/transcripts/summaries.

Recommended shape:

```json
{
  "tenant_id": "technolohit",
  "agent_id": "main_voice_sales",
  "call_session_id": "...",
  "caller": {
    "name": "",
    "company": "",
    "phone_present": false,
    "phone_source": "caller_id|voice|none"
  },
  "business_context": {
    "customer_type": "own_company|customer_project|existing_customer|unknown",
    "product_interest": "voice_agent|smart_website|aiseoq|botinteg|lokalki|unknown",
    "need": "",
    "current_problem": "",
    "desired_outcome": "",
    "urgency": ""
  },
  "contact": {
    "preferred_channel": "phone|email|unknown",
    "permission": "granted|denied|unknown",
    "callback_requested": false,
    "email_directed": false
  },
  "lead": {
    "lead_ready": false,
    "lead_reason": "",
    "custom_fields": {}
  },
  "conversation": {
    "stage": "",
    "last_question": "",
    "last_answered_question": "",
    "repair_count": 0,
    "turn_count": 0
  }
}
```

Rules:

- Memory updates must be explicit and auditable.
- LLM/RAG may suggest memory updates, but validators decide whether to accept them.
- Lead readiness is computed, not guessed by the LLM.
- Phone and permission must remain deterministic.

- [ ] Successful: `CallSessionMemory` model designed.
- [ ] Successful: Memory update rules documented.
- [ ] Successful: Memory snapshots can be persisted without leaking secrets.

## Deterministic State Machine

v4 should use a clear state machine with explicit transitions.

Recommended top-level states:

```text
opening
intent_discovery
product_value_answer
customer_context
need_discovery
qualification
contact_route
contact_capture
post_capture_q_and_a
closing
completed
manual_review
```

Hard rules:

- The assistant asks one useful question at a time.
- After contact capture or email direction, later product questions are answer-only unless caller explicitly requests a new lead path.
- Product Q&A must not restart customer-type intake unless the caller clearly starts a new inquiry.
- Lead creation is only possible through validated state transitions.
- Barge-in can interrupt any assistant output and re-enter the state machine with interruption context.

- [ ] Successful: v4 state machine diagram/document added.
- [ ] Successful: State transition tests cover normal, interrupted, and repair paths.
- [ ] Successful: Product Q&A after contact capture does not restart intake.

## Tenant-Ready Data Model

Add tenant-ready fields to core domain records.

Recommended identifiers:

```text
tenant_id = technolohit
agent_id = main_voice_sales
agent_config_version = technolohit-main-v4-YYYYMMDD
prompt_playbook_version = technolohit-sales-v4-YYYYMMDD
knowledge_version = technolohit-knowledge-vYYYYMMDD
runtime_version = voice-runtime-v4.x.x
```

Tables to update or verify:

- `voice.call_sessions`
- `voice.call_transcripts`
- `voice.call_summaries`
- `voice.call_events`
- `voice.leads`
- `voice.lead_access_audit`
- `voice.lead_followup_status`
- knowledge documents/chunks/tables
- new usage/quality events table

Recommended migration direction:

```sql
ALTER TABLE voice.call_sessions
  ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'technolohit',
  ADD COLUMN IF NOT EXISTS agent_id TEXT NOT NULL DEFAULT 'main_voice_sales',
  ADD COLUMN IF NOT EXISTS agent_config_version TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS runtime_version TEXT NOT NULL DEFAULT '';
```

Repeat equivalent fields where useful on transcripts, summaries, events, leads, audit, and usage events.

Recommended lead extension:

```sql
ALTER TABLE voice.leads
  ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'technolohit',
  ADD COLUMN IF NOT EXISTS agent_id TEXT NOT NULL DEFAULT 'main_voice_sales',
  ADD COLUMN IF NOT EXISTS custom_fields JSONB NOT NULL DEFAULT '{}'::jsonb;
```

Indexing:

- `(tenant_id, agent_id, started_at DESC)` on call sessions
- `(tenant_id, agent_id, call_session_id)` on transcripts/events/summaries
- `(tenant_id, agent_id, status, created_at DESC)` on leads
- tenant/agent scoped indexes on knowledge tables

- [ ] Successful: Existing schema inspected before migration.
- [ ] Successful: Tenant-ready migration designed.
- [ ] Successful: Default `technolohit` tenant applied without breaking existing data.
- [ ] Successful: Queries updated to include tenant/agent filters.

## Agent Configuration Model

Introduce versioned agent configuration. Phase 1 may load from versioned files or DB, but the domain model must be ready for DB-backed configs.

Recommended file seed:

```text
voice-bridge/config/agents/technolohit.main_voice_sales.v4.json
```

Recommended config sections:

```json
{
  "tenant_id": "technolohit",
  "agent_id": "main_voice_sales",
  "agent_config_version": "technolohit-main-v4-20260601",
  "company": {
    "name": "TechnoloHit",
    "website": "www.technolohit.com",
    "contact_email": "info@technolohit.com",
    "business_hours": {}
  },
  "assistant": {
    "name": "TechnoloHit Voice Assistant",
    "language": "de",
    "voice": "marin",
    "tone": "warm, concise, professional"
  },
  "privacy": {
    "recording_notice_mode": "auto",
    "forbidden_notification_fields": ["full_phone"]
  },
  "products": [],
  "sales_playbook": {},
  "lead_schema": {
    "standard_fields": [],
    "custom_fields": {}
  },
  "forbidden_claims": [],
  "handoff": {
    "callback_allowed": true,
    "email_direct_allowed": true
  }
}
```

Rules:

- Runtime code should not hardcode TechnoloHit-specific product wording.
- Agent config changes must be versioned.
- Call sessions must record config/playbook/knowledge version used.
- Config validation must fail closed if required sections are missing.

- [ ] Successful: Agent config schema designed.
- [ ] Successful: TechnoloHit config seed created.
- [ ] Successful: Runtime loads business behavior from agent config.
- [ ] Successful: `.env` contains no business behavior except infrastructure fallback values.

## RAG Scope And Sales Usage

RAG is for product/company/sales Q&A only in Phase 1.

RAG must not:

- create leads
- grant permission
- validate phone numbers
- choose callback readiness
- access cross-tenant knowledge
- invent pricing/guarantees

Every retrieval request must include:

```json
{
  "tenant_id": "technolohit",
  "agent_id": "main_voice_sales",
  "query": "...",
  "language": "de",
  "top_k": 3
}
```

RAG response must include:

- sources
- scores
- knowledge_version
- used/fallback reason
- tenant_id
- agent_id

Acceptance:

- If RAG is unavailable, the assistant fails closed to safe playbook text.
- RAG cannot leak another tenant's knowledge.
- RAG answerer is used only in allowed states.

- [ ] Successful: RAG API request/response supports tenant/agent scope.
- [ ] Successful: Knowledge ingestion stores tenant/agent/version.
- [ ] Successful: RAG Q&A state tests pass.
- [ ] Successful: RAG fail-closed tests pass.

## Lead Creation And Validation

Lead creation must remain deterministic and validator-based.

Standard lead fields:

- `tenant_id`
- `agent_id`
- `call_session_id`
- `product_interest`
- `customer_type`
- `caller_need`
- `contact_preference`
- `permission`
- `normalized_phone`
- `email`
- `company_name`
- `status`
- `source`
- `custom_fields JSONB`

Rules:

- `team_callback` requires valid callback phone and permission.
- Email path uses `await_customer_email`, not callback-ready lead.
- No full phone in Telegram/email/n8n payload.
- Full phone only in internal dashboard reveal with audit.
- LLM/RAG cannot override lead validators.
- If fields are unclear, use `manual_review`, not false-ready lead.

- [ ] Successful: Lead schema supports `custom_fields`.
- [ ] Successful: Lead validators are tenant-aware.
- [ ] Successful: Email path cannot create callback-ready lead.
- [ ] Successful: Phone path cannot create callback-ready lead without valid phone and permission.

## Usage And Quality Events

Create a minimal usage/quality event model from the start.

Recommended table:

```text
voice.call_quality_events
```

Suggested fields:

- `id UUID`
- `tenant_id TEXT`
- `agent_id TEXT`
- `call_session_id UUID`
- `event_type TEXT`
- `event_stage TEXT`
- `metric_name TEXT`
- `metric_value NUMERIC`
- `payload JSONB`
- `created_at TIMESTAMPTZ`

Events to capture:

- call duration
- number of turns
- STT first partial latency
- STT final latency
- endpointing latency
- LLM latency
- TTS first audio latency
- total response latency
- playback duration
- interruption/barge-in detected
- RAG used
- RAG miss/fail/timeout
- lead_created
- callback_requested
- email_directed
- repeated_prompt
- max_turns_close
- STT/TTS/LLM errors

Do not log:

- full phone in quality event payload
- API keys
- raw audio bytes
- full unredacted transcript in logs

- [ ] Successful: Usage/quality event schema designed.
- [ ] Successful: Core latency metrics written per call/turn.
- [ ] Successful: Events are tenant/agent scoped.

## Privacy, Security, And Retention

Keep existing privacy design:

- WireGuard-only Lead Dashboard
- Basic Auth now; SSO later
- masked phone by default
- explicit reveal phone action
- reveal audit log
- no full phone in email/Telegram/n8n
- transcript preview logging disabled by default

Add Phase 1 decisions:

- raw audio retention period
- transcript retention period
- lead retention/anonymization period
- audit retention period
- encrypted backup policy
- access list for dashboard users

Recommended initial policy for review:

```text
Raw audio: 21 days
Turn transcripts: 90 days unless lead/legal reason requires longer
Call summaries: 90 days
Quality events: 90 days
Lead records: until operationally resolved plus agreed business retention/anonymization
Audit events: 12 months
```

This is technical planning, not legal advice. **Mojtaba, Founder of TechnoloHit**, is the retention/privacy approval owner and must approve the final retention values before production v4 rollout.

- [x] Successful: Retention/privacy owner assigned: Mojtaba, Founder of TechnoloHit.
- [ ] Successful: Final retention values approved by Mojtaba.
- [ ] Successful: Backup encryption responsibility assigned.
- [ ] Successful: Dashboard access list reviewed.
- [ ] Successful: Privacy/legal sign-off obtained before production v4.

## Deployment Strategy

v4 must be deployable without risking v3 production.

Recommended rollout:

1. Build v4 runtime behind flags.
2. Run text QA harness.
3. Run offline audio/STT fixtures.
4. Run shadow mode if practical: store v4 interpretation without controlling live call.
5. Run live QA number or limited internal calls.
6. Enable for TechnoloHit production during supervised window.
7. Keep v3 rollback path.

Recommended flags:

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

Note:

- Infra/secrets remain in `.env`.
- Business behavior stays in `agent_config`.
- Deploy workflow must verify runtime flags without printing secrets.

- [ ] Successful: v4 flags documented.
- [ ] Successful: v3 rollback path tested.
- [ ] Successful: Deploy verification checks tenant/agent/runtime version.

## CI And QA Requirements

CI must cover:

- unit tests for state transitions
- unit tests for memory updates
- unit tests for lead validators
- unit tests for tenant scoping
- RAG fail-closed tests
- dialogue QA scenarios
- post-capture Q&A scenarios
- email path scenarios
- phone path scenarios
- interruption/barge-in simulated tests
- no forbidden outbound wording
- no secret/artifact guard

Live QA matrix must cover:

- accented/non-native German
- caller interrupts assistant
- caller changes topic after contact path
- caller asks product question after email direction
- caller asks price question after callback permission
- caller gives incomplete phone
- caller uses caller ID permission
- caller chooses email
- caller asks about Smart Website vs Voice Assistant relationship
- caller says goodbye
- silence/no speech
- noisy input

- [ ] Successful: v4 unit tests added.
- [ ] Successful: v4 dialogue QA matrix added.
- [ ] Successful: Live QA runbook added.

## Phase 0 Decision Document Gate

Before any implementation starts, Phase 0 must produce a concrete decision document.

Recommended filename:

```text
docs/Tasks/voice_assistant_v4_phase0_decision_report.md
```

The report must answer and evidence these decisions:

1. AudioSocket barge-in feasibility result
   - Can current AudioSocket playback be stopped quickly and reliably when caller speech starts?
   - What was tested?
   - What command/log/live-call evidence proves it?
   - If not reliable, what alternate media path is selected?

2. Streaming STT/TTS provider decision
   - Which provider/API/runtime will be used for streaming STT?
   - Which provider/API/runtime will be used for streaming or low-latency TTS?
   - Why was it selected?
   - What are the fallback options?

3. Latency target confirmation
   - speech start detection target
   - endpointing target
   - first partial transcript target
   - final transcript after endpoint target
   - first response audio target
   - barge-in stop target

4. Retention owner and values
   - raw audio retention
   - turn transcript retention
   - call summary retention
   - lead retention/anonymization
   - audit retention
   - backup encryption responsibility
   - approving owner/responsible person

5. Implementation path
   - implement v4 inside `voice-bridge` behind flags, or
   - create a new realtime runtime service
   - explain the choice and rollback impact

6. Rollback plan
   - how to keep v3 production safe
   - exact deploy flag/image rollback method
   - database migration rollback or forward-only strategy
   - how to disable v4 without affecting post-call/lead/dashboard flows

7. Concurrency and overload policy
   - expected normal concurrent calls for TechnoloHit
   - maximum safe concurrent calls on the current server
   - behavior when capacity is exceeded
   - queue vs reject vs fallback-to-human/voicemail decision
   - per-call CPU/memory estimate for realtime STT/TTS
   - provider rate-limit handling
   - backpressure behavior for STT/TTS/LLM/RAG failures
   - protection against one long call starving other calls

Hard gate:

```text
Do not start implementation before this Phase 0 decision report is complete and accepted.
```

- [x] Successful: Phase 0 decision report created.
- [x] Successful: AudioSocket barge-in feasibility documented.
- [x] Successful: Streaming STT/TTS provider decision documented.
- [x] Successful: Latency targets documented.
- [x] Successful: Retention owner and values documented.
- [x] Successful: Media path selected after Phase 0B repeatability validation: continue with AudioSocket for playback cancellation.
- [x] Successful: Rollback plan documented.
- [x] Successful: Concurrency and overload policy documented.
- [x] Successful: Phase 0 decision report accepted.

## Phase Plan

Progress summary:

- [x] Successful: Phase 0 / 0B / 0C accepted for foundation planning.
- [x] Successful: Phase 1 tenant-ready foundation implemented (tag `v1.4.0`).
- [x] Successful: Phase 2 runtime foundation / application layer implemented.
- [x] Successful: Phase 3 realtime audio foundation / media layer implemented.
- [x] Successful: Phase 4 barge-in and interruption runtime foundation implemented.
- [x] Successful: Phase 5 live dialogue orchestrator integration implemented.
- [x] Successful: Phase 6 RAG product/sales Q&A integration complete (canary path).

### Phase 0: Architecture And Runtime Feasibility

- [x] Successful: Current AudioSocket playback interruption feasibility tested. v3 default failed; Phase 0B repeatability QA passed with repeated `immediate_stop` results.
- [x] Successful: Phase 0C interruption recovery live QA passed sufficiently to continue.
- [x] Successful: Phase 0B/0C spike flags remain QA-only; production v4 uses proper flags later.
- [x] Successful: Streaming STT provider/API decision made.
- [x] Successful: Streaming/low-latency TTS provider/API decision made.
- [x] Successful: Latency targets confirmed.
- [x] Successful: Retention/security decisions recorded.
- [x] Successful: v4 media path selected after Phase 0B repeatability validation: AudioSocket playback cancellation.
- [x] Successful: `voice_assistant_v4_phase0_decision_report.md` completed and accepted.
- [x] Successful: Full barge-in behavior conditionally accepted for foundation planning (production implementation → Phase 4).

### Phase 1: Tenant-Ready Data And Config Foundation

- [x] Successful: Add `tenant_id`, `agent_id`, and version fields to core voice tables.
- [x] Successful: Add `custom_fields JSONB` to leads.
- [x] Successful: Add usage/quality events table.
- [x] Successful: Add versioned TechnoloHit agent config.
- [x] Successful: Runtime loads config without hardcoded TechnoloHit business behavior in v4 loader path.
- [x] Successful: RAG requests include tenant/agent scope.
- [x] Successful: v4 runtime router skeleton defaults to v3.
- [x] Successful: Phase 1 foundation report added.
- [ ] Successful: Phase 1 migrations applied on target database (operator step).
- [ ] Successful: Phase 1 team review accepted.

### Phase 2: Runtime Foundation / Application Layer

**Status: implementation complete in repo; production still on v3.**

- [x] Successful: Structured `CallSessionMemory` with tests.
- [x] Successful: Deterministic v4 state machine with tests.
- [x] Successful: Runtime router prepares v4 context (`createRuntimeContext`; v3 default unchanged).
- [x] Successful: Quality event typed builders with redaction.
- [x] Successful: v4 lead validator foundation with tests.
- [x] Successful: RAG scope guardrails (tenant/agent, no lead delegation).
- [x] Successful: Agent config helper functions.
- [x] Successful: Phase 2 runtime foundation report added.

Stub modules remain for media/orchestration wiring in later phases (no production behavior change).

### Phase 3: Realtime Audio Foundation / Media Layer

**Status: implementation complete in repo; production still on v3; canary is test-harness only.**

- [x] Successful: Create v4 audio session abstraction (beyond stub).
- [x] Successful: Add VAD/endpointing module (beyond stub).
- [x] Successful: Add streaming STT adapter or low-latency incremental STT adapter.
- [x] Successful: Add streaming/low-latency TTS adapter.
- [x] Successful: Add TTS cache for common prompts.
- [x] Successful: Latency metric hooks for STT/TTS/endpointing (live pipeline measurement → Phase 5/8).
- [x] Successful: Wire audiosocket to v4 runtime behind explicit v4/canary flags (safe; default off).
- [x] Successful: Phase 3 realtime audio foundation report added.

### Phase 4: Barge-In And Interruption Runtime Implementation

**Status: implementation complete in repo; canary/test-harness only; production still on v3.**

- [x] Successful: Detect caller speech during assistant playback (v4 barge-in detector + canary harness).
- [x] Successful: Stop/cancel playback safely using `VOICE_V4_BARGE_IN_ENABLED` path (not Phase 0B/0C spike flags).
- [x] Successful: Preserve interruption context in v4 memory/state.
- [x] Successful: Interruption recovery foundation (product/topic switch, same-topic continue) with tests.
- [x] Successful: Product/topic change after interruption resets or repairs state correctly (foundation tests).
- [x] Successful: Barge-in/interruption feasibility live QA passes for Phase 0; v4 modules now separate from spike.
- [x] Successful: Phase 4 barge-in runtime report added.
- [x] Successful: Resume dialogue from interrupted intent in **canary v4 orchestrator** (live production path → Phase 6+).

### Phase 5: Live Dialogue Orchestrator Integration

**Status: implementation complete in repo; canary/test-harness only; production still on v3.**

- [x] Successful: v4 memory/state transitions in canary orchestrator (not v3 `turn-assistant.js`).
- [x] Successful: v4 dialogue orchestrator module (`dialogue-orchestrator.js`).
- [x] Successful: Deterministic response planner foundation.
- [x] Successful: Canary runtime loop simulation (transcript, playback, barge-in).
- [x] Successful: Quality event sink hooks (v4 path only; memory buffer + optional insert).
- [x] Successful: Lead validator gates callback-ready in orchestrator.
- [x] Successful: Phase 5 dialogue orchestrator report added.
- [x] Successful: Product Q&A after contact capture does not restart intake (canary v4 orchestrator).
- [ ] Successful: Persist quality events from v4 path to DB (Phase 8).

### Phase 6: RAG Product/Sales Q&A Integration

**Status: implementation complete in repo (canary/test-harness only; production still v3).**

- [x] Successful: RAG retrieval tenant/agent scoped (Phase 1/2 foundation).
- [x] Successful: RAG scope guardrails — no lead/permission delegation (Phase 2).
- [x] Successful: RAG used only in allowed Q&A states in canary v4 runtime.
- [x] Successful: RAG output is grounded and bounded in canary v4 runtime.
- [x] Successful: RAG fail-closed behavior verified end-to-end in v4 canary path.
- [x] Successful: Product/sales answer canary QA passes (`v4-phase6-rag-product-sales-qa.test.js`).
- [ ] Successful: Live AudioSocket production path RAG integration (Phase 9 rollout).

### Phase 7: Lead Policy, Post-Call Reliability, And Privacy

**Status: implementation complete in repo (canary/test-harness only; production still v3).**

- [x] Successful: v4 lead validator foundation (Phase 2).
- [x] Successful: Lead validators read structured memory in canary v4 runtime.
- [x] Successful: Email path creates `await_customer_email`, not callback-ready lead.
- [x] Successful: Phone callback requires valid phone and permission in canary v4 runtime.
- [x] Successful: Post-call summary includes tenant/agent/version fields (v4 metadata bridge).
- [x] Successful: n8n notification payloads privacy-sanitized with idempotency key.
- [x] Successful: Phase 7 lead/post-call/privacy tests pass (`v4-phase7-lead-postcall-privacy.test.js`).
- [ ] Successful: Live production post-call path consumes v4 memory snapshot (Phase 8–9).

### Phase 8: Observability And Quality Analytics

**Status: implementation complete in repo (canary/test-harness only; production still v3).**

- [x] Successful: Quality event builder shapes defined (Phase 2).
- [x] Successful: Usage/quality events persisted from v4 canary runtime to DB (when `persistQualityToDb` / insertFn enabled).
- [x] Successful: Latency/error rollups visible via `buildCallQualitySummary` and SQL runbook.
- [x] Successful: QA queries documented (`voice_assistant_v4_phase8_quality_analytics_queries.sql`).
- [x] Successful: Conversion/drop-off metrics defined in per-call quality summary.
- [x] Successful: Phase 8 observability tests pass (`v4-phase8-observability-quality.test.js`).
- [ ] Successful: Live production v4 auto-flush on call end (Phase 9c enablement).

### Phase 9: Production Rollout Preparation

**Status: documentation and runbook complete; production v4 NOT enabled.**

- [x] Successful: v4 deploy flags documented and verification commands defined.
- [x] Successful: v3 rollback procedure documented (immutable tag pin).
- [x] Successful: Sysadmin runbook created (`voice_assistant_v4_phase9_sysadmin_runbook.md`).
- [x] Successful: Phase 9 rollout report created.
- [x] Successful: GitHub Actions / CI deploy tag format documented for v1.11.0.
- [x] Successful: Acceptance checklist defined (operator sign-off).
- [x] Successful: Internal live QA completed (operator — Phase 9 dry run v3 test call).
- [ ] Successful: Phase 9b supervised canary executed (awaiting team approval + preconditions).
- [ ] Successful: Supervised production v4 enablement completed (blocked — see blockers).
- [ ] Successful: Post-rollout quality review completed (after v4 enablement only).

### Phase 9b: Supervised Canary Validation

**Status: blueprint and runbook complete; production v4 NOT enabled; execution not started.**

- [x] Successful: Phase 9b supervised canary blueprint created.
- [x] Successful: Phase 9b sysadmin canary runbook created.
- [x] Successful: Canary flag matrix documented (baseline / test-host / maintenance window).
- [x] Successful: Call QA scenario matrix defined (Tier 9b-A / 9b-B).
- [x] Successful: Metrics, SQL snippets, stop/rollback criteria documented.
- [x] Successful: Sysadmin reporting template defined.
- [x] Successful: v1.11.0 live-call wiring constraint documented (Tier 9b-B N/A until wiring ships).
- [ ] Successful: Team approval for maintenance window recorded.
- [ ] Successful: Tier 9b-A executed on production (env verify + v3 baseline + rollback).
- [ ] Successful: Tier 9b-B executed (live v4 dialogue — **blocked until Phase 10**).

### Phase 10: Live AudioSocket → v4 Canary Wiring

**Status: implementation blueprint complete; no code yet; production v4 NOT enabled.**

- [x] Successful: Current blocker documented (live PSTN v3 vs v4 harness).
- [x] Successful: Target flag-gated canary architecture defined.
- [x] Successful: Routing / fail-closed-to-v3 architecture decision recorded.
- [x] Successful: Sub-phases 10A–10H defined.
- [x] Successful: Safety rules and required tests specified.
- [x] Successful: Sysadmin/live QA needs cross-referenced to Phase 9b + Phase 8 SQL.
- [x] Successful: Phase 10A implementation prompt prepared.
- [x] Successful: Phase 10A route selection + lifecycle logging implemented.
- [x] Successful: Phase 10B inbound PCM + VAD endpointing on live v4_canary path.
- [x] Successful: Phase 10C live STT on VAD endpoint implemented.
- [x] Successful: Phase 10D live dialogue orchestrator on transcript implemented.
- [x] Successful: Phase 10E live TTS/playback plumbing implemented with mock-safe adapter.
- [ ] Successful: Phase 10E2 real provider-backed TTS implemented for intelligible live-call answers.
- [ ] Successful: Phase 10H live QA runbook published.
- [ ] Successful: Tier 9b-B supervised canary executed.

## Sysadmin Preparation Checklist

Needed before implementation:

- [x] Successful: Confirm whether current Asterisk AudioSocket can support reliable playback stop/break for barge-in. Phase 0B repeatability QA passed for playback cancellation.
- [ ] Successful: Confirm whether an ARI/ExternalMedia path is available if AudioSocket is insufficient. Current ARI check shows no loaded ARI modules.
- [x] Successful: Confirm server CPU/memory headroom for realtime STT/TTS pipeline. Initial headroom is acceptable for testing.
- [x] Successful: Confirm expected and maximum concurrent call capacity for initial planning: 3 normal, 5 stretch/load-test.
- [ ] Successful: Confirm overload behavior for calls above capacity.
- [ ] Successful: Confirm allowed provider/API for streaming STT/TTS/realtime audio.
- [x] Successful: Confirm retention policy owner: Mojtaba, Founder of TechnoloHit.
- [ ] Successful: Confirm encrypted backup status for PostgreSQL and recordings.
- [ ] Successful: Confirm whether a QA phone number or QA route can be used for v4 tests.

Useful server checks:

```bash
docker stats --no-stream
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}'
docker logs --tail=100 technolohit-voice-bridge
docker exec technolohit-asterisk asterisk -rx "core show applications" | egrep -i "AudioSocket|ExternalMedia|ARI|Stasis"
docker exec technolohit-asterisk asterisk -rx "module show like ari"
docker exec technolohit-asterisk asterisk -rx "module show like external"
```

## Open Decisions

These must be answered in Phase 0:

1. Can current AudioSocket path support reliable barge-in?
2. Which streaming STT/TTS/realtime provider will be used?
3. What are the exact latency targets?
4. What are raw audio/transcript/lead/audit retention periods?
5. Should v4 be implemented inside `voice-bridge` behind flags or as a new `voice-runtime-v4` service?
6. Should agent config source of truth be file-based in Phase 1, DB-based, or file seed plus DB later?
7. Do we need a separate QA phone route before production rollout?
8. What is the maximum supported concurrent call count and overload behavior?

- [x] Successful: Open decisions resolved for Phase 1 foundation.
- [x] Successful: Implementation approved for Phase 1 foundation.

Current project status (see also **Current Project Status** at top):

- AudioSocket availability: available.
- AudioSocket barge-in live/manual behavior: v3 default failed; Phase 0B repeatability QA passed for playback cancellation. Phase 0C interruption recovery live QA passed sufficiently to continue.
- ARI/ExternalMedia fallback: not confirmed; ARI modules are not currently loaded.
- Server capacity: enough for initial v4 tests; operational concurrency target still pending.
- RAG readiness: ready via host-local URL `http://127.0.0.1:8080` from voice-bridge; Docker DNS `technolohit-rag-api` is not valid in the current host-network setup.
- Phase 1 foundation: **implementation complete in repo** (tag `v1.4.0`) — migrations pending operator apply.
- Phase 2 runtime foundation: **implementation complete in repo** (tag `v1.5.0`) — production still on v3.
- Phase 3 media foundation: **implementation complete in repo** (tag `v1.6.0`) — canary/test-harness only.
- Phase 4 barge-in foundation: **implementation complete in repo** (tag `v1.7.0`) — canary/test-harness only.
- Phase 5 dialogue orchestrator: **implementation complete in repo** — canary/test-harness only; production still on v3.
- Phase 6 RAG product/sales Q&A: **implementation complete in repo** — canary/test-harness only; production still on v3.
- Phase 7 lead/post-call/privacy: **implementation complete in repo** — canary/test-harness only; production still on v3.
- Phase 8 observability/quality analytics: **implementation complete in repo** — canary/test-harness only; production still on v3.
- Phase 9 rollout preparation: **dry run passed** (2026-06-01) — production on `voice-bridge-v1.11.0` with v3 active; **production v4 still disabled**.
- Phase 9b supervised canary: **blueprint/runbook complete in repo** — Tier 9b-A await approval; Tier 9b-B blocked on Phase 10.
- Phase 10 live AudioSocket wiring: **Phase 10A–10E implemented** (route gates, VAD, STT, dialogue, mock-safe TTS/playback plumbing); **real intelligible live-call TTS still requires Phase 10E2**; **barge-in not active** (10F after real TTS); production v4 still disabled.
- **Production v4 enablement (Phase 9c):** blocked until retention approval, backup encryption confirmation, dedicated QA route, overload fallback, OpenAI streaming limits, **and** Phase 10 live wiring + Tier 9b-B pass.

## Acceptance Criteria For v4 Phase 1

Functional:

- caller can interrupt assistant and assistant stops speaking
- endpointing feels fast and does not cut off normal callers
- assistant remembers caller context during the call
- assistant answers product questions after contact capture without restarting intake
- assistant uses RAG for product/sales Q&A only
- callback-ready lead is created only with valid phone and permission
- email path does not create callback-ready lead

Tenant-ready:

- all core call/lead/knowledge/events records include tenant/agent/version identifiers
- RAG retrieval is tenant/agent scoped
- TechnoloHit behavior is loaded from agent config
- leads support `custom_fields JSONB`
- usage/quality events are written per call

Security/privacy:

- no full phone in Telegram/email/n8n
- dashboard reveal remains audited
- transcript preview logs remain disabled by default
- retention policy is documented
- no cross-tenant knowledge access is possible

Production:

- CI green
- v3 rollback available
- v4 live QA matrix passed
- production rollout supervised
- post-rollout metrics reviewed

- [ ] Successful: Functional acceptance passed.
- [ ] Successful: Tenant-ready acceptance passed.
- [ ] Successful: Security/privacy acceptance passed.
- [ ] Successful: Production acceptance passed.

## Final Implementation Rule

Cursor or any implementation agent must work phase by phase.

For each phase:

1. Read this blueprint.
2. Inspect current code before editing.
3. Implement the smallest coherent set of changes for that phase.
4. Add focused tests.
5. Update docs.
6. Mark only completed checklist items as successful.
7. Stop and report blockers instead of guessing across telephony/provider/security boundaries.

Do not skip Phase 0.
