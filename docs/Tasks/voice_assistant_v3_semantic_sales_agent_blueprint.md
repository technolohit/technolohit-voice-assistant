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

Production acceptance:

- Live PSTN test with accented/non-native German does not loop.
- Assistant can sell/explain Digitale Rezeption naturally.
- Assistant captures useful business context.
- Callback-ready lead is created only with valid contact path.
- Manual review is used when confidence/contact is insufficient.
- Post-call summary reflects stable sales context.
- n8n notification remains privacy-safe.

- [x] Successful: Local acceptance passed.
- [ ] Successful: Production acceptance passed.

## Final Note

The v3 goal is not to make the assistant obey a bigger script.

The v3 goal is:

```text
Build a voice sales agent that understands messy human input, uses TechnoloHit knowledge, repairs misunderstandings gracefully, and only writes structured leads when the deterministic privacy and contact rules allow it.
```

