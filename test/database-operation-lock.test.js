import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_DATABASE_OPERATION_LOCK_FILE,
  acquireDatabaseOperationLock,
  beginDatabaseOperationLocalChildHold,
  describeDatabaseOperationLocalChildHold,
  openDatabaseOperationLockProtocolRecovery,
  openRetainedDatabaseOperationLock,
  proveDatabaseOperationLockAbsent,
  releaseDatabaseOperationLock,
  retainDatabaseOperationLocalChildRecovery,
  retainDatabaseOperationLock,
} from '../scripts/database-operation-lock.js';
import {
  DEFAULT_HOST_OPERATION_LOCK_DIRECTORY,
  acquireHostOperationLock,
  openRetainedHostOperationLock,
  releaseHostOperationLock,
  retainHostOperationLock,
} from '../scripts/host-operation-lock.js';
import {
  PRODUCTION_IMPORT_LOCAL_CHILD_RETENTION_REASON,
  createProductionImportLocalChildRecovery,
} from '../scripts/production-import-local-child-authority.js';

const RESTORE_OPERATION_TOKEN = '12345678-1234-4abc-8def-1234567890ab';
const TEST_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const SYNTHETIC_POSIX_PUBLICATION_SOURCE_BINDING = Object.freeze({
  birthtimeNs: '0',
  bytes: 0,
  ctimeNs: '0',
  dev: '0',
  gid: '0',
  ino: '0',
  mode: String(0o100600),
  sha256: '0'.repeat(64),
  uid: '0',
});

function restoreEvidence(overrides = {}) {
  return {
    applicationName: `easyboost_restore_${RESTORE_OPERATION_TOKEN}`,
    kind: 'restore',
    lastProbe: { activityCount: 2, process: 'ACTIVE', status: 'RUNNING' },
    operationToken: RESTORE_OPERATION_TOKEN,
    postgresContainerId: '2'.repeat(64),
    ...overrides,
  };
}

function retainedMarkerForActive(activeMarker, evidence = restoreEvidence()) {
  const authorityToken = activeMarker.toString('utf8').match(
    /^authorityToken=([0-9a-f]{64})$/mu,
  )?.[1];
  assert.ok(authorityToken);
  const lines = [
    'RETAINED',
    'protocol=easyboost-database-operation-lock-v3',
    `authorityToken=${authorityToken}`,
    `ownerPid=${process.pid}`,
    'reason=REMOTE_RESTORE_SETTLEMENT_UNPROVEN',
    'evidenceKind=restore',
    `operationToken=${evidence.operationToken}`,
    `applicationName=${evidence.applicationName}`,
    'ownershipToken=unknown',
    'importContainerId=unknown',
    `postgresContainerId=${evidence.postgresContainerId}`,
    `lastProbeStatus=${evidence.lastProbe.status}`,
    `lastProbeProcess=${evidence.lastProbe.process}`,
    `lastProbeActivityCount=${evidence.lastProbe.activityCount}`,
  ];
  const payload = Buffer.from(`${lines.join('\n')}\n`, 'utf8');
  return Buffer.concat([
    payload,
    Buffer.from(`markerSha256=${createHash('sha256').update(payload).digest('hex')}\n`, 'utf8'),
  ]);
}

async function databaseProtocolArtifacts(lockFile) {
  const baseName = path.basename(lockFile);
  return (await fs.readdir(path.dirname(lockFile))).filter((entry) => (
    entry === baseName || entry.startsWith(`${baseName}.`)
  ));
}

async function databaseRetirementArtifacts(lockFile) {
  const prefix = `${path.basename(lockFile)}-retired-`;
  return (await fs.readdir(path.dirname(lockFile))).filter((entry) => entry.startsWith(prefix));
}

function localChildPublicationFailureFileSystem() {
  return {
    ...fs,
    async link(source, destination) {
      if (/\.local-child-[0-9a-f]{32}$/u.test(String(destination))) {
        const error = new Error('simulated local-child publication link failure');
        error.code = 'EIO';
        throw error;
      }
      return fs.link(source, destination);
    },
  };
}

function localChildClaimCrashFileSystem() {
  let claimFile = null;
  let failParentSync = false;
  return {
    fileSystem: {
      ...fs,
      async open(file, flags, mode) {
        if (failParentSync && flags === 'r' && path.resolve(String(file)) === path.resolve(
          path.dirname(claimFile),
        )) {
          failParentSync = false;
          const error = new Error('simulated crash after local-child claim');
          error.code = 'EIO';
          throw error;
        }
        return fs.open(file, flags, mode);
      },
      async rename(source, destination) {
        const result = await fs.rename(source, destination);
        if (/\.local-child-[0-9a-f]{32}\.child-[1-9]\d*-[0-9a-f]{64}\.claimed$/u
          .test(String(destination))) {
          claimFile = String(destination);
          failParentSync = true;
        }
        return result;
      },
    },
    claimFile: () => claimFile,
  };
}

function localChildQuarantineCrashFileSystem() {
  let quarantineFile = null;
  let failParentSync = false;
  return {
    fileSystem: {
      ...fs,
      async open(file, flags, mode) {
        if (failParentSync && flags === 'r' && path.resolve(String(file)) === path.resolve(
          path.dirname(quarantineFile),
        )) {
          failParentSync = false;
          const error = new Error('simulated crash after local-child delete quarantine');
          error.code = 'EIO';
          throw error;
        }
        return fs.open(file, flags, mode);
      },
      async rename(source, destination) {
        const result = await fs.rename(source, destination);
        if (/\.local-child-[0-9a-f]{32}\.child-[1-9]\d*-[0-9a-f]{64}\.claimed\.delete-[0-9a-f]{64}\.quarantine$/u
          .test(String(destination))) {
          quarantineFile = String(destination);
          failParentSync = true;
        }
        return result;
      },
    },
    quarantineFile: () => quarantineFile,
  };
}

function retentionFaultFileSystem(fault) {
  return {
    ...fs,
    async open(file, flags, mode) {
      const handle = await fs.open(file, flags, mode);
      if (!String(file).includes('.retained-')) return handle;
      let writeCalls = 0;
      return {
        async close() {
          await handle.close();
          if (fault === 'close') {
            const error = new Error('simulated retained marker close failure');
            error.code = 'EIO';
            throw error;
          }
        },
        read: handle.read.bind(handle),
        stat: handle.stat.bind(handle),
        async sync() {
          if (fault === 'sync') {
            const error = new Error('simulated retained marker sync failure');
            error.code = 'EIO';
            throw error;
          }
          return handle.sync();
        },
        async write(buffer, offset, length, position) {
          writeCalls += 1;
          if (fault === 'zero-write') return { bytesWritten: 0, buffer };
          if (fault === 'partial-enospc' && writeCalls === 1) {
            return handle.write(buffer, offset, Math.min(7, length), position);
          }
          if (fault === 'partial-enospc') {
            const error = new Error('simulated retained marker ENOSPC');
            error.code = 'ENOSPC';
            throw error;
          }
          return handle.write(buffer, offset, length, position);
        },
      };
    },
  };
}

function pathSwapFileSystem(lockFile) {
  const displacedFile = `${lockFile}.displaced-owner`;
  const foreignMarker = Buffer.from('FOREIGN-DATABASE-LOCK\n', 'utf8');
  let armed = false;
  let swapped = false;
  const swap = async () => {
    if (!armed || swapped) return;
    swapped = true;
    await fs.rename(lockFile, displacedFile);
    await fs.writeFile(lockFile, foreignMarker, { flag: 'wx', mode: 0o600 });
  };
  return {
    arm() { armed = true; },
    displacedFile,
    fileSystem: {
      ...fs,
      async rename(source, destination) {
        if (source === lockFile || destination === lockFile) await swap();
        return fs.rename(source, destination);
      },
      async rm(file, options) {
        if (file === lockFile) await swap();
        return fs.rm(file, options);
      },
    },
    foreignMarker,
  };
}

function unsupportedDirectorySyncFileSystem(directory) {
  return {
    ...fs,
    requireDirectorySync: true,
    async open(file, flags, mode) {
      const handle = await fs.open(file, flags, mode);
      if (path.resolve(String(file)) !== path.resolve(directory) || flags !== 'r') return handle;
      return {
        close: handle.close.bind(handle),
        async sync() {
          const error = new Error('simulated unsupported directory fsync');
          error.code = 'EINVAL';
          throw error;
        },
      };
    },
  };
}

function lateRestoreSwapFileSystem(lockFile) {
  const firstForeignMarker = Buffer.from('FIRST-FOREIGN-DATABASE-LOCK\n', 'utf8');
  const lateForeignMarker = Buffer.from('LATE-FOREIGN-DATABASE-LOCK\n', 'utf8');
  let armed = false;
  let initialSwapComplete = false;
  let restoredClaimFile = null;
  let lateSwapPending = false;
  return {
    arm() { armed = true; },
    fileSystem: {
      ...fs,
      async link(source, destination) {
        const result = await fs.link(source, destination);
        if (armed && destination === lockFile && String(source).endsWith('.claimed')) {
          restoredClaimFile = String(source);
          lateSwapPending = true;
        }
        return result;
      },
      async open(file, flags, mode) {
        const handle = await fs.open(file, flags, mode);
        if (!lateSwapPending
            || path.resolve(String(file)) !== path.resolve(path.dirname(lockFile))
            || flags !== 'r') return handle;
        return {
          close: handle.close.bind(handle),
          async sync() {
            lateSwapPending = false;
            await fs.rm(lockFile);
            await fs.writeFile(lockFile, lateForeignMarker, { flag: 'wx', mode: 0o600 });
          },
        };
      },
      async rename(source, destination) {
        if (armed && !initialSwapComplete && source === lockFile) {
          initialSwapComplete = true;
          await fs.rename(lockFile, `${lockFile}.displaced-owner`);
          await fs.writeFile(lockFile, firstForeignMarker, { flag: 'wx', mode: 0o600 });
        }
        return fs.rename(source, destination);
      },
    },
    firstForeignMarker,
    lateForeignMarker,
    restoredClaimFile: () => restoredClaimFile,
  };
}

function claimedCleanupFaultFileSystem(label) {
  let failOnce = true;
  return {
    ...fs,
    async rename(source, destination) {
      if (failOnce
          && String(source).includes(`.${label}-authority-`)
          && String(source).endsWith('.quarantine')
          && /[\\/]captured-/u.test(String(destination))) {
        failOnce = false;
        const error = new Error(`simulated ${label} claimed authority cleanup failure`);
        error.code = 'EIO';
        throw error;
      }
      return fs.rename(source, destination);
    },
    async rm(file, options) {
      if (failOnce
          && String(file).includes(`.${label}-authority-`)
          && (String(file).endsWith('.claimed')
            || String(file).endsWith('.quarantine'))) {
        failOnce = false;
        const error = new Error(`simulated ${label} claimed authority cleanup failure`);
        error.code = 'EIO';
        throw error;
      }
      return fs.rm(file, options);
    },
  };
}

function claimDeletionSwapFileSystem(label) {
  const foreignMarker = Buffer.from(`FOREIGN-${label.toUpperCase()}-CLAIM\n`, 'utf8');
  let displacedFile = null;
  let swapped = false;
  const maybeSwap = async (file) => {
    if (swapped
        || !String(file).includes(`.${label}-marker-`)
        || !String(file).endsWith('.claimed')) return;
    swapped = true;
    displacedFile = `${file}.displaced-exact`;
    await fs.rename(file, displacedFile);
    await fs.writeFile(file, foreignMarker, { flag: 'wx', mode: 0o600 });
  };
  return {
    fileSystem: {
      ...fs,
      async rename(source, destination) {
        await maybeSwap(source);
        return fs.rename(source, destination);
      },
      async rm(file, options) {
        await maybeSwap(file);
        return fs.rm(file, options);
      },
    },
    foreignMarker,
    swappedClaimFile: () => (displacedFile ? displacedFile.replace(/\.displaced-exact$/u, '') : null),
  };
}

function retainedCleanupSwapFileSystem(lockFile) {
  const foreignMarker = Buffer.from('FOREIGN-RETAINED-CANONICAL\n', 'utf8');
  let swapped = false;
  return {
    fileSystem: {
      ...fs,
      async rename(source, destination) {
        if (!swapped
            && String(source).includes('.retained-')
            && String(source).endsWith('.tmp')
            && String(destination).endsWith('.quarantine')) {
          swapped = true;
          await fs.rename(lockFile, `${lockFile}.displaced-retained`);
          await fs.writeFile(lockFile, foreignMarker, { flag: 'wx', mode: 0o600 });
        }
        return fs.rename(source, destination);
      },
    },
    foreignMarker,
  };
}

function quarantineDestructionSwapFileSystem(label) {
  const foreignMarker = Buffer.from(`FOREIGN-${label.toUpperCase()}-QUARANTINE\n`, 'utf8');
  let quarantineFile = null;
  let displacedExactFile = null;
  let swapped = false;
  const maybeSwap = async (file) => {
    if (swapped || file !== quarantineFile) return;
    swapped = true;
    displacedExactFile = `${quarantineFile}.displaced-exact`;
    await fs.rename(quarantineFile, displacedExactFile);
    await fs.writeFile(quarantineFile, foreignMarker, { flag: 'wx', mode: 0o600 });
  };
  return {
    fileSystem: {
      ...fs,
      async rename(source, destination) {
        if (String(source).includes(`.${label}-marker-`)
            && String(source).endsWith('.claimed')
            && String(destination).endsWith('.quarantine')) {
          quarantineFile = String(destination);
        } else if (quarantineFile && source === quarantineFile) {
          await maybeSwap(source);
        }
        return fs.rename(source, destination);
      },
      async rm(file, options) {
        await maybeSwap(file);
        return fs.rm(file, options);
      },
    },
    displacedExactFile: () => displacedExactFile,
    foreignMarker,
    quarantineFile: () => quarantineFile,
  };
}

function quarantineDirectorySyncFaultFileSystem(label) {
  let failNextDirectorySync = false;
  let failed = false;
  return {
    ...fs,
    async open(file, flags, mode) {
      const handle = await fs.open(file, flags, mode);
      if (flags !== 'r' || !(await handle.stat()).isDirectory()) return handle;
      return {
        close: handle.close.bind(handle),
        async sync() {
          if (failNextDirectorySync && !failed) {
            failNextDirectorySync = false;
            failed = true;
            const error = new Error(`simulated ${label} quarantine directory sync failure`);
            error.code = 'EIO';
            throw error;
          }
          return handle.sync();
        },
      };
    },
    async rename(source, destination) {
      const result = await fs.rename(source, destination);
      if (String(source).includes(`.${label}-marker-`)
          && String(source).endsWith('.claimed')
          && String(destination).endsWith('.quarantine')) {
        failNextDirectorySync = true;
      }
      return result;
    },
  };
}

function retirementSlotParentSyncFileSystem(lockFile) {
  const parentDirectory = path.resolve(path.dirname(lockFile));
  const retirementPrefix = `${path.basename(lockFile)}-retired-`;
  let pendingParentSync = false;
  let synchronizedSlots = 0;
  return {
    ...fs,
    synchronizedSlots: () => synchronizedSlots,
    async link(source, destination) {
      if (pendingParentSync && path.basename(path.dirname(destination)).startsWith(retirementPrefix)) {
        const error = new Error('retirement slot contents linked before parent directory sync');
        error.code = 'EUNSYNCEDRETIREMENTSLOT';
        throw error;
      }
      return fs.link(source, destination);
    },
    async mkdir(directory, options) {
      const result = await fs.mkdir(directory, options);
      if (path.basename(String(directory)).startsWith(retirementPrefix)) {
        pendingParentSync = true;
      }
      return result;
    },
    async open(file, flags, mode) {
      const handle = await fs.open(file, flags, mode);
      if (!pendingParentSync
          || flags !== 'r'
          || path.resolve(String(file)) !== parentDirectory) return handle;
      return {
        close: handle.close.bind(handle),
        async sync() {
          pendingParentSync = false;
          synchronizedSlots += 1;
        },
      };
    },
  };
}

function zeroByteCrashFileSystem(label) {
  let cleanupInterrupted = false;
  const matchesTemporary = (file) => (
    String(file).includes(`.${label}-`) && String(file).endsWith('.tmp')
  );
  return {
    ...fs,
    async open(file, flags, mode) {
      const handle = await fs.open(file, flags, mode);
      if (flags !== 'wx+' || !matchesTemporary(file)) return handle;
      return {
        close: handle.close.bind(handle),
        read: handle.read.bind(handle),
        stat: handle.stat.bind(handle),
        sync: handle.sync.bind(handle),
        async write(buffer) {
          return { buffer, bytesWritten: 0 };
        },
      };
    },
    async rename(source, destination) {
      if (!cleanupInterrupted
          && matchesTemporary(source)
          && String(destination).endsWith('.quarantine')) {
        cleanupInterrupted = true;
        const error = new Error(`simulated ${label} zero-byte cleanup crash`);
        error.code = 'EIO';
        throw error;
      }
      return fs.rename(source, destination);
    },
  };
}

function pausedRetainedWriteFileSystem() {
  let reachedPause;
  const paused = new Promise((resolve) => { reachedPause = resolve; });
  let resumeWrite;
  const resumed = new Promise((resolve) => { resumeWrite = resolve; });
  return {
    fileSystem: {
      ...fs,
      async open(file, flags, mode) {
        const handle = await fs.open(file, flags, mode);
        if (flags !== 'wx+' || !String(file).includes('.retained-')) return handle;
        let writes = 0;
        return {
          close: handle.close.bind(handle),
          read: handle.read.bind(handle),
          stat: handle.stat.bind(handle),
          sync: handle.sync.bind(handle),
          async write(buffer, offset, length, position) {
            writes += 1;
            if (writes === 1) {
              const result = await handle.write(buffer, offset, 1, position);
              reachedPause();
              return result;
            }
            if (writes === 2) await resumed;
            return handle.write(buffer, offset, length, position);
          },
        };
      },
    },
    paused,
    resume() { resumeWrite(); },
  };
}

function retirementReclaimFaultFileSystem(fault) {
  let armed = false;
  let failNextParentSync = false;
  let failed = false;
  const isRetirementDirectory = (file) => (
    path.basename(String(file)).includes('-retired-')
  );
  return {
    arm() { armed = true; },
    fileSystem: {
      ...fs,
      async open(file, flags, mode) {
        const handle = await fs.open(file, flags, mode);
        if (!failNextParentSync || flags !== 'r' || !(await handle.stat()).isDirectory()) {
          return handle;
        }
        return {
          close: handle.close.bind(handle),
          async sync() {
            failNextParentSync = false;
            const error = new Error('simulated retirement reclaim parent sync failure');
            error.code = 'EIO';
            throw error;
          },
        };
      },
      async rm(file, options) {
        if (!armed || failed || !isRetirementDirectory(file)) return fs.rm(file, options);
        failed = true;
        if (fault === 'remove') {
          const error = new Error('simulated retirement reclaim removal failure');
          error.code = 'EIO';
          throw error;
        }
        const result = await fs.rm(file, options);
        failNextParentSync = true;
        return result;
      },
    },
  };
}

function occupiedRetirementCaptureFileSystem(target = 'exact') {
  const foreignBytes = Buffer.from('FOREIGN-RETIREMENT-DESTINATION\n', 'utf8');
  let armed = false;
  let foreignFile = null;
  return {
    arm() { armed = true; },
    fileSystem: {
      ...fs,
      async link(source, destination) {
        if (target === 'exact'
            && armed
            && !foreignFile
            && path.basename(String(destination)) === 'exact') {
          foreignFile = String(destination);
          await fs.writeFile(foreignFile, foreignBytes, { flag: 'wx', mode: 0o600 });
        }
        return fs.link(source, destination);
      },
      async open(file, flags, mode) {
        if (target === 'captured'
            && armed
            && !foreignFile
            && flags === 'r'
            && path.basename(String(file)).startsWith('captured-')) {
          foreignFile = String(file);
          await fs.writeFile(foreignFile, foreignBytes, { flag: 'wx', mode: 0o600 });
        }
        return fs.open(file, flags, mode);
      },
    },
    foreignBytes,
    foreignFile: () => foreignFile,
  };
}

test('shared database operation lock exposes one default and excludes contenders', async () => {
  assert.equal(
    DEFAULT_DATABASE_OPERATION_LOCK_FILE,
    path.resolve('backups', '.easyboost-database-operation.lock'),
  );

  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-shared-db-lock-'));
  const lockFile = path.join(directory, '.easyboost-database-operation.lock');
  try {
    const releaseOwner = await acquireDatabaseOperationLock(lockFile);
    await assert.rejects(
      acquireDatabaseOperationLock(lockFile),
      /DATABASE_OPERATION_LOCKED/u,
    );
    await releaseDatabaseOperationLock(releaseOwner, 100);

    const releaseNextOwner = await acquireDatabaseOperationLock(lockFile);
    await releaseDatabaseOperationLock(releaseNextOwner, 100);
    await assert.rejects(fs.access(lockFile), { code: 'ENOENT' });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('database lock publishes a durable local-child hold before spawn and cannot release around it',
  async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-database-child-hold-'));
    const lockFile = path.join(directory, 'database.lock');
    try {
      const release = await acquireDatabaseOperationLock(lockFile);
      let spawnObservedHold = false;
      const hold = await beginDatabaseOperationLocalChildHold(release, {
        commandLabel: 'docker fixture command',
      });
      spawnObservedHold = (await databaseProtocolArtifacts(lockFile)).some(
        (entry) => entry.includes('.local-child-'),
      );

      assert.equal(spawnObservedHold, true,
        'the durable hold must exist before a caller is allowed to spawn');
      await assert.rejects(
        releaseDatabaseOperationLock(release, 20),
        /DATABASE_OPERATION_LOCK_LOCAL_CHILD_HELD/u,
      );
      await hold.release();
      await releaseDatabaseOperationLock(release, 20);
      assert.deepEqual(await databaseProtocolArtifacts(lockFile), []);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

test('database lock retention refuses a live local-child hold before creating retention state',
  async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-retain-child-held-'));
    const lockFile = path.join(directory, 'database.lock');
    try {
      const release = await acquireDatabaseOperationLock(lockFile);
      const hold = await beginDatabaseOperationLocalChildHold(release, {
        commandLabel: 'docker fixture command',
      });
      const before = (await databaseProtocolArtifacts(lockFile)).sort();
      await assert.rejects(retainDatabaseOperationLock(
        release,
        20,
        'REMOTE_RESTORE_SETTLEMENT_UNPROVEN',
        restoreEvidence(),
      ), /DATABASE_OPERATION_LOCK_LOCAL_CHILD_HELD/u);
      assert.deepEqual((await databaseProtocolArtifacts(lockFile)).sort(), before,
        'retention must reject before publishing a temp or claiming ACTIVE');
      await hold.release();
      await releaseDatabaseOperationLock(release, 20);
      assert.deepEqual(await databaseProtocolArtifacts(lockFile), []);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

test('restart recovery classifies failed local-child publication as manual child recovery', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-child-publish-failure-'));
  const lockFile = path.join(directory, 'database.lock');
  try {
    const release = await acquireDatabaseOperationLock(lockFile, {
      fileSystem: localChildPublicationFailureFileSystem(),
    });
    await assert.rejects(beginDatabaseOperationLocalChildHold(release, {
      commandLabel: 'docker fixture command',
    }), /simulated local-child publication link failure/u);
    const recovery = await openDatabaseOperationLockProtocolRecovery({
      lockFile,
      processLivenessProbe: async () => false,
    });
    assert.equal(recovery.phase, 'local-child');
    await assert.rejects(recovery.recover(), (error) => {
      assert.equal(error.code, 'DATABASE_OPERATION_LOCK_LOCAL_CHILD_HOLD_REQUIRES_MANUAL_RECOVERY');
      assert.match(error.recoveryAuthority?.holdFile || '', /\.local-child-.*\.tmp$/u);
      assert.match(error.recoveryAuthority?.holdToken || '', /^[0-9a-f]{64}$/u);
      return true;
    });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('restart recovery classifies a crash after local-child claim as manual child recovery',
  async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-child-claim-crash-'));
    const lockFile = path.join(directory, 'database.lock');
    try {
      const injected = localChildClaimCrashFileSystem();
      const release = await acquireDatabaseOperationLock(lockFile, {
        fileSystem: injected.fileSystem,
      });
      const hold = await beginDatabaseOperationLocalChildHold(release, {
        commandLabel: 'docker fixture command',
      });
      await assert.rejects(hold.release(), /simulated crash after local-child claim/u);
      assert.ok(injected.claimFile());
      const recovery = await openDatabaseOperationLockProtocolRecovery({
        lockFile,
        processLivenessProbe: async () => false,
      });
      assert.equal(recovery.phase, 'local-child');
      await assert.rejects(recovery.recover(), (error) => {
        assert.equal(error.code,
          'DATABASE_OPERATION_LOCK_LOCAL_CHILD_HOLD_REQUIRES_MANUAL_RECOVERY');
        assert.equal(error.recoveryAuthority?.holdFile, injected.claimFile());
        assert.equal(error.recoveryAuthority?.holdToken, hold.holdToken);
        return true;
      });
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

test('restart recovery classifies a local-child delete quarantine as manual child recovery',
  async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-child-quarantine-'));
    const lockFile = path.join(directory, 'database.lock');
    try {
      const injected = localChildQuarantineCrashFileSystem();
      const release = await acquireDatabaseOperationLock(lockFile, {
        fileSystem: injected.fileSystem,
      });
      const hold = await beginDatabaseOperationLocalChildHold(release, {
        commandLabel: 'docker fixture command',
      });
      await assert.rejects(hold.release(), /simulated crash after local-child delete quarantine/u);
      assert.ok(injected.quarantineFile());
      const recovery = await openDatabaseOperationLockProtocolRecovery({
        lockFile,
        processLivenessProbe: async () => false,
      });
      assert.equal(recovery.phase, 'local-child');
      await assert.rejects(recovery.recover(), (error) => {
        assert.equal(error.code,
          'DATABASE_OPERATION_LOCK_LOCAL_CHILD_HOLD_REQUIRES_MANUAL_RECOVERY');
        assert.equal(error.recoveryAuthority?.holdFile, injected.quarantineFile());
        assert.equal(error.recoveryAuthority?.holdToken, hold.holdToken);
        return true;
      });
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

test('restart recovery cannot clear a durable local-child hold after its owner dies', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-child-hold-recovery-'));
  const lockFile = path.join(directory, 'database.lock');
  try {
    const release = await acquireDatabaseOperationLock(lockFile);
    const hold = await beginDatabaseOperationLocalChildHold(release, {
      commandLabel: 'docker fixture command',
    });
    const recovery = await openDatabaseOperationLockProtocolRecovery({
      lockFile,
      processLivenessProbe: async () => false,
    });

    await assert.rejects(recovery.recover(), (error) => {
      assert.equal(error.code, 'DATABASE_OPERATION_LOCK_LOCAL_CHILD_HOLD_REQUIRES_MANUAL_RECOVERY');
      assert.equal(error.recoveryAuthority?.holdFile, hold.holdFile);
      assert.equal(error.recoveryAuthority?.holdToken, hold.holdToken);
      return true;
    });
    assert.ok((await databaseProtocolArtifacts(lockFile)).some(
      (entry) => entry.includes('.local-child-'),
    ), 'restart recovery must leave the exact local-child hold intact');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('typed local-child recovery atomically resumes as retained import evidence', async () => {
  const directory = await fs.mkdtemp(path.join(
    TEST_DIRECTORY,
    '.database-local-child-recovery-',
  ));
  try {
    const lockFile = path.join(directory, 'database-operation.lock');
    const release = await acquireDatabaseOperationLock(lockFile);
    await beginDatabaseOperationLocalChildHold(release, {
      commandLabel: 'docker compose fixture',
    });
    const hold = describeDatabaseOperationLocalChildHold(release);
    const workingDirectory = path.resolve('.');
    const controlKey = `database:${workingDirectory}:docker`;
    const controlDirectory = path.join(
      directory,
      createHash('sha256').update(controlKey, 'utf8').digest('hex'),
    );
    const destinations = ['ready.proof', 'term.request', 'kill.request']
      .map((name) => path.join(controlDirectory, name));
    const localChildRecovery = createProductionImportLocalChildRecovery({
      controlDirectory,
      publicationResidues: destinations.map((destination, index) => ({
        destination,
        sourceBinding: SYNTHETIC_POSIX_PUBLICATION_SOURCE_BINDING,
        temporary: path.join(
          path.dirname(controlDirectory),
          `.${path.basename(controlDirectory)}.${path.basename(destination)}.${String(index + 5).repeat(32)}.tmp`,
        ),
      })),
    }, hold);
    const operationToken = '12345678-1234-4abc-8def-1234567890ab';
    const evidence = {
      applicationName: `easyboost_import_${operationToken}`,
      importContainerId: 'unknown',
      kind: 'import',
      lastProbe: { activityCount: 'unknown', process: 'UNKNOWN', status: 'UNKNOWN' },
      localChildRecovery,
      operationToken,
      ownershipToken: '4'.repeat(64),
      postgresContainerId: 'unknown',
    };
    const hostLockDirectory = path.join(directory, 'host-operation.lock');
    const hostRelease = await acquireHostOperationLock({
      lockDirectory: hostLockDirectory,
      operation: 'database-import',
    });
    await retainHostOperationLock(hostRelease, 2_000, {
      ...evidence,
      retentionReason: PRODUCTION_IMPORT_LOCAL_CHILD_RETENTION_REASON,
    });
    await assert.rejects(acquireHostOperationLock({
      lockDirectory: hostLockDirectory,
      operation: 'production-app-lifecycle',
    }), /HOST_OPERATION_LOCK/u);
    const hostGuard = await openRetainedHostOperationLock({
      expectedOperation: 'database-import',
      lockDirectory: hostLockDirectory,
    });
    assert.deepEqual(hostGuard.evidence, evidence);
    assert.equal(hostGuard.reason, PRODUCTION_IMPORT_LOCAL_CHILD_RETENTION_REASON);

    const transition = await retainDatabaseOperationLocalChildRecovery({
      expectedLocalChildRecovery: localChildRecovery,
      lockFile,
      processLivenessProbe: async () => false,
      reason: PRODUCTION_IMPORT_LOCAL_CHILD_RETENTION_REASON,
      recoveryEvidence: evidence,
    });

    assert.equal(transition.state, 'retained');
    assert.equal(transition.retained.reason, PRODUCTION_IMPORT_LOCAL_CHILD_RETENTION_REASON);
    assert.deepEqual(transition.retained.evidence, evidence);
    assert.deepEqual(await databaseProtocolArtifacts(lockFile), [
      'database-operation.lock',
      'database-operation.lock.authority',
    ]);
    await transition.retained.complete();
    await hostGuard.complete();
    assert.deepEqual(await databaseProtocolArtifacts(lockFile), []);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('post-link directory durability failure leaves named recoverable ACTIVE authority',
  async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-lock-durability-'));
    const lockFile = path.join(directory, '.easyboost-database-operation.lock');
    try {
      await assert.rejects(acquireDatabaseOperationLock(lockFile, {
        fileSystem: unsupportedDirectorySyncFileSystem(directory),
      }), (error) => {
        assert.equal(error.code, 'DATABASE_OPERATION_LOCK_ACQUIRE_DURABILITY_UNPROVEN');
        assert.equal(error.recoveryAuthority?.lockFile, lockFile);
        assert.equal(error.recoveryAuthority?.authorityFile, `${lockFile}.authority`);
        return true;
      });
      assert.match(await fs.readFile(lockFile, 'utf8'), /^ACTIVE\n/u);
      assert.match(await fs.readFile(`${lockFile}.authority`, 'utf8'), /^ACTIVE\n/u);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

test('database lock absence proof rejects marker, authority and pending protocol state', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-lock-absence-'));
  const lockFile = path.join(directory, '.easyboost-database-operation.lock');
  try {
    const lockModule = await import('../scripts/database-operation-lock.js');
    assert.equal(typeof lockModule.proveDatabaseOperationLockAbsent, 'function');
    await fs.writeFile(`${lockFile}.authority`, 'ACTIVE\n', { mode: 0o600 });
    await assert.rejects(lockModule.proveDatabaseOperationLockAbsent({ lockFile }),
      /DATABASE_OPERATION_LOCK_NOT_ABSENT/u);
    await fs.rm(`${lockFile}.authority`);
    const pendingFile = `${lockFile}.retained-pending.tmp`;
    await fs.writeFile(pendingFile, 'pending\n', { mode: 0o600 });
    await assert.rejects(lockModule.proveDatabaseOperationLockAbsent({ lockFile }),
      /DATABASE_OPERATION_LOCK_NOT_ABSENT/u);
    await fs.rm(pendingFile);
    const proof = await lockModule.proveDatabaseOperationLockAbsent({ lockFile });
    assert.equal(proof.absent, true);
    assert.equal(proof.lockFile, lockFile);
    assert.equal(typeof proof.release, 'function');
    await assert.rejects(acquireDatabaseOperationLock(lockFile), /DATABASE_OPERATION_LOCKED/u,
      'the absence lease must close the acquire race until its caller releases the host guard');
    await proof.release();
    const releaseNext = await acquireDatabaseOperationLock(lockFile);
    await releaseDatabaseOperationLock(releaseNext, 100);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('a typed absence lease can be reopened after a process restart and released', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-lock-lease-reopen-'));
  const lockFile = path.join(directory, '.easyboost-database-operation.lock');
  try {
    const lockModule = await import('../scripts/database-operation-lock.js');
    const originalProcessLease = await lockModule.proveDatabaseOperationLockAbsent({ lockFile });
    assert.match(await fs.readFile(lockFile, 'utf8'), /^ABSENCE_LEASE\n/u);

    const reopenedLease = await lockModule.openDatabaseOperationLockAbsenceProof({
      lockFile,
      processLivenessProbe: async () => false,
    });
    await reopenedLease.release();
    await assert.rejects(originalProcessLease.release(),
      /DATABASE_OPERATION_LOCK_OWNERSHIP_CHANGED/u);
    const nextLease = await lockModule.proveDatabaseOperationLockAbsent({ lockFile });
    await nextLease.release();
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('cleanup-pending absence lease is reopenable after host completion and process restart',
  async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-lock-lease-cleanup-'));
    const lockFile = path.join(directory, '.easyboost-database-operation.lock');
    const fileSystem = claimedCleanupFaultFileSystem('absence-release');
    try {
      const lockModule = await import('../scripts/database-operation-lock.js');
      const lease = await lockModule.proveDatabaseOperationLockAbsent({ fileSystem, lockFile });
      await assert.rejects(lease.release(),
        /simulated absence-release claimed authority cleanup failure/u);

      const restartedLease = await lockModule.openDatabaseOperationLockAbsenceProof({
        fileSystem,
        lockFile,
      });
      await restartedLease.release();
      const finalLease = await lockModule.proveDatabaseOperationLockAbsent({ fileSystem, lockFile });
      await finalLease.release();
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

test('absence reopen rejects matching bytes on a different hardlink identity', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-lock-lease-identity-'));
  const lockFile = path.join(directory, '.easyboost-database-operation.lock');
  const authorityFile = `${lockFile}.authority`;
  try {
    const lockModule = await import('../scripts/database-operation-lock.js');
    await lockModule.proveDatabaseOperationLockAbsent({ lockFile });
    const authorityBytes = await fs.readFile(authorityFile);
    await fs.rename(authorityFile, `${authorityFile}.original`);
    await fs.writeFile(authorityFile, authorityBytes, { flag: 'wx', mode: 0o600 });
    await fs.rm(`${authorityFile}.original`);
    await assert.rejects(lockModule.openDatabaseOperationLockAbsenceProof({ lockFile }),
      /DATABASE_OPERATION_LOCK_OWNERSHIP_CHANGED/u);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('absence reopen requires canonical and cleanup claim snapshots to be one hardlink', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-lock-claim-identity-'));
  const lockFile = path.join(directory, '.easyboost-database-operation.lock');
  const claimFile = `${lockFile}.absence-release-marker-${process.pid}-${'9'.repeat(64)}.claimed`;
  try {
    const lockModule = await import('../scripts/database-operation-lock.js');
    await lockModule.proveDatabaseOperationLockAbsent({ lockFile });
    const markerBytes = await fs.readFile(lockFile);
    await fs.rename(lockFile, path.join(directory, 'exact-owner'));
    await fs.writeFile(claimFile, markerBytes, { flag: 'wx', mode: 0o600 });
    await assert.rejects(lockModule.openDatabaseOperationLockAbsenceProof({ lockFile }),
      /DATABASE_OPERATION_LOCK_OWNERSHIP_CHANGED/u);
    assert.deepEqual(await fs.readFile(claimFile), markerBytes);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('generic restart recovery settles every acquisition, release, and completion claim phase',
  async (t) => {
    const cases = [
      {
        name: 'partial acquisition temporary marker',
        expectedPhase: 'acquisition',
        async setup(lockFile) {
          await fs.writeFile(`${lockFile}.active-${process.pid}-${'a'.repeat(64)}.tmp`, 'ACT', {
            flag: 'wx',
            mode: 0o600,
          });
        },
      },
      {
        name: 'acquisition after authority hardlink and before canonical hardlink',
        expectedPhase: 'acquisition',
        async setup(lockFile) {
          await acquireDatabaseOperationLock(lockFile);
          await fs.link(lockFile, `${lockFile}.active-${process.pid}-${'0'.repeat(64)}.tmp`);
          await fs.rm(lockFile);
        },
      },
      {
        name: 'failed acquisition after authority entered cleanup claim',
        expectedPhase: 'acquisition',
        async setup(lockFile) {
          await acquireDatabaseOperationLock(lockFile);
          await fs.link(lockFile, `${lockFile}.active-${process.pid}-${'a'.repeat(64)}.tmp`);
          await fs.rm(lockFile);
          await fs.rename(`${lockFile}.authority`,
            `${lockFile}.authority.acquire-cleanup-authority-${process.pid}-${'b'.repeat(64)}.claimed`);
        },
      },
      {
        name: 'acquisition after both hardlinks and before temporary cleanup',
        expectedPhase: 'acquisition',
        async setup(lockFile) {
          await acquireDatabaseOperationLock(lockFile);
          await fs.link(lockFile, `${lockFile}.active-${process.pid}-${'b'.repeat(64)}.tmp`);
        },
      },
      {
        name: 'stable ACTIVE acquired before its owner callback was returned',
        expectedPhase: 'active',
        async setup(lockFile) {
          await acquireDatabaseOperationLock(lockFile);
        },
      },
      {
        name: 'release after marker claim',
        expectedPhase: 'release',
        async setup(lockFile) {
          await acquireDatabaseOperationLock(lockFile);
          await fs.rename(lockFile, `${lockFile}.release-marker-${process.pid}-${'c'.repeat(64)}.claimed`);
        },
      },
      {
        name: 'release after both claims',
        expectedPhase: 'release',
        async setup(lockFile) {
          await acquireDatabaseOperationLock(lockFile);
          await fs.rename(lockFile, `${lockFile}.release-marker-${process.pid}-${'d'.repeat(64)}.claimed`);
          await fs.rename(`${lockFile}.authority`,
            `${lockFile}.authority.release-authority-${process.pid}-${'e'.repeat(64)}.claimed`);
        },
      },
      {
        name: 'release after marker claim cleanup but before authority claim cleanup',
        expectedPhase: 'release',
        async setup(lockFile) {
          await acquireDatabaseOperationLock(lockFile);
          const markerClaim = `${lockFile}.release-marker-${process.pid}-${'a'.repeat(64)}.claimed`;
          await fs.rename(lockFile, markerClaim);
          await fs.rename(`${lockFile}.authority`,
            `${lockFile}.authority.release-authority-${process.pid}-${'b'.repeat(64)}.claimed`);
          await fs.rm(markerClaim);
        },
      },
      {
        name: 'release after exact claim entered deletion quarantine',
        expectedPhase: 'release',
        async setup(lockFile) {
          await acquireDatabaseOperationLock(lockFile);
          const claim = `${lockFile}.release-marker-${process.pid}-${'f'.repeat(64)}.claimed`;
          await fs.rename(lockFile, claim);
          await fs.rename(claim, `${claim}.delete-${'1'.repeat(64)}.quarantine`);
        },
      },
      {
        name: 'retained completion after marker claim',
        expectedPhase: 'completion',
        async setup(lockFile) {
          const release = await acquireDatabaseOperationLock(lockFile);
          await retainDatabaseOperationLock(release, 100,
            'REMOTE_RESTORE_SETTLEMENT_UNPROVEN', restoreEvidence());
          await fs.rename(lockFile,
            `${lockFile}.complete-marker-${process.pid}-${'2'.repeat(64)}.claimed`);
        },
      },
      {
        name: 'retained completion after both claims',
        expectedPhase: 'completion',
        async setup(lockFile) {
          const release = await acquireDatabaseOperationLock(lockFile);
          await retainDatabaseOperationLock(release, 100,
            'REMOTE_RESTORE_SETTLEMENT_UNPROVEN', restoreEvidence());
          await fs.rename(lockFile,
            `${lockFile}.complete-marker-${process.pid}-${'3'.repeat(64)}.claimed`);
          await fs.rename(`${lockFile}.authority`,
            `${lockFile}.authority.complete-authority-${process.pid}-${'4'.repeat(64)}.claimed`);
        },
      },
      {
        name: 'retained completion after evidence claim cleanup',
        expectedPhase: 'completion',
        async setup(lockFile) {
          const release = await acquireDatabaseOperationLock(lockFile);
          await retainDatabaseOperationLock(release, 100,
            'REMOTE_RESTORE_SETTLEMENT_UNPROVEN', restoreEvidence());
          const markerClaim = `${lockFile}.complete-marker-${process.pid}-${'c'.repeat(64)}.claimed`;
          await fs.rename(lockFile, markerClaim);
          await fs.rename(`${lockFile}.authority`,
            `${lockFile}.authority.complete-authority-${process.pid}-${'d'.repeat(64)}.claimed`);
          await fs.rm(markerClaim);
        },
      },
    ];

    for (const fixture of cases) {
      await t.test(fixture.name, async () => {
        const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-protocol-reopen-'));
        const lockFile = path.join(directory, '.easyboost-database-operation.lock');
        try {
          await fixture.setup(lockFile);
          const recovery = await openDatabaseOperationLockProtocolRecovery({
            lockFile,
            processLivenessProbe: async () => false,
          });
          assert.equal(recovery.phase, fixture.expectedPhase);
          assert.equal((await recovery.recover()).state, 'absent');
          assert.deepEqual(await databaseProtocolArtifacts(lockFile), []);
        } finally {
          await fs.rm(directory, { recursive: true, force: true });
        }
      });
    }
  });

test('generic restart recovery finishes or rolls back every durable retention transition phase',
  async (t) => {
    const cases = [
      { name: 'retained temp before ACTIVE claim', claim: false, commit: false, removeTemp: false },
      { name: 'ACTIVE claim before retained commit', claim: true, commit: false, removeTemp: false },
      { name: 'retained commit before temp cleanup', claim: true, commit: true, removeTemp: false },
      { name: 'retained commit before ACTIVE claim cleanup', claim: true, commit: true, removeTemp: true },
    ];
    for (const fixture of cases) {
      await t.test(fixture.name, async () => {
        const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-retain-reopen-'));
        const lockFile = path.join(directory, '.easyboost-database-operation.lock');
        const retainedTemp = `${lockFile}.retained-${process.pid}-${'5'.repeat(64)}.tmp`;
        const activeClaim = `${lockFile}.retain-active-${process.pid}-${'6'.repeat(64)}.claimed`;
        try {
          await acquireDatabaseOperationLock(lockFile);
          const activeMarker = await fs.readFile(lockFile);
          await fs.writeFile(retainedTemp, retainedMarkerForActive(activeMarker), {
            flag: 'wx',
            mode: 0o600,
          });
          if (fixture.claim) await fs.rename(lockFile, activeClaim);
          if (fixture.commit) await fs.link(retainedTemp, lockFile);
          if (fixture.removeTemp) await fs.rm(retainedTemp);

          const recovery = await openDatabaseOperationLockProtocolRecovery({
            expectedEvidenceKind: 'restore',
            lockFile,
            processLivenessProbe: async () => false,
          });
          assert.equal(recovery.phase, 'retention');
          assert.equal((await recovery.recover()).state, 'retained');
          const retained = await openRetainedDatabaseOperationLock({
            expectedEvidenceKind: 'restore',
            lockFile,
          });
          assert.deepEqual(retained.evidence, restoreEvidence());
          await retained.complete();
          assert.deepEqual(await databaseProtocolArtifacts(lockFile), []);
        } finally {
          await fs.rm(directory, { recursive: true, force: true });
        }
      });
    }

    for (const claim of [false, true]) {
      await t.test(`partial retained temp ${claim ? 'after' : 'before'} ACTIVE claim`, async () => {
        const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-retain-partial-'));
        const lockFile = path.join(directory, '.easyboost-database-operation.lock');
        const retainedTemp = `${lockFile}.retained-${process.pid}-${'7'.repeat(64)}.tmp`;
        try {
          await acquireDatabaseOperationLock(lockFile);
          const activeMarker = await fs.readFile(lockFile);
          await fs.writeFile(retainedTemp, 'RETAINED\nprotocol=', { flag: 'wx', mode: 0o600 });
          if (claim) {
            await fs.rename(lockFile,
              `${lockFile}.retain-active-${process.pid}-${'8'.repeat(64)}.claimed`);
          }
          const recovery = await openDatabaseOperationLockProtocolRecovery({
            lockFile,
            processLivenessProbe: async () => false,
          });
          assert.equal(recovery.phase, 'retention');
          assert.equal((await recovery.recover()).state, 'active');
          assert.deepEqual(await fs.readFile(lockFile), activeMarker);
          const activeRecovery = await openDatabaseOperationLockProtocolRecovery({
            lockFile,
            processLivenessProbe: async () => false,
          });
          assert.equal(activeRecovery.phase, 'active');
          assert.equal((await activeRecovery.recover()).state, 'absent');
          assert.deepEqual(await databaseProtocolArtifacts(lockFile), []);
        } finally {
          await fs.rm(directory, { recursive: true, force: true });
        }
      });
    }
  });

test('zero-byte public temporary markers remain generically recoverable after cleanup crash',
  async (t) => {
    await t.test('acquisition', async () => {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-zero-active-'));
      const lockFile = path.join(directory, '.easyboost-database-operation.lock');
      try {
        await assert.rejects(acquireDatabaseOperationLock(lockFile, {
          fileSystem: zeroByteCrashFileSystem('active'),
        }), /temporary marker cleanup failed/u);
        const recovery = await openDatabaseOperationLockProtocolRecovery({ lockFile });
        assert.equal(recovery.phase, 'acquisition');
        assert.equal((await recovery.recover()).state, 'absent');
        assert.deepEqual(await databaseProtocolArtifacts(lockFile), []);
      } finally {
        await fs.rm(directory, { recursive: true, force: true });
      }
    });

    await t.test('retention', async () => {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-zero-retained-'));
      const lockFile = path.join(directory, '.easyboost-database-operation.lock');
      const fileSystem = zeroByteCrashFileSystem('retained');
      try {
        const releaseOwner = await acquireDatabaseOperationLock(lockFile, { fileSystem });
        await assert.rejects(retainDatabaseOperationLock(
          releaseOwner,
          10,
          'REMOTE_RESTORE_SETTLEMENT_UNPROVEN',
          restoreEvidence(),
        ), /temporary marker cleanup failed/u);
        const recovery = await openDatabaseOperationLockProtocolRecovery({
          lockFile,
          processLivenessProbe: async () => false,
        });
        assert.equal(recovery.phase, 'retention');
        assert.equal((await recovery.recover()).state, 'active');
        const activeRecovery = await openDatabaseOperationLockProtocolRecovery({
          lockFile,
          processLivenessProbe: async () => false,
        });
        assert.equal((await activeRecovery.recover()).state, 'absent');
        assert.deepEqual(await databaseProtocolArtifacts(lockFile), []);
      } finally {
        await fs.rm(directory, { recursive: true, force: true });
      }
    });

    await t.test('absence', async () => {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-zero-absence-'));
      const lockFile = path.join(directory, '.easyboost-database-operation.lock');
      try {
        await assert.rejects(proveDatabaseOperationLockAbsent({
          fileSystem: zeroByteCrashFileSystem('absence'),
          lockFile,
        }), /temporary marker cleanup failed/u);
        const recovery = await openDatabaseOperationLockProtocolRecovery({ lockFile });
        assert.equal(recovery.phase, 'absence');
        assert.equal((await recovery.recover()).state, 'absent');
        assert.deepEqual(await databaseProtocolArtifacts(lockFile), []);
      } finally {
        await fs.rm(directory, { recursive: true, force: true });
      }
    });
  });

test('retention recovery cannot mutate a paused partial write owned by a live process', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-live-retention-'));
  const lockFile = path.join(directory, '.easyboost-database-operation.lock');
  const pausedWrite = pausedRetainedWriteFileSystem();
  let retainPromise;
  let resumed = false;
  try {
    const releaseOwner = await acquireDatabaseOperationLock(lockFile, {
      fileSystem: pausedWrite.fileSystem,
    });
    retainPromise = retainDatabaseOperationLock(
      releaseOwner,
      10,
      'REMOTE_RESTORE_SETTLEMENT_UNPROVEN',
      restoreEvidence(),
    );
    await pausedWrite.paused;

    const beforeNames = (await databaseProtocolArtifacts(lockFile)).sort();
    const before = new Map(await Promise.all(beforeNames.map(async (name) => {
      const file = path.join(directory, name);
      return [name, {
        bytes: await fs.readFile(file),
        stat: await fs.stat(file, { bigint: true }),
      }];
    })));
    let probedPid;
    const recovery = await openDatabaseOperationLockProtocolRecovery({
      lockFile,
      processLivenessProbe: async (ownerPid) => {
        probedPid = ownerPid;
        return true;
      },
    });
    assert.equal(recovery.phase, 'retention');
    await assert.rejects(recovery.recover(), (error) => {
      assert.equal(error.code, 'DATABASE_OPERATION_LOCK_OWNER_STILL_ACTIVE');
      return true;
    });
    assert.equal(probedPid, process.pid);

    const afterNames = (await databaseProtocolArtifacts(lockFile)).sort();
    assert.deepEqual(afterNames, beforeNames);
    for (const name of afterNames) {
      const file = path.join(directory, name);
      const snapshot = before.get(name);
      const stat = await fs.stat(file, { bigint: true });
      assert.equal(stat.dev, snapshot.stat.dev);
      assert.equal(stat.ino, snapshot.stat.ino);
      assert.deepEqual(await fs.readFile(file), snapshot.bytes);
    }

    pausedWrite.resume();
    resumed = true;
    await retainPromise;
    const retained = await openRetainedDatabaseOperationLock({
      expectedEvidenceKind: 'restore',
      lockFile,
    });
    await retained.complete();
    assert.deepEqual(await databaseProtocolArtifacts(lockFile), []);
  } finally {
    if (!resumed) pausedWrite.resume();
    await retainPromise?.catch(() => {});
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('generic recovery cannot revoke a live ACTIVE owner or its callback authority', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-live-active-'));
  const lockFile = path.join(directory, '.easyboost-database-operation.lock');
  try {
    const releaseOwner = await acquireDatabaseOperationLock(lockFile);
    let probedPid;
    const recovery = await openDatabaseOperationLockProtocolRecovery({
      lockFile,
      processLivenessProbe: async (ownerPid) => {
        probedPid = ownerPid;
        return true;
      },
    });
    await assert.rejects(recovery.recover(), (error) => {
      assert.equal(error.code, 'DATABASE_OPERATION_LOCK_OWNER_STILL_ACTIVE');
      return true;
    });
    assert.equal(probedPid, process.pid);
    await assert.rejects(acquireDatabaseOperationLock(lockFile), /DATABASE_OPERATION_LOCKED/u);
    await releaseDatabaseOperationLock(releaseOwner, 10);
    assert.deepEqual(await databaseProtocolArtifacts(lockFile), []);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('generic recovery accepts positive terminated-owner proof for stable ACTIVE authority',
  async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-terminated-active-'));
    const lockFile = path.join(directory, '.easyboost-database-operation.lock');
    try {
      await acquireDatabaseOperationLock(lockFile);
      const recovery = await openDatabaseOperationLockProtocolRecovery({
        lockFile,
        processLivenessProbe: async () => false,
      });
      assert.equal((await recovery.recover()).state, 'absent');
      assert.deepEqual(await databaseProtocolArtifacts(lockFile), []);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

test('live absence lease cannot be reopened or generically revoked', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-live-absence-'));
  const lockFile = path.join(directory, '.easyboost-database-operation.lock');
  const lockModule = await import('../scripts/database-operation-lock.js');
  try {
    const lease = await proveDatabaseOperationLockAbsent({ lockFile });
    const liveness = { processLivenessProbe: async () => true };
    await assert.rejects(lockModule.openDatabaseOperationLockAbsenceProof({
      lockFile,
    }), (error) => {
      assert.equal(error.code, 'DATABASE_OPERATION_LOCK_OWNER_STILL_ACTIVE');
      return true;
    });
    const recovery = await openDatabaseOperationLockProtocolRecovery({ ...liveness, lockFile });
    await assert.rejects(recovery.recover(), (error) => {
      assert.equal(error.code, 'DATABASE_OPERATION_LOCK_OWNER_STILL_ACTIVE');
      return true;
    });
    await lease.release();
    assert.deepEqual(await databaseProtocolArtifacts(lockFile), []);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('ordinary release, retained completion and absence release do not consume retirement capacity',
  async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-routine-retirement-'));
    const lockFile = path.join(directory, '.easyboost-database-operation.lock');
    const lockModule = await import('../scripts/database-operation-lock.js');
    try {
      const cycles = lockModule.DATABASE_OPERATION_LOCK_RETIREMENT_CAPACITY + 1;
      for (let index = 0; index < cycles; index += 1) {
        const releaseOwner = await acquireDatabaseOperationLock(lockFile);
        await releaseDatabaseOperationLock(releaseOwner, 10);

        const retainedOwner = await acquireDatabaseOperationLock(lockFile);
        await retainDatabaseOperationLock(
          retainedOwner,
          10,
          'REMOTE_RESTORE_SETTLEMENT_UNPROVEN',
          restoreEvidence(),
        );
        const retained = await openRetainedDatabaseOperationLock({
          expectedEvidenceKind: 'restore',
          lockFile,
        });
        await retained.complete();

        const absence = await proveDatabaseOperationLockAbsent({ lockFile });
        await absence.release();
      }
      assert.deepEqual(await databaseRetirementArtifacts(lockFile), []);
      assert.deepEqual(await databaseProtocolArtifacts(lockFile), []);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

test('release claims exact authority before a path swap and never deletes the foreign marker',
  async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-release-swap-'));
    const lockFile = path.join(directory, '.easyboost-database-operation.lock');
    const swap = pathSwapFileSystem(lockFile);
    try {
      const releaseOwner = await acquireDatabaseOperationLock(lockFile, {
        fileSystem: swap.fileSystem,
      });
      swap.arm();
      await assert.rejects(releaseDatabaseOperationLock(releaseOwner, 10),
        /DATABASE_OPERATION_LOCK_OWNERSHIP_CHANGED/u);
      assert.deepEqual(await fs.readFile(lockFile), swap.foreignMarker);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

test('claim restoration keeps a named exact claim when canonical authority swaps after sync',
  async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-restore-claim-swap-'));
    const lockFile = path.join(directory, '.easyboost-database-operation.lock');
    const swap = lateRestoreSwapFileSystem(lockFile);
    try {
      const releaseOwner = await acquireDatabaseOperationLock(lockFile, {
        fileSystem: swap.fileSystem,
      });
      swap.arm();
      let recoveryFile;
      await assert.rejects(releaseDatabaseOperationLock(releaseOwner, 10), (error) => {
        assert.equal(error.code, 'DATABASE_OPERATION_LOCK_OWNERSHIP_CHANGED');
        assert.equal(error.recoveryAuthority?.claimedFile, swap.restoredClaimFile());
        recoveryFile = error.recoveryAuthority?.quarantineFile;
        assert.equal(typeof recoveryFile, 'string');
        return true;
      });
      assert.deepEqual(await fs.readFile(lockFile), swap.lateForeignMarker);
      assert.deepEqual(await fs.readFile(recoveryFile), swap.firstForeignMarker,
        'uncertain restoration must retain the exact named quarantine');
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

test('release retries cleanup-pending exact claims until deletion and directory sync settle',
  async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-release-retry-'));
    const lockFile = path.join(directory, '.easyboost-database-operation.lock');
    const fileSystem = claimedCleanupFaultFileSystem('release');
    try {
      const releaseOwner = await acquireDatabaseOperationLock(lockFile, { fileSystem });
      await assert.rejects(releaseDatabaseOperationLock(releaseOwner, 10),
        /simulated release claimed authority cleanup failure/u);
      await releaseDatabaseOperationLock(releaseOwner, 10);
      await assert.rejects(fs.access(lockFile), { code: 'ENOENT' });
      await assert.rejects(fs.access(`${lockFile}.authority`), { code: 'ENOENT' });
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

test('claim deletion quarantines a late foreign swap instead of unlinking it', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-claim-delete-swap-'));
  const lockFile = path.join(directory, '.easyboost-database-operation.lock');
  const swap = claimDeletionSwapFileSystem('release');
  try {
    const releaseOwner = await acquireDatabaseOperationLock(lockFile, {
      fileSystem: swap.fileSystem,
    });
    await assert.rejects(releaseDatabaseOperationLock(releaseOwner, 10),
      /DATABASE_OPERATION_LOCK_OWNERSHIP_CHANGED/u);
    const foreignClaimFile = swap.swappedClaimFile();
    assert.ok(foreignClaimFile);
    assert.deepEqual(await fs.readFile(foreignClaimFile), swap.foreignMarker);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('final quarantine destruction never unlinks a replacement foreign file', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-quarantine-destroy-swap-'));
  const lockFile = path.join(directory, '.easyboost-database-operation.lock');
  const swap = quarantineDestructionSwapFileSystem('release');
  try {
    const releaseOwner = await acquireDatabaseOperationLock(lockFile, {
      fileSystem: swap.fileSystem,
    });
    let retiredExactFile;
    await assert.rejects(releaseDatabaseOperationLock(releaseOwner, 10), (error) => {
      assert.equal(error.code, 'DATABASE_OPERATION_LOCK_OWNERSHIP_CHANGED');
      retiredExactFile = error.recoveryAuthority?.retiredExactFile;
      assert.equal(typeof retiredExactFile, 'string');
      return true;
    });
    assert.deepEqual(await fs.readFile(swap.quarantineFile()), swap.foreignMarker,
      'the replacement foreign file must be restored, not unlinked');
    assert.match(await fs.readFile(retiredExactFile, 'utf8'), /^ACTIVE\n/u,
      'the exact ACTIVE inode must retain a named retirement authority');
    await fs.access(swap.displacedExactFile());
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('exclusive retirement evidence capture never overwrites an occupied generated destination',
  async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-retirement-destination-'));
    const lockFile = path.join(directory, '.easyboost-database-operation.lock');
    const injected = occupiedRetirementCaptureFileSystem();
    try {
      const releaseOwner = await acquireDatabaseOperationLock(lockFile, {
        fileSystem: injected.fileSystem,
      });
      injected.arm();
      let exactQuarantine;
      await assert.rejects(releaseDatabaseOperationLock(releaseOwner, 10), (error) => {
        exactQuarantine = error.recoveryAuthority?.quarantineFile;
        assert.equal(typeof exactQuarantine, 'string');
        return true;
      });
      assert.deepEqual(await fs.readFile(injected.foreignFile()), injected.foreignBytes);
      assert.match(await fs.readFile(exactQuarantine, 'utf8'), /^ACTIVE\n/u,
        'failed no-replace capture must leave the exact authority named for recovery');
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

test('retirement refuses an occupied private move destination without overwriting it', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-retirement-move-'));
  const lockFile = path.join(directory, '.easyboost-database-operation.lock');
  const injected = occupiedRetirementCaptureFileSystem('captured');
  try {
    const releaseOwner = await acquireDatabaseOperationLock(lockFile, {
      fileSystem: injected.fileSystem,
    });
    injected.arm();
    let exactQuarantine;
    let retiredExactFile;
    await assert.rejects(releaseDatabaseOperationLock(releaseOwner, 10), (error) => {
      assert.equal(error.code, 'DATABASE_OPERATION_LOCK_RETIREMENT_DESTINATION_OCCUPIED');
      exactQuarantine = error.recoveryAuthority?.quarantineFile;
      retiredExactFile = error.recoveryAuthority?.retiredExactFile;
      assert.equal(typeof exactQuarantine, 'string');
      assert.equal(typeof retiredExactFile, 'string');
      return true;
    });
    assert.deepEqual(await fs.readFile(injected.foreignFile()), injected.foreignBytes);
    assert.match(await fs.readFile(exactQuarantine, 'utf8'), /^ACTIVE\n/u);
    assert.match(await fs.readFile(retiredExactFile, 'utf8'), /^ACTIVE\n/u);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('release retry settles a quarantine left by immediate parent-directory sync failure',
  async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-quarantine-sync-retry-'));
    const lockFile = path.join(directory, '.easyboost-database-operation.lock');
    const fileSystem = quarantineDirectorySyncFaultFileSystem('release');
    try {
      const releaseOwner = await acquireDatabaseOperationLock(lockFile, { fileSystem });
      await assert.rejects(releaseDatabaseOperationLock(releaseOwner, 10), (error) => {
        const failures = [
          error,
          error.cause,
          ...(error.errors || []),
          ...(error.cause?.errors || []),
        ].filter(Boolean);
        assert.ok(failures.some((failure) => (
          /simulated release quarantine directory sync failure/u.test(failure.message)
        )));
        return true;
      });
      assert.ok((await databaseProtocolArtifacts(lockFile)).some((entry) => (
        entry.endsWith('.quarantine')
      )));

      await releaseDatabaseOperationLock(releaseOwner, 10);
      assert.deepEqual(await databaseProtocolArtifacts(lockFile), [],
        'successful retry must leave no canonical, claim, temp, or quarantine protocol artifact');
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

test('retirement storage is finitely capped and new authority fails closed at capacity', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-retirement-cap-'));
  const lockFile = path.join(directory, '.easyboost-database-operation.lock');
  try {
    const lockModule = await import('../scripts/database-operation-lock.js');
    const capacity = lockModule.DATABASE_OPERATION_LOCK_RETIREMENT_CAPACITY;
    assert.ok(Number.isSafeInteger(capacity) && capacity >= 8 && capacity <= 256);
    const prefix = `${path.basename(lockFile)}-retired-`;
    for (let index = 0; index < capacity; index += 1) {
      await fs.mkdir(path.join(directory, `${prefix}${String(index).padStart(3, '0')}`));
    }

    await assert.rejects(acquireDatabaseOperationLock(lockFile), (error) => {
      assert.equal(error.code, 'DATABASE_OPERATION_LOCK_RETIREMENT_CAPACITY_EXHAUSTED');
      return true;
    });
    assert.deepEqual(await databaseProtocolArtifacts(lockFile), []);
    assert.equal((await fs.readdir(directory)).length, capacity,
      'capacity exhaustion must not create an unbounded spill name');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('retirement slot creation is durable in its outer parent before slot contents', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-retirement-parent-sync-'));
  const lockFile = path.join(directory, '.easyboost-database-operation.lock');
  const fileSystem = retirementSlotParentSyncFileSystem(lockFile);
  try {
    const releaseOwner = await acquireDatabaseOperationLock(lockFile, { fileSystem });
    await releaseDatabaseOperationLock(releaseOwner, 10);
    assert.ok(fileSystem.synchronizedSlots() >= 2,
      'both marker and authority retirement slots must be durable before receiving contents');
    assert.deepEqual(await databaseProtocolArtifacts(lockFile), []);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('verified retirement reclamation remains retryable through removal and parent-sync faults',
  async (t) => {
    for (const fault of ['remove', 'sync']) {
      await t.test(fault, async () => {
        const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-retirement-retry-'));
        const lockFile = path.join(directory, '.easyboost-database-operation.lock');
        const injected = retirementReclaimFaultFileSystem(fault);
        try {
          const releaseOwner = await acquireDatabaseOperationLock(lockFile, {
            fileSystem: injected.fileSystem,
          });
          injected.arm();
          await assert.rejects(releaseDatabaseOperationLock(releaseOwner, 10),
            /simulated retirement reclaim/u);
          await releaseDatabaseOperationLock(releaseOwner, 10);
          assert.deepEqual(await databaseProtocolArtifacts(lockFile), []);
          assert.deepEqual(await databaseRetirementArtifacts(lockFile), []);
        } finally {
          await fs.rm(directory, { recursive: true, force: true });
        }
      });
    }
  });

test('retention claims ACTIVE authority before commit and never overwrites a foreign marker',
  async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-retain-swap-'));
    const lockFile = path.join(directory, '.easyboost-database-operation.lock');
    const swap = pathSwapFileSystem(lockFile);
    try {
      const releaseOwner = await acquireDatabaseOperationLock(lockFile, {
        fileSystem: swap.fileSystem,
      });
      swap.arm();
      await assert.rejects(retainDatabaseOperationLock(
        releaseOwner,
        10,
        'REMOTE_RESTORE_SETTLEMENT_UNPROVEN',
        restoreEvidence(),
      ), /DATABASE_OPERATION_LOCK_OWNERSHIP_CHANGED/u);
      assert.deepEqual(await fs.readFile(lockFile), swap.foreignMarker);
      assert.match(await fs.readFile(`${lockFile}.authority`, 'utf8'), /^ACTIVE\n/u);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

test('retention preserves durable evidence when canonical swaps during temporary cleanup',
  async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-retain-cleanup-swap-'));
    const lockFile = path.join(directory, '.easyboost-database-operation.lock');
    const swap = retainedCleanupSwapFileSystem(lockFile);
    try {
      const releaseOwner = await acquireDatabaseOperationLock(lockFile, {
        fileSystem: swap.fileSystem,
      });
      let recoveryFile;
      await assert.rejects(retainDatabaseOperationLock(
        releaseOwner,
        100,
        'REMOTE_RESTORE_SETTLEMENT_UNPROVEN',
        restoreEvidence(),
      ), (error) => {
        assert.equal(error.code, 'DATABASE_OPERATION_LOCK_OWNERSHIP_CHANGED');
        recoveryFile = error.recoveryAuthority?.quarantineFile;
        assert.equal(typeof recoveryFile, 'string');
        return true;
      });
      assert.deepEqual(await fs.readFile(lockFile), swap.foreignMarker);
      assert.match(await fs.readFile(recoveryFile, 'utf8'), /^RETAINED\n/u);
      assert.match(await fs.readFile(`${lockFile}.authority`, 'utf8'), /^ACTIVE\n/u);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

test('shared database operation lock can retain a bounded recovery marker', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-retained-db-lock-'));
  const lockFile = path.join(directory, '.easyboost-database-operation.lock');
  try {
    const releaseOwner = await acquireDatabaseOperationLock(lockFile);
    await retainDatabaseOperationLock(
      releaseOwner,
      100,
      'REMOTE_RESTORE_SETTLEMENT_UNPROVEN',
      {
        applicationName: 'easyboost_restore_12345678-1234-4abc-8def-1234567890ab',
        kind: 'restore',
        lastProbe: { activityCount: 2, process: 'ACTIVE', status: 'RUNNING' },
        operationToken: '12345678-1234-4abc-8def-1234567890ab',
        postgresContainerId: '2'.repeat(64),
      },
    );
    const marker = await fs.readFile(lockFile, 'utf8');
    assert.match(marker, /^RETAINED\nprotocol=easyboost-database-operation-lock-v3\n/u);
    assert.match(marker, /authorityToken=[0-9a-f]{64}\n/u);
    assert.match(marker, /markerSha256=[0-9a-f]{64}\n$/u);
    const retained = await openRetainedDatabaseOperationLock({
      expectedEvidenceKind: 'restore',
      lockFile,
    });
    assert.equal(retained.legacy, false);
    assert.equal(retained.protocol, 'easyboost-database-operation-lock-v3');
    assert.equal(retained.reason, 'REMOTE_RESTORE_SETTLEMENT_UNPROVEN');
    assert.deepEqual(retained.evidence, restoreEvidence());
    await assert.rejects(acquireDatabaseOperationLock(lockFile), /DATABASE_OPERATION_LOCKED/u);
    await assert.rejects(releaseOwner(), /DATABASE_OPERATION_LOCK_RETAINED/u,
      'a retained marker must not be removed by a stale release callback');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('retention ENOSPC after a partial temporary write preserves exact ACTIVE authority',
  async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-retain-enospc-'));
    const lockFile = path.join(directory, '.easyboost-database-operation.lock');
    try {
      const releaseOwner = await acquireDatabaseOperationLock(lockFile, {
        fileSystem: retentionFaultFileSystem('partial-enospc'),
      });
      const activeMarker = await fs.readFile(lockFile);
      assert.match(activeMarker.toString('utf8'), /^ACTIVE\n/u);

      await assert.rejects(retainDatabaseOperationLock(
        releaseOwner,
        100,
        'REMOTE_RESTORE_SETTLEMENT_UNPROVEN',
        restoreEvidence(),
      ), { code: 'ENOSPC' });
      assert.deepEqual(await fs.readFile(lockFile), activeMarker);
      await assert.rejects(acquireDatabaseOperationLock(lockFile), /DATABASE_OPERATION_LOCKED/u);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

test('zero-write, sync and close failures cannot expose a partial RETAINED marker', async (t) => {
  for (const fault of ['zero-write', 'sync', 'close']) {
    await t.test(fault, async () => {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), `easyboost-retain-${fault}-`));
      const lockFile = path.join(directory, '.easyboost-database-operation.lock');
      try {
        const releaseOwner = await acquireDatabaseOperationLock(lockFile, {
          fileSystem: retentionFaultFileSystem(fault),
        });
        const activeMarker = await fs.readFile(lockFile);
        await assert.rejects(retainDatabaseOperationLock(
          releaseOwner,
          100,
          'REMOTE_RESTORE_SETTLEMENT_UNPROVEN',
          restoreEvidence(),
        ));
        assert.deepEqual(await fs.readFile(lockFile), activeMarker);
        assert.match(activeMarker.toString('utf8'), /^ACTIVE\n/u);
        await assert.rejects(acquireDatabaseOperationLock(lockFile), /DATABASE_OPERATION_LOCKED/u);
      } finally {
        await fs.rm(directory, { recursive: true, force: true });
      }
    });
  }
});

test('retained marker completion removes only the exact opened marker identity', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-retained-complete-'));
  const lockFile = path.join(directory, '.easyboost-database-operation.lock');
  try {
    const releaseOwner = await acquireDatabaseOperationLock(lockFile);
    await retainDatabaseOperationLock(
      releaseOwner,
      100,
      'REMOTE_RESTORE_SETTLEMENT_UNPROVEN',
      restoreEvidence(),
    );
    const retained = await openRetainedDatabaseOperationLock({
      expectedEvidenceKind: 'restore',
      lockFile,
    });
    await retained.complete();
    await assert.rejects(fs.access(lockFile), { code: 'ENOENT' });
    const absenceProof = await proveDatabaseOperationLockAbsent({ lockFile });
    assert.equal(absenceProof.absent, true);
    await absenceProof.release();
    await assert.rejects(retained.complete(), /DATABASE_OPERATION_LOCK_COMPLETION_NOT_OWNED/u);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('retained completion retries cleanup-pending exact claims until fully settled', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-complete-retry-'));
  const lockFile = path.join(directory, '.easyboost-database-operation.lock');
  const fileSystem = claimedCleanupFaultFileSystem('complete');
  try {
    const releaseOwner = await acquireDatabaseOperationLock(lockFile, { fileSystem });
    await retainDatabaseOperationLock(
      releaseOwner,
      100,
      'REMOTE_RESTORE_SETTLEMENT_UNPROVEN',
      restoreEvidence(),
    );
    const retained = await openRetainedDatabaseOperationLock({
      expectedEvidenceKind: 'restore',
      fileSystem,
      lockFile,
    });
    await assert.rejects(retained.complete(),
      /simulated complete claimed authority cleanup failure/u);
    await retained.complete();
    await assert.rejects(fs.access(lockFile), { code: 'ENOENT' });
    await assert.rejects(fs.access(`${lockFile}.authority`), { code: 'ENOENT' });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('retained marker completion refuses an identical path replacement', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-retained-replaced-'));
  const lockFile = path.join(directory, '.easyboost-database-operation.lock');
  const originalFile = `${lockFile}.original`;
  try {
    const releaseOwner = await acquireDatabaseOperationLock(lockFile);
    await retainDatabaseOperationLock(
      releaseOwner,
      100,
      'REMOTE_RESTORE_SETTLEMENT_UNPROVEN',
      restoreEvidence(),
    );
    const marker = await fs.readFile(lockFile);
    const retained = await openRetainedDatabaseOperationLock({
      expectedEvidenceKind: 'restore',
      lockFile,
    });
    await fs.rename(lockFile, originalFile);
    await fs.writeFile(lockFile, marker, { flag: 'wx', mode: 0o600 });

    await assert.rejects(retained.complete(), /DATABASE_OPERATION_LOCK_OWNERSHIP_CHANGED/u);
    assert.deepEqual(await fs.readFile(lockFile), marker);
    assert.deepEqual(await fs.readFile(originalFile), marker);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('retained completion claims exact authority before a late path swap', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-complete-swap-'));
  const lockFile = path.join(directory, '.easyboost-database-operation.lock');
  const swap = pathSwapFileSystem(lockFile);
  try {
    const releaseOwner = await acquireDatabaseOperationLock(lockFile, {
      fileSystem: swap.fileSystem,
    });
    await retainDatabaseOperationLock(
      releaseOwner,
      100,
      'REMOTE_RESTORE_SETTLEMENT_UNPROVEN',
      restoreEvidence(),
    );
    const retained = await openRetainedDatabaseOperationLock({
      expectedEvidenceKind: 'restore',
      fileSystem: swap.fileSystem,
      lockFile,
    });
    swap.arm();
    await assert.rejects(retained.complete(), /DATABASE_OPERATION_LOCK_OWNERSHIP_CHANGED/u);
    assert.deepEqual(await fs.readFile(lockFile), swap.foreignMarker);
    assert.match(await fs.readFile(`${lockFile}.authority`, 'utf8'), /^ACTIVE\n/u);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('retained recovery reader rejects evidence changed after the durable v3 commit', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-retained-tampered-'));
  const lockFile = path.join(directory, '.easyboost-database-operation.lock');
  try {
    const releaseOwner = await acquireDatabaseOperationLock(lockFile);
    await retainDatabaseOperationLock(
      releaseOwner,
      100,
      'REMOTE_RESTORE_SETTLEMENT_UNPROVEN',
      restoreEvidence(),
    );
    const marker = await fs.readFile(lockFile, 'utf8');
    await fs.writeFile(lockFile, marker.replace(
      'lastProbeActivityCount=2',
      'lastProbeActivityCount=3',
    ));
    await assert.rejects(openRetainedDatabaseOperationLock({
      expectedEvidenceKind: 'restore',
      lockFile,
    }), /retained marker checksum is invalid/u);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('retained recovery reader accepts an existing v2 marker as legacy evidence', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-retained-v2-'));
  const lockFile = path.join(directory, '.easyboost-database-operation.lock');
  try {
    await fs.writeFile(lockFile, [
      'RETAINED',
      'protocol=easyboost-database-operation-lock-v2',
      'ownerPid=1234',
      'reason=REMOTE_RESTORE_SETTLEMENT_UNPROVEN',
      'evidenceKind=restore',
      `operationToken=${RESTORE_OPERATION_TOKEN}`,
      `applicationName=easyboost_restore_${RESTORE_OPERATION_TOKEN}`,
      'ownershipToken=unknown',
      'importContainerId=unknown',
      `postgresContainerId=${'2'.repeat(64)}`,
      'lastProbeStatus=RUNNING',
      'lastProbeProcess=ACTIVE',
      'lastProbeActivityCount=2',
      '',
    ].join('\n'), { flag: 'wx', mode: 0o600 });
    const retained = await openRetainedDatabaseOperationLock({
      expectedEvidenceKind: 'restore',
      lockFile,
    });
    assert.equal(retained.legacy, true);
    assert.equal(retained.protocol, 'easyboost-database-operation-lock-v2');
    assert.equal(retained.reason, 'REMOTE_RESTORE_SETTLEMENT_UNPROVEN');
    assert.deepEqual(retained.evidence, restoreEvidence());
    await assert.rejects(retained.complete(), /DATABASE_OPERATION_LOCK_LEGACY_READ_ONLY/u);
    await fs.access(lockFile);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('shared database operation lock persists typed import settlement evidence', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-retained-import-lock-'));
  const lockFile = path.join(directory, '.easyboost-database-operation.lock');
  try {
    const releaseOwner = await acquireDatabaseOperationLock(lockFile);
    await retainDatabaseOperationLock(
      releaseOwner,
      100,
      'IMPORT_REMOTE_SETTLEMENT_UNPROVEN',
      {
        applicationName: 'easyboost_import_12345678-1234-4abc-8def-1234567890ab',
        importContainerId: '3'.repeat(64),
        kind: 'import',
        lastProbe: { activityCount: 1, process: 'ACTIVE', status: 'REMOVAL_UNPROVEN' },
        operationToken: '12345678-1234-4abc-8def-1234567890ab',
        ownershipToken: 'c'.repeat(64),
        postgresContainerId: '2'.repeat(64),
      },
    );
    const marker = await fs.readFile(lockFile, 'utf8');
    assert.match(marker, /evidenceKind=import/u);
    assert.match(marker, new RegExp(`ownershipToken=${'c'.repeat(64)}`, 'u'));
    assert.match(marker, new RegExp(`importContainerId=${'3'.repeat(64)}`, 'u'));
    assert.match(marker, /postgresContainerId=2{64}/u);
    assert.match(marker, /lastProbeStatus=REMOVAL_UNPROVEN/u);
    assert.match(marker, /applicationName=easyboost_import_12345678-1234-4abc-8def-1234567890ab/u);
    assert.match(marker, /operationToken=12345678-1234-4abc-8def-1234567890ab/u);
    assert.match(marker, /lastProbeProcess=ACTIVE/u);
    assert.match(marker, /lastProbeActivityCount=1/u);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('retained database recovery authority rejects missing or mismatched typed evidence', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-typed-db-lock-'));
  const lockFile = path.join(directory, '.easyboost-database-operation.lock');
  try {
    const releaseOwner = await acquireDatabaseOperationLock(lockFile);
    await assert.rejects(retainDatabaseOperationLock(
      releaseOwner,
      100,
      'REMOTE_RESTORE_SETTLEMENT_UNPROVEN',
    ), /restore recovery evidence is required/u);
    await assert.rejects(retainDatabaseOperationLock(
      releaseOwner,
      100,
      'IMPORT_CONTAINER_SETTLEMENT_UNPROVEN',
      {
        applicationName: 'easyboost_restore_12345678-1234-4abc-8def-1234567890ab',
        kind: 'restore',
        operationToken: '12345678-1234-4abc-8def-1234567890ab',
        postgresContainerId: '2'.repeat(64),
      },
    ), /does not match retention reason/u);
    await releaseDatabaseOperationLock(releaseOwner, 100);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('host operation guard serializes release, restore and import through one atomic directory',
  async () => {
    assert.equal(DEFAULT_HOST_OPERATION_LOCK_DIRECTORY,
      '/var/lib/easyboost/locks/host-operation.lock');
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-host-operation-lock-'));
    const lockDirectory = path.join(root, 'host.lock');
    try {
      const releaseRestore = await acquireHostOperationLock({
        lockDirectory,
        operation: 'database-restore',
      });
      assert.equal(await fs.readFile(path.join(lockDirectory, 'owner'), 'utf8'), [
        'protocol=easyboost-host-operation-v1',
        'operation=database-restore',
        `ownerPid=${process.pid}`,
        '',
      ].join('\n'));
      await assert.rejects(acquireHostOperationLock({
        lockDirectory,
        operation: 'database-import',
      }), /HOST_OPERATION_LOCKED/u);
      await releaseHostOperationLock(releaseRestore, 100);

      const releaseStaging = await acquireHostOperationLock({
        lockDirectory,
        operation: 'staging-release',
      });
      await retainHostOperationLock(releaseStaging, 100);
      await assert.rejects(acquireHostOperationLock({
        lockDirectory,
        operation: 'staging-release',
      }), /HOST_OPERATION_LOCKED/u);
      await assert.rejects(releaseStaging(), /HOST_OPERATION_LOCK_RETAINED/u);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

test('host operation guard refuses an ownership-changed directory instead of deleting it', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-host-operation-identity-'));
  const lockDirectory = path.join(root, 'host.lock');
  try {
    const release = await acquireHostOperationLock({
      lockDirectory,
      operation: 'database-restore',
    });
    await fs.rename(lockDirectory, `${lockDirectory}.owner`);
    await fs.mkdir(lockDirectory, { mode: 0o700 });
    await fs.writeFile(path.join(lockDirectory, 'owner'), 'foreign\n', { mode: 0o600 });
    await assert.rejects(releaseHostOperationLock(release, 100),
      /HOST_OPERATION_LOCK_OWNERSHIP_CHANGED/u);
    assert.equal(await fs.readFile(path.join(lockDirectory, 'owner'), 'utf8'), 'foreign\n');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('database lock adapters settle delayed mutations instead of rejecting before late effects',
  async () => {
    const effects = [];
    const release = async () => {
      await new Promise((resolve) => { setTimeout(resolve, 25); });
      effects.push('released');
    };
    release.retain = async () => {
      await new Promise((resolve) => { setTimeout(resolve, 25); });
      effects.push('retained');
    };

    await releaseDatabaseOperationLock(release, 1);
    assert.deepEqual(effects, ['released']);
    await retainDatabaseOperationLock(
      release,
      1,
      'REMOTE_RESTORE_SETTLEMENT_UNPROVEN',
      restoreEvidence(),
    );
    assert.deepEqual(effects, ['released', 'retained']);
  });
