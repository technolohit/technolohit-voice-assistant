# n8n Workflows (Voice Assistant)

This folder stores n8n workflow exports used by the voice assistant repo. Secrets and credential IDs are not committed.

## Tech-Voice-notif

- File: `Tech-Voice-notif.workflow.json`
- Purpose: async post-call Telegram + email notifications for voice leads
- Production webhook path: `voice/post-call`
- Message rendering: `Classify Notification` prepares `telegram_text`, `email_subject`, and `email_text`; send nodes reference these fields with n8n expressions.

### Redeploy

From repo root (requires n8n API config in `~/.cursor/mcp.json` under `n8n-mcp`):

```bash
node scripts/n8n-voice-notif-deploy.cjs deploy
```

### Import manually

1. n8n → Workflows → Import from file → select `Tech-Voice-notif.workflow.json`
2. Attach credentials: `TechnoloHit Telegram Bot`, `Ionos-Email-Tech`
3. Confirm webhook path remains `voice/post-call`
4. Activate workflow

### Test

```bash
node scripts/test-voice-lead-notification.cjs callback
node scripts/test-voice-lead-notification.cjs review
```
