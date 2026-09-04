import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { deflateRawSync } from 'node:zlib';

import { createReleaseArchive } from '../scripts/staging-release-archive.js';
import { captureHelperBundle } from '../scripts/staging-helper-bundle.js';

const gitBash = process.platform === 'win32' ? 'C:\\Program Files\\Git\\bin\\bash.exe' : 'bash';
const rollbackScript = path.resolve('scripts/staging-rollback.sh');
const deadlineHarness = path.resolve('test/staging-deadline-test-harness.js');
const sourceBundleDigest = captureHelperBundle({ sourceDirectory: path.resolve('scripts') }).bundleDigest;
const PREVIOUS_IMAGE_ID = `sha256:${'1'.repeat(64)}`;
const CANDIDATE_IMAGE_ID = `sha256:${'2'.repeat(64)}`;
const POSTGRES_IMAGE_ID = `sha256:${'3'.repeat(64)}`;
const DRIFTED_POSTGRES_IMAGE_ID = `sha256:${'4'.repeat(64)}`;
const FOREIGN_IMAGE_ID = `sha256:${'7'.repeat(64)}`;
const DRIFTED_RUNNING_IMAGE_ID = `sha256:${'8'.repeat(64)}`;
const LATE_RUNNING_IMAGE_ID = `sha256:${'9'.repeat(64)}`;
const APP_CONTAINER_ID = 'a'.repeat(64);
const POSTGRES_CONTAINER_ID = 'b'.repeat(64);
const DRIFTED_POSTGRES_CONTAINER_ID = 'c'.repeat(64);
const POSTGRES_VOLUME_SOURCE = '/var/lib/docker/volumes/easyboost-staging_postgres-data/_data';

function posixPath(value) {
  return value.replace(/^([A-Za-z]):/u, (_, drive) => `/${drive.toLowerCase()}`).replaceAll('\\', '/');
}

function approvedAppEnvironment(password = 'staging-password') {
  return {
    ADAPTIVE_LEARNING_ENABLED: 'false', ADMIN_TELEGRAM_ID: '',
    AI_DAILY_REQUEST_BUDGET: '1000', AI_REQUESTS_PER_HOUR: '100',
    APP_PORT: '3001', APP_URL: 'https://staging.useboost.ru',
    AZURE_SPEECH_KEY: '', AZURE_SPEECH_REGION: '',
    DATABASE_PROVIDER: 'postgres',
    DATABASE_URL: 'postgresql://easyboost_staging:' + password
      + '@postgres:5432/easyboost_staging',
    GROQ_API_KEY: '', GROQ_ENABLED: 'false', GROQ_MODEL: '',
    JWT_SECRET: 'j'.repeat(32), MONITORING_TOKEN: '', NODE_ENV: 'production',
    PORT: '3000', POSTGRES_PASSWORD: password,
    SPEAKING_PRONUNCIATION_ENABLED: 'false',
    SPEAKING_PRONUNCIATION_MAX_AUDIO_BYTES: '5242880',
    SPEAKING_PRONUNCIATION_MAX_AUDIO_SECONDS: '90',
    SPEAKING_PRONUNCIATION_TIMEOUT_MS: '45000',
    STT_REQUESTS_PER_HOUR: '100', TELEGRAM_BOT_TOKEN: '',
    TTS_REQUESTS_PER_HOUR: '100', WRITING_REQUESTS_PER_HOUR: '100',
    XAI_API_KEY: '', XAI_ENABLED: 'false', XAI_MODEL: '',
  };
}

function approvedComposeModel(appDirectory) {
  const appDir = posixPath(appDirectory).replace(/\/$/u, '');
  return {
    name: 'easyboost-staging',
    networks: { backend: { name: 'easyboost-staging_backend' } },
    services: {
      app: {
        build: { context: `${appDir}/.guarded-staging-build-context-required`, dockerfile: `${appDir}/Dockerfile` },
        depends_on: { postgres: { condition: 'service_healthy', required: true, restart: false } },
        env_file: [{ path: `${appDir}/.env.staging`, required: true }],
        environment: approvedAppEnvironment(),
        image: 'easyboost-staging-app:local', networks: { backend: null },
        ports: [{ host_ip: '127.0.0.1', mode: 'ingress', protocol: 'tcp', published: '3001', target: 3000 }],
        pull_policy: 'never', restart: 'unless-stopped',
      },
      postgres: {
        environment: {
          POSTGRES_DB: 'easyboost_staging', POSTGRES_PASSWORD: 'staging-password',
          POSTGRES_USER: 'easyboost_staging',
        },
        healthcheck: { interval: '10s', retries: 10, test: ['CMD-SHELL', 'pg_isready -U easyboost_staging -d easyboost_staging'], timeout: '5s' },
        image: POSTGRES_IMAGE_ID, networks: { backend: null }, pull_policy: 'never',
        restart: 'unless-stopped',
        volumes: [{ source: 'postgres-data', target: '/var/lib/postgresql/data', type: 'volume' }],
      },
    },
    volumes: { 'postgres-data': { name: 'easyboost-staging_postgres-data' } },
  };
}

function runBash(args, options = {}) {
  const result = spawnSync(gitBash, args, { encoding: 'utf8', ...options });
  if (result.error?.code === 'ENOENT') return null;
  return result;
}

async function packRelease(root, name, marker) {
  const source = path.join(root, `${name}-source`);
  await fs.mkdir(source, { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(source, '.dockerignore'), [
      '/backups', '/rollbacks', '/.release-sha256', '/.staging-release.lock', '',
    ].join('\n')),
    fs.writeFile(path.join(source, 'Dockerfile'), 'FROM scratch\nCOPY shared.txt /shared.txt\n'),
    fs.writeFile(path.join(source, 'compose.staging.yml'), [
      'services:',
      '  app:',
      '    image: easyboost-staging-app:local',
      '    pull_policy: never',
      '    build:',
      '      context: ./.guarded-staging-build-context-required',
      '',
    ].join('\n')),
    fs.writeFile(path.join(source, 'shared.txt'), `${marker}\n`),
    fs.writeFile(path.join(source, `${marker}-only.txt`), `${marker}-only\n`),
  ]);
  const archive = path.join(root, `${name}.tar.gz`);
  const files = ['.dockerignore', 'Dockerfile', 'compose.staging.yml', `${marker}-only.txt`, 'shared.txt'].sort();
  await createReleaseArchive({ sourceDirectory: source, files, outputPath: archive });
  const sha = crypto.createHash('sha256').update(await fs.readFile(archive)).digest('hex');
  return { archive, sha, source };
}

async function createFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-rollback-'));
  const appDir = path.join(root, 'app');
  const current = await packRelease(root, 'current', 'new');
  const target = await packRelease(root, 'target', 'old');
  const releaseStore = path.join(appDir, 'rollbacks', 'releases');
  await Promise.all([
    fs.mkdir(releaseStore, { recursive: true }),
    fs.mkdir(path.join(appDir, 'backups'), { recursive: true }),
  ]);
  for (const file of ['.dockerignore', 'Dockerfile', 'compose.staging.yml', 'shared.txt', 'new-only.txt']) {
    await fs.copyFile(path.join(current.source, file), path.join(appDir, file));
  }
  await Promise.all([
    fs.writeFile(path.join(appDir, '.env.staging'), 'APP_PORT=3001\nSECRET=preserved\n'),
    fs.writeFile(path.join(appDir, '.release-sha256'), `${current.sha}\n`),
    fs.writeFile(path.join(appDir, 'backups', 'keep.dump'), 'backup\n'),
  ]);
  for (const release of [current, target]) {
    const stored = path.join(releaseStore, `release-${release.sha}.tar.gz`);
    await fs.copyFile(release.archive, stored);
    await fs.writeFile(`${stored}.sha256`, `${release.sha}\n`);
    await fs.chmod(stored, 0o600);
    await fs.chmod(`${stored}.sha256`, 0o600);
  }
  await Promise.all([
    fs.chmod(appDir, 0o700),
    fs.chmod(path.join(appDir, 'backups'), 0o700),
    fs.chmod(path.join(appDir, 'rollbacks'), 0o700),
    fs.chmod(releaseStore, 0o700),
    fs.chmod(path.join(appDir, '.env.staging'), 0o600),
    fs.chmod(path.join(appDir, '.release-sha256'), 0o600),
    fs.chmod(path.join(appDir, 'backups', 'keep.dump'), 0o600),
  ]);
  const commandLog = path.join(root, 'commands.log');
  const bashEnv = path.join(root, 'commands.sh');
  await fs.writeFile(bashEnv, [
    `PREVIOUS_IMAGE_ID=${PREVIOUS_IMAGE_ID}`,
    `CANDIDATE_IMAGE_ID=${CANDIDATE_IMAGE_ID}`,
    `POSTGRES_IMAGE_ID=${POSTGRES_IMAGE_ID}`,
    `DRIFTED_POSTGRES_IMAGE_ID=${DRIFTED_POSTGRES_IMAGE_ID}`,
    `FOREIGN_IMAGE_ID=${FOREIGN_IMAGE_ID}`,
    `DRIFTED_RUNNING_IMAGE_ID=${DRIFTED_RUNNING_IMAGE_ID}`,
    `LATE_RUNNING_IMAGE_ID=${LATE_RUNNING_IMAGE_ID}`,
    `APP_CONTAINER_ID=${APP_CONTAINER_ID}`,
    `POSTGRES_CONTAINER_ID=${POSTGRES_CONTAINER_ID}`,
    `DRIFTED_POSTGRES_CONTAINER_ID=${DRIFTED_POSTGRES_CONTAINER_ID}`,
    `POSTGRES_VOLUME_SOURCE=${POSTGRES_VOLUME_SOURCE}`,
    'flock() { if [ "${FAKE_LOCK_BUSY:-0}" = "1" ]; then return 1; fi; return 0; }',
    'timeout() {',
    '  while [ "$#" -gt 0 ]; do case "$1" in --signal=*|--kill-after=*) shift ;; *s) shift; break ;; *) break ;; esac; done',
    '  if [ "${FAKE_LIVE_COPY_TIMEOUT:-0}" = "1" ] && [ "${1:-}" = cp ] && [ "${2:-}" = -a ] && [[ "${3:-}" == */target/. ]]; then return 124; fi',
    '  if [ "${FAKE_RECOVERY_COPY_TIMEOUT:-0}" = "1" ] && [ "${1:-}" = cp ] && [ "${2:-}" = -a ] && [[ "${3:-}" == */previous/. ]]; then return 124; fi',
    '  "$@"',
    '}',
    'fallocate() { if [ ! -x /usr/bin/fallocate ]; then /usr/bin/truncate -s "$2" "$4"; else /usr/bin/fallocate "$@"; fi; }',
    'stat() { if [ "$1" = "-c" ] && [ "$2" = "%b" ] && [[ "${@: -1}" == *".staging-space-reservation"* ]]; then size="$(/usr/bin/stat -c "%s" -- "${@: -1}")"; printf "%s\\n" "$(((size + 511) / 512))"; return 0; fi; /usr/bin/stat "$@"; }',
    'sha256sum() {',
    '  last="${@: -1}"',
    '  if [ "${last##*/}" = "target.tar.gz" ]; then printf "%s\\n" "$last" > "$COMMAND_LOG.frozen-path"; fi',
    '  /usr/bin/sha256sum "$@"',
    '}',
    'if [ "${FAKE_COMMANDS_INITIALIZED:-0}" != "1" ]; then',
    '  printf "%s\\n" "$PREVIOUS_IMAGE_ID" > "$COMMAND_LOG.image-state"',
    '  printf "%s\\n" "$PREVIOUS_IMAGE_ID" > "$COMMAND_LOG.container-state"',
    '  printf "%s\\n" "$POSTGRES_IMAGE_ID" > "$COMMAND_LOG.postgres-container-state"',
    '  printf "%s\\n" "$POSTGRES_CONTAINER_ID" > "$COMMAND_LOG.postgres-container-id-state"',
    '  printf "%s\\n" "$POSTGRES_VOLUME_SOURCE" > "$COMMAND_LOG.postgres-volume-source-state"',
    '  : > "$COMMAND_LOG.volume-state"',
    '  export FAKE_COMMANDS_INITIALIZED=1',
    'fi',
    'cp() { if [ "${FAKE_RECOVERY_COPY_FAIL:-0}" = "1" ] && [[ "$*" == *"/previous/."* ]]; then return 12; fi; /usr/bin/cp "$@"; }',
    'find() { if [ "${FAKE_RECOVERY_REMOVE_FAIL:-0}" = "1" ] && [[ "$*" == *" -exec "* ]]; then count=0; [ -f "$COMMAND_LOG.find-count" ] && count="$(cat "$COMMAND_LOG.find-count")"; count=$((count+1)); printf "%s\\n" "$count" > "$COMMAND_LOG.find-count"; if [ "$count" -ge 2 ]; then return 13; fi; fi; /usr/bin/find "$@"; }',
    'rm() {',
    '  if [ "${FAKE_TRANSACTION_MARKER_RM_FAIL:-0}" = "1" ] && [[ "$*" == *".staging-recovery-required"* ]]; then /usr/bin/rm "$@"; return 21; fi',
    '  if [ "${FAKE_RESERVATION_RM_FAIL:-0}" = "1" ] && [[ "$*" == *".staging-space-reservation"* ]]; then return 26; fi',
    '  if [ "${FAKE_WORKDIR_RM_FAIL:-0}" = "1" ] && [ "${1:-}" = "-rf" ] && [[ "$*" == *"easyboost-staging-rollback."* ]]; then return 27; fi',
    '  target="${@: -1}"',
    '  if [ "${FAKE_ADD_STORE_ENTRY_AFTER_RESERVATION_RELEASE:-0}" = "1" ]; then case "$target" in "$STAGING_APP_DIR"/rollbacks/releases/.staging-space-reservation.*) /usr/bin/rm "$@"; printf "unexpected\\n" > "$STAGING_APP_DIR/rollbacks/releases/unexpected-post-reservation"; /usr/bin/chmod 600 "$STAGING_APP_DIR/rollbacks/releases/unexpected-post-reservation"; return 0 ;; esac; fi',
    '  /usr/bin/rm "$@"',
    '  status="$?"',
    '  if [ "$status" -eq 0 ] && [ "${FAKE_ACTIVE_IMAGE_DRIFT_AFTER_WORKDIR_REMOVAL:-0}" = "1" ] && [ "${1:-}" = "-rf" ] && [[ "$*" == *"easyboost-staging-rollback."* ]]; then printf "%s\\n" "$LATE_RUNNING_IMAGE_ID" > "$COMMAND_LOG.container-state"; fi',
    '  return "$status"',
    '}',
    'mv() { if [ "${FAKE_ACTIVE_MARKER_PUBLISH_FAIL:-0}" = "1" ] && [ "${@: -1}" = "$STAGING_APP_DIR/.release-sha256" ]; then count=0; [ -f "$COMMAND_LOG.marker-mv-count" ] && count="$(cat "$COMMAND_LOG.marker-mv-count")"; count=$((count+1)); printf "%s\\n" "$count" > "$COMMAND_LOG.marker-mv-count"; [ "$count" -gt 1 ] || return 24; fi; /usr/bin/mv "$@"; }',
    'docker() {',
    '  printf "docker|%s\\n" "$*" >> "$COMMAND_LOG"',
    '  if [ "$1" = "compose" ]; then action=other; case " $* " in *" config --format json "*) action=config ;; *" up --pull never -d --no-build --no-deps app "*) action=up ;; *" down --volumes --remove-orphans "*) action=down ;; *" exec -T postgres "*) action=exec ;; *" ps "*) action=ps ;; esac; printf "compose-postgres-authority|%s|%s\\n" "${EASYBOOST_STAGING_POSTGRES_IMAGE_ID:-unset}" "$action" >> "$COMMAND_LOG"; fi',
  '  if [ "$1" = "ps" ] && [[ " $* " == *"label=com.docker.compose.project=easyboost-staging"* ]]; then',
    '    if [[ " $* " == *"label=com.docker.compose.service=app"* ]]; then [ ! -f "$COMMAND_LOG.container-state" ] || printf "%s\\n" "$APP_CONTAINER_ID"; elif [[ " $* " == *"label=com.docker.compose.service=postgres"* ]]; then [ ! -f "$COMMAND_LOG.postgres-container-state" ] || cat "$COMMAND_LOG.postgres-container-id-state"; fi',
  '    return 0',
  '  fi',
    '  if [ "$1" = "volume" ] && [ "$2" = "inspect" ]; then [ -f "$COMMAND_LOG.volume-state" ] || return 1; volume_source="${FAKE_POSTGRES_VOLUME_OBJECT_MOUNTPOINT:-$(cat "$COMMAND_LOG.postgres-volume-source-state")}"; [ ! -f "$COMMAND_LOG.postgres-volume-object-source-state" ] || volume_source="$(cat "$COMMAND_LOG.postgres-volume-object-source-state")"; printf \'{"Name":"%s","Driver":"%s","Scope":"%s","Mountpoint":"%s","Labels":{"com.docker.compose.project":"%s","com.docker.compose.volume":"%s"},"Options":null}\\n\' "${FAKE_POSTGRES_VOLUME_OBJECT_NAME:-easyboost-staging_postgres-data}" "${FAKE_POSTGRES_VOLUME_OBJECT_DRIVER:-local}" "${FAKE_POSTGRES_VOLUME_OBJECT_SCOPE:-local}" "$volume_source" "${FAKE_POSTGRES_VOLUME_OBJECT_PROJECT:-easyboost-staging}" "${FAKE_POSTGRES_VOLUME_OBJECT_LABEL:-postgres-data}"; return 0; fi',
    '  if [[ " $* " == *" config --format json "* ]]; then',
    '    printf "%s" "$FAKE_RESOLVED_COMPOSE_JSON"',
    '    return 0',
    '  fi',
    '  if [ "$1" = "build" ]; then',
    '    if [ -e "$STAGING_APP_DIR/old-only.txt" ]; then printf "build-after-mutation\\n" >> "$COMMAND_LOG"; fi',
    '    input_sha="$(sha256sum | awk \'{print $1}\')"',
    '    printf "stdin-sha|%s\\n" "$input_sha" >> "$COMMAND_LOG"',
    '    if [ "${FAKE_MUTATE_FROZEN_AFTER_BUILD:-0}" = "1" ]; then',
    '      frozen="$(cat "$COMMAND_LOG.frozen-path")"',
    '      chmod u+w "$frozen"',
    '      printf "changed-after-build" >> "$frozen"',
    '    fi',
    '    if [ "${FAKE_BUILD_FAIL:-0}" = "1" ]; then return 9; fi',
    '    printf "%s\\n" "$CANDIDATE_IMAGE_ID" > "$COMMAND_LOG.release-state"',
    '  fi',
    '  if [ "$1" = "image" ] && [ "$2" = "inspect" ]; then target="${@: -1}"; if [[ "$target" == easyboost-staging-app:release-* ]] && [ -f "$COMMAND_LOG.inspect-after-release-rm" ]; then case "${FAKE_RELEASE_INSPECT_AFTER_RM_STATUS:-}" in 124) return 124 ;; 128) printf "daemon unavailable\\n" >&2; return 128 ;; 1) printf "ambiguous inspect failure\\n" >&2; return 1 ;; esac; fi; case "$target" in easyboost-staging-app:release-*) if [ ! -f "$COMMAND_LOG.release-state" ]; then printf "Error response from daemon: No such image: %s\\n" "$target" >&2; return 1; fi; cat "$COMMAND_LOG.release-state" ;; easyboost-staging-app:local) if [ ! -f "$COMMAND_LOG.image-state" ]; then printf "Error response from daemon: No such image: %s\\n" "$target" >&2; return 1; fi; cat "$COMMAND_LOG.image-state" ;; postgres:17-alpine) if [ "${FAKE_POSTGRES_DRIFT_ONCE:-0}" = "1" ] && grep -q "$CANDIDATE_IMAGE_ID" "$COMMAND_LOG.image-state" 2>/dev/null && [ ! -f "$COMMAND_LOG.postgres-drifted" ]; then : > "$COMMAND_LOG.postgres-drifted"; printf "%s\\n" "$DRIFTED_POSTGRES_IMAGE_ID"; else printf "%s\\n" "$POSTGRES_IMAGE_ID"; fi ;; *) return 1 ;; esac; return 0; fi',
    '  if [ "$1" = "image" ] && [ "$2" = "ls" ]; then reference="${@: -1}"; reference="${reference#reference=}"; if [[ "$reference" == easyboost-staging-app:release-* ]] && [ ! -f "$COMMAND_LOG.release-state" ]; then case "${FAKE_RELEASE_PROBE_BEFORE_BUILD_STATUS:-}" in 124) return 124 ;; 128) printf "daemon unavailable\\n" >&2; return 128 ;; 1) printf "ambiguous probe failure\\n" >&2; return 1 ;; esac; fi; if [[ "$reference" == easyboost-staging-app:release-* ]] && [ -f "$COMMAND_LOG.inspect-after-release-rm" ]; then case "${FAKE_RELEASE_INSPECT_AFTER_RM_STATUS:-}" in 124) return 124 ;; 128) printf "daemon unavailable\\n" >&2; return 128 ;; 1) printf "ambiguous inspect failure\\n" >&2; return 1 ;; esac; fi; case "$reference" in easyboost-staging-app:release-*) [ ! -f "$COMMAND_LOG.release-state" ] || cat "$COMMAND_LOG.release-state" ;; easyboost-staging-app:local) [ ! -f "$COMMAND_LOG.image-state" ] || cat "$COMMAND_LOG.image-state" ;; postgres:17-alpine) printf "%s\\n" "$POSTGRES_IMAGE_ID" ;; esac; return 0; fi',
    '  if [ "$1" = "image" ] && [ "$2" = "tag" ]; then if [ "${FAKE_PROMOTE_SIDE_EFFECT_ERROR:-0}" = "1" ] && [[ "$3" == easyboost-staging-app:release-* ]]; then printf "%s\\n" "$CANDIDATE_IMAGE_ID" > "$COMMAND_LOG.image-state"; return 8; fi; if [ "${FAKE_PROMOTE_FAIL:-0}" = "1" ] && [[ "$3" == easyboost-staging-app:release-* ]]; then return 8; fi; if [ "${FAKE_RECOVERY_RETAG_FAIL:-0}" = "1" ] && [ "$3" = "$PREVIOUS_IMAGE_ID" ]; then return 18; fi; if [ "$4" = "easyboost-staging-app:local" ]; then if [ "$3" = "$PREVIOUS_IMAGE_ID" ]; then printf "%s\\n" "$3" > "$COMMAND_LOG.image-state"; else printf "%s\\n" "$CANDIDATE_IMAGE_ID" > "$COMMAND_LOG.image-state"; [ "${FAKE_RELEASE_IMAGE_DRIFT_BEFORE_RM:-0}" != "1" ] || printf "%s\\n" "$FOREIGN_IMAGE_ID" > "$COMMAND_LOG.release-state"; fi; fi; return 0; fi',
    '  if [ "$1" = "image" ] && [ "$2" = "rm" ]; then if [ "${FAKE_IMAGE_RM_FAIL:-0}" = "1" ]; then return 19; fi; case "${@: -1}" in easyboost-staging-app:local) rm -f "$COMMAND_LOG.image-state" ;; easyboost-staging-app:release-*) rm -f "$COMMAND_LOG.release-state"; [ -z "${FAKE_RELEASE_INSPECT_AFTER_RM_STATUS:-}" ] || : > "$COMMAND_LOG.inspect-after-release-rm" ;; esac; return 0; fi',
    '  if [ "$1" = "inspect" ]; then',
    '    target="${@: -1}"',
    '    if [ -f "$COMMAND_LOG.postgres-container-id-state" ] && [ "$target" = "$(cat "$COMMAND_LOG.postgres-container-id-state")" ]; then',
    '      [ -f "$COMMAND_LOG.postgres-container-state" ] || return 1',
    '      if [[ " $* " == *" --format {{json .}} "* ]]; then',
    '        postgres_health="${FAKE_POSTGRES_HEALTH:-healthy}"; postgres_running="${FAKE_POSTGRES_RUNNING:-true}"; postgres_mount_type="${FAKE_POSTGRES_MOUNT_TYPE:-volume}"; postgres_volume_name="${FAKE_POSTGRES_VOLUME_NAME:-easyboost-staging_postgres-data}"; postgres_volume_source="${FAKE_POSTGRES_VOLUME_SOURCE:-$(cat "$COMMAND_LOG.postgres-volume-source-state")}"',
    '        printf \'{"Id":"%s","Image":"%s","Config":{"Labels":{"com.docker.compose.project":"%s","com.docker.compose.service":"%s","com.docker.compose.oneoff":"%s"}},"State":{"Running":%s,"Health":{"Status":"%s"}},"Mounts":[{"Type":"%s","Name":"%s","Source":"%s","Destination":"%s","Driver":"%s","Mode":"%s","Propagation":"%s","RW":%s}]}\\n\' "$target" "$(cat "$COMMAND_LOG.postgres-container-state")" "${FAKE_POSTGRES_PROJECT:-easyboost-staging}" "${FAKE_POSTGRES_SERVICE:-postgres}" "${FAKE_POSTGRES_ONEOFF:-False}" "$postgres_running" "$postgres_health" "$postgres_mount_type" "$postgres_volume_name" "$postgres_volume_source" "${FAKE_POSTGRES_MOUNT_DESTINATION:-/var/lib/postgresql/data}" "${FAKE_POSTGRES_MOUNT_DRIVER:-local}" "${FAKE_POSTGRES_MOUNT_MODE:-z}" "${FAKE_POSTGRES_MOUNT_PROPAGATION:-}" "${FAKE_POSTGRES_MOUNT_RW:-true}"',
    '      else cat "$COMMAND_LOG.postgres-container-state"; fi',
    '    else',
    '      [ -f "$COMMAND_LOG.container-state" ] || return 1',
    '      if [ "${FAKE_RUNNING_IMAGE_DRIFT:-0}" = "1" ]; then printf "%s\\n" "$DRIFTED_RUNNING_IMAGE_ID"; else cat "$COMMAND_LOG.container-state"; fi',
    '    fi',
    '    return 0',
    '  fi',
    '  case " $* " in *" ps -q app "*) [ ! -f "$COMMAND_LOG.container-state" ] || printf "%s\\n" "$APP_CONTAINER_ID" ;; esac',
    '  if [[ " $* " == *" up --pull never -d --no-build --no-deps app "* ]]; then count=0; [ -f "$COMMAND_LOG.up-count" ] && count="$(cat "$COMMAND_LOG.up-count")"; count=$((count+1)); printf "%s\\n" "$count" > "$COMMAND_LOG.up-count"; if [ "${FAKE_RECOVERY_UP_FAIL:-0}" = "1" ] && [ "$count" -ge 2 ]; then return 20; fi; cat "$COMMAND_LOG.image-state" > "$COMMAND_LOG.container-state"; [ "${FAKE_POSTGRES_DRIFT_AFTER_APP_UP:-0}" != "1" ] || printf "%s\\n" "$DRIFTED_POSTGRES_CONTAINER_ID" > "$COMMAND_LOG.postgres-container-id-state"; [ "${FAKE_POSTGRES_MOUNT_DRIFT_AFTER_APP_UP:-0}" != "1" ] || printf "/var/lib/docker/volumes/foreign/_data\\n" > "$COMMAND_LOG.postgres-volume-source-state"; [ "${FAKE_POSTGRES_VOLUME_OBJECT_DRIFT_AFTER_APP_UP:-0}" != "1" ] || printf "/var/lib/docker/volumes/foreign-object/_data\\n" > "$COMMAND_LOG.postgres-volume-object-source-state"; fi',
    '  return 0',
    '}',
    'curl() { count=0; [ -f "$COMMAND_LOG.curl-count" ] && count="$(cat "$COMMAND_LOG.curl-count")"; count=$((count+1)); printf "%s\\n" "$count" > "$COMMAND_LOG.curl-count"; up_count=0; [ -f "$COMMAND_LOG.up-count" ] && up_count="$(cat "$COMMAND_LOG.up-count")"; if [ "${FAKE_RECOVERY_READINESS_FAIL:-0}" = "1" ] && [ "$up_count" -ge 2 ]; then return 1; fi; if [ "${FAKE_READINESS_FAIL:-0}" = "1" ] && grep -q "$CANDIDATE_IMAGE_ID" "$COMMAND_LOG.image-state" 2>/dev/null; then return 1; fi; return 0; }',
    'sleep() { return 0; }',
    'source() {',
    '  builtin source "$@" || return',
    '  case "${1:-}" in',
    '    */staging-release-common.sh)',
    '      run_bounded() {',
    '        local requested="$1" remaining bound',
    '        shift',
    '        remaining="$requested"',
    '        if [ "$transaction_deadline" -gt 0 ]; then',
    '          remaining=$((transaction_deadline - SECONDS))',
    '          [ "$remaining" -gt 0 ] || return 124',
    '        fi',
    '        bound="$requested"',
    '        [ "$remaining" -ge "$bound" ] || bound="$remaining"',
    '        timeout --signal=TERM --kill-after=5s "${bound}s" "$@"',
    '      }',
    '      ;;',
    '  esac',
    '}',
    '',
  ].join('\n'));
  for (const command of ['cp', 'curl', 'docker', 'fallocate', 'find', 'mv', 'rm',
    'sha256sum', 'sleep', 'stat', 'timeout']) {
    const executable = path.join(root, command);
    await fs.writeFile(executable, [
      '#!/bin/bash',
      'source "$(dirname "$0")/commands.sh"',
      `${command} "$@"`,
      '',
    ].join('\n'));
    await fs.chmod(executable, 0o755);
  }
  return {
    appDir,
    bashEnv,
    commandLog,
    current,
    root,
    target,
  };
}

function runRollback(fixture, sha = fixture.target.sha, extraEnv = {}, protocol = 'immutable-archive-v4',
  bundleDigest = sourceBundleDigest) {
  const arguments_ = [sha, protocol, bundleDigest];
  const configuration = Buffer.from(JSON.stringify({
    arguments: arguments_,
    bash: gitBash,
    controlKey: `staging-deadline-test:rollback:${rollbackScript}:${JSON.stringify(arguments_)}`,
    recoverySeconds: 600,
    script: posixPath(rollbackScript),
    transactionSeconds: 1_800,
  })).toString('base64url');
  return spawnSync(process.execPath, [deadlineHarness, configuration], {
    encoding: 'utf8',
    env: {
      ...process.env,
      BASH_ENV: posixPath(fixture.bashEnv),
      PATH: `${path.dirname(fixture.bashEnv)}${path.delimiter}${process.env.PATH}`,
      COMMAND_LOG: posixPath(fixture.commandLog),
      EASYBOOST_HOST_OPERATION_LOCK_DIR: posixPath(path.join(fixture.root, 'host-operation.lock')),
      EASYBOOST_STAGING_DEADLINE_TEST_CONTROL_ROOT:
        path.join(fixture.root, 'deadline-controls'),
      EASYBOOST_STAGING_SESSION_TEST_CONTROL_ROOT:
        path.join(fixture.root, 'session-controls'),
      FAKE_RESOLVED_COMPOSE_JSON: JSON.stringify(approvedComposeModel(fixture.appDir)),
      STAGING_APP_DIR: posixPath(fixture.appDir),
      ...extraEnv,
    },
  });
}

function assertComposeUsesCapturedPostgresAuthority(log, requiredCommands = []) {
  const authorityLines = log.split(/\r?\n/u)
    .filter((line) => line.startsWith('compose-postgres-authority|'));
  assert.ok(authorityLines.length > 0, log);
  assert.ok(authorityLines.every((line) => (
    line.startsWith(`compose-postgres-authority|${POSTGRES_IMAGE_ID}|`)
  )), authorityLines.join('\n'));
  for (const command of requiredCommands) {
    assert.ok(authorityLines.some((line) => line.endsWith(`|${command}`)),
      `missing captured PostgreSQL authority for Compose ${command}:\n${authorityLines.join('\n')}`);
  }
}

const CRC32_TABLE = Uint32Array.from({ length: 256 }, (_, byte) => {
  let value = byte;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
  }
  return value >>> 0;
});

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = CRC32_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function tarArchive(entries) {
  const blocks = [];
  for (const { name, body = Buffer.alloc(0), type = '0' } of entries) {
    const header = Buffer.alloc(512);
    header.write(name, 0, 100, 'utf8');
    header.write('0000644\0', 100, 8, 'ascii');
    header.write('0000000\0', 108, 8, 'ascii');
    header.write('0000000\0', 116, 8, 'ascii');
    header.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
    header.write('00000000000\0', 136, 12, 'ascii');
    header.fill(0x20, 148, 156);
    header[156] = type.charCodeAt(0);
    header.write('ustar\0', 257, 6, 'ascii');
    header.write('00', 263, 2, 'ascii');
    header.write('0000000\0', 329, 8, 'ascii');
    header.write('0000000\0', 337, 8, 'ascii');
    const checksum = header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0');
    header.write(checksum, 148, 6, 'ascii');
    header[154] = 0;
    header[155] = 0x20;
    blocks.push(header, body, Buffer.alloc(Math.ceil(body.length / 512) * 512 - body.length));
  }
  blocks.push(Buffer.alloc(1024));
  const tar = Buffer.concat(blocks);
  const trailer = Buffer.alloc(8);
  trailer.writeUInt32LE(crc32(tar), 0);
  trailer.writeUInt32LE(tar.length >>> 0, 4);
  return Buffer.concat([
    Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x02, 0xff]),
    deflateRawSync(tar, { level: 9 }), trailer,
  ]);
}

test('rollback requires the exact immutable-archive-v4 handshake and bundle digest before state access', async (context) => {
  const fixture = await createFixture();
  context.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  const baseline = await fs.readFile(fixture.commandLog, 'utf8').catch(() => '');
  for (const args of [
    [], [fixture.target.sha], [fixture.target.sha, 'immutable-archive-v1'],
    [fixture.target.sha, 'immutable-archive-v2'], [fixture.target.sha, 'immutable-archive-v3'],
    ['immutable-archive-v4', fixture.target.sha, sourceBundleDigest],
    [fixture.target.sha, 'immutable-archive-v4'],
    [fixture.target.sha, 'immutable-archive-v4', 'not-a-digest'],
    [fixture.target.sha, 'immutable-archive-v4', sourceBundleDigest, 'extra'],
  ]) {
    const result = runBash([posixPath(rollbackScript), ...args], {
      env: {
        ...process.env,
        BASH_ENV: posixPath(fixture.bashEnv),
        COMMAND_LOG: posixPath(fixture.commandLog),
        STAGING_APP_DIR: posixPath(fixture.appDir),
      },
    });
    assert.equal(result.status, 64, `${JSON.stringify(args)}: ${result.stderr}`);
    assert.equal(await fs.readFile(fixture.commandLog, 'utf8').catch(() => ''), baseline,
      'stale protocol must fail before Docker/state access');
  }
});

test('staging rollback requires a full SHA and builds that retained exact archive before activation', async (context) => {
  const probe = runBash(['--version']);
  if (!probe) return context.skip('Git Bash is not installed');
  const fixture = await createFixture();
  context.after(() => fs.rm(fixture.root, { recursive: true, force: true }));

  const result = runRollback(fixture, fixture.target.sha, {
    EASYBOOST_STAGING_BUILD_CONTEXT: '/untrusted/live-tree',
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(await fs.readFile(path.join(fixture.appDir, 'shared.txt'), 'utf8'), 'old\n');
  assert.equal(await fs.readFile(path.join(fixture.appDir, 'old-only.txt'), 'utf8'), 'old-only\n');
  await assert.rejects(fs.access(path.join(fixture.appDir, 'new-only.txt')), { code: 'ENOENT' });
  assert.equal(await fs.readFile(path.join(fixture.appDir, '.env.staging'), 'utf8'),
    'APP_PORT=3001\nSECRET=preserved\n');
  assert.equal(await fs.readFile(path.join(fixture.appDir, '.release-sha256'), 'utf8'),
    `${fixture.target.sha}\n`);
  const log = (await fs.readFile(fixture.commandLog, 'utf8')).trim().split(/\r?\n/u);
  const build = log.findIndex((line) => line === `docker|build --file Dockerfile --tag easyboost-staging-app:release-${fixture.target.sha} -`);
  const stdin = log.findIndex((line) => line === `stdin-sha|${fixture.target.sha}`);
  const promote = log.findIndex((line) => line.includes(`image tag easyboost-staging-app:release-${fixture.target.sha} easyboost-staging-app:local`));
  const up = log.findIndex((line) => (
    /docker\|compose .* up --pull never -d --no-build --no-deps app$/u.test(line)
  ));
  const cleanup = log.findIndex((line) => line.includes(`image rm -f easyboost-staging-app:release-${fixture.target.sha}`));
  assert.ok(build >= 0 && stdin > build && promote > stdin && up > promote && cleanup > up, log.join('\n'));
  assert.equal(log.includes('build-after-mutation'), false);
  assert.doesNotMatch(log.join('\n'), /--build/u);
  assert.doesNotMatch(log.join('\n'), /up --pull never -d --no-build app/u);
  assert.equal(await fs.readFile(`${fixture.commandLog}.postgres-container-state`, 'utf8'),
    `${POSTGRES_IMAGE_ID}\n`, 'rollback app activation must preserve the PostgreSQL image identity');
  assert.equal(await fs.readFile(`${fixture.commandLog}.postgres-container-id-state`, 'utf8'),
    `${POSTGRES_CONTAINER_ID}\n`, 'rollback app activation must preserve the PostgreSQL container identity');
  assert.equal(await fs.readFile(`${fixture.commandLog}.postgres-volume-source-state`, 'utf8'),
    `${POSTGRES_VOLUME_SOURCE}\n`, 'rollback app activation must preserve the PostgreSQL volume mount');
  assertComposeUsesCapturedPostgresAuthority(log.join('\n'), [
    'config', 'up',
  ]);
});

test('rollback rejects missing, abbreviated, unknown and tampered release identities before Docker', async (context) => {
  const probe = runBash(['--version']);
  if (!probe) return context.skip('Git Bash is not installed');
  for (const [label, value, expected] of [
    ['missing', undefined, 64],
    ['abbreviated', 'a'.repeat(12), 64],
    ['unknown', 'b'.repeat(64), 65],
  ]) {
    const fixture = await createFixture();
    context.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
    const result = value === undefined
      ? runBash([posixPath(rollbackScript)], {
        env: { ...process.env, BASH_ENV: posixPath(fixture.bashEnv), COMMAND_LOG: posixPath(fixture.commandLog), STAGING_APP_DIR: posixPath(fixture.appDir) },
      })
      : runRollback(fixture, value);
    assert.equal(result.status, expected, `${label}: ${result.stdout}\n${result.stderr}`);
    assert.equal(await fs.readFile(path.join(fixture.appDir, 'shared.txt'), 'utf8'), 'new\n');
    await assert.rejects(fs.access(fixture.commandLog), { code: 'ENOENT' });
  }

  const fixture = await createFixture();
  context.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  const stored = path.join(
    fixture.appDir, 'rollbacks', 'releases', `release-${fixture.target.sha}.tar.gz`,
  );
  await fs.appendFile(stored, 'tampered');
  const tampered = runRollback(fixture);
  assert.equal(tampered.status, 67, `${tampered.stdout}\n${tampered.stderr}`);
  assert.equal(await fs.readFile(path.join(fixture.appDir, 'shared.txt'), 'utf8'), 'new\n',
    `${tampered.stdout}\n${tampered.stderr}`);
  await assert.rejects(fs.access(fixture.commandLog), { code: 'ENOENT' });
});

test('rollback refuses stable-tag versus running-container drift before build or mutation', async (context) => {
  const fixture = await createFixture();
  context.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  const marker = await fs.readFile(path.join(fixture.appDir, '.release-sha256'), 'utf8');
  const result = runRollback(fixture, fixture.target.sha, { FAKE_RUNNING_IMAGE_DRIFT: '1' });
  assert.equal(result.status, 67, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /predecessor snapshot|running image|active/iu);
  const log = await fs.readFile(fixture.commandLog, 'utf8');
  assert.doesNotMatch(log, /docker\|build /u);
  assert.equal(await fs.readFile(path.join(fixture.appDir, '.release-sha256'), 'utf8'), marker);
  assert.equal(await fs.readFile(path.join(fixture.appDir, 'new-only.txt'), 'utf8'), 'new-only\n');
});

test('rollback rejects normalized-name collisions in an exact retained archive before Docker', async (context) => {
  const probe = runBash(['--version']);
  if (!probe) return context.skip('Git Bash is not installed');
  const fixture = await createFixture();
  context.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  const bytes = tarArchive([
    { name: '.dockerignore', body: Buffer.from('/backups\n') },
    { name: 'Dockerfile', body: Buffer.from('FROM scratch\n') },
    { name: './Dockerfile', body: Buffer.from('FROM unverified\n') },
    { name: 'compose.staging.yml', body: Buffer.from('services:\n') },
  ]);
  const sha = crypto.createHash('sha256').update(bytes).digest('hex');
  const stored = path.join(fixture.appDir, 'rollbacks', 'releases', `release-${sha}.tar.gz`);
  await fs.writeFile(stored, bytes);
  await fs.writeFile(`${stored}.sha256`, `${sha}\n`);
  await Promise.all([fs.chmod(stored, 0o600), fs.chmod(`${stored}.sha256`, 0o600)]);

  const result = runRollback(fixture, sha);
  assert.equal(result.status, 67, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /non-canonical member name|collision/u);
  assert.equal(await fs.readFile(path.join(fixture.appDir, 'shared.txt'), 'utf8'), 'new\n',
    `${result.stdout}\n${result.stderr}`);
  await assert.rejects(fs.access(fixture.commandLog), { code: 'ENOENT' });
});

test('a failed rollback image build preserves the active release and proves no release tag', async (context) => {
  const probe = runBash(['--version']);
  if (!probe) return context.skip('Git Bash is not installed');
  const fixture = await createFixture();
  context.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  const result = runRollback(fixture, fixture.target.sha, { FAKE_BUILD_FAIL: '1' });
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(await fs.readFile(path.join(fixture.appDir, 'shared.txt'), 'utf8'), 'new\n');
  assert.equal(await fs.readFile(path.join(fixture.appDir, '.release-sha256'), 'utf8'),
    `${fixture.current.sha}\n`);
  const log = await fs.readFile(fixture.commandLog, 'utf8');
  assert.match(log, new RegExp(`docker\\|build .*release-${fixture.target.sha}`, 'u'));
  await assert.rejects(fs.access(`${fixture.commandLog}.release-state`), { code: 'ENOENT' });
  assert.doesNotMatch(log, /image tag| up -d app|--build/u);
});

test('rollback detects a post-build target archive mutation before promotion', async (context) => {
  const probe = runBash(['--version']);
  if (!probe) return context.skip('Git Bash is not installed');
  const fixture = await createFixture();
  context.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  const result = runRollback(fixture, fixture.target.sha, {
    FAKE_MUTATE_FROZEN_AFTER_BUILD: '1',
  });
  assert.equal(result.status, 65, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /changed during image build/u);
  assert.equal(await fs.readFile(path.join(fixture.appDir, 'shared.txt'), 'utf8'), 'new\n');
  assert.equal(await fs.readFile(path.join(fixture.appDir, '.release-sha256'), 'utf8'),
    `${fixture.current.sha}\n`);
  const log = await fs.readFile(fixture.commandLog, 'utf8');
  assert.doesNotMatch(log, /image tag| up -d |--build/u);
});

test('a failed rollback stable-tag promotion keeps the current marker and tree', async (context) => {
  const probe = runBash(['--version']);
  if (!probe) return context.skip('Git Bash is not installed');
  const fixture = await createFixture();
  context.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  const result = runRollback(fixture, fixture.target.sha, { FAKE_PROMOTE_FAIL: '1' });
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(await fs.readFile(path.join(fixture.appDir, 'shared.txt'), 'utf8'), 'new\n');
  assert.equal(await fs.readFile(path.join(fixture.appDir, '.release-sha256'), 'utf8'),
    `${fixture.current.sha}\n`);
  const log = await fs.readFile(fixture.commandLog, 'utf8');
  assert.match(log, /docker\|image tag /u);
  assert.match(log, /docker\|image rm /u);
  assert.doesNotMatch(log, / up -d |--build/u);
});

test('rollback reconciles a stable tag changed before Docker reports promotion failure', async (context) => {
  const fixture = await createFixture();
  context.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  const result = runRollback(fixture, fixture.target.sha, {
    FAKE_PROMOTE_SIDE_EFFECT_ERROR: '1',
  });
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(await fs.readFile(`${fixture.commandLog}.image-state`, 'utf8'),
    `${PREVIOUS_IMAGE_ID}\n`);
  assert.equal(await fs.readFile(path.join(fixture.appDir, '.release-sha256'), 'utf8'),
    `${fixture.current.sha}\n`);
  assert.equal(await fs.readFile(path.join(fixture.appDir, 'shared.txt'), 'utf8'), 'new\n');
});

test('rollback readiness failure restores the previous image, code and marker', async (context) => {
  const probe = runBash(['--version']);
  if (!probe) return context.skip('Git Bash is not installed');
  const fixture = await createFixture();
  context.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  const result = runRollback(fixture, fixture.target.sha, { FAKE_READINESS_FAIL: '1' });
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(await fs.readFile(path.join(fixture.appDir, 'shared.txt'), 'utf8'), 'new\n',
    `${result.stdout}\n${result.stderr}`);
  assert.equal(await fs.readFile(path.join(fixture.appDir, 'new-only.txt'), 'utf8'), 'new-only\n');
  await assert.rejects(fs.access(path.join(fixture.appDir, 'old-only.txt')), { code: 'ENOENT' });
  assert.equal(await fs.readFile(path.join(fixture.appDir, '.release-sha256'), 'utf8'),
    `${fixture.current.sha}\n`);
  const log = await fs.readFile(fixture.commandLog, 'utf8');
  assert.match(log,
    new RegExp(`docker\\|image tag ${PREVIOUS_IMAGE_ID} easyboost-staging-app:local`, 'u'));
  assert.equal((log.match(/up --pull never -d --no-build --no-deps app/gu) ?? []).length, 2, log);
  await assert.rejects(fs.access(path.join(fixture.appDir, '.staging-recovery-required')),
    { code: 'ENOENT' });
  assert.match(result.stderr, /verified prior state restored/u);
});

test('rollback marker publication failure retains recovery capacity and restores the active snapshot', async (context) => {
  const fixture = await createFixture();
  context.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  const result = runRollback(fixture, fixture.target.sha, {
    FAKE_ACTIVE_MARKER_PUBLISH_FAIL: '1',
  });
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(await fs.readFile(path.join(fixture.appDir, '.release-sha256'), 'utf8'),
    `${fixture.current.sha}\n`);
  assert.equal(await fs.readFile(path.join(fixture.appDir, 'shared.txt'), 'utf8'), 'new\n');
  assert.equal(await fs.readFile(`${fixture.commandLog}.image-state`, 'utf8'),
    `${PREVIOUS_IMAGE_ID}\n`);
  assert.match(result.stderr, /verified prior state restored/u);
});

test('rollback transaction-clear and every later retirement failure preserve the committed target',
  async (context) => {
    for (const [step, flag] of [
      ['clear committed rollback transaction marker', 'FAKE_TRANSACTION_MARKER_RM_FAIL'],
      ['remove temporary rollback image', 'FAKE_IMAGE_RM_FAIL'],
      ['release rollback disk reservations', 'FAKE_RESERVATION_RM_FAIL'],
      ['remove private rollback work directory', 'FAKE_WORKDIR_RM_FAIL'],
    ]) {
      const fixture = await createFixture();
      context.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
      const result = runRollback(fixture, fixture.target.sha, { [flag]: '1' });
      assert.equal(result.status, 70, `${step}: ${result.stdout}\n${result.stderr}`);
      assert.equal(await fs.readFile(path.join(fixture.appDir, '.release-sha256'), 'utf8'),
        `${fixture.target.sha}\n`, step);
      assert.equal(await fs.readFile(path.join(fixture.appDir, 'old-only.txt'), 'utf8'),
        'old-only\n', step);
      assert.equal(await fs.readFile(`${fixture.commandLog}.image-state`, 'utf8'),
        `${CANDIDATE_IMAGE_ID}\n`, step);
      assert.match(await fs.readFile(
        path.join(fixture.appDir, '.staging-recovery-required'), 'utf8',
      ), new RegExp(step.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'),
      `${step}\n${result.stdout}\n${result.stderr}`);
      assert.doesNotMatch(await fs.readFile(fixture.commandLog, 'utf8'),
        new RegExp(`image tag ${PREVIOUS_IMAGE_ID} easyboost-staging-app:local`, 'u'), step);
      assert.doesNotMatch(result.stdout, /rollback_release_sha256=|staging_ready=/u, step);
    }
  });

test('rollback recovery claims verified prior state only after every exact cleanup boundary',
  async (context) => {
    for (const [step, flag] of [
      ['remove temporary rollback image', 'FAKE_IMAGE_RM_FAIL'],
      ['release rollback disk reservations', 'FAKE_RESERVATION_RM_FAIL'],
      ['remove private rollback work directory', 'FAKE_WORKDIR_RM_FAIL'],
      ['remove completed rollback recovery transaction marker', 'FAKE_TRANSACTION_MARKER_RM_FAIL'],
    ]) {
      const fixture = await createFixture();
      context.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
      const result = runRollback(fixture, fixture.target.sha, {
        FAKE_READINESS_FAIL: '1', [flag]: '1',
      });
      assert.equal(result.status, 70, `${step}: ${result.stdout}\n${result.stderr}`);
      assert.doesNotMatch(result.stderr, /verified prior state restored/u, step);
      assert.doesNotMatch(result.stdout, /rollback_release_sha256=|staging_ready=/u, step);
      assert.match(await fs.readFile(
        path.join(fixture.appDir, '.staging-recovery-required'), 'utf8',
      ), new RegExp(step.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'), step);
    }
  });

test('rollback recovery accepts only an authoritative exact-not-found after temporary image removal',
  async (context) => {
    for (const status of ['124', '128', '1']) {
      const fixture = await createFixture();
      context.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
      const result = runRollback(fixture, fixture.target.sha, {
        FAKE_READINESS_FAIL: '1', FAKE_RELEASE_INSPECT_AFTER_RM_STATUS: status,
      });
      assert.equal(result.status, 70, `inspect ${status}: ${result.stdout}\n${result.stderr}`);
      assert.doesNotMatch(result.stderr, /verified prior state restored/u, status);
      assert.doesNotMatch(result.stdout, /rollback_release_sha256=|staging_ready=/u, status);
      assert.match(await fs.readFile(
        path.join(fixture.appDir, '.staging-recovery-required'), 'utf8',
      ), /remove temporary rollback image/u, status);
    }
  });

test('rollback success cannot be claimed after an indeterminate temporary image probe',
  async (context) => {
    for (const status of ['124', '128', '1']) {
      const fixture = await createFixture();
      context.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
      const result = runRollback(fixture, fixture.target.sha, {
        FAKE_RELEASE_INSPECT_AFTER_RM_STATUS: status,
      });
      assert.equal(result.status, 70, `probe ${status}: ${result.stdout}\n${result.stderr}`);
      assert.doesNotMatch(result.stdout, /rollback_release_sha256=|staging_ready=/u, status);
      assert.match(await fs.readFile(
        path.join(fixture.appDir, '.staging-recovery-required'), 'utf8',
      ), /remove temporary rollback image/u, status);
    }
  });

test('rollback never removes a temporary image reference after its captured identity drifts',
  async (context) => {
    const fixture = await createFixture();
    context.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
    const result = runRollback(fixture, fixture.target.sha, {
      FAKE_RELEASE_IMAGE_DRIFT_BEFORE_RM: '1',
    });
    assert.equal(result.status, 70, `${result.stdout}\n${result.stderr}`);
    assert.doesNotMatch(result.stdout, /rollback_release_sha256=|staging_ready=/u);
    assert.doesNotMatch(await fs.readFile(fixture.commandLog, 'utf8'),
      new RegExp(`image rm -f easyboost-staging-app:release-${fixture.target.sha}`, 'u'),
      'a foreign replacement behind the exact temporary tag must never be deleted');
    assert.match(await fs.readFile(
      path.join(fixture.appDir, '.staging-recovery-required'), 'utf8',
    ), /remove temporary rollback image/u);
  });

test('rollback success and recovery reject reservation debris and late active-image drift',
  async (context) => {
    for (const [label, extraEnv] of [
      ['normal reservation debris', { FAKE_ADD_STORE_ENTRY_AFTER_RESERVATION_RELEASE: '1' }],
      ['normal active image drift', { FAKE_ACTIVE_IMAGE_DRIFT_AFTER_WORKDIR_REMOVAL: '1' }],
      ['recovery reservation debris', {
        FAKE_READINESS_FAIL: '1', FAKE_ADD_STORE_ENTRY_AFTER_RESERVATION_RELEASE: '1',
      }],
      ['recovery active image drift', {
        FAKE_READINESS_FAIL: '1', FAKE_ACTIVE_IMAGE_DRIFT_AFTER_WORKDIR_REMOVAL: '1',
      }],
    ]) {
      const fixture = await createFixture();
      context.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
      const result = runRollback(fixture, fixture.target.sha, extraEnv);
      assert.equal(result.status, 70, `${label}: ${result.stdout}\n${result.stderr}`);
      assert.doesNotMatch(result.stderr, /verified prior state restored/u, label);
      assert.doesNotMatch(result.stdout, /rollback_release_sha256=|staging_ready=/u, label);
      assert.match(await fs.readFile(
        path.join(fixture.appDir, '.staging-recovery-required'), 'utf8',
      ), /verify final (?:restored|committed) rollback release state/u, label);
    }
  });

test('rollback recovery preserves the first causal recovery step over later cleanup failures',
  async (context) => {
    const fixture = await createFixture();
    context.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
    const result = runRollback(fixture, fixture.target.sha, {
      FAKE_READINESS_FAIL: '1',
      FAKE_RECOVERY_COPY_FAIL: '1',
      FAKE_RESERVATION_RM_FAIL: '1',
    });
    assert.equal(result.status, 70, `${result.stdout}\n${result.stderr}`);
    const marker = await fs.readFile(
      path.join(fixture.appDir, '.staging-recovery-required'), 'utf8');
    assert.match(marker, /recovery_step=restore previous code tree/u);
    assert.doesNotMatch(marker, /release rollback disk reservations/u);
    assert.doesNotMatch(result.stderr, /verified prior state restored/u);
  });

test('rollback pins the PostgreSQL image through the final pre-activation boundary', async (context) => {
  const fixture = await createFixture();
  context.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  const result = runRollback(fixture, fixture.target.sha, { FAKE_POSTGRES_DRIFT_ONCE: '1' });
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /postgres.*identity changed/iu);
  assert.equal(await fs.readFile(path.join(fixture.appDir, '.release-sha256'), 'utf8'),
    `${fixture.current.sha}\n`);
  const log = await fs.readFile(fixture.commandLog, 'utf8');
  assert.equal((log.match(/up --pull never -d --no-build --no-deps app/gu) ?? []).length, 1);
  assertComposeUsesCapturedPostgresAuthority(log, [
    'config', 'up',
  ]);
});

test('rollback rejects an unhealthy PostgreSQL and fails closed on post-activation identity drift',
  async (context) => {
    const unhealthy = await createFixture();
    context.after(() => fs.rm(unhealthy.root, { recursive: true, force: true }));
    const preflight = runRollback(unhealthy, unhealthy.target.sha, {
      FAKE_POSTGRES_HEALTH: 'starting',
    });
    assert.equal(preflight.status, 67, `${preflight.stdout}\n${preflight.stderr}`);
    assert.doesNotMatch(await fs.readFile(unhealthy.commandLog, 'utf8'),
      /docker\|build |image tag|up --pull never/iu);

    const drifted = await createFixture();
    context.after(() => fs.rm(drifted.root, { recursive: true, force: true }));
    const drift = runRollback(drifted, drifted.target.sha, {
      FAKE_POSTGRES_MOUNT_DRIFT_AFTER_APP_UP: '1',
    });
    assert.equal(drift.status, 70, `${drift.stdout}\n${drift.stderr}`);
    assert.match(drift.stderr, /PostgreSQL.*(?:container|volume).*identity changed/iu);
    assert.doesNotMatch(await fs.readFile(drifted.commandLog, 'utf8'), /down --volumes/iu);
    assert.match(await fs.readFile(
      path.join(drifted.appDir, '.staging-recovery-required'), 'utf8'),
    /protected staging authority changed/iu);
  });

test('rollback recovery failures are diagnosed separately and block later operations', async (context) => {
  const probe = runBash(['--version']);
  if (!probe) return context.skip('Git Bash is not installed');
  for (const [label, flag] of [
    ['retag', 'FAKE_RECOVERY_RETAG_FAIL'],
    ['remove', 'FAKE_RECOVERY_REMOVE_FAIL'],
    ['copy', 'FAKE_RECOVERY_COPY_FAIL'],
    ['compose-up', 'FAKE_RECOVERY_UP_FAIL'],
    ['readiness', 'FAKE_RECOVERY_READINESS_FAIL'],
  ]) {
    const fixture = await createFixture();
    context.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
    const result = runRollback(fixture, fixture.target.sha, {
      FAKE_READINESS_FAIL: '1', [flag]: '1',
    });
    assert.equal(result.status, 70, `${label}: ${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /Primary staging rollback failed with status 1; recovery failed at:/u);
    assert.match(await fs.readFile(
      path.join(fixture.appDir, '.staging-recovery-required'), 'utf8',
    ), /manual recovery required/u);
    const logBefore = (await fs.readFile(fixture.commandLog, 'utf8')).length;
    const blocked = runRollback(fixture, fixture.target.sha);
    assert.equal(blocked.status, 70, `${label}: ${blocked.stdout}\n${blocked.stderr}`);
    assert.equal((await fs.readFile(fixture.commandLog, 'utf8')).length, logBefore);
  }
});

test('rollback bounds live-tree and recovery copies under the shared transaction deadline', async (context) => {
  const liveCopy = await createFixture();
  context.after(() => fs.rm(liveCopy.root, { recursive: true, force: true }));
  const liveResult = runRollback(liveCopy, liveCopy.target.sha, {
    FAKE_LIVE_COPY_TIMEOUT: '1',
  });
  assert.equal(liveResult.status, 124, `${liveResult.stdout}\n${liveResult.stderr}`);
  assert.match(liveResult.stderr, /verified prior state restored/u);
  assert.equal(await fs.readFile(path.join(liveCopy.appDir, 'new-only.txt'), 'utf8'),
    'new-only\n');

  const recoveryCopy = await createFixture();
  context.after(() => fs.rm(recoveryCopy.root, { recursive: true, force: true }));
  const recoveryResult = runRollback(recoveryCopy, recoveryCopy.target.sha, {
    FAKE_READINESS_FAIL: '1', FAKE_RECOVERY_COPY_TIMEOUT: '1',
  });
  assert.equal(recoveryResult.status, 70, `${recoveryResult.stdout}\n${recoveryResult.stderr}`);
  assert.match(recoveryResult.stderr, /recovery failed at: restore previous code tree/u);
  assert.match(await fs.readFile(
    path.join(recoveryCopy.appDir, '.staging-recovery-required'), 'utf8',
  ), /manual recovery required[\s\S]*recovery_step=restore previous code tree/u);
});

test('the shared nonblocking release lock rejects concurrent rollback before store reads', async (context) => {
  const probe = runBash(['--version']);
  if (!probe) return context.skip('Git Bash is not installed');
  const fixture = await createFixture();
  context.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  const result = runRollback(fixture, fixture.target.sha, { FAKE_LOCK_BUSY: '1' });
  assert.equal(result.status, 75, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /release operation is active/u);
  assert.equal(await fs.readFile(path.join(fixture.appDir, 'shared.txt'), 'utf8'), 'new\n');
  await assert.rejects(fs.access(fixture.commandLog), { code: 'ENOENT' });
});
