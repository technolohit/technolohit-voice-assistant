-- Least-privilege grants for the Lead Dashboard app role (schema voice only).
-- Run as PostgreSQL admin after db/voice/migrations/005_lead_dashboard_tables.sql.
-- Requires psql variable: lead_dashboard_db_user (role name). No passwords in this file.
-- Example:
-- docker exec -i central_postgres psql -U "$POSTGRES_USER" -d technolohit_growth \
--   -v lead_dashboard_db_user=technolohit_lead_dashboard_app \
--   -f /path/to/lead-dashboard-grants.sql

BEGIN;

GRANT CONNECT ON DATABASE technolohit_growth TO :"lead_dashboard_db_user";
GRANT USAGE ON SCHEMA voice TO :"lead_dashboard_db_user";

GRANT SELECT ON voice.leads TO :"lead_dashboard_db_user";
GRANT SELECT ON voice.call_sessions TO :"lead_dashboard_db_user";
GRANT SELECT ON voice.call_summaries TO :"lead_dashboard_db_user";

GRANT SELECT, INSERT ON voice.lead_access_audit TO :"lead_dashboard_db_user";
GRANT SELECT, INSERT, UPDATE ON voice.lead_followup_status TO :"lead_dashboard_db_user";

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA voice TO :"lead_dashboard_db_user";

REVOKE CREATE ON SCHEMA voice FROM :"lead_dashboard_db_user";
REVOKE ALL ON SCHEMA growth FROM :"lead_dashboard_db_user";
REVOKE ALL ON ALL TABLES IN SCHEMA growth FROM :"lead_dashboard_db_user";
REVOKE ALL ON ALL SEQUENCES IN SCHEMA growth FROM :"lead_dashboard_db_user";
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA growth FROM :"lead_dashboard_db_user";

COMMIT;
