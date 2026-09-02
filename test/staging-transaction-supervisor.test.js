import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { STAGING_DEADLINE_PROTOCOL } from '../scripts/staging-deadline-control.js';
import {
  parseStagingTransactionRecoveryAuthority,
  recoverStagingTransaction,
  runStagingTransaction,
} from '../scripts/staging-transaction-supervisor.js';

const TOKEN = 'c'.repeat(64);
const POSIX_PUBLICATION_SOURCE_BINDING = Object.freeze({
  birthtimeNs: '11',
  bytes: 17,
  ctimeNs: '12',
  dev: '13',
  gid: '14',
  ino: '15',
  mode: String(0o100600),
  sha256: 'a'.repeat(64),
  uid: '16',
});

function posixPublicationSourceBinding(file) {
  const identity = fsSync.lstatSync(file, { bigint: true });
  const bytes = fsSync.readFileSync(file);
  return Object.freeze({
    birthtimeNs: String(identity.birthtimeNs),
    bytes: bytes.length,
    ctimeNs: String(identity.ctimeNs),
    dev: String(identity.dev),
    gid: String(identity.gid),
    ino: String(identity.ino),
    mode: String(identity.mode),
    sha256: createHash('sha256').update(bytes).digest('hex'),
    uid: String(identity.uid),
  });
}

function rootOwnedPosixPublicationSourceBinding(file) {
  const binding = posixPublicationSourceBinding(file);
  return Object.freeze({
    ...binding,
    mode: String(BigInt(binding.mode) & ~0o077n),
    uid: '0',
  });
}

function syntheticPosixPublicationAuthority({ destination, temporary, tombstone }) {
  return Object.freeze({
    destination,
    sourceBinding: POSIX_PUBLICATION_SOURCE_BINDING,
    temporary,
    ...(tombstone === undefined ? {} : { tombstone }),
  });
}

function syntheticPosixRetirementAuthority(controlDirectory, token = 'd') {
  const parent = path.dirname(controlDirectory);
  const separator = controlDirectory.includes('\\') ? '\\' : '/';
  return Object.freeze({
    controlDirectory,
    reservationOwner: token.repeat(64),
    sourceDev: '17',
    sourceIno: '18',
    tombstone: `${parent}${parent.endsWith(separator) ? '' : separator}`
      + `.easyboost-staging-quarantine-slot.${token.repeat(64)}.tombstone`,
  });
}

function linuxPlatformPreloadSource() {
  return [
    "const fs=require('node:fs');",
    'const lstatSync=fs.lstatSync.bind(fs);',
    'fs.fsyncSync=()=>{};',
    'fs.lstatSync=(...args)=>{',
    'const stat=lstatSync(...args);',
    "const bigint=typeof stat.mode==='bigint';",
    "Object.defineProperty(stat,'mode',{configurable:true,value:bigint?stat.mode&~0o077n:stat.mode&~0o077});",
    "Object.defineProperty(stat,'uid',{configurable:true,value:bigint?0n:0});",
    'return stat;};',
    "Object.defineProperty(process,'getuid',{configurable:true,value:()=>0});",
    "Object.defineProperty(process,'platform',{configurable:true,value:'linux'});",
    '',
  ].join('');
}

function transition(action, seconds, sequence) {
  return { action, protocol: STAGING_DEADLINE_PROTOCOL, seconds, sequence, token: TOKEN };
}

function fixture({
  residualSession = false,
  rolloverAckAuthority,
  rolloverAckFailure = false,
  targetExitCode = 0,
} = {}) {
  const child = new EventEmitter();
  child.pid = 5151;
  child.unref = () => {};
  const acknowledgements = [];
  const requests = [];
  let wrapperClosed = false;
  let mailboxDisposed = false;
  let sessionDisposed = false;
  const mailbox = {
    acknowledge(value) {
      acknowledgements.push(value);
      if (rolloverAckFailure && value.state === 'RECOVERY') {
        const error = new Error('recovery acknowledgement persistence failed');
        if (rolloverAckAuthority) error.recoveryAuthority = rolloverAckAuthority;
        throw error;
      }
      if (value.state === 'DISARMED') {
        queueMicrotask(() => child.emit('close', 0, null));
      }
    },
    dispose() { mailboxDisposed = true; },
    environmentValue: 'fixture-deadline-environment',
    requestState(sequence) {
      if (!acknowledgements.some((record) => record.state === 'TRANSACTION')) {
        return { state: 'missing' };
      }
      if (sequence === 1) {
        return { record: rolloverAckFailure
          ? transition('ROLLOVER', 600, 1)
          : transition('DISARM', 0, 1), state: 'present' };
      }
      return { state: 'missing' };
    },
    specification: { controlDirectory: '/fixture/deadline', token: TOKEN },
  };
  const control = {
    dispose() { sessionDisposed = true; },
    markWrapperSpawned() {},
    observeWrapperClose() { wrapperClosed = true; },
    proofState() {
      return { state: wrapperClosed && !residualSession ? 'absent' : 'alive' };
    },
    readyState() {
      return {
        record: { processGroupId: 5151, sessionId: 5151, wrapperPid: 5151 },
        state: 'present',
      };
    },
    request(signal) {
      requests.push(signal);
      if (signal === 'SIGTERM') queueMicrotask(() => child.emit('close', null, 'SIGTERM'));
    },
    specification: { controlDirectory: '/fixture/session' },
    targetStatus() {
      return {
        exitCode: rolloverAckFailure ? null : targetExitCode,
        signal: null,
        state: 'present',
      };
    },
  };
  return {
    acknowledgements,
    child,
    control,
    mailbox,
    requests,
    states: () => ({ mailboxDisposed, sessionDisposed }),
  };
}

test('transaction wrapper requires READY then DISARM before successful session settlement', async () => {
  const state = fixture();
  const status = await runStagingTransaction({
    args: ['archive', 'sha'],
    createDeadlineMailbox: () => state.mailbox,
    createSessionInvocation(command, args, cwd, settlement, environment, control) {
      assert.equal(command, '/bin/bash');
      assert.equal(environment.EASYBOOST_STAGING_DEADLINE_CONTROL,
        state.mailbox.environmentValue);
      assert.equal(control, state.control);
      return { args: [], command: 'fixture-wrapper', posixSessionControl: control };
    },
    platform: 'linux',
    pollMilliseconds: 2,
    posixSessionControl: state.control,
    recoverySeconds: 600,
    reportRecoveryRequired() {},
    script: '/fixture/staging-deploy.sh',
    settlementMilliseconds: 20,
    spawnProcess() { return state.child; },
    startupMilliseconds: 20,
    termGraceMilliseconds: 10,
    transactionSeconds: 1_800,
  });

  assert.equal(status, 0);
  assert.deepEqual(state.acknowledgements.map(({ sequence, state: name }) => [sequence, name]), [
    [0, 'TRANSACTION'],
    [1, 'DISARMED'],
  ]);
  assert.deepEqual(state.requests, [], 'normal settlement must not request any signal');
  assert.deepEqual(state.states(), { mailboxDisposed: true, sessionDisposed: true });
});

test('transaction binds quiescent maintenance to both roots and strips its launcher proof', async () => {
  const state = fixture();
  const deadlineRoot = path.resolve('fixture-deadline-maintenance-root');
  const sessionRoot = path.resolve('fixture-session-maintenance-root');
  const transactionKey = `${path.resolve('/fixture/staging-deploy.sh')}:["archive","sha"]`;
  const deadlineAuthority = Object.freeze({ root: deadlineRoot, role: 'deadline' });
  const sessionAuthority = Object.freeze({ root: sessionRoot, role: 'session' });
  const deadlineReclaimer = () => true;
  const sessionReclaimer = () => true;
  const deadlineRotator = () => true;
  const sessionRotator = () => true;
  let deadlineOptions;
  let sessionOptions;
  const status = await runStagingTransaction({
    args: ['archive', 'sha'],
    createDeadlineMailbox(options) {
      deadlineOptions = options;
      return state.mailbox;
    },
    createSessionControl(options) {
      sessionOptions = options;
      return state.control;
    },
    createSessionInvocation(command, args, cwd, settlement, environment, control) {
      assert.equal(environment.SAFE_PARENT_VALUE, 'kept');
      assert.equal(environment.EASYBOOST_STAGING_QUIESCENT_MAINTENANCE, undefined);
      assert.equal(environment.EASYBOOST_STAGING_DEADLINE_CONTROL,
        state.mailbox.environmentValue);
      assert.equal(control, state.control);
      return { args: [], command: 'fixture-wrapper', posixSessionControl: control };
    },
    deadlineControlRoot: deadlineRoot,
    environment: {
      EASYBOOST_STAGING_QUIESCENT_MAINTENANCE: 'raw-launcher-proof',
      SAFE_PARENT_VALUE: 'kept',
    },
    platform: 'linux',
    pollMilliseconds: 2,
    prepareMaintenance(environment, roots) {
      assert.equal(environment.EASYBOOST_STAGING_QUIESCENT_MAINTENANCE,
        'raw-launcher-proof');
      assert.deepEqual(roots, [deadlineRoot, sessionRoot]);
      return {
        bindings: new Map([
          [deadlineRoot, {
            authority: deadlineAuthority,
            reclaimRetainedEvidence: deadlineReclaimer,
            rotateRecoveryBatonEpoch: deadlineRotator,
          }],
          [sessionRoot, {
            authority: sessionAuthority,
            reclaimRetainedEvidence: sessionReclaimer,
            rotateRecoveryBatonEpoch: sessionRotator,
          }],
        ]),
        environment: { SAFE_PARENT_VALUE: 'kept' },
      };
    },
    recoverySeconds: 600,
    reportRecoveryRequired() {},
    script: '/fixture/staging-deploy.sh',
    sessionControlRoot: sessionRoot,
    settlementMilliseconds: 20,
    spawnProcess() { return state.child; },
    startupMilliseconds: 20,
    termGraceMilliseconds: 10,
    transactionSeconds: 1_800,
  });

  assert.equal(status, 0);
  assert.deepEqual(sessionOptions, {
    controlKey: `staging-transaction:${transactionKey}`,
    controlRoot: sessionRoot,
    quiescentMaintenanceAuthority: sessionAuthority,
    reclaimRetainedEvidence: sessionReclaimer,
    rotateRecoveryBatonEpoch: sessionRotator,
  });
  assert.deepEqual(deadlineOptions, {
    controlKey: `staging-deadline:${transactionKey}`,
    controlRoot: deadlineRoot,
    quiescentMaintenanceAuthority: deadlineAuthority,
    reclaimRetainedEvidence: deadlineReclaimer,
    rotateRecoveryBatonEpoch: deadlineRotator,
  });
});

test('a proven target exit 125 does not report recovery authority', async () => {
  const state = fixture({ targetExitCode: 125 });
  const reports = [];
  const status = await runStagingTransaction({
    createDeadlineMailbox: () => state.mailbox,
    createSessionInvocation(command, args, cwd, settlement, environment, control) {
      return { args: [], command: 'fixture-wrapper', posixSessionControl: control };
    },
    platform: 'linux',
    pollMilliseconds: 2,
    posixSessionControl: state.control,
    recoverySeconds: 600,
    reportRecoveryRequired(authority) { reports.push(authority); },
    script: '/fixture/staging-deploy.sh',
    settlementMilliseconds: 20,
    spawnProcess() { return state.child; },
    startupMilliseconds: 20,
    termGraceMilliseconds: 10,
    transactionSeconds: 1_800,
  });

  assert.equal(status, 125);
  assert.deepEqual(reports, [], 'a legitimate target status is not a retained authority');
  assert.deepEqual(state.states(), { mailboxDisposed: true, sessionDisposed: true });
});

test('failed recovery rollover acknowledgement terminates cooperatively and stays fail-closed',
  async () => {
    const state = fixture({ rolloverAckFailure: true });
    const status = await runStagingTransaction({
      createDeadlineMailbox: () => state.mailbox,
      createSessionInvocation(command, args, cwd, settlement, environment, control) {
        return { args: [], command: 'fixture-wrapper', posixSessionControl: control };
      },
      platform: 'linux',
      pollMilliseconds: 2,
      posixSessionControl: state.control,
      recoverySeconds: 600,
      reportRecoveryRequired() {},
      script: '/fixture/staging-rollback.sh',
      settlementMilliseconds: 20,
      spawnProcess() { return state.child; },
      startupMilliseconds: 20,
      termGraceMilliseconds: 10,
      transactionSeconds: 1_800,
    });

    assert.equal(status, 125);
    assert.deepEqual(state.requests, ['SIGTERM'],
      'the controller may only make a tokenized cooperative request');
    assert.deepEqual(state.states(), { mailboxDisposed: false, sessionDisposed: true },
      'failed ACK authority remains durable while the proven-empty session may be disposed');
  });

test('a closed wrapper with a residual session reaches the settlement bound after DISARM', async () => {
  const state = fixture({ residualSession: true });
  const reports = [];
  const status = await Promise.race([
    runStagingTransaction({
      createDeadlineMailbox: () => state.mailbox,
      createSessionInvocation(command, args, cwd, settlement, environment, control) {
        return { args: [], command: 'fixture-wrapper', posixSessionControl: control };
      },
      platform: 'linux',
      pollMilliseconds: 2,
      posixSessionControl: state.control,
      recoverySeconds: 600,
      reportRecoveryRequired(authority) { reports.push(authority); },
      script: '/fixture/staging-deploy.sh',
      settlementMilliseconds: 15,
      spawnProcess() { return state.child; },
      startupMilliseconds: 20,
      termGraceMilliseconds: 10,
      transactionSeconds: 1_800,
    }),
    new Promise((resolve) => setTimeout(() => resolve('hung'), 250)),
  ]);

  assert.equal(status, 125, 'wrapper close must never leave an unbounded polling-only promise');
  assert.deepEqual(reports, [{
    deadlineControlDirectory: '/fixture/deadline',
    posixSessionControlDirectory: '/fixture/session',
    protocol: 'easyboost-staging-transaction-recovery-v1',
  }]);
  assert.deepEqual(state.states(), { mailboxDisposed: false, sessionDisposed: false });
});

test('a no-PID wrapper error reports no recovery authority after both cleanups succeed', async () => {
  const state = fixture();
  state.child.pid = undefined;
  const reports = [];
  const status = await runStagingTransaction({
    createDeadlineMailbox: () => state.mailbox,
    createSessionInvocation(command, args, cwd, settlement, environment, control) {
      return { args: [], command: 'fixture-wrapper', posixSessionControl: control };
    },
    platform: 'linux',
    pollMilliseconds: 2,
    posixSessionControl: state.control,
    recoverySeconds: 600,
    reportRecoveryRequired(authority) { reports.push(authority); },
    script: '/fixture/staging-deploy.sh',
    settlementMilliseconds: 20,
    spawnProcess() {
      queueMicrotask(() => state.child.emit('error', new Error('synthetic no-PID spawn error')));
      return state.child;
    },
    startupMilliseconds: 20,
    termGraceMilliseconds: 10,
    transactionSeconds: 1_800,
  });

  assert.equal(status, 125);
  assert.deepEqual(reports, [], 'removed namespaces are not recovery authorities');
  assert.deepEqual(state.states(), { mailboxDisposed: true, sessionDisposed: true });
});

test('runtime failure reports only the deadline after proven session disposal', async () => {
  const state = fixture({ rolloverAckFailure: true });
  const reports = [];
  const status = await runStagingTransaction({
    createDeadlineMailbox: () => state.mailbox,
    createSessionInvocation(command, args, cwd, settlement, environment, control) {
      return { args: [], command: 'fixture-wrapper', posixSessionControl: control };
    },
    platform: 'linux',
    pollMilliseconds: 2,
    posixSessionControl: state.control,
    recoverySeconds: 600,
    reportRecoveryRequired(authority) { reports.push(authority); },
    script: '/fixture/staging-rollback.sh',
    settlementMilliseconds: 20,
    spawnProcess() { return state.child; },
    startupMilliseconds: 20,
    termGraceMilliseconds: 10,
    transactionSeconds: 1_800,
  });

  assert.equal(status, 125);
  assert.deepEqual(reports, [{
    deadlineControlDirectory: '/fixture/deadline',
    posixSessionControlDirectory: null,
    protocol: 'easyboost-staging-transaction-recovery-v1',
  }]);
});

test('runtime session disposal preserves exact sibling-publication recovery authority', async () => {
  const state = fixture();
  const publication = syntheticPosixPublicationAuthority({
    destination: '/fixture/session/retirement.claim',
    temporary: `/fixture/.session.retirement.claim.${'5'.repeat(32)}.tmp`,
    tombstone: `/fixture/..session.retirement.claim.${'5'.repeat(32)}.tmp.cleanup.${'d'.repeat(64)}.tombstone`,
  });
  const disposalFailure = new Error('synthetic session retirement publication failure');
  disposalFailure.recoveryAuthority = publication;
  state.control.dispose = () => { throw disposalFailure; };
  const reports = [];
  const status = await runStagingTransaction({
    createDeadlineMailbox: () => state.mailbox,
    createSessionInvocation(command, args, cwd, settlement, environment, control) {
      return { args: [], command: 'fixture-wrapper', posixSessionControl: control };
    },
    platform: 'linux',
    pollMilliseconds: 2,
    posixSessionControl: state.control,
    recoverySeconds: 600,
    reportRecoveryRequired(authority) { reports.push(authority); },
    script: '/fixture/staging-deploy.sh',
    settlementMilliseconds: 20,
    spawnProcess() { return state.child; },
    startupMilliseconds: 20,
    termGraceMilliseconds: 10,
    transactionSeconds: 1_800,
  });
  assert.equal(status, 125);
  assert.deepEqual(reports, [{
    deadlineControlDirectory: '/fixture/deadline',
    posixSessionControlDirectory: '/fixture/session',
    posixSessionPublicationAuthority: publication,
    protocol: 'easyboost-staging-transaction-recovery-v1',
  }]);
});

test('no-PID cleanup preserves exact deadline sibling-publication recovery authority', async () => {
  const state = fixture();
  state.child.pid = undefined;
  const publication = Object.freeze({
    destination: '/fixture/deadline/retirement.claim',
    temporary: `/fixture/.deadline.retirement.claim.${'6'.repeat(32)}.tmp`,
  });
  const disposalFailure = new Error('synthetic deadline retirement publication failure');
  disposalFailure.recoveryAuthority = publication;
  state.mailbox.dispose = () => { throw disposalFailure; };
  const reports = [];
  const status = await runStagingTransaction({
    createDeadlineMailbox: () => state.mailbox,
    createSessionInvocation(command, args, cwd, settlement, environment, control) {
      return { args: [], command: 'fixture-wrapper', posixSessionControl: control };
    },
    platform: 'linux',
    posixSessionControl: state.control,
    recoverySeconds: 600,
    reportRecoveryRequired(authority) { reports.push(authority); },
    script: '/fixture/staging-deploy.sh',
    spawnProcess() {
      queueMicrotask(() => state.child.emit('error', new Error('synthetic no-PID error')));
      return state.child;
    },
    transactionSeconds: 1_800,
  });
  assert.equal(status, 125);
  assert.deepEqual(reports, [{
    deadlineControlDirectory: '/fixture/deadline',
    deadlinePublicationAuthority: publication,
    posixSessionControlDirectory: null,
    protocol: 'easyboost-staging-transaction-recovery-v1',
  }]);
});

test('runtime session disposal preserves exact retirement tombstone authority', async () => {
  const state = fixture();
  const retirement = syntheticPosixRetirementAuthority('/fixture/session', 'a');
  const disposalFailure = new Error('synthetic session retirement tombstone failure');
  disposalFailure.recoveryAuthority = retirement;
  state.control.dispose = () => { throw disposalFailure; };
  const reports = [];
  const status = await runStagingTransaction({
    createDeadlineMailbox: () => state.mailbox,
    createSessionInvocation(command, args, cwd, settlement, environment, control) {
      return { args: [], command: 'fixture-wrapper', posixSessionControl: control };
    },
    platform: 'linux',
    pollMilliseconds: 2,
    posixSessionControl: state.control,
    recoverySeconds: 600,
    reportRecoveryRequired(authority) { reports.push(authority); },
    script: '/fixture/staging-deploy.sh',
    settlementMilliseconds: 20,
    spawnProcess() { return state.child; },
    startupMilliseconds: 20,
    termGraceMilliseconds: 10,
    transactionSeconds: 1_800,
  });
  assert.equal(status, 125);
  assert.deepEqual(reports, [{
    deadlineControlDirectory: '/fixture/deadline',
    posixSessionControlDirectory: '/fixture/session',
    posixSessionRetirementAuthority: retirement,
    protocol: 'easyboost-staging-transaction-recovery-v1',
  }]);
});

test('runtime session disposal forwards its restart handoff without a generic retry', async () => {
  const state = fixture();
  const script = '/fixture/staging-deploy.sh';
  const args = ['archive', 'sha'];
  const key = `${path.resolve(script)}:${JSON.stringify(args)}`;
  const deadlineRoot = path.resolve('/fixture/deadline-root');
  const sessionRoot = path.resolve('/fixture/session-root');
  const deadlineDirectory = path.join(deadlineRoot, createHash('sha256')
    .update(`staging-deadline:${key}`, 'utf8').digest('hex'));
  const sessionDirectory = path.join(sessionRoot, createHash('sha256')
    .update(`staging-transaction:${key}`, 'utf8').digest('hex'));
  state.mailbox.specification.controlDirectory = deadlineDirectory;
  state.control.specification.controlDirectory = sessionDirectory;
  const handoff = Object.freeze({
    claimPath: path.join(sessionDirectory, 'retirement.claim'),
    controlDirectory: sessionDirectory,
    controlKey: `staging-transaction:${key}`,
    controlRoot: sessionRoot,
    protocol: 'easyboost-posix-session-recovery-handoff-v1',
    recoveryScope: deadlineDirectory,
    retirementOwner: 'a'.repeat(64),
  });
  const failure = new Error('synthetic session restart handoff');
  failure.recoveryAuthority = Object.freeze({
    controlDirectory: sessionDirectory,
    recoveryHandoff: handoff,
  });
  Object.defineProperty(failure, 'recoveryHandoff', { value: handoff });
  state.control.dispose = () => { throw failure; };
  const reports = [];
  const status = await runStagingTransaction({
    args,
    createDeadlineMailbox: () => state.mailbox,
    createSessionInvocation(command, invocationArgs, cwd, settlement, environment, control) {
      return { args: [], command: 'fixture-wrapper', posixSessionControl: control };
    },
    platform: 'linux',
    pollMilliseconds: 2,
    posixSessionControl: state.control,
    recoverySeconds: 600,
    reportRecoveryRequired(authority) { reports.push(authority); },
    script,
    settlementMilliseconds: 20,
    spawnProcess() { return state.child; },
    startupMilliseconds: 20,
    termGraceMilliseconds: 10,
    transactionSeconds: 1_800,
  });
  assert.equal(status, 125);
  assert.deepEqual(reports, [{
    deadlineControlDirectory: deadlineDirectory,
    posixSessionControlDirectory: sessionDirectory,
    posixSessionRecoveryHandoff: handoff,
    protocol: 'easyboost-staging-transaction-recovery-v1',
  }]);
  assert.deepEqual(parseStagingTransactionRecoveryAuthority(JSON.stringify(reports[0])), reports[0]);
});

test('no-PID cleanup preserves exact deadline retirement tombstone authority', async () => {
  const state = fixture();
  state.child.pid = undefined;
  const retirement = Object.freeze({
    controlDirectory: '/fixture/deadline',
    tombstone: `/fixture/.deadline.retire.${'b'.repeat(64)}.tombstone`,
  });
  const disposalFailure = new Error('synthetic deadline retirement tombstone failure');
  disposalFailure.recoveryAuthority = retirement;
  state.mailbox.dispose = () => { throw disposalFailure; };
  const reports = [];
  const status = await runStagingTransaction({
    createDeadlineMailbox: () => state.mailbox,
    createSessionInvocation(command, args, cwd, settlement, environment, control) {
      return { args: [], command: 'fixture-wrapper', posixSessionControl: control };
    },
    platform: 'linux',
    posixSessionControl: state.control,
    recoverySeconds: 600,
    reportRecoveryRequired(authority) { reports.push(authority); },
    script: '/fixture/staging-deploy.sh',
    spawnProcess() {
      queueMicrotask(() => state.child.emit('error', new Error('synthetic no-PID error')));
      return state.child;
    },
    transactionSeconds: 1_800,
  });
  assert.equal(status, 125);
  assert.deepEqual(reports, [{
    deadlineControlDirectory: '/fixture/deadline',
    deadlineRetirementAuthority: retirement,
    posixSessionControlDirectory: null,
    protocol: 'easyboost-staging-transaction-recovery-v1',
  }]);
});

test('TERM and KILL request failures retain exact session publication authority and namespace',
  async () => {
    for (const failedSignal of ['SIGTERM', 'SIGKILL']) {
      const state = fixture({ rolloverAckFailure: true });
      const publication = syntheticPosixPublicationAuthority({
        destination: `/fixture/session/${failedSignal.toLowerCase()}.request`,
        temporary: `/fixture/.session.${failedSignal.toLowerCase()}.request.${'b'.repeat(32)}.tmp`,
      });
      const requestFailure = new Error(`synthetic ${failedSignal} publication failure`);
      requestFailure.recoveryAuthority = publication;
      state.control.request = (signal) => {
        if (signal === failedSignal) {
          queueMicrotask(() => state.child.emit('close', null, signal));
          throw requestFailure;
        }
      };
      const reports = [];
      const status = await runStagingTransaction({
        createDeadlineMailbox: () => state.mailbox,
        createSessionInvocation(command, args, cwd, settlement, environment, control) {
          return { args: [], command: 'fixture-wrapper', posixSessionControl: control };
        },
        platform: 'linux',
        pollMilliseconds: 2,
        posixSessionControl: state.control,
        recoverySeconds: 600,
        reportRecoveryRequired(authority) { reports.push(authority); },
        script: '/fixture/staging-deploy.sh',
        settlementMilliseconds: 20,
        spawnProcess() { return state.child; },
        startupMilliseconds: 20,
        termGraceMilliseconds: 5,
        transactionSeconds: 1_800,
      });
      assert.equal(status, 125, failedSignal);
      assert.deepEqual(reports, [{
        deadlineControlDirectory: '/fixture/deadline',
        posixSessionControlDirectory: '/fixture/session',
        posixSessionPublicationAuthority: publication,
        protocol: 'easyboost-staging-transaction-recovery-v1',
      }], failedSignal);
      assert.equal(state.states().sessionDisposed, false,
        `${failedSignal} residue requires its parent namespace for typed cleanup`);
    }
  });

test('READY and rollover ACK failures retain exact deadline publication authority', async () => {
  for (const stage of ['READY', 'RECOVERY']) {
    const publication = Object.freeze({
      destination: `/fixture/deadline/${stage.toLowerCase()}.ack`,
      temporary: `/fixture/.deadline.${stage.toLowerCase()}.ack.${'c'.repeat(32)}.tmp`,
    });
    const state = fixture({
      rolloverAckAuthority: publication,
      rolloverAckFailure: stage === 'RECOVERY',
    });
    if (stage === 'READY') {
      const acknowledge = state.mailbox.acknowledge;
      state.mailbox.acknowledge = (value) => {
        if (value.state === 'TRANSACTION') {
          const error = new Error('READY acknowledgement publication failure');
          error.recoveryAuthority = publication;
          throw error;
        }
        return acknowledge(value);
      };
    }
    const reports = [];
    const status = await runStagingTransaction({
      createDeadlineMailbox: () => state.mailbox,
      createSessionInvocation(command, args, cwd, settlement, environment, control) {
        return { args: [], command: 'fixture-wrapper', posixSessionControl: control };
      },
      platform: 'linux',
      pollMilliseconds: 2,
      posixSessionControl: state.control,
      recoverySeconds: 600,
      reportRecoveryRequired(authority) { reports.push(authority); },
      script: '/fixture/staging-deploy.sh',
      settlementMilliseconds: 20,
      spawnProcess() { return state.child; },
      startupMilliseconds: 20,
      termGraceMilliseconds: 5,
      transactionSeconds: 1_800,
    });
    assert.equal(status, 125, stage);
    assert.deepEqual(reports, [{
      deadlineControlDirectory: '/fixture/deadline',
      deadlinePublicationAuthority: publication,
      posixSessionControlDirectory: null,
      protocol: 'easyboost-staging-transaction-recovery-v1',
    }], stage);
  }
});

test('fd3 writer egress and parent TERM/KILL failures retain a bounded plural exact authority',
  async () => {
    const state = fixture();
    state.child.stdio = [null, null, null, new EventEmitter()];
    const publications = ['wrapper', 'term', 'kill'].map((name, index) => (
      syntheticPosixPublicationAuthority({
      destination: `/fixture/session/${name}.json`,
      temporary: `/fixture/.session.${name}.json.${String(index + 1).repeat(32)}.tmp`,
      })
    ));
    state.mailbox.requestState = () => ({ state: 'missing' });
    state.control.request = (signal) => {
      const index = signal === 'SIGTERM' ? 1 : 2;
      const error = new Error(`synthetic ${signal} publication failure`);
      error.recoveryAuthority = publications[index];
      throw error;
    };
    const reports = [];
    let observerCancelled = false;
    const status = await runStagingTransaction({
      createDeadlineMailbox: () => state.mailbox,
      createSessionInvocation(command, args, cwd, settlement, environment, control) {
        return {
          args: [], command: 'fixture-wrapper', posixSessionControl: control,
          writerEgress: { descriptor: 3, specification: control.specification },
        };
      },
      observeSessionWriterEgress(stream, specification, callbacks) {
        assert.equal(stream, state.child.stdio[3]);
        assert.equal(specification, state.control.specification);
        queueMicrotask(() => {
          callbacks.onAuthority(publications[0]);
          callbacks.onEnd();
        });
        return { cancel() { observerCancelled = true; } };
      },
      platform: 'linux',
      pollMilliseconds: 2,
      posixSessionControl: state.control,
      recoverySeconds: 600,
      reportRecoveryRequired(authority) { reports.push(authority); },
      script: '/fixture/staging-deploy.sh',
      settlementMilliseconds: 8,
      spawnProcess(command, args, options) {
        assert.deepEqual(options.stdio, ['inherit', 'inherit', 'inherit', 'pipe']);
        return state.child;
      },
      startupMilliseconds: 20,
      termGraceMilliseconds: 5,
      transactionSeconds: 1_800,
    });
    assert.equal(status, 125);
    assert.equal(observerCancelled, true);
    assert.deepEqual(reports, [{
      deadlineControlDirectory: '/fixture/deadline',
      posixSessionControlDirectory: '/fixture/session',
      posixSessionPublicationAuthorities: publications,
      protocol: 'easyboost-staging-transaction-recovery-v1',
    }]);
  });

test('transaction waits for empty fd3 EOF whether it arrives before or after wrapper close',
  async () => {
    for (const order of ['end-first', 'close-first']) {
      const state = fixture();
      state.child.stdio = [null, null, null, new EventEmitter()];
      let callbacks;
      const pending = runStagingTransaction({
        createDeadlineMailbox: () => state.mailbox,
        createSessionInvocation(command, args, cwd, settlement, environment, control) {
          return {
            args: [], command: 'fixture-wrapper', posixSessionControl: control,
            writerEgress: { descriptor: 3, specification: control.specification },
          };
        },
        observeSessionWriterEgress(stream, specification, value) {
          callbacks = value;
          return { cancel() {} };
        },
        platform: 'linux',
        pollMilliseconds: 2,
        posixSessionControl: state.control,
        recoverySeconds: 600,
        script: '/fixture/staging-deploy.sh',
        settlementMilliseconds: 30,
        spawnProcess() { return state.child; },
        startupMilliseconds: 20,
        termGraceMilliseconds: 10,
        transactionSeconds: 1_800,
      });
      if (order === 'end-first') {
        callbacks.onEnd();
      } else {
        await new Promise((resolve) => setTimeout(resolve, 8));
        callbacks.onEnd();
      }
      assert.equal(await pending, 0, order);
    }
  });

test('settlement bound destroys an unread fd3 pipe before resolving recovery status', async () => {
  const state = fixture({ residualSession: true });
  const stream = new EventEmitter();
  let destroyed = false;
  let observerCancelled = false;
  stream.destroy = () => { destroyed = true; };
  state.child.stdio = [null, null, null, stream];
  const status = await Promise.race([
    runStagingTransaction({
      createDeadlineMailbox: () => state.mailbox,
      createSessionInvocation(command, args, cwd, settlement, environment, control) {
        return {
          args: [], command: 'fixture-wrapper', posixSessionControl: control,
          writerEgress: { descriptor: 3, specification: control.specification },
        };
      },
      observeSessionWriterEgress() {
        return { cancel() { observerCancelled = true; } };
      },
      platform: 'linux',
      pollMilliseconds: 2,
      posixSessionControl: state.control,
      recoverySeconds: 600,
      reportRecoveryRequired() {},
      script: '/fixture/staging-deploy.sh',
      settlementMilliseconds: 12,
      spawnProcess() { return state.child; },
      startupMilliseconds: 20,
      termGraceMilliseconds: 5,
      transactionSeconds: 1_800,
    }),
    new Promise((resolve) => setTimeout(() => resolve('hung'), 250)),
  ]);
  assert.equal(status, 125);
  assert.equal(observerCancelled, true);
  assert.equal(destroyed, true);
});

test('unsupported native platform fails before spawning or signaling a staging transaction', () => {
  let spawned = false;
  assert.throws(() => runStagingTransaction({
    platform: 'win32',
    recoverySeconds: 600,
    script: 'C:\\fixture\\staging-deploy.sh',
    spawnProcess() { spawned = true; },
    transactionSeconds: 1_800,
  }), (error) => error?.exitCode === 125);
  assert.equal(spawned, false);
});

test('typed transaction recovery proves the owned session before retiring its acknowledged deadline', () => {
  const calls = [];
  const recoveryProof = Object.freeze({ fixture: 'opaque-session-proof' });
  const deadlineRoot = path.resolve('/fixture/deadline-root');
  const sessionRoot = path.resolve('/fixture/session-root');
  const deadlineBinding = Object.freeze({
    authority: Object.freeze({ role: 'deadline' }),
    reclaimRetainedEvidence: () => true,
    rotateRecoveryBatonEpoch: () => true,
  });
  const sessionBinding = Object.freeze({
    authority: Object.freeze({ role: 'session' }),
    reclaimRetainedEvidence: () => true,
    rotateRecoveryBatonEpoch: () => true,
  });
  const recovered = recoverStagingTransaction({
    args: ['archive', 'sha'],
    completeSessionRecovery(proof, options) {
      calls.push(['complete-session', { ...options, proof }]);
      return true;
    },
    deadlineControlRoot: deadlineRoot,
    platform: 'linux',
    prepareMaintenance(environment, roots) {
      assert.deepEqual(roots, [deadlineRoot, sessionRoot]);
      return {
        bindings: new Map([
          [deadlineRoot, deadlineBinding],
          [sessionRoot, sessionBinding],
        ]),
        environment,
      };
    },
    recoverDeadline(options) {
      calls.push(['deadline', options]);
      return { finalSequence: 1, state: 'DISARMED' };
    },
    recoverSession(options) {
      calls.push(['session', options]);
      return {
        processGroupId: 7171, recoveryProof, sessionId: 7171, state: 'absent',
      };
    },
    script: '/fixture/staging-deploy.sh',
    sessionControlRoot: sessionRoot,
  });
  assert.deepEqual(calls.map(([kind, options]) => [kind, options.retire]), [
    ['session', false], ['deadline', false], ['complete-session', undefined],
  ]);
  assert.equal(calls[0][1].controlKey, calls[2][1].controlKey);
  assert.equal(calls[2][1].proof, recoveryProof);
  assert.match(calls[0][1].controlKey, /^staging-transaction:/u);
  assert.match(calls[1][1].controlKey, /^staging-deadline:/u);
  for (const options of [calls[0][1], calls[2][1]]) {
    assert.equal(options.quiescentMaintenanceAuthority, sessionBinding.authority);
    assert.equal(options.reclaimRetainedEvidence, sessionBinding.reclaimRetainedEvidence);
    assert.equal(options.rotateRecoveryBatonEpoch, sessionBinding.rotateRecoveryBatonEpoch);
  }
  assert.equal(calls[1][1].quiescentMaintenanceAuthority, deadlineBinding.authority);
  assert.equal(calls[1][1].reclaimRetainedEvidence, deadlineBinding.reclaimRetainedEvidence);
  assert.equal(calls[1][1].rotateRecoveryBatonEpoch, deadlineBinding.rotateRecoveryBatonEpoch);
  assert.deepEqual(recovered, {
    deadline: { finalSequence: 1, state: 'DISARMED' },
    session: {
      processGroupId: 7171, recoveryProof, sessionId: 7171, state: 'absent',
    },
  });
});

test('root transaction recovery retires only an absence-proven canonical incomplete authority', () => {
  const calls = [];
  const recoveryProof = Object.freeze({ fixture: 'opaque-session-proof' });
  const deadlinePublicationAuthority = Object.freeze({
    destination: '/fixture/deadline-root/owned/control.json',
    temporary: '/fixture/deadline-root/.owned.control.json.11111111111111111111111111111111.tmp',
  });
  const posixSessionPublicationAuthority = syntheticPosixPublicationAuthority({
    destination: '/fixture/session-root/owned/control.json',
    temporary: '/fixture/session-root/.owned.control.json.22222222222222222222222222222222.tmp',
  });
  const recovered = recoverStagingTransaction({
    args: ['archive', 'sha'],
    cleanupDeadlinePublication(authority) {
      calls.push(['cleanup-deadline-publication', authority]);
    },
    cleanupSessionPublication(authority) {
      calls.push(['cleanup-session-publication', authority]);
    },
    completeSessionRecovery(proof, options) {
      calls.push(['complete-session', { ...options, proof }]);
      return true;
    },
    deadlineControlRoot: '/fixture/deadline-root',
    deadlinePublicationAuthority,
    platform: 'linux',
    posixSessionPublicationAuthority,
    recoverDeadline(options) {
      calls.push(['deadline', options]);
      return { finalSequence: 1, state: 'incomplete' };
    },
    recoverSession(options) {
      calls.push(['session', options]);
      return {
        absence: 'absent', processGroupId: 7172, recoveryProof, sessionId: 7172,
        state: 'incomplete',
      };
    },
    script: '/fixture/staging-deploy.sh',
    sessionControlRoot: '/fixture/session-root',
  });
  assert.deepEqual(calls.map(([kind, options]) => [
    kind, options.permitIncompleteRetirement, options.retire,
  ]), [
    ['cleanup-session-publication', undefined, undefined],
    ['session', true, false],
    ['cleanup-deadline-publication', undefined, undefined],
    ['deadline', true, false],
    ['complete-session', undefined, undefined],
  ]);
  assert.deepEqual(calls[0][1], posixSessionPublicationAuthority);
  assert.equal(calls[2][1], deadlinePublicationAuthority);
  assert.equal(calls[3][1].sessionRecoveryProof, recoveryProof);
  assert.equal(calls[4][1].proof, recoveryProof);
  assert.equal(calls[1][1].publicationResidue, undefined);
  assert.equal(calls[3][1].publicationResidue, undefined);
  assert.deepEqual(recovered, {
    deadline: { finalSequence: 1, state: 'incomplete' },
    session: {
      absence: 'absent', processGroupId: 7172, recoveryProof, sessionId: 7172,
      state: 'incomplete',
    },
  });
});

test('recovery-stage writer residue is normalized to a reusable full transaction authority', () => {
  const script = '/fixture/staging-deploy.sh';
  const args = ['archive', 'sha'];
  const key = `${path.resolve(script)}:${JSON.stringify(args)}`;
  const deadlineRoot = path.resolve('/fixture/deadline-root');
  const sessionRoot = path.resolve('/fixture/session-root');
  const deadlineDirectory = path.join(deadlineRoot, createHash('sha256')
    .update(`staging-deadline:${key}`, 'utf8').digest('hex'));
  const sessionDirectory = path.join(sessionRoot, createHash('sha256')
    .update(`staging-transaction:${key}`, 'utf8').digest('hex'));
  const scenarios = [
    {
      expected: {
        deadlineControlDirectory: deadlineDirectory,
        posixSessionControlDirectory: sessionDirectory,
        posixSessionPublicationAuthority: syntheticPosixPublicationAuthority({
          destination: path.join(sessionDirectory, 'retirement.claim'),
          temporary: path.join(sessionRoot,
            `.${path.basename(sessionDirectory)}.retirement.claim.${'7'.repeat(32)}.tmp`),
        }),
        protocol: 'easyboost-staging-transaction-recovery-v1',
      },
      stage: 'session',
    },
    {
      expected: {
        deadlineControlDirectory: deadlineDirectory,
        deadlinePublicationAuthority: {
          destination: path.join(deadlineDirectory, 'retirement.claim'),
          temporary: path.join(deadlineRoot,
            `.${path.basename(deadlineDirectory)}.retirement.claim.${'8'.repeat(32)}.tmp`),
        },
        posixSessionControlDirectory: sessionDirectory,
        protocol: 'easyboost-staging-transaction-recovery-v1',
      },
      stage: 'deadline',
    },
    {
      expected: {
        deadlineControlDirectory: null,
        posixSessionControlDirectory: sessionDirectory,
        posixSessionPublicationAuthority: syntheticPosixPublicationAuthority({
          destination: path.join(sessionDirectory, 'retirement.claim'),
          temporary: path.join(sessionRoot,
            `.${path.basename(sessionDirectory)}.retirement.claim.${'9'.repeat(32)}.tmp`),
        }),
        protocol: 'easyboost-staging-transaction-recovery-v1',
      },
      stage: 'completion',
    },
  ];
  for (const { expected, stage } of scenarios) {
    const failure = new Error(`synthetic ${stage} recovery publication failure`);
    failure.recoveryAuthority = stage === 'deadline'
      ? expected.deadlinePublicationAuthority : expected.posixSessionPublicationAuthority;
    assert.throws(() => recoverStagingTransaction({
      args,
      completeSessionRecovery() {
        if (stage === 'completion') throw failure;
        return true;
      },
      deadlineControlRoot: deadlineRoot,
      platform: 'linux',
      recoverDeadline() {
        if (stage === 'deadline') throw failure;
        return { state: 'not-created' };
      },
      recoverSession() {
        if (stage === 'session') throw failure;
        return { absence: 'absent', recoveryProof: {}, state: 'incomplete' };
      },
      script,
      sessionControlRoot: sessionRoot,
    }), (error) => error?.exitCode === 125
      && JSON.stringify(error?.recoveryAuthority) === JSON.stringify(expected)
      && JSON.stringify(parseStagingTransactionRecoveryAuthority(
        JSON.stringify(error.recoveryAuthority),
      )) === JSON.stringify(expected));
  }
});

test('transaction recovery round-trips both restart-safe handoffs and resumes each baton once', () => {
  const script = '/fixture/staging-deploy.sh';
  const args = ['archive', 'sha'];
  const key = `${path.resolve(script)}:${JSON.stringify(args)}`;
  const deadlineRoot = path.resolve('/fixture/deadline-root');
  const sessionRoot = path.resolve('/fixture/session-root');
  const deadlineKey = `staging-deadline:${key}`;
  const sessionKey = `staging-transaction:${key}`;
  const deadlineDirectory = path.join(deadlineRoot, createHash('sha256')
    .update(deadlineKey, 'utf8').digest('hex'));
  const sessionDirectory = path.join(sessionRoot, createHash('sha256')
    .update(sessionKey, 'utf8').digest('hex'));
  const handoff = (role, suffix) => Object.freeze({
    claimPath: path.join(role === 'deadline' ? deadlineDirectory : sessionDirectory,
      `.recovery-baton.${suffix.repeat(64)}.claim`),
    controlDirectory: role === 'deadline' ? deadlineDirectory : sessionDirectory,
    controlKey: role === 'deadline' ? deadlineKey : sessionKey,
    controlRoot: role === 'deadline' ? deadlineRoot : sessionRoot,
    protocol: role === 'deadline'
      ? 'easyboost-staging-deadline-recovery-handoff-v1'
      : 'easyboost-posix-session-recovery-handoff-v1',
    recoveryScope: role === 'deadline'
      ? JSON.stringify({ fingerprint: 'f'.repeat(64), result: { state: 'incomplete' } })
      : deadlineDirectory,
    retirementOwner: suffix.repeat(64),
  });
  const capable = (value, recoveryHandoff, recoveryProof) => {
    Object.defineProperty(value, 'recoveryHandoff', { value: recoveryHandoff });
    Object.defineProperty(value, 'recoveryProof', { value: recoveryProof });
    return Object.freeze(value);
  };
  const firstSession = handoff('session', 'a');
  const firstDeadline = handoff('deadline', 'b');
  const deadlineFailure = new Error('synthetic deadline recovery interruption');
  deadlineFailure.recoveryAuthority = Object.freeze({
    controlDirectory: deadlineDirectory,
    recoveryHandoff: firstDeadline,
  });
  Object.defineProperty(deadlineFailure, 'recoveryHandoff', { value: firstDeadline });
  let authority;
  assert.throws(() => recoverStagingTransaction({
    args,
    deadlineControlRoot: deadlineRoot,
    platform: 'linux',
    recoverDeadline() { throw deadlineFailure; },
    recoverSession() {
      return capable({ absence: 'absent', state: 'incomplete' }, firstSession, {});
    },
    script,
    sessionControlRoot: sessionRoot,
  }), (error) => {
    authority = error?.recoveryAuthority;
    return error?.exitCode === 125
      && JSON.stringify(authority?.deadlineRecoveryHandoff) === JSON.stringify(firstDeadline)
      && JSON.stringify(authority?.posixSessionRecoveryHandoff) === JSON.stringify(firstSession);
  });
  assert.deepEqual(parseStagingTransactionRecoveryAuthority(JSON.stringify(authority)), authority);

  const nextSession = handoff('session', 'c');
  const nextDeadline = handoff('deadline', 'd');
  const sessionProof = Object.freeze({ fixture: 'resumed-session-proof' });
  const deadlineProof = Object.freeze({ fixture: 'resumed-deadline-proof' });
  const calls = [];
  const recovered = recoverStagingTransaction({
    args,
    completeDeadlineRecovery(proof) {
      calls.push(['complete-deadline', proof]);
      return true;
    },
    completeSessionRecovery(proof) {
      calls.push(['complete-session', proof]);
      return true;
    },
    deadlineControlRoot: deadlineRoot,
    platform: 'linux',
    recoverDeadline() { throw new Error('must resume deadline handoff'); },
    recoverSession() { throw new Error('must resume session handoff'); },
    recoveryAuthority: authority,
    resumeDeadlineRecovery(value) {
      calls.push(['resume-deadline', value]);
      return capable({ state: 'incomplete' }, nextDeadline, deadlineProof);
    },
    resumeSessionRecovery(value) {
      calls.push(['resume-session', value]);
      return capable({ absence: 'absent', state: 'incomplete' }, nextSession, sessionProof);
    },
    script,
    sessionControlRoot: sessionRoot,
  });
  assert.deepEqual(calls, [
    ['resume-session', firstSession],
    ['resume-deadline', firstDeadline],
    ['complete-deadline', deadlineProof],
    ['complete-session', sessionProof],
  ]);
  assert.deepEqual(recovered, {
    deadline: { state: 'incomplete' },
    session: { absence: 'absent', state: 'incomplete' },
  });
});

test('session completion failure keeps a parseable session handoff after deadline retirement', () => {
  const script = '/fixture/staging-deploy.sh';
  const args = ['archive', 'sha'];
  const key = `${path.resolve(script)}:${JSON.stringify(args)}`;
  const deadlineRoot = path.resolve('/fixture/deadline-root');
  const sessionRoot = path.resolve('/fixture/session-root');
  const deadlineDirectory = path.join(deadlineRoot, createHash('sha256')
    .update(`staging-deadline:${key}`, 'utf8').digest('hex'));
  const sessionKey = `staging-transaction:${key}`;
  const sessionDirectory = path.join(sessionRoot, createHash('sha256')
    .update(sessionKey, 'utf8').digest('hex'));
  const sessionHandoff = Object.freeze({
    claimPath: path.join(sessionDirectory, `.recovery-baton.${'e'.repeat(64)}.claim`),
    controlDirectory: sessionDirectory,
    controlKey: sessionKey,
    controlRoot: sessionRoot,
    protocol: 'easyboost-posix-session-recovery-handoff-v1',
    recoveryScope: deadlineDirectory,
    retirementOwner: 'e'.repeat(64),
  });
  const session = { absence: 'absent', state: 'incomplete' };
  Object.defineProperty(session, 'recoveryHandoff', { value: sessionHandoff });
  Object.defineProperty(session, 'recoveryProof', { value: {} });
  Object.freeze(session);
  assert.throws(() => recoverStagingTransaction({
    args,
    completeSessionRecovery() { throw new Error('synthetic session completion interruption'); },
    deadlineControlRoot: deadlineRoot,
    platform: 'linux',
    recoverDeadline() { return { state: 'not-created' }; },
    recoverSession() { return session; },
    script,
    sessionControlRoot: sessionRoot,
  }), (error) => {
    const authority = error?.recoveryAuthority;
    return error?.exitCode === 125
      && authority?.deadlineControlDirectory === null
      && authority?.posixSessionRecoveryHandoff === sessionHandoff
      && JSON.stringify(parseStagingTransactionRecoveryAuthority(JSON.stringify(authority)))
        === JSON.stringify(authority);
  });
});

test('root transaction recovery retires a session-only control prefix and records the absent deadline',
  async () => {
    const supervisor = await import('../scripts/posix-session-supervisor.js');
    const sessionRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-transaction-session-only-'));
    const deadlineRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-transaction-no-deadline-'));
    const script = '/fixture/staging-deploy.sh';
    const args = ['archive', 'sha'];
    const key = `${path.resolve(script)}:${JSON.stringify(args)}`;
    try {
      const control = supervisor.createPosixSessionControl({
        controlKey: `staging-transaction:${key}`,
        controlRoot: sessionRoot,
      });
      const recovered = recoverStagingTransaction({
        args,
        deadlineControlRoot: deadlineRoot,
        platform: 'linux',
        script,
        sessionControlRoot: sessionRoot,
      });
      assert.deepEqual(recovered, {
        deadline: { state: 'not-created' },
        session: { absence: 'absent', state: 'incomplete' },
      });
      await assert.rejects(fs.access(control.specification.controlDirectory), { code: 'ENOENT' });
    } finally {
      await fs.rm(sessionRoot, { recursive: true, force: true });
      await fs.rm(deadlineRoot, { recursive: true, force: true });
    }
  });

test('startup aggregates unproven cleanup and attaches both exact partial authorities', () => {
  const startupFailure = new Error('synthetic deadline creation failure');
  startupFailure.recoveryAuthority = Object.freeze({ controlDirectory: '/fixture/deadline-partial' });
  const cleanupFailure = new Error('synthetic session cleanup failure');
  cleanupFailure.recoveryAuthority = syntheticPosixPublicationAuthority({
    destination: '/fixture/session-partial/retirement.claim',
    temporary: `/fixture/.session-partial.retirement.claim.${'a'.repeat(32)}.tmp`,
  });
  const session = {
    dispose() { throw cleanupFailure; },
    specification: { controlDirectory: '/fixture/session-partial' },
  };
  assert.throws(() => runStagingTransaction({
    createDeadlineMailbox() { throw startupFailure; },
    createSessionControl() { return session; },
    platform: 'linux',
    recoverySeconds: 600,
    script: '/fixture/staging-deploy.sh',
    transactionSeconds: 1_800,
  }), (error) => error?.exitCode === 125
    && error?.recoveryAuthority?.deadlineControlDirectory === '/fixture/deadline-partial'
    && error?.recoveryAuthority?.posixSessionControlDirectory === '/fixture/session-partial'
    && JSON.stringify(error?.recoveryAuthority?.posixSessionPublicationAuthority)
      === JSON.stringify(cleanupFailure.recoveryAuthority)
    && error?.cause instanceof AggregateError
    && error.cause.errors.includes(startupFailure)
    && error.cause.errors.includes(cleanupFailure));
});

test('deadline creation failure retains its exact partial authority before any session can spawn', () => {
  const deadlineFailure = new Error('synthetic deadline publication failure');
  deadlineFailure.recoveryAuthority = Object.freeze({ controlDirectory: '/fixture/deadline-only' });
  let sessionCreated = false;
  let sessionDisposed = false;
  assert.throws(() => runStagingTransaction({
    createDeadlineMailbox() { throw deadlineFailure; },
    createSessionControl() {
      sessionCreated = true;
      return {
        dispose() { sessionDisposed = true; },
        specification: { controlDirectory: '/fixture/session-before-deadline' },
      };
    },
    platform: 'linux',
    recoverySeconds: 600,
    script: '/fixture/staging-deploy.sh',
    transactionSeconds: 1_800,
  }), (error) => error?.exitCode === 125
    && error?.recoveryAuthority?.deadlineControlDirectory === '/fixture/deadline-only'
    && error?.recoveryAuthority?.posixSessionControlDirectory === null
    && error?.cause === deadlineFailure);
  assert.equal(sessionCreated, true, 'session authority is established before deadline authority');
  assert.equal(sessionDisposed, true);
});

test('transaction preserves exact deadline publication residue for typed recovery', () => {
  const publication = Object.freeze({
    controlDirectory: '/fixture/deadline-publication',
    destination: '/fixture/deadline-publication/control.json',
    temporary: '/fixture/.deadline-publication.control.json.11111111111111111111111111111111.tmp',
  });
  const deadlineFailure = new Error('synthetic deadline publication cleanup failure');
  deadlineFailure.recoveryAuthority = publication;
  assert.throws(() => runStagingTransaction({
    createDeadlineMailbox() { throw deadlineFailure; },
    createSessionControl() {
      return {
        dispose() {},
        specification: { controlDirectory: '/fixture/session-before-deadline-publication' },
      };
    },
    platform: 'linux',
    recoverySeconds: 600,
    script: '/fixture/staging-deploy.sh',
    transactionSeconds: 1_800,
  }), (error) => error?.exitCode === 125
    && error?.recoveryAuthority?.deadlineControlDirectory === publication.controlDirectory
    && JSON.stringify(error?.recoveryAuthority?.deadlinePublicationAuthority)
      === JSON.stringify({ destination: publication.destination, temporary: publication.temporary })
    && error?.recoveryAuthority?.posixSessionPublicationAuthority === undefined);
});

test('transaction creates session authority before deadline authority and retains both on D-after-S failure',
  () => {
    const calls = [];
    const deadlineFailure = new Error('synthetic deadline-after-session failure');
    deadlineFailure.recoveryAuthority = Object.freeze({ controlDirectory: '/fixture/deadline-partial' });
    const session = {
      dispose() { calls.push('dispose-session'); },
      specification: { controlDirectory: '/fixture/session-partial' },
    };
    assert.throws(() => runStagingTransaction({
      createDeadlineMailbox() {
        calls.push('create-deadline');
        throw deadlineFailure;
      },
      createSessionControl() {
        calls.push('create-session');
        return session;
      },
      platform: 'linux',
      recoverySeconds: 600,
      script: '/fixture/staging-deploy.sh',
      transactionSeconds: 1_800,
    }), (error) => error?.exitCode === 125
      && error?.recoveryAuthority?.deadlineControlDirectory === '/fixture/deadline-partial'
      && error?.recoveryAuthority?.posixSessionControlDirectory === null);
    assert.deepEqual(calls, ['create-session', 'create-deadline', 'dispose-session']);
  });

test('transaction never creates deadline authority when session authority creation fails', () => {
  const sessionFailure = new Error('synthetic session-first failure');
  sessionFailure.recoveryAuthority = Object.freeze({ controlDirectory: '/fixture/session-partial' });
  let deadlineCreated = false;
  assert.throws(() => runStagingTransaction({
    createDeadlineMailbox() { deadlineCreated = true; },
    createSessionControl() { throw sessionFailure; },
    platform: 'linux',
    recoverySeconds: 600,
    script: '/fixture/staging-deploy.sh',
    transactionSeconds: 1_800,
  }), (error) => error?.exitCode === 125
    && error?.recoveryAuthority?.deadlineControlDirectory === null
    && error?.recoveryAuthority?.posixSessionControlDirectory === '/fixture/session-partial');
  assert.equal(deadlineCreated, false);
});

test('transaction preserves exact session publication residue for typed recovery', () => {
  const publication = Object.freeze({
    controlDirectory: '/fixture/session-publication',
    destination: '/fixture/session-publication/control.json',
    sourceBinding: POSIX_PUBLICATION_SOURCE_BINDING,
    temporary: '/fixture/.session-publication.control.json.22222222222222222222222222222222.tmp',
  });
  const sessionFailure = new Error('synthetic session publication cleanup failure');
  sessionFailure.recoveryAuthority = publication;
  assert.throws(() => runStagingTransaction({
    createDeadlineMailbox() { throw new Error('must not create deadline authority'); },
    createSessionControl() { throw sessionFailure; },
    platform: 'linux',
    recoverySeconds: 600,
    script: '/fixture/staging-deploy.sh',
    transactionSeconds: 1_800,
  }), (error) => error?.exitCode === 125
    && error?.recoveryAuthority?.posixSessionControlDirectory === publication.controlDirectory
    && JSON.stringify(error?.recoveryAuthority?.posixSessionPublicationAuthority)
      === JSON.stringify({
        destination: publication.destination,
        sourceBinding: publication.sourceBinding,
        temporary: publication.temporary,
      })
    && error?.recoveryAuthority?.deadlinePublicationAuthority === undefined);
});

test('transaction CLI emits stable retained authorities before its generic synchronous startup error',
  { skip: process.platform === 'win32' }, async () => {
    const script = path.resolve('fixture-cli-startup-authority.sh');
    const args = [`cli-authority-${process.pid}-${Date.now()}`];
    const controlKey = `staging-deadline:${script}:${JSON.stringify(args)}`;
    const root = path.join(os.tmpdir(), 'easyboost-staging-deadline-controls');
    const directory = path.join(root, createHash('sha256').update(controlKey, 'utf8').digest('hex'));
    const sessionRoot = path.join(os.tmpdir(), 'easyboost-posix-session-controls');
    const sessionDirectory = path.join(sessionRoot, createHash('sha256')
      .update(`staging-transaction:${script}:${JSON.stringify(args)}`, 'utf8').digest('hex'));
    const platformPreload = path.join(os.tmpdir(), `easyboost-transaction-cli-platform-${process.pid}.cjs`);
    let retirementTombstone;
    try {
      await fs.mkdir(root, { recursive: true, mode: 0o700 });
      await fs.mkdir(directory, { mode: 0o700 });
      await fs.writeFile(platformPreload, linuxPlatformPreloadSource());
      const result = spawnSync(process.execPath, [
        '--require', platformPreload,
        path.resolve('scripts/staging-transaction-supervisor.js'),
        '--run', '1800', '600', '20', '20', '20', '--', script, ...args,
      ], { cwd: process.cwd(), encoding: 'utf8' });
      assert.equal(result.status, 125, result.stderr);
      const lines = result.stderr.trim().split(/\r?\n/u);
      assert.match(lines[0], /^STAGING_TRANSACTION_RECOVERY_REQUIRED /u);
      const reported = JSON.parse(lines[0].slice(
        'STAGING_TRANSACTION_RECOVERY_REQUIRED '.length,
      ));
      retirementTombstone = reported.posixSessionRetirementAuthority?.tombstone;
      assert.equal(reported.deadlineControlDirectory, directory);
      assert.equal(reported.posixSessionControlDirectory, sessionDirectory);
      assert.equal(reported.posixSessionRetirementAuthority.controlDirectory,
        sessionDirectory);
      assert.match(reported.posixSessionRetirementAuthority.reservationOwner,
        /^[a-f0-9]{64}$/u);
      assert.match(reported.posixSessionRetirementAuthority.sourceDev,
        /^(?:0|[1-9]\d*)$/u);
      assert.match(reported.posixSessionRetirementAuthority.sourceIno,
        /^(?:0|[1-9]\d*)$/u);
      assert.equal(reported.posixSessionRetirementAuthority.tombstone,
        retirementTombstone);
      assert.deepEqual(parseStagingTransactionRecoveryAuthority(JSON.stringify(reported)), reported);
      assert.match(lines.slice(1).join('\n'), /staging transaction supervisor could not start/iu);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
      await fs.rm(sessionDirectory, { recursive: true, force: true });
      if (retirementTombstone) {
        await fs.rm(retirementTombstone, { recursive: true, force: true });
      }
      await fs.rm(platformPreload, { force: true });
    }
  });

test('transaction CLI round-trips exact bound publication residue into typed recovery', {
  skip: process.platform === 'win32',
}, async () => {
  const script = path.resolve('fixture-cli-publication-residue.sh');
  const args = [`cli-publication-${process.pid}-${Date.now()}`];
  const key = `${script}:${JSON.stringify(args)}`;
  const sessionRoot = path.join(os.tmpdir(), 'easyboost-posix-session-controls');
  const deadlineRoot = path.join(os.tmpdir(), 'easyboost-staging-deadline-controls');
  const sessionDirectory = path.join(sessionRoot, createHash('sha256')
    .update(`staging-transaction:${key}`, 'utf8').digest('hex'));
  const deadlineDirectory = path.join(deadlineRoot, createHash('sha256')
    .update(`staging-deadline:${key}`, 'utf8').digest('hex'));
  const destination = path.join(sessionDirectory, 'control.json');
  const temporary = path.join(sessionRoot,
    `.${path.basename(sessionDirectory)}.control.json.${'3'.repeat(32)}.tmp`);
  const platformPreload = path.join(os.tmpdir(),
    `easyboost-transaction-cli-publication-${process.pid}.cjs`);
  let publicationTombstone;
  let retirementTombstone;
  try {
    await fs.mkdir(sessionRoot, { recursive: true, mode: 0o700 });
    await fs.mkdir(deadlineRoot, { recursive: true, mode: 0o700 });
    await fs.mkdir(sessionDirectory, { mode: 0o700 });
    await fs.writeFile(temporary, 'private publication residue', { flag: 'wx', mode: 0o600 });
    const authority = JSON.stringify({
      deadlineControlDirectory: null,
      posixSessionControlDirectory: sessionDirectory,
      posixSessionPublicationAuthority: {
        destination,
        sourceBinding: rootOwnedPosixPublicationSourceBinding(temporary),
        temporary,
      },
      protocol: 'easyboost-staging-transaction-recovery-v1',
    });
    await fs.writeFile(platformPreload, linuxPlatformPreloadSource());
    const result = spawnSync(process.execPath, [
      '--require', platformPreload,
      path.resolve('scripts/staging-transaction-supervisor.js'),
      '--recover-with-authority', authority, '--', script, ...args,
    ], { cwd: process.cwd(), encoding: 'utf8' });
    assert.equal(result.status, 125, result.stderr);
    const lines = result.stderr.trim().split(/\r?\n/u);
    assert.match(lines[0], /^STAGING_TRANSACTION_RECOVERY_REQUIRED /u);
    const reported = JSON.parse(lines[0].slice(
      'STAGING_TRANSACTION_RECOVERY_REQUIRED '.length,
    ));
    retirementTombstone = reported.posixSessionRetirementAuthority?.tombstone;
    assert.deepEqual(reported, {
      deadlineControlDirectory: null,
      posixSessionControlDirectory: sessionDirectory,
      posixSessionRetirementAuthority: reported.posixSessionRetirementAuthority,
      protocol: 'easyboost-staging-transaction-recovery-v1',
    });
    assert.deepEqual(parseStagingTransactionRecoveryAuthority(JSON.stringify(reported)), reported);
    const temporaryIdentity = await fs.stat(temporary);
    assert.equal(temporaryIdentity.nlink, 2,
      'ordinary recovery must retain the authenticated source and payload links');
    for (const name of await fs.readdir(sessionRoot)) {
      if (!name.startsWith('.easyboost-staging-quarantine-slot.')) continue;
      const candidate = path.join(sessionRoot, name);
      try {
        const payloadIdentity = await fs.stat(path.join(candidate, 'payload'));
        if (String(payloadIdentity.dev) === String(temporaryIdentity.dev)
            && String(payloadIdentity.ino) === String(temporaryIdentity.ino)) {
          publicationTombstone = candidate;
          break;
        }
      } catch {}
    }
    assert.ok(publicationTombstone, 'the exact bound publication must remain replayable');
    await fs.access(sessionDirectory);
    await assert.rejects(fs.access(deadlineDirectory), { code: 'ENOENT' });
  } finally {
    await fs.rm(temporary, { force: true });
    await fs.rm(sessionDirectory, { recursive: true, force: true });
    await fs.rm(deadlineDirectory, { recursive: true, force: true });
    if (publicationTombstone) {
      await fs.rm(publicationTombstone, { recursive: true, force: true });
    }
    if (retirementTombstone) {
      await fs.rm(retirementTombstone, { recursive: true, force: true });
    }
    await fs.rm(platformPreload, { force: true });
  }
});

test('typed transaction recovery cleans exact retirement tombstones before namespace recovery', () => {
  const script = '/fixture/staging-deploy.sh';
  const args = ['archive', 'sha'];
  const key = `${path.resolve(script)}:${JSON.stringify(args)}`;
  const deadlineRoot = path.resolve('/fixture/deadline-root');
  const sessionRoot = path.resolve('/fixture/session-root');
  const deadlineControlDirectory = path.join(deadlineRoot, createHash('sha256')
    .update(`staging-deadline:${key}`, 'utf8').digest('hex'));
  const posixSessionControlDirectory = path.join(sessionRoot, createHash('sha256')
    .update(`staging-transaction:${key}`, 'utf8').digest('hex'));
  const authority = Object.freeze({
    deadlineControlDirectory,
    deadlineRetirementAuthority: Object.freeze({
      controlDirectory: deadlineControlDirectory,
      tombstone: path.join(deadlineRoot, `.${path.basename(deadlineControlDirectory)}.retire.${'c'.repeat(64)}.tombstone`),
    }),
    posixSessionControlDirectory,
    posixSessionRetirementAuthority: syntheticPosixRetirementAuthority(
      posixSessionControlDirectory, 'd',
    ),
    protocol: 'easyboost-staging-transaction-recovery-v1',
  });
  const calls = [];
  const recoveryProof = Object.freeze({ fixture: 'absence-proof' });
  const recovered = recoverStagingTransaction({
    args,
    cleanupDeadlineRetirement(value) { calls.push(['cleanup-deadline', value]); },
    cleanupSessionRetirement(value) { calls.push(['cleanup-session', value]); },
    completeSessionRecovery() { calls.push(['complete-session']); return true; },
    deadlineControlRoot: deadlineRoot,
    platform: 'linux',
    recoverDeadline() { calls.push(['recover-deadline']); return { state: 'not-created' }; },
    recoverSession() {
      calls.push(['recover-session']);
      return { absence: 'absent', recoveryProof, state: 'incomplete' };
    },
    recoveryAuthority: authority,
    script,
    sessionControlRoot: sessionRoot,
  });
  assert.deepEqual(calls, [
    ['cleanup-session', authority.posixSessionRetirementAuthority],
    ['recover-session'],
    ['cleanup-deadline', authority.deadlineRetirementAuthority],
    ['recover-deadline'], ['complete-session'],
  ]);
  assert.deepEqual(recovered, {
    deadline: { state: 'not-created' },
    session: { absence: 'absent', recoveryProof, state: 'incomplete' },
  });
});

test('typed recovery parses and cleans plural POSIX writer authorities in exact order', () => {
  const script = '/fixture/staging-deploy.sh';
  const args = ['archive', 'sha'];
  const key = `${path.resolve(script)}:${JSON.stringify(args)}`;
  const deadlineRoot = path.resolve('/fixture/deadline-root');
  const sessionRoot = path.resolve('/fixture/session-root');
  const deadlineControlDirectory = path.join(deadlineRoot, createHash('sha256')
    .update(`staging-deadline:${key}`, 'utf8').digest('hex'));
  const posixSessionControlDirectory = path.join(sessionRoot, createHash('sha256')
    .update(`staging-transaction:${key}`, 'utf8').digest('hex'));
  const posixSessionPublicationAuthorities = Object.freeze([1, 2, 3].map((index) => (
    syntheticPosixPublicationAuthority({
      destination: path.join(posixSessionControlDirectory, `record-${index}.json`),
      temporary: path.join(sessionRoot,
        `.${path.basename(posixSessionControlDirectory)}.record-${index}.json.${String(index).repeat(32)}.tmp`),
    })
  )));
  const authority = Object.freeze({
    deadlineControlDirectory,
    posixSessionControlDirectory,
    posixSessionPublicationAuthorities,
    protocol: 'easyboost-staging-transaction-recovery-v1',
  });
  assert.deepEqual(parseStagingTransactionRecoveryAuthority(JSON.stringify(authority)), authority);
  const calls = [];
  const recovered = recoverStagingTransaction({
    args,
    cleanupSessionPublication(value) { calls.push(['cleanup', value]); },
    completeSessionRecovery() { calls.push(['complete']); return true; },
    deadlineControlRoot: deadlineRoot,
    platform: 'linux',
    recoverDeadline() { calls.push(['deadline']); return { state: 'not-created' }; },
    recoverSession() {
      calls.push(['session']);
      return { absence: 'absent', recoveryProof: {}, state: 'incomplete' };
    },
    recoveryAuthority: authority,
    script,
    sessionControlRoot: sessionRoot,
  });
  assert.deepEqual(calls, [
    ...posixSessionPublicationAuthorities.map((value) => ['cleanup', value]),
    ['session'], ['deadline'], ['complete'],
  ]);
  assert.deepEqual(recovered, {
    deadline: { state: 'not-created' },
    session: { absence: 'absent', recoveryProof: {}, state: 'incomplete' },
  });
});

test('failed retirement cleanup preserves every still-live exact transaction authority', () => {
  const script = '/fixture/staging-deploy.sh';
  const args = ['archive', 'sha'];
  const key = `${path.resolve(script)}:${JSON.stringify(args)}`;
  const deadlineRoot = path.resolve('/fixture/deadline-root');
  const sessionRoot = path.resolve('/fixture/session-root');
  const deadlineControlDirectory = path.join(deadlineRoot, createHash('sha256')
    .update(`staging-deadline:${key}`, 'utf8').digest('hex'));
  const posixSessionControlDirectory = path.join(sessionRoot, createHash('sha256')
    .update(`staging-transaction:${key}`, 'utf8').digest('hex'));
  const authority = Object.freeze({
    deadlineControlDirectory,
    deadlinePublicationAuthority: Object.freeze({
      destination: path.join(deadlineControlDirectory, 'control.json'),
      temporary: path.join(deadlineRoot,
        `.${path.basename(deadlineControlDirectory)}.control.json.${'e'.repeat(32)}.tmp`),
    }),
    posixSessionControlDirectory,
    posixSessionRetirementAuthority: syntheticPosixRetirementAuthority(
      posixSessionControlDirectory, '2',
    ),
    protocol: 'easyboost-staging-transaction-recovery-v1',
  });
  assert.throws(() => recoverStagingTransaction({
    args,
    cleanupSessionRetirement() { throw new Error('synthetic tombstone cleanup failure'); },
    deadlineControlRoot: deadlineRoot,
    platform: 'linux',
    recoveryAuthority: authority,
    script,
    sessionControlRoot: sessionRoot,
  }), (error) => error?.exitCode === 125
    && JSON.stringify(error.recoveryAuthority) === JSON.stringify(authority));
});

test('a role-local retirement failure preserves the other role recovery handoff', () => {
  const script = '/fixture/staging-deploy.sh';
  const args = ['archive', 'sha'];
  const key = `${path.resolve(script)}:${JSON.stringify(args)}`;
  const deadlineRoot = path.resolve('/fixture/deadline-root');
  const sessionRoot = path.resolve('/fixture/session-root');
  const deadlineKey = `staging-deadline:${key}`;
  const sessionKey = `staging-transaction:${key}`;
  const deadlineDirectory = path.join(deadlineRoot, createHash('sha256')
    .update(deadlineKey, 'utf8').digest('hex'));
  const sessionDirectory = path.join(sessionRoot, createHash('sha256')
    .update(sessionKey, 'utf8').digest('hex'));
  const handoff = (role, suffix) => Object.freeze({
    claimPath: path.join(role === 'deadline' ? deadlineDirectory : sessionDirectory,
      `.recovery-baton.${suffix.repeat(64)}.claim`),
    controlDirectory: role === 'deadline' ? deadlineDirectory : sessionDirectory,
    controlKey: role === 'deadline' ? deadlineKey : sessionKey,
    controlRoot: role === 'deadline' ? deadlineRoot : sessionRoot,
    protocol: role === 'deadline'
      ? 'easyboost-staging-deadline-recovery-handoff-v1'
      : 'easyboost-posix-session-recovery-handoff-v1',
    recoveryScope: role === 'deadline'
      ? JSON.stringify({ fingerprint: 'f'.repeat(64), result: { state: 'incomplete' } })
      : deadlineDirectory,
    retirementOwner: suffix.repeat(64),
  });
  const deadlineHandoff = handoff('deadline', 'a');
  const sessionRetirement = syntheticPosixRetirementAuthority(sessionDirectory, 'b');
  const sessionCleanupFailure = new Error('synthetic session retirement cleanup failure');
  sessionCleanupFailure.recoveryAuthority = sessionRetirement;
  assert.throws(() => recoverStagingTransaction({
    args,
    cleanupSessionRetirement() { throw sessionCleanupFailure; },
    deadlineControlRoot: deadlineRoot,
    platform: 'linux',
    recoveryAuthority: {
      deadlineControlDirectory: deadlineDirectory,
      deadlineRecoveryHandoff: deadlineHandoff,
      posixSessionControlDirectory: sessionDirectory,
      posixSessionRetirementAuthority: sessionRetirement,
      protocol: 'easyboost-staging-transaction-recovery-v1',
    },
    script,
    sessionControlRoot: sessionRoot,
  }), (error) => error?.exitCode === 125
    && JSON.stringify(error.recoveryAuthority?.deadlineRecoveryHandoff)
      === JSON.stringify(deadlineHandoff)
    && JSON.stringify(error.recoveryAuthority?.posixSessionRetirementAuthority)
      === JSON.stringify(sessionRetirement));

  const sessionHandoff = handoff('session', 'c');
  const nextSessionHandoff = handoff('session', 'd');
  const deadlineRetirement = Object.freeze({
    controlDirectory: deadlineDirectory,
    tombstone: path.join(deadlineRoot,
      `.${path.basename(deadlineDirectory)}.retire.${'e'.repeat(64)}.tombstone`),
  });
  const deadlineCleanupFailure = new Error('synthetic deadline retirement cleanup failure');
  deadlineCleanupFailure.recoveryAuthority = deadlineRetirement;
  const recoveryProof = Object.freeze({});
  assert.throws(() => recoverStagingTransaction({
    args,
    cleanupDeadlineRetirement() { throw deadlineCleanupFailure; },
    deadlineControlRoot: deadlineRoot,
    platform: 'linux',
    recoveryAuthority: {
      deadlineControlDirectory: deadlineDirectory,
      deadlineRetirementAuthority: deadlineRetirement,
      posixSessionControlDirectory: sessionDirectory,
      posixSessionRecoveryHandoff: sessionHandoff,
      protocol: 'easyboost-staging-transaction-recovery-v1',
    },
    resumeSessionRecovery() {
      const result = { absence: 'absent', state: 'incomplete' };
      Object.defineProperty(result, 'recoveryHandoff', { value: nextSessionHandoff });
      Object.defineProperty(result, 'recoveryProof', { value: recoveryProof });
      return Object.freeze(result);
    },
    script,
    sessionControlRoot: sessionRoot,
  }), (error) => error?.exitCode === 125
    && JSON.stringify(error.recoveryAuthority?.deadlineRetirementAuthority)
      === JSON.stringify(deadlineRetirement)
    && JSON.stringify(error.recoveryAuthority?.posixSessionRecoveryHandoff)
      === JSON.stringify(nextSessionHandoff));

  const sessionPublication = syntheticPosixPublicationAuthority({
    destination: path.join(sessionDirectory, 'control.json'),
    temporary: path.join(sessionRoot,
      `.${path.basename(sessionDirectory)}.control.json.${'f'.repeat(32)}.tmp`),
  });
  const publicationFailure = new Error('synthetic resumed session publication failure');
  publicationFailure.recoveryAuthority = sessionPublication;
  assert.throws(() => recoverStagingTransaction({
    args,
    deadlineControlRoot: deadlineRoot,
    platform: 'linux',
    recoveryAuthority: {
      deadlineControlDirectory: null,
      posixSessionControlDirectory: sessionDirectory,
      posixSessionRecoveryHandoff: sessionHandoff,
      protocol: 'easyboost-staging-transaction-recovery-v1',
    },
    resumeSessionRecovery() { throw publicationFailure; },
    script,
    sessionControlRoot: sessionRoot,
  }), (error) => error?.exitCode === 125
    && error.recoveryAuthority?.posixSessionRecoveryHandoff === undefined
    && JSON.stringify(error.recoveryAuthority?.posixSessionPublicationAuthority)
      === JSON.stringify(sessionPublication)
    && JSON.stringify(parseStagingTransactionRecoveryAuthority(
      JSON.stringify(error.recoveryAuthority),
    )) === JSON.stringify(error.recoveryAuthority));

  const resumedSessionRetirement = syntheticPosixRetirementAuthority(
    sessionDirectory, '9',
  );
  const resumedRetirementFailure = new Error('synthetic resumed session retirement failure');
  resumedRetirementFailure.recoveryAuthority = resumedSessionRetirement;
  assert.throws(() => recoverStagingTransaction({
    args,
    deadlineControlRoot: deadlineRoot,
    platform: 'linux',
    recoveryAuthority: {
      deadlineControlDirectory: null,
      posixSessionControlDirectory: sessionDirectory,
      posixSessionRecoveryHandoff: sessionHandoff,
      protocol: 'easyboost-staging-transaction-recovery-v1',
    },
    resumeSessionRecovery() { throw resumedRetirementFailure; },
    script,
    sessionControlRoot: sessionRoot,
  }), (error) => error?.exitCode === 125
    && error.recoveryAuthority?.posixSessionRecoveryHandoff === undefined
    && JSON.stringify(error.recoveryAuthority?.posixSessionRetirementAuthority)
      === JSON.stringify(resumedSessionRetirement)
    && JSON.stringify(parseStagingTransactionRecoveryAuthority(
      JSON.stringify(error.recoveryAuthority),
    )) === JSON.stringify(error.recoveryAuthority));
});

test('bounded plural recovery reports remain parseable beyond the former 16 KiB ceiling', () => {
  const segment = 'n'.repeat(1_570);
  const deadlineRoot = path.resolve('/fixture', segment, 'deadline-root');
  const sessionRoot = path.resolve('/fixture', segment, 'session-root');
  const deadlineControlDirectory = path.join(deadlineRoot, 'd'.repeat(64));
  const posixSessionControlDirectory = path.join(sessionRoot, 's'.repeat(64));
  const pair = (directory, root, suffix) => Object.freeze({
    destination: path.join(directory, `record-${suffix}.json`),
    temporary: path.join(root, `.${suffix.repeat(64)}.${suffix.repeat(32)}.tmp`),
  });
  const authority = Object.freeze({
    deadlineControlDirectory,
    deadlinePublicationAuthority: pair(deadlineControlDirectory, deadlineRoot, 'd'),
    posixSessionControlDirectory,
    posixSessionPublicationAuthorities: Object.freeze(['a', 'b', 'c'].map((suffix) => (
      syntheticPosixPublicationAuthority(
        pair(posixSessionControlDirectory, sessionRoot, suffix),
      )
    ))),
    protocol: 'easyboost-staging-transaction-recovery-v1',
  });
  const serialized = JSON.stringify(authority);
  assert.ok(Buffer.byteLength(serialized, 'utf8') > 16_384);
  assert.deepEqual(parseStagingTransactionRecoveryAuthority(serialized), authority);
});

test('transaction recovery rejects a path-only POSIX publication authority', () => {
  const sessionDirectory = path.resolve('/fixture/session');
  const sessionRoot = path.dirname(sessionDirectory);
  assert.throws(() => parseStagingTransactionRecoveryAuthority(JSON.stringify({
    deadlineControlDirectory: null,
    posixSessionControlDirectory: sessionDirectory,
    posixSessionPublicationAuthority: {
      destination: path.join(sessionDirectory, 'control.json'),
      temporary: path.join(sessionRoot, `.session.control.json.${'4'.repeat(32)}.tmp`),
    },
    protocol: 'easyboost-staging-transaction-recovery-v1',
  })), /POSIX session publication authority is invalid/iu);
});

test('transaction recovery round-trips the exact POSIX publication source binding', () => {
  const sessionDirectory = path.resolve('/fixture/session');
  const sessionRoot = path.dirname(sessionDirectory);
  const authority = Object.freeze({
    deadlineControlDirectory: null,
    posixSessionControlDirectory: sessionDirectory,
    posixSessionPublicationAuthority: Object.freeze({
      destination: path.join(sessionDirectory, 'control.json'),
      sourceBinding: POSIX_PUBLICATION_SOURCE_BINDING,
      temporary: path.join(sessionRoot, `.session.control.json.${'5'.repeat(32)}.tmp`),
    }),
    protocol: 'easyboost-staging-transaction-recovery-v1',
  });

  assert.deepEqual(parseStagingTransactionRecoveryAuthority(JSON.stringify(authority)), authority);
});

test('transaction recovery never recaptures a replacement POSIX publication occupant', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-transaction-binding-'));
  const deadlineRoot = path.join(root, 'deadline');
  const sessionRoot = path.join(root, 'session');
  const script = path.resolve('/fixture/staging-deploy.sh');
  const args = ['archive', 'sha'];
  const key = `${script}:${JSON.stringify(args)}`;
  const sessionDirectory = path.join(sessionRoot, createHash('sha256')
    .update(`staging-transaction:${key}`, 'utf8').digest('hex'));
  const destination = path.join(sessionDirectory, 'control.json');
  const temporary = path.join(sessionRoot,
    `.${path.basename(sessionDirectory)}.control.json.${'6'.repeat(32)}.tmp`);
  await fs.mkdir(deadlineRoot, { mode: 0o700, recursive: true });
  await fs.mkdir(sessionDirectory, { mode: 0o700, recursive: true });
  await fs.writeFile(temporary, Buffer.alloc(32, 0x41), { flag: 'wx', mode: 0o600 });
  const sourceBinding = posixPublicationSourceBinding(temporary);
  const publication = Object.freeze({ destination, sourceBinding, temporary });
  await fs.unlink(temporary);
  await fs.writeFile(temporary, Buffer.alloc(32, 0x42), { flag: 'wx', mode: 0o600 });
  let sessionRecoveryCalls = 0;
  try {
    assert.throws(() => recoverStagingTransaction({
      args,
      deadlineControlRoot: deadlineRoot,
      platform: 'linux',
      recoverSession() {
        sessionRecoveryCalls += 1;
        throw new Error('session recovery must remain unreachable');
      },
      recoveryAuthority: {
        deadlineControlDirectory: null,
        posixSessionControlDirectory: sessionDirectory,
        posixSessionPublicationAuthority: publication,
        protocol: 'easyboost-staging-transaction-recovery-v1',
      },
      script,
      sessionControlRoot: sessionRoot,
    }), (error) => error?.exitCode === 125
      && assert.deepEqual(
        error.recoveryAuthority?.posixSessionPublicationAuthority,
        publication,
      ) === undefined);
    assert.equal(sessionRecoveryCalls, 0);
    assert.deepEqual(await fs.readFile(temporary), Buffer.alloc(32, 0x42));
    assert.equal((await fs.readdir(sessionRoot)).some((name) =>
      name.startsWith('.easyboost-staging-quarantine-slot.')), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('transaction recovery authority parser rejects extras, mismatch and unbounded payloads', () => {
  const sessionDirectory = path.resolve('/fixture/session');
  const sessionRoot = path.dirname(sessionDirectory);
  const base = {
    deadlineControlDirectory: null,
    posixSessionControlDirectory: sessionDirectory,
    protocol: 'easyboost-staging-transaction-recovery-v1',
  };
  assert.throws(() => parseStagingTransactionRecoveryAuthority(JSON.stringify({
    ...base, extra: true,
  })), /contract/iu);
  assert.throws(() => parseStagingTransactionRecoveryAuthority(JSON.stringify({
    ...base,
    posixSessionPublicationAuthority: {
      destination: path.resolve('/fixture/other/control.json'),
      sourceBinding: POSIX_PUBLICATION_SOURCE_BINDING,
      temporary: path.resolve(`/fixture/.other.control.json.${'4'.repeat(32)}.tmp`),
    },
  })), /does not match/iu);
  const duplicate = {
    destination: path.join(sessionDirectory, 'control.json'),
    sourceBinding: POSIX_PUBLICATION_SOURCE_BINDING,
    temporary: path.join(sessionRoot, `.session.control.json.${'4'.repeat(32)}.tmp`),
  };
  assert.throws(() => parseStagingTransactionRecoveryAuthority(JSON.stringify({
    ...base,
    posixSessionPublicationAuthorities: [duplicate, duplicate],
  })), /not unique/iu);
  assert.throws(() => parseStagingTransactionRecoveryAuthority(JSON.stringify({
    ...base,
    posixSessionPublicationAuthorities: [duplicate, {
      destination: path.join(sessionDirectory, 'other.json'),
      sourceBinding: POSIX_PUBLICATION_SOURCE_BINDING,
      temporary: path.join(sessionRoot, `.session.other.json.${'5'.repeat(32)}.tmp`),
    }],
    posixSessionPublicationAuthority: duplicate,
  })), /ambiguous/iu);
  assert.throws(() => parseStagingTransactionRecoveryAuthority(JSON.stringify({
    ...base,
    posixSessionRetirementAuthority: {
      ...syntheticPosixRetirementAuthority(path.resolve('/fixture/other'), '3'),
    },
  })), /does not match/iu);
  assert.throws(() => parseStagingTransactionRecoveryAuthority(JSON.stringify({
    ...base,
    posixSessionPublicationAuthority: duplicate,
    posixSessionRetirementAuthority: syntheticPosixRetirementAuthority(
      sessionDirectory, '6',
    ),
  })), /mutually exclusive/iu);
  assert.throws(() => parseStagingTransactionRecoveryAuthority(' '.repeat(65_537)),
    /payload/iu);
});
