#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { loadConfig } from "../src/config.js";
import { createQaDialogueContext, processTextTurn } from "../src/turn-assistant.js";
import { validateBusinessFallbackPolicy } from "../src/business-fallback-policy.js";
import { validateSalesPlaybooks } from "../src/sales-policy.js";
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

const CUSTOMER_TYPE_MENU_LOOP_SNIPPET =
  "sagen sie bitte kurz: eigenes unternehmen, kundenprojekt";

function hasProductExplanationContent(text) {
  return includesAll(text, ["digitale rezeption"]) || includesAll(text, ["anrufe"]);
}

function hasUsefulSalesFollowUpQuestion(text) {
  const haystack = normalizeText(text);
  const asksSomething =
    haystack.includes("?") ||
    /\b(geht es|mochten sie|was mochten|was soll|wie|welche|soll unser)\b/i.test(haystack);
  if (!asksSomething) return false;
  return (
    includesAll(text, ["eigenes unternehmen"]) ||
    includesAll(text, ["kundenprojekt"]) ||
    includesAll(text, ["verpasste anrufe"]) ||
    includesAll(text, ["lead"]) ||
    includesAll(text, ["verbessern"]) ||
    includesAll(text, ["ziel"]) ||
    includesAll(text, ["bereits kunde"])
  );
}

function acknowledgesOwnCompany(text) {
  return (
    includesAll(text, ["eigenes unternehmen"]) ||
    includesAll(text, ["eigenem unternehmen"]) ||
    includesAll(text, ["ordne das als eigenes unternehmen"])
  );
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

function buildQaConfig({ ragEnabled = false, v3Enabled = true } = {}) {
  process.env.VOICE_ASSISTANT_ENABLED = "true";
  process.env.VOICE_LOG_TRANSCRIPT_PREVIEW = "false";
  process.env.VOICE_QA_LOG_TRANSCRIPT_PREVIEW = "false";
  if (!process.env.VOICE_CONTACT_EMAIL) process.env.VOICE_CONTACT_EMAIL = "info@technolohit.com";
  if (!process.env.VOICE_WEBSITE_URL) process.env.VOICE_WEBSITE_URL = "www.technolohit.com";
  process.env.VOICE_RAG_ENABLED = ragEnabled ? "true" : "false";
  process.env.VOICE_SEMANTIC_INTENT_ENABLED = v3Enabled ? "true" : "false";
  process.env.VOICE_CONVERSATION_REPAIR_ENABLED = v3Enabled ? "true" : "false";
  process.env.VOICE_SEMANTIC_INTENT_MODE = "deterministic";
  process.env.VOICE_RAG_SALES_ANSWERER_ENABLED = ragEnabled ? "true" : "false";
  process.env.VOICE_RAG_QA_MODE = ragEnabled ? "true" : "false";

  const config = loadConfig();
  config.assistant.enabled = true;
  config.assistant.qaTextMode = true;
  config.rag.enabled = ragEnabled;
  config.semanticIntent.enabled = v3Enabled;
  config.conversationRepair.enabled = v3Enabled;
  config.rag.salesAnswererEnabled = ragEnabled;
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
  sales_voice_agent_pitch_no_early_phone: {
    turns: ["Ich interessiere mich fuer AI Assistant."],
    assert(results) {
      const turn = results[0];
      return [
        assertCondition(
          "sales pitch explains value",
          includesAll(turn.assistant, ["digitale rezeption"]) &&
            (includesAll(turn.assistant, ["anrufe"]) || includesAll(turn.assistant, ["leads"])),
          turn.assistant
        ),
        assertCondition(
          "asks customer type, not phone",
          includesAll(turn.assistant, ["eigenes unternehmen"]) &&
            includesAll(turn.assistant, ["kundenprojekt"]) &&
            excludes(turn.assistant, "telefonnummer"),
          turn.assistant
        ),
        ...noBannedCallbackOutputChecks(results)
      ];
    }
  },
  sales_customer_type_stt_kundenprojekt: {
    turns: [
      "Ich interessiere mich fuer AI Assistant.",
      "konnen dann projekt."
    ],
    assert(results) {
      const customerType = results[1];
      return [
        assertCondition(
          "STT-damaged Kundenprojekt is understood as customer project",
          customerType.normalized_intent === "sales_customer_type_agency_partner",
          `${customerType.normalized_intent}: ${customerType.assistant}`
        ),
        ...noBannedCallbackOutputChecks(results)
      ];
    }
  },
  sales_customer_type_first_option: {
    turns: [
      "Ich interessiere mich fuer AI Assistant.",
      "Die erste."
    ],
    assert(results) {
      const customerType = results[1];
      return [
        assertCondition(
          "first option maps to own company",
          customerType.normalized_intent === "sales_customer_type_new_prospect",
          `${customerType.normalized_intent}: ${customerType.assistant}`
        ),
        ...noBannedCallbackOutputChecks(results)
      ];
    }
  },
  sales_customer_type_own_company_plural: {
    turns: [
      "Ich interessiere mich fuer AI Assistant.",
      "Ich habe meine eigenen Unternehmen."
    ],
    assert(results) {
      const customerType = results[1];
      return [
        assertCondition(
          "natural own-company wording maps to new prospect",
          customerType.normalized_intent === "sales_customer_type_new_prospect",
          `${customerType.normalized_intent}: ${customerType.assistant}`
        ),
        ...noBannedCallbackOutputChecks(results)
      ];
    }
  },
  sales_explanation_after_pitch: {
    turns: [
      "Ich interessiere mich fuer AI Assistant.",
      "Kurze Erklaerung bitte."
    ],
    assert(results) {
      const explanation = results[1];
      return [
        assertCondition(
          "short explanation is answered inside sales flow",
          explanation.normalized_intent === "sales_product_explanation" &&
            hasProductExplanationContent(explanation.assistant) &&
            hasUsefulSalesFollowUpQuestion(explanation.assistant),
          `${explanation.normalized_intent}: ${explanation.assistant}`
        ),
        ...noBannedCallbackOutputChecks(results)
      ];
    }
  },
  sales_new_prospect_qualification: {
    turns: [
      "Ich interessiere mich fuer AI Assistant.",
      "Fuer mein eigenes Unternehmen.",
      "Wir verpassen zu viele Anrufe."
    ],
    assert(results) {
      const customerType = results[1];
      const handoff = results[2];
      return [
        assertCondition(
          "new prospect gets qualification question",
          customerType.normalized_intent === "sales_customer_type_new_prospect" &&
            (acknowledgesOwnCompany(customerType.assistant) ||
              includesAll(customerType.assistant, ["verbessern"]) ||
              includesAll(customerType.assistant, ["verpasste anrufe"]) ||
              includesAll(customerType.assistant, ["lead-erfassung"]) ||
              includesAll(customerType.assistant, ["fragen"])) &&
            excludes(customerType.assistant, CUSTOMER_TYPE_MENU_LOOP_SNIPPET),
          `${customerType.normalized_intent}: ${customerType.assistant}`
        ),
        assertCondition(
          "need discovery leads to handoff offer",
          handoff.normalized_intent === "sales_handoff_offer" &&
            includesAll(handoff.assistant, ["telefonisch"]) &&
            includesAll(handoff.assistant, ["e-mail"]),
          `${handoff.normalized_intent}: ${handoff.assistant}`
        ),
        ...noBannedCallbackOutputChecks(results)
      ];
    }
  },
  sales_existing_customer_path: {
    turns: [
      "Ich interessiere mich fuer AI Assistant.",
      "Ich bin schon Kunde."
    ],
    assert(results) {
      const customerType = results[1];
      return [
        assertCondition(
          "existing customer asks company or customer number",
          customerType.normalized_intent === "sales_customer_type_existing_customer" &&
            (includesAll(customerType.assistant, ["firmennamen"]) ||
              includesAll(customerType.assistant, ["kundennummer"])),
          `${customerType.normalized_intent}: ${customerType.assistant}`
        ),
        ...noBannedCallbackOutputChecks(results)
      ];
    }
  },
  v3_live_customer_type_loop: {
    turns: [
      "Ich interessiere mich fuer AI Assistant.",
      "Eigenunternehmen.",
      "Eigene Unternehmen."
    ],
    assert(results) {
      const second = results[1];
      const third = results[2];
      const menuLoop = "sagen sie bitte kurz: eigenes unternehmen, kundenprojekt";
      return [
        assertCondition(
          "Eigenunternehmen maps to new prospect",
          second.normalized_intent === "sales_customer_type_new_prospect",
          `${second.normalized_intent}: ${second.assistant}`
        ),
        assertCondition(
          "no repeated customer-type menu after Eigenunternehmen",
          excludes(second.assistant, menuLoop),
          second.assistant
        ),
        assertCondition(
          "no repeated customer-type menu on second own-company variant",
          excludes(third.assistant, menuLoop),
          third.assistant
        ),
        assertCondition(
          "turn 2 and 3 responses differ",
          normalizeText(second.assistant) !== normalizeText(third.assistant),
          `turn2=${second.assistant} turn3=${third.assistant}`
        ),
        ...noBannedCallbackOutputChecks(results)
      ];
    }
  },
  v3_fuer_meine_firma: {
    turns: ["Ich interessiere mich fuer AI Assistant.", "fuer meine Firma"],
    assert(results) {
      const customerType = results[1];
      return [
        assertCondition(
          "für meine Firma maps to new prospect",
          customerType.normalized_intent === "sales_customer_type_new_prospect",
          `${customerType.normalized_intent}: ${customerType.assistant}`
        ),
        ...noBannedCallbackOutputChecks(results)
      ];
    }
  },
  v3_repeated_unclear_no_loop: {
    turns: [
      "Ich interessiere mich fuer AI Assistant.",
      "hm",
      "aeh"
    ],
    assert(results) {
      const second = results[1];
      const third = results[2];
      return [
        assertCondition(
          "unclear turn does not repeat exact same assistant text",
          normalizeText(second.assistant) !== normalizeText(third.assistant) || third.assistant === "",
          `turn2=${second.assistant} turn3=${third.assistant}`
        ),
        assertCondition(
          "after unclear input avoids strict menu loop twice",
          !(
            includesAll(second.assistant, ["eigenes unternehmen", "kundenprojekt", "bereits kunde"]) &&
            includesAll(third.assistant, ["eigenes unternehmen", "kundenprojekt", "bereits kunde"])
          ),
          `turn2=${second.assistant} turn3=${third.assistant}`
        ),
        ...noBannedCallbackOutputChecks(results)
      ];
    }
  },
  v3_rag_fail_closed_explanation: {
    turns: ["Ich interessiere mich fuer AI Assistant.", "Kurze Erklaerung bitte."],
    assert(results) {
      const explanation = results[1];
      return [
        assertCondition(
          "explanation answered before contact capture",
          explanation.normalized_intent === "sales_product_explanation" &&
            (includesAll(explanation.assistant, ["rezeption"]) ||
              includesAll(explanation.assistant, ["anrufe"])),
          `${explanation.normalized_intent}: ${explanation.assistant}`
        ),
        assertCondition(
          "no phone capture in explanation turn",
          excludes(explanation.assistant, "telefonnummer"),
          explanation.assistant
        ),
        ...noBannedCallbackOutputChecks(results)
      ];
    }
  },
  v3_sales_depth_before_handoff: {
    turns: [
      "Ich interessiere mich fuer AI Assistant.",
      "Eigene Unternehmen.",
      "Ich moechte, dass meine Kunden erstmal mit diesem Assistenten reden, Leads sammeln und so weiter."
    ],
    assert(results) {
      const depth = results[2];
      return [
        assertCondition(
          "does not jump to phone/email handoff immediately",
          depth.normalized_intent !== "sales_handoff_offer" &&
            excludes(depth.assistant, "soll unser team das telefonisch") &&
            excludes(depth.assistant, "per e-mail starten"),
          `${depth.normalized_intent}: ${depth.assistant}`
        ),
        assertCondition(
          "reflects use case and asks one follow-up",
          (includesAll(depth.assistant, ["leads"]) ||
            includesAll(depth.assistant, ["gesprach"]) ||
            includesAll(depth.assistant, ["gespraeche"]) ||
            includesAll(depth.assistant, ["kunden"])) &&
            (includesAll(depth.assistant, ["website"]) ||
              includesAll(depth.assistant, ["telefon"]) ||
              includesAll(depth.assistant, ["verbessern"])),
          depth.assistant
        ),
        ...noBannedCallbackOutputChecks(results)
      ];
    }
  },
  v3_post_completion_product_question: {
    context: {
      callerPhoneNormalized: "+491701234567",
      callerPhoneRaw: "+49 170 1234567"
    },
    turns: [
      "Ich interessiere mich fuer AI Assistant.",
      "Eigene Unternehmen.",
      "Ich moechte, dass meine Kunden mit dem Assistenten reden und Leads sammeln.",
      "Auf der Website und auch am Telefon.",
      "Telefonisch.",
      "Ja.",
      "Kannst du ein bisschen ueber intelligente Website erklaeren? Hat sie zu tun mit KI-Assistent?"
    ],
    assert(results) {
      const productQ = results[6];
      const depth = results[2];
      return [
        assertCondition(
          "sales depth before contact",
          depth.normalized_intent === "sales_need_discovery_followup",
          `${depth.normalized_intent}: ${depth.assistant}`
        ),
        assertCondition(
          "product relation question is answered",
          productQ &&
            productQ.normalized_intent !== "human_or_ai_question" &&
            (productQ.normalized_intent === "post_completion_product_answer" ||
              productQ.normalized_intent === "product_relation_question" ||
              includesAll(productQ.assistant, ["website"])) &&
            (includesAll(productQ.assistant, ["ki-assistent"]) ||
              includesAll(productQ.assistant, ["assistent"])),
          productQ
            ? `${productQ.normalized_intent}: ${productQ.assistant}`
            : "missing product question turn"
        ),
        assertCondition(
          "no repeated Welche Frage loop on product answer turn",
          productQ ? excludes(productQ.assistant, "welche frage haben sie") : false,
          productQ?.assistant
        ),
        ...noBannedCallbackOutputChecks(results)
      ];
    }
  },
  v3_email_contact_closing: {
    turns: [
      "Ich interessiere mich fuer AI Assistant.",
      "Eigene Unternehmen.",
      "Leads sammeln mit dem Assistenten.",
      "Auf der Website und auch am Telefon.",
      "Per E-Mail."
    ],
    assert(results) {
      const email = results[4];
      const hasClosingQuestion =
        includesAll(email.assistant, ["kurze frage"]) ||
        includesAll(email.assistant, ["verabschieden"]) ||
        includesAll(email.assistant, ["noch eine frage"]);
      return [
        assertCondition(
          "email path includes configured contact email",
          email &&
            email.normalized_intent === "contact_preference_email" &&
            includesAll(email.assistant, ["info@technolohit.com"]),
          email ? `${email.normalized_intent}: ${email.assistant}` : "missing email turn"
        ),
        assertCondition(
          "email path includes closing or follow-up question",
          email && hasClosingQuestion && String(email.assistant).trim().length > 40,
          email?.assistant || "missing email turn"
        ),
        assertCondition(
          "email response is not empty or silent",
          email && normalizeText(email.assistant).length > 30,
          email?.assistant
        ),
        ...noBannedCallbackOutputChecks(results)
      ];
    }
  },
  v3_pricing_after_contact_capture: {
    context: {
      callerPhoneNormalized: "+491701234567",
      callerPhoneRaw: "+49 170 1234567"
    },
    turns: [
      "Ich interessiere mich fuer AI Assistant.",
      "Eigene Unternehmen.",
      "Leads sammeln mit dem Assistenten fuer meine Kunden.",
      "Auf der Website und auch am Telefon.",
      "Telefonisch.",
      "Ja.",
      "Wie steht kostet das?"
    ],
    assert(results) {
      const pricing = findTurn(results, "kostet");
      return [
        assertCondition(
          "pricing answered after contact capture",
          pricing &&
            (pricing.normalized_intent === "post_completion_pricing_answer" ||
              pricing.normalized_intent === "pricing_question") &&
            (includesAll(pricing.assistant, ["umfang"]) || includesAll(pricing.assistant, ["kosten"])),
          pricing ? `${pricing.normalized_intent}: ${pricing.assistant}` : "missing pricing turn"
        ),
        assertCondition(
          "no generic website redirect after contact captured",
          pricing
            ? excludes(pricing.assistant, "mehr informationen finden sie auf unserer website")
            : false,
          pricing?.assistant
        ),
        ...noBannedCallbackOutputChecks(results)
      ];
    }
  },
  v3_explanation_then_phone_handoff: {
    turns: [
      "Ich interessiere mich fuer AI Assistant.",
      "Kurze Erklaerung bitte.",
      "Telefonisch bitte."
    ],
    assert(results) {
      const explanation = results[1];
      const phone = results[2];
      return [
        assertCondition(
          "explanation before phone request",
          explanation.normalized_intent === "sales_product_explanation" &&
            hasProductExplanationContent(explanation.assistant),
          `${explanation.normalized_intent}: ${explanation.assistant}`
        ),
        assertCondition(
          "phone request moves to contact capture not customer-type loop",
          (phone.normalized_intent === "contact_preference_phone" ||
            phone.normalized_intent === "contact_preference_detected" ||
            phone.normalized_intent === "caller_id_callback_permission" ||
            includesAll(phone.assistant, ["telefonisch"]) ||
            includesAll(phone.assistant, ["kontaktieren"])) &&
            excludes(phone.assistant, CUSTOMER_TYPE_MENU_LOOP_SNIPPET),
          `${phone.normalized_intent}: ${phone.assistant}`
        ),
        assertCondition(
          "phone turn offers permission or callback path",
          includesAll(phone.assistant, ["team"]) ||
            includesAll(phone.assistant, ["kontaktieren"]) ||
            includesAll(phone.assistant, ["telefonnummer"]) ||
            includesAll(phone.assistant, ["nummer"]),
          phone.assistant
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
  sales_voice_agent_pitch_no_early_phone, sales_customer_type_stt_kundenprojekt,
  sales_customer_type_first_option, sales_customer_type_own_company_plural,
  sales_explanation_after_pitch, sales_new_prospect_qualification,
  sales_existing_customer_path,
  v3_live_customer_type_loop, v3_fuer_meine_firma, v3_repeated_unclear_no_loop,
  v3_rag_fail_closed_explanation, v3_explanation_then_phone_handoff,
  v3_sales_depth_before_handoff, v3_post_completion_product_question,
  v3_email_contact_closing,
  v3_pricing_after_contact_capture,
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
  validateSalesPlaybooks();

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
