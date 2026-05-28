# Voice Assistant Simplified Product Intake Strategy v1

Date: 2026-05-22
Status: Gate 6 QA in progress (not stable)

## 1) Strategy Decision

The TechnoloHit voice agent in Gate 6 is defined as:

- intelligent receptionist
- lightweight product intake and lead handoff

It is not a full sales consultant on voice channel.

## 2) Scope

The assistant should:

1. greet professionally
2. detect product/need
3. give a short product pitch
4. ask one handoff choice question (`E-Mail` or `Telefon`)
5. capture minimal contact details
6. optionally answer one short follow-up question
7. close politely

The assistant should not:

- run deep per-product qualification trees
- request budget/company/project scope by voice
- force long multi-step product interviews

## 3) Data-Driven Policy

Policy file:

- `voice-bridge/src/product-intake-policy.js`

Per product:

- `displayName`
- `aliases`
- `pitch`
- `emailInstruction`
- `handoffQuestion`

Supported products:

- Smart Website
- AISeoQ
- Botinteg
- LokalKI
- Digitaler Assistent

## 4) Runtime Principles

- avoid "Rückruf" as primary spoken prompt; prefer `Telefon`, `telefonisch`, `Anruf`
- keep RAG optional; core pitch + handoff must work without RAG
- keep privacy transcript preview flags default `false`
- keep STT prompt-leak rejection

## 5) Simplified Stages

- `idle`
- `pitch`
- `handoff_choice`
- `email_instruction`
- `phone_request`
- `permission`
- `closing`

## 6) QA Matrix (Gate 6 Blocking)

1. `Was macht TechnoloHit?` -> short 5-product overview + asks topic
2. Smart Website request -> pitch + `E-Mail oder Telefon` in same response
3. AISeoQ request -> pitch + `E-Mail oder Telefon`
4. Botinteg request -> pitch + `E-Mail oder Telefon`
5. LokalKI request -> pitch + `E-Mail oder Telefon`
6. Digital assistant request -> pitch + `E-Mail oder Telefon`
7. E-Mail path -> product-specific email instruction (no invented address if not configured)
8. Telefon path -> asks phone number
9. Phone + permission yes -> confirms and asks final short question
10. `Ich habe noch eine Frage` -> `Gerne. Welche Frage haben Sie?`
11. `Nein, danke` -> warm goodbye

Gate 6 remains NOT stable until this matrix passes with runtime evidence.
