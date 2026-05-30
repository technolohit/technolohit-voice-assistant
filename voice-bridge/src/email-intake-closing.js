function contactEmailFromConfig(config) {
  return String(config?.assistant?.contactEmail || "").trim();
}

export function emailContactReferenceText(config) {
  const address = contactEmailFromConfig(config);
  if (address) return `Sie können uns an ${address} schreiben.`;
  return "Die E-Mail-Adresse finden Sie auf unserer Website.";
}

export function buildEmailDirectIntakeClosingSuffix(config, { emailAddressInBody = false } = {}) {
  const address = contactEmailFromConfig(config);
  if (emailAddressInBody && address) {
    return "Haben Sie noch eine kurze Frage, oder darf ich mich verabschieden?";
  }
  if (address) {
    return `Wenn Sie noch eine kurze Frage haben, beantworte ich sie gern. Sonst erreichen Sie uns per E-Mail unter ${address}.`;
  }
  return "Haben Sie noch eine kurze Frage, oder darf ich mich verabschieden?";
}

export function splitEmailDirectIntakeParts(
  config,
  emailInstruction = "Schreiben Sie uns bitte kurz Ihr Anliegen und Ihre wichtigsten Fragen."
) {
  const reference = emailContactReferenceText(config);
  const instruction = String(emailInstruction || "").trim();
  const body = instruction ? `${reference} ${instruction}`.trim() : reference.trim();
  const closing = buildEmailDirectIntakeClosingSuffix(config, {
    emailAddressInBody: Boolean(contactEmailFromConfig(config))
  });
  return { body, closing };
}

export function buildEmailDirectIntakeConfirmationText(config, emailInstruction) {
  const { body, closing } = splitEmailDirectIntakeParts(config, emailInstruction);
  return `${body} ${closing}`.trim();
}
