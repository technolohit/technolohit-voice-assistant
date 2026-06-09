# Phase 10AI — RAG Content Extraction Hotfix

Date: 2026-06-09  
Target release: **`voice-bridge-v1.34.10`**

## Context

Phase 10AH / `v1.34.9` fixed live-path equivalence, but the new live-path preflight still failed after a successful retrieval:

| Field | Result |
|-------|--------|
| Raw retrieve | `pass`, `result_count=1`, `hit=true`, `top_score=0.780385` |
| Live path | `fail`, `used_rag=false`, `result_count=1`, `result_count_after_product_filter=1` |
| Failure | `fallback_reason=rag_unsafe_or_empty` |

This proved that retrieval, score, and product filtering were working. The remaining failure was in the answer extraction/safety layer.

## Root Cause

The RAG API response model returns chunks with a `content` field:

```text
RetrievedChunk.content
```

The voice-bridge live RAG answer builder only read:

```text
chunk.snippet || chunk.text
```

So real API chunks could pass retrieval and product filtering, but produce an empty answer candidate and fall back as `rag_unsafe_or_empty`.

## Fix

`buildAnswerFromChunks()` now accepts RAG API `content` chunks:

```text
chunk.snippet || chunk.text || chunk.content
```

## Test Coverage

Added a regression test to the Phase 10AH suite:

- content-only RAG API chunk
- `rag:live-path-preflight` equivalent path
- expected `used_rag=true`
- expected `result_count_after_product_filter=1`
- expected `fallback_reason=null`

## Gate Status

| Gate | Status |
|------|--------|
| Gate 2 | PASS |
| Gate 3 | Pending retry on `voice-bridge-v1.34.10` |
| Production | v3 / RAG-off |

## Constraints Preserved

- No production v4 enablement
- No production env changes
- `turn-assistant.js` untouched
- RAG API image unchanged
- No raw transcript/query/PII added to quality payloads
