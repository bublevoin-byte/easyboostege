import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  POSIX_RELEASE_MAINTENANCE_LANES,
  POSIX_RELEASE_MAINTENANCE_SCOPE_PROTOCOL,
  createPosixReleaseMaintenanceLauncherInvocation,
  establishPosixReleaseMaintenanceScope,
} from '../scripts/posix-release-maintenance-scope.js';

const projectDirectory = fileURLToPath(new URL('..', import.meta.url));

test('POSIX release maintenance source fixes two lanes and strips capability from targets', () => {
  assert.deepEqual(POSIX_RELEASE_MAINTENANCE_LANES,
    ['aisy-release-e2e', 'pwa-predecessor']);
  assert.equal(POSIX_RELEASE_MAINTENANCE_SCOPE_PROTOCOL,
    'easyboost-posix-release-maintenance-scope-v2');
  const launcher = fs.readFileSync('scripts/posix-release-maintenance-launcher.sh', 'utf8');
  const sessionSupervisor = fs.readFileSync('scripts/posix-session-supervisor.js', 'utf8');
  assert.match(launcher, /\/usr\/bin\/flock -n 8/u);
  assert.match(launcher, /exec 8<> "\$lock_file"/u);
  assert.match(launcher,
    /EASYBOOST_POSIX_RELEASE_MAINTENANCE_SCOPE="\$environment_value"/u);
  assert.match(sessionSupervisor,
    /delete targetEnvironment\[POSIX_RELEASE_MAINTENANCE_ENVIRONMENT\]/u);
});

test('POSIX release maintenance launcher accepts a target command with no arguments', () => {
  const launcher = fs.readFileSync('scripts/posix-release-maintenance-launcher.sh', 'utf8');
  assert.match(launcher, /\[ "\$#" -ge 6 \]/u);
});

test('real Linux launcher proves fd8 flock, consumes one lane and returns an opaque binding', {
  skip: process.platform !== 'linux',
}, () => {
  const temporaryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'easyboost-release-scope-integration-'),
  );
  const environment = {
    ...process.env,
    GITHUB_ACTIONS: 'true',
    GITHUB_JOB: 'scope-integration',
    GITHUB_RUN_ATTEMPT: '1',
    GITHUB_RUN_ID: '424242',
    RUNNER_TEMP: temporaryDirectory,
  };
  try {
    const descriptor = establishPosixReleaseMaintenanceScope({
      checkoutDirectory: projectDirectory,
      environment,
      lane: 'pwa-predecessor',
    });
    const moduleUrl = pathToFileURL(path.join(
      projectDirectory, 'scripts', 'posix-release-maintenance-scope.js',
    )).href;
    const program = [
      `import { consumePosixReleaseMaintenanceBinding, resolvePosixReleaseMaintenanceBinding } from ${JSON.stringify(moduleUrl)};`,
      `const binding = consumePosixReleaseMaintenanceBinding({ checkoutDirectory: ${JSON.stringify(projectDirectory)}, lane: 'pwa-predecessor' });`,
      'const resolved = resolvePosixReleaseMaintenanceBinding(binding, { lane: \'pwa-predecessor\' });',
      'process.stdout.write(`${JSON.stringify({ controlRoot: resolved.controlRoot, recoveryScope: resolved.recoveryScope })}\\n`);',
    ].join('\n');
    const invocation = createPosixReleaseMaintenanceLauncherInvocation(
      descriptor, process.execPath, ['--input-type=module', '-e', program], {
        cwd: projectDirectory,
        environment,
      },
    );
    const result = spawnSync(invocation.command, invocation.args, {
      cwd: invocation.cwd,
      encoding: 'utf8',
      env: invocation.environment,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout.trim());
    assert.equal(path.basename(report.controlRoot), 'posix-session-controls');
    assert.match(report.recoveryScope,
      /^easyboost-posix-release-maintenance-scope-v2:[a-f0-9]{64}:posix-session-controls$/u);
  } finally {
    fs.rmSync(temporaryDirectory, { force: true, recursive: true });
  }
});
