export function resolveGreetingPrivacyMode(config) {
  const explicit = String(process.env.VOICE_GREETING_PRIVACY_MODE ?? "").trim().toLowerCase();
  if (explicit === "recording" || explicit === "processing") return explicit;
  if (config?.recording?.enabled) return "recording";
  if (config?.transcription?.enabled || config?.postCallSummary?.enabled) return "processing";
  return "processing";
}

export function buildPrivacyGreetingText(config) {
  const mode = resolveGreetingPrivacyMode(config);
  if (mode === "recording") {
    return "Guten Tag, Sie sprechen mit dem KI-Assistenten von TechnoloHit. Dieses Gespräch kann zur Bearbeitung Ihres Anliegens aufgezeichnet, verarbeitet und zusammengefasst werden. Wie kann ich Ihnen helfen?";
  }
  return "Guten Tag, Sie sprechen mit dem KI-Assistenten von TechnoloHit. Zur Bearbeitung Ihres Anliegens kann dieses Gespräch verarbeitet und zusammengefasst werden. Wie kann ich Ihnen helfen?";
}
