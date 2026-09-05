// Diagnostic only. No process signals, environment reads or recovery authority.
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { constants } from 'node:os';
import { fileURLToPath } from 'node:url';

const MAX_PROCESSES = 64;
const MAX_READS = 512;
const MAX_BYTES = 4096;
const stages = new Map(Object.entries({
  'install-staging-release-helpers.sh': 'installer',
  'easyboost-staging-deploy': 'deploy',
  'easyboost-staging-rollback': 'rollback',
  'staging-deploy.sh': 'deploy',
  'staging-rollback.sh': 'rollback',
  'staging-helper-bundle.js': 'helper-bundle',
  'staging-runtime-authority.js': 'runtime-authority',
  'staging-release-archive.js': 'release-archive',
  'verify-staging-compose.js': 'compose-contract',
  'staging-bounded-stream.js': 'bounded-stream',
  'staging-command-supervisor.js': 'command-supervisor',
  'staging-transaction-supervisor.js': 'transaction-supervisor',
  'staging-deadline-control.js': 'deadline-control',
  'posix-session-supervisor.js': 'session-supervisor',
}));
const tools = new Set(['node', 'bash', 'flock', 'docker', 'sleep', 'sha256sum', 'stat', 'tar', 'python3']);

async function readLinuxProc(pid, file) {
  const suffix = file === 'children' ? `task/${pid}/children` : file;
  const handle = await fs.open(`/proc/${pid}/${suffix}`, 'r');
  try {
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_BYTES) throw new Error('metadata-limit');
    return buffer.toString('utf8', 0, bytesRead);
  } finally {
    await handle.close();
  }
}

function identity(value, pid) {
  const close = value.lastIndexOf(')');
  const fields = value.slice(close + 2).trim().split(/\s+/u);
  if (!value.startsWith(`${pid} (`) || close < 0 || !/^[1-9]\d*$/u.test(fields[19] ?? '')
      || !/^\d+$/u.test(fields[1] ?? '')) throw new Error('invalid-identity');
  return { pid, parent: Number(fields[1]), start: fields[19] };
}

function sameIdentity(left, right) {
  return left.pid === right.pid && left.parent === right.parent && left.start === right.start;
}

function category(cmdline) {
  const argv = cmdline.split('\0', 2);
  const executable = path.posix.basename(argv[0]);
  const interpreter = executable === 'node' || executable === 'bash'
    || /^\/proc\/(?:self|[1-9]\d*)\/fd\/[1-9]\d*$/u.test(argv[0]);
  return stages.get(executable)
    ?? (interpreter ? stages.get(path.posix.basename(argv[1] ?? '')) : undefined)
    ?? (tools.has(executable) ? executable : 'unknown');
}

// readProc is the filesystem boundary for deterministic missing/reused-identity tests.
// The CLI always reads the kernel's /proc; it accepts no alternate process or command.
export async function sampleOwnedProcesses(anchor, readProc = readLinuxProc) {
  let reads = 0;
  let omitted = 0;
  let truncated = false;
  const visited = new Set();
  async function read(pid, file) {
    if (++reads > MAX_READS) { truncated = true; throw new Error('read-limit'); }
    const value = await readProc(pid, file);
    if (typeof value !== 'string' || Buffer.byteLength(value) > MAX_BYTES) {
      truncated = true;
      throw new Error('metadata-limit');
    }
    return value;
  }
  async function visit(expected, depth) {
    if (visited.size >= MAX_PROCESSES || depth > 16) { truncated = true; return []; }
    if (visited.has(expected.pid)) { omitted++; return []; }
    visited.add(expected.pid);
    try {
      const before = identity(await read(expected.pid, 'stat'), expected.pid);
      if (!sameIdentity(before, expected)) throw new Error('changed-identity');
      const names = [category(await read(expected.pid, 'cmdline'))];
      const children = (await read(expected.pid, 'children')).trim();
      for (const value of children ? children.split(/\s+/u) : []) {
        if (visited.size >= MAX_PROCESSES) { truncated = true; break; }
        if (!/^[1-9]\d*$/u.test(value) || !Number.isSafeInteger(Number(value))) {
          omitted++; continue;
        }
        try {
          const child = identity(await read(Number(value), 'stat'), Number(value));
          if (child.parent !== before.pid || BigInt(child.start) < BigInt(before.start)) {
            omitted++; continue;
          }
          names.push(...await visit(child, depth + 1));
        } catch { omitted++; }
      }
      const after = identity(await read(expected.pid, 'stat'), expected.pid);
      if (!sameIdentity(before, after)) throw new Error('changed-identity');
      return names;
    } catch { omitted++; return []; }
  }
  const categories = {};
  if (Number.isSafeInteger(anchor.pid) && anchor.pid > 0) {
    for (const name of await visit(anchor, 0)) categories[name] = (categories[name] ?? 0) + 1;
  } else omitted++;
  return { categories, omitted, truncated, reads: Math.min(reads, MAX_READS) };
}

// The already-spawned ChildProcess is the observation seam, not a command launcher.
export async function profileOwnedChild(child, {
  readProc = readLinuxProc, writeLine = console.log, sampleIntervalMs = 1000, maxSamples = 900,
} = {}) {
  const interval = Math.max(10, Math.min(1000, Math.floor(sampleIntervalMs) || 1000));
  const limit = Math.max(1, Math.min(900, Math.floor(maxSamples) || 900));
  const started = performance.now();
  let stopped = false;
  let timer;
  let work;
  let samples = 0;
  let omitted = 0;
  let truncated = 0;
  let reads = 0;
  let anchor;
  const totals = new Map();
  const done = new Promise((resolve) => {
    const finish = (result) => { stopped = true; clearTimeout(timer); resolve(result); };
    child.once('close', (code, signal) => finish({ code, signal }));
    child.once('error', () => finish({ code: 1, signal: null }));
  });
  function emit(event, code = null) {
    const report = {
      event, elapsed_ms: Math.min(1_200_000, Math.round(performance.now() - started)),
      samples, omitted, truncated_snapshots: truncated, metadata_reads: reads,
      exit_code: code,
      categories: [...totals].sort(([a], [b]) => a.localeCompare(b)).map(([name, counts]) => ({
        category: name, ...counts, sampled_residency_ms: counts.observations * interval,
      })),
    };
    try {
      const line = JSON.stringify(report);
      if (Buffer.byteLength(line) <= 8192) writeLine(line);
    } catch { /* Reporting failure cannot replace the test's result. */ }
  }
  async function tick() {
    if (stopped) return;
    const snapshot = await sampleOwnedProcesses(anchor, readProc);
    samples++;
    omitted += snapshot.omitted;
    truncated += Number(snapshot.truncated);
    reads += snapshot.reads;
    for (const [name, count] of Object.entries(snapshot.categories)) {
      const previous = totals.get(name) ?? { observations: 0, max_concurrent: 0 };
      previous.observations += count;
      previous.max_concurrent = Math.max(previous.max_concurrent, count);
      totals.set(name, previous);
    }
    if (samples % 30 === 0) emit('sample');
    if (samples >= limit || performance.now() - started >= 900_000) emit('sample-limit');
    else if (!stopped) timer = setTimeout(() => { work = tick(); }, interval);
  }
  work = (async () => {
    try {
      if (!Number.isSafeInteger(child.pid) || child.pid <= 0) throw new Error('missing-child');
      anchor = identity(await readProc(child.pid, 'stat'), child.pid);
      if (anchor.parent !== process.pid) throw new Error('unowned-child');
      await tick();
    } catch { omitted++; }
  })();
  const result = await done;
  await work;
  emit('child-exit', result.code);
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.platform !== 'linux' || process.argv.length !== 2) {
    console.error('Native Linux diagnostic requires Linux and accepts no arguments.');
    process.exitCode = 2;
  } else {
    const child = spawn(process.execPath, [
      '--test', '--test-name-pattern',
      '^real Linux flock excludes deploy and rollback through build, tree activation and recovery$',
      'test/staging-release-lock.integration.test.js',
    ], { stdio: 'inherit' });
    const result = await profileOwnedChild(child);
    // Numeric shell signal status, without re-signalling the observer or its descendants.
    process.exitCode = result.code ?? (128 + (constants.signals[result.signal] ?? 1));
  }
}
