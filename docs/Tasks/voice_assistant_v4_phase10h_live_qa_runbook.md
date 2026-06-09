# v4 Phase 10H — Supervised Live PSTN QA Runbook (AudioSocket Canary)

Date: 2026-06-01
Baseline image: **`thnhit/technhvoice:voice-bridge-v1.23.0`** (Phase 10L) or later tag that includes 10L
Prior failed QA: [voice_assistant_v4_phase10h_live_qa_report.md](./voice_assistant_v4_phase10h_live_qa_report.md) (includes failed **v1.20.0** retry)
Stabilization: [voice_assistant_v4_phase10i_live_canary_stabilize_report.md](./voice_assistant_v4_phase10i_live_canary_stabilize_report.md), [voice_assistant_v4_phase10j_stt_failure_and_session_hardening_report.md](./voice_assistant_v4_phase10j_stt_failure_and_session_hardening_report.md), [voice_assistant_v4_phase10k_full_utterance_stt_buffer_fix_report.md](./voice_assistant_v4_phase10k_full_utterance_stt_buffer_fix_report.md), [voice_assistant_v4_phase10l_stt_success_buffer_metrics_report.md](./voice_assistant_v4_phase10l_stt_success_buffer_metrics_report.md)
Wiring: [voice_assistant_v4_phase10_live_audiosocket_canary_wiring_blueprint.md](./voice_assistant_v4_phase10_live_audiosocket_canary_wiring_blueprint.md)

**Do not execute without written maintenance-window approval.** This runbook does **not** enable production v4 GA. It validates the gated `v4_canary` path on a **supervised** PSTN call only.

**Production must return to v3** immediately after QA, even on pass.

---

## Paths and containers

```text
Compose dir:  /opt/technolohit-voice/asterisk
Runtime env:  /opt/technolohit-voice/voice-bridge/.env
Postgres:     container central_postgres, DB technolohit_growth
Compose service: voice-bridge
Container:    technolohit-voice-bridge
```

Env source of truth: [docs/voice-bridge-runtime-env.md](../voice-bridge-runtime-env.md)  
Deploy tags: [docs/release-and-cicd.md](../release-and-cicd.md)

---

## A. Precondition gate (abort if any fail)

Record results in [voice_assistant_v4_phase10h_live_qa_report.md](./voice_assistant_v4_phase10h_live_qa_report.md).

### A.1 Written approval and window

- [ ] Maintenance window scheduled (UTC): _______________
- [ ] Sysadmin + log observer present
- [ ] No production v4 GA approval implied by this QA
- [ ] Rollback image recorded (previous known-good): _______________

### A.2 Running image — upgrade to v1.19.0 (immutable tag)

```bash
cd /opt/technolohit-voice/asterisk
export VOICE_BRIDGE_IMAGE=thnhit/technhvoice:voice-bridge-v1.19.0
docker compose -f docker-compose.yml -f docker-compose.prod.yml pull voice-bridge
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d voice-bridge
sleep 3
docker inspect technolohit-voice-bridge --format 'running_image={{.Config.Image}}'
```

**Pass:** image ends with `voice-bridge-v1.19.0`.  
**Do not** pin production to `voice-bridge-latest`.

### A.3 Migration 009 (quality events) — required before SQL checks

```bash
docker exec central_postgres psql -U postgres -d technolohit_growth -P pager=off -c \
  "SELECT to_regclass('voice.call_quality_events') AS quality_table;"
```

**Pass:** `voice.call_quality_events` (not null).

If missing, apply migration from tag `v1.19.0` per [voice_assistant_v4_phase9_sysadmin_runbook.md](./voice_assistant_v4_phase9_sysadmin_runbook.md) §3 (file `009_v4_call_quality_events.sql`). Re-check before canary QA.

Baseline counts (optional):

```bash
docker exec central_postgres psql -U postgres -d technolohit_growth -P pager=off -c \
  "SELECT count(*) AS total FROM voice.call_quality_events;"
```

### A.4 OpenAI key present (do not print)

```bash
docker exec technolohit-voice-bridge sh -lc 'test -n "$OPENAI_API_KEY" && echo openai_key_set=yes || echo openai_key_set=no'
```

**Pass:** `openai_key_set=yes` (required for `VOICE_V4_TTS_PROVIDER=openai` and **`VOICE_V4_STT_PROVIDER=openai`**).

### A.4b STT provider (Phase 10I — required for live semantic QA)

```bash
docker exec technolohit-voice-bridge sh -lc \
  'echo stt_provider=${VOICE_V4_STT_PROVIDER:-unset}'
```

**Pass:** `stt_provider=openai`.
**Fail / abort:** `stt_provider=mock` or unset on a supervised PSTN semantic QA run — mock STT invalidates utterance understanding tests.

Startup log (after restart) must **not** show misleading `v4_active=true` on v3 default:

```bash
docker logs --since=2m technolohit-voice-bridge 2>&1 \
  | grep '\[voice-runtime\]' | tail -3
```

**Pass (v3 baseline):** `selected_runtime=v3 selected_runtime_active=true v4_requested=false v4_runtime_active=false reason=default_v3`

### A.4c Stale active call sessions (before and after QA)

```sql
SELECT id, status, started_at, ended_at, external_call_id
FROM voice.call_sessions
WHERE status = 'active' AND ended_at IS NULL
ORDER BY started_at DESC
LIMIT 10;
```

**Pass before QA:** zero rows, or only explained in-flight calls during the window.
**Pass after QA:** no new stale rows for the canary `call_session_id` (session must be `completed` with `ended_at` set).

**Read-only only** — do not bulk-update or auto-complete unrelated stale sessions from SQL.

### A.4d OpenAI STT preflight (Phase 10J — mandatory before canary)

Run **inside** the voice-bridge container after restart and **before** enabling canary env:

```bash
docker exec technolohit-voice-bridge npm run stt:preflight
```

**Pass (exit 0):** output includes `openai_stt_preflight=pass` and `http_status=200` (or another 2xx). `error_code=none` is ideal; `error_code=empty_transcript_on_tone` is also acceptable because the preflight uses a synthetic tone, not spoken German.

**Abort canary if fail:** `openai_stt_preflight=fail` — fix API key, model, or outbound connectivity first. Do **not** place a supervised PSTN call until preflight passes.

Expected safe output shape (no secrets, no transcript text):

```text
openai_stt_preflight=pass
model=gpt-4o-mini-transcribe
http_status=200
error_code=none
latency_ms=<number>
```

### A.5 RAG health (host-local URL from voice-bridge network)

```bash
curl -fsS http://127.0.0.1:8080/healthz && echo rag_ok
docker exec technolohit-voice-bridge sh -lc 'wget -qO- http://127.0.0.1:8080/healthz || curl -fsS http://127.0.0.1:8080/healthz'
```

**Pass:** HTTP 200 / health body.  
Phase 10H scenarios keep `VOICE_RAG_ENABLED=false` initially; this gate confirms infra only. Phase 10U RAG-on validation uses the same host-local URL and must not use Docker DNS from the host-network voice-bridge container.

### A.6 Gate 1 - v3 baseline health and pricing sanity (before any v4 canary flags)

With **production-safe baseline** env (section C), place **one** normal test call on the approved QA route.

Use this short script:

1. `Hallo, ich interessiere mich fuer die Smart Website.`
2. `Was kostet das?`
3. End the call normally.

**Important:** v3 does not support barge-in by design. Do not say `Stopp` to validate interruption behavior in the v3 baseline. Gate 1 is a health, routing, persistence, pricing-sanity, and rollback check. It is not a v4 interactivity test.

```bash
docker logs --since=5m technolohit-voice-bridge 2>&1 \
  | grep -vEi 'api[_-]?key|password|secret|Bearer |OPENAI' \
  | grep -vE '\+?[0-9]{8,}' \
  | egrep 'call_handler selected=|call accepted|call_end' \
  | tail -20
```

**Pass:**

- `call_handler selected=v3` (or handler not `v4_canary`)
- Greeting/assistant behavior normal for v3
- Smart Website pricing is answered briefly before customer-type qualification
- No `[v4-live]` lines on this call
- `live_runtime_selected`, `live_response_created`, and `live_runtime_summary` quality events are present when migration 009 is available
- No new stale active session

Record `call_session_id` if needed (UUID only — **not** caller phone).

### A.7 Backup env before canary changes

```bash
QA_STAMP="$(date -u +%Y%m%dT%H%MZ)"
cp /opt/technolohit-voice/voice-bridge/.env \
  "/opt/technolohit-voice/voice-bridge/.env.pre-10h-${QA_STAMP}.bak"
ls -l "/opt/technolohit-voice/voice-bridge/.env.pre-10h-${QA_STAMP}.bak"
```

---

## B. Safety rules

| Rule | Detail |
|------|--------|
| Supervised only | Run only in an approved maintenance window with an operator on the call |
| Restore v3 after QA | Revert section C env and restart **before** leaving the window |
| Empty allowlist | `VOICE_V4_LIVE_CANARY_ALLOWLIST=` (empty) **always** fail-closes to v3 |
| No phone in allowlist | Never put DID, E.164, or caller number in the allowlist |
| No concurrent PSTN | During canary window, avoid overlapping calls when using broad allowlist (see B.1) |
| No production v4 | Passing QA does not approve `VOICE_RUNTIME_VERSION=v4` for all traffic |
| Spike flags off | `VOICE_V4_PLAYBACK_CANCEL_SPIKE_ENABLED=false`, `VOICE_V4_INTERRUPTION_CONTEXT_SPIKE_ENABLED=false` |

### B.1 Allowlist feasibility (current code — read before canary)

`bridge_call_id` is a **new random UUID on every AudioSocket connection** (`persist.assignBridgeCallIdentity`). The allowlist is evaluated **once at call start**. You **cannot** learn the ID from the same call and activate v4 on that call retroactively.

| Approach | Feasible? | Notes |
|----------|-----------|--------|
| Put DID/phone in allowlist | **No** | Forbidden; not matched anyway |
| Preflight call → copy UUID → second call with that UUID | **No** | Second call gets a **new** UUID |
| Allowlist `qa-canary` without that substring in live IDs | **No** | Tests use `qa-canary`; production PSTN uses random UUIDs |
| Maintenance window + `VOICE_V4_LIVE_CANARY_ALLOWLIST=bridge:` | **Yes (supervised)** | Matches `external_call_id` form `bridge:<uuid>` for **every** call — **only** with zero other PSTN traffic |
| Dedicated non-phone route marker env (future code) | **Not in v1.19.0** | Recommended follow-up if `bridge:` is too broad |

**Recommended Phase 10H procedure (single-call window):**

1. Confirm **no other** inbound PSTN traffic during the window.
2. Set `VOICE_V4_LIVE_CANARY_ALLOWLIST=bridge:` (matches `external_call_id`; see section D).
3. Apply canary env, restart voice-bridge, place **one** supervised QA call.
4. Verify `call_handler selected=v4_canary` in logs.
5. Roll back env immediately after the call.

**Optional stricter procedure (two-call, still v3 on first call):**

1. Call #1 with empty allowlist → stays **v3**; note `bridge_call_id` in logs (for audit only).
2. Do **not** reuse that UUID for call #2 — it will not match.
3. For call #2, use `bridge:` allowlist (above) or stop and request a code follow-up for a static QA marker.

**Phase 10H blocker (document if `bridge:` cannot be used):** Without `bridge:` or a code change, random per-call UUIDs prevent pre-provisioned allowlist for PSTN canary.

---

## C. Production-safe baseline env (default / rollback target)

Edit `/opt/technolohit-voice/voice-bridge/.env`:

```env
VOICE_RUNTIME_VERSION=v3
VOICE_V4_REALTIME_ENABLED=false
VOICE_V4_CANARY_ENABLED=false
VOICE_V4_LIVE_AUDIOSOCKET_ENABLED=false
VOICE_V4_LIVE_CANARY_ALLOWLIST=
VOICE_V4_BARGE_IN_ENABLED=false
VOICE_V4_STT_PROVIDER=mock
VOICE_V4_TTS_PROVIDER=mock
VOICE_RAG_ENABLED=false
VOICE_RAG_SALES_ANSWERER_ENABLED=false
VOICE_V4_PLAYBACK_CANCEL_SPIKE_ENABLED=false
VOICE_V4_INTERRUPTION_CONTEXT_SPIKE_ENABLED=false
```

Restart after rollback:

```bash
cd /opt/technolohit-voice/asterisk
export VOICE_BRIDGE_IMAGE=thnhit/technhvoice:voice-bridge-v1.19.0
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d voice-bridge
```

(v1.19.0 code with v3 flags is the intended production-safe state until v4 GA is approved.)

---

## D. Gate 2 - supervised v4 / RAG-off control env (QA window only)

Edit `/opt/technolohit-voice/voice-bridge/.env` — **only** during the window:

```env
VOICE_RUNTIME_VERSION=v4
VOICE_V4_REALTIME_ENABLED=true
VOICE_V4_CANARY_ENABLED=true
VOICE_V4_LIVE_AUDIOSOCKET_ENABLED=true
VOICE_V4_LIVE_CANARY_ALLOWLIST=bridge:
VOICE_V4_STT_PROVIDER=openai
VOICE_V4_TTS_PROVIDER=openai
VOICE_V4_BARGE_IN_ENABLED=true
VOICE_RAG_ENABLED=false
VOICE_RAG_SALES_ANSWERER_ENABLED=false
VOICE_V4_PLAYBACK_CANCEL_SPIKE_ENABLED=false
VOICE_V4_INTERRUPTION_CONTEXT_SPIKE_ENABLED=false
```

Keep existing `OPENAI_API_KEY`, `VOICE_AGENT_CONFIG_PATH`, `VOICE_RAG_API_URL=http://127.0.0.1:8080`, VAD/barge-in thresholds unless ops standard says otherwise.

Gate 2 must pass before enabling RAG. It validates v4 interactivity, STT/TTS, barge-in, interruption recovery, product-context persistence, and quality flush.

### D.1 Gate 3 - Phase 10U supervised RAG-on override

Use only after the RAG-off canary is accepted and only during the supervised window:

```env
VOICE_RAG_API_URL=http://127.0.0.1:8080
VOICE_RAG_ENABLED=true
VOICE_RAG_SALES_ANSWERER_ENABLED=true
```

All other v4 live canary gates from section D remain required. Restore both RAG flags to `false` during rollback. Do not run Gate 3 if Gate 2 fails.

After editing the authoritative file:

```bash
cd /opt/technolohit-voice/asterisk

# 2) Render and inspect Compose config before recreate
docker compose -f docker-compose.yml -f docker-compose.prod.yml config \
  | egrep '^(      VOICE_RUNTIME_VERSION|      VOICE_V4_REALTIME_ENABLED|      VOICE_V4_CANARY_ENABLED|      VOICE_V4_LIVE_AUDIOSOCKET_ENABLED|      VOICE_RAG_ENABLED|      VOICE_RAG_SALES_ANSWERER_ENABLED|      VOICE_RAG_API_URL):'

# 3) Recreate voice-bridge
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d voice-bridge

# 4–5) Self-contained ownership + effective runtime preflight, then RAG guard
# No repository checkout required — uses deployed voice-bridge image only.
bash /opt/technolohit-voice/bin/gate3-compose-runtime-preflight.sh 2>/dev/null \
  || bash -se <<'GATE3_PREFLIGHT'
set -euo pipefail
DEPLOY_PATH="/opt/technolohit-voice/asterisk"
AUTHORITATIVE_ENV="/opt/technolohit-voice/voice-bridge/.env"
COMPOSE_PROJECT_ENV="${DEPLOY_PATH}/.env"
RAW_COMPOSE_BASE="${DEPLOY_PATH}/docker-compose.yml"
RAW_COMPOSE_PROD="${DEPLOY_PATH}/docker-compose.prod.yml"
CONTAINER_NAME="technolohit-voice-bridge"
TMP_DIR="$(mktemp -d)"
GATE3_KEYS=(VOICE_RUNTIME_VERSION VOICE_V4_REALTIME_ENABLED VOICE_V4_CANARY_ENABLED VOICE_V4_LIVE_AUDIOSOCKET_ENABLED VOICE_RAG_ENABLED VOICE_RAG_SALES_ANSWERER_ENABLED VOICE_RAG_API_URL)
cleanup(){ rm -rf "$TMP_DIR"; }; trap cleanup EXIT
fail(){ echo "compose_runtime_preflight=fail"; echo "failures=$1"; exit 1; }
write_snapshot_from_env_file(){ local src="$1" dst="$2" key line; : >"$dst"; for key in "${GATE3_KEYS[@]}"; do line="$(grep -E "^${key}=" "$src" 2>/dev/null | tail -n 1 || true)"; [ -n "$line" ] && printf '%s\n' "$line" >>"$dst"; done; chmod 600 "$dst"; }
write_snapshot_from_compose_config(){ local src="$1" dst="$2" key value; : >"$dst"; for key in "${GATE3_KEYS[@]}"; do value="$(awk -v key="$key" '$0 ~ /^  voice-bridge:/ { in_voice = 1; next } in_voice && /^  [A-Za-z0-9_.-]+:/ && $0 !~ /^  voice-bridge:/ { exit } in_voice && index($0, "      " key ":") == 1 { sub(/^[^:]*:[[:space:]]*/, "", $0); gsub(/^["'\''"]|["'\''"]$/, "", $0); print $0; exit }' "$src")"; [ -n "$value" ] && printf '%s=%s\n' "$key" "$value" >>"$dst"; done; chmod 600 "$dst"; }
write_snapshot_from_container(){ local dst="$1" key; : >"$dst"; for key in "${GATE3_KEYS[@]}"; do docker exec "$CONTAINER_NAME" sh -lc "printf '%s=%s\n' '$key' \"\${$key:-}\"" >>"$dst"; done; chmod 600 "$dst"; }
write_compose_project_env_keys(){ local src="$1" dst="$2"; if [ ! -f "$src" ]; then : >"$dst"; else awk -F= '/^[A-Za-z_][A-Za-z0-9_]*=/ { print $1 }' "$src" >"$dst"; fi; chmod 600 "$dst"; }
[ -f "$AUTHORITATIVE_ENV" ] || fail authoritative_env_missing
[ -f "$RAW_COMPOSE_BASE" ] || fail raw_compose_missing:docker-compose.yml
[ -f "$RAW_COMPOSE_PROD" ] || fail raw_compose_missing:docker-compose.prod.yml
docker inspect "$CONTAINER_NAME" >/dev/null 2>&1 || fail container_missing
RUNNING_IMAGE="$(docker inspect "$CONTAINER_NAME" --format '{{.Config.Image}}')"
AUTHORITATIVE_SNAPSHOT="${TMP_DIR}/authoritative-snapshot.env"
COMPOSE_RENDERED="${TMP_DIR}/compose-rendered.yml"
COMPOSE_SNAPSHOT="${TMP_DIR}/compose-snapshot.env"
CONTAINER_SNAPSHOT="${TMP_DIR}/container-snapshot.env"
PROJECT_ENV_KEYS="${TMP_DIR}/compose-project-env-keys.txt"
( cd "$DEPLOY_PATH"; docker compose -f docker-compose.yml -f docker-compose.prod.yml config >"$COMPOSE_RENDERED" )
write_snapshot_from_env_file "$AUTHORITATIVE_ENV" "$AUTHORITATIVE_SNAPSHOT"
write_snapshot_from_compose_config "$COMPOSE_RENDERED" "$COMPOSE_SNAPSHOT"
write_snapshot_from_container "$CONTAINER_SNAPSHOT"
write_compose_project_env_keys "$COMPOSE_PROJECT_ENV" "$PROJECT_ENV_KEYS"
docker run --rm --user 0:0 \
  -v "${AUTHORITATIVE_SNAPSHOT}:/authoritative.env:ro" \
  -v "${COMPOSE_SNAPSHOT}:/compose-config.env:ro" \
  -v "${CONTAINER_SNAPSHOT}:/container-env.env:ro" \
  -v "${RAW_COMPOSE_BASE}:/raw/docker-compose.yml:ro" \
  -v "${RAW_COMPOSE_PROD}:/raw/docker-compose.prod.yml:ro" \
  -v "${PROJECT_ENV_KEYS}:/compose-project-env-keys.txt:ro" \
  "$RUNNING_IMAGE" node scripts/compose-runtime-preflight.js \
    --gate3 --authoritative-file /authoritative.env --compose-config-file /compose-config.env \
    --container-env-file /container-env.env \
    --raw-compose-file /raw/docker-compose.yml \
    --raw-compose-file /raw/docker-compose.prod.yml \
    --compose-project-env-keys-file /compose-project-env-keys.txt
GATE3_PREFLIGHT
docker exec technolohit-voice-bridge npm run rag:canary-preflight
docker exec technolohit-voice-bridge npm run rag:retrieve-preflight
# If retrieve preflight fails with rag_retrieve_timeout:
docker exec technolohit-voice-bridge npm run rag:retrieve-diagnostics
```

**Abort Gate 3 unless every step exits zero and output includes all of:**

```text
compose_runtime_preflight=pass
ownership_pass=true
compose_source_forbidden_by_file=none
compose_project_env_forbidden_keys=none
rag_canary_preflight=pass
runtime_v4=true
v4_live_audiosocket_enabled=true
rag_enabled=true
rag_sales_answerer_enabled=true
rag_health_ok=true
failure_count=0
rag_retrieve_preflight=pass
product_scope=smart_website
hit=true
result_count>0
success_count>=required_success_count
```

If `rag:retrieve-preflight` reports `rag_retrieve_preflight=fail`, **do not place the Gate 3 call**.

Phase 10AE / v1.34.6 makes `rag:retrieve-preflight` resilient to one-off jitter by running
three retrieve attempts at the configured `VOICE_RAG_TIMEOUT_MS`. It still blocks Gate 3 unless
the majority succeeds. Do not compensate for a failed preflight by placing a live call.

| `fallback_reason` | Action |
|-------------------|--------|
| `rag_retrieve_timeout` | Run `npm run rag:retrieve-diagnostics`. If `classification=latency_budget_issue` (passes at 1200 ms, fails at 700 ms), classify as **latency budget issue** — team decides canary `VOICE_RAG_TIMEOUT_MS`. Gate 3 only after preflight passes at chosen budget. |
| `rag_miss` | Fix RAG knowledge ingestion (`result_count=0` at runtime timeout). |
| `wrong_product_scope` | Fix agent/scope config. |
| `rag_unavailable` | Fix RAG API connectivity. |
| `low_score` | Tune content or `VOICE_RAG_MIN_SCORE`. |

v1.34.4 correctly aborted Gate 3 on `rag_retrieve_timeout` (705 ms at 700 ms budget).
Use v1.34.5+ for explicit diagnostics. Gate 3 live failure on v1.34.3 was a separate
fallback issue fixed in 10AC (`call_session_id=c00a2c38-8ff8-43a0-aed8-85cd1d3e441f`).
v1.34.5 diagnostics showed Smart Website retrieval was present and fast across repeated attempts;
use v1.34.6+ for jitter-guarded retrieve preflight.

Also verify the raw runtime env without printing secrets:

```bash
docker exec technolohit-voice-bridge sh -lc \
  'printenv | sort | egrep "^(VOICE_RUNTIME_VERSION|VOICE_V4_REALTIME_ENABLED|VOICE_V4_CANARY_ENABLED|VOICE_V4_LIVE_AUDIOSOCKET_ENABLED|VOICE_V4_LIVE_CANARY_ALLOWLIST|VOICE_RAG_ENABLED|VOICE_RAG_SALES_ANSWERER_ENABLED|VOICE_RAG_API_URL)="'
```

If GitHub Actions deploy is used for Gate 3, set
`verify_v4_rag_canary_env=true` and `verify_v3_qa_env=false`. These two
verifiers intentionally expect opposite RAG states.

Restart:

```bash
cd /opt/technolohit-voice/asterisk
export VOICE_BRIDGE_IMAGE=thnhit/technhvoice:voice-bridge-v1.19.0
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d voice-bridge
sleep 3
docker exec technolohit-voice-bridge sh -lc \
  'printenv | sort | egrep "^(VOICE_RUNTIME_VERSION|VOICE_V4_|VOICE_RAG_|VOICE_V4_TTS_PROVIDER|VOICE_V4_STT_PROVIDER)=" || true'
```

Also verify the host source-of-truth file:

```bash
grep -E '^(VOICE_RUNTIME_VERSION|VOICE_V4_|VOICE_RAG_|VOICE_V4_TTS_PROVIDER|VOICE_V4_STT_PROVIDER)=' \
  /opt/technolohit-voice/voice-bridge/.env
```

---

## E. Live QA scenarios

Use one supervised call for scenarios 2–11 where possible. Mark pass/fail in the report template.

| ID | Scenario | Pass criteria (logs / behavior) |
|----|----------|----------------------------------|
| E1 | Gate 1 v3 baseline | Section A.6 — handler v3, known-product pricing answered, no `[v4-live]`; no barge-in expectation |
| E2 | v4 route selected | `[voice-bridge] call_handler selected=v4_canary` |
| E3 | Greeting heard | Caller hears normal greeting audio (v4 uses `skipAssistant` greeting path) |
| E4 | VAD speech start + endpoint | `[v4-live] vad_speech_started` and `vad_endpoint_detected` |
| E5 | STT completed | `[v4-live] stt_started stt_provider=openai` and `stt_completed stt_provider=openai` (no raw transcript in log line unless `VOICE_ASSISTANT_LOG_TRANSCRIPT_PREVIEW=true`) |
| E5a | Full utterance sent to STT (10K) | For multi-frame utterances, SQL diagnostics on `stt_completed` rows where `payload ? 'pcm_bytes'` show `pcm_bytes` much larger than `320`; `wav_bytes = pcm_bytes + 44`. A one-frame `pcm_bytes=320` with high `utterance_frames` is a fail. |
| E5b | STT failure fallback (10J) | If STT fails: `[v4-live] stt_failed … http_status=…` then `stt_fallback_started` / `stt_fallback_completed`; caller hears short retry prompt — **not** long silence |
| E5c | Goodbye / closing (10M) | After product Q&A, say **Auf Wiederhören** → warm goodbye (no open-ended “anything else?”) |
| E5d | Summary + latency SQL (10M) | G.3 returns `live_call_quality_summary`; G.3b shows `turn_latency_metrics` |
| E5e | Interruption follow-up (10N) | During playback: **Stopp, ich habe eine kurze Frage** → acknowledgement (not “nicht verstanden”); then **Was kostet das?** → bounded playbook answer |
| E5f | Barge-in quality (10N) | G.3c: `barge_in_detected` row present; logs must not show `quality_flush_skip_event` for that type |
| E5g | Interrupt listen window (10P) | After **Stopp** only: logs show `interrupt_followup_waiting` — **no** immediate `dialogue_plan_created` / TTS until continuation or timeout (~2.2s) |
| E5h | Post-interrupt latency (10P) | SQL: `interrupt_followup_latency_metrics` row with non-null `barge_in_detected_to_followup_speech_start_ms` when follow-up completes |
| E5i | Combined Smart Website inquiry (10AB) | Ask **Was ist Smart Website, was macht sie und was kostet sie?** — caller hears definition + value + scoped pricing without truncation; G.3h shows `combined_product_inquiry` |
| E6 | Dialogue plan | `[v4-live] dialogue_plan_created` |
| E7 | OpenAI TTS playback | `[v4-live] tts_completed` + `playback_started`; speech intelligible; no choppy overlap (see `silence_writer_paused` / `silence_writer_resumed`) |
| E8 | Barge-in | During assistant playback, caller speaks; `barge_in_detected`, `playback_cancelled` |
| E9 | Interruption product switch 1 | Say interest in **Digitale Rezeption** / voice agent → barge-in → say **Smart Website** → product updates |
| E10 | Interruption product switch 2 | From **Smart Website** context → barge-in → say **AI Voice Assistant** (alias for Digitale Rezeption product) or explicit switch utterance |
| E11 | Quality flush | `[v4-live] quality_flush_completed inserted_count=` (may be 0 if buffer empty; >0 if events buffered) |
| E12 | SQL summary + close | Rows for `live_call_quality_summary` and `audio_session_closed` for session UUID |
| E13 | Privacy | No `+49…` / long digit runs in `[v4-live]` logs or quality payloads (section G.4) |
| E14 | Restore v3 | Section C env; new call → `call_handler selected=v3` |
| E15 | Phase 10U product-scoped RAG | In Smart Website context, `Was kostet das?`, `Wie funktioniert das?`, `Was kann das?`, and `Erklar mir das kurz.` remain scoped to `smart_website` |
| E16 | Phase 10U interrupted RAG question | During playback say `Stopp. Wie funktioniert das?`; response uses the active product context, not the interrupted assistant topic |
| E17 | Phase 10U RAG failure fallback | If a controlled failure is approved, caller hears a short product answer; no silence, crash, repeated fallback, or unexpected `collect_sales_context` |

### E.18 Three-gate execution order

| Gate | Required result |
|------|-----------------|
| Gate 1 | v3 health/pricing/persistence passes; no barge-in test |
| Gate 2 | v4/RAG-off control call passes E2-E14, including interruption and product context |
| Gate 3 | v4/RAG-on canary passes E15-E17 |

Stop before Gate 3 if Gate 2 is partial, fail, or unsafe.

### E.9 / E.10 utterance hints (German, no phone numbers)

Agent catalog: `voice-bridge/config/agents/technolohit.main_voice_sales.v4.json`

1. **Digitale Rezeption:** e.g. “Ich interessiere mich für die digitale Rezeption.”
2. **Barge-in + Smart Website:** during playback, “Stopp — ich meine Smart Website.”
3. **Barge-in + voice agent / AI Voice Assistant:** during playback, “Stopp — ich meine den AI Voice Assistant.” (maps to product `voice_agent` / Digitale Rezeption)

Do not speak phone numbers during QA.

### E.8 barge-in tip

Wait until assistant is speaking (TTS playback). Speak clearly for ~0.5–1 s (multiple 20 ms frames). Expect cancel within configured `VOICE_V4_BARGE_IN_MIN_PLAYBACK_MS`.

---

## F. Logs to collect (privacy-safe)

During and after the canary call:

```bash
QA_STAMP="$(date -u +%Y%m%dT%H%MZ)"
docker logs --since=30m technolohit-voice-bridge 2>&1 \
  | grep -vEi 'api[_-]?key|password|secret|Bearer |OPENAI_API_KEY' \
  | grep -vE '\+?[0-9]{8,}' \
  | egrep '\[v4-live\]|quality_flush|barge_in|stt_|tts_|playback_|dialogue|call_end|call_handler selected=|silence_writer_|call_finish_persisted|\[voice-runtime\]' \
  > "/tmp/voice-bridge-10h-${QA_STAMP}.log"
wc -l "/tmp/voice-bridge-10h-${QA_STAMP}.log"
```

**Do not** paste full `.env`, API keys, raw transcripts, or assistant text into tickets.

Useful single-call checklist in logs:

| Pattern | Expected |
|---------|----------|
| `call_handler selected=v4_canary` | Once per canary call |
| `[v4-live] call_start handler=v4_canary` | Once |
| `vad_speech_started` / `vad_endpoint_detected` | Per caller turn |
| `stt_started stt_provider=openai` / `stt_completed stt_provider=openai` | Per caller turn (reject mock) |
| `silence_writer_paused` / `silence_writer_resumed` | Around assistant playback |
| `call_finish_persisted` | On hangup/close (session end path) |
| `dialogue_plan_created` | After STT |
| `tts_completed` / `playback_started` | Per assistant reply |
| `barge_in_detected` / `playback_cancelled` | On interruption test |
| `quality_flush_started` / `quality_flush_completed` | On hangup |
| `[v4-live] call_end` | On hangup |

Capture `call_session_id` from log lines (UUID), not caller phone.

---

## G. SQL verification

Use `call_session_id` from section F (UUID). Replace `<CALL_SESSION_ID>` below.

### G.1 Latest v4 quality rows for session

```sql
SELECT
  cqe.created_at,
  cqe.event_type,
  cqe.event_stage,
  cqe.metric_name,
  cqe.metric_value,
  cqe.payload->>'live_phase' AS live_phase,
  cqe.payload->>'runtime_version' AS runtime_version
FROM voice.call_quality_events cqe
WHERE cqe.call_session_id = '<CALL_SESSION_ID>'::uuid
ORDER BY cqe.created_at ASC;
```

### G.2 Event type counts per call

```sql
SELECT event_type, count(*) AS n
FROM voice.call_quality_events
WHERE call_session_id = '<CALL_SESSION_ID>'::uuid
GROUP BY event_type
ORDER BY n DESC;
```

### G.3 Summary event (Phase 10G / 10M — required after canary)

**Pass:** ≥ 1 row with `event_type = 'live_call_quality_summary'`.
If 0 rows but logs show `quality_flush_completed`, check v1.24.0+ (10M UUID validation fix).

```sql
SELECT
  created_at,
  event_type,
  payload->>'live_phase' AS live_phase,
  payload->>'close_reason' AS close_reason,
  payload->'live_counters'->>'endpoint_count' AS endpoint_count,
  payload->'live_counters'->>'stt_completed_count' AS stt_completed_count,
  payload->'live_counters'->>'tts_completed_count' AS tts_completed_count,
  payload->'live_counters'->>'barge_in_count' AS barge_in_count,
  payload->'turn_latency'->>'dialogue_plan_to_tts_started_ms' AS dialogue_plan_to_tts_started_ms,
  payload->'turn_latency'->>'tts_started_to_first_chunk_ms' AS tts_started_to_first_chunk_ms,
  payload->'turn_latency'->>'endpoint_to_first_playback_ms' AS endpoint_to_first_playback_ms,
  payload->'turn_latency'->>'total_turn_response_ms' AS total_turn_response_ms
FROM voice.call_quality_events
WHERE call_session_id = '<CALL_SESSION_ID>'::uuid
  AND event_type = 'live_call_quality_summary';
```

**Pass (10N):** On a successful STT→dialogue→TTS→playback turn, `dialogue_plan_to_tts_started_ms`, `tts_started_to_first_chunk_ms`, and `endpoint_to_first_playback_ms` should be **non-NULL**.

### G.3b Turn latency metrics (Phase 10M)

```sql
SELECT
  created_at,
  metric_value AS total_turn_response_ms,
  payload->>'endpoint_to_stt_completed_ms' AS endpoint_to_stt_completed_ms,
  payload->>'stt_completed_to_dialogue_plan_ms' AS stt_completed_to_dialogue_plan_ms,
  payload->>'dialogue_plan_to_tts_started_ms' AS dialogue_plan_to_tts_started_ms,
  payload->>'tts_started_to_first_chunk_ms' AS tts_started_to_first_chunk_ms,
  payload->>'endpoint_to_first_playback_ms' AS endpoint_to_first_playback_ms
FROM voice.call_quality_events
WHERE call_session_id = '<CALL_SESSION_ID>'::uuid
  AND event_type = 'turn_latency_metrics'
ORDER BY created_at DESC
LIMIT 5;
```

### G.3c Barge-in detected (Phase 10N)

```sql
SELECT created_at, event_type, metric_value AS cancel_latency_ms
FROM voice.call_quality_events
WHERE call_session_id = '<CALL_SESSION_ID>'::uuid
  AND event_type = 'barge_in_detected'
ORDER BY created_at;
```

**Pass:** ≥ 1 row when caller interrupted assistant playback. **Fail:** 0 rows but logs show `barge_in_detected` or `quality_flush_skip_event event_type=barge_in_detected` (upgrade to v1.25.0+).

### G.3d Interrupt follow-up latency (Phase 10P / 10Q)

```sql
SELECT
  created_at,
  event_type,
  payload->>'single_stop_detected',
  payload->>'marker_only',
  payload->>'stop_to_cancel_ms',
  payload->>'stop_to_wait_window_ms',
  payload->>'wait_window_to_continuation_ms',
  payload->>'barge_in_detected_to_playback_cancelled_ms' AS cancel_ms,
  payload->>'continuation_speech_started_ms',
  payload->>'followup_plan_to_first_playback_ms' AS plan_to_playback_ms
FROM voice.call_quality_events
WHERE call_session_id = '<CALL_SESSION_ID>'::uuid
  AND event_type IN (
    'interrupt_followup_started',
    'interrupt_followup_waiting',
    'interrupt_followup_continuation_received',
    'interrupt_followup_timeout',
    'interrupt_followup_latency_metrics'
  )
ORDER BY created_at DESC
LIMIT 10;
```

**Pass:** After a single “Stopp” during assistant speech: `interrupt_followup_started` + `interrupt_followup_waiting` with `single_stop_detected=true`; no immediate TTS; continuation or timeout event follows. **Fail:** Caller must repeat Stop/Stopp (pre-10Q) or no follow-up events after barge-in.

### G.3e Repeated / nested interruption (Phase 10R)

During one canary call, run this sequence on **v1.28.0+**:

1. Let assistant explain **Digitale Rezeption** → say **“Stopp”** once → wait → ask **“Was kostet das?”** → confirm pricing answer (no second stop).
2. Say **“Stopp, ich meine Smart Website”** → confirm product switch → ask **“Was kostet das?”** again → confirm pricing scoped to **Smart Website** (not voice_agent).
3. Interrupt again mid-explanation with **“Stopp”** only → confirm playback cancels and assistant stays silent until you continue or timeout.

```sql
SELECT event_type,
       payload->>'single_stop_detected',
       payload->>'marker_only',
       payload->>'matched_product',
       payload->>'current_product_context'
FROM voice.call_quality_events
WHERE call_session_id = '<CALL_SESSION_ID>'::uuid
  AND event_type IN (
    'interrupt_followup_started',
    'interrupt_followup_waiting',
    'interrupt_followup_continuation_received',
    'interrupt_followup_timeout',
    'turn_started'
  )
ORDER BY created_at;
```

**Pass:** After switch to `smart_website`, `response_plan_created.response_type=product_question_answer` for generic follow-ups; `current_product_context=smart_website` on `turn_started` / `response_plan_created`; stable `interrupt_sequence_id` across follow-up events.

### G.3f Post-interruption product context (Phase 10S)

After interrupt switch to Smart Website, ask **“Was kostet das?”** and **“Wie funktioniert das?”** without naming the product again.

```sql
SELECT event_type,
       payload->>'interrupt_sequence_id',
       payload->>'current_product_context',
       payload->>'previous_product_context',
       payload->>'response_type',
       payload->>'plan_reason'
FROM voice.call_quality_events
WHERE call_session_id = '<CALL_SESSION_ID>'::uuid
  AND event_type IN ('response_plan_created', 'turn_started', 'interrupt_followup_continuation_received')
ORDER BY created_at DESC
LIMIT 15;
```

**Pass:** `current_product_context=smart_website`; no `fallback_clarification` / `collect_sales_context` for generic product questions unless caller starts sales/contact flow.

### G.3g First product-selection response (Phase 10X)

For Gate 2, start a fresh call with one of these opening variants:

- `Hallo, ich interessiere mich für die Smart Website.`
- `Hallo, ich interessiere mich für die Smart-Webseite.`
- `Ich interessiere mich für die smarte Webseite.`

The first product-selection response must introduce or answer the known product.
It must not immediately enter sales qualification.

```sql
WITH first_product_selection AS (
  SELECT created_at,
         payload->>'response_type' AS response_type,
         payload->>'plan_reason' AS plan_reason,
         payload->>'current_product_context' AS current_product_context,
         payload->>'matched_product' AS matched_product
  FROM voice.call_quality_events
  WHERE call_session_id = '<CALL_SESSION_ID>'::uuid
    AND event_type = 'response_plan_created'
    AND payload->>'matched_product' = 'smart_website'
  ORDER BY created_at
  LIMIT 1
)
SELECT *
FROM first_product_selection
WHERE response_type IN ('fallback_clarification', 'collect_sales_context')
   OR current_product_context IS DISTINCT FROM 'smart_website'
   OR plan_reason IS DISTINCT FROM 'product_selection_intro';
```

**Pass:** query returns `0 rows`. The corresponding first product response has
`response_type=product_question_answer`,
`current_product_context=smart_website`, and
`plan_reason=product_selection_intro`.

**Fail:** any first product-selection response is `fallback_clarification` or
`collect_sales_context`. Stop before Gate 3.

### G.3h Combined Smart Website inquiry (Phase 10AB)

During Gate 2, ask one combined product question in a single turn. Use any variant:

- `Was ist Smart Website, was macht sie und was kostet sie?`
- `Was ist die Smart-Webseite und was kostet sie?`
- `Was macht die smarte Webseite und wie viel kostet das?`

**Live functional pass:** caller hears (without truncation) Smart Website definition,
customer value, and scope-based pricing. No immediate Neukunde / sales qualification.

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

**Pass:** combined-inquiry turn shows
`response_type=product_question_answer`,
`plan_reason=combined_product_inquiry`,
`current_product_context=smart_website`.

**Fail (must return 0 rows for combined turn):**

```sql
SELECT created_at, payload->>'response_type', payload->>'plan_reason'
FROM voice.call_quality_events
WHERE call_session_id = '<CALL_SESSION_ID>'::uuid
  AND event_type = 'response_plan_created'
  AND payload->>'response_type' = 'collect_sales_context';
```

Post-call summary remains required on v1.34.1+:

```sql
SELECT COUNT(*) FROM voice.call_summaries WHERE call_session_id = '<CALL_SESSION_ID>'::uuid;
SELECT event_type FROM voice.call_events
WHERE call_session_id = '<CALL_SESSION_ID>'::uuid AND event_type = 'post_call_summary_created';
```

### G.3i Gate 3 combined inquiry with RAG fallback (Phase 10AC)

During Gate 3, use the same combined Smart Website utterance as G.3h. If RAG retrieval
misses (`rag_retrieval_failed`, `fallback_reason=rag_miss`), the caller must still hear
definition + value + scope-based pricing via playbook fallback — not generic explanation only.

**Preflight (required before call):**

```bash
docker exec technolohit-voice-bridge npm run rag:retrieve-preflight
```

Abort if `rag_retrieve_preflight=fail` or `result_count=0`.

```sql
SELECT created_at, event_type,
       payload->>'fallback_reason' AS fallback_reason,
       payload->>'rag_result_count' AS rag_result_count,
       payload->>'rag_product_scope' AS rag_product_scope,
       payload->>'rag_used' AS rag_used,
       payload->>'rag_fallback_used' AS rag_fallback_used,
       payload->>'plan_reason' AS plan_reason,
       payload->>'response_type' AS response_type
FROM voice.call_quality_events
WHERE call_session_id = '<CALL_SESSION_ID>'::uuid
  AND event_type IN ('rag_retrieval_failed', 'rag_retrieval_completed', 'response_plan_created')
ORDER BY created_at;
```

**Pass on RAG miss (v1.34.4+):** `rag_fallback_used=true`, `plan_reason=combined_product_inquiry`,
caller hears pricing language; no `collect_sales_context` on combined turn.

**Pass on RAG hit:** `rag_used=true`, `rag_product_scope=smart_website`, scoped answer heard.

**Phase 10AF / v1.34.7+ live timeout retry:** If the first live retrieve attempt hits the
700 ms boundary, the v4 live path retries once on `timeout` only. A successful retry should
produce `rag_retrieval_completed` with `rag_attempt_count=2`, `rag_timeout_count=1`,
and `rag_attempt_fallback_reasons` containing `timeout`. Do not classify Gate 3 as full
RAG pass unless the live call has `rag_retrieval_completed` / `rag_used=true`.

### G.4 Session close + privacy-oriented payload scan

```sql
SELECT event_type, created_at
FROM voice.call_quality_events
WHERE call_session_id = '<CALL_SESSION_ID>'::uuid
  AND event_type IN ('audio_session_closed', 'live_call_quality_summary');
```

**Privacy scan note (Phase 10N / v1.25.0, updated 10R):** A naive `payload::text ~ '\+?\d{8,}'` scan can **false-positive** on telemetry-only numeric fields (RMS, frame counters, **interrupt timing epoch-ms fields**). Those are not caller phone numbers. Use the corrected query below: exclude known telemetry keys for `barge_in_detected` and interrupt-followup events (and version metadata), but still fail on phone-like patterns in **string** transcript/email/phone fields.

```sql
-- Legacy broad scan (may false-positive on telemetry numerics — do not use alone after v1.25.0).
-- SELECT id, event_type FROM voice.call_quality_events
-- WHERE call_session_id = '<CALL_SESSION_ID>'::uuid
--   AND (payload - 'runtime_version' - 'agent_config_version'
--        - 'prompt_playbook_version' - 'knowledge_version')::text ~ '\+?\d{8,}';
```

```sql
-- Corrected privacy scan: exclude version metadata + barge-in / interrupt timing telemetry.
-- Still scans all remaining payload text (transcript/email/phone/string fields remain strict).
SELECT id, event_type, created_at
FROM voice.call_quality_events
WHERE call_session_id = '<CALL_SESSION_ID>'::uuid
  AND (
    payload
      - 'runtime_version'
      - 'agent_config_version'
      - 'prompt_playbook_version'
      - 'knowledge_version'
      - 'last_rms'
      - 'rms_threshold'
      - 'playback_ms_at_trigger'
      - 'min_playback_ms'
      - 'speech_frames_required'
      - 'consecutive_speech_frames'
      - 'frames_sent_before_cancel'
      - 'trigger_count'
      - 'triggered_at'
      - 'stop_detected_ms'
      - 'playback_cancelled_ms'
      - 'wait_window_started_ms'
      - 'continuation_endpoint_ms'
      - 'continuation_speech_started_ms'
      - 'stop_to_cancel_ms'
      - 'stop_to_wait_window_ms'
      - 'wait_window_to_continuation_ms'
      - 'followup_stt_completed_to_plan_ms'
      - 'followup_plan_to_first_playback_ms'
      - 'followup_endpoint_to_stt_completed_ms'
      - 'barge_in_detected_to_playback_cancelled_ms'
      - 'barge_in_detected_to_followup_speech_start_ms'
      - 'interrupt_sequence_id'
      - 'parent_single_stop_detected'
      - 'plan_reason'
      - 'current_product_context'
      - 'previous_product_context'
      - 'matched_product'
      - 'bridge_call_id'
      - 'call_session_id'
      - 'external_call_id'
      - 'audiosocket_uuid'
  )::text ~ '\+?\d{8,}';
```

**Pass:** zero rows on corrected G.4 scan; summary + close rows present when flush ran with events.

**Manual review if legacy scan was used:** If the only matches are `barge_in_detected` rows and fields are telemetry-only (see list above), treat as **pass** after v1.25.0 — re-run corrected query to confirm.

### G.5 Failed flush / runtime errors (if suspected)

```sql
SELECT created_at, event_type, payload->>'error_class' AS error_class, payload->>'event_subtype' AS subtype
FROM voice.call_quality_events
WHERE call_session_id = '<CALL_SESSION_ID>'::uuid
  AND event_type = 'runtime_error'
ORDER BY created_at;
```

### G.6 STT failure diagnostics (Phase 10J)

```sql
SELECT
  created_at,
  metric_value AS stt_ms,
  payload->>'stt_provider' AS stt_provider,
  payload->>'stt_error_code' AS stt_error_code,
  payload->>'stt_http_status' AS stt_http_status,
  payload->>'stt_error_type' AS stt_error_type,
  payload->>'pcm_bytes' AS pcm_bytes,
  payload->>'wav_bytes' AS wav_bytes,
  payload->>'utterance_frames' AS utterance_frames,
  payload->>'utterance_duration_ms' AS utterance_duration_ms,
  payload->>'stt_failed_fallback_prompted' AS fallback_prompted,
  payload->>'event_subtype' AS event_subtype
FROM voice.call_quality_events
WHERE call_session_id = '<CALL_SESSION_ID>'::uuid
  AND event_type = 'runtime_error'
  AND payload->>'error_class' = 'stt_failed'
ORDER BY created_at;
```

**Pass:** rows explain failure (HTTP status / error code / byte counts). **No** transcript or API key in payload text.

### G.7 Successful STT buffer metrics (Phase 10K)

```sql
SELECT
  created_at,
  metric_value AS stt_ms,
  payload->>'stt_provider' AS stt_provider,
  payload->>'stt_http_status' AS stt_http_status,
  payload->>'utterance_frames' AS utterance_frames,
  payload->>'pcm_bytes' AS pcm_bytes,
  payload->>'wav_bytes' AS wav_bytes,
  payload->>'wav_bytes_minus_pcm_bytes' AS wav_bytes_minus_pcm_bytes,
  payload->>'sample_rate' AS sample_rate,
  payload->>'utterance_duration_ms' AS utterance_duration_ms
FROM voice.call_quality_events
WHERE call_session_id = '<CALL_SESSION_ID>'::uuid
  AND event_type = 'stt_completed'
  AND payload ? 'pcm_bytes'
ORDER BY created_at;
```

**Pass:** for normal multi-frame utterances, `pcm_bytes > 320`, `wav_bytes = pcm_bytes + 44`, `wav_bytes_minus_pcm_bytes = 44`, and `stt_http_status` is 2xx. **Fail:** high `utterance_frames` with `pcm_bytes=320`.

### G.8 RAG retrieval evidence (Phase 10U)

```sql
SELECT
  created_at,
  event_type,
  metric_value AS rag_latency_ms,
  payload->>'rag_enabled' AS rag_enabled,
  payload->>'rag_sales_answerer_enabled' AS rag_sales_answerer_enabled,
  payload->>'rag_product_scope' AS rag_product_scope,
  payload->>'rag_result_count' AS rag_result_count,
  payload->>'used_rag' AS used_rag,
  payload->>'rag_fallback_used' AS rag_fallback_used,
  payload->>'fallback_reason' AS fallback_reason,
  payload->>'rag_attempt_count' AS rag_attempt_count,
  payload->>'rag_success_count' AS rag_success_count,
  payload->>'rag_timeout_count' AS rag_timeout_count,
  payload->>'rag_attempt_fallback_reasons' AS rag_attempt_fallback_reasons,
  payload->>'rag_total_latency_ms' AS rag_total_latency_ms
FROM voice.call_quality_events
WHERE call_session_id = '<CALL_SESSION_ID>'::uuid
  AND event_type IN ('rag_retrieval_started', 'rag_retrieval_completed', 'rag_retrieval_failed')
ORDER BY created_at;
```

**Pass:** product scope matches the active product, completed rows have bounded latency, and failed rows use a safe fallback. For Gate 3 RAG-on acceptance, at least one live turn must show `rag_retrieval_completed`, `used_rag=true`, and `rag_result_count > 0`. Payloads must not contain raw query or transcript text.

### G.9 Response-plan RAG evidence (Phase 10U)

```sql
SELECT
  created_at,
  payload->>'response_type' AS response_type,
  payload->>'plan_reason' AS plan_reason,
  payload->>'current_product_context' AS current_product_context,
  payload->>'previous_product_context' AS previous_product_context,
  payload->>'rag_product_scope' AS rag_product_scope,
  payload->>'rag_used' AS rag_used,
  payload->>'rag_fallback_used' AS rag_fallback_used,
  payload->>'interrupt_sequence_id' AS interrupt_sequence_id
FROM voice.call_quality_events
WHERE call_session_id = '<CALL_SESSION_ID>'::uuid
  AND event_type = 'response_plan_created'
ORDER BY created_at;
```

**Pass:** `current_product_context` and `rag_product_scope` agree; `rag_used` reflects actual retrieval use; fallback plans set `rag_fallback_used=true`.

### G.10 Minimal all-live-call runtime evidence (Phase 10V)

```sql
SELECT
  created_at,
  event_type,
  payload->>'runtime_selected' AS runtime_selected,
  payload->>'handler_selected' AS handler_selected,
  payload->>'response_type' AS response_type,
  payload->>'response_template' AS response_template,
  payload->>'current_product_context' AS current_product_context,
  payload->>'close_reason' AS close_reason,
  payload->'counters' AS counters
FROM voice.call_quality_events
WHERE call_session_id = '<CALL_SESSION_ID>'::uuid
  AND event_type IN ('live_runtime_selected', 'live_response_created', 'live_runtime_summary')
ORDER BY created_at;
```

**Gate 1 pass:** v3 runtime/handler rows exist, pricing response type/template is visible, summary close reason exists, and no raw transcript, assistant text, phone, email, RAG query, or lead details appear in payloads.

See also [voice_assistant_v4_phase8_quality_analytics_queries.sql](./voice_assistant_v4_phase8_quality_analytics_queries.sql) (live summary query at end).

---

## H. Stop criteria (rollback immediately)

Stop the window and run section I if **any** occur:

| # | Condition |
|---|-----------|
| H1 | Call drops / silent line / no greeting |
| H2 | Garbled or unusable assistant audio |
| H3 | Assistant does not stop speaking after caller interruption (barge-in) |
| H4 | Repeated `[v4-live] stt_failed` without `stt_fallback_completed` (caller hears long silence) |
| H5 | Repeated `[v4-live] tts_failed` / no playback |
| H6 | `quality_flush_failed` with `relation` / missing table **after** migration 009 was verified |
| H7 | Raw phone pattern in `[v4-live]` logs or SQL payload scan (G.4) |
| H8 | `call_handler selected=v4_canary` on a call **outside** maintenance / wrong allowlist |
| H9 | v3 baseline (E14) fails after rollback |
| H10 | Unexpected concurrent production traffic while `bridge:` allowlist active |
| H11 | RAG returns or speaks content for the wrong product scope |
| H12 | RAG failure causes long silence, crash, repeated fallback loop, or unexpected sales-context collection |
| H13 | Raw RAG query, transcript, phone, email, or lead details appear in logs or quality payloads |

---

## I. Rollback commands (restore v3)

### I.0 Collect v4 logs before rollback (when possible)

Before reverting env, capture privacy-safe canary logs for post-mortem:

```bash
QA_STAMP="$(date -u +%Y%m%dT%H%MZ)"
docker logs --since=45m technolohit-voice-bridge 2>&1 \
  | grep -vEi 'api[_-]?key|password|secret|Bearer |OPENAI_API_KEY' \
  | grep -vE '\+?[0-9]{8,}' \
  | egrep '\[v4-live\]|stt_|tts_|call_finish_|active_call_|openai_stt_preflight' \
  > "/tmp/voice-bridge-10h-${QA_STAMP}-pre-rollback.log"
wc -l "/tmp/voice-bridge-10h-${QA_STAMP}-pre-rollback.log"
```

Then run section I.1–I.3.

### I.1 Restore env from backup

```bash
ls -lt /opt/technolohit-voice/voice-bridge/.env.pre-10h-*.bak | head -3
cp /opt/technolohit-voice/voice-bridge/.env.pre-10h-<STAMP>.bak \
  /opt/technolohit-voice/voice-bridge/.env
```

Or hand-edit to section C values (especially `VOICE_RUNTIME_VERSION=v3`, empty allowlist, `VOICE_V4_TTS_PROVIDER=mock`).

### I.2 Restart voice-bridge (immutable image — no `latest`)

```bash
cd /opt/technolohit-voice/asterisk
export VOICE_BRIDGE_IMAGE=thnhit/technhvoice:voice-bridge-v1.19.0
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d voice-bridge
sleep 3
docker inspect technolohit-voice-bridge --format 'running_image={{.Config.Image}}'
docker logs --tail=20 technolohit-voice-bridge 2>&1 | grep -E 'voice-runtime|voice-bridge'
```

### I.3 Verify v3 on host env

```bash
grep -E '^(VOICE_RUNTIME_VERSION|VOICE_V4_LIVE_AUDIOSOCKET_ENABLED|VOICE_V4_LIVE_CANARY_ALLOWLIST|VOICE_V4_TTS_PROVIDER)=' \
  /opt/technolohit-voice/voice-bridge/.env
```

**Expected:** `VOICE_RUNTIME_VERSION=v3`, live gates false, allowlist empty, `VOICE_V4_TTS_PROVIDER=mock`.

### I.4 Optional — rollback image only (if v1.19.0 faulty)

```bash
export VOICE_BRIDGE_IMAGE=thnhit/technhvoice:voice-bridge-v1.11.0
docker compose -f docker-compose.yml -f docker-compose.prod.yml pull voice-bridge
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d voice-bridge
```

Keep section C v3 flags regardless of image tag.

### I.5 Post-rollback v3 call

Repeat section A.6 / scenario E14. **Must pass** before closing the ticket.

---

## J. Sysadmin report

Copy [voice_assistant_v4_phase10h_live_qa_report.md](./voice_assistant_v4_phase10h_live_qa_report.md) into the ticket when complete.

---

## Phase references (10A–10G)

| Phase | Report |
|-------|--------|
| 10A | [voice_assistant_v4_phase10a_live_route_selection_report.md](./voice_assistant_v4_phase10a_live_route_selection_report.md) |
| 10B | [voice_assistant_v4_phase10b_vad_endpointing_report.md](./voice_assistant_v4_phase10b_vad_endpointing_report.md) |
| 10C | [voice_assistant_v4_phase10c_live_stt_report.md](./voice_assistant_v4_phase10c_live_stt_report.md) |
| 10D | [voice_assistant_v4_phase10d_live_dialogue_report.md](./voice_assistant_v4_phase10d_live_dialogue_report.md) |
| 10E | [voice_assistant_v4_phase10e_live_tts_playback_report.md](./voice_assistant_v4_phase10e_live_tts_playback_report.md) |
| 10E2 | [voice_assistant_v4_phase10e2_real_tts_report.md](./voice_assistant_v4_phase10e2_real_tts_report.md) |
| 10F | [voice_assistant_v4_phase10f_live_barge_in_report.md](./voice_assistant_v4_phase10f_live_barge_in_report.md) |
| 10G | [voice_assistant_v4_phase10g_quality_flush_report.md](./voice_assistant_v4_phase10g_quality_flush_report.md) |

---

## Production v4 status after 10H

| Outcome | Meaning |
|---------|---------|
| **pass** | Supervised canary path validated; **still** not production v4 for all calls |
| **partial** | Some scenarios failed; keep v3; open engineering ticket |
| **fail** | Do not retry without fix; v3 rollback required |
| **unsafe** | Privacy or routing safety failure; stop immediately |

Production v4 GA remains blocked until: live QA pass, production blocker list in blueprint, and explicit leadership approval for Phase 9c.
