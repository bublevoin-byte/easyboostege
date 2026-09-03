import { randomUUID } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  PRODUCTION_IMPORT_LOCAL_CHILD_RETENTION_REASON,
  decodeProductionImportLocalChildRecovery,
  encodeProductionImportLocalChildRecovery,
  normalizeProductionImportLocalChildRecovery,
} from './production-import-local-child-authority.js';

export const DEFAULT_HOST_OPERATION_LOCK_DIRECTORY =
  '/var/lib/easyboost/locks/host-operation.lock';

const OWNER_FILE = 'owner';
const RETAINED_AUTHORITY_FILE = 'retained-authority';
const RETAINED_FILE = 'retained';
const SAFE_OPERATION = /^[a-z][a-z0-9-]{0,63}$/u;
const CANONICAL_IMAGE_ID = /^sha256:[0-9a-f]{64}$/u;
const CANONICAL_CONTAINER_ID = /^[0-9a-f]{64}$/u;
const CANONICAL_OPERATION_TOKEN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CANONICAL_OWNERSHIP_TOKEN = /^[0-9a-f]{64}$/u;
const SAFE_EVIDENCE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const SAFE_IMPORT_PROBE_STATUS = /^[A-Z][A-Z0-9_:-]{0,63}$/u;
const SAFE_RESTORE_PROBE_STATUS = /^(?:PENDING|STAGING|STAGED|RUNNING|EXIT:(?:0|[1-9]\d*)|UNKNOWN)$/u;
const LIFECYCLE_ACTIONS = new Set(['replace', 'restart', 'start', 'stop']);
const IMPORT_RETENTION_REASONS = new Set([
  'IMPORT_CONTAINER_SETTLEMENT_UNPROVEN',
  PRODUCTION_IMPORT_LOCAL_CHILD_RETENTION_REASON,
  'IMPORT_REMOTE_SETTLEMENT_UNPROVEN',
]);
const RESTORE_RETENTION_REASONS = new Set([
  'APPLICATION_ISOLATION_UNPROVEN_AFTER_DATABASE_RESTORE',
  'REMOTE_RESTORE_SETTLEMENT_UNPROVEN',
]);
const MAX_MARKER_BYTES = 16 * 1024;
const MAX_HOST_OPERATION_TOMBSTONES = 32;

function combineErrors(primaryError, cleanupError, message) {
  if (!primaryError) return cleanupError;
  if (!cleanupError) return primaryError;
  return new AggregateError([primaryError, cleanupError], message, { cause: primaryError });
}

function isAbsoluteHostPath(value) {
  return path.isAbsolute(value) || path.posix.isAbsolute(value);
}

function sameDirectoryIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && right.isDirectory();
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && right.isFile();
}

function activeMarker(operation, ownerPid) {
  return [
    'protocol=easyboost-host-operation-v1',
    `operation=${operation}`,
    `ownerPid=${ownerPid}`,
    '',
  ].join('\n');
}

function lifecycleEvidenceMarker(operation, ownerPid, evidence) {
  if (!evidence || !LIFECYCLE_ACTIONS.has(evidence.lifecycleAction)) {
    throw new Error('Production lifecycle host guard retention requires one lifecycle action');
  }
  if (!SAFE_EVIDENCE_TOKEN.test(evidence.reason || '')) {
    throw new Error('Production lifecycle host guard retention requires one typed reason');
  }
  if (!CANONICAL_IMAGE_ID.test(evidence.previousImageId || '')
      || !CANONICAL_IMAGE_ID.test(evidence.newImageId || '')) {
    throw new Error('Production lifecycle host guard retention requires exact image authorities');
  }
  for (const field of ['currentContainerId', 'previousContainerId']) {
    if (evidence[field] !== null && evidence[field] !== undefined
        && !CANONICAL_CONTAINER_ID.test(evidence[field])) {
      throw new Error(`Production lifecycle host guard retention has invalid ${field}`);
    }
  }
  for (const field of ['lastProof', 'lastState']) {
    if (!SAFE_EVIDENCE_TOKEN.test(evidence[field] || '')) {
      throw new Error(`Production lifecycle host guard retention requires one typed ${field}`);
    }
  }
  return [
    'RETAINED',
    'protocol=easyboost-host-operation-v2',
    `operation=${operation}`,
    `ownerPid=${ownerPid}`,
    'evidenceKind=production-app-lifecycle',
    `lifecycleAction=${evidence.lifecycleAction}`,
    `reason=${evidence.reason}`,
    `previousImageId=${evidence.previousImageId}`,
    `newImageId=${evidence.newImageId}`,
    `currentContainerId=${evidence.currentContainerId || 'unknown'}`,
    `previousContainerId=${evidence.previousContainerId || 'unknown'}`,
    `lastProof=${evidence.lastProof}`,
    `lastState=${evidence.lastState}`,
    '',
  ].join('\n');
}

function normalizeImportEvidence(evidence) {
  const importContainerId = evidence?.importContainerId ?? 'unknown';
  const postgresContainerId = evidence?.postgresContainerId ?? 'unknown';
  const status = evidence?.lastProbe?.status ?? 'UNKNOWN';
  const processState = evidence?.lastProbe?.process ?? 'UNKNOWN';
  const activityCount = evidence?.lastProbe?.activityCount ?? 'unknown';
  if (evidence?.kind !== 'import'
      || !CANONICAL_OPERATION_TOKEN.test(evidence.operationToken || '')
      || evidence.applicationName !== `easyboost_import_${evidence.operationToken}`
      || !CANONICAL_OWNERSHIP_TOKEN.test(evidence.ownershipToken || '')
      || !(importContainerId === 'unknown' || CANONICAL_CONTAINER_ID.test(importContainerId))
      || !(postgresContainerId === 'unknown' || CANONICAL_CONTAINER_ID.test(postgresContainerId))
      || !SAFE_IMPORT_PROBE_STATUS.test(status)
      || !/^(?:ACTIVE|NONE|UNKNOWN)$/u.test(processState)
      || !(activityCount === 'unknown'
        || (Number.isSafeInteger(activityCount) && activityCount >= 0))) {
    throw new Error('Database import host guard recovery evidence is invalid');
  }
  const localChildRecovery = evidence.localChildRecovery === undefined
    ? undefined
    : normalizeProductionImportLocalChildRecovery(evidence.localChildRecovery);
  return {
    applicationName: evidence.applicationName,
    importContainerId,
    kind: 'import',
    lastProbe: {
      activityCount,
      process: processState,
      status,
    },
    operationToken: evidence.operationToken,
    ownershipToken: evidence.ownershipToken,
    postgresContainerId,
    ...(localChildRecovery === undefined ? {} : { localChildRecovery }),
  };
}

function importEvidenceMarker(operation, ownerPid, evidence) {
  if (!IMPORT_RETENTION_REASONS.has(evidence?.retentionReason)) {
    throw new Error('Database import host guard retention reason is invalid');
  }
  const normalized = normalizeImportEvidence(evidence);
  const requiresLocalChildRecovery = evidence.retentionReason
    === PRODUCTION_IMPORT_LOCAL_CHILD_RETENTION_REASON;
  if (requiresLocalChildRecovery !== Boolean(normalized.localChildRecovery)) {
    throw new Error('Database import local-child host guard authority is invalid');
  }
  return [
    'RETAINED',
    'protocol=easyboost-host-operation-v2',
    `operation=${operation}`,
    `ownerPid=${ownerPid}`,
    'evidenceKind=database-import',
    `reason=${evidence.retentionReason}`,
    `operationToken=${normalized.operationToken}`,
    `applicationName=${normalized.applicationName}`,
    `ownershipToken=${normalized.ownershipToken}`,
    `importContainerId=${normalized.importContainerId}`,
    `postgresContainerId=${normalized.postgresContainerId}`,
    `lastProbeStatus=${normalized.lastProbe.status}`,
    `lastProbeProcess=${normalized.lastProbe.process}`,
    `lastProbeActivityCount=${normalized.lastProbe.activityCount}`,
    ...(normalized.localChildRecovery
      ? [`localChildRecovery=${encodeProductionImportLocalChildRecovery(
        normalized.localChildRecovery,
      )}`]
      : []),
    '',
  ].join('\n');
}

function normalizeRestoreEvidence(evidence) {
  const status = evidence?.lastProbe?.status ?? 'UNKNOWN';
  const processState = evidence?.lastProbe?.process ?? 'UNKNOWN';
  const activityCount = evidence?.lastProbe?.activityCount ?? 'unknown';
  if (evidence?.kind !== 'restore'
      || !CANONICAL_OPERATION_TOKEN.test(evidence.operationToken || '')
      || evidence.applicationName !== `easyboost_restore_${evidence.operationToken}`
      || !CANONICAL_CONTAINER_ID.test(evidence.postgresContainerId || '')
      || !SAFE_RESTORE_PROBE_STATUS.test(status)
      || !/^(?:ACTIVE|NONE|UNKNOWN)$/u.test(processState)
      || !(activityCount === 'unknown'
        || (Number.isSafeInteger(activityCount) && activityCount >= 0))) {
    throw new Error('Database restore host guard recovery evidence is invalid');
  }
  return {
    applicationName: evidence.applicationName,
    kind: 'restore',
    lastProbe: {
      activityCount,
      process: processState,
      status,
    },
    operationToken: evidence.operationToken,
    postgresContainerId: evidence.postgresContainerId,
  };
}

function restoreEvidenceMarker(operation, ownerPid, evidence) {
  if (!RESTORE_RETENTION_REASONS.has(evidence?.retentionReason)) {
    throw new Error('Database restore host guard retention reason is invalid');
  }
  const normalized = normalizeRestoreEvidence(evidence);
  return [
    'RETAINED',
    'protocol=easyboost-host-operation-v2',
    `operation=${operation}`,
    `ownerPid=${ownerPid}`,
    'evidenceKind=database-restore',
    `reason=${evidence.retentionReason}`,
    `operationToken=${normalized.operationToken}`,
    `applicationName=${normalized.applicationName}`,
    `postgresContainerId=${normalized.postgresContainerId}`,
    `lastProbeStatus=${normalized.lastProbe.status}`,
    `lastProbeProcess=${normalized.lastProbe.process}`,
    `lastProbeActivityCount=${normalized.lastProbe.activityCount}`,
    '',
  ].join('\n');
}

function retainedMarker(operation, ownerPid, evidence) {
  if (operation === 'production-app-lifecycle') {
    return lifecycleEvidenceMarker(operation, ownerPid, evidence);
  }
  if (operation === 'database-import') {
    return importEvidenceMarker(operation, ownerPid, evidence);
  }
  if (operation === 'database-restore') {
    return restoreEvidenceMarker(operation, ownerPid, evidence);
  }
  return [
    'RETAINED',
    'protocol=easyboost-host-operation-v2',
    `operation=${operation}`,
    `ownerPid=${ownerPid}`,
    'evidenceKind=generic-operation',
    'reason=OPERATION_SETTLEMENT_UNPROVEN',
    '',
  ].join('\n');
}

function retainedLifecycleRecord(marker, expectedOperation) {
  const lines = marker.split('\n');
  if (lines.length !== 14 || lines.at(-1) !== ''
      || lines[0] !== 'RETAINED'
      || lines[1] !== 'protocol=easyboost-host-operation-v2'
      || lines[2] !== `operation=${expectedOperation}`
      || !/^ownerPid=[1-9][0-9]*$/u.test(lines[3])
      || lines[4] !== 'evidenceKind=production-app-lifecycle') {
    throw new Error('HOST_OPERATION_LOCK_RETAINED_EVIDENCE_INVALID');
  }
  const read = (index, key) => {
    const prefix = `${key}=`;
    if (!lines[index].startsWith(prefix)) {
      throw new Error('HOST_OPERATION_LOCK_RETAINED_EVIDENCE_INVALID');
    }
    return lines[index].slice(prefix.length);
  };
  const evidence = {
    lifecycleAction: read(5, 'lifecycleAction'),
    reason: read(6, 'reason'),
    previousImageId: read(7, 'previousImageId'),
    newImageId: read(8, 'newImageId'),
    currentContainerId: read(9, 'currentContainerId'),
    previousContainerId: read(10, 'previousContainerId'),
    lastProof: read(11, 'lastProof'),
    lastState: read(12, 'lastState'),
  };
  for (const field of ['currentContainerId', 'previousContainerId']) {
    if (evidence[field] === 'unknown') evidence[field] = null;
  }
  const ownerPid = Number(lines[3].slice('ownerPid='.length));
  if (!Number.isSafeInteger(ownerPid)
      || lifecycleEvidenceMarker(expectedOperation, ownerPid, evidence) !== marker) {
    throw new Error('HOST_OPERATION_LOCK_RETAINED_EVIDENCE_INVALID');
  }
  return { evidence, operation: expectedOperation, ownerPid, reason: evidence.reason };
}

function retainedImportRecord(marker, expectedOperation) {
  const lines = marker.split('\n');
  if ((lines.length !== 15 && lines.length !== 16) || lines.at(-1) !== ''
      || lines[0] !== 'RETAINED'
      || lines[1] !== 'protocol=easyboost-host-operation-v2'
      || lines[2] !== `operation=${expectedOperation}`
      || !/^ownerPid=[1-9][0-9]*$/u.test(lines[3])
      || lines[4] !== 'evidenceKind=database-import') {
    throw new Error('HOST_OPERATION_LOCK_RETAINED_EVIDENCE_INVALID');
  }
  const read = (index, key) => {
    const prefix = `${key}=`;
    if (!lines[index].startsWith(prefix)) {
      throw new Error('HOST_OPERATION_LOCK_RETAINED_EVIDENCE_INVALID');
    }
    return lines[index].slice(prefix.length);
  };
  const reason = read(5, 'reason');
  const activityValue = read(13, 'lastProbeActivityCount');
  const evidence = {
    applicationName: read(7, 'applicationName'),
    importContainerId: read(9, 'importContainerId'),
    kind: 'import',
    lastProbe: {
      activityCount: activityValue === 'unknown' ? 'unknown' : Number(activityValue),
      process: read(12, 'lastProbeProcess'),
      status: read(11, 'lastProbeStatus'),
    },
    operationToken: read(6, 'operationToken'),
    ownershipToken: read(8, 'ownershipToken'),
    postgresContainerId: read(10, 'postgresContainerId'),
  };
  if (lines.length === 16) {
    evidence.localChildRecovery = decodeProductionImportLocalChildRecovery(
      read(14, 'localChildRecovery'),
    );
  }
  const ownerPid = Number(lines[3].slice('ownerPid='.length));
  if (!Number.isSafeInteger(ownerPid)
      || importEvidenceMarker(expectedOperation, ownerPid, {
        ...evidence,
        retentionReason: reason,
      }) !== marker) {
    throw new Error('HOST_OPERATION_LOCK_RETAINED_EVIDENCE_INVALID');
  }
  return { evidence, operation: expectedOperation, ownerPid, reason };
}

function retainedRestoreRecord(marker, expectedOperation) {
  const lines = marker.split('\n');
  if (lines.length !== 13 || lines.at(-1) !== ''
      || lines[0] !== 'RETAINED'
      || lines[1] !== 'protocol=easyboost-host-operation-v2'
      || lines[2] !== `operation=${expectedOperation}`
      || !/^ownerPid=[1-9][0-9]*$/u.test(lines[3])
      || lines[4] !== 'evidenceKind=database-restore') {
    throw new Error('HOST_OPERATION_LOCK_RETAINED_EVIDENCE_INVALID');
  }
  const read = (index, key) => {
    const prefix = `${key}=`;
    if (!lines[index].startsWith(prefix)) {
      throw new Error('HOST_OPERATION_LOCK_RETAINED_EVIDENCE_INVALID');
    }
    return lines[index].slice(prefix.length);
  };
  const reason = read(5, 'reason');
  const activityValue = read(11, 'lastProbeActivityCount');
  const evidence = {
    applicationName: read(7, 'applicationName'),
    kind: 'restore',
    lastProbe: {
      activityCount: activityValue === 'unknown' ? 'unknown' : Number(activityValue),
      process: read(10, 'lastProbeProcess'),
      status: read(9, 'lastProbeStatus'),
    },
    operationToken: read(6, 'operationToken'),
    postgresContainerId: read(8, 'postgresContainerId'),
  };
  const ownerPid = Number(lines[3].slice('ownerPid='.length));
  if (!Number.isSafeInteger(ownerPid)
      || restoreEvidenceMarker(expectedOperation, ownerPid, {
        ...evidence,
        retentionReason: reason,
      }) !== marker) {
    throw new Error('HOST_OPERATION_LOCK_RETAINED_EVIDENCE_INVALID');
  }
  return { evidence, operation: expectedOperation, ownerPid, reason };
}

function retainedRecord(marker, expectedOperation) {
  if (expectedOperation === 'production-app-lifecycle') {
    return retainedLifecycleRecord(marker, expectedOperation);
  }
  if (expectedOperation === 'database-import') {
    return retainedImportRecord(marker, expectedOperation);
  }
  if (expectedOperation === 'database-restore') {
    return retainedRestoreRecord(marker, expectedOperation);
  }
  throw new Error('HOST_OPERATION_LOCK_RETAINED_EVIDENCE_INVALID');
}

async function readExactMarker(ownerFile, fileSystem = fsp, expectedLinkCount = 1n) {
  const before = await fileSystem.lstat(ownerFile, { bigint: true });
  if (!before.isFile() || before.nlink !== expectedLinkCount) {
    throw new Error('HOST_OPERATION_LOCK_OWNERSHIP_CHANGED');
  }
  const handle = await fileSystem.open(ownerFile, 'r');
  try {
    const opened = await handle.stat({ bigint: true });
    if (!sameFileIdentity(before, opened)
        || opened.size < 1n
        || opened.size > BigInt(MAX_MARKER_BYTES)) {
      throw new Error('HOST_OPERATION_LOCK_OWNERSHIP_CHANGED');
    }
    const marker = await handle.readFile('utf8');
    const after = await fileSystem.lstat(ownerFile, { bigint: true });
    if (!sameFileIdentity(opened, after)) {
      throw new Error('HOST_OPERATION_LOCK_OWNERSHIP_CHANGED');
    }
    return { identity: opened, marker };
  } finally {
    await handle.close();
  }
}

async function syncDirectory(directory, fileSystem = fsp, platform = process.platform) {
  const handle = await fileSystem.open(directory, platform === 'win32' ? 'r+' : 'r');
  let syncError;
  try {
    await handle.sync();
  } catch (error) {
    syncError = error;
  }
  let closeError;
  try {
    await handle.close();
  } catch (error) {
    closeError = error;
  }
  const failure = combineErrors(syncError, closeError, `Directory sync failed: ${directory}`);
  if (failure) throw failure;
}

function isMissing(error) {
  return error?.code === 'ENOENT';
}

async function exactDirectoryEntries(directory, fileSystem) {
  const entries = await fileSystem.readdir(directory, { withFileTypes: true });
  if (entries.some((entry) => !entry.isFile())) {
    throw new Error('HOST_OPERATION_LOCK_OWNERSHIP_CHANGED');
  }
  return entries.map((entry) => entry.name).sort();
}

async function discardExactMarkerPath({
  directory,
  expectedIdentity,
  expectedMarker,
  fileSystem,
  markerFile,
  platform,
}) {
  const claimedFile = `${markerFile}.cleanup-${randomUUID()}.claimed`;
  await fileSystem.rename(markerFile, claimedFile);
  let claimed;
  try {
    const linkCount = (await fileSystem.lstat(claimedFile, { bigint: true })).nlink;
    claimed = await readExactMarker(claimedFile, fileSystem, linkCount);
  } catch (error) {
    let restoreError;
    try {
      await fileSystem.rename(claimedFile, markerFile);
    } catch (failure) {
      restoreError = failure;
    }
    throw combineErrors(
      error,
      restoreError,
      `Host operation marker claim inspection and restoration failed: ${markerFile}`,
    );
  }
  if (!sameFileIdentity(expectedIdentity, claimed.identity)
      || claimed.marker !== expectedMarker) {
    let restoreError;
    try {
      await fileSystem.rename(claimedFile, markerFile);
    } catch (error) {
      restoreError = error;
    }
    throw combineErrors(
      new Error('HOST_OPERATION_LOCK_OWNERSHIP_CHANGED'),
      restoreError,
      `Host operation foreign marker claim restoration failed: ${markerFile}`,
    );
  }
  await fileSystem.unlink(claimedFile);
  await syncDirectory(directory, fileSystem, platform);
}

function assertExactEntries(actual, expected) {
  const ordered = [...expected].sort();
  if (actual.length !== ordered.length
      || actual.some((entry, index) => entry !== ordered[index])) {
    throw new Error('HOST_OPERATION_LOCK_OWNERSHIP_CHANGED');
  }
}

function completionMarker(operation, ownerPid, directoryIdentity) {
  return [
    'COMPLETED',
    'protocol=easyboost-host-operation-completion-v1',
    `operation=${operation}`,
    `ownerPid=${ownerPid}`,
    `directoryDevice=${directoryIdentity.dev}`,
    `directoryInode=${directoryIdentity.ino}`,
    '',
  ].join('\n');
}

function parseActiveMarker(marker) {
  const lines = marker.split('\n');
  if (lines.length !== 4
      || lines[0] !== 'protocol=easyboost-host-operation-v1'
      || !lines[1].startsWith('operation=')
      || !lines[2].startsWith('ownerPid=')
      || lines[3] !== '') {
    throw new Error('HOST_OPERATION_LOCK_OWNERSHIP_CHANGED');
  }
  const operation = lines[1].slice('operation='.length);
  const ownerPid = Number(lines[2].slice('ownerPid='.length));
  if (!SAFE_OPERATION.test(operation)
      || !Number.isSafeInteger(ownerPid)
      || ownerPid < 1
      || activeMarker(operation, ownerPid) !== marker) {
    throw new Error('HOST_OPERATION_LOCK_OWNERSHIP_CHANGED');
  }
  return { operation, ownerPid };
}

async function readCompletionProof(directory, fileSystem) {
  const directoryIdentity = await fileSystem.lstat(directory, { bigint: true });
  if (!directoryIdentity.isDirectory()) {
    throw new Error('HOST_OPERATION_LOCK_OWNERSHIP_CHANGED');
  }
  const owner = await readExactMarker(path.join(directory, OWNER_FILE), fileSystem);
  const { operation, ownerPid } = parseActiveMarker(owner.marker);
  const expected = completionMarker(operation, ownerPid, directoryIdentity);
  const authority = await readExactMarker(
    path.join(directory, 'completion-authority'), fileSystem, 2n,
  );
  const completed = await readExactMarker(path.join(directory, 'completed'), fileSystem, 2n);
  if (!sameFileIdentity(authority.identity, completed.identity)
      || authority.marker !== expected
      || completed.marker !== expected) {
    throw new Error('HOST_OPERATION_LOCK_OWNERSHIP_CHANGED');
  }
  const entries = await exactDirectoryEntries(directory, fileSystem);
  const activeEntries = [OWNER_FILE, 'completion-authority', 'completed'];
  const retainedEntries = [
    OWNER_FILE,
    RETAINED_AUTHORITY_FILE,
    RETAINED_FILE,
    'completion-authority',
    'completed',
  ];
  if (entries.length === activeEntries.length) {
    assertExactEntries(entries, activeEntries);
  } else {
    assertExactEntries(entries, retainedEntries);
    const retained = await readExactMarker(
      path.join(directory, RETAINED_FILE), fileSystem, 2n,
    );
    const retainedAuthority = await readExactMarker(
      path.join(directory, RETAINED_AUTHORITY_FILE), fileSystem, 2n,
    );
    if (!sameFileIdentity(retained.identity, retainedAuthority.identity)
        || retained.marker !== retainedAuthority.marker) {
      throw new Error('HOST_OPERATION_LOCK_OWNERSHIP_CHANGED');
    }
  }
  return { directoryIdentity, operation, ownerPid };
}

async function hasProvenCompletion(directory, fileSystem, platform) {
  try {
    await readCompletionProof(directory, fileSystem);
    await syncDirectory(directory, fileSystem, platform);
    await syncDirectory(path.dirname(directory), fileSystem, platform);
    await readCompletionProof(directory, fileSystem);
    return true;
  } catch {
    return false;
  }
}

async function pendingCompletionDirectories(resolvedDirectory, fileSystem, platform) {
  const parent = path.dirname(resolvedDirectory);
  const baseName = path.basename(resolvedDirectory);
  const completionPrefix = `${baseName}.completing-`;
  const abandonmentPrefix = `${baseName}.abandoned-`;
  let entries;
  try {
    entries = await fileSystem.readdir(parent, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  const protocolEntries = entries.filter((entry) => (
    entry.name.startsWith(completionPrefix)
    || entry.name.startsWith(abandonmentPrefix)
  ));
  if (protocolEntries.length > MAX_HOST_OPERATION_TOMBSTONES) {
    throw new Error(`HOST_OPERATION_LOCK_PROTOCOL_LIMIT: ${resolvedDirectory}`);
  }
  const pending = [];
  for (const entry of protocolEntries) {
    const candidate = path.join(parent, entry.name);
    const proven = entry.isDirectory() && (entry.name.startsWith(completionPrefix)
      ? await hasProvenCompletion(candidate, fileSystem, platform)
      : await hasProvenAbandonment(candidate, fileSystem, platform));
    if (!proven) {
      pending.push(candidate);
    }
  }
  return pending;
}

async function validateOwnedSnapshot({
  currentDirectory,
  directoryIdentity,
  expectedEntries,
  fileSystem,
  ownerIdentity,
  ownerMarker,
  retainedAuthorityIdentity,
  retainedIdentity,
  retainedMarker: expectedRetainedMarker,
}) {
  const currentIdentity = await fileSystem.lstat(currentDirectory, { bigint: true });
  if (!sameDirectoryIdentity(directoryIdentity, currentIdentity)) {
    throw new Error('HOST_OPERATION_LOCK_OWNERSHIP_CHANGED');
  }
  const owner = await readExactMarker(path.join(currentDirectory, OWNER_FILE), fileSystem);
  if (!sameFileIdentity(ownerIdentity, owner.identity) || owner.marker !== ownerMarker) {
    throw new Error('HOST_OPERATION_LOCK_OWNERSHIP_CHANGED');
  }
  if (expectedRetainedMarker !== undefined) {
    const retained = await readExactMarker(
      path.join(currentDirectory, RETAINED_FILE), fileSystem, 2n,
    );
    const retainedAuthority = await readExactMarker(
      path.join(currentDirectory, RETAINED_AUTHORITY_FILE), fileSystem, 2n,
    );
    if (!sameFileIdentity(retainedIdentity, retained.identity)
        || !sameFileIdentity(retainedAuthorityIdentity, retainedAuthority.identity)
        || !sameFileIdentity(retained.identity, retainedAuthority.identity)
        || retained.marker !== expectedRetainedMarker
        || retainedAuthority.marker !== expectedRetainedMarker) {
      throw new Error('HOST_OPERATION_LOCK_OWNERSHIP_CHANGED');
    }
  }
  assertExactEntries(await exactDirectoryEntries(currentDirectory, fileSystem), expectedEntries);
}

async function restoreUnexpectedCompletionDirectory({
  fileSystem,
  platform,
  resolvedDirectory,
  unexpectedDirectory,
  unexpectedIdentity,
}) {
  try {
    await fileSystem.lstat(resolvedDirectory, { bigint: true });
    throw new Error('HOST_OPERATION_LOCK_OWNERSHIP_CHANGED');
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  await fileSystem.rename(unexpectedDirectory, resolvedDirectory);
  const restored = await fileSystem.lstat(resolvedDirectory, { bigint: true });
  if (!sameDirectoryIdentity(unexpectedIdentity, restored)) {
    throw new Error('HOST_OPERATION_LOCK_OWNERSHIP_CHANGED');
  }
  await syncDirectory(path.dirname(resolvedDirectory), fileSystem, platform);
}

async function finalizeOwnedDirectory({
  currentDirectory,
  directoryIdentity,
  fileSystem,
  operation,
  ownerIdentity,
  ownerMarker,
  ownerPid,
  platform,
  retainedAuthorityIdentity,
  retainedIdentity,
  retainedMarker: expectedRetainedMarker,
  resolvedDirectory,
}) {
  let location = currentDirectory;
  const baseEntries = expectedRetainedMarker === undefined
    ? [OWNER_FILE]
    : [OWNER_FILE, RETAINED_AUTHORITY_FILE, RETAINED_FILE];
  const proofIntent = 'completion-intent';
  const proofAuthority = 'completion-authority';
  const completedFile = 'completed';
  const validate = (entries) => validateOwnedSnapshot({
    currentDirectory: location,
    directoryIdentity,
    expectedEntries: entries,
    fileSystem,
    ownerIdentity,
    ownerMarker,
    retainedAuthorityIdentity,
    retainedIdentity,
    retainedMarker: expectedRetainedMarker,
  });
  const proveCompletedForSnapshot = async () => {
    const completedEntries = [...baseEntries, proofAuthority, completedFile];
    await syncDirectory(location, fileSystem, platform);
    await syncDirectory(path.dirname(location), fileSystem, platform);
    await validate(completedEntries);
    await readCompletionProof(location, fileSystem);
    await validate(completedEntries);
  };

  let entries = await exactDirectoryEntries(location, fileSystem);
  if (entries.includes(completedFile)) {
    await proveCompletedForSnapshot();
    return { completed: true, currentDirectory: location };
  }
  const intentAlreadyPresent = entries.includes(proofIntent);
  const authorityAlreadyPresent = entries.includes(proofAuthority);
  if (intentAlreadyPresent && authorityAlreadyPresent) {
    throw new Error('HOST_OPERATION_LOCK_OWNERSHIP_CHANGED');
  }
  const initialPhaseEntries = intentAlreadyPresent
    ? [...baseEntries, proofIntent]
    : (authorityAlreadyPresent ? [...baseEntries, proofAuthority] : baseEntries);
  assertExactEntries(entries, initialPhaseEntries);
  await validate(initialPhaseEntries);

  const proof = completionMarker(operation, ownerPid, directoryIdentity);
  let intentIdentity;
  if (!intentAlreadyPresent && !authorityAlreadyPresent) {
    const intentFile = path.join(location, proofIntent);
    const handle = await fileSystem.open(intentFile, 'wx', 0o600);
    try {
      await handle.writeFile(proof, 'utf8');
      await handle.sync();
      intentIdentity = await handle.stat({ bigint: true });
    } finally {
      await handle.close();
    }
    if (!intentIdentity.isFile() || intentIdentity.nlink !== 1n) {
      throw new Error('HOST_OPERATION_LOCK_OWNERSHIP_CHANGED');
    }
    await syncDirectory(location, fileSystem, platform);
    await validate([...baseEntries, proofIntent]);
    const durableIntent = await readExactMarker(intentFile, fileSystem);
    if (!sameFileIdentity(intentIdentity, durableIntent.identity)
        || durableIntent.marker !== proof) {
      throw new Error('HOST_OPERATION_LOCK_OWNERSHIP_CHANGED');
    }
  } else if (intentAlreadyPresent) {
    const intent = await readExactMarker(path.join(location, proofIntent), fileSystem);
    if (intent.marker !== proof) {
      throw new Error('HOST_OPERATION_LOCK_OWNERSHIP_CHANGED');
    }
    intentIdentity = intent.identity;
    const handle = await fileSystem.open(path.join(location, proofIntent), 'r+');
    try {
      const opened = await handle.stat({ bigint: true });
      if (!sameFileIdentity(intentIdentity, opened)) {
        throw new Error('HOST_OPERATION_LOCK_OWNERSHIP_CHANGED');
      }
      await handle.sync();
    } finally {
      await handle.close();
    }
    await syncDirectory(location, fileSystem, platform);
  }

  const phaseBeforeMove = authorityAlreadyPresent ? proofAuthority : proofIntent;

  if (location === resolvedDirectory) {
    const completingDirectory = `${resolvedDirectory}.completing-${randomUUID()}`;
    await fileSystem.rename(location, completingDirectory);
    location = completingDirectory;
    const movedIdentity = await fileSystem.lstat(location, { bigint: true });
    if (!sameDirectoryIdentity(directoryIdentity, movedIdentity)) {
      const identityError = new Error('HOST_OPERATION_LOCK_OWNERSHIP_CHANGED');
      let restoreError;
      try {
        await restoreUnexpectedCompletionDirectory({
          fileSystem,
          platform,
          resolvedDirectory,
          unexpectedDirectory: location,
          unexpectedIdentity: movedIdentity,
        });
        location = resolvedDirectory;
      } catch (error) {
        restoreError = error;
      }
      throw combineErrors(
        identityError,
        restoreError,
        'HOST_OPERATION_LOCK_OWNERSHIP_CHANGED: foreign directory restoration failed',
      );
    }
    await syncDirectory(path.dirname(resolvedDirectory), fileSystem, platform);
    await validate([...baseEntries, phaseBeforeMove]);
  } else if (!path.basename(location).startsWith(
    `${path.basename(resolvedDirectory)}.completing-`,
  )) {
    throw new Error('HOST_OPERATION_LOCK_OWNERSHIP_CHANGED');
  }

  const intentFile = path.join(location, proofIntent);
  const authorityFile = path.join(location, proofAuthority);
  const publishedFile = path.join(location, completedFile);
  let authority;
  if (authorityAlreadyPresent) {
    authority = await readExactMarker(authorityFile, fileSystem).then((item) => {
      if (item.marker !== proof) throw new Error('HOST_OPERATION_LOCK_OWNERSHIP_CHANGED');
      return item.identity;
    });
    const handle = await fileSystem.open(authorityFile, 'r+');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } else {
    await fileSystem.rename(intentFile, authorityFile);
    authority = await readExactMarker(authorityFile, fileSystem).then((item) => {
      if (!sameFileIdentity(intentIdentity, item.identity) || item.marker !== proof) {
        throw new Error('HOST_OPERATION_LOCK_OWNERSHIP_CHANGED');
      }
      return item.identity;
    });
    await syncDirectory(location, fileSystem, platform);
  }
  if (!authority.isFile() || authority.nlink !== 1n) {
    throw new Error('HOST_OPERATION_LOCK_OWNERSHIP_CHANGED');
  }
  await validate([...baseEntries, proofAuthority]);
  await fileSystem.link(authorityFile, publishedFile);
  await syncDirectory(location, fileSystem, platform);
  const published = await readExactMarker(publishedFile, fileSystem, 2n);
  const durableAuthority = await readExactMarker(authorityFile, fileSystem, 2n);
  if (!sameFileIdentity(authority, published.identity)
      || !sameFileIdentity(durableAuthority.identity, published.identity)
      || published.marker !== proof
      || durableAuthority.marker !== proof) {
    throw new Error('HOST_OPERATION_LOCK_OWNERSHIP_CHANGED');
  }
  try {
    await validate([...baseEntries, proofAuthority, completedFile]);
  } catch (validationError) {
    try {
      await proveCompletedForSnapshot();
    } catch {
      throw validationError;
    }
  }
  return { completed: true, currentDirectory: location };
}

function resolveLockDirectory({ environment, lockDirectory }) {
  const configured = lockDirectory
    || environment?.EASYBOOST_HOST_OPERATION_LOCK_DIR
    || DEFAULT_HOST_OPERATION_LOCK_DIRECTORY;
  if (typeof configured !== 'string' || !configured || !isAbsoluteHostPath(configured)) {
    const error = new Error('EASYBOOST_HOST_OPERATION_LOCK_DIR must be an absolute path');
    error.exitCode = 2;
    throw error;
  }
  return path.normalize(configured);
}

async function boundedLockAction(action, timeoutMs, label) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error(`${label} timeout must be a positive safe integer`);
  }
  const startedAt = process.hrtime.bigint();
  let actionError;
  let result;
  try {
    result = await action();
  } catch (error) {
    actionError = error;
  }
  const elapsedMilliseconds = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
  if (elapsedMilliseconds >= timeoutMs) {
    const timeoutError = new Error(`${label} timed out after ${timeoutMs}ms`, {
      ...(actionError ? { cause: actionError } : {}),
    });
    timeoutError.hostOperationActionSettled = true;
    timeoutError.hostOperationActionSucceeded = !actionError;
    throw timeoutError;
  }
  if (actionError) throw actionError;
  return result;
}

function hostOperationNotAbsent(resolvedDirectory) {
  const error = new Error(`HOST_OPERATION_LOCK_NOT_ABSENT: ${resolvedDirectory}`);
  error.code = 'HOST_OPERATION_LOCK_NOT_ABSENT';
  return error;
}

function parseAbandonedMarker(marker) {
  const lines = marker.split('\n');
  if (lines.length !== 5
      || lines[0] !== 'ABANDONED'
      || lines[1] !== 'protocol=easyboost-host-operation-abandoned-v1'
      || !lines[2].startsWith('operation=')
      || !lines[3].startsWith('ownerPid=')
      || lines[4] !== '') {
    throw new Error('HOST_OPERATION_LOCK_OWNERSHIP_CHANGED');
  }
  const operation = lines[2].slice('operation='.length);
  const ownerPid = Number(lines[3].slice('ownerPid='.length));
  if (!SAFE_OPERATION.test(operation)
      || !Number.isSafeInteger(ownerPid)
      || ownerPid < 1) {
    throw new Error('HOST_OPERATION_LOCK_OWNERSHIP_CHANGED');
  }
  return { operation, ownerPid };
}

async function readMarkerSnapshotWithCurrentLinks(markerFile, fileSystem) {
  const identity = await fileSystem.lstat(markerFile, { bigint: true });
  return readExactMarker(markerFile, fileSystem, identity.nlink);
}

async function readAbandonmentProof(directory, fileSystem) {
  const directoryIdentity = await fileSystem.lstat(directory, { bigint: true });
  if (!directoryIdentity.isDirectory()) {
    throw new Error('HOST_OPERATION_LOCK_OWNERSHIP_CHANGED');
  }
  const entries = await exactDirectoryEntries(directory, fileSystem);
  const hasOwner = entries.includes(OWNER_FILE);
  assertExactEntries(entries, hasOwner ? [OWNER_FILE, 'abandoned'] : ['abandoned']);
  const abandoned = await readExactMarker(path.join(directory, 'abandoned'), fileSystem);
  const record = parseAbandonedMarker(abandoned.marker);
  if (hasOwner) {
    const owner = await readExactMarker(path.join(directory, OWNER_FILE), fileSystem);
    if (owner.marker !== activeMarker(record.operation, record.ownerPid)) {
      throw new Error('HOST_OPERATION_LOCK_OWNERSHIP_CHANGED');
    }
  }
  const after = await fileSystem.lstat(directory, { bigint: true });
  if (!sameDirectoryIdentity(directoryIdentity, after)) {
    throw new Error('HOST_OPERATION_LOCK_OWNERSHIP_CHANGED');
  }
  return { directoryIdentity, entries };
}

async function hasProvenAbandonment(directory, fileSystem, platform) {
  try {
    await readAbandonmentProof(directory, fileSystem);
    await syncDirectory(directory, fileSystem, platform);
    await syncDirectory(path.dirname(directory), fileSystem, platform);
    await readAbandonmentProof(directory, fileSystem);
    return true;
  } catch {
    return false;
  }
}

async function readTombstoneSnapshot(directory, fileSystem, kind) {
  const proof = kind === 'completion'
    ? await readCompletionProof(directory, fileSystem)
    : await readAbandonmentProof(directory, fileSystem);
  const entries = await exactDirectoryEntries(directory, fileSystem);
  const files = new Map();
  for (const entry of entries) {
    files.set(entry, await readMarkerSnapshotWithCurrentLinks(
      path.join(directory, entry), fileSystem,
    ));
  }
  const after = await fileSystem.lstat(directory, { bigint: true });
  if (!sameDirectoryIdentity(proof.directoryIdentity, after)) {
    throw new Error('HOST_OPERATION_LOCK_OWNERSHIP_CHANGED');
  }
  return { directoryIdentity: after, entries, files, kind };
}

function sameTombstoneSnapshot(expected, actual) {
  return sameDirectoryIdentity(expected.directoryIdentity, actual.directoryIdentity)
    && expected.entries.length === actual.entries.length
    && expected.entries.every((entry, index) => entry === actual.entries[index])
    && expected.entries.every((entry) => {
      const left = expected.files.get(entry);
      const right = actual.files.get(entry);
      return Boolean(left && right
        && sameFileIdentity(left.identity, right.identity)
        && left.marker === right.marker);
    });
}

async function readDurableTombstoneSnapshot(directory, fileSystem, platform, kind) {
  const before = await readTombstoneSnapshot(directory, fileSystem, kind);
  await syncDirectory(directory, fileSystem, platform);
  await syncDirectory(path.dirname(directory), fileSystem, platform);
  const after = await readTombstoneSnapshot(directory, fileSystem, kind);
  if (!sameTombstoneSnapshot(before, after)) {
    throw new Error('HOST_OPERATION_LOCK_OWNERSHIP_CHANGED');
  }
  return after;
}

async function discardExactTombstone({
  directory,
  fileSystem,
  kind,
  platform,
  snapshot,
}) {
  const quarantineDirectory = `${directory}.delete-${randomUUID()}.quarantine`;
  await fileSystem.rename(directory, quarantineDirectory);
  await syncDirectory(path.dirname(directory), fileSystem, platform);
  let claimed;
  try {
    claimed = await readTombstoneSnapshot(quarantineDirectory, fileSystem, kind);
  } catch (error) {
    let restoreError;
    try {
      const movedIdentity = await fileSystem.lstat(quarantineDirectory, { bigint: true });
      await restoreUnexpectedCompletionDirectory({
        fileSystem,
        platform,
        resolvedDirectory: directory,
        unexpectedDirectory: quarantineDirectory,
        unexpectedIdentity: movedIdentity,
      });
    } catch (failure) {
      restoreError = failure;
    }
    throw combineErrors(
      error,
      restoreError,
      `Host operation tombstone inspection and restoration failed: ${directory}`,
    );
  }
  if (!sameTombstoneSnapshot(snapshot, claimed)) {
    let restoreError;
    try {
      await restoreUnexpectedCompletionDirectory({
        fileSystem,
        platform,
        resolvedDirectory: directory,
        unexpectedDirectory: quarantineDirectory,
        unexpectedIdentity: claimed.directoryIdentity,
      });
    } catch (error) {
      restoreError = error;
    }
    throw combineErrors(
      new Error('HOST_OPERATION_LOCK_OWNERSHIP_CHANGED'),
      restoreError,
      `Host operation foreign tombstone restoration failed: ${directory}`,
    );
  }

  const claimedFiles = [];
  for (const entry of snapshot.entries) {
    const markerFile = path.join(quarantineDirectory, entry);
    const claimedFile = `${markerFile}.delete-${randomUUID()}.claimed`;
    await fileSystem.rename(markerFile, claimedFile);
    const moved = await readMarkerSnapshotWithCurrentLinks(claimedFile, fileSystem);
    const expected = snapshot.files.get(entry);
    if (!sameFileIdentity(expected.identity, moved.identity)
        || expected.marker !== moved.marker) {
      let restoreError;
      try {
        await fileSystem.rename(claimedFile, markerFile);
      } catch (error) {
        restoreError = error;
      }
      throw combineErrors(
        new Error('HOST_OPERATION_LOCK_OWNERSHIP_CHANGED'),
        restoreError,
        `Host operation foreign tombstone marker restoration failed: ${markerFile}`,
      );
    }
    claimedFiles.push({ claimedFile, expected });
  }
  const beforeDelete = await fileSystem.lstat(quarantineDirectory, { bigint: true });
  if (!sameDirectoryIdentity(snapshot.directoryIdentity, beforeDelete)) {
    throw new Error('HOST_OPERATION_LOCK_OWNERSHIP_CHANGED');
  }
  for (const { claimedFile, expected } of claimedFiles) {
    const current = await readMarkerSnapshotWithCurrentLinks(claimedFile, fileSystem);
    if (!sameFileIdentity(expected.identity, current.identity)
        || expected.marker !== current.marker) {
      throw new Error('HOST_OPERATION_LOCK_OWNERSHIP_CHANGED');
    }
    await fileSystem.unlink(claimedFile);
  }
  await syncDirectory(quarantineDirectory, fileSystem, platform);
  const emptyIdentity = await fileSystem.lstat(quarantineDirectory, { bigint: true });
  if (!sameDirectoryIdentity(snapshot.directoryIdentity, emptyIdentity)
      || (await fileSystem.readdir(quarantineDirectory)).length !== 0) {
    throw new Error('HOST_OPERATION_LOCK_OWNERSHIP_CHANGED');
  }
  await fileSystem.rmdir(quarantineDirectory);
  await syncDirectory(path.dirname(directory), fileSystem, platform);
}

async function cleanupProvenTombstones(resolvedDirectory, fileSystem, platform) {
  const parent = path.dirname(resolvedDirectory);
  const baseName = path.basename(resolvedDirectory);
  const completionPrefix = `${baseName}.completing-`;
  const abandonmentPrefix = `${baseName}.abandoned-`;
  const entries = await fileSystem.readdir(parent, { withFileTypes: true });
  const candidates = entries.filter((entry) => (
    entry.name.startsWith(completionPrefix)
    || entry.name.startsWith(abandonmentPrefix)
  ));
  if (candidates.length > MAX_HOST_OPERATION_TOMBSTONES) {
    throw new Error(`HOST_OPERATION_LOCK_PROTOCOL_LIMIT: ${resolvedDirectory}`);
  }
  for (const entry of candidates) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(parent, entry.name);
    const kind = entry.name.startsWith(completionPrefix) ? 'completion' : 'abandonment';
    const proven = kind === 'completion'
      ? await hasProvenCompletion(directory, fileSystem, platform)
      : await hasProvenAbandonment(directory, fileSystem, platform);
    if (!proven) continue;
    const snapshot = await readDurableTombstoneSnapshot(
      directory, fileSystem, platform, kind,
    );
    await discardExactTombstone({ directory, fileSystem, kind, platform, snapshot });
  }
}

async function settleExactAbandonedCanonical(resolvedDirectory, fileSystem, platform) {
  let directoryIdentity;
  try {
    directoryIdentity = await fileSystem.lstat(resolvedDirectory, { bigint: true });
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
  if (!directoryIdentity.isDirectory()) return false;
  const entries = await exactDirectoryEntries(resolvedDirectory, fileSystem);
  if (!entries.includes('abandoned')) return false;
  const hasOwner = entries.includes(OWNER_FILE);
  assertExactEntries(entries, hasOwner ? [OWNER_FILE, 'abandoned'] : ['abandoned']);
  const abandoned = await readExactMarker(
    path.join(resolvedDirectory, 'abandoned'), fileSystem,
  );
  const record = parseAbandonedMarker(abandoned.marker);
  if (hasOwner) {
    const owner = await readExactMarker(path.join(resolvedDirectory, OWNER_FILE), fileSystem);
    if (owner.marker !== activeMarker(record.operation, record.ownerPid)) {
      throw new Error('HOST_OPERATION_LOCK_OWNERSHIP_CHANGED');
    }
  }
  await syncDirectory(resolvedDirectory, fileSystem, platform);
  const beforeRename = await fileSystem.lstat(resolvedDirectory, { bigint: true });
  if (!sameDirectoryIdentity(directoryIdentity, beforeRename)) {
    throw new Error('HOST_OPERATION_LOCK_OWNERSHIP_CHANGED');
  }
  const abandonedDirectory = `${resolvedDirectory}.abandoned-${randomUUID()}`;
  await fileSystem.rename(resolvedDirectory, abandonedDirectory);
  const movedIdentity = await fileSystem.lstat(abandonedDirectory, { bigint: true });
  if (!sameDirectoryIdentity(directoryIdentity, movedIdentity)) {
    const identityError = new Error('HOST_OPERATION_LOCK_OWNERSHIP_CHANGED');
    let restoreError;
    try {
      await restoreUnexpectedCompletionDirectory({
        fileSystem,
        platform,
        resolvedDirectory,
        unexpectedDirectory: abandonedDirectory,
        unexpectedIdentity: movedIdentity,
      });
    } catch (error) {
      restoreError = error;
    }
    throw combineErrors(
      identityError,
      restoreError,
      'HOST_OPERATION_LOCK_OWNERSHIP_CHANGED: abandoned directory restoration failed',
    );
  }
  await syncDirectory(path.dirname(resolvedDirectory), fileSystem, platform);
  return true;
}

async function resumeExactActiveCompletion(resolvedDirectory, fileSystem, platform) {
  const pending = await pendingCompletionDirectories(
    resolvedDirectory, fileSystem, platform,
  );
  let canonicalIntent = false;
  try {
    canonicalIntent = (await exactDirectoryEntries(resolvedDirectory, fileSystem))
      .includes('completion-intent');
  } catch {}
  const candidates = canonicalIntent ? [resolvedDirectory, ...pending] : pending;
  if (candidates.length !== 1) return false;
  const currentDirectory = candidates[0];
  let entries;
  try {
    entries = await exactDirectoryEntries(currentDirectory, fileSystem);
  } catch {
    return false;
  }
  const hasCompletionIntent = entries.includes('completion-intent');
  const hasCompletionAuthority = entries.includes('completion-authority');
  try {
    if (hasCompletionIntent && hasCompletionAuthority) return false;
    assertExactEntries(entries, hasCompletionIntent
      ? [OWNER_FILE, 'completion-intent']
      : (hasCompletionAuthority ? [OWNER_FILE, 'completion-authority'] : [OWNER_FILE]));
    const directoryIdentity = await fileSystem.lstat(currentDirectory, { bigint: true });
    if (!directoryIdentity.isDirectory()) return false;
    const owner = await readExactMarker(path.join(currentDirectory, OWNER_FILE), fileSystem);
    const record = parseActiveMarker(owner.marker);
    if (hasCompletionIntent || hasCompletionAuthority) {
      const phaseFile = hasCompletionIntent ? 'completion-intent' : 'completion-authority';
      const authority = await readExactMarker(
        path.join(currentDirectory, phaseFile), fileSystem,
      );
      if (authority.marker !== completionMarker(
        record.operation, record.ownerPid, directoryIdentity,
      )) {
        return false;
      }
    }
    await finalizeOwnedDirectory({
      currentDirectory,
      directoryIdentity,
      fileSystem,
      operation: record.operation,
      ownerIdentity: owner.identity,
      ownerMarker: owner.marker,
      ownerPid: record.ownerPid,
      platform,
      resolvedDirectory,
    });
    return true;
  } catch {
    return false;
  }
}

export async function acquireHostOperationAbsenceLease(options = {}) {
  const releaseGuard = await acquireHostOperationLock({
    ...options,
    operation: 'host-operation-absence-lease',
  });
  let held = true;
  const release = async () => {
    if (!held) {
      throw new Error(`HOST_OPERATION_ABSENCE_LEASE_NOT_HELD: ${releaseGuard.lockDirectory}`);
    }
    await releaseGuard();
    held = false;
  };
  return Object.freeze({
    lockDirectory: releaseGuard.lockDirectory,
    release,
    state: 'absent-leased',
  });
}

export async function proveHostOperationLockAbsent(options = {}) {
  try {
    return await acquireHostOperationAbsenceLease(options);
  } catch (error) {
    if (/^HOST_OPERATION_LOCKED:/u.test(error.message)) {
      const resolvedDirectory = resolveLockDirectory(options);
      throw hostOperationNotAbsent(resolvedDirectory);
    }
    throw error;
  }
}

export async function acquireHostOperationLock({
  environment = process.env,
  fileSystem = fsp,
  lockDirectory,
  operation,
  platform = process.platform,
} = {}) {
  if (!SAFE_OPERATION.test(operation || '')) {
    const error = new Error('Host operation lock requires one safe operation code');
    error.exitCode = 2;
    throw error;
  }
  const resolvedDirectory = resolveLockDirectory({ environment, lockDirectory });
  const ownerFile = path.join(resolvedDirectory, OWNER_FILE);
  const ownerMarker = activeMarker(operation, process.pid);
  let directoryCreated = false;
  let directoryIdentity;
  let ownerIdentity;
  try {
    await settleExactAbandonedCanonical(resolvedDirectory, fileSystem, platform);
    await cleanupProvenTombstones(resolvedDirectory, fileSystem, platform);
    await resumeExactActiveCompletion(resolvedDirectory, fileSystem, platform);
    const pendingBeforeAcquire = await pendingCompletionDirectories(
      resolvedDirectory, fileSystem, platform,
    );
    if (pendingBeforeAcquire.length) {
      throw new Error(`HOST_OPERATION_LOCKED: ${pendingBeforeAcquire[0]}`);
    }
    await fileSystem.mkdir(resolvedDirectory, { mode: 0o700 });
    directoryCreated = true;
    directoryIdentity = await fileSystem.lstat(resolvedDirectory, { bigint: true });
    if (!directoryIdentity.isDirectory()) {
      throw new Error('HOST_OPERATION_LOCK_OWNERSHIP_CHANGED');
    }
    const ownerHandle = await fileSystem.open(ownerFile, 'wx', 0o600);
    try {
      await ownerHandle.writeFile(ownerMarker, 'utf8');
      await ownerHandle.sync();
      ownerIdentity = await ownerHandle.stat({ bigint: true });
    } finally {
      await ownerHandle.close();
    }
    if (!ownerIdentity.isFile() || ownerIdentity.nlink !== 1n) {
      throw new Error('HOST_OPERATION_LOCK_OWNERSHIP_CHANGED');
    }
    await syncDirectory(resolvedDirectory, fileSystem, platform);
    await validateOwnedSnapshot({
      currentDirectory: resolvedDirectory,
      directoryIdentity,
      expectedEntries: [OWNER_FILE],
      fileSystem,
      ownerIdentity,
      ownerMarker,
    });
    const pendingAfterAcquire = await pendingCompletionDirectories(
      resolvedDirectory, fileSystem, platform,
    );
    if (pendingAfterAcquire.length) {
      throw new Error(`HOST_OPERATION_LOCKED: ${pendingAfterAcquire[0]}`);
    }
    await validateOwnedSnapshot({
      currentDirectory: resolvedDirectory,
      directoryIdentity,
      expectedEntries: [OWNER_FILE],
      fileSystem,
      ownerIdentity,
      ownerMarker,
    });
  } catch (error) {
    if (error.code === 'EEXIST' && !directoryCreated) {
      throw new Error(`HOST_OPERATION_LOCKED: ${resolvedDirectory}`);
    }
    let cleanupError;
    if (directoryCreated) {
      let abandonedEvidenceError;
      try {
        const current = await fileSystem.lstat(resolvedDirectory, { bigint: true });
        directoryIdentity ||= current;
        const foreignCanonical = !sameDirectoryIdentity(directoryIdentity, current);
        if (foreignCanonical) {
          if (ownerIdentity) {
            try {
              const markerAtForeignPath = await readExactMarker(ownerFile, fileSystem)
                .catch(() => null);
              if (markerAtForeignPath
                  && sameFileIdentity(ownerIdentity, markerAtForeignPath.identity)
                  && markerAtForeignPath.marker === ownerMarker) {
                await discardExactMarkerPath({
                  directory: resolvedDirectory,
                  expectedIdentity: ownerIdentity,
                  expectedMarker: ownerMarker,
                  fileSystem,
                  markerFile: ownerFile,
                  platform,
                });
              }
            } catch (failure) {
              cleanupError = failure;
            }
          }
        }
        if (!foreignCanonical) {
          const abandonedMarker = path.join(resolvedDirectory, 'abandoned');
          const abandonedRecord = [
            'ABANDONED',
            'protocol=easyboost-host-operation-abandoned-v1',
            `operation=${operation}`,
            `ownerPid=${process.pid}`,
            '',
          ].join('\n');
          try {
            const handle = await fileSystem.open(abandonedMarker, 'wx', 0o600);
            try {
              await handle.writeFile(abandonedRecord, 'utf8');
              await handle.sync();
            } finally {
              await handle.close();
            }
          } catch (failure) {
            abandonedEvidenceError = failure;
          }
          const beforeAbandon = await fileSystem.lstat(resolvedDirectory, { bigint: true });
          if (!sameDirectoryIdentity(directoryIdentity, beforeAbandon)) {
            throw new Error('HOST_OPERATION_LOCK_OWNERSHIP_CHANGED');
          }
          const abandonedDirectory = `${resolvedDirectory}.abandoned-${randomUUID()}`;
          await fileSystem.rename(resolvedDirectory, abandonedDirectory);
          const abandonedIdentity = await fileSystem.lstat(abandonedDirectory, { bigint: true });
          if (!sameDirectoryIdentity(directoryIdentity, abandonedIdentity)) {
            const identityError = new Error('HOST_OPERATION_LOCK_OWNERSHIP_CHANGED');
            let restoreError;
            try {
              await restoreUnexpectedCompletionDirectory({
                fileSystem,
                platform,
                resolvedDirectory,
                unexpectedDirectory: abandonedDirectory,
                unexpectedIdentity: abandonedIdentity,
              });
            } catch (failure) {
              restoreError = failure;
            }
            throw combineErrors(
              identityError,
              restoreError,
              'HOST_OPERATION_LOCK_OWNERSHIP_CHANGED: abandoned cleanup restoration failed',
            );
          }
          await syncDirectory(path.dirname(resolvedDirectory), fileSystem, platform);
        }
      } catch (failure) {
        cleanupError = combineErrors(
          cleanupError,
          failure,
          'Host operation owned-directory cleanup failed',
        );
      }
      cleanupError = combineErrors(
        abandonedEvidenceError,
        cleanupError,
        'Host operation abandoned evidence and directory isolation both failed',
      );
    }
    throw combineErrors(error, cleanupError,
      'Host operation lock setup failed and owned-directory cleanup was incomplete');
  }

  let state = 'owned';
  let currentDirectory = resolvedDirectory;
  const release = async () => {
    if (state === 'retained' || state === 'retaining') {
      throw new Error(`HOST_OPERATION_LOCK_RETAINED: ${resolvedDirectory}`);
    }
    if (state !== 'owned') {
      throw new Error(`HOST_OPERATION_LOCK_NOT_OWNED: ${resolvedDirectory}`);
    }
    state = 'releasing';
    try {
      const finalized = await finalizeOwnedDirectory({
        currentDirectory,
        directoryIdentity,
        fileSystem,
        operation,
        ownerIdentity,
        ownerMarker,
        ownerPid: process.pid,
        platform,
        resolvedDirectory,
      });
      currentDirectory = finalized.currentDirectory;
      state = 'released';
    } catch (error) {
      const pending = await pendingCompletionDirectories(
        resolvedDirectory, fileSystem, platform,
      ).catch(() => []);
      if (pending.length === 1) currentDirectory = pending[0];
      state = 'owned';
      throw error;
    }
  };
  const completeRetained = async () => {
    if (state !== 'retained') {
      throw new Error(`HOST_OPERATION_LOCK_NOT_RETAINED: ${resolvedDirectory}`);
    }
    const retained = await openRetainedHostOperationLock({
      expectedOperation: operation,
      fileSystem,
      lockDirectory: resolvedDirectory,
      platform,
    });
    try {
      await retained.complete();
      state = 'released';
    } catch (error) {
      state = 'retained';
      throw error;
    }
  };
  release.retain = async (evidence) => {
    if (state !== 'owned') {
      throw new Error(`HOST_OPERATION_LOCK_NOT_OWNED: ${resolvedDirectory}`);
    }
    const persistentMarker = retainedMarker(operation, process.pid, evidence);
    const currentOwnerFile = path.join(currentDirectory, OWNER_FILE);
    const current = await fileSystem.lstat(currentDirectory, { bigint: true });
    const currentMarker = await readExactMarker(currentOwnerFile, fileSystem);
    if (!sameDirectoryIdentity(directoryIdentity, current)
        || !sameFileIdentity(ownerIdentity, currentMarker.identity)
        || currentMarker.marker !== ownerMarker) {
      throw new Error('HOST_OPERATION_LOCK_OWNERSHIP_CHANGED');
    }
    const existingEntries = await exactDirectoryEntries(currentDirectory, fileSystem);
    if (existingEntries.includes(RETAINED_AUTHORITY_FILE)
        && !existingEntries.includes(RETAINED_FILE)) {
      const authority = await readExactMarker(
        path.join(currentDirectory, RETAINED_AUTHORITY_FILE), fileSystem,
      );
      if (authority.marker !== persistentMarker) {
        throw new Error('HOST_OPERATION_LOCK_OWNERSHIP_CHANGED');
      }
      state = 'retaining';
      try {
        await resumeRetainedPublication({
          currentDirectory,
          expectedOperation: operation,
          fileSystem,
          platform,
        });
        state = 'retained';
        return completeRetained;
      } catch (error) {
        state = 'owned';
        throw error;
      }
    }
    const completionPhaseFiles = ['completion-intent', 'completion-authority']
      .filter((entry) => existingEntries.includes(entry));
    if (completionPhaseFiles.length > 1) {
      throw new Error('HOST_OPERATION_LOCK_OWNERSHIP_CHANGED');
    }
    const [completionPhaseFile] = completionPhaseFiles;
    assertExactEntries(existingEntries, completionPhaseFile
      ? [OWNER_FILE, completionPhaseFile]
      : [OWNER_FILE]);
    if (completionPhaseFile) {
      const proof = await readExactMarker(
        path.join(currentDirectory, completionPhaseFile), fileSystem,
      );
      if (proof.marker !== completionMarker(operation, process.pid, directoryIdentity)) {
        throw new Error('HOST_OPERATION_LOCK_OWNERSHIP_CHANGED');
      }
    }
    state = 'retaining';
    const pendingMarker = path.join(currentDirectory, RETAINED_AUTHORITY_FILE);
    const retainedFile = path.join(currentDirectory, RETAINED_FILE);
    let published = false;
    let pendingIdentity;
    try {
      const handle = await fileSystem.open(pendingMarker, 'wx', 0o600);
      try {
        await handle.writeFile(persistentMarker, 'utf8');
        await handle.sync();
        pendingIdentity = await handle.stat({ bigint: true });
        if (!pendingIdentity.isFile() || pendingIdentity.nlink !== 1n) {
          throw new Error('HOST_OPERATION_LOCK_OWNERSHIP_CHANGED');
        }
      } finally {
        await handle.close();
      }
      const beforeRename = await fileSystem.lstat(currentDirectory, { bigint: true });
      const beforeRenameMarker = await readExactMarker(currentOwnerFile, fileSystem);
      if (!sameDirectoryIdentity(directoryIdentity, beforeRename)
          || !sameFileIdentity(ownerIdentity, beforeRenameMarker.identity)
          || beforeRenameMarker.marker !== ownerMarker) {
        throw new Error('HOST_OPERATION_LOCK_OWNERSHIP_CHANGED');
      }
      await fileSystem.link(pendingMarker, retainedFile);
      published = true;
      await syncDirectory(currentDirectory, fileSystem, platform);
      const afterPublish = await fileSystem.lstat(currentDirectory, { bigint: true });
      const afterPublishMarker = await readExactMarker(retainedFile, fileSystem, 2n);
      const afterPublishAuthority = await readExactMarker(pendingMarker, fileSystem, 2n);
      if (!sameDirectoryIdentity(directoryIdentity, afterPublish)
          || !sameFileIdentity(pendingIdentity, afterPublishMarker.identity)
          || !sameFileIdentity(afterPublishAuthority.identity, afterPublishMarker.identity)
          || afterPublishMarker.marker !== persistentMarker
          || afterPublishAuthority.marker !== persistentMarker) {
        throw new Error('HOST_OPERATION_LOCK_OWNERSHIP_CHANGED');
      }
      assertExactEntries(await exactDirectoryEntries(currentDirectory, fileSystem),
        completionPhaseFile
          ? [OWNER_FILE, RETAINED_AUTHORITY_FILE, RETAINED_FILE, completionPhaseFile]
          : [OWNER_FILE, RETAINED_AUTHORITY_FILE, RETAINED_FILE]);
      state = 'retained';
      return completeRetained;
    } catch (error) {
      let retentionError = error;
      let misplacedMarkerCleanupError;
      let currentAtPath;
      try {
        currentAtPath = await fileSystem.lstat(currentDirectory, { bigint: true });
      } catch {}
      if (!currentAtPath || !sameDirectoryIdentity(directoryIdentity, currentAtPath)) {
        retentionError = new Error('HOST_OPERATION_LOCK_OWNERSHIP_CHANGED', {
          cause: error,
        });
        if (!published && pendingIdentity) {
          try {
            await discardExactMarkerPath({
              directory: currentDirectory,
              expectedIdentity: pendingIdentity,
              expectedMarker: persistentMarker,
              fileSystem,
              markerFile: pendingMarker,
              platform,
            });
          } catch (failure) {
            misplacedMarkerCleanupError = failure;
          }
        }
      }
      const exactAuthority = !published
        ? await readExactMarker(pendingMarker, fileSystem).catch(() => null)
        : null;
      state = published
        ? 'retained'
        : (exactAuthority?.marker === persistentMarker ? 'owned' : 'failed');
      throw combineErrors(
        retentionError,
        misplacedMarkerCleanupError,
        'Host operation retention rejected a foreign directory and cleanup was incomplete',
      );
    }
  };
  release.lockDirectory = resolvedDirectory;
  return release;
}

async function resumeRetainedPublication({
  currentDirectory,
  expectedOperation,
  fileSystem,
  platform,
}) {
  const entries = await exactDirectoryEntries(currentDirectory, fileSystem);
  if (entries.includes(RETAINED_FILE)) return;
  const completionPhaseFiles = ['completion-intent', 'completion-authority']
    .filter((entry) => entries.includes(entry));
  if (completionPhaseFiles.length > 1) {
    throw new Error('HOST_OPERATION_LOCK_OWNERSHIP_CHANGED');
  }
  const [completionPhaseFile] = completionPhaseFiles;
  assertExactEntries(entries, completionPhaseFile
    ? [OWNER_FILE, RETAINED_AUTHORITY_FILE, completionPhaseFile]
    : [OWNER_FILE, RETAINED_AUTHORITY_FILE]);
  const directoryIdentity = await fileSystem.lstat(currentDirectory, { bigint: true });
  if (!directoryIdentity.isDirectory()) {
    throw new Error('HOST_OPERATION_LOCK_OWNERSHIP_CHANGED');
  }
  const authorityFile = path.join(currentDirectory, RETAINED_AUTHORITY_FILE);
  const authority = await readExactMarker(authorityFile, fileSystem);
  const record = retainedRecord(authority.marker, expectedOperation);
  const ownerFile = path.join(currentDirectory, OWNER_FILE);
  const owner = await readExactMarker(ownerFile, fileSystem);
  if (owner.marker !== activeMarker(expectedOperation, record.ownerPid)) {
    throw new Error('HOST_OPERATION_LOCK_OWNERSHIP_CHANGED');
  }
  if (completionPhaseFile) {
    const proof = await readExactMarker(
      path.join(currentDirectory, completionPhaseFile), fileSystem,
    );
    if (proof.marker !== completionMarker(
      expectedOperation, record.ownerPid, directoryIdentity,
    )) {
      throw new Error('HOST_OPERATION_LOCK_OWNERSHIP_CHANGED');
    }
  }
  const authorityHandle = await fileSystem.open(authorityFile, 'r+');
  try {
    const opened = await authorityHandle.stat({ bigint: true });
    if (!sameFileIdentity(authority.identity, opened)) {
      throw new Error('HOST_OPERATION_LOCK_OWNERSHIP_CHANGED');
    }
    await authorityHandle.sync();
  } finally {
    await authorityHandle.close();
  }
  const beforePublishDirectory = await fileSystem.lstat(currentDirectory, { bigint: true });
  const beforePublishAuthority = await readExactMarker(authorityFile, fileSystem);
  const beforePublishOwner = await readExactMarker(ownerFile, fileSystem);
  if (!sameDirectoryIdentity(directoryIdentity, beforePublishDirectory)
      || !sameFileIdentity(authority.identity, beforePublishAuthority.identity)
      || !sameFileIdentity(owner.identity, beforePublishOwner.identity)
      || beforePublishAuthority.marker !== authority.marker
      || beforePublishOwner.marker !== owner.marker) {
    throw new Error('HOST_OPERATION_LOCK_OWNERSHIP_CHANGED');
  }
  assertExactEntries(await exactDirectoryEntries(currentDirectory, fileSystem),
    completionPhaseFile
      ? [OWNER_FILE, RETAINED_AUTHORITY_FILE, completionPhaseFile]
      : [OWNER_FILE, RETAINED_AUTHORITY_FILE]);
  const retainedFile = path.join(currentDirectory, RETAINED_FILE);
  await fileSystem.link(authorityFile, retainedFile);
  await syncDirectory(currentDirectory, fileSystem, platform);
  const published = await readExactMarker(retainedFile, fileSystem, 2n);
  const durableAuthority = await readExactMarker(authorityFile, fileSystem, 2n);
  if (!sameFileIdentity(authority.identity, published.identity)
      || !sameFileIdentity(durableAuthority.identity, published.identity)
      || published.marker !== authority.marker
      || durableAuthority.marker !== authority.marker) {
    throw new Error('HOST_OPERATION_LOCK_OWNERSHIP_CHANGED');
  }
}

export async function openRetainedHostOperationLock({
  environment = process.env,
  expectedOperation,
  fileSystem = fsp,
  lockDirectory,
  platform = process.platform,
} = {}) {
  if (!SAFE_OPERATION.test(expectedOperation || '')) {
    const error = new Error('Retained host operation lock requires one expected operation code');
    error.exitCode = 2;
    throw error;
  }
  const resolvedDirectory = resolveLockDirectory({ environment, lockDirectory });
  let canonicalIdentity;
  try {
    canonicalIdentity = await fileSystem.lstat(resolvedDirectory, { bigint: true });
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  const pending = await pendingCompletionDirectories(
    resolvedDirectory, fileSystem, platform,
  );
  if ((canonicalIdentity && pending.length) || pending.length > 1) {
    throw new Error('HOST_OPERATION_LOCK_OWNERSHIP_CHANGED');
  }
  let currentDirectory = canonicalIdentity ? resolvedDirectory : pending[0];
  if (!currentDirectory) {
    const error = new Error(`ENOENT: HOST_OPERATION_LOCK_RETAINED_NOT_FOUND: ${resolvedDirectory}`);
    error.code = 'ENOENT';
    throw error;
  }
  const ownerFile = path.join(currentDirectory, OWNER_FILE);
  const retainedFile = path.join(currentDirectory, RETAINED_FILE);
  const retainedAuthorityFile = path.join(currentDirectory, RETAINED_AUTHORITY_FILE);
  const directoryIdentity = await fileSystem.lstat(currentDirectory, { bigint: true });
  if (!directoryIdentity.isDirectory()
      || (canonicalIdentity
        && !sameDirectoryIdentity(canonicalIdentity, directoryIdentity))) {
    throw new Error('HOST_OPERATION_LOCK_OWNERSHIP_CHANGED');
  }
  let exactAuthority;
  let exactMarker;
  let exactOwner;
  let record;
  try {
    await resumeRetainedPublication({
      currentDirectory,
      expectedOperation,
      fileSystem,
      platform,
    });
    exactMarker = await readExactMarker(retainedFile, fileSystem, 2n);
    exactAuthority = await readExactMarker(retainedAuthorityFile, fileSystem, 2n);
    if (!sameFileIdentity(exactMarker.identity, exactAuthority.identity)
        || exactMarker.marker !== exactAuthority.marker) {
      throw new Error('HOST_OPERATION_LOCK_OWNERSHIP_CHANGED');
    }
    record = retainedRecord(exactMarker.marker, expectedOperation);
    exactOwner = await readExactMarker(ownerFile, fileSystem);
    if (exactOwner.marker !== activeMarker(expectedOperation, record.ownerPid)) {
      throw new Error('HOST_OPERATION_LOCK_OWNERSHIP_CHANGED');
    }
    const entries = await exactDirectoryEntries(currentDirectory, fileSystem);
    const completionPhaseFiles = ['completion-intent', 'completion-authority']
      .filter((entry) => entries.includes(entry));
    if (completionPhaseFiles.length > 1) {
      throw new Error('HOST_OPERATION_LOCK_OWNERSHIP_CHANGED');
    }
    const [completionPhaseFile] = completionPhaseFiles;
    assertExactEntries(entries, completionPhaseFile
      ? [OWNER_FILE, RETAINED_AUTHORITY_FILE, RETAINED_FILE, completionPhaseFile]
      : [OWNER_FILE, RETAINED_AUTHORITY_FILE, RETAINED_FILE]);
    if (completionPhaseFile) {
      const proof = await readExactMarker(
        path.join(currentDirectory, completionPhaseFile), fileSystem,
      );
      if (proof.marker !== completionMarker(
        expectedOperation, record.ownerPid, directoryIdentity,
      )) {
        throw new Error('HOST_OPERATION_LOCK_OWNERSHIP_CHANGED');
      }
    }
    const finalIdentity = await fileSystem.lstat(currentDirectory, { bigint: true });
    if (!sameDirectoryIdentity(directoryIdentity, finalIdentity)) {
      throw new Error('HOST_OPERATION_LOCK_OWNERSHIP_CHANGED');
    }
  } catch (error) {
    let finalIdentity;
    try {
      finalIdentity = await fileSystem.lstat(currentDirectory, { bigint: true });
    } catch {}
    if (!finalIdentity || !sameDirectoryIdentity(directoryIdentity, finalIdentity)) {
      throw new Error('HOST_OPERATION_LOCK_OWNERSHIP_CHANGED', { cause: error });
    }
    throw error;
  }
  let state = 'open';
  const release = async () => {
    if (state !== 'open') {
      throw new Error(`HOST_OPERATION_LOCK_NOT_OPEN: ${resolvedDirectory}`);
    }
    state = 'releasing';
    try {
      const finalized = await finalizeOwnedDirectory({
        currentDirectory,
        directoryIdentity,
        fileSystem,
        operation: expectedOperation,
        ownerIdentity: exactOwner.identity,
        ownerMarker: exactOwner.marker,
        ownerPid: record.ownerPid,
        platform,
        retainedAuthorityIdentity: exactAuthority.identity,
        retainedIdentity: exactMarker.identity,
        retainedMarker: exactMarker.marker,
        resolvedDirectory,
      });
      currentDirectory = finalized.currentDirectory;
      state = 'released';
    } catch (error) {
      const retryLocations = await pendingCompletionDirectories(
        resolvedDirectory, fileSystem, platform,
      ).catch(() => []);
      if (retryLocations.length === 1) currentDirectory = retryLocations[0];
      state = 'open';
      throw error;
    }
  };
  return {
    ...record,
    complete: release,
    lockDirectory: resolvedDirectory,
    release,
  };
}

export async function releaseHostOperationLock(release, timeoutMs) {
  await boundedLockAction(release, timeoutMs, 'Host operation lock release');
}

export async function retainHostOperationLock(release, timeoutMs, evidence) {
  if (typeof release?.retain !== 'function') {
    throw new Error('Host operation lock adapter does not support retention');
  }
  return boundedLockAction(
    () => release.retain(evidence),
    timeoutMs,
    'Host operation lock retention',
  );
}
