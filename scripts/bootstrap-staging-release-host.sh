#!/bin/bash
set -Eeuo pipefail
umask 077

source_dir="$(dirname "$(readlink -f "$0")")"
app_dir="${STAGING_APP_DIR:-/opt/easyboost-staging}"
env_template="${STAGING_ENV_TEMPLATE:-$source_dir/../.env.staging.example}"
helper_install_root="${STAGING_HELPER_INSTALL_ROOT:-/usr/local/lib/easyboost-staging-release}"
helper_link_root="${STAGING_HELPER_LINK_ROOT:-/usr/local/sbin}"
host_operation_lock_directory="${EASYBOOST_HOST_OPERATION_LOCK_DIR:-/var/lib/easyboost/locks/host-operation.lock}"
approved_prefix="${STAGING_BOOTSTRAP_ALLOWED_PREFIX:-}"
owner_uid="$(id -u)"
owner_gid="$(id -g)"
host_operation_owner_uid="${EASYBOOST_HOST_OPERATION_OWNER_UID:-0}"
host_operation_owner_gid="${EASYBOOST_HOST_OPERATION_OWNER_GID:-0}"

case "$app_dir:$env_template:$helper_install_root:$helper_link_root:$host_operation_lock_directory" in
  /*:/*:/*:/*:/*) ;;
  *) echo 'Staging bootstrap paths must be absolute' >&2; exit 64 ;;
esac
case "$host_operation_owner_uid:$host_operation_owner_gid" in
  *[!0-9:]*|:*|*:) echo 'Host-operation owner UID and GID must be explicit numeric identities' >&2; exit 64 ;;
esac
if [ "$host_operation_lock_directory" = /var/lib/easyboost/locks/host-operation.lock ] \
  && [ "$host_operation_owner_uid:$host_operation_owner_gid" != 0:0 ]; then
  echo 'Canonical host-operation lock parent must remain root-owned' >&2
  exit 77
fi
if [ -n "$approved_prefix" ]; then
  case "$approved_prefix" in /*) ;; *) echo 'Staging approved prefix must be absolute' >&2; exit 64 ;; esac
fi
command -v node >/dev/null 2>&1 || { echo 'Node.js is required' >&2; exit 69; }
command -v readlink >/dev/null 2>&1 || { echo 'readlink is required' >&2; exit 69; }

reject_linked_root_chain() {
  local current="$1" parent
  while true; do
    [ ! -L "$current" ] || return 1
    parent="$(dirname -- "$current")" || return 1
    [ "$parent" != "$current" ] || break
    current="$parent"
  done
}

for candidate in "$app_dir" "$helper_install_root" "$helper_link_root" \
  "$host_operation_lock_directory"; do
  reject_linked_root_chain "$candidate" || {
    echo 'Staging bootstrap roots must not traverse symlinks' >&2
    exit 64
  }
done
if [ -n "$approved_prefix" ]; then
  reject_linked_root_chain "$approved_prefix" || {
    echo 'Staging approved prefix must not traverse symlinks' >&2
    exit 64
  }
fi

node "$source_dir/staging-helper-bundle.js" validate-root-layout \
  "$app_dir" "$helper_install_root" "$helper_link_root" "$approved_prefix" >/dev/null || {
  echo 'Unsafe staging bootstrap root layout' >&2
  exit 64
}
app_dir="$(readlink -m -- "$app_dir")" || exit 64
helper_install_root="$(readlink -m -- "$helper_install_root")" || exit 64
helper_link_root="$(readlink -m -- "$helper_link_root")" || exit 64
host_operation_lock_directory="$(readlink -m -- "$host_operation_lock_directory")" || exit 64
host_operation_lock_parent="$(dirname -- "$host_operation_lock_directory")" || exit 64
if [ -n "$approved_prefix" ]; then
  approved_prefix="$(readlink -m -- "$approved_prefix")" || exit 64
fi
node "$source_dir/staging-helper-bundle.js" validate-root-layout \
  "$app_dir" "$helper_install_root" "$helper_link_root" "$approved_prefix" >/dev/null || {
  echo 'Unsafe canonical staging bootstrap root layout' >&2
  exit 64
}

if { [ "$app_dir" = /opt/easyboost-staging ] \
    || [ "$helper_install_root" = /usr/local/lib/easyboost-staging-release ] \
    || [ "$helper_link_root" = /usr/local/sbin ]; } \
  && [ "$owner_uid" -ne 0 ]; then
  echo 'The production staging bootstrap must run as root' >&2
  exit 77
fi

reject_linked_root_chain "$host_operation_lock_parent" || {
  echo 'Host-operation lock parent must not traverse symlinks' >&2
  exit 64
}
if [ -e "$host_operation_lock_directory" ] || [ -L "$host_operation_lock_directory" ]; then
  echo 'Host-operation lock authority already exists; finish or recover that operation first' >&2
  exit 75
fi
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*)
    mkdir -p -- "$host_operation_lock_parent"
    chmod 750 -- "$host_operation_lock_parent"
    ;;
  *)
    install -d -o "$host_operation_owner_uid" -g "$host_operation_owner_gid" -m 750 -- "$host_operation_lock_parent"
    [ ! -L "$host_operation_lock_parent" ] \
      && [ -d "$host_operation_lock_parent" ] \
      && [ "$(stat -c '%u:%g:%a' -- "$host_operation_lock_parent")" \
        = "$host_operation_owner_uid:$host_operation_owner_gid:750" ] || {
      echo 'Host-operation lock parent owner or mode could not be proven' >&2
      exit 67
    }
    ;;
esac
[ ! -e "$host_operation_lock_directory" ] && [ ! -L "$host_operation_lock_directory" ] || {
  echo 'Bootstrap must provision only the host-operation lock parent' >&2
  exit 67
}

verify_real_entry() {
  local candidate="$1" expected="$2" mode="$3" role="$4" actual_mode
  [ ! -L "$candidate" ] || { echo "$role must not be a symlink" >&2; return 1; }
  case "$expected" in
    directory) [ -d "$candidate" ] || { echo "$role is not a directory" >&2; return 1; } ;;
    file) [ -f "$candidate" ] || { echo "$role is not a regular file" >&2; return 1; } ;;
    *) return 1 ;;
  esac
  case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) return 0 ;; esac
  if [ "$expected" = file ]; then
    [ "$(stat -c '%u:%g:%h' -- "$candidate")" = "$owner_uid:$owner_gid:1" ] \
      || { echo "$role has an unsafe owner or link count" >&2; return 1; }
  else
    [ "$(stat -c '%u:%g' -- "$candidate")" = "$owner_uid:$owner_gid" ] \
      || { echo "$role has an unsafe owner" >&2; return 1; }
  fi
  actual_mode="$(stat -c '%a' -- "$candidate")" || return 1
  [ "$actual_mode" = "$mode" ] || { echo "$role has an unsafe mode" >&2; return 1; }
}

for candidate in "$app_dir" "$app_dir/backups" "$app_dir/rollbacks" \
  "$app_dir/rollbacks/releases"; do
  [ ! -L "$candidate" ] || { echo 'Staging bootstrap refuses linked runtime roots' >&2; exit 67; }
done
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*)
    mkdir -p -- "$app_dir/backups" "$app_dir/rollbacks/releases"
    chmod 700 -- "$app_dir" "$app_dir/backups" "$app_dir/rollbacks" \
      "$app_dir/rollbacks/releases"
    ;;
  *)
    install -d -o "$owner_uid" -g "$owner_gid" -m 700 -- "$app_dir"
    install -d -o "$owner_uid" -g "$owner_gid" -m 700 -- \
      "$app_dir/backups" "$app_dir/rollbacks" "$app_dir/rollbacks/releases"
    ;;
esac
for candidate in "$app_dir" "$app_dir/backups" "$app_dir/rollbacks" \
  "$app_dir/rollbacks/releases"; do
  verify_real_entry "$candidate" directory 700 'staging private directory'
done

env_file="$app_dir/.env.staging"
if [ ! -e "$env_file" ] && [ ! -L "$env_file" ]; then
  [ ! -L "$env_template" ] && [ -f "$env_template" ] \
    || { echo 'Staging environment template is missing or unsafe' >&2; exit 65; }
  case "$(uname -s)" in
    MINGW*|MSYS*|CYGWIN*) cp -- "$env_template" "$env_file"; chmod 600 -- "$env_file" ;;
    *) install -o "$owner_uid" -g "$owner_gid" -m 600 -- "$env_template" "$env_file" ;;
  esac
fi
verify_real_entry "$env_file" file 600 'staging environment file'

STAGING_APP_DIR="$app_dir" \
STAGING_HELPER_ALLOWED_PREFIX="$approved_prefix" \
STAGING_HELPER_INSTALL_ROOT="$helper_install_root" \
STAGING_HELPER_LINK_ROOT="$helper_link_root" \
  bash "$source_dir/install-staging-release-helpers.sh"

echo "staging_bootstrap_root=$app_dir"
echo 'staging_bootstrap_protocol=immutable-archive-v4'
