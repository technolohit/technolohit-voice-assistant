import pg from "pg";

const { Pool } = pg;

let pool = null;

function dbLog(message, err) {
  const detail = err?.message ? `: ${err.message}` : "";
  console.error(`[voice-db] ${message}${detail}`);
}

export function isDbConfigured(config) {
  return Boolean(config?.db?.enabled);
}

export function getPool(config) {
  if (!isDbConfigured(config)) {
    return null;
  }
  if (!pool) {
    pool = new Pool({
      host: config.db.host,
      port: config.db.port,
      database: config.db.database,
      user: config.db.user,
      password: config.db.password,
      ssl: config.db.ssl ? { rejectUnauthorized: false } : false,
      max: Number.parseInt(process.env.VOICE_DB_POOL_MAX ?? "5", 10) || 5,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      application_name: "technolohit_voice_bridge"
    });
    pool.on("error", (err) => {
      dbLog("pool error", err);
    });
  }
  return pool;
}

export async function closePool() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

/**
 * @param {import('./config.js').loadConfig extends () => infer R ? R : never} config
 */
export async function createCallSession(config, input) {
  const p = getPool(config);
  if (!p) return null;

  const externalCallId = String(input.externalCallId ?? "").trim();
  if (!externalCallId) {
    throw new Error("externalCallId is required");
  }

  const metadata = {
    ...(input.metadata && typeof input.metadata === "object" ? input.metadata : {}),
    source: input.source ?? "easybell",
    language: input.language ?? "de"
  };

  const sql = `
    INSERT INTO voice.call_sessions (
      external_call_id,
      provider,
      direction,
      status,
      caller_phone_raw,
      caller_phone_normalized,
      language,
      started_at,
      metadata
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, now(), $8::jsonb)
    RETURNING id::text AS id;
  `;

  const values = [
    externalCallId,
    String(input.provider ?? input.source ?? "easybell"),
    String(input.direction ?? "inbound"),
    String(input.status ?? "active"),
    String(input.callerPhoneRaw ?? ""),
    String(input.callerPhoneNormalized ?? ""),
    String(input.language ?? "de"),
    JSON.stringify(metadata)
  ];

  const result = await p.query(sql, values);
  return result.rows[0]?.id ?? null;
}

export async function insertCallEvent(config, input) {
  const p = getPool(config);
  if (!p) return null;

  const callSessionId = String(input.callSessionId ?? "").trim();
  if (!callSessionId) {
    throw new Error("callSessionId is required");
  }

  const sql = `
    INSERT INTO voice.call_events (
      call_session_id,
      event_type,
      event_source,
      payload,
      occurred_at
    ) VALUES ($1::uuid, $2, $3, $4::jsonb, COALESCE($5::timestamptz, now()))
    RETURNING id::text AS id;
  `;

  const payload = input.payload && typeof input.payload === "object" ? input.payload : {};
  const values = [
    callSessionId,
    String(input.eventType ?? "").trim(),
    String(input.eventSource ?? "voice-bridge"),
    JSON.stringify(payload),
    input.occurredAt ?? null
  ];

  const result = await p.query(sql, values);
  return result.rows[0]?.id ?? null;
}

export async function insertCallTranscript(config, input) {
  const p = getPool(config);
  if (!p) return null;

  const callSessionId = String(input.callSessionId ?? "").trim();
  if (!callSessionId) {
    throw new Error("callSessionId is required");
  }

  const text = String(input.text ?? input.content ?? "").trim();
  if (!text) {
    throw new Error("transcript text is required");
  }

  const sequenceNumber = Number.isFinite(input.sequenceNumber)
    ? Math.max(1, Math.floor(input.sequenceNumber))
    : 1;
  const confidence = input.confidence === undefined ? null : input.confidence;
  const metadata = input.metadata && typeof input.metadata === "object" ? input.metadata : {};

  const sql = `
    INSERT INTO voice.call_transcripts (
      call_session_id,
      segment_index,
      sequence_number,
      speaker,
      content,
      text,
      language_code,
      confidence,
      is_final,
      recorded_at,
      metadata
    ) VALUES (
      $1::uuid,
      $2,
      $3,
      $4,
      $5,
      $6,
      $7,
      $8,
      $9,
      COALESCE($10::timestamptz, now()),
      $11::jsonb
    )
    RETURNING id::text AS id;
  `;

  const values = [
    callSessionId,
    sequenceNumber,
    sequenceNumber,
    String(input.speaker ?? "caller"),
    text,
    text,
    String(input.language ?? input.languageCode ?? ""),
    confidence,
    input.isFinal !== false,
    input.recordedAt ?? null,
    JSON.stringify(metadata)
  ];

  const result = await p.query(sql, values);
  return result.rows[0]?.id ?? null;
}

export async function insertVoiceLead(config, input) {
  const p = getPool(config);
  if (!p) return null;

  const callSessionId = String(input.callSessionId ?? "").trim();
  if (!callSessionId) {
    throw new Error("callSessionId is required");
  }

  const metadata = input.metadata && typeof input.metadata === "object" ? input.metadata : {};

  const sql = `
    INSERT INTO voice.leads (
      call_session_id,
      company_name,
      email,
      normalized_phone,
      normalized_domain,
      city,
      country,
      status,
      source,
      notes,
      metadata
    ) VALUES (
      $1::uuid,
      $2,
      $3,
      $4,
      $5,
      $6,
      $7,
      $8,
      $9,
      $10,
      $11::jsonb
    )
    RETURNING id::text AS id;
  `;

  const values = [
    callSessionId,
    String(input.companyName ?? ""),
    String(input.email ?? ""),
    String(input.normalizedPhone ?? ""),
    String(input.normalizedDomain ?? ""),
    String(input.city ?? ""),
    input.country ?? null,
    String(input.status ?? "new"),
    String(input.source ?? "voice"),
    String(input.notes ?? ""),
    JSON.stringify(metadata)
  ];

  const result = await p.query(sql, values);
  const leadId = result.rows[0]?.id ?? null;
  if (leadId) {
    await p.query(
      `
        UPDATE voice.call_sessions
        SET lead_id = $2::uuid,
            metadata = metadata || $3::jsonb,
            updated_at = now()
        WHERE id = $1::uuid;
      `,
      [
        callSessionId,
        leadId,
        JSON.stringify({
          lead_id: leadId,
          lead_created_by: "voice_bridge_reception_first"
        })
      ]
    );
  }
  return leadId;
}

export async function endCallSession(config, input) {
  const p = getPool(config);
  if (!p) return false;

  const callSessionId = String(input.callSessionId ?? "").trim();
  if (!callSessionId) {
    throw new Error("callSessionId is required");
  }

  const sql = `
    UPDATE voice.call_sessions
    SET
      status = $2,
      ended_at = now(),
      duration_seconds = $3,
      metadata = metadata || $4::jsonb,
      updated_at = now()
    WHERE id = $1::uuid
    RETURNING id::text AS id;
  `;

  const metadataPatch = input.metadataPatch && typeof input.metadataPatch === "object"
    ? input.metadataPatch
    : {};

  const values = [
    callSessionId,
    String(input.status ?? "completed"),
    input.durationSeconds ?? null,
    JSON.stringify(metadataPatch)
  ];

  const result = await p.query(sql, values);
  return Boolean(result.rowCount);
}

export async function getCallSessionSnapshot(config, callSessionId) {
  const p = getPool(config);
  if (!p) return null;
  const id = String(callSessionId ?? "").trim();
  if (!id) return null;

  const result = await p.query(
    `
      SELECT id::text AS id,
             external_call_id,
             status,
             caller_phone_raw,
             caller_phone_normalized,
             metadata,
             started_at,
             ended_at,
             duration_seconds
      FROM voice.call_sessions
      WHERE id = $1::uuid
      LIMIT 1;
    `,
    [id]
  );
  return result.rows[0] ?? null;
}

export async function listTurnTranscripts(config, callSessionId) {
  const p = getPool(config);
  if (!p) return [];
  const id = String(callSessionId ?? "").trim();
  if (!id) return [];

  const result = await p.query(
    `
      SELECT speaker,
             sequence_number,
             text,
             metadata,
             created_at
      FROM voice.call_transcripts
      WHERE call_session_id = $1::uuid
        AND metadata->>'transcript_scope' = 'turn'
      ORDER BY sequence_number ASC, created_at ASC;
    `,
    [id]
  );
  return result.rows ?? [];
}

export async function getLatestFullCallTranscript(config, callSessionId) {
  const p = getPool(config);
  if (!p) return null;
  const id = String(callSessionId ?? "").trim();
  if (!id) return null;

  const result = await p.query(
    `
      SELECT text,
             metadata,
             created_at
      FROM voice.call_transcripts
      WHERE call_session_id = $1::uuid
        AND metadata->>'transcript_scope' = 'full_call'
      ORDER BY created_at DESC
      LIMIT 1;
    `,
    [id]
  );
  return result.rows[0] ?? null;
}

export async function upsertCallSummary(config, input) {
  const p = getPool(config);
  if (!p) return null;

  const callSessionId = String(input.callSessionId ?? "").trim();
  if (!callSessionId) {
    throw new Error("callSessionId is required");
  }

  const summaryText = String(input.summaryText ?? "").trim();
  if (!summaryText) {
    throw new Error("summaryText is required");
  }

  const summaryType = String(input.summaryType ?? "auto").trim() || "auto";
  const model = String(input.model ?? "deterministic-post-call-v1");
  const metadata = input.metadata && typeof input.metadata === "object" ? input.metadata : {};

  const result = await p.query(
    `
      INSERT INTO voice.call_summaries (
        call_session_id,
        summary_text,
        summary_type,
        model,
        metadata
      ) VALUES ($1::uuid, $2, $3, $4, $5::jsonb)
      ON CONFLICT (call_session_id, summary_type)
      DO UPDATE SET
        summary_text = EXCLUDED.summary_text,
        model = EXCLUDED.model,
        metadata = EXCLUDED.metadata,
        updated_at = now()
      RETURNING id::text AS id;
    `,
    [callSessionId, summaryText, summaryType, model, JSON.stringify(metadata)]
  );

  return result.rows[0]?.id ?? null;
}

export async function getLeadByCallSessionId(config, callSessionId) {
  const p = getPool(config);
  if (!p) return null;
  const id = String(callSessionId ?? "").trim();
  if (!id) return null;

  const result = await p.query(
    `
      SELECT id::text AS id,
             call_session_id::text AS call_session_id,
             status,
             source,
             normalized_phone,
             metadata,
             created_at,
             updated_at
      FROM voice.leads
      WHERE call_session_id = $1::uuid
      ORDER BY created_at DESC
      LIMIT 1;
    `,
    [id]
  );
  return result.rows[0] ?? null;
}

export async function updateVoiceLead(config, input) {
  const p = getPool(config);
  if (!p) return null;

  const leadId = String(input.leadId ?? "").trim();
  if (!leadId) {
    throw new Error("leadId is required");
  }

  const metadataPatch = input.metadataPatch && typeof input.metadataPatch === "object"
    ? input.metadataPatch
    : {};

  const result = await p.query(
    `
      UPDATE voice.leads
      SET
        status = COALESCE($2, status),
        normalized_phone = CASE
          WHEN COALESCE($3, '') <> '' THEN $3
          ELSE normalized_phone
        END,
        metadata = metadata || $4::jsonb,
        notes = CASE
          WHEN COALESCE($5, '') <> '' THEN $5
          ELSE notes
        END,
        updated_at = now()
      WHERE id = $1::uuid
      RETURNING id::text AS id;
    `,
    [
      leadId,
      input.status ?? null,
      String(input.normalizedPhone ?? ""),
      JSON.stringify(metadataPatch),
      String(input.notes ?? "")
    ]
  );
  return result.rows[0]?.id ?? null;
}
