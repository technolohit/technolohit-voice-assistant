/**
 * Phase 0C spike: interruption context capture and dialogue recovery after playback cancel.
 * Active only when VOICE_V4_INTERRUPTION_CONTEXT_SPIKE_ENABLED=true.
 */

import { matchProductPolicyFromText, productPolicyById } from "./product-intake-policy.js";

const PRODUCT_SELECTION_INTENT = {
  smart_website: "product_selection_smart_website",
  aiseoq: "product_selection_aiseoq",
  botinteg: "product_selection_botinteg",
  lokalki: "product_selection_lokalki",
  voice_agent: "product_selection_voice_agent"
};

function normalize(text) {
  return String(text ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function spikeLogLabel(ctx, extra = "") {
  const bridge = ctx?.bridgeCallId ?? "pending";
  return `bridge_call_id=${bridge}${extra ? ` ${extra}` : ""}`;
}

export function isInterruptionContextSpikeEnabled(config) {
  return Boolean(config?.v4InterruptionContextSpike?.enabled);
}

export function detectProductIdFromCallerText(callerText) {
  const match = matchProductPolicyFromText(String(callerText ?? ""));
  if (!match?.key) return "";
  return match.key === "digital_assistant" ? "voice_agent" : match.key;
}

export function productSelectionIntentForId(productId) {
  return PRODUCT_SELECTION_INTENT[String(productId ?? "")] || "";
}

export function detectInterruptionSignals(callerText) {
  const lower = normalize(callerText);
  const stopSignal = /\b(stopp|stop|abbrechen|neues thema|anderes produkt|falsch|nicht das|ich meine|ich meinte|ich wollte|meinte ich)\b/i.test(
    lower
  );
  const productQuestion = /\b(was ist|was sind|erklar|erklaer|erklaren|erzaehl|erzahlen|kurz erkl|mehr uber|mehr ueber|details zu|wie funktioniert)\b/i.test(
    lower
  );
  return { stopSignal, productQuestion };
}

export function buildInterruptionContext(config, ctx, info = {}) {
  const productState = info.productState ?? {};
  return {
    recordedAt: Date.now(),
    turnIndex: info.turnIndex ?? null,
    label: info.session?.label ?? info.label ?? "assistant response",
    assistantText: String(info.assistantText ?? "").replace(/\s+/g, " ").trim().slice(0, 500),
    cancellationReason: info.session?.cancelReason ?? info.cancellationReason ?? "unknown",
    framesSentBeforeCancel: Number(info.session?.framesSent ?? info.framesSentBeforeCancel ?? 0),
    cancelLatencyMs:
      info.session?.cancelLatencyMs ?? info.cancelLatencyMs ?? null,
    interruptedProductId: productState.selectedProduct ?? null,
    interruptedProductName: productState.selectedProductName ?? null,
    interruptedSalesStage: productState.productDialogueState ?? null,
    pendingCallerTurn: true
  };
}

export function recordInterruptionContext(ctx, context) {
  if (!context || typeof context !== "object") return;
  ctx.pendingInterruptionContext = context;
}

export function getPendingInterruptionContext(ctx) {
  return ctx?.pendingInterruptionContext ?? null;
}

export function clearPendingInterruptionContext(ctx) {
  if (ctx) ctx.pendingInterruptionContext = null;
}

export function repairProductStateForSwitch(productState, productId) {
  if (!productState || !productId) return productState;
  const policy = productPolicyById(productId === "voice_agent" ? "digital_assistant" : productId);
  productState.overviewOffered = true;
  productState.awaitingSelection = false;
  productState.awaitingInterestConfirmation = true;
  productState.selectedProduct = productId;
  productState.selectedProductName = policy?.displayName || productId;
  productState.productDialogueState = "sales_customer_type";
  productState.handoffChoice = "none";
  productState.botintegFollowupResolved = productId !== "botinteg";
  productState.botintegFollowupRetryCount = 0;
  productState.customerType = null;
  productState.salesNeedCaptured = false;
  productState.salesContext = {};
  productState.lastProductIntent = productSelectionIntentForId(productId);
  return productState;
}

export function resolveInterruptedProductTarget(callerText, productState, signals = {}) {
  const detected = detectProductIdFromCallerText(callerText);
  if (detected && detected !== productState?.selectedProduct) {
    return detected;
  }
  if (signals.stopSignal && detected) {
    return detected;
  }
  return "";
}

export function applyInterruptionTurnRepair({ config, ctx, callerText, productState, analysis }) {
  if (!isInterruptionContextSpikeEnabled(config)) {
    return { analysis, repaired: false };
  }

  const pending = getPendingInterruptionContext(ctx);
  if (!pending?.pendingCallerTurn) {
    return { analysis, repaired: false };
  }

  pending.pendingCallerTurn = false;
  pending.resolvedAt = Date.now();

  const signals = detectInterruptionSignals(callerText);
  const targetProductId = resolveInterruptedProductTarget(callerText, productState, signals);

  if (targetProductId) {
    repairProductStateForSwitch(productState, targetProductId);
    const forcedIntent = productSelectionIntentForId(targetProductId);
    ctx._interruptionRecovery = {
      switchToProductId: targetProductId,
      forcedIntent,
      action: "product_switch"
    };

    console.log(
      `[v4-interruption-spike] interruption_product_switch ${spikeLogLabel(ctx, `from_product=${pending.interruptedProductId ?? "none"} to_product=${targetProductId} turn_index=${pending.turnIndex ?? "unknown"} cancel_latency_ms=${pending.cancelLatencyMs ?? "unknown"}`)}`
    );

    return {
      analysis: {
        ...analysis,
        detectedIntent: forcedIntent,
        normalizedIntent: forcedIntent,
        transcriptQuality: "clear",
        transcriptQualityReason: "interruption_product_switch"
      },
      repaired: true,
      action: "product_switch",
      targetProductId
    };
  }

  if (signals.stopSignal) {
    productState.awaitingInterestConfirmation = false;
    productState.productDialogueState = "idle";
    productState.awaitingSelection = false;
    ctx._interruptionRecovery = { action: "topic_reset" };

    console.log(
      `[v4-interruption-spike] interruption_topic_reset ${spikeLogLabel(ctx, `interrupted_product=${pending.interruptedProductId ?? "none"} turn_index=${pending.turnIndex ?? "unknown"}`)}`
    );

    return {
      analysis: {
        ...analysis,
        transcriptQuality: analysis?.transcriptQuality ?? "clear",
        transcriptQualityReason: "interruption_topic_reset"
      },
      repaired: true,
      action: "topic_reset"
    };
  }

  console.log(
    `[v4-interruption-spike] interruption_context_consumed ${spikeLogLabel(ctx, `interrupted_product=${pending.interruptedProductId ?? "none"} turn_index=${pending.turnIndex ?? "unknown"} action=continue_with_caller_query`)}`
  );

  ctx._interruptionRecovery = { action: "continue_caller_query" };
  return { analysis, repaired: true, action: "continue_caller_query" };
}

export function logInterruptionRecorded(config, ctx, context) {
  if (!isInterruptionContextSpikeEnabled(config)) return;
  console.log(
    `[v4-interruption-spike] interruption_recorded ${spikeLogLabel(ctx, `turn_index=${context.turnIndex ?? "unknown"} interrupted_product=${context.interruptedProductId ?? "none"} sales_stage=${context.interruptedSalesStage ?? "none"} cancellation_reason=${context.cancellationReason ?? "unknown"} frames_sent_before_cancel=${context.framesSentBeforeCancel ?? 0} cancel_latency_ms=${context.cancelLatencyMs ?? "unknown"}`)}`
  );
}

export function resolveRagProductId({ config, ctx, callerText, productState }) {
  if (!isInterruptionContextSpikeEnabled(config)) {
    return productState?.selectedProduct ?? "";
  }
  const fromCaller = detectProductIdFromCallerText(callerText);
  if (fromCaller) return fromCaller;
  return productState?.selectedProduct ?? "";
}
