# Voice Bridge Runtime Environment (Source of Truth)

## Authoritative runtime env file on the production host

The `technolohit-voice-bridge` container loads runtime environment from:

```text
<VOICE_DEPLOY_PATH>/../voice-bridge/.env
```

When `VOICE_DEPLOY_PATH` is `/opt/technolohit-voice/asterisk`, the file is:

```text
/opt/technolohit-voice/voice-bridge/.env
```

This comes from Docker Compose `env_file` on the **voice-bridge** service (not from `asterisk/.env` alone).

`asterisk/.env` is for Asterisk/SIP settings and Compose interpolation (image tags only). Changing only `asterisk/.env` does **not** update voice-bridge runtime flags. Do **not** duplicate `VOICE_*` runtime flags in `asterisk/.env` — when the server compose file interpolates those keys into `voice-bridge.environment:`, they override `env_file` and can invalidate Gate 3.

Keep image selection separate from runtime flags:

- Runtime flags: `/opt/technolohit-voice/voice-bridge/.env` (sole source of truth)
- Image tag: GitHub Actions deploy input, `VOICE_BRIDGE_IMAGE` shell override, or the Compose interpolation env used by `docker compose`
- Compose reference: `asterisk/docker-compose.voice-bridge.reference.yml` (server patch shape; base `docker-compose.yml` is not tracked in this repo)

## v4 foundation flags (Phase 1–3 — default off)

Set in `/opt/technolohit-voice/voice-bridge/.env` only for supervised v4 work:

```env
VOICE_RUNTIME_VERSION=v3
VOICE_V4_REALTIME_ENABLED=false
VOICE_V4_STREAMING_STT_ENABLED=false
VOICE_V4_STREAMING_TTS_ENABLED=false
VOICE_TENANT_ID=technolohit
VOICE_AGENT_ID=main_voice_sales
VOICE_AGENT_CONFIG_PATH=/app/config/agents/technolohit.main_voice_sales.v4.json
```

Phase 3 media/canary flags (default off; production remains v3):

```env
VOICE_V4_CANARY_ENABLED=false
VOICE_V4_VAD_RMS_THRESHOLD=450
VOICE_V4_VAD_SPEECH_FRAMES=3
VOICE_V4_ENDPOINT_SILENCE_MS=600
VOICE_V4_ENDPOINT_MIN_SPEECH_MS=240
VOICE_V4_STT_PROVIDER=mock
VOICE_V4_TTS_PROVIDER=mock
VOICE_V4_TTS_CACHE_ENABLED=true
```

`VOICE_V4_CANARY_ENABLED=true` plus `VOICE_RUNTIME_VERSION=v4` and `VOICE_V4_REALTIME_ENABLED=true` prepares v4 stub/harness contexts in tests. **Live PSTN routing** requires Phase 10A gates below (all default off).

Phase 10E2/10I real STT/TTS is opt-in for supervised live-canary QA only:

```env
VOICE_V4_STT_PROVIDER=openai
VOICE_V4_TTS_PROVIDER=openai
OPENAI_API_KEY=<secret>
```

Keep `VOICE_V4_STT_PROVIDER=mock` and `VOICE_V4_TTS_PROVIDER=mock` unless a supervised QA window explicitly needs real v4 live-canary speech understanding/playback. Live PSTN semantic QA is invalid with mock STT.

Phase 10A live AudioSocket canary gates (default off; production remains v3):

```env
VOICE_V4_LIVE_AUDIOSOCKET_ENABLED=false
VOICE_V4_LIVE_CANARY_ALLOWLIST=
```

Live v4 canary on AudioSocket requires **all** of:

- `VOICE_RUNTIME_VERSION=v4`
- `VOICE_V4_REALTIME_ENABLED=true`
- `VOICE_V4_CANARY_ENABLED=true`
- `VOICE_V4_LIVE_AUDIOSOCKET_ENABLED=true`
- Non-empty `VOICE_V4_LIVE_CANARY_ALLOWLIST` with an entry matching `bridge_call_id` or `external_call_id` (prefix/substring/equality — no phone numbers in allowlist)

If any gate fails, the call **fail-closes to v3** (`turn-assistant`). Phase 10A adds lifecycle logs only (`[v4-live]`); STT/TTS/dialogue loop arrives in Phase 10B+.

Example QA allowlist (use bridge id prefix, not DID):

```env
VOICE_V4_LIVE_CANARY_ALLOWLIST=qa-canary
```

Phase 4 barge-in flags (canary/test-harness only; **not** production v4):

```env
VOICE_V4_BARGE_IN_ENABLED=false
VOICE_V4_BARGE_IN_RMS_THRESHOLD=450
VOICE_V4_BARGE_IN_SPEECH_FRAMES=3
VOICE_V4_BARGE_IN_MIN_PLAYBACK_MS=120
VOICE_V4_BARGE_IN_CANCEL_TIMEOUT_MS=400
```

Phase 0B/0C spike flags remain **QA-only legacy** and must not be used as the production v4 barge-in path:

```env
VOICE_V4_PLAYBACK_CANCEL_SPIKE_ENABLED=false
VOICE_V4_INTERRUPTION_CONTEXT_SPIKE_ENABLED=false
```

Production may override agent config via `VOICE_AGENT_CONFIG_PATH` or mount a replacement file. The voice-bridge Docker image includes the default seed at `/app/config/agents/technolohit.main_voice_sales.v4.json`.

### Phase 12A — immutable playbook runtime binding (default off)

Opt-in only. With defaults unchanged, runtime behavior is identical to the hardcoded Phase 10AK values and neither a binding nor playbook file is read at call time. Runtime activation requires an approved, active, canary-scoped binding to the exact immutable published artifact.

```env
VOICE_V4_PLAYBOOK_RUNTIME_ENABLED=false
VOICE_V4_PLAYBOOK_BINDING_PATH=
VOICE_V4_PLAYBOOK_PATH=
VOICE_V4_PLAYBOOK_ALLOW_DRAFT=false
```

| Variable | Default | Purpose |
|---|---|---|
| `VOICE_V4_PLAYBOOK_RUNTIME_ENABLED` | `false` | Master switch. It is insufficient by itself: the active v4 canary path and a valid binding are also required. |
| `VOICE_V4_PLAYBOOK_BINDING_PATH` | empty | Absolute or package-relative path to the runtime binding JSON. It must resolve under the package/container `config/playbook-bindings` directory; absolute paths outside that approved root are rejected. |
| `VOICE_V4_PLAYBOOK_PATH` | empty | Legacy Phase 10AN setting. Phase 12A bound runtime does not read it; retain empty. |
| `VOICE_V4_PLAYBOOK_ALLOW_DRAFT` | `false` | Legacy test/eval injection override only. Filesystem runtime binding rejects draft and candidate artifacts regardless of this value. |

The repository sample binding is `voice-bridge/config/playbook-bindings/technolohit.main_voice_sales.v1.canary.pending.json`; it is deliberately `status=pending` and `active=false`. It is not a production activation artifact.

Runtime eligibility requires all of: `VOICE_RUNTIME_VERSION=v4`, realtime enabled, canary enabled, live AudioSocket enabled, playbook runtime enabled, explicit binding path under the approved binding root, approved/active canary binding, and exact SHA-256/version/tenant/agent match. Existing binding files are checked with `realpath`, so a symlink within the approved directory cannot escape to another filesystem location.

The external binding is the only activation authority. The checksum-verified published playbook must retain an explicit boolean `runtime_binding.active=false`; embedded `true`, missing, or non-boolean activation metadata is rejected. Missing, corrupt, outside-root, traversing, symlink-escaping, draft, candidate, revoked, pending, inactive, or mismatched inputs fail closed to hardcoded behavior without crashing.

Privacy-safe preflight:

```bash
docker exec technolohit-voice-bridge npm run playbook:canary-preflight
```

Abort unless it exits zero and prints `playbook_canary_preflight=pass`, `binding_valid=true`, `checksum_verified=true`, and `failure_count=0`.

### Phase 10AR — questionnaire runtime (default off)

Opt-in only. When disabled, v4 response plans are unchanged. When enabled on an active v4 path, at most one soft project-context question may attach after a product/pricing answer if TTS length allows.

```env
VOICE_V4_QUESTIONNAIRE_RUNTIME_ENABLED=false
```

| Variable | Default | Purpose |
|---|---|---|
| `VOICE_V4_QUESTIONNAIRE_RUNTIME_ENABLED` | `false` | Master switch for post-answer questionnaire follow-up in v4 planner/orchestrator. Requires active v4 path; does not enable v4 globally. |

Safety: closing, out-of-scope, technical escalation, callback contact flow, RAG-unsafe fallback, duplicate responses, and length limits block questionnaire attachment. Lead validator rules are unchanged.

### Phase 10B — Agent Behavior Decision metadata (default off)

Opt-in only. When disabled, v4 `response_plan_created` quality events are unchanged. When enabled on an active v4 path, privacy-safe decision metadata is attached for observability. The decision object does **not** control response text, RAG, questionnaire, or callback runtime in Phase 10B.

```env
VOICE_V4_AGENT_BEHAVIOR_DECISION_ENABLED=false
```

| Variable | Default | Purpose |
|---|---|---|
| `VOICE_V4_AGENT_BEHAVIOR_DECISION_ENABLED` | `false` | Attach Agent Behavior Decision metadata to v4 `response_plan_created` events. Requires active v4 path; does not enable v4 globally or change planner behavior. |

Safety: metadata never includes raw transcript, phone, email, RAG query, or lead details. Invalid/missing playbooks fail closed in metadata (`behavior_decision_rag_allowed=false`, `behavior_decision_questionnaire_allowed=false`). Resolver failures record safe failure metadata without throwing.

### Phase 10E — contact form handoff / voice-capture restrictions (default off)

Opt-in only. When disabled, v4 response plans are unchanged. When enabled on an active v4 path, callers who offer email addresses, website URLs, company names, or complex project details by voice receive a short `contact_form_handoff` redirect to the contact form instead of voice capture.

```env
VOICE_V4_CONTACT_FORM_HANDOFF_ENABLED=false
```

| Variable | Default | Purpose |
|---|---|---|
| `VOICE_V4_CONTACT_FORM_HANDOFF_ENABLED` | `false` | Redirect email/URL/company/complex voice input to the contact form. Requires active v4 path; does not enable v4 globally. |

Safety: does not trigger RAG, questionnaire attachment, callback flow, or `lead_ready`. Closing intent and explicit callback requests still outrank contact-form handoff. Invalid/missing playbooks use a safe hardcoded German fallback phrase.

Production RAG URL from voice-bridge host network:

```env
VOICE_RAG_API_URL=http://127.0.0.1:8080
```

## v3 QA flags (voice-bridge only)

Set these in `/opt/technolohit-voice/voice-bridge/.env`:

```env
VOICE_SEMANTIC_INTENT_ENABLED=true
VOICE_CONVERSATION_REPAIR_ENABLED=true
VOICE_SEMANTIC_INTENT_MODE=deterministic
VOICE_RAG_ENABLED=false
VOICE_RAG_SALES_ANSWERER_ENABLED=false
VOICE_RAG_QA_MODE=false
VOICE_RAG_API_URL=http://127.0.0.1:8080
VOICE_RAG_RETRIEVE_TIMEOUT_MS=1500
VOICE_RAG_RETRIEVE_MAX_ATTEMPTS=3
VOICE_LEAD_POLICY_STRICT_CALLBACK=true
VOICE_LOG_TRANSCRIPT_PREVIEW=false
```

Also ensure the running image is pinned through the deploy workflow input or the Compose interpolation env, for example:

```env
VOICE_BRIDGE_IMAGE=thnhit/technhvoice:voice-bridge-v1.3.0
```

Do not rely on the service `env_file` alone for image substitution; Compose resolves `image: ${VOICE_BRIDGE_IMAGE}` before it injects `env_file` values into the container.

## After changing env

```bash
cd /opt/technolohit-voice/asterisk
VOICE_BRIDGE_IMAGE=thnhit/technhvoice:voice-bridge-v1.3.0 docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d voice-bridge
```

## Verify (no secrets)

```bash
docker inspect technolohit-voice-bridge --format 'running_image={{.Config.Image}}'
docker exec technolohit-voice-bridge sh -lc 'printenv | sort | egrep "^(VOICE_SEMANTIC_INTENT_ENABLED|VOICE_CONVERSATION_REPAIR_ENABLED|VOICE_SEMANTIC_INTENT_MODE|VOICE_RAG_ENABLED|VOICE_RAG_SALES_ANSWERER_ENABLED|VOICE_RAG_QA_MODE|VOICE_LEAD_POLICY_STRICT_CALLBACK|VOICE_LOG_TRANSCRIPT_PREVIEW|IMAGE_TAG|BUILD_VERSION)="'
```

Expected:

- `running_image` matches the requested tag
- v3 flags present as configured above
- `VOICE_RAG_ENABLED=false`

## Deploy workflow

GitHub Actions **Deploy Voice Stack** can optionally verify these flags when `verify_v3_qa_env=true` (see `.github/workflows/deploy.yml`).

## Supervised v4 RAG-on canary preflight

Gate 3 requires **two** hard checks after editing
`/opt/technolohit-voice/voice-bridge/.env` and recreating the container:

### 1. Source ownership + effective runtime (sanitized snapshots)

This check is **self-contained on the production host**. It does not require a
repository checkout. It uses the deployed `voice-bridge` image with
`docker run --user 0:0` so the preflight can read host-owned `0600` snapshot
files without exposing secrets.

**What it verifies**

| Check | Source | Purpose |
|-------|--------|---------|
| Ownership | Raw `docker-compose.yml` **and** `docker-compose.prod.yml` | Fail if any forbidden runtime key appears in `voice-bridge.environment:` |
| Ownership | `asterisk/.env` key names only | Fail if forbidden runtime keys are duplicated in Compose project env |
| Effective (Stage A) | Sanitized runtime snapshots from authoritative file | Rendered Compose and container must match authoritative file while v3/RAG-off |
| Effective (Gate 3) | Sanitized Gate 3 snapshots | Authoritative file, rendered Compose, and container must match required v4/RAG-on values |

Approved interpolation keys in `asterisk/.env` only:

- `VOICE_BRIDGE_IMAGE`
- `RAG_API_IMAGE`
- `BUILD_VERSION`
- `IMAGE_TAG`

### Stage A baseline (safe v3/RAG-off)

Image required for Stage A baseline preflight: **`voice-bridge-v1.34.0`** or newer.

```bash
cd /opt/technolohit-voice/asterisk
bash /opt/technolohit-voice/bin/stage-a-compose-runtime-preflight.sh
```

Install wrappers once from the release branch if needed:

```bash
install -m 755 /path/from/release/scripts/compose-runtime-preflight-host.sh \
  /opt/technolohit-voice/bin/compose-runtime-preflight-host.sh
install -m 755 /path/from/release/scripts/stage-a-compose-runtime-preflight.sh \
  /opt/technolohit-voice/bin/stage-a-compose-runtime-preflight.sh
```

Full server migration steps: [Phase 10Y Stage A sysadmin runbook](./Tasks/voice_assistant_v4_phase10y_stage_a_sysadmin_runbook.md).

**Abort Stage A** unless output includes:

```text
compose_runtime_preflight=pass
mode=baseline
ownership_pass=true
compose_source_forbidden_by_file=none
compose_project_env_forbidden_keys=none
baseline_effective_pass=true
```

### Gate 3 preflight (v4/RAG-on canary only)

Run from the server only after Gate 2 passes and you intentionally enable v4/RAG-on:

```bash
cd /opt/technolohit-voice/asterisk
bash /opt/technolohit-voice/bin/gate3-compose-runtime-preflight.sh
```

Install the Gate 3 wrapper once from the release branch if needed:

```bash
install -m 755 /path/from/release/scripts/gate3-compose-runtime-preflight.sh \
  /opt/technolohit-voice/bin/gate3-compose-runtime-preflight.sh
```

If the wrapper is not installed yet, use the self-contained inline block in
[Phase 10H runbook section D.1](./Tasks/voice_assistant_v4_phase10h_live_qa_runbook.md).

**Abort Gate 3** unless output includes:

```text
compose_runtime_preflight=pass
ownership_pass=true
compose_source_forbidden_by_file=none
compose_project_env_forbidden_keys=none
authoritative_file.VOICE_RAG_ENABLED=true
compose_config.VOICE_RAG_ENABLED=true
container_runtime.VOICE_RAG_ENABLED=true
container_runtime.VOICE_RAG_API_URL=http://127.0.0.1:8080
```

`docker compose config` alone cannot prove ownership — it expands `env_file`
into the rendered environment. The preflight inspects **every raw Compose file**
used by the render command (`docker-compose.yml` and `docker-compose.prod.yml`)
plus **key names** from `asterisk/.env`.

### 2. In-container RAG canary guard

```bash
docker exec technolohit-voice-bridge npm run rag:canary-preflight
```

The command prints safe booleans and RAG health only. It does not print
secrets, queries, transcripts, phone numbers, or lead data.

**Required pass output includes:**

```text
rag_canary_preflight=pass
runtime_v4=true
v4_live_audiosocket_enabled=true
rag_enabled=true
rag_sales_answerer_enabled=true
rag_health_ok=true
failure_count=0
```

Abort the canary if the command exits non-zero. The deploy workflow can run
the same guard with `verify_v4_rag_canary_env=true`. Do not set
`verify_v3_qa_env=true` and `verify_v4_rag_canary_env=true` in the same deploy
request because they intentionally expect opposite RAG flag values.
