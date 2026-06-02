/**
 * Phase 10Q — hard stop marker detection and marker/continuation split.
 */

import { normalizeText } from "./redaction.js";
import {
  detectShortFollowUpCategory,
  hasSubstantiveFollowUpContent,
} from "./playbook-short-answer.js";

const EXACT_MARKER =
  /^(stopp|stop|halt|moment|warte)(\s*bitte)?(\s*,?\s*(stopp|stop))?[.!?\s]*$/i;

const LEADING_MARKER =
  /^\s*(stopp|stop|halt|moment|warte)(\s*,?\s*(stopp|stop))?(\s+bitte)?\s*([.!?,:]\s*|\s+)/i;

export function isHardStopMarkerText(transcript = "") {
  const text = normalizeText(transcript);
  if (!text) return false;
  const lower = text.toLowerCase();
  if (EXACT_MARKER.test(lower.trim())) return true;
  if (LEADING_MARKER.test(text)) return true;
  return false;
}

/**
 * Split "Stopp. Was kostet das?" into marker + continuation.
 */
export function splitInterruptMarkerAndContinuation(transcript = "") {
  const text = normalizeText(transcript);
  if (!text) {
    return {
      marker: null,
      continuation: "",
      marker_only: true,
      single_stop_detected: false,
    };
  }

  let marker = null;
  let continuation = "";

  const leading = text.match(LEADING_MARKER);
  if (leading) {
    marker = text.slice(0, leading[0].length).trim();
    continuation = text.slice(leading[0].length).trim();
  } else if (EXACT_MARKER.test(text.trim())) {
    marker = text.trim();
    continuation = "";
  } else {
    continuation = text;
  }

  const continuationSubstantive =
    Boolean(continuation) &&
    (hasSubstantiveFollowUpContent(continuation) ||
      Boolean(detectShortFollowUpCategory(continuation)));

  const marker_only =
    Boolean(marker) &&
    (!continuation || !continuationSubstantive) &&
    (EXACT_MARKER.test(marker) || isHardStopMarkerText(marker));

  const single_stop_detected =
    Boolean(marker) &&
    (marker_only || isHardStopMarkerText(marker) || isHardStopMarkerText(text));

  return {
    marker,
    continuation: continuationSubstantive ? continuation : marker_only ? "" : text,
    marker_only,
    single_stop_detected,
  };
}

export function markerCharCount(marker) {
  return marker ? String(marker).length : 0;
}

export function continuationCharCount(continuation) {
  return continuation ? String(continuation).length : 0;
}
