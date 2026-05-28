import dotenv from "dotenv";
import {
  fail,
  info,
  loadDbConfig,
  loadVoiceRoleConfig,
  pass,
  pipeSql,
  printDbTarget,
  querySql
} from "./db/lib/postgres-remote.js";

dotenv.config();

const config = loadDbConfig();
const voiceRole = loadVoiceRoleConfig();
const externalCallId = `SMOKE-VOICE-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}`;
const extLit = externalCallId.replace(/'/g, "''");

printDbTarget(config);
info(`Voice app role: ${voiceRole.user}`);
info(`Smoke external_call_id: ${externalCallId}`);

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function extractUuid(text) {
  const match = String(text).match(UUID_RE);
  return match ? match[0].toLowerCase() : "";
}

/** One SSH/psql session: SET ROLE then SQL (no RESET — avoids noisy multi-line stdout). */
function queryAsVoiceRole(config, sqlBody) {
  return querySql(config, `SET ROLE ${voiceRole.user};\n${sqlBody.trim()}\n`);
}

info("Verifying voice role exists.");
const roleLit = voiceRole.user.replace(/'/g, "''");
const roleCheck = querySql(
  config,
  `SELECT rolname FROM pg_catalog.pg_roles WHERE rolname = '${roleLit}';`
);
if (!roleCheck.includes(voiceRole.user)) {
  fail(`Role ${voiceRole.user} not found. Run npm run db:migrate:voice first.`);
}
pass(`Role ${voiceRole.user} exists`);

info("Verifying schema voice and core tables.");
const tables = querySql(
  config,
  `SELECT table_name FROM information_schema.tables WHERE table_schema = 'voice' ORDER BY 1;`
);
for (const table of [
  "call_sessions",
  "call_events",
  "call_transcripts",
  "leads",
  "call_summaries"
]) {
  if (!tables.includes(table)) {
    fail(`Missing voice.${table}. Tables seen: ${tables || "(none)"}`);
  }
}
pass("All five voice tables present");

info("Verifying voice role has no access to schema growth (admin privilege check).");
const growthUsage = querySql(
  config,
  `SELECT has_schema_privilege('${roleLit}', 'growth', 'USAGE');`
);
const growthSelect = querySql(
  config,
  `SELECT has_table_privilege('${roleLit}', 'growth.prospects', 'SELECT');`
);
if (growthUsage === "t" || growthSelect === "t") {
  fail(
    `Voice role ${voiceRole.user} still has growth access (USAGE=${growthUsage}, SELECT prospects=${growthSelect}). Re-run npm run db:migrate:voice.`
  );
}
pass("Voice role cannot use schema growth or select growth.prospects");

info("Inserting smoke call_session and call_event as voice role.");
const sessionRaw = queryAsVoiceRole(
  config,
  `
INSERT INTO voice.call_sessions (
  external_call_id,
  provider,
  direction,
  status,
  caller_phone_normalized,
  metadata
) VALUES (
  '${extLit}',
  'smoke_test',
  'inbound',
  'completed',
  '+490000smoke',
  '{"source":"db:test:voice"}'::jsonb
)
RETURNING id::text;
`
);
const sessionId = extractUuid(sessionRaw);
if (!sessionId) {
  fail(`Could not parse session UUID from INSERT output: ${sessionRaw || "(empty)"}`);
}
pass(`Inserted call_sessions id=${sessionId}`);

const eventRaw = queryAsVoiceRole(
  config,
  `
INSERT INTO voice.call_events (
  call_session_id,
  event_type,
  event_source,
  payload
) VALUES (
  '${sessionId}'::uuid,
  'smoke_test',
  'db:test:voice',
  '{"ok":true}'::jsonb
)
RETURNING id::text;
`
);
const eventId = extractUuid(eventRaw);
if (!eventId) {
  fail(`Could not parse event UUID from INSERT output: ${eventRaw || "(empty)"}`);
}
pass(`Inserted call_events id=${eventId}`);

const joined = queryAsVoiceRole(
  config,
  `
SELECT cs.external_call_id || '|' || ce.event_type
FROM voice.call_sessions cs
JOIN voice.call_events ce ON ce.call_session_id = cs.id
WHERE cs.external_call_id = '${extLit}';
`
);
if (!joined.includes(externalCallId) || !joined.includes("smoke_test")) {
  fail(`Join verification failed. Got: ${joined || "(empty)"}`);
}
pass("Selected session and event via join");

info("Cleaning up smoke rows.");
pipeSql(
  config,
  `DELETE FROM voice.call_sessions WHERE external_call_id = '${extLit}';`,
  "delete smoke session"
);
pass("Deleted smoke call_session (cascade removes call_events)");

console.log("");
pass("Voice database smoke test completed.");
console.log(
  "Verified: schema voice, role grants, INSERT/SELECT on voice tables, no access to growth."
);
