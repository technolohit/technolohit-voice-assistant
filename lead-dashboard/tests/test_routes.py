from datetime import datetime, timezone

from fastapi.testclient import TestClient

from app.main import app
from app import repositories as repo


FULL_PHONE = "+4917612345678"
AUTH = ("admin", "dev-password")


def sample_lead():
    return {
        "lead_id": "11111111-1111-1111-1111-111111111111",
        "call_session_id": "22222222-2222-2222-2222-222222222222",
        "external_call_id": "bridge:test",
        "bridge_call_id": "bridge-test",
        "summary_id": "33333333-3333-3333-3333-333333333333",
        "lead_status": "qualified",
        "followup_status": "new",
        "followup_notes": "",
        "product_interest": "Smart Website",
        "caller_need": "Needs a callback",
        "contact_preference": "phone",
        "permission": "granted",
        "next_action": "team_callback",
        "confidence": "high",
        "summary_text": "Product interest: Smart Website",
        "phone": FULL_PHONE,
        "created_at": datetime(2026, 5, 29, 12, 0, tzinfo=timezone.utc),
        "updated_at": datetime(2026, 5, 29, 12, 5, tzinfo=timezone.utc),
    }


def client(monkeypatch):
    monkeypatch.setenv("LEAD_DASHBOARD_USER", "admin")
    monkeypatch.setenv("LEAD_DASHBOARD_PASSWORD", "dev-password")
    monkeypatch.delenv("LEAD_DASHBOARD_PASSWORD_HASH", raising=False)
    monkeypatch.delenv("LEAD_DASHBOARD_DATABASE_URL", raising=False)
    return TestClient(app)


def test_leads_requires_auth(monkeypatch):
    with client(monkeypatch) as c:
        response = c.get("/leads")
    assert response.status_code == 401


def test_leads_does_not_expose_full_phone(monkeypatch):
    async def fake_list_callback_leads(pool, **kwargs):
        return [sample_lead()]

    monkeypatch.setattr(repo, "list_callback_leads", fake_list_callback_leads)
    with client(monkeypatch) as c:
        c.app.state.pool = object()
        response = c.get("/leads", auth=AUTH)

    assert response.status_code == 200
    assert FULL_PHONE not in response.text
    assert "+491 **** 678" in response.text
    assert "Quick status" in response.text


def test_leads_passes_filters_to_repository(monkeypatch):
    calls = []

    async def fake_list_callback_leads(pool, **kwargs):
        calls.append(kwargs)
        return [sample_lead()]

    monkeypatch.setattr(repo, "list_callback_leads", fake_list_callback_leads)
    with client(monkeypatch) as c:
        c.app.state.pool = object()
        response = c.get(
            "/leads?status=contacted&phone=captured&q=11111111",
            auth=AUTH,
        )

    assert response.status_code == 200
    assert calls[0]["followup_status"] == "contacted"
    assert calls[0]["phone_filter"] == "captured"
    assert calls[0]["search"] == "11111111"


def test_leads_highlights_missing_phone(monkeypatch):
    lead = sample_lead()
    lead["phone"] = ""

    async def fake_list_callback_leads(pool, **kwargs):
        return [lead]

    monkeypatch.setattr(repo, "list_callback_leads", fake_list_callback_leads)
    with client(monkeypatch) as c:
        c.app.state.pool = object()
        response = c.get("/leads", auth=AUTH)

    assert response.status_code == 200
    assert "missing-phone" in response.text
    assert "No phone captured" in response.text


def test_detail_masks_phone_by_default(monkeypatch):
    async def fake_get_lead(pool, lead_id):
        return sample_lead()

    monkeypatch.setattr(repo, "get_lead", fake_get_lead)
    with client(monkeypatch) as c:
        c.app.state.pool = object()
        response = c.get("/leads/11111111-1111-1111-1111-111111111111", auth=AUTH)

    assert response.status_code == 200
    assert FULL_PHONE not in response.text
    assert "+491 **** 678" in response.text


def test_reveal_phone_writes_audit_and_displays_phone(monkeypatch):
    audit_calls = []

    async def fake_get_lead(pool, lead_id):
        return sample_lead()

    async def fake_insert_audit(pool, **kwargs):
        audit_calls.append(kwargs)

    monkeypatch.setattr(repo, "get_lead", fake_get_lead)
    monkeypatch.setattr(repo, "insert_audit", fake_insert_audit)
    with client(monkeypatch) as c:
        c.app.state.pool = object()
        response = c.post(
            "/leads/11111111-1111-1111-1111-111111111111/reveal-phone",
            auth=AUTH,
        )

    assert response.status_code == 200
    assert FULL_PHONE in response.text
    assert audit_calls[0]["action"] == "reveal_phone"
    assert audit_calls[0]["new_value"] == "revealed"
    assert FULL_PHONE not in str(audit_calls)


def test_status_update_writes_audit(monkeypatch):
    audit_calls = []

    async def fake_get_lead(pool, lead_id):
        return sample_lead()

    async def fake_update_followup_status(pool, **kwargs):
        return ("new", kwargs["status"])

    async def fake_insert_audit(pool, **kwargs):
        audit_calls.append(kwargs)

    monkeypatch.setattr(repo, "get_lead", fake_get_lead)
    monkeypatch.setattr(repo, "update_followup_status", fake_update_followup_status)
    monkeypatch.setattr(repo, "insert_audit", fake_insert_audit)
    with client(monkeypatch) as c:
        c.app.state.pool = object()
        response = c.post(
            "/leads/11111111-1111-1111-1111-111111111111/status",
            data={"status": "contacted", "notes": "Called once"},
            auth=AUTH,
            follow_redirects=False,
        )

    assert response.status_code == 303
    assert audit_calls[0]["action"] == "update_status"
    assert audit_calls[0]["old_value"] == "new"
    assert audit_calls[0]["new_value"] == "contacted"


def test_quick_status_redirects_to_list(monkeypatch):
    async def fake_get_lead(pool, lead_id):
        return sample_lead()

    async def fake_update_followup_status(pool, **kwargs):
        return ("new", kwargs["status"])

    async def fake_insert_audit(pool, **kwargs):
        return None

    monkeypatch.setattr(repo, "get_lead", fake_get_lead)
    monkeypatch.setattr(repo, "update_followup_status", fake_update_followup_status)
    monkeypatch.setattr(repo, "insert_audit", fake_insert_audit)
    with client(monkeypatch) as c:
        c.app.state.pool = object()
        response = c.post(
            "/leads/11111111-1111-1111-1111-111111111111/status",
            data={"status": "done", "notes": "", "return_to": "list"},
            auth=AUTH,
            follow_redirects=False,
        )

    assert response.status_code == 303
    assert response.headers["location"] == "/leads"


def test_invalid_status_rejected(monkeypatch):
    async def fake_get_lead(pool, lead_id):
        return sample_lead()

    monkeypatch.setattr(repo, "get_lead", fake_get_lead)
    with client(monkeypatch) as c:
        c.app.state.pool = object()
        response = c.post(
            "/leads/11111111-1111-1111-1111-111111111111/status",
            data={"status": "bad", "notes": ""},
            auth=AUTH,
        )

    assert response.status_code == 400
