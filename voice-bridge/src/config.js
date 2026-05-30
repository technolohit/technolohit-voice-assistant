import process from "node:process";

const BRIDGE_VERSION = "0.2.0";

function readBool(name, defaultValue = false) {
  const raw = String(process.env[name] ?? "").trim().toLowerCase();
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
  const database = String(process.env.VOICE_DB_NAME ?? "technolohit_growth").trim();
  const user = String(process.env.VOICE_DB_USER ?? "").trim();
  const password = String(process.env.VOICE_DB_PASSWORD ?? "");
  const ssl = readBool("VOICE_DB_SSL", false);

  const listenHost = String(process.env.VOICE_BRIDGE_HOST ?? "0.0.0.0").trim();
  const listenPort = readInt("VOICE_BRIDGE_PORT", 9092);
  const greetingMode = String(process.env.VOICE_GREETING_MODE ?? "default").trim();
  const greetingFile = String(process.env.VOICE_GREETING_FILE ?? "").trim();
  const sampleRate = readInt("VOICE_SAMPLE_RATE", 8000);
  const frameMs = readInt("VOICE_FRAME_MS", 20);
  const toneDurationMs = readInt("VOICE_TONE_DURATION_MS", 800);
  const toneFrequencyHz = readInt("VOICE_TONE_FREQUENCY_HZ", 440);
  const inboundLogEvery = readInt("VOICE_INBOUND_LOG_EVERY", 50);
  const recordingEnabled = readBool("VOICE_RECORDING_ENABLED", true);
  const recordingMaxSeconds = readInt("VOICE_RECORDING_MAX_SECONDS", 300);
  const recordingDir = String(process.env.VOICE_RECORDING_DIR ?? "/app/recordings").trim();
  const transcriptionEnabled = readBool("VOICE_TRANSCRIPTION_ENABLED", false);
  const transcriptionModel = String(
    process.env.VOICE_TRANSCRIPTION_MODEL ?? "gpt-4o-mini-transcribe"
  ).trim();
  const transcriptionLanguage = String(process.env.VOICE_TRANSCRIPTION_LANGUAGE ?? "de").trim();
  const transcriptionPrompt = String(process.env.VOICE_TRANSCRIPTION_PROMPT ?? "").trim();
  const knowledgeRetrievalEnabled = readBool("VOICE_KNOWLEDGE_RETRIEVAL_ENABLED", true);
  const knowledgeRetrievalMinScore = Math.max(1, readInt("VOICE_KNOWLEDGE_RETRIEVAL_MIN_SCORE", 1));
  const ragEnabled = readBool("VOICE_RAG_ENABLED", false);
  const ragApiUrl = String(process.env.VOICE_RAG_API_URL ?? "").trim();
  const ragTimeoutMs = Math.max(100, readInt("VOICE_RAG_TIMEOUT_MS", 700));
  const ragMinScore = Math.min(1, Math.max(0, readFloat("VOICE_RAG_MIN_SCORE", 0.72)));
  const ragQaMode = readBool("VOICE_RAG_QA_MODE", false);
  const ragQaTimeoutMs = Math.max(ragTimeoutMs, readInt("VOICE_RAG_QA_TIMEOUT_MS", 1200));
  const ragQaRetryDelta = Math.min(0.3, Math.max(0, readFloat("VOICE_RAG_QA_RETRY_DELTA", 0.08)));
  const ragQaAcceptFloor = Math.min(1, Math.max(0, readFloat("VOICE_RAG_QA_ACCEPT_FLOOR", 0.65)));
  const assistantEnabled = readBool("VOICE_ASSISTANT_ENABLED", false);
  const turnListenSeconds = readInt("VOICE_TURN_LISTEN_SECONDS", 5);
  const assistantMinListenMs = readInt("VOICE_ASSISTANT_MIN_LISTEN_MS", 2500);
  const assistantMaxListenMs = readInt(
    "VOICE_ASSISTANT_MAX_LISTEN_MS",
    Math.max(assistantMinListenMs, turnListenSeconds * 1000, 10000)
  );
  const assistantEndSilenceMs = readInt("VOICE_ASSISTANT_END_SILENCE_MS", 900);
  const assistantModel = String(process.env.VOICE_ASSISTANT_MODEL ?? "gpt-4o-mini").trim();
  const assistantTtsModel = String(
    process.env.VOICE_ASSISTANT_TTS_MODEL ?? "gpt-4o-mini-tts"
  ).trim();
  const assistantTtsVoice = String(process.env.VOICE_ASSISTANT_TTS_VOICE ?? "marin").trim();
  const assistantMaxTurns = readInt("VOICE_ASSISTANT_MAX_TURNS", 3);
  const assistantMaxTurnsWithIntake = readInt(
    "VOICE_ASSISTANT_MAX_TURNS_WITH_INTAKE",
    Math.max(assistantMaxTurns, assistantMaxTurns + 2)
  );
  const assistantEndOnSilence = readBool("VOICE_ASSISTANT_END_ON_SILENCE", true);
  const assistantMinTranscriptChars = readInt("VOICE_ASSISTANT_MIN_TRANSCRIPT_CHARS", 5);
  const assistantMaxResponseChars = readInt("VOICE_ASSISTANT_MAX_RESPONSE_CHARS", 160);
  const assistantMaxResponseSentences = readInt("VOICE_ASSISTANT_MAX_RESPONSE_SENTENCES", 2);
  const assistantTtsSpeed = Math.min(1.15, Math.max(0.75, readFloat("VOICE_ASSISTANT_TTS_SPEED", 1.0)));
  const assistantLogTranscriptPreview = readBool("VOICE_LOG_TRANSCRIPT_PREVIEW", false);
  const assistantQaLogTranscriptPreview = readBool("VOICE_QA_LOG_TRANSCRIPT_PREVIEW", false);
  const assistantContactEmail = String(process.env.VOICE_CONTACT_EMAIL ?? "").trim();
  const assistantWebsiteUrl = String(process.env.VOICE_WEBSITE_URL ?? "").trim();
  const assistantContactFormUrl = String(process.env.VOICE_CONTACT_FORM_URL ?? "").trim();
  const postCallSummaryEnabled = readBool("VOICE_POST_CALL_SUMMARY_ENABLED", true);
  const postCallLeadExtractionEnabled = readBool("VOICE_POST_CALL_LEAD_EXTRACTION_ENABLED", true);
  const postCallNotifyEnabled = readBool("VOICE_POST_CALL_NOTIFY_ENABLED", false);
  const postCallNotifyWebhookUrl = String(process.env.VOICE_POST_CALL_NOTIFY_WEBHOOK_URL ?? "").trim();
  const postCallNotifyTimeoutMs = Math.max(1000, readInt("VOICE_POST_CALL_NOTIFY_TIMEOUT_MS", 8000));
  const buildVersion = String(process.env.BUILD_VERSION || process.env.IMAGE_TAG || "unknown").trim();
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
      dir: recordingDir
    },
    transcription: {
      enabled: transcriptionEnabled,
      model: transcriptionModel,
      language: transcriptionLanguage,
      prompt: transcriptionPrompt
    },
    knowledgeRetrieval: {
      enabled: knowledgeRetrievalEnabled,
      minScore: knowledgeRetrievalMinScore
    },
    rag: {
      enabled: ragEnabled,
      apiUrl: ragApiUrl,
      timeoutMs: ragTimeoutMs,
      minScore: ragMinScore,
      qaMode: ragQaMode,
      qaTimeoutMs: ragQaTimeoutMs,
      qaRetryDelta: ragQaRetryDelta,
      qaAcceptFloor: ragQaAcceptFloor
    },
    postCallSummary: {
      enabled: postCallSummaryEnabled
    },
    postCallLeadExtraction: {
      enabled: postCallLeadExtractionEnabled
    },
    postCallNotify: {
      enabled: postCallNotifyEnabled,
      webhookUrl: postCallNotifyWebhookUrl,
      timeoutMs: postCallNotifyTimeoutMs
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
      contactFormUrl: assistantContactFormUrl
    },
    db: {
      host,
      port,
      database,
      user,
      password,
      ssl,
      enabled: Boolean(user && password)
    }
  };
}
