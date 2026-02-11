#!/usr/bin/env bash
set -euo pipefail

cd /repo

export FIRSTCLAW_STATE_DIR="/tmp/firstclaw-test"
export FIRSTCLAW_CONFIG_PATH="${FIRSTCLAW_STATE_DIR}/firstclaw.json"

echo "==> Build"
pnpm build

echo "==> Seed state"
mkdir -p "${FIRSTCLAW_STATE_DIR}/credentials"
mkdir -p "${FIRSTCLAW_STATE_DIR}/agents/main/sessions"
echo '{}' >"${FIRSTCLAW_CONFIG_PATH}"
echo 'creds' >"${FIRSTCLAW_STATE_DIR}/credentials/marker.txt"
echo 'session' >"${FIRSTCLAW_STATE_DIR}/agents/main/sessions/sessions.json"

echo "==> Reset (config+creds+sessions)"
pnpm firstclaw reset --scope config+creds+sessions --yes --non-interactive

test ! -f "${FIRSTCLAW_CONFIG_PATH}"
test ! -d "${FIRSTCLAW_STATE_DIR}/credentials"
test ! -d "${FIRSTCLAW_STATE_DIR}/agents/main/sessions"

echo "==> Recreate minimal config"
mkdir -p "${FIRSTCLAW_STATE_DIR}/credentials"
echo '{}' >"${FIRSTCLAW_CONFIG_PATH}"

echo "==> Uninstall (state only)"
pnpm firstclaw uninstall --state --yes --non-interactive

test ! -d "${FIRSTCLAW_STATE_DIR}"

echo "OK"
