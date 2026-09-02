import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

function inspectIsolatedProcessGroup(processGroupId, isAlive) {
  const identity = Object.freeze({
    leaderStartTime: '100',
    processGroupId,
    sessionId: processGroupId,
  });
  return (_observedProcessGroupId, expectedIdentity) => {
    if (!isAlive()) return { state: 'absent' };
    if (!expectedIdentity) return { identity, state: 'alive' };
    return { state: 'alive' };
  };
}

function errorTreeMessages(error, seen = new Set()) {
  if (!error || seen.has(error)) return [];
  seen.add(error);
  return [
    error.message,
    ...errorTreeMessages(error.cause, seen),
    ...(error instanceof AggregateError
      ? error.errors.flatMap((nested) => errorTreeMessages(nested, seen))
      : []),
  ].filter(Boolean);
}

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

function posixPublicationRecoveryAuthority(destination, temporary, { tombstone } = {}) {
  return Object.freeze({
    destination,
    sourceBinding: posixPublicationSourceBinding(temporary),
    temporary,
    ...(tombstone === undefined ? {} : { tombstone }),
  });
}

const SYNTHETIC_POSIX_PUBLICATION_SOURCE_BINDING = Object.freeze({
  birthtimeNs: '0',
  bytes: 0,
  ctimeNs: '0',
  dev: '0',
  gid: '0',
  ino: '0',
  mode: String(0o100600),
  sha256: '0'.repeat(64),
  uid: '0',
});

function windowsJobRecoveryAuthorityFixture(root, hashCharacter = 'e') {
  const controlName = `easyboost-windows-job-${hashCharacter.repeat(64)}`;
  const retirementName = `.${controlName}.retired`;
  const retirementProof = path.join(root, `${retirementName}.proof`);
  return Object.freeze({
    authorityFile: retirementProof,
    controlDirectory: path.join(root, controlName),
    proofToken: hashCharacter.repeat(64),
    protocol: 'easyboost-windows-job-recovery-v2',
    retirementDirectory: path.join(root, retirementName),
    retirementProof,
  });
}

function posixWriterEgressFixture(root = path.resolve(os.tmpdir(), 'easyboost-posix-egress-fixture')) {
  const controlDirectory = path.join(root, 'a'.repeat(64));
  const specification = Object.freeze({
    controlDirectory,
    killAckPath: path.join(controlDirectory, 'kill.ack'),
    killArmedPath: path.join(controlDirectory, 'kill-armed.proof'),
    proofPath: path.join(controlDirectory, 'session-settled.proof'),
    proofToken: 'b'.repeat(64),
    readyPath: path.join(controlDirectory, 'ready.proof'),
    startupClaimPath: path.join(controlDirectory, 'startup.claim'),
    statusPath: path.join(controlDirectory, 'target-status.proof'),
    termAckPath: path.join(controlDirectory, 'term.ack'),
  });
  const authorityFor = (destination, { tombstone = false } = {}) => {
    const temporary = path.join(root,
      `.${path.basename(controlDirectory)}.${path.basename(destination)}.${'c'.repeat(32)}.tmp`);
    return Object.freeze({
      destination,
      sourceBinding: SYNTHETIC_POSIX_PUBLICATION_SOURCE_BINDING,
      temporary,
      ...(tombstone ? {
        tombstone: path.join(root,
          `.${path.basename(temporary)}.cleanup.${'d'.repeat(64)}.tombstone`),
      } : {}),
    });
  };
  return { authorityFor, specification };
}

function exhaustPosixRecoveryBaton(supervisor, {
  controlKey,
  controlRoot,
  recoveryScope,
}) {
  let current = supervisor.recoverPosixSessionControl({
    controlKey,
    controlRoot,
    permitIncompleteRetirement: true,
    recoveryScope,
    retire: false,
  });
  for (let links = 1; links < 32; links += 1) {
    current = supervisor.resumePosixSessionRecoveryHandoff(current.recoveryHandoff);
  }
  return current;
}

function posixQuiescentMaintenanceAuthority(supervisor, root, lease = 'e'.repeat(64)) {
  const identity = fsSync.statSync(root);
  return Object.freeze({
    descriptor: supervisor.STAGING_QUIESCENT_MAINTENANCE_DESCRIPTOR,
    lease,
    ownerPid: process.pid,
    ownerStartTime: '1',
    protocol: supervisor.STAGING_QUIESCENT_MAINTENANCE_PROTOCOL,
    rootDev: String(identity.dev),
    rootIno: String(identity.ino),
  });
}

function resetPosixRecoveryBatonEpoch(request) {
  for (const name of request.names) {
    if (name !== 'retirement.claim') fsSync.unlinkSync(path.join(request.directory, name));
  }
  if (process.platform === 'win32' && process.env.NODE_TEST_CONTEXT) return;
  const descriptor = fsSync.openSync(request.directory, 'r');
  try { fsSync.fsyncSync(descriptor); } finally { fsSync.closeSync(descriptor); }
}

test('POSIX owned-session member inspection fails closed on an unreadable proc record', async () => {
  const supervisor = await import('../scripts/posix-session-supervisor.js');
  assert.equal(typeof supervisor.inspectOwnedPosixSessionMembers, 'function');
  const inspectionFailure = new Error('synthetic unreadable proc member');
  assert.throws(() => supervisor.inspectOwnedPosixSessionMembers({
    processGroupId: 4100,
    sessionId: 4100,
  }, {
    readEntries: () => [{ isDirectory: () => true, name: '4101' }],
    readStat: () => ({ error: inspectionFailure, process: null }),
    wrapperPid: 4100,
  }), (error) => error === inspectionFailure);
});

test('POSIX session absence cannot be inferred from a stale proc snapshot while the group exists',
  async () => {
    const supervisor = await import('../scripts/posix-session-supervisor.js');
    const inspected = supervisor.inspectPosixSession({
      processGroupId: 4200,
      sessionId: 4200,
      startTime: '100',
    }, {
      platform: 'linux',
      probeProcessGroup: () => ({ state: 'exists' }),
      readEntries: () => [{ isDirectory: () => true, name: '4201' }],
      // The snapshotted member forked a successor after readdir and exited
      // before its own stat was read. The successor was never in the snapshot.
      readStat: () => ({ process: null }),
    });

    assert.equal(inspected.state, 'unknown');
    assert.match(inspected.error.message, /group exists.*membership.*not proven/iu);
  });

test('POSIX session absence is proven by an atomic kernel ESRCH result', async () => {
  const supervisor = await import('../scripts/posix-session-supervisor.js');
  let procRead = false;
  const inspected = supervisor.inspectPosixSession({
    processGroupId: 4300,
    sessionId: 4300,
    startTime: '101',
  }, {
    platform: 'linux',
    probeProcessGroup: () => ({ state: 'absent' }),
    readEntries() {
      procRead = true;
      throw new Error('an exact ESRCH proof must not depend on a stale proc snapshot');
    },
  });

  assert.deepEqual(inspected, { state: 'absent' });
  assert.equal(procRead, false);
});

test('POSIX session control rejects a pre-existing unsafe control root before child creation', async (t) => {
  if (process.platform === 'win32') {
    t.skip('Windows has no portable POSIX owner/mode evidence');
    return;
  }
  const supervisor = await import('../scripts/posix-session-supervisor.js');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-unsafe-posix-root-'));
  const controlKey = 'unsafe-root-must-not-create-child';
  const directory = path.join(root, createHash('sha256').update(controlKey).digest('hex'));
  try {
    await fs.chmod(root, 0o755);
    assert.throws(() => supervisor.createPosixSessionControl({ controlKey, controlRoot: root }),
      /unsafe owner or mode/iu);
    await assert.rejects(fs.access(directory), { code: 'ENOENT' });
  } finally {
    await fs.chmod(root, 0o700);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('POSIX session control rejects a symlinked control root before child creation', async () => {
  const supervisor = await import('../scripts/posix-session-supervisor.js');
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-symlink-posix-root-'));
  const target = path.join(parent, 'target');
  const root = path.join(parent, 'root-link');
  const controlKey = 'symlink-root-must-not-create-child';
  const directory = path.join(target, createHash('sha256').update(controlKey).digest('hex'));
  await fs.mkdir(target);
  await fs.symlink(target, root, process.platform === 'win32' ? 'junction' : 'dir');
  try {
    assert.throws(() => supervisor.createPosixSessionControl({ controlKey, controlRoot: root }),
      /real directory/iu);
    await assert.rejects(fs.access(directory), { code: 'ENOENT' });
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test('POSIX supervisor fatal containment always escalates inside its owned group', async () => {
  const supervisor = await import('../scripts/posix-session-supervisor.js');
  const scheduled = [];
  const events = [];
  const primaryFailure = new Error('synthetic /proc polling failure');
  const proofFailure = new Error('synthetic kill-proof write failure');
  const containment = supervisor.createFatalPosixSessionContainment({
    armKill(reason) {
      events.push(`arm:${reason}`);
      throw proofFailure;
    },
    requestTerm(reason) { events.push(`term:${reason}`); },
    retryMilliseconds: 7,
    schedule(callback, milliseconds) {
      scheduled.push({ callback, milliseconds });
      return scheduled.length;
    },
    settlementMilliseconds: 31,
    signalOwnGroup(signal) { events.push(`signal:${signal}`); },
  });

  assert.equal(containment.activate(primaryFailure), true);
  assert.equal(containment.activate(new Error('secondary callback failure')), false,
    'one fatal transition must own exactly one escalation timer');
  assert.deepEqual(events, ['term:supervisor-failure']);
  assert.deepEqual(scheduled.map(({ milliseconds }) => milliseconds), [31]);

  scheduled.shift().callback();
  assert.deepEqual(events, [
    'term:supervisor-failure',
    'arm:supervisor-failure',
    'signal:SIGKILL',
  ], 'a failed proof write must never suppress delivery of SIGKILL to group 0');
  assert.deepEqual(scheduled.map(({ milliseconds }) => milliseconds), [7],
    'the wrapper must stay alive and retry until its own SIGKILL takes effect');
  assert.equal(containment.active, true);
  assert.ok(errorTreeMessages(containment.failure).includes(primaryFailure.message));
  assert.ok(errorTreeMessages(containment.failure).includes(proofFailure.message));
});

test('POSIX fatal containment still schedules group kill when TERM delivery throws', async () => {
  const supervisor = await import('../scripts/posix-session-supervisor.js');
  const scheduled = [];
  const signals = [];
  const containment = supervisor.createFatalPosixSessionContainment({
    armKill() {},
    requestTerm() { throw new Error('synthetic TERM failure'); },
    retryMilliseconds: 5,
    schedule(callback, milliseconds) {
      scheduled.push({ callback, milliseconds });
      return scheduled.length;
    },
    settlementMilliseconds: 19,
    signalOwnGroup(signal) { signals.push(signal); },
  });

  containment.activate(new Error('synthetic status write failure'));
  assert.deepEqual(scheduled.map(({ milliseconds }) => milliseconds), [19]);
  scheduled.shift().callback();
  assert.deepEqual(signals, ['SIGKILL']);
  assert.deepEqual(scheduled.map(({ milliseconds }) => milliseconds), [5]);
  assert.match(errorTreeMessages(containment.failure).join('\n'), /TERM failure/iu);
});

test('POSIX writer egress preserves exact two- and three-path authorities in one canonical frame',
  async () => {
    const supervisor = await import('../scripts/posix-session-supervisor.js');
    const { authorityFor, specification } = posixWriterEgressFixture();
    for (const authority of [
      authorityFor(specification.readyPath),
      authorityFor(specification.statusPath, { tombstone: true }),
    ]) {
      const frame = supervisor.encodePosixSessionWriterRecovery(authority, specification);
      assert.ok(frame.length <= 4_096);
      assert.equal(frame.at(-1), 0x0a);
      const accepted = [];
      const outcomes = [];
      const stream = new PassThrough();
      const ended = new Promise((resolve) => {
        supervisor.observePosixSessionWriterEgress(stream, specification, {
          onAuthority(value) { accepted.push(value); },
          onEnd(value) { outcomes.push(value); resolve(); },
        });
      });
      stream.write(frame.subarray(0, 7));
      stream.write(frame.subarray(7, frame.length - 1));
      stream.end(frame.subarray(frame.length - 1));
      await ended;
      assert.deepEqual(accepted, [authority]);
      assert.equal(outcomes[0].state, 'authority');
      assert.equal(outcomes[0].error, null);
      assert.deepEqual(outcomes[0].authority, authority);
    }
  });

test('POSIX writer egress rejects noncanonical, extra and over-bound frames without losing a first exact authority',
  async () => {
    const supervisor = await import('../scripts/posix-session-supervisor.js');
    const { authorityFor, specification } = posixWriterEgressFixture();
    const authority = authorityFor(specification.termAckPath, { tombstone: true });
    assert.throws(() => supervisor.encodePosixSessionWriterRecovery({
      ...authority, invented: 'not-authority',
    }, specification), /not exact/iu);

    const frame = supervisor.encodePosixSessionWriterRecovery(authority, specification);
    const accepted = [];
    const failures = [];
    const stream = new PassThrough();
    const ended = new Promise((resolve) => {
      supervisor.observePosixSessionWriterEgress(stream, specification, {
        onAuthority(value) { accepted.push(value); },
        onEnd: resolve,
        onProtocolFailure(error) { failures.push(error); },
      });
    });
    stream.end(Buffer.concat([frame, Buffer.from('second-frame-byte')]));
    await ended;
    assert.deepEqual(accepted, [authority], 'the first exact cleanup capability must remain addressable');
    assert.equal(failures.length, 1);
    assert.match(failures[0].message, /bytes after|more than one/iu);

    const parsed = JSON.parse(frame.toString('utf8'));
    const invalidFrames = [
      frame.subarray(0, -1),
      Buffer.alloc(4_097, 0x20),
      Buffer.from(`${JSON.stringify({ ...parsed, token: 'f'.repeat(64) })}\n`, 'utf8'),
      Buffer.from(`${JSON.stringify(parsed, null, 2)}\n`, 'utf8'),
    ];
    for (const invalidFrame of invalidFrames) {
      const invalidAccepted = [];
      const invalidFailures = [];
      const invalidStream = new PassThrough();
      const invalidEnded = new Promise((resolve) => {
        supervisor.observePosixSessionWriterEgress(invalidStream, specification, {
          onAuthority(value) { invalidAccepted.push(value); },
          onEnd: resolve,
          onProtocolFailure(error) { invalidFailures.push(error); },
        });
      });
      invalidStream.end(invalidFrame);
      await invalidEnded;
      assert.deepEqual(invalidAccepted, []);
      assert.equal(invalidFailures.length, 1);
    }

    const longRoot = path.resolve(os.tmpdir(), 'e'.repeat(1_700));
    const longFixture = posixWriterEgressFixture(longRoot);
    assert.throws(() => supervisor.encodePosixSessionWriterRecovery(
      longFixture.authorityFor(longFixture.specification.killArmedPath, { tombstone: true }),
      longFixture.specification,
    ), /byte bound/iu);
  });

test('POSIX record publisher latches the first startup, READY, status, ACK or fatal-proof writer failure',
  async () => {
    const supervisor = await import('../scripts/posix-session-supervisor.js');
    const { authorityFor, specification } = posixWriterEgressFixture();
    const stages = [
      [specification.startupClaimPath, 'STARTUP_CLAIM', true],
      [specification.readyPath, 'READY', false],
      [specification.statusPath, 'TARGET_STATUS', false],
      [specification.termAckPath, 'TERM_ACK', false],
      [specification.killAckPath, 'KILL_ACK', false],
      [specification.killArmedPath, 'KILL_ARMED', false],
    ];
    for (const [destination, event, guarded] of stages) {
      const authority = authorityFor(destination, { tombstone: event === 'KILL_ARMED' });
      const writerFailure = new Error(`synthetic ${event} writer failure`);
      writerFailure.recoveryAuthority = authority;
      const reports = [];
      let durableCalls = 0;
      const publisher = supervisor.createPosixSessionRecordPublisher(specification, {
        durableWrite() {
          durableCalls += 1;
          throw writerFailure;
        },
        reportRecovery(value) { reports.push(value); },
      });
      let firstFailure;
      assert.throws(() => {
        if (guarded) {
          publisher.guard(destination, () => {
            durableCalls += 1;
            throw writerFailure;
          });
        } else {
          publisher.write(destination, event);
        }
      }, (error) => {
        firstFailure = error;
        assert.deepEqual(error.recoveryAuthority, authority);
        return true;
      });
      assert.throws(() => publisher.write(
        specification.killArmedPath, 'KILL_ARMED', { reason: 'supervisor-failure' },
      ), (error) => error === firstFailure);
      assert.equal(durableCalls, 1, `${event} must prevent every later durable writer attempt`);
      assert.deepEqual(reports, [authority], `${event} must emit exactly one recovery capability`);
      assert.equal(publisher.failure, firstFailure);
    }
  });

test('an incomplete fd3 recovery write never suppresses fatal TERM and bounded group KILL', async () => {
  const supervisor = await import('../scripts/posix-session-supervisor.js');
  const { authorityFor, specification } = posixWriterEgressFixture();
  const authority = authorityFor(specification.statusPath);
  const writerFailure = new Error('synthetic status writer residue');
  writerFailure.recoveryAuthority = authority;
  let durableCalls = 0;
  let egressCalls = 0;
  const egress = supervisor.createPosixSessionWriterEgress(specification, {
    writeFrame(_descriptor, frame) {
      egressCalls += 1;
      return frame.length - 1;
    },
  });
  const publisher = supervisor.createPosixSessionRecordPublisher(specification, {
    durableWrite() {
      durableCalls += 1;
      throw writerFailure;
    },
    reportRecovery: (value) => egress.report(value),
  });
  let latched;
  assert.throws(() => publisher.write(specification.statusPath, 'TARGET_STATUS'), (error) => {
    latched = error;
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.recoveryAuthority, authority);
    return true;
  });
  const scheduled = [];
  const events = [];
  const containment = supervisor.createFatalPosixSessionContainment({
    armKill() {
      events.push('arm');
      publisher.write(specification.killArmedPath, 'KILL_ARMED', { reason: 'supervisor-failure' });
    },
    requestTerm() { events.push('term'); },
    retryMilliseconds: 3,
    schedule(callback, milliseconds) { scheduled.push({ callback, milliseconds }); },
    settlementMilliseconds: 11,
    signalOwnGroup(signal) { events.push(signal); },
  });
  containment.activate(latched);
  assert.deepEqual(events, ['term']);
  scheduled.shift().callback();
  assert.deepEqual(events, ['term', 'arm', 'SIGKILL']);
  assert.equal(durableCalls, 1);
  assert.equal(egressCalls, 1);
  assert.equal(egress.attempted, true);
});

test('real fd3 transport delivers one trusted frame and is not inherited by a target-like grandchild',
  async () => {
    const supervisor = await import('../scripts/posix-session-supervisor.js');
    const { authorityFor, specification } = posixWriterEgressFixture();
    const authority = authorityFor(specification.killAckPath, { tombstone: true });
    const moduleUrl = pathToFileURL(path.resolve('scripts/posix-session-supervisor.js')).href;
    const childSource = [
      `const supervisor = await import(${JSON.stringify(moduleUrl)});`,
      `const specification = ${JSON.stringify(specification)};`,
      `const authority = ${JSON.stringify(authority)};`,
      'supervisor.createPosixSessionWriterEgress(specification).report(authority);',
      "const { spawnSync } = await import('node:child_process');",
      "const forged = `import fs from 'node:fs'; try { fs.writeSync(3, Buffer.from('forged\\\\n')); } catch {}`;",
      "const result = spawnSync(process.execPath, ['--input-type=module', '--eval', forged], { stdio: 'inherit' });",
      "if (result.status !== 0) throw new Error('target-like grandchild failed');",
    ].join('\n');
    const child = spawn(process.execPath, ['--input-type=module', '--eval', childSource], {
      stdio: ['ignore', 'ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const accepted = [];
    const failures = [];
    const egressEnded = new Promise((resolve) => {
      supervisor.observePosixSessionWriterEgress(child.stdio[3], specification, {
        onAuthority(value) { accepted.push(value); },
        onEnd: resolve,
        onProtocolFailure(error) { failures.push(error); },
      });
    });
    const childClosed = new Promise((resolve) => child.once('close', (code, signal) => {
      resolve({ code, signal });
    }));
    const [outcome] = await Promise.all([childClosed, egressEnded]);
    assert.deepEqual(outcome, { code: 0, signal: null }, stderr);
    assert.deepEqual(accepted, [authority]);
    assert.deepEqual(failures, []);
  });

test('POSIX controller ACK failure leaves TERM unstarted so fatal containment can still signal it',
  async () => {
    const source = await fs.readFile('scripts/posix-session-supervisor.js', 'utf8');
    const start = source.indexOf('const requestTerm = (reason) => {');
    const end = source.indexOf('const requestKill = (reason) => {', start);
    const requestTerm = source.slice(start, end);
    const acknowledgement = requestTerm.indexOf("write(specification.termAckPath, 'TERM_ACK')");
    const signal = requestTerm.indexOf("signalOwnGroup('SIGTERM')");
    const started = requestTerm.indexOf('termStartedAt = Date.now()');
    assert.ok(start >= 0 && end > start && acknowledgement >= 0
      && signal > acknowledgement && started > signal,
    'TERM must become started only after controller ACK and signal delivery both succeed');
  });

test('POSIX session control requires a deterministic key and forbids live force-disposal',
  async () => {
    const supervisor = await import('../scripts/posix-session-supervisor.js');
    const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-posix-control-'));
    try {
      assert.throws(() => supervisor.createPosixSessionControl({
        controlRoot: temporaryDirectory,
      }), /controlKey/iu);
      const control = supervisor.createPosixSessionControl({
        controlKey: 'fixture-live-owned-session',
        controlRoot: temporaryDirectory,
      });
      control.markWrapperSpawned();
      assert.throws(() => control.dispose({ force: true }), /FORCE_DISPOSE_FORBIDDEN/u);
      await fs.access(control.specification.controlDirectory);
    } finally {
      await fs.rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

test('POSIX disposal claim cannot delete a successor namespace after an ABA replacement', async () => {
  const supervisor = await import('../scripts/posix-session-supervisor.js');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-posix-dispose-aba-'));
  const control = supervisor.createPosixSessionControl({
    controlKey: 'dispose-aba-successor', controlRoot: root,
  });
  const directory = control.specification.controlDirectory;
  try {
    assert.throws(() => control.dispose({
      force: true,
      beforeRetirementValidation() {
        fsSync.rmSync(directory, { force: true, recursive: true });
        fsSync.mkdirSync(directory, { mode: 0o700 });
        fsSync.writeFileSync(path.join(directory, 'successor'), 'must-survive', { flag: 'wx', mode: 0o600 });
      },
    }), /RETIREMENT_CLAIM_REQUIRED/iu);
    assert.equal(await fs.readFile(path.join(directory, 'successor'), 'utf8'), 'must-survive');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('POSIX retained retirement evidence never deletes an ABA successor during replay', async () => {
  const supervisor = await import('../scripts/posix-session-supervisor.js');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-posix-remove-aba-'));
  const controlKey = 'remove-aba-successor';
  const directory = path.join(root, createHash('sha256').update(controlKey).digest('hex'));
  const control = supervisor.createPosixSessionControl({ controlKey, controlRoot: root });
  try {
    const authority = control.dispose({ force: true });
    const tombstone = authority.tombstone;
    assert.equal(supervisor.cleanupPosixSessionRetirementTombstone(authority, {
      synchronizeDirectory() {
        fsSync.rmSync(tombstone, { force: true, recursive: true });
        fsSync.mkdirSync(tombstone, { mode: 0o700 });
        fsSync.writeFileSync(path.join(tombstone, 'successor'), 'must-survive', {
          flag: 'wx', mode: 0o600,
        });
      },
    }), true);
    assert.equal(await fs.readFile(path.join(tombstone, 'successor'), 'utf8'), 'must-survive');
    await assert.rejects(fs.access(directory), { code: 'ENOENT' });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('POSIX retirement replay preserves a same-shape replacement payload', async () => {
  const supervisor = await import('../scripts/posix-session-supervisor.js');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-posix-payload-aba-'));
  const control = supervisor.createPosixSessionControl({
    controlKey: 'retirement-payload-aba', controlRoot: root,
  });
  const displaced = path.join(root, 'displaced-exact-payload');
  try {
    const authority = control.dispose({ force: true });
    const tombstone = authority.tombstone;
    const payload = path.join(tombstone, 'payload');
    await fs.rename(payload, displaced);
    await fs.cp(displaced, payload, { recursive: true });
    let reclaimCalls = 0;

    assert.throws(() => supervisor.cleanupPosixSessionRetirementTombstone(authority, {
      quiescentMaintenanceAuthority: posixQuiescentMaintenanceAuthority(supervisor, root),
      reclaimRetainedEvidence(request) {
        reclaimCalls += 1;
        fsSync.rmSync(request.container, { recursive: true });
        return true;
      },
    }), /identity|reservation|changed/iu);
    assert.equal(reclaimCalls, 0, 'an identity mismatch must fail before maintenance deletion');
    await fs.access(payload);
    await fs.access(displaced);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('POSIX retirement replay rejects a later valid reuse of the same fixed slot', async () => {
  const supervisor = await import('../scripts/posix-session-supervisor.js');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-posix-retirement-slot-reuse-'));
  try {
    const first = supervisor.createPosixSessionControl({
      controlKey: 'retirement-slot-first', controlRoot: root,
    });
    const oldAuthority = first.dispose({ force: true });
    fsSync.rmSync(oldAuthority.tombstone, { recursive: true });

    const second = supervisor.createPosixSessionControl({
      controlKey: 'retirement-slot-second', controlRoot: root,
    });
    const newAuthority = second.dispose({ force: true });
    if (newAuthority.tombstone !== oldAuthority.tombstone) {
      fsSync.renameSync(newAuthority.tombstone, oldAuthority.tombstone);
      const reservationPath = path.join(oldAuthority.tombstone, 'reservation.claim');
      const reservation = JSON.parse(fsSync.readFileSync(reservationPath, 'utf8'));
      reservation.tombstone = path.basename(oldAuthority.tombstone);
      fsSync.writeFileSync(reservationPath, `${JSON.stringify(reservation)}\n`, { flag: 'w' });
    }
    const laterPayload = path.join(oldAuthority.tombstone, 'payload');
    let reclaimCalls = 0;

    assert.throws(() => supervisor.cleanupPosixSessionRetirementTombstone(oldAuthority, {
      quiescentMaintenanceAuthority: posixQuiescentMaintenanceAuthority(supervisor, root),
      reclaimRetainedEvidence() {
        reclaimCalls += 1;
        return true;
      },
    }), /reservation authority changed/iu);
    assert.equal(reclaimCalls, 0,
      'old replay authority must fail before deleting a later valid slot generation');
    await fs.access(laterPayload);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('POSIX helper failure retirement retries the exact reserved slot without slot loss',
  async () => {
    const supervisor = await import('../scripts/posix-session-supervisor.js');
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-posix-reservation-retry-'));
    const control = supervisor.createPosixSessionControl({
      controlKey: 'reservation-only-retirement-retry',
      controlRoot: root,
      noReplacePlatform: 'linux',
      runNoReplaceMove() { return { status: 73 }; },
    });
    let authority;
    try {
      assert.throws(() => control.dispose({ force: true }), (error) => {
        authority = error?.recoveryAuthority;
        return authority?.controlDirectory === control.specification.controlDirectory
          && typeof authority?.reservationOwner === 'string'
          && typeof authority?.sourceDev === 'string'
          && typeof authority?.sourceIno === 'string'
          && typeof authority?.tombstone === 'string';
      });
      assert.deepEqual(await fs.readdir(authority.tombstone), ['reservation.claim']);
      await fs.access(authority.controlDirectory);

      const kinds = [];
      assert.equal(supervisor.cleanupPosixSessionRetirementTombstone(authority, {
        noReplacePlatform: 'linux',
        quiescentMaintenanceAuthority: posixQuiescentMaintenanceAuthority(supervisor, root),
        reclaimRetainedEvidence(request) {
          kinds.push(request.kind);
          assert.equal(request.kind, 'RETIREMENT');
          assert.equal(request.container, authority.tombstone);
          fsSync.rmSync(request.container, { recursive: true });
          return true;
        },
        runNoReplaceMove(_command, args) {
          assert.equal(args.at(-2), authority.controlDirectory);
          assert.equal(args.at(-1), path.join(authority.tombstone, 'payload'));
          fsSync.renameSync(args.at(-2), args.at(-1));
          return { status: 0 };
        },
      }), true);
      assert.deepEqual(kinds, ['RETIREMENT']);
      assert.deepEqual(await fs.readdir(root), []);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

test('POSIX reservation-only retirement failure remains replayable in the same slot', async () => {
  const supervisor = await import('../scripts/posix-session-supervisor.js');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-posix-same-slot-retry-'));
  const control = supervisor.createPosixSessionControl({
    controlKey: 'reservation-only-same-slot-retry',
    controlRoot: root,
    noReplacePlatform: 'linux',
    runNoReplaceMove() { return { status: 73 }; },
  });
  let authority;
  try {
    assert.throws(() => control.dispose({ force: true }), (error) => {
      authority = error?.recoveryAuthority;
      return typeof authority?.tombstone === 'string';
    });
    const reclaims = [];
    assert.throws(() => supervisor.cleanupPosixSessionRetirementTombstone(authority, {
      noReplacePlatform: 'linux',
      quiescentMaintenanceAuthority: posixQuiescentMaintenanceAuthority(supervisor, root),
      reclaimRetainedEvidence(request) {
        reclaims.push(request.kind);
        return true;
      },
      runNoReplaceMove(_command, args) {
        assert.equal(args.at(-2), authority.controlDirectory);
        assert.equal(args.at(-1), path.join(authority.tombstone, 'payload'));
        return { status: 73 };
      },
    }), (error) => error?.recoveryAuthority?.tombstone === authority.tombstone);
    assert.deepEqual(reclaims, [], 'reservation must remain until its payload move succeeds');
    assert.deepEqual(await fs.readdir(authority.tombstone), ['reservation.claim']);
    await fs.access(authority.controlDirectory);

    assert.equal(supervisor.cleanupPosixSessionRetirementTombstone(authority, {
      noReplacePlatform: 'linux',
      quiescentMaintenanceAuthority: posixQuiescentMaintenanceAuthority(supervisor, root),
      reclaimRetainedEvidence(request) {
        reclaims.push(request.kind);
        fsSync.rmSync(request.container, { recursive: true });
        return true;
      },
      runNoReplaceMove(_command, args) {
        assert.equal(args.at(-1), path.join(authority.tombstone, 'payload'));
        fsSync.renameSync(args.at(-2), args.at(-1));
        return { status: 0 };
      },
    }), true);
    assert.deepEqual(reclaims, ['RETIREMENT']);
    assert.deepEqual(await fs.readdir(root), []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('POSIX retirement replay never treats a missing reservation slot as completed', async () => {
  const supervisor = await import('../scripts/posix-session-supervisor.js');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-posix-missing-slot-'));
  const control = supervisor.createPosixSessionControl({
    controlKey: 'reservation-only-missing-slot',
    controlRoot: root,
    noReplacePlatform: 'linux',
    runNoReplaceMove() { return { status: 73 }; },
  });
  let authority;
  try {
    assert.throws(() => control.dispose({ force: true }), (error) => {
      authority = error?.recoveryAuthority;
      return typeof authority?.tombstone === 'string';
    });
    fsSync.rmSync(authority.tombstone, { recursive: true });
    assert.throws(() => supervisor.cleanupPosixSessionRetirementTombstone(authority, {
      quiescentMaintenanceAuthority: posixQuiescentMaintenanceAuthority(supervisor, root),
      reclaimRetainedEvidence(request) {
        if (request.kind === 'QUIESCENT_ABSENCE_PROOF') return true;
        throw new Error('missing slot must not enter destructive maintenance');
      },
    }), /missing|retirement|evidence|source/iu);
    await fs.access(authority.controlDirectory);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('POSIX quiescent startup sweep adopts complete and reservation-only retirement slots',
  async () => {
    const supervisor = await import('../scripts/posix-session-supervisor.js');
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-posix-startup-sweep-'));
    try {
      const complete = supervisor.createPosixSessionControl({
        controlKey: 'startup-sweep-complete', controlRoot: root,
      });
      complete.dispose({ force: true });
      const reserved = supervisor.createPosixSessionControl({
        controlKey: 'startup-sweep-reserved',
        controlRoot: root,
        noReplacePlatform: 'linux',
        runNoReplaceMove() { return { status: 73 }; },
      });
      assert.throws(() => reserved.dispose({ force: true }), /RETIREMENT_CLAIM_REQUIRED/iu);

      const kinds = [];
      assert.equal(supervisor.sweepPosixSessionRetainedEvidence({
        controlRoot: root,
        noReplacePlatform: 'linux',
        quiescentMaintenanceAuthority: posixQuiescentMaintenanceAuthority(supervisor, root),
        reclaimRetainedEvidence(request) {
          if (request.kind === 'QUIESCENT_ABSENCE_PROOF') return true;
          kinds.push(request.kind);
          fsSync.rmSync(request.container, { recursive: true });
          return true;
        },
        runNoReplaceMove(_command, args) {
          fsSync.renameSync(args.at(-2), args.at(-1));
          return { status: 0 };
        },
      }), true);
      assert.deepEqual(kinds, ['RETIREMENT', 'RETIREMENT']);
      assert.deepEqual(await fs.readdir(root), []);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

test('POSIX recovery handoff gives one recoverer ownership and cannot delete a later successor',
  async () => {
    const supervisor = await import('../scripts/posix-session-supervisor.js');
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-posix-recovery-aba-'));
    const controlKey = 'recovery-aba-successor';
    const directory = path.join(root, createHash('sha256').update(controlKey).digest('hex'));
    await fs.mkdir(directory, { mode: 0o700 });
    try {
      const winner = supervisor.recoverPosixSessionControl({
        controlKey, controlRoot: root, permitIncompleteRetirement: true, retire: false,
      });
      assert.throws(() => supervisor.recoverPosixSessionControl({
        controlKey, controlRoot: root, permitIncompleteRetirement: true, retire: false,
      }), /missing|unknown record|RETIREMENT_CLAIM_REQUIRED/iu);
      assert.equal(supervisor.completePosixSessionRecovery(winner.recoveryProof, {
        controlKey, controlRoot: root,
      }), true);
      await fs.mkdir(directory, { mode: 0o700 });
      await fs.writeFile(path.join(directory, 'successor'), 'must-survive', { flag: 'wx', mode: 0o600 });
      assert.throws(() => supervisor.completePosixSessionRecovery(winner.recoveryProof, {
        controlKey, controlRoot: root,
      }), /handoff is invalid/iu);
      assert.equal(await fs.readFile(path.join(directory, 'successor'), 'utf8'), 'must-survive');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

test('POSIX completion rejects an exact sibling publication residue before retirement', async () => {
  const supervisor = await import('../scripts/posix-session-supervisor.js');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-posix-complete-residue-'));
  const controlKey = 'complete-must-reject-sibling-residue';
  const directory = path.join(root, createHash('sha256').update(controlKey).digest('hex'));
  await fs.mkdir(directory, { mode: 0o700 });
  const temporary = path.join(root,
    `.${path.basename(directory)}.ready.proof.${'a'.repeat(32)}.tmp`);
  try {
    const recovery = supervisor.recoverPosixSessionControl({
      controlKey, controlRoot: root, permitIncompleteRetirement: true, retire: false,
    });
    await fs.writeFile(temporary, 'retained exact writer residue', { flag: 'wx', mode: 0o600 });
    assert.throws(() => supervisor.completePosixSessionRecovery(recovery.recoveryProof, {
      controlKey, controlRoot: root,
    }), /RETIREMENT_CLAIM_REQUIRED/iu);
    await fs.access(directory);
    await fs.access(temporary);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('POSIX completion exposes retained retryable evidence when root fsync fails', async () => {
  const supervisor = await import('../scripts/posix-session-supervisor.js');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-posix-complete-fsync-'));
  const controlKey = 'complete-root-fsync-retry';
  const directory = path.join(root, createHash('sha256').update(controlKey).digest('hex'));
  await fs.mkdir(directory, { mode: 0o700 });
  try {
    const recovery = supervisor.recoverPosixSessionControl({
      controlKey, controlRoot: root, permitIncompleteRetirement: true, retire: false,
    });
    let failure;
    assert.throws(() => supervisor.completePosixSessionRecovery(recovery.recoveryProof, {
      controlKey,
      controlRoot: root,
      syncControlRoot() { throw new Error('synthetic post-removal root fsync failure'); },
    }), (error) => {
      failure = error;
      return typeof error?.recoveryAuthority?.tombstone === 'string';
    });
    assert.equal(failure.recoveryAuthority.controlDirectory, directory);
    await assert.rejects(fs.access(directory), { code: 'ENOENT' });
    await fs.access(failure.recoveryAuthority.tombstone);
    assert.equal(supervisor.cleanupPosixSessionRetirementTombstone(
      failure.recoveryAuthority,
    ), true);
    await fs.access(failure.recoveryAuthority.tombstone);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('POSIX restart handoff admits exactly one adopter', async () => {
  const supervisor = await import('../scripts/posix-session-supervisor.js');
  const competitor = await import(`../scripts/posix-session-supervisor.js?baton-race=${Date.now()}`);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-posix-restart-baton-'));
  const controlKey = 'restart-baton-single-winner';
  const directory = path.join(root, createHash('sha256').update(controlKey).digest('hex'));
  await fs.mkdir(directory, { mode: 0o700 });
  try {
    const first = supervisor.recoverPosixSessionControl({
      controlKey, controlRoot: root, permitIncompleteRetirement: true,
      recoveryScope: 'deadline-scope', retire: false,
    });
    let winner;
    assert.throws(() => supervisor.resumePosixSessionRecoveryHandoff(first.recoveryHandoff, {
      linkBaton(oldPath, nextPath) {
        winner = competitor.resumePosixSessionRecoveryHandoff(first.recoveryHandoff);
        fsSync.linkSync(oldPath, nextPath);
      },
    }), (error) => /already adopted/iu.test(error.message)
      && error.recoveryHandoff?.claimPath === winner.recoveryHandoff.claimPath);
    assert.deepEqual(winner, { absence: 'absent', state: 'incomplete' });
    assert.equal(competitor.completePosixSessionRecovery(winner.recoveryProof, {
      controlKey, controlRoot: root, recoveryScope: 'deadline-scope',
    }), true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('POSIX post-DISPOSE-claim failure exposes a restart-adoptable durable baton', async () => {
  const supervisor = await import('../scripts/posix-session-supervisor.js');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-posix-dispose-baton-'));
  const controlKey = 'dispose-claim-restart-baton';
  const recoveryScope = path.join(root, 'paired-deadline-control');
  const control = supervisor.createPosixSessionControl({ controlKey, controlRoot: root });
  try {
    let failure;
    assert.throws(() => control.dispose({
      force: true,
      recoveryScope,
      beforeRetirementValidation() { throw new Error('synthetic crash after DISPOSE claim'); },
    }), (error) => {
      failure = error;
      return /synthetic crash after DISPOSE claim/iu.test(error.message)
        && typeof error.recoveryAuthority?.recoveryHandoff?.claimPath === 'string';
    });
    const fresh = await import(`../scripts/posix-session-supervisor.js?dispose-resume=${Date.now()}`);
    let discovered;
    assert.throws(() => fresh.recoverPosixSessionControl({
      controlKey,
      controlRoot: root,
      permitIncompleteRetirement: true,
      recoveryScope,
      retire: false,
    }), (error) => {
      discovered = error.recoveryAuthority?.recoveryHandoff;
      return error.code === 'POSIX_SESSION_RETIREMENT_CLAIM_REQUIRED'
        && discovered?.recoveryScope === recoveryScope;
    });
    const serialized = JSON.parse(JSON.stringify(discovered));
    const resumed = fresh.resumePosixSessionRecoveryHandoff(serialized);
    assert.deepEqual(resumed, { absence: 'absent', state: 'incomplete' });
    assert.equal(fresh.completePosixSessionRecovery(resumed.recoveryProof, {
      controlKey, controlRoot: root, recoveryScope,
    }), true);
    await assert.rejects(fs.access(control.specification.controlDirectory), { code: 'ENOENT' });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('POSIX restart handoff rejects a multiply-linked claim before adoption', async () => {
  const supervisor = await import('../scripts/posix-session-supervisor.js');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-posix-baton-link-'));
  const controlKey = 'restart-baton-private-claim';
  const directory = path.join(root, createHash('sha256').update(controlKey).digest('hex'));
  const alias = path.join(directory, 'retirement-claim-alias');
  await fs.mkdir(directory, { mode: 0o700 });
  try {
    const first = supervisor.recoverPosixSessionControl({
      controlKey, controlRoot: root, permitIncompleteRetirement: true,
      recoveryScope: 'deadline-scope', retire: false,
    });
    await fs.link(first.recoveryHandoff.claimPath, alias);
    assert.throws(() => supervisor.resumePosixSessionRecoveryHandoff(first.recoveryHandoff),
      /link count|forked|invalid/iu);
    await fs.unlink(alias);
    const resumed = supervisor.resumePosixSessionRecoveryHandoff(first.recoveryHandoff);
    assert.equal(supervisor.completePosixSessionRecovery(resumed.recoveryProof, {
      controlKey, controlRoot: root, recoveryScope: 'deadline-scope',
    }), true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('POSIX post-adoption failure exposes an exact rotated handoff for retry', async () => {
  const supervisor = await import('../scripts/posix-session-supervisor.js');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-posix-baton-rotation-'));
  const controlKey = 'restart-baton-post-adoption-retry';
  const directory = path.join(root, createHash('sha256').update(controlKey).digest('hex'));
  const obstruction = path.join(directory, 'late-record');
  await fs.mkdir(directory, { mode: 0o700 });
  try {
    const first = supervisor.recoverPosixSessionControl({
      controlKey, controlRoot: root, permitIncompleteRetirement: true,
      recoveryScope: 'deadline-scope', retire: false,
    });
    await fs.writeFile(obstruction, 'must block the first adoption', { flag: 'wx', mode: 0o600 });
    let failure;
    assert.throws(() => supervisor.resumePosixSessionRecoveryHandoff(first.recoveryHandoff),
      (error) => {
        failure = error;
        return /namespace changed during baton adoption/iu.test(error.message);
      });
    const rotated = failure.recoveryAuthority?.recoveryHandoff;
    assert.deepEqual(Object.keys(rotated ?? {}).sort(), [
      'claimPath', 'controlDirectory', 'controlKey', 'controlRoot',
      'protocol', 'recoveryScope', 'retirementOwner',
    ]);
    assert.equal(failure.recoveryAuthority.controlDirectory, directory);
    assert.notEqual(rotated.claimPath, first.recoveryHandoff.claimPath);
    assert.match(path.basename(rotated.claimPath),
      /^\.recovery-baton\.[a-f0-9]{64}\.claim$/u);
    await fs.unlink(obstruction);
    const resumed = supervisor.resumePosixSessionRecoveryHandoff(rotated);
    assert.deepEqual(resumed, { absence: 'absent', state: 'incomplete' });
    assert.equal(supervisor.completePosixSessionRecovery(resumed.recoveryProof, {
      controlKey, controlRoot: root, recoveryScope: 'deadline-scope',
    }), true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('serialized POSIX restart handoffs restore every canonical recovery result in a fresh module',
  async () => {
    const supervisor = await import('../scripts/posix-session-supervisor.js');
    const cases = [
      { expected: { absence: 'absent', state: 'not-created' }, shape: 'missing' },
      { expected: { absence: 'absent', state: 'incomplete' }, shape: 'empty' },
      { expected: { absence: 'absent', state: 'incomplete' }, shape: 'control-only' },
      { expected: { absence: 'absent', state: 'incomplete' }, shape: 'launch-incomplete' },
      {
        expected: { processGroupId: 6300, sessionId: 6300, state: 'absent' },
        shape: 'full-absent',
      },
      {
        expected: {
          absence: 'absent', processGroupId: 6310, sessionId: 6310, state: 'incomplete',
        },
        shape: 'full-incomplete',
      },
    ];
    for (const [index, fixture] of cases.entries()) {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), `easyboost-posix-all-shapes-${index}-`));
      const controlKey = `restart-all-shapes-${fixture.shape}`;
      const directory = path.join(root, createHash('sha256').update(controlKey).digest('hex'));
      try {
        let control;
        if (fixture.shape === 'empty') {
          await fs.mkdir(directory, { mode: 0o700 });
        } else if (fixture.shape !== 'missing') {
          control = supervisor.createPosixSessionControl({ controlKey, controlRoot: root });
        }
        if (fixture.shape === 'launch-incomplete') {
          supervisor.claimPosixSessionStartup(control.specification, {
            kind: 'LAUNCH',
            identity: {
              processGroupId: 6290, processId: 6290, sessionId: 6290, startTime: '129',
            },
          });
        }
        if (fixture.shape === 'full-absent' || fixture.shape === 'full-incomplete') {
          const processId = fixture.shape === 'full-absent' ? 6300 : 6310;
          const startTime = fixture.shape === 'full-absent' ? '130' : '131';
          const { specification } = control;
          supervisor.claimPosixSessionStartup(specification, {
            kind: 'LAUNCH',
            identity: {
              processGroupId: processId, processId, sessionId: processId, startTime,
            },
          });
          await fs.writeFile(specification.readyPath, `${JSON.stringify({
            event: 'READY', processGroupId: processId,
            protocol: 'easyboost-posix-session-settled-v1', sessionId: processId,
            startTime, targetPid: null, token: specification.proofToken, wrapperPid: processId,
          })}\n`, { flag: 'wx' });
          if (fixture.shape === 'full-absent') {
            await fs.writeFile(specification.statusPath, `${JSON.stringify({
              errorCode: null, event: 'TARGET_STATUS', exitCode: 0,
              protocol: 'easyboost-posix-session-settled-v1', signal: null,
              token: specification.proofToken,
            })}\n`, { flag: 'wx' });
            await fs.writeFile(specification.proofPath, `${JSON.stringify({
              activeProcesses: 0, event: 'SESSION_DRAINED',
              protocol: 'easyboost-posix-session-settled-v1', token: specification.proofToken,
            })}\n`, { flag: 'wx' });
          } else {
            await fs.writeFile(specification.termRequestPath, `${JSON.stringify({
              protocol: 'easyboost-posix-session-control-v2', signal: 'SIGTERM',
              token: specification.controlToken,
            })}\n`, { flag: 'wx' });
          }
        }
        const recoveryScope = `deadline-scope-${fixture.shape}`;
        const recovered = supervisor.recoverPosixSessionControl({
          controlKey,
          controlRoot: root,
          inspectSession: () => ({ state: 'absent' }),
          permitIncompleteRetirement: fixture.shape !== 'full-absent',
          recoveryScope,
          retire: false,
        });
        assert.deepEqual(recovered, fixture.expected);
        const claim = JSON.parse(await fs.readFile(
          recovered.recoveryHandoff.claimPath, 'utf8',
        ));
        assert.equal(claim.purpose, 'RECOVERY');
        assert.match(claim.recoveryState.fingerprint, /^[a-f0-9]{64}$/u);
        assert.deepEqual(claim.recoveryState.result, fixture.expected);
        const serialized = JSON.parse(JSON.stringify(recovered.recoveryHandoff));
        const fresh = await import(
          `../scripts/posix-session-supervisor.js?all-shapes=${Date.now()}-${index}`
        );
        const resumed = fresh.resumePosixSessionRecoveryHandoff(serialized);
        assert.deepEqual(resumed, fixture.expected);
        assert.equal(fresh.completePosixSessionRecovery(resumed.recoveryProof, {
          controlKey, controlRoot: root, recoveryScope,
        }), true);
        await assert.rejects(fs.access(directory), { code: 'ENOENT' });
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    }
  });

test('POSIX crash after deterministic baton link keeps stale JSON restart-discoverable', async () => {
  const supervisor = await import('../scripts/posix-session-supervisor.js');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-posix-baton-crash-'));
  const controlKey = 'restart-baton-after-link-crash';
  const recoveryScope = 'paired-deadline-after-link-crash';
  const directory = path.join(root, createHash('sha256').update(controlKey).digest('hex'));
  await fs.mkdir(directory, { mode: 0o700 });
  try {
    const first = supervisor.recoverPosixSessionControl({
      controlKey, controlRoot: root, permitIncompleteRetirement: true,
      recoveryScope, retire: false,
    });
    const stale = JSON.parse(JSON.stringify(first.recoveryHandoff));
    let durableNext;
    assert.throws(() => supervisor.resumePosixSessionRecoveryHandoff(stale, {
      afterBatonMutation(next) {
        durableNext = JSON.parse(JSON.stringify(next));
        throw new Error('synthetic power loss after baton link');
      },
    }), (error) => /synthetic power loss/iu.test(error.message)
      && error.recoveryHandoff?.claimPath === durableNext.claimPath);
    const [originIdentity, nextIdentity] = await Promise.all([
      fs.stat(stale.claimPath), fs.stat(durableNext.claimPath),
    ]);
    assert.equal(String(originIdentity.ino), String(nextIdentity.ino));
    assert.equal(Number(nextIdentity.nlink), 2);
    let current;
    assert.throws(() => supervisor.resumePosixSessionRecoveryHandoff(stale), (error) => {
      current = error.recoveryAuthority?.recoveryHandoff;
      return /already adopted/iu.test(error.message)
        && current?.claimPath === durableNext.claimPath;
    });
    let discovered;
    assert.throws(() => supervisor.recoverPosixSessionControl({
      controlKey, controlRoot: root, permitIncompleteRetirement: true,
      recoveryScope, retire: false,
    }), (error) => {
      discovered = error.recoveryAuthority?.recoveryHandoff;
      return error.code === 'POSIX_SESSION_RETIREMENT_CLAIM_REQUIRED'
        && discovered?.claimPath === durableNext.claimPath;
    });
    const fresh = await import(`../scripts/posix-session-supervisor.js?after-link=${Date.now()}`);
    const resumed = fresh.resumePosixSessionRecoveryHandoff(
      JSON.parse(JSON.stringify(discovered)),
    );
    assert.deepEqual(resumed, { absence: 'absent', state: 'incomplete' });
    assert.equal(fresh.completePosixSessionRecovery(resumed.recoveryProof, {
      controlKey, controlRoot: root, recoveryScope,
    }), true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('POSIX exhausted recovery baton retains an exact replayable handoff without maintenance',
  async () => {
    const supervisor = await import('../scripts/posix-session-supervisor.js');
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-posix-baton-limit-'));
    const controlKey = 'restart-baton-limit-without-maintenance';
    const recoveryScope = 'paired-deadline-baton-limit';
    const directory = path.join(root, createHash('sha256').update(controlKey).digest('hex'));
    await fs.mkdir(directory, { mode: 0o700 });
    try {
      const exhausted = exhaustPosixRecoveryBaton(supervisor, {
        controlKey, controlRoot: root, recoveryScope,
      });
      const serialized = JSON.parse(JSON.stringify(exhausted.recoveryHandoff));
      const before = (await fs.readdir(directory)).sort();
      assert.equal(before.filter((name) => name === 'retirement.claim'
        || /^\.recovery-baton\.[a-f0-9]{64}\.claim$/u.test(name)).length, 32);
      let rotationCalled = false;
      assert.throws(() => supervisor.resumePosixSessionRecoveryHandoff(serialized, {
        rotateRecoveryBatonEpoch() { rotationCalled = true; return true; },
      }), (error) => error.code === 'POSIX_SESSION_RECOVERY_EPOCH_MAINTENANCE_REQUIRED'
        && error.recoveryHandoff?.claimPath === serialized.claimPath
        && error.recoveryAuthority?.recoveryHandoff?.claimPath === serialized.claimPath);
      assert.equal(rotationCalled, false);
      assert.deepEqual((await fs.readdir(directory)).sort(), before);
      let discovered;
      assert.throws(() => supervisor.recoverPosixSessionControl({
        controlKey,
        controlRoot: root,
        permitIncompleteRetirement: true,
        recoveryScope,
        retire: false,
      }), (error) => {
        discovered = error.recoveryAuthority?.recoveryHandoff;
        return error.code === 'POSIX_SESSION_RETIREMENT_CLAIM_REQUIRED'
          && discovered?.claimPath === serialized.claimPath;
      });
      assert.deepEqual(JSON.parse(JSON.stringify(discovered)), serialized);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

test('POSIX approved quiescent epoch rotation resets the hard-link bound and continues',
  async () => {
    const supervisor = await import('../scripts/posix-session-supervisor.js');
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-posix-baton-epoch-'));
    const controlKey = 'restart-baton-approved-epoch';
    const recoveryScope = 'paired-deadline-approved-epoch';
    const directory = path.join(root, createHash('sha256').update(controlKey).digest('hex'));
    await fs.mkdir(directory, { mode: 0o700 });
    try {
      const exhausted = exhaustPosixRecoveryBaton(supervisor, {
        controlKey, controlRoot: root, recoveryScope,
      });
      const authority = posixQuiescentMaintenanceAuthority(supervisor, root);
      let rotation;
      const resumed = supervisor.resumePosixSessionRecoveryHandoff(
        exhausted.recoveryHandoff,
        {
          quiescentMaintenanceAuthority: authority,
          reclaimRetainedEvidence() {
            throw new Error('retained evidence cleanup is not part of baton rotation');
          },
          rotateRecoveryBatonEpoch(request) {
            rotation = request;
            assert.deepEqual(request.authority, authority);
            assert.notEqual(request.authority, authority);
            assert.equal(request.directory, directory);
            assert.equal(request.root, root);
            assert.equal(request.kind, 'RECOVERY_BATON_EPOCH');
            assert.equal(request.source, exhausted.recoveryHandoff.claimPath);
            assert.equal(request.names.length, 32);
            assert.equal(Object.isFrozen(request), true);
            assert.equal(Object.isFrozen(request.names), true);
            const sourceIdentity = fsSync.lstatSync(request.source);
            assert.deepEqual(request.expectedIdentity, {
              dev: String(sourceIdentity.dev), ino: String(sourceIdentity.ino),
            });
            resetPosixRecoveryBatonEpoch(request);
            return true;
          },
        },
      );
      assert.ok(rotation);
      assert.deepEqual(resumed, { absence: 'absent', state: 'incomplete' });
      assert.notEqual(resumed.recoveryHandoff.claimPath, exhausted.recoveryHandoff.claimPath);
      const names = (await fs.readdir(directory)).filter((name) => name === 'retirement.claim'
        || /^\.recovery-baton\.[a-f0-9]{64}\.claim$/u.test(name));
      assert.equal(names.length, 2);
      assert.equal(supervisor.completePosixSessionRecovery(resumed.recoveryProof, {
        controlKey, controlRoot: root, recoveryScope,
      }), true);
      await assert.rejects(fs.access(directory), { code: 'ENOENT' });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

test('POSIX false and post-reset epoch failures both retain a restart-safe baton', async () => {
  const supervisor = await import('../scripts/posix-session-supervisor.js');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-posix-baton-epoch-failure-'));
  const controlKey = 'restart-baton-epoch-failure';
  const recoveryScope = 'paired-deadline-epoch-failure';
  const directory = path.join(root, createHash('sha256').update(controlKey).digest('hex'));
  await fs.mkdir(directory, { mode: 0o700 });
  try {
    const exhausted = exhaustPosixRecoveryBaton(supervisor, {
      controlKey, controlRoot: root, recoveryScope,
    });
    const authority = posixQuiescentMaintenanceAuthority(supervisor, root, 'f'.repeat(64));
    let retained;
    assert.throws(() => supervisor.resumePosixSessionRecoveryHandoff(
      exhausted.recoveryHandoff,
      {
        quiescentMaintenanceAuthority: authority,
        rotateRecoveryBatonEpoch() { return false; },
      },
    ), (error) => {
      retained = error.recoveryHandoff;
      return error.code === 'POSIX_SESSION_RECOVERY_EPOCH_MAINTENANCE_REQUIRED'
        && retained?.claimPath === exhausted.recoveryHandoff.claimPath;
    });
    assert.equal((await fs.readdir(directory)).filter((name) => name === 'retirement.claim'
      || /^\.recovery-baton\.[a-f0-9]{64}\.claim$/u.test(name)).length, 32);
    let resetFailure;
    assert.throws(() => supervisor.resumePosixSessionRecoveryHandoff(retained, {
      quiescentMaintenanceAuthority: authority,
      rotateRecoveryBatonEpoch(request) {
        resetPosixRecoveryBatonEpoch(request);
        throw new Error('synthetic crash after durable POSIX epoch reset');
      },
    }), (error) => {
      resetFailure = error;
      return /synthetic crash after durable POSIX epoch reset/iu.test(error.message)
        && path.basename(error.recoveryHandoff?.claimPath ?? '') === 'retirement.claim';
    });
    assert.deepEqual((await fs.readdir(directory)).filter((name) => name === 'retirement.claim'
      || /^\.recovery-baton\.[a-f0-9]{64}\.claim$/u.test(name)), ['retirement.claim']);
    const fresh = await import(`../scripts/posix-session-supervisor.js?epoch-reset=${Date.now()}`);
    const resumed = fresh.resumePosixSessionRecoveryHandoff(
      JSON.parse(JSON.stringify(resetFailure.recoveryHandoff)),
    );
    assert.deepEqual(resumed, { absence: 'absent', state: 'incomplete' });
    assert.equal(fresh.completePosixSessionRecovery(resumed.recoveryProof, {
      controlKey, controlRoot: root, recoveryScope,
    }), true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('POSIX fresh recovery resolves a stale pre-rotation handoff to the durable reset origin',
  async () => {
    const supervisor = await import('../scripts/posix-session-supervisor.js');
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-posix-baton-reset-crash-'));
    const controlKey = 'restart-baton-reset-crash';
    const recoveryScope = 'paired-deadline-reset-crash';
    const directory = path.join(root, createHash('sha256').update(controlKey).digest('hex'));
    await fs.mkdir(directory, { mode: 0o700 });
    try {
      const exhausted = exhaustPosixRecoveryBaton(supervisor, {
        controlKey, controlRoot: root, recoveryScope,
      });
      const stale = JSON.parse(JSON.stringify(exhausted.recoveryHandoff));
      const sourceIdentity = fsSync.lstatSync(stale.claimPath);
      const names = (await fs.readdir(directory)).filter((name) => name === 'retirement.claim'
        || /^\.recovery-baton\.[a-f0-9]{64}\.claim$/u.test(name));
      resetPosixRecoveryBatonEpoch({ directory, names });
      assert.deepEqual((await fs.readdir(directory)).filter((name) => name === 'retirement.claim'
        || /^\.recovery-baton\.[a-f0-9]{64}\.claim$/u.test(name)), ['retirement.claim']);
      const originIdentity = fsSync.lstatSync(path.join(directory, 'retirement.claim'));
      assert.equal(String(originIdentity.dev), String(sourceIdentity.dev));
      assert.equal(String(originIdentity.ino), String(sourceIdentity.ino));
      assert.equal(originIdentity.nlink, 1);

      const fresh = await import(`../scripts/posix-session-supervisor.js?epoch-crash=${Date.now()}`);
      let current;
      assert.throws(() => fresh.resumePosixSessionRecoveryHandoff(stale), (error) => {
        current = error.recoveryHandoff;
        return /durability resolved to a surviving tip/iu.test(error.message)
          && path.basename(current?.claimPath ?? '') === 'retirement.claim';
      });
      const resumed = fresh.resumePosixSessionRecoveryHandoff(
        JSON.parse(JSON.stringify(current)),
      );
      assert.deepEqual(resumed, { absence: 'absent', state: 'incomplete' });
      assert.equal(fresh.completePosixSessionRecovery(resumed.recoveryProof, {
        controlKey, controlRoot: root, recoveryScope,
      }), true);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

test('POSIX durable records stay absent until exact no-replace publication', async () => {
  const supervisor = await import('../scripts/posix-session-supervisor.js');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-posix-publication-'));
  const directory = path.join(root, 'owned-session');
  const destination = path.join(directory, 'ready.proof');
  await fs.mkdir(directory);
  const order = [];
  const filesystem = Object.create(fsSync);
  filesystem.fsyncSync = (descriptor) => {
    fsSync.fsyncSync(descriptor);
    order.push('file');
    assert.throws(() => fsSync.readFileSync(destination), { code: 'ENOENT' });
  };
  try {
    supervisor.writeDurablePosixSessionRecord(destination, '{"ready":true}\n', {
      filesystem,
      randomToken: () => '1'.repeat(32),
      synchronizeDirectory(value) { order.push(`directory:${path.basename(value)}`); },
    });
    assert.equal(await fs.readFile(destination, 'utf8'), '{"ready":true}\n');
    assert.deepEqual(order, ['file', 'directory:owned-session', `directory:${path.basename(root)}`]);
    assert.deepEqual((await fs.readdir(directory)).sort(), ['ready.proof']);
    assert.deepEqual((await fs.readdir(root)).sort(), ['owned-session']);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('POSIX durable writer carries the original source identity and content into recovery',
  async () => {
    const supervisor = await import('../scripts/posix-session-supervisor.js');
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-posix-source-binding-'));
    const directory = path.join(root, 'owned-session');
    const destination = path.join(directory, 'ready.proof');
    const temporary = path.join(root,
      '.owned-session.ready.proof.11111111111111111111111111111111.tmp');
    await fs.mkdir(directory, { mode: 0o700 });
    let recoveryAuthority;
    try {
      assert.throws(() => supervisor.writeDurablePosixSessionRecord(
        destination, '{"ready":true}\n', {
          platform: 'linux',
          randomToken: () => '1'.repeat(32),
          runNoReplaceMove() {
            return { status: 73 };
          },
        },
      ), (error) => {
        recoveryAuthority = error.recoveryAuthority;
        return error?.code === 'POSIX_SESSION_PUBLICATION_CLEANUP_REQUIRED'
          && assert.deepEqual(recoveryAuthority,
            posixPublicationRecoveryAuthority(destination, temporary)) === undefined;
      });
      await assert.rejects(fs.access(destination), { code: 'ENOENT' });
      assert.equal(await fs.readFile(temporary, 'utf8'), '{"ready":true}\n');
      assert.equal(supervisor.cleanupPosixSessionPublicationResidue(recoveryAuthority), true);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

test('POSIX constructor retains exact private-publication recovery authority', async () => {
  const supervisor = await import('../scripts/posix-session-supervisor.js');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-posix-constructor-residue-'));
  const controlKey = 'constructor-private-publication-residue';
  const directory = path.join(root, createHash('sha256').update(controlKey).digest('hex'));
  const destination = path.join(directory, 'control.json');
  const temporary = path.join(root, `.${path.basename(directory)}.control.json.${'1'.repeat(32)}.tmp`);
  const tombstone = path.join(root,
    `.${path.basename(temporary)}.cleanup.${'2'.repeat(64)}.tombstone`);
  const publication = new Error('synthetic private publication cleanup failure');
  publication.code = 'POSIX_SESSION_PUBLICATION_CLEANUP_REQUIRED';
  publication.recoveryAuthority = Object.freeze({
    destination,
    sourceBinding: SYNTHETIC_POSIX_PUBLICATION_SOURCE_BINDING,
    temporary,
    tombstone,
  });
  try {
    assert.throws(() => supervisor.createPosixSessionControl({
      controlKey,
      controlRoot: root,
      writeControlRecord() { throw publication; },
    }), (error) => error?.code === 'POSIX_SESSION_RECOVERY_REQUIRED'
      && assert.deepEqual(error.recoveryAuthority,
        {
          controlDirectory: directory,
          destination,
          sourceBinding: SYNTHETIC_POSIX_PUBLICATION_SOURCE_BINDING,
          temporary,
          tombstone,
        }) === undefined);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('bounded lifecycle preserves exact constructor publication authority for recovery', async () => {
  const lifecycle = await import('../scripts/bounded-child-lifecycle.js');
  const root = path.resolve('.test-posix-constructor-authority');
  const controlDirectory = path.join(root, 'a'.repeat(64));
  const destination = path.join(controlDirectory, 'control.json');
  const temporary = path.join(root,
    `.${path.basename(controlDirectory)}.control.json.${'b'.repeat(32)}.tmp`);
  const tombstone = path.join(root,
    `.${path.basename(temporary)}.cleanup.${'c'.repeat(64)}.tombstone`);
  const constructorFailure = new Error('synthetic constructor publication failure');
  constructorFailure.childSettlementUnproven = true;
  constructorFailure.recoveryAuthority = Object.freeze({
    controlDirectory,
    destination,
    sourceBinding: SYNTHETIC_POSIX_PUBLICATION_SOURCE_BINDING,
    temporary,
    tombstone,
  });

  const propagated = lifecycle.propagateLifecycleRecovery(
    new Error('synthetic import failure', { cause: constructorFailure }),
    constructorFailure,
  );

  assert.deepEqual(lifecycle.collectLifecycleRecovery(propagated), {
    childSettlementUnproven: true,
    recoveryAuthorities: [{
      controlDirectory,
      publicationResidue: {
        destination,
        sourceBinding: SYNTHETIC_POSIX_PUBLICATION_SOURCE_BINDING,
        temporary,
        tombstone,
      },
    }],
  });
});

test('POSIX path-only publication cleanup fails closed and never recaptures a later occupant',
  async () => {
  const supervisor = await import('../scripts/posix-session-supervisor.js');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-posix-residue-cleanup-'));
  const directory = path.join(root, 'owned-control');
  const destination = path.join(directory, 'control.json');
  const temporary = path.join(root, '.owned-control.control.json.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.tmp');
  await fs.mkdir(directory, { mode: 0o700 });
  await fs.writeFile(temporary, 'private authority', { flag: 'wx', mode: 0o600 });
  try {
    assert.throws(() => supervisor.cleanupPosixSessionPublicationResidue({
      destination, temporary,
    }), (error) => error?.code === 'POSIX_SESSION_PUBLICATION_CLEANUP_REQUIRED'
      && /authority is not exact/iu.test(error.cause?.message ?? ''));
    assert.equal(await fs.readFile(temporary, 'utf8'), 'private authority');
    await fs.unlink(temporary);
    await fs.writeFile(temporary, 'successor', { flag: 'wx', mode: 0o600 });
    assert.throws(() => supervisor.cleanupPosixSessionPublicationResidue({
      destination, temporary,
    }), (error) => error?.code === 'POSIX_SESSION_PUBLICATION_CLEANUP_REQUIRED'
      && /authority is not exact/iu.test(error.cause?.message ?? ''));
    assert.equal(await fs.readFile(temporary, 'utf8'), 'successor');
    assert.equal((await fs.readdir(root)).some((name) =>
      name.startsWith('.easyboost-staging-quarantine-slot.')), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
  });

test('POSIX direct publication cleanup rejects a same-inode content rewrite before quarantine',
  async () => {
    const supervisor = await import('../scripts/posix-session-supervisor.js');
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-posix-residue-rewrite-'));
    const directory = path.join(root, 'owned-control');
    const destination = path.join(directory, 'ready.proof');
    const temporary = path.join(root,
      '.owned-control.ready.proof.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.tmp');
    const original = Buffer.alloc(32, 0x41);
    const successor = Buffer.alloc(32, 0x42);
    await fs.mkdir(directory, { mode: 0o700 });
    await fs.writeFile(temporary, original, { flag: 'wx', mode: 0o600 });
    try {
      const before = await fs.stat(temporary);
      const authority = posixPublicationRecoveryAuthority(destination, temporary);
      assert.throws(() => supervisor.cleanupPosixSessionPublicationResidue(authority, {
        beforeUnlink() { fsSync.writeFileSync(temporary, successor); },
      }), (error) => error?.code === 'POSIX_SESSION_PUBLICATION_CLEANUP_REQUIRED'
        && errorTreeMessages(error).some((message) =>
          /changed before cleanup|no longer matches/iu.test(message)));
      const after = await fs.stat(temporary);
      assert.equal(String(after.dev), String(before.dev));
      assert.equal(String(after.ino), String(before.ino));
      assert.deepEqual(await fs.readFile(temporary), successor,
        'a modified same inode must remain untouched for explicit recovery');
      assert.equal((await fs.readdir(root)).some((name) => name.endsWith('.tombstone')), false,
        'content drift must fail before reserving or mutating quarantine state');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

test('POSIX publication recovery rejects a replacement present before replay begins', async () => {
  const supervisor = await import('../scripts/posix-session-supervisor.js');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-posix-residue-pre-replay-aba-'));
  const directory = path.join(root, 'owned-control');
  const destination = path.join(directory, 'ready.proof');
  const temporary = path.join(root,
    '.owned-control.ready.proof.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.tmp');
  await fs.mkdir(directory, { mode: 0o700 });
  await fs.writeFile(temporary, 'original private authority', { flag: 'wx', mode: 0o600 });
  const authority = posixPublicationRecoveryAuthority(destination, temporary);
  await fs.unlink(temporary);
  await fs.writeFile(temporary, 'foreign replacement', { flag: 'wx', mode: 0o600 });
  try {
    assert.throws(() => supervisor.cleanupPosixSessionPublicationResidue(authority), (error) =>
      error?.code === 'POSIX_SESSION_PUBLICATION_CLEANUP_REQUIRED'
      && errorTreeMessages(error).some((message) => /source binding|no longer matches/iu.test(message)));
    assert.equal(await fs.readFile(temporary, 'utf8'), 'foreign replacement');
    assert.equal((await fs.readdir(root)).some((name) => name.endsWith('.tombstone')), false,
      'a pre-replay successor must remain in place and must not create retained authority');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('POSIX publication quarantine never replaces a target created in the move window',
  async () => {
    const supervisor = await import('../scripts/posix-session-supervisor.js');
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-posix-target-no-replace-'));
    const directory = path.join(root, 'owned-control');
    const destination = path.join(directory, 'ready.proof');
    const temporary = path.join(root,
      '.owned-control.ready.proof.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.tmp');
    await fs.mkdir(directory, { mode: 0o700 });
    await fs.writeFile(temporary, 'owned private authority', { flag: 'wx', mode: 0o600 });
    const authority = posixPublicationRecoveryAuthority(destination, temporary);
    const racingFilesystem = Object.create(fsSync);
    const publishForeignTarget = (target) => {
      fsSync.writeFileSync(target, 'foreign retained payload', { flag: 'wx', mode: 0o600 });
    };
    racingFilesystem.renameSync = (source, target) => {
      publishForeignTarget(target);
      return fsSync.renameSync(source, target);
    };
    racingFilesystem.linkSync = (source, target) => {
      publishForeignTarget(target);
      return fsSync.linkSync(source, target);
    };
    try {
      assert.throws(() => supervisor.cleanupPosixSessionPublicationResidue(authority, {
        filesystem: racingFilesystem,
      }), (error) => error?.code === 'POSIX_SESSION_PUBLICATION_CLEANUP_REQUIRED');
      assert.equal(await fs.readFile(temporary, 'utf8'), 'owned private authority');
      const slotName = (await fs.readdir(root)).find((name) =>
        name.startsWith('.easyboost-staging-quarantine-slot.'));
      assert.ok(slotName);
      assert.equal(await fs.readFile(path.join(root, slotName, 'payload'), 'utf8'),
        'foreign retained payload');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
  }
});

test('POSIX publication handoff never pathname-unlinks a concurrent source successor',
  async () => {
    const supervisor = await import('../scripts/posix-session-supervisor.js');
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-posix-source-unlink-race-'));
    const directory = path.join(root, 'owned-control');
    const destination = path.join(directory, 'ready.proof');
    const temporary = path.join(root,
      '.owned-control.ready.proof.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.tmp');
    const displaced = `${temporary}.displaced-exact`;
    await fs.mkdir(directory, { mode: 0o700 });
    await fs.writeFile(temporary, 'owned private authority', { flag: 'wx', mode: 0o600 });
    const authority = posixPublicationRecoveryAuthority(destination, temporary);
    const racingFilesystem = Object.create(fsSync);
    let sourceUnlinkAttempts = 0;
    racingFilesystem.unlinkSync = (entry) => {
      if (entry === temporary) {
        sourceUnlinkAttempts += 1;
        fsSync.renameSync(temporary, displaced);
        fsSync.writeFileSync(temporary, 'foreign concurrent successor', {
          flag: 'wx', mode: 0o600,
        });
      }
      return fsSync.unlinkSync(entry);
    };
    try {
      assert.equal(supervisor.cleanupPosixSessionPublicationResidue(authority, {
        filesystem: racingFilesystem,
      }), true);
      assert.equal(sourceUnlinkAttempts, 0,
        'ordinary runtime cleanup must retain both proved hard-link names');
      assert.equal(await fs.readFile(temporary, 'utf8'), 'owned private authority');
      await assert.rejects(fs.access(displaced), { code: 'ENOENT' });
      const slot = (await fs.readdir(root)).find((name) =>
        name.startsWith('.easyboost-staging-quarantine-slot.'));
      assert.ok(slot);
      const payload = path.join(root, slot, 'payload');
      const sourceIdentity = await fs.stat(temporary);
      const payloadIdentity = await fs.stat(payload);
      assert.equal(String(sourceIdentity.dev), String(payloadIdentity.dev));
      assert.equal(String(sourceIdentity.ino), String(payloadIdentity.ino));
      assert.equal(sourceIdentity.nlink, 2);
      assert.equal(payloadIdentity.nlink, 2);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

test('POSIX directory quarantine uses a bounded no-clobber handoff and preserves a late target',
  async () => {
    const supervisor = await import('../scripts/posix-session-supervisor.js');
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-posix-directory-no-replace-'));
    const source = path.join(root, 'owned-control');
    const destination = path.join(root, 'retained-control');
    await fs.mkdir(source, { mode: 0o700 });
    await fs.writeFile(path.join(source, 'control.json'), 'owned source', { mode: 0o600 });
    let lateIdentity;
    try {
      assert.throws(() => supervisor.movePosixDirectoryNoReplace(source, destination, {
        platform: 'linux',
        runMove(command, args, options) {
          assert.equal(command, '/usr/bin/python3');
          assert.deepEqual(args.slice(0, 3), ['-I', '-S', '-c']);
          assert.match(args[3], /renameat2\(-100, source, -100, destination, 1\)/u);
          assert.deepEqual(args.slice(-2), [source, destination]);
          assert.equal(options.timeout, 5_000);
          assert.equal(options.shell, false);
          fsSync.mkdirSync(destination, { mode: 0o700 });
          lateIdentity = fsSync.lstatSync(destination);
          return { status: 73 };
        },
      }), /did not commit/iu);
      assert.equal(await fs.readFile(path.join(source, 'control.json'), 'utf8'), 'owned source');
      const retainedLateIdentity = await fs.stat(destination);
      assert.equal(String(retainedLateIdentity.dev), String(lateIdentity.dev));
      assert.equal(String(retainedLateIdentity.ino), String(lateIdentity.ino));
      assert.deepEqual(await fs.readdir(destination), []);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
  }
});

test('POSIX directory handoff retains both trees when its source name is substituted',
  async () => {
    const supervisor = await import('../scripts/posix-session-supervisor.js');
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-posix-directory-source-race-'));
    const source = path.join(root, 'owned-control');
    const displacedExact = path.join(root, 'displaced-exact-control');
    const destination = path.join(root, 'retained-control');
    await fs.mkdir(source, { mode: 0o700 });
    await fs.writeFile(path.join(source, 'control.json'), 'owned source', { mode: 0o600 });
    try {
      assert.throws(() => supervisor.movePosixDirectoryNoReplace(source, destination, {
        platform: 'linux',
        runMove() {
          fsSync.renameSync(source, displacedExact);
          fsSync.mkdirSync(source, { mode: 0o700 });
          fsSync.writeFileSync(path.join(source, 'successor'), 'foreign successor', {
            flag: 'wx', mode: 0o600,
          });
          fsSync.renameSync(source, destination);
          return { status: 0 };
        },
      }), (error) => error?.code === 'POSIX_SESSION_DIRECTORY_HANDOFF_RETAINED'
        && assert.deepEqual(error.recoveryAuthority, { destination, source }) === undefined);
      assert.equal(await fs.readFile(path.join(displacedExact, 'control.json'), 'utf8'),
        'owned source');
      assert.equal(await fs.readFile(path.join(destination, 'successor'), 'utf8'),
        'foreign successor');
      await assert.rejects(fs.access(source), { code: 'ENOENT' });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

test('POSIX retained publication evidence never unlinks an ABA successor during replay', async () => {
  const supervisor = await import('../scripts/posix-session-supervisor.js');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-posix-unlink-aba-'));
  const directory = path.join(root, 'owned-control');
  const destination = path.join(directory, 'control.json');
  const temporary = path.join(root, '.owned-control.control.json.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.tmp');
  await fs.mkdir(directory, { mode: 0o700 });
  await fs.writeFile(temporary, 'private authority', { flag: 'wx', mode: 0o600 });
  const initialAuthority = posixPublicationRecoveryAuthority(destination, temporary);
  try {
    let authority;
    assert.throws(() => supervisor.cleanupPosixSessionPublicationResidue(initialAuthority, {
      synchronizeDirectory() { throw new Error('capture terminal publication evidence'); },
    }), (error) => {
      authority = error.recoveryAuthority;
      return typeof authority?.tombstone === 'string';
    });
    assert.equal(supervisor.cleanupPosixSessionPublicationResidue(authority, {
      synchronizeDirectory() {
        fsSync.rmSync(authority.tombstone, { force: true, recursive: true });
        fsSync.writeFileSync(authority.tombstone, 'successor', { flag: 'wx', mode: 0o600 });
      },
    }), true);
    assert.equal(await fs.readFile(authority.tombstone, 'utf8'), 'successor');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('POSIX cleanup retains bounded terminal publication evidence and replay is idempotent', async () => {
  const supervisor = await import('../scripts/posix-session-supervisor.js');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-posix-unlink-tombstone-'));
  const directory = path.join(root, 'owned-control');
  const destination = path.join(directory, 'control.json');
  const temporary = path.join(root, '.owned-control.control.json.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.tmp');
  await fs.mkdir(directory, { mode: 0o700 });
  await fs.writeFile(temporary, 'private authority', { flag: 'wx', mode: 0o600 });
  const initialAuthority = posixPublicationRecoveryAuthority(destination, temporary);
  const sourceBinding = initialAuthority.sourceBinding;
  try {
    assert.equal(supervisor.cleanupPosixSessionPublicationResidue(initialAuthority), true);
    const tombstoneName = (await fs.readdir(root)).find((name) => name.endsWith('.tombstone'));
    const authority = { ...initialAuthority, tombstone: path.join(root, tombstoneName) };
    const reservation = JSON.parse(await fs.readFile(
      path.join(authority.tombstone, 'reservation.claim'), 'utf8',
    ));
    assert.equal(reservation.entries, 2,
      'quota reserves both retained pathnames while charging one payload byte-set');
    assert.equal(reservation.sourceName, path.basename(temporary));
    assert.deepEqual(reservation.sourceBinding, sourceBinding);
    await fs.access(authority.tombstone);
    assert.equal(supervisor.cleanupPosixSessionPublicationResidue(authority), true);
    await fs.access(authority.tombstone);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('POSIX replay reclaims an exact reservation-only publication after its source vanished',
  async () => {
    const supervisor = await import('../scripts/posix-session-supervisor.js');
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-posix-publication-reserved-'));
    const directory = path.join(root, 'owned-control');
    const destination = path.join(directory, 'control.json');
    const temporary = path.join(root,
      '.owned-control.control.json.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.tmp');
    await fs.mkdir(directory, { mode: 0o700 });
    await fs.writeFile(temporary, 'private authority', { flag: 'wx', mode: 0o600 });
    const initialAuthority = posixPublicationRecoveryAuthority(destination, temporary);
    const filesystem = Object.create(fsSync);
    filesystem.linkSync = () => { throw new Error('synthetic no-replace publication failure'); };
    let restartAuthority;
    try {
      assert.throws(() => supervisor.cleanupPosixSessionPublicationResidue(initialAuthority, {
        filesystem,
      }), (error) => {
        restartAuthority = error?.recoveryAuthority;
        return error?.code === 'POSIX_SESSION_PUBLICATION_CLEANUP_REQUIRED'
          && typeof restartAuthority?.tombstone === 'string';
      });
      assert.deepEqual(await fs.readdir(restartAuthority.tombstone), ['reservation.claim']);
      await fs.rm(temporary);

      let reclaimed;
      assert.equal(supervisor.cleanupPosixSessionPublicationResidue(restartAuthority, {
        quiescentMaintenanceAuthority: posixQuiescentMaintenanceAuthority(supervisor, root),
        reclaimRetainedEvidence(request) {
          if (request.kind === 'QUIESCENT_ABSENCE_PROOF') return true;
          reclaimed = request;
          assert.equal(request.kind, 'RESERVATION_ONLY');
          assert.equal(request.reservationBinding.purpose, 'cleanup');
          assert.equal(request.reservationBinding.sourceDev,
            initialAuthority.sourceBinding.dev);
          assert.equal(request.reservationBinding.sourceIno,
            initialAuthority.sourceBinding.ino);
          fsSync.rmSync(request.container, { recursive: true });
          return true;
        },
      }), true);
      assert.ok(reclaimed);
      await assert.rejects(fs.access(restartAuthority.tombstone), { code: 'ENOENT' });
      await assert.rejects(fs.access(temporary), { code: 'ENOENT' });
      await assert.rejects(fs.access(destination), { code: 'ENOENT' });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

test('POSIX quiescent maintenance alone retires the complete retained publication pair',
  async () => {
    const supervisor = await import('../scripts/posix-session-supervisor.js');
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-posix-pair-maintenance-'));
    const directory = path.join(root, 'owned-control');
    const destination = path.join(directory, 'control.json');
    const temporary = path.join(root,
      '.owned-control.control.json.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.tmp');
    await fs.mkdir(directory, { mode: 0o700 });
    await fs.writeFile(temporary, 'private authority', { flag: 'wx', mode: 0o600 });
    const initialAuthority = posixPublicationRecoveryAuthority(destination, temporary);
    try {
      assert.equal(supervisor.cleanupPosixSessionPublicationResidue(initialAuthority), true);
      const tombstoneName = (await fs.readdir(root)).find((name) =>
        name.startsWith('.easyboost-staging-quarantine-slot.'));
      const tombstone = path.join(root, tombstoneName);
      const authority = { ...initialAuthority, tombstone };
      const payload = path.join(tombstone, 'payload');
      assert.equal((await fs.stat(temporary)).nlink, 2);
      assert.equal((await fs.stat(payload)).nlink, 2);

      assert.throws(() => supervisor.cleanupPosixSessionPublicationResidue(authority, {
        reclaimRetainedEvidence() { throw new Error('must not run without a valid lease'); },
      }), /cleanup required/iu);
      assert.equal((await fs.stat(temporary)).nlink, 2,
        'an unbound callback cannot retire either retained name');

      const maintenance = posixQuiescentMaintenanceAuthority(supervisor, root);
      let reclaimed = false;
      assert.equal(supervisor.cleanupPosixSessionPublicationResidue(authority, {
        quiescentMaintenanceAuthority: maintenance,
        reclaimRetainedEvidence(request) {
          reclaimed = true;
          assert.equal(request.kind, 'PUBLICATION');
          assert.equal(fsSync.existsSync(temporary), false,
            'the leased path retires the source before delegating slot removal');
          assert.equal(fsSync.lstatSync(request.payload).nlink, 2);
          assert.equal(fsSync.lstatSync(path.join(
            request.container, 'retained-source',
          )).nlink, 2,
          'both exact links must be inside the identity-bound container before deletion');
          fsSync.rmSync(request.container, { recursive: true });
          return true;
        },
      }), true);
      assert.equal(reclaimed, true);
      await assert.rejects(fs.access(temporary), { code: 'ENOENT' });
      await assert.rejects(fs.access(tombstone), { code: 'ENOENT' });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

test('POSIX quiescent maintenance retains the last publication link after external link loss',
  async () => {
    const supervisor = await import('../scripts/posix-session-supervisor.js');
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-posix-pair-link-loss-'));
    const directory = path.join(root, 'owned-control');
    const destination = path.join(directory, 'control.json');
    const temporary = path.join(root,
      '.owned-control.control.json.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.tmp');
    await fs.mkdir(directory, { mode: 0o700 });
    await fs.writeFile(temporary, 'private authority', { flag: 'wx', mode: 0o600 });
    const initialAuthority = posixPublicationRecoveryAuthority(destination, temporary);
    try {
      assert.equal(supervisor.cleanupPosixSessionPublicationResidue(initialAuthority), true);
      const tombstoneName = (await fs.readdir(root)).find((name) =>
        name.startsWith('.easyboost-staging-quarantine-slot.'));
      const tombstone = path.join(root, tombstoneName);
      const payload = path.join(tombstone, 'payload');
      await fs.unlink(temporary);
      let reclaimCalls = 0;

      assert.throws(() => supervisor.cleanupPosixSessionPublicationResidue({
        ...initialAuthority, tombstone,
      }, {
        quiescentMaintenanceAuthority: posixQuiescentMaintenanceAuthority(supervisor, root),
        reclaimRetainedEvidence() {
          reclaimCalls += 1;
          return true;
        },
      }), /cleanup required/iu);
      assert.equal(reclaimCalls, 0,
        'a missing publication link must fail before maintenance deletion');
      assert.equal(await fs.readFile(payload, 'utf8'), 'private authority');
      assert.equal((await fs.stat(payload)).nlink, 1);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

test('POSIX quiescent source retirement relocates and preserves a last-window replacement',
  async () => {
    const supervisor = await import('../scripts/posix-session-supervisor.js');
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-posix-pair-source-race-'));
    const directory = path.join(root, 'owned-control');
    const destination = path.join(directory, 'ready.proof');
    const temporary = path.join(root,
      '.owned-control.ready.proof.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.tmp');
    const displacedExact = `${temporary}.displaced-exact`;
    await fs.mkdir(directory, { mode: 0o700 });
    await fs.writeFile(temporary, 'private authority', { flag: 'wx', mode: 0o600 });
    const initialAuthority = posixPublicationRecoveryAuthority(destination, temporary);
    try {
      assert.equal(supervisor.cleanupPosixSessionPublicationResidue(initialAuthority), true);
      const tombstoneName = (await fs.readdir(root)).find((name) =>
        name.startsWith('.easyboost-staging-quarantine-slot.'));
      const tombstone = path.join(root, tombstoneName);
      const authority = { ...initialAuthority, tombstone };
      let hookCalled = false;
      let reclaimCalled = false;
      let failure;
      assert.throws(() => supervisor.cleanupPosixSessionPublicationResidue(authority, {
        beforeRetainedSourceMove(request) {
          hookCalled = true;
          assert.equal(request.source, temporary);
          fsSync.renameSync(temporary, displacedExact);
          fsSync.writeFileSync(temporary, 'foreign replacement', { flag: 'wx', mode: 0o600 });
        },
        quiescentMaintenanceAuthority: posixQuiescentMaintenanceAuthority(supervisor, root),
        reclaimRetainedEvidence() {
          reclaimCalled = true;
          return true;
        },
      }), (error) => {
        failure = error;
        return error?.code === 'POSIX_SESSION_PUBLICATION_CLEANUP_REQUIRED';
      });
      assert.equal(hookCalled, true);
      assert.equal(reclaimCalled, false,
        'identity mismatch must fail before the maintenance helper can delete either object');
      assert.equal(failure.recoveryAuthority.tombstone, tombstone);
      await assert.rejects(fs.access(temporary), { code: 'ENOENT' });
      assert.equal(await fs.readFile(displacedExact, 'utf8'), 'private authority');
      assert.equal(await fs.readFile(path.join(tombstone, 'payload'), 'utf8'),
        'private authority');
      assert.equal(await fs.readFile(path.join(tombstone, 'retained-source'), 'utf8'),
        'foreign replacement');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

test('POSIX replay resumes after quiescent source retirement and preserves a later foreign name',
  async () => {
    const supervisor = await import('../scripts/posix-session-supervisor.js');
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-posix-pair-restart-'));
    const directory = path.join(root, 'owned-control');
    const destination = path.join(directory, 'ready.proof');
    const temporary = path.join(root,
      '.owned-control.ready.proof.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.tmp');
    await fs.mkdir(directory, { mode: 0o700 });
    await fs.writeFile(temporary, 'private authority', { flag: 'wx', mode: 0o600 });
    const initialAuthority = posixPublicationRecoveryAuthority(destination, temporary);
    try {
      assert.equal(supervisor.cleanupPosixSessionPublicationResidue(initialAuthority), true);
      const tombstoneName = (await fs.readdir(root)).find((name) =>
        name.startsWith('.easyboost-staging-quarantine-slot.'));
      const tombstone = path.join(root, tombstoneName);
      let restartAuthority;
      assert.throws(() => supervisor.cleanupPosixSessionPublicationResidue({
        ...initialAuthority, tombstone,
      }, {
        quiescentMaintenanceAuthority: posixQuiescentMaintenanceAuthority(supervisor, root),
        reclaimRetainedEvidence() {
          throw new Error('synthetic crash after durable source retirement');
        },
      }), (error) => {
        restartAuthority = error.recoveryAuthority;
        return error?.code === 'POSIX_SESSION_PUBLICATION_CLEANUP_REQUIRED';
      });
      await assert.rejects(fs.access(temporary), { code: 'ENOENT' });
      assert.equal((await fs.stat(path.join(tombstone, 'payload'))).nlink, 2);
      assert.equal((await fs.stat(path.join(tombstone, 'retained-source'))).nlink, 2);
      assert.equal(supervisor.cleanupPosixSessionPublicationResidue(restartAuthority), true,
        'the immutable reservation must make the partial maintenance state replayable');

      await fs.writeFile(temporary, 'foreign successor', { flag: 'wx', mode: 0o600 });
      assert.throws(() => supervisor.cleanupPosixSessionPublicationResidue(restartAuthority),
        (error) => error?.code === 'POSIX_SESSION_PUBLICATION_CLEANUP_REQUIRED');
      assert.equal(await fs.readFile(temporary, 'utf8'), 'foreign successor');
      assert.equal(await fs.readFile(path.join(tombstone, 'payload'), 'utf8'),
        'private authority');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

test('POSIX replay completes after quiescent maintenance removed the retained fixed slot',
  async () => {
    const supervisor = await import('../scripts/posix-session-supervisor.js');
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-posix-pair-removed-restart-'));
    const directory = path.join(root, 'owned-control');
    const destination = path.join(directory, 'ready.proof');
    const temporary = path.join(root,
      '.owned-control.ready.proof.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.tmp');
    await fs.mkdir(directory, { mode: 0o700 });
    await fs.writeFile(temporary, 'private authority', { flag: 'wx', mode: 0o600 });
    const initialAuthority = posixPublicationRecoveryAuthority(destination, temporary);
    try {
      assert.equal(supervisor.cleanupPosixSessionPublicationResidue(initialAuthority), true);
      const tombstoneName = (await fs.readdir(root)).find((name) =>
        name.startsWith('.easyboost-staging-quarantine-slot.'));
      const tombstone = path.join(root, tombstoneName);
      let restartAuthority;
      assert.throws(() => supervisor.cleanupPosixSessionPublicationResidue({
        ...initialAuthority, tombstone,
      }, {
        quiescentMaintenanceAuthority: posixQuiescentMaintenanceAuthority(supervisor, root),
        reclaimRetainedEvidence(request) {
          fsSync.rmSync(request.container, { recursive: true });
          throw new Error('synthetic crash after retained slot removal');
        },
      }), (error) => {
        restartAuthority = error.recoveryAuthority;
        return error?.code === 'POSIX_SESSION_PUBLICATION_CLEANUP_REQUIRED';
      });
      await assert.rejects(fs.access(temporary), { code: 'ENOENT' });
      await assert.rejects(fs.access(tombstone), { code: 'ENOENT' });

      assert.equal(supervisor.cleanupPosixSessionPublicationResidue(restartAuthority, {
        quiescentMaintenanceAuthority: posixQuiescentMaintenanceAuthority(
          supervisor, root, 'f'.repeat(64),
        ),
        reclaimRetainedEvidence(request) {
          assert.equal(request.kind, 'QUIESCENT_ABSENCE_PROOF');
          return true;
        },
      }), true);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

test('POSIX durable source authority rediscovers exact absence after maintenance completion',
  async () => {
    const supervisor = await import('../scripts/posix-session-supervisor.js');
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-posix-pair-origin-restart-'));
    const directory = path.join(root, 'owned-control');
    const destination = path.join(directory, 'ready.proof');
    const temporary = path.join(root,
      '.owned-control.ready.proof.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.tmp');
    await fs.mkdir(directory, { mode: 0o700 });
    await fs.writeFile(temporary, 'private authority', { flag: 'wx', mode: 0o600 });
    const durableAuthority = posixPublicationRecoveryAuthority(destination, temporary);
    try {
      assert.equal(supervisor.cleanupPosixSessionPublicationResidue(durableAuthority), true);
      const tombstoneName = (await fs.readdir(root)).find((name) =>
        name.startsWith('.easyboost-staging-quarantine-slot.'));
      const tombstone = path.join(root, tombstoneName);
      assert.throws(() => supervisor.cleanupPosixSessionPublicationResidue({
        ...durableAuthority, tombstone,
      }, {
        quiescentMaintenanceAuthority: posixQuiescentMaintenanceAuthority(supervisor, root),
        reclaimRetainedEvidence(request) {
          fsSync.rmSync(request.container, { recursive: true });
          throw new Error('synthetic process loss after retained slot removal');
        },
      }), /cleanup required/iu);
      await assert.rejects(fs.access(temporary), { code: 'ENOENT' });
      await assert.rejects(fs.access(tombstone), { code: 'ENOENT' });

      assert.equal(supervisor.cleanupPosixSessionPublicationResidue(durableAuthority, {
        quiescentMaintenanceAuthority: posixQuiescentMaintenanceAuthority(
          supervisor, root, 'a'.repeat(64),
        ),
        reclaimRetainedEvidence(request) {
          assert.equal(request.kind, 'QUIESCENT_ABSENCE_PROOF');
          return true;
        },
      }), true);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

test('POSIX proven quiescent maintenance reclaims a successful fixed-slot retirement', async () => {
  const supervisor = await import('../scripts/posix-session-supervisor.js');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-posix-maintenance-'));
  const rootIdentity = await fs.stat(root);
  const authority = Object.freeze({
    descriptor: supervisor.STAGING_QUIESCENT_MAINTENANCE_DESCRIPTOR,
    lease: 'd'.repeat(64),
    ownerPid: process.pid,
    ownerStartTime: '1',
    protocol: supervisor.STAGING_QUIESCENT_MAINTENANCE_PROTOCOL,
    rootDev: String(rootIdentity.dev),
    rootIno: String(rootIdentity.ino),
  });
  assert.deepEqual(supervisor.validatePosixQuiescentMaintenanceAuthority(authority, {
    controlRoot: root,
  }), authority);
  assert.throws(() => supervisor.validatePosixQuiescentMaintenanceAuthority(
    { ...authority, extra: true }, { controlRoot: root },
  ), /maintenance authority is invalid/iu);
  let reclaimed;
  const control = supervisor.createPosixSessionControl({
    controlKey: 'quiescent-maintenance-success',
    controlRoot: root,
    quiescentMaintenanceAuthority: authority,
    reclaimRetainedEvidence(request) {
      reclaimed = request;
      assert.deepEqual(request.authority, authority);
      assert.notEqual(request.authority, authority);
      assert.equal(request.container, request.tombstone);
      assert.equal(request.kind, 'RETIREMENT');
      assert.equal(path.basename(request.payload), 'payload');
      assert.deepEqual(request.bounds, {
        maximumBytes: 256 * 1024 * 1024,
        maximumEntries: 32_768,
      });
      const containerIdentity = fsSync.lstatSync(request.container);
      const payloadIdentity = fsSync.lstatSync(request.payload, { bigint: true });
      assert.deepEqual(request.containerIdentity, {
        dev: String(containerIdentity.dev), ino: String(containerIdentity.ino),
      });
      assert.deepEqual(request.payloadIdentity, {
        dev: String(payloadIdentity.dev), ino: String(payloadIdentity.ino),
      });
      fsSync.rmSync(request.container, { recursive: true });
      return true;
    },
  });
  try {
    control.dispose({ force: true });
    assert.ok(reclaimed);
    assert.deepEqual(await fs.readdir(root), []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('POSIX publication tombstone cleanup retries root durability with retained evidence', async () => {
  const supervisor = await import('../scripts/posix-session-supervisor.js');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-posix-unlink-sync-retry-'));
  const directory = path.join(root, 'owned-control');
  const destination = path.join(directory, 'control.json');
  const temporary = path.join(root, '.owned-control.control.json.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.tmp');
  await fs.mkdir(directory, { mode: 0o700 });
  await fs.writeFile(temporary, 'private authority', { flag: 'wx', mode: 0o600 });
  const initialAuthority = posixPublicationRecoveryAuthority(destination, temporary);
  try {
    let authority;
    assert.throws(() => supervisor.cleanupPosixSessionPublicationResidue(initialAuthority, {
      synchronizeDirectory() { throw new Error('synthetic quarantine parent sync failure'); },
    }), (error) => {
      authority = error?.recoveryAuthority;
      return typeof authority?.tombstone === 'string';
    });
    await fs.access(authority.tombstone);
    assert.equal(supervisor.cleanupPosixSessionPublicationResidue(authority), true);
    await fs.access(authority.tombstone);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('POSIX publication cleanup rediscovers its quarantined residue after a crash', async () => {
  const supervisor = await import('../scripts/posix-session-supervisor.js');
  const root = await fs.mkdtemp(path.resolve('.test-posix-publication-restart-'));
  const directory = path.join(root, 'owned-control');
  const destination = path.join(directory, 'ready.proof');
  const temporary = path.join(root,
    '.owned-control.ready.proof.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.tmp');
  await fs.mkdir(directory, { mode: 0o700 });
  await fs.writeFile(temporary, 'private authority', { flag: 'wx', mode: 0o600 });
  const originalAuthority = posixPublicationRecoveryAuthority(destination, temporary);
  try {
    assert.throws(() => supervisor.cleanupPosixSessionPublicationResidue(
      originalAuthority,
      { synchronizeDirectory() { throw new Error('synthetic crash after quarantine'); } },
    ), /cleanup required/iu);

    // The durable DB/host marker still contains the pre-crash authority. Recovery
    // must derive the exact quarantine from that marker, not from thrown memory.
    assert.equal(supervisor.cleanupPosixSessionPublicationResidue(originalAuthority), true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('POSIX publication cleanup rejects a same-size ABA successor after reservation restart', async () => {
  const supervisor = await import('../scripts/posix-session-supervisor.js');
  const root = await fs.mkdtemp(path.resolve('.test-posix-publication-restart-aba-'));
  const directory = path.join(root, 'owned-control');
  const destination = path.join(directory, 'ready.proof');
  const temporary = path.join(root,
    '.owned-control.ready.proof.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.tmp');
  const original = Buffer.alloc(32, 0x41);
  const successor = Buffer.alloc(32, 0x42);
  await fs.mkdir(directory, { mode: 0o700 });
  await fs.writeFile(temporary, original, { flag: 'wx', mode: 0o600 });
  const authority = posixPublicationRecoveryAuthority(destination, temporary);
  const crashingFilesystem = Object.create(fsSync);
  crashingFilesystem.linkSync = (source) => {
    assert.equal(source, temporary);
    throw new Error('synthetic crash after durable quarantine reservation');
  };
  try {
    assert.throws(() => supervisor.cleanupPosixSessionPublicationResidue(authority, {
      filesystem: crashingFilesystem,
    }), /cleanup required/iu);
    const slotName = (await fs.readdir(root)).find((name) =>
      /^\.easyboost-staging-quarantine-slot\.[0-9a-f]{64}\.tombstone$/u.test(name));
    assert.ok(slotName);
    const slot = path.join(root, slotName);
    assert.deepEqual(await fs.readdir(slot), ['reservation.claim']);

    await fs.unlink(temporary);
    await fs.writeFile(temporary, successor, { flag: 'wx', mode: 0o600 });

    assert.throws(() => supervisor.cleanupPosixSessionPublicationResidue(authority), (error) =>
      error?.code === 'POSIX_SESSION_PUBLICATION_CLEANUP_REQUIRED'
      && errorTreeMessages(error).some((message) =>
        /source (?:binding )?no longer matches(?: its reservation)?/iu.test(message)));
    assert.deepEqual(await fs.readFile(temporary), successor);
    assert.deepEqual(await fs.readdir(slot), ['reservation.claim']);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('POSIX retained publication replay revalidates exact content and bound after its hook',
  async () => {
    const supervisor = await import('../scripts/posix-session-supervisor.js');
    for (const mutation of ['same-size-content', 'over-bound']) {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), `easyboost-posix-replay-${mutation}-`));
      const directory = path.join(root, 'owned-control');
      const destination = path.join(directory, 'control.json');
      const temporary = path.join(root,
        '.owned-control.control.json.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.tmp');
      await fs.mkdir(directory, { mode: 0o700 });
      await fs.writeFile(temporary, Buffer.alloc(32, 0x41), { flag: 'wx', mode: 0o600 });
      const initialAuthority = posixPublicationRecoveryAuthority(destination, temporary);
      try {
        let authority;
        assert.throws(() => supervisor.cleanupPosixSessionPublicationResidue(initialAuthority, {
          synchronizeDirectory() { throw new Error('retain exact publication evidence'); },
        }), (error) => {
          authority = error.recoveryAuthority;
          return typeof authority?.tombstone === 'string';
        });
        const payload = path.join(authority.tombstone, 'payload');
        const before = await fs.stat(payload);
        assert.throws(() => supervisor.cleanupPosixSessionPublicationResidue(authority, {
          beforeUnlink() {
            if (mutation === 'same-size-content') {
              fsSync.writeFileSync(payload, Buffer.alloc(32, 0x42));
            } else {
              fsSync.truncateSync(payload, 65_537);
            }
          },
        }), (error) => error?.code === 'POSIX_SESSION_PUBLICATION_CLEANUP_REQUIRED'
          && errorTreeMessages(error).some((message) =>
            /changed before cleanup|no longer matches its reservation|unsafe or unbounded/iu
              .test(message)));
        const after = await fs.stat(payload);
        assert.equal(String(after.dev), String(before.dev));
        assert.equal(String(after.ino), String(before.ino));
        assert.equal(after.size, mutation === 'same-size-content' ? 32 : 65_537,
          'a rejected retained payload must never be deleted or rewritten');
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    }
  });

test('POSIX recovery retains every persisted publication residue as typed dual-link evidence',
  async () => {
  const supervisor = await import('../scripts/posix-session-supervisor.js');
  const root = await fs.mkdtemp(path.resolve('.test-posix-plural-recovery-'));
  const controlKey = 'plural-publication-recovery';
  const directory = path.join(root, createHash('sha256').update(controlKey).digest('hex'));
  let publicationResidues = ['ready.proof', 'term.request', 'kill.request']
    .map((name, index) => {
      const destination = path.join(directory, name);
      return {
        destination,
        temporary: path.join(root,
          `.${path.basename(directory)}.${name}.${String(index + 1).repeat(32)}.tmp`),
      };
    });
  await fs.mkdir(directory, { mode: 0o700 });
  for (const residue of publicationResidues) {
    await fs.writeFile(residue.temporary, 'private authority', { flag: 'wx', mode: 0o600 });
  }
  publicationResidues = publicationResidues.map(({ destination, temporary }) =>
    posixPublicationRecoveryAuthority(destination, temporary));
  try {
    const result = supervisor.recoverPosixSessionControl({
      controlKey,
      controlRoot: root,
      permitIncompleteRetirement: true,
      publicationResidues,
    });
    assert.equal(result.absence, 'absent');
    for (const residue of publicationResidues) {
      const sourceIdentity = await fs.stat(residue.temporary);
      assert.equal(sourceIdentity.nlink, 2,
        'runtime recovery must retain the authenticated source link');
    }
    assert.equal((await fs.readdir(root)).filter((name) =>
      name.startsWith('.easyboost-staging-quarantine-slot.')).length, 4,
    'three publication pairs and the retired control directory remain typed evidence');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('POSIX retained-evidence count and byte quotas fail closed before quarantine', async () => {
  const supervisor = await import('../scripts/posix-session-supervisor.js');
  for (const quota of ['count', 'bytes']) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), `easyboost-posix-${quota}-quota-`));
    const directory = path.join(root, 'owned-control');
    const destination = path.join(directory, 'control.json');
    const temporary = path.join(root,
      '.owned-control.control.json.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.tmp');
    await fs.mkdir(directory, { mode: 0o700 });
    await fs.writeFile(temporary, 'must-remain-operational', { flag: 'wx', mode: 0o600 });
    const authority = posixPublicationRecoveryAuthority(destination, temporary);
    try {
      if (quota === 'count') {
        for (let index = 0; index < 1_024; index += 1) {
          const token = index.toString(16).padStart(64, '0');
          fsSync.writeFileSync(path.join(root,
            `.retained-${index}.cleanup.${token}.tombstone`), '', { flag: 'wx', mode: 0o600 });
        }
      } else {
        const retained = path.join(root,
          `.retained.cleanup.${'b'.repeat(64)}.tombstone`);
        const descriptor = fsSync.openSync(retained, 'wx', 0o600);
        try { fsSync.ftruncateSync(descriptor, 256 * 1024 * 1024); }
        finally { fsSync.closeSync(descriptor); }
      }
      assert.throws(() => supervisor.cleanupPosixSessionPublicationResidue(authority),
        (error) => errorTreeMessages(error).some((message) => /quota is exhausted/iu.test(message)));
      assert.equal(await fs.readFile(temporary, 'utf8'), 'must-remain-operational');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }
});

test('POSIX correlated publication replay cannot bypass a previously failed quota check',
  async () => {
    const supervisor = await import('../scripts/posix-session-supervisor.js');
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-posix-quota-replay-'));
    const directory = path.join(root, 'owned-control');
    const destination = path.join(directory, 'control.json');
    const temporary = path.join(root,
      '.owned-control.control.json.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.tmp');
    await fs.mkdir(directory, { mode: 0o700 });
    await fs.writeFile(temporary, 'must-remain-operational', { flag: 'wx', mode: 0o600 });
    const authority = posixPublicationRecoveryAuthority(destination, temporary);
    try {
      for (let index = 0; index < 1_024; index += 1) {
        const token = index.toString(16).padStart(64, '0');
        fsSync.writeFileSync(path.join(root,
          `.retained-${index}.cleanup.${token}.tombstone`), '', { flag: 'wx', mode: 0o600 });
      }
      for (let attempt = 0; attempt < 2; attempt += 1) {
        assert.throws(() => supervisor.cleanupPosixSessionPublicationResidue(authority),
          (error) => errorTreeMessages(error).some((message) =>
            /quota is exhausted/iu.test(message)));
      }
      assert.equal(await fs.readFile(temporary, 'utf8'), 'must-remain-operational');
      const slot = (await fs.readdir(root)).find((name) =>
        name.startsWith('.easyboost-staging-quarantine-slot.'));
      assert.ok(slot);
      assert.deepEqual(await fs.readdir(path.join(root, slot)), ['reservation.claim']);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

test('POSIX cleanup treats a concurrently visible empty fixed slot as occupied', async () => {
  const supervisor = await import('../scripts/posix-session-supervisor.js');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-posix-empty-slot-'));
  const directory = path.join(root, 'owned-control');
  const destination = path.join(directory, 'control.json');
  const temporary = path.join(root,
    '.owned-control.control.json.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.tmp');
  await fs.mkdir(directory, { mode: 0o700 });
  await fs.writeFile(temporary, 'must-remain-operational', { flag: 'wx', mode: 0o600 });
  const authority = posixPublicationRecoveryAuthority(destination, temporary);
  try {
    for (let index = 0; index < 1_024; index += 1) {
      const slotToken = createHash('sha256')
        .update(`easyboost-staging-quarantine-slot-v1\0${index}`).digest('hex');
      const tombstone = `.easyboost-staging-quarantine-slot.${slotToken}.tombstone`;
      const container = path.join(root, tombstone);
      fsSync.mkdirSync(container, { mode: 0o700 });
      if (index === 1_023) continue;
      const owner = (index + 1).toString(16).padStart(64, '0');
      fsSync.writeFileSync(path.join(container, 'reservation.claim'),
        `${JSON.stringify({
          bytes: 0,
          entries: 1,
          event: 'TOMBSTONE_RESERVATION',
          kind: 'file',
          owner,
          protocol: 'easyboost-posix-session-control-v2',
          purpose: 'cleanup',
          tombstone,
        })}\n`, { flag: 'wx', mode: 0o600 });
    }
    assert.throws(() => supervisor.cleanupPosixSessionPublicationResidue(authority),
      (error) => errorTreeMessages(error).some((message) =>
      /reservation namespace is exhausted/iu.test(message)));
    assert.equal(await fs.readFile(temporary, 'utf8'), 'must-remain-operational');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('POSIX quiescent maintenance reclaims an exact empty claimless slot after creator crash',
  async () => {
    const supervisor = await import('../scripts/posix-session-supervisor.js');
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-posix-empty-slot-reclaim-'));
    const directory = path.join(root, 'owned-control');
    const destination = path.join(directory, 'ready.proof');
    const temporary = path.join(root,
      '.owned-control.ready.proof.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.tmp');
    await fs.mkdir(directory, { mode: 0o700 });
    await fs.writeFile(temporary, 'owned private authority', { flag: 'wx', mode: 0o600 });
    const authority = posixPublicationRecoveryAuthority(destination, temporary);
    const correlation = createHash('sha256')
      .update(`easyboost-posix-publication-residue-v1\0${destination}\0${temporary}`, 'utf8')
      .digest('hex');
    const slot = Number.parseInt(correlation.slice(0, 8), 16) % 1_024;
    const slotToken = createHash('sha256')
      .update(`easyboost-staging-quarantine-slot-v1\0${slot}`, 'utf8').digest('hex');
    const claimless = path.join(root,
      `.easyboost-staging-quarantine-slot.${slotToken}.tombstone`);
    await fs.mkdir(claimless, { mode: 0o700 });
    const maintenance = posixQuiescentMaintenanceAuthority(supervisor, root);
    let reclaimed = null;
    try {
      assert.equal(supervisor.cleanupPosixSessionPublicationResidue(authority, {
        quiescentMaintenanceAuthority: maintenance,
        reclaimRetainedEvidence(request) {
          if (request.kind !== 'CLAIMLESS_RESERVATION') return false;
          reclaimed = request;
          assert.equal(request.container, claimless);
          assert.equal(request.payload, null);
          assert.deepEqual(fsSync.readdirSync(request.container), []);
          fsSync.rmdirSync(request.container);
          return true;
        },
      }), true);
      assert.ok(reclaimed);
      await assert.rejects(fs.access(temporary), { code: 'ENOENT' });
      const slots = (await fs.readdir(root)).filter((name) =>
        name.startsWith('.easyboost-staging-quarantine-slot.'));
      assert.equal(slots.length, 1);
      assert.deepEqual((await fs.readdir(path.join(root, slots[0]))).sort(),
        ['payload', 'reservation.claim', 'retained-source']);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

test('concurrent cleanup of one POSIX publication authority converges to one replayable slot',
  { timeout: 10_000 }, async () => {
    const supervisor = await import('../scripts/posix-session-supervisor.js');
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-posix-correlation-race-'));
    const directory = path.join(root, 'owned-control');
    const destination = path.join(directory, 'ready.proof');
    const temporary = path.join(root,
      '.owned-control.ready.proof.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.tmp');
    const barrier = path.join(root, 'barrier');
    await fs.mkdir(directory, { mode: 0o700 });
    await fs.mkdir(barrier, { mode: 0o700 });
    await fs.writeFile(temporary, Buffer.alloc(32, 0x41), { flag: 'wx', mode: 0o600 });
    const authority = posixPublicationRecoveryAuthority(destination, temporary);
    const moduleUrl = pathToFileURL(path.resolve('scripts/posix-session-supervisor.js')).href;
    const childSource = `
      import fs from 'node:fs';
      import path from 'node:path';
      const [moduleUrl, destination, temporary, sourceBindingValue, barrier, id] = process.argv.slice(1);
      const sourceBinding = JSON.parse(sourceBindingValue);
      const originalMkdir = fs.mkdirSync;
      const originalReaddir = fs.readdirSync;
      const originalRename = fs.renameSync;
      const pause = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
      const isSlot = (entry) => path.basename(String(entry))
        .startsWith('.easyboost-staging-quarantine-slot.');
      let firstSlotAttempt = true;
      fs.mkdirSync = function mkdirWithEmptyWindow(entry, options) {
        if (firstSlotAttempt && isSlot(entry)) {
          firstSlotAttempt = false;
          fs.writeFileSync(path.join(barrier, 'ready-' + id), '', { flag: 'wx' });
          while (originalReaddir.call(fs, barrier)
            .filter((name) => name.startsWith('ready-')).length < 2) pause();
          const result = originalMkdir.call(fs, entry, options);
          while (!fs.existsSync(path.join(barrier, 'empty-observed'))) pause();
          return result;
        }
        return originalMkdir.call(fs, entry, options);
      };
      fs.readdirSync = function observeEmptySlot(entry, options) {
        const names = originalReaddir.call(fs, entry, options);
        if (isSlot(entry) && names.length === 0) {
          try {
            fs.writeFileSync(path.join(barrier, 'empty-observed'), '', { flag: 'wx' });
          } catch (error) {
            if (error.code !== 'EEXIST') throw error;
          }
        }
        return names;
      };
      fs.renameSync = function synchronizePayloadMove(source, target) {
        if (source === temporary) {
          try {
            fs.writeFileSync(path.join(barrier, 'rename-' + id), '', { flag: 'wx' });
          } catch (error) {
            if (error.code !== 'EEXIST') throw error;
          }
          while (originalReaddir.call(fs, barrier)
            .filter((name) => name.startsWith('rename-')).length < 2) pause();
        }
        return originalRename.call(fs, source, target);
      };
      const { cleanupPosixSessionPublicationResidue: cleanup } = await import(
        moduleUrl + '?contender=' + id + '-' + Date.now()
      );
      try {
        cleanup({ destination, sourceBinding, temporary });
        process.stdout.write('success');
      } catch (error) {
        process.stdout.write('error:' + error.message);
      }
    `;
    const runContender = (id) => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [
        '--input-type=module', '-e', childSource,
        moduleUrl, destination, temporary, JSON.stringify(authority.sourceBinding), barrier, id,
      ], { env: { ...process.env, NODE_TEST_CONTEXT: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      const timeout = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`POSIX correlated cleanup contender ${id} exceeded its test deadline`));
      }, 5_000);
      timeout.unref();
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.once('error', (error) => { clearTimeout(timeout); reject(error); });
      child.once('close', (code, signal) => {
        clearTimeout(timeout);
        resolve({ code, signal, stderr: stderr.trim(), stdout: stdout.trim() });
      });
    });
    try {
      const outcomes = await Promise.all([runContender('a'), runContender('b')]);
      assert.ok(outcomes.every(({ code, signal }) => code === 0 && signal === null),
        JSON.stringify(outcomes));
      assert.equal(outcomes.filter(({ stdout }) => stdout === 'success').length, 1,
        JSON.stringify(outcomes));
      const slots = (await fs.readdir(root)).filter((name) => name.endsWith('.tombstone'));
      assert.equal(slots.length, 1,
        'same-authority contenders must never publish two correlated reservations');
      assert.deepEqual((await fs.readdir(path.join(root, slots[0]))).sort(),
        ['payload', 'reservation.claim']);
      assert.equal(supervisor.cleanupPosixSessionPublicationResidue(authority), true,
        'the original pre-crash authority must replay idempotently');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

test('POSIX fixed-slot reservations admit only one concurrent N-1 tombstone mover', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-posix-quota-race-'));
  const directory = path.join(root, 'owned-control');
  await fs.mkdir(directory, { mode: 0o700 });
  try {
    for (let index = 0; index < 1_023; index += 1) {
      const token = (index + 1).toString(16).padStart(64, '0');
      const slotToken = createHash('sha256')
        .update(`easyboost-staging-quarantine-slot-v1\0${index}`).digest('hex');
      const tombstone = `.easyboost-staging-quarantine-slot.${slotToken}.tombstone`;
      const container = path.join(root, tombstone);
      fsSync.mkdirSync(container, { mode: 0o700 });
      fsSync.writeFileSync(path.join(container, 'reservation.claim'),
      `${JSON.stringify({
        bytes: 0,
        entries: 1,
        event: 'TOMBSTONE_RESERVATION',
        kind: 'file',
        owner: token,
        protocol: 'easyboost-posix-session-control-v2',
        purpose: 'cleanup',
        tombstone,
      })}\n`, { flag: 'wx', mode: 0o600 });
    }
    const authorities = ['a', 'b'].map((suffix) => {
      const destination = path.join(directory, `control-${suffix}.json`);
      const temporary = path.join(root,
        `.owned-control.control-${suffix}.json.${suffix.repeat(32)}.tmp`);
      fsSync.writeFileSync(temporary, suffix, { flag: 'wx', mode: 0o600 });
      return posixPublicationRecoveryAuthority(destination, temporary);
    });
    const moduleUrl = pathToFileURL(path.resolve('scripts/posix-session-supervisor.js')).href;
    const childSource = `
      import { cleanupPosixSessionPublicationResidue as cleanup } from ${JSON.stringify(moduleUrl)};
      try {
        cleanup({
          destination: process.argv[1],
          sourceBinding: JSON.parse(process.argv[3]),
          temporary: process.argv[2],
        });
      } catch (error) {
        const messages = [];
        for (let current = error; current; current = current.cause) messages.push(current.message);
        if (messages.some((message) => /quota|reservation namespace/iu.test(message))) {
          process.exitCode = 23;
        } else {
          console.error(error?.stack ?? error);
          process.exitCode = 24;
        }
      }
    `;
    const run = ({ destination, sourceBinding, temporary }) => new Promise((resolve, reject) => {
      const child = spawn(process.execPath,
        [
          '--input-type=module', '-e', childSource,
          destination, temporary, JSON.stringify(sourceBinding),
        ], {
          stdio: ['ignore', 'ignore', 'pipe'],
        });
      let stderr = '';
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve({ code, signal, stderr }));
    });
    const outcomes = await Promise.all(authorities.map(run));
    assert.deepEqual(outcomes.map(({ code }) => code).sort((a, b) => a - b), [0, 23],
      outcomes.map(({ stderr }) => stderr).join('\n'));
    const names = await fs.readdir(root);
    assert.equal(names.filter((name) => name.endsWith('.tombstone')).length, 1_024);
    assert.equal(authorities.filter(({ temporary }) => fsSync.existsSync(temporary)).length, 2,
      'the admitted authority retains its pair and the rejected authority remains untouched');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('POSIX disposal returns retained tombstone authority after root durability fails', async () => {
  const supervisor = await import('../scripts/posix-session-supervisor.js');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-posix-retire-tombstone-'));
  let syncs = 0;
  const control = supervisor.createPosixSessionControl({
    controlKey: 'retire-tombstone-authority',
    controlRoot: root,
    syncControlRoot() {
      syncs += 1;
      if (syncs === 2) throw new Error('synthetic tombstone parent sync failure');
    },
  });
  try {
    let authority;
    assert.throws(() => control.dispose({ force: true }), (error) => {
      authority = error?.recoveryAuthority;
      return authority?.controlDirectory === control.specification.controlDirectory
        && typeof authority?.tombstone === 'string';
    });
    await fs.access(authority.tombstone);
    assert.equal(supervisor.cleanupPosixSessionRetirementTombstone(authority), true);
    await fs.access(authority.tombstone);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('POSIX retirement tombstone replay retries root durability without deleting evidence', async () => {
  const supervisor = await import('../scripts/posix-session-supervisor.js');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-posix-retire-sync-retry-'));
  const control = supervisor.createPosixSessionControl({
    controlKey: 'retire-tombstone-sync-retry', controlRoot: root,
  });
  try {
    const authority = control.dispose({ force: true });
    assert.throws(() => supervisor.cleanupPosixSessionRetirementTombstone(authority, {
      synchronizeDirectory() { throw new Error('synthetic retirement parent sync failure'); },
    }), /synthetic retirement parent sync failure/iu);
    await fs.access(authority.tombstone);
    assert.equal(supervisor.cleanupPosixSessionRetirementTombstone(authority), true);
    await fs.access(authority.tombstone);
    assert.throws(() => supervisor.cleanupPosixSessionRetirementTombstone({
      ...authority,
      tombstone: authority.tombstone.replace(/[a-f0-9]{64}\.tombstone$/u,
        `${'g'.repeat(64)}.tombstone`),
    }), /invalid|not exact/iu, 'retained evidence tokens must stay strict lowercase hex');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('POSIX parent-sync failure preserves the exact atomically published record for replay',
  async () => {
  const supervisor = await import('../scripts/posix-session-supervisor.js');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-posix-parent-sync-'));
  const directory = path.join(root, 'owned-session');
  const destination = path.join(directory, 'ready.proof');
  await fs.mkdir(directory);
  let destinationSyncs = 0;
  let recoveryAuthority;
  try {
    assert.throws(() => supervisor.writeDurablePosixSessionRecord(
      destination, '{"ready":true}\n', {
        randomToken: () => '3'.repeat(32),
        synchronizeDirectory(value) {
          if (value === directory && destinationSyncs++ === 0) {
            throw new Error('synthetic destination parent sync failure');
          }
        },
      },
    ), (error) => {
      recoveryAuthority = error.recoveryAuthority;
      return /synthetic destination parent sync failure/iu.test(error.message)
        && recoveryAuthority?.destination === destination;
    });
    assert.equal(destinationSyncs, 1, 'runtime must not pathname-delete a published record');
    assert.equal(await fs.readFile(destination, 'utf8'), '{"ready":true}\n');
    assert.equal(supervisor.cleanupPosixSessionPublicationResidue(recoveryAuthority), true);
    assert.deepEqual(await fs.readdir(directory), ['ready.proof']);
    assert.deepEqual((await fs.readdir(root)).sort(), ['owned-session']);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('POSIX durable publication moves but never deletes a last-window source replacement',
  async () => {
    const supervisor = await import('../scripts/posix-session-supervisor.js');
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-posix-writer-replace-'));
    const directory = path.join(root, 'owned-session');
    const destination = path.join(directory, 'ready.proof');
    const temporary = path.join(root,
      '.owned-session.ready.proof.44444444444444444444444444444444.tmp');
    const displaced = path.join(root, 'displaced-original');
    await fs.mkdir(directory);
    const filesystem = Object.create(fsSync);
    filesystem.renameSync = (source, target) => {
      assert.equal(source, temporary);
      assert.equal(target, destination);
      fsSync.renameSync(source, displaced);
      fsSync.writeFileSync(source, 'foreign replacement\n', { mode: 0o600 });
      fsSync.renameSync(source, target);
    };
    let recoveryAuthority;
    try {
      assert.throws(() => supervisor.writeDurablePosixSessionRecord(
        destination, '{"ready":true}\n', {
          filesystem,
          platform: 'win32',
          randomToken: () => '4'.repeat(32),
        },
      ), (error) => {
        recoveryAuthority = error.recoveryAuthority;
        return error?.code === 'POSIX_SESSION_PUBLICATION_CLEANUP_REQUIRED'
          && recoveryAuthority?.destination === destination
          && recoveryAuthority?.temporary === temporary;
      });
      assert.equal(await fs.readFile(displaced, 'utf8'), '{"ready":true}\n');
      assert.equal(await fs.readFile(destination, 'utf8'), 'foreign replacement\n');
      await assert.rejects(fs.access(temporary), { code: 'ENOENT' });
      assert.throws(() => supervisor.cleanupPosixSessionPublicationResidue(
        recoveryAuthority,
      ), (error) => /binding does not match/iu.test(error?.cause?.message ?? ''));
      assert.equal(await fs.readFile(displaced, 'utf8'), '{"ready":true}\n');
      assert.equal(await fs.readFile(destination, 'utf8'), 'foreign replacement\n');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

test('typed POSIX recovery retires an empty never-published control prefix', async () => {
  const supervisor = await import('../scripts/posix-session-supervisor.js');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-posix-empty-prefix-'));
  const controlKey = 'fixture-never-published-posix-control';
  const directory = path.join(root, createHash('sha256').update(controlKey).digest('hex'));
  await fs.mkdir(directory, { mode: 0o700 });
  try {
    const recovered = supervisor.recoverPosixSessionControl({
      controlKey,
      controlRoot: root,
      inspectSession() { throw new Error('an unpublished control has no numeric session to inspect'); },
      permitIncompleteRetirement: true,
    });
    assert.deepEqual(recovered, { absence: 'absent', state: 'incomplete' });
    await assert.rejects(fs.access(directory), { code: 'ENOENT' });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('typed POSIX recovery proves a deterministic session authority was never created',
  async () => {
    const supervisor = await import('../scripts/posix-session-supervisor.js');
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-posix-not-created-'));
    const controlKey = 'fixture-never-created-posix-control';
    let inspected = false;
    try {
      const recovered = supervisor.recoverPosixSessionControl({
        controlKey,
        controlRoot: root,
        inspectSession() { inspected = true; throw new Error('no READY identity exists to inspect'); },
        permitIncompleteRetirement: true,
        retire: false,
      });
      assert.deepEqual(recovered, { absence: 'absent', state: 'not-created' });
      assert.equal(inspected, false, 'no numeric session may be inferred from an absent authority');
      assert.equal(supervisor.hasPosixSessionRecoveryProof(recovered.recoveryProof, controlKey), true);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

test('POSIX recovery durably reserves missing and empty pre-control authorities before proof',
  async () => {
    const supervisor = await import('../scripts/posix-session-supervisor.js');
    for (const initial of ['missing', 'empty']) {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), `easyboost-posix-${initial}-claim-`));
      const controlKey = `fixture-${initial}-startup-reservation`;
      const directory = path.join(root, createHash('sha256').update(controlKey).digest('hex'));
      try {
        if (initial === 'empty') await fs.mkdir(directory, { mode: 0o700 });
        const recovered = supervisor.recoverPosixSessionControl({
          controlKey,
          controlRoot: root,
          permitIncompleteRetirement: true,
          recoveryScope: 'fixture-deadline-authority',
          retire: false,
        });
        assert.deepEqual(recovered, {
          absence: 'absent', state: initial === 'missing' ? 'not-created' : 'incomplete',
        });
        assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, 'startup.claim'), 'utf8')), {
          event: 'STARTUP_CLAIM', kind: 'RECOVERY', protocol: 'easyboost-posix-session-settled-v1',
        });
        assert.equal(supervisor.consumePosixSessionRecoveryProof(recovered.recoveryProof, {
          controlKey, controlRoot: root, recoveryScope: 'fixture-deadline-authority',
        }), true, 'semantic absence is issued only for the durable no-replace reservation');
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    }
  });

test('an empty-read recovery proof rejects creator control publication before paired retirement',
  async () => {
    const supervisor = await import('../scripts/posix-session-supervisor.js');
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-posix-empty-read-race-'));
    const seedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-posix-creator-seed-'));
    const controlKey = 'fixture-empty-read-creator-publication';
    const directory = path.join(root, createHash('sha256').update(controlKey).digest('hex'));
    try {
      await fs.mkdir(directory, { mode: 0o700 });
      const stale = supervisor.recoverPosixSessionControl({
        controlKey,
        controlRoot: root,
        permitIncompleteRetirement: true,
        recoveryScope: 'fixture-deadline-authority',
        retire: false,
      });
      const seed = supervisor.createPosixSessionControl({
        controlKey: 'fixture-creator-control-publication-seed', controlRoot: seedRoot,
      });
      const creatorRecord = { ...seed.specification, controlDirectory: directory };
      for (const [field, value] of Object.entries(creatorRecord)) {
        if (field.endsWith('Path') || field === 'controlFile') {
          creatorRecord[field] = path.join(directory, path.basename(value));
        }
      }
      await fs.writeFile(path.join(directory, 'control.json'), `${JSON.stringify(creatorRecord)}\n`, {
        flag: 'wx', mode: 0o600,
      });
      assert.equal(supervisor.consumePosixSessionRecoveryProof(stale.recoveryProof, {
        controlKey, controlRoot: root, recoveryScope: 'fixture-deadline-authority',
      }), false, 'the empty-read proof must not authorize a namespace changed by creator publication');
      assert.throws(() => supervisor.recoverPosixSessionControl({
        controlKey,
        controlRoot: root,
        permitIncompleteRetirement: true,
        recoveryScope: 'fixture-deadline-authority',
        retire: false,
      }), /RETIREMENT_CLAIM_REQUIRED|unknown record/iu,
      'a stale winner leaves an explicit manual-recovery boundary instead of letting a successor delete it');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
      await fs.rm(seedRoot, { recursive: true, force: true });
    }
  });

test('empty-read recovery fingerprints the canonical control-and-RECOVERY-claim race result',
  async () => {
    const supervisor = await import('../scripts/posix-session-supervisor.js');
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-posix-empty-read-pair-'));
    const seedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-posix-pair-seed-'));
    const controlKey = 'fixture-empty-read-control-pair';
    const directory = path.join(root, createHash('sha256').update(controlKey).digest('hex'));
    try {
      await fs.mkdir(directory, { mode: 0o700 });
      const seed = supervisor.createPosixSessionControl({
        controlKey: 'fixture-empty-read-control-pair-seed', controlRoot: seedRoot,
      });
      const recovered = supervisor.recoverPosixSessionControl({
        afterRecoveryStartupClaim({ controlDirectory }) {
          const creatorRecord = { ...seed.specification, controlDirectory };
          for (const [field, value] of Object.entries(creatorRecord)) {
            if (field.endsWith('Path') || field === 'controlFile') {
              creatorRecord[field] = path.join(controlDirectory, path.basename(value));
            }
          }
          fsSync.writeFileSync(path.join(controlDirectory, 'control.json'),
            `${JSON.stringify(creatorRecord)}\n`, { flag: 'wx', mode: 0o600 });
        },
        controlKey,
        controlRoot: root,
        permitIncompleteRetirement: true,
        recoveryScope: 'fixture-deadline-authority',
        retire: false,
      });
      assert.deepEqual(recovered, { absence: 'absent', state: 'incomplete' });
      assert.deepEqual((await fs.readdir(directory)).sort(), [
        'control.json', 'retirement.claim', 'startup.claim',
      ]);
      assert.equal(supervisor.consumePosixSessionRecoveryProof(recovered.recoveryProof, {
        controlKey, controlRoot: root, recoveryScope: 'fixture-deadline-authority',
      }), true);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
      await fs.rm(seedRoot, { recursive: true, force: true });
    }
  });

test('typed POSIX recovery retires an exact control-only prefix without inspecting a session',
  async () => {
    const supervisor = await import('../scripts/posix-session-supervisor.js');
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-posix-control-only-'));
    const controlKey = 'fixture-control-only-posix-control';
    try {
      const control = supervisor.createPosixSessionControl({ controlKey, controlRoot: root });
      let inspected = false;
      const recovered = supervisor.recoverPosixSessionControl({
        controlKey,
        controlRoot: root,
        inspectSession() { inspected = true; throw new Error('a READY-less prefix has no session identity'); },
        permitIncompleteRetirement: true,
      });
      assert.deepEqual(recovered, { absence: 'absent', state: 'incomplete' });
      assert.equal(inspected, false);
      await assert.rejects(fs.access(control.specification.controlDirectory), { code: 'ENOENT' });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

test('POSIX startup claim makes control-only recovery mutually exclusive with wrapper launch',
  async () => {
    const supervisor = await import('../scripts/posix-session-supervisor.js');
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-posix-startup-claim-'));
    const controlKey = 'fixture-atomic-startup-claim';
    try {
      const control = supervisor.createPosixSessionControl({ controlKey, controlRoot: root });
      const recovered = supervisor.recoverPosixSessionControl({
        controlKey,
        controlRoot: root,
        permitIncompleteRetirement: true,
        recoveryScope: 'fixture-deadline-authority-a',
        retire: false,
      });
      assert.deepEqual(recovered, { absence: 'absent', state: 'incomplete' });
      const claim = JSON.parse(await fs.readFile(
        control.specification.startupClaimPath, 'utf8',
      ));
      assert.equal(claim.kind, 'RECOVERY');
      assert.throws(() => supervisor.claimPosixSessionStartup(
        control.specification,
        {
          kind: 'LAUNCH',
          identity: {
            processGroupId: 8110, processId: 8110, sessionId: 8110, startTime: '44',
          },
        },
      ), /already claimed|recovery|destination already exists/iu,
      'a wrapper that loses the no-replace claim must abort before READY or target spawn');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

test('POSIX launch claim prevents a concurrent control-only retirement', async () => {
  const supervisor = await import('../scripts/posix-session-supervisor.js');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-posix-launch-claim-'));
  const controlKey = 'fixture-live-startup-claim';
  try {
    const control = supervisor.createPosixSessionControl({ controlKey, controlRoot: root });
    supervisor.claimPosixSessionStartup(control.specification, {
      kind: 'LAUNCH',
      identity: {
        processGroupId: 8120, processId: 8120, sessionId: 8120, startTime: '45',
      },
    });
    assert.throws(() => supervisor.recoverPosixSessionControl({
      controlKey,
      controlRoot: root,
      inspectSession: () => ({ state: 'alive' }),
      permitIncompleteRetirement: true,
    }), /cannot prove|alive|READY/iu);
    await fs.access(control.specification.controlDirectory);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('POSIX recovery proof is root-and-scope bound, authority-stable and single-use', async () => {
  const supervisor = await import('../scripts/posix-session-supervisor.js');
  const firstRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-posix-proof-a-'));
  const secondRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-posix-proof-b-'));
  const controlKey = 'fixture-bound-recovery-proof';
  try {
    const recovered = supervisor.recoverPosixSessionControl({
      controlKey,
      controlRoot: firstRoot,
      permitIncompleteRetirement: true,
      recoveryScope: 'fixture-deadline-authority-a',
      retire: false,
    });
    assert.equal(supervisor.consumePosixSessionRecoveryProof(recovered.recoveryProof, {
      controlKey,
      controlRoot: secondRoot,
      recoveryScope: 'fixture-deadline-authority-a',
    }), false, 'a proof from another empty root must not authorize this root');
    assert.equal(supervisor.consumePosixSessionRecoveryProof(recovered.recoveryProof, {
      controlKey,
      controlRoot: firstRoot,
      recoveryScope: 'fixture-deadline-authority-b',
    }), false, 'a proof must bind its paired deadline authority');
    const reservedDirectory = path.join(
      firstRoot, createHash('sha256').update(controlKey).digest('hex'),
    );
    await fs.writeFile(path.join(reservedDirectory, 'replacement-authority'), 'changed');
    assert.equal(supervisor.consumePosixSessionRecoveryProof(recovered.recoveryProof, {
      controlKey,
      controlRoot: firstRoot,
      recoveryScope: 'fixture-deadline-authority-a',
    }), false, 'a proof must reject any changed or newly created authority');
    await fs.rm(path.join(reservedDirectory, 'replacement-authority'));
    assert.equal(supervisor.consumePosixSessionRecoveryProof(recovered.recoveryProof, {
      controlKey,
      controlRoot: firstRoot,
      recoveryScope: 'fixture-deadline-authority-a',
    }), true);
    assert.equal(supervisor.consumePosixSessionRecoveryProof(recovered.recoveryProof, {
      controlKey,
      controlRoot: firstRoot,
      recoveryScope: 'fixture-deadline-authority-a',
    }), false, 'an accepted proof must be consumed atomically');
  } finally {
    await fs.rm(firstRoot, { recursive: true, force: true });
    await fs.rm(secondRoot, { recursive: true, force: true });
  }
});

test('typed POSIX session recovery retires only a drained exact owned session authority',
  async () => {
    const supervisor = await import('../scripts/posix-session-supervisor.js');
    const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-posix-recovery-'));
    const controlKey = 'fixture-drained-owned-session-recovery';
    try {
      const control = supervisor.createPosixSessionControl({
        controlKey, controlRoot: temporaryDirectory,
      });
      const { specification } = control;
      supervisor.claimPosixSessionStartup(specification, {
        kind: 'LAUNCH',
        identity: { processGroupId: 6100, processId: 6100, sessionId: 6100, startTime: '123' },
      });
      await fs.writeFile(specification.readyPath, `${JSON.stringify({
        event: 'READY', processGroupId: 6100,
        protocol: 'easyboost-posix-session-settled-v1', sessionId: 6100,
        // The wrapper publishes READY before spawning a target, so its durable
        // production-shape authority deliberately has no target PID yet.
        startTime: '123', targetPid: null, token: specification.proofToken, wrapperPid: 6100,
      })}\n`, { flag: 'wx' });
      await fs.writeFile(specification.proofPath, `${JSON.stringify({
        activeProcesses: 0, event: 'SESSION_DRAINED',
        protocol: 'easyboost-posix-session-settled-v1', token: specification.proofToken,
      })}\n`, { flag: 'wx' });
      await fs.writeFile(specification.statusPath, `${JSON.stringify({
        errorCode: null, event: 'TARGET_STATUS', exitCode: 0,
        protocol: 'easyboost-posix-session-settled-v1', signal: null, token: specification.proofToken,
      })}\n`, { flag: 'wx' });
      await fs.writeFile(specification.termRequestPath, `${JSON.stringify({
        protocol: 'easyboost-posix-session-control-v2', signal: 'SIGTERM',
        token: specification.controlToken,
      })}\n`, { flag: 'wx' });
      await fs.writeFile(specification.termAckPath, `${JSON.stringify({
        event: 'TERM_ACK', extra: true, protocol: 'easyboost-posix-session-settled-v1',
        token: specification.proofToken,
      })}\n`, { flag: 'wx' });
      assert.throws(() => supervisor.recoverPosixSessionControl({
        controlKey, controlRoot: temporaryDirectory, inspectSession: () => ({ state: 'absent' }),
      }), /record is invalid|acknowledgement/iu,
      'an acknowledgement with extra keys must retain the authority');
      await fs.rm(specification.termRequestPath);
      await fs.rm(specification.termAckPath);
      await fs.writeFile(specification.killArmedPath, `${JSON.stringify({
        event: 'KILL_ARMED', extra: true, protocol: 'easyboost-posix-session-settled-v1',
        reason: 'controller', token: specification.proofToken,
      })}\n`, { flag: 'wx' });
      assert.throws(() => supervisor.recoverPosixSessionControl({
        controlKey, controlRoot: temporaryDirectory, inspectSession: () => ({ state: 'absent' }),
      }), /record is invalid|settlement/iu,
      'an undecodable kill-arm proof must retain the authority');
      await fs.rm(specification.killArmedPath);
      const recovered = supervisor.recoverPosixSessionControl({
        controlKey,
        controlRoot: temporaryDirectory,
        inspectSession(identity) {
          assert.deepEqual(identity, { processGroupId: 6100, sessionId: 6100, startTime: '123' });
          return { state: 'absent' };
        },
      });
      assert.deepEqual(recovered, { processGroupId: 6100, sessionId: 6100, state: 'absent' });
      await assert.rejects(fs.access(specification.controlDirectory), { code: 'ENOENT' });
    } finally {
      await fs.rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

test('POSIX recovery accepts target status plus internally armed group kill as exact settlement',
  async () => {
    const supervisor = await import('../scripts/posix-session-supervisor.js');
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-posix-kill-settlement-'));
    const controlKey = 'fixture-target-status-kill-settlement';
    try {
      const control = supervisor.createPosixSessionControl({ controlKey, controlRoot: root });
      const { specification } = control;
      supervisor.claimPosixSessionStartup(specification, {
        kind: 'LAUNCH',
        identity: { processGroupId: 6110, processId: 6110, sessionId: 6110, startTime: '126' },
      });
      await fs.writeFile(specification.readyPath, `${JSON.stringify({
        event: 'READY', processGroupId: 6110,
        protocol: 'easyboost-posix-session-settled-v1', sessionId: 6110,
        startTime: '126', targetPid: null, token: specification.proofToken, wrapperPid: 6110,
      })}\n`, { flag: 'wx' });
      await fs.writeFile(specification.statusPath, `${JSON.stringify({
        errorCode: null, event: 'TARGET_STATUS', exitCode: 0,
        protocol: 'easyboost-posix-session-settled-v1', signal: null,
        token: specification.proofToken,
      })}\n`, { flag: 'wx' });
      await fs.writeFile(specification.killArmedPath, `${JSON.stringify({
        event: 'KILL_ARMED', protocol: 'easyboost-posix-session-settled-v1',
        reason: 'target-closed', token: specification.proofToken,
      })}\n`, { flag: 'wx' });
      const recovered = supervisor.recoverPosixSessionControl({
        controlKey,
        controlRoot: root,
        inspectSession: () => ({ state: 'absent' }),
      });
      assert.deepEqual(recovered, { processGroupId: 6110, sessionId: 6110, state: 'absent' });
      await assert.rejects(fs.access(specification.controlDirectory), { code: 'ENOENT' });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

test('only session-proven recovery retires a canonical unresolved POSIX prefix',
  async () => {
    const supervisor = await import('../scripts/posix-session-supervisor.js');
    const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-posix-prefix-'));
    const controlKey = 'fixture-unresolved-owned-session-recovery';
    try {
      const control = supervisor.createPosixSessionControl({ controlKey, controlRoot: temporaryDirectory });
      const { specification } = control;
      supervisor.claimPosixSessionStartup(specification, {
        kind: 'LAUNCH',
        identity: { processGroupId: 6200, processId: 6200, sessionId: 6200, startTime: '124' },
      });
      await fs.writeFile(specification.readyPath, `${JSON.stringify({
        event: 'READY', processGroupId: 6200,
        protocol: 'easyboost-posix-session-settled-v1', sessionId: 6200,
        startTime: '124', targetPid: null, token: specification.proofToken, wrapperPid: 6200,
      })}\n`, { flag: 'wx' });
      await fs.writeFile(specification.termRequestPath, `${JSON.stringify({
        protocol: 'easyboost-posix-session-control-v2', signal: 'SIGTERM',
        token: specification.controlToken,
      })}\n`, { flag: 'wx' });
      assert.throws(() => supervisor.recoverPosixSessionControl({
        controlKey, controlRoot: temporaryDirectory, inspectSession: () => ({ state: 'absent' }),
      }), /session-proven/iu);
      await fs.access(specification.controlDirectory);
      let inspections = 0;
      const recovered = supervisor.recoverPosixSessionControl({
        controlKey,
        controlRoot: temporaryDirectory,
        permitIncompleteRetirement: true,
        inspectSession(identity) {
          inspections += 1;
          assert.deepEqual(identity, { processGroupId: 6200, sessionId: 6200, startTime: '124' });
          return { state: 'absent' };
        },
      });
      assert.deepEqual(recovered, {
        absence: 'absent', processGroupId: 6200, sessionId: 6200, state: 'incomplete',
      });
      assert.equal(inspections, 2, 'retirement needs two fresh owned-session absence proofs');
      await assert.rejects(fs.access(specification.controlDirectory), { code: 'ENOENT' });
    } finally {
      await fs.rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

test('POSIX session disposal retries parent durability without minting a second tombstone',
  async () => {
    const supervisor = await import('../scripts/posix-session-supervisor.js');
    const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-posix-fsync-'));
    let syncAttempts = 0;
    const syncFailure = new Error('synthetic control-root fsync failure');
    const control = supervisor.createPosixSessionControl({
      controlKey: 'fixture-parent-fsync-retry',
      controlRoot: temporaryDirectory,
      syncControlRoot() {
        syncAttempts += 1;
        if (syncAttempts === 2) throw syncFailure;
      },
    });
    try {
      let failure;
      assert.throws(() => control.dispose({ force: true }), (error) => {
        failure = error;
        return error === syncFailure && typeof error.recoveryAuthority?.tombstone === 'string';
      });
      const firstTombstone = failure.recoveryAuthority.tombstone;
      await fs.access(firstTombstone);
      assert.throws(() => control.request('SIGTERM'), /ENOENT|disposed/iu,
        'failed parent durability must not masquerade as a usable live controller');
      control.dispose({ force: true });
      assert.equal(syncAttempts, 3, 'retry must repeat the failed parent durability proof');
      assert.deepEqual((await fs.readdir(temporaryDirectory))
        .filter((name) => name.endsWith('.tombstone')), [path.basename(firstTombstone)],
      'retry must not mint another retained evidence authority');
    } finally {
      await fs.rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

test('POSIX wrapper durably publishes READY before it can spawn the target', async () => {
  const source = await fs.readFile('scripts/posix-session-supervisor.js', 'utf8');
  const startupClaim = source.indexOf("claimPosixSessionStartup(specification, { kind: 'LAUNCH'");
  const ready = source.indexOf("write(specification.readyPath, 'READY'");
  const targetSpawn = source.indexOf('target = spawn(payload.command');
  assert.ok(startupClaim >= 0 && ready > startupClaim && targetSpawn > ready,
    'the token-bound session authority must exist before target mutation can begin');
});

test('POSIX wrapper strips raw fd9 authority and gives targets only the sanitized chain',
  async () => {
    const source = await fs.readFile('scripts/posix-session-supervisor.js', 'utf8');
    const validation = source.indexOf('validateInheritedStagingNodeAuthority(');
    const rawDeletion = source.indexOf('delete process.env[STAGING_NODE_AUTHORITY_ENVIRONMENT]', validation);
    const targetEnvironment = source.indexOf('const targetEnvironment = { ...process.env }', rawDeletion);
    const targetSpawn = source.indexOf('target = spawn(payload.command', targetEnvironment);
    assert.ok(validation >= 0 && rawDeletion > validation && targetEnvironment > rawDeletion
      && targetSpawn > targetEnvironment);
    const targetBlock = source.slice(targetEnvironment, targetSpawn + 500);
    assert.match(targetBlock,
      /targetEnvironment\[STAGING_NODE_CHAIN_ENVIRONMENT\] = stagingNodeAuthority\.chain/u);
    assert.match(targetBlock,
      /delete targetEnvironment\[STAGING_NODE_AUTHORITY_ENVIRONMENT\]/u);
    assert.match(targetBlock,
      /delete targetEnvironment\[STAGING_QUIESCENT_MAINTENANCE_ENVIRONMENT\]/u);
    assert.match(targetBlock, /stdio: \['inherit', 'inherit', 'inherit'\]/u,
      'the target must inherit only fd0/fd1/fd2, never transaction fd9');
  });

test('real fd9 and sanitized-chain invocations stay on one descriptor-backed Node inode', {
  skip: process.platform !== 'linux' ? 'Linux /proc and bash are required' : false,
}, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-posix-node-chain-'));
  const nodeCopy = path.join(root, 'node');
  const moduleUrl = pathToFileURL(path.resolve('scripts/posix-session-supervisor.js')).href;
  try {
    await fs.copyFile(process.execPath, nodeCopy);
    await fs.chmod(nodeCopy, 0o555);
    const digest = createHash('sha256').update(await fs.readFile(nodeCopy)).digest('hex');
    const nestedSource = [
      "const supervisor = await import(process.env.EASYBOOST_TEST_MODULE);",
      "const control = supervisor.createPosixSessionControl({ controlKey: 'node-chain-nested', controlRoot: process.env.EASYBOOST_TEST_NESTED_ROOT });",
      "const invocation = supervisor.createPosixSessionInvocation('bash', ['-c', 'true'], process.cwd(), 100, process.env, control);",
      "const payload = JSON.parse(Buffer.from(invocation.args[2], 'base64').toString('utf8'));",
      "process.stdout.write(JSON.stringify({ chain: invocation.environment.EASYBOOST_STAGING_NODE_CHAIN_AUTHORITY, command: invocation.command, payloadSource: payload.nodeAuthority.source, raw: invocation.environment.EASYBOOST_STAGING_NODE_AUTHORITY ?? null }));",
      'control.dispose({ force: true });',
    ].join('\n');
    const runnerSource = [
      "const { spawnSync } = await import('node:child_process');",
      "const supervisor = await import(process.env.EASYBOOST_TEST_MODULE);",
      "const control = supervisor.createPosixSessionControl({ controlKey: 'node-chain-root', controlRoot: process.env.EASYBOOST_TEST_ROOT_CONTROL });",
      "const invocation = supervisor.createPosixSessionInvocation('bash', ['-c', 'true'], process.cwd(), 100, process.env, control);",
      "const payload = JSON.parse(Buffer.from(invocation.args[2], 'base64').toString('utf8'));",
      'const nestedEnvironment = { ...process.env, EASYBOOST_STAGING_NODE_COMMAND: invocation.command, EASYBOOST_STAGING_NODE_CHAIN_AUTHORITY: payload.nodeAuthority.chain };',
      'delete nestedEnvironment.EASYBOOST_STAGING_NODE_AUTHORITY;',
      "const nested = spawnSync(invocation.command, ['--input-type=module', '--eval', process.env.EASYBOOST_TEST_NESTED_SOURCE], { encoding: 'utf8', env: nestedEnvironment });",
      "if (nested.status !== 0) throw new Error(nested.stderr || 'nested descriptor-backed Node failed');",
      'process.stdout.write(JSON.stringify({ first: { chain: payload.nodeAuthority.chain, command: invocation.command, payloadSource: payload.nodeAuthority.source }, nested: JSON.parse(nested.stdout) }));',
      'control.dispose({ force: true });',
    ].join('\n');
    const shell = [
      'exec 9<"$EASYBOOST_TEST_NODE"',
      'export EASYBOOST_STAGING_NODE_AUTHORITY="easyboost-staging-node-authority-v1:9:$$:$EASYBOOST_TEST_DIGEST"',
      'exec "/proc/$$/fd/9" --input-type=module --eval "$EASYBOOST_TEST_RUNNER_SOURCE"',
    ].join('\n');
    const result = spawnSync('/bin/bash', ['--noprofile', '--norc', '-c', shell], {
      encoding: 'utf8',
      env: {
        ...process.env,
        EASYBOOST_TEST_DIGEST: digest,
        EASYBOOST_TEST_MODULE: moduleUrl,
        EASYBOOST_TEST_NESTED_ROOT: path.join(root, 'nested-control'),
        EASYBOOST_TEST_NESTED_SOURCE: nestedSource,
        EASYBOOST_TEST_NODE: nodeCopy,
        EASYBOOST_TEST_ROOT_CONTROL: path.join(root, 'root-control'),
        EASYBOOST_TEST_RUNNER_SOURCE: runnerSource,
      },
    });
    assert.equal(result.status, 0, result.stderr);
    const observed = JSON.parse(result.stdout);
    assert.equal(observed.first.command, observed.nested.command);
    assert.equal(observed.first.chain, observed.nested.chain);
    assert.equal(observed.first.payloadSource, 'descriptor');
    assert.equal(observed.nested.payloadSource, 'chain');
    assert.equal(observed.nested.raw, null);
    assert.match(observed.first.command, /^\/proc\/[1-9][0-9]*\/fd\/9$/u);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('POSIX wrapper settles a closed target by killing from inside its owned group', async () => {
  const source = await fs.readFile('scripts/posix-session-supervisor.js', 'utf8');
  const runtime = source.slice(
    source.indexOf('async function runSupervisor'),
    source.indexOf('const isMain'),
  );
  assert.match(runtime,
    /if \(targetClosed && !finishing\)[\s\S]{0,500}requestKill\('target-closed'\)/u,
    'a closed target must durably arm and signal KILL from group 0 before the wrapper closes');
  assert.doesNotMatch(runtime, /inspectOwnedPosixSessionMembers/u,
    'a /proc member snapshot must not authorize wrapper settlement');
  assert.doesNotMatch(runtime, /write\([^\n]+, 'SESSION_DRAINED'/u,
    'the wrapper cannot prove an exact excluding-self member count');
});

test('POSIX control never signals a reused group between TERM and KILL and fails closed',
  async () => {
    const supervisor = await import('../scripts/posix-session-supervisor.js');
    const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-posix-reuse-'));
    let inspections = 0;
    const control = supervisor.createPosixSessionControl({
      controlKey: 'fixture-reused-between-term-kill',
      controlRoot: temporaryDirectory,
      inspectSession() {
        inspections += 1;
        return { state: 'reused' };
      },
    });
    try {
      const { specification } = control;
      control.markWrapperSpawned();
      await fs.writeFile(specification.readyPath, `${JSON.stringify({
        event: 'READY',
        processGroupId: 4200,
        protocol: 'easyboost-posix-session-settled-v1',
        sessionId: 4200,
        startTime: '100',
        targetPid: 4201,
        token: specification.proofToken,
        wrapperPid: 4200,
      })}\n`, { flag: 'wx' });
      control.request('SIGTERM');
      control.request('SIGKILL');
      await fs.writeFile(specification.killArmedPath, `${JSON.stringify({
        event: 'KILL_ARMED',
        protocol: 'easyboost-posix-session-settled-v1',
        reason: 'controller',
        token: specification.proofToken,
      })}\n`, { flag: 'wx' });
      control.observeWrapperClose();
      const proof = control.proofState();
      assert.equal(proof.state, 'unknown');
      assert.match(proof.error.message, /reused/iu);
      assert.equal(inspections, 1);
      assert.throws(() => control.dispose({ force: true }), /FORCE_DISPOSE_FORBIDDEN/u,
        'foreign reuse must retain the exact durable recovery authority');
    } finally {
      await fs.rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

test('release command hard deadline escalates TERM to KILL for the complete process group', async () => {
  const { runBoundedReleaseCommand } = await import('../scripts/release-command-supervisor.js');
  const child = new EventEmitter();
  child.pid = 4242;
  const signals = [];
  let alive = true;

  await assert.rejects(runBoundedReleaseCommand('fake-release-command', [], {
    hardTimeoutMs: 10,
    inspectProcessGroup: inspectIsolatedProcessGroup(child.pid, () => alive),
    terminateGraceMs: 10,
    killGraceMs: 30,
    platform: 'linux',
    spawnProcess() { return child; },
    signalProcess(pid, signal) {
      if (signal === 0) {
        if (!alive) throw Object.assign(new Error('absent'), { code: 'ESRCH' });
        return;
      }
      signals.push([pid, signal]);
      if (signal === 'SIGKILL') {
        alive = false;
        queueMicrotask(() => child.emit('close', null, 'SIGKILL'));
      }
    },
  }), /hard deadline/iu);

  assert.deepEqual(signals.map(([, signal]) => signal), ['SIGTERM', 'SIGKILL']);
  assert.ok(signals.every(([numericTarget]) => numericTarget === undefined),
    'the compatibility fixture must not receive a numeric PID or PGID');
  assert.equal(child.listenerCount('error'), 0);
  assert.equal(child.listenerCount('close'), 0);
});

test('native POSIX termination uses only its authenticated session controller, never a numeric PID',
  async () => {
    const { runBoundedReleaseCommand } = await import('../scripts/release-command-supervisor.js');
    const wrapper = new EventEmitter();
    wrapper.pid = 4243;
    const requests = [];
    const numericSignals = [];
    let absent = false;
    let wrapperClosed = false;
    let disposed = false;
    const posixSessionControl = {
      dispose() { disposed = true; },
      observeWrapperClose() { wrapperClosed = true; },
      proofState() { return { state: absent && wrapperClosed ? 'absent' : 'alive' }; },
      request(signal) {
        requests.push(signal);
        if (signal === 'SIGKILL') {
          absent = true;
          queueMicrotask(() => wrapper.emit('close', 0, null));
        }
      },
      targetStatus() {
        return { exitCode: null, signal: 'SIGKILL', state: 'present' };
      },
    };

    await assert.rejects(runBoundedReleaseCommand('fake-release-command', [], {
      forcePosixSession: true,
      hardTimeoutMs: 10,
      killGraceMs: 30,
      platform: 'linux',
      posixSessionInvocation() {
        return { args: [], command: 'fixture-posix-wrapper', posixSessionControl };
      },
      signalProcess(...arguments_) {
        numericSignals.push(arguments_);
        throw new Error('external numeric signalling is forbidden');
      },
      spawnProcess() { return wrapper; },
      terminateGraceMs: 10,
    }), /hard deadline/iu);

    assert.deepEqual(requests, ['SIGTERM', 'SIGKILL']);
    assert.deepEqual(numericSignals, [],
      'the caller must never race a /proc check against numeric signal delivery');
    assert.equal(disposed, true, 'proven session control must be removed before return');
  });

test('release command consumes canonical POSIX writer egress and retains exact publication recovery',
  async () => {
    const release = await import('../scripts/release-command-supervisor.js');
    const supervisor = await import('../scripts/posix-session-supervisor.js');
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-release-writer-egress-'));
    const owned = supervisor.createPosixSessionControl({
      controlKey: 'release-writer-egress', controlRoot: root,
    });
    const specification = owned.specification;
    const wrapper = new EventEmitter();
    wrapper.pid = 4244;
    wrapper.stdio = [null, null, null, new PassThrough()];
    let disposed = false;
    let spawnOptions;
    const control = {
      dispose() { disposed = true; },
      markWrapperSpawned() {},
      observeWrapperClose() {},
      proofState() { return { state: 'absent' }; },
      request() {},
      specification,
      targetStatus() {
        return { errorCode: null, exitCode: 0, signal: null, state: 'present' };
      },
    };
    const destination = specification.statusPath;
    const temporary = path.join(root,
      `.${path.basename(specification.controlDirectory)}.${path.basename(destination)}.${'a'.repeat(32)}.tmp`);
    const authority = Object.freeze({
      destination,
      sourceBinding: Object.freeze({
        birthtimeNs: '1', bytes: 7, ctimeNs: '2', dev: '3', gid: '4', ino: '5',
        mode: '33152', sha256: 'b'.repeat(64), uid: '6',
      }),
      temporary,
    });
    try {
      const execution = release.runBoundedReleaseCommand('fake-release-command', [], {
        forcePosixSession: true,
        hardTimeoutMs: 1_000,
        killGraceMs: 30,
        platform: 'linux',
        posixSessionControl: control,
        posixSessionInvocation() {
          return {
            args: [], command: 'fixture-posix-wrapper', posixSessionControl: control,
            writerEgress: {
              descriptor: supervisor.POSIX_SESSION_WRITER_EGRESS_FD,
              specification,
            },
          };
        },
        processObject: new EventEmitter(),
        spawnProcess(_command, _args, options) {
          spawnOptions = options;
          return wrapper;
        },
        terminateGraceMs: 10,
      });
      wrapper.stdio[3].end(supervisor.encodePosixSessionWriterRecovery(authority, specification));
      wrapper.emit('close', 0, null);
      await assert.rejects(execution, (error) => {
        assert.equal(error.childSettlementUnproven, true);
        assert.deepEqual(error.recoveryAuthority, {
          controlDirectory: specification.controlDirectory,
          publicationResidue: authority,
        });
        return true;
      });
      assert.equal(spawnOptions.stdio[3], 'pipe');
      assert.equal(disposed, false, 'publication residue must retain the controller for replay');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

test('release command accepts authenticated target success when the POSIX wrapper self-terminates',
  async () => {
    const release = await import('../scripts/release-command-supervisor.js');
    const supervisor = await import('../scripts/posix-session-supervisor.js');
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-release-wrapper-success-'));
    const owned = supervisor.createPosixSessionControl({
      controlKey: 'release-wrapper-success', controlRoot: root,
    });
    const specification = owned.specification;
    const wrapper = new EventEmitter();
    wrapper.pid = 4245;
    wrapper.stdio = [null, null, null, new PassThrough()];
    let disposed = false;
    const control = {
      dispose() { disposed = true; },
      markWrapperSpawned() {},
      observeWrapperClose() {},
      proofState() { return { state: 'absent' }; },
      request() {},
      specification,
      targetStatus() {
        return { errorCode: null, exitCode: 0, signal: null, state: 'present' };
      },
    };
    try {
      const execution = release.runBoundedReleaseCommand('fake-release-command', [], {
        forcePosixSession: true,
        hardTimeoutMs: 1_000,
        killGraceMs: 30,
        platform: 'linux',
        posixSessionControl: control,
        posixSessionInvocation() {
          return {
            args: [], command: 'fixture-posix-wrapper', posixSessionControl: control,
            writerEgress: {
              descriptor: supervisor.POSIX_SESSION_WRITER_EGRESS_FD,
              specification,
            },
          };
        },
        processObject: new EventEmitter(),
        spawnProcess() { return wrapper; },
        terminateGraceMs: 10,
      });
      wrapper.stdio[3].end();
      wrapper.emit('close', null, 'SIGKILL');
      assert.deepEqual(await execution, {
        status: 0, signal: null, stderr: '', stdout: '',
      });
      assert.equal(disposed, true);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

test('release command retains exact controller request publication recovery', async () => {
  const release = await import('../scripts/release-command-supervisor.js');
  const supervisor = await import('../scripts/posix-session-supervisor.js');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-release-request-residue-'));
  const owned = supervisor.createPosixSessionControl({
    controlKey: 'release-request-residue', controlRoot: root,
  });
  const specification = owned.specification;
  const temporary = path.join(root,
    `.${path.basename(specification.controlDirectory)}.${path.basename(specification.termRequestPath)}.${'c'.repeat(32)}.tmp`);
  await fs.writeFile(temporary, 'request authority', { flag: 'wx', mode: 0o600 });
  const publicationResidue = posixPublicationRecoveryAuthority(
    specification.termRequestPath, temporary,
  );
  const wrapper = new EventEmitter();
  wrapper.pid = 4246;
  wrapper.stdio = [null, null, null, new PassThrough()];
  let absent = false;
  const control = {
    dispose() {},
    markWrapperSpawned() {},
    observeWrapperClose() {},
    proofState() { return { state: absent ? 'absent' : 'alive' }; },
    request(signal) {
      if (signal === 'SIGTERM') {
        throw Object.assign(new Error('synthetic request publication failure'), {
          recoveryAuthority: publicationResidue,
        });
      }
      absent = true;
      queueMicrotask(() => wrapper.emit('close', null, 'SIGKILL'));
    },
    specification,
    targetStatus() {
      return { errorCode: null, exitCode: 0, signal: null, state: 'present' };
    },
  };
  try {
    const execution = release.runBoundedReleaseCommand('fake-release-command', [], {
      forcePosixSession: true,
      hardTimeoutMs: 5,
      killGraceMs: 30,
      platform: 'linux',
      posixSessionControl: control,
      posixSessionInvocation() {
        return {
          args: [], command: 'fixture-posix-wrapper', posixSessionControl: control,
          writerEgress: {
            descriptor: supervisor.POSIX_SESSION_WRITER_EGRESS_FD, specification,
          },
        };
      },
      processObject: new EventEmitter(),
      spawnProcess() { return wrapper; },
      terminateGraceMs: 5,
    });
    wrapper.stdio[3].end();
    await assert.rejects(execution, (error) => {
      assert.deepEqual(error.recoveryAuthority, {
        controlDirectory: specification.controlDirectory,
        publicationResidue,
      });
      return true;
    });
    assert.equal(await fs.readFile(temporary, 'utf8'), 'request authority');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('release command retains exact retirement-claim publication recovery from disposal',
  async () => {
    const release = await import('../scripts/release-command-supervisor.js');
    const supervisor = await import('../scripts/posix-session-supervisor.js');
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-release-claim-residue-'));
    const owned = supervisor.createPosixSessionControl({
      controlKey: 'release-claim-residue', controlRoot: root,
    });
    const specification = owned.specification;
    const destination = path.join(specification.controlDirectory, 'retirement.claim');
    const temporary = path.join(root,
      `.${path.basename(specification.controlDirectory)}.${path.basename(destination)}.${'d'.repeat(32)}.tmp`);
    await fs.writeFile(temporary, 'claim authority', { flag: 'wx', mode: 0o600 });
    const publicationResidue = posixPublicationRecoveryAuthority(destination, temporary);
    const wrapper = new EventEmitter();
    wrapper.pid = 4247;
    wrapper.stdio = [null, null, null, new PassThrough()];
    const control = {
      dispose() {
        throw Object.assign(new Error('synthetic claim publication failure'), {
          recoveryAuthority: publicationResidue,
        });
      },
      markWrapperSpawned() {},
      observeWrapperClose() {},
      proofState() { return { state: 'absent' }; },
      request() {},
      specification,
      targetStatus() {
        return { errorCode: null, exitCode: 0, signal: null, state: 'present' };
      },
    };
    try {
      const execution = release.runBoundedReleaseCommand('fake-release-command', [], {
        forcePosixSession: true,
        hardTimeoutMs: 1_000,
        killGraceMs: 30,
        platform: 'linux',
        posixSessionControl: control,
        posixSessionInvocation() {
          return {
            args: [], command: 'fixture-posix-wrapper', posixSessionControl: control,
            writerEgress: {
              descriptor: supervisor.POSIX_SESSION_WRITER_EGRESS_FD, specification,
            },
          };
        },
        processObject: new EventEmitter(),
        spawnProcess() { return wrapper; },
        terminateGraceMs: 10,
      });
      wrapper.stdio[3].end();
      wrapper.emit('close', null, 'SIGKILL');
      await assert.rejects(execution, (error) => {
        assert.deepEqual(error.recoveryAuthority, {
          controlDirectory: specification.controlDirectory,
          publicationResidue,
        });
        return true;
      });
      assert.equal(await fs.readFile(temporary, 'utf8'), 'claim authority');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

test('canonical Aisy E2E runner bounds and reaps every inventory child', async () => {
  const { runAisyReleaseE2e } = await import('../scripts/run-aisy-release-e2e.js');
  const child = new EventEmitter();
  child.pid = 4343;
  const signals = [];
  let alive = true;
  let spawnOptions;
  const lateSuccess = setTimeout(() => {
    if (alive) {
      alive = false;
      child.emit('exit', 0, null);
    }
  }, 80);

  try {
    await assert.rejects(runAisyReleaseE2e({
      files: ['e2e/fake-release-scenario.test.js'],
      report() {},
      spawn(command, args, options) {
        assert.equal(command, process.execPath);
        assert.deepEqual(args, ['e2e/fake-release-scenario.test.js']);
        spawnOptions = options;
        return child;
      },
      commandLifecycle: {
        hardTimeoutMs: 10,
        inspectProcessGroup: inspectIsolatedProcessGroup(child.pid, () => alive),
        terminateGraceMs: 10,
        killGraceMs: 30,
        platform: 'linux',
        signalProcess(pid, signal) {
          if (signal === 0) {
            if (!alive) throw Object.assign(new Error('absent'), { code: 'ESRCH' });
            return;
          }
          signals.push([pid, signal]);
          if (signal === 'SIGKILL') {
            alive = false;
            queueMicrotask(() => child.emit('close', null, 'SIGKILL'));
          }
        },
      },
    }), /hard deadline/iu);
  } finally {
    clearTimeout(lateSuccess);
  }

  assert.equal(spawnOptions.env.XAI_API_KEY, '');
  assert.equal(spawnOptions.detached, true);
  assert.deepEqual(signals.map(([, signal]) => signal), ['SIGTERM', 'SIGKILL']);
  assert.equal(child.listenerCount('exit'), 0,
    'the release runner must not keep a second unbounded exit promise');
  assert.equal(child.listenerCount('close'), 0);
});

test('predecessor git, tar and frontend commands use the bounded release lifecycle', async () => {
  const { runPredecessorCommand } = await import('../scripts/pwa-predecessor-compat.js');
  const child = new EventEmitter();
  child.pid = 4444;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const signals = [];
  let alive = true;

  await assert.rejects(Promise.resolve().then(() => runPredecessorCommand(
    'fake-predecessor-command', ['--fixture'], {
      captureOutput: true,
      hardTimeoutMs: 10,
      inspectProcessGroup: inspectIsolatedProcessGroup(child.pid, () => alive),
      terminateGraceMs: 10,
      killGraceMs: 30,
      platform: 'linux',
      spawnProcess() { return child; },
      signalProcess(pid, signal) {
        if (signal === 0) {
          if (!alive) throw Object.assign(new Error('absent'), { code: 'ESRCH' });
          return;
        }
        signals.push([pid, signal]);
        if (signal === 'SIGKILL') {
          alive = false;
          queueMicrotask(() => child.emit('close', null, 'SIGKILL'));
        }
      },
    },
  )), /hard deadline/iu);

  assert.deepEqual(signals.map(([, signal]) => signal), ['SIGTERM', 'SIGKILL']);
});

test('release command never sends KILL to a process group reused after TERM', async () => {
  const { runBoundedReleaseCommand } = await import('../scripts/release-command-supervisor.js');
  const child = new EventEmitter();
  child.pid = 4342;
  let originalGroupReused = false;
  let groupAlive = true;
  const deliveredSignals = [];
  const execution = runBoundedReleaseCommand('fake-release-command', [], {
    hardTimeoutMs: 100,
    inspectProcessGroup(_processGroupId, expectedIdentity) {
      if (!expectedIdentity) {
        return {
          identity: { leaderStartTime: '100', processGroupId: child.pid, sessionId: child.pid },
          state: 'alive',
        };
      }
      return { state: originalGroupReused ? 'reused' : 'alive' };
    },
    killGraceMs: 30,
    platform: 'linux',
    processObject: new EventEmitter(),
    signalProcess(processGroupId, signal) {
      if (signal === 0) {
        if (groupAlive) return;
        throw Object.assign(new Error('group absent'), { code: 'ESRCH' });
      }
      deliveredSignals.push([processGroupId, signal]);
      if (signal === 'SIGTERM') originalGroupReused = true;
      if (signal === 'SIGKILL') groupAlive = false;
    },
    spawnProcess: () => child,
    terminateGraceMs: 10,
  });

  queueMicrotask(() => child.emit('close', 0, null));
  await assert.rejects(execution, /left a descendant process group/iu);
  assert.deepEqual(deliveredSignals, [[undefined, 'SIGTERM']],
    'the recycled numeric process group must never receive SIGKILL');
});

test('release command cleans only residual members of its captured original session', async () => {
  const { runBoundedReleaseCommand } = await import('../scripts/release-command-supervisor.js');
  const child = new EventEmitter();
  child.pid = 4442;
  const identity = Object.freeze({
    leaderStartTime: '200',
    processGroupId: child.pid,
    sessionId: child.pid,
  });
  let residualAlive = true;
  const deliveredSignals = [];
  const inspectedIdentities = [];
  const execution = runBoundedReleaseCommand('fake-residual-release-command', [], {
    hardTimeoutMs: 1_000,
    inspectProcessGroup(_processGroupId, expectedIdentity) {
      if (!expectedIdentity) return { identity, state: 'alive' };
      inspectedIdentities.push(expectedIdentity);
      return { state: residualAlive ? 'alive' : 'absent' };
    },
    killGraceMs: 30,
    platform: 'linux',
    processObject: new EventEmitter(),
    signalProcess(processGroupId, signal) {
      deliveredSignals.push([processGroupId, signal]);
      if (signal === 'SIGTERM') residualAlive = false;
    },
    spawnProcess: () => child,
    terminateGraceMs: 10,
  });
  queueMicrotask(() => child.emit('close', 0, null));

  await assert.rejects(execution, /left a descendant process group/iu);
  assert.deepEqual(deliveredSignals, [[undefined, 'SIGTERM']]);
  assert.ok(inspectedIdentities.length >= 2);
  for (const observed of inspectedIdentities) assert.deepEqual(observed, identity);
});

test('release command never signals when POSIX birth/session capture is ambiguous', async () => {
  const { runBoundedReleaseCommand } = await import('../scripts/release-command-supervisor.js');
  const child = new EventEmitter();
  child.pid = 4443;
  const captureFailure = new Error('synthetic release /proc identity ambiguity');
  const deliveredSignals = [];
  const execution = runBoundedReleaseCommand('fake-ambiguous-release-command', [], {
    hardTimeoutMs: 1_000,
    inspectProcessGroup() { return { error: captureFailure, state: 'unknown' }; },
    killGraceMs: 20,
    platform: 'linux',
    processObject: new EventEmitter(),
    signalProcess(...call) { deliveredSignals.push(call); },
    spawnProcess: () => child,
    terminateGraceMs: 10,
  });
  queueMicrotask(() => child.emit('close', 0, null));

  await assert.rejects(execution, (error) => {
    assert.match(errorTreeMessages(error).join(' '), /identity ambiguity|identity.*proven/iu);
    return true;
  });
  assert.deepEqual(deliveredSignals, []);
});

test('captured release output has a hard byte cap and aborts the child lifecycle', async () => {
  const { runBoundedReleaseCommand } = await import('../scripts/release-command-supervisor.js');
  const child = new EventEmitter();
  child.pid = 4545;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const signals = [];
  let alive = true;
  queueMicrotask(() => child.stdout.write(Buffer.alloc(17, 0x61)));

  await assert.rejects(runBoundedReleaseCommand('fake-output-command', [], {
    captureOutput: true,
    hardTimeoutMs: 1_000,
    inspectProcessGroup: inspectIsolatedProcessGroup(child.pid, () => alive),
    terminateGraceMs: 10,
    killGraceMs: 30,
    maxOutputBytes: 16,
    platform: 'linux',
    spawnProcess() { return child; },
    signalProcess(pid, signal) {
      if (signal === 0) {
        if (!alive) throw Object.assign(new Error('absent'), { code: 'ESRCH' });
        return;
      }
      signals.push([pid, signal]);
      if (signal === 'SIGKILL') {
        alive = false;
        queueMicrotask(() => child.emit('close', null, 'SIGKILL'));
      }
    },
  }), /output exceeded.*byte limit/iu);
  assert.deepEqual(signals.map(([, signal]) => signal), ['SIGTERM', 'SIGKILL']);
});

test('captured stream failure is primary and still reaches bounded group reap', async () => {
  const { runBoundedReleaseCommand } = await import('../scripts/release-command-supervisor.js');
  const child = new EventEmitter();
  child.pid = 4646;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  let alive = true;
  queueMicrotask(() => child.stderr.destroy(new Error('synthetic pipe abort')));

  await assert.rejects(runBoundedReleaseCommand('fake-stream-command', [], {
    captureOutput: true,
    hardTimeoutMs: 1_000,
    inspectProcessGroup: inspectIsolatedProcessGroup(child.pid, () => alive),
    terminateGraceMs: 10,
    killGraceMs: 30,
    platform: 'linux',
    spawnProcess() { return child; },
    signalProcess(_pid, signal) {
      if (signal === 0) {
        if (!alive) throw Object.assign(new Error('absent'), { code: 'ESRCH' });
        return;
      }
      if (signal === 'SIGKILL') {
        alive = false;
        queueMicrotask(() => child.emit('close', null, 'SIGKILL'));
      }
    },
  }), /stderr stream failed/iu);
});

test('release command observes every asynchronous child error until close', async () => {
  const { runBoundedReleaseCommand } = await import('../scripts/release-command-supervisor.js');
  const child = new EventEmitter();
  child.pid = 4696;
  let alive = true;
  const firstFailure = new Error('synthetic first async child failure');
  const secondFailure = new Error('synthetic second async child failure');
  const execution = runBoundedReleaseCommand('fake-async-error-command', [], {
    hardTimeoutMs: 1_000,
    inspectProcessGroup: inspectIsolatedProcessGroup(child.pid, () => alive),
    killGraceMs: 30,
    platform: 'linux',
    processObject: new EventEmitter(),
    signalProcess(_pid, signal) {
      if (signal === 'SIGKILL') {
        alive = false;
        queueMicrotask(() => child.emit('close', null, 'SIGKILL'));
      }
    },
    spawnProcess: () => child,
    terminateGraceMs: 10,
  });

  child.emit('error', firstFailure);
  assert.doesNotThrow(() => child.emit('error', secondFailure));
  await assert.rejects(execution, (error) => {
    const messages = errorTreeMessages(error).join(' ');
    assert.match(messages, /first async child failure/iu);
    assert.match(messages, /second async child failure/iu);
    return true;
  });
  assert.equal(child.listenerCount('error'), 0);
});

test('SIGKILL without an observed close produces a bounded explicit reap failure', async () => {
  const { runBoundedReleaseCommand } = await import('../scripts/release-command-supervisor.js');
  const child = new EventEmitter();
  child.pid = 4747;
  let alive = true;
  const started = Date.now();

  await assert.rejects(runBoundedReleaseCommand('fake-unreaped-command', [], {
    hardTimeoutMs: 10,
    inspectProcessGroup: inspectIsolatedProcessGroup(child.pid, () => alive),
    terminateGraceMs: 10,
    killGraceMs: 20,
    platform: 'linux',
    spawnProcess() { return child; },
    signalProcess(_pid, signal) {
      if (signal === 0) {
        if (!alive) throw Object.assign(new Error('absent'), { code: 'ESRCH' });
        return;
      }
      if (signal === 'SIGKILL') alive = false;
    },
  }), (error) => {
    assert.ok(error instanceof AggregateError, error?.stack);
    assert.match(error.errors[0].message, /hard deadline/iu);
    assert.match(error.errors[1].message, /close\/reap/iu);
    return true;
  });
  assert.ok(Date.now() - started < 300, 'unreaped child exceeded its own lifecycle bound');
});

test('command failure remains first when descendant cleanup also fails', async () => {
  const { runBoundedReleaseCommand } = await import('../scripts/release-command-supervisor.js');
  const child = new EventEmitter();
  child.pid = 4848;
  let alive = true;
  queueMicrotask(() => child.emit('close', 7, null));

  await assert.rejects(runBoundedReleaseCommand('fake-primary-command', [], {
    hardTimeoutMs: 1_000,
    inspectProcessGroup: inspectIsolatedProcessGroup(child.pid, () => alive),
    terminateGraceMs: 10,
    killGraceMs: 20,
    platform: 'linux',
    spawnProcess() { return child; },
    signalProcess(_pid, signal) {
      if (signal === 0) {
        if (!alive) throw Object.assign(new Error('absent'), { code: 'ESRCH' });
        return;
      }
      if (signal === 'SIGTERM') {
        throw Object.assign(new Error('synthetic TERM failure'), { code: 'EACCES' });
      }
      if (signal === 'SIGKILL') alive = false;
    },
  }), (error) => {
    assert.ok(error instanceof AggregateError, error?.stack);
    assert.match(error.message, /^release command failed \(status 7\);/u);
    assert.match(error.errors[0].message, /status 7/iu);
    assert.match(error.errors[1].message, /SIGTERM delivery failed/iu);
    return true;
  });
});

test('Windows timeout uses bounded taskkill tree escalation instead of leader-only kill', async () => {
  const { runBoundedReleaseCommand } = await import('../scripts/release-command-supervisor.js');
  const child = new EventEmitter();
  child.pid = 4949;
  const calls = [];

  await assert.rejects(runBoundedReleaseCommand('fake-windows-tree-command', [], {
    hardTimeoutMs: 10,
    terminateGraceMs: 10,
    killGraceMs: 20,
    platform: 'win32',
    spawnProcess() { return child; },
    windowsTreeKill(command, args, options) {
      calls.push({ args, command, options });
      if (args.includes('/F')) queueMicrotask(() => child.emit('close', null, 'SIGKILL'));
      return { status: 0 };
    },
  }), /hard deadline/iu);

  assert.deepEqual(calls.map(({ command, args }) => [command, args]), [
    ['taskkill.exe', ['/PID', '4949', '/T']],
    ['taskkill.exe', ['/PID', '4949', '/T', '/F']],
  ]);
  assert.equal(calls[0].options.timeout, 10);
  assert.equal(calls[1].options.timeout, 20);
});

test('already-closed Windows failure attempts TERM and KILL without waiting unused grace windows', async () => {
  const { runBoundedReleaseCommand } = await import('../scripts/release-command-supervisor.js');
  const child = new EventEmitter();
  child.pid = 5050;
  const calls = [];
  queueMicrotask(() => child.emit('close', 7, null));
  const started = Date.now();

  await assert.rejects(runBoundedReleaseCommand('fake-closed-windows-command', [], {
    hardTimeoutMs: 5_000,
    terminateGraceMs: 500,
    killGraceMs: 500,
    platform: 'win32',
    spawnProcess() { return child; },
    windowsTreeKill(_command, args) {
      calls.push(args);
      return { status: 128 };
    },
  }), (error) => {
    assert.ok(error instanceof AggregateError, error?.stack);
    assert.match(error.errors[0].message, /status 7/iu);
    return true;
  });

  assert.deepEqual(calls, [
    ['/PID', '5050', '/T'],
    ['/PID', '5050', '/T', '/F'],
  ]);
  assert.ok(Date.now() - started < 200,
    'a reaped leader must not spend grace windows waiting for a close already observed');
});

test('Windows leader success fails closed unless descendant settlement has exact proof', async () => {
  const { runBoundedReleaseCommand } = await import('../scripts/release-command-supervisor.js');
  const unprovenChild = new EventEmitter();
  unprovenChild.pid = 5151;
  const cleanupCalls = [];
  queueMicrotask(() => unprovenChild.emit('close', 0, null));
  await assert.rejects(runBoundedReleaseCommand('fake-unproven-windows-command', [], {
    hardTimeoutMs: 1_000,
    terminateGraceMs: 10,
    killGraceMs: 20,
    platform: 'win32',
    spawnProcess() { return unprovenChild; },
    windowsTreeKill(_command, args) {
      cleanupCalls.push(args);
      return { status: 0 };
    },
  }), /Windows.*descendant settlement.*not proven/iu);
  assert.deepEqual(cleanupCalls, [['/PID', '5151', '/T']],
    'an unproven success must still attempt bounded tree cleanup');

  const provenChild = new EventEmitter();
  provenChild.pid = 5252;
  queueMicrotask(() => provenChild.emit('close', 0, null));
  const outcome = await runBoundedReleaseCommand('fake-proven-windows-command', [], {
    hardTimeoutMs: 1_000,
    terminateGraceMs: 10,
    killGraceMs: 20,
    platform: 'win32',
    spawnProcess() { return provenChild; },
    windowsSettlementProof({ pid }) {
      assert.equal(pid, 5252);
      return { activeProcesses: 0, authority: 'easyboost-windows-job-v1' };
    },
  });
  assert.equal(outcome.status, 0);
});

test('native Windows Job invocation canonicalizes case-insensitive child environment aliases',
  async () => {
    const { createWindowsJobInvocation } = await import('../scripts/release-command-supervisor.js');
    const invocation = createWindowsJobInvocation(
      'fixture-command.exe', [], process.cwd(), 1_000,
      {
        ALPHA: 'first-alpha',
        alpha: 'last-alpha',
        PATH: 'first-path',
        Path: 'last-path',
        temp: 'first-temp',
        TEMP: 'last-temp',
      },
      { specification: { fixture: true } },
    );
    const encoded = invocation.environment.EASYBOOST_WINDOWS_JOB_TARGET_ENVIRONMENT;
    const payload = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
    const namesByFold = new Map();
    for (const entry of payload.entries) {
      const folded = entry.name.toLocaleUpperCase('en-US');
      assert.equal(namesByFold.has(folded), false,
        `Windows child environment contains duplicate alias ${entry.name}`);
      namesByFold.set(folded, entry);
    }
    assert.equal(namesByFold.get('ALPHA').value, 'last-alpha');
    assert.equal(namesByFold.get('PATH').value, 'last-path');
    assert.equal(namesByFold.get('TEMP').value, 'last-temp');
  });

test('explicit test seam resolves a nonzero child only after exact Windows settlement', async () => {
  const { runBoundedReleaseCommand } = await import('../scripts/release-command-supervisor.js');
  const child = new EventEmitter();
  child.pid = 5253;
  queueMicrotask(() => {
    child.emit('close', 70, null);
  });
  const outcome = await runBoundedReleaseCommand('fake-nonzero-windows-command', [], {
    hardTimeoutMs: 1_000,
    killGraceMs: 20,
    platform: 'win32',
    resolveNonZeroStatus: true,
    spawnProcess() { return child; },
    terminateGraceMs: 10,
    windowsSettlementProof({ pid }) {
      assert.equal(pid, 5253);
      return { activeProcesses: 0, authority: 'easyboost-windows-job-v1' };
    },
  });
  assert.deepEqual(outcome, {
    signal: null, status: 70, stderr: '', stdout: '',
  });
});

test('native Windows controller disposal failure rejects deterministically and stays retryable',
  async () => {
    const { runBoundedReleaseCommand } = await import('../scripts/release-command-supervisor.js');
    const child = new EventEmitter();
    child.pid = 5353;
    const disposalFailure = new Error('synthetic Windows Job control directory failure');
    let disposalAttempts = 0;
    let disposed = false;
    const windowsJobControl = {
      dispose() {
        disposalAttempts += 1;
        if (disposalAttempts === 1) throw disposalFailure;
        disposed = true;
      },
      proofState() { return { state: 'absent' }; },
      request() {},
      specification: {},
    };
    const execution = runBoundedReleaseCommand('fake-native-windows-command', [], {
      forceWindowsJob: true,
      hardTimeoutMs: 1_000,
      killGraceMs: 20,
      platform: 'win32',
      processObject: new EventEmitter(),
      spawnProcess() { return child; },
      terminateGraceMs: 10,
      windowsJobInvocation() {
        return { args: [], command: 'fixture-wrapper', windowsJobControl };
      },
      windowsSettlementProof() {
        return { activeProcesses: 0, authority: 'easyboost-windows-job-v1' };
      },
    });
    queueMicrotask(() => child.emit('close', 0, null));

    await assert.rejects(execution, /Windows Job controller disposal failed/iu);
    assert.equal(disposalAttempts, 1);
    assert.equal(disposed, false);
    windowsJobControl.dispose();
    assert.equal(disposalAttempts, 2);
    assert.equal(disposed, true);
  });

test('native Windows persistent typed disposal failure preserves replayable recovery authority',
  async () => {
    const { runBoundedReleaseCommand } = await import('../scripts/release-command-supervisor.js');
    const child = new EventEmitter();
    child.pid = 5356;
    const recoveryAuthority = windowsJobRecoveryAuthorityFixture(
      path.join(os.tmpdir(), 'durable-release-disposal-root'), 'e',
    );
    const windowsJobControl = {
      dispose() {
        const failure = new Error('WINDOWS_JOB_RECOVERY_REQUIRED: fixture release disposal');
        failure.childSettlementUnproven = true;
        failure.code = 'WINDOWS_JOB_RECOVERY_REQUIRED';
        failure.recoveryAuthority = recoveryAuthority;
        throw failure;
      },
      proofState() { return { state: 'absent' }; },
      recoveryAuthority,
      request() {},
      specification: {},
    };
    const execution = runBoundedReleaseCommand('fake-native-windows-command', [], {
      forceWindowsJob: true,
      hardTimeoutMs: 1_000,
      killGraceMs: 20,
      platform: 'win32',
      processObject: new EventEmitter(),
      spawnProcess() { return child; },
      terminateGraceMs: 10,
      windowsJobInvocation() {
        return { args: [], command: 'fixture-wrapper', windowsJobControl };
      },
    });
    queueMicrotask(() => child.emit('close', 0, null));

    await assert.rejects(execution, (error) => {
      assert.equal(error.childSettlementUnproven, true);
      assert.deepEqual(JSON.parse(JSON.stringify(error.recoveryAuthority)), recoveryAuthority);
      return true;
    });
  });

test('native Windows spawn plus typed disposal failure preserves replayable recovery authority',
  async () => {
    const { runBoundedReleaseCommand } = await import('../scripts/release-command-supervisor.js');
    const recoveryAuthority = windowsJobRecoveryAuthorityFixture(
      path.join(os.tmpdir(), 'durable-release-spawn-root'), 'f',
    );
    const windowsJobControl = {
      dispose() {
        const failure = new Error('WINDOWS_JOB_RECOVERY_REQUIRED: fixture spawn disposal');
        failure.childSettlementUnproven = true;
        failure.code = 'WINDOWS_JOB_RECOVERY_REQUIRED';
        failure.recoveryAuthority = recoveryAuthority;
        throw failure;
      },
      proofState() { return { state: 'unknown' }; },
      recoveryAuthority,
      request() {},
      specification: {},
    };
    await assert.rejects(runBoundedReleaseCommand('fake-native-windows-command', [], {
      forceWindowsJob: true,
      hardTimeoutMs: 1_000,
      killGraceMs: 20,
      platform: 'win32',
      spawnProcess() { throw new Error('synthetic wrapper spawn failure'); },
      terminateGraceMs: 10,
      windowsJobInvocation() {
        return { args: [], command: 'fixture-wrapper', windowsJobControl };
      },
    }), (error) => {
      assert.equal(error.childSettlementUnproven, true);
      assert.deepEqual(JSON.parse(JSON.stringify(error.recoveryAuthority)), recoveryAuthority);
      return true;
    });
  });

test('closed native Windows wrapper without Job-empty proof retains its durable controller',
  async () => {
    const { runBoundedReleaseCommand } = await import('../scripts/release-command-supervisor.js');
    const child = new EventEmitter();
    child.pid = 5354;
    const requests = [];
    const disposalCalls = [];
    const windowsJobControl = {
      dispose(options) { disposalCalls.push(options); },
      proofState() { return { state: 'unknown' }; },
      request(signal) { requests.push(signal); },
      specification: {
        proofPath: path.join(os.tmpdir(), 'durable-closed-job', 'job-empty.proof'),
      },
    };
    const execution = runBoundedReleaseCommand('fake-native-windows-command', [], {
      forceWindowsJob: true,
      hardTimeoutMs: 1_000,
      killGraceMs: 20,
      platform: 'win32',
      processObject: new EventEmitter(),
      spawnProcess() { return child; },
      terminateGraceMs: 10,
      windowsJobInvocation() {
        return { args: [], command: 'fixture-wrapper', windowsJobControl };
      },
    });
    queueMicrotask(() => child.emit('close', 126, null));

    await assert.rejects(execution, (error) => {
      assert.equal(error.childSettlementUnproven, true);
      assert.match(errorTreeMessages(error).join(' '),
        /status 126|termination could not be proven|Job-empty settlement/iu);
      return true;
    });
    assert.deepEqual(requests, ['SIGTERM']);
    assert.deepEqual(disposalCalls, [],
      'unproven Job state must retain the restart guard and tokenized recovery controller');
  });

test('unresponsive native Windows wrapper returns typed unresolved state without deleting control',
  async () => {
    const { runBoundedReleaseCommand } = await import('../scripts/release-command-supervisor.js');
    const child = new EventEmitter();
    child.pid = 5355;
    child.unref = () => {};
    const requests = [];
    const disposalCalls = [];
    const windowsJobControl = {
      dispose(options) { disposalCalls.push(options); },
      proofState() { return { state: 'unknown' }; },
      request(signal) { requests.push(signal); },
      specification: { proofPath: path.join(os.tmpdir(), 'durable-job', 'job-empty.proof') },
    };
    const started = Date.now();
    await assert.rejects(runBoundedReleaseCommand('fake-native-windows-command', [], {
      forceWindowsJob: true,
      hardTimeoutMs: 5,
      killGraceMs: 10,
      platform: 'win32',
      processObject: new EventEmitter(),
      spawnProcess() { return child; },
      terminateGraceMs: 5,
      windowsJobInvocation() {
        return { args: [], command: 'fixture-wrapper', windowsJobControl };
      },
    }), (error) => {
      assert.equal(error.childSettlementUnproven, true);
      assert.equal(error.recoveryAuthority?.controlDirectory,
        path.join(os.tmpdir(), 'durable-job'));
      return true;
    });
    assert.ok(Date.now() - started < 250, 'typed unresolved return must retain a finite outer bound');
    assert.deepEqual(requests, ['SIGTERM', 'SIGKILL']);
    assert.deepEqual(disposalCalls, [], 'live controller must never be force-deleted');
    assert.equal(child.listenerCount('error'), 1,
      'a returned live wrapper must retain an error observer');
  });

test('native Windows spawn and controller disposal failures are both reported', async () => {
  const { runBoundedReleaseCommand } = await import('../scripts/release-command-supervisor.js');
  const spawnFailure = new Error('synthetic native wrapper spawn failure');
  const disposalFailure = new Error('synthetic native wrapper disposal failure');
  let disposalAttempts = 0;
  const windowsJobControl = {
    dispose() {
      disposalAttempts += 1;
      if (disposalAttempts === 1) throw disposalFailure;
    },
    proofState() { return { state: 'unknown' }; },
    request() {},
    specification: {},
  };
  await assert.rejects(runBoundedReleaseCommand('fake-native-windows-command', [], {
    forceWindowsJob: true,
    hardTimeoutMs: 1_000,
    killGraceMs: 20,
    platform: 'win32',
    spawnProcess() { throw spawnFailure; },
    terminateGraceMs: 10,
    windowsJobInvocation() {
      return { args: [], command: 'fixture-wrapper', windowsJobControl };
    },
  }), (error) => {
    assert.ok(error instanceof AggregateError, error?.stack);
    assert.match(error.errors[0].message, /could not start/iu);
    assert.equal(error.errors[0].cause, undefined,
      'the target spawn diagnostic must not expose the raw command or arguments');
    assert.match(error.errors[1].message, /controller disposal failed/iu);
    assert.equal(error.errors[1].cause, disposalFailure);
    return true;
  });
  assert.equal(disposalAttempts, 1);
  windowsJobControl.dispose();
  assert.equal(disposalAttempts, 2);
});

test('native Windows release commands are enclosed by a kill-on-close Job Object proof boundary',
  async () => {
    const [supervisor, productionBuilder, windowsJob] = await Promise.all([
      fs.readFile('scripts/release-command-supervisor.js', 'utf8'),
      fs.readFile('scripts/build-production-image.js', 'utf8'),
      fs.readFile('scripts/windows-job-supervisor.ps1', 'utf8'),
    ]);
    assert.match(supervisor, /windows-job-supervisor\.ps1/u);
    assert.match(supervisor, /easyboost-windows-job-v1/u);
    for (const token of [
      'CreateJobObject', 'JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE', 'CreateProcess',
      'CREATE_SUSPENDED', 'CREATE_UNICODE_ENVIRONMENT', 'AssignProcessToJobObject', 'ResumeThread',
      'QueryInformationJobObject', 'ActiveProcesses', 'TerminateJobObject',
      'HasControlRequest', 'FileMode.CreateNew', 'FileOptions.WriteThrough',
    ]) assert.match(windowsJob, new RegExp(token, 'u'), token);
    assert.match(windowsJob, /stream\.Flush\(true\)/u,
      'Job-empty proof must be flushed durably before wrapper exit');
    assert.match(supervisor, /proofState\(\)[\s\S]*expectedProof/u,
      'native success must require the exact private Job-empty proof');
    assert.doesNotMatch(supervisor,
      /nativeWindowsJob\s*\?\s*\{\s*activeProcesses:\s*0/u,
      'wrapper close must not synthesize Job-empty evidence');
    assert.match(productionBuilder, /nativeWindowsJob = platform === 'win32'/u,
      'the Docker stdin runner must share the native Windows Job Object boundary');
    assert.match(productionBuilder,
      /const windowsJobInvocation = lifecycle\.windowsJobInvocation \?\? createWindowsJobInvocation/u,
      'the production runner must retain an injectable native Job invocation seam');
  });

test('predecessor fixture commands are injectable and partial roots are removed on failure', async () => {
  const { buildExactPredecessorFixture } = await import('../scripts/pwa-predecessor-compat.js');
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'aisy-predecessor-project-'));
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'aisy-predecessor-temp-'));
  const calls = [];
  try {
    await fs.mkdir(path.join(project, 'node_modules'));
    const fixture = await buildExactPredecessorFixture({
      projectDirectory: project,
      temporaryDirectory: temporary,
      async runCommand(command, args, options) {
        calls.push({ args, command, options });
      },
    });
    assert.deepEqual(calls.map(({ command }) => command), ['git', 'tar', process.execPath]);
    assert.deepEqual(calls[0].args.slice(0, 3), [
      '-c', `safe.directory=${path.resolve(project).replaceAll('\\', '/')}`, 'archive',
    ], 'predecessor archive must trust only the exact release checkout for this command');
    assert.match(calls[0].options.commandLabel, /git archive/iu);
    assert.match(calls[1].options.commandLabel, /tar extraction/iu);
    assert.match(calls[2].options.commandLabel, /frontend build/iu);
    await fs.rm(fixture.rootDirectory, { recursive: true, force: true });

    const primary = new Error('synthetic archive timeout primary');
    await assert.rejects(buildExactPredecessorFixture({
      projectDirectory: project,
      temporaryDirectory: temporary,
      async runCommand() { throw primary; },
    }), (error) => error === primary);
    assert.deepEqual(await fs.readdir(temporary), [],
      'a failed or timed-out predecessor command must not leave a partial fixture');
  } finally {
    await fs.rm(project, { recursive: true, force: true });
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

test('hermetic frontend build receives the predecessor command supervisor dependency', async () => {
  const [dockerfile, predecessorSource] = await Promise.all([
    fs.readFile('Dockerfile', 'utf8'),
    fs.readFile('scripts/pwa-predecessor-compat.js', 'utf8'),
  ]);
  assert.match(predecessorSource,
    /from '\.\/release-command-supervisor\.js';/u);
  assert.doesNotMatch(predecessorSource, /spawnSync/u,
    'predecessor source/build commands must never use an unbounded synchronous child');
  const frontendStage = dockerfile.slice(
    dockerfile.indexOf('FROM ${EASYBOOST_NODE_BASE_IMAGE} AS frontend-build'),
    dockerfile.indexOf(
      '\nFROM ', dockerfile.indexOf('FROM ${EASYBOOST_NODE_BASE_IMAGE} AS frontend-build') + 1,
    ),
  );
  assert.match(frontendStage,
    /COPY scripts\/posix-session-supervisor\.js scripts\/release-command-supervisor\.js \.\/scripts\//u,
    'the hermetic frontend build must include every local import of predecessor compatibility');
});
