# Phase 12A Immutable Playbook Runtime Binding Report

Date: 2026-06-22
Baseline: `d5e00cb04f8861ef3d6cd0244fe3cd0a1f70f04a`
Status: implemented and locally verified; no deploy or live QA performed

## Delivered

- Added a separate `playbook-runtime-binding-1` JSON contract with binding version, tenant, agent, exact playbook version/artifact, SHA-256, canary scope, status, approval, active flag, and hardcoded rollback target.
- Added a repository sample that is deliberately pending and inactive.
- Added strict binding and artifact loading with an approved `config/playbook-bindings` root, traversal containment, existing-file `realpath` checks that reject symlink escapes, immutable published-artifact classification, checksum verification, identity/version checks, and approval checks.
- Integrated loading once per v4 canary orchestrator through `behavior-policy.js`.
- Passed the exact verified playbook object to product content, questionnaire, callback policy, and Agent Behavior Decision consumers.
- Added `npm run playbook:canary-preflight` with privacy-safe key/value output and stable reason codes.

## Runtime Contract

Binding activation requires:

- active v4 live canary path;
- `VOICE_V4_PLAYBOOK_RUNTIME_ENABLED=true`;
- explicit `VOICE_V4_PLAYBOOK_BINDING_PATH`;
- a binding path that resolves within the package/container `config/playbook-bindings` directory; absolute paths are accepted only under that root;
- `scope=canary`, `status=approved`, `approval.state=approved`, complete approval metadata, and `active=true`;
- exact tenant, agent, playbook version, artifact path, and SHA-256 match;
- referenced artifact is a validated `.published.json` playbook with published release and runtime approval metadata;
- the checksum-verified published artifact has an explicit boolean `runtime_binding.active=false`.

Any failure returns hardcoded behavior without throwing. The legacy `VOICE_V4_PLAYBOOK_PATH` is not consulted by the Phase 12A filesystem runtime. `VOICE_V4_PLAYBOOK_ALLOW_DRAFT` remains only for existing injected test/eval fixtures.

## Safety

- The immutable published artifact was not edited.
- No active approved production binding was added.
- Production defaults remain v3 with all v4/playbook opt-ins off.
- Default-off resolution returns before filesystem loading.
- Binding containment is checked lexically and by `realpath`; a symlink inside the approved root cannot redirect loading outside it.
- The external approved binding is the sole activation authority. The immutable published playbook must remain embedded-inactive and is rejected when embedded activation is true, missing, or non-boolean.
- Preflight output contains no raw paths, product prose, transcripts, contact data, or secrets.

## Verification

The implementation is covered by `v4-phase12a-playbook-runtime-binding.test.js`, including valid bounded-root fixture activation, default-off equivalence, absolute outside-root rejection, relative traversal rejection, symlink escape rejection where the host permits symlink creation, checksum/version/tenant/agent mismatch, embedded activation contract rejection, candidate/draft rejection, pending/inactive/revoked/unapproved/wrong-scope rejection, missing/corrupt files, and safe preflight output.

Final command results are recorded in the implementation report returned with this change. No production environment, deploy workflow, Docker configuration, live canary script, `turn-assistant.js`, RAG API code, or live QA evidence was changed.

## Remaining Sysadmin Risks

- Separate canary approval must be recorded before creating an approved active binding.
- The deployed image and binding must contain the exact published artifact bytes matching the bound SHA-256.
- The binding file must be mounted/readable under `/app/config/playbook-bindings` (the resolved package equivalent) without exposing its path in logs.
- Existing v4 allowlist, STT/TTS, RAG, maintenance-window, and rollback gates remain mandatory.
- A local preflight pass is readiness evidence only; it is not a production or PSTN live pass.
