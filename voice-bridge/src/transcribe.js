import fs from "node:fs";
import OpenAI from "openai";
import * as persist from "./persist.js";

let client = null;

function getClient() {
  if (!client) {
    client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY
    });
  }
  return client;
}

function extractTranscriptText(response) {
  if (typeof response === "string") return response.trim();
  if (response?.text) return String(response.text).trim();
  return "";
}

function safeOpenAiError(err) {
  const status = err?.status ? `status=${err.status}` : "";
  const code = err?.code ? ` code=${err.code}` : "";
  const message = err?.message ?? String(err);
  return `${status}${code} ${message}`.trim();
}

export async function transcribeRecording(config, ctx, recording) {
  if (!config.transcription?.enabled) {
    return null;
  }

  const apiKey = String(process.env.OPENAI_API_KEY ?? "").trim();
  if (!apiKey) {
    const err = new Error("OPENAI_API_KEY is required when VOICE_TRANSCRIPTION_ENABLED=true");
    console.warn("[voice-transcribe] transcription enabled but OPENAI_API_KEY is missing");
    await persist.onTranscriptionFailed(config, ctx, err, {
      phase: "config",
      recordingWavPath: recording?.wavPath ?? ""
    });
    return null;
  }

  const model = config.transcription.model || "gpt-4o-mini-transcribe";
  const language = config.transcription.language || "de";

  try {
    const request = {
      file: fs.createReadStream(recording.wavPath),
      model,
      language,
      response_format: "json"
    };

    if (config.transcription.prompt) {
      request.prompt = config.transcription.prompt;
    }

    const response = await getClient().audio.transcriptions.create(request);
    const text = extractTranscriptText(response);
    if (!text) {
      throw new Error("transcription response did not include text");
    }

    const persisted = await persist.onTranscriptCreated(config, ctx, {
      text,
      model,
      language,
      recordingWavPath: recording.wavPath,
      recordingSlinPath: recording.slinPath,
      audioBytes: recording.audioBytes,
      sequenceNumber: 9999,
      transcriptScope: "full_call"
    });

    if (!persisted) {
      await persist.onTranscriptionFailed(config, ctx, new Error("transcript persistence failed"), {
        phase: "db",
        model,
        language,
        recordingWavPath: recording?.wavPath ?? ""
      });
      return null;
    }

    console.log(`[voice-transcribe] transcript created length=${text.length}`);
    return text;
  } catch (err) {
    await persist.onTranscriptionFailed(config, ctx, new Error(safeOpenAiError(err)), {
      phase: "openai",
      model,
      language,
      recordingWavPath: recording?.wavPath ?? ""
    });
    return null;
  }
}
