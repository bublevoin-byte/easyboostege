import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  STAGING_QUIESCENT_MAINTENANCE_DESCRIPTOR,
  STAGING_QUIESCENT_MAINTENANCE_ENVIRONMENT,
  STAGING_QUIESCENT_MAINTENANCE_PROTOCOL,
  bindStagingQuiescentMaintenanceRoot,
  consumePosixReleaseMaintenanceLock,
  consumeStagingQuiescentMaintenanceLock,
  posixReleaseMaintenanceEnvironmentValue,
  stagingQuiescentMaintenanceEnvironmentValue,
  stagingQuiescentMaintenanceLockBytes,
} from '../scripts/staging-quiescent-maintenance.js';

function filesystemWithDescriptor(lockPath) {
  const withPortableMode = (stat, mode) => {
    Object.defineProperty(stat, 'mode', {
      configurable: true,
      value: (stat.mode & ~0o777) | mode,
    });
    return stat;
  };
  const portableStat = (entry) => {
    const stat = fs.lstatSync(entry);
    return withPortableMode(stat, stat.isDirectory() ? 0o700 : 0o600);
  };
  return Object.freeze({
    ...fs,
    fstatSync(descriptor) {
      return descriptor === STAGING_QUIESCENT_MAINTENANCE_DESCRIPTOR
        ? portableStat(lockPath)
        : withPortableMode(fs.fstatSync(descriptor), 0o600);
    },
    lstatSync: portableStat,
  });
}

function consumeFixture({ environment, installRoot, lockBytes, lockPath, held }) {
  return consumeStagingQuiescentMaintenanceLock({
    environment,
    expectedInstallRoot: installRoot,
    filesystem: filesystemWithDescriptor(lockPath),
    platform: 'linux',
    processId: 4242,
    readDescriptorBytes: () => lockBytes,
    readDescriptorLockInfo: () => 'fixture-lock-info',
    readProcessStartTime: () => '818181',
    userId: undefined,
    verifyExclusiveLock: () => held.value,
  });
}

let freshModuleIndex = 0;

async function freshMaintenanceModule() {
  freshModuleIndex += 1;
  return import(new URL(
    `../scripts/staging-quiescent-maintenance.js?fresh=${freshModuleIndex}`,
    import.meta.url,
  ));
}

function createMaintenanceFixture(prefix) {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const installRoot = path.join(temporaryRoot, 'install');
  const controlRoot = path.join(temporaryRoot, 'control');
  const lockPath = path.join(installRoot, 'maintenance.lock');
  fs.mkdirSync(installRoot, { mode: 0o700 });
  fs.mkdirSync(controlRoot, { mode: 0o700 });
  const lockBytes = stagingQuiescentMaintenanceLockBytes(installRoot);
  fs.writeFileSync(lockPath, lockBytes, { mode: 0o600 });
  fs.chmodSync(lockPath, 0o600);
  return {
    controlRoot,
    held: { value: true },
    installRoot,
    lockBytes,
    lockPath,
    temporaryRoot,
  };
}

function consumeFreshProof(maintenanceModule, fixture) {
  const environment = {
    [maintenanceModule.STAGING_QUIESCENT_MAINTENANCE_ENVIRONMENT]:
      maintenanceModule.stagingQuiescentMaintenanceEnvironmentValue(fixture.lockBytes),
  };
  return maintenanceModule.consumeStagingQuiescentMaintenanceLock({
    environment,
    expectedInstallRoot: fixture.installRoot,
    filesystem: filesystemWithDescriptor(fixture.lockPath),
    platform: 'linux',
    processId: 4242,
    readDescriptorBytes: () => fixture.lockBytes,
    readDescriptorLockInfo: () => 'fixture-lock-info',
    readProcessStartTime: () => '818181',
    userId: undefined,
    verifyExclusiveLock: () => fixture.held.value,
  });
}

function writeRetainedFixture(controlRoot, name, {
  directoryPayload = false,
  retainedSource = false,
} = {}) {
  const container = path.join(controlRoot, name);
  const payload = path.join(container, 'payload');
  fs.mkdirSync(container, { mode: 0o700 });
  fs.writeFileSync(path.join(container, 'reservation.claim'), '{"fixture":true}\n', {
    mode: 0o600,
  });
  if (directoryPayload) {
    fs.mkdirSync(payload, { mode: 0o700 });
    fs.writeFileSync(path.join(payload, 'first'), 'first');
    fs.writeFileSync(path.join(payload, 'second'), 'second');
  } else {
    fs.writeFileSync(payload, 'retained');
    if (retainedSource) fs.linkSync(payload, path.join(container, 'retained-source'));
  }
  return { container, payload };
}

function retainedRequest(binding, controlRoot, container, payload, kind = 'PUBLICATION') {
  const containerStat = fs.lstatSync(container);
  const payloadStat = fs.lstatSync(payload);
  return {
    authority: binding.authority,
    bounds: { maximumBytes: 4096, maximumEntries: 16 },
    container,
    containerIdentity: { dev: String(containerStat.dev), ino: String(containerStat.ino) },
    kind,
    payload,
    payloadIdentity: { dev: String(payloadStat.dev), ino: String(payloadStat.ino) },
    reservationBinding: null,
    root: controlRoot,
    tombstone: container,
  };
}

function deletionTransactions(controlRoot) {
  return fs.readdirSync(controlRoot)
    .filter((name) => /^\.maintenance-deletion\.[a-f0-9]{64}$/u.test(name));
}

test('maintenance lock bytes and launcher environment are canonical and bounded', () => {
  const installRoot = path.resolve('/fixture/staging-helper');
  const bytes = stagingQuiescentMaintenanceLockBytes(installRoot);
  assert.deepEqual(JSON.parse(bytes.toString('utf8')), {
    installRoot,
    protocol: 'easyboost-staging-quiescent-maintenance-lock-v1',
  });
  assert.equal(bytes.at(-1), 0x0a);
  assert.match(stagingQuiescentMaintenanceEnvironmentValue(bytes),
    new RegExp(`^${STAGING_QUIESCENT_MAINTENANCE_PROTOCOL}:8:[a-f0-9]{64}$`, 'u'));
  assert.throws(() => stagingQuiescentMaintenanceLockBytes('relative'));
  assert.throws(() => stagingQuiescentMaintenanceEnvironmentValue(Buffer.alloc(0)));
});

test('POSIX release scope binds an allowlisted root and rechecks live lock bytes', () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'easyboost-release-scope-v2-'));
  const laneRoot = path.join(temporaryRoot, 'lane');
  const controlRoot = path.join(laneRoot, 'posix-session-controls');
  const foreignRoot = path.join(laneRoot, 'foreign-controls');
  const lockPath = path.join(laneRoot, 'maintenance.lock');
  fs.mkdirSync(controlRoot, { mode: 0o700, recursive: true });
  fs.mkdirSync(foreignRoot, { mode: 0o700 });
  const lockBytes = Buffer.from('{"protocol":"easyboost-posix-release-maintenance-lock-v2"}\n');
  fs.writeFileSync(lockPath, lockBytes, { mode: 0o600 });
  fs.chmodSync(lockPath, 0o600);
  const rootIdentity = fs.lstatSync(controlRoot);
  const environment = {
    EASYBOOST_POSIX_RELEASE_MAINTENANCE_SCOPE:
      posixReleaseMaintenanceEnvironmentValue(lockBytes),
  };
  let descriptorBytes = lockBytes;
  try {
    const proof = consumePosixReleaseMaintenanceLock({
      allowedControlRoots: [{
        dev: String(rootIdentity.dev), ino: String(rootIdentity.ino), path: controlRoot,
      }],
      environment,
      expectedLockBytes: lockBytes,
      expectedLockPath: lockPath,
      filesystem: filesystemWithDescriptor(lockPath),
      platform: 'linux',
      processId: 4242,
      readDescriptorBytes: () => descriptorBytes,
      readDescriptorLockInfo: () => 'fixture-lock-info',
      readProcessStartTime: () => '818181',
      userId: undefined,
      verifyExclusiveLock: () => true,
    });
    assert.equal(environment.EASYBOOST_POSIX_RELEASE_MAINTENANCE_SCOPE, undefined);
    const binding = bindStagingQuiescentMaintenanceRoot(proof, controlRoot, {
      synchronizeDirectory() {},
    });
    assert.throws(() => bindStagingQuiescentMaintenanceRoot(proof, foreignRoot),
      /outside its exact scope/iu);
    assert.equal(binding.reclaimRetainedEvidence({
      authority: binding.authority,
      kind: 'QUIESCENT_ABSENCE_PROOF',
      root: controlRoot,
    }), true);
    descriptorBytes = Buffer.from(lockBytes);
    descriptorBytes[0] ^= 1;
    assert.throws(() => binding.reclaimRetainedEvidence({
      authority: binding.authority,
      kind: 'QUIESCENT_ABSENCE_PROOF',
      root: controlRoot,
    }), /lock is no longer proven/iu);
  } finally {
    fs.rmSync(temporaryRoot, { force: true, recursive: true });
  }
});

test('fdinfo binds the inherited flock to descriptor 8 even when its recorder PID differs', () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'easyboost-maintenance-fdinfo-'));
  const installRoot = path.join(temporaryRoot, 'install');
  const lockPath = path.join(installRoot, 'maintenance.lock');
  fs.mkdirSync(installRoot, { mode: 0o700 });
  const lockBytes = stagingQuiescentMaintenanceLockBytes(installRoot);
  fs.writeFileSync(lockPath, lockBytes, { mode: 0o600 });
  fs.chmodSync(lockPath, 0o600);
  const stat = fs.lstatSync(lockPath);
  const device = BigInt(stat.dev);
  const major = ((device & 0x00000000000fff00n) >> 8n)
    | ((device & 0xfffff00000000000n) >> 32n);
  const minor = (device & 0x00000000000000ffn)
    | ((device & 0x00000ffffff00000n) >> 12n);
  const inode = BigInt(stat.ino).toString();
  const lockInfo = `pos:\t0\nlock:\t1: FLOCK ADVISORY WRITE 31337 ${major.toString(16)}:${minor.toString(16)}:${inode} 0 EOF\n`;
  const environment = {
    [STAGING_QUIESCENT_MAINTENANCE_ENVIRONMENT]:
      stagingQuiescentMaintenanceEnvironmentValue(lockBytes),
  };
  try {
    assert.ok(consumeStagingQuiescentMaintenanceLock({
      environment,
      expectedInstallRoot: installRoot,
      filesystem: filesystemWithDescriptor(lockPath),
      platform: 'linux',
      processId: 4242,
      readDescriptorBytes: () => lockBytes,
      readDescriptorLockInfo: () => lockInfo,
      readProcessStartTime: () => '818181',
      userId: undefined,
    }));
    assert.equal(environment[STAGING_QUIESCENT_MAINTENANCE_ENVIRONMENT], undefined);
    assert.throws(() => consumeStagingQuiescentMaintenanceLock({
      environment: {
        [STAGING_QUIESCENT_MAINTENANCE_ENVIRONMENT]:
          stagingQuiescentMaintenanceEnvironmentValue(lockBytes),
      },
      expectedInstallRoot: installRoot,
      filesystem: filesystemWithDescriptor(lockPath),
      platform: 'linux',
      processId: 4242,
      readDescriptorBytes: () => lockBytes,
      readDescriptorLockInfo: () => lockInfo.replace(`:${inode} 0 EOF`, ':1 0 EOF'),
      readProcessStartTime: () => '818181',
      userId: undefined,
    }), /exclusive lock is not held/u);
  } finally {
    fs.rmSync(temporaryRoot, { force: true, recursive: true });
  }
});

test('launcher proof is consumed, bound to each root and required for reclaim', () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'easyboost-maintenance-'));
  const installRoot = path.join(temporaryRoot, 'install');
  const controlRoot = path.join(temporaryRoot, 'control');
  const lockPath = path.join(installRoot, 'maintenance.lock');
  const container = path.join(controlRoot, '.fixture-slot.tombstone');
  const payload = path.join(container, 'payload');
  fs.mkdirSync(installRoot, { mode: 0o700 });
  fs.mkdirSync(controlRoot, { mode: 0o700 });
  const lockBytes = stagingQuiescentMaintenanceLockBytes(installRoot);
  fs.writeFileSync(lockPath, lockBytes, { mode: 0o600 });
  fs.chmodSync(lockPath, 0o600);
  fs.mkdirSync(container, { mode: 0o700 });
  fs.writeFileSync(path.join(container, 'reservation.claim'), '{"fixture":true}\n');
  fs.writeFileSync(payload, 'retained');
  const environment = {
    [STAGING_QUIESCENT_MAINTENANCE_ENVIRONMENT]:
      stagingQuiescentMaintenanceEnvironmentValue(lockBytes),
  };
  const held = { value: true };
  try {
    const proof = consumeFixture({ environment, held, installRoot, lockBytes, lockPath });
    assert.equal(environment[STAGING_QUIESCENT_MAINTENANCE_ENVIRONMENT], undefined);
    const binding = bindStagingQuiescentMaintenanceRoot(proof, controlRoot, {
      randomToken: () => 'a'.repeat(64),
      synchronizeDirectory() {},
    });
    assert.deepEqual(binding.authority, {
      descriptor: 8,
      lease: 'a'.repeat(64),
      ownerPid: 4242,
      ownerStartTime: '818181',
      protocol: STAGING_QUIESCENT_MAINTENANCE_PROTOCOL,
      rootDev: String(fs.lstatSync(controlRoot).dev),
      rootIno: String(fs.lstatSync(controlRoot).ino),
    });
    const containerStat = fs.lstatSync(container);
    const payloadStat = fs.lstatSync(payload);
    const validatedAuthority = Object.freeze({ ...binding.authority });
    assert.equal(binding.reclaimRetainedEvidence({
      authority: validatedAuthority,
      bounds: { maximumBytes: 1024, maximumEntries: 8 },
      container,
      containerIdentity: { dev: String(containerStat.dev), ino: String(containerStat.ino) },
      kind: 'RETIREMENT',
      payload,
      payloadIdentity: { dev: String(payloadStat.dev), ino: String(payloadStat.ino) },
      reservationBinding: null,
      root: controlRoot,
      tombstone: container,
    }), true);
    assert.equal(fs.existsSync(container), false);

    const recoveryDirectory = path.join(controlRoot, 'recovery-directory');
    const origin = path.join(recoveryDirectory, 'retirement.claim');
    const firstName = `.recovery-baton.${'1'.repeat(64)}.claim`;
    const secondName = `.recovery-baton.${'2'.repeat(64)}.claim`;
    fs.mkdirSync(recoveryDirectory, { mode: 0o700 });
    fs.writeFileSync(origin, 'baton');
    fs.linkSync(origin, path.join(recoveryDirectory, firstName));
    fs.linkSync(origin, path.join(recoveryDirectory, secondName));
    const batonStat = fs.lstatSync(origin);
    assert.equal(binding.rotateRecoveryBatonEpoch({
      authority: validatedAuthority,
      directory: recoveryDirectory,
      expectedIdentity: { dev: String(batonStat.dev), ino: String(batonStat.ino) },
      kind: 'RECOVERY_BATON_EPOCH',
      names: ['retirement.claim', firstName, secondName],
      root: controlRoot,
      source: path.join(recoveryDirectory, secondName),
    }), true);
    assert.deepEqual(fs.readdirSync(recoveryDirectory), ['retirement.claim']);
    assert.equal(fs.lstatSync(origin).nlink, 1);
  } finally {
    fs.rmSync(temporaryRoot, { force: true, recursive: true });
  }
});

test('production reclaimer accepts a publication pair after its source-name retirement', () => {
  const fixture = createMaintenanceFixture('easyboost-maintenance-publication-pair-');
  const retained = writeRetainedFixture(
    fixture.controlRoot,
    '.easyboost-staging-quarantine-slot.fixture.tombstone',
    { retainedSource: true },
  );
  try {
    const binding = bindStagingQuiescentMaintenanceRoot(
      consumeFixture({
        environment: {
          [STAGING_QUIESCENT_MAINTENANCE_ENVIRONMENT]:
            stagingQuiescentMaintenanceEnvironmentValue(fixture.lockBytes),
        },
        ...fixture,
      }),
      fixture.controlRoot,
      { randomToken: () => '1'.repeat(64), synchronizeDirectory() {} },
    );

    assert.equal(binding.reclaimRetainedEvidence(retainedRequest(
      binding, fixture.controlRoot, retained.container, retained.payload,
    )), true);
    assert.equal(fs.existsSync(retained.container), false);
  } finally {
    fs.rmSync(fixture.temporaryRoot, { force: true, recursive: true });
  }
});

test('production reclaimer removes an exact empty claimless fixed-slot reservation', () => {
  const fixture = createMaintenanceFixture('easyboost-maintenance-claimless-');
  const container = path.join(
    fixture.controlRoot,
    `.easyboost-staging-quarantine-slot.${'1'.repeat(64)}.tombstone`,
  );
  fs.mkdirSync(container, { mode: 0o700 });
  try {
    const binding = bindStagingQuiescentMaintenanceRoot(
      consumeFixture({
        environment: {
          [STAGING_QUIESCENT_MAINTENANCE_ENVIRONMENT]:
            stagingQuiescentMaintenanceEnvironmentValue(fixture.lockBytes),
        },
        ...fixture,
      }),
      fixture.controlRoot,
      { randomToken: () => '2'.repeat(64), synchronizeDirectory() {} },
    );
    const identity = fs.lstatSync(container);

    assert.equal(binding.reclaimRetainedEvidence({
      authority: binding.authority,
      bounds: { maximumBytes: 4096, maximumEntries: 16 },
      container,
      containerIdentity: { dev: String(identity.dev), ino: String(identity.ino) },
      kind: 'CLAIMLESS_RESERVATION',
      payload: null,
      payloadIdentity: null,
      reservationBinding: null,
      root: fixture.controlRoot,
      tombstone: container,
    }), true);
    assert.equal(fs.existsSync(container), false);
  } finally {
    fs.rmSync(fixture.temporaryRoot, { force: true, recursive: true });
  }
});

test('production reclaimer restarts an exact reservation-only deletion transaction', async () => {
  const fixture = createMaintenanceFixture('easyboost-maintenance-reservation-only-');
  const container = path.join(
    fixture.controlRoot,
    `.easyboost-staging-quarantine-slot.${'3'.repeat(64)}.tombstone`,
  );
  fs.mkdirSync(container, { mode: 0o700 });
  const record = {
    owner: '4'.repeat(64),
    purpose: 'cleanup',
    sourceDev: '12',
    sourceIno: '34',
  };
  const bytes = Buffer.from(`${JSON.stringify(record)}\n`);
  const reservation = path.join(container, 'reservation.claim');
  fs.writeFileSync(reservation, bytes, { mode: 0o600 });
  try {
    const crashModule = await freshMaintenanceModule();
    const crashBinding = crashModule.bindStagingQuiescentMaintenanceRoot(
      consumeFreshProof(crashModule, fixture),
      fixture.controlRoot,
      {
        onMaintenanceTransition(phase) {
          if (phase === 'payload-moved') throw new Error('fixture reservation-only crash');
        },
        randomToken: () => '5'.repeat(64),
        synchronizeDirectory() {},
      },
    );
    const containerIdentity = fs.lstatSync(container);
    assert.throws(() => crashBinding.reclaimRetainedEvidence({
      authority: crashBinding.authority,
      bounds: { maximumBytes: 4096, maximumEntries: 16 },
      container,
      containerIdentity: {
        dev: String(containerIdentity.dev), ino: String(containerIdentity.ino),
      },
      kind: 'RESERVATION_ONLY',
      payload: null,
      payloadIdentity: null,
      reservationBinding: {
        ...record,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      },
      root: fixture.controlRoot,
      tombstone: container,
    }), /fixture reservation-only crash/u);
    assert.equal(fs.existsSync(container), false);
    const [transaction] = deletionTransactions(fixture.controlRoot);
    assert.deepEqual(fs.readdirSync(path.join(fixture.controlRoot, transaction)).sort(),
      ['claim', 'payload']);

    const replayModule = await freshMaintenanceModule();
    replayModule.bindStagingQuiescentMaintenanceRoot(
      consumeFreshProof(replayModule, fixture),
      fixture.controlRoot,
      { randomToken: () => '6'.repeat(64), synchronizeDirectory() {} },
    );
    assert.deepEqual(deletionTransactions(fixture.controlRoot), []);
    assert.equal(fs.existsSync(container), false);
  } finally {
    fs.rmSync(fixture.temporaryRoot, { force: true, recursive: true });
  }
});

test('a revoked lock or replaced payload is retained instead of reclaimed', () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'easyboost-maintenance-retain-'));
  const installRoot = path.join(temporaryRoot, 'install');
  const controlRoot = path.join(temporaryRoot, 'control');
  const lockPath = path.join(installRoot, 'maintenance.lock');
  const container = path.join(controlRoot, '.fixture-slot.tombstone');
  const payload = path.join(container, 'payload');
  fs.mkdirSync(installRoot, { mode: 0o700 });
  fs.mkdirSync(controlRoot, { mode: 0o700 });
  fs.mkdirSync(container, { mode: 0o700 });
  fs.writeFileSync(path.join(container, 'reservation.claim'), '{"fixture":true}\n');
  fs.writeFileSync(payload, 'original');
  const lockBytes = stagingQuiescentMaintenanceLockBytes(installRoot);
  fs.writeFileSync(lockPath, lockBytes, { mode: 0o600 });
  fs.chmodSync(lockPath, 0o600);
  const held = { value: true };
  const environment = {
    [STAGING_QUIESCENT_MAINTENANCE_ENVIRONMENT]:
      stagingQuiescentMaintenanceEnvironmentValue(lockBytes),
  };
  try {
    const proof = consumeFixture({ environment, held, installRoot, lockBytes, lockPath });
    const binding = bindStagingQuiescentMaintenanceRoot(proof, controlRoot, {
      randomToken: () => 'b'.repeat(64),
      synchronizeDirectory() {},
    });
    const containerStat = fs.lstatSync(container);
    const payloadStat = fs.lstatSync(payload);
    const request = {
      authority: binding.authority,
      bounds: { maximumBytes: 1024, maximumEntries: 8 },
      container,
      containerIdentity: { dev: String(containerStat.dev), ino: String(containerStat.ino) },
      kind: 'RETIREMENT',
      payload,
      payloadIdentity: { dev: String(payloadStat.dev), ino: String(payloadStat.ino) },
      reservationBinding: null,
      root: controlRoot,
      tombstone: container,
    };
    assert.equal(binding.reclaimRetainedEvidence({
      authority: binding.authority,
      kind: 'QUIESCENT_ABSENCE_PROOF',
      root: controlRoot,
    }), true);
    assert.equal(fs.existsSync(container), true,
      'quiescent absence proof must not mutate retained evidence');
    held.value = false;
    assert.throws(() => binding.reclaimRetainedEvidence({
      authority: binding.authority,
      kind: 'QUIESCENT_ABSENCE_PROOF',
      root: controlRoot,
    }), /lock is no longer proven/u);
    assert.throws(() => binding.reclaimRetainedEvidence(request), /lock is no longer proven/u);
    assert.equal(fs.existsSync(container), true);
    held.value = true;
    fs.rmSync(payload);
    fs.writeFileSync(payload, 'replacement');
    assert.throws(() => binding.reclaimRetainedEvidence(request), /changed before reclaim/u);
    assert.equal(fs.readFileSync(payload, 'utf8'), 'replacement');
  } finally {
    fs.rmSync(temporaryRoot, { force: true, recursive: true });
  }
});

test('fresh startup resumes an empty pre-claim transaction and a durable move before marker',
  async () => {
    const fixture = createMaintenanceFixture('easyboost-maintenance-restart-move-');
    const retained = writeRetainedFixture(
      fixture.controlRoot, '.fixture-restart-slot.tombstone',
    );
    try {
      const beforeClaimModule = await freshMaintenanceModule();
      const beforeClaimProof = consumeFreshProof(beforeClaimModule, fixture);
      const beforeClaimBinding = beforeClaimModule.bindStagingQuiescentMaintenanceRoot(
        beforeClaimProof,
        fixture.controlRoot,
        {
          onMaintenanceTransition(phase) {
            if (phase === 'transaction-created') throw new Error('fixture crash before claim');
          },
          randomToken: () => '1'.repeat(64),
          synchronizeDirectory() {},
        },
      );
      assert.throws(() => beforeClaimBinding.reclaimRetainedEvidence(retainedRequest(
        beforeClaimBinding, fixture.controlRoot, retained.container, retained.payload, 'RETIREMENT',
      )), /fixture crash before claim/u);
      const [emptyTransaction] = deletionTransactions(fixture.controlRoot);
      assert.deepEqual(fs.readdirSync(path.join(fixture.controlRoot, emptyTransaction)), []);
      assert.equal(fs.existsSync(retained.container), true);

      const emptyRecoveryModule = await freshMaintenanceModule();
      emptyRecoveryModule.bindStagingQuiescentMaintenanceRoot(
        consumeFreshProof(emptyRecoveryModule, fixture),
        fixture.controlRoot,
        { randomToken: () => '2'.repeat(64), synchronizeDirectory() {} },
      );
      assert.deepEqual(deletionTransactions(fixture.controlRoot), []);
      assert.equal(fs.existsSync(retained.container), true);

      const moveCrashModule = await freshMaintenanceModule();
      const moveCrashBinding = moveCrashModule.bindStagingQuiescentMaintenanceRoot(
        consumeFreshProof(moveCrashModule, fixture),
        fixture.controlRoot,
        {
          onMaintenanceTransition(phase) {
            if (phase === 'payload-moved') throw new Error('fixture crash after durable move');
          },
          randomToken: () => '3'.repeat(64),
          synchronizeDirectory() {},
        },
      );
      assert.throws(() => moveCrashBinding.reclaimRetainedEvidence(retainedRequest(
        moveCrashBinding, fixture.controlRoot, retained.container, retained.payload, 'RETIREMENT',
      )), /fixture crash after durable move/u);
      assert.equal(fs.existsSync(retained.container), false);
      const [movedTransaction] = deletionTransactions(fixture.controlRoot);
      assert.deepEqual(fs.readdirSync(path.join(fixture.controlRoot, movedTransaction)).sort(),
        ['claim', 'payload']);
      assert.throws(() => moveCrashBinding.reclaimRetainedEvidence({
        authority: moveCrashBinding.authority,
        kind: 'QUIESCENT_ABSENCE_PROOF',
        root: fixture.controlRoot,
      }), /pending deletion evidence/u,
      'a live authority must not infer absence while its helper journal retains the payload');

      const moveRecoveryModule = await freshMaintenanceModule();
      moveRecoveryModule.bindStagingQuiescentMaintenanceRoot(
        consumeFreshProof(moveRecoveryModule, fixture),
        fixture.controlRoot,
        { randomToken: () => '4'.repeat(64), synchronizeDirectory() {} },
      );
      assert.deepEqual(deletionTransactions(fixture.controlRoot), []);
      assert.equal(fs.existsSync(retained.container), false);
      fs.mkdirSync(retained.container, { mode: 0o700 });
      assert.equal(fs.lstatSync(retained.container).isDirectory(), true);
    } finally {
      fs.rmSync(fixture.temporaryRoot, { force: true, recursive: true });
    }
  });

test('fresh startup resumes partial recursive deletion and payload-absent completion', async () => {
  const fixture = createMaintenanceFixture('easyboost-maintenance-restart-rm-');
  const retained = writeRetainedFixture(
    fixture.controlRoot, '.fixture-partial-slot.tombstone', { directoryPayload: true },
  );
  try {
    const seedModule = await freshMaintenanceModule();
    const seedBinding = seedModule.bindStagingQuiescentMaintenanceRoot(
      consumeFreshProof(seedModule, fixture),
      fixture.controlRoot,
      {
        onMaintenanceTransition(phase) {
          if (phase === 'payload-moved') throw new Error('fixture seed crash');
        },
        randomToken: () => '5'.repeat(64),
        synchronizeDirectory() {},
      },
    );
    assert.throws(() => seedBinding.reclaimRetainedEvidence(retainedRequest(
      seedBinding, fixture.controlRoot, retained.container, retained.payload, 'RETIREMENT',
    )), /fixture seed crash/u);
    const [transactionName] = deletionTransactions(fixture.controlRoot);
    const transactionPath = path.join(fixture.controlRoot, transactionName);
    const movedPayload = path.join(transactionPath, 'payload', 'payload');

    const partialModule = await freshMaintenanceModule();
    assert.throws(() => partialModule.bindStagingQuiescentMaintenanceRoot(
      consumeFreshProof(partialModule, fixture),
      fixture.controlRoot,
      {
        randomToken: () => '6'.repeat(64),
        removeRetainedTree(entry) {
          fs.rmSync(path.join(entry, 'payload', 'first'));
          throw new Error('fixture crash during recursive deletion');
        },
        synchronizeDirectory() {},
      },
    ), /fixture crash during recursive deletion/u);
    assert.equal(fs.existsSync(path.join(movedPayload, 'first')), false);
    assert.equal(fs.readFileSync(path.join(movedPayload, 'second'), 'utf8'), 'second');
    assert.deepEqual(fs.readdirSync(transactionPath).sort(), ['claim', 'moved', 'payload']);

    const absenceModule = await freshMaintenanceModule();
    assert.throws(() => absenceModule.bindStagingQuiescentMaintenanceRoot(
      consumeFreshProof(absenceModule, fixture),
      fixture.controlRoot,
      {
        onMaintenanceTransition(phase) {
          if (phase === 'payload-removed') throw new Error('fixture crash after absence');
        },
        randomToken: () => '7'.repeat(64),
        synchronizeDirectory() {},
      },
    ), /fixture crash after absence/u);
    assert.equal(fs.existsSync(path.join(transactionPath, 'payload')), false);
    assert.deepEqual(fs.readdirSync(transactionPath).sort(), ['claim', 'moved']);

    const completionModule = await freshMaintenanceModule();
    completionModule.bindStagingQuiescentMaintenanceRoot(
      consumeFreshProof(completionModule, fixture),
      fixture.controlRoot,
      { randomToken: () => '8'.repeat(64), synchronizeDirectory() {} },
    );
    assert.deepEqual(deletionTransactions(fixture.controlRoot), []);
    fs.mkdirSync(retained.container, { mode: 0o700 });
    assert.equal(fs.existsSync(retained.container), true);
  } finally {
    fs.rmSync(fixture.temporaryRoot, { force: true, recursive: true });
  }
});

test('startup retains source and moved-payload ABA plus a foreign exact transaction', async () => {
  const abaFixture = createMaintenanceFixture('easyboost-maintenance-aba-');
  const retained = writeRetainedFixture(
    abaFixture.controlRoot, '.fixture-aba-slot.tombstone',
  );
  try {
    const crashModule = await freshMaintenanceModule();
    const crashBinding = crashModule.bindStagingQuiescentMaintenanceRoot(
      consumeFreshProof(crashModule, abaFixture),
      abaFixture.controlRoot,
      {
        onMaintenanceTransition(phase) {
          if (phase === 'claim-published') throw new Error('fixture crash before move');
        },
        randomToken: () => '9'.repeat(64),
        synchronizeDirectory() {},
      },
    );
    assert.throws(() => crashBinding.reclaimRetainedEvidence(retainedRequest(
      crashBinding, abaFixture.controlRoot, retained.container, retained.payload, 'RETIREMENT',
    )), /fixture crash before move/u);
    fs.rmSync(retained.container, { force: false, recursive: true });
    const replacement = writeRetainedFixture(
      abaFixture.controlRoot, '.fixture-aba-slot.tombstone',
    );
    fs.writeFileSync(replacement.payload, 'replacement');
    const replayModule = await freshMaintenanceModule();
    assert.throws(() => replayModule.bindStagingQuiescentMaintenanceRoot(
      consumeFreshProof(replayModule, abaFixture),
      abaFixture.controlRoot,
      { randomToken: () => 'a'.repeat(64), synchronizeDirectory() {} },
    ), /source changed before move/u);
    assert.equal(fs.readFileSync(replacement.payload, 'utf8'), 'replacement');
    assert.equal(deletionTransactions(abaFixture.controlRoot).length, 1);
  } finally {
    fs.rmSync(abaFixture.temporaryRoot, { force: true, recursive: true });
  }

  const movedAbaFixture = createMaintenanceFixture('easyboost-maintenance-moved-aba-');
  const movedRetained = writeRetainedFixture(
    movedAbaFixture.controlRoot, '.fixture-moved-aba-slot.tombstone',
  );
  try {
    const crashModule = await freshMaintenanceModule();
    const crashBinding = crashModule.bindStagingQuiescentMaintenanceRoot(
      consumeFreshProof(crashModule, movedAbaFixture),
      movedAbaFixture.controlRoot,
      {
        onMaintenanceTransition(phase) {
          if (phase === 'payload-moved') throw new Error('fixture crash after moved ABA seed');
        },
        randomToken: () => 'c'.repeat(64),
        synchronizeDirectory() {},
      },
    );
    assert.throws(() => crashBinding.reclaimRetainedEvidence(retainedRequest(
      crashBinding,
      movedAbaFixture.controlRoot,
      movedRetained.container,
      movedRetained.payload,
      'RETIREMENT',
    )), /fixture crash after moved ABA seed/u);
    const [transactionName] = deletionTransactions(movedAbaFixture.controlRoot);
    const transactionPath = path.join(movedAbaFixture.controlRoot, transactionName);
    fs.rmSync(path.join(transactionPath, 'payload'), { force: false, recursive: true });
    const replacement = writeRetainedFixture(transactionPath, 'payload');
    fs.writeFileSync(replacement.payload, 'foreign replacement');
    const replayModule = await freshMaintenanceModule();
    assert.throws(() => replayModule.bindStagingQuiescentMaintenanceRoot(
      consumeFreshProof(replayModule, movedAbaFixture),
      movedAbaFixture.controlRoot,
      { randomToken: () => 'd'.repeat(64), synchronizeDirectory() {} },
    ), /moved payload changed/u);
    assert.equal(fs.readFileSync(replacement.payload, 'utf8'), 'foreign replacement');
    assert.equal(fs.existsSync(transactionPath), true);
  } finally {
    fs.rmSync(movedAbaFixture.temporaryRoot, { force: true, recursive: true });
  }

  const foreignFixture = createMaintenanceFixture('easyboost-maintenance-foreign-');
  const foreign = path.join(
    foreignFixture.controlRoot, `.maintenance-deletion.${'f'.repeat(64)}`,
  );
  fs.mkdirSync(foreign, { mode: 0o700 });
  fs.writeFileSync(path.join(foreign, 'claim'), '{}\n', { mode: 0o600 });
  try {
    const replayModule = await freshMaintenanceModule();
    assert.throws(() => replayModule.bindStagingQuiescentMaintenanceRoot(
      consumeFreshProof(replayModule, foreignFixture),
      foreignFixture.controlRoot,
      { randomToken: () => 'b'.repeat(64), synchronizeDirectory() {} },
    ), /deletion claim is invalid/u);
    assert.equal(fs.readFileSync(path.join(foreign, 'claim'), 'utf8'), '{}\n');
    assert.equal(fs.existsSync(foreign), true);
  } finally {
    fs.rmSync(foreignFixture.temporaryRoot, { force: true, recursive: true });
  }
});

test('startup retains and rejects every malformed reserved deletion namespace name', () => {
  const fixture = createMaintenanceFixture('easyboost-maintenance-reserved-prefix-');
  const malformed = path.join(fixture.controlRoot, '.maintenance-deletion.bad');
  fs.mkdirSync(malformed, { mode: 0o700 });
  fs.writeFileSync(path.join(malformed, 'foreign'), 'must survive');
  try {
    const proof = consumeFixture({
      environment: {
        [STAGING_QUIESCENT_MAINTENANCE_ENVIRONMENT]:
          stagingQuiescentMaintenanceEnvironmentValue(fixture.lockBytes),
      },
      held: fixture.held,
      installRoot: fixture.installRoot,
      lockBytes: fixture.lockBytes,
      lockPath: fixture.lockPath,
    });
    assert.throws(() => bindStagingQuiescentMaintenanceRoot(
      proof,
      fixture.controlRoot,
      { randomToken: () => 'e'.repeat(64), synchronizeDirectory() {} },
    ), /reserved deletion namespace name is invalid/u);
    assert.equal(fs.readFileSync(path.join(malformed, 'foreign'), 'utf8'), 'must survive');
  } finally {
    fs.rmSync(fixture.temporaryRoot, { force: true, recursive: true });
  }
});

test('recovery baton epoch rotation rejects a 33-link authority without mutation', () => {
  const fixture = createMaintenanceFixture('easyboost-maintenance-baton-cap-');
  const directory = path.join(fixture.controlRoot, 'recovery-directory');
  const origin = path.join(directory, 'retirement.claim');
  fs.mkdirSync(directory, { mode: 0o700 });
  fs.writeFileSync(origin, 'baton');
  const names = ['retirement.claim'];
  for (let index = 0; index < 32; index += 1) {
    const name = `.recovery-baton.${index.toString(16).padStart(64, '0')}.claim`;
    fs.linkSync(origin, path.join(directory, name));
    names.push(name);
  }
  try {
    const proof = consumeFixture({
      environment: {
        [STAGING_QUIESCENT_MAINTENANCE_ENVIRONMENT]:
          stagingQuiescentMaintenanceEnvironmentValue(fixture.lockBytes),
      },
      held: fixture.held,
      installRoot: fixture.installRoot,
      lockBytes: fixture.lockBytes,
      lockPath: fixture.lockPath,
    });
    const binding = bindStagingQuiescentMaintenanceRoot(proof, fixture.controlRoot, {
      randomToken: () => 'f'.repeat(64), synchronizeDirectory() {},
    });
    const identity = fs.lstatSync(origin);
    assert.throws(() => binding.rotateRecoveryBatonEpoch({
      authority: binding.authority,
      directory,
      expectedIdentity: { dev: String(identity.dev), ino: String(identity.ino) },
      kind: 'RECOVERY_BATON_EPOCH',
      names,
      root: fixture.controlRoot,
      source: path.join(directory, names.at(-1)),
    }), /epoch request is invalid/u);
    assert.equal(fs.lstatSync(origin).nlink, 33);
    assert.deepEqual(fs.readdirSync(directory).sort(), [...names].sort());
  } finally {
    fs.rmSync(fixture.temporaryRoot, { force: true, recursive: true });
  }
});

test('missing authority is optional, but an unheld supplied authority fails closed', () => {
  const empty = {};
  assert.equal(consumeStagingQuiescentMaintenanceLock({ environment: empty }), undefined);
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'easyboost-maintenance-unheld-'));
  const installRoot = path.join(temporaryRoot, 'install');
  const lockPath = path.join(installRoot, 'maintenance.lock');
  fs.mkdirSync(installRoot, { mode: 0o700 });
  const lockBytes = stagingQuiescentMaintenanceLockBytes(installRoot);
  fs.writeFileSync(lockPath, lockBytes, { mode: 0o600 });
  const environment = {
    [STAGING_QUIESCENT_MAINTENANCE_ENVIRONMENT]:
      stagingQuiescentMaintenanceEnvironmentValue(lockBytes),
  };
  try {
    assert.throws(() => consumeFixture({
      environment,
      held: { value: false },
      installRoot,
      lockBytes,
      lockPath,
    }), /exclusive lock is not held/u);
    assert.equal(environment[STAGING_QUIESCENT_MAINTENANCE_ENVIRONMENT], undefined);
  } finally {
    fs.rmSync(temporaryRoot, { force: true, recursive: true });
  }
});
