# Phase 10AE — Gate 3 Preflight Pass

Date: 2026-06-09  
Image: `thnhit/technhvoice:voice-bridge-v1.34.6`  
Commit: `22053633fb1a7c9b4f267154c69dbd3a4537e0a0`

## Scope

This was a **preflight-only** Gate 3 retry. No live Gate 3 call was placed. Production v4 was not enabled globally and the system was restored to v3/RAG-off after evidence collection.

## Result

| Check | Result |
|------|--------|
| Safe v3/RAG-off baseline | PASS |
| Stage A compose/runtime baseline preflight | PASS |
| Gate 3 compose/runtime preflight | PASS |
| `rag:canary-preflight` | PASS |
| `rag:retrieve-preflight` | PASS |
| Live Gate 3 call | NOT RUN |
| Rollback to v3/RAG-off | PASS |

## Retrieve Preflight Evidence

```text
rag_retrieve_preflight=pass
product_scope=smart_website
result_count=1
hit=true
top_score=0.7676192856897699
fallback_reason=none
payload_tenant_id=technolohit
payload_agent_id=main_voice_sales
rag_retrieve_ok=true
rag_http_status=200
rag_latency_ms=585
timeout_ms=700
attempt_count=3
success_count=2
required_success_count=2
timeout_count=1
attempt_fallback_reasons=rag_retrieve_timeout
min_score=0.72
failure_count=0
failures=none
```

## Interpretation

The v1.34.6 jitter-guarded retrieve preflight worked as intended:

- Smart Website retrieval succeeded.
- The required majority threshold passed: `success_count=2`, `required_success_count=2`.
- One retrieve attempt still timed out, so RAG latency should remain monitored during the live canary.
- This is sufficient to approve **one supervised Gate 3 live call**.

## Decision

Approved next step: **one supervised Gate 3 v4/RAG-on live call only**, followed by immediate rollback to v3/RAG-off and evidence review.

Production v4 remains globally disabled.
