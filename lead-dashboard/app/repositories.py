from typing import Any


CALLBACK_FILTER_SQL = """
(
  COALESCE(NULLIF(s.metadata->>'next_action', ''), NULLIF(l.metadata->>'next_action', '')) = 'team_callback'
  OR COALESCE(NULLIF(s.metadata->>'contact_preference', ''), NULLIF(l.metadata->>'contact_preference', '')) = 'phone'
  OR COALESCE(NULLIF(l.metadata->>'contact_route', ''), '') = 'callback'
)
"""


LEAD_SELECT_SQL = """
SELECT
  l.id::text AS lead_id,
  l.call_session_id::text AS call_session_id,
  cs.external_call_id,
  COALESCE(cs.metadata->>'bridge_call_id', '') AS bridge_call_id,
  l.status AS lead_status,
  COALESCE(fs.status, 'new') AS followup_status,
  COALESCE(fs.notes, '') AS followup_notes,
  COALESCE(NULLIF(s.metadata->>'product_interest', ''), NULLIF(l.metadata->>'product_interest', ''), 'Unknown') AS product_interest,
  COALESCE(NULLIF(s.metadata->>'caller_need', ''), NULLIF(l.metadata->>'caller_need', ''), '') AS caller_need,
  COALESCE(NULLIF(s.metadata->>'contact_preference', ''), NULLIF(l.metadata->>'contact_preference', ''), '') AS contact_preference,
  COALESCE(NULLIF(s.metadata->>'permission', ''), NULLIF(l.metadata->>'permission', ''), '') AS permission,
  COALESCE(NULLIF(s.metadata->>'next_action', ''), NULLIF(l.metadata->>'next_action', ''), '') AS next_action,
  COALESCE(NULLIF(s.metadata->>'confidence', ''), NULLIF(l.metadata->>'confidence', ''), '') AS confidence,
  COALESCE(NULLIF(s.summary_text, ''), l.notes, '') AS summary_text,
  COALESCE(NULLIF(l.normalized_phone, ''), NULLIF(cs.caller_phone_normalized, ''), NULLIF(cs.caller_phone_raw, '')) AS phone,
  l.created_at,
  l.updated_at,
  s.id::text AS summary_id
FROM voice.leads l
LEFT JOIN voice.call_sessions cs ON cs.id = l.call_session_id
LEFT JOIN voice.call_summaries s ON s.call_session_id = cs.id AND s.summary_type = 'auto'
LEFT JOIN voice.lead_followup_status fs ON fs.lead_id = l.id
"""


def _dict(row) -> dict[str, Any]:
    return dict(row) if row is not None else {}


async def list_callback_leads(
    pool,
    *,
    limit: int = 100,
    followup_status: str = "",
    phone_filter: str = "",
    search: str = "",
) -> list[dict[str, Any]]:
    filters = [CALLBACK_FILTER_SQL]
    values: list[Any] = []

    if followup_status:
        values.append(followup_status)
        filters.append(f"COALESCE(fs.status, 'new') = ${len(values)}")

    if phone_filter == "captured":
        filters.append(
            """
            COALESCE(
              NULLIF(l.normalized_phone, ''),
              NULLIF(cs.caller_phone_normalized, ''),
              NULLIF(cs.caller_phone_raw, '')
            ) IS NOT NULL
            """
        )
    elif phone_filter == "missing":
        filters.append(
            """
            COALESCE(
              NULLIF(l.normalized_phone, ''),
              NULLIF(cs.caller_phone_normalized, ''),
              NULLIF(cs.caller_phone_raw, '')
            ) IS NULL
            """
        )

    if search:
        values.append(f"%{search}%")
        placeholder = f"${len(values)}"
        filters.append(
            f"""
            (
              l.id::text ILIKE {placeholder}
              OR l.call_session_id::text ILIKE {placeholder}
              OR cs.external_call_id ILIKE {placeholder}
            )
            """
        )

    values.append(limit)
    limit_placeholder = f"${len(values)}"
    query = f"""
    {LEAD_SELECT_SQL}
    WHERE {' AND '.join(filters)}
    ORDER BY l.created_at DESC
    LIMIT {limit_placeholder}
    """
    async with pool.acquire() as conn:
        rows = await conn.fetch(query, *values)
    return [_dict(row) for row in rows]


async def get_lead(pool, lead_id: str) -> dict[str, Any] | None:
    query = f"""
    {LEAD_SELECT_SQL}
    WHERE l.id = $1::uuid
    """
    async with pool.acquire() as conn:
        row = await conn.fetchrow(query, lead_id)
    return _dict(row) if row else None


async def insert_audit(
    pool,
    *,
    lead_id: str,
    user_name: str,
    action: str,
    old_value: str = "",
    new_value: str = "",
    ip_address: str = "",
    user_agent: str = "",
) -> None:
    async with pool.acquire() as conn:
        await conn.execute(
            """
            INSERT INTO voice.lead_access_audit (
              lead_id, user_name, action, old_value, new_value, ip_address, user_agent
            )
            VALUES ($1::uuid, $2, $3, $4, $5, $6, $7)
            """,
            lead_id,
            user_name,
            action,
            old_value,
            new_value,
            ip_address,
            user_agent,
        )


async def update_followup_status(
    pool,
    *,
    lead_id: str,
    status: str,
    notes: str,
    user_name: str,
) -> tuple[str, str]:
    async with pool.acquire() as conn:
        old_status = await conn.fetchval(
            "SELECT status FROM voice.lead_followup_status WHERE lead_id = $1::uuid",
            lead_id,
        )
        old_status = old_status or "new"
        await conn.execute(
            """
            INSERT INTO voice.lead_followup_status (lead_id, status, notes, updated_by, updated_at)
            VALUES ($1::uuid, $2, $3, $4, now())
            ON CONFLICT (lead_id)
            DO UPDATE SET
              status = EXCLUDED.status,
              notes = EXCLUDED.notes,
              updated_by = EXCLUDED.updated_by,
              updated_at = now()
            """,
            lead_id,
            status,
            notes,
            user_name,
        )
    return old_status, status


async def list_audit(pool, limit: int = 100) -> list[dict[str, Any]]:
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT
              a.id::text AS id,
              a.lead_id::text AS lead_id,
              a.user_name,
              a.action,
              a.old_value,
              a.new_value,
              a.ip_address,
              a.user_agent,
              a.created_at,
              l.status AS lead_status
            FROM voice.lead_access_audit a
            LEFT JOIN voice.leads l ON l.id = a.lead_id
            ORDER BY a.created_at DESC
            LIMIT $1
            """,
            limit,
        )
    return [_dict(row) for row in rows]
