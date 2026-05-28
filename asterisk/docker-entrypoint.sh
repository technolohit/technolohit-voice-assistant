#!/bin/sh

set -u

ASTERISK_CONFIG_DIR="${ASTERISK_CONFIG_DIR:-/etc/asterisk}"
ASTERISK_TEMPLATE_DIR="${ASTERISK_TEMPLATE_DIR:-/etc/asterisk/templates}"
EASYBELL_REGISTRATION_NAME="${EASYBELL_REGISTRATION_NAME:-easybell-registration}"
KEEPER_BIN="${EASYBELL_REG_KEEPER_BIN:-/usr/local/bin/easybell-registration-keeper.sh}"

ASTERISK_PID=""
KEEPER_PID=""
STOPPING=0

log() {
  printf '[asterisk-entrypoint] %s\n' "$*"
}

copy_template_file() {
  name="$1"
  src="${ASTERISK_TEMPLATE_DIR}/${name}"
  dest="${ASTERISK_CONFIG_DIR}/${name}"

  if [ -f "$src" ]; then
    cp "$src" "$dest"
    log "copied ${name}"
  else
    log "template ${name} not present; keeping existing ${dest}"
  fi
}

render_pjsip() {
  src="${ASTERISK_TEMPLATE_DIR}/pjsip.conf.template"
  dest="${ASTERISK_CONFIG_DIR}/pjsip.conf"

  if [ -f "$src" ]; then
    envsubst < "$src" > "$dest"
    log "rendered pjsip.conf from template"
  else
    log "pjsip.conf.template not present; keeping existing ${dest}"
  fi
}

asterisk_cli() {
  asterisk -rx "$1" >/dev/null 2>&1 || true
}

stop_services() {
  if [ "$STOPPING" -eq 1 ]; then
    return
  fi
  STOPPING=1

  log "shutdown requested"

  if [ -n "$KEEPER_PID" ] && kill -0 "$KEEPER_PID" >/dev/null 2>&1; then
    log "stopping easybell registration keeper"
    kill "$KEEPER_PID" >/dev/null 2>&1 || true
    wait "$KEEPER_PID" >/dev/null 2>&1 || true
  fi

  log "unregistering ${EASYBELL_REGISTRATION_NAME}"
  asterisk_cli "pjsip send unregister ${EASYBELL_REGISTRATION_NAME}"
  sleep 3

  log "stopping Asterisk cleanly"
  asterisk_cli "core stop gracefully"

  if [ -n "$ASTERISK_PID" ]; then
    wait "$ASTERISK_PID" >/dev/null 2>&1 || true
  fi
}

trap 'stop_services' TERM INT

render_pjsip
copy_template_file extensions.conf
copy_template_file rtp.conf
copy_template_file logger.conf

if [ -f "${ASTERISK_TEMPLATE_DIR}/modules.conf" ]; then
  cp "${ASTERISK_TEMPLATE_DIR}/modules.conf" "${ASTERISK_CONFIG_DIR}/modules.conf"
  log "copied modules.conf"
else
  log "template modules.conf not present; keeping existing ${ASTERISK_CONFIG_DIR}/modules.conf"
fi

mkdir -p /var/log/asterisk/cdr-csv

log "starting Asterisk"
asterisk -f &
ASTERISK_PID="$!"

if [ -x "$KEEPER_BIN" ]; then
  log "starting easybell registration keeper"
  "$KEEPER_BIN" &
  KEEPER_PID="$!"
else
  log "keeper ${KEEPER_BIN} is not executable; skipping"
fi

wait "$ASTERISK_PID"
ASTERISK_EXIT="$?"

if [ "$STOPPING" -eq 0 ]; then
  if [ -n "$KEEPER_PID" ] && kill -0 "$KEEPER_PID" >/dev/null 2>&1; then
    kill "$KEEPER_PID" >/dev/null 2>&1 || true
    wait "$KEEPER_PID" >/dev/null 2>&1 || true
  fi
fi

exit "$ASTERISK_EXIT"
