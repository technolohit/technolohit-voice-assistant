# Phase 11A - Publish Governance Closure

**Date:** 2026-06-22

## Outcome

Phase 11 governance is complete. The founder-approved published playbook exists as an immutable, schema-validated artifact, but runtime activation and canary work have not started.

## Artifacts

- Candidate: `voice-bridge/config/playbooks/technolohit.main_voice_sales.v1.publish-candidate.json`
  - version: `technolohit-playbook-v1-20260620-candidate`
  - mode: `candidate`
  - status: `draft`
  - founder approval: `pending`
  - runtime binding: inactive
- Published: `voice-bridge/config/playbooks/technolohit.main_voice_sales.v1.published.json`
  - version: `technolohit-playbook-v1-20260622-published`
  - mode: `published`
  - status: `published`
  - founder approval: Mojtaba, 2026-06-22
  - content approval: true
  - runtime binding: inactive
  - canary approval: pending

## Founder Decisions

1. Callback finalized wording uses the live-tested text:
   `Vielen Dank. Ich habe die Anfrage aufgenommen. Unser Team meldet sich telefonisch bei Ihnen.`
2. Missing/invalid phone uses the concise current contact-form fallback from `DEFAULT_PHONE_CAPTURE_FAILURE_PHRASE`.
3. Botinteg is excluded from published v1 because it is absent from the founder-approved Markdown. The Phase 9 draft baseline remains unchanged.

## Validation Contract

`playbook-publish-validator.js` now requires an explicit mode and artifact path.

- Candidate mode requires draft/pending/unapproved/inactive metadata.
- Published mode requires published/approved founder metadata and `approval.approved_for_runtime=true`, while still requiring `runtime_binding.active=false`.
- Candidate/published mode mismatch fails closed.
- A top-level `approved_for_runtime` field is rejected; nested `approval.approved_for_runtime` is authoritative.
- Published v1 rejects Botinteg, unapproved callback wording, and unapproved no-valid-phone wording.
- Both modes require unique versions, green evals, safe policies, and privacy-safe CLI output.

Published eval runs against an in-memory draft projection of identical content. This allows governance eval without weakening the runtime rule that published playbooks are not runtime-eligible until their binding is separately activated.

## Commands

```text
npm run playbook:publish-validate
npm run playbook:publish-validate:published
```

Both commands must report zero failures. Activation is deliberately outside Phase 11A.

## Boundaries

- No runtime planner/RAG/callback behavior changes
- No production environment changes
- No v4 flag changes
- No Docker, deploy, tag, or live canary changes
- No rag-api changes
- `docs/Tasks/logs.txt` untouched

## Next Phase

The next work is a separately approved canary-readiness phase. It must select the published artifact explicitly, keep activation scoped to a supervised v4 canary, run all preflights/evals first, and preserve immediate rollback to v3/RAG-off.
