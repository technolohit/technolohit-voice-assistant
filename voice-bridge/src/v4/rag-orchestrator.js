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
import {
  detectTranscriptIntent,
  sanitizeResponseText,
  isPricingOrProductQuestion,
  isPostContactProductQuestion
} from "./transcript-intent.js";
import { ragAnswerMustNotCreateLead } from "./lead-validator.js";
import {
  filterRagChunksByProductScope,
  resolveRagProductScope
} from "./rag-product-scope.js";
import {
  runtimeRetrieveMaxAttempts,
  runtimeRetrieveTimeoutMs
} from "./rag-retrieve-config.js";
import {
  buildPlaybookCombinedProductAnswer,
  buildPlaybookShortAnswer,
  COMBINED_LIVE_TTS_CHAR_LIMIT,
  detectShortFollowUpCategory
} from "./playbook-short-answer.js";

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

export {
  isPricingOrProductQuestion,
  isPostContactProductQuestion
} from "./transcript-intent.js";

export function shouldUseRagForTurn({ config = null, state, intent, memory = {}, transcript = "" } = {}) {
  const resolvedState = String(state ?? memory?.current_state ?? "").trim();
  const resolvedIntent = intent ?? detectTranscriptIntent(transcript, memory);

  if (
    config &&
    (!config?.rag?.enabled || !config?.rag?.salesAnswererEnabled)
  ) {
    return { allowed: false, reason: "rag_disabled", state: resolvedState };
  }

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
  const productId = resolveRagProductScope(memory);
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
        product_scope: productId,
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
  const combined = buildPlaybookCombinedProductAnswer(agentConfig, productId, transcript);
  if (combined) {
    const answer = trimBoundedAnswer(combined, COMBINED_LIVE_TTS_CHAR_LIMIT);
    const safety = validateRagAnswerSafety(answer, agentConfig);
    return {
      ok: true,
      answer,
      next_question: firstQualifyingQuestion(productId),
      used_rag: false,
      fallback_reason: "playbook_combined_inquiry",
      creates_lead: false,
      safety_ok: safety.ok,
      evidence: { hit: false, hit_count: 0 }
    };
  }

  const category = detectShortFollowUpCategory(transcript);
  if (category && productId) {
    const scoped = buildPlaybookShortAnswer(agentConfig, productId, category);
    const answer = trimBoundedAnswer(scoped);
    const safety = validateRagAnswerSafety(answer, agentConfig);
    return {
      ok: true,
      answer,
      next_question: firstQualifyingQuestion(productId),
      used_rag: false,
      fallback_reason: category === "pricing" ? "playbook_pricing" : `playbook_${category}`,
      creates_lead: false,
      safety_ok: safety.ok,
      evidence: { hit: false, hit_count: 0 }
    };
  }

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

function summarizeRagFilterStages(ragResult = {}, productId = null) {
  const rawChunks = Array.isArray(ragResult?.data?.answer_context)
    ? ragResult.data.answer_context
    : [];
  const scopedChunks = filterRagChunksByProductScope(rawChunks, productId);
  const rawTopScore = rawChunks.length ? Number(rawChunks[0]?.score ?? NaN) : NaN;
  const scopedTopScore = scopedChunks.length ? Number(scopedChunks[0]?.score ?? NaN) : NaN;
  return {
    raw_result_count_before_voice_filter: rawChunks.length,
    result_count_after_product_filter: scopedChunks.length,
    top_score_before_filter: Number.isFinite(rawTopScore) ? rawTopScore : null,
    top_score_after_filter: Number.isFinite(scopedTopScore) ? scopedTopScore : null,
    scoped_chunks: scopedChunks
  };
}

function buildAnswerFromChunks(productId, ragData, agentConfig) {
  const chunks = filterRagChunksByProductScope(ragData?.answer_context, productId);
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

function finiteLatencyMs(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function summarizeLiveRagAttempts(attempts = []) {
  const safeAttempts = attempts.filter(Boolean);
  const successCount = safeAttempts.filter((entry) => entry?.ok && entry?.hit).length;
  const timeoutCount = safeAttempts.filter((entry) => entry?.reason === "timeout").length;
  const fallbackReasons = [
    ...new Set(
      safeAttempts
        .filter((entry) => !entry?.ok)
        .map((entry) => String(entry?.reason ?? "rag_unavailable"))
        .filter(Boolean)
    )
  ];
  return {
    attempt_count: safeAttempts.length,
    success_count: successCount,
    timeout_count: timeoutCount,
    attempt_fallback_reasons: fallbackReasons,
    total_latency_ms: safeAttempts.reduce(
      (sum, entry) => sum + finiteLatencyMs(entry?.latencyMs),
      0
    )
  };
}

async function retrieveWithLiveTimeoutRetry({ config, payload, retrieveFn, timeoutMs, maxAttempts }) {
  const attempts = [];
  for (let index = 0; index < maxAttempts; index += 1) {
    let ragResult;
    try {
      ragResult = await retrieveFn(config, { ...payload, timeoutMs });
    } catch {
      return {
        ragResult: null,
        meta: summarizeLiveRagAttempts(attempts),
        thrown: true
      };
    }

    attempts.push(ragResult);
    if (ragResult?.ok || ragResult?.reason !== "timeout") {
      break;
    }
  }

  const selected = attempts.find((entry) => entry?.ok && entry?.hit) ?? attempts[attempts.length - 1] ?? null;
  return {
    ragResult: selected,
    meta: summarizeLiveRagAttempts(attempts),
    thrown: false
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
  const productId = resolveRagProductScope(memory);
  const thresholdDefault = Number(config?.rag?.minScore ?? 0.72);
  const playbookFallback = () =>
    fallbackToPlaybook({ productId, transcript, agentConfig });
  const scopedFallback = (extra = {}, payloadMeta = null) => ({
    ...playbookFallback(),
    rag_product_scope: productId,
    result_count: Number(extra?.result_count ?? extra?.evidence?.hit_count ?? 0),
    min_score: extra?.min_score ?? payloadMeta?.min_score ?? thresholdDefault,
    top_score: extra?.top_score ?? extra?.evidence?.top_score ?? null,
    payload_tenant_id: payloadMeta?.tenant_id ?? null,
    payload_agent_id: payloadMeta?.agent_id ?? null,
    rag_http_status: extra?.rag_http_status ?? null,
    rag_error_reason: extra?.rag_error_reason ?? null,
    ...extra
  });

  const ragCheck = shouldUseRagForTurn({
    config,
    state: stateMachine?.state ?? memory?.current_state,
    memory,
    transcript
  });
  if (!ragCheck.allowed) {
    return { ...scopedFallback(), blocked: true, block_reason: ragCheck.reason };
  }

  const apiUrl = String(config?.rag?.apiUrl ?? "").trim();
  const documentedUrl = resolveDocumentedRagBaseUrl(config);
  if (!apiUrl) {
    return {
      ...scopedFallback(),
      fallback_reason: "rag_api_url_missing",
      documented_base_url: documentedUrl
    };
  }

  let payload;
  try {
    payload = buildV4RagQuery({ config, agentConfig, transcript, memory, stateMachine });
  } catch (err) {
    return {
      ...scopedFallback(),
      fallback_reason: err?.message ?? "rag_query_invalid"
    };
  }

  const threshold = minScore ?? payload.min_score ?? thresholdDefault;
  const timeoutMs = runtimeRetrieveTimeoutMs(config);
  const maxAttempts = runtimeRetrieveMaxAttempts(config);

  const { ragResult, meta: attemptMeta, thrown } = await retrieveWithLiveTimeoutRetry({
    config,
    payload,
    retrieveFn,
    timeoutMs,
    maxAttempts
  });
  const withAttemptMeta = (extra = {}) => ({
    ...extra,
    rag_attempt_count: attemptMeta.attempt_count,
    rag_success_count: attemptMeta.success_count,
    rag_timeout_count: attemptMeta.timeout_count,
    rag_attempt_fallback_reasons: attemptMeta.attempt_fallback_reasons,
    rag_total_latency_ms: attemptMeta.total_latency_ms || null
  });
  const withFilterMeta = (filterStages = {}, extra = {}) => ({
    ...withAttemptMeta(extra),
    raw_result_count_before_voice_filter: filterStages.raw_result_count_before_voice_filter ?? null,
    result_count_after_product_filter: filterStages.result_count_after_product_filter ?? null,
    top_score_before_filter: filterStages.top_score_before_filter ?? null,
    top_score_after_filter: filterStages.top_score_after_filter ?? null
  });

  if (thrown) {
    return {
      ...scopedFallback(withAttemptMeta()),
      fallback_reason: "rag_request_failed"
    };
  }

  if (!ragResult?.ok) {
    const evidence = summarizeRagEvidence(ragResult);
    return scopedFallback(
      withAttemptMeta({
        fallback_reason: ragResult?.reason ?? "rag_unavailable",
        latency_ms: attemptMeta.total_latency_ms || (ragResult?.latencyMs ?? null),
        rag_http_status: ragResult?.status ?? null,
        rag_error_reason: ragResult?.reason ?? "rag_unavailable",
        evidence,
        top_score: evidence.top_score,
        result_count: evidence.hit_count
      }),
      payload
    );
  }

  if (!ragResult.hit || ragResult.hitCount === 0) {
    const evidence = summarizeRagEvidence(ragResult);
    const filterStages = summarizeRagFilterStages(ragResult, productId);
    return scopedFallback(
      withFilterMeta(filterStages, {
        fallback_reason: "rag_miss",
        latency_ms: attemptMeta.total_latency_ms || (ragResult.latencyMs ?? null),
        rag_http_status: ragResult?.status ?? 200,
        evidence,
        top_score: filterStages.top_score_before_filter ?? evidence.top_score,
        result_count: 0
      }),
      payload
    );
  }

  const filterStages = summarizeRagFilterStages(ragResult, productId);
  const scopedChunks = filterStages.scoped_chunks;
  if (productId && scopedChunks.length === 0) {
    const evidence = summarizeRagEvidence(ragResult);
    return scopedFallback(
      withFilterMeta(filterStages, {
        fallback_reason: "rag_wrong_product_scope",
        latency_ms: attemptMeta.total_latency_ms || (ragResult.latencyMs ?? null),
        rag_http_status: ragResult?.status ?? 200,
        evidence,
        top_score: filterStages.top_score_before_filter ?? evidence.top_score,
        result_count: 0
      }),
      payload
    );
  }

  const scopedTopScore = filterStages.top_score_after_filter;
  if (scopedTopScore != null && scopedTopScore < threshold) {
    const evidence = summarizeRagEvidence(ragResult);
    return scopedFallback(
      withFilterMeta(filterStages, {
        fallback_reason: "rag_low_score",
        latency_ms: attemptMeta.total_latency_ms || (ragResult.latencyMs ?? null),
        rag_http_status: ragResult?.status ?? 200,
        min_score: threshold,
        evidence,
        top_score: scopedTopScore,
        result_count: scopedChunks.length
      }),
      payload
    );
  }

  const scopedData = { ...(ragResult.data ?? {}), answer_context: scopedChunks };
  const built = buildAnswerFromChunks(productId, scopedData, agentConfig);
  if (!built) {
    const evidence = summarizeRagEvidence(ragResult);
    return scopedFallback(
      withFilterMeta(filterStages, {
        fallback_reason: "rag_unsafe_or_empty",
        latency_ms: attemptMeta.total_latency_ms || (ragResult.latencyMs ?? null),
        rag_http_status: ragResult?.status ?? 200,
        evidence,
        top_score: scopedTopScore ?? filterStages.top_score_before_filter ?? evidence.top_score,
        result_count: scopedChunks.length
      }),
      payload
    );
  }

  const evidence = summarizeRagEvidence({ ...ragResult, data: scopedData });
  return {
    ...built,
    ...withFilterMeta(filterStages),
    latency_ms: attemptMeta.total_latency_ms || (ragResult.latencyMs ?? null),
    evidence,
    rag_product_scope: productId,
    result_count: scopedChunks.length,
    rag_http_status: ragResult?.status ?? 200,
    min_score: threshold,
    top_score: scopedTopScore ?? evidence.top_score,
    payload_tenant_id: payload.tenant_id,
    payload_agent_id: payload.agent_id,
    creates_lead: guard.createsLead
  };
}
