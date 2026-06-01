-- v4 Phase 8: quality analytics queries (privacy-safe; no full phone output)
-- Table: voice.call_quality_events (migration 009_v4_call_quality_events.sql)
-- Apply migration before running these queries.

-- Recent call quality events (last 24h), tenant scoped
SELECT
  cqe.call_session_id,
  cqe.tenant_id,
  cqe.agent_id,
  cqe.event_type,
  cqe.event_stage,
  cqe.metric_name,
  cqe.metric_value,
  cqe.payload->>'runtime_version' AS runtime_version,
  cqe.payload->>'agent_config_version' AS agent_config_version,
  cqe.created_at
FROM voice.call_quality_events cqe
WHERE cqe.created_at >= now() - interval '24 hours'
  AND cqe.tenant_id = 'technolohit'
ORDER BY cqe.created_at DESC
LIMIT 200;

-- Slow calls: p95 STT latency per session (last 7 days)
SELECT
  call_session_id,
  tenant_id,
  agent_id,
  percentile_cont(0.95) WITHIN GROUP (ORDER BY metric_value) AS stt_p95_ms,
  count(*) AS stt_samples
FROM voice.call_quality_events
WHERE event_type IN ('stt_completed', 'stt_final')
  AND metric_name IN ('stt_ms', 'stt_final_ms')
  AND metric_value IS NOT NULL
  AND created_at >= now() - interval '7 days'
GROUP BY call_session_id, tenant_id, agent_id
HAVING percentile_cont(0.95) WITHIN GROUP (ORDER BY metric_value) > 800
ORDER BY stt_p95_ms DESC
LIMIT 50;

-- Failed RAG retrievals by reason (no transcript/phone fields)
SELECT
  date_trunc('hour', created_at) AS hour_bucket,
  tenant_id,
  agent_id,
  payload->>'fallback_reason' AS fallback_reason,
  count(*) AS failures
FROM voice.call_quality_events
WHERE event_type = 'rag_retrieval_failed'
  AND created_at >= now() - interval '7 days'
GROUP BY 1, 2, 3, 4
ORDER BY hour_bucket DESC, failures DESC;

-- STT/TTS error signals
SELECT
  event_type,
  tenant_id,
  agent_id,
  count(*) AS event_count
FROM voice.call_quality_events
WHERE event_type IN ('runtime_error', 'post_call_error', 'stt_completed', 'tts_completed')
  AND (
    event_type IN ('runtime_error', 'post_call_error')
    OR (payload->>'ok') = 'false'
  )
  AND created_at >= now() - interval '7 days'
GROUP BY 1, 2, 3
ORDER BY event_count DESC;

-- Barge-in cancel latency rollup
SELECT
  tenant_id,
  agent_id,
  round(avg(metric_value)::numeric, 2) AS avg_cancel_ms,
  round(max(metric_value)::numeric, 2) AS max_cancel_ms,
  count(*) AS samples
FROM voice.call_quality_events
WHERE event_type IN ('playback_cancelled', 'playback_cancel_requested')
  AND metric_name = 'cancel_latency_ms'
  AND metric_value IS NOT NULL
  AND created_at >= now() - interval '7 days'
GROUP BY tenant_id, agent_id
ORDER BY avg_cancel_ms DESC;

-- Lead created vs skipped by reason
SELECT
  event_type,
  payload->>'reason' AS lead_reason,
  payload->>'next_action' AS next_action,
  tenant_id,
  agent_id,
  count(*) AS event_count
FROM voice.call_quality_events
WHERE event_type IN ('lead_created', 'lead_skipped')
  AND created_at >= now() - interval '30 days'
GROUP BY 1, 2, 3, 4, 5
ORDER BY event_count DESC;

-- Per tenant/agent event volume (conversion proxy)
SELECT
  tenant_id,
  agent_id,
  payload->>'runtime_version' AS runtime_version,
  count(*) FILTER (WHERE event_type = 'call_started') AS calls_started,
  count(*) FILTER (WHERE event_type = 'audio_session_closed') AS calls_closed,
  count(*) FILTER (WHERE event_type = 'lead_created') AS leads_created,
  count(*) FILTER (WHERE event_type = 'lead_skipped') AS leads_skipped,
  count(*) FILTER (WHERE event_type = 'rag_retrieval_completed') AS rag_hits,
  count(*) FILTER (WHERE event_type = 'rag_retrieval_failed') AS rag_failures
FROM voice.call_quality_events
WHERE created_at >= now() - interval '30 days'
GROUP BY tenant_id, agent_id, payload->>'runtime_version'
ORDER BY calls_started DESC;

-- Drop-off proxy: sessions with turns but no close event
WITH turns AS (
  SELECT call_session_id, count(*) AS turn_events
  FROM voice.call_quality_events
  WHERE event_type = 'turn_started'
    AND created_at >= now() - interval '7 days'
  GROUP BY call_session_id
),
closed AS (
  SELECT DISTINCT call_session_id
  FROM voice.call_quality_events
  WHERE event_type = 'audio_session_closed'
    AND created_at >= now() - interval '7 days'
)
SELECT t.call_session_id, t.turn_events
FROM turns t
LEFT JOIN closed c ON c.call_session_id = t.call_session_id
WHERE c.call_session_id IS NULL
ORDER BY t.turn_events DESC
LIMIT 50;
