/**
 * v4 quality event payload shape — DB insert helper lives in db.js.
 */

export function buildQualityEventInput({
  config,
  agentConfigResult = null,
  callSessionId = null,
  eventType,
  eventStage = null,
  metricName = null,
  metricValue = null,
  payload = {}
}) {
  const event_type = String(eventType ?? "").trim();
  if (!event_type) {
    throw new Error("eventType is required");
  }

  const tenantId = String(
    agentConfigResult?.config?.tenant_id ?? config?.v4?.tenantId ?? "technolohit"
  ).trim();
  const agentId = String(
    agentConfigResult?.config?.agent_id ?? config?.v4?.agentId ?? "main_voice_sales"
  ).trim();

  return {
    tenantId,
    agentId,
    callSessionId: callSessionId ? String(callSessionId).trim() : null,
    eventType: event_type,
    eventStage: eventStage ? String(eventStage).trim() : null,
    metricName: metricName ? String(metricName).trim() : null,
    metricValue: Number.isFinite(Number(metricValue)) ? Number(metricValue) : null,
    payload: payload && typeof payload === "object" ? payload : {}
  };
}

export function validateQualityEventInput(input) {
  const errors = [];
  if (!String(input?.eventType ?? "").trim()) errors.push("eventType required");
  if (!String(input?.tenantId ?? "").trim()) errors.push("tenantId required");
  if (!String(input?.agentId ?? "").trim()) errors.push("agentId required");
  return { ok: errors.length === 0, errors };
}
