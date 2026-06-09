# Phase 10AD — RAG Retrieve Timeout Diagnostics and Gate 3 Readiness Hardening

Date: 2026-06-03  
Target release: **`voice-bridge-v1.34.5`** (pending Codex review — do not tag/publish yet)

## Context

Phase 10AC / v1.34.4 behaved correctly:

| Step | Result |
|------|--------|
| v1.34.4 deploy | safe |
| Stage A baseline | pass |
| Gate 3 compose/runtime preflight | pass |
| `rag:canary-preflight` | pass |
| `rag:retrieve-preflight` | **fail** |
| Live Gate 3 call | **not placed** (correct abort) |

**Retrieve preflight failure (production observation):**

```text
rag_retrieve_preflight=fail
product_scope=smart_website
hit=false
result_count=0
fallback_reason=rag_retrieve_timeout
rag_latency_ms=705
timeout_ms=700
min_score=0.72
failures=rag_retrieve_timeout
```

This is **not** a voice runtime blocker. It is RAG retrieve **latency/timeout readiness**.

## Fix summary

| # | Fix |
|---|-----|
| 1 | Shared `rag-retrieve-probe.js` — payload build, outcome classification |
| 2 | `npm run rag:retrieve-diagnostics` — 5 attempts × 3 timeout budgets (700/1200/2000 ms) |
| 3 | Preflight failure reasons now explicit: `rag_retrieve_timeout`, `rag_miss`, `wrong_product_scope`, `rag_unavailable`, `low_score` |
| 4 | Optional `VOICE_RAG_RETRIEVE_DIAGNOSTIC_TIMEOUT_MS` (diagnostics only, not live runtime) |
| 5 | Docs + runbook decision tree for timeout vs miss |

## New command

```bash
docker exec technolohit-voice-bridge npm run rag:retrieve-diagnostics
```

Default: **5 attempts** per timeout budget at **700 ms** (runtime), **1200 ms**, **2000 ms**.

Optional env (diagnostics only):

```text
VOICE_RAG_RETRIEVE_DIAGNOSTIC_TIMEOUT_MS=<extra budget ms>
VOICE_RAG_RETRIEVE_DIAGNOSTIC_ATTEMPTS=<override attempt count>
```

## Sample diagnostics output (latency budget issue)

When retrieval times out at 700 ms but succeeds at 1200 ms:

```text
rag_retrieve_diagnostics=pass
classification=latency_budget_issue
attempt_count=3
timeout_ms=700
success_count=0
timeout_count=3
hit_count=0
latency_ms_p50=800
fallback_reasons=rag_retrieve_timeout
product_scope=smart_website
payload_tenant_id=technolohit
payload_agent_id=main_voice_sales
budget_timeout_ms=700
budget_hit_count=0
budget_timeout_count=3
budget_fallback_reasons=rag_retrieve_timeout
budget_timeout_ms=1200
budget_hit_count=3
budget_timeout_count=0
budget_fallback_reasons=none
```

**Interpretation:** Knowledge is retrievable but exceeds the Gate 3 runtime timeout budget. Classify as **latency budget issue**, not knowledge miss. Team must decide whether to raise canary `VOICE_RAG_TIMEOUT_MS` before Gate 3.

## Preflight failure distinction (strict, unchanged gate)

`rag:retrieve-preflight` still **fails** if the configured runtime timeout does not produce a hit.

| `fallback_reason` | Meaning | Next action |
|-------------------|---------|-------------|
| `rag_retrieve_timeout` | Request exceeded `VOICE_RAG_TIMEOUT_MS` | Run `rag:retrieve-diagnostics`; do not place Gate 3 call |
| `rag_miss` | Response OK but `result_count=0` | Fix RAG knowledge ingestion |
| `wrong_product_scope` | Payload scope validation failed | Fix agent/scope config |
| `rag_unavailable` | HTTP error / unreachable | Fix RAG API connectivity |
| `low_score` | Hit below `min_score` | Tune content or threshold |

## Gate decision tree

1. `rag:canary-preflight` → must pass  
2. `rag:retrieve-preflight` → must pass at runtime timeout  
3. If preflight fails with `rag_retrieve_timeout` → run `rag:retrieve-diagnostics`  
4. If diagnostics shows `classification=latency_budget_issue` → team decision on canary timeout budget; **no Gate 3 call until preflight passes**  
5. If diagnostics shows `classification=rag_miss` at all budgets → fix knowledge, not voice-bridge  

## Code changes

| File | Change |
|------|--------|
| `voice-bridge/src/v4/rag-retrieve-probe.js` | Shared probe + classification (new) |
| `voice-bridge/src/v4/rag-retrieve-diagnostics.js` | Multi-budget diagnostics (new) |
| `voice-bridge/scripts/rag-retrieve-diagnostics.js` | CLI (new) |
| `voice-bridge/src/v4/rag-retrieve-preflight.js` | Explicit failure reasons via probe |
| `voice-bridge/src/config.js` | `retrieveDiagnosticTimeoutMs` optional env |
| `voice-bridge/package.json` | `rag:retrieve-diagnostics` script |
| `voice-bridge/tests/v4-phase10ad-rag-retrieve-timeout-diagnostics.test.js` | Phase 10AD tests (new) |

## Local verification (2026-06-03)

| Check | Result |
|-------|--------|
| `cd voice-bridge && npm test` | **463/463 pass** |
| `python -m pytest rag-api/tests` | **7/7 pass** |
| `node --check` on changed JS | pass |
| `git diff --check` | pass |
| `run-ci-dialogue-scenarios.ps1` | **26/26 pass** |

## Gate status

| Gate | Status |
|------|--------|
| Gate 2 (v4/RAG-off) | **PASS** (v1.34.3+) |
| Gate 3 (v4/RAG-on) | **Blocked** — retrieve preflight timeout on v1.34.4 |
| Production | **v3 / RAG-off** |

## Constraints preserved

- Production v4 not enabled
- RAG not enabled by default
- No production env file changes from repo
- No live calls run
- No raw query/transcript/phone/email in output or quality payloads
- `turn-assistant.js` untouched
