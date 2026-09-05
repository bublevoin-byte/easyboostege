import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  consumePosixSessionRecoveryProof,
  movePosixDirectoryNoReplace,
} from './posix-session-supervisor.js';

export const STAGING_DEADLINE_PROTOCOL = 'easyboost-staging-deadline-v1';

const TOKEN_PATTERN = /^[a-f0-9]{64}$/u;
const TRANSITIONS = new Set(['DISARM', 'ROLLOVER']);
const ACKNOWLEDGEMENT_STATES = new Set(['DISARMED', 'RECOVERY', 'TRANSACTION']);
const MAX_MESSAGE_BYTES = 2_048;
const MAX_RECOVERY_BATON_LINKS = 32;
const MAX_TERMINAL_SLOTS = 1_024;
const MAX_TERMINAL_SLOT_BYTES = 64 * 1_024;
const MAX_TERMINAL_SLOT_ENTRIES = 64;
const STAGING_DEADLINE_TERMINAL_SLOT_PROTOCOL = 'easyboost-staging-deadline-terminal-slot-v1';
const STAGING_QUARANTINE_SLOT_SEED = 'easyboost-staging-quarantine-slot-v1';
const STAGING_QUARANTINE_SLOT_PREFIX = '.easyboost-staging-quarantine-slot.';
const STAGING_QUARANTINE_SLOT_SUFFIX = '.tombstone';
const STAGING_QUARANTINE_SLOT_TOKENS = Object.freeze(Array.from(
  { length: MAX_TERMINAL_SLOTS },
  (_, index) => createHash('sha256')
    .update(`${STAGING_QUARANTINE_SLOT_SEED}\0${index}`, 'utf8')
    .digest('hex'),
));
const STAGING_QUARANTINE_SLOT_TOKEN_SET = new Set(STAGING_QUARANTINE_SLOT_TOKENS);
// Terminal evidence lives in one of 1024 root-global, deterministic private
// containers.  An exclusive mkdir reserves count and byte capacity before authority
// mutation.  The active JS protocol never removes a container: ordinary
// success is reclaimed only by an explicitly injected owner-maintenance
// callback holding the immutable launcher's process-lifetime fd8 flock.  The
// callback independently compares both container and payload identities; any
// mismatch, absent proof, callback failure, or crash leaves the exact slot for
// offline/quiescent replay.  Thus a successor pathname is never deleted by a
// stale JS validation and retained evidence remains finitely bounded.
export const STAGING_QUIESCENT_MAINTENANCE_PROTOCOL =
  'easyboost-staging-quiescent-maintenance-v1';
export const STAGING_QUIESCENT_MAINTENANCE_DESCRIPTOR = 8;
export const STAGING_DEADLINE_CONTROL_ENVIRONMENT = 'EASYBOOST_STAGING_DEADLINE_CONTROL';
const STAGING_DEADLINE_RECOVERY_HANDOFF_PROTOCOL =
  'easyboost-staging-deadline-recovery-handoff-v1';
const DEADLINE_RECOVERY_PROOFS = new WeakMap();

function canonicalJson(value) {
  return `${JSON.stringify(value)}\n`;
}

function syncDirectory(directory) {
  if (process.platform === 'win32' && process.env.NODE_TEST_CONTEXT) return;
  const descriptor = fs.openSync(directory, 'r');
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}

function sameFileIdentity(left, right) {
  return String(left.dev) === String(right.dev) && String(left.ino) === String(right.ino);
}

function withOpenFileIdentity(filesystem, entry, label, operation) {
  // Windows denies the rename/unlink attack while the file is open, but it also
  // denies the legitimate parent-directory rename used by tombstone validation.
  // POSIX permits both, so retain an open descriptor there to prevent inode reuse.
  if (process.platform === 'win32') {
    const identity = filesystem.lstatSync(entry);
    if (!identity.isFile() || identity.isSymbolicLink()) {
      throw new Error(`${label} changed before validation`);
    }
    return operation(identity);
  }
  let descriptor;
  try {
    descriptor = filesystem.openSync(entry, 'r');
    const identity = filesystem.fstatSync(descriptor);
    const pathnameIdentity = filesystem.lstatSync(entry);
    if (!identity.isFile() || pathnameIdentity.isSymbolicLink()
        || !sameFileIdentity(identity, pathnameIdentity)) {
      throw new Error(`${label} changed before validation`);
    }
    return operation(identity);
  } finally {
    if (descriptor !== undefined) filesystem.closeSync(descriptor);
  }
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

function assertPathAbsent(filesystem, entry, label) {
  if (!pathIsAbsent(filesystem, entry)) throw new Error(`${label} still exists`);
}

export function writeDurableStagingDeadlineRecord(file, bytes, {
  filesystem = fs,
  synchronizeDirectory = syncDirectory,
} = {}) {
  const destination = path.resolve(file);
  const destinationDirectory = path.dirname(destination);
  let descriptor;
  let created = false;
  let failure;
  try {
    // The record is an exclusive fail-closed journal entry.  A crash may leave
    // an incomplete destination, which typed recovery retains, but the writer
    // never creates a second pathname that would later require ABA-unsafe
    // unlink/rollback cleanup.
    descriptor = filesystem.openSync(destination, 'wx', 0o600);
    created = true;
    filesystem.writeFileSync(descriptor, bytes);
    filesystem.fsyncSync(descriptor);
  } catch (error) {
    failure = error;
  }
  if (descriptor !== undefined) {
    try { filesystem.closeSync(descriptor); } catch (error) { failure ??= error; }
  }
  if (!failure) {
    try { synchronizeDirectory(destinationDirectory); } catch (error) { failure = error; }
  }
  if (failure) {
    if (created) {
      failure.recoveryAuthority = Object.freeze({ controlDirectory: destinationDirectory });
    }
    throw failure;
  }
}

function writeDurableStagingDeadlineReadyMarker(file, {
  filesystem = fs,
  synchronizeDirectory = syncDirectory,
} = {}) {
  const marker = path.resolve(file);
  const directory = path.dirname(marker);
  let descriptor;
  let created = false;
  let failure;
  try {
    descriptor = filesystem.openSync(marker, 'wx', 0o600);
    created = true;
    filesystem.fsyncSync(descriptor);
  } catch (error) {
    failure = error;
  }
  if (descriptor !== undefined) {
    try { filesystem.closeSync(descriptor); } catch (error) { failure ??= error; }
  }
  if (!failure) {
    try { synchronizeDirectory(directory); } catch (error) { failure = error; }
  }
  if (failure) {
    if (created) failure.recoveryAuthority = Object.freeze({ controlDirectory: directory });
    throw failure;
  }
}

function exactIdentityMatches(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function publishDurableStagingDeadlineMessage(file, bytes, {
  synchronizeDirectory = syncDirectory,
} = {}) {
  if (typeof synchronizeDirectory !== 'function') {
    throw new Error('staging deadline message directory synchronizer is invalid');
  }
  const recordPath = path.resolve(file);
  const directory = path.dirname(recordPath);
  const directoryIdentity = safeOwnedRecoveryDirectory(
    directory, 'staging deadline message directory',
  );
  let recordIdentity;
  try {
    writeDurableStagingDeadlineRecord(recordPath, bytes, { synchronizeDirectory });
    const written = readStableDeadlineFile(recordPath, {
      allowEmpty: false,
      label: 'staging deadline message record',
    });
    if (written.state !== 'present' || !written.bytes.equals(bytes)) {
      throw written.error ?? new Error('staging deadline message record is not exact');
    }
    recordIdentity = written.identity;
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    const existing = readStableDeadlineFile(recordPath, {
      allowEmpty: false,
      label: 'staging deadline existing message record',
    });
    if (existing.state !== 'present' || !existing.bytes.equals(bytes)) {
      throw existing.error ?? new Error('staging deadline existing message record conflicts');
    }
    recordIdentity = existing.identity;
    // An exact unsealed record may be completed after a crash only after its
    // already-published bytes and directory entry are made durable again.
    synchronizeDirectory(directory);
    const durable = readStableDeadlineFile(recordPath, {
      allowEmpty: false,
      label: 'staging deadline durable existing message record',
    });
    if (durable.state !== 'present' || !durable.bytes.equals(bytes)
        || !exactIdentityMatches(durable.identity, recordIdentity)) {
      throw durable.error ?? new Error('staging deadline existing message record changed');
    }
  }

  const markerPath = deadlineReadyPath(recordPath);
  try {
    writeDurableStagingDeadlineReadyMarker(markerPath, { synchronizeDirectory });
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    const marker = readStableDeadlineReadyMarker(markerPath);
    if (marker.state !== 'present') {
      throw marker.error ?? new Error('staging deadline existing ready marker is invalid');
    }
    // A crash after exclusive marker creation but before its directory fsync
    // leaves the correct semantic publication point visible.  Replay never
    // replaces it: it re-fsyncs the parent and proves the same exact marker.
    synchronizeDirectory(directory);
    const durableMarker = readStableDeadlineReadyMarker(markerPath);
    if (durableMarker.state !== 'present'
        || !exactIdentityMatches(durableMarker.identity, marker.identity)) {
      throw durableMarker.error
        ?? new Error('staging deadline existing ready marker changed during replay');
    }
  }

  const published = readPublishedDeadlineFile(recordPath, (value) => value);
  if (published.state !== 'present' || !published.record.equals(bytes)
      || !exactIdentityMatches(published.identity, recordIdentity)) {
    throw published.error ?? new Error('staging deadline published message changed');
  }
  const finalDirectory = safeOwnedRecoveryDirectory(
    directory, 'staging deadline message directory',
  );
  if (!sameFileIdentity(directoryIdentity, finalDirectory)) {
    throw new Error('staging deadline message directory changed during publication');
  }
}

const durableExclusiveWrite = writeDurableStagingDeadlineRecord;

function terminalSlotName(index) {
  return `${STAGING_QUARANTINE_SLOT_PREFIX}${STAGING_QUARANTINE_SLOT_TOKENS[index]}`
    + STAGING_QUARANTINE_SLOT_SUFFIX;
}

function exactTerminalSlotPath(root, entry) {
  const slot = path.resolve(entry);
  const name = path.basename(slot);
  const token = name.startsWith(STAGING_QUARANTINE_SLOT_PREFIX)
    && name.endsWith(STAGING_QUARANTINE_SLOT_SUFFIX)
    ? name.slice(STAGING_QUARANTINE_SLOT_PREFIX.length,
      -STAGING_QUARANTINE_SLOT_SUFFIX.length)
    : '';
  if (path.dirname(slot) !== root || !TOKEN_PATTERN.test(token)
      || !STAGING_QUARANTINE_SLOT_TOKEN_SET.has(token)) {
    throw new Error('staging deadline terminal slot path is invalid');
  }
  return slot;
}

function exactTerminalSlotRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || value.protocol !== STAGING_DEADLINE_TERMINAL_SLOT_PROTOCOL
      || !TOKEN_PATTERN.test(value.owner ?? '')
      || typeof value.source !== 'string' || !path.isAbsolute(value.source)) {
    throw new Error('staging deadline terminal slot reservation is invalid');
  }
  const keys = Object.keys(value).sort();
  if (value.purpose === 'PUBLICATION'
      && JSON.stringify(keys)
        === JSON.stringify(['destination', 'owner', 'protocol', 'purpose', 'source'])
      && typeof value.destination === 'string' && path.isAbsolute(value.destination)) {
    return Object.freeze({
      destination: path.resolve(value.destination),
      owner: value.owner,
      protocol: value.protocol,
      purpose: value.purpose,
      source: path.resolve(value.source),
    });
  }
  if (value.purpose === 'RETIREMENT'
      && JSON.stringify(keys) === JSON.stringify([
        'owner', 'protocol', 'purpose', 'source', 'sourceDev', 'sourceFingerprint', 'sourceIno',
      ])
      && /^(?:0|[1-9]\d*)$/u.test(value.sourceDev ?? '')
      && /^(?:0|[1-9]\d*)$/u.test(value.sourceIno ?? '')
      && TOKEN_PATTERN.test(value.sourceFingerprint ?? '')) {
    return Object.freeze({
      owner: value.owner,
      protocol: value.protocol,
      purpose: value.purpose,
      source: path.resolve(value.source),
      sourceDev: value.sourceDev,
      sourceFingerprint: value.sourceFingerprint,
      sourceIno: value.sourceIno,
    });
  }
  throw new Error('staging deadline terminal slot reservation is invalid');
}

function readExactTerminalSlotRecord(container, filesystem = fs) {
  const claim = path.join(container, 'reservation.claim');
  const bytes = filesystem.readFileSync(claim);
  if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > MAX_MESSAGE_BYTES) {
    throw new Error('staging deadline terminal slot reservation is unbounded');
  }
  const record = exactTerminalSlotRecord(JSON.parse(bytes.toString('utf8')));
  if (!Buffer.from(canonicalJson(record)).equals(bytes)) {
    throw new Error('staging deadline terminal slot reservation is not canonical');
  }
  return record;
}

function terminalSlotMatches(record, expected) {
  const correlationMatches = record.purpose === expected.purpose
    && record.source === expected.source && record.destination === expected.destination;
  if (!correlationMatches || record.purpose !== 'RETIREMENT'
      || expected.sourceDev === undefined) return correlationMatches;
  return record.sourceDev === expected.sourceDev
    && record.sourceIno === expected.sourceIno
    && record.sourceFingerprint === expected.sourceFingerprint;
}

function hasUnboundRetirementSlotCorrelation(container, expected, filesystem) {
  if (expected.purpose !== 'RETIREMENT' || expected.sourceDev === undefined) return false;
  try {
    const bytes = filesystem.readFileSync(path.join(container, 'reservation.claim'));
    if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > MAX_MESSAGE_BYTES) {
      return false;
    }
    const record = JSON.parse(bytes.toString('utf8'));
    return record && typeof record === 'object' && !Array.isArray(record)
      && JSON.stringify(Object.keys(record).sort())
        === JSON.stringify(['owner', 'protocol', 'purpose', 'source'])
      && record.protocol === STAGING_DEADLINE_TERMINAL_SLOT_PROTOCOL
      && record.purpose === 'RETIREMENT' && TOKEN_PATTERN.test(record.owner ?? '')
      && typeof record.source === 'string' && path.isAbsolute(record.source)
      && path.resolve(record.source) === expected.source
      && Buffer.from(canonicalJson(record)).equals(bytes);
  } catch {
    return false;
  }
}

function findExactTerminalSlots(root, expected, filesystem = fs) {
  const names = filesystem.readdirSync(root);
  if (names.length > 8_192) throw new Error('staging deadline terminal slot root is unbounded');
  const matches = [];
  for (const name of names) {
    if (!name.startsWith(STAGING_QUARANTINE_SLOT_PREFIX)
        || !name.endsWith(STAGING_QUARANTINE_SLOT_SUFFIX)) continue;
    let container;
    try {
      container = exactTerminalSlotPath(root, path.join(root, name));
      const slotIdentity = filesystem.lstatSync(container);
      if (!slotIdentity.isDirectory() || slotIdentity.isSymbolicLink()) continue;
      const record = readExactTerminalSlotRecord(container, filesystem);
      if (terminalSlotMatches(record, expected)) {
        matches.push(container);
      } else if (record.purpose === 'RETIREMENT' && expected.purpose === 'RETIREMENT'
          && record.source === expected.source && expected.sourceDev !== undefined) {
        const mismatch = new Error('staging deadline terminal slot source binding does not match');
        mismatch.code = 'STAGING_DEADLINE_RETIREMENT_SOURCE_BINDING_MISMATCH';
        mismatch.recoveryAuthority = Object.freeze({ tombstone: container });
        throw mismatch;
      }
    } catch (error) {
      if (error?.code === 'STAGING_DEADLINE_RETIREMENT_SOURCE_BINDING_MISMATCH') throw error;
      if (hasUnboundRetirementSlotCorrelation(container, expected, filesystem)) {
        const mismatch = new Error(
          'staging deadline terminal slot has no retirement source binding',
        );
        mismatch.code = 'STAGING_DEADLINE_RETIREMENT_SOURCE_BINDING_MISMATCH';
        mismatch.recoveryAuthority = Object.freeze({ tombstone: container });
        throw mismatch;
      }
      // An invalid or incomplete reservation is retained evidence.  It still
      // occupies its fixed slot, but cannot be adopted for another source.
    }
  }
  return matches;
}

function reserveTerminalSlot(root, expected, {
  filesystem = fs,
  synchronizeDirectory = syncDirectory,
} = {}) {
  const rootIdentity = filesystem.lstatSync(root);
  const start = randomBytes(2).readUInt16BE(0) % MAX_TERMINAL_SLOTS;
  for (let offset = 0; offset < MAX_TERMINAL_SLOTS; offset += 1) {
    const index = (start + offset) % MAX_TERMINAL_SLOTS;
    const container = path.join(root, terminalSlotName(index));
    try {
      filesystem.mkdirSync(container, { mode: 0o700 });
    } catch (error) {
      if (error?.code === 'EEXIST') continue;
      throw error;
    }
    try {
      // mkdir is the interprocess quota reservation.  There is deliberately no
      // scan-then-create window and no rollback removal: an ambiguous slot is
      // durable, bounded evidence for owner maintenance.
      synchronizeDirectory(root);
      const currentRoot = filesystem.lstatSync(root);
      const slotIdentity = filesystem.lstatSync(container);
      if (!sameFileIdentity(rootIdentity, currentRoot)
          || !slotIdentity.isDirectory() || slotIdentity.isSymbolicLink()) {
        throw new Error('staging deadline terminal slot changed during reservation');
      }
      const record = exactTerminalSlotRecord({
        ...expected,
        owner: randomBytes(32).toString('hex'),
        protocol: STAGING_DEADLINE_TERMINAL_SLOT_PROTOCOL,
      });
      writeDurableStagingDeadlineRecord(
        path.join(container, 'reservation.claim'), Buffer.from(canonicalJson(record)), {
          filesystem,
          synchronizeDirectory,
        },
      );
      return Object.freeze({ container, record, rootIdentity, slotIdentity });
    } catch (error) {
      error.recoveryAuthority = Object.freeze({ tombstone: container });
      throw error;
    }
  }
  const exhausted = new Error('staging deadline terminal slot quota is exhausted');
  exhausted.code = 'STAGING_DEADLINE_TERMINAL_SLOT_QUOTA_EXHAUSTED';
  throw exhausted;
}

function reserveOrReuseTerminalSlot(root, expected, options = {}) {
  const matches = findExactTerminalSlots(root, expected, options.filesystem ?? fs);
  if (matches.length > 1) {
    throw new Error('staging deadline terminal slot replay is ambiguous');
  }
  if (matches.length === 1) {
    const container = matches[0];
    return Object.freeze({
      container,
      record: readExactTerminalSlotRecord(container, options.filesystem ?? fs),
      rootIdentity: (options.filesystem ?? fs).lstatSync(root),
      slotIdentity: (options.filesystem ?? fs).lstatSync(container),
    });
  }
  return reserveTerminalSlot(root, expected, options);
}

function boundedTerminalPayload(payload, {
  expectedIdentity,
  expectedKind,
  filesystem = fs,
} = {}) {
  const stat = filesystem.lstatSync(payload);
  if (stat.isSymbolicLink() || !sameFileIdentity(stat, expectedIdentity)) {
    throw new Error('staging deadline terminal payload changed');
  }
  if (expectedKind === 'PUBLICATION') {
    if (!stat.isFile() || stat.nlink < 1 || stat.nlink > 2
        || stat.size < 0 || stat.size > MAX_MESSAGE_BYTES) {
      throw new Error('staging deadline terminal publication payload is unsafe or unbounded');
    }
    return Object.freeze({ bytes: Number(stat.size), entries: 1, identity: stat });
  }
  if (!stat.isDirectory()) {
    throw new Error('staging deadline terminal retirement payload is unsafe');
  }
  const names = filesystem.readdirSync(payload);
  if (names.length > MAX_TERMINAL_SLOT_ENTRIES) {
    throw new Error('staging deadline terminal retirement payload is unbounded');
  }
  let bytes = 0;
  const identities = new Set();
  for (const name of names) {
    const child = filesystem.lstatSync(path.join(payload, name));
    if (!child.isFile() || child.isSymbolicLink() || child.nlink < 1
        || child.size < 0 || child.size > MAX_MESSAGE_BYTES) {
      throw new Error('staging deadline terminal retirement payload is unsafe or unbounded');
    }
    const key = `${String(child.dev)}:${String(child.ino)}`;
    if (!identities.has(key)) {
      identities.add(key);
      bytes += Number(child.size);
    }
    if (bytes > MAX_TERMINAL_SLOT_BYTES) {
      throw new Error('staging deadline terminal retirement payload byte bound is exhausted');
    }
  }
  return Object.freeze({ bytes, entries: names.length, identity: stat });
}

function exactQuiescentMaintenanceAuthority(authority, root, rootIdentity) {
  const expectedKeys = ['descriptor', 'lease', 'ownerPid', 'ownerStartTime', 'protocol',
    'rootDev', 'rootIno'];
  if (!authority || typeof authority !== 'object' || Array.isArray(authority)
      || JSON.stringify(Object.keys(authority).sort()) !== JSON.stringify(expectedKeys)
      || authority.descriptor !== STAGING_QUIESCENT_MAINTENANCE_DESCRIPTOR
      || authority.protocol !== STAGING_QUIESCENT_MAINTENANCE_PROTOCOL
      || !TOKEN_PATTERN.test(authority.lease ?? '')
      || !Number.isSafeInteger(authority.ownerPid) || authority.ownerPid <= 0
      || typeof authority.ownerStartTime !== 'string'
      || !/^[1-9][0-9]*$/u.test(authority.ownerStartTime)
      || typeof authority.rootDev !== 'string' || typeof authority.rootIno !== 'string'
      || authority.rootDev !== String(rootIdentity.dev)
      || authority.rootIno !== String(rootIdentity.ino)
      || path.resolve(root) !== root) {
    throw new Error('staging quiescent maintenance authority is invalid');
  }
  return Object.freeze({
    descriptor: authority.descriptor,
    lease: authority.lease,
    ownerPid: authority.ownerPid,
    ownerStartTime: authority.ownerStartTime,
    protocol: authority.protocol,
    rootDev: authority.rootDev,
    rootIno: authority.rootIno,
  });
}

export function validateStagingQuiescentMaintenanceAuthority(authority, {
  controlRoot,
} = {}) {
  if (typeof controlRoot !== 'string' || !path.isAbsolute(controlRoot)) {
    throw new Error('staging quiescent maintenance control root is invalid');
  }
  const root = path.resolve(controlRoot);
  const rootIdentity = safeOwnedRecoveryDirectory(
    root, 'staging quiescent maintenance control root',
  );
  return exactQuiescentMaintenanceAuthority(authority, root, rootIdentity);
}

function maybeReclaimTerminalSlot({
  container,
  kind,
  payload,
  payloadIdentity,
  quiescentMaintenanceAuthority,
  reclaimRetainedEvidence,
  root,
  rootIdentity,
  synchronizeDirectory = syncDirectory,
}) {
  if (quiescentMaintenanceAuthority === undefined
      && reclaimRetainedEvidence === undefined) return false;
  if (typeof reclaimRetainedEvidence !== 'function') {
    throw new Error('staging retained evidence reclaimer is invalid');
  }
  const currentRoot = safeOwnedRecoveryDirectory(
    root, 'staging quiescent maintenance control root',
  );
  if (!sameFileIdentity(rootIdentity, currentRoot)) {
    throw new Error('staging quiescent maintenance root changed');
  }
  const authority = exactQuiescentMaintenanceAuthority(
    quiescentMaintenanceAuthority, root, currentRoot,
  );
  const containerIdentity = safeOwnedRecoveryDirectory(
    container, 'staging retained evidence container',
  );
  const result = reclaimRetainedEvidence(Object.freeze({
    authority,
    bounds: Object.freeze({
      maximumBytes: MAX_TERMINAL_SLOT_BYTES,
      maximumEntries: MAX_TERMINAL_SLOT_ENTRIES,
    }),
    container,
    containerIdentity: Object.freeze({
      dev: String(containerIdentity.dev),
      ino: String(containerIdentity.ino),
    }),
    kind,
    payload,
    payloadIdentity: Object.freeze({
      dev: String(payloadIdentity.dev),
      ino: String(payloadIdentity.ino),
    }),
    reservationBinding: null,
    root,
    tombstone: container,
  }));
  if (result !== true) return false;
  // The immutable launcher owns the process-lifetime flock and performs the
  // pathname operation.  JS only accepts its attestation after proving that
  // the operational source is absent and the authenticated root is unchanged.
  if (!pathIsAbsent(fs, container)) {
    throw new Error('staging retained evidence reclaimer did not retire its slot');
  }
  synchronizeDirectory(root);
  const finalRoot = safeOwnedRecoveryDirectory(root,
    'staging quiescent maintenance control root');
  if (!sameFileIdentity(rootIdentity, finalRoot)) {
    throw new Error('staging quiescent maintenance root changed');
  }
  return true;
}

function publicationSlotExpectation(destination, temporary) {
  return Object.freeze({
    destination,
    purpose: 'PUBLICATION',
    source: temporary,
  });
}

export function cleanupStagingDeadlinePublicationResidue(authority, {
  beforeUnlink = () => {},
  filesystem = fs,
  quiescentMaintenanceAuthority,
  reclaimRetainedEvidence,
  requireReclaimedPublication = false,
  synchronizeDirectory = syncDirectory,
} = {}) {
  let retainedTombstone;
  const failure = (cause) => {
    const error = new Error('staging deadline private publication cleanup required', { cause });
    error.code = 'STAGING_DEADLINE_PUBLICATION_CLEANUP_REQUIRED';
    error.recoveryAuthority = Object.freeze(retainedTombstone
      ? { destination: authority?.destination, temporary: authority?.temporary,
        tombstone: retainedTombstone }
      : { destination: authority?.destination, temporary: authority?.temporary });
    return error;
  };
  try {
    const keys = authority && Object.keys(authority).sort();
    if (!authority || (JSON.stringify(keys) !== JSON.stringify(['destination', 'temporary'])
        && JSON.stringify(keys)
          !== JSON.stringify(['destination', 'temporary', 'tombstone']))) {
      throw new Error('staging deadline publication authority is not exact');
    }
    const destination = path.resolve(authority.destination);
    const temporary = path.resolve(authority.temporary);
    const directory = path.dirname(destination);
    const root = path.dirname(directory);
    const temporaryName = path.basename(temporary);
    const temporaryPrefix = `.${path.basename(directory)}.${path.basename(destination)}.`;
    if (path.dirname(temporary) !== root || !temporaryName.startsWith(temporaryPrefix)
        || !/^[0-9a-f]{32}\.tmp$/u.test(temporaryName.slice(temporaryPrefix.length))) {
      throw new Error('staging deadline publication residue paths are not private siblings');
    }
    const rootIdentity = safeOwnedRecoveryDirectory(root,
      'staging deadline publication root');
    safeOwnedRecoveryDirectory(directory, 'staging deadline publication directory');
    const expected = publicationSlotExpectation(destination, temporary);
    let tombstone = authority.tombstone === undefined
      ? null : exactTerminalSlotPath(root, authority.tombstone);
    if (tombstone === null) {
      const matches = findExactTerminalSlots(root, expected, filesystem);
      if (matches.length > 1) {
        throw new Error('staging deadline publication tombstone replay is ambiguous');
      }
      [tombstone] = matches;
    }
    if (tombstone !== null && tombstone !== undefined) {
      retainedTombstone = tombstone;
      if (!terminalSlotMatches(readExactTerminalSlotRecord(tombstone, filesystem), expected)) {
        throw new Error('staging deadline publication tombstone authority does not match');
      }
    } else {
      tombstone = null;
    }
    let destinationIdentity = null;
    try {
      destinationIdentity = filesystem.lstatSync(destination);
      if (!destinationIdentity.isFile() || destinationIdentity.isSymbolicLink()
          || destinationIdentity.size > MAX_MESSAGE_BYTES) {
        throw new Error('staging deadline publication destination is unsafe or unbounded');
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    if (tombstone === null && pathIsAbsent(filesystem, temporary)) {
      synchronizeDirectory(root);
      assertPathAbsent(filesystem, temporary,
        'staging deadline original publication residue path');
      return true;
    }
    const payload = tombstone === null ? temporary : path.join(tombstone, 'payload');
    let sourceIdentity;
    if (tombstone !== null && pathIsAbsent(filesystem, payload)) {
      if (pathIsAbsent(filesystem, temporary)) {
        throw new Error('staging deadline publication terminal payload is missing');
      }
      const containerIdentity = filesystem.lstatSync(tombstone);
      sourceIdentity = withOpenFileIdentity(filesystem, temporary,
        'staging deadline publication residue', (identity) => {
          beforeUnlink(Object.freeze({ destination, temporary, tombstone }));
          const current = filesystem.lstatSync(temporary);
          const currentContainer = filesystem.lstatSync(tombstone);
          if (!sameFileIdentity(identity, current)
              || !sameFileIdentity(containerIdentity, currentContainer)
              || !terminalSlotMatches(readExactTerminalSlotRecord(tombstone, filesystem), expected)) {
            throw new Error('staging deadline publication residue changed before quarantine');
          }
          filesystem.renameSync(temporary, payload);
          return identity;
        });
    } else if (tombstone === null) {
      sourceIdentity = withOpenFileIdentity(filesystem, temporary,
        'staging deadline publication residue', (identity) => {
          beforeUnlink(Object.freeze({ destination, temporary }));
          const current = filesystem.lstatSync(temporary);
          if (!sameFileIdentity(identity, current)) {
            throw new Error('staging deadline publication residue changed before quarantine');
          }
          const reserved = reserveTerminalSlot(root, expected,
            { filesystem, synchronizeDirectory });
          tombstone = reserved.container;
          retainedTombstone = tombstone;
          filesystem.renameSync(temporary, path.join(tombstone, 'payload'));
          return identity;
        });
    } else {
      const containerIdentity = filesystem.lstatSync(tombstone);
      sourceIdentity = withOpenFileIdentity(filesystem, payload,
        'staging deadline publication tombstone payload', (identity) => {
          beforeUnlink(Object.freeze({ destination, temporary, tombstone }));
          const currentContainer = filesystem.lstatSync(tombstone);
          const currentPayload = filesystem.lstatSync(payload);
          if (!sameFileIdentity(containerIdentity, currentContainer)
              || !sameFileIdentity(identity, currentPayload)) {
            throw new Error('staging deadline publication tombstone changed before finalization');
          }
          return identity;
        });
    }
    retainedTombstone = tombstone;
    const activePayload = path.join(tombstone, 'payload');
    const expectedLinks = destinationIdentity === null ? 1 : 2;
    const payloadProof = boundedTerminalPayload(activePayload, {
      expectedIdentity: sourceIdentity,
      expectedKind: 'PUBLICATION',
      filesystem,
    });
    if (Number(payloadProof.identity.nlink) !== expectedLinks
        || (destinationIdentity !== null
          && (!sameFileIdentity(destinationIdentity, payloadProof.identity)
            || Number(destinationIdentity.nlink) !== expectedLinks))) {
      throw new Error('staging deadline publication residue link authority is invalid');
    }
    assertPathAbsent(filesystem, temporary,
      'staging deadline original publication residue path');
    synchronizeDirectory(tombstone);
    synchronizeDirectory(root);
    const durableRoot = filesystem.lstatSync(root);
    if (!sameFileIdentity(rootIdentity, durableRoot)) {
      throw new Error('staging deadline publication root changed during finalization');
    }
    const durable = boundedTerminalPayload(activePayload, {
      expectedIdentity: sourceIdentity,
      expectedKind: 'PUBLICATION',
      filesystem,
    });
    if (Number(durable.identity.nlink) !== expectedLinks) {
      throw new Error('staging deadline publication payload changed during finalization');
    }
    if (destinationIdentity === null) {
      assertPathAbsent(filesystem, destination, 'staging deadline publication destination');
    } else {
      const finalDestination = filesystem.lstatSync(destination);
      if (!sameFileIdentity(destinationIdentity, finalDestination)
          || Number(finalDestination.nlink) !== expectedLinks) {
        throw new Error('staging deadline publication destination changed during finalization');
      }
    }
    assertPathAbsent(filesystem, temporary,
      'staging deadline original publication residue path');
    const reclaimed = maybeReclaimTerminalSlot({
      container: tombstone,
      kind: 'PUBLICATION',
      payload: activePayload,
      payloadIdentity: sourceIdentity,
      quiescentMaintenanceAuthority,
      reclaimRetainedEvidence,
      root,
      rootIdentity,
      synchronizeDirectory,
    });
    if (requireReclaimedPublication && !reclaimed) {
      throw new Error('staging deadline publication evidence remains retained');
    }
    assertPathAbsent(filesystem, temporary,
      'staging deadline original publication residue path');
    return true;
  } catch (error) {
    if (error?.recoveryAuthority?.tombstone) {
      retainedTombstone = error.recoveryAuthority.tombstone;
    }
    throw failure(error);
  }
}

function exactDeadlinePublicationResidues(root, directory) {
  const names = fs.readdirSync(root);
  if (names.length > 4_096) throw new Error('staging deadline publication root is unbounded');
  const prefix = `.${path.basename(directory)}.`;
  const residues = [];
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith('.tmp')
        || !/^[0-9a-f]{32}$/u.test(name.slice(-36, -4))) continue;
    const destinationName = name.slice(prefix.length, -37);
    if (!/^(?:control\.json|retirement\.claim|ack-[0-2]\.json(?:\.ready)?|request-[12]\.json(?:\.ready)?)$/u
      .test(destinationName)) {
      throw new Error('staging deadline publication residue destination is invalid');
    }
    residues.push(Object.freeze({
      destination: path.join(directory, destinationName),
      temporary: path.join(root, name),
    }));
  }
  return Object.freeze(residues);
}

function recoverExactDeadlinePublicationResidues(root, directory, options) {
  for (const authority of exactDeadlinePublicationResidues(root, directory)) {
    cleanupStagingDeadlinePublicationResidue(authority, options);
  }
}

function linkedDeadlinePublicationTombstone(directory, file, identity) {
  const root = path.dirname(directory);
  const temporaryPrefix = `.${path.basename(directory)}.${path.basename(file)}.`;
  const matches = [];
  for (const name of fs.readdirSync(root)) {
    if (!name.startsWith(STAGING_QUARANTINE_SLOT_PREFIX)
        || !name.endsWith(STAGING_QUARANTINE_SLOT_SUFFIX)) continue;
    try {
      const container = exactTerminalSlotPath(root, path.join(root, name));
      const record = readExactTerminalSlotRecord(container);
      const temporaryName = path.basename(record.source);
      if (record.purpose !== 'PUBLICATION' || record.destination !== file
          || path.dirname(record.source) !== root
          || !temporaryName.startsWith(temporaryPrefix)
          || !/^[0-9a-f]{32}\.tmp$/u.test(temporaryName.slice(temporaryPrefix.length))
          || !pathIsAbsent(fs, record.source)) continue;
      const payload = path.join(container, 'payload');
      const alias = fs.lstatSync(payload);
      if (alias.isFile() && !alias.isSymbolicLink() && alias.nlink >= 2
          && String(alias.nlink) === String(identity.nlink)
          && sameFileIdentity(identity, alias)) matches.push(container);
    } catch {}
  }
  return matches.length === 1;
}

function moveOwnedDeadlineControlDirectory({
  directory,
  directoryIdentity,
  moveDirectoryNoReplace = movePosixDirectoryNoReplace,
  root,
  rootIdentity,
  sourceExpectation,
  synchronizeDirectory = syncDirectory,
  terminalSlot,
}) {
  if (typeof moveDirectoryNoReplace !== 'function' || !sourceExpectation) {
    throw new Error('staging deadline retirement handoff configuration is invalid');
  }
  boundedTerminalPayload(directory, {
    expectedIdentity: directoryIdentity,
    expectedKind: 'RETIREMENT',
  });
  assertDeadlineRetirementSourceBinding(
    directory, sourceExpectation, 'staging deadline retirement source before handoff',
  );
  let reserved = terminalSlot;
  try {
    reserved ??= reserveOrReuseTerminalSlot(root, sourceExpectation, { synchronizeDirectory });
    const record = readExactTerminalSlotRecord(reserved.container);
    const currentContainer = safeOwnedRecoveryDirectory(
      reserved.container, 'staging deadline retirement slot',
    );
    if (!sameFileIdentity(reserved.slotIdentity, currentContainer)
        || !terminalSlotMatches(record, sourceExpectation)) {
      throw new Error('staging deadline retirement slot authority does not match');
    }
    const payload = path.join(reserved.container, 'payload');
    if (!pathIsAbsent(fs, payload)) {
      throw new Error('staging deadline retirement slot payload is already occupied');
    }
    assertDeadlineRetirementSourceBinding(
      directory, record, 'staging deadline retirement source at no-replace handoff',
    );
    moveDirectoryNoReplace(directory, payload);
    synchronizeDirectory(reserved.container);
    synchronizeDirectory(root);
    const currentRoot = safeOwnedRecoveryDirectory(root, 'staging deadline control root');
    boundedTerminalPayload(payload, {
      expectedIdentity: directoryIdentity,
      expectedKind: 'RETIREMENT',
    });
    assertDeadlineRetirementSourceBinding(
      payload, record, 'staging deadline retained retirement payload',
    );
    if (!sameFileIdentity(rootIdentity, currentRoot)) {
      throw new Error('staging deadline retirement root changed during quarantine');
    }
    assertPathAbsent(fs, directory, 'staging deadline retired control directory');
    return reserved.container;
  } catch (cause) {
    if (reserved?.container && !cause?.recoveryAuthority?.tombstone) {
      cause.recoveryAuthority = Object.freeze({ tombstone: reserved.container });
    }
    throw deadlineRetirementClaimRequired(directory, cause);
  }
}

export function cleanupStagingDeadlineRetirementTombstone(authority, {
  beforeFinalize = () => {},
  quiescentMaintenanceAuthority,
  reclaimRetainedEvidence,
  requireReclaimedRetirement = false,
  synchronizeDirectory = syncDirectory,
} = {}) {
  if (!authority || JSON.stringify(Object.keys(authority).sort())
      !== JSON.stringify(['controlDirectory', 'tombstone'])) {
    throw new Error('staging deadline retirement tombstone authority is not exact');
  }
  const directory = path.resolve(authority.controlDirectory);
  const root = path.dirname(directory);
  const tombstone = exactTerminalSlotPath(root, authority.tombstone);
  const exactAuthority = Object.freeze({ controlDirectory: directory, tombstone });
  try {
    const rootIdentity = safeOwnedRecoveryDirectory(
      root, 'staging deadline retirement tombstone root',
    );
    assertPathAbsent(fs, directory, 'staging deadline retired control directory');
    let containerIdentity;
    try {
      containerIdentity = safeOwnedRecoveryDirectory(
        tombstone, 'staging deadline retirement tombstone',
      );
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      synchronizeDirectory(root);
      assertPathAbsent(fs, directory, 'staging deadline retired control directory');
      return true;
    }
    const record = readExactTerminalSlotRecord(tombstone);
    if (!terminalSlotMatches(record, { purpose: 'RETIREMENT', source: directory })) {
      throw new Error('staging deadline retirement tombstone authority does not match');
    }
    const payload = path.join(tombstone, 'payload');
    const payloadIdentity = safeOwnedRecoveryDirectory(
      payload, 'staging deadline retirement payload',
    );
    boundedTerminalPayload(payload, {
      expectedIdentity: payloadIdentity,
      expectedKind: 'RETIREMENT',
    });
    assertDeadlineRetirementSourceBinding(
      payload, record, 'staging deadline retirement payload',
    );
    beforeFinalize(exactAuthority);
    const finalContainer = safeOwnedRecoveryDirectory(tombstone,
      'staging deadline retirement tombstone');
    const finalPayload = safeOwnedRecoveryDirectory(payload,
      'staging deadline retirement payload');
    if (!sameFileIdentity(containerIdentity, finalContainer)
        || !sameFileIdentity(payloadIdentity, finalPayload)) {
      throw new Error('staging deadline retirement tombstone changed during finalization');
    }
    assertDeadlineRetirementSourceBinding(
      payload, record, 'staging deadline retirement payload during finalization',
    );
    assertPathAbsent(fs, directory, 'staging deadline retired control directory');
    synchronizeDirectory(tombstone);
    synchronizeDirectory(root);
    const durableRoot = safeOwnedRecoveryDirectory(
      root, 'staging deadline retirement tombstone root',
    );
    if (!sameFileIdentity(rootIdentity, durableRoot)) {
      throw new Error('staging deadline retirement root changed during finalization');
    }
    const durableContainer = safeOwnedRecoveryDirectory(tombstone,
      'staging deadline retirement tombstone');
    const durablePayload = safeOwnedRecoveryDirectory(payload,
      'staging deadline retirement payload');
    if (!sameFileIdentity(containerIdentity, durableContainer)
        || !sameFileIdentity(payloadIdentity, durablePayload)) {
      throw new Error('staging deadline retirement tombstone changed after finalization');
    }
    assertDeadlineRetirementSourceBinding(
      payload, record, 'staging deadline durable retirement payload',
    );
    assertPathAbsent(fs, directory, 'staging deadline retired control directory');
    const reclaimed = maybeReclaimTerminalSlot({
      container: tombstone,
      kind: 'RETIREMENT',
      payload,
      payloadIdentity,
      quiescentMaintenanceAuthority,
      reclaimRetainedEvidence,
      root,
      rootIdentity,
      synchronizeDirectory,
    });
    if (requireReclaimedRetirement && !reclaimed) {
      throw new Error('staging deadline retirement evidence remains retained');
    }
    assertPathAbsent(fs, directory, 'staging deadline retired control directory');
    return true;
  } catch (error) {
    error.recoveryAuthority = exactAuthority;
    throw error;
  }
}

function readExactFile(file, decode) {
  try {
    return { record: decode(fs.readFileSync(file)), state: 'present' };
  } catch (error) {
    if (error?.code === 'ENOENT') return { state: 'missing' };
    return { error, state: 'unknown' };
  }
}

function readStableDeadlineFile(file, {
  allowEmpty,
  exactSize,
  label,
} = {}) {
  let descriptor;
  try {
    const before = fs.lstatSync(file);
    const privateMode = process.platform === 'win32'
      || (before.uid === process.getuid() && (before.mode & 0o777) === 0o600);
    const sizeIsSafe = exactSize === undefined
      ? ((allowEmpty === true ? before.size >= 0 : before.size > 0)
        && before.size <= MAX_MESSAGE_BYTES)
      : before.size === exactSize;
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1
        || !privateMode || !sizeIsSafe) {
      throw new Error(`${label} is unsafe or unbounded`);
    }
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const opened = fs.fstatSync(descriptor);
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor);
    const finalPath = fs.lstatSync(file);
    const expected = JSON.stringify(exactStatIdentity(opened));
    if (JSON.stringify(exactStatIdentity(before)) !== expected
        || JSON.stringify(exactStatIdentity(after)) !== expected
        || JSON.stringify(exactStatIdentity(finalPath)) !== expected
        || bytes.length !== opened.size) {
      throw new Error(`${label} changed during capture`);
    }
    return Object.freeze({
      bytes,
      identity: exactStatIdentity(opened),
      state: 'present',
    });
  } catch (error) {
    if (error?.code === 'ENOENT') return Object.freeze({ state: 'missing' });
    return Object.freeze({ error, state: 'unknown' });
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function readStableDeadlineReadyMarker(markerPath) {
  return readStableDeadlineFile(markerPath, {
    allowEmpty: true,
    exactSize: 0,
    label: 'staging deadline ready marker',
  });
}

function readPublishedDeadlineFile(file, decode) {
  const markerPath = deadlineReadyPath(file);
  const marker = readStableDeadlineReadyMarker(markerPath);
  // Marker-first is the publication boundary: an absent marker means pending,
  // even when an exclusive writer has already exposed partial record bytes.
  if (marker.state !== 'present') return marker;
  const captured = readStableDeadlineFile(file, {
    allowEmpty: false,
    label: 'staging deadline published record',
  });
  if (captured.state === 'missing') {
    return Object.freeze({
      error: new Error('staging deadline ready marker has no record'),
      state: 'unknown',
    });
  }
  if (captured.state !== 'present') return captured;
  let record;
  try {
    record = decode(Buffer.from(captured.bytes));
  } catch (error) {
    return Object.freeze({ error, state: 'unknown' });
  }
  const finalMarker = readStableDeadlineReadyMarker(markerPath);
  if (finalMarker.state !== 'present'
      || !exactIdentityMatches(finalMarker.identity, marker.identity)) {
    return Object.freeze({
      error: finalMarker.error ?? new Error('staging deadline ready marker changed during capture'),
      state: 'unknown',
    });
  }
  return Object.freeze({
    identity: captured.identity,
    markerIdentity: marker.identity,
    record,
    state: 'present',
  });
}

function safeOwnedRecoveryDirectory(directory, label) {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory`);
  }
  if (process.platform !== 'win32'
      && (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0)) {
    throw new Error(`${label} has unsafe owner or mode`);
  }
  return stat;
}

function deadlineRetirementClaimPath(directory) {
  return path.join(directory, 'retirement.claim');
}

function deadlineRecoveryBatonPath(directory, currentPath, owner) {
  const token = createHash('sha256')
    .update(`easyboost-deadline-recovery-baton-v1\0${path.basename(currentPath)}\0${owner}`, 'utf8')
    .digest('hex');
  return path.join(directory, `.recovery-baton.${token}.claim`);
}

function exactDeadlineRetirementClaim(record) {
  return record && typeof record === 'object' && !Array.isArray(record)
    && record.event === 'RETIREMENT_CLAIM'
    && record.protocol === STAGING_DEADLINE_PROTOCOL
    && TOKEN_PATTERN.test(record.owner ?? '')
    && ((record.purpose === 'DISPOSE'
      && JSON.stringify(Object.keys(record).sort())
        === JSON.stringify(['event', 'owner', 'protocol', 'purpose']))
      || (record.purpose === 'RECOVERY'
        && typeof record.recoveryScope === 'string'
        && Buffer.byteLength(record.recoveryScope, 'utf8') <= MAX_MESSAGE_BYTES
        && JSON.stringify(Object.keys(record).sort())
          === JSON.stringify(['event', 'owner', 'protocol', 'purpose', 'recoveryScope'])));
}

function readExactDeadlineRetirementClaim(claimPath) {
  return readExactFile(claimPath, (value) => {
    const record = JSON.parse(value.toString('utf8'));
    if (!exactDeadlineRetirementClaim(record)
        || !Buffer.from(canonicalJson(record)).equals(value)) {
      throw new Error('staging deadline retirement claim is invalid');
    }
    return record;
  });
}

function collectDeadlineRecoveryBatonChain(directory, {
  expectedOwner,
  expectedScope,
} = {}) {
  const names = fs.readdirSync(directory);
  if (names.length > 64) throw new Error('staging deadline recovery baton namespace is unbounded');
  const candidateNames = names.filter((name) => name === 'retirement.claim'
    || /^\.recovery-baton\.[a-f0-9]{64}\.claim$/u.test(name));
  if (candidateNames.length === 0) return null;
  if (candidateNames.length > MAX_RECOVERY_BATON_LINKS) {
    throw new Error('staging deadline recovery baton chain is unbounded');
  }
  const firstPath = deadlineRetirementClaimPath(directory);
  if (!candidateNames.includes('retirement.claim')) {
    throw new Error('staging deadline recovery baton chain has no durable origin');
  }
  const first = readExactDeadlineRetirementClaim(firstPath);
  const firstIdentity = fs.lstatSync(firstPath);
  if (first.state !== 'present' || first.record.purpose !== 'RECOVERY'
      || !firstIdentity.isFile() || firstIdentity.isSymbolicLink()
      || firstIdentity.nlink < 1 || firstIdentity.nlink > MAX_RECOVERY_BATON_LINKS + 1
      || (expectedOwner !== undefined && first.record.owner !== expectedOwner)
      || (expectedScope !== undefined && first.record.recoveryScope !== expectedScope)) {
    throw new Error('staging deadline recovery baton origin is invalid');
  }
  const visited = [];
  let currentPath = firstPath;
  while (true) {
    const observed = readExactDeadlineRetirementClaim(currentPath);
    const identity = fs.lstatSync(currentPath);
    if (observed.state !== 'present' || observed.record.owner !== first.record.owner
        || observed.record.purpose !== 'RECOVERY'
        || observed.record.recoveryScope !== first.record.recoveryScope
        || !identity.isFile() || identity.isSymbolicLink()
        || !sameFileIdentity(firstIdentity, identity)) {
      throw new Error('staging deadline recovery baton chain changed during proof');
    }
    visited.push(path.basename(currentPath));
    if (visited.length > MAX_RECOVERY_BATON_LINKS) {
      throw new Error('staging deadline recovery baton chain is unbounded');
    }
    const successor = deadlineRecoveryBatonPath(
      directory, currentPath, first.record.owner,
    );
    if (pathIsAbsent(fs, successor)) break;
    currentPath = successor;
  }
  if (candidateNames.length !== visited.length
      || candidateNames.some((name) => !visited.includes(name))) {
    throw new Error('staging deadline recovery baton chain is forked or invalid');
  }
  const tipIdentity = fs.lstatSync(currentPath);
  const externalLinks = candidateNames.filter((name) => linkedDeadlinePublicationTombstone(
    directory, path.join(directory, name), tipIdentity,
  )).length;
  if (externalLinks > 1 || Number(tipIdentity.nlink) !== visited.length + externalLinks) {
    throw new Error('staging deadline recovery baton link count is invalid');
  }
  return Object.freeze({
    externalLinks,
    identity: tipIdentity,
    names: Object.freeze(visited),
    owner: first.record.owner,
    path: currentPath,
    recoveryScope: first.record.recoveryScope,
  });
}

function deadlineRetirementClaimRequired(directory, cause) {
  const error = new Error(`STAGING_DEADLINE_RETIREMENT_CLAIM_REQUIRED: ${directory}`,
    cause ? { cause } : {});
  error.code = 'STAGING_DEADLINE_RETIREMENT_CLAIM_REQUIRED';
  error.recoveryAuthority = Object.freeze(cause?.recoveryAuthority?.tombstone
    ? { controlDirectory: directory, tombstone: cause.recoveryAuthority.tombstone }
    : { controlDirectory: directory });
  return error;
}

function attachDeadlineRetirementTombstone(error, directory, tombstone) {
  error.recoveryAuthority = Object.freeze({ controlDirectory: directory, tombstone });
  return error;
}

function acquireDeadlineRetirementClaim(directory, {
  purpose = 'DISPOSE',
  recoveryScope = null,
} = {}) {
  const claimPath = deadlineRetirementClaimPath(directory);
  const expected = Object.freeze({
    event: 'RETIREMENT_CLAIM',
    owner: randomBytes(32).toString('hex'),
    protocol: STAGING_DEADLINE_PROTOCOL,
    purpose,
    ...(purpose === 'RECOVERY' ? { recoveryScope } : {}),
  });
  const bytes = Buffer.from(canonicalJson(expected));
  try {
    durableExclusiveWrite(claimPath, bytes);
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
  const observed = readExactFile(claimPath, (value) => {
    const record = JSON.parse(value.toString('utf8'));
    if (!exactDeadlineRetirementClaim(record)
        || !Buffer.from(canonicalJson(record)).equals(value)) {
      throw new Error('staging deadline retirement claim is invalid');
    }
    return record;
  });
  if (observed.state !== 'present' || !timingSafeEqual(
    Buffer.from(observed.record.owner), Buffer.from(expected.owner),
  ) || observed.record.purpose !== expected.purpose
      || observed.record.recoveryScope !== expected.recoveryScope) {
    throw deadlineRetirementClaimRequired(directory,
      observed.error ?? new Error('staging deadline retirement is already claimed'));
  }
  const identity = fs.lstatSync(claimPath);
  if (!identity.isFile() || identity.isSymbolicLink() || identity.nlink !== 1) {
    throw deadlineRetirementClaimRequired(directory,
      new Error('staging deadline retirement claim is not a private regular file'));
  }
  return Object.freeze({
    identity,
    owner: expected.owner,
    path: claimPath,
    purpose: expected.purpose,
    ...(purpose === 'RECOVERY' ? { recoveryScope } : {}),
  });
}

function revalidateDeadlineRetirementClaim({ claim, directory, directoryIdentity, root, rootIdentity }) {
  try {
    const currentRoot = safeOwnedRecoveryDirectory(root, 'staging deadline control root');
    const currentDirectory = safeOwnedRecoveryDirectory(directory, 'staging deadline control directory');
    const chain = claim.purpose === 'RECOVERY'
      ? collectDeadlineRecoveryBatonChain(directory, {
        expectedOwner: claim.owner,
        expectedScope: claim.recoveryScope,
      })
      : null;
    const currentClaim = chain?.identity ?? fs.lstatSync(claim.path);
    const observed = readExactDeadlineRetirementClaim(chain?.path ?? claim.path);
    if (!sameFileIdentity(rootIdentity, currentRoot)
        || !sameFileIdentity(directoryIdentity, currentDirectory)
        || !sameFileIdentity(claim.identity, currentClaim)
        || (chain !== null && chain.path !== claim.path)
        || observed.state !== 'present' || !timingSafeEqual(
          Buffer.from(observed.record.owner), Buffer.from(claim.owner),
        ) || observed.record.purpose !== claim.purpose
        || observed.record.recoveryScope !== claim.recoveryScope) {
      throw new Error('staging deadline retirement authority changed before removal');
    }
  } catch (error) {
    throw deadlineRetirementClaimRequired(directory, error);
  }
}

// `mkdir({recursive:true})` is not a root-authentication primitive: it follows
// a pre-existing link.  Establish and fingerprint the actual root before any
// deterministic child is created, then require the same inode immediately
// before publishing authenticated control bytes.
function establishOwnedControlRoot(controlRoot, label) {
  fs.mkdirSync(controlRoot, { mode: 0o700, recursive: true });
  const before = safeOwnedRecoveryDirectory(controlRoot, label);
  syncDirectory(controlRoot);
  const after = safeOwnedRecoveryDirectory(controlRoot, label);
  if (!sameFileIdentity(before, after)) {
    throw new Error(`${label} changed while being established`);
  }
  return after;
}

function revalidateOwnedControlRoot(controlRoot, expected, label) {
  const current = safeOwnedRecoveryDirectory(controlRoot, label);
  if (!sameFileIdentity(expected, current)) {
    throw new Error(`${label} changed during mailbox creation`);
  }
  return current;
}

function exactStatIdentity(stat) {
  return Object.freeze({
    dev: String(stat.dev),
    gid: String(stat.gid),
    ino: String(stat.ino),
    mode: String(stat.mode),
    nlink: String(stat.nlink),
    size: String(stat.size),
    uid: String(stat.uid),
  });
}

function captureDeadlineRecoveryNamespace(directory, { ignoreNames = [] } = {}) {
  const directoryBefore = fs.lstatSync(directory, { bigint: true });
  if (!directoryBefore.isDirectory() || directoryBefore.isSymbolicLink()
      || (process.platform !== 'win32'
        && (directoryBefore.uid !== BigInt(process.getuid())
          || (directoryBefore.mode & 0o077n) !== 0n))) {
    throw new Error('staging deadline recovery namespace is unsafe');
  }
  const ignored = new Set(ignoreNames);
  const allNames = fs.readdirSync(directory).sort();
  const allNameSet = new Set(allNames);
  const names = allNames.filter((name) => !ignored.has(name));
  if (names.length > 16) {
    throw new Error('staging deadline recovery namespace is unbounded');
  }
  const records = new Map();
  for (const name of names) {
    const file = path.join(directory, name);
    const before = fs.lstatSync(file, { bigint: true });
    const readyMarker = isDeadlineReadyMarkerName(name);
    const zeroByteUnsealedRecord = before.size === 0n
      && /^(?:ack-[0-2]|request-[12])\.json$/u.test(name)
      && !allNameSet.has(`${name}.ready`);
    const linksAreAccounted = readyMarker || zeroByteUnsealedRecord
      ? before.nlink === 1n
      : (before.nlink === 1n
        || (before.nlink === 2n
          && linkedDeadlinePublicationTombstone(directory, file, before)));
    const sizeIsSafe = readyMarker
      ? before.size === 0n
      : (zeroByteUnsealedRecord
        || (before.size >= 1n && before.size <= BigInt(MAX_MESSAGE_BYTES)));
    const specialModeIsSafe = (!readyMarker && !zeroByteUnsealedRecord)
      || process.platform === 'win32'
      || (before.uid === BigInt(process.getuid()) && (before.mode & 0o777n) === 0o600n);
    if (!before.isFile() || before.isSymbolicLink() || !linksAreAccounted
        || !sizeIsSafe || !specialModeIsSafe) {
      throw new Error('staging deadline recovery namespace record is unsafe or unbounded');
    }
    const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try {
      const opened = fs.fstatSync(descriptor, { bigint: true });
      const bytes = fs.readFileSync(descriptor);
      const after = fs.fstatSync(descriptor, { bigint: true });
      const finalPath = fs.lstatSync(file, { bigint: true });
      const expected = JSON.stringify(exactStatIdentity(opened));
      if (JSON.stringify(exactStatIdentity(before)) !== expected
          || JSON.stringify(exactStatIdentity(after)) !== expected
          || JSON.stringify(exactStatIdentity(finalPath)) !== expected
          || opened.nlink !== before.nlink || BigInt(bytes.length) !== opened.size) {
        throw new Error('staging deadline recovery namespace record changed during capture');
      }
      records.set(name, Object.freeze({
        bytes,
        identity: exactStatIdentity(opened),
      }));
    } finally {
      fs.closeSync(descriptor);
    }
  }
  const directoryAfter = fs.lstatSync(directory, { bigint: true });
  if (JSON.stringify(exactStatIdentity(directoryBefore))
        !== JSON.stringify(exactStatIdentity(directoryAfter))
      || JSON.stringify(allNames) !== JSON.stringify(fs.readdirSync(directory).sort())) {
    throw new Error('staging deadline recovery namespace changed during capture');
  }
  const signature = JSON.stringify({
    directory: exactStatIdentity(directoryAfter),
    records: names.map((name) => {
      const record = records.get(name);
      return [name, record.identity, record.bytes.toString('base64')];
    }),
  });
  return Object.freeze({ names: Object.freeze(names), records, signature });
}

function deadlineRetirementSourceFingerprint(snapshot) {
  return createHash('sha256').update(snapshot.signature).digest('hex');
}

function retirementSlotExpectation(source, sourceIdentity, sourceFingerprint) {
  if (!sourceIdentity || !TOKEN_PATTERN.test(sourceFingerprint ?? '')) {
    throw new Error('staging deadline retirement source binding is invalid');
  }
  return Object.freeze({
    purpose: 'RETIREMENT',
    source,
    sourceDev: String(sourceIdentity.dev),
    sourceFingerprint,
    sourceIno: String(sourceIdentity.ino),
  });
}

function assertDeadlineRetirementSourceBinding(source, expected, label) {
  const before = safeOwnedRecoveryDirectory(source, label);
  if (String(before.dev) !== expected.sourceDev || String(before.ino) !== expected.sourceIno) {
    throw new Error(`${label} identity no longer matches its reservation`);
  }
  const chain = collectDeadlineRecoveryBatonChain(source);
  const snapshot = captureDeadlineRecoveryNamespace(source, {
    ignoreNames: chain?.names ?? [],
  });
  const fingerprint = deadlineRetirementSourceFingerprint(snapshot);
  const after = safeOwnedRecoveryDirectory(source, label);
  if (!sameFileIdentity(before, after)
      || fingerprint !== expected.sourceFingerprint
      || (chain !== null
        && exactDeadlineRecoveryScope(chain.recoveryScope).fingerprint !== expected.sourceFingerprint)) {
    throw new Error(`${label} namespace no longer matches its reservation`);
  }
  return Object.freeze({ chain, identity: after, snapshot });
}

function readDeadlineRecoverySnapshotFile(snapshot, file, decode) {
  const record = snapshot.records.get(path.basename(file));
  if (!record) return { state: 'missing' };
  try {
    return { record: decode(Buffer.from(record.bytes)), state: 'present' };
  } catch (error) {
    return { error, state: 'unknown' };
  }
}

function revalidateDeadlineRecoveryNamespace(directory, semanticSnapshot, options) {
  const current = captureDeadlineRecoveryNamespace(directory, options);
  if (current.signature !== semanticSnapshot.signature) {
    throw new Error('staging deadline recovery namespace changed before retirement');
  }
}

function acquireDeadlineRecoveryRetirement(directory, root, recoveryScope) {
  const rootIdentity = safeOwnedRecoveryDirectory(root, 'staging deadline recovery control root');
  const directoryIdentity = safeOwnedRecoveryDirectory(
    directory, 'staging deadline recovery control directory',
  );
  const sourceExpectation = retirementSlotExpectation(
    directory, directoryIdentity, exactDeadlineRecoveryScope(recoveryScope).fingerprint,
  );
  boundedTerminalPayload(directory, {
    expectedIdentity: directoryIdentity,
    expectedKind: 'RETIREMENT',
  });
  let terminalSlot;
  try {
    assertDeadlineRetirementSourceBinding(
      directory, sourceExpectation, 'staging deadline retirement source',
    );
    terminalSlot = reserveOrReuseTerminalSlot(root, sourceExpectation);
    assertDeadlineRetirementSourceBinding(
      directory, sourceExpectation, 'staging deadline retirement source before claim',
    );
  } catch (cause) {
    if (cause?.recoveryAuthority?.tombstone) {
      cause.recoveryAuthority = Object.freeze({
        controlDirectory: directory,
        tombstone: cause.recoveryAuthority.tombstone,
      });
    }
    throw deadlineRetirementClaimRequired(directory, cause);
  }
  try {
    const claim = acquireDeadlineRetirementClaim(directory, { purpose: 'RECOVERY', recoveryScope });
    assertDeadlineRetirementSourceBinding(
      directory, sourceExpectation, 'staging deadline retirement source after claim',
    );
    return Object.freeze({
      claim, directoryIdentity, rootIdentity, sourceExpectation, terminalSlot,
    });
  } catch (error) {
    error.recoveryAuthority = Object.freeze({
      controlDirectory: directory,
      tombstone: terminalSlot.container,
    });
    throw error;
  }
}

function exactDeadlineRecoveryBatonNames(directory, recovery) {
  const chain = collectDeadlineRecoveryBatonChain(directory, {
    expectedOwner: recovery.claim.owner,
    expectedScope: recovery.claim.recoveryScope,
  });
  if (!chain || chain.path !== recovery.claim.path
      || !sameFileIdentity(chain.identity, recovery.claim.identity)) {
    throw new Error('staging deadline recovery baton is no longer current');
  }
  return chain.names;
}

function retireDeadlineRecoveryNamespace({
  directory,
  moveRetirementDirectory,
  quiescentMaintenanceAuthority,
  reclaimRetainedEvidence,
  requireReclaimedPublication = false,
  requireReclaimedRetirement = false,
  recovery,
  root,
  semanticSnapshot,
  syncControlRoot,
} = {}) {
  recoverExactDeadlinePublicationResidues(root, directory, {
    quiescentMaintenanceAuthority,
    reclaimRetainedEvidence,
    requireReclaimedPublication,
  });
  const batonNames = exactDeadlineRecoveryBatonNames(directory, recovery);
  revalidateDeadlineRecoveryNamespace(directory, semanticSnapshot, {
    ignoreNames: batonNames,
  });
  revalidateDeadlineRetirementClaim({
    claim: recovery.claim,
    directory,
    directoryIdentity: recovery.directoryIdentity,
    root,
    rootIdentity: recovery.rootIdentity,
  });
  const tombstone = moveOwnedDeadlineControlDirectory({
    directory,
    directoryIdentity: recovery.directoryIdentity,
    moveDirectoryNoReplace: moveRetirementDirectory,
    root,
    rootIdentity: recovery.rootIdentity,
    sourceExpectation: recovery.sourceExpectation,
    synchronizeDirectory: syncControlRoot,
    terminalSlot: recovery.terminalSlot,
  });
  try {
    syncControlRoot(root);
    const retained = safeOwnedRecoveryDirectory(path.join(tombstone, 'payload'),
      'staging deadline retirement payload');
    if (!sameFileIdentity(recovery.directoryIdentity, retained)) {
      throw new Error('staging deadline retirement tombstone changed during finalization');
    }
    assertPathAbsent(fs, directory, 'staging deadline retired control directory');
    cleanupStagingDeadlineRetirementTombstone({
      controlDirectory: directory,
      tombstone,
    }, {
      quiescentMaintenanceAuthority,
      reclaimRetainedEvidence,
      requireReclaimedRetirement,
      synchronizeDirectory: syncControlRoot,
    });
  } catch (error) {
    throw attachDeadlineRetirementTombstone(error, directory, tombstone);
  }
}

function exactDeadlineRecoveryScope(scope) {
  if (typeof scope !== 'string' || Buffer.byteLength(scope, 'utf8') > MAX_MESSAGE_BYTES) {
    throw new Error('staging deadline recovery handoff scope is invalid');
  }
  let value;
  try { value = JSON.parse(scope); } catch (cause) {
    throw new Error('staging deadline recovery handoff scope is invalid', { cause });
  }
  const result = value?.result;
  const resultKeys = Object.keys(result ?? {}).sort();
  const exactResult = (JSON.stringify(resultKeys) === JSON.stringify(['state'])
      && ['disposed', 'incomplete'].includes(result.state))
    || (JSON.stringify(resultKeys) === JSON.stringify(['finalSequence', 'state'])
      && Number.isSafeInteger(result.finalSequence) && result.finalSequence >= 0
      && result.finalSequence <= 2 && ['DISARMED', 'incomplete'].includes(result.state));
  if (!value || JSON.stringify(Object.keys(value).sort())
        !== JSON.stringify(['fingerprint', 'result'])
      || !TOKEN_PATTERN.test(value.fingerprint ?? '') || !exactResult
      || canonicalJson(value) !== scope) {
    throw new Error('staging deadline recovery handoff scope is invalid');
  }
  return Object.freeze({
    fingerprint: value.fingerprint,
    result: Object.freeze({ ...result }),
  });
}

function deadlineRecoveryScope(result, semanticSnapshot) {
  return canonicalJson({
    fingerprint: createHash('sha256').update(semanticSnapshot.signature).digest('hex'),
    result,
  });
}

function deadlineRecoveryHandoff(controlKey, controlRoot, directory, recovery) {
  return Object.freeze({
    claimPath: recovery.claim.path,
    controlDirectory: directory,
    controlKey,
    controlRoot: path.resolve(controlRoot),
    protocol: STAGING_DEADLINE_RECOVERY_HANDOFF_PROTOCOL,
    recoveryScope: recovery.claim.recoveryScope,
    retirementOwner: recovery.claim.owner,
  });
}

function attachDeadlineRecoveryHandoff(error, handoff) {
  const existing = error?.recoveryAuthority;
  error.recoveryAuthority = Object.freeze({
    controlDirectory: existing?.controlDirectory ?? handoff.controlDirectory,
    ...(existing?.destination && existing?.temporary
      ? { destination: existing.destination, temporary: existing.temporary } : {}),
    ...(existing?.tombstone ? { tombstone: existing.tombstone } : {}),
    recoveryHandoff: handoff,
  });
  Object.defineProperty(error, 'recoveryHandoff', { configurable: true, value: handoff });
  return error;
}

function deadlineRecoveryResult(result, {
  controlKey,
  controlRoot,
  directory,
  recovery,
  semanticSnapshot,
} = {}) {
  const recoveryProof = Object.freeze({});
  DEADLINE_RECOVERY_PROOFS.set(recoveryProof, {
    controlKey,
    controlRoot: path.resolve(controlRoot),
    directory,
    fingerprint: semanticSnapshot.signature,
    recovery,
  });
  const handoff = deadlineRecoveryHandoff(controlKey, controlRoot, directory, recovery);
  Object.defineProperty(result, 'recoveryHandoff', { enumerable: false, value: handoff });
  Object.defineProperty(result, 'recoveryProof', { enumerable: false, value: recoveryProof });
  return Object.freeze(result);
}

function deadlineRecoveryFromChain(chain, directoryIdentity, rootIdentity) {
  return Object.freeze({
    claim: Object.freeze({
      identity: chain.identity,
      owner: chain.owner,
      path: chain.path,
      purpose: 'RECOVERY',
      recoveryScope: chain.recoveryScope,
    }),
    directoryIdentity,
    rootIdentity,
    sourceExpectation: retirementSlotExpectation(
      path.dirname(chain.path), directoryIdentity,
      exactDeadlineRecoveryScope(chain.recoveryScope).fingerprint,
    ),
  });
}

function currentDeadlineRecoveryHandoff(controlKey, root, directory, {
  expectedOwner,
  expectedScope,
} = {}) {
  const rootIdentity = safeOwnedRecoveryDirectory(root,
    'staging deadline recovery handoff root');
  const directoryIdentity = safeOwnedRecoveryDirectory(directory,
    'staging deadline recovery handoff directory');
  const chain = collectDeadlineRecoveryBatonChain(directory, {
    expectedOwner,
    expectedScope,
  });
  if (!chain) throw new Error('staging deadline recovery baton is missing');
  return deadlineRecoveryHandoff(controlKey, root, directory,
    deadlineRecoveryFromChain(chain, directoryIdentity, rootIdentity));
}

// Every adoption adds an exclusive hard-link successor and retains the prior
// link.  The predecessor therefore remains a durable, deterministic pointer to
// the successor across a crash before directory fsync; no process ever has to
// unlink or overwrite a pathname to transfer the baton.
export function resumeStagingDeadlineRecoveryHandoff(handoff, {
  afterBatonMutation = () => {},
  linkBaton = fs.linkSync,
  quiescentMaintenanceAuthority,
  reclaimRetainedEvidence,
  requireReclaimedPublication = false,
  rotateRecoveryBatonEpoch,
  synchronizeDirectory = syncDirectory,
} = {}) {
  const expectedKeys = ['claimPath', 'controlDirectory', 'controlKey', 'controlRoot',
    'protocol', 'recoveryScope', 'retirementOwner'];
  if (!handoff || JSON.stringify(Object.keys(handoff).sort()) !== JSON.stringify(expectedKeys)
      || handoff.protocol !== STAGING_DEADLINE_RECOVERY_HANDOFF_PROTOCOL
      || typeof handoff.controlKey !== 'string' || !handoff.controlKey
      || typeof handoff.controlRoot !== 'string' || !path.isAbsolute(handoff.controlRoot)
      || typeof handoff.controlDirectory !== 'string' || !path.isAbsolute(handoff.controlDirectory)
      || typeof handoff.claimPath !== 'string' || !path.isAbsolute(handoff.claimPath)
      || !TOKEN_PATTERN.test(handoff.retirementOwner ?? '')) {
    throw new Error('staging deadline recovery handoff is invalid');
  }
  const scope = exactDeadlineRecoveryScope(handoff.recoveryScope);
  const root = path.resolve(handoff.controlRoot);
  const directory = path.resolve(handoff.controlDirectory);
  const expectedDirectory = path.join(
    root, createHash('sha256').update(handoff.controlKey, 'utf8').digest('hex'),
  );
  if (directory !== expectedDirectory) {
    throw new Error('staging deadline recovery handoff scope is invalid');
  }
  const oldPath = path.resolve(handoff.claimPath);
  let adoptionPath = oldPath;
  const oldName = path.basename(oldPath);
  if (path.dirname(oldPath) !== directory
      || (oldName !== 'retirement.claim'
        && !/^\.recovery-baton\.[a-f0-9]{64}\.claim$/u.test(oldName))) {
    throw new Error('staging deadline recovery baton is invalid');
  }
  const rootIdentity = safeOwnedRecoveryDirectory(root,
    'staging deadline recovery handoff root');
  const directoryIdentity = safeOwnedRecoveryDirectory(directory,
    'staging deadline recovery handoff directory');
  try {
    recoverExactDeadlinePublicationResidues(root, directory, {
      quiescentMaintenanceAuthority,
      reclaimRetainedEvidence,
      requireReclaimedPublication,
    });
  } catch (error) {
    throw attachDeadlineRecoveryHandoff(error, handoff);
  }
  let initialChain = collectDeadlineRecoveryBatonChain(directory, {
    expectedOwner: handoff.retirementOwner,
    expectedScope: handoff.recoveryScope,
  });
  if (!initialChain) {
    throw new Error('staging deadline recovery baton is not owned by this handoff');
  }
  if (!initialChain.names.includes(oldName)) {
    const current = deadlineRecoveryHandoff(handoff.controlKey, root, directory,
      deadlineRecoveryFromChain(initialChain, directoryIdentity, rootIdentity));
    throw attachDeadlineRecoveryHandoff(
      new Error('staging deadline recovery baton durability resolved to a surviving tip'), current,
    );
  }
  if (initialChain.path !== oldPath) {
    const current = deadlineRecoveryHandoff(handoff.controlKey, root, directory,
      deadlineRecoveryFromChain(initialChain, directoryIdentity, rootIdentity));
    throw attachDeadlineRecoveryHandoff(
      new Error('staging deadline recovery baton was already adopted'), current,
    );
  }
  let epochMutated = false;
  if (initialChain.names.length >= MAX_RECOVERY_BATON_LINKS) {
    const exhausted = new Error('staging deadline recovery baton epoch maintenance is required');
    exhausted.code = 'STAGING_DEADLINE_RECOVERY_EPOCH_MAINTENANCE_REQUIRED';
    if (typeof rotateRecoveryBatonEpoch !== 'function'
        || quiescentMaintenanceAuthority === undefined) {
      throw attachDeadlineRecoveryHandoff(exhausted, handoff);
    }
    try {
      const maintenance = exactQuiescentMaintenanceAuthority(
        quiescentMaintenanceAuthority, root, rootIdentity,
      );
      const rotated = rotateRecoveryBatonEpoch(Object.freeze({
        authority: maintenance,
        directory,
        expectedIdentity: Object.freeze({
          dev: String(initialChain.identity.dev),
          ino: String(initialChain.identity.ino),
        }),
        kind: 'RECOVERY_BATON_EPOCH',
        names: initialChain.names,
        root,
        source: initialChain.path,
      }));
      if (rotated !== true) throw exhausted;
      epochMutated = true;
      // The launcher callback is a privileged, quiescent maintenance
      // transaction.  It must be crash/restart-safe itself and durably leave
      // either the old valid chain or one canonical nlink=1 origin; JS never
      // performs the predecessor pathname removals.
      synchronizeDirectory(directory);
      const reset = collectDeadlineRecoveryBatonChain(directory, {
        expectedOwner: handoff.retirementOwner,
        expectedScope: handoff.recoveryScope,
      });
      if (!reset || reset.names.length !== 1 || reset.names[0] !== 'retirement.claim'
          || Number(reset.identity.nlink) !== 1) {
        throw new Error('staging deadline recovery baton epoch reset is invalid');
      }
      initialChain = reset;
      adoptionPath = reset.path;
    } catch (error) {
      try {
        const current = currentDeadlineRecoveryHandoff(
          handoff.controlKey, root, directory, {
            expectedOwner: handoff.retirementOwner,
            expectedScope: handoff.recoveryScope,
          },
        );
        throw attachDeadlineRecoveryHandoff(error, current);
      } catch (handoffError) {
        if (handoffError?.recoveryHandoff) throw handoffError;
        throw attachDeadlineRecoveryHandoff(error, handoff);
      }
    }
  }
  const nextPath = deadlineRecoveryBatonPath(
    directory, adoptionPath, handoff.retirementOwner,
  );
  let batonMutated = false;
  try {
    linkBaton(adoptionPath, nextPath);
    batonMutated = true;
    const linked = fs.lstatSync(nextPath);
    if (!sameFileIdentity(initialChain.identity, linked) || !linked.isFile()
        || linked.isSymbolicLink()
        || Number(linked.nlink)
          !== initialChain.names.length + initialChain.externalLinks + 1) {
      throw new Error('staging deadline recovery baton changed during adoption');
    }
    const provisional = Object.freeze({
      identity: linked,
      externalLinks: initialChain.externalLinks,
      names: Object.freeze([...initialChain.names, path.basename(nextPath)]),
      owner: handoff.retirementOwner,
      path: nextPath,
      recoveryScope: handoff.recoveryScope,
    });
    const nextHandoff = deadlineRecoveryHandoff(handoff.controlKey, root, directory,
      deadlineRecoveryFromChain(provisional, directoryIdentity, rootIdentity));
    afterBatonMutation(nextHandoff);
    synchronizeDirectory(directory);
    const currentRoot = safeOwnedRecoveryDirectory(root, 'staging deadline recovery handoff root');
    const currentDirectory = safeOwnedRecoveryDirectory(
      directory, 'staging deadline recovery handoff directory',
    );
    if (!sameFileIdentity(rootIdentity, currentRoot)
        || !sameFileIdentity(directoryIdentity, currentDirectory)) {
      throw new Error('staging deadline recovery namespace changed during baton adoption');
    }
    const finalChain = collectDeadlineRecoveryBatonChain(directory, {
      expectedOwner: handoff.retirementOwner,
      expectedScope: handoff.recoveryScope,
    });
    if (!finalChain || finalChain.path !== nextPath
        || finalChain.names.length !== initialChain.names.length + 1) {
      throw new Error('staging deadline recovery baton changed during adoption');
    }
    const recovery = deadlineRecoveryFromChain(finalChain, directoryIdentity, rootIdentity);
    const semanticSnapshot = captureDeadlineRecoveryNamespace(directory, {
      ignoreNames: finalChain.names,
    });
    const fingerprint = createHash('sha256').update(semanticSnapshot.signature).digest('hex');
    if (fingerprint !== scope.fingerprint) {
      throw new Error('staging deadline recovery namespace changed during baton adoption');
    }
    return deadlineRecoveryResult({ ...scope.result }, {
      controlKey: handoff.controlKey,
      controlRoot: root,
      directory,
      recovery,
      semanticSnapshot,
    });
  } catch (error) {
    if (epochMutated || batonMutated || !pathIsAbsent(fs, nextPath)) {
      try {
        const current = currentDeadlineRecoveryHandoff(
          handoff.controlKey, root, directory, {
            expectedOwner: handoff.retirementOwner,
            expectedScope: handoff.recoveryScope,
          },
        );
        throw attachDeadlineRecoveryHandoff(error, current);
      } catch (handoffError) {
        if (handoffError?.recoveryHandoff) throw handoffError;
        throw error;
      }
    }
    throw error;
  }
}

// The completion capability is intentionally opaque and process-local.  It is
// the only way a retire:false winner can later remove its namespace; a second
// recoverer observes the durable claim and fails closed.
export function completeStagingDeadlineRecovery(proof, {
  controlKey,
  controlRoot,
  quiescentMaintenanceAuthority,
  reclaimRetainedEvidence,
  requireReclaimedPublication = false,
  requireReclaimedRetirement = false,
  syncControlRoot = syncDirectory,
} = {}) {
  const authority = DEADLINE_RECOVERY_PROOFS.get(proof);
  if (!authority || authority.controlKey !== controlKey
      || authority.controlRoot !== path.resolve(controlRoot)) {
    throw new Error('staging deadline recovery handoff is invalid');
  }
  try {
    const batonNames = exactDeadlineRecoveryBatonNames(
      authority.directory, authority.recovery,
    );
    const snapshot = captureDeadlineRecoveryNamespace(authority.directory, {
      ignoreNames: batonNames,
    });
    if (snapshot.signature !== authority.fingerprint) {
      throw new Error('staging deadline recovery authority changed before handoff retirement');
    }
    retireDeadlineRecoveryNamespace({
      directory: authority.directory,
      quiescentMaintenanceAuthority,
      reclaimRetainedEvidence,
      requireReclaimedPublication,
      requireReclaimedRetirement,
      recovery: authority.recovery,
      root: authority.controlRoot,
      semanticSnapshot: snapshot,
      syncControlRoot,
    });
    DEADLINE_RECOVERY_PROOFS.delete(proof);
    return true;
  } catch (error) {
    const failure = deadlineRetirementClaimRequired(authority.directory, error);
    if (failure.recoveryAuthority?.tombstone
        && pathIsAbsent(fs, authority.directory)) throw failure;
    try {
      revalidateDeadlineRetirementClaim({
        claim: authority.recovery.claim,
        directory: authority.directory,
        directoryIdentity: authority.recovery.directoryIdentity,
        root: authority.controlRoot,
        rootIdentity: authority.recovery.rootIdentity,
      });
      throw attachDeadlineRecoveryHandoff(failure, deadlineRecoveryHandoff(
        authority.controlKey,
        authority.controlRoot,
        authority.directory,
        authority.recovery,
      ));
    } catch (handoffError) {
      if (handoffError?.recoveryHandoff) throw handoffError;
      throw failure;
    }
  }
}

function rejectExistingDeadlineRecoveryBaton(controlKey, root, directory) {
  let chain;
  try {
    chain = collectDeadlineRecoveryBatonChain(directory);
  } catch (cause) {
    throw deadlineRetirementClaimRequired(directory, cause);
  }
  if (!chain) return;
  const recovery = deadlineRecoveryFromChain(
    chain,
    safeOwnedRecoveryDirectory(directory,
      'staging deadline recovery handoff directory'),
    safeOwnedRecoveryDirectory(root, 'staging deadline recovery handoff root'),
  );
  const handoff = deadlineRecoveryHandoff(controlKey, root, directory, recovery);
  const failure = deadlineRetirementClaimRequired(
    directory, new Error('staging deadline recovery is already claimed'),
  );
  let slots;
  try {
    slots = findExactTerminalSlots(root, recovery.sourceExpectation);
  } catch (cause) {
    const mismatch = deadlineRetirementClaimRequired(directory, cause);
    if (cause?.recoveryAuthority?.tombstone) {
      attachDeadlineRetirementTombstone(
        mismatch, directory, cause.recoveryAuthority.tombstone,
      );
    }
    throw attachDeadlineRecoveryHandoff(mismatch, handoff);
  }
  if (slots.length === 1) {
    failure.recoveryAuthority = Object.freeze({
      controlDirectory: directory,
      tombstone: slots[0],
    });
  }
  throw attachDeadlineRecoveryHandoff(failure, handoff);
}

function recoverRetainedDeadlineRetirement(root, directory, {
  quiescentMaintenanceAuthority,
  reclaimRetainedEvidence,
  requireReclaimedRetirement = false,
  synchronizeDirectory = syncDirectory,
} = {}) {
  const matches = findExactTerminalSlots(root, {
    purpose: 'RETIREMENT', source: directory,
  });
  if (matches.length === 0) return null;
  if (matches.length > 1) {
    throw deadlineRetirementClaimRequired(
      directory, new Error('staging deadline retained retirement is ambiguous'),
    );
  }
  const tombstone = matches[0];
  const payload = path.join(tombstone, 'payload');
  try {
    const record = readExactTerminalSlotRecord(tombstone);
    assertDeadlineRetirementSourceBinding(
      payload, record, 'staging deadline retained retirement replay payload',
    );
    const chain = collectDeadlineRecoveryBatonChain(payload);
    if (!chain) throw new Error('staging deadline retained retirement baton is missing');
    const scope = exactDeadlineRecoveryScope(chain.recoveryScope);
    if (scope.fingerprint !== record.sourceFingerprint) {
      throw new Error('staging deadline retained retirement scope does not match its reservation');
    }
    synchronizeDirectory(root);
    assertPathAbsent(fs, directory, 'staging deadline retired control directory');
    cleanupStagingDeadlineRetirementTombstone({
      controlDirectory: directory,
      tombstone,
    }, {
      quiescentMaintenanceAuthority,
      reclaimRetainedEvidence,
      requireReclaimedRetirement,
      synchronizeDirectory,
    });
    assertPathAbsent(fs, directory, 'staging deadline retired control directory');
    return Object.freeze({ ...scope.result });
  } catch (cause) {
    throw attachDeadlineRetirementTombstone(
      deadlineRetirementClaimRequired(directory, cause), directory, tombstone,
    );
  }
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} is invalid`);
  return value;
}

function exactToken(value, label = 'staging deadline token') {
  if (typeof value !== 'string' || !TOKEN_PATTERN.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function exactSpecification(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || JSON.stringify(Object.keys(value).sort())
        !== JSON.stringify(['controlDirectory', 'protocol', 'token'])
      || value.protocol !== STAGING_DEADLINE_PROTOCOL
      || typeof value.controlDirectory !== 'string'
      || !path.isAbsolute(value.controlDirectory)) {
    throw new Error('staging deadline control specification is invalid');
  }
  return Object.freeze({
    controlDirectory: path.resolve(value.controlDirectory),
    protocol: value.protocol,
    token: exactToken(value.token),
  });
}

function decodeSpecification(environmentValue) {
  try {
    const bytes = Buffer.from(environmentValue, 'base64');
    const value = JSON.parse(bytes.toString('utf8'));
    const specification = exactSpecification(value);
    if (Buffer.from(JSON.stringify(specification), 'utf8').toString('base64')
        !== environmentValue) {
      throw new Error('staging deadline control specification is not canonical');
    }
    return specification;
  } catch (cause) {
    throw new Error('staging deadline control environment is invalid', { cause });
  }
}

function requestPath(specification, sequence) {
  return path.join(specification.controlDirectory, `request-${sequence}.json`);
}

function acknowledgementPath(specification, sequence) {
  return path.join(specification.controlDirectory, `ack-${sequence}.json`);
}

function deadlineReadyPath(recordPath) {
  return `${recordPath}.ready`;
}

function isDeadlineReadyMarkerName(name) {
  return /^(?:ack-[0-2]|request-[12])\.json\.ready$/u.test(name);
}

function tokenMatches(actual, expected) {
  if (typeof actual !== 'string' || !TOKEN_PATTERN.test(actual)) return false;
  return timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'));
}

function exactRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('staging deadline request is invalid');
  }
  const keys = Object.keys(value).sort();
  if (JSON.stringify(keys)
      !== JSON.stringify(['action', 'protocol', 'seconds', 'sequence', 'token'])) {
    throw new Error('staging deadline request has an invalid contract');
  }
  if (value.protocol !== STAGING_DEADLINE_PROTOCOL || !TRANSITIONS.has(value.action)
      || !Number.isSafeInteger(value.sequence) || value.sequence <= 0
      || !Number.isSafeInteger(value.seconds) || value.seconds < 0) {
    throw new Error('staging deadline request is invalid');
  }
  return Object.freeze({
    action: value.action,
    protocol: value.protocol,
    seconds: value.seconds,
    sequence: value.sequence,
    token: value.token,
  });
}

function acknowledgement(token, sequence, state, seconds) {
  return Object.freeze({
    protocol: STAGING_DEADLINE_PROTOCOL,
    seconds,
    sequence,
    state,
    token,
  });
}

function exactAcknowledgement(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || JSON.stringify(Object.keys(value).sort())
        !== JSON.stringify(['protocol', 'seconds', 'sequence', 'state', 'token'])) {
    throw new Error('staging deadline acknowledgement has an invalid contract');
  }
  if (value.protocol !== STAGING_DEADLINE_PROTOCOL
      || !ACKNOWLEDGEMENT_STATES.has(value.state)
      || !Number.isSafeInteger(value.sequence) || value.sequence < 0
      || !Number.isSafeInteger(value.seconds) || value.seconds < 0
      || !TOKEN_PATTERN.test(value.token ?? '')) {
    throw new Error('staging deadline acknowledgement is invalid');
  }
  return acknowledgement(
    value.token, value.sequence, value.state, value.seconds,
  );
}

function decodeMessage(bytes, label) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > MAX_MESSAGE_BYTES
      || bytes.at(-1) !== 0x0a || bytes.subarray(0, -1).includes(0)) {
    throw new Error(`${label} bytes are invalid`);
  }
  try {
    return JSON.parse(bytes.subarray(0, -1).toString('utf8'));
  } catch {
    throw new Error(`${label} JSON is invalid`);
  }
}

function encoded(value) {
  return Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
}

export function encodeStagingDeadlineRequest(value) {
  return encoded(exactRequest(value));
}

export function decodeStagingDeadlineRequest(bytes) {
  const value = exactRequest(decodeMessage(bytes, 'staging deadline request'));
  if (!encodeStagingDeadlineRequest(value).equals(bytes)) {
    throw new Error('staging deadline request is not canonically encoded');
  }
  return value;
}

export function encodeStagingDeadlineAcknowledgement(value) {
  return encoded(exactAcknowledgement(value));
}

export function decodeStagingDeadlineAcknowledgement(bytes, {
  expectedSeconds,
  expectedToken,
  expectedSequence,
  expectedState,
} = {}) {
  const value = exactAcknowledgement(decodeMessage(bytes, 'staging deadline acknowledgement'));
  if (!encodeStagingDeadlineAcknowledgement(value).equals(bytes)
      || !tokenMatches(value.token, exactToken(expectedToken, 'expected staging deadline token'))
      || value.sequence !== expectedSequence || value.state !== expectedState
      || value.seconds !== expectedSeconds) {
    throw new Error('staging deadline acknowledgement does not match its request authority');
  }
  return value;
}

export function createStagingDeadlineMailbox({
  controlKey,
  controlRoot = path.join(os.tmpdir(), 'easyboost-staging-deadline-controls'),
  moveRetirementDirectory = movePosixDirectoryNoReplace,
  quiescentMaintenanceAuthority,
  reclaimRetainedEvidence,
  synchronizeMessageDirectory = syncDirectory,
  token = randomBytes(32).toString('hex'),
  writeControlRecord = durableExclusiveWrite,
} = {}) {
  if (typeof moveRetirementDirectory !== 'function') {
    throw new Error('staging deadline retirement handoff is invalid');
  }
  const authorityToken = exactToken(token);
  const root = path.resolve(controlRoot);
  const rootIdentity = establishOwnedControlRoot(root, 'staging deadline control root');
  const effectiveControlKey = typeof controlKey === 'string' && controlKey.length > 0
    ? controlKey
    : `anonymous:${randomBytes(32).toString('hex')}`;
  const directory = path.join(
    root, createHash('sha256').update(effectiveControlKey, 'utf8').digest('hex'),
  );
  let directoryCreated = false;
  try {
    fs.mkdirSync(directory, { mode: 0o700 });
    directoryCreated = true;
  } catch (error) {
    if (error?.code === 'EEXIST') {
      const recovery = new Error(`STAGING_DEADLINE_RECOVERY_REQUIRED: ${directory}`);
      recovery.code = 'STAGING_DEADLINE_RECOVERY_REQUIRED';
      recovery.recoveryAuthority = Object.freeze({ controlDirectory: directory });
      throw recovery;
    }
    throw error;
  }
  let specification;
  let environmentValue;
  try {
    revalidateOwnedControlRoot(root, rootIdentity, 'staging deadline control root');
    syncDirectory(root);
    revalidateOwnedControlRoot(root, rootIdentity, 'staging deadline control root');
    specification = exactSpecification({
      controlDirectory: directory,
      protocol: STAGING_DEADLINE_PROTOCOL,
      token: authorityToken,
    });
    environmentValue = Buffer.from(JSON.stringify(specification), 'utf8').toString('base64');
    writeControlRecord(path.join(directory, 'control.json'), Buffer.from(canonicalJson(specification)));
  } catch (cause) {
    if (!directoryCreated) throw cause;
    const recovery = new Error(`STAGING_DEADLINE_RECOVERY_REQUIRED: ${directory}`, { cause });
    recovery.code = 'STAGING_DEADLINE_RECOVERY_REQUIRED';
    const publication = cause?.recoveryAuthority;
    recovery.recoveryAuthority = Object.freeze(publication?.destination && publication?.temporary
      ? {
        controlDirectory: directory,
        destination: publication.destination,
        temporary: publication.temporary,
        ...(publication.tombstone === undefined ? {} : { tombstone: publication.tombstone }),
      }
      : { controlDirectory: directory });
    throw recovery;
  }
  let disposed = false;
  let retainedTombstoneAuthority;
  return Object.freeze({
    acknowledge(value) {
      if (disposed) throw new Error('staging deadline mailbox is disposed');
      const record = exactAcknowledgement(value);
      if (!tokenMatches(record.token, authorityToken)) {
        throw new Error('staging deadline acknowledgement token does not match');
      }
      const file = acknowledgementPath(specification, record.sequence);
      const bytes = encodeStagingDeadlineAcknowledgement(record);
      publishDurableStagingDeadlineMessage(file, bytes, {
        synchronizeDirectory: synchronizeMessageDirectory,
      });
    },
    dispose({ beforeRetirementValidation = () => {} } = {}) {
      if (disposed) return;
      if (typeof beforeRetirementValidation !== 'function') {
        throw new Error('staging deadline retirement validation hook is invalid');
      }
      if (retainedTombstoneAuthority) {
        cleanupStagingDeadlineRetirementTombstone(retainedTombstoneAuthority, {
          quiescentMaintenanceAuthority,
          reclaimRetainedEvidence,
        });
        disposed = true;
        return;
      }
      if (!disposed) {
        const rootIdentity = safeOwnedRecoveryDirectory(root, 'staging deadline control root');
        const directoryIdentity = safeOwnedRecoveryDirectory(
          directory, 'staging deadline control directory',
        );
        recoverExactDeadlinePublicationResidues(root, directory, {
          quiescentMaintenanceAuthority,
          reclaimRetainedEvidence,
        });
        const semanticSnapshot = captureDeadlineRecoveryNamespace(directory);
        const recovery = acquireDeadlineRecoveryRetirement(
          directory,
          root,
          deadlineRecoveryScope({ state: 'disposed' }, semanticSnapshot),
        );
        const authority = deadlineRecoveryResult({ state: 'disposed' }, {
          controlKey: effectiveControlKey,
          controlRoot: root,
          directory,
          recovery,
          semanticSnapshot,
        });
        try {
          beforeRetirementValidation();
          retireDeadlineRecoveryNamespace({
            directory,
            moveRetirementDirectory,
            quiescentMaintenanceAuthority,
            reclaimRetainedEvidence,
            recovery,
            root,
            semanticSnapshot,
            syncControlRoot: syncDirectory,
          });
        } catch (error) {
          if (!error?.recoveryAuthority?.tombstone && recovery.terminalSlot?.container) {
            error.recoveryAuthority = Object.freeze({
              controlDirectory: directory,
              tombstone: recovery.terminalSlot.container,
            });
          }
          const tombstone = error?.recoveryAuthority?.tombstone;
          if (tombstone && pathIsAbsent(fs, directory)) {
            retainedTombstoneAuthority = Object.freeze({ controlDirectory: directory, tombstone });
            throw error;
          }
          try {
            revalidateDeadlineRetirementClaim({
              claim: recovery.claim,
              directory,
              directoryIdentity,
              root,
              rootIdentity,
            });
            throw attachDeadlineRecoveryHandoff(error, authority.recoveryHandoff);
          } catch (handoffError) {
            if (handoffError?.recoveryHandoff) throw handoffError;
            throw deadlineRetirementClaimRequired(directory, error);
          }
        }
        disposed = true;
      }
    },
    environmentValue,
    requestState(sequence) {
      if (!Number.isSafeInteger(sequence) || sequence < 0) {
        return { error: new Error('staging deadline request sequence is invalid'), state: 'unknown' };
      }
      const result = readPublishedDeadlineFile(requestPath(specification, sequence),
        decodeStagingDeadlineRequest);
      if (result.state !== 'present') return result;
      if (result.record.sequence !== sequence
          || !tokenMatches(result.record.token, authorityToken)) {
        return { error: new Error('staging deadline request authority does not match'), state: 'unknown' };
      }
      return { record: result.record, state: 'present' };
    },
    specification,
  });
}

// Recovery is deliberately narrower than mailbox disposal: an operator may retire
// a retained deterministic namespace only after reopening every authenticated record
// and proving that its final transition was durably acknowledged as DISARMED.
export function recoverStagingDeadlineMailbox({
  beforeRetirementValidation = () => {},
  controlKey,
  controlRoot = path.join(os.tmpdir(), 'easyboost-staging-deadline-controls'),
  permitIncompleteRetirement = false,
  publicationResidue,
  quiescentMaintenanceAuthority,
  reclaimRetainedEvidence,
  requireReclaimedPublication = false,
  requireReclaimedRetirement = false,
  retire = true,
  sessionRecoveryProof,
  sessionControlRoot = path.join(os.tmpdir(), 'easyboost-posix-session-controls'),
  syncControlRoot = syncDirectory,
} = {}) {
  if (typeof controlKey !== 'string' || controlKey.length === 0) {
    throw new Error('staging deadline recovery controlKey is invalid');
  }
  const root = path.resolve(controlRoot);
  const directory = path.join(root, createHash('sha256').update(controlKey, 'utf8').digest('hex'));
  const sessionControlKey = controlKey.startsWith('staging-deadline:')
    ? `staging-transaction:${controlKey.slice('staging-deadline:'.length)}`
    : null;
  let sessionProofConsumed = false;
  const consumeSessionProof = () => {
    if (sessionProofConsumed) return true;
    sessionProofConsumed = Boolean(sessionControlKey && consumePosixSessionRecoveryProof(
      sessionRecoveryProof,
      {
        controlKey: sessionControlKey,
        controlRoot: sessionControlRoot,
        recoveryScope: directory,
      },
    ));
    return sessionProofConsumed;
  };
  const recoveryRootIdentity = safeOwnedRecoveryDirectory(
    root, 'staging deadline recovery control root',
  );
  try {
    safeOwnedRecoveryDirectory(directory, 'staging deadline recovery control directory');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      const retainedResult = recoverRetainedDeadlineRetirement(root, directory, {
        quiescentMaintenanceAuthority,
        reclaimRetainedEvidence,
        requireReclaimedRetirement,
        synchronizeDirectory: syncControlRoot,
      });
      if (retainedResult !== null) return retainedResult;
    }
    if (error?.code === 'ENOENT' && permitIncompleteRetirement && sessionControlKey) {
      syncControlRoot(root);
      const currentRoot = safeOwnedRecoveryDirectory(
        root, 'staging deadline recovery control root',
      );
      if (!sameFileIdentity(recoveryRootIdentity, currentRoot)) {
        throw new Error('staging deadline recovery control root changed during absence proof');
      }
      assertPathAbsent(fs, directory, 'staging deadline recovery control directory');
      if (consumeSessionProof()) return Object.freeze({ state: 'not-created' });
    }
    throw error;
  }
  try {
    recoverExactDeadlinePublicationResidues(root, directory, {
      quiescentMaintenanceAuthority,
      reclaimRetainedEvidence,
      requireReclaimedPublication,
    });
  } catch (error) {
    try {
      const current = currentDeadlineRecoveryHandoff(controlKey, root, directory);
      throw attachDeadlineRecoveryHandoff(error, current);
    } catch (handoffError) {
      if (handoffError?.recoveryHandoff) throw handoffError;
      throw error;
    }
  }
  rejectExistingDeadlineRecoveryBaton(controlKey, root, directory);
  if (publicationResidue !== undefined) {
    if (path.resolve(path.dirname(publicationResidue?.destination ?? '')) !== path.resolve(directory)) {
      throw deadlineRetirementClaimRequired(directory,
        new Error('staging deadline publication residue does not belong to this control directory'));
    }
    cleanupStagingDeadlinePublicationResidue(publicationResidue, {
      quiescentMaintenanceAuthority,
      reclaimRetainedEvidence,
      requireReclaimedPublication,
    });
  }
  const semanticSnapshot = captureDeadlineRecoveryNamespace(directory);
  const finishRetirement = (result) => {
    const recovery = acquireDeadlineRecoveryRetirement(
      directory, root, deadlineRecoveryScope(result, semanticSnapshot),
    );
    const authority = deadlineRecoveryResult(result, {
      controlKey,
      controlRoot: root,
      directory,
      recovery,
      semanticSnapshot,
    });
    if (!retire) return authority;
    try {
      retireDeadlineRecoveryNamespace({
        directory,
        quiescentMaintenanceAuthority,
        reclaimRetainedEvidence,
        requireReclaimedPublication,
        requireReclaimedRetirement,
        recovery,
        root,
        semanticSnapshot,
        syncControlRoot,
      });
    } catch (error) {
      let batonIsCurrent = false;
      try {
        revalidateDeadlineRetirementClaim({
          claim: recovery.claim,
          directory,
          directoryIdentity: recovery.directoryIdentity,
          root,
          rootIdentity: recovery.rootIdentity,
        });
        batonIsCurrent = true;
      } catch {}
      if (batonIsCurrent) {
        throw attachDeadlineRecoveryHandoff(error, authority.recoveryHandoff);
      }
      throw error;
    }
    return authority;
  };
  const names = [...semanticSnapshot.names];
  const control = readDeadlineRecoverySnapshotFile(
    semanticSnapshot, path.join(directory, 'control.json'), (bytes) => {
    const value = JSON.parse(bytes.toString('utf8'));
    const specification = exactSpecification(value);
    if (!Buffer.from(canonicalJson(specification)).equals(bytes)
        || specification.controlDirectory !== directory) {
      throw new Error('staging deadline recovery control record is not exact');
    }
    return specification;
    },
  );
  if (control.state !== 'present') {
    if (control.state === 'missing' && names.length === 0 && permitIncompleteRetirement
        && sessionControlKey
        && consumeSessionProof()) {
      beforeRetirementValidation();
      return finishRetirement({ state: 'incomplete' });
    }
    throw control.error ?? new Error('staging deadline recovery authority is missing');
  }
  const expectedNames = new Set(['control.json']);
  const acknowledgements = new Map();
  const acknowledgementMarkers = new Set();
  const requests = new Map();
  const requestMarkers = new Set();
  for (const name of names) {
    const acknowledgementMatch = /^ack-(\d+)\.json$/u.exec(name);
    const acknowledgementMarkerMatch = /^ack-(\d+)\.json\.ready$/u.exec(name);
    const requestMatch = /^request-(\d+)\.json$/u.exec(name);
    const requestMarkerMatch = /^request-(\d+)\.json\.ready$/u.exec(name);
    if (!acknowledgementMatch && !acknowledgementMarkerMatch
        && !requestMatch && !requestMarkerMatch && name !== 'control.json') {
      throw new Error('staging deadline recovery authority contains an unknown record');
    }
    if (acknowledgementMatch) {
      const sequence = Number(acknowledgementMatch[1]);
      if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence > 2
          || acknowledgements.has(sequence)) {
        throw new Error('staging deadline recovery acknowledgement sequence is invalid');
      }
      acknowledgements.set(sequence, name);
      expectedNames.add(name);
    }
    if (acknowledgementMarkerMatch) {
      const sequence = Number(acknowledgementMarkerMatch[1]);
      if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence > 2
          || acknowledgementMarkers.has(sequence)) {
        throw new Error('staging deadline recovery acknowledgement marker sequence is invalid');
      }
      acknowledgementMarkers.add(sequence);
      expectedNames.add(name);
    }
    if (requestMatch) {
      const sequence = Number(requestMatch[1]);
      if (!Number.isSafeInteger(sequence) || sequence < 1 || sequence > 2
          || requests.has(sequence)) {
        throw new Error('staging deadline recovery request sequence is invalid');
      }
      requests.set(sequence, name);
      expectedNames.add(name);
    }
    if (requestMarkerMatch) {
      const sequence = Number(requestMarkerMatch[1]);
      if (!Number.isSafeInteger(sequence) || sequence < 1 || sequence > 2
          || requestMarkers.has(sequence)) {
        throw new Error('staging deadline recovery request marker sequence is invalid');
      }
      requestMarkers.add(sequence);
      expectedNames.add(name);
    }
  }
  if (expectedNames.size !== names.length) {
    throw new Error('staging deadline recovery authority is incomplete');
  }
  for (const sequence of acknowledgementMarkers) {
    if (!acknowledgements.has(sequence)) {
      throw new Error('staging deadline recovery acknowledgement marker is orphaned');
    }
  }
  for (const sequence of requestMarkers) {
    if (!requests.has(sequence)) {
      throw new Error('staging deadline recovery request marker is orphaned');
    }
  }

  const messageOrder = [
    { kind: 'acknowledgement', markers: acknowledgementMarkers, records: acknowledgements,
      sequence: 0 },
    { kind: 'request', markers: requestMarkers, records: requests, sequence: 1 },
    { kind: 'acknowledgement', markers: acknowledgementMarkers, records: acknowledgements,
      sequence: 1 },
    { kind: 'request', markers: requestMarkers, records: requests, sequence: 2 },
    { kind: 'acknowledgement', markers: acknowledgementMarkers, records: acknowledgements,
      sequence: 2 },
  ];
  const firstUnsealed = messageOrder.findIndex(({ markers, records, sequence }) => (
    records.has(sequence) && !markers.has(sequence)
  ));
  if (firstUnsealed !== -1 && messageOrder.slice(firstUnsealed + 1)
    .some(({ markers, records, sequence }) => records.has(sequence) || markers.has(sequence))) {
    throw new Error('staging deadline recovery authority follows an unsealed record');
  }
  if (messageOrder.filter(({ markers, records, sequence }) => (
    records.has(sequence) && !markers.has(sequence)
  )).length > 1) {
    throw new Error('staging deadline recovery authority has multiple unsealed records');
  }

  let finalSequence = Math.max(...requests.keys(), 0);
  let incomplete = false;
  const readyIsPaired = acknowledgements.has(0) && acknowledgementMarkers.has(0);
  if (!readyIsPaired) {
    const onlyUnpublishedReady = acknowledgements.has(0) && !acknowledgementMarkers.has(0)
      && names.length === 2;
    const controlOnly = !acknowledgements.has(0) && names.length === 1;
    if (!onlyUnpublishedReady && !controlOnly) {
      throw new Error('staging deadline recovery authority is incomplete');
    }
    finalSequence = 0;
    incomplete = true;
  } else {
    const ready = readDeadlineRecoverySnapshotFile(
      semanticSnapshot, acknowledgementPath(control.record, 0), (bytes) => {
      const record = exactAcknowledgement(decodeMessage(bytes, 'staging deadline acknowledgement'));
      if (!encodeStagingDeadlineAcknowledgement(record).equals(bytes)
          || record.sequence !== 0 || record.state !== 'TRANSACTION'
          || record.seconds <= 0 || !tokenMatches(record.token, control.record.token)) {
        throw new Error('staging deadline recovery READY acknowledgement is invalid');
      }
      return record;
      },
    );
    if (ready.state !== 'present') {
      throw ready.error ?? new Error('staging deadline recovery READY acknowledgement is invalid');
    }
  }
  if (!Number.isSafeInteger(finalSequence) || finalSequence > 2) {
    throw new Error('staging deadline recovery transition sequence bound is invalid');
  }
  if (readyIsPaired && finalSequence === 0) incomplete = true;
  if (requests.size !== finalSequence) {
    throw new Error('staging deadline recovery transition sequence has a gap');
  }
  for (const sequence of acknowledgements.keys()) {
    if (sequence > 0 && sequence > finalSequence) {
      throw new Error('staging deadline recovery acknowledgement has no request authority');
    }
  }
  const expectedTransitions = finalSequence === 2
    ? [
      { action: 'ROLLOVER', seconds: null, state: 'RECOVERY' },
      { action: 'DISARM', seconds: 0, state: 'DISARMED' },
    ] : [];
  for (let sequence = 1; sequence <= finalSequence; sequence += 1) {
    if (!requestMarkers.has(sequence)) {
      if (sequence !== finalSequence) {
        throw new Error('staging deadline recovery request sequence has an unsealed gap');
      }
      incomplete = true;
      continue;
    }
    const request = readDeadlineRecoverySnapshotFile(
      semanticSnapshot, requestPath(control.record, sequence), decodeStagingDeadlineRequest,
    );
    if (request.state !== 'present' || request.record.sequence !== sequence
        || !tokenMatches(request.record.token, control.record.token)) {
      throw request.error ?? new Error('staging deadline recovery request authority is invalid');
    }
    const expected = finalSequence === 1 && sequence === 1
      ? (request.record.action === 'ROLLOVER'
        ? { action: 'ROLLOVER', seconds: null, state: 'RECOVERY' }
        : { action: 'DISARM', seconds: 0, state: 'DISARMED' })
      : expectedTransitions[sequence - 1];
    if (request.record.action !== expected.action
        || (expected.seconds === null ? request.record.seconds <= 0
          : request.record.seconds !== expected.seconds)) {
      throw new Error('staging deadline recovery transition state machine is invalid');
    }
    if (!acknowledgements.has(sequence) || !acknowledgementMarkers.has(sequence)) {
      if (sequence !== finalSequence) {
        throw new Error('staging deadline recovery acknowledgement sequence has a gap');
      }
      incomplete = true;
    } else {
      const acknowledgementRecord = readDeadlineRecoverySnapshotFile(
        semanticSnapshot, acknowledgementPath(control.record, sequence), (bytes) => (
          decodeStagingDeadlineAcknowledgement(bytes, {
            expectedSeconds: request.record.seconds,
            expectedSequence: sequence,
            expectedState: expected.state,
            expectedToken: control.record.token,
          })
        ),
      );
      if (acknowledgementRecord.state !== 'present') {
        throw acknowledgementRecord.error
          ?? new Error('staging deadline recovery acknowledgement authority is invalid');
      }
    }
    if (finalSequence === 1 && request.record.action === 'ROLLOVER') incomplete = true;
    if (incomplete && sequence !== finalSequence) {
      throw new Error('staging deadline recovery transition follows an incomplete prefix');
    }
  }
  if (incomplete && (!permitIncompleteRetirement || !sessionControlKey
      || !consumeSessionProof())) {
    throw new Error('staging deadline recovery requires session-proven incomplete retirement');
  }
  // Re-read the root record immediately before the typed retirement boundary.
  const finalControl = readExactFile(path.join(directory, 'control.json'), (bytes) => {
    const value = JSON.parse(bytes.toString('utf8'));
    const specification = exactSpecification(value);
    if (!Buffer.from(canonicalJson(specification)).equals(bytes)
        || specification.controlDirectory !== directory
        || !tokenMatches(specification.token, control.record.token)) {
      throw new Error('staging deadline recovery control changed before retirement');
    }
    return specification;
  });
  if (finalControl.state !== 'present') {
    throw finalControl.error ?? new Error('staging deadline recovery control disappeared before retirement');
  }
  beforeRetirementValidation();
  return finishRetirement({ finalSequence, state: incomplete ? 'incomplete' : 'DISARMED' });
}

async function waitForAcknowledgement({
  specification,
  sequence,
  expectedState,
  expectedSeconds,
  timeoutMilliseconds,
  pollMilliseconds,
}) {
  if (!Number.isSafeInteger(timeoutMilliseconds) || timeoutMilliseconds <= 0
      || !Number.isSafeInteger(pollMilliseconds) || pollMilliseconds <= 0) {
    throw new Error('staging deadline acknowledgement bound is invalid');
  }
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    const result = readPublishedDeadlineFile(acknowledgementPath(specification, sequence), (bytes) => (
      decodeStagingDeadlineAcknowledgement(bytes, {
        expectedSequence: sequence,
        expectedSeconds,
        expectedState,
        expectedToken: specification.token,
      })
    ));
    if (result.state === 'present') return result.record;
    if (result.state === 'unknown') throw result.error;
    await new Promise((resolve) => setTimeout(resolve, pollMilliseconds));
  }
  const error = new Error('staging deadline acknowledgement timed out');
  error.code = 'STAGING_DEADLINE_ACK_TIMEOUT';
  throw error;
}

export async function awaitStagingDeadlineReady({
  environmentValue = process.env[STAGING_DEADLINE_CONTROL_ENVIRONMENT],
  transactionSeconds,
  timeoutMilliseconds = 5_000,
  pollMilliseconds = 20,
} = {}) {
  return waitForAcknowledgement({
    expectedState: 'TRANSACTION',
    expectedSeconds: positiveInteger(transactionSeconds, 'staging transaction deadline'),
    pollMilliseconds,
    sequence: 0,
    specification: decodeSpecification(environmentValue),
    timeoutMilliseconds,
  });
}

export async function requestStagingDeadlineTransition({
  action,
  seconds,
  sequence,
  environmentValue = process.env[STAGING_DEADLINE_CONTROL_ENVIRONMENT],
  timeoutMilliseconds = 5_000,
  pollMilliseconds = 20,
  synchronizeDirectory = syncDirectory,
} = {}) {
  const specification = decodeSpecification(environmentValue);
  const request = exactRequest({
    action,
    protocol: STAGING_DEADLINE_PROTOCOL,
    seconds,
    sequence,
    token: specification.token,
  });
  const requestFile = requestPath(specification, sequence);
  const requestBytes = encodeStagingDeadlineRequest(request);
  publishDurableStagingDeadlineMessage(requestFile, requestBytes, { synchronizeDirectory });
  const expectedState = action === 'ROLLOVER' ? 'RECOVERY' : 'DISARMED';
  return waitForAcknowledgement({
    expectedSeconds: seconds,
    expectedState,
    pollMilliseconds,
    sequence,
    specification,
    timeoutMilliseconds,
  });
}

export function createStagingDeadlineController({
  token,
  transactionSeconds,
  recoverySeconds,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  onDeadline = () => {},
} = {}) {
  const authorityToken = exactToken(token);
  const transactionBound = positiveInteger(transactionSeconds, 'transaction deadline');
  const recoveryBound = positiveInteger(recoverySeconds, 'recovery deadline');
  if (typeof setTimer !== 'function' || typeof clearTimer !== 'function'
      || typeof onDeadline !== 'function') {
    throw new Error('staging deadline controller dependencies are invalid');
  }

  let currentState = 'INITIAL';
  let currentSequence = 0;
  let activeTimer;

  const expire = (expectedState, expectedSequence) => {
    if (currentState === 'DISARMED' || currentState === 'EXPIRED') return;
    if (currentState !== 'UNPROVEN'
        && (currentState !== expectedState || currentSequence !== expectedSequence)) return;
    activeTimer = undefined;
    currentState = 'EXPIRED';
    onDeadline(Object.freeze({ sequence: currentSequence, state: expectedState }));
  };
  const schedule = (seconds, label, expectedState, expectedSequence) => setTimer(
    () => expire(expectedState, expectedSequence), seconds * 1_000, label,
  );
  const markUnproven = (error) => {
    currentState = 'UNPROVEN';
    throw error;
  };

  return Object.freeze({
    ready() {
      if (currentState !== 'INITIAL') throw new Error('staging deadline is already ready');
      activeTimer = schedule(transactionBound, 'transaction', 'TRANSACTION', 0);
      currentState = 'TRANSACTION';
      return acknowledgement(authorityToken, 0, currentState, transactionBound);
    },
    state() { return currentState; },
    transition(input) {
      const transition = exactRequest(input);
      if (!tokenMatches(transition.token, authorityToken)) {
        throw new Error('staging deadline request token does not match');
      }
      if (currentState === 'INITIAL') throw new Error('staging deadline controller is not ready');
      if (currentState === 'DISARMED') throw new Error('staging deadline controller is disarmed');
      if (currentState === 'EXPIRED' || currentState === 'UNPROVEN') {
        throw new Error('staging deadline controller settlement is unproven');
      }
      if (transition.sequence !== currentSequence + 1) {
        throw new Error('staging deadline request sequence is stale or non-monotonic');
      }

      if (transition.action === 'ROLLOVER') {
        if (currentState !== 'TRANSACTION' || transition.seconds !== recoveryBound) {
          throw new Error('staging recovery deadline rollover is invalid');
        }
        let replacement;
        try {
          replacement = schedule(recoveryBound, 'recovery', 'RECOVERY', transition.sequence);
          clearTimer(activeTimer);
        } catch (error) {
          if (replacement !== undefined) {
            try { clearTimer(replacement); } catch {}
          }
          return markUnproven(error);
        }
        activeTimer = replacement;
        currentSequence = transition.sequence;
        currentState = 'RECOVERY';
        return acknowledgement(
          authorityToken, currentSequence, currentState, recoveryBound,
        );
      }

      if (transition.seconds !== 0) {
        throw new Error('staging deadline disarm seconds must be zero');
      }
      try {
        clearTimer(activeTimer);
      } catch (error) {
        return markUnproven(error);
      }
      activeTimer = undefined;
      currentSequence = transition.sequence;
      currentState = 'DISARMED';
      return acknowledgement(authorityToken, currentSequence, currentState, 0);
    },
  });
}
