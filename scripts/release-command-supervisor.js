import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  POSIX_SESSION_WRITER_EGRESS_FD,
  createPosixSessionControl,
  createPosixSessionInvocation,
  normalizePosixSessionPublicationResidue,
  normalizePosixSessionPublicationResidues,
  observePosixSessionWriterEgress,
} from './posix-session-supervisor.js';

const DEFAULT_HARD_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_TERMINATE_GRACE_MS = 5_000;
const DEFAULT_KILL_GRACE_MS = 5_000;
const DEFAULT_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const GROUP_POLL_MS = 20;
const WINDOWS_JOB_PROTOCOL = 'easyboost-windows-job-v1';
const WINDOWS_JOB_CONTROL_PROTOCOL = 'easyboost-windows-job-control-v1';
const WINDOWS_JOB_EMPTY_PROTOCOL = 'easyboost-windows-job-empty-v1';
const WINDOWS_JOB_DELETE_PROTOCOL = 'easyboost-windows-job-delete-batch-v1';
const WINDOWS_JOB_REQUEST_PUBLICATION_PROTOCOL =
  'easyboost-windows-job-request-publication-v1';
const WINDOWS_JOB_RECOVERY_PROTOCOL = 'easyboost-windows-job-recovery-v2';
const WINDOWS_JOB_RETIREMENT_PROTOCOL = 'easyboost-windows-job-retirement-v2';
const WINDOWS_JOB_RECOVERY_FILE_LIMIT = 16 * 1024;
const WINDOWS_JOB_DELETE_PAYLOAD_LIMIT = 20 * 1024;
const WINDOWS_JOB_DELETE_TIMEOUT_MS = 30_000;
const WINDOWS_JOB_REQUEST_PUBLICATION_TIMEOUT_MS = 5_000;
const WINDOWS_JOB_SCRIPT = fileURLToPath(new URL('./windows-job-supervisor.ps1', import.meta.url));
const WINDOWS_JOB_DIRECTORY = fileURLToPath(new URL('.', import.meta.url));
const WINDOWS_JOB_CONTROL_ENVIRONMENT = 'EASYBOOST_WINDOWS_JOB_CONTROL';
const WINDOWS_JOB_ENVIRONMENT = 'EASYBOOST_WINDOWS_JOB_TARGET_ENVIRONMENT';
const WINDOWS_SUPERVISOR_ENVIRONMENT_KEYS = Object.freeze([
  'COMSPEC', 'PATH', 'PATHEXT', 'PSModulePath', 'SystemRoot', 'TEMP', 'TMP', 'WINDIR',
]);
const WINDOWS_JOB_MONOTONIC_NOW = () => performance.now();
const WINDOWS_JOB_RECOVERY_WAIT_STATE = new Int32Array(new SharedArrayBuffer(4));
const WINDOWS_JOB_RECOVERY_SLEEP = (milliseconds) => {
  Atomics.wait(WINDOWS_JOB_RECOVERY_WAIT_STATE, 0, 0, milliseconds);
};

function windowsJobCleanupClockReading(monotonicNow) {
  const reading = monotonicNow();
  if (typeof reading !== 'number' || !Number.isFinite(reading) || reading < 0) {
    throw new Error('Windows Job cleanup clock reading is invalid');
  }
  return reading;
}

export function createWindowsJobCleanupBudget(timeoutMs, {
  monotonicNow = WINDOWS_JOB_MONOTONIC_NOW,
} = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0
      || typeof monotonicNow !== 'function') {
    throw new Error('Windows Job cleanup budget is invalid');
  }
  const startedAt = windowsJobCleanupClockReading(monotonicNow);
  let lastReading = startedAt;
  return Object.freeze({
    remainingMilliseconds() {
      const current = windowsJobCleanupClockReading(monotonicNow);
      if (current < lastReading) {
        throw new Error('Windows Job cleanup clock moved backwards');
      }
      lastReading = current;
      const remaining = Math.floor(timeoutMs - (current - startedAt));
      if (!Number.isSafeInteger(remaining) || remaining <= 0) {
        throw new Error('Windows Job native deletion cleanup deadline expired');
      }
      return Math.min(timeoutMs, remaining);
    },
  });
}

function environmentValue(environment, requestedName) {
  const entry = Object.entries(environment ?? {}).find(
    ([name]) => name.toLocaleUpperCase('en-US') === requestedName.toLocaleUpperCase('en-US'),
  );
  return entry?.[1];
}

function windowsSupervisorEnvironment(targetEnvironment, controlSpecification) {
  const environment = {};
  for (const name of WINDOWS_SUPERVISOR_ENVIRONMENT_KEYS) {
    const value = environmentValue(process.env, name);
    if (value !== undefined) environment[name] = String(value);
  }
  const entriesByFold = new Map();
  const assignEntry = (name, value) => {
    if (value === undefined) return;
    const folded = name.toLocaleUpperCase('en-US');
    const previous = entriesByFold.get(folded);
    entriesByFold.set(folded, {
      name: previous?.name ?? name,
      value: String(value),
    });
  };
  for (const [name, value] of Object.entries(targetEnvironment ?? process.env)) {
    assignEntry(name, value);
  }
  for (const name of WINDOWS_SUPERVISOR_ENVIRONMENT_KEYS) {
    if (entriesByFold.has(name.toLocaleUpperCase('en-US'))) continue;
    const value = environmentValue(process.env, name);
    assignEntry(name, value);
  }
  const entries = [...entriesByFold.values()];
  environment[WINDOWS_JOB_ENVIRONMENT] = Buffer.from(JSON.stringify({
    entries,
    protocol: WINDOWS_JOB_PROTOCOL,
  }), 'utf8').toString('base64');
  environment[WINDOWS_JOB_CONTROL_ENVIRONMENT] = Buffer.from(JSON.stringify(
    controlSpecification,
  ), 'utf8').toString('base64');
  return environment;
}

function windowsNativeHelperEnvironment() {
  const environment = {};
  for (const name of WINDOWS_SUPERVISOR_ENVIRONMENT_KEYS) {
    const value = environmentValue(process.env, name);
    if (value !== undefined) environment[name] = String(value);
  }
  return environment;
}

function windowsJobProofValue(proofToken) {
  return `${JSON.stringify({
    activeProcesses: 0,
    protocol: WINDOWS_JOB_EMPTY_PROTOCOL,
    token: proofToken,
  })}\n`;
}

function windowsJobRequestValue(signal, controlToken) {
  return `${JSON.stringify({
    protocol: WINDOWS_JOB_CONTROL_PROTOCOL,
    signal,
    token: controlToken,
  })}\n`;
}

function windowsJobHashedControlPaths(controlRoot, controlKeyHash) {
  const controlName = `easyboost-windows-job-${controlKeyHash}`;
  const controlDirectory = path.join(controlRoot, controlName);
  const retirementName = `.${controlName}.retired`;
  return Object.freeze({
    controlDirectory,
    controlKeyHash,
    controlRoot,
    retirementDirectory: path.join(controlRoot, retirementName),
    retirementPending: path.join(controlRoot, `${retirementName}.proof.pending`),
    retirementProof: path.join(controlRoot, `${retirementName}.proof`),
    retirementProofDeletion: path.join(controlRoot, `${retirementName}.proof.sealed-delete`),
  });
}

function windowsJobControlPaths(controlKey, temporaryDirectory) {
  if (controlKey === undefined || controlKey === null || String(controlKey).length === 0) {
    throw new Error('Windows Job recovery requires a deterministic controlKey');
  }
  if (typeof temporaryDirectory !== 'string' || !path.isAbsolute(temporaryDirectory)) {
    throw new Error('Windows Job recovery root must be absolute');
  }
  const controlRoot = path.resolve(temporaryDirectory);
  const controlKeyHash = createHash('sha256').update(String(controlKey), 'utf8').digest('hex');
  return windowsJobHashedControlPaths(controlRoot, controlKeyHash);
}

function windowsJobControlPathsFromAuthority(authority) {
  if (!authority || typeof authority !== 'object' || Array.isArray(authority)
      || authority.protocol !== WINDOWS_JOB_RECOVERY_PROTOCOL
      || !/^[a-f0-9]{64}$/u.test(authority.proofToken ?? '')
      || typeof authority.controlDirectory !== 'string'
      || !path.isAbsolute(authority.controlDirectory)) {
    throw new Error('Windows Job recovery authority is invalid');
  }
  const controlDirectory = path.resolve(authority.controlDirectory);
  const match = /^easyboost-windows-job-([a-f0-9]{64})$/u.exec(path.basename(controlDirectory));
  if (!match) throw new Error('Windows Job recovery authority namespace is invalid');
  const paths = windowsJobHashedControlPaths(path.dirname(controlDirectory), match[1]);
  if (authority.controlDirectory !== paths.controlDirectory
      || authority.retirementDirectory !== paths.retirementDirectory
      || authority.retirementProof !== paths.retirementProof
      || authority.authorityFile !== paths.retirementProof) {
    throw new Error('Windows Job recovery authority paths are not exact');
  }
  return paths;
}

function windowsJobRecoveryAuthority(paths, proofToken) {
  if (proofToken === undefined) {
    return Object.freeze({ controlDirectory: paths.controlDirectory });
  }
  return Object.freeze({
    authorityFile: paths.retirementProof,
    controlDirectory: paths.controlDirectory,
    proofToken,
    protocol: WINDOWS_JOB_RECOVERY_PROTOCOL,
    retirementDirectory: paths.retirementDirectory,
    retirementProof: paths.retirementProof,
  });
}

function windowsJobRecoveryRequired(paths, cause, proofToken) {
  const error = new Error(
    `WINDOWS_JOB_RECOVERY_REQUIRED: ${paths.controlDirectory}`,
    cause ? { cause } : undefined,
  );
  error.childSettlementUnproven = true;
  error.code = 'WINDOWS_JOB_RECOVERY_REQUIRED';
  error.recoveryAuthority = windowsJobRecoveryAuthority(paths, proofToken);
  return error;
}

function lstatIfPresent(file, options) {
  try {
    return fs.lstatSync(file, options);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function exactWindowsJobDirectoryIdentity(directory) {
  const stat = lstatIfPresent(directory, { bigint: true });
  if (!stat) return null;
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('Windows Job recovery authority is not a private directory');
  }
  return Object.freeze({
    birthtimeNs: String(stat.birthtimeNs),
    dev: String(stat.dev),
    ino: String(stat.ino),
  });
}

function sameWindowsJobDirectoryIdentity(left, right) {
  return left && right
    && left.birthtimeNs === right.birthtimeNs
    && left.dev === right.dev
    && left.ino === right.ino;
}

function readBoundedWindowsJobFile(file, label, { allowedLinkCounts = [1n] } = {}) {
  const before = lstatIfPresent(file, { bigint: true });
  if (!before || !before.isFile() || before.isSymbolicLink()
      || !allowedLinkCounts.includes(before.nlink)
      || before.size > BigInt(WINDOWS_JOB_RECOVERY_FILE_LIMIT)) {
    throw new Error(`${label} is missing, unsafe, or unbounded`);
  }
  const value = fs.readFileSync(file);
  const after = lstatIfPresent(file, { bigint: true });
  if (!after || before.dev !== after.dev || before.ino !== after.ino
      || before.nlink !== after.nlink || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs) {
    throw new Error(`${label} changed during recovery validation`);
  }
  return value;
}

function parseCanonicalWindowsJobControl(raw, controlDirectory) {
  let record;
  try {
    record = JSON.parse(raw.toString('utf8'));
  } catch (cause) {
    throw new Error('Windows Job control record is not JSON', { cause });
  }
  if (!record || typeof record !== 'object' || Array.isArray(record)
      || !/^[a-f0-9]{64}$/u.test(record.controlToken ?? '')
      || !/^[a-f0-9]{64}$/u.test(record.proofToken ?? '')) {
    throw new Error('Windows Job control record is invalid');
  }
  const expected = {
    controlProtocol: WINDOWS_JOB_CONTROL_PROTOCOL,
    controlToken: record.controlToken,
    killRequestPath: path.join(controlDirectory, 'kill.request'),
    proofPath: path.join(controlDirectory, 'job-empty.proof'),
    proofProtocol: WINDOWS_JOB_EMPTY_PROTOCOL,
    proofToken: record.proofToken,
    termRequestPath: path.join(controlDirectory, 'term.request'),
  };
  if (raw.toString('utf8') !== `${JSON.stringify(expected)}\n`) {
    throw new Error('Windows Job control record is not exact or path-bound');
  }
  return Object.freeze(expected);
}

function windowsJobFileManifest(names, records, identities) {
  return Object.freeze(names.map((name) => {
    const value = records.get(name);
    return Object.freeze({
      identity: identities.get(name),
      name,
      sha256: createHash('sha256').update(value).digest('hex'),
      size: value.length,
    });
  }));
}

function windowsJobManifestHash(files) {
  return createHash('sha256').update(JSON.stringify(files), 'utf8').digest('hex');
}

function validateWindowsJobControlDirectory(directory, controlDirectory) {
  const identity = exactWindowsJobDirectoryIdentity(directory);
  if (!identity) throw new Error('Windows Job control directory is missing');
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  const allowedNames = new Set([
    'control.json', 'job-empty.proof', 'kill.request', 'term.request',
  ]);
  const names = entries.map(({ name }) => name).sort();
  if (!names.includes('control.json') || !names.includes('job-empty.proof')
      || names.length > allowedNames.size || names.some((name) => !allowedNames.has(name))) {
    throw new Error('Windows Job control directory contains unproven residue');
  }
  const records = new Map();
  const identities = new Map();
  for (const name of names) {
    const file = path.join(directory, name);
    const before = windowsJobFileIdentity(file);
    records.set(name, readBoundedWindowsJobFile(file, `Windows Job ${name}`));
    const after = windowsJobFileIdentity(file);
    if (!sameWindowsJobDirectoryIdentity(before, after)) {
      throw new Error(`Windows Job ${name} identity changed during manifest capture`);
    }
    identities.set(name, after);
  }
  const specification = parseCanonicalWindowsJobControl(
    records.get('control.json'), controlDirectory,
  );
  if (records.get('job-empty.proof').toString('utf8')
      !== windowsJobProofValue(specification.proofToken)) {
    throw new Error('Windows Job empty proof did not match its private token');
  }
  for (const [name, signal] of [['kill.request', 'SIGKILL'], ['term.request', 'SIGTERM']]) {
    if (records.has(name) && records.get(name).toString('utf8')
        !== windowsJobRequestValue(signal, specification.controlToken)) {
      throw new Error(`Windows Job ${name} did not match its private token`);
    }
  }
  const after = exactWindowsJobDirectoryIdentity(directory);
  if (!sameWindowsJobDirectoryIdentity(identity, after)) {
    throw new Error('Windows Job control directory changed during recovery validation');
  }
  const files = windowsJobFileManifest(names, records, identities);
  return Object.freeze({
    directoryIdentity: identity,
    files,
    proofToken: specification.proofToken,
    snapshotHash: windowsJobManifestHash(files),
  });
}

function canonicalWindowsJobFileManifest(files) {
  const allowedNames = new Set([
    'control.json', 'job-empty.proof', 'kill.request', 'term.request',
  ]);
  if (!Array.isArray(files) || files.length < 2 || files.length > allowedNames.size) {
    throw new Error('Windows Job retirement file manifest is invalid');
  }
  const canonical = files.map((file) => {
    const identity = file?.identity;
    if (!file || typeof file !== 'object' || Array.isArray(file)
        || !identity || typeof identity !== 'object' || Array.isArray(identity)
        || !/^\d+$/u.test(identity.birthtimeNs ?? '')
        || !/^\d+$/u.test(identity.dev ?? '') || !/^\d+$/u.test(identity.ino ?? '')
        || !allowedNames.has(file.name)
        || !Number.isSafeInteger(file.size) || file.size < 0
        || file.size > WINDOWS_JOB_RECOVERY_FILE_LIMIT
        || !/^[a-f0-9]{64}$/u.test(file.sha256 ?? '')) {
      throw new Error('Windows Job retirement file manifest is invalid');
    }
    return Object.freeze({
      identity: Object.freeze({
        birthtimeNs: identity.birthtimeNs,
        dev: identity.dev,
        ino: identity.ino,
      }),
      name: file.name,
      sha256: file.sha256,
      size: file.size,
    });
  });
  const names = canonical.map(({ name }) => name);
  if (!names.includes('control.json') || !names.includes('job-empty.proof')
      || names.some((name, index) => index > 0 && names[index - 1] >= name)) {
    throw new Error('Windows Job retirement file manifest is not exact');
  }
  return Object.freeze(canonical);
}

function windowsJobRetirementFileName(file, index) {
  const nameHash = createHash('sha256').update(file.name, 'utf8').digest('hex').slice(0, 16);
  return `.sealed-delete-${String(index).padStart(2, '0')}-${nameHash}`;
}

function validateWindowsJobRetiredFile(file, expected, options) {
  const before = windowsJobFileIdentity(file, options);
  if (expected.identity && !sameWindowsJobDirectoryIdentity(before, expected.identity)) {
    throw new Error(`Windows Job retired ${expected.name} identity changed after sealing`);
  }
  const value = readBoundedWindowsJobFile(
    file, `Windows Job retired ${expected.name}`, options,
  );
  const after = windowsJobFileIdentity(file, options);
  if (!sameWindowsJobDirectoryIdentity(before, after)) {
    throw new Error(`Windows Job retired ${expected.name} identity changed during validation`);
  }
  if (value.length !== expected.size
      || createHash('sha256').update(value).digest('hex') !== expected.sha256) {
    throw new Error(`Windows Job retired ${expected.name} changed after sealing`);
  }
}

function windowsJobFileIdentity(file, { allowedLinkCounts = [1n] } = {}) {
  const stat = lstatIfPresent(file, { bigint: true });
  if (!stat || !stat.isFile() || stat.isSymbolicLink()
      || !allowedLinkCounts.includes(stat.nlink)) {
    throw new Error('Windows Job retired file identity is unsafe');
  }
  return Object.freeze({
    birthtimeNs: String(stat.birthtimeNs),
    dev: String(stat.dev),
    ino: String(stat.ino),
  });
}

function captureWindowsJobPrivateGeneration(directory, controlDirectory) {
  const directoryIdentity = exactWindowsJobDirectoryIdentity(directory);
  if (!directoryIdentity) throw new Error('Windows Job private generation is missing');
  const names = fs.readdirSync(directory).sort();
  if (names.length !== 1 || names[0] !== 'control.json') {
    throw new Error('Windows Job private generation contains foreign residue');
  }
  const controlFile = path.join(directory, 'control.json');
  const before = windowsJobFileIdentity(controlFile);
  const value = readBoundedWindowsJobFile(
    controlFile, 'Windows Job private control.json',
  );
  const specification = parseCanonicalWindowsJobControl(value, controlDirectory);
  const after = windowsJobFileIdentity(controlFile);
  const finalDirectoryIdentity = exactWindowsJobDirectoryIdentity(directory);
  if (!sameWindowsJobDirectoryIdentity(before, after)
      || !sameWindowsJobDirectoryIdentity(directoryIdentity, finalDirectoryIdentity)) {
    throw new Error('Windows Job private generation changed during capture');
  }
  return Object.freeze({
    files: Object.freeze([Object.freeze({
      identity: after,
      name: 'control.json',
      sha256: createHash('sha256').update(value).digest('hex'),
      size: value.length,
    })]),
    directoryIdentity,
    proofToken: specification.proofToken,
  });
}

function captureWindowsJobSettledGeneration(directory, generation) {
  const settled = validateWindowsJobControlDirectory(directory, directory);
  if (!sameWindowsJobDirectoryIdentity(
    settled.directoryIdentity, generation.directoryIdentity,
  ) || settled.proofToken !== generation.proofToken) {
    throw new Error('Windows Job settled generation does not match its private publication');
  }
  const expectedControl = generation.files.find(({ name }) => name === 'control.json');
  const settledControl = settled.files.find(({ name }) => name === 'control.json');
  if (!expectedControl || !settledControl
      || expectedControl.sha256 !== settledControl.sha256
      || expectedControl.size !== settledControl.size
      || !sameWindowsJobDirectoryIdentity(expectedControl.identity, settledControl.identity)) {
    throw new Error('Windows Job settled control record changed after publication');
  }
  return settled;
}

function removeWindowsJobPrivateGeneration(directory, generation, {
  windowsCleanupNow = WINDOWS_JOB_MONOTONIC_NOW,
  windowsCleanupTimeoutMs = WINDOWS_JOB_DELETE_TIMEOUT_MS,
} = {}) {
  const observedDirectory = exactWindowsJobDirectoryIdentity(directory);
  if (!observedDirectory) return false;
  if (!sameWindowsJobDirectoryIdentity(observedDirectory, generation.directoryIdentity)) {
    throw new Error('Windows Job private generation path was replaced before cleanup');
  }
  const paths = Object.freeze({
    controlRoot: path.dirname(directory),
    retirementDirectory: directory,
  });
  const record = Object.freeze({
    directoryIdentity: generation.directoryIdentity,
    files: generation.files,
  });
  validateWindowsJobRetirementResidue(directory, record);
  const pairs = removeWindowsJobRetirementContents(paths, record, {
    removeRetirementFile: fs.unlinkSync,
  });
  if (process.platform === 'win32') {
    const cleanupBudget = createWindowsJobCleanupBudget(windowsCleanupTimeoutMs, {
      monotonicNow: windowsCleanupNow,
    });
    runWindowsJobDeletionBatch({
      cleanupBudget,
      directory: Object.freeze({
        expectedBirthtimeNs: generation.directoryIdentity.birthtimeNs,
        expectedFileIndex: generation.directoryIdentity.ino,
        expectedVolumeSerial: generation.directoryIdentity.dev,
        path: directory,
      }),
      pairs,
    });
  }
  syncWindowsJobRoot(path.dirname(directory));
  if (exactWindowsJobDirectoryIdentity(directory)) {
    throw new Error('Windows Job private generation cleanup left a directory replacement');
  }
  return true;
}

function deleteWindowsJobHardLinks({
  beforeCommit,
  beforeNativeOpen,
  counterpart,
  deleteCounterpart,
  deleteSource,
  expected,
  identity,
  source,
}) {
  const linkOptions = { allowedLinkCounts: [2n] };
  const validatePair = () => {
    const sourceIdentity = windowsJobFileIdentity(source, linkOptions);
    const counterpartIdentity = windowsJobFileIdentity(counterpart, linkOptions);
    if (!sameWindowsJobDirectoryIdentity(identity, sourceIdentity)
        || !sameWindowsJobDirectoryIdentity(identity, counterpartIdentity)) {
      throw new Error('Windows Job deletion hard-link identity changed');
    }
    validateWindowsJobRetiredFile(source, expected, linkOptions);
    validateWindowsJobRetiredFile(counterpart, expected, linkOptions);
  };
  validatePair();
  beforeCommit?.({ counterpart, expected, source });
  validatePair();
  if (process.platform === 'win32') {
    throw new Error('Windows Job native hard links require one retirement batch');
  }
  beforeNativeOpen?.({ counterpart, expected, source });
  validatePair();
  if (deleteSource) fs.unlinkSync(source);
  if (deleteCounterpart) fs.unlinkSync(counterpart);
  for (const [file, deleted] of [
    [source, deleteSource], [counterpart, deleteCounterpart],
  ]) {
    if (deleted && lstatIfPresent(file, { bigint: true })) {
      throw new Error('Windows Job late replacement survived identity-bound deletion');
    }
  }
}

function windowsJobDeletionPair({
  counterpart,
  deleteCounterpartAfterDirectory = false,
  deleteCounterpartBeforeDirectory = false,
  deleteSourceAfterDirectory = false,
  deleteSourceBeforeDirectory = false,
  expected,
  identity,
  source,
}) {
  return Object.freeze({
    deleteFirstAfterDirectory: deleteSourceAfterDirectory,
    deleteFirstBeforeDirectory: deleteSourceBeforeDirectory,
    deleteSecondAfterDirectory: deleteCounterpartAfterDirectory,
    deleteSecondBeforeDirectory: deleteCounterpartBeforeDirectory,
    expectedBirthtimeNs: identity.birthtimeNs,
    expectedFileIndex: identity.ino,
    expectedLinks: 2,
    expectedSha256: expected.sha256,
    expectedSize: expected.size,
    expectedVolumeSerial: identity.dev,
    firstPath: source,
    secondPath: counterpart,
  });
}

function runWindowsJobDeletionBatch({ cleanupBudget, directory, pairs }) {
  if (typeof cleanupBudget?.remainingMilliseconds !== 'function'
      || !Array.isArray(pairs) || (pairs.length === 0 && !directory)) {
    throw new Error('Windows Job native deletion batch is invalid');
  }
  const remaining = cleanupBudget.remainingMilliseconds();
  const specification = Object.freeze({
    pairs: Object.freeze(pairs.map((pair) => Object.freeze({ ...pair }))),
    directory: directory ? Object.freeze({ ...directory }) : null,
    protocol: WINDOWS_JOB_DELETE_PROTOCOL,
  });
  const encoded = Buffer.from(JSON.stringify(specification), 'utf8').toString('base64');
  if (Buffer.byteLength(encoded, 'ascii') > WINDOWS_JOB_DELETE_PAYLOAD_LIMIT) {
    throw new Error('Windows Job native deletion batch is too large');
  }
  const result = spawnSync('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', WINDOWS_JOB_SCRIPT, '-DeletePayload', encoded,
  ], {
    cwd: WINDOWS_JOB_DIRECTORY,
    encoding: 'utf8',
    env: windowsNativeHelperEnvironment(),
    killSignal: 'SIGKILL',
    maxBuffer: WINDOWS_JOB_RECOVERY_FILE_LIMIT,
    shell: false,
    timeout: remaining,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    const failure = new Error('Windows Job identity-bound deletion batch failed');
    failure.code = result.error?.code === 'ETIMEDOUT'
      ? 'WINDOWS_JOB_NATIVE_DELETE_TIMEOUT'
      : 'WINDOWS_JOB_NATIVE_DELETE_FAILED';
    throw failure;
  }
}

function runWindowsJobRequestPublication({ active, paths, requestPath, signal }) {
  const specification = Object.freeze({
    directory: Object.freeze({
      expectedBirthtimeNs: active.directoryIdentity.birthtimeNs,
      expectedFileIndex: active.directoryIdentity.ino,
      expectedVolumeSerial: active.directoryIdentity.dev,
      path: paths.controlDirectory,
    }),
    protocol: WINDOWS_JOB_REQUEST_PUBLICATION_PROTOCOL,
    requestPath,
    signal,
    token: active.controlToken,
  });
  const encoded = Buffer.from(JSON.stringify(specification), 'utf8').toString('base64');
  if (Buffer.byteLength(encoded, 'ascii') > WINDOWS_JOB_DELETE_PAYLOAD_LIMIT) {
    throw new Error('Windows Job native request publication is too large');
  }
  const result = spawnSync('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', WINDOWS_JOB_SCRIPT, '-RequestPayload', encoded,
  ], {
    cwd: WINDOWS_JOB_DIRECTORY,
    encoding: 'utf8',
    env: windowsNativeHelperEnvironment(),
    killSignal: 'SIGKILL',
    maxBuffer: WINDOWS_JOB_RECOVERY_FILE_LIMIT,
    shell: false,
    timeout: WINDOWS_JOB_REQUEST_PUBLICATION_TIMEOUT_MS,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    const failure = new Error('Windows Job identity-bound request publication failed');
    failure.code = result.error?.code === 'ETIMEDOUT'
      ? 'WINDOWS_JOB_NATIVE_REQUEST_TIMEOUT'
      : 'WINDOWS_JOB_NATIVE_REQUEST_FAILED';
    throw failure;
  }
}

function validateWindowsJobRetirementResidue(directory, record) {
  const identity = exactWindowsJobDirectoryIdentity(directory);
  if (!sameWindowsJobDirectoryIdentity(identity, record.directoryIdentity)) {
    throw new Error('Windows Job retirement proof does not own the quarantined directory');
  }
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  const names = entries.map(({ name }) => name).sort();
  const expectedFiles = new Map();
  for (const [index, file] of record.files.entries()) {
    expectedFiles.set(file.name, { file, index });
    expectedFiles.set(windowsJobRetirementFileName(file, index), { file, index });
  }
  if (names.length > record.files.length * 2
      || names.some((name) => !expectedFiles.has(name))) {
    throw new Error('Windows Job retirement quarantine contains unsealed residue');
  }
  const observations = new Map();
  for (const name of names) {
    const expected = expectedFiles.get(name);
    const observed = observations.get(expected.index) ?? [];
    observed.push({ name, ...expected });
    observations.set(expected.index, observed);
  }
  for (const observed of observations.values()) {
    if (observed.length === 1) {
      validateWindowsJobRetiredFile(
        path.join(directory, observed[0].name), observed[0].file,
      );
      continue;
    }
    if (observed.length !== 2
        || !observed.some(({ name, file }) => name === file.name)
        || !observed.some(({ name, file, index }) => name
          === windowsJobRetirementFileName(file, index))) {
      throw new Error('Windows Job retirement file has invalid sealed representations');
    }
    const [left, right] = observed;
    const leftPath = path.join(directory, left.name);
    const rightPath = path.join(directory, right.name);
    const linkOptions = { allowedLinkCounts: [2n] };
    const leftIdentity = windowsJobFileIdentity(leftPath, linkOptions);
    const rightIdentity = windowsJobFileIdentity(rightPath, linkOptions);
    if (!sameWindowsJobDirectoryIdentity(leftIdentity, rightIdentity)) {
      throw new Error('Windows Job retirement hard-link handoff identity is invalid');
    }
    validateWindowsJobRetiredFile(leftPath, left.file, linkOptions);
    validateWindowsJobRetiredFile(rightPath, right.file, linkOptions);
  }
  const after = exactWindowsJobDirectoryIdentity(directory);
  if (!sameWindowsJobDirectoryIdentity(identity, after)) {
    throw new Error('Windows Job retirement quarantine changed during validation');
  }
}

function removeWindowsJobRetirementContents(paths, record, {
  afterRetirementDirectoryRemove,
  afterRetirementFileLink,
  beforeRetirementDirectoryRemove,
  beforeRetirementFileLink,
  beforeRetirementSourceDeleteOpen,
  beforeRetirementSourceUnlink,
  removeRetirementFile,
}) {
  const nativePairs = [];
  for (const [index, file] of record.files.entries()) {
    const source = path.join(paths.retirementDirectory, file.name);
    const deletion = path.join(
      paths.retirementDirectory, windowsJobRetirementFileName(file, index),
    );
    const sourcePresent = lstatIfPresent(source, { bigint: true }) !== null;
    const deletionPresent = lstatIfPresent(deletion, { bigint: true }) !== null;
    if (!sourcePresent && !deletionPresent) continue;
    let identity;
    let linkedNow = false;
    if (sourcePresent && deletionPresent) {
      const linkOptions = { allowedLinkCounts: [2n] };
      const sourceIdentity = windowsJobFileIdentity(source, linkOptions);
      const deletionIdentity = windowsJobFileIdentity(deletion, linkOptions);
      if (!sameWindowsJobDirectoryIdentity(sourceIdentity, deletionIdentity)) {
        throw new Error('Windows Job retirement hard-link handoff identity is invalid');
      }
      validateWindowsJobRetiredFile(source, file, linkOptions);
      validateWindowsJobRetiredFile(deletion, file, linkOptions);
      identity = sourceIdentity;
    } else if (sourcePresent) {
      identity = windowsJobFileIdentity(source);
      validateWindowsJobRetiredFile(source, file);
      beforeRetirementFileLink?.({ deletion, file, source });
      fs.linkSync(source, deletion);
      const linkOptions = { allowedLinkCounts: [2n] };
      const linkedSourceIdentity = windowsJobFileIdentity(source, linkOptions);
      const linkedDeletionIdentity = windowsJobFileIdentity(deletion, linkOptions);
      if (!sameWindowsJobDirectoryIdentity(identity, linkedSourceIdentity)
          || !sameWindowsJobDirectoryIdentity(identity, linkedDeletionIdentity)) {
        throw new Error(`Windows Job retired ${file.name} identity changed during link handoff`);
      }
      validateWindowsJobRetiredFile(source, file, linkOptions);
      validateWindowsJobRetiredFile(deletion, file, linkOptions);
      syncWindowsJobRoot(paths.retirementDirectory);
      linkedNow = true;
      afterRetirementFileLink?.({ deletion, file, source });
      const committedSourceIdentity = windowsJobFileIdentity(source, linkOptions);
      const committedDeletionIdentity = windowsJobFileIdentity(deletion, linkOptions);
      if (!sameWindowsJobDirectoryIdentity(identity, committedSourceIdentity)
          || !sameWindowsJobDirectoryIdentity(identity, committedDeletionIdentity)) {
        throw new Error(`Windows Job retired ${file.name} identity changed before unlink`);
      }
      validateWindowsJobRetiredFile(source, file, linkOptions);
      validateWindowsJobRetiredFile(deletion, file, linkOptions);
    } else if (deletionPresent) {
      validateWindowsJobRetiredFile(deletion, file);
      identity = windowsJobFileIdentity(deletion);
      beforeRetirementFileLink?.({ deletion: source, file, source: deletion });
      fs.linkSync(deletion, source);
      const linkOptions = { allowedLinkCounts: [2n] };
      const sourceIdentity = windowsJobFileIdentity(source, linkOptions);
      const deletionIdentity = windowsJobFileIdentity(deletion, linkOptions);
      if (!sameWindowsJobDirectoryIdentity(identity, sourceIdentity)
          || !sameWindowsJobDirectoryIdentity(identity, deletionIdentity)) {
        throw new Error(`Windows Job retired ${file.name} identity changed during pair recovery`);
      }
      validateWindowsJobRetiredFile(source, file, linkOptions);
      validateWindowsJobRetiredFile(deletion, file, linkOptions);
      syncWindowsJobRoot(paths.retirementDirectory);
    }
    if (removeRetirementFile !== fs.unlinkSync) {
      removeRetirementFile(deletion);
      if (!lstatIfPresent(deletion, { bigint: true })) {
        fs.linkSync(source, deletion);
        syncWindowsJobRoot(paths.retirementDirectory);
      }
    }
    if (process.platform === 'win32') {
      beforeRetirementSourceUnlink?.({ counterpart: deletion, expected: file, source });
      beforeRetirementSourceDeleteOpen?.({ counterpart: deletion, expected: file, source });
      const linkOptions = { allowedLinkCounts: [2n] };
      const sourceIdentity = windowsJobFileIdentity(source, linkOptions);
      const deletionIdentity = windowsJobFileIdentity(deletion, linkOptions);
      if (!sameWindowsJobDirectoryIdentity(identity, sourceIdentity)
          || !sameWindowsJobDirectoryIdentity(identity, deletionIdentity)) {
        throw new Error(`Windows Job retired ${file.name} identity changed before native batch`);
      }
      validateWindowsJobRetiredFile(source, file, linkOptions);
      validateWindowsJobRetiredFile(deletion, file, linkOptions);
      nativePairs.push(windowsJobDeletionPair({
        counterpart: deletion,
        deleteCounterpartBeforeDirectory: true,
        deleteSourceBeforeDirectory: true,
        expected: file,
        identity,
        source,
      }));
      continue;
    }
    deleteWindowsJobHardLinks({
      beforeCommit: beforeRetirementSourceUnlink,
      beforeNativeOpen: beforeRetirementSourceDeleteOpen,
      counterpart: deletion,
      deleteCounterpart: true,
      deleteSource: true,
      expected: file,
      identity,
      source,
    });
    if (linkedNow) syncWindowsJobRoot(paths.retirementDirectory);
    syncWindowsJobRoot(paths.retirementDirectory);
  }
  if (process.platform === 'win32') return Object.freeze(nativePairs);
  beforeRetirementDirectoryRemove?.(paths.retirementDirectory);
  fs.rmdirSync(paths.retirementDirectory);
  syncWindowsJobRoot(paths.controlRoot);
  afterRetirementDirectoryRemove?.(paths.retirementDirectory);
  return Object.freeze([]);
}

function windowsJobRetirementRecord(paths, capture) {
  return Object.freeze({
    controlDirectory: paths.controlDirectory,
    controlKeyHash: paths.controlKeyHash,
    directoryIdentity: capture.directoryIdentity,
    files: capture.files,
    proofToken: capture.proofToken,
    protocol: WINDOWS_JOB_RETIREMENT_PROTOCOL,
    retirementDirectory: paths.retirementDirectory,
    snapshotHash: capture.snapshotHash,
  });
}

function retirementRecordValue(record) {
  return `${JSON.stringify(record)}\n`;
}

function windowsJobRetirementProofFile(record) {
  const value = Buffer.from(retirementRecordValue(record), 'utf8');
  return Object.freeze({
    name: 'retirement proof',
    sha256: createHash('sha256').update(value).digest('hex'),
    size: value.length,
  });
}

function readWindowsJobRetirementRecord(paths, {
  allowedLinkCounts = [1n],
  file = paths.retirementProof,
  label = 'Windows Job retirement proof',
} = {}) {
  const raw = readBoundedWindowsJobFile(
    file, label, { allowedLinkCounts },
  );
  let record;
  try {
    record = JSON.parse(raw.toString('utf8'));
  } catch (cause) {
    throw new Error('Windows Job retirement proof is not JSON', { cause });
  }
  const identity = record?.directoryIdentity;
  const files = canonicalWindowsJobFileManifest(record?.files);
  if (!identity || !/^\d+$/u.test(identity.birthtimeNs ?? '')
      || !/^\d+$/u.test(identity.dev ?? '') || !/^\d+$/u.test(identity.ino ?? '')
      || !/^[a-f0-9]{64}$/u.test(record.proofToken ?? '')
      || !/^[a-f0-9]{64}$/u.test(record.snapshotHash ?? '')
      || record.snapshotHash !== windowsJobManifestHash(files)) {
    throw new Error('Windows Job retirement proof is invalid');
  }
  const expected = windowsJobRetirementRecord(paths, {
    directoryIdentity: Object.freeze({
      birthtimeNs: identity.birthtimeNs,
      dev: identity.dev,
      ino: identity.ino,
    }),
    files,
    proofToken: record.proofToken,
    snapshotHash: record.snapshotHash,
  });
  if (raw.toString('utf8') !== retirementRecordValue(expected)) {
    throw new Error('Windows Job retirement proof is not exact or scope-bound');
  }
  return expected;
}

function assertWindowsJobRecoveryProofToken(record, proofToken) {
  if (proofToken !== undefined && record.proofToken !== proofToken) {
    throw new Error('Windows Job recovery authority does not own this controller generation');
  }
}

function readWindowsJobRetirementPublication(paths) {
  const pendingPresent = lstatIfPresent(paths.retirementPending, { bigint: true }) !== null;
  const proofPresent = lstatIfPresent(paths.retirementProof, { bigint: true }) !== null;
  if (!pendingPresent && !proofPresent) return null;
  if (pendingPresent && proofPresent) {
    const linkOptions = { allowedLinkCounts: [2n] };
    const pendingIdentity = windowsJobFileIdentity(paths.retirementPending, linkOptions);
    const proofIdentity = windowsJobFileIdentity(paths.retirementProof, linkOptions);
    if (!sameWindowsJobDirectoryIdentity(pendingIdentity, proofIdentity)) {
      throw new Error('Windows Job retirement proof hard-link publication is invalid');
    }
    const pending = readWindowsJobRetirementRecord(paths, {
      ...linkOptions,
      file: paths.retirementPending,
      label: 'Windows Job pending retirement proof',
    });
    const proof = readWindowsJobRetirementRecord(paths, linkOptions);
    if (retirementRecordValue(pending) !== retirementRecordValue(proof)) {
      throw new Error('Windows Job retirement proof hard links do not match');
    }
    return proof;
  }
  if (proofPresent) return readWindowsJobRetirementRecord(paths);
  return readWindowsJobRetirementRecord(paths, {
    file: paths.retirementPending,
    label: 'Windows Job pending retirement proof',
  });
}

function assertWindowsJobRetirementRecord(record, expected, label) {
  if (retirementRecordValue(record) !== retirementRecordValue(expected)) {
    throw new Error(`${label} does not match the quarantined control`);
  }
}

function unlinkWindowsJobRetirementHardLink(paths, {
  beforeUnlink,
  beforeUnlinkCommit,
  counterpart,
  counterpartLabel,
  record,
  source,
  sourceLabel,
}) {
  const linkOptions = { allowedLinkCounts: [2n] };
  let identity;
  const validatePair = () => {
    const sourceIdentity = windowsJobFileIdentity(source, linkOptions);
    const counterpartIdentity = windowsJobFileIdentity(counterpart, linkOptions);
    if (!sameWindowsJobDirectoryIdentity(sourceIdentity, counterpartIdentity)) {
      throw new Error(`${sourceLabel} hard-link retirement identity is invalid`);
    }
    identity ??= sourceIdentity;
    if (!sameWindowsJobDirectoryIdentity(identity, sourceIdentity)) {
      throw new Error(`${sourceLabel} hard-link retirement identity changed`);
    }
    assertWindowsJobRetirementRecord(readWindowsJobRetirementRecord(paths, {
      ...linkOptions,
      file: source,
      label: sourceLabel,
    }), record, sourceLabel);
    assertWindowsJobRetirementRecord(readWindowsJobRetirementRecord(paths, {
      ...linkOptions,
      file: counterpart,
      label: counterpartLabel,
    }), record, counterpartLabel);
  };
  validatePair();
  beforeUnlink?.({ counterpart, record, source });
  validatePair();
  deleteWindowsJobHardLinks({
    beforeCommit: beforeUnlinkCommit,
    counterpart,
    deleteCounterpart: false,
    deleteSource: true,
    expected: windowsJobRetirementProofFile(record),
    identity,
    source,
  });
  syncWindowsJobRoot(paths.controlRoot);
  assertWindowsJobRetirementRecord(readWindowsJobRetirementRecord(paths, {
    file: counterpart,
    label: counterpartLabel,
  }), record, counterpartLabel);
}

function readWindowsJobRetirementProofCleanup(paths) {
  const deletionPresent = lstatIfPresent(paths.retirementProofDeletion, {
    bigint: true,
  }) !== null;
  const proofPresent = lstatIfPresent(paths.retirementProof, { bigint: true }) !== null;
  if (!deletionPresent && !proofPresent) return null;
  if (deletionPresent && proofPresent) {
    const linkOptions = { allowedLinkCounts: [2n] };
    const deletionIdentity = windowsJobFileIdentity(
      paths.retirementProofDeletion, linkOptions,
    );
    const proofIdentity = windowsJobFileIdentity(paths.retirementProof, linkOptions);
    if (!sameWindowsJobDirectoryIdentity(deletionIdentity, proofIdentity)) {
      throw new Error('Windows Job retirement proof deletion handoff is invalid');
    }
    const deletion = readWindowsJobRetirementRecord(paths, {
      ...linkOptions,
      file: paths.retirementProofDeletion,
      label: 'Windows Job sealed deletion proof',
    });
    const proof = readWindowsJobRetirementRecord(paths, linkOptions);
    assertWindowsJobRetirementRecord(
      deletion, proof, 'Windows Job sealed deletion proof',
    );
    return proof;
  }
  if (proofPresent) return readWindowsJobRetirementRecord(paths);
  return readWindowsJobRetirementRecord(paths, {
    file: paths.retirementProofDeletion,
    label: 'Windows Job sealed deletion proof',
  });
}

function prepareWindowsJobRetirementProofPair(paths, record, {
  beforeRetirementPendingUnlink,
  beforeRetirementPendingUnlinkCommit,
  beforeRetirementProofDeleteCommit,
  beforeRetirementProofDeleteLink,
  beforeRetirementProofUnlink,
  deleteCounterpartAfterDirectory = false,
  deleteCounterpartBeforeDirectory = false,
  deleteSourceAfterDirectory = false,
  deleteSourceBeforeDirectory = false,
} = {}) {
  const pendingPresent = lstatIfPresent(paths.retirementPending, { bigint: true }) !== null;
  const proofPresent = lstatIfPresent(paths.retirementProof, { bigint: true }) !== null;
  const deletionPresent = lstatIfPresent(paths.retirementProofDeletion, {
    bigint: true,
  }) !== null;
  if (pendingPresent && deletionPresent) {
    throw new Error('Windows Job retirement proof cleanup states overlap');
  }
  if (pendingPresent && !proofPresent) {
    throw new Error('Windows Job pending retirement proof is not durably linked');
  }
  if (!pendingPresent && !proofPresent && !deletionPresent) return null;

  let source;
  let counterpart;
  if (pendingPresent) {
    source = paths.retirementPending;
    counterpart = paths.retirementProof;
    const publication = readWindowsJobRetirementPublication(paths);
    assertWindowsJobRetirementRecord(
      publication, record, 'Windows Job retirement proof publication',
    );
    beforeRetirementPendingUnlink?.({ counterpart, record, source });
    beforeRetirementPendingUnlinkCommit?.({
      counterpart, expected: windowsJobRetirementProofFile(record), source,
    });
  } else {
    let existing = readWindowsJobRetirementProofCleanup(paths);
    assertWindowsJobRetirementRecord(existing, record, 'Windows Job retirement proof');
    if (!proofPresent) {
      const identity = windowsJobFileIdentity(paths.retirementProofDeletion);
      fs.linkSync(paths.retirementProofDeletion, paths.retirementProof);
      const linkOptions = { allowedLinkCounts: [2n] };
      if (!sameWindowsJobDirectoryIdentity(
        identity, windowsJobFileIdentity(paths.retirementProof, linkOptions),
      )) throw new Error('Windows Job sealed proof identity changed during pair recovery');
      syncWindowsJobRoot(paths.controlRoot);
    } else if (!deletionPresent) {
      const identity = windowsJobFileIdentity(paths.retirementProof);
      beforeRetirementProofDeleteLink?.({
        deletion: paths.retirementProofDeletion,
        proof: paths.retirementProof,
        record,
      });
      fs.linkSync(paths.retirementProof, paths.retirementProofDeletion);
      const linkOptions = { allowedLinkCounts: [2n] };
      if (!sameWindowsJobDirectoryIdentity(
        identity, windowsJobFileIdentity(paths.retirementProofDeletion, linkOptions),
      )) throw new Error('Windows Job retirement proof identity changed during deletion handoff');
      syncWindowsJobRoot(paths.controlRoot);
    }
    existing = readWindowsJobRetirementProofCleanup(paths);
    assertWindowsJobRetirementRecord(existing, record, 'Windows Job retirement proof');
    source = paths.retirementProof;
    counterpart = paths.retirementProofDeletion;
  }

  beforeRetirementProofUnlink?.({ counterpart, record, source });
  beforeRetirementProofDeleteCommit?.({
    deletion: counterpart,
    proof: paths.retirementProof,
    record,
  });
  const linkOptions = { allowedLinkCounts: [2n] };
  const sourceIdentity = windowsJobFileIdentity(source, linkOptions);
  const counterpartIdentity = windowsJobFileIdentity(counterpart, linkOptions);
  if (!sameWindowsJobDirectoryIdentity(sourceIdentity, counterpartIdentity)) {
    throw new Error('Windows Job retirement proof deletion pair is invalid');
  }
  assertWindowsJobRetirementRecord(readWindowsJobRetirementRecord(paths, {
    ...linkOptions,
    file: source,
    label: 'Windows Job retirement proof source',
  }), record, 'Windows Job retirement proof source');
  assertWindowsJobRetirementRecord(readWindowsJobRetirementRecord(paths, {
    ...linkOptions,
    file: counterpart,
    label: 'Windows Job retirement proof counterpart',
  }), record, 'Windows Job retirement proof counterpart');
  return windowsJobDeletionPair({
    counterpart,
    deleteCounterpartAfterDirectory,
    deleteCounterpartBeforeDirectory,
    deleteSourceAfterDirectory,
    deleteSourceBeforeDirectory,
    expected: windowsJobRetirementProofFile(record),
    identity: sourceIdentity,
    source,
  });
}

function removeWindowsJobRetirementProof(paths, record, {
  beforeRetirementProofDeleteCommit,
  beforeRetirementProofDeleteLink,
  beforeRetirementProofUnlink,
  cleanupBudget,
} = {}) {
  if (process.platform === 'win32') {
    const pair = prepareWindowsJobRetirementProofPair(paths, record, {
      beforeRetirementProofDeleteCommit,
      beforeRetirementProofDeleteLink,
      beforeRetirementProofUnlink,
      deleteCounterpartBeforeDirectory: true,
      deleteSourceBeforeDirectory: true,
    });
    if (!pair) return;
    runWindowsJobDeletionBatch({ cleanupBudget, directory: null, pairs: [pair] });
    return;
  }
  let existing = readWindowsJobRetirementProofCleanup(paths);
  if (!existing) return;
  assertWindowsJobRetirementRecord(existing, record, 'Windows Job retirement proof');
  if (!lstatIfPresent(paths.retirementProofDeletion, { bigint: true })) {
    const identity = windowsJobFileIdentity(paths.retirementProof);
    beforeRetirementProofDeleteLink?.({
      deletion: paths.retirementProofDeletion,
      proof: paths.retirementProof,
      record,
    });
    fs.linkSync(paths.retirementProof, paths.retirementProofDeletion);
    const linkOptions = { allowedLinkCounts: [2n] };
    const proofIdentity = windowsJobFileIdentity(paths.retirementProof, linkOptions);
    const deletionIdentity = windowsJobFileIdentity(
      paths.retirementProofDeletion, linkOptions,
    );
    if (!sameWindowsJobDirectoryIdentity(identity, proofIdentity)
        || !sameWindowsJobDirectoryIdentity(identity, deletionIdentity)) {
      throw new Error('Windows Job retirement proof identity changed during deletion handoff');
    }
    existing = readWindowsJobRetirementProofCleanup(paths);
    assertWindowsJobRetirementRecord(existing, record, 'Windows Job retirement proof');
    syncWindowsJobRoot(paths.controlRoot);
  }
  if (!lstatIfPresent(paths.retirementProof, { bigint: true })) {
    const identity = windowsJobFileIdentity(paths.retirementProofDeletion);
    fs.linkSync(paths.retirementProofDeletion, paths.retirementProof);
    const linkOptions = { allowedLinkCounts: [2n] };
    const proofIdentity = windowsJobFileIdentity(paths.retirementProof, linkOptions);
    const deletionIdentity = windowsJobFileIdentity(
      paths.retirementProofDeletion, linkOptions,
    );
    if (!sameWindowsJobDirectoryIdentity(identity, proofIdentity)
        || !sameWindowsJobDirectoryIdentity(identity, deletionIdentity)) {
      throw new Error('Windows Job sealed proof identity changed during pair recovery');
    }
    syncWindowsJobRoot(paths.controlRoot);
  }
  const linkOptions = { allowedLinkCounts: [2n] };
  const proofIdentity = windowsJobFileIdentity(paths.retirementProof, linkOptions);
  const deletionIdentity = windowsJobFileIdentity(paths.retirementProofDeletion, linkOptions);
  if (!sameWindowsJobDirectoryIdentity(proofIdentity, deletionIdentity)) {
    throw new Error('Windows Job retirement proof deletion pair is invalid');
  }
  assertWindowsJobRetirementRecord(readWindowsJobRetirementRecord(paths, {
    ...linkOptions,
    file: paths.retirementProof,
    label: 'Windows Job retirement proof',
  }), record, 'Windows Job retirement proof');
  assertWindowsJobRetirementRecord(readWindowsJobRetirementRecord(paths, {
    ...linkOptions,
    file: paths.retirementProofDeletion,
    label: 'Windows Job sealed deletion proof',
  }), record, 'Windows Job sealed deletion proof');
  deleteWindowsJobHardLinks({
    beforeCommit: (files) => {
      beforeRetirementProofUnlink?.({
        counterpart: files.counterpart,
        record,
        source: files.source,
      });
      beforeRetirementProofDeleteCommit?.({
        deletion: files.counterpart,
        proof: files.source,
        record,
      });
    },
    counterpart: paths.retirementProofDeletion,
    deleteCounterpart: true,
    deleteSource: true,
    expected: windowsJobRetirementProofFile(record),
    identity: proofIdentity,
    source: paths.retirementProof,
  });
  syncWindowsJobRoot(paths.controlRoot);
}

function normalizeWindowsJobRetirementReceipt(paths, record, {
  beforeRetirementPendingUnlink,
  beforeRetirementPendingUnlinkCommit,
  beforeRetirementProofDeleteCommit,
  beforeRetirementProofDeleteLink,
  beforeRetirementProofUnlink,
  cleanupBudget,
} = {}) {
  let pendingPresent = lstatIfPresent(paths.retirementPending, { bigint: true }) !== null;
  let proofPresent = lstatIfPresent(paths.retirementProof, { bigint: true }) !== null;
  let deletionPresent = lstatIfPresent(paths.retirementProofDeletion, { bigint: true }) !== null;
  if (pendingPresent && deletionPresent) {
    throw new Error('Windows Job retirement receipt states overlap');
  }
  if (!proofPresent && pendingPresent) {
    publishWindowsJobRetirementRecord(paths, record, { deferPendingNormalization: true });
    proofPresent = true;
  }
  if (!proofPresent && deletionPresent) {
    const identity = windowsJobFileIdentity(paths.retirementProofDeletion);
    fs.linkSync(paths.retirementProofDeletion, paths.retirementProof);
    const linkOptions = { allowedLinkCounts: [2n] };
    if (!sameWindowsJobDirectoryIdentity(
      identity, windowsJobFileIdentity(paths.retirementProof, linkOptions),
    )) throw new Error('Windows Job completion receipt identity changed during recovery');
    syncWindowsJobRoot(paths.controlRoot);
    proofPresent = true;
  }
  if (!proofPresent) throw new Error('Windows Job completion receipt is missing');

  pendingPresent = lstatIfPresent(paths.retirementPending, { bigint: true }) !== null;
  deletionPresent = lstatIfPresent(paths.retirementProofDeletion, { bigint: true }) !== null;
  if (!pendingPresent && !deletionPresent) {
    assertWindowsJobRetirementRecord(
      readWindowsJobRetirementRecord(paths), record, 'Windows Job completion receipt',
    );
    return;
  }
  if (process.platform === 'win32') {
    const pair = prepareWindowsJobRetirementProofPair(paths, record, {
      beforeRetirementPendingUnlink,
      beforeRetirementPendingUnlinkCommit,
      beforeRetirementProofDeleteCommit,
      beforeRetirementProofDeleteLink,
      beforeRetirementProofUnlink,
      ...(pendingPresent
        ? { deleteSourceBeforeDirectory: true }
        : { deleteCounterpartBeforeDirectory: true }),
    });
    runWindowsJobDeletionBatch({ cleanupBudget, directory: null, pairs: [pair] });
  } else if (pendingPresent) {
    unlinkWindowsJobRetirementHardLink(paths, {
      beforeUnlink: beforeRetirementPendingUnlink,
      beforeUnlinkCommit: beforeRetirementPendingUnlinkCommit,
      counterpart: paths.retirementProof,
      counterpartLabel: 'Windows Job completion receipt',
      record,
      source: paths.retirementPending,
      sourceLabel: 'Windows Job pending retirement proof',
    });
  } else {
    const linkOptions = { allowedLinkCounts: [2n] };
    const proofIdentity = windowsJobFileIdentity(paths.retirementProof, linkOptions);
    const deletionIdentity = windowsJobFileIdentity(paths.retirementProofDeletion, linkOptions);
    if (!sameWindowsJobDirectoryIdentity(proofIdentity, deletionIdentity)) {
      throw new Error('Windows Job completion receipt cleanup pair is invalid');
    }
    deleteWindowsJobHardLinks({
      beforeCommit: (files) => {
        beforeRetirementProofUnlink?.({
          counterpart: files.counterpart, record, source: files.source,
        });
        beforeRetirementProofDeleteCommit?.({
          deletion: files.counterpart, proof: files.source, record,
        });
      },
      counterpart: paths.retirementProofDeletion,
      deleteCounterpart: true,
      deleteSource: false,
      expected: windowsJobRetirementProofFile(record),
      identity: proofIdentity,
      source: paths.retirementProof,
    });
    syncWindowsJobRoot(paths.controlRoot);
  }
  if (lstatIfPresent(paths.retirementPending, { bigint: true })
      || lstatIfPresent(paths.retirementProofDeletion, { bigint: true })) {
    throw new Error('Windows Job completion receipt normalization left residue');
  }
  assertWindowsJobRetirementRecord(
    readWindowsJobRetirementRecord(paths), record, 'Windows Job completion receipt',
  );
}

function removeWindowsJobNativeRetirement(paths, record, contentPairs, {
  afterRetirementDirectoryRemove,
  beforeRetirementDirectoryRemove,
  beforeRetirementPendingUnlink,
  beforeRetirementPendingUnlinkCommit,
  beforeRetirementProofDeleteCommit,
  beforeRetirementProofDeleteLink,
  beforeRetirementProofUnlink,
  cleanupBudget,
}) {
  const retainProofForHook = typeof afterRetirementDirectoryRemove === 'function';
  const pendingPresent = lstatIfPresent(paths.retirementPending, { bigint: true }) !== null;
  const proofPair = prepareWindowsJobRetirementProofPair(paths, record, {
    beforeRetirementPendingUnlink,
    beforeRetirementPendingUnlinkCommit,
    beforeRetirementProofDeleteCommit,
    beforeRetirementProofDeleteLink,
    beforeRetirementProofUnlink,
    ...(pendingPresent
      ? (retainProofForHook
        ? { deleteSourceBeforeDirectory: true }
        : { deleteSourceAfterDirectory: true })
      : (retainProofForHook
        ? { deleteCounterpartBeforeDirectory: true }
        : { deleteCounterpartAfterDirectory: true })),
  });
  if (!proofPair) throw new Error('Windows Job retirement proof is missing before native cleanup');
  beforeRetirementDirectoryRemove?.(paths.retirementDirectory);
  const directoryIdentity = exactWindowsJobDirectoryIdentity(paths.retirementDirectory);
  if (!sameWindowsJobDirectoryIdentity(directoryIdentity, record.directoryIdentity)) {
    throw new Error('Windows Job retirement directory changed before native cleanup');
  }
  runWindowsJobDeletionBatch({
    cleanupBudget,
    directory: Object.freeze({
      expectedBirthtimeNs: directoryIdentity.birthtimeNs,
      expectedFileIndex: directoryIdentity.ino,
      expectedVolumeSerial: directoryIdentity.dev,
      path: paths.retirementDirectory,
    }),
    pairs: [...contentPairs, proofPair],
  });
  for (const pair of contentPairs) {
    if (lstatIfPresent(pair.firstPath, { bigint: true })
        || lstatIfPresent(pair.secondPath, { bigint: true })) {
      throw new Error('Windows Job late control replacement survived native deletion');
    }
  }
  if (exactWindowsJobDirectoryIdentity(paths.retirementDirectory)) {
    throw new Error('Windows Job retirement cleanup did not remove its exact directory');
  }
  syncWindowsJobRoot(paths.controlRoot);
  if (retainProofForHook) {
    afterRetirementDirectoryRemove(paths.retirementDirectory);
    throw new Error('Windows Job retirement crash checkpoint did not interrupt cleanup');
  }
}

function syncWindowsJobRoot(controlRoot) {
  let descriptor;
  try {
    descriptor = fs.openSync(controlRoot, 'r');
    fs.fsyncSync(descriptor);
  } catch (error) {
    if (!['EACCES', 'EINVAL', 'EISDIR', 'ENOTSUP', 'EPERM'].includes(error?.code)) throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function publishWindowsJobRetirementRecord(paths, record, {
  afterRetirementProofLink,
  beforeRetirementPendingUnlink,
  beforeRetirementPendingUnlinkCommit,
  beforeRetirementProofLink,
  deferPendingNormalization = false,
} = {}) {
  let existing = readWindowsJobRetirementPublication(paths);
  if (existing && retirementRecordValue(existing) !== retirementRecordValue(record)) {
    throw new Error('Windows Job retirement proof does not match the quarantined control');
  }
  if (!existing) {
    const descriptor = fs.openSync(paths.retirementPending, 'wx', 0o600);
    try {
      fs.writeFileSync(descriptor, retirementRecordValue(record), 'utf8');
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    syncWindowsJobRoot(paths.controlRoot);
    existing = readWindowsJobRetirementPublication(paths);
    if (retirementRecordValue(existing) !== retirementRecordValue(record)) {
      throw new Error('Windows Job pending retirement proof changed after publication');
    }
  }
  if (!lstatIfPresent(paths.retirementProof, { bigint: true })) {
    beforeRetirementProofLink?.({
      pending: paths.retirementPending,
      proof: paths.retirementProof,
      record,
    });
    fs.linkSync(paths.retirementPending, paths.retirementProof);
    const linked = readWindowsJobRetirementPublication(paths);
    if (retirementRecordValue(linked) !== retirementRecordValue(record)) {
      throw new Error('Windows Job retirement proof changed during link publication');
    }
    syncWindowsJobRoot(paths.controlRoot);
    afterRetirementProofLink?.({
      pending: paths.retirementPending,
      proof: paths.retirementProof,
      record,
    });
  }
  const linked = readWindowsJobRetirementPublication(paths);
  assertWindowsJobRetirementRecord(
    linked, record, 'Windows Job retirement proof before normalization',
  );
  if (!deferPendingNormalization
      && lstatIfPresent(paths.retirementPending, { bigint: true })) {
    unlinkWindowsJobRetirementHardLink(paths, {
      beforeUnlink: beforeRetirementPendingUnlink,
      beforeUnlinkCommit: beforeRetirementPendingUnlinkCommit,
      counterpart: paths.retirementProof,
      counterpartLabel: 'Windows Job retirement proof',
      record,
      source: paths.retirementPending,
      sourceLabel: 'Windows Job pending retirement proof',
    });
  }
  const published = readWindowsJobRetirementPublication(paths);
  if (retirementRecordValue(published) !== retirementRecordValue(record)) {
    throw new Error('Windows Job retirement proof changed after normalization');
  }
}

function windowsJobRetirementResidue(paths) {
  return [
    paths.retirementDirectory,
    paths.retirementPending,
    paths.retirementProof,
    paths.retirementProofDeletion,
  ]
    .some((file) => lstatIfPresent(file, { bigint: true }) !== null);
}

function windowsJobCompletionReceiptOnly(paths) {
  return exactWindowsJobDirectoryIdentity(paths.controlDirectory) === null
    && exactWindowsJobDirectoryIdentity(paths.retirementDirectory) === null
    && lstatIfPresent(paths.retirementPending, { bigint: true }) === null
    && lstatIfPresent(paths.retirementProofDeletion, { bigint: true }) === null
    && lstatIfPresent(paths.retirementProof, { bigint: true }) !== null;
}

function windowsJobActiveGeneration(paths) {
  const directoryIdentity = exactWindowsJobDirectoryIdentity(paths.controlDirectory);
  if (!directoryIdentity) throw new Error('Windows Job active control is missing');
  const controlFile = path.join(paths.controlDirectory, 'control.json');
  const before = windowsJobFileIdentity(controlFile);
  const specification = parseCanonicalWindowsJobControl(readBoundedWindowsJobFile(
    controlFile, 'Windows Job active control.json',
  ), paths.controlDirectory);
  const after = windowsJobFileIdentity(controlFile);
  const finalDirectoryIdentity = exactWindowsJobDirectoryIdentity(paths.controlDirectory);
  if (!sameWindowsJobDirectoryIdentity(before, after)
      || !sameWindowsJobDirectoryIdentity(directoryIdentity, finalDirectoryIdentity)) {
    throw new Error('Windows Job active generation changed during validation');
  }
  return Object.freeze({
    controlToken: specification.controlToken,
    directoryIdentity,
    proofToken: specification.proofToken,
  });
}

function exactWindowsJobActiveProof(
  paths, active, expectedProof = windowsJobProofValue(active.proofToken),
) {
  if (expectedProof !== windowsJobProofValue(active.proofToken)) {
    throw new Error('Windows Job active empty proof expectation is not canonical');
  }
  const beforeDirectory = exactWindowsJobDirectoryIdentity(paths.controlDirectory);
  if (!sameWindowsJobDirectoryIdentity(beforeDirectory, active.directoryIdentity)) {
    throw new Error('Windows Job active generation changed before settlement proof');
  }
  const proofPath = path.join(paths.controlDirectory, 'job-empty.proof');
  if (!lstatIfPresent(proofPath, { bigint: true })) return false;
  const proof = readBoundedWindowsJobFile(proofPath, 'Windows Job active empty proof');
  if (proof.toString('utf8') !== expectedProof) {
    throw new Error('Windows Job active empty proof did not match its private token');
  }
  const after = windowsJobActiveGeneration(paths);
  if (!sameWindowsJobDirectoryIdentity(active.directoryIdentity, after.directoryIdentity)
      || active.proofToken !== after.proofToken
      || active.controlToken !== after.controlToken) {
    throw new Error('Windows Job active generation changed during settlement proof');
  }
  return true;
}

function windowsJobActiveProofReady(paths, active) {
  try {
    return exactWindowsJobActiveProof(paths, active);
  } catch (error) {
    if (process.platform === 'win32' && ['EACCES', 'EBUSY', 'EPERM'].includes(error?.code)) {
      return false;
    }
    throw error;
  }
}

function publishWindowsJobRecoveryRequest(paths, active, signal, {
  beforeWindowsRecoveryRequestPublication,
} = {}) {
  const current = windowsJobActiveGeneration(paths);
  if (!sameWindowsJobDirectoryIdentity(active.directoryIdentity, current.directoryIdentity)
      || active.proofToken !== current.proofToken
      || active.controlToken !== current.controlToken) {
    throw new Error('Windows Job active generation changed before recovery request');
  }
  const requestPath = path.join(
    paths.controlDirectory,
    signal === 'SIGKILL' ? 'kill.request' : 'term.request',
  );
  const value = windowsJobRequestValue(signal, active.controlToken);
  beforeWindowsRecoveryRequestPublication?.(Object.freeze({
    active, requestPath, signal,
  }));
  if (process.platform === 'win32') {
    runWindowsJobRequestPublication({ active, paths, requestPath, signal });
  } else {
    let descriptor;
    try {
      descriptor = fs.openSync(requestPath, 'wx', 0o600);
      fs.writeFileSync(descriptor, value, 'utf8');
      fs.fsyncSync(descriptor);
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const existing = readBoundedWindowsJobFile(
        requestPath, `Windows Job ${signal} recovery request`,
      );
      if (existing.toString('utf8') !== value) {
        throw new Error(`Windows Job ${signal} recovery request is not exact`);
      }
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
    }
  }
  syncWindowsJobRoot(paths.controlDirectory);
  const after = windowsJobActiveGeneration(paths);
  if (!sameWindowsJobDirectoryIdentity(active.directoryIdentity, after.directoryIdentity)
      || active.proofToken !== after.proofToken
      || active.controlToken !== after.controlToken) {
    throw new Error('Windows Job active generation changed during recovery request');
  }
}

function waitForWindowsJobActiveProof(paths, active, timeoutMs, {
  monotonicNow,
  sleep,
}) {
  const startedAt = windowsJobCleanupClockReading(monotonicNow);
  let previous = startedAt;
  while (true) {
    const proofPresent = windowsJobActiveProofReady(paths, active);
    const current = windowsJobCleanupClockReading(monotonicNow);
    if (current < previous) throw new Error('Windows Job recovery clock moved backwards');
    previous = current;
    const remaining = timeoutMs - (current - startedAt);
    if (proofPresent) return remaining >= 0;
    if (remaining <= 0) return false;
    sleep(Math.max(1, Math.min(GROUP_POLL_MS, Math.ceil(remaining))));
  }
}

function settleWindowsJobActiveGeneration(paths, recoveryAuthority, {
  beforeWindowsRecoveryRequestPublication,
  windowsRecoveryKillGraceMs,
  windowsRecoveryNow,
  windowsRecoverySleep,
  windowsRecoveryTerminateGraceMs,
}) {
  for (const [name, value] of [
    ['windowsRecoveryTerminateGraceMs', windowsRecoveryTerminateGraceMs],
    ['windowsRecoveryKillGraceMs', windowsRecoveryKillGraceMs],
  ]) {
    if (!Number.isSafeInteger(value) || value <= 0 || value > WINDOWS_JOB_DELETE_TIMEOUT_MS) {
      throw new Error(`${name} must be a positive bounded integer`);
    }
  }
  if (typeof windowsRecoveryNow !== 'function' || typeof windowsRecoverySleep !== 'function') {
    throw new Error('Windows Job recovery wait authority is invalid');
  }
  const active = windowsJobActiveGeneration(paths);
  assertWindowsJobRecoveryProofToken(active, recoveryAuthority.proofToken);
  if (windowsJobActiveProofReady(paths, active)) return active;
  publishWindowsJobRecoveryRequest(paths, active, 'SIGTERM', {
    beforeWindowsRecoveryRequestPublication,
  });
  if (waitForWindowsJobActiveProof(paths, active, windowsRecoveryTerminateGraceMs, {
    monotonicNow: windowsRecoveryNow,
    sleep: windowsRecoverySleep,
  })) return active;
  publishWindowsJobRecoveryRequest(paths, active, 'SIGKILL', {
    beforeWindowsRecoveryRequestPublication,
  });
  if (waitForWindowsJobActiveProof(paths, active, windowsRecoveryKillGraceMs, {
    monotonicNow: windowsRecoveryNow,
    sleep: windowsRecoverySleep,
  })) return active;
  throw new Error('Windows Job live generation did not settle after bounded recovery requests');
}

function reconcileWindowsJobActiveCompletionReceipt(paths, proofToken, {
  windowsCleanupNow = WINDOWS_JOB_MONOTONIC_NOW,
  windowsCleanupTimeoutMs = WINDOWS_JOB_DELETE_TIMEOUT_MS,
} = {}) {
  const active = windowsJobActiveGeneration(paths);
  if (active.proofToken !== proofToken) {
    throw new Error('Windows Job active generation token changed before publication completed');
  }
  const retirementIdentity = exactWindowsJobDirectoryIdentity(paths.retirementDirectory);
  const pendingPresent = lstatIfPresent(paths.retirementPending, { bigint: true }) !== null;
  const proofPresent = lstatIfPresent(paths.retirementProof, { bigint: true }) !== null;
  const proofDeletionPresent = lstatIfPresent(paths.retirementProofDeletion, {
    bigint: true,
  }) !== null;
  if (!retirementIdentity && !pendingPresent && !proofPresent && !proofDeletionPresent) {
    return active;
  }
  if (retirementIdentity || (pendingPresent && proofDeletionPresent)) {
    throw new Error('Windows Job active generation overlaps non-terminal retirement evidence');
  }
  const retirementRecord = pendingPresent
    ? readWindowsJobRetirementPublication(paths)
    : readWindowsJobRetirementProofCleanup(paths);
  if (!retirementRecord) {
    throw new Error('Windows Job prior completion receipt disappeared during reconciliation');
  }
  if (retirementRecord.proofToken === active.proofToken) {
    throw new Error('Windows Job active generation overlaps its own completion receipt');
  }
  const cleanupBudget = process.platform === 'win32'
    ? createWindowsJobCleanupBudget(windowsCleanupTimeoutMs, {
      monotonicNow: windowsCleanupNow,
    })
    : undefined;
  normalizeWindowsJobRetirementReceipt(paths, retirementRecord, { cleanupBudget });
  removeWindowsJobRetirementProof(paths, retirementRecord, { cleanupBudget });
  const after = windowsJobActiveGeneration(paths);
  if (!sameWindowsJobDirectoryIdentity(active.directoryIdentity, after.directoryIdentity)
      || active.proofToken !== after.proofToken
      || windowsJobRetirementResidue(paths)) {
    throw new Error('Windows Job active generation changed while consuming prior receipt');
  }
  return after;
}

function discoverWindowsJobProofToken(paths) {
  for (const directory of [paths.controlDirectory, paths.retirementDirectory]) {
    if (!exactWindowsJobDirectoryIdentity(directory)) continue;
    try {
      const raw = readBoundedWindowsJobFile(
        path.join(directory, 'control.json'), 'Windows Job control.json',
      );
      return parseCanonicalWindowsJobControl(raw, paths.controlDirectory).proofToken;
    } catch {}
  }
  try {
    const record = lstatIfPresent(paths.retirementPending, { bigint: true })
      ? readWindowsJobRetirementPublication(paths)
      : readWindowsJobRetirementProofCleanup(paths);
    return record?.proofToken;
  } catch {
    return undefined;
  }
}

export function recoverWindowsJobControl({
  afterRetirementDirectoryRemove,
  afterRetirementFileLink,
  afterRetirementProofLink,
  beforeRetirementCleanup,
  beforeRetirementDirectoryRemove,
  beforeRetirementFileLink,
  beforeRetirementPendingUnlink,
  beforeRetirementPendingUnlinkCommit,
  beforeRetirementProofDeleteCommit,
  beforeRetirementProofDeleteLink,
  beforeRetirementProofLink,
  beforeRetirementProofUnlink,
  beforeRetirementSourceDeleteOpen,
  beforeRetirementSourceUnlink,
  beforeWindowsRecoveryRequestPublication,
  controlKey,
  moveDirectory = fs.renameSync,
  recoveryAuthority,
  removeRetirementFile = fs.unlinkSync,
  temporaryDirectory = os.tmpdir(),
  windowsCleanupNow = WINDOWS_JOB_MONOTONIC_NOW,
  windowsCleanupTimeoutMs = WINDOWS_JOB_DELETE_TIMEOUT_MS,
  windowsRecoveryKillGraceMs = DEFAULT_KILL_GRACE_MS,
  windowsRecoveryNow = WINDOWS_JOB_MONOTONIC_NOW,
  windowsRecoverySleep = WINDOWS_JOB_RECOVERY_SLEEP,
  windowsRecoveryTerminateGraceMs = DEFAULT_TERMINATE_GRACE_MS,
} = {}) {
  const explicitAuthority = recoveryAuthority !== undefined;
  const paths = recoveryAuthority
    ? windowsJobControlPathsFromAuthority(recoveryAuthority)
    : windowsJobControlPaths(controlKey, temporaryDirectory);
  if (recoveryAuthority && controlKey !== undefined) {
    const keyedPaths = windowsJobControlPaths(controlKey, temporaryDirectory);
    if (keyedPaths.controlDirectory !== paths.controlDirectory) {
      throw new Error('Windows Job recovery authority does not match controlKey');
    }
  }
  let authorityProofToken = recoveryAuthority?.proofToken;
  const failure = (cause) => windowsJobRecoveryRequired(
    paths, cause, discoverWindowsJobProofToken(paths) ?? authorityProofToken,
  );
  let retired = false;
  try {
    if (!Number.isSafeInteger(windowsCleanupTimeoutMs) || windowsCleanupTimeoutMs <= 0
        || windowsCleanupTimeoutMs > WINDOWS_JOB_DELETE_TIMEOUT_MS) {
      throw new Error('Windows Job cleanup timeout must be a positive bounded integer');
    }
    const root = exactWindowsJobDirectoryIdentity(paths.controlRoot);
    if (!root) {
      if (explicitAuthority) {
        throw new Error('Windows Job explicit recovery root disappeared without settlement proof');
      }
      return Object.freeze({
        controlDirectory: paths.controlDirectory, retired: false, state: 'absent',
      });
    }
    const controlIdentity = exactWindowsJobDirectoryIdentity(paths.controlDirectory);
    let retirementIdentity = exactWindowsJobDirectoryIdentity(paths.retirementDirectory);
    let proofPresent = lstatIfPresent(paths.retirementProof, { bigint: true }) !== null;
    let pendingPresent = lstatIfPresent(paths.retirementPending, { bigint: true }) !== null;
    let proofDeletionPresent = lstatIfPresent(paths.retirementProofDeletion, {
      bigint: true,
    }) !== null;

    if (controlIdentity && !retirementIdentity
        && (proofPresent || pendingPresent || proofDeletionPresent)) {
      const active = windowsJobActiveGeneration(paths);
      authorityProofToken = active.proofToken;
      if (recoveryAuthority?.proofToken !== undefined
          && recoveryAuthority.proofToken !== active.proofToken) {
        throw new Error('Windows Job recovery authority does not own the active generation');
      }
      reconcileWindowsJobActiveCompletionReceipt(paths, active.proofToken, {
        windowsCleanupNow,
        windowsCleanupTimeoutMs,
      });
      proofPresent = lstatIfPresent(paths.retirementProof, { bigint: true }) !== null;
      pendingPresent = lstatIfPresent(paths.retirementPending, { bigint: true }) !== null;
      proofDeletionPresent = lstatIfPresent(paths.retirementProofDeletion, {
        bigint: true,
      }) !== null;
    }

    if (controlIdentity
        && (retirementIdentity || proofPresent || pendingPresent || proofDeletionPresent)) {
      throw new Error('Windows Job active and retirement namespaces overlap');
    }
    if (controlIdentity && explicitAuthority) {
      settleWindowsJobActiveGeneration(paths, recoveryAuthority, {
        beforeWindowsRecoveryRequestPublication,
        windowsRecoveryKillGraceMs,
        windowsRecoveryNow,
        windowsRecoverySleep,
        windowsRecoveryTerminateGraceMs,
      });
    }
    if (!controlIdentity && !retirementIdentity && !proofPresent
        && !pendingPresent && !proofDeletionPresent) {
      if (explicitAuthority) {
        throw new Error('Windows Job explicit recovery namespace disappeared without settlement proof');
      }
      return Object.freeze({
        controlDirectory: paths.controlDirectory, retired: false, state: 'absent',
      });
    }
    if (!retirementIdentity && (proofPresent || pendingPresent || proofDeletionPresent)) {
      if (pendingPresent && proofDeletionPresent) {
        throw new Error('Windows Job retirement proof completion states overlap');
      }
      let retirementRecord = pendingPresent
        ? readWindowsJobRetirementPublication(paths)
        : readWindowsJobRetirementProofCleanup(paths);
      authorityProofToken ??= retirementRecord.proofToken;
      assertWindowsJobRecoveryProofToken(retirementRecord, recoveryAuthority?.proofToken);
      if (pendingPresent && !proofPresent) {
        publishWindowsJobRetirementRecord(paths, retirementRecord, {
          deferPendingNormalization: true,
        });
        retirementRecord = readWindowsJobRetirementPublication(paths);
      }
      const cleanupBudget = process.platform === 'win32'
        ? createWindowsJobCleanupBudget(windowsCleanupTimeoutMs, {
          monotonicNow: windowsCleanupNow,
        })
        : undefined;
      if (explicitAuthority) {
        normalizeWindowsJobRetirementReceipt(paths, retirementRecord, {
          beforeRetirementPendingUnlink,
          beforeRetirementPendingUnlinkCommit,
          beforeRetirementProofDeleteCommit,
          beforeRetirementProofDeleteLink,
          beforeRetirementProofUnlink,
          cleanupBudget,
        });
        if (!windowsJobCompletionReceiptOnly(paths)) {
          throw new Error('Windows Job durable completion receipt is not exact');
        }
      } else {
        removeWindowsJobRetirementProof(paths, retirementRecord, {
          beforeRetirementProofDeleteCommit,
          beforeRetirementProofDeleteLink,
          beforeRetirementProofUnlink,
          cleanupBudget,
        });
        if (windowsJobRetirementResidue(paths)) {
          throw new Error('Windows Job retirement residue survived pre-spawn discovery');
        }
      }
      return Object.freeze({
        controlDirectory: paths.controlDirectory,
        retired: explicitAuthority ? pendingPresent || proofDeletionPresent : true,
        state: 'absent',
      });
    }
    if (retirementIdentity && proofDeletionPresent
        && (!proofPresent || pendingPresent)) {
      throw new Error('Windows Job proof deletion has no exact retirement proof pair');
    }

    let capture;
    if (controlIdentity) {
      capture = validateWindowsJobControlDirectory(
        paths.controlDirectory, paths.controlDirectory,
      );
      authorityProofToken ??= capture.proofToken;
      assertWindowsJobRecoveryProofToken(capture, recoveryAuthority?.proofToken);
      try {
        moveDirectory(paths.controlDirectory, paths.retirementDirectory);
      } catch (cause) {
        throw failure(cause);
      }
      retired = true;
      retirementIdentity = exactWindowsJobDirectoryIdentity(paths.retirementDirectory);
      if (!sameWindowsJobDirectoryIdentity(capture.directoryIdentity, retirementIdentity)) {
        throw new Error('Windows Job control identity changed during retirement move');
      }
      const quarantined = validateWindowsJobControlDirectory(
        paths.retirementDirectory, paths.controlDirectory,
      );
      if (capture.snapshotHash !== quarantined.snapshotHash
          || !sameWindowsJobDirectoryIdentity(capture.directoryIdentity,
            quarantined.directoryIdentity)) {
        throw new Error('Windows Job control changed during retirement quarantine');
      }
    } else {
      retired = true;
    }

    let retirementRecord;
    if (proofPresent || pendingPresent) {
      retirementRecord = readWindowsJobRetirementPublication(paths);
      authorityProofToken ??= retirementRecord.proofToken;
      assertWindowsJobRecoveryProofToken(retirementRecord, recoveryAuthority?.proofToken);
      if (!sameWindowsJobDirectoryIdentity(
        retirementRecord.directoryIdentity, retirementIdentity,
      )) throw new Error('Windows Job retirement proof does not own the quarantined directory');
      validateWindowsJobRetirementResidue(paths.retirementDirectory, retirementRecord);
      publishWindowsJobRetirementRecord(paths, retirementRecord, {
        afterRetirementProofLink,
        beforeRetirementPendingUnlink,
        beforeRetirementPendingUnlinkCommit,
        beforeRetirementProofLink,
        deferPendingNormalization: process.platform === 'win32',
      });
    } else {
      if (!capture) {
        capture = validateWindowsJobControlDirectory(
          paths.retirementDirectory, paths.controlDirectory,
        );
      }
      retirementRecord = windowsJobRetirementRecord(paths, capture);
      authorityProofToken ??= retirementRecord.proofToken;
      assertWindowsJobRecoveryProofToken(retirementRecord, recoveryAuthority?.proofToken);
      publishWindowsJobRetirementRecord(paths, retirementRecord, {
        afterRetirementProofLink,
        beforeRetirementPendingUnlink,
        beforeRetirementPendingUnlinkCommit,
        beforeRetirementProofLink,
        deferPendingNormalization: process.platform === 'win32',
      });
    }

    beforeRetirementCleanup?.(paths.retirementDirectory);
    validateWindowsJobRetirementResidue(paths.retirementDirectory, retirementRecord);
    const cleanupBudget = process.platform === 'win32'
      ? createWindowsJobCleanupBudget(windowsCleanupTimeoutMs, {
        monotonicNow: windowsCleanupNow,
      })
      : undefined;
    let contentPairs;
    try {
      contentPairs = removeWindowsJobRetirementContents(paths, retirementRecord, {
        afterRetirementDirectoryRemove,
        afterRetirementFileLink,
        beforeRetirementDirectoryRemove,
        beforeRetirementFileLink,
        beforeRetirementSourceDeleteOpen,
        beforeRetirementSourceUnlink,
        removeRetirementFile,
      });
      if (process.platform === 'win32') {
        removeWindowsJobNativeRetirement(paths, retirementRecord, contentPairs, {
          afterRetirementDirectoryRemove,
          beforeRetirementDirectoryRemove,
          beforeRetirementPendingUnlink,
          beforeRetirementPendingUnlinkCommit,
          beforeRetirementProofDeleteCommit,
          beforeRetirementProofDeleteLink,
          beforeRetirementProofUnlink,
          cleanupBudget,
        });
      }
    } catch (cause) {
      throw failure(cause);
    }
    if (exactWindowsJobDirectoryIdentity(paths.retirementDirectory)) {
      throw new Error('Windows Job retirement cleanup did not remove its quarantine');
    }
    if (process.platform !== 'win32') {
      normalizeWindowsJobRetirementReceipt(paths, retirementRecord, {
        beforeRetirementPendingUnlink,
        beforeRetirementPendingUnlinkCommit,
        beforeRetirementProofDeleteCommit,
        beforeRetirementProofDeleteLink,
        beforeRetirementProofUnlink,
        cleanupBudget,
      });
    }
    if (!windowsJobCompletionReceiptOnly(paths)) {
      throw new Error('Windows Job cleanup did not retain one exact completion receipt');
    }
    const completionReceipt = readWindowsJobRetirementRecord(paths);
    assertWindowsJobRetirementRecord(
      completionReceipt, retirementRecord, 'Windows Job completion receipt',
    );
    assertWindowsJobRecoveryProofToken(completionReceipt, recoveryAuthority?.proofToken);
    if (exactWindowsJobDirectoryIdentity(paths.controlDirectory)) {
      throw new Error('Windows Job successor appeared before retirement completed');
    }
    return Object.freeze({
      controlDirectory: paths.controlDirectory, retired, state: 'absent',
    });
  } catch (error) {
    if (error?.code === 'WINDOWS_JOB_RECOVERY_REQUIRED') throw error;
    throw failure(error);
  }
}

function recoveryAuthorityForWindowsJob(control) {
  if (control?.recoveryAuthority?.controlDirectory) return control.recoveryAuthority;
  const proofPath = control?.specification?.proofPath;
  if (typeof proofPath !== 'string' || !path.isAbsolute(proofPath)
      || path.basename(proofPath) !== 'job-empty.proof') return undefined;
  return Object.freeze({ controlDirectory: path.dirname(proofPath) });
}

function posixPublicationRecoveryFields(residues) {
  const exact = [...residues];
  if (exact.length === 0) return {};
  if (exact.length === 1) return { publicationResidue: exact[0] };
  return { publicationResidues: Object.freeze(exact) };
}

function recoveryAuthorityForPosixSession(control, residues = []) {
  const controlDirectory = control?.specification?.controlDirectory;
  return typeof controlDirectory === 'string' && path.isAbsolute(controlDirectory)
    ? Object.freeze({ controlDirectory, ...posixPublicationRecoveryFields(residues) })
    : undefined;
}

function stdioWithPosixWriterEgress(stdio, descriptor) {
  if (descriptor !== POSIX_SESSION_WRITER_EGRESS_FD) {
    throw new Error('POSIX session writer egress descriptor is invalid');
  }
  if (Array.isArray(stdio)) {
    const configured = [...stdio];
    if (configured[descriptor] !== undefined && configured[descriptor] !== 'pipe') {
      throw new Error('POSIX session writer egress descriptor is already occupied');
    }
    configured[descriptor] = 'pipe';
    return configured;
  }
  if (stdio !== undefined && stdio !== 'ignore' && stdio !== 'inherit' && stdio !== 'pipe') {
    throw new Error('POSIX session writer egress requires explicit stream stdio');
  }
  const inherited = stdio ?? 'inherit';
  return [inherited, inherited, inherited, 'pipe'];
}

function markSettlementUnproven(error, recoveryAuthority) {
  if (!recoveryAuthority) return error;
  error.childSettlementUnproven = true;
  error.recoveryAuthority = recoveryAuthority;
  return error;
}

export function createWindowsJobControl({
  beforePrivateGenerationCleanup,
  controlKey,
  publishDirectory = fs.renameSync,
  temporaryDirectory = os.tmpdir(),
} = {}) {
  const deterministicPaths = controlKey
    ? windowsJobControlPaths(controlKey, temporaryDirectory)
    : undefined;
  if (deterministicPaths) {
    if (windowsJobRetirementResidue(deterministicPaths)) {
      let completionReceiptOnly = false;
      try {
        completionReceiptOnly = windowsJobCompletionReceiptOnly(deterministicPaths);
      } catch (cause) {
        throw windowsJobRecoveryRequired(
          deterministicPaths, cause, discoverWindowsJobProofToken(deterministicPaths),
        );
      }
      if (completionReceiptOnly) {
        recoverWindowsJobControl({ controlKey, temporaryDirectory });
      } else {
        throw windowsJobRecoveryRequired(
          deterministicPaths,
          new Error('Windows Job retirement evidence requires typed recovery'),
          discoverWindowsJobProofToken(deterministicPaths),
        );
      }
    }
    if (typeof publishDirectory !== 'function') {
      throw new Error('Windows Job control publisher is invalid');
    }
  }
  const controlToken = randomBytes(32).toString('hex');
  const proofToken = randomBytes(32).toString('hex');
  const directory = deterministicPaths
    ? deterministicPaths.controlDirectory
    : fs.mkdtempSync(path.join(temporaryDirectory, 'easyboost-windows-job-'));
  const specification = Object.freeze({
    controlProtocol: WINDOWS_JOB_CONTROL_PROTOCOL,
    controlToken,
    killRequestPath: path.join(directory, 'kill.request'),
    proofPath: path.join(directory, 'job-empty.proof'),
    proofProtocol: WINDOWS_JOB_EMPTY_PROTOCOL,
    proofToken,
    termRequestPath: path.join(directory, 'term.request'),
  });
  // Publish deterministic generations only after their token-bound control record
  // is durable. A competing creator can then recover the winner's exact token;
  // it can never observe the old mkdir-before-control.json partial state.
  const creationDirectory = deterministicPaths
    ? fs.mkdtempSync(path.join(
      temporaryDirectory,
      `.${path.basename(directory)}.create-`,
    ))
    : directory;
  const metadataFile = path.join(creationDirectory, 'control.json');
  let privateGeneration;
  try {
    const descriptor = fs.openSync(metadataFile, 'wx', 0o600);
    try {
      fs.writeFileSync(descriptor, `${JSON.stringify(specification)}\n`, 'utf8');
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    privateGeneration = captureWindowsJobPrivateGeneration(creationDirectory, directory);
    if (deterministicPaths) {
      syncWindowsJobRoot(creationDirectory);
      publishDirectory(creationDirectory, directory);
      syncWindowsJobRoot(deterministicPaths.controlRoot);
      reconcileWindowsJobActiveCompletionReceipt(deterministicPaths, proofToken);
    }
  } catch (error) {
    let cleanupError;
    try {
      if (privateGeneration) {
        const publishedIdentity = deterministicPaths
          ? exactWindowsJobDirectoryIdentity(directory)
          : null;
        const cleanupDirectory = sameWindowsJobDirectoryIdentity(
          publishedIdentity, privateGeneration.directoryIdentity,
        )
          ? directory
          : creationDirectory;
        removeWindowsJobPrivateGeneration(cleanupDirectory, privateGeneration);
      }
    } catch (cause) {
      cleanupError = cause;
    }
    const failureCause = cleanupError
      ? new AggregateError(
        [error, cleanupError],
        'Windows Job publication failed and its private generation was retained',
        { cause: error },
      )
      : error;
    const recoveryToken = deterministicPaths
      ? discoverWindowsJobProofToken(deterministicPaths)
      : undefined;
    let recoveryResidue = false;
    if (deterministicPaths) {
      try {
        recoveryResidue = exactWindowsJobDirectoryIdentity(directory) !== null
          || windowsJobRetirementResidue(deterministicPaths);
      } catch {}
    }
    if (!deterministicPaths || (!recoveryResidue && recoveryToken === undefined)) {
      throw failureCause;
    }
    throw windowsJobRecoveryRequired(
      deterministicPaths, failureCause, recoveryToken,
    );
  }
  let disposed = false;
  let disposalGeneration;
  let exactProofVerified = false;
  let launchState = 'never-launched';
  const liveGeneration = Object.freeze({
    controlToken,
    directoryIdentity: privateGeneration.directoryIdentity,
    proofToken,
  });
  const livePaths = deterministicPaths ?? Object.freeze({ controlDirectory: directory });
  const expectedProof = windowsJobProofValue(proofToken);
  const request = (signal) => {
    if (disposed) throw new Error('Windows Job control is already disposed');
    if (exactProofVerified) return true;
    publishWindowsJobRecoveryRequest(livePaths, liveGeneration, signal);
    return true;
  };
  return Object.freeze({
    dispose({ force = false } = {}) {
      if (disposed) return;
      const proof = this.proofState();
      if (!force && proof.state !== 'absent') return;
      if (force && launchState !== 'never-launched' && proof.state !== 'absent') {
        throw new Error('WINDOWS_JOB_FORCE_DISPOSE_FORBIDDEN');
      }
      if (proof.state === 'absent') exactProofVerified = true;
      if (deterministicPaths && exactProofVerified) {
        recoverWindowsJobControl({
          recoveryAuthority: windowsJobRecoveryAuthority(deterministicPaths, proofToken),
        });
      } else {
        disposalGeneration ??= exactProofVerified
          ? captureWindowsJobSettledGeneration(directory, privateGeneration)
          : privateGeneration;
        beforePrivateGenerationCleanup?.({
          directory,
          generation: disposalGeneration,
        });
        if (!removeWindowsJobPrivateGeneration(directory, disposalGeneration)) {
          throw new Error('Windows Job private generation disappeared before exact cleanup');
        }
      }
      disposed = true;
    },
    markWrapperSpawned() {
      if (disposed) throw new Error('Windows Job control is already disposed');
      launchState = 'launched';
    },
    proofState() {
      if (exactProofVerified) return { state: 'absent' };
      if (disposed) return { state: 'unknown' };
      try {
        if (exactWindowsJobActiveProof(livePaths, liveGeneration, expectedProof)) {
          return { state: 'absent' };
        }
        return { state: 'unknown' };
      } catch (error) {
        return { error, state: 'unknown' };
      }
    },
    request,
    recoveryAuthority: deterministicPaths
      ? windowsJobRecoveryAuthority(deterministicPaths, proofToken)
      : undefined,
    specification,
  });
}

export function createWindowsJobInvocation(
  command, args, cwd, settlementMilliseconds, targetEnvironment,
  windowsJobControl = createWindowsJobControl(),
) {
  const payload = Buffer.from(JSON.stringify({
    arguments: args,
    command,
    cwd: cwd || process.cwd(),
    protocol: WINDOWS_JOB_PROTOCOL,
    settlementMilliseconds,
  }), 'utf8').toString('base64');
  return {
    args: [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', WINDOWS_JOB_SCRIPT, '-Payload', payload,
    ],
    command: 'powershell.exe',
    cwd: WINDOWS_JOB_DIRECTORY,
    environment: windowsSupervisorEnvironment(
      targetEnvironment,
      windowsJobControl.specification,
    ),
    windowsJobControl,
  };
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Invalid release command lifecycle bound: ${label}`);
  }
  return value;
}

function readLinuxProcessStat(processId) {
  const value = fs.readFileSync(`/proc/${processId}/stat`, 'utf8');
  const commandEnd = value.lastIndexOf(')');
  if (commandEnd < 1) throw new Error(`Invalid /proc stat for process ${processId}`);
  const fields = value.slice(commandEnd + 2).trim().split(/\s+/u);
  const parsedProcessId = Number(value.slice(0, value.indexOf(' ')));
  const processGroupId = Number(fields[2]);
  const sessionId = Number(fields[3]);
  const leaderStartTime = fields[19];
  if (![parsedProcessId, processGroupId, sessionId].every(Number.isSafeInteger)
    || !/^\d+$/u.test(leaderStartTime ?? '')) {
    throw new Error(`Invalid /proc identity for process ${processId}`);
  }
  return {
    leaderStartTime,
    processGroupId,
    processId: parsedProcessId,
    sessionId,
  };
}

function readLinuxProcessStatIfPresent(processId) {
  try {
    return { process: readLinuxProcessStat(processId) };
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ESRCH') return { process: null };
    return { error, process: null };
  }
}

function inspectResidualLinuxProcessGroup(processGroupId, expectedIdentity) {
  let entries;
  try {
    entries = fs.readdirSync('/proc', { withFileTypes: true });
  } catch (error) {
    return { error, state: 'unknown' };
  }
  let unreadableError;
  let originalMember = false;
  let reusedMember = false;
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/u.test(entry.name)) continue;
    const result = readLinuxProcessStatIfPresent(Number(entry.name));
    if (result.error) {
      unreadableError ??= result.error;
      continue;
    }
    if (!result.process || result.process.processGroupId !== processGroupId) continue;
    if (result.process.sessionId === expectedIdentity.sessionId) originalMember = true;
    else reusedMember = true;
  }
  if (originalMember) return { state: 'alive' };
  if (reusedMember) return { state: 'reused' };
  if (unreadableError) return { error: unreadableError, state: 'unknown' };
  return { state: 'absent' };
}

function inspectLinuxProcessGroup(processGroupId, expectedIdentity) {
  const leader = readLinuxProcessStatIfPresent(processGroupId);
  if (leader.error) return { error: leader.error, state: 'unknown' };
  if (!expectedIdentity) {
    if (!leader.process) {
      const residual = inspectResidualLinuxProcessGroup(processGroupId, {
        sessionId: processGroupId,
      });
      return residual.state === 'absent' ? residual : {
        error: residual.error ?? new Error(
          `POSIX process-group leader ${processGroupId} exited before identity capture`,
        ),
        state: 'unknown',
      };
    }
    if (leader.process.processGroupId !== processGroupId
      || leader.process.sessionId !== processGroupId) {
      return {
        error: new Error(`POSIX child ${processGroupId} is not an isolated session leader`),
        state: 'unknown',
      };
    }
    return {
      identity: Object.freeze({
        leaderStartTime: leader.process.leaderStartTime,
        processGroupId,
        sessionId: leader.process.sessionId,
      }),
      state: 'alive',
    };
  }
  if (leader.process) {
    if (leader.process.leaderStartTime !== expectedIdentity.leaderStartTime
      || leader.process.processGroupId !== expectedIdentity.processGroupId
      || leader.process.sessionId !== expectedIdentity.sessionId) return { state: 'reused' };
    return { state: 'alive' };
  }
  return inspectResidualLinuxProcessGroup(processGroupId, expectedIdentity);
}

function validProcessGroupIdentity(identity, processGroupId) {
  return identity
    && identity.processGroupId === processGroupId
    && Number.isSafeInteger(identity.sessionId)
    && identity.sessionId > 0
    && /^\d+$/u.test(identity.leaderStartTime ?? '');
}

export function createPosixProcessGroupAuthority(processGroupId, {
  inspectProcessGroup = inspectLinuxProcessGroup,
  requestSignal,
} = {}) {
  if (!Number.isSafeInteger(processGroupId) || processGroupId <= 0) return undefined;
  let capturedIdentity;
  let captureState;
  let captureError;
  try {
    const capture = inspectProcessGroup(processGroupId, null);
    capturedIdentity = validProcessGroupIdentity(capture?.identity, processGroupId)
      ? Object.freeze({ ...capture.identity })
      : undefined;
    captureState = capture?.state;
    captureError = capture?.error;
    if (captureState === 'alive' && !capturedIdentity && !captureError) {
      captureError = new Error('POSIX process-group birth/session identity was not captured');
    }
  } catch (error) {
    captureState = 'unknown';
    captureError = error;
  }
  const inspectOriginalGroup = () => {
    if (captureState === 'absent') return { state: 'absent' };
    if (!capturedIdentity) return { error: captureError, state: 'unknown' };
    try {
      return inspectProcessGroup(processGroupId, capturedIdentity);
    } catch (error) {
      return { error, state: 'unknown' };
    }
  };
  const unavailableSignalError = (inspection) => {
    if (inspection.state === 'absent' || inspection.state === 'reused') {
      return Object.assign(new Error('Original POSIX process group is absent'), {
        code: 'ESRCH',
      });
    }
    return Object.assign(new Error(
      'POSIX process-group birth/session identity could not be proven',
      inspection.error ? { cause: inspection.error } : undefined,
    ), { code: 'EAGAIN' });
  };
  return Object.freeze({
    identity: capturedIdentity,
    kind: 'posix-process-group',
    processGroupId,
    signal(signal) {
      const inspection = inspectOriginalGroup();
      if (inspection.state !== 'alive') throw unavailableSignalError(inspection);
      if (typeof requestSignal !== 'function') {
        throw Object.assign(new Error(
          'POSIX process-group authority has no cooperative signal controller',
        ), { code: 'EAGAIN' });
      }
      return requestSignal(signal);
    },
    state() {
      const inspection = inspectOriginalGroup();
      if (inspection.error) throw inspection.error;
      if (inspection.state === 'reused') {
        throw Object.assign(new Error('POSIX process-group numeric identity was reused'), {
          code: 'EAGAIN',
        });
      }
      return inspection.state;
    },
  });
}

function inspectAuthorityState(authority) {
  if (!authority) return { state: 'absent' };
  try {
    const state = authority.state();
    return { state: state === 'alive' || state === 'absent' ? state : 'unknown' };
  } catch (error) {
    return { error, state: 'unknown' };
  }
}

function canonicalReleaseRecoveryAuthority(authority) {
  if (!authority || typeof authority !== 'object' || Array.isArray(authority)) return undefined;
  if (authority.protocol === WINDOWS_JOB_RECOVERY_PROTOCOL) {
    try {
      return windowsJobRecoveryAuthority(
        windowsJobControlPathsFromAuthority(authority), authority.proofToken,
      );
    } catch {
      return undefined;
    }
  }
  if (typeof authority.controlDirectory !== 'string'
      || !path.isAbsolute(authority.controlDirectory)) return undefined;
  const controlDirectory = path.resolve(authority.controlDirectory);
  if (controlDirectory !== authority.controlDirectory) return undefined;
  try {
    const retirementKeys = [
      'controlDirectory', 'reservationOwner', 'sourceDev', 'sourceIno', 'tombstone',
    ];
    if (JSON.stringify(Object.keys(authority).sort()) === JSON.stringify(retirementKeys)) {
      if (!/^[a-f0-9]{64}$/u.test(authority.reservationOwner ?? '')
          || !/^(?:0|[1-9]\d*)$/u.test(authority.sourceDev ?? '')
          || !/^(?:0|[1-9]\d*)$/u.test(authority.sourceIno ?? '')
          || typeof authority.tombstone !== 'string'
          || !path.isAbsolute(authority.tombstone)
          || path.resolve(authority.tombstone) !== authority.tombstone
          || path.dirname(authority.tombstone) !== path.dirname(controlDirectory)
          || !/^\.easyboost-staging-quarantine-slot\.[a-f0-9]{64}\.tombstone$/u
            .test(path.basename(authority.tombstone))) return undefined;
      return Object.freeze({
        controlDirectory,
        reservationOwner: authority.reservationOwner,
        sourceDev: authority.sourceDev,
        sourceIno: authority.sourceIno,
        tombstone: authority.tombstone,
      });
    }
    if (authority.publicationResidue !== undefined
        && authority.publicationResidues !== undefined) return undefined;
    if (authority.publicationResidue !== undefined) {
      return Object.freeze({
        controlDirectory,
        publicationResidue: normalizePosixSessionPublicationResidue(
          authority.publicationResidue, controlDirectory,
        ),
      });
    }
    if (authority.publicationResidues !== undefined) {
      return Object.freeze({
        controlDirectory,
        publicationResidues: normalizePosixSessionPublicationResidues(
          authority.publicationResidues, controlDirectory,
        ),
      });
    }
    const residueKeys = ['destination', 'sourceBinding', 'temporary', 'tombstone'];
    if (residueKeys.some((key) => Object.hasOwn(authority, key))) {
      const publicationResidue = {};
      for (const key of residueKeys) {
        if (Object.hasOwn(authority, key)) publicationResidue[key] = authority[key];
      }
      return Object.freeze({
        controlDirectory,
        publicationResidue: normalizePosixSessionPublicationResidue(
          publicationResidue, controlDirectory,
        ),
      });
    }
  } catch {
    return undefined;
  }
  return Object.freeze({ controlDirectory });
}

function collectReleaseRecovery(error, state, seen) {
  if (!error || typeof error !== 'object' || seen.has(error)) return;
  seen.add(error);
  if (error.childSettlementUnproven === true) state.childSettlementUnproven = true;
  const candidate = canonicalReleaseRecoveryAuthority(error.recoveryAuthority);
  const specificity = (authority) => authority
    && authority.reservationOwner ? 3
      : authority && (authority.publicationResidue || authority.publicationResidues)
        ? 2 : authority ? 1 : 0;
  if (specificity(candidate) > specificity(state.recoveryAuthority)) {
    state.recoveryAuthority = candidate;
  }
  if (error instanceof AggregateError && Array.isArray(error.errors)) {
    for (const nested of error.errors) collectReleaseRecovery(nested, state, seen);
  }
  collectReleaseRecovery(error.cause, state, seen);
}

function propagateReleaseRecovery(target, ...sources) {
  const state = { childSettlementUnproven: false, recoveryAuthority: undefined };
  const seen = new Set();
  for (const source of [target, ...sources]) collectReleaseRecovery(source, state, seen);
  if (state.childSettlementUnproven && state.recoveryAuthority) {
    markSettlementUnproven(target, state.recoveryAuthority);
  }
  return target;
}

function releaseError(primary, lifecycleErrors, message) {
  if (!lifecycleErrors.length) return propagateReleaseRecovery(primary, primary);
  return propagateReleaseRecovery(
    new AggregateError([primary, ...lifecycleErrors], `${primary.message}; ${message}`),
    primary,
    ...lifecycleErrors,
  );
}

export function runBoundedReleaseCommand(command, args = [], options = {}) {
  const hardTimeoutMs = positiveInteger(
    options.hardTimeoutMs ?? DEFAULT_HARD_TIMEOUT_MS, 'hardTimeoutMs',
  );
  const terminateGraceMs = positiveInteger(
    options.terminateGraceMs ?? DEFAULT_TERMINATE_GRACE_MS, 'terminateGraceMs',
  );
  const killGraceMs = positiveInteger(
    options.killGraceMs ?? DEFAULT_KILL_GRACE_MS, 'killGraceMs',
  );
  const maxOutputBytes = positiveInteger(
    options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES, 'maxOutputBytes',
  );
  if (typeof command !== 'string' || !command || !Array.isArray(args)) {
    throw new Error('Invalid bounded release command');
  }

  const platform = options.platform ?? process.platform;
  const spawnProcess = options.spawnProcess ?? spawn;
  const windowsTreeKill = options.windowsTreeKill ?? spawnSync;
  const processObject = options.processObject ?? process;
  const commandLabel = options.commandLabel ?? 'release command';
  const captureOutput = options.captureOutput === true;
  // Test-only callers may preserve a verified nonzero child status. Settlement
  // proof remains mandatory; the production default still rejects it.
  const resolveNonZeroStatus = options.resolveNonZeroStatus === true;
  const nativeWindowsJob = platform === 'win32'
    && (spawnProcess === spawn || options.forceWindowsJob === true);
  const nativePosixSession = platform !== 'win32'
    && (spawnProcess === spawn || options.forcePosixSession === true);
  const productionNativePosix = process.platform === 'linux'
    && platform === 'linux' && spawnProcess === spawn
    && (options.posixSessionInvocation ?? createPosixSessionInvocation)
      === createPosixSessionInvocation;
  if (productionNativePosix && options.posixSessionControl === undefined) {
    const error = new Error('POSIX release maintenance binding is required before spawn');
    error.code = 'POSIX_RELEASE_MAINTENANCE_BINDING_REQUIRED';
    throw error;
  }
  const posixRecoveryScope = options.posixRecoveryScope ?? null;
  if (posixRecoveryScope !== null && (typeof posixRecoveryScope !== 'string'
      || Buffer.byteLength(posixRecoveryScope, 'utf8') > 8_192)) {
    throw new Error('POSIX release maintenance recovery scope is invalid');
  }
  const posixMaintenance = options.posixMaintenance;
  if (posixMaintenance !== undefined
      && (!posixMaintenance || typeof posixMaintenance !== 'object'
        || Array.isArray(posixMaintenance)
        || JSON.stringify(Object.keys(posixMaintenance).sort()) !== JSON.stringify([
          'quiescentMaintenanceAuthority', 'reclaimRetainedEvidence',
        ])
        || typeof posixMaintenance.reclaimRetainedEvidence !== 'function')) {
    throw new Error('POSIX release maintenance binding is invalid');
  }
  const windowsJobInvocation = options.windowsJobInvocation ?? createWindowsJobInvocation;
  const posixSessionInvocation = options.posixSessionInvocation ?? createPosixSessionInvocation;

  return new Promise((resolve, reject) => {
    let child;
    let invocation;
    let windowsJobControl;
    let posixSessionControl = options.posixSessionControl;
    const posixPublicationResidues = new Map();
    let posixRetirementAuthority;
    let posixStandaloneRecoveryAuthority;
    let posixWriterEgressEnded = true;
    let posixWriterEgressFailure;
    let posixWriterEgressObserver;
    let posixWriterEgressStream;
    let maybeFinish = () => {};
    let wrapperSpawned = false;
    const retainPosixPublicationResidue = (authority) => {
      const normalized = normalizePosixSessionPublicationResidue(
        authority, posixSessionControl.specification.controlDirectory,
      );
      posixPublicationResidues.set(JSON.stringify(normalized), normalized);
    };
    const capturePosixRecoveryAuthority = (source) => {
      const raw = source?.recoveryAuthority ?? source;
      const canonical = canonicalReleaseRecoveryAuthority(raw);
      if (canonical?.reservationOwner) {
        posixRetirementAuthority = canonical;
        return;
      }
      if (canonical?.publicationResidue) {
        posixPublicationResidues.set(
          JSON.stringify(canonical.publicationResidue), canonical.publicationResidue,
        );
        posixStandaloneRecoveryAuthority = canonical;
        return;
      }
      if (canonical?.publicationResidues) {
        for (const residue of canonical.publicationResidues) {
          posixPublicationResidues.set(JSON.stringify(residue), residue);
        }
        posixStandaloneRecoveryAuthority = canonical;
        return;
      }
      if (canonical) posixStandaloneRecoveryAuthority = canonical;
      else {
        try { retainPosixPublicationResidue(raw); } catch {}
      }
    };
    const posixRecoveryAuthority = () => posixRetirementAuthority
      ?? recoveryAuthorityForPosixSession(
        posixSessionControl, posixPublicationResidues.values(),
      ) ?? posixStandaloneRecoveryAuthority;
    try {
      if (nativeWindowsJob) {
        const suppliedControl = options.windowsJobControl
          ?? (windowsJobInvocation === createWindowsJobInvocation
            ? createWindowsJobControl({
              controlKey: options.windowsControlKey
                ?? `release:${path.resolve(options.cwd ?? process.cwd())}:${commandLabel}`,
              temporaryDirectory: options.windowsControlRoot,
            })
            : undefined);
        windowsJobControl = suppliedControl;
        invocation = windowsJobInvocation(
          command,
          args,
          options.cwd,
          killGraceMs,
          options.env,
          suppliedControl,
        );
      } else if (nativePosixSession) {
        const suppliedControl = posixSessionControl
          ?? (posixSessionInvocation === createPosixSessionInvocation
            ? createPosixSessionControl({
              controlKey: options.posixControlKey
                ?? `release:${path.resolve(options.cwd ?? process.cwd())}:${commandLabel}`,
              controlRoot: options.posixControlRoot,
              ...(posixMaintenance ?? {}),
            })
            : undefined);
        posixSessionControl = suppliedControl;
        invocation = posixSessionInvocation(
          command,
          args,
          options.cwd,
          killGraceMs,
          options.env,
          suppliedControl,
        );
        posixSessionControl = invocation.posixSessionControl ?? suppliedControl;
        if (!posixSessionControl) {
          throw new Error('POSIX session invocation did not provide its control authority');
        }
        if (invocation.writerEgress !== undefined) {
          if (invocation.writerEgress?.descriptor !== POSIX_SESSION_WRITER_EGRESS_FD
              || invocation.writerEgress.specification !== posixSessionControl.specification) {
            throw new Error('POSIX session writer egress authority is invalid');
          }
          posixWriterEgressEnded = false;
        }
      } else {
        invocation = { args, command };
      }
      windowsJobControl = invocation.windowsJobControl ?? windowsJobControl;
      const configuredStdio = captureOutput
        ? ['ignore', 'pipe', 'pipe'] : (options.stdio ?? 'inherit');
      const childStdio = nativePosixSession && invocation.writerEgress !== undefined
        ? stdioWithPosixWriterEgress(configuredStdio, invocation.writerEgress.descriptor)
        : configuredStdio;
      child = spawnProcess(invocation.command, invocation.args, {
        cwd: invocation.cwd ?? options.cwd,
        env: invocation.environment ?? options.env,
        detached: platform !== 'win32',
        shell: false,
        stdio: childStdio,
        windowsHide: true,
      });
      wrapperSpawned = true;
      windowsJobControl?.markWrapperSpawned?.();
      posixSessionControl?.markWrapperSpawned?.();
      if (nativePosixSession && invocation.writerEgress !== undefined) {
        posixWriterEgressStream = child?.stdio?.[invocation.writerEgress.descriptor];
        if (!posixWriterEgressStream) {
          throw new Error('POSIX session writer egress pipe is unavailable');
        }
        posixWriterEgressObserver = observePosixSessionWriterEgress(
          posixWriterEgressStream,
          invocation.writerEgress.specification,
          {
            onAuthority(authority) { retainPosixPublicationResidue(authority); },
            onEnd() {
              posixWriterEgressEnded = true;
              queueMicrotask(() => maybeFinish());
            },
            onProtocolFailure(error) { posixWriterEgressFailure = error; },
          },
        );
      }
    } catch (cause) {
      if (nativePosixSession) capturePosixRecoveryAuthority(cause);
      const primary = cause?.childSettlementUnproven === true
        ? cause
        : new Error(`${commandLabel} could not start`);
      posixWriterEgressObserver?.cancel?.();
      posixWriterEgressStream?.destroy?.();
      let disposalFailure;
      try {
        windowsJobControl?.dispose({ force: !wrapperSpawned });
        const retained = posixSessionControl?.dispose({
          force: !wrapperSpawned,
          recoveryScope: posixRecoveryScope,
        });
        if (nativePosixSession && retained !== undefined) {
          capturePosixRecoveryAuthority(retained);
        }
      } catch (disposalCause) {
        if (nativePosixSession) capturePosixRecoveryAuthority(disposalCause);
        disposalFailure = propagateReleaseRecovery(new Error(
          `${commandLabel} process controller disposal failed`,
          { cause: disposalCause },
        ), disposalCause);
        if (nativePosixSession && posixRecoveryAuthority()) {
          markSettlementUnproven(disposalFailure, posixRecoveryAuthority());
        }
      }
      const recoveryAuthority = nativeWindowsJob
        ? recoveryAuthorityForWindowsJob(windowsJobControl)
        : posixRecoveryAuthority();
      if (wrapperSpawned || recoveryAuthority) markSettlementUnproven(primary, recoveryAuthority);
      reject(disposalFailure
        ? releaseError(primary, [disposalFailure], disposalFailure.message)
        : primary);
      return;
    }

    const groupId = child.pid;
    const posixAuthority = platform !== 'win32' && !nativePosixSession
      ? createPosixProcessGroupAuthority(groupId, {
        inspectProcessGroup: options.inspectProcessGroup,
        requestSignal: options.requestPosixSignal
          ?? (typeof options.signalProcess === 'function'
            ? (signal) => options.signalProcess(undefined, signal)
            : undefined),
      })
      : undefined;
    const lifecycleErrors = [];
    const output = { stdout: [], stderr: [] };
    let outputBytes = 0;
    let primaryFailure;
    let leaderClosed = false;
    let closeCode = null;
    let closeSignal = null;
    let terminationStarted = false;
    let windowsTreeTerminated = false;
    let windowsSettlementProven = false;
    let windowsProofErrorRecorded = false;
    let settled = false;
    let hardTimer;
    let termTimer;
    let killTimer;
    let groupTimer;
    let spawnErrorTimer;

    const streamListeners = [];
    const clearLifecycle = () => {
      clearTimeout(hardTimer);
      clearTimeout(termTimer);
      clearTimeout(killTimer);
      clearTimeout(spawnErrorTimer);
      clearInterval(groupTimer);
      processObject.off?.('SIGINT', onInterrupt);
      processObject.off?.('SIGTERM', onTerminate);
      child.removeListener?.('error', onChildError);
      child.removeListener?.('close', onClose);
      posixWriterEgressObserver?.cancel?.();
      posixWriterEgressStream?.destroy?.();
      for (const [stream, event, listener] of streamListeners) {
        stream.removeListener(event, listener);
      }
    };
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearLifecycle();
      let completionError = error;
      if (nativeWindowsJob && !windowsSettlementProven) observeNativeWindowsSettlement();
      const provenWindowsDisposal = windowsSettlementProven
        || (!nativeWindowsJob && windowsTreeTerminated);
      if (provenWindowsDisposal) {
        try {
          windowsJobControl?.dispose();
        } catch (cause) {
          const disposalError = propagateReleaseRecovery(new Error(
            `${commandLabel} Windows Job controller disposal failed`,
            { cause },
          ), cause);
          completionError = completionError
            ? releaseError(completionError, [disposalError],
              `${commandLabel} failed and its Windows Job controller could not be disposed`)
            : disposalError;
        }
      } else if (nativeWindowsJob) {
        const settlementError = new Error(
          `${commandLabel} exact Windows Job-empty settlement was not proven`,
        );
        const recoveryAuthority = recoveryAuthorityForWindowsJob(windowsJobControl);
        markSettlementUnproven(settlementError, recoveryAuthority);
        completionError = completionError
          ? releaseError(completionError, [settlementError],
            `${commandLabel} failed with an unresolved Windows Job`)
          : settlementError;
        if (recoveryAuthority) markSettlementUnproven(completionError, recoveryAuthority);
      }
      if (nativePosixSession && posixSessionControl) {
        const writerSettlementError = !posixWriterEgressEnded
          ? new Error(`${commandLabel} POSIX session writer egress did not reach EOF`)
          : posixWriterEgressFailure
            ? new Error(`${commandLabel} POSIX session writer egress settlement is invalid`, {
              cause: posixWriterEgressFailure,
            })
            : posixPublicationResidues.size !== 0
              ? new Error(`${commandLabel} retained exact POSIX writer publication residue`)
              : null;
        const proof = posixSessionControl.proofState();
        if (!writerSettlementError && proof.state === 'absent') {
          try {
            const retained = posixSessionControl.dispose({ recoveryScope: posixRecoveryScope });
            if (retained !== undefined) {
              capturePosixRecoveryAuthority(retained);
              const disposalError = new Error(
                `${commandLabel} POSIX session retirement remains retained`,
              );
              markSettlementUnproven(disposalError, posixRecoveryAuthority());
              completionError = completionError
                ? releaseError(completionError, [disposalError],
                  `${commandLabel} failed with retained POSIX retirement evidence`)
                : disposalError;
            }
          } catch (cause) {
            capturePosixRecoveryAuthority(cause);
            const disposalError = propagateReleaseRecovery(new Error(
              `${commandLabel} POSIX session controller disposal failed`,
              { cause },
            ), cause);
            if (posixRecoveryAuthority()) {
              markSettlementUnproven(disposalError, posixRecoveryAuthority());
            }
            completionError = completionError
              ? releaseError(completionError, [disposalError],
                `${commandLabel} failed and its POSIX session controller could not be disposed`)
              : disposalError;
          }
        } else {
          const settlementError = writerSettlementError ?? new Error(
            `${commandLabel} POSIX session settlement could not be proven`,
            proof.error ? { cause: proof.error } : undefined,
          );
          const recoveryAuthority = posixRecoveryAuthority();
          markSettlementUnproven(settlementError, recoveryAuthority);
          completionError = completionError
            ? releaseError(completionError, [settlementError],
              `${commandLabel} failed with an unresolved POSIX session`)
            : settlementError;
          if (recoveryAuthority) markSettlementUnproven(completionError, recoveryAuthority);
        }
      }
      if (!leaderClosed) {
        child.on?.('error', () => {});
        child.unref?.();
      }
      if (completionError) reject(completionError);
      else resolve(Object.freeze({
        status: closeCode,
        signal: closeSignal,
        stdout: captureOutput ? Buffer.concat(output.stdout).toString('utf8') : '',
        stderr: captureOutput ? Buffer.concat(output.stderr).toString('utf8') : '',
      }));
    };
    const groupState = () => {
      if (platform === 'win32') return { state: 'unknown' };
      if (nativePosixSession) return posixSessionControl.proofState();
      return inspectAuthorityState(posixAuthority);
    };
    const addLifecycleError = (message, cause) => {
      lifecycleErrors.push(cause ? new Error(message, { cause }) : new Error(message));
    };
    const observeNativeWindowsSettlement = () => {
      if (!nativeWindowsJob || !windowsJobControl) return false;
      const proof = windowsJobControl.proofState();
      if (proof.state === 'absent') {
        windowsSettlementProven = true;
        windowsTreeTerminated = true;
        return true;
      }
      if (proof.error && !windowsProofErrorRecorded) {
        windowsProofErrorRecorded = true;
        addLifecycleError(
          `${commandLabel} Windows Job-empty proof validation failed`,
          proof.error,
        );
      }
      return false;
    };
    const terminalFailure = (fallback) => {
      const primary = primaryFailure ?? fallback;
      finish(releaseError(primary, lifecycleErrors,
        `${commandLabel} failed and its process lifecycle could not be completed cleanly`));
    };
    maybeFinish = () => {
      if (settled || !leaderClosed) return;
      const group = groupState();
      if (platform !== 'win32' && group.state !== 'absent') return;
      if (nativePosixSession && !posixWriterEgressEnded) return;
      if (platform === 'win32' && terminationStarted && !windowsTreeTerminated) return;
      if (platform === 'win32' && !terminationStarted && !windowsSettlementProven) return;
      if (primaryFailure) {
        terminalFailure(primaryFailure);
        return;
      }
      if (closeCode !== 0 && !resolveNonZeroStatus) {
        primaryFailure = new Error(
          `${commandLabel} failed (${closeSignal || `status ${closeCode ?? 'unknown'}`})`,
        );
        terminalFailure(primaryFailure);
        return;
      }
      finish();
    };
    const sendSignal = (signal) => {
      try {
        if (!groupId) return false;
        if (platform === 'win32') {
          if (nativeWindowsJob) {
            windowsJobControl.request(signal);
          } else {
            const taskkillArgs = ['/PID', String(groupId), '/T'];
            if (signal === 'SIGKILL') taskkillArgs.push('/F');
            const result = windowsTreeKill('taskkill.exe', taskkillArgs, {
              killSignal: 'SIGKILL',
              shell: false,
              stdio: 'ignore',
              timeout: signal === 'SIGKILL' ? killGraceMs : terminateGraceMs,
              windowsHide: true,
            });
            if (result?.error) throw result.error;
            if (result?.status !== 0) {
              throw Object.assign(new Error('taskkill failed'), {
                code: `status-${result?.status ?? 'unknown'}`,
              });
            }
            windowsTreeTerminated = true;
          }
        } else {
          if (nativePosixSession) posixSessionControl.request(signal);
          else {
            if (!posixAuthority) return false;
            posixAuthority.signal(signal);
          }
        }
        return true;
      } catch (error) {
        if (nativePosixSession) capturePosixRecoveryAuthority(error);
        if (error?.code !== 'ESRCH') {
          addLifecycleError(`${commandLabel} ${signal} delivery failed`, error);
        }
        return error?.code === 'ESRCH';
      }
    };
    const startTermination = (failure) => {
      if (!primaryFailure) primaryFailure = failure;
      if (terminationStarted) return;
      terminationStarted = true;
      windowsTreeTerminated = false;
      const termDelivered = sendSignal('SIGTERM');
      if (platform === 'win32' && leaderClosed) {
        if (nativeWindowsJob) observeNativeWindowsSettlement();
        if (!termDelivered) {
          windowsTreeTerminated = false;
          sendSignal('SIGKILL');
        }
        if (!windowsTreeTerminated) {
          addLifecycleError(`${commandLabel} process tree termination could not be proven`);
        }
        terminalFailure(failure);
        return;
      }
      if (platform !== 'win32') groupTimer = setInterval(maybeFinish, GROUP_POLL_MS);
      termTimer = setTimeout(() => {
        if (platform === 'win32') windowsTreeTerminated = false;
        sendSignal('SIGKILL');
        maybeFinish();
        if (settled) return;
        killTimer = setTimeout(() => {
          if (settled) return;
          const group = groupState();
          if (!leaderClosed) {
            addLifecycleError(`${commandLabel} leader did not reach close/reap after SIGKILL deadline`);
          }
          if (platform === 'win32' && !windowsTreeTerminated) {
            addLifecycleError(`${commandLabel} process tree termination could not be proven`);
          } else if (platform !== 'win32' && group.state === 'alive') {
            addLifecycleError(`${commandLabel} process group remained alive after SIGKILL deadline`);
          } else if (platform !== 'win32' && group.state === 'unknown') {
            addLifecycleError(`${commandLabel} process group termination could not be proven`);
          }
          terminalFailure(new Error(`${commandLabel} lifecycle deadline expired`));
        }, killGraceMs);
      }, terminateGraceMs);
      maybeFinish();
    };
    const onInterrupt = () => startTermination(new Error(`${commandLabel} was interrupted`));
    const onTerminate = () => startTermination(new Error(`${commandLabel} was terminated`));
    const onChildError = (error) => {
      const childFailure = new Error(`${commandLabel} could not start`, { cause: error });
      if (!primaryFailure) primaryFailure = childFailure;
      else addLifecycleError(`${commandLabel} emitted another asynchronous child error`, childFailure);
      if (groupId) startTermination(primaryFailure);
      else if (!spawnErrorTimer) {
        spawnErrorTimer = setTimeout(() => terminalFailure(primaryFailure), killGraceMs);
      }
    };
    const onClose = (code, signal) => {
      leaderClosed = true;
      closeCode = code;
      closeSignal = signal;
      if (nativePosixSession) {
        posixSessionControl.observeWrapperClose?.(code, signal);
        const status = posixSessionControl.targetStatus?.();
        if (status?.state === 'present') {
          closeCode = status.exitCode;
          closeSignal = status.signal;
          if (status.errorCode && !primaryFailure) {
            primaryFailure = new Error(`${commandLabel} could not start`);
          }
        } else if (!primaryFailure) {
          primaryFailure = new Error(`${commandLabel} target status was not proven`);
        }
      }
      const semanticCode = nativePosixSession ? closeCode : code;
      const semanticSignal = nativePosixSession ? closeSignal : signal;
      if (!terminationStarted && semanticCode !== 0 && !resolveNonZeroStatus) {
        primaryFailure = new Error(
          `${commandLabel} failed (${semanticSignal || `status ${semanticCode ?? 'unknown'}`})`,
        );
      }
      if (!terminationStarted && platform === 'win32' && code !== 0 && !resolveNonZeroStatus) {
        startTermination(primaryFailure);
        return;
      }
      if (!terminationStarted && platform === 'win32') {
        let proof;
        try {
          proof = nativeWindowsJob
            ? (observeNativeWindowsSettlement()
              ? { activeProcesses: 0, authority: WINDOWS_JOB_PROTOCOL }
              : null)
            : options.windowsSettlementProof?.({ pid: groupId });
        } catch (error) {
          addLifecycleError(`${commandLabel} Windows descendant settlement probe failed`, error);
        }
        if (proof?.authority !== WINDOWS_JOB_PROTOCOL || proof.activeProcesses !== 0) {
          startTermination(new Error(
            `${commandLabel} Windows descendant settlement was not proven after leader success`,
          ));
          return;
        }
        windowsSettlementProven = true;
      }
      if (terminationStarted && nativeWindowsJob) observeNativeWindowsSettlement();
      const group = groupState();
      if (!terminationStarted && platform !== 'win32' && group.state !== 'absent') {
        startTermination(primaryFailure ?? new Error(
          `${commandLabel} left a descendant process group after its leader exited`,
        ));
        return;
      }
      maybeFinish();
    };

    const capture = (name, stream) => {
      if (!stream?.on) {
        startTermination(new Error(`${commandLabel} ${name} stream is unavailable`));
        return;
      }
      const onData = (chunk) => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        outputBytes += bytes.length;
        if (outputBytes > maxOutputBytes) {
          startTermination(new Error(`${commandLabel} output exceeded its byte limit`));
          try { stream.destroy(); } catch {}
          return;
        }
        output[name].push(bytes);
      };
      const onStreamError = (error) => startTermination(
        new Error(`${commandLabel} ${name} stream failed`, { cause: error }),
      );
      stream.on('data', onData);
      stream.on('error', onStreamError);
      streamListeners.push([stream, 'data', onData], [stream, 'error', onStreamError]);
    };

    child.on('error', onChildError);
    child.once('close', onClose);
    processObject.on?.('SIGINT', onInterrupt);
    processObject.on?.('SIGTERM', onTerminate);
    hardTimer = setTimeout(() => startTermination(
      new Error(`${commandLabel} exceeded its hard deadline`),
    ), hardTimeoutMs);
    if (captureOutput) {
      capture('stdout', child.stdout);
      capture('stderr', child.stderr);
    }

  });
}
