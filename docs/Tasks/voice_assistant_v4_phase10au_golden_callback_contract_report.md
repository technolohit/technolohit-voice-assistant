# Phase 10AU — Golden Conversation Contract For Callback Flow + RAG Failure Normalization

Date: 2026-06-10
Release target: `v1.35.3` (`thnhit/technhvoice:voice-bridge-v1.35.3`)
Production status: **v3 / RAG-off unchanged**. v4, RAG, and questionnaire runtime remain **opt-in/default-off**.

## 1. Context — why v1.35.2 failed live

Call session `1fb2e144-86d3-4925-9345-f133c5419209` (supervised canary, `voice-bridge-v1.35.2`):

Transcript: "Was ist eine Smart Webseite, was macht sie und was kostet sie? Bitte rufen Sie mich telefonisch einfach zurück. Dankeschön, telefonisch bitte. Ja. Hallo?"

Observed plan sequence:

| Turn | response_type | plan_reason | Verdict |
| --- | --- | --- | --- |
| 1 | `product_question_answer` | `combined_product_inquiry` | OK |
| 2 | `collect_contact_preference` | `callback_request_intent` | OK |
| 3 | `collect_callback_permission` | `contact_phone_preference` | OK |
| 4 | `collect_callback_permission` | `callback_permission_granted` | OK (grant detected) |
| 5 | `product_question_answer` | `scoped_product_qa` | **WRONG** — "Hallo?" treated as product continuation |

Root problems:

- **A — no protected terminal state.** After `callback_permission_granted` the flow had no finalization stage; the next turn fell back through the generic planner branches.
- **B — no safe no-phone behavior.** With no valid caller phone the assistant neither confirmed manual review nor asked a precise missing-field question.
- **C — attention phrases hijacked.** "Hallo?" matched the closed-domain default (`product_question` with remembered product) and became `scoped_product_qa`.
- **D — RAG evidence broken.** Live RAG failure recorded `rag_attempt_count=1` with an **empty** fallback reason despite `VOICE_RAG_RETRIEVE_MAX_ATTEMPTS=3`: an empty/unnormalized failure reason is not classified as transient, so the retry loop stopped after attempt 1 and the evidence array filtered the empty string out.

## 2. The Golden Conversation Contract

Phase 10AU replaces ad-hoc guards with an explicit, deterministic callback flow lifecycle. New module: `voice-bridge/src/v4/callback-flow-policy.js`.

### 2.1 Lifecycle states (`CALLBACK_FLOW_STATES`, persisted in `memory.callback_flow_state`)

| State | Meaning |
| --- | --- |
| `none` | No callback flow |
| `contact_preference_pending` | Callback requested, preference question open |
| `callback_permission_pending` | Phone preference chosen, permission question open |
| `callback_permission_granted` | Transient grant stage (resolves immediately to finalized/manual review) |
| `callback_finalized` | Grant + valid caller phone → callback recorded |
| `callback_manual_review` | Grant without valid caller phone → manual review confirmed |
| `callback_denied` | Permission refused — flow ended, no callback-ready lead |
| `email_directed` | Caller directed to the e-mail path |

Legacy memories without `callback_flow_state` resolve deterministically from `contact_preference` / `callback_permission` / `contact_flow_pending`, so older builds and snapshots keep working.

### 2.2 Contract rules (enforced in code)

1. Closing remains highest priority (unchanged).
2. Once the callback flow is **active** (any state except `none`/`callback_denied`):
   - `scoped_product_qa` is forbidden. Product QA may resume **only** on an explicit new product question (`product_question` / `product_selection` intent).
   - RAG never runs for callback/contact/permission/manual-review/attention turns (gate blocks `callback_request`, `contact_phone` (planner `rag_allowed=false`), `callback_permission_granted`, `callback_permission_denied`, `callback_flow_attention`).
   - Questionnaire never attaches — both intent-based and **memory-based** (`isCallbackFlowActive`) blocks, so even an explicit product return inside the flow gets no questionnaire.
3. After `callback_permission_granted`:
   - **Valid caller phone** (`hasValidCallerPhone`, same `validatePhoneForCallback` rule the lead validator uses): plan `callback_finalized` / `callback_permission_granted` with final confirmation "Vielen Dank. Ich habe die Anfrage aufgenommen. Unser Team meldet sich telefonisch bei Ihnen." Lead validator may mark callback-ready only when all existing guards pass.
   - **No valid caller phone**: plan `callback_manual_review` / `callback_manual_review_no_phone` with "Vielen Dank. Ich nehme die Anfrage zur manuellen Prüfung auf, damit unser Team sich darum kümmern kann." `lead_ready=false`, lead stays `manual_review` (`validation.allowed=false`, `no_valid_phone_source`); post-call summary/notification still happens — the caller is not left hanging and the assistant never pretends callback-ready.
4. Attention/recovery phrases ("Hallo?", "Sind Sie noch da?", "Ja?", "Okay?") after the decision resolve to the new `callback_flow_attention` intent → plan `callback_reassurance` / `callback_flow_reassurance` which repeats the stage-appropriate confirmation. A repeated callback request after finalization is also reassurance, not a flow restart.
5. The post-call summary never stores "Hallo?", "Ja.", "Okay.", "Danke schön", "telefonisch bitte" (or sequences of them, e.g. "Dankeschön, telefonisch bitte.") as caller need.

## 3. RAG failure normalization and retry (root problem D)

- New `normalizeRetrievalFailure(result)` in `rag-orchestrator.js`: every failed attempt with a missing/empty reason is classified as `request_failed` (transient, retryable) — never empty.
- Thrown retriever errors now normalize to `request_failed` (previously `rag_request_failed`, an undocumented reason that only retried via a special-case flag).
- Retry policy (unchanged set, now reliably triggered): retry `timeout`, `request_failed`, `rag_unavailable`, `http_429`, `http_5xx` up to `VOICE_RAG_RETRIEVE_MAX_ATTEMPTS`; stop on first usable hit; never retry deterministic failures (`rag_miss`, `rag_wrong_product_scope`, `rag_low_score`, `rag_unsafe_or_empty`, `http_4xx`).
- Evidence guarantees:
  - `rag_attempt_count` equals actual attempts (thrown attempts included).
  - `rag_attempt_fallback_reasons` is never empty on failure.
  - `rag_error_reason` is set on every failed final outcome (deterministic fallbacks reuse their `fallback_reason`).
  - `max_attempts` and `timeout_ms` already flow into quality payloads via `buildSafeRagEventDiagnostics`.
- `rag-client.js`: HTTP failure results now include `status`, so `rag_http_status` is populated on failed outcomes.
- Preflight (`rag:live-path-preflight`) shares the same retrieval function and retry loop — unchanged equivalence.

## 4. Changed files

| File | Change |
| --- | --- |
| `voice-bridge/src/v4/callback-flow-policy.js` | **NEW** — lifecycle states, resolver with legacy fallback, attention-phrase matcher, `hasValidCallerPhone`, confirmation/reassurance texts |
| `voice-bridge/src/v4/transcript-intent.js` | `callback_flow_attention` intent for post-decision stages; pending-permission check delegates to policy stage; repeated callback requests inside an active flow stay in the flow |
| `voice-bridge/src/v4/response-planner.js` | New response types `callback_finalized` / `callback_manual_review` / `callback_reassurance`; grant branch splits on valid caller phone; `callback_flow_state` written by every contact-flow memory patch; scoped product QA blocked while flow active unless explicit product return; accepts `callerPhoneNormalized`/`callerPhoneRaw` |
| `voice-bridge/src/v4/dialogue-orchestrator.js` | Passes orchestrator caller-ID phone into the planner |
| `voice-bridge/src/v4/rag-orchestrator.js` | `normalizeRetrievalFailure` (exported), retry loop normalizes every attempt, non-empty `fallback_reason`/`rag_error_reason` on failed final outcomes, gate blocks `callback_flow_attention` |
| `voice-bridge/src/rag-client.js` | HTTP failures include `status` |
| `voice-bridge/src/v4/questionnaire-runtime.js` | Blocks on `callback_flow_attention` intent and on `isCallbackFlowActive(memory)` |
| `voice-bridge/src/post-call-summary.js` | Acknowledgement/attention sequences ("Hallo?", "Dankeschön, telefonisch bitte.") never become caller need |
| `voice-bridge/tests/v4-phase10au-golden-callback-contract.test.js` | **NEW** — golden contract test (see below) |
| `voice-bridge/tests/v4-phase10at-callback-permission-and-rag-retry.test.js` | Grant expectations updated to finalization contract (valid phone → `callback_finalized`) |
| `voice-bridge/tests/v4-phase10u-rag-live-canary-readiness.test.js` | Thrown-error reason expectation updated to normalized `request_failed` |

## 5. Golden Conversation Contract test

`voice-bridge/tests/v4-phase10au-golden-callback-contract.test.js` (11 tests) replays the exact live failure sequence turn-by-turn through the orchestrator harness:

1. "Was ist eine Smart Webseite, was macht sie und was kostet sie?" → `product_question_answer` / `combined_product_inquiry`
2. "Bitte rufen Sie mich telefonisch einfach zurück." → `collect_contact_preference` / `callback_request_intent`
3. "Dankeschön, telefonisch bitte." → `collect_callback_permission` / `contact_phone_preference`
4. "Ja." → `callback_finalized` / `callback_permission_granted` (valid caller ID) or `callback_manual_review` / `callback_manual_review_no_phone` (no caller ID)
5. "Hallo?" → `callback_reassurance` / `callback_flow_reassurance`

Forbidden after turn 2 and asserted on every turn: `product_question_answer`, `scoped_product_qa`, RAG retrieval (retriever call count + gate), `questionnaire_used=true`.

Variants covered:

- valid caller ID → `callback_ready=true`, `next_action=team_callback` via lead candidate/validator
- no caller ID → manual-review confirmation, `callback_ready=false`, `validation.allowed=false`
- "Danke, das reicht erstmal." after grant → closing wins
- explicit new product question after the flow → product QA resumes, still no questionnaire
- refusal → `callback_permission_denied`, no callback-ready lead, e-mail alternative
- attention phrase set + policy lifecycle helpers + RAG gate block
- summary cleanup for "Hallo?"/"Ja."/"Okay."/"Danke schön."/"telefonisch bitte"
- RAG: empty reason normalized to `request_failed` and retried to max attempts; thrown errors retried with non-empty reasons; `normalizeRetrievalFailure` unit checks
- v3 default route and production flags unchanged

## 6. Verification

| Check | Result |
| --- | --- |
| `cd voice-bridge && npm test` | **600/600 pass** |
| `python -m pytest rag-api/tests` | **7/7 pass** |
| `node --check` on all changed JS | pass |
| `git diff --check` | clean |
| `run-ci-dialogue-scenarios.ps1` | **26/26 pass** |

## 7. Confirmations

- `rag-api` code: **unchanged** — no rag-api image publish needed.
- `docs/Tasks/logs.txt`: **untouched**.
- Production defaults remain off: `VOICE_RUNTIME_VERSION=v3`, `VOICE_RAG_ENABLED=false`, `VOICE_V4_QUESTIONNAIRE_RUNTIME_ENABLED=false`; playbook runtime default-off; no production env files modified.
- `turn-assistant.js`: not expanded.
- Closing priority unchanged and covered by tests; callback/contact flow outranks product QA, RAG, interruption recovery, and questionnaire once started.
- No raw transcript, phone, e-mail, or RAG query in quality payloads (asserted in tests).

## 8. Release

- Commit: `8b9f0f4`
- Tag: `v1.35.3`
- Expected image: `thnhit/technhvoice:voice-bridge-v1.35.3`
- Live QA: **not run** — Sysadmin runs one supervised canary only after Codex review.
