# Phase 12L — Production Readiness Polish Gate Report

Date: 2026-06-25  
Status: **Ready for Codex review** — not committed  
Scope: ops/readiness polish only (no new voice runtime behavior, no RAG, no v4 GA)

## Context

Phase 12K closed voice runtime behavior on `voice-bridge-v1.36.4`. Phase 12L clears operational blockers before Phase 13 Limited Operational Canary.

| Safe production baseline | Value |
|--------------------------|-------|
| voice-bridge image | `thnhit/technhvoice:voice-bridge-v1.36.4` |
| `VOICE_RUNTIME_VERSION` | `v3` |
| RAG | **off** |
| v4 / playbook flags | **off** |
| Asterisk active calls | **0** (expected between windows) |

---

## 1. n8n notification email shows `undefined` (ops blocker)

### Symptom

Post-call Telegram may deliver, but the email body shows the literal word `undefined` (or an empty body).

### Root cause (not voice-bridge)

`voice-bridge` sends a valid `voice_post_call_outcome_v1` JSON payload. The bug is in **n8n workflow mapping**, not runtime.

Historical failure mode (documented in `voice_lead_notification_implementation_report_v1.md`):

1. Email node sits **after** Telegram in the chain (`Send Telegram Callback` → `Send Email Callback`).
2. Email node input is therefore Telegram output (`telegram_text` only).
3. If the Email node uses `={{ $json.email_text }}`, n8n evaluates `undefined` because Telegram output has no `email_text`.

Repo fix (since formatting hotfix): Email nodes read from Classify Notification:

```text
={{ $('Classify Notification').first().json.email_text }}
```

**Production drift:** live n8n workflow `Tech-Voice-notif` (ID `3uWYMhQ6JfCqKmHv`) may still run an older export without this mapping.

### voice-bridge payload shape (reference)

Built in `voice-bridge/src/post-call-notify.js`:

| Field | Source |
|-------|--------|
| `type` | `voice_post_call_outcome_v1` |
| `call_session_id`, `external_call_id`, `bridge_call_id` | call context |
| `summary.*` | post-call summary metadata (no raw phone) |
| `lead.action` | `created` / `updated` / `skipped` / `failed` |
| `lead.lead_id` | UUID when created |

Phase 12K notification reached voice-bridge with HTTP **200** (`action=sent`). The undefined text is downstream in n8n/email rendering.

### Repo change (Phase 12L)

| File | Change |
|------|--------|
| `workflows/n8n/Tech-Voice-notif.workflow.json` | Email subject/body expressions now include fallbacks: `email_text` → `telegram_text` → static error hint |
| `scripts/n8n-voice-notif-deploy.cjs` | Same fallback expressions for deploy parity |
| `workflows/n8n/README.md` | Note on Classify-direct mapping + fallbacks |

**Mapping changed:** only Email node `subject` and `text` expression strings (callback + review paths). No voice-bridge code change.

### Sysadmin / n8n action checklist (required on production)

1. **Redeploy workflow from repo** (preferred):

   ```bash
   node scripts/n8n-voice-notif-deploy.cjs deploy
   ```

   Or import `workflows/n8n/Tech-Voice-notif.workflow.json` manually in n8n UI.

2. **Verify Email node expressions** on both `Send Email Callback` and `Send Email Review`:
   - Subject: `={{ $('Classify Notification').first().json.email_subject || '[Voice] Lead notification' }}`
   - Body: `={{ $('Classify Notification').first().json.email_text || $('Classify Notification').first().json.telegram_text || 'Voice post-call notification (body missing — verify Tech-Voice-notif Classify Notification output).' }}`
   - **Must not** use `={{ $json.email_text }}` alone.

3. **Confirm credentials** still attached: `TechnoloHit Telegram Bot`, `Ionos-Email-Tech`.

4. **Test webhook** (does not use production call data):

   ```bash
   node scripts/test-voice-lead-notification.cjs callback
   ```

5. **Inspect n8n execution** → `Classify Notification` output must include non-empty `email_text` and `email_subject`; Email node must not show `undefined`.

6. **Optional replay guard:** use a fresh `call_session_id` in test payloads (script already timestamps IDs).

### Pass criteria

- Email body is readable plain text (starts with `CALLBACK LEAD - TechnoloHit Voice Assistant` for callback case).
- No literal `undefined` in subject or body.
- Telegram + email both succeed on test callback scenario.

---

## 2. Lead Dashboard verification — Phase 12K lead

### Target lead

| Field | Value |
|-------|-------|
| `lead_id` | `741f6e28-ffb8-4e66-8a23-2bc10551bb40` |
| `call_session_id` (Phase 12K) | `7a76318a-05b4-4853-b1cb-bf8bc0478cfb` |
| `bridge_call_id` (Phase 12K) | `4737af80-f805-4b3e-bc6c-8ec4b33c1464` |

### Pre-check (SQL on production DB)

```sql
SELECT l.id AS lead_id,
       l.status AS lead_status,
       l.normalized_phone IS NOT NULL AS has_normalized_phone,
       l.metadata->>'product_interest' AS product_interest,
       l.metadata->>'contact_preference' AS contact_preference,
       l.metadata->>'permission' AS permission,
       l.metadata->>'next_action' AS next_action,
       l.call_session_id,
       cs.metadata->>'bridge_call_id' AS bridge_call_id
FROM voice.leads l
LEFT JOIN voice.call_sessions cs ON cs.id = l.call_session_id
WHERE l.id = '741f6e28-ffb8-4e66-8a23-2bc10551bb40'::uuid;
```

**Expected:** row exists; `next_action=team_callback`; `permission=granted`; `contact_preference=phone`; phone present on lead or session; `call_session_id` matches Phase 12K.

### UI verification checklist (WireGuard + Basic Auth)

Access lead dashboard (internal host). Default local dev: `http://127.0.0.1:8090`.

| # | Check | Pass criterion |
|---|-------|----------------|
| 1 | List visibility | Lead appears on `/leads` (callback filter) |
| 2 | Product | `product_interest` renders (not blank / not `Unknown` if set in metadata) |
| 3 | Contact | `contact_preference` shows `phone` |
| 4 | Permission | `permission` shows `granted` |
| 5 | Next action | `next_action` shows `team_callback` |
| 6 | Status fields | `lead_status` + `followup_status` render (default follow-up `new`) |
| 7 | Phone masked | Detail page shows masked phone (e.g. `+491 **** 678`), **not** full number |
| 8 | Reveal phone | `POST /leads/{id}/reveal-phone` shows full number after button click |
| 9 | Audit on reveal | New row in `/audit` with `action=reveal_phone`, `new_value=revealed` |
| 10 | No phone in audit | Audit row does **not** contain full phone digits |
| 11 | List still masked | Return to `/leads` — phone remains masked in list view |

```sql
SELECT created_at, user_name, action, old_value, new_value, ip_address
FROM voice.lead_access_audit
WHERE lead_id = '741f6e28-ffb8-4e66-8a23-2bc10551bb40'::uuid
ORDER BY created_at DESC
LIMIT 5;
```

**Expected:** at least one `reveal_phone` row after operator reveal test; no digit runs in `old_value` / `new_value`.

### Code reference (no runtime change)

- Masking: `lead-dashboard/app/privacy.py` → `mask_phone()`
- Reveal + audit: `lead-dashboard/app/main.py` → `reveal_phone()`
- Audit insert: `lead-dashboard/app/repositories.py` → `insert_audit()`
- Automated coverage: `lead-dashboard/tests/test_routes.py` (reveal + audit tests)

Run locally:

```bash
cd lead-dashboard && python -m pytest tests/ -q
```

---

## 3. RAG posture (unchanged)

| Rule | Status |
|------|--------|
| `VOICE_RAG_ENABLED=false` | Required |
| `VOICE_RAG_SALES_ANSWERER_ENABLED=false` | Required |
| rag-api code/deploy | **Not touched** |
| RAG canary | **Not run** in Phase 12L |

---

## 4. Read-only production state audit

Run during a maintenance window with **zero active calls**. Do **not** edit env files as part of this audit — read and record only.

### voice-bridge env (authoritative file + container)

```bash
grep -E '^(VOICE_RUNTIME_VERSION|VOICE_RAG_ENABLED|VOICE_RAG_SALES_ANSWERER_ENABLED|VOICE_V4_REALTIME_ENABLED|VOICE_V4_CANARY_ENABLED|VOICE_V4_LIVE_AUDIOSOCKET_ENABLED|VOICE_V4_LIVE_CANARY_ALLOWLIST|VOICE_V4_PLAYBOOK_RUNTIME_ENABLED|VOICE_V4_BARGE_IN_ENABLED|VOICE_POST_CALL_NOTIFY_ENABLED)=' \
  /opt/technolohit-voice/voice-bridge/.env

docker exec technolohit-voice-bridge printenv | sort | egrep '^(VOICE_RUNTIME_VERSION|VOICE_RAG_|VOICE_V4_|VOICE_POST_CALL_NOTIFY_)='
```

| Check | Expected |
|-------|----------|
| `VOICE_RUNTIME_VERSION` | `v3` |
| `VOICE_RAG_ENABLED` | `false` |
| `VOICE_RAG_SALES_ANSWERER_ENABLED` | `false` |
| `VOICE_V4_REALTIME_ENABLED` | `false` |
| `VOICE_V4_CANARY_ENABLED` | `false` |
| `VOICE_V4_LIVE_AUDIOSOCKET_ENABLED` | `false` |
| `VOICE_V4_LIVE_CANARY_ALLOWLIST` | empty or unset |
| `VOICE_V4_PLAYBOOK_RUNTIME_ENABLED` | `false` |
| `VOICE_V4_BARGE_IN_ENABLED` | `false` (or off-equivalent) |
| `VOICE_POST_CALL_NOTIFY_ENABLED` | `true` (notifications should stay on) |

### Image pin

```bash
docker inspect technolohit-voice-bridge --format '{{.Config.Image}}'
```

**Expected:** `thnhit/technhvoice:voice-bridge-v1.36.4` (or digest-pinned equivalent).

### Asterisk active calls

```bash
docker exec technolohit-asterisk asterisk -rx "core show channels" | head -20
```

**Expected:** `0 active calls` (or no active channels) between canary windows.

### Stale session check (optional)

```sql
SELECT id, started_at, ended_at
FROM voice.call_sessions
WHERE ended_at IS NULL
  AND started_at < NOW() - INTERVAL '2 hours'
ORDER BY started_at DESC
LIMIT 5;
```

**Expected:** zero rows after rollback.

---

## Phase 12L classification

| Item | Result |
|------|--------|
| n8n `undefined` email | **Root cause identified**; repo fallback hardening + **sysadmin redeploy required** |
| Lead dashboard Phase 12K lead | **BLOCKED** — `normalized_phone` empty (Phase 12M fix → `v1.36.5`) |
| RAG | **Off** — no change |
| Production state audit | **Read-only checklist documented** |
| Voice runtime behavior | **No change** |
| rag-api / Docker deploy / production env | **Not touched** |

**Gate outcome:** Phase 12L passes when:

1. n8n workflow redeployed and email test shows readable body (no `undefined`).
2. Lead `741f6e28-ffb8-4e66-8a23-2bc10551bb40` passes dashboard checklist.
3. Production state audit matches expected v3/off table above.

Then proceed to **Phase 13 — Limited Operational Canary**.

## Related docs

- [phase12k_supervised_callback_phone_capture_canary_pass_report.md](phase12k_supervised_callback_phone_capture_canary_pass_report.md)
- [voice_lead_notification_implementation_report_v1.md](voice_lead_notification_implementation_report_v1.md)
- [sysadmin_voice_bridge_notification_dashboard_v1.md](sysadmin_voice_bridge_notification_dashboard_v1.md)
