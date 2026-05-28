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
    turns: [
      "Ich interessiere mich für Smart Website.",
      "Ja.",
      "Telefon.",
      "0170 1234567.",
      "Ja.",
      "Nein danke."
    ],
    assert(results) {
      const pitch = results[0];
      const yes = results[1];
      const phoneChoice = results[2];
      const phoneCapture = results[3];
      const permission = results[4];
      const close = results[5];
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
          "Telefon -> phone or permission request",
          includesAll(phoneChoice.assistant, ["telefonnummer"]) ||
            includesAll(phoneCapture.assistant, ["telefonnummer"]) ||
            includesAll(phoneChoice.assistant, ["kontaktieren"]) ||
            includesAll(phoneCapture.assistant, ["kontaktieren"]),
          `phone/permission request missing: ${phoneChoice.assistant} / ${phoneCapture.assistant}`
        ),
        assertCondition(
          "phone -> permission question",
          includesAll(permission.assistant, ["kontaktieren"]) || includesAll(permission.assistant, ["darf"]),
          permission.assistant
        ),
        assertCondition(
          "permission Ja -> final question",
          includesAll(permission.assistant, ["kurze frage"]) || includesAll(permission.assistant, ["verabschieden"]),
          permission.assistant
        ),
        assertCondition(
          "Nein danke -> warm goodbye",
          includesAll(close.assistant, ["wiederh"]) || includesAll(close.assistant, ["danke"]),
          close.assistant
        ),
        assertCondition(
          "Nein danke not clarification",
          excludes(close.assistant, "akustisch nicht gut verstanden"),
          close.assistant
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
    turns: [
      "Ich interessiere mich für Smart Website.",
      "Ja.",
      "Telefon.",
      "0170 1234567.",
      "Ja.",
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

Scenarios:
  smart_website_email, smart_website_phone, gate6_business_fallback,
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
  const ctx = createQaDialogueContext();
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
