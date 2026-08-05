#!/bin/bash
set -Eeuo pipefail

app_dir="$(readlink -f "${STAGING_APP_DIR:-/opt/easyboost-staging}")"
rollback="${1:-}"

case "$app_dir" in
  /|/opt) echo "Unsafe staging app directory" >&2; exit 65 ;;
esac

if [ -z "$rollback" ]; then
  rollback="$(
    find "$app_dir/rollbacks" -maxdepth 1 -type f -name 'code-before-*.tar.gz' \
      -printf '%T@ %p\n' |
      sort -nr |
      head -n1 |
      cut -d' ' -f2-
  )"
fi

test -n "$rollback"
rollback="$(readlink -f "$rollback")"
case "$rollback" in
  "$app_dir"/rollbacks/code-before-*.tar.gz) ;;
  *) echo "Rollback archive must be inside $app_dir/rollbacks" >&2; exit 65 ;;
esac
test -s "$rollback"
test -f "$app_dir/.env.staging"

restore_dir="$(mktemp -d "${app_dir}.rollback.XXXXXX")"
cleanup_restore() { rm -rf -- "$restore_dir"; }
trap cleanup_restore EXIT

tar -xzf "$rollback" -C "$restore_dir"
test -f "$restore_dir/compose.staging.yml"
for protected in .env.staging backups rollbacks; do
  if [ -e "$restore_dir/$protected" ] || [ -L "$restore_dir/$protected" ]; then
    echo "Rollback archive contains protected runtime path: $protected" >&2
    exit 65
  fi
done

# Reject a malformed release before removing the currently runnable code tree.
docker compose --project-directory "$app_dir" -f "$restore_dir/compose.staging.yml" \
  --env-file "$app_dir/.env.staging" config --quiet

find "$app_dir" -mindepth 1 -maxdepth 1 \
  ! -name '.env.staging' \
  ! -name 'backups' \
  ! -name 'rollbacks' \
  -exec rm -rf -- {} +
cp -a "$restore_dir"/. "$app_dir"/
cd "$app_dir"
docker compose -f compose.staging.yml --env-file .env.staging config --quiet
docker compose -f compose.staging.yml --env-file .env.staging up -d --build

app_port="$(
  awk -F= '$1 == "APP_PORT" { print $2 }' .env.staging |
    tail -n1 |
    tr -d '\r'
)"
app_port="${app_port:-3001}"

for attempt in $(seq 1 60); do
  curl -fsS "http://127.0.0.1:$app_port/health/ready" >/dev/null && break
  test "$attempt" -lt 60
  sleep 2
done

echo "Staging rollback completed from $rollback"
