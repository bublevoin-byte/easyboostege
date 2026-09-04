import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { movePosixDirectoryNoReplace } from './posix-session-supervisor.js';

export const STAGING_CUTOVER_HOST_LOCK_PROTOCOL =
  'easyboost-staging-cutover-host-lock-v1';
export const STAGING_CUTOVER_HOST_LOCK_CAPABILITY_PROTOCOL =
  'easyboost-staging-cutover-host-lock-capability-v1';

const ENTRY_PROTOCOL = 'immutable-archive-v4';
const OPERATION = 'staging-cutover';
const OWNER_FILE = 'owner.json';
const SHA = /^[a-f0-9]{64}$/u;
const LEGACY_APP_MODE = /^(?:700|755)$/u;
const LEGACY_MARKER_MODE = /^(?:600|644)$/u;
const LEGACY_COMPOSE_MODE = /^(?:600|644|664)$/u;
const START_TIME = /^[1-9][0-9]*$/u;
const BOOT_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const ADOPTION_FILE = /^claim-([a-f0-9]{64})\.json$/u;
const MAX_CHAIN_LENGTH = 32;
const MAX_RECORD_BYTES = 8 * 1024;
const MAX_CAPABILITY_BYTES = 16 * 1024;
const MAX_PATH_BYTES = 4 * 1024;

function canonicalJson(value) {
  return `${JSON.stringify(value)}\n`;
}

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

function permissions(identity) {
  return Number(typeof identity.mode === 'bigint'
    ? identity.mode & 0o777n : identity.mode & 0o777);
}

function sameIdentity(left, right) {
  return String(left?.dev) === String(right?.dev)
    && String(left?.ino) === String(right?.ino);
}

function identityRecord(identity) {
  return Object.freeze({ dev: String(identity.dev), ino: String(identity.ino) });
}

function lockError(message, exitCode = 70, code = 'STAGING_CUTOVER_HOST_LOCK_INVALID') {
  const error = new Error(message);
  error.code = code;
  error.exitCode = exitCode;
  return error;
}

function locked(lockDirectory) {
  return lockError(`HOST_OPERATION_LOCKED: ${lockDirectory}`, 75,
    'HOST_OPERATION_LOCKED');
}

function exactAbsolutePath(value, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value)
      || path.resolve(value) !== value || Buffer.byteLength(value, 'utf8') > MAX_PATH_BYTES
      || path.dirname(value) === value) {
    throw lockError(`${label} is invalid`, 64);
  }
  return value;
}

function exactBinding(value) {
  if (!exactKeys(value, [
    'appDirectory', 'bridgeSha256', 'bundleSha256', 'entryProtocol', 'journalPath',
    'legacyAppMode', 'legacyAuthoritySha256', 'legacyComposeMode', 'legacyComposeSha256',
    'legacyMarkerMode', 'legacyMarkerSha256', 'nonce', 'operation',
  ]) || value.entryProtocol !== ENTRY_PROTOCOL || value.operation !== OPERATION
      || value.appDirectory !== exactAbsolutePath(value.appDirectory, 'staging cutover app directory')
      || value.journalPath !== path.join(value.appDirectory, '.staging-recovery-required')
      || !SHA.test(value.nonce ?? '') || !SHA.test(value.bridgeSha256 ?? '')
      || !SHA.test(value.legacyMarkerSha256 ?? '')
      || !SHA.test(value.legacyComposeSha256 ?? '')
      || !SHA.test(value.legacyAuthoritySha256 ?? '')
      || !LEGACY_APP_MODE.test(value.legacyAppMode ?? '')
      || !LEGACY_MARKER_MODE.test(value.legacyMarkerMode ?? '')
      || !LEGACY_COMPOSE_MODE.test(value.legacyComposeMode ?? '')
      || (value.legacyComposeMode === '664' && value.legacyAppMode !== '700')
      || !SHA.test(value.bundleSha256 ?? '')) {
    throw lockError('staging cutover host-lock journal binding is invalid', 64);
  }
  return Object.freeze({
    appDirectory: value.appDirectory,
    bridgeSha256: value.bridgeSha256,
    bundleSha256: value.bundleSha256,
    entryProtocol: ENTRY_PROTOCOL,
    journalPath: value.journalPath,
    legacyAppMode: value.legacyAppMode,
    legacyAuthoritySha256: value.legacyAuthoritySha256,
    legacyComposeMode: value.legacyComposeMode,
    legacyComposeSha256: value.legacyComposeSha256,
    legacyMarkerMode: value.legacyMarkerMode,
    legacyMarkerSha256: value.legacyMarkerSha256,
    nonce: value.nonce,
    operation: OPERATION,
  });
}

function bindingFromOptions({
  appDirectory,
  bridgeSha256,
  bundleSha256,
  legacyAppMode,
  legacyAuthoritySha256,
  legacyComposeMode,
  legacyComposeSha256,
  legacyMarkerMode,
  legacyMarkerSha256,
  nonce,
}) {
  const exactAppDirectory = exactAbsolutePath(appDirectory, 'staging cutover app directory');
  return exactBinding({
    appDirectory: exactAppDirectory,
    bridgeSha256,
    bundleSha256,
    entryProtocol: ENTRY_PROTOCOL,
    journalPath: path.join(exactAppDirectory, '.staging-recovery-required'),
    legacyAppMode,
    legacyAuthoritySha256,
    legacyComposeMode,
    legacyComposeSha256,
    legacyMarkerMode,
    legacyMarkerSha256,
    nonce,
    operation: OPERATION,
  });
}

function sameBinding(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function readLinuxBootId(filesystem = fs) {
  const value = filesystem.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
  if (!BOOT_ID.test(value)) {
    throw lockError('Linux boot identity is invalid');
  }
  return value;
}

function readLinuxProcessStat(processId, filesystem = fs) {
  const value = filesystem.readFileSync(`/proc/${processId}/stat`, 'utf8');
  const commandEnd = value.lastIndexOf(')');
  const firstSpace = value.indexOf(' ');
  if (commandEnd < firstSpace || firstSpace < 1) {
    throw lockError('Linux process identity is invalid');
  }
  const parsedPid = Number(value.slice(0, firstSpace));
  const fields = value.slice(commandEnd + 1).trim().split(/\s+/u);
  const parentPid = Number(fields[1]);
  const startTime = fields[19];
  if (parsedPid !== processId || !Number.isSafeInteger(parentPid) || parentPid < 0
      || !START_TIME.test(startTime ?? '')) {
    throw lockError('Linux process identity is invalid');
  }
  return Object.freeze({ parentPid, startTime });
}

function exactOwner(value) {
  if (!exactKeys(value, ['bootId', 'pid', 'startTime', 'userId'])
      || !BOOT_ID.test(value.bootId ?? '')
      || !Number.isSafeInteger(value.pid) || value.pid < 1
      || !START_TIME.test(value.startTime ?? '')
      || !/^(?:0|[1-9][0-9]*)$/u.test(value.userId ?? '')) {
    throw lockError('staging cutover host-lock owner identity is invalid');
  }
  return Object.freeze({
    bootId: value.bootId,
    pid: value.pid,
    startTime: value.startTime,
    userId: value.userId,
  });
}

function captureOwner({
  filesystem,
  ownerPid,
  readBootId,
  readProcessStat,
  userId,
}) {
  if (!Number.isSafeInteger(ownerPid) || ownerPid < 1
      || !Number.isSafeInteger(userId) || userId < 0) {
    throw lockError('staging cutover host-lock caller identity is invalid', 64);
  }
  const visited = new Set();
  let currentPid = process.pid;
  for (let depth = 0; depth < 32; depth += 1) {
    if (!Number.isSafeInteger(currentPid) || currentPid < 1 || visited.has(currentPid)) {
      break;
    }
    visited.add(currentPid);
    const processPath = `/proc/${currentPid}`;
    const before = filesystem.lstatSync(processPath, { bigint: true });
    if (!before.isDirectory() || String(before.uid) !== String(userId)) {
      throw lockError('staging cutover host-lock caller ancestry is not owned');
    }
    const snapshot = readProcessStat(currentPid, filesystem);
    const after = filesystem.lstatSync(processPath, { bigint: true });
    const confirmed = readProcessStat(currentPid, filesystem);
    if (!sameIdentity(before, after) || String(after.uid) !== String(userId)
        || snapshot.parentPid !== confirmed.parentPid
        || snapshot.startTime !== confirmed.startTime) {
      throw lockError('staging cutover host-lock caller ancestry changed');
    }
    if (currentPid === ownerPid) {
      const bootId = readBootId(filesystem);
      if (readBootId(filesystem) !== bootId) {
        throw lockError('staging cutover host-lock boot identity changed');
      }
      return exactOwner({
        bootId,
        pid: ownerPid,
        startTime: snapshot.startTime,
        userId: String(userId),
      });
    }
    currentPid = snapshot.parentPid;
  }
  throw lockError('staging cutover host-lock owner is not a bounded caller ancestor');
}

function sameOwner(left, right) {
  return left.bootId === right.bootId && left.pid === right.pid
    && left.startTime === right.startTime && left.userId === right.userId;
}

function ownerState(owner, {
  filesystem,
  readBootId,
  readProcessStat,
}) {
  const bootId = readBootId(filesystem);
  if (bootId !== owner.bootId) return 'dead';
  let processDirectory;
  try {
    processDirectory = filesystem.lstatSync(`/proc/${owner.pid}`, { bigint: true });
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ESRCH') return 'dead';
    throw lockError('staging cutover host-lock owner liveness is unknown');
  }
  if (!processDirectory.isDirectory()
      || String(processDirectory.uid) !== owner.userId) return 'dead';
  let snapshot;
  try {
    snapshot = readProcessStat(owner.pid, filesystem);
    const confirmed = readProcessStat(owner.pid, filesystem);
    if (snapshot.parentPid !== confirmed.parentPid
        || snapshot.startTime !== confirmed.startTime) {
      throw lockError('staging cutover host-lock owner identity changed');
    }
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ESRCH') return 'dead';
    throw lockError('staging cutover host-lock owner liveness is unknown');
  }
  return snapshot.startTime === owner.startTime ? 'live' : 'dead';
}

function safeDirectory(directory, {
  expectedIdentity,
  expectedMode,
  filesystem,
  userId,
} = {}) {
  const before = filesystem.lstatSync(directory, { bigint: true });
  if (!before.isDirectory() || before.isSymbolicLink()
      || String(before.uid) !== String(userId)
      || (expectedMode !== undefined && permissions(before) !== expectedMode)
      || (expectedIdentity && !sameIdentity(before, expectedIdentity))) {
    throw lockError('staging cutover host-lock directory identity is unsafe');
  }
  const descriptor = filesystem.openSync(directory,
    filesystem.constants.O_RDONLY | filesystem.constants.O_DIRECTORY
      | filesystem.constants.O_NOFOLLOW);
  try {
    const opened = filesystem.fstatSync(descriptor, { bigint: true });
    const after = filesystem.lstatSync(directory, { bigint: true });
    if (!sameIdentity(before, opened) || !sameIdentity(opened, after)) {
      throw lockError('staging cutover host-lock directory changed while opening');
    }
  } finally {
    filesystem.closeSync(descriptor);
  }
  return before;
}

function boundedDirectoryNames(directory, expectedIdentity, options, maximumEntries) {
  const { descriptorDirectoryPath, filesystem, userId } = options;
  if (!Number.isSafeInteger(maximumEntries) || maximumEntries < 0
      || typeof descriptorDirectoryPath !== 'function') {
    throw lockError('staging cutover host-lock inventory bound is invalid');
  }
  const before = safeDirectory(directory, {
    expectedIdentity, expectedMode: 0o700, filesystem, userId,
  });
  const descriptor = filesystem.openSync(directory,
    filesystem.constants.O_RDONLY | filesystem.constants.O_DIRECTORY
      | filesystem.constants.O_NOFOLLOW);
  let inventory;
  try {
    const opened = filesystem.fstatSync(descriptor, { bigint: true });
    if (!sameIdentity(before, opened)) {
      throw lockError('staging cutover host-lock directory changed before inventory');
    }
    inventory = filesystem.opendirSync(descriptorDirectoryPath(descriptor, directory));
    const names = [];
    for (let entry = inventory.readSync(); entry !== null; entry = inventory.readSync()) {
      if (names.length >= maximumEntries) {
        throw lockError('staging cutover host-lock directory exceeds its entry bound');
      }
      if (Buffer.byteLength(entry.name, 'utf8') < 1
          || Buffer.byteLength(entry.name, 'utf8') > 255
          || /[\u0000-\u001f\u007f-\u009f]/u.test(entry.name)) {
        throw lockError('staging cutover host-lock directory contains a noncanonical name');
      }
      names.push(entry.name);
    }
    inventory.closeSync();
    inventory = undefined;
    const afterRead = filesystem.fstatSync(descriptor, { bigint: true });
    const finalPath = filesystem.lstatSync(directory, { bigint: true });
    if (!sameIdentity(opened, afterRead) || !sameIdentity(opened, finalPath)) {
      throw lockError('staging cutover host-lock directory changed during inventory');
    }
    return names.sort();
  } finally {
    if (inventory !== undefined) inventory.closeSync();
    filesystem.closeSync(descriptor);
  }
}

function safeParent(lockDirectory, { filesystem, userId }) {
  const parent = path.dirname(lockDirectory);
  const identity = safeDirectory(parent, { filesystem, userId });
  if ((permissions(identity) & 0o022) !== 0) {
    throw lockError('staging cutover host-lock parent is writable by another principal');
  }
  return identity;
}

function syncDirectory(directory, filesystem = fs) {
  const descriptor = filesystem.openSync(directory,
    filesystem.constants.O_RDONLY | filesystem.constants.O_DIRECTORY
      | filesystem.constants.O_NOFOLLOW);
  try {
    filesystem.fsyncSync(descriptor);
  } finally {
    filesystem.closeSync(descriptor);
  }
}

function assertParentUnchanged(lockDirectory, expected, options) {
  const current = safeParent(lockDirectory, options);
  if (!sameIdentity(current, expected)) {
    throw lockError('staging cutover host-lock parent changed');
  }
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function initialCandidateDirectory(lockDirectory) {
  return `${lockDirectory}.preparing`;
}

function adoptionCandidateDirectory(lockDirectory, predecessorSha256) {
  return `${lockDirectory}.claim-${predecessorSha256}.preparing`;
}

function safeRecordFile(file, {
  allowedLinks,
  expectedIdentity,
  filesystem,
  userId,
}) {
  const before = filesystem.lstatSync(file, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink()
      || String(before.uid) !== String(userId) || permissions(before) !== 0o600
      || !allowedLinks.includes(Number(before.nlink))
      || (expectedIdentity && !sameIdentity(before, expectedIdentity))
      || before.size < 1n || before.size > BigInt(MAX_RECORD_BYTES)) {
    throw lockError('staging cutover host-lock record identity is unsafe');
  }
  const descriptor = filesystem.openSync(file,
    filesystem.constants.O_RDONLY | filesystem.constants.O_NOFOLLOW);
  let bytes;
  try {
    const opened = filesystem.fstatSync(descriptor, { bigint: true });
    if (!sameIdentity(before, opened)) {
      throw lockError('staging cutover host-lock record changed while opening');
    }
    bytes = filesystem.readFileSync(descriptor);
    const afterRead = filesystem.fstatSync(descriptor, { bigint: true });
    if (!sameIdentity(opened, afterRead) || BigInt(bytes.length) !== opened.size) {
      throw lockError('staging cutover host-lock record changed while reading');
    }
  } finally {
    filesystem.closeSync(descriptor);
  }
  const after = filesystem.lstatSync(file, { bigint: true });
  if (!sameIdentity(before, after) || !allowedLinks.includes(Number(after.nlink))) {
    throw lockError('staging cutover host-lock record path changed');
  }
  return Object.freeze({ bytes, identity: after });
}

function writeRecordFile(file, bytes, { filesystem, userId }) {
  const descriptor = filesystem.openSync(file,
    filesystem.constants.O_WRONLY | filesystem.constants.O_CREAT
      | filesystem.constants.O_EXCL | filesystem.constants.O_NOFOLLOW,
    0o600);
  let identity;
  try {
    filesystem.writeFileSync(descriptor, bytes);
    filesystem.fsyncSync(descriptor);
    identity = filesystem.fstatSync(descriptor, { bigint: true });
  } finally {
    filesystem.closeSync(descriptor);
  }
  const current = safeRecordFile(file, {
    allowedLinks: [1], expectedIdentity: identity, filesystem, userId,
  });
  if (!current.bytes.equals(bytes)) {
    throw lockError('staging cutover host-lock record bytes changed after publication');
  }
  return current.identity;
}

function exactRecord(value) {
  if (!exactKeys(value, [
    'binding', 'kind', 'owner', 'predecessorSha256', 'protocol', 'publicationSource',
  ]) || value.protocol !== STAGING_CUTOVER_HOST_LOCK_PROTOCOL
      || !['INITIAL', 'ADOPTION'].includes(value.kind)
      || (value.kind === 'INITIAL') !== (value.predecessorSha256 === null)
      || (value.kind === 'INITIAL') !== (value.publicationSource === null)
      || (value.kind === 'ADOPTION' && !SHA.test(value.predecessorSha256 ?? ''))
      || (value.kind === 'ADOPTION'
        && (typeof value.publicationSource !== 'string'
          || !path.isAbsolute(value.publicationSource)
          || path.resolve(value.publicationSource) !== value.publicationSource
          || Buffer.byteLength(value.publicationSource, 'utf8') > MAX_PATH_BYTES))) {
    throw lockError('staging cutover host-lock record is invalid');
  }
  return Object.freeze({
    binding: exactBinding(value.binding),
    kind: value.kind,
    owner: exactOwner(value.owner),
    predecessorSha256: value.predecessorSha256,
    protocol: STAGING_CUTOVER_HOST_LOCK_PROTOCOL,
    publicationSource: value.publicationSource,
  });
}

function recordBytes(record) {
  return Buffer.from(canonicalJson(exactRecord(record)));
}

function readRecord(file, options) {
  const stable = safeRecordFile(file, { ...options, allowedLinks: [1, 2] });
  let parsed;
  try {
    parsed = JSON.parse(stable.bytes.toString('utf8'));
  } catch {
    throw lockError('staging cutover host-lock record is not JSON');
  }
  const record = exactRecord(parsed);
  if (!stable.bytes.equals(recordBytes(record))) {
    throw lockError('staging cutover host-lock record is not canonical');
  }
  return Object.freeze({
    bytes: stable.bytes,
    identity: stable.identity,
    record,
    sha256: sha256(stable.bytes),
  });
}

function adoptionSourceDirectory(lockDirectory, predecessorSha256, source) {
  const directory = path.dirname(source);
  if (directory !== adoptionCandidateDirectory(lockDirectory, predecessorSha256)
      || path.basename(source) !== 'claim.json') {
    throw lockError('staging cutover host-lock adoption source is invalid');
  }
  return directory;
}

function settleAdoptionPublication(
  lockDirectory,
  publicationLockDirectory,
  claim,
  options,
) {
  const { filesystem, userId } = options;
  const sourceDirectory = adoptionSourceDirectory(
    publicationLockDirectory,
    claim.record.predecessorSha256,
    claim.record.publicationSource,
  );
  const source = claim.record.publicationSource;
  const links = Number(claim.identity.nlink);
  let sourceIdentity;
  let sourceDirectoryIdentity;
  try {
    sourceIdentity = filesystem.lstatSync(source, { bigint: true });
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (sourceIdentity !== undefined) {
    sourceDirectoryIdentity = safeDirectory(sourceDirectory, {
      expectedMode: 0o700, filesystem, userId,
    });
    const sourceNames = boundedDirectoryNames(
      sourceDirectory, sourceDirectoryIdentity, options, 1,
    );
    if (sourceNames.length !== 1 || sourceNames[0] !== path.basename(source)) {
      throw lockError('staging cutover host-lock adoption source contains foreign entries');
    }
    if (!sameIdentity(sourceIdentity, claim.identity) || links !== 2) {
      throw lockError('staging cutover host-lock adoption source changed');
    }
    syncDirectory(lockDirectory, filesystem);
    filesystem.unlinkSync(source);
    syncDirectory(sourceDirectory, filesystem);
  } else if (links !== 1) {
    throw lockError('staging cutover host-lock adoption link authority is incomplete');
  }
  try {
    sourceDirectoryIdentity = safeDirectory(sourceDirectory, {
      expectedMode: 0o700, filesystem, userId,
    });
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (sourceDirectoryIdentity !== undefined) {
    if (boundedDirectoryNames(sourceDirectory, sourceDirectoryIdentity, options, 1).length !== 0) {
      throw lockError('staging cutover host-lock adoption source contains foreign entries');
    }
    filesystem.rmdirSync(sourceDirectory);
    syncDirectory(path.dirname(lockDirectory), filesystem);
  }
  const settled = safeRecordFile(claim.file, {
    allowedLinks: [1], expectedIdentity: claim.identity, filesystem, userId,
  });
  if (!settled.bytes.equals(claim.bytes)) {
    throw lockError('staging cutover host-lock adoption changed while settling');
  }
  return Object.freeze({ ...claim, identity: settled.identity });
}

function readChain(lockDirectory, expectedBinding, options, {
  publicationLockDirectory = lockDirectory,
} = {}) {
  const { filesystem, userId } = options;
  const directoryIdentity = safeDirectory(lockDirectory, {
    expectedMode: 0o700, filesystem, userId,
  });
  const actualNames = boundedDirectoryNames(
    lockDirectory, directoryIdentity, options, MAX_CHAIN_LENGTH + 2,
  );
  const claims = [];
  let current = readRecord(path.join(lockDirectory, OWNER_FILE), options);
  if (current.record.kind !== 'INITIAL' || !sameBinding(current.record.binding, expectedBinding)) {
    throw lockError('staging cutover host-lock belongs to another journal');
  }
  current = Object.freeze({ ...current, file: path.join(lockDirectory, OWNER_FILE) });
  claims.push(current);
  for (let index = 1; index < MAX_CHAIN_LENGTH; index += 1) {
    const nextFile = path.join(lockDirectory, `claim-${current.sha256}.json`);
    let exists = true;
    try {
      filesystem.lstatSync(nextFile);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      exists = false;
    }
    if (!exists) break;
    let next = readRecord(nextFile, options);
    next = Object.freeze({ ...next, file: nextFile });
    if (next.record.kind !== 'ADOPTION'
        || next.record.predecessorSha256 !== current.sha256
        || !sameBinding(next.record.binding, expectedBinding)) {
      throw lockError('staging cutover host-lock adoption chain is invalid');
    }
    next = settleAdoptionPublication(lockDirectory, publicationLockDirectory, next, options);
    claims.push(next);
    current = next;
  }
  const expectedNames = claims.map((claim) => path.basename(claim.file)).sort();
  if (claims.length === MAX_CHAIN_LENGTH
      || JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
    throw lockError('staging cutover host-lock contains foreign or excessive state');
  }
  const after = safeDirectory(lockDirectory, {
    expectedIdentity: directoryIdentity, expectedMode: 0o700, filesystem, userId,
  });
  return Object.freeze({ claims: Object.freeze(claims), current, directoryIdentity: after });
}

function exactCapability(value) {
  if (!exactKeys(value, [
    'binding', 'claimIdentity', 'claimPath', 'claimSha256', 'directoryIdentity',
    'lockDirectory', 'owner', 'protocol',
  ]) || value.protocol !== STAGING_CUTOVER_HOST_LOCK_CAPABILITY_PROTOCOL
      || !exactKeys(value.claimIdentity, ['dev', 'ino'])
      || !exactKeys(value.directoryIdentity, ['dev', 'ino'])
      || !/^(?:0|[1-9][0-9]*)$/u.test(value.claimIdentity.dev ?? '')
      || !/^(?:0|[1-9][0-9]*)$/u.test(value.claimIdentity.ino ?? '')
      || !/^(?:0|[1-9][0-9]*)$/u.test(value.directoryIdentity.dev ?? '')
      || !/^(?:0|[1-9][0-9]*)$/u.test(value.directoryIdentity.ino ?? '')
      || !SHA.test(value.claimSha256 ?? '')) {
    throw lockError('staging cutover host-lock capability is invalid', 64);
  }
  const lockDirectory = exactAbsolutePath(
    value.lockDirectory, 'staging cutover host-lock capability path',
  );
  const claimPath = exactAbsolutePath(
    value.claimPath, 'staging cutover host-lock capability claim',
  );
  if (path.dirname(claimPath) !== lockDirectory
      || (path.basename(claimPath) !== OWNER_FILE
        && !ADOPTION_FILE.test(path.basename(claimPath)))) {
    throw lockError('staging cutover host-lock capability scope is invalid', 64);
  }
  return Object.freeze({
    binding: exactBinding(value.binding),
    claimIdentity: Object.freeze({ ...value.claimIdentity }),
    claimPath,
    claimSha256: value.claimSha256,
    directoryIdentity: Object.freeze({ ...value.directoryIdentity }),
    lockDirectory,
    owner: exactOwner(value.owner),
    protocol: STAGING_CUTOVER_HOST_LOCK_CAPABILITY_PROTOCOL,
  });
}

function capabilityFromChain(lockDirectory, chain) {
  return exactCapability({
    binding: chain.current.record.binding,
    claimIdentity: identityRecord(chain.current.identity),
    claimPath: chain.current.file,
    claimSha256: chain.current.sha256,
    directoryIdentity: identityRecord(chain.directoryIdentity),
    lockDirectory,
    owner: chain.current.record.owner,
    protocol: STAGING_CUTOVER_HOST_LOCK_CAPABILITY_PROTOCOL,
  });
}

function parseCapability(serialized) {
  if (typeof serialized !== 'string' || serialized.length < 1
      || Buffer.byteLength(serialized, 'utf8') > MAX_CAPABILITY_BYTES) {
    throw lockError('staging cutover host-lock capability payload is invalid', 64);
  }
  let value;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw lockError('staging cutover host-lock capability payload is not JSON', 64);
  }
  return exactCapability(value);
}

function cleanupPrivateCandidate(directory, expectedIdentity, expectedFile, options) {
  const { filesystem, userId } = options;
  let current;
  try {
    current = safeDirectory(directory, {
      expectedIdentity, expectedMode: 0o700, filesystem, userId,
    });
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  const names = boundedDirectoryNames(directory, current, options, 1);
  const expectedNames = expectedFile ? [expectedFile.name] : [];
  if (JSON.stringify(names.sort()) !== JSON.stringify(expectedNames)) {
    throw lockError('staging cutover host-lock private candidate changed');
  }
  if (expectedFile) {
    const file = path.join(directory, expectedFile.name);
    const stable = safeRecordFile(file, {
      allowedLinks: [1], expectedIdentity: expectedFile.identity, filesystem, userId,
    });
    if (!stable.bytes.equals(expectedFile.bytes)) {
      throw lockError('staging cutover host-lock private candidate bytes changed');
    }
    filesystem.unlinkSync(file);
    syncDirectory(directory, filesystem);
  }
  const final = safeDirectory(directory, {
    expectedIdentity: current, expectedMode: 0o700, filesystem, userId,
  });
  if (!sameIdentity(final, expectedIdentity)) {
    throw lockError('staging cutover host-lock private candidate identity changed');
  }
  filesystem.rmdirSync(directory);
  syncDirectory(path.dirname(directory), filesystem);
}

function publishInitial(lockDirectory, binding, owner, options) {
  const { afterPhase, filesystem, noReplacePlatform, runNoReplaceMove, userId } = options;
  const parent = path.dirname(lockDirectory);
  const candidateDirectory = initialCandidateDirectory(lockDirectory);
  let created = false;
  try {
    filesystem.mkdirSync(candidateDirectory, { mode: 0o700 });
    created = true;
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
  const candidateIdentity = safeDirectory(candidateDirectory, {
    expectedMode: 0o700, filesystem, userId,
  });
  if (created) {
    syncDirectory(parent, filesystem);
    afterPhase('after-prepared-directory', Object.freeze({ candidateDirectory }));
  }
  const observedNames = boundedDirectoryNames(candidateDirectory, candidateIdentity, options, 1);
  if (observedNames.length > 1
      || (observedNames.length === 1 && observedNames[0] !== OWNER_FILE)) {
    throw lockError('staging cutover initial candidate contains foreign state');
  }
  const record = exactRecord({
    binding,
    kind: 'INITIAL',
    owner,
    predecessorSha256: null,
    protocol: STAGING_CUTOVER_HOST_LOCK_PROTOCOL,
    publicationSource: null,
  });
  const ownerFile = path.join(candidateDirectory, OWNER_FILE);
  let existingRecord;
  try {
    existingRecord = readRecord(ownerFile, options);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (existingRecord === undefined) {
    try {
      writeRecordFile(ownerFile, recordBytes(record), options);
      afterPhase('after-prepared-record', Object.freeze({ candidateDirectory }));
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      existingRecord = readRecord(ownerFile, options);
    }
  }
  if (existingRecord === undefined) existingRecord = readRecord(ownerFile, options);
  if (existingRecord !== undefined
      && (existingRecord.record.kind !== 'INITIAL'
        || !sameBinding(existingRecord.record.binding, binding))) {
    throw lockError('staging cutover initial candidate belongs to another journal');
  }
  const candidateNames = boundedDirectoryNames(candidateDirectory, candidateIdentity, options, 1);
  if (candidateNames.length !== 1 || candidateNames[0] !== OWNER_FILE) {
    throw lockError('staging cutover initial candidate contains foreign state');
  }
  syncDirectory(candidateDirectory, filesystem);
  safeDirectory(candidateDirectory, {
    expectedIdentity: candidateIdentity, expectedMode: 0o700, filesystem, userId,
  });
  try {
    movePosixDirectoryNoReplace(candidateDirectory, lockDirectory, {
      filesystem,
      platform: noReplacePlatform,
      runMove: runNoReplaceMove,
    });
  } catch (error) {
    let destination;
    try {
      destination = safeDirectory(lockDirectory, {
        expectedMode: 0o700, filesystem, userId,
      });
    } catch {}
    if (destination && sameIdentity(destination, candidateIdentity)) {
      syncDirectory(parent, filesystem);
    } else {
      cleanupPrivateCandidate(candidateDirectory, candidateIdentity, {
        bytes: existingRecord.bytes,
        identity: existingRecord.identity,
        name: OWNER_FILE,
      }, options);
      if (error?.message?.includes('destination already exists')) return null;
      throw error;
    }
  }
  syncDirectory(parent, filesystem);
  afterPhase('after-published-directory', Object.freeze({ lockDirectory }));
  return readChain(lockDirectory, binding, options);
}

function reconcileInitialCandidate(lockDirectory, binding, owner, options) {
  const { filesystem, userId } = options;
  const candidateDirectory = initialCandidateDirectory(lockDirectory);
  let candidateIdentity;
  try {
    candidateIdentity = safeDirectory(candidateDirectory, {
      expectedMode: 0o700, filesystem, userId,
    });
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  const names = boundedDirectoryNames(candidateDirectory, candidateIdentity, options, 1);
  if (names.length === 0) {
    cleanupPrivateCandidate(candidateDirectory, candidateIdentity, null, options);
    return;
  }
  if (names.length !== 1 || names[0] !== OWNER_FILE) {
    throw lockError('staging cutover initial candidate contains foreign state');
  }
  const candidate = readRecord(path.join(candidateDirectory, OWNER_FILE), options);
  if (candidate.record.kind !== 'INITIAL'
      || !sameBinding(candidate.record.binding, binding)) {
    throw lockError('staging cutover initial candidate belongs to another journal');
  }
  if (ownerState(candidate.record.owner, options) === 'live'
      && !sameOwner(candidate.record.owner, owner)) {
    throw locked(lockDirectory);
  }
  cleanupPrivateCandidate(candidateDirectory, candidateIdentity, {
    bytes: candidate.bytes,
    identity: candidate.identity,
    name: OWNER_FILE,
  }, options);
}

function adopt(lockDirectory, binding, predecessor, owner, options) {
  const { afterPhase, filesystem, userId } = options;
  const sourceDirectory = adoptionCandidateDirectory(lockDirectory, predecessor.sha256);
  let created = false;
  try {
    filesystem.mkdirSync(sourceDirectory, { mode: 0o700 });
    created = true;
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
  const sourceDirectoryIdentity = safeDirectory(sourceDirectory, {
    expectedMode: 0o700, filesystem, userId,
  });
  const source = path.join(sourceDirectory, 'claim.json');
  const observedNames = boundedDirectoryNames(
    sourceDirectory, sourceDirectoryIdentity, options, 1,
  );
  if (observedNames.length > 1
      || (observedNames.length === 1 && observedNames[0] !== 'claim.json')) {
    throw lockError('staging cutover adoption candidate contains foreign state');
  }
  const record = exactRecord({
    binding,
    kind: 'ADOPTION',
    owner,
    predecessorSha256: predecessor.sha256,
    protocol: STAGING_CUTOVER_HOST_LOCK_PROTOCOL,
    publicationSource: source,
  });
  let claim;
  try {
    claim = readRecord(source, options);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (claim === undefined) {
    const bytes = recordBytes(record);
    try {
      const sourceIdentity = writeRecordFile(source, bytes, options);
      claim = Object.freeze({ bytes, identity: sourceIdentity, record, sha256: sha256(bytes) });
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      claim = readRecord(source, options);
    }
  }
  if (claim.record.kind !== 'ADOPTION'
      || claim.record.predecessorSha256 !== predecessor.sha256
      || claim.record.publicationSource !== source
      || !sameBinding(claim.record.binding, binding)) {
    throw lockError('staging cutover adoption candidate belongs to another journal');
  }
  const sourceNames = boundedDirectoryNames(sourceDirectory, sourceDirectoryIdentity, options, 1);
  if (sourceNames.length !== 1 || sourceNames[0] !== 'claim.json') {
    throw lockError('staging cutover adoption candidate contains foreign state');
  }
  syncDirectory(sourceDirectory, filesystem);
  if (created) afterPhase('after-adoption-prepared', Object.freeze({ source }));
  const destination = path.join(lockDirectory, `claim-${predecessor.sha256}.json`);
  try {
    filesystem.linkSync(source, destination);
  } catch (error) {
    if (error?.code === 'EEXIST') return null;
    throw error;
  }
  const linked = safeRecordFile(destination, {
    allowedLinks: [2], expectedIdentity: claim.identity, filesystem, userId,
  });
  if (!linked.bytes.equals(claim.bytes)) {
    throw lockError('staging cutover host-lock adoption changed during publication');
  }
  afterPhase('after-adoption-linked', Object.freeze({ destination, source }));
  syncDirectory(lockDirectory, filesystem);
  filesystem.unlinkSync(source);
  syncDirectory(sourceDirectory, filesystem);
  if (boundedDirectoryNames(sourceDirectory, sourceDirectoryIdentity, options, 1).length !== 0) {
    throw lockError('staging cutover adoption candidate changed before retirement');
  }
  filesystem.rmdirSync(sourceDirectory);
  syncDirectory(path.dirname(lockDirectory), filesystem);
  afterPhase('after-adoption-source-cleanup', Object.freeze({ destination }));
  syncDirectory(lockDirectory, filesystem);
  syncDirectory(path.dirname(lockDirectory), filesystem);
  afterPhase('after-adoption-durable', Object.freeze({ destination }));
  return readChain(lockDirectory, binding, options);
}

function releasedTombstone(lockDirectory) {
  return `${lockDirectory}.released.tombstone`;
}

function restoreReleasedLock(lockDirectory, binding, options) {
  const { filesystem, noReplacePlatform, runNoReplaceMove, userId } = options;
  const tombstone = releasedTombstone(lockDirectory);
  let canonical;
  let retired;
  try {
    canonical = safeDirectory(lockDirectory, {
      expectedMode: 0o700, filesystem, userId,
    });
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  try {
    retired = safeDirectory(tombstone, {
      expectedMode: 0o700, filesystem, userId,
    });
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (canonical && retired) {
    throw lockError('staging cutover host-lock has simultaneous live and released state');
  }
  if (!retired) return;
  readChain(tombstone, binding, options, { publicationLockDirectory: lockDirectory });
  try {
    movePosixDirectoryNoReplace(tombstone, lockDirectory, {
      filesystem,
      platform: noReplacePlatform,
      runMove: runNoReplaceMove,
    });
  } catch (error) {
    let sourceExists = true;
    let destinationExists = true;
    try { filesystem.lstatSync(tombstone); } catch (failure) {
      if (failure?.code !== 'ENOENT') throw failure;
      sourceExists = false;
    }
    try { filesystem.lstatSync(lockDirectory); } catch (failure) {
      if (failure?.code !== 'ENOENT') throw failure;
      destinationExists = false;
    }
    if (sourceExists || !destinationExists) throw error;
  }
  syncDirectory(path.dirname(lockDirectory), filesystem);
}

function operationOptions({
  afterPhase = () => {},
  descriptorDirectoryPath = (descriptor, directory) => process.platform === 'linux'
    ? `/proc/self/fd/${descriptor}` : directory,
  filesystem = fs,
  noReplacePlatform = process.platform,
  readBootId = readLinuxBootId,
  readProcessStat = readLinuxProcessStat,
  runNoReplaceMove,
  userId = typeof process.getuid === 'function' ? process.getuid() : undefined,
} = {}) {
  if (noReplacePlatform !== 'linux' || typeof afterPhase !== 'function'
      || typeof readBootId !== 'function' || typeof readProcessStat !== 'function'
      || typeof descriptorDirectoryPath !== 'function'
      || !Number.isSafeInteger(userId) || userId < 0) {
    throw lockError('staging cutover host-lock requires exact Linux authority', 69);
  }
  return Object.freeze({
    afterPhase,
    descriptorDirectoryPath,
    filesystem,
    noReplacePlatform,
    readBootId,
    readProcessStat,
    runNoReplaceMove,
    userId,
  });
}

export function acquireStagingCutoverHostLock({
  appDirectory,
  bridgeSha256,
  bundleSha256,
  legacyAppMode,
  legacyAuthoritySha256,
  legacyComposeMode,
  legacyComposeSha256,
  legacyMarkerMode,
  legacyMarkerSha256,
  lockDirectory,
  nonce,
  ownerPid = process.pid,
  ...dependencies
} = {}) {
  const resolvedLock = exactAbsolutePath(lockDirectory,
    'staging cutover host-lock path');
  const binding = bindingFromOptions({
    appDirectory,
    bridgeSha256,
    bundleSha256,
    legacyAppMode,
    legacyAuthoritySha256,
    legacyComposeMode,
    legacyComposeSha256,
    legacyMarkerMode,
    legacyMarkerSha256,
    nonce,
  });
  const options = operationOptions(dependencies);
  const parentIdentity = safeParent(resolvedLock, options);
  const owner = captureOwner({ ...options, ownerPid });
  for (let attempt = 0; attempt < MAX_CHAIN_LENGTH; attempt += 1) {
    restoreReleasedLock(resolvedLock, binding, options);
    let exists = true;
    try {
      options.filesystem.lstatSync(resolvedLock);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      exists = false;
    }
    let chain;
    if (!exists) {
      chain = publishInitial(resolvedLock, binding, owner, options);
      if (chain === null) continue;
    } else {
      reconcileInitialCandidate(resolvedLock, binding, owner, options);
      chain = readChain(resolvedLock, binding, options);
    }
    assertParentUnchanged(resolvedLock, parentIdentity, options);
    const state = ownerState(chain.current.record.owner, options);
    if (state === 'live') {
      if (sameOwner(chain.current.record.owner, owner)) {
        return capabilityFromChain(resolvedLock, chain);
      }
      throw locked(resolvedLock);
    }
    const adopted = adopt(resolvedLock, binding, chain.current, owner, options);
    if (adopted === null) continue;
    if (!sameOwner(adopted.current.record.owner, owner)) {
      if (ownerState(adopted.current.record.owner, options) === 'live') {
        throw locked(resolvedLock);
      }
      continue;
    }
    assertParentUnchanged(resolvedLock, parentIdentity, options);
    return capabilityFromChain(resolvedLock, adopted);
  }
  throw lockError('staging cutover host-lock adoption attempts were exhausted');
}

function verifyCapability(capability, ownerPid, options, { allowReleased = false } = {}) {
  const exact = typeof capability === 'string' ? parseCapability(capability)
    : exactCapability(capability);
  const caller = captureOwner({ ...options, ownerPid });
  if (!sameOwner(exact.owner, caller)) {
    throw lockError('staging cutover host-lock capability belongs to another process');
  }
  let chain;
  try {
    chain = readChain(exact.lockDirectory, exact.binding, options);
  } catch (error) {
    if (!allowReleased || error?.code !== 'ENOENT') throw error;
    return Object.freeze({ capability: exact, chain: null, owner: caller });
  }
  if (!sameIdentity(chain.directoryIdentity, exact.directoryIdentity)
      || chain.current.file !== exact.claimPath
      || chain.current.sha256 !== exact.claimSha256
      || !sameIdentity(chain.current.identity, exact.claimIdentity)
      || !sameOwner(chain.current.record.owner, exact.owner)
      || ownerState(exact.owner, options) !== 'live') {
    throw lockError('staging cutover host-lock capability is no longer current');
  }
  return Object.freeze({ capability: exact, chain, owner: caller });
}

export function verifyStagingCutoverHostLock(capability, {
  ownerPid = process.pid,
  ...dependencies
} = {}) {
  const options = operationOptions(dependencies);
  verifyCapability(capability, ownerPid, options);
  return true;
}

export function releaseStagingCutoverHostLock(capability, {
  ownerPid = process.pid,
  ...dependencies
} = {}) {
  const options = operationOptions(dependencies);
  const exact = typeof capability === 'string' ? parseCapability(capability)
    : exactCapability(capability);
  const tombstone = releasedTombstone(exact.lockDirectory);
  let canonicalExists = true;
  try {
    options.filesystem.lstatSync(exact.lockDirectory);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    canonicalExists = false;
  }
  if (!canonicalExists) {
    const caller = captureOwner({ ...options, ownerPid });
    if (!sameOwner(exact.owner, caller)) {
      throw lockError('staging cutover released capability belongs to another process');
    }
    const chain = readChain(tombstone, exact.binding, options, {
      publicationLockDirectory: exact.lockDirectory,
    });
    if (!sameIdentity(chain.directoryIdentity, exact.directoryIdentity)
        || chain.current.sha256 !== exact.claimSha256
        || !sameIdentity(chain.current.identity, exact.claimIdentity)) {
      throw lockError('staging cutover released tombstone does not match capability');
    }
    return true;
  }
  const verified = verifyCapability(exact, ownerPid, options);
  try {
    options.filesystem.lstatSync(tombstone);
    throw lockError('staging cutover host-lock release tombstone is already occupied');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  movePosixDirectoryNoReplace(exact.lockDirectory, tombstone, {
    filesystem: options.filesystem,
    platform: options.noReplacePlatform,
    runMove: options.runNoReplaceMove,
  });
  syncDirectory(path.dirname(exact.lockDirectory), options.filesystem);
  options.afterPhase('after-released-directory', Object.freeze({ tombstone }));
  const retired = readChain(tombstone, exact.binding, options, {
    publicationLockDirectory: exact.lockDirectory,
  });
  if (!sameIdentity(retired.directoryIdentity, verified.chain.directoryIdentity)
      || retired.current.sha256 !== exact.claimSha256
      || !sameIdentity(retired.current.identity, exact.claimIdentity)) {
    throw lockError('staging cutover host-lock changed during release');
  }
  return true;
}

function cliUsage() {
  return 'Usage: staging-cutover-host-lock.js acquire LOCK_DIR OWNER_PID APP_DIR NONCE BRIDGE_SHA LEGACY_MARKER_SHA LEGACY_COMPOSE_SHA APP_MODE MARKER_MODE COMPOSE_MODE LEGACY_AUTHORITY_SHA BUNDLE_SHA | verify OWNER_PID CAPABILITY_JSON | release OWNER_PID CAPABILITY_JSON';
}

function runCli() {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'acquire' && args.length === 12) {
    const ownerPid = Number(args[1]);
    const capability = acquireStagingCutoverHostLock({
      appDirectory: args[2],
      bridgeSha256: args[4],
      bundleSha256: args[11],
      legacyAppMode: args[7],
      legacyAuthoritySha256: args[10],
      legacyComposeMode: args[9],
      legacyComposeSha256: args[6],
      legacyMarkerMode: args[8],
      legacyMarkerSha256: args[5],
      lockDirectory: args[0],
      nonce: args[3],
      ownerPid,
    });
    process.stdout.write(canonicalJson(capability));
    return;
  }
  if ((command === 'verify' || command === 'release') && args.length === 2) {
    const ownerPid = Number(args[0]);
    const action = command === 'verify'
      ? verifyStagingCutoverHostLock : releaseStagingCutoverHostLock;
    action(args[1], { ownerPid });
    process.stdout.write(`${command === 'verify' ? 'verified' : 'released'}\n`);
    return;
  }
  throw lockError(cliUsage(), 64);
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invoked === fileURLToPath(import.meta.url)) {
  try {
    runCli();
  } catch (error) {
    process.stderr.write(`${error?.message ?? String(error)}\n`);
    process.exitCode = Number.isInteger(error?.exitCode) ? error.exitCode : 70;
  }
}
