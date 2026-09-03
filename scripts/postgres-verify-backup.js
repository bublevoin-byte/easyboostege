import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_DATABASE_OPERATION_LOCK_FILE,
  acquireDatabaseOperationLock,
  beginDatabaseOperationLocalChildHold,
  releaseDatabaseOperationLock,
  retainDatabaseOperationLock,
} from './database-operation-lock.js';
import {
  DEFAULT_RESTORE_DEADLINE_MS,
  calculateRestoreCapacityHeadroom,
  reserveFileCapacity,
  runSupervisedPostgresRestore,
} from './postgres-restore-supervisor.js';
import {
  collectLifecycleRecovery,
  isBoundedChildSettled,
  propagateLifecycleRecovery,
  settleLocalChildHold,
  spawnBoundedChild,
  terminateAndReapChild,
} from './bounded-child-lifecycle.js';

const CANONICAL_IMAGE_ID = /^sha256:[0-9a-f]{64}$/u;
const CANONICAL_CONTAINER_ID = /^[0-9a-f]{64}$/u;
const CANONICAL_OPERATION_TOKEN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const DEFAULT_MAX_BACKUP_BYTES = 64 * 1024 * 1024 * 1024;
const PG_RESTORE_LIST_MAX_CAPTURE_BYTES = 8 * 1024 * 1024;
const REQUIRED_LEARNING_TABLES = [
  'module_attempts',
  'schema_migrations',
  'user_progress',
  'users',
  'word_progress',
];

function verificationUsageError(message) {
  const error = new Error(message);
  error.exitCode = 2;
  return error;
}

async function latestBackup(backupDirectory) {
  const entries = await fsp.readdir(backupDirectory, { withFileTypes: true });
  const candidates = await Promise.all(entries
    .filter((entry) => entry.isFile() && /^easyboost-.*\.dump$/u.test(entry.name))
    .map(async (entry) => ({ path: path.join(backupDirectory, entry.name), stat: await fsp.stat(path.join(backupDirectory, entry.name)) })));
  candidates.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
  if (!candidates[0]) throw new Error('BACKUP_NOT_FOUND');
  return candidates[0].path;
}

async function expectedMigrationFiles(migrationsDirectory) {
  const migrations = (await fsp.readdir(migrationsDirectory))
    .filter((file) => /^\d{3}_[a-z0-9_]+\.sql$/u.test(file))
    .sort();
  if (!migrations.length) throw new Error('RESTORE_VERIFICATION_MIGRATION_AUTHORITY_EMPTY');
  return migrations;
}

function commandFailure(primaryError, cleanupError) {
  if (!cleanupError) return primaryError;
  const error = new AggregateError(
    [primaryError, cleanupError],
    'Docker command failed and bounded child cleanup also failed',
    { cause: primaryError },
  );
  return propagateLifecycleRecovery(error, primaryError, cleanupError);
}

function deadline(milliseconds, value) {
  return new Promise((resolve) => {
    setTimeout(() => { resolve(value); }, milliseconds);
  });
}

function forwardChildStderr(source, destination) {
  if (!source) return Promise.resolve();
  const sink = new Writable({
    write(chunk, encoding, callback) {
      try {
        destination.write(chunk, encoding, callback);
      } catch (error) {
        callback(error);
      }
    },
  });
  const onDestinationError = (error) => { sink.destroy(error); };
  destination.once('error', onDestinationError);
  return pipeline(source, sink).finally(() => {
    destination.removeListener('error', onDestinationError);
  });
}

export async function runDockerCommand(args, {
  childLifecycle = {},
  commandTimeoutMs = 120_000,
  inputFile = null,
  inputHandle = null,
  capture = false,
  environment = process.env,
  killGraceMs = 2_000,
  maxCaptureBytes = PG_RESTORE_LIST_MAX_CAPTURE_BYTES,
  operationLock,
  reapTimeoutMs = 2_000,
  spawnProcess = spawn,
  stderrDestination = process.stderr,
} = {}) {
  if (inputFile && inputHandle) throw new Error('Docker command accepts only one input source');
  if (capture && (!Number.isSafeInteger(maxCaptureBytes) || maxCaptureBytes < 1)) {
    throw new Error('Docker capture limit must be a positive safe integer');
  }
  let localChildHold;
  let spawned;
  try {
    localChildHold = operationLock
      ? await beginDatabaseOperationLocalChildHold(operationLock, {
        commandLabel: `docker ${args.join(' ')}`,
      })
      : null;
    spawned = spawnBoundedChild('docker', args, {
      ...childLifecycle,
      environment,
      killGraceMs,
      reapTimeoutMs,
      spawnProcess,
      stdio: [inputFile || inputHandle ? 'pipe' : 'ignore', capture ? 'pipe' : 'inherit', 'pipe'],
    });
  } catch (error) {
    throw await settleLocalChildHold(
      localChildHold,
      error,
      'Docker command failed before spawn and releasing its local-child hold also failed',
    );
  }
  const { authority, child, childErrors } = spawned;
  const outputChunks = [];
  let capturedBytes = 0;
  let streamFailureResolve;
  let streamFailed = false;
  const streamFailure = new Promise((resolve) => { streamFailureResolve = resolve; });
  const failStream = (error) => {
    if (streamFailed) return;
    streamFailed = true;
    streamFailureResolve(error);
  };
  child.stdin?.once('error', failStream);
  child.stdout?.once('error', failStream);
  child.stderr?.once('error', failStream);
  if (capture) {
    child.stdout.on('data', (chunk) => {
      const buffered = Buffer.from(chunk);
      if (capturedBytes + buffered.length > maxCaptureBytes) {
        failStream(new Error(
          `docker ${args.join(' ')} captured output exceeded ${maxCaptureBytes} bytes`,
        ));
        return;
      }
      capturedBytes += buffered.length;
      outputChunks.push(buffered);
    });
  }
  let closed = false;
  const closeOutcome = new Promise((resolve) => {
    child.once('close', (exitCode, signal) => {
      closed = true;
      resolve({ exitCode, signal });
    });
  });
  const input = inputHandle
    ? inputHandle.createReadStream({ autoClose: false, start: 0 })
    : inputFile ? fs.createReadStream(inputFile) : null;
  const inputTask = input ? pipeline(input, child.stdin) : Promise.resolve();
  const stderrTask = forwardChildStderr(child.stderr, stderrDestination);
  const completion = Promise.race([
    Promise.all([closeOutcome, inputTask, stderrTask]).then(([outcome]) => {
      if (outcome.exitCode !== 0) {
        throw new Error(`docker ${args.join(' ')} failed with exit code ${outcome.exitCode}`);
      }
    }),
    childErrors.firstError.then((error) => { throw error; }),
    streamFailure.then((error) => { throw error; }),
  ]);
  const commandTimeout = Symbol('command-timeout');
  const outcome = await Promise.race([
    completion.then(() => null, (error) => error),
    deadline(commandTimeoutMs, commandTimeout),
  ]);
  let primaryError;
  if (outcome === null) {
    if (isBoundedChildSettled({ authority, isClosed: () => closed })) {
      const holdError = await settleLocalChildHold(
        localChildHold,
        null,
        'Docker command settled but releasing its local-child hold failed',
      );
      if (holdError) throw holdError;
      return Buffer.concat(outputChunks).toString().trim();
    }
    primaryError = new Error(
      `docker ${args.join(' ')} left a descendant process tree after its leader closed`,
    );
  } else {
    primaryError = outcome === commandTimeout
      ? new Error(`docker ${args.join(' ')} timed out after ${commandTimeoutMs}ms`)
      : outcome;
  }
  input?.destroy();
  child.stdin?.destroy();
  child.stdout?.destroy();
  child.stderr?.destroy();
  const cleanupError = await terminateAndReapChild({
    authority,
    child,
    childErrors,
    closeOutcome,
    commandLabel: `docker ${args.join(' ')}`,
    isClosed: () => closed,
    killGraceMs,
    reapTimeoutMs,
  });
  const failure = commandFailure(primaryError, cleanupError);
  if (failure.childSettlementUnproven === true) throw failure;
  throw await settleLocalChildHold(
    localChildHold,
    failure,
    'Docker command failed and releasing its settled local-child hold also failed',
  );
}

async function writeStatus(status, { backupDirectory, statusFile }) {
  await fsp.mkdir(backupDirectory, { recursive: true });
  const temporary = `${statusFile}.${process.pid}.tmp`;
  await fsp.writeFile(temporary, JSON.stringify(status, null, 2), { mode: 0o600 });
  await fsp.rename(temporary, statusFile);
}

function verificationFailure(primaryError, cleanupError) {
  if (primaryError && cleanupError) {
    const error = new AggregateError(
      [primaryError, cleanupError],
      'Backup verification failed and temporary database cleanup also failed',
      { cause: primaryError },
    );
    return propagateLifecycleRecovery(error, primaryError, cleanupError);
  }
  const failure = primaryError || cleanupError;
  return failure ? propagateLifecycleRecovery(failure) : null;
}

async function defaultWriteFrozenChunk(handle, chunk, offset, length, position) {
  return handle.write(chunk, offset, length, position);
}

function sameFrozenSourceIdentity(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.nlink === right.nlink
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function assertFrozenSourceUnchanged(reference, current) {
  if (current.nlink !== 1n) throw new Error('BACKUP_ARCHIVE_MULTIPLE_LINKS');
  if (!sameFrozenSourceIdentity(reference, current)) {
    throw new Error('BACKUP_ARCHIVE_CHANGED_DURING_FREEZE');
  }
}

async function openFrozenBackup(backupPath, {
  frozenBackupRoot,
  maxBackupBytes,
  reserveCapacity,
  writeFrozenChunk,
}) {
  let sourceHandle;
  let snapshotHandle;
  let headroomHandle;
  let snapshotDirectory;
  try {
    const pathStat = await fsp.lstat(backupPath, { bigint: true });
    if (pathStat.isSymbolicLink()) throw new Error('BACKUP_ARCHIVE_SYMLINK');
    if (!pathStat.isFile()) throw new Error('BACKUP_ARCHIVE_NOT_REGULAR');
    if (pathStat.nlink !== 1n) throw new Error('BACKUP_ARCHIVE_MULTIPLE_LINKS');
    if (pathStat.size > BigInt(maxBackupBytes)) throw new Error('BACKUP_ARCHIVE_TOO_LARGE');
    const noFollow = fs.constants.O_NOFOLLOW || 0;
    sourceHandle = await fsp.open(backupPath, fs.constants.O_RDONLY | noFollow);
    const sourceStat = await sourceHandle.stat({ bigint: true });
    if (!sourceStat.isFile()) throw new Error('BACKUP_ARCHIVE_NOT_REGULAR');
    if (sourceStat.nlink !== 1n) throw new Error('BACKUP_ARCHIVE_MULTIPLE_LINKS');
    if (sourceStat.size > BigInt(maxBackupBytes)) throw new Error('BACKUP_ARCHIVE_TOO_LARGE');
    if (sourceStat.size < 1n) throw new Error('BACKUP_ARCHIVE_EMPTY');
    if (!sameFrozenSourceIdentity(pathStat, sourceStat)) {
      throw new Error('BACKUP_ARCHIVE_PATH_CHANGED_DURING_OPEN');
    }
    await fsp.mkdir(frozenBackupRoot, { recursive: true, mode: 0o700 });
    snapshotDirectory = await fsp.mkdtemp(
      path.join(frozenBackupRoot, 'easyboost-frozen-backup-'),
    );
    const snapshotPath = path.join(snapshotDirectory, 'archive.dump');
    snapshotHandle = await fsp.open(snapshotPath, 'wx+', 0o600);
    const archiveBytes = Number(sourceStat.size);
    const capacityHeadroomBytes = calculateRestoreCapacityHeadroom(archiveBytes);
    await reserveCapacity(snapshotHandle, archiveBytes);
    headroomHandle = await fsp.open(
      path.join(snapshotDirectory, 'capacity.reserve'),
      'wx+',
      0o600,
    );
    await reserveCapacity(headroomHandle, capacityHeadroomBytes);
    const hash = createHash('sha256');
    let position = 0;
    for await (const chunk of sourceHandle.createReadStream({ autoClose: false, start: 0 })) {
      if (position + chunk.length > maxBackupBytes) throw new Error('BACKUP_ARCHIVE_TOO_LARGE');
      hash.update(chunk);
      let offset = 0;
      while (offset < chunk.length) {
        const { bytesWritten } = await writeFrozenChunk(
          snapshotHandle,
          chunk,
          offset,
          chunk.length - offset,
          position + offset,
        );
        if (!Number.isSafeInteger(bytesWritten) || bytesWritten < 1
            || bytesWritten > chunk.length - offset) {
          throw new Error('BACKUP_ARCHIVE_SNAPSHOT_WRITE_INVALID');
        }
        offset += bytesWritten;
      }
      position += chunk.length;
      assertFrozenSourceUnchanged(
        sourceStat,
        await sourceHandle.stat({ bigint: true }),
      );
    }
    const finalSourceStat = await sourceHandle.stat({ bigint: true });
    assertFrozenSourceUnchanged(sourceStat, finalSourceStat);
    if (BigInt(position) !== sourceStat.size) {
      throw new Error('BACKUP_ARCHIVE_CHANGED_DURING_FREEZE');
    }
    await snapshotHandle.sync();
    await sourceHandle.close();
    sourceHandle = null;
    await fsp.chmod(snapshotPath, 0o400);
    return {
      handle: snapshotHandle,
      archiveBytes,
      capacityHeadroomBytes,
      recoveryAuthority: Object.freeze({ frozenBackupDirectory: snapshotDirectory }),
      sha256: hash.digest('hex'),
      async release() {
        const errors = [];
        for (const handle of [snapshotHandle, headroomHandle]) {
          try {
            await handle.close();
          } catch (error) {
            errors.push(error);
          }
        }
        try {
          await fsp.rm(snapshotDirectory, { recursive: true });
        } catch (error) {
          errors.push(error);
        }
        if (errors.length === 1) throw errors[0];
        if (errors.length > 1) {
          throw new AggregateError(errors, 'Frozen backup descriptor and directory cleanup failed', {
            cause: errors[0],
          });
        }
      },
    };
  } catch (error) {
    const cleanupErrors = [];
    for (const handle of [sourceHandle, snapshotHandle, headroomHandle]) {
      if (!handle) continue;
      try {
        await handle.close();
      } catch (failure) {
        cleanupErrors.push(failure);
      }
    }
    if (snapshotDirectory) {
      try {
        await fsp.rm(snapshotDirectory, { recursive: true, force: true });
      } catch (failure) {
        cleanupErrors.push(failure);
      }
    }
    const cleanupError = cleanupErrors.length > 1
      ? new AggregateError(cleanupErrors, 'Frozen backup setup cleanup failed', {
        cause: cleanupErrors[0],
      })
      : cleanupErrors[0];
    throw verificationFailure(error, cleanupError);
  }
}

function statusErrorCode(error) {
  return String(error?.message || error).slice(0, 200);
}

const VERIFICATION_INSPECT_FORMAT = [
  '{{.Id}}',
  '{{.Image}}',
  '{{.State.Running}}',
  '{{ index .Config.Labels "easyboost.verification.token" }}',
  '{{(index .Mounts 0).Name}}',
  '{{(index .Mounts 0).Destination}}',
].join('|');

function delay(milliseconds) {
  return new Promise((resolve) => { setTimeout(resolve, milliseconds); });
}

export async function createDisposablePostgresVerificationRuntime({
  archiveBytes,
  capacityHeadroomBytes,
  operationToken,
  postgresExpectedImageId,
  readinessAttempts = 30,
  readinessIntervalMs = 1_000,
  runDocker,
  wait = delay,
} = {}) {
  if (!CANONICAL_OPERATION_TOKEN.test(operationToken || '')) {
    throw verificationUsageError('Disposable verification requires one canonical operation token');
  }
  if (!CANONICAL_IMAGE_ID.test(postgresExpectedImageId || '')) {
    throw verificationUsageError('Disposable verification requires one canonical PostgreSQL image ID');
  }
  if (!Number.isSafeInteger(archiveBytes) || archiveBytes < 1
      || capacityHeadroomBytes !== calculateRestoreCapacityHeadroom(archiveBytes)) {
    throw verificationUsageError('Disposable verification requires bounded archive capacity evidence');
  }
  if (!Number.isSafeInteger(readinessAttempts) || readinessAttempts < 1
      || readinessAttempts > 120) {
    throw verificationUsageError('Disposable verification readiness attempts are outside bounds');
  }
  if (!Number.isSafeInteger(readinessIntervalMs) || readinessIntervalMs < 1
      || readinessIntervalMs > 60_000) {
    throw verificationUsageError('Disposable verification readiness interval is outside bounds');
  }
  if (typeof runDocker !== 'function') {
    throw verificationUsageError('Disposable verification requires a Docker command adapter');
  }

  const resourceName = `easyboost-verify-${operationToken}`;
  let volumeOwned = false;
  let containerId;
  let state = 'setting-up';
  const cleanup = async () => {
    if (state === 'cleaned') {
      throw new Error('Disposable verification runtime is already cleaned');
    }
    const errors = [];
    if (containerId) {
      try {
        const removed = await runDocker(
          ['rm', '--force', containerId],
          { capture: true },
        );
        if (removed !== containerId) {
          throw new Error('Disposable verification container removal proof failed');
        }
        containerId = null;
      } catch (error) {
        errors.push(error);
      }
    }
    if (volumeOwned && !containerId) {
      try {
        const removed = await runDocker(
          ['volume', 'rm', resourceName],
          { capture: true },
        );
        if (removed !== resourceName) {
          throw new Error('Disposable verification volume removal proof failed');
        }
        volumeOwned = false;
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new AggregateError(errors, 'Disposable verification cleanup was incomplete', {
        cause: errors[0],
      });
    }
    state = 'cleaned';
  };

  try {
    const createdVolume = await runDocker([
      'volume', 'create',
      '--label', 'easyboost.verification.protocol=v1',
      '--label', `easyboost.verification.token=${operationToken}`,
      resourceName,
    ], { capture: true });
    if (createdVolume !== resourceName) {
      throw new Error('Disposable verification volume ownership proof failed');
    }
    volumeOwned = true;
    const tmpfsBytes = archiveBytes + capacityHeadroomBytes;
    const launchedContainerId = await runDocker([
      'run', '--detach',
      '--name', resourceName,
      '--label', 'easyboost.verification.protocol=v1',
      '--label', `easyboost.verification.token=${operationToken}`,
      '--network', 'none',
      '--mount', `type=volume,src=${resourceName},dst=/var/lib/postgresql/data`,
      '--tmpfs', `/tmp:rw,nosuid,nodev,noexec,size=${tmpfsBytes}`,
      '--env', 'POSTGRES_USER=easyboost',
      '--env', 'POSTGRES_DB=easyboost',
      '--env', 'POSTGRES_HOST_AUTH_METHOD=trust',
      postgresExpectedImageId,
    ], { capture: true });
    if (!CANONICAL_CONTAINER_ID.test(launchedContainerId)) {
      throw new Error('Disposable verification returned a non-canonical container ID');
    }
    containerId = launchedContainerId;
    const allocation = await runDocker([
      'inspect', '--format', VERIFICATION_INSPECT_FORMAT, containerId,
    ], { capture: true });
    const expected = [
      containerId,
      postgresExpectedImageId,
      'true',
      operationToken,
      resourceName,
      '/var/lib/postgresql/data',
    ].join('|');
    if (allocation !== expected) {
      throw new Error('Disposable verification container identity, image or volume proof failed');
    }
    let ready = false;
    let readinessError;
    for (let attempt = 1; attempt <= readinessAttempts; attempt += 1) {
      try {
        await runDocker([
          'exec', containerId, 'pg_isready', '-U', 'easyboost', '-d', 'easyboost',
        ], { capture: true });
        ready = true;
        break;
      } catch (error) {
        readinessError = error;
      }
      if (attempt < readinessAttempts) await wait(readinessIntervalMs);
    }
    if (!ready) {
      throw new Error(
        `Disposable PostgreSQL readiness failed after ${readinessAttempts} attempts`,
        { cause: readinessError },
      );
    }
    state = 'ready';
    return {
      cleanup,
      containerId,
      isolation: 'disposable-exact-image-container',
      operationToken,
      volumeName: resourceName,
    };
  } catch (error) {
    const recovery = collectLifecycleRecovery(error);
    error = propagateLifecycleRecovery(error);
    if (recovery.childSettlementUnproven) throw error;
    let cleanupError;
    try {
      await cleanup();
    } catch (failure) {
      cleanupError = failure;
    }
    throw verificationFailure(error, cleanupError);
  }
}

export async function verifyPostgresBackup({
  acquireOperationLock = acquireDatabaseOperationLock,
  backup,
  backupDirectory = path.resolve('backups'),
  statusFile = path.join(backupDirectory, 'restore-check-status.json'),
  createOperationToken = randomUUID,
  createVerificationRuntime = createDisposablePostgresVerificationRuntime,
  migrationsDirectory = path.resolve('migrations'),
  lockFile,
  lockReleaseTimeoutMs = 2_000,
  maxBackupBytes = DEFAULT_MAX_BACKUP_BYTES,
  postgresExpectedImageId,
  productionAppImageId,
  environment = process.env,
  freezeBackup = openFrozenBackup,
  frozenBackupRoot = os.tmpdir(),
  publishStatus = writeStatus,
  reserveCapacity = reserveFileCapacity,
  restoreDeadlineMs = DEFAULT_RESTORE_DEADLINE_MS,
  retainOperationLock = retainDatabaseOperationLock,
  runDocker = runDockerCommand,
  runSupervisedRestore = runSupervisedPostgresRestore,
  writeFrozenChunk = defaultWriteFrozenChunk,
} = {}) {
  if (!CANONICAL_IMAGE_ID.test(productionAppImageId || '')) {
    throw verificationUsageError(
      'EASYBOOST_PRODUCTION_APP_IMAGE_ID must be an owner-approved canonical sha256 image ID',
    );
  }
  if (!CANONICAL_IMAGE_ID.test(postgresExpectedImageId || '')) {
    throw verificationUsageError(
      'EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID must be an owner-approved canonical sha256 image ID',
    );
  }
  if (!Number.isSafeInteger(maxBackupBytes) || maxBackupBytes < 1) {
    throw verificationUsageError('Maximum backup size must be a positive safe integer');
  }
  if (!Number.isSafeInteger(lockReleaseTimeoutMs) || lockReleaseTimeoutMs < 1) {
    throw verificationUsageError('Operation lock release timeout must be a positive safe integer');
  }
  if (typeof frozenBackupRoot !== 'string' || !path.isAbsolute(frozenBackupRoot)) {
    throw verificationUsageError('Frozen backup root must be an absolute filesystem path');
  }
  const resolvedFrozenBackupRoot = path.resolve(frozenBackupRoot);
  const operationLockFile = path.resolve(lockFile || DEFAULT_DATABASE_OPERATION_LOCK_FILE);
  const releaseOperationLock = await acquireOperationLock(operationLockFile);
  let lockedResult;
  let lockedError;
  let operationLockRetentionReason;
  let recoveryEvidence;
  try {
    lockedResult = await (async () => {
  const startedAt = Date.now();
  const dockerEnvironment = {
    ...environment,
    EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID: postgresExpectedImageId,
    EASYBOOST_PRODUCTION_APP_IMAGE_ID: productionAppImageId,
  };
  const docker = (args, options = {}) => runDocker(args, {
    environment: dockerEnvironment,
    operationLock: releaseOperationLock,
    ...options,
  });

  let resolvedBackup;
  let frozenBackup;
  let runtime;
  let verificationResult;
  let primaryError = null;
  try {
    resolvedBackup = path.resolve(backup || await latestBackup(backupDirectory));
    frozenBackup = await freezeBackup(resolvedBackup, {
      frozenBackupRoot: resolvedFrozenBackupRoot,
      maxBackupBytes,
      reserveCapacity,
      writeFrozenChunk,
    });
    const availableImageId = await docker(
      ['image', 'inspect', '--format', '{{.Id}}', postgresExpectedImageId],
      { capture: true },
    );
    if (availableImageId !== postgresExpectedImageId) {
      throw new Error('Approved PostgreSQL verification image is unavailable');
    }
    const operationToken = createOperationToken();
    if (!CANONICAL_OPERATION_TOKEN.test(operationToken || '')) {
      throw new Error('Verification operation token generator returned a non-canonical UUID');
    }
    runtime = await createVerificationRuntime({
      archiveBytes: frozenBackup.archiveBytes,
      capacityHeadroomBytes: frozenBackup.capacityHeadroomBytes,
      operationToken,
      postgresExpectedImageId,
      runDocker: docker,
    });
    const postgresContainerId = runtime.containerId;
    if (!CANONICAL_CONTAINER_ID.test(postgresContainerId || '')) {
      throw new Error('Disposable verification runtime returned a non-canonical container ID');
    }
    await docker(
      ['exec', '-i', postgresContainerId, 'pg_restore', '--list'],
      {
        capture: true,
        inputHandle: frozenBackup.handle,
        maxCaptureBytes: PG_RESTORE_LIST_MAX_CAPTURE_BYTES,
      },
    );
    recoveryEvidence = await runSupervisedRestore({
      archiveBytes: frozenBackup.archiveBytes,
      archiveSha256: frozenBackup.sha256,
      capacityHeadroomBytes: frozenBackup.capacityHeadroomBytes,
      createOperationToken: () => operationToken,
      inputHandle: frozenBackup.handle,
      postgresContainerId,
      restoreDeadlineMs,
      runDocker: docker,
    });
    const restoredTables = await docker([
      'exec', '-i', postgresContainerId, 'psql', '-U', 'easyboost', '-d', 'easyboost', '-Atc',
      `SELECT table_name
         FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name IN ('module_attempts', 'schema_migrations', 'user_progress', 'users', 'word_progress')
        ORDER BY table_name;`,
    ], { capture: true });
    const restoredTableSet = new Set(restoredTables.split(/\r?\n/u).filter(Boolean));
    const missingTables = REQUIRED_LEARNING_TABLES.filter((table) => !restoredTableSet.has(table));
    if (missingTables.length) {
      throw new Error(`RESTORE_VERIFICATION_MISSING_TABLES: ${missingTables.join(', ')}`);
    }
    const expectedMigrations = await expectedMigrationFiles(migrationsDirectory);
    const restoredMigrationOutput = await docker([
      'exec', '-i', postgresContainerId, 'psql', '-U', 'easyboost', '-d', 'easyboost', '-Atc',
      'SELECT version FROM schema_migrations ORDER BY version;',
    ], { capture: true });
    const restoredMigrations = restoredMigrationOutput.split(/\r?\n/u).filter(Boolean);
    const expectedSet = new Set(expectedMigrations);
    const restoredSet = new Set(restoredMigrations);
    const missingMigrations = expectedMigrations.filter((migration) => !restoredSet.has(migration));
    const unexpectedMigrations = restoredMigrations.filter((migration) => !expectedSet.has(migration));
    if (missingMigrations.length || unexpectedMigrations.length
        || restoredMigrations.length !== expectedMigrations.length) {
      throw new Error(
        `RESTORE_VERIFICATION_MIGRATION_MISMATCH missing=${missingMigrations.join(',') || 'none'} unexpected=${unexpectedMigrations.join(',') || 'none'}`,
      );
    }
    const verification = await docker([
      'exec', '-i', postgresContainerId, 'psql', '-U', 'easyboost', '-d', 'easyboost', '-Atc',
      `SELECT (SELECT COUNT(*) FROM users) || ':' ||
              (SELECT COUNT(*) FROM user_progress) || ':' ||
              (SELECT COUNT(*) FROM module_attempts) || ':' ||
              (SELECT COUNT(*) FROM word_progress) || ':' ||
              (SELECT COUNT(*) FROM schema_migrations);`,
    ], { capture: true });
    const [users, userProgress, moduleAttempts, wordProgress, migrations] = verification
      .split(':').map(Number);
    if (![users, userProgress, moduleAttempts, wordProgress, migrations]
      .every((value) => Number.isSafeInteger(value) && value >= 0)
        || migrations !== expectedMigrations.length) {
      throw new Error('RESTORE_VERIFICATION_FAILED');
    }
    verificationResult = { users, userProgress, moduleAttempts, wordProgress, migrations };
  } catch (error) {
    primaryError = propagateLifecycleRecovery(error);
    if (primaryError.retainOperationLock === true) {
      operationLockRetentionReason = 'REMOTE_RESTORE_SETTLEMENT_UNPROVEN';
      recoveryEvidence = primaryError.recoveryEvidence;
    }
  }

  let cleanupError = null;
  let localChildSettlementUnproven = primaryError
    && collectLifecycleRecovery(primaryError).childSettlementUnproven;
  if (runtime && !operationLockRetentionReason && !localChildSettlementUnproven) {
    try {
      const cleanupResult = await runtime.cleanup();
      if (collectLifecycleRecovery(cleanupResult).childSettlementUnproven) {
        const returnedFailure = cleanupResult instanceof Error
          ? cleanupResult
          : new Error('Verification runtime cleanup returned unproven child settlement');
        cleanupError = propagateLifecycleRecovery(returnedFailure, cleanupResult);
      }
    } catch (error) {
      cleanupError = propagateLifecycleRecovery(error);
    }
    localChildSettlementUnproven = collectLifecycleRecovery(
      primaryError,
      cleanupError,
    ).childSettlementUnproven;
  }
  let backupCloseError = null;
  if (frozenBackup && !localChildSettlementUnproven) {
    try {
      const releaseResult = await frozenBackup.release();
      if (collectLifecycleRecovery(releaseResult).childSettlementUnproven) {
        const returnedFailure = releaseResult instanceof Error
          ? releaseResult
          : new Error('Frozen backup release returned unproven child settlement');
        backupCloseError = propagateLifecycleRecovery(returnedFailure, releaseResult);
      }
    } catch (error) {
      backupCloseError = propagateLifecycleRecovery(error);
    }
    localChildSettlementUnproven = collectLifecycleRecovery(
      primaryError,
      cleanupError,
      backupCloseError,
    ).childSettlementUnproven;
  }
  cleanupError = verificationFailure(cleanupError, backupCloseError);

  if (primaryError || cleanupError) {
    const failureStatus = {
      status: 'failed',
      checkedAt: new Date().toISOString(),
      backup: resolvedBackup ? path.basename(resolvedBackup) : null,
      backupSha256: frozenBackup?.sha256 || null,
      errorCode: statusErrorCode(primaryError || cleanupError),
      ...(primaryError && cleanupError
        ? { cleanupErrorCode: statusErrorCode(cleanupError) }
        : {}),
      durationMs: Date.now() - startedAt,
      postgresImageId: postgresExpectedImageId,
      verificationIsolation: runtime?.isolation || 'disposable-runtime-not-established',
    };
    let operationError = verificationFailure(primaryError, cleanupError);
    if (frozenBackup && (localChildSettlementUnproven || backupCloseError)) {
      operationError = propagateLifecycleRecovery(operationError, frozenBackup);
    }
    try {
      await publishStatus(failureStatus, { backupDirectory, statusFile });
    } catch (publicationError) {
      const operationErrors = operationError instanceof AggregateError
        ? [...operationError.errors]
        : [operationError];
      const publicationFailure = new AggregateError(
        [...operationErrors, publicationError],
        'Backup verification failed and publishing its failure status also failed',
        { cause: operationErrors[0] },
      );
      throw propagateLifecycleRecovery(publicationFailure, operationError, publicationError);
    }
    throw operationError;
  }

  const successStatus = {
    status: 'success',
    checkedAt: new Date().toISOString(),
    backup: path.basename(resolvedBackup),
    backupSha256: frozenBackup.sha256,
    postgresImageId: postgresExpectedImageId,
    verificationIsolation: runtime.isolation,
    ...verificationResult,
    durationMs: Date.now() - startedAt,
  };
  await publishStatus(successStatus, { backupDirectory, statusFile });
  return successStatus;
    })();
  } catch (error) {
    lockedError = propagateLifecycleRecovery(error);
  }
  let lockReleaseError;
  const localChildSettlementUnproven = lockedError
    && collectLifecycleRecovery(lockedError).childSettlementUnproven;
  if (localChildSettlementUnproven) {
    // The durable local-child hold is the only finalization authority until exact
    // child settlement is proven; do not release or retain around that hold.
  } else if (operationLockRetentionReason) {
    try {
      await retainOperationLock(
        releaseOperationLock,
        lockReleaseTimeoutMs,
        operationLockRetentionReason,
        recoveryEvidence,
      );
    } catch (error) {
      lockReleaseError = error;
    }
  } else {
    try {
      await releaseDatabaseOperationLock(releaseOperationLock, lockReleaseTimeoutMs);
    } catch (error) {
      lockReleaseError = error;
    }
  }
  if (lockedError) throw verificationFailure(lockedError, lockReleaseError);
  if (lockReleaseError) throw lockReleaseError;
  return lockedResult;
}

async function main() {
  const status = await verifyPostgresBackup({
    backup: process.argv[2],
    postgresExpectedImageId: process.env.EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID,
    productionAppImageId: process.env.EASYBOOST_PRODUCTION_APP_IMAGE_ID,
  });
  console.log(JSON.stringify(status));
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    const errors = error instanceof AggregateError ? error.errors : [error];
    for (const failure of errors) console.error(failure.message);
    process.exitCode = error.exitCode || 1;
  });
}
