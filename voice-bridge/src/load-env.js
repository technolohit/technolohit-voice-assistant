import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRootEnv = path.resolve(packageRoot, "..", ".env");
const localEnv = path.join(packageRoot, ".env");

/**
 * Load repo-root .env first, then voice-bridge/.env (local overrides).
 */
export function loadVoiceBridgeEnv() {
  if (fs.existsSync(repoRootEnv)) {
    dotenv.config({ path: repoRootEnv });
  }
  if (fs.existsSync(localEnv)) {
    dotenv.config({ path: localEnv, override: true });
  }
}
