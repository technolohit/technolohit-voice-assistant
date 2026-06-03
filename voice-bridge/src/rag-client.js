function normalizeUrl(baseUrl, path) {
  const base = String(baseUrl || "").trim().replace(/\/+$/, "");
  if (!base) return "";
  return `${base}${path}`;
}

export async function retrieveRagContext(config, payload) {
  const apiUrl = String(config?.rag?.apiUrl || "").trim();
  if (!apiUrl) {
    return { ok: false, reason: "rag_api_url_missing" };
  }

  const requestedTimeoutMs = Number(payload?.timeoutMs);
  const timeoutMs = Math.max(100, Number.isFinite(requestedTimeoutMs) ? requestedTimeoutMs : Number(config?.rag?.timeoutMs || 700));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();

  try {
    const response = await fetch(normalizeUrl(apiUrl, "/v1/retrieve"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    const latencyMs = Math.max(0, Date.now() - startedAt);
    if (!response.ok) {
      return { ok: false, reason: `http_${response.status}`, latencyMs };
    }

    const json = await response.json();
    const answerContext = Array.isArray(json?.answer_context) ? json.answer_context : [];
    const topScore = answerContext.length ? Number(answerContext[0]?.score ?? NaN) : NaN;
    return {
      ok: true,
      status: response.status,
      data: json,
      latencyMs,
      hit: Boolean(json?.hit),
      hitCount: answerContext.length,
      topScore: Number.isFinite(topScore) ? topScore : null,
      topSource: answerContext.length ? String(answerContext[0]?.source_uri || "") : "",
      topTitle: answerContext.length ? String(answerContext[0]?.title || "") : ""
    };
  } catch (err) {
    const latencyMs = Math.max(0, Date.now() - startedAt);
    const reason = err?.name === "AbortError" ? "timeout" : "request_failed";
    return { ok: false, reason, latencyMs };
  } finally {
    clearTimeout(timeout);
  }
}

export async function checkRagApiHealth(config, { timeoutMs = 500, fetchImpl = fetch } = {}) {
  const apiUrl = String(config?.rag?.apiUrl || "").trim();
  if (!apiUrl) {
    return { ok: false, reason: "rag_api_url_missing", latencyMs: null };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(100, Number(timeoutMs) || 500));
  const startedAt = Date.now();
  try {
    const response = await fetchImpl(normalizeUrl(apiUrl, "/healthz"), {
      method: "GET",
      signal: controller.signal
    });
    return {
      ok: response.ok,
      reason: response.ok ? "ok" : `http_${response.status}`,
      latencyMs: Math.max(0, Date.now() - startedAt)
    };
  } catch (err) {
    return {
      ok: false,
      reason: err?.name === "AbortError" ? "timeout" : "request_failed",
      latencyMs: Math.max(0, Date.now() - startedAt)
    };
  } finally {
    clearTimeout(timeout);
  }
}
