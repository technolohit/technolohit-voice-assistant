/**
 * Phase 12J — locked phone-capture sub-state, partial retry, and turn-taking guards.
 */

import { normalizeText } from "./redaction.js";
import {
  CALLBACK_FLOW_STATES,
  isPhoneNumberPendingStage,
} from "./callback-flow-policy.js";
import {
  evaluateSpokenPhoneCapture,
  extractPhoneCaptureFragment,
  isPhoneCaptureRefusal,
  looksLikePartialPhoneCapture,
} from "./spoken-phone-capture.js";

const MAX_PROTECTED_PHONE_DIGITS = 15;

export const PHONE_CAPTURE_RETRY_TEXT =
  "Ich habe die Nummer noch nicht vollständig verstanden. Bitte nennen Sie sie langsam, Ziffer für Ziffer.";

export const DEFAULT_PHONE_CAPTURE_MAX_RETRIES = 1;

export function isPhoneCaptureLocked(memory = {}) {
  return isPhoneNumberPendingStage(memory);
}

export function resolvePhoneCaptureMaxRetries(memory = {}) {
  const configured = Number(memory?.phone_capture_max_retries);
  if (Number.isFinite(configured) && configured >= 0) return configured;
  return DEFAULT_PHONE_CAPTURE_MAX_RETRIES;
}

export function resolvePhoneCaptureAttemptCount(memory = {}) {
  return Math.max(0, Number(memory?.phone_capture_attempt_count ?? 0));
}

export function shouldRetryPhoneCapture(memory = {}) {
  return resolvePhoneCaptureAttemptCount(memory) < resolvePhoneCaptureMaxRetries(memory);
}

function digitCount(value = "") {
  return String(value).replace(/\D/g, "").length;
}

function appendProtectedPhoneFragment(previous = "", current = "") {
  const prior = String(previous ?? "").trim();
  const next = String(current ?? "").trim();
  if (!next) return { value: prior, restarted: false };
  if (!prior) return { value: next, restarted: false };

  // A new national/international prefix means the caller restarted the number.
  if (next.startsWith("0") || next.startsWith("+")) {
    return { value: next, restarted: true };
  }
  if (prior.endsWith(next)) return { value: prior, restarted: false };

  let overlap = 0;
  const maxOverlap = Math.min(prior.length, next.length);
  for (let size = maxOverlap; size >= 3; size -= 1) {
    if (prior.endsWith(next.slice(0, size))) {
      overlap = size;
      break;
    }
  }

  const combined = `${prior}${next.slice(overlap)}`;
  if (digitCount(combined) > MAX_PROTECTED_PHONE_DIGITS) {
    return { value: next, restarted: true };
  }
  return { value: combined, restarted: false };
}

/**
 * Resolve one locked phone-capture turn without placing partial digits in
 * CallSessionMemory. The returned protected fragment belongs on the in-process
 * orchestrator only.
 */
export function resolveProtectedPhoneCaptureTurn(
  transcript = "",
  previousProtectedFragment = "",
) {
  const fragment = extractPhoneCaptureFragment(transcript);
  const merged = appendProtectedPhoneFragment(previousProtectedFragment, fragment);
  const capture = evaluateSpokenPhoneCapture(merged.value);

  return {
    planningTranscript: capture.ok ? merged.value : transcript,
    protectedFragment: merged.value,
    fragmentDetected: Boolean(fragment),
    captureComplete: capture.ok,
    usedAccumulated: capture.ok && Boolean(previousProtectedFragment) && !merged.restarted,
    restarted: merged.restarted,
  };
}

/**
 * Deterministic phone-capture intent while PHONE_NUMBER_PENDING is locked.
 */
export function resolvePhoneCaptureTranscriptIntent(transcript = "", memory = {}) {
  if (isPhoneCaptureRefusal(transcript)) return "phone_capture_refused";

  const capture = evaluateSpokenPhoneCapture(transcript);
  if (capture.ok) return "phone_number_candidate";

  if (looksLikePartialPhoneCapture(transcript) && shouldRetryPhoneCapture(memory)) {
    return "phone_capture_partial";
  }

  if (shouldRetryPhoneCapture(memory)) {
    return "phone_capture_partial";
  }

  return "phone_capture_failed";
}

export function buildPhoneCaptureRetryMemoryPatch(memory = {}) {
  const nextCount = resolvePhoneCaptureAttemptCount(memory) + 1;
  return {
    contact_preference: memory?.contact_preference ?? "phone",
    contact_flow_pending: true,
    phone_capture_attempted: true,
    phone_present: false,
    phone_capture_attempt_count: nextCount,
    phone_capture_max_retries: resolvePhoneCaptureMaxRetries(memory),
    callback_flow_state: CALLBACK_FLOW_STATES.PHONE_NUMBER_PENDING,
    current_state: "collecting_phone_number",
  };
}

export function resolvePhoneCaptureEndpointSilenceMs(config = {}, memory = {}) {
  const base = Number(config?.v4?.endpointSilenceMs ?? 600);
  if (!isPhoneCaptureLocked(memory)) return base;
  const extended = Number(config?.v4?.phoneCaptureEndpointSilenceMs ?? 0);
  if (Number.isFinite(extended) && extended > 0) return extended;
  return Math.max(base, 1200);
}
