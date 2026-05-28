# Sysadmin Runbook: Voice-Bridge RAG Fallback Gate 5 Execution v1

Date: 2026-05-22

## Scope

Validate Gate 5 behavior for feature-flagged RAG fallback in `voice-bridge`.

This runbook is for QA execution only. It does not authorize production-wide enablement.

## QA Image

```text
thnhit/technhvoice:voice-bridge-gate5-liveqa-hotfix-v4-20260522-1258
sha256:d4f30f4de840555a75d9faae39b56bfbad8ac385c90a0066c192749d463675c5
```

## Preconditions

- Gate 1-4 are green.
- `technolohit-rag-api` is healthy/ready.
- Approved knowledge ingest is complete.
- `VOICE_RAG_ENABLED` is still `false` before Gate 5 QA start.

## RAG API hotfix for semantic LokalKI retrieval

If Gate 5 fails with repeated `rag_no_hit` for internal-documents/privacy wording, deploy this RAG API hotfix first:

```text
thnhit/technhvoice:rag-api-gate5-semantic-lokalki-hotfix-v5-20260522-1212
sha256:f41f1fcbb98a436ea3a105e853e217511e0a2c090b2ac420a4edde8824a8de0a
```

```bash
cd /opt/technolohit-voice/asterisk
RAG_SEMANTIC_PRODUCT_BOOST=0.12 \
RAG_RETRIEVE_CANDIDATE_LIMIT=12 \
RAG_SEMANTIC_PRODUCT_ACCEPT_FLOOR=0.66 \
RAG_API_IMAGE=thnhit/technhvoice:rag-api-gate5-semantic-lokalki-hotfix-v5-20260522-1212 \
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d technolohit-rag-api
```

Verify hotfix env inside container:

```bash
docker exec technolohit-rag-api sh -lc 'echo "RAG_SEMANTIC_PRODUCT_BOOST=$RAG_SEMANTIC_PRODUCT_BOOST"; echo "RAG_RETRIEVE_CANDIDATE_LIMIT=$RAG_RETRIEVE_CANDIDATE_LIMIT"'
docker exec technolohit-rag-api sh -lc 'echo "RAG_SEMANTIC_PRODUCT_ACCEPT_FLOOR=$RAG_SEMANTIC_PRODUCT_ACCEPT_FLOOR"'
```

## Deploy (controlled QA window)

```bash
cd /opt/technolohit-voice/asterisk
docker compose -f docker-compose.yml -f docker-compose.prod.yml pull voice-bridge

VOICE_BRIDGE_IMAGE=thnhit/technhvoice:voice-bridge-gate5-liveqa-hotfix-v4-20260522-1258 \
VOICE_RAG_ENABLED=true \
VOICE_RAG_API_URL=http://127.0.0.1:8080 \
VOICE_RAG_TIMEOUT_MS=700 \
VOICE_RAG_MIN_SCORE=0.72 \
VOICE_RAG_QA_MODE=true \
VOICE_RAG_QA_TIMEOUT_MS=1800 \
VOICE_RAG_QA_RETRY_DELTA=0.08 \
VOICE_RAG_QA_ACCEPT_FLOOR=0.65 \
VOICE_LOG_TRANSCRIPT_PREVIEW=false \
VOICE_QA_LOG_TRANSCRIPT_PREVIEW=false \
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d voice-bridge
```

## Guardrails

- Deterministic router and Soft Intake remain first.
- Never route control intents to RAG (`Rückruf`, `telefonisch`, `per E-Mail`, permission, caller ID consent, product number routing).
- Timeout/error/no-hit/low-confidence must fail closed to existing safe fallback.
- Keep transcript/query previews redacted by default.

## Connectivity pre-check (before live-call QA)

Confirm localhost reachability from inside `voice-bridge` (current production stack uses `network_mode: host`):

```bash
docker exec technolohit-voice-bridge sh -lc 'node -e "fetch(\"http://127.0.0.1:8080/readyz\").then(r=>r.text()).then(console.log).catch(e=>{console.error(e.message);process.exit(1);})"'
```

Note for non-host-network deployments only:

```bash
docker exec technolohit-voice-bridge sh -lc 'node -e "fetch(\"http://technolohit-rag-api:8080/readyz\").then(r=>r.text()).then(console.log).catch(e=>{console.error(e.message);process.exit(1);})"'
```

## Controlled QA enablement

Run only in controlled QA deployment window:

```env
VOICE_RAG_ENABLED=true
VOICE_RAG_API_URL=http://127.0.0.1:8080
VOICE_RAG_TIMEOUT_MS=700
VOICE_RAG_MIN_SCORE=0.72
VOICE_RAG_QA_MODE=true
VOICE_RAG_QA_TIMEOUT_MS=1800
VOICE_RAG_QA_RETRY_DELTA=0.08
VOICE_RAG_QA_ACCEPT_FLOOR=0.65
VOICE_LOG_TRANSCRIPT_PREVIEW=false
VOICE_QA_LOG_TRANSCRIPT_PREVIEW=false
```

After QA, revert:

```env
VOICE_RAG_ENABLED=false
VOICE_RAG_QA_MODE=false
VOICE_LOG_TRANSCRIPT_PREVIEW=false
VOICE_QA_LOG_TRANSCRIPT_PREVIEW=false
```

## QA matrix

### A) Deterministic protection tests

1. Product overview:
   - caller: `Welche Produkte bieten Sie an?`
   - expected: deterministic product list (no RAG dependency)
2. Product number:
   - caller: `Nummer drei`
   - expected: deterministic Botinteg route
3. Callback request:
   - caller: `Rückruf bitte`
   - expected: deterministic Soft Intake path
4. Permission:
   - caller: `Ja` / `Nein`
   - expected: deterministic permission handling

### B) RAG fallback tests

1. Live-style semantic phrasing (must retrieve LokalKI context consistently):
   - caller: `Was kann Ihr System mit sensiblen internen Dokumenten machen?`
   - expected: `rag fallback hit` and no `rag_low_confidence` skip when RAG metadata marks deterministic semantic product router acceptance
2. Additional semantic phrasing:
   - caller: `Kann Ihre Lösung mit sensiblen Daten arbeiten?`
   - expected: `rag fallback hit` with LokalKI-approved source context

### C) Failure handling tests

1. RAG unavailable:
   - stop `technolohit-rag-api`
   - expected: no call break, safe fallback response
2. RAG timeout:
   - induce timeout (slow API or very short timeout)
   - expected: no call break, safe fallback response

## Evidence collection

Collect:

- voice-bridge logs for response routing (`used_template_response`, `used_llm_response`, `normalized_intent`)
- explicit RAG fallback hit/skip logs
- contact preference match logs (`contact_preference_match`, `match_reason`, `attempt_count`)
- rag-api logs for `/v1/retrieve` during test window
- post-call QA transcript snippets (redacted preview mode)

Suggested commands:

```bash
docker logs --since=30m technolohit-voice-bridge \
| egrep -i 'rag attempt|rag fallback|rag_status|contact preference check|contact_preference_match|normalized_intent|used_template_response|used_llm_response|soft_intake_state|product_flow_state|ERROR|WARNING' || true

docker logs --since=30m technolohit-rag-api \
| egrep -i 'POST /v1/retrieve|healthz|readyz|ERROR|Traceback' || true
```

Exact retrieval debug probes (run on voice host):

```bash
curl -sS -X POST http://127.0.0.1:8080/v1/retrieve \
  -H 'Content-Type: application/json' \
  -d '{"tenant_id":"technolohit","query":"Was kann Ihr System mit sensiblen internen Dokumenten machen?","language":"de","top_k":5,"min_score":0.72}'

curl -sS -X POST http://127.0.0.1:8080/v1/retrieve \
  -H 'Content-Type: application/json' \
  -d '{"tenant_id":"technolohit","query":"Kann Ihre Lösung mit sensiblen Daten arbeiten?","language":"de","top_k":5,"min_score":0.72}'

curl -sS -X POST http://127.0.0.1:8080/v1/retrieve \
  -H 'Content-Type: application/json' \
  -d '{"tenant_id":"technolohit","query":"Haben Sie eine private KI für interne Dokumente?","language":"de","top_k":5,"min_score":0.72}'
```

Live callback/contact-preference QA utterances:

- `Rückruf bitte`
- `Anruf`
- `Telefonisch`
- `E-Mail`

Expected:

- deterministic contact-preference handling without repeated unknown failures
- `contact_preference_match=callback|email|none` and `match_reason=fuzzy_keyword|state_override|intent_match|none`
- optional QA transcript diagnostics only when `VOICE_QA_LOG_TRANSCRIPT_PREVIEW=true`

## PASS criteria

Gate 5 is green only if:

- deterministic protection tests pass unchanged
- RAG fallback tests pass for semantic questions
- timeout/unavailable tests fail closed safely
- no raw transcript ingestion/logging regressions
- no regressions in Soft Intake/product-router behavior

Gate 5 remains an ongoing regression lane after green:

- future callback/STT/dialect regressions should be re-tested through this runbook
- future RAG no-hit/low-confidence quality regressions should re-run this matrix before any rollout changes
- green status for one slice does not auto-authorize Gate 6

## Final Gate 5 Closure Checklist (Minimum Required)

Run this exact minimum set before declaring Gate 5 green for the current slice.

1) Fail-closed runtime test (mandatory):

- stop RAG API:
  - `docker stop technolohit-rag-api`
- run one semantic live-call question:
  - example: `Was kann Ihr System mit sensiblen internen Dokumenten machen?`
- expected:
  - call continues safely (no crash, no blocked turn)
  - safe fallback response path is used
- restart RAG API:
  - `docker start technolohit-rag-api`
  - wait until readiness is stable before the next check:
    ```bash
    for i in $(seq 1 30); do
      if curl -fsS http://127.0.0.1:8080/readyz >/dev/null; then
        echo "rag-api ready"
        break
      fi
      sleep 2
    done
    ```

2) Short regression matrix (live-call):

- `Rückruf bitte`
- `Telefonisch`
- `E-Mail`
- `Was kann Ihr System mit sensiblen internen Dokumenten machen?`
- `Welche Produkte bieten Sie an?`
- `Nummer drei`

Expected:

- callback/contact preferences stay deterministic and complete reliably
- semantic LokalKI question uses approved RAG/deterministic semantic acceptance path
- product overview/selection remain deterministic

3) Privacy confirmation:

- `VOICE_LOG_TRANSCRIPT_PREVIEW=false`
- `VOICE_QA_LOG_TRANSCRIPT_PREVIEW=false`
- no raw transcript ingestion added anywhere in this gate

4) Final QA revert (post-evidence):

- `VOICE_RAG_ENABLED=false`
- `VOICE_RAG_QA_MODE=false`

Suggested revert command:

```bash
cd /opt/technolohit-voice/asterisk
VOICE_RAG_ENABLED=false \
VOICE_RAG_QA_MODE=false \
VOICE_LOG_TRANSCRIPT_PREVIEW=false \
VOICE_QA_LOG_TRANSCRIPT_PREVIEW=false \
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d voice-bridge
```

Gate 6 discussion is allowed only after this checklist evidence is attached and reviewed.

## Rollback

Immediate rollback switch:

```bash
cd /opt/technolohit-voice/asterisk
VOICE_RAG_ENABLED=false \
VOICE_RAG_QA_MODE=false \
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d voice-bridge
```

No DB rollback is required for this gate.
