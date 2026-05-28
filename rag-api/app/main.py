import time
from contextlib import asynccontextmanager
from fastapi import FastAPI, HTTPException, Request
from .config import get_settings
from .db import check_ready, create_pool
from .models import (
    IngestDocumentRequest,
    IngestDocumentResponse,
    ReindexRequest,
    ReindexResponse,
    RetrieveRequest,
    RetrieveResponse,
)
from .retrieval import ingest_document, retrieve


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    app.state.settings = settings
    app.state.pool = await create_pool(settings)
    yield
    if app.state.pool is not None:
        await app.state.pool.close()


app = FastAPI(title="TechnoloHit RAG API", version="0.1.0", lifespan=lifespan)


@app.middleware("http")
async def add_process_time_header(request: Request, call_next):
    started = time.perf_counter()
    response = await call_next(request)
    response.headers["x-process-time-ms"] = str(int((time.perf_counter() - started) * 1000))
    return response


@app.get("/healthz")
async def healthz() -> dict[str, object]:
    settings = get_settings()
    return {
        "ok": True,
        "service": settings.app_name,
        "environment": settings.environment,
    }


@app.get("/readyz")
async def readyz(request: Request) -> dict[str, object]:
    status = await check_ready(request.app.state.pool)
    if not status.get("ready"):
        raise HTTPException(status_code=503, detail=status)
    return status


@app.post("/v1/retrieve", response_model=RetrieveResponse)
async def retrieve_endpoint(request_body: RetrieveRequest, request: Request) -> RetrieveResponse:
    if request.app.state.pool is None:
        raise HTTPException(status_code=503, detail="db_not_configured")
    try:
        return await retrieve(request.app.state.pool, request.app.state.settings, request_body)
    except TimeoutError as exc:
        raise HTTPException(status_code=504, detail="retrieval_timeout") from exc


@app.post("/v1/ingest/document", response_model=IngestDocumentResponse)
async def ingest_document_endpoint(
    request_body: IngestDocumentRequest,
    request: Request,
) -> IngestDocumentResponse:
    if request.app.state.pool is None:
        raise HTTPException(status_code=503, detail="db_not_configured")
    return await ingest_document(request.app.state.pool, request.app.state.settings, request_body)


@app.post("/v1/ingest/reindex", response_model=ReindexResponse)
async def reindex_endpoint(request_body: ReindexRequest) -> ReindexResponse:
    return ReindexResponse(
        accepted=False,
        message=(
            "Reindex job worker is not enabled in v1. "
            f"Use /v1/ingest/document for tenant={request_body.tenant_id}."
        ),
    )
