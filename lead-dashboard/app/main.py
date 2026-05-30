from contextlib import asynccontextmanager
from fastapi import Depends, FastAPI, Form, HTTPException, Query, Request, status
from fastapi.responses import RedirectResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from .auth import require_user
from .config import get_settings
from .db import close_pool, create_pool
from .privacy import bounded_text, mask_phone, normalize_phone_display, redact_phone_like
from . import repositories as repo


VALID_STATUSES = {"new", "contacted", "not_reachable", "done"}
STATUS_OPTIONS = ["new", "contacted", "not_reachable", "done"]


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    app.state.settings = settings
    app.state.pool = await create_pool(settings.database_url)
    yield
    await close_pool(app.state.pool)


app = FastAPI(title="TechnoloHit Lead Dashboard", version="0.1.0", lifespan=lifespan)
templates = Jinja2Templates(directory="app/templates")
templates.env.filters["mask_phone"] = mask_phone
templates.env.filters["bounded"] = bounded_text
app.mount("/static", StaticFiles(directory="app/static"), name="static")


@app.middleware("http")
async def privacy_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers["Cache-Control"] = "no-store"
    response.headers["Pragma"] = "no-cache"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "same-origin"
    return response


def _client_ip(request: Request) -> str:
    return request.client.host if request.client else ""


def _user_agent(request: Request) -> str:
    return request.headers.get("user-agent", "")[:500]


def _pool(request: Request):
    pool = request.app.state.pool
    if pool is None:
        raise HTTPException(status_code=503, detail="database_not_configured")
    return pool


def _display_lead(row: dict, *, include_phone: bool = False) -> dict:
    phone = normalize_phone_display(row.get("phone"))
    data = {k: v for k, v in row.items() if k != "phone"}
    data["masked_phone"] = mask_phone(phone)
    data["has_phone"] = bool(phone)
    data["caller_need"] = bounded_text(redact_phone_like(data.get("caller_need")), 500)
    data["summary_text"] = bounded_text(redact_phone_like(data.get("summary_text")), 1200)
    if include_phone:
        data["revealed_phone"] = phone or "No phone captured"
    return data


@app.get("/healthz")
async def healthz(request: Request) -> dict[str, object]:
    settings = request.app.state.settings
    return {
        "ok": True,
        "service": settings.app_name,
        "environment": settings.environment,
        "db_configured": bool(settings.database_url),
    }


@app.get("/")
async def root() -> RedirectResponse:
    return RedirectResponse(url="/leads", status_code=302)


@app.get("/leads")
async def leads(
    request: Request,
    status_filter: str = Query(default="", alias="status"),
    phone: str = Query(default=""),
    q: str = Query(default=""),
    user: str = Depends(require_user),
):
    status_filter = status_filter if status_filter in VALID_STATUSES else ""
    phone = phone if phone in {"captured", "missing"} else ""
    q = q.strip()[:120]
    rows = await repo.list_callback_leads(
        _pool(request),
        followup_status=status_filter,
        phone_filter=phone,
        search=q,
    )
    leads = [_display_lead(row, include_phone=False) for row in rows]
    return templates.TemplateResponse(
        request,
        "leads.html",
        {
            "request": request,
            "user": user,
            "leads": leads,
            "active": "leads",
            "app_base_url": request.app.state.settings.app_base_url,
            "filters": {
                "status": status_filter,
                "phone": phone,
                "q": q,
            },
            "valid_statuses": STATUS_OPTIONS,
        },
    )


@app.get("/leads/{lead_id}")
async def lead_detail(request: Request, lead_id: str, user: str = Depends(require_user)):
    row = await repo.get_lead(_pool(request), lead_id)
    if not row:
        raise HTTPException(status_code=404, detail="lead_not_found")
    lead = _display_lead(row, include_phone=False)
    return templates.TemplateResponse(
        request,
        "lead_detail.html",
        {
            "request": request,
            "user": user,
            "lead": lead,
            "revealed": False,
            "active": "leads",
            "valid_statuses": STATUS_OPTIONS,
        },
    )


@app.post("/leads/{lead_id}/reveal-phone")
async def reveal_phone(request: Request, lead_id: str, user: str = Depends(require_user)):
    row = await repo.get_lead(_pool(request), lead_id)
    if not row:
        raise HTTPException(status_code=404, detail="lead_not_found")
    await repo.insert_audit(
        _pool(request),
        lead_id=lead_id,
        user_name=user,
        action="reveal_phone",
        new_value="revealed",
        ip_address=_client_ip(request),
        user_agent=_user_agent(request),
    )
    lead = _display_lead(row, include_phone=True)
    return templates.TemplateResponse(
        request,
        "lead_detail.html",
        {
            "request": request,
            "user": user,
            "lead": lead,
            "revealed": True,
            "active": "leads",
            "valid_statuses": STATUS_OPTIONS,
        },
    )


@app.post("/leads/{lead_id}/status")
async def update_status(
    request: Request,
    lead_id: str,
    status_value: str = Form(alias="status"),
    notes: str = Form(default=""),
    return_to: str = Form(default="detail"),
    user: str = Depends(require_user),
):
    if status_value not in VALID_STATUSES:
        raise HTTPException(status_code=400, detail="invalid_status")
    row = await repo.get_lead(_pool(request), lead_id)
    if not row:
        raise HTTPException(status_code=404, detail="lead_not_found")
    old_status, new_status = await repo.update_followup_status(
        _pool(request),
        lead_id=lead_id,
        status=status_value,
        notes=notes[:2000],
        user_name=user,
    )
    await repo.insert_audit(
        _pool(request),
        lead_id=lead_id,
        user_name=user,
        action="update_status",
        old_value=old_status,
        new_value=new_status,
        ip_address=_client_ip(request),
        user_agent=_user_agent(request),
    )
    target = "/leads" if return_to == "list" else f"/leads/{lead_id}"
    return RedirectResponse(url=target, status_code=status.HTTP_303_SEE_OTHER)


@app.get("/audit")
async def audit(request: Request, user: str = Depends(require_user)):
    rows = await repo.list_audit(_pool(request))
    return templates.TemplateResponse(
        request,
        "audit.html",
        {
            "request": request,
            "user": user,
            "events": rows,
            "active": "audit",
        },
    )
