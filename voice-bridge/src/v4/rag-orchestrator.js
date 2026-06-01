/**
 * v4 RAG orchestration — bounded product/sales Q&A for canary dialogue runtime.
 * Fail-closed; never creates leads or validates contact/permission.
 */

import { retrieveRagContext } from "../rag-client.js";
import { buildSalesProductExplanation, salesPlaybookByProduct } from "../sales-policy.js";
import {
  buildRagRetrievePayload,
  resolveDocumentedRagBaseUrl,
  V4_RAG_HOST_LOCAL_BASE_URL
} from "./rag-scope.js";
import { V4_STATES } from "./state-machine.js";
import { getForbiddenClaims, getProductById } from "./agent-config.js";
import { summarizeMemoryForPrompt } from "./call-session-memory.js";
import { redactPhoneLikeText, normalizeText } from "./redaction.js";
import { detectTranscriptIntent, sanitizeResponseText } from "./response-planner.js";
import { ragAnswerMustNotCreateLead } from "./lead-validator.js";

const MAX_ANSWER_CHARS = 220;
const PHONE_IN_TEXT = /\b(\+?\d[\d\s\-()/]{5,}\d)\b/;
const GUARANTEE_PATTERN = /\b(garantie|garantiert|100\s*%|ranking.?garantie)\b|garantie|100\s*%/i;

export { V4_RAG_HOST_LOCAL_BASE_URL };

export const V4_RAG_ALLOWED_STATES = new Set([
  V4_STATES.ANSWERING_PRODUCT_QUESTION,
  V4_STATES.COLLECTING_SALES_CONTEXT,
  V4_STATES.THINKING,
  V4_STATES.LISTENING
]);

export const V4_RAG_FORBIDDEN_STATES = new Set([
  V4_STATES.COLLECTING_CONTACT_PREFERENCE,
  V4_STATES.COLLECTING_CALLBACK_PERMISSION,
  V4_STATES.CLOSING,
  V4_STATES.COMPLETED,
  V4_STATES.GREETING,
  V4_STATES.IDLE
]);

export function isPricingOrProductQuestion(transcript = "", intent = null) {
  const resolved = intent ?? detectTranscriptIntent(transcript);
  if (resolved === "product_question") return true;
  const lower = normalizeText(transcript).toLowerCase();
  return /\b(preis|kosten|was kostet|pricing|tarif|gebühr|gebuehr)\b/i.test(lower);
}

export function isPostContactProductQuestion(memory = {}, transcript = "", intent = null) {
  if (!memory?.contact_preference) return false;
  return isPricingOrProductQuestion(transcript, intent);
}

export function shouldUseRagForTurn({ state, intent, memory = {}, transcript = "" } = {}) {
  const resolvedState = String(state ?? memory?.current_state ?? "").trim();
  const resolvedIntent = intent ?? detectTranscriptIntent(transcript, memory);

  if (V4_RAG_FORBIDDEN_STATES.has(resolvedState)) {
    return { allowed: false, reason: "forbidden_state", state: resolvedState };
  }

  if (resolvedState === V4_STATES.LEAD_READY && !isPricingOrProductQuestion(transcript, resolvedIntent)) {
    return { allowed: false, reason: "lead_ready_non_product_question" };
  }

  if (
    resolvedState === V4_STATES.VALIDATING_CONTACT &&
    !isPostContactProductQuestion(memory, transcript, resolvedIntent)
  ) {
    return { allowed: false, reason: "validating_contact_non_product_question" };
  }

  if (isPostContactProductQuestion(memory, transcript, resolvedIntent)) {
    return { allowed: true, reason: "post_contact_product_or_pricing" };
  }

  if (V4_RAG_ALLOWED_STATES.has(resolvedState) && isPricingOrProductQuestion(transcript, resolvedIntent)) {
    return { allowed: true, reason: "allowed_state_product_question" };
  }

  if (resolvedState === V4_STATES.ANSWERING_PRODUCT_QUESTION) {
    return { allowed: true, reason: "answering_product_question" };
  }

  return { allowed: false, reason: "rag_not_applicable" };
}

export function buildV4RagQuery({
  config,
  agentConfig = null,
  transcript = "",
  memory = {},
  stateMachine = {},
  purpose = "sales_qa"
} = {}) {
  const query = redactPhoneLikeText(normalizeText(transcript));
  if (!query) {
    throw new Error("transcript required for v4 RAG query");
  }

  const summary = summarizeMemoryForPrompt(memory);
  const productId = memory?.selected_product_id ?? memory?.product_interest ?? null;
  const state = stateMachine?.state ?? memory?.current_state ?? null;

  return buildRagRetrievePayload(
    config,
    {
      query,
      purpose,
      language: config?.transcription?.language ?? "de",
      context: {
        source: "rag_sales_answerer",
        product: productId,
        current_state: state,
        customer_type: summary.customer_type ?? null,
        dialogue_summary: JSON.stringify({
          customer_type: summary.customer_type,
          selected_product_id: summary.selected_product_id,
          contact_preference: summary.contact_preference,
          has_interruption: summary.has_interruption
        }),
        v4_rag: true
      }
    },
    agentConfig
  );
}

export function trimBoundedAnswer(text, maxChars = MAX_ANSWER_CHARS) {
  const base = sanitizeResponseText(normalizeText(text));
  if (base.length <= maxChars) return base;
  const slice = base.slice(0, maxChars);
  const lastSpace = slice.lastIndexOf(" ");
  const trimmed = (lastSpace > 80 ? slice.slice(0, lastSpace) : slice).trim();
  return trimmed.endsWith("?") ? trimmed : `${trimmed}?`;
}

export function validateRagAnswerSafety(answerText, agentConfig = null) {
  const text = normalizeText(answerText);
  if (!text) {
    return { ok: false, reason: "empty_answer" };
  }
  if (PHONE_IN_TEXT.test(text)) {
    return { ok: false, reason: "phone_in_answer" };
  }
  if (GUARANTEE_PATTERN.test(text)) {
    return { ok: false, reason: "guarantee_claim" };
  }
  const forbidden = getForbiddenClaims(agentConfig?.config ?? agentConfig ?? {});
  const lower = text.toLowerCase();
  for (const claim of forbidden) {
    const norm = String(claim).toLowerCase().trim();
    if (norm && lower.includes(norm)) {
      return { ok: false, reason: "forbidden_claim", claim: norm };
    }
  }
  if (/\b(lead_ready|callback_permission|phone_validated)\b/i.test(text)) {
    return { ok: false, reason: "lead_delegation_language" };
  }
  if (text.length > MAX_ANSWER_CHARS + 40) {
    return { ok: false, reason: "answer_too_long" };
  }
  return { ok: true, reason: "safe" };
}

export function summarizeRagEvidence(ragResult = {}) {
  const chunks = Array.isArray(ragResult?.data?.answer_context) ? ragResult.data.answer_context : [];
  return {
    hit: Boolean(ragResult?.hit),
    hit_count: chunks.length,
    top_score: ragResult?.topScore ?? null,
    top_source: ragResult?.topSource ? redactPhoneLikeText(String(ragResult.topSource)) : null,
    top_title: chunks[0]?.title ? redactPhoneLikeText(String(chunks[0].title)) : null,
    latency_ms: ragResult?.latencyMs ?? null
  };
}

function firstQualifyingQuestion(productId) {
  const playbook = salesPlaybookByProduct(productId);
  const questions = Array.isArray(playbook?.qualifying_questions) ? playbook.qualifying_questions : [];
  return questions[0] || "Was ist bei Ihnen gerade das wichtigste Ziel?";
}

export function fallbackToPlaybook({ productId, transcript = "", agentConfig = null } = {}) {
  const product = productId ? getProductById(agentConfig, productId) : null;
  const explanation =
    buildSalesProductExplanation(productId) ||
    (product ? `${product.display_name} unterstützt Sichtbarkeit und Anfragen.` : "Gerne erkläre ich das kurz.");
  const answer = trimBoundedAnswer(explanation);
  const safety = validateRagAnswerSafety(answer, agentConfig);
  return {
    ok: true,
    answer,
    next_question: firstQualifyingQuestion(productId),
    used_rag: false,
    fallback_reason: "playbook",
    creates_lead: false,
    safety_ok: safety.ok,
    evidence: { hit: false, hit_count: 0 }
  };
}

function buildAnswerFromChunks(productId, ragData, agentConfig) {
  const chunks = Array.isArray(ragData?.answer_context) ? ragData.answer_context : [];
  if (!chunks.length) return null;
  const snippet = normalizeText(chunks[0]?.snippet || chunks[0]?.text || "");
  if (!snippet) return null;
  const answer = trimBoundedAnswer(snippet, 180);
  const safety = validateRagAnswerSafety(answer, agentConfig);
  if (!safety.ok) return null;
  return {
    ok: true,
    answer,
    next_question: firstQualifyingQuestion(productId),
    used_rag: true,
    fallback_reason: null,
    creates_lead: false,
    safety_ok: true
  };
}

export async function retrieveV4RagAnswer({
  config,
  agentConfig = null,
  transcript = "",
  memory = {},
  stateMachine = {},
  retrieveFn = retrieveRagContext,
  minScore = null
} = {}) {
  const guard = ragAnswerMustNotCreateLead(true);
  const productId = memory?.selected_product_id ?? memory?.product_interest ?? null;
  const playbookFallback = () =>
    fallbackToPlaybook({ productId, transcript, agentConfig });

  const ragCheck = shouldUseRagForTurn({
    state: stateMachine?.state ?? memory?.current_state,
    memory,
    transcript
  });
  if (!ragCheck.allowed) {
    return { ...playbookFallback(), blocked: true, block_reason: ragCheck.reason };
  }

  const apiUrl = String(config?.rag?.apiUrl ?? "").trim();
  const documentedUrl = resolveDocumentedRagBaseUrl(config);
  if (!apiUrl) {
    return {
      ...playbookFallback(),
      fallback_reason: "rag_api_url_missing",
      documented_base_url: documentedUrl
    };
  }

  let payload;
  try {
    payload = buildV4RagQuery({ config, agentConfig, transcript, memory, stateMachine });
  } catch (err) {
    return {
      ...playbookFallback(),
      fallback_reason: err?.message ?? "rag_query_invalid"
    };
  }

  const threshold =
    minScore ?? payload.min_score ?? Number(config?.rag?.minScore ?? 0.72);
  const timeoutMs = Math.max(100, Number(config?.rag?.timeoutMs ?? 700));

  const ragResult = await retrieveFn(config, { ...payload, timeoutMs });

  if (!ragResult?.ok) {
    return {
      ...playbookFallback(),
      fallback_reason: ragResult?.reason ?? "rag_unavailable",
      latency_ms: ragResult?.latencyMs ?? null,
      evidence: summarizeRagEvidence(ragResult)
    };
  }

  if (!ragResult.hit || ragResult.hitCount === 0) {
    return {
      ...playbookFallback(),
      fallback_reason: "rag_miss",
      latency_ms: ragResult.latencyMs ?? null,
      evidence: summarizeRagEvidence(ragResult)
    };
  }

  if (Number.isFinite(ragResult.topScore) && ragResult.topScore < threshold) {
    return {
      ...playbookFallback(),
      fallback_reason: "rag_low_score",
      latency_ms: ragResult.latencyMs ?? null,
      evidence: summarizeRagEvidence(ragResult)
    };
  }

  const built = buildAnswerFromChunks(productId, ragResult.data, agentConfig);
  if (!built) {
    return {
      ...playbookFallback(),
      fallback_reason: "rag_unsafe_or_empty",
      latency_ms: ragResult.latencyMs ?? null,
      evidence: summarizeRagEvidence(ragResult)
    };
  }

  return {
    ...built,
    latency_ms: ragResult.latencyMs ?? null,
    evidence: summarizeRagEvidence(ragResult),
    payload_tenant_id: payload.tenant_id,
    payload_agent_id: payload.agent_id,
    creates_lead: guard.createsLead
  };
}
