import { spawn } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import process from 'node:process';

import {
  createPosixSessionControl,
  createPosixSessionInvocation,
} from './posix-session-supervisor.js';

const TERM_GRACE_MS = 5_000;
const PARENT_POLL_MS = 100;
const PROCESS_GROUP_POLL_MS = 25;
const CANONICAL_PROCESS_START_TIME = /^(?:0|[1-9]\d*)$/u;

function positiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${label} is invalid`);
  return parsed;
}

function canonicalProcessStartTime(value, label) {
  if (typeof value !== 'string' || !CANONICAL_PROCESS_START_TIME.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

export function readLinuxProcessStartTime(pid, { readFile = readFileSync } = {}) {
  return readLinuxProcessIdentity(pid, { readFile }).leaderStartTime;
}

export function readLinuxProcessIdentity(pid, { readFile = readFileSync } = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error('process identity PID is invalid');
  }
  const stat = readFile(`/proc/${pid}/stat`, 'utf8');
  const commBoundary = stat.lastIndexOf(') ');
  if (commBoundary < 0) throw new Error('process identity stat is malformed');
  const fields = stat.slice(commBoundary + 2).trim().split(/\s+/u);
  if (fields.length < 20) throw new Error('process identity stat is incomplete');
  const processGroupId = Number(fields[2]);
  const sessionId = Number(fields[3]);
  if (![processGroupId, sessionId].every(Number.isSafeInteger)
      || processGroupId <= 0 || sessionId <= 0) {
    throw new Error('process identity group/session is invalid');
  }
  return Object.freeze({
    leaderStartTime: canonicalProcessStartTime(fields[19], 'process identity start time'),
    processGroupId,
    processId: pid,
    sessionId,
    state: fields[0],
  });
}

function parentIdentityMatches(parentPid, parentStartTime, { readProcessStartTime }) {
  const currentStartTime = readProcessStartTime(parentPid);
  return CANONICAL_PROCESS_START_TIME.test(currentStartTime || '')
    && currentStartTime === parentStartTime;
}

function signalTree(child, signal, { platform, terminationAuthority }) {
  if (!child?.pid) return;
  try {
    if (platform === 'win32') child.kill(signal);
    else terminationAuthority.signal(signal);
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
}

function readLinuxProcessIdentityIfPresent(processId, options) {
  try {
    return { process: readLinuxProcessIdentity(processId, options) };
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ESRCH') return { process: null };
    return { error, process: null };
  }
}

function inspectResidualLinuxProcessGroup(processGroupId, expectedIdentity, {
  readFile = readFileSync,
  readDirectory = readdirSync,
} = {}) {
  let entries;
  try {
    entries = readDirectory('/proc', { withFileTypes: true });
  } catch (error) {
    return { error, state: 'unknown' };
  }
  let unreadableError;
  let originalMember = false;
  let reusedMember = false;
  for (const entry of entries) {
    const name = typeof entry === 'string' ? entry : entry.name;
    const isDirectory = typeof entry === 'string' || entry.isDirectory();
    if (!isDirectory || !/^\d+$/u.test(name)) continue;
    const result = readLinuxProcessIdentityIfPresent(Number(name), { readFile });
    if (result.error) {
      unreadableError ??= result.error;
      continue;
    }
    if (!result.process || result.process.processGroupId !== processGroupId) continue;
    if (result.process.sessionId === expectedIdentity.sessionId) originalMember = true;
    else reusedMember = true;
  }
  if (originalMember && reusedMember) {
    return {
      error: new Error('POSIX process-group session changed during authority inspection'),
      state: 'unknown',
    };
  }
  if (originalMember) return { state: 'alive' };
  if (reusedMember) return { state: 'reused' };
  if (unreadableError) return { error: unreadableError, state: 'unknown' };
  return { state: 'absent' };
}

export function inspectLinuxProcessGroup(processGroupId, expectedIdentity, options = {}) {
  const leader = readLinuxProcessIdentityIfPresent(processGroupId, options);
  if (leader.error) return { error: leader.error, state: 'unknown' };
  if (!expectedIdentity) {
    if (!leader.process) {
      const residual = inspectResidualLinuxProcessGroup(processGroupId, {
        sessionId: processGroupId,
      }, options);
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
  return inspectResidualLinuxProcessGroup(processGroupId, expectedIdentity, options);
}

function validProcessGroupIdentity(identity, processGroupId) {
  return identity
    && identity.processGroupId === processGroupId
    && Number.isSafeInteger(identity.sessionId)
    && identity.sessionId > 0
    && CANONICAL_PROCESS_START_TIME.test(identity.leaderStartTime ?? '');
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
      return Object.assign(new Error('Original POSIX process group is absent'), { code: 'ESRCH' });
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
      const firstInspection = inspectOriginalGroup();
      if (firstInspection.state !== 'alive') throw unavailableSignalError(firstInspection);
      const boundaryInspection = inspectOriginalGroup();
      if (boundaryInspection.state !== 'alive') throw unavailableSignalError(boundaryInspection);
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
      if (inspection.state === 'reused') return 'absent';
      return inspection.state;
    },
  });
}

export function probeProcessGroup(processGroupId, {
  platform = process.platform,
  signalProcess = process.kill.bind(process),
} = {}) {
  if (platform === 'win32' || !processGroupId) return { state: 'absent' };
  try {
    signalProcess(-processGroupId, 0);
    return { state: 'alive' };
  } catch (error) {
    if (error?.code === 'ESRCH') return { state: 'absent' };
    if (error?.code === 'EPERM') return { state: 'alive' };
    return { state: 'unknown', errorCode: error?.code ?? 'unknown' };
  }
}

export function runSupervisedCommand({
  command, args, timeoutMs, parentPid, parentStartTime, termGraceMs = TERM_GRACE_MS,
  postKillGraceMs = termGraceMs,
  platform = process.platform,
  readProcessStartTime = readLinuxProcessStartTime,
  inspectProcessGroup = inspectLinuxProcessGroup,
  spawnProcess = spawn,
  requestPosixSignal,
  forcePosixSession = false,
  posixSessionControl: suppliedPosixSessionControl,
  posixSessionInvocation = createPosixSessionInvocation,
  posixControlRoot,
  processObject = process,
}) {
  if (platform !== 'win32') {
    try {
      canonicalProcessStartTime(parentStartTime, 'staging command parent start time');
      if (!parentIdentityMatches(parentPid, parentStartTime, { readProcessStartTime })) {
        return Promise.resolve(143);
      }
    } catch {
      return Promise.resolve(143);
    }
  }
  const nativePosixSession = platform !== 'win32'
    && (spawnProcess === spawn || forcePosixSession === true);
  return new Promise((resolve, reject) => {
    let child;
    let posixSessionControl;
    let wrapperSpawned = false;
    try {
      let invocation = { args, command };
      if (nativePosixSession) {
        const control = suppliedPosixSessionControl
          ?? (posixSessionInvocation === createPosixSessionInvocation
            ? createPosixSessionControl({
              controlKey: `staging-command:${parentPid}:${parentStartTime}:${JSON.stringify(
                [command, args],
              )}`,
              controlRoot: posixControlRoot,
            })
            : undefined);
        invocation = posixSessionInvocation(
          command,
          args,
          undefined,
          postKillGraceMs,
          processObject.env ?? process.env,
          control,
        );
        posixSessionControl = invocation.posixSessionControl ?? control;
        if (!posixSessionControl) {
          throw new Error('bounded staging POSIX invocation has no owned-session control');
        }
      }
      child = spawnProcess(invocation.command, invocation.args, {
        cwd: invocation.cwd,
        detached: platform !== 'win32',
        env: invocation.environment,
        shell: false,
        stdio: 'inherit',
        windowsHide: true,
      });
      if (child?.pid && posixSessionControl) {
        wrapperSpawned = true;
        posixSessionControl.markWrapperSpawned();
      }
    } catch (cause) {
      const error = new Error('bounded staging command could not start: spawn error', { cause });
      if (wrapperSpawned) {
        try { posixSessionControl?.request('SIGTERM'); } catch {}
        child?.on?.('error', () => {});
        child?.unref?.();
        error.childSettlementUnproven = true;
        error.recoveryAuthority = Object.freeze({
          controlDirectory: posixSessionControl?.specification?.controlDirectory,
        });
      } else {
        try { posixSessionControl?.dispose({ force: true }); } catch {}
      }
      reject(error);
      return;
    }
    const processGroupId = child.pid;
    const processGroupAuthority = platform === 'win32'
      ? undefined
      : (nativePosixSession ? undefined : createPosixProcessGroupAuthority(
        processGroupId,
        { inspectProcessGroup, requestSignal: requestPosixSignal },
      ));
    const ownedProofState = () => {
      try {
        return posixSessionControl.proofState();
      } catch (error) {
        return { error, state: 'unknown' };
      }
    };
    const terminationAuthority = nativePosixSession
      ? Object.freeze({
        signal: (signal) => posixSessionControl.request(signal),
        state() {
          const proof = ownedProofState();
          if (proof.error) throw proof.error;
          return proof.state;
        },
      })
      : processGroupAuthority;
    let leaderClosed = false;
    let settled = false;
    let requestedStatus = null;
    let closeCode = null;
    let closeSignal = null;
    let killTimer;
    let parentTimer;
    let hardTimer;
    let processGroupTimer;
    let postKillTimer;
    let primaryFailure = null;
    const lifecycleErrors = [];
    let recordedProbeError = '';

    const clearAll = () => {
      clearTimeout(killTimer);
      clearTimeout(hardTimer);
      clearTimeout(postKillTimer);
      clearInterval(parentTimer);
      clearInterval(processGroupTimer);
      processObject.off('SIGINT', onInterrupt);
      processObject.off('SIGTERM', onTerminate);
    };
    const settle = (status) => {
      if (settled) return;
      if (nativePosixSession && posixSessionControl) {
        const proof = ownedProofState();
        if (proof.state !== 'absent') {
          const error = new Error(
            'bounded staging POSIX session settlement could not be proven',
            proof.error ? { cause: proof.error } : undefined,
          );
          error.childSettlementUnproven = true;
          error.recoveryAuthority = Object.freeze({
            controlDirectory: posixSessionControl.specification?.controlDirectory,
          });
          fail(error);
          return;
        }
        try {
          posixSessionControl.dispose();
        } catch (cause) {
          fail(new Error('bounded staging POSIX session controller disposal failed', { cause }));
          return;
        }
      }
      settled = true;
      clearAll();
      resolve(status);
    };
    const fail = (error) => {
      if (settled) return;
      let terminal = error;
      if (nativePosixSession && posixSessionControl) {
        const proof = ownedProofState();
        if (proof.state === 'absent') {
          try {
            posixSessionControl.dispose();
          } catch (cause) {
            terminal = new AggregateError(
              [terminal, new Error(
                'bounded staging POSIX session controller disposal failed', { cause },
              )],
              `${terminal.message}; owned-session controller disposal failed`,
            );
          }
        } else {
          terminal.childSettlementUnproven = true;
          terminal.recoveryAuthority = Object.freeze({
            controlDirectory: posixSessionControl.specification?.controlDirectory,
          });
        }
      }
      settled = true;
      clearAll();
      reject(terminal);
    };
    const recordError = (message) => lifecycleErrors.push(new Error(message));
    const failureWithLifecycleErrors = (terminal) => {
      const errors = [primaryFailure, ...lifecycleErrors, terminal].filter(Boolean);
      return errors.length === 1 ? terminal : new AggregateError(
        errors, primaryFailure
          ? `${primaryFailure.message}; ${terminal.message}`
          : `bounded staging command termination could not be proven: ${terminal.message}`,
      );
    };
    const failRecordedTermination = () => {
      const errors = [primaryFailure, ...lifecycleErrors].filter(Boolean);
      if (errors.length === 1) fail(errors[0]);
      else fail(new AggregateError(errors, primaryFailure
        ? primaryFailure.message
        : 'bounded staging command termination reported lifecycle errors'));
    };
    const groupProbe = () => {
      let probe;
      if (platform === 'win32') probe = { state: 'absent' };
      else {
        try {
          probe = { state: terminationAuthority?.state() ?? 'unknown' };
        } catch (error) {
          probe = { state: 'unknown', errorCode: error?.code ?? 'unknown' };
        }
      }
      if (probe.state === 'unknown' && probe.errorCode !== recordedProbeError) {
        recordedProbeError = probe.errorCode;
        recordError(`bounded staging process group probe failed (${probe.errorCode})`);
      }
      return probe;
    };
    const maybeSettle = () => {
      if (settled || !leaderClosed) return;
      if (requestedStatus !== null) {
        if (platform !== 'win32') {
          const probe = groupProbe();
          if (probe.state !== 'absent') return;
        }
        if (primaryFailure || lifecycleErrors.length) failRecordedTermination();
        else settle(requestedStatus);
        return;
      }
      if (platform !== 'win32') {
        const probe = groupProbe();
        if (probe.state !== 'absent') {
          primaryFailure = new Error(probe.state === 'alive'
            ? 'bounded staging command leader exited while process group descendants remained alive'
            : 'bounded staging command leader exited before process group termination could be proven');
          terminate(closeSignal ? 128 : (closeCode ?? 1));
          return;
        }
      }
      if (closeSignal) settle(128);
      else settle(closeCode ?? 1);
    };
    const watchTerminatedGroup = () => {
      if (platform === 'win32' || processGroupTimer) return;
      processGroupTimer = setInterval(maybeSettle, PROCESS_GROUP_POLL_MS);
    };
    const terminate = (status) => {
      if (settled || requestedStatus !== null) return;
      requestedStatus = status;
      try {
        signalTree(child, 'SIGTERM', { platform, terminationAuthority });
      } catch (error) {
        recordError(`bounded staging SIGTERM failed (${error?.code ?? 'unknown'})`);
      }
      watchTerminatedGroup();
      killTimer = setTimeout(() => {
        try {
          signalTree(child, 'SIGKILL', { platform, terminationAuthority });
        } catch (error) {
          recordError(`bounded staging SIGKILL failed (${error?.code ?? 'unknown'})`);
        }
        maybeSettle();
        if (settled) return;
        postKillTimer = setTimeout(() => {
          if (settled) return;
          if (platform !== 'win32') {
            const probe = groupProbe();
            if (probe.state === 'alive') {
              fail(failureWithLifecycleErrors(new Error(
                'bounded staging process group remained alive after SIGKILL deadline',
              )));
              return;
            }
            if (probe.state === 'unknown') {
              fail(failureWithLifecycleErrors(new Error(
                'could not prove bounded staging process group termination after SIGKILL',
              )));
              return;
            }
          }
          if (!leaderClosed) {
            fail(failureWithLifecycleErrors(new Error(
              'bounded staging command leader did not reach close/reap after SIGKILL deadline',
            )));
            return;
          }
          maybeSettle();
        }, postKillGraceMs);
      }, termGraceMs);
      maybeSettle();
    };
    const onInterrupt = () => terminate(130);
    const onTerminate = () => terminate(143);
    processObject.on('SIGINT', onInterrupt);
    processObject.on('SIGTERM', onTerminate);
    hardTimer = setTimeout(() => terminate(124), timeoutMs);
    if (platform !== 'win32') {
      parentTimer = setInterval(() => {
        try {
          if (!parentIdentityMatches(parentPid, parentStartTime, { readProcessStartTime })) {
            terminate(143);
          }
        } catch (error) {
          recordError(`bounded staging parent probe failed (${error?.code ?? 'unknown'})`);
          terminate(143);
        }
      }, PARENT_POLL_MS);
    }
    child.once('error', (error) => {
      const errorCode = error?.code ?? 'unknown';
      if (!child?.pid) {
        try { posixSessionControl?.dispose({ force: true }); } catch {}
        posixSessionControl = undefined;
        fail(new Error(`bounded staging command could not start: ${errorCode}`));
        return;
      }
      const lifecycleError = new Error(
        `bounded staging command post-spawn child error (${errorCode})`,
        { cause: error },
      );
      if (!primaryFailure) primaryFailure = lifecycleError;
      else lifecycleErrors.push(lifecycleError);
      terminate(127);
    });
    child.once('close', (code, signal) => {
      leaderClosed = true;
      closeCode = code;
      closeSignal = signal;
      if (nativePosixSession) {
        let status;
        try {
          posixSessionControl.observeWrapperClose?.(code, signal);
          status = posixSessionControl.targetStatus?.();
        } catch (error) {
          lifecycleErrors.push(new Error(
            'bounded staging command target status proof failed', { cause: error },
          ));
          status = { state: 'unknown' };
        }
        if (status?.state === 'present') {
          closeCode = status.exitCode;
          closeSignal = status.signal;
          if (status.errorCode && !primaryFailure) {
            primaryFailure = new Error(
              `bounded staging command could not start: ${status.errorCode}`,
            );
          }
        } else if (!primaryFailure) {
          primaryFailure = new Error('bounded staging command target status was not proven');
        }
      }
      maybeSettle();
    });
  });
}

async function runCli() {
  const milliseconds = process.argv[2] === '--milliseconds';
  const valueIndex = milliseconds ? 3 : 2;
  const parentIndex = milliseconds ? 4 : 3;
  const graceIndex = milliseconds ? 5 : -1;
  const legacySeparator = milliseconds ? 6 : 4;
  const explicitSeparator = milliseconds ? 7 : 5;
  const separator = process.argv.indexOf('--', legacySeparator);
  if (![legacySeparator, explicitSeparator].includes(separator)
      || separator + 1 >= process.argv.length) {
    throw new Error(
      'Usage: staging-command-supervisor.js SECONDS PARENT_PID [PARENT_START_TIME] -- COMMAND [ARG...]',
    );
  }
  const timeoutMs = milliseconds
    ? positiveInteger(process.argv[valueIndex], 'staging command timeout')
    : positiveInteger(process.argv[valueIndex], 'staging command timeout') * 1_000;
  const parentPid = positiveInteger(process.argv[parentIndex], 'staging command parent');
  const termGraceMs = milliseconds
    ? positiveInteger(process.argv[graceIndex], 'staging command termination grace')
    : TERM_GRACE_MS;
  const hasExplicitParentStartTime = separator === explicitSeparator;
  const explicitStartTimeIndex = milliseconds ? 6 : 4;
  let parentStartTime;
  if (process.platform === 'win32') {
    parentStartTime = hasExplicitParentStartTime
      ? canonicalProcessStartTime(
          process.argv[explicitStartTimeIndex], 'staging command parent start time',
        )
      : '0';
  } else if (hasExplicitParentStartTime) {
    parentStartTime = canonicalProcessStartTime(
      process.argv[explicitStartTimeIndex], 'staging command parent start time',
    );
  } else {
    if (process.ppid !== parentPid) {
      process.exitCode = 143;
      return;
    }
    try {
      parentStartTime = readLinuxProcessStartTime(parentPid);
    } catch {
      process.exitCode = 143;
      return;
    }
    if (process.ppid !== parentPid) {
      process.exitCode = 143;
      return;
    }
  }
  const command = process.argv[separator + 1];
  const args = process.argv.slice(separator + 2);
  const status = await runSupervisedCommand({
    command, args, timeoutMs, parentPid, parentStartTime, termGraceMs,
  });
  process.exitCode = status;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli().catch((error) => {
    console.error(error.message);
    process.exitCode = error?.childSettlementUnproven === true ? 125 : 127;
  });
}
