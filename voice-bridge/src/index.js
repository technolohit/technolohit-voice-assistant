import process from "node:process";
import fs from "node:fs";
import { createAudioSocketServer } from "./audiosocket.js";
import { loadConfig } from "./config.js";
import { isDbConfigured } from "./db.js";
import { loadVoiceBridgeEnv } from "./load-env.js";
import * as persist from "./persist.js";
import { describeRuntimeRoute, describeLiveHandlerReadiness } from "./v4/runtime-router.js";
import { loadAgentConfig } from "./v4/agent-config.js";
import { finalizeAllActiveCallsOnShutdown } from "./call-finish.js";
import { checkRagApiHealth } from "./rag-client.js";

loadVoiceBridgeEnv();

const config = loadConfig();

function readPackageVersion() {
  try {
    const raw = fs.readFileSync(new URL("../package.json", import.meta.url), "utf8");
    return JSON.parse(raw).version || "unknown";
  } catch {
    return "unknown";
  }
}

async function shutdown(signal) {
  console.log(`[voice-bridge] shutting down (${signal})`);
  try {
    await finalizeAllActiveCallsOnShutdown(config, "process_shutdown");
  } catch (err) {
    console.error(
      `[voice-bridge] active_call_shutdown_error error=${err?.message ?? String(err)}`
    );
  }
  try {
    await persist.shutdownDb(config);
    process.exit(0);
  } catch {
    process.exit(1);
  }
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

const server = createAudioSocketServer(config);

server.on("error", (err) => {
  console.error(`[voice-bridge] server error: ${err.message}`);
  process.exit(1);
});

server.listen(config.listenPort, config.listenHost, () => {
  console.log(
    `[voice-bridge] startup app_version=${readPackageVersion()} bridge_version=${config.bridgeVersion} build_version=${config.buildVersion} image_tag=${config.imageTag || "unset"} git_sha=${config.gitSha || "unset"} node_env=${process.env.NODE_ENV || "unset"}`
  );
  console.log(
    `[voice-bridge] listening on ${config.listenHost}:${config.listenPort} version=${config.bridgeVersion}`
  );
  if (isDbConfigured(config)) {
    console.log(
      `[voice-db] persistence enabled -> ${config.db.host}:${config.db.port}/${config.db.database} schema=voice user=${config.db.user}`
    );
  } else {
    console.warn("[voice-db] persistence disabled - set VOICE_DB_USER and VOICE_DB_PASSWORD");
  }

  if (config.recording.enabled) {
    console.log(
      `[voice-recording] recording enabled dir=${config.recording.dir} max_seconds=${config.recording.maxSeconds}`
    );
  } else {
    console.log("[voice-recording] recording disabled");
  }

  if (config.transcription.enabled) {
    console.log(
      `[voice-transcribe] transcription enabled model=${config.transcription.model} language=${config.transcription.language}`
    );
  } else {
    console.log("[voice-transcribe] transcription disabled");
  }

  if (config.assistant.enabled) {
    console.log(
      `[voice-assistant] assistant enabled listen_seconds=${config.assistant.listenSeconds} min_listen_ms=${config.assistant.minListenMs} max_listen_ms=${config.assistant.maxListenMs} end_silence_ms=${config.assistant.endSilenceMs} max_turns=${config.assistant.maxTurns} max_turns_with_intake=${config.assistant.maxTurnsWithIntake} end_on_silence=${config.assistant.endOnSilence} min_chars=${config.assistant.minTranscriptChars} model=${config.assistant.model} tts_model=${config.assistant.ttsModel} tts_voice=${config.assistant.ttsVoice} tts_speed=${config.assistant.ttsSpeed} max_response_chars=${config.assistant.maxResponseChars} log_preview=${config.assistant.logTranscriptPreview} rag_enabled=${config.rag.enabled}`
    );
  } else {
    console.log("[voice-assistant] assistant disabled");
  }

  const runtimeRoute = describeRuntimeRoute(config);
  const liveReadiness = describeLiveHandlerReadiness(config);
  console.log(
    `[voice-runtime] selected_runtime=${runtimeRoute.selected_runtime} selected_runtime_active=${runtimeRoute.selected_runtime_active} v4_requested=${runtimeRoute.v4_requested} v4_runtime_active=${runtimeRoute.v4_runtime_active} reason=${runtimeRoute.reason} startup_router_mode=${liveReadiness.startup_router_mode} live_audiosocket_canary_configured=${liveReadiness.live_audiosocket_canary_configured} live_handler_selection=${liveReadiness.live_handler_selection} stt_provider=${config.v4.sttProvider} tenant_id=${config.v4.tenantId} agent_id=${config.v4.agentId} rag_enabled=${config.rag.enabled} rag_sales_answerer_enabled=${config.rag.salesAnswererEnabled} rag_api_configured=${Boolean(config.rag.apiUrl)}`
  );
  if (liveReadiness.startup_router_note) {
    console.log(`[voice-runtime] ${liveReadiness.startup_router_note}`);
  }
  if (liveReadiness.per_call_handler_evidence) {
    console.log(`[voice-runtime] per_call_evidence_required=${liveReadiness.per_call_handler_evidence}`);
  }

  if (config.rag.enabled || config.rag.salesAnswererEnabled) {
    checkRagApiHealth(config, { timeoutMs: Math.min(config.rag.timeoutMs, 700) })
      .then((health) => {
        console.log(
          `[voice-rag] health ok=${health.ok} reason=${health.reason} latency_ms=${health.latencyMs ?? "unknown"}`
        );
      })
      .catch(() => {
        console.warn("[voice-rag] health ok=false reason=health_check_failed latency_ms=unknown");
      });
  }

  const agentConfigResult = loadAgentConfig(config);
  if (agentConfigResult.ok) {
    console.log(
      `[voice-runtime] agent_config loaded path=${agentConfigResult.path} version=${agentConfigResult.config.agent_config_version}`
    );
  } else {
    console.warn(
      `[voice-runtime] agent_config unavailable error=${agentConfigResult.error} path=${agentConfigResult.path}`
    );
  }
});
