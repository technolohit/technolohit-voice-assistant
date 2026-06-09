export function runtimeRetrieveTimeoutMs(config) {
  return Math.max(100, Number(config?.rag?.retrieveTimeoutMs ?? config?.rag?.timeoutMs ?? 700));
}

export function runtimeRetrieveMaxAttempts(config) {
  return Math.max(1, Math.min(5, Number(config?.rag?.retrieveMaxAttempts ?? 3)));
}
