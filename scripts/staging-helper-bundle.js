import crypto from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  STAGING_QUIESCENT_MAINTENANCE_DESCRIPTOR,
  STAGING_QUIESCENT_MAINTENANCE_ENVIRONMENT,
  STAGING_QUIESCENT_MAINTENANCE_LOCK_NAME,
  stagingQuiescentMaintenanceEnvironmentValue,
  stagingQuiescentMaintenanceLockBytes,
} from './staging-quiescent-maintenance.js';

export {
  STAGING_QUIESCENT_MAINTENANCE_DESCRIPTOR,
  STAGING_QUIESCENT_MAINTENANCE_ENVIRONMENT,
  STAGING_QUIESCENT_MAINTENANCE_LOCK_NAME,
  STAGING_QUIESCENT_MAINTENANCE_LOCK_PROTOCOL,
  STAGING_QUIESCENT_MAINTENANCE_PROTOCOL,
  stagingQuiescentMaintenanceEnvironmentValue,
  stagingQuiescentMaintenanceLockBytes,
} from './staging-quiescent-maintenance.js';

export const STAGING_HELPER_PROTOCOL = 'immutable-archive-v4';
export const STAGING_NODE_AUTHORITY_ENVIRONMENT = 'EASYBOOST_STAGING_NODE_AUTHORITY';
export const STAGING_NODE_AUTHORITY_PROTOCOL = 'easyboost-staging-node-authority-v1';
export const PRE_CUTOVER_V4_HELPER_BUNDLE_FILES = Object.freeze([
  'posix-session-supervisor.js',
  'staging-bounded-stream.js',
  'staging-command-supervisor.js',
  'staging-deadline-control.js',
  'staging-deploy.sh',
  'staging-helper-bundle.js',
  'staging-quiescent-maintenance.js',
  'staging-release-archive.js',
  'staging-release-common.sh',
  'staging-restart-app.sh',
  'staging-rollback.sh',
  'staging-runtime-authority.js',
  'staging-transaction-supervisor.js',
  'verify-staging-compose.js',
]);
export const HELPER_BUNDLE_FILES = Object.freeze([
  ...PRE_CUTOVER_V4_HELPER_BUNDLE_FILES,
  'staging-cutover-host-lock.js',
  'staging-cutover.sh',
].sort());

const MANIFEST_NAME = 'staging-release-bundle.json';
const GENERATION_ESM_BOUNDARY_NAME = 'package.json';
const GENERATION_ESM_BOUNDARY_BYTES = Buffer.from('{"type":"module"}\n');
export const HELPER_GENERATION_FILES = Object.freeze([
  GENERATION_ESM_BOUNDARY_NAME,
  ...HELPER_BUNDLE_FILES,
].sort());
const HELPER_GENERATION_FILE_SPECS = Object.freeze(HELPER_GENERATION_FILES.map((name) => Object.freeze({
  mode: name === GENERATION_ESM_BOUNDARY_NAME ? '0444' : '0555',
  name,
})));
const PRE_CUTOVER_V4_GENERATION_FILE_SPECS = Object.freeze([
  GENERATION_ESM_BOUNDARY_NAME,
  ...PRE_CUTOVER_V4_HELPER_BUNDLE_FILES,
].sort().map((name) => Object.freeze({
  mode: name === GENERATION_ESM_BOUNDARY_NAME ? '0444' : '0555',
  name,
})));
const LEGACY_HELPER_GENERATION_FILE_SPECS = Object.freeze(PRE_CUTOVER_V4_HELPER_BUNDLE_FILES.map((name) => Object.freeze({
  mode: '0555',
  name,
})));
const CURRENT_GENERATION_SCHEMA = 'v4-esm-boundary-cutover';
const PRE_CUTOVER_V4_GENERATION_SCHEMA = 'v4-esm-boundary';
const LEGACY_GENERATION_SCHEMA = 'v4-pre-esm-boundary';
const LEGACY_GENERATION_LOADER_SOURCE = `import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootValue = process.env.EASYBOOST_LEGACY_GENERATION_ROOT;
if (!rootValue || !path.isAbsolute(rootValue)) {
  throw new Error('legacy helper generation root is invalid');
}
const root = path.resolve(rootValue);

export async function load(url, context, nextLoad) {
  if (url.startsWith('file:')) {
    const candidate = path.resolve(fileURLToPath(url));
    const relative = path.relative(root, candidate);
    const inside = relative === '' || (relative !== '..'
      && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
    if (inside && path.extname(candidate) === '.js') {
      return { format: 'module', source: await fs.readFile(candidate), shortCircuit: true };
    }
  }
  return nextLoad(url, context);
}
`;
const LEGACY_GENERATION_LOADER_URL = `data:text/javascript;base64,${Buffer.from(
  LEGACY_GENERATION_LOADER_SOURCE,
).toString('base64')}`;
const MAX_HELPER_BYTES = 4 * 1024 * 1024;
const MAX_NODE_EXECUTABLE_BYTES = 512 * 1024 * 1024;
const NODE_AUTHORITIES_DIRECTORY = 'node-authorities';
const NODE_AUTHORITY_MANIFEST_NAME = 'node-authority.json';
const MAX_NODE_AUTHORITY_QUARANTINES = 1024;
const MAX_NODE_AUTHORITY_QUARANTINE_BYTES = 64n * 1024n * 1024n * 1024n;
const MAX_NODE_AUTHORITY_QUARANTINE_SCAN_ENTRIES = 8192;
const NODE_AUTHORITY_QUARANTINE_RESERVE_BYTES = BigInt(
  MAX_NODE_EXECUTABLE_BYTES + MAX_HELPER_BYTES,
);
const SHA_PATTERN = /^[a-f0-9]{64}$/u;
const NODE_AUTHORITY_QUARANTINE_PATTERN = /^\.[a-f0-9]{64}\.quarantine\.[a-f0-9]{64}$/u;
const TRUSTED_SHELL_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
const DEFAULT_STAGING_ROOTS = Object.freeze({
  appRoot: path.resolve('/opt/easyboost-staging'),
  installRoot: path.resolve('/usr/local/lib/easyboost-staging-release'),
  linkRoot: path.resolve('/usr/local/sbin'),
});
const RESERVED_POSIX_ROOTS = new Set([
  '/bin', '/boot', '/dev', '/etc', '/home', '/lib', '/lib64', '/media', '/mnt', '/opt',
  '/proc', '/root', '/run', '/sbin', '/srv', '/sys', '/tmp', '/usr', '/usr/local',
  '/usr/local/bin', '/usr/local/lib', '/var', '/var/lib', '/var/log',
]);
const localInstallerTails = new Map();

async function withLocalInstallerLock(key, action) {
  const predecessor = localInstallerTails.get(key) ?? Promise.resolve();
  let release;
  const tail = new Promise((resolve) => { release = resolve; });
  localInstallerTails.set(key, tail);
  await predecessor;
  try {
    return await action();
  } finally {
    release();
    if (localInstallerTails.get(key) === tail) localInstallerTails.delete(key);
  }
}

function canonicalAbsoluteRoot(value, label) {
  if (typeof value !== 'string' || value.length === 0 || !path.isAbsolute(value)
      || /[\r\n\0]/u.test(value)) {
    throw new Error(`${label} must be an absolute path`);
  }
  const canonical = path.resolve(value);
  if (canonical === path.parse(canonical).root) {
    throw new Error(`${label} must not resolve to a filesystem root`);
  }
  return canonical;
}

function strictDescendant(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

function rootsOverlap(first, second) {
  return first === second || strictDescendant(first, second) || strictDescendant(second, first);
}

function isReservedBroadRoot(candidate) {
  return process.platform !== 'win32' && RESERVED_POSIX_ROOTS.has(candidate);
}

export function validateStagingRootLayout({ appRoot, installRoot, linkRoot, allowedPrefix } = {}) {
  const canonical = {
    appRoot: canonicalAbsoluteRoot(appRoot, 'staging application root'),
    installRoot: canonicalAbsoluteRoot(installRoot, 'staging helper installation root'),
    linkRoot: canonicalAbsoluteRoot(linkRoot, 'staging helper link root'),
  };
  const approvedPrefix = allowedPrefix === undefined || allowedPrefix === null || allowedPrefix === ''
    ? null
    : canonicalAbsoluteRoot(allowedPrefix, 'staging approved prefix');
  if (approvedPrefix && isReservedBroadRoot(approvedPrefix)) {
    throw new Error('staging approved prefix must not be a broad or reserved system directory');
  }
  for (const [role, candidate] of Object.entries(canonical)) {
    if (candidate !== DEFAULT_STAGING_ROOTS[role]
        && (!approvedPrefix || !strictDescendant(candidate, approvedPrefix))) {
      throw new Error(`${role} must stay inside its explicit approved prefix`);
    }
    if (candidate !== DEFAULT_STAGING_ROOTS[role] && isReservedBroadRoot(candidate)) {
      throw new Error(`${role} must not be a broad or reserved system directory`);
    }
  }
  for (const [firstRole, secondRole] of [
    ['appRoot', 'installRoot'], ['appRoot', 'linkRoot'], ['installRoot', 'linkRoot'],
  ]) {
    if (rootsOverlap(canonical[firstRole], canonical[secondRole])) {
      throw new Error(`${firstRole} and ${secondRole} must not overlap`);
    }
  }
  return { allowedPrefix: approvedPrefix, ...canonical };
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function identity(stat) {
  return ['dev', 'ino', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs']
    .map((key) => String(stat[key])).join(':');
}

function directoryObjectIdentity(stat) {
  return ['dev', 'ino', 'mode', 'uid', 'gid'].map((key) => String(stat[key])).join(':');
}

function directoryAllocationIdentity(stat) {
  return ['dev', 'ino', 'uid', 'gid'].map((key) => String(stat[key])).join(':');
}

function safeBundleName(name) {
  if (!/^[a-z0-9][a-z0-9.-]*$/u.test(name) || name.includes('..')) {
    throw new Error(`invalid staging helper bundle path: ${name}`);
  }
  return name;
}

function readStableFile(file, label) {
  let before;
  try {
    before = fsSync.lstatSync(file, { bigint: true });
  } catch {
    throw new Error(`${label} is missing or unreadable`);
  }
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) {
    throw new Error(`${label} must be a single-link regular file`);
  }
  if (before.size > BigInt(MAX_HELPER_BYTES)) throw new Error(`${label} exceeds the helper byte bound`);
  let descriptor;
  try {
    descriptor = fsSync.openSync(file, fsSync.constants.O_RDONLY | (fsSync.constants.O_NOFOLLOW ?? 0));
    const opened = fsSync.fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || identity(opened) !== identity(before)) {
      throw new Error(`${label} changed while opening`);
    }
    const bytes = fsSync.readFileSync(descriptor);
    const after = fsSync.fstatSync(descriptor, { bigint: true });
    const finalPath = fsSync.lstatSync(file, { bigint: true });
    if (identity(after) !== identity(opened) || identity(finalPath) !== identity(opened)
        || BigInt(bytes.length) !== opened.size) {
      throw new Error(`${label} changed during descriptor capture`);
    }
    return bytes;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(label)) throw error;
    throw new Error(`${label} could not be descriptor-captured safely`);
  } finally {
    if (descriptor !== undefined) fsSync.closeSync(descriptor);
  }
}

function buildBundle(records) {
  const aggregate = crypto.createHash('sha256');
  aggregate.update(`easyboost-staging-helper-bundle-v4\0${STAGING_HELPER_PROTOCOL}\0`);
  for (const record of records) {
    aggregate.update(`F\0${record.name}\0${record.bytes.length}\0${record.sha256}\0${record.mode}\0`);
  }
  const bundleDigest = aggregate.digest('hex');
  const manifest = {
    protocol: STAGING_HELPER_PROTOCOL,
    bundleDigest,
    files: records.map((record) => ({
      name: record.name,
      bytes: record.bytes.length,
      sha256: record.sha256,
      mode: record.mode,
    })),
  };
  return { bundleDigest, manifest, manifestBytes: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`), records };
}

export function captureHelperBundle({ sourceDirectory }) {
  const source = path.resolve(sourceDirectory);
  let current = source;
  while (true) {
    const stat = fsSync.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error('staging helper source directory chain must be real and no-follow');
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const records = HELPER_GENERATION_FILE_SPECS.map((spec) => {
    const name = safeBundleName(spec.name);
    const bytes = name === GENERATION_ESM_BOUNDARY_NAME
      ? GENERATION_ESM_BOUNDARY_BYTES
      : readStableFile(path.join(source, name), `staging helper source ${name}`);
    return { bytes, mode: spec.mode, name, sha256: sha256(bytes) };
  });
  return buildBundle(records);
}

function assertExactKeys(value, names, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...names].sort())) {
    throw new Error(`${label} has an invalid contract`);
  }
}

function parseManifest(bytes) {
  let manifest;
  try {
    manifest = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error('staging helper generation manifest is invalid JSON');
  }
  assertExactKeys(manifest, ['bundleDigest', 'files', 'protocol'], 'staging helper generation manifest');
  if (manifest.protocol !== STAGING_HELPER_PROTOCOL || !SHA_PATTERN.test(manifest.bundleDigest)
      || !Array.isArray(manifest.files)) {
    throw new Error('staging helper generation manifest is invalid');
  }
  return manifest;
}

function generationSchemaForManifest(manifest) {
  const matches = (specs) => manifest.files.length === specs.length
    && manifest.files.every((record, index) => record && typeof record === 'object'
      && !Array.isArray(record) && record.name === specs[index].name
      && record.mode === specs[index].mode);
  if (matches(HELPER_GENERATION_FILE_SPECS)) {
    return { name: CURRENT_GENERATION_SCHEMA, specs: HELPER_GENERATION_FILE_SPECS };
  }
  if (matches(PRE_CUTOVER_V4_GENERATION_FILE_SPECS)) {
    return { name: PRE_CUTOVER_V4_GENERATION_SCHEMA, specs: PRE_CUTOVER_V4_GENERATION_FILE_SPECS };
  }
  if (matches(LEGACY_HELPER_GENERATION_FILE_SPECS)) {
    return { name: LEGACY_GENERATION_SCHEMA, specs: LEGACY_HELPER_GENERATION_FILE_SPECS };
  }
  throw new Error('staging helper generation manifest has an unsupported schema');
}

function assertPortableMode(stat, expected, label) {
  if (process.platform === 'win32') return;
  if ((stat.mode & 0o777) !== expected || stat.nlink !== 1 || stat.uid !== process.getuid()) {
    throw new Error(`${label} has an unsafe owner, mode or link count`);
  }
}

export async function verifyInstalledHelperGeneration({ generationDirectory, expectedDigest }) {
  const generation = path.resolve(generationDirectory);
  if (!SHA_PATTERN.test(expectedDigest) || path.basename(generation) !== expectedDigest) {
    throw new Error('staging helper generation identity is invalid');
  }
  const directoryStat = await fs.lstat(generation);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new Error('staging helper generation must be a real directory');
  }
  if (process.platform !== 'win32'
      && ((directoryStat.mode & 0o777) !== 0o555 || directoryStat.uid !== process.getuid())) {
    throw new Error('staging helper generation directory has an unsafe owner or mode');
  }
  const manifestBytes = readStableFile(path.join(generation, MANIFEST_NAME),
    'staging helper generation manifest');
  const manifest = parseManifest(manifestBytes);
  const schema = generationSchemaForManifest(manifest);
  const expectedNames = [...schema.specs.map((record) => record.name), MANIFEST_NAME].sort();
  const actualNames = (await fs.readdir(generation)).sort();
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
    throw new Error('staging helper generation has missing or unapproved files');
  }
  const records = [];
  for (const [index, spec] of schema.specs.entries()) {
    const { mode, name } = spec;
    const record = manifest.files[index];
    assertExactKeys(record, ['bytes', 'mode', 'name', 'sha256'], `staging helper manifest record ${name}`);
    if (record.name !== name || record.mode !== mode || !SHA_PATTERN.test(record.sha256)
        || !Number.isSafeInteger(record.bytes) || record.bytes < 0) {
      throw new Error(`staging helper generation manifest record ${name} is invalid`);
    }
    const file = path.join(generation, name);
    const bytes = readStableFile(file, `staging helper generation ${name}`);
    assertPortableMode(await fs.lstat(file), Number.parseInt(mode, 8),
      `staging helper generation ${name}`);
    if (bytes.length !== record.bytes || sha256(bytes) !== record.sha256) {
      throw new Error(`staging helper generation ${name} changed or has a digest mismatch`);
    }
    if (name === GENERATION_ESM_BOUNDARY_NAME && !bytes.equals(GENERATION_ESM_BOUNDARY_BYTES)) {
      throw new Error('staging helper generation ESM boundary is not canonical');
    }
    records.push({ bytes, mode, name, sha256: record.sha256 });
  }
  assertPortableMode(await fs.lstat(path.join(generation, MANIFEST_NAME)), 0o444,
    'staging helper generation manifest');
  const rebuilt = buildBundle(records);
  if (rebuilt.bundleDigest !== expectedDigest || manifest.bundleDigest !== expectedDigest
      || !rebuilt.manifestBytes.equals(manifestBytes)) {
    throw new Error('staging helper generation manifest or bundle digest mismatch');
  }
  return rebuilt;
}

async function assertSafeAncestorChain(directory) {
  let current = path.resolve(directory);
  const visited = [];
  while (true) {
    visited.push(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  for (const candidate of visited.reverse()) {
    let stat;
    try { stat = await fs.lstat(candidate); } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`${candidate}: unsafe helper ancestor`);
    }
    if (process.platform !== 'win32') {
      const mode = stat.mode & 0o7777;
      if (![0, process.getuid()].includes(stat.uid)
          || ((mode & 0o022) !== 0 && (mode & 0o1000) === 0)) {
        throw new Error(`${candidate}: unsafe helper ancestor owner or mode`);
      }
    }
  }
}

async function captureSafeDirectoryChain(directory) {
  let current = path.resolve(directory);
  const paths = [];
  while (true) {
    paths.push(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const captured = [];
  for (const candidate of paths.reverse()) {
    const stat = await fs.lstat(candidate, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`${candidate}: unsafe helper ancestor`);
    }
    if (process.platform !== 'win32') {
      const mode = stat.mode & 0o7777n;
      if (![0n, BigInt(process.getuid())].includes(stat.uid)
          || ((mode & 0o022n) !== 0n && (mode & 0o1000n) === 0n)) {
        throw new Error(`${candidate}: unsafe helper ancestor owner or mode`);
      }
    }
    captured.push({ path: candidate, stat });
  }
  return captured;
}

function assertSameDirectoryChain(before, after) {
  if (before.length !== after.length) throw new Error('helper ancestor chain changed during durable publication');
  for (const [index, prior] of before.entries()) {
    const current = after[index];
    if (prior.path !== current.path) throw new Error('helper ancestor path changed during durable publication');
    if (directoryObjectIdentity(prior.stat) !== directoryObjectIdentity(current.stat)) {
      throw new Error(`${prior.path}: helper directory identity changed during durable publication`);
    }
  }
}

function installerOperations(operations) {
  return {
    chmod: operations.chmod ?? fs.chmod,
    directorySyncSupported: operations.directorySyncSupported ?? process.platform !== 'win32',
    mkdir: operations.mkdir ?? fs.mkdir,
    mkdtemp: operations.mkdtemp ?? fs.mkdtemp,
    open: operations.open ?? fs.open,
    rename: operations.rename ?? fs.rename,
    rmdir: operations.rmdir ?? fs.rmdir,
    rm: operations.rm ?? fs.rm,
    syncDirectory: operations.syncDirectory,
    syncFile: operations.syncFile,
    writeFile: operations.writeFile ?? fs.writeFile,
    withInstallerLock: operations.withInstallerLock ?? withLocalInstallerLock,
  };
}

async function syncDirectory(directory, operations) {
  if (operations.syncDirectory) {
    await operations.syncDirectory(directory);
    return;
  }
  if (!operations.directorySyncSupported) return;
  const before = await fs.lstat(directory, { bigint: true });
  if (!before.isDirectory() || before.isSymbolicLink()) {
    throw new Error(`${directory}: unsafe helper directory sync target`);
  }
  const descriptor = await operations.open(directory,
    fsSync.constants.O_RDONLY | (fsSync.constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await descriptor.stat({ bigint: true });
    if (!opened.isDirectory() || directoryObjectIdentity(opened) !== directoryObjectIdentity(before)) {
      throw new Error(`${directory}: helper directory changed while opening for sync`);
    }
    await descriptor.sync();
    const after = await descriptor.stat({ bigint: true });
    const finalPath = await fs.lstat(directory, { bigint: true });
    if (!after.isDirectory() || !finalPath.isDirectory() || finalPath.isSymbolicLink()
        || directoryObjectIdentity(after) !== directoryObjectIdentity(opened)
        || directoryObjectIdentity(finalPath) !== directoryObjectIdentity(opened)) {
      throw new Error(`${directory}: helper directory changed during sync`);
    }
  } finally {
    await descriptor.close();
  }
}

async function writeDurableFile(destination, bytes, mode, operations) {
  const flags = fsSync.constants.O_CREAT | fsSync.constants.O_EXCL | fsSync.constants.O_RDWR
    | (fsSync.constants.O_NOFOLLOW ?? 0);
  const descriptor = await operations.open(destination, flags, mode | 0o200);
  try {
    const opened = await descriptor.stat({ bigint: true });
    const published = await fs.lstat(destination, { bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n || published.isSymbolicLink()
        || identity(published) !== identity(opened)) {
      throw new Error(`${destination}: durable helper file changed while opening no-follow`);
    }
    await descriptor.writeFile(bytes);
    await descriptor.chmod(mode);
    const prepared = await descriptor.stat({ bigint: true });
    if (!prepared.isFile() || prepared.nlink !== 1n || prepared.size !== BigInt(bytes.length)
        || (process.platform !== 'win32' && Number(prepared.mode & 0o777n) !== mode)) {
      throw new Error(`${destination}: durable helper file has an unsafe descriptor state`);
    }
    if (operations.syncFile) await operations.syncFile(destination, descriptor);
    else await descriptor.sync();
    const synced = await descriptor.stat({ bigint: true });
    const finalPath = await fs.lstat(destination, { bigint: true });
    if (identity(synced) !== identity(prepared) || finalPath.isSymbolicLink()
        || identity(finalPath) !== identity(prepared)) {
      throw new Error(`${destination}: durable helper file changed during descriptor sync`);
    }
  } finally {
    await descriptor.close();
  }
}

function verifyQuiescentMaintenanceLock(lockPath, expectedBytes) {
  const stat = fsSync.lstatSync(lockPath, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) {
    throw new Error('staging quiescent maintenance lock must be a single-link regular file');
  }
  if (process.platform !== 'win32'
      && (stat.uid !== BigInt(process.getuid()) || Number(stat.mode & 0o777n) !== 0o600)) {
    throw new Error('staging quiescent maintenance lock has an unsafe owner or mode');
  }
  const captured = readStableFile(lockPath, 'staging quiescent maintenance lock');
  if (!captured.equals(expectedBytes)) {
    throw new Error('staging quiescent maintenance lock bytes are not canonical');
  }
  return Object.freeze({
    bytes: captured,
    digest: sha256(captured),
    path: lockPath,
  });
}

async function ensureQuiescentMaintenanceLock(installRoot, operations) {
  const lockPath = path.join(installRoot, STAGING_QUIESCENT_MAINTENANCE_LOCK_NAME);
  const expectedBytes = stagingQuiescentMaintenanceLockBytes(installRoot);
  let created = false;
  try {
    await writeDurableFile(lockPath, expectedBytes, 0o600, operations);
    created = true;
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
  const lock = verifyQuiescentMaintenanceLock(lockPath, expectedBytes);
  if (created) await syncDirectory(installRoot, operations);
  return Object.freeze({
    ...lock,
    environment: stagingQuiescentMaintenanceEnvironmentValue(lock.bytes),
  });
}

async function assertOwnedHelperDirectory(directory, mode) {
  const stat = await fs.lstat(directory, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${directory}: unsafe helper directory`);
  if (process.platform !== 'win32') {
    const permissions = Number(stat.mode & 0o777n);
    if (stat.uid !== BigInt(process.getuid()) || permissions !== mode) {
      throw new Error(`${directory}: unsafe helper directory owner or mode`);
    }
  }
  return stat;
}

async function assertOwnedHelperDirectoryAllocation(directory) {
  const stat = await fs.lstat(directory, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${directory}: unsafe helper directory`);
  if (process.platform !== 'win32' && stat.uid !== BigInt(process.getuid())) {
    throw new Error(`${directory}: unsafe helper directory owner`);
  }
  return stat;
}

function descendantDirectoryChain(boundary, target) {
  const directories = [];
  let current = target;
  while (current !== boundary) {
    directories.unshift(current);
    const parent = path.dirname(current);
    if (parent === current) throw new Error(`${target}: helper directory escaped its durable boundary`);
    current = parent;
  }
  return directories;
}

async function ensureSafeDirectory(directory, mode, operations, durabilityBoundary = null) {
  const target = path.resolve(directory);
  let candidates;
  if (durabilityBoundary) {
    const boundary = path.resolve(durabilityBoundary);
    if (!strictDescendant(target, boundary)) {
      throw new Error(`${target}: helper directory must be inside its durable boundary`);
    }
    await captureSafeDirectoryChain(boundary);
    candidates = descendantDirectoryChain(boundary, target);
  } else {
    const missing = [];
    let current = target;
    while (true) {
      const exists = await fs.lstat(current).then(() => true, (error) => {
        if (error?.code === 'ENOENT') return false;
        throw error;
      });
      if (exists) break;
      missing.unshift(current);
      const parent = path.dirname(current);
      if (parent === current) throw new Error(`${target}: no existing safe helper ancestor`);
      current = parent;
    }
    await assertSafeAncestorChain(current);
    candidates = missing;
  }
  for (const candidate of candidates) {
    const parent = path.dirname(candidate);
    const parentBefore = await captureSafeDirectoryChain(parent);
    const existed = await fs.lstat(candidate).then(() => true, (error) => {
      if (error?.code === 'ENOENT') return false;
      throw error;
    });
    let created;
    if (!existed) {
      await operations.mkdir(candidate, { mode });
      const allocated = await assertOwnedHelperDirectoryAllocation(candidate);
      await operations.chmod(candidate, mode);
      const modeEstablished = await assertOwnedHelperDirectory(candidate, mode);
      if (directoryAllocationIdentity(allocated) !== directoryAllocationIdentity(modeEstablished)) {
        throw new Error(`${candidate}: helper directory identity changed while establishing mode`);
      }
      await syncDirectory(candidate, operations);
      created = await assertOwnedHelperDirectory(candidate, mode);
      if (identity(modeEstablished) !== identity(created)) {
        throw new Error(`${candidate}: helper directory changed while making its mode durable`);
      }
    } else {
      created = candidate === target
        ? await assertOwnedHelperDirectory(candidate, mode)
        : (await captureSafeDirectoryChain(candidate)).at(-1).stat;
    }
    const parentAfterCreate = await captureSafeDirectoryChain(parent);
    assertSameDirectoryChain(parentBefore, parentAfterCreate);
    await syncDirectory(parent, operations);
    const parentAfterSync = await captureSafeDirectoryChain(parent);
    assertSameDirectoryChain(parentAfterCreate, parentAfterSync);
    const published = !existed || candidate === target
      ? await assertOwnedHelperDirectory(candidate, mode)
      : (await captureSafeDirectoryChain(candidate)).at(-1).stat;
    if (identity(created) !== identity(published)) {
      throw new Error(`${candidate}: helper directory identity changed during durable publication`);
    }
  }
  await assertSafeAncestorChain(target);
  await assertOwnedHelperDirectory(target, mode);
}

function shellLiteral(value) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function bashPath(value) {
  if (process.platform !== 'win32') return value;
  const match = /^([A-Za-z]):[\\/](.*)$/u.exec(value);
  if (!match) throw new Error('installer Node authority path is not addressable by Git Bash');
  return `/${match[1].toLowerCase()}/${match[2].replaceAll('\\', '/')}`;
}

function executableIdentity(stat) {
  if (process.platform === 'win32') {
    return ['dev', 'ino', 'nlink', 'size'].map((key) => String(stat[key])).join(':');
  }
  return [stat.dev, stat.ino, stat.mode.toString(16), stat.uid, stat.gid, stat.nlink, stat.size]
    .map(String).join(':');
}

function executableAncestorIdentity(stat) {
  if (process.platform === 'win32') {
    return [stat.dev, stat.ino].map(String).join(':');
  }
  return [stat.dev, stat.ino, stat.mode.toString(16), stat.uid, stat.gid].map(String).join(':');
}

function assertSafeNodeExecutableAncestor(candidate, stat) {
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`installer Node executable ancestor ${candidate} must be a real directory`);
  }
  if (process.platform === 'win32') return;
  const owner = Number(stat.uid);
  const mode = stat.mode & 0o7777n;
  if (![0, process.getuid()].includes(owner)
      || ((mode & 0o022n) !== 0n && (mode & 0o1000n) === 0n)) {
    throw new Error(`installer Node executable ancestor ${candidate} has an unsafe owner or mode`);
  }
}

function captureNodeExecutableContent(executable, expectedStat, captureBytes) {
  let descriptor;
  try {
    descriptor = fsSync.openSync(executable,
      fsSync.constants.O_RDONLY | (fsSync.constants.O_NOFOLLOW ?? 0));
    const opened = fsSync.fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || identity(opened) !== identity(expectedStat)) {
      throw new Error('installer Node executable changed while opening');
    }
    if (opened.size > BigInt(MAX_NODE_EXECUTABLE_BYTES)) {
      throw new Error('installer Node executable exceeds the authority byte bound');
    }
    const aggregate = crypto.createHash('sha256');
    const chunk = Buffer.allocUnsafe(64 * 1024);
    const chunks = captureBytes ? [] : null;
    let capturedBytes = 0n;
    while (true) {
      const bytesRead = fsSync.readSync(descriptor, chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      capturedBytes += BigInt(bytesRead);
      aggregate.update(chunk.subarray(0, bytesRead));
      if (chunks) chunks.push(Buffer.from(chunk.subarray(0, bytesRead)));
    }
    const after = fsSync.fstatSync(descriptor, { bigint: true });
    const finalPath = fsSync.lstatSync(executable, { bigint: true });
    if (identity(after) !== identity(opened) || identity(finalPath) !== identity(opened)
        || capturedBytes !== opened.size) {
      throw new Error('installer Node executable changed during digest capture');
    }
    return {
      bytes: chunks ? Buffer.concat(chunks, Number(capturedBytes)) : undefined,
      digest: aggregate.digest('hex'),
    };
  } finally {
    if (descriptor !== undefined) fsSync.closeSync(descriptor);
  }
}

function captureNodeExecutionAuthority({ captureBytes = false, executablePath = process.execPath } = {}) {
  const executable = fsSync.realpathSync.native(executablePath);
  if (!path.isAbsolute(executable) || /[\r\n\0]/u.test(executable)) {
    throw new Error('installer Node executable must resolve to an absolute safe path');
  }
  const stat = fsSync.lstatSync(executable, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) {
    throw new Error('installer Node executable must resolve to a real regular file');
  }
  if (process.platform !== 'win32') {
    const owner = Number(stat.uid);
    if (![0, process.getuid()].includes(owner) || (stat.mode & 0o111n) === 0n
        || (stat.mode & 0o022n) !== 0n) {
      throw new Error('installer Node executable has an unsafe owner or mode');
    }
  }
  const ancestorPaths = [];
  let current = path.dirname(executable);
  while (true) {
    ancestorPaths.unshift(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const captureAncestors = () => ancestorPaths.map((candidate) => {
    const ancestorStat = fsSync.lstatSync(candidate, { bigint: true });
    assertSafeNodeExecutableAncestor(candidate, ancestorStat);
    return {
      identity: executableAncestorIdentity(ancestorStat),
      path: bashPath(candidate),
    };
  });
  const ancestors = captureAncestors();
  const content = captureNodeExecutableContent(executable, stat, captureBytes);
  const afterAncestors = captureAncestors();
  if (JSON.stringify(afterAncestors) !== JSON.stringify(ancestors)
      || fsSync.realpathSync.native(executablePath) !== executable) {
    throw new Error('installer Node executable ancestor chain changed during authority capture');
  }
  return Object.freeze({
    ancestors: Object.freeze(ancestors.map(Object.freeze)),
    bytes: content.bytes,
    digest: content.digest,
    directory: bashPath(path.dirname(executable)),
    executable: bashPath(executable),
    identity: executableIdentity(stat),
    statFormat: process.platform === 'win32' ? '%d:%i:%h:%s' : '%d:%i:%f:%u:%g:%h:%s',
    ancestorStatFormat: process.platform === 'win32' ? '%d:%i' : '%d:%i:%f:%u:%g',
  });
}

function privateNodeExecutableName() {
  return process.platform === 'win32' ? 'node.exe' : 'node';
}

function privateNodeAuthorityManifestBytes({ bytes, digest }) {
  return Buffer.from(`${JSON.stringify({
    bytes,
    digest,
    executable: privateNodeExecutableName(),
    protocol: STAGING_NODE_AUTHORITY_PROTOCOL,
  })}\n`);
}

function readPrivateNodeAuthorityManifest(runtimeDirectory, expectedDigest) {
  const manifestPath = path.join(runtimeDirectory, NODE_AUTHORITY_MANIFEST_NAME);
  assertPortableMode(fsSync.lstatSync(manifestPath), 0o444,
    'private Node authority manifest');
  let manifest;
  try {
    manifest = JSON.parse(readStableFile(manifestPath,
      'private Node authority manifest').toString('utf8'));
  } catch (cause) {
    throw new Error('private Node authority manifest is invalid', { cause });
  }
  const keys = manifest && typeof manifest === 'object' && !Array.isArray(manifest)
    ? Object.keys(manifest).sort() : [];
  if (JSON.stringify(keys) !== JSON.stringify(['bytes', 'digest', 'executable', 'protocol'])
      || manifest.protocol !== STAGING_NODE_AUTHORITY_PROTOCOL
      || manifest.digest !== expectedDigest
      || manifest.executable !== privateNodeExecutableName()
      || !Number.isSafeInteger(manifest.bytes) || manifest.bytes <= 0
      || manifest.bytes > MAX_NODE_EXECUTABLE_BYTES) {
    throw new Error('private Node authority manifest contract is invalid');
  }
  return manifest;
}

function privateNodeRuntimeAllocation(stat, label) {
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} is not a real directory`);
  }
  if (process.platform !== 'win32' && stat.uid !== BigInt(process.getuid())) {
    throw new Error(`${label} has an unsafe owner`);
  }
  return stat;
}

async function verifyPrivateNodeExecutionAuthority({ authorityRoot, digest }) {
  if (!SHA_PATTERN.test(digest)) throw new Error('private Node authority digest is invalid');
  const runtimeDirectory = path.join(authorityRoot, digest);
  await assertOwnedHelperDirectory(authorityRoot, 0o755);
  await assertOwnedHelperDirectory(runtimeDirectory, 0o555);
  const executableName = privateNodeExecutableName();
  const actualNames = (await fs.readdir(runtimeDirectory)).sort();
  if (JSON.stringify(actualNames)
      !== JSON.stringify([NODE_AUTHORITY_MANIFEST_NAME, executableName].sort())) {
    throw new Error('private Node authority has missing or unapproved files');
  }
  const manifest = readPrivateNodeAuthorityManifest(runtimeDirectory, digest);
  const executable = path.join(runtimeDirectory, executableName);
  const executableStat = await fs.lstat(executable);
  assertPortableMode(executableStat, 0o555, 'private Node authority executable');
  if (executableStat.size !== manifest.bytes) {
    throw new Error('private Node authority executable has a byte-count mismatch');
  }
  const authority = captureNodeExecutionAuthority({ executablePath: executable });
  if (authority.digest !== digest) {
    throw new Error('private Node authority executable has a digest mismatch');
  }
  return authority;
}

async function measurePrivateNodeQuarantineEntry(candidate, state) {
  state.entries += 1;
  if (state.entries > MAX_NODE_AUTHORITY_QUARANTINE_SCAN_ENTRIES) {
    throw new Error('private Node quarantine scan entry quota is exceeded');
  }
  const before = await fs.lstat(candidate, { bigint: true });
  if (before.dev !== state.device || before.isSymbolicLink()
      || (!before.isDirectory() && !before.isFile())) {
    throw new Error('private Node quarantine contains an unsafe entry');
  }
  let bytes = before.size;
  if (before.isDirectory()) {
    const names = (await fs.readdir(candidate)).sort();
    for (const name of names) {
      if (name === '' || name === '.' || name === '..' || path.basename(name) !== name) {
        throw new Error('private Node quarantine contains an invalid name');
      }
      bytes += await measurePrivateNodeQuarantineEntry(path.join(candidate, name), state);
      if (bytes > MAX_NODE_AUTHORITY_QUARANTINE_BYTES) {
        throw new Error('private Node quarantine aggregate byte quota is exceeded');
      }
    }
  }
  const after = await fs.lstat(candidate, { bigint: true });
  if (identity(after) !== identity(before)) {
    throw new Error('private Node quarantine changed during bounded scan');
  }
  return bytes;
}

async function assertPrivateNodeQuarantineBudget(authorityRoot, {
  additionalBytes = 0n,
  additionalEntries = 0,
  additionalPath = null,
} = {}) {
  const rootBefore = await fs.lstat(authorityRoot, { bigint: true });
  if (!rootBefore.isDirectory() || rootBefore.isSymbolicLink()) {
    throw new Error('private Node authority root is unsafe during quarantine scan');
  }
  const names = (await fs.readdir(authorityRoot)).sort();
  const quarantines = [];
  for (const name of names) {
    if (SHA_PATTERN.test(name)) continue;
    if (!NODE_AUTHORITY_QUARANTINE_PATTERN.test(name)) {
      throw new Error('private Node authority root contains an unapproved entry');
    }
    quarantines.push(name);
  }
  if (quarantines.length + additionalEntries > MAX_NODE_AUTHORITY_QUARANTINES) {
    throw new Error('private Node quarantine count quota is exceeded');
  }
  const state = { device: rootBefore.dev, entries: 0 };
  let aggregate = additionalBytes;
  for (const name of quarantines) {
    aggregate += await measurePrivateNodeQuarantineEntry(path.join(authorityRoot, name), state);
    if (aggregate > MAX_NODE_AUTHORITY_QUARANTINE_BYTES) {
      throw new Error('private Node quarantine aggregate byte quota is exceeded');
    }
  }
  if (additionalPath !== null) {
    aggregate += await measurePrivateNodeQuarantineEntry(additionalPath, state);
  }
  if (aggregate > MAX_NODE_AUTHORITY_QUARANTINE_BYTES) {
    throw new Error('private Node quarantine aggregate byte quota is exceeded');
  }
  const rootAfter = await fs.lstat(authorityRoot, { bigint: true });
  if (identity(rootAfter) !== identity(rootBefore)) {
    throw new Error('private Node authority root changed during quarantine scan');
  }
  return Object.freeze({ bytes: aggregate, count: quarantines.length + additionalEntries });
}

async function quarantinePrivateNodeRuntime({
  authorityRoot, digest, operations, runtimeDirectory, expectedAllocation,
}) {
  await assertPrivateNodeQuarantineBudget(authorityRoot, {
    additionalEntries: 1,
    additionalPath: runtimeDirectory,
  });
  const quarantine = path.join(authorityRoot,
    `.${digest}.quarantine.${crypto.randomBytes(32).toString('hex')}`);
  await operations.rename(runtimeDirectory, quarantine);
  const moved = privateNodeRuntimeAllocation(
    await fs.lstat(quarantine, { bigint: true }),
    'private Node publication quarantine',
  );
  if (directoryAllocationIdentity(moved) !== directoryAllocationIdentity(expectedAllocation)) {
    const error = new Error(
      'private Node partial-publication successor was retained in quarantine',
    );
    error.recoveryAuthority = Object.freeze({
      digest,
      protocol: STAGING_NODE_AUTHORITY_PROTOCOL,
      quarantine,
    });
    throw error;
  }
  await syncDirectory(authorityRoot, operations);
  await assertPrivateNodeQuarantineBudget(authorityRoot);
  return quarantine;
}

function invalidPrivateNodePartialPublication(message, cause) {
  const error = new Error(message, cause === undefined ? undefined : { cause });
  error.code = 'EASYBOOST_INVALID_PRIVATE_NODE_PUBLICATION';
  return error;
}

async function finishPrivateNodeExecutionAuthority({
  authorityRoot, completeMarkerAtStart, operations, runtimeDirectory, sourceAuthority,
}) {
  const allowedNames = new Set([NODE_AUTHORITY_MANIFEST_NAME, privateNodeExecutableName()]);
  const actualNames = (await fs.readdir(runtimeDirectory)).sort();
  if (actualNames.some((name) => !allowedNames.has(name))) {
    throw invalidPrivateNodePartialPublication(
      'private Node partial publication has unapproved files',
    );
  }
  if (completeMarkerAtStart
      && JSON.stringify(actualNames)
        !== JSON.stringify([NODE_AUTHORITY_MANIFEST_NAME, privateNodeExecutableName()].sort())) {
    throw new Error('sealed private Node authority has missing or unapproved files');
  }
  const executable = path.join(runtimeDirectory, privateNodeExecutableName());
  if (actualNames.includes(privateNodeExecutableName())) {
    try {
      const stat = await fs.lstat(executable);
      assertPortableMode(stat, 0o555, 'private Node partial-publication executable');
      if (stat.size !== sourceAuthority.bytes.length
          || captureNodeExecutionAuthority({ executablePath: executable }).digest
            !== sourceAuthority.digest) {
        throw new Error('private Node partial-publication executable is incomplete');
      }
    } catch (cause) {
      throw invalidPrivateNodePartialPublication(
        'private Node partial-publication executable is incomplete', cause,
      );
    }
  } else {
    await writeDurableFile(executable, sourceAuthority.bytes, 0o555, operations);
  }
  const manifestPath = path.join(runtimeDirectory, NODE_AUTHORITY_MANIFEST_NAME);
  if (actualNames.includes(NODE_AUTHORITY_MANIFEST_NAME)) {
    let manifest;
    try {
      manifest = readPrivateNodeAuthorityManifest(runtimeDirectory, sourceAuthority.digest);
    } catch (cause) {
      throw invalidPrivateNodePartialPublication(
        'private Node partial publication manifest is invalid', cause,
      );
    }
    if (manifest.bytes !== sourceAuthority.bytes.length) {
      throw invalidPrivateNodePartialPublication(
        'private Node partial publication manifest has a byte-count mismatch',
      );
    }
  } else {
    await writeDurableFile(manifestPath, privateNodeAuthorityManifestBytes({
      bytes: sourceAuthority.bytes.length,
      digest: sourceAuthority.digest,
    }), 0o444, operations);
  }
  await operations.chmod(runtimeDirectory, 0o555);
  await syncDirectory(runtimeDirectory, operations);
  return verifyPrivateNodeExecutionAuthority({
    authorityRoot,
    digest: sourceAuthority.digest,
  });
}

async function publishPrivateNodeExecutionAuthority({ installRoot, operations, sourceAuthority }) {
  if (!sourceAuthority.bytes || sourceAuthority.digest !== sha256(sourceAuthority.bytes)) {
    throw new Error('captured installer Node authority bytes are invalid');
  }
  const authorityRoot = path.join(installRoot, NODE_AUTHORITIES_DIRECTORY);
  await ensureSafeDirectory(authorityRoot, 0o755, operations, installRoot);
  const runtimeDirectory = path.join(authorityRoot, sourceAuthority.digest);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let allocated;
    let completeMarkerAtStart = false;
    const runtimeExists = await fs.lstat(runtimeDirectory).then(() => true, (error) => {
      if (error?.code === 'ENOENT') return false;
      throw error;
    });
    if (!runtimeExists) {
      await assertPrivateNodeQuarantineBudget(authorityRoot, {
        additionalBytes: NODE_AUTHORITY_QUARANTINE_RESERVE_BYTES,
        additionalEntries: 1,
      });
    }
    try {
      await operations.mkdir(runtimeDirectory, { mode: 0o700 });
      allocated = await assertOwnedHelperDirectory(runtimeDirectory, 0o700);
      await syncDirectory(authorityRoot, operations);
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      try {
        const adopted = await verifyPrivateNodeExecutionAuthority({
          authorityRoot, digest: sourceAuthority.digest,
        });
        await syncDirectory(authorityRoot, operations);
        return adopted;
      } catch (verificationError) {
        allocated = privateNodeRuntimeAllocation(
          await fs.lstat(runtimeDirectory, { bigint: true }),
          'private Node partial publication',
        );
        try {
          readPrivateNodeAuthorityManifest(runtimeDirectory, sourceAuthority.digest);
          completeMarkerAtStart = true;
        } catch {
          completeMarkerAtStart = false;
        }
        if (process.platform !== 'win32' && Number(allocated.mode & 0o777n) !== 0o700) {
          throw verificationError;
        }
      }
    }
    try {
      const authority = await finishPrivateNodeExecutionAuthority({
        authorityRoot,
        completeMarkerAtStart,
        operations,
        runtimeDirectory,
        sourceAuthority,
      });
      const published = await assertOwnedHelperDirectory(runtimeDirectory, 0o555);
      if (directoryAllocationIdentity(published) !== directoryAllocationIdentity(allocated)) {
        throw new Error('private Node authority identity changed during publication');
      }
      await syncDirectory(authorityRoot, operations);
      return authority;
    } catch (error) {
      const current = await fs.lstat(runtimeDirectory, { bigint: true }).catch((statError) => {
        if (statError?.code === 'ENOENT') return null;
        throw statError;
      });
      if (current === null
          || directoryAllocationIdentity(current) !== directoryAllocationIdentity(allocated)) {
        throw error;
      }
      const permissions = process.platform === 'win32' ? 0o700 : Number(current.mode & 0o777n);
      if (permissions !== 0o700
          || completeMarkerAtStart
          || error?.code !== 'EASYBOOST_INVALID_PRIVATE_NODE_PUBLICATION') {
        throw error;
      }
      await quarantinePrivateNodeRuntime({
        authorityRoot,
        digest: sourceAuthority.digest,
        expectedAllocation: allocated,
        operations,
        runtimeDirectory,
      });
    }
  }
  throw new Error('private Node publication recovery attempts were exhausted');
}

function trustedGenerationVerifierSource() {
  return `import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const CURRENT_FILES = Object.freeze(${JSON.stringify(HELPER_GENERATION_FILE_SPECS)});
const PRE_CUTOVER_FILES = Object.freeze(${JSON.stringify(PRE_CUTOVER_V4_GENERATION_FILE_SPECS)});
const LEGACY_FILES = Object.freeze(${JSON.stringify(LEGACY_HELPER_GENERATION_FILE_SPECS)});
const MANIFEST = ${JSON.stringify(MANIFEST_NAME)};
const PROTOCOL = ${JSON.stringify(STAGING_HELPER_PROTOCOL)};
const CURRENT_SCHEMA = ${JSON.stringify(CURRENT_GENERATION_SCHEMA)};
const PRE_CUTOVER_SCHEMA = ${JSON.stringify(PRE_CUTOVER_V4_GENERATION_SCHEMA)};
const LEGACY_SCHEMA = ${JSON.stringify(LEGACY_GENERATION_SCHEMA)};
const ESM_BOUNDARY_NAME = ${JSON.stringify(GENERATION_ESM_BOUNDARY_NAME)};
const ESM_BOUNDARY = Buffer.from(${JSON.stringify(GENERATION_ESM_BOUNDARY_BYTES.toString('utf8'))});
const MAX_BYTES = ${MAX_HELPER_BYTES};
const SHA = /^[a-f0-9]{64}$/u;

function fail(message) { throw new Error(message); }
function exactKeys(value, names) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...names].sort());
}
function fileIdentity(stat) {
  return ['dev', 'ino', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs']
    .map((key) => String(stat[key])).join(':');
}
function assertDirectory(directory, expectedMode, label) {
  const stat = fs.lstatSync(directory, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail(label + ' must be a real directory');
  if (process.platform !== 'win32'
      && (stat.uid !== BigInt(process.getuid()) || Number(stat.mode & 0o777n) !== expectedMode)) {
    fail(label + ' has an unsafe owner or mode');
  }
  return stat;
}
function readStable(file, expectedMode, label) {
  const before = fs.lstatSync(file, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n
      || before.size > BigInt(MAX_BYTES)) fail(label + ' is not a bounded single-link regular file');
  let descriptor;
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || fileIdentity(opened) !== fileIdentity(before)) {
      fail(label + ' changed while opening');
    }
    if (process.platform !== 'win32'
        && (opened.uid !== BigInt(process.getuid())
          || Number(opened.mode & 0o777n) !== expectedMode || opened.nlink !== 1n)) {
      fail(label + ' has an unsafe owner, mode or link count');
    }
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor, { bigint: true });
    const finalPath = fs.lstatSync(file, { bigint: true });
    if (fileIdentity(after) !== fileIdentity(opened)
        || fileIdentity(finalPath) !== fileIdentity(opened)
        || BigInt(bytes.length) !== opened.size) fail(label + ' changed during descriptor capture');
    return bytes;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

const [installRootArgument, generationArgument, expected] = process.argv.slice(2);
if (!SHA.test(expected)) fail('expected helper generation digest is invalid');
const installRoot = path.resolve(installRootArgument);
const generations = path.join(installRoot, 'generations');
const generation = path.resolve(generationArgument);
if (generation !== path.join(generations, expected) || path.basename(generation) !== expected) {
  fail('helper generation path is outside the trusted installation root');
}
assertDirectory(installRoot, 0o755, 'helper installation root');
assertDirectory(generations, 0o755, 'helper generations root');
assertDirectory(generation, 0o555, 'helper generation');
const manifestBytes = readStable(path.join(generation, MANIFEST), 0o444, 'helper manifest');
let manifest;
try { manifest = JSON.parse(manifestBytes.toString('utf8')); } catch { fail('helper manifest is invalid JSON'); }
if (!exactKeys(manifest, ['bundleDigest', 'files', 'protocol'])
    || manifest.protocol !== PROTOCOL || manifest.bundleDigest !== expected
    || !Array.isArray(manifest.files)) {
  fail('helper manifest contract is invalid');
}
const matchesSchema = (files) => manifest.files.length === files.length
  && manifest.files.every((record, index) => record && typeof record === 'object'
    && !Array.isArray(record) && record.name === files[index].name
    && record.mode === files[index].mode);
let FILES;
let generationSchema;
if (matchesSchema(CURRENT_FILES)) {
  FILES = CURRENT_FILES;
  generationSchema = CURRENT_SCHEMA;
} else if (matchesSchema(PRE_CUTOVER_FILES)) {
  FILES = PRE_CUTOVER_FILES;
  generationSchema = PRE_CUTOVER_SCHEMA;
} else if (matchesSchema(LEGACY_FILES)) {
  FILES = LEGACY_FILES;
  generationSchema = LEGACY_SCHEMA;
} else {
  fail('helper manifest schema is unsupported');
}
const expectedNames = [...FILES.map((record) => record.name), MANIFEST].sort();
const actualNames = fs.readdirSync(generation).sort();
if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
  fail('helper generation has missing or unapproved files');
}
const aggregate = crypto.createHash('sha256');
aggregate.update('easyboost-staging-helper-bundle-v4\\0' + PROTOCOL + '\\0');
const verifiedRecords = [];
for (const [index, spec] of FILES.entries()) {
  const { mode, name } = spec;
  const record = manifest.files[index];
  if (!exactKeys(record, ['bytes', 'mode', 'name', 'sha256']) || record.name !== name
      || record.mode !== mode || !SHA.test(record.sha256)
      || !Number.isSafeInteger(record.bytes) || record.bytes < 0) {
    fail('helper manifest record is invalid: ' + name);
  }
  const bytes = readStable(path.join(generation, name), Number.parseInt(mode, 8),
    'helper file ' + name);
  const digest = crypto.createHash('sha256').update(bytes).digest('hex');
  if (bytes.length !== record.bytes || digest !== record.sha256) {
    fail('helper file digest mismatch: ' + name);
  }
  if (name === ESM_BOUNDARY_NAME && !bytes.equals(ESM_BOUNDARY)) {
    fail('helper generation ESM boundary is not canonical');
  }
  aggregate.update('F\\0' + name + '\\0' + bytes.length + '\\0' + digest + '\\0' + mode + '\\0');
  verifiedRecords.push({ name, bytes: bytes.length, sha256: digest, mode });
}
if (aggregate.digest('hex') !== expected) fail('helper bundle digest mismatch');
const canonicalManifest = Buffer.from(JSON.stringify({
  protocol: PROTOCOL, bundleDigest: expected, files: verifiedRecords,
}, null, 2) + '\\n');
if (!canonicalManifest.equals(manifestBytes)) fail('helper manifest bytes are not canonical');
process.stdout.write(generationSchema + '\\n');
`;
}

function nodeAuthorityFunctionLines(authority) {
  const ancestorChecks = authority.ancestors.flatMap((ancestor) => [
    `  [ ! -L ${shellLiteral(ancestor.path)} ] && [ -d ${shellLiteral(ancestor.path)} ] || return 1`,
    `  actual="$("$stat_tool" -c "$node_ancestor_stat_format" -- ${shellLiteral(ancestor.path)})" || return 1`,
    `  [ "$actual" = ${shellLiteral(ancestor.identity)} ] || return 1`,
  ]);
  return [
    'assert_node_ancestors() {',
    '  local actual',
    ...ancestorChecks,
    '}',
    'bind_node_authority() {',
    '  local node_before node_opened node_after node_final node_digest_output node_digest',
    '  assert_node_ancestors || return 1',
    '  [ ! -L "$node_executable" ] && [ -f "$node_executable" ] || return 1',
    '  node_before="$("$stat_tool" -c "$node_stat_format" -- "$node_executable")" || return 1',
    '  [ "$node_before" = "$node_identity" ] || return 1',
    '  exec 9< "$node_executable" || return 1',
    '  node_bound_executable="/proc/$BASHPID/fd/9"',
    '  node_opened="$("$stat_tool" -Lc "$node_stat_format" -- "$node_bound_executable")" || return 1',
    '  [ "$node_opened" = "$node_before" ] || return 1',
    '  node_digest_output="$("$sha256_tool" -- "$node_bound_executable")" || return 1',
    '  node_digest="${node_digest_output%% *}"',
    '  [ "$node_digest" = "$node_digest_expected" ] || return 1',
    '  node_after="$("$stat_tool" -Lc "$node_stat_format" -- "$node_bound_executable")" || return 1',
    '  node_final="$("$stat_tool" -c "$node_stat_format" -- "$node_executable")" || return 1',
    '  [ "$node_after" = "$node_opened" ] && [ "$node_final" = "$node_opened" ] || return 1',
    '  [ ! -L "$node_executable" ] && [ -f "$node_executable" ] || return 1',
    '  assert_node_ancestors || return 1',
    '}',
  ];
}

function quiescentMaintenanceFunctionLines(maintenanceLock) {
  return [
    'bind_quiescent_maintenance() {',
    '  local maintenance_before maintenance_preopened maintenance_opened maintenance_after',
    '  local maintenance_final maintenance_digest_output maintenance_digest maintenance_digest_after',
    '  local maintenance_dev maintenance_ino maintenance_type maintenance_uid maintenance_mode',
    '  local maintenance_links maintenance_size maintenance_owner_uid',
    '  [ "$maintenance_lock_required" = 1 ] || return 0',
    '  [ ! -L "$maintenance_lock" ] && [ -f "$maintenance_lock" ] || return 1',
    '  maintenance_before="$("$stat_tool" -c "$maintenance_stat_format" -- "$maintenance_lock")" || return 1',
    '  IFS=: read -r maintenance_dev maintenance_ino maintenance_type maintenance_uid maintenance_mode maintenance_links maintenance_size <<< "$maintenance_before"',
    '  maintenance_owner_uid="$("$id_tool" -u)" || return 1',
    '  [ "$maintenance_uid" = "$maintenance_owner_uid" ] || return 1',
    '  [ "$maintenance_mode" = 600 ] && [ "$maintenance_links" = 1 ] || return 1',
    '  [ "$maintenance_size" = "$maintenance_lock_bytes" ] || return 1',
    '  exec 7< "$maintenance_lock" || return 1',
    '  maintenance_preopened="/proc/$BASHPID/fd/7"',
    '  maintenance_opened="$("$stat_tool" -Lc "$maintenance_stat_format" -- "$maintenance_preopened")" || return 1',
    '  [ "$maintenance_opened" = "$maintenance_before" ] || return 1',
    `  exec ${STAGING_QUIESCENT_MAINTENANCE_DESCRIPTOR}<> "$maintenance_preopened" || return 1`,
    '  exec 7<&-',
    `  maintenance_digest_output="$("$sha256_tool" -- "/proc/$BASHPID/fd/${STAGING_QUIESCENT_MAINTENANCE_DESCRIPTOR}")" || return 1`,
    '  maintenance_digest="${maintenance_digest_output%% *}"',
    '  [ "$maintenance_digest" = "$maintenance_lock_digest_expected" ] || return 1',
    `  "$flock_tool" -n ${STAGING_QUIESCENT_MAINTENANCE_DESCRIPTOR} || return 1`,
    `  maintenance_after="$("$stat_tool" -Lc "$maintenance_stat_format" -- "/proc/$BASHPID/fd/${STAGING_QUIESCENT_MAINTENANCE_DESCRIPTOR}")" || return 1`,
    `  maintenance_digest_output="$("$sha256_tool" -- "/proc/$BASHPID/fd/${STAGING_QUIESCENT_MAINTENANCE_DESCRIPTOR}")" || return 1`,
    '  maintenance_digest_after="${maintenance_digest_output%% *}"',
    '  maintenance_final="$("$stat_tool" -c "$maintenance_stat_format" -- "$maintenance_lock")" || return 1',
    '  [ "$maintenance_after" = "$maintenance_opened" ] || return 1',
    '  [ "$maintenance_final" = "$maintenance_opened" ] || return 1',
    '  [ "$maintenance_digest_after" = "$maintenance_lock_digest_expected" ] || return 1',
    '  [ ! -L "$maintenance_lock" ] && [ -f "$maintenance_lock" ] || return 1',
    `  ${STAGING_QUIESCENT_MAINTENANCE_ENVIRONMENT}="$maintenance_environment_expected"`,
    `  export ${STAGING_QUIESCENT_MAINTENANCE_ENVIRONMENT}`,
    '}',
  ];
}

function launcherBytes(installRoot, nodeAuthority, maintenanceLock) {
  const trustedVerifier = trustedGenerationVerifierSource().split('\n');
  return Buffer.from([
    '#!/bin/bash -p',
    'set -Eeuo pipefail',
    `PATH=${shellLiteral(TRUSTED_SHELL_PATH)}`,
    'export PATH',
    'LC_ALL=C',
    'export LC_ALL',
    `unset BASH_ENV ENV NODE_OPTIONS NODE_PATH EASYBOOST_LEGACY_GENERATION_ROOT ${STAGING_NODE_AUTHORITY_ENVIRONMENT} ${STAGING_QUIESCENT_MAINTENANCE_ENVIRONMENT}`,
    'unset LD_PRELOAD LD_LIBRARY_PATH DYLD_INSERT_LIBRARIES DYLD_LIBRARY_PATH',
    `install_root=${shellLiteral(installRoot)}`,
    `node_executable=${shellLiteral(nodeAuthority.executable)}`,
    `node_directory=${shellLiteral(nodeAuthority.directory)}`,
    `node_identity=${shellLiteral(nodeAuthority.identity)}`,
    `node_digest_expected=${shellLiteral(nodeAuthority.digest)}`,
    `node_authority_contract_protocol=${shellLiteral(STAGING_NODE_AUTHORITY_PROTOCOL)}`,
    `maintenance_lock=${shellLiteral(maintenanceLock.path)}`,
    `maintenance_lock_bytes=${maintenanceLock.bytes.length}`,
    `maintenance_lock_digest_expected=${shellLiteral(maintenanceLock.digest)}`,
    `maintenance_environment_expected=${shellLiteral(maintenanceLock.environment)}`,
    `maintenance_lock_required=${process.platform === 'win32' ? 0 : 1}`,
    "maintenance_stat_format='%d:%i:%f:%u:%a:%h:%s'",
    `node_stat_format=${shellLiteral(nodeAuthority.statFormat)}`,
    `node_ancestor_stat_format=${shellLiteral(nodeAuthority.ancestorStatFormat)}`,
    "stat_tool='/usr/bin/stat'",
    "id_tool='/usr/bin/id'",
    "sha256_tool='/usr/bin/sha256sum'",
    "flock_tool='/usr/bin/flock'",
    `legacy_loader=${shellLiteral(LEGACY_GENERATION_LOADER_URL)}`,
    ...nodeAuthorityFunctionLines(nodeAuthority),
    ...quiescentMaintenanceFunctionLines(maintenanceLock),
    'publish_node_authority_contract() {',
    '  local owner_pid="$BASHPID"',
    '  [[ "$owner_pid" =~ ^[1-9][0-9]*$ ]] || return 1',
    `  ${STAGING_NODE_AUTHORITY_ENVIRONMENT}="$node_authority_contract_protocol:9:$owner_pid:$node_digest_expected"`,
    `  export ${STAGING_NODE_AUTHORITY_ENVIRONMENT}`,
    '}',
    'prepare_current_environment() {',
    `  PATH="$node_directory:${TRUSTED_SHELL_PATH}"`,
    '  export PATH',
    '}',
    'prepare_legacy_environment() {',
    '  prepare_current_environment',
    '  EASYBOOST_LEGACY_GENERATION_ROOT="$generation_root"',
    '  NODE_OPTIONS="--experimental-loader=$legacy_loader"',
    '  export EASYBOOST_LEGACY_GENERATION_ROOT NODE_OPTIONS',
    '}',
    'role="${1:-}"',
    '[ "$#" -gt 0 ] && shift || true',
    "recovery_authority=''",
    'upgraded_recovery=0',
    "upgraded_archive=''",
    "upgraded_archive_sha=''",
    "upgraded_old_generation=''",
    "upgraded_current_generation=''",
    'case "$role" in',
    '  cutover) [ "$#" -eq 9 ] && [ -n "$1" ] && [ "$8" = immutable-archive-v4 ] && [[ "$2" =~ ^[0-9a-f]{64}$ ]] && [[ "$3" =~ ^[0-9a-f]{64}$ ]] && [[ "$4" =~ ^[0-9a-f]{64}$ ]] && [[ "$5" =~ ^0?[0-7]{3}$ ]] && [[ "$6" =~ ^0?[0-7]{3}$ ]] && [[ "$7" =~ ^0?[0-7]{3}$ ]] && [[ "$9" =~ ^[0-9a-f]{64}$ ]] || { echo "invalid staging cutover bundle invocation" >&2; exit 64; }; expected="$9"; entry=staging-cutover.sh ;;',
    '  deploy) [ "$#" -eq 4 ] && [ "$3" = immutable-archive-v4 ] && [[ "$4" =~ ^[0-9a-f]{64}$ ]] || { echo "invalid staging deploy bundle invocation" >&2; exit 64; }; expected="$4"; entry=staging-deploy.sh ;;',
    '  rollback) [ "$#" -eq 3 ] && [ "$2" = immutable-archive-v4 ] && [[ "$3" =~ ^[0-9a-f]{64}$ ]] || { echo "invalid staging rollback bundle invocation" >&2; exit 64; }; expected="$3"; entry=staging-rollback.sh ;;',
    '  restart) [ "$#" -eq 1 ] && [[ "$1" =~ ^[0-9a-f]{64}$ ]] || { echo "invalid staging restart bundle invocation" >&2; exit 64; }; expected="$1"; entry=staging-restart-app.sh ;;',
    '  recover) recovery_role="${1:-}"; [ "$#" -gt 0 ] && shift || true; case "$recovery_role" in',
    '    bridge) [ "$#" -eq 8 ] && [ "$1" = deploy ] && [ -n "$2" ] && [ "$4" = immutable-archive-v4 ] && [[ "$3" =~ ^[0-9a-f]{64}$ ]] && [[ "$5" =~ ^[0-9a-f]{64}$ ]] && [[ "$6" =~ ^[0-9a-f]{64}$ ]] && [ "$5" != "$6" ] && [ "$7" = --recovery-authority ] && [ -n "$8" ] || { echo "invalid upgraded staging recovery invocation" >&2; exit 64; }; upgraded_recovery=1; upgraded_archive="$2"; upgraded_archive_sha="$3"; upgraded_old_generation="$5"; upgraded_current_generation="$6"; recovery_authority="$8"; expected="$6" ;;',
    '    cutover) if [ "$#" -eq 11 ] && [ "$10" = --recovery-authority ] && [ -n "$11" ]; then recovery_authority="$11"; set -- "$1" "$2" "$3" "$4" "$5" "$6" "$7" "$8" "$9"; fi; [ "$#" -eq 9 ] && [ -n "$1" ] && [ "$8" = immutable-archive-v4 ] && [[ "$2" =~ ^[0-9a-f]{64}$ ]] && [[ "$3" =~ ^[0-9a-f]{64}$ ]] && [[ "$4" =~ ^[0-9a-f]{64}$ ]] && [[ "$5" =~ ^0?[0-7]{3}$ ]] && [[ "$6" =~ ^0?[0-7]{3}$ ]] && [[ "$7" =~ ^0?[0-7]{3}$ ]] && [[ "$9" =~ ^[0-9a-f]{64}$ ]] || { echo "invalid staging cutover recovery invocation" >&2; exit 64; }; expected="$9"; entry=staging-cutover.sh ;;',
    '    deploy) if [ "$#" -eq 6 ] && [ "$5" = --recovery-authority ] && [ -n "$6" ]; then recovery_authority="$6"; set -- "$1" "$2" "$3" "$4"; fi; [ "$#" -eq 4 ] && [ "$3" = immutable-archive-v4 ] && [[ "$4" =~ ^[0-9a-f]{64}$ ]] || { echo "invalid staging deploy recovery invocation" >&2; exit 64; }; expected="$4"; entry=staging-deploy.sh ;;',
    '    rollback) if [ "$#" -eq 5 ] && [ "$4" = --recovery-authority ] && [ -n "$5" ]; then recovery_authority="$5"; set -- "$1" "$2" "$3"; fi; [ "$#" -eq 3 ] && [ "$2" = immutable-archive-v4 ] && [[ "$3" =~ ^[0-9a-f]{64}$ ]] || { echo "invalid staging rollback recovery invocation" >&2; exit 64; }; expected="$3"; entry=staging-rollback.sh ;;',
    '    restart) if [ "$#" -eq 3 ] && [ "$2" = --recovery-authority ] && [ -n "$3" ]; then recovery_authority="$3"; set -- "$1"; fi; [ "$#" -eq 1 ] && [[ "$1" =~ ^[0-9a-f]{64}$ ]] || { echo "invalid staging restart recovery invocation" >&2; exit 64; }; expected="$1"; entry=staging-restart-app.sh ;;',
    '    *) echo "unknown staging helper recovery role" >&2; exit 64 ;;',
    '  esac ;;',
    '  *) echo "unknown staging helper launcher role" >&2; exit 64 ;;',
    'esac',
    'verify_generation() {',
    '  bind_node_authority || { echo "pinned Node execution authority is invalid" >&2; return 69; }',
    `  "$node_bound_executable" --input-type=module - "$install_root" "$1" "$2" <<'EASYBOOST_TRUSTED_GENERATION_VERIFIER'`,
    ...trustedVerifier,
    'EASYBOOST_TRUSTED_GENERATION_VERIFIER',
    '}',
    'if [ "$role" = recover ] && [ "$upgraded_recovery" -eq 1 ]; then',
    '  pointer="$install_root/current"',
    '  [ ! -L "$pointer" ] && [ -f "$pointer" ] || { echo "staging helper current pointer is unsafe" >&2; exit 69; }',
    '  before="$("$stat_tool" -Lc "%d:%i:%f:%u:%a:%h:%s" -- "$pointer")" || exit 69',
    '  exec 7< "$pointer" || exit 69',
    '  opened="$("$stat_tool" -Lc "%d:%i:%f:%u:%a:%h:%s" -- "/proc/$$/fd/7")" || exit 69',
    '  [ "$before" = "$opened" ] || { echo "staging helper current pointer changed while opening" >&2; exit 69; }',
    '  IFS= read -r current_generation <&7 || { echo "staging helper current pointer is unreadable" >&2; exit 69; }',
    '  if IFS= read -r extra <&7; then echo "staging helper current pointer has extra data" >&2; exit 69; fi',
    '  after="$("$stat_tool" -Lc "%d:%i:%f:%u:%a:%h:%s" -- "/proc/$$/fd/7")" || exit 69',
    '  final="$("$stat_tool" -Lc "%d:%i:%f:%u:%a:%h:%s" -- "$pointer")" || exit 69',
    '  [ "$before" = "$after" ] && [ "$after" = "$final" ] || { echo "staging helper current pointer changed during read" >&2; exit 69; }',
    '  IFS=: read -r pointer_dev pointer_ino pointer_type pointer_uid pointer_mode pointer_links pointer_size <<< "$before"',
    '  [ "$pointer_uid" = "$("$id_tool" -u)" ] || { echo "staging helper current pointer owner is unsafe" >&2; exit 69; }',
    '  [ "${before##*:}" = 65 ] && [[ "$before" == *":444:1:65" ]] || { echo "staging helper current pointer mode or size is unsafe" >&2; exit 69; }',
    '  [[ "$current_generation" =~ ^[0-9a-f]{64}$ ]] && [ "$current_generation" = "$upgraded_current_generation" ] || { echo "staging helper current bundle does not match upgraded recovery digest" >&2; exit 69; }',
    '  upgraded_pointer_identity="$before"',
    '  current_generation_root="$install_root/generations/$upgraded_current_generation"',
    '  old_generation_root="$install_root/generations/$upgraded_old_generation"',
    '  current_generation_schema="$(verify_generation "$current_generation_root" "$upgraded_current_generation")" || { echo "upgraded staging current generation is invalid" >&2; exit 69; }',
    `  [ "$current_generation_schema" = ${CURRENT_GENERATION_SCHEMA} ] || { echo "upgraded staging current generation schema is unsupported" >&2; exit 69; }`,
    '  old_generation_schema="$(verify_generation "$old_generation_root" "$upgraded_old_generation")" || { echo "upgraded staging historical generation is invalid" >&2; exit 69; }',
    `  [ "$old_generation_schema" = ${PRE_CUTOVER_V4_GENERATION_SCHEMA} ] || { echo "upgraded staging historical generation schema is unsupported" >&2; exit 69; }`,
    '  bind_quiescent_maintenance || { echo "staging quiescent maintenance lock is unavailable" >&2; exit 75; }',
    '  before="$("$stat_tool" -Lc "%d:%i:%f:%u:%a:%h:%s" -- "$pointer")" || exit 69',
    '  [ "$before" = "$upgraded_pointer_identity" ] || { echo "staging helper current pointer changed before upgraded recovery" >&2; exit 69; }',
    '  exec 7< "$pointer" || exit 69',
    '  opened="$("$stat_tool" -Lc "%d:%i:%f:%u:%a:%h:%s" -- "/proc/$$/fd/7")" || exit 69',
    '  [ "$before" = "$opened" ] || { echo "staging helper current pointer changed while reopening" >&2; exit 69; }',
    '  IFS= read -r current_generation <&7 || { echo "staging helper current pointer is unreadable" >&2; exit 69; }',
    '  if IFS= read -r extra <&7; then echo "staging helper current pointer has extra data" >&2; exit 69; fi',
    '  after="$("$stat_tool" -Lc "%d:%i:%f:%u:%a:%h:%s" -- "/proc/$$/fd/7")" || exit 69',
    '  final="$("$stat_tool" -Lc "%d:%i:%f:%u:%a:%h:%s" -- "$pointer")" || exit 69',
    '  [ "$before" = "$after" ] && [ "$after" = "$final" ] && [ "$current_generation" = "$upgraded_current_generation" ] || { echo "staging helper current pointer changed during upgraded recovery recheck" >&2; exit 69; }',
    '  [ "$(verify_generation "$current_generation_root" "$upgraded_current_generation")" = "$current_generation_schema" ] || { echo "upgraded staging current generation changed after maintenance bind" >&2; exit 69; }',
    '  [ "$(verify_generation "$old_generation_root" "$upgraded_old_generation")" = "$old_generation_schema" ] || { echo "upgraded staging historical generation changed after maintenance bind" >&2; exit 69; }',
    '  bind_node_authority || { echo "pinned Node execution authority changed after upgraded recovery verification" >&2; exit 69; }',
    '  publish_node_authority_contract || { echo "pinned Node authority contract could not be exported" >&2; exit 69; }',
    '  prepare_current_environment',
    '  exec "$node_bound_executable" "$current_generation_root/staging-transaction-supervisor.js" --recover-with-authority "$recovery_authority" -- "$old_generation_root/staging-deploy.sh" "$upgraded_archive" "$upgraded_archive_sha" immutable-archive-v4 "$upgraded_old_generation"',
    'fi',
    'if [ "$role" = recover ]; then',
    '  recovery_arguments=(--recover)',
    '  [ -z "$recovery_authority" ] || recovery_arguments=(--recover-with-authority "$recovery_authority" --)',
    '  generation_root="$install_root/generations/$expected"',
    '  generation_schema="$(verify_generation "$generation_root" "$expected")" || { echo "staging helper recovery generation is invalid" >&2; exit 69; }',
    '  bind_node_authority || { echo "pinned Node execution authority changed after verification" >&2; exit 69; }',
    '  bind_quiescent_maintenance || { echo "staging quiescent maintenance lock is unavailable" >&2; exit 75; }',
    '  publish_node_authority_contract || { echo "pinned Node authority contract could not be exported" >&2; exit 69; }',
    '  case "$generation_schema" in',
    `    ${CURRENT_GENERATION_SCHEMA}) prepare_current_environment; exec "$node_bound_executable" "$generation_root/staging-transaction-supervisor.js" "${'${recovery_arguments[@]}'}" "$generation_root/$entry" "$@" ;;`,
    `    ${PRE_CUTOVER_V4_GENERATION_SCHEMA}) prepare_current_environment; exec "$node_bound_executable" "$generation_root/staging-transaction-supervisor.js" "${'${recovery_arguments[@]}'}" "$generation_root/$entry" "$@" ;;`,
    `    ${LEGACY_GENERATION_SCHEMA}) prepare_legacy_environment; exec "$node_bound_executable" "$generation_root/staging-transaction-supervisor.js" "${'${recovery_arguments[@]}'}" "$generation_root/$entry" "$@" ;;`,
    '    *) echo "staging helper recovery schema is unsupported" >&2; exit 69 ;;',
    '  esac',
    'fi',
    'pointer="$install_root/current"',
    '[ ! -L "$pointer" ] && [ -f "$pointer" ] || { echo "staging helper current pointer is unsafe" >&2; exit 69; }',
    'before="$("$stat_tool" -Lc "%d:%i:%f:%u:%a:%h:%s" -- "$pointer")" || exit 69',
    'exec 7< "$pointer" || exit 69',
    'opened="$("$stat_tool" -Lc "%d:%i:%f:%u:%a:%h:%s" -- "/proc/$$/fd/7")" || exit 69',
    '[ "$before" = "$opened" ] || { echo "staging helper current pointer changed while opening" >&2; exit 69; }',
    'IFS= read -r current_generation <&7 || { echo "staging helper current pointer is unreadable" >&2; exit 69; }',
    'if IFS= read -r extra <&7; then echo "staging helper current pointer has extra data" >&2; exit 69; fi',
    'after="$("$stat_tool" -Lc "%d:%i:%f:%u:%a:%h:%s" -- "/proc/$$/fd/7")" || exit 69',
    'final="$("$stat_tool" -Lc "%d:%i:%f:%u:%a:%h:%s" -- "$pointer")" || exit 69',
    '[ "$before" = "$after" ] && [ "$after" = "$final" ] || { echo "staging helper current pointer changed during read" >&2; exit 69; }',
    'IFS=: read -r pointer_dev pointer_ino pointer_type pointer_uid pointer_mode pointer_links pointer_size <<< "$before"',
    '[ "$pointer_uid" = "$("$id_tool" -u)" ] || { echo "staging helper current pointer owner is unsafe" >&2; exit 69; }',
    '[ "${before##*:}" = 65 ] && [[ "$before" == *":444:1:65" ]] || { echo "staging helper current pointer mode or size is unsafe" >&2; exit 69; }',
    '[[ "$current_generation" =~ ^[0-9a-f]{64}$ ]] || { echo "staging helper current pointer is invalid" >&2; exit 69; }',
    '[ "$current_generation" = "$expected" ] || { echo "staging helper current bundle does not match requested digest" >&2; exit 69; }',
    'generation_root="$install_root/generations/$current_generation"',
    'generation_schema="$(verify_generation "$generation_root" "$current_generation")" || { echo "staging helper current generation is invalid" >&2; exit 69; }',
    'bind_node_authority || { echo "pinned Node execution authority changed after verification" >&2; exit 69; }',
    'bind_quiescent_maintenance || { echo "staging quiescent maintenance lock is unavailable" >&2; exit 75; }',
    'publish_node_authority_contract || { echo "pinned Node authority contract could not be exported" >&2; exit 69; }',
    'case "$generation_schema" in',
    `  ${CURRENT_GENERATION_SCHEMA}) prepare_current_environment; exec "$node_bound_executable" "$generation_root/staging-transaction-supervisor.js" --run 1800 600 5000 7000 5000 -- "$generation_root/$entry" "$@" ;;`,
    `  ${PRE_CUTOVER_V4_GENERATION_SCHEMA}) prepare_current_environment; exec "$node_bound_executable" "$generation_root/staging-transaction-supervisor.js" --run 1800 600 5000 7000 5000 -- "$generation_root/$entry" "$@" ;;`,
    `  ${LEGACY_GENERATION_SCHEMA}) prepare_legacy_environment; exec "$node_bound_executable" "$generation_root/staging-transaction-supervisor.js" --run 1800 600 5000 7000 5000 -- "$generation_root/$entry" "$@" ;;`,
    '  *) echo "staging helper current generation schema is unsupported" >&2; exit 69 ;;',
    'esac',
    '',
  ].join('\n'));
}

function dispatcherBytes(installRoot, role) {
  return Buffer.from([
    '#!/bin/bash -p',
    'set -Eeuo pipefail',
    `PATH=${shellLiteral(TRUSTED_SHELL_PATH)}`,
    'export PATH',
    `unset BASH_ENV ENV NODE_OPTIONS NODE_PATH EASYBOOST_LEGACY_GENERATION_ROOT ${STAGING_NODE_AUTHORITY_ENVIRONMENT} ${STAGING_QUIESCENT_MAINTENANCE_ENVIRONMENT}`,
    'unset LD_PRELOAD LD_LIBRARY_PATH DYLD_INSERT_LIBRARIES DYLD_LIBRARY_PATH',
    `exec ${shellLiteral(path.join(installRoot, 'staging-release-entry.sh'))} ${role} "$@"`,
    '',
  ].join('\n'));
}

async function removePublishedFileContainer(container, expectedAllocation, operations) {
  const current = await fs.lstat(container, { bigint: true }).catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (current === null || !current.isDirectory() || current.isSymbolicLink()
      || directoryAllocationIdentity(current) !== directoryAllocationIdentity(expectedAllocation)) {
    return;
  }
  if ((await fs.readdir(container)).length !== 0) return;
  await operations.rmdir(container).catch(() => {});
  await syncDirectory(path.dirname(container), operations).catch(() => {});
}

async function atomicFile(destination, bytes, mode, operations = fs) {
  const container = await operations.mkdtemp(`${destination}.new.${process.pid}.`);
  const containerAllocation = privateNodeRuntimeAllocation(
    await fs.lstat(container, { bigint: true }),
    'durable helper file private container',
  );
  const temporary = path.join(container,
    `${path.basename(destination)}.new.${process.pid}.${crypto.randomBytes(6).toString('hex')}`);
  let destinationModeChanged = false;
  let renamed = false;
  try {
    await writeDurableFile(temporary, bytes, mode, operations);
    if (process.platform === 'win32') {
      await operations.chmod(destination, 0o600).then(() => { destinationModeChanged = true; },
        (error) => { if (error?.code !== 'ENOENT') throw error; });
    }
    try {
      await operations.rename(temporary, destination);
      renamed = true;
      destinationModeChanged = false;
    } catch (error) {
      if (destinationModeChanged) await operations.chmod(destination, mode).catch(() => {});
      throw error;
    }
    await syncDirectory(path.dirname(destination), operations);
  } finally {
    if (renamed) {
      await removePublishedFileContainer(container, containerAllocation, operations);
    }
  }
}

export async function installStagingHelperBundle({
  sourceDirectory, appRoot = DEFAULT_STAGING_ROOTS.appRoot, installRoot, linkRoot,
  allowedPrefix, operations = fs,
}) {
  const validated = validateStagingRootLayout({
    appRoot,
    installRoot,
    linkRoot,
    allowedPrefix,
  });
  const captured = captureHelperBundle({ sourceDirectory });
  const sourceNodeAuthority = captureNodeExecutionAuthority({ captureBytes: true });
  const io = installerOperations(operations);
  const root = validated.installRoot;
  const links = validated.linkRoot;
  const generations = path.join(root, 'generations');
  const customRootBoundary = validated.allowedPrefix && strictDescendant(root, validated.allowedPrefix)
    ? validated.allowedPrefix : null;
  const customLinkBoundary = validated.allowedPrefix && strictDescendant(links, validated.allowedPrefix)
    ? validated.allowedPrefix : null;
  return io.withInstallerLock(root, async () => {
    await ensureSafeDirectory(root, 0o755, io, customRootBoundary);
    const nodeAuthority = await publishPrivateNodeExecutionAuthority({
      installRoot: root,
      operations: io,
      sourceAuthority: sourceNodeAuthority,
    });
    await ensureSafeDirectory(generations, 0o755, io, root);
    await ensureSafeDirectory(links, 0o755, io, customLinkBoundary);
    const generation = path.join(generations, captured.bundleDigest);
    try {
      await fs.lstat(generation);
      await verifyInstalledHelperGeneration({
        generationDirectory: generation, expectedDigest: captured.bundleDigest,
      });
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      const staging = await io.mkdtemp(path.join(generations, `.${captured.bundleDigest}.`));
      for (const record of captured.records) {
        await writeDurableFile(path.join(staging, record.name), record.bytes,
          Number.parseInt(record.mode, 8), io);
      }
      await writeDurableFile(path.join(staging, MANIFEST_NAME), captured.manifestBytes,
        0o444, io);
      await io.chmod(staging, 0o555);
      await syncDirectory(staging, io);
      await io.rename(staging, generation);
      await verifyInstalledHelperGeneration({
        generationDirectory: generation, expectedDigest: captured.bundleDigest,
      });
    }
    await syncDirectory(generations, io);
    const maintenanceLock = await ensureQuiescentMaintenanceLock(root, io);

    await atomicFile(path.join(root, 'staging-release-entry.sh'),
      launcherBytes(root, nodeAuthority, maintenanceLock), 0o555, io);
    await atomicFile(path.join(links, 'easyboost-staging-cutover'),
      dispatcherBytes(root, 'cutover'), 0o555, io);
    await atomicFile(path.join(links, 'easyboost-staging-deploy'),
      dispatcherBytes(root, 'deploy'), 0o555, io);
    await atomicFile(path.join(links, 'easyboost-staging-rollback'),
      dispatcherBytes(root, 'rollback'), 0o555, io);
    await atomicFile(path.join(links, 'easyboost-staging-restart'),
      dispatcherBytes(root, 'restart'), 0o555, io);
    await atomicFile(path.join(links, 'easyboost-staging-recover'),
      dispatcherBytes(root, 'recover'), 0o555, io);
    await atomicFile(path.join(root, 'current'), Buffer.from(`${captured.bundleDigest}\n`),
      0o444, io);
    await verifyInstalledHelperGeneration({
      generationDirectory: generation, expectedDigest: captured.bundleDigest,
    });
    return { bundleDigest: captured.bundleDigest, protocol: STAGING_HELPER_PROTOCOL };
  });
}

async function runCli() {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'protocol' && args.length === 0) {
    console.log(STAGING_HELPER_PROTOCOL);
    return;
  }
  if (command === 'digest' && args.length === 1) {
    console.log(captureHelperBundle({ sourceDirectory: path.resolve(args[0]) }).bundleDigest);
    return;
  }
  if (command === 'verify-generation' && args.length === 2) {
    await verifyInstalledHelperGeneration({
      generationDirectory: path.resolve(args[0]), expectedDigest: args[1],
    });
    return;
  }
  if (command === 'validate-root-layout' && args.length === 4) {
    console.log(JSON.stringify(validateStagingRootLayout({
      appRoot: args[0], installRoot: args[1], linkRoot: args[2], allowedPrefix: args[3],
    })));
    return;
  }
  if (command === 'install' && args.length === 3) {
    const result = await installStagingHelperBundle({
      sourceDirectory: path.resolve(args[0]),
      appRoot: process.env.STAGING_APP_DIR || DEFAULT_STAGING_ROOTS.appRoot,
      installRoot: path.resolve(args[1]),
      linkRoot: path.resolve(args[2]),
      allowedPrefix: process.env.STAGING_HELPER_ALLOWED_PREFIX,
    });
    console.log(`staging_helper_protocol=${result.protocol}`);
    console.log(`staging_helper_bundle_sha256=${result.bundleDigest}`);
    return;
  }
  throw new Error('Usage: staging-helper-bundle.js protocol | digest SOURCE | verify-generation DIRECTORY DIGEST | validate-root-layout APP_ROOT INSTALL_ROOT LINK_ROOT ALLOWED_PREFIX | install SOURCE INSTALL_ROOT LINK_ROOT');
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  runCli().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
