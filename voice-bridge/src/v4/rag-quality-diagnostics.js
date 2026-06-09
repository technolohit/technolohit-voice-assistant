/**
 * Privacy-safe RAG quality diagnostics for live v4 canary events.
 * Never includes raw query, transcript, snippets, phone, email, or secrets.
 */

import { normalizeText, redactPhoneLikeText } from "./redaction.js";
import {
  detectCombinedProductInquiry,
  detectShortFollowUpCategory,
} from "./playbook-short-answer.js";
import { runtimeRetrieveMaxAttempts, runtimeRetrieveTimeoutMs } from "./rag-retrieve-config.js";

export function resolveNormalizedQueryType(transcript = "") {
  const combined = detectCombinedProductInquiry(transcript);
  if (combined.isCombined) return "combined_product_inquiry";
  const category = detectShortFollowUpCategory(transcript);
  if (category) return category;
  return "product_question";
}

const EMAIL_LIKE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;

export function buildSafeTextPreview(text = "", maxChars = 220) {
  const redacted = redactPhoneLikeText(normalizeText(text)).replace(EMAIL_LIKE, "[email_redacted]");
  if (!redacted) return null;
  if (redacted.length <= maxChars) return redacted;
  const slice = redacted.slice(0, maxChars);
  const lastSpace = slice.lastIndexOf(" ");
  return (lastSpace > 80 ? slice.slice(0, lastSpace) : slice).trim();
}

export function buildSafeRagEventDiagnostics({
  config = null,
  transcript = "",
  ragResult = null,
  productScope = null,
  tenantId = null,
  agentId = null,
} = {}) {
  const normalized = normalizeText(transcript);
  const answerPreview = buildSafeTextPreview(ragResult?.answer, 240);
  const contextPreview = buildSafeTextPreview(ragResult?.answer_context_preview, 240);
  const titlePreview = buildSafeTextPreview(ragResult?.rag_source_title_preview, 120);
  return {
    normalized_query_type: resolveNormalizedQueryType(transcript),
    query_chars: normalized.length,
    product_scope: productScope ?? ragResult?.rag_product_scope ?? null,
    tenant_id: tenantId ?? ragResult?.payload_tenant_id ?? null,
    agent_id: agentId ?? ragResult?.payload_agent_id ?? null,
    timeout_ms: config ? runtimeRetrieveTimeoutMs(config) : null,
    max_attempts: config ? runtimeRetrieveMaxAttempts(config) : null,
    rag_http_status: ragResult?.rag_http_status ?? null,
    raw_result_count_before_voice_filter:
      ragResult?.raw_result_count_before_voice_filter ?? null,
    result_count_after_product_filter:
      ragResult?.result_count_after_product_filter ?? ragResult?.result_count ?? null,
    top_score_before_filter: ragResult?.top_score_before_filter ?? null,
    top_score_after_filter: ragResult?.top_score_after_filter ?? null,
    min_score: ragResult?.min_score ?? null,
    fallback_reason: ragResult?.fallback_reason ?? null,
    rag_error_reason: ragResult?.rag_error_reason ?? ragResult?.fallback_reason ?? null,
    rag_attempt_count: ragResult?.rag_attempt_count ?? null,
    rag_timeout_count: ragResult?.rag_timeout_count ?? null,
    rag_success_count: ragResult?.rag_success_count ?? null,
    rag_attempt_fallback_reasons: ragResult?.rag_attempt_fallback_reasons ?? [],
    ...(answerPreview ? { rag_answer_preview: answerPreview } : {}),
    ...(contextPreview ? { answer_context_preview: contextPreview } : {}),
    ...(titlePreview ? { rag_source_title_preview: titlePreview } : {}),
  };
}
