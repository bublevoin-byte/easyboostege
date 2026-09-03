import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import {
  STAGING_QUIESCENT_MAINTENANCE_DESCRIPTOR,
  STAGING_QUIESCENT_MAINTENANCE_PROTOCOL,
  createStagingDeadlineController,
  createStagingDeadlineMailbox,
} from '../scripts/staging-deadline-control.js';
import { createPosixSessionControl } from '../scripts/posix-session-supervisor.js';
import { runBoundedReleaseCommand } from '../scripts/release-command-supervisor.js';

function sameIdentity(left, right) {
  return String(left.dev) === String(right.dev) && String(left.ino) === String(right.ino);
}

function sameAuthority(left, right) {
  const keys = [
    'descriptor', 'lease', 'ownerPid', 'ownerStartTime',
    'protocol', 'rootDev', 'rootIno',
  ];
  return left && right
    && JSON.stringify(Object.keys(left).sort()) === JSON.stringify(keys)
    && JSON.stringify(Object.keys(right).sort()) === JSON.stringify(keys)
    && keys.every((key) => left[key] === right[key]);
}

function createSettledTestMaintenance(controlRoot) {
  const root = path.resolve(controlRoot);
  const rootIdentity = fs.lstatSync(root);
  const authority = Object.freeze({
    descriptor: STAGING_QUIESCENT_MAINTENANCE_DESCRIPTOR,
    lease: 'f'.repeat(64),
    ownerPid: process.pid,
    ownerStartTime: '1',
    protocol: STAGING_QUIESCENT_MAINTENANCE_PROTOCOL,
    rootDev: String(rootIdentity.dev),
    rootIno: String(rootIdentity.ino),
  });
  const reclaimRetainedEvidence = (request) => {
    if (!request || typeof request !== 'object' || Array.isArray(request)
        || JSON.stringify(Object.keys(request).sort()) !== JSON.stringify([
          'authority', 'bounds', 'container', 'containerIdentity', 'kind', 'payload',
          'payloadIdentity', 'reservationBinding', 'root', 'tombstone',
        ]) || !sameAuthority(request.authority, authority) || request.root !== root
        || request.container !== request.tombstone
        || path.dirname(request.container) !== root
        || request.payload !== path.join(request.container, 'payload')
        || request.reservationBinding !== null
        || (request.kind !== 'PUBLICATION' && request.kind !== 'RETIREMENT')) {
      throw new Error('staging deadline test maintenance request is invalid');
    }
    const currentRoot = fs.lstatSync(root);
    const container = fs.lstatSync(request.container);
    const payload = fs.lstatSync(request.payload);
    if (!sameIdentity(rootIdentity, currentRoot)
        || !sameIdentity(container, request.containerIdentity)
        || !sameIdentity(payload, request.payloadIdentity)
        || !container.isDirectory() || container.isSymbolicLink()) {
      throw new Error('staging deadline test maintenance authority changed');
    }
    // This harness runs only after the bounded child supervisor has proven the
    // session empty. Production never uses this seam; its fd8 owner performs
    // the crash-restart-safe maintenance transaction.
    fs.rmSync(request.container, { force: false, recursive: true });
    try {
      fs.lstatSync(request.container);
      throw new Error('staging deadline test maintenance did not retire its slot');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    if (!sameIdentity(rootIdentity, fs.lstatSync(root))) {
      throw new Error('staging deadline test maintenance root changed');
    }
    return true;
  };
  return Object.freeze({ authority, reclaimRetainedEvidence });
}

function exactConfiguration(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || typeof value.bash !== 'string' || !Array.isArray(value.arguments)
      || typeof value.controlKey !== 'string' || !value.controlKey
      || typeof value.script !== 'string' || !value.script
      || !Number.isSafeInteger(value.transactionSeconds) || value.transactionSeconds <= 0
      || !Number.isSafeInteger(value.recoverySeconds) || value.recoverySeconds <= 0) {
    throw new Error('staging deadline test harness configuration is invalid');
  }
  return value;
}

function decodeConfiguration(value) {
  try {
    return exactConfiguration(JSON.parse(Buffer.from(value, 'base64url').toString('utf8')));
  } catch (cause) {
    throw new Error('staging deadline test harness configuration is invalid', { cause });
  }
}

async function run(configuration) {
  const sessionControlRoot = process.env.EASYBOOST_STAGING_SESSION_TEST_CONTROL_ROOT;
  if (typeof sessionControlRoot !== 'string' || !path.isAbsolute(sessionControlRoot)) {
    throw new Error('staging deadline test harness requires an absolute session control root');
  }
  fs.mkdirSync(sessionControlRoot, { mode: 0o700, recursive: true });
  const deadlineControlRoot = process.env.EASYBOOST_STAGING_DEADLINE_TEST_CONTROL_ROOT;
  if (typeof deadlineControlRoot !== 'string' || !path.isAbsolute(deadlineControlRoot)) {
    throw new Error('staging deadline test harness requires an absolute deadline control root');
  }
  fs.mkdirSync(deadlineControlRoot, { mode: 0o700, recursive: true });
  const deadlineMaintenance = createSettledTestMaintenance(deadlineControlRoot);
  const mailbox = createStagingDeadlineMailbox({
    controlKey: configuration.controlKey,
    controlRoot: deadlineControlRoot,
    quiescentMaintenanceAuthority: deadlineMaintenance.authority,
    reclaimRetainedEvidence: deadlineMaintenance.reclaimRetainedEvidence,
  });
  const timers = new Set();
  const setTimer = (callback, milliseconds) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      callback();
    }, milliseconds);
    timers.add(timer);
    return timer;
  };
  const clearTimer = (timer) => {
    clearTimeout(timer);
    timers.delete(timer);
  };
  let deadlineExpired = false;
  const controller = createStagingDeadlineController({
    clearTimer,
    onDeadline() { deadlineExpired = true; },
    recoverySeconds: configuration.recoverySeconds,
    setTimer,
    token: mailbox.specification.token,
    transactionSeconds: configuration.transactionSeconds,
  });

  // This is the Windows/Git-Bash test seam for the Linux-only outer transaction
  // supervisor.  It establishes authenticated READY authority before the inner
  // release script starts, then accepts only its durable ROLLOVER/DISARM requests.
  mailbox.acknowledge(controller.ready());
  let controllerFailure;
  const consume = () => {
    if (controllerFailure) return;
    const state = controller.state();
    if (state !== 'TRANSACTION' && state !== 'RECOVERY') return;
    const sequence = state === 'TRANSACTION' ? 1 : 2;
    const request = mailbox.requestState(sequence);
    if (request.state === 'missing') return;
    if (request.state !== 'present') {
      controllerFailure = request.error ?? new Error('staging deadline request is not proven');
      return;
    }
    try {
      mailbox.acknowledge(controller.transition(request.record));
    } catch (error) {
      controllerFailure = error;
    }
  };
  const poll = setInterval(consume, 20);
  let result;
  try {
    const posixMaintenance = process.platform === 'win32'
      ? undefined : createSettledTestMaintenance(sessionControlRoot);
    const posixSessionControl = posixMaintenance === undefined ? undefined
      : createPosixSessionControl({
        controlKey: `staging-deadline-test-session:${configuration.controlKey}`,
        controlRoot: sessionControlRoot,
        quiescentMaintenanceAuthority: posixMaintenance.authority,
        reclaimRetainedEvidence: posixMaintenance.reclaimRetainedEvidence,
      });
    // The release supervisor is the test seam for the production outer wrapper:
    // Windows owns every Git-Bash descendant in a Job Object and Linux owns an
    // isolated POSIX session.  A close event alone is never settlement proof.
    result = await runBoundedReleaseCommand(configuration.bash, [
      '--noprofile', '--norc', configuration.script, ...configuration.arguments,
    ], {
      captureOutput: true,
      commandLabel: 'staging deadline test bounded session',
      env: {
        ...process.env,
        EASYBOOST_STAGING_DEADLINE_CONTROL: mailbox.environmentValue,
      },
      hardTimeoutMs: (configuration.transactionSeconds + configuration.recoverySeconds) * 1_000,
      posixControlKey: `staging-deadline-test-session:${configuration.controlKey}`,
      posixControlRoot: sessionControlRoot,
      posixSessionControl,
      resolveNonZeroStatus: true,
      windowsControlKey: `staging-deadline-test-session:${configuration.controlKey}`,
      windowsControlRoot: sessionControlRoot,
    });
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
  } catch (error) {
    controllerFailure ??= error;
  }
  clearInterval(poll);
  for (const timer of timers) clearTimeout(timer);

  if (controllerFailure || deadlineExpired || controller.state() !== 'DISARMED' || !result) {
    process.stderr.write(`staging deadline test settlement was not proven${controllerFailure
      ? `: ${controllerFailure.message}` : ''}\n`);
    process.exitCode = 125;
    return;
  }
  mailbox.dispose();
  process.exitCode = Number.isInteger(result.status) ? result.status : 125;
}

if (process.argv.length !== 3) {
  process.stderr.write('Usage: staging-deadline-test-harness.js BASE64URL_CONFIGURATION\n');
  process.exitCode = 64;
} else {
  run(decodeConfiguration(process.argv[2])).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 125;
  });
}
