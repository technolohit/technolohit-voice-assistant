grep -nE '^(RAG_API_IMAGE|RAG_SEMANTIC_PRODUCT_BOOST|RAG_RETRIEVE_CANDIDATE_LIMIT|RAG_SEMANTIC_PRODUCT_ACCEPT_FLOOR|RAG_DEFAULT_MIN_SCORE|VOICE_RAG_API_URL)=' .env
20:RAG_API_IMAGE=thnhit/technhvoice:rag-api-gate5-semantic-lokalki-hotfix-v5-20260522-1212
33:RAG_DEFAULT_MIN_SCORE=0.72
40:VOICE_RAG_API_URL=http://127.0.0.1:8080
45:RAG_SEMANTIC_PRODUCT_BOOST=0.12
46:RAG_RETRIEVE_CANDIDATE_LIMIT=12
48:RAG_SEMANTIC_PRODUCT_ACCEPT_FLOOR=0.66
root@app-prod-01:/opt/technolohit-voice/asterisk# cat > docker-compose.rag-api.yml <<'EOF'
services:
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
root@app-prod-01:/opt/technolohit-voice/asterisk# unset RAG_API_IMAGE
unset RAG_SEMANTIC_PRODUCT_BOOST
unset RAG_RETRIEVE_CANDIDATE_LIMIT
unset RAG_SEMANTIC_PRODUCT_ACCEPT_FLOOR
unset RAG_DEFAULT_MIN_SCORE

docker compose \
  -f docker-compose.yml \
  -f docker-compose.prod.yml \
  -f docker-compose.rag-api.yml \
  config \
| sed -n '/technolohit-rag-api:/,/^[a-zA-Z0-9_-]*:/p' \
| egrep -i 'image:|RAG_SEMANTIC_PRODUCT_BOOST|RAG_RETRIEVE_CANDIDATE_LIMIT|RAG_SEMANTIC_PRODUCT_ACCEPT_FLOOR|RAG_DEFAULT_MIN_SCORE|container_name'
    container_name: technolohit-rag-api
      RAG_API_IMAGE: thnhit/technhvoice:rag-api-gate5-semantic-lokalki-hotfix-v5-20260522-1212
      RAG_DEFAULT_MIN_SCORE: "0.72"
      RAG_RETRIEVE_CANDIDATE_LIMIT: "12"
      RAG_SEMANTIC_PRODUCT_ACCEPT_FLOOR: "0.66"
      RAG_SEMANTIC_PRODUCT_BOOST: "0.12"
      VOICE_BRIDGE_IMAGE: thnhit/technhvoice:voice-bridge-gate5-rag-fallback-qa-v1-20260522-103421
    image: thnhit/technhvoice:rag-api-gate5-semantic-lokalki-hotfix-v5-20260522-1212
    container_name: technolohit-voice-bridge
    image: thnhit/technhvoice:voice-bridge-gate5-rag-hotfix-v2-20260522-1110
root@app-prod-01:/opt/technolohit-voice/asterisk# docker pull thnhit/technhvoice:rag-api-gate5-semantic-lokalki-hotfix-v5-20260522-1212

docker compose \
  -f docker-compose.yml \
  -f docker-compose.prod.yml \
  -f docker-compose.rag-api.yml \
  up -d --force-recreate technolohit-rag-api
rag-api-gate5-semantic-lokalki-hotfix-v5-20260522-1212: Pulling from thnhit/technhvoice
02fc5f6d9dc5: Pull complete
345d7288f09f: Download complete
Digest: sha256:f41f1fcbb98a436ea3a105e853e217511e0a2c090b2ac420a4edde8824a8de0a
Status: Downloaded newer image for thnhit/technhvoice:rag-api-gate5-semantic-lokalki-hotfix-v5-20260522-1212
docker.io/thnhit/technhvoice:rag-api-gate5-semantic-lokalki-hotfix-v5-20260522-1212
[+] up 1/1
 ✔ Container technolohit-rag-api Started                                                                                                                                                                                                 0.7s
root@app-prod-01:/opt/technolohit-voice/asterisk# docker inspect technolohit-rag-api --format '{{.Config.Image}}'

docker exec technolohit-rag-api sh -lc '
echo "RAG_SEMANTIC_PRODUCT_BOOST=${RAG_SEMANTIC_PRODUCT_BOOST:-unset}"
echo "RAG_RETRIEVE_CANDIDATE_LIMIT=${RAG_RETRIEVE_CANDIDATE_LIMIT:-unset}"
echo "RAG_SEMANTIC_PRODUCT_ACCEPT_FLOOR=${RAG_SEMANTIC_PRODUCT_ACCEPT_FLOOR:-unset}"
echo "RAG_DEFAULT_MIN_SCORE=${RAG_DEFAULT_MIN_SCORE:-unset}"
echo "OPENAI_API_KEY_SET=$([ -n "${OPENAI_API_KEY:-}" ] && echo yes || echo no)"
'

curl -fsS http://127.0.0.1:8080/readyz
echo
thnhit/technhvoice:rag-api-gate5-semantic-lokalki-hotfix-v5-20260522-1212
RAG_SEMANTIC_PRODUCT_BOOST=0.12
RAG_RETRIEVE_CANDIDATE_LIMIT=12
RAG_SEMANTIC_PRODUCT_ACCEPT_FLOOR=0.66
RAG_DEFAULT_MIN_SCORE=0.72
OPENAI_API_KEY_SET=yes
{"ready":true,"vector_version":"0.8.2","knowledge_schema":true,"embedding_vector_column":true}
root@app-prod-01:/opt/technolohit-voice/asterisk# curl -sS -X POST http://127.0.0.1:8080/v1/retrieve \
  -H 'Content-Type: application/json' \
  -d '{"tenant_id":"technolohit","query":"Was kann Ihr System mit sensiblen internen Dokumenten machen?","language":"de","top_k":5,"min_score":0.72}'
echo

curl -sS -X POST http://127.0.0.1:8080/v1/retrieve \
  -H 'Content-Type: application/json' \
  -d '{"tenant_id":"technolohit","query":"Kann Ihre Lösung mit sensiblen Daten arbeiten?","language":"de","top_k":5,"min_score":0.72}'
echo

curl -sS -X POST http://127.0.0.1:8080/v1/retrieve \
  -H 'Content-Type: application/json' \
  -d '{"tenant_id":"technolohit","query":"Haben Sie eine private KI für interne Dokumente?","language":"de","top_k":5,"min_score":0.72}'
echo
{"hit":true,"answer_context":[{"chunk_id":"fd5a938f-d149-4455-8898-3b71c55ee23b","document_id":"1888da6d-a3f0-4877-8c45-323263ce2357","title":"LokalKI","content":"Produkt: LokalKI Kurzname: LokalKI Aliasse: LokalKI, lokale KI, private KI, Offline KI, interne KI Kurze Telefonantwort: LokalKI ist eine private KI-Lösung für sensible Daten in kontrollierten oder lokalen Umgebungen. Geht es um interne Dokumente oder Datenschutz? Detailantwort: LokalKI ist für interne Dokumente und sensible Daten in kontrollierten Umgebungen gedacht. Möchten Sie das mit dem Team prüfen? Nicht versprechen: absolute Sicherheit, DSGVO-Garantie, Rechtsberatung","score":0.5706095917520696,"source_uri":"C:/Technolohit/technolohit-email-outreach-automation/voice-bridge/knowledge/products.technolohit.json#lokalki","metadata":{"source_uri":"C:/Technolohit/technolohit-email-outreach-automation/voice-bridge/knowledge/products.technolohit.json#lokalki","semantic_product_intent":["lokalki"],"accepted_by":"deterministic_semantic_product_router","score_boost_reason":"semantic_product_intent","base_score":0.45061}}],"latency_ms":269}
{"hit":true,"answer_context":[{"chunk_id":"fd5a938f-d149-4455-8898-3b71c55ee23b","document_id":"1888da6d-a3f0-4877-8c45-323263ce2357","title":"LokalKI","content":"Produkt: LokalKI Kurzname: LokalKI Aliasse: LokalKI, lokale KI, private KI, Offline KI, interne KI Kurze Telefonantwort: LokalKI ist eine private KI-Lösung für sensible Daten in kontrollierten oder lokalen Umgebungen. Geht es um interne Dokumente oder Datenschutz? Detailantwort: LokalKI ist für interne Dokumente und sensible Daten in kontrollierten Umgebungen gedacht. Möchten Sie das mit dem Team prüfen? Nicht versprechen: absolute Sicherheit, DSGVO-Garantie, Rechtsberatung","score":0.5505523794261147,"source_uri":"C:/Technolohit/technolohit-email-outreach-automation/voice-bridge/knowledge/products.technolohit.json#lokalki","metadata":{"source_uri":"C:/Technolohit/technolohit-email-outreach-automation/voice-bridge/knowledge/products.technolohit.json#lokalki","semantic_product_intent":["lokalki"],"accepted_by":"deterministic_semantic_product_router","score_boost_reason":"semantic_product_intent","base_score":0.430552}}],"latency_ms":231}
{"hit":true,"answer_context":[{"chunk_id":"fd5a938f-d149-4455-8898-3b71c55ee23b","document_id":"1888da6d-a3f0-4877-8c45-323263ce2357","title":"LokalKI","content":"Produkt: LokalKI Kurzname: LokalKI Aliasse: LokalKI, lokale KI, private KI, Offline KI, interne KI Kurze Telefonantwort: LokalKI ist eine private KI-Lösung für sensible Daten in kontrollierten oder lokalen Umgebungen. Geht es um interne Dokumente oder Datenschutz? Detailantwort: LokalKI ist für interne Dokumente und sensible Daten in kontrollierten Umgebungen gedacht. Möchten Sie das mit dem Team prüfen? Nicht versprechen: absolute Sicherheit, DSGVO-Garantie, Rechtsberatung","score":0.7724091655402108,"source_uri":"C:/Technolohit/technolohit-email-outreach-automation/voice-bridge/knowledge/products.technolohit.json#lokalki","metadata":{"source_uri":"C:/Technolohit/technolohit-email-outreach-automation/voice-bridge/knowledge/products.technolohit.json#lokalki","score_boost_reason":"semantic_product_intent","semantic_product_intent":["lokalki"],"base_score":0.652409}},{"chunk_id":"5c563776-68a4-4719-98b8-2ca5b375f0bb","document_id":"6d377682-67aa-4fdc-9195-a1c8bd84d78c","title":"technolohit","content":"zt werden, damit interne Informationen besser geschuetzt bleiben. Keine absolute Sicherheits- oder Rechtsgarantie geben. Telefonantwort: \"LokalKI ist eine private KI-Loesung fuer sensible Daten in kontrollierten oder lokalen Umgebungen. Geht es um interne Dokumente oder Datenschutz?\" ### Digitale Rezeption / Voice Agent Die digitale Rezeption kann Anrufe annehmen, erste Fragen beantworten, Rueckrufwuensche vorbereiten und Anfragen fuer das Team speichern. Sie unterstuetzt das Team, ersetzt aber keine individuelle Beratung. Telefonantwort: \"Die digitale Rezeption nimmt Anrufe an, beantwortet erste Fragen und bereitet Rueckrufwuensche oder Leads vor. Moechten Sie das fuer Ihr Unternehmen pruefen?\" ## Core Offer: Intelligente Websites Eine intelligente Website ist eine moderne Unternehmenswebsite, die mehr macht als nur gut auszusehen.","score":0.720580829487852,"source_uri":"C:/Technolohit/technolohit-email-outreach-automation/voice-bridge/knowledge/technolohit.md","metadata":{"source_uri":"C:/Technolohit/technolohit-email-outreach-automation/voice-bridge/knowledge/technolohit.md","score_boost_reason":"semantic_product_intent","semantic_product_intent":["lokalki"],"base_score":0.600581}}],"latency_ms":195}
root@app-prod-01:/opt/technolohit-voice/asterisk# cd /opt/technolohit-voice/asterisk

cat > docker-compose.gate5-rag-voice.yml <<'EOF'
services:
  voice-bridge:
    image: ${VOICE_BRIDGE_IMAGE}
    environment:
      VOICE_RAG_ENABLED: "true"
      VOICE_RAG_API_URL: "http://127.0.0.1:8080"
      VOICE_RAG_TIMEOUT_MS: "700"
      VOICE_RAG_MIN_SCORE: "0.72"
      VOICE_RAG_QA_MODE: "true"
      VOICE_RAG_QA_TIMEOUT_MS: "1800"
      VOICE_RAG_QA_RETRY_DELTA: "0.08"
      VOICE_RAG_QA_ACCEPT_FLOOR: "0.65"
      VOICE_LOG_TRANSCRIPT_PREVIEW: "false"
EOF

export VOICE_BRIDGE_IMAGE='thnhit/technhvoice:voice-bridge-gate5-rag-hotfix-v2-20260522-1110'

docker pull "$VOICE_BRIDGE_IMAGE"

docker compose \
  -f docker-compose.yml \
  -f docker-compose.prod.yml \
  -f docker-compose.gate5-rag-voice.yml \
  up -d --force-recreate voice-bridge
voice-bridge-gate5-rag-hotfix-v2-20260522-1110: Pulling from thnhit/technhvoice
Digest: sha256:9f2a557055b949c561f37fb3b931c5494099b71f87d1ed1775df51d9486734ea
Status: Image is up to date for thnhit/technhvoice:voice-bridge-gate5-rag-hotfix-v2-20260522-1110
docker.io/thnhit/technhvoice:voice-bridge-gate5-rag-hotfix-v2-20260522-1110
WARN[0000] Found orphan containers ([technolohit-rag-api]) for this project. If you removed or renamed this service in your compose file, you can run this command with the --remove-orphans flag to clean it up.
[+] up 1/1
 ✔ Container technolohit-voice-bridge Started                                                                                                                                                                                            0.3s
root@app-prod-01:/opt/technolohit-voice/asterisk# docker inspect technolohit-voice-bridge --format '{{.Config.Image}}'

docker exec technolohit-voice-bridge sh -lc '
echo "VOICE_RAG_ENABLED=${VOICE_RAG_ENABLED:-unset}"
echo "VOICE_RAG_API_URL=${VOICE_RAG_API_URL:-unset}"
echo "VOICE_RAG_TIMEOUT_MS=${VOICE_RAG_TIMEOUT_MS:-unset}"
echo "VOICE_RAG_MIN_SCORE=${VOICE_RAG_MIN_SCORE:-unset}"
echo "VOICE_RAG_QA_MODE=${VOICE_RAG_QA_MODE:-unset}"
echo "VOICE_RAG_QA_TIMEOUT_MS=${VOICE_RAG_QA_TIMEOUT_MS:-unset}"
echo "VOICE_RAG_QA_RETRY_DELTA=${VOICE_RAG_QA_RETRY_DELTA:-unset}"
echo "VOICE_RAG_QA_ACCEPT_FLOOR=${VOICE_RAG_QA_ACCEPT_FLOOR:-unset}"
echo "VOICE_LOG_TRANSCRIPT_PREVIEW=${VOICE_LOG_TRANSCRIPT_PREVIEW:-unset}"
'

docker exec technolohit-voice-bridge sh -lc 'node -e "fetch(\"http://127.0.0.1:8080/readyz\").then(r=>r.text()).then(console.log).catch(e=>{console.error(e.message);process.exit(1);})"'
thnhit/technhvoice:voice-bridge-gate5-rag-hotfix-v2-20260522-1110
VOICE_RAG_ENABLED=true
VOICE_RAG_API_URL=http://127.0.0.1:8080
VOICE_RAG_TIMEOUT_MS=700
VOICE_RAG_MIN_SCORE=0.72
VOICE_RAG_QA_MODE=true
VOICE_RAG_QA_TIMEOUT_MS=1800
VOICE_RAG_QA_RETRY_DELTA=0.08
VOICE_RAG_QA_ACCEPT_FLOOR=0.65
VOICE_LOG_TRANSCRIPT_PREVIEW=false
{"ready":true,"vector_version":"0.8.2","knowledge_schema":true,"embedding_vector_column":true}
root@app-prod-01:/opt/technolohit-voice/asterisk# export QA_LIVE_START_UTC="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "$QA_LIVE_START_UTC"
2026-05-22T10:13:28Z
root@app-prod-01:/opt/technolohit-voice/asterisk# docker logs --since="$QA_LIVE_START_UTC" technolohit-voice-bridge \
| egrep -i 'rag attempt|rag fallback|rag_status|normalized_intent|used_template_response|used_llm_response|soft_intake_state|product_flow_state|ERROR|WARNING' || true

docker logs --since="$QA_LIVE_START_UTC" technolohit-rag-api \
| egrep -i 'POST /v1/retrieve|healthz|readyz|ERROR|Traceback' || true
[voice-assistant] turn transcribed turn_index=1 length=62 caller_transcript_preview=<redacted> normalized_intent=unknown transcript_quality=clear transcription_ms=1660
[voice-assistant] rag attempt turn_index=1 phase=initial timeout_ms=700 min_score=0.72
[voice-assistant] rag attempt turn_index=1 phase=no_hit_retry timeout_ms=1800 min_score=0.64
[voice-assistant] rag fallback skip turn_index=1 rag_status=skip reason=rag_no_hit latency_ms=242 hit_count=0 top_score=0.0000 selected_title=n/a selected_source=n/a
[voice-assistant] response created turn_index=1 caller_transcript_preview=<redacted> normalized_intent=unknown transcript_quality=clear response_preview=<redacted> used_template_response=true used_llm_response=false clarification_fallback=false relevance_fallback=true response_chars=89 soft_intake_state=not_started product_flow_state=not_started product_interest= response_generation_ms=2169
[voice-assistant] turn transcribed turn_index=2 length=179 caller_transcript_preview=<redacted> normalized_intent=callback_request transcript_quality=clear transcription_ms=1036
[voice-assistant] response created turn_index=2 caller_transcript_preview=<redacted> normalized_intent=callback_request transcript_quality=clear response_preview=<redacted> used_template_response=true used_llm_response=false clarification_fallback=false relevance_fallback=false response_chars=81 soft_intake_state=contact_preference_requested product_flow_state=not_started product_interest= response_generation_ms=0
[voice-assistant] turn transcribed turn_index=1 length=61 caller_transcript_preview=<redacted> normalized_intent=unknown transcript_quality=clear transcription_ms=633
[voice-assistant] rag attempt turn_index=1 phase=initial timeout_ms=700 min_score=0.72
[voice-assistant] rag fallback skip turn_index=1 rag_status=skip reason=rag_low_confidence latency_ms=177 hit_count=1 top_score=0.5706 selected_title=LokalKI selected_source=C:/Technolohit/technolohit-email-outreach-automation/voice-bridge/knowledge/products.technolohit.json#lokalki
[voice-assistant] response created turn_index=1 caller_transcript_preview=<redacted> normalized_intent=unknown transcript_quality=clear response_preview=<redacted> used_template_response=true used_llm_response=false clarification_fallback=false relevance_fallback=true response_chars=89 soft_intake_state=not_started product_flow_state=not_started product_interest= response_generation_ms=2923
[voice-assistant] turn transcribed turn_index=2 length=179 caller_transcript_preview=<redacted> normalized_intent=callback_request transcript_quality=clear transcription_ms=1231
[voice-assistant] response created turn_index=2 caller_transcript_preview=<redacted> normalized_intent=callback_request transcript_quality=clear response_preview=<redacted> used_template_response=true used_llm_response=false clarification_fallback=false relevance_fallback=false response_chars=81 soft_intake_state=contact_preference_requested product_flow_state=not_started product_interest= response_generation_ms=0
[voice-assistant] turn transcribed turn_index=1 length=50 caller_transcript_preview=<redacted> normalized_intent=product_selection_lokalki transcript_quality=clear transcription_ms=933
[voice-assistant] response created turn_index=1 caller_transcript_preview=<redacted> normalized_intent=product_selection_lokalki transcript_quality=clear response_preview=<redacted> used_template_response=true used_llm_response=false clarification_fallback=false relevance_fallback=false response_chars=143 soft_intake_state=not_started product_flow_state=awaiting_interest_confirmation product_interest=lokalki response_generation_ms=0
[voice-assistant] turn transcribed turn_index=2 length=18 caller_transcript_preview=<redacted> normalized_intent=unknown transcript_quality=unclear transcription_ms=606
[voice-assistant] response created turn_index=2 caller_transcript_preview=<redacted> normalized_intent=product_interest_reask transcript_quality=unclear response_preview=<redacted> used_template_response=true used_llm_response=false clarification_fallback=false relevance_fallback=false response_chars=90 soft_intake_state=not_started product_flow_state=awaiting_interest_confirmation product_interest=lokalki response_generation_ms=0
[voice-assistant] turn transcribed turn_index=3 length=11 caller_transcript_preview=<redacted> normalized_intent=unknown transcript_quality=unclear transcription_ms=829
[voice-assistant] response created turn_index=3 caller_transcript_preview=<redacted> normalized_intent=product_interest_confirmed transcript_quality=clear response_preview=<redacted> used_template_response=true used_llm_response=false clarification_fallback=false relevance_fallback=false response_chars=138 soft_intake_state=contact_preference_requested product_flow_state=selected product_interest=lokalki response_generation_ms=0
[voice-assistant] turn transcribed turn_index=4 length=12 caller_transcript_preview=<redacted> normalized_intent=unknown transcript_quality=unclear transcription_ms=541
[voice-assistant] response created turn_index=4 caller_transcript_preview=<redacted> normalized_intent=unknown transcript_quality=unclear response_preview=<redacted> used_template_response=true used_llm_response=false clarification_fallback=false relevance_fallback=false response_chars=89 soft_intake_state=contact_preference_requested product_flow_state=selected product_interest=lokalki response_generation_ms=0
[voice-assistant] turn transcribed turn_index=5 length=12 caller_transcript_preview=<redacted> normalized_intent=unknown transcript_quality=unclear transcription_ms=982
[voice-assistant] response created turn_index=5 caller_transcript_preview=<redacted> normalized_intent=unknown transcript_quality=unclear response_preview=<redacted> used_template_response=true used_llm_response=false clarification_fallback=false relevance_fallback=false response_chars=89 soft_intake_state=contact_preference_requested product_flow_state=selected product_interest=lokalki response_generation_ms=0
[voice-assistant] turn transcribed turn_index=6 length=10 caller_transcript_preview=<redacted> normalized_intent=unknown transcript_quality=unclear transcription_ms=625
[voice-assistant] response created turn_index=6 caller_transcript_preview=<redacted> normalized_intent=unknown transcript_quality=unclear response_preview=<redacted> used_template_response=true used_llm_response=false clarification_fallback=false relevance_fallback=false response_chars=149 soft_intake_state=failed product_flow_state=selected product_interest=lokalki response_generation_ms=0
[post-call] pipeline skipped call_session_id=e8e933b2-f497-4ec1-978c-db92f22a5eda reason=summary_not_created
INFO:     172.20.0.1:54118 - "POST /v1/retrieve HTTP/1.1" 200 OK
INFO:     172.20.0.1:54134 - "POST /v1/retrieve HTTP/1.1" 200 OK
INFO:     172.20.0.1:50656 - "POST /v1/retrieve HTTP/1.1" 200 OK
root@app-prod-01:/opt/technolohit-voice/asterisk#
root@app-prod-01:/opt/technolohit-voice/asterisk#

## Update: Gate 6 QA Candidate (voice-bridge v9 — ending policy + prompt-leak guard + first-turn product detection)

**Gate 6 is not stable** until runtime evidence in `docs/Tasks/sysadmin_voice_bridge_rag_gate6_rollout_v1.md` section 6.1 passes.

Current Gate 6 voice-bridge QA candidate (pushed to Docker Hub):

- `thnhit/technhvoice:voice-bridge-gate6-ending-policy-hotfix-v9-20260522-1620`
- digest `sha256:59f41925df1e72e34b02d2c5ddc9cc452daa5f44c24b6fcb90971513e35bb7a1`

Scope (v9, on top of v8 + v7 + v6 + v5 behavior):

- max-turn protection while soft intake waits for contact preference, contact detail, permission yes/no, or closing
- context-aware short Ja/Nein acceptance in `permission_requested`
- stronger closing policy after permission granted (final-question flow + warm close on no/danke/tschüss/silence)
- Botinteg responses include immediate follow-up prompts in the same assistant response (no long silent gap)
- stronger first-turn product intent recognition for natural Botinteg phrasing (`Ich möchte etwas über Botinteg wissen`)
- reduced aggressive email inference in product/soft-intake transitions
- hard filter for STT prompt leakage phrases (treated as no-input, not caller intent)
- fast-turn listening profile for Botinteg follow-up and closing states to reduce long silence
- privacy-safe logs: `soft_intake_max_turn_protected`, `permission_context_match`, `post_completion_followup`
- product logs: `product_name_detected`, `product_detection_reason`, `product_followup_prompt_included`

Deploy only via `scripts/deploy-voice-bridge-image.sh` on the voice server; confirm with `docker inspect`.

Rollback candidate (v8, before ending-policy update):

- `thnhit/technhvoice:voice-bridge-gate6-conversation-policy-hotfix-v8-20260522-1605`
- digest `sha256:49cea2c2e0b267a6836347f927793a00319e7b5ea7dfb0af483495b07d9ff2eb`

RAG API unchanged:

- `thnhit/technhvoice:rag-api-gate5-semantic-lokalki-hotfix-v5-20260522-1212`

## Update: Gate 5 Live-Call Hotfix Prepared (voice-bridge v5)

Prepared dedicated voice-bridge hotfix image for live-call Gate 5 QA stabilization:

- `thnhit/technhvoice:voice-bridge-gate6-quality-hotfix-v5-20260522-1439`
- digest `sha256:7d9a9ff6f479b757c5f2ab3ff84477e7ba4cc35aea9599eb837354aba77e9964`

Scope:

- accept approved deterministic semantic router metadata from RAG API (`accepted_by=deterministic_semantic_product_router`) without lowering global score thresholds
- first-turn semantic query normalization retry for internal-documents/privacy phrasings to reduce no-hit instability
- de-prioritize sticky product-selection resolution once soft-intake/contact flow is active
- stronger deterministic/fuzzy contact-preference capture for callback/email STT variants
- multi-step fallback prompts for contact-preference retries (`Anruf` / `E-Mail` focused)
- privacy-safe contact-preference matching logs (`contact_preference_match`, `match_reason`, `attempt_count`)
- optional QA-only transcript diagnostics flag: `VOICE_QA_LOG_TRANSCRIPT_PREVIEW` (default `false`)

Current independent status assessment:

- Gate 5 status: **GREEN for the current slice** (runtime evidence includes deterministic semantic acceptance, improved callback/contact handling, and mandatory fail-closed behavior with `technolohit-rag-api` stopped)
- Gate 5 remains open as a recurring regression lane after current slice completion.

Closure artifact:

- `docs/Tasks/voice_assistant_gate5_closure_evidence_v1.md`

Operational note from fail-closed evidence:

- after `docker start technolohit-rag-api`, readiness may briefly fail during startup; use a short wait loop against `http://127.0.0.1:8080/readyz` before declaring readiness failed.

Gate 5 current-slice closure note:

- this green status does not auto-enable Gate 6
- runtime flags should be reverted after QA window (`VOICE_RAG_ENABLED=false`, `VOICE_RAG_QA_MODE=false`, preview flags `false`)

Future work remains separate from Gate 5 closure:

- TTS speaking speed planning (proposed `VOICE_ASSISTANT_TTS_SPEED`, no implementation in this gate)
- multilingual voice UX planning gate (German default, English next, additional languages only after dedicated QA)

## Update: Gate 6 Rollout Planning Artifact Published

Gate 6 remains planning-only at this stage; no enablement has been executed from this update.

Published runbook:

- `docs/Tasks/sysadmin_voice_bridge_rag_gate6_rollout_v1.md`

Runbook scope:

- controlled production rollout strategy (not blind always-on)
- repo-verified compose reality check and safe override approach
- final preflight checklist before any enablement
- exact enable/revert commands for current host-network stack (`VOICE_RAG_API_URL=http://127.0.0.1:8080`)
- monitoring window commands, decision criteria, and rollback triggers
- productization structure notes as planning-only follow-up

## Update: Gate 6 Strategy Pivot (Lightweight Product Intake)

Date: 2026-05-22

Status:

- Gate 6 remains **NOT stable**
- v12 improved parts of dialogue quality, but product-specific multi-turn state handling proved brittle under real voice/STT noise
- strategy pivot approved: simplify voice role to **intelligent receptionist + lead handoff**

New voice-bridge Gate 6 candidate (v17 — closing incomplete-question guard + contact email path):

- `thnhit/technhvoice:voice-bridge-gate6-closing-guard-email-contact-v17-20260522-2200`
- digest `sha256:ffc3d9b768a3934023d967d0581cbd2900998998fd4d84cbcb3e7d7fff3e0290`

v16 status: **not stable** — protected-tail checks pass; incomplete post-completion fragments (e.g. `Soll ich meinen Unternehmen...`) were closed with warm goodbye; email path must speak configured `VOICE_CONTACT_EMAIL`.

v17 scope:

- closing guard: clarify incomplete/question fragments in `closing_pending` / post-completion follow-up; close only on clear close signals or silence
- logs: `closing_incomplete_question_guard`, `closing_reason=clear_close|silence|incomplete_question_clarified|followup_question`
- email path uses `VOICE_CONTACT_EMAIL` when set (`Sie können uns an … schreiben.`); website fallback when missing

Rollback candidate (v16):

- `thnhit/technhvoice:voice-bridge-gate6-permission-final-question-v16-20260522-2130`
- digest `sha256:13b1c5425d5d1abfd6ff53d14d78c2336d3bb9c43ae9e5900bc4e8411eb974bf`

Architecture impact:

- product pitch and handoff routing are now template/data-driven
- no complex per-product conversational qualification loops
- RAG remains optional for follow-up answers and must not block core product pitch/handoff behavior
- privacy preview flags remain default `false`

## Update: Text QA Harness (v20)

Date: 2026-05-23

- Added `voice-bridge/scripts/qa-dialogue-text.js` for deterministic text-turn simulation
- Exported `processTextTurn()` / `createQaDialogueContext()` from `turn-assistant.js`
- Predefined scenarios cover product intake, business fallback, contact-form regression, and optional RAG
- **Rule:** text QA must pass before live-call Gate 6 matrix; text QA alone does not mark Gate 6 stable

Current Gate 6 voice-bridge candidate after harness packaging fix (v21):

- `thnhit/technhvoice:voice-bridge-gate6-text-qa-harness-v21-20260523-0200`
