import path from "node:path";
import dotenv from "dotenv";
import {
  applySqlFileRemote,
  buildCreateOrUpdateRoleSql,
  fail,
  info,
  listVoiceMigrationFiles,
  loadDbConfig,
  loadVoiceRoleConfig,
  pass,
  pipeSql,
  pipeSqlFileWithVars,
  printDbTarget,
  repoRoot
} from "./db/lib/postgres-remote.js";

dotenv.config();

const useScp = String(process.env.DB_USE_SCP ?? "").toLowerCase() === "true";
const config = loadDbConfig();
const voiceRole = loadVoiceRoleConfig();

printDbTarget(config);
info(`Voice app role: ${voiceRole.user} (password from VOICE_DB_PASSWORD, not printed)`);

const migrations = listVoiceMigrationFiles();
if (!migrations.length) {
  fail("No SQL files in db/voice/migrations/.");
}

info(`Applying ${migrations.length} voice migration file(s) in lexical order.`);
info("Schema growth is not modified by this command.");

info("Creating or updating voice DB role (admin only, not stored in committed SQL).");
pipeSql(config, buildCreateOrUpdateRoleSql(voiceRole.user, voiceRole.password), "voice role");
pass(`Role ready: ${voiceRole.user}`);

for (const file of migrations) {
  const localPath = path.join(repoRoot(), "db", "voice", "migrations", file);

  if (file === "002_voice_grants.sql") {
    pipeSqlFileWithVars(
      config,
      localPath,
      { voice_db_user: voiceRole.user },
      file
    );
    pass(`Applied ${file} (grants for ${voiceRole.user})`);
    continue;
  }

  applySqlFileRemote(config, localPath, { useScp });
  pass(`Applied ${file}`);
}

console.log("");
pass("Voice schema migrations completed.");
console.log("Next: npm run db:test:voice");
console.log("Docs: docs/voice-database.md");
