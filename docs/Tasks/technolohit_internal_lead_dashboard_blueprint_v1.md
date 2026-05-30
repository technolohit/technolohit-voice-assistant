# TechnoloHit Internal Lead Dashboard Blueprint v1

Date: 2026-05-29

## Purpose

Design an internal-only Lead Dashboard for TechnoloHit Voice Assistant callback leads.

This is a design blueprint, not an implementation report. Do not build application code until this design is reviewed and accepted.

The dashboard should let authorized team members view callback leads and reveal the caller phone number only when needed for the requested callback.

## Decision Summary

Recommended architecture:

```text
Create a separate FastAPI + Jinja2 service:

lead-dashboard/
container: technolohit-lead-dashboard
image: thnhit/thn-dashbrd:<tag>
```

Do not extend `rag-api`.

Reason:

- `rag-api` is a focused FastAPI service for pgvector knowledge retrieval.
- The dashboard is an internal admin/privacy workflow.
- Keeping the dashboard separate avoids mixing RAG/runtime APIs with DSGVO-sensitive lead lookup UI.
- It can be deployed, restricted, audited, and rolled back independently.
- It can be bound to WireGuard/internal access only.

- [x] Successful: Design decision reviewed and accepted.
- [x] Successful: Separate `lead-dashboard` service approved.

## Existing Repository Findings

Existing FastAPI service:

```text
rag-api/
```

Purpose:

- `GET /healthz`
- `GET /readyz`
- `POST /v1/retrieve`
- `POST /v1/ingest/document`
- `POST /v1/ingest/reindex`

Conclusion:

`rag-api` should not be reused for the Lead Dashboard. It is retrieval infrastructure, not an internal admin UI.

Existing voice database:

```text
database: technolohit_growth
schema: voice
```

Relevant tables:

- `voice.leads`
- `voice.call_sessions`
- `voice.call_summaries`
- `voice.call_events`
- `voice.call_transcripts`

- [x] Successful: Existing FastAPI service inspected.
- [x] Successful: Existing voice DB schema inspected.

## Data Source

Primary query source:

```text
voice.leads l
LEFT JOIN voice.call_sessions cs ON cs.id = l.call_session_id
LEFT JOIN voice.call_summaries s ON s.call_session_id = cs.id AND s.summary_type = 'auto'
LEFT JOIN voice.lead_followup_status fs ON fs.lead_id = l.id
```

Phone source priority:

1. `voice.leads.normalized_phone`
2. `voice.call_sessions.caller_phone_normalized`
3. `voice.call_sessions.caller_phone_raw`
4. `No phone captured`

Summary/metadata fields:

- `voice.call_summaries.summary_text`
- `voice.call_summaries.metadata->>'product_interest'`
- `voice.call_summaries.metadata->>'caller_need'`
- `voice.call_summaries.metadata->>'contact_preference'`
- `voice.call_summaries.metadata->>'permission'`
- `voice.call_summaries.metadata->>'next_action'`
- fallback to `voice.leads.metadata` where needed

Suggested list filter:

```sql
WHERE
  COALESCE(s.metadata->>'next_action', l.metadata->>'next_action') = 'team_callback'
  OR COALESCE(l.metadata->>'contact_preference', s.metadata->>'contact_preference') = 'phone'
```

Final query should be tested against real production rows before implementation is considered complete.

- [ ] Successful: Final list query tested against production-like data.
- [ ] Successful: Phone fallback order verified.

## New Database Tables

Recommendation: keep dashboard-support tables in schema `voice`, because the data is operationally tied to voice leads and can share existing voice migration/grant tooling.

Recommended table names:

- `voice.lead_access_audit`
- `voice.lead_followup_status`

### `voice.lead_access_audit`

```sql
CREATE TABLE IF NOT EXISTS voice.lead_access_audit (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID NOT NULL REFERENCES voice.leads (id) ON DELETE CASCADE,
  user_name TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('view_lead', 'reveal_phone', 'update_status')),
  old_value TEXT,
  new_value TEXT,
  ip_address TEXT,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_lead_access_audit_created
  ON voice.lead_access_audit (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_lead_access_audit_lead_created
  ON voice.lead_access_audit (lead_id, created_at DESC);
```

### `voice.lead_followup_status`

```sql
CREATE TABLE IF NOT EXISTS voice.lead_followup_status (
  lead_id UUID PRIMARY KEY REFERENCES voice.leads (id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'new' CHECK (
    status IN ('new', 'contacted', 'not_reachable', 'done')
  ),
  notes TEXT NOT NULL DEFAULT '',
  updated_by TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

Recommended migration filename:

```text
db/voice/migrations/005_lead_dashboard_tables.sql
```

Grants:

- Existing voice role grants currently cover all schema `voice` tables.
- If a separate dashboard DB role is added later, grant least-privilege `SELECT` on lead/session/summary tables and `INSERT/UPDATE` only on dashboard support tables.

- [x] Successful: Migration design accepted.
- [x] Successful: Dashboard DB role decision made.

## Privacy Design

Rules:

- Email/Telegram/n8n must not include full phone numbers.
- Lead list must not show full phone numbers.
- Lead detail page shows masked phone by default.
- Full phone is only available through explicit `Reveal phone`.
- Every reveal writes an audit event.
- Full transcripts are not shown by default.
- Summaries are allowed, but should remain bounded and business-focused.

This is a technical privacy-by-design plan, not legal advice.

Relevant GDPR design principles:

- Data minimisation: process only personal data needed for the purpose.
- Data protection by design/default.
- Security of personal data through appropriate technical and organisational safeguards.

Official references:

- European Commission, data minimisation: https://commission.europa.eu/law/law-topic/data-protection/rules-business-and-organisations/principles-gdpr/how-much-data-can-be-collected_en
- European Commission, processing conditions and safeguards: https://commission.europa.eu/law/law-topic/data-protection/rules-business-and-organisations/principles-gdpr/overview-principles/what-data-can-we-process-and-under-which-conditions_en
- European Commission, data protection by design/default: https://commission.europa.eu/law/law-topic/data-protection/rules-business-and-organisations/obligations/what-does-data-protection-design-and-default-mean_en
- EDPB, secure personal data: https://www.edpb.europa.eu/sme-data-protection-guide/secure-personal-data_en

- [x] Successful: Privacy design accepted.
- [ ] Successful: Legal/privacy text reviewed by responsible person.

## Authentication

Recommended MVP:

```text
Basic Auth + WireGuard-only access
```

Environment variables:

```env
LEAD_DASHBOARD_USER=
LEAD_DASHBOARD_PASSWORD_HASH=
```

Recommendation:

- Prefer password hash over plaintext password.
- Use a slow hash such as bcrypt or argon2.
- Keep credentials out of git.
- Set secure response headers.
- Disable caching on pages that can reveal phone numbers.

Session login can come later if multiple users, roles, or SSO become important.

- [x] Successful: Basic Auth + WireGuard accepted for MVP.
- [x] Successful: Password hash format selected.

## Network And Access

Confirmed server network information:

```text
Public interface: ens6
Public IPv4: 85.214.6.159/32
WireGuard interface: wg0
WireGuard server IP: 10.20.0.11/24
WireGuard subnet: 10.20.0.0/24
```

Final sysadmin decision for production dashboard access:

```text
Use 10.20.0.1:8090 for the dashboard bind and user-facing WireGuard URL.
```

Although `ip addr show` showed `10.20.0.11/24` on this server, sysadmin confirmed the final production dashboard bind should use `10.20.0.1`.

Recommended production binding for this server:

```env
LEAD_DASHBOARD_BIND_HOST=10.20.0.1
LEAD_DASHBOARD_PORT=8090
LEAD_DASHBOARD_APP_BASE_URL=http://10.20.0.1:8090
```

Recommended Docker Compose port mapping:

```yaml
ports:
  - "10.20.0.1:8090:8090"
```

Defense-in-depth:

- Bind dashboard only to WireGuard host IP when possible.
- Add firewall/UFW rule allowing port `8090` only from WireGuard subnet.
- Do not expose dashboard through public reverse proxy.
- Use Basic Auth even though access is WireGuard-only.

If Docker cannot reliably bind to the WireGuard IP:

1. Bind to `127.0.0.1:8090:8090` and expose via internal-only Nginx bound to WireGuard IP.
2. Or bind to `0.0.0.0:8090` but restrict with firewall/UFW to `10.20.0.0/24`.
3. Or attach the dashboard to a private Docker network and use a host firewall/reverse proxy.

- [x] Successful: Server WireGuard host IP confirmed.
- [x] Successful: Binding strategy selected.
- [x] Successful: Firewall strategy selected.

## Phase 0 Runtime Preflight Commands

Run these on the production server before final compose/deploy.

### Confirm WireGuard IP and subnet

```bash
ip -4 addr show dev wg0
ip route show dev wg0
```

Expected:

```text
10.20.0.11/24
10.20.0.0/24
```

### Find the Docker network for `central_postgres`

```bash
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Networks}}' | grep -E 'central_postgres|NAME'
docker inspect central_postgres --format '{{json .NetworkSettings.Networks}}'
docker network ls
```

If `jq` is available:

```bash
docker inspect central_postgres | jq -r '.[0].NetworkSettings.Networks | keys[]'
```

Record the exact network name:

```text
LEAD_DASHBOARD_DOCKER_NETWORK=<central_postgres_network>
```

### Test `central_postgres` DNS resolution from that network

Replace `<central_postgres_network>` with the real network name:

```bash
docker run --rm --network <central_postgres_network> alpine:3.20 \
  sh -lc 'getent hosts central_postgres && nc -vz central_postgres 5432'
```

This test passed on production with network `central-postgres_default`:

```text
172.19.0.2        central_postgres  central_postgres
central_postgres (172.19.0.2:5432) open
```

Final Docker network:

```text
central-postgres_default
```

If this passes, prefer:

```text
postgresql://technolohit_lead_dashboard_app:<password>@central_postgres:5432/technolohit_growth
```

If it fails, use the WireGuard/host route as fallback:

```text
postgresql://technolohit_lead_dashboard_app:<password>@10.20.0.1:5432/technolohit_growth
```

### Inspect required DB columns

```bash
docker exec central_postgres psql -U "$POSTGRES_USER" -d technolohit_growth -P pager=off -c "
SELECT table_schema, table_name, column_name, data_type
FROM information_schema.columns
WHERE table_schema = 'voice'
  AND table_name IN ('leads', 'call_sessions', 'call_summaries')
ORDER BY table_name, ordinal_position;"
```

### Check whether the dedicated role exists

```bash
docker exec central_postgres psql -U "$POSTGRES_USER" -d technolohit_growth -tAc "
SELECT 1 FROM pg_roles WHERE rolname = 'technolohit_lead_dashboard_app';"
```

Expected:

- `1` means role exists.
- empty output means role must be created before production deploy.

### Verify dashboard binding after deployment

```bash
docker ps --filter name=technolohit-lead-dashboard --format 'table {{.Names}}\t{{.Ports}}'
ss -ltnp | grep ':8090'
curl -fsS http://10.20.0.1:8090/healthz
```

Expected binding:

```text
10.20.0.1:8090
```

### Verify public access is blocked

From outside WireGuard:

```bash
curl -m 5 -v http://85.214.6.159:8090/healthz
```

Expected: connection refused, timeout, or blocked. It must not return dashboard content.

### Verify WireGuard access works

From a WireGuard-connected client:

```bash
curl -i http://10.20.0.1:8090/healthz
curl -i http://10.20.0.1:8090/leads
```

Expected:

- `/healthz` returns `200`.
- `/leads` returns `401` without Basic Auth.

## Database Connectivity

The earlier docs used a generic WireGuard host example:

```text
10.20.0.1:5432
database: technolohit_growth
```

Final production dashboard bind/URL is `10.20.0.1`.

Preferred first deployment if the dashboard joins the same Docker network as `central_postgres`:

```env
DATABASE_URL=postgresql://technolohit_lead_dashboard_app:<password>@central_postgres:5432/technolohit_growth
```

Fallback if `central_postgres` is not resolvable from the dashboard container:

```env
DATABASE_URL=postgresql://technolohit_lead_dashboard_app:<password>@10.20.0.1:5432/technolohit_growth
```

Before implementation/deploy, verify:

```bash
docker network inspect <network>
docker exec technolohit-lead-dashboard getent hosts central_postgres
```

If `central_postgres` is not resolvable from the dashboard container, use `10.20.0.1` or attach the correct external Docker network.

- [ ] Successful: DB connection method confirmed.
- [ ] Successful: Dashboard DB user selected or created.

## MVP Routes

### `GET /healthz`

Returns JSON:

```json
{ "ok": true, "service": "technolohit-lead-dashboard" }
```

- [ ] Successful: `/healthz` works without DB failure.

### `GET /leads`

Authenticated.

Shows recent callback leads:

- created_at
- product_interest
- preferred_contact
- permission
- next_action
- lead status
- follow-up status
- masked phone
- detail link

No full phone in HTML.

- [ ] Successful: `/leads` shows recent callback leads.
- [ ] Successful: `/leads` contains no full phone numbers.

### `GET /leads/{lead_id}`

Authenticated.

Shows:

- Lead ID
- Call Session ID
- External Call ID
- Product interest
- Caller need / summary
- Preferred contact
- Permission
- Next action
- Lead status
- Follow-up status
- masked phone
- Reveal phone action
- Status update actions

- [ ] Successful: Lead detail page renders.
- [ ] Successful: Detail page defaults to masked phone.

### `POST /leads/{lead_id}/reveal-phone`

Authenticated.

Behavior:

- returns/displays full phone
- inserts audit log:
  - user
  - lead_id
  - action = `reveal_phone`
  - request IP
  - user agent
  - timestamp

- [ ] Successful: Reveal shows full phone only after explicit action.
- [ ] Successful: Reveal writes audit log.

### `POST /leads/{lead_id}/status`

Authenticated.

Allowed statuses:

- `new`
- `contacted`
- `not_reachable`
- `done`

Behavior:

- updates `voice.lead_followup_status`
- inserts audit log with old/new status

- [ ] Successful: Status update works.
- [ ] Successful: Status update writes audit log.

### `GET /audit`

Authenticated.

Shows recent:

- `view_lead`
- `reveal_phone`
- `update_status`

- [ ] Successful: Audit page renders recent actions.

## Phone Masking

Recommended helper:

```text
maskPhone(phone)
```

Rules:

- Normalize display whitespace.
- Keep first 4 digits and last 3 digits where possible.
- Mask the middle.
- If missing, show `No phone captured`.

Example:

```text
01764444444 -> 0176 **** 444
+4917612345678 -> +491 **** 678
```

- [ ] Successful: Phone masking helper tested.

## Proposed File Layout

```text
lead-dashboard/
  app/
    __init__.py
    main.py
    config.py
    db.py
    auth.py
    models.py
    repositories.py
    privacy.py
    templates/
      base.html
      leads.html
      lead_detail.html
      audit.html
    static/
      app.css
  tests/
    test_privacy.py
    test_routes_static.py
  Dockerfile
  requirements.txt
  README.md
  .env.example

db/voice/migrations/005_lead_dashboard_tables.sql
docs/Tasks/voice_lead_dashboard_implementation_report_v1.md
docker-compose.lead-dashboard.yml
```

- [x] Successful: File layout accepted.

## Docker Image And Tags

Docker Hub repository:

```text
thnhit/thn-dashbrd
```

Recommended tag convention:

```text
thnhit/thn-dashbrd:lead-dashboard-v0.1.0
thnhit/thn-dashbrd:lead-dashboard-YYYYMMDD-HHMM
thnhit/thn-dashbrd:lead-dashboard-latest
```

Use immutable version/timestamp tags for production deploys. Avoid relying only on `latest`.

- [x] Successful: Image tag convention accepted.

## Compose Draft

Confirm WireGuard host IP and Docker network before using this exactly.

```yaml
services:
  lead-dashboard:
    image: thnhit/thn-dashbrd:lead-dashboard-v0.1.0
    container_name: technolohit-lead-dashboard
    restart: unless-stopped
    environment:
      DATABASE_URL: ${LEAD_DASHBOARD_DATABASE_URL}
      LEAD_DASHBOARD_USER: ${LEAD_DASHBOARD_USER}
      LEAD_DASHBOARD_PASSWORD_HASH: ${LEAD_DASHBOARD_PASSWORD_HASH}
      APP_BASE_URL: ${LEAD_DASHBOARD_APP_BASE_URL}
      TRUSTED_PROXY_SUBNETS: ${LEAD_DASHBOARD_TRUSTED_PROXY_SUBNETS:-}
    ports:
      - "${LEAD_DASHBOARD_BIND_HOST:-10.20.0.1}:8090:8090"
    networks:
      - central-postgres_default
    healthcheck:
      test: ["CMD", "python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8090/healthz').read()"]
      interval: 30s
      timeout: 5s
      retries: 3

networks:
  central-postgres_default:
    name: ${LEAD_DASHBOARD_DOCKER_NETWORK:-central-postgres_default}
    external: true
```

- [x] Successful: Compose draft adapted to production server.

## n8n / Email Integration

Notifications should continue excluding full phone numbers.

Suggested notification addition after dashboard exists:

```text
SECURE LOOKUP
Open via WireGuard VPN:
http://10.20.0.1:8090/leads/{{lead_id}}

Phone is intentionally not included in this email for DSGVO/data-minimisation reasons.
```

Do not add phone to n8n payload or email.

- [ ] Successful: Secure lookup link added to notification.
- [ ] Successful: Full phone remains excluded from Telegram/email.

## Retention

Do not implement automatic deletion in MVP.

Recommended future retention policy:

- keep active callback phone while status is `new`, `contacted`, or `not_reachable`
- after status `done`, mask/delete phone after agreed period, for example 30/60/90 days
- retain audit events for an agreed accountability period

- [ ] Successful: Retention policy reviewed later.

## Acceptance Criteria Answers

### 1. Separate FastAPI container or reuse existing FastAPI?

Recommendation: separate FastAPI container.

Reason: existing `rag-api` is retrieval/knowledge infrastructure. Lead Dashboard is internal admin UI with personal-data access and audit controls.

### 2. Existing DB tables/columns for phone?

Use:

- `voice.leads.normalized_phone`
- fallback `voice.call_sessions.caller_phone_normalized`
- fallback `voice.call_sessions.caller_phone_raw`

### 3. Internal port/IP binding?

Recommended:

```text
10.20.0.1:8090:8090
```

Final sysadmin-confirmed production bind is `10.20.0.1`.

Also use firewall/UFW to allow `8090` only from `10.20.0.0/24`.

### 4. Auth method?

MVP:

```text
Basic Auth + WireGuard-only access
```

Prefer `LEAD_DASHBOARD_PASSWORD_HASH` instead of plaintext.

### 5. Schema/table names?

Recommended:

- `voice.lead_access_audit`
- `voice.lead_followup_status`

### 6. Files to create/change?

Create:

- `lead-dashboard/`
- `db/voice/migrations/005_lead_dashboard_tables.sql`
- `docker-compose.lead-dashboard.yml`
- `docs/Tasks/voice_lead_dashboard_implementation_report_v1.md`

Update:

- `README.md` or `docs/voice-database.md` with dashboard references
- `docs/Tasks/technolohit_voice_lead_notification_blueprint_v1.md` after n8n lookup link is added
- `workflows/n8n/Tech-Voice-notif.workflow.json` only after dashboard URL exists

### 7. Docker image/tag naming?

Use:

```text
thnhit/thn-dashbrd:lead-dashboard-v0.1.0
thnhit/thn-dashbrd:lead-dashboard-YYYYMMDD-HHMM
```

Optionally push:

```text
thnhit/thn-dashbrd:lead-dashboard-latest
```

but production should pin immutable tags.

### 8. Risks / missing information?

Missing before implementation:

- Final production dashboard bind: `10.20.0.1`.
- Confirmed dashboard container can join the `central_postgres` Docker network: `central-postgres_default`.
- Confirm dashboard DB user: reuse `VOICE_DB_USER` or create dedicated `technolohit_lead_dashboard_app`.
- Confirm password hash algorithm.
- Confirm who can access the dashboard.
- Confirm whether a public domain/reverse proxy must never route to this service.
- Confirm retention period.

Risks:

- Accidentally exposing port `8090` publicly.
- Email/Telegram link using an IP unreachable from mobile without WireGuard.
- Full phone appearing in HTML list pages or logs.
- Audit table growing forever without retention policy.
- Reusing `voice.leads.status` for operational follow-up could conflict with lead qualification state; use separate `lead_followup_status`.

- [ ] Successful: Missing information resolved.
- [x] Successful: Implementation approved.

## Implementation Phases

### Phase 0: Confirm Inputs

- [x] Successful: WireGuard host IP confirmed.
- [x] Successful: WireGuard subnet confirmed.
- [x] Successful: DB connection path confirmed.
- [x] Successful: Dashboard DB role selected.
- [x] Successful: Auth credential format selected.

### Phase 1: DB Migration

- [x] Successful: Create `005_lead_dashboard_tables.sql`.
- [ ] Successful: Apply migration.
- [ ] Successful: Verify audit/status tables.
- [ ] Successful: Verify grants.

### Phase 2: App Skeleton

- [x] Successful: Create `lead-dashboard` FastAPI app.
- [x] Successful: Add config/env handling.
- [x] Successful: Add DB pool.
- [x] Successful: Add Basic Auth.
- [x] Successful: Add `/healthz`.

### Phase 3: Lead Pages

- [x] Successful: Build `/leads`.
- [x] Successful: Build `/leads/{lead_id}`.
- [x] Successful: Add masked phone helper.
- [x] Successful: Verify no full phone in list HTML.
- [x] Successful: Add follow-up status filter.
- [x] Successful: Add phone captured/missing filter.
- [x] Successful: Add Lead ID / Call Session ID search.
- [x] Successful: Add audited quick status action from list.
- [x] Successful: Highlight `No phone captured` rows.

### Phase 4: Reveal And Status

- [x] Successful: Build `POST /leads/{lead_id}/reveal-phone`.
- [x] Successful: Audit every reveal.
- [x] Successful: Build status update endpoint.
- [x] Successful: Audit every status update.
- [x] Successful: Build `/audit`.

### Phase 5: Docker

- [x] Successful: Add Dockerfile.
- [x] Successful: Add compose file.
- [x] Successful: Build image.
- [x] Successful: Push to `thnhit/thn-dashbrd`.
- [ ] Successful: Run container on server.

### Phase 6: Security Verification

- [ ] Successful: Dashboard reachable over WireGuard.
- [ ] Successful: Dashboard unreachable without WireGuard.
- [ ] Successful: Basic Auth required.
- [ ] Successful: Full phone only appears after reveal.
- [ ] Successful: Reveal audit row is written.

### Phase 7: n8n Link

- [ ] Successful: Add secure lookup link to email/Telegram.
- [ ] Successful: Confirm notification still excludes full phone.
- [ ] Successful: Test real callback lead end-to-end.

### Phase 8: Documentation

- [x] Successful: Add implementation report.
- [x] Successful: Update dashboard README.
- [x] Successful: Update voice DB docs.
- [x] Successful: Document rollback.
