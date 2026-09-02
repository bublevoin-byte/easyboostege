import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';

import * as supervisorRuntime from '../scripts/staging-command-supervisor.js';

const supervisor = path.resolve('scripts/staging-command-supervisor.js');
const commonShell = path.resolve('scripts/staging-release-common.sh');
const deployShell = path.resolve('scripts/staging-deploy.sh');
const rollbackShell = path.resolve('scripts/staging-rollback.sh');
const restartShell = path.resolve('scripts/staging-restart-app.sh');
const gitBash = process.platform === 'win32'
  ? 'C:\\Program Files\\Git\\bin\\bash.exe'
  : 'bash';
const stableParentStartTime = '731';

function posixPath(value) {
  return value.replace(/^([A-Za-z]):/u, (_, drive) => `/${drive.toLowerCase()}`)
    .replaceAll('\\', '/');
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function groupAlive(pid) {
  try { process.kill(-pid, 0); return true; } catch { return false; }
}

function fakeProcessGroupInspector(processGroupId, readState = () => ({ state: 'alive' })) {
  const identity = Object.freeze({
    leaderStartTime: '991', processGroupId, sessionId: processGroupId,
  });
  return (candidateGroup, expectedIdentity) => {
    assert.equal(candidateGroup, processGroupId);
    if (!expectedIdentity) return { identity, state: 'alive' };
    assert.deepEqual(expectedIdentity, identity);
    return readState();
  };
}

async function waitFor(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail('timed out waiting for supervised process state');
}

test('supervisor propagates a bounded successful command result', () => {
  const result = spawnSync(process.execPath,
    [supervisor, '5', String(process.pid), '--', process.execPath, '-e', 'process.stdout.write("ready")'],
    { encoding: 'utf8', timeout: 10_000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'ready');
});

test('legacy milliseconds CLI remains compatible for its direct parent caller', () => {
  const result = spawnSync(process.execPath, [
    supervisor, '--milliseconds', '5000', String(process.pid), '100', '--',
    process.execPath, '-e', 'process.stdout.write("ready-ms")',
  ], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'ready-ms');
});

test('CLI rejects an explicit parent birth mismatch before starting the command', {
  skip: process.platform === 'win32' ? 'requires Linux /proc process identity' : false,
}, () => {
  const result = spawnSync(process.execPath, [
    supervisor, '5', String(process.pid), '1', '--',
    process.execPath, '-e', 'process.stdout.write("must-not-run")',
  ], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(result.status, 143, result.stderr);
  assert.equal(result.stdout, '');
});

test('leader success rejects after bounded cleanup when its POSIX process group remains alive', async () => {
  const child = new EventEmitter();
  child.pid = 4141;
  let processGroupAlive = true;
  const signals = [];
  const run = supervisorRuntime.runSupervisedCommand({
    command: process.execPath,
    args: ['-e', 'process.exit(0)'],
    timeoutMs: 1_000,
    parentPid: process.pid,
    parentStartTime: stableParentStartTime,
    termGraceMs: 10,
    postKillGraceMs: 20,
    platform: 'linux',
    readProcessStartTime: () => stableParentStartTime,
    inspectProcessGroup: fakeProcessGroupInspector(child.pid,
      () => ({ state: processGroupAlive ? 'alive' : 'absent' })),
    spawnProcess() {
      queueMicrotask(() => child.emit('close', 0, null));
      return child;
    },
    requestPosixSignal(signal) {
      signals.push(signal);
      if (signal === 'SIGTERM') {
        throw Object.assign(new Error('TERM denied'), { code: 'EACCES' });
      }
      if (signal === 'SIGKILL') processGroupAlive = false;
    },
  });

  const failure = await run.then(() => null, (error) => error);
  assert.ok(failure instanceof AggregateError);
  assert.match(failure.message, /leader exited.*descendants remained alive/iu);
  assert.match(failure.errors[0].message, /leader exited.*descendants remained alive/iu);
  assert.match(failure.errors[1].message, /SIGTERM failed.*EACCES/iu);
  assert.deepEqual(signals, [
    'SIGTERM',
    'SIGKILL',
  ]);
});

test('CLI rejects ordinary leader exit until its same-group descendant is terminated', {
  skip: process.platform === 'win32' ? 'requires POSIX process-group signals' : false,
}, async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-supervisor-descendant-exit-'));
  const leaderPidFile = path.join(root, 'leader.pid');
  const descendantPidFile = path.join(root, 'descendant.pid');
  const readyFile = path.join(root, 'descendant.ready');
  const recordedPids = [];
  context.after(async () => {
    if (recordedPids[0]) {
      try { process.kill(-recordedPids[0], 'SIGKILL'); } catch {}
    }
    for (const pid of recordedPids) {
      try { process.kill(pid, 'SIGKILL'); } catch {}
    }
    await fs.rm(root, { recursive: true, force: true });
  });
  const script = [
    `echo $$ > ${JSON.stringify(leaderPidFile)}`,
    `(trap '' TERM; echo ready > ${JSON.stringify(readyFile)}; while :; do sleep 1; done) </dev/null >/dev/null 2>&1 &`,
    `echo $! > ${JSON.stringify(descendantPidFile)}`,
    `while [ ! -s ${JSON.stringify(readyFile)} ]; do :; done`,
    'exit 0',
  ].join('\n');
  const result = spawnSync(process.execPath, [
    supervisor, '--milliseconds', '1000', String(process.pid), '100',
    '--', 'sh', '-c', script,
  ], { encoding: 'utf8', timeout: 5_000 });

  assert.equal(result.status, 127, result.stderr);
  assert.match(result.stderr, /leader exited.*descendants remained alive/iu);
  recordedPids.push(
    Number(await fs.readFile(leaderPidFile, 'utf8')),
    Number(await fs.readFile(descendantPidFile, 'utf8')),
  );
  await waitFor(() => !groupAlive(recordedPids[0]));
});

test('process-group authority distinguishes absence, EPERM-alive and indeterminate probe errors', () => {
  assert.equal(typeof supervisorRuntime.probeProcessGroup, 'function');
  const probe = (code) => supervisorRuntime.probeProcessGroup(42, {
    platform: 'linux',
    signalProcess() {
      if (code) throw Object.assign(new Error(code), { code });
    },
  });
  assert.deepEqual(probe(), { state: 'alive' });
  assert.deepEqual(probe('ESRCH'), { state: 'absent' });
  assert.deepEqual(probe('EPERM'), { state: 'alive' });
  assert.deepEqual(probe('EIO'), { state: 'unknown', errorCode: 'EIO' });
});

test('POSIX command-group authority revalidates child birth and session before signaling a reused PGID', () => {
  const processGroupId = 4242;
  const identity = Object.freeze({
    leaderStartTime: '777', processGroupId, sessionId: processGroupId,
  });
  let inspection = 0;
  const signals = [];
  const authority = supervisorRuntime.createPosixProcessGroupAuthority(processGroupId, {
    inspectProcessGroup(candidateGroup, expectedIdentity) {
      assert.equal(candidateGroup, processGroupId);
      inspection += 1;
      if (!expectedIdentity) return { identity, state: 'alive' };
      assert.deepEqual(expectedIdentity, identity);
      return inspection === 2 ? { state: 'alive' } : { state: 'reused' };
    },
    requestSignal(signal) { signals.push(signal); },
  });

  assert.throws(() => authority.signal('SIGTERM'), (error) => error?.code === 'ESRCH');
  assert.equal(inspection, 3, 'capture plus two boundary revalidations are required');
  assert.deepEqual(signals, [], 'a reused PGID must receive no foreign signal');
});

test('supervisor treats a reused child PGID as original-group absence without foreign signals', async () => {
  const child = new EventEmitter();
  child.pid = 4342;
  const signals = [];
  const status = await supervisorRuntime.runSupervisedCommand({
    command: process.execPath,
    args: ['-e', 'process.exit(0)'],
    timeoutMs: 1_000,
    parentPid: process.pid,
    parentStartTime: stableParentStartTime,
    platform: 'linux',
    readProcessStartTime: () => stableParentStartTime,
    inspectProcessGroup: fakeProcessGroupInspector(child.pid, () => ({ state: 'reused' })),
    spawnProcess() {
      queueMicrotask(() => child.emit('close', 0, null));
      return child;
    },
    requestPosixSignal(signal) { signals.push(signal); },
  });
  assert.equal(status, 0);
  assert.deepEqual(signals, []);
});

test('Linux process birth parser uses field 22 after the complete comm boundary', () => {
  const stat = '42 (worker ) name) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 987654 20';
  assert.equal(supervisorRuntime.readLinuxProcessStartTime(42, {
    readFile: () => stat,
  }), '987654');
});

test('Linux residual group inspection preserves the captured session and rejects reuse', () => {
  const processGroupId = 42;
  const expectedIdentity = Object.freeze({
    leaderStartTime: '777', processGroupId, sessionId: processGroupId,
  });
  const stat = (pid, group, session, startTime) => [
    `${pid} (worker ) name) S 1 ${group} ${session}`,
    '4 5 6 7 8 9 10 11 12 13 14 15 16 17 18',
    `${startTime} 20`,
  ].join(' ');
  const missingLeader = (candidatePath) => {
    if (candidatePath === `/proc/${processGroupId}/stat`) {
      throw Object.assign(new Error('gone'), { code: 'ENOENT' });
    }
    if (candidatePath === '/proc/43/stat') return stat(43, processGroupId, processGroupId, '778');
    throw Object.assign(new Error('gone'), { code: 'ENOENT' });
  };
  const originalResidual = supervisorRuntime.inspectLinuxProcessGroup(
    processGroupId,
    expectedIdentity,
    { readDirectory: () => ['42', '43'], readFile: missingLeader },
  );
  assert.deepEqual(originalResidual, { state: 'alive' });

  const mixedSessionScan = supervisorRuntime.inspectLinuxProcessGroup(
    processGroupId,
    expectedIdentity,
    {
      readDirectory: () => ['42', '43', '44'],
      readFile(candidatePath) {
        if (candidatePath === `/proc/${processGroupId}/stat`) {
          throw Object.assign(new Error('gone'), { code: 'ENOENT' });
        }
        if (candidatePath === '/proc/43/stat') {
          return stat(43, processGroupId, processGroupId, '778');
        }
        return stat(44, processGroupId, 99, '779');
      },
    },
  );
  assert.equal(mixedSessionScan.state, 'unknown',
    'a torn scan across original and reused sessions must never authorize a group signal');
  assert.ok(mixedSessionScan.error instanceof Error);

  const reusedLeader = supervisorRuntime.inspectLinuxProcessGroup(
    processGroupId,
    expectedIdentity,
    { readDirectory: () => [], readFile: () => stat(42, 42, 42, '999') },
  );
  assert.deepEqual(reusedLeader, { state: 'reused' });
});

test('supervisor fails closed before spawn when the parent PID birth does not match', async () => {
  let spawnCalls = 0;
  const child = new EventEmitter();
  child.pid = 4444;
  const status = await supervisorRuntime.runSupervisedCommand({
    command: process.execPath,
    args: ['-e', 'process.exit(0)'],
    timeoutMs: 250,
    parentPid: 73,
    parentStartTime: stableParentStartTime,
    platform: 'linux',
    readProcessStartTime: () => '732',
    spawnProcess() {
      spawnCalls += 1;
      queueMicrotask(() => child.emit('close', 0, null));
      return child;
    },
    signalProcess(pid, signal) {
      if (pid < 0 && signal === 0) {
        throw Object.assign(new Error('group absent'), { code: 'ESRCH' });
      }
    },
  });
  assert.deepEqual({ spawnCalls, status }, { spawnCalls: 0, status: 143 });
});

test('supervisor terminates the command when a live parent PID is reused', async () => {
  const child = new EventEmitter();
  child.pid = 4545;
  let identityReads = 0;
  let groupPresent = true;
  const signals = [];
  const status = await supervisorRuntime.runSupervisedCommand({
    command: process.execPath,
    args: ['-e', 'setInterval(() => {}, 1000)'],
    timeoutMs: 250,
    parentPid: 73,
    parentStartTime: stableParentStartTime,
    termGraceMs: 10,
    platform: 'linux',
    readProcessStartTime() {
      identityReads += 1;
      return identityReads === 1 ? stableParentStartTime : '732';
    },
    inspectProcessGroup: fakeProcessGroupInspector(child.pid,
      () => ({ state: groupPresent ? 'alive' : 'absent' })),
    spawnProcess() { return child; },
    requestPosixSignal(signal) {
      signals.push(signal);
      if (signal === 'SIGTERM') {
        groupPresent = false;
        queueMicrotask(() => child.emit('close', null, 'SIGTERM'));
      }
    },
  });
  assert.equal(status, 143);
  assert.ok(identityReads >= 2, 'parent birth identity must be re-read after launch');
  assert.deepEqual(signals, ['SIGTERM']);
});

test('a post-spawn child error settles the owned POSIX session before rejecting', async () => {
  const child = new EventEmitter();
  child.pid = 4646;
  let wrapperClosed = false;
  let wrapperMarked = false;
  let disposed = false;
  const signals = [];
  const control = {
    dispose() { disposed = true; },
    markWrapperSpawned() { wrapperMarked = true; },
    observeWrapperClose() { wrapperClosed = true; },
    proofState() { return { state: wrapperClosed ? 'absent' : 'alive' }; },
    request(signal) {
      signals.push(signal);
      if (signal === 'SIGTERM') queueMicrotask(() => child.emit('close', null, 'SIGTERM'));
    },
    specification: { controlDirectory: '/fixture/staging-post-spawn' },
    targetStatus() { return { exitCode: null, signal: 'SIGTERM', state: 'present' }; },
  };
  const failure = await supervisorRuntime.runSupervisedCommand({
    command: process.execPath,
    args: ['-e', 'setInterval(() => {}, 1000)'],
    timeoutMs: 1_000,
    parentPid: process.pid,
    parentStartTime: stableParentStartTime,
    termGraceMs: 10,
    postKillGraceMs: 20,
    platform: 'linux',
    readProcessStartTime: () => stableParentStartTime,
    forcePosixSession: true,
    posixSessionControl: control,
    posixSessionInvocation(command, args, cwd, settlement, environment, authority) {
      assert.equal(authority, control);
      return { args: [], command: 'fixture-owned-session', posixSessionControl: authority };
    },
    spawnProcess() {
      queueMicrotask(() => child.emit('error', Object.assign(
        new Error('late child error'), { code: 'EIO' },
      )));
      return child;
    },
  }).then(() => null, (error) => error);

  assert.ok(failure instanceof Error);
  assert.match(failure.message, /post-spawn child error.*EIO/iu);
  assert.deepEqual(signals, ['SIGTERM'],
    'a live owned session must settle before a post-spawn error is returned');
  assert.equal(wrapperMarked, true);
  assert.equal(disposed, true, 'exact absence proof permits normal control disposal');
});

test('a pre-PID spawn error rejects without entering process-group settlement', async () => {
  const child = new EventEmitter();
  const signals = [];
  let marked = false;
  let forcedDisposal = false;
  const control = {
    dispose({ force } = {}) { forcedDisposal = force === true; },
    markWrapperSpawned() { marked = true; },
    proofState() { return { state: 'unknown' }; },
    request(signal) { signals.push(signal); },
    specification: { controlDirectory: '/fixture/staging-pre-pid' },
  };
  const failure = await supervisorRuntime.runSupervisedCommand({
    command: 'missing-staging-command',
    args: [],
    timeoutMs: 1_000,
    parentPid: process.pid,
    parentStartTime: stableParentStartTime,
    platform: 'linux',
    readProcessStartTime: () => stableParentStartTime,
    forcePosixSession: true,
    posixSessionControl: control,
    posixSessionInvocation(command, args, cwd, settlement, environment, authority) {
      return { args: [], command: 'fixture-owned-session', posixSessionControl: authority };
    },
    spawnProcess() {
      queueMicrotask(() => child.emit('error', Object.assign(
        new Error('not found'), { code: 'ENOENT' },
      )));
      return child;
    },
  }).then(() => null, (error) => error);

  assert.ok(failure instanceof Error);
  assert.match(failure.message, /could not start.*ENOENT/iu);
  assert.deepEqual(signals, []);
  assert.equal(marked, false);
  assert.equal(forcedDisposal, true, 'only a pre-PID spawn failure may force-dispose control');
});

test('canonical staging shell uses non-exported tokenized deadline transitions',
  async () => {
    const common = await fs.readFile(path.resolve('scripts/staging-release-common.sh'), 'utf8');
    assert.match(common,
      /node "\$command_supervisor_tool" "\$bound" "\$\$" "\$parent_start_time" --/u,
      'run_bounded must pass the release parent birth identity to the Node supervisor');
    assert.match(common,
      /staging_node_executable="\$\{EASYBOOST_STAGING_NODE_COMMAND:-\}"[\s\S]*staging_node_chain_authority="\$\{EASYBOOST_STAGING_NODE_CHAIN_AUTHORITY:-\}"[\s\S]*unset EASYBOOST_STAGING_NODE_COMMAND EASYBOOST_STAGING_NODE_CHAIN_AUTHORITY/u,
      'the release shell must consume both descriptor-backed Node inputs before nesting');
    assert.match(common,
      /node\(\) \{[\s\S]*EASYBOOST_STAGING_NODE_COMMAND="\$staging_node_executable"[\s\S]*EASYBOOST_STAGING_NODE_CHAIN_AUTHORITY="\$staging_node_chain_authority"[\s\S]*"\$staging_node_executable" "\$@"/u,
      'each nested Node helper must receive the validated descriptor chain only for its invocation');
    assert.match(common,
      /if \[ "\$\{1:-\}" = node \]; then\s+shift\s+set -- "\$staging_node_executable" "\$@"/u,
      'run_bounded must replace a bare Node target before entering its fresh shell');
    assert.match(common,
      /deadline_control_environment="\$\{EASYBOOST_STAGING_DEADLINE_CONTROL:-\}"[\s\S]*unset EASYBOOST_STAGING_DEADLINE_CONTROL/u,
      'the inner shell must immediately de-export its private capability');
    assert.match(common,
      /--ready\s+\\\s+"\$TRANSACTION_SECONDS" "\$timeout_ms"/u,
      'main work must wait for the exact READY acknowledgement');
    assert.match(common,
      /request_owned_deadline_transition ROLLOVER\s+\\\s+"\$RECOVERY_SECONDS" "\$next_sequence"/u,
      'recovery must use a monotonic ROLLOVER rather than replacing a watchdog');
    assert.match(common, /request_owned_deadline_transition DISARM 0 "\$next_sequence"/u,
      'host-lock settlement must require a durable DISARM acknowledgement');
  });

test('production staging controllers contain no external numeric POSIX signal authority', async () => {
  const [common, commandSupervisor] = await Promise.all([
    fs.readFile(commonShell, 'utf8'),
    fs.readFile(supervisor, 'utf8'),
  ]);

  for (const externallyReusableTarget of [
    '$parent', '$pid', '$member_pid', '-$deadline_watchdog_pid',
  ]) {
    assert.equal(common.includes(`kill -"$signal" "${externallyReusableTarget}"`), false,
      `staging watchdog must not signal externally reusable target ${externallyReusableTarget}`);
    assert.equal(common.includes(`kill -"$signal" -- "${externallyReusableTarget}"`), false,
      `staging watchdog must not signal externally reusable target ${externallyReusableTarget}`);
  }
  assert.doesNotMatch(commandSupervisor,
    /signalProcess\(-processGroupId,\s*['"]SIG(?:TERM|KILL)['"]/u,
    'the command controller must request termination through an owned-session capability');
});

test('staging launcher places the whole entry inside the owned-session deadline wrapper',
  async () => {
    const [bundle, transaction] = await Promise.all([
      fs.readFile(path.resolve('scripts/staging-helper-bundle.js'), 'utf8'),
      fs.readFile(path.resolve('scripts/staging-transaction-supervisor.js'), 'utf8'),
    ]);
    assert.match(bundle,
      /prepare_current_environment; exec "\$node_bound_executable" "\$generation_root\/staging-transaction-supervisor\.js" --run 1800 600/u,
      'the current authenticated generation must enter through the bound Node transaction wrapper');
    assert.match(bundle,
      /NODE_OPTIONS="--experimental-loader=\$legacy_loader"[\s\S]*exec "\$node_bound_executable" "\$generation_root\/staging-transaction-supervisor\.js" --run 1800 600/u,
      'an authenticated legacy generation and its nested Node helpers must inherit the trusted loader');
    assert.match(bundle,
      /prepare_current_environment\(\) \{[\s\S]*PATH="\$node_directory:/u,
      'both current and legacy nested bare Node commands must resolve through the pinned directory');
    assert.doesNotMatch(bundle, /\$\(stat -L|\$\(id -u/u,
      'pointer authority must use only its fixed absolute stat and id tools');
    const readyProbe = transaction.indexOf('posixSessionControl.readyState()');
    const durableReady = transaction.indexOf('deadlineMailbox.acknowledge(deadlineController.ready())');
    assert.ok(readyProbe >= 0 && durableReady >= 0 && readyProbe < durableReady,
      'owned-session READY proof must precede transaction timer activation and ACK-0');
    assert.doesNotMatch(bundle, /setsid|coproc EASYBOOST_DEADLINE_WATCHDOG/u);
});

test('deadline settlement requires an exact DISARM acknowledgement', () => {
  const script = String.raw`
set -Eeuo pipefail
source "$COMMON_SHELL"
deadline_control_environment=fixture
deadline_control_active=1
deadline_sequence=0
request_owned_deadline_transition() { printf 'REQUEST:%s:%s:%s\n' "$1" "$2" "$3"; }
kill() { printf 'UNSAFE-SIGNAL:%s\n' "$*"; }
stop_deadline_watchdog
printf 'ACTIVE:%s SEQUENCE:%s\n' "$deadline_control_active" "$deadline_sequence"
`;
  const result = spawnSync(gitBash, ['-c', script], {
    encoding: 'utf8',
    env: { ...process.env, COMMON_SHELL: posixPath(commonShell) },
    timeout: 5_000,
  });
  if (result.error?.code === 'ENOENT') return;
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split(/\r?\n/u), [
    'REQUEST:DISARM:0:1',
    'ACTIVE:0 SEQUENCE:1',
  ]);
  assert.doesNotMatch(result.stdout, /UNSAFE-SIGNAL/u);
});

test('a failed DISARM acknowledgement is sticky across repeated stop attempts', () => {
  const script = String.raw`
set -Eeuo pipefail
source "$COMMON_SHELL"
deadline_control_environment=fixture
deadline_control_active=1
deadline_sequence=0
requests=0
request_owned_deadline_transition() { requests=$((requests + 1)); return 1; }
kill() { printf 'UNSAFE-SIGNAL:%s\n' "$*"; }
if stop_deadline_watchdog; then first=0; else first=$?; fi
if stop_deadline_watchdog; then second=0; else second=$?; fi
printf 'FIRST:%s SECOND:%s REQUESTS:%s ACTIVE:%s\n' \
  "$first" "$second" "$requests" "$deadline_control_active"
`;
  const started = Date.now();
  const result = spawnSync(gitBash, ['-c', script], {
    encoding: 'utf8',
    env: { ...process.env, COMMON_SHELL: posixPath(commonShell) },
    timeout: 5_000,
  });
  if (result.error?.code === 'ENOENT') return;
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /UNSAFE-SIGNAL/u);
  assert.equal(result.stdout.trim(), 'FIRST:125 SECOND:125 REQUESTS:1 ACTIVE:1');
  assert.ok(Date.now() - started < 2_000, 'indeterminate group settlement exceeded its bound');
});

test('early deadline cleanup exposes settlement failure instead of preserving success', () => {
  const script = String.raw`
set -uo pipefail
source "$COMMON_SHELL"
stop_deadline_watchdog() { return 125; }
true
stop_early_deadline
`;
  const result = spawnSync(gitBash, ['-c', script], {
    encoding: 'utf8',
    env: { ...process.env, COMMON_SHELL: posixPath(commonShell) },
    timeout: 5_000,
  });
  if (result.error?.code === 'ENOENT') return;
  assert.equal(result.status, 125,
    `failed watchdog settlement was hidden (stdout=${result.stdout}, stderr=${result.stderr})`);
});

test('production EXIT cleanup proves watchdog settlement before releasing the host guard', async () => {
  const script = String.raw`
set -uo pipefail
source "$COMMON_SHELL"
stop_deadline_watchdog() { printf 'STOP-FAILED\n'; return 125; }
release_host_operation_lock() { printf 'UNSAFE-HOST-RELEASE\n'; return 0; }
write_recovery_marker() { printf 'MARKER:%s:%s:%s\n' "$1" "$2" "$3"; }
if settle_deadline_watchdog_and_release_host_lock 0 'staging deadline watchdog settlement was not proven'; then
  status=0
else
  status=$?
fi
printf 'STATUS:%s\n' "$status"
`;
  const result = spawnSync(gitBash, ['-c', script], {
    encoding: 'utf8',
    env: { ...process.env, COMMON_SHELL: posixPath(commonShell) },
    timeout: 5_000,
  });
  if (result.error?.code === 'ENOENT') return;
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split(/\r?\n/u), [
    'STOP-FAILED',
    'MARKER:staging deadline watchdog settlement was not proven:0:125',
    'STATUS:125',
  ]);
  assert.doesNotMatch(result.stdout, /UNSAFE-HOST-RELEASE/u);

  const handlers = [
    ['deploy', await fs.readFile(deployShell, 'utf8'), 'cleanup()'],
    ['rollback', await fs.readFile(rollbackShell, 'utf8'), 'cleanup()'],
    ['restart', await fs.readFile(restartShell, 'utf8'), 'cleanup_restart()'],
  ];
  for (const [name, source, functionName] of handlers) {
    const start = source.indexOf(functionName);
    const end = source.indexOf('\n}\n', start) + 3;
    const handler = source.slice(start, end);
    assert.match(handler, /settle_deadline_watchdog_and_release_host_lock/u,
      `${name} full EXIT cleanup must use fail-closed watchdog settlement`);
    assert.doesNotMatch(handler,
      /release_host_operation_lock[\s\S]*stop_deadline_watchdog/u,
      `${name} full EXIT cleanup must not release the host guard before settlement proof`);

    const variables = name === 'restart'
      ? 'restart_started=0\nrestart_verified=0\n'
      : 'authority_violation=0\nactivation_succeeded=1\ncommit_verified=0\n'
        + 'runtime_recovered=0\nbackup_staging=""\nrelease_finalization_verified=0\n';
    const call = name === 'restart' ? 'cleanup_restart' : 'cleanup';
    const fullHandlerResult = spawnSync(gitBash, ['-c', String.raw`
set +e
${variables}
finalize_release_boundaries() { return 0; }
settle_deadline_watchdog_and_release_host_lock() { return 125; }
release_host_operation_lock() { printf 'UNSAFE-HOST-RELEASE\n'; return 0; }
stop_deadline_watchdog() { return 125; }
${handler}
true
${call}
`], { encoding: 'utf8', timeout: 5_000 });
    assert.equal(fullHandlerResult.status, 125,
      `${name} full EXIT cleanup hid failed watchdog settlement (${fullHandlerResult.stderr})`);
    assert.doesNotMatch(fullHandlerResult.stdout, /UNSAFE-HOST-RELEASE/u);
  }
});

test('recovery watchdog startup failure blocks production recovery and finalization immediately', async () => {
  const handlers = [
    ['deploy', await fs.readFile(deployShell, 'utf8')],
    ['rollback', await fs.readFile(rollbackShell, 'utf8')],
  ];
  for (const [name, source] of handlers) {
    const start = source.indexOf('cleanup()');
    const end = source.indexOf('\n}\ntrap cleanup EXIT', start) + 3;
    const cleanup = source.slice(start, end);
    const script = String.raw`
set +e
authority_violation=0
activation_succeeded=1
stable_promotion_attempted=0
active_release=1
release_transaction_started=0
commit_verified=0
candidate_pair_existed=1
candidate_pair_publication_started=0
backup_staging=''
release_finalization_verified=0
recovery_marker=marker
begin_recovery_deadline() { printf 'BEGIN-FAILED\n'; return 125; }
write_recovery_marker() { printf 'MARKER:%s:%s:%s\n' "$1" "$2" "$3"; return 0; }
finalize_release_boundaries() { printf 'UNSAFE-FINALIZE\n'; return 0; }
settle_deadline_watchdog_and_release_host_lock() { printf 'UNSAFE-HOST-RELEASE\n'; return 0; }
${cleanup}
false
cleanup
`;
    const result = spawnSync(gitBash, ['-c', script], {
      encoding: 'utf8',
      timeout: 5_000,
    });
    if (result.error?.code === 'ENOENT') return;
    assert.equal(result.status, 125,
      `${name} continued without a recovery watchdog (stdout=${result.stdout}, stderr=${result.stderr})`);
    assert.deepEqual(result.stdout.trim().split(/\r?\n/u), [
      'BEGIN-FAILED',
      'MARKER:staging recovery deadline watchdog could not be established:1:125',
    ]);
    assert.doesNotMatch(result.stdout, /UNSAFE-(?:FINALIZE|HOST-RELEASE)/u);
  }
});

test('deadline transitions stop before delivery when prior settlement is unproven', () => {
  const script = String.raw`
set -uo pipefail
source "$COMMON_SHELL"
deadline_watchdog_settlement_unproven=1
deadline_control_active=1
request_owned_deadline_transition() { printf 'UNSAFE-REQUEST\n'; }
if begin_recovery_deadline; then recovery=0; else recovery=$?; fi
if stop_deadline_watchdog; then stop=0; else stop=$?; fi
printf 'RECOVERY:%s STOP:%s\n' "$recovery" "$stop"
`;
  const result = spawnSync(gitBash, ['-c', script], {
    encoding: 'utf8',
    env: { ...process.env, COMMON_SHELL: posixPath(commonShell) },
    timeout: 5_000,
  });
  if (result.error?.code === 'ENOENT') return;
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'RECOVERY:125 STOP:125');
  assert.doesNotMatch(result.stdout, /UNSAFE-REQUEST/u);
});

test('failed deadline settlement retains its exact pending sequence across retries', () => {
  const script = String.raw`
set -uo pipefail
source "$COMMON_SHELL"
deadline_control_environment=fixture-authority
deadline_control_active=1
deadline_sequence=0
requests=0
request_owned_deadline_transition() { requests=$((requests + 1)); return 1; }
if stop_deadline_watchdog; then first=0; else first=$?; fi
if begin_recovery_deadline; then recovery=0; else recovery=$?; fi
if stop_deadline_watchdog; then stop_two=0; else stop_two=$?; fi
printf 'FIRST:%s RECOVERY:%s STOP2:%s REQUESTS:%s ACTIVE:%s SEQUENCE:%s CONTROL:%s\n' \
  "$first" "$recovery" "$stop_two" "$requests" \
  "$deadline_control_active" "$deadline_sequence" "$deadline_control_environment"
`;
  const result = spawnSync(gitBash, ['-c', script], {
    encoding: 'utf8',
    env: { ...process.env, COMMON_SHELL: posixPath(commonShell) },
    timeout: 5_000,
  });
  if (result.error?.code === 'ENOENT') return;
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(),
    'FIRST:125 RECOVERY:125 STOP2:125 REQUESTS:1 ACTIVE:1 SEQUENCE:0 CONTROL:fixture-authority');
});

test('recovery deadline rollover is acknowledged before local deadline state changes', () => {
  const script = String.raw`
set -Eeuo pipefail
source "$COMMON_SHELL"
deadline_control_environment=fixture
deadline_control_active=1
deadline_sequence=0
transaction_deadline=999999
request_owned_deadline_transition() {
  printf 'REQUEST:%s:%s:%s BEFORE:%s\n' "$1" "$2" "$3" "$deadline_sequence"
}
begin_recovery_deadline
printf 'SEQUENCE:%s ACTIVE:%s\n' "$deadline_sequence" "$deadline_control_active"
`;
  const result = spawnSync(gitBash, ['-c', script], {
    encoding: 'utf8',
    env: { ...process.env, COMMON_SHELL: posixPath(commonShell) },
    timeout: 5_000,
  });
  if (result.error?.code === 'ENOENT') return;
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.deepEqual(result.stdout.trim().split(/\r?\n/u), [
    'REQUEST:ROLLOVER:600:1 BEFORE:0',
    'SEQUENCE:1 ACTIVE:1',
  ]);
});

test('missing READY acknowledgement blocks the transaction before main work', () => {
  const script = String.raw`
set -Eeuo pipefail
source "$COMMON_SHELL"
deadline_control_environment=fixture
node() { printf 'READY-CALL:%s\n' "$*"; return 1; }
if begin_transaction_deadline; then status=0; else status=$?; fi
printf 'STATUS:%s UNPROVEN:%s ACTIVE:%s\n' \
  "$status" "$deadline_watchdog_settlement_unproven" "$deadline_control_active"
`;
  const result = spawnSync(gitBash, ['-c', script], {
    encoding: 'utf8',
    env: { ...process.env, COMMON_SHELL: posixPath(commonShell) },
    timeout: 10_000,
  });
  if (result.error?.code === 'ENOENT') return;
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /READY-CALL:[^\n]*--ready 1800 5000/u);
  assert.match(result.stdout, /STATUS:125 UNPROVEN:1 ACTIVE:0/u);
});

test('the deadline capability is not inherited by ordinary child commands', () => {
  const script = String.raw`
set -Eeuo pipefail
EASYBOOST_STAGING_DEADLINE_CONTROL=private-fixture
export EASYBOOST_STAGING_DEADLINE_CONTROL
source "$COMMON_SHELL"
[ "$deadline_control_environment" = private-fixture ]
if /usr/bin/env | /usr/bin/grep -q '^EASYBOOST_STAGING_DEADLINE_CONTROL='; then
  printf 'UNSAFE-INHERITANCE\n'
  exit 99
fi
printf 'captured=private-fixture inherited=absent\n'
`;
  const result = spawnSync(gitBash, ['-c', script], {
    encoding: 'utf8',
    env: { ...process.env, COMMON_SHELL: posixPath(commonShell) },
    timeout: 10_000,
  });
  if (result.error?.code === 'ENOENT') return;
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(result.stdout.trim(), 'captured=private-fixture inherited=absent');
});

test('supervisor reaches an explicit terminal failure when a group survives SIGKILL', async () => {
  const child = new EventEmitter();
  child.pid = 4242;
  const signals = [];
  const started = Date.now();
  await assert.rejects(supervisorRuntime.runSupervisedCommand({
    command: process.execPath,
    args: ['-e', 'process.exit(0)'],
    timeoutMs: 10,
    parentPid: process.pid,
    parentStartTime: stableParentStartTime,
    termGraceMs: 10,
    postKillGraceMs: 20,
    platform: 'linux',
    readProcessStartTime: () => stableParentStartTime,
    inspectProcessGroup: fakeProcessGroupInspector(child.pid),
    spawnProcess() { return child; },
    requestPosixSignal(signal) {
      signals.push(signal);
      if (signal === 'SIGTERM') queueMicrotask(() => child.emit('close', null, 'SIGTERM'));
    },
  }), /process group remained alive after SIGKILL/iu);
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  assert.ok(Date.now() - started < 500, 'post-KILL terminal outcome exceeded its own bound');
});

test('supervisor exposes an indeterminate post-KILL group probe instead of settling success', async () => {
  const child = new EventEmitter();
  child.pid = 4343;
  await assert.rejects(supervisorRuntime.runSupervisedCommand({
    command: process.execPath,
    args: ['-e', 'process.exit(0)'],
    timeoutMs: 10,
    parentPid: process.pid,
    parentStartTime: stableParentStartTime,
    termGraceMs: 10,
    postKillGraceMs: 20,
    platform: 'linux',
    readProcessStartTime: () => stableParentStartTime,
    inspectProcessGroup: fakeProcessGroupInspector(child.pid, () => ({
      error: Object.assign(new Error('probe failed'), { code: 'EIO' }),
      state: 'unknown',
    })),
    spawnProcess() { return child; },
    requestPosixSignal(signal) {
      if (signal === 'SIGTERM') queueMicrotask(() => child.emit('close', null, 'SIGTERM'));
    },
  }), /process group probe.*EIO|could not prove.*process group/iu);
});

test('supervisor bounds and reaps a TERM-ignoring command group', {
  skip: process.platform === 'win32' ? 'requires POSIX process-group signals' : false,
}, async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-supervisor-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const childPid = path.join(root, 'child.pid');
  const grandchildPid = path.join(root, 'grandchild.pid');
  const script = [
    'trap "" TERM',
    `echo $$ > ${JSON.stringify(childPid)}`,
    `(trap "" TERM; echo $$ > ${JSON.stringify(grandchildPid)}; while :; do sleep 1; done) &`,
    'while :; do sleep 1; done',
  ].join('\n');
  const result = spawnSync(process.execPath,
    [supervisor, '1', String(process.pid), '--', 'bash', '-c', script],
    { encoding: 'utf8', timeout: 10_000 });
  assert.equal(result.status, 124, result.stderr);
  const pids = [Number(await fs.readFile(childPid, 'utf8')), Number(await fs.readFile(grandchildPid, 'utf8'))];
  await waitFor(() => pids.every((pid) => !alive(pid)));
});

test('supervisor keeps escalation armed when TERM closes the leader before its descendants', {
  skip: process.platform === 'win32' ? 'requires POSIX process-group signals' : false,
}, async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-supervisor-leader-exit-'));
  const leaderPid = path.join(root, 'leader.pid');
  const grandchildPid = path.join(root, 'grandchild.pid');
  const recordedPids = [];
  context.after(async () => {
    for (const pid of recordedPids) {
      try { process.kill(pid, 'SIGKILL'); } catch {}
    }
    await fs.rm(root, { recursive: true, force: true });
  });
  const script = [
    "trap 'exit 0' TERM",
    `echo $$ > ${JSON.stringify(leaderPid)}`,
    `(trap "" TERM; echo $BASHPID > ${JSON.stringify(grandchildPid)}; while :; do sleep 1; done) &`,
    'while :; do sleep 1; done',
  ].join('\n');
  const result = spawnSync(process.execPath, [
    supervisor, '--milliseconds', '250', String(process.pid), '100',
    '--', 'bash', '-c', script,
  ], { stdio: 'ignore', timeout: 5_000 });
  assert.equal(result.status, 124);
  recordedPids.push(
    Number(await fs.readFile(leaderPid, 'utf8')),
    Number(await fs.readFile(grandchildPid, 'utf8')),
  );
  assert.equal(recordedPids.every((pid) => !alive(pid)), true);
  assert.equal(groupAlive(recordedPids[0]), false);
});

test('actual Git Bash/MSYS fails closed before an unprovable bounded command starts', {
  skip: process.platform !== 'win32' ? 'requires the actual Git Bash/MSYS timeout path' : false,
}, async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-msys-bounded-command-'));
  const descendantPidFile = path.join(root, 'descendant.pid');
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const script = String.raw`
set -uo pipefail
source "$COMMON_SHELL"
transaction_deadline=0
if run_bounded 1 bash --noprofile --norc -c \
  'printf "UNSAFE-START\n" > "$1"' staging-msys-command "$DESCENDANT_PID_FILE"; then
  status=0
else
  status=$?
fi
[ ! -e "$DESCENDANT_PID_FILE" ] || exit 97
printf 'STATUS:%s COMMAND:not-started\n' "$status"
`;
  const result = spawnSync(gitBash, ['-c', script], {
    encoding: 'utf8',
    env: {
      ...process.env,
      COMMON_SHELL: posixPath(commonShell),
      DESCENDANT_PID_FILE: posixPath(descendantPidFile),
    },
    timeout: 12_000,
  });
  if (result.error?.code === 'ENOENT') return context.skip('Git Bash is not installed');
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(result.stdout.trim(), 'STATUS:125 COMMAND:not-started');
});

test('supervisor kills descendants when its invoking parent is externally SIGKILLed', {
  skip: process.platform === 'win32' ? 'requires Linux/POSIX parent and process-group semantics' : false,
}, async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-supervisor-parent-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const childPid = path.join(root, 'child.pid');
  const parentScript = [
    `node ${JSON.stringify(supervisor)} 30 "$$" -- bash -c 'echo $$ > "$1"; trap "" TERM; while :; do sleep 1; done' child ${JSON.stringify(childPid)} &`,
    'supervisor_pid=$!',
    'wait "$supervisor_pid"',
  ].join('\n');
  const parent = spawn('bash', ['-c', parentScript], { detached: false, stdio: 'ignore' });
  await waitFor(async () => fs.readFile(childPid, 'utf8').then(() => true, () => false));
  const pid = Number(await fs.readFile(childPid, 'utf8'));
  parent.kill('SIGKILL');
  await new Promise((resolve) => parent.once('close', resolve));
  await waitFor(() => !alive(pid));
});
