# Voice Lead Dashboard Implementation Report v1

Date: 2026-05-29

## Summary

Implemented the repository side of the internal-only TechnoloHit Lead Dashboard.

The dashboard is a separate FastAPI + Jinja2 service under `lead-dashboard/`. It is designed for WireGuard-only access plus Basic Auth and reads callback leads from the existing `technolohit_growth` database, schema `voice`.

Production server deployment remains pending until the role/password is created and the compose service is run on the server.

Sysadmin confirmed:

- Docker network: `central-postgres_default`
- DNS/connectivity from that network to `central_postgres:5432`: passed
- final dashboard URL: `http://10.20.0.1:8090`
- final bind: `10.20.0.1:8090`

Still pending:

- create/verify role `technolohit_lead_dashboard_app`
- production column verification for `voice.leads`, `voice.call_sessions`, `voice.call_summaries`

## Files Changed

| Path | Purpose |
|------|---------|
| `lead-dashboard/` | New FastAPI + Jinja2 dashboard service |
| `lead-dashboard/app/main.py` | Routes, auth dependencies, reveal/status workflows |
| `lead-dashboard/app/repositories.py` | PostgreSQL queries and audit/status writes |
| `lead-dashboard/app/privacy.py` | Phone masking and phone-like text redaction |
| `lead-dashboard/app/templates/*.html` | Lead list, lead detail, audit pages, list filters and quick status |
| `lead-dashboard/app/static/app.css` | Internal dashboard styling |
| `lead-dashboard/tests/` | Privacy/auth/route tests |
| `lead-dashboard/Dockerfile` | Container image build |
| `lead-dashboard/.dockerignore` | Keep local/test artifacts out of image |
| `lead-dashboard/.env.example` | Environment template |
| `lead-dashboard/README.md` | Local/deploy notes |
| `docker-compose.lead-dashboard.yml` | Configurable compose service |
| `db/voice/migrations/005_lead_dashboard_tables.sql` | Audit/status support tables |
| `scripts/db/create-lead-dashboard-role.sql` | Optional role creation helper |
| `scripts/db/lead-dashboard-grants.sql` | Least-privilege grants helper |

## Database Migration

Created:

```text
db/voice/migrations/005_lead_dashboard_tables.sql
```

Tables:

- `voice.lead_access_audit`
- `voice.lead_followup_status`

This migration is idempotent and contains no passwords.

Apply with the normal voice migration flow after production review:

```bash
npm run db:migrate:voice
```

## Dedicated DB Role

Preferred runtime role:

```text
technolohit_lead_dashboard_app
```

Optional helper files:

```text
scripts/db/create-lead-dashboard-role.sql
scripts/db/lead-dashboard-grants.sql
```

Least-privilege target:

- `USAGE` on schema `voice`
- `SELECT` on `voice.leads`
- `SELECT` on `voice.call_sessions`
- `SELECT` on `voice.call_summaries`
- `SELECT, INSERT` on `voice.lead_access_audit`
- `SELECT, INSERT, UPDATE` on `voice.lead_followup_status`

Role creation must be done manually or by sysadmin tooling with a real password. Do not commit the password.

Server role creation example:

```bash
docker exec -i central_postgres psql -U "$POSTGRES_USER" -d technolohit_growth <<'SQL'
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = 'technolohit_lead_dashboard_app'
  ) THEN
    CREATE ROLE technolohit_lead_dashboard_app
      LOGIN
      PASSWORD 'REPLACE_WITH_STRONG_PASSWORD';
  END IF;
END $$;
SQL
```

Apply least-privilege grants from this repo file:

```bash
docker exec -i central_postgres psql -U "$POSTGRES_USER" -d technolohit_growth \
  -v lead_dashboard_db_user=technolohit_lead_dashboard_app \
  < scripts/db/lead-dashboard-grants.sql
```

## Environment Variables

```env
LEAD_DASHBOARD_BIND_HOST=10.20.0.1
LEAD_DASHBOARD_PORT=8090
LEAD_DASHBOARD_APP_BASE_URL=http://10.20.0.1:8090
LEAD_DASHBOARD_DATABASE_URL=postgresql://technolohit_lead_dashboard_app:<password>@central_postgres:5432/technolohit_growth
LEAD_DASHBOARD_USER=<user>
LEAD_DASHBOARD_PASSWORD_HASH=<bcrypt-hash>
LEAD_DASHBOARD_IMAGE=thnhit/thn-dashbrd:lead-dashboard-v0.1.0
LEAD_DASHBOARD_DOCKER_NETWORK=central-postgres_default
```

Fallback DB URL if Docker DNS is not available:

```env
LEAD_DASHBOARD_DATABASE_URL=postgresql://technolohit_lead_dashboard_app:<password>@10.20.0.1:5432/technolohit_growth
```

Generate a bcrypt hash:

```bash
python - <<'PY'
import bcrypt, getpass
password = getpass.getpass("Password: ").encode()
print(bcrypt.hashpw(password, bcrypt.gensalt(rounds=12)).decode())
PY
```

When storing bcrypt hashes in a Docker Compose `.env` file, escape `$` as `$$` if Compose interpolation strips the hash.

## Routes

| Route | Auth | Purpose |
|-------|------|---------|
| `GET /healthz` | no | Docker healthcheck |
| `GET /leads` | Basic Auth | Recent callback/phone leads, masked phone only |
| `GET /leads/{lead_id}` | Basic Auth | Lead detail, masked phone by default |
| `POST /leads/{lead_id}/reveal-phone` | Basic Auth | Show full phone after explicit action; audit logged |
| `POST /leads/{lead_id}/status` | Basic Auth | Update follow-up status; audit logged |
| `GET /audit` | Basic Auth | Recent reveal/status actions |

## Privacy Behavior

Implemented:

- `/leads` does not pass full phone to template context.
- `/leads/{lead_id}` shows masked phone by default.
- Full phone is only shown after `POST /reveal-phone`.
- `reveal_phone` audit rows use `new_value='revealed'`, not the phone number.
- Status updates audit old/new status only.
- Phone-like sequences in `caller_need` and `summary_text` are redacted before display.
- Full transcripts are not queried or displayed.
- `/leads` now supports status/phone/search filters without exposing full phone values.
- Missing phone leads are visibly highlighted.
- Quick status changes on the list page use the same audited status update path.

Phone source priority:

1. `voice.leads.normalized_phone`
2. `voice.call_sessions.caller_phone_normalized`
3. `voice.call_sessions.caller_phone_raw`
4. `No phone captured`

Phone masking examples:

```text
01764444444 -> 0176 **** 444
+4917612345678 -> +491 **** 678
```

## Docker

Build:

```bash
docker build -t thnhit/thn-dashbrd:lead-dashboard-v0.1.0 ./lead-dashboard
```

Timestamp tag:

```bash
TAG=lead-dashboard-$(date -u +%Y%m%d-%H%M)
docker tag thnhit/thn-dashbrd:lead-dashboard-v0.1.0 thnhit/thn-dashbrd:$TAG
```

Push:

```bash
docker push thnhit/thn-dashbrd:lead-dashboard-v0.1.0
docker push thnhit/thn-dashbrd:$TAG
```

Optional latest:

```bash
docker tag thnhit/thn-dashbrd:lead-dashboard-v0.1.0 thnhit/thn-dashbrd:lead-dashboard-latest
docker push thnhit/thn-dashbrd:lead-dashboard-latest
```

Production should pin an immutable tag, not only `latest`.

Docker build and push completed.

```text
thnhit/thn-dashbrd:lead-dashboard-v0.1.0
thnhit/thn-dashbrd:lead-dashboard-20260529-2102
thnhit/thn-dashbrd:lead-dashboard-latest
```

Pushed digest:

```text
sha256:4587f52f6eb4b9cd5be7c2922ee8ef503e764de697e08a8bd3595b7be21611c7
```

### Pending v0.1.1 Build

After the list UX improvement, code changes are ready for a new image tag:

```text
thnhit/thn-dashbrd:lead-dashboard-v0.1.1
```

The local Docker daemon was unavailable when attempting the rebuild:

```text
open //./pipe/dockerDesktopLinuxEngine: Das System kann die angegebene Datei nicht finden
```

Build/push when Docker is available:

```bash
docker build -t thnhit/thn-dashbrd:lead-dashboard-v0.1.1 ./lead-dashboard
TAG=lead-dashboard-$(date -u +%Y%m%d-%H%M)
docker tag thnhit/thn-dashbrd:lead-dashboard-v0.1.1 thnhit/thn-dashbrd:$TAG
docker tag thnhit/thn-dashbrd:lead-dashboard-v0.1.1 thnhit/thn-dashbrd:lead-dashboard-latest
docker push thnhit/thn-dashbrd:lead-dashboard-v0.1.1
docker push thnhit/thn-dashbrd:$TAG
docker push thnhit/thn-dashbrd:lead-dashboard-latest
```

## Compose

Compose file:

```text
docker-compose.lead-dashboard.yml
```

Deploy after filling env values:

```bash
docker compose --env-file lead-dashboard/.env -f docker-compose.lead-dashboard.yml pull
docker compose --env-file lead-dashboard/.env -f docker-compose.lead-dashboard.yml up -d
```

Expected port binding:

```text
10.20.0.1:8090:8090
```

## Server Runtime Verification

Check WireGuard:

```bash
ip -4 addr show dev wg0
ip route show dev wg0
```

Check Docker network:

```bash
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Networks}}' | grep -E 'central_postgres|NAME'
docker inspect central_postgres --format '{{json .NetworkSettings.Networks}}'
docker network ls
```

Test DNS from selected network:

```bash
docker run --rm --network central-postgres_default alpine:3.20 \
  sh -lc 'getent hosts central_postgres && nc -vz central_postgres 5432'
```

Verified production output:

```text
172.19.0.2        central_postgres  central_postgres
central_postgres (172.19.0.2:5432) open
```

Check role:

```bash
docker exec central_postgres psql -U "$POSTGRES_USER" -d technolohit_growth -tAc \
  "SELECT 1 FROM pg_roles WHERE rolname = 'technolohit_lead_dashboard_app';"
```

Verify binding:

```bash
docker ps --filter name=technolohit-lead-dashboard --format 'table {{.Names}}\t{{.Ports}}'
ss -ltnp | grep ':8090'
curl -fsS http://10.20.0.1:8090/healthz
```

Verify public access is blocked from outside WireGuard:

```bash
curl -m 5 -v http://85.214.6.159:8090/healthz
```

Expected: connection refused, timeout, or blocked.

Verify WireGuard access:

```bash
curl -i http://10.20.0.1:8090/healthz
curl -i http://10.20.0.1:8090/leads
```

Expected:

- `/healthz` returns `200`
- `/leads` returns `401` without Basic Auth

## Firewall Recommendation

If UFW is used:

```bash
sudo ufw allow in on wg0 from 10.20.0.0/24 to 10.20.0.1 port 8090 proto tcp
sudo ufw deny in on ens6 to any port 8090 proto tcp
sudo ufw status numbered
```

If UFW is not used, equivalent nftables/iptables rules are required.

## n8n Email Link Recommendation

After dashboard is deployed, update email/Telegram templates to include:

```text
SECURE LOOKUP
Open via WireGuard VPN:
http://10.20.0.1:8090/leads/{{lead_id}}

Phone is intentionally not included in this email for DSGVO/data-minimisation reasons.
```

Do not include full phone in n8n payload, Telegram, or email.

## Verification Completed Locally

Tests:

```bash
cd lead-dashboard
python -m pytest
```

Result:

```text
12 passed
```

Compile check:

```bash
python -m compileall lead-dashboard/app
```

Result: pass.

Healthcheck run:

```bash
LEAD_DASHBOARD_USER=admin LEAD_DASHBOARD_PASSWORD=dev-password \
uvicorn app.main:app --host 127.0.0.1 --port 8090
curl http://127.0.0.1:8090/healthz
```

Result:

```json
{"ok":true,"service":"technolohit-lead-dashboard","environment":"production","db_configured":false}
```

Docker image healthcheck run:

```bash
docker run -d --rm -p 127.0.0.1:8091:8090 \
  -e LEAD_DASHBOARD_USER=admin \
  -e LEAD_DASHBOARD_PASSWORD=dev-password \
  thnhit/thn-dashbrd:lead-dashboard-v0.1.0
curl http://127.0.0.1:8091/healthz
```

Result:

```json
{"ok":true,"service":"technolohit-lead-dashboard","environment":"production","db_configured":false}
```

Compose render check:

```bash
docker compose -f docker-compose.lead-dashboard.yml config
```

Result: pass. Rendered service attaches to external network `central-postgres_default` and binds `10.20.0.1:8090`.

## Pending Production Acceptance

- Apply DB migration.
- Create/verify `technolohit_lead_dashboard_app`.
- Apply least-privilege grants.
- Confirmed `central_postgres` Docker network/DNS: `central-postgres_default`.
- Build and push image completed.
- Deploy compose on the server.
- Verify WireGuard-only reachability and public blocking.
- Add secure lookup link to n8n/email after dashboard is reachable.

## Rollback

Application rollback:

```bash
docker compose --env-file lead-dashboard/.env -f docker-compose.lead-dashboard.yml down
```

DB rollback is usually not required. If explicitly needed before production data depends on the tables:

```sql
DROP TABLE IF EXISTS voice.lead_followup_status;
DROP TABLE IF EXISTS voice.lead_access_audit;
```

Do not drop audit data after production use without a retention/legal decision.
