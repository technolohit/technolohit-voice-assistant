# v4 Phase 10O — Controlled Repeatability and RAG-Enabled Canary Plan

Date: 2026-06-02  
Prerequisite: [Phase 10N report](./voice_assistant_v4_phase10n_interruption_semantic_recovery_report.md) — **v1.25.0 supervised canary PASS** (`call_session_id=9061f2db-713f-4d89-84d0-146e2571eb5f`).

**Phase 10O-A status: FAILED (stopped).** Repeatability failed through v1.28.0. **v1.28.0 / 10R:** PARTIAL/STRONG on interrupts. **10S** addresses post-switch generic Q&A (`Was kostet das?` scoped to `smart_website`). See [10R](./voice_assistant_v4_phase10r_repeated_interruption_stability_report.md), [10S](./voice_assistant_v4_phase10s_product_context_after_interruption_report.md).

**Phase 10O-B (RAG-on): Gate 3 PARTIAL pending v1.34.8 retrieve-timeout validation.** v1.34.6
preflights passed and one valid supervised live Gate 3 call was placed. Human observation was
positive, but live RAG retrieval timed out at about 702 ms and the answer came from playbook
fallback (`rag_used=false`, `rag_fallback_used=true`). v1.34.7 then timed out during retrieve
preflight at the 700 ms budget. **Do not classify Gate 3 as full PASS** until a v1.34.8+ live
call emits `rag_retrieval_completed`, `rag_used=true`, and `rag_result_count>0`.
Gate 2 remains **PASS** (v4/RAG-off).

**Production v4 remains off.** This phase extends evidence; it does **not** enable global production v4.

---

## Goal

1. **Repeatability (RAG off):** Run the v1.25.0 live canary script across **3 supervised PSTN calls** with the same checklist as 10N (interruption, product switch, goodbye, quality SQL).
2. **RAG-enabled canary (one call):** After RAG health check and tenant/agent scoping verification, run **one** supervised call with RAG enabled for product Q&A only — confirm grounded answers and **no** lead-policy regression.

---

## Constraints

| Rule | Detail |
|------|--------|
| Production v4 | **Stay disabled** (`VOICE_RUNTIME_VERSION=v3` default for normal traffic) |
| Canary flags | Existing allowlist + live AudioSocket canary only |
| RAG canary | **Only after** RAG API health check passes and `tenant_id` / `agent_id` scoping matches agent config |
| Deploy | Sysadmin-driven image pin; no blueprint-driven production env change |
| Privacy | Use [10H runbook G.4 corrected privacy query](./voice_assistant_v4_phase10h_live_qa_runbook.md) — not legacy broad numeric scan |

## Phase 10V three-gate requirement

1. Gate 1: v3 baseline health and known-product pricing sanity. Do not test `Stopp` or barge-in on v3.
2. Gate 2: v4/RAG-off control call. This is the required interactive comparison and must prove interruption/product-context behavior. The first known-product opening response must be neither `fallback_clarification` nor `collect_sales_context`.
3. Gate 3: v4/RAG-on canary. Gate 2 passed on v1.34.3; v1.34.6 live call was partial due to live RAG timeout. Retest on v1.34.8+ only, run one supervised call, and roll back immediately after evidence collection.

Gate 3 is invalid unless **all three** checks pass immediately before the call:

1. `bash ../scripts/gate3-compose-runtime-preflight.sh` — authoritative
   `voice-bridge/.env`, rendered Compose config, and container runtime must agree.
2. `docker exec technolohit-voice-bridge npm run rag:canary-preflight` — must
   report `rag_enabled=true` and `rag_sales_answerer_enabled=true`.
3. `docker exec technolohit-voice-bridge npm run rag:retrieve-preflight` — must
   report `rag_retrieve_preflight=pass`, `product_scope=smart_website`, `hit=true`,
   `result_count>0`, and `success_count>=required_success_count`. **Abort Gate 3** on any failure.
4. If step 3 fails with `fallback_reason=rag_retrieve_timeout`, run
   `docker exec technolohit-voice-bridge npm run rag:retrieve-diagnostics`.
   - `classification=latency_budget_issue` → team decision on canary `VOICE_RAG_TIMEOUT_MS`; still no Gate 3 until preflight passes.
   - `classification=rag_miss` at all budgets → fix RAG knowledge ingestion.

---

## Phase 10O-A — Repeatability (3 calls, RAG disabled)

**Image:** `thnhit/technhvoice:voice-bridge-v1.25.0` (or newer patch with 10N code unchanged).

**Per call (same as 10N E5 / G.3):**

1. Product question → intelligible TTS answer  
2. Interrupt: **“Stopp, ich habe eine kurze Frage”** → acknowledgement (not fallback)  
3. **“Was kostet das?”** → bounded playbook answer  
4. **“Stopp, ich meine Smart Website”** (or other product) → switch acknowledged  
5. **“Auf Wiederhören”** → warm goodbye  
6. SQL: `live_call_quality_summary`, `barge_in_detected` (if interrupted), corrected G.4 privacy scan = 0 rows  
7. Rollback env to v3 after window  

**Success:** **3/3** calls classified **PASS** with unique `call_session_id` per call.

---

## Phase 10O-B — RAG-enabled product Q&A (1 call)

**Preconditions (all required):**

```bash
# RAG health from voice-bridge host network
curl -sS -o /dev/null -w "%{http_code}" http://127.0.0.1:8080/healthz
# Expect 200

# Confirm env (canary only — not production default)
# VOICE_RAG_API_URL=http://127.0.0.1:8080
# VOICE_RAG_ENABLED=true
# VOICE_RAG_SALES_ANSWERER_ENABLED=true
# tenant_id=technolohit agent_id=main_voice_sales in agent config
```

Enable RAG for canary only (operator documents exact env keys used; do not commit secrets). Use `voice-bridge-v1.34.3` or newer with Phase 10U product-scope guardrails, Phase 10X product-introduction behavior, and Phase 10AB first-turn combined-inquiry scoping.

**Call script:**

1. Select or switch to **Smart Website**.
2. Ask `Was kostet das?`, `Wie funktioniert das?`, `Was kann das?`, and `Erklar mir das kurz.`
3. Confirm every answer remains scoped to Smart Website unless the caller explicitly changes product.
4. During playback say `Stopp. Wie funktioniert das?`; confirm the continuation still uses Smart Website RAG scope.
5. Confirm answers are **grounded**: no forbidden claims, no invented exact prices, no unsupported features.
6. Confirm `lead_ready`, callback, and contact flows are not triggered by RAG answers alone.
7. Verify `rag_retrieval_started`, `rag_retrieval_completed` or `rag_retrieval_failed`, response-plan RAG fields, quality summary counts, and corrected privacy scan.
8. If a controlled RAG failure test is approved, confirm the assistant gives a short product playbook answer without silence, crash, or fallback loop.

**Success:** **1/1** call **PASS** — grounded product-scoped Q&A, safe failure behavior, lead policy unchanged, no raw query/transcript/PII in quality payloads.

---

## Stop criteria (abort window)

Stop immediately and roll back to v3 if any of:

| # | Condition |
|---|-----------|
| 1 | Fallback loop (“nicht verstanden” / clarification repeated ≥ 2× without progress) |
| 2 | Wrong product context after interruption (stale product answer) |
| 3 | Corrected G.4 privacy scan **> 0 rows** (real phone/transcript leak — not telemetry false positive) |
| 4 | New stale `call_session` after hangup |
| 5 | STT failure on normal-length utterance (no fallback prompt heard) |
| 6 | TTS choppy or long silence after successful STT |
| 7 | Barge-in does not cancel playback when caller speaks during assistant audio |
| 8 | `quality_flush_skip_event` on capstone events (`live_call_quality_summary`, `barge_in_detected`) |
| 9 | RAG answer uses a product other than `current_product_context` without an explicit product switch |
| 10 | Raw query, transcript, phone, email, or lead details appear in RAG or quality payloads |

---

## Success criteria (phase complete)

| Track | Criterion |
|-------|-----------|
| 10O-A | **3/3** supervised calls **PASS** with RAG **disabled** |
| 10O-B | **1/1** supervised call **PASS** with RAG **enabled** for product Q&A; grounded answer; no lead creation from RAG turn |
| Overall | Production v4 still **not** globally enabled; blueprint updated with 10O results |

---

## Deliverables

- One row per call in a short **10O results** section (append to this doc or separate `voice_assistant_v4_phase10o_canary_results.md` when executed)  
- Update [blueprint](./voice_assistant_v4_realtime_tenant_ready_blueprint.md) when 10O-A and 10O-B complete  
- No change to `docs/Tasks/logs.txt` from agent tasks  

---

## References

- [Phase 10H live QA runbook](./voice_assistant_v4_phase10h_live_qa_runbook.md)  
- [Phase 10N interruption recovery report](./voice_assistant_v4_phase10n_interruption_semantic_recovery_report.md)  
- [Phase 10M summary/latency report](./voice_assistant_v4_phase10m_live_summary_latency_closing_report.md)
