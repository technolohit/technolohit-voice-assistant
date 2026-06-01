import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";
import {
  applyInterruptionTurnRepair,
  buildInterruptionContext,
  detectInterruptionSignals,
  detectProductIdFromCallerText,
  isInterruptionContextSpikeEnabled,
  recordInterruptionContext,
  repairProductStateForSwitch
} from "../src/interruption-recovery.js";
import { answerProductQuestionWithRag } from "../src/rag-sales-answerer.js";
import { processTextTurn, createQaDialogueContext } from "../src/turn-assistant.js";

function spikeConfig(overrides = {}) {
  return {
    assistant: {
      minTranscriptChars: 5,
      maxResponseChars: 220,
      maxResponseSentences: 3
    },
    semanticIntent: { enabled: true, mode: "deterministic", minAccept: 0.75, minSoft: 0.45 },
    conversationRepair: { enabled: true },
    rag: { enabled: false, salesAnswererEnabled: false },
    v4InterruptionContextSpike: { enabled: true },
    ...overrides
  };
}

function productState(productId, stage = "sales_customer_type") {
  return {
    overviewOffered: true,
    awaitingSelection: false,
    awaitingInterestConfirmation: true,
    selectedProduct: productId,
    selectedProductName: productId,
    productDialogueState: stage,
    handoffChoice: "none",
    botintegFollowupResolved: true,
    botintegFollowupRetryCount: 0,
    customerType: null,
    salesNeedCaptured: false,
    salesContext: {},
    lastProductIntent: null,
    lastProductTurnIndex: null
  };
}

function qaState(ctx, product) {
  return {
    ctx,
    assistantTurn: {
      started: true,
      completed: false,
      currentTurnIndex: 1,
      history: [],
      clarificationAsked: false,
      unknownIntentCount: 0,
      intake: {
        contactPreferenceAsked: false,
        waitingFor: null,
        closingPending: false
      },
      product
    }
  };
}

test("loadConfig defaults interruption context spike to disabled", () => {
  const prev = process.env.VOICE_V4_INTERRUPTION_CONTEXT_SPIKE_ENABLED;
  delete process.env.VOICE_V4_INTERRUPTION_CONTEXT_SPIKE_ENABLED;
  const config = loadConfig();
  assert.equal(config.v4InterruptionContextSpike.enabled, false);
  if (prev === undefined) {
    delete process.env.VOICE_V4_INTERRUPTION_CONTEXT_SPIKE_ENABLED;
  } else {
    process.env.VOICE_V4_INTERRUPTION_CONTEXT_SPIKE_ENABLED = prev;
  }
});

test("detectProductIdFromCallerText maps Smart Website and Voice Assistant", () => {
  assert.equal(detectProductIdFromCallerText("Erzählen Sie mir bitte über Smart Website"), "smart_website");
  assert.equal(detectProductIdFromCallerText("Was ist der AI Voice Assistant?"), "voice_agent");
});

test("applyInterruptionTurnRepair switches product after pending interruption", () => {
  const config = spikeConfig();
  const ctx = createQaDialogueContext();
  const product = productState("voice_agent");
  recordInterruptionContext(
    ctx,
    buildInterruptionContext(config, ctx, {
      turnIndex: 2,
      assistantText: "Die digitale Rezeption nimmt Anrufe an...",
      productState: product,
      cancellationReason: "inbound_speech_detected",
      cancelLatencyMs: 12
    })
  );

  const repair = applyInterruptionTurnRepair({
    config,
    ctx,
    callerText: "Erzählen Sie mir bitte über Smart Website",
    productState: product,
    analysis: { detectedIntent: "unknown", transcriptQuality: "clear" }
  });

  assert.equal(repair.repaired, true);
  assert.equal(repair.action, "product_switch");
  assert.equal(product.selectedProduct, "smart_website");
  assert.equal(repair.analysis.detectedIntent, "product_selection_smart_website");
});

test("processTextTurn after interruption answers Smart Website not Digitale Rezeption", async () => {
  const config = spikeConfig();
  const ctx = createQaDialogueContext();
  const product = productState("voice_agent");
  recordInterruptionContext(
    ctx,
    buildInterruptionContext(config, ctx, {
      turnIndex: 2,
      assistantText: "Die digitale Rezeption nimmt Anrufe an...",
      productState: product,
      cancellationReason: "inbound_speech_detected"
    })
  );

  const result = await processTextTurn({
    state: qaState(ctx, product),
    transcript: "Erzählen Sie mir bitte über Smart Website",
    config,
    turnIndex: 3
  });

  assert.match(result.responseText, /Smart Website|Website/i);
  assert.doesNotMatch(result.responseText, /Digitale Rezeption|Telefonassistent/i);
  assert.equal(result.nextState.product.selectedProduct, "smart_website");
});

test("processTextTurn after interruption switches from Smart Website to Voice Assistant", async () => {
  const config = spikeConfig();
  const ctx = createQaDialogueContext();
  const product = productState("smart_website");
  recordInterruptionContext(
    ctx,
    buildInterruptionContext(config, ctx, {
      turnIndex: 2,
      assistantText: "Eine Smart Website verbindet moderne Website...",
      productState: product,
      cancellationReason: "inbound_speech_detected"
    })
  );

  const result = await processTextTurn({
    state: qaState(ctx, product),
    transcript: "Und was ist der AI Voice Assistant?",
    config,
    turnIndex: 3
  });

  assert.match(result.responseText, /Telefonassistent|Voice|Rezeption|Assistent/i);
  assert.equal(result.nextState.product.selectedProduct, "voice_agent");
});

test("processTextTurn handles Stopp ich meine product repair", async () => {
  const config = spikeConfig();
  const ctx = createQaDialogueContext();
  const product = productState("voice_agent");
  recordInterruptionContext(
    ctx,
    buildInterruptionContext(config, ctx, {
      turnIndex: 2,
      assistantText: "Die digitale Rezeption...",
      productState: product,
      cancellationReason: "inbound_speech_detected"
    })
  );

  const result = await processTextTurn({
    state: qaState(ctx, product),
    transcript: "Stopp, ich meine Smart Website",
    config,
    turnIndex: 3
  });

  assert.equal(result.nextState.product.selectedProduct, "smart_website");
  assert.match(result.responseText, /Smart Website|Website/i);
});

test("interruption repair is inactive when spike flag is off", () => {
  const config = spikeConfig({ v4InterruptionContextSpike: { enabled: false } });
  const ctx = createQaDialogueContext();
  const product = productState("voice_agent");
  recordInterruptionContext(
    ctx,
    buildInterruptionContext(config, ctx, { turnIndex: 2, productState: product })
  );

  const repair = applyInterruptionTurnRepair({
    config,
    ctx,
    callerText: "Smart Website bitte",
    productState: product,
    analysis: { detectedIntent: "unknown", transcriptQuality: "clear" }
  });

  assert.equal(repair.repaired, false);
  assert.equal(product.selectedProduct, "voice_agent");
});

test("answerProductQuestionWithRag uses caller product when spike enabled", async () => {
  const config = spikeConfig({ rag: { enabled: false, salesAnswererEnabled: false } });
  const voiceFallback = await answerProductQuestionWithRag({
    config,
    callerText: "Was ist Smart Website?",
    productId: "voice_agent"
  });
  assert.match(voiceFallback.answer, /Smart Website|Website/i);
  assert.doesNotMatch(voiceFallback.answer, /Digitale Rezeption/i);
});

test("detectInterruptionSignals recognizes stop repair phrase", () => {
  const signals = detectInterruptionSignals("Stopp, ich meine Botinteg");
  assert.equal(signals.stopSignal, true);
});

test("repairProductStateForSwitch resets sales context", () => {
  const product = productState("voice_agent", "sales_need_discovery");
  product.customerType = "new_prospect";
  product.salesNeedCaptured = true;
  repairProductStateForSwitch(product, "botinteg");
  assert.equal(product.selectedProduct, "botinteg");
  assert.equal(product.productDialogueState, "sales_customer_type");
  assert.equal(product.customerType, null);
  assert.equal(product.salesNeedCaptured, false);
});
