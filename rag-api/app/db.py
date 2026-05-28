import asyncpg
from .config import Settings


async def create_pool(settings: Settings) -> asyncpg.Pool | None:
    if not settings.db_dsn:
        return None

    server_settings = {
        "statement_timeout": str(max(100, settings.db_statement_timeout_ms)),
    }
    return await asyncpg.create_pool(
        dsn=settings.db_dsn,
        min_size=1,
        max_size=5,
        ssl=settings.db_ssl,
        server_settings=server_settings,
    )


async def check_ready(pool: asyncpg.Pool | None) -> dict[str, object]:
    if pool is None:
        return {"ready": False, "reason": "db_not_configured"}

    async with pool.acquire() as conn:
        vector = await conn.fetchval(
            "SELECT extversion FROM pg_extension WHERE extname = 'vector';"
        )
        has_schema = await conn.fetchval(
            "SELECT EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = 'knowledge');"
        )
        has_embeddings = await conn.fetchval(
            """
            SELECT EXISTS (
              SELECT 1
              FROM information_schema.columns
              WHERE table_schema = 'knowledge'
                AND table_name = 'embeddings'
                AND column_name = 'embedding'
                AND udt_name = 'vector'
            );
            """
        )

    return {
        "ready": bool(vector and has_schema and has_embeddings),
        "vector_version": vector,
        "knowledge_schema": bool(has_schema),
        "embedding_vector_column": bool(has_embeddings),
    }
