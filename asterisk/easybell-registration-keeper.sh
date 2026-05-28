#!/bin/sh

REG_NAME="${EASYBELL_REGISTRATION_NAME:-easybell-registration}"
INTERVAL="${EASYBELL_REG_KEEPER_INTERVAL:-60}"
FORCE_EVERY="${EASYBELL_FORCE_REREGISTER_EVERY:-240}"

case "$INTERVAL" in
  ''|*[!0-9]*) INTERVAL=60 ;;
esac

case "$FORCE_EVERY" in
  ''|*[!0-9]*) FORCE_EVERY=240 ;;
esac

if [ "$INTERVAL" -lt 1 ]; then
  INTERVAL=60
fi

if [ "$FORCE_EVERY" -lt 1 ]; then
  FORCE_EVERY=240
fi

log() {
  printf '[easybell-keeper] %s\n' "$*" >&2
}

cli() {
  output="$(asterisk -rx "$1" 2>&1)"
  rc="$?"
  if [ "$rc" -ne 0 ]; then
    log "CLI command failed rc=${rc}: $1; ${output}"
  fi
  printf '%s\n' "$output"
  return 0
}

wait_for_cli() {
  while :; do
    output="$(asterisk -rx "core show uptime" 2>&1)"
    rc="$?"
    if [ "$rc" -eq 0 ] && printf '%s\n' "$output" | grep -qi "System uptime"; then
      return 0
    fi
    log "waiting for Asterisk CLI"
    sleep 2
  done
}

# Full PJSIP registration row (e.g. easybell-registration/sip:...). Do not parse the
# last column — Easybell output can end with "(exp. 236s)" which caused false status.
registration_line() {
  cli "pjsip show registrations" | grep -F "${REG_NAME}/" | head -n 1
}

word_in_line() {
  word="$1"
  line="$2"
  printf '%s\n' "$line" | grep -Eq "(^|[^[:alnum:]_])${word}([^[:alnum:]_]|$)"
}

registration_status() {
  line="$(registration_line)"
  if [ -z "$line" ]; then
    printf 'Unknown'
    return
  fi
  if word_in_line Registered "$line"; then
    printf 'Registered'
  elif word_in_line Unregistered "$line"; then
    printf 'Unregistered'
  else
    printf 'NotRegistered'
  fi
}

active_channel_count() {
  output="$(cli "core show channels count")"
  count="$(printf '%s\n' "$output" | sed -n 's/^[[:space:]]*\([0-9][0-9]*\)[[:space:]][[:space:]]*active channels*.*/\1/p' | head -n 1)"

  if [ -z "$count" ]; then
    log "could not parse active channel count; assuming active calls exist"
    printf 'unknown'
  else
    printf '%s' "$count"
  fi
}

has_active_calls() {
  count="$(active_channel_count)"
  if [ "$count" = "unknown" ]; then
    return 0
  fi
  if [ "$count" -gt 0 ]; then
    return 0
  fi
  return 1
}

send_register() {
  cli "pjsip send register ${REG_NAME}" >/dev/null
}

clean_reregister() {
  reason="$1"
  log "$reason"
  cli "pjsip send unregister ${REG_NAME}" >/dev/null
  sleep 2
  cli "pjsip send register ${REG_NAME}" >/dev/null
}

wait_for_cli

now="$(date +%s)"
next_force=$((now + FORCE_EVERY))

log "started registration keeper reg=${REG_NAME} interval=${INTERVAL}s force_every=${FORCE_EVERY}s"

while :; do
  send_register

  status="$(registration_status)"
  active_channels="$(active_channel_count)"
  log "status=${status} active_channels=${active_channels}"

  if [ "$status" != "Registered" ]; then
    if has_active_calls; then
      log "registration is ${status}; active call state is not idle, skipping clean re-register"
    else
      clean_reregister "registration is ${status}; clean re-register"
      status="$(registration_status)"
      active_channels="$(active_channel_count)"
      log "status=${status} active_channels=${active_channels}"
    fi
  fi

  now="$(date +%s)"
  if [ "$now" -ge "$next_force" ]; then
    if has_active_calls; then
      log "periodic clean re-register due but active call state is not idle; skipping"
    else
      clean_reregister "periodic clean re-register"
      status="$(registration_status)"
      active_channels="$(active_channel_count)"
      log "status=${status} active_channels=${active_channels}"
    fi
    next_force=$((now + FORCE_EVERY))
  fi

  sleep "$INTERVAL"
done
