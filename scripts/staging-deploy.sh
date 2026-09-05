#!/bin/bash
set -Eeuo pipefail
umask 077
unset EASYBOOST_STAGING_BUILD_CONTEXT

ENTRY_PROTOCOL='immutable-archive-v4'
MAX_RELEASE_ARCHIVE_BYTES=$((256 * 1024 * 1024))

if [ "$#" -ne 4 ] || [ "$3" != "$ENTRY_PROTOCOL" ] \
  || [[ ! "$4" =~ ^[0-9a-f]{64}$ ]]; then
  echo "Usage: $0 RELEASE_ARCHIVE EXPECTED_SHA256 $ENTRY_PROTOCOL BUNDLE_SHA256" >&2
  exit 64
fi

entry_source="${BASH_SOURCE[0]}"
case "$entry_source" in /*) ;; *) echo "staging deploy helper path must be absolute" >&2; exit 69 ;; esac
source "${entry_source%/*}/staging-release-common.sh"
[ "$PROTOCOL" = "$ENTRY_PROTOCOL" ] || {
  echo "staging deploy helper protocol mismatch" >&2
  exit 69
}
expected_bundle_digest="$4"
trap 'exit 124' TERM
begin_transaction_deadline
trap stop_early_deadline EXIT
command -v node >/dev/null 2>&1 || { echo "Node.js is required" >&2; exit 69; }
verify_helper_bundle "$expected_bundle_digest" || exit 69

expected_sha="${2,,}"
if [[ ! "$expected_sha" =~ ^[0-9a-f]{64}$ ]]; then
  echo "Release checksum must be a full SHA-256" >&2
  exit 64
fi

archive="$1"
app_dir="${STAGING_APP_DIR:-/opt/easyboost-staging}"
case "$archive" in /*) ;; *) archive="$(pwd -P)/$archive" ;; esac
case "$app_dir" in /*) app_dir="${app_dir%/}" ;; *) echo "Staging app directory must be absolute" >&2; exit 65 ;; esac
case "$app_dir" in /|/opt) echo "Unsafe staging app directory" >&2; exit 65 ;; esac

env_file="$app_dir/.env.staging"
compose_file="$app_dir/compose.staging.yml"
release_store="$app_dir/rollbacks/releases"
lock_file="$app_dir/.staging-release.lock"
recovery_marker="$app_dir/.staging-recovery-required"
release_image="easyboost-staging-app:release-$expected_sha"

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
    'staging deploy deadline watchdog settlement was not proven' \
    || settlement_status="$?"
  [ "$settlement_status" -eq 0 ] || status="$settlement_status"
  exit "$status"
}
trap release_early_host_operation_lock EXIT

if [ -e "$recovery_marker" ]; then
  echo "Staging is fail-closed pending verified manual recovery" >&2
  exit 70
fi

candidate_pair_existed=0
candidate_pair_publication_started=0
candidate_pair_published=0
image_build_attempted=0
candidate_image_id=''
stable_promotion_attempted=0
tree_mutated=0
activation_succeeded=0
commit_verified=0
transaction_cleared=0
postcommit_step=''
active_release=0
previous_image_id=''
previous_sha=''
candidate_expanded=0
candidate_compressed=0
previous_expanded=0
previous_compressed=0
backup_capacity=0
database_backup_required=0
backup_bytes=0
backup_temp=''
backup_destination=''
backup_staging=''
recovery_step='not started'
transaction_marker_created=0
release_transaction_started=0
release_finalization_step=''
release_finalization_verified=0
uploaded_archive_authority=''
uploaded_archive_size=0
frozen_archive_reservation_authority=''
first_deploy_compose_file=''

cleanup_incomplete_upload_reservation() {
  [ -n "$temporary_reservation_file" ] || return 0
  reverify_release_workspace || return 1
  if [ -e "$temporary_reservation_file" ] || [ -L "$temporary_reservation_file" ]; then
    [ ! -L "$temporary_reservation_file" ] && [ -f "$temporary_reservation_file" ] \
      || return 1
    run_workspace_bounded "$COMMAND_SECONDS" rm -f -- "$temporary_reservation_file" || return 1
  fi
  [ ! -e "$temporary_reservation_file" ] && [ ! -L "$temporary_reservation_file" ] \
    || return 1
  temporary_reservation_file=''
  temporary_reservation_authority=''
}

cleanup_frozen_archive_reservation() {
  reverify_release_workspace || return 1
  if [ ! -e "$frozen_archive" ] && [ ! -L "$frozen_archive" ]; then
    frozen_archive_reservation_authority=''
    return 0
  fi
  [ ! -L "$frozen_archive" ] && [ -f "$frozen_archive" ] || return 1
  if [ -n "$frozen_archive_reservation_authority" ]; then
    run_bounded "$COMMAND_SECONDS" node "$runtime_authority_tool" verify-reservation \
      "$frozen_archive" "$uploaded_archive_size" \
      "$frozen_archive_reservation_authority" || return 1
  fi
  run_workspace_bounded "$COMMAND_SECONDS" rm -f -- "$frozen_archive" || return 1
  [ ! -e "$frozen_archive" ] && [ ! -L "$frozen_archive" ] || return 1
  frozen_archive_reservation_authority=''
}

reserve_uploaded_archive_space() {
  local required available
  reverify_release_workspace || return 1
  required=$((uploaded_archive_size + MINIMUM_DISK_HEADROOM_BYTES))
  available="$(run_bounded "$COMMAND_SECONDS" df --output=avail -B1 -- "$work_dir")" || {
    echo "Uploaded release archive capacity probe failed" >&2
    return 1
  }
  available="${available##*$'\n'}"
  if [[ ! "$available" =~ ^[0-9]+$ ]] || [ "$available" -lt "$required" ]; then
    echo "Insufficient upload storage capacity and headroom" >&2
    return 1
  fi
  temporary_reservation_file="$work_dir/.staging-space-reservation-upload"
  if ! reserve_file "$temporary_reservation_file" "$MINIMUM_DISK_HEADROOM_BYTES"; then
    cleanup_incomplete_upload_reservation || :
    echo "Uploaded release archive capacity reservation could not be proven" >&2
    return 1
  fi
  if ! run_workspace_bounded "$COMMAND_SECONDS" fallocate -l "$uploaded_archive_size" -- "$frozen_archive" \
    || ! run_workspace_bounded "$COMMAND_SECONDS" chmod 600 "$frozen_archive"; then
    cleanup_frozen_archive_reservation || :
    echo "Uploaded release archive output capacity could not be allocated" >&2
    return 1
  fi
  frozen_archive_reservation_authority="$(run_bounded "$COMMAND_SECONDS" node \
    "$runtime_authority_tool" capture-reservation "$frozen_archive" \
    "$uploaded_archive_size")" || {
    cleanup_frozen_archive_reservation || :
    echo "Uploaded release archive output capacity could not be proven" >&2
    return 1
  }
}

verify_deploy_cleanup_boundary() { return 0; }

verify_committed_deploy_boundary() {
  verify_reservation_free_active_state "$expected_sha" \
    "$(release_archive_path "$expected_sha")" "$candidate_image_id"
}

verify_recovered_deploy_boundary() {
  if [ "$active_release" -eq 1 ]; then
    verify_reservation_free_active_state "$previous_sha" \
      "$(release_archive_path "$previous_sha")" "$previous_image_id"
  else
    validate_release_store allow-change && verify_empty_state
  fi
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
    cleanup_step='protected staging authority changed during deploy'
    echo "Protected staging authority changed; automatic recovery is unsafe" >&2
  elif [ "$primary_status" -ne 0 ] && [ "$activation_succeeded" -eq 0 ] \
    && { [ "$stable_promotion_attempted" -eq 1 ] \
      || { [ "$active_release" -eq 0 ] && [ "$release_transaction_started" -eq 1 ]; }; }; then
    if [ "$active_release" -eq 1 ]; then recover_previous_release; else recover_empty_release; fi
    recovery_status="$?"
    if [ "$recovery_status" -ne 0 ]; then
      recovery_failed=1
      final_status=70
      record_cleanup_failure "$recovery_step"
      echo "Primary staging deploy failed with status $primary_status; recovery failed at: $recovery_step" >&2
    else
      runtime_recovered=1
    fi
  elif [ "$primary_status" -ne 0 ] && [ "$commit_verified" -eq 1 ]; then
    final_status=70
    recovery_failed=1
    record_cleanup_failure "${postcommit_step:-clear committed release transaction marker}"
    write_recovery_marker "$cleanup_step" "$primary_status" 1
    echo "Staging candidate committed but transaction cleanup failed; state remains fail-closed" >&2
  elif [ "$primary_status" -ne 0 ]; then
    echo "Staging deploy failed before active-state mutation (status $primary_status)" >&2
  fi
  if [ "$primary_status" -ne 0 ] && [ "$activation_succeeded" -eq 0 ] \
    && [ "$candidate_pair_existed" -eq 0 ] \
    && [ "$candidate_pair_publication_started" -eq 1 ]; then
    recovery_step='remove transaction-owned candidate release publication'
    if ! remove_owned_candidate_publication; then
      [ -z "$candidate_publication_cleanup_failure_step" ] \
        || recovery_step="$candidate_publication_cleanup_failure_step"
      recovery_failed=1
      final_status=70
      record_cleanup_failure "$recovery_step"
    fi
  fi
  if [ -n "$backup_staging" ] && [ -e "$backup_staging" ] \
    && ! run_bounded "$COMMAND_SECONDS" rm -f -- "$backup_staging"; then
    echo "Partial staging database backup could not be removed" >&2
    record_cleanup_failure 'remove partial staging database backup'
    final_status=70
    recovery_failed=1
  fi
  proof_hook=verify_deploy_cleanup_boundary
  proof_step='verify completed staging cleanup boundary'
  if [ "$runtime_recovered" -eq 1 ]; then
    proof_hook=verify_recovered_deploy_boundary
    proof_step='revalidate exact restored release state'
  elif [ "$commit_verified" -eq 1 ]; then
    proof_hook=verify_committed_deploy_boundary
    proof_step='verify final staging release store'
  fi
  release_finalization_step="$cleanup_step"
  if ! finalize_release_boundaries \
    'remove temporary staging release image' \
    'release staging disk reservations' \
    'remove private staging work directory' \
    'remove completed recovery transaction marker' \
    "$proof_step" "$proof_hook"; then
    record_cleanup_failure "$release_finalization_step"
    final_status=70
    recovery_failed=1
  elif [ "$runtime_recovered" -eq 1 ] && [ "$release_finalization_verified" -eq 1 ]; then
    recovery_verified=1
  fi
  if [ "$recovery_failed" -eq 0 ] && [ "$recovery_verified" -eq 1 ]; then
    echo "Primary staging deploy failed with status $primary_status; verified prior state restored" >&2
  fi
  if [ "$recovery_failed" -eq 1 ] && [ -n "$cleanup_step" ]; then
    write_recovery_marker "$cleanup_step" "$primary_status" 1 || \
      echo "Recovery-required marker could not be persisted" >&2
  fi
  if [ "$recovery_failed" -eq 1 ]; then
    echo "Staging remains fail-closed; inspect $recovery_marker" >&2
  fi
  settle_deadline_watchdog_and_release_host_lock "$primary_status" \
    'staging deploy deadline watchdog settlement was not proven' \
    || settlement_status="$?"
  [ "$settlement_status" -eq 0 ] || final_status="$settlement_status"
  exit "$final_status"
}
trap cleanup EXIT

create_release_workspace deploy || exit 67
frozen_archive="$work_dir/release.tar.gz"
release_dir="$work_dir/candidate"
previous_archive="$work_dir/previous.tar.gz"
previous_tree="$work_dir/previous"

validate_release_store || exit 67

# Reject an invalid upload before inspecting Docker, the active image, or any mutable runtime state.
uploaded_archive_authority="$(run_bounded "$COMMAND_SECONDS" node "$bounded_stream_tool" \
  capture-file "$archive" "$MAX_RELEASE_ARCHIVE_BYTES")" || {
  echo "Uploaded release archive identity or byte bound is unsafe" >&2
  exit 65
}
uploaded_archive_size="$(authority_field "$uploaded_archive_authority" size)" || exit 65
[[ "$uploaded_archive_size" =~ ^[0-9]+$ ]] \
  && [ "$uploaded_archive_size" -le "$MAX_RELEASE_ARCHIVE_BYTES" ] || exit 65
reserve_uploaded_archive_space || exit 68
frozen_record="$(run_workspace_bounded "$COMMAND_SECONDS" node "$bounded_stream_tool" \
  freeze-reserved-file "$archive" "$frozen_archive" "$MAX_RELEASE_ARCHIVE_BYTES" \
  "$uploaded_archive_authority" "$frozen_archive_reservation_authority")" || {
  cleanup_frozen_archive_reservation || :
  exit 65
}
frozen_archive_reservation_authority=''
frozen_size="$(authority_field "$frozen_record" bytes)" || exit 65
frozen_sha="$(authority_field "$frozen_record" sha256)" || exit 65
[ "$frozen_size" = "$uploaded_archive_size" ] \
  || { echo "Uploaded release archive changed while freezing" >&2; exit 65; }
[ "$frozen_sha" = "$expected_sha" ] \
  || { echo "Release checksum mismatch" >&2; exit 65; }
[ "$(sha256_file "$frozen_archive")" = "$expected_sha" ] \
  || { echo "Release checksum mismatch" >&2; exit 65; }
release_space_reservations \
  || { echo "Uploaded release archive reservation cleanup failed" >&2; exit 68; }
run_archive_inspect "$frozen_archive" || exit 65
read -r candidate_expanded candidate_compressed < <(archive_metrics "$frozen_archive") \
  || { echo "Release archive metrics are unavailable" >&2; exit 65; }
admit_release_pair "$expected_sha" "$frozen_archive" || exit 68

if [ -f "$compose_file" ] || [ -f "$app_dir/.release-sha256" ]; then
  if [ ! -f "$compose_file" ] || [ ! -f "$app_dir/.release-sha256" ]; then
    echo "Active release metadata is incomplete" >&2
    exit 67
  fi
  previous_sha="$(read_exact_sha_marker \
    "$app_dir/.release-sha256" 'active release marker')" || exit 67
  active_release=1
  reverify_release_store_identity || exit 67
  run_workspace_bounded "$COMMAND_SECONDS" cp --reflink=never -- \
    "$(release_archive_path "$previous_sha")" "$previous_archive"
  run_workspace_bounded "$COMMAND_SECONDS" chmod 400 "$previous_archive"
  [ "$(sha256_file "$previous_archive")" = "$previous_sha" ] \
    || { echo "Active retained archive changed while freezing" >&2; exit 67; }
  read -r previous_expanded previous_compressed < <(archive_metrics "$previous_archive") \
    || { echo "Active archive metrics are unavailable" >&2; exit 67; }
  previous_image_id="$(image_id "$STABLE_IMAGE")" || {
    echo "Active staging image cannot be restored" >&2
    exit 67
  }
  [ -n "$previous_image_id" ] || { echo "Active staging image cannot be restored" >&2; exit 67; }
  require_local_dependency_images || exit 67
  capture_running_postgres_authority || {
    echo "Active staging PostgreSQL runtime is not an exact healthy authority" >&2
    exit 67
  }
  verify_active_snapshot "$previous_sha" "$previous_archive" "$previous_image_id" || {
    echo "Active predecessor snapshot could not be verified" >&2
    exit 67
  }
  database_backup_required=1
  backup_capacity="$MAX_DATABASE_BACKUP_BYTES"
else
  verify_empty_state || {
    echo "First deploy requires an empty bootstrappable Docker and code state" >&2
    exit 67
  }
fi

reserve_release_space "$candidate_expanded" "$previous_expanded" \
  "$candidate_compressed" "$previous_compressed" "$backup_capacity" || exit 68
if [ "$active_release" -eq 1 ]; then
  consume_reservation "$temporary_reservation_file" "$previous_expanded" || exit 68
  run_workspace_bounded "$COMMAND_SECONDS" mkdir -m 700 "$previous_tree"
  run_archive_extract "$previous_archive" "$previous_tree" || exit 67
  run_tree_verify "$previous_archive" "$previous_tree" || exit 67
fi
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
if [ "$active_release" -eq 0 ]; then
  first_deploy_compose_file="$release_dir/compose.staging.yml"
fi
verify_space_reservations || exit 68
image_is_absent "$release_image" || {
  echo "Temporary staging release image reference is not authoritatively absent" >&2
  exit 70
}

begin_release_transaction
release_transaction_started=1
image_build_attempted=1
run_bounded "$IMAGE_BUILD_SECONDS" docker build --file Dockerfile \
  --tag "$release_image" - < "$frozen_archive"
candidate_image_id="$(image_id "$release_image")"
[ -n "$candidate_image_id" ] || { echo "Candidate image identity is unavailable" >&2; exit 70; }
[ "$(sha256_file "$frozen_archive")" = "$expected_sha" ] \
  || { echo "Frozen release archive changed during image build" >&2; exit 65; }

if [ "$database_backup_required" -eq 1 ]; then
  consume_reservation "$temporary_reservation_file" "$MAX_DATABASE_BACKUP_BYTES" || exit 68
  backup_temp="$work_dir/database-backup.dump"
  verify_running_postgres_authority || exit 67
  reverify_compose_authority || exit 67
  run_bounded 120 docker compose -f "$compose_file" --env-file "$env_file" exec -T postgres \
    pg_dump -U easyboost_staging -d easyboost_staging \
    --format=custom --no-owner --no-privileges \
    | run_workspace_bounded 120 node "$bounded_stream_tool" "$backup_temp" "$MAX_DATABASE_BACKUP_BYTES"
  test -s "$backup_temp"
  backup_bytes="$(run_bounded "$COMMAND_SECONDS" stat -c '%s' -- "$backup_temp")"
  [ "$backup_bytes" -le "$MAX_DATABASE_BACKUP_BYTES" ] || exit 68
  run_workspace_bounded "$COMMAND_SECONDS" chmod 600 "$backup_temp"
  verify_running_postgres_authority || exit 67
fi

if [ "$active_release" -eq 1 ]; then
  verify_active_snapshot "$previous_sha" "$previous_archive" "$previous_image_id" || {
    echo "Active predecessor changed before promotion" >&2
    exit 67
  }
fi
verify_space_reservations || exit 68

if [ "$backup_bytes" -gt 0 ]; then
  consume_reservation "$live_reservation_file" "$backup_bytes" || exit 68
  backup_destination="$app_dir/backups/easyboost-staging-$(run_bounded "$COMMAND_SECONDS" date -u +%Y%m%dT%H%M%SZ)-${expected_sha:0:12}-$$.dump"
  backup_staging="$backup_destination.tmp.$$"
  run_workspace_bounded "$COMMAND_SECONDS" cp --reflink=never -- "$backup_temp" "$backup_staging"
  [ "$(sha256_file "$backup_staging")" = "$(sha256_file "$backup_temp")" ] || exit 70
  run_bounded "$COMMAND_SECONDS" chmod 600 "$backup_staging"
  durable_sync_file "$backup_staging" || exit 70
  durable_publish_no_replace_file "$backup_staging" "$backup_destination" || exit 70
  [ "$(run_bounded "$COMMAND_SECONDS" stat -c '%h' -- "$backup_destination")" -eq 2 ] \
    || exit 70
  durable_remove_file "$backup_staging" || exit 70
  [ ! -e "$backup_staging" ] && [ ! -L "$backup_staging" ] || exit 70
  [ "$(run_bounded "$COMMAND_SECONDS" stat -c '%h' -- "$backup_destination")" -eq 1 ] \
    || exit 70
  [ "$(sha256_file "$backup_destination")" = "$(sha256_file "$backup_temp")" ] || exit 70
  backup_staging=''
fi

if [ "$active_release" -eq 0 ]; then
  reverify_compose_authority || exit 70
  validate_staging_compose_contract "$first_deploy_compose_file" || exit 70
  verify_postgres_image || exit 70
  run_bounded "$COMMAND_SECONDS" docker compose --project-directory "$app_dir" \
    -f "$first_deploy_compose_file" --env-file "$env_file" \
    up --pull never -d --no-build --no-deps postgres
  wait_for_running_postgres_authority || exit 70
else
  verify_running_postgres_authority || exit 70
fi

stable_promotion_attempted=1
run_bounded "$COMMAND_SECONDS" docker image tag "$release_image" "$STABLE_IMAGE"
verify_stable_image "$candidate_image_id"

prepare_release_tree_for_copy "$release_dir"
run_tree_verify "$frozen_archive" "$release_dir"
tree_mutated=1
consume_reservation "$live_reservation_file" "$candidate_expanded" || exit 68
clear_release_tree
run_workspace_bounded "$COMMAND_SECONDS" cp -a "$release_dir"/. "$app_dir"/
run_bounded "$COMMAND_SECONDS" chmod 700 "$app_dir"
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

publish_release_pair "$expected_sha" "$frozen_archive"
validate_release_store
port="$(app_port)"
reverify_compose_authority
run_bounded "$COMMAND_SECONDS" docker compose -f "$compose_file" --env-file "$env_file" ps
publish_active_marker "$expected_sha"
published_sha="$(read_exact_sha_marker "$app_dir/.release-sha256" 'published active release marker')"
[ "$published_sha" = "$expected_sha" ] || exit 70
commit_verified=1
activation_succeeded=1
postcommit_step='prune expired staging database backups'
run_bounded "$COMMAND_SECONDS" find "$app_dir/backups" -type f \
  -name 'easyboost-staging-*.dump' -mtime +14 -delete
release_finalization_step=''
postcommit_step='finalize committed staging release boundaries'
if ! finalize_release_boundaries \
  'remove temporary staging release image' \
  'release staging disk reservations' \
  'remove private staging work directory' \
  'clear committed release transaction marker' \
  'verify final staging release store' \
  verify_committed_deploy_boundary; then
  postcommit_step="$release_finalization_step"
  exit 70
fi
[ "$release_finalization_verified" -eq 1 ] || exit 70
postcommit_step=''
echo "staging_release_sha256=$expected_sha"
echo "staging_ready=http://127.0.0.1:$port/health/ready"
