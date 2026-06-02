/**
 * In-process registry of active AudioSocket calls (Phase 10J shutdown hardening).
 */

const activeCalls = new Map();

function registryKey(ctx) {
  return String(ctx?.bridgeCallId ?? ctx?.callSessionId ?? "").trim() || null;
}

export function registerActiveCall(ctx, finishFn) {
  const key = registryKey(ctx);
  if (!key || typeof finishFn !== "function") return;
  activeCalls.set(key, { ctx, finish: finishFn, registeredAt: Date.now() });
  console.log(`[voice-bridge] active_call_registry_size=${activeCalls.size}`);
}

export function unregisterActiveCall(ctx) {
  const key = registryKey(ctx);
  if (!key) return;
  if (activeCalls.delete(key)) {
    console.log(`[voice-bridge] active_call_registry_size=${activeCalls.size}`);
  }
}

export function getActiveCallRegistrySize() {
  return activeCalls.size;
}

export function listActiveCalls() {
  return [...activeCalls.values()];
}

export function clearActiveCallRegistryForTests() {
  activeCalls.clear();
}
