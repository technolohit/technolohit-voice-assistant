/**
 * Post-contact / post-completion follow-up routing.
 */

import { buildBusinessFallbackResponse, matchBusinessFallbackFromText } from "./business-fallback-policy.js";
import {
  buildPostCapturePricingAnswer,
  buildProductRelationAnswer,
  detectProductRelationQuestion
} from "./product-intent-routing.js";
import { answerProductQuestionWithRag } from "./rag-sales-answerer.js";

const QUESTION_PROMPT_TEXT = "Gerne. Welche Frage haben Sie?";
const CLOSING_ONCE_TEXT = "Haben Sie noch eine kurze Frage, oder darf ich mich verabschieden?";

function normalize(text) {
  return String(text ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/ß/g, "ss")
    .replace(/\s+/g, " ")
    .trim();
}

export function isFollowupQuestionOnlySignal(text) {
  const normalized = normalize(text).replace(/[!?.,;:]+/g, " ").replace(/\s+/g, " ").trim();
  if (!normalized || !/\b(frage|question)\b/i.test(normalized)) return false;

  const hasQuestionWords = /\b(was|wie|wann|wo|warum|wieso|weshalb|welche|welcher|welches|kannst|konnten)\b/i.test(
    normalized
  );
  const hasTopicTail = /\b(zu|wegen|uber|ueber)\b\s+[a-z0-9]{3,}/i.test(normalized);
  const tokens = normalized.split(" ").filter(Boolean);

  if (hasQuestionWords || hasTopicTail) return false;
  if (
    /\b(ja|klar|doch|genau)?\s*(ich\s*)?(habe|hab|hatte|haette)?\s*(noch\s*)?(eine\s*)?frage\b/i.test(normalized) &&
    tokens.length <= 10
  ) {
    return true;
  }
  return /\b(noch\s*)?eine\s*frage\b/i.test(normalized) && tokens.length <= 6;
}

function classifyPostCompletionIntent(callerText) {
  const lower = normalize(callerText);
  if (detectProductRelationQuestion(lower)) return "product_relation_question";
  if (/\b(preis|preise|kosten|kostet|was kostet|wie teuer|teuer|wie steht.*kost)\b/i.test(lower)) {
    return "pricing_question";
  }
  if (/\b(intelligente website|smart website|digitale rezeption|ki assistent|ai assistant)\b/i.test(lower)) {
    if (/\b(erklar|erklaren|was ist|wie funktioniert|was bringt)\b/i.test(lower)) {
      return "product_explanation_question";
    }
  }
  return "";
}

function appendClosingOnce(intake, text) {
  if (intake.postCompletionClosingAsked) return text;
  intake.postCompletionClosingAsked = true;
  return `${text} ${CLOSING_ONCE_TEXT}`;
}

export function isPostCompletionAnswerEligible(intake) {
  if (!intake?.completed && !intake?.closingPending) return false;
  return (
    intake.waitingFor === "post_completion_actual_question" ||
    intake.waitingFor === "post_completion_question" ||
    intake.waitingFor === "closing_answer" ||
    intake.closingPending ||
    intake.postCompletionFollowupUsed
  );
}

/**
 * Route a post-completion caller turn. Returns null if not handled here.
 */
export async function routePostCompletionTurn({
  config,
  callerText,
  intake,
  productState,
  normalizeResponse
}) {
  if (!isPostCompletionAnswerEligible(intake)) return null;

  if (isFollowupQuestionOnlySignal(callerText)) {
    intake.postCompletionFollowupUsed = true;
    intake.closingPending = false;
    intake.waitingFor = "post_completion_actual_question";
    return {
      text: normalizeResponse(QUESTION_PROMPT_TEXT),
      detectedIntent: "post_completion_question_prompt",
      finalResponseTemplate: "post_completion",
      intake,
      product: productState
    };
  }

  const intent = classifyPostCompletionIntent(callerText);
  const contactCaptured =
    intake.contactPermissionGranted === true || Boolean(intake.completed);

  if (intent === "product_relation_question") {
    intake.postCompletionFollowupUsed = true;
    intake.waitingFor = "post_completion_question";
    intake.postCompletionAnswerCount = Number(intake.postCompletionAnswerCount || 0) + 1;
    const text = appendClosingOnce(intake, buildProductRelationAnswer());
    return {
      text: normalizeResponse(text),
      detectedIntent: "post_completion_product_answer",
      finalResponseTemplate: "post_completion",
      intake,
      product: productState
    };
  }

  if (intent === "pricing_question") {
    intake.postCompletionFollowupUsed = true;
    intake.waitingFor = "post_completion_question";
    intake.postCompletionAnswerCount = Number(intake.postCompletionAnswerCount || 0) + 1;
    const text = appendClosingOnce(intake, buildPostCapturePricingAnswer(contactCaptured));
    return {
      text: normalizeResponse(text),
      detectedIntent: "post_completion_pricing_answer",
      finalResponseTemplate: "post_completion",
      intake,
      product: productState
    };
  }

  if (intent === "product_explanation_question") {
    const productId = productState?.selectedProduct || "voice_agent";
    const ragAnswer = await answerProductQuestionWithRag({
      config,
      callerText,
      productId,
      dialogueSummary: ""
    });
    const body = ragAnswer.answer || buildProductRelationAnswer();
    intake.postCompletionFollowupUsed = true;
    intake.waitingFor = "post_completion_question";
    intake.postCompletionAnswerCount = Number(intake.postCompletionAnswerCount || 0) + 1;
    const text = appendClosingOnce(intake, body);
    return {
      text: normalizeResponse(text),
      detectedIntent: "post_completion_product_answer",
      finalResponseTemplate: ragAnswer.used_rag ? "rag_sales_answerer" : "post_completion",
      intake,
      product: productState
    };
  }

  const fallbackMatch = matchBusinessFallbackFromText(callerText);
  if (fallbackMatch) {
    const built = buildBusinessFallbackResponse(fallbackMatch.intent, {
      contactEmail: String(config?.assistant?.contactEmail || "").trim(),
      websiteUrl: String(config?.assistant?.websiteUrl || "").trim(),
      fallbackQuestionCount: Number(intake.businessFallbackQuestionCount || 0),
      contactCaptured
    });
    if (built.body) {
      intake.postCompletionFollowupUsed = true;
      intake.waitingFor = "post_completion_question";
      intake.businessFallbackQuestionCount = Number(intake.businessFallbackQuestionCount || 0) + 1;
      intake.postCompletionAnswerCount = Number(intake.postCompletionAnswerCount || 0) + 1;
      let text = built.body;
      if (built.guidance && !contactCaptured) text = `${text} ${built.guidance}`;
      text = appendClosingOnce(intake, text);
      return {
        text: normalizeResponse(text),
        detectedIntent: `post_completion_${fallbackMatch.intent}`,
        finalResponseTemplate: "post_completion",
        intake,
        product: productState
      };
    }
  }

  const lower = normalize(callerText);
  if (lower.length >= 20 && (lower.includes("?") || /\b(was|wie|warum|kannst|konnten|erklar)\b/i.test(lower))) {
    intake.postCompletionFollowupUsed = true;
    intake.waitingFor = "post_completion_question";
    intake.postCompletionAnswerCount = Number(intake.postCompletionAnswerCount || 0) + 1;
    const text = appendClosingOnce(
      intake,
      "Das kann ich kurz einordnen: Unser Team kann die Details persoenlich mit Ihnen klaeren."
    );
    return {
      text: normalizeResponse(text),
      detectedIntent: "post_completion_general_answer",
      finalResponseTemplate: "post_completion",
      intake,
      product: productState
    };
  }

  return null;
}
