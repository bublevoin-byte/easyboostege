// DIAGNOSTIC ONLY: one real installed rollback; no preceding successful deploy.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { HELPER_BUNDLE_FILES, verifyInstalledHelperGeneration } from '../../../scripts/staging-helper-bundle.js';
import { createReleaseArchive, extractReleaseArchive, verifyReleaseTree } from '../../../scripts/staging-release-archive.js';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const fixturePrefix = 'easyboost-ci126-rollback-';
const systemPath = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
const treeBoundMs = 120_000;
const payloadNames = ['.dockerignore', 'Dockerfile', 'candidate.txt', 'compose.staging.yml'];
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const exists = async (file) => fs.lstat(file).then(() => true, (error) => {
  if (error.code === 'ENOENT') return false;
  throw error;
});

function report(row) {
  const line = JSON.stringify(row);
  assert.ok(Buffer.byteLength(line) <= 2048);
  writeSync(1, `${line}\n`);
}

async function loadFactories() {
  const text = await fs.readFile(path.join(repo, 'test/staging-release-lock.integration.test.js'), 'utf8');
  function extract(start, end, expression, context = {}) {
    const first = text.indexOf(start);
    const last = text.indexOf(end, first);
    assert.ok(first > 0 && last > first);
    return vm.runInNewContext(`${text.slice(first, last)}\n${expression}`, context, { timeout: 1000 });
  }
  const factories = extract('const previousImageId =', '\nasync function waitForFile(',
    '({ release, lockFixtureDockerScript, approvedComposeModel, previousImageId, candidateImageId, lockFixturePhases })',
    { fs, path, createReleaseArchive });
  const prepareInstaller = extract('async function prepareHermeticHelperInstaller(',
    '\nfunction combineCleanupFailures(', 'prepareHermeticHelperInstaller',
    { fs, path, process, assert, HELPER_BUNDLE_FILES,
      installerScript: path.join(repo, 'scripts/install-staging-release-helpers.sh') });
  return { ...factories, prepareInstaller };
}

export async function prepareFixture(root) {
  assert.equal(path.dirname(root), os.tmpdir());
  assert.ok(path.basename(root).startsWith(fixturePrefix));
  const identity = await fs.lstat(root);
  assert.ok(identity.isDirectory() && !identity.isSymbolicLink());
  const factories = await loadFactories();
  const current = await factories.release(root, 'current', 'current');
  const candidate = await factories.release(root, 'candidate', 'candidate');
  const app = path.join(root, 'app');
  const bin = path.join(root, 'bin');
  const barriers = path.join(root, 'barriers');
  await extractReleaseArchive({ archivePath: candidate.archive, destination: app });
  // deploy's chmod -R a-w + prepare-copy + cp -a preserves0444 file modes.
  for (const name of payloadNames) await fs.chmod(path.join(app, name), 0o444);
  for (const directory of ['backups', 'rollbacks', 'rollbacks/releases']) {
    await fs.mkdir(path.join(app, directory), { mode: 0o700 });
  }
  await fs.chmod(app, 0o700);
  for (const [name, bytes] of [['.env.staging', 'APP_PORT=3001\n'],
    ['.release-sha256', `${candidate.sha}\n`], ['.staging-release.lock', '']]) {
    await fs.writeFile(path.join(app, name), bytes, { mode: 0o600 });
  }
  for (const release of [current, candidate]) {
    const archive = path.join(app, 'rollbacks/releases', `release-${release.sha}.tar.gz`);
    await fs.copyFile(release.archive, archive);
    await fs.chmod(archive, 0o600);
    await fs.writeFile(`${archive}.sha256`, `${release.sha}\n`, { mode: 0o600 });
  }
  // Same synthetic backup stream as successful fixture deploy; timestamp/PID are inert history.
  const backup = `easyboost-staging-20000101T000000Z-${candidate.sha.slice(0, 12)}-1.dump`;
  await fs.writeFile(path.join(app, 'backups', backup), 'synthetic-lock-fixture-backup\n', { mode: 0o600 });
  await fs.mkdir(bin, { mode: 0o700 });
  await fs.mkdir(barriers, { mode: 0o700 });
  const imageState = path.join(root, 'image-state');
  const containerState = path.join(root, 'container-state');
  const releaseState = path.join(root, 'release-state');
  for (const file of [imageState, containerState]) {
    await fs.writeFile(file, `${factories.candidateImageId}\n`, { mode: 0o600 });
  }
  await fs.writeFile(path.join(bin, 'docker'), factories.lockFixtureDockerScript(current, candidate), { mode: 0o755 });
  await fs.writeFile(path.join(bin, 'curl'), '#!/bin/bash\nset -eu\ncount=0; [ ! -f "$BARRIER_DIR/curl-count" ] || count="$(cat "$BARRIER_DIR/curl-count")"; count=$((count+1)); echo "$count" > "$BARRIER_DIR/curl-count"\nexit 0\n', { mode: 0o755 });
  await fs.writeFile(path.join(bin, 'sleep'), '#!/bin/bash\nexit 0\n', { mode: 0o755 });
  const environment = { PATH: `${bin}:${systemPath}`, LANG: 'C', LC_ALL: 'C', HOME: root, TMPDIR: root,
    STAGING_APP_DIR: app, STAGING_HELPER_ALLOWED_PREFIX: root,
    EASYBOOST_HOST_OPERATION_LOCK_DIR: path.join(root, 'host-operation.lock'),
    BARRIER_DIR: barriers, IMAGE_STATE: imageState, CONTAINER_STATE: containerState,
    RELEASE_STATE: releaseState, RESOLVED_COMPOSE_JSON: JSON.stringify(factories.approvedComposeModel(app)) };
  return { root, identity, factories, current, candidate, app, bin, barriers, backup,
    imageState, containerState, releaseState, environment };
}

async function protectedEntry(file, kind, mode) {
  const stat = await fs.lstat(file);
  assert.ok(!stat.isSymbolicLink() && (kind === 'directory' ? stat.isDirectory() : stat.isFile()));
  if (kind === 'file') assert.equal(stat.nlink, 1);
  if (process.platform === 'linux') {
    assert.equal(stat.uid, process.getuid());
    assert.equal(stat.mode & 0o777, mode);
  }
}

export async function verifyFixture(fixture) {
  const { root, app, current, candidate, factories, imageState, containerState, releaseState, backup, barriers } = fixture;
  await verifyReleaseTree({ archivePath: candidate.archive, directory: app });
  assert.equal(await fs.readFile(path.join(app, '.release-sha256'), 'utf8'), `${candidate.sha}\n`);
  assert.equal(await fs.readFile(path.join(app, '.env.staging'), 'utf8'), 'APP_PORT=3001\n');
  assert.equal(await fs.readFile(path.join(app, '.staging-release.lock'), 'utf8'), '');
  for (const name of payloadNames) await protectedEntry(path.join(app, name), 'file', 0o444);
  for (const directory of ['', 'backups', 'rollbacks', 'rollbacks/releases']) {
    await protectedEntry(path.join(app, directory), 'directory', 0o700);
  }
  for (const file of ['.env.staging', '.release-sha256', '.staging-release.lock', `backups/${backup}`]) {
    await protectedEntry(path.join(app, file), 'file', 0o600);
  }
  assert.equal(await fs.readFile(path.join(app, 'backups', backup), 'utf8'), 'synthetic-lock-fixture-backup\n');
  const store = path.join(app, 'rollbacks/releases');
  const expectedNames = [];
  for (const release of [current, candidate]) {
    const name = `release-${release.sha}.tar.gz`;
    expectedNames.push(name, `${name}.sha256`);
    await protectedEntry(path.join(store, name), 'file', 0o600);
    await protectedEntry(path.join(store, `${name}.sha256`), 'file', 0o600);
    assert.equal(digest(await fs.readFile(path.join(store, name))), release.sha);
    assert.equal(await fs.readFile(path.join(store, `${name}.sha256`), 'utf8'), `${release.sha}\n`);
    await verifyReleaseTree({ archivePath: path.join(store, name), directory: release.source });
  }
  assert.deepEqual((await fs.readdir(store)).sort(), expectedNames.sort());
  assert.deepEqual(await fs.readdir(path.join(app, 'rollbacks')), ['releases']);
  assert.deepEqual(await fs.readdir(path.join(app, 'backups')), [backup]);
  assert.deepEqual(await fs.readdir(barriers), []);
  assert.equal(await exists(path.join(app, '.staging-recovery-required')), false);
  assert.equal(await exists(path.join(root, 'host-operation.lock')), false);
  assert.equal(await exists(releaseState), false);
  assert.equal(await fs.readFile(imageState, 'utf8'), `${factories.candidateImageId}\n`);
  assert.equal(await fs.readFile(containerState, 'utf8'), `${factories.candidateImageId}\n`);
  return { activeTree: 'candidate', archivePairs: 2, image: 'candidate', container: 'candidate',
    temporaryRelease: 'absent', transactionResidue: 'absent', protectedMetadata: 'verified' };
}

export function barrierVerdict(row) {
  if (row.tree === 'present' && !row.deadlineReached) return 'barrier-reached';
  if (row.exited || row.closed || !row.deadlineReached) {
    return row.maintenanceRefusal ? 'environment-refusal' : 'exited-before-barrier';
  }
  return row.elapsedMs >= treeBoundMs && row.lastPhase === 'config-json-complete'
    && row.upCount === 'missing' && row.tree === 'absent'
    && row.stdoutBytes === 0 && row.stderrBytes === 0
    ? 'matching-original-timeout' : 'other-timeout';
}

export function diagnosticExitStatus(verdict, child) {
  if (Number.isInteger(child.status) && child.status > 0 && child.status <= 255) return child.status;
  if (child.signal && os.constants.signals[child.signal]) return 128 + os.constants.signals[child.signal];
  if (child.status === 0 && verdict !== 'barrier-reached') return 1;
  if (!child.closed) return 124;
  return child.status === 0 && verdict === 'barrier-reached' ? 0 : 1;
}

export function requireChildSuccess(child) {
  const status = diagnosticExitStatus('barrier-reached', child);
  if (status !== 0) throw Object.assign(new Error('diagnostic child failed'), { status });
}

export function startChild(command, args, environment) {
  const handle = { startedAt: performance.now(), exited: false, closed: false, status: null, signal: null,
    stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), stdoutBytes: 0, stderrBytes: 0, overflow: false };
  const child = spawn(command, args, { cwd: repo, env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
  handle.child = child;
  for (const stream of ['stdout', 'stderr']) {
    child[stream].on('data', (chunk) => {
      handle[`${stream}Bytes`] += chunk.length;
      const remaining = 64 * 1024 - handle[stream].length;
      handle[stream] = Buffer.concat([handle[stream], chunk.subarray(0, Math.max(0, remaining))]);
      if (handle[`${stream}Bytes`] > 64 * 1024) handle.overflow = true;
    });
  }
  child.once('error', () => { handle.spawnError = true; });
  // Descendants can retain inherited pipes after this process has already failed.
  child.once('exit', (status, signal) => { Object.assign(handle, { exited: true, status, signal }); });
  handle.done = new Promise((resolve) => child.once('close', (status, signal) => {
    Object.assign(handle, { closed: true, status, signal });
    resolve(handle);
  }));
  return handle;
}

async function waitClosed(handle, milliseconds) {
  let timer;
  try {
    return await Promise.race([handle.done.then(() => true),
      new Promise((resolve) => { timer = setTimeout(() => resolve(false), milliseconds); })]);
  } finally { clearTimeout(timer); }
}

async function boundedText(file, accepts) {
  let opened;
  try {
    opened = await fs.open(file, 'r');
    const buffer = Buffer.alloc(128);
    const { bytesRead } = await opened.read(buffer, 0, buffer.length, 0);
    const value = buffer.subarray(0, bytesRead).toString('utf8').trim();
    return bytesRead < 128 && accepts(value) ? value : 'unavailable';
  } catch (error) { return error.code === 'ENOENT' ? 'missing' : 'unavailable'; }
  finally { await opened?.close().catch(() => {}); }
}

async function barrierSnapshot(fixture, handle, deadlineReached) {
  const { barriers, factories } = fixture;
  const [lastPhase, upCount, tree] = await Promise.all([
    boundedText(path.join(barriers, 'phase-tree'), (value) => factories.lockFixturePhases.has(value)),
    boundedText(path.join(barriers, 'up-count'), (value) => /^\d{1,6}$/.test(value)),
    exists(path.join(barriers, 'tree')).then((present) => present ? 'present' : 'absent'),
  ]);
  // Only this fixed source literal can leave the private stream buffer.
  const maintenanceRefusal = handle.stderr.toString('utf8').split(/\r?\n/)
    .includes('staging maintenance exclusive lock is not held');
  return { elapsedMs: Math.round(performance.now() - handle.startedAt), lastPhase, upCount, tree,
    stdoutBytes: handle.stdoutBytes, stderrBytes: handle.stderrBytes,
    exited: handle.exited, closed: handle.closed, status: handle.status, signal: handle.signal,
    deadlineReached, maintenanceRefusal };
}

export async function observeTreeBarrier(fixture, handle) {
  const deadline = handle.startedAt + treeBoundMs;
  let nextProgress = handle.startedAt + 25_000;
  let deadlineReached = false;
  while (true) {
    if (handle.exited || handle.spawnError) break;
    if (performance.now() >= deadline) { deadlineReached = true; break; }
    if (await exists(path.join(fixture.barriers, 'tree')) || handle.exited || handle.closed || handle.overflow) break;
    if (performance.now() >= nextProgress) {
      report({ event: 'rollback-progress', elapsedMs: Math.round(performance.now() - handle.startedAt) });
      nextProgress += 25_000;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const snapshot = await barrierSnapshot(fixture, handle, deadlineReached);
  return { verdict: handle.overflow ? 'output-limit' : barrierVerdict(snapshot), ...snapshot };
}

async function installFixture(fixture) {
  const { root, bin, factories, environment } = fixture;
  assert.equal(path.resolve(process.cwd()), path.resolve(repo));
  const prepared = await factories.prepareInstaller(root, bin);
  const helperRoot = path.join(root, 'helpers');
  const helperLinks = path.join(root, 'sbin');
  const installer = startChild(path.join(prepared.nodeDirectory, 'node'), [
    path.join(root, 'helper-installer-source/staging-helper-bundle.js'), 'install',
    path.join(root, 'helper-installer-source'), helperRoot, helperLinks,
  ], { ...environment, PATH: `${prepared.nodeDirectory}:${environment.PATH}` });
  await waitClosed(installer, 40_000);
  report({ event: 'installer', elapsedMs: Math.round(performance.now() - installer.startedAt),
    status: installer.status, signal: installer.signal, stdoutBytes: installer.stdoutBytes, stderrBytes: installer.stderrBytes });
  requireChildSuccess(installer);
  assert.equal(installer.stderrBytes, 0);
  assert.equal(installer.overflow, false);
  const bundleDigest = /staging_helper_bundle_sha256=([a-f0-9]{64})/.exec(installer.stdout.toString('utf8'))?.[1];
  assert.ok(bundleDigest);
  assert.equal(await fs.readFile(path.join(helperRoot, 'current'), 'utf8'), `${bundleDigest}\n`);
  const generation = path.join(helperRoot, 'generations', bundleDigest);
  await verifyInstalledHelperGeneration({ generationDirectory: generation, expectedDigest: bundleDigest });
  for (const name of HELPER_BUNDLE_FILES) {
    if (name === 'staging-helper-bundle.js') continue; // original fixture's one trusted-PATH binding
    assert.deepEqual(await fs.readFile(path.join(generation, name)), await fs.readFile(path.join(repo, 'scripts', name)));
  }
  const authorities = await fs.readdir(path.join(helperRoot, 'node-authorities'));
  assert.equal(authorities.length, 1);
  const installedNode = path.join(helperRoot, 'node-authorities', authorities[0], 'node');
  assert.equal(await fs.realpath(installedNode), installedNode);
  const installedIdentity = await fs.lstat(installedNode);
  const source = path.join(prepared.nodeDirectory, 'node');
  const sourceIdentity = await fs.lstat(source);
  assert.notEqual(`${sourceIdentity.dev}:${sourceIdentity.ino}`, `${installedIdentity.dev}:${installedIdentity.ino}`);
  assert.equal(digest(await fs.readFile(installedNode)), digest(await fs.readFile(source)));
  // This independent installer input is owned by our new fixture, no longer in use.
  // Removing one119MiB copy leaves the original three64MiB disk reservations possible.
  assert.equal(path.dirname(source), path.join(root, 'node-authority'));
  await fs.unlink(source);
  await fs.rmdir(prepared.nodeDirectory);
  const launcher = path.join(helperLinks, 'easyboost-staging-rollback');
  assert.ok((await fs.stat(launcher)).isFile());
  return { launcher, bundleDigest };
}

async function proveDockerBoundary(fixture) {
  const { bin, environment, factories, current, candidate } = fixture;
  for (const [args, status, expected] of [
    [['image', 'inspect', '--format', '{{.Id}}', 'easyboost-staging-app:local'], 0, `${factories.candidateImageId}\n`],
    [['inspect', '--format', '{{.Image}}', 'fake-container'], 0, `${factories.candidateImageId}\n`],
    ...[current, candidate].map((release) => [['image', 'inspect', '--format', '{{.Id}}',
      `easyboost-staging-app:release-${release.sha}`], 1, '']),
  ]) {
    const child = startChild(path.join(bin, 'docker'), args, environment);
    assert.equal(await waitClosed(child, 3000), true);
    assert.equal(child.status, status);
    assert.equal(child.stdout.toString('utf8'), expected);
    assert.equal(child.stderrBytes, 0);
  }
}

async function attempt() {
  const startedAt = performance.now();
  let stage = 'prepare';
  let fixture;
  let handle;
  // A hard outer lifetime belongs to this disposable diagnostic process only.
  // Never signal an unproven descendant or recursively remove an active fixture.
  const watchdog = setTimeout(() => {
    report({ event: 'outer-deadline', stage, status: 124, fixtureRetained: true });
    process.exit(124);
  }, 210_000);
  try {
    fixture = await prepareFixture(await fs.mkdtemp(`/tmp/${fixturePrefix}`));
    stage = 'install';
    const installed = await installFixture(fixture);
    stage = 'equivalence';
    const equivalence = await verifyFixture(fixture);
    await proveDockerBoundary(fixture);
    report({ event: 'equivalence', ...equivalence, installedGeneration: 'verified',
      elapsedMs: Math.round(performance.now() - startedAt) });
    stage = 'rollback';
    await fs.writeFile(path.join(fixture.barriers, 'phase-tree'), 'child-started\n', { mode: 0o600 });
    handle = startChild('/bin/bash', [installed.launcher, fixture.current.sha,
      'immutable-archive-v4', installed.bundleDigest], { ...fixture.environment, BLOCK_AT: 'tree' });
    report({ event: 'rollback-start', elapsedMs: 0, treeBoundMs });
    const snapshot = await observeTreeBarrier(fixture, handle);
    const { verdict } = snapshot;
    report({ event: 'tree-barrier', ...snapshot });
    stage = 'settlement';
    // Release this fixed fixture barrier even if the120s assertion failed first.
    await fs.writeFile(path.join(fixture.barriers, 'release-tree'), 'go\n', { mode: 0o600 });
    const beforeSettlement = performance.now();
    const closed = await waitClosed(handle, 30_000);
    report({ event: 'settlement', closed, status: handle.status, signal: handle.signal,
      elapsedMs: Math.round(performance.now() - beforeSettlement),
      sinceRollbackMs: Math.round(performance.now() - handle.startedAt), fixtureRetained: true,
      cleanup: 'disposable-container-lifecycle', descendantsProven: closed && handle.status === 0 });
    // Retain private bounded evidence until the outer container stops, even on failure.
    await fs.writeFile(path.join(fixture.root, 'rollback-stdout'), handle.stdout, { mode: 0o600 });
    await fs.writeFile(path.join(fixture.root, 'rollback-stderr'), handle.stderr, { mode: 0o600 });
    return diagnosticExitStatus(verdict, handle);
  } catch (error) {
    const status = Number.isInteger(error.status) && error.status > 0 && error.status <= 255
      ? error.status : handle ? diagnosticExitStatus('observation-error', handle) : 1;
    report({ event: 'setup-or-observation-error', stage, status, fixtureRetained: Boolean(fixture),
      childClosed: handle?.closed ?? null });
    return status;
  } finally { clearTimeout(watchdog); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2) {
    report({ event: 'invalid-invocation', status: 64 });
    process.exitCode = 64;
  } else if (process.platform !== 'linux') {
    report({ event: 'linux-required', status: 69 });
    process.exitCode = 69;
  } else {
    // The command is intended only inside the documented disposable container.
    // Explicit exit ends the harness if production settlement could not finish.
    process.exit(await attempt());
  }
}
