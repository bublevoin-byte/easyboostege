import { createHash, randomBytes } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  PRODUCTION_IMPORT_LOCAL_CHILD_RETENTION_REASON,
  decodeProductionImportLocalChildRecovery,
  encodeProductionImportLocalChildRecovery,
  normalizeProductionImportLocalChildRecovery,
} from './production-import-local-child-authority.js';

export const DEFAULT_DATABASE_OPERATION_LOCK_FILE = path.resolve(
  'backups',
  '.easyboost-database-operation.lock',
);

const ACTIVE_PROTOCOL = 'easyboost-database-operation-lock-active-v1';
const ABSENCE_LEASE_PROTOCOL = 'easyboost-database-operation-lock-absence-lease-v1';
const LOCAL_CHILD_HOLD_PROTOCOL = 'easyboost-database-operation-local-child-hold-v1';
const RETAINED_PROTOCOL = 'easyboost-database-operation-lock-v3';
const LOCAL_CHILD_RETAINED_PROTOCOL = 'easyboost-database-operation-lock-v4';
const LEGACY_RETAINED_PROTOCOL = 'easyboost-database-operation-lock-v2';
const MAX_MARKER_BYTES = 16 * 1024;
export const DATABASE_OPERATION_LOCK_RETIREMENT_CAPACITY = 128;
const RETIREMENT_RESERVE_FOR_NEW_AUTHORITY = 5;
const CANONICAL_CONTAINER_ID = /^[0-9a-f]{64}$/u;
const CANONICAL_OPERATION_TOKEN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CANONICAL_OWNERSHIP_TOKEN = /^[0-9a-f]{64}$/u;
const CANONICAL_MARKER_TOKEN = /^[0-9a-f]{64}$/u;
const SAFE_PROBE_STATUS = /^(?:PENDING|STAGING|STAGED|RUNNING|EXIT:(?:0|[1-9]\d*)|UNKNOWN)$/u;
const SAFE_IMPORT_PROBE_STATUS = /^[A-Z][A-Z0-9_:-]{0,63}$/u;
const RESTORE_RETENTION_REASONS = new Set([
  'APPLICATION_ISOLATION_UNPROVEN_AFTER_DATABASE_RESTORE',
  'REMOTE_RESTORE_SETTLEMENT_UNPROVEN',
]);
const IMPORT_RETENTION_REASONS = new Set([
  'IMPORT_CONTAINER_SETTLEMENT_UNPROVEN',
  PRODUCTION_IMPORT_LOCAL_CHILD_RETENTION_REASON,
  'IMPORT_REMOTE_SETTLEMENT_UNPROVEN',
]);
const WINDOWS_DIRECTORY_SYNC_UNSUPPORTED = new Set([
  'EBADF',
  'EISDIR',
  'EINVAL',
  'ENOTSUP',
  'EPERM',
]);

function combineOperationErrors(primaryError, cleanupError, message) {
  if (!primaryError) return cleanupError;
  if (!cleanupError) return primaryError;
  const error = new AggregateError([primaryError, cleanupError], message, {
    cause: primaryError,
  });
  error.code = primaryError.code;
  error.exitCode = primaryError.exitCode;
  if (primaryError.recoveryAuthority || cleanupError.recoveryAuthority) {
    error.recoveryAuthority = Object.freeze({
      ...primaryError.recoveryAuthority,
      ...cleanupError.recoveryAuthority,
    });
  }
  return error;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function randomMarkerToken() {
  return randomBytes(32).toString('hex');
}

function markerError(code, lockFile) {
  const error = new Error(`${code}: ${lockFile}`);
  error.code = code;
  return error;
}

function authorityFileFor(lockFile) {
  return `${lockFile}.authority`;
}

function recoverableAcquisitionError(error, lockFile, authorityFile, authorityToken) {
  const failure = new Error(
    `DATABASE_OPERATION_LOCK_ACQUIRE_DURABILITY_UNPROVEN: ${lockFile}`,
    { cause: error },
  );
  failure.code = 'DATABASE_OPERATION_LOCK_ACQUIRE_DURABILITY_UNPROVEN';
  failure.recoveryAuthority = Object.freeze({
    authorityFile,
    authorityToken,
    lockFile,
  });
  return failure;
}

function markerPayload(lines) {
  return Buffer.from(`${lines.join('\n')}\n`, 'utf8');
}

function checksummedMarker(lines) {
  const payload = markerPayload(lines);
  return Buffer.concat([
    payload,
    Buffer.from(`markerSha256=${sha256(payload)}\n`, 'utf8'),
  ]);
}

function buildActiveMarker(authorityToken) {
  return checksummedMarker([
    'ACTIVE',
    `protocol=${ACTIVE_PROTOCOL}`,
    `authorityToken=${authorityToken}`,
    `ownerPid=${process.pid}`,
  ]);
}

function buildAbsenceLeaseMarker(authorityToken) {
  return checksummedMarker([
    'ABSENCE_LEASE',
    `protocol=${ABSENCE_LEASE_PROTOCOL}`,
    `authorityToken=${authorityToken}`,
    `ownerPid=${process.pid}`,
    'purpose=host-guard-bound-database-absence-proof',
  ]);
}

function buildLocalChildHoldMarker(authorityToken, holdToken, commandLabel) {
  return checksummedMarker([
    'LOCAL_CHILD_HOLD',
    `protocol=${LOCAL_CHILD_HOLD_PROTOCOL}`,
    `authorityToken=${authorityToken}`,
    `holdToken=${holdToken}`,
    `ownerPid=${process.pid}`,
    `commandSha256=${sha256(String(commandLabel))}`,
  ]);
}

function expectedEvidenceKindForReason(reason) {
  if (RESTORE_RETENTION_REASONS.has(reason)) return 'restore';
  if (IMPORT_RETENTION_REASONS.has(reason)) return 'import';
  return null;
}

function formatRecoveryEvidence(evidence) {
  if (!evidence || typeof evidence !== 'object') {
    throw new Error('Database operation lock recovery evidence is invalid');
  }
  if (evidence.kind === 'import') {
    const importContainerId = evidence.importContainerId ?? 'unknown';
    const postgresContainerId = evidence.postgresContainerId ?? 'unknown';
    const status = evidence.lastProbe?.status ?? 'UNKNOWN';
    const processState = evidence.lastProbe?.process ?? 'UNKNOWN';
    const activityCount = evidence.lastProbe?.activityCount ?? 'unknown';
    if (!CANONICAL_OPERATION_TOKEN.test(evidence.operationToken || '')
        || evidence.applicationName !== `easyboost_import_${evidence.operationToken}`
        || !CANONICAL_OWNERSHIP_TOKEN.test(evidence.ownershipToken || '')
        || !(importContainerId === 'unknown' || CANONICAL_CONTAINER_ID.test(importContainerId))
        || !(postgresContainerId === 'unknown' || CANONICAL_CONTAINER_ID.test(postgresContainerId))
        || !SAFE_IMPORT_PROBE_STATUS.test(status)
        || !/^(?:ACTIVE|NONE|UNKNOWN)$/u.test(processState)
        || !(activityCount === 'unknown'
          || (Number.isSafeInteger(activityCount) && activityCount >= 0))) {
      throw new Error('Database operation lock import recovery evidence is invalid');
    }
    const localChildRecovery = evidence.localChildRecovery === undefined
      ? undefined
      : normalizeProductionImportLocalChildRecovery(evidence.localChildRecovery);
    return {
      applicationName: evidence.applicationName,
      evidenceKind: 'import',
      importContainerId,
      lastProbeActivityCount: String(activityCount),
      lastProbeProcess: processState,
      lastProbeStatus: status,
      operationToken: evidence.operationToken,
      ownershipToken: evidence.ownershipToken,
      postgresContainerId,
      ...(localChildRecovery === undefined ? {} : { localChildRecovery }),
    };
  }
  if (evidence.kind !== 'restore'
      || !CANONICAL_OPERATION_TOKEN.test(evidence.operationToken || '')
      || evidence.applicationName !== `easyboost_restore_${evidence.operationToken}`
      || !CANONICAL_CONTAINER_ID.test(evidence.postgresContainerId || '')) {
    throw new Error('Database operation lock restore recovery evidence is invalid');
  }
  const { lastProbe } = evidence;
  const status = lastProbe?.status ?? 'UNKNOWN';
  const processState = lastProbe?.process ?? 'UNKNOWN';
  const activityCount = lastProbe?.activityCount ?? 'unknown';
  if (!SAFE_PROBE_STATUS.test(status)
      || !/^(?:ACTIVE|NONE|UNKNOWN)$/u.test(processState)
      || !(activityCount === 'unknown'
        || (Number.isSafeInteger(activityCount) && activityCount >= 0))) {
    throw new Error('Database operation lock recovery probe evidence is invalid');
  }
  return {
    applicationName: evidence.applicationName,
    evidenceKind: 'restore',
    importContainerId: 'unknown',
    lastProbeActivityCount: String(activityCount),
    lastProbeProcess: processState,
    lastProbeStatus: status,
    operationToken: evidence.operationToken,
    ownershipToken: 'unknown',
    postgresContainerId: evidence.postgresContainerId,
  };
}

function buildRetainedMarker(authorityToken, reason, evidence) {
  const localChildRecovery = evidence.localChildRecovery;
  if ((reason === PRODUCTION_IMPORT_LOCAL_CHILD_RETENTION_REASON)
      !== Boolean(localChildRecovery)) {
    throw new Error('Database operation lock local-child retained evidence is invalid');
  }
  return checksummedMarker([
    'RETAINED',
    `protocol=${localChildRecovery ? LOCAL_CHILD_RETAINED_PROTOCOL : RETAINED_PROTOCOL}`,
    `authorityToken=${authorityToken}`,
    `ownerPid=${process.pid}`,
    `reason=${reason}`,
    `evidenceKind=${evidence.evidenceKind}`,
    `operationToken=${evidence.operationToken}`,
    `applicationName=${evidence.applicationName}`,
    `ownershipToken=${evidence.ownershipToken}`,
    `importContainerId=${evidence.importContainerId}`,
    `postgresContainerId=${evidence.postgresContainerId}`,
    `lastProbeStatus=${evidence.lastProbeStatus}`,
    `lastProbeProcess=${evidence.lastProbeProcess}`,
    `lastProbeActivityCount=${evidence.lastProbeActivityCount}`,
    ...(localChildRecovery
      ? [`localChildRecovery=${encodeProductionImportLocalChildRecovery(localChildRecovery)}`]
      : []),
  ]);
}

async function writeFully(handle, bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesWritten } = await handle.write(
      bytes,
      offset,
      bytes.length - offset,
      offset,
    );
    if (!Number.isSafeInteger(bytesWritten) || bytesWritten < 1
        || bytesWritten > bytes.length - offset) {
      throw new Error('Database operation lock marker write was incomplete');
    }
    offset += bytesWritten;
  }
}

async function readHandleSnapshot(handle, { allowEmpty = false } = {}) {
  const stat = await handle.stat({ bigint: true });
  const size = Number(stat.size);
  if (!Number.isSafeInteger(size) || size < (allowEmpty ? 0 : 1) || size > MAX_MARKER_BYTES) {
    throw new Error('Database operation lock marker has an invalid size');
  }
  const bytes = Buffer.alloc(size);
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
    if (!Number.isSafeInteger(bytesRead) || bytesRead < 1
        || bytesRead > bytes.length - offset) {
      throw new Error('Database operation lock marker read was incomplete');
    }
    offset += bytesRead;
  }
  return { bytes, stat };
}

async function closeWithPrimary(handle, primaryError, message) {
  let closeError;
  try {
    await handle.close();
  } catch (error) {
    closeError = error;
  }
  const failure = combineOperationErrors(primaryError, closeError, message);
  if (failure) throw failure;
}

async function removeTemporaryFile(fileSystem, lockFile, temporaryFile, primaryError) {
  let cleanupError;
  try {
    const snapshot = await readOptionalOpaquePathSnapshot(fileSystem, temporaryFile);
    if (snapshot) {
      await discardExactClaim(fileSystem, { claimedFile: temporaryFile, lockFile, snapshot });
    }
  } catch (error) {
    cleanupError = error;
  }
  throw combineOperationErrors(
    primaryError,
    cleanupError,
    `Database operation lock temporary marker cleanup failed: ${temporaryFile}`,
  );
}

async function writeDurableTemporaryMarker({ fileSystem, lockFile, label, bytes }) {
  const temporaryFile = `${lockFile}.${label}-${process.pid}-${randomMarkerToken()}.tmp`;
  const handle = await fileSystem.open(temporaryFile, 'wx+', 0o600);
  let snapshot;
  let writeError;
  try {
    await writeFully(handle, bytes);
    await handle.sync();
    snapshot = await readHandleSnapshot(handle);
    if (!snapshot.bytes.equals(bytes)) {
      throw new Error('Database operation lock marker verification failed');
    }
  } catch (error) {
    writeError = error;
  }
  try {
    await closeWithPrimary(
      handle,
      writeError,
      `Database operation lock ${label} marker write and close both failed`,
    );
  } catch (error) {
    await removeTemporaryFile(fileSystem, lockFile, temporaryFile, error);
  }
  return {
    bytes,
    lockFile,
    stat: snapshot.stat,
    temporaryFile,
  };
}

async function syncParentDirectory(fileSystem, lockFile) {
  const windowsNodeTestFallback = (error) => process.platform === 'win32'
    && Boolean(process.env.NODE_TEST_CONTEXT)
    && fileSystem.requireDirectorySync !== true
    && WINDOWS_DIRECTORY_SYNC_UNSUPPORTED.has(error.code);
  let handle;
  try {
    handle = await fileSystem.open(path.dirname(lockFile), 'r');
  } catch (error) {
    if (windowsNodeTestFallback(error)) return;
    throw error;
  }
  let syncError;
  try {
    await handle.sync();
  } catch (error) {
    if (!windowsNodeTestFallback(error)) syncError = error;
  }
  await closeWithPrimary(
    handle,
    syncError,
    `Database operation lock parent directory sync and close both failed: ${lockFile}`,
  );
}

async function readOptionalPathSnapshot(fileSystem, lockFile) {
  let handle;
  try {
    handle = await fileSystem.open(lockFile, 'r');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  let snapshot;
  let readError;
  try {
    snapshot = await readHandleSnapshot(handle);
  } catch (error) {
    readError = error;
  }
  await closeWithPrimary(
    handle,
    readError,
    `Database operation lock read and close both failed: ${lockFile}`,
  );
  return snapshot;
}

async function readOptionalOpaquePathSnapshot(fileSystem, lockFile) {
  let handle;
  try {
    handle = await fileSystem.open(lockFile, 'r');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  let snapshot;
  let readError;
  try {
    snapshot = await readHandleSnapshot(handle, { allowEmpty: true });
  } catch (error) {
    readError = error;
  }
  await closeWithPrimary(
    handle,
    readError,
    `Database operation lock recovery read and close both failed: ${lockFile}`,
  );
  return snapshot;
}

async function readPathSnapshot(fileSystem, lockFile) {
  const snapshot = await readOptionalPathSnapshot(fileSystem, lockFile);
  if (!snapshot) throw markerError('DATABASE_OPERATION_LOCK_OWNERSHIP_CHANGED', lockFile);
  return snapshot;
}

async function readOpaquePathSnapshot(fileSystem, lockFile) {
  const snapshot = await readOptionalOpaquePathSnapshot(fileSystem, lockFile);
  if (!snapshot) throw markerError('DATABASE_OPERATION_LOCK_OWNERSHIP_CHANGED', lockFile);
  return snapshot;
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

async function restoreClaimedPath(fileSystem, claim, originalFile) {
  const { claimedFile } = claim;
  claim.lockFile ||= originalFile.endsWith('.authority')
    ? originalFile.slice(0, -'.authority'.length)
    : originalFile;
  let expected = claim.snapshot;
  if (!expected) {
    expected = await readOptionalOpaquePathSnapshot(fileSystem, claimedFile);
  }
  if (!expected) {
    const error = markerError('DATABASE_OPERATION_LOCK_RESTORATION_UNCERTAIN', originalFile);
    error.recoveryAuthority = Object.freeze({ claimedFile, originalFile });
    throw error;
  }
  try {
    await fileSystem.link(claimedFile, originalFile);
  } catch (error) {
    error.recoveryAuthority = Object.freeze({ claimedFile, originalFile });
    throw error;
  }
  await syncParentDirectory(fileSystem, originalFile);
  const quarantined = await quarantineExactClaim(fileSystem, claim);
  if (!quarantined) {
    const error = markerError('DATABASE_OPERATION_LOCK_RESTORATION_UNCERTAIN', originalFile);
    error.recoveryAuthority = Object.freeze({ claimedFile, originalFile });
    throw error;
  }
  const restored = await readOptionalOpaquePathSnapshot(fileSystem, originalFile);
  if (!restored
      || !sameFileIdentity(restored.stat, expected.stat)
      || !restored.bytes.equals(expected.bytes)) {
    const error = markerError('DATABASE_OPERATION_LOCK_RESTORATION_UNCERTAIN', originalFile);
    error.recoveryAuthority = Object.freeze({
      claimedFile,
      originalFile,
      quarantineFile: quarantined.claimedFile,
    });
    throw error;
  }
  await deleteQuarantinedClaim(fileSystem, quarantined);
  await syncParentDirectory(fileSystem, originalFile);
}

async function claimExactPath(fileSystem, originalFile, expected, label) {
  const claimedFile = `${originalFile}.${label}-${process.pid}-${randomMarkerToken()}.claimed`;
  try {
    await fileSystem.rename(originalFile, claimedFile);
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw markerError('DATABASE_OPERATION_LOCK_OWNERSHIP_CHANGED', originalFile);
    }
    throw error;
  }
  try {
    await syncParentDirectory(fileSystem, originalFile);
  } catch (error) {
    error.recoveryAuthority = Object.freeze({ claimedFile, originalFile });
    throw error;
  }
  let claimed;
  try {
    claimed = await readOpaquePathSnapshot(fileSystem, claimedFile);
  } catch (error) {
    let restoreError;
    try {
      await restoreClaimedPath(fileSystem, { claimedFile, snapshot: null }, originalFile);
    } catch (failure) {
      restoreError = failure;
    }
    throw combineOperationErrors(
      error,
      restoreError,
      `Database operation lock claim inspection and restoration failed: ${originalFile}`,
    );
  }
  if (!sameFileIdentity(claimed.stat, expected.stat)
      || !claimed.bytes.equals(expected.bytes)) {
    let restoreError;
    try {
      await restoreClaimedPath(fileSystem, { claimedFile, snapshot: claimed }, originalFile);
    } catch (error) {
      restoreError = error;
    }
    throw combineOperationErrors(
      markerError('DATABASE_OPERATION_LOCK_OWNERSHIP_CHANGED', originalFile),
      restoreError,
      `Database operation lock foreign claim restoration failed: ${originalFile}`,
    );
  }
  return {
    claimedFile,
    lockFile: originalFile.endsWith('.authority')
      ? originalFile.slice(0, -'.authority'.length)
      : originalFile,
    snapshot: claimed,
  };
}

async function restoreExactClaim(fileSystem, claim, originalFile) {
  await restoreClaimedPath(fileSystem, claim, originalFile);
}

async function quarantineExactClaim(fileSystem, claim) {
  const originalClaimedFile = claim.claimedFile;
  const protocolLockFile = claim.lockFile || claim.snapshot.lockFile;
  const quarantineSuffix = /\.delete-[0-9a-f]{64}\.quarantine$/u;
  const nextSuffix = `.delete-${randomMarkerToken()}.quarantine`;
  const quarantineFile = quarantineSuffix.test(originalClaimedFile)
    ? originalClaimedFile.replace(quarantineSuffix, nextSuffix)
    : `${originalClaimedFile}${nextSuffix}`;
  try {
    await fileSystem.rename(originalClaimedFile, quarantineFile);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  claim.claimedFile = quarantineFile;
  try {
    await syncParentDirectory(fileSystem, originalClaimedFile);
  } catch (error) {
    error.recoveryAuthority = Object.freeze({
      claimedFile: originalClaimedFile,
      quarantineFile,
    });
    throw error;
  }
  const quarantined = await readOpaquePathSnapshot(fileSystem, quarantineFile);
  if (!sameFileIdentity(quarantined.stat, claim.snapshot.stat)
      || !quarantined.bytes.equals(claim.snapshot.bytes)) {
    let restoreError;
    try {
      await fileSystem.link(quarantineFile, originalClaimedFile);
      await syncParentDirectory(fileSystem, originalClaimedFile);
    } catch (error) {
      restoreError = error;
    }
    const error = combineOperationErrors(
      markerError('DATABASE_OPERATION_LOCK_OWNERSHIP_CHANGED', claim.claimedFile),
      restoreError,
      `Database operation lock foreign quarantine restoration failed: ${claim.claimedFile}`,
    );
    error.recoveryAuthority = Object.freeze({
      claimedFile: originalClaimedFile,
      quarantineFile,
    });
    throw error;
  }
  claim.lockFile = protocolLockFile;
  claim.snapshot = quarantined;
  return claim;
}

async function deleteQuarantinedClaim(fileSystem, quarantined) {
  try {
    await retireQuarantinedClaim(fileSystem, quarantined);
  } catch (error) {
    error.recoveryAuthority ||= Object.freeze({ quarantineFile: quarantined.claimedFile });
    throw error;
  }
}

async function discardExactClaim(fileSystem, claim) {
  if (claim.retirement) {
    await retireQuarantinedClaim(fileSystem, claim);
    return;
  }
  const quarantined = await quarantineExactClaim(fileSystem, claim);
  if (!quarantined) return;
  await deleteQuarantinedClaim(fileSystem, quarantined);
}

async function discardExactClaimAfterCanonicalCheck(
  fileSystem,
  claim,
  canonicalFile,
  expectedCanonical,
) {
  const quarantined = await quarantineExactClaim(fileSystem, claim);
  if (!quarantined) {
    const error = markerError('DATABASE_OPERATION_LOCK_RESTORATION_UNCERTAIN', canonicalFile);
    error.recoveryAuthority = Object.freeze({
      claimedFile: claim.claimedFile,
      originalFile: canonicalFile,
    });
    throw error;
  }
  const canonical = await readOptionalPathSnapshot(fileSystem, canonicalFile);
  if (!canonical
      || !sameFileIdentity(canonical.stat, expectedCanonical.stat)
      || !canonical.bytes.equals(expectedCanonical.bytes)) {
    const error = markerError('DATABASE_OPERATION_LOCK_OWNERSHIP_CHANGED', canonicalFile);
    error.recoveryAuthority = Object.freeze({
      claimedFile: claim.claimedFile,
      originalFile: canonicalFile,
      quarantineFile: quarantined.claimedFile,
    });
    throw error;
  }
  await deleteQuarantinedClaim(fileSystem, quarantined);
}

async function claimAuthorityPair({
  authorityFile,
  authoritySnapshot,
  fileSystem,
  lockFile,
  markerSnapshot,
  label,
}) {
  const markerClaim = await claimExactPath(fileSystem, lockFile, markerSnapshot, `${label}-marker`);
  let authorityClaim;
  try {
    authorityClaim = await claimExactPath(
      fileSystem,
      authorityFile,
      authoritySnapshot,
      `${label}-authority`,
    );
  } catch (error) {
    let restoreError;
    try {
      await restoreExactClaim(fileSystem, markerClaim, lockFile);
    } catch (failure) {
      restoreError = failure;
    }
    throw combineOperationErrors(
      error,
      restoreError,
      `Database operation lock marker restoration failed: ${lockFile}`,
    );
  }
  return { authorityClaim, markerClaim };
}

async function discardAuthorityPair(fileSystem, claims, lockFile) {
  let markerError_;
  if (claims.markerClaim) {
    try {
      await discardExactClaim(fileSystem, claims.markerClaim);
    } catch (error) {
      markerError_ = error;
    }
  }
  let authorityError;
  if (claims.authorityClaim) {
    try {
      await discardExactClaim(fileSystem, claims.authorityClaim);
    } catch (error) {
      authorityError = error;
    }
  }
  const claimFailure = combineOperationErrors(
    markerError_,
    authorityError,
    `Database operation lock claimed authority cleanup failed: ${lockFile}`,
  );
  let settlementError;
  try {
    await syncParentDirectory(fileSystem, lockFile);
    if (!claimFailure) await assertProtocolNamespace(fileSystem, lockFile);
  } catch (error) {
    settlementError = error;
  }
  const failure = combineOperationErrors(
    claimFailure,
    settlementError,
    `Database operation lock claimed authority settlement failed: ${lockFile}`,
  );
  if (failure) throw failure;
}

function parsePositivePid(value) {
  if (!/^[1-9]\d*$/u.test(value)) throw new Error('Database operation lock owner PID is invalid');
  const ownerPid = Number(value);
  if (!Number.isSafeInteger(ownerPid)) {
    throw new Error('Database operation lock owner PID is invalid');
  }
  return ownerPid;
}

async function defaultProcessLivenessProbe(ownerPid) {
  try {
    process.kill(ownerPid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    if (error.code === 'EPERM') return true;
    throw error;
  }
}

function parseOrderedFields(lines, expectedNames) {
  if (lines.length !== expectedNames.length) {
    throw new Error('Database operation lock retained marker has invalid fields');
  }
  const fields = {};
  for (let index = 0; index < expectedNames.length; index += 1) {
    const prefix = `${expectedNames[index]}=`;
    if (!lines[index].startsWith(prefix)) {
      throw new Error('Database operation lock retained marker has invalid fields');
    }
    fields[expectedNames[index]] = lines[index].slice(prefix.length);
  }
  return fields;
}

function evidenceFromFields(fields) {
  const activityCount = fields.lastProbeActivityCount === 'unknown'
    ? 'unknown'
    : Number(fields.lastProbeActivityCount);
  const common = {
    applicationName: fields.applicationName,
    kind: fields.evidenceKind,
    lastProbe: {
      activityCount,
      process: fields.lastProbeProcess,
      status: fields.lastProbeStatus,
    },
    operationToken: fields.operationToken,
    postgresContainerId: fields.postgresContainerId,
  };
  if (fields.evidenceKind === 'import') {
    common.importContainerId = fields.importContainerId;
    common.ownershipToken = fields.ownershipToken;
    if (fields.localChildRecovery !== undefined) {
      common.localChildRecovery = decodeProductionImportLocalChildRecovery(
        fields.localChildRecovery,
      );
    }
  }
  const formatted = formatRecoveryEvidence(common);
  const comparableNames = [
    'applicationName',
    'evidenceKind',
    'importContainerId',
    'lastProbeActivityCount',
    'lastProbeProcess',
    'lastProbeStatus',
    'operationToken',
    'ownershipToken',
    'postgresContainerId',
  ];
  if (comparableNames.some((name) => formatted[name] !== fields[name])) {
    throw new Error('Database operation lock retained marker evidence is invalid');
  }
  if (fields.localChildRecovery !== undefined
      && encodeProductionImportLocalChildRecovery(formatted.localChildRecovery)
        !== fields.localChildRecovery) {
    throw new Error('Database operation lock retained marker evidence is invalid');
  }
  return common;
}

function decodeMarkerLines(bytes) {
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes) || !text.endsWith('\n') || text.includes('\r')) {
    throw new Error('Database operation lock retained marker encoding is invalid');
  }
  const lines = text.split('\n');
  lines.pop();
  return lines;
}

function parseActiveMarker(bytes) {
  const lines = decodeMarkerLines(bytes);
  if (lines.length !== 5
      || lines[0] !== 'ACTIVE'
      || lines[1] !== `protocol=${ACTIVE_PROTOCOL}`
      || !lines[2].startsWith('authorityToken=')
      || !lines[3].startsWith('ownerPid=')
      || !lines[4].startsWith('markerSha256=')) {
    throw new Error('Database operation lock ACTIVE authority is invalid');
  }
  const authorityToken = lines[2].slice('authorityToken='.length);
  const checksum = lines[4].slice('markerSha256='.length);
  if (!CANONICAL_MARKER_TOKEN.test(authorityToken)
      || !CANONICAL_MARKER_TOKEN.test(checksum)
      || sha256(markerPayload(lines.slice(0, -1))) !== checksum) {
    throw new Error('Database operation lock ACTIVE authority is invalid');
  }
  const ownerPid = parsePositivePid(lines[3].slice('ownerPid='.length));
  return { authorityToken, ownerPid };
}

function parseAbsenceLeaseMarker(bytes) {
  const lines = decodeMarkerLines(bytes);
  if (lines.length !== 6
      || lines[0] !== 'ABSENCE_LEASE'
      || lines[1] !== `protocol=${ABSENCE_LEASE_PROTOCOL}`
      || !lines[2].startsWith('authorityToken=')
      || !lines[3].startsWith('ownerPid=')
      || lines[4] !== 'purpose=host-guard-bound-database-absence-proof'
      || !lines[5].startsWith('markerSha256=')) {
    throw new Error('Database operation lock absence lease is invalid');
  }
  const authorityToken = lines[2].slice('authorityToken='.length);
  const checksum = lines[5].slice('markerSha256='.length);
  if (!CANONICAL_MARKER_TOKEN.test(authorityToken)
      || !CANONICAL_MARKER_TOKEN.test(checksum)
      || sha256(markerPayload(lines.slice(0, -1))) !== checksum) {
    throw new Error('Database operation lock absence lease is invalid');
  }
  const ownerPid = parsePositivePid(lines[3].slice('ownerPid='.length));
  return { authorityToken, ownerPid };
}

function parseLocalChildHoldMarker(bytes) {
  const lines = decodeMarkerLines(bytes);
  if (lines.length !== 7
      || lines[0] !== 'LOCAL_CHILD_HOLD'
      || lines[1] !== `protocol=${LOCAL_CHILD_HOLD_PROTOCOL}`
      || !lines[2].startsWith('authorityToken=')
      || !lines[3].startsWith('holdToken=')
      || !lines[4].startsWith('ownerPid=')
      || !lines[5].startsWith('commandSha256=')
      || !lines[6].startsWith('markerSha256=')) {
    throw new Error('Database operation local-child hold is invalid');
  }
  const authorityToken = lines[2].slice('authorityToken='.length);
  const holdToken = lines[3].slice('holdToken='.length);
  const ownerPid = parsePositivePid(lines[4].slice('ownerPid='.length));
  const commandSha256 = lines[5].slice('commandSha256='.length);
  const checksum = lines[6].slice('markerSha256='.length);
  if (!CANONICAL_MARKER_TOKEN.test(authorityToken)
      || !CANONICAL_MARKER_TOKEN.test(holdToken)
      || !CANONICAL_MARKER_TOKEN.test(commandSha256)
      || !CANONICAL_MARKER_TOKEN.test(checksum)
      || sha256(markerPayload(lines.slice(0, -1))) !== checksum) {
    throw new Error('Database operation local-child hold is invalid');
  }
  return { authorityToken, commandSha256, holdToken, ownerPid };
}

function parseRetainedMarker(bytes) {
  const lines = decodeMarkerLines(bytes);
  if (lines[0] !== 'RETAINED') {
    throw new Error('DATABASE_OPERATION_LOCK_NOT_RETAINED');
  }
  if (lines[1] === `protocol=${RETAINED_PROTOCOL}`
      || lines[1] === `protocol=${LOCAL_CHILD_RETAINED_PROTOCOL}`) {
    const protocol = lines[1].slice('protocol='.length);
    const checksumLine = lines.at(-1);
    const checksumPrefix = 'markerSha256=';
    if (!checksumLine?.startsWith(checksumPrefix)
        || !CANONICAL_MARKER_TOKEN.test(checksumLine.slice(checksumPrefix.length))) {
      throw new Error('Database operation lock retained marker checksum is invalid');
    }
    const payloadLines = lines.slice(0, -1);
    if (sha256(markerPayload(payloadLines)) !== checksumLine.slice(checksumPrefix.length)) {
      throw new Error('Database operation lock retained marker checksum is invalid');
    }
    const fields = parseOrderedFields(payloadLines.slice(2), [
      'authorityToken',
      'ownerPid',
      'reason',
      'evidenceKind',
      'operationToken',
      'applicationName',
      'ownershipToken',
      'importContainerId',
      'postgresContainerId',
      'lastProbeStatus',
      'lastProbeProcess',
      'lastProbeActivityCount',
      ...(protocol === LOCAL_CHILD_RETAINED_PROTOCOL ? ['localChildRecovery'] : []),
    ]);
    if (!CANONICAL_MARKER_TOKEN.test(fields.authorityToken)) {
      throw new Error('Database operation lock retained marker authority is invalid');
    }
    parsePositivePid(fields.ownerPid);
    const evidence = evidenceFromFields(fields);
    if (expectedEvidenceKindForReason(fields.reason) !== evidence.kind) {
      throw new Error('Database operation lock retained marker reason is invalid');
    }
    if ((fields.reason === PRODUCTION_IMPORT_LOCAL_CHILD_RETENTION_REASON)
        !== Boolean(evidence.localChildRecovery)) {
      throw new Error('Database operation lock retained marker local-child evidence is invalid');
    }
    return {
      authorityToken: fields.authorityToken,
      evidence,
      legacy: false,
      protocol,
      reason: fields.reason,
    };
  }
  if (lines[1] !== `protocol=${LEGACY_RETAINED_PROTOCOL}`) {
    throw new Error('Database operation lock retained marker protocol is unsupported');
  }
  const fields = parseOrderedFields(lines.slice(2), [
    'ownerPid',
    'reason',
    'evidenceKind',
    'operationToken',
    'applicationName',
    'ownershipToken',
    'importContainerId',
    'postgresContainerId',
    'lastProbeStatus',
    'lastProbeProcess',
    'lastProbeActivityCount',
  ]);
  parsePositivePid(fields.ownerPid);
  const evidence = evidenceFromFields(fields);
  if (expectedEvidenceKindForReason(fields.reason) !== evidence.kind) {
    throw new Error('Database operation lock retained marker reason is invalid');
  }
  return {
    authorityToken: null,
    evidence,
    legacy: true,
    protocol: LEGACY_RETAINED_PROTOCOL,
    reason: fields.reason,
  };
}

async function createDatabaseOperationAuthority({
  authorityToken,
  fileSystem,
  label,
  lockFile,
  markerBytes,
  parseMarker,
}) {
  await fileSystem.mkdir(path.dirname(lockFile), { recursive: true });
  await requireRetirementCapacity(
    fileSystem,
    lockFile,
    RETIREMENT_RESERVE_FOR_NEW_AUTHORITY,
  );
  if (protocolEntries(
    await fileSystem.readdir(path.dirname(lockFile)),
    path.basename(lockFile),
  ).length > 0) {
    throw markerError('DATABASE_OPERATION_LOCKED', lockFile);
  }
  const authorityFile = authorityFileFor(lockFile);
  const temporary = await writeDurableTemporaryMarker({
    bytes: markerBytes,
    fileSystem,
    label,
    lockFile,
  });
  try {
    await fileSystem.link(temporary.temporaryFile, authorityFile);
  } catch (error) {
    const primaryError = error.code === 'EEXIST'
      ? markerError('DATABASE_OPERATION_LOCKED', lockFile)
      : error;
    await removeTemporaryFile(fileSystem, lockFile, temporary.temporaryFile, primaryError);
  }
  try {
    await fileSystem.link(temporary.temporaryFile, lockFile);
  } catch (error) {
    const primaryError = error.code === 'EEXIST'
      ? markerError('DATABASE_OPERATION_LOCKED', lockFile)
      : error;
    let authorityCleanupError;
    try {
      const authorityClaim = await claimExactPath(
        fileSystem,
        authorityFile,
        temporary,
        'acquire-cleanup-authority',
      );
      await discardExactClaim(fileSystem, authorityClaim);
      await syncParentDirectory(fileSystem, lockFile);
    } catch (failure) {
      authorityCleanupError = failure;
    }
    let temporaryCleanupError;
    try {
      await discardExactClaim(fileSystem, {
        claimedFile: temporary.temporaryFile,
        snapshot: temporary,
      });
    } catch (failure) {
      temporaryCleanupError = failure;
    }
    const failure = combineOperationErrors(
      combineOperationErrors(
        primaryError,
        authorityCleanupError,
        `Database operation lock authority cleanup failed: ${authorityFile}`,
      ),
      temporaryCleanupError,
      `Database operation lock acquisition cleanup failed: ${lockFile}`,
    );
    if (authorityCleanupError) {
      throw recoverableAcquisitionError(failure, lockFile, authorityFile, authorityToken);
    }
    throw failure;
  }
  let markerSnapshot;
  let authoritySnapshot;
  try {
    await syncParentDirectory(fileSystem, lockFile);
    markerSnapshot = await readPathSnapshot(fileSystem, lockFile);
    authoritySnapshot = await readPathSnapshot(fileSystem, authorityFile);
    if (!sameFileIdentity(markerSnapshot.stat, temporary.stat)
        || !markerSnapshot.bytes.equals(markerBytes)
        || !sameFileIdentity(authoritySnapshot.stat, temporary.stat)
        || !authoritySnapshot.bytes.equals(markerBytes)
        || parseMarker(markerSnapshot.bytes).authorityToken !== authorityToken
        || parseMarker(authoritySnapshot.bytes).authorityToken !== authorityToken) {
      throw markerError('DATABASE_OPERATION_LOCK_OWNERSHIP_CHANGED', lockFile);
    }
    await discardExactClaim(fileSystem, {
      claimedFile: temporary.temporaryFile,
      snapshot: temporary,
    });
    await syncParentDirectory(fileSystem, lockFile);
    const baseName = path.basename(lockFile);
    await assertProtocolNamespace(fileSystem, lockFile, [
      baseName,
      `${baseName}.authority`,
    ]);
  } catch (error) {
    throw recoverableAcquisitionError(error, lockFile, authorityFile, authorityToken);
  }
  return {
    authorityFile,
    authoritySnapshot,
    authorityToken,
    markerSnapshot,
  };
}

export async function acquireDatabaseOperationLock(
  lockFile = DEFAULT_DATABASE_OPERATION_LOCK_FILE,
  { fileSystem = fsp } = {},
) {
  const authorityToken = randomMarkerToken();
  const activeBytes = buildActiveMarker(authorityToken);
  const authority = await createDatabaseOperationAuthority({
    authorityToken,
    fileSystem,
    label: 'active',
    lockFile,
    markerBytes: activeBytes,
    parseMarker: parseActiveMarker,
  });
  const {
    authorityFile,
    authoritySnapshot,
    markerSnapshot: activeSnapshot,
  } = authority;

  let state = 'owned';
  let localChildHoldState = 'absent';
  let localChildHoldAuthority = null;
  let releaseClaims;
  const release = async () => {
    if (state === 'retained' || state === 'retaining' || state === 'retention-failed') {
      throw new Error(`DATABASE_OPERATION_LOCK_RETAINED: ${lockFile}`);
    }
    if (state === 'released' || state === 'releasing') {
      throw new Error(`DATABASE_OPERATION_LOCK_NOT_OWNED: ${lockFile}`);
    }
    if (localChildHoldState !== 'absent') {
      throw markerError('DATABASE_OPERATION_LOCK_LOCAL_CHILD_HELD', lockFile);
    }
    if (state === 'owned') {
      state = 'releasing';
      try {
        releaseClaims = await claimAuthorityPair({
          authorityFile,
          authoritySnapshot,
          fileSystem,
          label: 'release',
          lockFile,
          markerSnapshot: activeSnapshot,
        });
        state = 'release-cleanup-pending';
      } catch (error) {
        state = 'owned';
        throw error;
      }
    }
    await discardAuthorityPair(fileSystem, releaseClaims, lockFile);
    state = 'released';
  };
  release.beginLocalChildHold = async ({ commandLabel } = {}) => {
    if (state !== 'owned' || localChildHoldState !== 'absent') {
      throw markerError('DATABASE_OPERATION_LOCK_LOCAL_CHILD_HELD', lockFile);
    }
    if (typeof commandLabel !== 'string' || !commandLabel || commandLabel.length > 4_096) {
      throw new Error('Database operation local-child command label is invalid');
    }
    localChildHoldState = 'creating';
    const holdToken = randomMarkerToken();
    const commandSha256 = sha256(String(commandLabel));
    // Keep the pathname comfortably below legacy Windows MAX_PATH even while the
    // exact-claim and quarantine suffixes are appended. The full 256-bit token
    // remains inside the checksummed marker; the exclusive 128-bit path suffix
    // is only a private namespace locator.
    const holdFile = `${lockFile}.local-child-${holdToken.slice(0, 32)}`;
    const bytes = buildLocalChildHoldMarker(authorityToken, holdToken, commandLabel);
    let temporary;
    let holdSnapshot;
    try {
      await assertProtocolNamespace(fileSystem, lockFile, [
        path.basename(lockFile),
        path.basename(authorityFile),
      ]);
      temporary = await writeDurableTemporaryMarker({
        bytes,
        fileSystem,
        label: 'local-child',
        lockFile,
      });
      await fileSystem.link(temporary.temporaryFile, holdFile);
      await syncParentDirectory(fileSystem, holdFile);
      holdSnapshot = await readPathSnapshot(fileSystem, holdFile);
      if (!sameFileIdentity(holdSnapshot.stat, temporary.stat)
          || !holdSnapshot.bytes.equals(bytes)) {
        throw markerError('DATABASE_OPERATION_LOCK_OWNERSHIP_CHANGED', holdFile);
      }
      await discardExactClaimAfterCanonicalCheck(
        fileSystem,
        { claimedFile: temporary.temporaryFile, lockFile, snapshot: temporary },
        holdFile,
        holdSnapshot,
      );
      temporary = null;
      await syncParentDirectory(fileSystem, holdFile);
      await assertProtocolNamespace(fileSystem, lockFile, [
        path.basename(lockFile),
        path.basename(authorityFile),
        path.basename(holdFile),
      ]);
      localChildHoldAuthority = Object.freeze({
        authorityToken,
        commandSha256,
        holdToken,
      });
      localChildHoldState = 'held';
    } catch (error) {
      localChildHoldState = 'hold-failed';
      error.recoveryAuthority ||= Object.freeze({ holdFile, holdToken, lockFile });
      throw error;
    }

    let holdState = 'held';
    return Object.freeze({
      holdFile,
      holdToken,
      async release() {
        if (holdState !== 'held' || localChildHoldState !== 'held') {
          throw markerError('DATABASE_OPERATION_LOCK_LOCAL_CHILD_HOLD_NOT_OWNED', holdFile);
        }
        holdState = 'releasing';
        localChildHoldState = 'releasing';
        try {
          const claim = await claimExactPath(
            fileSystem,
            holdFile,
            holdSnapshot,
            'child',
          );
          await discardExactClaim(fileSystem, claim);
          await syncParentDirectory(fileSystem, holdFile);
          await assertProtocolNamespace(fileSystem, lockFile, [
            path.basename(lockFile),
            path.basename(authorityFile),
          ]);
          holdState = 'released';
          localChildHoldAuthority = null;
          localChildHoldState = 'absent';
        } catch (error) {
          holdState = 'release-failed';
          localChildHoldState = 'release-failed';
          error.recoveryAuthority ||= Object.freeze({ holdFile, holdToken, lockFile });
          throw error;
        }
      },
    });
  };
  release.describeLocalChildHold = () => {
    if (!localChildHoldAuthority
        || !new Set(['held', 'releasing', 'release-failed']).has(localChildHoldState)) {
      return null;
    }
    return localChildHoldAuthority;
  };
  release.retain = async (reason, recoveryEvidence) => {
    if (state !== 'owned') {
      throw new Error(`DATABASE_OPERATION_LOCK_NOT_OWNED: ${lockFile}`);
    }
    if (localChildHoldState !== 'absent') {
      throw markerError('DATABASE_OPERATION_LOCK_LOCAL_CHILD_HELD', lockFile);
    }
    if (!/^[A-Z][A-Z0-9_]{0,127}$/u.test(reason || '')) {
      throw new Error('Database operation lock retention reason must be a safe uppercase code');
    }
    const expectedEvidenceKind = expectedEvidenceKindForReason(reason);
    if (!expectedEvidenceKind) {
      throw new Error('Database operation lock retention reason is unsupported');
    }
    if (recoveryEvidence === undefined) {
      throw new Error(`Database operation lock ${expectedEvidenceKind} recovery evidence is required`);
    }
    const evidence = formatRecoveryEvidence(recoveryEvidence);
    if (evidence.evidenceKind !== expectedEvidenceKind) {
      throw new Error('Database operation lock recovery evidence does not match retention reason');
    }
    state = 'retaining';
    const retainedBytes = buildRetainedMarker(authorityToken, reason, evidence);
    let temporary;
    let activeClaim;
    let committed = false;
    try {
      temporary = await writeDurableTemporaryMarker({
        bytes: retainedBytes,
        fileSystem,
        label: 'retained',
        lockFile,
      });
      activeClaim = await claimExactPath(
        fileSystem,
        lockFile,
        activeSnapshot,
        'retain-active',
      );
      try {
        await fileSystem.link(temporary.temporaryFile, lockFile);
      } catch (error) {
        let restoreError;
        try {
          await restoreExactClaim(fileSystem, activeClaim, lockFile);
          activeClaim = null;
        } catch (failure) {
          restoreError = failure;
        }
        throw combineOperationErrors(
          error,
          restoreError,
          `Database operation lock ACTIVE restoration failed: ${lockFile}`,
        );
      }
      committed = true;
      await syncParentDirectory(fileSystem, lockFile);
      const retainedSnapshot = await readPathSnapshot(fileSystem, lockFile);
      if (!sameFileIdentity(retainedSnapshot.stat, temporary.stat)
          || !retainedSnapshot.bytes.equals(retainedBytes)) {
        throw markerError('DATABASE_OPERATION_LOCK_OWNERSHIP_CHANGED', lockFile);
      }
      const parsed = parseRetainedMarker(retainedSnapshot.bytes);
      if (parsed.authorityToken !== authorityToken) {
        throw markerError('DATABASE_OPERATION_LOCK_OWNERSHIP_CHANGED', lockFile);
      }
      await discardExactClaim(fileSystem, activeClaim);
      activeClaim = null;
      await discardExactClaimAfterCanonicalCheck(
        fileSystem,
        { claimedFile: temporary.temporaryFile, snapshot: temporary },
        lockFile,
        retainedSnapshot,
      );
      temporary = null;
      await syncParentDirectory(fileSystem, lockFile);
      const baseName = path.basename(lockFile);
      await assertProtocolNamespace(fileSystem, lockFile, [
        baseName,
        `${baseName}.authority`,
      ]);
      state = 'retained';
    } catch (error) {
      state = committed ? 'retained' : 'retention-failed';
      let cleanupError;
      if (temporary && !committed) {
        try {
          await discardExactClaim(fileSystem, {
            claimedFile: temporary.temporaryFile,
            snapshot: temporary,
          });
        } catch (failure) {
          cleanupError = failure;
        }
      }
      if (activeClaim) {
        try {
          if (!committed) await restoreExactClaim(fileSystem, activeClaim, lockFile);
        } catch (failure) {
          cleanupError = combineOperationErrors(
            cleanupError,
            failure,
            `Database operation lock ACTIVE claim cleanup failed: ${lockFile}`,
          );
        }
      }
      if (committed && (temporary || activeClaim)) {
        error.recoveryAuthority ||= Object.freeze({
          activeClaimFile: activeClaim?.claimedFile,
          retainedTemporaryFile: temporary?.temporaryFile,
        });
      }
      throw combineOperationErrors(
        error,
        cleanupError,
        `Database operation lock retention cleanup failed: ${lockFile}`,
      );
    }
  };
  return release;
}

export async function openRetainedDatabaseOperationLock({
  lockFile = DEFAULT_DATABASE_OPERATION_LOCK_FILE,
  expectedEvidenceKind,
  fileSystem = fsp,
} = {}) {
  if (!/^(?:import|restore)$/u.test(expectedEvidenceKind || '')) {
    throw new Error('Database operation lock expected evidence kind must be import or restore');
  }
  const snapshot = await readPathSnapshot(fileSystem, lockFile);
  const parsed = parseRetainedMarker(snapshot.bytes);
  if (parsed.evidence.kind !== expectedEvidenceKind) {
    throw new Error('Database operation lock retained evidence kind does not match recovery');
  }
  const authorityFile = authorityFileFor(lockFile);
  let authoritySnapshot;
  if (!parsed.legacy) {
    authoritySnapshot = await readPathSnapshot(fileSystem, authorityFile);
    const activeAuthority = parseActiveMarker(authoritySnapshot.bytes);
    if (activeAuthority.authorityToken !== parsed.authorityToken) {
      throw markerError('DATABASE_OPERATION_LOCK_OWNERSHIP_CHANGED', lockFile);
    }
  }
  let state = 'open';
  let completionClaims;
  const complete = async () => {
    if (parsed.legacy) {
      throw new Error(`DATABASE_OPERATION_LOCK_LEGACY_READ_ONLY: ${lockFile}`);
    }
    if (state === 'completed' || state === 'completing') {
      throw new Error(`DATABASE_OPERATION_LOCK_COMPLETION_NOT_OWNED: ${lockFile}`);
    }
    if (state === 'open') {
      state = 'completing';
      try {
        completionClaims = await claimAuthorityPair({
          authorityFile,
          authoritySnapshot,
          fileSystem,
          label: 'complete',
          lockFile,
          markerSnapshot: snapshot,
        });
        state = 'completion-cleanup-pending';
      } catch (error) {
        state = 'open';
        throw error;
      }
    }
    await discardAuthorityPair(fileSystem, completionClaims, lockFile);
    state = 'completed';
  };
  return {
    complete,
    evidence: parsed.evidence,
    legacy: parsed.legacy,
    protocol: parsed.protocol,
    reason: parsed.reason,
  };
}

function createAbsenceLeaseHandle({
  authorityFile,
  authoritySnapshot,
  claims = { authorityClaim: null, markerClaim: null },
  fileSystem,
  lockFile,
  markerSnapshot,
  state = 'held',
}) {
  let leaseState = state;
  const leaseClaims = claims;
  const release = async () => {
    if (leaseState === 'released' || leaseState === 'claiming') {
      throw new Error(`DATABASE_OPERATION_LOCK_ABSENCE_LEASE_NOT_OWNED: ${lockFile}`);
    }
    if (leaseState === 'held') {
      leaseState = 'claiming';
      try {
        const claimed = await claimAuthorityPair({
          authorityFile,
          authoritySnapshot,
          fileSystem,
          label: 'absence-release',
          lockFile,
          markerSnapshot,
        });
        leaseClaims.authorityClaim = claimed.authorityClaim;
        leaseClaims.markerClaim = claimed.markerClaim;
        leaseState = 'cleanup-pending';
      } catch (error) {
        leaseState = 'held';
        throw error;
      }
    } else if (leaseState === 'recovery-pending') {
      leaseState = 'claiming';
      try {
        if (!leaseClaims.markerClaim && markerSnapshot) {
          leaseClaims.markerClaim = await claimExactPath(
            fileSystem,
            lockFile,
            markerSnapshot,
            'absence-release-marker',
          );
        }
        if (!leaseClaims.authorityClaim && authoritySnapshot) {
          leaseClaims.authorityClaim = await claimExactPath(
            fileSystem,
            authorityFile,
            authoritySnapshot,
            'absence-release-authority',
          );
        }
        leaseState = 'cleanup-pending';
      } catch (error) {
        leaseState = 'recovery-pending';
        throw error;
      }
    }
    await discardAuthorityPair(fileSystem, leaseClaims, lockFile);
    leaseState = 'released';
  };
  return Object.freeze({
    absent: true,
    lockFile,
    protocol: ABSENCE_LEASE_PROTOCOL,
    release,
  });
}

function protocolEntries(entries, baseName) {
  return entries.filter((entry) => entry === baseName || entry.startsWith(`${baseName}.`));
}

async function assertProtocolNamespace(fileSystem, lockFile, expectedEntries = []) {
  const baseName = path.basename(lockFile);
  const actual = protocolEntries(
    await fileSystem.readdir(path.dirname(lockFile)),
    baseName,
  ).sort();
  const expected = [...expectedEntries].sort();
  if (actual.length !== expected.length
      || actual.some((entry, index) => entry !== expected[index])) {
    const error = markerError('DATABASE_OPERATION_LOCK_CLEANUP_INCOMPLETE', lockFile);
    error.recoveryAuthority = Object.freeze({ protocolEntries: actual });
    throw error;
  }
}

function retirementSlotPrefix(lockFile) {
  return `${path.basename(lockFile)}-retired-`;
}

function retirementCapacityError(lockFile) {
  return markerError('DATABASE_OPERATION_LOCK_RETIREMENT_CAPACITY_EXHAUSTED', lockFile);
}

async function retirementSlotNames(fileSystem, lockFile) {
  const prefix = retirementSlotPrefix(lockFile);
  const slotPattern = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\\d{3}$`, 'u');
  return (await fileSystem.readdir(path.dirname(lockFile))).filter((entry) => (
    slotPattern.test(entry)
  ));
}

async function requireRetirementCapacity(fileSystem, lockFile, reserve = 1) {
  const used = (await retirementSlotNames(fileSystem, lockFile)).length;
  if (used + reserve > DATABASE_OPERATION_LOCK_RETIREMENT_CAPACITY) {
    throw retirementCapacityError(lockFile);
  }
}

async function allocateRetirementSlot(fileSystem, lockFile) {
  await requireRetirementCapacity(fileSystem, lockFile);
  const directory = path.dirname(lockFile);
  const prefix = retirementSlotPrefix(lockFile);
  for (let index = 0; index < DATABASE_OPERATION_LOCK_RETIREMENT_CAPACITY; index += 1) {
    const slotDirectory = path.join(directory, `${prefix}${String(index).padStart(3, '0')}`);
    try {
      await fileSystem.mkdir(slotDirectory, { mode: 0o700 });
      await syncParentDirectory(fileSystem, slotDirectory);
      return slotDirectory;
    } catch (error) {
      if (error.code !== 'EEXIST') {
        error.recoveryAuthority = Object.freeze({ retirementDirectory: slotDirectory });
        throw error;
      }
    }
  }
  throw retirementCapacityError(lockFile);
}

async function restoreCapturedForeign(fileSystem, retirement, recoveryAuthority) {
  let restoreError;
  try {
    await fileSystem.link(retirement.capturedFile, retirement.sourceFile);
    await syncParentDirectory(fileSystem, retirement.sourceFile);
  } catch (error) {
    if (error.code !== 'EEXIST') restoreError = error;
  }
  const ownershipError = markerError(
    'DATABASE_OPERATION_LOCK_OWNERSHIP_CHANGED',
    retirement.sourceFile,
  );
  ownershipError.recoveryAuthority = Object.freeze(recoveryAuthority);
  throw combineOperationErrors(
    ownershipError,
    restoreError,
    `Database operation lock captured foreign restoration failed: ${retirement.sourceFile}`,
  );
}

async function reclaimVerifiedRetirement(fileSystem, retirement) {
  const recoveryAuthority = Object.freeze({
    retiredCapturedFile: retirement.capturedFile,
    retiredExactFile: retirement.exactFile,
    retirementDirectory: retirement.slotDirectory,
  });
  if (!retirement.removed) {
    try {
      await fileSystem.rm(retirement.slotDirectory, { recursive: true });
      retirement.removed = true;
    } catch (error) {
      error.recoveryAuthority = recoveryAuthority;
      throw error;
    }
  }
  try {
    await syncParentDirectory(fileSystem, retirement.slotDirectory);
  } catch (error) {
    error.recoveryAuthority = recoveryAuthority;
    throw error;
  }
}

async function retireQuarantinedClaim(fileSystem, quarantined) {
  const expected = quarantined.snapshot;
  const lockFile = quarantined.lockFile || expected.lockFile;
  if (!lockFile) {
    throw markerError('DATABASE_OPERATION_LOCK_RECOVERY_AMBIGUOUS', quarantined.claimedFile);
  }
  if (quarantined.retirement?.removed) {
    await reclaimVerifiedRetirement(fileSystem, quarantined.retirement);
    return;
  }
  if (!quarantined.retirement) {
    const slotDirectory = await allocateRetirementSlot(fileSystem, lockFile);
    const retirement = {
      captured: false,
      capturedFile: path.join(slotDirectory, `captured-${randomMarkerToken()}`),
      exactFile: path.join(slotDirectory, 'exact'),
      slotDirectory,
      sourceFile: quarantined.claimedFile,
    };
    quarantined.retirement = retirement;
    try {
      await fileSystem.link(retirement.sourceFile, retirement.exactFile);
      await syncParentDirectory(fileSystem, retirement.exactFile);
    } catch (error) {
      error.recoveryAuthority = Object.freeze({
        quarantineFile: retirement.sourceFile,
        retiredExactFile: retirement.exactFile,
        retirementDirectory: retirement.slotDirectory,
      });
      throw error;
    }
  }
  const { retirement } = quarantined;
  const exact = await readOpaquePathSnapshot(fileSystem, retirement.exactFile);
  if (!sameFileIdentity(exact.stat, expected.stat) || !exact.bytes.equals(expected.bytes)) {
    const error = markerError(
      'DATABASE_OPERATION_LOCK_OWNERSHIP_CHANGED',
      retirement.sourceFile,
    );
    error.recoveryAuthority = Object.freeze({
      quarantineFile: retirement.sourceFile,
      retiredExactFile: retirement.exactFile,
      retirementDirectory: retirement.slotDirectory,
    });
    throw error;
  }
  if (!retirement.captured) {
    const occupiedCapture = await readOptionalOpaquePathSnapshot(
      fileSystem,
      retirement.capturedFile,
    );
    if (occupiedCapture) {
      const error = markerError(
        'DATABASE_OPERATION_LOCK_RETIREMENT_DESTINATION_OCCUPIED',
        retirement.capturedFile,
      );
      error.recoveryAuthority = Object.freeze({
        quarantineFile: retirement.sourceFile,
        retiredCapturedFile: retirement.capturedFile,
        retiredExactFile: retirement.exactFile,
        retirementDirectory: retirement.slotDirectory,
      });
      throw error;
    }
    try {
      // Node has no cross-platform rename-no-replace primitive. The exact inode is already held by
      // the exclusive hardlink above; this move only neutralizes its protocol pathname inside a
      // newly-created mode-0700 slot with a 256-bit destination. Same-UID mutation in this narrow
      // check-to-rename window is the explicit private-path threat boundary.
      await fileSystem.rename(retirement.sourceFile, retirement.capturedFile);
      retirement.captured = true;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const captured = await readOptionalOpaquePathSnapshot(fileSystem, retirement.capturedFile);
      if (!captured) {
        error.recoveryAuthority = Object.freeze({
          quarantineFile: retirement.sourceFile,
          retiredExactFile: retirement.exactFile,
          retirementDirectory: retirement.slotDirectory,
        });
        throw error;
      }
      retirement.captured = true;
    }
  }
  await syncParentDirectory(fileSystem, retirement.capturedFile);
  await syncParentDirectory(fileSystem, retirement.sourceFile);
  const captured = await readOpaquePathSnapshot(fileSystem, retirement.capturedFile);
  if (!sameFileIdentity(captured.stat, expected.stat)
      || !captured.bytes.equals(expected.bytes)) {
    await restoreCapturedForeign(fileSystem, retirement, {
      quarantineFile: retirement.sourceFile,
      retiredCapturedFile: retirement.capturedFile,
      retiredExactFile: retirement.exactFile,
      retirementDirectory: retirement.slotDirectory,
    });
  }
  await reclaimVerifiedRetirement(fileSystem, retirement);
}

const RECOVERY_DELETION_TAIL = String.raw`(?:\.delete-[0-9a-f]{64}\.quarantine)*`;
const RECOVERY_INSTANCE = String.raw`[1-9]\d*-[0-9a-f]{64}`;

function recoveryRoleForEntry(entry, baseName) {
  if (entry === baseName) return { name: 'canonical-marker', side: 'marker' };
  const suffix = entry.slice(baseName.length);
  if (suffix === '.authority') return { name: 'canonical-authority', side: 'authority' };
  const patterns = [
    [new RegExp(`^\\.local-child-[0-9a-f]{32}$`, 'u'),
      { name: 'local-child-hold', phase: 'local-child', side: 'hold' }],
    [new RegExp(`^\\.local-child-${RECOVERY_INSTANCE}\\.tmp${RECOVERY_DELETION_TAIL}$`, 'u'),
      { name: 'local-child-temp', phase: 'local-child', side: 'hold' }],
    [new RegExp(
      `^\\.local-child-[0-9a-f]{32}\\.child-${RECOVERY_INSTANCE}\\.claimed${RECOVERY_DELETION_TAIL}$`,
      'u',
    ), { name: 'local-child-claim', phase: 'local-child', side: 'hold' }],
    [new RegExp(
      `^\\.local-child-active-${RECOVERY_INSTANCE}\\.claimed${RECOVERY_DELETION_TAIL}$`,
      'u',
    ), { name: 'local-child-active', phase: 'local-child', side: 'marker' }],
    [new RegExp(
      `^\\.local-child-retained-${RECOVERY_INSTANCE}\\.tmp${RECOVERY_DELETION_TAIL}$`,
      'u',
    ), { name: 'local-child-retained', phase: 'local-child', side: 'temporary' }],
    [new RegExp(`^\\.active-${RECOVERY_INSTANCE}\\.tmp${RECOVERY_DELETION_TAIL}$`, 'u'),
      { name: 'active-temp', phase: 'acquisition', side: 'temporary' }],
    [new RegExp(`^\\.retained-${RECOVERY_INSTANCE}\\.tmp${RECOVERY_DELETION_TAIL}$`, 'u'),
      { name: 'retained-temp', phase: 'retention', side: 'temporary' }],
    [new RegExp(`^\\.absence-${RECOVERY_INSTANCE}\\.tmp${RECOVERY_DELETION_TAIL}$`, 'u'),
      { name: 'absence-temp', phase: 'absence', side: 'temporary' }],
    [new RegExp(`^\\.retain-active-${RECOVERY_INSTANCE}\\.claimed${RECOVERY_DELETION_TAIL}$`, 'u'),
      { name: 'retain-active', phase: 'retention', side: 'marker' }],
  ];
  for (const phase of ['release', 'complete', 'absence-release', 'acquire-cleanup']) {
    const recoveryPhase = ({
      'absence-release': 'absence',
      'acquire-cleanup': 'acquisition',
      complete: 'completion',
      release: 'release',
    })[phase];
    patterns.push(
      [new RegExp(
        `^\\.${phase}-marker-${RECOVERY_INSTANCE}\\.claimed${RECOVERY_DELETION_TAIL}$`,
        'u',
      ), { name: `${phase}-marker`, phase: recoveryPhase, side: 'marker' }],
      [new RegExp(
        `^\\.authority\\.${phase}-authority-${RECOVERY_INSTANCE}\\.claimed${RECOVERY_DELETION_TAIL}$`,
        'u',
      ), { name: `${phase}-authority`, phase: recoveryPhase, side: 'authority' }],
    );
  }
  return patterns.find(([pattern]) => pattern.test(suffix))?.[1] || null;
}

function describeRecoveryMarker(bytes) {
  try {
    return { kind: 'active', ...parseActiveMarker(bytes) };
  } catch {}
  try {
    return { kind: 'absence', ...parseAbsenceLeaseMarker(bytes) };
  } catch {}
  try {
    const retained = parseRetainedMarker(bytes);
    return {
      authorityToken: retained.authorityToken,
      evidence: retained.evidence,
      kind: retained.legacy ? 'legacy-retained' : 'retained',
      reason: retained.reason,
    };
  } catch {}
  try {
    return { kind: 'local-child-hold', ...parseLocalChildHoldMarker(bytes) };
  } catch {}
  return { kind: 'invalid' };
}

function expectedRecoveryMarkerKinds(role) {
  if (role.name === 'canonical-marker') {
    return new Set(['absence', 'active', 'legacy-retained', 'retained']);
  }
  if (role.name === 'canonical-authority') return new Set(['absence', 'active']);
  if (role.name === 'local-child-active') return new Set(['active']);
  if (role.name === 'local-child-retained') return new Set(['retained']);
  if (role.phase === 'local-child') return new Set(['local-child-hold']);
  if (role.name === 'absence-release-authority') return new Set(['absence']);
  if (role.side === 'authority' || role.name === 'active-temp'
      || role.name === 'retain-active' || role.name === 'release-marker') {
    return new Set(['active']);
  }
  if (role.name === 'absence-temp' || role.name === 'absence-release-marker') {
    return new Set(['absence']);
  }
  if (role.name === 'retained-temp' || role.name === 'complete-marker') {
    return new Set(['retained']);
  }
  return new Set();
}

function inferRecoveryPhase(records, lockFile) {
  const sidecarPhases = new Set(records.map((record) => record.role.phase).filter(Boolean));
  if (sidecarPhases.size > 1) {
    throw markerError('DATABASE_OPERATION_LOCK_RECOVERY_AMBIGUOUS', lockFile);
  }
  if (sidecarPhases.size === 1) return [...sidecarPhases][0];
  const canonicalMarker = records.find((record) => record.role.name === 'canonical-marker');
  const canonicalAuthority = records.find((record) => (
    record.role.name === 'canonical-authority'
  ));
  const kind = canonicalMarker?.descriptor.kind || canonicalAuthority?.descriptor.kind;
  if (kind === 'active') return 'active';
  if (kind === 'absence') return 'absence';
  if (kind === 'retained') return 'retained';
  if (kind === 'legacy-retained') return 'legacy-retained';
  throw markerError('DATABASE_OPERATION_LOCK_RECOVERY_NOT_FOUND', lockFile);
}

function validateRecoveryRecords(records, lockFile, expectedEvidenceKind) {
  const roleCounts = new Map();
  for (const record of records) {
    roleCounts.set(record.role.name, (roleCounts.get(record.role.name) || 0) + 1);
    const allowedKinds = expectedRecoveryMarkerKinds(record.role);
    if (record.descriptor.kind === 'invalid') {
      if (record.role.side !== 'temporary') {
        throw markerError('DATABASE_OPERATION_LOCK_RECOVERY_AMBIGUOUS', lockFile);
      }
    } else if (!allowedKinds.has(record.descriptor.kind)) {
      throw markerError('DATABASE_OPERATION_LOCK_RECOVERY_AMBIGUOUS', lockFile);
    }
  }
  if ([...roleCounts.values()].some((count) => count > 1)) {
    throw markerError('DATABASE_OPERATION_LOCK_RECOVERY_AMBIGUOUS', lockFile);
  }
  const typed = records.filter((record) => record.descriptor.authorityToken);
  const tokens = new Set(typed.map((record) => record.descriptor.authorityToken));
  if (tokens.size > 1) {
    throw markerError('DATABASE_OPERATION_LOCK_OWNERSHIP_CHANGED', lockFile);
  }
  for (const kind of ['absence', 'active', 'local-child-hold', 'retained']) {
    const sameKind = typed.filter((record) => record.descriptor.kind === kind);
    const [first] = sameKind;
    if (first && sameKind.some((record) => (
      !sameFileIdentity(record.snapshot.stat, first.snapshot.stat)
    ))) {
      throw markerError('DATABASE_OPERATION_LOCK_OWNERSHIP_CHANGED', lockFile);
    }
  }
  const retained = records.filter((record) => record.descriptor.kind === 'retained');
  if (expectedEvidenceKind !== undefined
      && !/^(?:import|restore)$/u.test(expectedEvidenceKind || '')) {
    throw new Error('Database operation lock expected evidence kind must be import or restore');
  }
  if (expectedEvidenceKind && retained.some((record) => (
    record.descriptor.evidence.kind !== expectedEvidenceKind
  ))) {
    throw new Error('Database operation lock retained evidence kind does not match recovery');
  }
  return tokens.size === 1 ? [...tokens][0] : null;
}

async function scanDatabaseOperationLockProtocol({
  expectedEvidenceKind,
  fileSystem,
  lockFile,
  processLivenessProbe,
}) {
  const directory = path.dirname(lockFile);
  const baseName = path.basename(lockFile);
  const names = protocolEntries(await fileSystem.readdir(directory), baseName);
  const records = [];
  for (const name of names) {
    const role = recoveryRoleForEntry(name, baseName);
    if (!role) throw markerError('DATABASE_OPERATION_LOCK_RECOVERY_AMBIGUOUS', lockFile);
    const recoveryFile = path.join(directory, name);
    const snapshot = await readOptionalOpaquePathSnapshot(fileSystem, recoveryFile);
    if (!snapshot) throw markerError('DATABASE_OPERATION_LOCK_OWNERSHIP_CHANGED', recoveryFile);
    records.push({
      descriptor: describeRecoveryMarker(snapshot.bytes),
      file: recoveryFile,
      role,
      snapshot,
    });
  }
  const authorityToken = validateRecoveryRecords(records, lockFile, expectedEvidenceKind);
  return {
    authorityToken,
    expectedEvidenceKind,
    fileSystem,
    lockFile,
    phase: inferRecoveryPhase(records, lockFile),
    processLivenessProbe,
    records,
  };
}

function stableOwnerPid(scan) {
  if (scan.phase !== 'active' && scan.phase !== 'absence' && scan.phase !== 'local-child') {
    return null;
  }
  if (scan.records.length < 1 || scan.records.some((record) => (
    !new Set([
      'canonical-marker',
      'canonical-authority',
      'local-child-claim',
      'local-child-hold',
      'local-child-temp',
    ])
      .has(record.role.name)
      || (scan.phase === 'local-child'
        ? !new Set(['active', 'local-child-hold']).has(record.descriptor.kind)
        : record.descriptor.kind !== scan.phase)
  ))) return null;
  const ownerPids = new Set(scan.records.map((record) => record.descriptor.ownerPid));
  if (ownerPids.size !== 1) {
    throw markerError('DATABASE_OPERATION_LOCK_OWNERSHIP_CHANGED', scan.lockFile);
  }
  return [...ownerPids][0];
}

async function proveOwnerTerminated(scan, ownerPid) {
  let active;
  try {
    active = await scan.processLivenessProbe(ownerPid);
  } catch (cause) {
    const error = markerError('DATABASE_OPERATION_LOCK_OWNER_LIVENESS_UNPROVEN', scan.lockFile);
    error.cause = cause;
    error.ownerPid = ownerPid;
    throw error;
  }
  if (active === false) return;
  const code = active === true
    ? 'DATABASE_OPERATION_LOCK_OWNER_STILL_ACTIVE'
    : 'DATABASE_OPERATION_LOCK_OWNER_LIVENESS_UNPROVEN';
  const error = markerError(code, scan.lockFile);
  error.ownerPid = ownerPid;
  throw error;
}

async function proveStableOwnerTerminated(scan) {
  const ownerPid = stableOwnerPid(scan);
  if (ownerPid === null) return;
  await proveOwnerTerminated(scan, ownerPid);
}

function retentionOwnerPid(scan) {
  if (scan.phase !== 'retention') return null;
  const authority = recordNamed(scan, 'canonical-authority');
  if (!authority || authority.descriptor.kind !== 'active') {
    throw markerError('DATABASE_OPERATION_LOCK_RECOVERY_AMBIGUOUS', scan.lockFile);
  }
  const allowedRoles = new Set([
    'canonical-authority',
    'canonical-marker',
    'retain-active',
  ]);
  const activeRecords = scan.records.filter((record) => record.descriptor.kind === 'active');
  if (activeRecords.length < 1 || activeRecords.some((record) => (
    !allowedRoles.has(record.role.name)
      || !sameFileIdentity(record.snapshot.stat, authority.snapshot.stat)
  ))) {
    throw markerError('DATABASE_OPERATION_LOCK_OWNERSHIP_CHANGED', scan.lockFile);
  }
  const ownerPids = new Set(activeRecords.map((record) => record.descriptor.ownerPid));
  if (ownerPids.size !== 1) {
    throw markerError('DATABASE_OPERATION_LOCK_OWNERSHIP_CHANGED', scan.lockFile);
  }
  return [...ownerPids][0];
}

async function proveRetentionOwnerTerminated(scan) {
  await proveOwnerTerminated(scan, retentionOwnerPid(scan));
}

function cleanupClaimLabel(phase, side) {
  if (phase === 'completion') return `complete-${side}`;
  if (phase === 'release') return `release-${side}`;
  if (phase === 'absence') return `absence-release-${side}`;
  return `acquire-cleanup-${side}`;
}

async function settleProtocolDeletion(scan) {
  const claimedCanonical = [];
  const sidecars = [];
  for (const record of scan.records) {
    if (record.role.name === 'canonical-marker'
        || record.role.name === 'canonical-authority') {
      claimedCanonical.push(await claimExactPath(
        scan.fileSystem,
        record.file,
        record.snapshot,
        cleanupClaimLabel(scan.phase, record.role.side),
      ));
    } else {
      sidecars.push({
        claimedFile: record.file,
        lockFile: scan.lockFile,
        snapshot: record.snapshot,
      });
    }
  }
  for (const claim of [...claimedCanonical, ...sidecars]) {
    await discardExactClaim(scan.fileSystem, claim);
  }
  await syncParentDirectory(scan.fileSystem, scan.lockFile);
  await assertProtocolNamespace(scan.fileSystem, scan.lockFile);
  return Object.freeze({ state: 'absent' });
}

function recordNamed(scan, name) {
  return scan.records.find((record) => record.role.name === name) || null;
}

async function linkRecoverySource(scan, source, destinationFile) {
  await scan.fileSystem.link(source.file, destinationFile);
  await syncParentDirectory(scan.fileSystem, destinationFile);
  const linked = await readPathSnapshot(scan.fileSystem, destinationFile);
  if (!sameFileIdentity(linked.stat, source.snapshot.stat)
      || !linked.bytes.equals(source.snapshot.bytes)) {
    const error = markerError('DATABASE_OPERATION_LOCK_RESTORATION_UNCERTAIN', destinationFile);
    error.recoveryAuthority = Object.freeze({
      claimedFile: source.file,
      originalFile: destinationFile,
    });
    throw error;
  }
  return linked;
}

async function settleRetentionRecovery(scan) {
  const retainedRecords = scan.records.filter((record) => (
    record.descriptor.kind === 'retained'
  ));
  const partialTemps = scan.records.filter((record) => (
    record.role.name === 'retained-temp' && record.descriptor.kind === 'invalid'
  ));
  const canonical = recordNamed(scan, 'canonical-marker');
  const authority = recordNamed(scan, 'canonical-authority');
  const activeClaim = recordNamed(scan, 'retain-active');
  if (!authority || authority.descriptor.kind !== 'active') {
    throw markerError('DATABASE_OPERATION_LOCK_RECOVERY_AMBIGUOUS', scan.lockFile);
  }
  if (retainedRecords.length > 0) {
    const retainedSources = retainedRecords.filter((record) => (
      record.role.name === 'retained-temp'
    ));
    let retainedCanonical = canonical?.descriptor.kind === 'retained' ? canonical : null;
    let exactActiveClaim = activeClaim;
    if (canonical?.descriptor.kind === 'active') {
      exactActiveClaim = await claimExactPath(
        scan.fileSystem,
        scan.lockFile,
        canonical.snapshot,
        'retain-active',
      );
      retainedCanonical = null;
    } else if (canonical && canonical.descriptor.kind !== 'retained') {
      throw markerError('DATABASE_OPERATION_LOCK_RECOVERY_AMBIGUOUS', scan.lockFile);
    }
    if (!retainedCanonical) {
      const source = retainedRecords.find((record) => record.role.name === 'retained-temp');
      if (!source) throw markerError('DATABASE_OPERATION_LOCK_RECOVERY_AMBIGUOUS', scan.lockFile);
      const snapshot = await linkRecoverySource(scan, source, scan.lockFile);
      retainedCanonical = { ...source, file: scan.lockFile, snapshot };
    }
    if (retainedSources.length === 0) {
      const retainedHoldFile = `${scan.lockFile}.retained-${process.pid}-${randomMarkerToken()}.tmp`;
      await scan.fileSystem.link(scan.lockFile, retainedHoldFile);
      await syncParentDirectory(scan.fileSystem, scan.lockFile);
      const retainedHold = await readPathSnapshot(scan.fileSystem, retainedHoldFile);
      if (!sameFileIdentity(retainedHold.stat, retainedCanonical.snapshot.stat)
          || !retainedHold.bytes.equals(retainedCanonical.snapshot.bytes)) {
        const error = markerError('DATABASE_OPERATION_LOCK_OWNERSHIP_CHANGED', scan.lockFile);
        error.recoveryAuthority = Object.freeze({ retainedTemporaryFile: retainedHoldFile });
        throw error;
      }
      retainedSources.push({
        descriptor: retainedCanonical.descriptor,
        file: retainedHoldFile,
        role: { name: 'retained-temp', phase: 'retention', side: 'temporary' },
        snapshot: retainedHold,
      });
    }
    if (exactActiveClaim) {
      await discardExactClaim(scan.fileSystem, exactActiveClaim.claimedFile
        ? exactActiveClaim
        : {
          claimedFile: exactActiveClaim.file,
          lockFile: scan.lockFile,
          snapshot: exactActiveClaim.snapshot,
        });
    }
    for (const record of retainedSources) {
      await discardExactClaimAfterCanonicalCheck(
        scan.fileSystem,
        { claimedFile: record.file, lockFile: scan.lockFile, snapshot: record.snapshot },
        scan.lockFile,
        retainedCanonical.snapshot,
      );
    }
    await syncParentDirectory(scan.fileSystem, scan.lockFile);
    const baseName = path.basename(scan.lockFile);
    await assertProtocolNamespace(scan.fileSystem, scan.lockFile, [
      baseName,
      `${baseName}.authority`,
    ]);
    const retained = await openRetainedDatabaseOperationLock({
      expectedEvidenceKind: scan.expectedEvidenceKind
        || retainedCanonical.descriptor.evidence.kind,
      fileSystem: scan.fileSystem,
      lockFile: scan.lockFile,
    });
    return Object.freeze({ retained, state: 'retained' });
  }
  const activeSource = canonical?.descriptor.kind === 'active' ? canonical : activeClaim;
  if (!activeSource || activeSource.descriptor.kind !== 'active') {
    throw markerError('DATABASE_OPERATION_LOCK_RECOVERY_AMBIGUOUS', scan.lockFile);
  }
  if (!canonical) await linkRecoverySource(scan, activeSource, scan.lockFile);
  if (activeClaim) {
    await discardExactClaim(scan.fileSystem, {
      claimedFile: activeClaim.file,
      lockFile: scan.lockFile,
      snapshot: activeClaim.snapshot,
    });
  }
  for (const record of partialTemps) {
    await discardExactClaim(scan.fileSystem, {
      claimedFile: record.file,
      lockFile: scan.lockFile,
      snapshot: record.snapshot,
    });
  }
  await syncParentDirectory(scan.fileSystem, scan.lockFile);
  const baseName = path.basename(scan.lockFile);
  await assertProtocolNamespace(scan.fileSystem, scan.lockFile, [
    baseName,
    `${baseName}.authority`,
  ]);
  return Object.freeze({ state: 'active' });
}

function sameRecoveryEvidence(left, right) {
  try {
    return JSON.stringify(formatRecoveryEvidence(left))
      === JSON.stringify(formatRecoveryEvidence(right));
  } catch {
    return false;
  }
}

function validateLocalChildTransitionRecord(record, expectedRecovery, reason, evidence) {
  if (!record || record.descriptor.kind !== 'retained'
      || record.descriptor.authorityToken !== expectedRecovery.hold.authorityToken
      || record.descriptor.reason !== reason
      || !sameRecoveryEvidence(record.descriptor.evidence, evidence)
      || JSON.stringify(record.descriptor.evidence.localChildRecovery)
        !== JSON.stringify(expectedRecovery)) {
    throw markerError('DATABASE_OPERATION_LOCK_LOCAL_CHILD_AUTHORITY_MISMATCH', record?.file);
  }
  return record;
}

async function validateLocalChildTransitionScan(scan, expectedRecovery, reason, evidence) {
  if (scan.phase !== 'local-child'
      || scan.authorityToken !== expectedRecovery.hold.authorityToken) {
    throw markerError('DATABASE_OPERATION_LOCK_LOCAL_CHILD_AUTHORITY_MISMATCH', scan.lockFile);
  }
  const authority = recordNamed(scan, 'canonical-authority');
  if (!authority || authority.descriptor.kind !== 'active'
      || authority.descriptor.authorityToken !== expectedRecovery.hold.authorityToken) {
    throw markerError('DATABASE_OPERATION_LOCK_LOCAL_CHILD_AUTHORITY_MISMATCH', scan.lockFile);
  }
  const holdRecords = scan.records.filter((record) => (
    record.descriptor.kind === 'local-child-hold'
  ));
  const retainedRecords = scan.records.filter((record) => (
    record.descriptor.kind === 'retained'
  ));
  if (holdRecords.length === 0 && retainedRecords.length === 0) {
    throw markerError('DATABASE_OPERATION_LOCK_LOCAL_CHILD_AUTHORITY_MISMATCH', scan.lockFile);
  }
  if (holdRecords.some((record) => (
    record.descriptor.authorityToken !== expectedRecovery.hold.authorityToken
      || record.descriptor.commandSha256 !== expectedRecovery.hold.commandSha256
      || record.descriptor.holdToken !== expectedRecovery.hold.holdToken
      || record.descriptor.ownerPid !== authority.descriptor.ownerPid
  ))) {
    throw markerError('DATABASE_OPERATION_LOCK_LOCAL_CHILD_AUTHORITY_MISMATCH', scan.lockFile);
  }
  for (const record of retainedRecords) {
    validateLocalChildTransitionRecord(record, expectedRecovery, reason, evidence);
  }
  const activeRecords = scan.records.filter((record) => record.descriptor.kind === 'active');
  if (activeRecords.some((record) => (
    record.descriptor.ownerPid !== authority.descriptor.ownerPid
      || record.descriptor.authorityToken !== authority.descriptor.authorityToken
  ))) {
    throw markerError('DATABASE_OPERATION_LOCK_LOCAL_CHILD_AUTHORITY_MISMATCH', scan.lockFile);
  }
  await proveOwnerTerminated(scan, authority.descriptor.ownerPid);
  return { holdRecords, retainedRecords };
}

async function discardLocalChildHoldRecords(scan, records) {
  for (const record of records) {
    const claim = record.role.name === 'local-child-hold'
      ? await claimExactPath(scan.fileSystem, record.file, record.snapshot, 'child')
      : {
        claimedFile: record.file,
        lockFile: scan.lockFile,
        snapshot: record.snapshot,
      };
    await discardExactClaim(scan.fileSystem, claim);
  }
}

export async function retainDatabaseOperationLocalChildRecovery({
  expectedLocalChildRecovery,
  fileSystem = fsp,
  lockFile = DEFAULT_DATABASE_OPERATION_LOCK_FILE,
  processLivenessProbe = defaultProcessLivenessProbe,
  reason,
  recoveryEvidence,
} = {}) {
  const expectedRecovery = normalizeProductionImportLocalChildRecovery(
    expectedLocalChildRecovery,
  );
  if (reason !== PRODUCTION_IMPORT_LOCAL_CHILD_RETENTION_REASON) {
    throw new Error('Database local-child recovery retention reason is invalid');
  }
  const formattedEvidence = formatRecoveryEvidence(recoveryEvidence);
  if (formattedEvidence.evidenceKind !== 'import'
      || JSON.stringify(formattedEvidence.localChildRecovery)
        !== JSON.stringify(expectedRecovery)) {
    throw new Error('Database local-child recovery evidence is not exact');
  }
  if (typeof processLivenessProbe !== 'function') {
    throw new Error('Database operation lock process liveness probe must be a function');
  }

  let scan = await scanDatabaseOperationLockProtocol({
    expectedEvidenceKind: 'import',
    fileSystem,
    lockFile,
    processLivenessProbe,
  });
  if (scan.phase === 'retained') {
    const retainedRecord = validateLocalChildTransitionRecord(
      recordNamed(scan, 'canonical-marker'),
      expectedRecovery,
      reason,
      recoveryEvidence,
    );
    const retained = await openRetainedDatabaseOperationLock({
      expectedEvidenceKind: 'import',
      fileSystem,
      lockFile,
    });
    return Object.freeze({ retained, state: retainedRecord.descriptor.kind });
  }

  let transition = await validateLocalChildTransitionScan(
    scan,
    expectedRecovery,
    reason,
    recoveryEvidence,
  );
  const invalidRetainedTemps = scan.records.filter((record) => (
    record.role.name === 'local-child-retained' && record.descriptor.kind === 'invalid'
  ));
  if (invalidRetainedTemps.length) {
    for (const record of invalidRetainedTemps) {
      await discardExactClaim(fileSystem, {
        claimedFile: record.file,
        lockFile,
        snapshot: record.snapshot,
      });
    }
    await syncParentDirectory(fileSystem, lockFile);
    scan = await scanDatabaseOperationLockProtocol({
      expectedEvidenceKind: 'import',
      fileSystem,
      lockFile,
      processLivenessProbe,
    });
    transition = await validateLocalChildTransitionScan(
      scan,
      expectedRecovery,
      reason,
      recoveryEvidence,
    );
  }

  let retainedSources = transition.retainedRecords.filter((record) => (
    record.role.name === 'local-child-retained'
  ));
  let retainedCanonical = recordNamed(scan, 'canonical-marker');
  if (retainedCanonical?.descriptor.kind === 'active') retainedCanonical = null;
  if (retainedCanonical) {
    validateLocalChildTransitionRecord(
      retainedCanonical,
      expectedRecovery,
      reason,
      recoveryEvidence,
    );
  }
  if (retainedSources.length === 0 && !retainedCanonical) {
    const temporary = await writeDurableTemporaryMarker({
      bytes: buildRetainedMarker(
        expectedRecovery.hold.authorityToken,
        reason,
        formattedEvidence,
      ),
      fileSystem,
      label: 'local-child-retained',
      lockFile,
    });
    retainedSources = [{
      descriptor: describeRecoveryMarker(temporary.bytes),
      file: temporary.temporaryFile,
      role: { name: 'local-child-retained', phase: 'local-child', side: 'temporary' },
      snapshot: { bytes: temporary.bytes, stat: temporary.stat },
    }];
  }

  let activeClaim = recordNamed(scan, 'local-child-active');
  const canonical = recordNamed(scan, 'canonical-marker');
  if (canonical?.descriptor.kind === 'active') {
    if (activeClaim) {
      throw markerError('DATABASE_OPERATION_LOCK_RECOVERY_AMBIGUOUS', lockFile);
    }
    const claim = await claimExactPath(
      fileSystem,
      lockFile,
      canonical.snapshot,
      'local-child-active',
    );
    activeClaim = {
      descriptor: canonical.descriptor,
      file: claim.claimedFile,
      role: { name: 'local-child-active', phase: 'local-child', side: 'marker' },
      snapshot: claim.snapshot,
    };
  } else if (!retainedCanonical && !activeClaim) {
    throw markerError('DATABASE_OPERATION_LOCK_RECOVERY_AMBIGUOUS', lockFile);
  }

  if (!retainedCanonical) {
    const [source] = retainedSources;
    const snapshot = await linkRecoverySource(scan, source, lockFile);
    retainedCanonical = { ...source, file: lockFile, snapshot };
  }
  validateLocalChildTransitionRecord(
    retainedCanonical,
    expectedRecovery,
    reason,
    recoveryEvidence,
  );
  if (activeClaim) {
    await discardExactClaim(fileSystem, {
      claimedFile: activeClaim.file,
      lockFile,
      snapshot: activeClaim.snapshot,
    });
  }
  await discardLocalChildHoldRecords(scan, transition.holdRecords);
  for (const record of retainedSources) {
    await discardExactClaimAfterCanonicalCheck(
      fileSystem,
      { claimedFile: record.file, lockFile, snapshot: record.snapshot },
      lockFile,
      retainedCanonical.snapshot,
    );
  }
  await syncParentDirectory(fileSystem, lockFile);
  const baseName = path.basename(lockFile);
  await assertProtocolNamespace(fileSystem, lockFile, [
    baseName,
    `${baseName}.authority`,
  ]);
  const retained = await openRetainedDatabaseOperationLock({
    expectedEvidenceKind: 'import',
    fileSystem,
    lockFile,
  });
  return Object.freeze({ retained, state: 'retained' });
}

async function settleProtocolRecovery(scan) {
  if (scan.phase === 'local-child') {
    await proveStableOwnerTerminated(scan);
    const holds = scan.records.filter((record) => record.role.phase === 'local-child');
    const hold = recordNamed(scan, 'local-child-hold')
      || recordNamed(scan, 'local-child-claim')
      || recordNamed(scan, 'local-child-temp');
    if (!hold || holds.some((record) => (
      record.descriptor.kind !== 'local-child-hold'
        || record.descriptor.holdToken !== hold.descriptor.holdToken
        || !sameFileIdentity(record.snapshot.stat, hold.snapshot.stat)
    ))) {
      throw markerError('DATABASE_OPERATION_LOCK_RECOVERY_AMBIGUOUS', scan.lockFile);
    }
    const error = markerError(
      'DATABASE_OPERATION_LOCK_LOCAL_CHILD_HOLD_REQUIRES_MANUAL_RECOVERY',
      scan.lockFile,
    );
    error.recoveryAuthority = Object.freeze({
      holdFile: hold.file,
      holdFiles: Object.freeze(holds.map((record) => record.file).sort()),
      holdToken: hold.descriptor.holdToken,
      lockFile: scan.lockFile,
    });
    throw error;
  }
  if (scan.phase === 'retention') {
    await proveRetentionOwnerTerminated(scan);
    return settleRetentionRecovery(scan);
  }
  if (scan.phase === 'legacy-retained') {
    throw new Error(`DATABASE_OPERATION_LOCK_LEGACY_READ_ONLY: ${scan.lockFile}`);
  }
  if (scan.phase === 'retained') {
    const retainedRecord = recordNamed(scan, 'canonical-marker');
    const retained = await openRetainedDatabaseOperationLock({
      expectedEvidenceKind: scan.expectedEvidenceKind || retainedRecord.descriptor.evidence.kind,
      fileSystem: scan.fileSystem,
      lockFile: scan.lockFile,
    });
    return Object.freeze({ retained, state: 'retained' });
  }
  await proveStableOwnerTerminated(scan);
  return settleProtocolDeletion(scan);
}

export async function openDatabaseOperationLockProtocolRecovery({
  expectedEvidenceKind,
  fileSystem = fsp,
  lockFile = DEFAULT_DATABASE_OPERATION_LOCK_FILE,
  processLivenessProbe = defaultProcessLivenessProbe,
} = {}) {
  if (typeof processLivenessProbe !== 'function') {
    throw new Error('Database operation lock process liveness probe must be a function');
  }
  const initial = await scanDatabaseOperationLockProtocol({
    expectedEvidenceKind,
    fileSystem,
    lockFile,
    processLivenessProbe,
  });
  let state = 'open';
  return Object.freeze({
    authorityToken: initial.authorityToken,
    lockFile,
    phase: initial.phase,
    async recover() {
      if (state !== 'open') {
        throw new Error(`DATABASE_OPERATION_LOCK_RECOVERY_NOT_OWNED: ${lockFile}`);
      }
      state = 'recovering';
      try {
        const result = await settleProtocolRecovery(initial);
        state = 'recovered';
        return result;
      } catch (error) {
        state = 'reopen-required';
        throw error;
      }
    },
  });
}

export async function openDatabaseOperationLockAbsenceProof({
  lockFile = DEFAULT_DATABASE_OPERATION_LOCK_FILE,
  fileSystem = fsp,
  processLivenessProbe = defaultProcessLivenessProbe,
} = {}) {
  if (typeof processLivenessProbe !== 'function') {
    throw new Error('Database operation lock process liveness probe must be a function');
  }
  let scan = await scanDatabaseOperationLockProtocol({
    fileSystem,
    lockFile,
    processLivenessProbe,
  });
  if (scan.phase !== 'absence'
      || scan.records.some((record) => record.descriptor.kind !== 'absence')) {
    throw markerError('DATABASE_OPERATION_LOCK_ABSENCE_LEASE_AMBIGUOUS', lockFile);
  }
  await proveStableOwnerTerminated(scan);
  let released = false;
  return Object.freeze({
    absent: true,
    lockFile,
    protocol: ABSENCE_LEASE_PROTOCOL,
    async release() {
      if (released) {
        throw new Error(`DATABASE_OPERATION_LOCK_ABSENCE_LEASE_NOT_OWNED: ${lockFile}`);
      }
      try {
        await settleProtocolDeletion(scan);
        released = true;
      } catch (error) {
        try {
          scan = await scanDatabaseOperationLockProtocol({
            fileSystem,
            lockFile,
            processLivenessProbe,
          });
        } catch {}
        throw error;
      }
    },
  });
}

export async function proveDatabaseOperationLockAbsent({
  lockFile = DEFAULT_DATABASE_OPERATION_LOCK_FILE,
  fileSystem = fsp,
} = {}) {
  const authorityToken = randomMarkerToken();
  const markerBytes = buildAbsenceLeaseMarker(authorityToken);
  let authority;
  try {
    authority = await createDatabaseOperationAuthority({
      authorityToken,
      fileSystem,
      label: 'absence',
      lockFile,
      markerBytes,
      parseMarker: parseAbsenceLeaseMarker,
    });
  } catch (error) {
    if (error.code !== 'DATABASE_OPERATION_LOCKED') throw error;
    const failure = markerError('DATABASE_OPERATION_LOCK_NOT_ABSENT', lockFile);
    failure.cause = error;
    throw failure;
  }
  const lease = createAbsenceLeaseHandle({
    ...authority,
    fileSystem,
    lockFile,
  });
  const baseName = path.basename(lockFile);
  const entries = protocolEntries(await fileSystem.readdir(path.dirname(lockFile)), baseName);
  if (entries.some((entry) => entry !== baseName && entry !== `${baseName}.authority`)) {
    let cleanupError;
    try {
      await lease.release();
    } catch (error) {
      cleanupError = error;
    }
    throw combineOperationErrors(
      markerError('DATABASE_OPERATION_LOCK_NOT_ABSENT', lockFile),
      cleanupError,
      `Database operation lock absence lease cleanup failed: ${lockFile}`,
    );
  }
  return lease;
}

export async function releaseDatabaseOperationLock(release, _timeoutMs) {
  await Promise.resolve().then(release);
}

export async function beginDatabaseOperationLocalChildHold(release, options) {
  if (typeof release?.beginLocalChildHold !== 'function') {
    throw new Error('Database operation lock adapter does not support local-child holds');
  }
  return release.beginLocalChildHold(options);
}

export function describeDatabaseOperationLocalChildHold(release) {
  if (typeof release?.describeLocalChildHold !== 'function') {
    throw new Error('Database operation lock adapter cannot describe its local-child hold');
  }
  const authority = release.describeLocalChildHold();
  if (!authority
      || !CANONICAL_MARKER_TOKEN.test(authority.authorityToken || '')
      || !CANONICAL_MARKER_TOKEN.test(authority.commandSha256 || '')
      || !CANONICAL_MARKER_TOKEN.test(authority.holdToken || '')) {
    throw new Error('Database operation lock has no exact local-child hold authority');
  }
  return Object.freeze({
    authorityToken: authority.authorityToken,
    commandSha256: authority.commandSha256,
    holdToken: authority.holdToken,
  });
}

export async function retainDatabaseOperationLock(
  release,
  _timeoutMs,
  reason,
  recoveryEvidence,
) {
  if (typeof release?.retain !== 'function') {
    throw new Error('Database operation lock adapter does not support retention');
  }
  await Promise.resolve().then(() => release.retain(reason, recoveryEvidence));
}
