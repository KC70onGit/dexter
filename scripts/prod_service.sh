#!/bin/zsh
set -euo pipefail

LABEL="com.keespronk.dexter-telegram.prod"
UID_VALUE="$(id -u)"
DOMAIN="gui/${UID_VALUE}"
SOURCE_PLIST="/Users/keespronk/Python_Dev/dexter-telegram/ops/launchd/${LABEL}.plist"
TARGET_PLIST="/Users/keespronk/Library/LaunchAgents/${LABEL}.plist"

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

is_loaded() {
  launchctl print "${DOMAIN}/${LABEL}" >/dev/null 2>&1
}

case "${1:-}" in
  install)
    require_plist
    mkdir -p /Users/keespronk/Library/LaunchAgents
    cp "${SOURCE_PLIST}" "${TARGET_PLIST}"
    launchctl bootout "${DOMAIN}/${LABEL}" >/dev/null 2>&1 || true
    launchctl bootstrap "${DOMAIN}" "${TARGET_PLIST}"
    launchctl kickstart -k "${DOMAIN}/${LABEL}"
    ;;
  start)
    launchctl kickstart -k "${DOMAIN}/${LABEL}"
    ;;
  stop)
    launchctl bootout "${DOMAIN}/${LABEL}"
    ;;
  restart)
    require_plist
    mkdir -p /Users/keespronk/Library/LaunchAgents
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
    tail -n 80 /Users/keespronk/Python/dexter-telegram/.dexter/launchd.stdout.log /Users/keespronk/Python/dexter-telegram/.dexter/launchd.stderr.log
    ;;
  *)
    usage
    exit 1
    ;;
esac
