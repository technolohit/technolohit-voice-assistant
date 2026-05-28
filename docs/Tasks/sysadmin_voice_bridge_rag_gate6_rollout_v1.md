# Sysadmin Runbook: Voice-Bridge RAG Gate 6 Rollout v1

Date: 2026-05-22

## 1) Gate 6 Objective

Gate 6 is a **production-safe controlled rollout** of optional voice-bridge RAG fallback.

It is **not** a generic feature flag flip. It must preserve:

- deterministic-first routing
- fail-closed behavior when RAG is slow/unavailable
- privacy-safe logging defaults
- fast rollback

Gate 5 remains the recurring regression lane after this rollout.

## 2) Production / QA Candidate Images (Pinned)

**Gate 6 status:** rollout QA in progress — **not stable** until runtime evidence in section 6.1 passes.

**Strategy pivot (2026-05-22 evening):**
- v12 is **not stable**; complex per-product conversational state loops are too fragile for voice channel QA.
- v14 fixed pitch + interest question in one segment, but **v14 is not stable**: after `Ja`, the handoff question (`E-Mail`/`Telefon`) was dropped by the response limiter (3 sentence segments, `maxResponseSentences=2`).
- v15 fixed product-intake handoff sync; **v15 is not stable**: after permission granted, the final closing question was dropped by the same limiter pattern.
- v16 fixed permission final question + protected-tail checks; **v16 is not stable**: incomplete post-completion questions closed too aggressively; email path must use configured `VOICE_CONTACT_EMAIL`.
- v17 fixed closing guard + email contact path; **v17 core flow is stable** (pitch, handoff, phone, permission, follow-up prompt, incomplete guard) but **v17 is not stable for Gate 6**: out-of-flow business questions after lead capture still misrouted (company-name hint / generic clarification instead of deterministic business fallback).
- v18 added deterministic business fallback after lead capture; **v18 is not stable**: responses still too consultative, contact-form not deterministic in all contexts, clear close (`Danke. Tschüss.`) could hit acoustic clarification, website/email guidance inconsistent.
- v19 simplifies business fallback: brief answer + website/contact-form guidance + final close question; works in general conversation and post-capture; clear close always wins.
- v20 adds text QA harness support (`processTextTurn`), business fallback in `closing_pending`, URL-safe response assembly; use text QA before live-call iteration.
- v21 packages `scripts/qa-dialogue-text.js` into the runtime image at `/app/scripts/` (v20 image omitted `COPY scripts`).
- Gate 6 product handling uses **template-driven "Intelligent Receptionist + Lightweight Product Intake"** with protected mandatory-tail assembly.
- Voice agent scope is short product pitch + interest question + handoff choice (`E-Mail` or `Telefon`) + minimal contact capture.
- RAG remains optional support, not a hard runtime dependency for product pitch/routing.

- voice-bridge (current Gate 6 QA candidate):
  - `thnhit/technhvoice:voice-bridge-gate6-text-qa-harness-v21-20260523-0200`
  - `sha256:32ae118f2efed211e4cece592f1eddd9ca86686611dcac93c0a5ef0104c52742`
- voice-bridge rollback (previous Gate 6 QA candidate — harness missing from image):
  - `thnhit/technhvoice:voice-bridge-gate6-text-qa-harness-v21-20260523-0200`
  - `sha256:10a322770408141694416272942e917da6c8fc28031da92b116b66901f36bfd9`
- voice-bridge rollback (business fallback v19):
  - `thnhit/technhvoice:voice-bridge-gate6-business-fallback-v19-20260522-2330`
  - `sha256:d539218a7384d54af9af292d3160d8706de756d327478c3e54f8d0e602480665`
- voice-bridge rollback (business fallback v18):
  - `thnhit/technhvoice:voice-bridge-gate6-business-fallback-v18-20260522-2300`
  - `sha256:8edcee5c3db28177746ee1f729cf04f40a6230f72ba7c9be42232d317bd09796`
- voice-bridge rollback (stable core flow, weak post-capture business Q&A):
  - `thnhit/technhvoice:voice-bridge-gate6-closing-guard-email-contact-v17-20260522-2200`
  - `sha256:ffc3d9b768a3934023d967d0581cbd2900998998fd4d84cbcb3e7d7fff3e0290`
- voice-bridge rollback (older):
  - `thnhit/technhvoice:voice-bridge-gate6-permission-final-question-v16-20260522-2130`
  - `sha256:13b1c5425d5d1abfd6ff53d14d78c2336d3bb9c43ae9e5900bc4e8411eb974bf`
  - (v16: product intake + permission final question OK; incomplete follow-up closed too early)
- rag-api:
  - `thnhit/technhvoice:rag-api-gate5-semantic-lokalki-hotfix-v5-20260522-1212`
  - `sha256:f41f1fcbb98a436ea3a105e853e217511e0a2c090b2ac420a4edde8824a8de0a`

## 3) Compose Reality Check (Verified From Repo)

Verified in repo:

- `asterisk/docker-compose.prod.yml` defines:
  - `voice-bridge.image: ${VOICE_BRIDGE_IMAGE:-...}`
- repo does **not** include `asterisk/docker-compose.yml` base file
- repo does **not** define `technolohit-rag-api` service in tracked compose files
- repo does **not** consume `RAG_API_IMAGE` by default

Implication:

- `VOICE_BRIDGE_IMAGE` is consumed by repo-tracked compose override
- `RAG_API_IMAGE` requires either:
  1) server-side base compose that already defines `technolohit-rag-api`, or
  2) an explicit Gate 6 override compose file (recommended below)

### Recommended explicit Gate 6 override (to avoid assumptions)

Create `docker-compose.gate6-rollout.yml` on server:

```yaml
services:
  voice-bridge:
    image: ${VOICE_BRIDGE_IMAGE}
    environment:
      VOICE_RAG_ENABLED: "true"
      VOICE_RAG_API_URL: "http://127.0.0.1:8080"
      VOICE_RAG_TIMEOUT_MS: "700"
      VOICE_RAG_MIN_SCORE: "0.72"
      VOICE_RAG_QA_MODE: "false"
      VOICE_LOG_TRANSCRIPT_PREVIEW: "false"
      VOICE_QA_LOG_TRANSCRIPT_PREVIEW: "false"
      VOICE_CONTACT_EMAIL: "${VOICE_CONTACT_EMAIL}"
      VOICE_WEBSITE_URL: "${VOICE_WEBSITE_URL}"

  technolohit-rag-api:
    image: ${RAG_API_IMAGE}
    container_name: technolohit-rag-api
    restart: unless-stopped
    env_file:
      - .env
    environment:
      RAG_SEMANTIC_PRODUCT_BOOST: "${RAG_SEMANTIC_PRODUCT_BOOST}"
      RAG_RETRIEVE_CANDIDATE_LIMIT: "${RAG_RETRIEVE_CANDIDATE_LIMIT}"
      RAG_SEMANTIC_PRODUCT_ACCEPT_FLOOR: "${RAG_SEMANTIC_PRODUCT_ACCEPT_FLOOR}"
      RAG_DEFAULT_MIN_SCORE: "${RAG_DEFAULT_MIN_SCORE}"
    ports:
      - "127.0.0.1:8080:8080"
```

Validate merged compose before rollout:

```bash
docker compose \
  -f docker-compose.yml \
  -f docker-compose.prod.yml \
  -f docker-compose.gate6-rollout.yml \
  config > /tmp/gate6-merged-compose.yml
```

Optional server-side verification of effective services/images:

```bash
docker compose \
  -f docker-compose.yml \
  -f docker-compose.prod.yml \
  -f docker-compose.gate6-rollout.yml \
  config --services

docker compose \
  -f docker-compose.yml \
  -f docker-compose.prod.yml \
  -f docker-compose.gate6-rollout.yml \
  config | egrep -i 'voice-bridge|technolohit-rag-api|image:'
```

## 4) Final Preflight Checklist (Must Pass Before Enablement)

**Hard deployment validity rule:** a deployment is **not valid** until `docker inspect` confirms the running container image exactly matches the expected image tag.

**Hard deployment path rule:** for normal dev/QA and rollout image changes, use `scripts/deploy-voice-bridge-image.sh` and `scripts/deploy-rag-api-image.sh`. Manual `export` / `sed` / `docker compose` deploy flows are fallback-only because shell env precedence previously caused repeated false QA results.

### Step-by-step execution order (must follow)

1. Sync `.env` and create/verify `docker-compose.gate6-rollout.yml`
   - **Required for email path QA:** set `VOICE_CONTACT_EMAIL=info@technolohit.com` in server `.env` (voice-bridge reads this at runtime; do not invent addresses in code when missing).
2. Pull candidate images
3. Verify merged compose config
4. Recreate target containers and verify actual running images
5. Run preflight checks

Only then discuss controlled enablement window.

## 4.1) Primary Deploy Path (Use Helpers First)

Use this as the default path for all image tag changes:

```bash
cd /opt/technolohit-voice/asterisk
chmod +x scripts/deploy-voice-bridge-image.sh scripts/deploy-rag-api-image.sh

./scripts/deploy-rag-api-image.sh \
  thnhit/technhvoice:rag-api-gate5-semantic-lokalki-hotfix-v5-20260522-1212

./scripts/deploy-voice-bridge-image.sh \
  thnhit/technhvoice:voice-bridge-gate6-text-qa-harness-v21-20260523-0200
```

Each helper enforces:

- `.env` backup before modification
- idempotent `.env` image key update
- compose render with `env -u VOICE_BRIDGE_IMAGE -u RAG_API_IMAGE`
- expected image match in merged compose
- `docker inspect` running-image verification (non-zero exit on mismatch)
- runtime env print from inside target container

Any future QA instruction that changes image tags must run helper deployment first, then continue QA checks.

## 4.2) Manual Fallback / Emergency Path Only (Discouraged)

Use this section only if helper scripts are temporarily unavailable or need debugging.

```bash
cd /opt/technolohit-voice/asterisk

# 1) Idempotently set pinned candidate images and RAG policy envs
# (replace existing keys instead of appending duplicates)
sed -i 's|^VOICE_BRIDGE_IMAGE=.*|VOICE_BRIDGE_IMAGE=thnhit/technhvoice:voice-bridge-gate6-text-qa-harness-v21-20260523-0200|' .env || true
sed -i 's|^RAG_API_IMAGE=.*|RAG_API_IMAGE=thnhit/technhvoice:rag-api-gate5-semantic-lokalki-hotfix-v5-20260522-1212|' .env || true
sed -i 's|^RAG_SEMANTIC_PRODUCT_BOOST=.*|RAG_SEMANTIC_PRODUCT_BOOST=0.12|' .env || true
sed -i 's|^RAG_RETRIEVE_CANDIDATE_LIMIT=.*|RAG_RETRIEVE_CANDIDATE_LIMIT=12|' .env || true
sed -i 's|^RAG_SEMANTIC_PRODUCT_ACCEPT_FLOOR=.*|RAG_SEMANTIC_PRODUCT_ACCEPT_FLOOR=0.66|' .env || true
sed -i 's|^RAG_DEFAULT_MIN_SCORE=.*|RAG_DEFAULT_MIN_SCORE=0.72|' .env || true
sed -i 's|^VOICE_RAG_API_URL=.*|VOICE_RAG_API_URL=http://127.0.0.1:8080|' .env || true
if ! grep -q '^VOICE_BRIDGE_IMAGE=' .env; then echo 'VOICE_BRIDGE_IMAGE=thnhit/technhvoice:voice-bridge-gate6-text-qa-harness-v21-20260523-0200' >> .env; fi
if ! grep -q '^RAG_API_IMAGE=' .env; then echo 'RAG_API_IMAGE=thnhit/technhvoice:rag-api-gate5-semantic-lokalki-hotfix-v5-20260522-1212' >> .env; fi
if ! grep -q '^RAG_SEMANTIC_PRODUCT_BOOST=' .env; then echo 'RAG_SEMANTIC_PRODUCT_BOOST=0.12' >> .env; fi
if ! grep -q '^RAG_RETRIEVE_CANDIDATE_LIMIT=' .env; then echo 'RAG_RETRIEVE_CANDIDATE_LIMIT=12' >> .env; fi
if ! grep -q '^RAG_SEMANTIC_PRODUCT_ACCEPT_FLOOR=' .env; then echo 'RAG_SEMANTIC_PRODUCT_ACCEPT_FLOOR=0.66' >> .env; fi
if ! grep -q '^RAG_DEFAULT_MIN_SCORE=' .env; then echo 'RAG_DEFAULT_MIN_SCORE=0.72' >> .env; fi
if ! grep -q '^VOICE_RAG_API_URL=' .env; then echo 'VOICE_RAG_API_URL=http://127.0.0.1:8080' >> .env; fi
if ! grep -q '^VOICE_CONTACT_EMAIL=' .env; then echo 'VOICE_CONTACT_EMAIL=info@technolohit.com' >> .env; fi
if ! grep -q '^VOICE_WEBSITE_URL=' .env; then echo 'VOICE_WEBSITE_URL=www.technolohit.com' >> .env; fi

# 1b) Create gate6 override with both image variables wired
cat > docker-compose.gate6-rollout.yml <<'EOF'
services:
  voice-bridge:
    image: ${VOICE_BRIDGE_IMAGE}
    environment:
      VOICE_RAG_ENABLED: "true"
      VOICE_RAG_API_URL: "http://127.0.0.1:8080"
      VOICE_RAG_TIMEOUT_MS: "700"
      VOICE_RAG_MIN_SCORE: "0.72"
      VOICE_RAG_QA_MODE: "false"
      VOICE_LOG_TRANSCRIPT_PREVIEW: "false"
      VOICE_QA_LOG_TRANSCRIPT_PREVIEW: "false"
      VOICE_CONTACT_EMAIL: "${VOICE_CONTACT_EMAIL}"
      VOICE_WEBSITE_URL: "${VOICE_WEBSITE_URL}"
  technolohit-rag-api:
    image: ${RAG_API_IMAGE}
    container_name: technolohit-rag-api
    restart: unless-stopped
    env_file:
      - .env
    environment:
      RAG_SEMANTIC_PRODUCT_BOOST: "${RAG_SEMANTIC_PRODUCT_BOOST}"
      RAG_RETRIEVE_CANDIDATE_LIMIT: "${RAG_RETRIEVE_CANDIDATE_LIMIT}"
      RAG_SEMANTIC_PRODUCT_ACCEPT_FLOOR: "${RAG_SEMANTIC_PRODUCT_ACCEPT_FLOOR}"
      RAG_DEFAULT_MIN_SCORE: "${RAG_DEFAULT_MIN_SCORE}"
    ports:
      - "127.0.0.1:8080:8080"
EOF

# 2) Pull pinned candidate images
docker pull thnhit/technhvoice:voice-bridge-gate6-text-qa-harness-v21-20260523-0200
docker pull thnhit/technhvoice:rag-api-gate5-semantic-lokalki-hotfix-v5-20260522-1212

# 3) Verify merged compose config (with stale shell overrides removed)
env -u VOICE_BRIDGE_IMAGE -u RAG_API_IMAGE docker compose \
  -f docker-compose.yml \
  -f docker-compose.prod.yml \
  -f docker-compose.gate6-rollout.yml \
  config > /tmp/gate6-merged-compose.yml

env -u VOICE_BRIDGE_IMAGE -u RAG_API_IMAGE docker compose \
  -f docker-compose.yml \
  -f docker-compose.prod.yml \
  -f docker-compose.gate6-rollout.yml \
  config --services

env -u VOICE_BRIDGE_IMAGE -u RAG_API_IMAGE docker compose \
  -f docker-compose.yml \
  -f docker-compose.prod.yml \
  -f docker-compose.gate6-rollout.yml \
  config | egrep -i 'voice-bridge|technolohit-rag-api|image:'

# 4) Recreate containers, then verify actual running images
env -u VOICE_BRIDGE_IMAGE -u RAG_API_IMAGE docker compose \
  -f docker-compose.yml \
  -f docker-compose.prod.yml \
  -f docker-compose.gate6-rollout.yml \
  up -d --force-recreate voice-bridge technolohit-rag-api

docker inspect technolohit-voice-bridge --format '{{.Config.Image}}'
# expected: thnhit/technhvoice:voice-bridge-gate6-text-qa-harness-v21-20260523-0200

docker inspect technolohit-rag-api --format '{{.Config.Image}}'
# expected: thnhit/technhvoice:rag-api-gate5-semantic-lokalki-hotfix-v5-20260522-1212

# 5) Preflight checks (no enablement window yet)
curl -fsS http://127.0.0.1:8080/healthz
curl -fsS http://127.0.0.1:8080/readyz

docker exec technolohit-voice-bridge sh -lc 'node -e "fetch(\"http://127.0.0.1:8080/readyz\").then(r=>r.text()).then(console.log).catch(e=>{console.error(e.message);process.exit(1);})"'

docker exec technolohit-voice-bridge sh -lc '
echo "VOICE_LOG_TRANSCRIPT_PREVIEW=${VOICE_LOG_TRANSCRIPT_PREVIEW:-unset}";
echo "VOICE_QA_LOG_TRANSCRIPT_PREVIEW=${VOICE_QA_LOG_TRANSCRIPT_PREVIEW:-unset}";
'
```

### A. rag-api health/readiness

```bash
curl -fsS http://127.0.0.1:8080/healthz
curl -fsS http://127.0.0.1:8080/readyz
```

### B. pgvector + knowledge readiness counts

Run against production DB:

```sql
SELECT count(*) AS docs FROM knowledge.documents WHERE tenant_id='technolohit' AND is_active=true;
SELECT count(*) AS chunks FROM knowledge.chunks WHERE tenant_id='technolohit';
SELECT count(*) AS embeddings FROM knowledge.embeddings WHERE tenant_id='technolohit';
```

### C. Direct retrieval probes

```bash
curl -sS -X POST http://127.0.0.1:8080/v1/retrieve \
  -H 'Content-Type: application/json' \
  -d '{"tenant_id":"technolohit","query":"Was kann Ihr System mit sensiblen internen Dokumenten machen?","language":"de","top_k":5,"min_score":0.72}'

curl -sS -X POST http://127.0.0.1:8080/v1/retrieve \
  -H 'Content-Type: application/json' \
  -d '{"tenant_id":"technolohit","query":"Was ist Botinteg?","language":"de","top_k":5,"min_score":0.72}'
```

### D. voice-bridge connectivity to rag-api (host-network)

```bash
docker exec technolohit-voice-bridge sh -lc 'node -e "fetch(\"http://127.0.0.1:8080/readyz\").then(r=>r.text()).then(console.log).catch(e=>{console.error(e.message);process.exit(1);})"'
```

### E. Deterministic smoke prompts (pre-enable sanity)

- `Rückruf bitte`
- `Telefonisch`
- `E-Mail`
- `Welche Produkte bieten Sie an?`
- `Nummer drei`

Expected: deterministic behavior unchanged.

### F. Privacy flags check

```bash
docker exec technolohit-voice-bridge sh -lc '
echo "VOICE_LOG_TRANSCRIPT_PREVIEW=${VOICE_LOG_TRANSCRIPT_PREVIEW:-unset}";
echo "VOICE_QA_LOG_TRANSCRIPT_PREVIEW=${VOICE_QA_LOG_TRANSCRIPT_PREVIEW:-unset}";
'
```

Must be false/unset for production rollout.

### F2. Contact email + website config (required for business fallback QA)

Server `.env` must include:

```bash
VOICE_CONTACT_EMAIL=info@technolohit.com
VOICE_WEBSITE_URL=www.technolohit.com
```

Verify runtime values inside container:

```bash
docker exec technolohit-voice-bridge sh -lc 'echo "VOICE_CONTACT_EMAIL=${VOICE_CONTACT_EMAIL:-unset}"; echo "VOICE_WEBSITE_URL=${VOICE_WEBSITE_URL:-unset}"'
```

Expected for Gate 6 business-fallback QA:
- `VOICE_CONTACT_EMAIL=info@technolohit.com`
- `VOICE_WEBSITE_URL=www.technolohit.com`

If `VOICE_CONTACT_EMAIL` is unset, assistant must **not** invent an address.
If `VOICE_WEBSITE_URL` is unset, assistant uses generic wording: `auf unserer Website im Kontaktbereich` (no invented URL).

### G. Fail-closed check

Gate 5 already contains mandatory runtime fail-closed evidence. For Gate 6 preflight, minimum required is:

- verify prior evidence artifact exists:
  - `docs/Tasks/voice_assistant_gate5_closure_evidence_v1.md`
- optionally re-run a short non-live stop/start smoke if change risk is suspected.

## 5) Controlled Enablement Command (Current Stack)

Production-safe values:

- `VOICE_RAG_ENABLED=true`
- `VOICE_RAG_API_URL=http://127.0.0.1:8080`
- `VOICE_RAG_TIMEOUT_MS=700`
- `VOICE_RAG_MIN_SCORE=0.72`
- `VOICE_RAG_QA_MODE=false`
- `VOICE_LOG_TRANSCRIPT_PREVIEW=false`
- `VOICE_QA_LOG_TRANSCRIPT_PREVIEW=false`

Command:

```bash
cd /opt/technolohit-voice/asterisk

env -u VOICE_BRIDGE_IMAGE -u RAG_API_IMAGE docker compose \
  -f docker-compose.yml \
  -f docker-compose.prod.yml \
  -f docker-compose.gate6-rollout.yml \
  up -d --force-recreate voice-bridge technolohit-rag-api

docker inspect technolohit-voice-bridge --format '{{.Config.Image}}'
docker inspect technolohit-rag-api --format '{{.Config.Image}}'
```

## 6) Monitoring Commands (2-4 Hour Window)

```bash
export GATE6_START_UTC="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

docker logs --since="$GATE6_START_UTC" technolohit-voice-bridge \
| egrep -i 'rag attempt|rag fallback|rag_status|reason=|selected_title=|selected_source=|deterministic_semantic_accepted|contact preference check|contact_preference_match|match_reason|permission_context_match|soft_intake_max_turn_protected|post_completion_followup|soft_intake_state|product_flow_state|product_intake_product|product_intake_stage|handoff_choice|final_response_template|conversation finished|max_turns|used_template_response|used_llm_response|ERROR|WARNING' || true

docker logs --since="$GATE6_START_UTC" technolohit-rag-api \
| egrep -i 'POST /v1/retrieve|ERROR|Traceback' || true
```

## 6.1) Gate 6 QA Matrix on v21 (Must Pass Before "Gate 6 stable")

Deploy `voice-bridge-gate6-text-qa-harness-v21-20260523-0200` via helper first. Run section **6.3 Text QA Harness** locally or inside the container before live-call QA. v17 core product-intake flow must remain unchanged. Do not mark Gate 6 stable until all rows have **live-call** runtime evidence.

| # | Scenario | Expected evidence |
|---|----------|-------------------|
| 1 | General overview (`Was macht TechnoloHit?`) | short 5-product overview + asks which topic |
| 2 | Smart Website pitch | one assistant segment = `pitchShort` + `Möchten Sie ... prüfen lassen?` |
| 2b | Smart Website interest `Ja` | **same turn segment** contains `Sehr gerne` + `E-Mail` + (`telefonisch` or `Telefon`); log `product_interest_confirmed_contains_handoff_question=true`; stage `handoff_choice_requested` |
| 2c | Smart Website handoff `Telefon` | asks phone number (`Unter welcher Telefonnummer`) |
| 3 | AISeoQ | pitch + interest question in one segment; `Ja` -> ack + handoff question in one segment |
| 4 | Botinteg | pitch + interest question; `Ja` -> ack + handoff question; no qualification loop |
| 5 | LokalKI | pitch + interest question; `Ja` -> ack + handoff question |
| 6 | Digital Assistant | pitch + interest question; `Ja` -> ack + handoff question |
| 7 | E-Mail path | with `VOICE_CONTACT_EMAIL=info@technolohit.com`: assistant says `Sie können uns an info@technolohit.com schreiben.` + product `emailInstruction`; log `voice_contact_email_configured=true` |
| 7b | E-Mail path missing env | if unset, no invented address; fallback website-only wording |
| 8 | Telefon path | asks phone number, asks permission, confirms with **final question in same segment** |
| 8b | Permission granted `Ja` | one assistant segment contains `Danke`/`notiert` + `telefonisch` or `Team meldet sich` + `Haben Sie noch eine kurze Frage` or `darf ich mich verabschieden`; log `permission_granted_contains_final_question=true` |
| 9 | Follow-up question after capture | `Ja, ich habe eine Frage` -> `Gerne. Welche Frage haben Sie?` |
| 9d | Post-capture Beratung/process question | `Wie läuft die Beratung ab?` -> short process + `www.technolohit.com`/Kontaktformular + final close question; log `business_fallback_intent=consultation_process_question business_fallback_guidance=website_contact voice_website_url_configured=true` |
| 9e | Post-capture E-Mail contents question | `Was soll ich in der E-Mail schreiben?` -> goal + website/domain + key question + optional company name + `info@technolohit.com`; log `business_fallback_guidance=email` |
| 9f | Post-capture company name question | `Soll ich den Namen meines Unternehmens nennen?` -> optional in E-Mail/Formular, goal/website/key question first |
| 9g | Contact form (any context) | `Wo finde ich das Kontaktformular?` -> deterministic Kontaktbereich on configured website + final close question; **not** generic unknown/clarification |
| 9h | Clear close after fallback | `Danke. Tschüss.` -> warm goodbye; log `clear_close_detected=true closing_reason=clear_close`; **no** acoustic clarification |
| 9i | Fallback chain limit | after 2+ miscellaneous business questions -> contact-form redirect on configured website |
| 9b | Incomplete follow-up fragment (non-business) | truncated `Soll ich...` without business intent -> clarification repeat request, **not** warm goodbye; log `closing_incomplete_question_guard=true closing_reason=incomplete_question_clarified` and `post_completion_followup_answered=false` |
| 9c | Clear close after final question | `Danke` / `Nein, danke` -> warm goodbye; log `closing_reason=clear_close` |
| 10 | Closing | `Nein, danke` -> warm goodbye |

Log grep for the QA window:

```bash
export QA_START_UTC="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
docker logs --since="$QA_START_UTC" technolohit-voice-bridge \
| egrep -i 'business_fallback_intent|business_fallback_guidance|business_fallback_source|business_fallback_next_step|voice_website_url_configured|clear_close_detected|fallback_question_count|post_completion_followup_answered|closing_incomplete_question_guard|closing_reason|voice_contact_email_configured|product_pitch_contains_next_question|product_interest_confirmed_contains_handoff_question|permission_granted_contains_final_question|final_permission_response_missing_question|response_limiter_removed_permission_tail|permission_context_match|soft_intake_max_turn_protected|post_completion_followup|soft_intake_state|contact_preference_match|product_intake_product|product_intake_stage|handoff_choice|final_response_template|rag fallback hit|conversation finished|max_turns|post-call.*lead|ERROR' || true
```

### 6.2) DB Transcript Debug Query (Correct Columns)

`voice.call_transcripts` does **not** contain `ct.turn_index` as a physical column. Use:

- `sequence_number`
- `segment_index`
- `metadata->>'turn_index'`
- `content` / `text`

```sql
WITH last_call AS (
  SELECT id, external_call_id, status, created_at, ended_at
  FROM voice.call_sessions
  ORDER BY created_at DESC
  LIMIT 1
)
SELECT
  lc.external_call_id,
  lc.status,
  ct.sequence_number,
  ct.segment_index,
  ct.speaker,
  ct.content,
  ct.text,
  ct.metadata->>'turn_index' AS meta_turn_index,
  ct.created_at AS transcript_created_at
FROM last_call lc
JOIN voice.call_transcripts ct ON ct.call_session_id = lc.id
ORDER BY ct.sequence_number, ct.segment_index, ct.created_at;
```

## 6.3) Text QA Harness (Precondition — Not a Gate 6 Stable Substitute)

Live-call QA mixes AudioSocket timing, STT noise, silence handling, TTS playback, DB persistence, and dialogue logic. That is too slow for every policy/template iteration.

The repo now includes a **text-only dialogue simulator** that exercises the same production modules:

- `product-intake-policy.js`
- `business-fallback-policy.js`
- `config.js`
- `turn-assistant.js` via exported `processTextTurn()`

It bypasses AudioSocket, STT, TTS, and audio recording. It does **not** replace live-call QA.

**Rule:** predefined text scenarios must pass locally before running the live-call Gate 6 matrix. Gate 6 remains **not stable** until live-call evidence in section 6.1 is captured.

### Run from repo

```bash
cd voice-bridge

# Single scenario (human table + assertions, exit 0/1)
node scripts/qa-dialogue-text.js --scenario gate6_business_fallback
node scripts/qa-dialogue-text.js --scenario smart_website_phone
node scripts/qa-dialogue-text.js --scenario contact_form_question

# JSON-lines per turn
node scripts/qa-dialogue-text.js --scenario gate6_business_fallback --json

# Custom turn list
node scripts/qa-dialogue-text.js --turns '[
  "Wo finde ich das Kontaktformular?",
  "Danke. Tschüss."
]'

# Optional RAG scenario only
node scripts/qa-dialogue-text.js --scenario lokalki_rag_optional --rag true
```

Or: `npm run qa:dialogue -- --scenario contact_form_question`

### Run inside deployed container (v21+)

The harness is packaged at `/app/scripts/qa-dialogue-text.js`. From the host:

```bash
docker exec technolohit-voice-bridge sh -lc \
  'node /app/scripts/qa-dialogue-text.js --scenario contact_form_question --json'

docker exec technolohit-voice-bridge sh -lc \
  'node /app/scripts/qa-dialogue-text.js --scenario gate6_business_fallback'
```

Pre-build verification (before push):

```bash
docker run --rm thnhit/technhvoice:voice-bridge-gate6-text-qa-harness-v21-20260523-0200 \
  sh -lc 'ls -la /app/scripts && node /app/scripts/qa-dialogue-text.js --scenario contact_form_question --json'
```

Ensure `VOICE_WEBSITE_URL` is passed through compose (section 3 override includes `VOICE_WEBSITE_URL: "${VOICE_WEBSITE_URL}"`).

### Predefined scenarios

| Scenario id | Alias | Purpose |
|-------------|-------|---------|
| `smart_website_email` | `smart-website-email` | pitch → Ja → E-Mail path |
| `smart_website_phone` | `smart-website-phone` | pitch → Ja → Telefon → permission → close |
| `gate6_business_fallback` | `gate6-business-fallback` | full post-capture business fallback chain |
| `five_products_overview` | — | product overview template |
| `clear_close` | — | warm goodbye after phone intake |
| `contact_form_question` | — | single-turn Kontaktformular (regression) |
| `email_contents_question` | — | single-turn E-Mail contents |
| `lokalki_rag_optional` | — | optional RAG path (`--rag true`) |

### Default deterministic env (override via `.env`)

- `VOICE_CONTACT_EMAIL=info@technolohit.com`
- `VOICE_WEBSITE_URL=www.technolohit.com`
- `VOICE_RAG_ENABLED=false`
- `VOICE_LOG_TRANSCRIPT_PREVIEW=false`

### Example table output

```text
Turn | Caller | Assistant | normalized_intent | product_intake_stage | handoff_choice | business_fallback_intent | final_response_template
1 | Wo finde ich das Kontaktformular? | Das Kontaktformular finden Sie im Kontaktbereich auf www.technolohit.com. ... | contact_form_question | idle | none | contact_form_question | business_fallback
```

## 7) Decision Criteria

Keep enabled only if:

- timeout/request_failed rates remain low
- deterministic flows remain stable
- callback/contact flow does not regress
- privacy flags remain safe (no preview leakage)
- no repeated low-confidence/no-hit on common approved topics

Revert immediately if:

- request_failed/timeout spikes
- contact flow regression
- privacy flag drift
- unstable user-facing quality on common prompts

## 8) Revert Command (One-Command Safe Rollback)

```bash
cd /opt/technolohit-voice/asterisk

VOICE_RAG_ENABLED=false \
VOICE_RAG_QA_MODE=false \
VOICE_LOG_TRANSCRIPT_PREVIEW=false \
VOICE_QA_LOG_TRANSCRIPT_PREVIEW=false \
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d voice-bridge
```

No DB rollback required for this Gate 6 toggle.

## 9) Productization Notes (Planning Only, Not Gate 6 Implementation)

Target customer packaging:

- `deploy/docker-compose.customer.yml`
- `deploy/.env.customer.example`
- `deploy/knowledge/customer.md`
- `deploy/knowledge/products.customer.json`
- `deploy/knowledge/faqs.customer.json`
- `deploy/asterisk/templates/`
- `deploy/runbooks/`
- `deploy/scripts/preflight.sh`
- `deploy/scripts/verify-ready.sh`
- `deploy/scripts/collect-evidence.sh`

This is planning scope only for Gate 6.

## 10) Guardrails (Must Not Change)

- Do not make RAG a hard dependency.
- Do not ingest raw call transcripts.
- Do not bypass deterministic routing.
- Do not change Gate 5 regression lane status.
- Do not mix TTS speed or multilingual implementation into this rollout.

TTS speed and multilingual remain separate future planning lanes.

## 11) Troubleshooting Image Drift

If `docker inspect` still shows an old image after deploy:

```bash
env | grep -E 'VOICE_BRIDGE_IMAGE|RAG_API_IMAGE'
unset VOICE_BRIDGE_IMAGE
unset RAG_API_IMAGE
```

Then rerun the deploy helper:

```bash
./scripts/deploy-voice-bridge-image.sh thnhit/technhvoice:voice-bridge-gate6-text-qa-harness-v21-20260523-0200
./scripts/deploy-rag-api-image.sh thnhit/technhvoice:rag-api-gate5-semantic-lokalki-hotfix-v5-20260522-1212
```

Voice-bridge rollback to v16 (product intake + permission final question OK; incomplete follow-up closed too early):

```bash
./scripts/deploy-voice-bridge-image.sh thnhit/technhvoice:voice-bridge-gate6-permission-final-question-v16-20260522-2130
```

Do not continue QA until `docker inspect` matches the expected image for both containers.
