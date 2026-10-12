#!/bin/sh
# Runs once, when the Postgres data volume is first initialized (docker-entrypoint-initdb.d).
# One database and one login role per service, so the key server and the feedback server cannot
# read each other's data. To change a password later: ALTER ROLE <role> PASSWORD '...';
set -eu

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
  -v key_password="$KEY_SERVER_DB_PASSWORD" \
  -v feedback_password="$FEEDBACK_DB_PASSWORD" <<'SQL'
CREATE ROLE key_server LOGIN PASSWORD :'key_password';
CREATE DATABASE keyserver OWNER key_server;
REVOKE ALL ON DATABASE keyserver FROM PUBLIC;

CREATE ROLE feedback LOGIN PASSWORD :'feedback_password';
CREATE DATABASE feedback OWNER feedback;
REVOKE ALL ON DATABASE feedback FROM PUBLIC;

-- Extensions the feedback server's Spanish full-text search uses (pre-created as superuser).
\connect feedback
CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
SQL
