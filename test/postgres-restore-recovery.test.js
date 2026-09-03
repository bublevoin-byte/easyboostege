import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  acquireHostOperationAbsenceLease,
  acquireHostOperationLock,
  openRetainedHostOperationLock,
  proveHostOperationLockAbsent,
  releaseHostOperationLock,
  retainHostOperationLock,
} from '../scripts/host-operation-lock.js';
import {
  recoverRetainedProductionAppLifecycle,
  runProductionAppLifecycle,
} from '../scripts/production-app-lifecycle.js';
import { restorePostgresBackup } from '../scripts/postgres-restore.js';
import {
  createDisposablePostgresVerificationRuntime,
  verifyPostgresBackup,
} from '../scripts/postgres-verify-backup.js';

const appContainerId = '1'.repeat(64);
const postgresContainerId = '2'.repeat(64);
const replacementAppContainerId = '3'.repeat(64);
const applicationImageId = `sha256:${'a'.repeat(64)}`;
const postgresImageId = `sha256:${'b'.repeat(64)}`;
const previousApplicationImageId = `sha256:${'c'.repeat(64)}`;

function productionComposeAllocation({ containerId, imageId, running, service = 'app' }) {
  return [
    containerId,
    'easyboost-production',
    service,
    'False',
    imageId,
    String(running),
  ].join('|');
}

function fileSystemWith(overrides) {
  return new Proxy(fs, {
    get(target, property) {
      if (Object.hasOwn(overrides, property)) return overrides[property];
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

test('host guard timeout rejects only after release and retain mutations have settled',
  async () => {
    let releaseSettled = false;
    const startedAt = Date.now();
    await assert.rejects(releaseHostOperationLock(async () => {
      await new Promise((resolve) => { setTimeout(resolve, 30); });
      releaseSettled = true;
    }, 5), /Host operation lock release timed out/u);

    assert.equal(releaseSettled, true);
    assert.ok(Date.now() - startedAt >= 20);

    let retainSettled = false;
    const adapter = async () => {};
    adapter.retain = async () => {
      await new Promise((resolve) => { setTimeout(resolve, 30); });
      retainSettled = true;
    };
    await assert.rejects(retainHostOperationLock(adapter, 5, {}),
      /Host operation lock retention timed out/u);
    assert.equal(retainSettled, true);
  });

test('host guard absence lease blocks concurrent acquisition through caller transition', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-host-absence-'));
  const hostLockDirectory = path.join(directory, 'host.lock');
  try {
    const release = await acquireHostOperationLock({
      lockDirectory: hostLockDirectory,
      operation: 'database-restore',
    });
    await releaseHostOperationLock(release, 1_000);
    const absenceLease = await acquireHostOperationAbsenceLease({
      lockDirectory: hostLockDirectory,
    });
    assert.equal(absenceLease.state, 'absent-leased');
    assert.equal(absenceLease.lockDirectory, hostLockDirectory);
    await assert.rejects(acquireHostOperationLock({
      lockDirectory: hostLockDirectory,
      operation: 'database-import',
    }), /HOST_OPERATION_LOCKED/u);
    await absenceLease.release();

    const compatibilityLease = await proveHostOperationLockAbsent({
      lockDirectory: hostLockDirectory,
    });
    assert.deepEqual({
      lockDirectory: compatibilityLease.lockDirectory,
      state: compatibilityLease.state,
    }, {
      lockDirectory: hostLockDirectory,
      state: 'absent-leased',
    });
    await compatibilityLease.release();

    await fs.mkdir(hostLockDirectory, { mode: 0o700 });
    await assert.rejects(proveHostOperationLockAbsent({
      lockDirectory: hostLockDirectory,
    }), /HOST_OPERATION_LOCK_NOT_ABSENT/u);
    await fs.rmdir(hostLockDirectory);

    const pending = `${hostLockDirectory}.completing-foreign`;
    await fs.mkdir(pending, { mode: 0o700 });
    await assert.rejects(proveHostOperationLockAbsent({
      lockDirectory: hostLockDirectory,
    }), /HOST_OPERATION_LOCK_NOT_ABSENT/u);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('host guard retention cannot overwrite a marker swapped before atomic publication',
  async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-retain-swap-'));
    const hostLockDirectory = path.join(directory, 'host.lock');
    const retainedFile = path.join(hostLockDirectory, 'retained');
    let swapped = false;
    const fileSystem = fileSystemWith({
      async link(source, destination) {
        if (destination === retainedFile && !swapped) {
          swapped = true;
          await fs.writeFile(destination, 'foreign-retained-marker\n', {
            flag: 'wx',
            mode: 0o600,
          });
        }
        return fs.link(source, destination);
      },
    });
    try {
      const release = await acquireHostOperationLock({
        fileSystem,
        lockDirectory: hostLockDirectory,
        operation: 'production-app-lifecycle',
      });
      await assert.rejects(retainHostOperationLock(release, 100, {
        currentContainerId: replacementAppContainerId,
        lastProof: 'exact-stop-proof-rejected',
        lastState: 'mutation-settlement-unproven',
        lifecycleAction: 'replace',
        newImageId: applicationImageId,
        previousContainerId: appContainerId,
        previousImageId: previousApplicationImageId,
        reason: 'APP_MUTATION_SETTLEMENT_UNPROVEN',
      }));
      assert.equal(swapped, true);
      assert.equal(await fs.readFile(retainedFile, 'utf8'), 'foreign-retained-marker\n');
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

test('matching pre-publication retained authority is reopenable after a process restart',
  async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-retain-resume-'));
    const hostLockDirectory = path.join(directory, 'host.lock');
    let publicationFailed = false;
    const fileSystem = fileSystemWith({
      async link(source, destination) {
        if (path.basename(destination) === 'retained' && !publicationFailed) {
          publicationFailed = true;
          const error = new Error('injected retained publication failure');
          error.code = 'EIO';
          throw error;
        }
        return fs.link(source, destination);
      },
    });
    try {
      const release = await acquireHostOperationLock({
        fileSystem,
        lockDirectory: hostLockDirectory,
        operation: 'production-app-lifecycle',
      });
      await assert.rejects(retainHostOperationLock(release, 100, {
        currentContainerId: appContainerId,
        lastProof: 'exact-app-stopped-proved',
        lastState: 'app-stopped',
        lifecycleAction: 'restart',
        newImageId: applicationImageId,
        previousContainerId: appContainerId,
        previousImageId: applicationImageId,
        reason: 'APP_MUTATION_SETTLEMENT_UNPROVEN',
      }), /injected retained publication failure/u);
      assert.equal(publicationFailed, true);
      await assert.rejects(fs.access(path.join(hostLockDirectory, 'retained')), {
        code: 'ENOENT',
      });

      const reopened = await openRetainedHostOperationLock({
        expectedOperation: 'production-app-lifecycle',
        lockDirectory: hostLockDirectory,
      });
      assert.equal(reopened.reason, 'APP_MUTATION_SETTLEMENT_UNPROVEN');
      await reopened.complete();
      await assert.rejects(fs.access(hostLockDirectory), { code: 'ENOENT' });
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

test('host guard retention treats Linux directory fsync EPERM as a retained failure',
  async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-retain-fsync-'));
    const hostLockDirectory = path.join(directory, 'host.lock');
    let directorySyncAttempted = false;
    let denyDirectorySync = false;
    const fileSystem = fileSystemWith({
      async open(target, ...arguments_) {
        const handle = await fs.open(target, ...arguments_);
        if (target !== hostLockDirectory || arguments_[0] !== 'r') return handle;
        return new Proxy(handle, {
          get(handleTarget, property) {
            if (property === 'sync') {
              return async () => {
                if (!denyDirectorySync) return undefined;
                directorySyncAttempted = true;
                const error = new Error('injected Linux directory sync denial');
                error.code = 'EPERM';
                throw error;
              };
            }
            const value = Reflect.get(handleTarget, property);
            return typeof value === 'function' ? value.bind(handleTarget) : value;
          },
        });
      },
    });
    try {
      const release = await acquireHostOperationLock({
        fileSystem,
        lockDirectory: hostLockDirectory,
        operation: 'production-app-lifecycle',
        platform: 'linux',
      });
      denyDirectorySync = true;
      await assert.rejects(retainHostOperationLock(release, 100, {
        currentContainerId: replacementAppContainerId,
        lastProof: 'exact-stop-proof-rejected',
        lastState: 'mutation-settlement-unproven',
        lifecycleAction: 'replace',
        newImageId: applicationImageId,
        previousContainerId: appContainerId,
        previousImageId: previousApplicationImageId,
        reason: 'APP_MUTATION_SETTLEMENT_UNPROVEN',
      }), /injected Linux directory sync denial/u);
      assert.equal(directorySyncAttempted, true);
      assert.match(await fs.readFile(path.join(hostLockDirectory, 'retained'), 'utf8'),
        /^RETAINED$/mu);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

test('host guard never treats Windows directory fsync EPERM as durable', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-win32-fsync-'));
  const hostLockDirectory = path.join(directory, 'host.lock');
  let denyDirectorySync = false;
  const fileSystem = fileSystemWith({
    async open(target, ...arguments_) {
      const openArguments = target === hostLockDirectory
          && arguments_[0] === 'r+' && process.platform !== 'win32'
        ? ['r', ...arguments_.slice(1)]
        : arguments_;
      const handle = await fs.open(target, ...openArguments);
      if (target !== hostLockDirectory) return handle;
      return new Proxy(handle, {
        get(handleTarget, property) {
          if (property === 'sync') {
            return async () => {
              if (!denyDirectorySync) return undefined;
              const error = new Error('injected Windows directory sync denial');
              error.code = 'EPERM';
              throw error;
            };
          }
          const value = Reflect.get(handleTarget, property);
          return typeof value === 'function' ? value.bind(handleTarget) : value;
        },
      });
    },
  });
  try {
    const release = await acquireHostOperationLock({
      fileSystem,
      lockDirectory: hostLockDirectory,
      operation: 'production-app-lifecycle',
      platform: 'win32',
    });
    denyDirectorySync = true;
    await assert.rejects(retainHostOperationLock(release, 100, {
      currentContainerId: appContainerId,
      lastProof: 'exact-app-stopped-proved',
      lastState: 'app-stopped',
      lifecycleAction: 'restart',
      newImageId: applicationImageId,
      previousContainerId: appContainerId,
      previousImageId: applicationImageId,
      reason: 'APP_MUTATION_SETTLEMENT_UNPROVEN',
    }), /injected Windows directory sync denial/u);
    assert.match(await fs.readFile(path.join(hostLockDirectory, 'retained'), 'utf8'),
      /^RETAINED$/mu);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('host guard acquisition failure moves the exact owned directory to an abandoned record',
  async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-acquire-abandon-'));
    const hostLockDirectory = path.join(directory, 'host.lock');
    const ownerFile = path.join(hostLockDirectory, 'owner');
    let failedWrite = false;
    const fileSystem = fileSystemWith({
      async open(target, ...arguments_) {
        if (target === ownerFile && !failedWrite) {
          failedWrite = true;
          const error = new Error('injected active marker write failure');
          error.code = 'ENOSPC';
          throw error;
        }
        return fs.open(target, ...arguments_);
      },
    });
    try {
      await assert.rejects(acquireHostOperationLock({
        fileSystem,
        lockDirectory: hostLockDirectory,
        operation: 'production-app-lifecycle',
      }), /injected active marker write failure/u);
      await assert.rejects(fs.access(hostLockDirectory), { code: 'ENOENT' });
      const abandoned = (await fs.readdir(directory))
        .filter((entry) => entry.startsWith('host.lock.abandoned-'));
      assert.equal(abandoned.length, 1);
      assert.match(
        await fs.readFile(path.join(directory, abandoned[0], 'abandoned'), 'utf8'),
        /^ABANDONED\nprotocol=easyboost-host-operation-abandoned-v1$/mu,
      );
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

test('host guard acquisition cannot leave a canonical wedge when abandoned evidence write fails',
  async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-acquire-no-wedge-'));
    const hostLockDirectory = path.join(directory, 'host.lock');
    const ownerFile = path.join(hostLockDirectory, 'owner');
    const abandonedFile = path.join(hostLockDirectory, 'abandoned');
    const fileSystem = fileSystemWith({
      async open(target, ...arguments_) {
        if (target === ownerFile || target === abandonedFile) {
          const error = new Error(`injected write failure for ${path.basename(target)}`);
          error.code = 'ENOSPC';
          throw error;
        }
        return fs.open(target, ...arguments_);
      },
    });
    try {
      await assert.rejects(acquireHostOperationLock({
        fileSystem,
        lockDirectory: hostLockDirectory,
        operation: 'production-app-lifecycle',
      }));
      await assert.rejects(fs.access(hostLockDirectory), { code: 'ENOENT' });
      assert.equal((await fs.readdir(directory)).filter(
        (entry) => entry.startsWith('host.lock.abandoned-'),
      ).length, 1);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

test('next acquisition settles an exact abandoned canonical directory after rename failure',
  async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-acquire-resume-'));
    const hostLockDirectory = path.join(directory, 'host.lock');
    const ownerFile = path.join(hostLockDirectory, 'owner');
    let ownerFailed = false;
    let abandonRenameFailed = false;
    const fileSystem = fileSystemWith({
      async open(target, ...arguments_) {
        if (target === ownerFile && !ownerFailed) {
          ownerFailed = true;
          const error = new Error('injected active acquisition failure');
          error.code = 'ENOSPC';
          throw error;
        }
        return fs.open(target, ...arguments_);
      },
      async rename(source, destination) {
        if (source === hostLockDirectory
            && destination.startsWith(`${hostLockDirectory}.abandoned-`)
            && !abandonRenameFailed) {
          abandonRenameFailed = true;
          const error = new Error('injected abandoned rename failure');
          error.code = 'EIO';
          throw error;
        }
        return fs.rename(source, destination);
      },
    });
    try {
      await assert.rejects(acquireHostOperationLock({
        fileSystem,
        lockDirectory: hostLockDirectory,
        operation: 'production-app-lifecycle',
      }));
      assert.equal(ownerFailed, true);
      assert.equal(abandonRenameFailed, true);
      assert.match(await fs.readFile(path.join(hostLockDirectory, 'abandoned'), 'utf8'),
        /^ABANDONED$/mu);

      const release = await acquireHostOperationLock({
        lockDirectory: hostLockDirectory,
        operation: 'production-app-lifecycle',
      });
      await releaseHostOperationLock(release, 100);
      await assert.rejects(fs.access(hostLockDirectory), { code: 'ENOENT' });
      assert.equal((await fs.readdir(directory)).some(
        (entry) => entry.startsWith('host.lock.abandoned-'),
      ), false);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

test('retained lifecycle guard atomically publishes typed evidence beside the active owner',
  async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-lifecycle-evidence-'));
    const hostLockDirectory = path.join(directory, 'host.lock');
    try {
      const release = await acquireHostOperationLock({
        lockDirectory: hostLockDirectory,
        operation: 'production-app-lifecycle',
      });
      const activeMarker = await fs.readFile(path.join(hostLockDirectory, 'owner'), 'utf8');
      assert.doesNotMatch(activeMarker, /^RETAINED$/mu);

      await retainHostOperationLock(release, 100, {
        currentContainerId: replacementAppContainerId,
        lastProof: 'exact-stop-proof-rejected',
        lastState: 'mutation-settlement-unproven',
        lifecycleAction: 'replace',
        newImageId: applicationImageId,
        previousContainerId: appContainerId,
        previousImageId: previousApplicationImageId,
        reason: 'APP_MUTATION_SETTLEMENT_UNPROVEN',
      });

      assert.equal(await fs.readFile(path.join(hostLockDirectory, 'owner'), 'utf8'), [
        'protocol=easyboost-host-operation-v1',
        'operation=production-app-lifecycle',
        `ownerPid=${process.pid}`,
        '',
      ].join('\n'));
      assert.equal(await fs.readFile(path.join(hostLockDirectory, 'retained'), 'utf8'), [
        'RETAINED',
        'protocol=easyboost-host-operation-v2',
        'operation=production-app-lifecycle',
        `ownerPid=${process.pid}`,
        'evidenceKind=production-app-lifecycle',
        'lifecycleAction=replace',
        'reason=APP_MUTATION_SETTLEMENT_UNPROVEN',
        `previousImageId=${previousApplicationImageId}`,
        `newImageId=${applicationImageId}`,
        `currentContainerId=${replacementAppContainerId}`,
        `previousContainerId=${appContainerId}`,
        'lastProof=exact-stop-proof-rejected',
        'lastState=mutation-settlement-unproven',
        '',
      ].join('\n'));
      const retainedIdentity = await fs.lstat(path.join(hostLockDirectory, 'retained'), {
        bigint: true,
      });
      const retainedAuthorityIdentity = await fs.lstat(
        path.join(hostLockDirectory, 'retained-authority'),
        { bigint: true },
      );
      assert.equal(retainedIdentity.ino, retainedAuthorityIdentity.ino);
      assert.equal(retainedIdentity.nlink, 2n);
      await assert.rejects(release(), /HOST_OPERATION_LOCK_RETAINED/u);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

test('retained lifecycle recovery handle is bound to the exact marker and directory identity',
  async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-retained-identity-'));
    const hostLockDirectory = path.join(directory, 'host.lock');
    const movedLockDirectory = path.join(directory, 'original-host.lock');
    try {
      const release = await acquireHostOperationLock({
        lockDirectory: hostLockDirectory,
        operation: 'production-app-lifecycle',
      });
      await retainHostOperationLock(release, 100, {
        currentContainerId: appContainerId,
        lastProof: 'exact-stop-proof-rejected',
        lastState: 'mutation-settlement-unproven',
        lifecycleAction: 'restart',
        newImageId: applicationImageId,
        previousContainerId: appContainerId,
        previousImageId: applicationImageId,
        reason: 'APP_MUTATION_SETTLEMENT_UNPROVEN',
      });

      const retained = await openRetainedHostOperationLock({
        expectedOperation: 'production-app-lifecycle',
        lockDirectory: hostLockDirectory,
      });
      assert.deepEqual(retained.evidence, {
        currentContainerId: appContainerId,
        lastProof: 'exact-stop-proof-rejected',
        lastState: 'mutation-settlement-unproven',
        lifecycleAction: 'restart',
        newImageId: applicationImageId,
        previousContainerId: appContainerId,
        previousImageId: applicationImageId,
        reason: 'APP_MUTATION_SETTLEMENT_UNPROVEN',
      });

      await fs.rename(hostLockDirectory, movedLockDirectory);
      await fs.mkdir(hostLockDirectory, { mode: 0o700 });
      await fs.writeFile(path.join(hostLockDirectory, 'owner'), 'foreign\n', { mode: 0o600 });
      await assert.rejects(retained.release(), /HOST_OPERATION_LOCK_OWNERSHIP_CHANGED/u);
      assert.equal(await fs.readFile(path.join(hostLockDirectory, 'owner'), 'utf8'), 'foreign\n');
      assert.match(await fs.readFile(path.join(movedLockDirectory, 'retained'), 'utf8'),
        /^RETAINED$/mu);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

test('retained import host guard round-trips exact typed DB evidence and completes by identity',
  async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-import-host-marker-'));
    const hostLockDirectory = path.join(directory, 'host.lock');
    const operationToken = '12345678-1234-4abc-8def-1234567890ab';
    const evidence = {
      applicationName: `easyboost_import_${operationToken}`,
      importContainerId: replacementAppContainerId,
      kind: 'import',
      lastProbe: { activityCount: 1, process: 'ACTIVE', status: 'REMOVAL_UNPROVEN' },
      operationToken,
      ownershipToken: 'e'.repeat(64),
      postgresContainerId,
    };
    try {
      const release = await acquireHostOperationLock({
        lockDirectory: hostLockDirectory,
        operation: 'database-import',
      });
      await retainHostOperationLock(release, 100, {
        ...evidence,
        retentionReason: 'IMPORT_REMOTE_SETTLEMENT_UNPROVEN',
      });
      const retained = await openRetainedHostOperationLock({
        expectedOperation: 'database-import',
        lockDirectory: hostLockDirectory,
      });
      assert.equal(retained.operation, 'database-import');
      assert.equal(retained.reason, 'IMPORT_REMOTE_SETTLEMENT_UNPROVEN');
      assert.deepEqual(retained.evidence, evidence);
      await retained.complete();
      await assert.rejects(fs.access(hostLockDirectory), { code: 'ENOENT' });
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

test('host retention returns exact completion authority for write-ahead finalization',
  async () => {
    const directory = await fs.mkdtemp(path.resolve('.test-host-write-ahead-'));
    const hostLockDirectory = path.join(directory, 'host.lock');
    const operationToken = '12345678-1234-4abc-8def-1234567890ab';
    const evidence = {
      applicationName: `easyboost_import_${operationToken}`,
      importContainerId: 'unknown',
      kind: 'import',
      lastProbe: { activityCount: 'unknown', process: 'UNKNOWN', status: 'UNKNOWN' },
      operationToken,
      ownershipToken: 'e'.repeat(64),
      postgresContainerId: 'unknown',
      retentionReason: 'IMPORT_CONTAINER_SETTLEMENT_UNPROVEN',
    };
    try {
      const release = await acquireHostOperationLock({
        lockDirectory: hostLockDirectory,
        operation: 'database-import',
      });
      const complete = await retainHostOperationLock(release, 2_000, evidence);
      assert.equal(typeof complete, 'function');
      await complete();
      await assert.rejects(fs.access(hostLockDirectory), { code: 'ENOENT' });
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

test('retained restore host guard mirrors exact DB restore evidence', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-restore-host-marker-'));
  const hostLockDirectory = path.join(directory, 'host.lock');
  const operationToken = '22345678-1234-4abc-8def-1234567890ab';
  const evidence = {
    applicationName: `easyboost_restore_${operationToken}`,
    kind: 'restore',
    lastProbe: { activityCount: 0, process: 'NONE', status: 'EXIT:0' },
    operationToken,
    postgresContainerId,
  };
  try {
    const release = await acquireHostOperationLock({
      lockDirectory: hostLockDirectory,
      operation: 'database-restore',
    });
    await retainHostOperationLock(release, 100, {
      ...evidence,
      retentionReason: 'REMOTE_RESTORE_SETTLEMENT_UNPROVEN',
    });
    const retained = await openRetainedHostOperationLock({
      expectedOperation: 'database-restore',
      lockDirectory: hostLockDirectory,
    });
    assert.equal(retained.operation, 'database-restore');
    assert.equal(retained.reason, 'REMOTE_RESTORE_SETTLEMENT_UNPROVEN');
    assert.deepEqual(retained.evidence, evidence);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('retained host completion resumes from its exact finalization sidecar after failure',
  async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-host-complete-retry-'));
    const hostLockDirectory = path.join(directory, 'host.lock');
    let finalizeFailed = false;
    const fileSystem = fileSystemWith({
      async link(source, destination) {
        if (path.basename(destination) === 'completed' && !finalizeFailed) {
          finalizeFailed = true;
          const error = new Error('injected finalization commit failure');
          error.code = 'EIO';
          throw error;
        }
        return fs.link(source, destination);
      },
    });
    try {
      const release = await acquireHostOperationLock({
        lockDirectory: hostLockDirectory,
        operation: 'production-app-lifecycle',
      });
      await retainHostOperationLock(release, 2_000, {
        currentContainerId: appContainerId,
        lastProof: 'exact-app-stopped-proved',
        lastState: 'app-stopped',
        lifecycleAction: 'restart',
        newImageId: applicationImageId,
        previousContainerId: appContainerId,
        previousImageId: applicationImageId,
        reason: 'APP_MUTATION_SETTLEMENT_UNPROVEN',
      });

      const first = await openRetainedHostOperationLock({
        expectedOperation: 'production-app-lifecycle',
        fileSystem,
        lockDirectory: hostLockDirectory,
      });
      await assert.rejects(first.complete(), /injected finalization commit failure/u);
      assert.equal(finalizeFailed, true);

      const retry = await openRetainedHostOperationLock({
        expectedOperation: 'production-app-lifecycle',
        lockDirectory: hostLockDirectory,
      });
      await retry.complete();
      await assert.rejects(fs.access(hostLockDirectory), { code: 'ENOENT' });
      const sidecars = (await fs.readdir(directory)).filter(
        (entry) => entry.startsWith('host.lock.completing-'),
      );
      assert.equal(sidecars.length, 1);
      assert.match(await fs.readFile(path.join(directory, sidecars[0], 'completed'), 'utf8'),
        /^COMPLETED$/mu);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

test('durable valid completion survives one transient final validation failure', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-complete-revalidate-'));
  const hostLockDirectory = path.join(directory, 'host.lock');
  let validationFailed = false;
  const fileSystem = fileSystemWith({
    async readdir(target, options) {
      const entries = await fs.readdir(target, options);
      if (target.startsWith(`${hostLockDirectory}.completing-`)
          && entries.some((entry) => (typeof entry === 'string' ? entry : entry.name) === 'completed')
          && !validationFailed) {
        validationFailed = true;
        const error = new Error('injected final completion validation failure');
        error.code = 'EIO';
        throw error;
      }
      return entries;
    },
  });
  try {
    const release = await acquireHostOperationLock({
      lockDirectory: hostLockDirectory,
      operation: 'production-app-lifecycle',
    });
    await retainHostOperationLock(release, 100, {
      currentContainerId: appContainerId,
      lastProof: 'exact-app-stopped-proved',
      lastState: 'app-stopped',
      lifecycleAction: 'restart',
      newImageId: applicationImageId,
      previousContainerId: appContainerId,
      previousImageId: applicationImageId,
      reason: 'APP_MUTATION_SETTLEMENT_UNPROVEN',
    });
    const retained = await openRetainedHostOperationLock({
      expectedOperation: 'production-app-lifecycle',
      fileSystem,
      lockDirectory: hostLockDirectory,
    });
    await retained.complete();
    assert.equal(validationFailed, true);
    const absenceLease = await acquireHostOperationAbsenceLease({
      lockDirectory: hostLockDirectory,
    });
    await absenceLease.release();
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('new acquisition resumes exact active import and restore completion after restart',
  async () => {
    for (const operation of ['database-import', 'database-restore']) {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-active-resume-'));
      const hostLockDirectory = path.join(directory, 'host.lock');
      let publicationFailed = false;
      const fileSystem = fileSystemWith({
        async link(source, destination) {
          if (path.basename(destination) === 'completed' && !publicationFailed) {
            publicationFailed = true;
            const error = new Error(`injected ${operation} completion publication failure`);
            error.code = 'EIO';
            throw error;
          }
          return fs.link(source, destination);
        },
      });
      try {
        const release = await acquireHostOperationLock({
          fileSystem,
          lockDirectory: hostLockDirectory,
          operation,
        });
        await assert.rejects(releaseHostOperationLock(release, 1_000),
          new RegExp(`injected ${operation} completion publication failure`, 'u'));
        assert.equal(publicationFailed, true);
        await assert.rejects(fs.access(hostLockDirectory), { code: 'ENOENT' });
        const sidecar = (await fs.readdir(directory)).find(
          (entry) => entry.startsWith('host.lock.completing-'),
        );
        assert.ok(sidecar);
        assert.match(
          await fs.readFile(path.join(directory, sidecar, 'completion-authority'), 'utf8'),
          new RegExp(`operation=${operation}`, 'u'),
        );

        const nextRelease = await acquireHostOperationLock({
          lockDirectory: hostLockDirectory,
          operation: 'staging-release',
        });
        await releaseHostOperationLock(nextRelease, 1_000);
      } finally {
        await fs.rm(directory, { recursive: true, force: true });
      }
    }
  });

test('new acquisition resumes active completion before its authority publication', async () => {
  for (const operation of ['database-import', 'database-restore']) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-active-intent-'));
    const hostLockDirectory = path.join(directory, 'host.lock');
    let authorityFailed = false;
    const fileSystem = fileSystemWith({
      async rename(source, destination) {
        if (path.basename(source) === 'completion-intent'
            && path.basename(destination) === 'completion-authority'
            && !authorityFailed) {
          authorityFailed = true;
          const error = new Error(`injected ${operation} completion authority failure`);
          error.code = 'EIO';
          throw error;
        }
        return fs.rename(source, destination);
      },
    });
    try {
      const release = await acquireHostOperationLock({
        fileSystem,
        lockDirectory: hostLockDirectory,
        operation,
      });
      await assert.rejects(releaseHostOperationLock(release, 1_000),
        new RegExp(`injected ${operation} completion authority failure`, 'u'));
      assert.equal(authorityFailed, true);
      await assert.rejects(fs.access(hostLockDirectory), { code: 'ENOENT' });
      const sidecar = (await fs.readdir(directory)).find(
        (entry) => entry.startsWith('host.lock.completing-'),
      );
      assert.ok(sidecar);
      assert.deepEqual((await fs.readdir(path.join(directory, sidecar))).sort(),
        ['completion-intent', 'owner']);
      assert.match(await fs.readFile(path.join(directory, sidecar, 'owner'), 'utf8'),
        new RegExp(`operation=${operation}`, 'u'));

      const next = await acquireHostOperationLock({
        lockDirectory: hostLockDirectory,
        operation: 'staging-release',
      });
      await releaseHostOperationLock(next, 1_000);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  }
});

test('durable completion intent makes a failed canonical claim restart-recoverable', async () => {
  for (const operation of ['database-import', 'database-restore']) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-completion-intent-'));
    const hostLockDirectory = path.join(directory, 'host.lock');
    let claimFailed = false;
    const fileSystem = fileSystemWith({
      async rename(source, destination) {
        if (source === hostLockDirectory
            && destination.startsWith(`${hostLockDirectory}.completing-`)
            && !claimFailed) {
          claimFailed = true;
          const error = new Error(`injected ${operation} canonical completion claim failure`);
          error.code = 'EIO';
          throw error;
        }
        return fs.rename(source, destination);
      },
    });
    try {
      const release = await acquireHostOperationLock({
        fileSystem,
        lockDirectory: hostLockDirectory,
        operation,
      });
      await assert.rejects(releaseHostOperationLock(release, 1_000),
        new RegExp(`injected ${operation} canonical completion claim failure`, 'u'));
      assert.equal(claimFailed, true);
      assert.deepEqual((await fs.readdir(hostLockDirectory)).sort(),
        ['completion-intent', 'owner']);
      assert.match(await fs.readFile(path.join(hostLockDirectory, 'completion-intent'), 'utf8'),
        new RegExp(`operation=${operation}`, 'u'));

      const next = await acquireHostOperationLock({
        lockDirectory: hostLockDirectory,
        operation: 'staging-release',
      });
      await releaseHostOperationLock(next, 1_000);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  }
});

test('retained host completion preserves a foreign marker swapped after its last check',
  async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-host-complete-swap-'));
    const hostLockDirectory = path.join(directory, 'host.lock');
    let swapped = false;
    const fileSystem = fileSystemWith({
      async rename(source, destination) {
        if (source === hostLockDirectory
            && destination.startsWith(`${hostLockDirectory}.completing-`)
            && !swapped) {
          swapped = true;
          await fs.unlink(path.join(hostLockDirectory, 'retained'));
          await fs.writeFile(path.join(hostLockDirectory, 'retained'), 'foreign-retained\n', {
            flag: 'wx',
            mode: 0o600,
          });
        }
        return fs.rename(source, destination);
      },
    });
    try {
      const release = await acquireHostOperationLock({
        lockDirectory: hostLockDirectory,
        operation: 'production-app-lifecycle',
      });
      await retainHostOperationLock(release, 100, {
        currentContainerId: appContainerId,
        lastProof: 'exact-app-stopped-proved',
        lastState: 'app-stopped',
        lifecycleAction: 'restart',
        newImageId: applicationImageId,
        previousContainerId: appContainerId,
        previousImageId: applicationImageId,
        reason: 'APP_MUTATION_SETTLEMENT_UNPROVEN',
      });
      const retained = await openRetainedHostOperationLock({
        expectedOperation: 'production-app-lifecycle',
        fileSystem,
        lockDirectory: hostLockDirectory,
      });
      await assert.rejects(retained.complete(), /HOST_OPERATION_LOCK_OWNERSHIP_CHANGED/u);
      assert.equal(swapped, true);
      const sidecars = (await fs.readdir(directory)).filter(
        (entry) => entry.startsWith('host.lock.completing-'),
      );
      assert.equal(sidecars.length, 1);
      assert.equal(await fs.readFile(path.join(directory, sidecars[0], 'retained'), 'utf8'),
        'foreign-retained\n');
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

test('retained completion restores a whole foreign directory swapped before rename',
  async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-host-dir-swap-'));
    const hostLockDirectory = path.join(directory, 'host.lock');
    const originalDirectory = path.join(directory, 'owned-original.lock');
    let swapped = false;
    const fileSystem = fileSystemWith({
      async rename(source, destination) {
        if (source === hostLockDirectory
            && destination.startsWith(`${hostLockDirectory}.completing-`)
            && !swapped) {
          swapped = true;
          await fs.rename(hostLockDirectory, originalDirectory);
          await fs.mkdir(hostLockDirectory, { mode: 0o700 });
          await fs.writeFile(path.join(hostLockDirectory, 'foreign'), 'foreign-directory\n', {
            flag: 'wx',
            mode: 0o600,
          });
        }
        return fs.rename(source, destination);
      },
    });
    try {
      const release = await acquireHostOperationLock({
        lockDirectory: hostLockDirectory,
        operation: 'production-app-lifecycle',
      });
      await retainHostOperationLock(release, 100, {
        currentContainerId: appContainerId,
        lastProof: 'exact-app-stopped-proved',
        lastState: 'app-stopped',
        lifecycleAction: 'restart',
        newImageId: applicationImageId,
        previousContainerId: appContainerId,
        previousImageId: applicationImageId,
        reason: 'APP_MUTATION_SETTLEMENT_UNPROVEN',
      });
      const retained = await openRetainedHostOperationLock({
        expectedOperation: 'production-app-lifecycle',
        fileSystem,
        lockDirectory: hostLockDirectory,
      });
      await assert.rejects(retained.complete(), /HOST_OPERATION_LOCK_OWNERSHIP_CHANGED/u);
      assert.equal(swapped, true);
      assert.equal(await fs.readFile(path.join(hostLockDirectory, 'foreign'), 'utf8'),
        'foreign-directory\n');
      assert.match(await fs.readFile(path.join(originalDirectory, 'retained'), 'utf8'),
        /^RETAINED$/mu);
      assert.equal((await fs.readdir(directory)).some(
        (entry) => entry.startsWith('host.lock.completing-'),
      ), false);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

test('active host release preserves a foreign owner swapped after its last check', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-host-release-swap-'));
  const hostLockDirectory = path.join(directory, 'host.lock');
  let swapped = false;
  const fileSystem = fileSystemWith({
    async rename(source, destination) {
      if (source === hostLockDirectory
          && destination.startsWith(`${hostLockDirectory}.completing-`)
          && !swapped) {
        swapped = true;
        await fs.unlink(path.join(hostLockDirectory, 'owner'));
        await fs.writeFile(path.join(hostLockDirectory, 'owner'), 'foreign-owner\n', {
          flag: 'wx',
          mode: 0o600,
        });
      }
      return fs.rename(source, destination);
    },
  });
  try {
    const release = await acquireHostOperationLock({
      fileSystem,
      lockDirectory: hostLockDirectory,
      operation: 'production-app-lifecycle',
    });
    await assert.rejects(releaseHostOperationLock(release, 100),
      /HOST_OPERATION_LOCK_OWNERSHIP_CHANGED/u);
    assert.equal(swapped, true);
    const sidecars = (await fs.readdir(directory)).filter(
      (entry) => entry.startsWith('host.lock.completing-'),
    );
    assert.equal(sidecars.length, 1);
    assert.equal(await fs.readFile(path.join(directory, sidecars[0], 'owner'), 'utf8'),
      'foreign-owner\n');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('host acquisition rejects a canonical swap before owner open without marking foreign state',
  async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-host-owner-open-swap-'));
    const hostLockDirectory = path.join(directory, 'host.lock');
    const displacedOwnedDirectory = path.join(directory, 'displaced-owned.lock');
    const ownerFile = path.join(hostLockDirectory, 'owner');
    let swapped = false;
    const fileSystem = fileSystemWith({
      async open(target, ...arguments_) {
        if (target === ownerFile && !swapped) {
          swapped = true;
          await fs.rename(hostLockDirectory, displacedOwnedDirectory);
          await fs.mkdir(hostLockDirectory, { mode: 0o700 });
          await fs.writeFile(path.join(hostLockDirectory, 'foreign'), 'foreign-directory\n', {
            flag: 'wx',
            mode: 0o600,
          });
        }
        return fs.open(target, ...arguments_);
      },
    });
    try {
      await assert.rejects(acquireHostOperationLock({
        fileSystem,
        lockDirectory: hostLockDirectory,
        operation: 'production-app-lifecycle',
      }), /HOST_OPERATION_LOCK_OWNERSHIP_CHANGED/u);
      assert.equal(swapped, true);
      assert.equal(await fs.readFile(path.join(hostLockDirectory, 'foreign'), 'utf8'),
        'foreign-directory\n');
      await assert.rejects(fs.access(ownerFile), { code: 'ENOENT' });
      assert.deepEqual(await fs.readdir(displacedOwnedDirectory), []);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

test('host acquisition revalidates canonical identity after its final protocol scan', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-host-final-swap-'));
  const hostLockDirectory = path.join(directory, 'host.lock');
  const displacedOwnedDirectory = path.join(directory, 'displaced-owned.lock');
  let swapped = false;
  const fileSystem = fileSystemWith({
    async readdir(target, options) {
      const entries = await fs.readdir(target, options);
      if (target === directory && !swapped) {
        const ownerExists = await fs.access(path.join(hostLockDirectory, 'owner'))
          .then(() => true, () => false);
        if (ownerExists) {
          swapped = true;
          await fs.rename(hostLockDirectory, displacedOwnedDirectory);
          await fs.mkdir(hostLockDirectory, { mode: 0o700 });
          await fs.writeFile(path.join(hostLockDirectory, 'foreign'), 'foreign-directory\n', {
            mode: 0o600,
          });
        }
      }
      return entries;
    },
  });
  try {
    await assert.rejects(acquireHostOperationLock({
      fileSystem,
      lockDirectory: hostLockDirectory,
      operation: 'production-app-lifecycle',
    }), /HOST_OPERATION_LOCK_OWNERSHIP_CHANGED/u);
    assert.equal(swapped, true);
    assert.equal(await fs.readFile(path.join(hostLockDirectory, 'foreign'), 'utf8'),
      'foreign-directory\n');
    assert.match(await fs.readFile(path.join(displacedOwnedDirectory, 'owner'), 'utf8'),
      /operation=production-app-lifecycle/u);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('host retention rejects a canonical swap before authority open without marking foreign state',
  async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-host-retain-open-swap-'));
    const hostLockDirectory = path.join(directory, 'host.lock');
    const displacedOwnedDirectory = path.join(directory, 'displaced-owned.lock');
    const retainedAuthorityFile = path.join(hostLockDirectory, 'retained-authority');
    let swapped = false;
    const fileSystem = fileSystemWith({
      async open(target, ...arguments_) {
        if (target === retainedAuthorityFile && arguments_[0] === 'wx' && !swapped) {
          swapped = true;
          await fs.rename(hostLockDirectory, displacedOwnedDirectory);
          await fs.mkdir(hostLockDirectory, { mode: 0o700 });
          await fs.writeFile(path.join(hostLockDirectory, 'foreign'), 'foreign-directory\n', {
            flag: 'wx',
            mode: 0o600,
          });
        }
        return fs.open(target, ...arguments_);
      },
    });
    try {
      const release = await acquireHostOperationLock({
        fileSystem,
        lockDirectory: hostLockDirectory,
        operation: 'production-app-lifecycle',
      });
      await assert.rejects(retainHostOperationLock(release, 1_000, {
        currentContainerId: appContainerId,
        lastProof: 'exact-app-stopped-proved',
        lastState: 'app-stopped',
        lifecycleAction: 'restart',
        newImageId: applicationImageId,
        previousContainerId: appContainerId,
        previousImageId: applicationImageId,
        reason: 'APP_MUTATION_SETTLEMENT_UNPROVEN',
      }), /HOST_OPERATION_LOCK_OWNERSHIP_CHANGED/u);
      assert.equal(swapped, true);
      assert.equal(await fs.readFile(path.join(hostLockDirectory, 'foreign'), 'utf8'),
        'foreign-directory\n');
      await assert.rejects(fs.access(retainedAuthorityFile), { code: 'ENOENT' });
      assert.deepEqual(await fs.readdir(displacedOwnedDirectory), ['owner']);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

test('retained host open rejects a canonical swap at authority open and preserves both identities',
  async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-host-open-swap-'));
    const hostLockDirectory = path.join(directory, 'host.lock');
    const displacedOwnedDirectory = path.join(directory, 'displaced-owned.lock');
    const retainedAuthorityFile = path.join(hostLockDirectory, 'retained-authority');
    let swapped = false;
    try {
      const release = await acquireHostOperationLock({
        lockDirectory: hostLockDirectory,
        operation: 'production-app-lifecycle',
      });
      await retainHostOperationLock(release, 1_000, {
        currentContainerId: appContainerId,
        lastProof: 'exact-app-stopped-proved',
        lastState: 'app-stopped',
        lifecycleAction: 'restart',
        newImageId: applicationImageId,
        previousContainerId: appContainerId,
        previousImageId: applicationImageId,
        reason: 'APP_MUTATION_SETTLEMENT_UNPROVEN',
      });
      const fileSystem = fileSystemWith({
        async open(target, ...arguments_) {
          if (target === retainedAuthorityFile && arguments_[0] === 'r' && !swapped) {
            swapped = true;
            await fs.rename(hostLockDirectory, displacedOwnedDirectory);
            await fs.mkdir(hostLockDirectory, { mode: 0o700 });
            await fs.writeFile(path.join(hostLockDirectory, 'foreign'), 'foreign-directory\n', {
              flag: 'wx',
              mode: 0o600,
            });
          }
          return fs.open(target, ...arguments_);
        },
      });
      await assert.rejects(openRetainedHostOperationLock({
        expectedOperation: 'production-app-lifecycle',
        fileSystem,
        lockDirectory: hostLockDirectory,
      }), /HOST_OPERATION_LOCK_OWNERSHIP_CHANGED/u);
      assert.equal(swapped, true);
      assert.equal(await fs.readFile(path.join(hostLockDirectory, 'foreign'), 'utf8'),
        'foreign-directory\n');
      assert.match(await fs.readFile(path.join(displacedOwnedDirectory, 'retained'), 'utf8'),
        /^RETAINED$/mu);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

test('acquisition cleanup restores a foreign canonical directory swapped at its claim rename',
  async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-host-cleanup-swap-'));
    const hostLockDirectory = path.join(directory, 'host.lock');
    const displacedOwnedDirectory = path.join(directory, 'displaced-owned.lock');
    const ownerFile = path.join(hostLockDirectory, 'owner');
    let ownerFailed = false;
    let swapped = false;
    const fileSystem = fileSystemWith({
      async open(target, ...arguments_) {
        if (target === ownerFile && !ownerFailed) {
          ownerFailed = true;
          const error = new Error('injected acquisition marker failure');
          error.code = 'ENOSPC';
          throw error;
        }
        return fs.open(target, ...arguments_);
      },
      async rename(source, destination) {
        if (source === hostLockDirectory
            && destination.startsWith(`${hostLockDirectory}.abandoned-`)
            && !swapped) {
          swapped = true;
          await fs.rename(hostLockDirectory, displacedOwnedDirectory);
          await fs.mkdir(hostLockDirectory, { mode: 0o700 });
          await fs.writeFile(path.join(hostLockDirectory, 'foreign'), 'foreign-directory\n', {
            flag: 'wx',
            mode: 0o600,
          });
        }
        return fs.rename(source, destination);
      },
    });
    try {
      await assert.rejects(acquireHostOperationLock({
        fileSystem,
        lockDirectory: hostLockDirectory,
        operation: 'production-app-lifecycle',
      }));
      assert.equal(ownerFailed, true);
      assert.equal(swapped, true);
      assert.equal(await fs.readFile(path.join(hostLockDirectory, 'foreign'), 'utf8'),
        'foreign-directory\n');
      assert.match(await fs.readFile(path.join(displacedOwnedDirectory, 'abandoned'), 'utf8'),
        /^ABANDONED$/mu);
      assert.equal((await fs.readdir(directory)).some(
        (entry) => entry.startsWith('host.lock.abandoned-'),
      ), false);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

test('completion restoration never replaces a canonical directory created at restore rename',
  async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-host-restore-swap-'));
    const hostLockDirectory = path.join(directory, 'host.lock');
    const displacedOwnedDirectory = path.join(directory, 'displaced-owned.lock');
    let firstSwap = false;
    let restoreSwap = false;
    const fileSystem = fileSystemWith({
      async rename(source, destination) {
        if (source === hostLockDirectory
            && destination.startsWith(`${hostLockDirectory}.completing-`)
            && !firstSwap) {
          firstSwap = true;
          await fs.rename(hostLockDirectory, displacedOwnedDirectory);
          await fs.mkdir(hostLockDirectory, { mode: 0o700 });
          await fs.writeFile(path.join(hostLockDirectory, 'first-foreign'), 'first\n', {
            mode: 0o600,
          });
        } else if (source.startsWith(`${hostLockDirectory}.completing-`)
            && destination === hostLockDirectory
            && !restoreSwap) {
          restoreSwap = true;
          await fs.mkdir(hostLockDirectory, { mode: 0o700 });
          await fs.writeFile(path.join(hostLockDirectory, 'second-foreign'), 'second\n', {
            mode: 0o600,
          });
        }
        return fs.rename(source, destination);
      },
    });
    try {
      const release = await acquireHostOperationLock({
        fileSystem,
        lockDirectory: hostLockDirectory,
        operation: 'database-import',
      });
      await assert.rejects(releaseHostOperationLock(release, 1_000));
      assert.equal(firstSwap, true);
      assert.equal(restoreSwap, true);
      assert.equal(await fs.readFile(path.join(hostLockDirectory, 'second-foreign'), 'utf8'),
        'second\n');
      const sidecar = (await fs.readdir(directory)).find(
        (entry) => entry.startsWith('host.lock.completing-'),
      );
      assert.ok(sidecar);
      assert.equal(await fs.readFile(path.join(directory, sidecar, 'first-foreign'), 'utf8'),
        'first\n');
      assert.match(await fs.readFile(path.join(displacedOwnedDirectory, 'owner'), 'utf8'),
        /operation=database-import/u);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

test('host tombstone cleanup removes only exact bounded completion and abandonment records',
  async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-host-tombstones-'));
    const hostLockDirectory = path.join(directory, 'host.lock');
    try {
      const first = await acquireHostOperationLock({
        lockDirectory: hostLockDirectory,
        operation: 'database-import',
      });
      await releaseHostOperationLock(first, 1_000);
      assert.equal((await fs.readdir(directory)).filter(
        (entry) => entry.startsWith('host.lock.completing-'),
      ).length, 1);

      let ownerWriteFailed = false;
      const ownerFile = path.join(hostLockDirectory, 'owner');
      const failingFileSystem = fileSystemWith({
        async open(target, ...arguments_) {
          if (target === ownerFile && !ownerWriteFailed) {
            ownerWriteFailed = true;
            const error = new Error('injected owner failure for abandonment tombstone');
            error.code = 'ENOSPC';
            throw error;
          }
          return fs.open(target, ...arguments_);
        },
      });
      await assert.rejects(acquireHostOperationLock({
        fileSystem: failingFileSystem,
        lockDirectory: hostLockDirectory,
        operation: 'database-restore',
      }), /injected owner failure/u);
      assert.equal(ownerWriteFailed, true);

      const next = await acquireHostOperationLock({
        lockDirectory: hostLockDirectory,
        operation: 'staging-release',
      });
      const entriesWhileHeld = await fs.readdir(directory);
      assert.equal(entriesWhileHeld.some((entry) => (
        entry.startsWith('host.lock.completing-')
        || entry.startsWith('host.lock.abandoned-')
      )), false);
      await releaseHostOperationLock(next, 1_000);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

test('host tombstone scan is bounded and preserves every unproven prefixed directory',
  async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-host-tombstone-bound-'));
    const hostLockDirectory = path.join(directory, 'host.lock');
    try {
      for (let index = 0; index < 33; index += 1) {
        const tombstone = `${hostLockDirectory}.completing-foreign-${index}`;
        await fs.mkdir(tombstone, { mode: 0o700 });
        await fs.writeFile(path.join(tombstone, 'foreign'), `foreign-${index}\n`, {
          mode: 0o600,
        });
      }
      await assert.rejects(acquireHostOperationLock({
        lockDirectory: hostLockDirectory,
        operation: 'production-app-lifecycle',
      }), /HOST_OPERATION_LOCK_PROTOCOL_LIMIT/u);
      assert.equal((await fs.readdir(directory)).length, 33);
      assert.equal(await fs.readFile(
        path.join(`${hostLockDirectory}.completing-foreign-0`, 'foreign'), 'utf8',
      ), 'foreign-0\n');
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

test('host tombstone cleanup restores a foreign directory swapped at the cleanup claim',
  async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-tombstone-swap-'));
    const hostLockDirectory = path.join(directory, 'host.lock');
    const displacedTombstone = path.join(directory, 'displaced-completion.lock');
    let swapped = false;
    try {
      const release = await acquireHostOperationLock({
        lockDirectory: hostLockDirectory,
        operation: 'database-import',
      });
      await releaseHostOperationLock(release, 1_000);
      const sidecarName = (await fs.readdir(directory)).find(
        (entry) => entry.startsWith('host.lock.completing-'),
      );
      assert.ok(sidecarName);
      const sidecar = path.join(directory, sidecarName);
      const fileSystem = fileSystemWith({
        async rename(source, destination) {
          if (source === sidecar && destination.startsWith(`${sidecar}.delete-`) && !swapped) {
            swapped = true;
            await fs.rename(sidecar, displacedTombstone);
            await fs.mkdir(sidecar, { mode: 0o700 });
            await fs.writeFile(path.join(sidecar, 'foreign'), 'foreign-tombstone\n', {
              mode: 0o600,
            });
          }
          return fs.rename(source, destination);
        },
      });
      await assert.rejects(acquireHostOperationLock({
        fileSystem,
        lockDirectory: hostLockDirectory,
        operation: 'staging-release',
      }));
      assert.equal(swapped, true);
      assert.equal(await fs.readFile(path.join(sidecar, 'foreign'), 'utf8'),
        'foreign-tombstone\n');
      assert.match(await fs.readFile(path.join(displacedTombstone, 'completed'), 'utf8'),
        /^COMPLETED$/mu);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

test('maintenance stop proves only the canonical Compose app and does not require PostgreSQL',
  async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-stop-without-pg-'));
    const hostLockDirectory = path.join(directory, 'host.lock');
    let allocation = appContainerId;
    const calls = [];
    try {
      const result = await runProductionAppLifecycle({
        action: 'stop',
        environment: {
          ...process.env,
          EASYBOOST_APP_READINESS_URL: 'https://operator:secret@app.example/ready',
        },
        hostLockDirectory,
        postgresExpectedImageId: 'postgres:latest',
        productionAppImageId: applicationImageId,
        runDocker: async (arguments_) => {
          calls.push(arguments_);
          if (arguments_[0] === 'image') return applicationImageId;
          if (arguments_[0] === 'compose') {
            assert.deepEqual(arguments_.slice(0, 4), [
              'compose', '--project-name', 'easyboost-production', '-f',
            ]);
          }
          if (arguments_[0] === 'compose' && arguments_.includes('ps')
              && arguments_.at(-1) === 'app') return allocation;
          if (arguments_[0] === 'inspect') {
            return productionComposeAllocation({
              containerId: appContainerId,
              imageId: applicationImageId,
              running: false,
            });
          }
          if (arguments_[0] === 'rm') { allocation = ''; return appContainerId; }
          throw new Error(`unexpected Docker command: ${arguments_.join(' ')}`);
        },
      });
      assert.deepEqual(result, { action: 'stop', appContainerId });
      assert.equal(allocation, '');
      assert.equal(calls.some((arguments_) => arguments_.includes('postgres')), false);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

test('application lifecycle leaves the host guard untouched for nested child settlement recovery',
  async () => {
    const controlDirectory = path.join(os.tmpdir(), 'easyboost-lifecycle-child-control');
    const childFailure = Object.assign(new Error('owned Docker child is unsettled'), {
      childSettlementUnproven: true,
      recoveryAuthority: { controlDirectory, authorityToken: 'must-not-escape' },
    });
    const nestedFailure = new AggregateError([childFailure], 'nested Docker failure');
    let releases = 0;
    let retentions = 0;
    await assert.rejects(runProductionAppLifecycle({
      action: 'stop',
      acquireHostLock: async () => async () => {},
      productionAppImageId: applicationImageId,
      releaseHostLock: async () => { releases += 1; },
      retainHostLock: async () => { retentions += 1; },
      runDocker: async () => { throw nestedFailure; },
    }), (error) => {
      assert.equal(error.childSettlementUnproven, true);
      assert.deepEqual(error.recoveryAuthority, { controlDirectory });
      assert.equal(Object.hasOwn(error, 'recoveryAuthorities'), false);
      assert.doesNotMatch(JSON.stringify(error.recoveryAuthority), /authorityToken/u);
      return true;
    });
    assert.equal(releases, 0,
      'unsettled child recovery must block host-lock release');
    assert.equal(retentions, 0,
      'unsettled child recovery must block host-lock retention transitions');
  });

test('application lifecycle skips app-start recovery after nested child settlement failure',
  async () => {
    const controlDirectory = path.join(os.tmpdir(), 'easyboost-lifecycle-child-control-start');
    const childFailure = Object.assign(new Error('started application child is unsettled'), {
      childSettlementUnproven: true,
      recoveryAuthority: { controlDirectory, token: 'must-not-escape' },
    });
    const nestedFailure = new AggregateError([childFailure], 'nested application start failure');
    const postFailureCalls = [];
    let childFailureThrown = false;
    let releases = 0;
    let retentions = 0;
    await assert.rejects(runProductionAppLifecycle({
      action: 'start',
      acquireHostLock: async () => async () => {},
      postgresExpectedImageId: postgresImageId,
      productionAppImageId: applicationImageId,
      releaseHostLock: async () => { releases += 1; },
      retainHostLock: async () => { retentions += 1; },
      runDocker: async (arguments_) => {
        if (childFailureThrown) postFailureCalls.push(arguments_);
        if (arguments_[0] === 'image') {
          return arguments_.at(-1) === postgresImageId ? postgresImageId : applicationImageId;
        }
        if (arguments_[0] === 'compose' && arguments_.includes('postgres')) {
          return postgresContainerId;
        }
        if (arguments_[0] === 'compose' && arguments_.includes('app')) return appContainerId;
        if (arguments_[0] === 'inspect' && arguments_.at(-1) === postgresContainerId) {
          return productionComposeAllocation({
            containerId: postgresContainerId,
            imageId: postgresImageId,
            running: true,
            service: 'postgres',
          });
        }
        if (arguments_[0] === 'inspect' && arguments_.at(-1) === appContainerId) {
          return productionComposeAllocation({
            containerId: appContainerId,
            imageId: applicationImageId,
            running: false,
          });
        }
        if (arguments_[0] === 'start' && arguments_.includes(appContainerId)) {
          childFailureThrown = true;
          throw nestedFailure;
        }
        throw new Error(`unexpected Docker command: ${arguments_.join(' ')}`);
      },
    }), (error) => {
      assert.equal(error.childSettlementUnproven, true);
      assert.deepEqual(error.recoveryAuthority, { controlDirectory });
      return true;
    });
    assert.deepEqual(postFailureCalls, [],
      'child settlement must short-circuit before app stop, Compose ps, or inspect recovery');
    assert.equal(releases, 0);
    assert.equal(retentions, 0);
  });

test('successful lifecycle release failure becomes typed retained recovery authority', async () => {
  for (const message of ['release failed', 'Host operation lock release timed out after 5ms']) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-release-retain-'));
    const hostLockDirectory = path.join(directory, 'host.lock');
    const releaseError = new Error(message);
    try {
      await assert.rejects(runProductionAppLifecycle({
        action: 'stop',
        hostLockDirectory,
        productionAppImageId: applicationImageId,
        releaseHostLock: async () => { throw releaseError; },
        runDocker: async (arguments_) => {
          if (arguments_[0] === 'image') return applicationImageId;
          if (arguments_[0] === 'compose' && arguments_.includes('ps')) return '';
          throw new Error(`unexpected Docker command: ${arguments_.join(' ')}`);
        },
      }), (error) => error === releaseError);

      const retained = await openRetainedHostOperationLock({
        expectedOperation: 'production-app-lifecycle',
        lockDirectory: hostLockDirectory,
      });
      assert.equal(retained.reason, 'HOST_GUARD_FINALIZATION_UNPROVEN');
      assert.deepEqual(retained.evidence, {
        currentContainerId: null,
        lastProof: 'compose-app-inventory-proved',
        lastState: 'app-absent',
        lifecycleAction: 'stop',
        newImageId: applicationImageId,
        previousContainerId: null,
        previousImageId: applicationImageId,
        reason: 'HOST_GUARD_FINALIZATION_UNPROVEN',
      });

      const recovered = await recoverRetainedProductionAppLifecycle({
        hostLockDirectory,
        runDocker: async (arguments_) => {
          if (arguments_[0] === 'compose' && arguments_.includes('ps')) return '';
          throw new Error(`unexpected Docker command: ${arguments_.join(' ')}`);
        },
      });
      assert.deepEqual(recovered, {
        action: 'recover',
        recoveredLifecycleAction: 'stop',
        state: 'app-absent',
      });
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  }
});

test('retained lifecycle recovery settles one exact approved allocation to app-absent', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-lifecycle-recover-'));
  const hostLockDirectory = path.join(directory, 'host.lock');
  let allocation = replacementAppContainerId;
  let running = true;
  const calls = [];
  try {
    const release = await acquireHostOperationLock({
      lockDirectory: hostLockDirectory,
      operation: 'production-app-lifecycle',
    });
    await retainHostOperationLock(release, 100, {
      currentContainerId: replacementAppContainerId,
      lastProof: 'exact-stop-proof-rejected',
      lastState: 'mutation-settlement-unproven',
      lifecycleAction: 'replace',
      newImageId: applicationImageId,
      previousContainerId: appContainerId,
      previousImageId: previousApplicationImageId,
      reason: 'APP_MUTATION_SETTLEMENT_UNPROVEN',
    });

    const result = await recoverRetainedProductionAppLifecycle({
      hostLockDirectory,
      runDocker: async (arguments_) => {
        calls.push(arguments_);
        if (arguments_[0] === 'image') return arguments_.at(-1);
        if (arguments_[0] === 'compose') {
          assert.deepEqual(arguments_.slice(0, 4), [
            'compose', '--project-name', 'easyboost-production', '-f',
          ]);
        }
        if (arguments_[0] === 'compose' && arguments_.includes('ps')) return allocation;
        if (arguments_[0] === 'inspect') {
          return productionComposeAllocation({
            containerId: allocation,
            imageId: applicationImageId,
            running,
          });
        }
        if (arguments_[0] === 'stop') { running = false; return allocation; }
        if (arguments_[0] === 'rm') { allocation = ''; return replacementAppContainerId; }
        throw new Error(`unexpected Docker command: ${arguments_.join(' ')}`);
      },
    });
    assert.deepEqual(result, {
      action: 'recover',
      appContainerId: replacementAppContainerId,
      recoveredLifecycleAction: 'replace',
      state: 'app-absent',
    });
    assert.equal(allocation, '');
    assert.equal(calls.some((arguments_) => arguments_.includes('postgres')), false);
    await assert.rejects(fs.access(hostLockDirectory), { code: 'ENOENT' });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('retained lifecycle recovery rejects ambiguous or foreign app state without mutation',
  async () => {
    const unauthorizedImageId = `sha256:${'d'.repeat(64)}`;
    const scenarios = [
      {
        allocation: `${appContainerId}\n${replacementAppContainerId}`,
        label: 'ambiguous allocation',
        proof: null,
      },
      {
        allocation: appContainerId,
        label: 'foreign project',
        proof: [appContainerId, 'foreign-project', 'app', 'False', applicationImageId, 'true']
          .join('|'),
      },
      {
        allocation: appContainerId,
        label: 'foreign service',
        proof: [appContainerId, 'easyboost-production', 'worker', 'False', applicationImageId,
          'true'].join('|'),
      },
      {
        allocation: appContainerId,
        label: 'one-off allocation',
        proof: [appContainerId, 'easyboost-production', 'app', 'True', applicationImageId, 'true']
          .join('|'),
      },
      {
        allocation: appContainerId,
        label: 'foreign image',
        proof: productionComposeAllocation({
          containerId: appContainerId,
          imageId: unauthorizedImageId,
          running: true,
        }),
      },
    ];
    for (const scenario of scenarios) {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-recover-foreign-'));
      const hostLockDirectory = path.join(directory, 'host.lock');
      const mutations = [];
      try {
        const release = await acquireHostOperationLock({
          lockDirectory: hostLockDirectory,
          operation: 'production-app-lifecycle',
        });
        await retainHostOperationLock(release, 100, {
          currentContainerId: appContainerId,
          lastProof: 'app-isolation-proof-rejected',
          lastState: 'mutation-settlement-unproven',
          lifecycleAction: 'restart',
          newImageId: applicationImageId,
          previousContainerId: appContainerId,
          previousImageId: applicationImageId,
          reason: 'APP_MUTATION_SETTLEMENT_UNPROVEN',
        });
        await assert.rejects(recoverRetainedProductionAppLifecycle({
          hostLockDirectory,
          runDocker: async (arguments_) => {
            if (arguments_[0] === 'compose' && arguments_.includes('ps')) {
              return scenario.allocation;
            }
            if (arguments_[0] === 'inspect') return scenario.proof;
            if (['rm', 'stop'].includes(arguments_[0])) mutations.push(arguments_);
            throw new Error(`unexpected Docker command: ${arguments_.join(' ')}`);
          },
        }), undefined, scenario.label);
        assert.deepEqual(mutations, [], `${scenario.label} must fail before mutation`);
        assert.match(await fs.readFile(path.join(hostLockDirectory, 'retained'), 'utf8'),
          /^RETAINED$/mu);
      } finally {
        await fs.rm(directory, { recursive: true, force: true });
      }
    }
  });

test('retained lifecycle recovery rejects a different same-image allocation ID', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-recover-id-swap-'));
  const hostLockDirectory = path.join(directory, 'host.lock');
  const mutations = [];
  try {
    const release = await acquireHostOperationLock({
      lockDirectory: hostLockDirectory,
      operation: 'production-app-lifecycle',
    });
    await retainHostOperationLock(release, 100, {
      currentContainerId: appContainerId,
      lastProof: 'app-isolation-proof-rejected',
      lastState: 'mutation-settlement-unproven',
      lifecycleAction: 'restart',
      newImageId: applicationImageId,
      previousContainerId: appContainerId,
      previousImageId: applicationImageId,
      reason: 'APP_MUTATION_SETTLEMENT_UNPROVEN',
    });
    await assert.rejects(recoverRetainedProductionAppLifecycle({
      hostLockDirectory,
      runDocker: async (arguments_) => {
        if (arguments_[0] === 'compose' && arguments_.includes('ps')) {
          return replacementAppContainerId;
        }
        if (arguments_[0] === 'inspect') {
          return productionComposeAllocation({
            containerId: replacementAppContainerId,
            imageId: applicationImageId,
            running: true,
          });
        }
        if (['rm', 'stop'].includes(arguments_[0])) mutations.push(arguments_);
        if (arguments_[0] === 'image') return applicationImageId;
        throw new Error(`unexpected Docker command: ${arguments_.join(' ')}`);
      },
    }), /outside recorded container authority/u);
    assert.deepEqual(mutations, []);
    assert.match(await fs.readFile(path.join(hostLockDirectory, 'retained'), 'utf8'),
      /^RETAINED$/mu);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('retained lifecycle unknown-ID discovery requires an explicit recovery option', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-recover-unknown-id-'));
  const hostLockDirectory = path.join(directory, 'host.lock');
  let allocation = replacementAppContainerId;
  let running = true;
  const runDocker = async (arguments_) => {
    if (arguments_[0] === 'compose' && arguments_.includes('ps')) return allocation;
    if (arguments_[0] === 'inspect') {
      return productionComposeAllocation({
        containerId: replacementAppContainerId,
        imageId: applicationImageId,
        running,
      });
    }
    if (arguments_[0] === 'image') return applicationImageId;
    if (arguments_[0] === 'stop') { running = false; return replacementAppContainerId; }
    if (arguments_[0] === 'rm') { allocation = ''; return replacementAppContainerId; }
    throw new Error(`unexpected Docker command: ${arguments_.join(' ')}`);
  };
  try {
    const release = await acquireHostOperationLock({
      lockDirectory: hostLockDirectory,
      operation: 'production-app-lifecycle',
    });
    await retainHostOperationLock(release, 100, {
      currentContainerId: null,
      lastProof: 'compose-up-dispatched',
      lastState: 'mutation-settlement-unproven',
      lifecycleAction: 'start',
      newImageId: applicationImageId,
      previousContainerId: null,
      previousImageId: applicationImageId,
      reason: 'APP_MUTATION_SETTLEMENT_UNPROVEN',
    });
    await assert.rejects(recoverRetainedProductionAppLifecycle({
      hostLockDirectory,
      runDocker,
    }), /outside recorded container authority/u);
    assert.equal(running, true);

    const recovered = await recoverRetainedProductionAppLifecycle({
      allowUnknownContainerDiscovery: true,
      hostLockDirectory,
      runDocker,
    });
    assert.equal(recovered.appContainerId, replacementAppContainerId);
    assert.equal(recovered.state, 'app-absent');
    assert.equal(allocation, '');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('unproven lifecycle settlement persists exact typed recovery evidence', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-lifecycle-retain-'));
  const hostLockDirectory = path.join(directory, 'host.lock');
  const startError = new Error('start response was lost');
  const stopError = new Error('recovery stop response was lost');
  let running = true;
  let stopCalls = 0;
  try {
    await assert.rejects(runProductionAppLifecycle({
      action: 'restart',
      hostLockDirectory,
      postgresExpectedImageId: postgresImageId,
      productionAppImageId: applicationImageId,
      runDocker: async (arguments_) => {
        if (arguments_[0] === 'image') return arguments_.at(-1);
        if (arguments_[0] === 'compose' && arguments_.includes('ps')
            && arguments_.at(-1) === 'postgres') return postgresContainerId;
        if (arguments_[0] === 'compose' && arguments_.includes('ps')
            && arguments_.at(-1) === 'app') return appContainerId;
        if (arguments_[0] === 'inspect' && arguments_.at(-1) === postgresContainerId) {
          return productionComposeAllocation({
            containerId: postgresContainerId,
            imageId: postgresImageId,
            running: true,
            service: 'postgres',
          });
        }
        if (arguments_[0] === 'inspect') {
          return productionComposeAllocation({
            containerId: appContainerId,
            imageId: applicationImageId,
            running,
          });
        }
        if (arguments_[0] === 'stop') {
          stopCalls += 1;
          if (stopCalls > 1) throw stopError;
          running = false;
          return appContainerId;
        }
        if (arguments_[0] === 'start') throw startError;
        throw new Error(`unexpected Docker command: ${arguments_.join(' ')}`);
      },
    }));
    const marker = await fs.readFile(path.join(hostLockDirectory, 'retained'), 'utf8');
    assert.match(marker, /^RETAINED$/mu);
    assert.match(marker, /operation=production-app-lifecycle/u);
    assert.match(marker, /lifecycleAction=restart/u);
    assert.match(marker, /reason=APP_MUTATION_SETTLEMENT_UNPROVEN/u);
    assert.match(marker, new RegExp(`previousImageId=${applicationImageId}`, 'u'));
    assert.match(marker, new RegExp(`newImageId=${applicationImageId}`, 'u'));
    assert.match(marker, new RegExp(`currentContainerId=${appContainerId}`, 'u'));
    assert.match(marker, new RegExp(`previousContainerId=${appContainerId}`, 'u'));
    assert.match(marker, /lastProof=app-isolation-proof-rejected/u);
    assert.match(marker, /lastState=mutation-settlement-unproven/u);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('lifecycle readiness URL environment is strict and reaches the guarded readiness probe',
  async () => {
    const invalid = spawnSync(
      process.execPath,
      ['scripts/production-app-lifecycle.js', 'start'],
      {
        cwd: path.resolve(),
        encoding: 'utf8',
        env: {
          ...process.env,
          EASYBOOST_APP_READINESS_URL: 'https://operator:secret@app.example/ready',
          EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID: postgresImageId,
          EASYBOOST_PRODUCTION_APP_IMAGE_ID: applicationImageId,
        },
      },
    );
    assert.equal(invalid.status, 2);
    assert.match(invalid.stderr, /EASYBOOST_APP_READINESS_URL.*credentials/u);

    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-readiness-url-'));
    const hostLockDirectory = path.join(directory, 'host.lock');
    let observedUrl;
    let running = false;
    try {
      await runProductionAppLifecycle({
        action: 'start',
        checkReadiness: async ({ url }) => { observedUrl = url; },
        environment: {
          ...process.env,
          EASYBOOST_APP_READINESS_URL: 'https://app.example/health/ready',
        },
        hostLockDirectory,
        postgresExpectedImageId: postgresImageId,
        productionAppImageId: applicationImageId,
        runDocker: async (arguments_) => {
          if (arguments_[0] === 'image') return arguments_.at(-1);
          if (arguments_[0] === 'compose' && arguments_.includes('ps')
              && arguments_.at(-1) === 'postgres') return postgresContainerId;
          if (arguments_[0] === 'compose' && arguments_.includes('ps')
              && arguments_.at(-1) === 'app') return appContainerId;
          if (arguments_[0] === 'inspect' && arguments_.at(-1) === postgresContainerId) {
            return productionComposeAllocation({
              containerId: postgresContainerId,
              imageId: postgresImageId,
              running: true,
              service: 'postgres',
            });
          }
          if (arguments_[0] === 'inspect') {
            return productionComposeAllocation({
              containerId: appContainerId,
              imageId: applicationImageId,
              running,
            });
          }
          if (arguments_[0] === 'start') { running = true; return appContainerId; }
          throw new Error(`unexpected Docker command: ${arguments_.join(' ')}`);
        },
      });
      assert.equal(observedUrl, 'https://app.example/health/ready');
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

test('start and restart keep mutation pending through readiness failure and re-isolate under guard',
  async () => {
    for (const action of ['start', 'restart']) {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), `easyboost-${action}-ready-`));
      const hostLockDirectory = path.join(directory, 'host.lock');
      const readinessError = new Error(`${action} readiness failed`);
      let running = action === 'restart';
      let stopCalls = 0;
      try {
        await assert.rejects(runProductionAppLifecycle({
          action,
          checkReadiness: async () => {
            await assert.rejects(acquireHostOperationLock({
              lockDirectory: hostLockDirectory,
              operation: 'database-import',
            }), /HOST_OPERATION_LOCKED/u);
            throw readinessError;
          },
          hostLockDirectory,
          postgresExpectedImageId: postgresImageId,
          productionAppImageId: applicationImageId,
          runDocker: async (arguments_) => {
            if (arguments_[0] === 'image') return arguments_.at(-1);
            if (arguments_[0] === 'compose' && arguments_.includes('ps')
                && arguments_.at(-1) === 'postgres') return postgresContainerId;
            if (arguments_[0] === 'compose' && arguments_.includes('ps')
                && arguments_.at(-1) === 'app') return appContainerId;
            if (arguments_[0] === 'inspect' && arguments_.at(-1) === postgresContainerId) {
              return productionComposeAllocation({
                containerId: postgresContainerId,
                imageId: postgresImageId,
                running: true,
                service: 'postgres',
              });
            }
            if (arguments_[0] === 'inspect') {
              return productionComposeAllocation({
                containerId: appContainerId,
                imageId: applicationImageId,
                running,
              });
            }
            if (arguments_[0] === 'start') { running = true; return appContainerId; }
            if (arguments_[0] === 'stop') {
              await assert.rejects(acquireHostOperationLock({
                lockDirectory: hostLockDirectory,
                operation: 'database-restore',
              }), /HOST_OPERATION_LOCKED/u);
              stopCalls += 1;
              running = false;
              return appContainerId;
            }
            throw new Error(`unexpected Docker command: ${arguments_.join(' ')}`);
          },
        }), (error) => error === readinessError);
        assert.equal(running, false);
        assert.equal(stopCalls, action === 'restart' ? 2 : 1);
        const release = await acquireHostOperationLock({
          lockDirectory: hostLockDirectory,
          operation: 'database-restore',
        });
        await release();
      } finally {
        await fs.rm(directory, { recursive: true, force: true });
      }
    }
  });

test('lifecycle CLI exposes retained recovery as a root-safe action', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-recover-cli-'));
  const missingLockDirectory = path.join(directory, 'missing-host.lock');
  try {
    const result = spawnSync(
      process.execPath,
      ['scripts/production-app-lifecycle.js', 'recover'],
      {
        cwd: path.resolve(),
        encoding: 'utf8',
        env: {
          ...process.env,
          EASYBOOST_HOST_OPERATION_LOCK_DIR: missingLockDirectory,
        },
      },
    );
    assert.equal(result.status, 1,
      'recover must enter retained-marker inspection rather than fail usage validation');
    assert.doesNotMatch(result.stderr, /Usage:/u);
    assert.match(result.stderr, /ENOENT/u);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

function createRestoreDocker(events, state) {
  return async (arguments_) => {
    events.push(arguments_);
    if (arguments_[0] === 'image') return applicationImageId;
    if (arguments_[0] === 'compose' && arguments_.includes('ps')
        && arguments_.at(-1) === 'postgres') return postgresContainerId;
    if (arguments_[0] === 'compose' && arguments_.includes('ps')
        && arguments_.at(-1) === 'app') return appContainerId;
    if (arguments_[0] === 'inspect' && arguments_.at(-1) === postgresContainerId) {
      return productionComposeAllocation({
        containerId: postgresContainerId,
        imageId: postgresImageId,
        running: true,
        service: 'postgres',
      });
    }
    if (arguments_[0] === 'inspect' && arguments_.at(-1) === appContainerId) {
      return productionComposeAllocation({
        containerId: appContainerId,
        imageId: applicationImageId,
        running: state.appRunning,
      });
    }
    if (arguments_[0] === 'stop') { state.appRunning = false; return ''; }
    if (arguments_[0] === 'start') { state.appRunning = true; return ''; }
    if (arguments_.includes('pg_restore') && arguments_.includes('--list')) return '';
    throw new Error(`unexpected Docker command: ${arguments_.join(' ')}`);
  };
}

test('host snapshot ENOSPC fails before Docker mutation and releases both guards', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-restore-capacity-'));
  const backup = path.join(directory, 'backup.dump');
  const lockFile = path.join(directory, 'database.lock');
  const hostLockDirectory = path.join(directory, 'host.lock');
  await fs.writeFile(backup, 'bounded fixture archive', { mode: 0o600 });
  const capacityError = Object.assign(new Error('HOST_SNAPSHOT_CAPACITY_UNAVAILABLE'), {
    code: 'ENOSPC',
  });
  let dockerCalls = 0;
  try {
    await assert.rejects(restorePostgresBackup({
      backup,
      hostLockDirectory,
      lockFile,
      postgresExpectedImageId: postgresImageId,
      productionAppImageId: applicationImageId,
      reserveCapacity: async () => { throw capacityError; },
      runDocker: async () => { dockerCalls += 1; },
      log() {},
    }), (error) => error === capacityError);
    assert.equal(dockerCalls, 0, 'capacity admission must precede Docker and app lifecycle work');
    await assert.rejects(fs.access(lockFile), { code: 'ENOENT' });
    await assert.rejects(fs.access(hostLockDirectory), { code: 'ENOENT' });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('managed restore continuously rejects an app start race and settles with app stopped', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-restore-app-race-'));
  const backup = path.join(directory, 'backup.dump');
  const lockFile = path.join(directory, 'database.lock');
  const hostLockDirectory = path.join(directory, 'host.lock');
  await fs.writeFile(backup, 'bounded fixture archive', { mode: 0o600 });
  const state = { appRunning: true };
  const events = [];
  try {
    await assert.rejects(restorePostgresBackup({
      backup,
      checkReadiness: async () => ({ ok: true }),
      hostLockDirectory,
      lockFile,
      postgresExpectedImageId: postgresImageId,
      productionAppImageId: applicationImageId,
      runDocker: createRestoreDocker(events, state),
      runSupervisedRestore: async ({ assertMutationIsolation }) => {
        await assertMutationIsolation({ phase: 'before-launch' });
        state.appRunning = true;
        await assertMutationIsolation({ phase: 'after-launch' });
      },
      log() {},
    }), /Application container identity, ownership, image or running state changed/u);
    assert.equal(state.appRunning, false,
      'the exact immutable app must be stopped again after the race is detected');
    assert.ok(events.filter((arguments_) => arguments_[0] === 'stop').length >= 2,
      'the recovery path must stop once before restore and again after the raced start');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('managed restore holds the shared host guard through restore and app readiness', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-restore-host-guard-'));
  const backup = path.join(directory, 'backup.dump');
  const lockFile = path.join(directory, 'database.lock');
  const hostLockDirectory = path.join(directory, 'host.lock');
  await fs.writeFile(backup, 'bounded fixture archive', { mode: 0o600 });
  const state = { appRunning: true };
  const events = [];
  let releaseBlockedDuringReadiness = false;
  try {
    const result = await restorePostgresBackup({
      backup,
      checkReadiness: async () => {
        await assert.rejects(acquireHostOperationLock({
          lockDirectory: hostLockDirectory,
          operation: 'staging-release',
        }), /HOST_OPERATION_LOCKED/u);
        releaseBlockedDuringReadiness = true;
        return { ok: true };
      },
      hostLockDirectory,
      lockFile,
      postgresExpectedImageId: postgresImageId,
      productionAppImageId: applicationImageId,
      runDocker: createRestoreDocker(events, state),
      runSupervisedRestore: async ({ assertMutationIsolation }) => {
        await assertMutationIsolation({ phase: 'before-launch' });
        return {
          applicationName: 'easyboost_restore_12345678-1234-4abc-8def-1234567890ab',
          kind: 'restore',
          lastProbe: { activityCount: 0, process: 'NONE', settled: true, status: 'EXIT:0' },
          operationToken: '12345678-1234-4abc-8def-1234567890ab',
          postgresContainerId,
          settlement: 'remote-proof',
        };
      },
      log() {},
    });
    assert.equal(result.appContainerId, appContainerId);
    assert.equal(releaseBlockedDuringReadiness, true);
    const releaseAfterwards = await acquireHostOperationLock({
      lockDirectory: hostLockDirectory,
      operation: 'staging-release',
    });
    await releaseAfterwards();
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('scheduled verification restores only inside a disposable exact-image runtime', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-verify-isolated-'));
  const backup = path.join(directory, 'backup.dump');
  const migrationsDirectory = path.join(directory, 'migrations');
  await fs.writeFile(backup, 'bounded fixture archive', { mode: 0o600 });
  await fs.mkdir(migrationsDirectory);
  await fs.writeFile(path.join(migrationsDirectory, '001_fixture.sql'), '-- fixture\n');
  const calls = [];
  let cleanupCalls = 0;
  try {
    const status = await verifyPostgresBackup({
      backup,
      backupDirectory: directory,
      createVerificationRuntime: async ({ postgresExpectedImageId }) => {
        assert.equal(postgresExpectedImageId, postgresImageId);
        return {
          cleanup: async () => { cleanupCalls += 1; },
          containerId: postgresContainerId,
          isolation: 'disposable-exact-image-container',
          volumeName: 'easyboost-verify-volume-fixture',
        };
      },
      lockFile: path.join(directory, 'verify.lock'),
      migrationsDirectory,
      postgresExpectedImageId: postgresImageId,
      productionAppImageId: applicationImageId,
      runDocker: async (arguments_, options = {}) => {
        calls.push({ arguments_, options });
        if (arguments_[0] === 'image') return postgresImageId;
        if (arguments_.includes('pg_restore') && arguments_.includes('--list')) return '';
        if (arguments_.includes('psql')) {
          const query = arguments_.at(-1);
          if (query.includes('information_schema.tables')) {
            return ['module_attempts', 'schema_migrations', 'user_progress', 'users', 'word_progress'].join('\n');
          }
          if (query.includes('SELECT version')) return '001_fixture.sql';
          return '3:5:7:11:1';
        }
        throw new Error(`unexpected Docker command: ${arguments_.join(' ')}`);
      },
      runSupervisedRestore: async ({ postgresContainerId: target }) => {
        assert.equal(target, postgresContainerId);
        return {
          applicationName: 'easyboost_restore_12345678-1234-4abc-8def-1234567890ab',
          kind: 'restore',
          lastProbe: { activityCount: 0, process: 'NONE', settled: true, status: 'EXIT:0' },
          operationToken: '12345678-1234-4abc-8def-1234567890ab',
          postgresContainerId,
          settlement: 'remote-proof',
        };
      },
      statusFile: path.join(directory, 'status.json'),
    });
    assert.equal(status.verificationIsolation, 'disposable-exact-image-container');
    assert.equal(status.postgresImageId, postgresImageId);
    assert.equal(cleanupCalls, 1);
    assert.equal(calls.some(({ arguments_ }) => arguments_[0] === 'compose'), false,
      'scheduled verification must never resolve or mutate the live Compose postgres service');
    assert.equal(calls.some(({ arguments_ }) => (
      arguments_.includes('createdb') || arguments_.includes('dropdb')
    )), false, 'disposable verification must not create a database in production PostgreSQL');
    for (const { arguments_ } of calls.filter(({ arguments_ }) => (
      arguments_.includes('pg_restore') || arguments_.includes('psql')
    ))) {
      assert.equal(arguments_.includes(postgresContainerId), true);
    }
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('verification retains structured recovery authority when remote settlement is unproven',
  async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-verify-retained-'));
    const backup = path.join(directory, 'backup.dump');
    const lockFile = path.join(directory, 'verify.lock');
    await fs.writeFile(backup, 'bounded fixture archive', { mode: 0o600 });
    const recoveryEvidence = {
      applicationName: 'easyboost_restore_12345678-1234-4abc-8def-1234567890ab',
      kind: 'restore',
      lastProbe: { activityCount: 1, process: 'ACTIVE', settled: false, status: 'RUNNING' },
      operationToken: '12345678-1234-4abc-8def-1234567890ab',
      postgresContainerId,
    };
    const settlementError = Object.assign(new Error('remote verification settlement unproven'), {
      recoveryEvidence,
      retainOperationLock: true,
      settlementProven: false,
    });
    let cleanupCalls = 0;
    try {
      await assert.rejects(verifyPostgresBackup({
        backup,
        backupDirectory: directory,
        createVerificationRuntime: async () => ({
          cleanup: async () => { cleanupCalls += 1; },
          containerId: postgresContainerId,
          isolation: 'disposable-exact-image-container',
          volumeName: 'easyboost-verify-volume-fixture',
        }),
        lockFile,
        postgresExpectedImageId: postgresImageId,
        productionAppImageId: applicationImageId,
        publishStatus: async () => {},
        runDocker: async (arguments_) => {
          if (arguments_[0] === 'image') return postgresImageId;
          if (arguments_.includes('pg_restore') && arguments_.includes('--list')) return '';
          throw new Error(`unexpected Docker command: ${arguments_.join(' ')}`);
        },
        runSupervisedRestore: async () => { throw settlementError; },
      }), (error) => error === settlementError);
      assert.equal(cleanupCalls, 0,
        'an unproven remote mutation must retain its isolated runtime for operator settlement');
      const marker = await fs.readFile(lockFile, 'utf8');
      assert.match(marker, /protocol=easyboost-database-operation-lock-v3/u);
      assert.match(marker, /operationToken=12345678-1234-4abc-8def-1234567890ab/u);
      assert.match(marker, new RegExp(`postgresContainerId=${postgresContainerId}`, 'u'));
      assert.match(marker, /lastProbeStatus=RUNNING\nlastProbeProcess=ACTIVE\nlastProbeActivityCount=1/u);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

test('disposable verification runtime binds container and volume to one exact image authority',
  async () => {
    const operationToken = '12345678-1234-4abc-8def-1234567890ab';
    const volumeName = `easyboost-verify-${operationToken}`;
    const calls = [];
    const runtime = await createDisposablePostgresVerificationRuntime({
      archiveBytes: 23,
      capacityHeadroomBytes: 1_048_576,
      operationToken,
      postgresExpectedImageId: postgresImageId,
      readinessAttempts: 1,
      runDocker: async (arguments_) => {
        calls.push(arguments_);
        if (arguments_[0] === 'volume' && arguments_[1] === 'create') return volumeName;
        if (arguments_[0] === 'run') return postgresContainerId;
        if (arguments_[0] === 'inspect') {
          return [
            postgresContainerId,
            postgresImageId,
            'true',
            operationToken,
            volumeName,
            '/var/lib/postgresql/data',
          ].join('|');
        }
        if (arguments_.includes('pg_isready')) return 'ready';
        if (arguments_[0] === 'rm') return postgresContainerId;
        if (arguments_[0] === 'volume' && arguments_[1] === 'rm') return volumeName;
        throw new Error(`unexpected Docker command: ${arguments_.join(' ')}`);
      },
    });
    assert.equal(runtime.containerId, postgresContainerId);
    const run = calls.find((arguments_) => arguments_[0] === 'run');
    assert.ok(run.includes('--network') && run.includes('none'));
    assert.ok(run.includes(postgresImageId));
    assert.equal(run.some((argument) => /postgres:17-alpine/u.test(argument)), false);
    await runtime.cleanup();
    assert.ok(calls.some((arguments_) => arguments_[0] === 'rm'
      && arguments_.includes(postgresContainerId)));
    assert.ok(calls.some((arguments_) => arguments_[0] === 'volume'
      && arguments_[1] === 'rm' && arguments_.includes(volumeName)));
  });

test('production app start uses the shared host guard through exact-image readiness', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-app-lifecycle-'));
  const hostLockDirectory = path.join(directory, 'host.lock');
  const calls = [];
  let appRunning = false;
  let readinessObservedGuard = false;
  try {
    const result = await runProductionAppLifecycle({
      action: 'start',
      checkReadiness: async () => {
        await assert.rejects(acquireHostOperationLock({
          lockDirectory: hostLockDirectory,
          operation: 'database-restore',
        }), /HOST_OPERATION_LOCKED/u);
        readinessObservedGuard = true;
      },
      hostLockDirectory,
      postgresExpectedImageId: postgresImageId,
      productionAppImageId: applicationImageId,
      runDocker: async (arguments_) => {
        calls.push(arguments_);
        if (arguments_[0] === 'image') return arguments_.at(-1);
        if (arguments_[0] === 'compose' && arguments_.includes('ps')
            && arguments_.at(-1) === 'postgres') return postgresContainerId;
        if (arguments_[0] === 'compose' && arguments_.includes('ps')
            && arguments_.at(-1) === 'app') return appContainerId;
        if (arguments_[0] === 'inspect' && arguments_.at(-1) === postgresContainerId) {
          return [postgresContainerId, 'easyboost-production', 'postgres', 'False', postgresImageId,
            'true'].join('|');
        }
        if (arguments_[0] === 'inspect' && arguments_.at(-1) === appContainerId) {
          return [appContainerId, 'easyboost-production', 'app', 'False', applicationImageId,
            String(appRunning)].join('|');
        }
        if (arguments_[0] === 'start') { appRunning = true; return appContainerId; }
        throw new Error(`unexpected Docker command: ${arguments_.join(' ')}`);
      },
    });
    assert.deepEqual(result, { action: 'start', appContainerId });
    assert.equal(readinessObservedGuard, true);
    assert.equal(appRunning, true);
    assert.equal(calls.some((arguments_) => arguments_[0] === 'start'
      && arguments_.at(-1) === appContainerId), true);
    assert.equal(calls.some((arguments_) => arguments_[0] === 'compose'
      && arguments_.includes('up')), false,
    'an existing immutable app must start by exact ID, not mutable Compose selection');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('production app replacement swaps one approved immutable allocation under the shared guard',
  async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-app-replace-'));
    const hostLockDirectory = path.join(directory, 'host.lock');
    let allocation = appContainerId;
    let appImageId = previousApplicationImageId;
    let appRunning = true;
    let readinessObservedGuard = false;
    const calls = [];
    try {
      const result = await runProductionAppLifecycle({
        action: 'replace',
        checkReadiness: async () => {
          await assert.rejects(acquireHostOperationLock({
            lockDirectory: hostLockDirectory,
            operation: 'database-import',
          }), /HOST_OPERATION_LOCKED/u);
          readinessObservedGuard = true;
        },
        hostLockDirectory,
        postgresExpectedImageId: postgresImageId,
        previousAppImageId: previousApplicationImageId,
        productionAppImageId: applicationImageId,
        runDocker: async (arguments_) => {
          calls.push(arguments_);
          if (arguments_[0] === 'image') return arguments_.at(-1);
          if (arguments_[0] === 'compose' && arguments_.includes('ps')
              && arguments_.at(-1) === 'postgres') return postgresContainerId;
          if (arguments_[0] === 'compose' && arguments_.includes('ps')
              && arguments_.at(-1) === 'app') return allocation;
          if (arguments_[0] === 'inspect' && arguments_.at(-1) === postgresContainerId) {
            return [postgresContainerId, 'easyboost-production', 'postgres', 'False',
              postgresImageId, 'true'].join('|');
          }
          if (arguments_[0] === 'inspect' && arguments_.at(-1) === allocation) {
            return [allocation, 'easyboost-production', 'app', 'False', appImageId,
              String(appRunning)].join('|');
          }
          if (arguments_[0] === 'stop') {
            assert.equal(arguments_.at(-1), allocation);
            appRunning = false;
            return allocation;
          }
          if (arguments_[0] === 'rm') {
            assert.equal(arguments_.at(-1), allocation);
            allocation = '';
            return arguments_.at(-1);
          }
          if (arguments_[0] === 'compose' && arguments_.includes('up')) {
            assert.equal(allocation, '');
            allocation = replacementAppContainerId;
            appImageId = applicationImageId;
            appRunning = true;
            return '';
          }
          throw new Error(`unexpected Docker command: ${arguments_.join(' ')}`);
        },
      });
      assert.deepEqual(result, {
        action: 'replace',
        appContainerId: replacementAppContainerId,
        previousAppContainerId: appContainerId,
      });
      assert.equal(readinessObservedGuard, true);
      assert.equal(allocation, replacementAppContainerId);
      assert.equal(appImageId, applicationImageId);
      assert.equal(appRunning, true);
      assert.equal(calls.some((arguments_) => arguments_[0] === 'stop'
        && arguments_.at(-1) === appContainerId), true);
      assert.equal(calls.some((arguments_) => arguments_[0] === 'rm'
        && arguments_.at(-1) === appContainerId), true);
      assert.equal(calls.some((arguments_) => arguments_[0] === 'compose'
        && arguments_.includes('up')), true);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

test('replacement CLI rejects missing or mutable previous application image authority', () => {
  const baseEnvironment = {
    ...process.env,
    EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID: postgresImageId,
    EASYBOOST_PRODUCTION_APP_IMAGE_ID: applicationImageId,
  };
  delete baseEnvironment.EASYBOOST_PREVIOUS_APP_IMAGE_ID;
  for (const previousImageId of [undefined, 'easyboost/app:latest']) {
    const environment = { ...baseEnvironment };
    if (previousImageId) environment.EASYBOOST_PREVIOUS_APP_IMAGE_ID = previousImageId;
    const result = spawnSync(
      process.execPath,
      ['scripts/production-app-lifecycle.js', 'replace'],
      {
        cwd: path.resolve(),
        encoding: 'utf8',
        env: environment,
      },
    );
    assert.equal(result.status, 2);
    assert.match(result.stderr,
      /EASYBOOST_PREVIOUS_APP_IMAGE_ID must be a canonical sha256 image ID/u);
  }
});

test('production app replacement rejects a current allocation outside previous-image authority',
  async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-app-replace-owner-'));
    const hostLockDirectory = path.join(directory, 'host.lock');
    const calls = [];
    const unauthorizedImageId = `sha256:${'d'.repeat(64)}`;
    try {
      await assert.rejects(runProductionAppLifecycle({
        action: 'replace',
        hostLockDirectory,
        postgresExpectedImageId: postgresImageId,
        previousAppImageId: previousApplicationImageId,
        productionAppImageId: applicationImageId,
        runDocker: async (arguments_) => {
          calls.push(arguments_);
          if (arguments_[0] === 'image') return arguments_.at(-1);
          if (arguments_[0] === 'compose' && arguments_.includes('ps')
              && arguments_.at(-1) === 'postgres') return postgresContainerId;
          if (arguments_[0] === 'compose' && arguments_.includes('ps')
              && arguments_.at(-1) === 'app') return appContainerId;
          if (arguments_[0] === 'inspect' && arguments_.at(-1) === postgresContainerId) {
            return [postgresContainerId, 'easyboost-production', 'postgres', 'False',
              postgresImageId, 'true'].join('|');
          }
          if (arguments_[0] === 'inspect' && arguments_.at(-1) === appContainerId) {
            return [appContainerId, 'easyboost-production', 'app', 'False', unauthorizedImageId,
              'true'].join('|');
          }
          throw new Error(`unexpected Docker command: ${arguments_.join(' ')}`);
        },
      }), /identity, ownership, image or running state changed/u);
      assert.equal(calls.some((arguments_) => ['stop', 'rm'].includes(arguments_[0])), false);
      assert.equal(calls.some((arguments_) => arguments_[0] === 'compose'
        && arguments_.includes('up')), false);
      await acquireHostOperationLock({
        lockDirectory: hostLockDirectory,
        operation: 'database-import',
      }).then((release) => release());
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

test('failed replacement readiness removes the exact approved new allocation and releases the guard',
  async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-app-replace-ready-'));
    const hostLockDirectory = path.join(directory, 'host.lock');
    const readinessError = new Error('replacement readiness failed');
    let allocation = appContainerId;
    let appImageId = previousApplicationImageId;
    let appRunning = true;
    const removed = [];
    try {
      await assert.rejects(runProductionAppLifecycle({
        action: 'replace',
        checkReadiness: async () => { throw readinessError; },
        hostLockDirectory,
        postgresExpectedImageId: postgresImageId,
        previousAppImageId: previousApplicationImageId,
        productionAppImageId: applicationImageId,
        runDocker: async (arguments_) => {
          if (arguments_[0] === 'image') return arguments_.at(-1);
          if (arguments_[0] === 'compose' && arguments_.includes('ps')
              && arguments_.at(-1) === 'postgres') return postgresContainerId;
          if (arguments_[0] === 'compose' && arguments_.includes('ps')
              && arguments_.at(-1) === 'app') return allocation;
          if (arguments_[0] === 'inspect' && arguments_.at(-1) === postgresContainerId) {
            return [postgresContainerId, 'easyboost-production', 'postgres', 'False',
              postgresImageId, 'true'].join('|');
          }
          if (arguments_[0] === 'inspect' && arguments_.at(-1) === allocation) {
            return [allocation, 'easyboost-production', 'app', 'False', appImageId,
              String(appRunning)].join('|');
          }
          if (arguments_[0] === 'stop') {
            assert.equal(arguments_.at(-1), allocation);
            appRunning = false;
            return allocation;
          }
          if (arguments_[0] === 'rm') {
            assert.equal(arguments_.at(-1), allocation);
            removed.push(allocation);
            allocation = '';
            return arguments_.at(-1);
          }
          if (arguments_[0] === 'compose' && arguments_.includes('up')) {
            allocation = replacementAppContainerId;
            appImageId = applicationImageId;
            appRunning = true;
            return '';
          }
          throw new Error(`unexpected Docker command: ${arguments_.join(' ')}`);
        },
      }), (error) => error === readinessError);
      assert.equal(allocation, '');
      assert.deepEqual(removed, [appContainerId, replacementAppContainerId]);
      await acquireHostOperationLock({
        lockDirectory: hostLockDirectory,
        operation: 'database-restore',
      }).then((release) => release());
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

test('rejected replacement create retains the guard when immediate allocation inventory is empty',
  async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-app-replace-late-'));
    const hostLockDirectory = path.join(directory, 'host.lock');
    const primaryError = new Error('replacement Compose response was lost');
    let allocation = appContainerId;
    let appRunning = true;
    try {
      await assert.rejects(runProductionAppLifecycle({
        action: 'replace',
        hostLockDirectory,
        postgresExpectedImageId: postgresImageId,
        previousAppImageId: previousApplicationImageId,
        productionAppImageId: applicationImageId,
        runDocker: async (arguments_) => {
          if (arguments_[0] === 'image') return arguments_.at(-1);
          if (arguments_[0] === 'compose' && arguments_.includes('ps')
              && arguments_.at(-1) === 'postgres') return postgresContainerId;
          if (arguments_[0] === 'compose' && arguments_.includes('ps')
              && arguments_.at(-1) === 'app') return allocation;
          if (arguments_[0] === 'inspect' && arguments_.at(-1) === postgresContainerId) {
            return [postgresContainerId, 'easyboost-production', 'postgres', 'False',
              postgresImageId, 'true'].join('|');
          }
          if (arguments_[0] === 'inspect' && arguments_.at(-1) === appContainerId) {
            return [appContainerId, 'easyboost-production', 'app', 'False',
              previousApplicationImageId, String(appRunning)].join('|');
          }
          if (arguments_[0] === 'stop') { appRunning = false; return appContainerId; }
          if (arguments_[0] === 'rm') { allocation = ''; return appContainerId; }
          if (arguments_[0] === 'compose' && arguments_.includes('up')) throw primaryError;
          throw new Error(`unexpected Docker command: ${arguments_.join(' ')}`);
        },
      }), (error) => error === primaryError);
      assert.equal(allocation, '', 'the immediate observation may still be empty');
      await assert.rejects(acquireHostOperationLock({
        lockDirectory: hostLockDirectory,
        operation: 'database-import',
      }), /HOST_OPERATION_LOCKED/u,
      'a rejected create may still have a delayed side effect after the immediate empty probe');
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

test('replacement cleanup failure retains the guard and reports readiness before removal errors',
  async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-app-replace-cleanup-'));
    const hostLockDirectory = path.join(directory, 'host.lock');
    const readinessError = new Error('replacement readiness failed');
    const removalError = new Error('replacement allocation removal response was lost');
    let allocation = appContainerId;
    let appImageId = previousApplicationImageId;
    let appRunning = true;
    try {
      await assert.rejects(runProductionAppLifecycle({
        action: 'replace',
        checkReadiness: async () => { throw readinessError; },
        hostLockDirectory,
        postgresExpectedImageId: postgresImageId,
        previousAppImageId: previousApplicationImageId,
        productionAppImageId: applicationImageId,
        runDocker: async (arguments_) => {
          if (arguments_[0] === 'image') return arguments_.at(-1);
          if (arguments_[0] === 'compose' && arguments_.includes('ps')
              && arguments_.at(-1) === 'postgres') return postgresContainerId;
          if (arguments_[0] === 'compose' && arguments_.includes('ps')
              && arguments_.at(-1) === 'app') return allocation;
          if (arguments_[0] === 'inspect' && arguments_.at(-1) === postgresContainerId) {
            return [postgresContainerId, 'easyboost-production', 'postgres', 'False',
              postgresImageId, 'true'].join('|');
          }
          if (arguments_[0] === 'inspect' && arguments_.at(-1) === allocation) {
            return [allocation, 'easyboost-production', 'app', 'False', appImageId,
              String(appRunning)].join('|');
          }
          if (arguments_[0] === 'stop') { appRunning = false; return allocation; }
          if (arguments_[0] === 'rm' && allocation === appContainerId) {
            allocation = '';
            return appContainerId;
          }
          if (arguments_[0] === 'compose' && arguments_.includes('up')) {
            allocation = replacementAppContainerId;
            appImageId = applicationImageId;
            appRunning = true;
            return '';
          }
          if (arguments_[0] === 'rm' && allocation === replacementAppContainerId) {
            throw removalError;
          }
          throw new Error(`unexpected Docker command: ${arguments_.join(' ')}`);
        },
      }), (error) => {
        assert.ok(error instanceof AggregateError);
        assert.equal(error.cause, readinessError);
        assert.equal(error.errors[0], readinessError);
        assert.ok(error.errors[1] instanceof AggregateError);
        assert.equal(error.errors[1].errors[0], removalError);
        assert.match(error.errors[1].errors[1].message,
          /allocation remains after exact removal/u);
        return true;
      });
      assert.equal(allocation, replacementAppContainerId);
      assert.equal(appRunning, false);
      await assert.rejects(acquireHostOperationLock({
        lockDirectory: hostLockDirectory,
        operation: 'database-restore',
      }), /HOST_OPERATION_LOCKED/u);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

test('production app stop removes the exact allocation before releasing the shared host guard',
  async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-app-stop-'));
    const hostLockDirectory = path.join(directory, 'host.lock');
    const calls = [];
    let appContainerAllocation = appContainerId;
    let appRunning = true;
    let removalObservedGuard = false;
    try {
      const result = await runProductionAppLifecycle({
        action: 'stop',
        hostLockDirectory,
        postgresExpectedImageId: postgresImageId,
        productionAppImageId: applicationImageId,
        runDocker: async (arguments_) => {
          calls.push(arguments_);
          if (arguments_[0] === 'image') return arguments_.at(-1);
          if (arguments_[0] === 'compose' && arguments_.includes('ps')
              && arguments_.at(-1) === 'postgres') return postgresContainerId;
          if (arguments_[0] === 'compose' && arguments_.includes('ps')
              && arguments_.at(-1) === 'app') return appContainerAllocation;
          if (arguments_[0] === 'inspect' && arguments_.at(-1) === postgresContainerId) {
            return [postgresContainerId, 'easyboost-production', 'postgres', 'False',
              postgresImageId, 'true'].join('|');
          }
          if (arguments_[0] === 'inspect' && arguments_.at(-1) === appContainerId) {
            return [appContainerId, 'easyboost-production', 'app', 'False', applicationImageId,
              String(appRunning)].join('|');
          }
          if (arguments_[0] === 'stop') {
            appRunning = false;
            return appContainerId;
          }
          if (arguments_[0] === 'rm') {
            await assert.rejects(acquireHostOperationLock({
              lockDirectory: hostLockDirectory,
              operation: 'database-import',
            }), /HOST_OPERATION_LOCKED/u);
            removalObservedGuard = true;
            appContainerAllocation = '';
            return appContainerId;
          }
          throw new Error(`unexpected Docker command: ${arguments_.join(' ')}`);
        },
      });
      assert.deepEqual(result, { action: 'stop', appContainerId });
      assert.equal(removalObservedGuard, true);
      assert.equal(appContainerAllocation, '',
        'a successful stop must leave no Compose app allocation for database-only work');
      assert.equal(calls.some((arguments_) => arguments_[0] === 'rm'
        && arguments_.at(-1) === appContainerId), true);
      await acquireHostOperationLock({
        lockDirectory: hostLockDirectory,
        operation: 'database-import',
      }).then((release) => release());
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

test('failed start from no allocation removes a remotely created exact container', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-app-create-failure-'));
  const hostLockDirectory = path.join(directory, 'host.lock');
  const primaryError = new Error('compose up response was lost');
  let allocation = '';
  let running = false;
  const calls = [];
  try {
    await assert.rejects(runProductionAppLifecycle({
      action: 'start',
      hostLockDirectory,
      postgresExpectedImageId: postgresImageId,
      productionAppImageId: applicationImageId,
      runDocker: async (arguments_) => {
        calls.push(arguments_);
        if (arguments_[0] === 'image') return arguments_.at(-1);
        if (arguments_[0] === 'compose' && arguments_.includes('ps')
            && arguments_.at(-1) === 'postgres') return postgresContainerId;
        if (arguments_[0] === 'compose' && arguments_.includes('ps')
            && arguments_.at(-1) === 'app') return allocation;
        if (arguments_[0] === 'inspect' && arguments_.at(-1) === postgresContainerId) {
          return [postgresContainerId, 'easyboost-production', 'postgres', 'False', postgresImageId,
            'true'].join('|');
        }
        if (arguments_[0] === 'compose' && arguments_.includes('up')) {
          allocation = appContainerId;
          running = true;
          throw primaryError;
        }
        if (arguments_[0] === 'inspect' && arguments_.at(-1) === appContainerId) {
          return [appContainerId, 'easyboost-production', 'app', 'False', applicationImageId,
            String(running)].join('|');
        }
        if (arguments_[0] === 'stop') { running = false; return appContainerId; }
        if (arguments_[0] === 'rm') { allocation = ''; return appContainerId; }
        throw new Error(`unexpected Docker command: ${arguments_.join(' ')}`);
      },
    }), (error) => error === primaryError);
    assert.equal(allocation, '',
      'a failed create-start must restore the prior empty application allocation');
    assert.equal(calls.some((arguments_) => arguments_[0] === 'rm'), true);
    await assert.rejects(acquireHostOperationLock({
      lockDirectory: hostLockDirectory,
      operation: 'database-restore',
    }), /HOST_OPERATION_LOCKED/u,
    'a rejected Compose start has unproven delayed settlement even after observed cleanup');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('failed exact-ID start is treated as mutation-pending and re-isolated', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-app-start-failure-'));
  const hostLockDirectory = path.join(directory, 'host.lock');
  const primaryError = new Error('docker start response was lost');
  let running = false;
  let stopCalls = 0;
  try {
    await assert.rejects(runProductionAppLifecycle({
      action: 'start',
      hostLockDirectory,
      postgresExpectedImageId: postgresImageId,
      productionAppImageId: applicationImageId,
      runDocker: async (arguments_) => {
        if (arguments_[0] === 'image') return arguments_.at(-1);
        if (arguments_[0] === 'compose' && arguments_.includes('ps')
            && arguments_.at(-1) === 'postgres') return postgresContainerId;
        if (arguments_[0] === 'compose' && arguments_.includes('ps')
            && arguments_.at(-1) === 'app') return appContainerId;
        if (arguments_[0] === 'inspect' && arguments_.at(-1) === postgresContainerId) {
          return [postgresContainerId, 'easyboost-production', 'postgres', 'False', postgresImageId,
            'true'].join('|');
        }
        if (arguments_[0] === 'inspect' && arguments_.at(-1) === appContainerId) {
          return [appContainerId, 'easyboost-production', 'app', 'False', applicationImageId,
            String(running)].join('|');
        }
        if (arguments_[0] === 'start') {
          throw primaryError;
        }
        if (arguments_[0] === 'stop') {
          stopCalls += 1;
          running = false;
          return appContainerId;
        }
        throw new Error(`unexpected Docker command: ${arguments_.join(' ')}`);
      },
    }), (error) => error === primaryError);
    assert.equal(running, false);
    assert.equal(stopCalls, 1,
      'a rejected exact-ID start must issue stop even when the immediate probe still says stopped');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('rejected start retains the guard when its ordered recovery stop also rejects', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-app-stop-settlement-'));
  const hostLockDirectory = path.join(directory, 'host.lock');
  const primaryError = new Error('docker start response was lost');
  const stopError = new Error('ordered recovery stop response was lost');
  try {
    await assert.rejects(runProductionAppLifecycle({
      action: 'start',
      hostLockDirectory,
      postgresExpectedImageId: postgresImageId,
      productionAppImageId: applicationImageId,
      runDocker: async (arguments_) => {
        if (arguments_[0] === 'image') return arguments_.at(-1);
        if (arguments_[0] === 'compose' && arguments_.includes('ps')
            && arguments_.at(-1) === 'postgres') return postgresContainerId;
        if (arguments_[0] === 'compose' && arguments_.includes('ps')
            && arguments_.at(-1) === 'app') return appContainerId;
        if (arguments_[0] === 'inspect' && arguments_.at(-1) === postgresContainerId) {
          return [postgresContainerId, 'easyboost-production', 'postgres', 'False', postgresImageId,
            'true'].join('|');
        }
        if (arguments_[0] === 'inspect' && arguments_.at(-1) === appContainerId) {
          return [appContainerId, 'easyboost-production', 'app', 'False', applicationImageId,
            'false'].join('|');
        }
        if (arguments_[0] === 'start') throw primaryError;
        if (arguments_[0] === 'stop') throw stopError;
        throw new Error(`unexpected Docker command: ${arguments_.join(' ')}`);
      },
    }), (error) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.errors[0], primaryError);
      assert.equal(error.errors[1], stopError);
      return true;
    });
    await assert.rejects(acquireHostOperationLock({
      lockDirectory: hostLockDirectory,
      operation: 'database-import',
    }), /HOST_OPERATION_LOCKED/u);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('failed create-start retains the host guard when allocation settlement cannot be reproved',
  async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-app-start-retain-'));
    const hostLockDirectory = path.join(directory, 'host.lock');
    const primaryError = new Error('compose up response was lost');
    let appInventoryCalls = 0;
    try {
      await assert.rejects(runProductionAppLifecycle({
        action: 'start',
        hostLockDirectory,
        postgresExpectedImageId: postgresImageId,
        productionAppImageId: applicationImageId,
        runDocker: async (arguments_) => {
          if (arguments_[0] === 'image') return arguments_.at(-1);
          if (arguments_[0] === 'compose' && arguments_.includes('ps')
              && arguments_.at(-1) === 'postgres') return postgresContainerId;
          if (arguments_[0] === 'compose' && arguments_.includes('ps')
              && arguments_.at(-1) === 'app') {
            appInventoryCalls += 1;
            if (appInventoryCalls === 1) return '';
            throw new Error('application allocation inventory unavailable');
          }
          if (arguments_[0] === 'inspect' && arguments_.at(-1) === postgresContainerId) {
            return [postgresContainerId, 'easyboost-production', 'postgres', 'False',
              postgresImageId, 'true'].join('|');
          }
          if (arguments_[0] === 'compose' && arguments_.includes('up')) throw primaryError;
          throw new Error(`unexpected Docker command: ${arguments_.join(' ')}`);
        },
      }), (error) => {
        assert.ok(error instanceof AggregateError);
        assert.equal(error.errors[0], primaryError);
        assert.equal(error.cause, primaryError);
        return true;
      });
      await assert.rejects(acquireHostOperationLock({
        lockDirectory: hostLockDirectory,
        operation: 'database-restore',
      }), /HOST_OPERATION_LOCKED/u);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

test('rejected Compose start retains the host guard even when the immediate allocation is empty',
  async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-app-start-delayed-'));
    const hostLockDirectory = path.join(directory, 'host.lock');
    const primaryError = new Error('compose up rejected before its delayed daemon side effect');
    try {
      await assert.rejects(runProductionAppLifecycle({
        action: 'start',
        hostLockDirectory,
        postgresExpectedImageId: postgresImageId,
        productionAppImageId: applicationImageId,
        runDocker: async (arguments_) => {
          if (arguments_[0] === 'image') return arguments_.at(-1);
          if (arguments_[0] === 'compose' && arguments_.includes('ps')
              && arguments_.at(-1) === 'postgres') return postgresContainerId;
          if (arguments_[0] === 'compose' && arguments_.includes('ps')
              && arguments_.at(-1) === 'app') return '';
          if (arguments_[0] === 'inspect' && arguments_.at(-1) === postgresContainerId) {
            return [postgresContainerId, 'easyboost-production', 'postgres', 'False',
              postgresImageId, 'true'].join('|');
          }
          if (arguments_[0] === 'compose' && arguments_.includes('up')) throw primaryError;
          throw new Error(`unexpected Docker command: ${arguments_.join(' ')}`);
        },
      }), (error) => error === primaryError);
      await assert.rejects(acquireHostOperationLock({
        lockDirectory: hostLockDirectory,
        operation: 'database-import',
      }), /HOST_OPERATION_LOCKED/u);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

test('maintenance stop is idempotent for an absent or approved stopped allocation', async () => {
  for (const initialAllocation of ['', appContainerId]) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-app-stop-idempotent-'));
    const hostLockDirectory = path.join(directory, 'host.lock');
    let allocation = initialAllocation;
    try {
      const result = await runProductionAppLifecycle({
        action: 'stop',
        hostLockDirectory,
        postgresExpectedImageId: postgresImageId,
        productionAppImageId: applicationImageId,
        runDocker: async (arguments_) => {
          if (arguments_[0] === 'image') return arguments_.at(-1);
          if (arguments_[0] === 'compose' && arguments_.includes('ps')
              && arguments_.at(-1) === 'postgres') return postgresContainerId;
          if (arguments_[0] === 'compose' && arguments_.includes('ps')
              && arguments_.at(-1) === 'app') return allocation;
          if (arguments_[0] === 'inspect' && arguments_.at(-1) === postgresContainerId) {
            return [postgresContainerId, 'easyboost-production', 'postgres', 'False',
              postgresImageId, 'true'].join('|');
          }
          if (arguments_[0] === 'inspect' && arguments_.at(-1) === appContainerId) {
            return [appContainerId, 'easyboost-production', 'app', 'False', applicationImageId,
              'false'].join('|');
          }
          if (arguments_[0] === 'rm') { allocation = ''; return appContainerId; }
          throw new Error(`unexpected Docker command: ${arguments_.join(' ')}`);
        },
      });
      assert.deepEqual(result, {
        action: 'stop',
        ...(initialAllocation ? { appContainerId } : {}),
      });
      assert.equal(allocation, '');
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  }
});
