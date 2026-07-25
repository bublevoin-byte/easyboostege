#!/bin/bash
set -Eeuo pipefail

if [ "$#" -ne 2 ]; then
  echo "Usage: $0 RELEASE_ARCHIVE EXPECTED_SHA256" >&2
  exit 64
fi

archive="$(readlink -f "$1")"
expected_sha="${2,,}"
app_dir="${STAGING_APP_DIR:-/opt/easyboost-staging}"
compose_file="$app_dir/compose.staging.yml"
env_file="$app_dir/.env.staging"
release_id="${expected_sha:0:12}"
rollback_dir="$app_dir/rollbacks"

test -f "$archive"
actual_sha="$(sha256sum "$archive" | awk '{print $1}')"
if [ "$actual_sha" != "$expected_sha" ]; then
  echo "Release checksum mismatch" >&2
  exit 65
fi

install -d -m 755 "$app_dir"
install -d -m 700 "$rollback_dir" "$app_dir/backups"

if [ -f "$env_file" ]; then
  chmod 600 "$env_file"
else
  echo "$env_file is required" >&2
  exit 66
fi

if [ -f "$compose_file" ] && docker compose -f "$compose_file" --env-file "$env_file" ps --status running postgres --quiet | grep -q .; then
  backup="$app_dir/backups/easyboost-staging-$(date -u +%Y%m%dT%H%M%SZ).dump"
  docker compose -f "$compose_file" --env-file "$env_file" exec -T postgres \
    pg_dump -U easyboost_staging -d easyboost_staging \
    --format=custom --no-owner --no-privileges > "$backup"
  test -s "$backup"
  chmod 600 "$backup"
fi

if [ -f "$compose_file" ]; then
  rollback="$rollback_dir/code-before-$release_id-$(date -u +%Y%m%dT%H%M%SZ).tar.gz"
  tar --exclude='./.env.staging' --exclude='./backups' --exclude='./rollbacks' \
    -czf "$rollback" -C "$app_dir" .
  chmod 600 "$rollback"
fi

tar -xzf "$archive" -C "$app_dir"
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
  if curl -fsS "http://127.0.0.1:$app_port/health/ready" >/dev/null; then
    break
  fi
  if [ "$attempt" -eq 60 ]; then
    docker compose -f compose.staging.yml --env-file .env.staging logs --tail=100 app
    exit 1
  fi
  sleep 2
done

printf '%s\n' "$actual_sha" > .release-sha256
chmod 644 .release-sha256
find "$rollback_dir" -type f -name 'code-before-*.tar.gz' -mtime +14 -delete
find "$app_dir/backups" -type f -name 'easyboost-staging-*.dump' -mtime +14 -delete

echo "staging_release_sha256=$actual_sha"
echo "staging_ready=http://127.0.0.1:$app_port/health/ready"
docker compose -f compose.staging.yml --env-file .env.staging ps
