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
import { isClosingIntent } from "./closing-intent.js";
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
  detectCombinedProductInquiry,
  detectShortFollowUpCategory
} from "./playbook-short-answer.js";

const MAX_ANSWER_CHARS = 220;
const MAX_COMBINED_RAG_ANSWER_CHARS = 260;
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
  V4_STATES.COLLECTING_PHONE_NUMBER,
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

  // Phase 10AK: closing / stop intent overrides RAG in every state, including
  // ANSWERING_PRODUCT_QUESTION right after a product answer.
  if (resolvedIntent === "closing" || isClosingIntent(transcript)) {
    return { allowed: false, reason: "closing_intent", state: resolvedState };
  }

  // Phase 10AP: role boundary and callback intents must not trigger RAG.
  // Phase 10AT/10AU: the whole callback/contact continuation (permission
  // grant/refusal, manual review, attention recovery) must never run RAG.
  if (
    resolvedIntent === "out_of_scope" ||
    resolvedIntent === "technical_escalation" ||
    resolvedIntent === "callback_request" ||
    resolvedIntent === "callback_permission_granted" ||
    resolvedIntent === "callback_permission_denied" ||
    resolvedIntent === "callback_flow_attention" ||
    resolvedIntent === "phone_number_candidate" ||
    resolvedIntent === "phone_capture_refused" ||
    resolvedIntent === "phone_capture_failed"
  ) {
    return { allowed: false, reason: `${resolvedIntent}_intent`, state: resolvedState };
  }

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

function safePreview(text, maxChars = 220) {
  const base = redactPhoneLikeText(normalizeText(text));
  if (base.length <= maxChars) return base;
  const slice = base.slice(0, maxChars);
  const lastSpace = slice.lastIndexOf(" ");
  return (lastSpace > 80 ? slice.slice(0, lastSpace) : slice).trim();
}

function chunkText(chunk = {}) {
  return normalizeText(chunk?.snippet || chunk?.text || chunk?.content || "");
}

function chunkTitle(chunk = {}) {
  return normalizeText(chunk?.title || chunk?.metadata?.title || chunk?.source_title || "");
}

function buildCombinedRagAnswer(productId, transcript = "") {
  const combined = detectCombinedProductInquiry(transcript);
  if (!combined.isCombined) return null;
  if (productId !== "smart_website") return null;
  return sanitizeResponseText(
    "Smart Website ist eine moderne Firmenwebsite mit Leistungsseiten und lokaler Sichtbarkeit. " +
      "Sie erklaert Ihr Angebot, beantwortet erste Fragen und bereitet qualifizierte Anfragen vor. " +
      "Der Preis haengt vom Umfang ab, etwa Seiten, Inhalte und lokale SEO."
  );
}

function buildAnswerFromChunks(productId, ragData, agentConfig, transcript = "") {
  const chunks = filterRagChunksByProductScope(ragData?.answer_context, productId);
  if (!chunks.length) return null;
  const snippet = chunkText(chunks[0]);
  if (!snippet) return null;
  const contextSafety = validateRagAnswerSafety(trimBoundedAnswer(snippet, 220), agentConfig);
  if (!contextSafety.ok) return null;
  const combinedAnswer = buildCombinedRagAnswer(productId, transcript);
  const answer = combinedAnswer
    ? trimBoundedAnswer(combinedAnswer, MAX_COMBINED_RAG_ANSWER_CHARS)
    : trimBoundedAnswer(snippet, 180);
  const safety = validateRagAnswerSafety(answer, agentConfig);
  if (!safety.ok) return null;
  return {
    ok: true,
    answer,
    answer_context_preview: safePreview(snippet, 220),
    rag_source_title_preview: safePreview(chunkTitle(chunks[0]), 120) || null,
    max_spoken_chars: combinedAnswer ? MAX_COMBINED_RAG_ANSWER_CHARS : null,
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
        .map((entry) => String(entry?.reason ?? "").trim() || "request_failed")
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

// Phase 10AT: transient transport failures must be retried up to
// VOICE_RAG_RETRIEVE_MAX_ATTEMPTS (the previous loop only retried "timeout",
// so a single transient network/5xx failure burned the whole live turn).
const TRANSIENT_HTTP_STATUS = /^http_(429|5\d{2})$/;

export function isTransientRetrievalFailure(result) {
  if (!result || result.ok) return false;
  const reason = String(result.reason ?? "");
  if (reason === "timeout" || reason === "request_failed" || reason === "rag_unavailable") {
    return true;
  }
  return TRANSIENT_HTTP_STATUS.test(reason);
}

// Phase 10AU: every failed attempt must carry a non-empty normalized reason.
// An empty/missing reason is a transport-level anomaly — classify it as
// "request_failed" (transient, retryable) instead of letting an empty string
// suppress retries and produce empty fallback-reason evidence.
export function normalizeRetrievalFailure(result) {
  if (!result) {
    return { ok: false, reason: "request_failed", latencyMs: 0 };
  }
  if (result.ok) return result;
  const reason = String(result.reason ?? "").trim();
  if (reason) return result;
  return { ...result, reason: "request_failed" };
}

async function retrieveWithLiveTransientRetry({ config, payload, retrieveFn, timeoutMs, maxAttempts }) {
  const attempts = [];
  for (let index = 0; index < maxAttempts; index += 1) {
    let ragResult;
    try {
      ragResult = await retrieveFn(config, { ...payload, timeoutMs });
    } catch {
      ragResult = { ok: false, reason: "request_failed", latencyMs: 0 };
    }
    ragResult = normalizeRetrievalFailure(ragResult);

    attempts.push(ragResult);
    // Stop immediately on a transport-level success (usable hit or
    // deterministic miss). Retry only timeout / transient / unavailable
    // failures; deterministic failures (for example http_4xx) stop the loop.
    if (ragResult?.ok) break;
    if (!isTransientRetrievalFailure(ragResult)) break;
  }

  const selected = attempts.find((entry) => entry?.ok && entry?.hit) ?? attempts[attempts.length - 1] ?? null;
  return {
    ragResult: selected,
    meta: summarizeLiveRagAttempts(attempts)
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
    // Phase 10AU: failed final outcomes always carry a non-empty error
    // reason; deterministic fallbacks reuse their fallback_reason.
    rag_error_reason: extra?.rag_error_reason ?? extra?.fallback_reason ?? null,
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

  const { ragResult, meta: attemptMeta } = await retrieveWithLiveTransientRetry({
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

  if (!ragResult?.ok) {
    const evidence = summarizeRagEvidence(ragResult);
    // Phase 10AU: final failed outcome must always carry a non-empty
    // normalized reason for fallback_reason and rag_error_reason.
    const failureReason = String(ragResult?.reason ?? "").trim() || "rag_unavailable";
    return scopedFallback(
      withAttemptMeta({
        fallback_reason: failureReason,
        latency_ms: attemptMeta.total_latency_ms || (ragResult?.latencyMs ?? null),
        rag_http_status: ragResult?.status ?? null,
        rag_error_reason: failureReason,
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
  const built = buildAnswerFromChunks(productId, scopedData, agentConfig, transcript);
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
