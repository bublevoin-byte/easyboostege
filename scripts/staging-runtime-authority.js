import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ENVIRONMENT_MAX_BYTES = 4 * 1024 * 1024;
const SHA_BYTES = 65;

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
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

function assertOwnerMode(stat, expectedMode, role, { singleLink = false } = {}) {
  if (process.platform !== 'win32') {
    if (Number(stat.uid) !== process.getuid() || Number(stat.mode & 0o777n) !== expectedMode) {
      throw new Error(`${role} must have the exact private owner and mode`);
    }
  }
  if (singleLink && stat.nlink !== 1n) throw new Error(`${role} must be a single-link file`);
}

function readStablePrivateFile(file, {
  role, expectedMode = 0o600, maximumBytes, exactBytes,
}) {
  const absolute = path.resolve(file);
  let before;
  try {
    before = fs.lstatSync(absolute, { bigint: true });
  } catch {
    throw new Error(`${role} is missing or unreadable`);
  }
  if (!before.isFile() || before.isSymbolicLink()) throw new Error(`${role} must be a regular no-follow file`);
  assertOwnerMode(before, expectedMode, role, { singleLink: true });
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

export function capturePrivateFile({
  file, role, expectedMode = 0o600, maximumBytes = ENVIRONMENT_MAX_BYTES,
}) {
  return readStablePrivateFile(file, {
    role, expectedMode, maximumBytes,
  }).record;
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

async function runCli() {
  const [command, ...args] = process.argv.slice(2);
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
  throw new Error('Usage: staging-runtime-authority.js capture-runtime APP | verify-runtime APP JSON | read-sha FILE ROLE | read-env-port FILE | capture-file FILE ROLE MODE MAX | verify-file FILE ROLE MODE MAX JSON | capture-optional-file FILE ROLE MODE MAX | verify-optional-file FILE ROLE MODE MAX JSON | capture-store DIR [RESERVATION] | verify-store DIR [RESERVATION] JSON | capture-reservation FILE MIN | verify-reservation FILE MIN JSON | record-field JSON FIELD');
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  runCli().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
