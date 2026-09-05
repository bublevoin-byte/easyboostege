// Ticket22 diagnostic only: existing guarded protected-state checks, no rollback.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HELPER_BUNDLE_FILES, verifyInstalledHelperGeneration } from '../../../scripts/staging-helper-bundle.js';
import { prepareFixture, verifyFixture } from './ci126-rollback-only.mjs';
import { requireComponentSuccess } from '../diagnostics/native-bounded-timing.mjs';

const boundaries = ['compose', 'workspace', 'reservations'];
const thisFile = fileURLToPath(import.meta.url);
const repo = fileURLToPath(new URL('../../../', import.meta.url));
const digestOf = (bytes) => createHash('sha256').update(bytes).digest('hex');

function report(row) {
  const line = JSON.stringify(row);
  assert.ok(Buffer.byteLength(line) <= 1024);
  writeSync(1, `${line}\n`);
}

export function reportBoundaryRows(status, rows, writeRow = report) {
  try {
    for (const row of rows) writeRow(row);
  } catch { return status || 1; }
  return status;
}

export function readBoundaryObservation(result, operation) {
  requireComponentSuccess(result);
  assert.ok(boundaries.includes(operation));
  assert.ok(Buffer.byteLength(result.stdout) <= 1024);
  const lines = result.stdout.trim().split('\n');
  assert.equal(lines.length, 3);
  return lines.map((line, index) => {
    const match = /^boundary (compose|workspace|reservations) ([1-3]) ([0-9]+\.[0-9]+) ([0-9]+\.[0-9]+)$/u.exec(line);
    assert.ok(match);
    assert.equal(match[1], operation);
    assert.equal(Number(match[2]), index + 1);
    const elapsed = (Number(match[4]) - Number(match[3])) * 1000;
    assert.ok(Number.isFinite(elapsed) && elapsed >= 0 && elapsed <= 60000);
    return { event: 'protected-boundary', operation, iteration: index + 1,
      source: 'chain', elapsed_ms: +elapsed.toFixed(2), status: 0 };
  });
}

// Internal module entry, invoked only by the fixed descriptor bootstrap below.
// The public diagnostic CLI accepts no arguments and never forwards caller environment.
export async function boundaryOwner() {
  const root = process.env.CI131_ROOT;
  const digest = process.env.CI131_BUNDLE;
  assert.match(root, /^\/tmp\/easyboost-ci126-rollback-[a-zA-Z0-9]+$/u);
  assert.match(digest, /^[a-f0-9]{64}$/u);
  const generation = path.join(root, 'helpers', 'generations', digest);
  const { runSupervisedCommand, readLinuxProcessStartTime } = await import(`${generation}/staging-command-supervisor.js`);
  return runSupervisedCommand({
    command: '/bin/bash', args: ['--noprofile', '--norc', '-c', [
      'set -Eeuo pipefail; umask 077',
      '[ -n "$EASYBOOST_STAGING_NODE_CHAIN_AUTHORITY" ] || exit 69',
      'source "$1" || exit',
      '[ -n "$staging_node_chain_authority" ] || exit 69',
      'app_dir="$2/app"; env_file="$app_dir/.env.staging"',
      'release_store="$app_dir/rollbacks/releases"; lock_file="$app_dir/.staging-release.lock"',
      'recovery_marker="$app_dir/.staging-recovery-required"',
      // Full existing setup/capture and real allocated reservations, all outside timing.
      'bind_release_runtime_authority || exit',
      'create_release_workspace rollback || exit',
      'candidate_pair_existed=1',
      'reserve_release_space 0 0 0 0 0 || exit',
      'begin_release_transaction || exit',
      'for operation in compose workspace reservations; do',
      '  for iteration in 1 2 3; do',
      '    started="$EPOCHREALTIME"',
      '    case "$operation" in',
      '      compose) reverify_compose_authority || exit ;;',
      '      workspace) reverify_release_workspace || exit ;;',
      '      reservations) verify_space_reservations || exit ;;',
      '    esac',
      '    finished="$EPOCHREALTIME"',
      '    printf "boundary %s %s %s %s\\n" "$operation" "$iteration" "$started" "$finished"',
      '  done',
      'done',
    ].join('\n'), 'ci131-protected', path.join(generation, 'staging-release-common.sh'), root],
    timeoutMs: 90000, parentPid: process.pid,
    parentStartTime: readLinuxProcessStartTime(process.pid),
    posixControlRoot: path.join(root, 'outer-controls'),
  });
}

async function baseline() {
  const deadline = performance.now() + 120000;
  let stage = 'prepare';
  let fixture;
  const watchdog = setTimeout(() => {
    process.exit(reportBoundaryRows(124, [{ event: 'protected-component-deadline', stage, status: 124,
      fixture_retained: Boolean(fixture), cleanup: 'disposable-container-lifecycle' }]));
  }, 120000);
  try {
    assert.equal(path.resolve(process.cwd()), path.resolve(repo));
    fixture = await prepareFixture(await fs.mkdtemp('/tmp/easyboost-ci126-rollback-'));
    await verifyFixture(fixture);
    const { root, bin, factories } = fixture;
    const prepared = await factories.prepareInstaller(root, bin);
    const environment = { PATH: `${bin}:${prepared.nodeDirectory}:/usr/bin:/bin`,
      LANG: 'C', LC_ALL: 'C', HOME: root, TMPDIR: root, STAGING_HELPER_ALLOWED_PREFIX: root };
    function run(command, args, env = environment) {
      const remaining = Math.floor(deadline - performance.now());
      if (remaining <= 0) throw Object.assign(new Error('diagnostic deadline'), { status: 124 });
      return spawnSync(command, args, { env, cwd: repo, encoding: 'utf8', timeout: remaining,
        killSignal: 'SIGKILL', maxBuffer: 8192 });
    }
    stage = 'install';
    const helperRoot = path.join(root, 'helpers');
    const installed = run(path.join(prepared.nodeDirectory, 'node'), [
      path.join(root, 'helper-installer-source', 'staging-helper-bundle.js'), 'install',
      path.join(root, 'helper-installer-source'), helperRoot, path.join(root, 'sbin'),
    ]);
    requireComponentSuccess(installed);
    const digest = /staging_helper_bundle_sha256=([a-f0-9]{64})/u.exec(installed.stdout)?.[1];
    assert.ok(digest);
    assert.equal(await fs.readFile(path.join(helperRoot, 'current'), 'utf8'), `${digest}\n`);
    const generation = path.join(helperRoot, 'generations', digest);
    await verifyInstalledHelperGeneration({ generationDirectory: generation, expectedDigest: digest });
    for (const file of HELPER_BUNDLE_FILES) {
      // Only the existing fixture's trusted command-directory binding may differ.
      if (file === 'staging-helper-bundle.js') continue;
      assert.deepEqual(await fs.readFile(path.join(generation, file)),
        await fs.readFile(path.join(repo, 'scripts', file)));
    }
    const directories = await fs.readdir(path.join(helperRoot, 'node-authorities'));
    assert.equal(directories.length, 1);
    const privateNode = path.join(helperRoot, 'node-authorities', directories[0], 'node');
    const sourceNode = path.join(prepared.nodeDirectory, 'node');
    assert.equal(await fs.realpath(privateNode), privateNode);
    const installedIdentity = await fs.lstat(privateNode);
    const sourceIdentity = await fs.lstat(sourceNode);
    assert.ok(sourceIdentity.isFile() && !sourceIdentity.isSymbolicLink());
    assert.equal(sourceIdentity.uid, process.getuid());
    assert.equal(sourceIdentity.nlink, 1);
    assert.notEqual(`${installedIdentity.dev}:${installedIdentity.ino}`,
      `${sourceIdentity.dev}:${sourceIdentity.ino}`);
    const nodeDigest = digestOf(await fs.readFile(privateNode));
    assert.equal(nodeDigest, digestOf(await fs.readFile(sourceNode)));
    // Same exact settled installer-input retirement as ci126: leave room for three64MiB files.
    assert.equal(path.dirname(sourceNode), path.join(root, 'node-authority'));
    await fs.unlink(sourceNode);
    await fs.rmdir(prepared.nodeDirectory);
    stage = 'boundaries';
    const shell = 'exec 9<"$CI131_NODE"\n'
      + 'export EASYBOOST_STAGING_NODE_AUTHORITY="easyboost-staging-node-authority-v1:9:$$:$CI131_NODE_DIGEST"\n'
      + 'exec "/proc/$$/fd/9" "$@"';
    const fixedOwner = `import { boundaryOwner } from ${JSON.stringify(import.meta.url)}; process.exitCode = await boundaryOwner();`;
    const result = run('/bin/bash', ['--noprofile', '--norc', '-c', shell,
      'ci131-protected', '--input-type=module', '-e', fixedOwner], {
      ...environment, CI131_ROOT: root, CI131_BUNDLE: digest,
      CI131_NODE: privateNode, CI131_NODE_DIGEST: nodeDigest,
    });
    requireComponentSuccess(result);
    assert.ok(Buffer.byteLength(result.stdout) <= 3072);
    const lines = result.stdout.trim().split('\n');
    assert.equal(lines.length, 9);
    const rows = [];
    for (const [index, operation] of boundaries.entries()) {
      rows.push(...readBoundaryObservation({ ...result,
        stdout: lines.slice(index * 3, index * 3 + 3).join('\n') }, operation));
    }
    rows.push({ event: 'protected-provenance', node_version: process.version,
      node_bytes: installedIdentity.size, node_sha256: nodeDigest, installed_bundle_sha256: digest,
      common_sha256: digestOf(await fs.readFile(path.join(generation, 'staging-release-common.sh'))),
      authority_sha256: digestOf(await fs.readFile(path.join(generation, 'staging-runtime-authority.js'))),
      archive_pairs: 2, reservations: 3, reservation_bytes_each: 67108864,
      transaction_marker: 'present', status: 0 });
    rows.push({ event: 'protected-component-only', status: 0, fixture_retained: true,
      cleanup: 'disposable-container-lifecycle' });
    return reportBoundaryRows(0, rows);
  } catch (error) {
    const status = Number.isInteger(error.status) && error.status > 0 && error.status <= 255 ? error.status : 1;
    return reportBoundaryRows(status, [{ event: 'protected-component-failed', stage, status,
      fixture_retained: Boolean(fixture), cleanup: 'disposable-container-lifecycle' }]);
  } finally { clearTimeout(watchdog); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === thisFile) {
  if (process.argv.length !== 2) {
    process.exitCode = reportBoundaryRows(64, [{ event: 'invalid-invocation', status: 64 }]);
  } else if (process.platform !== 'linux') {
    process.exitCode = reportBoundaryRows(69, [{ event: 'linux-required', status: 69 }]);
  } else {
    process.exitCode = await baseline();
  }
}
