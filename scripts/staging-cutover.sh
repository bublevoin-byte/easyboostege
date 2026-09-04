#!/bin/bash
set -Eeuo pipefail
umask 077
unset EASYBOOST_STAGING_BUILD_CONTEXT

ENTRY_PROTOCOL='immutable-archive-v4'
MAX_RELEASE_ARCHIVE_BYTES=$((256 * 1024 * 1024))
MAX_LEGACY_COMPOSE_BYTES=$((4 * 1024 * 1024))

if [ "$#" -ne 9 ] || [ "$8" != "$ENTRY_PROTOCOL" ] \
  || [[ ! "$2" =~ ^[0-9a-f]{64}$ ]] \
  || [[ ! "$3" =~ ^[0-9a-f]{64}$ ]] \
  || [[ ! "$4" =~ ^[0-9a-f]{64}$ ]] \
  || [[ ! "$9" =~ ^[0-9a-f]{64}$ ]] \
  || [[ ! "$5" =~ ^(700|755)$ ]] \
  || [[ ! "$6" =~ ^(600|644)$ ]] \
  || [[ ! "$7" =~ ^(600|644|664)$ ]] \
  || { [ "$7" = 664 ] && [ "$5" != 700 ]; }; then
  echo "Usage: $0 BRIDGE_ARCHIVE BRIDGE_SHA256 LEGACY_MARKER_SHA256 LEGACY_COMPOSE_SHA256 LEGACY_APP_MODE LEGACY_MARKER_MODE LEGACY_COMPOSE_MODE $ENTRY_PROTOCOL BUNDLE_SHA256" >&2
  exit 64
fi

entry_source="${BASH_SOURCE[0]}"
case "$entry_source" in /*) ;; *) echo "staging cutover helper path must be absolute" >&2; exit 69 ;; esac
source "${entry_source%/*}/staging-release-common.sh"
[ "$PROTOCOL" = "$ENTRY_PROTOCOL" ] || {
  echo "staging cutover helper protocol mismatch" >&2
  exit 69
}

expected_bundle_digest="$9"
trap 'exit 124' TERM
begin_transaction_deadline
trap stop_early_deadline EXIT
command -v node >/dev/null 2>&1 || { echo "Node.js is required" >&2; exit 69; }
verify_helper_bundle "$expected_bundle_digest" || exit 69

archive="$1"
bridge_sha="${2,,}"
legacy_marker_sha="${3,,}"
legacy_compose_sha="${4,,}"
expected_legacy_app_mode="$5"
expected_legacy_marker_mode="$6"
expected_legacy_compose_mode="$7"
app_dir="${STAGING_APP_DIR:-/opt/easyboost-staging}"
case "$archive" in /*) ;; *) archive="$(pwd -P)/$archive" ;; esac
case "$app_dir" in /*) app_dir="${app_dir%/}" ;; *) echo "Staging app directory must be absolute" >&2; exit 65 ;; esac
case "$app_dir" in /|/opt) echo "Unsafe staging app directory" >&2; exit 65 ;; esac

env_file="$app_dir/.env.staging"
compose_file="$app_dir/compose.staging.yml"
marker_file="$app_dir/.release-sha256"
release_store="$app_dir/rollbacks/releases"
lock_file="$app_dir/.staging-release.lock"
recovery_marker="$app_dir/.staging-recovery-required"
cutover_host_lock_tool="$script_dir/staging-cutover-host-lock.js"
cutover_host_lock_directory="${EASYBOOST_HOST_OPERATION_LOCK_DIR:-/var/lib/easyboost/locks/host-operation.lock}"

command -v flock >/dev/null 2>&1 || { echo "flock is required" >&2; exit 69; }
command -v timeout >/dev/null 2>&1 || { echo "GNU timeout is required" >&2; exit 69; }
[ "$(run_bounded "$COMMAND_SECONDS" readlink -m -- "$archive")" = "$archive" ] || {
  echo 'Bridge archive path must be absolute and canonical' >&2
  exit 65
}
[ "$(run_bounded "$COMMAND_SECONDS" readlink -m -- "$app_dir")" = "$app_dir" ] || {
  echo 'Staging app directory must be absolute and canonical' >&2
  exit 65
}
case "$cutover_host_lock_directory" in /*) ;; *) echo 'Cutover host-lock path must be absolute' >&2; exit 65 ;; esac
[ "$(run_bounded "$COMMAND_SECONDS" readlink -m -- "$cutover_host_lock_directory")" \
    = "$cutover_host_lock_directory" ] || {
  echo 'Cutover host-lock path must be absolute and canonical' >&2
  exit 65
}

frozen_archive=''
candidate_compose_temporary=''
candidate_compose_authority=''
cutover_compose_temp_present=0
cutover_compose_temp_mode=''
cutover_compose_temp_authority=''
legacy_compose_mode=''
legacy_marker_mode=''
legacy_root_mode=''
legacy_root_identity=''
legacy_backups_identity=''
legacy_rollbacks_identity=''
legacy_environment_authority=''
legacy_marker_authority=''
legacy_compose_authority=''
legacy_authority_sha=''
legacy_store_identity=''
legacy_store_snapshot=''
legacy_store_existed=0
cutover_state=''
cutover_marker_state=''
cutover_tree_state=''
cutover_journal_present=0
cutover_journal_nonce=''
expected_cutover_journal_nonce=''
cutover_journal_temporary=''
cutover_journal_temp_authority=''
cutover_marker_temporary=''
cutover_marker_temp_present=0
cutover_marker_temp_mode=''
cutover_marker_temp_authority=''
cutover_host_lock_capability=''
cutover_host_lock_owned=0
cutover_host_lock_released=0
cutover_staged_archive=''
cutover_staged_sidecar=''
cutover_staged_archive_prefix_authority=''
cutover_staged_sidecar_prefix_authority=''
bridge_compose_sha=''
bridge_sidecar_sha=''
uploaded_archive_authority=''
uploaded_archive_size=0
candidate_expanded=0
candidate_compressed=0
candidate_pair_existed=0
candidate_pair_publication_started=0
candidate_pair_published=0
release_transaction_started=0
transaction_marker_created=0
transaction_cleared=0
compose_replaced=0
marker_promotion_attempted=0
stable_promotion_attempted=0
stable_tag_created=0
stable_preexisted=0
running_app_container=''
running_app_image_id=''
commit_verified=0
finalization_done=0
release_finalization_step=''
release_finalization_verified=0
image_build_attempted=0
release_image=''

capture_legacy_file() {
  local candidate="$1" role="$2" mode="$3" maximum="$4"
  run_bounded "$COMMAND_SECONDS" node "$runtime_authority_tool" capture-file \
    "$candidate" "$role" "$((8#$mode))" "$maximum"
}

capture_legacy_root() {
  local candidate="$1" mode="$2"
  run_bounded "$COMMAND_SECONDS" node "$runtime_authority_tool" \
    capture-cutover-legacy-root "$candidate" "$((8#$mode))"
}

verify_legacy_root() {
  local candidate="$1" mode="$2" authority="$3"
  run_bounded "$COMMAND_SECONDS" node "$runtime_authority_tool" \
    verify-cutover-legacy-root "$candidate" "$((8#$mode))" "$authority"
}

capture_legacy_bound_file() {
  local candidate="$1" kind="$2" mode="$3" maximum="$4"
  run_bounded "$COMMAND_SECONDS" node "$runtime_authority_tool" \
    capture-cutover-legacy-file "$candidate" "$kind" "$((8#$mode))" "$maximum"
}

verify_legacy_bound_file() {
  local candidate="$1" kind="$2" mode="$3" maximum="$4" authority="$5"
  run_bounded "$COMMAND_SECONDS" node "$runtime_authority_tool" \
    verify-cutover-legacy-file "$candidate" "$kind" "$((8#$mode))" "$maximum" \
    "$authority"
}

verify_legacy_file() {
  local candidate="$1" role="$2" mode="$3" maximum="$4" authority="$5"
  run_bounded "$COMMAND_SECONDS" node "$runtime_authority_tool" verify-file \
    "$candidate" "$role" "$((8#$mode))" "$maximum" "$authority"
}

verify_legacy_tree_proof() {
  local proof proof_archive_sha proof_live_compose_sha
  proof="$(run_bounded "$ARCHIVE_INSPECT_SECONDS" node "$archive_tool" \
    verify-tree-transition "$frozen_archive" "$app_dir" compose.staging.yml)" || return 1
  proof_archive_sha="$(authority_field "$proof" sha256)" || return 1
  proof_live_compose_sha="$(authority_field "$proof" liveTransitionSha256)" || return 1
  [ "$proof_archive_sha" = "$bridge_sha" ] \
    && [ "$proof_live_compose_sha" = "$legacy_compose_sha" ] || {
      echo "Legacy tree or Compose authority does not match the approved bridge" >&2
      return 1
    }
}

capture_single_running_container() {
  local service="$1" output
  output="$(run_bounded "$COMMAND_SECONDS" docker ps --no-trunc --quiet \
    --filter 'label=com.docker.compose.project=easyboost-staging' \
    --filter "label=com.docker.compose.service=$service" \
    --filter 'label=com.docker.compose.oneoff=False')" || return 1
  [ -n "$output" ] && [[ "$output" != *$'\n'* ]] || {
    echo "Staging $service must have exactly one running Compose container" >&2
    return 1
  }
  printf '%s\n' "$output"
}

container_image_id() {
  local container="$1" actual
  actual="$(run_bounded "$COMMAND_SECONDS" docker inspect \
    --format '{{.Image}}' "$container")" || return 1
  canonical_image_id "$actual" || {
    echo "Running staging container has a noncanonical image identity" >&2
    return 1
  }
  printf '%s\n' "$actual"
}

capture_running_pair() {
  running_app_container="$(capture_single_running_container app)" || return 1
  running_app_image_id="$(container_image_id "$running_app_container")" || return 1
  require_local_dependency_images || return 1
  capture_running_postgres_authority || return 1
}

verify_running_pair() {
  local app_container app_image
  app_container="$(capture_single_running_container app)" || return 1
  [ "$app_container" = "$running_app_container" ] || {
      echo "Staging app container identity changed during cutover" >&2
      return 1
    }
  app_image="$(container_image_id "$app_container")" || return 1
  [ "$app_image" = "$running_app_image_id" ] || {
      echo "Staging app container image identity changed during cutover" >&2
      return 1
    }
  verify_running_postgres_authority || return 1
}

verify_uploaded_archive_authority() {
  local current
  current="$(run_bounded "$COMMAND_SECONDS" node "$bounded_stream_tool" \
    capture-file "$archive" "$MAX_RELEASE_ARCHIVE_BYTES")" || return 1
  [ "$current" = "$uploaded_archive_authority" ]
}

validate_staging_compose_archive_contract() {
  local candidate_archive="$1" expected_context
  verify_uploaded_archive_authority || return 1
  require_local_dependency_images || return 1
  expected_context="$(run_bounded "$COMMAND_SECONDS" readlink -m \
    "$app_dir/.guarded-staging-build-context-required")" || return 1
  if ! run_bounded "$ARCHIVE_INSPECT_SECONDS" node "$archive_tool" \
      emit-compose "$candidate_archive" \
    | run_bounded "$COMMAND_SECONDS" docker compose --project-directory "$app_dir" \
      -f - --env-file "$env_file" config --format json 2>/dev/null \
    | run_bounded "$COMMAND_SECONDS" node "$compose_contract_tool" "$expected_context"; then
    echo 'unsafe release archive: invalid staging Compose configuration' >&2
    return 1
  fi
  verify_uploaded_archive_authority
}

wait_for_prebootstrap_readiness() {
  local port attempt
  verify_legacy_file "$env_file" 'legacy staging environment' 600 4194304 \
    "$legacy_environment_authority" || return 1
  port="$(run_bounded "$COMMAND_SECONDS" node "$runtime_authority_tool" \
    read-env-port "$env_file")" || return 1
  for ((attempt=1; attempt<=READINESS_ATTEMPTS; attempt+=1)); do
    if run_bounded 10 curl --connect-timeout 3 --max-time 5 -fsS \
      "http://127.0.0.1:$port/health/ready" >/dev/null; then return 0; fi
    [ "$attempt" -lt "$READINESS_ATTEMPTS" ] || return 1
    run_bounded "$READINESS_INTERVAL_SECONDS" sleep "$READINESS_INTERVAL_SECONDS" || return 1
  done
}

capture_stable_cutover_state() {
  local stable_probe_status
  if stable_image_id="$(probe_image_reference "$STABLE_IMAGE")"; then
    stable_preexisted=1
    [ "$stable_image_id" = "$running_app_image_id" ] || {
      echo "Existing stable app image does not match the running app" >&2
      return 1
    }
  else
    stable_probe_status="$?"
    [ "$stable_probe_status" -eq 1 ] || return 1
    [ "$cutover_tree_state" = legacy ] || {
      echo "A bridge Compose tree requires the exact running app stable tag" >&2
      return 1
    }
    stable_preexisted=0
    stable_image_id=''
  fi
}

verify_stable_cutover_state() {
  if [ "$stable_preexisted" -eq 1 ]; then
    verify_stable_image "$running_app_image_id"
  else
    image_is_absent "$STABLE_IMAGE"
  fi
}

verify_cutover_store_file() {
  local candidate="$1" expected_sha="$2" role="$3" owner mode links permissions actual
  [ ! -L "$candidate" ] && [ -f "$candidate" ] || {
    echo "$role must be a regular no-follow file" >&2
    return 1
  }
  owner="$(run_bounded "$COMMAND_SECONDS" stat -c '%u' -- "$candidate")" || return 1
  mode="$(run_bounded "$COMMAND_SECONDS" stat -c '%a' -- "$candidate")" || return 1
  links="$(run_bounded "$COMMAND_SECONDS" stat -c '%h' -- "$candidate")" || return 1
  permissions=$((8#$mode))
  [ "$owner" = "$(id -u)" ] && [ "$mode" = 600 ] \
    && [ $((permissions & 0022)) -eq 0 ] \
    && { [ "$links" -eq 1 ] || [ "$links" -eq 2 ]; } || {
      echo "$role has an unsafe owner, mode or link count" >&2
      return 1
    }
  actual="$(sha256_file "$candidate")" || return 1
  [ "$actual" = "$expected_sha" ] || {
    echo "$role bytes do not match the approved cutover" >&2
    return 1
  }
}

capture_cutover_store_snapshot() {
  local entry name records=''
  local archive_final sidecar_final
  archive_final="$(release_archive_path "$bridge_sha")"
  sidecar_final="$archive_final.sha256"
  shopt -s nullglob dotglob
  local entries=("$release_store"/*)
  shopt -u nullglob dotglob
  for entry in "${entries[@]}"; do
    name="${entry##*/}"
    case "$entry" in
      "$archive_final") verify_cutover_store_file "$entry" "$bridge_sha" \
        'cutover bridge retained archive' || return 1 ;;
      "$sidecar_final") verify_cutover_store_file "$entry" "$bridge_sidecar_sha" \
        'cutover bridge checksum sidecar' || return 1 ;;
      *) echo "Cutover release store contains foreign or unowned state: $name" >&2; return 1 ;;
    esac
    records+="$name:$(run_bounded "$COMMAND_SECONDS" stat -c '%d:%i:%f:%u:%g:%a:%h:%s' -- "$entry"):$(sha256_file "$entry")\n"
  done
  printf '%b' "$records"
}

cutover_pair_presence() {
  local archive_final sidecar_final archive_present=0 sidecar_present=0
  archive_final="$(release_archive_path "$bridge_sha")"
  sidecar_final="$archive_final.sha256"
  [ ! -e "$archive_final" ] && [ ! -L "$archive_final" ] \
    || { verify_cutover_store_file "$archive_final" "$bridge_sha" \
      'cutover bridge retained archive' || return 1; archive_present=1; }
  [ ! -e "$sidecar_final" ] && [ ! -L "$sidecar_final" ] \
    || { verify_cutover_store_file "$sidecar_final" "$bridge_sidecar_sha" \
      'cutover bridge checksum sidecar' || return 1; sidecar_present=1; }
  printf '%s:%s\n' "$archive_present" "$sidecar_present"
}

read_cutover_journal_nonce() {
  run_bounded "$COMMAND_SECONDS" node "$runtime_authority_tool" read-cutover-journal \
    "$recovery_marker" "$bridge_sha" "$legacy_marker_sha" "$legacy_compose_sha" \
    "$expected_legacy_app_mode" "$expected_legacy_marker_mode" \
    "$expected_legacy_compose_mode" "$legacy_authority_sha" "$expected_bundle_digest"
}

derive_cutover_journal_nonce() {
  run_bounded "$COMMAND_SECONDS" node -e '
    const crypto = require("node:crypto");
    const fields = process.argv.slice(1);
    if (fields.length !== 8
        || [0, 1, 2, 6, 7].some(index => !/^[a-f0-9]{64}$/.test(fields[index]))
        || !/^(700|755)$/.test(fields[3])
        || !/^(600|644)$/.test(fields[4])
        || !/^(600|644|664)$/.test(fields[5])
        || (fields[5] === "664" && fields[3] !== "700")) {
      process.exit(2);
    }
    process.stdout.write(crypto.createHash("sha256")
      .update(["easyboost-staging-cutover-v1", ...fields].join("\\0"))
      .digest("hex") + "\\n");
  ' "$bridge_sha" "$legacy_marker_sha" "$legacy_compose_sha" \
    "$expected_legacy_app_mode" "$expected_legacy_marker_mode" \
    "$expected_legacy_compose_mode" "$legacy_authority_sha" "$expected_bundle_digest"
}

verify_cutover_host_lock() {
  local result
  [ "$cutover_host_lock_owned" -eq 1 ] && [ -n "$cutover_host_lock_capability" ] || return 1
  result="$(run_bounded "$COMMAND_SECONDS" node "$cutover_host_lock_tool" verify \
    "$$" "$cutover_host_lock_capability")" || return 1
  [ "$result" = verified ]
}

acquire_cutover_host_lock() {
  local status
  [ "$cutover_journal_present" -eq 1 ] \
    && [[ "$cutover_journal_nonce" =~ ^[a-f0-9]{64}$ ]] || return 1
  case "$cutover_host_lock_directory" in /*) ;; *) return 64 ;; esac
  verify_safe_ancestors "$cutover_host_lock_directory" || return 1
  if cutover_host_lock_capability="$(run_bounded "$COMMAND_SECONDS" node \
    "$cutover_host_lock_tool" acquire "$cutover_host_lock_directory" "$$" \
    "$app_dir" "$cutover_journal_nonce" "$bridge_sha" "$legacy_marker_sha" \
    "$legacy_compose_sha" "$expected_legacy_app_mode" \
    "$expected_legacy_marker_mode" "$expected_legacy_compose_mode" \
    "$legacy_authority_sha" "$expected_bundle_digest")"; then
    cutover_host_lock_owned=1
    verify_cutover_host_lock
    return
  else
    status="$?"
  fi
  cutover_host_lock_capability=''
  cutover_host_lock_owned=0
  return "$status"
}

release_cutover_host_lock() {
  local result
  verify_cutover_host_lock || return 1
  result="$(run_bounded "$COMMAND_SECONDS" node "$cutover_host_lock_tool" release \
    "$$" "$cutover_host_lock_capability")" || return 1
  [ "$result" = released ] || return 1
  cutover_host_lock_owned=0
  cutover_host_lock_released=1
  cutover_host_lock_capability=''
}

reconcile_cutover_journal_temporary() {
  cutover_journal_temp_authority="$(run_bounded "$COMMAND_SECONDS" node \
    "$runtime_authority_tool" capture-cutover-journal-prefix \
    "$cutover_journal_temporary" "$bridge_sha" "$legacy_marker_sha" \
    "$legacy_compose_sha" "$expected_legacy_app_mode" \
    "$expected_legacy_marker_mode" "$expected_legacy_compose_mode" \
    "$legacy_authority_sha" "$expected_bundle_digest" \
    "$expected_cutover_journal_nonce")" || return 1
  [ -n "$cutover_journal_temp_authority" ]
}

verify_cutover_journal_namespace() {
  run_bounded "$COMMAND_SECONDS" node "$runtime_authority_tool" \
    verify-cutover-journal-namespace "$app_dir" "$cutover_journal_temporary" >/dev/null
}

publish_cutover_active_marker() {
  verify_cutover_host_lock || return 1
  reverify_active_marker_identity || return 1
  reverify_transaction_marker_identity || return 1
  [ -n "$cutover_marker_temp_authority" ] || return 1
  run_bounded "$COMMAND_SECONDS" node "$runtime_authority_tool" \
    publish-cutover-marker "$cutover_marker_temporary" "$marker_file" \
    "$bridge_sha" "$legacy_marker_sha" "$cutover_marker_temp_authority" \
    "$active_marker_authority" || return 1
  cutover_marker_temp_present=0
  cutover_marker_temp_authority=''
  capture_active_marker_identity || return 1
  [ "$(read_exact_sha_marker "$marker_file" 'published bridge marker')" = "$bridge_sha" ]
}

begin_cutover_transaction() {
  if [ "$cutover_journal_present" -eq 1 ]; then
    [ ! -e "$cutover_journal_temporary" ] && [ ! -L "$cutover_journal_temporary" ] \
      || return 1
    cutover_journal_nonce="$(read_cutover_journal_nonce)" || return 1
    [ "$cutover_journal_nonce" = "$expected_cutover_journal_nonce" ] || return 1
    capture_transaction_marker_identity || return 1
  else
    cutover_journal_nonce="$expected_cutover_journal_nonce"
    [[ "$cutover_journal_nonce" =~ ^[0-9a-f]{64}$ ]] || return 1
    verify_prebootstrap_authority || return 1
    [ -n "$cutover_journal_temp_authority" ] || return 1
    run_bounded "$COMMAND_SECONDS" node "$runtime_authority_tool" \
      publish-cutover-journal "$cutover_journal_temporary" "$recovery_marker" \
      "$bridge_sha" "$legacy_marker_sha" "$legacy_compose_sha" \
      "$expected_legacy_app_mode" "$expected_legacy_marker_mode" \
      "$expected_legacy_compose_mode" "$legacy_authority_sha" \
      "$expected_bundle_digest" \
      "$cutover_journal_nonce" \
      "$cutover_journal_temp_authority" || return 1
    cutover_journal_temp_authority=''
    cutover_journal_present=1
    transaction_marker_created=1
    capture_transaction_marker_identity || return 1
  fi
  cutover_staged_archive="$app_dir/backups/.staging-cutover-$cutover_journal_nonce.release.tar.gz"
  cutover_staged_sidecar="$app_dir/backups/.staging-cutover-$cutover_journal_nonce.release.tar.gz.sha256"
  release_transaction_started=1
}

ensure_cutover_transaction_directory() {
  verify_cutover_host_lock || return 1
  reverify_transaction_marker_identity || return 1
  [ "$cutover_staged_archive" \
      = "$app_dir/backups/.staging-cutover-$cutover_journal_nonce.release.tar.gz" ] \
    && [ "$cutover_staged_sidecar" \
      = "$app_dir/backups/.staging-cutover-$cutover_journal_nonce.release.tar.gz.sha256" ] \
    || return 1
  verify_protected_path "$app_dir/backups" directory 'staging backup root' 1 700
}

verify_cutover_staged_hardlink() {
  local staged="$1" final="$2" expected_sha="$3" role="$4" staged_identity final_identity
  verify_cutover_store_file "$staged" "$expected_sha" "$role staged" || return 1
  verify_cutover_store_file "$final" "$expected_sha" "$role final" || return 1
  staged_identity="$(run_bounded "$COMMAND_SECONDS" stat -c '%d:%i' -- "$staged")" || return 1
  final_identity="$(run_bounded "$COMMAND_SECONDS" stat -c '%d:%i' -- "$final")" || return 1
  [ "$staged_identity" = "$final_identity" ]
}

capture_cutover_staged_authorities() {
  local archive_links=0 sidecar_links=0 archive_final sidecar_final
  archive_final="$(release_archive_path "$bridge_sha")"
  sidecar_final="$archive_final.sha256"
  if [ "$cutover_journal_present" -eq 0 ]; then
    [ ! -e "$cutover_staged_archive" ] && [ ! -L "$cutover_staged_archive" ] \
      && [ ! -e "$cutover_staged_sidecar" ] && [ ! -L "$cutover_staged_sidecar" ] || return 1
  fi
  if [ -e "$cutover_staged_archive" ] || [ -L "$cutover_staged_archive" ]; then
    [ "$cutover_journal_present" -eq 1 ] || return 1
    archive_links="$(run_bounded "$COMMAND_SECONDS" stat -c '%h' -- \
      "$cutover_staged_archive")" || return 1
  fi
  if [ "$archive_links" -eq 2 ]; then
    verify_cutover_staged_hardlink "$cutover_staged_archive" "$archive_final" \
      "$bridge_sha" 'cutover bridge archive' || return 1
    cutover_staged_archive_prefix_authority='published-hardlink'
  else
    cutover_staged_archive_prefix_authority="$(run_bounded "$COMMAND_SECONDS" node \
      "$bounded_stream_tool" capture-file-prefix "$archive" "$cutover_staged_archive" \
      "$MAX_RELEASE_ARCHIVE_BYTES" "$uploaded_archive_authority")" || return 1
  fi
  if [ -e "$cutover_staged_sidecar" ] || [ -L "$cutover_staged_sidecar" ]; then
    [ "$cutover_journal_present" -eq 1 ] || return 1
    sidecar_links="$(run_bounded "$COMMAND_SECONDS" stat -c '%h' -- \
      "$cutover_staged_sidecar")" || return 1
  fi
  if [ "$sidecar_links" -eq 2 ]; then
    verify_cutover_staged_hardlink "$cutover_staged_sidecar" "$sidecar_final" \
      "$bridge_sidecar_sha" 'cutover bridge checksum' || return 1
    cutover_staged_sidecar_prefix_authority='published-hardlink'
  else
    cutover_staged_sidecar_prefix_authority="$(run_bounded "$COMMAND_SECONDS" node \
      "$runtime_authority_tool" capture-cutover-marker-prefix \
      "$cutover_staged_sidecar" "$bridge_sha")" || return 1
  fi
}

verify_cutover_staged_authorities() {
  local archive_before="$cutover_staged_archive_prefix_authority"
  local sidecar_before="$cutover_staged_sidecar_prefix_authority"
  capture_cutover_staged_authorities || return 1
  [ "$cutover_staged_archive_prefix_authority" = "$archive_before" ] \
    && [ "$cutover_staged_sidecar_prefix_authority" = "$sidecar_before" ]
}

ensure_bridge_release_pair() {
  local archive_final sidecar_final links
  verify_cutover_host_lock || return 1
  reverify_transaction_marker_identity || return 1
  archive_final="$(release_archive_path "$bridge_sha")"
  sidecar_final="$archive_final.sha256"
  ensure_cutover_transaction_directory || return 1
  [ "$frozen_archive" = "$cutover_staged_archive" ] || return 1
  verify_cutover_store_file "$cutover_staged_archive" "$bridge_sha" \
    'cutover staged bridge archive' || return 1
  if [ -e "$cutover_staged_sidecar" ] || [ -L "$cutover_staged_sidecar" ]; then
    [ ! -L "$cutover_staged_sidecar" ] && [ -f "$cutover_staged_sidecar" ] || return 1
    links="$(run_bounded "$COMMAND_SECONDS" stat -c '%h' -- \
      "$cutover_staged_sidecar")" || return 1
    if [ "$links" -eq 2 ]; then
      verify_cutover_store_file "$cutover_staged_sidecar" "$bridge_sidecar_sha" \
        'cutover staged bridge checksum' || return 1
    else
      [ "$links" -eq 1 ] || return 1
      [ -n "$cutover_staged_sidecar_prefix_authority" ] || return 1
      [ "$(run_bounded "$COMMAND_SECONDS" node "$runtime_authority_tool" \
        capture-cutover-marker-prefix "$cutover_staged_sidecar" "$bridge_sha")" \
        = "$cutover_staged_sidecar_prefix_authority" ] || return 1
      run_bounded "$COMMAND_SECONDS" node "$runtime_authority_tool" \
        complete-cutover-marker-prefix "$cutover_staged_sidecar" "$bridge_sha" \
        "$cutover_staged_sidecar_prefix_authority" >/dev/null || return 1
    fi
  else
    [ "$cutover_staged_sidecar_prefix_authority" = '{"present":false}' ] || return 1
    run_bounded "$COMMAND_SECONDS" node "$runtime_authority_tool" \
      complete-cutover-marker-prefix "$cutover_staged_sidecar" "$bridge_sha" \
      "$cutover_staged_sidecar_prefix_authority" >/dev/null || return 1
  fi
  durable_sync_parent "$cutover_staged_sidecar" || return 1
  verify_cutover_store_file "$cutover_staged_sidecar" "$bridge_sidecar_sha" \
    'cutover staged bridge checksum' || return 1
  if [ ! -e "$archive_final" ] && [ ! -L "$archive_final" ]; then
    durable_publish_no_replace_file "$cutover_staged_archive" "$archive_final" || return 1
  else
    verify_cutover_store_file "$archive_final" "$bridge_sha" \
      'cutover bridge retained archive' || return 1
  fi
  if [ ! -e "$sidecar_final" ] && [ ! -L "$sidecar_final" ]; then
    durable_publish_no_replace_file "$cutover_staged_sidecar" "$sidecar_final" || return 1
  else
    verify_cutover_store_file "$sidecar_final" "$bridge_sidecar_sha" \
      'cutover bridge checksum sidecar' || return 1
  fi
  durable_remove_file "$cutover_staged_archive" || return 1
  durable_remove_file "$cutover_staged_sidecar" || return 1
  cutover_staged_archive=''
  cutover_staged_sidecar=''
  capture_release_store_identity || return 1
  validate_release_store allow-change || return 1
  verify_release_pair "$bridge_sha" 'cutover bridge' || return 1
  candidate_pair_existed=1
  candidate_pair_published=1
}

prepare_cutover_frozen_archive() {
  local available current_prefix_size links required frozen_record
  verify_cutover_host_lock || return 1
  reverify_transaction_marker_identity || return 1
  ensure_cutover_transaction_directory || return 1
  frozen_archive="$cutover_staged_archive"
  if [ -e "$frozen_archive" ] || [ -L "$frozen_archive" ]; then
    links="$(run_bounded "$COMMAND_SECONDS" stat -c '%h' -- "$frozen_archive")" || return 1
    if [ "$links" -eq 2 ]; then
      verify_cutover_store_file "$frozen_archive" "$bridge_sha" \
        'journal-owned published bridge archive' || return 1
      run_archive_inspect "$frozen_archive" || return 1
      return
    fi
    [ "$links" -eq 1 ] || return 1
  fi
  [ -n "$cutover_staged_archive_prefix_authority" ] || return 1
  [ "$(run_bounded "$COMMAND_SECONDS" node "$bounded_stream_tool" \
    capture-file-prefix "$archive" "$frozen_archive" "$MAX_RELEASE_ARCHIVE_BYTES" \
    "$uploaded_archive_authority")" = "$cutover_staged_archive_prefix_authority" ] || return 1
  if [ -e "$frozen_archive" ]; then
    current_prefix_size="$(run_bounded "$COMMAND_SECONDS" stat -c '%s' -- \
      "$frozen_archive")" || return 1
  else
    current_prefix_size=0
  fi
  [[ "$current_prefix_size" =~ ^[0-9]+$ ]] \
    && [ "$current_prefix_size" -le "$uploaded_archive_size" ] || return 1
  required=$((uploaded_archive_size - current_prefix_size + MINIMUM_DISK_HEADROOM_BYTES))
  available="$(run_bounded "$COMMAND_SECONDS" df --output=avail -B1 -- \
    "$app_dir/backups")" || return 1
  available="${available##*$'\n'}"
  [[ "$available" =~ ^[0-9]+$ ]] && [ "$available" -ge "$required" ] || {
      echo 'Insufficient cutover release-store capacity and headroom' >&2
      return 1
    }
  verify_cutover_host_lock || return 1
  reverify_transaction_marker_identity || return 1
  verify_uploaded_archive_authority || return 1
  frozen_record="$(run_bounded "$COMMAND_SECONDS" node "$bounded_stream_tool" \
    complete-file-prefix "$archive" "$frozen_archive" "$MAX_RELEASE_ARCHIVE_BYTES" \
    "$uploaded_archive_authority" "$cutover_staged_archive_prefix_authority")" || return 1
  [ "$(authority_field "$frozen_record" bytes)" = "$uploaded_archive_size" ] \
    && [ "$(authority_field "$frozen_record" sha256)" = "$bridge_sha" ] || return 1
  durable_sync_file "$frozen_archive" || return 1
  durable_sync_parent "$frozen_archive" || return 1
  verify_cutover_store_file "$frozen_archive" "$bridge_sha" \
    'journal-owned frozen bridge archive' || return 1
  run_archive_inspect "$frozen_archive"
}

verify_prebootstrap_authority() {
  verify_cutover_journal_namespace || return 1
  verify_legacy_root "$app_dir" "$legacy_root_mode" "$legacy_root_identity" \
    && verify_legacy_root "$app_dir/backups" 700 "$legacy_backups_identity" \
    && verify_legacy_root "$app_dir/rollbacks" 700 "$legacy_rollbacks_identity" \
    || return 1
  verify_legacy_file "$env_file" 'legacy staging environment' 600 4194304 \
    "$legacy_environment_authority" || return 1
  verify_legacy_bound_file "$marker_file" marker "$legacy_marker_mode" 65 \
    "$legacy_marker_authority" || return 1
  verify_legacy_bound_file "$compose_file" compose "$legacy_compose_mode" \
    "$MAX_LEGACY_COMPOSE_BYTES" "$legacy_compose_authority" || return 1
  if [ "$cutover_journal_present" -eq 1 ]; then
    reverify_transaction_marker_identity || return 1
    [ "$(read_cutover_journal_nonce)" = "$expected_cutover_journal_nonce" ] || return 1
    [ ! -e "$cutover_journal_temporary" ] && [ ! -L "$cutover_journal_temporary" ] \
      || return 1
  else
    [ ! -e "$recovery_marker" ] && [ ! -L "$recovery_marker" ] || return 1
    [ "$(run_bounded "$COMMAND_SECONDS" node "$runtime_authority_tool" \
      capture-cutover-journal-prefix "$cutover_journal_temporary" \
      "$bridge_sha" "$legacy_marker_sha" "$legacy_compose_sha" \
      "$expected_legacy_app_mode" "$expected_legacy_marker_mode" \
      "$expected_legacy_compose_mode" "$legacy_authority_sha" \
      "$expected_bundle_digest" \
      "$expected_cutover_journal_nonce")" \
      = "$cutover_journal_temp_authority" ] || return 1
  fi
  if [ "$cutover_compose_temp_present" -eq 1 ]; then
    verify_legacy_file "$app_dir/.compose.staging.yml.cutover-$bridge_sha" \
      'cutover Compose temporary' "$cutover_compose_temp_mode" \
      "$MAX_LEGACY_COMPOSE_BYTES" "$cutover_compose_temp_authority" || return 1
  else
    [ ! -e "$app_dir/.compose.staging.yml.cutover-$bridge_sha" ] \
      && [ ! -L "$app_dir/.compose.staging.yml.cutover-$bridge_sha" ] || return 1
  fi
  if [ "$cutover_marker_temp_present" -eq 1 ]; then
    [ "$(run_bounded "$COMMAND_SECONDS" node "$runtime_authority_tool" \
      capture-cutover-marker-prefix "$cutover_marker_temporary" "$bridge_sha")" \
      = "$cutover_marker_temp_authority" ] || return 1
  else
    [ "$(run_bounded "$COMMAND_SECONDS" node "$runtime_authority_tool" \
      capture-cutover-marker-prefix "$cutover_marker_temporary" "$bridge_sha")" \
      = "$cutover_marker_temp_authority" ] || return 1
  fi
  if [ "$legacy_store_existed" -eq 1 ]; then
    [ "$(protected_identity_record "$release_store")" = "$legacy_store_identity" ] || return 1
    [ "$(capture_cutover_store_snapshot)" = "$legacy_store_snapshot" ] || return 1
  else
    [ ! -e "$release_store" ] && [ ! -L "$release_store" ] || return 1
  fi
  verify_cutover_staged_authorities || return 1
  case "$cutover_tree_state:$cutover_compose_temp_present:$cutover_marker_temp_present" in
    legacy:0:0) verify_legacy_tree_proof ;;
    bridge:0:0) run_tree_verify "$frozen_archive" "$app_dir" ;;
    legacy:1:*|bridge:1:*|legacy:*:1|bridge:*:1) [ "$cutover_journal_present" -eq 1 ] ;;
    *) return 1 ;;
  esac
}

verify_cutover_mode_boundary() {
  if [ "$cutover_journal_present" -eq 0 ]; then
    if [ "$cutover_state" = legacy ]; then
      [ "$legacy_root_mode" = "$expected_legacy_app_mode" ] \
        && [ "$legacy_marker_mode" = "$expected_legacy_marker_mode" ] \
        && [ "$legacy_compose_mode" = "$expected_legacy_compose_mode" ] || {
          echo 'Unjournaled legacy modes do not match the operator-approved tuple' >&2
          return 1
        }
      return 0
    fi
    [ "$cutover_state" = committed ] \
      && [ "$legacy_root_mode" = 700 ] \
      && [ "$legacy_marker_mode" = 600 ] \
      && [ "$legacy_compose_mode" = 600 ] || {
        echo 'Journal-free committed bridge modes are not canonical v4 state' >&2
        return 1
      }
    return 0
  fi

  case "$legacy_root_mode" in "$expected_legacy_app_mode"|700) ;; *) return 1 ;; esac
  if [ "$cutover_marker_state" = bridge ]; then
    [ "$legacy_marker_mode" = 600 ] || return 1
  else
    case "$legacy_marker_mode" in "$expected_legacy_marker_mode"|600) ;; *) return 1 ;; esac
  fi
  if [ "$cutover_tree_state" = bridge ]; then
    [ "$legacy_compose_mode" = 600 ] || return 1
  else
    [ "$legacy_compose_mode" = "$expected_legacy_compose_mode" ] || return 1
  fi
}

bootstrap_private_v4_runtime() {
  verify_cutover_host_lock || return 1
  reverify_transaction_marker_identity || return 1
  verify_prebootstrap_authority || {
    echo "Legacy staging authority changed before protected bootstrap" >&2
    return 1
  }
  if [ "$legacy_store_existed" -eq 0 ]; then
    run_bounded "$COMMAND_SECONDS" mkdir -m 700 -- "$release_store" || return 1
    durable_sync_parent "$release_store" || return 1
  fi
  if [ "$(run_bounded "$COMMAND_SECONDS" stat -c '%a' -- "$app_dir")" != 700 ]; then
    run_bounded "$COMMAND_SECONDS" chmod 700 -- "$app_dir" || return 1
    durable_sync_parent "$env_file" || return 1
  fi
  if [ "$(run_bounded "$COMMAND_SECONDS" stat -c '%a' -- "$marker_file")" != 600 ]; then
    run_bounded "$COMMAND_SECONDS" chmod 600 -- "$marker_file" || return 1
    durable_sync_file "$marker_file" || return 1
    durable_sync_parent "$marker_file" || return 1
  fi
  verify_protected_runtime || return 1
  bind_release_runtime_authority
}

replace_live_compose() {
  local expected_sha="$1" temporary authority
  verify_cutover_host_lock || return 1
  reverify_transaction_marker_identity || return 1
  temporary="$app_dir/.compose.staging.yml.cutover-$bridge_sha"
  candidate_compose_temporary="$temporary"
  if [ -e "$temporary" ] || [ -L "$temporary" ]; then
    [ "$cutover_journal_present" -eq 1 ] || return 1
    verify_legacy_file "$temporary" 'cutover Compose temporary' \
      "$cutover_compose_temp_mode" "$MAX_LEGACY_COMPOSE_BYTES" \
      "$cutover_compose_temp_authority" || return 1
  fi
  run_bounded "$ARCHIVE_INSPECT_SECONDS" node "$archive_tool" complete-compose \
    "$frozen_archive" "$temporary" || return 1
  [ "$(sha256_file "$temporary")" = "$expected_sha" ] || return 1
  authority="$(run_bounded "$COMMAND_SECONDS" node "$runtime_authority_tool" capture-file \
    "$temporary" 'cutover Compose temporary' 384 "$MAX_LEGACY_COMPOSE_BYTES")" || return 1
  candidate_compose_authority="$authority"
  verify_cutover_host_lock || return 1
  reverify_transaction_marker_identity || return 1
  verify_legacy_bound_file "$compose_file" compose "$legacy_compose_mode" \
    "$MAX_LEGACY_COMPOSE_BYTES" "$legacy_compose_authority" || return 1
  durable_replace_file "$temporary" "$compose_file" || return 1
  candidate_compose_temporary=''
  candidate_compose_authority=''
  [ "$(sha256_file "$compose_file")" = "$expected_sha" ]
}

reconcile_journaled_compose_temporary() {
  [ "$cutover_compose_temp_present" -eq 1 ] || return 0
  [ "$cutover_journal_present" -eq 1 ] || return 1
  verify_legacy_file "$cutover_compose_path" 'cutover Compose temporary' \
    "$cutover_compose_temp_mode" "$MAX_LEGACY_COMPOSE_BYTES" \
    "$cutover_compose_temp_authority" || return 1
  begin_cutover_transaction || return 1
  # A killed predecessor may have left any prefix of the deterministic temporary.
  # Rebuild that exact journal-owned path from the already-verified bridge and publish
  # it atomically.  Never try to restore bytes kept only in a predecessor's /tmp.
  replace_live_compose "$bridge_compose_sha" || return 1
  cutover_compose_temp_present=0
  cutover_compose_temp_mode=''
  cutover_compose_temp_authority=''
  cutover_tree_state=bridge
  cutover_state=resuming
  compose_replaced=1
  run_tree_verify "$frozen_archive" "$app_dir"
}

verify_committed_cutover_boundary() {
  verify_reservation_free_active_state "$bridge_sha" \
    "$(release_archive_path "$bridge_sha")" "$running_app_image_id" || return 1
  verify_running_pair
}

cleanup_cutover_artifacts() {
  verify_cutover_host_lock || return 1
  reverify_transaction_marker_identity || return 1
  verify_cutover_host_lock || return 1
  reverify_transaction_marker_identity || return 1
}

complete_cutover_transaction() {
  verify_cutover_host_lock || return 1
  reverify_transaction_marker_identity || return 1
  verify_committed_cutover_boundary || return 1
  cleanup_cutover_artifacts || return 1
  verify_committed_cutover_boundary || return 1
  # The deadline must acknowledge DISARM before the cross-process exclusion
  # authority can be retired.  The journal remains exact across every failure.
  stop_deadline_watchdog || return 125
  verify_cutover_host_lock || return 1
  release_cutover_host_lock || return 1
  # fd 8 (launcher maintenance) and fd 9 (release inode) remain held here.
  clear_transaction_marker || return 1
  transaction_marker_created=0
  cutover_journal_present=0
  transaction_cleared=1
  verify_committed_cutover_boundary || return 1
  finalization_done=1
}

cleanup_cutover() {
  local primary_status="$?" final_status settlement_status=0
  trap - EXIT TERM
  final_status="$primary_status"
  set +e
  if [ "$cutover_host_lock_owned" -eq 1 ]; then
    if ! verify_cutover_host_lock; then
      final_status=70
      echo 'Typed staging cutover lock authority changed; no cleanup is safe' >&2
    elif [ "$finalization_done" -eq 0 ] && ! cleanup_cutover_artifacts; then
      final_status=70
    fi
  fi
  if [ "$primary_status" -ne 0 ] && [ "$release_transaction_started" -eq 1 ]; then
    final_status=70
    echo 'Staging cutover remains fail-closed and can only roll forward with the exact same arguments' >&2
  fi
  stop_deadline_watchdog || settlement_status="$?"
  [ "$settlement_status" -eq 0 ] || final_status="$settlement_status"
  exit "$final_status"
}

trap cleanup_cutover EXIT

# Capture and inspect the immutable upload without creating a second unjournaled
# tree.  The only durable copy is created later under the exact cutover journal.
uploaded_archive_authority="$(run_bounded "$COMMAND_SECONDS" node "$bounded_stream_tool" \
  capture-file "$archive" "$MAX_RELEASE_ARCHIVE_BYTES")" || exit 65
uploaded_archive_size="$(authority_field "$uploaded_archive_authority" size)" || exit 65
[[ "$uploaded_archive_size" =~ ^[0-9]+$ ]] \
  && [ "$uploaded_archive_size" -le "$MAX_RELEASE_ARCHIVE_BYTES" ] || exit 65
frozen_archive="$archive"
verify_uploaded_archive_authority || exit 65
archive_record="$(run_bounded "$ARCHIVE_INSPECT_SECONDS" node "$archive_tool" \
  inspect "$archive")" || exit 65
[ "$(authority_field "$archive_record" sha256)" = "$bridge_sha" ] || {
  echo "Bridge release checksum mismatch" >&2
  exit 65
}
read -r candidate_expanded candidate_compressed < <(archive_metrics "$archive") || exit 65
bridge_compose_record="$(run_bounded "$ARCHIVE_INSPECT_SECONDS" node "$archive_tool" \
  emit-compose "$archive" | sha256sum)" || exit 65
bridge_compose_sha="${bridge_compose_record%% *}"
[[ "$bridge_compose_sha" =~ ^[0-9a-f]{64}$ ]] || exit 65
bridge_sidecar_sha="$(printf '%s\n' "$bridge_sha" | sha256sum)"
bridge_sidecar_sha="${bridge_sidecar_sha%% *}"

# Capture the predecessor identities before naming or publishing any journal state.
# Only stable directory identity fields are hashed, so journal-authorized mode and
# child-entry transitions do not weaken crash recovery.
verify_protected_path "$app_dir" directory 'legacy staging root' 1 || exit 67
verify_protected_path "$app_dir/backups" directory 'legacy staging backup root' 1 700 || exit 67
verify_protected_path "$app_dir/rollbacks" directory 'legacy staging rollback root' 1 700 || exit 67
verify_protected_path "$env_file" file 'legacy staging environment' 1 600 || exit 67
verify_protected_path "$lock_file" optional-file 'staging release lock' 1 600 || exit 67
verify_safe_ancestors "$cutover_host_lock_directory" || exit 67
legacy_root_mode="$(run_bounded "$COMMAND_SECONDS" stat -c '%a' -- "$app_dir")" || exit 67
case "$legacy_root_mode" in 700|755) ;; *) echo "Legacy staging root mode is unsafe" >&2; exit 67 ;; esac
legacy_root_identity="$(capture_legacy_root "$app_dir" "$legacy_root_mode")" || exit 67
legacy_backups_identity="$(capture_legacy_root "$app_dir/backups" 700)" || exit 67
legacy_rollbacks_identity="$(capture_legacy_root "$app_dir/rollbacks" 700)" || exit 67
legacy_environment_authority="$(capture_legacy_file "$env_file" \
  'legacy staging environment' 600 4194304)" || exit 67
capture_running_pair || exit 67
legacy_authority_sha="$(run_bounded "$COMMAND_SECONDS" node "$runtime_authority_tool" \
  derive-cutover-legacy-authority "$app_dir" "$legacy_root_identity" \
  "$legacy_backups_identity" "$legacy_rollbacks_identity" \
  "$legacy_environment_authority" "$running_app_container" \
  "$running_app_image_id" "$postgres_runtime_authority")" || exit 67
[[ "$legacy_authority_sha" =~ ^[0-9a-f]{64}$ ]] || exit 67
expected_cutover_journal_nonce="$(derive_cutover_journal_nonce)" || exit 69
[[ "$expected_cutover_journal_nonce" =~ ^[0-9a-f]{64}$ ]] || exit 69
cutover_journal_temporary="$app_dir/.staging-recovery-required.cutover-$expected_cutover_journal_nonce.preparing"
cutover_marker_temporary="$app_dir/.release-sha256.cutover-$expected_cutover_journal_nonce.preparing"
cutover_staged_archive="$app_dir/backups/.staging-cutover-$expected_cutover_journal_nonce.release.tar.gz"
cutover_staged_sidecar="$app_dir/backups/.staging-cutover-$expected_cutover_journal_nonce.release.tar.gz.sha256"

verify_cutover_journal_namespace || {
  echo 'Cutover journal preparing namespace has a foreign or ambiguous binding' >&2
  exit 70
}
reconcile_cutover_journal_temporary || {
  echo 'Cutover journal deterministic temporary could not be reconciled' >&2
  exit 70
}
if [ -e "$recovery_marker" ] || [ -L "$recovery_marker" ]; then
  verify_protected_path "$recovery_marker" file 'staging cutover journal' 1 600 || exit 70
  cutover_journal_nonce="$(read_cutover_journal_nonce)" || {
    echo "Staging is fail-closed under a different recovery authority" >&2
    exit 70
  }
  cutover_journal_present=1
  transaction_marker_created=1
  [ "$cutover_journal_nonce" = "$expected_cutover_journal_nonce" ] || exit 70
  capture_transaction_marker_identity || exit 70
fi
if [ "$cutover_journal_present" -eq 1 ] \
  && { [ -e "$cutover_journal_temporary" ] || [ -L "$cutover_journal_temporary" ]; }; then
  echo 'Committed cutover journal and its preparing path cannot coexist' >&2
  exit 70
fi
cutover_marker_temp_authority="$(run_bounded "$COMMAND_SECONDS" node \
  "$runtime_authority_tool" capture-cutover-marker-prefix \
  "$cutover_marker_temporary" "$bridge_sha")" || exit 70
if [ -e "$cutover_marker_temporary" ] || [ -L "$cutover_marker_temporary" ]; then
  [ "$cutover_journal_present" -eq 1 ] || {
    echo 'Unjournaled cutover active-marker temporary is present' >&2
    exit 70
  }
  cutover_marker_temp_present=1
fi
capture_cutover_staged_authorities || {
  echo 'Foreign or changed journal-owned cutover staging state is present' >&2
  exit 70
}
legacy_marker_mode="$(run_bounded "$COMMAND_SECONDS" stat -c '%a' -- "$marker_file")" || exit 67
case "$legacy_marker_mode" in 600|644) ;; *) echo "Legacy active marker mode is unsafe" >&2; exit 67 ;; esac
legacy_compose_mode="$(run_bounded "$COMMAND_SECONDS" stat -c '%a' -- "$compose_file")" || exit 67
case "$legacy_compose_mode" in 600|644|664) ;; *) echo "Legacy Compose mode is unsafe" >&2; exit 67 ;; esac
legacy_marker_authority="$(capture_legacy_bound_file "$marker_file" marker \
  "$legacy_marker_mode" 65)" || exit 67
legacy_compose_authority="$(capture_legacy_bound_file "$compose_file" compose \
  "$legacy_compose_mode" "$MAX_LEGACY_COMPOSE_BYTES")" || exit 67
cutover_compose_path="$app_dir/.compose.staging.yml.cutover-$bridge_sha"
if [ -e "$cutover_compose_path" ] || [ -L "$cutover_compose_path" ]; then
  [ "$cutover_journal_present" -eq 1 ] || {
    echo "Unjournaled cutover Compose temporary is present" >&2
    exit 70
  }
  verify_protected_path "$cutover_compose_path" file 'cutover Compose temporary' 1 || exit 70
  cutover_compose_temp_mode="$(run_bounded "$COMMAND_SECONDS" stat -c '%a' -- \
    "$cutover_compose_path")" || exit 70
  case "$cutover_compose_temp_mode" in 600|644) ;; *) exit 70 ;; esac
  cutover_compose_temp_authority="$(capture_legacy_file "$cutover_compose_path" \
    'cutover Compose temporary' "$cutover_compose_temp_mode" \
    "$MAX_LEGACY_COMPOSE_BYTES")" || exit 70
  cutover_compose_temp_present=1
fi
[ "$(authority_field "$legacy_marker_authority" size)" = 65 ] || exit 67
expected_marker_bytes_sha="$(printf '%s\n' "$legacy_marker_sha" | sha256sum)"
expected_marker_bytes_sha="${expected_marker_bytes_sha%% *}"
bridge_marker_bytes_sha="$(printf '%s\n' "$bridge_sha" | sha256sum)"
bridge_marker_bytes_sha="${bridge_marker_bytes_sha%% *}"
case "$(authority_field "$legacy_marker_authority" sha256)" in
  "$expected_marker_bytes_sha") cutover_marker_state=legacy ;;
  "$bridge_marker_bytes_sha") cutover_marker_state=bridge ;;
  *) echo "Active marker is neither the approved legacy state nor the bridge" >&2; exit 67 ;;
esac
[ "$cutover_marker_state" != bridge ] || [ "$cutover_marker_temp_present" -eq 0 ] || {
  echo 'A committed bridge marker cannot coexist with its preparing path' >&2
  exit 70
}
case "$(authority_field "$legacy_compose_authority" sha256)" in
  "$legacy_compose_sha") cutover_tree_state=legacy ;;
  "$bridge_compose_sha") cutover_tree_state=bridge ;;
  *) echo "Live Compose is neither the approved legacy state nor the bridge" >&2; exit 67 ;;
esac
[ "$cutover_tree_state" != bridge ] || [ "$cutover_compose_temp_present" -eq 0 ] || {
  echo 'A committed bridge Compose cannot coexist with its preparing path' >&2
  exit 70
}
if [ -e "$release_store" ] || [ -L "$release_store" ]; then
  verify_protected_path "$release_store" directory 'legacy staging release store' 1 700 || exit 67
  legacy_store_existed=1
  legacy_store_identity="$(protected_identity_record "$release_store")" || exit 67
  legacy_store_snapshot="$(capture_cutover_store_snapshot)" || exit 67
fi
pair_presence='0:0'
[ "$legacy_store_existed" -eq 0 ] || pair_presence="$(cutover_pair_presence)" || exit 67
case "$cutover_marker_state:$cutover_tree_state:$pair_presence" in
  legacy:legacy:0:0) cutover_state=legacy ;;
  legacy:bridge:0:0|legacy:bridge:1:0|legacy:bridge:1:1)
    [ "$cutover_journal_present" -eq 1 ] || {
      echo "Partial cutover state has no matching durable journal" >&2
      exit 70
    }
    cutover_state=resuming ;;
  bridge:bridge:1:1) cutover_state=committed ;;
  *) echo "Staging state is not an exact cutover boundary" >&2; exit 70 ;;
esac
if [ "$cutover_state" = legacy ] && [ "$cutover_journal_present" -eq 1 ]; then
  cutover_state=resuming
fi
verify_cutover_mode_boundary || exit 67
if [ "$cutover_state" = committed ] && [ "$cutover_journal_present" -eq 0 ]; then
  [ "$(run_bounded "$COMMAND_SECONDS" stat -c '%a' -- "$app_dir")" = 700 ] \
    && [ "$legacy_marker_mode" = 600 ] && [ "$legacy_compose_mode" = 600 ] \
    && [ "$legacy_store_existed" -eq 1 ] || {
      echo "Committed bridge has non-v4 runtime permissions" >&2
      exit 67
    }
fi
if [ "$cutover_compose_temp_present" -eq 0 ] \
  && [ "$cutover_marker_temp_present" -eq 0 ]; then
  case "$cutover_tree_state" in
    legacy) verify_legacy_tree_proof || exit 67 ;;
    bridge) run_tree_verify "$frozen_archive" "$app_dir" || exit 67 ;;
  esac
fi

# Prove every application, PostgreSQL, image and readiness precondition while the
# legacy filesystem is still byte- and metadata-identical.  A rejected bridge must
# not leave behind the v4 store or permission normalization.
validate_staging_compose_archive_contract "$archive" || exit 65
verify_running_pair || exit 67
capture_stable_cutover_state || exit 67
wait_for_prebootstrap_readiness || exit 67
verify_running_pair || exit 67
# A fully committed, journal-free bridge is read-only idempotency.  The launcher keeps fd 8,
# and the ordinary release inode keeps fd 9; never recreate a typed cutover lock or journal.
if [ "$cutover_state" = committed ] && [ "$cutover_journal_present" -eq 0 ]; then
  acquire_release_lock_inode \
    || { status="$?"; [ "$status" -eq 75 ] && exit 75; exit 67; }
  verify_prebootstrap_authority || exit 67
  verify_protected_runtime || exit 67
  bind_release_runtime_authority || exit 67
  verify_committed_cutover_boundary || exit 67
  finalization_done=1
  port="$(app_port)"
  echo "staging_cutover_sha256=$bridge_sha"
  echo "staging_ready=http://127.0.0.1:$port/health/ready"
  exit 0
fi

# The exact durable journal is the first staging-root mutation.  Only that journal can
# authorize creation or dead-owner adoption of the typed cross-process host lock.
begin_cutover_transaction || exit 70
acquire_cutover_host_lock \
  || { status="$?"; [ "$status" -eq 75 ] && exit 75; exit 70; }
verify_cutover_host_lock || exit 70
acquire_release_lock_inode \
  || { status="$?"; [ "$status" -eq 75 ] && exit 75; exit 67; }
verify_cutover_host_lock || exit 70
verify_prebootstrap_authority || {
  echo "Legacy staging authority changed while acquiring cutover locks" >&2
  exit 67
}
validate_staging_compose_archive_contract "$archive" || exit 65
verify_running_pair || exit 67
verify_stable_cutover_state || exit 67
wait_for_prebootstrap_readiness || exit 67
bootstrap_private_v4_runtime || exit 67
prepare_cutover_frozen_archive || exit 70
validate_staging_compose_archive_contract "$frozen_archive" || exit 70

reconcile_journaled_compose_temporary || {
  echo "Journal-owned cutover Compose temporary could not be reconciled" >&2
  exit 70
}
wait_for_readiness || exit 67
verify_running_pair || exit 67
verify_stable_cutover_state || exit 67

if [ "$cutover_state" = committed ]; then
  if [ "$cutover_journal_present" -eq 1 ]; then
    begin_cutover_transaction || exit 70
    ensure_bridge_release_pair || exit 70
  fi
  validate_release_store allow-change || exit 67
  verify_release_pair "$bridge_sha" 'already adopted bridge' || exit 67
  verify_active_snapshot "$bridge_sha" "$(release_archive_path "$bridge_sha")" \
    "$running_app_image_id" || exit 67
  verify_running_pair || exit 67
  commit_verified=1
  complete_cutover_transaction || { status="$?"; [ "$status" -eq 125 ] && exit 125; exit 70; }
  echo "staging_cutover_sha256=$bridge_sha"
  exit 0
fi

if [ "$cutover_tree_state" = legacy ]; then
  verify_legacy_tree_proof || exit 67
  [ "$(read_exact_sha_marker "$marker_file" 'legacy active release marker')" \
    = "$legacy_marker_sha" ] || exit 67
else
  [ "$cutover_journal_present" -eq 1 ] || exit 70
fi
verify_running_pair || exit 67
wait_for_readiness || exit 67

begin_cutover_transaction || exit 70
if [ "$stable_preexisted" -eq 0 ]; then
  verify_cutover_host_lock || exit 70
  reverify_transaction_marker_identity || exit 70
  stable_promotion_attempted=1
  run_bounded "$COMMAND_SECONDS" docker image tag "$running_app_image_id" "$STABLE_IMAGE"
  verify_stable_image "$running_app_image_id" || exit 70
  stable_tag_created=1
fi
if [ "$cutover_tree_state" = legacy ]; then
  replace_live_compose "$bridge_compose_sha" || exit 70
  compose_replaced=1
else
  [ "$cutover_compose_temp_present" -eq 0 ] || exit 70
fi
run_tree_verify "$frozen_archive" "$app_dir" || exit 70
verify_running_pair || exit 70
wait_for_readiness || exit 70
ensure_bridge_release_pair || exit 70
current_marker="$(read_exact_sha_marker "$marker_file" 'cutover active release marker')" || exit 70
if [ "$current_marker" = "$legacy_marker_sha" ]; then
  marker_promotion_attempted=1
  publish_cutover_active_marker || exit 70
elif [ "$current_marker" != "$bridge_sha" ]; then
  exit 70
fi
[ "$(read_exact_sha_marker "$marker_file" 'published bridge marker')" = "$bridge_sha" ] || exit 70
verify_active_snapshot "$bridge_sha" "$(release_archive_path "$bridge_sha")" \
  "$running_app_image_id" || exit 70
verify_running_pair || exit 70
commit_verified=1
complete_cutover_transaction \
  || { status="$?"; [ "$status" -eq 125 ] && exit 125; exit 70; }
port="$(app_port)"
echo "staging_cutover_sha256=$bridge_sha"
echo "staging_ready=http://127.0.0.1:$port/health/ready"
