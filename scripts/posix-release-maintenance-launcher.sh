#!/bin/bash
set -Eeuo pipefail
umask 077
PATH='/usr/bin:/bin'
LC_ALL=C
export PATH LC_ALL
unset BASH_ENV ENV NODE_OPTIONS NODE_PATH EASYBOOST_POSIX_RELEASE_MAINTENANCE_SCOPE

[ "$#" -ge 6 ] || { echo 'POSIX release maintenance launcher arguments are invalid' >&2; exit 64; }
lock_file="$1"
expected_stat="$2"
expected_bytes="$3"
expected_digest="$4"
environment_value="$5"
node_command="$6"
shift 6

case "$lock_file:$node_command" in /*:/*) ;; *) echo 'POSIX release maintenance paths must be absolute' >&2; exit 64 ;; esac
[[ "$expected_stat" =~ ^[0-9]+:[0-9]+:[0-9]+:[0-9]+:600:1:[1-9][0-9]*$ ]] \
  || { echo 'POSIX release maintenance lock identity is invalid' >&2; exit 64; }
[[ "$expected_bytes" =~ ^[1-9][0-9]*$ ]] \
  || { echo 'POSIX release maintenance lock size is invalid' >&2; exit 64; }
[ "${expected_stat##*:}" = "$expected_bytes" ] \
  || { echo 'POSIX release maintenance lock size does not match its identity' >&2; exit 64; }
[[ "$expected_digest" =~ ^[a-f0-9]{64}$ ]] \
  || { echo 'POSIX release maintenance lock digest is invalid' >&2; exit 64; }
[[ "$environment_value" =~ ^easyboost-posix-release-maintenance-scope-v2:8:[a-f0-9]{64}$ ]] \
  || { echo 'POSIX release maintenance environment authority is invalid' >&2; exit 64; }
[ -x /usr/bin/stat ] && [ -x /usr/bin/sha256sum ] && [ -x /usr/bin/flock ] \
  || { echo 'POSIX release maintenance tools are unavailable' >&2; exit 69; }
[ ! -L "$lock_file" ] && [ -f "$lock_file" ] \
  || { echo 'POSIX release maintenance lock path is unsafe' >&2; exit 69; }

stat_format='%d:%i:%u:%g:%a:%h:%s'
before="$(/usr/bin/stat -c "$stat_format" -- "$lock_file")"
[ "$before" = "$expected_stat" ] || { echo 'POSIX release maintenance lock changed' >&2; exit 75; }
exec 7< "$lock_file"
opened="$(/usr/bin/stat -Lc "$stat_format" -- "/proc/$BASHPID/fd/7")"
[ "$opened" = "$expected_stat" ] || { echo 'POSIX release maintenance opened lock changed' >&2; exit 75; }
digest_line="$(/usr/bin/sha256sum -- "/proc/$BASHPID/fd/7")"
[ "${digest_line%% *}" = "$expected_digest" ] \
  || { echo 'POSIX release maintenance lock bytes changed' >&2; exit 75; }
exec 8<> "$lock_file"
opened8="$(/usr/bin/stat -Lc "$stat_format" -- "/proc/$BASHPID/fd/8")"
[ "$opened8" = "$expected_stat" ] || { echo 'POSIX release maintenance descriptor changed' >&2; exit 75; }
/usr/bin/flock -n 8 || { echo 'Another POSIX release maintenance batch is active' >&2; exit 75; }
after="$(/usr/bin/stat -c "$stat_format" -- "$lock_file")"
opened8="$(/usr/bin/stat -Lc "$stat_format" -- "/proc/$BASHPID/fd/8")"
digest_line="$(/usr/bin/sha256sum -- "/proc/$BASHPID/fd/8")"
[ "$after" = "$expected_stat" ] && [ "$opened8" = "$expected_stat" ] \
  && [ "${digest_line%% *}" = "$expected_digest" ] \
  || { echo 'POSIX release maintenance authority changed after flock' >&2; exit 75; }
exec 7<&-
EASYBOOST_POSIX_RELEASE_MAINTENANCE_SCOPE="$environment_value"
export EASYBOOST_POSIX_RELEASE_MAINTENANCE_SCOPE
exec "$node_command" "$@"
