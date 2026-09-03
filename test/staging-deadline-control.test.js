import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Worker } from 'node:worker_threads';

import {
  STAGING_DEADLINE_PROTOCOL,
  STAGING_QUIESCENT_MAINTENANCE_DESCRIPTOR,
  STAGING_QUIESCENT_MAINTENANCE_PROTOCOL,
  awaitStagingDeadlineReady,
  cleanupStagingDeadlinePublicationResidue,
  cleanupStagingDeadlineRetirementTombstone,
  completeStagingDeadlineRecovery,
  createStagingDeadlineMailbox,
  createStagingDeadlineController,
  decodeStagingDeadlineAcknowledgement,
  decodeStagingDeadlineRequest,
  encodeStagingDeadlineAcknowledgement,
  encodeStagingDeadlineRequest,
  recoverStagingDeadlineMailbox,
  requestStagingDeadlineTransition,
  resumeStagingDeadlineRecoveryHandoff,
  writeDurableStagingDeadlineRecord,
} from '../scripts/staging-deadline-control.js';

const TOKEN = 'a'.repeat(64);

function terminalSlotPath(root, index = 0) {
  const token = createHash('sha256')
    .update(`easyboost-staging-quarantine-slot-v1\0${index}`)
    .digest('hex');
  return path.join(root, `.easyboost-staging-quarantine-slot.${token}.tombstone`);
}

function terminalSlotRecord({
  destination, purpose, source, sourceDev, sourceFingerprint, sourceIno,
}) {
  return {
    ...(purpose === 'PUBLICATION' ? { destination } : {}),
    owner: 'b'.repeat(64),
    protocol: 'easyboost-staging-deadline-terminal-slot-v1',
    purpose,
    source,
    ...(purpose === 'RETIREMENT' ? { sourceDev, sourceFingerprint, sourceIno } : {}),
  };
}

async function createTerminalSlot(root, index, record) {
  const container = terminalSlotPath(root, index);
  await fs.mkdir(container, { mode: 0o700 });
  await fs.writeFile(path.join(container, 'reservation.claim'),
    `${JSON.stringify(record)}\n`, { flag: 'wx', mode: 0o600 });
  return container;
}

function fixtureStatIdentity(stat) {
  return {
    dev: String(stat.dev),
    gid: String(stat.gid),
    ino: String(stat.ino),
    mode: String(stat.mode),
    nlink: String(stat.nlink),
    size: String(stat.size),
    uid: String(stat.uid),
  };
}

async function fixtureDeadlineNamespaceFingerprint(directory) {
  const directoryIdentity = await fs.lstat(directory, { bigint: true });
  const names = (await fs.readdir(directory)).sort();
  const records = [];
  for (const name of names) {
    const file = path.join(directory, name);
    const identity = await fs.lstat(file, { bigint: true });
    const bytes = await fs.readFile(file);
    records.push([name, fixtureStatIdentity(identity), bytes.toString('base64')]);
  }
  const signature = JSON.stringify({
    directory: fixtureStatIdentity(directoryIdentity),
    records,
  });
  return createHash('sha256').update(signature).digest('hex');
}

async function createRetirementTerminalSlot(root, index, source, initializePayload = async () => {}) {
  const container = terminalSlotPath(root, index);
  const payload = path.join(container, 'payload');
  await fs.mkdir(payload, { mode: 0o700, recursive: true });
  await initializePayload(payload);
  const sourceIdentity = await fs.lstat(payload);
  const record = terminalSlotRecord({
    purpose: 'RETIREMENT',
    source,
    sourceDev: String(sourceIdentity.dev),
    sourceFingerprint: await fixtureDeadlineNamespaceFingerprint(payload),
    sourceIno: String(sourceIdentity.ino),
  });
  await fs.writeFile(path.join(container, 'reservation.claim'),
    `${JSON.stringify(record)}\n`, { flag: 'wx', mode: 0o600 });
  return container;
}

function maintenanceAuthority(root) {
  const identity = fsSync.lstatSync(root);
  return Object.freeze({
    descriptor: STAGING_QUIESCENT_MAINTENANCE_DESCRIPTOR,
    lease: 'c'.repeat(64),
    ownerPid: process.pid,
    ownerStartTime: '1',
    protocol: STAGING_QUIESCENT_MAINTENANCE_PROTOCOL,
    rootDev: String(identity.dev),
    rootIno: String(identity.ino),
  });
}

function trustedTestReclaimer({
  container, containerIdentity, payload, payloadIdentity,
}) {
  const currentContainer = fsSync.lstatSync(container);
  const currentPayload = fsSync.lstatSync(payload);
  assert.deepEqual({ dev: String(currentContainer.dev), ino: String(currentContainer.ino) },
    containerIdentity);
  assert.deepEqual({ dev: String(currentPayload.dev), ino: String(currentPayload.ino) },
    payloadIdentity);
  fsSync.rmSync(container, { recursive: true });
  return true;
}

function errorChainMatches(error, pattern) {
  for (let current = error; current; current = current.cause) {
    if (pattern.test(current.message ?? '')) return true;
  }
  return false;
}

function request(sequence, action, seconds) {
  return {
    action,
    protocol: STAGING_DEADLINE_PROTOCOL,
    seconds,
    sequence,
    token: TOKEN,
  };
}

function deadlineReadyPath(recordPath) {
  return `${recordPath}.ready`;
}

async function ensureDeadlineReadyMarker(recordPath) {
  const markerPath = deadlineReadyPath(recordPath);
  let handle;
  try {
    handle = await fs.open(markerPath, 'wx', 0o600);
    await handle.sync();
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    const marker = await fs.lstat(markerPath);
    assert.equal(marker.isFile(), true);
    assert.equal(marker.isSymbolicLink(), false);
    assert.equal(marker.nlink, 1);
    assert.equal(marker.size, 0);
  } finally {
    await handle?.close();
  }
  return markerPath;
}

test('deadline durable publication uses one exclusive pathname and no cleanup mutation', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-deadline-publication-'));
  const directory = path.join(root, 'owned-deadline');
  const destination = path.join(directory, 'ack-0.json');
  await fs.mkdir(directory);
  let forbiddenMutations = 0;
  const filesystem = Object.create(fsSync);
  filesystem.linkSync = () => { forbiddenMutations += 1; };
  filesystem.unlinkSync = () => { forbiddenMutations += 1; };
  filesystem.rmSync = () => { forbiddenMutations += 1; };
  try {
    writeDurableStagingDeadlineRecord(destination, Buffer.from('{"ack":true}\n'), {
      filesystem, synchronizeDirectory() {},
    });
    assert.equal(await fs.readFile(destination, 'utf8'), '{"ack":true}\n');
    assert.equal(forbiddenMutations, 0);
    assert.deepEqual(await fs.readdir(directory), ['ack-0.json']);
    assert.deepEqual(await fs.readdir(root), ['owned-deadline']);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('deadline publication fsync ambiguity retains the direct journal authority', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-deadline-publication-authority-'));
  const directory = path.join(root, 'owned-deadline');
  const destination = path.join(directory, 'ack-0.json');
  await fs.mkdir(directory);
  try {
    assert.throws(() => writeDurableStagingDeadlineRecord(
      destination, Buffer.from('{"ack":true}\n'), {
        synchronizeDirectory() { throw new Error('synthetic destination sync failure'); },
      },
    ), (error) => assert.deepEqual(error?.recoveryAuthority,
      { controlDirectory: directory }) === undefined);
    assert.equal(await fs.readFile(destination, 'utf8'), '{"ack":true}\n');
    assert.deepEqual(await fs.readdir(root), ['owned-deadline']);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('deadline constructor retains exact private-publication recovery authority', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-deadline-constructor-residue-'));
  const controlKey = 'constructor-private-publication-residue';
  const directory = path.join(root, createHash('sha256').update(controlKey).digest('hex'));
  const destination = path.join(directory, 'control.json');
  const temporary = path.join(root, `.${path.basename(directory)}.control.json.${'1'.repeat(32)}.tmp`);
  const publication = new Error('synthetic private publication cleanup failure');
  publication.code = 'STAGING_DEADLINE_PUBLICATION_CLEANUP_REQUIRED';
  publication.recoveryAuthority = Object.freeze({ destination, temporary });
  try {
    assert.throws(() => createStagingDeadlineMailbox({
      controlKey,
      controlRoot: root,
      token: TOKEN,
      writeControlRecord() { throw publication; },
    }), (error) => error?.code === 'STAGING_DEADLINE_RECOVERY_REQUIRED'
      && assert.deepEqual(error.recoveryAuthority, { controlDirectory: directory, destination, temporary }) === undefined);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('deadline constructor round-trips an exact publication tombstone into typed cleanup',
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-deadline-constructor-tombstone-'));
    const controlKey = 'constructor-private-publication-tombstone';
    const directory = path.join(root, createHash('sha256').update(controlKey).digest('hex'));
    const destination = path.join(directory, 'control.json');
    const temporary = path.join(root,
      `.${path.basename(directory)}.control.json.${'2'.repeat(32)}.tmp`);
    const tombstone = terminalSlotPath(root, 0);
    const publication = new Error('synthetic quarantined publication cleanup failure');
    publication.code = 'STAGING_DEADLINE_PUBLICATION_CLEANUP_REQUIRED';
    publication.recoveryAuthority = Object.freeze({ destination, temporary, tombstone });
    let wrappedAuthority;
    try {
      assert.throws(() => createStagingDeadlineMailbox({
        controlKey,
        controlRoot: root,
        token: TOKEN,
        writeControlRecord() {
          fsSync.mkdirSync(tombstone, { mode: 0o700 });
          fsSync.writeFileSync(path.join(tombstone, 'reservation.claim'),
            `${JSON.stringify(terminalSlotRecord({
              destination, purpose: 'PUBLICATION', source: temporary,
            }))}\n`, { flag: 'wx', mode: 0o600 });
          fsSync.writeFileSync(path.join(tombstone, 'payload'),
            'private publication residue', { flag: 'wx', mode: 0o600 });
          throw publication;
        },
      }), (error) => {
        wrappedAuthority = error?.recoveryAuthority;
        return error?.code === 'STAGING_DEADLINE_RECOVERY_REQUIRED'
          && assert.deepEqual(wrappedAuthority, {
            controlDirectory: directory, destination, temporary, tombstone,
          }) === undefined;
      });
      const { controlDirectory, ...cleanupAuthority } = wrappedAuthority;
      assert.equal(controlDirectory, directory);
      assert.equal(cleanupStagingDeadlinePublicationResidue(cleanupAuthority), true);
      assert.equal(await fs.readFile(path.join(tombstone, 'payload'), 'utf8'),
        'private publication residue');
      assert.equal(cleanupStagingDeadlinePublicationResidue(cleanupAuthority), true);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

test('deadline private-publication cleanup rejects an ABA replacement before unlinking', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-deadline-residue-cleanup-'));
  const directory = path.join(root, 'owned-control');
  const destination = path.join(directory, 'control.json');
  const temporary = path.join(root, '.owned-control.control.json.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.tmp');
  await fs.mkdir(directory, { mode: 0o700 });
  await fs.writeFile(temporary, 'private authority', { flag: 'wx', mode: 0o600 });
  try {
    assert.throws(() => cleanupStagingDeadlinePublicationResidue({ destination, temporary }, {
      beforeUnlink() {
        fsSync.unlinkSync(temporary);
        fsSync.writeFileSync(temporary, 'successor', { flag: 'wx', mode: 0o600 });
      },
    }), /cleanup required|changed/iu);
    assert.equal(await fs.readFile(temporary, 'utf8'), 'successor');
    assert.equal((await fs.readdir(root)).filter((name) => name.endsWith('.tombstone')).length, 0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('deadline private-publication finalization never unlinks a tombstone successor', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-deadline-unlink-aba-'));
  const directory = path.join(root, 'owned-control');
  const destination = path.join(directory, 'control.json');
  const temporary = path.join(root, '.owned-control.control.json.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.tmp');
  await fs.mkdir(directory, { mode: 0o700 });
  await fs.writeFile(temporary, 'private authority', { flag: 'wx', mode: 0o600 });
  try {
    assert.equal(cleanupStagingDeadlinePublicationResidue({ destination, temporary }), true);
    const tombstoneName = (await fs.readdir(root)).find((name) => name.endsWith('.tombstone'));
    const tombstone = path.join(root, tombstoneName);
    assert.equal(cleanupStagingDeadlinePublicationResidue({ destination, temporary }), true,
      'the original authority must discover and replay its retained terminal tombstone');
    await fs.writeFile(temporary, 'operational-path successor', { flag: 'wx', mode: 0o600 });
    assert.throws(() => cleanupStagingDeadlinePublicationResidue({ destination, temporary }),
      /original publication residue path still exists|cleanup required/iu);
    assert.equal(await fs.readFile(temporary, 'utf8'), 'operational-path successor');
    await fs.unlink(temporary);
    const displaced = path.join(root, 'displaced-private-authority');
    assert.throws(() => cleanupStagingDeadlinePublicationResidue({
      destination, temporary, tombstone,
    }, {
      beforeUnlink() {
        fsSync.renameSync(tombstone, displaced);
        fsSync.mkdirSync(tombstone, { mode: 0o700 });
        fsSync.writeFileSync(path.join(tombstone, 'successor'), 'must-survive', {
          flag: 'wx', mode: 0o600,
        });
      },
    }), /changed|cleanup required/iu);
    assert.equal(await fs.readFile(path.join(tombstone, 'successor'), 'utf8'), 'must-survive');
    await assert.rejects(fs.access(temporary), { code: 'ENOENT' });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('deadline publication tombstone finalization retries root durability without unlinking',
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-deadline-cleanup-resync-'));
    const directory = path.join(root, 'owned-control');
    const destination = path.join(directory, 'control.json');
    const temporary = path.join(root,
      '.owned-control.control.json.bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.tmp');
    await fs.mkdir(directory, { mode: 0o700 });
    await fs.writeFile(temporary, 'private authority', { flag: 'wx', mode: 0o600 });
    try {
      let failure;
      let rootSynchronizations = 0;
      assert.throws(() => cleanupStagingDeadlinePublicationResidue({ destination, temporary }, {
        synchronizeDirectory(entry) {
          if (entry === root && (rootSynchronizations += 1) === 2) {
            throw new Error('synthetic root fsync failure');
          }
        },
      }), (error) => {
        failure = error;
        return error.code === 'STAGING_DEADLINE_PUBLICATION_CLEANUP_REQUIRED';
      });
      const authority = failure.recoveryAuthority;
      assert.equal(typeof authority.tombstone, 'string');
      assert.equal(await fs.readFile(path.join(authority.tombstone, 'payload'), 'utf8'),
        'private authority');
      const synchronized = [];
      assert.equal(cleanupStagingDeadlinePublicationResidue(authority, {
        synchronizeDirectory(entry) { synchronized.push(entry); },
      }), true);
      assert.deepEqual(synchronized, [authority.tombstone, root]);
      assert.equal(await fs.readFile(path.join(authority.tombstone, 'payload'), 'utf8'),
        'private authority');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

test('deadline retirement tombstone finalization retries root durability without removal',
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-deadline-retire-resync-'));
    const controlDirectory = path.join(root, 'owned-control');
    const tombstone = await createRetirementTerminalSlot(root, 0, controlDirectory);
    const authority = Object.freeze({ controlDirectory, tombstone });
    try {
      let failure;
      assert.throws(() => cleanupStagingDeadlineRetirementTombstone(authority, {
        synchronizeDirectory() { throw new Error('synthetic root fsync failure'); },
      }), (error) => {
        failure = error;
        return /fsync failure/iu.test(error.message);
      });
      assert.deepEqual(failure.recoveryAuthority, authority);
      await fs.access(tombstone);
      const synchronized = [];
      assert.equal(cleanupStagingDeadlineRetirementTombstone(authority, {
        synchronizeDirectory(entry) { synchronized.push(entry); },
      }), true);
      assert.deepEqual(synchronized, [tombstone, root]);
      await fs.access(tombstone);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

test('deadline retirement tombstone finalization never removes an ABA successor', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-deadline-retire-aba-'));
  const controlDirectory = path.join(root, 'owned-control');
  const tombstone = await createRetirementTerminalSlot(
    root,
    0,
    controlDirectory,
    (payload) => fs.writeFile(path.join(payload, 'control.json'), '{}\n', { mode: 0o600 }),
  );
  const displaced = path.join(root, 'displaced-retirement-tombstone');
  const authority = Object.freeze({ controlDirectory, tombstone });
  try {
    assert.throws(() => cleanupStagingDeadlineRetirementTombstone(authority, {
      beforeFinalize() {
        fsSync.renameSync(tombstone, displaced);
        fsSync.mkdirSync(tombstone, { mode: 0o700 });
        fsSync.writeFileSync(path.join(tombstone, 'successor'), 'must-survive', {
          flag: 'wx', mode: 0o600,
        });
      },
    }), /changed|ENOENT/iu);
    assert.equal(await fs.readFile(path.join(tombstone, 'successor'), 'utf8'), 'must-survive');
    await assert.rejects(fs.access(controlDirectory), { code: 'ENOENT' });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('deadline mailbox rejects a pre-existing unsafe control root before child creation', async (t) => {
  if (process.platform === 'win32') {
    t.skip('Windows has no portable POSIX owner/mode evidence');
    return;
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-unsafe-deadline-root-'));
  const controlKey = 'unsafe-root-must-not-create-child';
  const directory = path.join(root, createHash('sha256').update(controlKey).digest('hex'));
  try {
    await fs.chmod(root, 0o755);
    assert.throws(() => createStagingDeadlineMailbox({ controlKey, controlRoot: root, token: TOKEN }),
      /unsafe owner or mode/iu);
    await assert.rejects(fs.access(directory), { code: 'ENOENT' });
  } finally {
    await fs.chmod(root, 0o700);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('deadline mailbox rejects a symlinked control root before child creation', async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-symlink-deadline-root-'));
  const target = path.join(parent, 'target');
  const root = path.join(parent, 'root-link');
  const controlKey = 'symlink-root-must-not-create-child';
  const directory = path.join(target, createHash('sha256').update(controlKey).digest('hex'));
  await fs.mkdir(target);
  await fs.symlink(target, root, process.platform === 'win32' ? 'junction' : 'dir');
  try {
    assert.throws(() => createStagingDeadlineMailbox({ controlKey, controlRoot: root, token: TOKEN }),
      /real directory/iu);
    await assert.rejects(fs.access(directory), { code: 'ENOENT' });
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test('session-proven recovery retires an empty never-published deadline prefix', async () => {
  const posix = await import('../scripts/posix-session-supervisor.js');
  const transactionKey = 'fixture-never-published-deadline-control';
  const sessionKey = `staging-transaction:${transactionKey}`;
  const deadlineKey = `staging-deadline:${transactionKey}`;
  const sessionRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-empty-session-'));
  const deadlineRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-empty-deadline-'));
  const sessionDirectory = path.join(sessionRoot,
    createHash('sha256').update(sessionKey).digest('hex'));
  const deadlineDirectory = path.join(deadlineRoot,
    createHash('sha256').update(deadlineKey).digest('hex'));
  await fs.mkdir(sessionDirectory, { mode: 0o700 });
  await fs.mkdir(deadlineDirectory, { mode: 0o700 });
  try {
    const session = posix.recoverPosixSessionControl({
      controlKey: sessionKey,
      controlRoot: sessionRoot,
      permitIncompleteRetirement: true,
      recoveryScope: deadlineDirectory,
      retire: false,
    });
    const deadline = recoverStagingDeadlineMailbox({
      controlKey: deadlineKey,
      controlRoot: deadlineRoot,
      permitIncompleteRetirement: true,
      sessionControlRoot: sessionRoot,
      sessionRecoveryProof: session.recoveryProof,
    });
    assert.deepEqual(deadline, { state: 'incomplete' });
    await assert.rejects(fs.access(deadlineDirectory), { code: 'ENOENT' });
    await fs.mkdir(deadlineDirectory, { mode: 0o700 });
    assert.throws(() => recoverStagingDeadlineMailbox({
      controlKey: deadlineKey,
      controlRoot: deadlineRoot,
      permitIncompleteRetirement: true,
      sessionControlRoot: sessionRoot,
      sessionRecoveryProof: session.recoveryProof,
    }), /recovery authority is missing|incomplete/iu,
    'a consumed session proof must not retire a newly created deadline namespace');
    await fs.access(deadlineDirectory);
    await fs.rm(deadlineDirectory, { recursive: true });
    assert.equal(posix.completePosixSessionRecovery(session.recoveryProof, {
      controlKey: sessionKey,
      controlRoot: sessionRoot,
      recoveryScope: deadlineDirectory,
    }), true);
    await assert.rejects(fs.access(sessionDirectory), { code: 'ENOENT' });
  } finally {
    await fs.rm(sessionRoot, { recursive: true, force: true });
    await fs.rm(deadlineRoot, { recursive: true, force: true });
  }
});

test('missing deadline directory is root-synchronized before session proof consumption', async () => {
  const posix = await import('../scripts/posix-session-supervisor.js');
  const transactionKey = 'fixture-missing-deadline-root-durability';
  const sessionKey = `staging-transaction:${transactionKey}`;
  const deadlineKey = `staging-deadline:${transactionKey}`;
  const sessionRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-missing-deadline-session-'));
  const deadlineRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-missing-deadline-root-'));
  const deadlineDirectory = path.join(
    deadlineRoot, createHash('sha256').update(deadlineKey).digest('hex'),
  );
  try {
    const session = posix.recoverPosixSessionControl({
      controlKey: sessionKey,
      controlRoot: sessionRoot,
      permitIncompleteRetirement: true,
      recoveryScope: deadlineDirectory,
      retire: false,
    });
    assert.throws(() => recoverStagingDeadlineMailbox({
      controlKey: deadlineKey,
      controlRoot: deadlineRoot,
      permitIncompleteRetirement: true,
      sessionControlRoot: sessionRoot,
      sessionRecoveryProof: session.recoveryProof,
      syncControlRoot() { throw new Error('synthetic missing-directory root fsync failure'); },
    }), /root fsync failure/iu);
    assert.deepEqual(recoverStagingDeadlineMailbox({
      controlKey: deadlineKey,
      controlRoot: deadlineRoot,
      permitIncompleteRetirement: true,
      sessionControlRoot: sessionRoot,
      sessionRecoveryProof: session.recoveryProof,
      syncControlRoot() {},
    }), { state: 'not-created' });
    await assert.rejects(fs.access(deadlineDirectory), { code: 'ENOENT' });
    assert.equal(posix.completePosixSessionRecovery(session.recoveryProof, {
      controlKey: sessionKey,
      controlRoot: sessionRoot,
      recoveryScope: deadlineDirectory,
    }), true);
  } finally {
    await fs.rm(sessionRoot, { recursive: true, force: true });
    await fs.rm(deadlineRoot, { recursive: true, force: true });
  }
});

test('deadline recovery retains a new record added to an empty prefix at retirement', async () => {
  const posix = await import('../scripts/posix-session-supervisor.js');
  const transactionKey = 'fixture-late-empty-deadline-record';
  const sessionKey = `staging-transaction:${transactionKey}`;
  const deadlineKey = `staging-deadline:${transactionKey}`;
  const sessionRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-late-empty-session-'));
  const deadlineRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-late-empty-deadline-'));
  const deadlineDirectory = path.join(
    deadlineRoot, createHash('sha256').update(deadlineKey).digest('hex'),
  );
  await fs.mkdir(deadlineDirectory, { mode: 0o700 });
  try {
    const session = posix.recoverPosixSessionControl({
      controlKey: sessionKey,
      controlRoot: sessionRoot,
      permitIncompleteRetirement: true,
      recoveryScope: deadlineDirectory,
      retire: false,
    });
    assert.throws(() => recoverStagingDeadlineMailbox({
      beforeRetirementValidation() {
        fsSync.writeFileSync(path.join(deadlineDirectory, 'late-record.json'), '{"late":true}\n', {
          flag: 'wx',
        });
      },
      controlKey: deadlineKey,
      controlRoot: deadlineRoot,
      permitIncompleteRetirement: true,
      sessionControlRoot: sessionRoot,
      sessionRecoveryProof: session.recoveryProof,
    }), /changed|namespace|retirement/iu);
    assert.deepEqual(await fs.readdir(deadlineDirectory), ['late-record.json'],
      'source namespace substitution must fail before a retirement claim is published');
  } finally {
    await fs.rm(sessionRoot, { recursive: true, force: true });
    await fs.rm(deadlineRoot, { recursive: true, force: true });
  }
});

test('session-absence proof retires a control-only deadline prefix without weakening READY', async () => {
  const posix = await import('../scripts/posix-session-supervisor.js');
  const transactionKey = 'fixture-control-only-deadline-prefix';
  const sessionKey = `staging-transaction:${transactionKey}`;
  const deadlineKey = `staging-deadline:${transactionKey}`;
  const sessionRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-not-created-session-'));
  const deadlineRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-control-only-deadline-'));
  try {
    const mailbox = createStagingDeadlineMailbox({
      controlKey: deadlineKey,
      controlRoot: deadlineRoot,
      token: TOKEN,
    });
    const deadlineDirectory = mailbox.specification.controlDirectory;
    const session = posix.recoverPosixSessionControl({
      controlKey: sessionKey,
      controlRoot: sessionRoot,
      permitIncompleteRetirement: true,
      recoveryScope: deadlineDirectory,
      retire: false,
    });
    const retired = recoverStagingDeadlineMailbox({
      controlKey: deadlineKey,
      controlRoot: deadlineRoot,
      permitIncompleteRetirement: true,
      sessionControlRoot: sessionRoot,
      sessionRecoveryProof: session.recoveryProof,
    });
    assert.deepEqual(retired, { finalSequence: 0, state: 'incomplete' });
    await assert.rejects(fs.access(mailbox.specification.controlDirectory), { code: 'ENOENT' });
  } finally {
    await fs.rm(sessionRoot, { recursive: true, force: true });
    await fs.rm(deadlineRoot, { recursive: true, force: true });
  }
});

test('deadline recovery retains a late READY acknowledgement after consuming session proof',
  async () => {
    const posix = await import('../scripts/posix-session-supervisor.js');
    const transactionKey = 'fixture-late-ready-retirement';
    const sessionKey = `staging-transaction:${transactionKey}`;
    const deadlineKey = `staging-deadline:${transactionKey}`;
    const sessionRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-late-ready-session-'));
    const deadlineRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-late-ready-deadline-'));
    try {
      const mailbox = createStagingDeadlineMailbox({
        controlKey: deadlineKey,
        controlRoot: deadlineRoot,
        token: TOKEN,
      });
      const session = posix.recoverPosixSessionControl({
        controlKey: sessionKey,
        controlRoot: sessionRoot,
        permitIncompleteRetirement: true,
        recoveryScope: mailbox.specification.controlDirectory,
        retire: false,
      });
      let retirementBoundaries = 0;
      assert.throws(() => recoverStagingDeadlineMailbox({
        beforeRetirementValidation() {
          retirementBoundaries += 1;
          mailbox.acknowledge({
            protocol: STAGING_DEADLINE_PROTOCOL,
            seconds: 1_800,
            sequence: 0,
            state: 'TRANSACTION',
            token: TOKEN,
          });
        },
        controlKey: deadlineKey,
        controlRoot: deadlineRoot,
        permitIncompleteRetirement: true,
        sessionControlRoot: sessionRoot,
        sessionRecoveryProof: session.recoveryProof,
      }), /changed|namespace|retirement/iu);
      assert.equal(retirementBoundaries, 1);
      assert.deepEqual((await fs.readdir(mailbox.specification.controlDirectory)).sort(), [
        'ack-0.json', 'ack-0.json.ready', 'control.json',
      ]);
      assert.throws(() => recoverStagingDeadlineMailbox({
        controlKey: deadlineKey,
        controlRoot: deadlineRoot,
        permitIncompleteRetirement: true,
        sessionControlRoot: sessionRoot,
        sessionRecoveryProof: session.recoveryProof,
      }), /session-proven|incomplete|unknown record|RETIREMENT_CLAIM_REQUIRED/iu,
      'the consumed proof must not authorize a second retirement attempt');
    } finally {
      await fs.rm(sessionRoot, { recursive: true, force: true });
      await fs.rm(deadlineRoot, { recursive: true, force: true });
    }
  });

test('staging deadline transitions are authenticated, monotonic and atomically disarmed', () => {
  const timerEvents = [];
  let nextTimer = 0;
  const controller = createStagingDeadlineController({
    clearTimer(timer) { timerEvents.push(`clear:${timer.label}`); },
    recoverySeconds: 600,
    setTimer(callback, milliseconds, label) {
      const timer = { callback, id: ++nextTimer, label, milliseconds };
      timerEvents.push(`set:${label}:${milliseconds}`);
      return timer;
    },
    token: TOKEN,
    transactionSeconds: 1_800,
  });

  assert.throws(() => controller.transition(request(1, 'ROLLOVER', 600)), /not ready/iu);
  assert.deepEqual(controller.ready(), {
    protocol: STAGING_DEADLINE_PROTOCOL,
    seconds: 1_800,
    sequence: 0,
    state: 'TRANSACTION',
    token: TOKEN,
  });
  assert.deepEqual(controller.transition(request(1, 'ROLLOVER', 600)), {
    protocol: STAGING_DEADLINE_PROTOCOL,
    seconds: 600,
    sequence: 1,
    state: 'RECOVERY',
    token: TOKEN,
  });
  assert.deepEqual(timerEvents, [
    'set:transaction:1800000',
    'set:recovery:600000',
    'clear:transaction',
  ], 'the recovery timer must exist before the transaction deadline is retired');

  assert.throws(() => controller.transition(request(1, 'DISARM', 0)), /sequence/iu);
  assert.throws(() => controller.transition({
    ...request(2, 'DISARM', 0), token: 'b'.repeat(64),
  }), /token/iu);
  assert.equal(controller.state(), 'RECOVERY');

  assert.deepEqual(controller.transition(request(2, 'DISARM', 0)), {
    protocol: STAGING_DEADLINE_PROTOCOL,
    seconds: 0,
    sequence: 2,
    state: 'DISARMED',
    token: TOKEN,
  });
  assert.deepEqual(timerEvents.at(-1), 'clear:recovery');
  assert.throws(() => controller.transition(request(3, 'ROLLOVER', 600)), /disarmed/iu);
});

test('a failed rollover ACK keeps the prior deadline capable of terminating the owned session', () => {
  const timers = [];
  const expirations = [];
  const controller = createStagingDeadlineController({
    clearTimer(timer) {
      if (timer.label === 'transaction') throw new Error('transaction timer cannot be retired');
      timer.cleared = true;
    },
    onDeadline(expiration) { expirations.push(expiration); },
    recoverySeconds: 600,
    setTimer(callback, milliseconds, label) {
      const timer = { callback, cleared: false, label, milliseconds };
      timers.push(timer);
      return timer;
    },
    token: TOKEN,
    transactionSeconds: 1_800,
  });

  controller.ready();
  assert.throws(() => controller.transition(request(1, 'ROLLOVER', 600)),
    /cannot be retired/iu);
  assert.equal(controller.state(), 'UNPROVEN');
  timers[0].callback();
  assert.deepEqual(expirations, [{ sequence: 0, state: 'TRANSACTION' }],
    'failure to ACK rollover must not silently disable the still-live prior deadline');
});

test('staging deadline wire messages reject token, sequence and shape substitution', () => {
  const rollover = request(1, 'ROLLOVER', 600);
  const encodedRequest = encodeStagingDeadlineRequest(rollover);
  assert.deepEqual(decodeStagingDeadlineRequest(encodedRequest), rollover);

  const acknowledgement = {
    protocol: STAGING_DEADLINE_PROTOCOL,
    seconds: 600,
    sequence: 1,
    state: 'RECOVERY',
    token: TOKEN,
  };
  const encodedAcknowledgement = encodeStagingDeadlineAcknowledgement(acknowledgement);
  assert.deepEqual(decodeStagingDeadlineAcknowledgement(encodedAcknowledgement, {
    expectedSeconds: 600,
    expectedSequence: 1,
    expectedState: 'RECOVERY',
    expectedToken: TOKEN,
  }), acknowledgement);

  for (const tampered of [
    { ...acknowledgement, seconds: 601 },
    { ...acknowledgement, sequence: 2 },
    { ...acknowledgement, token: 'b'.repeat(64) },
    { ...acknowledgement, unexpected: true },
  ]) {
    assert.throws(() => decodeStagingDeadlineAcknowledgement(
      Buffer.from(`${JSON.stringify(tampered)}\n`),
      {
        expectedSeconds: 600,
        expectedSequence: 1,
        expectedState: 'RECOVERY',
        expectedToken: TOKEN,
      },
    ), /acknowledgement/iu);
  }
});

test('durable deadline mailbox returns only an exact authenticated acknowledgement', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-staging-deadline-mailbox-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const mailbox = createStagingDeadlineMailbox({ controlRoot: root, token: TOKEN });

  const pending = requestStagingDeadlineTransition({
    action: 'ROLLOVER',
    environmentValue: mailbox.environmentValue,
    pollMilliseconds: 2,
    seconds: 600,
    sequence: 1,
    timeoutMilliseconds: 500,
  });
  let observed;
  for (let attempt = 0; attempt < 100 && !observed; attempt += 1) {
    observed = mailbox.requestState(1).record;
    if (!observed) await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.deepEqual(observed, request(1, 'ROLLOVER', 600));
  mailbox.acknowledge({
    protocol: STAGING_DEADLINE_PROTOCOL,
    seconds: 600,
    sequence: 1,
    state: 'RECOVERY',
    token: TOKEN,
  });
  assert.deepEqual(await pending, {
    protocol: STAGING_DEADLINE_PROTOCOL,
    seconds: 600,
    sequence: 1,
    state: 'RECOVERY',
    token: TOKEN,
  });
  assert.deepEqual((await fs.readdir(mailbox.specification.controlDirectory)).sort(), [
    'ack-1.json', 'ack-1.json.ready', 'control.json',
    'request-1.json', 'request-1.json.ready',
  ], 'deadline publication must expose only exact record and ready-marker pairs');
});

test('deadline request remains unpublished while its durable record has no ready marker',
  async (context) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-deadline-request-ready-race-'));
    context.after(() => fs.rm(root, { recursive: true, force: true }));
    const mailbox = createStagingDeadlineMailbox({
      controlKey: 'deadline-request-ready-race', controlRoot: root, token: TOKEN,
    });
    const requestFile = path.join(mailbox.specification.controlDirectory, 'request-1.json');
    const bytes = encodeStagingDeadlineRequest(request(1, 'ROLLOVER', 600));
    const split = Math.floor(bytes.length / 2);
    const handle = await fs.open(requestFile, 'wx', 0o600);
    try {
      await handle.write(bytes, 0, split, 0);
      assert.equal(mailbox.requestState(1).state, 'missing',
        'a visible partial record is not published without its ready marker');
      await handle.write(bytes, split, bytes.length - split, split);
      await handle.sync();
    } finally {
      await handle.close();
    }
    assert.equal(mailbox.requestState(1).state, 'missing',
      'even complete durable bytes remain unpublished before the marker');
    await ensureDeadlineReadyMarker(requestFile);
    assert.deepEqual(mailbox.requestState(1), {
      record: request(1, 'ROLLOVER', 600), state: 'present',
    });
  });

test('deadline acknowledgement remains unpublished while its durable record has no ready marker',
  async (context) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-deadline-ack-ready-race-'));
    context.after(() => fs.rm(root, { recursive: true, force: true }));
    const mailbox = createStagingDeadlineMailbox({
      controlKey: 'deadline-ack-ready-race', controlRoot: root, token: TOKEN,
    });
    const acknowledgementRecord = {
      protocol: STAGING_DEADLINE_PROTOCOL,
      seconds: 1_800,
      sequence: 0,
      state: 'TRANSACTION',
      token: TOKEN,
    };
    const acknowledgementFile = path.join(mailbox.specification.controlDirectory, 'ack-0.json');
    const bytes = encodeStagingDeadlineAcknowledgement(acknowledgementRecord);
    let settled = false;
    const observed = awaitStagingDeadlineReady({
      environmentValue: mailbox.environmentValue,
      pollMilliseconds: 2,
      timeoutMilliseconds: 1_000,
      transactionSeconds: 1_800,
    }).then((value) => ({ value }), (error) => ({ error }));
    observed.then(() => { settled = true; });
    const split = Math.floor(bytes.length / 2);
    const handle = await fs.open(acknowledgementFile, 'wx', 0o600);
    try {
      await handle.write(bytes, 0, split, 0);
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(settled, false,
        'a visible partial acknowledgement is not published without its ready marker');
      await handle.write(bytes, split, bytes.length - split, split);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(settled, false,
      'complete acknowledgement bytes remain unpublished before the marker');
    await ensureDeadlineReadyMarker(acknowledgementFile);
    const result = await observed;
    assert.equal(result.error, undefined);
    assert.deepEqual(result.value, acknowledgementRecord);
  });

test('deadline ready marker validation fails closed for marker-only unsafe and invalid pairs',
  async (context) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-deadline-ready-invalid-'));
    context.after(() => fs.rm(root, { recursive: true, force: true }));

    const markerOnly = createStagingDeadlineMailbox({
      controlKey: 'deadline-marker-only', controlRoot: root, token: TOKEN,
    });
    const markerOnlyRecord = path.join(
      markerOnly.specification.controlDirectory, 'request-1.json',
    );
    await ensureDeadlineReadyMarker(markerOnlyRecord);
    assert.equal(markerOnly.requestState(1).state, 'unknown');

    const unsafe = createStagingDeadlineMailbox({
      controlKey: 'deadline-unsafe-marker', controlRoot: root, token: TOKEN,
    });
    const unsafeRecord = path.join(unsafe.specification.controlDirectory, 'request-1.json');
    await fs.writeFile(unsafeRecord, encodeStagingDeadlineRequest(request(1, 'ROLLOVER', 600)), {
      flag: 'wx', mode: 0o600,
    });
    await fs.writeFile(deadlineReadyPath(unsafeRecord), 'not-empty', { flag: 'wx', mode: 0o600 });
    assert.equal(unsafe.requestState(1).state, 'unknown');

    const invalid = createStagingDeadlineMailbox({
      controlKey: 'deadline-invalid-paired-record', controlRoot: root, token: TOKEN,
    });
    const invalidRecord = path.join(invalid.specification.controlDirectory, 'request-1.json');
    await fs.writeFile(invalidRecord, '{"partial":true', { flag: 'wx', mode: 0o600 });
    await ensureDeadlineReadyMarker(invalidRecord);
    assert.equal(invalid.requestState(1).state, 'unknown');
  });

test('deadline recovery accepts an exact fully paired acknowledged transition', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-deadline-ready-recovery-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const controlKey = 'deadline-ready-recovery';
  const mailbox = createStagingDeadlineMailbox({ controlKey, controlRoot: root, token: TOKEN });
  const ready = {
    protocol: STAGING_DEADLINE_PROTOCOL,
    seconds: 1_800,
    sequence: 0,
    state: 'TRANSACTION',
    token: TOKEN,
  };
  mailbox.acknowledge(ready);
  await ensureDeadlineReadyMarker(path.join(mailbox.specification.controlDirectory, 'ack-0.json'));
  const requestFile = path.join(mailbox.specification.controlDirectory, 'request-1.json');
  await fs.writeFile(requestFile, encodeStagingDeadlineRequest(request(1, 'DISARM', 0)), {
    flag: 'wx', mode: 0o600,
  });
  await ensureDeadlineReadyMarker(requestFile);
  mailbox.acknowledge({
    protocol: STAGING_DEADLINE_PROTOCOL,
    seconds: 0,
    sequence: 1,
    state: 'DISARMED',
    token: TOKEN,
  });
  await ensureDeadlineReadyMarker(path.join(mailbox.specification.controlDirectory, 'ack-1.json'));
  assert.deepEqual(recoverStagingDeadlineMailbox({ controlKey, controlRoot: root }), {
    finalSequence: 1, state: 'DISARMED',
  });
});

test('deadline recovery treats a final unsealed request as session-proven incomplete',
  async (context) => {
    const posix = await import('../scripts/posix-session-supervisor.js');
    const transactionKey = 'deadline-unsealed-request-recovery';
    const sessionKey = `staging-transaction:${transactionKey}`;
    const deadlineKey = `staging-deadline:${transactionKey}`;
    const sessionRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-unsealed-session-'));
    const deadlineRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-unsealed-deadline-'));
    context.after(() => fs.rm(sessionRoot, { recursive: true, force: true }));
    context.after(() => fs.rm(deadlineRoot, { recursive: true, force: true }));
    const mailbox = createStagingDeadlineMailbox({
      controlKey: deadlineKey, controlRoot: deadlineRoot, token: TOKEN,
    });
    mailbox.acknowledge({
      protocol: STAGING_DEADLINE_PROTOCOL,
      seconds: 1_800,
      sequence: 0,
      state: 'TRANSACTION',
      token: TOKEN,
    });
    await fs.writeFile(
      path.join(mailbox.specification.controlDirectory, 'request-1.json'),
      '{"partial":true',
      { flag: 'wx', mode: 0o600 },
    );
    assert.throws(() => recoverStagingDeadlineMailbox({
      controlKey: deadlineKey,
      controlRoot: deadlineRoot,
      permitIncompleteRetirement: true,
      sessionControlRoot: sessionRoot,
    }), /session-proven incomplete retirement/iu);
    const session = posix.recoverPosixSessionControl({
      controlKey: sessionKey,
      controlRoot: sessionRoot,
      permitIncompleteRetirement: true,
      recoveryScope: mailbox.specification.controlDirectory,
      retire: false,
    });
    assert.deepEqual(recoverStagingDeadlineMailbox({
      controlKey: deadlineKey,
      controlRoot: deadlineRoot,
      permitIncompleteRetirement: true,
      sessionControlRoot: sessionRoot,
      sessionRecoveryProof: session.recoveryProof,
    }), { finalSequence: 1, state: 'incomplete' });
    await assert.rejects(fs.access(mailbox.specification.controlDirectory), { code: 'ENOENT' });
  });

test('deadline recovery bounds a zero-byte unsealed request as session-proven incomplete',
  async (context) => {
    const posix = await import('../scripts/posix-session-supervisor.js');
    const transactionKey = 'deadline-zero-request-recovery';
    const sessionKey = `staging-transaction:${transactionKey}`;
    const deadlineKey = `staging-deadline:${transactionKey}`;
    const sessionRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-zero-request-session-'));
    const deadlineRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-zero-request-deadline-'));
    context.after(() => fs.rm(sessionRoot, { recursive: true, force: true }));
    context.after(() => fs.rm(deadlineRoot, { recursive: true, force: true }));
    const mailbox = createStagingDeadlineMailbox({
      controlKey: deadlineKey, controlRoot: deadlineRoot, token: TOKEN,
    });
    mailbox.acknowledge({
      protocol: STAGING_DEADLINE_PROTOCOL,
      seconds: 1_800,
      sequence: 0,
      state: 'TRANSACTION',
      token: TOKEN,
    });
    await fs.writeFile(
      path.join(mailbox.specification.controlDirectory, 'request-1.json'),
      Buffer.alloc(0),
      { flag: 'wx', mode: 0o600 },
    );
    const session = posix.recoverPosixSessionControl({
      controlKey: sessionKey,
      controlRoot: sessionRoot,
      permitIncompleteRetirement: true,
      recoveryScope: mailbox.specification.controlDirectory,
      retire: false,
    });
    assert.deepEqual(recoverStagingDeadlineMailbox({
      controlKey: deadlineKey,
      controlRoot: deadlineRoot,
      permitIncompleteRetirement: true,
      sessionControlRoot: sessionRoot,
      sessionRecoveryProof: session.recoveryProof,
    }), { finalSequence: 1, state: 'incomplete' });
  });

test('deadline recovery bounds a zero-byte unsealed acknowledgement as session-proven incomplete',
  async (context) => {
    const posix = await import('../scripts/posix-session-supervisor.js');
    const transactionKey = 'deadline-zero-ack-recovery';
    const sessionKey = `staging-transaction:${transactionKey}`;
    const deadlineKey = `staging-deadline:${transactionKey}`;
    const sessionRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-zero-ack-session-'));
    const deadlineRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-zero-ack-deadline-'));
    context.after(() => fs.rm(sessionRoot, { recursive: true, force: true }));
    context.after(() => fs.rm(deadlineRoot, { recursive: true, force: true }));
    const mailbox = createStagingDeadlineMailbox({
      controlKey: deadlineKey, controlRoot: deadlineRoot, token: TOKEN,
    });
    await fs.writeFile(
      path.join(mailbox.specification.controlDirectory, 'ack-0.json'),
      Buffer.alloc(0),
      { flag: 'wx', mode: 0o600 },
    );
    const session = posix.recoverPosixSessionControl({
      controlKey: sessionKey,
      controlRoot: sessionRoot,
      permitIncompleteRetirement: true,
      recoveryScope: mailbox.specification.controlDirectory,
      retire: false,
    });
    assert.deepEqual(recoverStagingDeadlineMailbox({
      controlKey: deadlineKey,
      controlRoot: deadlineRoot,
      permitIncompleteRetirement: true,
      sessionControlRoot: sessionRoot,
      sessionRecoveryProof: session.recoveryProof,
    }), { finalSequence: 0, state: 'incomplete' });
  });

test('deadline recovery rejects a zero-byte record once a ready marker seals it', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-zero-sealed-deadline-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const controlKey = 'deadline-zero-sealed-recovery';
  const mailbox = createStagingDeadlineMailbox({ controlKey, controlRoot: root, token: TOKEN });
  mailbox.acknowledge({
    protocol: STAGING_DEADLINE_PROTOCOL,
    seconds: 1_800,
    sequence: 0,
    state: 'TRANSACTION',
    token: TOKEN,
  });
  const zeroRequest = path.join(mailbox.specification.controlDirectory, 'request-1.json');
  await fs.writeFile(zeroRequest, Buffer.alloc(0), { flag: 'wx', mode: 0o600 });
  await ensureDeadlineReadyMarker(zeroRequest);
  assert.throws(() => recoverStagingDeadlineMailbox({ controlKey, controlRoot: root }),
    /unsafe or unbounded/iu);
  await fs.access(mailbox.specification.controlDirectory);
});

test('deadline paired publication seals only an exact existing record and replays idempotently',
  async (context) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-deadline-paired-replay-'));
    context.after(() => fs.rm(root, { recursive: true, force: true }));
    const mailbox = createStagingDeadlineMailbox({
      controlKey: 'deadline-paired-replay', controlRoot: root, token: TOKEN,
    });
    const requestFile = path.join(mailbox.specification.controlDirectory, 'request-1.json');
    await fs.writeFile(requestFile, encodeStagingDeadlineRequest(request(1, 'DISARM', 0)), {
      flag: 'wx', mode: 0o600,
    });
    const pending = requestStagingDeadlineTransition({
      action: 'DISARM',
      environmentValue: mailbox.environmentValue,
      pollMilliseconds: 2,
      seconds: 0,
      sequence: 1,
      timeoutMilliseconds: 500,
    });
    assert.equal(mailbox.requestState(1).state, 'present',
      'an exact existing durable record is sealed before becoming visible');
    mailbox.acknowledge({
      protocol: STAGING_DEADLINE_PROTOCOL,
      seconds: 0,
      sequence: 1,
      state: 'DISARMED',
      token: TOKEN,
    });
    await pending;
    assert.equal((await fs.lstat(deadlineReadyPath(requestFile))).size, 0);
    assert.deepEqual(await requestStagingDeadlineTransition({
      action: 'DISARM',
      environmentValue: mailbox.environmentValue,
      pollMilliseconds: 2,
      seconds: 0,
      sequence: 1,
      timeoutMilliseconds: 500,
    }), {
      protocol: STAGING_DEADLINE_PROTOCOL,
      seconds: 0,
      sequence: 1,
      state: 'DISARMED',
      token: TOKEN,
    });

    const conflicting = createStagingDeadlineMailbox({
      controlKey: 'deadline-paired-conflict', controlRoot: root, token: TOKEN,
    });
    const conflictingFile = path.join(
      conflicting.specification.controlDirectory, 'request-1.json',
    );
    await fs.writeFile(conflictingFile, encodeStagingDeadlineRequest(
      request(1, 'ROLLOVER', 600),
    ), { flag: 'wx', mode: 0o600 });
    await assert.rejects(requestStagingDeadlineTransition({
      action: 'DISARM',
      environmentValue: conflicting.environmentValue,
      pollMilliseconds: 2,
      seconds: 0,
      sequence: 1,
      timeoutMilliseconds: 100,
    }), /conflicts|existing message record/iu);
    await assert.rejects(fs.access(deadlineReadyPath(conflictingFile)), { code: 'ENOENT' });
  });

test('deadline marker EEXIST replay re-syncs and revalidates the exact created marker', () => {
  const root = fsSync.mkdtempSync(path.join(os.tmpdir(), 'easyboost-deadline-marker-resync-'));
  const acknowledgementRecord = {
    protocol: STAGING_DEADLINE_PROTOCOL,
    seconds: 1_800,
    sequence: 0,
    state: 'TRANSACTION',
    token: TOKEN,
  };
  let phase = 'first';
  let replayDirectorySyncs = 0;
  let markerPath;
  try {
    const mailbox = createStagingDeadlineMailbox({
      controlKey: 'deadline-marker-resync',
      controlRoot: root,
      synchronizeMessageDirectory() {
        if (phase === 'first' && markerPath && fsSync.existsSync(markerPath)) {
          throw new Error('synthetic marker directory fsync failure');
        }
        if (phase === 'replay') replayDirectorySyncs += 1;
      },
      token: TOKEN,
    });
    markerPath = deadlineReadyPath(path.join(
      mailbox.specification.controlDirectory, 'ack-0.json',
    ));
    assert.throws(() => mailbox.acknowledge(acknowledgementRecord),
      /synthetic marker directory fsync failure/iu);
    const retainedMarker = fsSync.lstatSync(markerPath);
    assert.equal(retainedMarker.isFile(), true);
    assert.equal(retainedMarker.nlink, 1);
    assert.equal(retainedMarker.size, 0);

    phase = 'replay';
    mailbox.acknowledge(acknowledgementRecord);
    assert.equal(replayDirectorySyncs, 2,
      'record and marker EEXIST branches each re-sync the exact directory entry');
    const replayedMarker = fsSync.lstatSync(markerPath);
    assert.equal(String(replayedMarker.dev), String(retainedMarker.dev));
    assert.equal(String(replayedMarker.ino), String(retainedMarker.ino));
  } finally {
    fsSync.rmSync(root, { recursive: true, force: true });
  }
});

test('inner transaction waits for an authenticated READY acknowledgement', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-staging-deadline-ready-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const mailbox = createStagingDeadlineMailbox({ controlRoot: root, token: TOKEN });
  const pending = awaitStagingDeadlineReady({
    environmentValue: mailbox.environmentValue,
    pollMilliseconds: 2,
    timeoutMilliseconds: 500,
    transactionSeconds: 1_800,
  });
  mailbox.acknowledge({
    protocol: STAGING_DEADLINE_PROTOCOL,
    seconds: 1_800,
    sequence: 0,
    state: 'TRANSACTION',
    token: TOKEN,
  });
  assert.equal((await pending).state, 'TRANSACTION');
});

test('deadline disposal claim cannot delete a successor namespace after an ABA replacement', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-deadline-dispose-aba-'));
  const mailbox = createStagingDeadlineMailbox({
    controlKey: 'dispose-aba-successor', controlRoot: root, token: TOKEN,
  });
  const directory = mailbox.specification.controlDirectory;
  try {
    assert.throws(() => mailbox.dispose({
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

test('deadline disposal never moves authority into a replaced terminal slot', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-deadline-slot-aba-'));
  const mailbox = createStagingDeadlineMailbox({
    controlKey: 'dispose-slot-aba-successor', controlRoot: root, token: TOKEN,
  });
  const directory = mailbox.specification.controlDirectory;
  let successorSlot;
  try {
    assert.throws(() => mailbox.dispose({
      beforeRetirementValidation() {
        const name = fsSync.readdirSync(root).find((entry) => entry.endsWith('.tombstone'));
        const slot = path.join(root, name);
        const displaced = path.join(root, 'displaced-terminal-slot');
        const claim = fsSync.readFileSync(path.join(slot, 'reservation.claim'));
        fsSync.renameSync(slot, displaced);
        fsSync.mkdirSync(slot, { mode: 0o700 });
        fsSync.writeFileSync(path.join(slot, 'reservation.claim'), claim, {
          flag: 'wx', mode: 0o600,
        });
        fsSync.writeFileSync(path.join(slot, 'successor'), 'must-survive', {
          flag: 'wx', mode: 0o600,
        });
        successorSlot = slot;
      },
    }), /slot authority|RETIREMENT_CLAIM_REQUIRED/iu);
    assert.equal(await fs.readFile(path.join(successorSlot, 'successor'), 'utf8'),
      'must-survive');
    await fs.access(directory);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('deadline retirement refuses an unbound legacy slot for the same source path', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-deadline-unbound-slot-'));
  const mailbox = createStagingDeadlineMailbox({
    controlKey: 'deadline-unbound-retirement-slot', controlRoot: root, token: TOKEN,
  });
  const directory = mailbox.specification.controlDirectory;
  const tombstone = terminalSlotPath(root, 0);
  const legacyRecord = {
    owner: 'b'.repeat(64),
    protocol: 'easyboost-staging-deadline-terminal-slot-v1',
    purpose: 'RETIREMENT',
    source: directory,
  };
  try {
    await fs.mkdir(tombstone, { mode: 0o700 });
    await fs.writeFile(path.join(tombstone, 'reservation.claim'),
      `${JSON.stringify(legacyRecord)}\n`, { flag: 'wx', mode: 0o600 });
    assert.throws(() => mailbox.dispose(), (error) => (
      error?.code === 'STAGING_DEADLINE_RETIREMENT_CLAIM_REQUIRED'
        && error.recoveryAuthority?.tombstone === tombstone
    ));
    await fs.access(directory);
    assert.deepEqual(await fs.readdir(tombstone), ['reservation.claim']);
    assert.deepEqual(JSON.parse(await fs.readFile(
      path.join(tombstone, 'reservation.claim'), 'utf8',
    )), legacyRecord);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('deadline retirement source binding rejects a directory substitution and its replay',
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-deadline-source-binding-'));
    const controlKey = 'deadline-retirement-source-binding';
    const displaced = path.join(root, 'displaced-original-deadline-directory');
    let injected = false;
    let replacementIdentity;
    let tombstone;
    const mailbox = createStagingDeadlineMailbox({
      controlKey,
      controlRoot: root,
      moveRetirementDirectory(source, destination) {
        injected = true;
        tombstone = path.dirname(destination);
        fsSync.renameSync(source, displaced);
        fsSync.cpSync(displaced, source, { recursive: true });
        replacementIdentity = fsSync.lstatSync(source);
        fsSync.renameSync(source, destination);
        return true;
      },
      token: TOKEN,
    });
    const directory = mailbox.specification.controlDirectory;
    const originalIdentity = await fs.lstat(directory);
    try {
      let failure;
      assert.throws(() => mailbox.dispose(), (error) => {
        failure = error;
        return error?.code === 'STAGING_DEADLINE_RETIREMENT_CLAIM_REQUIRED';
      });
      assert.equal(injected, true);
      assert.equal(failure.recoveryAuthority?.tombstone, tombstone);
      const reservation = JSON.parse(await fs.readFile(
        path.join(tombstone, 'reservation.claim'), 'utf8',
      ));
      assert.equal(reservation.sourceDev, String(originalIdentity.dev));
      assert.equal(reservation.sourceIno, String(originalIdentity.ino));
      assert.match(reservation.sourceFingerprint, /^[a-f0-9]{64}$/u);

      const retainedOriginal = await fs.lstat(displaced);
      const retainedReplacement = await fs.lstat(path.join(tombstone, 'payload'));
      assert.equal(String(retainedOriginal.ino), String(originalIdentity.ino));
      assert.equal(String(retainedReplacement.ino), String(replacementIdentity.ino));
      assert.notEqual(String(retainedReplacement.ino), String(originalIdentity.ino));

      assert.throws(() => recoverStagingDeadlineMailbox({
        controlKey,
        controlRoot: root,
      }), (error) => error?.code === 'STAGING_DEADLINE_RETIREMENT_CLAIM_REQUIRED'
        && error.recoveryAuthority?.tombstone === tombstone);
      assert.equal(String((await fs.lstat(displaced)).ino), String(originalIdentity.ino));
      assert.equal(String((await fs.lstat(path.join(tombstone, 'payload'))).ino),
        String(replacementIdentity.ino));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

test('deadline retirement namespace binding rejects same-directory record substitution and replay',
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-deadline-namespace-binding-'));
    const controlKey = 'deadline-retirement-namespace-binding';
    const displacedControl = path.join(root, 'displaced-original-control.json');
    let replacementControlIdentity;
    let tombstone;
    const mailbox = createStagingDeadlineMailbox({
      controlKey,
      controlRoot: root,
      moveRetirementDirectory(source, destination) {
        tombstone = path.dirname(destination);
        const control = path.join(source, 'control.json');
        const bytes = fsSync.readFileSync(control);
        fsSync.renameSync(control, displacedControl);
        fsSync.writeFileSync(control, bytes, { flag: 'wx', mode: 0o600 });
        replacementControlIdentity = fsSync.lstatSync(control);
        fsSync.renameSync(source, destination);
        return true;
      },
      token: TOKEN,
    });
    const directory = mailbox.specification.controlDirectory;
    const originalDirectoryIdentity = await fs.lstat(directory);
    const originalControlIdentity = await fs.lstat(path.join(directory, 'control.json'));
    try {
      assert.throws(() => mailbox.dispose(), (error) => (
        error?.code === 'STAGING_DEADLINE_RETIREMENT_CLAIM_REQUIRED'
          && error.recoveryAuthority?.tombstone === tombstone
      ));
      const payload = path.join(tombstone, 'payload');
      const retainedDirectoryIdentity = await fs.lstat(payload);
      const retainedReplacementIdentity = await fs.lstat(path.join(payload, 'control.json'));
      assert.equal(String(retainedDirectoryIdentity.ino), String(originalDirectoryIdentity.ino));
      assert.equal(String((await fs.lstat(displacedControl)).ino), String(originalControlIdentity.ino));
      assert.equal(String(retainedReplacementIdentity.ino), String(replacementControlIdentity.ino));
      assert.notEqual(String(retainedReplacementIdentity.ino), String(originalControlIdentity.ino));

      assert.throws(() => recoverStagingDeadlineMailbox({
        controlKey,
        controlRoot: root,
      }), (error) => error?.code === 'STAGING_DEADLINE_RETIREMENT_CLAIM_REQUIRED'
        && error.recoveryAuthority?.tombstone === tombstone);
      assert.equal(String((await fs.lstat(displacedControl)).ino), String(originalControlIdentity.ino));
      assert.equal(String((await fs.lstat(path.join(payload, 'control.json'))).ino),
        String(replacementControlIdentity.ino));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

test('deadline disposal retains a terminal tombstone and never invokes pathname removal', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-deadline-remove-aba-'));
  const controlKey = 'remove-aba-successor';
  const directory = path.join(root, createHash('sha256').update(controlKey).digest('hex'));
  let removals = 0;
  const mailbox = createStagingDeadlineMailbox({
    controlKey,
    controlRoot: root,
    token: TOKEN,
    removeDirectory() { removals += 1; },
  });
  try {
    mailbox.dispose();
    assert.equal(removals, 0);
    await assert.rejects(fs.access(directory), { code: 'ENOENT' });
    const tombstones = (await fs.readdir(root)).filter((name) => name.endsWith('.tombstone'));
    assert.equal(tombstones.length, 1);
    await fs.access(path.join(root, tombstones[0]));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('quiescent owner maintenance reclaims ordinary success beyond the fixed slot epoch',
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-deadline-maintenance-'));
    const authority = maintenanceAuthority(root);
    let reclaims = 0;
    try {
      for (let index = 0; index < 1_025; index += 1) {
        const mailbox = createStagingDeadlineMailbox({
          controlKey: `maintenance-success-${index}`,
          controlRoot: root,
          quiescentMaintenanceAuthority: authority,
          reclaimRetainedEvidence(requestValue) {
            reclaims += 1;
            assert.deepEqual(Object.keys(requestValue).sort(), [
              'authority', 'bounds', 'container', 'containerIdentity', 'kind', 'payload',
              'payloadIdentity', 'reservationBinding', 'root', 'tombstone',
            ]);
            assert.equal(requestValue.reservationBinding, null);
            assert.equal(requestValue.kind, 'RETIREMENT');
            return trustedTestReclaimer(requestValue);
          },
          token: TOKEN,
        });
        mailbox.dispose();
      }
      assert.equal(reclaims, 1_025);
      assert.deepEqual(await fs.readdir(root), []);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

test('deadline terminal slot N-1 reservation has one winner and fails before loser claim',
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-deadline-tombstone-quota-'));
    try {
      for (let index = 0; index < 1_023; index += 1) {
        fsSync.mkdirSync(terminalSlotPath(root, index), { mode: 0o700 });
      }
      const barrier = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
      const moduleUrl = new URL('../scripts/staging-deadline-control.js', import.meta.url).href;
      const source = `
        const { parentPort, workerData } = require('node:worker_threads');
        import(workerData.moduleUrl).then(({ createStagingDeadlineMailbox }) => {
          const mailbox = createStagingDeadlineMailbox({
            controlKey: workerData.controlKey,
            controlRoot: workerData.root,
            token: '${TOKEN}',
          });
          const gate = new Int32Array(workerData.barrier);
          if (Atomics.add(gate, 0, 1) + 1 === 2) Atomics.notify(gate, 0);
          while (Atomics.load(gate, 0) < 2) Atomics.wait(gate, 0, 1);
          try {
            mailbox.dispose();
            parentPort.postMessage({ directory: mailbox.specification.controlDirectory, ok: true });
          } catch (error) {
            const messages = [];
            for (let current = error; current; current = current.cause) messages.push(current.message);
            parentPort.postMessage({
              directory: mailbox.specification.controlDirectory,
              messages,
              ok: false,
            });
          }
        });
      `;
      const attempt = (controlKey) => new Promise((resolve, reject) => {
        const worker = new Worker(source, {
          eval: true,
          workerData: { barrier, controlKey, moduleUrl, root },
        });
        worker.once('message', resolve);
        worker.once('error', reject);
      });
      const results = await Promise.all([
        attempt('retained-tombstone-quota-a'),
        attempt('retained-tombstone-quota-b'),
      ]);
      assert.equal(results.filter(({ ok }) => ok).length, 1);
      const loser = results.find(({ ok }) => !ok);
      assert.match(loser.messages.join(' '), /terminal slot quota/iu);
      assert.equal((await fs.readdir(root)).filter((name) => name.endsWith('.tombstone')).length,
        1_024);
      await assert.rejects(
        fs.access(path.join(loser.directory, 'retirement.claim')),
        { code: 'ENOENT' },
      );
      await fs.access(loser.directory);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

test('deadline recovery handoff gives one recoverer ownership and cannot delete a later successor',
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-deadline-recovery-aba-'));
    const controlKey = 'recovery-aba-successor';
    const mailbox = createStagingDeadlineMailbox({ controlKey, controlRoot: root, token: TOKEN });
    const directory = mailbox.specification.controlDirectory;
    try {
      mailbox.acknowledge({
        protocol: STAGING_DEADLINE_PROTOCOL, seconds: 60, sequence: 0,
        state: 'TRANSACTION', token: TOKEN,
      });
      const pending = requestStagingDeadlineTransition({
        action: 'DISARM', environmentValue: mailbox.environmentValue, pollMilliseconds: 2,
        seconds: 0, sequence: 1, timeoutMilliseconds: 500,
      });
      for (let attempt = 0; attempt < 100 && mailbox.requestState(1).state === 'missing'; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      mailbox.acknowledge({
        protocol: STAGING_DEADLINE_PROTOCOL, seconds: 0, sequence: 1,
        state: 'DISARMED', token: TOKEN,
      });
      await pending;
      const winner = recoverStagingDeadlineMailbox({
        controlKey, controlRoot: root, retire: false,
      });
      assert.throws(() => recoverStagingDeadlineMailbox({
        controlKey, controlRoot: root, retire: false,
      }), /unknown record|RETIREMENT_CLAIM_REQUIRED/iu);
      assert.equal(completeStagingDeadlineRecovery(winner.recoveryProof, {
        controlKey, controlRoot: root,
      }), true);
      await fs.mkdir(directory, { mode: 0o700 });
      await fs.writeFile(path.join(directory, 'successor'), 'must-survive', { flag: 'wx', mode: 0o600 });
      assert.throws(() => completeStagingDeadlineRecovery(winner.recoveryProof, {
        controlKey, controlRoot: root,
      }), /handoff is invalid/iu);
      assert.equal(await fs.readFile(path.join(directory, 'successor'), 'utf8'), 'must-survive');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

test('restart-safe deadline recovery baton has exactly one concurrent adopter', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-deadline-baton-race-'));
  const controlKey = 'restart-safe-deadline-baton-race';
  const mailbox = createStagingDeadlineMailbox({ controlKey, controlRoot: root, token: TOKEN });
  try {
    mailbox.acknowledge({
      protocol: STAGING_DEADLINE_PROTOCOL, seconds: 60, sequence: 0,
      state: 'TRANSACTION', token: TOKEN,
    });
    const pending = requestStagingDeadlineTransition({
      action: 'DISARM', environmentValue: mailbox.environmentValue, pollMilliseconds: 2,
      seconds: 0, sequence: 1, timeoutMilliseconds: 500,
    });
    for (let attempt = 0; attempt < 100 && mailbox.requestState(1).state === 'missing'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    mailbox.acknowledge({
      protocol: STAGING_DEADLINE_PROTOCOL, seconds: 0, sequence: 1,
      state: 'DISARMED', token: TOKEN,
    });
    await pending;

    const first = recoverStagingDeadlineMailbox({ controlKey, controlRoot: root, retire: false });
    assert.deepEqual(Object.keys(first.recoveryHandoff).sort(), [
      'claimPath', 'controlDirectory', 'controlKey', 'controlRoot',
      'protocol', 'recoveryScope', 'retirementOwner',
    ]);
    const barrier = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
    const moduleUrl = new URL('../scripts/staging-deadline-control.js', import.meta.url).href;
    const source = `
      const { parentPort, workerData } = require('node:worker_threads');
      const gate = new Int32Array(workerData.barrier);
      if (Atomics.add(gate, 0, 1) + 1 === 2) Atomics.notify(gate, 0);
      while (Atomics.load(gate, 0) < 2) Atomics.wait(gate, 0, 1);
      import(workerData.moduleUrl).then(({ resumeStagingDeadlineRecoveryHandoff }) => {
        try {
          const result = resumeStagingDeadlineRecoveryHandoff(workerData.handoff);
          parentPort.postMessage({ handoff: result.recoveryHandoff, ok: true });
        } catch (error) {
          parentPort.postMessage({ message: error.message, ok: false });
        }
      });
    `;
    const adopt = () => new Promise((resolve, reject) => {
      const worker = new Worker(source, {
        eval: true,
        workerData: { barrier, handoff: first.recoveryHandoff, moduleUrl },
      });
      worker.once('message', resolve);
      worker.once('error', reject);
    });
    const attempts = await Promise.all([adopt(), adopt()]);
    assert.equal(attempts.filter(({ ok }) => ok).length, 1);
    assert.equal(attempts.filter(({ ok }) => !ok).length, 1);

    const resumed = resumeStagingDeadlineRecoveryHandoff(
      attempts.find(({ ok }) => ok).handoff,
    );
    assert.deepEqual(resumed, { finalSequence: 1, state: 'DISARMED' });
    assert.equal(completeStagingDeadlineRecovery(resumed.recoveryProof, {
      controlKey, controlRoot: root,
    }), true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('deadline baton adoption keeps a discoverable successor across post-link durability failure',
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-deadline-baton-crash-'));
    const controlKey = 'restart-safe-deadline-baton-post-link-crash';
    const mailbox = createStagingDeadlineMailbox({ controlKey, controlRoot: root, token: TOKEN });
    try {
      mailbox.acknowledge({
        protocol: STAGING_DEADLINE_PROTOCOL, seconds: 60, sequence: 0,
        state: 'TRANSACTION', token: TOKEN,
      });
      const pending = requestStagingDeadlineTransition({
        action: 'DISARM', environmentValue: mailbox.environmentValue, pollMilliseconds: 2,
        seconds: 0, sequence: 1, timeoutMilliseconds: 500,
      });
      for (let attempt = 0; attempt < 100 && mailbox.requestState(1).state === 'missing'; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      mailbox.acknowledge({
        protocol: STAGING_DEADLINE_PROTOCOL, seconds: 0, sequence: 1,
        state: 'DISARMED', token: TOKEN,
      });
      await pending;

      const first = recoverStagingDeadlineMailbox({ controlKey, controlRoot: root, retire: false });
      let mutationFailure;
      assert.throws(() => resumeStagingDeadlineRecoveryHandoff(first.recoveryHandoff, {
        synchronizeDirectory() { throw new Error('synthetic baton directory fsync failure'); },
      }), (error) => {
        mutationFailure = error;
        return /fsync failure/iu.test(error.message);
      });
      const next = mutationFailure.recoveryAuthority?.recoveryHandoff;
      assert.match(path.basename(next.claimPath), /^\.recovery-baton\.[a-f0-9]{64}\.claim$/u);
      assert.notEqual(next.claimPath, first.recoveryHandoff.claimPath);
      const oldIdentity = await fs.lstat(first.recoveryHandoff.claimPath);
      const nextIdentity = await fs.lstat(next.claimPath);
      assert.equal(String(oldIdentity.ino), String(nextIdentity.ino));
      assert.equal(nextIdentity.nlink, 2);

      // Model power loss after link returned but before the directory fsync
      // made that successor durable.  Replaying the emitted stale successor
      // must attach the surviving predecessor instead of wedging recovery.
      await fs.unlink(next.claimPath);
      let replayed;
      assert.throws(() => resumeStagingDeadlineRecoveryHandoff(next), (error) => {
        replayed = error.recoveryAuthority?.recoveryHandoff;
        return /surviving tip/iu.test(error.message);
      });
      assert.deepEqual(replayed, first.recoveryHandoff);
      const retried = resumeStagingDeadlineRecoveryHandoff(replayed);
      let discovered;
      assert.throws(() => recoverStagingDeadlineMailbox({
        controlKey, controlRoot: root, retire: false,
      }), (error) => {
        discovered = error.recoveryAuthority?.recoveryHandoff;
        return /RETIREMENT_CLAIM_REQUIRED/iu.test(error.message);
      });
      assert.deepEqual(discovered, retried.recoveryHandoff);

      const resumed = resumeStagingDeadlineRecoveryHandoff(retried.recoveryHandoff);
      assert.deepEqual(resumed, { finalSequence: 1, state: 'DISARMED' });
      assert.equal(completeStagingDeadlineRecovery(resumed.recoveryProof, {
        controlKey, controlRoot: root,
      }), true);
      await assert.rejects(fs.access(mailbox.specification.controlDirectory), { code: 'ENOENT' });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

test('baton resume auto-quarantines an exact link-plus-fsync publication residue', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-deadline-baton-residue-'));
  const controlKey = 'deadline-baton-link-fsync-residue';
  const mailbox = createStagingDeadlineMailbox({ controlKey, controlRoot: root, token: TOKEN });
  try {
    mailbox.acknowledge({
      protocol: STAGING_DEADLINE_PROTOCOL, seconds: 60, sequence: 0,
      state: 'TRANSACTION', token: TOKEN,
    });
    const pending = requestStagingDeadlineTransition({
      action: 'DISARM', environmentValue: mailbox.environmentValue, pollMilliseconds: 2,
      seconds: 0, sequence: 1, timeoutMilliseconds: 500,
    });
    for (let attempt = 0; attempt < 100 && mailbox.requestState(1).state === 'missing'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    mailbox.acknowledge({
      protocol: STAGING_DEADLINE_PROTOCOL, seconds: 0, sequence: 1,
      state: 'DISARMED', token: TOKEN,
    });
    await pending;
    const first = recoverStagingDeadlineMailbox({ controlKey, controlRoot: root, retire: false });
    const directory = mailbox.specification.controlDirectory;
    const temporary = path.join(root,
      `.${path.basename(directory)}.retirement.claim.${'d'.repeat(32)}.tmp`);
    fsSync.linkSync(first.recoveryHandoff.claimPath, temporary);
    const before = await fs.lstat(first.recoveryHandoff.claimPath);
    assert.equal(before.nlink, 2);

    const resumed = resumeStagingDeadlineRecoveryHandoff(first.recoveryHandoff);
    assert.deepEqual(resumed, { finalSequence: 1, state: 'DISARMED' });
    await assert.rejects(fs.access(temporary), { code: 'ENOENT' });
    const publicationSlots = [];
    for (const name of await fs.readdir(root)) {
      if (!name.endsWith('.tombstone')) continue;
      const container = path.join(root, name);
      const claim = JSON.parse(await fs.readFile(path.join(container, 'reservation.claim'), 'utf8'));
      if (claim.purpose === 'PUBLICATION') publicationSlots.push(container);
    }
    assert.equal(publicationSlots.length, 1);
    const payloadIdentity = await fs.lstat(path.join(publicationSlots[0], 'payload'));
    const batonIdentity = await fs.lstat(resumed.recoveryHandoff.claimPath);
    assert.equal(String(payloadIdentity.ino), String(batonIdentity.ino));
    assert.equal(batonIdentity.nlink, 3);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('exhausted baton chain fails closed and a quiescent epoch rotation restores progress',
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-deadline-baton-epoch-'));
    const controlKey = 'deadline-baton-epoch-rotation';
    const mailbox = createStagingDeadlineMailbox({ controlKey, controlRoot: root, token: TOKEN });
    try {
      mailbox.acknowledge({
        protocol: STAGING_DEADLINE_PROTOCOL, seconds: 60, sequence: 0,
        state: 'TRANSACTION', token: TOKEN,
      });
      const pending = requestStagingDeadlineTransition({
        action: 'DISARM', environmentValue: mailbox.environmentValue, pollMilliseconds: 2,
        seconds: 0, sequence: 1, timeoutMilliseconds: 500,
      });
      for (let attempt = 0; attempt < 100 && mailbox.requestState(1).state === 'missing'; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      mailbox.acknowledge({
        protocol: STAGING_DEADLINE_PROTOCOL, seconds: 0, sequence: 1,
        state: 'DISARMED', token: TOKEN,
      });
      await pending;
      let current = recoverStagingDeadlineMailbox({ controlKey, controlRoot: root, retire: false });
      for (let index = 1; index < 32; index += 1) {
        current = resumeStagingDeadlineRecoveryHandoff(current.recoveryHandoff);
      }
      let exhausted;
      assert.throws(() => resumeStagingDeadlineRecoveryHandoff(current.recoveryHandoff), (error) => {
        exhausted = error;
        return error.code === 'STAGING_DEADLINE_RECOVERY_EPOCH_MAINTENANCE_REQUIRED';
      });
      assert.deepEqual(exhausted.recoveryAuthority?.recoveryHandoff,
        current.recoveryHandoff);

      let callbackFailure;
      assert.throws(() => resumeStagingDeadlineRecoveryHandoff(current.recoveryHandoff, {
        quiescentMaintenanceAuthority: maintenanceAuthority(root),
        rotateRecoveryBatonEpoch() { throw new Error('synthetic epoch maintenance crash'); },
      }), (error) => {
        callbackFailure = error;
        return /epoch maintenance crash/iu.test(error.message);
      });
      assert.deepEqual(callbackFailure.recoveryAuthority?.recoveryHandoff,
        current.recoveryHandoff);

      let rotations = 0;
      const resumed = resumeStagingDeadlineRecoveryHandoff(current.recoveryHandoff, {
        quiescentMaintenanceAuthority: maintenanceAuthority(root),
        rotateRecoveryBatonEpoch(requestValue) {
          rotations += 1;
          assert.equal(requestValue.kind, 'RECOVERY_BATON_EPOCH');
          const identity = fsSync.lstatSync(requestValue.source);
          assert.deepEqual({ dev: String(identity.dev), ino: String(identity.ino) },
            requestValue.expectedIdentity);
          const bytes = fsSync.readFileSync(requestValue.source);
          for (const name of requestValue.names) {
            fsSync.unlinkSync(path.join(requestValue.directory, name));
          }
          fsSync.writeFileSync(path.join(requestValue.directory, 'retirement.claim'), bytes, {
            flag: 'wx', mode: 0o600,
          });
          return true;
        },
      });
      assert.equal(rotations, 1);
      assert.deepEqual(resumed, { finalSequence: 1, state: 'DISARMED' });
      const batonNames = (await fs.readdir(mailbox.specification.controlDirectory))
        .filter((name) => name === 'retirement.claim' || name.startsWith('.recovery-baton.'));
      assert.equal(batonNames.length, 2);
      assert.equal(completeStagingDeadlineRecovery(resumed.recoveryProof, {
        controlKey, controlRoot: root,
      }), true);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

test('runtime deadline disposal failure after its claim exposes restart-adoptable authority',
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-deadline-dispose-handoff-'));
    const controlKey = 'runtime-dispose-restart-handoff';
    const mailbox = createStagingDeadlineMailbox({ controlKey, controlRoot: root, token: TOKEN });
    try {
      let disposalFailure;
      assert.throws(() => mailbox.dispose({
        beforeRetirementValidation() { throw new Error('synthetic post-claim crash'); },
      }), (error) => {
        disposalFailure = error;
        return /post-claim crash/iu.test(error.message);
      });
      const handoff = disposalFailure.recoveryAuthority?.recoveryHandoff;
      assert.equal(handoff?.controlKey, controlKey);
      assert.equal(path.basename(handoff?.claimPath ?? ''), 'retirement.claim');
      const reservedSlot = disposalFailure.recoveryAuthority?.tombstone;
      assert.equal(typeof reservedSlot, 'string');
      const reservation = JSON.parse(await fs.readFile(
        path.join(reservedSlot, 'reservation.claim'), 'utf8',
      ));
      assert.equal(reservation.purpose, 'RETIREMENT');
      assert.equal(reservation.source, mailbox.specification.controlDirectory);
      await fs.access(mailbox.specification.controlDirectory);

      let discovered;
      assert.throws(() => recoverStagingDeadlineMailbox({
        controlKey, controlRoot: root, retire: false,
      }), (error) => {
        discovered = error.recoveryAuthority?.recoveryHandoff;
        return /RETIREMENT_CLAIM_REQUIRED/iu.test(error.message);
      });
      assert.deepEqual(discovered, handoff);
      const resumed = resumeStagingDeadlineRecoveryHandoff(handoff);
      assert.deepEqual(resumed, { state: 'disposed' });

      let completionFailure;
      assert.throws(() => completeStagingDeadlineRecovery(resumed.recoveryProof, {
        controlKey,
        controlRoot: root,
        syncControlRoot() { throw new Error('synthetic disposal root fsync failure'); },
      }), (error) => {
        completionFailure = error;
        return errorChainMatches(error, /fsync failure/iu);
      });
      const terminal = completionFailure.recoveryAuthority;
      assert.deepEqual(Object.keys(terminal).sort(), ['controlDirectory', 'tombstone']);
      await fs.access(terminal.tombstone);
      await assert.rejects(fs.access(mailbox.specification.controlDirectory), { code: 'ENOENT' });
      assert.deepEqual(recoverStagingDeadlineMailbox({
        controlKey, controlRoot: root,
      }), { state: 'disposed' });
      assert.equal(cleanupStagingDeadlineRetirementTombstone(terminal, {
        synchronizeDirectory() {},
      }), true);
      await fs.access(terminal.tombstone);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

test('failed default deadline retirement exposes its current restart handoff', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-deadline-caught-handoff-'));
  const controlKey = 'caught-default-deadline-retirement-handoff';
  const mailbox = createStagingDeadlineMailbox({ controlKey, controlRoot: root, token: TOKEN });
  const directory = mailbox.specification.controlDirectory;
  const residue = path.join(root,
    `.${path.basename(directory)}.late.${'d'.repeat(32)}.tmp`);
  try {
    mailbox.acknowledge({
      protocol: STAGING_DEADLINE_PROTOCOL, seconds: 60, sequence: 0,
      state: 'TRANSACTION', token: TOKEN,
    });
    const pending = requestStagingDeadlineTransition({
      action: 'DISARM', environmentValue: mailbox.environmentValue, pollMilliseconds: 2,
      seconds: 0, sequence: 1, timeoutMilliseconds: 500,
    });
    for (let attempt = 0; attempt < 100 && mailbox.requestState(1).state === 'missing'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    mailbox.acknowledge({
      protocol: STAGING_DEADLINE_PROTOCOL, seconds: 0, sequence: 1,
      state: 'DISARMED', token: TOKEN,
    });
    await pending;

    let failure;
    assert.throws(() => recoverStagingDeadlineMailbox({
      beforeRetirementValidation() {
        fsSync.writeFileSync(residue, 'retained publication', { flag: 'wx', mode: 0o600 });
      },
      controlKey,
      controlRoot: root,
    }), (error) => {
      failure = error;
      return Boolean(error.recoveryAuthority?.recoveryHandoff);
    });
    const handoff = failure.recoveryAuthority?.recoveryHandoff;
    assert.deepEqual(Object.keys(handoff ?? {}).sort(), [
      'claimPath', 'controlDirectory', 'controlKey', 'controlRoot',
      'protocol', 'recoveryScope', 'retirementOwner',
    ]);
    await fs.unlink(residue);
    const resumed = resumeStagingDeadlineRecoveryHandoff(handoff);
    assert.deepEqual(resumed, { finalSequence: 1, state: 'DISARMED' });
    assert.equal(completeStagingDeadlineRecovery(resumed.recoveryProof, {
      controlKey, controlRoot: root,
    }), true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('deadline recovery exposes a retryable tombstone after removal outlives root fsync',
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-deadline-recovery-resync-'));
    const controlKey = 'deadline-recovery-removal-before-root-fsync';
    const mailbox = createStagingDeadlineMailbox({ controlKey, controlRoot: root, token: TOKEN });
    try {
      mailbox.acknowledge({
        protocol: STAGING_DEADLINE_PROTOCOL, seconds: 60, sequence: 0,
        state: 'TRANSACTION', token: TOKEN,
      });
      const pending = requestStagingDeadlineTransition({
        action: 'DISARM', environmentValue: mailbox.environmentValue, pollMilliseconds: 2,
        seconds: 0, sequence: 1, timeoutMilliseconds: 500,
      });
      for (let attempt = 0; attempt < 100 && mailbox.requestState(1).state === 'missing'; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      mailbox.acknowledge({
        protocol: STAGING_DEADLINE_PROTOCOL, seconds: 0, sequence: 1,
        state: 'DISARMED', token: TOKEN,
      });
      await pending;

      let failure;
      assert.throws(() => recoverStagingDeadlineMailbox({
        controlKey,
        controlRoot: root,
        syncControlRoot() { throw new Error('synthetic recovery root fsync failure'); },
      }), (error) => {
        failure = error;
        return errorChainMatches(error, /fsync failure/iu);
      });
      const authority = failure.recoveryAuthority;
      assert.equal(typeof authority?.tombstone, 'string');
      await fs.access(authority.tombstone);
      assert.equal(cleanupStagingDeadlineRetirementTombstone(authority, {
        synchronizeDirectory() {},
      }), true);
      await fs.access(authority.tombstone);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

test('deadline baton adoption revalidates the full namespace and preserves the rotated baton',
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-deadline-baton-revalidate-'));
    const controlKey = 'deadline-baton-full-namespace-revalidation';
    const mailbox = createStagingDeadlineMailbox({ controlKey, controlRoot: root, token: TOKEN });
    try {
      mailbox.acknowledge({
        protocol: STAGING_DEADLINE_PROTOCOL, seconds: 60, sequence: 0,
        state: 'TRANSACTION', token: TOKEN,
      });
      const pending = requestStagingDeadlineTransition({
        action: 'DISARM', environmentValue: mailbox.environmentValue, pollMilliseconds: 2,
        seconds: 0, sequence: 1, timeoutMilliseconds: 500,
      });
      for (let attempt = 0; attempt < 100 && mailbox.requestState(1).state === 'missing'; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      mailbox.acknowledge({
        protocol: STAGING_DEADLINE_PROTOCOL, seconds: 0, sequence: 1,
        state: 'DISARMED', token: TOKEN,
      });
      await pending;
      const first = recoverStagingDeadlineMailbox({ controlKey, controlRoot: root, retire: false });
      const acknowledgementFile = path.join(mailbox.specification.controlDirectory, 'ack-1.json');
      const authentic = await fs.readFile(acknowledgementFile, 'utf8');
      const changed = authentic.replace('"DISARMED"', '"RECOVERY"');
      assert.equal(changed.length, authentic.length);
      await fs.writeFile(acknowledgementFile, changed);

      let failure;
      assert.throws(() => resumeStagingDeadlineRecoveryHandoff(first.recoveryHandoff), (error) => {
        failure = error;
        return /namespace changed/iu.test(error.message);
      });
      const rotated = failure.recoveryAuthority?.recoveryHandoff;
      assert.notEqual(rotated?.claimPath, first.recoveryHandoff.claimPath);
      await fs.writeFile(acknowledgementFile, authentic);
      const resumed = resumeStagingDeadlineRecoveryHandoff(rotated);
      assert.deepEqual(resumed, { finalSequence: 1, state: 'DISARMED' });
      assert.equal(completeStagingDeadlineRecovery(resumed.recoveryProof, {
        controlKey, controlRoot: root,
      }), true);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

test('deadline mailbox fails closed on a stale acknowledgement and keeps proof state', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-staging-deadline-stale-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const mailbox = createStagingDeadlineMailbox({ controlRoot: root, token: TOKEN });
  const pending = requestStagingDeadlineTransition({
    action: 'DISARM',
    environmentValue: mailbox.environmentValue,
    pollMilliseconds: 2,
    seconds: 0,
    sequence: 2,
    timeoutMilliseconds: 100,
  });
  const failure = pending.then(() => null, (error) => error);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (mailbox.requestState(2).state === 'present') break;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  const staleAcknowledgement = path.join(mailbox.specification.controlDirectory, 'ack-2.json');
  await fs.writeFile(staleAcknowledgement,
    encodeStagingDeadlineAcknowledgement({
      protocol: STAGING_DEADLINE_PROTOCOL,
      seconds: 0,
      sequence: 1,
      state: 'DISARMED',
      token: TOKEN,
    }), { flag: 'wx', mode: 0o600 });
  await ensureDeadlineReadyMarker(staleAcknowledgement);
  assert.match((await failure).message, /acknowledgement/iu);
  assert.equal(mailbox.requestState(2).state, 'present',
    'a failed acknowledgement must not erase the request/recovery authority');
});

test('typed deadline recovery retires only an exact acknowledged DISARM authority', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-staging-deadline-recovery-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const controlKey = 'deadline-recovery-fixture';
  const mailbox = createStagingDeadlineMailbox({ controlKey, controlRoot: root, token: TOKEN });
  mailbox.acknowledge({
    protocol: STAGING_DEADLINE_PROTOCOL,
    seconds: 1_800,
    sequence: 0,
    state: 'TRANSACTION',
    token: TOKEN,
  });
  const pending = requestStagingDeadlineTransition({
    action: 'DISARM', environmentValue: mailbox.environmentValue, pollMilliseconds: 2,
    seconds: 0, sequence: 1, timeoutMilliseconds: 500,
  });
  for (let attempt = 0; attempt < 100 && mailbox.requestState(1).state === 'missing'; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  mailbox.acknowledge({
    protocol: STAGING_DEADLINE_PROTOCOL,
    seconds: 0,
    sequence: 1,
    state: 'DISARMED',
    token: TOKEN,
  });
  await pending;

  const retired = recoverStagingDeadlineMailbox({ controlKey, controlRoot: root });
  assert.deepEqual(retired, { finalSequence: 1, state: 'DISARMED' });
  await assert.rejects(fs.access(mailbox.specification.controlDirectory), { code: 'ENOENT' });
});

test('disarmed deadline recovery retains an authenticated record changed at retirement',
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-deadline-late-change-'));
    const controlKey = 'deadline-recovery-late-record-change';
    try {
      const mailbox = createStagingDeadlineMailbox({ controlKey, controlRoot: root, token: TOKEN });
      mailbox.acknowledge({
        protocol: STAGING_DEADLINE_PROTOCOL,
        seconds: 1_800,
        sequence: 0,
        state: 'TRANSACTION',
        token: TOKEN,
      });
      const pending = requestStagingDeadlineTransition({
        action: 'DISARM', environmentValue: mailbox.environmentValue, pollMilliseconds: 2,
        seconds: 0, sequence: 1, timeoutMilliseconds: 500,
      });
      for (let attempt = 0; attempt < 100 && mailbox.requestState(1).state === 'missing'; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      mailbox.acknowledge({
        protocol: STAGING_DEADLINE_PROTOCOL,
        seconds: 0,
        sequence: 1,
        state: 'DISARMED',
        token: TOKEN,
      });
      await pending;
      const acknowledgementFile = path.join(mailbox.specification.controlDirectory, 'ack-1.json');
      const authenticatedBytes = await fs.readFile(acknowledgementFile, 'utf8');
      const changedBytes = authenticatedBytes.replace('"DISARMED"', '"RECOVERY"');
      assert.equal(changedBytes.length, authenticatedBytes.length,
        'the interleaving must change authenticated bytes without changing record size');

      assert.throws(() => recoverStagingDeadlineMailbox({
        beforeRetirementValidation() {
          fsSync.writeFileSync(acknowledgementFile, changedBytes);
        },
        controlKey,
        controlRoot: root,
      }), /changed|namespace|retirement/iu);
      assert.equal(await fs.readFile(acknowledgementFile, 'utf8'), changedBytes);
      await fs.access(mailbox.specification.controlDirectory);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

test('typed deadline recovery retains incomplete or tampered authority', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-staging-deadline-recovery-retain-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const mailbox = createStagingDeadlineMailbox({
    controlKey: 'deadline-recovery-retain-fixture', controlRoot: root, token: TOKEN,
  });
  mailbox.acknowledge({
    protocol: STAGING_DEADLINE_PROTOCOL,
    seconds: 1_800,
    sequence: 0,
    state: 'TRANSACTION',
    token: TOKEN,
  });
  assert.throws(() => recoverStagingDeadlineMailbox({
    controlKey: 'deadline-recovery-retain-fixture', controlRoot: root,
  }), /DISARM|recovery/iu);
  await fs.access(mailbox.specification.controlDirectory);
});

test('typed deadline recovery rejects an unbounded transition history and retains authority',
  async (context) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-staging-deadline-history-'));
    context.after(() => fs.rm(root, { recursive: true, force: true }));
    const controlKey = 'deadline-recovery-unbounded-history';
    const mailbox = createStagingDeadlineMailbox({ controlKey, controlRoot: root, token: TOKEN });
    mailbox.acknowledge({
      protocol: STAGING_DEADLINE_PROTOCOL,
      seconds: 1_800,
      sequence: 0,
      state: 'TRANSACTION',
      token: TOKEN,
    });
    for (const [sequence, action, seconds, state] of [
      [1, 'ROLLOVER', 600, 'RECOVERY'],
      [2, 'DISARM', 0, 'DISARMED'],
      [3, 'DISARM', 0, 'DISARMED'],
    ]) {
      const pending = requestStagingDeadlineTransition({
        action, environmentValue: mailbox.environmentValue, pollMilliseconds: 2,
        seconds, sequence, timeoutMilliseconds: 500,
      });
      for (let attempt = 0; attempt < 100 && mailbox.requestState(sequence).state === 'missing'; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      mailbox.acknowledge({
        protocol: STAGING_DEADLINE_PROTOCOL, seconds, sequence, state, token: TOKEN,
      });
      await pending;
    }
    assert.throws(() => recoverStagingDeadlineMailbox({ controlKey, controlRoot: root }),
      /state machine|bounded|sequence/iu);
    await fs.access(mailbox.specification.controlDirectory);
  });

test('only session-proven recovery may retire a canonical unresolved deadline prefix',
  async (context) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-staging-deadline-prefix-'));
    context.after(() => fs.rm(root, { recursive: true, force: true }));
    const controlKey = 'deadline-recovery-unresolved-prefix';
    const mailbox = createStagingDeadlineMailbox({ controlKey, controlRoot: root, token: TOKEN });
    mailbox.acknowledge({
      protocol: STAGING_DEADLINE_PROTOCOL,
      seconds: 1_800,
      sequence: 0,
      state: 'TRANSACTION',
      token: TOKEN,
    });
    const pending = requestStagingDeadlineTransition({
      action: 'ROLLOVER', environmentValue: mailbox.environmentValue, pollMilliseconds: 2,
      seconds: 600, sequence: 1, timeoutMilliseconds: 500,
    });
    for (let attempt = 0; attempt < 100 && mailbox.requestState(1).state === 'missing'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    await assert.rejects(pending, /timed out/iu);
    assert.throws(() => recoverStagingDeadlineMailbox({ controlKey, controlRoot: root }),
      /session-proven/iu);
    await fs.access(mailbox.specification.controlDirectory);
    assert.throws(() => recoverStagingDeadlineMailbox({
      controlKey, controlRoot: root, permitIncompleteRetirement: true,
    }), /session-proven/iu,
    'a caller cannot bypass the POSIX proof boundary with a boolean option');
    await fs.access(mailbox.specification.controlDirectory);
  });
