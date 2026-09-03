import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { runDockerBuild } from '../scripts/build-production-image.js';

function finiteContext(megabytes = 1) {
  return (async function* content() {
    for (let index = 0; index < megabytes * 16; index += 1) yield Buffer.alloc(64 * 1024, 0x61);
  }());
}

function lifecycleOptions(overrides = {}) {
  return {
    hardTimeoutMs: 1_000,
    terminateGraceMs: 100,
    killGraceMs: 500,
    ...overrides,
  };
}

async function fixtureScript(directory, name, source) {
  const file = path.join(directory, name);
  await fs.writeFile(file, source, 'utf8');
  return file;
}

async function waitForExit(pid, { timeoutMs = 2_000 } = {}) {
  assert.ok(Number.isSafeInteger(pid) && pid > 0, 'a process probe requires a positive PID');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
      await new Promise((resolve) => setTimeout(resolve, 20));
    } catch (error) {
      if (error.code === 'ESRCH') return;
      throw error;
    }
  }
  assert.fail(`child process ${pid} remained alive after lifecycle timeout`);
}

async function waitForFile(file, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return Number(await fs.readFile(file, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  assert.fail(`timed out waiting for ${path.basename(file)}`);
}

async function readOptionalPid(file) {
  try {
    const value = (await fs.readFile(file, 'utf8')).trim();
    if (!/^[1-9]\d*$/u.test(value)) return null;
    const pid = Number(value);
    return Number.isSafeInteger(pid) ? pid : null;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

test('optional fixture PID evidence rejects empty, partial and non-positive values', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-build-pid-evidence-'));
  const pidFile = path.join(directory, 'pid');
  try {
    for (const value of ['', '0', '-1', '12.5', `${Number.MAX_SAFE_INTEGER}0`]) {
      await fs.writeFile(pidFile, value, 'utf8');
      assert.equal(await readOptionalPid(pidFile), null);
    }
    await fs.writeFile(pidFile, '123\n', 'utf8');
    assert.equal(await readOptionalPid(pidFile), 123);
  } finally {
    await fs.rm(directory, { force: true, recursive: true });
  }
});

function errorTreeMessages(error, seen = new Set()) {
  if (!error || seen.has(error)) return [];
  seen.add(error);
  return [
    error.message,
    ...errorTreeMessages(error.cause, seen),
    ...(error instanceof AggregateError
      ? error.errors.flatMap((nested) => errorTreeMessages(nested, seen))
      : []),
  ].filter(Boolean);
}

function windowsJobRecoveryAuthorityFixture(root, hashCharacter = 'a') {
  const controlName = `easyboost-windows-job-${hashCharacter.repeat(64)}`;
  const retirementName = `.${controlName}.retired`;
  const retirementProof = path.join(root, `${retirementName}.proof`);
  return Object.freeze({
    authorityFile: retirementProof,
    controlDirectory: path.join(root, controlName),
    proofToken: hashCharacter.repeat(64),
    protocol: 'easyboost-windows-job-recovery-v2',
    retirementDirectory: path.join(root, retirementName),
    retirementProof,
  });
}

const SYNTHETIC_POSIX_PUBLICATION_SOURCE_BINDING = Object.freeze({
  birthtimeNs: '0',
  bytes: 0,
  ctimeNs: '0',
  dev: '0',
  gid: '0',
  ino: '0',
  mode: String(0o100600),
  sha256: '0'.repeat(64),
  uid: '0',
});

function posixWriterEgressFixture() {
  const controlDirectory = path.join(
    path.resolve('.bounded-child-authority'),
    createHash('sha256').update('bounded-child-fixture', 'utf8').digest('hex'),
  );
  const specification = {
    controlDirectory,
    killAckPath: path.join(controlDirectory, 'kill.ack'),
    killArmedPath: path.join(controlDirectory, 'kill-armed.proof'),
    proofPath: path.join(controlDirectory, 'session-settled.proof'),
    proofToken: 'b'.repeat(64),
    readyPath: path.join(controlDirectory, 'ready.proof'),
    startupClaimPath: path.join(controlDirectory, 'startup.claim'),
    statusPath: path.join(controlDirectory, 'target-status.proof'),
    termAckPath: path.join(controlDirectory, 'term.ack'),
  };
  const destination = specification.readyPath;
  const temporary = path.join(
    path.dirname(controlDirectory),
    `.${path.basename(controlDirectory)}.${path.basename(destination)}.${'c'.repeat(32)}.tmp`,
  );
  return {
    publicationResidue: {
      destination,
      sourceBinding: SYNTHETIC_POSIX_PUBLICATION_SOURCE_BINDING,
      temporary,
    },
    specification,
  };
}

test('bounded build child consumes the complete stdin stream and exits cleanly', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-build-child-ok-'));
  try {
    const script = await fixtureScript(directory, 'consume.mjs', [
      'process.stdin.resume();',
      'process.stdin.on("end", () => process.exit(0));',
      '',
    ].join('\n'));
    const outcome = await runDockerBuild(
      process.execPath, [script], { cwd: directory, env: {}, shell: false }, finiteContext(),
      lifecycleOptions({ hardTimeoutMs: 4_000 }),
    );
    assert.deepEqual(outcome, { status: 0, signal: null, error: undefined });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('one hard deadline allows slow startup and legitimate post-upload Docker work', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-build-child-post-upload-'));
  const pidFile = path.join(directory, 'pid');
  try {
    const script = await fixtureScript(directory, 'post-upload.mjs', [
      'import fs from "node:fs";',
      'fs.writeFileSync(process.env.PID_FILE, String(process.pid));',
      'process.stdin.on("end", () => {',
      '  setTimeout(() => process.exit(0), 350);',
      '});',
      'setTimeout(() => process.stdin.resume(), 200);',
      '',
    ].join('\n'));
    const started = Date.now();
    const outcome = await runDockerBuild(
      process.execPath, [script], {
        cwd: directory, env: { PID_FILE: pidFile }, shell: false,
      }, finiteContext(),
      // A legacy caller-provided inactivity value must not create a second,
      // event-loop-sensitive deadline beside the one hard lifecycle bound.
      lifecycleOptions({ hardTimeoutMs: 2_000, inactivityTimeoutMs: 100 }),
    );
    assert.deepEqual(outcome, { status: 0, signal: null, error: undefined });
    assert.ok(Date.now() - started >= 300, 'runner returned before the child was reaped');
    await waitForExit(Number(await fs.readFile(pidFile, 'utf8')));
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('successful runner leaves no anonymous lifecycle timer or synthetic completion handle', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-build-child-wrapper-'));
  try {
    const worker = await fixtureScript(directory, 'worker.mjs', [
      'process.stdin.resume();',
      'process.stdin.on("end", () => setTimeout(() => process.exit(0), 40));',
      '',
    ].join('\n'));
    const runner = await fixtureScript(directory, 'runner.mjs', [
      `import { runDockerBuild } from ${JSON.stringify(pathToFileURL(path.resolve('scripts/build-production-image.js')).href)};`,
      'async function* context() { yield Buffer.alloc(1024, 0x61); }',
      `await runDockerBuild(process.execPath, [${JSON.stringify(worker)}], { cwd: ${JSON.stringify(directory)}, env: {}, shell: false }, context(), { hardTimeoutMs: 15000, terminateGraceMs: 100, killGraceMs: 100 });`,
      '',
    ].join('\n'));
    const result = spawnSync(process.execPath, [runner], {
      cwd: directory, encoding: 'utf8', timeout: 8_000,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(result.signal, null, 'wrapper must exit without a leaked lifecycle timer');
    const source = await fs.readFile(path.resolve('scripts/build-production-image.js'), 'utf8');
    assert.doesNotMatch(source, /\.unref\s*\(/u);
    assert.match(source, /child\.once\('close'/u,
      'only the observed close event may settle a spawned Docker child');
    assert.doesNotMatch(source, /pid === undefined\) finish/iu,
      'spawn errors must still wait for the observed close/reap boundary');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('builder reports an explicit bounded failure when SIGKILL never reaches close/reap', async () => {
  const child = new EventEmitter();
  child.pid = 5151;
  child.stdin = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  const signals = [];
  child.kill = () => { throw new Error('leader-only child.kill is forbidden'); };
  const started = Date.now();
  await assert.rejects(runDockerBuild(
    process.execPath,
    ['-e', 'process.stdin.resume(); process.stdin.on("end", () => process.exit(0))'],
    { env: {}, shell: false },
    finiteContext(),
    lifecycleOptions({
      forcePosixSession: true,
      hardTimeoutMs: 10,
      terminateGraceMs: 10,
      killGraceMs: 20,
      platform: 'linux',
      posixSessionControl: {
        dispose() {},
        markWrapperSpawned() {},
        observeWrapperClose() {},
        proofState() { return { state: 'alive' }; },
        request(signal) { signals.push(signal); },
        specification: { controlDirectory: path.join(os.tmpdir(), 'durable-build-posix') },
      },
      posixSessionInvocation(command, args, cwd, settlementMilliseconds, environment, control) {
        return { args, command, cwd, environment, posixSessionControl: control };
      },
      spawnProcess() { return child; },
    }),
  ), /SIGKILL.*(?:close|reap)|(?:close|reap).*SIGKILL/iu);
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  assert.ok(Date.now() - started < 500, 'builder close/reap failure exceeded its own bound');
  assert.equal(child.listenerCount('error'), 1,
    'a returned unreaped child must retain its asynchronous error observer');
  assert.equal(child.listenerCount('close'), 1,
    'a returned unreaped child must retain its eventual close/proof observer');
});

test('simulated native Windows build accepts success only after exact Job proof and disposal',
  async () => {
    const child = new EventEmitter();
    child.pid = 5251;
    child.stdin = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
    child.kill = () => { throw new Error('native Windows Job child.kill fallback is forbidden'); };
    let disposeCalls = 0;
    const windowsJobControl = {
      dispose() { disposeCalls += 1; },
      proofState() { return { state: 'absent' }; },
      request() { throw new Error('successful wrapper must not require termination'); },
      specification: {},
    };
    const outcomePromise = runDockerBuild(
      'fixture-target', [], { env: {}, shell: false }, finiteContext(), lifecycleOptions({
        forceWindowsJob: true,
        platform: 'win32',
        spawnProcess() {
          setImmediate(() => child.emit('close', 0, null));
          return child;
        },
        windowsJobInvocation() {
          return { args: [], command: 'fixture-wrapper', windowsJobControl };
        },
      }),
    );
    const outcome = await outcomePromise;
    assert.equal(outcome.status, 0);
    assert.equal(disposeCalls, 1, 'controller directory must be gone before success returns');
  });

test('simulated native Windows build retains control when Job-empty proof is missing',
  async () => {
    const child = new EventEmitter();
    child.pid = 5252;
    child.stdin = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
    child.kill = () => { throw new Error('native Windows Job child.kill fallback is forbidden'); };
    const disposeCalls = [];
    const windowsJobControl = {
      dispose(options) { disposeCalls.push(options); },
    proofState() { return { state: 'unknown' }; },
    request() {},
    specification: { proofPath: path.join(os.tmpdir(), 'durable-build-job-proof', 'job-empty.proof') },
    };
    const execution = runDockerBuild(
      'fixture-target', [], { env: {}, shell: false }, finiteContext(), lifecycleOptions({
        forceWindowsJob: true,
        platform: 'win32',
        spawnProcess() {
          setImmediate(() => child.emit('close', 0, null));
          return child;
        },
        windowsJobInvocation() {
          return { args: [], command: 'fixture-wrapper', windowsJobControl };
        },
      }),
    );
  await assert.rejects(execution, (error) => {
    assert.equal(error.childSettlementUnproven, true);
    assert.match(error.message, /Job-empty proof|JOB_EMPTY|settlement.*proof/iu);
    return true;
  });
  assert.deepEqual(disposeCalls, [],
    'unproven Job state must retain its durable restart guard and recovery controller');
  });

test('simulated native Windows timeout terminates only through its Job controller', async () => {
  const child = new EventEmitter();
  child.pid = 5253;
  child.stdin = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  let childKillCalls = 0;
  child.kill = () => { childKillCalls += 1; return true; };
  const requests = [];
  let disposeCalls = 0;
  const windowsJobControl = {
    dispose() { disposeCalls += 1; },
    proofState() { return { state: 'absent' }; },
    request(signal) {
      requests.push(signal);
      setImmediate(() => child.emit('close', 125, null));
    },
    specification: {},
  };
  await assert.rejects(runDockerBuild(
    'fixture-target', [], { env: {}, shell: false }, finiteContext(), lifecycleOptions({
      forceWindowsJob: true,
      hardTimeoutMs: 10,
      killGraceMs: 50,
      platform: 'win32',
      spawnProcess() { return child; },
      terminateGraceMs: 20,
      windowsJobInvocation() {
        return { args: [], command: 'fixture-wrapper', windowsJobControl };
      },
    }),
  ), /hard deadline/iu);
  assert.deepEqual(requests, ['SIGTERM']);
  assert.equal(childKillCalls, 0, 'native Windows wrapper must never receive child.kill');
  assert.equal(disposeCalls, 1);
});

test('unresponsive native Windows build returns typed unresolved state and retains its controller',
  async () => {
    const child = new EventEmitter();
    child.pid = 5255;
    child.stdin = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
    child.kill = () => { throw new Error('native Windows Job child.kill fallback is forbidden'); };
    child.unref = () => {};
    const requests = [];
    const disposeCalls = [];
    const recoveryAuthority = windowsJobRecoveryAuthorityFixture(
      path.join(os.tmpdir(), 'durable-build-job-root'), 'b',
    );
    const controlDirectory = recoveryAuthority.controlDirectory;
    const windowsJobControl = {
      dispose(options) { disposeCalls.push(options); },
      proofState() { return { state: 'unknown' }; },
      recoveryAuthority,
      request(signal) { requests.push(signal); },
      specification: { proofPath: path.join(controlDirectory, 'job-empty.proof') },
    };
    const started = Date.now();
    await assert.rejects(runDockerBuild(
      'fixture-target', [], { env: {}, shell: false }, finiteContext(), lifecycleOptions({
        forceWindowsJob: true,
        hardTimeoutMs: 5,
        killGraceMs: 10,
        platform: 'win32',
        spawnProcess() { return child; },
        terminateGraceMs: 5,
        windowsJobInvocation() {
          return { args: [], command: 'fixture-wrapper', windowsJobControl };
        },
      }),
    ), (error) => {
      assert.equal(error.childSettlementUnproven, true);
      assert.deepEqual(error.recoveryAuthority, recoveryAuthority,
        'the build failure must preserve the directly replayable typed recovery authority');
      return true;
    });
    assert.ok(Date.now() - started < 250, 'typed unresolved build return must remain finite');
    assert.deepEqual(requests, ['SIGTERM', 'SIGKILL']);
    assert.deepEqual(disposeCalls, [], 'live controller must never be force-deleted');
    assert.equal(child.listenerCount('error'), 1,
      'a returned live wrapper must retain an error observer');
  });

test('simulated native Windows build reports disposal failure and retries cleanup', async () => {
  const child = new EventEmitter();
  child.pid = 5254;
  child.stdin = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  const disposalFailure = new Error('synthetic build controller removal failure');
  let disposeCalls = 0;
  const windowsJobControl = {
    dispose() {
      disposeCalls += 1;
      if (disposeCalls === 1) throw disposalFailure;
    },
    proofState() { return { state: 'absent' }; },
    request() {},
    specification: {},
  };
  const execution = runDockerBuild(
    'fixture-target', [], { env: {}, shell: false }, finiteContext(), lifecycleOptions({
      forceWindowsJob: true,
      platform: 'win32',
      spawnProcess() {
        setImmediate(() => child.emit('close', 0, null));
        return child;
      },
      windowsJobInvocation() {
        return { args: [], command: 'fixture-wrapper', windowsJobControl };
      },
    }),
  );
  await assert.rejects(execution, /Windows Job controller disposal failed/iu);
  assert.equal(disposeCalls, 2, 'final cleanup must retry a transient disposal failure');
});

test('persistent typed Windows build disposal failure keeps its replayable recovery authority',
  async () => {
    const child = new EventEmitter();
    child.pid = 5256;
    child.stdin = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
    const recoveryAuthority = windowsJobRecoveryAuthorityFixture(
      path.join(os.tmpdir(), 'durable-build-disposal-root'), 'd',
    );
    let disposeCalls = 0;
    const windowsJobControl = {
      dispose() {
        disposeCalls += 1;
        const failure = new Error('WINDOWS_JOB_RECOVERY_REQUIRED: fixture disposal');
        failure.childSettlementUnproven = true;
        failure.code = 'WINDOWS_JOB_RECOVERY_REQUIRED';
        failure.recoveryAuthority = recoveryAuthority;
        throw failure;
      },
      proofState() { return { state: 'absent' }; },
      recoveryAuthority,
      request() {},
      specification: { proofPath: path.join(recoveryAuthority.controlDirectory, 'job-empty.proof') },
    };
    const execution = runDockerBuild(
      'fixture-target', [], { env: {}, shell: false }, finiteContext(), lifecycleOptions({
        forceWindowsJob: true,
        platform: 'win32',
        spawnProcess() {
          setImmediate(() => child.emit('close', 0, null));
          return child;
        },
        windowsJobInvocation() {
          return { args: [], command: 'fixture-wrapper', windowsJobControl };
        },
      }),
    );
    await assert.rejects(execution, (error) => {
      assert.equal(error.childSettlementUnproven, true);
      assert.deepEqual(error.recoveryAuthority, recoveryAuthority);
      return true;
    });
    assert.equal(disposeCalls, 1,
      'typed unresolved disposal must not be retried as an ordinary transient failure');
  });

test('native Windows build timeout returns after descendant settlement with no controller dirs', {
  skip: process.platform === 'win32' ? false : 'requires Windows Job Objects',
}, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-build-native-job-'));
  const controls = path.join(directory, 'controls');
  const leaderPidFile = path.join(directory, 'leader.pid');
  const descendantPidFile = path.join(directory, 'descendant.pid');
  let leaderPid;
  let descendantPid;
  try {
    await fs.mkdir(controls);
    const descendant = await fixtureScript(directory, 'job-descendant.mjs', [
      'import fs from "node:fs";',
      'fs.writeFileSync(process.env.DESCENDANT_PID_FILE, String(process.pid));',
      'setInterval(() => {}, 1000);',
      '',
    ].join('\n'));
    const leader = await fixtureScript(directory, 'job-leader.mjs', [
      'import { spawn } from "node:child_process";',
      'import fs from "node:fs";',
      `spawn(process.execPath, [${JSON.stringify(descendant)}], { env: process.env, stdio: "ignore" });`,
      'const wait = new Int32Array(new SharedArrayBuffer(4));',
      'const deadline = Date.now() + 2_000;',
      'while (!fs.existsSync(process.env.DESCENDANT_PID_FILE) && Date.now() < deadline) {',
      '  Atomics.wait(wait, 0, 0, 5);',
      '}',
      'if (!fs.existsSync(process.env.DESCENDANT_PID_FILE)) process.exit(91);',
      'fs.writeFileSync(process.env.LEADER_PID_FILE, String(process.pid));',
      'process.stdin.resume();',
      'setInterval(() => {}, 1000);',
      '',
    ].join('\n'));
    const supervisor = await import('../scripts/release-command-supervisor.js');
    const execution = runDockerBuild(
      process.execPath,
      [leader],
      {
        cwd: directory,
        env: {
          DESCENDANT_PID_FILE: descendantPidFile,
          LEADER_PID_FILE: leaderPidFile,
        },
        shell: false,
      },
      finiteContext(),
      lifecycleOptions({
        // The fixture first waits up to 2 seconds for the descendant to publish.
        // Keep its lifecycle deadline later than that bounded handshake, otherwise
        // load can correctly kill the Job before the PID evidence exists to inspect.
        hardTimeoutMs: 4_000,
        killGraceMs: 1_000,
        terminateGraceMs: 100,
        // This synchronous test-only seam completes fixture publication before
        // runDockerBuild installs its hard deadline. The real Job wrapper runs
        // independently, so waiting here does not alter production timing.
        forceWindowsJob: true,
        spawnProcess(command, args, spawnOptions) {
          const child = spawn(command, args, spawnOptions);
          const wait = new Int32Array(new SharedArrayBuffer(4));
          const deadline = Date.now() + 3_000;
          while (
            (!fsSync.existsSync(leaderPidFile) || !fsSync.existsSync(descendantPidFile))
            && Date.now() < deadline
          ) {
            Atomics.wait(wait, 0, 0, 5);
          }
          return child;
        },
        windowsJobInvocation(command, args, cwd, settlementMilliseconds, environment) {
          const control = supervisor.createWindowsJobControl({ temporaryDirectory: controls });
          return supervisor.createWindowsJobInvocation(
            command, args, cwd, settlementMilliseconds, environment, control,
          );
        },
      }),
    );
    // The Windows controller may correctly reject before the fixtures have both
    // published their PIDs; attach an observer now so that expected failure is
    // not reported as an unhandled rejection while those public probes run.
    void execution.catch(() => {});
    leaderPid = await waitForFile(leaderPidFile);
    descendantPid = await waitForFile(descendantPidFile);
    await assert.rejects(execution, /hard deadline/iu);
    for (const pid of [leaderPid, descendantPid]) {
      assert.throws(() => process.kill(pid, 0), (error) => error?.code === 'ESRCH',
        `native Windows build process ${pid} must be absent when the runner returns`);
    }
    assert.deepEqual(await fs.readdir(controls), [],
      'native Windows runner must remove every private controller directory before return');
  } finally {
    for (const pid of [descendantPid, leaderPid]) {
      if (!Number.isSafeInteger(pid) || pid < 1) continue;
      try { process.kill(pid, 'SIGKILL'); } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
    }
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('native Windows typed restart recovery interrupts descendants after the leader has exited', {
  skip: process.platform === 'win32' ? false : 'requires Windows Job Objects',
}, async () => {
  const supervisor = await import(
    `../scripts/release-command-supervisor.js?native-restart-request=${Date.now()}`
  );
  const temporaryDirectory = await fs.mkdtemp(path.join(
    path.resolve('test'), '.tmp-native-windows-restart-request-',
  ));
  const targetPidFile = path.join(temporaryDirectory, 'target.pid');
  const descendantPidFile = path.join(temporaryDirectory, 'descendant.pid');
  const target = await fixtureScript(temporaryDirectory, 'post-leader-target.ps1', [
    "$ErrorActionPreference = 'Stop'",
    "[IO.File]::WriteAllText($env:TARGET_PID_FILE, [string][Diagnostics.Process]::GetCurrentProcess().Id)",
    "$child = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoLogo', '-NoProfile', '-NonInteractive', '-Command', 'Start-Sleep -Seconds 30') -WindowStyle Hidden -PassThru",
    "[IO.File]::WriteAllText($env:DESCENDANT_PID_FILE, [string]$child.Id)",
    'Start-Sleep -Milliseconds 200',
  ].join('\n'));
  const control = supervisor.createWindowsJobControl({
    controlKey: 'fixture-native-post-leader-restart-request',
    temporaryDirectory,
  });
  const invocation = supervisor.createWindowsJobInvocation(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', target],
    temporaryDirectory,
    5_000,
    {
      ...process.env,
      DESCENDANT_PID_FILE: descendantPidFile,
      TARGET_PID_FILE: targetPidFile,
    },
    control,
  );
  const wrapper = spawn(invocation.command, invocation.args, {
    cwd: invocation.cwd,
    env: invocation.environment,
    stdio: 'ignore',
    windowsHide: true,
  });
  control.markWrapperSpawned();
  const wrapperExit = new Promise((resolve, reject) => {
    wrapper.once('error', reject);
    wrapper.once('close', (code, signal) => resolve({ code, signal }));
  });
  let descendantPid;
  try {
    const targetPid = await waitForFile(targetPidFile, 5_000);
    descendantPid = await waitForFile(descendantPidFile, 5_000);
    await waitForExit(targetPid, { timeoutMs: 2_000 });
    assert.doesNotThrow(() => process.kill(descendantPid, 0),
      'the post-leader fixture descendant must still be alive before restart recovery');

    assert.deepEqual(supervisor.recoverWindowsJobControl({
      recoveryAuthority: JSON.parse(JSON.stringify(control.recoveryAuthority)),
      windowsRecoveryKillGraceMs: 2_000,
      windowsRecoveryTerminateGraceMs: 300,
    }), {
      controlDirectory: control.recoveryAuthority.controlDirectory,
      retired: true,
      state: 'absent',
    });
    assert.deepEqual(await wrapperExit, { code: 125, signal: null });
    await waitForExit(descendantPid, { timeoutMs: 2_000 });
  } finally {
    if (wrapper.exitCode === null && wrapper.signalCode === null) wrapper.kill('SIGKILL');
    await wrapperExit.catch(() => {});
    if (descendantPid) await waitForExit(descendantPid, { timeoutMs: 2_000 }).catch(() => {});
    await fs.rm(temporaryDirectory, { force: true, recursive: true });
  }
});

test('external SIGKILL of the production runner cannot orphan its Docker command group', {
  skip: process.platform === 'win32' ? 'requires POSIX process-group and parent-death semantics' : false,
}, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-build-child-parent-kill-'));
  const workerPidFile = path.join(directory, 'worker.pid');
  const grandchildPidFile = path.join(directory, 'grandchild.pid');
  try {
    const grandchild = await fixtureScript(directory, 'grandchild.mjs', [
      'import fs from "node:fs";',
      'fs.writeFileSync(process.env.GRANDCHILD_PID_FILE, String(process.pid));',
      'process.on("SIGTERM", () => {});',
      'setInterval(() => {}, 1000);',
      '',
    ].join('\n'));
    const worker = await fixtureScript(directory, 'worker.mjs', [
      'import { spawn } from "node:child_process";',
      'import fs from "node:fs";',
      'fs.writeFileSync(process.env.WORKER_PID_FILE, String(process.pid));',
      `spawn(process.execPath, [${JSON.stringify(grandchild)}], { env: process.env, stdio: "ignore" });`,
      'process.on("SIGTERM", () => {});',
      'process.stdin.resume();',
      'setInterval(() => {}, 1000);',
      '',
    ].join('\n'));
    const runner = await fixtureScript(directory, 'runner.mjs', [
      `import { runDockerBuild } from ${JSON.stringify(pathToFileURL(path.resolve('scripts/build-production-image.js')).href)};`,
      'async function* context() { while (true) { yield Buffer.alloc(64 * 1024); await new Promise((resolve) => setTimeout(resolve, 10)); } }',
      `await runDockerBuild(process.execPath, [${JSON.stringify(worker)}], { cwd: ${JSON.stringify(directory)}, env: { WORKER_PID_FILE: ${JSON.stringify(workerPidFile)}, GRANDCHILD_PID_FILE: ${JSON.stringify(grandchildPidFile)} }, shell: false }, context(), { hardTimeoutMs: 30000, terminateGraceMs: 200, killGraceMs: 200 });`,
      '',
    ].join('\n'));
    const runnerProcess = spawn(process.execPath, [runner], {
      cwd: directory,
      stdio: 'ignore',
    });
    const workerPid = await waitForFile(workerPidFile);
    const grandchildPid = await waitForFile(grandchildPidFile);
    process.kill(runnerProcess.pid, 'SIGKILL');
    await new Promise((resolve) => runnerProcess.once('close', resolve));
    await waitForExit(workerPid);
    await waitForExit(grandchildPid);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('database child lifecycle does not accept leader close while a descendant survives',
  async () => {
    const lifecycle = await import(`../scripts/bounded-child-lifecycle.js?tree=${Date.now()}`);
    const child = new EventEmitter();
    let descendantAlive = true;
    const treeSignals = [];
    const authority = {
      signal(signal) {
        treeSignals.push(signal);
        if (signal === 'SIGKILL') descendantAlive = false;
      },
      state() { return descendantAlive ? 'alive' : 'absent'; },
    };
    child.kill = () => {
      throw new Error('leader-only signal must not be used when tree authority exists');
    };

    const cleanupError = await lifecycle.terminateAndReapChild({
      authority,
      child,
      closeOutcome: Promise.resolve({ exitCode: 0, signal: null }),
      commandLabel: 'database fixture command',
      isClosed: () => true,
      killGraceMs: 5,
      reapTimeoutMs: 20,
    });
    assert.equal(cleanupError, null, cleanupError?.stack);
    assert.deepEqual(treeSignals, ['SIGTERM', 'SIGKILL']);
    assert.equal(descendantAlive, false,
      'the database command descendant must not outlive its already-closed leader');
  });

test('database child cleanup reports a live residual tree truthfully after leader close', async () => {
  const lifecycle = await import(`../scripts/bounded-child-lifecycle.js?live-tree=${Date.now()}`);
  const child = new EventEmitter();
  child.kill = () => { throw new Error('tree authority must own signal delivery'); };
  const cleanupError = await lifecycle.terminateAndReapChild({
    authority: {
      signal() {},
      state() { return 'alive'; },
    },
    child,
    closeOutcome: Promise.resolve({ exitCode: 0, signal: null }),
    commandLabel: 'database fixture command',
    isClosed: () => true,
    killGraceMs: 5,
    reapTimeoutMs: 5,
  });
  assert.equal(cleanupError?.childSettlementUnproven, true);
  assert.match(cleanupError.message, /process tree remained alive after SIGKILL/iu);
  assert.doesNotMatch(cleanupError.message, /did not close/iu);
});

test('database child cleanup preserves a descendant settlement probe failure', async () => {
  const lifecycle = await import(`../scripts/bounded-child-lifecycle.js?probe=${Date.now()}`);
  const child = new EventEmitter();
  const probeFailure = new Error('fixture process-tree probe failed');
  const cleanupError = await lifecycle.terminateAndReapChild({
    authority: {
      signal() {},
      state() { throw probeFailure; },
    },
    child,
    closeOutcome: Promise.resolve({ exitCode: 0, signal: null }),
    commandLabel: 'database fixture command',
    isClosed: () => true,
    killGraceMs: 5,
    reapTimeoutMs: 5,
  });
  assert.equal(cleanupError?.childSettlementUnproven, true);
  assert.match(cleanupError.message, /settlement could not be proven/iu);
  assert.equal(cleanupError.cause, probeFailure);
});

test('POSIX bounded child opens fd3 and retains exact trusted writer publication authority',
  async () => {
    const lifecycle = await import(`../scripts/bounded-child-lifecycle.js?fd3=${Date.now()}`);
    const supervisor = await import('../scripts/posix-session-supervisor.js');
    const { publicationResidue, specification } = posixWriterEgressFixture();
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdio = [child.stdin, child.stdout, child.stderr, new PassThrough()];
    child.unref = () => {};
    const signals = [];
    const control = {
      dispose() { throw new Error('writer residue must keep the control authority retained'); },
      markWrapperSpawned() {},
      observeWrapperClose() {},
      proofState() { return { state: 'absent' }; },
      request(signal) { signals.push(signal); },
      specification,
    };
    const spawned = lifecycle.spawnBoundedChild('fixture', [], {
      forcePosixSession: true,
      platform: 'linux',
      posixSessionControl: control,
      posixSessionInvocation() {
        return {
          args: [],
          command: 'fixture-wrapper',
          posixSessionControl: control,
          writerEgress: { descriptor: 3, specification },
        };
      },
      spawnProcess(_command, _args, options) {
        assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe', 'pipe']);
        return child;
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let closed = false;
    child.stdio[3].end(supervisor.encodePosixSessionWriterRecovery(
      publicationResidue,
      specification,
    ));
    child.emit('close', 125, null);
    closed = true;
    await new Promise((resolve) => { setImmediate(resolve); });

    const cleanupError = await lifecycle.terminateAndReapChild({
      ...spawned,
      closeOutcome: Promise.resolve({ exitCode: 125, signal: null }),
      commandLabel: 'POSIX fd3 fixture',
      isClosed: () => closed,
      killGraceMs: 1,
      reapTimeoutMs: 1,
    });
    assert.equal(cleanupError?.childSettlementUnproven, true);
    assert.deepEqual(cleanupError.recoveryAuthority, {
      controlDirectory: specification.controlDirectory,
      publicationResidue,
    });
    assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  });

test('POSIX bounded child retains fd3, TERM and KILL publication authorities together',
  async () => {
    const lifecycle = await import(`../scripts/bounded-child-lifecycle.js?plural-fd3=${Date.now()}`);
    const supervisor = await import('../scripts/posix-session-supervisor.js');
    const { publicationResidue, specification } = posixWriterEgressFixture();
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdio = [child.stdin, child.stdout, child.stderr, new PassThrough()];
    child.unref = () => {};
    const requestResidues = ['term.request', 'kill.request'].map((name, index) => ({
      destination: path.join(specification.controlDirectory, name),
      sourceBinding: SYNTHETIC_POSIX_PUBLICATION_SOURCE_BINDING,
      temporary: path.join(path.dirname(specification.controlDirectory),
        `.${path.basename(specification.controlDirectory)}.${name}.${String(index + 1).repeat(32)}.tmp`),
    }));
    let requestIndex = 0;
    const control = {
      dispose() { throw new Error('publication residues must retain the controller'); },
      markWrapperSpawned() {},
      observeWrapperClose() {},
      proofState() { return { state: 'absent' }; },
      request() {
        const failure = new Error('synthetic parent request publication failure');
        failure.recoveryAuthority = requestResidues[requestIndex];
        requestIndex += 1;
        throw failure;
      },
      specification,
    };
    const spawned = lifecycle.spawnBoundedChild('fixture', [], {
      forcePosixSession: true,
      platform: 'linux',
      posixSessionControl: control,
      posixSessionInvocation() {
        return {
          args: [], command: 'fixture-wrapper', posixSessionControl: control,
          writerEgress: { descriptor: 3, specification },
        };
      },
      spawnProcess() { return child; },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let closed = false;
    child.stdio[3].end(supervisor.encodePosixSessionWriterRecovery(
      publicationResidue,
      specification,
    ));
    child.emit('close', 125, null);
    closed = true;
    await new Promise((resolve) => { setImmediate(resolve); });

    const cleanupError = await lifecycle.terminateAndReapChild({
      ...spawned,
      closeOutcome: Promise.resolve({ exitCode: 125, signal: null }),
      commandLabel: 'POSIX plural publication fixture',
      isClosed: () => closed,
      killGraceMs: 1,
      reapTimeoutMs: 1,
    });
    assert.equal(cleanupError?.childSettlementUnproven, true);
    const expectedRecoveryAuthority = {
      controlDirectory: specification.controlDirectory,
      publicationResidues: [publicationResidue, ...requestResidues],
    };
    assert.deepEqual(cleanupError.recoveryAuthority, expectedRecoveryAuthority);
    const propagated = lifecycle.propagateLifecycleRecovery(cleanupError);
    assert.deepEqual(propagated.recoveryAuthority, expectedRecoveryAuthority);
  });

for (const [description, frame] of [
  ['partial', Buffer.from('{"protocol":"secret-database-url"', 'utf8')],
  ['malformed', Buffer.from('{"protocol":"secret-database-url"}\n', 'utf8')],
]) {
  test(`POSIX bounded child fails closed on ${description} fd3 writer evidence without leaking it`,
    async () => {
      const lifecycle = await import(
        `../scripts/bounded-child-lifecycle.js?fd3-${description}=${Date.now()}`
      );
      const { specification } = posixWriterEgressFixture();
      const child = new EventEmitter();
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.stdio = [child.stdin, child.stdout, child.stderr, new PassThrough()];
      child.unref = () => {};
      const control = {
        dispose() { throw new Error('invalid fd3 evidence must keep authority retained'); },
        markWrapperSpawned() {},
        observeWrapperClose() {},
        proofState() { return { state: 'absent' }; },
        request() {},
        specification,
      };
      const spawned = lifecycle.spawnBoundedChild('fixture', [], {
        forcePosixSession: true,
        platform: 'linux',
        posixSessionControl: control,
        posixSessionInvocation() {
          return {
            args: [], command: 'fixture-wrapper', posixSessionControl: control,
            writerEgress: { descriptor: 3, specification },
          };
        },
        spawnProcess() { return child; },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let closed = false;
      child.stdio[3].end(frame);
      child.emit('close', 125, null);
      closed = true;
      await new Promise((resolve) => { setImmediate(resolve); });

      const cleanupError = await lifecycle.terminateAndReapChild({
        ...spawned,
        closeOutcome: Promise.resolve({ exitCode: 125, signal: null }),
        commandLabel: `POSIX ${description} fd3 fixture`,
        isClosed: () => closed,
        killGraceMs: 1,
        reapTimeoutMs: 1,
      });
      assert.equal(cleanupError?.childSettlementUnproven, true);
      assert.deepEqual(cleanupError.recoveryAuthority, {
        controlDirectory: specification.controlDirectory,
      });
      assert.doesNotMatch(JSON.stringify(cleanupError), /secret-database-url/u);
    });
}

test('POSIX database authority never signals a reused process-group identity', async () => {
  const lifecycle = await import(`../scripts/bounded-child-lifecycle.js?reuse=${Date.now()}`);
  const child = new EventEmitter();
  child.pid = 4242;
  child.kill = () => { throw new Error('POSIX group authority must own signal delivery'); };
  const deliveredSignals = [];
  const spawned = lifecycle.spawnBoundedChild('fixture', [], {
    inspectProcessGroup(_processGroupId, expectedIdentity) {
      if (!expectedIdentity) {
        return {
          identity: { leaderStartTime: '100', processGroupId: 4242, sessionId: 4242 },
          state: 'alive',
        };
      }
      return { state: 'reused' };
    },
    platform: 'linux',
    signalProcess(...args) { deliveredSignals.push(args); },
    spawnProcess() { return child; },
    stdio: 'ignore',
  });
  const cleanupError = await lifecycle.terminateAndReapChild({
    ...spawned,
    closeOutcome: Promise.resolve({ exitCode: 0, signal: null }),
    commandLabel: 'database fixture command',
    isClosed: () => true,
    killGraceMs: 5,
    reapTimeoutMs: 5,
  });
  assert.equal(cleanupError?.childSettlementUnproven, true,
    'numeric reuse must fail closed instead of proving the original tree absent');
  assert.match(errorTreeMessages(cleanupError).join(' '), /reused/iu);
  assert.deepEqual(deliveredSignals, [], 'a recycled numeric PGID must never receive a signal');
});

test('POSIX database authority fails closed when birth/session capture is ambiguous', async () => {
  const lifecycle = await import(`../scripts/bounded-child-lifecycle.js?ambiguous=${Date.now()}`);
  const child = new EventEmitter();
  child.pid = 4343;
  child.kill = () => { throw new Error('POSIX group authority must own signal delivery'); };
  const deliveredSignals = [];
  const captureFailure = new Error('fixture /proc identity capture failed');
  const spawned = lifecycle.spawnBoundedChild('fixture', [], {
    inspectProcessGroup() { return { error: captureFailure, state: 'unknown' }; },
    platform: 'linux',
    signalProcess(...args) { deliveredSignals.push(args); },
    spawnProcess() { return child; },
    stdio: 'ignore',
  });
  const cleanupError = await lifecycle.terminateAndReapChild({
    ...spawned,
    closeOutcome: new Promise(() => {}),
    commandLabel: 'database fixture command',
    isClosed: () => false,
    killGraceMs: 5,
    reapTimeoutMs: 5,
  });
  assert.equal(cleanupError?.childSettlementUnproven, true);
  assert.deepEqual(deliveredSignals, [], 'ambiguous numeric PGID must never receive a signal');
  assert.match(errorTreeMessages(cleanupError).join(' '), /identity capture|fixture \/proc/iu);
});

test('POSIX fast exit before identity capture proves absence without a numeric signal', async () => {
  const lifecycle = await import(`../scripts/bounded-child-lifecycle.js?fast-exit=${Date.now()}`);
  const child = new EventEmitter();
  child.pid = 4444;
  const deliveredSignals = [];
  const spawned = lifecycle.spawnBoundedChild('fixture', [], {
    inspectProcessGroup() { return { state: 'absent' }; },
    platform: 'linux',
    signalProcess(...args) { deliveredSignals.push(args); },
    spawnProcess() { return child; },
    stdio: 'ignore',
  });
  const cleanupError = await lifecycle.terminateAndReapChild({
    ...spawned,
    closeOutcome: Promise.resolve({ exitCode: 0, signal: null }),
    commandLabel: 'database fixture command',
    isClosed: () => true,
    killGraceMs: 5,
    reapTimeoutMs: 5,
  });
  assert.equal(cleanupError, null, cleanupError?.stack);
  assert.deepEqual(deliveredSignals, []);
});

test('Windows Job settlement accepts only its exact token-bound empty proof', async () => {
  const supervisor = await import(`../scripts/release-command-supervisor.js?proof=${Date.now()}`);
  const control = supervisor.createWindowsJobControl();
  try {
    assert.equal(control.proofState().state, 'unknown');
    await fs.writeFile(control.specification.proofPath, `${JSON.stringify({
      activeProcesses: 0,
      protocol: 'easyboost-windows-job-empty-v1',
      token: '0'.repeat(64),
    })}\n`, { flag: 'wx' });
    assert.equal(control.proofState().state, 'unknown', 'a forged token cannot prove Job emptiness');
    await fs.rm(control.specification.proofPath);
    await fs.writeFile(control.specification.proofPath, `${JSON.stringify({
      activeProcesses: 0,
      protocol: 'easyboost-windows-job-empty-v1',
      token: control.specification.proofToken,
    })}\n`, { flag: 'wx' });
    assert.equal(control.proofState().state, 'absent');
  } finally {
    control.dispose({ force: true });
  }
});

test('Windows Job control disposal stays retryable after a filesystem failure', async () => {
  const supervisor = await import(`../scripts/release-command-supervisor.js?dispose=${Date.now()}`);
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-job-dispose-'));
  const removalFailure = new Error('synthetic controller directory removal failure');
  let removalAttempts = 0;
  const control = supervisor.createWindowsJobControl({
    beforePrivateGenerationCleanup() {
      removalAttempts += 1;
      if (removalAttempts === 1) throw removalFailure;
    },
    temporaryDirectory,
  });
  try {
    await fs.writeFile(control.specification.proofPath, `${JSON.stringify({
      activeProcesses: 0,
      protocol: 'easyboost-windows-job-empty-v1',
      token: control.specification.proofToken,
    })}\n`, { flag: 'wx' });
    assert.throws(() => control.dispose(), (error) => error === removalFailure);
    assert.equal(control.proofState().state, 'absent',
      'failed disposal must continue reading the real token-bound proof');
    assert.doesNotThrow(() => control.request('SIGTERM'),
      'failed disposal must leave the controller retryable');
    control.dispose();
    assert.equal(removalAttempts, 2);
    await assert.rejects(fs.access(path.dirname(control.specification.proofPath)), /ENOENT/u);
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test('Windows Job control latches exact proof across partial directory removal and retries cleanup',
  async () => {
    const supervisor = await import(`../scripts/release-command-supervisor.js?partial=${Date.now()}`);
    const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-job-partial-'));
    const removalFailure = new Error('synthetic partial controller directory removal failure');
    let removalAttempts = 0;
    const control = supervisor.createWindowsJobControl({
      beforePrivateGenerationCleanup({ directory }) {
        removalAttempts += 1;
        if (removalAttempts === 1) {
          fsSync.rmSync(path.join(directory, 'job-empty.proof'));
          throw removalFailure;
        }
      },
      temporaryDirectory,
    });
    try {
      await fs.writeFile(control.specification.proofPath, `${JSON.stringify({
        activeProcesses: 0,
        protocol: 'easyboost-windows-job-empty-v1',
        token: control.specification.proofToken,
      })}\n`, { flag: 'wx' });
      assert.throws(() => control.dispose(), (error) => error === removalFailure);
      assert.equal(control.proofState().state, 'absent',
        'verified exact proof must survive a partial rm that removed the proof file');
      control.dispose();
      assert.equal(removalAttempts, 2, 'the second dispose must retry exact generation cleanup');
      await assert.rejects(fs.access(path.dirname(control.specification.proofPath)), /ENOENT/u);
    } finally {
      await fs.rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

test('Windows Job control retries an exact empty directory after all sealed files disappear',
  async () => {
    const supervisor = await import(
      `../scripts/release-command-supervisor.js?empty-private-retry=${Date.now()}`
    );
    const temporaryDirectory = await fs.mkdtemp(path.join(
      os.tmpdir(), 'easyboost-job-empty-private-retry-',
    ));
    const removalFailure = new Error('synthetic failure after all generation files disappeared');
    let removalAttempts = 0;
    const control = supervisor.createWindowsJobControl({
      beforePrivateGenerationCleanup({ directory }) {
        removalAttempts += 1;
        if (removalAttempts !== 1) return;
        fsSync.rmSync(path.join(directory, 'control.json'));
        fsSync.rmSync(path.join(directory, 'job-empty.proof'));
        throw removalFailure;
      },
      temporaryDirectory,
    });
    try {
      await fs.writeFile(control.specification.proofPath, `${JSON.stringify({
        activeProcesses: 0,
        protocol: 'easyboost-windows-job-empty-v1',
        token: control.specification.proofToken,
      })}\n`, { flag: 'wx' });
      assert.throws(() => control.dispose(), (error) => error === removalFailure);
      control.dispose();
      assert.equal(removalAttempts, 2);
      await assert.rejects(fs.access(path.dirname(control.specification.proofPath)), /ENOENT/u);
    } finally {
      await fs.rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

test('Windows Job deterministic restart guard refuses reuse and live force-disposal', async () => {
  const supervisor = await import(`../scripts/release-command-supervisor.js?guard=${Date.now()}`);
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-job-guard-'));
  const control = supervisor.createWindowsJobControl({
    controlKey: 'fixture-mutating-job',
    temporaryDirectory,
  });
  try {
    control.markWrapperSpawned();
    assert.throws(() => control.dispose({ force: true }), /WINDOWS_JOB_FORCE_DISPOSE_FORBIDDEN/u);
    assert.throws(() => supervisor.createWindowsJobControl({
      controlKey: 'fixture-mutating-job',
      temporaryDirectory,
    }), (error) => {
      assert.equal(error.code, 'WINDOWS_JOB_RECOVERY_REQUIRED');
      assert.equal(error.childSettlementUnproven, true);
      assert.equal(error.recoveryAuthority?.controlDirectory,
        path.dirname(control.specification.proofPath));
      return true;
    });
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test('Windows Job explicit post-spawn authority never treats a missing root or namespace as proof',
  async (t) => {
    const [supervisor, lifecycle] = await Promise.all([
      import(`../scripts/release-command-supervisor.js?missing-authority=${Date.now()}`),
      import(`../scripts/bounded-child-lifecycle.js?missing-authority=${Date.now()}`),
    ]);

    for (const missing of ['namespace', 'root']) {
      await t.test(`missing ${missing}`, async () => {
        const temporaryDirectory = await fs.mkdtemp(path.join(
          path.resolve('test'), '.tmp-windows-job-missing-',
        ));
        try {
          const controlKey = `fixture-explicit-missing-${missing}`;
          const control = supervisor.createWindowsJobControl({ controlKey, temporaryDirectory });
          control.markWrapperSpawned();
          const recoveryAuthority = JSON.parse(JSON.stringify(control.recoveryAuthority));
          assert.match(recoveryAuthority.proofToken, /^[0-9a-f]{64}$/u,
            'post-spawn authority must be bound to one controller generation');
          const propagated = lifecycle.propagateLifecycleRecovery(Object.assign(
            new Error('fixture post-spawn failure'),
            { childSettlementUnproven: true, recoveryAuthority },
          ));
          assert.deepEqual(JSON.parse(JSON.stringify(propagated.recoveryAuthority)),
            recoveryAuthority,
            'generic lifecycle propagation must preserve the generation-bound token');
          await fs.rm(missing === 'root'
            ? temporaryDirectory
            : recoveryAuthority.controlDirectory, { force: true, recursive: true });

          assert.throws(() => supervisor.recoverWindowsJobControl({ recoveryAuthority }),
            (error) => {
              assert.equal(error?.code, 'WINDOWS_JOB_RECOVERY_REQUIRED');
              assert.equal(error?.childSettlementUnproven, true);
              assert.deepEqual(error?.recoveryAuthority, recoveryAuthority);
              return true;
            }, 'pathname absence is not token-bound child settlement evidence');

          assert.deepEqual(supervisor.recoverWindowsJobControl({
            controlKey,
            temporaryDirectory,
          }), {
            controlDirectory: recoveryAuthority.controlDirectory,
            retired: false,
            state: 'absent',
          }, 'deterministic pre-spawn discovery may still report an unused namespace');
        } finally {
          await fs.rm(temporaryDirectory, { force: true, recursive: true });
        }
      });
    }
  });

test('Windows Job typed restart recovery replays exact TERM and KILL for its live generation',
  async () => {
    const supervisor = await import(
      `../scripts/release-command-supervisor.js?restart-request-replay=${Date.now()}`
    );
    const temporaryDirectory = await fs.mkdtemp(path.join(
      path.resolve('test'), '.tmp-windows-job-request-replay-',
    ));
    const control = supervisor.createWindowsJobControl({
      controlKey: 'fixture-restart-request-replay',
      temporaryDirectory,
    });
    control.markWrapperSpawned();
    const { killRequestPath, proofPath, proofToken, termRequestPath } = control.specification;
    const responderSource = [
      "const fs = require('node:fs');",
      'const [termPath, killPath, proofPath, termValue, killValue, proofValue] = process.argv.slice(1);',
      'const deadline = Date.now() + 5_000;',
      'const timer = setInterval(() => {',
      '  if (Date.now() >= deadline) { clearInterval(timer); process.exit(2); }',
      '  try {',
      "    if (fs.readFileSync(termPath, 'utf8') !== termValue) process.exit(3);",
      "    if (fs.readFileSync(killPath, 'utf8') !== killValue) return;",
      "    fs.writeFileSync(proofPath, proofValue, { flag: 'wx', mode: 0o600 });",
      '    clearInterval(timer);',
      '    process.exit(0);',
      '  } catch (error) {',
      "    if (!['EACCES', 'EBUSY', 'ENOENT'].includes(error?.code)) process.exit(4);",
      '  }',
      '}, 5);',
    ].join('\n');
    const responderArguments = [
      '-e', responderSource,
      termRequestPath,
      killRequestPath,
      proofPath,
      `${JSON.stringify({
        protocol: 'easyboost-windows-job-control-v1',
        signal: 'SIGTERM',
        token: control.specification.controlToken,
      })}\n`,
      `${JSON.stringify({
        protocol: 'easyboost-windows-job-control-v1',
        signal: 'SIGKILL',
        token: control.specification.controlToken,
      })}\n`,
      `${JSON.stringify({
        activeProcesses: 0,
        protocol: 'easyboost-windows-job-empty-v1',
        token: proofToken,
      })}\n`,
    ];
    let responder;
    let responderExit;
    const startResponder = () => {
      if (responder) return;
      responder = spawn(process.execPath, responderArguments, {
        stdio: 'ignore', windowsHide: true,
      });
      responderExit = new Promise((resolve, reject) => {
        responder.once('error', reject);
        responder.once('close', (code, signal) => resolve({ code, signal }));
      });
    };
    try {
      let monotonicReading = 0;
      assert.throws(() => supervisor.recoverWindowsJobControl({
        recoveryAuthority: JSON.parse(JSON.stringify(control.recoveryAuthority)),
        windowsRecoveryKillGraceMs: 1,
        windowsRecoveryNow() {
          const current = monotonicReading;
          monotonicReading += 1;
          return current;
        },
        windowsRecoverySleep() {},
        windowsRecoveryTerminateGraceMs: 1,
      }), (error) => error?.code === 'WINDOWS_JOB_RECOVERY_REQUIRED',
      'the first parent must retain both exact requests without settlement proof');
      assert.deepEqual(supervisor.recoverWindowsJobControl({
        beforeWindowsRecoveryRequestPublication({ signal }) {
          if (signal === 'SIGKILL') startResponder();
        },
        recoveryAuthority: JSON.parse(JSON.stringify(control.recoveryAuthority)),
        windowsRecoveryKillGraceMs: 2_000,
        windowsRecoveryTerminateGraceMs: 25,
      }), {
        controlDirectory: control.recoveryAuthority.controlDirectory,
        retired: true,
        state: 'absent',
      });
      assert.deepEqual(await responderExit, { code: 0, signal: null });
    } finally {
      if (responder?.exitCode === null && responder.signalCode === null) responder.kill('SIGKILL');
      await responderExit?.catch(() => {});
      await fs.rm(temporaryDirectory, { force: true, recursive: true });
    }
  });

test('Windows Job restart requests preserve foreign bytes and never signal a stale generation',
  async (context) => {
    const supervisor = await import(
      `../scripts/release-command-supervisor.js?restart-request-ownership=${Date.now()}`
    );
    await context.test('foreign request bytes', async () => {
      const temporaryDirectory = await fs.mkdtemp(path.join(
        path.resolve('test'), '.tmp-windows-job-foreign-request-',
      ));
      const control = supervisor.createWindowsJobControl({
        controlKey: 'fixture-foreign-restart-request',
        temporaryDirectory,
      });
      control.markWrapperSpawned();
      try {
        await fs.writeFile(control.specification.termRequestPath, 'foreign request bytes', {
          flag: 'wx', mode: 0o600,
        });
        assert.throws(() => supervisor.recoverWindowsJobControl({
          recoveryAuthority: JSON.parse(JSON.stringify(control.recoveryAuthority)),
          windowsRecoveryKillGraceMs: 1,
          windowsRecoveryTerminateGraceMs: 1,
        }), (error) => error?.code === 'WINDOWS_JOB_RECOVERY_REQUIRED');
        assert.equal(await fs.readFile(control.specification.termRequestPath, 'utf8'),
          'foreign request bytes');
        await fs.access(control.recoveryAuthority.controlDirectory);
      } finally {
        await fs.rm(temporaryDirectory, { force: true, recursive: true });
      }
    });

    await context.test('stale typed authority', async () => {
      const temporaryDirectory = await fs.mkdtemp(path.join(
        path.resolve('test'), '.tmp-windows-job-stale-request-',
      ));
      const control = supervisor.createWindowsJobControl({
        controlKey: 'fixture-stale-restart-request',
        temporaryDirectory,
      });
      control.markWrapperSpawned();
      try {
        assert.throws(() => supervisor.recoverWindowsJobControl({
          recoveryAuthority: {
            ...JSON.parse(JSON.stringify(control.recoveryAuthority)),
            proofToken: '0'.repeat(64),
          },
          windowsRecoveryKillGraceMs: 1,
          windowsRecoveryTerminateGraceMs: 1,
        }), (error) => error?.code === 'WINDOWS_JOB_RECOVERY_REQUIRED');
        await assert.rejects(fs.access(control.specification.termRequestPath), /ENOENT/u);
        await assert.rejects(fs.access(control.specification.killRequestPath), /ENOENT/u);
        await fs.access(control.recoveryAuthority.controlDirectory);
      } finally {
        await fs.rm(temporaryDirectory, { force: true, recursive: true });
      }
    });
  });

test('Windows Job restart request publication cannot poison a concurrent successor', {
  skip: process.platform === 'win32' ? false : 'requires native Windows identity locking',
}, async () => {
  const supervisor = await import(
    `../scripts/release-command-supervisor.js?restart-request-successor=${Date.now()}`
  );
  const temporaryDirectory = await fs.mkdtemp(path.join(
    path.resolve('test'), '.tmp-windows-job-request-successor-',
  ));
  const controlKey = 'fixture-restart-request-successor';
  const control = supervisor.createWindowsJobControl({ controlKey, temporaryDirectory });
  control.markWrapperSpawned();
  const authority = JSON.parse(JSON.stringify(control.recoveryAuthority));
  const originalOpenSync = fsSync.openSync;
  let raced = false;
  let successor;
  const publishSuccessor = () => {
    if (raced) return;
    raced = true;
    fsSync.writeFileSync(control.specification.proofPath, `${JSON.stringify({
      activeProcesses: 0,
      protocol: 'easyboost-windows-job-empty-v1',
      token: control.specification.proofToken,
    })}\n`, { flag: 'wx', mode: 0o600 });
    control.dispose();
    successor = supervisor.createWindowsJobControl({ controlKey, temporaryDirectory });
    successor.markWrapperSpawned();
  };
  fsSync.openSync = (file, flags, ...args) => {
    if (file === control.specification.termRequestPath && flags === 'wx') publishSuccessor();
    return originalOpenSync.call(fsSync, file, flags, ...args);
  };
  try {
    assert.throws(() => supervisor.recoverWindowsJobControl({
      beforeWindowsRecoveryRequestPublication: publishSuccessor,
      recoveryAuthority: authority,
      windowsRecoveryKillGraceMs: 1,
      windowsRecoveryTerminateGraceMs: 1,
    }), (error) => error?.code === 'WINDOWS_JOB_RECOVERY_REQUIRED');
    assert.equal(raced, true, 'the fixture must replace generation A with successor B');
    await assert.rejects(fs.access(successor.specification.termRequestPath), /ENOENT/u,
      'generation A must not create its request inside successor B');
    await assert.rejects(fs.access(successor.specification.killRequestPath), /ENOENT/u,
      'generation A must not create its KILL request inside successor B');
    fsSync.writeFileSync(successor.specification.proofPath, `${JSON.stringify({
      activeProcesses: 0,
      protocol: 'easyboost-windows-job-empty-v1',
      token: successor.specification.proofToken,
    })}\n`, { flag: 'wx', mode: 0o600 });
    successor.dispose();
  } finally {
    fsSync.openSync = originalOpenSync;
    await fs.rm(temporaryDirectory, { force: true, recursive: true });
  }
});

test('Windows Job restart request replay stops at exact monotonic TERM and KILL bounds',
  async () => {
    const supervisor = await import(
      `../scripts/release-command-supervisor.js?restart-request-deadline=${Date.now()}`
    );
    const temporaryDirectory = await fs.mkdtemp(path.join(
      path.resolve('test'), '.tmp-windows-job-request-deadline-',
    ));
    const control = supervisor.createWindowsJobControl({
      controlKey: 'fixture-restart-request-deadline',
      temporaryDirectory,
    });
    control.markWrapperSpawned();
    let monotonicReading = 0;
    try {
      assert.throws(() => supervisor.recoverWindowsJobControl({
        recoveryAuthority: JSON.parse(JSON.stringify(control.recoveryAuthority)),
        windowsRecoveryKillGraceMs: 2,
        windowsRecoveryNow() {
          const current = monotonicReading;
          monotonicReading += 1;
          return current;
        },
        windowsRecoverySleep() {},
        windowsRecoveryTerminateGraceMs: 2,
      }), (error) => {
        assert.equal(error?.code, 'WINDOWS_JOB_RECOVERY_REQUIRED');
        assert.match(error?.cause?.message ?? '', /did not settle after bounded recovery requests/iu);
        return true;
      });
      assert.equal(monotonicReading, 6,
        'each request phase must stop after its own caller-provided monotonic bound');
      for (const [signal, requestPath] of [
        ['SIGTERM', control.specification.termRequestPath],
        ['SIGKILL', control.specification.killRequestPath],
      ]) {
        assert.equal(await fs.readFile(requestPath, 'utf8'), `${JSON.stringify({
          protocol: 'easyboost-windows-job-control-v1',
          signal,
          token: control.specification.controlToken,
        })}\n`);
      }
      await fs.access(control.recoveryAuthority.controlDirectory);
    } finally {
      await fs.rm(temporaryDirectory, { force: true, recursive: true });
    }
  });

test('Windows Job explicit recovery replays only its exact token-bound completion receipt',
  async () => {
    const supervisor = await import(
      `../scripts/release-command-supervisor.js?completion-receipt=${Date.now()}`
    );
    const temporaryDirectory = await fs.mkdtemp(path.join(
      path.resolve('test'), '.tmp-windows-job-receipt-',
    ));
    const controlKey = 'fixture-token-bound-completion-receipt';
    const control = supervisor.createWindowsJobControl({ controlKey, temporaryDirectory });
    control.markWrapperSpawned();
    const recoveryAuthority = JSON.parse(JSON.stringify(control.recoveryAuthority));
    const controlDirectory = recoveryAuthority.controlDirectory;
    try {
      await fs.writeFile(control.specification.proofPath, `${JSON.stringify({
        activeProcesses: 0,
        protocol: 'easyboost-windows-job-empty-v1',
        token: control.specification.proofToken,
      })}\n`, { flag: 'wx', mode: 0o600 });
      const directoryStat = await fs.lstat(controlDirectory, { bigint: true });
      const names = (await fs.readdir(controlDirectory)).sort();
      const files = [];
      for (const name of names) {
        const file = path.join(controlDirectory, name);
        const [contents, stat] = await Promise.all([
          fs.readFile(file),
          fs.lstat(file, { bigint: true }),
        ]);
        files.push({
          identity: {
            birthtimeNs: String(stat.birthtimeNs),
            dev: String(stat.dev),
            ino: String(stat.ino),
          },
          name,
          sha256: createHash('sha256').update(contents).digest('hex'),
          size: contents.length,
        });
      }
      const record = {
        controlDirectory,
        controlKeyHash: path.basename(controlDirectory).replace('easyboost-windows-job-', ''),
        directoryIdentity: {
          birthtimeNs: String(directoryStat.birthtimeNs),
          dev: String(directoryStat.dev),
          ino: String(directoryStat.ino),
        },
        files,
        proofToken: recoveryAuthority.proofToken,
        protocol: 'easyboost-windows-job-retirement-v2',
        retirementDirectory: recoveryAuthority.retirementDirectory,
        snapshotHash: createHash('sha256').update(JSON.stringify(files), 'utf8').digest('hex'),
      };
      await fs.rm(controlDirectory, { force: true, recursive: true });
      await fs.writeFile(recoveryAuthority.retirementProof,
        `${JSON.stringify(record)}\n`, { flag: 'wx', mode: 0o600 });

      const expected = { controlDirectory, retired: false, state: 'absent' };
      assert.deepEqual(supervisor.recoverWindowsJobControl({ recoveryAuthority }), expected);
      assert.deepEqual(supervisor.recoverWindowsJobControl({ recoveryAuthority }), expected,
        'the durable receipt must make an explicit replay idempotent');
      await fs.access(recoveryAuthority.retirementProof);

      const staleAuthority = { ...recoveryAuthority, proofToken: '0'.repeat(64) };
      assert.throws(() => supervisor.recoverWindowsJobControl({
        recoveryAuthority: staleAuthority,
      }), (error) => error?.code === 'WINDOWS_JOB_RECOVERY_REQUIRED');
      await fs.access(recoveryAuthority.retirementProof);
    } finally {
      await fs.rm(temporaryDirectory, { force: true, recursive: true });
    }
  });

test('Windows Job pre-spawn receipt contention exposes only a complete replayable generation',
  async () => {
    const supervisor = await import(
      `../scripts/release-command-supervisor.js?receipt-contention=${Date.now()}`
    );
    const temporaryDirectory = await fs.mkdtemp(path.join(
      path.resolve('test'), '.tmp-windows-job-receipt-contention-',
    ));
    const controlKey = 'fixture-pre-spawn-receipt-contention';
    const previous = supervisor.createWindowsJobControl({ controlKey, temporaryDirectory });
    let winner;
    try {
      previous.markWrapperSpawned();
      await fs.writeFile(previous.specification.proofPath, `${JSON.stringify({
        activeProcesses: 0,
        protocol: 'easyboost-windows-job-empty-v1',
        token: previous.specification.proofToken,
      })}\n`, { flag: 'wx', mode: 0o600 });
      previous.dispose();
      await fs.access(previous.recoveryAuthority.retirementProof);

      let collision;
      assert.throws(() => supervisor.createWindowsJobControl({
        controlKey,
        publishDirectory(source, destination) {
          const stagedControl = path.join(source, 'control.json');
          assert.equal(fsSync.existsSync(stagedControl), true,
            'a deterministic namespace must be complete before it becomes visible');
          assert.equal(fsSync.existsSync(destination), false);
          winner = supervisor.createWindowsJobControl({ controlKey, temporaryDirectory });
          fsSync.renameSync(source, destination);
        },
        temporaryDirectory,
      }), (error) => {
        collision = error;
        assert.equal(error?.code, 'WINDOWS_JOB_RECOVERY_REQUIRED');
        assert.equal(error?.childSettlementUnproven, true);
        assert.deepEqual(error?.recoveryAuthority, winner.recoveryAuthority,
          'the losing creator must receive the winner generation private token');
        assert.match(error?.recoveryAuthority?.proofToken, /^[0-9a-f]{64}$/u);
        return true;
      });

      const creationResidues = (await fs.readdir(temporaryDirectory)).filter(
        (name) => name.includes('.create-'),
      );
      assert.deepEqual(creationResidues, [],
        'the losing private prepublication directory must be removed');

      winner.markWrapperSpawned();
      await fs.writeFile(winner.specification.proofPath, `${JSON.stringify({
        activeProcesses: 0,
        protocol: 'easyboost-windows-job-empty-v1',
        token: winner.specification.proofToken,
      })}\n`, { flag: 'wx', mode: 0o600 });
      assert.deepEqual(supervisor.recoverWindowsJobControl({
        recoveryAuthority: collision.recoveryAuthority,
      }), {
        controlDirectory: collision.recoveryAuthority.controlDirectory,
        retired: true,
        state: 'absent',
      });
      assert.deepEqual(supervisor.recoverWindowsJobControl({
        recoveryAuthority: collision.recoveryAuthority,
      }), {
        controlDirectory: collision.recoveryAuthority.controlDirectory,
        retired: false,
        state: 'absent',
      }, 'the losing creator authority must remain restart-idempotent');

      const successor = supervisor.createWindowsJobControl({ controlKey, temporaryDirectory });
      successor.dispose({ force: true });
    } finally {
      await fs.rm(temporaryDirectory, { force: true, recursive: true });
    }
  });

test('Windows Job publication loser reports a winner that retires during collision handling',
  async () => {
    const supervisor = await import(
      `../scripts/release-command-supervisor.js?retiring-publication-winner=${Date.now()}`
    );
    const temporaryDirectory = await fs.mkdtemp(path.join(
      path.resolve('test'), '.tmp-windows-job-retiring-publication-winner-',
    ));
    const controlKey = 'fixture-retiring-publication-winner';
    let winner;
    let collisionAuthority;
    try {
      assert.throws(() => supervisor.createWindowsJobControl({
        controlKey,
        publishDirectory(source, destination) {
          winner = supervisor.createWindowsJobControl({ controlKey, temporaryDirectory });
          let collision;
          try {
            fsSync.renameSync(source, destination);
          } catch (error) {
            collision = error;
          }
          winner.markWrapperSpawned();
          fsSync.writeFileSync(winner.specification.proofPath, `${JSON.stringify({
            activeProcesses: 0,
            protocol: 'easyboost-windows-job-empty-v1',
            token: winner.specification.proofToken,
          })}\n`, { flag: 'wx', mode: 0o600 });
          winner.dispose();
          throw collision;
        },
        temporaryDirectory,
      }), (error) => {
        collisionAuthority = error?.recoveryAuthority;
        assert.equal(error?.code, 'WINDOWS_JOB_RECOVERY_REQUIRED');
        assert.deepEqual(collisionAuthority, winner.recoveryAuthority);
        return true;
      });
      assert.deepEqual(supervisor.recoverWindowsJobControl({
        recoveryAuthority: collisionAuthority,
      }), {
        controlDirectory: collisionAuthority.controlDirectory,
        retired: false,
        state: 'absent',
      });
    } finally {
      await fs.rm(temporaryDirectory, { force: true, recursive: true });
    }
  });

test('Windows Job delayed publisher rolls back before an in-flight winner retirement',
  async () => {
    const supervisor = await import(
      `../scripts/release-command-supervisor.js?inflight-retirement-publish=${Date.now()}`
    );
    const temporaryDirectory = await fs.mkdtemp(path.join(
      path.resolve('test'), '.tmp-windows-job-inflight-retirement-publish-',
    ));
    const controlKey = 'fixture-inflight-retirement-publish';
    let winnerAuthority;
    let collisionAuthority;
    try {
      assert.throws(() => supervisor.createWindowsJobControl({
        controlKey,
        publishDirectory(source, destination) {
          const winner = supervisor.createWindowsJobControl({ controlKey, temporaryDirectory });
          winner.markWrapperSpawned();
          fsSync.writeFileSync(winner.specification.proofPath, `${JSON.stringify({
            activeProcesses: 0,
            protocol: 'easyboost-windows-job-empty-v1',
            token: winner.specification.proofToken,
          })}\n`, { flag: 'wx', mode: 0o600 });
          winnerAuthority = winner.recoveryAuthority;
          assert.throws(() => supervisor.recoverWindowsJobControl({
            beforeRetirementCleanup() {
              throw new Error('fixture winner crash after retirement publication');
            },
            recoveryAuthority: winnerAuthority,
          }), (error) => error?.code === 'WINDOWS_JOB_RECOVERY_REQUIRED');
          fsSync.renameSync(source, destination);
        },
        temporaryDirectory,
      }), (error) => {
        collisionAuthority = error?.recoveryAuthority;
        assert.equal(error?.code, 'WINDOWS_JOB_RECOVERY_REQUIRED');
        assert.deepEqual(collisionAuthority, winnerAuthority,
          'rollback must expose the still-replayable retirement generation');
        return true;
      });
      assert.equal(fsSync.existsSync(winnerAuthority.controlDirectory), false,
        'the never-returned delayed generation must be removed by exact identity');
      assert.deepEqual(supervisor.recoverWindowsJobControl({
        recoveryAuthority: collisionAuthority,
      }), {
        controlDirectory: collisionAuthority.controlDirectory,
        retired: true,
        state: 'absent',
      });
    } finally {
      await fs.rm(temporaryDirectory, { force: true, recursive: true });
    }
  });

test('Windows Job publication consumes a winner receipt created after the pre-spawn check',
  async () => {
    const supervisor = await import(
      `../scripts/release-command-supervisor.js?publication-receipt-aba=${Date.now()}`
    );
    const temporaryDirectory = await fs.mkdtemp(path.join(
      path.resolve('test'), '.tmp-windows-job-publication-receipt-aba-',
    ));
    const controlKey = 'fixture-publication-receipt-aba';
    let winner;
    let successor;
    try {
      successor = supervisor.createWindowsJobControl({
        controlKey,
        publishDirectory(source, destination) {
          winner = supervisor.createWindowsJobControl({ controlKey, temporaryDirectory });
          winner.markWrapperSpawned();
          fsSync.writeFileSync(winner.specification.proofPath, `${JSON.stringify({
            activeProcesses: 0,
            protocol: 'easyboost-windows-job-empty-v1',
            token: winner.specification.proofToken,
          })}\n`, { flag: 'wx', mode: 0o600 });
          winner.dispose();
          fsSync.renameSync(source, destination);
        },
        temporaryDirectory,
      });

      assert.equal(fsSync.existsSync(successor.recoveryAuthority.controlDirectory), true);
      assert.equal(fsSync.existsSync(winner.recoveryAuthority.retirementProof), false,
        'a returned generation must not overlap the previous completion receipt');
      successor.dispose({ force: true });
    } finally {
      await fs.rm(temporaryDirectory, { force: true, recursive: true });
    }
  });

test('Windows Job publication exception rolls back before returning across a prior receipt',
  async () => {
    const supervisor = await import(
      `../scripts/release-command-supervisor.js?publication-receipt-crash=${Date.now()}`
    );
    const temporaryDirectory = await fs.mkdtemp(path.join(
      path.resolve('test'), '.tmp-windows-job-publication-receipt-crash-',
    ));
    const controlKey = 'fixture-publication-receipt-crash';
    let winner;
    let recoveryAuthority;
    try {
      assert.throws(() => supervisor.createWindowsJobControl({
        controlKey,
        publishDirectory(source, destination) {
          winner = supervisor.createWindowsJobControl({ controlKey, temporaryDirectory });
          winner.markWrapperSpawned();
          fsSync.writeFileSync(winner.specification.proofPath, `${JSON.stringify({
            activeProcesses: 0,
            protocol: 'easyboost-windows-job-empty-v1',
            token: winner.specification.proofToken,
          })}\n`, { flag: 'wx', mode: 0o600 });
          winner.dispose();
          fsSync.renameSync(source, destination);
          throw new Error('fixture crash after active generation publication');
        },
        temporaryDirectory,
      }), (error) => {
        recoveryAuthority = error?.recoveryAuthority;
        assert.equal(error?.code, 'WINDOWS_JOB_RECOVERY_REQUIRED');
        assert.deepEqual(recoveryAuthority, winner.recoveryAuthority);
        return true;
      });

      assert.equal(fsSync.existsSync(recoveryAuthority.controlDirectory), false,
        'the generation that never returned must be removed by exact identity');
      assert.deepEqual(supervisor.recoverWindowsJobControl({ recoveryAuthority }), {
        controlDirectory: recoveryAuthority.controlDirectory,
        retired: false,
        state: 'absent',
      });
    } finally {
      await fs.rm(temporaryDirectory, { force: true, recursive: true });
    }
  });

test('Windows Job concurrent receipt consumption reports the current replayable generation',
  async () => {
    const supervisor = await import(
      `../scripts/release-command-supervisor.js?concurrent-receipt-token=${Date.now()}`
    );
    const temporaryDirectory = await fs.mkdtemp(path.join(
      path.resolve('test'), '.tmp-windows-job-concurrent-receipt-token-',
    ));
    const controlKey = 'fixture-concurrent-receipt-token';
    const previous = supervisor.createWindowsJobControl({ controlKey, temporaryDirectory });
    let winner;
    try {
      previous.markWrapperSpawned();
      fsSync.writeFileSync(previous.specification.proofPath, `${JSON.stringify({
        activeProcesses: 0,
        protocol: 'easyboost-windows-job-empty-v1',
        token: previous.specification.proofToken,
      })}\n`, { flag: 'wx', mode: 0o600 });
      previous.dispose();

      assert.throws(() => supervisor.recoverWindowsJobControl({
        beforeRetirementProofDeleteLink() {
          supervisor.recoverWindowsJobControl({ controlKey, temporaryDirectory });
          winner = supervisor.createWindowsJobControl({ controlKey, temporaryDirectory });
        },
        controlKey,
        temporaryDirectory,
      }), (error) => {
        assert.equal(error?.code, 'WINDOWS_JOB_RECOVERY_REQUIRED');
        assert.deepEqual(error?.recoveryAuthority, winner.recoveryAuthority,
          'a concurrent consumer must never emit the superseded receipt token');
        return true;
      });
      winner.dispose({ force: true });
    } finally {
      await fs.rm(temporaryDirectory, { force: true, recursive: true });
    }
  });

test('Windows Job pre-launch disposal preserves a foreign directory replacement', async () => {
  const supervisor = await import(
    `../scripts/release-command-supervisor.js?prelaunch-dispose-aba=${Date.now()}`
  );
  const temporaryDirectory = await fs.mkdtemp(path.join(
    path.resolve('test'), '.tmp-windows-job-prelaunch-dispose-aba-',
  ));
  const control = supervisor.createWindowsJobControl({
    controlKey: 'fixture-prelaunch-dispose-aba',
    temporaryDirectory,
  });
  const controlDirectory = control.recoveryAuthority.controlDirectory;
  const movedGeneration = `${controlDirectory}.moved`;
  try {
    fsSync.renameSync(controlDirectory, movedGeneration);
    fsSync.mkdirSync(controlDirectory);
    fsSync.writeFileSync(path.join(controlDirectory, 'foreign.txt'), 'foreign');

    assert.throws(() => control.dispose({ force: true }));
    assert.equal(fsSync.readFileSync(path.join(controlDirectory, 'foreign.txt'), 'utf8'),
      'foreign', 'pre-launch cleanup must not recursively delete a pathname replacement');
    assert.equal(fsSync.existsSync(path.join(movedGeneration, 'control.json')), true);
  } finally {
    await fs.rm(temporaryDirectory, { force: true, recursive: true });
  }
});

test('Windows Job publication failure cleanup preserves a foreign private-path replacement',
  async () => {
    const supervisor = await import(
      `../scripts/release-command-supervisor.js?publication-cleanup-aba=${Date.now()}`
    );
    const temporaryDirectory = await fs.mkdtemp(path.join(
      path.resolve('test'), '.tmp-windows-job-publication-cleanup-aba-',
    ));
    let privateDirectory;
    let movedGeneration;
    try {
      assert.throws(() => supervisor.createWindowsJobControl({
        controlKey: 'fixture-publication-cleanup-aba',
        publishDirectory(source) {
          privateDirectory = source;
          movedGeneration = `${source}.moved`;
          fsSync.renameSync(source, movedGeneration);
          fsSync.mkdirSync(source);
          fsSync.writeFileSync(path.join(source, 'foreign.txt'), 'foreign');
          const collision = new Error('fixture publication collision after private path swap');
          collision.code = 'EEXIST';
          throw collision;
        },
        temporaryDirectory,
      }), /private generation was retained/u);
      assert.equal(fsSync.readFileSync(path.join(privateDirectory, 'foreign.txt'), 'utf8'),
        'foreign', 'publication cleanup must not recursively delete a pathname replacement');
      assert.equal(fsSync.existsSync(path.join(movedGeneration, 'control.json')), true);
    } finally {
      await fs.rm(temporaryDirectory, { force: true, recursive: true });
    }
  });

test('Windows Job restart recovery retires only an exact proven-empty deterministic control',
  async () => {
    const supervisor = await import(`../scripts/release-command-supervisor.js?recover=${Date.now()}`);
    const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-job-recover-'));
    const controlKey = 'fixture-proven-empty-job-restart';
    const control = supervisor.createWindowsJobControl({ controlKey, temporaryDirectory });
    const controlDirectory = path.dirname(control.specification.proofPath);
    try {
      control.markWrapperSpawned();
      await fs.writeFile(control.specification.proofPath, `${JSON.stringify({
        activeProcesses: 0,
        protocol: 'easyboost-windows-job-empty-v1',
        token: control.specification.proofToken,
      })}\n`, { flag: 'wx', mode: 0o600 });
      let recoveryAuthority;
      assert.throws(() => supervisor.createWindowsJobControl({
        controlKey,
        temporaryDirectory,
      }), (error) => {
        recoveryAuthority = JSON.parse(JSON.stringify(error.recoveryAuthority));
        return error?.code === 'WINDOWS_JOB_RECOVERY_REQUIRED';
      });

      const recovered = supervisor.recoverWindowsJobControl({
        recoveryAuthority,
      });
      assert.deepEqual(recovered, {
        controlDirectory,
        retired: true,
        state: 'absent',
      });
      await assert.rejects(fs.access(controlDirectory), /ENOENT/u);

      assert.deepEqual(supervisor.recoverWindowsJobControl({
        recoveryAuthority,
      }), {
        controlDirectory,
        retired: false,
        state: 'absent',
      }, 'a completed retirement must be restart-idempotent');

      const successor = supervisor.createWindowsJobControl({ controlKey, temporaryDirectory });
      successor.dispose({ force: true });
    } finally {
      await fs.rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

test('Windows Job typed authority survives generic lifecycle propagation and JSON restart',
  async () => {
    const [supervisor, lifecycle] = await Promise.all([
      import(`../scripts/release-command-supervisor.js?propagated=${Date.now()}`),
      import(`../scripts/bounded-child-lifecycle.js?propagated=${Date.now()}`),
    ]);
    const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-job-propagated-'));
    const controlKey = 'fixture-propagated-recovery-authority';
    const control = supervisor.createWindowsJobControl({ controlKey, temporaryDirectory });
    try {
      control.markWrapperSpawned();
      await fs.writeFile(control.specification.proofPath, `${JSON.stringify({
        activeProcesses: 0,
        protocol: 'easyboost-windows-job-empty-v1',
        token: control.specification.proofToken,
      })}\n`, { flag: 'wx', mode: 0o600 });
      let collision;
      assert.throws(() => supervisor.createWindowsJobControl({
        controlKey,
        temporaryDirectory,
      }), (error) => {
        collision = error;
        return error?.code === 'WINDOWS_JOB_RECOVERY_REQUIRED';
      });
      const wrapped = new AggregateError(
        [new Error('primary fixture failure'), collision],
        'fixture lifecycle aggregation',
      );
      const expectedAuthority = JSON.parse(JSON.stringify(collision.recoveryAuthority));
      const propagated = lifecycle.propagateLifecycleRecovery(wrapped);
      const recoveryAuthority = JSON.parse(JSON.stringify(propagated.recoveryAuthority));
      assert.deepEqual(recoveryAuthority, expectedAuthority);
      assert.deepEqual(supervisor.recoverWindowsJobControl({ recoveryAuthority }), {
        controlDirectory: path.dirname(control.specification.proofPath),
        retired: true,
        state: 'absent',
      });
    } finally {
      await fs.rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

test('Windows Job restart recovery leaves every unproven control residue fail-closed', async () => {
  const supervisor = await import(`../scripts/release-command-supervisor.js?unproven=${Date.now()}`);
  const fixtures = [
    {
      name: 'missing proof',
      mutate: async () => {},
    },
    {
      name: 'malformed proof',
      mutate: async (control) => fs.writeFile(control.specification.proofPath, '{broken\n', {
        flag: 'wx', mode: 0o600,
      }),
    },
    {
      name: 'mismatched proof token',
      mutate: async (control) => fs.writeFile(control.specification.proofPath,
        `${JSON.stringify({
          activeProcesses: 0,
          protocol: 'easyboost-windows-job-empty-v1',
          token: '0'.repeat(64),
        })}\n`, { flag: 'wx', mode: 0o600 }),
    },
    {
      name: 'malformed control record',
      mutate: async (control) => fs.writeFile(
        path.join(path.dirname(control.specification.proofPath), 'control.json'),
        '{broken\n',
      ),
    },
  ];

  for (const [index, fixture] of fixtures.entries()) {
    const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-job-unproven-'));
    const controlKey = `fixture-unproven-job-${index}`;
    const control = supervisor.createWindowsJobControl({ controlKey, temporaryDirectory });
    const controlDirectory = path.dirname(control.specification.proofPath);
    try {
      control.markWrapperSpawned();
      await fixture.mutate(control);
      assert.throws(() => supervisor.recoverWindowsJobControl({
        controlKey,
        temporaryDirectory,
      }), (error) => {
        assert.equal(error.code, 'WINDOWS_JOB_RECOVERY_REQUIRED', fixture.name);
        assert.equal(error.childSettlementUnproven, true, fixture.name);
        assert.equal(error.recoveryAuthority?.controlDirectory, controlDirectory, fixture.name);
        return true;
      });
      await fs.access(controlDirectory);
      assert.throws(() => supervisor.createWindowsJobControl({
        controlKey,
        temporaryDirectory,
      }), (error) => error?.code === 'WINDOWS_JOB_RECOVERY_REQUIRED');
    } finally {
      await fs.rm(temporaryDirectory, { recursive: true, force: true });
    }
  }
});

test('Windows Job retirement resumes after a crash between quarantine and cleanup', async () => {
  const supervisor = await import(`../scripts/release-command-supervisor.js?resume=${Date.now()}`);
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-job-resume-'));
  const controlKey = 'fixture-retirement-crash-restart';
  const control = supervisor.createWindowsJobControl({ controlKey, temporaryDirectory });
  const controlDirectory = path.dirname(control.specification.proofPath);
  let moved = false;
  try {
    control.markWrapperSpawned();
    await fs.writeFile(control.specification.proofPath, `${JSON.stringify({
      activeProcesses: 0,
      protocol: 'easyboost-windows-job-empty-v1',
      token: control.specification.proofToken,
    })}\n`, { flag: 'wx', mode: 0o600 });

    assert.throws(() => supervisor.recoverWindowsJobControl({
      controlKey,
      moveDirectory(source, destination) {
        fsSync.renameSync(source, destination);
        moved = true;
        throw new Error('synthetic power loss after retirement move');
      },
      temporaryDirectory,
    }), (error) => {
      assert.equal(error.code, 'WINDOWS_JOB_RECOVERY_REQUIRED');
      assert.equal(error.childSettlementUnproven, true);
      assert.equal(error.recoveryAuthority?.controlDirectory, controlDirectory);
      assert.equal(typeof error.recoveryAuthority?.retirementDirectory, 'string');
      return true;
    });
    assert.equal(moved, true);
    await assert.rejects(fs.access(controlDirectory), /ENOENT/u);
    assert.throws(() => supervisor.createWindowsJobControl({
      controlKey,
      temporaryDirectory,
    }), (error) => error?.code === 'WINDOWS_JOB_RECOVERY_REQUIRED',
    'a retained retirement namespace must block a new same-scope controller');

    assert.deepEqual(supervisor.recoverWindowsJobControl({
      controlKey,
      temporaryDirectory,
    }), {
      controlDirectory,
      retired: true,
      state: 'absent',
    });
    const successor = supervisor.createWindowsJobControl({ controlKey, temporaryDirectory });
    successor.dispose({ force: true });
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test('Windows Job retirement seal survives partial cleanup and authorizes only its quarantined inode',
  async () => {
    const supervisor = await import(`../scripts/release-command-supervisor.js?partial-recovery=${Date.now()}`);
    const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-job-partial-recover-'));
    const controlKey = 'fixture-partial-retirement-recovery';
    const control = supervisor.createWindowsJobControl({ controlKey, temporaryDirectory });
    const controlDirectory = path.dirname(control.specification.proofPath);
    let removalAttempted = false;
    try {
      control.markWrapperSpawned();
      await fs.writeFile(control.specification.proofPath, `${JSON.stringify({
        activeProcesses: 0,
        protocol: 'easyboost-windows-job-empty-v1',
        token: control.specification.proofToken,
      })}\n`, { flag: 'wx', mode: 0o600 });

      assert.throws(() => supervisor.recoverWindowsJobControl({
        controlKey,
        removeRetirementFile(file) {
          removalAttempted = true;
          fsSync.unlinkSync(file);
          throw new Error('synthetic partial recursive cleanup');
        },
        temporaryDirectory,
      }), (error) => {
        assert.equal(error.code, 'WINDOWS_JOB_RECOVERY_REQUIRED');
        assert.equal(error.childSettlementUnproven, true);
        assert.equal(error.recoveryAuthority?.controlDirectory, controlDirectory);
        assert.equal(typeof error.recoveryAuthority?.retirementDirectory, 'string');
        assert.equal(typeof error.recoveryAuthority?.retirementProof, 'string');
        return true;
      });
      assert.equal(removalAttempted, true);

      assert.deepEqual(supervisor.recoverWindowsJobControl({
        controlKey,
        temporaryDirectory,
      }), {
        controlDirectory,
        retired: true,
        state: 'absent',
      });
      const successor = supervisor.createWindowsJobControl({ controlKey, temporaryDirectory });
      successor.dispose({ force: true });
    } finally {
      await fs.rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

test('Windows Job retirement seal never authorizes unknown or changed quarantine bytes', async () => {
  const supervisor = await import(`../scripts/release-command-supervisor.js?sealed-residue=${Date.now()}`);
  const fixtures = [
    {
      mutate(directory) { fsSync.writeFileSync(path.join(directory, 'foreign.txt'), 'foreign'); },
      name: 'unknown sibling',
    },
    {
      mutate(directory) { fsSync.writeFileSync(path.join(directory, 'control.json'), 'changed\n'); },
      name: 'changed control bytes',
    },
  ];
  for (const [index, fixture] of fixtures.entries()) {
    const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-job-sealed-residue-'));
    const controlKey = `fixture-sealed-residue-${index}`;
    const control = supervisor.createWindowsJobControl({ controlKey, temporaryDirectory });
    let retirementDirectory;
    try {
      control.markWrapperSpawned();
      await fs.writeFile(control.specification.proofPath, `${JSON.stringify({
        activeProcesses: 0,
        protocol: 'easyboost-windows-job-empty-v1',
        token: control.specification.proofToken,
      })}\n`, { flag: 'wx', mode: 0o600 });
      assert.throws(() => supervisor.recoverWindowsJobControl({
        beforeRetirementCleanup(directory) {
          retirementDirectory = directory;
          fixture.mutate(directory);
        },
        controlKey,
        temporaryDirectory,
      }), (error) => error?.code === 'WINDOWS_JOB_RECOVERY_REQUIRED');

      assert.throws(() => supervisor.recoverWindowsJobControl({
        controlKey,
        temporaryDirectory,
      }), (error) => {
        assert.equal(error.code, 'WINDOWS_JOB_RECOVERY_REQUIRED', fixture.name);
        assert.equal(error.childSettlementUnproven, true, fixture.name);
        return true;
      });
      await fs.access(retirementDirectory);
      if (fixture.name === 'unknown sibling') {
        assert.equal(await fs.readFile(path.join(retirementDirectory, 'foreign.txt'), 'utf8'),
          'foreign', 'unsealed sibling must never be recursively deleted');
      } else {
        assert.equal(await fs.readFile(path.join(retirementDirectory, 'control.json'), 'utf8'),
          'changed\n', 'changed sealed bytes must never be recursively deleted');
      }
    } finally {
      await fs.rm(temporaryDirectory, { recursive: true, force: true });
    }
  }
});

test('Windows Job retirement preserves a sibling created at the empty-directory boundary', async () => {
  const supervisor = await import(`../scripts/release-command-supervisor.js?late-sibling=${Date.now()}`);
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-job-late-sibling-'));
  const controlKey = 'fixture-late-retirement-sibling';
  const control = supervisor.createWindowsJobControl({ controlKey, temporaryDirectory });
  let retirementDirectory;
  try {
    control.markWrapperSpawned();
    await fs.writeFile(control.specification.proofPath, `${JSON.stringify({
      activeProcesses: 0,
      protocol: 'easyboost-windows-job-empty-v1',
      token: control.specification.proofToken,
    })}\n`, { flag: 'wx', mode: 0o600 });
    assert.throws(() => supervisor.recoverWindowsJobControl({
      beforeRetirementDirectoryRemove(directory) {
        retirementDirectory = directory;
        fsSync.writeFileSync(path.join(directory, 'late-foreign.txt'), 'late foreign');
      },
      controlKey,
      temporaryDirectory,
    }), (error) => error?.code === 'WINDOWS_JOB_RECOVERY_REQUIRED');
    assert.equal(await fs.readFile(path.join(retirementDirectory, 'late-foreign.txt'), 'utf8'),
      'late foreign', 'the late sibling must survive the failed empty-directory removal');
    assert.throws(() => supervisor.recoverWindowsJobControl({
      controlKey,
      temporaryDirectory,
    }), (error) => error?.code === 'WINDOWS_JOB_RECOVERY_REQUIRED');
    assert.equal(await fs.readFile(path.join(retirementDirectory, 'late-foreign.txt'), 'utf8'),
      'late foreign');
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test('Windows Job retirement never deletes a source replaced after its sealed link', async () => {
  const supervisor = await import(`../scripts/release-command-supervisor.js?late-source=${Date.now()}`);
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-job-late-source-'));
  const controlKey = 'fixture-late-retirement-source';
  const control = supervisor.createWindowsJobControl({ controlKey, temporaryDirectory });
  let lateSource;
  try {
    control.markWrapperSpawned();
    await fs.writeFile(control.specification.proofPath, `${JSON.stringify({
      activeProcesses: 0,
      protocol: 'easyboost-windows-job-empty-v1',
      token: control.specification.proofToken,
    })}\n`, { flag: 'wx', mode: 0o600 });
    assert.throws(() => supervisor.recoverWindowsJobControl({
      afterRetirementFileLink({ source }) {
        if (lateSource) return;
        lateSource = source;
        fsSync.unlinkSync(source);
        fsSync.writeFileSync(source, 'late source replacement');
      },
      controlKey,
      temporaryDirectory,
    }), (error) => error?.code === 'WINDOWS_JOB_RECOVERY_REQUIRED');
    assert.equal(await fs.readFile(lateSource, 'utf8'), 'late source replacement',
      'the identity-bound delete must preserve a source replacement from its last race window');
    assert.throws(() => supervisor.recoverWindowsJobControl({
      controlKey,
      temporaryDirectory,
    }), (error) => error?.code === 'WINDOWS_JOB_RECOVERY_REQUIRED');
    assert.equal(await fs.readFile(lateSource, 'utf8'), 'late source replacement');
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test('Windows Job retirement never deletes a source replaced at unlink commit', async () => {
  const supervisor = await import(`../scripts/release-command-supervisor.js?unlink-source=${Date.now()}`);
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-job-unlink-source-'));
  const controlKey = 'fixture-retirement-source-unlink-commit';
  const control = supervisor.createWindowsJobControl({ controlKey, temporaryDirectory });
  let lateSource;
  try {
    control.markWrapperSpawned();
    await fs.writeFile(control.specification.proofPath, `${JSON.stringify({
      activeProcesses: 0,
      protocol: 'easyboost-windows-job-empty-v1',
      token: control.specification.proofToken,
    })}\n`, { flag: 'wx', mode: 0o600 });
    assert.throws(() => supervisor.recoverWindowsJobControl({
      beforeRetirementSourceUnlink({ source }) {
        if (lateSource) return;
        lateSource = source;
        fsSync.unlinkSync(source);
        fsSync.writeFileSync(source, 'late unlink-commit replacement');
      },
      controlKey,
      temporaryDirectory,
    }), (error) => error?.code === 'WINDOWS_JOB_RECOVERY_REQUIRED');
    assert.equal(await fs.readFile(lateSource, 'utf8'), 'late unlink-commit replacement');
    assert.throws(() => supervisor.recoverWindowsJobControl({
      controlKey,
      temporaryDirectory,
    }), (error) => error?.code === 'WINDOWS_JOB_RECOVERY_REQUIRED');
    assert.equal(await fs.readFile(lateSource, 'utf8'), 'late unlink-commit replacement');
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test('Windows Job native deletion holds a read-delete share that denies writers', async () => {
  const nativeSupervisor = await fs.readFile('scripts/windows-job-supervisor.ps1', 'utf8');

  assert.match(nativeSupervisor,
    /var share = FILE_SHARE_READ \| FILE_SHARE_DELETE;/u);
  assert.doesNotMatch(nativeSupervisor,
    /var share = [^;]*FILE_SHARE_WRITE/u,
    'identity-bound deletion must not permit a post-SHA writer');
});

test('Windows Job native deletion binds the expected source volume', async () => {
  const [releaseSupervisor, nativeSupervisor] = await Promise.all([
    fs.readFile('scripts/release-command-supervisor.js', 'utf8'),
    fs.readFile('scripts/windows-job-supervisor.ps1', 'utf8'),
  ]);

  assert.match(releaseSupervisor, /expectedVolumeSerial: identity\.dev/u);
  assert.match(nativeSupervisor,
    /string expectedVolumeSerial,\s*uint expectedLinks/u);
  assert.match(nativeSupervisor,
    /UInt32\.TryParse\(\s*expectedVolumeSerial,\s*NumberStyles\.None,\s*CultureInfo\.InvariantCulture,/u);
  assert.match(nativeSupervisor,
    /information\.VolumeSerialNumber != parsedVolumeSerial/u);
  assert.match(nativeSupervisor,
    /\[string\]\$_\.expectedVolumeSerial/u);
});

test('Windows Job native request publication exposes only a flushed atomic hard link', async () => {
  const nativeSupervisor = await fs.readFile('scripts/windows-job-supervisor.ps1', 'utf8');
  const publicationStart = nativeSupervisor.indexOf('public static int PublishExactControlRequest(');
  const publicationEnd = nativeSupervisor.indexOf('\n    private static ', publicationStart + 1);
  assert.ok(publicationStart >= 0 && publicationEnd > publicationStart,
    'the native request publication boundary must remain inspectable');
  const publication = nativeSupervisor.slice(publicationStart, publicationEnd);

  assert.match(publication,
    /CreateFile\(exactDirectory, 0, FILE_SHARE_READ \| FILE_SHARE_WRITE,/u,
    'the exact directory must deny DELETE sharing while its pathname is used');
  assert.match(publication, /FILE_FLAG_DELETE_ON_CLOSE/u,
    'a crash must remove an unpublished private request candidate');
  assert.match(publication, /stream\.Flush\(true\)/u,
    'the private request bytes must be durable before publication');
  assert.match(publication, /CreateHardLink\(exactRequest, temporaryPath,/u,
    'the visible request must appear through one atomic no-replace hard link');
  assert.ok(publication.indexOf('stream.Flush(true)')
      < publication.indexOf('CreateHardLink(exactRequest, temporaryPath'),
  'publication must occur only after the exact private bytes are flushed');
  assert.doesNotMatch(publication,
    /CreateFile\(exactRequest,[\s\S]*?CREATE_NEW/u,
    'a crash must never leave a partial visible request at the canonical pathname');
});

test('Windows Job native retirement uses one exact batch under one shared cleanup deadline',
  async () => {
    const [releaseSupervisor, nativeSupervisor] = await Promise.all([
      fs.readFile('scripts/release-command-supervisor.js', 'utf8'),
      fs.readFile('scripts/windows-job-supervisor.ps1', 'utf8'),
    ]);

    assert.match(releaseSupervisor,
      /easyboost-windows-job-delete-batch-v1/u);
    assert.match(releaseSupervisor,
      /function runWindowsJobDeletionBatch\([\s\S]*?cleanupBudget[\s\S]*?spawnSync\(/u);
    assert.match(releaseSupervisor,
      /pairs:\s*Object\.freeze\([\s\S]*?directory:/u,
      'all exact hard-link pairs and the retirement directory must share one native payload');
    const nativeRunnerStart = releaseSupervisor.indexOf('function runWindowsJobDeletionBatch(');
    const nativeRunnerEnd = releaseSupervisor.indexOf('\nfunction ', nativeRunnerStart + 1);
    assert.ok(nativeRunnerStart >= 0 && nativeRunnerEnd > nativeRunnerStart);
    const nativeRunner = releaseSupervisor.slice(nativeRunnerStart, nativeRunnerEnd);
    assert.equal((nativeRunner.match(/spawnSync\(/gu) ?? []).length, 1,
      'one recovery batch must start at most one native helper');
    assert.match(nativeSupervisor, /DeleteExactHardLinkBatch/u);
    assert.doesNotMatch(nativeSupervisor, /DeleteExactHardLinks\(/u,
      'the helper must not expose the former one-process-per-pair entrypoint');
  });

test('Windows Job native settlement deadline cannot be extended by wall-clock rollback',
  async () => {
    const nativeSupervisor = await fs.readFile('scripts/windows-job-supervisor.ps1', 'utf8');
    const waitStart = nativeSupervisor.indexOf('private static bool WaitForSettlement(');
    const waitEnd = nativeSupervisor.indexOf('\n    private static ', waitStart + 1);
    assert.ok(waitStart >= 0 && waitEnd > waitStart,
      'the native Job settlement boundary must remain inspectable');
    const waitForSettlement = nativeSupervisor.slice(waitStart, waitEnd);

    assert.match(nativeSupervisor, /using System\.Diagnostics;/u);
    assert.match(waitForSettlement,
      /WaitForSettlement\(IntPtr job, Stopwatch deadline, int milliseconds,/u,
      'all settlement phases must consume a caller-owned monotonic deadline');
    assert.match(waitForSettlement, /RemainingSettlementMilliseconds\(deadline, milliseconds\)/u);
    assert.match(waitForSettlement, /Thread\.Sleep\(Math\.Min\(20, remaining\)\)/u,
      'the final polling sleep must never intentionally exceed the remaining budget');
    assert.match(waitForSettlement,
      /HasControlRequest\(killRequestPath,[\s\S]*HasControlRequest\(termRequestPath,/u,
      'restart requests must remain observable after the target leader exits');
    assert.doesNotMatch(waitForSettlement, /DateTime\.(?:Now|UtcNow)/u,
      'a backward wall-clock adjustment must not extend settlement');

    const runStart = nativeSupervisor.indexOf('public static int Run(');
    const runEnd = nativeSupervisor.indexOf('\n  }\n}', runStart);
    assert.ok(runStart >= 0 && runEnd > runStart);
    const nativeRun = nativeSupervisor.slice(runStart, runEnd);
    assert.match(nativeRun, /var completionDeadline = Stopwatch\.StartNew\(\);/u);
    assert.match(nativeRun,
      /WaitForSettlement\(job, completionDeadline, passiveMilliseconds,/u);
    assert.match(nativeRun,
      /WaitForSettlement\(job, completionDeadline, settlementMilliseconds,/u,
      'passive and forced settlement must share one Stopwatch budget');
    assert.doesNotMatch(nativeRun, /WaitForSettlement\(job, settlementMilliseconds\)/u,
      'no settlement phase may silently restart the full caller budget');
  });

test('Windows Job shared cleanup budget ignores wall-clock rollback and rejects invalid monotonic time',
  async (context) => {
    const supervisor = await import(
      `../scripts/release-command-supervisor.js?cleanup-clock=${Date.now()}`
    );
    let wallClock = 50_000;
    context.mock.method(Date, 'now', () => wallClock);
    const forwardReadings = [1_000, 1_125];
    const budget = supervisor.createWindowsJobCleanupBudget(30_000, {
      monotonicNow: () => forwardReadings.shift(),
    });

    wallClock = 100;
    assert.equal(budget.remainingMilliseconds(), 29_875);

    const backwardReadings = [2_000, 2_125, 2_124];
    const backwardBudget = supervisor.createWindowsJobCleanupBudget(30_000, {
      monotonicNow: () => backwardReadings.shift(),
    });
    assert.equal(backwardBudget.remainingMilliseconds(), 29_875);
    assert.throws(() => backwardBudget.remainingMilliseconds(), /moved backwards/iu);

    for (const invalid of [Number.NaN, Number.POSITIVE_INFINITY, -1, '1000']) {
      assert.throws(() => supervisor.createWindowsJobCleanupBudget(30_000, {
        monotonicNow: () => invalid,
      }), /clock reading is invalid/iu);
    }
  });

test('Windows Job sealed manifest binds crash-resumed files to their original identity', async () => {
  const releaseSupervisor = await fs.readFile('scripts/release-command-supervisor.js', 'utf8');

  assert.match(releaseSupervisor,
    /function windowsJobFileManifest\(names, records, identities\)/u);
  assert.match(releaseSupervisor,
    /identity:\s*identities\.get\(name\)/u);
  assert.match(releaseSupervisor,
    /expectedBirthtimeNs:\s*identity\.birthtimeNs/u);
  assert.match(releaseSupervisor,
    /function validateWindowsJobRetiredFile[\s\S]*?sameWindowsJobDirectoryIdentity/u);
});

test('Windows Job native deletion rejects a source replaced after final JS validation', async () => {
  const supervisor = await import(`../scripts/release-command-supervisor.js?native-open-source=${Date.now()}`);
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-job-native-open-source-'));
  const controlKey = 'fixture-retirement-source-native-open';
  const control = supervisor.createWindowsJobControl({ controlKey, temporaryDirectory });
  let lateSource;
  try {
    control.markWrapperSpawned();
    await fs.writeFile(control.specification.proofPath, `${JSON.stringify({
      activeProcesses: 0,
      protocol: 'easyboost-windows-job-empty-v1',
      token: control.specification.proofToken,
    })}\n`, { flag: 'wx', mode: 0o600 });
    assert.throws(() => supervisor.recoverWindowsJobControl({
      beforeRetirementSourceDeleteOpen({ source }) {
        if (lateSource) return;
        lateSource = source;
        fsSync.unlinkSync(source);
        fsSync.writeFileSync(source, 'late native-open replacement');
      },
      controlKey,
      temporaryDirectory,
    }), (error) => error?.code === 'WINDOWS_JOB_RECOVERY_REQUIRED');
    assert.equal(await fs.readFile(lateSource, 'utf8'), 'late native-open replacement');
    assert.throws(() => supervisor.recoverWindowsJobControl({
      controlKey,
      temporaryDirectory,
    }), (error) => error?.code === 'WINDOWS_JOB_RECOVERY_REQUIRED');
    assert.equal(await fs.readFile(lateSource, 'utf8'), 'late native-open replacement');
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test('Windows Job sealed file handoff never replaces a late deletion-name sibling', async () => {
  const supervisor = await import(`../scripts/release-command-supervisor.js?late-handoff=${Date.now()}`);
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-job-late-handoff-'));
  const controlKey = 'fixture-late-retirement-handoff';
  const control = supervisor.createWindowsJobControl({ controlKey, temporaryDirectory });
  let lateFile;
  try {
    control.markWrapperSpawned();
    await fs.writeFile(control.specification.proofPath, `${JSON.stringify({
      activeProcesses: 0,
      protocol: 'easyboost-windows-job-empty-v1',
      token: control.specification.proofToken,
    })}\n`, { flag: 'wx', mode: 0o600 });
    assert.throws(() => supervisor.recoverWindowsJobControl({
      beforeRetirementFileLink({ deletion }) {
        if (lateFile) return;
        lateFile = deletion;
        fsSync.writeFileSync(lateFile, 'late deletion-name sibling');
      },
      controlKey,
      temporaryDirectory,
    }), (error) => error?.code === 'WINDOWS_JOB_RECOVERY_REQUIRED');
    assert.equal(await fs.readFile(lateFile, 'utf8'), 'late deletion-name sibling',
      'atomic no-replace handoff must preserve the late destination');
    assert.throws(() => supervisor.recoverWindowsJobControl({
      controlKey,
      temporaryDirectory,
    }), (error) => error?.code === 'WINDOWS_JOB_RECOVERY_REQUIRED');
    assert.equal(await fs.readFile(lateFile, 'utf8'), 'late deletion-name sibling');
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test('Windows Job sealed file handoff resumes after a crash with both hard links', async () => {
  const supervisor = await import(`../scripts/release-command-supervisor.js?dual-link=${Date.now()}`);
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-job-dual-link-'));
  const controlKey = 'fixture-dual-link-retirement-handoff';
  const control = supervisor.createWindowsJobControl({ controlKey, temporaryDirectory });
  let linkedFiles;
  try {
    control.markWrapperSpawned();
    await fs.writeFile(control.specification.proofPath, `${JSON.stringify({
      activeProcesses: 0,
      protocol: 'easyboost-windows-job-empty-v1',
      token: control.specification.proofToken,
    })}\n`, { flag: 'wx', mode: 0o600 });
    assert.throws(() => supervisor.recoverWindowsJobControl({
      afterRetirementFileLink(files) {
        if (linkedFiles) return;
        linkedFiles = files;
        throw new Error('synthetic power loss after retirement file link');
      },
      controlKey,
      temporaryDirectory,
    }), (error) => error?.code === 'WINDOWS_JOB_RECOVERY_REQUIRED');

    const source = await fs.stat(linkedFiles.source, { bigint: true });
    const deletion = await fs.stat(linkedFiles.deletion, { bigint: true });
    assert.equal(source.nlink, 2n);
    assert.equal(deletion.nlink, 2n);
    assert.equal(source.dev, deletion.dev);
    assert.equal(source.ino, deletion.ino);

    assert.deepEqual(supervisor.recoverWindowsJobControl({
      controlKey,
      temporaryDirectory,
    }), {
      controlDirectory: path.dirname(control.specification.proofPath),
      retired: true,
      state: 'absent',
    });
    const successor = supervisor.createWindowsJobControl({ controlKey, temporaryDirectory });
    successor.dispose({ force: true });
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test('Windows Job retirement proof publication never replaces a late destination', async () => {
  const supervisor = await import(`../scripts/release-command-supervisor.js?late-proof=${Date.now()}`);
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-job-late-proof-'));
  const controlKey = 'fixture-late-retirement-proof';
  const control = supervisor.createWindowsJobControl({ controlKey, temporaryDirectory });
  let lateProof;
  try {
    control.markWrapperSpawned();
    await fs.writeFile(control.specification.proofPath, `${JSON.stringify({
      activeProcesses: 0,
      protocol: 'easyboost-windows-job-empty-v1',
      token: control.specification.proofToken,
    })}\n`, { flag: 'wx', mode: 0o600 });
    assert.throws(() => supervisor.recoverWindowsJobControl({
      beforeRetirementProofLink({ proof }) {
        lateProof = proof;
        fsSync.writeFileSync(proof, 'late unsafe retirement proof');
      },
      controlKey,
      temporaryDirectory,
    }), (error) => error?.code === 'WINDOWS_JOB_RECOVERY_REQUIRED');
    assert.equal(await fs.readFile(lateProof, 'utf8'), 'late unsafe retirement proof',
      'atomic no-replace proof publication must preserve the late destination');
    await fs.access(`${lateProof}.pending`);

    assert.throws(() => supervisor.recoverWindowsJobControl({
      controlKey,
      temporaryDirectory,
    }), (error) => error?.code === 'WINDOWS_JOB_RECOVERY_REQUIRED');
    assert.equal(await fs.readFile(lateProof, 'utf8'), 'late unsafe retirement proof');
    await fs.access(`${lateProof}.pending`);
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test('Windows Job retirement proof publication resumes from an exact dual-link state', async () => {
  const supervisor = await import(`../scripts/release-command-supervisor.js?dual-proof=${Date.now()}`);
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-job-dual-proof-'));
  const controlKey = 'fixture-dual-retirement-proof';
  const control = supervisor.createWindowsJobControl({ controlKey, temporaryDirectory });
  let linkedProofs;
  try {
    control.markWrapperSpawned();
    await fs.writeFile(control.specification.proofPath, `${JSON.stringify({
      activeProcesses: 0,
      protocol: 'easyboost-windows-job-empty-v1',
      token: control.specification.proofToken,
    })}\n`, { flag: 'wx', mode: 0o600 });
    assert.throws(() => supervisor.recoverWindowsJobControl({
      afterRetirementProofLink(files) {
        linkedProofs = files;
        throw new Error('synthetic power loss after retirement proof link');
      },
      controlKey,
      temporaryDirectory,
    }), (error) => error?.code === 'WINDOWS_JOB_RECOVERY_REQUIRED');

    const pending = await fs.stat(linkedProofs.pending, { bigint: true });
    const proof = await fs.stat(linkedProofs.proof, { bigint: true });
    assert.equal(pending.nlink, 2n);
    assert.equal(proof.nlink, 2n);
    assert.equal(pending.dev, proof.dev);
    assert.equal(pending.ino, proof.ino);

    assert.deepEqual(supervisor.recoverWindowsJobControl({
      controlKey,
      temporaryDirectory,
    }), {
      controlDirectory: path.dirname(control.specification.proofPath),
      retired: true,
      state: 'absent',
    });
    const successor = supervisor.createWindowsJobControl({ controlKey, temporaryDirectory });
    successor.dispose({ force: true });
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test('Windows Job retirement never deletes pending proof replaced at unlink commit', async () => {
  const supervisor = await import(`../scripts/release-command-supervisor.js?pending-unlink=${Date.now()}`);
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-job-pending-unlink-'));
  const controlKey = 'fixture-retirement-pending-unlink-commit';
  const control = supervisor.createWindowsJobControl({ controlKey, temporaryDirectory });
  let latePending;
  try {
    control.markWrapperSpawned();
    await fs.writeFile(control.specification.proofPath, `${JSON.stringify({
      activeProcesses: 0,
      protocol: 'easyboost-windows-job-empty-v1',
      token: control.specification.proofToken,
    })}\n`, { flag: 'wx', mode: 0o600 });
    assert.throws(() => supervisor.recoverWindowsJobControl({
      beforeRetirementPendingUnlinkCommit({ source }) {
        latePending = source;
        fsSync.unlinkSync(source);
        fsSync.writeFileSync(source, 'late pending unlink-commit replacement');
      },
      controlKey,
      temporaryDirectory,
    }), (error) => error?.code === 'WINDOWS_JOB_RECOVERY_REQUIRED');
    assert.equal(await fs.readFile(latePending, 'utf8'),
      'late pending unlink-commit replacement');
    assert.throws(() => supervisor.recoverWindowsJobControl({
      controlKey,
      temporaryDirectory,
    }), (error) => error?.code === 'WINDOWS_JOB_RECOVERY_REQUIRED');
    assert.equal(await fs.readFile(latePending, 'utf8'),
      'late pending unlink-commit replacement');
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test('Windows Job retirement preserves a proof replaced at the empty-directory boundary', async () => {
  const supervisor = await import(`../scripts/release-command-supervisor.js?late-proof-cleanup=${Date.now()}`);
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-job-late-proof-cleanup-'));
  const controlKey = 'fixture-late-retirement-proof-cleanup';
  const control = supervisor.createWindowsJobControl({ controlKey, temporaryDirectory });
  const controlDirectory = path.dirname(control.specification.proofPath);
  const retirementProof = path.join(
    path.dirname(controlDirectory), `.${path.basename(controlDirectory)}.retired.proof`,
  );
  try {
    control.markWrapperSpawned();
    await fs.writeFile(control.specification.proofPath, `${JSON.stringify({
      activeProcesses: 0,
      protocol: 'easyboost-windows-job-empty-v1',
      token: control.specification.proofToken,
    })}\n`, { flag: 'wx', mode: 0o600 });
    assert.throws(() => supervisor.recoverWindowsJobControl({
      beforeRetirementDirectoryRemove() {
        fsSync.unlinkSync(retirementProof);
        fsSync.writeFileSync(retirementProof, 'late foreign retirement proof');
      },
      controlKey,
      temporaryDirectory,
    }), (error) => error?.code === 'WINDOWS_JOB_RECOVERY_REQUIRED');
    assert.equal(await fs.readFile(retirementProof, 'utf8'), 'late foreign retirement proof');
    assert.throws(() => supervisor.recoverWindowsJobControl({
      controlKey,
      temporaryDirectory,
    }), (error) => error?.code === 'WINDOWS_JOB_RECOVERY_REQUIRED');
    assert.equal(await fs.readFile(retirementProof, 'utf8'), 'late foreign retirement proof');
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test('Windows Job retirement preserves pending proof replaced before normalization', async () => {
  const supervisor = await import(`../scripts/release-command-supervisor.js?late-pending-cleanup=${Date.now()}`);
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-job-late-pending-'));
  const controlKey = 'fixture-late-retirement-pending-cleanup';
  const control = supervisor.createWindowsJobControl({ controlKey, temporaryDirectory });
  let pendingProof;
  try {
    control.markWrapperSpawned();
    await fs.writeFile(control.specification.proofPath, `${JSON.stringify({
      activeProcesses: 0,
      protocol: 'easyboost-windows-job-empty-v1',
      token: control.specification.proofToken,
    })}\n`, { flag: 'wx', mode: 0o600 });
    assert.throws(() => supervisor.recoverWindowsJobControl({
      beforeRetirementPendingUnlink({ source }) {
        pendingProof = source;
        fsSync.unlinkSync(source);
        fsSync.writeFileSync(source, 'late foreign pending proof');
      },
      controlKey,
      temporaryDirectory,
    }), (error) => error?.code === 'WINDOWS_JOB_RECOVERY_REQUIRED');
    assert.equal(await fs.readFile(pendingProof, 'utf8'), 'late foreign pending proof');
    assert.throws(() => supervisor.recoverWindowsJobControl({
      controlKey,
      temporaryDirectory,
    }), (error) => error?.code === 'WINDOWS_JOB_RECOVERY_REQUIRED');
    assert.equal(await fs.readFile(pendingProof, 'utf8'), 'late foreign pending proof');
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test('Windows Job completion proof retirement resumes after quarantine removal', async () => {
  const supervisor = await import(`../scripts/release-command-supervisor.js?proof-cleanup-resume=${Date.now()}`);
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-job-proof-cleanup-resume-'));
  const controlKey = 'fixture-retirement-proof-cleanup-resume';
  const control = supervisor.createWindowsJobControl({ controlKey, temporaryDirectory });
  let retirementProof;
  try {
    control.markWrapperSpawned();
    await fs.writeFile(control.specification.proofPath, `${JSON.stringify({
      activeProcesses: 0,
      protocol: 'easyboost-windows-job-empty-v1',
      token: control.specification.proofToken,
    })}\n`, { flag: 'wx', mode: 0o600 });
    assert.throws(() => supervisor.recoverWindowsJobControl({
      afterRetirementDirectoryRemove() {
        throw new Error('synthetic power loss after quarantine removal');
      },
      controlKey,
      temporaryDirectory,
    }), (error) => {
      retirementProof = error?.recoveryAuthority?.retirementProof;
      return error?.code === 'WINDOWS_JOB_RECOVERY_REQUIRED';
    });
    await fs.access(retirementProof);
    assert.deepEqual(supervisor.recoverWindowsJobControl({
      controlKey,
      temporaryDirectory,
    }), {
      controlDirectory: path.dirname(control.specification.proofPath),
      retired: true,
      state: 'absent',
    });
    const successor = supervisor.createWindowsJobControl({ controlKey, temporaryDirectory });
    successor.dispose({ force: true });
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test('Windows Job completion never deletes retirement proof replaced at delete commit', async () => {
  const supervisor = await import(`../scripts/release-command-supervisor.js?proof-delete=${Date.now()}`);
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-job-proof-delete-'));
  const controlKey = 'fixture-retirement-proof-delete-commit';
  const control = supervisor.createWindowsJobControl({ controlKey, temporaryDirectory });
  let lateProof;
  try {
    control.markWrapperSpawned();
    await fs.writeFile(control.specification.proofPath, `${JSON.stringify({
      activeProcesses: 0,
      protocol: 'easyboost-windows-job-empty-v1',
      token: control.specification.proofToken,
    })}\n`, { flag: 'wx', mode: 0o600 });
    if (process.platform !== 'win32') {
      assert.deepEqual(supervisor.recoverWindowsJobControl({
        controlKey,
        temporaryDirectory,
      }), {
        controlDirectory: path.dirname(control.specification.proofPath),
        retired: true,
        state: 'absent',
      });
    }
    assert.throws(() => supervisor.recoverWindowsJobControl({
      beforeRetirementProofDeleteCommit({ proof }) {
        lateProof = proof;
        fsSync.unlinkSync(proof);
        fsSync.writeFileSync(proof, 'late proof delete-commit replacement');
      },
      controlKey,
      temporaryDirectory,
    }), (error) => error?.code === 'WINDOWS_JOB_RECOVERY_REQUIRED');
    assert.equal(await fs.readFile(lateProof, 'utf8'),
      'late proof delete-commit replacement');
    assert.throws(() => supervisor.recoverWindowsJobControl({
      controlKey,
      temporaryDirectory,
    }), (error) => error?.code === 'WINDOWS_JOB_RECOVERY_REQUIRED');
    assert.equal(await fs.readFile(lateProof, 'utf8'),
      'late proof delete-commit replacement');
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test('Windows Job completion recovery rejects a late pending proof residue', async () => {
  const supervisor = await import(`../scripts/release-command-supervisor.js?late-completion-pending=${Date.now()}`);
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-job-late-completion-pending-'));
  const controlKey = 'fixture-late-completion-pending';
  const control = supervisor.createWindowsJobControl({ controlKey, temporaryDirectory });
  let latePending;
  try {
    control.markWrapperSpawned();
    await fs.writeFile(control.specification.proofPath, `${JSON.stringify({
      activeProcesses: 0,
      protocol: 'easyboost-windows-job-empty-v1',
      token: control.specification.proofToken,
    })}\n`, { flag: 'wx', mode: 0o600 });
    assert.throws(() => supervisor.recoverWindowsJobControl({
      afterRetirementDirectoryRemove() {
        throw new Error('synthetic power loss after quarantine removal');
      },
      controlKey,
      temporaryDirectory,
    }), (error) => error?.code === 'WINDOWS_JOB_RECOVERY_REQUIRED');

    assert.throws(() => supervisor.recoverWindowsJobControl({
      beforeRetirementProofDeleteLink({ proof }) {
        latePending = `${proof}.pending`;
        fsSync.writeFileSync(latePending, 'late foreign pending proof');
      },
      controlKey,
      temporaryDirectory,
    }), (error) => error?.code === 'WINDOWS_JOB_RECOVERY_REQUIRED');
    assert.equal(await fs.readFile(latePending, 'utf8'), 'late foreign pending proof');
    assert.throws(() => supervisor.recoverWindowsJobControl({
      controlKey,
      temporaryDirectory,
    }), (error) => error?.code === 'WINDOWS_JOB_RECOVERY_REQUIRED');
    assert.equal(await fs.readFile(latePending, 'utf8'), 'late foreign pending proof');
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test('Windows bounded authority does not cache empty proof before disposal succeeds', async () => {
  const lifecycle = await import(`../scripts/bounded-child-lifecycle.js?dispose-retry=${Date.now()}`);
  const child = new EventEmitter();
  child.pid = 4494;
  const removalFailure = new Error('synthetic bounded controller disposal failure');
  let disposeAttempts = 0;
  const windowsJobControl = {
    dispose() {
      disposeAttempts += 1;
      if (disposeAttempts === 1) throw removalFailure;
    },
    proofState() { return { state: 'absent' }; },
    request() {},
    specification: {},
  };
  const spawned = lifecycle.spawnBoundedChild('fixture', [], {
    forceWindowsJob: true,
    platform: 'win32',
    spawnProcess() { return child; },
    stdio: 'ignore',
    windowsJobInvocation() {
      return { args: [], command: 'fixture-wrapper', windowsJobControl };
    },
  });
  child.emit('close', 0, null);
  assert.throws(() => spawned.authority.state(), (error) => error === removalFailure);
  assert.equal(spawned.authority.state(), 'absent');
  assert.equal(disposeAttempts, 2, 'settlement must retry the failed directory removal');
});

test('Windows database authority requires Job-empty proof in addition to wrapper close', async () => {
  const lifecycle = await import(`../scripts/bounded-child-lifecycle.js?job-proof=${Date.now()}`);
  const child = new EventEmitter();
  child.pid = 4545;
  child.kill = () => { throw new Error('Windows Job controller must own termination'); };
  let jobEmptyProven = false;
  const requests = [];
  const recoveryAuthority = windowsJobRecoveryAuthorityFixture(
    path.join(os.tmpdir(), 'durable-database-job-root'), 'c',
  );
  const windowsJobControl = {
    dispose() {},
    proofState() { return { state: jobEmptyProven ? 'absent' : 'unknown' }; },
    recoveryAuthority,
    request(signal) { requests.push(signal); },
    specification: { proofPath: path.join(recoveryAuthority.controlDirectory, 'job-empty.proof') },
  };
  const spawned = lifecycle.spawnBoundedChild('fixture', [], {
    forceWindowsJob: true,
    platform: 'win32',
    spawnProcess() { return child; },
    stdio: 'ignore',
    windowsJobInvocation() {
      return { args: [], command: 'fixture-wrapper', windowsJobControl };
    },
  });
  assert.deepEqual(spawned.authority.recoveryAuthority, recoveryAuthority,
    'the database lifecycle must expose the same directly replayable typed authority');
  let closed = false;
  child.emit('close', 0, null);
  closed = true;
  assert.equal(lifecycle.isBoundedChildSettled({
    authority: spawned.authority,
    isClosed: () => closed,
  }), false, 'wrapper close without controller proof must remain unproven');
  jobEmptyProven = true;
  assert.equal(lifecycle.isBoundedChildSettled({
    authority: spawned.authority,
    isClosed: () => closed,
  }), true);
  assert.deepEqual(requests, []);
});

test('native database child authority reaps a real descendant tree', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-db-native-tree-'));
  const leaderPidFile = path.join(directory, 'leader.pid');
  const descendantPidFile = path.join(directory, 'descendant.pid');
  let child;
  let leaderPid;
  let descendantPid;
  try {
    const descendant = await fixtureScript(directory, 'descendant.mjs', [
      'import fs from "node:fs";',
      'fs.writeFileSync(process.env.DESCENDANT_PID_FILE, String(process.pid));',
      'process.on("SIGTERM", () => {});',
      'setInterval(() => {}, 1000);',
      '',
    ].join('\n'));
    const leader = await fixtureScript(directory, 'leader.mjs', [
      'import { spawn } from "node:child_process";',
      'import fs from "node:fs";',
      'fs.writeFileSync(process.env.LEADER_PID_FILE, String(process.pid));',
      `spawn(process.execPath, [${JSON.stringify(descendant)}], { env: process.env, stdio: "ignore" });`,
      'process.on("SIGTERM", () => {});',
      'setInterval(() => {}, 1000);',
      '',
    ].join('\n'));
    const lifecycle = await import(`../scripts/bounded-child-lifecycle.js?native-tree=${Date.now()}`);
    const spawned = lifecycle.spawnBoundedChild(process.execPath, [leader], {
      cwd: directory,
      environment: {
        ...process.env,
        DESCENDANT_PID_FILE: descendantPidFile,
        LEADER_PID_FILE: leaderPidFile,
      },
      killGraceMs: 100,
      reapTimeoutMs: 1_000,
      stdio: 'ignore',
    });
    child = spawned.child;
    assert.equal(
      spawned.authority.kind,
      process.platform === 'win32'
        ? 'windows-job-object-wrapper'
        : 'posix-owned-session-wrapper',
    );
    let closed = false;
    const closeOutcome = new Promise((resolve) => {
      child.once('close', (exitCode, signal) => {
        closed = true;
        resolve({ exitCode, signal });
      });
    });
    leaderPid = await waitForFile(leaderPidFile);
    descendantPid = await waitForFile(descendantPidFile);

    const cleanupError = await lifecycle.terminateAndReapChild({
      authority: spawned.authority,
      child,
      closeOutcome,
      commandLabel: 'native database fixture command',
      isClosed: () => closed,
      killGraceMs: 100,
      reapTimeoutMs: 1_000,
    });
    assert.equal(cleanupError, null, cleanupError?.stack);
    for (const pid of [leaderPid, descendantPid]) {
      assert.throws(() => process.kill(pid, 0), (error) => error?.code === 'ESRCH',
        `process ${pid} must already be absent when Job-empty cleanup returns`);
    }
  } finally {
    for (const pid of [descendantPid, leaderPid, child?.pid]) {
      if (!Number.isSafeInteger(pid) || pid < 1) continue;
      try { process.kill(pid, 'SIGKILL'); } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
    }
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('a child that closes stdin and exits zero cannot accept a partial build context', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-build-child-early-'));
  try {
    const script = await fixtureScript(directory, 'early.mjs', 'process.stdin.destroy(); process.exit(0);\n');
    await assert.rejects(runDockerBuild(
      process.execPath, [script], { cwd: directory, env: {}, shell: false }, finiteContext(16),
      lifecycleOptions(),
    ), /input|stdin|closed|complete/iu);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('a child that consumes the full context but fails is not accepted as a build', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-build-child-fail-'));
  try {
    const script = await fixtureScript(directory, 'fail.mjs', [
      'process.stdin.resume();',
      'process.stdin.on("end", () => process.exit(7));',
      '',
    ].join('\n'));
    await assert.rejects(runDockerBuild(
      process.execPath, [script], { cwd: directory, env: {}, shell: false }, finiteContext(),
      lifecycleOptions({ hardTimeoutMs: 4_000 }),
    ), /status 7|exited.*7|failed/iu);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('context generation and Docker failure are both preserved after the child is reaped',
  async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-build-child-dual-fail-'));
    const pidFile = path.join(directory, 'pid');
    try {
      const script = await fixtureScript(directory, 'dual-fail.mjs', [
        'import fs from "node:fs";',
        'fs.writeFileSync(process.env.PID_FILE, String(process.pid));',
        'process.stdin.on("error", () => {});',
        'process.stdin.resume();',
        'setTimeout(() => process.exit(7), 80);',
        '',
      ].join('\n'));
      async function* failingContext() {
        yield Buffer.alloc(64 * 1024, 0x61);
        await new Promise((resolve) => setTimeout(resolve, 10));
        throw new Error('immutable context generator primary');
      }
      await assert.rejects(runDockerBuild(
        process.execPath, [script], {
          cwd: directory, env: { PID_FILE: pidFile }, shell: false,
        }, failingContext(), lifecycleOptions({ hardTimeoutMs: 4_000 }),
      ), (error) => {
        assert.ok(error instanceof AggregateError, error?.stack);
        assert.equal(error.errors.length, 2);
        assert.match(error.errors[0].message, /immutable context|stdin|pipeline/iu);
        assert.match(error.errors[0].cause?.message ?? '', /immutable context generator primary/u);
        assert.match(error.errors[1].message, /status 7/iu);
        return true;
      });
      await waitForExit(Number(await fs.readFile(pidFile, 'utf8')));
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

test('a child spawn failure is bounded and sanitizes the unavailable command', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-build-child-spawn-'));
  const unavailable = path.join(directory, 'private-build-runner-sentinel');
  try {
    const windowsJobControl = {
      dispose() {},
      markWrapperSpawned() {},
      proofState() { return { state: 'absent' }; },
      request() {},
      specification: {
        proofPath: path.join(directory, 'never-launched-job', 'job-empty.proof'),
      },
    };
    const started = Date.now();
    await assert.rejects(runDockerBuild(
      unavailable, [], { cwd: directory, env: {}, shell: false }, finiteContext(),
      lifecycleOptions({
        forceWindowsJob: true,
        platform: 'win32',
        spawnProcess() { throw new Error('synthetic unavailable wrapper command'); },
        windowsJobInvocation() {
          return { args: [], command: unavailable, windowsJobControl };
        },
      }),
    ), (error) => {
      assert.match(error.message, /start|spawn|unavailable|failed/iu);
      assert.doesNotMatch(error.message, /private-build-runner-sentinel/u);
      return true;
    });
    assert.ok(Date.now() - started < 2_000, 'spawn failure exceeded the lifecycle bound');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

for (const [label, source] of [
  ['never reads', [
    'import fs from "node:fs";',
    'process.on("SIGTERM", () => {});',
    'fs.writeFileSync(`${process.env.PID_FILE}.tmp`, String(process.pid));',
    'fs.renameSync(`${process.env.PID_FILE}.tmp`, process.env.PID_FILE);',
    'setInterval(() => {}, 1000);',
  ].join('\n')],
  ['reads once then hangs', [
    'import fs from "node:fs";',
    'process.on("SIGTERM", () => {});',
    'fs.writeFileSync(`${process.env.PID_FILE}.tmp`, String(process.pid));',
    'fs.renameSync(`${process.env.PID_FILE}.tmp`, process.env.PID_FILE);',
    'process.stdin.once("data", () => { process.stdin.pause(); });',
    'setInterval(() => {}, 1000);',
  ].join('\n')],
]) {
  test(`build child that ${label} is TERM→KILL bounded and reaped`, async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-build-child-hang-'));
    const pidFile = path.join(directory, 'pid');
    const secretSentinel = 'private-child-diagnostic-value';
    try {
      const script = await fixtureScript(directory, 'hang.mjs', source);
      const started = Date.now();
      await assert.rejects(runDockerBuild(
        process.execPath, [script], {
          cwd: directory,
          env: { PID_FILE: pidFile, SECRET_SENTINEL: secretSentinel },
          shell: false,
        }, finiteContext(32), lifecycleOptions({ hardTimeoutMs: 700 }),
      ), (error) => {
        assert.match(error.message, /timeout|deadline|progress/iu);
        assert.doesNotMatch(error.message, new RegExp(secretSentinel, 'u'));
        return true;
      });
      assert.ok(Date.now() - started < 5_000,
        `${label} exceeded the hard lifecycle and native cleanup bound`);
      const pid = await readOptionalPid(pidFile);
      // Under load the hard deadline may reap the child before its first JavaScript statement.
      // If it did start the fixture, its announced PID must no longer be alive.
      if (pid !== null) await waitForExit(pid, { timeoutMs: 5_000 });
    } finally {
      await fs.rm(directory, {
        force: true,
        maxRetries: 20,
        recursive: true,
        retryDelay: 25,
      });
    }
  });
}
