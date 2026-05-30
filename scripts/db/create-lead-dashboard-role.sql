-- Optional role creation helper for TechnoloHit Lead Dashboard.
-- Run manually as PostgreSQL admin; replace the password before running.
-- Do not commit real passwords.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_roles
    WHERE rolname = 'technolohit_lead_dashboard_app'
  ) THEN
    CREATE ROLE technolohit_lead_dashboard_app
      LOGIN
      PASSWORD 'REPLACE_WITH_STRONG_PASSWORD';
  END IF;
END $$;
