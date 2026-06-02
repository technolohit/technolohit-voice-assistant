import process from "node:process";

const BRIDGE_VERSION = "0.2.0";

function readBool(name, defaultValue = false) {
  const raw = String(process.env[name] ?? "")
    .trim()
    .toLowerCase();
  if (!raw) return defaultValue;
  return raw === "true" || raw === "1" || raw === "yes";
}

function readInt(name, defaultValue) {
  const parsed = Number.parseInt(String(process.env[name] ?? ""), 10);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

function readFloat(name, defaultValue) {
  const parsed = Number.parseFloat(String(process.env[name] ?? ""));
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

export function loadConfig() {
  const host = String(process.env.VOICE_DB_HOST ?? "10.20.0.1").trim();
  const port = readInt("VOICE_DB_PORT", 5432);
  const database = String(
    process.env.VOICE_DB_NAME ?? "technolohit_growth",
  ).trim();
  const user = String(process.env.VOICE_DB_USER ?? "").trim();
  const password = String(process.env.VOICE_DB_PASSWORD ?? "");
  const ssl = readBool("VOICE_DB_SSL", false);

  const listenHost = String(process.env.VOICE_BRIDGE_HOST ?? "0.0.0.0").trim();
  const listenPort = readInt("VOICE_BRIDGE_PORT", 9092);
  const greetingMode = String(
    process.env.VOICE_GREETING_MODE ?? "default",
  ).trim();
  const greetingFile = String(process.env.VOICE_GREETING_FILE ?? "").trim();
  const sampleRate = readInt("VOICE_SAMPLE_RATE", 8000);
  const frameMs = readInt("VOICE_FRAME_MS", 20);
  const toneDurationMs = readInt("VOICE_TONE_DURATION_MS", 800);
  const toneFrequencyHz = readInt("VOICE_TONE_FREQUENCY_HZ", 440);
  const inboundLogEvery = readInt("VOICE_INBOUND_LOG_EVERY", 50);
  const recordingEnabled = readBool("VOICE_RECORDING_ENABLED", true);
  const recordingMaxSeconds = readInt("VOICE_RECORDING_MAX_SECONDS", 300);
  const recordingDir = String(
    process.env.VOICE_RECORDING_DIR ?? "/app/recordings",
  ).trim();
  const transcriptionEnabled = readBool("VOICE_TRANSCRIPTION_ENABLED", false);
  const transcriptionModel = String(
    process.env.VOICE_TRANSCRIPTION_MODEL ?? "gpt-4o-mini-transcribe",
  ).trim();
  const transcriptionLanguage = String(
    process.env.VOICE_TRANSCRIPTION_LANGUAGE ?? "de",
  ).trim();
  const transcriptionPrompt = String(
    process.env.VOICE_TRANSCRIPTION_PROMPT ?? "",
  ).trim();
  const knowledgeRetrievalEnabled = readBool(
    "VOICE_KNOWLEDGE_RETRIEVAL_ENABLED",
    true,
  );
  const knowledgeRetrievalMinScore = Math.max(
    1,
    readInt("VOICE_KNOWLEDGE_RETRIEVAL_MIN_SCORE", 1),
  );
  const ragEnabled = readBool("VOICE_RAG_ENABLED", false);
  const ragApiUrl = String(process.env.VOICE_RAG_API_URL ?? "").trim();
  const ragTimeoutMs = Math.max(100, readInt("VOICE_RAG_TIMEOUT_MS", 700));
  const ragMinScore = Math.min(
    1,
    Math.max(0, readFloat("VOICE_RAG_MIN_SCORE", 0.72)),
  );
  const ragQaMode = readBool("VOICE_RAG_QA_MODE", false);
  const ragQaTimeoutMs = Math.max(
    ragTimeoutMs,
    readInt("VOICE_RAG_QA_TIMEOUT_MS", 1200),
  );
  const ragQaRetryDelta = Math.min(
    0.3,
    Math.max(0, readFloat("VOICE_RAG_QA_RETRY_DELTA", 0.08)),
  );
  const ragQaAcceptFloor = Math.min(
    1,
    Math.max(0, readFloat("VOICE_RAG_QA_ACCEPT_FLOOR", 0.65)),
  );
  const ragSalesAnswererEnabled = readBool(
    "VOICE_RAG_SALES_ANSWERER_ENABLED",
    false,
  );
  const semanticIntentEnabled = readBool(
    "VOICE_SEMANTIC_INTENT_ENABLED",
    false,
  );
  const semanticIntentMode = String(
    process.env.VOICE_SEMANTIC_INTENT_MODE ?? "deterministic",
  ).trim();
  const semanticIntentModel = String(
    process.env.VOICE_SEMANTIC_INTENT_MODEL ?? "",
  ).trim();
  const semanticIntentMinAccept = Math.min(
    1,
    Math.max(0, readFloat("VOICE_SEMANTIC_INTENT_MIN_ACCEPT", 0.75)),
  );
  const semanticIntentMinSoft = Math.min(
    1,
    Math.max(0, readFloat("VOICE_SEMANTIC_INTENT_MIN_SOFT", 0.45)),
  );
  const conversationRepairEnabled = readBool(
    "VOICE_CONVERSATION_REPAIR_ENABLED",
    false,
  );
  const asrDiagnosticsEnabled = readBool(
    "VOICE_ASR_DIAGNOSTICS_ENABLED",
    false,
  );
  const leadPolicyStrictCallback = readBool(
    "VOICE_LEAD_POLICY_STRICT_CALLBACK",
    true,
  );
  const assistantEnabled = readBool("VOICE_ASSISTANT_ENABLED", false);
  const turnListenSeconds = readInt("VOICE_TURN_LISTEN_SECONDS", 5);
  const assistantMinListenMs = readInt("VOICE_ASSISTANT_MIN_LISTEN_MS", 2500);
  const assistantMaxListenMs = readInt(
    "VOICE_ASSISTANT_MAX_LISTEN_MS",
    Math.max(assistantMinListenMs, turnListenSeconds * 1000, 10000),
  );
  const assistantEndSilenceMs = readInt("VOICE_ASSISTANT_END_SILENCE_MS", 900);
  const assistantModel = String(
    process.env.VOICE_ASSISTANT_MODEL ?? "gpt-4o-mini",
  ).trim();
  const assistantTtsModel = String(
    process.env.VOICE_ASSISTANT_TTS_MODEL ?? "gpt-4o-mini-tts",
  ).trim();
  const assistantTtsVoice = String(
    process.env.VOICE_ASSISTANT_TTS_VOICE ?? "marin",
  ).trim();
  const assistantMaxTurns = readInt("VOICE_ASSISTANT_MAX_TURNS", 3);
  const assistantMaxTurnsWithIntake = readInt(
    "VOICE_ASSISTANT_MAX_TURNS_WITH_INTAKE",
    Math.max(assistantMaxTurns, assistantMaxTurns + 2),
  );
  const assistantEndOnSilence = readBool(
    "VOICE_ASSISTANT_END_ON_SILENCE",
    true,
  );
  const assistantMinTranscriptChars = readInt(
    "VOICE_ASSISTANT_MIN_TRANSCRIPT_CHARS",
    5,
  );
  const assistantMaxResponseChars = readInt(
    "VOICE_ASSISTANT_MAX_RESPONSE_CHARS",
    160,
  );
  const assistantMaxResponseSentences = readInt(
    "VOICE_ASSISTANT_MAX_RESPONSE_SENTENCES",
    2,
  );
  const assistantTtsSpeed = Math.min(
    1.15,
    Math.max(0.75, readFloat("VOICE_ASSISTANT_TTS_SPEED", 1.0)),
  );
  const assistantLogTranscriptPreview = readBool(
    "VOICE_LOG_TRANSCRIPT_PREVIEW",
    false,
  );
  const assistantQaLogTranscriptPreview = readBool(
    "VOICE_QA_LOG_TRANSCRIPT_PREVIEW",
    false,
  );
  const assistantContactEmail = String(
    process.env.VOICE_CONTACT_EMAIL ?? "",
  ).trim();
  const assistantWebsiteUrl = String(
    process.env.VOICE_WEBSITE_URL ?? "",
  ).trim();
  const assistantContactFormUrl = String(
    process.env.VOICE_CONTACT_FORM_URL ?? "",
  ).trim();
  const postCallSummaryEnabled = readBool(
    "VOICE_POST_CALL_SUMMARY_ENABLED",
    true,
  );
  const postCallLeadExtractionEnabled = readBool(
    "VOICE_POST_CALL_LEAD_EXTRACTION_ENABLED",
    true,
  );
  const postCallNotifyEnabled = readBool(
    "VOICE_POST_CALL_NOTIFY_ENABLED",
    false,
  );
  const postCallNotifyWebhookUrl = String(
    process.env.VOICE_POST_CALL_NOTIFY_WEBHOOK_URL ?? "",
  ).trim();
  const postCallNotifyTimeoutMs = Math.max(
    1000,
    readInt("VOICE_POST_CALL_NOTIFY_TIMEOUT_MS", 8000),
  );
  const v4PlaybackCancelSpikeEnabled = readBool(
    "VOICE_V4_PLAYBACK_CANCEL_SPIKE_ENABLED",
    false,
  );
  const v4PlaybackCancelSpikeRmsThreshold = Math.max(
    100,
    readInt("VOICE_V4_PLAYBACK_CANCEL_SPIKE_RMS_THRESHOLD", 450),
  );
  const v4PlaybackCancelSpikeSpeechFrames = Math.max(
    1,
    readInt("VOICE_V4_PLAYBACK_CANCEL_SPIKE_SPEECH_FRAMES", 3),
  );
  const v4InterruptionContextSpikeEnabled = readBool(
    "VOICE_V4_INTERRUPTION_CONTEXT_SPIKE_ENABLED",
    false,
  );
  const runtimeVersion = String(process.env.VOICE_RUNTIME_VERSION ?? "v3")
    .trim()
    .toLowerCase();
  const v4RealtimeEnabled = readBool("VOICE_V4_REALTIME_ENABLED", false);
  const v4BargeInEnabled = readBool("VOICE_V4_BARGE_IN_ENABLED", false);
  const v4StreamingSttEnabled = readBool(
    "VOICE_V4_STREAMING_STT_ENABLED",
    false,
  );
  const v4StreamingTtsEnabled = readBool(
    "VOICE_V4_STREAMING_TTS_ENABLED",
    false,
  );
  const v4CanaryEnabled = readBool("VOICE_V4_CANARY_ENABLED", false);
  const v4VadRmsThreshold = Math.max(
    1,
    readInt("VOICE_V4_VAD_RMS_THRESHOLD", 450),
  );
  const v4VadSpeechFrames = Math.max(
    1,
    readInt("VOICE_V4_VAD_SPEECH_FRAMES", 3),
  );
  const v4EndpointSilenceMs = Math.max(
    0,
    readInt("VOICE_V4_ENDPOINT_SILENCE_MS", 600),
  );
  const v4EndpointMinSpeechMs = Math.max(
    0,
    readInt("VOICE_V4_ENDPOINT_MIN_SPEECH_MS", 240),
  );
  const v4SttProvider = String(process.env.VOICE_V4_STT_PROVIDER ?? "mock")
    .trim()
    .toLowerCase();
  const v4TtsProvider = String(process.env.VOICE_V4_TTS_PROVIDER ?? "mock")
    .trim()
    .toLowerCase();
  const v4TtsCacheEnabled = readBool("VOICE_V4_TTS_CACHE_ENABLED", true);
  const v4BargeInRmsThreshold = Math.max(
    1,
    readInt("VOICE_V4_BARGE_IN_RMS_THRESHOLD", v4VadRmsThreshold),
  );
  const v4BargeInSpeechFrames = Math.max(
    1,
    readInt("VOICE_V4_BARGE_IN_SPEECH_FRAMES", v4VadSpeechFrames),
  );
  const v4BargeInMinPlaybackMs = Math.max(
    0,
    readInt("VOICE_V4_BARGE_IN_MIN_PLAYBACK_MS", 120),
  );
  const v4BargeInCancelTimeoutMs = Math.max(
    50,
    readInt("VOICE_V4_BARGE_IN_CANCEL_TIMEOUT_MS", 400),
  );
  const v4InterruptFollowupWaitMs = Math.max(
    500,
    readInt("VOICE_V4_INTERRUPT_FOLLOWUP_WAIT_MS", 2200),
  );
  const v4InterruptFollowupMaxMs = Math.max(
    v4InterruptFollowupWaitMs,
    readInt("VOICE_V4_INTERRUPT_FOLLOWUP_MAX_MS", 3000),
  );
  const v4InterruptMarkerOnlyMinChars = Math.max(
    8,
    readInt("VOICE_V4_INTERRUPT_MARKER_ONLY_MIN_CHARS", 12),
  );
  const v4LiveAudioSocketEnabled = readBool(
    "VOICE_V4_LIVE_AUDIOSOCKET_ENABLED",
    false,
  );
  const v4LiveCanaryAllowlistRaw = String(
    process.env.VOICE_V4_LIVE_CANARY_ALLOWLIST ?? "",
  ).trim();
  const v4LiveCanaryAllowlist = v4LiveCanaryAllowlistRaw
    ? v4LiveCanaryAllowlistRaw
        .split(/[,;\s]+/)
        .map((entry) => entry.trim())
        .filter(Boolean)
    : [];
  const tenantId = String(process.env.VOICE_TENANT_ID ?? "technolohit").trim();
  const agentId = String(
    process.env.VOICE_AGENT_ID ?? "main_voice_sales",
  ).trim();
  const agentConfigPath = String(
    process.env.VOICE_AGENT_CONFIG_PATH ?? "",
  ).trim();
  const buildVersion = String(
    process.env.BUILD_VERSION || process.env.IMAGE_TAG || "unknown",
  ).trim();
  const imageTag = String(process.env.IMAGE_TAG || "").trim();
  const gitSha = String(process.env.GIT_SHA || "").trim();

  return {
    bridgeVersion: BRIDGE_VERSION,
    buildVersion,
    imageTag,
    gitSha,
    listenHost,
    listenPort,
    greetingMode,
    greetingFile,
    sampleRate,
    frameMs,
    toneDurationMs,
    toneFrequencyHz,
    inboundLogEvery,
    recording: {
      enabled: recordingEnabled,
      maxSeconds: recordingMaxSeconds,
      dir: recordingDir,
    },
    transcription: {
      enabled: transcriptionEnabled,
      model: transcriptionModel,
      language: transcriptionLanguage,
      prompt: transcriptionPrompt,
    },
    knowledgeRetrieval: {
      enabled: knowledgeRetrievalEnabled,
      minScore: knowledgeRetrievalMinScore,
    },
    rag: {
      enabled: ragEnabled,
      apiUrl: ragApiUrl,
      timeoutMs: ragTimeoutMs,
      minScore: ragMinScore,
      qaMode: ragQaMode,
      qaTimeoutMs: ragQaTimeoutMs,
      qaRetryDelta: ragQaRetryDelta,
      qaAcceptFloor: ragQaAcceptFloor,
      salesAnswererEnabled: ragSalesAnswererEnabled,
    },
    semanticIntent: {
      enabled: semanticIntentEnabled,
      mode: semanticIntentMode,
      model: semanticIntentModel,
      minAccept: semanticIntentMinAccept,
      minSoft: semanticIntentMinSoft,
    },
    conversationRepair: {
      enabled: conversationRepairEnabled,
    },
    asrDiagnostics: {
      enabled: asrDiagnosticsEnabled,
    },
    leadPolicy: {
      /** Always-on by default: blocks fake team_callback without valid phone. Set false only to restore legacy next_action. */
      strictCallback: leadPolicyStrictCallback,
    },
    postCallSummary: {
      enabled: postCallSummaryEnabled,
    },
    postCallLeadExtraction: {
      enabled: postCallLeadExtractionEnabled,
    },
    postCallNotify: {
      enabled: postCallNotifyEnabled,
      webhookUrl: postCallNotifyWebhookUrl,
      timeoutMs: postCallNotifyTimeoutMs,
    },
    v4PlaybackCancelSpike: {
      enabled: v4PlaybackCancelSpikeEnabled,
      speechRmsThreshold: v4PlaybackCancelSpikeRmsThreshold,
      speechFramesRequired: v4PlaybackCancelSpikeSpeechFrames,
    },
    v4InterruptionContextSpike: {
      enabled: v4InterruptionContextSpikeEnabled,
    },
    v4: {
      runtimeVersion,
      realtimeEnabled: v4RealtimeEnabled,
      bargeInEnabled: v4BargeInEnabled,
      streamingSttEnabled: v4StreamingSttEnabled,
      streamingTtsEnabled: v4StreamingTtsEnabled,
      canaryEnabled: v4CanaryEnabled,
      vadRmsThreshold: v4VadRmsThreshold,
      vadSpeechFrames: v4VadSpeechFrames,
      endpointSilenceMs: v4EndpointSilenceMs,
      endpointMinSpeechMs: v4EndpointMinSpeechMs,
      sttProvider: v4SttProvider,
      ttsProvider: v4TtsProvider,
      ttsCacheEnabled: v4TtsCacheEnabled,
      bargeInRmsThreshold: v4BargeInRmsThreshold,
      bargeInSpeechFrames: v4BargeInSpeechFrames,
      bargeInMinPlaybackMs: v4BargeInMinPlaybackMs,
      bargeInCancelTimeoutMs: v4BargeInCancelTimeoutMs,
      interruptFollowupWaitMs: v4InterruptFollowupWaitMs,
      interruptFollowupMaxMs: v4InterruptFollowupMaxMs,
      interruptMarkerOnlyMinChars: v4InterruptMarkerOnlyMinChars,
      liveAudioSocketEnabled: v4LiveAudioSocketEnabled,
      liveCanaryAllowlist: v4LiveCanaryAllowlist,
      tenantId,
      agentId,
      agentConfigPath,
    },
    assistant: {
      enabled: assistantEnabled,
      listenSeconds: turnListenSeconds,
      minListenMs: assistantMinListenMs,
      maxListenMs: assistantMaxListenMs,
      endSilenceMs: assistantEndSilenceMs,
      model: assistantModel,
      ttsModel: assistantTtsModel,
      ttsVoice: assistantTtsVoice,
      ttsSpeed: assistantTtsSpeed,
      maxTurns: assistantMaxTurns,
      maxTurnsWithIntake: assistantMaxTurnsWithIntake,
      endOnSilence: assistantEndOnSilence,
      minTranscriptChars: assistantMinTranscriptChars,
      maxResponseChars: assistantMaxResponseChars,
      maxResponseSentences: assistantMaxResponseSentences,
      logTranscriptPreview: assistantLogTranscriptPreview,
      qaLogTranscriptPreview: assistantQaLogTranscriptPreview,
      contactEmail: assistantContactEmail,
      websiteUrl: assistantWebsiteUrl,
      contactFormUrl: assistantContactFormUrl,
    },
    db: {
      host,
      port,
      database,
      user,
      password,
      ssl,
      enabled: Boolean(user && password),
    },
  };
}
