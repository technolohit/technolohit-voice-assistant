# Voice Assistant Live Call Runtime Fix v1

## Goal

Fix the live-call behavior of the TechnoloHit Voice Assistant.

The previous `conversation_quality_v1` improved the knowledge base and static templates, but live call testing shows the assistant still performs poorly in real calls.

This task focuses on runtime call quality:

- shorter greeting
- correct deployment/regeneration of greeting audio
- better caller turn capture
- less cutting off caller speech
- stronger intent detection for imperfect STT
- deterministic templates for critical business intents
- reduced unsafe LLM fallback
- shorter phone-friendly answers
- dedicated email-campaign caller handling
- live-call QA instrumentation/reporting

This is not a lead pipeline task.

---

## Evidence From Live Calls

Recent live-call logs show:

- greeting still uses `/app/audio/greeting.slin`
- caller turns are often cut off after fixed ~5 seconds
- STT returns partial phrases like:
  - `Kann ich so einen Telefon...`
  - `konnen Sie mich auf`
  - `Ich habe eine Webseite und frage ich...`
- `Platz eins bei Google` questions sometimes route to LLM instead of safe SEO guarantee template
- assistant responses are too long for phone usage
- some responses take 10–15 seconds playback time
- several turns fall back to clarification even when caller intent is understandable
- email campaign caller scenario is not deterministic yet

The goal is to make the assistant usable in real phone conversations before adding lead extraction, notifications, summaries, or integrations.

---

## Current Known Architecture

Relevant files from previous inspection:

```text
voice-bridge/src/audiosocket.js
voice-bridge/src/media-outbound.js
voice-bridge/src/audio-media.js
voice-bridge/src/turn-assistant.js
voice-bridge/src/config.js
voice-bridge/src/index.js
voice-bridge/scripts/generate-greeting-openai.js
voice-bridge/knowledge/technolohit.md
voice-bridge/.env.example
.env.example
voice-bridge/README.md
The current assistant is hybrid:

STT per turn
deterministic templates for known intents
LLM fallback for unknown clear intents
OpenAI TTS for assistant responses
response length controls exist
knowledge loads from voice-bridge/knowledge/technolohit.md
Product Decisions

Keep these decisions:

Language: German only
Identity: digitaler Assistent von TechnoloHit
No human name
No exact pricing
No ranking guarantees
No DSGVO/compliance guarantees
No default product-name-heavy answers
No lead extraction
No n8n
No Botinteg integration
No CRM integration
No notification workflows
No calendar booking
In Scope
1. Fix Greeting Experience

The current greeting is too long and still appears to be served from:

/app/audio/greeting.slin

Inspect how greeting audio is sourced/generated/deployed.

Update the greeting text to a short production-friendly version.

Preferred MVP greeting:

Hallo, hier ist der digitale Assistent von TechnoloHit. Wobei kann ich Ihnen helfen?

If a notice is currently required by existing config or product decision, use the shorter notice version:

Hallo, hier ist der digitale Assistent von TechnoloHit. Zur Bearbeitung Ihrer Anfrage kann eine Textnotiz gespeichert werden. Wobei kann ich Ihnen helfen?

Tasks:

locate the source greeting text
regenerate greeting audio if the repository supports it
ensure the correct generated file is used by runtime
document the exact generated file/path
document if deployment/manual copy is required
do not leave old greeting active silently

Do not make legal claims. Do not add long consent text in this task unless already required by current configuration.

2. Improve Caller Turn Capture

Current behavior appears to use a fixed ~5 second listening window.

This cuts off callers mid-sentence.

Inspect listenForTurn / caller audio capture in:

voice-bridge/src/turn-assistant.js

Implement a low-risk improvement.

Preferred behavior:

min_listen_ms = 2500
max_listen_ms = 10000
end_silence_ms = 900

The assistant should stop listening after speech appears to have ended, not blindly after 5 seconds.

If proper VAD is not available, implement a safe energy/silence-based heuristic using existing audio buffers.

Requirements:

preserve existing architecture
keep bounded max listen time
avoid infinite listening
avoid breaking calls with silence
document thresholds in config if feasible
add .env.example entries if new env vars are added
keep defaults safe

Suggested env names if needed:

VOICE_ASSISTANT_MIN_LISTEN_MS=2500
VOICE_ASSISTANT_MAX_LISTEN_MS=10000
VOICE_ASSISTANT_END_SILENCE_MS=900

If a true silence heuristic is risky, increase configurable listen max and document limitation, but still avoid hard-coded 5 seconds.

3. Strengthen Intent Detection For Imperfect STT

STT from phone calls is imperfect. Intent detection must tolerate broken German.

Update intent detection in voice-bridge/src/turn-assistant.js.

Critical intents must be detected even with partial or grammatically broken transcripts.

Add robust patterns for:

seo_guarantee_question

Should match phrases such as:

platz eins
platz 1
erste seite
google bringen
bei google nach oben
ranking garantieren
platz eins bei google
mich auf platz eins
auf platz eins bringen

Also tolerate broken STT like:

Dann sind mich auf Platz eins bei Google
kann man sie mich auf Platz eins beibringen
konnen Sie mich auf
pricing_question

Should match:

was kostet
kosten
preis
preise
wie teuer
budget
angebot
smart_website_interest

Should match:

intelligente website
intelligente websites
smart website
webseite
website
internetauftritt
neue website
moderne website
voice_assistant_question

Should match:

telefonassistent
voice assistant
sprachassistent
digitaler assistent
ki telefon
telefon
anruf
anrufe beantworten
email_campaign_caller

Add dedicated intent for:

ich habe ihre email bekommen
ich habe ihre e-mail bekommen
ich habe eine email von ihnen bekommen
wegen ihrer email
wegen der nachricht
sie haben mir geschrieben
ich rufe wegen der email an
human_or_ai_question

Should match:

sind sie ein mensch
bist du ein mensch
spreche ich mit einer ki
sind sie eine ki
roboter
assistant
assistent
4. Critical Intents Must Use Templates

Do not let critical intents fall through to LLM if detectable.

These should be deterministic template responses:

seo_guarantee_question
pricing_question
smart_website_interest
voice_assistant_question
email_campaign_caller
human_or_ai_question
free_analysis_request
callback_request
technology_question
english_language

If transcript is short but contains a strong signal, prefer the template.

Example:

Caller: "Was kostet eine Webseite?"
Assistant: "Das hängt vom Umfang ab. Wenn Sie möchten, kann unser Team Ihre Situation kurz prüfen und Ihnen eine erste Einschätzung geben."

Example:

Caller: "Können Sie mich auf Platz eins bei Google bringen?"
Assistant: "Seriöse Ranking-Garantien geben wir nicht. Wir verbessern Struktur und Inhalte, damit Ihre Website bessere Chancen bei passenden Suchanfragen hat."

Example:

Caller: "Ich habe Ihre E-Mail bekommen."
Assistant: "Danke. Dann geht es wahrscheinlich um die kostenlose Website-Ersteinschätzung. Für welches Unternehmen rufen Sie an?"
5. Reduce LLM Fallback Aggressiveness

The LLM fallback currently creates vague or bad answers for important business cases.

Adjust fallback policy:

If transcript is too short/incomplete but has a strong keyword, use a template.
If transcript is unclear and has no strong keyword, ask one short clarification.
Only use LLM fallback for clear, non-critical questions.
If LLM is used, enforce very short response.

Preferred clarification:

Entschuldigung, ich habe das nicht sicher verstanden. Geht es um eine Website, mehr Sichtbarkeit oder einen Rückruf?

Avoid:

Könnten Sie bitte konkretisieren, worauf Sie mich gerne ansprechen möchten?

It sounds unnatural on the phone.

6. Shorten All Phone Responses

Hard requirement:

normal answer: max 1–2 short sentences
max one follow-up question
no long marketing explanations
no multi-topic answers
no “Möchten Sie mehr über unsere Dienstleistungen erfahren?” generic question
prefer direct next-step questions

Examples:

Good:

Eine intelligente Website hilft lokalen Unternehmen, besser gefunden zu werden und Anfragen besser zu erfassen. Für welche Art von Unternehmen rufen Sie an?

Bad:

TechnoloHit konzentriert sich darauf, Unternehmen mit intelligenten Websites zu unterstützen. Unsere Lösungen helfen Ihnen, Ihre Besucher besser zu gewinnen und zu betreuen. Möchten Sie mehr über unsere Dienstleistungen erfahren?
7. Add Email Campaign Caller Template

This is important for upcoming outreach.

Intent: email_campaign_caller

Template:

Danke. Dann geht es wahrscheinlich um die kostenlose Website-Ersteinschätzung. Für welches Unternehmen rufen Sie an?

Follow-up flow should remain conversational and transcript-based for now.

Do not implement lead extraction.

8. Improve Conversation End / Max Turns Behavior

Current calls can end with max turns while caller still expects help.

Inspect max turn behavior.

Do not create a complex state machine yet.

But ensure that when max turns are reached, the assistant closes politely with callback orientation:

Ich gebe Ihre Anfrage gerne an unser Team weiter. Wann passt Ihnen ein kurzer Rückruf?

If the system cannot collect/store callback reliably yet, keep this conversational and rely on transcript.

9. Add Runtime Debug Metadata For QA

Without exposing transcript previews by default, add safe metadata to events/logs if not already present.

Useful fields:

detected_intent
transcript_quality
used_template_response
used_llm_response
used_clarification_fallback
listen_duration_ms
speech_end_detected
audio_bytes_captured
response_length
playback_ms

Do not log raw transcript unless VOICE_LOG_TRANSCRIPT_PREVIEW=true.

Do not log secrets.

Do not create migrations unless strictly necessary. Prefer existing metadata JSONB fields.

Out Of Scope

Do not implement:

lead extraction
writes to voice.leads
writes to voice.call_summaries
n8n
email notification
Telegram notification
CRM integration
Botinteg integration
calendar booking
new customer deployment platform
multi-tenant SaaS architecture
major architecture refactor
new database migrations unless absolutely unavoidable
exact pricing
pilot discount automation
Verification Requirements

Run static checks:

node --check voice-bridge/src/config.js
node --check voice-bridge/src/index.js
node --check voice-bridge/src/turn-assistant.js
npm run validate

If greeting generation script is used, document the command and output path.

If automated tests exist, run relevant tests.

Manual Live Call QA Required

After implementation, create a report:

docs/Tasks/voice_assistant_live_call_runtime_fix_v1_report.md

The report must include:

files changed
greeting source and output file
whether greeting was regenerated
listen/turn capture changes
intent detection changes
template changes
LLM fallback changes
env vars added/changed
validation commands/results
manual test checklist

Manual test checklist:

Scenario	Caller phrase	Expected
Smart Website	Ich interessiere mich für Ihre intelligente Website.	short explanation + asks business type
Pricing	Was kostet eine Webseite?	no exact price + offers assessment
SEO guarantee	Können Sie mich auf Platz eins bei Google bringen?	no guarantee template
Voice assistant	Kann ich so einen Telefonassistenten bekommen?	says yes as part of solution, no overpromise
Email campaign	Ich habe Ihre E-Mail bekommen.	routes to email template
Human/AI	Sind Sie ein Mensch?	transparent digital assistant
Unclear partial	Können Sie mich auf...	does not hallucinate, asks short clarification or detects SEO if possible
English	Can you help me in English?	German-only response

If live calls cannot be performed by Cursor, state this clearly and provide exact commands/SQL queries for Founder validation.

SQL QA Queries

Include these or equivalent in the report for founder testing:

SELECT cs.external_call_id,
       ct.speaker,
       ct.sequence_number,
       ct.metadata->>'turn_index' AS turn_index,
       ct.metadata->>'detected_intent' AS intent,
       ct.metadata->>'transcript_quality' AS quality,
       ct.metadata->>'used_template_response' AS template,
       ct.metadata->>'used_clarification_fallback' AS clarification,
       length(ct.text) AS text_len,
       left(ct.text, 250) AS text_preview,
       ct.created_at
FROM voice.call_transcripts ct
JOIN voice.call_sessions cs ON cs.id = ct.call_session_id
WHERE ct.metadata->>'transcript_scope' = 'turn'
ORDER BY ct.created_at DESC
LIMIT 30;
SELECT cs.external_call_id,
       ce.event_type,
       ce.payload,
       ce.occurred_at
FROM voice.call_events ce
JOIN voice.call_sessions cs ON cs.id = ce.call_session_id
WHERE ce.event_type IN (
  'turn_transcribed',
  'assistant_response_created',
  'assistant_response_played',
  'turn_failed',
  'conversation_finished'
)
ORDER BY ce.occurred_at DESC
LIMIT 30;
Success Criteria

This task is successful only if:

greeting is short and correct
old long greeting is not still active
caller speech is less likely to be cut off
key business intents use deterministic templates
Platz eins bei Google routes to no-guarantee template
pricing routes to no-exact-price template
email campaign caller routes to dedicated template
assistant responses are much shorter
LLM fallback is less aggressive
no lead extraction was added
no n8n was added
no Botinteg integration was added
validation passes
report is created
Final Reminder

Fix the live phone experience first.

Do not build downstream automation yet.

Do not add new product integrations.

The priority is: caller hears a short greeting, speaks naturally, is understood better, and gets a short useful German answer.