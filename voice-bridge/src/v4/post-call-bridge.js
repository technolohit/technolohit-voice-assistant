/**
 * v4 post-call metadata bridge — summary/lead inputs without enabling production v4.
 */

import { getAgentVersionMetadata } from "./agent-config.js";
import { serializeMemoryForPersistence } from "./call-session-memory.js";
import { buildLeadCandidateFromMemory } from "./lead-candidate.js";
import { sanitizeOutboundObject, assertNoRawPhoneInPayload } from "./privacy-sanitize.js";

export function mergeV4SummaryMetadataPatch(base = {}, v4Patch = null) {
  if (!v4Patch || typeof v4Patch !== "object") return base;
  return sanitizeOutboundObject({ ...base, ...v4Patch });
}

export function buildV4PostCallSummaryMetadata({
  memory = {},
  agentConfig = null,
  leadCandidate = null,
  options = {}
} = {}) {
  const version = agentConfig?.ok
    ? getAgentVersionMetadata(agentConfig.config)
    : {
        tenant_id: memory.tenant_id ?? "technolohit",
        agent_id: memory.agent_id ?? "main_voice_sales",
        agent_config_version: null,
        prompt_playbook_version: null,
        knowledge_version: null,
        runtime_version: "v4"
      };

  const candidate =
    leadCandidate ??
    buildLeadCandidateFromMemory(memory, {
      callerPhoneNormalized: options.callerPhoneNormalized,
      callerPhoneRaw: options.callerPhoneRaw,
      source: options.source ?? "v4_post_call_bridge"
    });

  const metadata = {
    v4_runtime: true,
    tenant_id: version.tenant_id,
    agent_id: version.agent_id,
    agent_config_version: version.agent_config_version ?? null,
    prompt_playbook_version: version.prompt_playbook_version ?? null,
    knowledge_version: version.knowledge_version ?? null,
    runtime_version: version.runtime_version ?? "v4",
    product_interest: candidate.product_interest ?? "none",
    customer_type: candidate.customer_type ?? null,
    contact_preference: candidate.contact_preference ?? "unknown",
    permission: candidate.callback_permission ?? "unknown",
    phone_present: candidate.phone_present,
    email_directed: candidate.email_present || candidate.contact_preference === "email",
    next_action: candidate.next_action,
    callback_ready: candidate.callback_ready,
    lead_ready: candidate.lead_ready,
    confidence: options.confidence ?? "medium",
    transcript_quality_notes: options.transcriptQualityNotes ?? "v4_canary_memory",
    v4_memory_snapshot: serializeMemoryForPersistence(memory),
    include_full_transcript: false
  };

  return sanitizeOutboundObject(metadata);
}

export function buildV4PostCallLeadInputs({ memory, leadCandidate, summaryMetadata }) {
  const candidate = leadCandidate ?? buildLeadCandidateFromMemory(memory);
  return {
    should_create: Boolean(candidate.callback_ready || candidate.next_action === "await_customer_email"),
    next_action: candidate.next_action,
    metadata_patch: sanitizeOutboundObject({
      ...summaryMetadata,
      v4_lead_candidate: {
        callback_ready: candidate.callback_ready,
        validation_reason: candidate.validation?.reason ?? null,
        phone_masked: candidate.phone_masked ?? null
      }
    })
  };
}

export function finalizeV4PostCallHandoff(orchestrator, options = {}) {
  const memory = orchestrator?.memory ?? {};
  const leadCandidate = buildLeadCandidateFromMemory(memory, {
    callerPhoneNormalized: options.callerPhoneNormalized ?? orchestrator?.callerPhoneNormalized,
    callerPhoneRaw: options.callerPhoneRaw ?? orchestrator?.callerPhoneRaw,
    source: "dialogue_orchestrator_close"
  });
  const summaryMetadata = buildV4PostCallSummaryMetadata({
    memory,
    agentConfig: orchestrator?.agentConfig ?? null,
    leadCandidate,
    options
  });
  const leadInputs = buildV4PostCallLeadInputs({ memory, leadCandidate, summaryMetadata });
  return {
    leadCandidate,
    summaryMetadata,
    leadInputs,
    privacy_ok: assertNoRawPhoneInPayload({ summaryMetadata, leadCandidate })
  };
}
