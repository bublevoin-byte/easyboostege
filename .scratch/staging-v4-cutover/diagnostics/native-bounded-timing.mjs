// Diagnostic component only. This does not reproduce or clear a deployment.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { HELPER_BUNDLE_FILES } from '../../../scripts/staging-helper-bundle.js';

const matrix = [
  ['true-once', 'true', 1, 0], ['true-repeat', 'true', 4, 0],
  ['true-depth-one', 'true', 1, 1], ['true-depth-two', 'true', 1, 2],
  ['helper-bundle', 'bundle', 1, 0], ['compose', 'compose', 1, 0],
];
const prefix = 'easyboost-bounded-timing-';
const milliseconds = (value) => Math.min(120_000, Math.max(0, +value.toFixed(2)));
let outputFailed = false;

function report(value) {
  // Every caller constructs a fixed schema; never serialize child output or Error objects.
  const line = JSON.stringify(value);
  assert.ok(Buffer.byteLength(line) <= 512);
  try { writeSync(1, `${line}\n`); } catch { outputFailed = true; }
}

export function requireComponentSuccess(result) {
  const status = result.status ?? (result.error?.code === 'ETIMEDOUT' ? 124
    : result.signal ? 128 + (os.constants.signals[result.signal] ?? 0) : 1);
  if (status !== 0 || result.error) throw Object.assign(new Error('component failed'), { status: status || 1 });
  assert.equal(result.stderr, '');
}

export async function removeFixture(root, identity) {
  assert.equal(path.dirname(root), '/tmp');
  assert.ok(path.basename(root).startsWith(prefix));
  const current = await fs.lstat(root);
  assert.ok(current.isDirectory() && !current.isSymbolicLink());
  assert.equal(current.uid, process.getuid());
  assert.equal(current.dev, identity.dev);
  assert.equal(current.ino, identity.ino);
  // Collect and validate first; never follow links, and never chmod an outside target.
  const directories = [];
  let entries = 0;
  async function inspect(directory, depth) {
    assert.ok(depth <= 12 && ++entries <= 4096);
    directories.push(directory);
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      assert.ok(++entries <= 4096);
      if (entry.isDirectory() && !entry.isSymbolicLink()) await inspect(path.join(directory, entry.name), depth + 1);
    }
  }
  await inspect(root, 0);
  for (const directory of directories) await fs.chmod(directory, 0o700);
  await fs.rm(root, { recursive: true, force: false, maxRetries: 0 });
}

async function baseline() {
  let root;
  let identity;
  let status = 0;
  let removed = 0;
  let stage = 'fixture';
  const deadline = performance.now() + 120_000;
  try {
    // Reuse the hermetic fixture's synthetic command-directory binding. Production
    // control, invocation, wrapper and settlement bytes stay intact.
    const fixture = await fs.readFile('test/staging-release-lock.integration.test.js', 'utf8');
    function extract(start, end, expression, context = {}) {
      const first = fixture.indexOf(start);
      const last = fixture.indexOf(end, first);
      assert.ok(first > 0 && last > first);
      return vm.runInNewContext(`${fixture.slice(first, last)}\n${expression}`, context);
    }
    const prepare = extract('async function prepareHermeticHelperInstaller(',
      '\nfunction combineCleanupFailures(', 'prepareHermeticHelperInstaller',
      { fs, path, process, assert, HELPER_BUNDLE_FILES,
        installerScript: path.resolve('scripts/install-staging-release-helpers.sh') });
    const factories = extract('const previousImageId =', '\nasync function release(',
      '({ lockFixtureDockerScript, approvedComposeModel })');
    root = await fs.mkdtemp(`/tmp/${prefix}`);
    identity = await fs.lstat(root);
    const app = path.join(root, 'app');
    const bin = path.join(root, 'bin');
    const helperRoot = path.join(root, 'helpers');
    await fs.mkdir(bin);
    await fs.mkdir(path.join(app, 'rollbacks', 'releases'), { recursive: true, mode: 0o700 });
    await fs.mkdir(path.join(app, 'backups'), { mode: 0o700 });
    await fs.chmod(app, 0o700);
    await fs.chmod(path.join(app, 'rollbacks'), 0o700);
    for (const [name, data] of [['.env.staging', 'APP_PORT=3001\n'],
      ['.release-sha256', `${'a'.repeat(64)}\n`], ['.staging-release.lock', ''],
      ['compose.staging.yml', 'synthetic fixture\n']]) {
      await fs.writeFile(path.join(app, name), data, { mode: 0o600 });
    }
    await fs.writeFile(path.join(bin, 'docker'), factories.lockFixtureDockerScript(
      { sha: 'a'.repeat(64) }, { sha: 'c'.repeat(64) }), { mode: 0o755 });
    const prepared = await prepare(root, bin);
    // Independent of the caller's Node flags, shell hooks and staging inputs.
    const environment = { PATH: `${bin}:${prepared.nodeDirectory}:/usr/bin:/bin`,
      LANG: 'C', HOME: root, TMPDIR: root, STAGING_APP_DIR: app,
      STAGING_HELPER_ALLOWED_PREFIX: root, BARRIER_DIR: root, BLOCK_AT: 'tree',
      EASYBOOST_STAGING_POSTGRES_IMAGE_ID: `sha256:${'3'.repeat(64)}`,
      RESOLVED_COMPOSE_JSON: JSON.stringify(factories.approvedComposeModel(app)) };
    function run(command, args, env = environment) {
      const remaining = Math.floor(deadline - performance.now());
      if (remaining <= 0) throw Object.assign(new Error('component deadline'), { status: 124 });
      return spawnSync(command, args, { env, encoding: 'utf8', timeout: remaining,
        killSignal: 'SIGKILL', maxBuffer: 64 * 1024 });
    }
    const beforeInstall = performance.now();
    const installed = run(path.join(prepared.nodeDirectory, 'node'), [
      path.join(root, 'helper-installer-source', 'staging-helper-bundle.js'), 'install',
      path.join(root, 'helper-installer-source'), helperRoot, path.join(root, 'sbin'),
    ]);
    requireComponentSuccess(installed);
    const digest = /staging_helper_bundle_sha256=([a-f0-9]{64})/.exec(installed.stdout)?.[1];
    assert.ok(digest);
    report({ event: 'fixture', elapsed_ms: milliseconds(performance.now() - beforeInstall), status: 0 });
    const nodeDirectories = await fs.readdir(path.join(helperRoot, 'node-authorities'));
    assert.equal(nodeDirectories.length, 1);
    const privateNode = path.join(helperRoot, 'node-authorities', nodeDirectories[0], 'node');
    const nodeDigest = createHash('sha256').update(await fs.readFile(privateNode)).digest('hex');
    const worker = fileURLToPath(new URL('./bounded-timing-chain.mjs', import.meta.url));
    // Live descriptor owner bootstrap from ticket14 and the existing Node-chain test.
    const shell = 'exec 9<"$BOUNDED_TIMING_NODE"\n'
      + 'export EASYBOOST_STAGING_NODE_AUTHORITY="easyboost-staging-node-authority-v1:9:$$:$BOUNDED_TIMING_NODE_DIGEST"\n'
      + 'exec "/proc/$$/fd/9" "$@"';
    const chainEnvironment = { ...environment, BOUNDED_TIMING_NODE: privateNode,
      BOUNDED_TIMING_NODE_DIGEST: nodeDigest, BOUNDED_TIMING_ROOT: root,
      BOUNDED_TIMING_BUNDLE_DIGEST: digest };
    for (const [label, operation, count, depth] of matrix) {
      stage = label;
      const started = performance.now();
      const result = run('/bin/bash', ['--noprofile', '--norc', '-c', shell,
        'bounded-timing', worker, 'owner', operation, String(count), String(depth)], chainEnvironment);
      requireComponentSuccess(result);
      const rows = result.stdout.trim().split('\n').map((line) => JSON.parse(line));
      assert.equal(rows.length, count * (depth + 1));
      for (const row of rows) {
        assert.deepEqual(Object.keys(row), ['event', 'operation', 'source', 'depth', 'iteration',
          'control_ms', 'invocation_ms', 'elapsed_ms', 'status']);
        assert.equal(row.event, 'component');
        assert.equal(row.operation, operation);
        assert.ok(['descriptor', 'chain'].includes(row.source));
        assert.ok(Number.isInteger(row.depth) && row.depth >= 0 && row.depth <= depth);
        assert.ok(Number.isInteger(row.iteration) && row.iteration >= 1 && row.iteration <= count);
        for (const value of [row.control_ms, row.invocation_ms, row.elapsed_ms]) {
          assert.ok(Number.isFinite(value) && value >= 0 && value <= 120_000);
        }
        assert.equal(row.status, 0);
        report(row);
      }
      report({ event: 'operation', operation: label,
        elapsed_ms: milliseconds(performance.now() - started), status: 0 });
    }
  } catch (error) {
    status = Number.isInteger(error.status) && error.status > 0 && error.status <= 255 ? error.status : 1;
    report({ event: 'component-failed', operation: stage, status });
  }
  // A failed owner may still have a live session: retain its private fixture and evidence.
  // Never substitute recursive deletion for normal production settlement.
  if (root && status === 0) {
    try {
      await removeFixture(root, identity);
      removed = 1;
    } catch {
      status = 1;
      report({ event: 'fixture-cleanup-failed', status });
    }
  }
  report({ event: 'component-only', status, fixture_removed: removed });
  return status || (outputFailed ? 1 : 0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2) {
    report({ event: 'invalid-invocation', status: 64 });
    process.exitCode = 64;
  } else if (process.platform !== 'linux') {
    report({ event: 'linux-required', status: 69 });
    process.exitCode = 69;
  } else {
    process.exitCode = await baseline();
  }
}
