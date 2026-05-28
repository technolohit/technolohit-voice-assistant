# Sysadmin Guide: Voice Bridge Knowledge Retrieval v1

Date: 2026-05-21

## Purpose

Verify FAQ retrieval executes before unknown LLM fallback.

## Required Env

```env
VOICE_KNOWLEDGE_RETRIEVAL_ENABLED=true
VOICE_KNOWLEDGE_RETRIEVAL_MIN_SCORE=2
```

## Deploy

```bash
cd /opt/technolohit-voice/asterisk
docker compose -f docker-compose.yml -f docker-compose.prod.yml pull voice-bridge
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d voice-bridge
```

## Manual QA Scenarios

1) Caller asks: `Was soll ich in der E-Mail schreiben?`
- Expected: deterministic answer about three points (goal/current status/callback number), no generic marketing.

2) Caller asks: `Wie lange dauert die Umsetzung?`
- Expected: deterministic duration-dependent answer from FAQ.

3) Caller asks unrelated unclear text:
- Expected: existing unknown fallback behavior.

## Log Verification

```bash
docker logs --since=20m technolohit-voice-bridge \
| egrep -i 'response created|used_template_response|used_llm_response|ERROR|WARNING' || true
```

Success pattern for retrieval hit:
- `normalized_intent=knowledge_retrieval_answer`
- `used_template_response=true`
- `used_llm_response=false`
