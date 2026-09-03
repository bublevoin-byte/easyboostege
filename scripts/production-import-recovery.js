import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runDockerCommand } from './import-json.js';
import { recoverPosixSessionControl } from './posix-session-supervisor.js';
import {
  recoverWindowsJobControl,
} from './release-command-supervisor.js';
import {
  PRODUCTION_IMPORT_LOCAL_CHILD_RETENTION_REASON,
  normalizeProductionImportChildControllerAuthority,
  normalizeProductionImportLocalChildRecovery,
} from './production-import-local-child-authority.js';

const PRODUCTION_COMPOSE_PROJECT = 'easyboost-production';
const PRODUCTION_IMPORT_OWNER_LABEL = 'easyboost.production-import-owner';
const DATABASE_ABSENCE_LEASE_PROTOCOL =
  'easyboost-database-operation-lock-absence-lease-v1';
const CANONICAL_CONTAINER_ID = /^[0-9a-f]{64}$/u;
const CANONICAL_IMAGE_ID = /^sha256:[0-9a-f]{64}$/u;
const CANONICAL_OPERATION_TOKEN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CANONICAL_OWNERSHIP_TOKEN = /^[0-9a-f]{64}$/u;
const IMPORT_RETENTION_REASONS = new Set([
  'IMPORT_CONTAINER_SETTLEMENT_UNPROVEN',
  PRODUCTION_IMPORT_LOCAL_CHILD_RETENTION_REASON,
  'IMPORT_REMOTE_SETTLEMENT_UNPROVEN',
]);
const IMPORT_EVIDENCE_FIELDS = new Set([
  'applicationName',
  'importContainerId',
  'kind',
  'lastProbe',
  'localChildRecovery',
  'operationToken',
  'ownershipToken',
  'postgresContainerId',
  'retentionReason',
]);
const IMPORT_PROBE_FIELDS = new Set(['activityCount', 'process', 'status']);

function usageError(message) {
  const error = new Error(message);
  error.exitCode = 2;
  return error;
}

function composeArguments(composeFile, ...arguments_) {
  return [
    'compose', '--project-name', PRODUCTION_COMPOSE_PROJECT,
    '-f', composeFile, ...arguments_,
  ];
}

function parseContainerInventory(output, description) {
  const normalized = String(output || '').trim();
  if (!normalized) return [];
  const containerIds = normalized.split(/\r?\n/u);
  if (containerIds.some((containerId) => !CANONICAL_CONTAINER_ID.test(containerId))) {
    throw new Error(`${description} contains a non-canonical container ID`);
  }
  if (new Set(containerIds).size !== containerIds.length) {
    throw new Error(`${description} contains duplicate container IDs`);
  }
  return containerIds;
}

function validateRecoveryEvidence(evidence) {
  const evidenceFields = evidence && typeof evidence === 'object' && !Array.isArray(evidence)
    ? Object.keys(evidence)
    : [];
  const lastProbe = evidence?.lastProbe;
  const probeFields = lastProbe && typeof lastProbe === 'object' && !Array.isArray(lastProbe)
    ? Object.keys(lastProbe)
    : [];
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)
      || evidenceFields.some((field) => !IMPORT_EVIDENCE_FIELDS.has(field))
      || ['applicationName', 'importContainerId', 'kind', 'lastProbe', 'operationToken',
        'ownershipToken', 'postgresContainerId'].some((field) => !evidenceFields.includes(field))
      || evidence.kind !== 'import'
      || !CANONICAL_OPERATION_TOKEN.test(evidence.operationToken || '')
      || evidence.applicationName !== `easyboost_import_${evidence.operationToken}`
      || !CANONICAL_OWNERSHIP_TOKEN.test(evidence.ownershipToken || '')
      || !(evidence.importContainerId === 'unknown'
        || CANONICAL_CONTAINER_ID.test(evidence.importContainerId || ''))
      || !(evidence.postgresContainerId === 'unknown'
        || CANONICAL_CONTAINER_ID.test(evidence.postgresContainerId || ''))
      || !lastProbe || typeof lastProbe !== 'object' || Array.isArray(lastProbe)
      || probeFields.length !== IMPORT_PROBE_FIELDS.size
      || probeFields.some((field) => !IMPORT_PROBE_FIELDS.has(field))
      || !/^[A-Z][A-Z0-9_:-]{0,63}$/u.test(lastProbe.status || '')
      || !/^(?:ACTIVE|NONE|UNKNOWN)$/u.test(lastProbe.process || '')
      || !(lastProbe.activityCount === 'unknown'
        || (Number.isSafeInteger(lastProbe.activityCount) && lastProbe.activityCount >= 0))
      || (evidence.retentionReason !== undefined
        && !IMPORT_RETENTION_REASONS.has(evidence.retentionReason))) {
    throw usageError('Retained production import recovery evidence is invalid');
  }
  const localChildRecovery = evidence.localChildRecovery === undefined
    ? undefined
    : normalizeProductionImportLocalChildRecovery(evidence.localChildRecovery);
  return Object.freeze({
    applicationName: evidence.applicationName,
    importContainerId: evidence.importContainerId,
    kind: 'import',
    lastProbe: Object.freeze({
      activityCount: lastProbe.activityCount,
      process: lastProbe.process,
      status: lastProbe.status,
    }),
    operationToken: evidence.operationToken,
    ownershipToken: evidence.ownershipToken,
    postgresContainerId: evidence.postgresContainerId,
    ...(localChildRecovery === undefined ? {} : { localChildRecovery }),
    ...(evidence.retentionReason === undefined
      ? {}
      : { retentionReason: evidence.retentionReason }),
  });
}

function approvedImageIds(environment) {
  const appImageId = environment?.EASYBOOST_PRODUCTION_APP_IMAGE_ID;
  const postgresImageId = environment?.EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID;
  if (!CANONICAL_IMAGE_ID.test(appImageId || '')) {
    throw usageError(
      'EASYBOOST_PRODUCTION_APP_IMAGE_ID must be an owner-approved canonical sha256 image ID',
    );
  }
  if (!CANONICAL_IMAGE_ID.test(postgresImageId || '')) {
    throw usageError(
      'EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID must be an owner-approved canonical sha256 image ID',
    );
  }
  return { appImageId, postgresImageId };
}

function parseActivityCount(output) {
  if (!/^(0|[1-9]\d*)$/u.test(String(output || ''))) {
    throw new Error('Production import recovery pg_stat_activity evidence is malformed');
  }
  const activityCount = Number(output);
  if (!Number.isSafeInteger(activityCount)) {
    throw new Error('Production import recovery pg_stat_activity evidence is unsafe');
  }
  return activityCount;
}

async function inventoryOwnedImportContainers({
  dockerOptions,
  ownershipToken,
  runDocker,
}) {
  return parseContainerInventory(await runDocker([
    'ps', '--all', '--quiet', '--no-trunc', '--filter',
    `label=${PRODUCTION_IMPORT_OWNER_LABEL}=${ownershipToken}`,
  ], { ...dockerOptions, capture: true }), 'Production import recovery ownership inventory');
}

async function proveOwnedImportContainer({
  appImageId,
  containerId,
  dockerOptions,
  evidenceContainerId,
  ownershipToken,
  runDocker,
}) {
  if (evidenceContainerId !== 'unknown' && evidenceContainerId !== containerId) {
    throw new Error('Production import recovery container conflicts with retained evidence');
  }
  const authorityTemplate = [
    '{{.Id}}',
    `{{ index .Config.Labels "${PRODUCTION_IMPORT_OWNER_LABEL}" }}`,
    '{{ index .Config.Labels "com.docker.compose.project" }}',
    '{{ index .Config.Labels "com.docker.compose.service" }}',
    '{{ index .Config.Labels "com.docker.compose.oneoff" }}',
    '{{.Image}}',
  ].join('|');
  const authority = await runDocker([
    'inspect', '--format', authorityTemplate, containerId,
  ], { ...dockerOptions, capture: true });
  const expectedAuthority = [
    containerId,
    ownershipToken,
    PRODUCTION_COMPOSE_PROJECT,
    'app',
    'True',
    appImageId,
  ].join('|');
  if (authority !== expectedAuthority) {
    throw new Error('Production import recovery container is foreign or lacks exact authority');
  }
}

async function provePostgresSettlement({
  applicationName,
  composeFile,
  dockerOptions,
  evidenceContainerId,
  postgresImageId,
  runDocker,
}) {
  const inventory = parseContainerInventory(await runDocker(
    composeArguments(composeFile, 'ps', '--all', '--quiet', 'postgres'),
    { ...dockerOptions, capture: true },
  ), 'Production import recovery PostgreSQL inventory');
  if (inventory.length !== 1) {
    throw new Error('Production import recovery requires exactly one PostgreSQL container');
  }
  const [postgresContainerId] = inventory;
  if (evidenceContainerId !== 'unknown' && postgresContainerId !== evidenceContainerId) {
    throw new Error('Production import recovery PostgreSQL allocation changed');
  }
  const authorityTemplate = [
    '{{.Id}}',
    '{{.Image}}',
    '{{ index .Config.Labels "com.docker.compose.project" }}',
    '{{ index .Config.Labels "com.docker.compose.service" }}',
    '{{ index .Config.Labels "com.docker.compose.oneoff" }}',
    '{{.State.Running}}',
  ].join('|');
  const authority = await runDocker([
    'inspect', '--format', authorityTemplate, postgresContainerId,
  ], { ...dockerOptions, capture: true });
  const expectedAuthority = [
    postgresContainerId,
    postgresImageId,
    PRODUCTION_COMPOSE_PROJECT,
    'postgres',
    'False',
    'true',
  ].join('|');
  if (authority !== expectedAuthority) {
    throw new Error('Production import recovery PostgreSQL authority is foreign');
  }
  const activityCount = parseActivityCount(await runDocker([
    'exec', '-i', postgresContainerId,
    'psql', '-U', 'easyboost', '-d', 'easyboost', '-At',
    '--set', `appname=${applicationName}`,
    '-c', "SELECT count(*) FROM pg_stat_activity WHERE application_name = :'appname';",
  ], { ...dockerOptions, capture: true }));
  if (activityCount !== 0) {
    throw new Error('Production import recovery PostgreSQL activity is still active');
  }
  return postgresContainerId;
}

async function proveApplicationIsolation({
  allowedImportContainerId = null,
  composeFile,
  dockerOptions,
  ownershipToken,
  runDocker,
}) {
  const inventory = parseContainerInventory(await runDocker(
    composeArguments(composeFile, 'ps', '--all', '--quiet', 'app'),
    { ...dockerOptions, capture: true },
  ), 'Production import recovery application inventory');
  if (inventory.length === 0) return;
  if (allowedImportContainerId && inventory.length === 1
      && inventory[0] === allowedImportContainerId) {
    const authorityTemplate = [
      '{{.Id}}',
      `{{ index .Config.Labels "${PRODUCTION_IMPORT_OWNER_LABEL}" }}`,
      '{{ index .Config.Labels "com.docker.compose.project" }}',
      '{{ index .Config.Labels "com.docker.compose.service" }}',
      '{{ index .Config.Labels "com.docker.compose.oneoff" }}',
    ].join('|');
    const authority = await runDocker([
      'inspect', '--format', authorityTemplate, allowedImportContainerId,
    ], { ...dockerOptions, capture: true });
    if (authority === [
      allowedImportContainerId,
      ownershipToken,
      PRODUCTION_COMPOSE_PROJECT,
      'app',
      'True',
    ].join('|')) return;
    throw new Error('Production import recovery application allocation is foreign');
  }
  throw new Error('Production application allocation must be absent during import recovery');
}

export async function recoverRetainedProductionImport({
  evidence,
  environment = process.env,
  composeFile = path.resolve('compose.production.yml'),
  runDocker = runDockerCommand,
  completeDatabaseLock,
  completeHostGuard,
} = {}) {
  const retainedEvidence = validateRecoveryEvidence(evidence);
  const { appImageId, postgresImageId } = approvedImageIds(environment);
  if (typeof composeFile !== 'string' || !composeFile) {
    throw usageError('Production import recovery requires one Compose file');
  }
  if (typeof runDocker !== 'function'
      || typeof completeDatabaseLock !== 'function'
      || typeof completeHostGuard !== 'function') {
    throw usageError('Production import recovery requires Docker and guard completion adapters');
  }
  const dockerOptions = { environment: { ...environment } };
  const ownedInventory = await inventoryOwnedImportContainers({
    dockerOptions,
    ownershipToken: retainedEvidence.ownershipToken,
    runDocker,
  });
  if (ownedInventory.length > 1) {
    throw new Error('Production import recovery ownership inventory is ambiguous');
  }
  const importContainerId = ownedInventory[0] || null;
  if (importContainerId) {
    await proveOwnedImportContainer({
      appImageId,
      containerId: importContainerId,
      dockerOptions,
      evidenceContainerId: retainedEvidence.importContainerId,
      ownershipToken: retainedEvidence.ownershipToken,
      runDocker,
    });
  }

  let postgresContainerId = await provePostgresSettlement({
    applicationName: retainedEvidence.applicationName,
    composeFile,
    dockerOptions,
    evidenceContainerId: retainedEvidence.postgresContainerId,
    postgresImageId,
    runDocker,
  });
  await proveApplicationIsolation({
    allowedImportContainerId: importContainerId,
    composeFile,
    dockerOptions,
    ownershipToken: retainedEvidence.ownershipToken,
    runDocker,
  });

  if (importContainerId) {
    await runDocker(
      ['rm', '--force', importContainerId],
      { ...dockerOptions, capture: true },
    );
    const finalOwnedInventory = await inventoryOwnedImportContainers({
      dockerOptions,
      ownershipToken: retainedEvidence.ownershipToken,
      runDocker,
    });
    if (finalOwnedInventory.length !== 0) {
      throw new Error('Production import recovery container removal is unproven');
    }
    postgresContainerId = await provePostgresSettlement({
      applicationName: retainedEvidence.applicationName,
      composeFile,
      dockerOptions,
      evidenceContainerId: retainedEvidence.postgresContainerId,
      postgresImageId,
      runDocker,
    });
    await proveApplicationIsolation({
      composeFile,
      dockerOptions,
      ownershipToken: retainedEvidence.ownershipToken,
      runDocker,
    });
  }
  const completionOwnershipInventory = await inventoryOwnedImportContainers({
    dockerOptions,
    ownershipToken: retainedEvidence.ownershipToken,
    runDocker,
  });
  if (completionOwnershipInventory.length !== 0) {
    throw new Error('Production import recovery ownership settlement changed before completion');
  }

  const recoveryResult = Object.freeze({
    applicationName: retainedEvidence.applicationName,
    importContainerId: importContainerId || retainedEvidence.importContainerId,
    postgresContainerId,
    recovered: true,
  });
  await completeDatabaseLock(recoveryResult);
  await completeHostGuard(recoveryResult);
  return recoveryResult;
}

function sameEvidence(left, right) {
  const normalizedLeft = validateRecoveryEvidence(left);
  const normalizedRight = validateRecoveryEvidence(right);
  return [
    'applicationName',
    'importContainerId',
    'kind',
    'operationToken',
    'ownershipToken',
    'postgresContainerId',
  ].every((field) => normalizedLeft[field] === normalizedRight[field])
    && ['activityCount', 'process', 'status'].every((field) => (
      normalizedLeft.lastProbe[field] === normalizedRight.lastProbe[field]
    ))
    && JSON.stringify(normalizedLeft.localChildRecovery)
      === JSON.stringify(normalizedRight.localChildRecovery);
}

export async function recoverProductionImportLocalChildControl({
  recoverPosixControl = recoverPosixSessionControl,
  recoverWindowsControl = recoverWindowsJobControl,
  recoveryAuthority,
  workingDirectory = process.cwd(),
} = {}) {
  const controller = normalizeProductionImportChildControllerAuthority(recoveryAuthority);
  if (typeof workingDirectory !== 'string' || !path.isAbsolute(workingDirectory)
      || path.normalize(workingDirectory) !== workingDirectory) {
    throw usageError('Production import local-child recovery working directory is invalid');
  }
  const controlKey = `database:${workingDirectory}:docker`;
  const controlRoot = path.dirname(controller.controlDirectory);
  const controlHash = createHash('sha256').update(controlKey, 'utf8').digest('hex');
  let result;
  if (controller.protocol === 'easyboost-windows-job-recovery-v2') {
    result = await recoverWindowsControl({
      controlKey,
      recoveryAuthority: controller,
      temporaryDirectory: controlRoot,
    });
  } else {
    if (path.basename(controller.controlDirectory) !== controlHash) {
      throw new Error('Production import POSIX child authority does not match its operation scope');
    }
    result = await recoverPosixControl({
      controlKey,
      controlRoot,
      permitIncompleteRetirement: true,
      ...(controller.publicationResidue === undefined ? {} : {
        publicationResidue: controller.publicationResidue,
      }),
      ...(controller.publicationResidues === undefined ? {} : {
        publicationResidues: controller.publicationResidues,
      }),
      recoveryScope: null,
    });
  }
  if (result?.state !== 'absent' && result?.absence !== 'absent') {
    throw new Error('Production import local-child supervisor settlement is unproven');
  }
  return Object.freeze({ recoveryAuthority: controller, state: 'absent' });
}

function validateLocalChildRecoveryProof(proof, expectedController) {
  if (proof?.state !== 'absent') {
    throw new Error('Production import local-child supervisor settlement is unproven');
  }
  const recoveredController = normalizeProductionImportChildControllerAuthority(
    proof.recoveryAuthority,
  );
  if (JSON.stringify(recoveredController) !== JSON.stringify(expectedController)) {
    throw new Error('Production import local-child supervisor authority changed during recovery');
  }
}

function validateDatabaseAbsenceLease(absenceLease, databaseLockFile) {
  if (absenceLease?.absent !== true
      || absenceLease.protocol !== DATABASE_ABSENCE_LEASE_PROTOCOL
      || absenceLease.lockFile !== databaseLockFile
      || typeof absenceLease.release !== 'function') {
    throw new Error('Database operation absence lease adapter returned unsafe authority');
  }
  return absenceLease;
}

async function openDatabaseRecoveryAuthority({
  databaseLockModule,
  fileSystem,
  lockFile,
}) {
  try {
    const absenceLease = validateDatabaseAbsenceLease(
      await databaseLockModule.proveDatabaseOperationLockAbsent({
        fileSystem,
        lockFile,
      }),
      lockFile,
    );
    return { absenceLease, databaseLock: null };
  } catch (error) {
    if (error?.code !== 'DATABASE_OPERATION_LOCK_NOT_ABSENT') throw error;
  }

  try {
    const absenceLease = validateDatabaseAbsenceLease(
      await databaseLockModule.openDatabaseOperationLockAbsenceProof({
        fileSystem,
        lockFile,
      }),
      lockFile,
    );
    return { absenceLease, databaseLock: null };
  } catch (error) {
    if (error?.code !== 'DATABASE_OPERATION_LOCK_ABSENCE_LEASE_AMBIGUOUS') throw error;
  }

  try {
    const databaseLock = await databaseLockModule.openRetainedDatabaseOperationLock({
      expectedEvidenceKind: 'import',
      fileSystem,
      lockFile,
    });
    return { absenceLease: null, databaseLock };
  } catch (retainedOpenError) {
    // A host guard can be durably retained after database finalization failed
    // while the database marker is still in ACTIVE/release protocol state. Use
    // the database lock's existing typed recovery transition; never infer
    // absence from the retained host marker alone.
    if (typeof databaseLockModule.openDatabaseOperationLockProtocolRecovery !== 'function') {
      throw retainedOpenError;
    }
    const protocolRecovery = await databaseLockModule.openDatabaseOperationLockProtocolRecovery({
      expectedEvidenceKind: 'import',
      fileSystem,
      lockFile,
    });
    if (!protocolRecovery || typeof protocolRecovery.recover !== 'function') {
      throw new Error('Database operation protocol recovery adapter returned unsafe authority');
    }
    const result = await protocolRecovery.recover();
    if (result?.state === 'retained' && result.retained) {
      return { absenceLease: null, databaseLock: result.retained };
    }
    if (result?.state !== 'absent') {
      throw new Error('Database operation protocol recovery did not prove finalization');
    }
    const absenceLease = validateDatabaseAbsenceLease(
      await databaseLockModule.proveDatabaseOperationLockAbsent({
        fileSystem,
        lockFile,
      }),
      lockFile,
    );
    return { absenceLease, databaseLock: null };
  }
}

async function releaseTemporaryHostAbsenceLease(hostAbsenceLease, primaryError = null) {
  try {
    await hostAbsenceLease.release();
  } catch (releaseError) {
    if (!primaryError) throw releaseError;
    throw new AggregateError(
      [primaryError, releaseError],
      'Import recovery failed and releasing its temporary host absence lease also failed',
      { cause: primaryError },
    );
  }
  if (primaryError) throw primaryError;
}

async function completeLeaseOnlyRecovery({
  databaseLockFile,
  databaseLockModule,
  environment,
  fileSystem,
  hostLockModule,
}) {
  if (typeof hostLockModule.acquireHostOperationAbsenceLease !== 'function') {
    throw new Error('Host operation absence lease adapter is unavailable');
  }
  const hostAbsenceLease = await hostLockModule.acquireHostOperationAbsenceLease({
    environment,
  });
  if (hostAbsenceLease?.state !== 'absent-leased'
      || typeof hostAbsenceLease.release !== 'function') {
    throw new Error('Host operation absence lease adapter returned unsafe authority');
  }
  let databaseAbsenceLease;
  try {
    databaseAbsenceLease = validateDatabaseAbsenceLease(
      await databaseLockModule.openDatabaseOperationLockAbsenceProof({
        fileSystem,
        lockFile: databaseLockFile,
      }),
      databaseLockFile,
    );
    await databaseAbsenceLease.release();
  } catch (error) {
    await releaseTemporaryHostAbsenceLease(hostAbsenceLease, error);
  }
  await releaseTemporaryHostAbsenceLease(hostAbsenceLease);
  return Object.freeze({ leaseOnly: true, recovered: true });
}

export async function runRetainedProductionImportRecoveryCli({
  databaseLockModule,
  hostLockModule,
  fileSystem = fs,
  environment = process.env,
  recoverLocalChildControl = recoverProductionImportLocalChildControl,
  runRecovery = recoverRetainedProductionImport,
  workingDirectory = process.cwd(),
} = {}) {
  if (typeof databaseLockModule?.openDatabaseOperationLockAbsenceProof !== 'function'
      || typeof hostLockModule?.openRetainedHostOperationLock !== 'function') {
    throw new Error('Retained import recovery lock adapters are unavailable');
  }
  const databaseLockFile = databaseLockModule.DEFAULT_DATABASE_OPERATION_LOCK_FILE;
  if (typeof databaseLockFile !== 'string' || !databaseLockFile) {
    throw new Error('Database operation lock adapter has no canonical marker path');
  }
  let hostGuard;
  try {
    hostGuard = await hostLockModule.openRetainedHostOperationLock({
      environment,
      expectedOperation: 'database-import',
    });
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    return completeLeaseOnlyRecovery({
      databaseLockFile,
      databaseLockModule,
      environment,
      fileSystem,
      hostLockModule,
    });
  }
  if (typeof databaseLockModule.proveDatabaseOperationLockAbsent !== 'function'
      || typeof databaseLockModule.openRetainedDatabaseOperationLock !== 'function') {
    throw new Error('Retained import recovery lock adapters are unavailable');
  }
  const hostEvidence = validateRecoveryEvidence(hostGuard?.evidence);
  const expectsLocalChildRecovery = hostGuard?.reason
    === PRODUCTION_IMPORT_LOCAL_CHILD_RETENTION_REASON;
  if (expectsLocalChildRecovery !== Boolean(hostEvidence.localChildRecovery)) {
    throw new Error('Retained import recovery host local-child authority is not exact');
  }
  if (expectsLocalChildRecovery) {
    if (typeof recoverLocalChildControl !== 'function'
        || typeof databaseLockModule.retainDatabaseOperationLocalChildRecovery !== 'function') {
      throw new Error('Retained import local-child recovery adapters are unavailable');
    }
    const proof = await recoverLocalChildControl({
      recoveryAuthority: hostEvidence.localChildRecovery.controller,
      workingDirectory,
    });
    validateLocalChildRecoveryProof(proof, hostEvidence.localChildRecovery.controller);
    await databaseLockModule.retainDatabaseOperationLocalChildRecovery({
      expectedLocalChildRecovery: hostEvidence.localChildRecovery,
      fileSystem,
      lockFile: databaseLockFile,
      reason: hostGuard.reason,
      recoveryEvidence: hostEvidence,
    });
  }
  let { absenceLease, databaseLock } = await openDatabaseRecoveryAuthority({
    databaseLockModule,
    fileSystem,
    lockFile: databaseLockFile,
  });
  if (databaseLock && !IMPORT_RETENTION_REASONS.has(databaseLock.reason)) {
    throw new Error('Retained database marker is not an import recovery operation');
  }
  const databaseEvidence = databaseLock
    ? validateRecoveryEvidence(databaseLock.evidence)
    : null;
  if (hostGuard?.operation !== 'database-import'
      || !IMPORT_RETENTION_REASONS.has(hostGuard.reason)
      || (hostEvidence.retentionReason !== undefined
        && hostEvidence.retentionReason !== hostGuard.reason)
      || (databaseEvidence && !sameEvidence(hostEvidence, databaseEvidence))
      || (databaseEvidence && hostGuard.reason !== databaseLock.reason)
      || (databaseEvidence?.retentionReason !== undefined
        && databaseEvidence.retentionReason !== databaseLock.reason)
      || databaseLock?.legacy
      || (databaseLock && typeof databaseLock.complete !== 'function')
      || (absenceLease && typeof absenceLease.release !== 'function')
      || typeof (hostGuard?.complete || hostGuard?.release) !== 'function') {
    throw new Error('Retained import recovery guards do not share exact authority');
  }
  const completeDatabaseLock = databaseLock
    ? async (proof) => {
      await databaseLock.complete(proof);
      absenceLease = validateDatabaseAbsenceLease(
        await databaseLockModule.proveDatabaseOperationLockAbsent({
          fileSystem,
          lockFile: databaseLockFile,
        }),
        databaseLockFile,
      );
    }
    : async () => {
      if (typeof absenceLease?.release !== 'function') {
        throw new Error('Database operation absence lease is not held');
      }
    };
  const completeHostGuard = async (proof) => {
    if (typeof absenceLease?.release !== 'function') {
      throw new Error('Database operation absence lease is not held');
    }
    await (hostGuard.complete || hostGuard.release)(proof);
    await absenceLease.release();
    absenceLease = null;
  };
  return runRecovery({
    evidence: databaseEvidence || hostEvidence,
    environment,
    completeDatabaseLock,
    completeHostGuard,
  });
}

async function main() {
  if (process.argv.length !== 2) {
    throw usageError('Production import recovery CLI does not accept arguments');
  }
  const databaseLockModule = await import('./database-operation-lock.js');
  const hostLockModule = await import('./host-operation-lock.js');
  const result = await runRetainedProductionImportRecoveryCli({
    databaseLockModule,
    hostLockModule,
  });
  console.log(JSON.stringify(result, null, 2));
}

const currentModule = path.resolve(fileURLToPath(import.meta.url));
if (process.argv[1] && currentModule === path.resolve(process.argv[1])) {
  try {
    await main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = Number.isInteger(error.exitCode) ? error.exitCode : 1;
  }
}
