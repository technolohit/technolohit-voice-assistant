/**
 * Phase 10G — deterministic spoken phone capture for callback flow (v4).
 *
 * Parses common German digit strings and limited spoken digit words.
 * Validates via validatePhoneForCallback(); never logs full numbers.
 */

import { normalizeText } from "./redaction.js";
import { normalizeCallerPhone } from "../caller-id.js";
import { validatePhoneForCallback } from "./lead-validator.js";
import { maskPhoneForExternal } from "./privacy-sanitize.js";

const DIGIT_WORDS = new Map([
  ["null", "0"],
  ["zero", "0"],
  ["eins", "1"],
  ["ein", "1"],
  ["eine", "1"],
  ["zwei", "2"],
  ["drei", "3"],
  ["vier", "4"],
  ["funf", "5"],
  ["fuenf", "5"],
  ["fünf", "5"],
  ["sechs", "6"],
  ["sieben", "7"],
  ["acht", "8"],
  ["neun", "9"],
]);

function normalizeSpokenTokens(text = "") {
  return normalizeText(text)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "");
}

function parseDigitStringCandidate(transcript = "") {
  const raw = String(transcript ?? "");
  const digitMatch = raw.match(/\+?\d[\d\s()./-]{5,}\d/);
  if (!digitMatch) return "";
  const value = digitMatch[0].replace(/[^\d+]/g, "");
  if (!value) return "";
  return value.startsWith("00") ? `+${value.slice(2)}` : value;
}

function parseSpokenWordDigits(transcript = "") {
  let hasPlus = false;
  const digits = [];
  for (const word of normalizeSpokenTokens(transcript).split(/\s+/).filter(Boolean)) {
    if (word === "plus") {
      hasPlus = true;
      continue;
    }
    const digit = DIGIT_WORDS.get(word);
    if (digit !== undefined) digits.push(digit);
  }
  if (digits.length < 6) return "";
  return `${hasPlus ? "+" : ""}${digits.join("")}`;
}

export function parseSpokenPhoneCandidate(transcript = "") {
  const fromDigits = parseDigitStringCandidate(transcript);
  if (fromDigits) return normalizeCallerPhone(fromDigits);
  const fromWords = parseSpokenWordDigits(transcript);
  return fromWords ? normalizeCallerPhone(fromWords) : "";
}

/**
 * @returns {{ ok: boolean, normalized_phone: string, masked_phone: string, reason: string }}
 */
export function evaluateSpokenPhoneCapture(transcript = "") {
  const normalized_phone = parseSpokenPhoneCandidate(transcript);
  if (!normalized_phone) {
    return {
      ok: false,
      normalized_phone: "",
      masked_phone: "",
      reason: "no_phone_detected",
    };
  }

  const validation = validatePhoneForCallback({ spokenPhone: normalized_phone });
  if (!validation.ok) {
    return {
      ok: false,
      normalized_phone: "",
      masked_phone: "",
      reason: validation.reason ?? "invalid_phone",
    };
  }

  return {
    ok: true,
    normalized_phone,
    masked_phone: maskPhoneForExternal(normalized_phone),
    reason: validation.reason ?? "valid_phone",
  };
}

export function isPhoneCaptureRefusal(transcript = "") {
  const lower = normalizeSpokenTokens(transcript);
  if (!lower) return false;
  return /\b(nein|lieber nicht|keine nummer|keine telefonnummer|möchte nicht|moechte nicht|will nicht|kein telefon|ohne nummer)\b/i.test(
    lower
  );
}
