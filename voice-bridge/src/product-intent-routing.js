/**
 * Product vs human/AI intent routing (priority over generic KI-assistent keyword matches).
 */

function normalize(text) {
  return String(text ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/ß/g, "ss")
    .replace(/\s+/g, " ")
    .trim();
}

export function detectProductRelationQuestion(text) {
  const lower = normalize(text);
  if (!lower) return false;

  const hasWebsite = /\b(intelligente website|intelligente webseite|smart website|smarte website|website|webseite|homepage)\b/i.test(
    lower
  );
  const hasAssistant = /\b(ki assistent|ki-assistent|ai assistant|digitaler assistent|digitale rezeption|voice assistant|telefonassistent|sprachassistent)\b/i.test(
    lower
  );
  const hasRelation = /\b(zusammenhang|hat zu tun|hat damit zu tun|hat was zu tun|unterschied|beziehung|zusammen|verbindung|auch|erganzend|ergaenzend|miteinander|gehort zusammen)\b/i.test(
    lower
  );
  const asksExplain = /\b(erklar|erklaren|erklaer|erklaeren|was ist|wie funktioniert|was bringt|was macht|kannst du|konnten sie|bitte erklar)\b/i.test(
    lower
  );

  if (hasWebsite && hasAssistant && (hasRelation || asksExplain)) return true;
  if (hasWebsite && asksExplain && /\b(ki|assistent|rezeption)\b/i.test(lower)) return true;
  if (hasRelation && hasWebsite) return true;
  return false;
}

export function shouldClassifyAsHumanOrAiQuestion(text) {
  const lower = normalize(text);
  if (!lower) return false;
  if (detectProductRelationQuestion(lower)) return false;
  if (
    /\b(intelligente website|smart website|website|webseite|zusammenhang|unterschied|hat zu tun|erklar|erklaren)\b/i.test(
      lower
    ) &&
    /\b(ki|assistent|rezeption|voice)\b/i.test(lower)
  ) {
    return false;
  }

  if (
    /\b(echte person|echter mensch|real person|ein mensch|einen mensch|eine person|bist du.*mensch|sind sie.*mensch|sind sie.*person|sehen sie.*mensch|spreche ich.*(ki|bot|assistent)|sind sie.*(echt|ki|bot|assistent)|roboter)\b/i.test(
      lower
    )
  ) {
    return true;
  }

  if (
    /\b(ki|ai|bot|digitaler assistent)\b/i.test(lower) &&
    !/\b(ai assistant|ai voice assistant|voice assistant|voice bot|call bot|ki assistent|ki telefonassistent|telefonassistent|digitale rezeption|ki-assistent)\b/i.test(
      lower
    ) &&
    /\b(bist du|sind sie|echt|mensch|person|roboter)\b/i.test(lower)
  ) {
    return true;
  }

  return /\b(sizinze|sizine|sinse|siense|sindse)\b.*\b(echte|person|mensch)\b/i.test(lower);
}

export function buildProductRelationAnswer() {
  return (
    "Eine intelligente Website kann Inhalte, Angebote und Lead-Erfassung besser strukturieren. " +
    "Der KI-Assistent kann ergaenzend Fragen beantworten oder Leads vorbereiten. Beides kann zusammenarbeiten, muss aber nicht."
  );
}

export function buildPostCapturePricingAnswer(contactAlreadyCaptured = false) {
  const base =
    "Die Kosten haengen vom Umfang ab, zum Beispiel Kanaele, Wissen und Uebergabe an Ihr Team. Unser Team kann das im Termin passend einschaetzen.";
  if (contactAlreadyCaptured) return base;
  return `${base} Wenn Sie möchten, prüft unser Team das kurz mit Ihnen.`;
}
