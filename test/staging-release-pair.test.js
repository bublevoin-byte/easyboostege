import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createReleaseArchive } from '../scripts/staging-release-archive.js';
import * as runtimeAuthority from '../scripts/staging-runtime-authority.js';

async function releasePair(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'easyboost-release-pair-'));
  const identity = fs.lstatSync(root, { bigint: true });
  t.after(() => {
    const current = fs.lstatSync(root, { bigint: true });
    assert.ok(current.isDirectory() && !current.isSymbolicLink());
    assert.equal(current.dev, identity.dev);
    assert.equal(current.ino, identity.ino);
    fs.rmSync(root, { recursive: true });
  });
  const source = path.join(root, 'source');
  fs.mkdirSync(source, { mode: 0o700 });
  fs.writeFileSync(path.join(source, 'compose.staging.yml'), 'services: {}\n');
  const archivePath = path.join(root, 'release.tar.gz');
  const { sha256 } = await createReleaseArchive({
    sourceDirectory: source, files: ['compose.staging.yml'], outputPath: archivePath,
  });
  fs.chmodSync(archivePath, 0o600);
  fs.writeFileSync(`${archivePath}.sha256`, `${sha256}\n`, { mode: 0o600 });
  return { root, archivePath, expectedSha256: sha256, role: 'candidate' };
}

test('retained release pair accepts a real canonical archive and private checksum sidecar', async (t) => {
  const pair = await releasePair(t);
  assert.equal(await runtimeAuthority.verifyRetainedReleasePair(pair), undefined);
});

test('retained release pair CLI succeeds silently with exactly three fixed arguments', async (t) => {
  const pair = await releasePair(t);
  const args = [path.resolve('scripts/staging-runtime-authority.js'), 'verify-release-pair',
    pair.archivePath, pair.expectedSha256, pair.role];
  const result = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
});

function pairCli(pair, extra = []) {
  return spawnSync(process.execPath, [path.resolve('scripts/staging-runtime-authority.js'),
    'verify-release-pair', pair.archivePath, pair.expectedSha256, pair.role, ...extra], {
    encoding: 'utf8', timeout: 5000, maxBuffer: 4096,
  });
}

test('retained release pair refuses noncanonical and mismatched declared or expected digests', async (t) => {
  const pair = await releasePair(t);
  const sidecar = `${pair.archivePath}.sha256`;
  for (const value of [pair.expectedSha256, `${pair.expectedSha256.toUpperCase()}\n`,
    `${pair.expectedSha256}\r\n`, `${'0'.repeat(64)}\n`, `${pair.expectedSha256}\nextra\n`]) {
    fs.writeFileSync(sidecar, value);
    const result = pairCli(pair);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout, '');
  }
  fs.writeFileSync(sidecar, `${pair.expectedSha256}\n`);
  for (const expectedSha256 of ['', 'invalid', pair.expectedSha256.toUpperCase(), '0'.repeat(64)]) {
    await assert.rejects(runtimeAuthority.verifyRetainedReleasePair({ ...pair, expectedSha256 }),
      /noncanonical|verification failed/u);
  }
  assert.equal(pairCli(pair, ['extra']).status, 1);
  const missing = spawnSync(process.execPath, [path.resolve('scripts/staging-runtime-authority.js'),
    'verify-release-pair', pair.archivePath], { encoding: 'utf8', timeout: 5000 });
  assert.equal(missing.status, 1);
  assert.equal(missing.stdout, '');
});

test('retained release pair compares the captured archive digest and validates its real content', async (t) => {
  const pair = await releasePair(t);
  fs.writeFileSync(pair.archivePath, 'invalid archive');
  await assert.rejects(runtimeAuthority.verifyRetainedReleasePair(pair), /verification failed/u);
  const expectedSha256 = createHash('sha256').update('invalid archive').digest('hex');
  fs.writeFileSync(`${pair.archivePath}.sha256`, `${expectedSha256}\n`);
  const result = pairCli({ ...pair, expectedSha256 });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /unsafe release archive/u);
});

test('retained release pair rejects an oversized archive before reading its bytes', {
  skip: process.platform === 'win32',
}, async (t) => {
  const pair = await releasePair(t);
  fs.truncateSync(pair.archivePath, 536870913);
  await assert.rejects(runtimeAuthority.verifyRetainedReleasePair(pair), /archive.*byte bound/u);
});

for (const target of ['archive', 'sidecar']) {
  const fileFor = (pair) => target === 'archive' ? pair.archivePath : `${pair.archivePath}.sha256`;
  test(`retained release pair refuses missing or non-regular ${target}`, async (t) => {
    const pair = await releasePair(t);
    const file = fileFor(pair);
    fs.unlinkSync(file);
    await assert.rejects(runtimeAuthority.verifyRetainedReleasePair(pair), /missing or unreadable/u);
    fs.mkdirSync(file);
    await assert.rejects(runtimeAuthority.verifyRetainedReleasePair(pair), /regular no-follow/u);
  });

  test(`retained release pair refuses hard-linked ${target}`, async (t) => {
    const pair = await releasePair(t);
    fs.linkSync(fileFor(pair), path.join(pair.root, 'extra-link'));
    await assert.rejects(runtimeAuthority.verifyRetainedReleasePair(pair), /single-link/u);
  });

  test(`retained release pair refuses symlinked or non-private ${target}`, {
    skip: process.platform === 'win32',
  }, async (t) => {
    const pair = await releasePair(t);
    const file = fileFor(pair);
    fs.chmodSync(file, 0o644);
    await assert.rejects(runtimeAuthority.verifyRetainedReleasePair(pair), /exact private owner and mode/u);
    fs.chmodSync(file, 0o600);
    const moved = path.join(pair.root, 'original');
    fs.renameSync(file, moved);
    fs.symlinkSync(moved, file);
    await assert.rejects(runtimeAuthority.verifyRetainedReleasePair(pair), /regular no-follow/u);
  });

  test(`retained release pair refuses foreign-owned ${target}`, {
    skip: process.platform === 'win32' || process.getuid() !== 0,
  }, async (t) => {
    const pair = await releasePair(t);
    fs.chownSync(fileFor(pair), 1, 1);
    await assert.rejects(runtimeAuthority.verifyRetainedReleasePair(pair), /exact private owner and mode/u);
  });

  test(`retained release pair rechecks ${target} bytes after real archive validation`, async (t) => {
    const pair = await releasePair(t);
    // The validator has parsed the real archive synchronously. Its actual await yields before
    // final reproof, so this changes a real file without a fake validator or fault-injection hook.
    const pending = runtimeAuthority.verifyRetainedReleasePair(pair);
    const file = fileFor(pair);
    const changed = fs.readFileSync(file);
    changed[0] ^= 1;
    fs.writeFileSync(file, changed);
    await assert.rejects(pending, /identity or bytes changed/u);
  });

  test(`retained release pair rechecks ${target} identity even when replacement bytes match`, async (t) => {
    const pair = await releasePair(t);
    const file = fileFor(pair);
    const pending = runtimeAuthority.verifyRetainedReleasePair(pair);
    const replacement = path.join(pair.root, 'replacement');
    fs.copyFileSync(file, replacement);
    fs.chmodSync(replacement, 0o600);
    fs.renameSync(file, path.join(pair.root, 'captured-original'));
    fs.renameSync(replacement, file);
    await assert.rejects(pending, /identity or bytes changed/u);
  });
}

test('retained release pair takes fresh authorities on each invocation', async (t) => {
  const pair = await releasePair(t);
  await runtimeAuthority.verifyRetainedReleasePair(pair);
  const replacement = path.join(pair.root, 'replacement');
  fs.copyFileSync(pair.archivePath, replacement);
  fs.chmodSync(replacement, 0o600);
  fs.renameSync(pair.archivePath, path.join(pair.root, 'old-archive'));
  fs.renameSync(replacement, pair.archivePath);
  assert.equal(await runtimeAuthority.verifyRetainedReleasePair(pair), undefined);
});

function shellPair(pair, body) {
  return spawnSync('/bin/bash', ['--noprofile', '--norc', '-c',
    'source "$1" || exit\nrelease_store="$2"\nsha="$3"\ntrace="$4"\n' + body,
    'release-pair-test', path.resolve('scripts/staging-release-common.sh'), pair.root,
    pair.expectedSha256, path.join(pair.root, 'bounded-calls')], {
    encoding: 'utf8', timeout: 10000, maxBuffer: 4096,
    env: { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, LANG: 'C' },
  });
}

test('shell retained-pair verification runs the real CLI in one existing 60-second bounded call', {
  skip: process.platform !== 'linux',
}, async (t) => {
  const pair = await releasePair(t);
  const stored = path.join(pair.root, `release-${pair.expectedSha256}.tar.gz`);
  fs.renameSync(pair.archivePath, stored);
  fs.renameSync(`${pair.archivePath}.sha256`, `${stored}.sha256`);
  const result = shellPair(pair, [
    'run_bounded() { printf "%s\\n" "$@" >> "$trace"; shift; "$@"; }',
    'verify_release_pair "$sha" candidate',
  ].join('\n'));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.deepEqual(fs.readFileSync(path.join(pair.root, 'bounded-calls'), 'utf8').trim().split('\n'),
    ['60', 'node', path.resolve('scripts/staging-runtime-authority.js'),
      'verify-release-pair', stored, pair.expectedSha256, 'candidate']);
});

test('shell retained-pair verification preserves real nonzero operation status and path prechecks', {
  skip: process.platform !== 'linux',
}, async (t) => {
  const pair = await releasePair(t);
  const stored = path.join(pair.root, `release-${pair.expectedSha256}.tar.gz`);
  fs.renameSync(pair.archivePath, stored);
  fs.renameSync(`${pair.archivePath}.sha256`, `${stored}.sha256`);
  for (const status of [1, 23, 124, 125, 137]) {
    const result = shellPair(pair, [
      `run_bounded() { node -e 'process.exitCode = ${status}'; }`,
      'verify_release_pair "$sha" candidate',
    ].join('\n'));
    assert.equal(result.status, status, result.stderr);
    assert.equal(result.stdout, '');
  }
  const precheck = () => shellPair(pair, [
    'run_bounded() { printf invoked; return 0; }',
    'verify_release_pair "$sha" candidate',
  ].join('\n'));
  for (const file of [stored, `${stored}.sha256`]) {
    const original = `${file}.original`;
    fs.renameSync(file, original);
    for (const kind of ['missing', 'directory', 'symlink']) {
      if (kind === 'directory') fs.mkdirSync(file);
      if (kind === 'symlink') fs.symlinkSync(original, file);
      const result = precheck();
      assert.equal(result.status, 1, result.stderr);
      assert.equal(result.stdout, '');
      if (kind === 'directory') fs.rmdirSync(file);
      if (kind === 'symlink') fs.unlinkSync(file);
    }
    fs.renameSync(original, file);
  }
});

test('all existing release callers map pair failures to their fail-closed transaction outcome', {
  skip: process.platform !== 'linux',
}, async (t) => {
  const pair = await releasePair(t);
  const stored = path.join(pair.root, `release-${pair.expectedSha256}.tar.gz`);
  fs.renameSync(pair.archivePath, stored);
  fs.renameSync(`${pair.archivePath}.sha256`, `${stored}.sha256`);
  const callers = [
    ['staging-release-common.sh', [1, 1, 1, 1, 1]],
    ['staging-rollback.sh', [67, 65]],
    ['staging-restart-app.sh', [67]],
    ['staging-cutover.sh', [1, 67]],
  ];
  for (const [file, expectedStatuses] of callers) {
    // Execute each unchanged call expression from the real scripts at the shell seam.
    // Surrounding deployment actions are outside this finite mapping test.
    const source = fs.readFileSync(path.resolve('scripts', file), 'utf8');
    const calls = [...source.matchAll(/^\s*(verify_release_pair [^\r\n]+)$/gmu)]
      .map((match) => match[1]);
    assert.equal(calls.length, expectedStatuses.length, file);
    for (const [index, call] of calls.entries()) {
      for (const status of [1, 124, 125, 137]) {
        const result = shellPair(pair, [
          'active_sha="$sha"; previous_sha="$sha"; target_sha="$sha"',
          'expected_sha="$sha"; bridge_sha="$sha"',
          `run_bounded() { node -e 'process.exitCode = ${status}'; }`,
          `caller() {\n${call}\nprintf unsafe-continuation\n}\ncaller`,
        ].join('\n'));
        assert.equal(result.status, expectedStatuses[index], `${file}: ${call}: ${result.stderr}`);
        assert.equal(result.stdout, '', `${file}: no action may follow a failed pair`);
      }
    }
  }
});
