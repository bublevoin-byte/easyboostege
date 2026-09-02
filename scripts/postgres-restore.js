import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { createHash } from 'node:crypto';
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
  MAX_RESTORE_DEADLINE_MS,
  MIN_RESTORE_DEADLINE_MS,
  calculateRestoreCapacityHeadroom,
  reserveFileCapacity,
  runSupervisedPostgresRestore,
} from './postgres-restore-supervisor.js';
import {
  acquireHostOperationLock,
  releaseHostOperationLock,
  retainHostOperationLock,
} from './host-operation-lock.js';
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
const PRODUCTION_COMPOSE_PROJECT_NAME = 'easyboost-production';
const POSTGRES_ALLOCATION_FORMAT = '{{.Id}}|{{ index .Config.Labels "com.docker.compose.project" }}|{{ index .Config.Labels "com.docker.compose.service" }}|{{ index .Config.Labels "com.docker.compose.oneoff" }}|{{.Image}}|{{.State.Running}}';
const DEFAULT_MAX_BACKUP_BYTES = 64 * 1024 * 1024 * 1024;
const PG_RESTORE_LIST_MAX_CAPTURE_BYTES = 8 * 1024 * 1024;

function lifecycleFailure(primaryError, cleanupError, message) {
  if (!primaryError) return cleanupError;
  if (!cleanupError) return primaryError;
  const error = new AggregateError([primaryError, cleanupError], message, {
    cause: primaryError,
  });
  error.exitCode = primaryError?.exitCode;
  return propagateLifecycleRecovery(error, primaryError, cleanupError);
}

function deadline(milliseconds, value) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { resolve(value); }, milliseconds);
    timer.unref?.();
  });
}

function forwardChildStderr(source, destination, accountCaptureBytes = () => {}) {
  if (!source) return Promise.resolve();
  const sink = new Writable({
    write(chunk, encoding, callback) {
      try {
        accountCaptureBytes(chunk);
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
  const accountCaptureBytes = (chunk) => {
    if (!capture) return;
    const byteLength = Buffer.byteLength(chunk);
    if (capturedBytes + byteLength > maxCaptureBytes) {
      throw new Error(`docker ${args.join(' ')} captured output exceeded ${maxCaptureBytes} bytes`);
    }
    capturedBytes += byteLength;
  };
  if (capture) {
    child.stdout.on('data', (chunk) => {
      try {
        accountCaptureBytes(chunk);
        outputChunks.push(Buffer.from(chunk));
      } catch (error) {
        failStream(error);
      }
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
  const stderrTask = forwardChildStderr(child.stderr, stderrDestination, accountCaptureBytes);
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
  let failure = primaryError;
  if (cleanupError) {
    failure = lifecycleFailure(
      primaryError,
      cleanupError,
      'Docker command failed and bounded child cleanup also failed',
    );
  }
  if (failure.childSettlementUnproven === true) throw failure;
  throw await settleLocalChildHold(
    localChildHold,
    failure,
    'Docker command failed and releasing its settled local-child hold also failed',
  );
}

function restoreUsageError(message) {
  const error = new Error(message);
  error.exitCode = 2;
  return error;
}

function delay(milliseconds) {
  return new Promise((resolve) => { setTimeout(resolve, milliseconds); });
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
    throw lifecycleFailure(error, cleanupError, 'Backup freeze failed and its resources did not close');
  }
}

export async function waitForApplicationReadiness({
  url = 'http://127.0.0.1:3000/health/ready',
  attempts = 30,
  requestTimeoutMs = 2_000,
  intervalMs = 1_000,
  fetchImpl = globalThis.fetch,
  wait = delay,
} = {}) {
  if (!Number.isSafeInteger(attempts) || attempts < 1) {
    throw restoreUsageError('Application readiness attempts must be a positive integer');
  }
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1) {
    throw restoreUsageError('Application readiness timeout must be a positive integer');
  }
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    let timeout;
    try {
      const timeoutPromise = new Promise((resolve, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(new Error(`Application readiness request timed out after ${requestTimeoutMs}ms`));
        }, requestTimeoutMs);
      });
      const response = await Promise.race([
        fetchImpl(url, { cache: 'no-store', signal: controller.signal }),
        timeoutPromise,
      ]);
      if (response?.ok) return { attempt, url };
      lastError = new Error(`Application readiness returned HTTP ${response?.status ?? 'unknown'}`);
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timeout);
    }
    if (attempt < attempts) await wait(intervalMs);
  }
  throw new Error(`Application readiness failed after ${attempts} attempts`, { cause: lastError });
}

async function proveExactAppAllocation({
  appContainerId,
  composeDocker,
  docker,
  expectedRunning,
  productionAppImageId,
}) {
  const currentAppContainerId = await composeDocker(
    ['ps', '--all', '--quiet', 'app'],
    { capture: true },
  );
  if (currentAppContainerId !== appContainerId) {
    throw new Error('Compose application allocation changed during database restore');
  }
  const allocation = await docker([
    'inspect', '--format',
    '{{.Id}}|{{ index .Config.Labels "com.docker.compose.project" }}|{{ index .Config.Labels "com.docker.compose.service" }}|{{ index .Config.Labels "com.docker.compose.oneoff" }}|{{.Image}}|{{.State.Running}}',
    appContainerId,
  ], { capture: true });
  const expected = [
    appContainerId,
    PRODUCTION_COMPOSE_PROJECT_NAME,
    'app',
    'False',
    productionAppImageId,
    String(expectedRunning),
  ].join('|');
  if (allocation !== expected) {
    throw new Error('Application container identity, ownership, image or running state changed');
  }
}

async function proveExactPostgresAllocation({ composeDocker, docker, postgresExpectedImageId }) {
  const postgresContainerId = await composeDocker(
    ['ps', '--all', '--quiet', 'postgres'],
    { capture: true },
  );
  if (!CANONICAL_CONTAINER_ID.test(postgresContainerId)) {
    throw new Error('Database restore requires one canonical PostgreSQL container ID');
  }
  const allocation = await docker(
    ['inspect', '--format', POSTGRES_ALLOCATION_FORMAT, postgresContainerId],
    { capture: true },
  );
  const expected = [
    postgresContainerId,
    PRODUCTION_COMPOSE_PROJECT_NAME,
    'postgres',
    'False',
    postgresExpectedImageId,
    'true',
  ].join('|');
  if (allocation !== expected) {
    throw new Error('Running PostgreSQL identity, ownership or image does not match the approved restore authority');
  }
  return postgresContainerId;
}

async function proveComposeAppAbsent({ composeDocker }) {
  const appAllocation = await composeDocker(
    ['ps', '--all', '--quiet', 'app'],
    { capture: true },
  );
  if (appAllocation !== '') {
    throw new Error('APPLICATION_ALLOCATION_PRESENT_DURING_DATABASE_ONLY_RESTORE');
  }
}

async function stopAndVerifyExactAppContainer({
  appContainerId,
  composeDocker,
  docker,
  productionAppImageId,
}) {
  let stopError;
  try {
    await docker(['stop', '--time', '10', appContainerId]);
  } catch (error) {
    stopError = error;
  }
  let verificationError;
  try {
    await proveExactAppAllocation({
      appContainerId,
      composeDocker,
      docker,
      expectedRunning: false,
      productionAppImageId,
    });
  } catch (error) {
    verificationError = error;
  }
  if (stopError && verificationError) {
    throw lifecycleFailure(
      stopError,
      verificationError,
      'Exact application stop failed and stopped-state verification also failed',
    );
  }
  if (stopError) throw stopError;
  if (verificationError) throw verificationError;
}

export async function restorePostgresBackup({
  acquireOperationLock = acquireDatabaseOperationLock,
  acquireHostLock = acquireHostOperationLock,
  applicationMode = 'managed',
  backup,
  checkReadiness = waitForApplicationReadiness,
  postgresExpectedImageId,
  productionAppImageId,
  readinessUrl = 'http://127.0.0.1:3000/health/ready',
  restoreDeadlineMs = DEFAULT_RESTORE_DEADLINE_MS,
  composeFile = path.resolve('compose.production.yml'),
  freezeBackup = openFrozenBackup,
  frozenBackupRoot = os.tmpdir(),
  environment = process.env,
  hostLockDirectory,
  hostLockReleaseTimeoutMs = 2_000,
  lockFile,
  lockReleaseTimeoutMs = 2_000,
  maxBackupBytes = DEFAULT_MAX_BACKUP_BYTES,
  releaseHostLock = releaseHostOperationLock,
  reserveCapacity = reserveFileCapacity,
  retainOperationLock = retainDatabaseOperationLock,
  retainHostLock = retainHostOperationLock,
  runDocker = runDockerCommand,
  runSupervisedRestore = runSupervisedPostgresRestore,
  writeFrozenChunk = defaultWriteFrozenChunk,
  log = console.log,
} = {}) {
  if (applicationMode !== 'managed' && applicationMode !== 'absent') {
    throw restoreUsageError('Application mode must be either managed or absent');
  }
  if (!CANONICAL_IMAGE_ID.test(productionAppImageId || '')) {
    throw restoreUsageError(
      'EASYBOOST_PRODUCTION_APP_IMAGE_ID must be an owner-approved canonical sha256 image ID',
    );
  }
  if (!CANONICAL_IMAGE_ID.test(postgresExpectedImageId || '')) {
    throw restoreUsageError(
      'EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID must be an owner-approved canonical sha256 image ID',
    );
  }
  if (!backup) throw restoreUsageError('Database restore requires a backup path');
  if (typeof frozenBackupRoot !== 'string' || !path.isAbsolute(frozenBackupRoot)) {
    throw restoreUsageError('Frozen backup root must be an absolute filesystem path');
  }
  if (!Number.isSafeInteger(maxBackupBytes) || maxBackupBytes < 1) {
    throw restoreUsageError('Maximum backup size must be a positive safe integer');
  }
  if (!Number.isSafeInteger(lockReleaseTimeoutMs) || lockReleaseTimeoutMs < 1) {
    throw restoreUsageError('Operation lock release timeout must be a positive safe integer');
  }
  if (!Number.isSafeInteger(hostLockReleaseTimeoutMs) || hostLockReleaseTimeoutMs < 1) {
    throw restoreUsageError('Host operation lock release timeout must be a positive safe integer');
  }
  if (!Number.isSafeInteger(restoreDeadlineMs)
      || restoreDeadlineMs < MIN_RESTORE_DEADLINE_MS
      || restoreDeadlineMs > MAX_RESTORE_DEADLINE_MS) {
    throw restoreUsageError(
      `Restore deadline must be an integer between ${MIN_RESTORE_DEADLINE_MS} and ${MAX_RESTORE_DEADLINE_MS}ms`,
    );
  }
  const resolvedBackup = path.resolve(backup);
  const resolvedFrozenBackupRoot = path.resolve(frozenBackupRoot);
  const operationLockFile = path.resolve(lockFile || DEFAULT_DATABASE_OPERATION_LOCK_FILE);
  const scopedHostLockDirectory = hostLockDirectory
    || (lockFile ? path.join(path.dirname(operationLockFile), '.easyboost-host-operation.lock') : undefined);
  const releaseHostOperation = await acquireHostLock({
    environment,
    lockDirectory: scopedHostLockDirectory,
    operation: 'database-restore',
  });
  let releaseOperationLock;
  try {
    releaseOperationLock = await acquireOperationLock(operationLockFile);
  } catch (error) {
    let hostReleaseError;
    try {
      await releaseHostLock(releaseHostOperation, hostLockReleaseTimeoutMs);
    } catch (failure) {
      hostReleaseError = failure;
    }
    throw lifecycleFailure(
      error,
      hostReleaseError,
      'Database operation lock failed and releasing the host operation guard also failed',
    );
  }
  const dockerOptions = {
    environment: {
      ...environment,
      EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID: postgresExpectedImageId,
      EASYBOOST_PRODUCTION_APP_IMAGE_ID: productionAppImageId,
    },
  };
  const docker = (args, options = {}) => runDocker(args, {
    ...dockerOptions,
    operationLock: releaseOperationLock,
    ...options,
  });
  const composeDocker = (args, options) => (
    docker([
      'compose', '--project-name', PRODUCTION_COMPOSE_PROJECT_NAME,
      '-f', composeFile, ...args,
    ], options)
  );
  let operationError;
  let operationLockRetentionReason;
  let recoveryEvidence;
  let result;
  let frozenBackup;
  try {
    frozenBackup = await freezeBackup(resolvedBackup, {
      frozenBackupRoot: resolvedFrozenBackupRoot,
      maxBackupBytes,
      reserveCapacity,
      writeFrozenChunk,
    });
    if (applicationMode === 'managed') {
      const appPreflightImageId = await docker(
        ['image', 'inspect', '--format', '{{.Id}}', productionAppImageId],
        { capture: true },
      );
      if (appPreflightImageId !== productionAppImageId) {
        throw new Error('Approved application image is unavailable before database restore');
      }
    }
    const postgresContainerId = await proveExactPostgresAllocation({
      composeDocker,
      docker,
      postgresExpectedImageId,
    });
    log(`Validating backup: ${resolvedBackup}`);
    await docker(
      ['exec', '-i', postgresContainerId, 'pg_restore', '--list'],
      {
        capture: true,
        inputHandle: frozenBackup.handle,
        maxCaptureBytes: PG_RESTORE_LIST_MAX_CAPTURE_BYTES,
      },
    );

    let appContainerId;
    if (applicationMode === 'managed') {
      appContainerId = await composeDocker(
        ['ps', '--all', '--quiet', 'app'],
        { capture: true },
      );
      if (!CANONICAL_CONTAINER_ID.test(appContainerId)) {
        throw new Error('Database restore requires one canonical Compose application container ID');
      }
      await proveExactAppAllocation({
        appContainerId,
        composeDocker,
        docker,
        expectedRunning: true,
        productionAppImageId,
      });
      log(`Stopping exact application container ${appContainerId} for restore...`);
      await stopAndVerifyExactAppContainer({
        appContainerId,
        composeDocker,
        docker,
        productionAppImageId,
      });
    }

    let destructiveRestoreStarted = false;
    let supervisedResult;
    try {
      if (applicationMode === 'absent') {
        await proveComposeAppAbsent({ composeDocker });
        await proveComposeAppAbsent({ composeDocker });
      }
      destructiveRestoreStarted = true;
      const assertMutationIsolation = async () => {
        if (applicationMode === 'managed') {
          await proveExactAppAllocation({
            appContainerId,
            composeDocker,
            docker,
            expectedRunning: false,
            productionAppImageId,
          });
        } else {
          await proveComposeAppAbsent({ composeDocker });
        }
      };
      supervisedResult = await runSupervisedRestore({
        archiveBytes: frozenBackup.archiveBytes,
        archiveSha256: frozenBackup.sha256,
        assertMutationIsolation,
        capacityHeadroomBytes: frozenBackup.capacityHeadroomBytes,
        inputHandle: frozenBackup.handle,
        postgresContainerId,
        restoreDeadlineMs,
        runDocker: docker,
      });
      recoveryEvidence = supervisedResult;
      if (applicationMode === 'absent') {
        await proveComposeAppAbsent({ composeDocker });
      }
    } catch (restoreError) {
      const recovery = collectLifecycleRecovery(restoreError);
      restoreError = propagateLifecycleRecovery(restoreError);
      if (recovery.childSettlementUnproven) throw restoreError;
      if (restoreError.retainOperationLock === true) {
        operationLockRetentionReason = 'REMOTE_RESTORE_SETTLEMENT_UNPROVEN';
      }
      recoveryEvidence = restoreError.recoveryEvidence || recoveryEvidence;
      let isolationError;
      try {
        if (applicationMode === 'managed') {
          await stopAndVerifyExactAppContainer({
            appContainerId,
            composeDocker,
            docker,
            productionAppImageId,
          });
        } else {
          await proveComposeAppAbsent({ composeDocker });
        }
      } catch (error) {
        isolationError = error;
      }
      if (destructiveRestoreStarted && isolationError && !operationLockRetentionReason) {
        operationLockRetentionReason = 'APPLICATION_ISOLATION_UNPROVEN_AFTER_DATABASE_RESTORE';
      }
      if (applicationMode === 'managed') {
        log('Restore failed; application remains stopped for operator recovery.');
      } else {
        log('Database-only restore failed; Compose application allocation was rechecked.');
      }
      throw lifecycleFailure(
        restoreError,
        isolationError,
        applicationMode === 'managed'
          ? 'Database restore failed and exact application isolation verification also failed'
          : 'Database-only restore failed and application absence could not be reproved',
      );
    }

    if (applicationMode === 'managed') {
      log(`Starting exact application container ${appContainerId}...`);
      try {
        await docker(['start', appContainerId]);
        await proveExactAppAllocation({
          appContainerId,
          composeDocker,
          docker,
          expectedRunning: true,
          productionAppImageId,
        });
        await checkReadiness({ url: readinessUrl });
      } catch (startError) {
        const recovery = collectLifecycleRecovery(startError);
        startError = propagateLifecycleRecovery(startError);
        if (recovery.childSettlementUnproven) throw startError;
        let cleanupError;
        try {
          await stopAndVerifyExactAppContainer({
            appContainerId,
            composeDocker,
            docker,
            productionAppImageId,
          });
        } catch (error) {
          cleanupError = error;
        }
        if (destructiveRestoreStarted && cleanupError && !operationLockRetentionReason) {
          operationLockRetentionReason = 'APPLICATION_ISOLATION_UNPROVEN_AFTER_DATABASE_RESTORE';
        }
        log('Application start verification failed; restored database remains isolated with the app stopped.');
        throw lifecycleFailure(
          startError,
          cleanupError,
          'Application start verification failed and exact-ID cleanup also failed',
        );
      }
    }
    result = {
      applicationMode,
      backup: resolvedBackup,
      ...(appContainerId ? { appContainerId } : {}),
      backupSha256: frozenBackup.sha256,
    };
  } catch (error) {
    operationError = propagateLifecycleRecovery(error);
  }
  let backupCloseError;
  let localChildSettlementUnproven = operationError
    && collectLifecycleRecovery(operationError).childSettlementUnproven;
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
      operationError,
      backupCloseError,
    ).childSettlementUnproven;
  }
  operationError = lifecycleFailure(
    operationError,
    backupCloseError,
    'Database restore failed and closing its frozen backup descriptor also failed',
  );
  if (frozenBackup && (localChildSettlementUnproven || backupCloseError) && operationError) {
    operationError = propagateLifecycleRecovery(operationError, frozenBackup);
  }
  let lockReleaseError;
  let hostLockReleaseError;
  if (localChildSettlementUnproven) {
    // The durable local-child hold remains the only finalization authority until exact
    // child settlement is proven; neither enclosing guard may transition around it.
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
    if (!lockReleaseError) {
      try {
        await retainHostLock(releaseHostOperation, hostLockReleaseTimeoutMs, {
          ...recoveryEvidence,
          retentionReason: operationLockRetentionReason,
        });
      } catch (error) {
        hostLockReleaseError = error;
      }
    }
  } else {
    try {
      await releaseDatabaseOperationLock(releaseOperationLock, lockReleaseTimeoutMs);
    } catch (error) {
      lockReleaseError = error;
    }
    if (!lockReleaseError) {
      try {
        await releaseHostLock(releaseHostOperation, hostLockReleaseTimeoutMs);
      } catch (error) {
        hostLockReleaseError = error;
      }
    }
  }
  lockReleaseError = lifecycleFailure(
    lockReleaseError,
    hostLockReleaseError,
    'Database and host operation lock finalization both failed',
  );
  if (operationError) {
    throw lifecycleFailure(
      operationError,
      lockReleaseError,
      'Database restore failed and releasing its operation lock also failed',
    );
  }
  if (lockReleaseError) throw lockReleaseError;
  log('Restore completed successfully.');
  return result;
}

async function main() {
  const arguments_ = process.argv.slice(2);
  const managedGrammar = arguments_.length === 2 && arguments_[1] === '--confirm-restore';
  const absentGrammar = arguments_.length === 3
    && arguments_[1] === '--database-only'
    && arguments_[2] === '--confirm-restore';
  if (!arguments_[0] || (!managedGrammar && !absentGrammar)) {
    throw restoreUsageError([
      'Usage: npm run db:restore -- <backup.dump> --confirm-restore',
      '   or: npm run db:restore -- <backup.dump> --database-only --confirm-restore',
    ].join('\n'));
  }
  await restorePostgresBackup({
    applicationMode: absentGrammar ? 'absent' : 'managed',
    backup: arguments_[0],
    postgresExpectedImageId: process.env.EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID,
    productionAppImageId: process.env.EASYBOOST_PRODUCTION_APP_IMAGE_ID,
  });
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = error.exitCode || 1;
  });
}
