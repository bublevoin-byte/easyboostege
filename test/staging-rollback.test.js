import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const gitBash = process.platform === 'win32' ? 'C:\\Program Files\\Git\\bin\\bash.exe' : 'bash';
const rollbackScript = path.resolve('scripts/staging-rollback.sh');

function posixPath(value) {
  return value.replace(/^([A-Za-z]):/u, (_, drive) => `/${drive.toLowerCase()}`).replaceAll('\\', '/');
}

function runBash(args, options = {}) {
  const result = spawnSync(gitBash, args, { encoding: 'utf8', ...options });
  if (result.error?.code === 'ENOENT') return null;
  return result;
}

test('staging rollback restores an exact code release while preserving only staging runtime state', async (context) => {
  const probe = runBash(['--version']);
  if (!probe) return context.skip('Git Bash is not installed');
  assert.equal(probe.status, 0, probe.stderr);

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-rollback-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const appDir = path.join(root, 'app');
  const sourceDir = path.join(root, 'old-release');
  const fakeBin = path.join(root, 'fake-bin');
  await Promise.all([
    fs.mkdir(path.join(appDir, 'rollbacks'), { recursive: true }),
    fs.mkdir(path.join(appDir, 'backups'), { recursive: true }),
    fs.mkdir(path.join(sourceDir, 'scripts'), { recursive: true }),
    fs.mkdir(fakeBin, { recursive: true }),
  ]);

  await Promise.all([
    fs.writeFile(path.join(sourceDir, 'compose.staging.yml'), 'name: old-release\n'),
    fs.writeFile(path.join(sourceDir, 'shared.txt'), 'old\n'),
    fs.writeFile(path.join(sourceDir, 'old-only.txt'), 'old-only\n'),
    fs.writeFile(path.join(sourceDir, '.release-sha256'), 'old-release\n'),
    fs.writeFile(path.join(sourceDir, 'scripts', 'old.sh'), '#!/bin/sh\n'),
    fs.writeFile(path.join(appDir, 'compose.staging.yml'), 'name: new-release\n'),
    fs.writeFile(path.join(appDir, 'shared.txt'), 'new\n'),
    fs.writeFile(path.join(appDir, 'new-only.txt'), 'must disappear\n'),
    fs.writeFile(path.join(appDir, '.env.staging'), 'APP_PORT=3001\nSECRET=preserved\n'),
    fs.writeFile(path.join(appDir, 'backups', 'keep.dump'), 'backup\n'),
    fs.writeFile(path.join(appDir, 'rollbacks', 'keep.tar.gz'), 'older rollback\n'),
  ]);

  const archive = path.join(appDir, 'rollbacks', 'code-before-test-20260805T120000Z.tar.gz');
  const packed = runBash(['-lc', `tar -czf '${posixPath(archive)}' -C '${posixPath(sourceDir)}' .`]);
  assert.equal(packed.status, 0, packed.stderr);

  const bashEnv = path.join(fakeBin, 'commands.sh');
  await fs.writeFile(bashEnv, [
    'docker() { return 0; }',
    'curl() { return 0; }',
    'sleep() { return 0; }',
    '',
  ].join('\n'));

  const result = runBash([posixPath(rollbackScript), posixPath(archive)], {
    env: {
      ...process.env,
      STAGING_APP_DIR: posixPath(appDir),
      BASH_ENV: posixPath(bashEnv),
    },
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);

  assert.equal(await fs.readFile(path.join(appDir, 'shared.txt'), 'utf8'), 'old\n');
  assert.equal(await fs.readFile(path.join(appDir, 'old-only.txt'), 'utf8'), 'old-only\n');
  await assert.rejects(fs.access(path.join(appDir, 'new-only.txt')), { code: 'ENOENT' });
  assert.equal(await fs.readFile(path.join(appDir, '.env.staging'), 'utf8'), 'APP_PORT=3001\nSECRET=preserved\n');
  assert.equal(await fs.readFile(path.join(appDir, 'backups', 'keep.dump'), 'utf8'), 'backup\n');
  assert.equal(await fs.readFile(path.join(appDir, 'rollbacks', 'keep.tar.gz'), 'utf8'), 'older rollback\n');
  assert.equal((await fs.stat(archive)).isFile(), true);

  await fs.writeFile(path.join(sourceDir, '.env.staging'), 'SECRET=archive-must-not-overwrite\n');
  const protectedArchive = path.join(appDir, 'rollbacks', 'code-before-protected-20260805T130000Z.tar.gz');
  const packedProtected = runBash([
    '-lc', `tar -czf '${posixPath(protectedArchive)}' -C '${posixPath(sourceDir)}' .`,
  ]);
  assert.equal(packedProtected.status, 0, packedProtected.stderr);
  const rejected = runBash([posixPath(rollbackScript), posixPath(protectedArchive)], {
    env: { ...process.env, STAGING_APP_DIR: posixPath(appDir), BASH_ENV: posixPath(bashEnv) },
  });
  assert.equal(rejected.status, 65, `${rejected.stdout}\n${rejected.stderr}`);
  assert.match(rejected.stderr, /protected runtime path: \.env\.staging/u);
  assert.equal(await fs.readFile(path.join(appDir, 'shared.txt'), 'utf8'), 'old\n');
  assert.equal(await fs.readFile(path.join(appDir, '.env.staging'), 'utf8'), 'APP_PORT=3001\nSECRET=preserved\n');
});
