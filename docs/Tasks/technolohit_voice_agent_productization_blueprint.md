# TechnoloHit Voice Agent Productization Blueprint

## Purpose

This document is a strategic and technical guide for improving the current TechnoloHit AI phone assistant and turning it into a product-grade `Digital Reception System`.

It is **not** a single implementation task. Cursor/Codex should read this document before proposing or implementing the next steps.

Companion execution plan:

```text
docs/Tasks/technolohit_voice_agent_productization_implementation_plan_v1.md
```

That file turns this blueprint into phased engineering work.

The goal is to help Cursor understand:

- what TechnoloHit sells
- why the current voice assistant still feels weak
- where the gap is compared with mature AI voice-agent companies
- what should be improved first
- what should not be over-engineered too early
- how this can later become a deployable product for customers

---

## 1. Executive Summary

TechnoloHit already has strong product assets:

1. `Smart Website`
2. `AISeoQ`
3. `Botinteg`
4. `LokalKI`
5. `Digitaler Telefonassistent` / `AI Voice Agent Assistant`

The current voice assistant infrastructure is technically promising, but the caller experience is still not product-grade.

The issue is not only the AI model. The bigger gap is:

```text
conversation design + state machine + fallback ladder + product knowledge + human handoff + QA loop
```

The assistant must move from:

```text
voice chatbot
```

to:

```text
Digital Reception System
```

The assistant should be able to:

- answer calls professionally
- explain TechnoloHit’s products in simple German
- guide callers to the right product
- answer short follow-up questions
- offer callback or email handoff
- close conversations naturally
- avoid overpromising
- produce usable data for follow-up later

---

## 2. Current Problem

The assistant has improved technically, but it still does not feel like a professional company receptionist.

Observed issues:

- It answers some questions correctly but sounds transactional.
- It does not naturally explain the full TechnoloHit product portfolio.
- It does not invite callers to ask about products.
- It does not guide callers through product choices.
- It does not consistently close conversations warmly.
- It can feel like a basic IVR or unfinished chatbot.
- It does not yet create enough trust for a customer who is evaluating whether to buy a voice assistant product from TechnoloHit.

This is dangerous from a sales perspective:

```text
If our own voice assistant sounds weak, customers will not trust us to sell voice automation.
```

---

## 3. Gap Compared With Mature AI Voice-Agent Companies

Large companies do not usually rely on one model and one prompt.

They typically have:

- robust telephony integration
- strong end-of-turn detection
- stateful conversation management
- deterministic handling for critical flows
- fallback ladders
- DTMF fallback when speech recognition fails
- product/service routing
- human handoff
- QA metrics
- conversation analytics
- continuous improvement from real calls

### Current TechnoloHit Position

TechnoloHit has a good technical foundation:

- VoIP / SIP / Asterisk
- `AudioSocket`
- `voice-bridge`
- OpenAI-based STT / response / TTS
- PostgreSQL persistence
- Docker-based deployment
- manual QA via logs and SQL
- basic state machine and templates

But the maturity gap is in:

| Area               | Current State       | Target State                                        |
| ------------------ | ------------------- | --------------------------------------------------- |
| Product knowledge  | partial             | assistant can explain all products briefly          |
| Conversation style | still robotic       | receptionist-like, friendly, short                  |
| State machine      | improving           | state-first, deterministic for business flows       |
| Fallback           | basic               | layered speech + simplified options + optional DTMF |
| Handoff            | improving           | email/callback choice with clean closing            |
| QA loop            | manual logs         | structured metrics and failure categories           |
| Productization     | internal deployment | repeatable customer deployment package              |

---

## 4. Product Portfolio The Assistant Must Understand

The assistant should not overload callers with technical product names immediately.

It should first ask what the caller needs. But if the caller asks about products, it must be able to explain all major TechnoloHit offers clearly.

The language should be German, short, and business-friendly.

---

## 4.1 Smart Website

### Internal Product Meaning

`Smart Website` is not just a website-design idea.

It is a business system built on TechnoloHit’s own AI and automation infrastructure.

A Smart Website should help `KMU` / local businesses:

- become more visible in Google and modern search systems
- explain services clearly
- capture leads
- answer common customer questions
- integrate an AI chatbot on the website
- report customer requests to the business owner
- support continuous improvement through SEO and content intelligence

### Short German Phone Explanation

```text
Eine Smart Website ist keine normale Website und keine reine Online-Visitenkarte.
Sie hilft kleinen und mittleren Unternehmen, besser gefunden zu werden, Anfragen zu erfassen und Kundenfragen direkt auf der Website zu beantworten.
```

### Slightly Longer German Explanation

```text
Bei einer Smart Website verbinden wir moderne Website-Struktur, lokale Sichtbarkeit, KI-gestützte Kundenkommunikation und Anfrage-Erfassung.
Das Ziel ist, dass die Website nicht nur gut aussieht, sondern aktiv beim Gewinnen und Vorbereiten von Kundenanfragen hilft.
```

### What The Assistant Should Avoid

Do not say:

```text
Wir garantieren Platz 1 bei Google.
```

Say instead:

```text
Wir richten die Website auf relevante Suchanfragen und bessere lokale Sichtbarkeit aus.
```

---

## 4.2 AISeoQ

### Internal Product Meaning

`AISeoQ` is a `SEO Execution Workspace`.

It is mainly useful for:

- agencies
- IT companies
- SEO teams
- web agencies
- content teams

It helps teams improve websites through:

- page analysis
- competitor comparison
- content audit
- keyword/query opportunities
- prioritized action plans
- SEO editor
- reports for customers

It is not just a keyword tool and not a clone of `SISTRIX` or `Semrush`.

It is designed to convert SEO evidence into action:

```text
Analysis → Prioritization → SEO Editor → Action Plan → Report
```

### Short German Phone Explanation

```text
AISeoQ ist ein SEO-Arbeitsbereich für Agenturen und IT-Unternehmen.
Er hilft dabei, Webseiten zu analysieren, mit Wettbewerbern zu vergleichen und konkrete Verbesserungen für bessere Sichtbarkeit abzuleiten.
```

### Slightly Longer German Explanation

```text
AISeoQ unterstützt Teams dabei, SEO nicht nur zu messen, sondern umzusetzen.
Es verbindet Analyse, Wettbewerbsvergleich, Content-Audit, Maßnahmenplanung und kundenfertige Reports in einem Arbeitsprozess.
```

### Best Caller Fit

If a caller says they are an agency, IT service provider, web designer, or SEO consultant, the assistant should mention `AISeoQ`.

---

## 4.3 Botinteg

### Internal Product Meaning

`Botinteg` is an AI chatbot and intelligent automation platform.

It is especially useful for small companies with limited budgets that want automation without building everything from scratch.

It can support:

- AI chatbots for websites
- answering frequent customer questions
- lead capture
- storing leads in the business database
- integrations with communication channels and business tools
- social media / messaging workflows where configured
- automation around customer inquiries

Botinteg should be treated as a customer-communication and automation engine.

Important: For architecture and security, public widget traffic must not get access to privileged owner-only integrations or private actions.

### Short German Phone Explanation

```text
Botinteg ist unsere Lösung für KI-Chatbots und einfache Automatisierung.
Damit können Unternehmen Kundenfragen beantworten, Anfragen erfassen und Abläufe mit weniger manuellem Aufwand organisieren.
```

### Slightly Longer German Explanation

```text
Botinteg hilft vor allem kleinen Unternehmen, mit überschaubarem Budget intelligente Automatisierung zu nutzen.
Zum Beispiel für Website-Chat, häufige Fragen, Lead-Erfassung und einfache Integrationen mit bestehenden Abläufen.
```

### What The Assistant Should Avoid

Do not overpromise every integration in every case.

Say:

```text
Je nach Setup können Integrationen und Automationen geplant werden.
```

Do not say:

```text
Wir integrieren garantiert alle Kanäle sofort.
```

---

## 4.4 LokalKI

### Internal Product Meaning

`LokalKI` is like a private ChatGPT-style assistant for organizations with sensitive data.

It is intended for businesses or institutions that need:

- local/private deployment
- stronger data control
- internal network use
- offline or limited-internet operation where technically feasible
- private knowledge assistant behavior
- control over sensitive information

### Short German Phone Explanation

```text
LokalKI ist eine private KI-Lösung für Unternehmen mit sensiblen Daten.
Sie kann lokal oder in einer kontrollierten Umgebung genutzt werden, damit interne Informationen besser geschützt bleiben.
```

### Slightly Longer German Explanation

```text
LokalKI ist für Organisationen gedacht, die KI nutzen möchten, aber mehr Kontrolle über Daten, Infrastruktur und Zugriff brauchen.
Je nach Setup kann die Lösung in der eigenen Umgebung betrieben werden.
```

### What The Assistant Should Avoid

Do not claim full compliance or absolute security.

Say:

```text
für höhere Anforderungen an Kontrolle und Datenschutz
```

Do not say:

```text
100% DSGVO-konform und garantiert sicher
```

unless legally and technically verified.

---

## 4.5 Digitaler Telefonassistent / AI Voice Agent Assistant

### Recommended Customer-Facing Name

Use:

```text
Digitaler Telefonassistent
```

or:

```text
Digitale Rezeption
```

Avoid making the customer-facing name too technical.

### Internal Product Meaning

This is the new TechnoloHit voice capability.

It can answer incoming calls, provide basic information, guide callers to the right product, collect callback requests, store call-related information, and later notify business owners about new leads.

Future target:

```text
Heute wurden 5 neue Anfragen erfasst. Bitte prüfen Sie diese Leads.
```

### Short German Phone Explanation

```text
Unser digitaler Telefonassistent kann eingehende Anrufe annehmen, erste Fragen beantworten und Anfragen für das Team vorbereiten.
```

### Slightly Longer German Explanation

```text
Der digitale Telefonassistent unterstützt Unternehmen dabei, auch dann erreichbar zu sein, wenn gerade niemand ans Telefon gehen kann.
Er kann Fragen aufnehmen, Rückrufwünsche vorbereiten und wichtige Informationen für das Team speichern.
```

### What The Assistant Should Avoid

Do not say:

```text
Er ersetzt Ihr Personal vollständig.
```

Say:

```text
Er unterstützt Ihr Team und hilft, keine wichtigen Anfragen zu verlieren.
```

---

## 5. Product Overview Flow For The Voice Assistant

The assistant should support a product overview flow.

### Trigger Examples

Caller says:

```text
Welche Produkte haben Sie?
Was bietet TechnoloHit an?
Was machen Sie genau?
Welche Lösungen gibt es?
Ich möchte wissen, was Sie anbieten.
Produktliste.
Liste der Produkte.
```

### Assistant Response

```text
Gerne. TechnoloHit bietet fünf zentrale Lösungen an:
Smart Websites, AISeoQ, Botinteg, LokalKI und einen digitalen Telefonassistenten.
Möchten Sie zu einem Produkt mehr erfahren?
```

If caller needs help choosing:

```text
Sie können einfach den Produktnamen sagen, zum Beispiel Smart Website oder Botinteg.
```

Optional numbered version:

```text
Sie können auch eine Zahl sagen: eins für Smart Website, zwei für AISeoQ, drei für Botinteg, vier für LokalKI oder fünf für den Telefonassistenten.
```

### Product List Short Version

If the caller asks for a very short overview:

```text
Smart Websites helfen Unternehmen, online sichtbarer zu werden und Anfragen zu erfassen.
AISeoQ unterstützt Agenturen bei SEO-Analyse und Umsetzung.
Botinteg ist für KI-Chatbots und Automatisierung.
LokalKI ist für private KI in kontrollierten Umgebungen.
Der digitale Telefonassistent beantwortet Anrufe und bereitet Anfragen vor.
```

This should only be used if the caller explicitly asks for product overview. It is too long for every call.

---

## 6. Product Selection Flow

When a caller selects a product:

### Caller: “Smart Website”

Assistant:

```text
Eine Smart Website hilft lokalen Unternehmen, besser gefunden zu werden, Kundenfragen zu beantworten und Anfragen zu erfassen.
Möchten Sie eher mehr Sichtbarkeit, mehr Anfragen oder bessere Kundenkommunikation erreichen?
```

### Caller: “AISeoQ”

Assistant:

```text
AISeoQ ist besonders für Agenturen und IT-Dienstleister interessant.
Es hilft, Websites zu analysieren, Wettbewerber zu vergleichen und konkrete SEO-Maßnahmen für Kunden abzuleiten.
```

Then:

```text
Arbeiten Sie eher für eigene Projekte oder für Kundenprojekte?
```

### Caller: “Botinteg”

Assistant:

```text
Botinteg hilft Unternehmen mit KI-Chatbots und einfachen Automationen, zum Beispiel für häufige Fragen und Anfrage-Erfassung.
Geht es bei Ihnen eher um Website-Chat, Lead-Erfassung oder Automatisierung?
```

### Caller: “LokalKI”

Assistant:

```text
LokalKI ist für Unternehmen gedacht, die KI mit mehr Kontrolle über sensible Daten nutzen möchten.
Geht es bei Ihnen um interne Dokumente, Datenschutz oder eine lokale Installation?
```

### Caller: “Telefonassistent”

Assistant:

```text
Der digitale Telefonassistent kann Anrufe annehmen, erste Fragen beantworten und Rückrufwünsche vorbereiten.
Möchten Sie so etwas für Ihr eigenes Unternehmen prüfen lassen?
```

---

## 7. Closing / Handoff Flow

The assistant should not end abruptly.

After answering a product question:

```text
Wenn Sie möchten, kann unser Team Ihre Situation persönlich einschätzen.
```

Then:

```text
Möchten Sie lieber einen Rückruf oder möchten Sie uns direkt per E-Mail schreiben?
```

### If Rückruf

```text
Welche Telefonnummer dürfen wir für den Rückruf notieren?
```

Then:

```text
Danke. Darf unser Team Sie dazu kontaktieren?
```

If yes:

```text
Danke. Ich gebe Ihre Anfrage an unser Team weiter. Haben Sie noch eine weitere Frage?
```

If no:

```text
Kein Problem. Sie können uns jederzeit per E-Mail unter info@technolohit.com erreichen. Haben Sie noch eine weitere Frage?
```

### If E-Mail

```text
Gerne. Schreiben Sie uns bitte kurz an info@technolohit.com.
Nennen Sie am besten Ihre Website, Ihr Anliegen und falls möglich einen groben Budgetrahmen.
Dann kann unser Team Ihnen eine passende Einschätzung geben. Haben Sie noch eine weitere Frage?
```

### Final Goodbye

If caller says no:

```text
Alles klar. Vielen Dank für Ihren Anruf. Ich wünsche Ihnen einen schönen Tag. Auf Wiederhören.
```

---

## 8. Retrieval / RAG / pgvector Strategy

Production verification on 2026-05-21 showed that pgvector is **not** installed on `central_postgres`.

Current facts:

- current DB image is `postgres:16-alpine`
- `pg_available_extensions` has no `vector`
- `CREATE EXTENSION vector` fails because `vector.control` is not present
- no vector columns exist in production

Therefore Phase 8 must be split clearly:

- **Phase 8a: Lightweight FAQ retrieval**: implemented in `voice-bridge` with keyword/phrase matching over `voice-bridge/knowledge/faqs.technolohit.json`.
- **Phase 8b: pgvector-backed semantic RAG**: not implemented yet and must not be marked complete until production has a pinned pgvector-capable Postgres image, extension verification, schema migrations, ingestion, retrieval API, and QA evidence.

Full architecture decision:

```text
docs/Tasks/technolohit_rag_pgvector_architecture_v1.md
```

Sysadmin infra preparation prompt:

```text
docs/Tasks/sysadmin_pgvector_rag_infra_prep_v1.md
```

Production cutover runbook:

```text
docs/Tasks/sysadmin_pgvector_production_cutover_v1.md
```

Decision status on 2026-05-21:

- Founder, Codex, and Sysadmin/DevOps approved the direction.
- pgvector must be enabled through a pinned infrastructure image, not package installation inside a running container.
- The mandatory dry-run restore passed with pgvector 0.8.2, restored `growth` and `voice` schemas, matching smoke counts, and a successful vector operator smoke test.
- Production cutover is now complete and verified.
- `central_postgres` now runs pinned image:
  - `pgvector/pgvector:0.8.2-pg16-bookworm@sha256:00ba258a66dac104fd5171074a0084462a64a1369d8513f3d0a634e2f24d15bc`
- Active production data path:
  - `/srv/central-postgres/data-pgvector`
- Rollback data path preserved:
  - `/srv/central-postgres/data`
- Runtime/admin user remains `postgres`.
- `vector` extension is active in production (`vector 0.8.2`).
- Post-cutover smoke counts passed:
  - `growth.prospects = 40`
  - `voice.call_sessions = 113`
  - `voice.call_transcripts = 674`
- Vector smoke test passed using `embedding vector(3)` and `<=>` ordering.
- `central-postgres-backup.sh` was verified after cutover.
- Application work may proceed in parallel only behind disabled feature flags until DB/RAG readiness is verified.

### Recommended RAG Direction

Use two layers:

1. Keep live call control deterministic and local in `voice-bridge`.
   - product routing
   - callback/email choice
   - caller ID callback permission
   - contact permission
   - human closing
   - critical short German templates

2. Add semantic retrieval as a separate service.
   - recommended service name: `technolohit-rag-api`
   - recommended stack: FastAPI + central Postgres + pgvector + OpenAI embeddings
   - `voice-bridge` calls this service only as optional fallback/support with a strict timeout
   - if RAG is slow or unavailable, live calls continue with existing deterministic/LLM-safe fallback

### Recommended pgvector Image

```text
pgvector/pgvector:0.8.2-pg16-bookworm@sha256:00ba258a66dac104fd5171074a0084462a64a1369d8513f3d0a634e2f24d15bc
```

Use a versioned tag plus digest. Do not use `pg16` alone for production pinning.

### Migration Principle

Do not install pgvector manually inside a running container.

Do not mutate the production DB before backup.

Do not assume the existing Alpine-created data volume should be mounted directly into a Debian pgvector image. The safer production path is:

```text
1. take pg_dumpall
2. preserve/snapshot the old volume
3. create a new Postgres volume
4. start pinned pgvector image on the new volume
5. restore backup
6. run CREATE EXTENSION IF NOT EXISTS vector;
7. verify extension and existing app schemas
8. only then apply app-owned knowledge schema migrations
```

### Mandatory Dry-Run Restore Gate

Before production cutover, Sysadmin must prove the migration path on a temporary pgvector-enabled container/volume:

```text
1. take logical backup with pg_dumpall
2. verify backup file exists and has non-zero size
3. restore into a temporary pgvector-enabled PostgreSQL 16 container/volume
4. verify technolohit_growth exists
5. verify growth and voice schemas exist
6. verify pgcrypto extension exists
7. run smoke counts for growth.prospects, voice.call_sessions, and voice.call_transcripts
8. run CREATE EXTENSION IF NOT EXISTS vector;
9. verify vector appears in pg_extension
10. discard or keep the dry-run container only as infra evidence, not as production DB
```

Production cutover is blocked until this dry-run gate is green.

Dry-run status:

```text
GREEN on 2026-05-21.
Production cutover completed later on 2026-05-21 (Gate 2 green).
```

### Redis

Redis is still not required for the current single-instance live call path.

Redis may help later with:

- multi-instance voice-bridge state
- low-latency shared call/session state
- distributed locks
- rate limits
- queue coordination

Do not add Redis until there is a concrete scaling or coordination need.

### What RAG Must Not Handle

RAG must not decide critical phone-control flows:

- `Rückruf bitte`
- `per Anruf`
- `telefonisch`
- `per E-Mail`
- `Nummer drei` after a product list
- permission yes/no
- caller ID callback consent

Those remain state-machine and deterministic regex/template flows.

---

## 9. Productization Direction

The future product should be deployable as a configurable single-tenant package.

Target deployment model:

```text
Linux server
Docker Compose
Easybell or compatible SIP provider
Asterisk
voice-bridge
PostgreSQL
OpenAI API key
customer knowledge file
customer .env file
```

### Customer-Specific Configuration

Each customer should be configurable through:

```text
BUSINESS_NAME
ASSISTANT_NAME_OR_IDENTITY
LANGUAGE=de
KNOWLEDGE_PATH
CONTACT_EMAIL
CALLBACK_POLICY
VOICE_MODEL
STT_MODEL
TTS_MODEL
MAX_TURNS
ENABLE_DTMF_FALLBACK
ENABLE_POST_CALL_SUMMARY
```

### Customer Knowledge File

Example:

```text
knowledge/customer.md
```

This should include:

- company description
- services
- opening hours
- callback rules
- products/services
- forbidden claims
- escalation rules
- emergency instructions if relevant
- FAQ

Do not hardcode TechnoloHit product text into the runtime in a way that prevents customer reuse.

---

## 10. Recommended Roadmap

### Status Snapshot (Updated)

- [x] Phase 1 — Human Closing v1 (implemented in production)
- [x] Phase 2 — Product Overview v1 (implemented in production)
- [~] Phase 3 — Fallback Ladder v1 (speech simplification started, DTMF pending)
- [x] Phase 4 — Caller ID Capture (runtime capture + callback permission flow integrated)
- [x] Phase 5 — Post-call Summary (deterministic summary row persisted post-call)
- [x] Phase 6 — Lead Extraction (post-call guarded extraction + enrichment implemented)
- [x] Phase 7 — Notification / Dashboard (async webhook notification path implemented)
- [x] Phase 8a — Lightweight Knowledge Retrieval (file-based FAQ retrieval implemented)
- [x] Phase 8b - pgvector / Semantic RAG Enablement (production cutover green, extension verified)
- [x] Phase 8c - RAG API Service MVP (deployment + approved ingestion + retrieval QA green)
- [~] Phase 8d - Voice RAG Fallback Integration (feature flags prepared, runtime lookup still disabled)
- [ ] Phase 8e - Knowledge Expansion And QA Loop
- [ ] Phase 9 - Productized Deployment

### Phase 1 — Human Closing v1 ✅

Goal:

- Add natural final question.
- Add warm goodbye.
- Avoid abrupt ending.

### Phase 2 — Product Overview v1 ✅

Goal:

- Assistant can list the five TechnoloHit products.
- Caller can select product by name or number.
- Assistant gives one short explanation and asks a useful follow-up.

### Phase 3 — Fallback Ladder v1 🟡

Goal:

- If speech choice fails, simplify:
  - “Sagen Sie Rückruf oder E-Mail.”
  - then optionally:
  - “Drücken Sie 1 für Rückruf oder 2 für E-Mail.”

### Phase 4 — Caller ID Capture ✅

Goal:

- Capture caller number from SIP/Asterisk if available.
- Ask:
  - `Darf unser Team Sie unter dieser Nummer zurückrufen?`
- Avoid asking caller to speak their phone number when possible.

Delivered in runtime:

- `voice-bridge` now accepts optional caller ID values in AudioSocket UUID payload metadata (`JSON` or key-value format).
- Caller ID is persisted into `voice.call_sessions` (`caller_phone_raw`, `caller_phone_normalized`) and call metadata/events.
- In soft intake callback path, if caller ID is available, the assistant skips "Welche Telefonnummer..." and directly asks:
  - `Danke. Darf unser Team Sie unter dieser Nummer zurückrufen?`

### Phase 5 — Post-call Summary ✅

Goal:

Create summary after call:

```text
Product interest:
Caller need:
Preferred contact:
Permission:
Next action:
```

Delivered in runtime:

- Post-call processing now upserts one deterministic `summary_type=auto` row in `voice.call_summaries`.
- Summary fields include: `product_interest`, `caller_need`, `contact_preference`, `permission`, `phone_present`, `email_directed`, `next_action`, `confidence`, `transcript_quality_notes`.
- Summary generation is outside realtime turn playback path and controlled by `VOICE_POST_CALL_SUMMARY_ENABLED`.
- No additional lead extraction and no notification dispatch were added in this phase (reserved for phases 6 and 7).

### Phase 6 — Lead Extraction ✅

Only after summary is stable.

Write to `voice.leads` if schema and privacy rules are ready.

Delivered in runtime:

- Lead extraction now runs post-call after summary generation (outside realtime audio path).
- Existing lead rows are enriched first (to avoid duplicate lead creation).
- New lead rows are created only when guard conditions pass:
  - explicit contact route
  - valid permission path (`phone` requires granted permission; `email` requires directed-email path)
  - sufficient summary quality signal
- Extracted lead metadata is structured (`product_interest`, `contact_preference`, `permission`, `next_action`, `confidence`, `summary_id`) and does not include raw transcript text.

### Phase 7 — Notification / Dashboard ✅

Notify founder/team or customer after call.

Use async post-call processing.

Do not put this into realtime audio path.

Delivered in runtime:

- Added async post-call notification step after summary + lead processing.
- Notification uses optional webhook config (`VOICE_POST_CALL_NOTIFY_ENABLED`, `VOICE_POST_CALL_NOTIFY_WEBHOOK_URL`).
- Notification payload includes compact call outcome fields (`summary`, `lead action/reason`, `next_action`, `confidence`) suitable for founder/team dashboard ingestion.
- Notification processing emits `post_call_notification_processed` event with `sent/skipped/failed` status and reason.
- Realtime turn audio path remains unchanged (no in-call notification calls).

### Phase 8a — Lightweight Knowledge Retrieval ✅

Add lightweight retrieval for product FAQs and customer-specific knowledge only after deterministic flows are stable.

Delivered in runtime:

- Added lightweight FAQ retrieval for clear unknown caller questions before LLM fallback.
- Retrieval source is structured file `voice-bridge/knowledge/faqs.technolohit.json`.
- Retrieval is configurable with `VOICE_KNOWLEDGE_RETRIEVAL_ENABLED` and `VOICE_KNOWLEDGE_RETRIEVAL_MIN_SCORE`.
- If no FAQ match passes threshold, runtime keeps existing safe LLM fallback behavior.
- No pgvector infrastructure was introduced in this phase.

### Phase 8b - pgvector / Semantic RAG Enablement ✅

Goal:

- Prepare central Postgres for semantic retrieval in a production-safe way.
- Enable pgvector in `technolohit_growth` only after backup, dry-run restore, production restore, and smoke verification.
- Keep old `postgres:16-alpine` volume untouched for rollback during the cutover window.

Owner:

- Sysadmin/DevOps owns image pinning, backups, dry-run restore, production volume cutover, health checks, rollback commands, and evidence.
- Application repo owns only app migrations and code after DB readiness is proven.

Required to mark this phase complete:

- `central_postgres` runs a pinned pgvector-enabled PostgreSQL 16 image.
- mandatory dry-run restore succeeded on a temporary pgvector-enabled container/volume.
- `CREATE EXTENSION IF NOT EXISTS vector;` succeeds in `technolohit_growth`.
- smoke queries prove existing `growth` and `voice` data survived restore.
- old `postgres:16-alpine` volume is preserved for rollback.
- Sysadmin sends explicit `PRODUCTION_PGVECTOR_READY=true`.

Current completion status:

- Complete/green in production.
- `PRODUCTION_PGVECTOR_READY=true` confirmed.
- This marks Gate 2 complete only.
- Full RAG is still pending under phases 8c/8d/8e.

Pinned runtime role guidance:

- Migration/admin user remains `postgres`.
- RAG runtime user is pinned to `technolohit_rag_app` (least privilege for `knowledge` schema).

Completion evidence:

```sql
SELECT name, default_version, installed_version
FROM pg_available_extensions
WHERE name = 'vector';

SELECT extname, extversion
FROM pg_extension
WHERE extname = 'vector';

SELECT count(*) FROM growth.prospects;
SELECT count(*) FROM voice.call_sessions;
SELECT count(*) FROM voice.call_transcripts;
```

### Phase 8c - RAG API Service MVP

Goal:

- Build `technolohit-rag-api` as a separate service, not inside `voice-bridge`.
- Provide ingestion, chunking, embedding generation, pgvector retrieval, retrieval logs, and health endpoints.
- Keep it reusable for future customer deployments.

Required endpoints:

```text
GET /healthz
GET /readyz
POST /v1/retrieve
POST /v1/ingest/document
POST /v1/ingest/reindex
```

Required app-owned schema:

```text
knowledge.documents
knowledge.chunks
knowledge.embeddings
knowledge.retrieval_logs
```

Completion evidence:

- knowledge migrations run successfully after pgvector is available. ✅ (Gate 3 green)
- one product/FAQ document can be ingested.
- semantic retrieve for `Was ist Botinteg?`, `Was ist LokalKI?`, and `Was ist eine Smart Website?` returns correct chunks.
- retrieval logs do not store raw sensitive transcript content by default.
- `/readyz` fails safely if DB/vector readiness is missing.

Current status:

- Gate 3 is complete in production:
  - `PRODUCTION_PGVECTOR_READY=true RAG_DB_USER=technolohit_rag_app npm run db:migrate:knowledge` passed.
  - Verified:
    - `knowledge.documents`
    - `knowledge.chunks`
    - `knowledge.embeddings`
    - `knowledge.retrieval_logs`
    - `knowledge.embeddings.embedding` with type `vector`
    - required indexes including `knowledge_embeddings_hnsw_idx`
    - grants for `technolohit_rag_app`
- Gate 4 is complete/green (RAG API deploy + approved ingestion + retrieval QA evidence confirmed).

Prepared in app repo:

- `db/knowledge/migrations/001_knowledge_schema.sql`
- `db/knowledge/migrations/002_knowledge_grants.sql`
- `scripts/db-migrate-knowledge-postgres.js`
- `rag-api/` FastAPI service skeleton
- `rag-api/Dockerfile`
- `rag-api/docker-compose.example.yml`
- `rag-api/scripts/ingest_technolohit_knowledge.py`
- `rag-api/tests/test_contract_static.py`
- `docs/Tasks/sysadmin_rag_api_gate4_execution_v1.md`

Gate 4 QA note:

- Gate 4 is now green after hotfix validation:
  - image: `thnhit/technhvoice:rag-api-gate4-hotfix-v2-20260522-012413`
  - `/healthz` and `/readyz` green with `vector_version=0.8.2`
  - approved knowledge ingest preserved (`docs=11`, `chunks=27`, `embeddings=27`)
  - retrieval QA at `min_score=0.72` passed for:
    - `Was ist Botinteg?`
    - `Was ist LokalKI?`
    - `Was ist eine Smart Website?`
  - deterministic exact product-name boost evidence observed (`score_boost_reason=exact_product_name`)
  - no raw transcript ingestion
  - `VOICE_RAG_ENABLED=false` remains unchanged

Hard gate:

```text
PRODUCTION_PGVECTOR_READY=true
RAG_DB_USER=technolohit_rag_app
```

Without that signal, `npm run db:migrate:knowledge` must not be run against production.

### Phase 8d - Voice RAG Fallback Integration

Goal:

- Let `voice-bridge` use RAG only as optional semantic fallback/support.
- Keep deterministic product routing, Soft Intake, callback/email choices, and permission handling first.
- Ensure live calls never fail because RAG is slow or unavailable.

Feature flags, disabled by default until QA:

```env
VOICE_RAG_ENABLED=false
VOICE_RAG_API_URL=
VOICE_RAG_TIMEOUT_MS=700
VOICE_RAG_MIN_SCORE=0.72
```

RAG must not handle:

```text
Rueckruf bitte
per Anruf
telefonisch
Per E-Mail bitte
Nummer drei after product overview
permission yes/no
caller ID callback consent
```

Completion evidence:

- deterministic product and Soft Intake tests pass with `VOICE_RAG_ENABLED=true`.
- RAG timeout/unavailable test still produces a safe phone answer.
- logs do not expose raw transcript previews by default.
- RAG is used only for clear semantic knowledge questions that deterministic routing did not already handle.

Prepared in app repo:

- `VOICE_RAG_ENABLED=false`
- `VOICE_RAG_API_URL=`
- `VOICE_RAG_TIMEOUT_MS=700`
- `VOICE_RAG_MIN_SCORE=0.72`

Not implemented/enabled yet:

- production validation of live-call RAG HTTP lookup behavior in `voice-bridge`
- production `VOICE_RAG_ENABLED=true`
- Docker image release for `technolohit-rag-api`

Implementation update (Gate 5 slice):

- `voice-bridge` now includes a minimal, feature-flagged RAG fallback code path for unknown-intent clear semantic questions.
- Guardrails in code keep product router and Soft Intake ahead of RAG.
- Fail-closed behavior is implemented for timeout/error/no-hit/low-confidence responses.
- Gate 5 hotfix v2 adds privacy-safe observability logs (`rag attempt`, `rag_status`, `hit_count`, `top_score`, selected source/title), QA-only timeout retry, and QA-only bounded no-hit retry.
- The path remains disabled in production while `VOICE_RAG_ENABLED=false`.

These wait for pgvector production readiness, RAG API QA, and explicit founder/sysadmin approval.

Gate 5 planning artifact:

- `docs/Tasks/voice_assistant_gate5_rag_fallback_planning_v1.md`
- `docs/Tasks/sysadmin_voice_bridge_rag_fallback_gate5_execution_v1.md`

### Phase 8e - Knowledge Expansion And QA Loop

Goal:

- Use real call failures and product questions to improve approved knowledge.
- Keep RAG grounded in curated product/FAQ documents, not raw unreviewed transcripts.
- Add evaluation cases before enabling RAG broadly for customer-facing calls.

Candidate knowledge sources:

- TechnoloHit product catalog
- FAQ catalog
- approved `technolohit.md`
- approved call-summary learnings after human review
- future customer knowledge files

Required before broad production enablement:

- evaluation set for German product questions, short phrases, and imperfect STT.
- minimum retrieval score and fallback policy documented.
- human review process for adding new knowledge.
- no automatic ingestion of raw caller transcripts without explicit privacy review.

### Phase 9 - Productized Deployment

Create repeatable customer deployment pattern:

- Docker Compose
- Asterisk config
- `.env`
- knowledge file
- deployment guide
- rollback notes

---

## 11. Parallel Work Contract

Sysadmin and application development can proceed in parallel, but with clear gates.

### Sysadmin/DevOps Parallel Track

Sysadmin may start immediately:

- prepare backup and restore scripts
- prepare temporary dry-run pgvector container/volume
- pin pgvector image by tag and digest
- verify disk space for backup plus restored volume
- document rollback to old image and old volume
- prepare production maintenance-window checklist
- provide dry-run evidence before app migrations touch production

Sysadmin must not:

- install pgvector manually inside the running production container
- switch production volume/image before dry-run restore passes
- clone the application repo on the DB server as a required migration mechanism
- run app-owned knowledge migrations until the app team provides reviewed SQL

### Application Parallel Track

Application work may start immediately, but must stay safe:

- add app-owned SQL migration files for `knowledge` schema, not run them in production yet
- create `technolohit-rag-api` skeleton and tests
- implement ingestion/retrieval against a local or dry-run pgvector DB
- add `voice-bridge` RAG feature flags with default `false`
- keep deterministic routing before RAG
- document QA and rollback behavior
- require `PRODUCTION_PGVECTOR_READY=true` before applying app-owned knowledge migrations to production

Application must not:

- assume pgvector exists in production
- make live calls depend on RAG availability
- log raw transcript content by default
- auto-ingest raw customer/caller transcripts into knowledge

### Phase Gates

```text
Gate 1: dry-run restore green
Gate 2: production pgvector cutover green
Gate 3: knowledge schema migration green
Gate 4: RAG API ingestion/retrieval green
Gate 5: voice-bridge RAG fallback QA green
Gate 6: production enablement with VOICE_RAG_ENABLED=true
```

Current gate status:

```text
Gate 1: GREEN
Gate 2: GREEN
Gate 3: GREEN
Gate 4: GREEN
Gate 5: GREEN (current slice runtime evidence complete; regression lane remains active)
Gate 6: QA IN PROGRESS (not stable; strategy pivot to lightweight product intake)
```

Current Gate 6 voice-bridge QA candidate (registry):

- `thnhit/technhvoice:voice-bridge-gate6-text-qa-harness-v21-20260523-0200`

v21 packages `/app/scripts/qa-dialogue-text.js` into the runtime image (v20 omitted `COPY scripts` in Dockerfile).

Text QA is a **precondition** for live-call Gate 6 QA; it does not replace live-call validation.

Customer deploy must configure `VOICE_CONTACT_EMAIL` and `VOICE_WEBSITE_URL` in server `.env` for spoken email/website instructions.

Do not mark Gate 6 stable until section 6.1 runtime matrix in `docs/Tasks/sysadmin_voice_bridge_rag_gate6_rollout_v1.md` passes.

Gate 6 productization direction (explicit business rule):

- voice agent role is **intelligent receptionist + lightweight product intake**
- it is **not** a full sales consultant in voice channel
- standard flow is: detect topic -> short pitch -> handoff choice (`E-Mail` or `Telefon`) -> minimal contact capture -> polite close
- product copy is data-driven and editable without modifying the core turn state machine

Do not mark later gates complete just because code exists. Each gate needs runtime evidence.

Gate 5 remains a recurring quality/safety regression lane even after it reaches green for a specific slice:

- callback/contact-preference recognition quality
- RAG hit/no-hit/low-confidence behavior
- product-routing and soft-intake priority regressions
- STT dialect/accent robustness
- privacy/logging behavior

Gate 5 closure artifact for current slice:

- `docs/Tasks/voice_assistant_gate5_closure_evidence_v1.md`

Gate 6 controlled rollout still requires explicit founder/sysadmin approval after QA matrix passes; current phase is deploy-and-verify on v6 only.

Gate 6 planning artifact:

- `docs/Tasks/sysadmin_voice_bridge_rag_gate6_rollout_v1.md`

Separate future planning lanes (not part of Gate 5 closure or automatic Gate 6 rollout):

- TTS speaking speed tuning for phone UX
- multilingual voice UX rollout (German default, English next, additional languages only after dedicated QA gates)

---
## 12. Cursor Instructions

Cursor should not mark pgvector complete without production verification.

Cursor should first inspect current `voice-bridge`, `db`, and infra runbooks, then implement small, sequential steps.

Recommended next task after Sysadmin approves the DB migration approach:

```text
voice_assistant_pgvector_enablement_v1.md
```

Scope:

- add app-owned `knowledge` SQL migrations only after pgvector is verified
- add `technolohit-rag-api` skeleton and health checks
- add ingestion for approved product/FAQ knowledge
- add retrieval endpoint with timeout-safe behavior
- add optional `voice-bridge` RAG fallback behind feature flags
- keep deterministic product routing before RAG
- no in-place package install inside production Postgres
- no DB mutation before backup
- no raw transcript logging by default

Cursor should be encouraged to propose better ideas, but only if they preserve:

- minimal blast radius
- modularity
- phone-friendly UX
- state-machine-first logic
- no premature infra
- productization readiness

---

## 13. Implementation Guardrails

Do not implement:

- full SaaS multi-tenancy
- Redis unless a concrete need is proven
- pgvector production cutover without dry-run restore evidence
- lead extraction before post-call summary
- notifications inside realtime call path
- long product lectures
- exact pricing claims
- SEO ranking guarantees
- DSGVO compliance claims without evidence
- private integration access from public voice/customer channels

---

## 14. Quality Bar

The assistant should feel like:

```text
a calm, professional digital receptionist
```

not like:

```text
a generic chatbot reading a prompt
```

Minimum experience:

1. Greets briefly.
2. Understands main product interest.
3. Can explain product list.
4. Can explain selected product briefly.
5. Can route to callback or email.
6. Closes politely.
7. Does not overpromise.
8. Does not ask too many questions.
9. Does not break when caller asks for product list.
10. Produces useful logs/metadata for QA.

---

## 15. Final Strategic Direction

TechnoloHit should position this as:

```text
Digitale Rezeption für KMU
```

or:

```text
Digitaler Telefonassistent für lokale Unternehmen
```

It can become part of the `Smart Website` package:

```text
Smart Website + Website Chat + Digitaler Telefonassistent + SEO improvement loop
```

That is a strong offer for local businesses in Germany.

But first, the assistant must demonstrate this quality on TechnoloHit’s own phone line.

The next implementation should therefore improve:

```text
human conversation quality + product portfolio understanding + closing behavior
```

before adding more infrastructure.
