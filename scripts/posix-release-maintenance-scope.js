import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  createPosixSessionControl,
  sweepPosixSessionRetainedEvidence,
} from './posix-session-supervisor.js';
import {
  POSIX_RELEASE_MAINTENANCE_ENVIRONMENT,
  bindStagingQuiescentMaintenanceRoot,
  consumePosixReleaseMaintenanceLock,
  posixReleaseMaintenanceEnvironmentValue,
} from './staging-quiescent-maintenance.js';

export const POSIX_RELEASE_MAINTENANCE_SCOPE_PROTOCOL =
  'easyboost-posix-release-maintenance-scope-v2';
export const POSIX_RELEASE_MAINTENANCE_LOCK_PROTOCOL =
  'easyboost-posix-release-maintenance-lock-v2';
export const POSIX_RELEASE_MAINTENANCE_LANES = Object.freeze([
  'aisy-release-e2e',
  'pwa-predecessor',
]);

const MODULE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const LAUNCHER = path.join(MODULE_DIRECTORY, 'posix-release-maintenance-launcher.sh');
const SCOPE_DESCRIPTORS = new WeakMap();
const MAINTENANCE_BINDINGS = new WeakMap();
const SAFE_NAME = /^[a-z][a-z0-9-]{0,63}$/u;
const DECIMAL = /^(?:0|[1-9][0-9]*)$/u;
const MAX_LOCK_BYTES = 4_096;

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort()
      .map((key) => [key, canonicalValue(value[key])]));
  }
  return value;
}

function canonicalJson(value) {
  return `${JSON.stringify(canonicalValue(value))}\n`;
}

function permissions(stat) {
  return typeof stat.mode === 'bigint'
    ? Number(stat.mode & 0o777n) : Number(stat.mode & 0o777);
}

function sameIdentity(left, right) {
  return String(left.dev) === String(right.dev) && String(left.ino) === String(right.ino);
}

function syncDirectory(directory, filesystem = fs) {
  const descriptor = filesystem.openSync(directory, 'r');
  try { filesystem.fsyncSync(descriptor); } finally { filesystem.closeSync(descriptor); }
}

function ensurePrivateDirectory(directory, userId, filesystem = fs) {
  try {
    filesystem.mkdirSync(directory, { mode: 0o700 });
    syncDirectory(path.dirname(directory), filesystem);
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
  const identity = filesystem.lstatSync(directory, { bigint: true });
  if (!identity.isDirectory() || identity.isSymbolicLink()
      || permissions(identity) !== 0o700
      || String(identity.uid) !== String(userId)) {
    throw new Error('POSIX release maintenance directory is unsafe');
  }
  return identity;
}

function githubAttempt(environment) {
  const keys = ['GITHUB_ACTIONS', 'GITHUB_JOB', 'GITHUB_RUN_ATTEMPT', 'GITHUB_RUN_ID', 'RUNNER_TEMP'];
  const present = keys.filter((key) => environment[key] !== undefined);
  if (present.length === 0) return null;
  if (present.length !== keys.length || environment.GITHUB_ACTIONS !== 'true'
      || !/^[1-9][0-9]*$/u.test(environment.GITHUB_RUN_ID)
      || !/^[1-9][0-9]*$/u.test(environment.GITHUB_RUN_ATTEMPT)
      || !/^[A-Za-z0-9_.-]{1,128}$/u.test(environment.GITHUB_JOB)
      || !path.isAbsolute(environment.RUNNER_TEMP)) {
    throw new Error('POSIX release maintenance GitHub attempt scope is invalid');
  }
  return `github:${environment.GITHUB_RUN_ID}:${environment.GITHUB_RUN_ATTEMPT}`
    + `:${environment.GITHUB_JOB}`;
}

function lockFingerprint(stat) {
  return [stat.dev, stat.ino, stat.uid, stat.gid,
    permissions(stat).toString(8), stat.nlink, stat.size].map(String).join(':');
}

function validateLockFile(file, bytes, userId, filesystem = fs) {
  const before = filesystem.lstatSync(file, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n
      || permissions(before) !== 0o600 || String(before.uid) !== String(userId)
      || before.size !== BigInt(bytes.length)) {
    throw new Error('POSIX release maintenance lock file is unsafe');
  }
  const observed = filesystem.readFileSync(file);
  const after = filesystem.lstatSync(file, { bigint: true });
  if (!observed.equals(bytes) || !sameIdentity(before, after)
      || before.size !== after.size || before.mtimeNs !== after.mtimeNs) {
    throw new Error('POSIX release maintenance lock file changed during validation');
  }
  return after;
}

function publishLockFile(file, bytes, userId, filesystem = fs) {
  let descriptor;
  try {
    descriptor = filesystem.openSync(file, 'wx', 0o600);
    filesystem.writeFileSync(descriptor, bytes);
    filesystem.fsyncSync(descriptor);
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  } finally {
    if (descriptor !== undefined) filesystem.closeSync(descriptor);
  }
  syncDirectory(path.dirname(file), filesystem);
  return validateLockFile(file, bytes, userId, filesystem);
}

function strictLane(lane) {
  if (!POSIX_RELEASE_MAINTENANCE_LANES.includes(lane)) {
    throw new Error('POSIX release maintenance lane is invalid');
  }
  return lane;
}

export function establishPosixReleaseMaintenanceScope({
  checkoutDirectory,
  controlRootNames = ['posix-session-controls'],
  environment = process.env,
  filesystem = fs,
  lane,
  platform = process.platform,
  temporaryDirectory,
  userId = typeof process.getuid === 'function' ? process.getuid() : undefined,
} = {}) {
  if (platform !== 'linux' || !Number.isSafeInteger(userId) || userId < 0
      || typeof checkoutDirectory !== 'string' || !path.isAbsolute(checkoutDirectory)
      || !Array.isArray(controlRootNames) || controlRootNames.length < 1
      || controlRootNames.some((name) => !SAFE_NAME.test(name))) {
    throw new Error('POSIX release maintenance scope request is invalid');
  }
  lane = strictLane(lane);
  const checkoutPath = filesystem.realpathSync.native(checkoutDirectory);
  const checkoutIdentity = filesystem.lstatSync(checkoutPath, { bigint: true });
  if (!checkoutIdentity.isDirectory() || checkoutIdentity.isSymbolicLink()) {
    throw new Error('POSIX release maintenance checkout is invalid');
  }
  const attempt = githubAttempt(environment);
  const base = attempt === null
    ? path.resolve(temporaryDirectory ?? os.tmpdir())
    : filesystem.realpathSync.native(environment.RUNNER_TEMP);
  if (!path.isAbsolute(base)) throw new Error('POSIX release maintenance base is invalid');
  const userRoot = path.join(base, `easyboost-release-maintenance-v2-u${userId}`);
  ensurePrivateDirectory(userRoot, userId, filesystem);
  const checkoutKey = createHash('sha256').update([
    checkoutPath, String(checkoutIdentity.dev), String(checkoutIdentity.ino), attempt ?? 'local',
  ].join('\0'), 'utf8').digest('hex');
  const scopeRoot = path.join(userRoot, checkoutKey);
  const scopeIdentity = ensurePrivateDirectory(scopeRoot, userId, filesystem);
  const laneRoot = path.join(scopeRoot, lane);
  ensurePrivateDirectory(laneRoot, userId, filesystem);
  const uniqueNames = [...new Set(controlRootNames)].sort();
  if (uniqueNames.length !== controlRootNames.length) {
    throw new Error('POSIX release maintenance control-root names are not unique');
  }
  const controlRoots = uniqueNames.map((name) => {
    const rootPath = path.join(laneRoot, name);
    const identity = ensurePrivateDirectory(rootPath, userId, filesystem);
    if (path.dirname(rootPath) !== laneRoot) {
      throw new Error('POSIX release maintenance control roots must be siblings');
    }
    return Object.freeze({
      dev: String(identity.dev),
      ino: String(identity.ino),
      name,
      path: rootPath,
    });
  });
  const record = Object.freeze({
    checkoutDev: String(checkoutIdentity.dev),
    checkoutIno: String(checkoutIdentity.ino),
    checkoutPath,
    ciAttempt: attempt,
    controlRoots,
    lane,
    ownerUid: String(userId),
    protocol: POSIX_RELEASE_MAINTENANCE_LOCK_PROTOCOL,
    scopeDev: String(scopeIdentity.dev),
    scopeIno: String(scopeIdentity.ino),
    scopePath: scopeRoot,
  });
  const lockBytes = Buffer.from(canonicalJson(record), 'utf8');
  if (lockBytes.length < 1 || lockBytes.length > MAX_LOCK_BYTES) {
    throw new Error('POSIX release maintenance lock record is unbounded');
  }
  const lockPath = path.join(laneRoot, 'maintenance.lock');
  const lockIdentity = publishLockFile(lockPath, lockBytes, userId, filesystem);
  const descriptor = Object.freeze({});
  SCOPE_DESCRIPTORS.set(descriptor, Object.freeze({
    checkoutDirectory: checkoutPath,
    controlRoots,
    environmentValue: posixReleaseMaintenanceEnvironmentValue(lockBytes),
    lane,
    laneRoot,
    lockBytes,
    lockDigest: createHash('sha256').update(lockBytes).digest('hex'),
    lockFingerprint: lockFingerprint(lockIdentity),
    lockPath,
    record,
    scopeRoot,
  }));
  return descriptor;
}

export function createPosixReleaseMaintenanceLauncherInvocation(
  descriptor,
  command,
  args = [],
  { cwd, environment = process.env } = {},
) {
  const scope = SCOPE_DESCRIPTORS.get(descriptor);
  if (!scope || typeof command !== 'string' || !path.isAbsolute(command)
      || !Array.isArray(args) || args.some((argument) => typeof argument !== 'string')) {
    throw new Error('POSIX release maintenance launcher invocation is invalid');
  }
  const childEnvironment = { ...environment };
  for (const name of [
    'BASH_ENV', 'ENV', 'NODE_OPTIONS', 'NODE_PATH', POSIX_RELEASE_MAINTENANCE_ENVIRONMENT,
  ]) delete childEnvironment[name];
  return Object.freeze({
    args: Object.freeze([
      LAUNCHER,
      scope.lockPath,
      scope.lockFingerprint,
      String(scope.lockBytes.length),
      scope.lockDigest,
      scope.environmentValue,
      command,
      ...args,
    ]),
    command: '/bin/bash',
    cwd: cwd ?? '/',
    environment: childEnvironment,
  });
}

export function launchPosixReleaseMaintenanceBatch({
  args = process.argv.slice(2),
  checkoutDirectory,
  entrypoint = process.argv[1],
  environment = process.env,
  lane,
  spawnProcess = spawnSync,
  stdio = 'inherit',
  temporaryDirectory,
} = {}) {
  if (process.platform !== 'linux'
      || environment[POSIX_RELEASE_MAINTENANCE_ENVIRONMENT] !== undefined) return null;
  const descriptor = establishPosixReleaseMaintenanceScope({
    checkoutDirectory, environment, lane, temporaryDirectory,
  });
  const invocation = createPosixReleaseMaintenanceLauncherInvocation(
    descriptor, process.execPath, [path.resolve(entrypoint), ...args], { environment },
  );
  return spawnProcess(invocation.command, invocation.args, {
    cwd: invocation.cwd,
    env: invocation.environment,
    shell: false,
    stdio,
    windowsHide: true,
  });
}

export function consumePosixReleaseMaintenanceBinding({
  checkoutDirectory,
  environment = process.env,
  lane,
  temporaryDirectory,
} = {}) {
  if (process.platform !== 'linux') return undefined;
  const descriptor = establishPosixReleaseMaintenanceScope({
    checkoutDirectory, environment, lane, temporaryDirectory,
  });
  const scope = SCOPE_DESCRIPTORS.get(descriptor);
  const proof = consumePosixReleaseMaintenanceLock({
    allowedControlRoots: scope.controlRoots.map(({ dev, ino, path: rootPath }) => ({
      dev, ino, path: rootPath,
    })),
    environment,
    expectedLockBytes: scope.lockBytes,
    expectedLockPath: scope.lockPath,
  });
  if (!proof) throw new Error('POSIX release maintenance binding is required');
  const root = scope.controlRoots[0];
  const maintenance = bindStagingQuiescentMaintenanceRoot(proof, root.path);
  sweepPosixSessionRetainedEvidence({
    controlRoot: root.path,
    quiescentMaintenanceAuthority: maintenance.authority,
    reclaimRetainedEvidence: maintenance.reclaimRetainedEvidence,
  });
  const binding = Object.freeze({});
  MAINTENANCE_BINDINGS.set(binding, Object.freeze({
    controlRoot: root.path,
    lane: scope.lane,
    quiescentMaintenanceAuthority: maintenance.authority,
    reclaimRetainedEvidence: maintenance.reclaimRetainedEvidence,
    recoveryScope: `${POSIX_RELEASE_MAINTENANCE_SCOPE_PROTOCOL}:${scope.lockDigest}:${root.name}`,
  }));
  return binding;
}

export function resolvePosixReleaseMaintenanceBinding(binding, { lane } = {}) {
  const resolved = MAINTENANCE_BINDINGS.get(binding);
  if (!resolved || (lane !== undefined && resolved.lane !== strictLane(lane))) {
    throw new Error('POSIX release maintenance binding is invalid');
  }
  return resolved;
}

export function createPosixReleaseSessionControl(binding, {
  controlKey,
  inspectSession,
  syncControlRoot,
  writeControlRecord,
} = {}) {
  const resolved = resolvePosixReleaseMaintenanceBinding(binding);
  const control = createPosixSessionControl({
    controlKey,
    controlRoot: resolved.controlRoot,
    ...(inspectSession === undefined ? {} : { inspectSession }),
    quiescentMaintenanceAuthority: resolved.quiescentMaintenanceAuthority,
    reclaimRetainedEvidence: resolved.reclaimRetainedEvidence,
    ...(syncControlRoot === undefined ? {} : { syncControlRoot }),
    ...(writeControlRecord === undefined ? {} : { writeControlRecord }),
  });
  return Object.freeze({
    control,
    controlRoot: resolved.controlRoot,
    recoveryScope: resolved.recoveryScope,
  });
}
