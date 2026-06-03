# Voice Assistant v4 Phase 10W - Gate 3 Preflight and Product Opening Report

Date: 2026-06-03
Status: **Implementation complete; supervised live validation required**
Target release: `voice-bridge-v1.31.0`

## Incident

Phase 10V Gate 3 was invalid. The expected v4/RAG-on canary ran with both RAG
flags false inside the running container:

```text
VOICE_RAG_ENABLED=false
VOICE_RAG_SALES_ANSWERER_ENABLED=false
```

The call session was:

```text
d925e5c7-3529-41fb-840a-fcd7dd8caf2f
```

The call therefore provides no RAG-on quality evidence.

## Root Causes

### Missing hard Gate 3 runtime guard

The runbook described the desired env values but did not require a hard
in-container preflight after the container was recreated. A change to the wrong
file, a missing recreate, or a v3 verifier could leave RAG disabled while the
operator believed Gate 3 was active.

### Product opening fallback

The v4 closed-domain matcher correctly recognized variants such as
`Smart-Webseite` and `smarte Webseite` as `smart_website`, but the shared
transcript intent remained `unclear`. The response planner then emitted
`fallback_clarification` even though a high-confidence product match existed.

## Changes

### Hard RAG-on canary preflight

New command:

```bash
docker exec technolohit-voice-bridge npm run rag:canary-preflight
```

It fails unless the running container has:

- v4 runtime selected;
- realtime/canary/live AudioSocket gates enabled;
- non-empty live canary allowlist;
- `VOICE_RAG_ENABLED=true`;
- `VOICE_RAG_SALES_ANSWERER_ENABLED=true`;
- configured and healthy RAG API.

Output is privacy-safe and does not include secrets, URLs, transcripts, RAG
queries, phone numbers, emails, or lead data.

The deploy workflow also supports `verify_v4_rag_canary_env=true`.

### Smart Website opening recovery

The shared v4 transcript intent now treats a valid configured product alias as
`product_selection`, including punctuation and inflection variants such as:

- `Smart-Webseite`;
- `smarte Webseite`;
- other configured aliases.

This prevents a high-confidence product match from falling through to generic
clarification.

## Safety

- Production v4 remains disabled by default.
- RAG remains disabled by default.
- No production env file was changed.
- No global RAG enablement was performed.
- v3 behavior is unchanged.
- `docs/Tasks/logs.txt` is not part of this change.

## Files Changed

| Area | Files |
|------|-------|
| Gate 3 preflight | `voice-bridge/src/v4/rag-canary-preflight.js`, `voice-bridge/scripts/rag-canary-preflight.js`, `voice-bridge/package.json` |
| Product opening recovery | `voice-bridge/src/v4/transcript-intent.js` |
| Deploy guard | `.github/workflows/deploy.yml` |
| Tests | `voice-bridge/tests/v4-phase10w-rag-gate3-preflight.test.js` |
| Docs | Phase 10W report, Phase 10H runbook, Phase 10O plan, Phase 10U report, runtime env doc, release/CICD doc, main blueprint |

## Verification

| Check | Result |
|------|--------|
| `cd voice-bridge && npm test` | `397/397` passed |
| `python -m pytest rag-api/tests` | `7/7` passed |
| `voice-bridge/scripts/run-ci-dialogue-scenarios.ps1` | `26/26` passed |
| `node --check` on changed JS | passed |
| `git diff --check` | clean |

## Required Live Validation

1. Deploy the next voice-bridge image.
2. Run Gate 2 v4/RAG-off control first.
3. Set Gate 3 env in `/opt/technolohit-voice/voice-bridge/.env`.
4. Recreate voice-bridge.
5. Run `npm run rag:canary-preflight` inside the container.
6. Abort if it does not pass.
7. Only then place the RAG-on call.
