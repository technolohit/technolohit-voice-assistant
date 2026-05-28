import path from "node:path";
import dotenv from "dotenv";
import {
  applySqlFileRemote,
  fail,
  info,
  listKnowledgeMigrationFiles,
  loadDbConfig,
  pass,
  pipeSqlFileWithVars,
  querySql,
  printDbTarget,
  repoRoot
} from "./db/lib/postgres-remote.js";

dotenv.config();

const useScp = String(process.env.DB_USE_SCP ?? "").toLowerCase() === "true";
const config = loadDbConfig();
const ragDbUser = String(process.env.RAG_DB_USER ?? "").trim();
const rolePattern = /^[a-z_][a-z0-9_]{0,62}$/i;
const productionPgvectorReady =
  String(process.env.PRODUCTION_PGVECTOR_READY ?? "").trim().toLowerCase() === "true";

printDbTarget(config);
info("Knowledge schema migrations require pgvector in the target database.");

if (!productionPgvectorReady) {
  fail(
    "PRODUCTION_PGVECTOR_READY must be true before applying knowledge migrations. Wait for Sysadmin pgvector cutover confirmation."
  );
}
pass("PRODUCTION_PGVECTOR_READY=true confirmed.");

const availableVector = querySql(
  config,
  "SELECT count(*) FROM pg_available_extensions WHERE name = 'vector';"
);
if (Number.parseInt(availableVector, 10) !== 1) {
  fail("pgvector is not available on this Postgres image. Stop: do infra pgvector cutover first.");
}
pass("pgvector is available in pg_available_extensions.");

const migrations = listKnowledgeMigrationFiles();
if (!migrations.length) {
  fail("No SQL files in db/knowledge/migrations/.");
}

info(`Applying ${migrations.length} knowledge migration file(s) in lexical order.`);
info("Schemas growth and voice are not modified by this command.");

for (const file of migrations) {
  const localPath = path.join(repoRoot(), "db", "knowledge", "migrations", file);
  if (file === "002_knowledge_grants.sql") {
    if (!ragDbUser || !rolePattern.test(ragDbUser)) {
      fail("RAG_DB_USER must be set to a valid Postgres role before applying knowledge grants.");
    }
    pipeSqlFileWithVars(config, localPath, { rag_db_user: ragDbUser }, file);
    pass(`Applied ${file} (grants for ${ragDbUser})`);
    continue;
  }
  applySqlFileRemote(config, localPath, { useScp });
  pass(`Applied ${file}`);
}

const installedVector = querySql(
  config,
  "SELECT extname || '|' || extversion FROM pg_extension WHERE extname = 'vector';"
);
if (!installedVector.startsWith("vector|")) {
  fail(`vector extension is not installed after migration. Got: ${installedVector || "(empty)"}`);
}
pass(`vector extension installed: ${installedVector}`);

const vectorColumns = querySql(
  config,
  "SELECT count(*) FROM information_schema.columns WHERE table_schema = 'knowledge' AND udt_name = 'vector';"
);
if (Number.parseInt(vectorColumns, 10) < 1) {
  fail(`Expected at least one knowledge vector column. Got: ${vectorColumns || "(empty)"}`);
}
pass(`knowledge vector columns: ${vectorColumns}`);

console.log("");
pass("Knowledge schema migrations completed.");
