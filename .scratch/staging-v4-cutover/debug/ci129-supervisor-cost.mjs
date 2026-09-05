// Local ticket20 attribution only [DEBUG-ci129-cost]. No production repair.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { statSync, writeSync } from 'node:fs';
import fs from 'node:fs/promises';
import { Session } from 'node:inspector';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { HELPER_BUNDLE_FILES } from '../../../scripts/staging-helper-bundle.js';
import { removeFixture, requireComponentSuccess } from '../diagnostics/native-bounded-timing.mjs';

const thisFile = fileURLToPath(import.meta.url);
const ms = (value) => +value.toFixed(2);
const epoch = () => performance.timeOrigin + performance.now();
const cpu = (before) => {
  const value = process.cpuUsage(before);
  return (value.user + value.system) / 1000;
};
function report(value) {
  const line = JSON.stringify(value);
  assert.ok(Buffer.byteLength(line) <= 1024);
  writeSync(1, `${line}\n`);
}
export function reportCostRows(status, rows, writeRow = report) {
  try {
    for (const row of rows) writeRow(row);
  } catch { return status || 1; }
  return status;
}
function childStatus(result) {
  return result.status ?? (result.error?.code === 'ETIMEDOUT' ? 124
    : result.signal ? 128 + (os.constants.signals[result.signal] ?? 0) : 1);
}

export async function finishCostObservation(status, stopProfiler) {
  if (status !== 0) {
    try { await stopProfiler(); } catch {}
    return { status };
  }
  return { status, profile: (await stopProfiler()).profile };
}

// Inspector samples locate stacks, not CPU durations. Only process.cpuUsage supplies CPU time.
function profileCounts(profile) {
  assert.ok(profile.nodes.length <= 8192 && profile.samples.length <= 60000);
  const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
  const parents = new Map();
  for (const node of profile.nodes) for (const id of node.children ?? []) parents.set(id, node.id);
  const counts = { profile_samples: profile.samples.length, descriptor_hash_samples: 0,
    reopened_hash_samples: 0, hash_update_samples: 0, hash_read_samples: 0 };
  for (const sample of profile.samples) {
    let id = sample;
    const names = [];
    while (id !== undefined && names.length < 128) {
      names.push(nodes.get(id)?.callFrame.functionName ?? '');
      id = parents.get(id);
    }
    if (!names.includes('hashOpenRegularFile')) continue;
    if (names.includes('capturedStagingNodeExecutable')) counts.reopened_hash_samples++;
    else if (names.includes('captureStagingNodeAuthority')) counts.descriptor_hash_samples++;
    if (names.includes('update')) counts.hash_update_samples++;
    if (names.includes('readSync')) counts.hash_read_samples++;
  }
  return counts;
}

async function owner(targetStatus, count, expectedSource = 'descriptor') {
  const root = process.env.CI129_ROOT;
  const digest = process.env.CI129_BUNDLE;
  assert.match(root, /^\/tmp\/easyboost-bounded-timing-[a-zA-Z0-9]+$/u);
  assert.match(digest, /^[a-f0-9]{64}$/u);
  const generation = path.join(root, 'helpers', 'generations', digest);
  const { runSupervisedCommand, readLinuxProcessStartTime } = await import(`${generation}/staging-command-supervisor.js`);
  const { createPosixSessionControl, createPosixSessionInvocation } = await import(`${generation}/posix-session-supervisor.js`);
  const session = new Session();
  session.connect();
  const post = (method, params = {}) => new Promise((resolve, reject) => {
    session.post(method, params, (error, value) => error ? reject(error) : resolve(value));
  });
  try {
    await post('Profiler.enable');
    await post('Profiler.setSamplingInterval', { interval: 1000 });
    for (let iteration = 1; iteration <= count; iteration++) {
      await post('Profiler.start');
      const started = performance.now();
      const initialCpu = process.cpuUsage();
      const beforeControlCpu = process.cpuUsage();
      const beforeControl = performance.now();
      const control = createPosixSessionControl({
        controlKey: `ci129-cost:${process.pid}:${iteration}`,
        controlRoot: path.join(root, 'cost-controls'),
      });
      const controlMs = performance.now() - beforeControl;
      const controlCpuMs = cpu(beforeControlCpu);
      const times = {};
      let observationFailed = false;
      let invocationMs;
      let invocationCpuMs;
      let disposeMs;
      let disposeCpuMs;
      let source;
      // These are real existing lifecycle methods. Return values and errors are unchanged.
      const observedControl = Object.freeze({ ...control,
        markWrapperSpawned(...args) {
          times.spawn = epoch();
          return control.markWrapperSpawned(...args);
        },
        observeWrapperClose(...args) {
          times.close = epoch();
          try {
            for (const [name, field] of [['ready', 'readyPath'], ['status', 'statusPath'],
              ['kill', 'killArmedPath']]) {
              const value = statSync(control.specification[field]);
              assert.ok(value.isFile() && value.size > 0 && value.size <= 4096);
              times[name] = value.mtimeMs;
            }
          } catch { observationFailed = true; }
          return control.observeWrapperClose(...args);
        },
        dispose(...args) {
          const beforeCpu = process.cpuUsage();
          const before = performance.now();
          try { return control.dispose(...args); } finally {
            disposeMs = performance.now() - before;
            disposeCpuMs = cpu(beforeCpu);
          }
        },
      });
      const status = await runSupervisedCommand({
        command: targetStatus === 0 ? '/usr/bin/true' : '/bin/bash',
        args: targetStatus === 0 ? [] : ['--noprofile', '--norc', '-c', 'exit 23'],
        timeoutMs: 5000, parentPid: process.pid,
        parentStartTime: readLinuxProcessStartTime(process.pid),
        posixSessionControl: observedControl,
        posixSessionInvocation(...args) {
          const beforeCpu = process.cpuUsage();
          const before = performance.now();
          const invocation = createPosixSessionInvocation(...args);
          invocationMs = performance.now() - before;
          invocationCpuMs = cpu(beforeCpu);
          source = JSON.parse(Buffer.from(invocation.args[2], 'base64').toString()).nodeAuthority.source;
          assert.equal(source, expectedSource);
          return invocation;
        },
      });
      const finished = epoch();
      const totalMs = performance.now() - started;
      const totalCpuMs = cpu(initialCpu);
      const { profile } = await finishCostObservation(status, () => post('Profiler.stop'));
      // A failed real command has priority over missing or invalid observer data.
      if (status !== 0) return status;
      assert.equal(observationFailed, false);
      const intervals = [times.ready - times.spawn, times.status - times.ready,
        times.kill - times.status, times.close - times.kill, finished - times.close];
      assert.ok(intervals.every((value) => Number.isFinite(value) && value >= 0 && value <= 30000));
      const [spawnToReady, readyToStatus, statusToKill, killToClose, closeToFinish] = intervals;
      report({ event: 'supervisor-cost', iteration, source, status,
        total_ms: ms(totalMs), controller_cpu_ms: ms(totalCpuMs),
        control_ms: ms(controlMs), control_cpu_ms: ms(controlCpuMs),
        invocation_ms: ms(invocationMs), invocation_cpu_ms: ms(invocationCpuMs),
        spawn_to_ready_ms: ms(spawnToReady), ready_to_status_ms: ms(readyToStatus),
        status_to_kill_ms: ms(statusToKill), kill_to_close_ms: ms(killToClose),
        close_to_finish_ms: ms(closeToFinish), dispose_ms: ms(disposeMs),
        dispose_cpu_ms: ms(disposeCpuMs), ...profileCounts(profile),
      });
    }
    return 0;
  } finally { session.disconnect(); }
}

async function chainOwner(targetStatus, count) {
  const root = process.env.CI129_ROOT;
  const digest = process.env.CI129_BUNDLE;
  assert.match(root, /^\/tmp\/easyboost-bounded-timing-[a-zA-Z0-9]+$/u);
  assert.match(digest, /^[a-f0-9]{64}$/u);
  const generation = path.join(root, 'helpers', 'generations', digest);
  const { runSupervisedCommand, readLinuxProcessStartTime } = await import(`${generation}/staging-command-supervisor.js`);
  // The real wrapper removes raw descriptor metadata and supplies the live inherited chain.
  // This outer command's duration contains the nested observations and is not reported or added.
  return runSupervisedCommand({
    command: `/proc/${process.pid}/fd/9`,
    args: [thisFile, 'nested', String(targetStatus), String(count)], timeoutMs: 15000,
    parentPid: process.pid, parentStartTime: readLinuxProcessStartTime(process.pid),
    posixControlRoot: path.join(root, 'outer-controls'),
  });
}

// Fixed finite-child fixture boundary: two known statuses and one or three iterations only.
// The same installed helper preparation as the existing component; no launcher/flock rollback.
export async function runCostFixture(targetStatus = 0, count = 3, source = 'descriptor') {
  assert.ok([0, 23].includes(targetStatus) && [1, 3].includes(count));
  assert.ok(['descriptor', 'chain'].includes(source));
  assert.equal(process.platform, 'linux');
  let root;
  let identity;
  let status = 1;
  let removed = 0;
  let rows = [];
  const deadline = performance.now() + 35000;
  try {
    const fixture = await fs.readFile('test/staging-release-lock.integration.test.js', 'utf8');
    const first = fixture.indexOf('async function prepareHermeticHelperInstaller(');
    const last = fixture.indexOf('\nfunction combineCleanupFailures(', first);
    assert.ok(first > 0 && last > first);
    const prepare = vm.runInNewContext(`${fixture.slice(first, last)}\nprepareHermeticHelperInstaller`,
      { fs, path, process, assert, HELPER_BUNDLE_FILES,
        installerScript: path.resolve('scripts/install-staging-release-helpers.sh') });
    root = await fs.mkdtemp('/tmp/easyboost-bounded-timing-');
    identity = await fs.lstat(root);
    const bin = path.join(root, 'bin');
    await fs.mkdir(bin);
    const prepared = await prepare(root, bin);
    const environment = { PATH: `${bin}:${prepared.nodeDirectory}:/usr/bin:/bin`,
      LANG: 'C', HOME: root, TMPDIR: root, STAGING_HELPER_ALLOWED_PREFIX: root };
    function run(command, args, env) {
      const remaining = Math.floor(deadline - performance.now());
      if (remaining <= 0) throw Object.assign(new Error('fixture deadline'), { status: 124 });
      return spawnSync(command, args, { env, encoding: 'utf8', timeout: remaining,
        killSignal: 'SIGKILL', maxBuffer: 16 * 1024 });
    }
    const helperRoot = path.join(root, 'helpers');
    const installed = run(path.join(prepared.nodeDirectory, 'node'), [
      path.join(root, 'helper-installer-source', 'staging-helper-bundle.js'), 'install',
      path.join(root, 'helper-installer-source'), helperRoot, path.join(root, 'sbin'),
    ], environment);
    requireComponentSuccess(installed);
    const digest = /staging_helper_bundle_sha256=([a-f0-9]{64})/u.exec(installed.stdout)?.[1];
    assert.ok(digest);
    const directories = await fs.readdir(path.join(helperRoot, 'node-authorities'));
    assert.equal(directories.length, 1);
    const privateNode = path.join(helperRoot, 'node-authorities', directories[0], 'node');
    const nodeDigest = createHash('sha256').update(await fs.readFile(privateNode)).digest('hex');
    const env = { ...environment, CI129_ROOT: root, CI129_BUNDLE: digest,
      CI129_NODE: privateNode, CI129_DIGEST: nodeDigest };
    const shell = 'exec 9<"$CI129_NODE"\n'
      + 'export EASYBOOST_STAGING_NODE_AUTHORITY="easyboost-staging-node-authority-v1:9:$$:$CI129_DIGEST"\n'
      + 'exec "/proc/$$/fd/9" "$@"';
    const result = run('/bin/bash', ['--noprofile', '--norc', '-c', shell,
      'ci129-cost', thisFile, source === 'descriptor' ? 'owner' : 'chain-owner',
      String(targetStatus), String(count)], env);
    status = childStatus(result);
    if (status === 0) {
      requireComponentSuccess(result);
      rows = result.stdout.trim().split('\n').map((line) => {
        assert.ok(Buffer.byteLength(line) <= 1024);
        const row = JSON.parse(line);
        assert.equal(row.event, 'supervisor-cost');
        assert.equal(row.status, 0);
        return row;
      });
      assert.equal(rows.length, count);
      await removeFixture(root, identity);
      removed = 1;
    } else rows = [{ event: 'component-failed', status }];
  } catch (error) {
    status = Number.isInteger(error.status) && error.status > 0 && error.status <= 255 ? error.status : 1;
    rows = [{ event: 'component-failed', status }];
  }
  // Unknown descendants and failed fixtures are retained for disposable-container lifecycle.
  return { status, fixture_removed: removed, rows };
}

if (process.argv[1] && path.resolve(process.argv[1]) === thisFile) {
  try {
    if (process.argv.length === 5 && ['owner', 'nested', 'chain-owner'].includes(process.argv[2])
        && ['0', '23'].includes(process.argv[3]) && ['1', '3'].includes(process.argv[4])
        && process.platform === 'linux') {
      process.exitCode = process.argv[2] === 'chain-owner'
        ? await chainOwner(Number(process.argv[3]), Number(process.argv[4]))
        : await owner(Number(process.argv[3]), Number(process.argv[4]),
          process.argv[2] === 'nested' ? 'chain' : 'descriptor');
    } else if (process.argv.length !== 2) {
      process.exitCode = reportCostRows(64, [{ event: 'invalid-invocation', status: 64 }]);
    } else if (process.platform !== 'linux') {
      process.exitCode = reportCostRows(69, [{ event: 'linux-required', status: 69 }]);
    } else {
      let result;
      for (const source of ['descriptor', 'chain']) {
        result = await runCostFixture(0, 3, source);
        process.exitCode = reportCostRows(result.status, result.rows);
        if (process.exitCode !== 0) break;
      }
      process.exitCode = reportCostRows(process.exitCode, [{ event: 'component-only',
        status: process.exitCode, fixture_removed: result.fixture_removed }]);
    }
  } catch { process.exitCode = 1; }
}
