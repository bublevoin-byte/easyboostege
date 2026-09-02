import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';

const gitBash = process.platform === 'win32' ? 'C:\\Program Files\\Git\\bin\\bash.exe' : 'bash';
const harness = path.resolve('test/staging-deadline-test-harness.js');
const transactionSupervisor = path.resolve('scripts/staging-transaction-supervisor.js');

function posixPath(value) {
  return value.replace(/^([A-Za-z]):/u, (_, drive) => `/${drive.toLowerCase()}`)
    .replaceAll('\\', '/');
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

test('deadline harness settles DISARM only after reclaiming the bounded session descendant',
  async (context) => {
    const probe = spawnSync(gitBash, ['--version'], { encoding: 'utf8' });
    if (probe.error?.code === 'ENOENT') return context.skip('Git Bash is not installed');
    assert.equal(probe.status, 0, probe.stderr);
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-deadline-harness-session-'));
    context.after(() => fs.rm(root, { force: true, recursive: true }));
    const descendantPid = path.join(root, 'descendant.pid');
    const descendantReady = path.join(root, 'descendant.ready');
    context.after(async () => {
      const pid = Number(await fs.readFile(descendantPid, 'utf8').catch(() => '0'));
      if (!Number.isSafeInteger(pid) || pid <= 0) return;
      if (process.platform === 'win32') {
        spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
      } else {
        try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch {} }
      }
    });
    const script = path.join(root, 'disarmed-leader-with-descendant.sh');
    await fs.writeFile(script, [
      '#!/bin/bash',
      'set -Eeuo pipefail',
      `node ${JSON.stringify(posixPath(transactionSupervisor))} --ready 1800 1000`,
      `(trap '' HUP TERM; echo $BASHPID > ${JSON.stringify(posixPath(descendantPid))}; echo ready > ${JSON.stringify(posixPath(descendantReady))}; while :; do sleep 1; done) &`,
      `while [ ! -s ${JSON.stringify(posixPath(descendantReady))} ]; do :; done`,
      `node ${JSON.stringify(posixPath(transactionSupervisor))} --request DISARM 0 1 1000`,
    ].join('\n'));
    const configuration = Buffer.from(JSON.stringify({
      arguments: [],
      bash: gitBash,
      controlKey: 'deadline-harness-session-settlement-red',
      recoverySeconds: 600,
      script: posixPath(script),
      transactionSeconds: 1800,
    })).toString('base64url');
    const result = spawnSync(process.execPath, [harness, configuration], {
      encoding: 'utf8',
      env: {
        ...process.env,
        EASYBOOST_STAGING_DEADLINE_TEST_CONTROL_ROOT: path.join(root, 'deadline'),
        EASYBOOST_STAGING_SESSION_TEST_CONTROL_ROOT: path.join(root, 'session'),
      },
      timeout: 15_000,
    });
    // Windows Job Objects can report that descendants existed and therefore
    // preserve the stricter 125 semantic result. Linux cannot prove that
    // historical fact without a racy /proc snapshot; its isolated wrapper
    // instead kills the whole session and proves it absent before returning.
    const expectedStatus = process.platform === 'win32' ? 125 : 0;
    assert.equal(result.status, expectedStatus, `${result.stdout}\n${result.stderr}`);
    const pid = Number(await fs.readFile(descendantPid, 'utf8'));
    assert.equal(alive(pid), false, 'deadline harness returned before its descendant was reaped');
  });

test('deadline harness accepts DISARM only after the bounded supervisor proves its session empty',
  async (context) => {
    const probe = spawnSync(gitBash, ['--version'], { encoding: 'utf8' });
    if (probe.error?.code === 'ENOENT') return context.skip('Git Bash is not installed');
    assert.equal(probe.status, 0, probe.stderr);
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-deadline-harness-proven-'));
    context.after(() => fs.rm(root, { force: true, recursive: true }));
    const script = path.join(root, 'disarm-and-exit.sh');
    await fs.writeFile(script, [
      '#!/bin/bash',
      'set -Eeuo pipefail',
      `node ${JSON.stringify(posixPath(transactionSupervisor))} --ready 1800 1000`,
      `node ${JSON.stringify(posixPath(transactionSupervisor))} --request DISARM 0 1 1000`,
    ].join('\n'));
    const configuration = Buffer.from(JSON.stringify({
      arguments: [], bash: gitBash, controlKey: 'deadline-harness-proven-session-green',
      recoverySeconds: 600, script: posixPath(script), transactionSeconds: 1800,
    })).toString('base64url');
    const result = spawnSync(process.execPath, [harness, configuration], {
      encoding: 'utf8',
      env: {
        ...process.env,
        EASYBOOST_STAGING_DEADLINE_TEST_CONTROL_ROOT: path.join(root, 'deadline'),
        EASYBOOST_STAGING_SESSION_TEST_CONTROL_ROOT: path.join(root, 'session'),
      },
      timeout: 15_000,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  });

test('deadline harness reclaims its exact retired mailbox before the same operation retries',
  async (context) => {
    const probe = spawnSync(gitBash, ['--version'], { encoding: 'utf8' });
    if (probe.error?.code === 'ENOENT') return context.skip('Git Bash is not installed');
    assert.equal(probe.status, 0, probe.stderr);
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-deadline-harness-retry-'));
    context.after(() => fs.rm(root, { force: true, recursive: true }));
    const script = path.join(root, 'disarm-and-retry.sh');
    await fs.writeFile(script, [
      '#!/bin/bash',
      'set -Eeuo pipefail',
      `node ${JSON.stringify(posixPath(transactionSupervisor))} --ready 1800 1000`,
      `node ${JSON.stringify(posixPath(transactionSupervisor))} --request DISARM 0 1 1000`,
    ].join('\n'));
    const configuration = Buffer.from(JSON.stringify({
      arguments: [], bash: gitBash, controlKey: 'deadline-harness-exact-retry',
      recoverySeconds: 600, script: posixPath(script), transactionSeconds: 1800,
    })).toString('base64url');
    const deadlineRoot = path.join(root, 'deadline');
    const sessionRoot = path.join(root, 'session');
    const run = () => spawnSync(process.execPath, [harness, configuration], {
      encoding: 'utf8',
      env: {
        ...process.env,
        EASYBOOST_STAGING_DEADLINE_TEST_CONTROL_ROOT: deadlineRoot,
        EASYBOOST_STAGING_SESSION_TEST_CONTROL_ROOT: sessionRoot,
      },
      timeout: 15_000,
    });
    const first = run();
    const retry = run();
    assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`);
    assert.equal(retry.status, 0, `${retry.stdout}\n${retry.stderr}`);
    assert.deepEqual(await fs.readdir(deadlineRoot), []);
  });
