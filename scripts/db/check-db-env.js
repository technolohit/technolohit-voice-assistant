import dotenv from "dotenv";
import { info, loadDbConfig, loadVoiceRoleConfig, pass, printDbTarget } from "./lib/postgres-remote.js";

dotenv.config();

const config = loadDbConfig();
printDbTarget(config);
pass("Database SSH/.env configuration is valid (no secrets printed).");

const voice = loadVoiceRoleConfig();
info(`Voice app role: ${voice.user} (VOICE_DB_PASSWORD is set, not printed)`);
pass("Voice DB env is ready for db:migrate:voice and db:test:voice.");
