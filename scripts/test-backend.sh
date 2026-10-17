#!/usr/bin/env bash
# Runs the backend tests in Node 20, the API image's runtime. This includes the SQLite suites,
# which skip on a host where better-sqlite3 can't load (Windows + Node 24, SYSTEM.md L13).
# Linux node_modules live in a named Docker volume, so the host's node_modules are untouched.
#
#   bash scripts/test-backend.sh             # every suite on SQLite
#   bash scripts/test-backend.sh --postgres  # the same suites on a throwaway Postgres (DESIGN §13.3)
set -euo pipefail
cd "$(dirname "$0")/../backend-node"

POSTGRES_IMAGE=postgres:17.10-alpine

# Git Bash on Windows: give Docker a Windows path and stop MSYS rewriting "/app".
src=$(pwd -W 2>/dev/null || pwd)
export MSYS_NO_PATHCONV=1

net_args=()
env_args=()
if [ "${1:-}" = "--postgres" ]; then
  net="sp-test-$$"
  docker network create "$net" >/dev/null
  # The password only exists inside this private network for the length of the run.
  docker run -d --rm --name "$net-pg" --network "$net" -e POSTGRES_PASSWORD=test -e POSTGRES_DB=test "$POSTGRES_IMAGE" >/dev/null
  trap 'docker rm -f "$net-pg" >/dev/null 2>&1; docker network rm "$net" >/dev/null 2>&1' EXIT
  for i in $(seq 1 30); do
    docker exec "$net-pg" pg_isready -U postgres -d test >/dev/null 2>&1 && break
    sleep 1
  done
  net_args=(--network "$net")
  env_args=(-e "TEST_DATABASE_URL=postgres://postgres:test@$net-pg:5432/test")
  echo "Running the backend tests against $POSTGRES_IMAGE"
fi

docker run --rm "${net_args[@]}" "${env_args[@]}" \
  -v "$src:/app" \
  -v store-platform-backend-node-modules:/app/node_modules \
  -w /app node:20-alpine \
  sh -c "apk add --no-cache python3 make g++ >/dev/null && npm ci --no-audit --no-fund >/dev/null && npx vitest run"
