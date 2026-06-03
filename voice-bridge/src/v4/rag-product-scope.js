/**
 * Phase 10U - product scope helpers for RAG retrieval and result validation.
 */

import { normalizeText } from "./redaction.js";
import { resolveCurrentProductContext } from "./product-context-persistence.js";

const PRODUCT_ALIASES = {
  smart_website: ["smart website", "smarte website", "intelligente website", "intelligente webseite"],
  voice_agent: [
    "digitale rezeption",
    "digitaler telefonassistent",
    "voice agent",
    "ai voice assistant",
    "ki voice assistant",
    "telefonassistent",
  ],
  lokalki: ["lokalki", "lokal ki", "lokale ki", "private ki"],
  aiseoq: ["aiseoq", "ai seo q", "seo workspace"],
  botinteg: ["botinteg", "bot integ"],
};

export function resolveRagProductScope(memory = {}) {
  return resolveCurrentProductContext(memory);
}

export function ragChunkMatchesProductScope(chunk = {}, productScope = null) {
  const scope = String(productScope ?? "").trim();
  if (!scope) return true;

  const metadataProduct = String(
    chunk?.metadata?.product_id ??
      chunk?.metadata?.product ??
      chunk?.metadata?.product_scope ??
      "",
  ).trim();
  if (metadataProduct) return metadataProduct === scope;

  const haystack = normalizeText(
    [
      chunk?.source_uri,
      chunk?.title,
      chunk?.snippet,
      chunk?.text,
      chunk?.content,
    ]
      .filter(Boolean)
      .join(" "),
  ).toLowerCase();

  if (!haystack) return false;
  if (haystack.includes(`#${scope}`) || haystack.includes(scope.replaceAll("_", " "))) {
    return true;
  }
  return (PRODUCT_ALIASES[scope] ?? []).some((alias) => haystack.includes(alias));
}

export function filterRagChunksByProductScope(chunks = [], productScope = null) {
  const list = Array.isArray(chunks) ? chunks : [];
  if (!productScope) return list;
  return list.filter((chunk) => ragChunkMatchesProductScope(chunk, productScope));
}
