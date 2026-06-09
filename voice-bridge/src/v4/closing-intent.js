/**
 * Phase 10AK — closing / stop intent detection (Conversation Priority Contract #1).
 * Closing must override RAG, fallback clarification, product continuation,
 * lead capture, and interrupt follow-up continuation.
 *
 * Self-contained on purpose: depends only on redaction.js so it can be wired
 * early in intent detection, RAG gating, and response planning without cycles.
 */

import { normalizeText } from "./redaction.js";

/** Canonical v4 closing response (blueprint Conversation Priority Contract). */
export const CLOSING_RESPONSE_TEXT =
  "Sehr gerne. Dann wünsche ich Ihnen noch einen schönen Tag. Auf Wiederhören.";

// Strong goodbye phrases — always closing (matches pre-10AK DEFINITE_GOODBYE).
const STRONG_GOODBYE =
  /\b(auf wiederh[oö]ren|auf wiedersehen|wiederh[oö]ren|wiedersehen|bis dann|nein danke|danke[, ]+das war alles|das war alles|das war'?s|das wars|keine frage mehr|tsch[uü]ss|tschuess|sch[oö]nen tag)\b/i;

// "Ich habe keine weiteren Fragen." and variants.
const NO_MORE_QUESTIONS =
  /\bkeine weiteren? fragen?\b|\bkeine fragen? mehr\b/i;

// Soft closing phrases: "Danke, das reicht erstmal." / "Passt so, danke." / "Danke, passt."
const SOFT_CLOSING =
  /\bdas reicht\b(?!\s*nicht)|\bpasst so\b|\bdanke,?\s*passt\b|\bpasst,?\s*danke\b/i;

// "Stopp, danke" — Stopp combined with thanks/goodbye is closing, not barge-in wait.
const STOP_WITH_THANKS =
  /\b(stopp|stop)\b[\s\S]*\bdanke\b|\bdanke\b[\s\S]*\b(stopp|stop)\b/i;

// Guards: caller is announcing a follow-up question or asking something new.
const FOLLOW_UP_GUARD =
  /\b(kurze frage|noch eine frage|darf ich kurz fragen|ich h[äa]tte (noch )?eine frage|ich habe (noch )?eine frage)\b/i;
const QUESTION_GUARD =
  /\b(was|wie|warum|wieso|wann|wo|wof[üu]r|kostet|kosten|preis)\b/i;

export function isClosingIntent(transcript = "") {
  const lower = normalizeText(transcript).toLowerCase();
  if (!lower) return false;

  if (STRONG_GOODBYE.test(lower)) return true;
  if (/^danke[.!]?$/.test(lower.trim())) return true;
  if (NO_MORE_QUESTIONS.test(lower)) return true;

  // Soft phrases never close when the caller is announcing or asking a question.
  if (FOLLOW_UP_GUARD.test(lower)) return false;
  if (QUESTION_GUARD.test(lower)) return false;

  if (SOFT_CLOSING.test(lower)) return true;
  if (STOP_WITH_THANKS.test(lower)) return true;

  return false;
}

/**
 * Context-sensitive "Stopp": a bare stop word without thanks/goodbye stays
 * barge-in/interruption behavior and must NOT close the call.
 */
export function isBareStopWord(transcript = "") {
  const lower = normalizeText(transcript).toLowerCase().trim();
  if (!lower) return false;
  return /^(stopp|stop)[.!,]?$/.test(lower) && !isClosingIntent(transcript);
}
