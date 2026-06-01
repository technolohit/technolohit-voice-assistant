/**
 * v4 agent config loader — versioned JSON seed, no secrets.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_AGENT_FILENAME = "technolohit.main_voice_sales.v4.json";

const REQUIRED_STRING_FIELDS = [
  "schema_version",
  "tenant_id",
  "agent_id",
  "agent_config_version",
  "prompt_playbook_version",
  "knowledge_version",
  "runtime_version"
];

export function resolveAgentConfigPath(config) {
  const explicit = String(
    config?.v4?.agentConfigPath ?? process.env.VOICE_AGENT_CONFIG_PATH ?? ""
  ).trim();
  const repoDefault = path.join(packageRoot, "config/agents", DEFAULT_AGENT_FILENAME);
  if (explicit) return explicit;
  return repoDefault;
}

export function validateAgentConfig(raw) {
  const errors = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, errors: ["agent config must be a JSON object"] };
  }

  for (const field of REQUIRED_STRING_FIELDS) {
    const value = String(raw[field] ?? "").trim();
    if (!value) errors.push(`missing required field: ${field}`);
  }

  if (!raw.company || typeof raw.company !== "object") {
    errors.push("missing required object: company");
  } else if (!String(raw.company.name ?? "").trim()) {
    errors.push("missing required field: company.name");
  }

  if (!raw.assistant || typeof raw.assistant !== "object") {
    errors.push("missing required object: assistant");
  } else if (!String(raw.assistant.language ?? "").trim()) {
    errors.push("missing required field: assistant.language");
  }

  if (!Array.isArray(raw.products) || raw.products.length === 0) {
    errors.push("products must be a non-empty array");
  }

  const secretKeys = ["api_key", "password", "secret", "token", "private_key"];
  for (const key of secretKeys) {
    if (key in raw) errors.push(`secret-like field is not allowed in agent config: ${key}`);
  }

  return { ok: errors.length === 0, errors };
}

export function loadAgentConfig(config) {
  const configPath = resolveAgentConfigPath(config);
  if (!fs.existsSync(configPath)) {
    return {
      ok: false,
      path: configPath,
      error: "agent_config_not_found",
      message: `Agent config not found at ${configPath}`
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (err) {
    return {
      ok: false,
      path: configPath,
      error: "agent_config_invalid_json",
      message: err?.message || "invalid JSON"
    };
  }

  const validation = validateAgentConfig(parsed);
  if (!validation.ok) {
    return {
      ok: false,
      path: configPath,
      error: "agent_config_validation_failed",
      message: validation.errors.join("; "),
      errors: validation.errors
    };
  }

  return { ok: true, path: configPath, config: parsed };
}

export function getAgentVersionMetadata(agentConfig) {
  const cfg = agentConfig?.config ?? agentConfig ?? {};
  return {
    tenant_id: String(cfg.tenant_id ?? "technolohit").trim(),
    agent_id: String(cfg.agent_id ?? "main_voice_sales").trim(),
    agent_config_version: String(cfg.agent_config_version ?? "").trim(),
    prompt_playbook_version: String(cfg.prompt_playbook_version ?? "").trim(),
    knowledge_version: String(cfg.knowledge_version ?? "").trim(),
    runtime_version: String(cfg.runtime_version ?? "").trim()
  };
}

function agentConfigRoot(agentConfig) {
  return agentConfig?.config ?? agentConfig ?? {};
}

export function getProductById(agentConfig, productId) {
  const products = Array.isArray(agentConfigRoot(agentConfig).products)
    ? agentConfigRoot(agentConfig).products
    : [];
  return products.find((product) => product.id === productId) ?? null;
}

export function matchProductAlias(agentConfig, text) {
  const normalized = String(text ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return null;

  const products = Array.isArray(agentConfigRoot(agentConfig).products)
    ? agentConfigRoot(agentConfig).products
    : [];
  for (const product of products) {
    const aliases = Array.isArray(product.aliases) ? product.aliases : [];
    for (const alias of aliases) {
      const aliasNorm = String(alias).toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").trim();
      if (aliasNorm && normalized.includes(aliasNorm)) {
        return product;
      }
    }
    const display = String(product.display_name ?? "").toLowerCase();
    if (display && normalized.includes(display)) return product;
  }
  return null;
}

export function getForbiddenClaims(agentConfig) {
  const claims = agentConfigRoot(agentConfig).forbidden_claims;
  return Array.isArray(claims) ? claims.map(String) : [];
}

export function getLeadFieldSchema(agentConfig) {
  const fields = agentConfigRoot(agentConfig).lead_fields;
  return Array.isArray(fields) ? fields.map(String) : [];
}

export function getClosingQuestion(agentConfig) {
  const handoff = agentConfigRoot(agentConfig).handoff ?? {};
  return String(handoff.closing_question_default ?? "Gibt es noch etwas, wobei ich Ihnen helfen kann?").trim();
}
