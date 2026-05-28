# Voice Assistant Gate 5 Planning v1 (RAG Fallback QA)

Date: 2026-05-22

## Objective

Prepare Gate 5 validation for `voice-bridge` optional RAG fallback integration while keeping production-safe defaults.

Gate 5 is **QA planning only** at this stage.

## Current baseline

- Gate 1: GREEN
- Gate 2: GREEN
- Gate 3: GREEN
- Gate 4: GREEN
- Gate 5: PENDING
- Gate 6: PENDING

Current runtime invariants:

- `VOICE_RAG_ENABLED=false`
- voice-bridge RAG lookup is not yet implemented in live path
- RAG API is not a hard dependency for live calls
- raw transcript ingestion remains disabled

## Non-negotiable guardrails

1. Deterministic routing wins before RAG:
   - product overview/selection
   - Soft Intake callback/email
   - permission yes/no
   - caller ID consent path
2. RAG timeout/error must not break a call.
3. No raw transcript preview logging by default.
4. No automatic raw call transcript ingestion.
5. Keep production flag off until Gate 5 evidence is green and founder/sysadmin approve.

## Proposed minimal implementation slice for Gate 5 QA

This is the smallest safe slice to validate behavior:

1. Add a small `rag-client` helper in `voice-bridge`:
   - POST `/v1/retrieve`
   - strict timeout using `VOICE_RAG_TIMEOUT_MS`
   - fail-closed (returns no hit on timeout/error)
2. Call helper only in unknown-intent branch after deterministic template + FAQ retrieval miss.
3. Only use RAG hit if:
   - `config.rag.enabled === true`
   - transcript quality is clear
   - not in active product flow
   - not in active soft-intake flow
4. If no valid RAG hit, continue existing safe LLM/unknown fallback path.

## Exclusion list (must never route to RAG)

- `Rückruf bitte`
- `per Anruf`
- `telefonisch`
- `Per E-Mail bitte`
- `Nummer drei` after product overview
- permission yes/no
- caller ID callback consent

## Gate 5 QA test matrix (when implementation slice is ready)

### A) Deterministic control-path protection

Run with `VOICE_RAG_ENABLED=true` in a controlled QA environment:

1. Product overview:
   - Caller: `Welche Produkte bieten Sie an?`
   - Expected: deterministic product list template (no RAG dependency)
2. Product selection:
   - Caller: `Nummer drei`
   - Expected: deterministic Botinteg product template
3. Soft Intake callback:
   - Caller: `Rückruf bitte`
   - Expected: deterministic contact preference flow
4. Permission:
   - Caller: `Ja` / `Nein`
   - Expected: deterministic permission handling only

### B) RAG fallback behavior

1. Knowledge question outside deterministic intents:
   - Caller: `Was ist Botinteg?`
   - Expected: RAG-supported answer path, phone-friendly short response
2. Unknown semantic question:
   - Caller: product/FAQ variant not covered by fixed templates
   - Expected: RAG hit if confidence and score pass threshold
   - QA probes:
     - `Was kann Ihr System mit sensiblen internen Dokumenten machen?`
     - `Kann Ihre Lösung mit sensiblen Daten arbeiten?`
     - `Haben Sie eine private KI für interne Dokumente?`
   - Expected mapping: should retrieve LokalKI/private-knowledge context (or deterministic LokalKI-safe template if router classifies product intent)
3. No-hit scenario:
   - Expected: existing safe unknown fallback

### C) Failure handling

1. RAG API unavailable:
   - stop `technolohit-rag-api`
   - Expected: call continues safely with existing fallback
2. RAG timeout:
   - set short timeout or induce latency
   - Expected: no crash, no blocked turn, safe fallback

## Gate 5 evidence requirements

Gate 5 can be marked green only if:

- deterministic routing tests pass unchanged with `VOICE_RAG_ENABLED=true`
- RAG timeout/unavailable tests pass with no call breakage
- logs remain privacy-safe (`VOICE_LOG_TRANSCRIPT_PREVIEW=false` by default)
- no raw transcript ingestion is introduced
- regression checks for Soft Intake and product router remain green

PASS vs Open-for-Regression definition:

- PASS (current slice): current image + env pass deterministic, semantic RAG, and fail-closed tests in runtime evidence
- OPEN FOR REGRESSION (ongoing): Gate 5 matrix remains reusable and mandatory for future voice quality regressions (RAG quality, callback recognition, STT/dialect robustness, routing behavior, and privacy logging)

## Promotion policy

- Keep `VOICE_RAG_ENABLED=false` in production until Gate 5 evidence is complete.
- Gate 6 (production enablement) needs explicit founder/sysadmin approval.
- Any production enablement should be reversible with a one-variable rollback:
  - `VOICE_RAG_ENABLED=false`

## Execution artifact

Published:

- `docs/Tasks/sysadmin_voice_bridge_rag_fallback_gate5_execution_v1.md`

This runbook contains exact QA enablement/revert, test matrix, evidence collection, pass criteria, and rollback switch.
