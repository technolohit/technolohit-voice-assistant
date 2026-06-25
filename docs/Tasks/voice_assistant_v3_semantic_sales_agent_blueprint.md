# TechnoloHit Voice Assistant v3 Semantic Sales Agent Blueprint

Date: 2026-05-30

## Purpose

Design the next architecture for the TechnoloHit Voice Assistant so it can behave like a real sales receptionist, not like a scripted phone form.

This blueprint is intentionally strategic and implementation-oriented. It exists because the v1/v2 path exposed a deeper issue:

```text
The assistant is too dependent on exact transcripts, fixed stages, regex-style intent matching, and repeated clarification prompts.
```

The goal of v3 is not to add more synonyms. The goal is to build a semantic, RAG-assisted, sales-first voice agent that can tolerate imperfect German, accents, non-native speakers, noisy PSTN audio, and rough ASR transcripts.

Primary target:

```text
When a caller asks about a TechnoloHit product, the assistant should understand the business intent, explain the product naturally, ask one useful sales question at a time, and collect a qualified lead only after enough context exists.
```

- [ ] Successful: Team accepts that v3 is an architecture redesign, not another synonym hotfix.
- [ ] Successful: Cursor reviews this blueprint before touching code.
- [ ] Successful: Production safety and rollback strategy are agreed before deploy.

## Current Failure Evidence

Live call evidence from v1.2.1 showed:

```text
Caller: AI Assistant, bitte.
Assistant: Die digitale Rezeption nimmt Anrufe an, beantwortet erste Fragen und bereitet Leads vor.
           Geht es um Ihr eigenes Unternehmen oder um ein Kundenprojekt?

Caller: Eigenunternehmen.
Assistant: Sagen Sie bitte kurz: eigenes Unternehmen, Kundenprojekt oder bereits Kunde.

Caller: Eigene Unternehmen.
Assistant: Sagen Sie bitte kurz: eigenes Unternehmen, Kundenprojekt oder bereits Kunde.
```

The database transcript also showed ASR outputs such as:

```text
Aino, der Name.
Ai generasyon tanim.
Eigenunternehmen.
Eigene Unternehmen.
Bereits Kunde.
```

This means the system is failing at multiple layers:

- ASR/transcription is not reliable enough for exact matching.
- The conversation engine treats rough transcripts too literally.
- The assistant repeats the same prompt instead of repairing the conversation.
- Lead metadata can become misleading because later turns overwrite earlier business context.
- RAG is not yet acting as the assistant's sales brain.
- The current `turn-assistant.js` is carrying too many responsibilities.

Important conclusion:

```text
This is not a Node.js problem by itself.
This is an architecture problem: speech recognition, semantic intent, conversation repair, RAG grounding, and lead policy are not separated cleanly.
```

- [x] Successful: v1.2.1 live-call failure is documented.
- [x] Successful: Team accepts that exact transcript matching is not enough.

## Non-Goals

Do not solve v3 by only adding more regexes.

Do not let an LLM directly:

- create callback-ready leads
- validate phone numbers
- mark permission as granted
- expose full phone numbers in notifications
- invent prices, guarantees, legal promises, or implementation timelines
- bypass DSGVO/GDPR privacy rules

Do not remove the existing production system until v3 is tested behind flags and rollback is proven.

- [ ] Successful: Team agrees not to replace production blindly.
- [ ] Successful: Deterministic privacy and lead guards remain mandatory.

## Strategic Decision

Recommended v3 architecture:

```text
Audio/ASR diagnostics
  -> semantic intent interpreter
  -> sales dialogue manager
  -> RAG grounded answerer
  -> deterministic privacy/contact/lead policy
  -> post-call summary and notification
```

Keep deterministic code for:

- call session lifecycle
- privacy greeting mode
- caller ID handling
- phone/email capture
- phone validation
- contact permission
- lead write guards
- audit/logging redaction
- max-turn protection
- post-call summary pipeline
- webhook notification without phone number

Use semantic/LLM/RAG for:

- interpreting noisy caller text
- mapping rough ASR variants to likely intent
- deciding the next best sales question
- explaining product value from approved knowledge
- handling objections
- repairing misunderstood turns
- producing structured non-sensitive sales context

Required principle:

```text
LLM/RAG may recommend conversation actions.
Deterministic policy decides whether sensitive actions are allowed.
```

- [ ] Successful: v3 architecture approved.
- [ ] Successful: Sensitive actions remain deterministic.

## Core Design: Semantic Intent Interpreter

Create a new module, for example:

```text
voice-bridge/src/semantic-intent.js
```

Purpose:

Take the latest caller transcript, recent dialogue state, current stage, and product context, then return structured intent.

Example output:

```json
{
  "intent": "customer_type",
  "value": "new_prospect",
  "confidence": 0.72,
  "evidence": "Caller likely means own company despite ASR variant 'Eigenunternehmen'.",
  "repair_needed": false
}
```

Allowed intent families:

- `product_interest`
- `product_question`
- `customer_type`
- `need_or_pain`
- `existing_customer_identifier`
- `contact_preference`
- `phone_number_candidate`
- `email_candidate`
- `permission`
- `unclear`
- `off_topic`
- `goodbye`

Allowed `customer_type` values:

- `new_prospect`
- `existing_customer`
- `agency_partner`
- `unknown`

Semantic examples that must be accepted:

```text
Eigenunternehmen                  -> customer_type:new_prospect
Eigene Unternehmen                -> customer_type:new_prospect
für meine Firma                   -> customer_type:new_prospect
mein Geschäft                     -> customer_type:new_prospect
Kundenprojekt                     -> customer_type:agency_partner
für einen Kunden                  -> customer_type:agency_partner
Bereits Kunde                     -> customer_type:existing_customer
Kundennummer                      -> customer_type:existing_customer
die erste                         -> customer_type:new_prospect, only if previous options were own/company, customer project, existing customer
die zweite                        -> customer_type:agency_partner, same context
die dritte                        -> customer_type:existing_customer, same context
```

Confidence policy:

- `>= 0.75`: accept and proceed.
- `0.45 - 0.74`: proceed with a soft confirmation embedded in the next useful question.
- `< 0.45`: repair once, then choose a safe broad path or offer human contact.

Example medium-confidence repair:

```text
Ich nehme an, es geht um Ihr eigenes Unternehmen. Was möchten Sie mit dem AI Assistant verbessern: weniger verpasste Anrufe, bessere Lead-Erfassung oder schnellere Antworten?
```

Do not repeat the same clarification more than once.

- [x] Successful: Semantic intent module created.
- [x] Successful: Structured intent schema validated.
- [x] Successful: Low-confidence output fails closed.
- [x] Successful: Medium-confidence output can proceed with soft confirmation.

## Core Design: Conversation Repair Policy

Create a new module, for example:

```text
voice-bridge/src/conversation-repair.js
```

Purpose:

Stop loops and make the assistant behave like a patient human.

Rules:

1. Never ask the exact same clarification twice in a row.
2. After one failed clarification, switch wording or infer the most likely safe path.
3. If the caller repeatedly struggles, offer an easier route:

```text
Kein Problem. Ich kann Ihr Anliegen kurz aufnehmen und unser Team meldet sich. Geht es eher um Website, Telefonassistent oder Automatisierung?
```

4. If product interest is already known, do not go back to the product menu.
5. If customer type is unclear but product interest is clear, continue with a general sales question.

Example:

```text
Caller: Eigenunternehmen.
Assistant should not repeat:
Sagen Sie bitte kurz: eigenes Unternehmen, Kundenprojekt oder bereits Kunde.

Assistant should say:
Alles klar, ich ordne das als eigenes Unternehmen ein. Was möchten Sie mit dem AI Assistant verbessern?
```

- [x] Successful: Same-prompt loop prevention implemented.
- [x] Successful: Customer type repair works for rough ASR.
- [x] Successful: Product flow does not reset unnecessarily.

## Core Design: RAG Sales Brain

RAG must become the product knowledge layer, but with strict guardrails.

Create or refactor toward:

```text
voice-bridge/src/rag-sales-answerer.js
```

Input:

- caller question
- current product interest
- recent dialogue summary
- approved sales playbook
- RAG context chunks

Output:

```json
{
  "answer": "short German voice response",
  "next_question": "one useful sales question",
  "used_rag": true,
  "confidence": "high|medium|low",
  "safety": {
    "contains_price_claim": false,
    "contains_guarantee": false,
    "contains_private_data": false
  }
}
```

RAG behavior:

- Answer product and company questions before trying to capture contact.
- Keep responses short enough for phone.
- Use business value language, not technical documentation language.
- Ask one next question after answering.
- If RAG fails or times out, use approved playbook fallback.
- If caller asks something out of scope, say that the team can clarify.

Example:

```text
Caller: Was bringt mir der AI Assistant?
Assistant: Er kann Anrufe annehmen, erste Fragen beantworten und wichtige Infos für Ihr Team vorbereiten. Besonders hilfreich ist das, wenn Anfragen verloren gehen oder niemand immer ans Telefon kann. Geht es bei Ihnen eher um mehr Erreichbarkeit oder bessere Lead-Erfassung?
```

- [x] Successful: RAG answerer module exists.
- [x] Successful: RAG timeout remains safe.
- [x] Successful: RAG answers are grounded and short.
- [x] Successful: RAG never writes leads directly.

## ASR / Speech Recognition Strategy

The current system cannot be improved reliably without measuring ASR quality.

Required diagnostics before replacing providers:

1. Capture short caller audio snippets for QA only when legally/configurationally allowed.
2. Store or export:
   - audio snippet id
   - ASR transcript
   - expected intent
   - actual intent
   - confidence
   - stage
   - model/provider
3. Build a small local evaluation dataset from real failed calls.

Potential ASR options to evaluate:

- Current ASR path, improved with prompts/context if supported.
- OpenAI `gpt-4o-transcribe` for higher-quality transcription.
- OpenAI Realtime speech-to-speech or SIP path for a more voice-native architecture.
- Deepgram Nova-style German STT provider if latency/cost/accuracy is better.
- Twilio Media Streams / Conversation Relay if telephony stack migration becomes acceptable.

Decision rule:

```text
Do not guess the best ASR provider. Evaluate real TechnoloHit call audio against at least two candidate paths.
```

Important:

- ASR evaluation must respect DSGVO/GDPR.
- Audio retention must be short and documented.
- Do not store unnecessary full recordings forever.
- Redact or restrict access to personal data.

- [ ] Successful: ASR diagnostics plan approved.
- [ ] Successful: Real-call failed transcript dataset created.
- [ ] Successful: At least two ASR options evaluated.
- [ ] Successful: Provider decision documented.

## Target Conversation Model

### Stage 1: Understand Interest

Good behavior:

```text
Caller: AI Assistant bitte.
Assistant: Gerne. Ich meine damit unsere digitale Rezeption: Sie nimmt Anrufe an, beantwortet erste Fragen und bereitet Leads vor. Geht es um Ihr eigenes Unternehmen oder um ein Kundenprojekt?
```

If caller says only:

```text
AI Assistant.
```

Do not ask for phone number. Do not ask product menu. Present value first.

- [x] Successful: Product interest is understood from short phrases.
- [x] Successful: No immediate phone capture after product interest.

### Stage 2: Identify Caller Context

Accepted context:

- own company
- customer project / agency / partner
- existing customer
- unclear

If unclear, ask once. If still unclear, proceed with a general question.

- [x] Successful: Own-company variants work.
- [x] Successful: Agency/customer-project variants work.
- [x] Successful: Existing-customer variants work.
- [x] Successful: Repeated unclear input does not loop.

### Stage 3: Sell And Qualify

Ask questions like:

- What should the assistant improve?
- Are missed calls a problem?
- Should it answer common questions?
- Should it prepare leads for your team?
- Is this for one website/number or multiple customer projects?

Do not ask all questions. Ask one useful question at a time.

- [x] Successful: Assistant asks one useful sales question.
- [x] Successful: Assistant does not sound like a form.

### Stage 4: Handoff

Only after business context:

```text
Das klingt passend. Soll unser Team das telefonisch mit Ihnen prüfen, oder möchten Sie lieber per E-Mail starten?
```

Then deterministic contact capture begins.

- [x] Successful: Handoff happens after business context.
- [x] Successful: Contact capture remains privacy-safe.

## Lead Policy

Lead creation must require:

- product interest
- useful caller need or sales context
- contact path, if callback-ready
- deterministic permission/contact validation

If contact path is missing but business context exists:

```text
next_action = manual_followup or manual_review
```

If no usable phone exists:

- `phone_present` must not be true
- `permission` must not be granted for callback
- `next_action` must not be `team_callback`

If customer type changes mid-call:

- do not blindly overwrite with the latest noisy turn
- store confidence and evidence
- prefer higher-confidence semantic classification

- [x] Successful: Lead policy rejects fake callback-ready leads.
- [x] Successful: Lead metadata includes confidence/evidence.
- [x] Successful: Noisy late turns do not overwrite stronger earlier context.

## Proposed File Layout

Create or refactor toward:

```text
voice-bridge/src/
  semantic-intent.js
  conversation-repair.js
  sales-dialogue-manager.js
  rag-sales-answerer.js
  lead-policy.js
  asr-diagnostics.js

voice-bridge/tests/
  semantic-intent.test.js
  conversation-repair.test.js
  sales-dialogue-manager.test.js
  rag-sales-answerer.test.js
  lead-policy.test.js

voice-bridge/fixtures/
  live-call-failures/
    v1_2_1_customer_type_loop.json

docs/Tasks/
  voice_assistant_v3_semantic_sales_agent_report.md
```

`turn-assistant.js` should become thinner. It should orchestrate modules, not contain all sales, RAG, repair, and lead policy logic inline.

- [x] Successful: File layout accepted.
- [x] Successful: `turn-assistant.js` responsibility reduced.

## 2026-06-11 Architecture Update: Agent Behavior Layer Track

The supervised v4 canary sequence through `voice-bridge-v1.35.3` showed a useful but uncomfortable pattern: individual fixes can improve one live symptom, but the assistant will remain fragile if business behavior is spread across ad hoc planner branches.

Recent canary evidence confirmed important progress:

- live Smart Website RAG answer can work (`rag_retrieval_completed`, `rag_used=true`, scoped to `smart_website`)
- callback/contact flow can reach manual review safely
- RAG and questionnaire can be suppressed after callback flow starts
- closing intent can override product continuation
- post-call summary, notification, privacy scan, and rollback can work safely

The remaining architecture decision is:

```text
Runtime engine changes rarely.
Business behavior changes through versioned playbooks.
Every playbook version has eval scenarios.
No canary without passing eval.
No production rollout without repeatability.
```

This is **not** a new framework from scratch. The repository already contains related pieces that should be consolidated:

- `voice-bridge/config/playbooks/technolohit.main_voice_sales.v1.json`
- `voice-bridge/src/v4/playbook-loader.js`
- `voice-bridge/src/v4/behavior-policy.js`
- `voice-bridge/src/v4/playbook-eval-scenarios.js`
- `voice-bridge/src/v4/playbook-questionnaire-generator.js`
- `voice-bridge/src/v4/questionnaire-runtime.js`
- `voice-bridge/src/v4/callback-flow-policy.js`
- `voice-bridge/src/v4/response-planner.js`

Source-of-truth rule:

```text
docs/TechnoloHit Product Playbook v1.md
  = human/founder-approved source

voice-bridge/config/playbooks/technolohit.main_voice_sales.v1.json
  = schema-validated runtime source

playbook eval scenarios
  = quality gate before canary
```

Markdown must not be loaded directly at call time. Runtime must use a schema-validated JSON/YAML playbook with explicit `playbook_version`, status, approval, and runtime binding.

The next work track keeps this existing v3 blueprint as the main source of truth. No separate blueprint is created unless a later implementation phase genuinely needs a long-form design addendum. If that happens, this file must link to it and remain the main entry point.

### Agent Behavior Layer Decision Object

The intended consolidation point is a small deterministic decision object shared by planner, RAG, questionnaire, callback/contact flow, and quality events.

Example:

```json
{
  "priority": "callback_flow",
  "response_type": "callback_manual_review",
  "product_id": "smart_website",
  "playbook_version": "technolohit-playbook-v1",
  "rag_allowed": false,
  "questionnaire_allowed": false,
  "lead_tier": "manual_review",
  "next_action": "post_call_notification",
  "reason": "callback_permission_granted_no_valid_phone",
  "suppressed_intents": ["product_context_continuation", "questionnaire"]
}
```

Required priority contract:

1. Closing intent
2. Active callback/contact flow continuation
3. Safety / role boundary
4. Explicit new product question
5. Product context continuation
6. Product-specific qualification question
7. Questionnaire
8. Generic fallback clarification

Rules:

- RAG provides product answer content only; it must not decide conversation priority.
- Questionnaire runs only when the Agent Behavior Layer allows it.
- Callback/contact flow remains higher priority than product continuation unless the caller asks a new explicit product question.
- Lead readiness remains deterministic and cannot be granted by RAG or questionnaire.
- Complex email addresses, website URLs, company names, keywords, and competitor lists should be routed to contact form instead of captured by voice.

## Implementation Phases

### Phase 0: Freeze And Baseline

- Keep production on the safest currently deployed tag.
- Do not deploy more v2 sales changes unless they fix an urgent production bug.
- Add the v1.2.1 failed call as a QA fixture.
- Document current deployed image and env.

- [ ] Successful: Production baseline documented.
- [x] Successful: v1.2.1 failure fixture added.

### Phase 1: Semantic Intent Layer

- Implement `semantic-intent.js`.
- Start with deterministic + optional LLM mode behind env flags.
- Return structured JSON only.
- Add tests for noisy German/non-native variants.

Suggested env:

```env
VOICE_SEMANTIC_INTENT_ENABLED=false
VOICE_SEMANTIC_INTENT_MODE=deterministic
VOICE_SEMANTIC_INTENT_MODEL=
VOICE_SEMANTIC_INTENT_MIN_ACCEPT=0.75
VOICE_SEMANTIC_INTENT_MIN_SOFT=0.45
```

- [x] Successful: Semantic intent layer implemented behind flag.
- [x] Successful: Noisy customer type tests pass.

### Phase 2: Conversation Repair

- Implement prompt loop detection.
- Track last clarification prompt type.
- If same stage fails twice, infer safe path or ask a broader question.
- Add tests for repeated `Eigenunternehmen`.

- [x] Successful: No repeated same prompt.
- [x] Successful: Medium-confidence customer type proceeds safely.

### Phase 3: Sales Dialogue Manager

- Move sales stage logic out of `turn-assistant.js`.
- Implement state transitions:
  - `interest_detected`
  - `context_identification`
  - `value_answer`
  - `need_discovery`
  - `handoff_offer`
  - `contact_capture`
  - `manual_review`
- Ensure only one question per assistant response.

- [x] Successful: Sales dialogue manager exists.
- [x] Successful: One-question rule tested.

### Phase 4: RAG Sales Answerer

- Integrate RAG as a grounded product answerer behind QA flag.
- Use approved sales playbooks as fallback.
- Fail closed on timeout/unavailable.
- Do not enable for all production calls yet.

Suggested env:

```env
VOICE_RAG_ENABLED=false
VOICE_RAG_QA_MODE=true
VOICE_RAG_SALES_ANSWERER_ENABLED=false
```

- [x] Successful: RAG sales answerer works in local QA.
- [x] Successful: RAG failure does not break calls.

### Phase 5: ASR Diagnostics

- Add logging/DB metadata for ASR provider/model, confidence if available, and semantic confidence.
- Add optional QA-only audio snippet capture if legal/configuration approved.
- Create eval script that replays failed transcripts and expected intents.

- [x] Successful: ASR diagnostics implemented.
- [x] Successful: Real failed calls can be evaluated offline.

### Phase 6: Lead Policy Hardening

- Create or refactor `lead-policy.js`.
- Prevent noisy late turns from overwriting better earlier sales context.
- Add confidence/evidence fields to metadata.
- Keep callback-ready rules strict.

- [x] Successful: Lead metadata is stable and useful.
- [x] Successful: Callback-ready lead requires valid contact path.

### Phase 7: CI QA Matrix

Add dialogue QA scenarios for:

```text
AI Assistant bitte -> own-company rough variants -> need discovery
AI Assistant bitte -> Kundenprojekt rough variants -> agency path
AI Assistant bitte -> explanation request -> product answer -> next question
AI Assistant bitte -> repeated unclear -> no loop
AI Assistant bitte -> phone before context -> defer or handle safely
AI Assistant bitte -> explanation -> Telefonisch bitte -> phone handoff (v3_explanation_then_phone_handoff)
AI Assistant bitte -> concrete use case -> sales reflection + follow-up before handoff (v3_sales_depth_before_handoff)
After contact capture -> product relation question (Website vs KI-Assistent) answered, not human_or_ai (v3_post_completion_product_question)
After contact capture -> pricing concise, no website redirect (v3_pricing_after_contact_capture)
E-Mail contact path -> guidance plus short closing question, no silence (v3_email_contact_closing)
Existing customer -> asks company/customer number
RAG timeout -> deterministic fallback
```

- [x] Successful: CI covers live failure.
- [x] Successful: CI covers explanation-then-phone handoff.
- [x] Successful: CI covers no-loop repair.
- [x] Successful: CI covers RAG fail-closed.
- [x] Successful: CI covers sales depth before handoff.
- [x] Successful: CI covers post-completion product relation QA.
- [x] Successful: CI covers post-capture pricing wording.

### Phase 8: Controlled Rollout

Rollout order:

1. Merge with all v3 features disabled.
2. Deploy with no behavior change.
3. Enable semantic deterministic mode in QA/live test only.
4. Enable repair policy.
5. Enable RAG sales answerer in QA mode.
6. Run live call matrix.
7. Decide whether to expand production.

Required verification:

See [docs/voice-bridge-runtime-env.md](../voice-bridge-runtime-env.md) — authoritative env is `voice-bridge/.env` on the host (Compose `env_file` for `technolohit-voice-bridge`), not `asterisk/.env` alone.

```bash
docker inspect technolohit-voice-bridge --format 'running_image={{.Config.Image}}'
docker logs --tail=120 technolohit-voice-bridge
docker exec technolohit-voice-bridge sh -lc 'printenv | sort | egrep "^(VOICE_SEMANTIC|VOICE_RAG|VOICE_CONVERSATION|VOICE_LEAD_POLICY|IMAGE_TAG|BUILD_VERSION)=" || true'
```

GitHub Actions **Deploy Voice Stack** optional input `verify_v3_qa_env=true` checks image tag and non-secret v3 flags in the running container.

- [ ] Successful: Deploy with v3 disabled works.
- [ ] Successful: QA mode works.
- [ ] Successful: Production rollout approved.

### Phase 9: Product Playbook Consolidation

Goal: consolidate the founder-approved product playbook into a machine-readable, versioned runtime artifact without changing live behavior.

No live behavior change in this phase.

Inputs:

- Human-approved playbook: [docs/TechnoloHit Product Playbook v1.md](../TechnoloHit%20Product%20Playbook%20v1.md)
- Current runtime draft: `voice-bridge/config/playbooks/technolohit.main_voice_sales.v1.json`
- Current loader/validator: `voice-bridge/src/v4/playbook-loader.js`

Required work:

- Compare Markdown playbook against current JSON playbook.
- Report gaps between Markdown and JSON before enabling any runtime use.
- Add or strengthen schema validation for:
  - `playbook_version`
  - product IDs, priorities, aliases, explanations, follow-up questions
  - pricing policies
  - contact capture policy
  - callback/contact flow policy
  - contact form handoff policy
  - lead tiers
  - role boundaries
  - eval scenarios
  - approval/runtime binding metadata
- Keep draft playbook inactive unless explicitly enabled for tests/canary.
- Ensure `playbook_version` is available to quality events and eval snapshots.

Do not:

- Do not change live call behavior.
- Do not enable `VOICE_V4_PLAYBOOK_RUNTIME_ENABLED` by default.
- Do not remove current safe hardcoded fallbacks.
- Do not modify `rag-api`.

- [x] Successful: Markdown-to-JSON gap report produced ([docs/Tasks/phase9_product_playbook_consolidation_report.md](phase9_product_playbook_consolidation_report.md)).
- [x] Successful: JSON playbook contains founder-approved product positioning and contact policy (`technolohit-playbook-v1-20260611`: company positioning, product priorities, 10s/25s/45s phone answers, follow-up questions, approved price phrases, contact capture / caller ID / contact form handoff policy, lead tiers, LokalKI low priority).
- [x] Successful: Schema validation rejects incomplete or unsafe playbooks (required products, priorities, follow-up questions, pricing policies, contact capture/caller ID/contact form handoff, lead tiers, approval/runtime-binding metadata, LokalKI low-priority/direct-answer-only).
- [x] Successful: `playbook_version` is explicit and test-visible (eval suite + snapshot keyed by `playbook_version`; `eval_coverage` traceability map added).
- [x] Successful: Runtime binding remains inactive by default (`status=draft`, `runtime_binding.active=false`, `approved_for_runtime=false`; `VOICE_V4_PLAYBOOK_RUNTIME_ENABLED`/`VOICE_V4_QUESTIONNAIRE_RUNTIME_ENABLED` default off).
- [x] Successful: Existing tests pass with no live behavior change (new `voice-bridge/tests/v4-phase9-product-playbook-consolidation.test.js`; full suite green).

### Phase 10: Behavior Decision Layer

#### Phase 10A: Agent Behavior Decision skeleton (pure logic)

Goal: implement the deterministic Agent Behavior Decision object as a pure module with tests only. No planner/RAG/questionnaire/callback runtime wiring in this increment.

Deliverable: `voice-bridge/src/v4/agent-behavior-decision.js` exposing `resolveAgentBehaviorDecision()` and a privacy-safe snapshot helper.

- [x] Successful: Pure decision module implements the 8-level priority contract.
- [x] Successful: Decision object includes `priority`, `response_type`, `product_id`, `playbook_version`, `rag_allowed`, `questionnaire_allowed`, `lead_tier`, `next_action`, `reason`, `suppressed_intents`.
- [x] Successful: Missing/invalid playbook fails closed to safe decision metadata.
- [x] Successful: Focused tests cover closing, callback, role boundary, product paths, questionnaire eligibility, fallback, playbook traceability, and privacy.
- [x] Successful: No live runtime behavior change (`isAgentBehaviorDecisionRuntimeEnabled()` remains false; no planner wiring).

#### Phase 10B: Agent Behavior Decision metadata plumbing (opt-in, default off)

Goal: attach privacy-safe Agent Behavior Decision metadata to v4 quality events when explicitly enabled. Observability only — no planner/RAG/questionnaire/callback behavior switching.

Deliverable: `VOICE_V4_AGENT_BEHAVIOR_DECISION_ENABLED=false`, `agent-behavior-decision-runtime.js`, and `behavior_decision_*` fields on `response_plan_created`.

- [x] Successful: Config flag added and defaults false.
- [x] Successful: Metadata attached to v4 `response_plan_created` when flag on and v4 path active.
- [x] Successful: Flag off leaves existing response plans and quality payloads unchanged.
- [x] Successful: Decision metadata does not alter response text, type, or next action.
- [x] Successful: Invalid/missing playbook and resolver failures fail closed in metadata without throwing.
- [x] Successful: Privacy-safe metadata (no transcript/phone/email/RAG query/lead details).

#### Phase 10C: Agent Behavior Decision vs planner eval harness (non-live)

Goal: compare Agent Behavior Decision metadata against actual v4 planner/orchestrator behavior in a non-live harness. Reveal mismatches for Phase 10D; do not switch runtime behavior.

Deliverable: `voice-bridge/src/v4/agent-behavior-decision-eval.js`, focused tests, and privacy-safe eval snapshots.

- [x] Successful: Eval harness runs synthetic scenarios through decision resolver and planner/orchestrator.
- [x] Successful: Privacy-safe per-scenario results (`caller_chars` only; no raw transcript/phone/email).
- [x] Successful: Required scenario categories covered (closing, callback, out-of-scope, technical escalation, product, questionnaire, fallback, pending voice-capture/handoff).
- [x] Successful: Pending scenarios report `status: "pending"` (not fake pass).
- [x] Successful: Mismatches produce `status: "fail"` with useful `failures` (questionnaire same-turn attachment documented for Phase 10D).
- [x] Successful: No live runtime behavior change; decision flag remains default off.

#### Phase 10D: Questionnaire decision guard (opt-in, default off)

Goal: fix the Phase 10C questionnaire mismatch only — block questionnaire attachment when Agent Behavior Decision says `questionnaire_allowed=false`, and only when the decision flag is explicitly enabled.

Deliverable: `agent-behavior-decision-questionnaire-guard.js` wired into `questionnaire-runtime.js`.

- [x] Successful: When `VOICE_V4_AGENT_BEHAVIOR_DECISION_ENABLED=true`, questionnaire runtime does not attach when decision disallows.
- [x] Successful: When decision flag is false (default), existing questionnaire behavior unchanged.
- [x] Successful: Product answer `response_type`, base text, and `next_state` unchanged; only follow-up attachment skipped when guard blocks.
- [x] Successful: Closing/callback/role-boundary paths still block questionnaire; invalid playbook fails closed for attachment when flag on.
- [x] Successful: Phase 10C eval suite: 10 pass / 0 fail / 3 pending.
- [x] Successful: No global planner/RAG/callback switching; decision flag remains default off.

#### Phase 10E: Contact form handoff and voice-capture restrictions (opt-in, default off)

Goal: runtime consumers for contact-form handoff when callers offer email, website URL, company name, or complex project details by voice. Default v3 production behavior unchanged.

Deliverable: `contact-form-handoff-intent.js`, `contact-form-handoff-policy.js`, planner `contact_form_handoff` response type, `VOICE_V4_CONTACT_FORM_HANDOFF_ENABLED=false`.

- [x] Successful: Deterministic intents for email/website/company/complex-details voice offers.
- [x] Successful: Planner returns `contact_form_handoff` with playbook phrase or safe fallback; no RAG/questionnaire/lead_ready/email-URL capture.
- [x] Successful: Closing and explicit callback requests still outrank contact-form handoff.
- [x] Successful: Agent Behavior Decision and eval harness aligned (13 pass / 0 fail / 0 pending).
- [x] Successful: Flag off leaves existing v3/v4 default planner behavior unchanged.

#### Phase 10F: Playbook-driven company and product content (opt-in, default off)

Goal: runtime consumers for `company_general`, `product_explanation`, and `product_pricing` eval categories using the validated Product Playbook. Reuses `VOICE_V4_PLAYBOOK_RUNTIME_ENABLED=false` — no separate content flag.

Deliverable: `playbook-product-content.js`, `company-general-intent.js`, planner/orchestrator wiring, eval harness pass for pending content categories.

- [x] Successful: Pure resolvers for company positioning, phone-safe explanations, approved pricing phrases, and LokalKI `answer_only_when_asked` filter.
- [x] Successful: Company-general intent is narrow (TechnoloHit ecosystem questions only); arbitrary general knowledge stays `out_of_scope`.
- [x] Successful: RAG success preserved; playbook is deterministic fallback only.
- [x] Successful: Closing, callback, contact-form handoff, and role boundary still outrank product content.
- [x] Successful: Pricing uses approved phrases only (scope-dependent Smart Website; orientation prices for Voice Agent / AiseoQ).
- [x] Successful: Playbook eval: 0 fail / 0 pending for `company_general`, `product_explanation`, `product_pricing`.
- [x] Successful: Flag off leaves planner output unchanged; production defaults unchanged.

#### Phase 10G: Caller-ID missing `ask_phone_once` (v4)

Goal: when caller ID is missing/invalid, ask for phone exactly once before callback permission; never loop; route failures to contact-form / manual review.

Deliverable: `spoken-phone-capture.js`, `phone-capture-privacy.js`, `caller-id-callback-policy.js`, `phone_number_pending` state, `request_phone_once` response type, orchestrator-protected phone, playbook eval scenarios.

- [x] Successful: Valid CLI → permission phrase only (playbook or hardcoded).
- [x] Successful: Missing CLI → `request_phone_once` once (`max_phone_asks=1`).
- [x] Successful: Valid spoken/digit phone → permission; invalid/refusal → manual review / contact form, no second ask.
- [x] Successful: Closing wins; RAG and questionnaire blocked during phone capture.
- [x] Successful: Numeric and spoken digit phone turns persist `[phone_redacted]` in `last_user_utterance`; raw current-turn transcript is replaced after planning.
- [x] Successful: No full numeric phone or known spoken digit sequence in serialized memory, post-call summary metadata, notification payload, quality events, decision payloads, or eval snapshots.
- [x] Successful: Playbook eval 33/0/0; decision eval 13/0/0; `npm test` 712/0.

**Phase 10 completion (2026-06-20):** Increments **10A–10G complete**. Umbrella Phase 10 **closed after Codex privacy blocker tests passed**. See [phase10_completion_audit_report.md](phase10_completion_audit_report.md) and [phase10g_caller_id_missing_phone_capture_report.md](phase10g_caller_id_missing_phone_capture_report.md).

**Audit conclusion (superseded 2026-06-11):** Central runtime behavior switching **not required**; priority contract enforced by bounded planner/RAG/callback guards plus decision metadata (default off).

#### Phase 10 (remaining): Runtime behavior switching — audit status (superseded)

Goal: centralize conversation priority decisions behind a feature flag, using existing v4 modules rather than adding another planner framework.

Recommended implementation shape:

```text
transcript + memory + playbook + agent_config
  -> Agent Behavior Decision
  -> response planner / RAG / questionnaire / callback flow
```

The decision object should include:

- `priority`
- `response_type`
- `product_id`
- `playbook_version`
- `rag_allowed`
- `questionnaire_allowed`
- `lead_tier`
- `next_action`
- `reason`
- `suppressed_intents`, if available

Required behavior:

- Closing always wins.
- Active callback/contact flow wins over product continuation.
- Safety and role-boundary intents run before product Q&A.
- A clearly explicit new product question may resume product Q&A after callback flow.
- Product context continuation can answer only when no higher-priority flow is active.
- RAG can provide content only when `rag_allowed=true`.
- Questionnaire can run only when `questionnaire_allowed=true`.
- Lead tier is advisory metadata; deterministic lead validators still decide writes.

Feature flag / rollout:

- Keep default behavior unchanged.
- Use an explicit opt-in flag or extend the existing playbook runtime flag only after review.
- Fail closed to current behavior if playbook loading or decision resolution fails.

**Audit (2026-06-11):** Distributed enforcement via planner/intent/RAG/callback modules satisfies the priority contract in eval; a single decision-driven controller is **not recommended**. Checklist below reflects **original wording** — treat items as **met in spirit** except where audit notes partial status.

- [x] Successful: Behavior decision object is implemented behind a disabled flag (10A/10B).
- Partial (accepted): Planner, RAG, questionnaire, and callback flow use distributed imperative guards; decision metadata is observability + opt-in questionnaire guard (10D). Eval alignment is sufficient; no second global controller is required.
- [x] Successful: Callback/contact flow cannot be overridden by scoped product Q&A (10AP–10AU, 10F).
- [x] Successful: RAG is content-only and cannot decide priority.
- Partial (accepted): Questionnaire is decision-gated only when `VOICE_V4_AGENT_BEHAVIOR_DECISION_ENABLED=true` (10D guard; default off).
- [x] Successful: Quality events include safe decision metadata when flag on (10B).
- [x] Successful: Default production behavior remains unchanged.
- [x] **Closed (10G):** Caller-ID missing `request_phone_once` — implemented.

### Phase 11: Playbook Eval / Review / Publish Version

**Status (2026-06-22): COMPLETE (governance only).** Mojtaba approved the published v1 content. Runtime activation and canary work have not started.

**Closed prerequisite:** Phase 10 closed at commit `389e0d0254797857b389677e7a5c3b9633355729` (712 tests, playbook eval 33/0/0, decision eval 13/0/0).

**Delivered in Phase 11:**

- Founder review matrix + drift report: `docs/Tasks/phase11_playbook_review_and_publish_candidate_report.md`
- Immutable publish candidate (inactive): `voice-bridge/config/playbooks/technolohit.main_voice_sales.v1.publish-candidate.json` (`technolohit-playbook-v1-20260620-candidate`)
- Immutable published artifact (inactive): `voice-bridge/config/playbooks/technolohit.main_voice_sales.v1.published.json` (`technolohit-playbook-v1-20260622-published`)
- Two-mode non-live validation: `voice-bridge/src/v4/playbook-publish-validator.js`, `npm run playbook:publish-validate`, `npm run playbook:publish-validate:published`
- Phase 11 tests: `voice-bridge/tests/v4-phase11-playbook-publish-validator.test.js`
- Phase 11A closure report: `docs/Tasks/phase11a_publish_governance_closure_report.md`

**Candidate state:** `status=draft`, `runtime_binding.active=false`, `approved_for_runtime=false`, `founder_approval=pending` (Mojtaba).

**Published state:** `status=published`, `approval.approved_for_runtime=true`, `founder_approval=approved`, `runtime_binding.active=false`, `canary_approval=pending`.

**Explicitly not part of Phase 11:** runtime activation, canary, Docker publish, or v4 flag enablement. Publishing content and activating runtime remain separate approvals.

### Phase 12A: Immutable Playbook Runtime Binding + Canary Readiness

Phase 12A adds a separate schema-validated runtime binding without modifying the immutable Phase 11 published playbook.

- Runtime binding contract: `voice-bridge/src/v4/playbook-runtime-binding.js`
- Default-safe sample: `voice-bridge/config/playbook-bindings/technolohit.main_voice_sales.v1.canary.pending.json`
- Canary preflight: `npm run playbook:canary-preflight`
- Runtime integration: `behavior-policy.js` resolves the binding once per active v4 canary call; the checksum-verified playbook instance is passed to product, questionnaire, and decision consumers.
- Required gates: v4 runtime + realtime + canary + live AudioSocket + playbook runtime flag + explicit approved active canary binding under `config/playbook-bindings`.
- Binding trust boundary: absolute and package-relative paths must resolve under the approved binding root; existing files are checked with `realpath` to reject symlink escapes.
- Activation authority: only the external binding may activate runtime. The checksum-verified published artifact must keep explicit boolean `runtime_binding.active=false`.
- Rejections: outside-root path, relative traversal, symlink escape, missing/corrupt binding, embedded active/missing/invalid activation metadata, draft/candidate artifact, checksum/version/tenant/agent mismatch, non-canary scope, pending/inactive/revoked/unapproved metadata.
- Failure behavior: hardcoded defaults, no crash. With the master flag off, no binding or playbook read occurs and v3/default behavior remains unchanged.
- The repository does not contain an active approved production binding. Sysadmin canary approval and creation of an approved binding remain future operational work.

Implementation evidence: [phase12a_immutable_playbook_runtime_binding_report.md](phase12a_immutable_playbook_runtime_binding_report.md).

### Phase 12C: Runtime Artifact Validator Fix

**Status (2026-06-22):** Fix implemented; release `v1.36.1` for canary deployment.

- Incident: `v1.36.0` image fails `playbook:canary-artifact-validate` with ENOENT on `/app/Dockerfile`.
- Fix: runtime validator inspects packaged `config/` artifacts only; Dockerfile checks moved to CI tests.
- `v1.36.0`: release image valid, artifact-validation CLI broken — **must not deploy for Phase 12B canary**.
- Recommended pin: `thnhit/technhvoice:voice-bridge-v1.36.1`

Implementation evidence:
[phase12c_runtime_artifact_validator_fix_report.md](phase12c_runtime_artifact_validator_fix_report.md).

### Phase 12B: Approved Canary Binding + Release Readiness

**Status (2026-06-22):** Released as `v1.36.0`; superseded for deployment by `v1.36.1` (12C validator fix).

Phase 12B adds a repository-packaged, separately approved canary binding
without changing the immutable published playbook or production defaults.

- Approved binding:
  `voice-bridge/config/playbook-bindings/technolohit.main_voice_sales.v1.canary.approved.json`
- Non-live release validation:
  `npm run playbook:canary-artifact-validate`
- Runtime/server guard remains:
  `npm run playbook:canary-preflight`
- Release recommendation:
  `v1.36.1` / `thnhit/technhvoice:voice-bridge-v1.36.1` (replaces broken `v1.36.0` validator)
- Docker Publish always publishes voice-bridge and skips rag-api when
  `rag-api/**` is unchanged since the previous semantic-version tag.

- [x] Successful: Pending sample remains pending/inactive and cannot activate runtime.
- [x] Successful: Approved binding is explicit canary-only approval, active only when all runtime gates are enabled.
- [x] Successful: Exact published version and SHA-256 are test-visible and validated.
- [x] Successful: Docker build context contains the published playbook and approved binding.
- [x] Successful: Non-live artifact validator does not claim server/runtime activation.
- [x] Successful: Default v3/playbook-off runtime fails canary preflight safely.
- [x] Successful: Voice-only release does not publish a new rag-api tag when rag-api is unchanged.
- [x] Successful: `v1.36.0` release is committed, tagged, and published.
- [x] Successful: Phase 12C fixes runtime artifact validator; `v1.36.1` recommended for canary pin.
- [ ] Successful: One supervised playbook canary passes and is rolled back to v3/off.

Implementation evidence:
[phase12b_approved_canary_binding_and_release_readiness_report.md](phase12b_approved_canary_binding_and_release_readiness_report.md).

### Phase 12D: First supervised playbook canary (live)

**Status (2026-06-20):** **PARTIAL PASS / ACCEPTANCE FAIL** — one valid v4 canary call (`c411ccac-a282-4115-b883-aafd9d8bea3f`). Handler, binding preflights, product/pricing routing, RAG-off, quality flush, post-call, privacy, and rollback passed. Acceptance failed on runtime playbook provenance, company-general TTS truncation, and incomplete callback evidence when the caller closed during contact preference.

### Phase 12E: Live playbook provenance and spoken integrity

**Status (2026-06-20):** Released as `voice-bridge-v1.36.2` after Codex approval.

- Runtime `playbook_version` on `response_plan_created` comes from the verified approved binding only; legacy agent-config prompt version is exposed separately as `agent_config_playbook_version`.
- Company-general answers survive `prepareLiveAssistantSpeechText()` as complete sentences within 160 chars.
- Closing during incomplete callback flows records `callback_flow_abandoned` evidence without lead/permission fabrication.
- Non-live readiness: `npm run runtime:readiness`; startup logs distinguish legacy router stub from per-call live handler selection.

Implementation evidence:
[phase12e_live_playbook_provenance_and_spoken_integrity_report.md](phase12e_live_playbook_provenance_and_spoken_integrity_report.md).

### Phase 12G: Missing-caller-ID callback phone capture (live)

**Status (2026-06-20):** **FAIL** — STT delivered `Meine Nummer ist 01511 2345678.` but runtime emitted `callback_manual_review` / `phone_capture_failed` and post-call `callback_permission_missing`. Root cause: live dialogue redacted phone digits before spoken-phone parsing.

### Phase 12H: Callback phone capture handoff fix

**Status (2026-06-20):** Released as `voice-bridge-v1.36.3` after Codex approval.

- Live STT transcript stays raw for planning during `phone_number_pending`; redaction applies only to persistence, quality, and post-call surfaces.
- German numeric mobile formats (`01511 2345678`, spaced digits, spoken digits) capture and normalize to protected `orchestrator.callerPhoneNormalized`.
- Post-call manual-review outcomes report `phone_capture_failed` instead of misleading `callback_permission_missing`.

Implementation evidence:
[phase12h_callback_phone_capture_handoff_fix_report.md](phase12h_callback_phone_capture_handoff_fix_report.md).

### Phase 12I: Callback phone capture re-test (live)

**Status (2026-06-20):** **FAIL** — v4 canary and playbook binding were correct (`handler=v4_canary`, `reason=v4_live_canary_selected`). Flow reached `request_phone_once`, but `Meine Nummer ist 01511 2345678.` produced `phone_capture_failed` → `callback_manual_review`, then `barge_in_detected`. Root cause: phone-capture turn-taking and state-lock failure (not STT or parser).

### Phase 12J: Phone capture state lock and turn-taking repair

**Status (2026-06-20):** Released as `voice-bridge-v1.36.4` after Codex approval.

- Locked routing while `PHONE_NUMBER_PENDING`: no product Q&A, RAG, questionnaire, or generic fallback.
- Partial/incomplete transcripts retry once (`request_phone_once_retry`) before `callback_manual_review`.
- Manual review after retry uses `phone_capture_failed_after_retry`, not `callback_permission_missing`.
- Barge-in during `request_phone_once` feeds phone capture; extended endpoint silence (default 1200 ms).

Implementation evidence:
[phase12j_phone_capture_state_lock_and_turn_taking_report.md](phase12j_phone_capture_state_lock_and_turn_taking_report.md).

### Phase 12K: Supervised missing-caller-ID callback phone capture canary (live)

**Status (2026-06-25):** **PASS** — Phase 12 **closed**.

| Evidence | Result |
|----------|--------|
| Image | `thnhit/technhvoice:voice-bridge-v1.36.4` |
| `call_session_id` | `7a76318a-05b4-4853-b1cb-bf8bc0478cfb` |
| `bridge_call_id` | `4737af80-f805-4b3e-bc6c-8ec4b33c1464` |
| Calls | Exactly **one** supervised PSTN call |
| Handler | `v4_canary` / `v4_live_canary_selected` |
| `playbook_version` | `technolohit-playbook-v1-20260622-published` |
| RAG | **off** |
| Callback sequence | `collect_contact_preference` → `request_phone_once` → `collect_callback_permission` → `callback_finalized` → `closing` |
| `lead_created_count` | **1** |
| Privacy scan | **0** phone-like matches |
| Notification | HTTP **200** |
| Rollback | **v3 / RAG-off** restored |

Passing canary image: **`voice-bridge-v1.36.4`** (`sha256:c9f9c61fd0d6c4f604bff4d6517a5c989a14437d3236eebe73f6c83b84a3d444`).

Implementation evidence:
[phase12k_supervised_callback_phone_capture_canary_pass_report.md](phase12k_supervised_callback_phone_capture_canary_pass_report.md).

### Phase 12: CLOSED (2026-06-25)

Phase 12A–12K complete. Approved playbook binding, live provenance, missing-caller-ID phone capture, and supervised callback canary are **accepted** on `v1.36.4`.

**Next track:** limited operational canary and release readiness (not broad v4 GA). Production default remains **v3 / RAG-off** until explicit leadership approval.

Goal: make playbook versions testable and reviewable before any canary.

Required eval coverage:

- company general question
- Smart Website explanation
- Smart Website price
- Voice Agent explanation
- Voice Agent price
- AiseoQ explanation
- AiseoQ price
- callback request after product answer
- phone preference
- callback permission
- no email capture by voice
- no website URL capture by voice
- contact form handoff
- no RAG after callback starts
- no questionnaire after callback starts
- closing

Review/publish flow:

```text
founder/questionnaire input
  -> Markdown playbook update
  -> validated JSON playbook version
  -> eval scenarios
  -> review
  -> publish version
  -> optional canary
```

Rules:

- A new customer-specific behavior change creates a new playbook version, not a Docker-image behavior patch.
- No live canary starts until eval passes.
- No production rollout starts until canary repeatability passes.
- Published playbooks must carry explicit approval metadata.

- [x] Successful: Eval scenarios are loaded from or traceable to playbook version (publish candidate `eval_coverage` map).
- [x] Successful: Eval snapshot is privacy-safe and keyed by `playbook_version` (existing formatters + publish CLI privacy guard).
- [x] Successful: All required eval categories pass before canary (validated by `playbook:publish-validate` on candidate).
- [x] Successful: Review/publish metadata exists (`publish_candidate`, `approval`, changelog, source commit SHA).
- [x] Successful: Canary remains blocked after content publication until a separate activation/canary approval (`runtime_binding.active=false`).

## Next Implementation Task

Do **not** start broad runtime rewrites or production v4 GA next.

Phase 12 is **closed** (supervised callback phone-capture canary **PASS** on `voice-bridge-v1.36.4`).

The next track is **limited operational canary / release readiness**:

```text
- Repeat supervised canary evidence on a narrow allowlist window (v3 rollback mandatory).
- Confirm post-call, notification, privacy, and playbook provenance on each window.
- Optional Phase 13 observability: populate callback_permission / callback_ready / next_action on response_plan_created (not a Phase 12 blocker).
- No production v4 GA until leadership explicitly approves after operational canary repeatability.
```

Required before widening traffic:

- Team accepts Phase 12 closeout and `v1.36.4` as the passing playbook-canary image.
- Team accepts production default remains v3 / RAG-off between windows.
- Team accepts limited operational canary scope before any GA decision.

Do not touch yet:

- production env files
- `rag-api`
- Docker/deploy workflows
- live canary scripts except documentation updates
- `turn-assistant.js`, unless a later approved phase explicitly requires it

## Sysadmin Preparation

Before enabling RAG/semantic LLM in production-like QA, sysadmin should verify:

```bash
docker exec technolohit-voice-bridge sh -lc 'getent hosts technolohit-rag-api || true'
docker exec technolohit-voice-bridge sh -lc 'wget -qO- http://technolohit-rag-api:8080/healthz || true'
docker exec technolohit-voice-bridge sh -lc 'printenv | sort | egrep "^(VOICE_RAG|VOICE_SEMANTIC|OPENAI|IMAGE_TAG|BUILD_VERSION)=" || true'
```

If evaluating alternate ASR providers, sysadmin/devops must provide:

- provider API key as secret/env
- explicit data processing approval
- retention policy
- test-only flag
- rollback plan

- [ ] Successful: RAG network verified.
- [ ] Successful: Any new ASR provider approved before use.

## Acceptance Criteria

Local acceptance:

- `Eigenunternehmen` maps to own-company/new prospect.
- `Eigene Unternehmen` maps to own-company/new prospect.
- STT-damaged customer project variants map to agency/customer project when likely.
- `Kurze Erklärung bitte` receives a product explanation and next question.
- Concrete use-case answers get one sales follow-up before phone/email handoff.
- Product/relation questions (Website, KI-Assistent, Zusammenhang) are not classified as `human_or_ai_question`.
- After contact capture, bare “Ich habe noch eine Frage” prompts for the question; actual questions are answered directly.
- Post-capture pricing is concise and does not redirect to the website when contact is already captured.
- The assistant never repeats the same clarification twice.
- Product questions are answered before contact capture.
- Phone capture still requires deterministic validation.
- RAG timeout/unavailable remains safe.
- No full phone number appears in logs, Telegram, or email.
- Product/playbook behavior is traceable to a `playbook_version`.
- Agent Behavior Decision metadata explains why RAG/questionnaire/callback/product paths were allowed or suppressed.
- Callback/contact flow cannot be overridden by product continuation unless the caller asks a new explicit product question.
- Contact form handoff exists for email, website URL, company name, keywords, competitors, or detailed project information.
- Eval scenarios for the active playbook pass before any canary.

Production acceptance:

- Live PSTN test with accented/non-native German does not loop.
- Assistant can sell/explain Digitale Rezeption naturally.
- Assistant captures useful business context.
- Callback-ready lead is created only with valid contact path.
- Manual review is used when confidence/contact is insufficient.
- Post-call summary reflects stable sales context.
- n8n notification remains privacy-safe.
- Live canary repeatability passes without code changes between calls.
- Production rollout is approved only after product playbook/eval gates and operational blockers are reviewed.

- [x] Successful: Local acceptance passed.
- [ ] Successful: Production acceptance passed.

## Final Note

The v3 goal is not to make the assistant obey a bigger script.

The v3 goal is:

```text
Build a voice sales agent that understands messy human input, uses TechnoloHit knowledge, repairs misunderstandings gracefully, and only writes structured leads when the deterministic privacy and contact rules allow it.
```
