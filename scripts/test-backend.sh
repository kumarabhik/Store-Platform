#!/usr/bin/env bash
# Runs the backend tests in Node 20, the API image's runtime. This includes the SQLite suites,
# which skip on a host where better-sqlite3 can't load (Windows + Node 24, SYSTEM.md L13).
# Linux node_modules live in a named Docker volume, so the host's node_modules are untouched.
set -euo pipefail
cd "$(dirname "$0")/../backend-node"

# Git Bash on Windows: give Docker a Windows path and stop MSYS rewriting "/app".
src=$(pwd -W 2>/dev/null || pwd)
export MSYS_NO_PATHCONV=1

docker run --rm \
  -v "$src:/app" \
  -v store-platform-backend-node-modules:/app/node_modules \
  -w /app node:20-alpine \
  sh -c "apk add --no-cache python3 make g++ >/dev/null && npm ci --no-audit --no-fund >/dev/null && npx vitest run"
