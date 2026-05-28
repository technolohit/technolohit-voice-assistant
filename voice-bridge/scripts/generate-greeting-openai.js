#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadVoiceBridgeEnv } from "../src/load-env.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = path.join(packageRoot, "audio", "greeting.wav");

const GREETING_TEXT =
  "Hallo, hier ist der digitale Assistent von TechnoloHit. Wobei kann ich Ihnen helfen?";

const TTS_INSTRUCTIONS =
  "Speak German with a warm, calm, professional business receptionist tone. Natural pacing, clear pronunciation, friendly but not salesy. The speaker should sound like a reliable digital assistant for a German technology company.";

function readSetting(name, defaultValue) {
  return String(process.env[name] ?? defaultValue).trim();
}

function truncateErrorBody(text) {
  return String(text ?? "").replace(/\s+/g, " ").slice(0, 800);
}

async function readOpenAiError(response) {
  const body = await response.text().catch(() => "");
  try {
    const parsed = JSON.parse(body);
    return {
      body,
      message: parsed?.error?.message ?? "",
      type: parsed?.error?.type ?? "",
      code: parsed?.error?.code ?? ""
    };
  } catch {
    return { body, message: "", type: "", code: "" };
  }
}

async function main() {
  loadVoiceBridgeEnv();

  const apiKey = String(process.env.OPENAI_API_KEY ?? "").trim();
  if (!apiKey) {
    console.error("[voice-tts] OPENAI_API_KEY is required");
    process.exitCode = 1;
    return;
  }

  const model = readSetting("VOICE_TTS_MODEL", "gpt-4o-mini-tts");
  const voice = readSetting("VOICE_TTS_VOICE", "marin");
  const format = readSetting("VOICE_TTS_FORMAT", "wav").toLowerCase();

  const response = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      voice,
      input: GREETING_TEXT,
      instructions: TTS_INSTRUCTIONS,
      response_format: format
    })
  });

  if (!response.ok) {
    const error = await readOpenAiError(response);
    if (response.status === 429 && error.code === "insufficient_quota") {
      console.error(
        "[voice-tts] OpenAI quota is insufficient for this API key/project. Check billing, credits, usage limits, or create a key in a project with active quota."
      );
      process.exitCode = 1;
      return;
    }
    console.error(
      `[voice-tts] OpenAI speech request failed status=${response.status} code=${error.code || "unknown"} type=${error.type || "unknown"} body=${truncateErrorBody(error.body)}`
    );
    process.exitCode = 1;
    return;
  }

  const audio = Buffer.from(await response.arrayBuffer());
  if (!audio.length) {
    console.error("[voice-tts] OpenAI speech response was empty");
    process.exitCode = 1;
    return;
  }

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, audio);

  console.log(
    `[voice-tts] wrote ${outputPath} bytes=${audio.length} model=${model} voice=${voice} format=${format}`
  );
}

main().catch((err) => {
  console.error(`[voice-tts] failed: ${err?.message ?? String(err)}`);
  process.exitCode = 1;
});
