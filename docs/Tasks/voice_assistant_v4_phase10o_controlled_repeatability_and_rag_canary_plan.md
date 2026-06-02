# v4 Phase 10O — Controlled Repeatability and RAG-Enabled Canary Plan

Date: 2026-06-02  
Prerequisite: [Phase 10N report](./voice_assistant_v4_phase10n_interruption_semantic_recovery_report.md) — **v1.25.0 supervised canary PASS** (`call_session_id=9061f2db-713f-4d89-84d0-146e2571eb5f`).

**Phase 10O-A status: FAILED (stopped).** Repeatability failed through v1.28.0. **v1.28.0 / 10R:** PARTIAL/STRONG on interrupts. **10S** addresses post-switch generic Q&A (`Was kostet das?` scoped to `smart_website`). See [10R](./voice_assistant_v4_phase10r_repeated_interruption_stability_report.md), [10S](./voice_assistant_v4_phase10s_product_context_after_interruption_report.md).

**Phase 10O-B (RAG-on): BLOCKED** until Phase 10O-A passes on **v1.29.0+**.

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
curl -sS -o /dev/null -w "%{http_code}" http://127.0.0.1:8080/health
# Expect 200

# Confirm env (canary only — not production default)
# VOICE_RAG_API_URL or documented host-local URL
# tenant_id=technolohit agent_id=main_voice_sales in agent config
```

Enable RAG for canary only (operator document exact env keys used; do not commit secrets).

**Call script:**

1. Select product (e.g. Smart Website)  
2. Ask a product question answerable from TechnoloHit knowledge (not pricing-only playbook)  
3. Confirm answer is **grounded** (no forbidden claims; no invented pricing guarantees)  
4. Confirm **lead_ready** / callback flows are **not** triggered by RAG answer alone  
5. Quality flush + privacy scan (corrected G.4)  

**Success:** **1/1** call **PASS** — grounded product Q&A; lead policy unchanged.

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
