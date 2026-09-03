import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { isIP } from 'node:net';
import pg from 'pg';
import { config } from '../config.js';
import {
  DEFAULT_DATABASE_OPERATION_LOCK_FILE,
  acquireDatabaseOperationLock,
  beginDatabaseOperationLocalChildHold,
  describeDatabaseOperationLocalChildHold,
  releaseDatabaseOperationLock,
  retainDatabaseOperationLock,
} from './database-operation-lock.js';
import {
  collectLifecycleRecovery,
  isBoundedChildSettled,
  propagateLifecycleRecovery,
  settleLocalChildHold,
  spawnBoundedChild,
  terminateAndReapChild,
} from './bounded-child-lifecycle.js';
import {
  acquireHostOperationLock,
  releaseHostOperationLock,
  retainHostOperationLock,
} from './host-operation-lock.js';
import {
  PRODUCTION_IMPORT_LOCAL_CHILD_RETENTION_REASON,
  assertProductionImportPosixControllerRetentionBound,
  assertProductionImportWindowsControllerRetentionBound,
  createProductionImportLocalChildRecovery,
  normalizeProductionImportChildControllerAuthority,
} from './production-import-local-child-authority.js';

const { Client } = pg;
const PRODUCTION_IMPORT_OWNER_LABEL = 'easyboost.production-import-owner';
const PRODUCTION_COMPOSE_PROJECT = 'easyboost-production';
export const PRODUCTION_IMPORT_PROTOCOL =
  'easyboost-production-json-import-v1;write=append-only;owner=exact;digest=sha256';
const CANONICAL_CONTAINER_ID = /^[0-9a-f]{64}$/u;
const CANONICAL_OPERATION_TOKEN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const DEFAULT_MAXIMUM_SOURCE_BYTES = 256 * 1024 * 1024;
const DEFAULT_ALLOCATION_SETTLEMENT_PROBE_ATTEMPTS = 5;
const DEFAULT_ALLOCATION_SETTLEMENT_PROBE_INTERVAL_MS = 1_000;
const DEFAULT_IMPORT_SETTLEMENT_PROBE_ATTEMPTS = 5;
const DEFAULT_IMPORT_SETTLEMENT_PROBE_INTERVAL_MS = 1_000;
const SOURCE_READ_CHUNK_BYTES = 64 * 1024;
const DATABASE_TARGET_BOUND_IMPORT_WRAPPER = [
  "const { isIP } = require('node:net');",
  "const { spawn } = require('node:child_process');",
  'const [endpoint, applicationName, ...importArguments] = process.argv.slice(1);',
  'function fail() {',
  "  console.error('Bound database import configuration is invalid');",
  '  process.exit(2);',
  '}',
  "if (isIP(endpoint) !== 4 || process.env.DATABASE_PROVIDER !== 'postgres'",
  "    || !/^easyboost_import_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(applicationName || '')) fail();",
  'let databaseUrl;',
  'try { databaseUrl = new URL(process.env.DATABASE_URL); } catch { fail(); }',
  "if (databaseUrl.protocol !== 'postgresql:'",
  "    || databaseUrl.hostname !== 'postgres'",
  "    || databaseUrl.port !== '5432'",
  "    || databaseUrl.pathname !== '/easyboost'",
  "    || databaseUrl.username !== 'easyboost'",
  '    || !databaseUrl.password || databaseUrl.search || databaseUrl.hash) fail();',
  'databaseUrl.hostname = endpoint;',
  "databaseUrl.port = '5432';",
  "databaseUrl.searchParams.set('application_name', applicationName);",
  "const child = spawn(process.execPath, ['scripts/import-json.js', ...importArguments], {",
  '  env: { ...process.env, DATABASE_URL: databaseUrl.toString() },',
  "  stdio: ['ignore', 'inherit', 'inherit'],",
  '});',
  "for (const signal of ['SIGTERM', 'SIGINT']) {",
  '  process.once(signal, () => { try { child.kill(signal); } catch { process.exit(1); } });',
  '}',
  'child.once(\'error\', () => {',
  "  console.error('Bound database import child could not start');",
  '  process.exit(1);',
  '});',
  'child.once(\'close\', (code) => { process.exit(Number.isInteger(code) ? code : 1); });',
].join('\n');
const primaryFirstErrorLists = new WeakMap();
const productionImportUnprovenSettlement = Symbol('production-import-unproven-settlement');
const productionImportLastSettlementProbe = Symbol('production-import-last-settlement-probe');

function productionComposeArguments(composeFile, ...arguments_) {
  return [
    'compose', '--project-name', PRODUCTION_COMPOSE_PROJECT,
    '-f', composeFile, ...arguments_,
  ];
}

function productionImportUsageError(message) {
  const error = new Error(message);
  error.exitCode = 2;
  return error;
}

function prepareDockerLocalChildLifecycle(childLifecycle, spawnProcess) {
  const configuredLifecycle = childLifecycle && typeof childLifecycle === 'object'
    ? { ...childLifecycle }
    : {};
  const platform = configuredLifecycle.platform ?? process.platform;
  const defaultControlKey = `database:${configuredLifecycle.cwd ?? process.cwd()}:docker`;
  const usesOwnedWindowsJob = platform === 'win32'
    && (spawnProcess === spawn || Boolean(configuredLifecycle.forceWindowsJob));
  if (usesOwnedWindowsJob) {
    if (configuredLifecycle.windowsJobInvocation !== undefined) {
      throw new Error(
        'Docker command Windows controller retention bound cannot be proven before spawn',
      );
    }
    const configuredControlRoot = configuredLifecycle.windowsControlRoot ?? os.tmpdir();
    const controlKey = configuredLifecycle.windowsControlKey ?? defaultControlKey;
    assertProductionImportWindowsControllerRetentionBound(configuredControlRoot, controlKey);
    return {
      ...configuredLifecycle,
      platform,
      windowsControlKey: controlKey,
      windowsControlRoot: path.resolve(configuredControlRoot),
    };
  }
  const usesOwnedPosixSession = platform !== 'win32'
    && (spawnProcess === spawn || Boolean(configuredLifecycle.forcePosixSession));
  if (!usesOwnedPosixSession) return configuredLifecycle;

  let preparedLifecycle = { ...configuredLifecycle, platform };
  const configuredControl = configuredLifecycle.posixSessionControl;
  const configuredInvocation = configuredLifecycle.posixSessionInvocation;
  let controlDirectory = configuredControl?.specification?.controlDirectory;
  if (controlDirectory === undefined) {
    if (configuredInvocation !== undefined) {
      throw new Error(
        'Docker command POSIX controller retention bound cannot be proven before spawn',
      );
    }
    const configuredControlRoot = configuredLifecycle.posixControlRoot
      ?? path.join(os.tmpdir(), 'easyboost-posix-session-controls');
    const controlRoot = path.resolve(configuredControlRoot);
    const controlKey = configuredLifecycle.posixControlKey
      ?? defaultControlKey;
    preparedLifecycle = {
      ...preparedLifecycle,
      posixControlKey: controlKey,
      posixControlRoot: controlRoot,
    };
    controlDirectory = path.join(
      controlRoot,
      createHash('sha256').update(controlKey, 'utf8').digest('hex'),
    );
  } else if (configuredInvocation !== undefined) {
    preparedLifecycle = {
      ...preparedLifecycle,
      posixSessionInvocation(...arguments_) {
        const suppliedControl = arguments_[5];
        if (suppliedControl !== configuredControl
            || configuredControl?.specification?.controlDirectory !== controlDirectory) {
          throw new Error(
            'Docker command POSIX controller authority changed after retention preflight',
          );
        }
        const invocation = configuredInvocation(...arguments_);
        if (!invocation || typeof invocation !== 'object'
            || (invocation.posixSessionControl !== undefined
              && invocation.posixSessionControl !== configuredControl)
            || configuredControl?.specification?.controlDirectory !== controlDirectory) {
          throw new Error(
            'Docker command POSIX invocation replaced its preflighted controller authority',
          );
        }
        return {
          ...invocation,
          posixSessionControl: configuredControl,
        };
      },
    };
  }
  assertProductionImportPosixControllerRetentionBound(controlDirectory);
  return preparedLifecycle;
}

function dockerCommandCloseFailure(authority, { exitCode, signal }) {
  if (authority?.kind !== 'posix-owned-session-wrapper') {
    return exitCode === 0 ? null : new Error(`Docker command failed with exit code ${exitCode}`);
  }
  if (exitCode !== null || signal !== 'SIGKILL') {
    return new Error(
      `Docker command POSIX wrapper failed with exit code ${exitCode} and signal ${signal ?? 'none'}`,
    );
  }
  if (typeof authority.targetStatus !== 'function') {
    return new Error('Docker command POSIX target status authority is unavailable');
  }
  let status;
  try {
    status = authority.targetStatus();
  } catch (cause) {
    return new Error('Docker command POSIX target status could not be authenticated', { cause });
  }
  if (status?.state !== 'present') {
    return new Error('Docker command POSIX target status could not be authenticated',
      status?.error ? { cause: status.error } : undefined);
  }
  if (status.errorCode !== null) {
    return new Error(`Docker command target could not start (${status.errorCode ?? 'unknown error'})`);
  }
  if (status.signal !== null) {
    return new Error(`Docker command target failed with signal ${status.signal}`);
  }
  if (!Number.isInteger(status.exitCode)) {
    return new Error('Docker command POSIX target status is incomplete');
  }
  return status.exitCode === 0
    ? null
    : new Error(`Docker command failed with exit code ${status.exitCode}`);
}

export async function runDockerCommand(arguments_, {
  capture = false,
  childLifecycle = {},
  environment = process.env,
  spawnProcess = spawn,
  hardTimeoutMs = 120_000,
  terminateGraceMs = 5_000,
  killGraceMs = 5_000,
  maximumOutputBytes = 1024 * 1024,
  operationLock,
} = {}) {
  for (const [name, value, allowZero] of [
    ['hard timeout', hardTimeoutMs, false],
    ['terminate grace', terminateGraceMs, true],
    ['kill grace', killGraceMs, true],
    ['maximum output bytes', maximumOutputBytes, false],
  ]) {
    if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
      throw new Error(`Docker command ${name} must be a bounded integer`);
    }
  }

  let localChildHold;
  let spawned;
  try {
    const preparedChildLifecycle = prepareDockerLocalChildLifecycle(
      childLifecycle,
      spawnProcess,
    );
    localChildHold = operationLock
      ? await beginDatabaseOperationLocalChildHold(operationLock, {
        commandLabel: `docker ${arguments_.join(' ')}`,
      })
      : null;
    spawned = spawnBoundedChild('docker', arguments_, {
      ...preparedChildLifecycle,
      environment,
      killGraceMs: Math.max(1, terminateGraceMs),
      reapTimeoutMs: Math.max(1, killGraceMs),
      spawnProcess,
      stdio: ['ignore', capture ? 'pipe' : 'inherit', capture ? 'pipe' : 'inherit'],
    });
  } catch (cause) {
    const startFailure = propagateLifecycleRecovery(
      new Error('Docker command could not start', { cause }),
      cause,
    );
    if (collectLifecycleRecovery(startFailure).childSettlementUnproven) {
      throw startFailure;
    }
    throw await settleLocalChildHold(
      localChildHold,
      startFailure,
      'Docker command failed before spawn and releasing its local-child hold also failed',
    );
  }
  const { authority, child, childErrors } = spawned;
  const stdoutChunks = [];
  let outputBytes = 0;
  let streamFailureResolve;
  let streamFailed = false;
  const streamFailure = new Promise((resolve) => { streamFailureResolve = resolve; });
  const failStream = (error) => {
    if (streamFailed) return;
    streamFailed = true;
    streamFailureResolve(error);
  };
  const handleOutput = (chunk, retain) => {
    const buffered = Buffer.from(chunk);
    if (outputBytes + buffered.length > maximumOutputBytes) {
      failStream(new Error(`Docker command output exceeded ${maximumOutputBytes} bytes`));
      return;
    }
    outputBytes += buffered.length;
    if (retain) stdoutChunks.push(buffered);
  };
  if (capture) {
    child.stdout?.on('data', (chunk) => { handleOutput(chunk, true); });
    child.stderr?.on('data', (chunk) => { handleOutput(chunk, false); });
    child.stdout?.once('error', failStream);
    child.stderr?.once('error', failStream);
  }
  let closed = false;
  const closeOutcome = new Promise((resolve) => {
    child.once('close', (exitCode, signal) => {
      closed = true;
      resolve({ exitCode, signal });
    });
  });
  const completion = Promise.race([
    closeOutcome.then((close) => {
      const failure = dockerCommandCloseFailure(authority, close);
      if (failure) throw failure;
    }),
    childErrors.firstError.then((cause) => {
      throw new Error('Docker command could not start', { cause });
    }),
    streamFailure.then((error) => { throw error; }),
  ]);
  const commandTimeout = Symbol('docker-command-timeout');
  let hardTimer;
  const outcome = await Promise.race([
    completion.then(() => null, (error) => error),
    new Promise((resolve) => {
      hardTimer = setTimeout(() => { resolve(commandTimeout); }, hardTimeoutMs);
    }),
  ]);
  clearTimeout(hardTimer);
  let primaryError;
  if (outcome === null) {
    if (isBoundedChildSettled({ authority, isClosed: () => closed })) {
      const holdError = await settleLocalChildHold(
        localChildHold,
        null,
        'Docker command settled but releasing its local-child hold failed',
      );
      if (holdError) throw holdError;
      return Buffer.concat(stdoutChunks).toString('utf8').trim();
    }
    primaryError = new Error(
      `docker ${arguments_.join(' ')} left a descendant process tree after its leader closed`,
    );
  } else {
    primaryError = outcome === commandTimeout
      ? new Error(`Docker command exceeded hard deadline of ${hardTimeoutMs}ms`)
      : outcome;
  }
  child.stdin?.destroy();
  child.stdout?.destroy();
  child.stderr?.destroy();
  const cleanupError = await terminateAndReapChild({
    authority,
    child,
    childErrors,
    closeOutcome,
    commandLabel: `docker ${arguments_.join(' ')}`,
    isClosed: () => closed,
    killGraceMs: terminateGraceMs,
    reapTimeoutMs: killGraceMs,
  });
  const failure = cleanupError
    ? propagateLifecycleRecovery(new AggregateError(
      [primaryError, cleanupError],
      'Docker command lifecycle failed',
      { cause: primaryError },
    ), primaryError, cleanupError)
    : primaryError;
  if (collectLifecycleRecovery(failure).childSettlementUnproven) throw failure;
  throw await settleLocalChildHold(
    localChildHold,
    failure,
    'Docker command failed and releasing its settled local-child hold also failed',
  );
}

function parseOwnedContainerInventory(output) {
  const normalized = String(output || '').trim();
  if (!normalized) return [];
  const containerIds = normalized.split(/\r?\n/u);
  if (containerIds.some((containerId) => !CANONICAL_CONTAINER_ID.test(containerId))) {
    throw new Error('Production import ownership inventory contains a non-canonical container ID');
  }
  return containerIds;
}

async function observeOwnedImportAllocation({
  attempts,
  dockerOptions,
  intervalMs,
  ownershipInventoryArguments,
  runDocker,
  wait,
}) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const inventory = parseOwnedContainerInventory(await runDocker(
      ownershipInventoryArguments,
      { ...dockerOptions, capture: true },
    ));
    if (inventory.length > 1) {
      throw new Error('Production import ownership inventory is ambiguous');
    }
    if (inventory.length === 1) return inventory[0];
    if (attempt < attempts) await wait(intervalMs);
  }
  return null;
}

function parseApplicationContainerInventory(output) {
  const normalized = String(output || '').trim();
  if (!normalized) return [];
  const containerIds = normalized.split(/\r?\n/u);
  if (containerIds.some((containerId) => !CANONICAL_CONTAINER_ID.test(containerId))) {
    throw new Error('Production application inventory contains a non-canonical container ID');
  }
  if (new Set(containerIds).size !== containerIds.length) {
    throw new Error('Production application inventory contains duplicate container IDs');
  }
  return containerIds;
}

async function assertProductionApplicationAllocationAbsent({
  composeFile,
  runDocker,
  dockerOptions,
  allowedOneOffContainerId = null,
  finalBoundary = false,
}) {
  const allocations = parseApplicationContainerInventory(await runDocker(
    productionComposeArguments(composeFile, 'ps', '--all', '--quiet', 'app'),
    { ...dockerOptions, capture: true },
  ));
  const unexpectedAllocations = allocations.filter((containerId) => (
    containerId !== allowedOneOffContainerId
  ));
  if (unexpectedAllocations.length !== 0
    || allocations.length > (allowedOneOffContainerId ? 1 : 0)) {
    throw new Error(finalBoundary
      ? 'Production application allocation appeared before JSON import'
      : 'Production application allocation must be absent before JSON import');
  }
}

async function proveProductionImportContainerAuthority({
  containerId,
  dockerOptions,
  ownershipToken,
  productionAppImageId,
  runDocker,
}) {
  const ownershipLabelTemplate = `{{ index .Config.Labels "${PRODUCTION_IMPORT_OWNER_LABEL}" }}`;
  const recoveredOwnershipToken = await runDocker(
    ['inspect', '--format', ownershipLabelTemplate, containerId],
    { ...dockerOptions, capture: true },
  );
  if (recoveredOwnershipToken !== ownershipToken) {
    throw new Error('Production import ownership label mismatch');
  }
  const resolvedContainerId = await runDocker(
    ['inspect', '--format', '{{.Id}}', containerId],
    { ...dockerOptions, capture: true },
  );
  if (resolvedContainerId !== containerId) {
    throw new Error('Created import container ID could not be resolved immutably');
  }
  const composeProject = await runDocker([
    'inspect', '--format', '{{ index .Config.Labels "com.docker.compose.project" }}', containerId,
  ], { ...dockerOptions, capture: true });
  if (composeProject !== PRODUCTION_COMPOSE_PROJECT) {
    throw new Error('Production import container belongs to a foreign Compose project');
  }
  const composeService = await runDocker([
    'inspect', '--format', '{{ index .Config.Labels "com.docker.compose.service" }}', containerId,
  ], { ...dockerOptions, capture: true });
  if (composeService !== 'app') {
    throw new Error('Production import container does not have exact app service authority');
  }
  const composeOneOff = await runDocker([
    'inspect', '--format', '{{ index .Config.Labels "com.docker.compose.oneoff" }}', containerId,
  ], { ...dockerOptions, capture: true });
  if (composeOneOff !== 'True') {
    throw new Error('Production import container is not an exact Compose one-off');
  }
  const oneOffImageId = await runDocker(
    ['inspect', '--format', '{{.Image}}', containerId],
    { ...dockerOptions, capture: true },
  );
  if (oneOffImageId !== productionAppImageId) {
    throw new Error('Production one-off import container does not use the owner-approved image');
  }
}

function productionImportFailure(errors, message) {
  if (errors.length === 1) return errors[0];
  const failure = new AggregateError(errors, message, { cause: errors[0] });
  primaryFirstErrorLists.set(failure, errors);
  const recoveryEvidence = errors.find((error) => (
    error?.[productionImportUnprovenSettlement]
  ))?.[productionImportUnprovenSettlement];
  if (recoveryEvidence) failure[productionImportUnprovenSettlement] = recoveryEvidence;
  return failure;
}

function markProductionImportSettlementUnproven(
  error,
  recoveryEvidence,
  retentionReason = 'IMPORT_CONTAINER_SETTLEMENT_UNPROVEN',
) {
  error[productionImportUnprovenSettlement] = Object.freeze({
    ...recoveryEvidence,
    retentionReason,
  });
  return error;
}

function productionImportRecoveryEvidence({
  applicationName,
  ownershipToken,
  createdContainerId,
  lastProbe,
  operationToken,
  postgresContainerId,
}) {
  return {
    applicationName,
    kind: 'import',
    operationToken,
    ownershipToken,
    importContainerId: createdContainerId || 'unknown',
    postgresContainerId: postgresContainerId || 'unknown',
    lastProbe: lastProbe || {
      activityCount: 'unknown',
      process: 'UNKNOWN',
      status: 'UNKNOWN',
    },
  };
}

function parseImportActivityCount(output) {
  if (!/^(0|[1-9]\d*)$/u.test(String(output || ''))) {
    throw new Error('Production import pg_stat_activity authority returned malformed evidence');
  }
  const activityCount = Number(output);
  if (!Number.isSafeInteger(activityCount)) {
    throw new Error('Production import pg_stat_activity authority exceeded safe integer range');
  }
  return activityCount;
}

async function proveProductionImportDatabaseSettlement({
  applicationName,
  attempts,
  dockerOptions,
  intervalMs,
  postgresContainerId,
  runDocker,
  wait,
}) {
  let lastProbe = {
    activityCount: 'unknown',
    process: 'UNKNOWN',
    status: 'UNKNOWN',
  };
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let activityCount;
    try {
      activityCount = parseImportActivityCount(await runDocker([
        'exec', '-i', postgresContainerId,
        'psql', '-U', 'easyboost', '-d', 'easyboost', '-At',
        '--set', `appname=${applicationName}`,
        '-c', "SELECT count(*) FROM pg_stat_activity WHERE application_name = :'appname';",
      ], { ...dockerOptions, capture: true }));
    } catch (error) {
      error[productionImportLastSettlementProbe] = Object.freeze({ ...lastProbe });
      throw error;
    }
    lastProbe = {
      activityCount,
      process: activityCount === 0 ? 'NONE' : 'ACTIVE',
      status: activityCount === 0 ? 'INACTIVE' : 'ACTIVE',
    };
    if (activityCount === 0) return { lastProbe, settled: true };
    if (attempt < attempts) await wait(intervalMs);
  }
  return { lastProbe, settled: false };
}

function appendProductionImportFailure(primaryError, secondaryError, message) {
  const primaryErrors = primaryFirstErrorLists.get(primaryError) || [primaryError];
  const failure = productionImportFailure([...primaryErrors, secondaryError], message);
  const recoveryEvidence = primaryError?.[productionImportUnprovenSettlement];
  if (recoveryEvidence) failure[productionImportUnprovenSettlement] = recoveryEvidence;
  return failure;
}

function sameFileIdentity(left, right) {
  return [
    'dev', 'ino', 'mode', 'nlink', 'uid', 'gid', 'size', 'mtimeNs', 'ctimeNs',
  ].every((key) => left[key] === right[key]);
}

function sameFilesystemObject(left, right) {
  return ['dev', 'ino', 'mode', 'uid', 'gid'].every((key) => left[key] === right[key]);
}

function assertRegularSingleLink(stat, description) {
  if (!stat.isFile()) throw new Error(`${description} must be a regular file`);
  if (stat.nlink !== 1n) throw new Error(`${description} must have exactly one filesystem link`);
}

async function closeHandle(handle) {
  if (handle) await handle.close();
}

async function removePrivateSnapshot(snapshotPath, directoryPath) {
  if (snapshotPath) {
    try {
      await fs.unlink(snapshotPath);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  if (directoryPath) await fs.rmdir(directoryPath);
}

async function createProductionSourceSnapshot(source, maximumSourceBytes) {
  const initialStat = await fs.lstat(source, { bigint: true });
  assertRegularSingleLink(initialStat, 'Production JSON import source');
  if (initialStat.size > BigInt(maximumSourceBytes)) {
    throw new Error(`Production JSON import source exceeds ${maximumSourceBytes} bytes`);
  }

  const openFlags = fsSync.constants.O_RDONLY | (fsSync.constants.O_NOFOLLOW || 0);
  let sourceHandle = null;
  let snapshotHandle = null;
  let directoryPath = null;
  let snapshotPath = null;
  let result = null;
  let primaryError = null;
  try {
    sourceHandle = await fs.open(source, openFlags);
    const openedStat = await sourceHandle.stat({ bigint: true });
    assertRegularSingleLink(openedStat, 'Opened production JSON import source');
    if (!sameFileIdentity(initialStat, openedStat)) {
      throw new Error('Production JSON import source changed before descriptor freeze');
    }

    directoryPath = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-json-import-'));
    await fs.chmod(directoryPath, 0o700);
    const directoryStat = await fs.lstat(directoryPath, { bigint: true });
    if (!directoryStat.isDirectory()) {
      throw new Error('Production JSON import snapshot parent must be a private directory');
    }
    if (typeof process.getuid === 'function' && directoryStat.uid !== BigInt(process.getuid())) {
      throw new Error('Production JSON import snapshot parent is not process-owned');
    }
    if (process.platform !== 'win32' && (directoryStat.mode & 0o777n) !== 0o700n) {
      throw new Error('Production JSON import snapshot parent must have mode 0700');
    }

    snapshotPath = path.join(directoryPath, 'source.json');
    snapshotHandle = await fs.open(snapshotPath, 'wx', 0o600);
    await snapshotHandle.chmod(0o600);
    const hash = createHash('sha256');
    const readBuffer = Buffer.allocUnsafe(SOURCE_READ_CHUNK_BYTES);
    const expectedBytes = Number(openedStat.size);
    let totalBytes = 0;
    while (totalBytes < expectedBytes) {
      const readLength = Math.min(readBuffer.length, expectedBytes - totalBytes);
      const { bytesRead } = await sourceHandle.read(readBuffer, 0, readLength, null);
      if (bytesRead === 0) {
        throw new Error('Production JSON import source was truncated during snapshot');
      }
      hash.update(readBuffer.subarray(0, bytesRead));
      let writtenBytes = 0;
      while (writtenBytes < bytesRead) {
        const writeResult = await snapshotHandle.write(
          readBuffer,
          writtenBytes,
          bytesRead - writtenBytes,
          null,
        );
        if (writeResult.bytesWritten === 0) {
          throw new Error('Production JSON import snapshot write made no progress');
        }
        writtenBytes += writeResult.bytesWritten;
      }
      totalBytes += bytesRead;
    }
    const eofProbe = Buffer.allocUnsafe(1);
    const { bytesRead: extraBytes } = await sourceHandle.read(eofProbe, 0, 1, null);
    if (extraBytes !== 0) throw new Error('Production JSON import source grew during snapshot');
    await snapshotHandle.sync();

    const finalDescriptorStat = await sourceHandle.stat({ bigint: true });
    const finalPathStat = await fs.lstat(source, { bigint: true });
    if (!sameFileIdentity(initialStat, finalDescriptorStat)
      || !sameFileIdentity(initialStat, finalPathStat)) {
      throw new Error('Production JSON import source changed during snapshot');
    }
    const snapshotStat = await snapshotHandle.stat({ bigint: true });
    assertRegularSingleLink(snapshotStat, 'Production JSON import private snapshot');
    if (snapshotStat.size !== openedStat.size) {
      throw new Error('Production JSON import private snapshot size mismatch');
    }
    if (typeof process.getuid === 'function' && snapshotStat.uid !== BigInt(process.getuid())) {
      throw new Error('Production JSON import private snapshot is not process-owned');
    }
    if (process.platform !== 'win32' && (snapshotStat.mode & 0o777n) !== 0o600n) {
      throw new Error('Production JSON import private snapshot must have mode 0600');
    }
    const finalDirectoryStat = await fs.lstat(directoryPath, { bigint: true });
    if (!sameFilesystemObject(directoryStat, finalDirectoryStat)) {
      throw new Error('Production JSON import snapshot parent identity changed during creation');
    }
    result = {
      directoryPath,
      directoryStat: finalDirectoryStat,
      path: snapshotPath,
      stat: snapshotStat,
      sourceSha256: hash.digest('hex'),
    };
  } catch (error) {
    primaryError = error;
  }

  const errors = primaryError ? [primaryError] : [];
  for (const handle of [snapshotHandle, sourceHandle]) {
    try {
      await closeHandle(handle);
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    try {
      await removePrivateSnapshot(snapshotPath, directoryPath);
    } catch (error) {
      errors.push(error);
    }
    throw productionImportFailure(errors, 'Production JSON import source snapshot failed');
  }
  return result;
}

async function verifyProductionSourceSnapshot(snapshot) {
  const currentDirectoryStat = await fs.lstat(snapshot.directoryPath, { bigint: true });
  const currentSnapshotStat = await fs.lstat(snapshot.path, { bigint: true });
  if (!currentDirectoryStat.isDirectory()
    || !sameFileIdentity(snapshot.directoryStat, currentDirectoryStat)
    || !sameFileIdentity(snapshot.stat, currentSnapshotStat)) {
    throw new Error('Production JSON import private snapshot identity changed');
  }
  assertRegularSingleLink(currentSnapshotStat, 'Production JSON import private snapshot');
  const openFlags = fsSync.constants.O_RDONLY | (fsSync.constants.O_NOFOLLOW || 0);
  let handle = null;
  let primaryError = null;
  try {
    handle = await fs.open(snapshot.path, openFlags);
    const openedStat = await handle.stat({ bigint: true });
    if (!sameFileIdentity(snapshot.stat, openedStat)) {
      throw new Error('Production JSON import private snapshot descriptor identity changed');
    }
    const hash = createHash('sha256');
    const readBuffer = Buffer.allocUnsafe(SOURCE_READ_CHUNK_BYTES);
    const expectedBytes = Number(openedStat.size);
    let totalBytes = 0;
    while (totalBytes < expectedBytes) {
      const readLength = Math.min(readBuffer.length, expectedBytes - totalBytes);
      const { bytesRead } = await handle.read(readBuffer, 0, readLength, null);
      if (bytesRead === 0) {
        throw new Error('Production JSON import private snapshot was truncated');
      }
      hash.update(readBuffer.subarray(0, bytesRead));
      totalBytes += bytesRead;
    }
    const eofProbe = Buffer.allocUnsafe(1);
    const { bytesRead: extraBytes } = await handle.read(eofProbe, 0, 1, null);
    if (extraBytes !== 0) throw new Error('Production JSON import private snapshot grew');
    const finalDescriptorStat = await handle.stat({ bigint: true });
    const finalPathStat = await fs.lstat(snapshot.path, { bigint: true });
    const finalDirectoryStat = await fs.lstat(snapshot.directoryPath, { bigint: true });
    if (!sameFileIdentity(snapshot.stat, finalDescriptorStat)
      || !sameFileIdentity(snapshot.stat, finalPathStat)
      || !sameFileIdentity(snapshot.directoryStat, finalDirectoryStat)) {
      throw new Error('Production JSON import private snapshot changed during verification');
    }
    if (hash.digest('hex') !== snapshot.sourceSha256) {
      throw new Error('Production JSON import private snapshot digest changed');
    }
  } catch (error) {
    primaryError = error;
  }
  try {
    await closeHandle(handle);
  } catch (error) {
    if (primaryError) {
      throw productionImportFailure(
        [primaryError, error],
        'Production JSON import private snapshot verification and close failed',
      );
    }
    throw error;
  }
  if (primaryError) throw primaryError;
}

async function cleanupProductionSourceSnapshot(snapshot) {
  await verifyProductionSourceSnapshot(snapshot);
  await fs.unlink(snapshot.path);
  const remainingDirectoryStat = await fs.lstat(snapshot.directoryPath, { bigint: true });
  if (!sameFilesystemObject(snapshot.directoryStat, remainingDirectoryStat)) {
    throw new Error('Production JSON import snapshot parent identity changed during cleanup');
  }
  await fs.rmdir(snapshot.directoryPath);
}

async function readDigestBoundJsonSource(source, expectedSourceSha256) {
  const initialStat = await fs.lstat(source, { bigint: true });
  assertRegularSingleLink(initialStat, 'Digest-bound JSON import source');
  if (initialStat.size > BigInt(DEFAULT_MAXIMUM_SOURCE_BYTES)) {
    throw new Error(
      `Digest-bound JSON import source exceeds ${DEFAULT_MAXIMUM_SOURCE_BYTES} bytes`,
    );
  }

  const openFlags = fsSync.constants.O_RDONLY | (fsSync.constants.O_NOFOLLOW || 0);
  let handle = null;
  let primaryError = null;
  let sourceBytes = null;
  let sourceSha256 = null;
  try {
    handle = await fs.open(source, openFlags);
    const openedStat = await handle.stat({ bigint: true });
    assertRegularSingleLink(openedStat, 'Opened digest-bound JSON import source');
    if (!sameFileIdentity(initialStat, openedStat)) {
      throw new Error('Digest-bound JSON import source changed before descriptor read');
    }
    const chunks = [];
    const hash = createHash('sha256');
    const readBuffer = Buffer.allocUnsafe(SOURCE_READ_CHUNK_BYTES);
    const expectedBytes = Number(openedStat.size);
    let totalBytes = 0;
    while (totalBytes < expectedBytes) {
      const readLength = Math.min(readBuffer.length, expectedBytes - totalBytes);
      const { bytesRead } = await handle.read(readBuffer, 0, readLength, null);
      if (bytesRead === 0) throw new Error('Digest-bound JSON import source was truncated');
      const chunk = Buffer.from(readBuffer.subarray(0, bytesRead));
      chunks.push(chunk);
      hash.update(chunk);
      totalBytes += bytesRead;
    }
    const eofProbe = Buffer.allocUnsafe(1);
    const { bytesRead: extraBytes } = await handle.read(eofProbe, 0, 1, null);
    if (extraBytes !== 0) throw new Error('Digest-bound JSON import source grew during read');
    const finalDescriptorStat = await handle.stat({ bigint: true });
    const finalPathStat = await fs.lstat(source, { bigint: true });
    if (!sameFileIdentity(initialStat, finalDescriptorStat)
      || !sameFileIdentity(initialStat, finalPathStat)) {
      throw new Error('Digest-bound JSON import source changed during descriptor read');
    }
    sourceBytes = Buffer.concat(chunks, totalBytes);
    sourceSha256 = hash.digest('hex');
  } catch (error) {
    primaryError = error;
  }

  try {
    await closeHandle(handle);
  } catch (error) {
    if (primaryError) {
      throw productionImportFailure(
        [primaryError, error],
        'Digest-bound JSON import source read and close failed',
      );
    }
    throw error;
  }
  if (primaryError) throw primaryError;
  if (sourceSha256 !== expectedSourceSha256) {
    throw new Error(
      `JSON import source digest mismatch: expected ${expectedSourceSha256}, `
      + `received ${sourceSha256}`,
    );
  }
  return JSON.parse(sourceBytes.toString('utf8'));
}

function parseProductionPostgresEndpoint(output) {
  let networks;
  try {
    networks = JSON.parse(output);
  } catch (cause) {
    throw new Error('Production PostgreSQL network allocation is not valid JSON', { cause });
  }
  if (!networks || typeof networks !== 'object' || Array.isArray(networks)) {
    throw new Error('Production PostgreSQL network allocation must be an object');
  }
  const networkNames = Object.keys(networks);
  if (networkNames.length !== 1) {
    throw new Error('Production PostgreSQL must have exactly one inspected network endpoint');
  }
  const [networkName] = networkNames;
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(networkName)) {
    throw new Error('Production PostgreSQL network name is not canonical');
  }
  const allocation = networks[networkName];
  if (!allocation || typeof allocation !== 'object' || Array.isArray(allocation)) {
    throw new Error('Production PostgreSQL network endpoint is malformed');
  }
  const endpoint = allocation.IPAddress;
  if (typeof endpoint !== 'string' || isIP(endpoint) !== 4) {
    throw new Error('Production PostgreSQL network endpoint must be a canonical IPv4 address');
  }
  const octets = endpoint.split('.').map(Number);
  if (octets[0] === 0 || octets[0] === 127 || octets[0] >= 224
    || (octets[0] === 169 && octets[1] === 254)
    || octets.every((octet) => octet === 255)) {
    throw new Error('Production PostgreSQL network endpoint is not a usable unicast address');
  }
  return Object.freeze({ endpoint, networkName });
}

async function proveProductionPostgres({
  composeFile,
  postgresImageId,
  runDocker,
  dockerOptions,
  readinessAttempts,
  readinessIntervalMs,
  wait,
  expectedBinding = null,
}) {
  const postgresContainerId = await runDocker(
    productionComposeArguments(composeFile, 'ps', '--all', '--quiet', 'postgres'),
    { ...dockerOptions, capture: true },
  );
  if (!CANONICAL_CONTAINER_ID.test(postgresContainerId)) {
    throw new Error('Production PostgreSQL service must resolve to one canonical container ID');
  }
  if (expectedBinding && postgresContainerId !== expectedBinding.containerId) {
    throw new Error('Production PostgreSQL allocation changed before import');
  }
  const postgresAuthorityTemplate = [
    '{{.Id}}',
    '{{.Image}}',
    '{{ index .Config.Labels "com.docker.compose.project" }}',
    '{{ index .Config.Labels "com.docker.compose.service" }}',
    '{{ index .Config.Labels "com.docker.compose.oneoff" }}',
    '{{.State.Running}}',
  ].join('|');
  const postgresAuthority = await runDocker([
    'inspect', '--format', postgresAuthorityTemplate, postgresContainerId,
  ], { ...dockerOptions, capture: true });
  if (postgresAuthority !== [
    postgresContainerId,
    postgresImageId,
    PRODUCTION_COMPOSE_PROJECT,
    'postgres',
    'False',
    'true',
  ].join('|')) {
    throw new Error('canonical PostgreSQL container identity does not match owner authority');
  }
  const networkBinding = parseProductionPostgresEndpoint(await runDocker([
    'inspect', '--format', '{{json .NetworkSettings.Networks}}', postgresContainerId,
  ], { ...dockerOptions, capture: true }));
  if (expectedBinding
    && (networkBinding.networkName !== expectedBinding.networkName
      || networkBinding.endpoint !== expectedBinding.endpoint)) {
    throw new Error('Production PostgreSQL network endpoint changed before import');
  }
  let readinessError = null;
  for (let attempt = 1; attempt <= readinessAttempts; attempt += 1) {
    try {
      await runDocker([
        'exec', postgresContainerId, 'pg_isready', '-t', '2', '-U', 'easyboost', '-d', 'easyboost',
      ], { ...dockerOptions, capture: true });
      return Object.freeze({
        containerId: postgresContainerId,
        endpoint: networkBinding.endpoint,
        networkName: networkBinding.networkName,
      });
    } catch (error) {
      if (collectLifecycleRecovery(error).childSettlementUnproven) {
        throw propagateLifecycleRecovery(error);
      }
      readinessError = error;
      if (attempt < readinessAttempts) await wait(readinessIntervalMs);
    }
  }
  throw new Error(
    `PostgreSQL readiness check failed after ${readinessAttempts} attempts`,
    { cause: readinessError },
  );
}

function parseProductionImportReport(output, { dryRun, source }) {
  let report;
  try {
    report = JSON.parse(output);
  } catch (cause) {
    throw new Error('Production JSON import must emit exactly one JSON report', { cause });
  }
  if (!report || typeof report !== 'object' || Array.isArray(report)
    || report.dryRun !== dryRun || report.source !== source
    || !Number.isSafeInteger(report.users) || report.users < 0
    || !Number.isSafeInteger(report.learnerIdentities) || report.learnerIdentities < 0
    || !Number.isSafeInteger(report.progress) || report.progress < 0
    || !Array.isArray(report.skipped)) {
    throw new Error('Production JSON import emitted an invalid JSON report');
  }
  return report;
}

function importedDate(value, fallback = new Date()) {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : fallback;
}

export function createJsonImportPlan(parsed, { source = '' } = {}) {
  const users = parsed?.users && typeof parsed.users === 'object' ? parsed.users : {};
  const progress = parsed?.progress && typeof parsed.progress === 'object' ? parsed.progress : {};
  const learnerIdentities = Array.isArray(parsed?.learner_identities) ? parsed.learner_identities : [];
  const identitiesByUsername = new Map();
  for (const identity of learnerIdentities) {
    const username = String(identity?.username || '');
    if (!username) continue;
    const current = identitiesByUsername.get(username) || [];
    current.push(identity);
    identitiesByUsername.set(username, current);
  }

  const report = { source, users: 0, learnerIdentities: 0, progress: 0, skipped: [] };
  const entries = [];
  for (const [username, user] of Object.entries(users)) {
    const providerIdentities = identitiesByUsername.get(username) || [];
    const legacyIdentity = Boolean(user?.hash) || user?.telegram_id != null;
    const providerIdentity = user?.identity_managed === true
      && !user.hash && user.telegram_id == null && providerIdentities.length === 1;
    if (!username || (!legacyIdentity && !providerIdentity)) {
      report.skipped.push({ username, reason: 'missing identity' });
      continue;
    }
    entries.push({
      username,
      user,
      identity: providerIdentity ? providerIdentities[0] : null,
      progress: progress[username] && typeof progress[username] === 'object'
        ? progress[username]
        : null,
    });
    report.users += 1;
    if (providerIdentity) report.learnerIdentities += 1;
    if (progress[username] && typeof progress[username] === 'object') report.progress += 1;
  }
  return { entries, report };
}

async function importUser(client, entry) {
  const { username, user, identity } = entry;
  const result = await client.query(
    `INSERT INTO users (
       username, password_hash, telegram_id, identity_managed, display_name,
       trial_used, subscription_until, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
     ON CONFLICT (username) DO NOTHING
     RETURNING username`,
    [
      username,
      user.hash || null,
      user.telegram_id == null ? null : String(user.telegram_id),
      Boolean(identity),
      identity ? String(user.display_name || '') : null,
      Boolean(user.trial_used),
      user.sub_until ? importedDate(Number(user.sub_until), null) : null,
      user.created ? importedDate(Number(user.created)) : new Date(),
    ],
  );
  if (result.rowCount !== 1) throw new Error('IMPORT_EXISTING_USER_CONFLICT');
}

async function importLearnerIdentity(client, entry) {
  if (!entry.identity) return;
  const { provider, subject, created_at: createdAt, updated_at: updatedAt } = entry.identity;
  const result = await client.query(
    `INSERT INTO learner_identities (provider, subject, username, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (provider, subject) DO NOTHING
     RETURNING username`,
    [
      String(provider || ''),
      String(subject || ''),
      entry.username,
      importedDate(createdAt),
      importedDate(updatedAt),
    ],
  );
  if (result.rowCount !== 1) throw new Error('IMPORT_PROVIDER_IDENTITY_CONFLICT');
}

async function importProgress(client, entry) {
  if (!entry.progress) return;
  const result = await client.query(
    `INSERT INTO user_progress (username, data, updated_at)
     VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (username) DO NOTHING
     RETURNING username`,
    [entry.username, JSON.stringify(entry.progress)],
  );
  if (result.rowCount !== 1) throw new Error('IMPORT_EXISTING_PROGRESS_CONFLICT');
}

export async function importJsonData(parsed, { source = '', client } = {}) {
  if (!client || typeof client.query !== 'function') throw new Error('IMPORT_CLIENT_REQUIRED');
  const plan = createJsonImportPlan(parsed, { source });
  await client.query('BEGIN');
  try {
    for (const entry of plan.entries) {
      await importUser(client, entry);
      await importLearnerIdentity(client, entry);
      await importProgress(client, entry);
    }
    await client.query('COMMIT');
    return plan.report;
  } catch (primaryError) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      throw productionImportFailure(
        [primaryError, rollbackError],
        'JSON import failed and transaction rollback also failed',
      );
    }
    throw primaryError;
  }
}

export async function runConnectedJsonImport(parsed, {
  source = '', client, onReport = () => {},
} = {}) {
  let report;
  let primaryError = null;
  try {
    report = await importJsonData(parsed, { source, client });
    await onReport(report);
  } catch (error) {
    primaryError = error;
  }

  let disconnectError = null;
  try {
    await client.end();
  } catch (error) {
    disconnectError = error;
  }

  if (primaryError && disconnectError) {
    throw appendProductionImportFailure(
      primaryError,
      disconnectError,
      'JSON import failed and database disconnect also failed',
    );
  }
  if (primaryError) throw primaryError;
  if (disconnectError) throw disconnectError;
  return report;
}

async function runProductionComposeJsonImportWithSnapshot({
  source,
  snapshot,
  dryRun = false,
  expectedSourceSha256 = null,
  composeFile = path.resolve('compose.production.yml'),
  containerName = `easyboost-json-import-${process.pid}-${Date.now()}`,
  operationToken = randomUUID(),
  ownershipToken = randomBytes(32).toString('hex'),
  environment = process.env,
  runDocker = runDockerCommand,
  allocationSettlementProbeAttempts = DEFAULT_ALLOCATION_SETTLEMENT_PROBE_ATTEMPTS,
  allocationSettlementProbeIntervalMs = DEFAULT_ALLOCATION_SETTLEMENT_PROBE_INTERVAL_MS,
  postgresReadinessAttempts = 30,
  postgresReadinessIntervalMs = 1000,
  importSettlementProbeAttempts = DEFAULT_IMPORT_SETTLEMENT_PROBE_ATTEMPTS,
  importSettlementProbeIntervalMs = DEFAULT_IMPORT_SETTLEMENT_PROBE_INTERVAL_MS,
  operationLock,
  wait = (milliseconds) => new Promise((resolve) => { setTimeout(resolve, milliseconds); }),
} = {}) {
  const productionAppImageId = environment.EASYBOOST_PRODUCTION_APP_IMAGE_ID;
  if (!/^sha256:[0-9a-f]{64}$/u.test(productionAppImageId || '')) {
    throw productionImportUsageError(
      'EASYBOOST_PRODUCTION_APP_IMAGE_ID must be an owner-approved canonical sha256 image ID',
    );
  }
  const postgresImageId = environment.EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID;
  if (!/^sha256:[0-9a-f]{64}$/u.test(postgresImageId || '')) {
    throw productionImportUsageError(
      'EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID must be an owner-approved canonical sha256 image ID',
    );
  }
  if (!dryRun && !/^[0-9a-f]{64}$/u.test(expectedSourceSha256 || '')) {
    throw productionImportUsageError(
      'live production JSON import requires an exact --expected-source-sha256 digest',
    );
  }
  if (!Number.isSafeInteger(postgresReadinessAttempts) || postgresReadinessAttempts < 1) {
    throw productionImportUsageError('PostgreSQL readiness attempts must be a positive integer');
  }
  if (!Number.isSafeInteger(postgresReadinessIntervalMs) || postgresReadinessIntervalMs < 0) {
    throw productionImportUsageError('PostgreSQL readiness interval must be a non-negative integer');
  }
  if (!source || !path.isAbsolute(source)) {
    throw productionImportUsageError('Production JSON import requires an absolute source path');
  }
  if (!/^[0-9a-f]{64}$/u.test(ownershipToken)) {
    throw productionImportUsageError('Production JSON import ownership token must be canonical');
  }
  if (!CANONICAL_OPERATION_TOKEN.test(operationToken || '')) {
    throw productionImportUsageError('Production JSON import operation token must be a canonical random UUID');
  }
  if (!Number.isSafeInteger(allocationSettlementProbeAttempts)
      || allocationSettlementProbeAttempts < 2 || allocationSettlementProbeAttempts > 60) {
    throw productionImportUsageError('Allocation settlement probe attempts must be between 2 and 60');
  }
  if (!Number.isSafeInteger(allocationSettlementProbeIntervalMs)
      || allocationSettlementProbeIntervalMs < 1
      || allocationSettlementProbeIntervalMs > 60_000) {
    throw productionImportUsageError(
      'Allocation settlement probe interval must be between 1 and 60000ms',
    );
  }
  if (!Number.isSafeInteger(importSettlementProbeAttempts)
      || importSettlementProbeAttempts < 1 || importSettlementProbeAttempts > 60) {
    throw productionImportUsageError('Import settlement probe attempts must be between 1 and 60');
  }
  if (!Number.isSafeInteger(importSettlementProbeIntervalMs)
      || importSettlementProbeIntervalMs < 1 || importSettlementProbeIntervalMs > 60_000) {
    throw productionImportUsageError('Import settlement probe interval must be between 1 and 60000ms');
  }
  const resolvedSource = path.resolve(source);
  const applicationName = `easyboost_import_${operationToken}`;
  const dockerEnvironment = {
    ...environment,
    EASYBOOST_PRODUCTION_APP_IMAGE_ID: productionAppImageId,
    EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID: postgresImageId,
  };
  const dockerOptions = { environment: dockerEnvironment, operationLock };
  const containerSource = '/tmp/easyboost-legacy-data.json';
  const ownershipLabel = `${PRODUCTION_IMPORT_OWNER_LABEL}=${ownershipToken}`;
  const ownershipInventoryArguments = [
    'ps', '--all', '--quiet', '--no-trunc', '--filter', `label=${ownershipLabel}`,
  ];
  const preflightImageId = await runDocker(
    ['image', 'inspect', '--format', '{{.Id}}', productionAppImageId],
    { ...dockerOptions, capture: true },
  );
  if (preflightImageId !== productionAppImageId) {
    throw new Error('Owner-approved application image is unavailable before legacy import');
  }
  await assertProductionApplicationAllocationAbsent({
    composeFile,
    runDocker,
    dockerOptions,
  });
  const postgresBinding = await proveProductionPostgres({
    composeFile,
    postgresImageId,
    runDocker,
    dockerOptions,
    readinessAttempts: postgresReadinessAttempts,
    readinessIntervalMs: postgresReadinessIntervalMs,
    wait,
  });
  const preflightOwnershipInventory = parseOwnedContainerInventory(await runDocker(
    ownershipInventoryArguments,
    { ...dockerOptions, capture: true },
  ));
  if (preflightOwnershipInventory.length !== 0) {
    throw new Error('Production import ownership label is already allocated');
  }

  let allocationSucceeded = false;
  let allocationOutput = '';
  let allocationError = null;
  try {
    allocationOutput = await runDocker([
      ...productionComposeArguments(composeFile, 'run'), '--rm', '--detach', '--no-deps',
      '--label', ownershipLabel,
      '--name', containerName, '--entrypoint', 'sleep', 'app', '3600',
    ], { ...dockerOptions, capture: true });
    allocationSucceeded = true;
  } catch (error) {
    allocationError = error;
  }
  if (collectLifecycleRecovery(allocationError).childSettlementUnproven) {
    throw propagateLifecycleRecovery(allocationError);
  }

  let createdContainerId = null;
  let allocationObservationQuiet = false;
  let recoveryError = null;
  try {
    const recoveredContainerId = await observeOwnedImportAllocation({
      attempts: allocationSettlementProbeAttempts,
      dockerOptions,
      intervalMs: allocationSettlementProbeIntervalMs,
      ownershipInventoryArguments,
      runDocker,
      wait,
    });
    allocationObservationQuiet = !recoveredContainerId;
    if (allocationSucceeded && !recoveredContainerId) {
      throw new Error('Successful production import allocation has no unique owned container');
    }
    if (recoveredContainerId) {
      await proveProductionImportContainerAuthority({
        containerId: recoveredContainerId,
        dockerOptions,
        ownershipToken,
        productionAppImageId,
        runDocker,
      });
      createdContainerId = recoveredContainerId;
      if (CANONICAL_CONTAINER_ID.test(allocationOutput)
        && allocationOutput !== createdContainerId) {
        throw new Error('Compose output conflicts with the recovered immutable container ID');
      }
    }
  } catch (error) {
    recoveryError = error;
  }

  const allocationStageErrors = [allocationError, recoveryError].filter(Boolean);
  if (allocationStageErrors.length > 0) {
    let settlementProven = allocationObservationQuiet;
    if (createdContainerId) {
      try {
        await proveProductionPostgres({
          composeFile,
          postgresImageId,
          runDocker,
          dockerOptions,
          readinessAttempts: postgresReadinessAttempts,
          readinessIntervalMs: postgresReadinessIntervalMs,
          wait,
          expectedBinding: postgresBinding,
        });
        await assertProductionApplicationAllocationAbsent({
          composeFile,
          runDocker,
          dockerOptions,
          allowedOneOffContainerId: createdContainerId,
        });
        await runDocker(
          ['rm', '--force', createdContainerId],
          { ...dockerOptions, capture: true },
        );
        createdContainerId = null;
        const delayedReplacementId = await observeOwnedImportAllocation({
          attempts: allocationSettlementProbeAttempts,
          dockerOptions,
          intervalMs: allocationSettlementProbeIntervalMs,
          ownershipInventoryArguments,
          runDocker,
          wait,
        });
        if (delayedReplacementId) {
          await proveProductionImportContainerAuthority({
            containerId: delayedReplacementId,
            dockerOptions,
            ownershipToken,
            productionAppImageId,
            runDocker,
          });
          createdContainerId = delayedReplacementId;
          throw new Error('Production import allocation reappeared after exact removal');
        }
        await proveProductionPostgres({
          composeFile,
          postgresImageId,
          runDocker,
          dockerOptions,
          readinessAttempts: postgresReadinessAttempts,
          readinessIntervalMs: postgresReadinessIntervalMs,
          wait,
          expectedBinding: postgresBinding,
        });
        await assertProductionApplicationAllocationAbsent({
          composeFile,
          runDocker,
          dockerOptions,
        });
        settlementProven = true;
      } catch (error) {
        allocationStageErrors.push(error);
        settlementProven = false;
      }
    } else if (settlementProven) {
      try {
        await proveProductionPostgres({
          composeFile,
          postgresImageId,
          runDocker,
          dockerOptions,
          readinessAttempts: postgresReadinessAttempts,
          readinessIntervalMs: postgresReadinessIntervalMs,
          wait,
          expectedBinding: postgresBinding,
        });
        await assertProductionApplicationAllocationAbsent({
          composeFile,
          runDocker,
          dockerOptions,
        });
      } catch (error) {
        allocationStageErrors.push(error);
        settlementProven = false;
      }
    }
    const failure = productionImportFailure(
      allocationStageErrors,
      'Production import allocation failed and ownership recovery or cleanup also failed',
    );
    if (!settlementProven) {
      markProductionImportSettlementUnproven(failure, productionImportRecoveryEvidence({
        applicationName,
        ownershipToken,
        createdContainerId,
        operationToken,
        postgresContainerId: postgresBinding.containerId,
      }));
    }
    throw failure;
  }

  let importResult;
  let primaryError = null;
  let databaseMutationMayBeRemote = false;
  let lastSettlementProbe = {
    activityCount: 0,
    process: 'NONE',
    status: 'NOT_STARTED',
  };
  try {
    const oneOffRunning = await runDocker(
      ['inspect', '--format', '{{.State.Running}}', createdContainerId],
      { ...dockerOptions, capture: true },
    );
    if (oneOffRunning !== 'true') {
      throw new Error('Production one-off import container is not running');
    }
    const importProtocol = await runDocker([
      'exec', '-i', createdContainerId, 'node', 'scripts/import-json.js',
      '--print-production-import-protocol',
    ], { ...dockerOptions, capture: true });
    if (importProtocol !== PRODUCTION_IMPORT_PROTOCOL) {
      throw new Error('Production application image does not attest the required append-only import protocol');
    }
    await verifyProductionSourceSnapshot(snapshot);
    await runDocker(
      ['cp', snapshot.path, `${createdContainerId}:${containerSource}`],
      dockerOptions,
    );
    await verifyProductionSourceSnapshot(snapshot);
    await runDocker([
      'exec', '--user', 'root', createdContainerId, 'chown', 'node:node', containerSource,
    ], dockerOptions);
    // Compose DNS is mutable. Re-prove the immutable allocation at the last possible boundary,
    // then pass only its inspected endpoint to an in-container wrapper. The wrapper rewrites the
    // hostname of its existing DATABASE_URL without ever rendering the credential on the host.
    await proveProductionPostgres({
      composeFile,
      postgresImageId,
      runDocker,
      dockerOptions,
      readinessAttempts: postgresReadinessAttempts,
      readinessIntervalMs: postgresReadinessIntervalMs,
      wait,
      expectedBinding: postgresBinding,
    });
    await assertProductionApplicationAllocationAbsent({
      composeFile,
      runDocker,
      dockerOptions,
      allowedOneOffContainerId: createdContainerId,
      finalBoundary: true,
    });
    databaseMutationMayBeRemote = true;
    lastSettlementProbe = {
      activityCount: 'unknown',
      process: 'UNKNOWN',
      status: 'UNKNOWN',
    };
    const reportOutput = await runDocker([
      'exec', '-i', createdContainerId, 'node', '-e', DATABASE_TARGET_BOUND_IMPORT_WRAPPER,
      postgresBinding.endpoint,
      applicationName,
      containerSource, '--expected-source-sha256', snapshot.sourceSha256,
      ...(dryRun ? ['--dry-run'] : []),
    ], { ...dockerOptions, capture: true });
    databaseMutationMayBeRemote = false;
    lastSettlementProbe = {
      activityCount: 0,
      process: 'NONE',
      status: 'COMPLETE',
    };
    const report = parseProductionImportReport(reportOutput, {
      dryRun,
      source: containerSource,
    });
    importResult = {
      dryRun,
      source: resolvedSource,
      sourceSha256: snapshot.sourceSha256,
      report,
    };
  } catch (error) {
    primaryError = error;
  }
  if (collectLifecycleRecovery(primaryError).childSettlementUnproven) {
    throw propagateLifecycleRecovery(primaryError);
  }

  let cleanupError = null;
  if (createdContainerId) {
    try {
      await runDocker(
        ['rm', '--force', createdContainerId],
        { ...dockerOptions, capture: true },
      );
    } catch (error) {
      cleanupError = error;
    }
  }
  if (collectLifecycleRecovery(primaryError, cleanupError).childSettlementUnproven) {
    const localChildFailure = productionImportFailure(
      [primaryError, cleanupError].filter(Boolean),
      'Legacy import failed and local Docker child settlement is unproven',
    );
    throw propagateLifecycleRecovery(localChildFailure, primaryError, cleanupError);
  }
  let settlementError = null;
  if (primaryError && !cleanupError && databaseMutationMayBeRemote) {
    try {
      const settlement = await proveProductionImportDatabaseSettlement({
        applicationName,
        attempts: importSettlementProbeAttempts,
        dockerOptions,
        intervalMs: importSettlementProbeIntervalMs,
        postgresContainerId: postgresBinding.containerId,
        runDocker,
        wait,
      });
      lastSettlementProbe = settlement.lastProbe;
      if (!settlement.settled) {
        settlementError = new Error(
          'Production import PostgreSQL activity did not settle within the bounded probe window',
        );
      } else {
        databaseMutationMayBeRemote = false;
      }
    } catch (error) {
      lastSettlementProbe = error[productionImportLastSettlementProbe]
        || lastSettlementProbe;
      settlementError = error;
    }
  }
  if (primaryError && cleanupError) {
    throw markProductionImportSettlementUnproven(productionImportFailure(
      [primaryError, cleanupError],
      'Legacy import failed and immutable container cleanup also failed',
    ), productionImportRecoveryEvidence({
      applicationName,
      ownershipToken,
      createdContainerId,
      lastProbe: lastSettlementProbe,
      operationToken,
      postgresContainerId: postgresBinding.containerId,
    }));
  }
  if (primaryError && settlementError) {
    throw markProductionImportSettlementUnproven(productionImportFailure(
      [primaryError, settlementError],
      'Legacy import failed and PostgreSQL settlement could not be proven',
    ), productionImportRecoveryEvidence({
      applicationName,
      ownershipToken,
      createdContainerId,
      lastProbe: lastSettlementProbe,
      operationToken,
      postgresContainerId: postgresBinding.containerId,
    }), 'IMPORT_REMOTE_SETTLEMENT_UNPROVEN');
  }
  if (primaryError) throw primaryError;
  if (cleanupError) {
    throw markProductionImportSettlementUnproven(cleanupError, productionImportRecoveryEvidence({
      applicationName,
      ownershipToken,
      createdContainerId,
      lastProbe: lastSettlementProbe,
      operationToken,
      postgresContainerId: postgresBinding.containerId,
    }));
  }
  return importResult;
}

export async function runProductionComposeJsonImport({
  acquireOperationLock = acquireDatabaseOperationLock,
  acquireHostOperation = acquireHostOperationLock,
  releaseHostOperation = releaseHostOperationLock,
  retainOperationLock = retainDatabaseOperationLock,
  retainHostOperation = retainHostOperationLock,
  source,
  dryRun = false,
  expectedSourceSha256 = null,
  composeFile = path.resolve('compose.production.yml'),
  containerName = `easyboost-json-import-${process.pid}-${Date.now()}`,
  operationToken = randomUUID(),
  ownershipToken = randomBytes(32).toString('hex'),
  environment = process.env,
  runDocker = runDockerCommand,
  allocationSettlementProbeAttempts = DEFAULT_ALLOCATION_SETTLEMENT_PROBE_ATTEMPTS,
  allocationSettlementProbeIntervalMs = DEFAULT_ALLOCATION_SETTLEMENT_PROBE_INTERVAL_MS,
  postgresReadinessAttempts = 30,
  postgresReadinessIntervalMs = 1000,
  importSettlementProbeAttempts = DEFAULT_IMPORT_SETTLEMENT_PROBE_ATTEMPTS,
  importSettlementProbeIntervalMs = DEFAULT_IMPORT_SETTLEMENT_PROBE_INTERVAL_MS,
  wait = (milliseconds) => new Promise((resolve) => { setTimeout(resolve, milliseconds); }),
  hostLockDirectory,
  hostLockReleaseTimeoutMs = 2_000,
  lockFile,
  lockReleaseTimeoutMs = 2_000,
  maximumSourceBytes = DEFAULT_MAXIMUM_SOURCE_BYTES,
} = {}) {
  const productionAppImageId = environment.EASYBOOST_PRODUCTION_APP_IMAGE_ID;
  if (!/^sha256:[0-9a-f]{64}$/u.test(productionAppImageId || '')) {
    throw productionImportUsageError(
      'EASYBOOST_PRODUCTION_APP_IMAGE_ID must be an owner-approved canonical sha256 image ID',
    );
  }
  const postgresImageId = environment.EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID;
  if (!/^sha256:[0-9a-f]{64}$/u.test(postgresImageId || '')) {
    throw productionImportUsageError(
      'EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID must be an owner-approved canonical sha256 image ID',
    );
  }
  if (!source || !path.isAbsolute(source)) {
    throw productionImportUsageError('Production JSON import requires an absolute source path');
  }
  if (!/^[0-9a-f]{64}$/u.test(ownershipToken)) {
    throw productionImportUsageError('Production JSON import ownership token must be canonical');
  }
  if (!CANONICAL_OPERATION_TOKEN.test(operationToken || '')) {
    throw productionImportUsageError('Production JSON import operation token must be a canonical random UUID');
  }
  if (!Number.isSafeInteger(allocationSettlementProbeAttempts)
      || allocationSettlementProbeAttempts < 2 || allocationSettlementProbeAttempts > 60) {
    throw productionImportUsageError('Allocation settlement probe attempts must be between 2 and 60');
  }
  if (!Number.isSafeInteger(allocationSettlementProbeIntervalMs)
      || allocationSettlementProbeIntervalMs < 1
      || allocationSettlementProbeIntervalMs > 60_000) {
    throw productionImportUsageError(
      'Allocation settlement probe interval must be between 1 and 60000ms',
    );
  }
  if (!dryRun && !/^[0-9a-f]{64}$/u.test(expectedSourceSha256 || '')) {
    throw productionImportUsageError(
      'live production JSON import requires an exact --expected-source-sha256 digest',
    );
  }
  if (!Number.isSafeInteger(postgresReadinessAttempts) || postgresReadinessAttempts < 1) {
    throw productionImportUsageError('PostgreSQL readiness attempts must be a positive integer');
  }
  if (!Number.isSafeInteger(postgresReadinessIntervalMs) || postgresReadinessIntervalMs < 0) {
    throw productionImportUsageError('PostgreSQL readiness interval must be a non-negative integer');
  }
  if (!Number.isSafeInteger(importSettlementProbeAttempts)
      || importSettlementProbeAttempts < 1 || importSettlementProbeAttempts > 60) {
    throw productionImportUsageError('Import settlement probe attempts must be between 1 and 60');
  }
  if (!Number.isSafeInteger(importSettlementProbeIntervalMs)
      || importSettlementProbeIntervalMs < 1 || importSettlementProbeIntervalMs > 60_000) {
    throw productionImportUsageError('Import settlement probe interval must be between 1 and 60000ms');
  }
  if (!Number.isSafeInteger(maximumSourceBytes) || maximumSourceBytes < 1) {
    throw productionImportUsageError('Production JSON import source byte limit must be positive');
  }
  if (!Number.isSafeInteger(lockReleaseTimeoutMs) || lockReleaseTimeoutMs < 1) {
    throw productionImportUsageError('Operation lock release timeout must be a positive integer');
  }
  if (!Number.isSafeInteger(hostLockReleaseTimeoutMs) || hostLockReleaseTimeoutMs < 1) {
    throw productionImportUsageError('Host operation lock release timeout must be a positive integer');
  }

  const resolvedSource = path.resolve(source);
  const operationLockFile = path.resolve(lockFile || DEFAULT_DATABASE_OPERATION_LOCK_FILE);
  const releaseHostLock = await acquireHostOperation({
    environment,
    lockDirectory: hostLockDirectory,
    operation: 'database-import',
  });
  let releaseOperationLock = null;
  let snapshot = null;
  let importResult = null;
  let operationError = null;
  try {
    releaseOperationLock = await acquireOperationLock(operationLockFile);
    snapshot = await createProductionSourceSnapshot(resolvedSource, maximumSourceBytes);
    if (!dryRun && snapshot.sourceSha256 !== expectedSourceSha256) {
      throw new Error(
        `Production JSON import source digest mismatch: expected ${expectedSourceSha256}, `
        + `received ${snapshot.sourceSha256}`,
      );
    }
    importResult = await runProductionComposeJsonImportWithSnapshot({
      source: resolvedSource,
      snapshot,
      dryRun,
      expectedSourceSha256,
      composeFile,
      containerName,
      operationToken,
      ownershipToken,
      environment,
      runDocker,
      allocationSettlementProbeAttempts,
      allocationSettlementProbeIntervalMs,
      postgresReadinessAttempts,
      postgresReadinessIntervalMs,
      importSettlementProbeAttempts,
      importSettlementProbeIntervalMs,
      operationLock: releaseOperationLock,
      wait,
    });
  } catch (error) {
    operationError = error;
  }

  let cleanupError = null;
  if (snapshot) {
    try {
      await cleanupProductionSourceSnapshot(snapshot);
    } catch (error) {
      cleanupError = error;
    }
  }
  if (operationError && cleanupError) {
    operationError = appendProductionImportFailure(
      operationError,
      cleanupError,
      'Production JSON import failed and private source snapshot cleanup also failed',
    );
  } else if (cleanupError) {
    operationError = cleanupError;
  }

  if (operationError) operationError = propagateLifecycleRecovery(operationError);
  const lifecycleRecovery = collectLifecycleRecovery(operationError);
  if (lifecycleRecovery.childSettlementUnproven) {
    try {
      if (!releaseOperationLock || lifecycleRecovery.recoveryAuthorities.length !== 1) {
        throw new Error('Production import has no single exact local-child recovery authority');
      }
      const localChildRecovery = createProductionImportLocalChildRecovery(
        lifecycleRecovery.recoveryAuthorities[0],
        describeDatabaseOperationLocalChildHold(releaseOperationLock),
      );
      const existingSettlement = operationError?.[productionImportUnprovenSettlement];
      const recoveryEvidence = {
        ...(existingSettlement || productionImportRecoveryEvidence({
          applicationName: `easyboost_import_${operationToken}`,
          ownershipToken,
          operationToken,
        })),
        localChildRecovery,
      };
      delete recoveryEvidence.retentionReason;
      markProductionImportSettlementUnproven(
        operationError,
        recoveryEvidence,
        PRODUCTION_IMPORT_LOCAL_CHILD_RETENTION_REASON,
      );
      await retainHostOperation(
        releaseHostLock,
        hostLockReleaseTimeoutMs,
        {
          ...recoveryEvidence,
          retentionReason: PRODUCTION_IMPORT_LOCAL_CHILD_RETENTION_REASON,
        },
      );
      operationError.code = 'PRODUCTION_IMPORT_LOCAL_CHILD_RECOVERY_REQUIRED';
    } catch (retentionError) {
      operationError = appendProductionImportFailure(
        operationError,
        retentionError,
        'Production JSON import local-child authority could not be retained',
      );
    }
    throw propagateLifecycleRecovery(operationError);
  }

  const unprovenSettlement = operationError?.[productionImportUnprovenSettlement];
  if (unprovenSettlement) {
    const {
      retentionReason = 'IMPORT_CONTAINER_SETTLEMENT_UNPROVEN',
      ...retentionEvidence
    } = unprovenSettlement;
    const retentionErrors = [];
    try {
      await retainOperationLock(
        releaseOperationLock,
        lockReleaseTimeoutMs,
        retentionReason,
        retentionEvidence,
      );
    } catch (error) {
      retentionErrors.push(error);
    }
    try {
      await retainHostOperation(
        releaseHostLock,
        hostLockReleaseTimeoutMs,
        {
          ...retentionEvidence,
          retentionReason,
        },
      );
    } catch (error) {
      retentionErrors.push(error);
    }
    let retentionFailure = operationError;
    for (const error of retentionErrors) {
      retentionFailure = appendProductionImportFailure(
        retentionFailure,
        error,
        'Production JSON import settlement is unproven and retaining its guards also failed',
      );
    }
    throw retentionFailure;
  }

  const finalizationRetentionReason = 'IMPORT_CONTAINER_SETTLEMENT_UNPROVEN';
  const finalizationRetentionEvidence = productionImportRecoveryEvidence({
    applicationName: `easyboost_import_${operationToken}`,
    ownershipToken,
    operationToken,
  });
  let retainedHostCompletion = null;
  const prepareHostBeforeDatabaseFinalization = Boolean(
    releaseOperationLock && typeof releaseHostLock?.retain === 'function',
  );
  if (prepareHostBeforeDatabaseFinalization) {
    try {
      retainedHostCompletion = await retainHostOperation(
        releaseHostLock,
        hostLockReleaseTimeoutMs,
        {
          ...finalizationRetentionEvidence,
          retentionReason: finalizationRetentionReason,
        },
      );
      if (typeof retainedHostCompletion !== 'function') {
        throw new Error('Production import host retention returned no completion authority');
      }
    } catch (retentionError) {
      if (operationError) {
        throw appendProductionImportFailure(
          operationError,
          retentionError,
          'Production JSON import failed and its host finalization authority could not be retained',
        );
      }
      throw retentionError;
    }
  }

  let lockReleaseError = null;
  if (releaseOperationLock) {
    try {
      await releaseDatabaseOperationLock(releaseOperationLock, lockReleaseTimeoutMs);
    } catch (error) {
      lockReleaseError = error;
    }
  }
  if (operationError && lockReleaseError) {
    operationError = appendProductionImportFailure(
      operationError,
      lockReleaseError,
      'Production JSON import failed and releasing its operation lock also failed',
    );
  } else if (lockReleaseError) {
    operationError = lockReleaseError;
  }

  if (lockReleaseError) {
    try {
      await retainOperationLock(
        releaseOperationLock,
        lockReleaseTimeoutMs,
        finalizationRetentionReason,
        finalizationRetentionEvidence,
      );
    } catch (retentionError) {
      operationError = appendProductionImportFailure(
        operationError,
        retentionError,
        'Production JSON import database guard finalization and retained transition both failed',
      );
    }
    if (!prepareHostBeforeDatabaseFinalization) {
      try {
        await retainHostOperation(
          releaseHostLock,
          hostLockReleaseTimeoutMs,
          {
            ...finalizationRetentionEvidence,
            retentionReason: finalizationRetentionReason,
          },
        );
      } catch (retentionError) {
        operationError = appendProductionImportFailure(
          operationError,
          retentionError,
          'Production JSON import database guard finalization failed and retaining its host guard also failed',
        );
      }
    }
    throw operationError;
  }

  let hostLockReleaseError = null;
  try {
    await releaseHostOperation(
      retainedHostCompletion ?? releaseHostLock,
      hostLockReleaseTimeoutMs,
    );
  } catch (error) {
    hostLockReleaseError = error;
  }
  if (operationError && hostLockReleaseError) {
    throw appendProductionImportFailure(
      operationError,
      hostLockReleaseError,
      'Production JSON import failed and releasing its host operation lock also failed',
    );
  }
  if (operationError) throw operationError;
  if (hostLockReleaseError) throw hostLockReleaseError;
  return importResult;
}

async function main() {
  const arguments_ = process.argv.slice(2);
  if (arguments_.length === 1 && arguments_[0] === '--print-production-import-protocol') {
    console.log(PRODUCTION_IMPORT_PROTOCOL);
    return;
  }
  const supportedOptions = new Set([
    '--dry-run',
    '--production-compose',
    '--expected-source-sha256',
  ]);
  const seenOptions = new Set();
  const fileArguments = [];
  let expectedSourceSha256 = null;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (!argument.startsWith('-')) {
      fileArguments.push(argument);
      continue;
    }
    let error = null;
    if (!supportedOptions.has(argument)) {
      error = productionImportUsageError(`Unknown JSON import option: ${argument}`);
    } else if (seenOptions.has(argument)) {
      error = productionImportUsageError(`Duplicate JSON import option: ${argument}`);
    }
    if (error) {
      console.error(error.message);
      process.exitCode = error.exitCode;
      return;
    }
    seenOptions.add(argument);
    if (argument === '--expected-source-sha256') {
      const digest = arguments_[index + 1];
      if (!/^[0-9a-f]{64}$/u.test(digest || '')) {
        const digestError = productionImportUsageError(
          '--expected-source-sha256 requires exactly 64 lowercase hexadecimal characters',
        );
        console.error(digestError.message);
        process.exitCode = digestError.exitCode;
        return;
      }
      expectedSourceSha256 = digest;
      index += 1;
    }
  }
  const dryRun = arguments_.includes('--dry-run');
  const productionCompose = arguments_.includes('--production-compose');
  if (fileArguments.length !== 1 || fileArguments[0].length === 0) {
    const error = productionImportUsageError('JSON import requires exactly one source path');
    console.error(error.message);
    process.exitCode = error.exitCode;
    return;
  }
  const [fileArgument] = fileArguments;
  if (productionCompose && !dryRun && !expectedSourceSha256) {
    const error = productionImportUsageError(
      'live production JSON import requires --expected-source-sha256 from an exact dry run',
    );
    console.error(error.message);
    process.exitCode = error.exitCode;
    return;
  }
  if (expectedSourceSha256 && productionCompose && dryRun) {
    const error = productionImportUsageError(
      '--expected-source-sha256 cannot be supplied to a production-compose dry run',
    );
    console.error(error.message);
    process.exitCode = error.exitCode;
    return;
  }
  if (productionCompose) {
    try {
      const result = await runProductionComposeJsonImport({
        source: fileArgument,
        dryRun,
        expectedSourceSha256,
      });
      console.log(JSON.stringify(result, null, 2));
    } catch (error) {
      console.error(formatProductionImportCliFailure(error));
      process.exitCode = Number.isInteger(error.exitCode) ? error.exitCode : 1;
    }
    return;
  }
  const source = path.resolve(fileArgument);
  const parsed = expectedSourceSha256
    ? await readDigestBoundJsonSource(source, expectedSourceSha256)
    : JSON.parse(await fs.readFile(source, 'utf8'));
  const plan = createJsonImportPlan(parsed, { source });
  if (dryRun) {
    console.log(JSON.stringify({ dryRun: true, ...plan.report }, null, 2));
    return;
  }
  if (!config.database.url) throw new Error('DATABASE_URL is required to import data');

  const client = new Client({ connectionString: config.database.url });
  await client.connect();
  await runConnectedJsonImport(parsed, {
    source,
    client,
    onReport(report) {
      console.log(JSON.stringify({ dryRun: false, ...report }, null, 2));
    },
  });
}

export function formatProductionImportCliFailure(error) {
  const recovery = collectLifecycleRecovery(error);
  if (!recovery.childSettlementUnproven) {
    return typeof error?.message === 'string' ? error.message : 'Production JSON import failed';
  }
  if (recovery.recoveryAuthorities.length === 1) {
    try {
      const recoveryAuthority = normalizeProductionImportChildControllerAuthority(
        recovery.recoveryAuthorities[0],
      );
      return JSON.stringify({
        childSettlementUnproven: true,
        code: error?.code === 'PRODUCTION_IMPORT_LOCAL_CHILD_RECOVERY_REQUIRED'
          ? error.code
          : 'PRODUCTION_IMPORT_LOCAL_CHILD_RECOVERY_UNAVAILABLE',
        recoveryAuthority,
      });
    } catch {}
  }
  return JSON.stringify({
    childSettlementUnproven: true,
    code: 'PRODUCTION_IMPORT_LOCAL_CHILD_RECOVERY_UNAVAILABLE',
  });
}

const currentModule = path.resolve(fileURLToPath(import.meta.url));
if (process.argv[1] && currentModule === path.resolve(process.argv[1])) await main();
