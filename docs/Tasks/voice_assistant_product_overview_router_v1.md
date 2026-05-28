# Voice Assistant Product Overview Router v1

Date: 2026-05-21

## Goal

Make the TechnoloHit phone assistant useful when callers ask what TechnoloHit offers. The assistant should explain the five current offers briefly and let callers select a product by name or number before entering the reception-first contact flow.

## Scope

- voice-bridge assistant runtime only
- deterministic intent matching/templates for product overview and product selection
- product knowledge/catalog docs
- metadata and QA documentation

Out of scope:

- Asterisk/Easybell changes
- Postgres schema migrations
- n8n/CRM/notifications
- Redis/pgvector
- realtime speech rewrite
- calendar booking

## Products

1. Smart Website
2. AISeoQ
3. Botinteg
4. LokalKI
5. Digitale Rezeption / Voice Agent

## Required Runtime Behavior

Caller:

```text
Welche Produkte bieten Sie an?
```

Assistant:

```text
TechnoloHit bietet fünf Lösungen: Smart Websites, AISeoQ, Botinteg, LokalKI und eine digitale Rezeption. Zu welchem Produkt möchten Sie kurz mehr hören?
```

Caller:

```text
Nummer drei.
```

Assistant:

```text
Botinteg ist für KI-Chatbots und einfache Automatisierung, etwa FAQ, Lead-Erfassung und Website-Abläufe. Geht es eher um Chatbot oder Automatisierung?
```

## Acceptance Tests

| Caller | Expected |
|---|---|
| `Welche Produkte bieten Sie an?` | `product_overview_request`, template response, no LLM |
| `Nummer drei.` after overview | `product_selection_botinteg`, template response, no LLM |
| `Was ist LokalKI?` | `product_selection_lokalki`, no compliance/security guarantee |
| `Erzähl mehr über Smart Website.` | `product_selection_smart_website` or `product_more_detail_request`, no generic marketing |
| `Ja.` after product explanation | starts reception-first soft intake |

## QA Metadata

Assistant transcript rows should include:

- `detected_intent`
- `product_flow_state`
- `product_interest`
- `product_interest_name`
- `used_template_response=true`
- `used_llm_response=false` for known product paths

No schema migration is required because this uses existing JSONB metadata.
