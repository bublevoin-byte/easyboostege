import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { HELPER_BUNDLE_FILES } from '../scripts/staging-helper-bundle.js';
import { createReleaseArchive } from '../scripts/staging-release-archive.js';

const installerScript = path.resolve('scripts/install-staging-release-helpers.sh');
const previousImageId = `sha256:${'1'.repeat(64)}`;
const candidateImageId = `sha256:${'2'.repeat(64)}`;
const postgresImageId = `sha256:${'3'.repeat(64)}`;
const postgresContainerId = 'b'.repeat(64);
const postgresVolumeSource = '/var/lib/docker/volumes/easyboost-staging_postgres-data/_data';
const lockFixturePhases = new Set([
  'child-started', 'config-json-enter', 'config-json-complete',
  'config-quiet-enter', 'config-quiet-complete',
  'build-enter', 'build-input-drained', 'build-barrier', 'build-complete',
  'up-enter', 'up-state-written', 'up-barrier', 'up-complete',
]);
const postgresContainerInspection = {
  Id: postgresContainerId,
  Image: postgresImageId,
  Config: {
    Labels: {
      'com.docker.compose.project': 'easyboost-staging',
      'com.docker.compose.service': 'postgres',
      'com.docker.compose.oneoff': 'False',
    },
  },
  State: { Running: true, Health: { Status: 'healthy' } },
  Mounts: [{
    Type: 'volume',
    Name: 'easyboost-staging_postgres-data',
    Source: postgresVolumeSource,
    Destination: '/var/lib/postgresql/data',
    Driver: 'local',
    Mode: 'z',
    Propagation: '',
    RW: true,
  }],
};
const postgresVolumeInspection = {
  Name: 'easyboost-staging_postgres-data',
  Driver: 'local',
  Scope: 'local',
  Mountpoint: postgresVolumeSource,
  Labels: {
    'com.docker.compose.project': 'easyboost-staging',
    'com.docker.compose.volume': 'postgres-data',
  },
  Options: null,
};

function lockFixtureDockerScript(current, candidate) {
  return `#!/bin/bash
set -eu
record_phase() {
  case "\${BLOCK_AT:-}" in
    build|tree|recovery) { printf '%s\\n' "$1" > "$BARRIER_DIR/phase-$BLOCK_AT"; } 2>/dev/null || : ;;
  esac
}
if [ "\${1:-}" = ps ] \\
  && [[ " $* " == *"label=com.docker.compose.project=easyboost-staging"* ]] \\
  && [[ " $* " == *"label=com.docker.compose.service=postgres"* ]] \\
  && [[ " $* " == *"label=com.docker.compose.oneoff=False"* ]]; then
  echo ${postgresContainerId}
  exit 0
fi
if [ "\${1:-}" = volume ] && [ "\${2:-}" = inspect ]; then
  [ "\${@: -1}" = easyboost-staging_postgres-data ] || exit 1
  printf '%s\\n' '${JSON.stringify(postgresVolumeInspection)}'
  exit 0
fi
if [ "\${1:-}" = build ]; then
  record_phase build-enter
  cat >/dev/null
  record_phase build-input-drained
  if [ "\${BLOCK_AT:-}" = build ]; then
    echo $$ > "$BARRIER_DIR/build-pid"
    [ ! -e /proc/$$/fd/9 ] || touch "$BARRIER_DIR/inherited-lock-fd"
    trap '' TERM
    record_phase build-barrier
    touch "$BARRIER_DIR/build"
    while [ ! -e "$BARRIER_DIR/release-build" ]; do /bin/sleep 0.02; done
  fi
  case " $* " in
    *" --tag easyboost-staging-app:release-${current.sha} "*) echo ${previousImageId} > "$RELEASE_STATE" ;;
    *" --tag easyboost-staging-app:release-${candidate.sha} "*) echo ${candidateImageId} > "$RELEASE_STATE" ;;
    *) exit 1 ;;
  esac
  record_phase build-complete
  exit 0
fi
if [ "\${1:-}" = image ] && [ "\${2:-}" = ls ]; then
  [ "$#" -eq 6 ] && [ "$3" = --quiet ] && [ "$4" = --no-trunc ] && [ "$5" = --filter ] || exit 1
  case "$6" in
    reference=easyboost-staging-app:release-${current.sha}) expected=${previousImageId} ;;
    reference=easyboost-staging-app:release-${candidate.sha}) expected=${candidateImageId} ;;
    reference=easyboost-staging-app:local) cat "$IMAGE_STATE"; exit 0 ;;
    *) exit 1 ;;
  esac
  # The fixture holds one temporary release at a time; its ID identifies the exact tag.
  [ -f "$RELEASE_STATE" ] || exit 0
  observed="$(cat "$RELEASE_STATE")"
  case "$observed" in ${previousImageId}|${candidateImageId}) : ;; *) exit 1 ;; esac
  if [ "$observed" = "$expected" ]; then printf '%s\\n' "$observed"; fi
  exit 0
fi
if [ "\${1:-}" = image ] && [ "\${2:-}" = inspect ]; then
  target="\${@: -1}"
  case "$target" in easyboost-staging-app:release-*) [ -f "$RELEASE_STATE" ] || exit 1; cat "$RELEASE_STATE" ;; easyboost-staging-app:local) cat "$IMAGE_STATE" ;; postgres:17-alpine) echo ${postgresImageId} ;; *) exit 1 ;; esac
  exit 0
fi
if [ "\${1:-}" = image ] && [ "\${2:-}" = tag ]; then
  if [[ "$3" == sha256:* ]]; then printf '%s\n' "$3" > "$IMAGE_STATE"; else cat "$RELEASE_STATE" > "$IMAGE_STATE"; fi
  exit 0
fi
if [ "\${1:-}" = image ] && [ "\${2:-}" = rm ]; then case "\${@: -1}" in easyboost-staging-app:release-*) rm -f "$RELEASE_STATE" ;; esac; exit 0; fi
if [ "\${1:-}" = inspect ]; then
  if [ "\${@: -1}" = ${postgresContainerId} ]; then
    if [[ " $* " == *" --format {{json .}} "* ]]; then
      printf '%s\\n' '${JSON.stringify(postgresContainerInspection)}'
    else
      echo ${postgresImageId}
    fi
  else
    cat "$CONTAINER_STATE"
  fi
  exit 0
fi
if [ "\${1:-}" = compose ]; then
  printf '%s\n' "$*" >> "$BARRIER_DIR/compose-invocations"
  case " $* " in
    *" config --format json "*) record_phase config-json-enter; printf '%s' "$RESOLVED_COMPOSE_JSON"; record_phase config-json-complete ;;
    *" config --quiet "*) record_phase config-quiet-enter; :; record_phase config-quiet-complete ;;
    *" ps -q app "*) echo fake-container ;;
    *" ps --status running postgres --quiet "*) : ;;
    *" exec -T postgres pg_dump -U easyboost_staging -d easyboost_staging --format=custom --no-owner --no-privileges ")
      # Synthetic stream for the operator backup gate, not a restorable PostgreSQL archive.
      printf '%s\\n' 'synthetic-lock-fixture-backup'
      ;;
    *" up --pull never -d --no-build --no-deps app "*)
      record_phase up-enter
      count=0; [ ! -f "$BARRIER_DIR/up-count" ] || count="$(cat "$BARRIER_DIR/up-count")"; count=$((count+1)); echo "$count" > "$BARRIER_DIR/up-count"
      cat "$IMAGE_STATE" > "$CONTAINER_STATE"
      record_phase up-state-written
      if { [ "\${BLOCK_AT:-}" = tree ] && [ "$count" -eq 1 ]; } || { [ "\${BLOCK_AT:-}" = recovery ] && [ "$count" -eq 2 ]; }; then
        record_phase up-barrier
        touch "$BARRIER_DIR/$BLOCK_AT"; while [ ! -e "$BARRIER_DIR/release-$BLOCK_AT" ]; do /bin/sleep 0.02; done
      fi
      record_phase up-complete
      ;;
  esac
  exit 0
fi
exit 0
`;
}

function approvedComposeModel(appDirectory) {
  return {
    name: 'easyboost-staging',
    networks: { backend: { name: 'easyboost-staging_backend' } },
    services: {
      app: {
        build: {
          context: `${appDirectory}/.guarded-staging-build-context-required`,
          dockerfile: `${appDirectory}/Dockerfile`,
        },
        depends_on: {
          postgres: { condition: 'service_healthy', required: true, restart: false },
        },
        env_file: [{ path: `${appDirectory}/.env.staging`, required: true }],
        environment: {
          ADAPTIVE_LEARNING_ENABLED: 'false', ADMIN_TELEGRAM_ID: '',
          AI_DAILY_REQUEST_BUDGET: '1000', AI_REQUESTS_PER_HOUR: '100',
          APP_PORT: '3001', APP_URL: 'https://staging.useboost.ru',
          AZURE_SPEECH_KEY: '', AZURE_SPEECH_REGION: '',
          DATABASE_PROVIDER: 'postgres',
          DATABASE_URL: 'postgresql://easyboost_staging:staging-password@postgres:5432/easyboost_staging',
          GROQ_API_KEY: '', GROQ_ENABLED: 'false', GROQ_MODEL: '',
          JWT_SECRET: 'j'.repeat(32), MONITORING_TOKEN: '', NODE_ENV: 'production',
          PORT: '3000', POSTGRES_PASSWORD: 'staging-password',
          SPEAKING_PRONUNCIATION_ENABLED: 'false',
          SPEAKING_PRONUNCIATION_MAX_AUDIO_BYTES: '5242880',
          SPEAKING_PRONUNCIATION_MAX_AUDIO_SECONDS: '90',
          SPEAKING_PRONUNCIATION_TIMEOUT_MS: '45000',
          STT_REQUESTS_PER_HOUR: '100', TELEGRAM_BOT_TOKEN: '',
          TTS_REQUESTS_PER_HOUR: '100', WRITING_REQUESTS_PER_HOUR: '100',
          XAI_API_KEY: '', XAI_ENABLED: 'false', XAI_MODEL: '',
        },
        image: 'easyboost-staging-app:local', networks: { backend: null },
        ports: [{ host_ip: '127.0.0.1', mode: 'ingress', protocol: 'tcp', published: '3001', target: 3000 }],
        pull_policy: 'never', restart: 'unless-stopped',
      },
      postgres: {
        environment: {
          POSTGRES_DB: 'easyboost_staging', POSTGRES_PASSWORD: 'staging-password',
          POSTGRES_USER: 'easyboost_staging',
        },
        healthcheck: {
          interval: '10s', retries: 10,
          test: ['CMD-SHELL', 'pg_isready -U easyboost_staging -d easyboost_staging'],
          timeout: '5s',
        },
        image: postgresImageId, networks: { backend: null }, pull_policy: 'never',
        restart: 'unless-stopped',
        volumes: [{ source: 'postgres-data', target: '/var/lib/postgresql/data', type: 'volume' }],
      },
    },
    volumes: { 'postgres-data': { name: 'easyboost-staging_postgres-data' } },
  };
}

async function release(root, name, copy) {
  const source = path.join(root, `${name}-source`);
  await fs.mkdir(source, { recursive: true });
  const files = ['.dockerignore', 'Dockerfile', 'compose.staging.yml', `${name}.txt`];
  await Promise.all([
    fs.writeFile(path.join(source, '.dockerignore'), '/backups\n/rollbacks\n'),
    fs.writeFile(path.join(source, 'Dockerfile'), 'FROM scratch\n'),
    fs.writeFile(path.join(source, 'compose.staging.yml'), [
      'services:', '  app:', '    image: easyboost-staging-app:local',
      '    pull_policy: never', '    build:',
      '      context: ./.guarded-staging-build-context-required', '',
    ].join('\n')),
    fs.writeFile(path.join(source, `${name}.txt`), `${copy}\n`),
  ]);
  const archive = path.join(root, `${name}.tar.gz`);
  const created = await createReleaseArchive({ sourceDirectory: source, files: files.sort(), outputPath: archive });
  return { archive, sha: created.sha256, source };
}

async function waitForFile(file, handle, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { await fs.access(file); return; } catch {}
    if (!childIsLive(handle.child)) {
      const result = await handle.done;
      assert.fail([
        `Process exited before ${path.basename(file)} barrier`,
        `status=${result.status} signal=${result.signal ?? 'none'}`,
        await lockLifecycleEvidence(file, handle),
      ].join('\n'));
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error([
    `Timed out waiting for ${file}`,
    await lockLifecycleEvidence(file, handle),
  ].join('\n'));
}

async function lockLifecycleEvidence(file, handle) {
  // Diagnostic reads are bounded, and their failure must never replace the barrier failure.
  async function readValue(name, accepts) {
    let opened;
    try {
      opened = await fs.open(path.join(path.dirname(file), name), 'r');
      const bytes = Buffer.alloc(128);
      const { bytesRead } = await opened.read(bytes, 0, bytes.length, 0);
      const value = bytes.subarray(0, bytesRead).toString('utf8').trim();
      return bytesRead < bytes.length && accepts(value) ? value : 'unavailable';
    } catch (error) {
      return error.code === 'ENOENT' ? 'missing' : 'unavailable';
    } finally {
      await opened?.close().catch(() => {});
    }
  }
  function outputTail(value) {
    let tail = value.slice(-1_024);
    while (Buffer.byteLength(tail) > 1_024) tail = tail.slice(1);
    return tail;
  }
  const [lastPhase, upCount, tree] = await Promise.all([
    handle.phaseFile ? readValue(path.basename(handle.phaseFile), (value) => lockFixturePhases.has(value)) : 'unavailable',
    readValue('up-count', (value) => /^\d{1,6}$/u.test(value)),
    fs.access(path.join(path.dirname(file), 'tree')).then(() => 'present',
      (error) => error.code === 'ENOENT' ? 'absent' : 'unavailable'),
  ]);
  return `[DEBUG-ci123-lock] ${JSON.stringify({
    elapsedMs: Math.round(performance.now() - handle.startedAt), lastPhase, upCount, tree,
    stdout: outputTail(handle.output.stdout), stderr: outputTail(handle.output.stderr),
  })}`;
}

async function waitForProcessExit(pid, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code === 'ESRCH') return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`supervised staging descendant ${pid} remained alive`);
}

function start(command, args, environment) {
  let phaseFile = null;
  if (environment.BARRIER_DIR && ['build', 'tree', 'recovery'].includes(environment.BLOCK_AT)) {
    try {
      const candidate = path.join(environment.BARRIER_DIR, `phase-${environment.BLOCK_AT}`);
      writeFileSync(candidate, 'child-started\n');
      phaseFile = candidate;
    } catch { /* Unavailable diagnostics must not prevent starting the original scenario. */ }
  }
  const startedAt = performance.now();
  const child = spawn(command, args, { env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
  const output = { stderr: '', stdout: '' };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { output.stdout += chunk; });
  child.stderr.on('data', (chunk) => { output.stderr += chunk; });
  const done = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (status, signal) => resolve({ signal, status, ...output }));
  });
  return { child, done, output, phaseFile, startedAt };
}

function childIsLive(child) {
  return child.exitCode === null && child.signalCode === null;
}

async function boundedOutcome(promise, milliseconds) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ type: 'timeout' }), milliseconds);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function signalStartedChild(child, signal, label) {
  try {
    child.kill(signal);
  } catch (error) {
    if (error.code !== 'ESRCH') {
      throw new Error(`${label} could not receive ${signal}`, { cause: error });
    }
  }
}

async function waitForChildState(child, milliseconds, label) {
  const deadline = Date.now() + milliseconds;
  while (childIsLive(child) && Date.now() < deadline) {
    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });
  }
  if (childIsLive(child)) throw new Error(`${label} remained live after SIGKILL`);
}

async function settleStartedChild(handle, label, { exitMs = 5_000, graceMs = 750 } = {}) {
  if (!handle) return;
  const tracked = Promise.resolve(handle.done).then(
    (value) => ({ type: 'settled', value }),
    (error) => ({ error, type: 'rejected' }),
  );
  if (childIsLive(handle.child)) {
    signalStartedChild(handle.child, 'SIGTERM', label);
    const grace = await boundedOutcome(tracked, graceMs);
    if (grace.type === 'rejected') {
      if (childIsLive(handle.child)) {
        signalStartedChild(handle.child, 'SIGKILL', label);
        await waitForChildState(handle.child, exitMs, label);
      }
      throw grace.error;
    }
    if (grace.type === 'settled') return;
    if (childIsLive(handle.child)) signalStartedChild(handle.child, 'SIGKILL', label);
  }
  const result = await boundedOutcome(tracked, exitMs);
  if (result.type === 'timeout') {
    if (childIsLive(handle.child)) signalStartedChild(handle.child, 'SIGKILL', label);
    await waitForChildState(handle.child, exitMs, label);
    throw new Error(`${label} did not settle within ${exitMs}ms`);
  }
  if (result.type === 'rejected') throw result.error;
  if (childIsLive(handle.child)) {
    signalStartedChild(handle.child, 'SIGKILL', label);
    await waitForChildState(handle.child, exitMs, label);
  }
}

async function settleCleanupOperations(operations) {
  const settlements = await Promise.allSettled(operations.map(({ operation }) => operation()));
  return settlements.flatMap((settlement, index) => settlement.status === 'rejected'
    ? [new Error(`${operations[index].label} cleanup failed`, { cause: settlement.reason })]
    : []);
}

async function makeDirectoriesOwnerWritable(directory) {
  const identity = await fs.lstat(directory).catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (!identity?.isDirectory() || identity.isSymbolicLink()) return;
  await fs.chmod(directory, 0o700);
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      await makeDirectoriesOwnerWritable(path.join(directory, entry.name));
    }
  }
}

async function prepareHermeticHelperInstaller(root, trustedCommandDirectory) {
  const source = path.join(root, 'helper-installer-source');
  const nodeDirectory = path.join(root, 'node-authority');
  const nodeExecutable = path.join(nodeDirectory, 'node');
  await Promise.all([
    fs.mkdir(source),
    fs.mkdir(nodeDirectory, { mode: 0o755 }),
  ]);
  await Promise.all(HELPER_BUNDLE_FILES.map((name) => (
    fs.copyFile(path.resolve('scripts', name), path.join(source, name))
  )));
  const helperBundle = path.join(source, 'staging-helper-bundle.js');
  const trustedSystemPath = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
  const productionDeclaration = `const TRUSTED_SHELL_PATH = '${trustedSystemPath}';`;
  const helperBundleSource = await fs.readFile(helperBundle, 'utf8');
  const fixtureBundleSource = helperBundleSource.replace(
    productionDeclaration,
    `const TRUSTED_SHELL_PATH = ${JSON.stringify(`${trustedCommandDirectory}:${trustedSystemPath}`)};`,
  );
  assert.notEqual(fixtureBundleSource, helperBundleSource,
    'fixture helper bundle must bind its hermetic command directory');
  await fs.writeFile(helperBundle, fixtureBundleSource);
  await fs.copyFile(process.execPath, nodeExecutable);
  await fs.chmod(nodeDirectory, 0o755);
  await fs.chmod(nodeExecutable, 0o755);
  const installer = path.join(source, path.basename(installerScript));
  const installerSource = (await fs.readFile(installerScript, 'utf8')).replace(
    "PATH='/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'",
    'PATH="${EASYBOOST_TEST_INSTALLER_NODE_DIRECTORY}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"',
  );
  await fs.writeFile(installer, installerSource);
  return { installer, nodeDirectory };
}

function combineCleanupFailures(primaryFailure, cleanupErrors) {
  if (primaryFailure && cleanupErrors.length > 0) {
    return new AggregateError([primaryFailure, ...cleanupErrors],
      'lock integration scenario and cleanup both failed');
  }
  if (primaryFailure) return primaryFailure;
  if (cleanupErrors.length > 0) {
    return new AggregateError(cleanupErrors, 'lock integration cleanup failed');
  }
  return null;
}

async function cleanupLockIntegrationResources({ barriers, handles, root }) {
  const errors = [];
  if (barriers) {
    errors.push(...await settleCleanupOperations([
      { label: 'release-build barrier', operation: () => fs.writeFile(path.join(barriers, 'release-build'), 'cleanup\n') },
      { label: 'release-tree barrier', operation: () => fs.writeFile(path.join(barriers, 'release-tree'), 'cleanup\n') },
      { label: 'release-recovery barrier', operation: () => fs.writeFile(path.join(barriers, 'release-recovery'), 'cleanup\n') },
    ]));
  }
  errors.push(...await settleCleanupOperations([
    { label: 'building child', operation: () => settleStartedChild(handles.building, 'building child') },
    { label: 'activating child', operation: () => settleStartedChild(handles.activating, 'activating child') },
    { label: 'recovering child', operation: () => settleStartedChild(handles.recovering, 'recovering child') },
    { label: 'killed child', operation: () => settleStartedChild(handles.killed, 'killed child') },
  ]));
  if (root) {
    errors.push(...await settleCleanupOperations([
      {
        label: 'fixture root',
        operation: async () => {
          if (process.platform !== 'win32') await makeDirectoriesOwnerWritable(root);
          await fs.rm(root, { recursive: true, force: true });
        },
      },
    ]));
  }
  return errors;
}

test('lock integration cleanup settles every resource and bounds TERM-to-KILL escalation', async () => {
  const calls = [];
  const cleanupErrors = await settleCleanupOperations([
    { label: 'first', operation: async () => { calls.push('first'); throw new Error('injected'); } },
    { label: 'second', operation: async () => { calls.push('second'); } },
    { label: 'third', operation: async () => { calls.push('third'); } },
    { label: 'fourth', operation: async () => { calls.push('fourth'); } },
  ]);
  assert.deepEqual(calls.sort(), ['first', 'fourth', 'second', 'third']);
  assert.equal(cleanupErrors.length, 1);
  assert.match(cleanupErrors[0].message, /first/u);

  const signals = [];
  let resolveDone;
  const child = { exitCode: null, signalCode: null };
  child.kill = (signal) => {
    signals.push(signal);
    if (signal === 'SIGKILL') {
      child.exitCode = 137;
      resolveDone({ signal: 'SIGKILL', status: null });
    }
    return true;
  };
  const done = new Promise((resolve) => { resolveDone = resolve; });
  await settleStartedChild({ child, done }, 'blocked child', { exitMs: 100, graceMs: 5 });
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);

  const primary = new Error('primary assertion');
  const combined = combineCleanupFailures(primary, cleanupErrors);
  assert.ok(combined instanceof AggregateError);
  assert.equal(combined.errors[0], primary, 'the primary scenario failure must remain first');
  assert.equal(combined.errors[1], cleanupErrors[0]);
});

test('lock fixture emits a deterministic nonempty synthetic backup for the approved pg_dump command', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-lock-fixture-backup-'));
  try {
    await fs.writeFile(path.join(root, 'docker'), lockFixtureDockerScript(
      { sha: 'a'.repeat(64) }, { sha: 'c'.repeat(64) },
    ));
    const bash = process.platform === 'win32' ? 'C:\\Program Files\\Git\\bin\\bash.exe' : 'bash';
    const args = ['docker', 'compose', '-f', '/fixture/compose.staging.yml',
      '--env-file', '/fixture/.env.staging', 'exec', '-T', 'postgres',
      'pg_dump', '-U', 'easyboost_staging', '-d', 'easyboost_staging',
      '--format=custom', '--no-owner', '--no-privileges'];
    const options = { cwd: root, encoding: 'utf8', timeout: 5_000,
      env: { ...process.env, BARRIER_DIR: '.' } };
    const first = spawnSync(bash, args, options);
    assert.equal(first.status, 0, first.stderr);
    assert.ok(Buffer.byteLength(first.stdout) > 0,
      'the fixture must emit a nonempty stream for the staging-deploy backup gate');
    const repeated = spawnSync(bash, args, options);
    assert.equal(repeated.status, 0, repeated.stderr);
    assert.equal(repeated.stdout, first.stdout, 'the synthetic backup stream must be deterministic');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

async function withLockImageFixture(action) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-lock-image-reference-'));
  const current = { sha: 'a'.repeat(64) };
  const candidate = { sha: 'c'.repeat(64) };
  const bash = process.platform === 'win32' ? 'C:\\Program Files\\Git\\bin\\bash.exe' : 'bash';
  const environment = { ...process.env, BARRIER_DIR: '.', BLOCK_AT: '',
    IMAGE_STATE: 'image-state', CONTAINER_STATE: 'container-state', RELEASE_STATE: 'release-state' };
  const options = { cwd: root, env: environment, encoding: 'utf8', timeout: 5_000 };
  try {
    await fs.writeFile(path.join(root, 'docker'), lockFixtureDockerScript(current, candidate));
    await fs.writeFile(path.join(root, 'image-state'), `${previousImageId}\n`);
    await fs.writeFile(path.join(root, 'container-state'), `${previousImageId}\n`);
    const run = (args) => spawnSync(bash, ['docker', ...args], {
      ...options, input: 'synthetic build stream\n',
    });
    return await action({ root, current, candidate, bash, options, run });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

test('lock fixture image reference listing agrees with build and inspect', async () => {
  await withLockImageFixture(async ({ candidate, run }) => {
    const reference = `easyboost-staging-app:release-${candidate.sha}`;
    const built = run(['build', '--file', 'Dockerfile', '--tag', reference, '-']);
    assert.equal(built.status, 0, built.stderr);
    const inspected = run(['image', 'inspect', '--format', '{{.Id}}', reference]);
    assert.equal(inspected.status, 0, inspected.stderr);
    assert.equal(inspected.stdout, `${candidateImageId}\n`);
    const listed = run(['image', 'ls', '--quiet', '--no-trunc', '--filter', `reference=${reference}`]);
    assert.equal(listed.status, 0, listed.stderr);
    assert.equal(listed.stdout, `${candidateImageId}\n`, 'built reference must not be reported absent');
  });
});

for (const releaseName of ['current', 'candidate']) {
  test(`lock fixture image reference tracks absent, built and removed ${releaseName} without changing retained state`, async () => {
    await withLockImageFixture(async ({ root, current, candidate, run }) => {
      const release = releaseName === 'current' ? current : candidate;
      const other = releaseName === 'current' ? candidate : current;
      const expected = releaseName === 'current' ? previousImageId : candidateImageId;
      const reference = `easyboost-staging-app:release-${release.sha}`;
      const listing = (target) => {
        const result = run(['image', 'ls', '--quiet', '--no-trunc', '--filter', `reference=${target}`]);
        assert.equal(result.status, 0, result.stderr);
        return result.stdout;
      };
      assert.equal(listing(reference), '', 'unbuilt exact tag must be absent');
      assert.equal(run(['image', 'inspect', '--format', '{{.Id}}', reference]).status, 1);
      const built = run(['build', '--file', 'Dockerfile', '--tag', reference, '-']);
      assert.equal(built.status, 0, built.stderr);
      const inspected = run(['image', 'inspect', '--format', '{{.Id}}', reference]);
      assert.equal(inspected.status, 0, inspected.stderr);
      assert.equal(inspected.stdout, `${expected}\n`);
      assert.equal(listing(reference), `${expected}\n`);
      assert.equal(listing(`easyboost-staging-app:release-${other.sha}`), '',
        'the other known release must not alias the built tag');
      const removed = run(['image', 'rm', '-f', reference]);
      assert.equal(removed.status, 0, removed.stderr);
      assert.equal(listing(reference), '', 'removed exact tag must be absent');
      assert.equal(run(['image', 'inspect', '--format', '{{.Id}}', reference]).status, 1);
      await assert.rejects(fs.access(path.join(root, 'release-state')), { code: 'ENOENT' });
      assert.equal(listing('easyboost-staging-app:local'), `${previousImageId}\n`);
      for (const args of [
        ['image', 'inspect', '--format', '{{.Id}}', 'easyboost-staging-app:local'],
        ['inspect', '--format', '{{.Image}}', 'fake-container'],
      ]) {
        const retained = run(args);
        assert.equal(retained.status, 0, retained.stderr);
        assert.equal(retained.stdout, `${previousImageId}\n`);
      }
      for (const state of ['image-state', 'container-state']) {
        assert.equal(await fs.readFile(path.join(root, state), 'utf8'), `${previousImageId}\n`);
      }
    });
  });
}

test('lock fixture image reference listing rejects malformed and unsupported query shapes', async () => {
  await withLockImageFixture(async ({ candidate, run }) => {
    const reference = `reference=easyboost-staging-app:release-${candidate.sha}`;
    const prefix = ['image', 'ls', '--quiet', '--no-trunc', '--filter'];
    for (const args of [
      ['image', 'ls'],
      ['image', 'ls', '--quiet', '--filter', reference],
      ['image', 'ls', '--no-trunc', '--quiet', '--filter', reference],
      ['image', 'ls', '--quiet', '--no-trunc', '--format', reference],
      prefix,
      [...prefix, reference, 'extra'],
      [...prefix, 'reference=easyboost-staging-app:release-*'],
      [...prefix, `${reference}-other`],
      [...prefix, reference.slice(0, -1)],
      [...prefix, 'label=easyboost-staging-app:local'],
    ]) {
      const result = run(args);
      assert.equal(result.status, 1, `unsupported listing must fail: ${args.join(' ')}\n${result.stderr}`);
      assert.equal(result.stdout, '', 'rejected listing must not publish an image identity');
    }
  });
});

test('lock fixture image reference lets real owned cleanup prove removal and reject a different owner', async () => {
  await withLockImageFixture(async ({ root, current, candidate, bash, options, run }) => {
    // Source the real helper unchanged apart from LF normalization, then replace only
    // its external command runner. This finite command contract is not supervisor proof.
    const common = await fs.readFile(path.resolve('scripts/staging-release-common.sh'), 'utf8');
    await fs.writeFile(path.join(root, 'common.sh'), common.replaceAll('\r\n', '\n'));
    await fs.writeFile(path.join(root, 'remove-owned.sh'), `#!/bin/bash
set -eu
source "$PWD/common.sh"
run_bounded() {
  [ "$1" = "$COMMAND_SECONDS" ] && [ "$2" = docker ] || return 64
  shift 2
  printf '%s\\n' "$*" >> command-log
  bash "$PWD/docker" "$@"
}
remove_owned_image_reference "$1" "$2"
`);
    for (const [release, expected, wrongOwner] of [
      [current, previousImageId, candidateImageId],
      [candidate, candidateImageId, previousImageId],
    ]) {
      const reference = `easyboost-staging-app:release-${release.sha}`;
      const built = run(['build', '--file', 'Dockerfile', '--tag', reference, '-']);
      assert.equal(built.status, 0, built.stderr);
      const remove = (owner) => spawnSync(bash, ['remove-owned.sh', reference, owner], {
        ...options, env: { ...options.env,
          PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH}` },
      });
      const rejected = remove(wrongOwner);
      assert.equal(rejected.status, 1, rejected.stderr);
      assert.match(rejected.stderr, /is not owned by this transaction/u);
      assert.equal(await fs.readFile(path.join(root, 'release-state'), 'utf8'), `${expected}\n`);
      await fs.writeFile(path.join(root, 'command-log'), '');
      const removed = remove(expected);
      assert.equal(removed.status, 0, removed.stderr);
      const listCommand = `image ls --quiet --no-trunc --filter reference=${reference}`;
      assert.deepEqual((await fs.readFile(path.join(root, 'command-log'), 'utf8')).trim().split('\n'), [
        listCommand, listCommand, `image rm -f ${reference}`, listCommand,
      ]);
      await assert.rejects(fs.access(path.join(root, 'release-state')), { code: 'ENOENT' });
      const absent = run(['image', 'ls', '--quiet', '--no-trunc', '--filter', `reference=${reference}`]);
      assert.equal(absent.status, 0, absent.stderr);
      assert.equal(absent.stdout, '');
      for (const state of ['image-state', 'container-state']) {
        assert.equal(await fs.readFile(path.join(root, state), 'utf8'), `${previousImageId}\n`);
      }
    }
  });
});

test('lock barrier timeout preserves failure and cleanup with bounded lifecycle evidence', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-lock-evidence-'));
  const barriers = path.join(root, 'barriers');
  let handle;
  let failure;
  let cleanupErrors;
  try {
    await fs.mkdir(barriers);
    const docker = path.join(root, 'docker');
    await fs.writeFile(docker, lockFixtureDockerScript(
      { sha: 'a'.repeat(64) }, { sha: 'c'.repeat(64) },
    ));
    const bash = process.platform === 'win32' ? 'C:\\Program Files\\Git\\bin\\bash.exe' : 'bash';
    handle = start(process.execPath, ['--input-type=module', '-e', `
      import { spawnSync } from 'node:child_process';
      import fs from 'node:fs';
      import path from 'node:path';
      const configured = spawnSync(${JSON.stringify(bash)}, [${JSON.stringify(docker.replaceAll('\\', '/'))},
        'compose', '-f', '/fixture/compose.staging.yml', '--env-file', '/fixture/.env.staging',
        'config', '--quiet'], { env: process.env, encoding: 'utf8', timeout: 3000 });
      if (configured.status !== 0) process.exit(2);
      process.stdout.write('o'.repeat(12000) + 'stdout-tail');
      process.stderr.write('e'.repeat(12000) + 'stderr-tail');
      fs.writeFileSync(path.join(process.env.BARRIER_DIR, 'ready'), 'ready');
      setTimeout(() => {}, 4000);
    `], { ...process.env, BARRIER_DIR: barriers.replaceAll('\\', '/'), BLOCK_AT: 'tree' });
    await waitForFile(path.join(barriers, 'ready'), handle, 3_000);
    try {
      await waitForFile(path.join(barriers, 'tree'), handle, 50);
    } catch (error) {
      failure = error;
    }
    assert.match(failure?.message ?? '', /Timed out waiting for .*tree/u);
    const evidenceLine = failure.message.split('\n').find((line) => line.startsWith('[DEBUG-ci123-lock] '));
    assert.ok(evidenceLine, 'a stalled child must expose lifecycle evidence before cleanup');
    const evidence = JSON.parse(evidenceLine.slice('[DEBUG-ci123-lock] '.length));
    assert.equal(evidence.lastPhase, 'config-quiet-complete');
    assert.ok(evidence.elapsedMs >= 50 && evidence.elapsedMs < 4_000);
    assert.equal(evidence.upCount, 'missing');
    assert.equal(evidence.tree, 'absent');
    assert.ok(evidence.stdout.endsWith('stdout-tail'));
    assert.ok(evidence.stderr.endsWith('stderr-tail'));
    assert.ok(Buffer.byteLength(evidence.stdout) <= 1_024);
    assert.ok(Buffer.byteLength(evidence.stderr) <= 1_024);
    assert.ok(failure.message.length < 4_000, 'captured output must stay bounded');
    assert.equal(childIsLive(handle.child), true, 'diagnostics must precede child cleanup');
  } finally {
    cleanupErrors = await cleanupLockIntegrationResources({ barriers, handles: { activating: handle }, root });
  }
  assert.deepEqual(cleanupErrors, []);
  assert.equal(childIsLive(handle.child), false);
  await assert.rejects(fs.access(root), { code: 'ENOENT' });
  assert.equal(combineCleanupFailures(failure, cleanupErrors), failure,
    'cleanup must retain the original barrier failure');
});

test('lock fixture lifecycle evidence follows normal config, build and tree activation', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-lock-lifecycle-'));
  const current = { sha: 'a'.repeat(64) };
  const candidate = { sha: 'c'.repeat(64) };
  const bash = process.platform === 'win32' ? 'C:\\Program Files\\Git\\bin\\bash.exe' : 'bash';
  const docker = path.join(root, 'docker').replaceAll('\\', '/');
  const environment = { ...process.env, BARRIER_DIR: root.replaceAll('\\', '/'), BLOCK_AT: 'tree',
    IMAGE_STATE: 'image-state', CONTAINER_STATE: 'container-state', RELEASE_STATE: 'release-state',
    RESOLVED_COMPOSE_JSON: '{"name":"synthetic-compose"}' };
  const compose = ['compose', '-f', '/fixture/compose.staging.yml', '--env-file', '/fixture/.env.staging'];
  let activating;
  try {
    await fs.writeFile(docker, lockFixtureDockerScript(current, candidate));
    await fs.writeFile(path.join(root, 'image-state'), `${previousImageId}\n`);
    function run(args, input) {
      const result = spawnSync(bash, [docker, ...args], {
        cwd: root, env: environment, input, encoding: 'utf8', timeout: 3_000,
      });
      assert.equal(result.status, 0, result.stderr);
      return result;
    }
    assert.equal(run([...compose, 'config', '--format', 'json']).stdout, '{"name":"synthetic-compose"}');
    assert.equal(await fs.readFile(path.join(root, 'phase-tree'), 'utf8'), 'config-json-complete\n');
    assert.equal(run([...compose, 'config', '--quiet']).stdout, '');
    assert.equal(await fs.readFile(path.join(root, 'phase-tree'), 'utf8'), 'config-quiet-complete\n');
    run(['build', '--file', 'Dockerfile', '--tag', `easyboost-staging-app:release-${current.sha}`, '-'],
      'synthetic build stream\n');
    assert.equal(await fs.readFile(path.join(root, 'phase-tree'), 'utf8'), 'build-complete\n');
    assert.equal(await fs.readFile(path.join(root, 'release-state'), 'utf8'), `${previousImageId}\n`);
    activating = start(bash, [docker, ...compose, 'up', '--pull', 'never', '-d', '--no-build', '--no-deps', 'app'],
      { ...environment, IMAGE_STATE: path.join(root, 'image-state').replaceAll('\\', '/'),
        CONTAINER_STATE: path.join(root, 'container-state').replaceAll('\\', '/') });
    await waitForFile(path.join(root, 'tree'), activating, 3_000);
    const evidence = JSON.parse((await lockLifecycleEvidence(path.join(root, 'tree'), activating))
      .slice('[DEBUG-ci123-lock] '.length));
    assert.equal(evidence.lastPhase, 'up-barrier');
    assert.equal(evidence.upCount, '1');
    assert.equal(evidence.tree, 'present');
    assert.equal(childIsLive(activating.child), true);
    assert.equal(await fs.readFile(path.join(root, 'container-state'), 'utf8'), `${previousImageId}\n`);
    await fs.writeFile(path.join(root, 'release-tree'), 'go\n');
    assert.equal((await activating.done).status, 0);
    assert.equal(await fs.readFile(path.join(root, 'phase-tree'), 'utf8'), 'up-complete\n');
    // Unreadable diagnostic destination must not alter the approved command's verdict/output.
    await fs.rm(path.join(root, 'phase-tree'));
    await fs.mkdir(path.join(root, 'phase-tree'));
    assert.equal(run([...compose, 'config', '--quiet']).stdout, '');
  } finally {
    assert.deepEqual(await cleanupLockIntegrationResources({ barriers: root,
      handles: { activating }, root }), []);
  }
});

test('lock barrier failure reports missing or invalid evidence without masking exit and cleanup', async () => {
  for (const condition of ['missing', 'unreadable', 'invalid']) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-lock-missing-evidence-'));
    let handle;
    let failure;
    let cleanupErrors;
    try {
      // Starting with an unreadable destination must also ignore stale evidence.
      if (condition === 'unreadable') await fs.mkdir(path.join(root, 'phase-tree'));
      handle = start(process.execPath, ['-e', 'process.exitCode = 7;'], {
        ...process.env, BARRIER_DIR: root, BLOCK_AT: 'tree',
      });
      if (condition === 'missing') await fs.rm(path.join(root, 'phase-tree'));
      if (condition === 'invalid') {
        await fs.writeFile(path.join(root, 'phase-tree'), 'not-an-allowlisted-phase');
        await fs.writeFile(path.join(root, 'up-count'), 'not-an-activation-count');
      }
      await handle.done;
      try {
        await waitForFile(path.join(root, 'tree'), handle, 100);
      } catch (error) {
        failure = error;
      }
      assert.match(failure?.message ?? '', /Process exited before tree barrier\nstatus=7 signal=none/u);
      const evidenceLine = failure.message.split('\n').find((line) => line.startsWith('[DEBUG-ci123-lock] '));
      assert.ok(evidenceLine);
      const evidence = JSON.parse(evidenceLine.slice('[DEBUG-ci123-lock] '.length));
      assert.equal(evidence.lastPhase, condition === 'missing' ? 'missing' : 'unavailable');
      assert.equal(evidence.upCount, condition === 'invalid' ? 'unavailable' : 'missing');
      assert.equal(evidence.tree, 'absent');
      assert.ok(evidence.elapsedMs >= 0);
      assert.doesNotMatch(failure.message, /not-an-allowlisted-phase|not-an-activation-count/u);
    } finally {
      cleanupErrors = await cleanupLockIntegrationResources({ barriers: root, handles: { activating: handle }, root });
    }
    assert.deepEqual(cleanupErrors, []);
    assert.equal(childIsLive(handle.child), false);
    await assert.rejects(fs.access(root), { code: 'ENOENT' });
    assert.equal(combineCleanupFailures(failure, cleanupErrors), failure);
  }
});

test('real Linux flock excludes deploy and rollback through build, tree activation and recovery', {
  skip: process.platform !== 'linux' ? 'requires Linux /usr/bin/flock semantics' : false,
}, async (t) => {
  let root = null;
  let barriers = null;
  let building = null;
  let activating = null;
  let recovering = null;
  let killed = null;
  let primaryFailure = null;
  const cleanupErrors = [];
  try {
    const flock = spawnSync('flock', ['--version'], { encoding: 'utf8' });
    assert.equal(flock.status, 0, flock.stderr);
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-real-flock-'));
    const appDir = path.join(root, 'app');
    const fakeBin = path.join(root, 'bin');
    barriers = path.join(root, 'barriers');
    const current = await release(root, 'current', 'current');
    const candidate = await release(root, 'candidate', 'candidate');
    await fs.mkdir(path.join(appDir, 'rollbacks', 'releases'), { recursive: true });
    await fs.mkdir(path.join(appDir, 'backups'), { recursive: true });
    await fs.mkdir(fakeBin);
    await fs.mkdir(barriers);
    const helperRoot = path.join(root, 'helpers');
    const helperLinks = path.join(root, 'sbin');
    const hermeticInstaller = await prepareHermeticHelperInstaller(root, fakeBin);
    const installed = spawnSync('bash', [hermeticInstaller.installer], {
      env: {
        ...process.env,
        EASYBOOST_TEST_INSTALLER_NODE_DIRECTORY: hermeticInstaller.nodeDirectory,
        STAGING_HELPER_ALLOWED_PREFIX: root,
        STAGING_HELPER_INSTALL_ROOT: helperRoot,
        STAGING_HELPER_LINK_ROOT: helperLinks,
      },
      encoding: 'utf8',
    });
    assert.equal(installed.status, 0, installed.stderr);
    assert.match(installed.stdout, /staging_helper_protocol=immutable-archive-v4/u);
    const bundleDigest = /staging_helper_bundle_sha256=([a-f0-9]{64})/u.exec(installed.stdout)?.[1];
    assert.match(bundleDigest ?? '', /^[a-f0-9]{64}$/u);
    assert.equal(await fs.readFile(path.join(helperRoot, 'current'), 'utf8'), `${bundleDigest}\n`);
    const installedAgain = spawnSync('bash', [hermeticInstaller.installer], {
      env: {
        ...process.env,
        EASYBOOST_TEST_INSTALLER_NODE_DIRECTORY: hermeticInstaller.nodeDirectory,
        STAGING_HELPER_ALLOWED_PREFIX: root,
        STAGING_HELPER_INSTALL_ROOT: helperRoot,
        STAGING_HELPER_LINK_ROOT: helperLinks,
      },
      encoding: 'utf8',
    });
    assert.equal(installedAgain.status, 0, installedAgain.stderr);
    await fs.cp(current.source, appDir, { recursive: true });
    await fs.writeFile(path.join(appDir, '.env.staging'), 'APP_PORT=3001\n');
    await fs.writeFile(path.join(appDir, '.release-sha256'), `${current.sha}\n`);
    const currentStored = path.join(
      appDir, 'rollbacks', 'releases', `release-${current.sha}.tar.gz`,
    );
    await fs.copyFile(current.archive, currentStored);
    await fs.writeFile(`${currentStored}.sha256`, `${current.sha}\n`);
    await Promise.all([
      fs.chmod(appDir, 0o700),
      fs.chmod(path.join(appDir, 'backups'), 0o700),
      fs.chmod(path.join(appDir, 'rollbacks'), 0o700),
      fs.chmod(path.join(appDir, 'rollbacks', 'releases'), 0o700),
      fs.chmod(path.join(appDir, '.env.staging'), 0o600),
      fs.chmod(path.join(appDir, '.release-sha256'), 0o600),
      fs.chmod(currentStored, 0o600),
      fs.chmod(`${currentStored}.sha256`, 0o600),
    ]);
    const imageState = path.join(root, 'image-state');
    const containerState = path.join(root, 'container-state');
    const releaseState = path.join(root, 'release-state');
    await fs.writeFile(imageState, `${previousImageId}\n`);
    await fs.writeFile(containerState, `${previousImageId}\n`);

    const docker = path.join(fakeBin, 'docker');
    await fs.writeFile(docker, lockFixtureDockerScript(current, candidate));
    await fs.writeFile(path.join(fakeBin, 'curl'), `#!/bin/bash
set -eu
count=0; [ ! -f "$BARRIER_DIR/curl-count" ] || count="$(cat "$BARRIER_DIR/curl-count")"; count=$((count+1)); echo "$count" > "$BARRIER_DIR/curl-count"
if [ "\${FAIL_CANDIDATE_READY:-0}" = 1 ] && grep -Fqx '${candidateImageId}' "$IMAGE_STATE"; then exit 1; fi
exit 0
`);
    await fs.writeFile(path.join(fakeBin, 'sleep'), '#!/bin/bash\nexit 0\n');
    await fs.chmod(docker, 0o755);
    await fs.chmod(path.join(fakeBin, 'curl'), 0o755);
    await fs.chmod(path.join(fakeBin, 'sleep'), 0o755);

    const environment = {
      ...process.env,
      BARRIER_DIR: barriers,
      CONTAINER_STATE: containerState,
      EASYBOOST_HOST_OPERATION_LOCK_DIR: path.join(root, 'host-operation.lock'),
      IMAGE_STATE: imageState,
      RELEASE_STATE: releaseState,
      RESOLVED_COMPOSE_JSON: JSON.stringify(approvedComposeModel(appDir)),
      PATH: `${fakeBin}:${process.env.PATH}`,
      STAGING_APP_DIR: appDir,
      TMPDIR: root,
    };
    const installedDeploy = path.join(helperLinks, 'easyboost-staging-deploy');
    const installedRollback = path.join(helperLinks, 'easyboost-staging-rollback');
    const deployArgs = [installedDeploy, candidate.archive, candidate.sha,
      'immutable-archive-v4', bundleDigest];

    building = start('bash', deployArgs, { ...environment, BLOCK_AT: 'build' });
    t.diagnostic('[DEBUG-ci123-lock] deploy-start elapsed_ms=0');
    await waitForFile(path.join(barriers, 'build'), building);
    t.diagnostic(`[DEBUG-ci123-lock] deploy-build-barrier elapsed_ms=${Math.round(performance.now() - building.startedAt)}`);
    const blockedRollback = spawnSync('bash', [installedRollback, current.sha,
      'immutable-archive-v4', bundleDigest], {
      env: environment, encoding: 'utf8', timeout: 10_000,
    });
    assert.equal(blockedRollback.status, 75, blockedRollback.stderr);
    await fs.writeFile(path.join(barriers, 'release-build'), 'go\n');
    const built = await building.done;
    t.diagnostic(`[DEBUG-ci123-lock] deploy-exit elapsed_ms=${Math.round(performance.now() - building.startedAt)}`);
    assert.equal(built.status, 0, built.stderr);
    assert.equal(await fs.readFile(containerState, 'utf8'), `${candidateImageId}\n`);

    await fs.rm(path.join(barriers, 'up-count'), { force: true });
    activating = start('bash', [installedRollback, current.sha,
      'immutable-archive-v4', bundleDigest], {
      ...environment, BLOCK_AT: 'tree',
    });
    t.diagnostic('[DEBUG-ci123-lock] rollback-start elapsed_ms=0');
    await waitForFile(path.join(barriers, 'tree'), activating);
    t.diagnostic(`[DEBUG-ci123-lock] rollback-tree-barrier elapsed_ms=${Math.round(performance.now() - activating.startedAt)}`);
    const blockedDeploy = spawnSync('bash', deployArgs, {
      env: environment, encoding: 'utf8', timeout: 10_000,
    });
    assert.equal(blockedDeploy.status, 75, blockedDeploy.stderr);
    await fs.writeFile(path.join(barriers, 'release-tree'), 'go\n');
    const activated = await activating.done;
    t.diagnostic(`[DEBUG-ci123-lock] rollback-exit elapsed_ms=${Math.round(performance.now() - activating.startedAt)}`);
    assert.equal(activated.status, 0, activated.stderr);
    assert.equal(await fs.readFile(containerState, 'utf8'), `${previousImageId}\n`);

    await fs.rm(path.join(barriers, 'up-count'), { force: true });
    await fs.rm(path.join(barriers, 'curl-count'), { force: true });
    recovering = start('bash', deployArgs, {
      ...environment, BLOCK_AT: 'recovery', FAIL_CANDIDATE_READY: '1',
    });
    t.diagnostic('[DEBUG-ci123-lock] recovery-start elapsed_ms=0');
    await waitForFile(path.join(barriers, 'recovery'), recovering);
    t.diagnostic(`[DEBUG-ci123-lock] recovery-barrier elapsed_ms=${Math.round(performance.now() - recovering.startedAt)}`);
    const blockedDuringRecovery = spawnSync('bash', [installedRollback, candidate.sha,
      'immutable-archive-v4', bundleDigest], {
      env: environment, encoding: 'utf8', timeout: 10_000,
    });
    assert.equal(blockedDuringRecovery.status, 75, blockedDuringRecovery.stderr);
    await fs.writeFile(path.join(barriers, 'release-recovery'), 'go\n');
    const recovered = await recovering.done;
    t.diagnostic(`[DEBUG-ci123-lock] recovery-exit elapsed_ms=${Math.round(performance.now() - recovering.startedAt)}`);
    assert.equal(recovered.status, 1, recovered.stderr);
    assert.match(recovered.stderr, /verified prior state restored/u);
    assert.equal(await fs.readFile(containerState, 'utf8'), `${previousImageId}\n`);

    await fs.rm(path.join(barriers, 'build'), { force: true });
    await fs.rm(path.join(barriers, 'release-build'), { force: true });
    killed = start('bash', deployArgs, { ...environment, BLOCK_AT: 'build' });
    t.diagnostic('[DEBUG-ci123-lock] killed-build-start elapsed_ms=0');
    await waitForFile(path.join(barriers, 'build'), killed);
    t.diagnostic(`[DEBUG-ci123-lock] killed-build-barrier elapsed_ms=${Math.round(performance.now() - killed.startedAt)}`);
    const blockedBuildPid = Number(await fs.readFile(path.join(barriers, 'build-pid'), 'utf8'));
    await assert.rejects(fs.access(path.join(barriers, 'inherited-lock-fd')), { code: 'ENOENT' });
    killed.child.kill('SIGKILL');
    const killedResult = await killed.done;
    t.diagnostic(`[DEBUG-ci123-lock] killed-build-exit elapsed_ms=${Math.round(performance.now() - killed.startedAt)}`);
    assert.equal(killedResult.signal, 'SIGKILL');
    await waitForProcessExit(blockedBuildPid);
    let afterKill;
    const lockDeadline = Date.now() + 5_000;
    do {
      afterKill = spawnSync('bash', [installedRollback, current.sha,
        'immutable-archive-v4', bundleDigest], {
        env: environment, encoding: 'utf8', timeout: 10_000,
      });
      if (afterKill.status !== 75) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    } while (Date.now() < lockDeadline);
    assert.notEqual(afterKill.status, 75, afterKill.stderr);
    assert.equal(afterKill.status, 70, afterKill.stderr);
    await assert.rejects(fs.access(path.join(barriers, 'release-build')), { code: 'ENOENT' });
    const composeInvocations = (await fs.readFile(
      path.join(barriers, 'compose-invocations'), 'utf8',
    )).trim().split('\n');
    const appUpInvocations = composeInvocations.filter((invocation) => (
      invocation.includes(' up ') && invocation.endsWith(' app')
    ));
    assert.ok(appUpInvocations.length >= 4,
      `expected app activation/recovery calls, got ${appUpInvocations.length}`);
    for (const invocation of appUpInvocations) {
      assert.match(invocation,
        / up --pull never -d --no-build --no-deps app$/u,
        'every app activation must preserve the exact dependency-isolation flags');
    }
  } catch (error) {
    primaryFailure = error;
  } finally {
    cleanupErrors.push(...await cleanupLockIntegrationResources({
      barriers,
      handles: { activating, building, killed, recovering },
      root,
    }));
  }
  const failure = combineCleanupFailures(primaryFailure, cleanupErrors);
  if (failure) throw failure;
});
