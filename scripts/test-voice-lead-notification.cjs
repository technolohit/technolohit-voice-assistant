/**
 * Test Tech-Voice-notif webhook scenarios.
 * Usage: node scripts/test-voice-lead-notification.cjs [callback|review|ignore|duplicate]
 * Env: VOICE_NOTIF_WEBHOOK_URL (default production webhook URL)
 */
const https = require("https");
const http = require("http");

const DEFAULT_WEBHOOK = "https://wf.automobil-agent.de/webhook/voice/post-call";

function postJson(url, payload) {
  const body = JSON.stringify(payload);
  const target = new URL(url);
  const lib = target.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.request(
      target,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body)
        }
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          resolve({ status: res.statusCode, body: data });
        });
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function buildScenarios(runId) {
  return {
    callback: {
    type: "voice_post_call_outcome_v1",
    occurred_at: new Date().toISOString(),
    call_session_id: `test-callback-${runId}`,
    external_call_id: `ext-test-${runId}`,
    bridge_call_id: `bridge-test-${runId}`,
    summary: {
      id: `summary-test-${runId}`,
      text: "Caller wants callback about Smart Website.",
      product_interest: "Smart Website",
      caller_need: "Website refresh",
      contact_preference: "callback",
      permission: "granted",
      next_action: "team_callback",
      confidence: "high",
      transcript_quality_notes: ""
    },
    lead: { action: "created", reason: "ok", lead_id: `lead-test-${runId}` }
  },
  review: {
    type: "voice_post_call_outcome_v1",
    occurred_at: new Date().toISOString(),
    call_session_id: `test-review-${runId}`,
    external_call_id: `ext-test-review-${runId}`,
    bridge_call_id: `bridge-test-review-${runId}`,
    summary: {
      id: `summary-test-review-${runId}`,
      text: "Low confidence call needs manual review.",
      product_interest: "Botinteg",
      caller_need: "Chatbot",
      contact_preference: "callback",
      permission: "granted",
      next_action: "manual_review",
      confidence: "low",
      transcript_quality_notes: "STT unclear in middle section"
    },
    lead: { action: "skipped", reason: "low_confidence", lead_id: "" }
  },
  ignore: {
    type: "voice_post_call_outcome_v1",
    occurred_at: new Date().toISOString(),
    call_session_id: `test-ignore-${runId}`,
    external_call_id: `ext-test-ignore-${runId}`,
    bridge_call_id: `bridge-test-ignore-${runId}`,
    summary: {
      id: `summary-test-ignore-${runId}`,
      text: "Caller will email directly.",
      product_interest: "AISeoQ",
      caller_need: "SEO comparison",
      contact_preference: "email",
      permission: "not_requested",
      next_action: "await_customer_email",
      confidence: "high",
      transcript_quality_notes: ""
    },
    lead: { action: "skipped", reason: "await_email", lead_id: "" }
  }
  };
}

async function main() {
  const scenario = process.argv[2] || "callback";
  const url = process.env.VOICE_NOTIF_WEBHOOK_URL || DEFAULT_WEBHOOK;
  const runId = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const scenarios = buildScenarios(runId);

  if (scenario === "duplicate") {
    const first = await postJson(url, scenarios.callback);
    const second = await postJson(url, scenarios.callback);
    console.log("duplicate first", first.status, first.body.slice(0, 200));
    console.log("duplicate second", second.status, second.body.slice(0, 200));
    return;
  }

  const payload = scenarios[scenario];
  if (!payload) {
    console.error("Unknown scenario:", scenario);
    process.exit(1);
  }

  const result = await postJson(url, payload);
  console.log(scenario, "status", result.status);
  console.log(result.body.slice(0, 500));
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
