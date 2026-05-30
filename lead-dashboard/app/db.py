import asyncpg


async def create_pool(database_url: str):
    if not database_url:
        return None
    return await asyncpg.create_pool(
        dsn=database_url,
        min_size=1,
        max_size=5,
        command_timeout=5,
    )


async def close_pool(pool) -> None:
    if pool is not None and hasattr(pool, "close"):
        await pool.close()
