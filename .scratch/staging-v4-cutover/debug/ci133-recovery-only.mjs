// DIAGNOSTIC ONLY: real failed deploy/recovery from a verified post-rollback fixture.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { constants, writeSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareFixture, verifyFixture, startChild, requireChildSuccess } from './ci126-rollback-only.mjs';
import { extractReleaseArchive, verifyReleaseTree } from '../../../scripts/staging-release-archive.js';
import { HELPER_BUNDLE_FILES, verifyInstalledHelperGeneration } from '../../../scripts/staging-helper-bundle.js';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const currentFiles = ['.dockerignore', 'Dockerfile', 'compose.staging.yml', 'current.txt'];
const directories = ['', 'backups', 'rollbacks', 'rollbacks/releases'];
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const captures = new WeakMap();
const nodeIdentity = (stat) => [stat.dev, stat.ino, stat.mode, stat.uid, stat.gid,
  stat.isDirectory() ? '' : stat.nlink].join(':');
const recoveryBoundMs = 120_000;
const expectedDiagnostic = 'Primary staging deploy failed with status 1; verified prior state restored';
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function report(row) {
  const line = JSON.stringify(row);
  assert.ok(Buffer.byteLength(line) <= 2048);
  writeSync(1, `${line}\n`);
}

async function entry(file, directory, mode) {
  const stat = await fs.lstat(file);
  assert.ok(!stat.isSymbolicLink() && (directory ? stat.isDirectory() : stat.isFile()));
  if (!directory) assert.equal(stat.nlink, 1);
  if (process.platform === 'linux') {
    assert.equal(stat.uid, process.getuid());
    assert.equal(stat.mode & 0o7777, mode);
  }
  return nodeIdentity(stat);
}

async function absent(file) {
  await assert.rejects(fs.lstat(file), { code: 'ENOENT' });
}

export async function prepareRecoveryFixture(root) {
  const fixture = await prepareFixture(root);
  await verifyFixture(fixture); // Verify the reused candidate preparation before transforming it.
  const extracted = path.join(root, 'recovery-current');
  await extractReleaseArchive({ archivePath: fixture.current.archive, destination: extracted });
  for (const name of ['.dockerignore', 'Dockerfile', 'compose.staging.yml', 'candidate.txt']) {
    const file = path.join(fixture.app, name);
    await entry(file, false, 0o444);
    await fs.chmod(file, 0o600);
    await fs.unlink(file);
  }
  for (const name of currentFiles) {
    await fs.rename(path.join(extracted, name), path.join(fixture.app, name));
    await fs.chmod(path.join(fixture.app, name), 0o444);
  }
  await fs.rmdir(extracted);
  await fs.writeFile(path.join(fixture.app, '.release-sha256'), `${fixture.current.sha}\n`);
  for (const file of [fixture.imageState, fixture.containerState]) {
    await fs.writeFile(file, `${fixture.factories.previousImageId}\n`);
  }
  await fs.writeFile(path.join(fixture.barriers, 'tree'), '', { mode: 0o600 });
  await fs.writeFile(path.join(fixture.barriers, 'release-tree'), 'go\n', { mode: 0o600 });
  await fs.writeFile(path.join(fixture.barriers, 'phase-tree'), 'config-json-complete\n', { mode: 0o600 });
  // Exact original failed-readiness behavior; rollback-only's always-ready curl is unsuitable.
  await fs.writeFile(path.join(fixture.bin, 'curl'), `#!/bin/bash
set -eu
count=0; [ ! -f "$BARRIER_DIR/curl-count" ] || count="$(cat "$BARRIER_DIR/curl-count")"; count=$((count+1)); echo "$count" > "$BARRIER_DIR/curl-count"
if [ "\${FAIL_CANDIDATE_READY:-0}" = 1 ] && grep -Fqx '${fixture.factories.candidateImageId}' "$IMAGE_STATE"; then exit 1; fi
exit 0
`);
  const retained = new Map();
  for (const name of directories) retained.set(name, await entry(path.join(fixture.app, name), true, 0o700));
  for (const name of ['.env.staging', '.staging-release.lock', `backups/${fixture.backup}`]) {
    retained.set(name, await entry(path.join(fixture.app, name), false, 0o600));
  }
  for (const name of await fs.readdir(path.join(fixture.app, 'rollbacks/releases'))) {
    const relative = `rollbacks/releases/${name}`;
    retained.set(relative, await entry(path.join(fixture.app, relative), false, 0o600));
  }
  const prepared = new Map();
  for (const name of [...currentFiles, '.release-sha256']) {
    prepared.set(name, await entry(path.join(fixture.app, name), false, name === '.release-sha256' ? 0o600 : 0o444));
  }
  captures.set(fixture, { retained, prepared, barriers: await entry(fixture.barriers, true, 0o700) });
  return fixture;
}

async function verifyCurrent(fixture, { recovered = false } = {}) {
  const { app, current, candidate, factories, root, imageState, containerState, releaseState } = fixture;
  assert.equal(nodeIdentity(await fs.lstat(root)), nodeIdentity(fixture.identity));
  const retained = captures.get(fixture)?.retained;
  assert.ok(retained, 'fixture must have independently captured retained metadata');
  await verifyReleaseTree({ archivePath: current.archive, directory: app });
  for (const name of currentFiles) await entry(path.join(app, name), false, recovered ? 0o644 : 0o444);
  assert.deepEqual((await fs.readdir(app)).sort(), [...currentFiles, '.env.staging', '.release-sha256',
    '.staging-release.lock', 'backups', 'rollbacks'].sort());
  await entry(path.join(app, '.release-sha256'), false, 0o600);
  assert.equal(await fs.readFile(path.join(app, '.release-sha256'), 'utf8'), `${current.sha}\n`);
  assert.equal(await fs.readFile(path.join(app, '.env.staging'), 'utf8'), 'APP_PORT=3001\n');
  assert.equal(await fs.readFile(path.join(app, '.staging-release.lock'), 'utf8'), '');
  for (const [name, identity] of retained) {
    assert.equal(await entry(path.join(app, name), directories.includes(name), directories.includes(name) ? 0o700 : 0o600), identity);
  }
  const expectedStore = [];
  for (const release of [current, candidate]) {
    const name = `release-${release.sha}.tar.gz`;
    expectedStore.push(name, `${name}.sha256`);
    const stored = path.join(app, 'rollbacks/releases', name);
    assert.equal(digest(await fs.readFile(stored)), release.sha);
    assert.equal(await fs.readFile(`${stored}.sha256`, 'utf8'), `${release.sha}\n`);
    await verifyReleaseTree({ archivePath: stored, directory: release.source });
  }
  assert.deepEqual((await fs.readdir(path.join(app, 'rollbacks/releases'))).sort(), expectedStore.sort());
  assert.deepEqual(await fs.readdir(path.join(app, 'rollbacks')), ['releases']);
  const backups = await fs.readdir(path.join(app, 'backups'));
  assert.equal(backups.length, recovered ? 2 : 1);
  for (const name of backups) {
    assert.match(name, new RegExp(`^easyboost-staging-[0-9]{8}T[0-9]{6}Z-${candidate.sha.slice(0, 12)}-[0-9]+\\.dump$`, 'u'));
    await entry(path.join(app, 'backups', name), false, 0o600);
    assert.equal(await fs.readFile(path.join(app, 'backups', name), 'utf8'), 'synthetic-lock-fixture-backup\n');
  }
  await absent(releaseState);
  for (const name of await fs.readdir(root)) assert.ok(!name.startsWith('host-operation.lock'), 'host-operation residue');
  await entry(imageState, false, 0o600);
  await entry(containerState, false, 0o600);
  assert.equal(await fs.readFile(imageState, 'utf8'), `${factories.previousImageId}\n`);
  assert.equal(await fs.readFile(containerState, 'utf8'), `${factories.previousImageId}\n`);
  return { activeTree: 'current', archivePairs: 2, image: 'current', container: 'current',
    temporaryRelease: 'absent', transactionResidue: 'absent', protectedMetadata: 'verified' };
}

export async function verifyPreparedRecovery(fixture) {
  const state = await verifyCurrent(fixture);
  for (const [name, identity] of captures.get(fixture).prepared) {
    assert.equal(await entry(path.join(fixture.app, name), false, name === '.release-sha256' ? 0o600 : 0o444), identity);
  }
  assert.equal(await entry(fixture.barriers, true, 0o700), captures.get(fixture).barriers);
  assert.deepEqual((await fs.readdir(fixture.barriers)).sort(), ['phase-tree', 'release-tree', 'tree']);
  assert.equal(await fs.readFile(path.join(fixture.barriers, 'tree'), 'utf8'), '');
  assert.equal(await fs.readFile(path.join(fixture.barriers, 'release-tree'), 'utf8'), 'go\n');
  assert.equal(await fs.readFile(path.join(fixture.barriers, 'phase-tree'), 'utf8'), 'config-json-complete\n');
  return { ...state, counters: 'absent', staleTree: 'retained', recovery: 'absent',
    omittedHistory: 'build-markers-and-compose-log;fresh-supervisor-control-roots' };
}

async function boundedValue(file, accepts) {
  let opened;
  try {
    const before = await fs.lstat(file);
    assert.ok(before.isFile() && !before.isSymbolicLink() && before.nlink === 1 && before.size < 128);
    opened = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    assert.equal(nodeIdentity(await opened.stat()), nodeIdentity(before));
    const buffer = Buffer.alloc(128);
    const { bytesRead } = await opened.read(buffer, 0, 128, 0);
    const value = buffer.subarray(0, bytesRead).toString('utf8').trim();
    assert.ok(bytesRead < 128 && accepts(value));
    const after = await opened.stat();
    assert.equal(nodeIdentity(after), nodeIdentity(before));
    assert.equal(after.mtimeMs, before.mtimeMs);
    return { value, mtimeMs: after.mtimeMs };
  } catch (error) {
    return { value: error.code === 'ENOENT' ? 'missing' : 'unavailable', mtimeMs: null };
  } finally { await opened?.close().catch(() => {}); }
}

async function barrierState(fixture, name) {
  try {
    const stat = await fs.lstat(path.join(fixture.barriers, name));
    assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size === 0);
    if (process.platform === 'linux') assert.equal(stat.uid, process.getuid());
    return 'present';
  } catch (error) { return error.code === 'ENOENT' ? 'absent' : 'unavailable'; }
}

async function snapshot(fixture, handle) {
  const [phase, count, barrier, staleTree] = await Promise.all([
    boundedValue(path.join(fixture.barriers, 'phase-recovery'), (value) => fixture.factories.lockFixturePhases.has(value)),
    boundedValue(path.join(fixture.barriers, 'up-count'), (value) => /^\d{1,6}$/u.test(value)),
    barrierState(fixture, 'recovery'), barrierState(fixture, 'tree'),
  ]);
  return { elapsedMs: Math.round(performance.now() - handle.startedAt), lastPhase: phase.value,
    upCount: count.value, recovery: barrier, staleTree,
    stdoutBytes: handle.stdoutBytes, stderrBytes: handle.stderrBytes, exited: handle.exited,
    closed: handle.closed, status: handle.status, signal: handle.signal };
}

async function releaseRecoveryBarrier(fixture) {
  assert.equal(nodeIdentity(await fs.lstat(fixture.root)), nodeIdentity(fixture.identity));
  assert.equal(await entry(fixture.barriers, true, 0o700), captures.get(fixture).barriers);
  assert.equal(await barrierState(fixture, 'recovery'), 'present');
  await fs.writeFile(path.join(fixture.barriers, 'release-recovery'), 'go\n', { flag: 'wx', mode: 0o600 });
}

// This is the actual CLI observation, evidence publication and result seam.
// Short budgets and a local byte writer exist only for finite module contracts.
export async function finishRecoveryAttempt(fixture, handle, {
  barrierTimeoutMs = recoveryBoundMs, settlementTimeoutMs = 150_000, proofTimeoutMs = 3000, emit = report,
} = {}) {
  let outputFailed = false;
  const publish = (row) => { try { emit(row); } catch { outputFailed = true; } };
  let observationFailed = false;
  let released = false;
  let firstBarrierElapsedMs = null;
  let nextSample = 0;
  let previousPhase;
  let previousMtime;
  let omittedCount = 0;
  const rows = [];
  async function sample() {
    if (performance.now() < nextSample) return;
    const phase = await boundedValue(path.join(fixture.barriers, 'phase-recovery'),
      (value) => fixture.factories.lockFixturePhases.has(value));
    const elapsedMs = Math.round(performance.now() - handle.startedAt);
    nextSample = performance.now() + 500;
    if (fixture.factories.lockFixturePhases.has(phase.value)
      && (phase.value !== previousPhase || phase.mtimeMs !== previousMtime)) {
      if (rows.length < 16) rows.push({ elapsedMs, phase: phase.value });
      else omittedCount += 1;
      previousPhase = phase.value;
      previousMtime = phase.mtimeMs;
    }
  }
  const deadline = handle.startedAt + barrierTimeoutMs;
  let deadlineReached = false;
  let reached = false;
  let nextProgress = handle.startedAt + 25_000;
  while (true) {
    const barrier = await barrierState(fixture, 'recovery');
    const now = performance.now();
    if (now >= deadline) { deadlineReached = true; break; }
    if (barrier === 'present') { reached = true; firstBarrierElapsedMs = Math.round(now - handle.startedAt); break; }
    if (handle.exited || handle.closed || handle.spawnError || handle.overflow) break;
    if (now >= nextProgress) {
      publish({ event: 'recovery-progress', elapsedMs: Math.round(now - handle.startedAt) });
      nextProgress = now + 25_000;
    }
    await sample();
    await pause(25);
  }
  const initial = Object.freeze({ ...await snapshot(fixture, handle), deadlineReached });
  const maintenanceRefusal = handle.stderr.toString('utf8').split(/\r?\n/u)
    .includes('staging maintenance exclusive lock is not held');
  const verdict = handle.overflow ? 'output-limit' : reached ? 'barrier-reached'
    : handle.exited || handle.closed || handle.spawnError ? maintenanceRefusal ? 'environment-refusal' : 'exited-before-barrier'
      : initial.elapsedMs >= recoveryBoundMs && initial.lastPhase === 'config-json-complete'
        && initial.upCount === 'missing' && initial.recovery === 'absent' && initial.staleTree === 'present'
        && initial.stdoutBytes === 3 && initial.stderrBytes === 0 ? 'matching-original-timeout' : 'other-timeout';
  publish({ event: 'recovery-barrier', verdict, ...initial });
  const settlementStarted = performance.now();
  const settlementDeadline = settlementStarted + settlementTimeoutMs;
  do {
    if (!released && await barrierState(fixture, 'recovery') === 'present') {
      firstBarrierElapsedMs ??= Math.round(performance.now() - handle.startedAt);
      try { await releaseRecoveryBarrier(fixture); released = true; }
      catch { observationFailed = true; break; }
    }
    await sample();
    if (handle.closed || performance.now() >= settlementDeadline) break;
    await pause(Math.min(25, Math.max(0, settlementDeadline - performance.now())));
  } while (true);
  const final = await snapshot(fixture, handle);
  const expectedEvidence = !handle.overflow && handle.stderr.toString('utf8').split(/\r?\n/u).includes(expectedDiagnostic);
  let finalState = 'not-proven';
  let auxiliary = null;
  if (handle.closed && handle.status === 1 && !handle.signal && expectedEvidence) {
    try {
      await verifyCurrent(fixture, { recovered: true });
      if (process.platform === 'linux') await proveCurrentDocker(fixture, { timeoutMs: proofTimeoutMs, emit: publish });
      finalState = 'verified-current';
    }
    catch (error) { observationFailed = true; auxiliary = error.auxiliary ?? null; }
  }
  let status = !handle.closed || auxiliary?.closed === false ? 124
    : handle.signal ? 128 + (os.constants.signals[handle.signal] ?? 0)
      : Number.isInteger(handle.status) && handle.status > 1 ? handle.status
        : reached && handle.status === 1 && expectedEvidence && finalState === 'verified-current'
          && !observationFailed && !handle.overflow && !handle.spawnError ? 0 : 1;
  publish({ event: 'phase-timeline', intervalMs: 500, rows, omittedCount });
  publish({ event: 'settlement', ...final, sinceRecoveryMs: final.elapsedMs,
    elapsedMs: Math.round(performance.now() - settlementStarted), expectedEvidence, finalState, auxiliary,
    lateRecoveryElapsedMs: reached ? null : firstBarrierElapsedMs, barrierReleased: released,
    fixtureRetained: true, cleanup: 'disposable-environment-lifecycle',
    helperRecoveredAsExpected: handle.closed && handle.status === 1 && expectedEvidence && finalState === 'verified-current' });
  try {
    assert.equal(nodeIdentity(await fs.lstat(fixture.root)), nodeIdentity(fixture.identity));
    for (const stream of ['stdout', 'stderr']) {
      await fs.writeFile(path.join(fixture.root, `recovery-${stream}`), handle[stream], { flag: 'wx', mode: 0o600 });
    }
  } catch { outputFailed = true; }
  status ||= outputFailed ? 1 : 0;
  publish({ event: 'recovery-result', status, outputFailed, fixtureRetained: true });
  return status || (outputFailed ? 1 : 0);
}

async function waitClosed(handle, timeoutMs) {
  let timer;
  try {
    return await Promise.race([handle.done.then(() => true),
      new Promise((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); })]);
  } finally { clearTimeout(timer); }
}

async function requireAuxiliarySettlement(handle, role, timeoutMs, emit) {
  if (await waitClosed(handle, timeoutMs)) return;
  const auxiliary = Object.freeze({ role, exited: handle.exited, closed: false,
    status: handle.status, signal: handle.signal, stdoutBytes: handle.stdoutBytes, stderrBytes: handle.stderrBytes });
  try { emit({ event: 'auxiliary-unsettled', ...auxiliary, fixtureRetained: true }); }
  catch { /* A report error cannot replace unproved settlement or the captured child result. */ }
  throw Object.assign(new Error('diagnostic auxiliary settlement unproved'), { status: 124, auxiliary });
}

// Reduced budgets are finite module contracts only; the CLI retains its fixed40s installer bound.
export async function installRecoveryFixture(fixture, emit = report, { timeoutMs = 40_000 } = {}) {
  assert.equal(process.platform, 'linux');
  assert.equal(path.resolve(process.cwd()), path.resolve(repo));
  await verifyPreparedRecovery(fixture);
  const prepared = await fixture.factories.prepareInstaller(fixture.root, fixture.bin);
  const helperRoot = path.join(fixture.root, 'helpers');
  const links = path.join(fixture.root, 'sbin');
  const source = path.join(prepared.nodeDirectory, 'node');
  const installer = startChild(source, [path.join(fixture.root, 'helper-installer-source/staging-helper-bundle.js'),
    'install', path.join(fixture.root, 'helper-installer-source'), helperRoot, links],
  { ...fixture.environment, PATH: `${prepared.nodeDirectory}:${fixture.environment.PATH}` });
  await requireAuxiliarySettlement(installer, 'installer', timeoutMs, emit);
  // Resolve child failure before reporting; a failed report never replaces its known status.
  requireChildSuccess(installer);
  assert.equal(installer.overflow, false);
  assert.equal(installer.stderrBytes, 0);
  emit({ event: 'installer', elapsedMs: Math.round(performance.now() - installer.startedAt),
    status: installer.status, stdoutBytes: installer.stdoutBytes, stderrBytes: installer.stderrBytes });
  const bundleDigest = /staging_helper_bundle_sha256=([a-f0-9]{64})/u.exec(installer.stdout.toString('utf8'))?.[1];
  assert.ok(bundleDigest);
  assert.equal(await fs.readFile(path.join(helperRoot, 'current'), 'utf8'), `${bundleDigest}\n`);
  const generation = path.join(helperRoot, 'generations', bundleDigest);
  await verifyInstalledHelperGeneration({ generationDirectory: generation, expectedDigest: bundleDigest });
  for (const name of HELPER_BUNDLE_FILES) {
    if (name === 'staging-helper-bundle.js') continue; // The original fixture's trusted command-directory binding.
    assert.deepEqual(await fs.readFile(path.join(generation, name)), await fs.readFile(path.join(repo, 'scripts', name)));
  }
  const authorities = await fs.readdir(path.join(helperRoot, 'node-authorities'));
  assert.equal(authorities.length, 1);
  const installedNode = path.join(helperRoot, 'node-authorities', authorities[0], 'node');
  assert.equal(await fs.realpath(installedNode), installedNode);
  const installedIdentity = await fs.lstat(installedNode);
  const sourceIdentity = await fs.lstat(source);
  assert.notEqual(`${sourceIdentity.dev}:${sourceIdentity.ino}`, `${installedIdentity.dev}:${installedIdentity.ino}`);
  assert.equal(digest(await fs.readFile(installedNode)), digest(await fs.readFile(source)));
  assert.equal(path.dirname(source), path.join(fixture.root, 'node-authority'));
  // This inactive installer copy is private and no longer used; preserve the installed authority.
  await entry(source, false, 0o755);
  await fs.unlink(source);
  await fs.rmdir(prepared.nodeDirectory);
  const launcher = path.join(links, 'easyboost-staging-deploy');
  await entry(launcher, false, 0o555);
  return { launcher, bundleDigest };
}

export async function proveCurrentDocker(fixture, { timeoutMs = 3000, emit = report } = {}) {
  const expected = `${fixture.factories.previousImageId}\n`;
  for (const [args, status, stdout] of [
    [['image', 'inspect', '--format', '{{.Id}}', 'easyboost-staging-app:local'], 0, expected],
    [['inspect', '--format', '{{.Image}}', 'fake-container'], 0, expected],
    ...[fixture.current, fixture.candidate].map((release) => [
      ['image', 'inspect', '--format', '{{.Id}}', `easyboost-staging-app:release-${release.sha}`], 1, '']),
  ]) {
    const child = startChild('/bin/bash', [path.join(fixture.bin, 'docker'), ...args], fixture.environment);
    await requireAuxiliarySettlement(child, 'docker-inspection', timeoutMs, emit);
    assert.equal(child.status, status);
    assert.equal(child.signal, null);
    assert.equal(child.stdout.toString('utf8'), stdout);
    assert.equal(child.stderrBytes, 0);
    assert.equal(child.overflow, false);
  }
}

async function attempt() {
  let stage = 'prepare';
  let fixture;
  let handle;
  const startedAt = performance.now();
  const watchdog = setTimeout(() => {
    try { report({ event: 'outer-deadline', stage, status: 124, fixtureRetained: true,
      childClosed: handle?.closed ?? null, childStatus: handle?.status ?? null, signal: handle?.signal ?? null }); }
    finally { process.exit(124); }
  }, 300_000);
  try {
    fixture = await prepareRecoveryFixture(await fs.mkdtemp('/tmp/easyboost-ci126-rollback-recovery-'));
    stage = 'install';
    const installed = await installRecoveryFixture(fixture);
    stage = 'equivalence';
    const equivalence = await verifyPreparedRecovery(fixture);
    await proveCurrentDocker(fixture);
    report({ event: 'equivalence', ...equivalence, installedGeneration: 'verified',
      elapsedMs: Math.round(performance.now() - startedAt) });
    stage = 'recovery';
    await fs.writeFile(path.join(fixture.barriers, 'phase-recovery'), 'child-started\n', { flag: 'wx', mode: 0o600 });
    handle = startChild('/bin/bash', [installed.launcher, fixture.candidate.archive, fixture.candidate.sha,
      'immutable-archive-v4', installed.bundleDigest],
    { ...fixture.environment, BLOCK_AT: 'recovery', FAIL_CANDIDATE_READY: '1' });
    return await finishRecoveryAttempt(fixture, handle);
  } catch (error) {
    const status = handle && !handle.closed ? 124
      : handle?.signal ? 128 + (os.constants.signals[handle.signal] ?? 0)
        : handle?.status > 0 ? handle.status
          : Number.isInteger(error.status) && error.status > 0 && error.status <= 255 ? error.status : 1;
    try { report({ event: 'setup-or-observation-error', stage, status,
      fixtureRetained: Boolean(fixture), childClosed: handle?.closed ?? null,
      auxiliary: error.auxiliary ?? null }); } catch { /* Preserve status. */ }
    return status;
  } finally { clearTimeout(watchdog); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2) {
    try { report({ event: 'invalid-invocation', status: 64 }); } catch { /* Preserve invocation failure. */ }
    process.exitCode = 64;
  } else if (process.platform !== 'linux') {
    try { report({ event: 'linux-required', status: 69 }); } catch { /* Preserve platform failure. */ }
    process.exitCode = 69;
  } else {
    // Only the dedicated native VM/disposable environment owns remaining descendants.
    process.exit(await attempt());
  }
}
