-- Grants for the RAG API app role.
-- Applied with psql variable: -v rag_db_user=<role_name>

GRANT USAGE ON SCHEMA knowledge TO :"rag_db_user";

GRANT SELECT, INSERT, UPDATE, DELETE
ON ALL TABLES IN SCHEMA knowledge
TO :"rag_db_user";

GRANT USAGE, SELECT
ON ALL SEQUENCES IN SCHEMA knowledge
TO :"rag_db_user";

ALTER DEFAULT PRIVILEGES IN SCHEMA knowledge
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES
TO :"rag_db_user";

ALTER DEFAULT PRIVILEGES IN SCHEMA knowledge
GRANT USAGE, SELECT ON SEQUENCES
TO :"rag_db_user";
