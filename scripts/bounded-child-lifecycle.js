import { spawn } from 'node:child_process';
import path from 'node:path';

import {
  createPosixProcessGroupAuthority,
  createWindowsJobControl,
  createWindowsJobInvocation,
} from './release-command-supervisor.js';
import {
  POSIX_SESSION_WRITER_EGRESS_FD,
  createPosixSessionControl,
  createPosixSessionInvocation,
  normalizePosixSessionPublicationResidue,
  normalizePosixSessionPublicationResidues,
  observePosixSessionWriterEgress,
} from './posix-session-supervisor.js';

const SETTLEMENT_POLL_MS = 10;

function deadline(milliseconds, value) {
  return new Promise((resolve) => {
    setTimeout(() => { resolve(value); }, milliseconds);
  });
}

function observeChildErrors(child) {
  const errors = [];
  let resolveFirstError;
  const firstError = new Promise((resolve) => { resolveFirstError = resolve; });
  child.on('error', (error) => {
    errors.push(error);
    if (errors.length === 1) resolveFirstError(error);
  });
  return Object.freeze({
    count: () => errors.length,
    firstError,
    since: (index) => errors.slice(index),
  });
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
  const inherited = stdio ?? 'pipe';
  return [inherited, inherited, inherited, 'pipe'];
}

export function spawnBoundedChild(command, args, {
  cwd,
  environment,
  forcePosixSession = false,
  forceWindowsJob = false,
  inspectProcessGroup,
  killGraceMs = 2_000,
  platform = process.platform,
  reapTimeoutMs = 2_000,
  posixControlKey,
  posixControlRoot,
  posixSessionControl,
  posixSessionInvocation = createPosixSessionInvocation,
  requestPosixSignal,
  signalProcess,
  spawnProcess = spawn,
  stdio,
  windowsJobInvocation = createWindowsJobInvocation,
  windowsControlKey,
  windowsControlRoot,
} = {}) {
  const nativeWindowsJob = platform === 'win32' && (spawnProcess === spawn || forceWindowsJob);
  const nativePosixSession = platform !== 'win32'
    && (spawnProcess === spawn || forcePosixSession);
  let child;
  let invocation;
  let ownedPosixControl;
  let ownedWindowsControl;
  const posixPublicationResidues = new Map();
  const retainPosixPublicationResidue = (authority, control) => {
    const normalized = normalizePosixSessionPublicationResidue(
      authority,
      control.specification.controlDirectory,
    );
    posixPublicationResidues.set(JSON.stringify(normalized), normalized);
  };
  const posixPublicationRecoveryFields = () => {
    const residues = [...posixPublicationResidues.values()];
    if (residues.length === 0) return {};
    if (residues.length === 1) return { publicationResidue: residues[0] };
    return { publicationResidues: Object.freeze(residues) };
  };
  let posixWriterEgressEnded = true;
  let posixWriterEgressFailure;
  let posixWriterEgressObserver;
  let posixWriterEgressStream;
  let wrapperSpawned = false;
  try {
    if (nativeWindowsJob) {
      ownedWindowsControl = windowsJobInvocation === createWindowsJobInvocation
        ? createWindowsJobControl({
          controlKey: windowsControlKey ?? `database:${cwd ?? process.cwd()}:${command}`,
          temporaryDirectory: windowsControlRoot,
        })
        : undefined;
      invocation = windowsJobInvocation(
        command,
        args,
        cwd,
        Math.max(killGraceMs, reapTimeoutMs),
        environment,
        ownedWindowsControl,
      );
      ownedWindowsControl = invocation.windowsJobControl ?? ownedWindowsControl;
    } else if (nativePosixSession) {
      ownedPosixControl = posixSessionControl
        ?? (posixSessionInvocation === createPosixSessionInvocation
          ? createPosixSessionControl({
            controlKey: posixControlKey ?? `database:${cwd ?? process.cwd()}:${command}`,
            controlRoot: posixControlRoot,
          })
          : undefined);
      invocation = posixSessionInvocation(
        command,
        args,
        cwd,
        Math.max(killGraceMs, reapTimeoutMs),
        environment,
        ownedPosixControl,
      );
      ownedPosixControl = invocation.posixSessionControl ?? ownedPosixControl;
      if (invocation.writerEgress !== undefined) {
        const control = invocation.posixSessionControl ?? ownedPosixControl;
        if (invocation.writerEgress?.descriptor !== POSIX_SESSION_WRITER_EGRESS_FD
            || invocation.writerEgress.specification !== control?.specification) {
          throw new Error('POSIX session writer egress authority is invalid');
        }
        posixWriterEgressEnded = false;
      }
    } else {
      invocation = { args, command, cwd, environment };
    }
    const childStdio = nativePosixSession && invocation.writerEgress !== undefined
      ? stdioWithPosixWriterEgress(stdio, invocation.writerEgress.descriptor)
      : stdio;
    child = spawnProcess(invocation.command, invocation.args, {
      cwd: invocation.cwd ?? cwd,
      detached: platform !== 'win32',
      env: invocation.environment ?? environment,
      stdio: childStdio,
      windowsHide: true,
    });
    wrapperSpawned = true;
    invocation.windowsJobControl?.markWrapperSpawned?.();
    (invocation.posixSessionControl ?? ownedPosixControl)?.markWrapperSpawned?.();
    if (nativePosixSession && invocation.writerEgress !== undefined) {
      const control = invocation.posixSessionControl ?? ownedPosixControl;
      posixWriterEgressStream = child?.stdio?.[invocation.writerEgress.descriptor];
      if (!posixWriterEgressStream) {
        throw new Error('POSIX session writer egress pipe is unavailable');
      }
      posixWriterEgressObserver = observePosixSessionWriterEgress(
        posixWriterEgressStream,
        invocation.writerEgress.specification,
        {
          onAuthority(authority) {
            retainPosixPublicationResidue(authority, control);
          },
          onEnd() { posixWriterEgressEnded = true; },
          onProtocolFailure(error) { posixWriterEgressFailure = error; },
        },
      );
    }
  } catch (cause) {
    // A returned wrapper may already own the target. Its deterministic control
    // directory must survive a bookkeeping failure for same-scope recovery.
    const cleanupErrors = [];
    const control = invocation?.posixSessionControl ?? ownedPosixControl;
    if (wrapperSpawned && nativePosixSession) {
      try { control?.request?.('SIGTERM'); } catch (error) {
        cleanupErrors.push(error);
        try {
          retainPosixPublicationResidue(error?.recoveryAuthority, control);
        } catch {}
      }
      posixWriterEgressObserver?.cancel?.();
      posixWriterEgressStream?.destroy?.();
    }
    for (const candidate of [
      invocation?.windowsJobControl ?? ownedWindowsControl,
      control,
    ]) {
      try { candidate?.dispose({ force: !wrapperSpawned }); } catch (error) {
        cleanupErrors.push(error);
      }
    }
    const failure = cleanupErrors.length === 0 ? cause : new AggregateError(
      [cause, ...cleanupErrors],
      'Bounded child startup failed and its controller cleanup was not proven',
      { cause },
    );
    if (wrapperSpawned && nativePosixSession) {
      failure.childSettlementUnproven = true;
      if (typeof control?.specification?.controlDirectory === 'string'
          && path.isAbsolute(control.specification.controlDirectory)) {
          failure.recoveryAuthority = Object.freeze({
            controlDirectory: control.specification.controlDirectory,
            ...posixPublicationRecoveryFields(),
        });
      }
    }
    throw failure;
  }

  let authority;
  if (nativeWindowsJob) {
    let wrapperClosed = false;
    let jobEmptyProven = false;
    child.once('close', () => { wrapperClosed = true; });
    const jobControl = invocation.windowsJobControl ?? ownedWindowsControl;
    authority = Object.freeze({
      kind: 'windows-job-object-wrapper',
      recoveryAuthority: jobControl?.recoveryAuthority
        ?? (typeof jobControl?.specification?.proofPath === 'string'
          && path.isAbsolute(jobControl.specification.proofPath)
          && path.basename(jobControl.specification.proofPath) === 'job-empty.proof'
          ? Object.freeze({ controlDirectory: path.dirname(jobControl.specification.proofPath) })
          : undefined),
      signal: (signal) => {
        if (!jobControl) throw new Error('Windows Job controller authority is unavailable');
        return jobControl.request(signal);
      },
      state: () => {
        if (!wrapperClosed) return 'alive';
        if (jobEmptyProven) return 'absent';
        if (!jobControl) throw new Error('Windows Job empty proof authority is unavailable');
        const proof = jobControl.proofState();
        if (proof.state === 'absent') {
          jobControl.dispose();
          jobEmptyProven = true;
          return 'absent';
        }
        if (proof.error) throw proof.error;
        return 'unknown';
      },
    });
  } else if (nativePosixSession) {
    let wrapperClosed = false;
    let sessionEmptyProven = false;
    const control = invocation.posixSessionControl ?? ownedPosixControl;
    if (!control) throw new Error('POSIX session controller authority is unavailable');
    child.once('close', (code, signal) => {
      wrapperClosed = true;
      control.observeWrapperClose?.(code, signal);
    });
    authority = Object.freeze({
      kind: 'posix-owned-session-wrapper',
      get recoveryAuthority() {
        return typeof control.specification?.controlDirectory === 'string'
            && path.isAbsolute(control.specification.controlDirectory)
          ? Object.freeze({
            controlDirectory: control.specification.controlDirectory,
            ...posixPublicationRecoveryFields(),
          })
          : undefined;
      },
      detach() {
        posixWriterEgressObserver?.cancel?.();
        posixWriterEgressStream?.destroy?.();
      },
      signal: (signal) => {
        try {
          return control.request(signal);
        } catch (error) {
          try {
            retainPosixPublicationResidue(error?.recoveryAuthority, control);
          } catch {}
          throw error;
        }
      },
      targetStatus: () => control.targetStatus(),
      state: () => {
        if (!wrapperClosed) return 'alive';
        if (sessionEmptyProven) return 'absent';
        if (!posixWriterEgressEnded) return 'unknown';
        if (posixWriterEgressFailure) {
          throw new Error('POSIX session writer egress settlement is invalid', {
            cause: posixWriterEgressFailure,
          });
        }
        if (posixPublicationResidues.size !== 0) {
          throw new Error('POSIX session retained exact writer publication residue');
        }
        const proof = control.proofState();
        if (proof.state === 'absent') {
          control.dispose();
          sessionEmptyProven = true;
          return 'absent';
        }
        if (proof.error) throw proof.error;
        return proof.state === 'alive' ? 'alive' : 'unknown';
      },
    });
  } else if (platform !== 'win32' && Number.isSafeInteger(child.pid) && child.pid > 0) {
    authority = createPosixProcessGroupAuthority(child.pid, {
      inspectProcessGroup,
      requestSignal: requestPosixSignal
        ?? (typeof signalProcess === 'function'
          ? (signal) => signalProcess(undefined, signal)
          : undefined),
    });
  }
  const childErrors = observeChildErrors(child);
  return Object.freeze({ authority, child, childErrors });
}

function inspectAuthorityState(authority, isClosed) {
  if (!authority) return { state: isClosed() ? 'absent' : 'alive' };
  try {
    const state = authority.state();
    return { state: state === 'alive' || state === 'absent' ? state : 'unknown' };
  } catch (error) {
    return { error, state: 'unknown' };
  }
}

export function isBoundedChildSettled({ authority, isClosed }) {
  return isClosed() && inspectAuthorityState(authority, isClosed).state === 'absent';
}

const RECOVERY_AUTHORITY_PATH_KEYS = Object.freeze([
  'authorityFile',
  'claimedFile',
  'controlDirectory',
  'frozenBackupDirectory',
  'holdFile',
  'lockFile',
  'originalFile',
  'quarantineFile',
  'retainedTemporaryFile',
  'retiredCapturedFile',
  'retiredExactFile',
  'retirementDirectory',
  'retirementProof',
]);
const RECOVERY_AUTHORITY_PATH_ARRAY_KEYS = Object.freeze(['holdFiles']);
const WINDOWS_JOB_RECOVERY_PROTOCOL = 'easyboost-windows-job-recovery-v2';

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

function compareCodeUnits(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function sanitizeRecoveryAuthority(authority) {
  if (!authority || typeof authority !== 'object' || Array.isArray(authority)) return undefined;
  const retirementKeys = [
    'controlDirectory', 'reservationOwner', 'sourceDev', 'sourceIno', 'tombstone',
  ];
  if (JSON.stringify(Object.keys(authority).sort()) === JSON.stringify(retirementKeys)) {
    if (typeof authority.controlDirectory !== 'string'
        || !path.isAbsolute(authority.controlDirectory)
        || path.resolve(authority.controlDirectory) !== authority.controlDirectory
        || typeof authority.tombstone !== 'string' || !path.isAbsolute(authority.tombstone)
        || path.resolve(authority.tombstone) !== authority.tombstone
        || path.dirname(authority.tombstone) !== path.dirname(authority.controlDirectory)
        || !/^\.easyboost-staging-quarantine-slot\.[a-f0-9]{64}\.tombstone$/u
          .test(path.basename(authority.tombstone))
        || !/^[a-f0-9]{64}$/u.test(authority.reservationOwner ?? '')
        || !/^(?:0|[1-9]\d*)$/u.test(authority.sourceDev ?? '')
        || !/^(?:0|[1-9]\d*)$/u.test(authority.sourceIno ?? '')) return undefined;
    return deepFreeze({
      controlDirectory: authority.controlDirectory,
      reservationOwner: authority.reservationOwner,
      sourceDev: authority.sourceDev,
      sourceIno: authority.sourceIno,
      tombstone: authority.tombstone,
    });
  }
  const sanitized = {};
  for (const key of RECOVERY_AUTHORITY_PATH_KEYS) {
    const value = authority[key];
    if (typeof value === 'string' && path.isAbsolute(value)) sanitized[key] = value;
  }
  for (const key of RECOVERY_AUTHORITY_PATH_ARRAY_KEYS) {
    if (!Array.isArray(authority[key])) continue;
    const paths = [...new Set(authority[key]
      .filter((value) => typeof value === 'string' && path.isAbsolute(value)))].sort(compareCodeUnits);
    if (paths.length) sanitized[key] = Object.freeze(paths);
  }
  if (authority.protocol === WINDOWS_JOB_RECOVERY_PROTOCOL) {
    sanitized.protocol = WINDOWS_JOB_RECOVERY_PROTOCOL;
    if (/^[0-9a-f]{64}$/u.test(authority.proofToken ?? '')) {
      sanitized.proofToken = authority.proofToken;
    }
  }
  const flatPublicationPathKeys = ['destination', 'temporary', 'tombstone'];
  const flatPublicationKeys = [...flatPublicationPathKeys, 'sourceBinding'];
  const hasFlatPublicationResidue = flatPublicationPathKeys.some((key) =>
    Object.hasOwn(authority, key));
  if (hasFlatPublicationResidue) {
    if (Object.hasOwn(authority, 'publicationResidue')
        || Object.hasOwn(authority, 'publicationResidues')
        || typeof sanitized.controlDirectory !== 'string') return undefined;
    const publicationResidue = {};
    for (const key of flatPublicationKeys) {
      if (Object.hasOwn(authority, key)) publicationResidue[key] = authority[key];
    }
    try {
      sanitized.publicationResidue = normalizePosixSessionPublicationResidue(
        publicationResidue,
        sanitized.controlDirectory,
      );
    } catch {
      return undefined;
    }
  }
  if (Object.hasOwn(authority, 'publicationResidue')) {
    if (Object.hasOwn(authority, 'publicationResidues')) return undefined;
    if (typeof sanitized.controlDirectory !== 'string') return undefined;
    try {
      sanitized.publicationResidue = normalizePosixSessionPublicationResidue(
        authority.publicationResidue,
        sanitized.controlDirectory,
      );
    } catch {
      return undefined;
    }
  }
  if (Object.hasOwn(authority, 'publicationResidues')) {
    if (typeof sanitized.controlDirectory !== 'string') return undefined;
    try {
      sanitized.publicationResidues = normalizePosixSessionPublicationResidues(
        authority.publicationResidues,
        sanitized.controlDirectory,
      );
    } catch {
      return undefined;
    }
  }
  return Object.keys(sanitized).length ? deepFreeze(sanitized) : undefined;
}

function scrubRecoveryAuthorityMetadata(error, seen = new Set()) {
  if (!error || typeof error !== 'object' || seen.has(error)) return true;
  seen.add(error);
  try {
    if (error instanceof AggregateError) {
      if (!Array.isArray(error.errors)) return false;
      for (const nested of error.errors) {
        if (!scrubRecoveryAuthorityMetadata(nested, seen)) return false;
      }
    }
    if (!scrubRecoveryAuthorityMetadata(error.cause, seen)) return false;
    for (const key of ['recoveryAuthority', 'recoveryAuthorities']) {
      if (!Object.hasOwn(error, key)) continue;
      delete error[key];
      if (Object.hasOwn(error, key)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function canonicalRecoveryAuthority(authority) {
  return JSON.stringify(authority);
}

function collectRecoveryState(error, state, seen) {
  if (!error || typeof error !== 'object' || seen.has(error)) return;
  seen.add(error);
  if (error.childSettlementUnproven === true) state.childSettlementUnproven = true;
  const pluralAuthorities = Array.isArray(error.recoveryAuthorities)
    ? error.recoveryAuthorities
    : [];
  for (const authority of [error.recoveryAuthority, ...pluralAuthorities]) {
    const sanitized = sanitizeRecoveryAuthority(authority);
    if (!sanitized) continue;
    const key = canonicalRecoveryAuthority(sanitized);
    state.authorities.set(key, sanitized);
  }
  if (error instanceof AggregateError) {
    for (const nested of error.errors) collectRecoveryState(nested, state, seen);
  }
  collectRecoveryState(error.cause, state, seen);
}

export function collectLifecycleRecovery(error, ...sources) {
  const state = { authorities: new Map(), childSettlementUnproven: false };
  const seen = new Set();
  for (const source of [error, ...sources]) collectRecoveryState(source, state, seen);
  const authorities = [...state.authorities.entries()]
    .sort(([left], [right]) => compareCodeUnits(left, right))
    .map(([, authority]) => authority);
  return Object.freeze({
    childSettlementUnproven: state.childSettlementUnproven,
    recoveryAuthorities: Object.freeze(authorities),
  });
}

function createRecoveryPropagationFallback(error) {
  const message = typeof error?.message === 'string'
    ? error.message
    : 'unknown lifecycle recovery failure';
  return new Error(`Lifecycle recovery authority could not be safely sanitized: ${message}`);
}

function attachPublicRecovery(target, recovery) {
  const authorities = recovery.recoveryAuthorities;
  try {
    if (recovery.childSettlementUnproven) {
      Object.defineProperty(target, 'childSettlementUnproven', {
        configurable: true,
        enumerable: true,
        value: true,
        writable: true,
      });
    }
    if (authorities.length) {
      Object.defineProperty(target, 'recoveryAuthority', {
        configurable: true,
        enumerable: true,
        value: authorities[0],
        writable: true,
      });
    }
    if (authorities.length > 1) {
      Object.defineProperty(target, 'recoveryAuthorities', {
        configurable: true,
        enumerable: true,
        value: Object.freeze([...authorities]),
        writable: true,
      });
    }
    return true;
  } catch {
    return false;
  }
}

export function propagateLifecycleRecovery(error, ...sources) {
  const recovery = collectLifecycleRecovery(error, ...sources);
  let target = scrubRecoveryAuthorityMetadata(error)
    ? error
    : createRecoveryPropagationFallback(error);
  if (!attachPublicRecovery(target, recovery)) {
    // Do not retain the original graph or copy its flags/codes when it cannot safely
    // carry the public contract: only the sanitized recovery fields may survive.
    target = createRecoveryPropagationFallback(error);
    attachPublicRecovery(target, recovery);
  }
  return target;
}

export async function settleLocalChildHold(localChildHold, primaryError, message) {
  if (!localChildHold) return primaryError ?? null;
  let holdError;
  try {
    await localChildHold.release();
  } catch (error) {
    holdError = error;
  }
  if (!primaryError) return holdError ?? null;
  if (!holdError) return primaryError;
  const failure = new AggregateError([primaryError, holdError], message, {
    cause: primaryError,
  });
  return propagateLifecycleRecovery(failure, primaryError, holdError);
}

async function waitForSettlement({ authority, isClosed, milliseconds }) {
  const end = Date.now() + milliseconds;
  while (Date.now() < end) {
    if (isBoundedChildSettled({ authority, isClosed })) return true;
    await deadline(Math.min(SETTLEMENT_POLL_MS, Math.max(1, end - Date.now())), undefined);
  }
  return isBoundedChildSettled({ authority, isClosed });
}

function markSettlementUnproven(error) {
  error.childSettlementUnproven = true;
  return error;
}

export async function terminateAndReapChild({
  authority,
  child,
  childErrors,
  closeOutcome,
  commandLabel,
  isClosed,
  killGraceMs,
  reapTimeoutMs,
}) {
  if (isBoundedChildSettled({ authority, isClosed })) return null;
  const observedErrorIndex = childErrors?.count() ?? 0;
  const signalTree = (signal) => {
    if (authority) return authority.signal(signal);
    throw Object.assign(new Error(
      `${commandLabel} has no owned process-tree signal authority`,
    ), { code: 'EAGAIN' });
  };
  const signalErrors = [];
  try {
    signalTree('SIGTERM');
  } catch (error) {
    if (error?.code !== 'ESRCH') signalErrors.push(error);
  }
  const closedAfterTerm = await waitForSettlement({
    authority,
    isClosed,
    milliseconds: killGraceMs,
  });
  if (closedAfterTerm) {
    signalErrors.push(...(childErrors?.since(observedErrorIndex) ?? []));
    if (signalErrors.length === 0) return null;
    if (signalErrors.length === 1) return signalErrors[0];
    return new AggregateError(signalErrors, `${commandLabel} signal delivery failed`, {
      cause: signalErrors[0],
    });
  }

  try {
    signalTree('SIGKILL');
  } catch (error) {
    if (error?.code !== 'ESRCH') signalErrors.push(error);
  }
  const closedAfterKill = await waitForSettlement({
    authority,
    isClosed,
    milliseconds: reapTimeoutMs,
  });
  signalErrors.push(...(childErrors?.since(observedErrorIndex) ?? []));
  const signalError = signalErrors.length > 1
    ? new AggregateError(signalErrors, `${commandLabel} signal escalation failed`, {
      cause: signalErrors[0],
    })
    : signalErrors[0];
  if (!closedAfterKill) {
    const settlement = inspectAuthorityState(authority, isClosed);
    const causes = [signalError, settlement.error].filter(Boolean);
    const cause = causes.length > 1
      ? new AggregateError(causes, `${commandLabel} cleanup evidence failed`, {
        cause: causes[0],
      })
      : causes[0];
    const message = !isClosed()
      ? `${commandLabel} did not close after SIGKILL within ${reapTimeoutMs}ms`
      : settlement.state === 'alive'
        ? `${commandLabel} process tree remained alive after SIGKILL within ${reapTimeoutMs}ms`
        : `${commandLabel} process tree settlement could not be proven after SIGKILL within ${reapTimeoutMs}ms`;
    const failure = markSettlementUnproven(new Error(
      message,
      cause ? { cause } : undefined,
    ));
    failure.recoveryAuthority = authority?.recoveryAuthority;
    authority?.detach?.();
    child.on?.('error', () => {});
    child.unref?.();
    child.stdin?.unref?.();
    child.stdout?.unref?.();
    child.stderr?.unref?.();
    return failure;
  }
  void closeOutcome;
  return signalError ?? null;
}
