import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { assertNoSecretPatterns } from '../scripts/secret-scan-contract.js';
import { gitTrackedFiles } from '../scripts/verify-docker-context.js';

const projectDirectory = fileURLToPath(new URL('..', import.meta.url));

test('prebuild secret and Docker-context guard is independent of ignored build output', async () => {
  const [manifestSource, scannerSource] = await Promise.all([
    fs.readFile(path.join(projectDirectory, 'scripts', 'aisy-release-candidate-files.json'), 'utf8'),
    fs.readFile(path.join(projectDirectory, 'scripts', 'scan-secrets.js'), 'utf8'),
  ]);
  const manifest = JSON.parse(manifestSource);
  assert.equal(manifest.files.some((file) => file === 'dist' || file.startsWith('dist/')), false,
    'the prebuild source inventory cannot require ignored dist bytes from an earlier build');
  assert.doesNotMatch(scannerSource, /verify-release-artifact|verifyReleaseArtifact|dist\/public/u,
    'artifact verification belongs strictly after the sole build, not in the prebuild source scan');
});

test('secret scan includes an explicit untracked candidate inventory without sweeping the worktree', async () => {
  const temporary = await fs.mkdtemp(path.join(projectDirectory, '.secret-candidate-test-'));
  try {
    const relativeDirectory = path.relative(projectDirectory, temporary).split(path.sep).join('/');
    const fixture = `${relativeDirectory}/candidate.txt`;
    const manifest = `${relativeDirectory}/candidate-files.json`;
    await fs.writeFile(path.join(projectDirectory, fixture), ['x', 'ai-', 'z'.repeat(40)].join(''));
    await fs.writeFile(path.join(projectDirectory, manifest), `${JSON.stringify({
      schemaVersion: 'aisy-release-candidate-files-v1', files: [manifest, fixture],
    }, null, 2)}\n`);

    const result = spawnSync(process.execPath, [
      'scripts/scan-secrets.js', '--candidate-manifest', manifest,
    ], { cwd: projectDirectory, encoding: 'utf8' });
    assert.notEqual(result.status, 0, 'an assembled secret in an explicit untracked candidate must fail the gate');
    assert.match(result.stderr, /candidate\.txt: xAI key/u);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /aisy-style-lab|product-readiness-audit/u,
      'the explicit candidate scan must not sweep protected unrelated untracked paths');
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

test('secret scan checks binary candidate bytes instead of trusting a file suffix', async () => {
  const temporary = await fs.mkdtemp(path.join(projectDirectory, '.secret-binary-candidate-test-'));
  try {
    const relativeDirectory = path.relative(projectDirectory, temporary).split(path.sep).join('/');
    const fixture = `${relativeDirectory}/candidate.png`;
    const manifest = `${relativeDirectory}/candidate-files.json`;
    const assembled = ['g', 'sk_', 'b'.repeat(40)].join('');
    await fs.writeFile(path.join(projectDirectory, fixture), Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]), Buffer.from(assembled, 'ascii'),
    ]));
    await fs.writeFile(path.join(projectDirectory, manifest), `${JSON.stringify({
      schemaVersion: 'aisy-release-candidate-files-v1', files: [manifest, fixture],
    }, null, 2)}\n`);

    const result = spawnSync(process.execPath, [
      'scripts/scan-secrets.js', '--candidate-manifest', manifest,
    ], { cwd: projectDirectory, encoding: 'utf8' });
    assert.notEqual(result.status, 0, 'an assembled secret in binary candidate bytes must fail the gate');
    assert.match(result.stderr, /candidate\.png: Groq key/u);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, new RegExp(assembled, 'u'));
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

test('secret scan includes its own scanner sources and reports only successful reads', async () => {
  const scanner = await fs.readFile(path.join(projectDirectory, 'scripts', 'scan-secrets.js'), 'utf8');
  assert.doesNotMatch(scanner, /ignoredFiles/u,
    'the mandatory gate must not exempt its own executable scanner sources');

  const temporary = await fs.mkdtemp(path.join(projectDirectory, '.secret-clean-candidate-test-'));
  try {
    const relativeDirectory = path.relative(projectDirectory, temporary).split(path.sep).join('/');
    const fixture = `${relativeDirectory}/candidate.txt`;
    const manifest = `${relativeDirectory}/candidate-files.json`;
    await fs.writeFile(path.join(projectDirectory, fixture), 'bounded clean candidate\n');
    await fs.writeFile(path.join(projectDirectory, manifest), `${JSON.stringify({
      schemaVersion: 'aisy-release-candidate-files-v1', files: [manifest, fixture],
    }, null, 2)}\n`);
    const expected = new Set([...gitTrackedFiles(projectDirectory), manifest, fixture]).size;
    const result = spawnSync(process.execPath, [
      'scripts/scan-secrets.js', '--candidate-manifest', manifest,
    ], { cwd: projectDirectory, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`; ${expected} unique files read`, 'u'));
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

test('secret scan fails closed when a declared file is missing or changes during its read', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-secret-read-'));
  const file = path.join(directory, 'candidate.txt');
  try {
    assert.throws(() => assertNoSecretPatterns({
      rootDirectory: directory, files: ['missing.txt'], scanAllBytes: true,
    }), /missing\.txt.*(?:missing|read|open)/iu);

    await fs.writeFile(file, 'initial safe bytes\n');
    const originalRead = fsSync.readFileSync;
    let changed = false;
    try {
      fsSync.readFileSync = function patchedRead(target, ...args) {
        const result = originalRead.call(this, target, ...args);
        if (!changed && (target === file || typeof target === 'number')) {
          changed = true;
          fsSync.appendFileSync(file, 'changed after read\n');
        }
        return result;
      };
      assert.throws(() => assertNoSecretPatterns({
        rootDirectory: directory, files: ['candidate.txt'], scanAllBytes: true,
      }), /candidate\.txt.*changed/iu);
    } finally {
      fsSync.readFileSync = originalRead;
    }
    assert.equal(changed, true);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
