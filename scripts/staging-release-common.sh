#!/bin/bash

# The production launcher gives the transaction process one already-open Node
# executable (fd 9).  The POSIX wrapper exposes that same immutable file through
# the still-live transaction PID, so every nested helper must use this path
# rather than reopening a mutable PATH entry.  Direct developer/test invocation
# retains a bounded fallback resolved before the shell function is declared.
staging_node_executable="${EASYBOOST_STAGING_NODE_COMMAND:-}"
staging_node_chain_authority="${EASYBOOST_STAGING_NODE_CHAIN_AUTHORITY:-}"
if [ -n "$staging_node_executable" ]; then
  if [[ ! "$staging_node_executable" =~ ^/proc/([1-9][0-9]*)/fd/9$ ]] \
    || [ ! -f "$staging_node_executable" ] || [ ! -x "$staging_node_executable" ]; then
    echo 'Staging Node descriptor authority is invalid' >&2
    return 69 2>/dev/null || exit 69
  fi
  staging_node_owner_pid="${BASH_REMATCH[1]}"
  if [[ ! "$staging_node_chain_authority" =~ ^easyboost-staging-node-chain-v1:${staging_node_owner_pid}:[1-9][0-9]*:[a-f0-9]{64}$ ]]; then
    echo 'Staging Node chain authority is invalid' >&2
    return 69 2>/dev/null || exit 69
  fi
else
  [ -z "$staging_node_chain_authority" ] || {
    echo 'Staging Node chain authority has no descriptor command' >&2
    return 69 2>/dev/null || exit 69
  }
  staging_node_executable="$(type -P node 2>/dev/null || true)"
  [ -n "$staging_node_executable" ] && [ -f "$staging_node_executable" ] \
    && [ -x "$staging_node_executable" ] || {
      echo 'Node.js is required' >&2
      return 69 2>/dev/null || exit 69
    }
fi
unset EASYBOOST_STAGING_NODE_COMMAND EASYBOOST_STAGING_NODE_CHAIN_AUTHORITY
node() {
  if [ -n "$staging_node_chain_authority" ]; then
    EASYBOOST_STAGING_NODE_COMMAND="$staging_node_executable" \
      EASYBOOST_STAGING_NODE_CHAIN_AUTHORITY="$staging_node_chain_authority" \
      "$staging_node_executable" "$@"
  else
    "$staging_node_executable" "$@"
  fi
}

PROTOCOL='immutable-archive-v4'
STABLE_IMAGE='easyboost-staging-app:local'
MAX_RELEASE_PAIRS=4
MAX_RELEASE_STORE_BYTES=$((1024 * 1024 * 1024))
ARCHIVE_INSPECT_SECONDS=60
ARCHIVE_EXTRACT_SECONDS=90
IMAGE_BUILD_SECONDS=600
READINESS_ATTEMPTS=60
READINESS_INTERVAL_SECONDS=2
MINIMUM_DISK_HEADROOM_BYTES=$((64 * 1024 * 1024))
MAX_DATABASE_BACKUP_BYTES=$((256 * 1024 * 1024))
TRANSACTION_SECONDS=1800
RECOVERY_SECONDS=600
COMMAND_SECONDS=60
DEADLINE_WATCHDOG_STARTUP_SECONDS=5
transaction_deadline=0
deadline_control_environment="${EASYBOOST_STAGING_DEADLINE_CONTROL:-}"
unset EASYBOOST_STAGING_DEADLINE_CONTROL
deadline_sequence=0
deadline_control_active=0
deadline_watchdog_settlement_unproven=0
protected_runtime_identity=''
postgres_image_id=''
unset EASYBOOST_STAGING_POSTGRES_IMAGE_ID
temporary_reservation_file=''
live_reservation_file=''
store_reservation_file=''
temporary_reservation_authority=''
live_reservation_authority=''
store_reservation_authority=''
release_store_authority=''
active_marker_authority=''
transaction_marker_authority=''
host_operation_lock_directory=''
host_operation_lock_identity=''
host_operation_owner_marker=''
host_operation_lock_owned=0
authority_violation=0
candidate_archive_tmp=''
candidate_sidecar_tmp=''
candidate_archive_final=''
candidate_sidecar_final=''
candidate_archive_identity=''
candidate_sidecar_identity=''
candidate_store_prepublication_authority=''
candidate_publication_cleanup_failure_step=''

script_source="${BASH_SOURCE[0]}"
case "$script_source" in /*) ;; *) echo "staging helper source path must be absolute" >&2; return 69 ;; esac
script_dir="${script_source%/*}"
archive_tool="$script_dir/staging-release-archive.js"
compose_contract_tool="$script_dir/verify-staging-compose.js"
helper_bundle_tool="$script_dir/staging-helper-bundle.js"
bounded_stream_tool="$script_dir/staging-bounded-stream.js"
command_supervisor_tool="$script_dir/staging-command-supervisor.js"
transaction_supervisor_tool="$script_dir/staging-transaction-supervisor.js"
runtime_authority_tool="$script_dir/staging-runtime-authority.js"

read_process_start_time() {
  local pid="$1" stat fields start_time
  [ -r "/proc/$pid/stat" ] || return 1
  IFS= read -r stat < "/proc/$pid/stat" || return 1
  fields="${stat##*) }"
  [ "$fields" != "$stat" ] || return 1
  set -- $fields
  [ "$#" -ge 20 ] || return 1
  start_time="${20}"
  case "$start_time" in ''|*[!0-9]*) return 1;; esac
  printf '%s\n' "$start_time"
}

stop_early_deadline() {
  local status="$?" settlement_status=0
  trap - EXIT TERM
  stop_deadline_watchdog || settlement_status="$?"
  if [ "$settlement_status" -ne 0 ]; then
    exit "$settlement_status"
  fi
  exit "$status"
}

settle_deadline_watchdog_and_release_host_lock() {
  local primary_status="${1:-125}"
  local cleanup_step="${2:-staging deadline controller settlement was not proven}"
  local settlement_status=0

  stop_deadline_watchdog || settlement_status="$?"
  if [ "$settlement_status" -ne 0 ]; then
    if ! write_recovery_marker "$cleanup_step" "$primary_status" 125; then
      echo 'Recovery-required marker could not be persisted after deadline settlement failure' >&2
    fi
    echo 'Shared host-operation guard retained because staging deadline DISARM is unproven' >&2
    return 125
  fi
  if ! release_host_operation_lock; then
    echo 'Shared host-operation guard could not be released safely' >&2
    return 70
  fi
}

request_owned_deadline_transition() {
  local action="$1" seconds="$2" sequence="$3" timeout_ms
  [ -n "$deadline_control_environment" ] || return 125
  timeout_ms=$((DEADLINE_WATCHDOG_STARTUP_SECONDS * 1000))
  EASYBOOST_STAGING_DEADLINE_CONTROL="$deadline_control_environment" \
    node "$transaction_supervisor_tool" --request \
      "$action" "$seconds" "$sequence" "$timeout_ms"
}

stop_deadline_watchdog() {
  local next_sequence
  if [ "$deadline_watchdog_settlement_unproven" -eq 1 ]; then
    echo 'Staging deadline controller settlement remains unproven' >&2
    return 125
  fi
  [ "$deadline_control_active" -eq 1 ] || return 0
  next_sequence=$((deadline_sequence + 1))
  if ! request_owned_deadline_transition DISARM 0 "$next_sequence"; then
    deadline_watchdog_settlement_unproven=1
    transaction_deadline=$((SECONDS + DEADLINE_WATCHDOG_STARTUP_SECONDS))
    echo 'Staging deadline DISARM acknowledgement was not proven' >&2
    return 125
  fi
  deadline_sequence="$next_sequence"
  deadline_control_active=0
  deadline_control_environment=''
  transaction_deadline=0
}

begin_transaction_deadline() {
  local timeout_ms
  if [ "$deadline_watchdog_settlement_unproven" -eq 1 ] \
    || [ "$deadline_control_active" -eq 1 ] \
    || [ -z "$deadline_control_environment" ]; then
    deadline_watchdog_settlement_unproven=1
    echo 'Staging transaction deadline authority is unavailable' >&2
    return 125
  fi
  timeout_ms=$((DEADLINE_WATCHDOG_STARTUP_SECONDS * 1000))
  if ! EASYBOOST_STAGING_DEADLINE_CONTROL="$deadline_control_environment" \
    node "$transaction_supervisor_tool" --ready \
      "$TRANSACTION_SECONDS" "$timeout_ms"; then
    deadline_watchdog_settlement_unproven=1
    echo 'Staging transaction deadline READY acknowledgement was not proven' >&2
    return 125
  fi
  deadline_sequence=0
  deadline_control_active=1
  transaction_deadline=$((SECONDS + TRANSACTION_SECONDS))
}

begin_recovery_deadline() {
  local next_sequence
  if [ "$deadline_watchdog_settlement_unproven" -eq 1 ] \
    || [ "$deadline_control_active" -ne 1 ]; then
    deadline_watchdog_settlement_unproven=1
    transaction_deadline=$((SECONDS + DEADLINE_WATCHDOG_STARTUP_SECONDS))
    echo 'Staging recovery deadline rollover authority is unavailable' >&2
    return 125
  fi
  next_sequence=$((deadline_sequence + 1))
  if ! request_owned_deadline_transition ROLLOVER \
    "$RECOVERY_SECONDS" "$next_sequence"; then
    deadline_watchdog_settlement_unproven=1
    transaction_deadline=$((SECONDS + DEADLINE_WATCHDOG_STARTUP_SECONDS))
    echo 'Staging recovery deadline ROLLOVER acknowledgement was not proven' >&2
    return 125
  fi
  deadline_sequence="$next_sequence"
  transaction_deadline=$((SECONDS + RECOVERY_SECONDS))
}

run_bounded() {
  local requested="$1" remaining bound parent_start_time
  shift
  # The bounded supervisor executes its target in a fresh bash, where shell
  # functions are intentionally not exported.  Replace the public command name
  # with the descriptor-backed executable before crossing that boundary.
  if [ "${1:-}" = node ]; then
    shift
    set -- "$staging_node_executable" "$@"
  fi
  remaining="$requested"
  if [ "$transaction_deadline" -gt 0 ]; then
    remaining=$((transaction_deadline - SECONDS))
    if [ "$remaining" -le 0 ]; then
      echo "Staging release transaction deadline exceeded" >&2
      return 124
    fi
  fi
  bound="$requested"
  [ "$remaining" -ge "$bound" ] || bound="$remaining"
  case "${OSTYPE:-}" in
    msys*|cygwin*)
      echo 'Exact owned-session command supervision is unavailable on MSYS/Cygwin' >&2
      return 125
      ;;
    *) parent_start_time="$(read_process_start_time "$$")" || {
      echo "Staging release parent process identity is unavailable" >&2
      return 125
    }
      node "$command_supervisor_tool" "$bound" "$$" "$parent_start_time" -- \
      bash --noprofile --norc -c '"$@"' staging-bounded-command "$@" 9>&- ;;
  esac
}

durable_sync_file() {
  run_bounded "$COMMAND_SECONDS" node "$bounded_stream_tool" fsync-file "$1"
}

durable_sync_parent() {
  run_bounded "$COMMAND_SECONDS" node "$bounded_stream_tool" fsync-parent "$1"
}

durable_replace_file() {
  local temporary="$1" destination="$2"
  durable_sync_file "$temporary" || return 1
  run_bounded "$COMMAND_SECONDS" mv -f -- "$temporary" "$destination" || return 1
  durable_sync_parent "$destination"
}

durable_remove_file() {
  local target="$1"
  run_bounded "$COMMAND_SECONDS" rm -f -- "$target" || return 1
  [ ! -e "$target" ] && [ ! -L "$target" ] || return 1
  durable_sync_parent "$target"
}

durable_confirm_absence() {
  local target="$1"
  [ ! -e "$target" ] && [ ! -L "$target" ] || return 1
  durable_sync_parent "$target"
}

durable_move_no_replace_file() {
  local source="$1" destination="$2" source_parent destination_parent
  durable_sync_file "$source" || return 1
  run_bounded "$COMMAND_SECONDS" mv -n -T -- "$source" "$destination" || return 1
  durable_sync_parent "$source" || return 1
  source_parent="$(dirname -- "$source")" || return 1
  destination_parent="$(dirname -- "$destination")" || return 1
  [ "$source_parent" = "$destination_parent" ] || durable_sync_parent "$destination"
}

durable_remove_empty_directory() {
  local directory="$1"
  run_bounded "$COMMAND_SECONDS" rmdir -- "$directory" || return 1
  [ ! -e "$directory" ] && [ ! -L "$directory" ] || return 1
  durable_sync_parent "$directory"
}

durable_publish_no_replace_file() {
  local temporary="$1" final="$2"
  durable_sync_file "$temporary" || return 1
  run_bounded "$COMMAND_SECONDS" ln -- "$temporary" "$final" || return 1
  durable_sync_parent "$final" || return 1
}

sha256_file() {
  local output
  output="$(run_bounded "$COMMAND_SECONDS" sha256sum -- "$1")" || return 1
  printf '%s\n' "${output%% *}"
}

read_exact_sha_marker() {
  run_bounded "$COMMAND_SECONDS" node "$runtime_authority_tool" read-sha "$1" "$2"
}

verify_safe_ancestors() {
  local candidate="$1" current parent owner mode permissions current_uid
  case "$candidate" in /*) ;; *) echo "protected staging path must be absolute" >&2; return 1 ;; esac
  current_uid="$(id -u)" || return 1
  current="$(dirname -- "$candidate")"
  while :; do
    if [ -L "$current" ] || [ ! -d "$current" ]; then
      echo "protected staging ancestor is missing or linked" >&2
      return 1
    fi
    owner="$(stat -c '%u' -- "$current")" || return 1
    { [ "$owner" = 0 ] || [ "$owner" = "$current_uid" ]; } || {
      echo "protected staging ancestor has a foreign owner" >&2
      return 1
    }
    mode="$(stat -c '%a' -- "$current")" || return 1
    permissions=$((8#$mode))
    if [ $((permissions & 0022)) -ne 0 ] && [ $((permissions & 01000)) -eq 0 ]; then
      echo "protected staging ancestor has insecure write permissions" >&2
      return 1
    fi
    [ "$current" = / ] && break
    parent="$(dirname -- "$current")"
    [ "$parent" != "$current" ] || break
    current="$parent"
  done
}

verify_protected_path() {
  local candidate="$1" expected="$2" role="$3" verify_ancestors="${4:-1}"
  local exact_mode="${5:-}" owner mode permissions links
  [ "$verify_ancestors" -eq 0 ] || verify_safe_ancestors "$candidate" || return 1
  if [ -L "$candidate" ]; then
    echo "$role must not be a symlink" >&2
    return 1
  fi
  case "$expected" in
    directory) [ -d "$candidate" ] || { echo "$role directory is missing" >&2; return 1; } ;;
    file) [ -f "$candidate" ] || { echo "$role file is missing" >&2; return 1; } ;;
    optional-file) [ ! -e "$candidate" ] && return 0
      [ -f "$candidate" ] || { echo "$role entry has an unsafe type" >&2; return 1; } ;;
    *) return 1 ;;
  esac
  owner="$(stat -c '%u' -- "$candidate")" || return 1
  [ "$owner" = "$(id -u)" ] || { echo "$role has a foreign owner" >&2; return 1; }
  mode="$(stat -c '%a' -- "$candidate")" || return 1
  links="$(stat -c '%h' -- "$candidate")" || return 1
  permissions=$((8#$mode))
  if { [ -n "$exact_mode" ] && [ "$mode" != "$exact_mode" ]; } \
    || [ $((permissions & 0022)) -ne 0 ] \
    || { [ "$expected" != directory ] && [ "$links" -ne 1 ]; }; then
    echo "$role has insecure write permissions" >&2
    return 1
  fi
}

verify_protected_runtime() {
  local verify_ancestors="${1:-1}"
  verify_protected_path "$app_dir" directory 'staging root' "$verify_ancestors" 700 || return 1
  verify_protected_path "$app_dir/backups" directory 'staging backup root' "$verify_ancestors" 700 || return 1
  verify_protected_path "$app_dir/rollbacks" directory 'staging rollback root' "$verify_ancestors" 700 || return 1
  verify_protected_path "$release_store" directory 'staging release store' "$verify_ancestors" 700 || return 1
  verify_protected_path "$env_file" file 'staging environment file' "$verify_ancestors" 600 || return 1
  verify_protected_path "$lock_file" optional-file 'staging release lock' "$verify_ancestors" 600 || return 1
  verify_protected_path "$app_dir/.release-sha256" optional-file 'active release marker' "$verify_ancestors" 600 || return 1
  verify_protected_path "$recovery_marker" optional-file 'staging recovery marker' "$verify_ancestors" 600 || return 1
}

protected_identity_record() {
  local candidate="$1"
  [ ! -L "$candidate" ] && [ -e "$candidate" ] || return 1
  run_bounded "$COMMAND_SECONDS" stat -c '%d:%i:%f:%u:%g:%a' -- "$candidate"
}

authority_field() {
  run_bounded "$COMMAND_SECONDS" node "$runtime_authority_tool" record-field "$1" "$2"
}

capture_active_marker_identity() {
  active_marker_authority="$(run_bounded "$COMMAND_SECONDS" node "$runtime_authority_tool" \
    capture-optional-file "$app_dir/.release-sha256" 'active release marker' 384 65)" || return 1
  [ -n "$active_marker_authority" ]
}

reverify_active_marker_identity() {
  [ -n "$active_marker_authority" ] || return 1
  if ! run_bounded "$COMMAND_SECONDS" node "$runtime_authority_tool" verify-optional-file \
    "$app_dir/.release-sha256" 'active release marker' 384 65 "$active_marker_authority"; then
    authority_violation=1
    return 1
  fi
}

capture_transaction_marker_identity() {
  transaction_marker_authority="$(run_bounded "$COMMAND_SECONDS" node "$runtime_authority_tool" \
    capture-optional-file "$recovery_marker" 'staging transaction marker' 384 4096)" || return 1
  [ -n "$transaction_marker_authority" ]
}

reverify_transaction_marker_identity() {
  [ -n "$transaction_marker_authority" ] || return 1
  if ! run_bounded "$COMMAND_SECONDS" node "$runtime_authority_tool" verify-optional-file \
    "$recovery_marker" 'staging transaction marker' 384 4096 "$transaction_marker_authority"; then
    authority_violation=1
    return 1
  fi
}

capture_release_store_identity() {
  if [ -n "${store_reservation_file:-}" ]; then
    release_store_authority="$(run_bounded "$COMMAND_SECONDS" node "$runtime_authority_tool" \
      capture-store "$release_store" "$store_reservation_file")" || return 1
  else
    release_store_authority="$(run_bounded "$COMMAND_SECONDS" node "$runtime_authority_tool" \
      capture-store "$release_store")" || return 1
  fi
  [ -n "$release_store_authority" ]
}

reverify_release_store_identity() {
  [ -n "$release_store_authority" ] || return 1
  if [ -n "${store_reservation_file:-}" ]; then
    if ! run_bounded "$COMMAND_SECONDS" node "$runtime_authority_tool" verify-store \
      "$release_store" "$store_reservation_file" "$release_store_authority"; then
      authority_violation=1
      return 1
    fi
  else
    if ! run_bounded "$COMMAND_SECONDS" node "$runtime_authority_tool" verify-store \
      "$release_store" "$release_store_authority"; then
      authority_violation=1
      return 1
    fi
  fi
}

capture_protected_runtime_identity() {
  protected_runtime_identity="$(run_bounded "$COMMAND_SECONDS" node \
    "$runtime_authority_tool" capture-runtime "$app_dir")" || return 1
  [ -n "$protected_runtime_identity" ]
}

reverify_protected_runtime_identity() {
  [ -n "$protected_runtime_identity" ] || return 1
  if ! run_bounded "$COMMAND_SECONDS" node "$runtime_authority_tool" verify-runtime \
    "$app_dir" "$protected_runtime_identity"; then
    authority_violation=1
    return 1
  fi
}

acquire_release_lock() {
  local temporary before after runtime_root_before runtime_root_after
  if [ ! -e "$lock_file" ]; then
    temporary="$app_dir/.staging-release.lock.new.$$"
    (umask 077; set -o noclobber; : > "$temporary") 2>/dev/null || return 1
    run_bounded "$COMMAND_SECONDS" chmod 600 "$temporary" \
      || { run_bounded "$COMMAND_SECONDS" rm -f -- "$temporary"; return 1; }
    if ! ln -- "$temporary" "$lock_file"; then
      run_bounded "$COMMAND_SECONDS" rm -f -- "$temporary"
      [ -e "$lock_file" ] || return 1
    else
      run_bounded "$COMMAND_SECONDS" rm -f -- "$temporary"
    fi
  fi
  verify_protected_path "$lock_file" file 'staging release lock' || return 1
  before="$(run_bounded "$COMMAND_SECONDS" stat -Lc '%d:%i:%F:%u:%a' -- "$lock_file")" || return 1
  runtime_root_before="$(run_bounded "$COMMAND_SECONDS" stat -Lc '%d:%i:%F:%u:%a' -- "$app_dir")" || return 1
  exec 9<> "$lock_file" || return 1
  if [[ "${OSTYPE:-}" == linux* ]]; then
    after="$(run_bounded "$COMMAND_SECONDS" stat -Lc '%d:%i:%F:%u:%a' -- "/proc/$$/fd/9")" || return 1
    [ "$before" = "$after" ] || {
      echo "staging release lock identity changed while opening" >&2
      return 1
    }
  fi
  if ! flock -n 9; then
    echo "Another staging release operation is active" >&2
    return 75
  fi
  runtime_root_after="$(run_bounded "$COMMAND_SECONDS" stat -Lc '%d:%i:%F:%u:%a' -- "$app_dir")" || return 1
  [ "$runtime_root_before" = "$runtime_root_after" ] || {
    echo "protected staging root changed while acquiring the release lock" >&2
    return 1
  }
  capture_protected_runtime_identity || return 1
  capture_active_marker_identity || return 1
  capture_transaction_marker_identity || return 1
}

verify_host_operation_lock() {
  local current expected_digest actual_digest expected_size actual_size owner_file
  [ "$host_operation_lock_owned" -eq 1 ] || return 1
  owner_file="$host_operation_lock_directory/owner"
  current="$(stat -Lc '%d:%i:%F:%u:%a:%h' -- "$host_operation_lock_directory")" \
    || return 1
  [ "$current" = "$host_operation_lock_identity" ] || {
    echo 'shared host-operation lock identity changed' >&2
    return 1
  }
  verify_protected_path "$owner_file" file 'shared host-operation owner marker' 1 600 \
    || return 1
  expected_digest="$(printf '%s\n' "$host_operation_owner_marker" | /usr/bin/sha256sum)" \
    || return 1
  expected_digest="${expected_digest%% *}"
  actual_digest="$(/usr/bin/sha256sum -- "$owner_file")" || return 1
  actual_digest="${actual_digest%% *}"
  expected_size=$((${#host_operation_owner_marker} + 1))
  actual_size="$(stat -Lc '%s' -- "$owner_file")" || return 1
  [ "$actual_digest" = "$expected_digest" ] && [ "$actual_size" = "$expected_size" ] || {
    echo 'shared host-operation owner marker changed' >&2
    return 1
  }
}

acquire_host_operation_lock() {
  local operation="$1" owner_file current
  [[ "$operation" =~ ^[a-z][a-z0-9-]{0,63}$ ]] || return 2
  host_operation_lock_directory="${EASYBOOST_HOST_OPERATION_LOCK_DIR:-/var/lib/easyboost/locks/host-operation.lock}"
  case "$host_operation_lock_directory" in
    /*) ;;
    *) echo 'EASYBOOST_HOST_OPERATION_LOCK_DIR must be an absolute path' >&2; return 2 ;;
  esac
  verify_safe_ancestors "$host_operation_lock_directory" || return 1
  if ! mkdir -m 700 -- "$host_operation_lock_directory" 2>/dev/null; then
    echo "HOST_OPERATION_LOCKED: $host_operation_lock_directory" >&2
    return 75
  fi
  current="$(stat -Lc '%d:%i:%F:%u:%a:%h' -- "$host_operation_lock_directory")" \
    || return 1
  case "$current" in
    *":directory:$(id -u):700:"*) ;;
    *) echo 'shared host-operation lock directory is unsafe' >&2; return 1 ;;
  esac
  host_operation_lock_identity="$current"
  host_operation_owner_marker="$(printf \
    'protocol=easyboost-host-operation-v1\noperation=%s\nownerPid=%s' "$operation" "$$")"
  owner_file="$host_operation_lock_directory/owner"
  (umask 077; set -o noclobber; printf '%s\n' "$host_operation_owner_marker" > "$owner_file") \
    2>/dev/null || return 1
  chmod 600 -- "$owner_file" || return 1
  host_operation_lock_owned=1
  verify_host_operation_lock
}

release_host_operation_lock() {
  local owner_file current
  [ "$host_operation_lock_owned" -eq 1 ] || return 0
  verify_host_operation_lock || return 1
  owner_file="$host_operation_lock_directory/owner"
  /usr/bin/rm -- "$owner_file" || return 1
  current="$(stat -Lc '%d:%i:%F:%u:%a:%h' -- "$host_operation_lock_directory")" \
    || return 1
  [ "$current" = "$host_operation_lock_identity" ] || return 1
  rmdir -- "$host_operation_lock_directory" || return 1
  host_operation_lock_owned=0
  host_operation_lock_identity=''
  host_operation_owner_marker=''
}

run_archive_inspect() {
  run_bounded "$ARCHIVE_INSPECT_SECONDS" node "$archive_tool" inspect "$1" >/dev/null
}

archive_metrics() {
  local output
  output="$(run_bounded "$ARCHIVE_INSPECT_SECONDS" \
    node "$archive_tool" inspect "$1")" || return 1
  printf '%s' "$output" | run_bounded "$COMMAND_SECONDS" node -e '
    let source="";
    process.stdin.on("data", chunk => { source += chunk; });
    process.stdin.on("end", () => {
      const value=JSON.parse(source);
      if (!Number.isSafeInteger(value.aggregateBytes) || value.aggregateBytes < 0
          || !Number.isSafeInteger(value.compressedBytes) || value.compressedBytes < 0) process.exit(2);
      process.stdout.write(`${value.aggregateBytes} ${value.compressedBytes}\n`);
    });'
}

reserve_file() {
  local file="$1" bytes="$2" authority
  [[ "$bytes" =~ ^[0-9]+$ ]] || return 1
  if [ -e "$file" ] || [ -L "$file" ]; then
    echo "staging disk reservation path is not empty" >&2
    return 1
  fi
  run_bounded "$COMMAND_SECONDS" fallocate -l "$bytes" -- "$file" || return 1
  run_bounded "$COMMAND_SECONDS" chmod 600 "$file" || return 1
  authority="$(run_bounded "$COMMAND_SECONDS" node "$runtime_authority_tool" \
    capture-reservation "$file" "$bytes")" || return 1
  set_reservation_authority "$file" "$authority"
}

set_reservation_authority() {
  local file="$1" authority="$2"
  case "$file" in
    "$temporary_reservation_file") temporary_reservation_authority="$authority" ;;
    "$live_reservation_file") live_reservation_authority="$authority" ;;
    "$store_reservation_file") store_reservation_authority="$authority" ;;
    *) echo "unknown staging disk reservation" >&2; return 1 ;;
  esac
}

reservation_authority() {
  case "$1" in
    "$temporary_reservation_file") printf '%s\n' "$temporary_reservation_authority" ;;
    "$live_reservation_file") printf '%s\n' "$live_reservation_authority" ;;
    "$store_reservation_file") printf '%s\n' "$store_reservation_authority" ;;
    *) return 1 ;;
  esac
}

verify_one_reservation() {
  local file="$1" minimum="$2" authority
  authority="$(reservation_authority "$file")" || return 1
  [ -n "$authority" ] || return 1
  if ! run_bounded "$COMMAND_SECONDS" node "$runtime_authority_tool" verify-reservation \
    "$file" "$minimum" "$authority"; then
    echo "staging disk reservation authority failed for ${file##*/}" >&2
    return 1
  fi
}

consume_reservation() {
  local file="$1" bytes="$2" current remaining authority
  [ -n "$file" ] || return 1
  authority="$(reservation_authority "$file")" || return 1
  [ -n "$authority" ] || return 1
  current="$(authority_field "$authority" size)" || return 1
  [[ "$current" =~ ^[0-9]+$ ]] && [[ "$bytes" =~ ^[0-9]+$ ]] || return 1
  verify_one_reservation "$file" "$current" || return 1
  remaining=$((current - bytes))
  if [ "$remaining" -lt "$MINIMUM_DISK_HEADROOM_BYTES" ]; then
    echo "staging disk reservation underflow" >&2
    return 1
  fi
  run_bounded "$COMMAND_SECONDS" truncate -s "$remaining" -- "$file" || return 1
  authority="$(run_bounded "$COMMAND_SECONDS" node "$runtime_authority_tool" \
    capture-reservation "$file" "$remaining")" || return 1
  set_reservation_authority "$file" "$authority"
  if [ "$file" = "$store_reservation_file" ] && [ -n "$release_store_authority" ]; then
    reverify_release_store_identity || return 1
  fi
}

verify_space_reservations() {
  local file authority size
  for file in "$temporary_reservation_file" "$live_reservation_file" "$store_reservation_file"; do
    [ -n "$file" ] || continue
    authority="$(reservation_authority "$file")" || return 1
    size="$(authority_field "$authority" size)" || return 1
    [ "$size" -ge "$MINIMUM_DISK_HEADROOM_BYTES" ] || {
      echo "staging disk reservation lost required headroom" >&2
      return 1
    }
    verify_one_reservation "$file" "$size" || return 1
  done
}

release_space_reservations() {
  local failed=0 file authority size
  for file in "$temporary_reservation_file" "$live_reservation_file" "$store_reservation_file"; do
    [ -n "$file" ] || continue
    authority="$(reservation_authority "$file")" || authority=''
    size="$(authority_field "$authority" size 2>/dev/null)" || size=''
    if [ -z "$authority" ] || [ -z "$size" ] \
      || ! verify_one_reservation "$file" "$size" \
      || ! run_bounded "$COMMAND_SECONDS" rm -f -- "$file" \
      || [ -e "$file" ] || [ -L "$file" ]; then
      failed=1
    fi
  done
  temporary_reservation_file=''
  live_reservation_file=''
  store_reservation_file=''
  temporary_reservation_authority=''
  live_reservation_authority=''
  store_reservation_authority=''
  [ "$failed" -eq 0 ]
}

admit_release_space() {
  local candidate_expanded="$1" previous_expanded="$2"
  local candidate_compressed="$3" previous_compressed="$4"
  local backup_capacity="${5:-0}"
  local store_increment="$candidate_compressed" spec target required device available_kib available
  local temporary_required live_required store_required
  declare -A required_by_device=()
  declare -A sample_by_device=()
  [ "${candidate_pair_existed:-0}" -eq 0 ] || store_increment=0
  temporary_required=$((candidate_expanded + previous_expanded + candidate_compressed \
    + previous_compressed + backup_capacity + MINIMUM_DISK_HEADROOM_BYTES))
  live_required=$((candidate_expanded + previous_expanded + backup_capacity \
    + MINIMUM_DISK_HEADROOM_BYTES))
  store_required=$((store_increment + MINIMUM_DISK_HEADROOM_BYTES))
  for spec in "$work_dir:$temporary_required" "$app_dir:$live_required" \
    "$release_store:$store_required"; do
    target="${spec%:*}"
    required="${spec##*:}"
    [[ "$required" =~ ^[0-9]+$ ]] || return 1
    device="$(run_bounded "$COMMAND_SECONDS" stat -c '%d' -- "$target")" || return 1
    required_by_device[$device]=$(( ${required_by_device[$device]:-0} + required ))
    sample_by_device[$device]="$target"
  done
  for device in "${!required_by_device[@]}"; do
    target="${sample_by_device[$device]}"
    available_kib="$(run_bounded "$COMMAND_SECONDS" df --output=avail -B1 -- "$target")" || {
      echo "Staging disk capacity probe failed" >&2
      return 1
    }
    available_kib="${available_kib##*$'\n'}"
    [[ "$available_kib" =~ ^[0-9]+$ ]] || {
      echo "Staging disk capacity probe returned an invalid result" >&2
      return 1
    }
    available="$available_kib"
    if [ "$available" -lt "${required_by_device[$device]}" ]; then
      echo "Insufficient staging disk capacity before release mutation" >&2
      return 1
    fi
  done
}

reserve_release_space() {
  local candidate_expanded="$1" previous_expanded="$2"
  local candidate_compressed="$3" previous_compressed="$4" backup_capacity="${5:-0}" store_increment
  reverify_protected_runtime_identity || return 1
  admit_release_space "$@" || return 1
  store_increment="$candidate_compressed"
  [ "${candidate_pair_existed:-0}" -eq 0 ] || store_increment=0
  temporary_reservation_file="$work_dir/.staging-space-reservation"
  live_reservation_file="$app_dir/backups/.staging-space-reservation.$$"
  store_reservation_file="$release_store/.staging-space-reservation.$$"
  reserve_file "$temporary_reservation_file" \
    $((candidate_expanded + previous_expanded + backup_capacity \
      + MINIMUM_DISK_HEADROOM_BYTES)) || return 1
  reserve_file "$live_reservation_file" \
    $((candidate_expanded + previous_expanded + backup_capacity \
      + MINIMUM_DISK_HEADROOM_BYTES)) || return 1
  reserve_file "$store_reservation_file" \
    $((store_increment + MINIMUM_DISK_HEADROOM_BYTES)) || return 1
  capture_release_store_identity || return 1
  verify_space_reservations
}

run_archive_extract() {
  run_bounded "$ARCHIVE_EXTRACT_SECONDS" node "$archive_tool" extract "$1" "$2"
}

run_tree_verify() {
  run_bounded "$ARCHIVE_INSPECT_SECONDS" node "$archive_tool" verify-tree "$1" "$2"
}

prepare_release_tree_for_copy() {
  run_bounded "$ARCHIVE_INSPECT_SECONDS" node "$archive_tool" prepare-copy "$1"
}

release_archive_path() { printf '%s/release-%s.tar.gz\n' "$release_store" "$1"; }

verify_release_pair() {
  local sha="$1" role="$2" stored declared actual archive_authority sidecar_authority
  stored="$(release_archive_path "$sha")"
  if [ -L "$stored" ] || [ -L "$stored.sha256" ] \
    || [ ! -f "$stored" ] || [ ! -f "$stored.sha256" ]; then
    echo "$role release has no verified retained release archive" >&2
    return 1
  fi
  archive_authority="$(run_bounded "$COMMAND_SECONDS" node "$runtime_authority_tool" \
    capture-file "$stored" "$role retained release archive" 384 536870912)" || return 1
  sidecar_authority="$(run_bounded "$COMMAND_SECONDS" node "$runtime_authority_tool" \
    capture-file "$stored.sha256" "$role retained checksum sidecar" 384 65)" || return 1
  declared="$(read_exact_sha_marker "$stored.sha256" "$role retained checksum sidecar")" \
    || return 1
  actual="$(authority_field "$archive_authority" sha256)" || return 1
  if [ "$declared" != "$sha" ] || [ "$actual" != "$sha" ]; then
    echo "$role retained release archive verification failed" >&2
    return 1
  fi
  run_archive_inspect "$stored" || {
    echo "$role retained release archive validation failed" >&2
    return 1
  }
  run_bounded "$COMMAND_SECONDS" node "$runtime_authority_tool" verify-file \
    "$stored" "$role retained release archive" 384 536870912 "$archive_authority" || return 1
  run_bounded "$COMMAND_SECONDS" node "$runtime_authority_tool" verify-file \
    "$stored.sha256" "$role retained checksum sidecar" 384 65 "$sidecar_authority"
}

validate_release_store() {
  local allow_change="${1:-}" archives sidecars entries entry archive sha total=0
  local initial_authority size
  if [ -n "$release_store_authority" ] && [ "$allow_change" != allow-change ]; then
    reverify_release_store_identity || return 1
  fi
  capture_release_store_identity || return 1
  initial_authority="$release_store_authority"
  shopt -s nullglob dotglob
  entries=("$release_store"/*)
  archives=("$release_store"/release-*.tar.gz)
  sidecars=("$release_store"/release-*.tar.gz.sha256)
  shopt -u nullglob dotglob
  for entry in "${entries[@]}"; do
    if [ -n "${store_reservation_file:-}" ] && [ "$entry" = "$store_reservation_file" ]; then
      [ ! -L "$entry" ] && [ -f "$entry" ] || return 1
      continue
    fi
    case "${entry##*/}" in release-[0-9a-f]*.tar.gz|release-[0-9a-f]*.tar.gz.sha256) ;;
      *) echo "Release archive store contains unowned or temporary debris" >&2; return 1 ;;
    esac
    if [ -L "$entry" ] || [ ! -f "$entry" ]; then
      echo "Release archive store entries must be regular files" >&2
      return 1
    fi
  done
  if [ "${#archives[@]}" -ne "${#sidecars[@]}" ]; then
    echo "Release archive store contains an orphaned pair" >&2
    return 1
  fi
  if [ "${#archives[@]}" -gt "$MAX_RELEASE_PAIRS" ]; then
    echo "Release archive store exceeds the pair bound" >&2
    return 1
  fi
  for archive in "${archives[@]}"; do
    sha="${archive##*/release-}"
    sha="${sha%.tar.gz}"
    [[ "$sha" =~ ^[0-9a-f]{64}$ ]] || {
      echo "Release archive store contains an invalid identity" >&2
      return 1
    }
    verify_release_pair "$sha" 'stored' || return 1
    size="$(run_bounded "$COMMAND_SECONDS" stat -c '%s' -- "$archive")" || return 1
    total=$((total + size))
  done
  if [ "$total" -gt "$MAX_RELEASE_STORE_BYTES" ]; then
    echo "Release archive store exceeds the byte bound" >&2
    return 1
  fi
  release_store_pairs="${#archives[@]}"
  release_store_bytes="$total"
  reverify_release_store_identity || return 1
  [ "$release_store_authority" = "$initial_authority" ]
}

admit_release_pair() {
  local sha="$1" archive="$2" stored size
  stored="$(release_archive_path "$sha")"
  if [ -f "$stored" ] || [ -f "$stored.sha256" ]; then
    verify_release_pair "$sha" 'candidate' || return 1
    candidate_pair_existed=1
    return 0
  fi
  reverify_release_store_identity || return 1
  size="$(run_bounded "$COMMAND_SECONDS" stat -c '%s' -- "$archive")" || return 1
  if [ "$release_store_pairs" -ge "$MAX_RELEASE_PAIRS" ] \
    || [ $((release_store_bytes + size)) -gt "$MAX_RELEASE_STORE_BYTES" ]; then
    echo "Release archive store admission bound reached; archive nothing automatically" >&2
    return 1
  fi
}

validate_staging_compose_contract() {
  local candidate="$1" expected_context
  if [ -n "$protected_runtime_identity" ]; then
    reverify_compose_authority || return 1
  fi
  require_local_dependency_images || return 1
  expected_context="$(run_bounded "$COMMAND_SECONDS" readlink -m "$app_dir/.guarded-staging-build-context-required")"
  if ! run_bounded "$COMMAND_SECONDS" docker compose --project-directory "$app_dir" -f "$candidate" \
    --env-file "$env_file" config --format json 2>/dev/null \
    | run_bounded "$COMMAND_SECONDS" node "$compose_contract_tool" "$expected_context"; then
    echo "unsafe release archive: invalid staging Compose configuration" >&2
    return 1
  fi
}

verify_helper_bundle() {
  local expected_digest="$1" actual_digest archive_protocol compose_protocol
  [[ "$expected_digest" =~ ^[0-9a-f]{64}$ ]] || return 1
  [ ! -L "$helper_bundle_tool" ] && [ -f "$helper_bundle_tool" ] || return 1
  actual_digest="$(run_bounded "$COMMAND_SECONDS" \
    node "$helper_bundle_tool" digest "$script_dir")" || return 1
  if [ "$actual_digest" != "$expected_digest" ]; then
    echo "staging release helper bundle digest mismatch" >&2
    return 1
  fi
  if [ -e "$script_dir/staging-release-bundle.json" ]; then
    run_bounded "$COMMAND_SECONDS" node "$helper_bundle_tool" verify-generation \
      "$script_dir" "$expected_digest" || {
      echo "staging release helper bundle generation is incomplete or changed" >&2
      return 1
    }
  elif [[ "$script_dir" == /usr/local/lib/easyboost-staging-release/generations/* ]]; then
    echo "installed staging release helper bundle manifest is missing" >&2
    return 1
  fi
  archive_protocol="$(run_bounded "$COMMAND_SECONDS" node "$archive_tool" protocol)" || return 1
  compose_protocol="$(run_bounded "$COMMAND_SECONDS" node "$compose_contract_tool" --protocol)" || return 1
  if [ "$PROTOCOL" != 'immutable-archive-v4' ] \
    || [ "$archive_protocol" != "$PROTOCOL" ] || [ "$compose_protocol" != "$PROTOCOL" ]; then
    echo "staging release helper bundle protocol mismatch" >&2
    return 1
  fi
}

require_local_dependency_images() {
  local current
  current="$(image_id 'postgres:17-alpine')" || {
    echo "postgres:17-alpine must be pre-seeded locally before staging release" >&2
    return 1
  }
  [ -n "$current" ] || return 1
  if [ -n "$postgres_image_id" ] && [ "$current" != "$postgres_image_id" ]; then
    echo "postgres:17-alpine image identity changed during staging transaction" >&2
    return 1
  fi
  postgres_image_id="$current"
  export EASYBOOST_STAGING_POSTGRES_IMAGE_ID="$postgres_image_id"
}

verify_postgres_image() {
  local current
  [ -n "$postgres_image_id" ] || return 1
  if [ "${EASYBOOST_STAGING_POSTGRES_IMAGE_ID:-}" != "$postgres_image_id" ]; then
    echo "staging PostgreSQL Compose image authority changed during transaction" >&2
    return 1
  fi
  current="$(image_id 'postgres:17-alpine')" || return 1
  [ "$current" = "$postgres_image_id" ] || {
    echo "postgres:17-alpine image identity changed before activation" >&2
    return 1
  }
}

canonical_image_id() {
  [[ "$1" =~ ^sha256:[0-9a-f]{64}$ ]]
}

image_id() {
  local image="$1" output status
  if output="$(run_bounded "$COMMAND_SECONDS" docker image inspect \
    --format '{{.Id}}' "$image" 2>&1)"; then
    canonical_image_id "$output" || {
      echo "Docker image inspection returned a noncanonical identity for $image" >&2
      return 70
    }
    printf '%s\n' "$output"
    return 0
  else
    status="$?"
  fi
  if [ "$status" -eq 1 ] && { \
    [ "$output" = "Error response from daemon: No such image: $image" ] \
      || [ "$output" = "Error: No such image: $image" ]; }; then
    return 1
  fi
  echo "Docker image inspection for $image was inconclusive (status $status)" >&2
  return 70
}

probe_image_reference() {
  local image="$1" output status
  if output="$(run_bounded "$COMMAND_SECONDS" docker image ls --quiet --no-trunc \
    --filter "reference=$image" 2>&1)"; then
    if [ -z "$output" ]; then
      return 1
    fi
    if ! canonical_image_id "$output"; then
      echo "Docker image reference probe for $image returned an ambiguous identity" >&2
      return 2
    fi
    printf '%s\n' "$output"
    return 0
  else
    status="$?"
  fi
  echo "Docker image reference probe for $image was inconclusive (status $status)" >&2
  return 2
}

image_is_absent() {
  local status
  if probe_image_reference "$1" >/dev/null; then return 1; else status="$?"; fi
  [ "$status" -eq 1 ]
}

verify_stable_image() {
  local expected="$1" actual
  actual="$(image_id "$STABLE_IMAGE")" || return 1
  [ -n "$actual" ] && [ "$actual" = "$expected" ]
}

app_port() {
  reverify_protected_runtime_identity || return 1
  run_bounded "$COMMAND_SECONDS" node "$runtime_authority_tool" read-env-port "$env_file"
}

wait_for_readiness() {
  local port attempt
  port="$(app_port)"
  for ((attempt=1; attempt<=READINESS_ATTEMPTS; attempt+=1)); do
    if run_bounded 10 curl --connect-timeout 3 --max-time 5 -fsS \
      "http://127.0.0.1:$port/health/ready" >/dev/null; then return 0; fi
    [ "$attempt" -lt "$READINESS_ATTEMPTS" ] || return 1
    run_bounded "$READINESS_INTERVAL_SECONDS" sleep "$READINESS_INTERVAL_SECONDS" || return 1
  done
}

verify_running_image() {
  local expected="$1" container actual
  reverify_compose_authority || return 1
  container="$(run_bounded "$COMMAND_SECONDS" docker compose -f "$compose_file" \
    --env-file "$env_file" ps -q app)" || return 1
  [ -n "$container" ] || return 1
  actual="$(run_bounded "$COMMAND_SECONDS" docker inspect \
    --format '{{.Image}}' "$container")" || return 1
  canonical_image_id "$actual" || return 1
  [ "$actual" = "$expected" ]
}

reverify_compose_authority() {
  reverify_protected_runtime_identity || return 1
  reverify_active_marker_identity || return 1
  reverify_transaction_marker_identity || return 1
}

clear_release_tree() {
  reverify_protected_runtime_identity || return 1
  run_bounded "$COMMAND_SECONDS" find "$app_dir" -mindepth 1 -maxdepth 1 \
    ! -name '.env.staging' ! -name 'backups' ! -name 'rollbacks' \
    ! -name '.release-sha256' ! -name '.staging-release.lock' \
    ! -name '.staging-recovery-required' -exec rm -rf -- {} +
}

write_recovery_marker() {
  local step="$1" primary_status="${2:-70}" recovery_status="${3:-1}" temporary
  reverify_protected_runtime_identity || return 1
  [ -z "$transaction_marker_authority" ] || reverify_transaction_marker_identity || return 1
  temporary="$(run_bounded "$COMMAND_SECONDS" \
    mktemp "$app_dir/.staging-recovery-required.tmp.XXXXXX")" || return 1
  printf 'manual recovery required\nprimary_status=%s\nrecovery_status=%s\nrecovery_step=%s\n' \
    "$primary_status" "$recovery_status" "$step" > "$temporary"
  run_bounded "$COMMAND_SECONDS" chmod 600 "$temporary" || return 1
  durable_replace_file "$temporary" "$recovery_marker" || return 1
  capture_transaction_marker_identity
}

verify_active_snapshot() {
  local expected_sha="$1" expected_archive="$2" expected_image="$3" marker
  reverify_compose_authority || return 1
  reverify_release_store_identity || return 1
  marker="$(read_exact_sha_marker "$app_dir/.release-sha256" 'active release marker')" \
    || return 1
  [ "$marker" = "$expected_sha" ] || return 1
  verify_release_pair "$expected_sha" 'active' || return 1
  [ "$(sha256_file "$expected_archive")" = "$expected_sha" ] || return 1
  run_tree_verify "$expected_archive" "$app_dir" || return 1
  compose_file="$app_dir/compose.staging.yml"
  validate_staging_compose_contract "$compose_file" || return 1
  require_local_dependency_images || return 1
  verify_stable_image "$expected_image" || return 1
  verify_running_image "$expected_image" || return 1
  wait_for_readiness || return 1
  reverify_active_marker_identity || return 1
  reverify_release_store_identity || return 1
}

verify_reservation_free_active_state() {
  local expected_sha="$1" expected_archive="$2" expected_image="$3"
  [ -z "$temporary_reservation_file" ] \
    && [ -z "$live_reservation_file" ] \
    && [ -z "$store_reservation_file" ] || return 1
  validate_release_store allow-change || return 1
  verify_active_snapshot "$expected_sha" "$expected_archive" "$expected_image"
}

remove_owned_image_reference() {
  local image="$1" expected_image_id="$2" observed confirmed status removal_status=0
  if observed="$(probe_image_reference "$image")"; then
    if ! canonical_image_id "$expected_image_id" || [ "$observed" != "$expected_image_id" ]; then
      echo "Docker image reference $image is not owned by this transaction" >&2
      return 1
    fi
    confirmed="$(probe_image_reference "$image")" || {
      echo "Docker image reference $image changed before exact-tag removal" >&2
      return 1
    }
    if [ "$confirmed" != "$expected_image_id" ]; then
      echo "Docker image reference $image was rebound before exact-tag removal" >&2
      return 1
    fi
    run_bounded "$COMMAND_SECONDS" docker image rm -f "$image" || removal_status="$?"
    if ! image_is_absent "$image"; then
      echo "Docker image reference $image could not be proven absent after removal" >&2
      return 1
    fi
    [ "$removal_status" -eq 0 ] || return 1
    return 0
  else
    status="$?"
  fi
  [ "$status" -eq 1 ] && return 0
  echo "Docker image reference $image has indeterminate state" >&2
  return 1
}

finalize_release_boundaries() {
  local image_step="$1" reservation_step="$2" workdir_step="$3"
  local marker_step="$4" proof_step="$5" proof_hook="$6" failed=0
  release_finalization_verified=0
  [ -z "${release_finalization_step:-}" ] || failed=1
  record_finalization_failure() {
    [ -n "${release_finalization_step:-}" ] || release_finalization_step="$1"
    failed=1
  }

  if [ "${image_build_attempted:-0}" -eq 1 ]; then
    if remove_owned_image_reference "$release_image" "${candidate_image_id:-}"; then
      image_build_attempted=0
    else
      record_finalization_failure "$image_step"
    fi
  fi
  if ! release_space_reservations; then
    record_finalization_failure "$reservation_step"
  fi
  if [ -n "${work_dir:-}" ]; then
    if run_bounded "$COMMAND_SECONDS" chmod -R u+w -- "$work_dir" \
      && run_bounded "$COMMAND_SECONDS" rm -rf -- "$work_dir" \
      && [ ! -e "$work_dir" ] && [ ! -L "$work_dir" ]; then
      work_dir=''
    else
      record_finalization_failure "$workdir_step"
    fi
  fi
  if [ "$failed" -eq 0 ] && [ "${transaction_marker_created:-0}" -eq 1 ]; then
    if clear_transaction_marker; then
      transaction_marker_created=0
      transaction_cleared=1
    else
      record_finalization_failure "$marker_step"
    fi
  fi
  if [ "$failed" -eq 0 ]; then
    if "$proof_hook"; then
      release_finalization_verified=1
    else
      record_finalization_failure "$proof_step"
    fi
  fi
  if [ "$failed" -ne 0 ]; then
    echo "Staging release finalization failed at: $release_finalization_step" >&2
  fi
  [ "$failed" -eq 0 ]
}

recover_previous_release() {
  local restored_marker
  recovery_step='retag previous image'
  run_bounded "$COMMAND_SECONDS" docker image tag \
    "$previous_image_id" "$STABLE_IMAGE" || return 1
  verify_stable_image "$previous_image_id" || return 1
  recovery_step='restore previous code tree'
  consume_reservation "$live_reservation_file" "$previous_expanded" || return 1
  clear_release_tree || return 1
  run_bounded "$COMMAND_SECONDS" cp -a "$previous_tree"/. "$app_dir"/ || return 1
  run_bounded "$COMMAND_SECONDS" chmod 700 "$app_dir" || return 1
  run_tree_verify "$previous_archive" "$app_dir" || return 1
  recovery_step='restart previous application'
  compose_file="$app_dir/compose.staging.yml"
  validate_staging_compose_contract "$compose_file" || return 1
  verify_postgres_image || return 1
  reverify_compose_authority || return 1
  run_bounded "$COMMAND_SECONDS" docker compose -f "$compose_file" \
    --env-file "$env_file" up --pull never -d --no-build app || return 1
  verify_running_image "$previous_image_id" || return 1
  wait_for_readiness || return 1
  recovery_step='verify previous release identity'
  publish_active_marker "$previous_sha" || return 1
  restored_marker="$(read_exact_sha_marker \
    "$app_dir/.release-sha256" 'restored active release marker')" || return 1
  [ "$restored_marker" = "$previous_sha" ] || return 1
  run_tree_verify "$previous_archive" "$app_dir" || return 1
  return 0
}

recover_empty_release() {
  recovery_step='remove failed first Compose project'
  if [ -f "$app_dir/compose.staging.yml" ]; then
    compose_file="$app_dir/compose.staging.yml"
    validate_staging_compose_contract "$compose_file" || return 1
    reverify_compose_authority || return 1
    run_bounded "$COMMAND_SECONDS" docker compose -f "$compose_file" --env-file "$env_file" \
      down --volumes --remove-orphans || return 1
    reverify_compose_authority || return 1
    recovery_step='verify failed first Compose project removal'
    verify_empty_compose_objects || return 1
  fi
  recovery_step='remove failed first release image'
  remove_owned_image_reference "$release_image" "$candidate_image_id" || return 1
  recovery_step='remove failed first stable image'
  remove_owned_image_reference "$STABLE_IMAGE" "$candidate_image_id" || return 1
  recovery_step='clear failed first code tree'
  clear_release_tree || return 1
  reverify_active_marker_identity || return 1
  durable_remove_file "$app_dir/.release-sha256" || return 1
  capture_active_marker_identity || return 1
  [ ! -e "$app_dir/compose.staging.yml" ] && [ ! -e "$app_dir/.release-sha256" ] || return 1
  recovery_step='prepare bootstrappable empty staging runtime'
  [ ! -e "$app_dir/compose.staging.yml" ] && [ ! -e "$app_dir/.release-sha256" ] || return 1
  return 0
}

verify_empty_compose_objects() {
  local containers volumes networks
  containers="$(run_bounded "$COMMAND_SECONDS" docker ps -a \
    --filter 'label=com.docker.compose.project=easyboost-staging' \
    --format '{{.ID}}')" || return 1
  [ -z "$containers" ] || return 1
  volumes="$(run_bounded "$COMMAND_SECONDS" docker volume ls --quiet \
    --filter 'name=^easyboost-staging_postgres-data$')" || return 1
  [ -z "$volumes" ] || return 1
  networks="$(run_bounded "$COMMAND_SECONDS" docker network ls --quiet \
    --filter 'name=^easyboost-staging_backend$')" || return 1
  [ -z "$networks" ] || return 1
}

verify_empty_state() {
  local unexpected
  [ ! -e "$app_dir/.release-sha256" ] || return 1
  unexpected="$(run_bounded "$COMMAND_SECONDS" find "$app_dir" -mindepth 1 -maxdepth 1 \
    ! -name '.env.staging' ! -name 'backups' ! -name 'rollbacks' \
    ! -name '.staging-release.lock' ! -name '.staging-recovery-required' \
    -print -quit)" || return 1
  [ -z "$unexpected" ] || return 1
  verify_empty_compose_objects || return 1
  image_is_absent "$release_image" || return 1
  image_is_absent "$STABLE_IMAGE" || return 1
  if [ "${candidate_pair_existed:-0}" -eq 0 ]; then
    [ ! -e "$(release_archive_path "$expected_sha")" ] \
      && [ ! -e "$(release_archive_path "$expected_sha").sha256" ] || return 1
  else
    verify_release_pair "$expected_sha" 'preexisting candidate' || return 1
  fi
}

publication_identity_record() {
  local candidate="$1" role="$2"
  verify_protected_path "$candidate" file "$role" 0 600 || return 1
  run_bounded "$COMMAND_SECONDS" stat -c '%d:%i:%f:%u:%g:%a:%h' -- "$candidate"
}

publication_cleanup_identity_record() {
  local candidate="$1" role="$2" owner mode links permissions
  if [ -L "$candidate" ] || [ ! -f "$candidate" ]; then
    echo "$role entry has an unsafe type" >&2
    return 1
  fi
  owner="$(run_bounded "$COMMAND_SECONDS" stat -c '%u' -- "$candidate")" || return 1
  mode="$(run_bounded "$COMMAND_SECONDS" stat -c '%a' -- "$candidate")" || return 1
  links="$(run_bounded "$COMMAND_SECONDS" stat -c '%h' -- "$candidate")" || return 1
  permissions=$((8#$mode))
  if [ "$owner" != "$(id -u)" ] || [ "$mode" != 600 ] \
    || [ $((permissions & 0022)) -ne 0 ] \
    || { [ "$links" -ne 1 ] && [ "$links" -ne 2 ]; }; then
    echo "$role cleanup identity is unsafe" >&2
    return 1
  fi
  run_bounded "$COMMAND_SECONDS" stat -c '%d:%i:%f:%u:%g:%a:%h' -- "$candidate"
}

remove_owned_publication_path() {
  local candidate="$1" expected_identity="$2" role="$3" current
  local quarantine_dir quarantine move_status=0 removal_status=0 restore_status=0 directory_status=0
  [ -n "$candidate" ] || return 0
  if [ ! -e "$candidate" ] && [ ! -L "$candidate" ]; then
    durable_confirm_absence "$candidate"
    return
  fi
  [ -n "$expected_identity" ] || return 1
  quarantine_dir="$(run_bounded "$COMMAND_SECONDS" \
    mktemp -d "$release_store/.publication-cleanup.XXXXXX")" || return 1
  run_bounded "$COMMAND_SECONDS" chmod 700 "$quarantine_dir" || return 1
  quarantine="$quarantine_dir/owned-entry"
  durable_move_no_replace_file "$candidate" "$quarantine" || move_status="$?"
  if [ -e "$candidate" ] || [ -L "$candidate" ] \
    || { [ ! -e "$quarantine" ] && [ ! -L "$quarantine" ]; }; then
    durable_remove_empty_directory "$quarantine_dir" || true
    echo "$role could not be isolated for cleanup" >&2
    return 1
  fi
  current="$(publication_cleanup_identity_record "$quarantine" "$role")" || current=''
  if [ -z "$current" ] || [ "${current%:*}" != "${expected_identity%:*}" ]; then
    durable_move_no_replace_file "$quarantine" "$candidate" \
      || restore_status="$?"
    if [ -e "$quarantine" ] || [ -L "$quarantine" ]; then restore_status=1; fi
    durable_remove_empty_directory "$quarantine_dir" || directory_status="$?"
    echo "$role identity changed before cleanup" >&2
    [ "$restore_status" -eq 0 ] && [ "$directory_status" -eq 0 ] || true
    return 1
  fi
  durable_remove_file "$quarantine" || removal_status="$?"
  if [ -e "$quarantine" ] || [ -L "$quarantine" ]; then removal_status=1; fi
  durable_remove_empty_directory "$quarantine_dir" || directory_status="$?"
  durable_confirm_absence "$candidate" || return 1
  if [ "$move_status" -ne 0 ] || [ "$removal_status" -ne 0 ] \
    || [ "$directory_status" -ne 0 ]; then
    echo "$role cleanup durability failed (move=$move_status removal=$removal_status directory=$directory_status)" >&2
    return 1
  fi
}

publish_owned_publication_path() {
  local temporary="$1" final="$2" expected_identity="$3" role="$4" linked
  durable_publish_no_replace_file "$temporary" "$final" || return 1
  linked="$(publication_cleanup_identity_record "$final" "$role")" || return 1
  [ "${linked%:*}" = "${expected_identity%:*}" ] && [ "${linked##*:}" -eq 2 ] || return 1
  durable_remove_file "$temporary" || return 1
  [ ! -e "$temporary" ] && [ ! -L "$temporary" ] || return 1
  [ "$(publication_identity_record "$final" "$role")" = "$expected_identity" ]
}

remove_owned_candidate_publication() {
  local failed=0
  candidate_publication_cleanup_failure_step=''
  [ "${candidate_pair_existed:-0}" -eq 0 ] || return 0
  remove_owned_publication_path "$candidate_archive_tmp" "$candidate_archive_identity" \
    'candidate retained archive temporary' || {
      failed=1
      candidate_publication_cleanup_failure_step='remove transaction-owned candidate release publication'
    }
  remove_owned_publication_path "$candidate_archive_final" "$candidate_archive_identity" \
    'candidate retained archive final' || {
      failed=1
      candidate_publication_cleanup_failure_step='remove transaction-owned candidate release publication'
    }
  remove_owned_publication_path "$candidate_sidecar_tmp" "$candidate_sidecar_identity" \
    'candidate retained checksum temporary' || {
      failed=1
      candidate_publication_cleanup_failure_step='remove transaction-owned candidate release publication'
    }
  remove_owned_publication_path "$candidate_sidecar_final" "$candidate_sidecar_identity" \
    'candidate retained checksum final' || {
      failed=1
      candidate_publication_cleanup_failure_step='remove transaction-owned candidate release publication'
    }
  if [ "$failed" -eq 0 ] && [ -n "$candidate_store_prepublication_authority" ]; then
    if [ -n "${store_reservation_file:-}" ]; then
      run_bounded "$COMMAND_SECONDS" node "$runtime_authority_tool" verify-store \
        "$release_store" "$store_reservation_file" \
        "$candidate_store_prepublication_authority" || {
          failed=1
          candidate_publication_cleanup_failure_step='revalidate staging release store after candidate publication cleanup'
        }
    else
      run_bounded "$COMMAND_SECONDS" node "$runtime_authority_tool" verify-store \
        "$release_store" "$candidate_store_prepublication_authority" || {
          failed=1
          candidate_publication_cleanup_failure_step='revalidate staging release store after candidate publication cleanup'
        }
    fi
    [ "$failed" -ne 0 ] || release_store_authority="$candidate_store_prepublication_authority"
  fi
  [ "$failed" -eq 0 ]
}

publish_release_pair() {
  local sha="$1" source="$2" stored
  stored="$(release_archive_path "$sha")"
  if [ "$candidate_pair_existed" -eq 1 ]; then return 0; fi
  reverify_protected_runtime_identity || return 1
  reverify_release_store_identity || return 1
  consume_reservation "$store_reservation_file" \
    "$(run_bounded "$COMMAND_SECONDS" stat -c '%s' -- "$source")" || return 1
  candidate_store_prepublication_authority="$release_store_authority"
  candidate_archive_final="$stored"
  candidate_sidecar_final="$stored.sha256"
  candidate_pair_publication_started=1

  candidate_archive_tmp="$(run_bounded "$COMMAND_SECONDS" \
    mktemp "$release_store/.release-$sha.tar.gz.tmp.XXXXXX")" || return 1
  candidate_archive_identity="$(publication_identity_record "$candidate_archive_tmp" \
    'candidate retained archive temporary')" || return 1
  run_bounded "$COMMAND_SECONDS" cp --reflink=never -- \
    "$source" "$candidate_archive_tmp" || return 1
  [ "$(sha256_file "$candidate_archive_tmp")" = "$sha" ] || return 1
  run_bounded "$COMMAND_SECONDS" chmod 600 "$candidate_archive_tmp" || return 1
  [ "$(publication_identity_record "$candidate_archive_tmp" \
    'candidate retained archive temporary')" = "$candidate_archive_identity" ] || return 1
  publish_owned_publication_path "$candidate_archive_tmp" "$candidate_archive_final" \
    "$candidate_archive_identity" 'candidate retained archive final' || return 1

  candidate_sidecar_tmp="$(run_bounded "$COMMAND_SECONDS" \
    mktemp "$release_store/.release-$sha.sha256.tmp.XXXXXX")" || return 1
  candidate_sidecar_identity="$(publication_identity_record "$candidate_sidecar_tmp" \
    'candidate retained checksum temporary')" || return 1
  printf '%s\n' "$sha" | run_bounded "$COMMAND_SECONDS" \
    tee "$candidate_sidecar_tmp" >/dev/null || return 1
  run_bounded "$COMMAND_SECONDS" chmod 600 "$candidate_sidecar_tmp" || return 1
  [ "$(publication_identity_record "$candidate_sidecar_tmp" \
    'candidate retained checksum temporary')" = "$candidate_sidecar_identity" ] || return 1
  publish_owned_publication_path "$candidate_sidecar_tmp" "$candidate_sidecar_final" \
    "$candidate_sidecar_identity" 'candidate retained checksum final' || return 1
  validate_release_store allow-change || return 1
  verify_release_pair "$sha" 'published candidate' || return 1
  candidate_pair_published=1
}

publish_active_marker() {
  local sha="$1" temporary
  reverify_protected_runtime_identity || return 1
  reverify_active_marker_identity || return 1
  temporary="$(run_bounded "$COMMAND_SECONDS" \
    mktemp "$app_dir/.release-sha256.tmp.XXXXXX")" || return 1
  printf '%s\n' "$sha" > "$temporary"
  run_bounded "$COMMAND_SECONDS" chmod 600 "$temporary" || return 1
  durable_replace_file "$temporary" "$app_dir/.release-sha256" || return 1
  capture_active_marker_identity
}

begin_release_transaction() {
  local temporary
  reverify_protected_runtime_identity || return 1
  reverify_transaction_marker_identity || return 1
  temporary="$(run_bounded "$COMMAND_SECONDS" \
    mktemp "$app_dir/.staging-recovery-required.tmp.XXXXXX")" || return 1
  printf 'release transaction in progress\n' > "$temporary"
  run_bounded "$COMMAND_SECONDS" chmod 600 "$temporary" || return 1
  durable_replace_file "$temporary" "$recovery_marker" || return 1
  transaction_marker_created=1
  capture_transaction_marker_identity
}

clear_transaction_marker() {
  local removal_status
  reverify_transaction_marker_identity || {
    echo 'Staging transaction marker identity could not be revalidated before removal' >&2
    return 1
  }
  if durable_remove_file "$recovery_marker"; then
    capture_transaction_marker_identity || {
      echo 'Staging transaction marker absence authority could not be captured' >&2
      return 1
    }
    return 0
  else
    removal_status="$?"
    echo "Staging transaction marker durable removal failed with status $removal_status" >&2
  fi
  # A pathname command may report failure after it has already removed the
  # exact, prevalidated marker. Preserve the nonzero/fail-closed result, but
  # durably reconcile absence and replace the stale inode authority so cleanup
  # can publish a new recovery-required marker without claiming success.
  if durable_confirm_absence "$recovery_marker"; then
    capture_transaction_marker_identity || {
      echo 'Staging transaction marker reconciled absence could not be captured' >&2
      return 1
    }
  else
    echo 'Staging transaction marker absence could not be durably reconciled' >&2
  fi
  return "$removal_status"
}
