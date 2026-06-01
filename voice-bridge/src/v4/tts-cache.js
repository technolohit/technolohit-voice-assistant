/**
 * v4 TTS phrase cache — static prompts only; never cache personal/caller-specific text.
 */

import { createHash } from "node:crypto";
import { redactPhoneLikeText, normalizeText } from "./redaction.js";

const CACHEABLE_CATEGORIES = new Set([
  "greeting",
  "clarification",
  "closing",
  "handoff"
]);

const PHONE_LIKE = /\b(\+?\d[\d\s\-()/]{5,}\d)\b/;
const CALLER_SPECIFIC_PATTERNS = [
  /\b(herr|frau|mr\.|mrs\.|ms\.)\s+[A-ZÄÖÜ][a-zäöüß]+\b/i,
  /\b(ihr|dein|deine|your)\s+(name|nummer|telefon|email)\b/i,
  /\{\{.*\}\}/
];

export function buildCacheKey({ voice, model, language, text }) {
  const normalized = normalizeText(text);
  const hash = createHash("sha256")
    .update(`${voice ?? ""}|${model ?? ""}|${language ?? ""}|${normalized}`)
    .digest("hex")
    .slice(0, 32);
  return {
    key: hash,
    voice: String(voice ?? "").trim(),
    model: String(model ?? "").trim(),
    language: String(language ?? "").trim(),
    text_hash: hash
  };
}

export function shouldCachePhrase(text, category = null) {
  const normalized = normalizeText(text);
  if (!normalized) {
    return { cacheable: false, reason: "empty_text" };
  }
  if (PHONE_LIKE.test(normalized)) {
    return { cacheable: false, reason: "phone_like_text" };
  }
  for (const pattern of CALLER_SPECIFIC_PATTERNS) {
    if (pattern.test(normalized)) {
      return { cacheable: false, reason: "caller_specific_text" };
    }
  }
  if (category && !CACHEABLE_CATEGORIES.has(String(category))) {
    return { cacheable: false, reason: "category_not_cacheable" };
  }
  if (!category) {
    return { cacheable: false, reason: "category_required" };
  }
  return { cacheable: true, reason: "static_phrase" };
}

export function createTtsPhraseCache({ maxEntries = 128 } = {}) {
  const store = new Map();
  const max = Math.max(1, Number(maxEntries) || 128);

  return {
    maxEntries: max,
    size() {
      return store.size;
    },
    getCachedPhrase(keyOrParts) {
      const key =
        typeof keyOrParts === "string"
          ? keyOrParts
          : buildCacheKey(keyOrParts).key;
      const entry = store.get(key);
      if (!entry) return null;
      return { ...entry, hit: true };
    },
    putCachedPhrase(keyOrParts, value, meta = {}) {
      const built =
        typeof keyOrParts === "string" ? { key: keyOrParts } : buildCacheKey(keyOrParts);
      const eligibility = shouldCachePhrase(meta.text ?? value?.text ?? "", meta.category);
      if (!eligibility.cacheable) {
        return { ok: false, reason: eligibility.reason };
      }
      if (store.size >= max && !store.has(built.key)) {
        const firstKey = store.keys().next().value;
        store.delete(firstKey);
      }
      const safeText = redactPhoneLikeText(meta.text ?? value?.text ?? "");
      const entry = {
        key: built.key,
        audio: value?.audio ?? null,
        format: value?.format ?? "pcm_s16le",
        sample_rate: value?.sampleRate ?? 8000,
        text_preview: safeText.slice(0, 80),
        category: meta.category ?? null,
        cached_at: Date.now()
      };
      store.set(built.key, entry);
      return { ok: true, key: built.key };
    }
  };
}
