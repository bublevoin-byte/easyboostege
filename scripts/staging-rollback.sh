#!/bin/bash
set -Eeuo pipefail

app_dir="${STAGING_APP_DIR:-/opt/easyboost-staging}"
rollback="${1:-}"

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

tar -xzf "$rollback" -C "$app_dir"
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
