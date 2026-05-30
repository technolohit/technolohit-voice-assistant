# Voice Assistant Sales + RAG Orchestrator v2 - Implementation Report

Date: 2026-05-30

## Summary

Implemented the first production-safe slice of the v2 sales conversation redesign.

The assistant now starts product conversations as a consultative sales receptionist instead of immediately offering phone/email handoff. It gives a short product value pitch, asks whether the caller is calling for their own company or a customer project, branches for existing customers, and only offers phone/email handoff after at least one useful sales context answer.

RAG production enablement is still pending sysadmin runtime evidence and controlled QA. The existing RAG fail-closed behavior remains covered by tests.

## v1.2.1 Live QA Patch

Fixed two issues found during the first v1.2.0 live PSTN QA:

- `post-call-summary.js` used a helper from the lead module and crashed with `summaryField is not defined`.
- The `sales_customer_type` stage was too strict and repeated the same question when STT produced natural/rough answers such as `konnen dann projekt`, `die erste`, or `Ich habe meine eigenen Unternehmen`.
- A short explanation request after the first product pitch stays inside the sales flow instead of falling back into a loop.

The assistant now accepts those variants and keeps moving through the sales flow instead of looping. The re-ask copy is shorter:

```text
Sagen Sie bitte kurz: eigenes Unternehmen, Kundenprojekt oder bereits Kunde.
```

## Files Changed

- `voice-bridge/knowledge/sales-playbooks.technolohit.json`
  - New structured sales playbooks for Smart Website, AISeoQ, Botinteg, LokalKI, and Digitale Rezeption.
- `voice-bridge/src/sales-policy.js`
  - New sales policy helpers: playbook loading, customer-type classification, pitch generation, need discovery, handoff offer, validation.
- `voice-bridge/src/turn-assistant.js`
  - Product selection now enters `sales_customer_type` instead of immediate contact handoff.
  - Adds `sales_need_discovery` and `sales_handoff_offer` stages.
  - Product metadata now includes non-sensitive sales stage and customer type.
- `voice-bridge/src/persist.js`
  - Assistant transcript and soft-intake lead metadata now include non-sensitive sales context fields.
- `voice-bridge/src/post-call-summary.js`, `voice-bridge/src/post-call-lead.js`
  - Post-call summary/lead enrichment now carries `customer_type`, `sales_stage`, and `current_problem`.
- `voice-bridge/scripts/qa-dialogue-text.js`
  - Adds sales QA scenarios for no early phone capture, new prospect qualification, and existing customer path.
  - Validates sales playbooks in QA startup.
- `voice-bridge/tests/intelligence-upgrade.test.js`
  - Adds sales playbook validation test.
- `.github/workflows/ci.yml`
  - CI dialogue scenarios now focus on v2 sales behavior and key guardrails.
- `docs/Tasks/voice_assistant_sales_rag_orchestrator_blueprint_v2.md`
  - Checklist updated for completed local implementation phases.

## Behavior Change

Before:

```text
Caller: Ich interessiere mich für AI Assistant.
Assistant: Kurze Erklärung oder telefonischer Kontakt?
```

Now:

```text
Caller: Ich interessiere mich für AI Assistant.
Assistant: Die digitale Rezeption nimmt Anrufe an, beantwortet erste Fragen und bereitet Leads vor. Geht es um Ihr eigenes Unternehmen oder um ein Kundenprojekt?
```

Then:

```text
Caller: Für mein eigenes Unternehmen.
Assistant: Geht es bei Ihnen eher um weniger verpasste Anrufe, bessere Lead-Erfassung oder schnellere Antworten auf typische Fragen?
```

Then:

```text
Caller: Wir verpassen zu viele Anrufe.
Assistant: Das passt zu Digitale Rezeption. Soll unser Team das telefonisch mit Ihnen prüfen, oder möchten Sie lieber per E-Mail starten?
```

## Local Tests

Passed:

```bash
cd voice-bridge
node --check src/sales-policy.js
node --check src/turn-assistant.js
node --check scripts/qa-dialogue-text.js
npm test
```

Passed selected CI dialogue scenarios:

```text
sales_voice_agent_pitch_no_early_phone
sales_customer_type_stt_kundenprojekt
sales_customer_type_first_option
sales_customer_type_own_company_plural
sales_explanation_after_pitch
sales_new_prospect_qualification
sales_existing_customer_path
voice_agent_ki_assistent
voice_agent_telefonassistent
rueckruf_input_maps_to_phone
no_rueckruf_output
unclear_input
unknown_intent
five_products_overview
contact_form_question
email_contents_question
```

## Pending

- RAG runtime DNS/health verification from `technolohit-voice-bridge` to `technolohit-rag-api`.
- Controlled live-call QA with `VOICE_RAG_ENABLED=true` and `VOICE_RAG_QA_MODE=true`.
- Notification template updates to include sales summary and secure dashboard link.
- Production deployment with immutable image tag after CI/Docker publish.

## Sysadmin Required Before RAG Rollout

Run on production:

```bash
docker exec technolohit-voice-bridge sh -lc 'getent hosts technolohit-rag-api || true'
docker exec technolohit-voice-bridge sh -lc 'wget -qO- http://technolohit-rag-api:8080/healthz || true'
docker exec technolohit-voice-bridge sh -lc 'printenv | sort | egrep "^(VOICE_RAG|VOICE_ASSISTANT|VOICE_LOG_TRANSCRIPT_PREVIEW|IMAGE_TAG|BUILD_VERSION)=" || true'
```

Do not enable RAG for normal production traffic until the controlled QA evidence is reviewed.
