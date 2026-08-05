import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const gitBash = process.platform === 'win32' ? 'C:\\Program Files\\Git\\bin\\bash.exe' : 'bash';
const deployScript = path.resolve('scripts/staging-deploy.sh');

function posixPath(value) {
  return value.replace(/^([A-Za-z]):/u, (_, drive) => `/${drive.toLowerCase()}`).replaceAll('\\', '/');
}

function runBash(args, options = {}) {
  const result = spawnSync(gitBash, args, { encoding: 'utf8', ...options });
  if (result.error?.code === 'ENOENT') return null;
  return result;
}

test('staging deploy installs an exact release while preserving only runtime state', async (context) => {
  const probe = runBash(['--version']);
  if (!probe) return context.skip('Git Bash is not installed');
  assert.equal(probe.status, 0, probe.stderr);

  const root = await fs.mkdtemp(path.join(process.cwd(), '.tmp-easyboost-deploy-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const appDir = path.join(root, 'app');
  const releaseDir = path.join(root, 'release');
  const fakeBin = path.join(root, 'fake-bin');
  await Promise.all([
    fs.mkdir(path.join(appDir, 'rollbacks'), { recursive: true }),
    fs.mkdir(path.join(appDir, 'backups'), { recursive: true }),
    fs.mkdir(path.join(releaseDir, 'scripts'), { recursive: true }),
    fs.mkdir(fakeBin, { recursive: true }),
  ]);

  await Promise.all([
    fs.writeFile(path.join(releaseDir, 'compose.staging.yml'), 'name: new-release\n'),
    fs.writeFile(path.join(releaseDir, 'shared.txt'), 'new\n'),
    fs.writeFile(path.join(releaseDir, 'new-only.txt'), 'new-only\n'),
    fs.writeFile(path.join(releaseDir, 'scripts', 'new.sh'), '#!/bin/sh\n'),
    fs.writeFile(path.join(appDir, 'compose.staging.yml'), 'name: old-release\n'),
    fs.writeFile(path.join(appDir, 'shared.txt'), 'old\n'),
    fs.writeFile(path.join(appDir, 'old-only.txt'), 'must disappear\n'),
    fs.writeFile(path.join(appDir, '.env.staging'), 'APP_PORT=3001\nSECRET=preserved\n'),
    fs.writeFile(path.join(appDir, 'backups', 'keep.dump'), 'backup\n'),
    fs.writeFile(path.join(appDir, 'rollbacks', 'keep.tar.gz'), 'older rollback\n'),
  ]);

  const archive = path.join(root, 'release.tar.gz');
  const packed = runBash(['-lc', `tar -czf '${posixPath(archive)}' -C '${posixPath(releaseDir)}' .`]);
  assert.equal(packed.status, 0, packed.stderr);
  const expectedSha = crypto.createHash('sha256').update(await fs.readFile(archive)).digest('hex');

  const bashEnv = path.join(fakeBin, 'commands.sh');
  await fs.writeFile(bashEnv, [
    'install() { return 0; }',
    'docker() { return 0; }',
    'curl() { return 0; }',
    'sleep() { return 0; }',
    '',
  ].join('\n'));

  const result = runBash([posixPath(deployScript), posixPath(archive), expectedSha], {
    env: {
      ...process.env,
      STAGING_APP_DIR: posixPath(appDir),
      BASH_ENV: posixPath(bashEnv),
    },
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);

  assert.equal(await fs.readFile(path.join(appDir, 'shared.txt'), 'utf8'), 'new\n');
  assert.equal(await fs.readFile(path.join(appDir, 'new-only.txt'), 'utf8'), 'new-only\n');
  await assert.rejects(fs.access(path.join(appDir, 'old-only.txt')), { code: 'ENOENT' });
  assert.equal(await fs.readFile(path.join(appDir, '.env.staging'), 'utf8'), 'APP_PORT=3001\nSECRET=preserved\n');
  assert.equal(await fs.readFile(path.join(appDir, 'backups', 'keep.dump'), 'utf8'), 'backup\n');
  assert.equal(await fs.readFile(path.join(appDir, 'rollbacks', 'keep.tar.gz'), 'utf8'), 'older rollback\n');
  assert.equal(await fs.readFile(path.join(appDir, '.release-sha256'), 'utf8'), `${expectedSha}\n`);

  const rollbacks = await fs.readdir(path.join(appDir, 'rollbacks'));
  assert.equal(rollbacks.some((name) => name.startsWith(`code-before-${expectedSha.slice(0, 12)}-`)), true);
});
