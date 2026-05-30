# TechnoloHit Lead Dashboard

Internal-only FastAPI + Jinja2 dashboard for TechnoloHit Voice Assistant callback leads.

The dashboard is designed for WireGuard-only access plus Basic Auth. It reads from the existing `technolohit_growth` database, schema `voice`.

## Privacy Model

- Email, Telegram, and n8n notifications must not include full phone numbers.
- `/leads` never receives full phone numbers in template context.
- `/leads/{lead_id}` shows masked phone by default.
- Full phone is shown only after `POST /leads/{lead_id}/reveal-phone`.
- Every reveal writes `voice.lead_access_audit`.
- Status changes write `voice.lead_access_audit` and `voice.lead_followup_status`.
- Audit rows do not store full phone numbers.

## Environment

```env
LEAD_DASHBOARD_DATABASE_URL=postgresql://technolohit_lead_dashboard_app:<password>@central_postgres:5432/technolohit_growth
LEAD_DASHBOARD_USER=admin
LEAD_DASHBOARD_PASSWORD_HASH=<bcrypt-hash>
LEAD_DASHBOARD_APP_BASE_URL=http://10.20.0.1:8090
```

Generate a bcrypt hash:

```bash
python - <<'PY'
import bcrypt, getpass
password = getpass.getpass("Password: ").encode()
print(bcrypt.hashpw(password, bcrypt.gensalt(rounds=12)).decode())
PY
```

## Local Run

```bash
cd lead-dashboard
python -m venv .venv
. .venv/Scripts/activate
pip install -r requirements.txt
LEAD_DASHBOARD_PASSWORD=dev-password uvicorn app.main:app --reload --host 127.0.0.1 --port 8090
```

`/healthz` does not require auth. All lead/audit pages require Basic Auth.

## Docker

Build:

```bash
docker build -t thnhit/thn-dashbrd:lead-dashboard-v0.1.0 ./lead-dashboard
```

Timestamp tag:

```bash
$tag = "lead-dashboard-" + (Get-Date -AsUTC -Format "yyyyMMdd-HHmm")
docker tag thnhit/thn-dashbrd:lead-dashboard-v0.1.0 "thnhit/thn-dashbrd:$tag"
```

Run with compose from repo root:

```bash
docker compose --env-file lead-dashboard/.env -f docker-compose.lead-dashboard.yml up -d
```

Production DB network is `central-postgres_default`; set `LEAD_DASHBOARD_DOCKER_NETWORK=central-postgres_default`.

Published image tags:

```text
thnhit/thn-dashbrd:lead-dashboard-v0.1.0
thnhit/thn-dashbrd:lead-dashboard-20260529-2102
thnhit/thn-dashbrd:lead-dashboard-latest
```

List UX in the current source includes:

- filter by follow-up status
- filter by captured/missing phone
- search by Lead ID, Call Session ID, or external call ID
- quick status update from the list
- highlighted rows for missing phone
