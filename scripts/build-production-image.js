import crypto from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

import { assertNoSecretBytes } from './secret-scan-contract.js';
import { propagateLifecycleRecovery } from './bounded-child-lifecycle.js';
import {
  createWindowsJobControl,
  createWindowsJobInvocation,
} from './release-command-supervisor.js';
import {
  createPosixSessionControl,
  createPosixSessionInvocation,
} from './posix-session-supervisor.js';
import {
  DEFAULT_CANDIDATE_MANIFEST,
  gitTrackedFiles,
  parseCandidateFileManifest,
  readCandidateFileManifest,
  validateAuditedPathSet,
  verifyDockerBuildContext,
} from './verify-docker-context.js';

const projectDirectory = fileURLToPath(new URL('..', import.meta.url));
const CONTEXT_MARKER = 'aisy-production-docker-context-v2';
const PRODUCTION_IMAGE = 'easyboost-production-app:local';
const TAR_BLOCK_SIZE = 512;
const TAR_END = Buffer.alloc(TAR_BLOCK_SIZE * 2);
const FULL_COMMIT_IDENTITY = /^[0-9a-f]{40}$/u;
const NODE_BASE_IMAGE_PATTERN = /^node:22-bookworm-slim@sha256:[0-9a-f]{64}$/u;

function requireNodeBaseImage(environment) {
  const authority = environment?.EASYBOOST_NODE_BASE_IMAGE;
  if (!NODE_BASE_IMAGE_PATTERN.test(authority || '')) {
    throw new Error(
      'Production Node base image must be owner-reviewed node:22-bookworm-slim@sha256:<64-lowercase-hex>',
    );
  }
  return authority;
}

function gitOutput(sourceDirectory, args, failure) {
  try {
    return execFileSync('git', args, {
      cwd: sourceDirectory,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    }).trim();
  } catch {
    throw new Error(`Production release exact Git checkout ${failure}`);
  }
}

function assertDetachedHead(sourceDirectory) {
  try {
    execFileSync('git', ['symbolic-ref', '--quiet', 'HEAD'], {
      cwd: sourceDirectory,
      encoding: 'utf8',
    });
  } catch (error) {
    if (error?.status === 1) return;
    throw new Error('Production release checkout HEAD attachment is unreadable');
  }
  throw new Error('Production release exact checkout must use a detached HEAD');
}

function assertExactReleaseCheckout({ sourceDirectory, expectedCommit }) {
  if (!FULL_COMMIT_IDENTITY.test(expectedCommit)) {
    throw new Error('Production release commit identity must be a full lowercase 40-character SHA');
  }
  const topLevel = gitOutput(sourceDirectory, ['rev-parse', '--show-toplevel'],
    'is missing or unreadable');
  let actualRoot;
  let expectedRoot;
  let actualRootStat;
  let expectedRootStat;
  try {
    actualRoot = fs.realpathSync(topLevel);
    expectedRoot = fs.realpathSync(sourceDirectory);
    actualRootStat = fs.statSync(actualRoot, { bigint: true });
    expectedRootStat = fs.statSync(expectedRoot, { bigint: true });
  } catch {
    throw new Error('Production release exact Git checkout root is unreadable');
  }
  if (!actualRootStat.isDirectory() || !expectedRootStat.isDirectory()
      || actualRootStat.dev !== expectedRootStat.dev || actualRootStat.ino !== expectedRootStat.ino) {
    throw new Error('Production release build directory must be the exact Git checkout root');
  }
  assertDetachedHead(sourceDirectory);
  const head = gitOutput(sourceDirectory, ['rev-parse', '--verify', 'HEAD'],
    'HEAD is missing or unreadable');
  if (head !== expectedCommit) {
    throw new Error('Production release checkout HEAD does not match the owner-approved commit identity');
  }
  const status = gitOutput(sourceDirectory,
    ['status', '--porcelain=v1', '--untracked-files=all'], 'status is unreadable');
  if (status) throw new Error('Production release exact Git checkout is not clean');
  const trackedFiles = gitTrackedFiles(sourceDirectory);
  const tracked = new Set(trackedFiles);
  const candidateFiles = readCandidateFileManifest({ projectDirectory: sourceDirectory });
  const untrackedCandidate = candidateFiles.find((file) => !tracked.has(file));
  if (untrackedCandidate) {
    throw new Error(`Production release candidate is not tracked by the exact checkout: ${untrackedCandidate}`);
  }
  return { head, trackedFiles };
}

function identity(stat) {
  return [
    stat.dev, stat.ino, stat.mode, stat.nlink, stat.size, stat.mtimeNs, stat.ctimeNs,
  ].map(String).join(':');
}

function directoryIdentity(stat) {
  return [stat.dev, stat.ino, stat.mode].map(String).join(':');
}

function directoryNames(files) {
  const names = new Set(['']);
  for (const file of files) {
    let current = path.posix.dirname(file);
    while (current !== '.') {
      names.add(current);
      current = path.posix.dirname(current);
    }
  }
  return [...names].sort((left, right) => left.localeCompare(right, 'en'));
}

function snapshotDirectories(rootDirectory, names, expected) {
  const result = new Map();
  for (const name of names) {
    const absolute = name ? path.join(rootDirectory, name) : rootDirectory;
    const stat = fs.lstatSync(absolute, { bigint: true });
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`Production context ancestor is not a real directory: ${name || '.'}`);
    }
    const current = directoryIdentity(stat);
    if (expected && expected.get(name) !== current) {
      throw new Error(`Production context ancestor identity changed: ${name || '.'}`);
    }
    result.set(name, current);
  }
  return result;
}

function assertFileAncestors(rootDirectory, file, expectedDirectories) {
  const names = [''];
  let current = path.posix.dirname(file);
  while (current !== '.') {
    names.push(current);
    current = path.posix.dirname(current);
  }
  snapshotDirectories(rootDirectory, names, expectedDirectories);
}

function readStableFile(rootDirectory, file, expected, expectedDirectories) {
  assertFileAncestors(rootDirectory, file, expectedDirectories);
  const absolute = path.join(rootDirectory, file);
  const before = fs.lstatSync(absolute, { bigint: true });
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new Error(`Production context source is not a regular file: ${file}`);
  }
  const beforeIdentity = identity(before);
  if (expected && expected.identity !== beforeIdentity) {
    throw new Error(`Production context source identity changed: ${file}`);
  }

  const noFollow = fs.constants.O_NOFOLLOW ?? 0;
  let descriptor;
  try {
    descriptor = fs.openSync(absolute, fs.constants.O_RDONLY | noFollow);
  } catch {
    throw new Error(`Production context source could not be opened safely: ${file}`);
  }
  let body;
  let opened;
  let afterRead;
  try {
    opened = fs.fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || identity(opened) !== beforeIdentity) {
      throw new Error(`Production context source identity changed while opening: ${file}`);
    }
    body = fs.readFileSync(descriptor);
    afterRead = fs.fstatSync(descriptor, { bigint: true });
    if (identity(afterRead) !== beforeIdentity) {
      throw new Error(`Production context source changed while reading: ${file}`);
    }
  } finally {
    fs.closeSync(descriptor);
  }

  const after = fs.lstatSync(absolute, { bigint: true });
  if (after.isSymbolicLink() || !after.isFile() || identity(after) !== beforeIdentity) {
    throw new Error(`Production context source changed after reading: ${file}`);
  }
  assertFileAncestors(rootDirectory, file, expectedDirectories);
  const digest = crypto.createHash('sha256').update(body).digest('hex');
  if (expected && (expected.digest !== digest || expected.size !== body.length)) {
    throw new Error(`Production context source bytes changed: ${file}`);
  }
  assertNoSecretBytes({ file, bytes: body });
  return {
    body,
    digest,
    identity: beforeIdentity,
    mode: Number(before.mode & 0o777n),
    size: body.length,
  };
}

function splitTarPath(file) {
  if (Buffer.byteLength(file, 'utf8') <= 100) return { name: file, prefix: '' };
  const separators = [...file.matchAll(/\//gu)].map((match) => match.index).reverse();
  for (const separator of separators) {
    const prefix = file.slice(0, separator);
    const name = file.slice(separator + 1);
    if (Buffer.byteLength(prefix, 'utf8') <= 155 && Buffer.byteLength(name, 'utf8') <= 100) {
      return { name, prefix };
    }
  }
  throw new Error(`Docker context path cannot be represented by USTAR: ${file}`);
}

function writeText(header, offset, length, value, label) {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length > length) throw new Error(`USTAR ${label} is too long`);
  bytes.copy(header, offset);
}

function writeOctal(header, offset, length, value, label) {
  const octal = BigInt(value).toString(8);
  if (octal.length > length - 1) throw new Error(`USTAR ${label} overflows`);
  header.write(`${octal.padStart(length - 1, '0')}\0`, offset, length, 'ascii');
}

function tarHeader(entry) {
  const header = Buffer.alloc(TAR_BLOCK_SIZE);
  const { name, prefix } = splitTarPath(entry.file);
  writeText(header, 0, 100, name, 'name');
  writeOctal(header, 100, 8, entry.mode, 'mode');
  writeOctal(header, 108, 8, 0, 'uid');
  writeOctal(header, 116, 8, 0, 'gid');
  writeOctal(header, 124, 12, entry.size, 'size');
  writeOctal(header, 136, 12, 0, 'mtime');
  header.fill(0x20, 148, 156);
  header[156] = '0'.charCodeAt(0);
  writeText(header, 257, 6, 'ustar\0', 'magic');
  writeText(header, 263, 2, '00', 'version');
  writeText(header, 345, 155, prefix, 'prefix');
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  const encodedChecksum = checksum.toString(8).padStart(6, '0');
  if (encodedChecksum.length > 6) throw new Error('USTAR checksum overflows');
  header.write(encodedChecksum, 148, 6, 'ascii');
  header[154] = 0;
  header[155] = 0x20;
  return header;
}

function contextLength(entries) {
  return entries.reduce((total, entry) => (
    total + TAR_BLOCK_SIZE + Math.ceil(entry.size / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE
  ), TAR_END.length);
}

function freezeProductionContext({ sourceDirectory, trackedFiles, candidateFiles }) {
  const tracked = trackedFiles ?? gitTrackedFiles(sourceDirectory);
  let manifestControl;
  let explicit = candidateFiles;
  if (!explicit) {
    const manifestDirectories = snapshotDirectories(
      sourceDirectory, directoryNames([DEFAULT_CANDIDATE_MANIFEST]),
    );
    manifestControl = readStableFile(
      sourceDirectory, DEFAULT_CANDIDATE_MANIFEST, undefined, manifestDirectories,
    );
    explicit = parseCandidateFileManifest({
      projectDirectory: sourceDirectory,
      manifestName: DEFAULT_CANDIDATE_MANIFEST,
      source: manifestControl.body.toString('utf8'),
    });
  }
  const audited = new Set(validateAuditedPathSet([...tracked, ...explicit]));
  const controlFiles = manifestControl
    ? [DEFAULT_CANDIDATE_MANIFEST, '.dockerignore', 'Dockerfile']
    : ['.dockerignore', 'Dockerfile'];
  for (const required of controlFiles) {
    if (!audited.has(required)) throw new Error(`Production context control file is not audited: ${required}`);
  }
  const controlDirectoryList = directoryNames(controlFiles);
  const controlDirectories = snapshotDirectories(sourceDirectory, controlDirectoryList);
  const controls = new Map(manifestControl
    ? [[DEFAULT_CANDIDATE_MANIFEST, manifestControl]]
    : []);
  for (const file of ['.dockerignore', 'Dockerfile']) {
    controls.set(file, readStableFile(sourceDirectory, file, undefined, controlDirectories));
  }
  const verified = verifyDockerBuildContext({
    projectDirectory: sourceDirectory,
    trackedFiles: tracked,
    candidateFiles: explicit,
    dockerfileSource: controls.get('Dockerfile').body.toString('utf8'),
    dockerignoreSource: controls.get('.dockerignore').body.toString('utf8'),
  });
  const files = [...new Set([...controlFiles, ...verified.reachable])].sort();
  const directoryList = directoryNames(files);
  const directories = snapshotDirectories(sourceDirectory, directoryList);
  const entries = [];
  const hash = crypto.createHash('sha256');
  hash.update(`${CONTEXT_MARKER}\0`);
  let bytes = 0;
  for (const file of files) {
    const control = controls.get(file);
    const frozen = control
      ? readStableFile(sourceDirectory, file, control, directories)
      : readStableFile(sourceDirectory, file, undefined, directories);
    const entry = { file, ...frozen };
    if (control) entry.controlBody = control.body;
    delete entry.body;
    entries.push(entry);
    bytes += entry.size;
    hash.update(`F\0${file}\0${entry.mode}\0${entry.size}\0${entry.digest}\0`);
  }
  snapshotDirectories(sourceDirectory, directoryList, directories);
  return {
    bytes,
    contextBytes: contextLength(entries),
    directories,
    directoryList,
    entries,
    fingerprint: hash.digest('hex'),
    sourceDirectory,
  };
}

function immutableContext(frozen) {
  const state = { completed: false, emitted: 0 };
  async function* stream() {
    for (const entry of frozen.entries) {
      const current = readStableFile(
        frozen.sourceDirectory, entry.file, entry, frozen.directories,
      );
      const header = tarHeader(entry);
      state.emitted += header.length;
      yield header;
      const body = entry.controlBody ?? current.body;
      state.emitted += body.length;
      yield body;
      const paddingLength = Math.ceil(body.length / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE
        - body.length;
      if (paddingLength) {
        const padding = Buffer.alloc(paddingLength);
        state.emitted += padding.length;
        yield padding;
      }
    }
    snapshotDirectories(
      frozen.sourceDirectory, frozen.directoryList, frozen.directories,
    );
    state.emitted += TAR_END.length;
    yield TAR_END;
    state.completed = true;
  }
  return { context: stream(), state };
}

function recoveryAuthorityFor(control, proofFileName) {
  if (control?.recoveryAuthority?.controlDirectory) return control.recoveryAuthority;
  const proofPath = control?.specification?.proofPath
    ?? control?.specification?.controlDirectory;
  if (typeof proofPath !== 'string' || !path.isAbsolute(proofPath)) return undefined;
  const controlDirectory = control?.specification?.controlDirectory
    ?? path.dirname(proofPath);
  if (!path.isAbsolute(controlDirectory)
      || (proofFileName && path.basename(proofPath) !== proofFileName)) return undefined;
  return Object.freeze({ controlDirectory });
}

function markSettlementUnproven(error, recoveryAuthority) {
  // An unresolved child is actionable only when the caller receives the durable
  // same-scope guard that prevents a later invocation from starting beside it.
  if (!recoveryAuthority) return error;
  error.childSettlementUnproven = true;
  error.recoveryAuthority = recoveryAuthority;
  return error;
}

export async function runDockerBuild(command, args, options, context, lifecycle = {}) {
  const bounds = {
    hardTimeoutMs: lifecycle.hardTimeoutMs ?? 15 * 60_000,
    terminateGraceMs: lifecycle.terminateGraceMs ?? 5_000,
    killGraceMs: lifecycle.killGraceMs ?? 5_000,
  };
  for (const [name, value] of Object.entries(bounds)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`Invalid Docker child lifecycle bound: ${name}`);
    }
  }
  const spawnProcess = lifecycle.spawnProcess ?? spawn;
  const platform = lifecycle.platform ?? process.platform;
  const nativeWindowsJob = platform === 'win32'
    && (spawnProcess === spawn || lifecycle.forceWindowsJob === true);
  const nativePosixSession = platform !== 'win32'
    && (spawnProcess === spawn || lifecycle.forcePosixSession === true);
  const windowsJobInvocation = lifecycle.windowsJobInvocation ?? createWindowsJobInvocation;
  const posixSessionInvocation = lifecycle.posixSessionInvocation ?? createPosixSessionInvocation;

  let child;
  let windowsJobControl;
  let posixSessionControl;
  let windowsControlDisposed = false;
  let posixControlDisposed = false;
  let wrapperSpawned = false;
  const disposeWindowsControl = ({ force = false } = {}) => {
    if (!windowsJobControl || windowsControlDisposed) return null;
    try {
      windowsJobControl.dispose(force ? { force: true } : undefined);
      windowsControlDisposed = true;
      return null;
    } catch (cause) {
      return propagateLifecycleRecovery(
        new Error('Docker build Windows Job controller disposal failed', { cause }),
        cause,
      );
    }
  };
  const disposePosixControl = ({ force = false } = {}) => {
    if (!posixSessionControl || posixControlDisposed) return null;
    try {
      posixSessionControl.dispose(force ? { force: true } : undefined);
      posixControlDisposed = true;
      return null;
    } catch (cause) {
      return new Error('Docker build POSIX session controller disposal failed', { cause });
    }
  };
  try {
    const suppliedWindowsControl = nativeWindowsJob
      ? (lifecycle.windowsJobControl
        ?? (windowsJobInvocation === createWindowsJobInvocation
          ? createWindowsJobControl({
            controlKey: lifecycle.windowsControlKey
              ?? `docker-build:${path.resolve(options.cwd ?? process.cwd())}`,
            temporaryDirectory: lifecycle.windowsControlRoot,
          })
          : undefined))
      : undefined;
    windowsJobControl = suppliedWindowsControl;
    const windowsInvocation = nativeWindowsJob
      ? windowsJobInvocation(
        command,
        args,
        options.cwd,
        bounds.killGraceMs,
        options.env,
        suppliedWindowsControl,
      )
      : null;
    windowsJobControl = windowsInvocation?.windowsJobControl ?? windowsJobControl;
    if (nativeWindowsJob && !windowsJobControl) {
      throw new Error('Windows Job controller authority is unavailable');
    }
    const suppliedPosixControl = nativePosixSession
      ? (lifecycle.posixSessionControl
        ?? (posixSessionInvocation === createPosixSessionInvocation
          ? createPosixSessionControl({
            controlKey: lifecycle.posixControlKey
              ?? `docker-build:${path.resolve(options.cwd ?? process.cwd())}`,
            controlRoot: lifecycle.posixControlRoot,
          })
          : undefined))
      : undefined;
    posixSessionControl = suppliedPosixControl;
    const posixInvocation = nativePosixSession
      ? posixSessionInvocation(
        command,
        args,
        options.cwd,
        bounds.killGraceMs,
        options.env,
        suppliedPosixControl,
      )
      : null;
    posixSessionControl = posixInvocation?.posixSessionControl ?? posixSessionControl;
    if (nativePosixSession && !posixSessionControl) {
      throw new Error('POSIX session controller authority is unavailable');
    }
    const childCommand = posixInvocation?.command ?? windowsInvocation?.command ?? command;
    const childArgs = posixInvocation?.args ?? windowsInvocation?.args ?? args;
    child = spawnProcess(childCommand, childArgs, {
      ...options,
      cwd: posixInvocation?.cwd ?? windowsInvocation?.cwd ?? options.cwd,
      env: posixInvocation?.environment ?? windowsInvocation?.environment ?? options.env,
      detached: nativePosixSession,
      shell: false,
      stdio: ['pipe', 'inherit', 'inherit'],
    });
    // From this point a controller directory is the only durable recovery guard
    // for this target. Never force-remove it, even if bookkeeping below fails.
    wrapperSpawned = true;
    windowsJobControl?.markWrapperSpawned?.();
    posixSessionControl?.markWrapperSpawned?.();
  } catch (cause) {
    const recoveryAuthority = nativeWindowsJob
      ? recoveryAuthorityFor(windowsJobControl, 'job-empty.proof')
      : recoveryAuthorityFor(posixSessionControl);
    const primary = cause?.childSettlementUnproven === true
      ? cause
      : new Error('Docker build process could not start', { cause });
    if (wrapperSpawned) markSettlementUnproven(primary, recoveryAuthority);
    const disposalFailure = disposeWindowsControl({ force: !wrapperSpawned });
    const posixDisposalFailure = disposePosixControl({ force: !wrapperSpawned });
    const disposalFailures = [disposalFailure, posixDisposalFailure].filter(Boolean);
    if (disposalFailures.length) {
      throw new AggregateError(
        [primary, ...disposalFailures],
        `${primary.message}; ${disposalFailures.map((error) => error.message).join('; ')}`,
        { cause: primary },
      );
    }
    throw primary;
  }

  let completionResolved = false;
  let childClosed = false;
  let resolveCompletion;
  let terminationReason = '';
  let hardTimer;
  let termTimer;
  let killTimer;
  const terminationErrors = [];
  const completion = new Promise((resolve) => { resolveCompletion = resolve; });
  const finish = (outcome) => {
    if (completionResolved) return;
    completionResolved = true;
    clearTimeout(hardTimer);
    clearTimeout(termTimer);
    clearTimeout(killTimer);
    resolveCompletion(outcome);
  };
  const settleClosedWindowsControl = () => {
    if (!nativeWindowsJob) return null;
    let proof;
    try {
      proof = windowsJobControl.proofState();
    } catch (cause) {
      proof = { error: cause, state: 'unknown' };
    }
    if (proof?.state === 'absent') return disposeWindowsControl();
    const proofFailure = new Error(
      'Docker build exact Windows Job-empty proof was unavailable after wrapper close',
      proof?.error ? { cause: proof.error } : undefined,
    );
    return markSettlementUnproven(
      proofFailure,
      recoveryAuthorityFor(windowsJobControl, 'job-empty.proof'),
    );
  };
  const settleClosedPosixControl = (status, signal) => {
    if (!nativePosixSession) return { lifecycleFailure: null, signal, status };
    posixSessionControl.observeWrapperClose?.(status, signal);
    const targetStatus = posixSessionControl.targetStatus?.();
    const effective = targetStatus?.state === 'present'
      ? { signal: targetStatus.signal, status: targetStatus.exitCode }
      : { signal, status };
    let proof;
    try {
      proof = posixSessionControl.proofState();
    } catch (cause) {
      proof = { error: cause, state: 'unknown' };
    }
    if (proof?.state === 'absent') {
      return { ...effective, lifecycleFailure: disposePosixControl() };
    }
    const lifecycleFailure = new Error(
      'Docker build exact POSIX session settlement proof was unavailable after wrapper close',
      proof?.error ? { cause: proof.error } : undefined,
    );
    return {
      ...effective,
      lifecycleFailure: markSettlementUnproven(
        lifecycleFailure,
        recoveryAuthorityFor(posixSessionControl),
      ),
    };
  };
  const childErrors = [];
  const onError = (error) => {
    childErrors.push(error);
  };
  const onClose = (status, signal) => {
    childClosed = true;
    const error = childErrors.length > 1
      ? new AggregateError(childErrors, 'Docker build process emitted multiple asynchronous errors', {
        cause: childErrors[0],
      })
      : childErrors[0];
    const posixSettlement = settleClosedPosixControl(status, signal);
    const lifecycleFailures = [
      settleClosedWindowsControl(),
      posixSettlement.lifecycleFailure,
    ].filter(Boolean);
    const lifecycleFailure = lifecycleFailures.length > 1
      ? propagateLifecycleRecovery(
        new AggregateError(lifecycleFailures, 'Docker build lifecycle proofs failed', {
          cause: lifecycleFailures[0],
        }),
        ...lifecycleFailures,
      )
      : lifecycleFailures[0];
    finish({
      status: posixSettlement.status,
      signal: posixSettlement.signal,
      error,
      ...(lifecycleFailure ? { lifecycleFailure } : {}),
    });
  };
  child.on('error', onError);
  child.once('close', onClose);

  const deliverTermination = (signal) => {
    try {
      if (nativeWindowsJob) windowsJobControl.request(signal);
      else if (nativePosixSession) posixSessionControl.request(signal);
      else {
        throw new Error('Docker build has no owned process-tree signal authority');
      }
    } catch (cause) {
      terminationErrors.push(new Error(`Docker build ${signal} delivery failed`, { cause }));
    }
  };
  const terminate = (reason) => {
    if (terminationReason || completionResolved) return;
    terminationReason = reason;
    try { child.stdin.destroy(); } catch {}
    deliverTermination('SIGTERM');
    if (completionResolved) return;
    termTimer = setTimeout(() => {
      if (completionResolved) return;
      deliverTermination('SIGKILL');
      if (completionResolved) return;
      killTimer = setTimeout(() => {
        if (completionResolved) return;
        const terminal = new Error(
          'Docker build process did not reach close/reap after its SIGKILL deadline',
        );
        const windowsProofFailure = nativeWindowsJob
          ? new Error('Docker build exact Windows Job-empty proof was unavailable before return')
          : null;
        if (windowsProofFailure) {
          markSettlementUnproven(
            windowsProofFailure,
            recoveryAuthorityFor(windowsJobControl, 'job-empty.proof'),
          );
        }
        const posixProofFailure = nativePosixSession
          ? new Error('Docker build exact POSIX session proof was unavailable before return')
          : null;
        if (posixProofFailure) {
          markSettlementUnproven(
            posixProofFailure,
            recoveryAuthorityFor(posixSessionControl),
          );
        }
        const failures = [
          ...terminationErrors,
          terminal,
          windowsProofFailure,
          posixProofFailure,
        ].filter(Boolean);
        const lifecycleFailure = failures.length === 1 ? failures[0] : new AggregateError(
          failures,
          `Docker build termination failed: ${failures.map((error) => error.message).join('; ')}`,
          { cause: failures[0] },
        );
        const recoveryAuthority = (windowsProofFailure || posixProofFailure)?.recoveryAuthority;
        if (recoveryAuthority) {
          markSettlementUnproven(lifecycleFailure, recoveryAuthority);
        }
        const error = childErrors.length > 1
          ? new AggregateError(childErrors, 'Docker build process emitted multiple asynchronous errors', {
            cause: childErrors[0],
          })
          : childErrors[0];
        finish({ status: null, signal: null, error, lifecycleFailure });
      }, bounds.killGraceMs);
    }, bounds.terminateGraceMs);
  };
  const onParentInterrupt = () => terminate('was interrupted');
  const onParentTerminate = () => terminate('was terminated');
  process.on('SIGINT', onParentInterrupt);
  process.on('SIGTERM', onParentTerminate);

  hardTimer = setTimeout(() => terminate('exceeded its hard deadline'), bounds.hardTimeoutMs);
  const streamed = pipeline(Readable.from(context), child.stdin)
    .then(() => ({ complete: true, error: undefined }))
    .catch((error) => ({ complete: false, error }));

  let outcome;
  let streamResult;
  try {
    outcome = await completion;
    streamResult = await streamed;
  } finally {
    clearTimeout(hardTimer);
    clearTimeout(termTimer);
    clearTimeout(killTimer);
    if (childClosed) {
      child.removeListener('error', onError);
      child.removeListener('close', onClose);
    } else {
      child.unref?.();
      child.stdin?.unref?.();
      child.stdout?.unref?.();
      child.stderr?.unref?.();
    }
    process.off('SIGINT', onParentInterrupt);
    process.off('SIGTERM', onParentTerminate);
    try { child.stdin.destroy(); } catch {}
    if (nativeWindowsJob && !windowsControlDisposed && childClosed
        && outcome?.lifecycleFailure?.childSettlementUnproven !== true) {
      const retryFailure = disposeWindowsControl();
      if (retryFailure) {
        outcome.lifecycleFailure = outcome.lifecycleFailure
          ? propagateLifecycleRecovery(new AggregateError(
            [outcome.lifecycleFailure, retryFailure],
            `${outcome.lifecycleFailure.message}; ${retryFailure.message}`,
            { cause: outcome.lifecycleFailure },
          ), outcome.lifecycleFailure, retryFailure)
          : retryFailure;
      }
    }
    if (nativePosixSession && !posixControlDisposed && childClosed
        && outcome?.lifecycleFailure?.childSettlementUnproven !== true) {
      const retryFailure = disposePosixControl();
      if (retryFailure) {
        outcome.lifecycleFailure = outcome.lifecycleFailure
          ? new AggregateError(
            [outcome.lifecycleFailure, retryFailure],
            `${outcome.lifecycleFailure.message}; ${retryFailure.message}`,
            { cause: outcome.lifecycleFailure },
          )
          : retryFailure;
      }
    }
  }

  const terminationFailure = terminationReason
    ? new Error(`Docker build process ${terminationReason}`)
    : null;
  const asynchronousFailure = outcome.error
    ? new Error('Docker build process could not start', { cause: outcome.error })
    : null;
  const contextFailure = streamResult.complete ? null : new Error(
    'Docker build stdin closed before the immutable context pipeline was complete',
    { cause: streamResult.error },
  );
  const dockerFailure = outcome.status === 0 ? null
    : new Error(`Docker build process failed with status ${outcome.status ?? 'unknown'}`);
  if (outcome.lifecycleFailure) {
    const primary = terminationFailure ?? asynchronousFailure
      ?? (contextFailure && dockerFailure
        ? new AggregateError([contextFailure, dockerFailure],
          'Immutable Docker context and Docker build both failed', { cause: contextFailure })
        : contextFailure ?? dockerFailure);
    if (primary) {
      const failure = propagateLifecycleRecovery(new AggregateError(
        [primary, outcome.lifecycleFailure],
        `${primary.message}; ${outcome.lifecycleFailure.message}`,
        { cause: primary },
      ), primary, outcome.lifecycleFailure);
      throw failure;
    }
    throw outcome.lifecycleFailure;
  }
  if (terminationFailure && terminationErrors.length) {
    throw new AggregateError(
      [terminationFailure, ...terminationErrors],
      `${terminationFailure.message}; signal delivery failed`,
      { cause: terminationFailure },
    );
  }
  if (terminationFailure) throw terminationFailure;
  if (asynchronousFailure) throw asynchronousFailure;
  if (contextFailure && dockerFailure) {
    throw new AggregateError([contextFailure, dockerFailure],
      'Immutable Docker context and Docker build both failed');
  }
  if (contextFailure) throw contextFailure;
  if (dockerFailure) throw dockerFailure;
  return outcome;
}

export async function buildProductionImage({
  projectDirectory: sourceDirectory = projectDirectory,
  trackedFiles,
  candidateFiles,
  expectedCommit,
  environment = process.env,
  runBuild = runDockerBuild,
} = {}) {
  const absoluteProject = path.resolve(sourceDirectory);
  const nodeBaseImage = requireNodeBaseImage(environment);
  if (expectedCommit !== undefined && (trackedFiles !== undefined || candidateFiles !== undefined)) {
    throw new Error('Exact production release checkout authority cannot use injected file inventories');
  }
  const exactCheckout = expectedCommit === undefined ? undefined : assertExactReleaseCheckout({
    sourceDirectory: absoluteProject,
    expectedCommit,
  });
  const frozen = freezeProductionContext({
    sourceDirectory: absoluteProject,
    trackedFiles: exactCheckout?.trackedFiles ?? trackedFiles,
    candidateFiles,
  });
  if (exactCheckout) {
    const rechecked = assertExactReleaseCheckout({
      sourceDirectory: absoluteProject,
      expectedCommit,
    });
    if (JSON.stringify(rechecked.trackedFiles) !== JSON.stringify(exactCheckout.trackedFiles)) {
      throw new Error('Production release tracked inventory changed while freezing the context');
    }
  }
  const { context, state } = immutableContext(frozen);
  const childEnvironment = { ...environment };
  delete childEnvironment.EASYBOOST_PRODUCTION_BUILD_CONTEXT;
  delete childEnvironment.EASYBOOST_NODE_BASE_IMAGE;
  const outcome = await runBuild('docker', [
    'build', '--file', 'Dockerfile', '--tag', PRODUCTION_IMAGE,
    '--build-arg', `EASYBOOST_NODE_BASE_IMAGE=${nodeBaseImage}`, '-',
  ], {
    cwd: absoluteProject,
    env: childEnvironment,
    shell: false,
  }, context);
  if (outcome?.error) throw new Error('Docker image build could not start');
  if (outcome?.status !== 0) {
    throw new Error(`Docker image build failed with exit code ${outcome?.status ?? 'unknown'}`);
  }
  if (!state.completed || state.emitted !== frozen.contextBytes) {
    throw new Error('Docker runner did not consume the complete immutable Docker context');
  }
  return {
    bytes: frozen.bytes,
    contextBytes: frozen.contextBytes,
    files: frozen.entries.length,
    fingerprint: frozen.fingerprint,
  };
}

function parseProductionImageArguments(args) {
  if (args.length !== 2 || args[0] !== '--expected-commit'
      || !FULL_COMMIT_IDENTITY.test(args[1])) {
    throw new Error('Usage: build-production-image.js --expected-commit <full-lowercase-40-character-sha>');
  }
  return { expectedCommit: args[1] };
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  Promise.resolve().then(() => parseProductionImageArguments(process.argv.slice(2)))
    .then((options) => buildProductionImage(options)).then((result) => {
      console.log(`Guarded production image built from ${result.files} files / ${result.bytes} bytes (${result.fingerprint}).`);
    }).catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
