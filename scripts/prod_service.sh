#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd -P)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd -P)"
LABEL="com.keespronk.dexter-telegram.prod"
UID_VALUE="$(id -u)"
DOMAIN="gui/${UID_VALUE}"
SOURCE_PLIST="${REPO_ROOT}/ops/launchd/${LABEL}.plist"
TARGET_PLIST="${HOME}/Library/LaunchAgents/${LABEL}.plist"
PROD_DIR="${HOME}/Python/dexter-telegram"
ENV_FILE="${PROD_DIR}/.env"
GATEWAY_CONFIG="${PROD_DIR}/.dexter/gateway.json"
SAFETY_STATE="${PROD_DIR}/.dexter/telegram-safety.json"

usage() {
  cat <<'EOF'
Usage:
  ./scripts/prod_service.sh install
  ./scripts/prod_service.sh start
  ./scripts/prod_service.sh stop
  ./scripts/prod_service.sh restart
  ./scripts/prod_service.sh uninstall
  ./scripts/prod_service.sh status
  ./scripts/prod_service.sh logs
EOF
}

require_plist() {
  if [[ ! -f "${SOURCE_PLIST}" ]]; then
    echo "Missing plist: ${SOURCE_PLIST}" >&2
    exit 1
  fi
}

require_runtime_inputs() {
  local missing=()

  [[ -f "${ENV_FILE}" ]] || missing+=("${ENV_FILE}")
  [[ -f "${GATEWAY_CONFIG}" ]] || missing+=("${GATEWAY_CONFIG}")
  [[ -f "${SAFETY_STATE}" ]] || missing+=("${SAFETY_STATE}")

  if (( ${#missing[@]} > 0 )); then
    echo "Missing required Dexter prod runtime files:" >&2
    for path in "${missing[@]}"; do
      echo "  - ${path}" >&2
    done
    echo "" >&2
    echo "Restore the missing gitignored runtime files before starting the launchd service." >&2
    exit 1
  fi

  python3 - "${ENV_FILE}" "${GATEWAY_CONFIG}" <<'PY'
import json
import sys
from pathlib import Path

env_path = Path(sys.argv[1])
gateway_path = Path(sys.argv[2])

errors = []

env_vars = {}
for line in env_path.read_text().splitlines():
    stripped = line.strip()
    if not stripped or stripped.startswith('#') or '=' not in stripped:
        continue
    key, value = stripped.split('=', 1)
    env_vars[key.strip()] = value.strip()

token = env_vars.get("TELEGRAM_BOT_TOKEN", "")
if not token or token.startswith("your-"):
    errors.append(f"{env_path} does not contain a usable TELEGRAM_BOT_TOKEN")

cfg = json.loads(gateway_path.read_text())
gateway = cfg.get("gateway", {}) or {}
telegram = ((cfg.get("channels", {}) or {}).get("telegram", {}) or {})
account_id = gateway.get("accountId") or "default"
account = ((telegram.get("accounts", {}) or {}).get(account_id, {}) or {})

channel_enabled = telegram.get("enabled", True)
account_enabled = account.get("enabled", True)
allow_from = account.get("allowFrom") or telegram.get("allowFrom") or []

if channel_enabled is False or account_enabled is False:
    errors.append(f"{gateway_path} has Telegram disabled for account '{account_id}'")
if not allow_from:
    errors.append(f"{gateway_path} has an empty Telegram allowFrom for account '{account_id}'")

if errors:
    for error in errors:
        print(error, file=sys.stderr)
    sys.exit(1)
PY
}

is_loaded() {
  launchctl print "${DOMAIN}/${LABEL}" >/dev/null 2>&1
}

case "${1:-}" in
  install)
    require_plist
    require_runtime_inputs
    mkdir -p "${HOME}/Library/LaunchAgents"
    cp "${SOURCE_PLIST}" "${TARGET_PLIST}"
    launchctl bootout "${DOMAIN}/${LABEL}" >/dev/null 2>&1 || true
    launchctl bootstrap "${DOMAIN}" "${TARGET_PLIST}"
    launchctl kickstart -k "${DOMAIN}/${LABEL}"
    ;;
  start)
    require_runtime_inputs
    launchctl kickstart -k "${DOMAIN}/${LABEL}"
    ;;
  stop)
    launchctl bootout "${DOMAIN}/${LABEL}"
    ;;
  restart)
    require_plist
    require_runtime_inputs
    mkdir -p "${HOME}/Library/LaunchAgents"
    cp "${SOURCE_PLIST}" "${TARGET_PLIST}"
    if ! is_loaded; then
      launchctl bootstrap "${DOMAIN}" "${TARGET_PLIST}"
    fi
    launchctl kickstart -k "${DOMAIN}/${LABEL}"
    ;;
  uninstall)
    launchctl bootout "${DOMAIN}/${LABEL}" >/dev/null 2>&1 || true
    rm -f "${TARGET_PLIST}"
    ;;
  status)
    launchctl print "${DOMAIN}/${LABEL}"
    ;;
  logs)
    tail -n 80 "${PROD_DIR}/.dexter/launchd.stdout.log" "${PROD_DIR}/.dexter/launchd.stderr.log"
    ;;
  *)
    usage
    exit 1
    ;;
esac
