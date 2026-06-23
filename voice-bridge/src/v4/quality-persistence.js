/**
 * v4 quality event persistence — DB insert wrapper (v4 path only, fail-safe).
 */

import { insertCallQualityEvent, isDbConfigured } from "../db.js";
import { buildPersistMetadata } from "./persist-metadata.js";
import { redactQualityPayload, validateQualityEventInput } from "./quality-events.js";
import { buildCallQualitySummary } from "./quality-analytics.js";
import { assertNoRawPhoneInPayload } from "./privacy-sanitize.js";

export function enrichQualityEventForPersistence(event, { persistMetadata = null, config = null, agentConfig = null } = {}) {
  const meta =
    persistMetadata ??
    buildPersistMetadata(config ?? {}, agentConfig?.ok ? agentConfig : agentConfig ?? null);

  const payload = redactQualityPayload({
    ...(event?.payload && typeof event.payload === "object" ? event.payload : {}),
    runtime_version: meta.runtime_version ?? null,
    agent_config_version: meta.agent_config_version ?? null,
    prompt_playbook_version: meta.prompt_playbook_version ?? null,
    agent_config_playbook_version: meta.agent_config_playbook_version ?? meta.prompt_playbook_version ?? null,
    knowledge_version: meta.knowledge_version ?? null,
    playbook_version: meta.playbook_version ?? null,
    playbook_binding_version: meta.playbook_binding_version ?? null,
    playbook_source: meta.playbook_source ?? null,
    playbook_provenance_ok: meta.playbook_provenance_ok ?? null,
    playbook_provenance_reason: meta.playbook_provenance_reason ?? null,
  });

  return {
    tenantId: String(event?.tenantId ?? meta.tenant_id ?? "technolohit").trim(),
    agentId: String(event?.agentId ?? meta.agent_id ?? "main_voice_sales").trim(),
    callSessionId: event?.callSessionId ?? null,
    eventType: String(event?.eventType ?? "").trim(),
    eventStage: event?.eventStage ?? null,
    metricName: event?.metricName ?? null,
    metricValue: Number.isFinite(Number(event?.metricValue)) ? Number(event.metricValue) : null,
    payload
  };
}

export function createDbQualityEventInsertFn(config, options = {}) {
  return async function insertQualityEvent(event) {
    if (!isDbConfigured(config)) {
      return { ok: false, reason: "db_disabled" };
    }

    const enriched = enrichQualityEventForPersistence(event, options);
    const validation = validateQualityEventInput(enriched);
    if (!validation.ok) {
      return { ok: false, reason: "validation_failed", errors: validation.errors };
    }
    if (!assertNoRawPhoneInPayload(enriched.payload)) {
      return { ok: false, reason: "privacy_guard_blocked_raw_phone" };
    }

    try {
      const id = await insertCallQualityEvent(config, enriched);
      return id
        ? { ok: true, id, reason: "inserted" }
        : { ok: false, reason: "insert_returned_null" };
    } catch (err) {
      return {
        ok: false,
        reason: "db_error",
        error: String(err?.message ?? err ?? "db_error")
      };
    }
  };
}

export async function flushOrchestratorQualityEvents(orchestrator, options = {}) {
  const sink = orchestrator?.qualitySink;
  if (!sink || typeof sink.flushQualityEvents !== "function") {
    return { ok: false, reason: "quality_sink_missing", flushed: 0, failed: 0, events: [] };
  }

  if (!orchestrator.v4PathActive && !options.forceV4) {
    return { ok: false, reason: "v3_path_no_flush", flushed: 0, failed: 0, events: [] };
  }

  const persistMetadata =
    options.persistMetadata ??
    orchestrator.persistMetadata ??
    orchestrator.runtimeContext?.persistMetadata ??
    buildPersistMetadata(orchestrator.config ?? {}, orchestrator.agentConfig, orchestrator.behaviorPolicy);

  const preFlushEvents = sink.getBufferedQualityEvents?.() ?? [];

  const flushResult = await sink.flushQualityEvents({
    v4PathActive: true,
    persistMetadata,
    config: orchestrator.config,
    agentConfig: orchestrator.agentConfig,
    onInsertError: options.onInsertError ?? null
  });

  const events = flushResult.events ?? preFlushEvents;
  const summary = buildCallQualitySummary(events, {
    persistMetadata,
    postCallMetadata: options.v4PostCallMetadata ?? orchestrator.postCallHandoff?.summaryMetadata ?? null
  });

  return {
    ...flushResult,
    events,
    summary
  };
}
