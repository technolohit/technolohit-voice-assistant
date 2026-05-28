# Sysadmin brief: voice-bridge call identity fix

**Date:** 2026-05-19  
**Service:** `voice-bridge` (AudioSocket → PostgreSQL `voice` schema)  
**Impact:** Application only — no Asterisk, Easybell, firewall, or database migration required.

---

## Summary

Production Asterisk does not expose a dialplan `UUID()` function and sends a **static** AudioSocket UUID (`11111111-1111-1111-1111-111111111111`) on every call. The bridge previously used that value as `voice.call_sessions.external_call_id` (`audiosocket:<uuid>`), which violated the unique index on the second and later calls.

The bridge now generates a **unique ID per TCP connection** in Node.js. Asterisk’s wire UUID is stored only in JSON metadata for correlation.

---

## Three changes delivered

### 1. Unique call identity (application code)

| Before | After |
|--------|--------|
| `external_call_id = audiosocket:<asterisk_uuid>` | `external_call_id = bridge:<node_random_uuid>` |
| Same Asterisk UUID → duplicate key on every call | Each call → new row, unique constraint preserved |

**Behaviour:**

- On **TCP connect**, `crypto.randomUUID()` assigns `bridge_call_id`; `external_call_id` is set to `bridge:<that_uuid>`.
- On **UUID frame**, the Asterisk value is stored as `metadata.audiosocket_uuid` (and in event payloads), not as the DB unique key.

**Code:** `voice-bridge/src/persist.js`, `voice-bridge/src/audiosocket.js`

**Not changed:** Asterisk dialplan, Easybell, Docker Compose on monitoring host, Postgres schema, unique index on `external_call_id`.

---

### 2. Logging (operations / troubleshooting)

Log lines now include both identifiers where relevant:

- `bridge_call_id` — bridge-generated UUID (matches `external_call_id` after the `bridge:` prefix)
- `audiosocket_uuid` — value from Asterisk AudioSocket (may be static on production)

**Example:**

```text
[voice-bridge] call accepted bridge_call_id=<uuid> audiosocket_uuid=pending remote=...
[voice-bridge] UUID frame received bridge_call_id=<uuid> audiosocket_uuid=11111111-1111-1111-1111-111111111111
[voice-db] call session created id=<n> external_call_id=bridge:<uuid> bridge_call_id=<uuid> audiosocket_uuid=11111111-...
```

DB insert failures still log as `[voice-db] ... failed` and **do not** stop the audio path.

---

### 3. Documentation

| Document | Update |
|----------|--------|
| `voice-bridge/README.md` | Persistence model, verify SQL (`external_call_id LIKE 'bridge:%'`), metadata example |
| `docs/voice-database.md` | `external_call_id` / `audiosocket_uuid` semantics for voice-bridge |

---

## Deployment (sysadmin)

1. **Pull** latest repo revision containing the voice-bridge change.
2. **Rebuild/restart** only the voice-bridge process/container (port **9092** by default, `VOICE_BRIDGE_*` env unchanged).
3. **Do not** run `npm run db:migrate:voice` for this fix — no new migration.
4. **Do not** change Asterisk or Easybell configuration.

**Env:** Existing `VOICE_DB_*` and `voice-bridge/.env` remain valid. No new secrets.

---

## Verification after deploy

1. Place **two** inbound test calls in a row.
2. On the monitoring host (or via SSH + `docker exec` to `central_postgres`):

```sql
SELECT id,
       external_call_id,
       metadata->>'bridge_call_id'   AS bridge_call_id,
       metadata->>'audiosocket_uuid' AS audiosocket_uuid,
       created_at
FROM voice.call_sessions
ORDER BY created_at DESC
LIMIT 5;
```

**Expected:**

- Two rows with **different** `external_call_id` values (`bridge:...`).
- Same `audiosocket_uuid` in metadata if Asterisk still sends the static placeholder.
- No `duplicate key` errors in voice-bridge logs.

3. Optional — events for latest sessions:

```sql
SELECT ce.occurred_at, ce.event_type, ce.payload
FROM voice.call_events ce
JOIN voice.call_sessions cs ON cs.id = ce.call_session_id
WHERE cs.external_call_id LIKE 'bridge:%'
ORDER BY ce.occurred_at DESC
LIMIT 20;
```

---

## Legacy data

Older rows may still show `external_call_id` like `audiosocket:...` from a previous bridge build. New calls use `bridge:...` only after this deploy.

---

## Rollback

Redeploy the previous voice-bridge image/binary. No DB rollback script is required. Note: rollback restores the duplicate-key behaviour if Asterisk continues to send a static UUID.

---

## Contact / references

- Service README: [voice-bridge/README.md](../voice-bridge/README.md)
- Voice DB: [voice-database.md](./voice-database.md)
