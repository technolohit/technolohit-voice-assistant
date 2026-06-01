import hashlib
import json
import re
import time
from typing import Any
import asyncpg
from .config import Settings
from .embeddings import embed_many, embed_text, vector_literal
from .models import IngestDocumentRequest, IngestDocumentResponse, RetrievedChunk, RetrieveRequest, RetrieveResponse

PRODUCT_ALIASES: dict[str, tuple[str, ...]] = {
    "smart_website": ("smart website", "smarte website", "intelligente website", "intelligente webseite"),
    "aiseoq": ("aiseoq", "ai seo q", "seo workspace"),
    "botinteg": ("botinteg", "bot integ"),
    "lokalki": ("lokalki", "lokal ki", "lokale ki"),
    "voice_agent": ("digitale rezeption", "digitaler telefonassistent", "voice agent", "telefonassistent"),
}

SEMANTIC_PRODUCT_SIGNALS: dict[str, tuple[str, ...]] = {
    "lokalki": (
        "interne dokumente",
        "sensible interne dokumente",
        "sensible daten",
        "datenschutz",
        "private ki",
        "lokale ki",
        "lokalki",
        "kontrollierte umgebung",
        "internes wissen",
    ),
}

GERMAN_STEM_SUFFIXES: tuple[str, ...] = ("innen", "chen", "ern", "en", "em", "er", "es", "e", "n", "s")

LOKALKI_SEMANTIC_PATTERNS: tuple[str, ...] = (
    r"\bsensibl\w*\s+intern\w*\s+dokument\w*\b",
    r"\bmit\s+sensibl\w*\s+intern\w*\s+dokument\w*\b",
    r"\bsensibl\w*\s+daten\b",
    r"\bmit\s+sensibl\w*\s+daten\b",
    r"\bloesung\s+mit\s+sensibl\w*\s+daten\b",
    r"\bsystem\s+mit\s+sensibl\w*\s+intern\w*\s+dokument\w*\b",
    r"\bsensibl\w*\s+daten\s+arbeit\w*\b",
)


def is_explicit_lokalki_semantic_query(query: str) -> bool:
    normalized = normalize_text(query)
    return any(re.search(pattern, normalized) for pattern in LOKALKI_SEMANTIC_PATTERNS)


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def now_ms() -> int:
    return int(time.perf_counter() * 1000)


def normalize_text(text: str) -> str:
    lowered = str(text or "").lower()
    lowered = lowered.replace("ß", "ss")
    lowered = (
        lowered.replace("ä", "ae")
        .replace("ö", "oe")
        .replace("ü", "ue")
    )
    lowered = re.sub(r"[^a-z0-9\s_-]", " ", lowered)
    lowered = re.sub(r"\s+", " ", lowered).strip()
    return lowered


def stem_token(token: str) -> str:
    value = token.strip()
    if len(value) <= 3:
        return value
    for suffix in GERMAN_STEM_SUFFIXES:
        if value.endswith(suffix) and len(value) - len(suffix) >= 4:
            return value[: -len(suffix)]
    return value


def token_stems(text: str) -> set[str]:
    normalized = normalize_text(text)
    if not normalized:
        return set()
    stems = {stem_token(token) for token in normalized.split(" ") if token}
    return {stem for stem in stems if stem}


def signal_matches_query(signal: str, query: str) -> bool:
    signal_norm = normalize_text(signal)
    query_norm = normalize_text(query)
    if not signal_norm or not query_norm:
        return False
    if re.search(rf"(^|\s){re.escape(signal_norm)}($|\s)", query_norm):
        return True
    signal_stems = token_stems(signal_norm)
    query_stems = token_stems(query_norm)
    return bool(signal_stems) and signal_stems.issubset(query_stems)


def is_definition_query(query: str) -> bool:
    normalized = normalize_text(query)
    return bool(
        re.search(r"\bwas ist\b", normalized)
        or re.search(r"\bwas sind\b", normalized)
        or re.search(r"\berklaer", normalized)
        or re.search(r"\berzaehl", normalized)
    )


def requested_product_ids(query: str) -> set[str]:
    normalized = normalize_text(query)
    found: set[str] = set()
    for product_id, aliases in PRODUCT_ALIASES.items():
        for alias in aliases:
            alias_norm = normalize_text(alias)
            if not alias_norm:
                continue
            if re.search(rf"(^|\s){re.escape(alias_norm)}($|\s)", normalized):
                found.add(product_id)
                break
    return found


def requested_semantic_product_ids(query: str) -> set[str]:
    normalized = normalize_text(query)
    found: set[str] = set()
    for product_id, signals in SEMANTIC_PRODUCT_SIGNALS.items():
        for signal in signals:
            if signal_matches_query(signal, query):
                found.add(product_id)
                break
    if any(re.search(pattern, normalized) for pattern in LOKALKI_SEMANTIC_PATTERNS):
        found.add("lokalki")
    return found


def row_matches_product(row: asyncpg.Record, product_id: str) -> bool:
    source_uri = normalize_text(str(row["source_uri"] or ""))
    title = normalize_text(str(row["title"] or ""))
    content = normalize_text(str(row["content"] or ""))
    if f"#{product_id}" in source_uri:
        return True
    for alias in PRODUCT_ALIASES.get(product_id, ()):
        alias_norm = normalize_text(alias)
        if alias_norm and (alias_norm in title or alias_norm in content):
            return True
    return False


def chunk_matches_product(chunk: RetrievedChunk, product_id: str) -> bool:
    source_uri = normalize_text(str(chunk.source_uri or ""))
    title = normalize_text(str(chunk.title or ""))
    content = normalize_text(str(chunk.content or ""))
    if f"#{product_id}" in source_uri:
        return True
    for alias in PRODUCT_ALIASES.get(product_id, ()):
        alias_norm = normalize_text(alias)
        if alias_norm and (alias_norm in title or alias_norm in content):
            return True
    return False


def chunk_from_row(row: asyncpg.Record, adjusted_score: float, metadata: dict[str, Any]) -> RetrievedChunk:
    return RetrievedChunk(
        chunk_id=str(row["chunk_id"]),
        document_id=str(row["document_id"]),
        title=row["title"],
        content=row["content"],
        score=adjusted_score,
        source_uri=row["source_uri"],
        metadata=metadata,
    )


def chunk_text(text: str, chunk_chars: int, overlap_chars: int) -> list[str]:
    normalized = re.sub(r"\s+", " ", text).strip()
    if not normalized:
        return []

    chunk_chars = max(300, chunk_chars)
    overlap_chars = max(0, min(overlap_chars, chunk_chars // 3))
    chunks: list[str] = []
    start = 0
    while start < len(normalized):
        end = min(len(normalized), start + chunk_chars)
        if end < len(normalized):
            boundary = normalized.rfind(". ", start, end)
            if boundary > start + 200:
                end = boundary + 1
        chunk = normalized[start:end].strip()
        if chunk:
            chunks.append(chunk)
        if end >= len(normalized):
            break
        start = max(end - overlap_chars, start + 1)
    return chunks


async def ingest_document(
    pool: asyncpg.Pool,
    settings: Settings,
    request: IngestDocumentRequest,
) -> IngestDocumentResponse:
    content = request.content[: settings.max_document_chars]
    chunks = chunk_text(content, settings.chunk_chars, settings.chunk_overlap_chars)
    embeddings = await embed_many(settings, chunks)
    content_hash = sha256_text(content)

    async with pool.acquire() as conn:
        async with conn.transaction():
            document_id = await conn.fetchval(
                """
                INSERT INTO knowledge.documents (
                  tenant_id, agent_id, source_type, source_uri, title, language, content_hash, metadata
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
                ON CONFLICT (tenant_id, agent_id, source_uri, content_hash)
                DO UPDATE SET
                  title = EXCLUDED.title,
                  language = EXCLUDED.language,
                  metadata = EXCLUDED.metadata,
                  agent_id = EXCLUDED.agent_id,
                  is_active = true,
                  updated_at = now()
                RETURNING id;
                """,
                request.tenant_id,
                request.agent_id,
                request.source_type,
                request.source_uri,
                request.title,
                request.language,
                content_hash,
                json.dumps(request.metadata),
            )
            await conn.execute("DELETE FROM knowledge.chunks WHERE document_id = $1;", document_id)

            created = 0
            for index, (chunk, embedding) in enumerate(zip(chunks, embeddings)):
                chunk_id = await conn.fetchval(
                    """
                    INSERT INTO knowledge.chunks (
                      document_id, tenant_id, chunk_index, content, token_count, metadata
                    )
                    VALUES ($1, $2, $3, $4, $5, $6::jsonb)
                    RETURNING id;
                    """,
                    document_id,
                    request.tenant_id,
                    index,
                    chunk,
                    max(1, len(chunk.split())),
                    json.dumps({"source_uri": request.source_uri}),
                )
                await conn.execute(
                    """
                    INSERT INTO knowledge.embeddings (
                      chunk_id, tenant_id, model, dimensions, embedding, content_hash
                    )
                    VALUES ($1, $2, $3, $4, $5::vector, $6);
                    """,
                    chunk_id,
                    request.tenant_id,
                    settings.embedding_model,
                    settings.embedding_dimensions,
                    vector_literal(embedding),
                    sha256_text(chunk),
                )
                created += 1

    return IngestDocumentResponse(
        document_id=str(document_id),
        chunks_created=len(chunks),
        embeddings_created=created,
    )


async def retrieve(
    pool: asyncpg.Pool,
    settings: Settings,
    request: RetrieveRequest,
) -> RetrieveResponse:
    started = now_ms()
    embedding = await embed_text(settings, request.query)
    query_vector = vector_literal(embedding)
    min_score = request.min_score if request.min_score is not None else settings.default_min_score
    top_k = request.top_k or settings.default_top_k
    candidate_limit = max(top_k, int(settings.retrieve_candidate_limit))
    exact_boost = max(0.0, float(settings.exact_product_boost))
    semantic_boost = max(0.0, float(settings.semantic_product_boost))
    semantic_accept_floor = max(0.0, min(1.0, float(getattr(settings, "semantic_product_accept_floor", 0.66))))
    product_ids = requested_product_ids(request.query)
    semantic_product_ids = requested_semantic_product_ids(request.query)
    explicit_lokalki_semantic = is_explicit_lokalki_semantic_query(request.query)
    definition_query = is_definition_query(request.query)

    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT
              c.id AS chunk_id,
              d.id AS document_id,
              d.title,
              c.content,
              d.source_uri,
              c.metadata,
              1 - (e.embedding <=> $1::vector) AS score
            FROM knowledge.embeddings e
            JOIN knowledge.chunks c ON c.id = e.chunk_id
            JOIN knowledge.documents d ON d.id = c.document_id
            WHERE e.tenant_id = $2
              AND d.agent_id = $3
              AND e.model = $4
              AND e.dimensions = $5
              AND d.is_active = true
            ORDER BY e.embedding <=> $1::vector
            LIMIT $6;
            """,
            query_vector,
            request.tenant_id,
            request.agent_id,
            settings.embedding_model,
            settings.embedding_dimensions,
            candidate_limit,
        )
        if semantic_product_ids:
            semantic_rows = await conn.fetch(
                """
                SELECT
                  c.id AS chunk_id,
                  d.id AS document_id,
                  d.title,
                  c.content,
                  d.source_uri,
                  c.metadata,
                  1 - (e.embedding <=> $1::vector) AS score
                FROM knowledge.embeddings e
                JOIN knowledge.chunks c ON c.id = e.chunk_id
                JOIN knowledge.documents d ON d.id = c.document_id
                WHERE e.tenant_id = $2
                  AND d.agent_id = $3
                  AND e.model = $4
                  AND e.dimensions = $5
                  AND d.is_active = true
                  AND (
                    d.source_uri LIKE '%products.technolohit.json%'
                    OR d.source_uri LIKE '%technolohit.md%'
                  )
                ORDER BY e.embedding <=> $1::vector
                LIMIT $6;
                """,
                query_vector,
                request.tenant_id,
                request.agent_id,
                settings.embedding_model,
                settings.embedding_dimensions,
                max(top_k, 6),
            )
            seen_chunk_ids = {str(row["chunk_id"]) for row in rows}
            for row in semantic_rows:
                chunk_id = str(row["chunk_id"])
                if chunk_id not in seen_chunk_ids:
                    rows.append(row)
                    seen_chunk_ids.add(chunk_id)
        if "lokalki" in semantic_product_ids:
            lokalki_rows = await conn.fetch(
                """
                SELECT
                  c.id AS chunk_id,
                  d.id AS document_id,
                  d.title,
                  c.content,
                  d.source_uri,
                  c.metadata,
                  1 - (e.embedding <=> $1::vector) AS score
                FROM knowledge.embeddings e
                JOIN knowledge.chunks c ON c.id = e.chunk_id
                JOIN knowledge.documents d ON d.id = c.document_id
                WHERE e.tenant_id = $2
                  AND d.agent_id = $3
                  AND e.model = $4
                  AND e.dimensions = $5
                  AND d.is_active = true
                  AND d.source_uri LIKE '%products.technolohit.json%'
                  AND (
                    d.source_uri LIKE '%#lokalki%'
                    OR lower(c.content) LIKE '%lokalki%'
                    OR lower(c.content) LIKE '%private ki%'
                    OR lower(c.content) LIKE '%interne dokumente%'
                    OR lower(c.content) LIKE '%sensible daten%'
                  )
                ORDER BY e.embedding <=> $1::vector
                LIMIT $6;
                """,
                query_vector,
                request.tenant_id,
                request.agent_id,
                settings.embedding_model,
                settings.embedding_dimensions,
                max(top_k, 5),
            )
            seen_chunk_ids = {str(row["chunk_id"]) for row in rows}
            for row in lokalki_rows:
                chunk_id = str(row["chunk_id"])
                if chunk_id not in seen_chunk_ids:
                    rows.append(row)
                    seen_chunk_ids.add(chunk_id)

        ranked_chunks: list[RetrievedChunk] = []
        for row in rows:
            base_score = float(row["score"])
            adjusted_score = base_score
            metadata = json_object(row["metadata"])

            # Deterministic rerank for exact product-name definition queries.
            if (
                definition_query
                and product_ids
                and row["source_uri"]
                and "products.technolohit.json" in str(row["source_uri"])
                and any(row_matches_product(row, product_id) for product_id in product_ids)
            ):
                adjusted_score = min(1.0, base_score + exact_boost)
                metadata = {
                    **metadata,
                    "score_boost_reason": "exact_product_name",
                    "base_score": round(base_score, 6),
                }

            if (
                semantic_product_ids
                and any(row_matches_product(row, product_id) for product_id in semantic_product_ids)
            ):
                adjusted_score = min(1.0, adjusted_score + semantic_boost)
                metadata = {
                    **metadata,
                    "score_boost_reason": metadata.get("score_boost_reason", "semantic_product_intent"),
                    "semantic_product_intent": sorted(list(semantic_product_ids)),
                    "base_score": round(base_score, 6),
                }

            ranked_chunks.append(chunk_from_row(row, adjusted_score, metadata))
        for chunk in ranked_chunks:
            if not semantic_product_ids:
                continue
            if float(chunk.score) >= min_score:
                continue
            if float(chunk.score) < semantic_accept_floor:
                continue
            if not any(chunk_matches_product(chunk, product_id) for product_id in semantic_product_ids):
                continue
            chunk.metadata = {
                **json_object(chunk.metadata),
                "semantic_product_intent": sorted(list(semantic_product_ids)),
                "accepted_by": "semantic_product_floor",
                "semantic_product_floor": semantic_accept_floor,
            }
        ranked_chunks.sort(
            key=lambda item: (
                1 if semantic_product_ids and any(chunk_matches_product(item, pid) for pid in semantic_product_ids) else 0,
                1 if semantic_product_ids and "products.technolohit.json#" in str(item.source_uri or "") else 0,
                float(item.score),
            ),
            reverse=True,
        )
        chunks = [
            chunk
            for chunk in ranked_chunks
            if (
                float(chunk.score) >= min_score
                or (
                    semantic_product_ids
                    and any(chunk_matches_product(chunk, product_id) for product_id in semantic_product_ids)
                    and float(chunk.score) >= semantic_accept_floor
                )
            )
        ][:top_k]
        if not chunks and "lokalki" in semantic_product_ids:
            fallback_candidates = [
                chunk
                for chunk in ranked_chunks
                if chunk_matches_product(chunk, "lokalki") and float(chunk.score) >= semantic_accept_floor
            ]
            fallback_candidates.sort(
                key=lambda item: (
                    1 if "products.technolohit.json#lokalki" in str(item.source_uri or "") else 0,
                    float(item.score),
                ),
                reverse=True,
            )
            if fallback_candidates:
                chosen = fallback_candidates[0]
                chosen.metadata = {
                    **json_object(chosen.metadata),
                    "score_boost_reason": "semantic_product_intent",
                    "semantic_product_intent": ["lokalki"],
                    "accepted_by": "semantic_product_floor",
                    "semantic_product_floor": semantic_accept_floor,
                }
                chunks = [chosen]
        if explicit_lokalki_semantic:
            has_lokalki_chunk = any(chunk_matches_product(chunk, "lokalki") for chunk in chunks)
            if not has_lokalki_chunk:
                lokalki_row = await conn.fetchrow(
                    """
                    SELECT
                      c.id AS chunk_id,
                      d.id AS document_id,
                      d.title,
                      c.content,
                      d.source_uri,
                      c.metadata,
                      1 - (e.embedding <=> $1::vector) AS score
                    FROM knowledge.embeddings e
                    JOIN knowledge.chunks c ON c.id = e.chunk_id
                    JOIN knowledge.documents d ON d.id = c.document_id
                    WHERE e.tenant_id = $2
                      AND d.agent_id = $3
                      AND e.model = $4
                      AND e.dimensions = $5
                      AND d.is_active = true
                      AND d.source_uri LIKE '%products.technolohit.json%'
                      AND (
                        d.source_uri LIKE '%#lokalki%'
                        OR lower(d.title) LIKE '%lokalki%'
                        OR lower(c.content) LIKE '%lokalki%'
                      )
                    ORDER BY e.embedding <=> $1::vector
                    LIMIT 1;
                    """,
                    query_vector,
                    request.tenant_id,
                    request.agent_id,
                    settings.embedding_model,
                    settings.embedding_dimensions,
                )
                if lokalki_row:
                    base_score = float(lokalki_row["score"])
                    deterministic_score = min(1.0, base_score + semantic_boost)
                    deterministic_chunk = chunk_from_row(
                        lokalki_row,
                        deterministic_score,
                        {
                            **json_object(lokalki_row["metadata"]),
                            "semantic_product_intent": ["lokalki"],
                            "accepted_by": "deterministic_semantic_product_router",
                            "score_boost_reason": "semantic_product_intent",
                            "base_score": round(base_score, 6),
                        },
                    )
                    chunks = [deterministic_chunk, *chunks][:top_k]
        latency_ms = max(0, now_ms() - started)
        await log_retrieval(conn, settings, request, chunks, latency_ms, min_score, top_k)

    return RetrieveResponse(hit=bool(chunks), answer_context=chunks, latency_ms=latency_ms)


async def log_retrieval(
    conn: asyncpg.Connection,
    settings: Settings,
    request: RetrieveRequest,
    chunks: list[RetrievedChunk],
    latency_ms: int,
    min_score: float,
    top_k: int,
) -> None:
    query_preview = request.query[:160] if settings.log_query_preview else None
    selected_ids = [chunk.chunk_id for chunk in chunks]
    await conn.execute(
        """
        INSERT INTO knowledge.retrieval_logs (
          tenant_id, agent_id, query_hash, query_preview, top_k, min_score, latency_ms,
          hit_count, selected_chunk_ids, caller_context
        )
        SELECT $1, $2, $3, $4, $5, $6, $7, $8,
               ARRAY(SELECT value::uuid FROM unnest($9::text[]) AS value),
               $10::jsonb;
        """,
        request.tenant_id,
        request.agent_id,
        sha256_text(request.query),
        query_preview,
        top_k,
        min_score,
        latency_ms,
        len(chunks),
        selected_ids,
        json.dumps(safe_context(request.context)),
    )


def safe_context(context: dict[str, Any]) -> dict[str, Any]:
    allowed = {
        "call_id",
        "turn_index",
        "detected_intent",
        "transcript_quality",
        "source",
        "tenant_id",
        "agent_id",
    }
    return {key: value for key, value in context.items() if key in allowed}


def json_object(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if isinstance(value, str) and value:
        try:
            parsed = json.loads(value)
            return parsed if isinstance(parsed, dict) else {}
        except json.JSONDecodeError:
            return {}
    return {}
