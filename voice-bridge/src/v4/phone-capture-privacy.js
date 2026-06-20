/**
 * Phase 10G privacy guard for phone-capture turns.
 *
 * Context-aware by design: spoken digit words are redacted only while the
 * callback flow is explicitly waiting for a phone number and the deterministic
 * phone parser finds a candidate.
 */

import { isPhoneNumberPendingStage } from "./callback-flow-policy.js";
import { parseSpokenPhoneCandidate } from "./spoken-phone-capture.js";

export const PHONE_REDACTED_TEXT = "[phone_redacted]";

export function shouldRedactPhoneCaptureTranscript(memory = {}, transcript = "") {
  if (!isPhoneNumberPendingStage(memory)) return false;
  return Boolean(parseSpokenPhoneCandidate(transcript));
}

export function sanitizePhoneCaptureTranscriptForPersistence(memory = {}, transcript = "") {
  return shouldRedactPhoneCaptureTranscript(memory, transcript)
    ? PHONE_REDACTED_TEXT
    : null;
}
