# Voice Assistant v2 Inspection — TechnoloHit Digital Assistant

## Goal

Inspect the current `voice-bridge` / AI Voice Assistant implementation and produce a factual technical inspection report before any implementation changes.

This is an **inspection-only** task.

The goal is to understand the current architecture, runtime behavior, database schema, privacy risks, recording/transcription behavior, prompt logic, OpenAI usage, lead capture readiness, and future integration points before planning `Voice Assistant v2`.

---

## Why

TechnoloHit has a working AI Voice Assistant MVP connected to its phone infrastructure.

The current assistant can answer calls, use OpenAI, transcribe calls, store call-related data, and act as an early digital phone assistant. However, before improving it into a professional lead-capturing assistant, we need a reliable factual understanding of the current codebase and runtime assumptions.

The next product goal is to turn the voice assistant into a professional first-line `digitaler Assistent von TechnoloHit` that can:

- answer calls in German
- transparently identify itself as a digital assistant
- answer basic questions about TechnoloHit and Smart Websites
- collect structured lead information
- offer a `kostenlose Ersteinschätzung`
- avoid exact pricing unless officially configured
- avoid SEO ranking guarantees
- avoid pretending to be human
- store call/lead data safely
- prepare human callback follow-up
- potentially integrate later with Botinteg or other TechnoloHit systems

Before implementation, the current system must be inspected carefully.

---

## Business Context

TechnoloHit is a Germany-focused AI technology company building practical AI-based systems for local businesses, agencies, and organizations.

The main service currently being promoted is:

```text
Intelligente Websites für lokale Unternehmen
These Smart Websites are positioned as more than normal websites. They are meant to help local businesses:

get found more easily online
explain services clearly
answer frequent customer questions
capture inquiries outside business hours
prepare structured leads
improve customer communication
use TechnoloHit’s own AI systems in the background

The voice assistant is intended to support this offer as a first-line phone assistant and lead intake channel.

For general callers, the assistant should not start with technical product names like Botinteg, AISeoQ, or LokalKI. It should explain the customer value in simple German.

Current Strategic Decisions

These decisions should guide the inspection and future planning:

 Language for MVP: German only
 Assistant identity: digitaler Assistent von TechnoloHit
 No human name for the assistant
 Do not pretend to be human
 Do not give exact prices for now
 Default offer: kostenlose Ersteinschätzung
 No direct calendar booking for now
 Only collect preferred callback time
 Product names like Botinteg, AISeoQ, and LokalKI should not be mentioned by default to general callers
 If asked about technology, explain simply that TechnoloHit uses its own AI systems for visibility, customer communication, and automation
 If recording or transcription is enabled, caller notice/consent behavior must be inspected carefully
 n8n should not be part of realtime audio processing
 n8n may later be used only for async post-call notification or follow-up workflows
Known Founder Context To Verify

The Founder believes the current system includes:

 Inbound phone number via Easybell
 Asterisk receives SIP calls
 Asterisk sends audio to voice-bridge via AudioSocket
 voice-bridge runs as a Docker container
 Docker image may follow a pattern like:
  Docker image may follow a pattern like:
thnhit/technhvoice:voice-bridge-<sha>
 Runtime secrets may be stored on the cloud server in .env
 PostgreSQL database may be:
technolohit_growth
 PostgreSQL schema may be:
voice
 Candidate tables may include:
voice.call_sessions
voice.call_events
voice.call_transcripts
voice.leads
voice.call_summaries
 OpenAI API is used for STT and/or assistant response logic
 Current assistant is MVP-level and needs improved Knowledge and conversation design
 Current implementation may already store call transcripts and call events

Cursor must verify all assumptions against actual repository files and available configuration.

Scope

This task is strictly limited to inspection and reporting.

In Scope
 Locate voice assistant / voice-bridge implementation
 Inspect runtime call flow
 Inspect database schema and migrations/models
 Inspect recording and transcription behavior
 Inspect OpenAI API usage
 Inspect prompt / response logic
 Inspect lead capture readiness
 Inspect notification/follow-up readiness
 Inspect security and privacy risks
 Inspect cost/performance risk areas
 Inspect whether future Botinteg-style integration is structurally feasible
 Produce a factual Markdown inspection report
Out of Scope
 Do not implement new features
 Do not change prompts
 Do not create migrations
 Do not modify database schema
 Do not refactor
 Do not edit Docker files
 Do not edit deployment files
 Do not edit .env or secrets
 Do not add dependencies
 Do not change OpenAI model settings
 Do not add notification workflows
 Do not add n8n workflows
 Do not integrate with Botinteg
 Do not claim GDPR/DSGVO compliance
Key Safety Rules
 This is inspection-only
 Do not make production changes
 Do not run destructive commands
 Do not expose or print secrets
 Do not copy sensitive customer data into the report
 Redact tokens, API keys, passwords, private numbers, and secrets
 Mark uncertain items as Unknown / Requires Follow-up
 Use exact file paths and function/class names wherever possible
 Report facts from code/config only
 Do not infer compliance
 Do not introduce new architecture yet
Phase 1 — Locate Voice Assistant Implementation
Purpose

Find the actual implementation files and understand the project structure.

Tasks
 Locate the main voice-bridge service/module
 Identify the service entrypoint
 Identify audio input handling
 Identify AudioSocket handling, if present
 Identify STT logic
 Identify response generation logic
 Identify TTS/audio response logic, if present
 Identify database access logic
 Identify config/env loading
 Identify Dockerfile / compose / deployment references
 Identify OpenAI client usage
 Identify any n8n references
 Identify logging configuration
Report

Include:

relevant file paths
key functions/classes
module responsibilities
unknowns
Phase 2 — Runtime Call Flow Inspection
Purpose

Document the actual call lifecycle.

Expected Call Flow To Verify
Inbound call
→ Easybell
→ Asterisk
→ AudioSocket
→ voice-bridge
→ STT
→ intent / response logic
→ TTS / audio response
→ PostgreSQL persistence
→ call end
→ optional summary / lead extraction
Tasks
 Document actual inbound call flow
 Identify which parts are synchronous
 Identify which parts are asynchronous
 Identify how call sessions are created
 Identify how caller turns are processed
 Identify how assistant responses are generated
 Identify how errors are handled
 Identify how call ending is detected
 Identify what is persisted during the call
 Identify what is persisted after the call
 Identify any retry/fallback behavior
 Identify failure behavior for STT/OpenAI/DB errors
Report

Include:

actual step-by-step call flow
files/functions responsible for each step
failure handling gaps
unknowns
Phase 3 — Database Schema Inspection
Purpose

Verify the actual voice schema and related persistence model.

Tasks

Inspect all relevant schema/model/migration files.

Confirm whether the following tables exist:

 voice.call_sessions
 voice.call_events
 voice.call_transcripts
 voice.leads
 voice.call_summaries

For each existing table, document:

 columns
 primary key
 foreign keys
 indexes
 timestamps
 status/lifecycle fields
 raw payload fields
 PII fields
 transcript fields
 audio-related fields
 summary fields
 lead fields
 relationships to call sessions
 retention/deletion fields, if any
Important

If actual schema differs from Founder assumptions, report the exact difference.

Do not create migrations.

Phase 4 — Recording and Transcription Behavior
Purpose

Understand what is recorded, transcribed, stored, and controlled by configuration.

Tasks

Inspect:

 env flags such as VOICE_RECORDING_ENABLED
 whether audio recording is enabled
 where audio is stored
 whether audio files are persisted
 whether per-turn transcript is stored
 whether full-call transcript is stored
 whether call summaries are stored
 whether transcript quality metadata is stored
 whether consent/notice status is stored
 whether retention logic exists
 whether deletion/export logic exists
 whether audio/transcript paths are configurable
 whether recording/transcription errors are handled safely
Report

Clearly state:

what is currently stored
where it is stored
whether caller notice/consent is captured
whether retention/deletion exists
unknowns and risks
Phase 5 — Privacy / GDPR / DSGVO Risk Inspection
Purpose

Identify obvious privacy-sensitive data paths.

Tasks

Inspect whether the system stores or logs:

 phone numbers
 caller names
 email addresses
 company names
 website URLs
 call transcripts
 audio files
 call summaries
 OpenAI requests
 OpenAI responses
 raw payloads
 metadata that could identify callers

Inspect whether the system has:

 redaction
 data minimization
 retention settings
 deletion support
 export support
 consent/notice capture
 admin-only access controls, if APIs exist
 public exposure risk
Report

Do not claim compliance.

Report:

implementation facts
privacy-sensitive fields
logging risks
retention gaps
consent/notice gaps
access exposure risks
Phase 6 — Prompt / Knowledge / Conversation Logic Inspection
Purpose

Understand how the current assistant decides what to say.

Tasks

Find and document:

 system prompt location
 hardcoded instructions
 template responses
 intent detection logic
 RAG/knowledge loading, if any
 fallback behavior
 pricing behavior
 offer behavior
 Smart Website explanation behavior
 lead collection behavior
 callback collection behavior
 hallucination protection
 model names
 temperature settings
 max token settings
 prompt length
 whether responses are deterministic or free-form
Report

Classify current behavior:

Deterministic / template-based
LLM-generated
Hybrid
Unknown

Also identify where a future file like this could be loaded safely:

TechnoloHit Voice Assistant Knowledge Base.md
Phase 7 — Lead Capture Flow Inspection
Purpose

Determine whether the current system already extracts or stores leads.

Tasks

Inspect:

 whether voice.leads exists
 whether voice.leads is written today
 where lead extraction happens, if present
 whether lead extraction is rule-based or LLM-based
 whether caller phone number is normalized
 whether email is extracted
 whether website URL/domain is normalized
 whether duplicate matching exists
 whether lead status lifecycle exists
 whether raw extraction payload is stored
 whether source call session is linked
Desired Future Lead Fields To Consider

Do not implement, only compare to current schema:

contact_name
phone
normalized_phone
email
company_name
business_type
city
country
website_url
normalized_domain
main_topic
main_pain_point
preferred_callback_time
lead_status
source_call_session_id
raw_extraction
created_at
updated_at
Report

Include:

current lead capability
missing fields
future implementation considerations
duplicate prevention considerations
Phase 8 — Notification / Follow-up Flow Inspection
Purpose

Check whether there is any post-call notification or follow-up system.

Tasks

Inspect for:

 email notification
 internal Telegram notification
 webhook
 n8n workflow
 admin dashboard
 logs-only follow-up
 post-call summary dispatch
 realtime notification logic
Important Architecture Direction

n8n must not be introduced into realtime audio processing.

If n8n is used later, it should be post-call async notification/follow-up only.

Report

State:

whether notification exists
whether it is realtime or post-call
whether it is safe to extend later
unknowns
Phase 9 — OpenAI Usage / Cost and Performance Inspection
Purpose

Understand cost and latency risks.

Tasks

Inspect:

 STT model used
 chat/LLM model used
 TTS model used, if any
 number of OpenAI calls per caller turn
 whether summaries are generated per turn or post-call
 whether long context is sent every turn
 whether templates reduce model calls
 whether fallback responses avoid model calls
 timeout handling
 retry behavior
 token usage tracking
 logging of model usage
 failure behavior when OpenAI fails
Report

Include:

cost risk areas
latency risk areas
possible future optimization areas
no implementation yet
Phase 10 — Security Inspection
Purpose

Identify obvious security risks.

Tasks

Inspect for:

 plaintext secrets in repository
 secrets in logs
 .env handling
 OpenAI API key handling
 DB credentials handling
 exposed endpoints
 unauthenticated APIs
 transcript exposure
 raw call data exposure
 debug logging of sensitive data
 webhook-like ingress paths
 public access to private voice data
 unsafe file storage
 Docker/deployment risks
Report

Classify each finding:

Low
Medium
High
Critical
Unknown

Do not fix yet.

Phase 11 — Botinteg / Future Integration Reuse Inspection
Purpose

Determine whether future integration with Botinteg-like concepts is feasible without duplicating systems.

Tasks

Do not implement integration.

Only inspect whether the current project or related architecture has reusable concepts for:

 bot knowledge
 FAQ/knowledge base
 conversation/session models
 lead/inquiry models
 owner dashboard/inbox
 integration abstractions
 channel model
 public vs private channel separation
 email notification
 Google Sheets or CRM-style handoff
 admin-only access to private communication data
Important Boundary

Voice call data should be treated as private/owner-side data.

Do not expose voice call data through any public website widget or public endpoint.

Report

Include:

reuse opportunities
duplicate implementation risks
integration unknowns
recommended inspection follow-ups
Phase 12 — Produce Inspection Report
Purpose

Create a factual report for the Founder and planning layer.
C:\Technolohit\technolohit-email-outreach-automation\docs\Tasks\voice_assistant_v2_inspection_report.md
Required Report Structure
# Voice Assistant v2 Inspection Report

## Executive Summary

## Actual Architecture

## Relevant Files and Modules

## Runtime Call Flow

## Database Schema Findings

## Recording and Transcription Findings

## Privacy / GDPR Risk Areas

## Prompt and Conversation Logic Findings

## Lead Capture Findings

## Notification / Follow-up Findings

## OpenAI Usage / Cost Findings

## Security Findings

## Botinteg / Future Integration Reuse Opportunities

## Gaps / Unknowns

## Recommended Next Steps

## Do Not Implement Yet
Report Requirements
 Use exact file paths
 Use exact function/class/module names where possible
 Use factual language
 Mark unverifiable items as Unknown / Requires Follow-up
 Do not include secrets
 Do not include sensitive real caller data
 Redact private data if examples are necessary
 Do not claim compliance
 Do not propose implementation as completed
 Do not modify code
Success Criteria

This inspection task is complete only when:

 The current voice assistant implementation location is identified
 Runtime call flow is documented
 Database schema findings are documented
 Recording/transcription behavior is documented
 Privacy and security risks are listed
 Prompt/conversation logic is documented
 OpenAI cost/performance risks are listed
 Lead capture readiness is documented
 Notification/follow-up readiness is documented
 Future integration/reuse opportunities are documented
 Inspection report exists at:
C:\Technolohit\technolohit-email-outreach-automation\docs\Tasks\voice_assistant_v2_inspection_report.md
 No production code was changed
 No migrations were created
 No configs or secrets were modified
Final Reminder

This is not an implementation task.

Do not build Voice Assistant v2 yet.

First inspect, document, and report.