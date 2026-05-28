# TechnoloHit Voice Agent Productization Implementation Plan v1

Date: 2026-05-21

Owner mindset: build this like the first product proof for a European AI receptionist startup, not like a demo script.

## 0. Why This Plan Exists

Live tests show the current voice assistant has improved, but it still does not sell confidence.

The assistant can now:

- answer the phone
- transcribe turns
- route basic Smart Website/pricing interest
- ask for callback or direct email
- write lightweight lead markers
- end some intake flows cleanly

But it still feels below product-grade because it does not yet:

- explain the full TechnoloHit product portfolio
- guide a caller who asks "what do you offer?"
- recover elegantly from bad STT beyond one narrow flow
- use the knowledge file as a structured product brain
- provide a natural sales/reception path after product explanations
- produce business-ready call outcomes for the founder/team
- demonstrate the quality we want to sell as `Digitale Rezeption`

## 1. Benchmark: What Mature Voice-Agent Companies Do Better

The gap is not only model quality. Mature platforms combine realtime audio, orchestration, tools, state, evaluation, and deployment discipline.

Observed market patterns from public sources:

- OpenAI's Voice Agents SDK is built around low-latency spoken interfaces, speech-to-speech models, VAD, interruptions, tool use, handoffs, history, guardrails, and tracing. Source: https://openai.github.io/openai-agents-js/guides/voice-agents/
- Retell's public OpenAI case study emphasizes natural low-latency calls, function calling, multi-turn workflows, appointment/lead workflows, post-call analysis, real-time analytics, QA, and human escalations. Source: https://openai.com/index/retell-ai/
- ElevenAgents describes the platform as STT + LLM + TTS plus interruption handling, turn-taking logic, and knowledge bases. Source: https://help.elevenlabs.io/hc/en-us/articles/29297698405905-What-is-ElevenAgents
- Vapi positions mature voice agents around phone calls, tool integration, APIs/databases, multi-assistant orchestration, observability, evals, simulations, monitoring, and human escalation. Source: https://docs.vapi.ai/quickstart/introduction

TechnoloHit's current advantage:

- We control the whole stack: Asterisk, voice-bridge, Postgres, Docker, knowledge, and product strategy.
- We can package this for KMU without depending on a closed voice-agent vendor.
- We already have real inbound production calls, not just a browser demo.

Current gap:

| Area | Current TechnoloHit | Product-Grade Target |
|---|---|---|
| Audio pipeline | turn-based STT -> LLM/template -> TTS | eventually realtime speech-to-speech or streaming STT/TTS |
| Product knowledge | Markdown plus templates | structured product catalog + FAQ + business rules |
| Conversation | basic receptionist | product guide + receptionist + safe closer |
| Tooling | DB transcripts/events/leads | summaries, outcomes, follow-up tasks, optional notifications |
| Fallback | clarification and fuzzy regex | fallback ladder: speech simplification, DTMF, human/direct email |
| QA | logs and SQL | call scorecards, failure categories, scenario regression tests |
| Deployment | TechnoloHit-specific | customer-configurable single-tenant package |

## 2. Product Positioning

Customer-facing product name:

```text
Digitale Rezeption
```

Technical/product name:

```text
TechnoloHit AI Voice Agent Assistant
```

Core promise:

```text
Wir helfen kleinen und mittleren Unternehmen, erreichbar zu bleiben, Anfragen sauber aufzunehmen und KI ohne komplizierte Eigenentwicklung zu nutzen.
```

Do not position it as:

```text
fully replacing staff
```

Position it as:

```text
supporting the team, capturing opportunities, and routing callers to the right next step
```

## 3. Product Knowledge Target

The assistant must know five TechnoloHit offers and explain each in one phone-friendly answer.

### 3.1 Smart Website

Core:

```text
Eine Smart Website ist keine reine Online-Visitenkarte. Sie verbindet Website, lokale Sichtbarkeit, KI-Chat und Anfrage-Erfassung, damit KMU besser gefunden werden und mehr Anfragen sauber vorbereiten können.
```

Use when caller says:

- Website
- Webseite
- Homepage
- intelligente Website
- lokale Sichtbarkeit
- Kundenanfragen über die Website

Do not promise:

- Platz 1 bei Google
- fixed traffic/customer increase
- exact delivery time

### 3.2 AISeoQ

Core:

```text
AISeoQ ist ein SEO-Arbeitsbereich für Agenturen, IT-Dienstleister und Webteams. Er hilft, Websites mit Wettbewerbern zu vergleichen und daraus konkrete Verbesserungen und Kundenreports abzuleiten.
```

Use when caller says:

- SEO platform
- agency
- IT company
- customer website analysis
- competitor comparison
- reports for customers

### 3.3 Botinteg

Core:

```text
Botinteg ist eine Lösung für KI-Chatbots und einfache Automatisierung. Kleine Unternehmen können damit häufige Fragen beantworten, Leads erfassen und Abläufe mit Website, Social Media oder internen Tools verbinden.
```

Use when caller says:

- chatbot
- automation
- WhatsApp
- Instagram
- Facebook
- lead capture
- frequently asked questions
- small budget automation

Do not promise every integration automatically. Say integrations depend on setup.

### 3.4 LokalKI

Core:

```text
LokalKI ist eine private KI-Lösung für Unternehmen mit sensiblen Daten. Sie kann in einer kontrollierten oder lokalen Umgebung genutzt werden, damit interne Informationen besser geschützt bleiben.
```

Use when caller says:

- private AI
- sensitive data
- offline
- internal network
- own server
- Datenschutz
- interne Dokumente

Do not claim absolute security or legal compliance.

### 3.5 Digitale Rezeption / Voice Agent

Core:

```text
Die digitale Rezeption kann Anrufe annehmen, erste Fragen beantworten, Rückrufwünsche vorbereiten und Anfragen für das Team speichern.
```

Use when caller says:

- Telefonassistent
- voice agent
- Anrufe beantworten
- digitale Rezeption
- lead intake by phone
- business owner wants call automation

## 4. Target Conversation Shape

The assistant should not immediately dump all products.

Default greeting:

```text
Hallo, hier ist der digitale Assistent von TechnoloHit. Wobei kann ich Ihnen helfen?
```

If caller asks broad offer/product question:

```text
TechnoloHit bietet fünf Lösungen: Smart Websites, AISeoQ, Botinteg, LokalKI und eine digitale Rezeption. Möchten Sie zu einem Produkt kurz mehr hören?
```

If caller says product number/name:

```text
Gerne. [One product explanation]. Geht es bei Ihnen darum, so etwas für Ihr eigenes Unternehmen zu prüfen?
```

If caller is interested:

```text
Wenn Sie möchten, kann unser Team Ihre Situation persönlich einschätzen. Möchten Sie lieber einen Rückruf oder uns direkt per E-Mail schreiben?
```

If email:

```text
Gerne. Schreiben Sie uns bitte kurz an info@technolohit.com und nennen Sie am besten Ihre Website, Ihr Anliegen und einen groben Budgetrahmen. Dann kann unser Team passend antworten.
```

If callback:

```text
Welche Telefonnummer dürfen wir für den Rückruf notieren?
```

Permission:

```text
Danke. Darf unser Team Sie dazu kontaktieren?
```

Final close:

```text
Alles klar. Vielen Dank für Ihren Anruf. Auf Wiederhören.
```

## 5. Productization Architecture Direction

### 5.1 Do Not Start With Redis

Redis is useful when:

- multiple voice-bridge instances share live call state
- we need distributed locks/rate limits
- we need ultra-fast ephemeral session state across workers

Current bottleneck is not Redis. The bottleneck is conversation design, structured knowledge, and QA. Keep in-memory call state plus Postgres until multi-instance scaling is real.

### 5.2 Do Not Start With pgvector

pgvector is useful when:

- customer knowledge becomes large
- semantic FAQ search is needed
- we need post-call transcript clustering
- a customer has many documents

Current product portfolio knowledge is small and should be deterministic/structured. Use JSON/YAML product catalog first. Add pgvector later for customer-specific knowledge retrieval.

### 5.3 Realtime Speech-To-Speech Should Be A Controlled POC

The current STT -> logic -> TTS turn pipeline is easier to debug but slower and less natural.

Create a feature-flagged POC later:

```text
VOICE_RUNTIME_MODE=turn_based | realtime
```

Do not replace the stable AudioSocket path until:

- live SIP reliability is stable
- product routing works
- summary/lead outcomes work
- QA has repeatable scenarios

## 6. Implementation Phases

### Phase 0: Metadata + QA Identity

Goal: every runtime log reveals the exact image and git SHA.

Status:

- Build metadata fix image exists:
  - `thnhit/technhvoice:voice-bridge-build-metadata-fix-v1-20260521-173808`
  - digest `sha256:ebe66d0f525a58dd8151396a09f5be1b2b56f6925dc9b69784b52ee403c30bd1`

Acceptance:

```text
startup ... build_version=<immutable-tag> image_tag=<immutable-tag> git_sha=85dbb09
```

### Phase 1: Product Overview + Product Router v1

Goal: caller can ask what TechnoloHit offers and select one of five products by name or number.

Status:

- Implemented in `voice_assistant_product_overview_router_v1`.
- Docker image:
  - `thnhit/technhvoice:voice-bridge-product-overview-router-v1-20260521-175634`
  - digest `sha256:058cfc139c374e8980afa1befdfcdd6c2654afd873887e38b802cd602ec351f3`

Code scope:

- `voice-bridge/src/turn-assistant.js`
- `voice-bridge/knowledge/technolohit.md`
- optional new file: `voice-bridge/knowledge/products.technolohit.json`
- `voice-bridge/README.md`

Intents to add:

- `product_overview_request`
- `product_selection_smart_website`
- `product_selection_aiseoq`
- `product_selection_botinteg`
- `product_selection_lokalki`
- `product_selection_voice_agent`
- `product_number_1` through `product_number_5`
- `more_detail_request`
- `compare_products_request`

Templates:

- product overview in one short answer
- one short explanation per product
- one useful follow-up question per product

Acceptance:

- "Welche Produkte haben Sie?" gives five products briefly.
- "Nummer drei" explains Botinteg.
- "Was ist LokalKI?" explains private/local AI without compliance guarantees.
- "Erzähl mehr über Smart Website" gives the fuller Smart Website version.
- No generic marketing paragraph.

### Phase 2: Human Closing v1

Goal: the assistant closes naturally after intake or product explanation.

Acceptance:

- After email handoff: asks if caller has another question or says a warm goodbye, depending current policy.
- After callback permission: thanks caller and closes naturally.
- No repeated callback question after the caller already chose email or declined.

### Phase 3: Fallback Ladder v1

Goal: when STT fails, the assistant becomes simpler, not more verbose.

Fallback ladder:

1. Natural prompt.
2. Simplified speech choice:
   - `Sagen Sie bitte nur: Rückruf oder E-Mail.`
3. Optional DTMF:
   - `Drücken Sie 1 für Rückruf oder 2 für E-Mail.`
4. Safe email fallback:
   - `Sie erreichen uns unter info@technolohit.com.`

DevOps need:

- Confirm Asterisk/AudioSocket DTMF frame forwarding is reliable in production.
- No new container required.

### Phase 4: Structured Knowledge v1

Goal: stop relying on a large Markdown file as the only product brain.

Add:

```text
voice-bridge/knowledge/products.technolohit.json
```

Suggested shape:

```json
{
  "products": [
    {
      "id": "smart_website",
      "name": "Smart Website",
      "phone_short_de": "...",
      "phone_detail_de": "...",
      "best_for": ["KMU", "local businesses"],
      "forbidden_claims": ["SEO ranking guarantees"]
    }
  ]
}
```

Acceptance:

- product templates are loaded from structured data
- product copy can be edited without touching code
- missing product data falls back safely

### Phase 5: Post-Call Summary + Outcome v1

Goal: every call produces a useful business outcome after the call, outside the realtime path.

Suggested summary fields:

- product_interest
- caller_need
- contact_preference
- permission
- phone_present
- email_directed
- next_action
- confidence
- transcript_quality_notes

DB:

- Use existing tables if available.
- If `voice.call_summaries` does not exist or is not adequate, propose a small migration.

Acceptance:

- Founder can see what happened without reading full transcript.
- No notifications yet unless explicitly requested.

### Phase 6: Lead Extraction v1

Goal: create better `voice.leads` rows after summary is stable.

Rules:

- Do not write noisy leads from unclear calls.
- Require clear interest or explicit contact route.
- Store structured product interest and outcome metadata.
- Avoid storing sensitive raw transcript in lead metadata.

### Phase 7: Notification/Dashboard v1

Goal: founder/team receives useful follow-up prompts.

Do this asynchronously after call:

- Email/Slack/Teams/n8n can come later.
- Never put slow notification workflows in realtime audio path.

Example notification:

```text
New voice lead: Smart Website interest, callback requested, permission granted.
```

### Phase 8: Customer Package v1

Goal: sell this as a deployable system.

Package:

- Docker Compose
- Asterisk profile
- voice-bridge
- Postgres
- customer `.env`
- customer knowledge file
- deployment/runbook
- rollback guide
- QA call script

Customer-editable files:

- `knowledge/customer.md`
- `knowledge/products.customer.json`
- `.env`

### Phase 9: Realtime Mode POC

Goal: compare turn-based vs realtime for latency and naturalness.

Options:

- OpenAI Realtime API / Agents SDK
- SIP/WebSocket bridge path
- keep current turn-based path as fallback

Acceptance:

- measurable latency improvement
- barge-in/interruption works
- tool boundaries remain safe
- no loss of call persistence

### Phase 10: Scale Infrastructure

Only after customer deployments or multiple simultaneous calls:

- Redis for distributed live call/session state
- pgvector for large customer knowledge and transcript analytics
- queue worker for post-call summary, enrichment, notifications
- dashboard for QA and lead review

## 7. Immediate Cursor Task Recommendation

Create the next task:

```text
docs/Tasks/voice_assistant_product_overview_router_v1.md
```

Scope:

- add product overview intent
- add product selection by name and number
- use deterministic templates first
- optionally add structured product JSON
- update knowledge and README
- add SQL QA expectations
- no Redis
- no pgvector
- no notifications
- no CRM
- no calendar booking
- no realtime rewrite

Implementation target:

```text
Caller: Welche Produkte bieten Sie an?
Assistant: TechnoloHit bietet fünf Lösungen: Smart Websites, AISeoQ, Botinteg, LokalKI und eine digitale Rezeption. Möchten Sie zu einem Produkt kurz mehr hören?

Caller: Nummer drei.
Assistant: Botinteg ist unsere Lösung für KI-Chatbots und einfache Automatisierung. Geht es bei Ihnen eher um Website-Chat, Lead-Erfassung oder Automatisierung?
```

## 8. Sysadmin Needs

Now:

- Deploy metadata-only image if QA needs correct startup logs:
  - `thnhit/technhvoice:voice-bridge-build-metadata-fix-v1-20260521-173808`
  - `sha256:ebe66d0f525a58dd8151396a09f5be1b2b56f6925dc9b69784b52ee403c30bd1`

Soon:

- Confirm DTMF frames are visible in voice-bridge logs/events during test calls.
- Keep Postgres migrations ready for future `call_summaries` if not already present.
- No Redis/pgvector provisioning yet.

Later:

- Redis only for multi-instance live state.
- pgvector only when customer knowledge retrieval becomes larger than structured product/FAQ data.
- background worker container for post-call summary/notifications.

## 9. Quality Metrics To Track

Per call:

- first intent detected
- product interest detected
- product overview success
- product selection success
- fallback count
- clarification count
- handoff route
- permission result
- lead marker created
- conversation finish reason
- caller hangup point
- total call duration
- time to first assistant answer after caller turn

Target before selling:

- 90%+ correct product routing on scripted QA calls
- no repeated contact-choice loop in standard scenarios
- no hallucinated pricing, SEO guarantees, or compliance claims
- clear startup image metadata in every deployment
- stable inbound SIP calls after redeploy

## 10. Founder Decision

The strongest product path is:

```text
Smart Website + Website Chat + Digital Reception + Lead Capture + Follow-up Summary
```

This is easier to sell to KMU than a generic "AI Voice Agent" because it connects directly to business outcomes:

- be reachable
- explain services
- capture leads
- improve online visibility
- reduce manual work

The assistant itself must prove that promise on TechnoloHit's own phone line before we sell it broadly.
