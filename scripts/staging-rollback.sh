#!/bin/bash
set -Eeuo pipefail
umask 077
unset EASYBOOST_STAGING_BUILD_CONTEXT

ENTRY_PROTOCOL='immutable-archive-v4'

if [ "$#" -ne 3 ] || [ "$2" != "$ENTRY_PROTOCOL" ] \
  || [[ ! "$3" =~ ^[0-9a-f]{64}$ ]]; then
  echo "Usage: $0 EXACT_RELEASE_SHA256 $ENTRY_PROTOCOL BUNDLE_SHA256" >&2
  exit 64
fi
entry_source="${BASH_SOURCE[0]}"
case "$entry_source" in /*) ;; *) echo "staging rollback helper path must be absolute" >&2; exit 69 ;; esac
source "${entry_source%/*}/staging-release-common.sh"
[ "$PROTOCOL" = "$ENTRY_PROTOCOL" ] || {
  echo "staging rollback helper protocol mismatch" >&2
  exit 69
}
expected_bundle_digest="$3"
trap 'exit 124' TERM
begin_transaction_deadline
trap stop_early_deadline EXIT
command -v node >/dev/null 2>&1 || { echo "Node.js is required" >&2; exit 69; }
verify_helper_bundle "$expected_bundle_digest" || exit 69
target_sha="${1,,}"
if [[ ! "$target_sha" =~ ^[0-9a-f]{64}$ ]]; then
  echo "Rollback identity must be a full SHA-256" >&2
  exit 64
fi

app_dir="${STAGING_APP_DIR:-/opt/easyboost-staging}"
case "$app_dir" in /*) app_dir="${app_dir%/}" ;; *) echo "Staging app directory must be absolute" >&2; exit 65 ;; esac
case "$app_dir" in /|/opt) echo "Unsafe staging app directory" >&2; exit 65 ;; esac
env_file="$app_dir/.env.staging"
compose_file="$app_dir/compose.staging.yml"
release_store="$app_dir/rollbacks/releases"
lock_file="$app_dir/.staging-release.lock"
recovery_marker="$app_dir/.staging-recovery-required"
release_image="easyboost-staging-app:release-$target_sha"

command -v flock >/dev/null 2>&1 || { echo "flock is required" >&2; exit 69; }
command -v timeout >/dev/null 2>&1 || { echo "GNU timeout is required" >&2; exit 69; }
command -v fallocate >/dev/null 2>&1 || { echo "fallocate is required" >&2; exit 69; }
command -v truncate >/dev/null 2>&1 || { echo "truncate is required" >&2; exit 69; }
verify_protected_runtime || exit 67
acquire_release_lock || { status="$?"; [ "$status" -eq 75 ] && exit 75; exit 67; }
acquire_host_operation_lock staging-release \
  || { status="$?"; [ "$status" -eq 75 ] && exit 75; exit 67; }

release_early_host_operation_lock() {
  local status="$?" settlement_status=0
  trap - EXIT TERM
  settle_deadline_watchdog_and_release_host_lock "$status" \
    'staging rollback deadline watchdog settlement was not proven' \
    || settlement_status="$?"
  [ "$settlement_status" -eq 0 ] || status="$settlement_status"
  exit "$status"
}
trap release_early_host_operation_lock EXIT
if [ -e "$recovery_marker" ]; then
  echo "Staging is fail-closed pending verified manual recovery" >&2
  exit 70
fi
for required in "$env_file" "$compose_file" "$app_dir/.release-sha256"; do
  [ -f "$required" ] || { echo "Active staging release metadata is incomplete" >&2; exit 67; }
done

previous_sha="$(read_exact_sha_marker \
  "$app_dir/.release-sha256" 'active release marker')" || exit 67
if [ "$target_sha" = "$previous_sha" ]; then
  echo "Rollback target is already active" >&2
  exit 65
fi

image_build_attempted=0
candidate_image_id=''
stable_promotion_attempted=0
tree_mutated=0
activation_succeeded=0
commit_verified=0
transaction_cleared=0
postcommit_step=''
active_release=1
previous_image_id=''
recovery_step='not started'
transaction_marker_created=0
candidate_expanded=0
candidate_compressed=0
previous_expanded=0
previous_compressed=0
candidate_pair_existed=1
release_finalization_step=''
release_finalization_verified=0

verify_rollback_cleanup_boundary() { return 0; }

verify_committed_rollback_boundary() {
  verify_reservation_free_active_state "$target_sha" \
    "$(release_archive_path "$target_sha")" "$candidate_image_id"
}

verify_recovered_rollback_boundary() {
  verify_reservation_free_active_state "$previous_sha" \
    "$(release_archive_path "$previous_sha")" "$previous_image_id"
}

cleanup() {
  local primary_status="$?" final_status recovery_failed=0 recovery_status=0 cleanup_step=''
  local runtime_recovered=0 recovery_verified=0 proof_hook proof_step settlement_status=0
  trap - EXIT TERM
  final_status="$primary_status"
  record_cleanup_failure() { [ -n "$cleanup_step" ] || cleanup_step="$1"; }
  set +e
  if [ "$primary_status" -ne 0 ]; then
    begin_recovery_deadline
    recovery_status="$?"
    if [ "$recovery_status" -ne 0 ]; then
      cleanup_step='staging recovery deadline watchdog could not be established'
      if ! write_recovery_marker "$cleanup_step" "$primary_status" 125; then
        echo 'Recovery-required marker could not be persisted after recovery watchdog startup failure' >&2
      fi
      echo 'Staging recovery and finalization blocked because their deadline watchdog is unavailable' >&2
      exit 125
    fi
  fi
  if [ "$primary_status" -ne 0 ] && [ "$authority_violation" -eq 1 ]; then
    final_status=70
    recovery_failed=1
    cleanup_step='protected staging authority changed during rollback'
    if ! write_recovery_marker "$cleanup_step" "$primary_status" 1; then
      echo "Recovery-required marker could not be persisted after authority drift" >&2
    fi
    echo "Protected staging authority changed; automatic recovery is unsafe" >&2
  elif [ "$primary_status" -ne 0 ] && [ "$activation_succeeded" -eq 0 ] \
    && [ "$stable_promotion_attempted" -eq 1 ]; then
    recover_previous_release
    recovery_status="$?"
    if [ "$recovery_status" -ne 0 ]; then
      recovery_failed=1
      final_status=70
      record_cleanup_failure "$recovery_step"
      echo "Primary staging rollback failed with status $primary_status; recovery failed at: $recovery_step" >&2
    else
      runtime_recovered=1
    fi
  elif [ "$primary_status" -ne 0 ] && [ "$commit_verified" -eq 1 ]; then
    final_status=70
    recovery_failed=1
    record_cleanup_failure "${postcommit_step:-clear committed rollback transaction marker}"
    write_recovery_marker "$cleanup_step" "$primary_status" 1
    echo "Rollback candidate committed but transaction cleanup failed; state remains fail-closed" >&2
  elif [ "$primary_status" -ne 0 ]; then
    echo "Staging rollback failed before active-state mutation (status $primary_status)" >&2
  fi
  proof_hook=verify_rollback_cleanup_boundary
  proof_step='verify completed rollback cleanup boundary'
  if [ "$runtime_recovered" -eq 1 ]; then
    proof_hook=verify_recovered_rollback_boundary
    proof_step='verify final restored rollback release state'
  elif [ "$commit_verified" -eq 1 ]; then
    proof_hook=verify_committed_rollback_boundary
    proof_step='verify final committed rollback release state'
  fi
  release_finalization_step="$cleanup_step"
  if ! finalize_release_boundaries \
    'remove temporary rollback image' \
    'release rollback disk reservations' \
    'remove private rollback work directory' \
    'remove completed rollback recovery transaction marker' \
    "$proof_step" "$proof_hook"; then
    record_cleanup_failure "$release_finalization_step"
    final_status=70
    recovery_failed=1
  elif [ "$runtime_recovered" -eq 1 ] && [ "$release_finalization_verified" -eq 1 ]; then
    recovery_verified=1
  fi
  if [ "$recovery_failed" -eq 0 ] && [ "$recovery_verified" -eq 1 ]; then
    echo "Primary staging rollback failed with status $primary_status; verified prior state restored" >&2
  fi
  if [ "$recovery_failed" -eq 1 ] && [ -n "$cleanup_step" ]; then
    write_recovery_marker "$cleanup_step" "$primary_status" 1 || \
      echo "Recovery-required marker could not be persisted" >&2
  fi
  if [ "$recovery_failed" -eq 1 ]; then
    echo "Staging remains fail-closed; inspect $recovery_marker" >&2
  fi
  settle_deadline_watchdog_and_release_host_lock "$primary_status" \
    'staging rollback deadline watchdog settlement was not proven' \
    || settlement_status="$?"
  [ "$settlement_status" -eq 0 ] || final_status="$settlement_status"
  exit "$final_status"
}
trap cleanup EXIT

create_release_workspace rollback || exit 67
previous_archive="$work_dir/previous.tar.gz"
previous_tree="$work_dir/previous"
frozen_archive="$work_dir/target.tar.gz"
release_dir="$work_dir/target"

validate_release_store || exit 67
verify_release_pair "$previous_sha" 'active' || exit 67
verify_release_pair "$target_sha" 'target' || exit 65
previous_image_id="$(image_id "$STABLE_IMAGE")" || {
  echo "Active staging image cannot be restored" >&2
  exit 67
}
[ -n "$previous_image_id" ] || { echo "Active staging image cannot be restored" >&2; exit 67; }

run_workspace_bounded "$COMMAND_SECONDS" cp --reflink=never -- \
  "$(release_archive_path "$previous_sha")" "$previous_archive"
run_workspace_bounded "$COMMAND_SECONDS" chmod 400 "$previous_archive"
[ "$(sha256_file "$previous_archive")" = "$previous_sha" ] \
  || { echo "Active retained archive changed while freezing" >&2; exit 67; }
read -r previous_expanded previous_compressed < <(archive_metrics "$previous_archive") \
  || { echo "Active archive metrics are unavailable" >&2; exit 67; }
run_tree_verify "$previous_archive" "$app_dir" || {
  echo "Active code tree does not match its retained archive" >&2
  exit 67
}
validate_staging_compose_contract "$compose_file" || exit 67
require_local_dependency_images || exit 67
capture_running_postgres_authority || {
  echo "Active staging PostgreSQL runtime is not an exact healthy authority" >&2
  exit 67
}
verify_active_snapshot "$previous_sha" "$previous_archive" "$previous_image_id" || {
  echo "Active predecessor snapshot could not be verified" >&2
  exit 67
}

run_workspace_bounded "$COMMAND_SECONDS" cp --reflink=never -- \
  "$(release_archive_path "$target_sha")" "$frozen_archive"
run_workspace_bounded "$COMMAND_SECONDS" chmod 400 "$frozen_archive"
[ "$(sha256_file "$frozen_archive")" = "$target_sha" ] \
  || { echo "Target retained archive changed while freezing" >&2; exit 65; }
run_archive_inspect "$frozen_archive" || exit 65
read -r candidate_expanded candidate_compressed < <(archive_metrics "$frozen_archive") \
  || { echo "Rollback archive metrics are unavailable" >&2; exit 65; }
reserve_release_space "$candidate_expanded" "$previous_expanded" \
  "$candidate_compressed" "$previous_compressed" 0 || exit 68
consume_reservation "$temporary_reservation_file" "$previous_expanded" || exit 68
run_workspace_bounded "$COMMAND_SECONDS" mkdir -m 700 "$previous_tree"
run_archive_extract "$previous_archive" "$previous_tree" || exit 67
run_tree_verify "$previous_archive" "$previous_tree" || exit 67
consume_reservation "$temporary_reservation_file" "$candidate_expanded" || exit 68
run_workspace_bounded "$COMMAND_SECONDS" mkdir -m 700 "$release_dir"
run_archive_extract "$frozen_archive" "$release_dir" || exit 65
for required in .dockerignore Dockerfile compose.staging.yml; do
  [ -f "$release_dir/$required" ] || { echo "unsafe release archive: missing $required" >&2; exit 65; }
done
validate_staging_compose_contract "$release_dir/compose.staging.yml" || exit 65
require_local_dependency_images || exit 65
run_tree_verify "$frozen_archive" "$release_dir" || exit 65
run_workspace_bounded "$COMMAND_SECONDS" chmod -R a-w "$release_dir"
verify_space_reservations || exit 68
image_is_absent "$release_image" || {
  echo "Temporary rollback image reference is not authoritatively absent" >&2
  exit 70
}

begin_release_transaction
image_build_attempted=1
run_bounded "$IMAGE_BUILD_SECONDS" docker build --file Dockerfile \
  --tag "$release_image" - < "$frozen_archive"
candidate_image_id="$(image_id "$release_image")"
[ -n "$candidate_image_id" ] || { echo "Rollback image identity is unavailable" >&2; exit 70; }
[ "$(sha256_file "$frozen_archive")" = "$target_sha" ] \
  || { echo "Frozen rollback archive changed during image build" >&2; exit 65; }
verify_active_snapshot "$previous_sha" "$previous_archive" "$previous_image_id" || {
  echo "Active predecessor changed before rollback promotion" >&2
  exit 67
}
verify_running_postgres_authority || exit 67
verify_space_reservations || exit 68

stable_promotion_attempted=1
run_bounded "$COMMAND_SECONDS" docker image tag "$release_image" "$STABLE_IMAGE"
verify_stable_image "$candidate_image_id"

prepare_release_tree_for_copy "$release_dir"
run_tree_verify "$frozen_archive" "$release_dir"
tree_mutated=1
consume_reservation "$live_reservation_file" "$candidate_expanded" || exit 68
clear_release_tree
run_workspace_bounded "$COMMAND_SECONDS" cp -a "$release_dir"/. "$app_dir"/
compose_file="$app_dir/compose.staging.yml"
run_tree_verify "$frozen_archive" "$app_dir"
validate_staging_compose_contract "$compose_file"
verify_running_postgres_authority
reverify_compose_authority
run_bounded "$COMMAND_SECONDS" docker compose -f "$compose_file" --env-file "$env_file" \
  up --pull never -d --no-build --no-deps app
verify_running_image "$candidate_image_id"
verify_running_postgres_authority
wait_for_readiness || {
  reverify_compose_authority || exit 70
  run_bounded "$COMMAND_SECONDS" docker compose -f "$compose_file" \
    --env-file "$env_file" logs --tail=100 app >&2
  exit 1
}
verify_running_postgres_authority
run_tree_verify "$frozen_archive" "$app_dir"
port="$(app_port)"
reverify_compose_authority
run_bounded "$COMMAND_SECONDS" docker compose -f "$compose_file" --env-file "$env_file" ps
publish_active_marker "$target_sha"
published_sha="$(read_exact_sha_marker "$app_dir/.release-sha256" 'published rollback marker')"
[ "$published_sha" = "$target_sha" ] || exit 70
commit_verified=1
activation_succeeded=1
release_finalization_step=''
postcommit_step='finalize committed rollback release boundaries'
if ! finalize_release_boundaries \
  'remove temporary rollback image' \
  'release rollback disk reservations' \
  'remove private rollback work directory' \
  'clear committed rollback transaction marker' \
  'verify final committed rollback release state' \
  verify_committed_rollback_boundary; then
  postcommit_step="$release_finalization_step"
  exit 70
fi
[ "$release_finalization_verified" -eq 1 ] || exit 70
postcommit_step=''
echo "rollback_release_sha256=$target_sha"
echo "staging_ready=http://127.0.0.1:$port/health/ready"
