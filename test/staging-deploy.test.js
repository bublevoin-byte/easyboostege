import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { gzipSync } from 'node:zlib';

import { createReleaseArchive } from '../scripts/staging-release-archive.js';
import { captureHelperBundle, HELPER_BUNDLE_FILES } from '../scripts/staging-helper-bundle.js';
import { verifyStagingComposeModel } from '../scripts/verify-staging-compose.js';

const gitBash = process.platform === 'win32' ? 'C:\\Program Files\\Git\\bin\\bash.exe' : 'bash';
const cutoverScript = path.resolve('scripts/staging-cutover.sh');
const deployScript = path.resolve('scripts/staging-deploy.sh');
const deadlineHarness = path.resolve('test/staging-deadline-test-harness.js');
const restartScript = path.resolve('scripts/staging-restart-app.sh');
const commonScript = path.resolve('scripts/staging-release-common.sh');
const sourceBundleDigest = captureHelperBundle({ sourceDirectory: path.resolve('scripts') }).bundleDigest;
const PREVIOUS_IMAGE_ID = `sha256:${'1'.repeat(64)}`;
const CANDIDATE_IMAGE_ID = `sha256:${'2'.repeat(64)}`;
const POSTGRES_IMAGE_ID = `sha256:${'3'.repeat(64)}`;
const DRIFTED_POSTGRES_IMAGE_ID = `sha256:${'4'.repeat(64)}`;
const STALE_IMAGE_ID = `sha256:${'5'.repeat(64)}`;
const STALE_RELEASE_IMAGE_ID = `sha256:${'6'.repeat(64)}`;
const FOREIGN_IMAGE_ID = `sha256:${'7'.repeat(64)}`;
const DRIFTED_RUNNING_IMAGE_ID = `sha256:${'8'.repeat(64)}`;
const APP_CONTAINER_ID = 'a'.repeat(64);
const POSTGRES_CONTAINER_ID = 'b'.repeat(64);
const DRIFTED_POSTGRES_CONTAINER_ID = 'c'.repeat(64);
const POSTGRES_VOLUME_SOURCE = '/var/lib/docker/volumes/easyboost-staging_postgres-data/_data';
const STAGING_TEST_TRANSACTION_SECONDS = 120;
const STAGING_TEST_RECOVERY_SECONDS = 60;

function posixPath(value) {
  return value.replace(/^([A-Za-z]):/u, (_, drive) => `/${drive.toLowerCase()}`).replaceAll('\\', '/');
}

function approvedAppEnvironment(password = 'staging-password') {
  return {
    ADAPTIVE_LEARNING_ENABLED: 'false',
    ADMIN_TELEGRAM_ID: '',
    AI_DAILY_REQUEST_BUDGET: '1000',
    AI_REQUESTS_PER_HOUR: '100',
    APP_PORT: '3001',
    APP_URL: 'https://staging.useboost.ru',
    AZURE_SPEECH_KEY: '',
    AZURE_SPEECH_REGION: '',
    DATABASE_PROVIDER: 'postgres',
    DATABASE_URL: 'postgresql://easyboost_staging:' + password
      + '@postgres:5432/easyboost_staging',
    GROQ_API_KEY: '',
    GROQ_ENABLED: 'false',
    GROQ_MODEL: '',
    JWT_SECRET: 'j'.repeat(32),
    MONITORING_TOKEN: '',
    NODE_ENV: 'production',
    PORT: '3000',
    POSTGRES_PASSWORD: password,
    SPEAKING_PRONUNCIATION_ENABLED: 'false',
    SPEAKING_PRONUNCIATION_MAX_AUDIO_BYTES: '5242880',
    SPEAKING_PRONUNCIATION_MAX_AUDIO_SECONDS: '90',
    SPEAKING_PRONUNCIATION_TIMEOUT_MS: '45000',
    STT_REQUESTS_PER_HOUR: '100',
    TELEGRAM_BOT_TOKEN: '',
    TTS_REQUESTS_PER_HOUR: '100',
    WRITING_REQUESTS_PER_HOUR: '100',
    XAI_API_KEY: '',
    XAI_ENABLED: 'false',
    XAI_MODEL: '',
  };
}

function approvedComposeModel(appDirectory) {
  const appDir = posixPath(appDirectory).replace(/\/$/u, '');
  return {
    name: 'easyboost-staging',
    networks: { backend: { name: 'easyboost-staging_backend' } },
    services: {
      app: {
        build: {
          context: `${appDir}/.guarded-staging-build-context-required`,
          dockerfile: `${appDir}/Dockerfile`,
        },
        depends_on: {
          postgres: { condition: 'service_healthy', required: true, restart: false },
        },
        env_file: [{ path: `${appDir}/.env.staging`, required: true }],
        environment: approvedAppEnvironment(),
        image: 'easyboost-staging-app:local',
        networks: { backend: null },
        ports: [{
          host_ip: '127.0.0.1', mode: 'ingress', protocol: 'tcp', published: '3001', target: 3000,
        }],
        pull_policy: 'never',
        restart: 'unless-stopped',
      },
      postgres: {
        environment: {
          POSTGRES_DB: 'easyboost_staging',
          POSTGRES_PASSWORD: 'staging-password',
          POSTGRES_USER: 'easyboost_staging',
        },
        healthcheck: {
          interval: '10s', retries: 10,
          test: ['CMD-SHELL', 'pg_isready -U easyboost_staging -d easyboost_staging'],
          timeout: '5s',
        },
        image: POSTGRES_IMAGE_ID,
        networks: { backend: null },
        pull_policy: 'never',
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

test('safe root-owned ancestors are accepted while the protected runtime stays invoking-user-owned',
  async (context) => {
    const probe = runBash(['--version']);
    if (!probe) return context.skip('Git Bash is not installed');
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-safe-ancestors-'));
    const runtime = path.join(root, 'runtime');
    context.after(() => fs.rm(root, { recursive: true, force: true }));
    await fs.mkdir(runtime);
    const script = [
      `source ${JSON.stringify(posixPath(commonScript))}`,
      'candidate="$1"',
      'candidate_parent="$(dirname -- "$candidate")"',
      'leaf_owner="$2"',
      'id() { [ "$1" = -u ] && printf "1000\\n"; }',
      'stat() {',
      '  local format="" target="" owner',
      '  while [ "$#" -gt 0 ]; do',
      '    case "$1" in -c) format="$2"; shift 2 ;; --) shift ;; *) target="$1"; shift ;; esac',
      '  done',
      '  case "$format" in',
      '    %u) case "$target" in "$candidate") owner="$leaf_owner" ;; "$candidate_parent") owner=1000 ;; *) owner=0 ;; esac; printf "%s\\n" "$owner" ;;',
      '    %a) [ "$target" = "$candidate" ] && printf "700\\n" || printf "755\\n" ;;',
      '    %h) printf "1\\n" ;;',
      '    *) return 1 ;;',
      '  esac',
      '}',
      'verify_protected_path "$candidate" directory "test runtime" 1 700',
    ].join('\n');
    const accepted = runBash(['--noprofile', '--norc', '-c', script, 'authority-test',
      posixPath(runtime), '1000']);
    assert.equal(accepted.status, 0, `${accepted.stdout}\n${accepted.stderr}`);

    const foreignLeaf = runBash(['--noprofile', '--norc', '-c', script, 'authority-test',
      posixPath(runtime), '0']);
    assert.notEqual(foreignLeaf.status, 0, `${foreignLeaf.stdout}\n${foreignLeaf.stderr}`);
    assert.match(foreignLeaf.stderr, /test runtime has a foreign owner/u);
  });

test('workflow pins canonical Node and sudo invokes only the authorized deploy entrypoint',
  async () => {
    const [ci, deployWorkflow] = await Promise.all([
      fs.readFile(path.resolve('.github/workflows/ci.yml'), 'utf8'),
      fs.readFile(path.resolve('.github/workflows/deploy-staging.yml'), 'utf8'),
    ]);
    const inertIdentity = `sha256:${'0'.repeat(64)}`;
    const validationStep = ci.match(
      /- name: Validate staging deployment\r?\n([\s\S]*?)(?=\r?\n\s{6}- name:|$)/u,
    )?.[1] ?? '';
    assert.match(validationStep,
      new RegExp(`^\\s*env:\\r?\\n\\s*EASYBOOST_STAGING_POSTGRES_IMAGE_ID: ${inertIdentity}\\r?$`, 'mu'),
      'CI config validation must use the canonical non-deployable test-only image identity');
    assert.equal((ci.match(/EASYBOOST_STAGING_POSTGRES_IMAGE_ID:/gu) ?? []).length, 1,
      'the inert CI identity must not leak into an executable deployment step');

    for (const [label, workflow] of [['CI', ci], ['deploy', deployWorkflow]]) {
      assert.match(workflow, /^\s*node-version:\s*22\.23\.2\s*$/mu,
        `${label} canonical archive producer Node must stay exact`);
      assert.doesNotMatch(workflow, /^\s*node-version:\s*22\s*$/mu,
        `${label} must not float across Node 22 patch releases`);
    }
    assert.match(deployWorkflow,
      /"sudo \/usr\/local\/sbin\/easyboost-staging-deploy \/tmp\/easyboost-staging-release\.tar\.gz '\$release_sha' immutable-archive-v4 '\$helper_sha'"/u,
      'sudo must invoke the allowlisted helper directly');
    assert.doesNotMatch(deployWorkflow, /sudo\s+(?:\/usr\/bin\/)?timeout\b/u,
      'sudoers does not authorize an outer timeout executable');
    assert.match(deployWorkflow, /^\s*timeout-minutes:\s*60\s*$/mu,
      'job remains the outer bounded workflow');
  });

test('cutover has no unsafe legacy worktree fallback and the release lock has no crash sibling',
  async () => {
    const [cutoverSource, commonSource] = await Promise.all([
      fs.readFile(path.resolve('scripts/staging-cutover.sh'), 'utf8'),
      fs.readFile(commonScript, 'utf8'),
    ]);
    assert.doesNotMatch(cutoverSource, /rm -rf|run_archive_extract|\bextract\b/u);
    assert.doesNotMatch(cutoverSource, /cp\s+--(?:reflink=never\s+)?--/u,
      'journal-reserved cutover entries must only use descriptor-bound prefix completion');
    assert.doesNotMatch(commonSource, /\.staging-release\.lock\.new\.\$\$/u,
      'the stable release lock must not have a random crash-residue sibling');
    assert.match(commonSource,
      /set -o noclobber; : > "\$lock_file"[\s\S]*:600:1:0/u,
      'the final lock path is created no-replace and proven private, zero-byte, and single-link');
  });

async function createRelease(root, name, marker) {
  const directory = path.join(root, name);
  await fs.mkdir(path.join(directory, 'scripts'), { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(directory, '.dockerignore'), [
      '/backups', '/rollbacks', '/.release-sha256', '/.staging-release.lock', '',
    ].join('\n')),
    fs.writeFile(path.join(directory, 'Dockerfile'), 'FROM scratch\nCOPY shared.txt /shared.txt\n'),
    fs.writeFile(path.join(directory, 'compose.staging.yml'), [
      'name: easyboost-staging',
      'services:',
      '  app:',
      '    image: easyboost-staging-app:local',
      '    pull_policy: never',
      '    build:',
      '      context: ./.guarded-staging-build-context-required',
      '',
    ].join('\n')),
    fs.writeFile(path.join(directory, 'shared.txt'), `${marker}\n`),
    fs.writeFile(path.join(directory, `${marker}-only.txt`), `${marker}-only\n`),
    fs.writeFile(path.join(directory, 'scripts', 'release.sh'), '#!/bin/sh\n'),
  ]);
  const archive = path.join(root, `${name}.tar.gz`);
  const files = ['.dockerignore', 'Dockerfile', 'compose.staging.yml', `${marker}-only.txt`,
    'scripts/release.sh', 'shared.txt'].sort();
  await createReleaseArchive({ sourceDirectory: directory, files, outputPath: archive });
  const sha = crypto.createHash('sha256').update(await fs.readFile(archive)).digest('hex');
  return { archive, directory, sha };
}

async function repackRelease(release) {
  await fs.rm(release.archive);
  const files = [];
  async function visit(directory, prefix = '') {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await visit(path.join(directory, entry.name), name);
      else files.push(name);
    }
  }
  await visit(release.directory);
  await createReleaseArchive({ sourceDirectory: release.directory, files: files.sort(), outputPath: release.archive });
  release.sha = crypto.createHash('sha256').update(await fs.readFile(release.archive)).digest('hex');
}

async function seedActiveRelease(appDir, release) {
  const releaseStore = path.join(appDir, 'rollbacks', 'releases');
  await fs.mkdir(releaseStore, { recursive: true });
  const stored = path.join(releaseStore, `release-${release.sha}.tar.gz`);
  await fs.copyFile(release.archive, stored);
  await fs.writeFile(`${stored}.sha256`, `${release.sha}\n`);
  await fs.writeFile(path.join(appDir, '.release-sha256'), `${release.sha}\n`);
  await Promise.all([
    fs.chmod(releaseStore, 0o700),
    fs.chmod(stored, 0o600),
    fs.chmod(`${stored}.sha256`, 0o600),
    fs.chmod(path.join(appDir, '.release-sha256'), 0o600),
  ]);
}

async function writeFakeCommands(root) {
  const fakeBin = path.join(root, 'fake-bin');
  await fs.mkdir(fakeBin, { recursive: true });
  const bashEnv = path.join(fakeBin, 'commands.sh');
  await fs.writeFile(bashEnv, [
    `PREVIOUS_IMAGE_ID=${PREVIOUS_IMAGE_ID}`,
    `CANDIDATE_IMAGE_ID=${CANDIDATE_IMAGE_ID}`,
    `POSTGRES_IMAGE_ID=${POSTGRES_IMAGE_ID}`,
    `DRIFTED_POSTGRES_IMAGE_ID=${DRIFTED_POSTGRES_IMAGE_ID}`,
    `STALE_IMAGE_ID=${STALE_IMAGE_ID}`,
    `STALE_RELEASE_IMAGE_ID=${STALE_RELEASE_IMAGE_ID}`,
    `FOREIGN_IMAGE_ID=${FOREIGN_IMAGE_ID}`,
    `DRIFTED_RUNNING_IMAGE_ID=${DRIFTED_RUNNING_IMAGE_ID}`,
    `APP_CONTAINER_ID=${APP_CONTAINER_ID}`,
    `POSTGRES_CONTAINER_ID=${POSTGRES_CONTAINER_ID}`,
    `DRIFTED_POSTGRES_CONTAINER_ID=${DRIFTED_POSTGRES_CONTAINER_ID}`,
    `POSTGRES_VOLUME_SOURCE=${POSTGRES_VOLUME_SOURCE}`,
    'flock() { if [ "${FAKE_LOCK_BUSY:-0}" = "1" ]; then return 1; fi; return 0; }',
    'timeout() {',
    '  while [ "$#" -gt 0 ]; do case "$1" in --signal=*|--kill-after=*) shift ;; *s) shift; break ;; *) break ;; esac; done',
    '  if [ "${FAKE_BOUNDED_COMPOSE_TIMEOUT:-0}" = "1" ] && [[ " $* " == *" config --format json "* ]]; then return 124; fi',
    '  if [ "${FAKE_BACKUP_WRITE_TIMEOUT:-0}" = "1" ] && [[ " $* " == *staging-bounded-stream.js* ]] && [[ " $* " == *"/database-backup.dump "* ]]; then return 124; fi',
    '  if [ "${FAKE_BACKUP_FILE_SYNC_FAIL:-0}" = "1" ] && [[ " $* " == *"staging-bounded-stream.js fsync-file "* ]] && [[ " $* " == *"/backups/"* ]]; then return 124; fi',
    '  if [ "${FAKE_BACKUP_PARENT_SYNC_FAIL:-0}" = "1" ] && [[ " $* " == *"staging-bounded-stream.js fsync-parent "* ]] && [[ " $* " == *"/backups/"* ]]; then return 124; fi',
    '  if [ "${FAKE_LIVE_COPY_TIMEOUT:-0}" = "1" ] && [ "${1:-}" = cp ] && [ "${2:-}" = -a ] && [[ "${3:-}" == */candidate/. ]]; then return 124; fi',
    '  if [ "${FAKE_RECOVERY_COPY_TIMEOUT:-0}" = "1" ] && [ "${1:-}" = cp ] && [ "${2:-}" = -a ] && [[ "${3:-}" == */previous/. ]]; then return 124; fi',
    '  "$@"',
    '}',
    'fallocate() {',
    '  target="${@: -1}"',
    '  if [[ "$target" == *"/.staging-space-reservation-upload" ]] || [[ "$target" == *easyboost-staging-deploy.*"/release.tar.gz" ]]; then printf "%s\n" "$*" >> "$COMMAND_LOG.upload-reservations"; fi',
    '  if [[ "$target" == *"/.staging-space-reservation-upload" ]]; then',
    '    if [ "${FAKE_UPLOAD_SWAP_DURING_RESERVATION:-0}" = "1" ] && [ ! -f "$COMMAND_LOG.upload-swapped" ]; then /usr/bin/mv -- "$FAKE_UPLOAD_REPLACEMENT" "$FAKE_UPLOAD_SOURCE"; : > "$COMMAND_LOG.upload-swapped"; fi',
    '    if [ "${FAKE_UPLOAD_SYMLINK_DURING_RESERVATION:-0}" = "1" ] && [ ! -f "$COMMAND_LOG.upload-symlinked" ]; then /usr/bin/mv -- "$FAKE_UPLOAD_SOURCE" "$FAKE_UPLOAD_SOURCE.displaced" || return; /usr/bin/ln -s -- "$FAKE_UPLOAD_REPLACEMENT" "$FAKE_UPLOAD_SOURCE" || return; [ -L "$FAKE_UPLOAD_SOURCE" ] || return 30; : > "$COMMAND_LOG.upload-symlinked"; fi',
    '    if [ "${FAKE_UPLOAD_CAPACITY_SIDE_EFFECT_FAIL:-0}" = "1" ]; then /usr/bin/truncate -s "$2" "$4"; return 28; fi',
    '    if [ "${FAKE_UPLOAD_CAPACITY_FAIL:-0}" = "1" ]; then return 28; fi',
    '  fi',
    '  if [[ "$target" == *easyboost-staging-deploy.*"/release.tar.gz" ]] && [ "${FAKE_UPLOAD_OUTPUT_SIDE_EFFECT_FAIL:-0}" = "1" ]; then /usr/bin/truncate -s "$2" "$4"; return 29; fi',
    '  if [ "${FAKE_SPARSE_RESERVATION:-0}" = "1" ] || [ ! -x /usr/bin/fallocate ]; then /usr/bin/truncate -s "$2" "$4"; else /usr/bin/fallocate "$@"; fi',
    '}',
    'mktemp() {',
    '  if [ -n "${FAKE_TRUSTED_TMP_ROOT:-}" ] && [[ " $* " == *" /tmp/easyboost-staging-deploy.XXXXXX "* ]]; then result="$(/usr/bin/mktemp -d "$FAKE_TRUSTED_TMP_ROOT/easyboost-staging-deploy.XXXXXX")" || return; printf "%s\n" "$result" > "$COMMAND_LOG.workdir"; printf "%s\n" "$result"; return 0; fi',
    '  /usr/bin/mktemp "$@"',
    '}',
    'stat() { if [ "$1" = "-c" ] && [ "$2" = "%b" ] && [[ "${@: -1}" == *".staging-space-reservation"* ]]; then if [ "${FAKE_SPARSE_RESERVATION:-0}" = "1" ]; then printf "0\\n"; else size="$(/usr/bin/stat -c "%s" -- "${@: -1}")"; printf "%s\\n" "$(((size + 511) / 512))"; fi; return 0; fi; /usr/bin/stat "$@"; }',
    'df() {',
    '  target="${@: -1}"',
    '  if [ "${FAKE_LOW_APP_DISK:-0}" = "1" ] && [[ "$target" == "$STAGING_APP_DIR"* ]]; then printf "Filesystem 1024-blocks Used Available Capacity Mounted on\\nfake 100 99 1 99%% %s\\n" "$STAGING_APP_DIR"; return 0; fi',
    '  /usr/bin/df "$@"',
    '}',
    'sha256sum() {',
    '  last="${@: -1}"',
    '  if [ "${last##*/}" = "release.tar.gz" ]; then printf "%s\\n" "$last" > "$COMMAND_LOG.frozen-path"; fi',
    '  if [ "${FAKE_RELEASE_ARCHIVE_HASH_FAIL:-0}" = "1" ]; then case "$last" in "$STAGING_APP_DIR"/rollbacks/releases/.release-*.tar.gz.tmp.*) return 36 ;; esac; fi',
    '  /usr/bin/sha256sum "$@"',
    '}',
    'if [ "${FAKE_COMMANDS_INITIALIZED:-0}" != "1" ]; then',
    '  export FAKE_COMMANDS_INITIALIZED=1',
    '  if [ "${FAKE_NO_PREVIOUS_IMAGE:-0}" = "1" ]; then /usr/bin/rm -f "$COMMAND_LOG.image-state" "$COMMAND_LOG.container-state" "$COMMAND_LOG.postgres-container-state" "$COMMAND_LOG.postgres-container-id-state" "$COMMAND_LOG.postgres-volume-source-state" "$COMMAND_LOG.volume-state" "$COMMAND_LOG.network-state" "$COMMAND_LOG.release-state"; else printf "%s\\n" "$PREVIOUS_IMAGE_ID" > "$COMMAND_LOG.image-state"; printf "%s\\n" "$PREVIOUS_IMAGE_ID" > "$COMMAND_LOG.container-state"; printf "%s\\n" "$POSTGRES_IMAGE_ID" > "$COMMAND_LOG.postgres-container-state"; printf "%s\\n" "$POSTGRES_CONTAINER_ID" > "$COMMAND_LOG.postgres-container-id-state"; printf "%s\\n" "$POSTGRES_VOLUME_SOURCE" > "$COMMAND_LOG.postgres-volume-source-state"; : > "$COMMAND_LOG.volume-state"; : > "$COMMAND_LOG.network-state"; fi',
    '  [ "${FAKE_FIRST_STALE_STABLE:-0}" != "1" ] || printf "%s\\n" "$STALE_IMAGE_ID" > "$COMMAND_LOG.image-state"',
    '  [ "${FAKE_FIRST_STALE_RELEASE:-0}" != "1" ] || printf "%s\\n" "$STALE_RELEASE_IMAGE_ID" > "$COMMAND_LOG.release-state"',
    '  [ "${FAKE_FIRST_STALE_CONTAINER:-0}" != "1" ] || printf "%s\\n" "$STALE_IMAGE_ID" > "$COMMAND_LOG.container-state"',
    '  [ "${FAKE_MISSING_APP_CONTAINER:-0}" != "1" ] || /usr/bin/rm -f "$COMMAND_LOG.container-state"',
    '  [ "${FAKE_MISSING_POSTGRES_CONTAINER:-0}" != "1" ] || /usr/bin/rm -f "$COMMAND_LOG.postgres-container-state" "$COMMAND_LOG.postgres-container-id-state" "$COMMAND_LOG.postgres-volume-source-state"',
    '  [ "${FAKE_DRIFTED_RUNNING_POSTGRES:-0}" != "1" ] || printf "%s\\n" "$DRIFTED_POSTGRES_IMAGE_ID" > "$COMMAND_LOG.postgres-container-state"',
    'fi',
    'if [ "${FAKE_NONCANONICAL_IMAGE_IDENTITIES:-0}" = "1" ]; then printf "sha256:not-canonical\\n" > "$COMMAND_LOG.image-state"; printf "sha256:not-canonical\\n" > "$COMMAND_LOG.container-state"; fi',
    'cp() {',
    '  if [ "${FAKE_RECOVERY_COPY_FAIL:-0}" = "1" ] && [[ "$*" == *"/previous/."* ]]; then return 12; fi',
    '  if [ "${FAKE_CUTOVER_COMPOSE_COPY_SIDE_EFFECT_FAIL:-0}" = "1" ] && [[ "${@: -1}" == "$STAGING_APP_DIR/.compose.staging.yml.cutover-"* ]]; then /usr/bin/cp "$@"; return 37; fi',
    '  if [ "${FAKE_RELEASE_ARCHIVE_WRITE_FAIL:-0}" = "1" ]; then case "${@: -1}" in "$STAGING_APP_DIR"/rollbacks/releases/.release-*.tar.gz.tmp.*) /usr/bin/cp "$@"; return 31 ;; esac; fi',
    '  /usr/bin/cp "$@"',
    '}',
    'tee() {',
    '  if [ "${FAKE_RELEASE_SIDECAR_WRITE_FAIL:-0}" = "1" ]; then case "${@: -1}" in "$STAGING_APP_DIR"/rollbacks/releases/.release-*.sha256.tmp.*) /usr/bin/tee "$@"; return 32 ;; esac; fi',
    '  /usr/bin/tee "$@"',
    '}',
    'find() {',
    '  if [ "${FAKE_BACKUP_PRUNE_FAIL:-0}" = "1" ] && [[ "$*" == *"/backups "* ]] && [[ "$*" == *" -mtime +14 "* ]]; then return 25; fi',
    '  if [ "${FAKE_RECOVERY_REMOVE_FAIL:-0}" = "1" ] && [[ "$*" == *" -exec "* ]]; then',
    '    count=0; [ -f "$COMMAND_LOG.find-count" ] && count="$(cat "$COMMAND_LOG.find-count")"; count=$((count+1)); printf "%s\\n" "$count" > "$COMMAND_LOG.find-count"',
    '    if [ "$count" -ge 2 ]; then return 13; fi',
    '  fi',
    '  /usr/bin/find "$@"',
    '}',
    'rm() {',
    '  if [ "${FAKE_TRANSACTION_MARKER_RM_FAIL:-0}" = "1" ] && [[ "$*" == *".staging-recovery-required"* ]]; then return 21; fi',
    '  if [ "${FAKE_RESERVATION_RM_FAIL:-0}" = "1" ] && [[ "$*" == *".staging-space-reservation"* ]] && [ "$(cat "$STAGING_APP_DIR/.release-sha256" 2>/dev/null || :)" = "$CANDIDATE_RELEASE_SHA" ]; then return 26; fi',
    '  if [ "${FAKE_WORKDIR_RM_FAIL:-0}" = "1" ] && [ "${1:-}" = "-rf" ] && [[ "$*" == *"easyboost-staging-deploy."* ]]; then return 27; fi',
    '  target="${@: -1}"',
    '  if [ "${FAKE_ADD_STORE_ENTRY_AFTER_RESERVATION_RELEASE:-0}" = "1" ]; then case "$target" in "$STAGING_APP_DIR"/rollbacks/releases/.staging-space-reservation.*) /usr/bin/rm "$@"; printf "unexpected\n" > "$STAGING_APP_DIR/rollbacks/releases/unexpected-post-reservation"; /usr/bin/chmod 600 "$STAGING_APP_DIR/rollbacks/releases/unexpected-post-reservation"; return 0 ;; esac; fi',
    '  if [ "${FAKE_PAIR_ARCHIVE_FINAL_RM_FAIL:-0}" = "1" ]; then case "$target" in "$STAGING_APP_DIR"/rollbacks/releases/.publication-cleanup.*/owned-entry) if [ ! -f "$COMMAND_LOG.pair-owned-rm-failed" ]; then : > "$COMMAND_LOG.pair-owned-rm-failed"; return 35; fi ;; "$STAGING_APP_DIR"/rollbacks/releases/release-*.tar.gz) return 35 ;; esac; fi',
    '  if [ "${FAKE_PAIR_FINAL_CLEANUP_REPLACE:-0}" = "1" ] && [ ! -f "$COMMAND_LOG.pair-cleanup-replaced" ]; then case "$target" in "$STAGING_APP_DIR"/rollbacks/releases/release-*.tar.gz) printf "foreign replacement\\n" > "$target.foreign"; /usr/bin/chmod 600 "$target.foreign"; /usr/bin/mv -f -- "$target.foreign" "$target"; : > "$COMMAND_LOG.pair-cleanup-replaced" ;; esac; fi',
    '  if [ "${FAKE_TAMPER_PREVIOUS_STORE_ON_PAIR_CLEANUP:-0}" = "1" ] && [ ! -f "$COMMAND_LOG.store-tampered" ]; then case "$target" in "$STAGING_APP_DIR"/rollbacks/releases/release-*.tar.gz|"$STAGING_APP_DIR"/rollbacks/releases/release-*.tar.gz.sha256|"$STAGING_APP_DIR"/rollbacks/releases/.publication-cleanup.*/owned-entry) candidate_sidecar="$STAGING_APP_DIR/rollbacks/releases/release-$CANDIDATE_RELEASE_SHA.tar.gz.sha256"; for sidecar in "$STAGING_APP_DIR"/rollbacks/releases/release-*.tar.gz.sha256; do [ "$sidecar" = "$candidate_sidecar" ] && continue; printf "%064d\\n" 0 > "$sidecar"; : > "$COMMAND_LOG.store-tampered"; break; done ;; esac; fi',
    '  /usr/bin/rm "$@"',
    '}',
    'mv() {',
    '  destination="${@: -1}"',
    '  source="${@: -2:1}"',
    '  if [ "${FAKE_RELEASE_FINAL_PUBLICATION_REPLACE:-0}" = "1" ]; then case "$destination" in "$STAGING_APP_DIR"/rollbacks/releases/release-*.tar.gz) printf "foreign replacement\\n" > "$destination"; /usr/bin/chmod 600 "$destination" ;; esac; fi',
    '  if [ "${FAKE_PAIR_FINAL_CLEANUP_REPLACE:-0}" = "1" ] && [ ! -f "$COMMAND_LOG.pair-cleanup-replaced" ]; then case "$source" in "$STAGING_APP_DIR"/rollbacks/releases/release-*.tar.gz) printf "foreign replacement\\n" > "$source.foreign"; /usr/bin/chmod 600 "$source.foreign"; /usr/bin/mv -f -- "$source.foreign" "$source"; : > "$COMMAND_LOG.pair-cleanup-replaced" ;; esac; fi',
    '  if [ "${FAKE_RELEASE_ARCHIVE_MV_FAIL:-0}" = "1" ]; then case "$destination" in "$STAGING_APP_DIR"/rollbacks/releases/release-*.tar.gz) /usr/bin/mv "$@"; return 33 ;; esac; fi',
    '  if [ "${FAKE_RELEASE_SIDECAR_MV_FAIL:-0}" = "1" ]; then case "$destination" in "$STAGING_APP_DIR"/rollbacks/releases/release-*.tar.gz.sha256) /usr/bin/mv "$@"; return 34 ;; esac; fi',
    '  if [ "${FAKE_ACTIVE_MARKER_PUBLISH_FAIL:-0}" = "1" ] && [ "$destination" = "$STAGING_APP_DIR/.release-sha256" ]; then count=0; [ -f "$COMMAND_LOG.marker-mv-count" ] && count="$(cat "$COMMAND_LOG.marker-mv-count")"; count=$((count+1)); printf "%s\\n" "$count" > "$COMMAND_LOG.marker-mv-count"; [ "$count" -gt 1 ] || return 24; fi',
    '  /usr/bin/mv "$@"',
    '}',
    'ln() { destination="${@: -1}"; if [ "${FAKE_RELEASE_FINAL_PUBLICATION_REPLACE:-0}" = "1" ]; then case "$destination" in "$STAGING_APP_DIR"/rollbacks/releases/release-*.tar.gz) printf "foreign replacement\\n" > "$destination"; /usr/bin/chmod 600 "$destination" ;; esac; fi; if [ "${FAKE_RELEASE_ARCHIVE_MV_FAIL:-0}" = "1" ]; then case "$destination" in "$STAGING_APP_DIR"/rollbacks/releases/release-*.tar.gz) /usr/bin/ln "$@"; return 33 ;; esac; fi; if [ "${FAKE_RELEASE_SIDECAR_MV_FAIL:-0}" = "1" ]; then case "$destination" in "$STAGING_APP_DIR"/rollbacks/releases/release-*.tar.gz.sha256) /usr/bin/ln "$@"; return 34 ;; esac; fi; /usr/bin/ln "$@"; }',
    'docker() {',
    '  printf "docker|%s\\n" "$*" >> "$COMMAND_LOG"',
    '  if [ "$1" = "compose" ]; then action=other; case " $* " in *" config --format json "*) action=config ;; *" up --pull never -d --no-build --no-deps app "*) action=up ;; *" up --pull never -d --no-build --no-deps postgres "*) action=postgres-up ;; *" down --volumes --remove-orphans "*) action=down ;; *" exec -T postgres "*) action=exec ;; *" ps "*) action=ps ;; esac; printf "compose-postgres-authority|%s|%s\\n" "${EASYBOOST_STAGING_POSTGRES_IMAGE_ID:-unset}" "$action" >> "$COMMAND_LOG"; fi',
    '  if [ "$1" = "ps" ] && [[ " $* " == *"label=com.docker.compose.project=easyboost-staging"* ]]; then',
    '    if [[ " $* " == *"label=com.docker.compose.service=app"* ]]; then [ ! -f "$COMMAND_LOG.container-state" ] || printf "%s\\n" "$APP_CONTAINER_ID"; elif [[ " $* " == *"label=com.docker.compose.service=postgres"* ]]; then [ ! -f "$COMMAND_LOG.postgres-container-state" ] || cat "$COMMAND_LOG.postgres-container-id-state"; else [ ! -f "$COMMAND_LOG.container-state" ] || printf "%s\\n" "$APP_CONTAINER_ID"; [ ! -f "$COMMAND_LOG.postgres-container-state" ] || cat "$COMMAND_LOG.postgres-container-id-state"; fi',
    '    return 0',
    '  fi',
    '  if [ "$1" = "volume" ] && [ "$2" = "inspect" ]; then [ -f "$COMMAND_LOG.volume-state" ] || return 1; volume_source="${FAKE_POSTGRES_VOLUME_OBJECT_MOUNTPOINT:-$(cat "$COMMAND_LOG.postgres-volume-source-state")}"; [ ! -f "$COMMAND_LOG.postgres-volume-object-source-state" ] || volume_source="$(cat "$COMMAND_LOG.postgres-volume-object-source-state")"; printf \'{"Name":"%s","Driver":"%s","Scope":"%s","Mountpoint":"%s","Labels":{"com.docker.compose.project":"%s","com.docker.compose.volume":"%s"},"Options":null}\\n\' "${FAKE_POSTGRES_VOLUME_OBJECT_NAME:-easyboost-staging_postgres-data}" "${FAKE_POSTGRES_VOLUME_OBJECT_DRIVER:-local}" "${FAKE_POSTGRES_VOLUME_OBJECT_SCOPE:-local}" "$volume_source" "${FAKE_POSTGRES_VOLUME_OBJECT_PROJECT:-easyboost-staging}" "${FAKE_POSTGRES_VOLUME_OBJECT_LABEL:-postgres-data}"; return 0; fi',
    '  if [ "$1" = "volume" ] && [ "$2" = "ls" ]; then [ ! -f "$COMMAND_LOG.volume-state" ] || printf "easyboost-staging_postgres-data\\n"; return 0; fi',
    '  if [ "$1" = "network" ] && [ "$2" = "ls" ]; then [ ! -f "$COMMAND_LOG.network-state" ] || printf "easyboost-staging_backend\\n"; return 0; fi',
    '  if [[ " $* " == *" config --format json "* ]]; then',
    '    if [ "$1" = "compose" ] && [[ " $* " == *" -f - "* ]]; then /usr/bin/cat > /dev/null || return; fi',
    '    if [ "${FAKE_POSTGRES_RETAG_AFTER_CAPTURE:-0}" = "1" ] && [ ! -f "$COMMAND_LOG.postgres-retagged" ]; then : > "$COMMAND_LOG.postgres-retagged"; fi',
    '    if [ -n "${FAKE_RESOLVED_COMPOSE_CANDIDATE_JSON:-}" ] && [[ "$*" == *"/candidate/compose.staging.yml"* ]]; then printf "%s" "$FAKE_RESOLVED_COMPOSE_CANDIDATE_JSON"; else printf "%s" "$FAKE_RESOLVED_COMPOSE_JSON"; fi',
    '    return 0',
    '  fi',
    '  if [ "$1" = "build" ]; then',
    '    if [ "${FAKE_REQUIRE_HOST_OPERATION_LOCK:-0}" = "1" ]; then',
    '      [ -f "$EASYBOOST_HOST_OPERATION_LOCK_DIR/owner" ] || return 41',
    '      grep -qx "protocol=easyboost-host-operation-v1" "$EASYBOOST_HOST_OPERATION_LOCK_DIR/owner" || return 41',
    '      grep -qx "operation=staging-release" "$EASYBOOST_HOST_OPERATION_LOCK_DIR/owner" || return 41',
    '      printf "host-operation-lock-active\\n" >> "$COMMAND_LOG"',
    '    fi',
    '    if [ -e "$STAGING_APP_DIR/new-only.txt" ]; then printf "build-after-mutation\\n" >> "$COMMAND_LOG"; fi',
    '    input_sha="$(sha256sum | awk \'{print $1}\')"',
    '    printf "stdin-sha|%s\\n" "$input_sha" >> "$COMMAND_LOG"',
    '    if [ "${FAKE_MUTATE_FROZEN_AFTER_BUILD:-0}" = "1" ]; then',
    '      frozen="$(cat "$COMMAND_LOG.frozen-path")"',
    '      chmod u+w "$frozen"',
    '      printf "changed-after-build" >> "$frozen"',
    '    fi',
    '    if [ "${FAKE_SWAP_ENV_AFTER_BUILD:-0}" = "1" ]; then /usr/bin/mv "$STAGING_APP_DIR/.env.staging" "$COMMAND_LOG.old-env"; /usr/bin/cp "$COMMAND_LOG.old-env" "$STAGING_APP_DIR/.env.staging"; chmod 600 "$STAGING_APP_DIR/.env.staging"; fi',
    '    if [ "${FAKE_REWRITE_ENV_IN_PLACE_AFTER_BUILD:-0}" = "1" ]; then printf "APP_PORT=3001\\nSECRET=rewritten\\n" > "$STAGING_APP_DIR/.env.staging"; chmod 600 "$STAGING_APP_DIR/.env.staging"; fi',
    '    if [ "${FAKE_REWRITE_ACTIVE_MARKER_AFTER_BUILD:-0}" = "1" ]; then printf "%064d\\n" 0 > "$STAGING_APP_DIR/.release-sha256"; chmod 600 "$STAGING_APP_DIR/.release-sha256"; fi',
    '    if [ "${FAKE_ADD_STORE_ENTRY_AFTER_BUILD:-0}" = "1" ]; then printf "unexpected\\n" > "$STAGING_APP_DIR/rollbacks/releases/unexpected-entry"; chmod 600 "$STAGING_APP_DIR/rollbacks/releases/unexpected-entry"; fi',
    '    if [ "${FAKE_BUILD_FAIL:-0}" = "1" ]; then return 9; fi',
    '    printf "%s\\n" "$CANDIDATE_IMAGE_ID" > "$COMMAND_LOG.release-state"',
    '    return 0',
    '  fi',
    '  if [ "$1" = "image" ] && [ "$2" = "inspect" ]; then',
    '    target="${@: -1}"',
    '    if [[ "$target" == easyboost-staging-app:release-* ]] && [ -f "$COMMAND_LOG.inspect-after-release-rm" ]; then',
    '      case "${FAKE_RELEASE_INSPECT_AFTER_RM_STATUS:-}" in 124) return 124 ;; 128) printf "daemon unavailable\\n" >&2; return 128 ;; 1) printf "ambiguous inspect failure\\n" >&2; return 1 ;; esac',
    '    fi',
    '    case "$target" in easyboost-staging-app:release-*) if [ ! -f "$COMMAND_LOG.release-state" ]; then printf "Error response from daemon: No such image: %s\\n" "$target" >&2; return 1; fi; cat "$COMMAND_LOG.release-state" ;; easyboost-staging-app:local) if [ ! -f "$COMMAND_LOG.image-state" ]; then printf "Error response from daemon: No such image: %s\\n" "$target" >&2; return 1; fi; cat "$COMMAND_LOG.image-state" ;; postgres:17-alpine) if [ -f "$COMMAND_LOG.postgres-retagged" ]; then printf "%s\\n" "$DRIFTED_POSTGRES_IMAGE_ID"; elif [ "${FAKE_POSTGRES_DRIFT_ONCE:-0}" = "1" ] && grep -q "$CANDIDATE_IMAGE_ID" "$COMMAND_LOG.image-state" 2>/dev/null && [ ! -f "$COMMAND_LOG.postgres-drifted" ]; then : > "$COMMAND_LOG.postgres-drifted"; printf "%s\\n" "$DRIFTED_POSTGRES_IMAGE_ID"; else printf "%s\\n" "$POSTGRES_IMAGE_ID"; fi ;; *) return 1 ;; esac; return 0',
    '  fi',
    '  if [ "$1" = "image" ] && [ "$2" = "ls" ]; then',
    '    reference="${@: -1}"; reference="${reference#reference=}"',
    '    if [[ "$reference" == easyboost-staging-app:release-* ]] && [ ! -f "$COMMAND_LOG.release-state" ]; then case "${FAKE_RELEASE_PROBE_BEFORE_BUILD_STATUS:-}" in 124) return 124 ;; 128) printf "daemon unavailable\\n" >&2; return 128 ;; 1) printf "ambiguous probe failure\\n" >&2; return 1 ;; esac; fi',
    '    if [[ "$reference" == easyboost-staging-app:release-* ]] && [ -f "$COMMAND_LOG.inspect-after-release-rm" ]; then case "${FAKE_RELEASE_INSPECT_AFTER_RM_STATUS:-}" in 124) return 124 ;; 128) printf "daemon unavailable\\n" >&2; return 128 ;; 1) printf "ambiguous inspect failure\\n" >&2; return 1 ;; esac; fi',
    '    if [[ "$reference" == easyboost-staging-app:release-* ]] && [ "${FAKE_RELEASE_REBOUND_AFTER_OWNERSHIP_PROBE:-0}" = "1" ] && [ -f "$COMMAND_LOG.release-state" ] && [ ! -f "$COMMAND_LOG.release-rebound" ]; then cat "$COMMAND_LOG.release-state"; printf "%s\\n" "$FOREIGN_IMAGE_ID" > "$COMMAND_LOG.release-state"; : > "$COMMAND_LOG.release-rebound"; return 0; fi',
    '    case "$reference" in easyboost-staging-app:release-*) [ ! -f "$COMMAND_LOG.release-state" ] || cat "$COMMAND_LOG.release-state" ;; easyboost-staging-app:local) [ ! -f "$COMMAND_LOG.image-state" ] || cat "$COMMAND_LOG.image-state" ;; postgres:17-alpine) printf "%s\\n" "$POSTGRES_IMAGE_ID" ;; esac; return 0',
    '  fi',
    '  if [ "$1" = "image" ] && [ "$2" = "tag" ]; then',
    '    if [ "${FAKE_PROMOTE_SIDE_EFFECT_ERROR:-0}" = "1" ] && [[ "$3" == easyboost-staging-app:release-* ]]; then printf "%s\\n" "$CANDIDATE_IMAGE_ID" > "$COMMAND_LOG.image-state"; return 8; fi',
    '    if [ "${FAKE_PROMOTE_FAIL:-0}" = "1" ] && [[ "$3" == easyboost-staging-app:release-* ]]; then return 8; fi',
    '    if [ "${FAKE_RECOVERY_RETAG_FAIL:-0}" = "1" ] && [ "$3" = "$PREVIOUS_IMAGE_ID" ]; then return 18; fi',
    '    if [ "$4" = "easyboost-staging-app:local" ]; then if [ "$3" = "$PREVIOUS_IMAGE_ID" ]; then printf "%s\\n" "$3" > "$COMMAND_LOG.image-state"; else printf "%s\\n" "$CANDIDATE_IMAGE_ID" > "$COMMAND_LOG.image-state"; [ "${FAKE_RELEASE_IMAGE_DRIFT_BEFORE_RM:-0}" != "1" ] || printf "%s\\n" "$FOREIGN_IMAGE_ID" > "$COMMAND_LOG.release-state"; fi; fi',
    '    return 0',
    '  fi',
    '  if [ "$1" = "image" ] && [ "$2" = "rm" ]; then',
    '    if [ "${FAKE_IMAGE_RM_FAIL:-0}" = "1" ]; then return 19; fi',
    '    if [ "${@: -1}" = "easyboost-staging-app:local" ] && [ -f "$COMMAND_LOG.container-state" ]; then return 19; fi',
    '    case "${@: -1}" in easyboost-staging-app:local) rm -f "$COMMAND_LOG.image-state" ;; easyboost-staging-app:release-*) rm -f "$COMMAND_LOG.release-state"; [ -z "${FAKE_RELEASE_INSPECT_AFTER_RM_STATUS:-}" ] || : > "$COMMAND_LOG.inspect-after-release-rm" ;; esac; return 0',
    '  fi',
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
    '  case " $* " in',
    '    *" ps -a -q app "*) [ ! -f "$COMMAND_LOG.container-state" ] || printf "%s\\n" "$APP_CONTAINER_ID" ;;',
    '    *" ps -q app "*) [ ! -f "$COMMAND_LOG.container-state" ] || printf "%s\\n" "$APP_CONTAINER_ID" ;;',
    '    *" ps --status running postgres --quiet "*) printf "postgres\\n" ;;',
    '    *" exec -T postgres "*) printf "database-backup\\n"; if [ "${FAKE_PG_DUMP_FAIL:-0}" = "1" ]; then return 23; fi ;;',
    '  esac',
    '  if [[ " $* " == *" down --volumes --remove-orphans "* ]]; then',
    '    [ "${FAKE_COMPOSE_DOWN_FAIL:-0}" != "1" ] || return 22',
    '    [ "${FAKE_APP_CONTAINER_RESIDUE:-0}" = "1" ] || rm -f "$COMMAND_LOG.container-state"',
    '    [ "${FAKE_POSTGRES_CONTAINER_RESIDUE:-0}" = "1" ] || rm -f "$COMMAND_LOG.postgres-container-state" "$COMMAND_LOG.postgres-container-id-state" "$COMMAND_LOG.postgres-volume-source-state"',
    '    [ "${FAKE_VOLUME_RESIDUE:-0}" = "1" ] || rm -f "$COMMAND_LOG.volume-state"',
    '    [ "${FAKE_NETWORK_RESIDUE:-0}" = "1" ] || rm -f "$COMMAND_LOG.network-state"',
    '    return 0',
    '  fi',
    '  if [[ " $* " == *" rm -f -s app "* ]]; then if [ "${FAKE_CONTAINER_RM_FAIL:-0}" = "1" ]; then return 22; fi; rm -f "$COMMAND_LOG.container-state"; return 0; fi',
    '  if [[ " $* " == *" up --pull never -d --no-build --no-deps postgres "* ]]; then printf "%s\\n" "$POSTGRES_IMAGE_ID" > "$COMMAND_LOG.postgres-container-state"; printf "%s\\n" "$POSTGRES_CONTAINER_ID" > "$COMMAND_LOG.postgres-container-id-state"; printf "%s\\n" "$POSTGRES_VOLUME_SOURCE" > "$COMMAND_LOG.postgres-volume-source-state"; : > "$COMMAND_LOG.volume-state"; : > "$COMMAND_LOG.network-state"; return 0; fi',
    '  if [[ " $* " == *" up --pull never -d --no-build --no-deps app "* ]]; then count=0; [ -f "$COMMAND_LOG.up-count" ] && count="$(cat "$COMMAND_LOG.up-count")"; count=$((count+1)); printf "%s\\n" "$count" > "$COMMAND_LOG.up-count"; if [ "${FAKE_RECOVERY_UP_FAIL:-0}" = "1" ] && [ "$count" -ge 2 ]; then return 20; fi; cat "$COMMAND_LOG.image-state" > "$COMMAND_LOG.container-state"; [ "${FAKE_POSTGRES_DRIFT_AFTER_APP_UP:-0}" != "1" ] || printf "%s\\n" "$DRIFTED_POSTGRES_CONTAINER_ID" > "$COMMAND_LOG.postgres-container-id-state"; [ "${FAKE_POSTGRES_MOUNT_DRIFT_AFTER_APP_UP:-0}" != "1" ] || printf "/var/lib/docker/volumes/foreign/_data\\n" > "$COMMAND_LOG.postgres-volume-source-state"; [ "${FAKE_POSTGRES_VOLUME_OBJECT_DRIFT_AFTER_APP_UP:-0}" != "1" ] || printf "/var/lib/docker/volumes/foreign-object/_data\\n" > "$COMMAND_LOG.postgres-volume-object-source-state"; fi',
    '  return 0',
    '}',
    'curl() { count=0; [ -f "$COMMAND_LOG.curl-count" ] && count="$(cat "$COMMAND_LOG.curl-count")"; count=$((count+1)); printf "%s\\n" "$count" > "$COMMAND_LOG.curl-count"; up_count=0; [ -f "$COMMAND_LOG.up-count" ] && up_count="$(cat "$COMMAND_LOG.up-count")"; if [ "${FAKE_PRECUTOVER_READINESS_FAIL:-0}" = "1" ]; then return 1; fi; if [ "${FAKE_RESTART_READINESS_FAIL:-0}" = "1" ] && [ "$up_count" -ge 1 ]; then return 1; fi; if [ "${FAKE_RECOVERY_READINESS_FAIL:-0}" = "1" ] && [ "$up_count" -ge 2 ]; then return 1; fi; if [ "${FAKE_READINESS_FAIL:-0}" = "1" ] && grep -q "$CANDIDATE_IMAGE_ID" "$COMMAND_LOG.image-state" 2>/dev/null; then return 1; fi; return 0; }',
    'sleep() { return 0; }',
    'install() { return 0; }',
    'source() {',
    '  builtin source "$@" || return',
    '  case "${1:-}" in',
    '    */staging-release-common.sh)',
    `      TRANSACTION_SECONDS=${STAGING_TEST_TRANSACTION_SECONDS}`,
    `      RECOVERY_SECONDS=${STAGING_TEST_RECOVERY_SECONDS}`,
    '      run_bounded() {',
    '        local requested="$1" remaining bound',
    '        shift',
    '        if [ "${FAKE_CUTOVER_COMPOSE_COMPLETE_SIDE_EFFECT_FAIL:-0}" = "1" ] && [ "${1:-}" = node ] && [ "${3:-}" = complete-compose ] && [ ! -f "$COMMAND_LOG.cutover-compose-prefix-failed" ]; then command node "$2" emit-compose "$4" | head -c 17 > "$5" || return 37; chmod 600 -- "$5" || return 37; : > "$COMMAND_LOG.cutover-compose-prefix-failed"; return 37; fi',
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
  for (const command of ['cp', 'curl', 'df', 'docker', 'fallocate', 'find', 'install', 'ln', 'mktemp', 'mv',
    'rm', 'sha256sum', 'sleep', 'stat', 'tee', 'timeout']) {
    const executable = path.join(fakeBin, command);
    await fs.writeFile(executable, [
      '#!/bin/bash',
      'source "$(dirname "$0")/commands.sh"',
      `${command} "$@"`,
      '',
    ].join('\n'));
    await fs.chmod(executable, 0o755);
  }
  return bashEnv;
}

async function createFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-deploy-'));
  const appDir = path.join(root, 'app');
  const trustedTmp = path.join(root, 'trusted-tmp');
  await Promise.all([
    fs.mkdir(path.join(appDir, 'rollbacks'), { recursive: true }),
    fs.mkdir(path.join(appDir, 'backups'), { recursive: true }),
    fs.mkdir(trustedTmp),
  ]);
  const previous = await createRelease(root, 'previous-release', 'old');
  const candidate = await createRelease(root, 'candidate-release', 'new');
  await Promise.all([
    fs.cp(previous.directory, appDir, { recursive: true }),
    fs.writeFile(path.join(appDir, '.env.staging'), 'APP_PORT=3001\nSECRET=preserved\n'),
    fs.writeFile(path.join(appDir, 'backups', 'keep.dump'), 'backup\n'),
    fs.writeFile(path.join(appDir, 'rollbacks', 'keep.tar.gz'), 'legacy artifact\n'),
  ]);
  await seedActiveRelease(appDir, previous);
  await Promise.all([
    fs.chmod(appDir, 0o700),
    fs.chmod(path.join(appDir, 'backups'), 0o700),
    fs.chmod(path.join(appDir, 'rollbacks'), 0o700),
    fs.chmod(path.join(appDir, 'rollbacks', 'releases'), 0o700),
    fs.chmod(path.join(appDir, '.env.staging'), 0o600),
    fs.chmod(path.join(appDir, 'backups', 'keep.dump'), 0o600),
  ]);
  return {
    appDir,
    bashEnv: await writeFakeCommands(root),
    candidate,
    commandLog: path.join(root, 'commands.log'),
    previous,
    root,
    trustedTmp,
  };
}

async function removeFixture(root) {
  async function makeDirectoriesOwnerWritable(directory) {
    let entries;
    try {
      await fs.chmod(directory, 0o700);
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    await Promise.all(entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => makeDirectoriesOwnerWritable(path.join(directory, entry.name))));
  }
  if (process.platform !== 'win32') await makeDirectoriesOwnerWritable(root);
  await fs.rm(root, { recursive: true, force: true });
}

async function makeFirstDeploymentFixture(fixture) {
  for (const entry of await fs.readdir(fixture.appDir)) {
    if (['.env.staging', 'backups', 'rollbacks'].includes(entry)) continue;
    await fs.rm(path.join(fixture.appDir, entry), { recursive: true, force: true });
  }
  await fs.rm(path.join(fixture.appDir, 'rollbacks', 'releases'), { recursive: true, force: true });
  await fs.mkdir(path.join(fixture.appDir, 'rollbacks', 'releases'));
  await fs.chmod(path.join(fixture.appDir, 'rollbacks', 'releases'), 0o700);
}

function runDeploy(fixture, extraEnv = {}) {
  const resolved = approvedComposeModel(fixture.appDir);
  const candidateResolved = structuredClone(resolved);
  if (extraEnv.FAKE_RESOLVED_COMPOSE_INVALID === '1') {
    candidateResolved.services.app.image = 'unverified.example/app:latest';
    candidateResolved.services.app.pull_policy = 'always';
    candidateResolved.services.app.build.context = posixPath(fixture.appDir);
  }
  if (extraEnv.FAKE_EXTRA_SERVICE === '1') {
    candidateResolved.services.helper = {
      image: 'unverified.example/helper:latest', pull_policy: 'always',
    };
  }
  const arguments_ = [
    posixPath(fixture.candidate.archive), fixture.candidate.sha, 'immutable-archive-v4',
    sourceBundleDigest,
  ];
  const configuration = Buffer.from(JSON.stringify({
    arguments: arguments_,
    bash: gitBash,
    controlKey: `staging-deadline-test:deploy:${deployScript}:${JSON.stringify(arguments_)}`,
    recoverySeconds: STAGING_TEST_RECOVERY_SECONDS,
    script: posixPath(deployScript),
    transactionSeconds: STAGING_TEST_TRANSACTION_SECONDS,
  })).toString('base64url');
  return spawnSync(process.execPath, [deadlineHarness, configuration], {
    encoding: 'utf8',
    env: {
      ...process.env,
      BASH_ENV: posixPath(fixture.bashEnv),
      PATH: `${path.dirname(fixture.bashEnv)}${path.delimiter}${process.env.PATH}`,
      COMMAND_LOG: posixPath(fixture.commandLog),
      CANDIDATE_RELEASE_SHA: fixture.candidate.sha,
      FAKE_TRUSTED_TMP_ROOT: posixPath(fixture.trustedTmp),
      FAKE_RESOLVED_COMPOSE_JSON: JSON.stringify(resolved),
      FAKE_RESOLVED_COMPOSE_CANDIDATE_JSON:
        extraEnv.FAKE_RESOLVED_COMPOSE_INVALID === '1' || extraEnv.FAKE_EXTRA_SERVICE === '1'
          ? JSON.stringify(candidateResolved) : '',
      EASYBOOST_HOST_OPERATION_LOCK_DIR: posixPath(path.join(fixture.root, 'host-operation.lock')),
      EASYBOOST_STAGING_DEADLINE_TEST_CONTROL_ROOT:
        path.join(fixture.root, 'deadline-controls'),
      EASYBOOST_STAGING_SESSION_TEST_CONTROL_ROOT:
        path.join(fixture.root, 'session-controls'),
      STAGING_APP_DIR: posixPath(fixture.appDir),
      ...extraEnv,
    },
  });
}

function runCutover(fixture, {
  bridge = fixture.previous,
  legacyMarkerSha,
  legacyComposeSha,
  legacyAppMode = '700',
  legacyMarkerMode = '644',
  legacyComposeMode = '664',
  extraEnv = {},
} = {}) {
  const arguments_ = [
    posixPath(bridge.archive), bridge.sha, legacyMarkerSha, legacyComposeSha,
    legacyAppMode, legacyMarkerMode, legacyComposeMode,
    'immutable-archive-v4', sourceBundleDigest,
  ];
  const configuration = Buffer.from(JSON.stringify({
    arguments: arguments_,
    bash: gitBash,
    controlKey: `staging-deadline-test:cutover:${cutoverScript}:${JSON.stringify(arguments_)}`,
    recoverySeconds: STAGING_TEST_RECOVERY_SECONDS,
    script: posixPath(cutoverScript),
    transactionSeconds: STAGING_TEST_TRANSACTION_SECONDS,
  })).toString('base64url');
  return spawnSync(process.execPath, [deadlineHarness, configuration], {
    encoding: 'utf8',
    env: {
      ...process.env,
      BASH_ENV: posixPath(fixture.bashEnv),
      PATH: `${path.dirname(fixture.bashEnv)}${path.delimiter}${process.env.PATH}`,
      COMMAND_LOG: posixPath(fixture.commandLog),
      CANDIDATE_RELEASE_SHA: bridge.sha,
      FAKE_RESOLVED_COMPOSE_JSON: JSON.stringify(approvedComposeModel(fixture.appDir)),
      EASYBOOST_HOST_OPERATION_LOCK_DIR: posixPath(path.join(fixture.root, 'host-operation.lock')),
      EASYBOOST_STAGING_DEADLINE_TEST_CONTROL_ROOT: path.join(fixture.root, 'deadline-controls'),
      EASYBOOST_STAGING_SESSION_TEST_CONTROL_ROOT: path.join(fixture.root, 'session-controls'),
      STAGING_APP_DIR: posixPath(fixture.appDir),
      ...extraEnv,
    },
  });
}

function runRestart(fixture, extraEnv = {}) {
  const arguments_ = [sourceBundleDigest];
  const configuration = Buffer.from(JSON.stringify({
    arguments: arguments_,
    bash: gitBash,
    controlKey: `staging-deadline-test:restart:${restartScript}:${JSON.stringify(arguments_)}`,
    recoverySeconds: STAGING_TEST_RECOVERY_SECONDS,
    script: posixPath(restartScript),
    transactionSeconds: STAGING_TEST_TRANSACTION_SECONDS,
  })).toString('base64url');
  return spawnSync(process.execPath, [deadlineHarness, configuration], {
    encoding: 'utf8',
    env: {
      ...process.env,
      BASH_ENV: posixPath(fixture.bashEnv),
      PATH: path.dirname(fixture.bashEnv) + path.delimiter + process.env.PATH,
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

test('root-owned staging restart preserves release authority and fails closed on readiness loss',
  async (context) => {
    const probe = runBash(['--version']);
    if (!probe) return context.skip('Git Bash is not installed');
    const ready = await createFixture();
    context.after(() => removeFixture(ready.root));
    const markerBefore = await fs.readFile(path.join(ready.appDir, '.release-sha256'), 'utf8');
    const success = runRestart(ready);
    assert.equal(success.status, 0, success.stdout + '\n' + success.stderr);
    const successLog = await fs.readFile(ready.commandLog, 'utf8');
    assert.match(successLog,
      /docker\|compose .* up --pull never -d --no-build --no-deps app$/mu);
    assert.doesNotMatch(successLog, /docker\|build |image tag|--build/u);
    assertComposeUsesCapturedPostgresAuthority(successLog, ['config', 'up']);
    assert.equal(await fs.readFile(path.join(ready.appDir, '.release-sha256'), 'utf8'), markerBefore);
    await assert.rejects(fs.access(path.join(ready.appDir, '.staging-recovery-required')),
      { code: 'ENOENT' });
    await assert.rejects(fs.access(path.join(ready.root, 'host-operation.lock')), { code: 'ENOENT' });

    const unavailable = await createFixture();
    context.after(() => removeFixture(unavailable.root));
    const failure = runRestart(unavailable, { FAKE_RESTART_READINESS_FAIL: '1' });
    assert.notEqual(failure.status, 0, failure.stdout + '\n' + failure.stderr);
    assert.match(await fs.readFile(path.join(unavailable.appDir, '.staging-recovery-required'), 'utf8'),
      /manual recovery required[\s\S]*staging app environment restart readiness/iu);
    assert.equal(await fs.readFile(path.join(unavailable.appDir, '.release-sha256'), 'utf8'),
      unavailable.previous.sha + '\n');
  });

test('explicit legacy cutover provisions a missing store and adopts the running release without rebuilding or touching PostgreSQL',
  async (context) => {
    if (process.platform === 'win32') {
      return context.skip('production cutover requires Linux /proc and POSIX lock semantics');
    }
    const probe = runBash(['--version']);
    if (!probe) return context.skip('Git Bash is not installed');
    const fixture = await createFixture();
    context.after(() => removeFixture(fixture.root));
    const releaseStore = path.join(fixture.appDir, 'rollbacks', 'releases');
    await fs.rm(releaseStore, { recursive: true });
    const legacyMarkerSha = 'a'.repeat(64);
    const legacyCompose = 'name: easyboost-staging\nservices:\n  app:\n    build: .\n';
    const legacyComposeSha = crypto.createHash('sha256').update(legacyCompose).digest('hex');
    await Promise.all([
      fs.writeFile(path.join(fixture.appDir, '.release-sha256'), `${legacyMarkerSha}\n`),
      fs.writeFile(path.join(fixture.appDir, 'compose.staging.yml'), legacyCompose),
    ]);
    await fs.chmod(fixture.appDir, 0o700);
    await fs.chmod(path.join(fixture.appDir, '.release-sha256'), 0o644);
    await fs.chmod(path.join(fixture.appDir, 'compose.staging.yml'), 0o664);

    const result = runCutover(fixture, { legacyMarkerSha, legacyComposeSha });

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(await fs.readFile(path.join(fixture.appDir, '.release-sha256'), 'utf8'),
      `${fixture.previous.sha}\n`);
    assert.equal(await fs.readFile(path.join(fixture.appDir, 'compose.staging.yml'), 'utf8'),
      await fs.readFile(path.join(fixture.previous.directory, 'compose.staging.yml'), 'utf8'));
    const retained = path.join(releaseStore, `release-${fixture.previous.sha}.tar.gz`);
    assert.deepEqual(await fs.readFile(retained), await fs.readFile(fixture.previous.archive));
    assert.equal(await fs.readFile(`${retained}.sha256`, 'utf8'), `${fixture.previous.sha}\n`);
    if (process.platform !== 'win32') {
      assert.equal((await fs.stat(releaseStore)).mode & 0o777, 0o700);
      assert.equal((await fs.stat(path.join(fixture.appDir, '.release-sha256'))).mode & 0o777, 0o600);
    }
    assert.equal(await fs.readFile(path.join(fixture.appDir, '.env.staging'), 'utf8'),
      'APP_PORT=3001\nSECRET=preserved\n');
    assert.equal(await fs.readFile(path.join(fixture.appDir, 'backups', 'keep.dump'), 'utf8'), 'backup\n');
    const log = await fs.readFile(fixture.commandLog, 'utf8');
    assert.doesNotMatch(log, /docker\|(?:build|compose .* (?:up|down)|volume rm)/u);
    const protectedFiles = [
      path.join(fixture.appDir, '.release-sha256'),
      path.join(fixture.appDir, 'compose.staging.yml'),
      retained,
      `${retained}.sha256`,
    ];
    const identitiesBeforeRetry = await Promise.all(protectedFiles.map((file) => fs.stat(file, { bigint: true })));
    const retryLogOffset = Buffer.byteLength(log);

    const retry = runCutover(fixture, { legacyMarkerSha, legacyComposeSha });

    assert.equal(retry.status, 0, `${retry.stdout}\n${retry.stderr}`);
    const identitiesAfterRetry = await Promise.all(protectedFiles.map((file) => fs.stat(file, { bigint: true })));
    const identity = (stat) => [stat.dev, stat.ino, stat.mode, stat.nlink, stat.size, stat.mtimeNs, stat.ctimeNs];
    assert.deepEqual(identitiesAfterRetry.map(identity), identitiesBeforeRetry.map(identity),
      'an exact second invocation must not rewrite committed release metadata');
    const retryLog = (await fs.readFile(fixture.commandLog, 'utf8')).slice(retryLogOffset);
    assert.doesNotMatch(retryLog,
      /docker\|(?:build|image tag|image rm|compose .* (?:up|down)|volume rm)/u);
    await assert.rejects(fs.access(path.join(fixture.appDir, '.staging-recovery-required')),
      { code: 'ENOENT' });
  });

test('journaled cutover completes an exact deterministic Compose prefix left by its predecessor',
  async (context) => {
    if (process.platform === 'win32') {
      return context.skip('production cutover requires Linux /proc and POSIX lock semantics');
    }
    const probe = runBash(['--version']);
    if (!probe) return context.skip('Git Bash is not installed');
    const fixture = await createFixture();
    context.after(() => removeFixture(fixture.root));
    const releaseStore = path.join(fixture.appDir, 'rollbacks', 'releases');
    await fs.rm(releaseStore, { recursive: true });
    const legacyMarkerSha = 'b'.repeat(64);
    const legacyCompose = 'name: easyboost-staging\nservices:\n  app:\n    build: .\n';
    const legacyComposeSha = crypto.createHash('sha256').update(legacyCompose).digest('hex');
    await Promise.all([
      fs.writeFile(path.join(fixture.appDir, '.release-sha256'), `${legacyMarkerSha}\n`),
      fs.writeFile(path.join(fixture.appDir, 'compose.staging.yml'), legacyCompose),
    ]);
    await fs.chmod(fixture.appDir, 0o700);
    await fs.chmod(path.join(fixture.appDir, '.release-sha256'), 0o644);
    await fs.chmod(path.join(fixture.appDir, 'compose.staging.yml'), 0o664);

    const interrupted = runCutover(fixture, {
      legacyMarkerSha,
      legacyComposeSha,
      extraEnv: { FAKE_CUTOVER_COMPOSE_COMPLETE_SIDE_EFFECT_FAIL: '1' },
    });
    assert.notEqual(interrupted.status, 0, `${interrupted.stdout}\n${interrupted.stderr}`);
    assert.match(interrupted.stderr, /roll forward/iu);
    const journal = path.join(fixture.appDir, '.staging-recovery-required');
    const temporary = path.join(
      fixture.appDir, `.compose.staging.yml.cutover-${fixture.previous.sha}`,
    );
    await fs.access(journal);
    await fs.access(temporary);
    assert.equal(await fs.readFile(path.join(fixture.appDir, 'compose.staging.yml'), 'utf8'),
      legacyCompose, 'failed copy must not replace the live Compose file');

    const resumed = runCutover(fixture, { legacyMarkerSha, legacyComposeSha });
    assert.equal(resumed.status, 0, `${resumed.stdout}\n${resumed.stderr}`);
    assert.equal(await fs.readFile(path.join(fixture.appDir, '.release-sha256'), 'utf8'),
      `${fixture.previous.sha}\n`);
    assert.equal(await fs.readFile(path.join(fixture.appDir, 'compose.staging.yml'), 'utf8'),
      await fs.readFile(path.join(fixture.previous.directory, 'compose.staging.yml'), 'utf8'));
    await assert.rejects(fs.access(journal), { code: 'ENOENT' });
    await assert.rejects(fs.access(temporary), { code: 'ENOENT' });
  });

test('legacy cutover proves bridge and running-service preconditions before metadata normalization',
  async (context) => {
    if (process.platform === 'win32') {
      return context.skip('production cutover requires Linux /proc and POSIX lock semantics');
    }
    const probe = runBash(['--version']);
    if (!probe) return context.skip('Git Bash is not installed');
    const cases = [
      ['missing app', { FAKE_MISSING_APP_CONTAINER: '1' }, 67, {}],
      ['missing postgres', { FAKE_MISSING_POSTGRES_CONTAINER: '1' }, 67, {}],
      ['wrong postgres image', { FAKE_DRIFTED_RUNNING_POSTGRES: '1' }, 67, {}],
      ['unready app', { FAKE_PRECUTOVER_READINESS_FAIL: '1' }, 67, {}],
      ['invalid bridge Compose', null, 65, {}],
      ['wrong approved mode tuple', {}, 67, { legacyMarkerMode: '600' }],
    ];
    for (const [label, environment, expectedStatus, cutoverOptions] of cases) {
      const fixture = await createFixture();
      context.after(() => removeFixture(fixture.root));
      const releaseStore = path.join(fixture.appDir, 'rollbacks', 'releases');
      await fs.rm(releaseStore, { recursive: true });
      const legacyMarkerSha = 'c'.repeat(64);
      const legacyCompose = 'name: easyboost-staging\nservices:\n  app:\n    build: .\n';
      const legacyComposeSha = crypto.createHash('sha256').update(legacyCompose).digest('hex');
      await Promise.all([
        fs.writeFile(path.join(fixture.appDir, '.release-sha256'), `${legacyMarkerSha}\n`),
        fs.writeFile(path.join(fixture.appDir, 'compose.staging.yml'), legacyCompose),
      ]);
      await fs.chmod(fixture.appDir, 0o700);
      await fs.chmod(path.join(fixture.appDir, '.release-sha256'), 0o644);
      await fs.chmod(path.join(fixture.appDir, 'compose.staging.yml'), 0o664);
      const protectedPaths = [
        fixture.appDir,
        path.join(fixture.appDir, '.release-sha256'),
        path.join(fixture.appDir, 'compose.staging.yml'),
      ];
      const before = await Promise.all(protectedPaths.map((file) => fs.stat(file, { bigint: true })));
      const invalidModel = approvedComposeModel(fixture.appDir);
      invalidModel.services.app.image = 'unapproved.example/app:latest';
      const extraEnv = environment ?? {
        FAKE_RESOLVED_COMPOSE_JSON: JSON.stringify(invalidModel),
      };

      const rejected = runCutover(fixture, {
        legacyMarkerSha, legacyComposeSha, extraEnv, ...cutoverOptions,
      });
      assert.equal(rejected.status, expectedStatus,
        `${label}: ${rejected.stdout}\n${rejected.stderr}`);
      const after = await Promise.all(protectedPaths.map((file) => fs.stat(file, { bigint: true })));
      const identity = (stat) => [
        stat.dev, stat.ino, stat.mode, stat.nlink, stat.size, stat.mtimeNs, stat.ctimeNs,
      ];
      assert.deepEqual(after.map(identity), before.map(identity),
        `${label}: rejected precondition must preserve exact legacy metadata`);
      assert.equal(await fs.readFile(path.join(fixture.appDir, '.release-sha256'), 'utf8'),
        `${legacyMarkerSha}\n`, label);
      assert.equal(await fs.readFile(path.join(fixture.appDir, 'compose.staging.yml'), 'utf8'),
        legacyCompose, label);
      await assert.rejects(fs.access(releaseStore), { code: 'ENOENT' }, label);
      await assert.rejects(fs.access(path.join(fixture.appDir, '.staging-recovery-required')),
        { code: 'ENOENT' }, label);
      await assert.rejects(fs.access(path.join(fixture.appDir, '.staging-release.lock')),
        { code: 'ENOENT' }, label);
      await assert.rejects(fs.access(path.join(fixture.root, 'host-operation.lock')),
        { code: 'ENOENT' }, label);
      const dockerLog = await fs.readFile(fixture.commandLog, 'utf8').catch(() => '');
      assert.doesNotMatch(dockerLog, /docker\|(?:build|image tag|image rm|compose .*\bup\b|volume rm)/u,
        label);
      assert.equal(await fs.readFile(`${fixture.commandLog}.image-state`, 'utf8'),
        `${PREVIOUS_IMAGE_ID}\n`, label);
    }
  });

test('staging release owns the shared host-operation guard through mutation and rejects contention',
  async (context) => {
    const probe = runBash(['--version']);
    if (!probe) return context.skip('Git Bash is not installed');
    const guarded = await createFixture();
    context.after(() => removeFixture(guarded.root));
    const success = runDeploy(guarded, { FAKE_REQUIRE_HOST_OPERATION_LOCK: '1' });
    const successLog = await fs.readFile(guarded.commandLog, 'utf8').catch(() => '');
    assert.equal(success.status, 0, `${success.stdout}\n${success.stderr}\n${successLog}`);
    assert.match(successLog, /host-operation-lock-active/u);
    await assert.rejects(fs.access(path.join(guarded.root, 'host-operation.lock')), { code: 'ENOENT' },
      'the exactly-owned host guard must be released after a verified operation');

    const contended = await createFixture();
    context.after(() => removeFixture(contended.root));
    const lockDirectory = path.join(contended.root, 'host-operation.lock');
    await fs.mkdir(lockDirectory, { mode: 0o700 });
    await fs.writeFile(path.join(lockDirectory, 'owner'), [
      'protocol=easyboost-host-operation-v1', 'operation=database-import', 'ownerPid=31337', '',
    ].join('\n'));
    const rejected = runDeploy(contended);
    assert.equal(rejected.status, 75, `${rejected.stdout}\n${rejected.stderr}`);
    assert.equal(await fs.readFile(path.join(lockDirectory, 'owner'), 'utf8'), [
      'protocol=easyboost-host-operation-v1', 'operation=database-import', 'ownerPid=31337', '',
    ].join('\n'), 'a foreign operation guard must remain byte-identical');
    await assert.rejects(fs.access(contended.commandLog), { code: 'ENOENT' },
      'host guard contention must stop before Docker');
  });

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

async function assertPrivateUploadWorkdirCleaned(fixture, ignoredCallerTmp) {
  const workdir = (await fs.readFile(`${fixture.commandLog}.workdir`, 'utf8')).trim();
  assert.ok(workdir.startsWith(`${posixPath(fixture.trustedTmp)}/easyboost-staging-deploy.`),
    `fixed trusted /tmp request must not use caller TMPDIR: ${workdir}`);
  assert.deepEqual(await fs.readdir(fixture.trustedTmp), [],
    'the exact trusted private work directory must be removed');
  assert.deepEqual(await fs.readdir(ignoredCallerTmp), [],
    'caller-controlled TMPDIR must remain unused');
}

test('staging deploy builds the verified archive before activation and retains exact releases', async (context) => {
  const probe = runBash(['--version']);
  if (!probe) return context.skip('Git Bash is not installed');
  assert.equal(probe.status, 0, probe.stderr);
  const fixture = await createFixture();
  context.after(() => removeFixture(fixture.root));

  const result = runDeploy(fixture, { EASYBOOST_STAGING_BUILD_CONTEXT: '/untrusted/live-tree' });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(await fs.readFile(path.join(fixture.appDir, 'shared.txt'), 'utf8'), 'new\n');
  assert.equal(await fs.readFile(path.join(fixture.appDir, 'new-only.txt'), 'utf8'), 'new-only\n');
  await assert.rejects(fs.access(path.join(fixture.appDir, 'old-only.txt')), { code: 'ENOENT' });
  assert.equal(await fs.readFile(path.join(fixture.appDir, '.env.staging'), 'utf8'),
    'APP_PORT=3001\nSECRET=preserved\n');
  assert.equal(await fs.readFile(path.join(fixture.appDir, 'backups', 'keep.dump'), 'utf8'), 'backup\n');
  assert.equal(await fs.readFile(path.join(fixture.appDir, '.release-sha256'), 'utf8'),
    `${fixture.candidate.sha}\n`);

  const retained = path.join(
    fixture.appDir, 'rollbacks', 'releases', `release-${fixture.candidate.sha}.tar.gz`,
  );
  assert.deepEqual(await fs.readFile(retained), await fs.readFile(fixture.candidate.archive));
  assert.equal(await fs.readFile(`${retained}.sha256`, 'utf8'), `${fixture.candidate.sha}\n`);
  const log = (await fs.readFile(fixture.commandLog, 'utf8')).trim().split(/\r?\n/u);
  const build = log.findIndex((line) => line === `docker|build --file Dockerfile --tag easyboost-staging-app:release-${fixture.candidate.sha} -`);
  const input = log.findIndex((line) => line === `stdin-sha|${fixture.candidate.sha}`);
  const promote = log.findIndex((line) => line === `docker|image tag easyboost-staging-app:release-${fixture.candidate.sha} easyboost-staging-app:local`);
  const up = log.findIndex((line) => (
    /docker\|compose .* up --pull never -d --no-build --no-deps app$/u.test(line)
  ));
  const cleanup = log.findIndex((line) => line === `docker|image rm -f easyboost-staging-app:release-${fixture.candidate.sha}`);
  assert.ok(build >= 0 && input > build && promote > input && up > promote && cleanup > up, log.join('\n'));
  assert.equal(log.includes('build-after-mutation'), false);
  assert.doesNotMatch(log.join('\n'), /--build/u);
  assert.doesNotMatch(log.join('\n'), /up --pull never -d --no-build app/u);
  assert.equal(await fs.readFile(`${fixture.commandLog}.postgres-container-state`, 'utf8'),
    `${POSTGRES_IMAGE_ID}\n`, 'app activation must preserve the PostgreSQL image identity');
  assert.equal(await fs.readFile(`${fixture.commandLog}.postgres-container-id-state`, 'utf8'),
    `${POSTGRES_CONTAINER_ID}\n`, 'app activation must preserve the PostgreSQL container identity');
  assert.equal(await fs.readFile(`${fixture.commandLog}.postgres-volume-source-state`, 'utf8'),
    `${POSTGRES_VOLUME_SOURCE}\n`, 'app activation must preserve the PostgreSQL volume mount');
  assertComposeUsesCapturedPostgresAuthority(log.join('\n'), [
    'config', 'up',
  ]);
  const uploadBytes = (await fs.stat(fixture.candidate.archive)).size + (64 * 1024 * 1024);
  assert.match(await fs.readFile(`${fixture.commandLog}.upload-reservations`, 'utf8'),
    new RegExp(`^-l 67108864 -- .*\\.staging-space-reservation-upload\\n-l ${uploadBytes - 67108864} -- .*release\\.tar\\.gz\\n$`, 'u'),
    'the 64 MiB headroom and exact preallocated upload destination must both be retained');
});

test('a failed staging image build preserves the active tree and proves no release tag', async (context) => {
  const probe = runBash(['--version']);
  if (!probe) return context.skip('Git Bash is not installed');
  const fixture = await createFixture();
  context.after(() => removeFixture(fixture.root));

  const result = runDeploy(fixture, { FAKE_BUILD_FAIL: '1' });
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(await fs.readFile(path.join(fixture.appDir, 'shared.txt'), 'utf8'), 'old\n');
  assert.equal(await fs.readFile(path.join(fixture.appDir, 'old-only.txt'), 'utf8'), 'old-only\n');
  await assert.rejects(fs.access(path.join(fixture.appDir, 'new-only.txt')), { code: 'ENOENT' });
  assert.equal(await fs.readFile(path.join(fixture.appDir, '.release-sha256'), 'utf8'),
    `${fixture.previous.sha}\n`);
  const log = await fs.readFile(fixture.commandLog, 'utf8');
  assert.match(log, new RegExp(`docker\\|build .*release-${fixture.candidate.sha}`, 'u'));
  await assert.rejects(fs.access(`${fixture.commandLog}.release-state`), { code: 'ENOENT' });
  assert.doesNotMatch(log, /image tag| up -d app|--build/u);
});

test('a post-build frozen-archive mutation is detected before image promotion or tree changes', async (context) => {
  const probe = runBash(['--version']);
  if (!probe) return context.skip('Git Bash is not installed');
  const fixture = await createFixture();
  context.after(() => removeFixture(fixture.root));

  const result = runDeploy(fixture, { FAKE_MUTATE_FROZEN_AFTER_BUILD: '1' });
  assert.equal(result.status, 65, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /changed during image build/u);
  assert.equal(await fs.readFile(path.join(fixture.appDir, 'shared.txt'), 'utf8'), 'old\n');
  assert.equal(await fs.readFile(path.join(fixture.appDir, '.release-sha256'), 'utf8'),
    `${fixture.previous.sha}\n`);
  const log = await fs.readFile(fixture.commandLog, 'utf8');
  assert.match(log, /docker\|build /u);
  assert.match(log, /docker\|image rm /u);
  assert.doesNotMatch(log, /image tag| up -d |--build/u);
});

test('a failed staging stable-tag promotion preserves the active marker and runnable tree', async (context) => {
  const probe = runBash(['--version']);
  if (!probe) return context.skip('Git Bash is not installed');
  const fixture = await createFixture();
  context.after(() => removeFixture(fixture.root));

  const result = runDeploy(fixture, { FAKE_PROMOTE_FAIL: '1' });
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(await fs.readFile(path.join(fixture.appDir, 'shared.txt'), 'utf8'), 'old\n');
  assert.equal(await fs.readFile(path.join(fixture.appDir, '.release-sha256'), 'utf8'),
    `${fixture.previous.sha}\n`);
  const log = await fs.readFile(fixture.commandLog, 'utf8');
  assert.match(log, /docker\|image tag /u);
  assert.match(log, /docker\|image rm /u);
  assert.doesNotMatch(log, / up -d |--build/u);
});

test('an ambiguous stable-tag result restores the active deployment', async (context) => {
  const active = await createFixture();
  context.after(() => removeFixture(active.root));
  const activeResult = runDeploy(active, { FAKE_PROMOTE_SIDE_EFFECT_ERROR: '1' });
  assert.notEqual(activeResult.status, 0, `${activeResult.stdout}\n${activeResult.stderr}`);
  assert.equal(await fs.readFile(`${active.commandLog}.image-state`, 'utf8'),
    `${PREVIOUS_IMAGE_ID}\n`);
  assert.equal(await fs.readFile(path.join(active.appDir, '.release-sha256'), 'utf8'),
    `${active.previous.sha}\n`);
  assert.equal(await fs.readFile(path.join(active.appDir, 'shared.txt'), 'utf8'), 'old\n');
});

test('an ambiguous stable-tag result removes a failed first deployment', async (context) => {
  const first = await createFixture();
  context.after(() => removeFixture(first.root));
  await makeFirstDeploymentFixture(first);
  const firstResult = runDeploy(first, {
    FAKE_NO_PREVIOUS_IMAGE: '1', FAKE_PROMOTE_SIDE_EFFECT_ERROR: '1',
  });
  assert.notEqual(firstResult.status, 0, `${firstResult.stdout}\n${firstResult.stderr}`);
  await assert.rejects(fs.access(`${first.commandLog}.image-state`), { code: 'ENOENT' });
  await assert.rejects(fs.access(`${first.commandLog}.release-state`), { code: 'ENOENT' });
  await assert.rejects(fs.access(path.join(first.appDir, '.release-sha256')), { code: 'ENOENT' });
  await assert.rejects(fs.access(path.join(first.appDir, 'compose.staging.yml')), { code: 'ENOENT' });
});

test('readiness failure restores the previous stable image, code tree and marker', async (context) => {
  const probe = runBash(['--version']);
  if (!probe) return context.skip('Git Bash is not installed');
  const fixture = await createFixture();
  context.after(() => removeFixture(fixture.root));

  const result = runDeploy(fixture, { FAKE_READINESS_FAIL: '1' });
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(await fs.readFile(path.join(fixture.appDir, 'shared.txt'), 'utf8'), 'old\n');
  assert.equal(await fs.readFile(path.join(fixture.appDir, 'old-only.txt'), 'utf8'), 'old-only\n');
  await assert.rejects(fs.access(path.join(fixture.appDir, 'new-only.txt')), { code: 'ENOENT' });
  assert.equal(await fs.readFile(path.join(fixture.appDir, '.release-sha256'), 'utf8'),
    `${fixture.previous.sha}\n`);
  const candidateStored = path.join(
    fixture.appDir, 'rollbacks', 'releases', `release-${fixture.candidate.sha}.tar.gz`,
  );
  await assert.rejects(fs.access(candidateStored), { code: 'ENOENT' });
  await assert.rejects(fs.access(`${candidateStored}.sha256`), { code: 'ENOENT' });
  const log = await fs.readFile(fixture.commandLog, 'utf8');
  assert.match(log,
    new RegExp(`docker\\|image tag ${PREVIOUS_IMAGE_ID} easyboost-staging-app:local`, 'u'));
  assert.equal((log.match(/up --pull never -d --no-build --no-deps app/gu) ?? []).length, 2,
    `${log}\n${result.stderr}`);
  assertComposeUsesCapturedPostgresAuthority(log, [
    'config', 'up',
  ]);
  await assert.rejects(fs.access(path.join(fixture.appDir, '.staging-recovery-required')),
    { code: 'ENOENT' });
  assert.match(result.stderr, /verified prior state restored/u);
});

test('every partial release-pair publication removes exact temp and final paths before verified recovery',
  async (context) => {
    const probe = runBash(['--version']);
    if (!probe) return context.skip('Git Bash is not installed');
    for (const flag of [
      'FAKE_RELEASE_ARCHIVE_WRITE_FAIL',
      'FAKE_RELEASE_ARCHIVE_HASH_FAIL',
      'FAKE_RELEASE_ARCHIVE_MV_FAIL',
      'FAKE_RELEASE_SIDECAR_WRITE_FAIL',
      'FAKE_RELEASE_SIDECAR_MV_FAIL',
    ]) {
      const fixture = await createFixture();
      context.after(() => removeFixture(fixture.root));
      const result = runDeploy(fixture, { [flag]: '1' });
      assert.notEqual(result.status, 0, `${flag}: ${result.stdout}\n${result.stderr}`);
      assert.equal(await fs.readFile(path.join(fixture.appDir, '.release-sha256'), 'utf8'),
        `${fixture.previous.sha}\n`, flag);
      assert.equal(await fs.readFile(path.join(fixture.appDir, 'shared.txt'), 'utf8'), 'old\n', flag);
      assert.deepEqual((await fs.readdir(
        path.join(fixture.appDir, 'rollbacks', 'releases'),
      )).sort(), [
        `release-${fixture.previous.sha}.tar.gz`,
        `release-${fixture.previous.sha}.tar.gz.sha256`,
      ], `${flag} must leave only the exact predecessor pair`);
      await assert.rejects(() => fs.access(path.join(fixture.appDir, '.staging-recovery-required')),
        { code: 'ENOENT' }, `${flag}: ${result.stdout}\n${result.stderr}\n${
          await fs.readFile(fixture.commandLog, 'utf8')}`);
      assert.match(result.stderr, /verified prior state restored/u, flag);

      const retry = runDeploy(fixture);
      assert.equal(retry.status, 0, `${flag} retry: ${retry.stdout}\n${retry.stderr}`);
    }
  });

test('release-pair cleanup attempts every owned path and never claims an unverified prior store',
  async (context) => {
    const cleanupFailure = await createFixture();
    context.after(() => removeFixture(cleanupFailure.root));
    const cleanupResult = runDeploy(cleanupFailure, {
      FAKE_PAIR_ARCHIVE_FINAL_RM_FAIL: '1',
      FAKE_RELEASE_SIDECAR_WRITE_FAIL: '1',
    });
    assert.equal(cleanupResult.status, 70,
      `${cleanupResult.stdout}\n${cleanupResult.stderr}`);
    const cleanupEntries = await fs.readdir(
      path.join(cleanupFailure.appDir, 'rollbacks', 'releases'),
    );
    assert.equal(cleanupEntries.some((entry) => entry.includes('.sha256.tmp.')), false,
      'a failed archive removal must not prevent independent sidecar-temp cleanup');
    assert.match(await fs.readFile(
      path.join(cleanupFailure.appDir, '.staging-recovery-required'), 'utf8',
    ), /publication|release store|archive pair/iu);
    assert.doesNotMatch(cleanupResult.stderr, /verified prior state restored/u);

    const revalidation = await createFixture();
    context.after(() => removeFixture(revalidation.root));
    const revalidationResult = runDeploy(revalidation, {
      FAKE_RELEASE_SIDECAR_MV_FAIL: '1',
      FAKE_TAMPER_PREVIOUS_STORE_ON_PAIR_CLEANUP: '1',
    });
    assert.equal(revalidationResult.status, 70,
      `${revalidationResult.stdout}\n${revalidationResult.stderr}`);
    assert.match(await fs.readFile(
      path.join(revalidation.appDir, '.staging-recovery-required'), 'utf8',
    ), /release store|retained|archive pair/iu,
    `${revalidationResult.stdout}\n${revalidationResult.stderr}\n${
      await fs.readFile(revalidation.commandLog, 'utf8')}`);
    assert.doesNotMatch(revalidationResult.stderr, /verified prior state restored/u,
      'the success message requires exact post-cleanup predecessor-store verification');
  });

test('release-pair publication never overwrites a foreign final-path race', async (context) => {
  const fixture = await createFixture();
  context.after(() => removeFixture(fixture.root));
  const result = runDeploy(fixture, { FAKE_RELEASE_FINAL_PUBLICATION_REPLACE: '1' });
  const candidateArchive = path.join(
    fixture.appDir, 'rollbacks', 'releases', `release-${fixture.candidate.sha}.tar.gz`,
  );

  assert.equal(result.status, 70, `${result.stdout}\n${result.stderr}`);
  assert.equal(await fs.readFile(candidateArchive, 'utf8'), 'foreign replacement\n');
  assert.doesNotMatch(result.stderr, /verified prior state restored/u);
  assert.doesNotMatch(result.stdout, /staging_release_sha256=|staging_ready=/u);
});

test('release-pair cleanup quarantines and preserves a foreign final-path replacement', async (context) => {
  const fixture = await createFixture();
  context.after(() => removeFixture(fixture.root));
  const result = runDeploy(fixture, {
    FAKE_RELEASE_SIDECAR_WRITE_FAIL: '1',
    FAKE_PAIR_FINAL_CLEANUP_REPLACE: '1',
  });
  const candidateArchive = path.join(
    fixture.appDir, 'rollbacks', 'releases', `release-${fixture.candidate.sha}.tar.gz`,
  );

  assert.equal(result.status, 70, `${result.stdout}\n${result.stderr}`);
  assert.equal(await fs.readFile(candidateArchive, 'utf8'), 'foreign replacement\n');
  assert.doesNotMatch(result.stderr, /verified prior state restored/u);
  assert.doesNotMatch(result.stdout, /staging_release_sha256=|staging_ready=/u);
});

test('failure clearing the transaction marker keeps the committed candidate fail-closed', async (context) => {
  const fixture = await createFixture();
  context.after(() => removeFixture(fixture.root));
  const result = runDeploy(fixture, { FAKE_TRANSACTION_MARKER_RM_FAIL: '1' });
  assert.equal(result.status, 70, `${result.stdout}\n${result.stderr}`);
  assert.equal(await fs.readFile(path.join(fixture.appDir, '.release-sha256'), 'utf8'),
    `${fixture.candidate.sha}\n`);
  assert.equal(await fs.readFile(path.join(fixture.appDir, 'new-only.txt'), 'utf8'), 'new-only\n');
  assert.match(await fs.readFile(
    path.join(fixture.appDir, '.staging-recovery-required'), 'utf8',
  ), /transaction|recovery/iu);
  const log = await fs.readFile(fixture.commandLog, 'utf8');
  assert.doesNotMatch(log, new RegExp(`image tag ${PREVIOUS_IMAGE_ID} easyboost-staging-app:local`, 'u'),
    'a committed candidate must not be rolled back after the commit marker');
});

test('every deploy post-commit retirement failure preserves the committed candidate and fails closed',
  async (context) => {
    for (const [step, flag] of [
      ['prune expired staging database backups', 'FAKE_BACKUP_PRUNE_FAIL'],
      ['remove temporary staging release image', 'FAKE_IMAGE_RM_FAIL'],
      ['release staging disk reservations', 'FAKE_RESERVATION_RM_FAIL'],
      ['remove private staging work directory', 'FAKE_WORKDIR_RM_FAIL'],
    ]) {
      const fixture = await createFixture();
      context.after(() => removeFixture(fixture.root));
      const result = runDeploy(fixture, { [flag]: '1' });
      assert.equal(result.status, 70, `${step}: ${result.stdout}\n${result.stderr}`);
      assert.equal(await fs.readFile(path.join(fixture.appDir, '.release-sha256'), 'utf8'),
        `${fixture.candidate.sha}\n`, step);
      assert.equal(await fs.readFile(path.join(fixture.appDir, 'new-only.txt'), 'utf8'),
        'new-only\n', step);
      assert.equal(await fs.readFile(`${fixture.commandLog}.image-state`, 'utf8'),
        `${CANDIDATE_IMAGE_ID}\n`, step);
      assert.match(await fs.readFile(
        path.join(fixture.appDir, '.staging-recovery-required'), 'utf8',
      ), new RegExp(step.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'), step);
      assert.doesNotMatch(await fs.readFile(fixture.commandLog, 'utf8'),
        new RegExp(`image tag ${PREVIOUS_IMAGE_ID} easyboost-staging-app:local`, 'u'), step);
    }
  });

test('deploy accepts only an authoritative exact-not-found after temporary image removal',
  async (context) => {
    for (const status of ['124', '128', '1']) {
      const fixture = await createFixture();
      context.after(() => removeFixture(fixture.root));
      const result = runDeploy(fixture, { FAKE_RELEASE_INSPECT_AFTER_RM_STATUS: status });
      assert.equal(result.status, 70, `inspect ${status}: ${result.stdout}\n${result.stderr}`);
      assert.doesNotMatch(result.stdout, /staging_release_sha256=|staging_ready=/u, status);
      assert.match(await fs.readFile(
        path.join(fixture.appDir, '.staging-recovery-required'), 'utf8',
      ), /remove temporary staging release image/u, status);
    }
  });

test('deploy rejects every noncanonical Docker image identity before build', async (context) => {
  const fixture = await createFixture();
  context.after(() => removeFixture(fixture.root));
  const result = runDeploy(fixture, { FAKE_NONCANONICAL_IMAGE_IDENTITIES: '1' });

  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.doesNotMatch(await fs.readFile(fixture.commandLog, 'utf8'), /docker\|build/u,
    'a malformed identity must fail before any candidate image is built');
  assert.match(result.stderr, /image identity|inspection/iu);
});

test('deploy recovery cannot claim a restored predecessor after an indeterminate image probe',
  async (context) => {
    for (const status of ['124', '128', '1']) {
      const fixture = await createFixture();
      context.after(() => removeFixture(fixture.root));
      const result = runDeploy(fixture, {
        FAKE_READINESS_FAIL: '1', FAKE_RELEASE_INSPECT_AFTER_RM_STATUS: status,
      });
      assert.equal(result.status, 70, `probe ${status}: ${result.stdout}\n${result.stderr}`);
      assert.doesNotMatch(result.stderr, /verified prior state restored/u, status);
      assert.doesNotMatch(result.stdout, /staging_release_sha256=|staging_ready=/u, status);
      assert.match(await fs.readFile(
        path.join(fixture.appDir, '.staging-recovery-required'), 'utf8',
      ), /remove temporary staging release image/u, status);
    }
  });

test('deploy rejects every indeterminate temporary-image preflight before Docker build',
  async (context) => {
    for (const status of ['124', '128', '1']) {
      const fixture = await createFixture();
      context.after(() => removeFixture(fixture.root));
      const result = runDeploy(fixture, { FAKE_RELEASE_PROBE_BEFORE_BUILD_STATUS: status });
      assert.equal(result.status, 70, `probe ${status}: ${result.stdout}\n${result.stderr}`);
      const log = await fs.readFile(fixture.commandLog, 'utf8');
      assert.doesNotMatch(log, /docker\|build /u, status);
      assert.doesNotMatch(result.stdout, /staging_release_sha256=|staging_ready=/u, status);
    }
  });

test('deploy never removes a temporary image reference after its captured identity drifts',
  async (context) => {
    const fixture = await createFixture();
    context.after(() => removeFixture(fixture.root));
    const result = runDeploy(fixture, { FAKE_RELEASE_IMAGE_DRIFT_BEFORE_RM: '1' });
    assert.equal(result.status, 70, `${result.stdout}\n${result.stderr}`);
    assert.doesNotMatch(result.stdout, /staging_release_sha256=|staging_ready=/u);
    assert.doesNotMatch(await fs.readFile(fixture.commandLog, 'utf8'),
      new RegExp(`image rm -f easyboost-staging-app:release-${fixture.candidate.sha}`, 'u'),
      'a foreign replacement behind the exact temporary tag must never be deleted');
    assert.match(await fs.readFile(
      path.join(fixture.appDir, '.staging-recovery-required'), 'utf8',
  ), /remove temporary staging release image/u);
});

test('deploy does not remove a foreign tag rebound after the ownership probe', async (context) => {
  const fixture = await createFixture();
  context.after(() => removeFixture(fixture.root));
  const result = runDeploy(fixture, { FAKE_RELEASE_REBOUND_AFTER_OWNERSHIP_PROBE: '1' });

  assert.equal(result.status, 70, `${result.stdout}\n${result.stderr}`);
  assert.equal(await fs.readFile(`${fixture.commandLog}.release-state`, 'utf8'), `${FOREIGN_IMAGE_ID}\n`,
    'the replacement tag must survive fail-closed cleanup');
  const log = await fs.readFile(fixture.commandLog, 'utf8');
  assert.doesNotMatch(log,
    new RegExp(`image rm -f easyboost-staging-app:release-${fixture.candidate.sha}`, 'u'));
  assert.doesNotMatch(log, new RegExp(`image rm -f ${CANDIDATE_IMAGE_ID}`, 'u'),
    'cleanup must never delete the immutable image ID');
});

test('deploy and rollback use one common ordered release finalizer without mode switches',
  async () => {
    const [deploySource, rollbackSource, commonSource] = await Promise.all([
      fs.readFile(deployScript, 'utf8'),
      fs.readFile(path.resolve('scripts/staging-rollback.sh'), 'utf8'),
      fs.readFile(commonScript, 'utf8'),
    ]);
    assert.match(commonSource,
      /finalize_release_boundaries\(\)[\s\S]*remove_owned_image_reference[\s\S]*release_space_reservations[\s\S]*rm -rf -- "\$work_dir"[\s\S]*clear_transaction_marker[\s\S]*"\$proof_hook"/u,
      'one seam must own image → reservations → workdir → marker → exact state proof');
    assert.ok((deploySource.match(/finalize_release_boundaries/gu) ?? []).length >= 2,
      'deploy success and recovery cleanup must use the common finalizer');
    assert.ok((rollbackSource.match(/finalize_release_boundaries/gu) ?? []).length >= 2,
      'rollback success and recovery cleanup must use the common finalizer');
    assert.doesNotMatch(commonSource, /eval\s|case\s+"?\$.*(?:deploy|rollback)/u,
      'the finalizer must dispatch one literal proof callback, not a mode switchboard');
  });

test('normal success revalidates the whole release store after its reservation is removed',
  async (context) => {
    const fixture = await createFixture();
    context.after(() => removeFixture(fixture.root));
    const result = runDeploy(fixture, { FAKE_ADD_STORE_ENTRY_AFTER_RESERVATION_RELEASE: '1' });
    assert.equal(result.status, 70, `${result.stdout}\n${result.stderr}`);
    assert.equal(await fs.readFile(path.join(fixture.appDir, '.release-sha256'), 'utf8'),
      `${fixture.candidate.sha}\n`);
    assert.equal(await fs.readFile(path.join(fixture.appDir, 'new-only.txt'), 'utf8'), 'new-only\n');
    assert.match(await fs.readFile(
      path.join(fixture.appDir, '.staging-recovery-required'), 'utf8',
    ), /verify final staging release store/u);
    assert.doesNotMatch(result.stdout, /staging_release_sha256=|staging_ready=/u,
      'success evidence must not be emitted until the reservation-free store is verified');
  });

test('active-marker publication failure recovers while predecessor material and reservations remain available', async (context) => {
  const fixture = await createFixture();
  context.after(() => removeFixture(fixture.root));
  const result = runDeploy(fixture, { FAKE_ACTIVE_MARKER_PUBLISH_FAIL: '1' });
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(await fs.readFile(path.join(fixture.appDir, '.release-sha256'), 'utf8'),
    `${fixture.previous.sha}\n`);
  assert.equal(await fs.readFile(path.join(fixture.appDir, 'shared.txt'), 'utf8'), 'old\n');
  assert.equal(await fs.readFile(`${fixture.commandLog}.image-state`, 'utf8'),
    `${PREVIOUS_IMAGE_ID}\n`);
  await assert.rejects(fs.access(path.join(fixture.appDir, '.staging-recovery-required')),
    { code: 'ENOENT' });
  assert.match(result.stderr, /verified prior state restored/u);
});

test('first deployment success and post-promotion failure leave a bootstrappable exact state', async (context) => {
  const probe = runBash(['--version']);
  if (!probe) return context.skip('Git Bash is not installed');

  const success = await createFixture();
  context.after(() => removeFixture(success.root));
  await makeFirstDeploymentFixture(success);
  const first = runDeploy(success, { FAKE_NO_PREVIOUS_IMAGE: '1' });
  assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`);
  assert.equal(await fs.readFile(path.join(success.appDir, 'shared.txt'), 'utf8'), 'new\n');
  assert.equal(await fs.readFile(path.join(success.appDir, '.release-sha256'), 'utf8'),
    `${success.candidate.sha}\n`);

  const failure = await createFixture();
  context.after(() => removeFixture(failure.root));
  await makeFirstDeploymentFixture(failure);
  const failed = runDeploy(failure, {
    FAKE_NO_PREVIOUS_IMAGE: '1', FAKE_READINESS_FAIL: '1',
  });
  assert.equal(failed.status, 1, `${failed.stdout}\n${failed.stderr}`);
  for (const absent of [
    'compose.staging.yml', 'Dockerfile', 'shared.txt', 'new-only.txt', '.release-sha256',
    '.staging-recovery-required',
  ]) await assert.rejects(fs.access(path.join(failure.appDir, absent)), { code: 'ENOENT' });
  const candidateStored = path.join(
    failure.appDir, 'rollbacks', 'releases', `release-${failure.candidate.sha}.tar.gz`,
  );
  await assert.rejects(fs.access(candidateStored), { code: 'ENOENT' });
  await assert.rejects(fs.access(`${candidateStored}.sha256`), { code: 'ENOENT' });
  await assert.rejects(fs.access(`${failure.commandLog}.image-state`), { code: 'ENOENT' });
  for (const state of ['container-state', 'postgres-container-state', 'volume-state', 'network-state']) {
    await assert.rejects(fs.access(`${failure.commandLog}.${state}`), { code: 'ENOENT' });
  }
  const failureLog = await fs.readFile(failure.commandLog, 'utf8');
  assert.match(failureLog,
    /docker\|compose .* down --volumes --remove-orphans/u,
    'failed first deploy must remove the exact Compose project before image cleanup');
  assertComposeUsesCapturedPostgresAuthority(failureLog, [
    'config', 'down',
  ]);
  assert.match(failed.stderr, /verified prior state restored/u);

  const retry = runDeploy(failure, { FAKE_NO_PREVIOUS_IMAGE: '1' });
  assert.equal(retry.status, 0, `${retry.stdout}\n${retry.stderr}`);
  assert.equal(await fs.readFile(path.join(failure.appDir, '.release-sha256'), 'utf8'),
    `${failure.candidate.sha}\n`);

  const partialPublication = await createFixture();
  context.after(() => removeFixture(partialPublication.root));
  await makeFirstDeploymentFixture(partialPublication);
  const partial = runDeploy(partialPublication, {
    FAKE_NO_PREVIOUS_IMAGE: '1', FAKE_RELEASE_SIDECAR_MV_FAIL: '1',
  });
  assert.notEqual(partial.status, 0, `${partial.stdout}\n${partial.stderr}`);
  assert.deepEqual(await fs.readdir(
    path.join(partialPublication.appDir, 'rollbacks', 'releases'),
  ), [], 'a failed first-deploy publication must restore the exact empty release store');
  for (const absent of ['compose.staging.yml', 'Dockerfile', 'shared.txt', 'new-only.txt',
    '.release-sha256', '.staging-recovery-required']) {
    await assert.rejects(fs.access(path.join(partialPublication.appDir, absent)), { code: 'ENOENT' });
  }
  assert.match(partial.stderr, /verified prior state restored/u);
  const partialRetry = runDeploy(partialPublication, { FAKE_NO_PREVIOUS_IMAGE: '1' });
  assert.equal(partialRetry.status, 0, `${partialRetry.stdout}\n${partialRetry.stderr}`);
});

test('first-deploy recovery fails closed when any exact Compose project object survives cleanup',
  async (context) => {
    for (const [label, flag, state] of [
      ['app container', 'FAKE_APP_CONTAINER_RESIDUE', 'container-state'],
      ['postgres container', 'FAKE_POSTGRES_CONTAINER_RESIDUE', 'postgres-container-state'],
      ['postgres volume', 'FAKE_VOLUME_RESIDUE', 'volume-state'],
      ['backend network', 'FAKE_NETWORK_RESIDUE', 'network-state'],
    ]) {
      const fixture = await createFixture();
      context.after(() => removeFixture(fixture.root));
      await makeFirstDeploymentFixture(fixture);
      const result = runDeploy(fixture, {
        FAKE_NO_PREVIOUS_IMAGE: '1', FAKE_READINESS_FAIL: '1', [flag]: '1',
      });
      assert.equal(result.status, 70, `${label}: ${result.stdout}\n${result.stderr}`);
      assert.match(result.stderr, /recovery failed at: verify failed first Compose project removal/u,
        label);
      await fs.access(`${fixture.commandLog}.${state}`);
      assert.match(await fs.readFile(
        path.join(fixture.appDir, '.staging-recovery-required'), 'utf8',
      ), /manual recovery required/u, label);
    }
  });

test('first deploy refuses contaminated Docker state and recovers pre-promotion failures to empty', async (context) => {
  for (const flag of ['FAKE_FIRST_STALE_STABLE', 'FAKE_FIRST_STALE_RELEASE',
    'FAKE_FIRST_STALE_CONTAINER']) {
    const fixture = await createFixture();
    context.after(() => removeFixture(fixture.root));
    await makeFirstDeploymentFixture(fixture);
    const result = runDeploy(fixture, { FAKE_NO_PREVIOUS_IMAGE: '1', [flag]: '1' });
    assert.notEqual(result.status, 0, `${flag}: ${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /empty bootstrappable/iu);
    assert.doesNotMatch(await fs.readFile(fixture.commandLog, 'utf8'), /docker\|build /u);
  }

  const failedBuild = await createFixture();
  context.after(() => removeFixture(failedBuild.root));
  await makeFirstDeploymentFixture(failedBuild);
  const failed = runDeploy(failedBuild, { FAKE_NO_PREVIOUS_IMAGE: '1', FAKE_BUILD_FAIL: '1' });
  assert.notEqual(failed.status, 0, `${failed.stdout}\n${failed.stderr}`);
  for (const absent of ['compose.staging.yml', '.release-sha256', '.staging-recovery-required']) {
    await assert.rejects(fs.access(path.join(failedBuild.appDir, absent)), { code: 'ENOENT' });
  }
  await assert.rejects(fs.access(`${failedBuild.commandLog}.image-state`), { code: 'ENOENT' });
  await assert.rejects(fs.access(`${failedBuild.commandLog}.release-state`), { code: 'ENOENT' });
  const retry = runDeploy(failedBuild, { FAKE_NO_PREVIOUS_IMAGE: '1' });
  assert.equal(retry.status, 0, `${retry.stdout}\n${retry.stderr}`);
});

test('every checked active recovery failure is separately diagnosed and leaves fail-closed state', async (context) => {
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
    context.after(() => removeFixture(fixture.root));
    const result = runDeploy(fixture, { FAKE_READINESS_FAIL: '1', [flag]: '1' });
    assert.equal(result.status, 70, `${label}: ${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /Primary staging deploy failed with status 1; recovery failed at:/u);
    assert.match(await fs.readFile(
      path.join(fixture.appDir, '.staging-recovery-required'), 'utf8',
    ), /manual recovery required/u);
    const logBefore = (await fs.readFile(fixture.commandLog, 'utf8')).length;
    const blocked = runDeploy(fixture);
    assert.equal(blocked.status, 70, `${label}: ${blocked.stdout}\n${blocked.stderr}`);
    assert.equal((await fs.readFile(fixture.commandLog, 'utf8')).length, logBefore,
      `${label}: fail-closed retry must not reach Docker`);
  }
});

test('first-deployment cleanup failure is explicit and leaves a recovery-required marker', async (context) => {
  const probe = runBash(['--version']);
  if (!probe) return context.skip('Git Bash is not installed');
  const fixture = await createFixture();
  context.after(() => removeFixture(fixture.root));
  await makeFirstDeploymentFixture(fixture);
  const result = runDeploy(fixture, {
    FAKE_NO_PREVIOUS_IMAGE: '1', FAKE_READINESS_FAIL: '1', FAKE_IMAGE_RM_FAIL: '1',
  });
  assert.equal(result.status, 70, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /recovery failed at: remove failed first release image/u);
  assert.match(await fs.readFile(
    path.join(fixture.appDir, '.staging-recovery-required'), 'utf8',
  ), /manual recovery required[\s\S]*primary_status=1[\s\S]*recovery_status=/u);
});

test('stale deploy protocol and bounded store failures happen before Docker or code mutation', async (context) => {
  const probe = runBash(['--version']);
  if (!probe) return context.skip('Git Bash is not installed');

  const stale = await createFixture();
  context.after(() => removeFixture(stale.root));
  const staleResult = runBash([
    posixPath(deployScript), posixPath(stale.candidate.archive), stale.candidate.sha,
  ], {
    env: {
      ...process.env, BASH_ENV: posixPath(stale.bashEnv), COMMAND_LOG: posixPath(stale.commandLog),
      STAGING_APP_DIR: posixPath(stale.appDir),
    },
  });
  assert.equal(staleResult.status, 64, `${staleResult.stdout}\n${staleResult.stderr}`);
  await assert.rejects(fs.access(stale.commandLog), { code: 'ENOENT' });
  assert.equal(await fs.readFile(path.join(stale.appDir, 'shared.txt'), 'utf8'), 'old\n');

  const bounded = await createFixture();
  context.after(() => removeFixture(bounded.root));
  for (let index = 0; index < 4; index += 1) {
    const release = await createRelease(bounded.root, `retained-${index}`, `retained-${index}`);
    const stored = path.join(
      bounded.appDir, 'rollbacks', 'releases', `release-${release.sha}.tar.gz`,
    );
    await fs.copyFile(release.archive, stored);
    await fs.writeFile(`${stored}.sha256`, `${release.sha}\n`);
    await Promise.all([
      fs.chmod(stored, 0o600),
      fs.chmod(`${stored}.sha256`, 0o600),
    ]);
  }
  const boundedResult = runDeploy(bounded);
  assert.equal(boundedResult.status, 67, `${boundedResult.stdout}\n${boundedResult.stderr}`);
  assert.match(boundedResult.stderr, /pair bound/u);
  await assert.rejects(fs.access(bounded.commandLog), { code: 'ENOENT' });
  assert.equal(await fs.readFile(path.join(bounded.appDir, '.release-sha256'), 'utf8'),
    `${bounded.previous.sha}\n`);
});

test('release store rejects temporary debris and malformed checksum sidecars before Docker', async (context) => {
  const probe = runBash(['--version']);
  if (!probe) return context.skip('Git Bash is not installed');

  const debris = await createFixture();
  context.after(() => removeFixture(debris.root));
  const debrisPath = path.join(debris.appDir, 'rollbacks', 'releases', '.candidate.tmp');
  await fs.writeFile(debrisPath, 'partial\n');
  await fs.chmod(debrisPath, 0o600);
  const debrisResult = runDeploy(debris);
  assert.equal(debrisResult.status, 67, `${debrisResult.stdout}\n${debrisResult.stderr}`);
  assert.match(debrisResult.stderr, /unowned or temporary debris/u);
  await assert.rejects(fs.access(debris.commandLog), { code: 'ENOENT' });
  assert.equal(await fs.readFile(path.join(debris.appDir, 'shared.txt'), 'utf8'), 'old\n');

  const sidecar = await createFixture();
  context.after(() => removeFixture(sidecar.root));
  const previousSidecar = path.join(
    sidecar.appDir, 'rollbacks', 'releases', `release-${sidecar.previous.sha}.tar.gz.sha256`,
  );
  await fs.appendFile(previousSidecar, 'unexpected-second-line\n');
  const sidecarResult = runDeploy(sidecar);
  assert.equal(sidecarResult.status, 67, `${sidecarResult.stdout}\n${sidecarResult.stderr}`);
  assert.match(sidecarResult.stderr, /exactly one lowercase SHA-256 line|byte bound or exact size/u);
  await assert.rejects(fs.access(sidecar.commandLog), { code: 'ENOENT' });
  assert.equal(await fs.readFile(path.join(sidecar.appDir, 'shared.txt'), 'utf8'), 'old\n');
});

test('active release marker requires exactly one lowercase SHA line with a newline', async (context) => {
  for (const [label, body] of [
    ['extra line', null],
    ['uppercase', 'uppercase'],
    ['missing newline', 'missing-newline'],
  ]) {
    const fixture = await createFixture();
    context.after(() => removeFixture(fixture.root));
    const marker = path.join(fixture.appDir, '.release-sha256');
    if (body === null) await fs.writeFile(marker, `${fixture.previous.sha}\nextra\n`);
    else if (body === 'uppercase') await fs.writeFile(marker, `${fixture.previous.sha.toUpperCase()}\n`);
    else await fs.writeFile(marker, fixture.previous.sha);
    const result = runDeploy(fixture);
    assert.equal(result.status, 67, `${label}: ${result.stdout}\n${result.stderr}`);
    const log = await fs.readFile(fixture.commandLog, 'utf8').catch(() => '');
    assert.doesNotMatch(log, /docker\|build /u, label);
  }
});

test('the shared nonblocking staging release lock rejects concurrent deploy before Docker', async (context) => {
  const probe = runBash(['--version']);
  if (!probe) return context.skip('Git Bash is not installed');
  const fixture = await createFixture();
  context.after(() => removeFixture(fixture.root));
  const result = runDeploy(fixture, { FAKE_LOCK_BUSY: '1' });
  assert.equal(result.status, 75, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /release operation is active/u);
  assert.equal(await fs.readFile(path.join(fixture.appDir, 'shared.txt'), 'utf8'), 'old\n');
  await assert.rejects(fs.access(fixture.commandLog), { code: 'ENOENT' });
});

test('protected staging store and lock paths reject symlinks before write or Docker', async (context) => {
  const fixture = await createFixture();
  context.after(() => removeFixture(fixture.root));
  const store = path.join(fixture.appDir, 'rollbacks', 'releases');
  const outsideStore = path.join(fixture.root, 'outside-store');
  await fs.rm(store, { recursive: true, force: true });
  await fs.mkdir(outsideStore);
  await fs.symlink(outsideStore, store, 'junction');
  const result = runDeploy(fixture);
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /symlink|protected|release store|runtime/iu);
  assert.deepEqual(await fs.readdir(outsideStore), []);
  const log = await fs.readFile(fixture.commandLog, 'utf8').catch(() => '');
  assert.doesNotMatch(log, /docker\|/u);

  const lockFixture = await createFixture();
  context.after(() => removeFixture(lockFixture.root));
  const outsideLock = path.join(lockFixture.root, 'outside-lock');
  const lock = path.join(lockFixture.appDir, '.staging-release.lock');
  await fs.writeFile(outsideLock, 'must-not-change\n');
  try {
    await fs.symlink(outsideLock, lock, 'file');
  } catch (error) {
    if (error.code === 'EPERM') return;
    throw error;
  }
  const lockResult = runDeploy(lockFixture);
  assert.notEqual(lockResult.status, 0, `${lockResult.stdout}\n${lockResult.stderr}`);
  assert.equal(await fs.readFile(outsideLock, 'utf8'), 'must-not-change\n');
  const lockLog = await fs.readFile(lockFixture.commandLog, 'utf8').catch(() => '');
  assert.doesNotMatch(lockLog, /docker\|/u);
});

test('deploy refuses a legacy active tree without a verified retained source archive', async (context) => {
  const probe = runBash(['--version']);
  if (!probe) return context.skip('Git Bash is not installed');
  const fixture = await createFixture();
  context.after(() => removeFixture(fixture.root));
  await fs.rm(path.join(fixture.appDir, '.release-sha256'));
  await fs.rm(path.join(fixture.appDir, 'rollbacks', 'releases'), { recursive: true, force: true });
  await fs.mkdir(path.join(fixture.appDir, 'rollbacks', 'releases'));
  await fs.chmod(path.join(fixture.appDir, 'rollbacks', 'releases'), 0o700);

  const result = runDeploy(fixture);
  assert.equal(result.status, 67, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /active release metadata is incomplete|verified retained release archive/iu);
  assert.equal(await fs.readFile(path.join(fixture.appDir, 'shared.txt'), 'utf8'), 'old\n');
  await assert.rejects(fs.access(fixture.commandLog), { code: 'ENOENT' });
});

test('deploy rejects stable-tag and running-container drift before build or mutation', async (context) => {
  const fixture = await createFixture();
  context.after(() => removeFixture(fixture.root));
  const markerBefore = await fs.readFile(path.join(fixture.appDir, '.release-sha256'), 'utf8');
  const result = runDeploy(fixture, { FAKE_RUNNING_IMAGE_DRIFT: '1' });
  assert.equal(result.status, 67, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /running|predecessor|active staging image/iu);
  const log = await fs.readFile(fixture.commandLog, 'utf8').catch(() => '');
  assert.doesNotMatch(log, /docker\|build /u);
  assert.equal(await fs.readFile(path.join(fixture.appDir, '.release-sha256'), 'utf8'), markerBefore);
  assert.equal(await fs.readFile(path.join(fixture.appDir, 'old-only.txt'), 'utf8'), 'old-only\n');
});

test('deploy admits live/store/temp peak capacity before Docker or active-tree mutation', async (context) => {
  const fixture = await createFixture();
  context.after(() => removeFixture(fixture.root));
  const result = runDeploy(fixture, { FAKE_LOW_APP_DISK: '1' });
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /disk|space|headroom|capacity/iu);
  const log = await fs.readFile(fixture.commandLog, 'utf8');
  assert.doesNotMatch(log, /docker\|build /u);
  assert.equal(await fs.readFile(path.join(fixture.appDir, 'old-only.txt'), 'utf8'), 'old-only\n');
  assert.equal(await fs.readFile(path.join(fixture.appDir, '.release-sha256'), 'utf8'),
    `${fixture.previous.sha}\n`);
});

test('deploy rejects a byte-identical upload swap after capture and cleans its exact pre-copy state', async (context) => {
  const probe = runBash(['--version']);
  if (!probe) return context.skip('Git Bash is not installed');
  const fixture = await createFixture();
  context.after(() => removeFixture(fixture.root));
  const replacement = path.join(fixture.root, 'byte-identical-replacement.tar.gz');
  const temporaryRoot = path.join(fixture.root, 'deploy-temporary');
  await Promise.all([
    fs.copyFile(fixture.candidate.archive, replacement),
    fs.mkdir(temporaryRoot),
  ]);
  const result = runDeploy(fixture, {
    FAKE_UPLOAD_REPLACEMENT: posixPath(replacement),
    FAKE_UPLOAD_SOURCE: posixPath(fixture.candidate.archive),
    FAKE_UPLOAD_SWAP_DURING_RESERVATION: '1',
    TMPDIR: posixPath(temporaryRoot),
  });
  assert.equal(result.status, 65, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /uploaded release archive.*identity changed/iu);
  assert.doesNotMatch(await fs.readFile(fixture.commandLog, 'utf8').catch(() => ''),
    /docker\|build /u);
  await assertPrivateUploadWorkdirCleaned(fixture, temporaryRoot);
});

test('deploy fails before upload copy when exact pre-copy capacity cannot be reserved', async (context) => {
  const fixture = await createFixture();
  context.after(() => removeFixture(fixture.root));
  const temporaryRoot = path.join(fixture.root, 'deploy-temporary');
  await fs.mkdir(temporaryRoot);
  const result = runDeploy(fixture, {
    FAKE_UPLOAD_CAPACITY_FAIL: '1',
    TMPDIR: posixPath(temporaryRoot),
  });
  assert.equal(result.status, 68, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /upload.*(?:capacity|reservation|headroom)/iu);
  assert.doesNotMatch(await fs.readFile(fixture.commandLog, 'utf8').catch(() => ''),
    /docker\|build /u);
  await assertPrivateUploadWorkdirCleaned(fixture, temporaryRoot);
});

test('deploy rejects a symlink replacement between upload capture and descriptor open', async (context) => {
  const fixture = await createFixture();
  context.after(() => removeFixture(fixture.root));
  const replacement = path.join(fixture.root, 'symlink-target.tar.gz');
  const temporaryRoot = path.join(fixture.root, 'deploy-temporary');
  await Promise.all([
    fs.copyFile(fixture.candidate.archive, replacement),
    fs.mkdir(temporaryRoot),
  ]);
  const result = runDeploy(fixture, {
    FAKE_UPLOAD_REPLACEMENT: posixPath(replacement),
    FAKE_UPLOAD_SOURCE: posixPath(fixture.candidate.archive),
    FAKE_UPLOAD_SYMLINK_DURING_RESERVATION: '1',
    TMPDIR: posixPath(temporaryRoot),
  });
  const symlinkCreated = await fs.access(`${fixture.commandLog}.upload-symlinked`)
    .then(() => true, () => false);
  if (!symlinkCreated) {
    assert.equal(result.status, 68, `${result.stdout}\n${result.stderr}`);
    await assertPrivateUploadWorkdirCleaned(fixture, temporaryRoot);
    return context.skip('Git Bash cannot create a real file symlink on this host');
  }
  assert.equal(result.status, 65, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /uploaded release archive.*(?:no-follow|identity changed)/iu);
  assert.doesNotMatch(await fs.readFile(fixture.commandLog, 'utf8').catch(() => ''),
    /docker\|build /u);
  await assertPrivateUploadWorkdirCleaned(fixture, temporaryRoot);
});

test('deploy rejects an oversized sparse upload before reservation, copy or Docker', async (context) => {
  const fixture = await createFixture();
  context.after(() => removeFixture(fixture.root));
  const temporaryRoot = path.join(fixture.root, 'deploy-temporary');
  await fs.mkdir(temporaryRoot);
  await fs.truncate(fixture.candidate.archive, (256 * 1024 * 1024) + 1);
  fixture.candidate.sha = 'a'.repeat(64);
  const result = runDeploy(fixture, { TMPDIR: posixPath(temporaryRoot) });
  assert.equal(result.status, 65, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /byte bound/iu);
  assert.doesNotMatch(await fs.readFile(fixture.commandLog, 'utf8').catch(() => ''),
    /docker\|build /u);
  await assertPrivateUploadWorkdirCleaned(fixture, temporaryRoot);
});

test('partial pre-copy allocation failures clean only their private exact state', async (context) => {
  for (const flag of ['FAKE_UPLOAD_CAPACITY_SIDE_EFFECT_FAIL',
    'FAKE_UPLOAD_OUTPUT_SIDE_EFFECT_FAIL']) {
    const fixture = await createFixture();
    context.after(() => removeFixture(fixture.root));
    const temporaryRoot = path.join(fixture.root, 'deploy-temporary');
    await fs.mkdir(temporaryRoot);
    const result = runDeploy(fixture, {
      [flag]: '1',
      TMPDIR: posixPath(temporaryRoot),
    });
    assert.equal(result.status, 68, `${flag}: ${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /upload.*(?:capacity|reservation|headroom)/iu);
    await assertPrivateUploadWorkdirCleaned(fixture, temporaryRoot);
    await assert.rejects(fs.access(path.join(fixture.appDir, '.staging-recovery-required')),
      { code: 'ENOENT' });
  }
});

test('disk reservation must prove allocated blocks and leaves no reservation debris', async (context) => {
  if (process.platform !== 'win32') {
    const sparse = await createFixture();
    context.after(() => removeFixture(sparse.root));
    const rejected = runDeploy(sparse, { FAKE_SPARSE_RESERVATION: '1' });
    assert.equal(rejected.status, 68, `${rejected.stdout}\n${rejected.stderr}`);
    assert.match(rejected.stderr, /reservation.*(?:capacity|proven)|disk/iu);
    const rejectedLog = await fs.readFile(sparse.commandLog, 'utf8').catch(() => '');
    assert.doesNotMatch(rejectedLog, /docker\|build /u);
  }

  const valid = await createFixture();
  context.after(() => removeFixture(valid.root));
  const result = runDeploy(valid);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const debris = [];
  async function visit(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.name.includes('.staging-space-reservation')) debris.push(absolute);
      if (entry.isDirectory()) await visit(absolute);
    }
  }
  await visit(valid.appDir);
  assert.deepEqual(debris, []);
});

test('bounded database backup failure is pre-promotion and leaves no partial live artifact', async (context) => {
  for (const flag of ['FAKE_PG_DUMP_FAIL', 'FAKE_BACKUP_WRITE_TIMEOUT']) {
    const fixture = await createFixture();
    context.after(() => removeFixture(fixture.root));
    const result = runDeploy(fixture, { [flag]: '1' });
    assert.notEqual(result.status, 0, `${flag}: ${result.stdout}\n${result.stderr}`);
    const log = await fs.readFile(fixture.commandLog, 'utf8').catch((error) => {
      assert.fail(`${flag}: ${error.message}\n${result.stdout}\n${result.stderr}`);
    });
    assert.match(log, /exec -T postgres pg_dump/u);
    assert.doesNotMatch(log, /image tag .*easyboost-staging-app:local/u);
    assert.equal(await fs.readFile(path.join(fixture.appDir, 'old-only.txt'), 'utf8'), 'old-only\n');
    assert.deepEqual((await fs.readdir(path.join(fixture.appDir, 'backups'))).sort(), ['keep.dump']);
    await assert.rejects(fs.access(path.join(fixture.appDir, '.staging-recovery-required')),
      { code: 'ENOENT' });
  }
});

test('database backup publication is crash-durable before stable-image promotion', async (context) => {
  for (const flag of ['FAKE_BACKUP_FILE_SYNC_FAIL', 'FAKE_BACKUP_PARENT_SYNC_FAIL']) {
    const fixture = await createFixture();
    context.after(() => removeFixture(fixture.root));
    const result = runDeploy(fixture, { [flag]: '1' });
    assert.notEqual(result.status, 0, `${flag}: ${result.stdout}\n${result.stderr}`);
    const log = await fs.readFile(fixture.commandLog, 'utf8').catch((error) => {
      assert.fail(`${flag}: ${error.message}\n${result.stdout}\n${result.stderr}`);
    });
    assert.match(log, /exec -T postgres pg_dump/u);
    assert.doesNotMatch(log, /image tag .*easyboost-staging-app:local/u);
    assert.equal(await fs.readFile(path.join(fixture.appDir, 'old-only.txt'), 'utf8'), 'old-only\n');
    const backups = await fs.readdir(path.join(fixture.appDir, 'backups'));
    assert.equal(backups.some((name) => name.includes('.tmp.')), false,
      `${flag}: ${backups.join(', ')}`);
  }
});

test('pinned protected runtime identity rejects a same-owner post-lock replacement before promotion', async (context) => {
  const fixture = await createFixture();
  context.after(() => removeFixture(fixture.root));
  const marker = await fs.readFile(path.join(fixture.appDir, '.release-sha256'), 'utf8');
  const result = runDeploy(fixture, { FAKE_SWAP_ENV_AFTER_BUILD: '1' });
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /protected staging runtime (?:identity|authority) changed|protected.*identity/iu);
  const log = await fs.readFile(fixture.commandLog, 'utf8');
  assert.match(log, /docker\|build /u);
  assert.doesNotMatch(log, /image tag .*easyboost-staging-app:local/u);
  assert.equal(await fs.readFile(path.join(fixture.appDir, '.release-sha256'), 'utf8'), marker);
  assert.equal(await fs.readFile(path.join(fixture.appDir, 'old-only.txt'), 'utf8'), 'old-only\n');
});

test('active-marker and release-store authority remain closed after lock acquisition', async (context) => {
  for (const flag of ['FAKE_REWRITE_ACTIVE_MARKER_AFTER_BUILD', 'FAKE_ADD_STORE_ENTRY_AFTER_BUILD']) {
    const fixture = await createFixture();
    context.after(() => removeFixture(fixture.root));
    const result = runDeploy(fixture, { [flag]: '1' });
    assert.equal(result.status, 70, `${flag}: ${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /authority|identity|membership|changed/iu);
    assert.doesNotMatch(await fs.readFile(fixture.commandLog, 'utf8'),
      /image tag .*easyboost-staging-app:local/u);
    assert.match(await fs.readFile(
      path.join(fixture.appDir, '.staging-recovery-required'), 'utf8'),
    /protected staging authority changed/iu);
  }
});

test('pinned protected environment rejects same-inode byte rewrites and unsafe private modes', async (context) => {
  const rewritten = await createFixture();
  context.after(() => removeFixture(rewritten.root));
  const rewriteResult = runDeploy(rewritten, { FAKE_REWRITE_ENV_IN_PLACE_AFTER_BUILD: '1' });
  assert.notEqual(rewriteResult.status, 0, `${rewriteResult.stdout}\n${rewriteResult.stderr}`);
  assert.match(rewriteResult.stderr, /protected staging runtime authority changed/iu);
  assert.doesNotMatch(await fs.readFile(rewritten.commandLog, 'utf8'),
    /image tag .*easyboost-staging-app:local/u);

  if (process.platform !== 'win32') {
    const publicEnv = await createFixture();
    context.after(() => removeFixture(publicEnv.root));
    await fs.chmod(path.join(publicEnv.appDir, '.env.staging'), 0o644);
    const modeResult = runDeploy(publicEnv);
    assert.equal(modeResult.status, 67, `${modeResult.stdout}\n${modeResult.stderr}`);
    assert.match(modeResult.stderr, /mode|permissions|private/iu);
    assert.doesNotMatch(await fs.readFile(publicEnv.commandLog, 'utf8').catch(() => ''),
      /docker\|build /u);
  }
});

test('pinned PostgreSQL image identity is rechecked immediately before activation', async (context) => {
  const fixture = await createFixture();
  context.after(() => removeFixture(fixture.root));
  const result = runDeploy(fixture, { FAKE_POSTGRES_DRIFT_ONCE: '1' });
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /postgres.*identity changed/iu);
  assert.equal(await fs.readFile(path.join(fixture.appDir, '.release-sha256'), 'utf8'),
    `${fixture.previous.sha}\n`);
  const log = await fs.readFile(fixture.commandLog, 'utf8');
  assert.equal((log.match(/up --pull never -d --no-build --no-deps app/gu) ?? []).length, 1,
    'only the verified predecessor recovery may run after the drift is cleared');
  assertComposeUsesCapturedPostgresAuthority(log, [
    'config', 'up',
  ]);
});

test('captured PostgreSQL ID remains Compose authority when the lookup tag is retagged',
  async (context) => {
    const fixture = await createFixture();
    context.after(() => removeFixture(fixture.root));
    const result = runDeploy(fixture, { FAKE_POSTGRES_RETAG_AFTER_CAPTURE: '1' });
    assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /postgres.*identity changed/iu);
    const log = await fs.readFile(fixture.commandLog, 'utf8');
    const composeAuthorityLines = log.split(/\r?\n/u)
      .filter((line) => line.startsWith('compose-postgres-authority|'));
    assertComposeUsesCapturedPostgresAuthority(log, ['config']);
    assert.doesNotMatch(composeAuthorityLines.join('\n'),
      new RegExp(`unset|${DRIFTED_POSTGRES_IMAGE_ID}`, 'u'));
    assert.doesNotMatch(log, /docker\|(?:build |.* up --pull never )/u,
      'retag drift must fail before build or activation');
  });

test('deploy rejects unhealthy or incorrectly mounted PostgreSQL before active-state mutation',
  async (context) => {
    for (const [label, extraEnv] of [
      ['not running', { FAKE_POSTGRES_RUNNING: 'false' }],
      ['not healthy', { FAKE_POSTGRES_HEALTH: 'starting' }],
      ['wrong volume name', { FAKE_POSTGRES_VOLUME_NAME: 'foreign-volume' }],
      ['noncanonical mount source', { FAKE_POSTGRES_VOLUME_SOURCE: 'relative-volume-source' }],
      ['read-only data mount', { FAKE_POSTGRES_MOUNT_RW: 'false' }],
      ['wrong volume object driver', { FAKE_POSTGRES_VOLUME_OBJECT_DRIVER: 'nfs' }],
      ['wrong volume object label', { FAKE_POSTGRES_VOLUME_OBJECT_LABEL: 'foreign' }],
      ['volume object does not match mount', { FAKE_POSTGRES_VOLUME_OBJECT_MOUNTPOINT: '/foreign' }],
    ]) {
      const fixture = await createFixture();
      context.after(() => removeFixture(fixture.root));
      const result = runDeploy(fixture, extraEnv);
      assert.equal(result.status, 67, `${label}: ${result.stdout}\n${result.stderr}`);
      const log = await fs.readFile(fixture.commandLog, 'utf8');
      assert.doesNotMatch(log, /docker\|build |image tag|up --pull never/iu, label);
      assert.equal(await fs.readFile(path.join(fixture.appDir, '.release-sha256'), 'utf8'),
        `${fixture.previous.sha}\n`, label);
      assert.equal(await fs.readFile(path.join(fixture.appDir, 'old-only.txt'), 'utf8'),
        'old-only\n', label);
    }
  });

test('deploy fails closed if the PostgreSQL container or volume identity changes during app activation',
  async (context) => {
    for (const [label, flag] of [
      ['container', 'FAKE_POSTGRES_DRIFT_AFTER_APP_UP'],
      ['volume', 'FAKE_POSTGRES_MOUNT_DRIFT_AFTER_APP_UP'],
      ['volume object', 'FAKE_POSTGRES_VOLUME_OBJECT_DRIFT_AFTER_APP_UP'],
    ]) {
      const fixture = await createFixture();
      context.after(() => removeFixture(fixture.root));
      const result = runDeploy(fixture, { [flag]: '1' });
      assert.equal(result.status, 70, `${label}: ${result.stdout}\n${result.stderr}`);
      assert.match(result.stderr, /PostgreSQL.*(?:container|volume).*identity changed/iu, label);
      const log = await fs.readFile(fixture.commandLog, 'utf8');
      assert.match(log, /up --pull never -d --no-build --no-deps app/u, label);
      assert.doesNotMatch(log, /down --volumes/iu,
        'external PostgreSQL drift must never authorize destructive empty-state recovery');
      assert.match(await fs.readFile(
        path.join(fixture.appDir, '.staging-recovery-required'), 'utf8'),
      /protected staging authority changed/iu, label);
      await fs.access(`${fixture.commandLog}.volume-state`);
    }
  });

test('deploy rejects an uploaded archive whose frozen bytes do not match the requested checksum', async (context) => {
  const probe = runBash(['--version']);
  if (!probe) return context.skip('Git Bash is not installed');
  const fixture = await createFixture();
  context.after(() => removeFixture(fixture.root));
  await fs.appendFile(fixture.candidate.archive, 'changed-after-checksum');

  const result = runDeploy(fixture);
  assert.equal(result.status, 65, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /checksum mismatch/u);
  assert.equal(await fs.readFile(path.join(fixture.appDir, 'shared.txt'), 'utf8'), 'old\n');
  assert.equal(await fs.readFile(path.join(fixture.appDir, '.release-sha256'), 'utf8'),
    `${fixture.previous.sha}\n`);
  await assert.rejects(fs.access(fixture.commandLog), { code: 'ENOENT' });
});

function tarArchive(entries) {
  const blocks = [];
  for (const { name, body = Buffer.alloc(0), type = '0', link = '' } of entries) {
    const header = Buffer.alloc(512);
    header.write(name, 0, 100, 'utf8');
    header.write('0000644\0', 100, 8, 'ascii');
    header.write('0000000\0', 108, 8, 'ascii');
    header.write('0000000\0', 116, 8, 'ascii');
    header.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
    header.write('00000000000\0', 136, 12, 'ascii');
    header.fill(0x20, 148, 156);
    header[156] = type.charCodeAt(0);
    if (link) header.write(link, 157, 100, 'utf8');
    header.write('ustar\0', 257, 6, 'ascii');
    header.write('00', 263, 2, 'ascii');
    const checksum = header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0');
    header.write(checksum, 148, 6, 'ascii');
    header[154] = 0;
    header[155] = 0x20;
    blocks.push(header, body, Buffer.alloc(Math.ceil(body.length / 512) * 512 - body.length));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

test('deploy rejects traversal, protected runtime paths and links before Docker', async (context) => {
  const probe = runBash(['--version']);
  if (!probe) return context.skip('Git Bash is not installed');
  for (const [label, dangerous] of [
    ['traversal', { name: '../escape', body: Buffer.from('outside\n') }],
    ['parent-segment', { name: 'x/../Dockerfile', body: Buffer.from('override\n') }],
    ['leading-dot-duplicate', { name: './Dockerfile', body: Buffer.from('override\n') }],
    ['case-collision', { name: 'dockerfile', body: Buffer.from('override\n') }],
    ['double-separator', { name: 'a//b', body: Buffer.from('blocked\n') }],
    ['dot-segment', { name: 'a/./b', body: Buffer.from('blocked\n') }],
    ['control-name', { name: 'bad\nname', body: Buffer.from('blocked\n') }],
    ['protected', { name: '.env.staging', body: Buffer.from('not-runtime\n') }],
    ['symlink', { name: 'linked', type: '2', link: '/outside' }],
    ['hardlink', { name: 'linked-copy', type: '1', link: 'Dockerfile' }],
    ['sentinel', { name: '.guarded-staging-build-context-required/file.txt', body: Buffer.from('blocked\n') }],
    ['lock', { name: '.staging-release.lock', body: Buffer.from('blocked\n') }],
    ['recovery-marker', { name: '.staging-recovery-required', body: Buffer.from('blocked\n') }],
    ['env-descendant', { name: '.env.staging/private', body: Buffer.from('blocked\n') }],
  ]) {
    const fixture = await createFixture();
    context.after(() => removeFixture(fixture.root));
    const bytes = tarArchive([
      { name: '.dockerignore', body: Buffer.from('/backups\n') },
      { name: 'Dockerfile', body: Buffer.from('FROM scratch\n') },
      { name: 'compose.staging.yml', body: Buffer.from('name: easyboost-staging\n') },
      dangerous,
    ]);
    fixture.candidate.archive = path.join(fixture.root, `${label}.tar.gz`);
    await fs.writeFile(fixture.candidate.archive, bytes);
    fixture.candidate.sha = crypto.createHash('sha256').update(bytes).digest('hex');
    const result = runDeploy(fixture);
    assert.equal(result.status, 65, `${label}: ${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /unsafe release archive|protected runtime path/u);
    assert.equal(await fs.readFile(path.join(fixture.appDir, 'shared.txt'), 'utf8'), 'old\n');
    await assert.rejects(fs.access(fixture.commandLog), { code: 'ENOENT' });
  }
});

test('resolved Compose authority rejects comment-spoofed image and context values before build', async (context) => {
  const probe = runBash(['--version']);
  if (!probe) return context.skip('Git Bash is not installed');
  const fixture = await createFixture();
  context.after(() => removeFixture(fixture.root));
  await fs.writeFile(path.join(fixture.candidate.directory, 'compose.staging.yml'), [
    '# image: easyboost-staging-app:local',
    '# pull_policy: never',
    '# context: ${EASYBOOST_STAGING_BUILD_CONTEXT:-./.guarded-staging-build-context-required}',
    'services:',
    '  app:',
    '    image: unverified.example/app:latest',
    '    pull_policy: always',
    '    build:',
    '      context: .',
    '',
  ].join('\n'));
  await repackRelease(fixture.candidate);

  const result = runDeploy(fixture, { FAKE_RESOLVED_COMPOSE_INVALID: '1' });
  assert.equal(result.status, 65, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr,
    /exact stable local image|unverified image|resolved fail-closed|local-only/u);
  assert.equal(await fs.readFile(path.join(fixture.appDir, 'shared.txt'), 'utf8'), 'old\n');
  const log = await fs.readFile(fixture.commandLog, 'utf8');
  assert.match(log, / config --format json$/mu);
  assert.doesNotMatch(log, /docker\|build /u);
});

test('resolved Compose authority rejects unapproved services and build contexts before mutation', async (context) => {
  const fixture = await createFixture();
  context.after(() => removeFixture(fixture.root));
  const result = runDeploy(fixture, { FAKE_EXTRA_SERVICE: '1' });
  assert.equal(result.status, 65, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /Compose|service|context|unsafe/iu);
  const log = await fs.readFile(fixture.commandLog, 'utf8');
  assert.doesNotMatch(log, /docker\|build /u);
  assert.equal(await fs.readFile(path.join(fixture.appDir, 'old-only.txt'), 'utf8'), 'old-only\n');
});

test('root staging deploy rejects public credential sentinels before Docker or release-state mutation',
  async (context) => {
    const stagingTemplate = await fs.readFile(path.resolve('.env.staging.example'), 'utf8');
    const productionTemplate = await fs.readFile(path.resolve('.env.example'), 'utf8');
    const credentialNames = new Set(['JWT_SECRET', 'MONITORING_TOKEN', 'POSTGRES_PASSWORD']);
    const cases = [
      ['.env.staging.example', stagingTemplate],
      ['.env.example', productionTemplate],
    ].flatMap(([file, contents]) => contents.split(/\r?\n/u).flatMap((line) => {
      const match = /^([A-Z][A-Z0-9_]*)=(.*)$/u.exec(line);
      if (!match || !credentialNames.has(match[1]) || match[2].length === 0) return [];
      return [{ file, name: match[1], value: match[2] }];
    }));
    assert.deepEqual(cases.map(({ file, name }) => `${file}:${name}`).sort(), [
      '.env.example:JWT_SECRET',
      '.env.example:POSTGRES_PASSWORD',
      '.env.staging.example:JWT_SECRET',
      '.env.staging.example:MONITORING_TOKEN',
      '.env.staging.example:POSTGRES_PASSWORD',
    ].sort(), 'public credential sentinel inventory must cover both published templates');

    for (const { file, name, value } of cases) {
      const label = `${file}:${name}`;
      const fixture = await createFixture();
      context.after(() => removeFixture(fixture.root));
      const model = approvedComposeModel(fixture.appDir);
      model.services.app.environment[name] = value;
      if (name === 'POSTGRES_PASSWORD') {
        model.services.postgres.environment.POSTGRES_PASSWORD = value;
        model.services.app.environment.DATABASE_URL =
          `postgresql://easyboost_staging:${value}@postgres:5432/easyboost_staging`;
      }

      const result = runDeploy(fixture, {
        FAKE_RESOLVED_COMPOSE_CANDIDATE_JSON: JSON.stringify(model),
      });
      assert.equal(result.status, 65, `${label}: deploy must fail closed before Docker`);
      assert.match(result.stderr, /credential|placeholder|unsafe staging Compose/iu, label);
      assert.equal(`${result.stdout}\n${result.stderr}`.includes(value), false,
        `${label}: the rejected credential value must not enter diagnostics`);
      const log = await fs.readFile(fixture.commandLog, 'utf8');
      assert.doesNotMatch(log, /docker\|(?:build |image tag |.*\bup --pull\b)/u, label);
      assert.equal(await fs.readFile(path.join(fixture.appDir, 'old-only.txt'), 'utf8'),
        'old-only\n', label);
      assert.equal(await fs.readFile(path.join(fixture.appDir, '.release-sha256'), 'utf8'),
        `${fixture.previous.sha}\n`, label);
    }

    const independent = approvedComposeModel('/opt/easyboost-staging');
    const independentPassword = 'independently-provisioned-staging-database-secret';
    independent.services.app.environment.JWT_SECRET =
      'independently-provisioned-staging-jwt-secret';
    independent.services.app.environment.MONITORING_TOKEN =
      'independently-provisioned-monitoring-token';
    independent.services.app.environment.POSTGRES_PASSWORD = independentPassword;
    independent.services.postgres.environment.POSTGRES_PASSWORD = independentPassword;
    independent.services.app.environment.DATABASE_URL =
      `postgresql://easyboost_staging:${independentPassword}@postgres:5432/easyboost_staging`;
    assert.deepEqual(verifyStagingComposeModel(
      independent,
      '/opt/easyboost-staging/.guarded-staging-build-context-required',
      POSTGRES_IMAGE_ID,
    ), { services: 2 });
  });

test('staging Compose source and resolved model require immutable PostgreSQL image authority',
  async () => {
    const composeSource = await fs.readFile(path.resolve('compose.staging.yml'), 'utf8');
    assert.match(composeSource,
      /^\s*image:\s*["']?\$\{EASYBOOST_STAGING_POSTGRES_IMAGE_ID:\?[^}]+\}["']?\s*$/mu,
      'the mutable postgres tag may only be a pre-seeded lookup, never Compose authority');
    assert.doesNotMatch(composeSource, /^\s*image:\s*postgres:17-alpine\s*$/mu);

    const expectedContext = '/opt/easyboost-staging/.guarded-staging-build-context-required';
    const pinned = approvedComposeModel('/opt/easyboost-staging');
    pinned.services.postgres.image = POSTGRES_IMAGE_ID;
    assert.deepEqual(verifyStagingComposeModel(
      pinned, expectedContext, POSTGRES_IMAGE_ID,
    ), { services: 2 });
    for (const unapproved of [
      'postgres:17-alpine', 'sha256:not-canonical', '3'.repeat(64),
      DRIFTED_POSTGRES_IMAGE_ID,
    ]) {
      const model = structuredClone(pinned);
      model.services.postgres.image = unapproved;
      assert.throws(() => verifyStagingComposeModel(
        model, expectedContext, POSTGRES_IMAGE_ID,
      ),
        /postgres image|canonical|immutable|authority/iu, unapproved);
    }
  });

test('resolved Compose authority rejects every unapproved container or host capability', () => {
  const expectedContext = '/opt/easyboost-staging/.guarded-staging-build-context-required';
  const baseline = approvedComposeModel('/opt/easyboost-staging');
  assert.deepEqual(verifyStagingComposeModel(
    structuredClone(baseline), expectedContext, POSTGRES_IMAGE_ID,
  ),
    { services: 2 });
  for (const [label, mutate] of [
    ['privileged', (model) => { model.services.app.privileged = true; }],
    ['cap_add', (model) => { model.services.app.cap_add = ['SYS_ADMIN']; }],
    ['devices', (model) => { model.services.app.devices = ['/dev/kvm:/dev/kvm']; }],
    ['host network', (model) => { model.services.app.network_mode = 'host'; }],
    ['host pid', (model) => { model.services.app.pid = 'host'; }],
    ['host ipc', (model) => { model.services.app.ipc = 'host'; }],
    ['host user namespace', (model) => { model.services.app.userns_mode = 'host'; }],
    ['Docker socket', (model) => { model.services.app.volumes = ['/var/run/docker.sock:/var/run/docker.sock']; }],
    ['service secret', (model) => { model.services.app.secrets = ['runtime-secret']; }],
    ['service config', (model) => { model.services.app.configs = ['runtime-config']; }],
    ['extra host', (model) => { model.services.app.extra_hosts = ['host.docker.internal:host-gateway']; }],
    ['entrypoint', (model) => { model.services.app.entrypoint = ['/bin/sh']; }],
    ['command', (model) => { model.services.app.command = ['sleep', 'infinity']; }],
    ['non-loopback port', (model) => { model.services.app.ports[0].host_ip = '0.0.0.0'; }],
    ['wrong loopback port', (model) => { model.services.app.ports[0].published = '3002'; }],
    ['host bind', (model) => { model.services.postgres.volumes[0] = { type: 'bind', source: '/tmp', target: '/var/lib/postgresql/data' }; }],
    ['production database URL', (model) => { model.services.app.environment.DATABASE_URL = 'postgresql://easyboost:staging-password@production-db:5432/easyboost'; }],
    ['NODE_OPTIONS injection', (model) => { model.services.app.environment.NODE_OPTIONS = '--require=/tmp/payload.js'; }],
    ['production network name', (model) => { model.networks.backend.name = 'easyboost-production_backend'; }],
    ['production volume name', (model) => { model.volumes['postgres-data'].name = 'easyboost-production_postgres-data'; }],
    ['missing healthcheck', (model) => { delete model.services.postgres.healthcheck; }],
    ['missing protected env file', (model) => { delete model.services.app.env_file; }],
    ['missing postgres volume', (model) => { delete model.services.postgres.volumes; }],
    ['top-level secret', (model) => { model.secrets = { hidden: {} }; }],
    ['top-level config', (model) => { model.configs = { hidden: {} }; }],
  ]) {
    const model = structuredClone(baseline);
    mutate(model);
    assert.throws(() => verifyStagingComposeModel(model, expectedContext, POSTGRES_IMAGE_ID),
      /unapproved|authority|loopback|named volume|staging-scoped/iu, label);
  }
});

test('documented staging env inventory resolves to the exact approved app model and port', async () => {
  const template = await fs.readFile(path.resolve('.env.staging.example'), 'utf8');
  const documentedNames = template.split(/\r?\n/u)
    .map((line) => /^([A-Z][A-Z0-9_]*)=/u.exec(line)?.[1])
    .filter(Boolean)
    .sort();
  const model = approvedComposeModel('/opt/easyboost-staging');
  const resolvedNames = Object.keys(model.services.app.environment).sort();
  assert.deepEqual(resolvedNames,
    [...new Set([...documentedNames, 'DATABASE_PROVIDER', 'DATABASE_URL', 'PORT'])].sort());
  assert.equal(model.services.app.environment.APP_PORT, '3001');
  assert.equal(model.services.app.ports[0].published, '3001');
  assert.deepEqual(verifyStagingComposeModel(
    model,
    '/opt/easyboost-staging/.guarded-staging-build-context-required',
    POSTGRES_IMAGE_ID,
  ), { services: 2 });
});

test('staging Compose validation is transaction-deadline bounded before mutation', async (context) => {
  const fixture = await createFixture();
  context.after(() => removeFixture(fixture.root));
  const started = Date.now();
  const result = runDeploy(fixture, { FAKE_BOUNDED_COMPOSE_TIMEOUT: '1' });
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.ok(Date.now() - started < 20_000,
    'bounded validation plus canonical PostgreSQL preflight must return promptly');
  assert.match(result.stderr, /Compose|timeout|deadline|invalid/iu);
  const log = await fs.readFile(fixture.commandLog, 'utf8').catch(() => '');
  assert.doesNotMatch(log, /docker\|build /u);
});

test('live-tree and recovery filesystem children are bounded while the release lock is held', async (context) => {
  const liveCopy = await createFixture();
  context.after(() => removeFixture(liveCopy.root));
  const liveResult = runDeploy(liveCopy, { FAKE_LIVE_COPY_TIMEOUT: '1' });
  assert.equal(liveResult.status, 124, `${liveResult.stdout}\n${liveResult.stderr}`);
  assert.match(liveResult.stderr, /verified prior state restored/u);
  assert.equal(await fs.readFile(path.join(liveCopy.appDir, 'old-only.txt'), 'utf8'),
    'old-only\n');
  assert.equal(await fs.readFile(path.join(liveCopy.appDir, '.release-sha256'), 'utf8'),
    `${liveCopy.previous.sha}\n`);

  const recoveryCopy = await createFixture();
  context.after(() => removeFixture(recoveryCopy.root));
  const recoveryResult = runDeploy(recoveryCopy, {
    FAKE_READINESS_FAIL: '1', FAKE_RECOVERY_COPY_TIMEOUT: '1',
  });
  assert.equal(recoveryResult.status, 70, `${recoveryResult.stdout}\n${recoveryResult.stderr}`);
  assert.match(recoveryResult.stderr, /recovery failed at: restore previous code tree/u);
  assert.match(await fs.readFile(
    path.join(recoveryCopy.appDir, '.staging-recovery-required'), 'utf8',
  ), /manual recovery required[\s\S]*recovery_step=restore previous code tree/u);
});

test('staging v4 helper digest authority rejects a mixed same-protocol bundle before state access', async (context) => {
  const fixture = await createFixture();
  context.after(() => removeFixture(fixture.root));
  const bundle = path.join(fixture.root, 'immutable-archive-v4-mixed');
  await fs.mkdir(bundle);
  for (const file of HELPER_BUNDLE_FILES) {
    const source = path.resolve('scripts', file);
    const destination = path.join(bundle, file);
    await fs.copyFile(source, destination);
  }
  await fs.appendFile(path.join(bundle, 'staging-release-common.sh'), '\n# mixed-generation probe\n');
  const arguments_ = [
    posixPath(path.join(bundle, 'staging-deploy.sh')),
    posixPath(fixture.candidate.archive), fixture.candidate.sha, 'immutable-archive-v4',
    sourceBundleDigest,
  ];
  const environment = {
    ...process.env,
    BASH_ENV: posixPath(fixture.bashEnv),
    COMMAND_LOG: posixPath(fixture.commandLog),
    EASYBOOST_STAGING_DEADLINE_TEST_CONTROL_ROOT:
      path.join(fixture.root, 'deadline-controls'),
    EASYBOOST_STAGING_SESSION_TEST_CONTROL_ROOT:
      path.join(fixture.root, 'session-controls'),
    STAGING_APP_DIR: posixPath(fixture.appDir),
  };
  const directResult = runBash(arguments_, { env: environment });
  assert.equal(directResult.status, 125, `${directResult.stdout}\n${directResult.stderr}`);
  assert.match(directResult.stderr, /deadline authority is unavailable/iu);

  const configuration = Buffer.from(JSON.stringify({
    arguments: arguments_.slice(1),
    bash: gitBash,
    controlKey: `staging-deadline-test:mixed-helper:${arguments_[0]}:${JSON.stringify(arguments_.slice(1))}`,
    recoverySeconds: STAGING_TEST_RECOVERY_SECONDS,
    script: arguments_[0],
    transactionSeconds: STAGING_TEST_TRANSACTION_SECONDS,
  })).toString('base64url');
  const result = spawnSync(process.execPath, [deadlineHarness, configuration], {
    encoding: 'utf8', env: environment,
  });
  assert.equal(result.status, 69, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /bundle digest mismatch|protocol mismatch/iu);
  await assert.rejects(fs.access(fixture.commandLog), { code: 'ENOENT' });
  assert.equal(await fs.readFile(path.join(fixture.appDir, 'old-only.txt'), 'utf8'), 'old-only\n');
});

test('staging Compose, workflow and operator docs expose only the immutable archive build path', async () => {
  const projectDirectory = path.resolve('.');
  const [compose, dockerignore, deploySource, rollbackSource, restartSource, commonSource, archiveSource,
    installerSource, bootstrapSource, bundleSource, workflow, readme, telegram, checklist,
    pwaReleaseGuide, knownLimitations] = await Promise.all([
    fs.readFile(path.join(projectDirectory, 'compose.staging.yml'), 'utf8'),
    fs.readFile(path.join(projectDirectory, '.dockerignore'), 'utf8'),
    fs.readFile(path.join(projectDirectory, 'scripts', 'staging-deploy.sh'), 'utf8'),
    fs.readFile(path.join(projectDirectory, 'scripts', 'staging-rollback.sh'), 'utf8'),
    fs.readFile(path.join(projectDirectory, 'scripts', 'staging-restart-app.sh'), 'utf8'),
    fs.readFile(path.join(projectDirectory, 'scripts', 'staging-release-common.sh'), 'utf8'),
    fs.readFile(path.join(projectDirectory, 'scripts', 'staging-release-archive.js'), 'utf8'),
    fs.readFile(path.join(projectDirectory, 'scripts', 'install-staging-release-helpers.sh'), 'utf8'),
    fs.readFile(path.join(projectDirectory, 'scripts', 'bootstrap-staging-release-host.sh'), 'utf8'),
    fs.readFile(path.join(projectDirectory, 'scripts', 'staging-helper-bundle.js'), 'utf8'),
    fs.readFile(path.join(projectDirectory, '.github', 'workflows', 'deploy-staging.yml'), 'utf8'),
    fs.readFile(path.join(projectDirectory, 'README_DEPLOY.md'), 'utf8'),
    fs.readFile(path.join(projectDirectory, 'docs', 'TELEGRAM_ADMIN.md'), 'utf8'),
    fs.readFile(path.join(projectDirectory, 'docs', 'EXPERIMENTAL_RELEASE_OPERATIONS_CHECKLIST.md'), 'utf8'),
    fs.readFile(path.join(projectDirectory, 'docs', 'AISY_PWA_RELEASE.md'), 'utf8'),
    fs.readFile(path.join(projectDirectory, 'docs', 'KNOWN_LIMITATIONS.md'), 'utf8'),
  ]);
  assert.match(compose, /image: easyboost-staging-app:local/u);
  assert.match(compose, /pull_policy: never/u);
  assert.match(compose,
    /^\s*context: \.\/\.guarded-staging-build-context-required\s*$/mu);
  assert.doesNotMatch(compose, /EASYBOOST_STAGING_BUILD_CONTEXT/u,
    'no caller environment may reopen the raw staging build context');
  assert.doesNotMatch(compose, /^\s*build:\s*\.\s*$/mu);
  await assert.rejects(fs.access(path.join(projectDirectory, '.guarded-staging-build-context-required')));
  for (const excluded of [
    'backups', 'rollbacks', '.release-sha256', '.staging-release.lock',
    '.staging-recovery-required', '.release-archive*',
    '.guarded-staging-build-context-required',
  ]) assert.match(dockerignore, new RegExp(`^${excluded.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}$`, 'mu'));

  assert.match(workflow,
    /staging-release-archive\.js create-git \. easyboost-staging-release\.tar\.gz[\s\S]*staging-release-archive\.js inspect easyboost-staging-release\.tar\.gz/u);
  assert.match(workflow,
    /staging-helper-bundle\.js digest scripts[\s\S]*easyboost-staging-deploy \/tmp\/easyboost-staging-release\.tar\.gz '\$release_sha' immutable-archive-v4 '\$helper_sha'/u);
  assert.doesNotMatch(deploySource, /up -d --build|up --build/u);
  assert.match(deploySource, /unset EASYBOOST_STAGING_BUILD_CONTEXT/u);
  assert.match(deploySource, /up --pull never -d --no-build --no-deps app/u);
  assert.doesNotMatch(rollbackSource, /code-before-|up -d --build|up --build/u);
  assert.match(rollbackSource, /unset EASYBOOST_STAGING_BUILD_CONTEXT/u);
  assert.match(rollbackSource, /Usage: \$0 EXACT_RELEASE_SHA256/u);
  assert.match(rollbackSource, /up --pull never -d --no-build --no-deps app/u);
  assert.match(restartSource, /acquire_release_lock[\s\S]*acquire_host_operation_lock staging-release/u);
  assert.match(restartSource,
    /up --pull never -d --no-build --no-deps app[\s\S]*verify_running_image[\s\S]*wait_for_readiness/u);
  assert.ok(
    deploySource.indexOf('docker build --file Dockerfile')
      < deploySource.indexOf('docker image tag "$release_image" "$STABLE_IMAGE"'),
    'the release image must be built before stable-tag promotion',
  );
  assert.ok(
    commonSource.indexOf('"$candidate_archive_tmp" "$candidate_archive_final"')
      < commonSource.indexOf('"$candidate_sidecar_tmp" "$candidate_sidecar_final"'),
    'the checksum sidecar must be published last',
  );
  assert.match(commonSource, /MAX_RELEASE_PAIRS=4[\s\S]*MAX_RELEASE_STORE_BYTES=/u);
  assert.match(commonSource, /runtime_authority_tool[\s\S]*read-sha/u);
  assert.match(archiveSource, /maxCompressedBytes: 256 \* 1024 \* 1024/u);
  assert.match(installerSource,
    /PROTOCOL='immutable-archive-v4'[\s\S]*staging-helper-bundle\.js" install/u);
  assert.match(bundleSource,
    /generations[\s\S]*staging-release-entry\.sh[\s\S]*current[\s\S]*bundleDigest/u);
  assert.match(bootstrapSource,
    /install -d -o "\$owner_uid" -g "\$owner_gid" -m 700[\s\S]*\.env\.staging[\s\S]*-m 600[\s\S]*install-staging-release-helpers\.sh/u);

  const rawBuild = /docker\s+compose[^\r\n]*(?:compose\.staging\.yml|staging)[^\r\n]*(?:\bbuild\b|--build)/iu;
  for (const [name, document] of [
    ['README_DEPLOY.md', readme],
    ['docs/TELEGRAM_ADMIN.md', telegram],
    ['docs/EXPERIMENTAL_RELEASE_OPERATIONS_CHECKLIST.md', checklist],
  ]) assert.equal(rawBuild.test(document), false, `${name} exposes a raw staging build`);
  assert.match(readme,
    /easyboost-staging-deploy \\\r?\n\s*easyboost-staging-release\.tar\.gz <sha256> immutable-archive-v4 "\$helper_sha"/u);
  assert.match(readme,
    /easyboost-staging-rollback \\\r?\n\s*<full-release-sha256> immutable-archive-v4 \\\r?\n\s*"\$\(sudo cat [^)]+\/current\)"/u);
  assert.match(readme, /bootstrap-staging-release-host\.sh/u);
  assert.match(readme, /install-staging-release-helpers\.sh/u);
  for (const [name, document] of [
    ['README_DEPLOY.md', readme],
    ['docs/KNOWN_LIMITATIONS.md', knownLimitations],
  ]) {
    assert.match(document,
      /easyboost-staging-cutover \\\r?\n\s*"\$bridge_archive" \\\r?\n\s*"\$bridge_sha" \\\r?\n\s*"\$legacy_marker_sha" \\\r?\n\s*"\$legacy_compose_sha" \\\r?\n\s*700 644 664 \\\r?\n\s*immutable-archive-v4 \\\r?\n\s*"\$helper_sha"/u,
      `${name} must document the exact nine-argument legacy cutover`);
    assert.match(document,
      /easyboost-staging-recover bridge \\\r?\n\s*deploy \\\r?\n\s*"\$archive" \\\r?\n\s*"\$archive_sha" \\\r?\n\s*immutable-archive-v4 \\\r?\n\s*"\$old_bundle_sha" \\\r?\n\s*"\$current_bundle_sha" \\\r?\n\s*--recovery-authority \\\r?\n\s*"\$authority_json"/u,
      `${name} must document the exact cross-generation recovery bridge`);
    assert.match(document, /manual seeding|ручное создание/iu,
      `${name} must explicitly forbid manual active-release seeding`);
    assert.match(document,
      /normal deploy remains forbidden|обычный deploy нельзя запускать/iu,
      `${name} must block normal deploy until cutover proof succeeds`);
    const installerIndex = document.indexOf('install-staging-release-helpers.sh');
    const recoveryIndex = document.indexOf('easyboost-staging-recover bridge');
    const cutoverIndex = document.indexOf('easyboost-staging-cutover');
    assert.ok(installerIndex >= 0 && installerIndex < recoveryIndex
      && recoveryIndex < cutoverIndex,
    `${name} must order helper install, old transaction recovery, then cutover`);
  }
  assert.match(readme, /никогда автоматически не[\s\S]{0,80}down-migrate PostgreSQL schema\/data/iu);
  assert.match(checklist,
    /easyboost-staging-rollback \\\r?\n\s*<full-release-sha256> immutable-archive-v4 \\\r?\n\s*"\$\(sudo cat [^)]+\/current\)"/u);
  assert.match(checklist, /immutable-archive-v4/u);
  assert.match(checklist,
    /Root-owned deploy helper[^\n]*versioned четырёхаргументный protocol\s*\n`RELEASE_ARCHIVE EXPECTED_SHA256 immutable-archive-v4 BUNDLE_SHA256`/u,
    'the executable operator checklist must describe all four deploy-helper arguments');
  assert.match(checklist, /PostgreSQL schema\/data[^\n]*never|PostgreSQL schema\/data никогда/iu);
  const stagingVerification = checklist.slice(
    checklist.indexOf('## 2. Явный push/staging deploy gate'),
    checklist.indexOf('## 3.', checklist.indexOf('## 2. Явный push/staging deploy gate')),
  );
  const stagingPostgresTokens = [
    "--filter 'label=com.docker.compose.project=easyboost-staging'",
    "--filter 'label=com.docker.compose.service=postgres'",
    "--filter 'label=com.docker.compose.oneoff=False'",
    '[[ "${#staging_postgres_container_ids[@]}" -eq 1 ]]',
    'staging_postgres_identity="$(docker inspect --format',
    '[[ "$staging_postgres_container_id" =~ ^[0-9a-f]{64}$ ]]',
    '[[ "$staging_postgres_inspected_id" = "$staging_postgres_container_id" ]]',
    '[[ "$staging_postgres_project" = "easyboost-staging" ]]',
    '[[ "$staging_postgres_service" = "postgres" ]]',
    '[[ "$staging_postgres_oneoff" = "False" ]]',
    '[[ "$staging_postgres_running" = "true" ]]',
    '[[ "$EASYBOOST_STAGING_POSTGRES_IMAGE_ID" =~ ^sha256:[0-9a-f]{64}$ ]]',
    'export EASYBOOST_STAGING_POSTGRES_IMAGE_ID',
    'docker compose -f compose.staging.yml --env-file .env.staging ps',
  ];
  let stagingPostgresCursor = -1;
  for (const token of stagingPostgresTokens) {
    const next = stagingVerification.indexOf(token, stagingPostgresCursor + 1);
    assert.ok(next > stagingPostgresCursor,
      `post-deploy staging verification is missing exact PostgreSQL authority token: ${token}`);
    stagingPostgresCursor = next;
  }
  for (const [name, document] of [
    ['README_DEPLOY.md', readme],
    ['docs/AISY_PWA_RELEASE.md', pwaReleaseGuide],
    ['docs/KNOWN_LIMITATIONS.md', knownLimitations],
  ]) {
    assert.match(document,
      /identity-bound\s+transaction-owned\s+temporary\/final\s+publication\s+cleanup\s+requires\s+exact\s+release-store\s+revalidation/iu,
      `${name} must define exact transaction-owned publication cleanup and store proof`);
    assert.match(document,
      /success\s+is\s+emitted\s+only\s+after\s+the\s+reservation\s+is\s+removed\s+and\s+the\s+whole\s+release\s+store\s+is\s+revalidated/iu,
      `${name} must defer success until reservation-free whole-store verification`);
    assert.match(document,
      /verified\s+prior\s+state\s+restored\s+is\s+printed\s+only\s+after\s+exact\s+recovery-state\s+verification/iu,
      `${name} must forbid an unverified recovery success claim`);
    assert.match(document,
      /only\s+a\s+successful\s+empty\s+exact-reference\s+image\s+probe\s+proves\s+absence/iu,
      `${name} must define the sole authoritative temporary-image absence result`);
    assert.match(document,
      /timeout[\s\S]{0,120}daemon[\s\S]{0,120}error[\s\S]{0,120}indeterminate[\s\S]{0,120}fail-closed/iu,
      `${name} must fail closed for every indeterminate Docker image response`);
  }
  assert.doesNotMatch(telegram, /TELEGRAM_ADMIN_ID/u);
  assert.match(telegram, /ADMIN_TELEGRAM_ID/u);
  assert.doesNotMatch(telegram, /docker compose/u,
    'Telegram environment restart must not bypass the root-owned release helper');
  assert.match(telegram,
    /easyboost-staging-restart "\$\(sudo cat \/usr\/local\/lib\/easyboost-staging-release\/current\)"/u);
  assert.doesNotMatch(telegram, /signed archive workflow/iu);
});
