import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync, inflateRawSync } from 'node:zlib';

export const ARCHIVE_LIMITS = Object.freeze({
  maxAggregateBytes: 384 * 1024 * 1024,
  maxCompressedBytes: 256 * 1024 * 1024,
  maxDepth: 32,
  maxFileBytes: 16 * 1024 * 1024,
  maxMembers: 4096,
  maxPathBytes: 256,
  minimumDiskHeadroomBytes: 64 * 1024 * 1024,
  validationTimeoutMs: 60_000,
});
export const STAGING_ARCHIVE_PROTOCOL = 'immutable-archive-v4';

const BLOCK = 512;
const COMPOSE_MEMBER = 'compose.staging.yml';
const COMPOSE_IO_CHUNK_BYTES = 64 * 1024;
const TAR_END = Buffer.alloc(BLOCK * 2);
const GZIP_HEADER = Buffer.from([
  0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x02, 0xff,
]);
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const RUNTIME_NAMES = new Set([
  '.env.staging', '.release-sha256', '.staging-recovery-required',
  '.staging-release.lock', 'backups', 'rollbacks',
  '.guarded-staging-build-context-required',
]);
const CRC32_TABLE = Uint32Array.from({ length: 256 }, (_, byte) => {
  let value = byte;
  for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
  return value >>> 0;
});

function archiveError(reason) {
  return new Error(`unsafe release archive: ${reason}`);
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = CRC32_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function canonicalFold(value) {
  return value.normalize('NFC').toLowerCase();
}

function canonicalGzip(bytes) {
  const trailer = Buffer.alloc(8);
  trailer.writeUInt32LE(crc32(bytes), 0);
  trailer.writeUInt32LE(bytes.length >>> 0, 4);
  return Buffer.concat([
    GZIP_HEADER,
    deflateRawSync(bytes, { level: 9 }),
    trailer,
  ]);
}

function compareCanonicalNames(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function canonicalTar(entries) {
  const chunks = [];
  for (const entry of [...entries].sort((left, right) => compareCanonicalNames(left.name, right.name))) {
    chunks.push(makeHeader({ file: entry.name, mode: 0o644, size: entry.size }), entry.body);
    const padding = Math.ceil(entry.size / BLOCK) * BLOCK - entry.size;
    if (padding) chunks.push(Buffer.alloc(padding));
  }
  chunks.push(TAR_END);
  return Buffer.concat(chunks);
}

function gunzipSingleMember(compressed, maximumOutput) {
  if (compressed.length < 18 || !compressed.subarray(0, GZIP_HEADER.length).equals(GZIP_HEADER)) {
    throw archiveError('non-canonical gzip header or flags');
  }
  const offset = GZIP_HEADER.length;
  if (offset + 8 > compressed.length) throw archiveError('truncated gzip stream');
  let inflated;
  try {
    inflated = inflateRawSync(compressed.subarray(offset), {
      info: true, maxOutputLength: maximumOutput,
    });
  } catch {
    throw archiveError('invalid or expanded-overflow gzip stream');
  }
  const trailer = offset + inflated.engine.bytesWritten;
  if (trailer + 8 !== compressed.length) {
    throw archiveError('concatenated or trailing gzip payload');
  }
  const expectedCrc = compressed.readUInt32LE(trailer);
  const expectedSize = compressed.readUInt32LE(trailer + 4);
  if (expectedCrc !== crc32(inflated.buffer)
      || expectedSize !== (inflated.buffer.length >>> 0)) {
    throw archiveError('gzip checksum or size mismatch');
  }
  return inflated.buffer;
}

function identity(stat) {
  return [stat.dev, stat.ino, stat.mode, stat.nlink, stat.size, stat.mtimeNs, stat.ctimeNs]
    .map(String).join(':');
}

function readStableFile(file, label = 'release archive') {
  let before;
  try {
    before = fs.lstatSync(file, { bigint: true });
  } catch {
    throw new Error(`${label} is missing or unreadable`);
  }
  if (!before.isFile() || before.isSymbolicLink()) throw new Error(`${label} must be a regular file`);
  let descriptor;
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || identity(opened) !== identity(before)) {
      throw new Error(`${label} changed while opening`);
    }
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor, { bigint: true });
    const finalPath = fs.lstatSync(file, { bigint: true });
    if (identity(after) !== identity(opened) || identity(finalPath) !== identity(opened)
        || BigInt(bytes.length) !== opened.size) {
      throw new Error(`${label} changed during read`);
    }
    return { bytes, mode: Number(opened.mode & 0o777n) };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(label)) throw error;
    throw new Error(`${label} could not be read safely`);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function decodeField(header, offset, length, label) {
  const field = header.subarray(offset, offset + length);
  const end = field.indexOf(0);
  const bytes = end === -1 ? field : field.subarray(0, end);
  if (end !== -1 && field.subarray(end + 1).some((byte) => byte !== 0)) {
    throw archiveError(`non-canonical ${label} padding`);
  }
  try {
    const decoded = UTF8.decode(bytes);
    if (!Buffer.from(decoded, 'utf8').equals(bytes) || decoded.includes('\ufeff')) {
      throw archiveError(`non-canonical UTF-8 ${label}`);
    }
    return decoded;
  } catch {
    throw archiveError(`invalid UTF-8 ${label}`);
  }
}

function parseOctal(header, offset, length, label) {
  const source = header.subarray(offset, offset + length).toString('ascii')
    .replace(/[\0 ]+$/u, '');
  if (!/^[0-7]+$/u.test(source)) throw archiveError(`invalid ${label}`);
  const value = Number.parseInt(source, 8);
  if (!Number.isSafeInteger(value) || value < 0) throw archiveError(`${label} overflow`);
  return value;
}

function canonicalName(name, limits) {
  if (!name || name !== name.normalize('NFC') || name.startsWith('./') || name.startsWith('/')
      || name.endsWith('/') || name.includes('\\') || /[\u0000-\u001f\u007f-\u009f]/u.test(name)
      || /^[A-Za-z]:/u.test(name) || Buffer.byteLength(name, 'utf8') > limits.maxPathBytes) {
    throw archiveError('non-canonical member name');
  }
  const components = name.split('/');
  if (components.length > limits.maxDepth || components.some((entry) => !entry || entry === '.' || entry === '..')) {
    throw archiveError('non-canonical member name');
  }
  const root = canonicalFold(components[0]);
  if (RUNTIME_NAMES.has(root) || root.startsWith('.release-archive')) {
    throw archiveError('protected runtime path');
  }
  return name;
}

function parseTar(tar, { limits, now }) {
  const started = now();
  const deadline = () => {
    if (now() - started > limits.validationTimeoutMs) {
      throw archiveError('validation time bound exceeded');
    }
  };
  const entries = [];
  const names = new Set();
  const folded = new Map();
  let aggregateBytes = 0;
  let offset = 0;
  let zeroBlocks = 0;
  let terminated = false;
  while (offset + BLOCK <= tar.length) {
    deadline();
    const header = tar.subarray(offset, offset + BLOCK);
    if (header.every((byte) => byte === 0)) {
      zeroBlocks += 1;
      offset += BLOCK;
      if (zeroBlocks === 2) {
        if (offset !== tar.length) throw archiveError('surplus or trailing tar payload');
        terminated = true;
        break;
      }
      continue;
    }
    if (zeroBlocks) throw archiveError('invalid tar terminator');
    const checksumHeader = Buffer.from(header);
    const expectedChecksum = parseOctal(header, 148, 8, 'header checksum');
    checksumHeader.fill(0x20, 148, 156);
    const actualChecksum = checksumHeader.reduce((sum, byte) => sum + byte, 0);
    if (actualChecksum !== expectedChecksum) throw archiveError('header checksum mismatch');
    if (!header.subarray(257, 263).equals(Buffer.from('ustar\0'))
        || !header.subarray(263, 265).equals(Buffer.from('00'))) {
      throw archiveError('unsupported tar header format');
    }
    const type = header[156];
    if (type !== 0 && type !== 0x30) throw archiveError('unsupported member type');
    if (decodeField(header, 157, 100, 'link name')) throw archiveError('regular member has link target');
    const leaf = decodeField(header, 0, 100, 'member name');
    const prefix = decodeField(header, 345, 155, 'member prefix');
    const name = canonicalName(prefix ? `${prefix}/${leaf}` : leaf, limits);
    if (entries.length && compareCanonicalNames(entries.at(-1).name, name) >= 0) {
      throw archiveError('members are not in strict canonical producer order');
    }
    const size = parseOctal(header, 124, 12, 'member size');
    if (!header.equals(makeHeader({ file: name, mode: 0o644, size }))) {
      throw archiveError(`${name}: non-canonical USTAR header`);
    }
    if (size > limits.maxFileBytes) throw archiveError(`${name}: per-file byte bound exceeded`);
    if (entries.length + 1 > limits.maxMembers) throw archiveError('member count bound exceeded');
    aggregateBytes += size;
    if (aggregateBytes > limits.maxAggregateBytes) throw archiveError('expanded byte bound exceeded');
    const bodyStart = offset + BLOCK;
    const paddedSize = Math.ceil(size / BLOCK) * BLOCK;
    const nextOffset = bodyStart + paddedSize;
    if (nextOffset > tar.length) throw archiveError(`${name}: truncated member body`);
    const body = tar.subarray(bodyStart, bodyStart + size);
    if (tar.subarray(bodyStart + size, nextOffset).some((byte) => byte !== 0)) {
      throw archiveError(`${name}: non-zero member padding`);
    }
    if (names.has(name)) throw archiveError('duplicate member collision');
    const caseKey = canonicalFold(name);
    if (folded.has(caseKey)) throw archiveError('normalized/case-folded member collision');
    names.add(name);
    folded.set(caseKey, name);
    entries.push({ body, mode: 0o644, name, size });
    offset = nextOffset;
  }
  if (!terminated) throw archiveError('missing or truncated tar terminator');
  const foldedNames = new Set(folded.keys());
  for (const entry of entries) {
    const parts = entry.name.split('/');
    for (let index = 1; index < parts.length; index += 1) {
      const parent = canonicalFold(parts.slice(0, index).join('/'));
      if (foldedNames.has(parent)) throw archiveError('file/directory prefix collision');
    }
  }
  return { aggregateBytes, entries };
}

function readAndParse({ archivePath, limits = ARCHIVE_LIMITS, now = () => Date.now() }) {
  const stat = fs.lstatSync(archivePath, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink()) throw archiveError('archive must be a regular file');
  if (stat.size > BigInt(limits.maxCompressedBytes)) throw archiveError('compressed byte bound exceeded');
  const { bytes: compressed } = readStableFile(archivePath, 'release archive');
  const maximumOutput = limits.maxAggregateBytes
    + limits.maxMembers * ((BLOCK * 2) - 1) + TAR_END.length;
  if (!Number.isSafeInteger(maximumOutput) || maximumOutput < TAR_END.length) {
    throw archiveError('archive expansion bound overflow');
  }
  const tar = gunzipSingleMember(compressed, maximumOutput);
  const parsed = parseTar(tar, { limits, now });
  const reproducedTar = canonicalTar(parsed.entries);
  if (!reproducedTar.equals(tar) || !canonicalGzip(reproducedTar).equals(compressed)) {
    throw archiveError('archive bytes differ from the canonical producer');
  }
  return { ...parsed, compressedBytes: compressed.length, sha256: sha256(compressed) };
}

function releaseComposeEntry(parsed) {
  const matches = parsed.entries.filter((entry) => entry.name === COMPOSE_MEMBER);
  if (matches.length !== 1) {
    throw archiveError(`${COMPOSE_MEMBER}: archive must contain exactly one literal member`);
  }
  return matches[0];
}

function writeBounded(bytes, writeChunk) {
  if (typeof writeChunk !== 'function') {
    throw new TypeError('release Compose output requires one byte writer');
  }
  let offset = 0;
  while (offset < bytes.length) {
    const end = Math.min(offset + COMPOSE_IO_CHUNK_BYTES, bytes.length);
    let chunkOffset = offset;
    while (chunkOffset < end) {
      const written = writeChunk(bytes.subarray(chunkOffset, end));
      if (!Number.isSafeInteger(written) || written < 1 || written > end - chunkOffset) {
        throw archiveError('release Compose output writer made invalid progress');
      }
      chunkOffset += written;
    }
    offset = end;
  }
}

export async function emitReleaseCompose({
  archivePath,
  limits = ARCHIVE_LIMITS,
  now = () => Date.now(),
  writeChunk = (chunk) => fs.writeSync(1, chunk),
}) {
  // Nothing is emitted until the complete gzip, USTAR inventory, canonical
  // producer bytes and every archive bound have been validated.
  const parsed = readAndParse({ archivePath, limits, now });
  const compose = releaseComposeEntry(parsed);
  writeBounded(compose.body, writeChunk);
  return {
    bytes: compose.size,
    sha256: sha256(compose.body),
  };
}

function sameFileNode(left, right) {
  return left.dev === right.dev && left.ino === right.ino && right.isFile();
}

function exactComposeOutputIdentity(identity, userId, groupId) {
  return identity.isFile() && !identity.isSymbolicLink() && identity.nlink === 1n
    && identity.uid === BigInt(userId) && identity.gid === BigInt(groupId)
    && Number(identity.mode & 0o777n) === 0o600;
}

function verifyComposePrefix(descriptor, expected, length) {
  if (!Number.isSafeInteger(length) || length < 0 || length > expected.length) {
    throw archiveError('release Compose output length is not a bounded prefix');
  }
  const buffer = Buffer.allocUnsafe(Math.min(COMPOSE_IO_CHUNK_BYTES, Math.max(length, 1)));
  let offset = 0;
  while (offset < length) {
    const requested = Math.min(buffer.length, length - offset);
    const received = fs.readSync(descriptor, buffer, 0, requested, offset);
    if (received !== requested
        || !buffer.subarray(0, received).equals(expected.subarray(offset, offset + received))) {
      throw archiveError('release Compose output is not an exact literal prefix');
    }
    offset += received;
  }
}

function stableComposeOutputPath(outputPath, expectedIdentity, userId, groupId) {
  const current = fs.lstatSync(outputPath, { bigint: true });
  if (!exactComposeOutputIdentity(current, userId, groupId)
      || !sameFileNode(expectedIdentity, current)) {
    throw archiveError('release Compose output path identity changed');
  }
  return current;
}

export async function completeReleaseCompose({
  archivePath,
  outputPath,
  limits = ARCHIVE_LIMITS,
  now = () => Date.now(),
}) {
  // Validate the whole archive before creating or opening the deterministic
  // output. Invalid archive input therefore cannot leave filesystem residue.
  const parsed = readAndParse({ archivePath, limits, now });
  const compose = releaseComposeEntry(parsed);
  if (typeof outputPath !== 'string' || !path.isAbsolute(outputPath)
      || path.resolve(outputPath) !== outputPath || path.dirname(outputPath) === outputPath) {
    throw archiveError('release Compose output path must be exact and absolute');
  }
  if (typeof process.getuid !== 'function' || typeof process.getgid !== 'function') {
    throw archiveError('release Compose completion requires POSIX ownership authority');
  }
  if (!Number.isInteger(fs.constants.O_NOFOLLOW)
      || !Number.isInteger(fs.constants.O_DIRECTORY)) {
    throw archiveError('release Compose completion requires no-follow POSIX descriptors');
  }
  const userId = process.getuid();
  const groupId = process.getgid();
  const noFollow = fs.constants.O_NOFOLLOW;
  let descriptor;
  let created = false;
  let pathBefore;
  try {
    try {
      descriptor = fs.openSync(outputPath,
        fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow,
        0o600);
      created = true;
      fs.fchmodSync(descriptor, 0o600);
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      pathBefore = fs.lstatSync(outputPath, { bigint: true });
      if (!exactComposeOutputIdentity(pathBefore, userId, groupId)) {
        throw archiveError('release Compose output has an unsafe identity');
      }
      descriptor = fs.openSync(outputPath, fs.constants.O_RDWR | noFollow);
    }

    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (!exactComposeOutputIdentity(opened, userId, groupId)
        || (pathBefore && !sameFileNode(pathBefore, opened))) {
      throw archiveError('release Compose output changed while opening');
    }
    stableComposeOutputPath(outputPath, opened, userId, groupId);
    if (opened.size > BigInt(compose.size)) {
      throw archiveError('release Compose output is longer than the literal member');
    }
    const appendOffset = Number(opened.size);
    verifyComposePrefix(descriptor, compose.body, appendOffset);
    const beforeAppend = fs.fstatSync(descriptor, { bigint: true });
    stableComposeOutputPath(outputPath, opened, userId, groupId);
    if (!sameFileNode(opened, beforeAppend) || beforeAppend.size !== opened.size) {
      throw archiveError('release Compose output changed before append');
    }

    let offset = appendOffset;
    while (offset < compose.size) {
      const end = Math.min(offset + COMPOSE_IO_CHUNK_BYTES, compose.size);
      const written = fs.writeSync(descriptor, compose.body, offset, end - offset, offset);
      if (!Number.isSafeInteger(written) || written < 1 || written > end - offset) {
        throw archiveError('release Compose output append made invalid progress');
      }
      offset += written;
    }
    fs.fsyncSync(descriptor);
    const completed = fs.fstatSync(descriptor, { bigint: true });
    stableComposeOutputPath(outputPath, opened, userId, groupId);
    if (!sameFileNode(opened, completed) || completed.size !== BigInt(compose.size)) {
      throw archiveError('release Compose output identity changed after append');
    }
    verifyComposePrefix(descriptor, compose.body, compose.size);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
  if (created) {
    const parentDescriptor = fs.openSync(path.dirname(outputPath),
      fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | noFollow);
    try {
      fs.fsyncSync(parentDescriptor);
    } finally {
      fs.closeSync(parentDescriptor);
    }
  }
  const finalIdentity = fs.lstatSync(outputPath, { bigint: true });
  if (!exactComposeOutputIdentity(finalIdentity, userId, groupId)
      || finalIdentity.size !== BigInt(compose.size)) {
    throw archiveError('release Compose output final identity is unsafe');
  }
  const finalDescriptor = fs.openSync(outputPath, fs.constants.O_RDONLY | noFollow);
  try {
    const opened = fs.fstatSync(finalDescriptor, { bigint: true });
    if (!sameFileNode(finalIdentity, opened)) {
      throw archiveError('release Compose output changed during final reproof');
    }
    verifyComposePrefix(finalDescriptor, compose.body, compose.size);
  } finally {
    fs.closeSync(finalDescriptor);
  }
  return {
    bytes: compose.size,
    complete: true,
    sha256: sha256(compose.body),
  };
}

export async function validateReleaseArchive(options) {
  const parsed = readAndParse(options);
  return {
    aggregateBytes: parsed.aggregateBytes,
    compressedBytes: parsed.compressedBytes,
    files: parsed.entries.length,
    sha256: parsed.sha256,
  };
}

function existingAncestor(value) {
  let current = path.resolve(value);
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) throw archiveError('no existing destination ancestor');
    current = parent;
  }
  return current;
}

function defaultAvailableDiskBytes(destination) {
  const stat = fs.statfsSync(existingAncestor(destination), { bigint: true });
  return stat.bavail * stat.bsize;
}

export async function extractReleaseArchive({
  archivePath,
  destination,
  limits = ARCHIVE_LIMITS,
  now = () => Date.now(),
  availableDiskBytes = defaultAvailableDiskBytes,
}) {
  const parsed = readAndParse({ archivePath, limits, now });
  const required = BigInt(parsed.aggregateBytes + limits.minimumDiskHeadroomBytes);
  if (BigInt(availableDiskBytes(destination)) < required) {
    throw archiveError('insufficient disk headroom');
  }
  if (fs.existsSync(destination) && fs.readdirSync(destination).length) {
    throw archiveError('extraction destination is not empty');
  }
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  const started = now();
  for (const entry of parsed.entries) {
    if (now() - started > limits.validationTimeoutMs + 30_000) {
      throw archiveError('extraction time bound exceeded');
    }
    const absolute = path.join(destination, ...entry.name.split('/'));
    fs.mkdirSync(path.dirname(absolute), { recursive: true, mode: 0o700 });
    fs.writeFileSync(absolute, entry.body, { flag: 'wx', mode: entry.mode || 0o600 });
    const written = readStableFile(absolute, entry.name).bytes;
    if (written.length !== entry.size || sha256(written) !== sha256(entry.body)) {
      throw archiveError(`${entry.name}: extracted bytes mismatch`);
    }
  }
  return {
    aggregateBytes: parsed.aggregateBytes,
    files: parsed.entries.length,
    sha256: parsed.sha256,
  };
}

function listTree(directory, prefix = '') {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (!prefix && (RUNTIME_NAMES.has(entry.name) || entry.name.startsWith('.release-archive'))) continue;
    const absolute = path.join(directory, entry.name);
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) throw archiveError(`${name}: live tree symlink is forbidden`);
    if (stat.isDirectory()) files.push(...listTree(absolute, name));
    else if (stat.isFile()) files.push(name);
    else throw archiveError(`${name}: unsupported live tree entry`);
  }
  return files.sort();
}

export async function verifyReleaseTree({ archivePath, directory, limits = ARCHIVE_LIMITS }) {
  const parsed = readAndParse({ archivePath, limits });
  const declared = parsed.entries.map((entry) => entry.name).sort();
  const actual = listTree(directory);
  const expected = new Set(declared);
  for (const name of actual) {
    if (!expected.has(name)) throw archiveError(`${name}: undeclared live tree file`);
  }
  const actualSet = new Set(actual);
  for (const entry of parsed.entries) {
    if (!actualSet.has(entry.name)) throw archiveError(`${entry.name}: live tree file missing`);
    const bytes = readStableFile(path.join(directory, ...entry.name.split('/')), entry.name).bytes;
    if (bytes.length !== entry.size || sha256(bytes) !== sha256(entry.body)) {
      throw archiveError(`${entry.name}: live tree bytes mismatch`);
    }
  }
  return { aggregateBytes: parsed.aggregateBytes, files: parsed.entries.length, sha256: parsed.sha256 };
}

export async function verifyReleaseTreeTransition({
  archivePath,
  directory,
  transitionFile,
  limits = ARCHIVE_LIMITS,
}) {
  const allowedTransition = canonicalName(transitionFile, limits);
  if (allowedTransition !== 'compose.staging.yml') {
    throw archiveError('legacy transition authority must be compose.staging.yml');
  }
  const parsed = readAndParse({ archivePath, limits });
  const declared = parsed.entries.map((entry) => entry.name).sort();
  const actual = listTree(directory);
  if (JSON.stringify(actual) !== JSON.stringify(declared)) {
    throw archiveError('legacy transition tree inventory mismatch');
  }
  const transition = parsed.entries.find((entry) => entry.name === allowedTransition);
  if (!transition) throw archiveError('declared transition file is missing from archive');

  let liveTransitionSha256 = '';
  for (const entry of parsed.entries) {
    const live = readStableFile(
      path.join(directory, ...entry.name.split('/')),
      entry.name,
    ).bytes;
    if (entry.name === allowedTransition) {
      liveTransitionSha256 = sha256(live);
      continue;
    }
    if (live.length !== entry.size || sha256(live) !== sha256(entry.body)) {
      throw archiveError(`${entry.name}: live transition tree bytes mismatch`);
    }
  }
  const archiveTransitionSha256 = sha256(transition.body);
  if (liveTransitionSha256 === archiveTransitionSha256) {
    throw archiveError('declared transition file did not change');
  }
  return {
    aggregateBytes: parsed.aggregateBytes,
    archiveTransitionSha256,
    files: parsed.entries.length,
    liveTransitionSha256,
    sha256: parsed.sha256,
    transitionFile: allowedTransition,
  };
}

function directoryIdentity(stat) {
  return `${stat.dev}:${stat.ino}`;
}

export async function prepareReleaseTreeForCopy({ directory }) {
  const root = path.resolve(directory);
  let directories = 0;
  let files = 0;

  function visit(current, name) {
    let before;
    try {
      before = fs.lstatSync(current, { bigint: true });
    } catch {
      throw archiveError(`${name}: copy source entry is missing or unreadable`);
    }
    if (!before.isDirectory() || before.isSymbolicLink()) {
      throw archiveError(`${name}: copy source directory is unsafe`);
    }
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const childName = name ? `${name}/${entry.name}` : entry.name;
      const child = path.join(current, entry.name);
      const stat = fs.lstatSync(child, { bigint: true });
      if (stat.isSymbolicLink()) {
        throw archiveError(`${childName}: copy source symlink is forbidden`);
      }
      if (stat.isDirectory()) visit(child, childName);
      else if (stat.isFile()) files += 1;
      else throw archiveError(`${childName}: unsupported copy source entry`);
    }
    fs.chmodSync(current, 0o700);
    const after = fs.lstatSync(current, { bigint: true });
    if (!after.isDirectory() || after.isSymbolicLink()
        || directoryIdentity(after) !== directoryIdentity(before)) {
      throw archiveError(`${name}: copy source directory changed during mode preparation`);
    }
    directories += 1;
  }

  visit(root, '.');
  return { directories, files };
}

function splitTarPath(file) {
  if (Buffer.byteLength(file, 'utf8') <= 100) return { name: file, prefix: '' };
  for (const match of [...file.matchAll(/\//gu)].reverse()) {
    const prefix = file.slice(0, match.index);
    const name = file.slice(match.index + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) return { name, prefix };
  }
  throw archiveError(`${file}: path cannot be represented by USTAR`);
}

function writeOctal(header, offset, length, value) {
  const octal = BigInt(value).toString(8);
  if (octal.length > length - 1) throw archiveError('USTAR numeric field overflow');
  header.write(`${octal.padStart(length - 1, '0')}\0`, offset, length, 'ascii');
}

function makeHeader({ file, mode, size }) {
  const header = Buffer.alloc(BLOCK);
  const split = splitTarPath(file);
  header.write(split.name, 0, 100, 'utf8');
  writeOctal(header, 100, 8, mode & 0o777);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = 0x30;
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  writeOctal(header, 329, 8, 0);
  writeOctal(header, 337, 8, 0);
  header.write(split.prefix, 345, 155, 'utf8');
  const checksum = header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0');
  header.write(checksum, 148, 6, 'ascii');
  header[154] = 0;
  header[155] = 0x20;
  return header;
}

export async function createReleaseArchive({ sourceDirectory, files, outputPath }) {
  const limits = ARCHIVE_LIMITS;
  const unique = [...new Set(files)].sort(compareCanonicalNames);
  if (unique.length !== files.length || unique.length > limits.maxMembers) {
    throw archiveError('duplicate or excessive release input list');
  }
  const folded = new Set();
  const entries = [];
  let aggregateBytes = 0;
  for (const requested of unique) {
    const file = canonicalName(requested.split(path.sep).join('/'), limits);
    const key = canonicalFold(file);
    if (folded.has(key)) throw archiveError('normalized/case-folded member collision');
    folded.add(key);
    const absolute = path.resolve(sourceDirectory, ...file.split('/'));
    const relative = path.relative(sourceDirectory, absolute);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw archiveError('release input escapes root');
    const { bytes } = readStableFile(absolute, file);
    if (bytes.length > limits.maxFileBytes) throw archiveError(`${file}: per-file byte bound exceeded`);
    aggregateBytes += bytes.length;
    if (aggregateBytes > limits.maxAggregateBytes) throw archiveError('expanded byte bound exceeded');
    entries.push({ body: bytes, mode: 0o644, name: file, size: bytes.length });
  }
  const compressed = canonicalGzip(canonicalTar(entries));
  if (compressed.length > limits.maxCompressedBytes) throw archiveError('compressed byte bound exceeded');
  fs.writeFileSync(outputPath, compressed, { flag: 'wx', mode: 0o600 });
  return { aggregateBytes, files: unique.length, sha256: sha256(compressed) };
}

async function runCli() {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'protocol' && args.length === 0) {
    console.log(STAGING_ARCHIVE_PROTOCOL);
    return;
  }
  if (command === 'create-git' && args.length === 2) {
    const sourceDirectory = path.resolve(args[0]);
    const files = execFileSync('git', ['ls-files', '-z'], {
      cwd: sourceDirectory, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    }).split('\0').filter(Boolean);
    const result = await createReleaseArchive({ sourceDirectory, files, outputPath: path.resolve(args[1]) });
    console.log(`staging_release_sha256=${result.sha256}`);
    return;
  }
  if (command === 'inspect' && args.length === 1) {
    const result = await validateReleaseArchive({ archivePath: path.resolve(args[0]) });
    console.log(JSON.stringify(result));
    return;
  }
  if (command === 'emit-compose' && args.length === 1) {
    await emitReleaseCompose({ archivePath: path.resolve(args[0]) });
    return;
  }
  if (command === 'complete-compose' && args.length === 2) {
    await completeReleaseCompose({
      archivePath: path.resolve(args[0]),
      outputPath: args[1],
    });
    return;
  }
  if (command === 'extract' && args.length === 2) {
    await extractReleaseArchive({ archivePath: path.resolve(args[0]), destination: path.resolve(args[1]) });
    return;
  }
  if (command === 'verify-tree' && args.length === 2) {
    await verifyReleaseTree({ archivePath: path.resolve(args[0]), directory: path.resolve(args[1]) });
    return;
  }
  if (command === 'verify-tree-transition' && args.length === 3) {
    const result = await verifyReleaseTreeTransition({
      archivePath: path.resolve(args[0]),
      directory: path.resolve(args[1]),
      transitionFile: args[2],
    });
    console.log(JSON.stringify(result));
    return;
  }
  if (command === 'prepare-copy' && args.length === 1) {
    await prepareReleaseTreeForCopy({ directory: path.resolve(args[0]) });
    return;
  }
  throw new Error('Usage: staging-release-archive.js protocol | create-git ROOT OUTPUT | inspect ARCHIVE | emit-compose ARCHIVE | complete-compose ARCHIVE OUTPUT | extract ARCHIVE DEST | verify-tree ARCHIVE DIRECTORY | verify-tree-transition ARCHIVE DIRECTORY FILE | prepare-copy DIRECTORY');
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  runCli().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
