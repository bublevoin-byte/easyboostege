import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { HELPER_BUNDLE_FILES } from '../scripts/staging-helper-bundle.js';
import { createReleaseArchive } from '../scripts/staging-release-archive.js';

const installerScript = path.resolve('scripts/install-staging-release-helpers.sh');
const postgresImageId = `sha256:${'3'.repeat(64)}`;

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
        result.stderr,
      ].join('\n'));
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error([
    `Timed out waiting for ${file}`,
    handle.output.stderr.slice(-4_096),
  ].join('\n'));
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
  return { child, done, output };
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

test('real Linux flock excludes deploy and rollback through build, tree activation and recovery', {
  skip: process.platform !== 'linux' ? 'requires Linux /usr/bin/flock semantics' : false,
}, async () => {
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
    await fs.writeFile(imageState, `sha256:${'1'.repeat(64)}\n`);
    await fs.writeFile(containerState, `sha256:${'1'.repeat(64)}\n`);

    const docker = path.join(fakeBin, 'docker');
    await fs.writeFile(docker, `#!/bin/bash
set -eu
if [ "\${1:-}" = build ]; then
  cat >/dev/null
  if [ "\${BLOCK_AT:-}" = build ]; then
    echo $$ > "$BARRIER_DIR/build-pid"
    [ ! -e /proc/$$/fd/9 ] || touch "$BARRIER_DIR/inherited-lock-fd"
    trap '' TERM
    touch "$BARRIER_DIR/build"
    while [ ! -e "$BARRIER_DIR/release-build" ]; do /bin/sleep 0.02; done
  fi
  echo sha256:${'2'.repeat(64)} > "$RELEASE_STATE"
  exit 0
fi
if [ "\${1:-}" = image ] && [ "\${2:-}" = inspect ]; then
  target="\${@: -1}"
  case "$target" in easyboost-staging-app:release-*) [ -f "$RELEASE_STATE" ] || exit 1; cat "$RELEASE_STATE" ;; easyboost-staging-app:local) cat "$IMAGE_STATE" ;; postgres:17-alpine) echo ${postgresImageId} ;; *) exit 1 ;; esac
  exit 0
fi
if [ "\${1:-}" = image ] && [ "\${2:-}" = tag ]; then
  if [[ "$3" == sha256:* ]]; then printf '%s\n' "$3" > "$IMAGE_STATE"; else echo sha256:${'2'.repeat(64)} > "$IMAGE_STATE"; fi
  exit 0
fi
if [ "\${1:-}" = image ] && [ "\${2:-}" = rm ]; then case "\${@: -1}" in easyboost-staging-app:release-*) rm -f "$RELEASE_STATE" ;; esac; exit 0; fi
if [ "\${1:-}" = inspect ]; then cat "$CONTAINER_STATE"; exit 0; fi
if [ "\${1:-}" = compose ]; then
  case " $* " in
    *" config --format json "*) printf '%s' "$RESOLVED_COMPOSE_JSON" ;;
    *" config --quiet "*) : ;;
    *" ps -q app "*) echo fake-container ;;
    *" ps --status running postgres --quiet "*) : ;;
    *" up --pull never -d --no-build app "*)
      count=0; [ ! -f "$BARRIER_DIR/up-count" ] || count="$(cat "$BARRIER_DIR/up-count")"; count=$((count+1)); echo "$count" > "$BARRIER_DIR/up-count"
      cat "$IMAGE_STATE" > "$CONTAINER_STATE"
      if { [ "\${BLOCK_AT:-}" = tree ] && [ "$count" -eq 1 ]; } || { [ "\${BLOCK_AT:-}" = recovery ] && [ "$count" -eq 2 ]; }; then
        touch "$BARRIER_DIR/$BLOCK_AT"; while [ ! -e "$BARRIER_DIR/release-$BLOCK_AT" ]; do /bin/sleep 0.02; done
      fi
      ;;
  esac
  exit 0
fi
exit 0
`);
    await fs.writeFile(path.join(fakeBin, 'curl'), `#!/bin/bash
set -eu
count=0; [ ! -f "$BARRIER_DIR/curl-count" ] || count="$(cat "$BARRIER_DIR/curl-count")"; count=$((count+1)); echo "$count" > "$BARRIER_DIR/curl-count"
if [ "\${FAIL_CANDIDATE_READY:-0}" = 1 ] && grep -q candidate "$IMAGE_STATE"; then exit 1; fi
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
    await waitForFile(path.join(barriers, 'build'), building);
    const blockedRollback = spawnSync('bash', [installedRollback, current.sha,
      'immutable-archive-v4', bundleDigest], {
      env: environment, encoding: 'utf8', timeout: 10_000,
    });
    assert.equal(blockedRollback.status, 75, blockedRollback.stderr);
    await fs.writeFile(path.join(barriers, 'release-build'), 'go\n');
    const built = await building.done;
    assert.equal(built.status, 0, built.stderr);

    await fs.rm(path.join(barriers, 'up-count'), { force: true });
    activating = start('bash', [installedRollback, current.sha,
      'immutable-archive-v4', bundleDigest], {
      ...environment, BLOCK_AT: 'tree',
    });
    await waitForFile(path.join(barriers, 'tree'), activating);
    const blockedDeploy = spawnSync('bash', deployArgs, {
      env: environment, encoding: 'utf8', timeout: 10_000,
    });
    assert.equal(blockedDeploy.status, 75, blockedDeploy.stderr);
    await fs.writeFile(path.join(barriers, 'release-tree'), 'go\n');
    const activated = await activating.done;
    assert.equal(activated.status, 0, activated.stderr);

    await fs.rm(path.join(barriers, 'up-count'), { force: true });
    await fs.rm(path.join(barriers, 'curl-count'), { force: true });
    recovering = start('bash', deployArgs, {
      ...environment, BLOCK_AT: 'recovery', FAIL_CANDIDATE_READY: '1',
    });
    await waitForFile(path.join(barriers, 'recovery'), recovering);
    const blockedDuringRecovery = spawnSync('bash', [installedRollback, candidate.sha,
      'immutable-archive-v4', bundleDigest], {
      env: environment, encoding: 'utf8', timeout: 10_000,
    });
    assert.equal(blockedDuringRecovery.status, 75, blockedDuringRecovery.stderr);
    await fs.writeFile(path.join(barriers, 'release-recovery'), 'go\n');
    const recovered = await recovering.done;
    assert.equal(recovered.status, 1, recovered.stderr);
    assert.match(recovered.stderr, /verified prior state restored/u);

    await fs.rm(path.join(barriers, 'build'), { force: true });
    await fs.rm(path.join(barriers, 'release-build'), { force: true });
    killed = start('bash', deployArgs, { ...environment, BLOCK_AT: 'build' });
    await waitForFile(path.join(barriers, 'build'), killed);
    const blockedBuildPid = Number(await fs.readFile(path.join(barriers, 'build-pid'), 'utf8'));
    await assert.rejects(fs.access(path.join(barriers, 'inherited-lock-fd')), { code: 'ENOENT' });
    killed.child.kill('SIGKILL');
    const killedResult = await killed.done;
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
