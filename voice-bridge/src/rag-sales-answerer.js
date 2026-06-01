/**
 * Grounded RAG sales answerer with deterministic playbook fail-closed fallback.
 */

import { retrieveRagContext } from "./rag-client.js";
import { buildSalesProductExplanation, salesPlaybookByProduct } from "./sales-policy.js";
import {
  detectProductIdFromCallerText,
  isInterruptionContextSpikeEnabled
} from "./interruption-recovery.js";

const PRICE_PATTERN = /\b(preis|kosten|euro|€|garantie|garantiert|implementierung in \d)\b/i;
const GUARANTEE_PATTERN = /\b(garantie|garantiert|100\s*%|ranking.?garantie)\b/i;

function normalize(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

function firstQualifyingQuestion(productId) {
  const playbook = salesPlaybookByProduct(productId);
  const questions = Array.isArray(playbook?.qualifying_questions) ? playbook.qualifying_questions : [];
  return questions[0] || "Was ist bei Ihnen gerade das wichtigste Ziel?";
}

function safetyScan(text) {
  const normalized = normalize(text);
  return {
    contains_price_claim: PRICE_PATTERN.test(normalized),
    contains_guarantee: GUARANTEE_PATTERN.test(normalized),
    contains_private_data: /\b\d{6,}\b/.test(normalized)
  };
}

function trimForVoice(text, maxChars = 220) {
  const base = normalize(text);
  if (base.length <= maxChars) return base;
  const slice = base.slice(0, maxChars);
  const lastSpace = slice.lastIndexOf(" ");
  return `${(lastSpace > 80 ? slice.slice(0, lastSpace) : slice).trim()}?`;
}

function playbookFallback(productId, callerText) {
  const explanation = buildSalesProductExplanation(productId);
  const nextQuestion = firstQualifyingQuestion(productId);
  const answer = explanation || "Gerne erkläre ich das kurz.";
  return {
    answer: trimForVoice(answer),
    next_question: nextQuestion,
    used_rag: false,
    confidence: "medium",
    safety: safetyScan(`${answer} ${nextQuestion}`),
    fallback_reason: "playbook"
  };
}

function buildAnswerFromRagChunks(productId, ragData) {
  const chunks = Array.isArray(ragData?.answer_context) ? ragData.answer_context : [];
  if (!chunks.length) return null;
  const top = chunks[0];
  const snippet = normalize(top?.snippet || top?.text || "");
  if (!snippet) return null;
  const explanation = trimForVoice(snippet, 180);
  return {
    answer: explanation,
    next_question: firstQualifyingQuestion(productId),
    used_rag: true,
    confidence: "high",
    safety: safetyScan(explanation),
    fallback_reason: null
  };
}

export function isRagSalesAnswererEnabled(config) {
  if (!config?.rag?.enabled) return false;
  if (!config?.rag?.salesAnswererEnabled) return false;
  if (config?.rag?.qaMode && !config?.assistant?.qaTextMode) return false;
  return true;
}

/**
 * Answer a product question using RAG when enabled; otherwise approved playbook text.
 */
export async function answerProductQuestionWithRag({
  config,
  callerText,
  productId,
  dialogueSummary = ""
}) {
  const callerProductId = detectProductIdFromCallerText(callerText);
  const effectiveProductId =
    isInterruptionContextSpikeEnabled(config) && callerProductId ? callerProductId : productId;
  const fallback = playbookFallback(effectiveProductId, callerText);

  if (!isRagSalesAnswererEnabled(config)) {
    return { ...fallback, confidence: "medium" };
  }

  const apiUrl = String(config?.rag?.apiUrl || "").trim();
  if (!apiUrl) {
    return { ...fallback, fallback_reason: "rag_api_url_missing" };
  }

  const timeoutMs = config?.rag?.qaMode
    ? Number(config?.rag?.qaTimeoutMs || config?.rag?.timeoutMs || 1200)
    : Number(config?.rag?.timeoutMs || 700);

  const ragResult = await retrieveRagContext(config, {
    query: normalize(callerText),
    product: productId,
    dialogue_summary: normalize(dialogueSummary).slice(0, 400),
    timeoutMs
  });

  if (!ragResult.ok || !ragResult.hit) {
    return {
      ...fallback,
      fallback_reason: ragResult.reason || "rag_miss",
      confidence: "low"
    };
  }

  const built = buildAnswerFromRagChunks(productId, ragResult.data);
  if (!built) {
    return { ...fallback, fallback_reason: "rag_empty" };
  }

  if (built.safety.contains_price_claim || built.safety.contains_guarantee) {
    return { ...fallback, fallback_reason: "rag_safety_reject" };
  }

  return built;
}

export function validateRagSalesAnswer(result) {
  if (!result || typeof result !== "object") throw new Error("rag sales answer: invalid result");
  if (!result.answer) throw new Error("rag sales answer: answer required");
  if (!result.next_question) throw new Error("rag sales answer: next_question required");
}
