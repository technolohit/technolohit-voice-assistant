from typing import Any
from pydantic import BaseModel, Field


class RetrieveRequest(BaseModel):
    tenant_id: str = "technolohit"
    agent_id: str = "main_voice_sales"
    query: str = Field(min_length=1, max_length=4000)
    language: str = "de"
    top_k: int = Field(default=3, ge=1, le=8)
    min_score: float = Field(default=0.72, ge=0.0, le=1.0)
    context: dict[str, Any] = Field(default_factory=dict)


class RetrievedChunk(BaseModel):
    chunk_id: str
    document_id: str
    title: str
    content: str
    score: float
    source_uri: str
    metadata: dict[str, Any] = Field(default_factory=dict)


class RetrieveResponse(BaseModel):
    hit: bool
    answer_context: list[RetrievedChunk] = Field(default_factory=list)
    latency_ms: int


class IngestDocumentRequest(BaseModel):
    tenant_id: str = "technolohit"
    agent_id: str = "main_voice_sales"
    source_type: str = Field(default="manual", max_length=80)
    source_uri: str = Field(max_length=500)
    title: str = Field(max_length=300)
    language: str = "de"
    content: str = Field(min_length=1)
    metadata: dict[str, Any] = Field(default_factory=dict)


class IngestDocumentResponse(BaseModel):
    document_id: str
    chunks_created: int
    embeddings_created: int


class ReindexRequest(BaseModel):
    tenant_id: str = "technolohit"
    source_uri: str | None = None


class ReindexResponse(BaseModel):
    accepted: bool
    message: str
