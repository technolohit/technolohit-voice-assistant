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

`asterisk/.env` is for Asterisk/SIP settings. Changing only `asterisk/.env` does **not** update voice-bridge flags.

Keep image selection separate from runtime flags:

- Runtime flags: `/opt/technolohit-voice/voice-bridge/.env`
- Image tag: GitHub Actions deploy input, `VOICE_BRIDGE_IMAGE` shell override, or the Compose interpolation env used by `docker compose`

## v3 QA flags (voice-bridge only)

Set these in `/opt/technolohit-voice/voice-bridge/.env`:

```env
VOICE_SEMANTIC_INTENT_ENABLED=true
VOICE_CONVERSATION_REPAIR_ENABLED=true
VOICE_SEMANTIC_INTENT_MODE=deterministic
VOICE_RAG_ENABLED=false
VOICE_RAG_SALES_ANSWERER_ENABLED=false
VOICE_RAG_QA_MODE=false
VOICE_RAG_API_URL=http://technolohit-rag-api:8080
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
