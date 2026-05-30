import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const playbookPath = path.join(packageRoot, "knowledge", "sales-playbooks.technolohit.json");

let cachedPlaybooks = null;

function normalize(value) {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function loadSalesPlaybooks() {
  if (cachedPlaybooks) return cachedPlaybooks;
  const raw = fs.readFileSync(playbookPath, "utf8");
  const parsed = JSON.parse(raw);
  cachedPlaybooks = parsed;
  return parsed;
}

export function salesPlaybookByProduct(productId) {
  const playbooks = loadSalesPlaybooks();
  return (Array.isArray(playbooks.products) ? playbooks.products : []).find(
    (product) => product.id === productId
  ) || null;
}

export function buildSalesProductPitch(config, productId) {
  const playbook = salesPlaybookByProduct(productId);
  if (!playbook) return "";
  const shortPitches = {
    smart_website:
      "Eine Smart Website hilft, Angebote klarer zu zeigen und Anfragen besser vorzubereiten.",
    aiseoq:
      "AISeoQ hilft, Websites mit Wettbewerbern zu vergleichen und SEO-Massnahmen abzuleiten.",
    botinteg:
      "Botinteg hilft bei KI-Chatbots, wiederkehrenden Fragen und strukturierter Lead-Erfassung.",
    lokalki:
      "LokalKI hilft, interne Dokumente mit KI kontrollierter nutzbar zu machen.",
    voice_agent:
      "Die digitale Rezeption nimmt Anrufe an, beantwortet erste Fragen und bereitet Leads vor."
  };
  return `${shortPitches[productId] || playbook.positioning} Geht es um Ihr eigenes Unternehmen oder um ein Kundenprojekt?`;
}

export function classifyCustomerType(text) {
  const normalized = normalize(text);
  if (/\b(schon kunde|bereits kunde|bestandskunde|kunde bei ihnen|kundennummer|kunden nummer)\b/i.test(normalized)) {
    return "existing_customer";
  }
  if (/\b(kundenprojekt|fur kunden|fuer kunden|agentur|agency|it dienstleister|webagentur|kunde von mir)\b/i.test(normalized)) {
    return "agency_partner";
  }
  if (/\b(eigenes unternehmen|meine firma|mein unternehmen|unser unternehmen|neues projekt|neu|startup|selbst)\b/i.test(normalized)) {
    return "new_prospect";
  }
  return "unknown";
}

export function buildCustomerTypeResponse(customerType, productId) {
  const playbook = salesPlaybookByProduct(productId);
  const firstQuestion = Array.isArray(playbook?.qualifying_questions) && playbook.qualifying_questions.length
    ? playbook.qualifying_questions[0]
    : "Was ist bei Ihnen gerade das wichtigste Ziel?";

  if (customerType === "existing_customer") {
    return "Alles klar. Können Sie mir kurz den Firmennamen oder Ihre Kundennummer nennen, damit unser Team die Anfrage zuordnen kann?";
  }
  if (customerType === "agency_partner") {
    return "Verstanden. Geht es eher um Ihre eigene Nutzung oder möchten Sie das für Kundenprojekte einsetzen?";
  }
  if (customerType === "new_prospect") {
    return firstQuestion;
  }
  return "Geht es um Ihr eigenes Unternehmen, ein Kundenprojekt oder sind Sie bereits Kunde bei TechnoloHit?";
}

export function buildNeedDiscoveryResponse(productId, customerType, callerText) {
  const playbook = salesPlaybookByProduct(productId);
  const questions = Array.isArray(playbook?.qualifying_questions) ? playbook.qualifying_questions : [];
  if (customerType === "existing_customer") {
    return "Danke. Worum geht es bei Ihrer bestehenden Lösung gerade genau?";
  }
  if (customerType === "agency_partner") {
    return questions[1] || "Was soll die Lösung für Ihre Kunden konkret verbessern?";
  }
  return questions[1] || "Was möchten Sie damit konkret verbessern?";
}

export function buildHandoffOffer(productId) {
  const playbook = salesPlaybookByProduct(productId);
  const productName = playbook?.name || "dieses Thema";
  return `Das passt zu ${productName}. Soll unser Team das telefonisch mit Ihnen prüfen, oder möchten Sie lieber per E-Mail starten?`;
}

export function validateSalesPlaybooks() {
  const playbooks = loadSalesPlaybooks();
  if (!Array.isArray(playbooks.products) || playbooks.products.length < 5) {
    throw new Error("sales playbooks invalid: products must contain all TechnoloHit products");
  }
  for (const product of playbooks.products) {
    for (const field of ["id", "name", "positioning", "best_for", "pain_points", "value_props", "qualifying_questions", "safe_claims", "forbidden_claims"]) {
      if (product[field] == null || product[field] === "") {
        throw new Error(`sales playbooks invalid: ${product.id || "unknown"}.${field} missing`);
      }
    }
    if (!Array.isArray(product.qualifying_questions) || product.qualifying_questions.length < 1) {
      throw new Error(`sales playbooks invalid: ${product.id}.qualifying_questions must not be empty`);
    }
  }
}
