#!/bin/bash
set -Eeuo pipefail
umask 077
unset EASYBOOST_STAGING_BUILD_CONTEXT

if [ "$#" -ne 1 ] || [[ ! "$1" =~ ^[0-9a-f]{64}$ ]]; then
  echo "Usage: $0 BUNDLE_SHA256" >&2
  exit 64
fi

entry_source="${BASH_SOURCE[0]}"
case "$entry_source" in /*) ;; *) echo "staging restart helper path must be absolute" >&2; exit 69 ;; esac
source "${entry_source%/*}/staging-release-common.sh"
trap 'exit 124' TERM
begin_transaction_deadline
trap stop_early_deadline EXIT
command -v node >/dev/null 2>&1 || { echo "Node.js is required" >&2; exit 69; }
verify_helper_bundle "$1" || exit 69

app_dir="${STAGING_APP_DIR:-/opt/easyboost-staging}"
case "$app_dir" in /*) app_dir="${app_dir%/}" ;; *) echo "Staging app directory must be absolute" >&2; exit 65 ;; esac
case "$app_dir" in /|/opt) echo "Unsafe staging app directory" >&2; exit 65 ;; esac
env_file="$app_dir/.env.staging"
compose_file="$app_dir/compose.staging.yml"
release_store="$app_dir/rollbacks/releases"
lock_file="$app_dir/.staging-release.lock"
recovery_marker="$app_dir/.staging-recovery-required"

command -v flock >/dev/null 2>&1 || { echo "flock is required" >&2; exit 69; }
command -v timeout >/dev/null 2>&1 || { echo "GNU timeout is required" >&2; exit 69; }
verify_protected_runtime || exit 67
acquire_release_lock || { status="$?"; [ "$status" -eq 75 ] && exit 75; exit 67; }
acquire_host_operation_lock staging-release \
  || { status="$?"; [ "$status" -eq 75 ] && exit 75; exit 67; }

release_early_host_operation_lock() {
  local status="$?" settlement_status=0
  trap - EXIT TERM
  settle_deadline_watchdog_and_release_host_lock "$status" \
    'staging restart deadline watchdog settlement was not proven' \
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

active_sha="$(read_exact_sha_marker "$app_dir/.release-sha256" 'active release marker')" || exit 67
validate_release_store || exit 67
verify_release_pair "$active_sha" 'active' || exit 67
active_archive="$(release_archive_path "$active_sha")"
active_image_id="$(image_id "$STABLE_IMAGE")" || {
  echo "Active staging image identity is unavailable" >&2
  exit 67
}
require_local_dependency_images || exit 67
capture_running_postgres_authority || {
  echo "Active staging PostgreSQL runtime is not an exact healthy authority" >&2
  exit 67
}
verify_active_snapshot "$active_sha" "$active_archive" "$active_image_id" || {
  echo "Active staging release is not a verified restart authority" >&2
  exit 67
}

restart_started=0
restart_verified=0
transaction_marker_created=0

cleanup_restart() {
  local primary_status="$?" final_status recovery_status=0 settlement_status=0
  trap - EXIT TERM
  final_status="$primary_status"
  set +e
  if [ "$primary_status" -ne 0 ] && [ "$restart_started" -eq 1 ] \
    && [ "$restart_verified" -eq 0 ]; then
    write_recovery_marker 'staging app environment restart readiness was not proven' \
      "$primary_status" 1
    recovery_status="$?"
    [ "$recovery_status" -eq 0 ] || {
      echo 'Restart recovery marker could not be persisted' >&2
      final_status=70
    }
  fi
  settle_deadline_watchdog_and_release_host_lock "$primary_status" \
    'staging restart deadline watchdog settlement was not proven' \
    || settlement_status="$?"
  [ "$settlement_status" -eq 0 ] || final_status="$settlement_status"
  exit "$final_status"
}
trap cleanup_restart EXIT

begin_release_transaction || exit 70
restart_started=1
reverify_compose_authority || exit 70
verify_stable_image "$active_image_id" || exit 70
verify_running_postgres_authority || exit 70
run_bounded "$COMMAND_SECONDS" docker compose -f "$compose_file" --env-file "$env_file" \
  up --pull never -d --no-build --no-deps app
verify_stable_image "$active_image_id" || exit 70
verify_running_image "$active_image_id" || exit 70
verify_running_postgres_authority || exit 70
wait_for_readiness || {
  reverify_compose_authority || exit 70
  run_bounded "$COMMAND_SECONDS" docker compose -f "$compose_file" \
    --env-file "$env_file" logs --tail=100 app >&2
  exit 1
}
verify_running_postgres_authority || exit 70
run_tree_verify "$active_archive" "$app_dir" || exit 70
reverify_compose_authority || exit 70
[ "$(read_exact_sha_marker "$app_dir/.release-sha256" 'active release marker')" = "$active_sha" ] \
  || exit 70
clear_transaction_marker || exit 70
transaction_marker_created=0
restart_verified=1
port="$(app_port)"
echo "staging_release_sha256=$active_sha"
echo "staging_ready=http://127.0.0.1:$port/health/ready"
