import {
  sanitizeOutboundObject,
  buildPostCallIdempotencyKey,
  assertNoRawPhoneInPayload
} from "./v4/privacy-sanitize.js";

function normalizeText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function notificationPayload(ctx, summary, leadResult) {
  const metadata = summary?.metadata && typeof summary.metadata === "object" ? summary.metadata : {};
  return sanitizeOutboundObject({
    type: "voice_post_call_outcome_v1",
    occurred_at: new Date().toISOString(),
    call_session_id: ctx.callSessionId ?? "",
    external_call_id: ctx.externalCallId ?? "",
    bridge_call_id: ctx.bridgeCallId ?? "",
    idempotency_key: buildPostCallIdempotencyKey(ctx, summary, leadResult),
    summary: {
      id: summary?.summaryId ?? "",
      text: summary?.summaryText ?? "",
      product_interest: metadata.product_interest ?? "",
      caller_need: metadata.caller_need ?? "",
      contact_preference: metadata.contact_preference ?? "",
      permission: metadata.permission ?? "",
      next_action: metadata.next_action ?? "",
      confidence: metadata.confidence ?? "",
      transcript_quality_notes: metadata.transcript_quality_notes ?? "",
      tenant_id: metadata.tenant_id ?? "",
      agent_id: metadata.agent_id ?? "",
      runtime_version: metadata.runtime_version ?? ""
    },
    lead: {
      action: leadResult?.action ?? "skipped",
      reason: leadResult?.reason ?? "unknown",
      lead_id: leadResult?.leadId ?? ""
    }
  });
}

export async function sendPostCallNotification(config, ctx, summary, leadResult) {
  if (!config?.postCallNotify?.enabled) {
    return { action: "skipped", reason: "feature_disabled", statusCode: null, url: "", error: "" };
  }

  const url = normalizeText(config?.postCallNotify?.webhookUrl);
  if (!url) {
    return { action: "skipped", reason: "missing_webhook_url", statusCode: null, url: "", error: "" };
  }

  const timeoutMs = Number(config?.postCallNotify?.timeoutMs ?? 8000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const payload = notificationPayload(ctx, summary, leadResult);
    if (!assertNoRawPhoneInPayload(payload)) {
      return {
        action: "skipped",
        reason: "privacy_guard_blocked_raw_phone",
        statusCode: null,
        url,
        error: "raw_phone_detected"
      };
    }

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    if (!response.ok) {
      return {
        action: "failed",
        reason: `http_${response.status}`,
        statusCode: response.status,
        url,
        error: ""
      };
    }

    return {
      action: "sent",
      reason: "ok",
      statusCode: response.status,
      url,
      error: ""
    };
  } catch (err) {
    const errorText =
      err?.name === "AbortError" ? "timeout" : normalizeText(err?.message || err || "unknown_error");
    return {
      action: "failed",
      reason: errorText,
      statusCode: null,
      url,
      error: errorText
    };
  } finally {
    clearTimeout(timer);
  }
}

export { notificationPayload };
