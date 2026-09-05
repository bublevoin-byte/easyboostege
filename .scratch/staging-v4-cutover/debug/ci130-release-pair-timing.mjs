// Fixed finite ticket21 comparison. No rollback, new guard, or arbitrary command interface.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { HELPER_BUNDLE_FILES } from '../../../scripts/staging-helper-bundle.js';
import { createReleaseArchive } from '../../../scripts/staging-release-archive.js';
import { removeFixture, requireComponentSuccess } from '../diagnostics/native-bounded-timing.mjs';

const thisFile = fileURLToPath(import.meta.url);
const digestOf = (bytes) => createHash('sha256').update(bytes).digest('hex');
const baselineHashes = {
  'staging-runtime-authority.js': '224f98ca86d9710c79bd3b29b752e7117906d00b358ab39bed643db16f708319',
  'staging-release-common.sh': 'f667daac6d5bc94090f9f027160e2abc04209a26ad747ef4445288b9f8de6b3b',
};
// Exact function from HEAD 62614030bc7b61596c425c0fb0be3a338e7b22e3.
const oldPair = String.raw`verify_release_pair() {
  local sha="$1" role="$2" stored declared actual archive_authority sidecar_authority
  stored="$(release_archive_path "$sha")"
  if [ -L "$stored" ] || [ -L "$stored.sha256" ] \
    || [ ! -f "$stored" ] || [ ! -f "$stored.sha256" ]; then
    echo "$role release has no verified retained release archive" >&2
    return 1
  fi
  archive_authority="$(run_bounded "$COMMAND_SECONDS" node "$runtime_authority_tool" \
    capture-file "$stored" "$role retained release archive" 384 536870912)" || return 1
  sidecar_authority="$(run_bounded "$COMMAND_SECONDS" node "$runtime_authority_tool" \
    capture-file "$stored.sha256" "$role retained checksum sidecar" 384 65)" || return 1
  declared="$(read_exact_sha_marker "$stored.sha256" "$role retained checksum sidecar")" \
    || return 1
  actual="$(authority_field "$archive_authority" sha256)" || return 1
  if [ "$declared" != "$sha" ] || [ "$actual" != "$sha" ]; then
    echo "$role retained release archive verification failed" >&2
    return 1
  fi
  run_archive_inspect "$stored" || {
    echo "$role retained release archive validation failed" >&2
    return 1
  }
  run_bounded "$COMMAND_SECONDS" node "$runtime_authority_tool" verify-file \
    "$stored" "$role retained release archive" 384 536870912 "$archive_authority" || return 1
  run_bounded "$COMMAND_SECONDS" node "$runtime_authority_tool" verify-file \
    "$stored.sha256" "$role retained checksum sidecar" 384 65 "$sidecar_authority"
}
`;

function replaceSection(source, start, end, replacement) {
  const first = source.indexOf(start);
  const last = source.indexOf(end, first);
  assert.ok(first > 0 && last > first);
  return source.slice(0, first) + replacement + source.slice(last);
}

async function restoreBaseline(sourceDirectory) {
  for (const file of Object.keys(baselineHashes)) {
    const destination = path.join(sourceDirectory, file);
    let source = (await fs.readFile(destination, 'utf8')).replaceAll('\r\n', '\n');
    if (file.endsWith('.sh')) {
      source = replaceSection(source, 'verify_release_pair() {', '\nvalidate_release_store() {', oldPair);
    } else {
      source = source.replace("import { validateReleaseArchive } from './staging-release-archive.js';\n", '');
      source = replaceSection(source, 'export async function verifyRetainedReleasePair(',
        'export function readCutoverJournal(', '');
      source = replaceSection(source, "  if (command === 'verify-release-pair') {",
        "  if (command === 'capture-postgres-container'", '');
    }
    // Refuse a comparison unless the entire restored production file equals the known baseline.
    assert.equal(digestOf(source), baselineHashes[file]);
    await fs.writeFile(destination, source);
  }
}

export function readPairObservation(result, phase) {
  requireComponentSuccess(result);
  assert.ok(['before', 'after'].includes(phase));
  assert.ok(Buffer.byteLength(result.stdout) <= 1024);
  const lines = result.stdout.trim().split('\n');
  assert.equal(lines.length, 3);
  return lines.map((line, index) => {
    const match = /^pair ([1-3]) ([0-9]+\.[0-9]+) ([0-9]+\.[0-9]+)$/u.exec(line);
    assert.ok(match);
    assert.equal(Number(match[1]), index + 1);
    const elapsed = (Number(match[3]) - Number(match[2])) * 1000;
    assert.ok(Number.isFinite(elapsed) && elapsed >= 0 && elapsed <= 60000);
    return { event: 'release-pair', phase, iteration: index + 1, source: 'chain',
      elapsed_ms: +elapsed.toFixed(2), status: 0 };
  });
}

async function owner() {
  const root = process.env.CI130_ROOT;
  const digest = process.env.CI130_BUNDLE;
  const sha = process.env.CI130_PAIR_SHA;
  assert.match(root, /^\/tmp\/easyboost-bounded-timing-[a-zA-Z0-9]+$/u);
  assert.match(digest, /^[a-f0-9]{64}$/u);
  assert.match(sha, /^[a-f0-9]{64}$/u);
  const generation = path.join(root, 'helpers', 'generations', digest);
  const { runSupervisedCommand, readLinuxProcessStartTime } = await import(`${generation}/staging-command-supervisor.js`);
  return runSupervisedCommand({
    command: '/bin/bash', args: ['--noprofile', '--norc', '-c', [
      '[ -n "$EASYBOOST_STAGING_NODE_CHAIN_AUTHORITY" ] || exit 69',
      'source "$1" || exit',
      'release_store="$2"',
      'for iteration in 1 2 3; do',
      '  started="$EPOCHREALTIME"',
      '  verify_release_pair "$3" candidate || exit',
      '  printf "pair %s %s %s\\n" "$iteration" "$started" "$EPOCHREALTIME"',
      'done',
    ].join('\n'), 'ci130-pair', path.join(generation, 'staging-release-common.sh'),
    path.join(root, 'releases'), sha],
    timeoutMs: 60000, parentPid: process.pid,
    parentStartTime: readLinuxProcessStartTime(process.pid),
    posixControlRoot: path.join(root, 'outer-controls'),
  });
}

export async function runPairFixture(phase) {
  assert.ok(['before', 'after'].includes(phase));
  assert.equal(process.platform, 'linux');
  const deadline = performance.now() + 75000;
  let status = 1;
  let removed = 0;
  let rows = [];
  let root;
  let identity;
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
    if (phase === 'before') await restoreBaseline(path.join(root, 'helper-installer-source'));
    const environment = { PATH: `${bin}:${prepared.nodeDirectory}:/usr/bin:/bin`,
      LANG: 'C', HOME: root, TMPDIR: root, STAGING_HELPER_ALLOWED_PREFIX: root };
    function run(command, args, env = environment) {
      const remaining = Math.floor(deadline - performance.now());
      if (remaining <= 0) throw Object.assign(new Error('fixture deadline'), { status: 124 });
      return spawnSync(command, args, { env, encoding: 'utf8', timeout: remaining,
        killSignal: 'SIGKILL', maxBuffer: 8192 });
    }
    const helperRoot = path.join(root, 'helpers');
    const installed = run(path.join(prepared.nodeDirectory, 'node'), [
      path.join(root, 'helper-installer-source', 'staging-helper-bundle.js'), 'install',
      path.join(root, 'helper-installer-source'), helperRoot, path.join(root, 'sbin'),
    ]);
    requireComponentSuccess(installed);
    const digest = /staging_helper_bundle_sha256=([a-f0-9]{64})/u.exec(installed.stdout)?.[1];
    assert.ok(digest);
    const directories = await fs.readdir(path.join(helperRoot, 'node-authorities'));
    assert.equal(directories.length, 1);
    const privateNode = path.join(helperRoot, 'node-authorities', directories[0], 'node');
    const nodeDigest = digestOf(await fs.readFile(privateNode));
    const source = path.join(root, 'pair-source');
    const store = path.join(root, 'releases');
    await fs.mkdir(source);
    await fs.mkdir(store, { mode: 0o700 });
    await fs.writeFile(path.join(source, 'compose.staging.yml'), 'services: {}\n');
    const temporary = path.join(root, 'release.tar.gz');
    const pair = await createReleaseArchive({ sourceDirectory: source,
      files: ['compose.staging.yml'], outputPath: temporary });
    const archive = path.join(store, `release-${pair.sha256}.tar.gz`);
    await fs.chmod(temporary, 0o600);
    await fs.rename(temporary, archive);
    await fs.writeFile(`${archive}.sha256`, `${pair.sha256}\n`, { mode: 0o600 });
    const environmentWithChain = { ...environment, CI130_ROOT: root, CI130_BUNDLE: digest,
      CI130_NODE: privateNode, CI130_NODE_DIGEST: nodeDigest, CI130_PAIR_SHA: pair.sha256 };
    const shell = 'exec 9<"$CI130_NODE"\n'
      + 'export EASYBOOST_STAGING_NODE_AUTHORITY="easyboost-staging-node-authority-v1:9:$$:$CI130_NODE_DIGEST"\n'
      + 'exec "/proc/$$/fd/9" "$@"';
    const result = run('/bin/bash', ['--noprofile', '--norc', '-c', shell,
      'ci130-pair', thisFile, 'owner'], environmentWithChain);
    rows = readPairObservation(result, phase);
    rows.push({ event: 'pair-fixture', phase, compressed_bytes: (await fs.stat(archive)).size,
      node_version: process.version, status: 0 });
    await removeFixture(root, identity);
    removed = 1;
    status = 0;
  } catch (error) {
    status = Number.isInteger(error.status) && error.status > 0 && error.status <= 255 ? error.status : 1;
    rows = [{ event: 'pair-fixture-failed', phase, status }];
  }
  // Failed/uncertain fixtures remain intact for disposal of the surrounding container.
  return { status, fixture_removed: removed, rows };
}

if (process.argv[1] && path.resolve(process.argv[1]) === thisFile) {
  try {
    if (process.argv.length === 3 && process.argv[2] === 'owner' && process.platform === 'linux') {
      process.exitCode = await owner();
    } else if (process.argv.length !== 2 || process.platform !== 'linux') {
      process.exitCode = process.argv.length !== 2 ? 64 : 69;
    } else {
      for (const phase of ['before', 'after']) {
        const result = await runPairFixture(phase);
        process.exitCode = result.status;
        for (const row of result.rows) {
          const line = JSON.stringify(row);
          assert.ok(Buffer.byteLength(line) <= 512);
          console.log(line);
        }
        console.log(JSON.stringify({ event: 'pair-component-only', phase,
          status: result.status, fixture_removed: result.fixture_removed }));
        if (result.status !== 0) break;
      }
    }
  } catch { process.exitCode = process.exitCode || 1; }
}
