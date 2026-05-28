function normalize(text) {
  return String(text ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/ß/g, "ss")
    .replace(/\s+/g, " ")
    .trim();
}

export const BUSINESS_FALLBACK_CLOSE_QUESTION =
  "Haben Sie noch eine kurze Frage, oder darf ich mich verabschieden?";

const BUSINESS_FALLBACK_REDIRECT_INTENT = "contact_form_redirect";

function normalizeWebsiteUrl(websiteUrl) {
  return String(websiteUrl ?? "")
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "");
}

function websiteReference(websiteUrl) {
  const site = normalizeWebsiteUrl(websiteUrl);
  return site || null;
}

function contactAreaPhrase(websiteUrl) {
  const site = websiteReference(websiteUrl);
  if (site) return `im Kontaktbereich auf ${site}`;
  return "im Kontaktbereich auf unserer Website";
}

function websiteBrowsePhrase(websiteUrl) {
  const site = websiteReference(websiteUrl);
  if (site) return site;
  return "unserer Website im Kontaktbereich";
}

function buildWebsiteContactGuidance({ websiteUrl, contactEmail, includeEmail = false }) {
  const site = websiteReference(websiteUrl);
  let guidance;
  let guidanceType = "website_contact";

  if (site) {
    guidance =
      "Mehr Informationen finden Sie auf " +
      `${site}. Im Kontaktbereich können Sie auch das Formular mit Ihren Anforderungen ausfüllen. So kann unser Team Ihre Anfrage schneller prüfen.`;
  } else {
    guidance =
      "Mehr Informationen finden Sie auf unserer Website im Kontaktbereich. Dort können Sie auch das Formular mit Ihren Anforderungen ausfüllen.";
  }

  const email = String(contactEmail || "").trim();
  if (includeEmail && email.includes("@")) {
    guidance += ` Sie können uns auch an ${email} schreiben.`;
    guidanceType = "website_contact_email";
  }

  return { guidance, guidanceType };
}

const BUSINESS_FALLBACK_POLICIES = [
  {
    id: "email_contents_question",
    nextStep: "email",
    guidanceMode: "none",
    matches(normalized) {
      return (
        /\b(was soll ich in der e-?mail|was soll ich schicken|was soll ich mailen|was soll ich reinschreiben|was soll ich schreiben|welche informationen|was brauchen sie|was braucht ihr|was muss in die e-?mail|was in die e-?mail)\b/i.test(
          normalized
        ) ||
        (/\be-?mail\b/i.test(normalized) &&
          /\b(was|welche|schreiben|schicken|informationen|brauchen)\b/i.test(normalized))
      );
    },
    buildBody({ contactEmail }) {
      let text =
        "Schreiben Sie uns am besten kurz Ihr Ziel, Ihre Website oder Domain falls vorhanden und die wichtigste Frage. Den Unternehmensnamen können Sie gern dazuschreiben.";
      const email = String(contactEmail || "").trim();
      if (email.includes("@")) {
        text += ` Sie können uns an ${email} schreiben.`;
      }
      return text;
    }
  },
  {
    id: "contact_form_question",
    nextStep: "contact_form",
    guidanceMode: "none",
    matches(normalized) {
      return (
        /\b(kontaktformular|kontakt formular|formular|website kontakt|kontaktbereich|kontakt bereich)\b/i.test(
          normalized
        ) ||
        (/\b(wo finde ich|wo ist|wo gibt es)\b/i.test(normalized) &&
          /\b(formular|kontaktformular|kontakt)\b/i.test(normalized))
      );
    },
    buildBody({ websiteUrl }) {
      return `Das Kontaktformular finden Sie ${contactAreaPhrase(websiteUrl)}. Dort können Sie Ihre Anforderungen eintragen, damit unser Team Ihre Anfrage schneller prüfen kann.`;
    }
  },
  {
    id: "company_name_question",
    nextStep: "email",
    guidanceMode: "none",
    matches(normalized) {
      if (
        /\b(beratung|prozess|funktioniert|lauft ab|laeuft ab|nachste schritte|naechste schritte|was passiert)\b/i.test(
          normalized
        )
      ) {
        return false;
      }
      return (
        /\b(firmennamen nennen|firmenname|unternehmensname|name vom unternehmen|namen meines unternehmens|namen nennen|soll ich den namen|soll ich.*name.*nennen)\b/i.test(
          normalized
        ) ||
        (/\b(soll ich|muss ich)\b/i.test(normalized) &&
          /\b(firmenname|unternehmensname|namen)\b/i.test(normalized))
      );
    },
    buildBody() {
      return "Ja, das können Sie gern in der E-Mail oder im Kontaktformular angeben. Wichtiger sind zuerst Ihr Ziel, Ihre Website oder Domain falls vorhanden und Ihre wichtigste Frage.";
    }
  },
  {
    id: "consultation_process_question",
    nextStep: "close_question",
    guidanceMode: "none",
    matches(normalized) {
      return (
        /\b(beratung|erste einschaetzung|ersteinschaetzung|wie funktioniert|wie lauft das ab|wie laeuft das ab|welcher prozess|was passiert danach|nachste schritte|naechste schritte|wie geht es weiter|ablauf)\b/i.test(
          normalized
        ) ||
        (/\b(soll ich|muss ich)\b/i.test(normalized) &&
          /\b(beratung|funktioniert|prozess)\b/i.test(normalized))
      );
    },
    buildBody({ websiteUrl }) {
      const sitePhrase = websiteBrowsePhrase(websiteUrl);
      return `Bei einer ersten Einschätzung schaut unser Team kurz auf Ihr Ziel und Ihre Situation. Mehr Informationen finden Sie auf ${sitePhrase}, oder Sie nutzen dort das Kontaktformular.`;
    }
  },
  {
    id: "pricing_question",
    nextStep: "close_question",
    guidanceMode: "website_contact",
    matches(normalized) {
      return /\b(preis|preise|kosten|kostet|was kostet|wie teuer|teuer)\b/i.test(normalized);
    },
    buildBody() {
      return "Das hängt vom Umfang ab. Unser Team kann Ihnen nach einer kurzen Einschätzung eine passendere Orientierung geben.";
    }
  }
];

function buildRedirectBody(websiteUrl) {
  const site = websiteReference(websiteUrl);
  if (site) {
    return `Für alles Weitere ist das Kontaktformular auf ${site} am besten. Dort können Sie Ihre Anforderungen eintragen, und unser Team prüft sie gezielt.`;
  }
  return "Für alles Weitere ist das Kontaktformular auf unserer Website im Kontaktbereich am besten. Dort können Sie Ihre Anforderungen eintragen, und unser Team prüft sie gezielt.";
}

export function matchBusinessFallbackFromText(text) {
  const normalized = normalize(text);
  if (!normalized) return null;

  for (const policy of BUSINESS_FALLBACK_POLICIES) {
    if (policy.matches(normalized)) {
      return { intent: policy.id, nextStep: policy.nextStep };
    }
  }
  return null;
}

export function buildBusinessFallbackResponse(intentId, options = {}) {
  const fallbackQuestionCount = Number(options.fallbackQuestionCount || 0);
  const contactEmail = String(options.contactEmail || "").trim();
  const websiteUrl = String(options.websiteUrl || "").trim();
  const hasWebsite = Boolean(websiteReference(websiteUrl));
  const hasEmail = contactEmail.includes("@");

  if (fallbackQuestionCount >= 2) {
    return {
      body: buildRedirectBody(websiteUrl),
      guidance: "",
      guidanceType: "website_contact",
      nextStep: "contact_form",
      intent: BUSINESS_FALLBACK_REDIRECT_INTENT
    };
  }

  const policy = BUSINESS_FALLBACK_POLICIES.find((entry) => entry.id === intentId);
  if (!policy) {
    return {
      body: "",
      guidance: "",
      guidanceType: "none",
      nextStep: "close_question",
      intent: intentId || "none"
    };
  }

  const body = policy.buildBody({ contactEmail, websiteUrl });
  let guidance = "";
  let guidanceType = "none";

  if (policy.guidanceMode === "website_contact") {
    const built = buildWebsiteContactGuidance({
      websiteUrl,
      contactEmail,
      includeEmail: false
    });
    guidance = built.guidance;
    guidanceType = built.guidanceType;
  } else if (policy.id === "email_contents_question" && hasEmail) {
    guidanceType = "email";
  } else if (policy.id === "contact_form_question" || policy.id === "consultation_process_question") {
    guidanceType = hasWebsite ? "website_contact" : "website_contact";
  }

  return {
    body,
    guidance,
    guidanceType,
    nextStep: policy.nextStep,
    intent: policy.id
  };
}

export function buildBusinessFallbackBody(intentId, contactEmail = "", websiteUrl = "") {
  return buildBusinessFallbackResponse(intentId, { contactEmail, websiteUrl }).body;
}

export function validateBusinessFallbackPolicy() {
  for (const policy of BUSINESS_FALLBACK_POLICIES) {
    if (!policy.id || typeof policy.matches !== "function" || typeof policy.buildBody !== "function") {
      throw new Error(`business-fallback-policy invalid: ${policy.id || "unknown"}`);
    }
    const sample = buildBusinessFallbackResponse(policy.id, {
      contactEmail: "info@technolohit.com",
      websiteUrl: "www.technolohit.com"
    });
    if (!sample.body) {
      throw new Error(`business-fallback-policy invalid: ${policy.id}.buildBody returned empty`);
    }
  }

  const redirect = buildBusinessFallbackResponse("consultation_process_question", {
    contactEmail: "info@technolohit.com",
    websiteUrl: "www.technolohit.com",
    fallbackQuestionCount: 2
  });
  if (!redirect.body || redirect.intent !== BUSINESS_FALLBACK_REDIRECT_INTENT) {
    throw new Error("business-fallback-policy invalid: redirect response");
  }
}
