/**
 * v4 call session memory — Phase 1 placeholder interface.
 */

export function createCallSessionMemory({ bridgeCallId, tenantId = "technolohit", agentId = "main_voice_sales" }) {
  return {
    bridgeCallId: String(bridgeCallId ?? "pending"),
    tenantId,
    agentId,
    turnIndex: 0,
    selectedProductId: null,
    salesStage: null,
    pendingInterruption: null,
    phase: "phase1_stub"
  };
}

export function advanceTurn(memory) {
  return {
    ...memory,
    turnIndex: Number(memory?.turnIndex ?? 0) + 1
  };
}

export function setSelectedProduct(memory, productId) {
  return {
    ...memory,
    selectedProductId: productId ? String(productId) : null
  };
}
