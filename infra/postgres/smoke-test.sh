#!/bin/sh
# Checks a Postgres image built from this directory's Dockerfile: it starts, and a role that
# owns its database can create and use pgvector, as the feedback server's migration does.
#
#   infra/postgres/smoke-test.sh spainassistant/postgres:local
set -eu
image=$1
name=sa-postgres-smoke-$$

docker run -d --name "$name" -e POSTGRES_PASSWORD=smoke "$image" >/dev/null
trap 'docker rm -f "$name" >/dev/null' EXIT

# The entrypoint starts Postgres twice (the first time only on its socket, to initialize):
# wait for the one that listens on TCP.
i=0
until docker exec "$name" psql -U postgres -h 127.0.0.1 -Atc 'SELECT 1' >/dev/null 2>&1; do
  i=$((i + 1))
  if [ "$i" -ge 60 ]; then
    docker logs "$name" >&2
    echo "smoke-test: Postgres did not start" >&2
    exit 1
  fi
  sleep 1
done

docker exec -i "$name" psql -q -v ON_ERROR_STOP=1 -U postgres <<'SQL'
CREATE ROLE app LOGIN;
CREATE DATABASE app OWNER app;
SQL
distance=$(
  docker exec -i "$name" psql -q -v ON_ERROR_STOP=1 -U app -d app -At <<'SQL'
CREATE EXTENSION vector;
SELECT '[1,0]'::vector <=> '[0,1]'::vector;
SQL
)
if [ "$distance" != 1 ]; then
  echo "smoke-test: expected a cosine distance of 1, got: $distance" >&2
  exit 1
fi
echo "smoke-test: pgvector $(docker exec "$name" psql -U postgres -d app -Atc "SELECT extversion FROM pg_extension WHERE extname = 'vector'") works in $image"
