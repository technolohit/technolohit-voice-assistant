/**
 * Phase 10F — playbook-driven company and product content (pure resolvers).
 *
 * Active only when VOICE_V4_PLAYBOOK_RUNTIME_ENABLED=true and the playbook
 * passes runtime eligibility checks. Never throws.
 */

import { normalizeText } from "./redaction.js";
import { COMBINED_LIVE_TTS_CHAR_LIMIT, detectCombinedProductInquiry } from "./playbook-short-answer.js";
import { isPlaybookRuntimeEligible } from "./behavior-policy.js";
import { loadTenantPlaybookFromPath, resolvePlaybookPath, validatePlaybook } from "./playbook-loader.js";

export function findPlaybookProduct(playbook, productId) {
  if (!playbook || !productId) return null;
  const products = Array.isArray(playbook.products) ? playbook.products : [];
  return products.find((entry) => entry?.id === productId) ?? null;
}

export function isPlaybookProductContentRuntimeEnabled(
  config = null,
  behaviorPolicy = null,
  playbook = null
) {
  if (!config?.v4?.playbookRuntimeEnabled) return false;
  if (behaviorPolicy?.source && behaviorPolicy.source !== "playbook") return false;
  const candidate = playbook ?? null;
  if (!candidate) return behaviorPolicy?.source === "playbook";
  const draftAllowed = Boolean(config?.v4?.playbookAllowDraft);
  const validation = validatePlaybook(candidate);
  if (!validation.ok) return false;
  return isPlaybookRuntimeEligible(candidate, { allowDraft: draftAllowed }).ok;
}

export function loadPlaybookForProductContent({
  config = null,
  behaviorPolicy = null,
  playbook = null,
} = {}) {
  if (!config?.v4?.playbookRuntimeEnabled) return null;
  if (behaviorPolicy?.source && behaviorPolicy.source !== "playbook") return null;

  let candidate = playbook;
  if (!candidate) {
    const configuredPath = String(config?.v4?.playbookPath ?? "").trim();
    const loaded = loadTenantPlaybookFromPath(configuredPath || resolvePlaybookPath());
    if (!loaded.ok) return null;
    candidate = loaded.playbook;
  }

  const draftAllowed = Boolean(config?.v4?.playbookAllowDraft);
  const validation = validatePlaybook(candidate);
  if (!validation.ok) return null;
  if (!isPlaybookRuntimeEligible(candidate, { allowDraft: draftAllowed }).ok) return null;
  return candidate;
}

function truncateForLiveTts(text, maxChars = COMBINED_LIVE_TTS_CHAR_LIMIT) {
  const normalized = normalizeText(text);
  if (!normalized) return "";
  if (!maxChars || normalized.length <= maxChars) return normalized;
  const slice = normalized.slice(0, maxChars);
  const lastSpace = slice.lastIndexOf(" ");
  if (lastSpace > Math.floor(maxChars * 0.6)) {
    return slice.slice(0, lastSpace).trim();
  }
  return slice.trim();
}

function pickPhoneSafeAnswer(candidates = [], maxChars = COMBINED_LIVE_TTS_CHAR_LIMIT) {
  const normalized = candidates
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter(Boolean);
  for (const candidate of normalized) {
    if (candidate.length <= maxChars) return candidate;
  }
  return normalized.length ? truncateForLiveTts(normalized[0], maxChars) : null;
}

export function resolveCompanyAnswer(playbook, options = {}) {
  const company = playbook?.company ?? {};
  const base =
    (typeof company.positioning_short === "string" && company.positioning_short.trim()) ||
    (typeof company.positioning_long === "string" && company.positioning_long.trim()) ||
    null;
  if (!base) return null;

  const maxChars = options.maxChars ?? COMBINED_LIVE_TTS_CHAR_LIMIT;
  const includeFollowUp = options.includeDiagnosticFollowUp !== false;
  const followUp =
    includeFollowUp && typeof company.diagnostic_follow_up === "string"
      ? company.diagnostic_follow_up.trim()
      : null;

  if (!followUp) return truncateForLiveTts(base, maxChars);

  const combined = `${base} ${followUp}`;
  if (combined.length <= maxChars) return combined;

  const followUpBudget = followUp.length + 1;
  const baseBudget = Math.max(48, maxChars - followUpBudget);
  const trimmedBase = truncateForLiveTts(base, baseBudget);
  return truncateForLiveTts(`${trimmedBase} ${followUp}`, maxChars);
}

export function resolveProductExplanation(playbook, productId, options = {}) {
  const product = findPlaybookProduct(playbook, productId);
  if (!product) return null;
  const phone = product.phone_answers ?? {};
  return pickPhoneSafeAnswer(
    [phone.short_10s, product.short_explanation, phone.medium_25s],
    options.maxChars ?? COMBINED_LIVE_TTS_CHAR_LIMIT
  );
}

export function resolveProductPricingAnswer(playbook, productId, options = {}) {
  const product = findPlaybookProduct(playbook, productId);
  if (!product) return null;
  const phrase = product.price_policy?.approved_phrase ?? product.pricing_answer ?? null;
  if (typeof phrase !== "string" || !phrase.trim()) return null;
  return truncateForLiveTts(phrase.trim(), options.maxChars ?? COMBINED_LIVE_TTS_CHAR_LIMIT);
}

export function resolveProductFollowUpQuestion(playbook, productId) {
  const product = findPlaybookProduct(playbook, productId);
  const question = product?.follow_up_question;
  return typeof question === "string" && question.trim() ? question.trim() : null;
}

export function resolveCombinedProductInquiryAnswer(playbook, productId, transcript = "") {
  const facets = detectCombinedProductInquiry(transcript);
  if (!facets.isCombined) return null;
  const product = findPlaybookProduct(playbook, productId);
  if (!product) return null;

  if (typeof product.combined_inquiry_answer === "string" && product.combined_inquiry_answer.trim()) {
    return truncateForLiveTts(product.combined_inquiry_answer.trim());
  }

  const parts = [];
  if (facets.whatIs || facets.howItWorks) {
    const explanation = resolveProductExplanation(playbook, productId);
    if (explanation) parts.push(explanation);
  }
  if (facets.pricing) {
    const pricing = resolveProductPricingAnswer(playbook, productId);
    if (pricing) parts.push(pricing);
  }
  if (!parts.length) return null;
  return truncateForLiveTts(parts.join(" "));
}

export function shouldProactivelyPromotePlaybookProduct(playbook, productId, transcript = "") {
  const product = findPlaybookProduct(playbook, productId);
  if (!product) return true;
  if (product.answer_only_when_asked === true) {
    return explicitPlaybookProductMention(transcript, product);
  }
  if (product.priority === "low") {
    return explicitPlaybookProductMention(transcript, product);
  }
  return true;
}

export function explicitPlaybookProductMention(transcript = "", product = {}) {
  const lower = normalizeText(transcript).toLowerCase();
  if (!lower) return false;
  const aliases = Array.isArray(product.aliases) ? product.aliases : [];
  const names = [product.display_name, product.id, ...aliases].filter(Boolean);
  return names.some((name) => lower.includes(normalizeText(name).toLowerCase()));
}

export function filterPlaybookProductMatch(playbook, productId, transcript = "") {
  if (!productId) return null;
  if (!playbook) return productId;
  if (shouldProactivelyPromotePlaybookProduct(playbook, productId, transcript)) {
    return productId;
  }
  return null;
}
