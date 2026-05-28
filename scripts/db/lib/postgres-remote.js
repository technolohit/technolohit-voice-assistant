import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const PLACEHOLDER_VALUES = new Set([
  "",
  "your-monitoring-server",
  "your-ssh-user",
  "your-postgres-container-name",
  "your-postgres-container"
]);

const PLACEHOLDER_PATTERNS = [/^your-/i, /^changeme$/i];

export function repoRoot() {
  return process.cwd();
}

export function info(message) {
  console.log(`INFO ${message}`);
}

export function pass(message) {
  console.log(`PASS ${message}`);
}

export function fail(message) {
  console.error(`FAIL ${message}`);
  process.exit(1);
}

function expandHome(filePath) {
  if (!filePath) return "";
  if (filePath === "~") return os.homedir();
  if (filePath.startsWith("~/")) {
    return path.join(os.homedir(), filePath.slice(2));
  }
  return filePath;
}

function isPlaceholder(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (PLACEHOLDER_VALUES.has(normalized)) return true;
  return PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function loadDbConfig() {
  const host = String(process.env.DB_SSH_HOST ?? "").trim();
  const user = String(process.env.DB_SSH_USER ?? "").trim();
  const port = String(process.env.DB_SSH_PORT ?? "22").trim();
  const keyPath = expandHome(String(process.env.DB_SSH_KEY_PATH ?? "").trim());
  const dockerContainer = String(
    process.env.DB_DOCKER_CONTAINER ?? process.env.DB_POSTGRES_CONTAINER ?? ""
  ).trim();
  const dbName = String(process.env.DB_NAME ?? "technolohit_growth").trim();
  const adminUser = String(process.env.DB_ADMIN_USER ?? "postgres").trim();
  const remoteTmpDir = String(
    process.env.DB_REMOTE_TMP_DIR ?? "/tmp/th-voice-migrations"
  ).trim();

  if (!host) {
    fail(
      "DB_SSH_HOST is missing in .env. Example: DB_SSH_HOST=85.215.211.72 (see .env.example and db/README.md)."
    );
  }
  if (isPlaceholder(host)) {
    fail(
      `DB_SSH_HOST is still a placeholder (${host}). Set the monitoring server IP/hostname in .env.`
    );
  }
  if (!user) {
    fail("DB_SSH_USER is missing in .env. Example: DB_SSH_USER=moji");
  }
  if (isPlaceholder(user)) {
    fail(`DB_SSH_USER is still a placeholder (${user}). Set your SSH user in .env.`);
  }
  if (!dockerContainer) {
    fail(
      "DB_DOCKER_CONTAINER is missing in .env. Example: DB_DOCKER_CONTAINER=central_postgres (legacy alias: DB_POSTGRES_CONTAINER)."
    );
  }
  if (isPlaceholder(dockerContainer)) {
    fail(
      `DB_DOCKER_CONTAINER is still a placeholder (${dockerContainer}). Set the Docker Postgres container name in .env.`
    );
  }
  if (keyPath && !fs.existsSync(keyPath)) {
    fail(`DB_SSH_KEY_PATH does not exist: ${keyPath}`);
  }

  return {
    host,
    user,
    port,
    keyPath,
    dockerContainer,
    dbName,
    adminUser,
    remoteTmpDir,
    sshTarget: `${user}@${host}`
  };
}

export function printDbTarget(config) {
  info(`SSH: ${config.user}@${config.host}:${config.port}`);
  if (config.keyPath) {
    info(`SSH key: ${config.keyPath}`);
  }
  info(`Docker container: ${config.dockerContainer}`);
  info(`Database: ${config.dbName} (psql user: ${config.adminUser})`);
  info(`Remote staging dir (optional scp): ${config.remoteTmpDir}`);
}

function sshBaseArgs(config) {
  const args = [];
  if (config.port && config.port !== "22") {
    args.push("-p", config.port);
  }
  if (config.keyPath) {
    args.push("-i", config.keyPath);
  }
  args.push(config.sshTarget);
  return args;
}

function scpBaseArgs(config) {
  const args = [];
  if (config.port && config.port !== "22") {
    args.push("-P", config.port);
  }
  if (config.keyPath) {
    args.push("-i", config.keyPath);
  }
  return args;
}

function dockerPsqlArgv(config, extra = []) {
  return [
    "docker",
    "exec",
    "-i",
    config.dockerContainer,
    "psql",
    "-v",
    "ON_ERROR_STOP=1",
    "-U",
    config.adminUser,
    "-d",
    config.dbName,
    ...extra
  ];
}

function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    ...options
  });
  if (result.status !== 0) {
    const detail = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
    fail(`${command} failed (exit ${result.status})${detail ? `:\n${detail}` : ""}`);
  }
  return result;
}

export function runRemoteShell(config, shellCommand) {
  return runCommand("ssh", [...sshBaseArgs(config), shellCommand]);
}

export function pipeSql(config, sql, label) {
  if (label) info(`Applying SQL: ${label}`);
  runCommand("ssh", [...sshBaseArgs(config), ...dockerPsqlArgv(config)], {
    input: sql.endsWith("\n") ? sql : `${sql}\n`
  });
}

export function pipeSqlFile(config, localPath, label) {
  const resolved = path.resolve(localPath);
  if (!fs.existsSync(resolved)) {
    fail(`SQL file not found: ${resolved}`);
  }
  const sql = fs.readFileSync(resolved, "utf8");
  pipeSql(config, sql, label || path.basename(resolved));
}

export function scpSqlFileToRemote(config, localPath) {
  const resolved = path.resolve(localPath);
  if (!fs.existsSync(resolved)) {
    fail(`SQL file not found: ${resolved}`);
  }
  const remotePath = `${config.remoteTmpDir}/${path.basename(resolved)}`;
  info(`Staging ${resolved} → ${config.sshTarget}:${remotePath}`);
  runRemoteShell(config, `mkdir -p ${config.remoteTmpDir}`);
  runCommand("scp", [
    ...scpBaseArgs(config),
    resolved,
    `${config.sshTarget}:${remotePath}`
  ]);
  return remotePath;
}

export function applySqlFileRemote(config, localPath, { useScp = false } = {}) {
  if (useScp) {
    const remotePath = scpSqlFileToRemote(config, localPath);
    runRemoteShell(
      config,
      `docker exec -i ${config.dockerContainer} psql -v ON_ERROR_STOP=1 -U ${config.adminUser} -d ${config.dbName} < ${remotePath}`
    );
    return;
  }
  pipeSqlFile(config, localPath);
}

export function querySql(config, sql) {
  const result = runCommand("ssh", [
    ...sshBaseArgs(config),
    ...dockerPsqlArgv(config, ["-t", "-A"])
  ], {
    input: `${sql.trim()}\n`
  });
  return result.stdout.trim();
}

const VOICE_ROLE_PATTERN = /^[a-z_][a-z0-9_]{0,62}$/i;

export function loadVoiceRoleConfig() {
  const user = String(process.env.VOICE_DB_USER ?? "").trim();
  const password = String(process.env.VOICE_DB_PASSWORD ?? "");

  if (!user) {
    fail("VOICE_DB_USER is missing in .env. Example: VOICE_DB_USER=technolohit_voice_app");
  }
  if (isPlaceholder(user)) {
    fail(`VOICE_DB_USER is still a placeholder (${user}). Set the voice app role name in .env.`);
  }
  if (!VOICE_ROLE_PATTERN.test(user)) {
    fail(
      `VOICE_DB_USER must be a valid PostgreSQL role name (letters, digits, underscore; max 63 chars). Got: ${user}`
    );
  }
  if (!password) {
    fail("VOICE_DB_PASSWORD is missing in .env. Set a strong password for VOICE_DB_USER.");
  }
  if (isPlaceholder(password)) {
    fail("VOICE_DB_PASSWORD is still a placeholder. Set a real password in .env (never commit it).");
  }

  return { user, password };
}

export function escapeSqlLiteral(value) {
  return String(value).replace(/'/g, "''");
}

export function buildCreateOrUpdateRoleSql(roleName, password) {
  const roleLit = escapeSqlLiteral(roleName);
  const pwd = escapeSqlLiteral(password);
  return `
DO $voice_role$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = '${roleLit}') THEN
    CREATE ROLE ${roleName}
      LOGIN
      PASSWORD '${pwd}'
      NOSUPERUSER
      NOCREATEDB
      NOCREATEROLE
      NOREPLICATION;
  ELSE
    ALTER ROLE ${roleName}
      WITH LOGIN PASSWORD '${pwd}';
  END IF;
END
$voice_role$;
`.trim();
}

export function listVoiceMigrationFiles() {
  const dir = path.join(repoRoot(), "db", "voice", "migrations");
  if (!fs.existsSync(dir)) {
    fail(`Missing voice migrations directory: ${dir}`);
  }
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .sort((a, b) => a.localeCompare(b));
}

export function listKnowledgeMigrationFiles() {
  const dir = path.join(repoRoot(), "db", "knowledge", "migrations");
  if (!fs.existsSync(dir)) {
    fail(`Missing knowledge migrations directory: ${dir}`);
  }
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .sort((a, b) => a.localeCompare(b));
}

export function pipeSqlFileWithVars(config, localPath, psqlVars = {}, label) {
  const resolved = path.resolve(localPath);
  if (!fs.existsSync(resolved)) {
    fail(`SQL file not found: ${resolved}`);
  }
  const sql = fs.readFileSync(resolved, "utf8");
  const varArgs = Object.entries(psqlVars).flatMap(([key, value]) => ["-v", `${key}=${value}`]);
  if (label) info(`Applying SQL: ${label}`);
  runCommand("ssh", [...sshBaseArgs(config), ...dockerPsqlArgv(config, varArgs)], {
    input: sql.endsWith("\n") ? sql : `${sql}\n`
  });
}

export function backupDatabase(config, backupDir) {
  const dir = backupDir || path.join(repoRoot(), "db", "backups");
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "Z");
  const backupFile = path.join(dir, `${config.dbName}-${stamp}.sql`);
  info(`Backing up ${config.dbName} to ${backupFile}`);
  const dump = spawnSync(
    "ssh",
    [...sshBaseArgs(config), ...dockerPsqlArgv(config).slice(0, 4), "pg_dump", "-U", config.adminUser, config.dbName],
    { encoding: "buffer" }
  );
  if (dump.status !== 0) {
    const detail = [dump.stderr?.toString(), dump.stdout?.toString()].filter(Boolean).join("\n").trim();
    fail(`pg_dump over SSH failed${detail ? `:\n${detail}` : ""}`);
  }
  fs.writeFileSync(backupFile, dump.stdout);
  pass(`Backup written (${dump.stdout.length} bytes)`);
  return backupFile;
}
