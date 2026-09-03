import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

export const STAGING_QUIESCENT_MAINTENANCE_ENVIRONMENT =
  'EASYBOOST_STAGING_QUIESCENT_MAINTENANCE';
export const STAGING_QUIESCENT_MAINTENANCE_PROTOCOL =
  'easyboost-staging-quiescent-maintenance-v1';
export const STAGING_QUIESCENT_MAINTENANCE_LOCK_PROTOCOL =
  'easyboost-staging-quiescent-maintenance-lock-v1';
export const STAGING_QUIESCENT_MAINTENANCE_DESCRIPTOR = 8;
export const STAGING_QUIESCENT_MAINTENANCE_LOCK_NAME = 'maintenance.lock';
export const POSIX_RELEASE_MAINTENANCE_ENVIRONMENT =
  'EASYBOOST_POSIX_RELEASE_MAINTENANCE_SCOPE';
export const POSIX_RELEASE_MAINTENANCE_PROTOCOL =
  'easyboost-posix-release-maintenance-scope-v2';

const TOKEN = /^[a-f0-9]{64}$/u;
const START_TIME = /^[1-9][0-9]*$/u;
const MAX_LOCK_BYTES = 4_096;
const MAX_MAINTENANCE_BYTES = 1024 * 1024 * 1024;
const MAX_MAINTENANCE_ENTRIES = 65_536;
const MAX_MAINTENANCE_DELETIONS = 1_024;
const MAX_MAINTENANCE_DELETION_RECORD_BYTES = 4_096;
const MAX_MAINTENANCE_RECOVERY_BATON_LINKS = 32;
const MAINTENANCE_DELETION_PROTOCOL =
  'easyboost-staging-quiescent-maintenance-deletion-v1';
const MAINTENANCE_DELETION_PREFIX = '.maintenance-deletion.';
const MAINTENANCE_DELETION_NAME = /^\.maintenance-deletion\.([a-f0-9]{64})$/u;
const MAINTENANCE_DELETION_CLAIM = 'claim';
const MAINTENANCE_DELETION_CLAIM_PENDING = 'claim.pending';
const MAINTENANCE_DELETION_MARKER = 'moved';
const MAINTENANCE_DELETION_MARKER_PENDING = 'moved.pending';
const MAINTENANCE_DELETION_PAYLOAD = 'payload';
const LOCK_PROOFS = new WeakMap();
const ROOT_AUTHORITIES = new WeakMap();

function canonicalJson(value) {
  return `${JSON.stringify(value)}\n`;
}

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

function sameIdentity(left, right) {
  return String(left.dev) === String(right.dev) && String(left.ino) === String(right.ino);
}

function permissions(stat) {
  return typeof stat.mode === 'bigint'
    ? Number(stat.mode & 0o777n) : Number(stat.mode & 0o777);
}

function ownedRegularFile(stat, userId) {
  return stat?.isFile?.() && !stat?.isSymbolicLink?.() && Number(stat.nlink) === 1
    && (userId === undefined || String(stat.uid) === String(userId));
}

function ownedDirectory(stat, userId, expectedMode) {
  return stat?.isDirectory?.() && !stat?.isSymbolicLink?.()
    && (userId === undefined || String(stat.uid) === String(userId))
    && (expectedMode === undefined || permissions(stat) === expectedMode);
}

function linuxProcessStartTime(processId, filesystem = fs) {
  const value = filesystem.readFileSync(`/proc/${processId}/stat`, 'utf8');
  const commandEnd = value.lastIndexOf(')');
  if (commandEnd < 1) throw new Error('staging maintenance process identity is invalid');
  const fields = value.slice(commandEnd + 2).trim().split(/\s+/u);
  const parsedProcessId = Number(value.slice(0, value.indexOf(' ')));
  const startTime = fields[19];
  if (parsedProcessId !== processId || !START_TIME.test(startTime ?? '')) {
    throw new Error('staging maintenance process identity is invalid');
  }
  return startTime;
}

function linuxDeviceParts(device) {
  const value = BigInt(device);
  const major = ((value & 0x00000000000fff00n) >> 8n)
    | ((value & 0xfffff00000000000n) >> 32n);
  const minor = (value & 0x00000000000000ffn)
    | ((value & 0x00000ffffff00000n) >> 12n);
  return { major, minor };
}

function descriptorInfoProvesExclusiveLock(value, stat) {
  const { major, minor } = linuxDeviceParts(stat.dev);
  for (const line of value.split(/\r?\n/u)) {
    if (!line) continue;
    const fields = line.trim().split(/\s+/u);
    if (fields.length !== 9 || fields[0] !== 'lock:' || !/^[1-9][0-9]*:$/u.test(fields[1])
        || fields[2] !== 'FLOCK' || fields[3] !== 'ADVISORY'
        || fields[4] !== 'WRITE' || !/^(?:-1|[1-9][0-9]*)$/u.test(fields[5])
        || fields[7] !== '0' || fields[8] !== 'EOF') continue;
    const match = /^([a-f0-9]+):([a-f0-9]+):([0-9]+)$/iu.exec(fields[6]);
    if (match && BigInt(`0x${match[1]}`) === major && BigInt(`0x${match[2]}`) === minor
        && BigInt(match[3]) === BigInt(stat.ino)) return true;
  }
  return false;
}

function syncDirectory(directory, filesystem = fs) {
  const descriptor = filesystem.openSync(directory, 'r');
  try { filesystem.fsyncSync(descriptor); } finally { filesystem.closeSync(descriptor); }
}

export function stagingQuiescentMaintenanceLockBytes(installRoot) {
  if (typeof installRoot !== 'string' || !path.isAbsolute(installRoot)
      || path.resolve(installRoot) !== installRoot) {
    throw new Error('staging maintenance install root is invalid');
  }
  return Buffer.from(canonicalJson({
    installRoot,
    protocol: STAGING_QUIESCENT_MAINTENANCE_LOCK_PROTOCOL,
  }));
}

export function stagingQuiescentMaintenanceEnvironmentValue(lockBytes) {
  if (!Buffer.isBuffer(lockBytes) || lockBytes.length < 1 || lockBytes.length > MAX_LOCK_BYTES) {
    throw new Error('staging maintenance lock bytes are invalid');
  }
  return `${STAGING_QUIESCENT_MAINTENANCE_PROTOCOL}`
    + `:${STAGING_QUIESCENT_MAINTENANCE_DESCRIPTOR}`
    + `:${createHash('sha256').update(lockBytes).digest('hex')}`;
}

function exactEnvironmentDigest(value) {
  const prefix = `${STAGING_QUIESCENT_MAINTENANCE_PROTOCOL}`
    + `:${STAGING_QUIESCENT_MAINTENANCE_DESCRIPTOR}:`;
  if (typeof value !== 'string' || !value.startsWith(prefix)
      || !TOKEN.test(value.slice(prefix.length))) {
    throw new Error('staging maintenance launcher authority is invalid');
  }
  return value.slice(prefix.length);
}

function assertLiveLock(proof) {
  const currentDescriptor = proof.filesystem.fstatSync(
    STAGING_QUIESCENT_MAINTENANCE_DESCRIPTOR,
  );
  const currentPath = proof.filesystem.lstatSync(proof.lockPath);
  const currentStartTime = proof.readProcessStartTime(proof.processId, proof.filesystem);
  const currentBytes = proof.readDescriptorBytes(
    STAGING_QUIESCENT_MAINTENANCE_DESCRIPTOR,
  );
  if (!sameIdentity(proof.lockIdentity, currentDescriptor)
      || !sameIdentity(proof.lockIdentity, currentPath)
      || !ownedRegularFile(currentDescriptor, proof.userId)
      || !ownedRegularFile(currentPath, proof.userId)
      || permissions(currentDescriptor) !== 0o600 || permissions(currentPath) !== 0o600
      || !Buffer.isBuffer(currentBytes) || !currentBytes.equals(proof.lockBytes)
      || Number(currentDescriptor.size) !== proof.lockBytes.length
      || currentStartTime !== proof.ownerStartTime
      || !proof.verifyExclusiveLock(
        proof.readDescriptorLockInfo(STAGING_QUIESCENT_MAINTENANCE_DESCRIPTOR),
        currentDescriptor,
      )) {
    throw new Error('staging maintenance process-lifetime lock is no longer proven');
  }
  return currentDescriptor;
}

export function consumeStagingQuiescentMaintenanceLock({
  environment,
  expectedInstallRoot,
  filesystem = fs,
  platform = process.platform,
  processId = process.pid,
  readDescriptorBytes = (descriptor) => filesystem.readFileSync(`/proc/self/fd/${descriptor}`),
  readDescriptorLockInfo = (descriptor) => (
    filesystem.readFileSync(`/proc/self/fdinfo/${descriptor}`, 'utf8')
  ),
  readProcessStartTime = linuxProcessStartTime,
  userId = typeof process.getuid === 'function' ? process.getuid() : undefined,
  verifyExclusiveLock = descriptorInfoProvesExclusiveLock,
} = {}) {
  if (!environment || typeof environment !== 'object') {
    throw new Error('staging maintenance environment is invalid');
  }
  const value = environment[STAGING_QUIESCENT_MAINTENANCE_ENVIRONMENT];
  delete environment[STAGING_QUIESCENT_MAINTENANCE_ENVIRONMENT];
  if (value === undefined) return undefined;
  if (platform !== 'linux' || !Number.isSafeInteger(processId) || processId <= 0) {
    throw new Error('staging maintenance requires a Linux process-lifetime lock');
  }
  const expectedDigest = exactEnvironmentDigest(value);
  const lockBytes = stagingQuiescentMaintenanceLockBytes(expectedInstallRoot);
  const lockPath = path.join(expectedInstallRoot, STAGING_QUIESCENT_MAINTENANCE_LOCK_NAME);
  const descriptorIdentity = filesystem.fstatSync(
    STAGING_QUIESCENT_MAINTENANCE_DESCRIPTOR,
  );
  const pathIdentity = filesystem.lstatSync(lockPath);
  const observedBytes = readDescriptorBytes(STAGING_QUIESCENT_MAINTENANCE_DESCRIPTOR);
  if (!ownedRegularFile(descriptorIdentity, userId) || permissions(descriptorIdentity) !== 0o600
      || !ownedRegularFile(pathIdentity, userId) || permissions(pathIdentity) !== 0o600
      || !sameIdentity(descriptorIdentity, pathIdentity)
      || !Buffer.isBuffer(observedBytes) || !observedBytes.equals(lockBytes)
      || Number(descriptorIdentity.size) !== lockBytes.length
      || createHash('sha256').update(observedBytes).digest('hex') !== expectedDigest) {
    throw new Error('staging maintenance lock file is invalid');
  }
  const ownerStartTime = readProcessStartTime(processId, filesystem);
  if (!verifyExclusiveLock(
    readDescriptorLockInfo(STAGING_QUIESCENT_MAINTENANCE_DESCRIPTOR), descriptorIdentity,
  )) {
    throw new Error('staging maintenance exclusive lock is not held');
  }
  const publicProof = Object.freeze({
    descriptor: STAGING_QUIESCENT_MAINTENANCE_DESCRIPTOR,
    protocol: STAGING_QUIESCENT_MAINTENANCE_PROTOCOL,
  });
  LOCK_PROOFS.set(publicProof, {
    filesystem,
    lockBytes,
    lockIdentity: descriptorIdentity,
    lockPath,
    ownerStartTime,
    processId,
    readDescriptorBytes,
    readDescriptorLockInfo,
    readProcessStartTime,
    userId,
    verifyExclusiveLock,
  });
  assertLiveLock(LOCK_PROOFS.get(publicProof));
  return publicProof;
}

function exactMaintenanceEnvironmentDigest(value, protocol) {
  const prefix = `${protocol}:${STAGING_QUIESCENT_MAINTENANCE_DESCRIPTOR}:`;
  if (typeof value !== 'string' || !value.startsWith(prefix)
      || !TOKEN.test(value.slice(prefix.length))) {
    throw new Error('POSIX release maintenance launcher authority is invalid');
  }
  return value.slice(prefix.length);
}

export function posixReleaseMaintenanceEnvironmentValue(lockBytes) {
  if (!Buffer.isBuffer(lockBytes) || lockBytes.length < 1 || lockBytes.length > MAX_LOCK_BYTES) {
    throw new Error('POSIX release maintenance lock bytes are invalid');
  }
  return `${POSIX_RELEASE_MAINTENANCE_PROTOCOL}`
    + `:${STAGING_QUIESCENT_MAINTENANCE_DESCRIPTOR}`
    + `:${createHash('sha256').update(lockBytes).digest('hex')}`;
}

export function consumePosixReleaseMaintenanceLock({
  allowedControlRoots,
  environment,
  expectedLockBytes,
  expectedLockPath,
  filesystem = fs,
  platform = process.platform,
  processId = process.pid,
  readDescriptorBytes = (descriptor) => filesystem.readFileSync(`/proc/self/fd/${descriptor}`),
  readDescriptorLockInfo = (descriptor) => (
    filesystem.readFileSync(`/proc/self/fdinfo/${descriptor}`, 'utf8')
  ),
  readProcessStartTime = linuxProcessStartTime,
  userId = typeof process.getuid === 'function' ? process.getuid() : undefined,
  verifyExclusiveLock = descriptorInfoProvesExclusiveLock,
} = {}) {
  if (!environment || typeof environment !== 'object') {
    throw new Error('POSIX release maintenance environment is invalid');
  }
  const value = environment[POSIX_RELEASE_MAINTENANCE_ENVIRONMENT];
  delete environment[POSIX_RELEASE_MAINTENANCE_ENVIRONMENT];
  if (value === undefined) return undefined;
  if (platform !== 'linux' || !Number.isSafeInteger(processId) || processId <= 0
      || typeof expectedLockPath !== 'string' || !path.isAbsolute(expectedLockPath)
      || path.resolve(expectedLockPath) !== expectedLockPath
      || !Buffer.isBuffer(expectedLockBytes) || expectedLockBytes.length < 1
      || expectedLockBytes.length > MAX_LOCK_BYTES
      || !Array.isArray(allowedControlRoots) || allowedControlRoots.length < 1) {
    throw new Error('POSIX release maintenance requires an exact Linux lifetime scope');
  }
  const expectedDigest = exactMaintenanceEnvironmentDigest(
    value, POSIX_RELEASE_MAINTENANCE_PROTOCOL,
  );
  const descriptorIdentity = filesystem.fstatSync(
    STAGING_QUIESCENT_MAINTENANCE_DESCRIPTOR,
  );
  const pathIdentity = filesystem.lstatSync(expectedLockPath);
  const observedBytes = readDescriptorBytes(STAGING_QUIESCENT_MAINTENANCE_DESCRIPTOR);
  if (!ownedRegularFile(descriptorIdentity, userId) || permissions(descriptorIdentity) !== 0o600
      || !ownedRegularFile(pathIdentity, userId) || permissions(pathIdentity) !== 0o600
      || !sameIdentity(descriptorIdentity, pathIdentity)
      || !Buffer.isBuffer(observedBytes) || !observedBytes.equals(expectedLockBytes)
      || Number(descriptorIdentity.size) !== expectedLockBytes.length
      || createHash('sha256').update(observedBytes).digest('hex') !== expectedDigest) {
    throw new Error('POSIX release maintenance lock file is invalid');
  }
  const allowed = new Map();
  for (const root of allowedControlRoots) {
    if (!exactKeys(root, ['dev', 'ino', 'path']) || typeof root.path !== 'string'
        || !path.isAbsolute(root.path) || path.resolve(root.path) !== root.path
        || !/^(?:0|[1-9][0-9]*)$/u.test(root.dev ?? '')
        || !/^(?:0|[1-9][0-9]*)$/u.test(root.ino ?? '') || allowed.has(root.path)) {
      throw new Error('POSIX release maintenance control-root allowlist is invalid');
    }
    const identity = filesystem.lstatSync(root.path);
    if (!ownedDirectory(identity, userId, 0o700)
        || String(identity.dev) !== root.dev || String(identity.ino) !== root.ino) {
      throw new Error('POSIX release maintenance control root is invalid');
    }
    allowed.set(root.path, Object.freeze({ ...root }));
  }
  const ownerStartTime = readProcessStartTime(processId, filesystem);
  if (!verifyExclusiveLock(
    readDescriptorLockInfo(STAGING_QUIESCENT_MAINTENANCE_DESCRIPTOR), descriptorIdentity,
  )) throw new Error('POSIX release maintenance exclusive lock is not held');
  const publicProof = Object.freeze({
    descriptor: STAGING_QUIESCENT_MAINTENANCE_DESCRIPTOR,
    protocol: POSIX_RELEASE_MAINTENANCE_PROTOCOL,
  });
  LOCK_PROOFS.set(publicProof, {
    allowedControlRoots: allowed,
    filesystem,
    lockBytes: expectedLockBytes,
    lockIdentity: descriptorIdentity,
    lockPath: expectedLockPath,
    ownerStartTime,
    processId,
    readDescriptorBytes,
    readDescriptorLockInfo,
    readProcessStartTime,
    userId,
    verifyExclusiveLock,
  });
  assertLiveLock(LOCK_PROOFS.get(publicProof));
  return publicProof;
}

function exactIdentity(value) {
  if (!exactKeys(value, ['dev', 'ino'])
      || !/^(?:0|[1-9][0-9]*)$/u.test(value.dev ?? '')
      || !/^(?:0|[1-9][0-9]*)$/u.test(value.ino ?? '')) {
    throw new Error('staging retained evidence identity is invalid');
  }
  return value;
}

function exactReservationBinding(value) {
  if (!exactKeys(value, ['owner', 'purpose', 'sha256', 'sourceDev', 'sourceIno'])
      || !TOKEN.test(value.owner ?? '') || !TOKEN.test(value.sha256 ?? '')
      || (value.purpose !== 'cleanup' && value.purpose !== 'retire')
      || !/^(?:0|[1-9][0-9]*)$/u.test(value.sourceDev ?? '')
      || !/^(?:0|[1-9][0-9]*)$/u.test(value.sourceIno ?? '')) {
    throw new Error('staging maintenance reservation binding is invalid');
  }
  return Object.freeze({ ...value });
}

function authorityMatches(expected, observed) {
  const keys = [
    'descriptor', 'lease', 'ownerPid', 'ownerStartTime',
    'protocol', 'rootDev', 'rootIno',
  ];
  return exactKeys(observed, keys)
    && keys.every((key) => observed[key] === expected[key]);
}

function measureRetainedPayload(entry, state, filesystem) {
  const stat = filesystem.lstatSync(entry);
  if (stat.isSymbolicLink?.() || String(stat.dev) !== state.device
      || (!stat.isDirectory?.() && !stat.isFile?.())
      || (state.userId !== undefined && String(stat.uid) !== String(state.userId))) {
    throw new Error('staging retained evidence contains an unsafe entry');
  }
  state.entries += 1;
  if (state.entries > state.maximumEntries) {
    throw new Error('staging retained evidence entry bound is exhausted');
  }
  if (stat.isFile()) {
    const identity = `${String(stat.dev)}:${String(stat.ino)}`;
    if (!state.identities.has(identity)) {
      state.identities.add(identity);
      state.bytes += Number(stat.size);
    }
    if (!Number.isSafeInteger(Number(stat.size)) || Number(stat.size) < 0
        || state.bytes > state.maximumBytes) {
      throw new Error('staging retained evidence byte bound is exhausted');
    }
    return;
  }
  const names = filesystem.readdirSync(entry);
  for (const name of names) {
    if (!name || name === '.' || name === '..' || path.basename(name) !== name) {
      throw new Error('staging retained evidence name is invalid');
    }
    measureRetainedPayload(path.join(entry, name), state, filesystem);
  }
}

function exactBound(value, maximum, label) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function pathIsAbsent(filesystem, entry) {
  try {
    filesystem.lstatSync(entry);
    return false;
  } catch (error) {
    if (error?.code === 'ENOENT') return true;
    throw error;
  }
}

function boundedDirectoryNames(directory, maximumEntries, filesystem) {
  const handle = filesystem.opendirSync(directory);
  const names = [];
  try {
    for (;;) {
      const entry = handle.readSync();
      if (entry === null) break;
      if (!entry.name || entry.name === '.' || entry.name === '..'
          || path.basename(entry.name) !== entry.name) {
        throw new Error('staging maintenance deletion namespace contains an invalid name');
      }
      names.push(entry.name);
      if (names.length > maximumEntries) {
        throw new Error('staging maintenance deletion namespace scan bound is exhausted');
      }
    }
  } finally {
    handle.closeSync();
  }
  return names.sort();
}

function assertMissing(filesystem, entry, label) {
  if (!pathIsAbsent(filesystem, entry)) throw new Error(`${label} already exists`);
}

function assertMaintenanceRoot(binding) {
  assertLiveLock(binding.proof);
  const currentRoot = binding.proof.filesystem.lstatSync(binding.controlRoot);
  if (!sameIdentity(binding.rootIdentity, currentRoot)
      || !ownedDirectory(currentRoot, binding.proof.userId, 0o700)) {
    throw new Error('staging maintenance root changed during deletion recovery');
  }
  return currentRoot;
}

function validatePrivateDeletionDirectory(binding, transaction) {
  assertMaintenanceRoot(binding);
  const identity = binding.proof.filesystem.lstatSync(transaction);
  if (!ownedDirectory(identity, binding.proof.userId, 0o700)
      || String(identity.dev) !== String(binding.rootIdentity.dev)) {
    throw new Error('staging maintenance deletion transaction is unsafe');
  }
  return identity;
}

function validatePrivateRecord(binding, entry, maximumBytes, { allowPartial = false } = {}) {
  const filesystem = binding.proof.filesystem;
  const pathIdentity = filesystem.lstatSync(entry);
  if (!ownedRegularFile(pathIdentity, binding.proof.userId)
      || permissions(pathIdentity) !== 0o600
      || String(pathIdentity.dev) !== String(binding.rootIdentity.dev)
      || !Number.isSafeInteger(Number(pathIdentity.size))
      || Number(pathIdentity.size) < (allowPartial ? 0 : 1)
      || Number(pathIdentity.size) > maximumBytes) {
    throw new Error('staging maintenance deletion record is unsafe');
  }
  const descriptor = filesystem.openSync(
    entry, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
  );
  let descriptorIdentity;
  let bytes;
  try {
    descriptorIdentity = filesystem.fstatSync(descriptor);
    if (!sameIdentity(pathIdentity, descriptorIdentity)
        || !ownedRegularFile(descriptorIdentity, binding.proof.userId)
        || permissions(descriptorIdentity) !== 0o600
        || Number(descriptorIdentity.size) !== Number(pathIdentity.size)) {
      throw new Error('staging maintenance deletion record changed while opening');
    }
    bytes = filesystem.readFileSync(descriptor);
  } finally {
    filesystem.closeSync(descriptor);
  }
  const finalIdentity = filesystem.lstatSync(entry);
  if (!sameIdentity(pathIdentity, finalIdentity) || !Buffer.isBuffer(bytes)
      || bytes.length !== Number(pathIdentity.size)) {
    throw new Error('staging maintenance deletion record changed while reading');
  }
  return { bytes, identity: pathIdentity };
}

function publishPrivateRecord(binding, transaction, pendingName, finalName, bytes) {
  const filesystem = binding.proof.filesystem;
  const pending = path.join(transaction, pendingName);
  const destination = path.join(transaction, finalName);
  assertMaintenanceRoot(binding);
  validatePrivateDeletionDirectory(binding, transaction);
  assertMissing(filesystem, pending, 'staging maintenance deletion pending record');
  assertMissing(filesystem, destination, 'staging maintenance deletion record');
  const descriptor = filesystem.openSync(
    pending,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
      | (fs.constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    filesystem.fchmodSync(descriptor, 0o600);
    filesystem.writeFileSync(descriptor, bytes);
    filesystem.fsyncSync(descriptor);
    const identity = filesystem.fstatSync(descriptor);
    if (!ownedRegularFile(identity, binding.proof.userId)
        || permissions(identity) !== 0o600
        || String(identity.dev) !== String(binding.rootIdentity.dev)
        || Number(identity.size) !== bytes.length) {
      throw new Error('staging maintenance deletion record publication is unsafe');
    }
  } finally {
    filesystem.closeSync(descriptor);
  }
  binding.synchronizeDirectory(transaction, filesystem);
  assertMissing(filesystem, destination, 'staging maintenance deletion record');
  filesystem.renameSync(pending, destination);
  binding.synchronizeDirectory(transaction, filesystem);
  validatePrivateRecord(binding, destination,
    Math.max(bytes.length, 1), { allowPartial: bytes.length === 0 });
}

function normalizedDeletionClaim({
  bounds,
  containerIdentity,
  kind,
  payloadIdentity,
  reservationBinding,
  reservationIdentity,
  rootIdentity,
  sourceName,
  transaction,
}) {
  return {
    bounds: {
      maximumBytes: bounds.maximumBytes,
      maximumEntries: bounds.maximumEntries,
    },
    containerIdentity: {
      dev: containerIdentity.dev,
      ino: containerIdentity.ino,
    },
    kind,
    payloadIdentity: payloadIdentity === null ? null : {
      dev: payloadIdentity.dev,
      ino: payloadIdentity.ino,
    },
    protocol: MAINTENANCE_DELETION_PROTOCOL,
    reservationBinding: reservationBinding === null ? null : {
      owner: reservationBinding.owner,
      purpose: reservationBinding.purpose,
      sha256: reservationBinding.sha256,
      sourceDev: reservationBinding.sourceDev,
      sourceIno: reservationBinding.sourceIno,
    },
    reservationIdentity: reservationIdentity === null ? null : {
      dev: reservationIdentity.dev,
      ino: reservationIdentity.ino,
    },
    rootIdentity: {
      dev: rootIdentity.dev,
      ino: rootIdentity.ino,
    },
    sourceName,
    transaction,
  };
}

function exactDeletionClaim(value, transaction, binding) {
  if (!exactKeys(value, [
    'bounds', 'containerIdentity', 'kind', 'payloadIdentity', 'protocol',
    'reservationBinding', 'reservationIdentity', 'rootIdentity', 'sourceName', 'transaction',
  ]) || !exactKeys(value.bounds, ['maximumBytes', 'maximumEntries'])
      || value.protocol !== MAINTENANCE_DELETION_PROTOCOL
      || value.transaction !== transaction
      || (value.kind !== 'CLAIMLESS_RESERVATION'
        && value.kind !== 'PUBLICATION' && value.kind !== 'RESERVATION_ONLY'
        && value.kind !== 'RETIREMENT')
      || typeof value.sourceName !== 'string' || path.basename(value.sourceName) !== value.sourceName
      || !value.sourceName || value.sourceName === '.' || value.sourceName === '..'
      || value.sourceName.startsWith(MAINTENANCE_DELETION_PREFIX)) {
    throw new Error('staging maintenance deletion claim is invalid');
  }
  const bounds = {
    maximumBytes: exactBound(
      value.bounds.maximumBytes, MAX_MAINTENANCE_BYTES,
      'staging retained evidence maximum byte bound',
    ),
    maximumEntries: exactBound(
      value.bounds.maximumEntries, MAX_MAINTENANCE_ENTRIES,
      'staging retained evidence maximum entry bound',
    ),
  };
  const containerIdentity = exactIdentity(value.containerIdentity);
  const claimless = value.kind === 'CLAIMLESS_RESERVATION';
  const reservationOnly = value.kind === 'RESERVATION_ONLY';
  if (claimless !== (value.payloadIdentity === null && value.reservationIdentity === null)
      || reservationOnly !== (value.payloadIdentity === null
        && value.reservationIdentity !== null && value.reservationBinding !== null)
      || (!reservationOnly && value.reservationBinding !== null)) {
    throw new Error('staging maintenance deletion claim evidence is invalid');
  }
  const payloadIdentity = claimless || reservationOnly
    ? null : exactIdentity(value.payloadIdentity);
  const reservationBinding = reservationOnly
    ? exactReservationBinding(value.reservationBinding) : null;
  const reservationIdentity = claimless ? null : exactIdentity(value.reservationIdentity);
  const rootIdentity = exactIdentity(value.rootIdentity);
  if (!sameIdentity(rootIdentity, binding.rootIdentity)) {
    throw new Error('staging maintenance deletion claim root is invalid');
  }
  return normalizedDeletionClaim({
    bounds,
    containerIdentity,
    kind: value.kind,
    payloadIdentity,
    reservationBinding,
    reservationIdentity,
    rootIdentity,
    sourceName: value.sourceName,
    transaction,
  });
}

function readDeletionClaim(binding, transactionPath, transaction) {
  const observed = validatePrivateRecord(
    binding,
    path.join(transactionPath, MAINTENANCE_DELETION_CLAIM),
    MAX_MAINTENANCE_DELETION_RECORD_BYTES,
  ).bytes;
  let parsed;
  try {
    parsed = JSON.parse(observed.toString('utf8'));
  } catch {
    throw new Error('staging maintenance deletion claim is not JSON');
  }
  const claim = exactDeletionClaim(parsed, transaction, binding);
  if (!Buffer.from(canonicalJson(claim)).equals(observed)) {
    throw new Error('staging maintenance deletion claim is not canonical');
  }
  return claim;
}

function validateReservationRecord(binding, entry, expectedIdentity, expectedBinding = null) {
  const record = validatePrivateRecord(
    binding, entry, MAX_MAINTENANCE_DELETION_RECORD_BYTES,
  );
  if (!sameIdentity(record.identity, expectedIdentity)) {
    throw new Error('staging maintenance deletion reservation identity changed');
  }
  if (expectedBinding !== null) {
    const bindingValue = exactReservationBinding(expectedBinding);
    let parsed;
    try { parsed = JSON.parse(record.bytes.toString('utf8')); } catch {
      throw new Error('staging maintenance deletion reservation is not JSON');
    }
    if (createHash('sha256').update(record.bytes).digest('hex') !== bindingValue.sha256
        || parsed?.owner !== bindingValue.owner
        || parsed?.purpose !== bindingValue.purpose
        || parsed?.sourceDev !== bindingValue.sourceDev
        || parsed?.sourceIno !== bindingValue.sourceIno) {
      throw new Error('staging maintenance deletion reservation binding changed');
    }
  }
}

function validatePublicationLinks(binding, directory, names, claim) {
  const linkNames = ['payload', 'retained-source'].filter((name) => names.includes(name));
  if (linkNames.length < 1) {
    throw new Error('staging maintenance publication links are missing');
  }
  for (const name of linkNames) {
    const identity = binding.proof.filesystem.lstatSync(path.join(directory, name));
    if (!sameIdentity(identity, claim.payloadIdentity) || !identity.isFile()
        || identity.isSymbolicLink?.()
        || Number(identity.nlink) !== linkNames.length
        || (binding.proof.userId !== undefined
          && String(identity.uid) !== String(binding.proof.userId))) {
      throw new Error('staging maintenance publication links changed before deletion');
    }
  }
}

function measureClaimPayload(binding, entry, claim) {
  measureRetainedPayload(entry, {
    bytes: 0,
    device: String(binding.rootIdentity.dev),
    entries: 0,
    identities: new Set(),
    maximumBytes: claim.bounds.maximumBytes,
    maximumEntries: claim.bounds.maximumEntries,
    userId: binding.proof.userId,
  }, binding.proof.filesystem);
}

function validateUnmovedSource(binding, claim) {
  assertMaintenanceRoot(binding);
  const filesystem = binding.proof.filesystem;
  const source = path.join(binding.controlRoot, claim.sourceName);
  const containerIdentity = filesystem.lstatSync(source);
  if (!sameIdentity(containerIdentity, claim.containerIdentity)
      || !ownedDirectory(containerIdentity, binding.proof.userId, 0o700)
      || String(containerIdentity.dev) !== String(binding.rootIdentity.dev)) {
    throw new Error('staging maintenance deletion source changed before move');
  }
  const names = boundedDirectoryNames(source, 4, filesystem);
  if (claim.kind === 'CLAIMLESS_RESERVATION') {
    if (names.length !== 0) {
      throw new Error('staging maintenance claimless source contains foreign evidence');
    }
    return source;
  }
  if (claim.kind === 'RESERVATION_ONLY') {
    if (JSON.stringify(names) !== JSON.stringify(['reservation.claim'])) {
      throw new Error('staging maintenance reservation-only source contains foreign evidence');
    }
    validateReservationRecord(
      binding, path.join(source, 'reservation.claim'), claim.reservationIdentity,
      claim.reservationBinding,
    );
    return source;
  }
  const retirementPair = claim.kind === 'RETIREMENT'
    && JSON.stringify(names) === JSON.stringify(['payload', 'reservation.claim']);
  const retiredPublicationPair = claim.kind === 'PUBLICATION'
    && JSON.stringify(names)
      === JSON.stringify(['payload', 'reservation.claim', 'retained-source']);
  if (!retirementPair && !retiredPublicationPair) {
    throw new Error('staging maintenance deletion source contains foreign evidence');
  }
  const payload = path.join(source, 'payload');
  const payloadIdentity = filesystem.lstatSync(payload);
  if (!sameIdentity(payloadIdentity, claim.payloadIdentity)) {
    throw new Error('staging maintenance deletion payload changed before move');
  }
  validateReservationRecord(
    binding, path.join(source, 'reservation.claim'), claim.reservationIdentity,
  );
  if (claim.kind === 'PUBLICATION') validatePublicationLinks(binding, source, names, claim);
  measureClaimPayload(binding, payload, claim);
  return source;
}

function validateMovedRemainder(binding, moved, claim, { deletionArmed }) {
  const filesystem = binding.proof.filesystem;
  const identity = filesystem.lstatSync(moved);
  if (!sameIdentity(identity, claim.containerIdentity)
      || !ownedDirectory(identity, binding.proof.userId, 0o700)
      || String(identity.dev) !== String(binding.rootIdentity.dev)) {
    throw new Error('staging maintenance deletion moved payload changed');
  }
  const names = boundedDirectoryNames(moved, 4, filesystem);
  if (claim.kind === 'CLAIMLESS_RESERVATION') {
    if (names.length !== 0) {
      throw new Error('staging maintenance claimless payload contains foreign evidence');
    }
    return;
  }
  if (claim.kind === 'RESERVATION_ONLY') {
    if (names.some((name) => name !== 'reservation.claim')
        || (!deletionArmed && JSON.stringify(names) !== JSON.stringify(['reservation.claim']))) {
      throw new Error('staging maintenance reservation-only payload contains foreign evidence');
    }
    if (names.includes('reservation.claim')) {
      validateReservationRecord(
        binding, path.join(moved, 'reservation.claim'), claim.reservationIdentity,
        claim.reservationBinding,
      );
    }
    return;
  }
  const allowedNames = claim.kind === 'PUBLICATION'
    ? new Set(['payload', 'reservation.claim', 'retained-source'])
    : new Set(['payload', 'reservation.claim']);
  const completePair = claim.kind === 'RETIREMENT'
    && JSON.stringify(names) === JSON.stringify(['payload', 'reservation.claim']);
  const completeRetiredPublicationPair = claim.kind === 'PUBLICATION'
    && JSON.stringify(names)
      === JSON.stringify(['payload', 'reservation.claim', 'retained-source']);
  if (names.some((name) => !allowedNames.has(name))
      || (!deletionArmed && !completePair && !completeRetiredPublicationPair)) {
    throw new Error('staging maintenance deletion moved payload contains foreign evidence');
  }
  if (names.includes('reservation.claim')) {
    validateReservationRecord(
      binding, path.join(moved, 'reservation.claim'), claim.reservationIdentity,
    );
  }
  if (names.includes('payload')) {
    const payload = path.join(moved, 'payload');
    const identity = filesystem.lstatSync(payload);
    if (!sameIdentity(identity, claim.payloadIdentity)) {
      throw new Error('staging maintenance deletion retained payload changed');
    }
    measureClaimPayload(binding, payload, claim);
  }
  if (claim.kind === 'PUBLICATION' && (names.includes('payload')
      || names.includes('retained-source'))) {
    validatePublicationLinks(binding, moved, names, claim);
  }
}

function maintenanceTransition(binding, phase, transactionPath) {
  binding.onMaintenanceTransition(phase, Object.freeze({
    root: binding.controlRoot,
    transaction: transactionPath,
  }));
}

function validateEmptyMarker(binding, entry) {
  const record = validatePrivateRecord(binding, entry, 1, { allowPartial: true });
  if (record.bytes.length !== 0) {
    throw new Error('staging maintenance deletion moved marker is invalid');
  }
}

function discardPendingRecord(binding, transactionPath, name, maximumBytes) {
  const filesystem = binding.proof.filesystem;
  const entry = path.join(transactionPath, name);
  validatePrivateRecord(binding, entry, maximumBytes, { allowPartial: true });
  assertMaintenanceRoot(binding);
  filesystem.unlinkSync(entry);
  binding.synchronizeDirectory(transactionPath, filesystem);
}

function removeDeletionTransaction(binding, transactionPath, transactionIdentity) {
  const filesystem = binding.proof.filesystem;
  assertMaintenanceRoot(binding);
  const current = filesystem.lstatSync(transactionPath);
  if (!sameIdentity(transactionIdentity, current)
      || !ownedDirectory(current, binding.proof.userId, 0o700)
      || boundedDirectoryNames(transactionPath, 1, filesystem).length !== 0) {
    throw new Error('staging maintenance deletion transaction changed before removal');
  }
  filesystem.rmdirSync(transactionPath);
  binding.synchronizeDirectory(binding.controlRoot, filesystem);
  assertMaintenanceRoot(binding);
  maintenanceTransition(binding, 'transaction-removed', transactionPath);
}

function resumeMaintenanceDeletion(binding, transactionName) {
  const match = MAINTENANCE_DELETION_NAME.exec(transactionName);
  if (!match) throw new Error('staging maintenance deletion transaction name is invalid');
  const transaction = match[1];
  const transactionPath = path.join(binding.controlRoot, transactionName);
  const filesystem = binding.proof.filesystem;
  const transactionIdentity = validatePrivateDeletionDirectory(binding, transactionPath);
  let names = boundedDirectoryNames(transactionPath, 6, filesystem);
  const allowedNames = new Set([
    MAINTENANCE_DELETION_CLAIM,
    MAINTENANCE_DELETION_CLAIM_PENDING,
    MAINTENANCE_DELETION_MARKER,
    MAINTENANCE_DELETION_MARKER_PENDING,
    MAINTENANCE_DELETION_PAYLOAD,
  ]);
  if (names.some((name) => !allowedNames.has(name))) {
    throw new Error('staging maintenance deletion transaction contains foreign evidence');
  }

  if (names.includes(MAINTENANCE_DELETION_CLAIM_PENDING)) {
    if (names.length !== 1) {
      throw new Error('staging maintenance deletion pending claim is ambiguous');
    }
    discardPendingRecord(
      binding, transactionPath, MAINTENANCE_DELETION_CLAIM_PENDING,
      MAX_MAINTENANCE_DELETION_RECORD_BYTES,
    );
    names = [];
  }
  if (names.length === 0) {
    removeDeletionTransaction(binding, transactionPath, transactionIdentity);
    return;
  }

  const claimPath = path.join(transactionPath, MAINTENANCE_DELETION_CLAIM);
  const markerPath = path.join(transactionPath, MAINTENANCE_DELETION_MARKER);
  const markerPendingPath = path.join(
    transactionPath, MAINTENANCE_DELETION_MARKER_PENDING,
  );
  const moved = path.join(transactionPath, MAINTENANCE_DELETION_PAYLOAD);
  if (!names.includes(MAINTENANCE_DELETION_CLAIM)) {
    if (JSON.stringify(names) !== JSON.stringify([MAINTENANCE_DELETION_MARKER])) {
      throw new Error('staging maintenance deletion transaction has no exact claim');
    }
    validateEmptyMarker(binding, markerPath);
    assertMaintenanceRoot(binding);
    filesystem.unlinkSync(markerPath);
    binding.synchronizeDirectory(transactionPath, filesystem);
    maintenanceTransition(binding, 'marker-removed', transactionPath);
    removeDeletionTransaction(binding, transactionPath, transactionIdentity);
    return;
  }

  const claim = readDeletionClaim(binding, transactionPath, transaction);
  if (names.includes(MAINTENANCE_DELETION_MARKER_PENDING)) {
    if (names.includes(MAINTENANCE_DELETION_MARKER)
        || !names.includes(MAINTENANCE_DELETION_PAYLOAD)) {
      throw new Error('staging maintenance deletion pending marker is ambiguous');
    }
    validateEmptyMarker(binding, markerPendingPath);
    discardPendingRecord(binding, transactionPath,
      MAINTENANCE_DELETION_MARKER_PENDING, 1);
    names = boundedDirectoryNames(transactionPath, 6, filesystem);
  }

  let payloadPresent = names.includes(MAINTENANCE_DELETION_PAYLOAD);
  let markerPresent = names.includes(MAINTENANCE_DELETION_MARKER);
  if (!payloadPresent && !markerPresent) {
    const source = validateUnmovedSource(binding, claim);
    assertMissing(filesystem, moved, 'staging maintenance deletion destination');
    assertMaintenanceRoot(binding);
    filesystem.renameSync(source, moved);
    binding.synchronizeDirectory(transactionPath, filesystem);
    binding.synchronizeDirectory(binding.controlRoot, filesystem);
    assertMaintenanceRoot(binding);
    const movedIdentity = filesystem.lstatSync(moved);
    if (!sameIdentity(movedIdentity, claim.containerIdentity)) {
      throw new Error('staging maintenance deletion move did not preserve identity');
    }
    payloadPresent = true;
    maintenanceTransition(binding, 'payload-moved', transactionPath);
  }

  if (payloadPresent && !markerPresent) {
    validateMovedRemainder(binding, moved, claim, { deletionArmed: false });
    publishPrivateRecord(
      binding,
      transactionPath,
      MAINTENANCE_DELETION_MARKER_PENDING,
      MAINTENANCE_DELETION_MARKER,
      Buffer.alloc(0),
    );
    markerPresent = true;
    maintenanceTransition(binding, 'marker-published', transactionPath);
  }

  if (!markerPresent) {
    throw new Error('staging maintenance deletion transaction is not armed');
  }
  validateEmptyMarker(binding, markerPath);
  if (payloadPresent) {
    validateMovedRemainder(binding, moved, claim, { deletionArmed: true });
    assertMaintenanceRoot(binding);
    binding.removeRetainedTree(moved, filesystem);
    binding.synchronizeDirectory(transactionPath, filesystem);
    assertMaintenanceRoot(binding);
    if (!pathIsAbsent(filesystem, moved)) {
      throw new Error('staging maintenance deletion payload still exists');
    }
    maintenanceTransition(binding, 'payload-removed', transactionPath);
  }

  const finalNames = boundedDirectoryNames(transactionPath, 4, filesystem);
  if (JSON.stringify(finalNames)
      !== JSON.stringify([MAINTENANCE_DELETION_CLAIM, MAINTENANCE_DELETION_MARKER])) {
    throw new Error('staging maintenance deletion completion contains foreign evidence');
  }
  readDeletionClaim(binding, transactionPath, transaction);
  validateEmptyMarker(binding, markerPath);
  assertMaintenanceRoot(binding);
  filesystem.unlinkSync(claimPath);
  binding.synchronizeDirectory(transactionPath, filesystem);
  maintenanceTransition(binding, 'claim-removed', transactionPath);
  validateEmptyMarker(binding, markerPath);
  filesystem.unlinkSync(markerPath);
  binding.synchronizeDirectory(transactionPath, filesystem);
  maintenanceTransition(binding, 'marker-removed', transactionPath);
  removeDeletionTransaction(binding, transactionPath, transactionIdentity);
}

function recoverMaintenanceDeletions(binding) {
  assertMaintenanceRoot(binding);
  const names = boundedDirectoryNames(
    binding.controlRoot, MAX_MAINTENANCE_ENTRIES, binding.proof.filesystem,
  );
  const reserved = names.filter((name) => name.startsWith(MAINTENANCE_DELETION_PREFIX));
  const malformed = reserved.find((name) => !MAINTENANCE_DELETION_NAME.test(name));
  if (malformed !== undefined) {
    throw new Error('staging maintenance reserved deletion namespace name is invalid');
  }
  const transactions = reserved;
  if (transactions.length > MAX_MAINTENANCE_DELETIONS) {
    throw new Error('staging maintenance deletion transaction bound is exhausted');
  }
  for (const transaction of transactions) {
    resumeMaintenanceDeletion(binding, transaction);
  }
  assertMaintenanceRoot(binding);
}

export function bindStagingQuiescentMaintenanceRoot(lockProof, controlRoot, {
  onMaintenanceTransition = () => {},
  randomToken = () => randomBytes(32).toString('hex'),
  removeRetainedTree = (entry, filesystem) => {
    filesystem.rmSync(entry, { force: false, recursive: true });
  },
  synchronizeDirectory = syncDirectory,
} = {}) {
  const proof = LOCK_PROOFS.get(lockProof);
  if (!proof || typeof controlRoot !== 'string' || !path.isAbsolute(controlRoot)
      || path.resolve(controlRoot) !== controlRoot
      || typeof onMaintenanceTransition !== 'function'
      || typeof randomToken !== 'function'
      || typeof removeRetainedTree !== 'function'
      || typeof synchronizeDirectory !== 'function') {
    throw new Error('staging maintenance root binding is invalid');
  }
  assertLiveLock(proof);
  const rootIdentity = proof.filesystem.lstatSync(controlRoot);
  if (!ownedDirectory(rootIdentity, proof.userId, 0o700)) {
    throw new Error('staging maintenance control root is unsafe');
  }
  if (proof.allowedControlRoots !== undefined) {
    const allowed = proof.allowedControlRoots.get(controlRoot);
    if (!allowed || String(rootIdentity.dev) !== allowed.dev
        || String(rootIdentity.ino) !== allowed.ino) {
      throw new Error('POSIX release maintenance control root is outside its exact scope');
    }
  }
  const lease = randomToken();
  if (!TOKEN.test(lease)) throw new Error('staging maintenance lease is invalid');
  const authority = Object.freeze({
    descriptor: STAGING_QUIESCENT_MAINTENANCE_DESCRIPTOR,
    lease,
    ownerPid: proof.processId,
    ownerStartTime: proof.ownerStartTime,
    protocol: STAGING_QUIESCENT_MAINTENANCE_PROTOCOL,
    rootDev: String(rootIdentity.dev),
    rootIno: String(rootIdentity.ino),
  });
  const binding = {
    authority,
    controlRoot,
    onMaintenanceTransition,
    proof,
    randomToken,
    removeRetainedTree,
    rootIdentity,
    synchronizeDirectory,
  };
  recoverMaintenanceDeletions(binding);
  ROOT_AUTHORITIES.set(authority, binding);
  const reclaimRetainedEvidence = (request) => {
    if (exactKeys(request, ['authority', 'kind', 'root'])
        && request.kind === 'QUIESCENT_ABSENCE_PROOF') {
      if (!authorityMatches(authority, request.authority)
          || request.root !== controlRoot) {
        throw new Error('staging quiescent absence proof request is invalid');
      }
      // This request deliberately has no filesystem side effect.  It turns a
      // live closure backed by the inherited fd8 flock into a fresh liveness
      // assertion; a serialized authority object alone can never satisfy it.
      assertMaintenanceRoot(binding);
      const names = boundedDirectoryNames(
        controlRoot, MAX_MAINTENANCE_ENTRIES, proof.filesystem,
      );
      const reserved = names.filter((name) => name.startsWith(
        MAINTENANCE_DELETION_PREFIX,
      ));
      if (reserved.some((name) => !MAINTENANCE_DELETION_NAME.test(name))) {
        throw new Error('staging maintenance reserved deletion namespace name is invalid');
      }
      if (reserved.length !== 0) {
        throw new Error('staging quiescent absence proof has pending deletion evidence');
      }
      assertLiveLock(proof);
      assertMaintenanceRoot(binding);
      return true;
    }
    if (!exactKeys(request, [
      'authority', 'bounds', 'container', 'containerIdentity', 'kind', 'payload',
      'payloadIdentity', 'reservationBinding', 'root', 'tombstone',
    ]) || !authorityMatches(authority, request.authority) || request.root !== controlRoot
        || request.tombstone !== request.container
        || (request.kind !== 'CLAIMLESS_RESERVATION'
          && request.kind !== 'PUBLICATION' && request.kind !== 'RESERVATION_ONLY'
          && request.kind !== 'RETIREMENT')) {
      throw new Error('staging retained evidence reclaim request is invalid');
    }
    const maximumBytes = exactBound(
      request.bounds?.maximumBytes, MAX_MAINTENANCE_BYTES,
      'staging retained evidence maximum byte bound',
    );
    const maximumEntries = exactBound(
      request.bounds?.maximumEntries, MAX_MAINTENANCE_ENTRIES,
      'staging retained evidence maximum entry bound',
    );
    const containerIdentity = exactIdentity(request.containerIdentity);
    const claimless = request.kind === 'CLAIMLESS_RESERVATION';
    const reservationOnly = request.kind === 'RESERVATION_ONLY';
    if ((claimless || reservationOnly)
        !== (request.payload === null && request.payloadIdentity === null)
        || reservationOnly !== (request.reservationBinding !== null)
        || (!reservationOnly && request.reservationBinding !== null)) {
      throw new Error('staging retained evidence reclaim payload authority is invalid');
    }
    const payloadIdentity = claimless || reservationOnly
      ? null : exactIdentity(request.payloadIdentity);
    const reservationBinding = reservationOnly
      ? exactReservationBinding(request.reservationBinding) : null;
    const container = path.resolve(request.container);
    const payload = claimless || reservationOnly ? null : path.resolve(request.payload);
    if (request.container !== container || path.dirname(container) !== controlRoot
        || (!(claimless || reservationOnly)
          && (request.payload !== payload || payload !== path.join(container, 'payload')))) {
      throw new Error('staging retained evidence reclaim scope is invalid');
    }
    assertMaintenanceRoot(binding);
    const currentContainer = proof.filesystem.lstatSync(container);
    const currentPayload = claimless || reservationOnly
      ? null : proof.filesystem.lstatSync(payload);
    const reservation = claimless ? null : path.join(container, 'reservation.claim');
    const currentReservation = claimless ? null : proof.filesystem.lstatSync(reservation);
    const transaction = binding.randomToken();
    if (!TOKEN.test(transaction)) {
      throw new Error('staging maintenance deletion transaction token is invalid');
    }
    const claim = normalizedDeletionClaim({
      bounds: { maximumBytes, maximumEntries },
      containerIdentity,
      kind: request.kind,
      payloadIdentity,
      reservationBinding,
      reservationIdentity: currentReservation === null ? null : {
        dev: String(currentReservation.dev), ino: String(currentReservation.ino),
      },
      rootIdentity: { dev: String(rootIdentity.dev), ino: String(rootIdentity.ino) },
      sourceName: path.basename(container),
      transaction,
    });
    if (!sameIdentity(currentContainer, containerIdentity)
        || (!(claimless || reservationOnly)
          && !sameIdentity(currentPayload, payloadIdentity))) {
      throw new Error('staging retained evidence changed before reclaim');
    }
    validateUnmovedSource(binding, claim);
    const claimBytes = Buffer.from(canonicalJson(claim));
    if (claimBytes.length < 1
        || claimBytes.length > MAX_MAINTENANCE_DELETION_RECORD_BYTES) {
      throw new Error('staging maintenance deletion claim is unbounded');
    }
    const transactionName = `${MAINTENANCE_DELETION_PREFIX}${transaction}`;
    const transactionPath = path.join(controlRoot, transactionName);
    proof.filesystem.mkdirSync(transactionPath, { mode: 0o700, recursive: false });
    const transactionIdentity = validatePrivateDeletionDirectory(binding, transactionPath);
    if (String(transactionIdentity.dev) !== String(rootIdentity.dev)) {
      throw new Error('staging maintenance deletion transaction device is invalid');
    }
    binding.synchronizeDirectory(controlRoot, proof.filesystem);
    maintenanceTransition(binding, 'transaction-created', transactionPath);
    publishPrivateRecord(
      binding,
      transactionPath,
      MAINTENANCE_DELETION_CLAIM_PENDING,
      MAINTENANCE_DELETION_CLAIM,
      claimBytes,
    );
    maintenanceTransition(binding, 'claim-published', transactionPath);
    resumeMaintenanceDeletion(binding, transactionName);
    assertMaintenanceRoot(binding);
    if (!pathIsAbsent(proof.filesystem, container)
        || !pathIsAbsent(proof.filesystem, transactionPath)) {
      throw new Error('staging retained evidence deletion transaction did not complete');
    }
    return true;
  };
  const rotateRecoveryBatonEpoch = (request) => {
    if (!exactKeys(request, [
      'authority', 'directory', 'expectedIdentity', 'kind', 'names', 'root', 'source',
    ]) || !authorityMatches(authority, request.authority)
        || request.kind !== 'RECOVERY_BATON_EPOCH'
        || request.root !== controlRoot || !Array.isArray(request.names)
        || request.names.length < 2
        || request.names.length > MAX_MAINTENANCE_RECOVERY_BATON_LINKS
        || request.names[0] !== 'retirement.claim') {
      throw new Error('staging recovery baton epoch request is invalid');
    }
    const expectedIdentity = exactIdentity(request.expectedIdentity);
    const directory = path.resolve(request.directory);
    if (request.directory !== directory || path.dirname(directory) !== controlRoot
        || request.source !== path.join(directory, request.names.at(-1))) {
      throw new Error('staging recovery baton epoch scope is invalid');
    }
    const uniqueNames = new Set();
    for (const [index, name] of request.names.entries()) {
      if (path.basename(name) !== name || uniqueNames.has(name)
          || (index > 0 && !/^\.recovery-baton\.[a-f0-9]{64}\.claim$/u.test(name))) {
        throw new Error('staging recovery baton epoch names are invalid');
      }
      uniqueNames.add(name);
    }
    assertLiveLock(proof);
    const currentRoot = proof.filesystem.lstatSync(controlRoot);
    const currentDirectory = proof.filesystem.lstatSync(directory);
    if (!sameIdentity(rootIdentity, currentRoot)
        || !ownedDirectory(currentDirectory, proof.userId, 0o700)) {
      throw new Error('staging recovery baton epoch directory is unsafe');
    }
    for (const name of request.names) {
      const stat = proof.filesystem.lstatSync(path.join(directory, name));
      if (!stat.isFile?.() || stat.isSymbolicLink?.()
          || (proof.userId !== undefined && String(stat.uid) !== String(proof.userId))
          || String(stat.dev) !== expectedIdentity.dev
          || String(stat.ino) !== expectedIdentity.ino
          || Number(stat.nlink) !== request.names.length) {
        throw new Error('staging recovery baton epoch identity is invalid');
      }
    }
    for (let index = request.names.length - 1; index > 0; index -= 1) {
      assertLiveLock(proof);
      const entry = path.join(directory, request.names[index]);
      const stat = proof.filesystem.lstatSync(entry);
      if (String(stat.dev) !== expectedIdentity.dev
          || String(stat.ino) !== expectedIdentity.ino
          || Number(stat.nlink) !== index + 1) {
        throw new Error('staging recovery baton epoch changed during rotation');
      }
      proof.filesystem.unlinkSync(entry);
      binding.synchronizeDirectory(directory, proof.filesystem);
    }
    assertLiveLock(proof);
    const origin = proof.filesystem.lstatSync(path.join(directory, 'retirement.claim'));
    if (String(origin.dev) !== expectedIdentity.dev || String(origin.ino) !== expectedIdentity.ino
        || Number(origin.nlink) !== 1) {
      throw new Error('staging recovery baton epoch reset is invalid');
    }
    return true;
  };
  return Object.freeze({ authority, reclaimRetainedEvidence, rotateRecoveryBatonEpoch });
}
