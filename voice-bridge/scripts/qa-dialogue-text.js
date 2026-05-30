#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { loadConfig } from "../src/config.js";
import { createQaDialogueContext, processTextTurn } from "../src/turn-assistant.js";
import { validateBusinessFallbackPolicy } from "../src/business-fallback-policy.js";
import { validateProductIntakePolicy } from "../src/product-intake-policy.js";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(scriptDir, "..");
dotenv.config({ path: path.join(packageRoot, ".env") });

function parseArgs(argv) {
  const args = {
    scenario: null,
    turns: null,
    json: false,
    rag: false,
    help: false
  };

  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--help" || token === "-h") {
      args.help = true;
      continue;
    }
    if (token === "--json") {
      args.json = true;
      continue;
    }
    if (token === "--rag") {
      const value = argv[i + 1];
      if (value === "true" || value === "false") {
        args.rag = value === "true";
        i += 1;
      } else {
        args.rag = true;
      }
      continue;
    }
    if (token === "--scenario") {
      args.scenario = String(argv[i + 1] ?? "").trim();
      i += 1;
      continue;
    }
    if (token === "--turns") {
      args.turns = String(argv[i + 1] ?? "").trim();
      i += 1;
    }
  }

  return args;
}

function normalizeText(text) {
  return String(text ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/ß/g, "ss")
    .replace(/\s+/g, " ")
    .trim();
}

function includesAll(text, parts) {
  const haystack = normalizeText(text);
  return parts.every((part) => haystack.includes(normalizeText(part)));
}

function excludes(text, part) {
  return !normalizeText(text).includes(normalizeText(part));
}

function hasBannedCallbackOutput(text) {
  const normalized = normalizeText(text);
  return /\b(ruckruf|rueckruf|ruckrufnummer|rueckrufnummer|zuruckrufen|zurueckrufen|zuruckruft|zurueckruft)\b/i.test(
    normalized
  );
}

function noBannedCallbackOutputChecks(results) {
  return results.map((entry) =>
    assertCondition(
      `turn ${entry.turn} has no banned callback wording`,
      !hasBannedCallbackOutput(entry.assistant),
      entry.assistant
    )
  );
}

function buildQaConfig({ ragEnabled = false } = {}) {
  process.env.VOICE_ASSISTANT_ENABLED = "true";
  process.env.VOICE_LOG_TRANSCRIPT_PREVIEW = "false";
  process.env.VOICE_QA_LOG_TRANSCRIPT_PREVIEW = "false";
  if (!process.env.VOICE_CONTACT_EMAIL) process.env.VOICE_CONTACT_EMAIL = "info@technolohit.com";
  if (!process.env.VOICE_WEBSITE_URL) process.env.VOICE_WEBSITE_URL = "www.technolohit.com";
  process.env.VOICE_RAG_ENABLED = ragEnabled ? "true" : "false";

  const config = loadConfig();
  config.assistant.enabled = true;
  config.assistant.qaTextMode = true;
  config.rag.enabled = ragEnabled;
  return config;
}

async function runTurns(turns, config, ctx) {
  const results = [];
  for (let index = 0; index < turns.length; index += 1) {
    const caller = String(turns[index] ?? "").trim();
    const turn = await processTextTurn({
      state: ctx,
      transcript: caller,
      config,
      turnIndex: index + 1,
      qaMode: true
    });
    results.push({
      turn: index + 1,
      caller,
      assistant: turn.responseText,
      normalized_intent: turn.normalizedIntent,
      transcript_quality: turn.transcriptQuality,
      product_intake_stage: turn.metadata?.product_intake_stage ?? "",
      handoff_choice: turn.metadata?.handoff_choice ?? "",
      business_fallback_intent: turn.metadata?.business_fallback_intent ?? "none",
      final_response_template: turn.metadata?.final_response_template ?? "",
      metadata: turn.metadata
    });
  }
  return results;
}

function findTurn(results, callerSubstring) {
  return results.find((entry) => normalizeText(entry.caller).includes(normalizeText(callerSubstring)));
}

function findTurnByAssistantIncludes(results, part) {
  return results.find((entry) => includesAll(entry.assistant, [part]));
}

function assertCondition(name, ok, message) {
  return { name, ok, message: ok ? "ok" : message };
}

const SCENARIO_ALIASES = {
  "smart-website-email": "smart_website_email",
  "smart-website-phone": "smart_website_phone",
  "gate6-business-fallback": "gate6_business_fallback"
};

const SCENARIOS = {
  smart_website_email: {
    turns: [
      "Ich interessiere mich für eine intelligente Website.",
      "Ja.",
      "E-Mail."
    ],
    assert(results) {
      const pitch = results[0];
      const yes = results[1];
      const email = results[2];
      return [
        assertCondition(
          "pitch includes interest question",
          includesAll(pitch.assistant, ["prüfen lassen"]) || includesAll(pitch.assistant, ["möchten"]),
          `expected interest question in turn 1: ${pitch.assistant}`
        ),
        assertCondition(
          "Ja includes handoff question",
          includesAll(yes.assistant, ["e-mail"]) &&
            (includesAll(yes.assistant, ["telefon"]) || includesAll(yes.assistant, ["telefonisch"])),
          `expected handoff question in turn 2: ${yes.assistant}`
        ),
        assertCondition(
          "E-Mail path includes configured email",
          includesAll(email.assistant, ["info@technolohit.com"]),
          `expected contact email in turn 3: ${email.assistant}`
        )
      ];
    }
  },
  smart_website_phone: {
    context: {
      callerPhoneNormalized: "",
      callerPhoneRaw: ""
    },
    turns: [
      "Ich interessiere mich für Smart Website.",
      "Ja.",
      "Telefon.",
      "0170 1234567.",
      "Nein danke."
    ],
    assert(results) {
      const pitch = results[0];
      const yes = results[1];
      const phoneChoice = results[2];
      const phoneCapture = results[3];
      const close = results[4];
      return [
        assertCondition(
          "pitch + interest question same response",
          includesAll(pitch.assistant, ["smart"]) || includesAll(pitch.assistant, ["website"]),
          pitch.assistant
        ),
        assertCondition(
          "Ja -> handoff question same response",
          includesAll(yes.assistant, ["e-mail"]) &&
            (includesAll(yes.assistant, ["telefon"]) || includesAll(yes.assistant, ["telefonisch"])),
          yes.assistant
        ),
        assertCondition(
          "Telefon -> phone request",
          includesAll(phoneChoice.assistant, ["telefonnummer"]) ||
            includesAll(phoneChoice.assistant, ["telefonisch kontaktieren"]),
          phoneChoice.assistant
        ),
        assertCondition(
          "phone capture -> confirmation without second permission",
          includesAll(phoneCapture.assistant, ["notiert"]) || includesAll(phoneCapture.assistant, ["team"]),
          phoneCapture.assistant
        ),
        assertCondition(
          "no duplicate permission after phone capture",
          excludes(phoneCapture.assistant, "darf unser team sie dazu kontaktieren"),
          phoneCapture.assistant
        ),
        assertCondition(
          "Nein danke -> warm goodbye",
          includesAll(close.assistant, ["wiederh"]) || includesAll(close.assistant, ["danke"]),
          close.assistant
        ),
        ...noBannedCallbackOutputChecks(results)
      ];
    }
  },
  caller_id_callback: {
    context: {
      callerPhoneNormalized: "+491701234567",
      callerPhoneRaw: "+49 170 1234567"
    },
    turns: ["Ich interessiere mich für Smart Website.", "Ja.", "Telefon.", "Ja."],
    assert(results) {
      const phoneChoice = results[2];
      const permission = results[3];
      return [
        assertCondition(
          "caller ID -> callback permission under current number",
          includesAll(phoneChoice.assistant, ["von der sie gerade anrufen"]) ||
            includesAll(phoneChoice.assistant, ["unter der nummer"]),
          phoneChoice.assistant
        ),
        assertCondition(
          "no spoken phone number request with caller ID",
          excludes(phoneChoice.assistant, "unter welcher telefonnummer"),
          phoneChoice.assistant
        ),
        assertCondition(
          "permission yes -> short confirmation",
          includesAll(permission.assistant, ["notiert"]),
          permission.assistant
        ),
        assertCondition(
          "no full phone in assistant text",
          !/\+49\s*170\s*1234567/.test(permission.assistant),
          permission.assistant
        )
      ];
    }
  },
  caller_id_missing_callback: {
    context: {
      callerPhoneNormalized: "",
      callerPhoneRaw: ""
    },
    turns: ["Ich interessiere mich für Smart Website.", "Ja.", "Telefon."],
    assert(results) {
      const phoneChoice = results[2];
      return [
        assertCondition(
          "missing caller ID -> spoken phone request once",
          includesAll(phoneChoice.assistant, ["unter welcher telefonnummer"]) &&
            includesAll(phoneChoice.assistant, ["telefonisch"]),
          phoneChoice.assistant
        ),
        assertCondition(
          "not caller ID permission prompt",
          excludes(phoneChoice.assistant, "von der sie gerade anrufen"),
          phoneChoice.assistant
        ),
        ...noBannedCallbackOutputChecks(results)
      ];
    }
  },
  voice_agent_ai_assistant: {
    turns: ["Ich interessiere mich für AI Assistant."],
    assert(results) {
      const turn = results[0];
      return [
        assertCondition(
          "compact voice agent ack",
          includesAll(turn.assistant, ["ki-telefonassistent"]) ||
            includesAll(turn.assistant, ["digitale rezeption"]),
          turn.assistant
        ),
        assertCondition(
          "offers explanation or callback",
          includesAll(turn.assistant, ["erklaerung", "erklärung", "kurze erklarung", "kurze erklärung"]) ||
            includesAll(turn.assistant, ["telefonisch", "kontakt"]),
          turn.assistant
        ),
        assertCondition(
          "no full product menu",
          excludes(turn.assistant, "welches thema interessiert sie am meisten"),
          turn.assistant
        ),
        ...noBannedCallbackOutputChecks(results)
      ];
    }
  },
  voice_agent_short_explanation: {
    context: {
      callerPhoneNormalized: "",
      callerPhoneRaw: ""
    },
    turns: ["Ich interessiere mich für AI Assistant.", "Kurze Erklärung bitte.", "Telefonisch bitte."],
    assert(results) {
      const offer = results[0];
      const explanation = results[1];
      const phoneChoice = results[2];
      return [
        assertCondition(
          "voice agent compact offer recognized",
          offer.normalized_intent === "product_selection_voice_agent" &&
            (includesAll(offer.assistant, ["ki-telefonassistent"]) ||
              includesAll(offer.assistant, ["digitale rezeption"])),
          `${offer.normalized_intent}: ${offer.assistant}`
        ),
        assertCondition(
          "short explanation answers instead of reasking compact offer",
          includesAll(explanation.assistant, ["digitale rezeption"]) &&
            includesAll(explanation.assistant, ["anrufe"]) &&
            (includesAll(explanation.assistant, ["e-mail"]) ||
              includesAll(explanation.assistant, ["telefonisch"])),
          explanation.assistant
        ),
        assertCondition(
          "explanation not repeated compact offer",
          excludes(explanation.assistant, "kurze erklärung oder") &&
            excludes(explanation.assistant, "kurze erklarung oder"),
          explanation.assistant
        ),
        assertCondition(
          "after explanation phone path asks for phone when caller ID missing",
          includesAll(phoneChoice.assistant, ["telefonnummer"]) &&
            includesAll(phoneChoice.assistant, ["telefonisch"]),
          phoneChoice.assistant
        ),
        ...noBannedCallbackOutputChecks(results)
      ];
    }
  },
  rueckruf_input_maps_to_phone: {
    context: {
      callerPhoneNormalized: "",
      callerPhoneRaw: ""
    },
    turns: ["Rückruf bitte."],
    assert(results) {
      const turn = results[0];
      return [
        assertCondition(
          "inbound Rueckruf maps to phone/contact path",
          turn.normalized_intent === "callback_request" ||
            turn.normalized_intent === "contact_preference_phone" ||
            includesAll(turn.assistant, ["telefon"]) ||
            includesAll(turn.assistant, ["e-mail"]),
          `${turn.normalized_intent}: ${turn.assistant}`
        ),
        assertCondition(
          "outbound response does not say Rueckruf variants",
          !hasBannedCallbackOutput(turn.assistant),
          turn.assistant
        )
      ];
    }
  },
  no_rueckruf_output: {
    context: {
      callerPhoneNormalized: "",
      callerPhoneRaw: ""
    },
    turns: [
      "Ich interessiere mich für AI Assistant.",
      "Kurze Erklärung bitte.",
      "Telefonisch bitte.",
      "0170 1234567.",
      "Nein danke."
    ],
    assert(results) {
      return noBannedCallbackOutputChecks(results);
    }
  },
  incomplete_phone_reasks: {
    context: {
      callerPhoneNormalized: "",
      callerPhoneRaw: ""
    },
    turns: [
      "Ich interessiere mich fÃ¼r AI Assistant.",
      "Telefonisch bitte.",
      "Null eins sieben sechs."
    ],
    assert(results) {
      const phoneCapture = results[2];
      return [
        assertCondition(
          "incomplete spoken phone asks once more",
          phoneCapture.normalized_intent === "phone_detail_incomplete_reask" &&
            includesAll(phoneCapture.assistant, ["telefonnummer"]) &&
            (includesAll(phoneCapture.assistant, ["vollstaendig"]) ||
              includesAll(phoneCapture.assistant, ["vollstandig"]) ||
              includesAll(phoneCapture.assistant, ["vollstÃ¤ndig"])),
          `${phoneCapture.normalized_intent}: ${phoneCapture.assistant}`
        ),
        assertCondition(
          "incomplete spoken phone is not callback-ready",
          phoneCapture.metadata?.contactDetailValid !== true &&
            phoneCapture.metadata?.softIntakeCompleted !== true &&
            phoneCapture.metadata?.softIntakeLeadCreated !== true,
          JSON.stringify(phoneCapture.metadata)
        ),
        ...noBannedCallbackOutputChecks(results)
      ];
    }
  },
  invalid_phone_reasks_again: {
    context: {
      callerPhoneNormalized: "",
      callerPhoneRaw: ""
    },
    turns: [
      "Ich interessiere mich fÃƒÂ¼r AI Assistant.",
      "Telefonisch bitte.",
      "076.",
      "0 1 2 6 4 4 4."
    ],
    assert(results) {
      const firstInvalid = results[2];
      const secondInvalid = results[3];
      return [
        assertCondition(
          "076 reasks full phone number",
          firstInvalid.normalized_intent === "phone_detail_incomplete_reask" &&
            includesAll(firstInvalid.assistant, ["telefonnummer"]) &&
            (includesAll(firstInvalid.assistant, ["vollstaendig"]) ||
              includesAll(firstInvalid.assistant, ["vollstandig"]) ||
              includesAll(firstInvalid.assistant, ["vollstÃƒÂ¤ndig"])),
          `${firstInvalid.normalized_intent}: ${firstInvalid.assistant}`
        ),
        assertCondition(
          "seven digit phone still reasks full phone number",
          secondInvalid.normalized_intent === "phone_detail_incomplete_reask" &&
            includesAll(secondInvalid.assistant, ["telefonnummer"]) &&
            (includesAll(secondInvalid.assistant, ["vollstaendig"]) ||
              includesAll(secondInvalid.assistant, ["vollstandig"]) ||
              includesAll(secondInvalid.assistant, ["vollstÃƒÂ¤ndig"])),
          `${secondInvalid.normalized_intent}: ${secondInvalid.assistant}`
        ),
        assertCondition(
          "invalid phones are not callback-ready",
          firstInvalid.metadata?.contactDetailValid !== true &&
            firstInvalid.metadata?.softIntakeCompleted !== true &&
            secondInvalid.metadata?.contactDetailValid !== true &&
            secondInvalid.metadata?.softIntakeCompleted !== true &&
            secondInvalid.metadata?.softIntakeLeadCreated !== true,
          JSON.stringify({ first: firstInvalid.metadata, second: secondInvalid.metadata })
        ),
        ...noBannedCallbackOutputChecks(results)
      ];
    }
  },
  full_phone_creates_callback_ready: {
    context: {
      callerPhoneNormalized: "",
      callerPhoneRaw: ""
    },
    turns: [
      "Ich interessiere mich fÃ¼r AI Assistant.",
      "Telefonisch bitte.",
      "0176 444 444 44."
    ],
    assert(results) {
      const phoneCapture = results[2];
      return [
        assertCondition(
          "full phone creates callback-ready intake",
          phoneCapture.normalized_intent === "contact_permission_granted" &&
            phoneCapture.metadata?.contactDetailValid === true &&
            phoneCapture.metadata?.softIntakeCompleted === true,
          `${phoneCapture.normalized_intent}: ${JSON.stringify(phoneCapture.metadata)}`
        ),
        assertCondition(
          "full phone path does not ask duplicate permission",
          excludes(phoneCapture.assistant, "darf unser team sie dazu kontaktieren"),
          phoneCapture.assistant
        ),
        ...noBannedCallbackOutputChecks(results)
      ];
    }
  },
  voice_agent_ki_assistent: {
    turns: ["Ich brauche einen KI Assistenten am Telefon."],
    assert(results) {
      const turn = results[0];
      return [
        assertCondition(
          "KI Assistent routes to voice agent offer",
          includesAll(turn.assistant, ["ki-telefonassistent"]) ||
            includesAll(turn.assistant, ["digitale rezeption"]),
          turn.assistant
        )
      ];
    }
  },
  voice_agent_telefonassistent: {
    turns: ["Kann ich so einen Telefonassistenten für meine Firma bekommen?"],
    assert(results) {
      const turn = results[0];
      return [
        assertCondition(
          "Telefonassistent routes to voice agent offer",
          includesAll(turn.assistant, ["ki-telefonassistent"]) ||
            includesAll(turn.assistant, ["digitale rezeption"]),
          turn.assistant
        )
      ];
    }
  },
  unclear_input: {
    turns: ["mhm äh"],
    assert(results) {
      const turn = results[0];
      return [
        assertCondition(
          "short acoustic clarification",
          includesAll(turn.assistant, ["akustisch nicht gut verstanden"]) &&
            includesAll(turn.assistant, ["wiederholen"]),
          turn.assistant
        ),
        assertCondition(
          "no full product menu",
          excludes(turn.assistant, "technolohit bietet intelligente websites"),
          turn.assistant
        )
      ];
    }
  },
  unknown_intent: {
    turns: ["Ich suche etwas für mein Lager und Inventur."],
    assert(results) {
      const turn = results[0];
      return [
        assertCondition(
          "short unknown intent clarification",
          includesAll(turn.assistant, ["nicht ganz sicher"]) ||
            includesAll(turn.assistant, ["worum geht es"]),
          turn.assistant
        ),
        assertCondition(
          "no full greeting repeat",
          excludes(turn.assistant, "guten tag"),
          turn.assistant
        )
      ];
    }
  },
  gate6_business_fallback: {
    turns: [
      "Ich interessiere mich für Smart Website.",
      "Ja.",
      "E-Mail.",
      "Ja, ich habe noch eine Frage.",
      "Wie läuft die Beratung ab?",
      "Was soll ich in der E-Mail schreiben?",
      "Wo finde ich das Kontaktformular?",
      "Danke. Tschüss."
    ],
    assert(results) {
      const pitch = results[0];
      const yes = results[1];
      const email = results[2];
      const beratung = findTurn(results, "Beratung");
      const emailContents = findTurn(results, "E-Mail schreiben");
      const contactForm = findTurn(results, "Kontaktformular");
      const goodbye = results.at(-1);
      return [
        assertCondition(
          "Smart Website pitch includes interest question",
          includesAll(pitch.assistant, ["prüfen lassen"]) || includesAll(pitch.assistant, ["möchten"]),
          pitch.assistant
        ),
        assertCondition(
          "Ja includes E-Mail + Telefon handoff",
          includesAll(yes.assistant, ["e-mail"]) &&
            (includesAll(yes.assistant, ["telefon"]) || includesAll(yes.assistant, ["telefonisch"])),
          yes.assistant
        ),
        assertCondition(
          "E-Mail path includes info@technolohit.com",
          includesAll(email.assistant, ["info@technolohit.com"]),
          email.assistant
        ),
        assertCondition(
          "Beratung includes website or Kontaktformular",
          beratung &&
            (includesAll(beratung.assistant, ["www.technolohit.com"]) ||
              includesAll(beratung.assistant, ["kontaktformular"])),
          beratung?.assistant || "missing beratung turn"
        ),
        assertCondition(
          "E-Mail contents includes goal/domain/question/email",
          emailContents &&
            includesAll(emailContents.assistant, ["ziel"]) &&
            (includesAll(emailContents.assistant, ["website"]) ||
              includesAll(emailContents.assistant, ["domain"])) &&
            includesAll(emailContents.assistant, ["frage"]) &&
            includesAll(emailContents.assistant, ["info@technolohit.com"]),
          emailContents?.assistant || "missing email contents turn"
        ),
        assertCondition(
          "Kontaktformular deterministic",
          contactForm &&
            (includesAll(contactForm.assistant, ["kontaktformular"]) ||
              includesAll(contactForm.assistant, ["kontaktbereich"])) &&
            includesAll(contactForm.assistant, ["www.technolohit.com"]),
          contactForm?.assistant || "missing contact form turn"
        ),
        assertCondition(
          "Kontaktformular not incomplete clarification",
          contactForm && excludes(contactForm.assistant, "nicht ganz vollständig verstanden"),
          contactForm?.assistant || "missing contact form turn"
        ),
        assertCondition(
          "Danke Tschüss warm goodbye",
          goodbye &&
            (includesAll(goodbye.assistant, ["wiederh"]) || includesAll(goodbye.assistant, ["danke für ihren anruf"])),
          goodbye?.assistant || "missing goodbye turn"
        ),
        assertCondition(
          "Danke Tschüss not clarification",
          goodbye && excludes(goodbye.assistant, "akustisch nicht gut verstanden"),
          goodbye?.assistant || "missing goodbye turn"
        )
      ];
    }
  },
  five_products_overview: {
    turns: ["Welche Produkte bieten Sie an?"],
    assert(results) {
      const turn = results[0];
      return [
        assertCondition(
          "overview mentions products",
          includesAll(turn.assistant, ["technolohit"]) &&
            (includesAll(turn.assistant, ["website"]) || includesAll(turn.assistant, ["aiseoq"])),
          turn.assistant
        )
      ];
    }
  },
  clear_close: {
    context: {
      callerPhoneNormalized: "",
      callerPhoneRaw: ""
    },
    turns: [
      "Ich interessiere mich für Smart Website.",
      "Ja.",
      "Telefon.",
      "0170 1234567.",
      "Nein danke."
    ],
    assert(results) {
      const close = results.at(-1);
      return [
        assertCondition(
          "clear close warm goodbye",
          includesAll(close.assistant, ["wiederh"]) || includesAll(close.assistant, ["danke"]),
          close.assistant
        ),
        assertCondition(
          "clear close not clarification",
          excludes(close.assistant, "akustisch nicht gut verstanden"),
          close.assistant
        )
      ];
    }
  },
  contact_form_question: {
    turns: ["Wo finde ich das Kontaktformular?"],
    assert(results) {
      const turn = results[0];
      return [
        assertCondition(
          "includes Kontaktformular or Kontaktbereich",
          includesAll(turn.assistant, ["kontaktformular"]) || includesAll(turn.assistant, ["kontaktbereich"]),
          turn.assistant
        ),
        assertCondition(
          "includes configured website",
          includesAll(turn.assistant, ["www.technolohit.com"]),
          turn.assistant
        ),
        assertCondition(
          "not incomplete clarification",
          excludes(turn.assistant, "nicht ganz vollständig verstanden"),
          turn.assistant
        ),
        assertCondition(
          "not acoustic clarification",
          excludes(turn.assistant, "akustisch nicht gut verstanden"),
          turn.assistant
        ),
        assertCondition(
          "business fallback intent set",
          turn.business_fallback_intent === "contact_form_question" ||
            turn.final_response_template === "business_fallback",
          `intent=${turn.business_fallback_intent} template=${turn.final_response_template}`
        )
      ];
    }
  },
  email_contents_question: {
    turns: ["Was soll ich in der E-Mail schreiben?"],
    assert(results) {
      const turn = results[0];
      return [
        assertCondition(
          "includes goal",
          includesAll(turn.assistant, ["ziel"]),
          turn.assistant
        ),
        assertCondition(
          "includes website or domain",
          includesAll(turn.assistant, ["website"]) || includesAll(turn.assistant, ["domain"]),
          turn.assistant
        ),
        assertCondition(
          "includes key question",
          includesAll(turn.assistant, ["frage"]),
          turn.assistant
        ),
        assertCondition(
          "includes configured email",
          includesAll(turn.assistant, ["info@technolohit.com"]),
          turn.assistant
        ),
        assertCondition(
          "not incomplete clarification",
          excludes(turn.assistant, "nicht ganz vollständig verstanden"),
          turn.assistant
        )
      ];
    }
  },
  lokalki_rag_optional: {
    requiresRag: true,
    turns: ["Was ist LokalKI?"],
    assert(results, { ragEnabled }) {
      if (!ragEnabled) {
        return [
          assertCondition("rag scenario skipped", true, "pass with --rag true to evaluate RAG path")
        ];
      }
      const turn = results[0];
      return [
        assertCondition(
          "mentions LokalKI or sensitive data theme",
          includesAll(turn.assistant, ["lokalki"]) ||
            includesAll(turn.assistant, ["intern"]) ||
            turn.final_response_template === "knowledge" ||
            turn.final_response_template === "qa_skipped_llm",
          `${turn.assistant} template=${turn.final_response_template}`
        )
      ];
    }
  }
};

function resolveScenarioName(name) {
  const key = String(name ?? "").trim();
  if (!key) return null;
  if (SCENARIOS[key]) return key;
  const aliased = SCENARIO_ALIASES[key];
  return aliased && SCENARIOS[aliased] ? aliased : null;
}

function printTable(results) {
  const headers = [
    "Turn",
    "Caller",
    "Assistant",
    "normalized_intent",
    "product_intake_stage",
    "handoff_choice",
    "business_fallback_intent",
    "final_response_template"
  ];
  console.log(headers.join(" | "));
  console.log(headers.map(() => "---").join(" | "));
  for (const row of results) {
    const line = [
      row.turn,
      row.caller.replace(/\s+/g, " ").slice(0, 40),
      row.assistant.replace(/\s+/g, " ").slice(0, 80),
      row.normalized_intent,
      row.product_intake_stage,
      row.handoff_choice,
      row.business_fallback_intent,
      row.final_response_template
    ];
    console.log(line.join(" | "));
  }
}

function printAssertions(scenarioName, checks) {
  console.log(`\nScenario: ${scenarioName}`);
  let failed = 0;
  for (const check of checks) {
    const status = check.ok ? "PASS" : "FAIL";
    console.log(`  [${status}] ${check.name}${check.ok ? "" : ` — ${check.message}`}`);
    if (!check.ok) failed += 1;
  }
  return failed;
}

function usage() {
  console.log(`Usage:
  node voice-bridge/scripts/qa-dialogue-text.js --scenario <name> [--json] [--rag true|false]
  node voice-bridge/scripts/qa-dialogue-text.js --turns '<json array>' [--json]

Windows PowerShell: run from voice-bridge/ with the node command above (npm run qa:dialogue -- --scenario … may not forward args correctly).

Scenarios:
  smart_website_email, smart_website_phone, caller_id_callback, caller_id_missing_callback,
  voice_agent_ai_assistant, voice_agent_short_explanation,
  voice_agent_ki_assistent, voice_agent_telefonassistent,
  rueckruf_input_maps_to_phone, no_rueckruf_output,
  incomplete_phone_reasks, invalid_phone_reasks_again, full_phone_creates_callback_ready,
  unclear_input, unknown_intent, gate6_business_fallback,
  five_products_overview, clear_close, contact_form_question,
  email_contents_question, lokalki_rag_optional

Aliases:
  smart-website-email, smart-website-phone, gate6-business-fallback
`);
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    usage();
    process.exit(0);
  }

  validateProductIntakePolicy();
  validateBusinessFallbackPolicy();

  let scenarioName = resolveScenarioName(args.scenario);
  let turns = null;
  let assertFn = null;
  let requiresRag = false;

  if (args.turns) {
    try {
      turns = JSON.parse(args.turns);
      if (!Array.isArray(turns)) throw new Error("turns must be a JSON array");
    } catch (err) {
      console.error(`Invalid --turns JSON: ${err.message}`);
      process.exit(2);
    }
  } else if (scenarioName) {
    const scenario = SCENARIOS[scenarioName];
    turns = scenario.turns;
    assertFn = scenario.assert;
    requiresRag = Boolean(scenario.requiresRag);
  } else {
    usage();
    process.exit(2);
  }

  const config = buildQaConfig({ ragEnabled: args.rag || requiresRag });
  const scenario = scenarioName ? SCENARIOS[scenarioName] : null;
  const ctx = createQaDialogueContext(scenario?.context || {});
  const results = await runTurns(turns, config, ctx);

  if (args.json) {
    for (const row of results) {
      console.log(JSON.stringify(row));
    }
  } else {
    printTable(results);
  }

  if (assertFn) {
    const checks = assertFn(results, { ragEnabled: config.rag.enabled });
    if (!args.json) {
      const failed = printAssertions(scenarioName, checks);
      process.exit(failed ? 1 : 0);
    } else {
      const failed = checks.filter((check) => !check.ok);
      if (failed.length) process.exit(1);
    }
  }
}

main().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
