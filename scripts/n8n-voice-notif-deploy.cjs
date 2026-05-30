/**
 * Deploy/update Tech-Voice-notif workflow via n8n API.
 * Reads API config from ~/.cursor/mcp.json (n8n-mcp server env args).
 * Does not print API keys.
 */
const fs = require("fs");
const https = require("https");
const path = require("path");
const { randomUUID } = require("crypto");

const WORKFLOW_ID = "3uWYMhQ6JfCqKmHv";
const WORKFLOW_NAME = "Tech-Voice-notif";
const WORKFLOW_EXPORT_PATH = path.join(__dirname, "..", "workflows", "n8n", "Tech-Voice-notif.workflow.json");

function loadApiConfig() {
  const mcpPath = path.join(process.env.USERPROFILE || process.env.HOME, ".cursor", "mcp.json");
  const mcp = JSON.parse(fs.readFileSync(mcpPath, "utf8"));
  const args = mcp.mcpServers["n8n-mcp"].args;
  const base = (args.find((a) => a.startsWith("N8N_API_URL=")) || "").replace("N8N_API_URL=", "");
  const key = (args.find((a) => a.startsWith("N8N_API_KEY=")) || "").replace("N8N_API_KEY=", "");
  if (!base || !key) throw new Error("Missing N8N_API_URL or N8N_API_KEY in mcp.json");
  return { base, key };
}

function request(method, apiPath, body) {
  const { base, key } = loadApiConfig();
  const url = new URL(apiPath, base.endsWith("/") ? base : `${base}/`);
  const payload = body ? JSON.stringify(body) : null;
  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        method,
        headers: {
          "X-N8N-API-KEY": key,
          Accept: "application/json",
          ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {})
        }
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          if (res.statusCode >= 400) {
            reject(new Error(`${method} ${url.pathname} failed ${res.statusCode}: ${data.slice(0, 500)}`));
            return;
          }
          resolve(data ? JSON.parse(data) : null);
        });
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function uuid() {
  return randomUUID();
}

const TELEGRAM_CRED = { telegramApi: { id: "WjjoP4hVedXo55Zy", name: "TechnoloHit Telegram Bot" } };
const EMAIL_CRED = { smtp: { id: "", name: "Ionos-Email-Tech" } };
const TELEGRAM_CHAT_ID = "1978700853";
const NOTIFY_EMAIL_TO = "info@technolohit.com";
const CLASSIFIED = "$('Classify Notification').first().json";

const normalizeCode = `const body = $json.body ?? $json;
const summary = body.summary ?? {};
const lead = body.lead ?? {};
const idempotency_key = \`voice-lead-notif:\${body.call_session_id ?? ''}:\${summary.id ?? ''}:\${lead.action ?? ''}\`;

return [{
  json: {
    type: body.type ?? "",
    occurred_at: body.occurred_at ?? new Date().toISOString(),
    call_session_id: body.call_session_id ?? "",
    external_call_id: body.external_call_id ?? "",
    bridge_call_id: body.bridge_call_id ?? "",
    summary_id: summary.id ?? "",
    summary_text: summary.text ?? "",
    product_interest: summary.product_interest ?? "",
    caller_need: summary.caller_need ?? "",
    contact_preference: summary.contact_preference ?? "",
    permission: summary.permission ?? "",
    next_action: summary.next_action ?? "",
    confidence: summary.confidence ?? "",
    transcript_quality_notes: summary.transcript_quality_notes ?? "",
    lead_action: lead.action ?? "",
    lead_reason: lead.reason ?? "",
    lead_id: lead.lead_id ?? "",
    idempotency_key
  }
}];`;

const dedupeCode = `const key = $json.idempotency_key;
const staticData = $getWorkflowStaticData('global');
if (!staticData.sentKeys || typeof staticData.sentKeys !== 'object') {
  staticData.sentKeys = {};
}
const existing = staticData.sentKeys[key];
if (existing) {
  return [{
    json: {
      ...$json,
      dedupe_status: 'duplicate',
      dedupe_previous: existing
    }
  }];
}

staticData.sentKeys[key] = {
  status: 'pending',
  call_session_id: $json.call_session_id,
  summary_id: $json.summary_id,
  lead_id: $json.lead_id,
  claimed_at: new Date().toISOString(),
  execution_id: $execution.id
};

return [{ json: { ...$json, dedupe_status: 'new' } }];`;

const classifyCode = `function clean(value, fallback = '-') {
  const text = String(value ?? '').replace(/\\s+/g, ' ').trim();
  return text || fallback;
}

function cleanMultiline(value, fallback = '-') {
  const text = String(value ?? '').replace(/\\r\\n/g, '\\n').replace(/\\n{3,}/g, '\\n\\n').trim();
  return text || fallback;
}

function short(value, max = 600) {
  const text = clean(value);
  if (text.length <= max) return text;
  return text.slice(0, max - 3).trimEnd() + '...';
}

function buildTelegramText(data) {
  if (data.notification_type === 'callback') {
    return [
      'CALLBACK LEAD',
      'Priority: HIGH',
      '',
      'What happened',
      'Product: ' + clean(data.product_interest),
      'Need: ' + short(data.caller_need, 280),
      'Contact: ' + clean(data.contact_preference),
      'Permission: ' + clean(data.permission),
      'Confidence: ' + clean(data.confidence),
      '',
      'Lead',
      'Status: ' + clean(data.lead_action) + ' (' + clean(data.lead_reason) + ')',
      'Lead ID: ' + clean(data.lead_id),
      '',
      'Next action',
      'Call back as soon as possible.',
      'Phone: not included in webhook payload yet.',
      '',
      'IDs',
      'Call session: ' + clean(data.call_session_id),
      'Summary: ' + clean(data.summary_id)
    ].join('\\n');
  }

  return [
    'VOICE LEAD REVIEW',
    'Priority: MEDIUM',
    '',
    'Reason: ' + clean(data.notification_reason),
    'Product: ' + clean(data.product_interest),
    'Need: ' + short(data.caller_need, 280),
    'Confidence: ' + clean(data.confidence),
    'Transcript notes: ' + clean(data.transcript_quality_notes),
    '',
    'Lead',
    'Status: ' + clean(data.lead_action) + ' (' + clean(data.lead_reason) + ')',
    'Lead ID: ' + clean(data.lead_id),
    '',
    'IDs',
    'Call session: ' + clean(data.call_session_id),
    'Summary: ' + clean(data.summary_id)
  ].join('\\n');
}

function buildEmailSubject(data) {
  const product = clean(data.product_interest, 'Unknown product');
  if (data.notification_type === 'callback') {
    return '[HIGH] Voice callback lead - ' + product;
  }
  return '[Review] Voice lead needs check - ' + product;
}

function buildEmailText(data) {
  const title = data.notification_type === 'callback'
    ? 'CALLBACK LEAD - TechnoloHit Voice Assistant'
    : 'VOICE LEAD REVIEW - TechnoloHit Voice Assistant';
  const action = data.notification_type === 'callback'
    ? 'Call this lead back as soon as possible. Phone is not included in the webhook payload yet; use the lead/call session lookup until the payload is enriched.'
    : 'Review this call before follow-up. It was routed here because of low confidence, manual review, or lead processing failure.';

  return [
    title,
    '',
    'ACTION',
    action,
    '',
    'LEAD SUMMARY',
    'Product interest: ' + clean(data.product_interest),
    'Caller need: ' + clean(data.caller_need),
    'Preferred contact: ' + clean(data.contact_preference),
    'Permission: ' + clean(data.permission),
    'Next action: ' + clean(data.next_action),
    'Confidence: ' + clean(data.confidence),
    'Transcript quality: ' + clean(data.transcript_quality_notes),
    '',
    'LEAD RESULT',
    'Action: ' + clean(data.lead_action),
    'Reason: ' + clean(data.lead_reason),
    'Lead ID: ' + clean(data.lead_id),
    '',
    'CALL IDS',
    'Call session ID: ' + clean(data.call_session_id),
    'External call ID: ' + clean(data.external_call_id),
    'Bridge call ID: ' + clean(data.bridge_call_id),
    'Summary ID: ' + clean(data.summary_id),
    '',
    'SUMMARY TEXT',
    cleanMultiline(data.summary_text),
    '',
    'Automatic notification from n8n workflow Tech-Voice-notif.'
  ].join('\\n');
}

let notification_type = 'ignore';
let priority = 'none';
let notification_reason = 'not_actionable';

const isCallback =
  $json.next_action === 'team_callback'
  && $json.permission === 'granted'
  && ['created', 'updated'].includes($json.lead_action);

const needsReview =
  $json.next_action === 'manual_review'
  || $json.confidence === 'low'
  || $json.lead_action === 'failed';

if (isCallback) {
  notification_type = 'callback';
  priority = 'high';
  notification_reason = 'callback_requested_permission_granted';
} else if (needsReview) {
  notification_type = 'review';
  priority = 'medium';
  notification_reason = 'manual_review_or_low_confidence';
}

const enriched = { ...$json, notification_type, priority, notification_reason };
return [{
  json: {
    ...enriched,
    telegram_text: buildTelegramText(enriched),
    email_subject: buildEmailSubject(enriched),
    email_text: buildEmailText(enriched)
  }
}];`;

const markSentCode = `const source = $('Classify Notification').first().json;
const key = source.idempotency_key;
const staticData = $getWorkflowStaticData('global');
if (!staticData.sentKeys || typeof staticData.sentKeys !== 'object') {
  staticData.sentKeys = {};
}

const tgNode = source.notification_type === 'callback' ? 'Send Telegram Callback' : 'Send Telegram Review';
const emailNode = source.notification_type === 'callback' ? 'Send Email Callback' : 'Send Email Review';
const tgItems = $(tgNode).all();
const emailItems = $(emailNode).all();
const tgFailed = tgItems.some((item) => item.json?.error);
const emailFailed = emailItems.some((item) => item.json?.error);

let delivery_status = 'sent';
if (tgFailed && emailFailed) delivery_status = 'failed';
else if (tgFailed || emailFailed) delivery_status = 'partial';

staticData.sentKeys[key] = {
  ...staticData.sentKeys[key],
  status: 'sent',
  call_session_id: source.call_session_id,
  summary_id: source.summary_id,
  lead_id: source.lead_id,
  notification_type: source.notification_type,
  delivery_status,
  telegram_sent_at: new Date().toISOString(),
  email_sent_at: new Date().toISOString(),
  execution_id: $execution.id
};

return [{
  json: {
    ...source,
    delivery_status,
    notification_recorded: delivery_status !== 'failed'
  }
}];`;

function buildWorkflow(existingWebhookNode) {
  const webhook = {
    ...existingWebhookNode,
    position: [0, 300],
    parameters: {
      ...existingWebhookNode.parameters,
      httpMethod: "POST",
      path: "voice/post-call",
      responseMode: "onReceived",
      options: {}
    }
  };

  const nodes = [
    webhook,
    {
      id: uuid(),
      name: "Normalize Payload",
      type: "n8n-nodes-base.code",
      typeVersion: 2,
      position: [220, 300],
      parameters: { mode: "runOnceForAllItems", jsCode: normalizeCode }
    },
    {
      id: uuid(),
      name: "Validate Payload",
      type: "n8n-nodes-base.if",
      typeVersion: 2.2,
      position: [440, 300],
      parameters: {
        conditions: {
          options: { caseSensitive: true, leftValue: "", typeValidation: "strict" },
          combinator: "and",
          conditions: [
            {
              id: uuid(),
              leftValue: "={{ $json.type }}",
              rightValue: "voice_post_call_outcome_v1",
              operator: { type: "string", operation: "equals" }
            },
            {
              id: uuid(),
              leftValue: "={{ $json.call_session_id }}",
              rightValue: "",
              operator: { type: "string", operation: "notEmpty" }
            },
            {
              id: uuid(),
              leftValue: "={{ $json.summary_id }}",
              rightValue: "",
              operator: { type: "string", operation: "notEmpty" }
            }
          ]
        }
      }
    },
    {
      id: uuid(),
      name: "Dedupe Check",
      type: "n8n-nodes-base.code",
      typeVersion: 2,
      position: [660, 300],
      parameters: { mode: "runOnceForAllItems", jsCode: dedupeCode }
    },
    {
      id: uuid(),
      name: "Is New Notification",
      type: "n8n-nodes-base.if",
      typeVersion: 2.2,
      position: [880, 300],
      parameters: {
        conditions: {
          options: { caseSensitive: true, leftValue: "", typeValidation: "strict" },
          combinator: "and",
          conditions: [
            {
              id: uuid(),
              leftValue: "={{ $json.dedupe_status }}",
              rightValue: "new",
              operator: { type: "string", operation: "equals" }
            }
          ]
        }
      }
    },
    {
      id: uuid(),
      name: "Classify Notification",
      type: "n8n-nodes-base.code",
      typeVersion: 2,
      position: [1100, 300],
      parameters: { mode: "runOnceForAllItems", jsCode: classifyCode }
    },
    {
      id: uuid(),
      name: "Route Notification",
      type: "n8n-nodes-base.switch",
      typeVersion: 3.2,
      position: [1320, 300],
      parameters: {
        rules: {
          values: [
            {
              conditions: {
                options: { caseSensitive: true, leftValue: "", typeValidation: "strict" },
                combinator: "and",
                conditions: [
                  {
                    leftValue: "={{ $json.notification_type }}",
                    rightValue: "callback",
                    operator: { type: "string", operation: "equals" }
                  }
                ]
              },
              renameOutput: true,
              outputKey: "callback"
            },
            {
              conditions: {
                options: { caseSensitive: true, leftValue: "", typeValidation: "strict" },
                combinator: "and",
                conditions: [
                  {
                    leftValue: "={{ $json.notification_type }}",
                    rightValue: "review",
                    operator: { type: "string", operation: "equals" }
                  }
                ]
              },
              renameOutput: true,
              outputKey: "review"
            }
          ]
        },
        options: { fallbackOutput: "extra" }
      }
    },
    {
      id: uuid(),
      name: "Send Telegram Callback",
      type: "n8n-nodes-base.telegram",
      typeVersion: 1.2,
      position: [1560, 120],
      parameters: {
        resource: "message",
        operation: "sendMessage",
        chatId: TELEGRAM_CHAT_ID,
        text: "={{ $json.telegram_text }}",
        additionalFields: {}
      },
      credentials: TELEGRAM_CRED,
      continueOnFail: true
    },
    {
      id: uuid(),
      name: "Send Email Callback",
      type: "n8n-nodes-base.emailSend",
      typeVersion: 2.1,
      position: [1780, 120],
      parameters: {
        fromEmail: "voice-assistant@technolohit.com",
        toEmail: NOTIFY_EMAIL_TO,
        subject: `={{ ${CLASSIFIED}.email_subject }}`,
        emailFormat: "text",
        text: `={{ ${CLASSIFIED}.email_text }}`,
        options: {}
      },
      credentials: EMAIL_CRED,
      continueOnFail: true
    },
    {
      id: uuid(),
      name: "Mark Notification Sent",
      type: "n8n-nodes-base.code",
      typeVersion: 2,
      position: [2000, 120],
      parameters: { mode: "runOnceForAllItems", jsCode: markSentCode }
    },
    {
      id: uuid(),
      name: "Send Telegram Review",
      type: "n8n-nodes-base.telegram",
      typeVersion: 1.2,
      position: [1560, 420],
      parameters: {
        resource: "message",
        operation: "sendMessage",
        chatId: TELEGRAM_CHAT_ID,
        text: "={{ $json.telegram_text }}",
        additionalFields: {}
      },
      credentials: TELEGRAM_CRED,
      continueOnFail: true
    },
    {
      id: uuid(),
      name: "Send Email Review",
      type: "n8n-nodes-base.emailSend",
      typeVersion: 2.1,
      position: [1780, 420],
      parameters: {
        fromEmail: "voice-assistant@technolohit.com",
        toEmail: NOTIFY_EMAIL_TO,
        subject: `={{ ${CLASSIFIED}.email_subject }}`,
        emailFormat: "text",
        text: `={{ ${CLASSIFIED}.email_text }}`,
        options: {}
      },
      credentials: EMAIL_CRED,
      continueOnFail: true
    },
    {
      id: uuid(),
      name: "Mark Review Sent",
      type: "n8n-nodes-base.code",
      typeVersion: 2,
      position: [2000, 420],
      parameters: { mode: "runOnceForAllItems", jsCode: markSentCode }
    },
    {
      id: uuid(),
      name: "Log Ignored",
      type: "n8n-nodes-base.set",
      typeVersion: 3.4,
      position: [1560, 640],
      parameters: {
        mode: "manual",
        duplicateItem: false,
        assignments: {
          assignments: [
            { id: uuid(), name: "status", value: "ignored", type: "string" },
            { id: uuid(), name: "notification_type", value: "={{ $json.notification_type }}", type: "string" },
            { id: uuid(), name: "call_session_id", value: "={{ $json.call_session_id }}", type: "string" },
            { id: uuid(), name: "next_action", value: "={{ $json.next_action }}", type: "string" },
            { id: uuid(), name: "lead_action", value: "={{ $json.lead_action }}", type: "string" }
          ]
        }
      }
    },
    {
      id: uuid(),
      name: "Log Duplicate",
      type: "n8n-nodes-base.set",
      typeVersion: 3.4,
      position: [880, 520],
      parameters: {
        mode: "manual",
        duplicateItem: false,
        assignments: {
          assignments: [
            { id: uuid(), name: "status", value: "duplicate_skipped", type: "string" },
            { id: uuid(), name: "idempotency_key", value: "={{ $json.idempotency_key }}", type: "string" }
          ]
        }
      }
    },
    {
      id: uuid(),
      name: "Log Invalid Payload",
      type: "n8n-nodes-base.set",
      typeVersion: 3.4,
      position: [440, 520],
      parameters: {
        mode: "manual",
        duplicateItem: false,
        assignments: {
          assignments: [
            { id: uuid(), name: "status", value: "invalid_payload", type: "string" },
            { id: uuid(), name: "type", value: "={{ $json.type }}", type: "string" }
          ]
        }
      }
    }
  ];

  const byName = Object.fromEntries(nodes.map((n) => [n.name, n]));

  const connections = {
    Webhook: { main: [[{ node: "Normalize Payload", type: "main", index: 0 }]] },
    "Normalize Payload": { main: [[{ node: "Validate Payload", type: "main", index: 0 }]] },
    "Validate Payload": {
      main: [
        [{ node: "Dedupe Check", type: "main", index: 0 }],
        [{ node: "Log Invalid Payload", type: "main", index: 0 }]
      ]
    },
    "Dedupe Check": { main: [[{ node: "Is New Notification", type: "main", index: 0 }]] },
    "Is New Notification": {
      main: [
        [{ node: "Classify Notification", type: "main", index: 0 }],
        [{ node: "Log Duplicate", type: "main", index: 0 }]
      ]
    },
    "Classify Notification": { main: [[{ node: "Route Notification", type: "main", index: 0 }]] },
    "Route Notification": {
      main: [
        [{ node: "Send Telegram Callback", type: "main", index: 0 }],
        [{ node: "Send Telegram Review", type: "main", index: 0 }],
        [{ node: "Log Ignored", type: "main", index: 0 }]
      ]
    },
    "Send Telegram Callback": { main: [[{ node: "Send Email Callback", type: "main", index: 0 }]] },
    "Send Email Callback": { main: [[{ node: "Mark Notification Sent", type: "main", index: 0 }]] },
    "Send Telegram Review": { main: [[{ node: "Send Email Review", type: "main", index: 0 }]] },
    "Send Email Review": { main: [[{ node: "Mark Review Sent", type: "main", index: 0 }]] }
  };

  return { nodes, connections, byName };
}

async function main() {
  const cmd = process.argv[2] || "deploy";
  const existing = await request("GET", `/api/v1/workflows/${WORKFLOW_ID}`);
  const webhookNode = existing.nodes.find((n) => n.name === "Webhook");
  if (!webhookNode) throw new Error("Webhook node not found");

  if (cmd === "show") {
    console.log(
      existing.nodes.map((n) => `${n.name} (${n.type})`).join("\n")
    );
    return;
  }

  const { nodes, connections } = buildWorkflow(webhookNode);
  const body = {
    name: WORKFLOW_NAME,
    nodes,
    connections,
    settings: { executionOrder: "v1" }
  };

  const updated = await request("PUT", `/api/v1/workflows/${WORKFLOW_ID}`, body);
  console.log("Updated workflow:", updated.name, "nodes:", updated.nodes.length);
  fs.mkdirSync(path.dirname(WORKFLOW_EXPORT_PATH), { recursive: true });
  fs.writeFileSync(WORKFLOW_EXPORT_PATH, `${JSON.stringify({ ...body, id: WORKFLOW_ID }, null, 2)}\n`);
  console.log("Wrote export:", WORKFLOW_EXPORT_PATH);

  if (cmd === "activate") {
    await request("POST", `/api/v1/workflows/${WORKFLOW_ID}/activate`);
    console.log("Workflow activated");
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
