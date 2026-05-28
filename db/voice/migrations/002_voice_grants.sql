-- Least-privilege grants for Voice Assistant app role (schema voice only).
-- Run as PostgreSQL admin after 001_voice_schema.sql.
-- Requires psql variable: voice_db_user (role name). No passwords in this file.
-- Example: psql ... -v voice_db_user=technolohit_voice_app -f 002_voice_grants.sql

BEGIN;

GRANT CONNECT ON DATABASE technolohit_growth TO :"voice_db_user";

GRANT USAGE ON SCHEMA voice TO :"voice_db_user";

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA voice TO :"voice_db_user";

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA voice TO :"voice_db_user";

ALTER DEFAULT PRIVILEGES IN SCHEMA voice
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO :"voice_db_user";

ALTER DEFAULT PRIVILEGES IN SCHEMA voice
  GRANT USAGE, SELECT ON SEQUENCES TO :"voice_db_user";

REVOKE CREATE ON SCHEMA voice FROM :"voice_db_user";

REVOKE ALL ON SCHEMA growth FROM :"voice_db_user";
REVOKE ALL ON ALL TABLES IN SCHEMA growth FROM :"voice_db_user";
REVOKE ALL ON ALL SEQUENCES IN SCHEMA growth FROM :"voice_db_user";
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA growth FROM :"voice_db_user";

COMMIT;
