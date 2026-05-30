# TechnoloHit Voice Assistant Sales + RAG Orchestrator Blueprint v2

Date: 2026-05-30

## Purpose

Redesign the TechnoloHit Voice Assistant from a mostly scripted intake flow into a consultative, RAG-assisted sales receptionist.

The current system has become too defensive and form-like. It can capture a callback lead, but it does not yet sell, qualify, or use the knowledge/RAG system as the assistant's real product brain.

This blueprint supersedes the "intelligence upgrade v1" direction for conversation design. Keep the safety fixes from v1.1.x, but stop adding small hotfixes to the old product-intake flow unless they are production-critical.

Primary goal:

```text
The caller should feel they are speaking with a helpful TechnoloHit sales receptionist who can understand the product interest, explain value, ask smart qualification questions, and collect a useful lead only when it makes sense.
```

## Why The Current Direction Is Failing

Production evidence from v1.1.3:

- `VOICE_RAG_ENABLED=false`, so the live assistant is not using RAG as a real-time knowledge layer.
- The assistant repeats a compact product offer instead of adapting when STT mishears a follow-up like "kurze Erklärung".
- The assistant moves too quickly from product interest to contact capture.
- Product presentation is too thin and not persuasive enough.
- Lead capture focuses on phone validation instead of lead quality.
- The knowledge files still contain old callback wording and overly restrictive "no marketing" guidance.
- The code is mixing too many responsibilities in `turn-assistant.js`: intent routing, product pitching, RAG fallback, lead capture, consent, TTS, and post-capture handling.

Important conclusion:

```text
The issue is not only RAG being disabled.
The issue is that the assistant has no clear sales conversation policy.
RAG must support a stronger conversation orchestrator, not replace it.
```

- [ ] Successful: Team accepts that v1 small hotfixing should stop except for urgent production bugs.
- [ ] Successful: Team accepts v2 as the new conversation design direction.

## Strategic Design Decision

Recommended architecture:

```text
Voice Assistant v2 = deterministic safety shell + LLM/RAG sales brain + structured lead policy.
```

Keep deterministic code for:

- privacy/recording greeting
- caller ID and phone/email capture
- phone number validation
- PII redaction/logging
- final lead creation
- max-turn protection
- hangup/closing
- RAG timeout/fail-closed

Use LLM/RAG for:

- understanding free-form product interest
- explaining products naturally
- answering company/product questions from knowledge
- asking the next best sales qualification question
- handling objections without hallucinating
- deciding whether the caller is an existing customer, new prospect, partner/agency, or unclear

Do not let RAG/LLM directly:

- grant contact permission
- validate phone numbers
- expose private data
- make legal/compliance promises
- invent pricing, timelines, or guarantees
- decide final database writes without schema validation

- [ ] Successful: Deterministic safety shell approved.
- [ ] Successful: RAG/LLM sales brain approved.
- [ ] Successful: Database writes remain structured and guarded.

## Target Conversation Model

The assistant should not behave like a menu. It should use a staged consultative flow.

### Stage 1: Open And Understand

Goal: identify why the caller is calling.

Good behavior:

```text
Caller: Ich interessiere mich für AI Assistant.
Assistant: Gerne. Meinen Sie einen KI-Telefonassistenten, der Anrufe annimmt und erste Anfragen vorbereitet?
```

If clear enough, do not ask a menu question. Move to value explanation.

- [x] Successful: Product interest is recognized without product menu loops.
- [x] Successful: Assistant does not repeat the same compact offer after unclear follow-up.

### Stage 2: Product Value Pitch

Goal: explain the product in business value terms, not technical terms.

Example for Digitale Rezeption:

```text
Die digitale Rezeption kann Anrufe annehmen, typische Fragen beantworten und wichtige Kontaktdaten für Ihr Team vorbereiten. Das ist vor allem hilfreich, wenn viele Anfragen reinkommen oder niemand jeden Anruf sofort beantworten kann.
```

Then ask one sales question:

```text
Geht es um Ihr eigenes Unternehmen oder um ein Kundenprojekt?
```

Product pitch rules:

- mention business outcome first
- avoid internal architecture unless asked
- no guaranteed results
- one follow-up question per turn
- no immediate phone-number request after first product mention

- [x] Successful: Each product has a consultative pitch.
- [x] Successful: Pitch asks one useful next question.

### Stage 3: Customer Type / Qualification

Goal: route the caller correctly.

Ask:

```text
Sind Sie bereits Kunde bei TechnoloHit, oder geht es um ein neues Projekt?
```

If existing customer:

```text
Alles klar. Können Sie mir kurz den Firmennamen oder Ihre Kundennummer nennen, damit unser Team die Anfrage zuordnen kann?
```

If new prospect:

```text
Verstanden. In welcher Branche ist Ihr Unternehmen ungefähr tätig?
```

If agency/IT provider:

```text
Geht es um Ihre eigene Nutzung oder möchten Sie das für Kundenprojekte einsetzen?
```

- [x] Successful: Existing customer path exists.
- [x] Successful: New prospect path exists.
- [x] Successful: Agency/customer-project path exists.

### Stage 4: Need Discovery

Goal: capture one or two high-value context fields before contact handoff.

Potential fields:

- product_interest
- customer_type: existing_customer | new_prospect | agency_partner | unclear
- company_name
- industry_or_business_type
- current_problem
- desired_outcome
- urgency: now | soon | exploratory | unknown
- preferred_contact

Ask only one question at a time. Do not collect all fields mechanically.

Examples:

```text
Was ist bei Ihnen gerade das wichtigste Ziel: weniger verpasste Anrufe, bessere Lead-Erfassung oder schnellere Antworten auf typische Fragen?
```

```text
Haben Sie schon eine bestehende Website oder soll etwas Neues aufgebaut werden?
```

```text
Soll die Lösung eher sofort entlasten, oder möchten Sie erstmal prüfen, ob es grundsätzlich passt?
```

- [x] Successful: Lead contains useful business context, not only phone number.
- [x] Successful: Assistant stops after enough context and offers handoff.

### Stage 5: Conversion / Handoff

Goal: collect contact details only after product interest and need are clear enough.

Good transition:

```text
Das klingt nach einem passenden Thema für unser Team. Möchten Sie, dass wir das kurz telefonisch mit Ihnen prüfen, oder schreiben Sie uns lieber per E-Mail?
```

Phone path:

- If caller ID available, ask permission to use current number.
- If caller ID missing, ask for full phone number.
- Validate phone strictly.
- Do not create callback-ready lead without usable phone.

Email path:

- Do not capture email by voice in MVP.
- Give `info@technolohit.com`.
- Include what they should mention in the email.

- [x] Successful: Contact capture happens after sales context, not immediately.
- [x] Successful: Phone/email privacy rules remain intact.

## Product Sales Playbooks

Create a structured sales playbook file:

```text
voice-bridge/knowledge/sales-playbooks.technolohit.json
```

Each product should have:

```json
{
  "id": "voice_agent",
  "name": "Digitale Rezeption",
  "positioning": "...",
  "best_for": ["..."],
  "pain_points": ["..."],
  "value_props": ["..."],
  "qualifying_questions": ["..."],
  "objection_answers": {
    "price": "...",
    "human_replacement": "...",
    "data_privacy": "..."
  },
  "safe_claims": ["..."],
  "forbidden_claims": ["..."],
  "handoff_summary_template": "..."
}
```

Minimum products:

- Smart Website
- AISeoQ
- Botinteg
- LokalKI
- Digitale Rezeption / Voice Agent

- [x] Successful: Sales playbook JSON created.
- [x] Successful: Product catalog and sales playbook are consistent.
- [ ] Successful: Old callback-heavy wording removed from knowledge.

## RAG Design

RAG should become the assistant's knowledge layer for safe sales/product answers.

### Required RAG Runtime

Production must verify:

```bash
docker exec technolohit-voice-bridge sh -lc 'getent hosts technolohit-rag-api || true'
docker exec technolohit-voice-bridge sh -lc 'wget -qO- http://technolohit-rag-api:8080/healthz || true'
```

Target env:

```env
VOICE_RAG_ENABLED=true
VOICE_RAG_QA_MODE=true
VOICE_RAG_API_URL=http://technolohit-rag-api:8080
VOICE_RAG_TIMEOUT_MS=700
VOICE_RAG_MIN_SCORE=0.72
```

Rollout:

1. enable in QA mode / controlled calls
2. log retrieval hit/miss and source, without raw transcript preview
3. compare responses against playbook
4. only then enable for normal production calls

### RAG Use Cases

Use RAG for:

- "Was macht TechnoloHit?"
- "Was ist eine digitale Rezeption?"
- "Kann ich so einen AI Assistant bekommen?"
- "Was kostet das ungefähr?" with no exact prices
- "Ist das DSGVO-konform?" with safe non-legal answer
- product comparisons
- objection handling
- follow-up questions after pitch

Do not use RAG for:

- phone number validation
- permission yes/no
- final lead status
- PII extraction

- [ ] Successful: RAG runtime URL verified.
- [ ] Successful: RAG QA mode enabled in controlled test.
- [ ] Successful: RAG answers product questions without breaking safety.

## LLM Conversation Policy

Create a small policy module:

```text
voice-bridge/src/sales-policy.js
```

Responsibilities:

- define allowed conversation stages
- define stage transition rules
- choose next sales question
- enforce one question per turn
- enforce max answer length
- enforce no forbidden claims
- return structured intent/stage output

Suggested output contract:

```json
{
  "stage": "product_pitch|qualification|need_discovery|handoff|closing",
  "product_interest": "voice_agent",
  "customer_type": "new_prospect",
  "lead_context": {
    "company_name": "",
    "industry_or_business_type": "",
    "current_problem": "missed calls",
    "desired_outcome": "capture more leads"
  },
  "next_question_type": "business_goal",
  "assistant_text": "..."
}
```

The app must validate this structure before using it.

- [x] Successful: Sales policy module created.
- [x] Successful: Structured output is validated.
- [ ] Successful: Invalid LLM output fails closed to safe deterministic text.

## Data Model / Lead Quality

Current callback lead is not enough. We need useful lead context.

Recommended metadata fields in `voice.leads.metadata`:

```json
{
  "product_interest": "voice_agent",
  "customer_type": "new_prospect",
  "company_name": "",
  "industry_or_business_type": "",
  "current_problem": "",
  "desired_outcome": "",
  "urgency": "",
  "preferred_contact": "phone",
  "permission": "granted",
  "qualification_confidence": "medium",
  "sales_summary": ""
}
```

Do not create a `team_callback` lead only because the user said "Telefonisch".

Create a callback lead when:

- product interest is clear enough
- caller chose phone or caller requested team contact
- usable phone exists from caller ID or validated voice capture
- permission/contact basis is clear

Create manual review when:

- interest exists but phone is missing
- product unclear but caller wants contact
- transcript quality is poor

- [x] Successful: Lead metadata includes sales context.
- [ ] Successful: `team_callback` requires both interest and usable contact path.
- [ ] Successful: ambiguous calls become manual review, not fake qualified leads.

## Production Logging / Evidence

Keep transcript previews off by default.

Add non-sensitive telemetry:

```text
sales_stage=
product_interest=
customer_type=
rag_hit=
rag_top_source=
lead_quality=
next_question_type=
used_sales_policy=
used_rag_answer=
```

Do not log:

- full phone numbers
- full transcript text
- email addresses captured by voice
- secrets

- [ ] Successful: Telemetry added without PII.
- [ ] Successful: Live-call QA can diagnose stage/RAG behavior without transcript preview.

## CI / QA Scenarios

Add dialogue QA scenarios that test sales behavior, not only callback mechanics.

Required scenarios:

### Voice Agent Sales

```text
Caller: Ich interessiere mich für AI Assistant.
Expected: product recognized; short value pitch; asks company/customer-type question; no immediate phone request.
```

### Product Explanation Follow-up

```text
Caller: Kurze Erklärung bitte.
Expected: explains value using knowledge/RAG; does not repeat compact offer.
```

### New Prospect Qualification

```text
Caller: Neues Projekt.
Expected: asks one useful business qualification question.
```

### Existing Customer

```text
Caller: Ich bin schon Kunde.
Expected: asks company name or customer number; does not pitch like a cold prospect.
```

### Objection / Price

```text
Caller: Was kostet das?
Expected: no exact price; explains depends on scope; offers short team assessment.
```

### RAG Product Question

```text
Caller: Was ist LokalKI?
Expected: uses knowledge/RAG answer; no hallucinated security guarantee.
```

### Handoff After Qualification

```text
Caller has product + need context.
Expected: offers phone/email handoff.
```

- [x] Successful: Sales QA scenarios added.
- [x] Successful: CI fails if assistant asks for phone too early.
- [x] Successful: CI fails if product answer is only generic/menu-like.

## Implementation Phases

### Phase 0: Stop The Bleeding

- Freeze further micro-hotfixes unless production-critical.
- Keep `VOICE_RAG_ENABLED=false` until v2 QA is ready.
- Keep v1.1.3 safety fixes.
- Collect current RAG network evidence.

- [ ] Successful: Hotfix freeze accepted.
- [ ] Successful: RAG network path verified.

### Phase 1: Sales Playbooks

- Create `sales-playbooks.technolohit.json`.
- Rewrite product knowledge to remove old callback-first wording.
- Add safe claims and forbidden claims per product.

- [x] Successful: Sales playbooks created.
- [ ] Successful: Knowledge wording reviewed.

### Phase 2: Conversation Stage Model

- Add explicit stages: discovery, pitch, qualification, need_discovery, handoff, capture, closing.
- Prevent immediate phone capture after first product recognition.
- Add existing/new customer branch.

- [x] Successful: Stage model implemented.
- [x] Successful: No immediate phone request after first product interest.

### Phase 3: RAG Sales Answerer

- Use RAG for safe product/company questions.
- Combine retrieved context with playbook constraints.
- Fail closed to deterministic safe fallback.

- [ ] Successful: RAG answer path works in QA.
- [x] Successful: RAG timeout/unavailable remains safe.

### Phase 4: Structured Lead Context

- Capture sales summary and qualification fields.
- Update post-call summary to use sales metadata.
- Make n8n notifications more useful without phone numbers.

- [x] Successful: Lead metadata includes business context.
- [ ] Successful: Notifications include sales summary and secure dashboard link, not phone.

### Phase 5: QA And Rollout

- Add sales dialogue QA to CI.
- Run controlled live calls with RAG QA mode.
- Only then enable RAG for production.

- [x] Successful: CI sales QA green.
- [ ] Successful: Controlled live RAG QA passed.
- [ ] Successful: Production rollout approved.

## Sysadmin Requirements

Before production RAG rollout:

```bash
docker exec technolohit-voice-bridge sh -lc 'getent hosts technolohit-rag-api || true'
docker exec technolohit-voice-bridge sh -lc 'wget -qO- http://technolohit-rag-api:8080/healthz || true'
docker exec technolohit-voice-bridge sh -lc 'printenv | sort | egrep "^(VOICE_RAG|VOICE_ASSISTANT|VOICE_LOG_TRANSCRIPT_PREVIEW|IMAGE_TAG|BUILD_VERSION)=" || true'
```

Need final env values:

```env
VOICE_RAG_API_URL=http://technolohit-rag-api:8080
VOICE_RAG_ENABLED=true
VOICE_RAG_QA_MODE=true
VOICE_LOG_TRANSCRIPT_PREVIEW=false
```

Do not enable normal production RAG until QA mode evidence is reviewed.

- [ ] Successful: Sysadmin confirms RAG container DNS.
- [ ] Successful: Sysadmin confirms RAG health from voice-bridge container.
- [ ] Successful: Env rollout plan approved.

## Acceptance Criteria

The v2 assistant is acceptable when:

- It can explain each TechnoloHit product in a short, useful sales-oriented way.
- It uses RAG/knowledge for product and company questions in controlled QA.
- It asks whether the caller is existing customer/new prospect/agency when relevant.
- It captures at least one useful business context field before contact handoff when possible.
- It does not ask for phone number immediately after first product interest.
- It does not create callback-ready leads without usable contact data.
- It keeps all phone/privacy guardrails from v1.1.x.
- It handles unclear audio without repeating the same offer loop.
- It produces n8n/lead-dashboard data that helps the team act quickly.

- [ ] Successful: Product sales behavior accepted.
- [ ] Successful: RAG behavior accepted.
- [ ] Successful: Lead quality accepted.
- [ ] Successful: Privacy behavior accepted.
