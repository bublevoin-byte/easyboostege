import { randomUUID } from 'node:crypto';

export const DEFAULT_RESTORE_DEADLINE_MS = 1_800_000;
export const MIN_RESTORE_DEADLINE_MS = 60_000;
export const MAX_RESTORE_DEADLINE_MS = 3_600_000;

const CANONICAL_CONTAINER_ID = /^[0-9a-f]{64}$/u;
const CANONICAL_OPERATION_TOKEN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CANONICAL_SHA256 = /^[0-9a-f]{64}$/u;
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024 * 1024;
const MIN_CAPACITY_HEADROOM_BYTES = 1024 * 1024;
const MAX_CAPACITY_HEADROOM_BYTES = 256 * 1024 * 1024;
const CAPACITY_WRITE_CHUNK_BYTES = 1024 * 1024;
const CONTROL_CAPTURE_BYTES = 4_096;
const CONTROL_TIMEOUT_MS = 10_000;
const CANCEL_TIMEOUT_MS = 20_000;
const DEFAULT_PROBE_INTERVAL_MS = 1_000;
const DEFAULT_SETTLEMENT_PROBE_ATTEMPTS = 5;
const SHELL_DOLLAR = '$';

const STAGE_SCRIPT = String.raw`
set -eu
# EASYBOOST_RESTORE_STAGE
token="$EASYBOOST_RESTORE_OPERATION_TOKEN"
base="/tmp/easyboost-restore-${SHELL_DOLLAR}{token}"
archive="${SHELL_DOLLAR}{base}.dump"
reservation="${SHELL_DOLLAR}{base}.reserve"
status="${SHELL_DOLLAR}{base}.status"
bytes="$EASYBOOST_RESTORE_ARCHIVE_BYTES"
expected_sha256="$EASYBOOST_RESTORE_ARCHIVE_SHA256"
headroom_bytes="$EASYBOOST_RESTORE_CAPACITY_HEADROOM_BYTES"
umask 077
printf 'STAGING\n' > "${SHELL_DOLLAR}{status}.tmp"
mv "${SHELL_DOLLAR}{status}.tmp" "$status"
# EASYBOOST_RESTORE_CAPACITY_RESERVATION
required_kib=$(( (bytes + headroom_bytes + 1023) / 1024 ))
available_kib="$(df -Pk /tmp | awk 'END { print $4 }')"
case "$available_kib" in ''|*[!0-9]*) echo EASYBOOST_RESTORE_CONTAINER_CAPACITY_UNPROVEN >&2; exit 72;; esac
[ "$available_kib" -ge "$required_kib" ] \
  || { echo EASYBOOST_RESTORE_CONTAINER_CAPACITY_UNAVAILABLE >&2; exit 72; }
reserve_file() {
  target="$1"
  target_bytes="$2"
  full_blocks=$(( target_bytes / 1048576 ))
  remainder_bytes=$(( target_bytes % 1048576 ))
  dd if=/dev/zero bs=1048576 count="$full_blocks" > "$target" 2>/dev/null
  if [ "$remainder_bytes" -gt 0 ]; then
    dd if=/dev/zero bs="$remainder_bytes" count=1 >> "$target" 2>/dev/null
  fi
  [ "$(wc -c < "$target")" -eq "$target_bytes" ]
}
reserve_file "$archive" "$bytes"
reserve_file "$reservation" "$headroom_bytes"
dd of="$archive" bs=1048576 conv=notrunc 2>/dev/null
actual_bytes="$(wc -c < "$archive")"
actual_sha256="$(sha256sum "$archive" | awk '{ print $1 }')"
[ "$actual_bytes" -eq "$bytes" ] && [ "$actual_sha256" = "$expected_sha256" ] \
  || { echo EASYBOOST_RESTORE_STAGED_ARCHIVE_MISMATCH >&2; exit 73; }
printf 'STAGED\n' > "${SHELL_DOLLAR}{status}.tmp"
mv "${SHELL_DOLLAR}{status}.tmp" "$status"
`;

const RESTORE_PROCESS_IDENTITY_SCRIPT = String.raw`
read_process_record() (
  identity_pid="$1"
  identity_stat_file="/proc/${SHELL_DOLLAR}{identity_pid}/stat"
  [ -r "$identity_stat_file" ] || exit 1
  IFS= read -r identity_stat < "$identity_stat_file" || exit 1
  identity_fields="${SHELL_DOLLAR}{identity_stat##*) }"
  [ "$identity_fields" != "$identity_stat" ] || exit 1
  set -- $identity_fields
  [ "$#" -ge 20 ] || exit 1
  identity_state="$1"
  identity_start_time="${SHELL_DOLLAR}{20}"
  case "$identity_state" in [A-Za-z]) ;; *) exit 1;; esac
  case "$identity_start_time" in ''|*[!0-9]*) exit 1;; esac
  printf '%s:%s\n' "$identity_state" "$identity_start_time"
)
read_process_start_time() (
  identity_record="$(read_process_record "$1")" || exit 1
  printf '%s\n' "${SHELL_DOLLAR}{identity_record#*:}"
)
restore_identity_is_current() (
  identity_pid="$1"
  identity_expected_start_time="$2"
  identity_token="$3"
  identity_current_start_time="$(read_process_start_time "$identity_pid")" || exit 1
  [ "$identity_current_start_time" = "$identity_expected_start_time" ] || exit 1
  identity_environment_file="/proc/${SHELL_DOLLAR}{identity_pid}/environ"
  [ -r "$identity_environment_file" ] || exit 1
  tr '\000' '\n' < "$identity_environment_file" 2>/dev/null \
    | grep -Fqx "EASYBOOST_RESTORE_OPERATION_TOKEN=${SHELL_DOLLAR}{identity_token}" \
    || exit 1
  identity_current_start_time="$(read_process_start_time "$identity_pid")" || exit 1
  [ "$identity_current_start_time" = "$identity_expected_start_time" ]
)
observe_restore_identity() (
  identity_pid="$1"
  identity_expected_start_time="$2"
  if identity_record="$(read_process_record "$identity_pid")"; then
    identity_state="${SHELL_DOLLAR}{identity_record%%:*}"
    identity_current_start_time="${SHELL_DOLLAR}{identity_record#*:}"
    if [ "$identity_current_start_time" != "$identity_expected_start_time" ]; then
      printf 'REPLACED\n'
    elif [ "$identity_state" = 'Z' ]; then
      printf 'ZOMBIE\n'
    else
      printf 'LIVE\n'
    fi
  else
    if [ ! -e "/proc/${SHELL_DOLLAR}{identity_pid}/stat" ]; then
      printf 'GONE\n'
    else
      printf 'UNKNOWN\n'
    fi
  fi
)
`;

const WATCHDOG_SCRIPT = String.raw`
set -eu
# EASYBOOST_RESTORE_WATCHDOG
token="$EASYBOOST_RESTORE_OPERATION_TOKEN"
${RESTORE_PROCESS_IDENTITY_SCRIPT}
base="/tmp/easyboost-restore-${SHELL_DOLLAR}{token}"
archive="${SHELL_DOLLAR}{base}.dump"
reservation="${SHELL_DOLLAR}{base}.reserve"
status="${SHELL_DOLLAR}{base}.status"
pids="${SHELL_DOLLAR}{base}.pids"
restore_gate="${SHELL_DOLLAR}{base}.restore-gate"
restore_ready="${SHELL_DOLLAR}{base}.restore-ready"
watchdog_gate="${SHELL_DOLLAR}{base}.watchdog-gate"
watchdog_ready="${SHELL_DOLLAR}{base}.watchdog-ready"
cancel_marker="${SHELL_DOLLAR}{base}.cancel"
watchdog_stop_marker="${SHELL_DOLLAR}{base}.watchdog-stop"
outer_authority_marker="${SHELL_DOLLAR}{base}.outer-authority"
case "$EASYBOOST_RESTORE_DEADLINE_SECONDS" in
  ''|*[!0-9]*|0) exit 74;;
esac
umask 077
printf 'RUNNING\n' > "${SHELL_DOLLAR}{status}.tmp"
mv "${SHELL_DOLLAR}{status}.tmp" "$status"
restore_pid=''
restore_start_time=''
restore_reported_start_time=''
restore_settled='true'
watchdog_pid=''
watchdog_start_time=''
watchdog_reported_start_time=''
watchdog_settled='true'
reaped_status=74
wait_without_descendant() {
  wait_seconds="$1"
  wait_name="$2"
  wait_fifo="${SHELL_DOLLAR}{base}.${SHELL_DOLLAR}{wait_name}-wait"
  rm -f "$wait_fifo"
  mkfifo "$wait_fifo"
  exec 3<> "$wait_fifo"
  rm -f "$wait_fifo"
  read -r -t "$wait_seconds" ignored <&3 || true
  exec 3>&-
}
await_startup_ready() {
  ready_file="$1"
  attempt=0
  while [ "$attempt" -lt 50 ]; do
    if [ -r "$ready_file" ]; then
      IFS= read -r ready_value < "$ready_file" || return 1
      case "$ready_value" in READY:[0-9]*) ;; *) return 1;; esac
      startup_reported_start_time="${SHELL_DOLLAR}{ready_value#READY:}"
      case "$startup_reported_start_time" in ''|*[!0-9]*) return 1;; esac
      return
    fi
    attempt=$((attempt + 1))
    wait_without_descendant 0.1 "startup-${SHELL_DOLLAR}{attempt}"
  done
  return 1
}
control_marker_matches() {
  marker_file="$1"
  marker_verb="$2"
  [ -r "$marker_file" ] || return 1
  IFS= read -r marker_value < "$marker_file" || return 1
  [ "$marker_value" = "${SHELL_DOLLAR}{marker_verb}:${SHELL_DOLLAR}{token}" ]
}
publish_control_marker() {
  marker_file="$1"
  marker_verb="$2"
  marker_publisher="$3"
  marker_tmp="${SHELL_DOLLAR}{marker_file}.${SHELL_DOLLAR}{marker_publisher}.tmp"
  printf '%s:%s\n' "$marker_verb" "$token" > "$marker_tmp"
  mv "$marker_tmp" "$marker_file"
}
request_restore_cancel() {
  publish_control_marker "$cancel_marker" CANCEL "$1"
}
request_watchdog_stop() {
  publish_control_marker "$watchdog_stop_marker" STOP supervisor
}
terminate_restore_backends() {
  control_application_name="easyboost_restore_control_${SHELL_DOLLAR}{token}"
  target_application_name="easyboost_restore_${SHELL_DOLLAR}{token}"
  PGCONNECT_TIMEOUT=2 PGOPTIONS='-c statement_timeout=2000 -c lock_timeout=2000' PGAPPNAME="$control_application_name" psql --no-password -U easyboost -d easyboost -Atq \
    --set "appname=${SHELL_DOLLAR}{target_application_name}" \
    -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = :'appname' AND pid <> pg_backend_pid();" \
    >/dev/null 2>&1
}
reap_exact_child_if_exited() {
  child_pid="$1"
  child_start_time="$2"
  child_observation="$(observe_restore_identity \
    "$child_pid" "$child_start_time" "$token")" || child_observation='UNKNOWN'
  case "$child_observation" in
    ZOMBIE|GONE) ;;
    REPLACED) return 2;;
    LIVE) return 1;;
    *) return 2;;
  esac
  if wait "$child_pid" 2>/dev/null; then
    child_wait_status=0
  else
    child_wait_status="$?"
  fi
  [ "$child_wait_status" -ne 127 ] || child_wait_status=74
  child_after="$(observe_restore_identity \
    "$child_pid" "$child_start_time" "$token")" || child_after='UNKNOWN'
  case "$child_after" in GONE|REPLACED) ;; *) return 2;; esac
  reaped_status="$child_wait_status"
}
bounded_reap_exact_child() {
  child_pid="$1"
  child_start_time="$2"
  child_attempts="$3"
  child_wait_name="$4"
  attempt=0
  while [ "$attempt" -lt "$child_attempts" ]; do
    if reap_exact_child_if_exited "$child_pid" "$child_start_time"; then
      return 0
    fi
    attempt=$((attempt + 1))
    wait_without_descendant 1 \
      "${SHELL_DOLLAR}{child_wait_name}-${SHELL_DOLLAR}{child_pid}-${SHELL_DOLLAR}{attempt}"
  done
  reap_exact_child_if_exited "$child_pid" "$child_start_time"
}
bounded_reap_unknown_gated_child() {
  child_pid="$1"
  child_attempts="$2"
  child_wait_name="$3"
  attempt=0
  while [ "$attempt" -lt "$child_attempts" ]; do
    if child_record="$(read_process_record "$child_pid")"; then
      child_state="${SHELL_DOLLAR}{child_record%%:*}"
      child_discovered_start="${SHELL_DOLLAR}{child_record#*:}"
      if [ "$child_state" = 'Z' ]; then
        child_zombie_record="$(read_process_record "$child_pid")" || return 2
        [ "$child_zombie_record" = "Z:${SHELL_DOLLAR}{child_discovered_start}" ] || return 2
        if wait "$child_pid" 2>/dev/null; then
          reaped_status=0
        else
          reaped_status="$?"
        fi
        [ "$reaped_status" -ne 127 ] || return 2
        return 0
      fi
      if restore_identity_is_current \
        "$child_pid" "$child_discovered_start" "$token"; then
        bounded_reap_exact_child "$child_pid" "$child_discovered_start" \
          "$((child_attempts - attempt))" "$child_wait_name"
        return
      fi
    elif [ ! -e "/proc/${SHELL_DOLLAR}{child_pid}/stat" ]; then
      if wait "$child_pid" 2>/dev/null; then reaped_status=0; else reaped_status="$?"; fi
      [ "$reaped_status" -ne 127 ] || reaped_status=74
      return 0
    fi
    attempt=$((attempt + 1))
    wait_without_descendant 1 \
      "${SHELL_DOLLAR}{child_wait_name}-unknown-${SHELL_DOLLAR}{attempt}"
  done
  return 1
}
settle_gated_child() {
  child_pid="$1"
  child_reported_start="$2"
  child_wait_name="$3"
  if [ -n "$child_reported_start" ]; then
    bounded_reap_exact_child "$child_pid" "$child_reported_start" 2 "$child_wait_name"
  else
    bounded_reap_unknown_gated_child "$child_pid" 2 "$child_wait_name"
  fi
}
finish_restore_supervisor() {
  finish_status="$1"
  trap - EXIT HUP INT TERM
  printf 'EXIT:%s\n' "$finish_status" > "${SHELL_DOLLAR}{status}.tmp"
  mv "${SHELL_DOLLAR}{status}.tmp" "$status"
  rm -f "$archive" "$reservation" "$pids" \
    "${SHELL_DOLLAR}{pids}.tmp" "$restore_gate" "$restore_ready" \
    "${SHELL_DOLLAR}{restore_ready}.tmp" "$watchdog_gate" "$watchdog_ready" \
    "${SHELL_DOLLAR}{watchdog_ready}.tmp" "$cancel_marker" \
    "${SHELL_DOLLAR}{cancel_marker}".*.tmp "$watchdog_stop_marker" \
    "${SHELL_DOLLAR}{watchdog_stop_marker}".*.tmp "$outer_authority_marker" \
    "${SHELL_DOLLAR}{outer_authority_marker}.tmp" "${SHELL_DOLLAR}{base}".*-wait
  exit "$finish_status"
}
leave_restore_supervisor_unsettled() {
  trap - EXIT HUP INT TERM
  printf 'OUTER:%s\n' "$token" > "${SHELL_DOLLAR}{outer_authority_marker}.tmp"
  mv "${SHELL_DOLLAR}{outer_authority_marker}.tmp" "$outer_authority_marker"
  exec 4>&-
  exec 5>&-
  rm -f "$restore_gate" "$restore_ready" "${SHELL_DOLLAR}{restore_ready}.tmp" \
    "$watchdog_gate" "$watchdog_ready" "${SHELL_DOLLAR}{watchdog_ready}.tmp" \
    "${SHELL_DOLLAR}{pids}.tmp" "${SHELL_DOLLAR}{base}".*-wait
  exit 74
}
settle_after_unexpected_exit() {
  trap - EXIT HUP INT TERM
  set +e
  exec 4>&-
  exec 5>&-
  rm -f "$restore_gate" "$restore_ready" "${SHELL_DOLLAR}{restore_ready}.tmp" \
    "$watchdog_gate" "$watchdog_ready" "${SHELL_DOLLAR}{watchdog_ready}.tmp"
  request_restore_cancel supervisor-exit
  terminate_restore_backends
  if [ -n "$watchdog_pid" ]; then
    if [ -n "$watchdog_start_time" ]; then
      if bounded_reap_exact_child "$watchdog_pid" "$watchdog_start_time" 2 exit-watchdog; then
        watchdog_settled='true'
      else
        watchdog_settled='false'
      fi
    else
      if settle_gated_child \
        "$watchdog_pid" "$watchdog_reported_start_time" exit-watchdog; then
        watchdog_settled='true'
      else
        watchdog_settled='false'
      fi
    fi
  fi
  if [ -n "$restore_pid" ]; then
    if [ -n "$restore_start_time" ]; then
      if bounded_reap_exact_child "$restore_pid" "$restore_start_time" 2 exit-restore; then
        restore_settled='true'
      else
        restore_settled='false'
      fi
    else
      if settle_gated_child "$restore_pid" "$restore_reported_start_time" exit-restore; then
        restore_settled='true'
      else
        restore_settled='false'
      fi
    fi
  fi
  if [ "$watchdog_settled" != 'true' ] || [ "$restore_settled" != 'true' ]; then
    leave_restore_supervisor_unsettled
  fi
  finish_restore_supervisor 74
}
trap settle_after_unexpected_exit EXIT
trap 'exit 74' HUP INT TERM
rm -f "$restore_gate" "$restore_ready" "$watchdog_gate" "$watchdog_ready"
if control_marker_matches "$cancel_marker" CANCEL; then
  finish_restore_supervisor 74
fi
mkfifo "$restore_gate"
exec 4<> "$restore_gate"
(
  exec 6< "$restore_gate"
  exec 4>&-
  IFS= read -r own_stat < /proc/self/stat || exit 74
  own_fields="${SHELL_DOLLAR}{own_stat##*) }"
  [ "$own_fields" != "$own_stat" ] || exit 74
  set -- $own_fields
  [ "$#" -ge 20 ] || exit 74
  own_start_time="${SHELL_DOLLAR}{20}"
  case "$own_start_time" in ''|*[!0-9]*) exit 74;; esac
  printf 'READY:%s\n' "$own_start_time" > "${SHELL_DOLLAR}{restore_ready}.tmp"
  mv "${SHELL_DOLLAR}{restore_ready}.tmp" "$restore_ready"
  IFS= read -r startup_command <&6 || exit 74
  exec 6<&-
  [ "$startup_command" = 'GO' ] || exit 74
  if control_marker_matches "$cancel_marker" CANCEL; then exit 74; fi
  exec pg_restore -U easyboost -d easyboost --clean --if-exists \
    --no-owner --no-privileges --exit-on-error < "$archive"
) &
restore_pid="$!"
restore_settled='false'
if ! await_startup_ready "$restore_ready" \
  || ! restore_reported_start_time="$startup_reported_start_time" \
  || ! restore_start_time="$(read_process_start_time "$restore_pid")" \
  || [ "$restore_start_time" != "$restore_reported_start_time" ] \
  || ! restore_identity_is_current "$restore_pid" "$restore_start_time" "$token"; then
  exec 4>&-
  rm -f "$restore_gate" "$restore_ready" "${SHELL_DOLLAR}{restore_ready}.tmp"
  if settle_gated_child "$restore_pid" "$restore_reported_start_time" restore-startup; then
    restore_settled='true'
  else
    leave_restore_supervisor_unsettled
  fi
  restore_pid=''
  finish_restore_supervisor 74
fi
printf 'GO\n' >&4
exec 4>&-
rm -f "$restore_gate" "$restore_ready" "${SHELL_DOLLAR}{restore_ready}.tmp"
printf '%s:%s:%s\n' "$$" "$restore_pid" "$restore_start_time" > "${SHELL_DOLLAR}{pids}.tmp"
mv "${SHELL_DOLLAR}{pids}.tmp" "$pids"
mkfifo "$watchdog_gate"
exec 5<> "$watchdog_gate"
(
  exec 7< "$watchdog_gate"
  exec 5>&-
  IFS= read -r own_stat < /proc/self/stat || exit 74
  own_fields="${SHELL_DOLLAR}{own_stat##*) }"
  [ "$own_fields" != "$own_stat" ] || exit 74
  set -- $own_fields
  [ "$#" -ge 20 ] || exit 74
  own_start_time="${SHELL_DOLLAR}{20}"
  case "$own_start_time" in ''|*[!0-9]*) exit 74;; esac
  printf 'READY:%s\n' "$own_start_time" > "${SHELL_DOLLAR}{watchdog_ready}.tmp"
  mv "${SHELL_DOLLAR}{watchdog_ready}.tmp" "$watchdog_ready"
  IFS= read -r startup_command <&7 || exit 74
  exec 7<&-
  [ "$startup_command" = 'GO' ] || exit 74
  watchdog_attempt=0
  watchdog_attempts="$EASYBOOST_RESTORE_DEADLINE_SECONDS"
  while [ "$watchdog_attempt" -lt "$watchdog_attempts" ]; do
    if control_marker_matches "$watchdog_stop_marker" STOP; then exit 0; fi
    if control_marker_matches "$cancel_marker" CANCEL; then
      terminate_restore_backends || true
      exit 0
    fi
    watchdog_attempt=$((watchdog_attempt + 1))
    wait_without_descendant 1 "deadline-${SHELL_DOLLAR}{watchdog_attempt}"
  done
  request_restore_cancel watchdog || true
  terminate_restore_backends || true
) &
watchdog_pid="$!"
watchdog_settled='false'
if ! await_startup_ready "$watchdog_ready" \
  || ! watchdog_reported_start_time="$startup_reported_start_time" \
  || ! watchdog_start_time="$(read_process_start_time "$watchdog_pid")" \
  || [ "$watchdog_start_time" != "$watchdog_reported_start_time" ] \
  || ! restore_identity_is_current "$watchdog_pid" "$watchdog_start_time" "$token"; then
  exec 5>&-
  rm -f "$watchdog_gate" "$watchdog_ready" "${SHELL_DOLLAR}{watchdog_ready}.tmp"
  if settle_gated_child "$watchdog_pid" "$watchdog_reported_start_time" watchdog-startup; then
    watchdog_settled='true'
  fi
  watchdog_pid=''
  request_restore_cancel watchdog-startup || true
  terminate_restore_backends || true
  if bounded_reap_exact_child "$restore_pid" "$restore_start_time" 2 restore-cancel; then
    restore_settled='true'
  fi
  if [ "$watchdog_settled" != 'true' ] || [ "$restore_settled" != 'true' ]; then
    leave_restore_supervisor_unsettled
  fi
  restore_pid=''
  finish_restore_supervisor 74
fi
printf 'GO\n' >&5
exec 5>&-
rm -f "$watchdog_gate" "$watchdog_ready" "${SHELL_DOLLAR}{watchdog_ready}.tmp"
restore_wait_attempts="$EASYBOOST_RESTORE_DEADLINE_SECONDS"
if bounded_reap_exact_child \
  "$restore_pid" "$restore_start_time" "$restore_wait_attempts" restore; then
  restore_status="$reaped_status"
  restore_settled='true'
else
  request_restore_cancel supervisor || true
  terminate_restore_backends || true
  if bounded_reap_exact_child "$restore_pid" "$restore_start_time" 1 restore-cancel; then
    restore_status="$reaped_status"
    restore_settled='true'
  else
    leave_restore_supervisor_unsettled
  fi
fi
request_watchdog_stop || true
if bounded_reap_exact_child "$watchdog_pid" "$watchdog_start_time" 2 watchdog-stop; then
  watchdog_settled='true'
else
  leave_restore_supervisor_unsettled
fi
watchdog_pid=''
restore_pid=''
if control_marker_matches "$cancel_marker" CANCEL && [ "$restore_status" -eq 0 ]; then
  restore_status=74
fi
finish_restore_supervisor "$restore_status"
`;

const PROBE_SCRIPT = String.raw`
set -eu
# EASYBOOST_RESTORE_PROBE
token="$1"
probe_phase="${SHELL_DOLLAR}{2:-before}"
case "$probe_phase" in before|after) ;; *) exit 74;; esac
base="/tmp/easyboost-restore-${SHELL_DOLLAR}{token}"
status_file="${SHELL_DOLLAR}{base}.status"
status='PENDING'
read_remote_status() {
  status='PENDING'
  if [ -e "$status_file" ]; then
    if [ -r "$status_file" ] && status_value="$(head -n 1 "$status_file" 2>/dev/null)"; then
      status="$status_value"
    else
      status='UNKNOWN'
    fi
  fi
}
process='NONE'
process_unknown='false'
scan_remote_processes() {
  process='NONE'
  process_unknown='false'
  for stat_file in /proc/[0-9]*/stat; do
    [ -e "$stat_file" ] || continue
    process_pid="${SHELL_DOLLAR}{stat_file#/proc/}"
    process_pid="${SHELL_DOLLAR}{process_pid%/stat}"
    if ! IFS= read -r process_stat < "$stat_file"; then
      [ ! -e "$stat_file" ] || process_unknown='true'
      continue
    fi
    process_fields="${SHELL_DOLLAR}{process_stat##*) }"
    if [ "$process_fields" = "$process_stat" ]; then
      [ ! -e "$stat_file" ] || process_unknown='true'
      continue
    fi
    set -- $process_fields
    if [ "$#" -lt 20 ]; then
      [ ! -e "$stat_file" ] || process_unknown='true'
      continue
    fi
    process_state="$1"
    process_start_time="${SHELL_DOLLAR}{20}"
    [ "$process_state" = 'Z' ] && continue
    environment_file="/proc/${SHELL_DOLLAR}{process_pid}/environ"
    if [ ! -r "$environment_file" ]; then
      [ ! -e "$stat_file" ] || process_unknown='true'
      continue
    fi
    if ! process_environment="$(tr '\000' '\n' < "$environment_file" 2>/dev/null)"; then
      [ ! -e "$stat_file" ] || process_unknown='true'
      continue
    fi
    if printf '%s\n' "$process_environment" \
      | grep -Fqx "EASYBOOST_RESTORE_OPERATION_TOKEN=${SHELL_DOLLAR}{token}"; then
      if ! IFS= read -r process_stat_after < "$stat_file"; then
        process_unknown='true'
        continue
      fi
      process_fields_after="${SHELL_DOLLAR}{process_stat_after##*) }"
      if [ "$process_fields_after" = "$process_stat_after" ]; then
        process_unknown='true'
        continue
      fi
      set -- $process_fields_after
      if [ "$#" -lt 20 ] || [ "${SHELL_DOLLAR}{20}" != "$process_start_time" ]; then
        process_unknown='true'
        continue
      fi
      if [ "$1" != 'Z' ]; then
        process='ACTIVE'
        break
      fi
    fi
  done
  if [ "$process" = 'NONE' ] && [ "$process_unknown" = 'true' ]; then
    process='UNKNOWN'
  fi
}
if [ "$probe_phase" = 'before' ]; then
  read_remote_status
  scan_remote_processes
else
  scan_remote_processes
  read_remote_status
fi
printf 'STATUS=%s\nPROCESS=%s\n' "$status" "$process"
`;

const CANCEL_SCRIPT = String.raw`
set -eu
# EASYBOOST_RESTORE_CANCEL
token="$1"
case "$token" in
  ????????-????-4???-[89ab]???-????????????) ;;
  *) exit 74;;
esac
base="/tmp/easyboost-restore-${SHELL_DOLLAR}{token}"
cancel_marker="${SHELL_DOLLAR}{base}.cancel"
cancel_tmp="${SHELL_DOLLAR}{cancel_marker}.external.tmp"
printf 'CANCEL:%s\n' "$token" > "$cancel_tmp"
mv "$cancel_tmp" "$cancel_marker"
control_application_name="easyboost_restore_control_${SHELL_DOLLAR}{token}"
target_application_name="easyboost_restore_${SHELL_DOLLAR}{token}"
PGCONNECT_TIMEOUT=2 PGOPTIONS='-c statement_timeout=2000 -c lock_timeout=2000' PGAPPNAME="$control_application_name" psql --no-password -U easyboost -d easyboost -Atq \
  --set "appname=${SHELL_DOLLAR}{target_application_name}" \
  -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = :'appname' AND pid <> pg_backend_pid();" \
  >/dev/null 2>&1 || true
`;

const CLEANUP_SCRIPT = String.raw`
set -eu
# EASYBOOST_RESTORE_CLEANUP
token="$1"
base="/tmp/easyboost-restore-${SHELL_DOLLAR}{token}"
rm -f "${SHELL_DOLLAR}{base}.dump" "${SHELL_DOLLAR}{base}.reserve" "${SHELL_DOLLAR}{base}.pids" "${SHELL_DOLLAR}{base}.status" "${SHELL_DOLLAR}{base}.status.tmp" "${SHELL_DOLLAR}{base}.pids.tmp"
rm -f "${SHELL_DOLLAR}{base}.restore-gate" "${SHELL_DOLLAR}{base}.restore-ready" \
  "${SHELL_DOLLAR}{base}.restore-ready.tmp" "${SHELL_DOLLAR}{base}.watchdog-gate" \
  "${SHELL_DOLLAR}{base}.watchdog-ready" "${SHELL_DOLLAR}{base}.watchdog-ready.tmp" \
  "${SHELL_DOLLAR}{base}.cancel" "${SHELL_DOLLAR}{base}.cancel".*.tmp \
  "${SHELL_DOLLAR}{base}.watchdog-stop" "${SHELL_DOLLAR}{base}.watchdog-stop".*.tmp \
  "${SHELL_DOLLAR}{base}.outer-authority" "${SHELL_DOLLAR}{base}.outer-authority.tmp" \
  "${SHELL_DOLLAR}{base}".*-wait
`;

function supervisorUsageError(message) {
  const error = new Error(message);
  error.exitCode = 2;
  return error;
}

function delay(milliseconds) {
  return new Promise((resolve) => { setTimeout(resolve, milliseconds); });
}

function hasChildSettlementUnproven(error, visited = new Set()) {
  if (!error || (typeof error !== 'object' && typeof error !== 'function')
      || visited.has(error)) return false;
  visited.add(error);
  if (error.childSettlementUnproven === true) return true;
  if (error instanceof AggregateError
      && error.errors.some((nested) => hasChildSettlementUnproven(nested, visited))) {
    return true;
  }
  return hasChildSettlementUnproven(error.cause, visited);
}

function appendError(errors, error) {
  if (!error) return;
  if (hasChildSettlementUnproven(error)) errors.childSettlementUnproven = true;
  if (error instanceof AggregateError) errors.push(...error.errors);
  else errors.push(error);
}

function lifecycleError(errors, message, { settlementProven, retainOperationLock }) {
  const failures = errors.filter(Boolean);
  const error = failures.length === 1
    ? failures[0]
    : new AggregateError(failures, message, { cause: failures[0] });
  if (errors.childSettlementUnproven === true
      || failures.some((failure) => hasChildSettlementUnproven(failure))) {
    error.childSettlementUnproven = true;
  }
  error.settlementProven = settlementProven;
  error.retainOperationLock = retainOperationLock;
  return error;
}

export function calculateRestoreCapacityHeadroom(archiveBytes) {
  if (!Number.isSafeInteger(archiveBytes) || archiveBytes < 1
      || archiveBytes > MAX_ARCHIVE_BYTES) {
    throw supervisorUsageError(
      `Restore archive bytes must be an integer between 1 and ${MAX_ARCHIVE_BYTES}`,
    );
  }
  return Math.min(
    MAX_CAPACITY_HEADROOM_BYTES,
    Math.max(MIN_CAPACITY_HEADROOM_BYTES, Math.ceil(archiveBytes / 10)),
  );
}

async function defaultWriteCapacityChunk(handle, chunk, offset, length, position) {
  return handle.write(chunk, offset, length, position);
}

export async function reserveFileCapacity(handle, byteLength, {
  writeCapacityChunk = defaultWriteCapacityChunk,
} = {}) {
  if (!handle || typeof handle.write !== 'function' || typeof handle.stat !== 'function') {
    throw supervisorUsageError('Capacity reservation requires one open file handle');
  }
  if (!Number.isSafeInteger(byteLength) || byteLength < 1
      || byteLength > MAX_ARCHIVE_BYTES + MAX_CAPACITY_HEADROOM_BYTES) {
    throw supervisorUsageError('Capacity reservation byte length is outside the safe bound');
  }
  if (typeof writeCapacityChunk !== 'function') {
    throw supervisorUsageError('Capacity reservation requires a write adapter');
  }
  const chunk = Buffer.alloc(Math.min(CAPACITY_WRITE_CHUNK_BYTES, byteLength));
  let position = 0;
  while (position < byteLength) {
    const length = Math.min(chunk.length, byteLength - position);
    let offset = 0;
    while (offset < length) {
      const { bytesWritten } = await writeCapacityChunk(
        handle,
        chunk,
        offset,
        length - offset,
        position + offset,
      );
      if (!Number.isSafeInteger(bytesWritten) || bytesWritten < 1
          || bytesWritten > length - offset) {
        throw new Error('Restore capacity reservation write was incomplete');
      }
      offset += bytesWritten;
    }
    position += length;
  }
  await handle.sync();
  const reserved = await handle.stat({ bigint: true });
  if (!reserved.isFile() || reserved.size !== BigInt(byteLength)) {
    throw new Error('Restore capacity reservation size proof failed');
  }
  return { byteLength };
}

function recoveryEvidence({ applicationName, lastProbe, operationToken, postgresContainerId }) {
  return {
    applicationName,
    kind: 'restore',
    lastProbe: lastProbe || {
      activityCount: 'unknown',
      process: 'UNKNOWN',
      settled: false,
      status: 'UNKNOWN',
    },
    operationToken,
    postgresContainerId,
  };
}

function parseRemoteProbe(output) {
  const match = /^STATUS=(PENDING|STAGING|STAGED|RUNNING|EXIT:\d+|UNKNOWN)\r?\nPROCESS=(ACTIVE|NONE|UNKNOWN)$/u
    .exec(output);
  if (!match) throw new Error('Remote restore process/status authority returned malformed evidence');
  return { process: match[2], status: match[1] };
}

function parseActivityCount(output) {
  if (!/^(0|[1-9]\d*)$/u.test(output)) {
    throw new Error('Remote restore pg_stat_activity authority returned malformed evidence');
  }
  const count = Number(output);
  if (!Number.isSafeInteger(count)) {
    throw new Error('Remote restore pg_stat_activity authority exceeded safe integer range');
  }
  return count;
}

export async function runSupervisedPostgresRestore({
  archiveBytes,
  archiveSha256,
  assertMutationIsolation = async () => {},
  capacityHeadroomBytes = calculateRestoreCapacityHeadroom(archiveBytes),
  createOperationToken = randomUUID,
  inputHandle,
  now = Date.now,
  postgresContainerId,
  restoreDeadlineMs = DEFAULT_RESTORE_DEADLINE_MS,
  runDocker,
  settlementProbeAttempts = DEFAULT_SETTLEMENT_PROBE_ATTEMPTS,
  wait = delay,
  probeIntervalMs = DEFAULT_PROBE_INTERVAL_MS,
} = {}) {
  if (!Number.isSafeInteger(restoreDeadlineMs)
      || restoreDeadlineMs < MIN_RESTORE_DEADLINE_MS
      || restoreDeadlineMs > MAX_RESTORE_DEADLINE_MS) {
    throw supervisorUsageError(
      `Restore deadline must be an integer between ${MIN_RESTORE_DEADLINE_MS} and ${MAX_RESTORE_DEADLINE_MS}ms`,
    );
  }
  if (!CANONICAL_CONTAINER_ID.test(postgresContainerId || '')) {
    throw supervisorUsageError('Supervised restore requires one canonical PostgreSQL container ID');
  }
  if (!inputHandle || typeof inputHandle !== 'object') {
    throw supervisorUsageError('Supervised restore requires a frozen backup handle');
  }
  if (typeof runDocker !== 'function') {
    throw supervisorUsageError('Supervised restore requires a Docker command adapter');
  }
  if (!Number.isSafeInteger(archiveBytes) || archiveBytes < 1
      || archiveBytes > MAX_ARCHIVE_BYTES) {
    throw supervisorUsageError(
      `Restore archive bytes must be an integer between 1 and ${MAX_ARCHIVE_BYTES}`,
    );
  }
  if (!CANONICAL_SHA256.test(archiveSha256 || '')) {
    throw supervisorUsageError('Supervised restore requires one canonical archive SHA-256');
  }
  const expectedHeadroom = calculateRestoreCapacityHeadroom(archiveBytes);
  if (!Number.isSafeInteger(capacityHeadroomBytes)
      || capacityHeadroomBytes !== expectedHeadroom) {
    throw supervisorUsageError(
      `Restore capacity headroom must equal the bounded policy value ${expectedHeadroom}`,
    );
  }
  if (typeof assertMutationIsolation !== 'function') {
    throw supervisorUsageError('Supervised restore requires a mutation isolation adapter');
  }
  if (!Number.isSafeInteger(settlementProbeAttempts)
      || settlementProbeAttempts < 1 || settlementProbeAttempts > 60) {
    throw supervisorUsageError('Settlement probe attempts must be an integer between 1 and 60');
  }
  if (!Number.isSafeInteger(probeIntervalMs)
      || probeIntervalMs < 1 || probeIntervalMs > 60_000) {
    throw supervisorUsageError('Restore probe interval must be an integer between 1 and 60000ms');
  }

  const operationToken = createOperationToken();
  if (!CANONICAL_OPERATION_TOKEN.test(operationToken || '')) {
    throw new Error('Restore operation token generator returned a non-canonical random UUID');
  }
  const applicationName = `easyboost_restore_${operationToken}`;
  const deadlineSeconds = Math.ceil(restoreDeadlineMs / 1_000);
  const boundedDocker = (arguments_, {
    capture = false,
    commandTimeoutMs = CONTROL_TIMEOUT_MS,
    ...options
  } = {}) => runDocker(arguments_, {
    capture,
    commandTimeoutMs,
    ...(capture ? { maxCaptureBytes: CONTROL_CAPTURE_BYTES } : {}),
    ...options,
  });
  const remoteShell = (script, marker, {
    capture = true,
    commandTimeoutMs = CONTROL_TIMEOUT_MS,
    input,
    remoteArguments = [],
  } = {}) => boundedDocker([
    'exec', ...(input ? ['-i'] : []), postgresContainerId,
    'sh', '-ceu', script, marker, operationToken, ...remoteArguments,
  ], {
    capture,
    commandTimeoutMs,
    ...(input ? { inputHandle: input } : {}),
  });
  let launchInitiated = false;
  const probeRemote = async () => {
    const before = parseRemoteProbe(await remoteShell(
      PROBE_SCRIPT,
      'easyboost-restore-probe-before',
      { capture: true, remoteArguments: ['before'] },
    ));
    const activityCount = parseActivityCount(await boundedDocker([
      'exec', '-i', postgresContainerId,
      'psql', '-U', 'easyboost', '-d', 'easyboost', '-At',
      '--set', `appname=${applicationName}`,
      '-c', "SELECT count(*) FROM pg_stat_activity WHERE application_name = :'appname';",
    ], { capture: true }));
    const after = parseRemoteProbe(await remoteShell(
      PROBE_SCRIPT,
      'easyboost-restore-probe-after',
      { capture: true, remoteArguments: ['after'] },
    ));
    const process = before.process === 'ACTIVE' || after.process === 'ACTIVE'
      ? 'ACTIVE'
      : (before.process === 'UNKNOWN' || after.process === 'UNKNOWN' ? 'UNKNOWN' : 'NONE');
    const stableStatus = before.status === after.status;
    const terminalStatus = stableStatus && before.status.startsWith('EXIT:');
    return {
      activityCount,
      process,
      settled: stableStatus
        && (!launchInitiated || terminalStatus)
        && before.process === 'NONE'
        && activityCount === 0
        && after.process === 'NONE',
      status: after.status,
    };
  };

  const errors = [];
  let lastProbe;
  let restoreCompleted = false;
  let deadlineAt;
  try {
    await assertMutationIsolation({
      operationToken,
      phase: 'before-stage',
      postgresContainerId,
    });
    await boundedDocker([
      'exec', '-i', '--env', `EASYBOOST_RESTORE_OPERATION_TOKEN=${operationToken}`,
      '--env', `EASYBOOST_RESTORE_ARCHIVE_BYTES=${archiveBytes}`,
      '--env', `EASYBOOST_RESTORE_ARCHIVE_SHA256=${archiveSha256}`,
      '--env', `EASYBOOST_RESTORE_CAPACITY_HEADROOM_BYTES=${capacityHeadroomBytes}`,
      postgresContainerId, 'sh', '-ceu', STAGE_SCRIPT,
    ], {
      commandTimeoutMs: restoreDeadlineMs,
      inputHandle,
    });
    await assertMutationIsolation({
      operationToken,
      phase: 'before-launch',
      postgresContainerId,
    });
    launchInitiated = true;
    await boundedDocker([
      'exec', '--detach',
      '--env', `EASYBOOST_RESTORE_OPERATION_TOKEN=${operationToken}`,
      '--env', `PGAPPNAME=${applicationName}`,
      '--env', `EASYBOOST_RESTORE_DEADLINE_SECONDS=${deadlineSeconds}`,
      postgresContainerId, 'sh', '-ceu', WATCHDOG_SCRIPT,
    ], { capture: true });
    deadlineAt = now() + restoreDeadlineMs;
    await assertMutationIsolation({
      operationToken,
      phase: 'after-launch',
      postgresContainerId,
    });
  } catch (error) {
    appendError(errors, error);
  }

  if (!errors.length) {
    while (true) {
      try {
        await assertMutationIsolation({
          operationToken,
          phase: 'probe',
          postgresContainerId,
        });
        lastProbe = await probeRemote();
      } catch (error) {
        appendError(errors, error);
        break;
      }
      if (lastProbe.status.startsWith('EXIT:')) {
        const exitCode = Number(lastProbe.status.slice('EXIT:'.length));
        if (exitCode !== 0) {
          appendError(errors, new Error(`Remote pg_restore exited with status ${exitCode}`));
        } else if (lastProbe.settled) {
          restoreCompleted = true;
        }
        if (errors.length || restoreCompleted) break;
      } else if (lastProbe.settled && lastProbe.status === 'RUNNING') {
        appendError(errors, new Error(
          'Remote restore lost its tokenized process before publishing terminal status',
        ));
        break;
      }
      const remaining = deadlineAt - now();
      if (remaining <= 0) {
        appendError(errors, new Error(`Remote pg_restore exceeded ${restoreDeadlineMs}ms deadline`));
        break;
      }
      await wait(Math.min(probeIntervalMs, remaining));
    }
  }

  let settlementProven = restoreCompleted && lastProbe?.settled;
  const secondaryErrors = [];
  let postgresStopped = false;
  if (!settlementProven) {
    if (!lastProbe?.settled) {
      try {
        await remoteShell(CANCEL_SCRIPT, 'easyboost-restore-cancel', {
          commandTimeoutMs: CANCEL_TIMEOUT_MS,
        });
      } catch (error) {
        appendError(secondaryErrors, error);
      }
      for (let attempt = 1; attempt <= settlementProbeAttempts; attempt += 1) {
        try {
          lastProbe = await probeRemote();
          if (lastProbe.settled) {
            settlementProven = true;
            break;
          }
        } catch (error) {
          appendError(secondaryErrors, error);
          break;
        }
        if (attempt < settlementProbeAttempts) await wait(probeIntervalMs);
      }
    } else {
      settlementProven = true;
    }
  }

  if (!settlementProven) {
    appendError(secondaryErrors, new Error(
      'Remote restore settlement could not prove both process and pg_stat_activity absence',
    ));
    try {
      await boundedDocker(
        ['stop', '--time', '10', postgresContainerId],
        { capture: true, commandTimeoutMs: CANCEL_TIMEOUT_MS },
      );
    } catch (error) {
      appendError(secondaryErrors, error);
    }
    try {
      const stoppedEvidence = await boundedDocker([
        'inspect', '--format', '{{.Id}}|{{.State.Running}}', postgresContainerId,
      ], { capture: true });
      if (stoppedEvidence !== `${postgresContainerId}|false`) {
        throw new Error('Exact PostgreSQL container stopped-state proof failed');
      }
      settlementProven = true;
      postgresStopped = true;
    } catch (error) {
      appendError(secondaryErrors, error);
    }
  }

  if (settlementProven && !postgresStopped) {
    try {
      await remoteShell(CLEANUP_SCRIPT, 'easyboost-restore-cleanup');
    } catch (error) {
      appendError(secondaryErrors, error);
    }
  }

  if (errors.length || secondaryErrors.length || !restoreCompleted || postgresStopped) {
    if (!errors.length && (!restoreCompleted || postgresStopped)) {
      appendError(errors, new Error(postgresStopped
        ? 'Remote restore required PostgreSQL stop fallback'
        : 'Remote restore did not publish successful terminal status'));
    }
    const lifecycleErrors = [...errors, ...secondaryErrors];
    if (errors.childSettlementUnproven === true
        || secondaryErrors.childSettlementUnproven === true) {
      lifecycleErrors.childSettlementUnproven = true;
    }
    const failure = lifecycleError(
      lifecycleErrors,
      'Supervised PostgreSQL restore failed and remote settlement required recovery',
      {
        settlementProven,
        retainOperationLock: !settlementProven,
      },
    );
    failure.recoveryEvidence = recoveryEvidence({
      applicationName,
      lastProbe,
      operationToken,
      postgresContainerId,
    });
    throw failure;
  }

  return {
    applicationName,
    kind: 'restore',
    lastProbe,
    operationToken,
    postgresContainerId,
    settlement: 'remote-proof',
  };
}
