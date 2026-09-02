import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
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
} from './database-operation-lock.js';
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
const DEFAULT_MAX_CAPTURE_BYTES = 8 * 1024 * 1024;

function backupUsageError(message) {
  const error = new Error(message);
  error.exitCode = 2;
  return error;
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
    const timer = setTimeout(() => { resolve(value); }, milliseconds);
    timer.unref?.();
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
  capture = false,
  childLifecycle = {},
  commandTimeoutMs = 120_000,
  environment = process.env,
  killGraceMs = 2_000,
  maxCaptureBytes = DEFAULT_MAX_CAPTURE_BYTES,
  operationLock,
  outputFile = null,
  reapTimeoutMs = 2_000,
  spawnProcess = spawn,
  stderrDestination = process.stderr,
} = {}) {
  if (capture && outputFile) throw new Error('Docker command cannot capture and stream output together');
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
      stdio: ['ignore', capture || outputFile ? 'pipe' : 'inherit', 'pipe'],
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
  const outputStream = outputFile
    ? fs.createWriteStream(outputFile, { flags: 'wx', mode: 0o600 })
    : null;
  const outputTask = outputStream ? pipeline(child.stdout, outputStream) : Promise.resolve();
  const stderrTask = forwardChildStderr(child.stderr, stderrDestination);
  const completion = Promise.race([
    Promise.all([closeOutcome, outputTask, stderrTask]).then(([closeResult]) => {
      if (closeResult.exitCode !== 0) {
        throw new Error(`docker ${args.join(' ')} failed with exit code ${closeResult.exitCode}`);
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
  child.stdout?.destroy();
  child.stderr?.destroy();
  child.stdin?.destroy();
  outputStream?.destroy();
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

function defaultBackupDestination() {
  const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
  return path.resolve('backups', `easyboost-${stamp}.dump`);
}

async function proveExactPostgresAllocation({ composeDocker, docker, postgresExpectedImageId }) {
  const postgresContainerId = await composeDocker(
    ['ps', '--all', '--quiet', 'postgres'],
    { capture: true },
  );
  if (!CANONICAL_CONTAINER_ID.test(postgresContainerId)) {
    throw new Error('Database backup requires one canonical PostgreSQL container ID');
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
    throw new Error('Running PostgreSQL identity, ownership or image does not match the approved backup authority');
  }
  return postgresContainerId;
}

export async function createPostgresBackup({
  acquireOperationLock = acquireDatabaseOperationLock,
  destination = defaultBackupDestination(),
  composeFile = path.resolve('compose.production.yml'),
  postgresExpectedImageId,
  productionAppImageId,
  environment = process.env,
  lockFile,
  lockReleaseTimeoutMs = 2_000,
  runDocker = runDockerCommand,
  createDumpProcess = spawn,
  log = console.log,
} = {}) {
  if (!CANONICAL_IMAGE_ID.test(productionAppImageId || '')) {
    throw backupUsageError(
      'EASYBOOST_PRODUCTION_APP_IMAGE_ID must be an owner-approved canonical sha256 image ID',
    );
  }
  if (!CANONICAL_IMAGE_ID.test(postgresExpectedImageId || '')) {
    throw backupUsageError(
      'EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID must be an owner-approved canonical sha256 image ID',
    );
  }
  if (!Number.isSafeInteger(lockReleaseTimeoutMs) || lockReleaseTimeoutMs < 1) {
    throw backupUsageError('Operation lock release timeout must be a positive safe integer');
  }

  const resolvedDestination = path.resolve(destination);
  const operationLockFile = path.resolve(lockFile || DEFAULT_DATABASE_OPERATION_LOCK_FILE);
  const releaseOperationLock = await acquireOperationLock(operationLockFile);
  const temporary = `${resolvedDestination}.${process.pid}.${randomUUID()}.tmp`;
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
  const composeDocker = (args, options) => (
    docker([
      'compose', '--project-name', PRODUCTION_COMPOSE_PROJECT_NAME,
      '-f', composeFile, ...args,
    ], options)
  );

  let operationError;
  let result;
  try {
    const postgresContainerId = await proveExactPostgresAllocation({
      composeDocker,
      docker,
      postgresExpectedImageId,
    });

    await fsp.mkdir(path.dirname(resolvedDestination), { recursive: true });
    try {
      try {
        await fsp.access(resolvedDestination);
        throw new Error(`BACKUP_DESTINATION_ALREADY_EXISTS: ${resolvedDestination}`);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }

      await docker([
        'exec', '-i', postgresContainerId,
        'pg_dump', '-U', 'easyboost', '-d', 'easyboost', '--format=custom', '--no-owner', '--no-privileges',
      ], { outputFile: temporary, spawnProcess: createDumpProcess });

      const stat = await fsp.stat(temporary);
      if (!stat.size) throw new Error('pg_dump created an empty backup');
      try {
        await fsp.link(temporary, resolvedDestination);
      } catch (error) {
        if (error.code === 'EEXIST') {
          throw new Error(`BACKUP_DESTINATION_ALREADY_EXISTS: ${resolvedDestination}`);
        }
        throw error;
      }
      await fsp.rm(temporary);
      log(`Backup created: ${resolvedDestination} (${stat.size} bytes)`);
      result = { destination: resolvedDestination, bytes: stat.size };
    } catch (error) {
      const recovery = collectLifecycleRecovery(error);
      error = propagateLifecycleRecovery(error);
      if (recovery.childSettlementUnproven) {
        log(`Manual recovery required: retain the exact partial backup path ${temporary} until the local Docker process tree is proven absent.`);
        throw error;
      }
      let cleanupError;
      try {
        await fsp.rm(temporary, { force: true });
      } catch (failure) {
        cleanupError = failure;
        log(`Manual recovery required: remove the exact partial backup path ${temporary} after confirming no backup process owns it.`);
      }
      throw commandFailure(error, cleanupError);
    }
  } catch (error) {
    operationError = propagateLifecycleRecovery(error);
  }
  let lockReleaseError;
  if (!operationError || !collectLifecycleRecovery(operationError).childSettlementUnproven) {
    try {
      await releaseDatabaseOperationLock(releaseOperationLock, lockReleaseTimeoutMs);
    } catch (error) {
      lockReleaseError = error;
    }
  }
  if (operationError) throw commandFailure(operationError, lockReleaseError);
  if (lockReleaseError) throw lockReleaseError;
  return result;
}

async function main() {
  await createPostgresBackup({
    destination: process.argv[2],
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
