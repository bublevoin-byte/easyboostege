import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { movePosixEntryNoReplace } from './posix-session-supervisor.js';

const ENVIRONMENT_MAX_BYTES = 4 * 1024 * 1024;
const DOCKER_INSPECTION_MAX_BYTES = 4 * 1024 * 1024;
const SHA_BYTES = 65;
const SHA_PATTERN = /^[a-f0-9]{64}$/u;
const CONTAINER_ID_PATTERN = /^[a-f0-9]{64}$/u;
const IMAGE_ID_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const LEGACY_APP_MODE_PATTERN = /^(?:700|755)$/u;
const LEGACY_MARKER_MODE_PATTERN = /^(?:600|644)$/u;
const LEGACY_COMPOSE_MODE_PATTERN = /^(?:600|644|664)$/u;
const CUTOVER_JOURNAL_PROTOCOL = 'easyboost-staging-cutover-v1';
const CUTOVER_LEGACY_AUTHORITY_PROTOCOL = 'easyboost-staging-cutover-legacy-authority-v1';
const CUTOVER_JOURNAL_PREPARING_PREFIX = '.staging-recovery-required.cutover-';
const CUTOVER_JOURNAL_PREPARING_PATTERN = /^\.staging-recovery-required\.cutover-[a-f0-9]{64}\.preparing$/u;
const CUTOVER_APP_ROOT_MAX_ENTRIES = 4096;

function currentIdentity({ platform = process.platform } = {}) {
  if (platform === 'win32') return { gid: null, uid: null };
  return { gid: process.getgid(), uid: process.getuid() };
}

function assertLegacyModeTuple({ legacyAppMode, legacyMarkerMode, legacyComposeMode }, role) {
  if (!LEGACY_APP_MODE_PATTERN.test(legacyAppMode ?? '')
      || !LEGACY_MARKER_MODE_PATTERN.test(legacyMarkerMode ?? '')
      || !LEGACY_COMPOSE_MODE_PATTERN.test(legacyComposeMode ?? '')
      || (legacyComposeMode === '664' && legacyAppMode !== '700')) {
    throw new Error(`${role} legacy mode tuple is invalid`);
  }
}

function syncParent(directoryEntry, operations = fs, platform = process.platform) {
  if (platform === 'win32') return;
  const descriptor = operations.openSync(path.dirname(directoryEntry), fs.constants.O_RDONLY);
  try { operations.fsyncSync(descriptor); } finally { operations.closeSync(descriptor); }
}

function canonicalCutoverJournal({
  bridgeSha256, legacyMarkerSha256, legacyComposeSha256, legacyAppMode,
  legacyMarkerMode, legacyComposeMode, legacyAuthoritySha256, bundleSha256, nonce,
}) {
  for (const [label, value] of Object.entries({
    bridgeSha256, legacyMarkerSha256, legacyComposeSha256, legacyAuthoritySha256,
    bundleSha256, nonce,
  })) {
    if (!SHA_PATTERN.test(value ?? '')) throw new Error(`cutover journal ${label} is invalid`);
  }
  assertLegacyModeTuple({ legacyAppMode, legacyMarkerMode, legacyComposeMode },
    'cutover journal');
  return Buffer.from([
    `protocol=${CUTOVER_JOURNAL_PROTOCOL}`,
    `bridgeSha256=${bridgeSha256}`,
    `legacyMarkerSha256=${legacyMarkerSha256}`,
    `legacyComposeSha256=${legacyComposeSha256}`,
    `legacyAppMode=${legacyAppMode}`,
    `legacyMarkerMode=${legacyMarkerMode}`,
    `legacyComposeMode=${legacyComposeMode}`,
    `legacyAuthoritySha256=${legacyAuthoritySha256}`,
    `bundleSha256=${bundleSha256}`,
    `nonce=${nonce}`,
    '',
  ].join('\n'), 'ascii');
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function canonicalStringMap(value, role, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error(`${role} is invalid`);
  }
  const result = {};
  for (const key of Object.keys(value).sort()) {
    if (key.length === 0 || key.includes('\0') || typeof value[key] !== 'string'
        || value[key].includes('\0')) {
      throw new Error(`${role} must contain only canonical string entries`);
    }
    result[key] = value[key];
  }
  return result;
}

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

export function capturePostgresContainerAuthority({
  inspection, expectedContainerId, expectedImageId,
}) {
  if (!CONTAINER_ID_PATTERN.test(expectedContainerId ?? '')) {
    throw new Error('expected PostgreSQL container identity is noncanonical');
  }
  if (!IMAGE_ID_PATTERN.test(expectedImageId ?? '')) {
    throw new Error('expected PostgreSQL image identity is noncanonical');
  }
  if (!inspection || typeof inspection !== 'object' || Array.isArray(inspection)) {
    throw new Error('PostgreSQL container inspection is invalid');
  }
  if (inspection.Id !== expectedContainerId) {
    throw new Error('PostgreSQL container identity changed during inspection');
  }
  if (inspection.Image !== expectedImageId) {
    throw new Error('PostgreSQL image identity does not match the pinned image');
  }
  const labels = inspection.Config?.Labels;
  if (!labels || typeof labels !== 'object'
      || labels['com.docker.compose.project'] !== 'easyboost-staging'
      || labels['com.docker.compose.service'] !== 'postgres'
      || labels['com.docker.compose.oneoff'] !== 'False') {
    throw new Error('PostgreSQL container Compose identity is invalid');
  }
  if (inspection.State?.Running !== true) {
    throw new Error('PostgreSQL container is not running');
  }
  if (inspection.State?.Health?.Status !== 'healthy') {
    throw new Error('PostgreSQL container is not healthy');
  }
  if (!Array.isArray(inspection.Mounts)) {
    throw new Error('PostgreSQL container mount inventory is invalid');
  }
  const dataMounts = inspection.Mounts.filter(
    (mount) => mount?.Destination === '/var/lib/postgresql/data',
  );
  if (dataMounts.length !== 1) {
    throw new Error('PostgreSQL container must have exactly one data mount');
  }
  const [volume] = dataMounts;
  if (volume.Type !== 'volume' || volume.Name !== 'easyboost-staging_postgres-data'
      || volume.RW !== true || typeof volume.Source !== 'string'
      || !path.posix.isAbsolute(volume.Source) || path.posix.normalize(volume.Source) !== volume.Source
      || volume.Source === '/' || volume.Driver !== 'local'
      || typeof volume.Mode !== 'string' || volume.Mode.includes('\0')
      || typeof volume.Propagation !== 'string' || volume.Propagation.includes('\0')) {
    throw new Error('PostgreSQL named-volume mount identity is invalid');
  }
  return {
    version: 2,
    containerId: inspection.Id,
    imageId: inspection.Image,
    project: labels['com.docker.compose.project'],
    service: labels['com.docker.compose.service'],
    oneoff: labels['com.docker.compose.oneoff'],
    running: inspection.State.Running,
    health: inspection.State.Health.Status,
    volume: {
      type: volume.Type,
      name: volume.Name,
      source: volume.Source,
      destination: volume.Destination,
      driver: volume.Driver,
      mode: volume.Mode,
      propagation: volume.Propagation,
      readWrite: volume.RW,
    },
  };
}

function exactPostgresContainerAuthority(value) {
  const topKeys = [
    'containerId', 'health', 'imageId', 'oneoff', 'project', 'running',
    'service', 'version', 'volume',
  ];
  const volumeKeys = [
    'destination', 'driver', 'mode', 'name', 'propagation', 'readWrite',
    'source', 'type',
  ];
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).sort().join('\0') !== topKeys.sort().join('\0')
      || Object.keys(value.volume ?? {}).sort().join('\0') !== volumeKeys.sort().join('\0')
      || value.version !== 2 || !CONTAINER_ID_PATTERN.test(value.containerId ?? '')
      || !IMAGE_ID_PATTERN.test(value.imageId ?? '') || value.project !== 'easyboost-staging'
      || value.service !== 'postgres' || value.oneoff !== 'False'
      || value.running !== true || value.health !== 'healthy'
      || value.volume.type !== 'volume'
      || value.volume.name !== 'easyboost-staging_postgres-data'
      || value.volume.destination !== '/var/lib/postgresql/data'
      || value.volume.driver !== 'local' || value.volume.readWrite !== true
      || typeof value.volume.mode !== 'string' || value.volume.mode.includes('\0')
      || typeof value.volume.propagation !== 'string' || value.volume.propagation.includes('\0')
      || typeof value.volume.source !== 'string'
      || !path.posix.isAbsolute(value.volume.source)
      || path.posix.normalize(value.volume.source) !== value.volume.source
      || value.volume.source === '/') {
    throw new Error('PostgreSQL container authority is invalid');
  }
  return value;
}

export function completePostgresRuntimeAuthority({ containerAuthority, volumeInspection }) {
  const container = exactPostgresContainerAuthority(containerAuthority);
  if (!volumeInspection || typeof volumeInspection !== 'object'
      || Array.isArray(volumeInspection)) {
    throw new Error('PostgreSQL volume inspection is invalid');
  }
  const labels = canonicalStringMap(volumeInspection.Labels, 'PostgreSQL volume labels');
  const options = canonicalStringMap(
    volumeInspection.Options, 'PostgreSQL volume options', { nullable: true },
  );
  if (volumeInspection.Name !== container.volume.name
      || volumeInspection.Driver !== 'local' || volumeInspection.Scope !== 'local'
      || volumeInspection.Mountpoint !== container.volume.source
      || typeof volumeInspection.Mountpoint !== 'string'
      || !path.posix.isAbsolute(volumeInspection.Mountpoint)
      || path.posix.normalize(volumeInspection.Mountpoint) !== volumeInspection.Mountpoint
      || labels['com.docker.compose.project'] !== 'easyboost-staging'
      || labels['com.docker.compose.volume'] !== 'postgres-data') {
    throw new Error('PostgreSQL volume object does not match the container mount authority');
  }
  return {
    ...container,
    volumeObject: {
      name: volumeInspection.Name,
      driver: volumeInspection.Driver,
      scope: volumeInspection.Scope,
      mountpoint: volumeInspection.Mountpoint,
      labels,
      options,
    },
  };
}

function exactPostgresRuntimeAuthority(value) {
  if (!exactKeys(value, [
    'containerId', 'health', 'imageId', 'oneoff', 'project', 'running', 'service',
    'version', 'volume', 'volumeObject',
  ]) || !exactKeys(value.volumeObject, [
    'driver', 'labels', 'mountpoint', 'name', 'options', 'scope',
  ])) {
    throw new Error('PostgreSQL runtime authority is invalid');
  }
  const { volumeObject, ...containerAuthority } = value;
  const normalized = completePostgresRuntimeAuthority({
    containerAuthority,
    volumeInspection: {
      Name: volumeObject.name,
      Driver: volumeObject.driver,
      Scope: volumeObject.scope,
      Mountpoint: volumeObject.mountpoint,
      Labels: volumeObject.labels,
      Options: volumeObject.options,
    },
  });
  if (JSON.stringify(normalized) !== JSON.stringify(value)) {
    throw new Error('PostgreSQL runtime authority is not canonical');
  }
  return normalized;
}

export function capturePostgresRuntimeAuthority({
  inspection, volumeInspection, expectedContainerId, expectedImageId,
}) {
  return completePostgresRuntimeAuthority({
    containerAuthority: capturePostgresContainerAuthority({
      inspection, expectedContainerId, expectedImageId,
    }),
    volumeInspection,
  });
}

export function verifyCutoverJournalPreparingInventory({
  appDirectory, expectedPath, operations = fs, platform = process.platform,
}) {
  const absoluteApp = path.resolve(appDirectory);
  const absoluteExpected = path.resolve(expectedPath);
  const expectedName = path.basename(absoluteExpected);
  if (absoluteApp !== appDirectory || absoluteExpected !== expectedPath
      || path.dirname(absoluteExpected) !== absoluteApp
      || !CUTOVER_JOURNAL_PREPARING_PATTERN.test(expectedName)) {
    throw new Error('cutover journal preparing namespace arguments are invalid');
  }
  const before = operations.lstatSync(absoluteApp, { bigint: true });
  if (!before.isDirectory() || before.isSymbolicLink()) {
    throw new Error('cutover app root must be a no-follow directory');
  }
  let descriptor;
  let directory;
  try {
    const directoryFlags = fs.constants.O_RDONLY
      | (fs.constants.O_DIRECTORY ?? 0) | (fs.constants.O_NOFOLLOW ?? 0);
    descriptor = operations.openSync(absoluteApp, directoryFlags);
    const opened = operations.fstatSync(descriptor, { bigint: true });
    if (!sameMetadata(opened, before, { platform })) {
      throw new Error('cutover app root changed while opening its namespace');
    }
    const inventoryPath = platform === 'linux' ? `/proc/self/fd/${descriptor}` : absoluteApp;
    directory = operations.opendirSync(inventoryPath);
    let count = 0;
    const reserved = [];
    for (let entry = directory.readSync(); entry !== null; entry = directory.readSync()) {
      count += 1;
      if (count > CUTOVER_APP_ROOT_MAX_ENTRIES) {
        throw new Error('cutover app-root inventory exceeds its entry bound');
      }
      if (entry.name.startsWith(CUTOVER_JOURNAL_PREPARING_PREFIX)) reserved.push(entry.name);
    }
    directory.closeSync();
    directory = undefined;
    const after = operations.fstatSync(descriptor, { bigint: true });
    const finalPath = operations.lstatSync(absoluteApp, { bigint: true });
    if (!sameMetadata(after, opened, { platform })
        || !sameMetadata(finalPath, opened, { platform })) {
      throw new Error('cutover app-root namespace changed during inventory');
    }
    if (reserved.length > 1) {
      throw new Error('cutover journal preparing namespace contains multiple bindings');
    }
    if (reserved.length === 1 && reserved[0] !== expectedName) {
      throw new Error('cutover journal preparing namespace contains a foreign binding');
    }
    return reserved.length === 0 ? { present: false } : { name: expectedName, present: true };
  } finally {
    if (directory !== undefined) directory.closeSync();
    if (descriptor !== undefined) operations.closeSync(descriptor);
  }
}

function metadata(stat, { platform = process.platform } = {}) {
  return {
    dev: String(stat.dev),
    ino: String(stat.ino),
    mode: String(stat.mode),
    nlink: String(stat.nlink),
    uid: String(stat.uid),
    gid: String(stat.gid),
    size: String(stat.size),
    blocks: platform === 'win32' ? null : String(stat.blocks ?? 0),
    mtimeNs: String(stat.mtimeNs),
    ctimeNs: String(stat.ctimeNs),
  };
}

function sameMetadata(left, right, options) {
  return JSON.stringify(metadata(left, options)) === JSON.stringify(metadata(right, options));
}

function assertOwnerMode(stat, expectedMode, role, {
  exactCurrentGroup = false,
  singleLink = false,
} = {}) {
  if (process.platform !== 'win32') {
    if (Number(stat.uid) !== process.getuid()
        || (exactCurrentGroup && Number(stat.gid) !== process.getgid())
        || Number(stat.mode & 0o777n) !== expectedMode) {
      throw new Error(`${role} must have the exact private owner and mode`);
    }
  }
  if (singleLink && stat.nlink !== 1n) throw new Error(`${role} must be a single-link file`);
}

function readStablePrivateFile(file, {
  role, expectedMode = 0o600, maximumBytes, exactBytes, exactCurrentGroup = false,
}) {
  const absolute = path.resolve(file);
  let before;
  try {
    before = fs.lstatSync(absolute, { bigint: true });
  } catch {
    throw new Error(`${role} is missing or unreadable`);
  }
  if (!before.isFile() || before.isSymbolicLink()) throw new Error(`${role} must be a regular no-follow file`);
  assertOwnerMode(before, expectedMode, role, { exactCurrentGroup, singleLink: true });
  if ((exactBytes !== undefined && before.size !== BigInt(exactBytes))
      || (maximumBytes !== undefined && before.size > BigInt(maximumBytes))) {
    throw new Error(`${role} exceeds its byte bound or exact size`);
  }
  let descriptor;
  try {
    descriptor = fs.openSync(absolute, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (!sameMetadata(opened, before)) throw new Error(`${role} changed while opening`);
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor, { bigint: true });
    const finalPath = fs.lstatSync(absolute, { bigint: true });
    if (!sameMetadata(after, opened) || !sameMetadata(finalPath, opened)
        || BigInt(bytes.length) !== opened.size) {
      throw new Error(`${role} changed during descriptor read`);
    }
    return { bytes, record: { ...metadata(opened), sha256: sha256(bytes) } };
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function assertCanonicalPrefix(bytes, canonicalBytes, role) {
  if (!Buffer.isBuffer(canonicalBytes) || canonicalBytes.length < 1
      || bytes.length > canonicalBytes.length
      || !bytes.equals(canonicalBytes.subarray(0, bytes.length))) {
    throw new Error(`${role} bytes are not an exact canonical prefix`);
  }
}

export function capturePrivateFilePrefix({
  file, canonicalBytes, role, expectedMode = 0o600, operations = fs,
  platform = process.platform,
}) {
  const absolute = path.resolve(file);
  let existing;
  try {
    existing = operations.lstatSync(absolute, { bigint: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return { present: false };
    throw error;
  }
  if (!existing.isFile() || existing.isSymbolicLink()) {
    throw new Error(`${role} must be a regular no-follow file`);
  }
  const owner = currentIdentity({ platform });
  if (platform !== 'win32' && (Number(existing.uid) !== owner.uid
      || Number(existing.gid) !== owner.gid)) {
    throw new Error(`${role} must have the exact current uid and gid`);
  }
  assertOwnerMode(existing, expectedMode, role, { singleLink: true });
  if (existing.size > BigInt(canonicalBytes.length)) {
    throw new Error(`${role} exceeds its canonical byte bound`);
  }
  let descriptor;
  try {
    descriptor = operations.openSync(absolute,
      fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW ?? 0));
    const opened = operations.fstatSync(descriptor, { bigint: true });
    if (!sameMetadata(opened, existing, { platform })) {
      throw new Error(`${role} changed while opening`);
    }
    const bytes = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = operations.readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (count < 1) throw new Error(`${role} ended before its recorded size`);
      offset += count;
    }
    assertCanonicalPrefix(bytes, canonicalBytes, role);
    const after = operations.fstatSync(descriptor, { bigint: true });
    const finalPath = operations.lstatSync(absolute, { bigint: true });
    if (!sameMetadata(after, opened, { platform })
        || !sameMetadata(finalPath, opened, { platform })) {
      throw new Error(`${role} changed during descriptor prefix capture`);
    }
    return { present: true, authority: { ...metadata(opened, { platform }), sha256: sha256(bytes) } };
  } finally {
    if (descriptor !== undefined) operations.closeSync(descriptor);
  }
}

export function completePrivateFilePrefix({
  file, canonicalBytes, role, authority, expectedMode = 0o600, operations = fs,
  platform = process.platform,
}) {
  const absolute = path.resolve(file);
  const current = capturePrivateFilePrefix({
    file: absolute, canonicalBytes, role, expectedMode, operations, platform,
  });
  if (JSON.stringify(current) !== JSON.stringify(authority)) {
    throw new Error(`${role} presence, identity or bytes changed before completion`);
  }
  const flags = fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW ?? 0)
    | (current.present ? 0 : fs.constants.O_CREAT | fs.constants.O_EXCL);
  let descriptor;
  try {
    descriptor = operations.openSync(absolute, flags, expectedMode);
    const opened = operations.fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || opened.isSymbolicLink()) {
      throw new Error(`${role} must remain a regular no-follow file`);
    }
    const owner = currentIdentity({ platform });
    if (platform !== 'win32' && (Number(opened.uid) !== owner.uid
        || Number(opened.gid) !== owner.gid)) {
      throw new Error(`${role} owner changed during completion`);
    }
    assertOwnerMode(opened, expectedMode, role, { singleLink: true });
    if (current.present && !sameMetadata(opened, current.authority, { platform })) {
      throw new Error(`${role} changed while reopening for completion`);
    }
    const prefixLength = Number(opened.size);
    if (!Number.isSafeInteger(prefixLength) || prefixLength > canonicalBytes.length) {
      throw new Error(`${role} size changed during completion`);
    }
    const existing = Buffer.alloc(prefixLength);
    let readOffset = 0;
    while (readOffset < existing.length) {
      const count = operations.readSync(descriptor, existing, readOffset,
        existing.length - readOffset, readOffset);
      if (count < 1) throw new Error(`${role} ended during completion`);
      readOffset += count;
    }
    assertCanonicalPrefix(existing, canonicalBytes, role);
    let writeOffset = prefixLength;
    while (writeOffset < canonicalBytes.length) {
      const count = operations.writeSync(descriptor, canonicalBytes, writeOffset,
        canonicalBytes.length - writeOffset, writeOffset);
      if (count < 1) throw new Error(`${role} canonical suffix write stalled`);
      writeOffset += count;
    }
    operations.fsyncSync(descriptor);
    const completed = operations.fstatSync(descriptor, { bigint: true });
    const finalPath = operations.lstatSync(absolute, { bigint: true });
    if (completed.size !== BigInt(canonicalBytes.length)
        || !sameMetadata(completed, finalPath, { platform })) {
      throw new Error(`${role} changed after canonical completion`);
    }
    const exact = Buffer.alloc(canonicalBytes.length);
    let exactOffset = 0;
    while (exactOffset < exact.length) {
      const count = operations.readSync(descriptor, exact, exactOffset,
        exact.length - exactOffset, exactOffset);
      if (count < 1) throw new Error(`${role} ended after canonical completion`);
      exactOffset += count;
    }
    if (!exact.equals(canonicalBytes)) {
      throw new Error(`${role} is not canonical after completion`);
    }
  } finally {
    if (descriptor !== undefined) operations.closeSync(descriptor);
  }
  return capturePrivateFile({
    file: absolute, role, expectedMode, maximumBytes: canonicalBytes.length,
  });
}

export function capturePrivateFile({
  file, role, expectedMode = 0o600, maximumBytes = ENVIRONMENT_MAX_BYTES,
}) {
  return readStablePrivateFile(file, {
    role, expectedMode, maximumBytes,
  }).record;
}

function exactLegacyMode(expectedMode, kind) {
  if (!Number.isInteger(expectedMode) || expectedMode < 0 || expectedMode > 0o777) {
    throw new Error(`legacy cutover ${kind} mode is invalid`);
  }
  const canonical = expectedMode.toString(8);
  const pattern = kind === 'marker' ? LEGACY_MARKER_MODE_PATTERN
    : kind === 'compose' ? LEGACY_COMPOSE_MODE_PATTERN : null;
  if (pattern === null || !pattern.test(canonical)) {
    throw new Error(`legacy cutover ${kind} mode is invalid`);
  }
  return expectedMode;
}

export function captureLegacyCutoverFile({
  file, kind, expectedMode, maximumBytes = ENVIRONMENT_MAX_BYTES,
}) {
  const mode = exactLegacyMode(expectedMode, kind);
  return readStablePrivateFile(file, {
    role: `legacy cutover ${kind}`,
    expectedMode: mode,
    maximumBytes,
    exactCurrentGroup: true,
  }).record;
}

export function verifyLegacyCutoverFile({
  file, kind, expectedMode, maximumBytes = ENVIRONMENT_MAX_BYTES, authority,
}) {
  const current = captureLegacyCutoverFile({ file, kind, expectedMode, maximumBytes });
  if (JSON.stringify(current) !== JSON.stringify(authority)) {
    throw new Error(`legacy cutover ${kind} identity or bytes changed during transaction`);
  }
  return current;
}

export function captureLegacyCutoverRoot({ directory, expectedMode }) {
  if (!Number.isInteger(expectedMode)
      || !LEGACY_APP_MODE_PATTERN.test(expectedMode.toString(8))) {
    throw new Error('legacy cutover app-root mode is invalid');
  }
  const absolute = path.resolve(directory);
  if (absolute !== directory || path.dirname(absolute) === absolute) {
    throw new Error('legacy cutover app-root path must be absolute and canonical');
  }
  const before = fs.lstatSync(absolute, { bigint: true });
  if (!before.isDirectory() || before.isSymbolicLink()) {
    throw new Error('legacy cutover app root must be a real no-follow directory');
  }
  assertOwnerMode(before, expectedMode, 'legacy cutover app root', {
    exactCurrentGroup: true,
  });
  let descriptor;
  try {
    descriptor = fs.openSync(absolute, fs.constants.O_RDONLY
      | (fs.constants.O_DIRECTORY ?? 0) | (fs.constants.O_NOFOLLOW ?? 0));
    const opened = fs.fstatSync(descriptor, { bigint: true });
    const finalPath = fs.lstatSync(absolute, { bigint: true });
    if (!sameMetadata(opened, before) || !sameMetadata(finalPath, opened)) {
      throw new Error('legacy cutover app root changed while opening');
    }
    return Object.freeze({
      version: 1,
      dev: String(opened.dev),
      ino: String(opened.ino),
      uid: String(opened.uid),
      gid: String(opened.gid),
      mode: expectedMode.toString(8),
    });
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

export function verifyLegacyCutoverRoot({ directory, expectedMode, authority }) {
  const current = captureLegacyCutoverRoot({ directory, expectedMode });
  if (JSON.stringify(current) !== JSON.stringify(authority)) {
    throw new Error('legacy cutover app-root identity changed during transaction');
  }
  return current;
}

function exactLegacyDirectoryAuthority(value, role, allowedModes) {
  if (!exactKeys(value, ['dev', 'gid', 'ino', 'mode', 'uid', 'version'])
      || value.version !== 1
      || !/^(?:0|[1-9][0-9]*)$/u.test(value.dev ?? '')
      || !/^(?:0|[1-9][0-9]*)$/u.test(value.ino ?? '')
      || !/^(?:0|[1-9][0-9]*)$/u.test(value.uid ?? '')
      || !/^(?:0|[1-9][0-9]*)$/u.test(value.gid ?? '')
      || !allowedModes.test(value.mode ?? '')) {
    throw new Error(`${role} authority is invalid`);
  }
  const owner = currentIdentity();
  if (process.platform !== 'win32'
      && (Number(value.uid) !== owner.uid || Number(value.gid) !== owner.gid)) {
    throw new Error(`${role} authority has a foreign uid or gid`);
  }
  return value;
}

function exactLegacyEnvironmentAuthority(value) {
  const keys = [
    'blocks', 'ctimeNs', 'dev', 'gid', 'ino', 'mode', 'mtimeNs', 'nlink',
    'sha256', 'size', 'uid',
  ];
  const integer = /^(?:0|[1-9][0-9]*)$/u;
  if (!exactKeys(value, keys)
      || !integer.test(value.dev ?? '') || !integer.test(value.ino ?? '')
      || !integer.test(value.mode ?? '') || !integer.test(value.nlink ?? '')
      || !integer.test(value.uid ?? '') || !integer.test(value.gid ?? '')
      || !integer.test(value.size ?? '') || !integer.test(value.mtimeNs ?? '')
      || !integer.test(value.ctimeNs ?? '') || !SHA_PATTERN.test(value.sha256 ?? '')
      || (value.blocks !== null && !integer.test(value.blocks ?? ''))
      || (process.platform !== 'win32' && value.blocks === null)
      || value.nlink !== '1' || BigInt(value.size) > BigInt(ENVIRONMENT_MAX_BYTES)
      || (BigInt(value.mode) & 0o170000n) !== 0o100000n
      || (BigInt(value.mode) & 0o777n) !== 0o600n) {
    throw new Error('legacy cutover environment authority is invalid');
  }
  const owner = currentIdentity();
  if (process.platform !== 'win32'
      && (Number(value.uid) !== owner.uid || Number(value.gid) !== owner.gid)) {
    throw new Error('legacy cutover environment authority has a foreign uid or gid');
  }
  return Object.freeze({
    dev: value.dev,
    ino: value.ino,
    mode: value.mode,
    nlink: value.nlink,
    uid: value.uid,
    gid: value.gid,
    size: value.size,
    blocks: value.blocks,
    mtimeNs: value.mtimeNs,
    ctimeNs: value.ctimeNs,
    sha256: value.sha256,
  });
}

export function deriveCutoverLegacyAuthoritySha256({
  appDirectory, appRootAuthority, backupsAuthority, rollbacksAuthority,
  environmentAuthority, runningAppContainer, runningAppImage, postgresRuntimeAuthority,
}) {
  if (typeof appDirectory !== 'string' || !path.isAbsolute(appDirectory)
      || path.resolve(appDirectory) !== appDirectory || path.dirname(appDirectory) === appDirectory
      || !CONTAINER_ID_PATTERN.test(runningAppContainer ?? '')
      || !IMAGE_ID_PATTERN.test(runningAppImage ?? '')) {
    throw new Error('cutover legacy runtime authority input is invalid');
  }
  const app = exactLegacyDirectoryAuthority(
    appRootAuthority, 'legacy cutover app root', LEGACY_APP_MODE_PATTERN,
  );
  const backups = exactLegacyDirectoryAuthority(
    backupsAuthority, 'legacy cutover backups root', /^700$/u,
  );
  const rollbacks = exactLegacyDirectoryAuthority(
    rollbacksAuthority, 'legacy cutover rollbacks root', /^700$/u,
  );
  const stableDirectoryIdentity = (authority) => Object.freeze({
    dev: authority.dev,
    gid: authority.gid,
    ino: authority.ino,
    uid: authority.uid,
  });
  const canonical = {
    appDirectory,
    appRoot: stableDirectoryIdentity(app),
    backups: stableDirectoryIdentity(backups),
    environment: exactLegacyEnvironmentAuthority(environmentAuthority),
    postgres: exactPostgresRuntimeAuthority(postgresRuntimeAuthority),
    protocol: CUTOVER_LEGACY_AUTHORITY_PROTOCOL,
    rollbacks: stableDirectoryIdentity(rollbacks),
    runningAppContainer,
    runningAppImage,
  };
  return sha256(Buffer.from(JSON.stringify(canonical), 'utf8'));
}

export function verifyPrivateFile({ file, role, expectedMode, maximumBytes, authority }) {
  const current = capturePrivateFile({ file, role, expectedMode, maximumBytes });
  if (JSON.stringify(current) !== JSON.stringify(authority)) {
    throw new Error(`${role} identity or bytes changed during transaction`);
  }
  return current;
}

export function captureOptionalPrivateFile({
  file, role, expectedMode = 0o600, maximumBytes = 4096,
}) {
  try {
    fs.lstatSync(path.resolve(file));
  } catch (error) {
    if (error?.code === 'ENOENT') return { present: false };
    throw new Error(`${role} is unreadable`);
  }
  return {
    present: true,
    authority: capturePrivateFile({ file, role, expectedMode, maximumBytes }),
  };
}

export function verifyOptionalPrivateFile(options) {
  const current = captureOptionalPrivateFile(options);
  if (JSON.stringify(current) !== JSON.stringify(options.authority)) {
    throw new Error(`${options.role} presence, identity or bytes changed during transaction`);
  }
  return current;
}

function capturePrivateDirectory(directory, role) {
  const absolute = path.resolve(directory);
  const stat = fs.lstatSync(absolute, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${role} must be a real directory`);
  assertOwnerMode(stat, 0o700, role);
  const record = metadata(stat);
  return {
    dev: record.dev,
    ino: record.ino,
    mode: record.mode,
    uid: record.uid,
    gid: record.gid,
  };
}

function captureStoreMember(file, name) {
  const stat = fs.lstatSync(file, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error('staging release store contains a non-regular entry');
  }
  assertOwnerMode(stat, 0o600, `staging release store entry ${name}`, { singleLink: true });
  return { name, ...metadata(stat) };
}

export function captureReleaseStore({ directory, ignoredReservation = '' }) {
  const absolute = path.resolve(directory);
  const ignored = ignoredReservation ? path.resolve(ignoredReservation) : '';
  if (ignored && path.dirname(ignored) !== absolute) {
    throw new Error('staging release store reservation is outside the store');
  }
  const rootBefore = capturePrivateDirectory(absolute, 'staging release store');
  const namesBefore = fs.readdirSync(absolute).sort();
  const entries = namesBefore
    .filter((name) => path.join(absolute, name) !== ignored)
    .map((name) => captureStoreMember(path.join(absolute, name), name));
  const rootAfter = capturePrivateDirectory(absolute, 'staging release store');
  const namesAfter = fs.readdirSync(absolute).sort();
  if (JSON.stringify(rootAfter) !== JSON.stringify(rootBefore)
      || JSON.stringify(namesAfter) !== JSON.stringify(namesBefore)) {
    throw new Error('staging release store membership changed during capture');
  }
  for (const entry of entries) {
    const final = captureStoreMember(path.join(absolute, entry.name), entry.name);
    if (JSON.stringify(final) !== JSON.stringify(entry)) {
      throw new Error('staging release store entry changed during capture');
    }
  }
  return { version: 1, root: rootBefore, ignoredReservation: ignored ? path.basename(ignored) : '', entries };
}

export function verifyReleaseStore(options) {
  const current = captureReleaseStore(options);
  if (JSON.stringify(current) !== JSON.stringify(options.authority)) {
    throw new Error('staging release store identity or membership changed during transaction');
  }
  return current;
}

export function readCanonicalShaFile({ file, role }) {
  const { bytes } = readStablePrivateFile(file, {
    role, expectedMode: 0o600, exactBytes: SHA_BYTES,
  });
  const source = bytes.toString('ascii');
  if (!/^[a-f0-9]{64}\n$/u.test(source)) {
    throw new Error(`${role} must contain exactly one lowercase SHA-256 line`);
  }
  return source.slice(0, 64);
}

export function readCutoverJournal({
  file, bridgeSha256, legacyMarkerSha256, legacyComposeSha256, legacyAppMode,
  legacyMarkerMode, legacyComposeMode, legacyAuthoritySha256, bundleSha256,
}) {
  for (const [label, value] of Object.entries({
    bridgeSha256, legacyMarkerSha256, legacyComposeSha256, legacyAuthoritySha256,
    bundleSha256,
  })) {
    if (!SHA_PATTERN.test(value ?? '')) throw new Error(`cutover journal ${label} is invalid`);
  }
  assertLegacyModeTuple({ legacyAppMode, legacyMarkerMode, legacyComposeMode },
    'cutover journal');
  const { bytes } = readStablePrivateFile(file, {
    role: 'staging cutover journal', expectedMode: 0o600, maximumBytes: 1024,
  });
  const source = bytes.toString('ascii');
  const match = /^protocol=easyboost-staging-cutover-v1\nbridgeSha256=([a-f0-9]{64})\nlegacyMarkerSha256=([a-f0-9]{64})\nlegacyComposeSha256=([a-f0-9]{64})\nlegacyAppMode=(700|755)\nlegacyMarkerMode=(600|644)\nlegacyComposeMode=(600|644|664)\nlegacyAuthoritySha256=([a-f0-9]{64})\nbundleSha256=([a-f0-9]{64})\nnonce=([a-f0-9]{64})\n$/u.exec(source);
  if (!match || Buffer.from(source, 'ascii').compare(bytes) !== 0) {
    throw new Error('staging cutover journal bytes are invalid');
  }
  const [, actualBridge, actualMarker, actualCompose, actualAppMode,
    actualMarkerMode, actualComposeMode, actualAuthority, actualBundle, nonce] = match;
  if (actualBridge !== bridgeSha256 || actualMarker !== legacyMarkerSha256
      || actualCompose !== legacyComposeSha256 || actualAppMode !== legacyAppMode
      || actualMarkerMode !== legacyMarkerMode || actualComposeMode !== legacyComposeMode
      || actualAuthority !== legacyAuthoritySha256
      || actualBundle !== bundleSha256) {
    throw new Error('staging cutover journal does not match the requested transition');
  }
  const canonical = [
    `protocol=${CUTOVER_JOURNAL_PROTOCOL}`,
    `bridgeSha256=${bridgeSha256}`,
    `legacyMarkerSha256=${legacyMarkerSha256}`,
    `legacyComposeSha256=${legacyComposeSha256}`,
    `legacyAppMode=${legacyAppMode}`,
    `legacyMarkerMode=${legacyMarkerMode}`,
    `legacyComposeMode=${legacyComposeMode}`,
    `legacyAuthoritySha256=${legacyAuthoritySha256}`,
    `bundleSha256=${bundleSha256}`,
    `nonce=${nonce}`,
    '',
  ].join('\n');
  if (canonical !== source) throw new Error('staging cutover journal is not canonical');
  return nonce;
}

export function captureCutoverJournalPreparing({
  file, bridgeSha256, legacyMarkerSha256, legacyComposeSha256, legacyAppMode,
  legacyMarkerMode, legacyComposeMode, legacyAuthoritySha256, bundleSha256, nonce,
}) {
  return capturePrivateFilePrefix({
    file,
    canonicalBytes: canonicalCutoverJournal({
      bridgeSha256, legacyMarkerSha256, legacyComposeSha256, legacyAppMode,
      legacyMarkerMode, legacyComposeMode, legacyAuthoritySha256, bundleSha256, nonce,
    }),
    role: 'staging cutover journal deterministic temporary',
  });
}

export function publishCutoverJournal({
  temporary, destination, bridgeSha256, legacyMarkerSha256, legacyComposeSha256,
  legacyAppMode, legacyMarkerMode, legacyComposeMode, legacyAuthoritySha256,
  bundleSha256, nonce,
  authority, operations = fs, platform = process.platform,
  runMove,
}) {
  const canonicalBytes = canonicalCutoverJournal({
    bridgeSha256, legacyMarkerSha256, legacyComposeSha256, legacyAppMode,
    legacyMarkerMode, legacyComposeMode, legacyAuthoritySha256, bundleSha256, nonce,
  });
  const completed = completePrivateFilePrefix({
    file: temporary, canonicalBytes,
    role: 'staging cutover journal deterministic temporary',
    authority, operations, platform,
  });
  try {
    operations.lstatSync(path.resolve(destination));
    throw new Error('staging cutover journal destination is already occupied');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const moved = movePosixEntryNoReplace(path.resolve(temporary), path.resolve(destination), {
    filesystem: operations, platform, runMove,
  });
  syncParent(destination, operations, platform);
  let sourceAbsent = false;
  try { operations.lstatSync(path.resolve(temporary)); } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    sourceAbsent = true;
  }
  const published = readStablePrivateFile(destination, {
    role: 'staging cutover journal', expectedMode: 0o600,
    maximumBytes: canonicalBytes.length,
  });
  if (!sourceAbsent || published.bytes.compare(canonicalBytes) !== 0
      || String(moved.dev) !== published.record.dev
      || String(moved.ino) !== published.record.ino
      || completed.dev !== published.record.dev || completed.ino !== published.record.ino) {
    throw new Error('staging cutover journal publication did not commit exact identity and bytes');
  }
  return published.record;
}

function canonicalCutoverMarker(bridgeSha256) {
  if (!SHA_PATTERN.test(bridgeSha256 ?? '')) {
    throw new Error('cutover active marker SHA-256 is invalid');
  }
  return Buffer.from(`${bridgeSha256}\n`, 'ascii');
}

export function captureCutoverMarkerPreparing({ file, bridgeSha256 }) {
  return capturePrivateFilePrefix({
    file, canonicalBytes: canonicalCutoverMarker(bridgeSha256),
    role: 'staging cutover active-marker deterministic temporary',
  });
}

export function publishCutoverActiveMarker({
  temporary, destination, bridgeSha256, legacyMarkerSha256, temporaryAuthority,
  destinationAuthority, operations = fs, platform = process.platform,
  beforeReplace = () => {},
}) {
  if (!SHA_PATTERN.test(legacyMarkerSha256 ?? '') || typeof beforeReplace !== 'function') {
    throw new Error('legacy cutover active marker authority is invalid');
  }
  const canonicalBytes = canonicalCutoverMarker(bridgeSha256);
  const completed = completePrivateFilePrefix({
    file: temporary, canonicalBytes,
    role: 'staging cutover active-marker deterministic temporary',
    authority: temporaryAuthority, operations, platform,
  });
  const verifyDestination = () => {
    verifyOptionalPrivateFile({
      file: destination, role: 'active release marker', expectedMode: 0o600,
      maximumBytes: SHA_BYTES, authority: destinationAuthority,
    });
    if (readCanonicalShaFile({ file: destination, role: 'cutover legacy active marker' })
        !== legacyMarkerSha256) {
      throw new Error('cutover legacy active marker bytes changed before replacement');
    }
  };
  verifyDestination();
  beforeReplace();
  verifyDestination();
  operations.renameSync(path.resolve(temporary), path.resolve(destination));
  syncParent(destination, operations, platform);
  let sourceAbsent = false;
  try { operations.lstatSync(path.resolve(temporary)); } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    sourceAbsent = true;
  }
  const published = readStablePrivateFile(destination, {
    role: 'published bridge marker', expectedMode: 0o600, exactBytes: SHA_BYTES,
  });
  if (!sourceAbsent || published.bytes.compare(canonicalBytes) !== 0
      || completed.dev !== published.record.dev || completed.ino !== published.record.ino) {
    throw new Error('cutover active marker replacement did not commit exact identity and bytes');
  }
  return published.record;
}

export function readEnvironmentPort({ file }) {
  const { bytes } = readStablePrivateFile(file, {
    role: 'staging environment', expectedMode: 0o600, maximumBytes: ENVIRONMENT_MAX_BYTES,
  });
  const source = bytes.toString('utf8');
  if (Buffer.from(source, 'utf8').compare(bytes) !== 0 || source.includes('\0')) {
    throw new Error('staging environment encoding is invalid');
  }
  const ports = source.split(/\r?\n/u)
    .filter((line) => line.startsWith('APP_PORT='))
    .map((line) => line.slice('APP_PORT='.length));
  if (ports.length !== 1 || ports[0] !== '3001') {
    throw new Error('staging APP_PORT must be exactly 3001');
  }
  return ports[0];
}

export function captureProtectedRuntime({ appDirectory }) {
  const app = path.resolve(appDirectory);
  return {
    version: 1,
    app: capturePrivateDirectory(app, 'staging root'),
    backups: capturePrivateDirectory(path.join(app, 'backups'), 'staging backup root'),
    rollbacks: capturePrivateDirectory(path.join(app, 'rollbacks'), 'staging rollback root'),
    store: capturePrivateDirectory(path.join(app, 'rollbacks', 'releases'), 'staging release store'),
    environment: readStablePrivateFile(path.join(app, '.env.staging'), {
      role: 'staging environment', expectedMode: 0o600, maximumBytes: ENVIRONMENT_MAX_BYTES,
    }).record,
    lock: readStablePrivateFile(path.join(app, '.staging-release.lock'), {
      role: 'staging release lock', expectedMode: 0o600, maximumBytes: 4096,
    }).record,
  };
}

export function verifyProtectedRuntime({ appDirectory, authority }) {
  const current = captureProtectedRuntime({ appDirectory });
  if (JSON.stringify(current) !== JSON.stringify(authority)) {
    throw new Error('protected staging runtime authority changed during transaction');
  }
  return current;
}

function statStablePrivateFile(file, {
  role, expectedMode = 0o600, maximumBytes = Number.MAX_SAFE_INTEGER, operations = fs,
  platform = process.platform,
}) {
  const absolute = path.resolve(file);
  let before;
  try {
    before = operations.lstatSync(absolute, { bigint: true });
  } catch {
    throw new Error(role + ' is missing or unreadable');
  }
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error(role + ' must be a regular no-follow file');
  }
  assertOwnerMode(before, expectedMode, role, { singleLink: true });
  if (before.size > BigInt(maximumBytes)) throw new Error(role + ' exceeds its byte bound');
  let descriptor;
  try {
    descriptor = operations.openSync(absolute,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const opened = operations.fstatSync(descriptor, { bigint: true });
    if (!sameMetadata(opened, before, { platform })) throw new Error(role + ' changed while opening');
    const after = operations.fstatSync(descriptor, { bigint: true });
    const finalPath = operations.lstatSync(absolute, { bigint: true });
    if (!sameMetadata(after, opened, { platform })
        || !sameMetadata(finalPath, opened, { platform })) {
      throw new Error(role + ' changed during descriptor verification');
    }
    return metadata(opened, { platform });
  } finally {
    if (descriptor !== undefined) operations.closeSync(descriptor);
  }
}

export function captureReservation({
  file, minimumBytes, operations = fs, platform = process.platform,
}) {
  if (!Number.isSafeInteger(minimumBytes) || minimumBytes < 0) {
    throw new Error('staging reservation minimum is invalid');
  }
  const record = statStablePrivateFile(file, {
    role: 'staging disk reservation', expectedMode: 0o600,
    maximumBytes: Number.MAX_SAFE_INTEGER, operations, platform,
  });
  const size = Number(record.size);
  const allocatedBytes = platform === 'win32' ? size : Number(record.blocks) * 512;
  if (!Number.isSafeInteger(size) || size < minimumBytes
      || !Number.isSafeInteger(allocatedBytes) || allocatedBytes < size) {
    throw new Error('staging disk reservation allocated capacity could not be proven');
  }
  const { dev, ino, mode, nlink, uid, gid, size: recordedSize, blocks: recordedBlocks } = record;
  return {
    dev, ino, mode, nlink, uid, gid, size: recordedSize,
    blocks: recordedBlocks,
    allocatedBytes,
  };
}

export function verifyReservation({
  file, minimumBytes, authority, operations = fs, platform = process.platform,
}) {
  const current = captureReservation({ file, minimumBytes, operations, platform });
  if (JSON.stringify(current) !== JSON.stringify(authority)) {
    throw new Error('staging disk reservation identity or allocated capacity changed');
  }
  return current;
}

function parseJson(value, label) {
  try { return JSON.parse(value); } catch { throw new Error(`${label} is invalid`); }
}

async function readBoundedStdin(label, maximumBytes = DOCKER_INSPECTION_MAX_BYTES) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > maximumBytes) {
      process.stdin.destroy();
      throw new Error(`${label} exceeds its byte bound`);
    }
    chunks.push(buffer);
  }
  if (bytes === 0) throw new Error(`${label} is empty`);
  const sourceBytes = Buffer.concat(chunks, bytes);
  const source = sourceBytes.toString('utf8');
  if (Buffer.from(source, 'utf8').compare(sourceBytes) !== 0 || source.includes('\0')) {
    throw new Error(`${label} encoding is invalid`);
  }
  return parseJson(source, label);
}

async function runCli() {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'capture-postgres-container' && args.length === 2) {
    console.log(JSON.stringify(capturePostgresContainerAuthority({
      inspection: await readBoundedStdin('PostgreSQL container inspection'),
      expectedContainerId: args[0], expectedImageId: args[1],
    })));
    return;
  }
  if (command === 'complete-postgres-runtime' && args.length === 1) {
    console.log(JSON.stringify(completePostgresRuntimeAuthority({
      containerAuthority: parseJson(args[0], 'PostgreSQL container authority'),
      volumeInspection: await readBoundedStdin('PostgreSQL volume inspection'),
    })));
    return;
  }
  if (command === 'verify-cutover-journal-namespace' && args.length === 2) {
    console.log(JSON.stringify(verifyCutoverJournalPreparingInventory({
      appDirectory: args[0], expectedPath: args[1],
    })));
    return;
  }
  if (command === 'capture-runtime' && args.length === 1) {
    console.log(JSON.stringify(captureProtectedRuntime({ appDirectory: args[0] })));
    return;
  }
  if (command === 'verify-runtime' && args.length === 2) {
    verifyProtectedRuntime({ appDirectory: args[0], authority: parseJson(args[1], 'runtime authority') });
    return;
  }
  if (command === 'read-sha' && args.length === 2) {
    console.log(readCanonicalShaFile({ file: args[0], role: args[1] }));
    return;
  }
  if (command === 'read-cutover-journal' && args.length === 9) {
    console.log(readCutoverJournal({
      file: args[0], bridgeSha256: args[1], legacyMarkerSha256: args[2],
      legacyComposeSha256: args[3], legacyAppMode: args[4],
      legacyMarkerMode: args[5], legacyComposeMode: args[6],
      legacyAuthoritySha256: args[7], bundleSha256: args[8],
    }));
    return;
  }
  if (command === 'capture-cutover-journal-prefix' && args.length === 10) {
    console.log(JSON.stringify(captureCutoverJournalPreparing({
      file: args[0], bridgeSha256: args[1], legacyMarkerSha256: args[2],
      legacyComposeSha256: args[3], legacyAppMode: args[4],
      legacyMarkerMode: args[5], legacyComposeMode: args[6],
      legacyAuthoritySha256: args[7], bundleSha256: args[8], nonce: args[9],
    })));
    return;
  }
  if (command === 'publish-cutover-journal' && args.length === 12) {
    publishCutoverJournal({
      temporary: args[0], destination: args[1], bridgeSha256: args[2],
      legacyMarkerSha256: args[3], legacyComposeSha256: args[4],
      legacyAppMode: args[5], legacyMarkerMode: args[6], legacyComposeMode: args[7],
      legacyAuthoritySha256: args[8], bundleSha256: args[9], nonce: args[10],
      authority: parseJson(args[11], 'cutover journal prefix authority'),
    });
    return;
  }
  if (command === 'capture-cutover-marker-prefix' && args.length === 2) {
    console.log(JSON.stringify(captureCutoverMarkerPreparing({
      file: args[0], bridgeSha256: args[1],
    })));
    return;
  }
  if (command === 'complete-cutover-marker-prefix' && args.length === 3) {
    console.log(JSON.stringify(completePrivateFilePrefix({
      file: args[0], canonicalBytes: canonicalCutoverMarker(args[1]),
      role: 'staging cutover SHA prefix',
      authority: parseJson(args[2], 'cutover SHA prefix authority'),
    })));
    return;
  }
  if (command === 'publish-cutover-marker' && args.length === 6) {
    publishCutoverActiveMarker({
      temporary: args[0], destination: args[1], bridgeSha256: args[2],
      legacyMarkerSha256: args[3],
      temporaryAuthority: parseJson(args[4], 'cutover marker prefix authority'),
      destinationAuthority: parseJson(args[5], 'active marker authority'),
    });
    return;
  }
  if (command === 'capture-reservation' && args.length === 2) {
    console.log(JSON.stringify(captureReservation({ file: args[0], minimumBytes: Number(args[1]) })));
    return;
  }
  if (command === 'capture-optional-file' && args.length === 4) {
    console.log(JSON.stringify(captureOptionalPrivateFile({
      file: args[0], role: args[1], expectedMode: Number(args[2]), maximumBytes: Number(args[3]),
    })));
    return;
  }
  if (command === 'verify-optional-file' && args.length === 5) {
    verifyOptionalPrivateFile({
      file: args[0], role: args[1], expectedMode: Number(args[2]), maximumBytes: Number(args[3]),
      authority: parseJson(args[4], 'optional private file authority'),
    });
    return;
  }
  if (command === 'capture-store' && (args.length === 1 || args.length === 2)) {
    console.log(JSON.stringify(captureReleaseStore({
      directory: args[0], ignoredReservation: args[1] ?? '',
    })));
    return;
  }
  if (command === 'verify-store' && (args.length === 2 || args.length === 3)) {
    verifyReleaseStore({
      directory: args[0], ignoredReservation: args.length === 3 ? args[1] : '',
      authority: parseJson(args.at(-1), 'release store authority'),
    });
    return;
  }
  if (command === 'read-env-port' && args.length === 1) {
    console.log(readEnvironmentPort({ file: args[0] }));
    return;
  }
  if (command === 'record-field' && args.length === 2) {
    const record = parseJson(args[0], 'authority record');
    const value = record[args[1]];
    if (typeof value !== 'string' && typeof value !== 'number') {
      throw new Error('authority record field is unavailable');
    }
    process.stdout.write(String(value));
    return;
  }
  if (command === 'derive-cutover-legacy-authority' && args.length === 8) {
    console.log(deriveCutoverLegacyAuthoritySha256({
      appDirectory: args[0],
      appRootAuthority: parseJson(args[1], 'legacy cutover app-root authority'),
      backupsAuthority: parseJson(args[2], 'legacy cutover backups authority'),
      rollbacksAuthority: parseJson(args[3], 'legacy cutover rollbacks authority'),
      environmentAuthority: parseJson(args[4], 'legacy cutover environment authority'),
      runningAppContainer: args[5],
      runningAppImage: args[6],
      postgresRuntimeAuthority: parseJson(args[7], 'legacy cutover PostgreSQL authority'),
    }));
    return;
  }
  if (command === 'capture-cutover-legacy-root' && args.length === 2) {
    console.log(JSON.stringify(captureLegacyCutoverRoot({
      directory: args[0], expectedMode: Number(args[1]),
    })));
    return;
  }
  if (command === 'verify-cutover-legacy-root' && args.length === 3) {
    verifyLegacyCutoverRoot({
      directory: args[0], expectedMode: Number(args[1]),
      authority: parseJson(args[2], 'legacy cutover app-root authority'),
    });
    return;
  }
  if (command === 'capture-cutover-legacy-file' && args.length === 4) {
    console.log(JSON.stringify(captureLegacyCutoverFile({
      file: args[0], kind: args[1], expectedMode: Number(args[2]),
      maximumBytes: Number(args[3]),
    })));
    return;
  }
  if (command === 'verify-cutover-legacy-file' && args.length === 5) {
    verifyLegacyCutoverFile({
      file: args[0], kind: args[1], expectedMode: Number(args[2]),
      maximumBytes: Number(args[3]),
      authority: parseJson(args[4], `legacy cutover ${args[1]} authority`),
    });
    return;
  }
  if (command === 'capture-file' && args.length === 4) {
    console.log(JSON.stringify(capturePrivateFile({
      file: args[0], role: args[1], expectedMode: Number(args[2]), maximumBytes: Number(args[3]),
    })));
    return;
  }
  if (command === 'verify-file' && args.length === 5) {
    verifyPrivateFile({
      file: args[0], role: args[1], expectedMode: Number(args[2]), maximumBytes: Number(args[3]),
      authority: parseJson(args[4], 'private file authority'),
    });
    return;
  }
  if (command === 'verify-reservation' && args.length === 3) {
    verifyReservation({
      file: args[0], minimumBytes: Number(args[1]),
      authority: parseJson(args[2], 'reservation authority'),
    });
    return;
  }
  throw new Error('Usage: staging-runtime-authority.js capture-postgres-container CONTAINER_ID IMAGE_ID | complete-postgres-runtime CONTAINER_JSON | verify-cutover-journal-namespace APP EXPECTED | capture-runtime APP | verify-runtime APP JSON | read-sha FILE ROLE | read-cutover-journal FILE BRIDGE_SHA LEGACY_MARKER_SHA LEGACY_COMPOSE_SHA APP_MODE MARKER_MODE COMPOSE_MODE LEGACY_AUTHORITY_SHA BUNDLE_SHA | capture-cutover-journal-prefix FILE BRIDGE_SHA LEGACY_MARKER_SHA LEGACY_COMPOSE_SHA APP_MODE MARKER_MODE COMPOSE_MODE LEGACY_AUTHORITY_SHA BUNDLE_SHA NONCE | publish-cutover-journal TEMP DEST BRIDGE_SHA LEGACY_MARKER_SHA LEGACY_COMPOSE_SHA APP_MODE MARKER_MODE COMPOSE_MODE LEGACY_AUTHORITY_SHA BUNDLE_SHA NONCE JSON | capture-cutover-marker-prefix FILE BRIDGE_SHA | complete-cutover-marker-prefix FILE BRIDGE_SHA JSON | publish-cutover-marker TEMP DEST BRIDGE_SHA LEGACY_SHA TEMP_JSON DEST_JSON | read-env-port FILE | derive-cutover-legacy-authority APP_DIR ROOT_JSON BACKUPS_JSON ROLLBACKS_JSON ENVIRONMENT_JSON APP_CONTAINER APP_IMAGE POSTGRES_JSON | capture-cutover-legacy-root DIR MODE | verify-cutover-legacy-root DIR MODE JSON | capture-cutover-legacy-file FILE KIND MODE MAX | verify-cutover-legacy-file FILE KIND MODE MAX JSON | capture-file FILE ROLE MODE MAX | verify-file FILE ROLE MODE MAX JSON | capture-optional-file FILE ROLE MODE MAX | verify-optional-file FILE ROLE MODE MAX JSON | capture-store DIR [RESERVATION] | verify-store DIR [RESERVATION] JSON | capture-reservation FILE MIN | verify-reservation FILE MIN JSON | record-field JSON FIELD');
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  runCli().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
