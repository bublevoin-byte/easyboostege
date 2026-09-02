import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  recoverRetainedProductionRestore,
  runRetainedProductionRestoreRecoveryCli,
} from '../scripts/production-restore-recovery.js';
import { restorePostgresBackup } from '../scripts/postgres-restore.js';

const APP_IMAGE_ID = `sha256:${'a'.repeat(64)}`;
const POSTGRES_IMAGE_ID = `sha256:${'b'.repeat(64)}`;
const POSTGRES_CONTAINER_ID = 'c'.repeat(64);
const APP_CONTAINER_ID = 'd'.repeat(64);
const OPERATION_TOKEN = '12345678-1234-4abc-8def-1234567890ab';
const APPLICATION_NAME = `easyboost_restore_${OPERATION_TOKEN}`;
const COMPOSE_PROJECT = 'easyboost-production';
const ABSENCE_LEASE_PROTOCOL = 'easyboost-database-operation-lock-absence-lease-v1';
const DATABASE_LOCK_FILE = path.resolve('backups', '.restore-recovery-test.lock');
const HOST_LOCK_DIRECTORY = path.resolve('fake-restore-recovery-host.lock');

function restoreEvidence(overrides = {}) {
  return {
    applicationName: APPLICATION_NAME,
    kind: 'restore',
    lastProbe: {
      activityCount: 2,
      process: 'ACTIVE',
      status: 'RUNNING',
    },
    operationToken: OPERATION_TOKEN,
    postgresContainerId: POSTGRES_CONTAINER_ID,
    ...overrides,
  };
}

function productionEnvironment() {
  return {
    EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID: POSTGRES_IMAGE_ID,
    EASYBOOST_PRODUCTION_APP_IMAGE_ID: APP_IMAGE_ID,
  };
}

function databaseAbsenceLease(lockFile = DATABASE_LOCK_FILE, overrides = {}) {
  return {
    absent: true,
    lockFile,
    protocol: ABSENCE_LEASE_PROTOCOL,
    release: async () => {},
    ...overrides,
  };
}

function recoveryEnvironment(overrides = {}) {
  return {
    ...productionEnvironment(),
    EASYBOOST_HOST_OPERATION_LOCK_DIR: HOST_LOCK_DIRECTORY,
    ...overrides,
  };
}

test('stopped exact PostgreSQL proves settlement without exec and completes DB before host', async () => {
  const composeFile = path.resolve('compose.production.yml');
  const calls = [];
  const completions = [];
  const runDocker = async (args, options) => {
    calls.push({ args, options });
    if (args[0] === 'compose' && args.at(-1) === 'postgres') return POSTGRES_CONTAINER_ID;
    if (args[0] === 'compose' && args.at(-1) === 'app') return '';
    if (args[0] === 'inspect' && args.at(-1) === POSTGRES_CONTAINER_ID) {
      return [
        POSTGRES_CONTAINER_ID,
        POSTGRES_IMAGE_ID,
        COMPOSE_PROJECT,
        'postgres',
        'False',
        'false',
      ].join('|');
    }
    throw new Error(`Unexpected Docker command: ${args.join(' ')}`);
  };

  const result = await recoverRetainedProductionRestore({
    completeDatabaseLock: async () => { completions.push('database'); },
    completeHostGuard: async () => { completions.push('host'); },
    composeFile,
    environment: productionEnvironment(),
    evidence: restoreEvidence(),
    reason: 'REMOTE_RESTORE_SETTLEMENT_UNPROVEN',
    runDocker,
  });

  assert.deepEqual(completions, ['database', 'host']);
  assert.equal(calls.some(({ args }) => args.includes('exec')), false);
  assert.deepEqual(result, {
    databaseUsable: false,
    guardRecoveryCompleted: true,
    postgresContainerId: POSTGRES_CONTAINER_ID,
    postgresState: 'stopped',
    requiredOperatorAction: 'RERUN_FULL_GUARDED_DATABASE_ONLY_RESTORE',
  });
  assert.ok(calls.every(({ options }) => options.capture === true));
  assert.ok(calls.every(({ options }) => Number.isSafeInteger(options.commandTimeoutMs)
    && options.commandTimeoutMs >= 1
    && options.commandTimeoutMs <= 20_000));
  assert.ok(calls.every(({ options }) => options.maxCaptureBytes === 4_096));
});

test('running exact PostgreSQL requires token process NONE and zero matching activity', async () => {
  const calls = [];
  const runDocker = async (args, options) => {
    calls.push({ args, options });
    if (args[0] === 'compose' && args.at(-1) === 'postgres') return POSTGRES_CONTAINER_ID;
    if (args[0] === 'compose' && args.at(-1) === 'app') return '';
    if (args[0] === 'inspect') {
      return [
        POSTGRES_CONTAINER_ID,
        POSTGRES_IMAGE_ID,
        COMPOSE_PROJECT,
        'postgres',
        'False',
        'true',
      ].join('|');
    }
    if (args[0] === 'exec') {
      return 'PROCESS_BEFORE=NONE\nACTIVITY=0\nPROCESS_AFTER=NONE';
    }
    throw new Error(`Unexpected Docker command: ${args.join(' ')}`);
  };

  const result = await recoverRetainedProductionRestore({
    completeDatabaseLock: async () => {},
    completeHostGuard: async () => {},
    environment: productionEnvironment(),
    evidence: restoreEvidence(),
    reason: 'REMOTE_RESTORE_SETTLEMENT_UNPROVEN',
    runDocker,
  });

  assert.equal(result.postgresState, 'running');
  const execCall = calls.find(({ args }) => args[0] === 'exec');
  assert.ok(execCall);
  assert.equal(execCall.args.includes(OPERATION_TOKEN), true);
  assert.equal(execCall.args.includes(APPLICATION_NAME), true);
  assert.equal(execCall.options.commandTimeoutMs, 10_000);
  assert.equal(execCall.options.maxCaptureBytes, 4_096);
  assert.deepEqual(execCall.options.environment, productionEnvironment());
});

test('application-isolation recovery stops only the exact approved running app allocation', async () => {
  let appStopped = false;
  const calls = [];
  const runDocker = async (args) => {
    calls.push(args);
    if (args[0] === 'compose' && args.at(-1) === 'postgres') return POSTGRES_CONTAINER_ID;
    if (args[0] === 'compose' && args.at(-1) === 'app') return APP_CONTAINER_ID;
    if (args[0] === 'inspect' && args.at(-1) === POSTGRES_CONTAINER_ID) {
      return [
        POSTGRES_CONTAINER_ID,
        POSTGRES_IMAGE_ID,
        COMPOSE_PROJECT,
        'postgres',
        'False',
        'false',
      ].join('|');
    }
    if (args[0] === 'inspect' && args.at(-1) === APP_CONTAINER_ID) {
      return [
        APP_CONTAINER_ID,
        APP_IMAGE_ID,
        COMPOSE_PROJECT,
        'app',
        'False',
        String(!appStopped),
      ].join('|');
    }
    if (args[0] === 'stop') {
      assert.deepEqual(args, ['stop', '--time', '10', APP_CONTAINER_ID]);
      appStopped = true;
      return APP_CONTAINER_ID;
    }
    throw new Error(`Unexpected Docker command: ${args.join(' ')}`);
  };

  const result = await recoverRetainedProductionRestore({
    completeDatabaseLock: async () => {},
    completeHostGuard: async () => {},
    environment: productionEnvironment(),
    evidence: restoreEvidence(),
    reason: 'APPLICATION_ISOLATION_UNPROVEN_AFTER_DATABASE_RESTORE',
    runDocker,
  });

  assert.equal(appStopped, true);
  assert.equal(result.applicationIsolation, 'exact-app-stopped');
  assert.equal(calls.filter((args) => args[0] === 'stop').length, 1);
  assert.ok(calls.filter((args) => args[0] === 'inspect'
    && args.at(-1) === APP_CONTAINER_ID).length >= 2);
});

test('PostgreSQL allocation swap before completion fails closed without guard mutation', async () => {
  const swappedContainerId = 'e'.repeat(64);
  let postgresInventories = 0;
  const completions = [];
  const runDocker = async (args) => {
    if (args[0] === 'compose' && args.at(-1) === 'postgres') {
      postgresInventories += 1;
      return postgresInventories === 1 ? POSTGRES_CONTAINER_ID : swappedContainerId;
    }
    if (args[0] === 'compose' && args.at(-1) === 'app') return '';
    if (args[0] === 'inspect') {
      return [
        POSTGRES_CONTAINER_ID,
        POSTGRES_IMAGE_ID,
        COMPOSE_PROJECT,
        'postgres',
        'False',
        'false',
      ].join('|');
    }
    throw new Error(`Unexpected Docker command: ${args.join(' ')}`);
  };

  await assert.rejects(recoverRetainedProductionRestore({
    completeDatabaseLock: async () => { completions.push('database'); },
    completeHostGuard: async () => { completions.push('host'); },
    environment: productionEnvironment(),
    evidence: restoreEvidence(),
    reason: 'REMOTE_RESTORE_SETTLEMENT_UNPROVEN',
    runDocker,
  }), /PostgreSQL allocation changed/u);
  assert.deepEqual(completions, []);
  assert.equal(postgresInventories, 2);
});

test('CLI rejects a foreign initial DB absence lease before recovery or guard mutation', async () => {
  const effects = [];
  const environment = recoveryEnvironment();
  const databaseLockModule = {
    DEFAULT_DATABASE_OPERATION_LOCK_FILE: DATABASE_LOCK_FILE,
    async openDatabaseOperationLockAbsenceProof() {
      assert.fail('foreign initial absence authority must fail before reopen');
    },
    async openRetainedDatabaseOperationLock() {
      assert.fail('foreign initial absence authority must fail before retained open');
    },
    async proveDatabaseOperationLockAbsent(options) {
      assert.deepEqual(options, { lockFile: DATABASE_LOCK_FILE });
      return databaseAbsenceLease(path.resolve('foreign-database.lock'), {
        release: async () => { effects.push('database-release'); },
      });
    },
  };
  const hostLockModule = {
    DEFAULT_HOST_OPERATION_LOCK_DIRECTORY: HOST_LOCK_DIRECTORY,
    async openRetainedHostOperationLock() {
      return {
        complete: async () => { effects.push('host-complete'); },
        evidence: restoreEvidence(),
        lockDirectory: HOST_LOCK_DIRECTORY,
        operation: 'database-restore',
        reason: 'REMOTE_RESTORE_SETTLEMENT_UNPROVEN',
      };
    },
  };

  await assert.rejects(runRetainedProductionRestoreRecoveryCli({
    databaseLockModule,
    environment,
    hostLockModule,
    runRecovery: async () => { effects.push('recovery'); },
  }), /absence lease is invalid/u);

  await new Promise((resolve) => { setImmediate(resolve); });
  assert.deepEqual(effects, []);
});

test('CLI validates the DB absence lease created after retained DB completion', async () => {
  const effects = [];
  let absenceProofCalls = 0;
  const environment = recoveryEnvironment();
  const databaseLockModule = {
    DEFAULT_DATABASE_OPERATION_LOCK_FILE: DATABASE_LOCK_FILE,
    async openDatabaseOperationLockAbsenceProof() {
      const error = new Error('retained marker has no absence lease yet');
      error.code = 'DATABASE_OPERATION_LOCK_ABSENCE_LEASE_AMBIGUOUS';
      throw error;
    },
    async openRetainedDatabaseOperationLock(options) {
      assert.deepEqual(options, {
        expectedEvidenceKind: 'restore',
        lockFile: DATABASE_LOCK_FILE,
      });
      return {
        complete: async () => { effects.push('database-complete'); },
        evidence: restoreEvidence(),
        legacy: false,
        reason: 'REMOTE_RESTORE_SETTLEMENT_UNPROVEN',
      };
    },
    async proveDatabaseOperationLockAbsent(options) {
      assert.deepEqual(options, { lockFile: DATABASE_LOCK_FILE });
      absenceProofCalls += 1;
      if (absenceProofCalls === 1) {
        const error = new Error('retained DB marker exists');
        error.code = 'DATABASE_OPERATION_LOCK_NOT_ABSENT';
        throw error;
      }
      return databaseAbsenceLease(path.resolve('foreign-database.lock'), {
        release: async () => { effects.push('database-release'); },
      });
    },
  };
  const hostLockModule = {
    DEFAULT_HOST_OPERATION_LOCK_DIRECTORY: HOST_LOCK_DIRECTORY,
    async openRetainedHostOperationLock() {
      return {
        complete: async () => { effects.push('host-complete'); },
        evidence: restoreEvidence(),
        lockDirectory: HOST_LOCK_DIRECTORY,
        operation: 'database-restore',
        reason: 'REMOTE_RESTORE_SETTLEMENT_UNPROVEN',
      };
    },
  };

  await assert.rejects(runRetainedProductionRestoreRecoveryCli({
    databaseLockModule,
    environment,
    hostLockModule,
    runRecovery: async ({ completeDatabaseLock, completeHostGuard }) => {
      effects.push('recovery');
      await completeDatabaseLock();
      await completeHostGuard();
    },
  }), /absence lease is invalid/u);

  await new Promise((resolve) => { setImmediate(resolve); });
  assert.deepEqual(effects, ['recovery', 'database-complete']);
});

test('CLI rejects a foreign reopened DB absence lease before host-only retry', async () => {
  const effects = [];
  const environment = recoveryEnvironment();
  const databaseLockModule = {
    DEFAULT_DATABASE_OPERATION_LOCK_FILE: DATABASE_LOCK_FILE,
    async openDatabaseOperationLockAbsenceProof(options) {
      assert.deepEqual(options, { lockFile: DATABASE_LOCK_FILE });
      return databaseAbsenceLease(path.resolve('foreign-database.lock'), {
        release: async () => { effects.push('database-release'); },
      });
    },
    async openRetainedDatabaseOperationLock(options) {
      assert.deepEqual(options, {
        expectedEvidenceKind: 'restore',
        lockFile: DATABASE_LOCK_FILE,
      });
      throw new Error('database marker is not retained');
    },
    async proveDatabaseOperationLockAbsent(options) {
      assert.deepEqual(options, { lockFile: DATABASE_LOCK_FILE });
      const error = new Error('persisted absence lease exists');
      error.code = 'DATABASE_OPERATION_LOCK_NOT_ABSENT';
      throw error;
    },
  };
  const hostLockModule = {
    DEFAULT_HOST_OPERATION_LOCK_DIRECTORY: HOST_LOCK_DIRECTORY,
    async openRetainedHostOperationLock() {
      return {
        complete: async () => { effects.push('host-complete'); },
        evidence: restoreEvidence(),
        lockDirectory: HOST_LOCK_DIRECTORY,
        operation: 'database-restore',
        reason: 'REMOTE_RESTORE_SETTLEMENT_UNPROVEN',
      };
    },
  };

  await assert.rejects(runRetainedProductionRestoreRecoveryCli({
    databaseLockModule,
    environment,
    hostLockModule,
    runRecovery: async () => { effects.push('recovery'); },
  }), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.match(error.errors[1].message, /absence lease is invalid/u);
    return true;
  });

  await new Promise((resolve) => { setImmediate(resolve); });
  assert.deepEqual(effects, []);
});

test('lease-only recovery rejects a foreign DB absence lease while the host lease is held',
  async () => {
    const effects = [];
    const environment = recoveryEnvironment();
    const hostMissing = new Error('retained host guard is absent');
    hostMissing.code = 'ENOENT';
    const databaseLockModule = {
      DEFAULT_DATABASE_OPERATION_LOCK_FILE: DATABASE_LOCK_FILE,
      async openDatabaseOperationLockAbsenceProof(options) {
        assert.deepEqual(options, { lockFile: DATABASE_LOCK_FILE });
        effects.push('database-open');
        return databaseAbsenceLease(path.resolve('foreign-database.lock'), {
          release: async () => { effects.push('database-release'); },
        });
      },
      async openRetainedDatabaseOperationLock() {},
      async proveDatabaseOperationLockAbsent() {},
    };
    const hostLockModule = {
      DEFAULT_HOST_OPERATION_LOCK_DIRECTORY: HOST_LOCK_DIRECTORY,
      async acquireHostOperationAbsenceLease(options) {
        assert.deepEqual(options, { environment });
        effects.push('host-acquire');
        return {
          lockDirectory: HOST_LOCK_DIRECTORY,
          release: async () => { effects.push('host-release'); },
          state: 'absent-leased',
        };
      },
      async openRetainedHostOperationLock() { throw hostMissing; },
    };

    await assert.rejects(runRetainedProductionRestoreRecoveryCli({
      databaseLockModule,
      environment,
      hostLockModule,
    }), /absence lease is invalid/u);

    await new Promise((resolve) => { setImmediate(resolve); });
    assert.deepEqual(effects, ['host-acquire', 'database-open', 'host-release']);
  });

test('normal recovery rejects a retained host handle for a foreign lock directory before DB access',
  async () => {
    const effects = [];
    const environment = recoveryEnvironment();
    await assert.rejects(runRetainedProductionRestoreRecoveryCli({
      databaseLockModule: {
        DEFAULT_DATABASE_OPERATION_LOCK_FILE: DATABASE_LOCK_FILE,
        async openDatabaseOperationLockAbsenceProof() { effects.push('database-open'); },
        async openRetainedDatabaseOperationLock() { effects.push('database-retained'); },
        async proveDatabaseOperationLockAbsent() { effects.push('database-prove'); },
      },
      environment,
      hostLockModule: {
        DEFAULT_HOST_OPERATION_LOCK_DIRECTORY: HOST_LOCK_DIRECTORY,
        async openRetainedHostOperationLock() {
          return {
            complete: async () => { effects.push('host-complete'); },
            evidence: restoreEvidence(),
            lockDirectory: path.resolve('foreign-host.lock'),
            operation: 'database-restore',
            reason: 'REMOTE_RESTORE_SETTLEMENT_UNPROVEN',
          };
        },
      },
      runRecovery: async () => { effects.push('recovery'); },
    }), /host operation lock authority is invalid/u);

    await new Promise((resolve) => { setImmediate(resolve); });
    assert.deepEqual(effects, []);
  });

test('lease-only recovery rejects a foreign host absence lease before DB mutation', async () => {
  const effects = [];
  const environment = recoveryEnvironment();
  const hostMissing = new Error('retained host guard is absent');
  hostMissing.code = 'ENOENT';
  await assert.rejects(runRetainedProductionRestoreRecoveryCli({
    databaseLockModule: {
      DEFAULT_DATABASE_OPERATION_LOCK_FILE: DATABASE_LOCK_FILE,
      async openDatabaseOperationLockAbsenceProof() { effects.push('database-open'); },
      async openRetainedDatabaseOperationLock() { effects.push('database-retained'); },
      async proveDatabaseOperationLockAbsent() { effects.push('database-prove'); },
    },
    environment,
    hostLockModule: {
      DEFAULT_HOST_OPERATION_LOCK_DIRECTORY: HOST_LOCK_DIRECTORY,
      async acquireHostOperationAbsenceLease() {
        effects.push('host-acquire');
        return {
          lockDirectory: path.resolve('foreign-host.lock'),
          release: async () => { effects.push('host-release'); },
          state: 'absent-leased',
        };
      },
      async openRetainedHostOperationLock() { throw hostMissing; },
    },
  }), /host operation absence lease adapter returned unsafe authority/iu);

  await new Promise((resolve) => { setImmediate(resolve); });
  assert.deepEqual(effects, ['host-acquire']);
});

test('CLI rejects wrong-protocol DB absence leases at all four recovery ingresses', async (t) => {
  for (const ingress of ['initial-prove', 'post-completion-prove', 'host-retry-open',
    'lease-only-open']) {
    await t.test(ingress, async () => {
      const effects = [];
      const environment = recoveryEnvironment();
      const evidence = restoreEvidence();
      let proofCalls = 0;
      const wrongProtocolLease = databaseAbsenceLease(DATABASE_LOCK_FILE, {
        protocol: 'easyboost-database-operation-lock-absence-lease-obsolete',
        release: async () => { effects.push('database-release'); },
      });
      const databaseLockModule = {
        DEFAULT_DATABASE_OPERATION_LOCK_FILE: DATABASE_LOCK_FILE,
        async openDatabaseOperationLockAbsenceProof(options) {
          assert.deepEqual(options, { lockFile: DATABASE_LOCK_FILE });
          if (ingress === 'host-retry-open' || ingress === 'lease-only-open') {
            return wrongProtocolLease;
          }
          const error = new Error('absence lease does not exist');
          error.code = 'DATABASE_OPERATION_LOCK_ABSENCE_LEASE_AMBIGUOUS';
          throw error;
        },
        async openRetainedDatabaseOperationLock(options) {
          assert.deepEqual(options, {
            expectedEvidenceKind: 'restore',
            lockFile: DATABASE_LOCK_FILE,
          });
          if (ingress === 'post-completion-prove') {
            return {
              complete: async () => { effects.push('database-complete'); },
              evidence,
              legacy: false,
              reason: 'REMOTE_RESTORE_SETTLEMENT_UNPROVEN',
            };
          }
          throw new Error('database marker is not retained');
        },
        async proveDatabaseOperationLockAbsent(options) {
          assert.deepEqual(options, { lockFile: DATABASE_LOCK_FILE });
          proofCalls += 1;
          if (ingress === 'initial-prove') return wrongProtocolLease;
          if (ingress === 'post-completion-prove' && proofCalls === 2) {
            return wrongProtocolLease;
          }
          const error = new Error('database authority still exists');
          error.code = 'DATABASE_OPERATION_LOCK_NOT_ABSENT';
          throw error;
        },
      };
      const hostMissing = new Error('retained host guard is absent');
      hostMissing.code = 'ENOENT';
      const hostLockModule = {
        DEFAULT_HOST_OPERATION_LOCK_DIRECTORY: HOST_LOCK_DIRECTORY,
        async acquireHostOperationAbsenceLease() {
          effects.push('host-acquire');
          return {
            lockDirectory: HOST_LOCK_DIRECTORY,
            release: async () => { effects.push('host-release'); },
            state: 'absent-leased',
          };
        },
        async openRetainedHostOperationLock() {
          if (ingress === 'lease-only-open') throw hostMissing;
          return {
            complete: async () => { effects.push('host-complete'); },
            evidence,
            lockDirectory: HOST_LOCK_DIRECTORY,
            operation: 'database-restore',
            reason: 'REMOTE_RESTORE_SETTLEMENT_UNPROVEN',
          };
        },
      };

      await assert.rejects(runRetainedProductionRestoreRecoveryCli({
        databaseLockModule,
        environment,
        hostLockModule,
        runRecovery: async ({ completeDatabaseLock, completeHostGuard }) => {
          effects.push('recovery');
          await completeDatabaseLock();
          await completeHostGuard();
        },
      }), (error) => {
        const errors = error instanceof AggregateError ? error.errors : [error];
        assert.ok(errors.some((candidate) => /absence lease is invalid/u.test(candidate.message)));
        return true;
      });

      await new Promise((resolve) => { setImmediate(resolve); });
      const expectedEffects = ingress === 'post-completion-prove'
        ? ['recovery', 'database-complete']
        : ingress === 'lease-only-open' ? ['host-acquire', 'host-release'] : [];
      assert.deepEqual(effects, expectedEffects);
    });
  }
});

test('CLI accepts semantically equal reordered host and DB evidence and completes DB before host', async () => {
  const events = [];
  let databaseCompleted = false;
  const evidence = restoreEvidence();
  const reorderedEvidence = {
    postgresContainerId: evidence.postgresContainerId,
    operationToken: evidence.operationToken,
    lastProbe: {
      status: evidence.lastProbe.status,
      activityCount: evidence.lastProbe.activityCount,
      process: evidence.lastProbe.process,
    },
    kind: evidence.kind,
    applicationName: evidence.applicationName,
  };
  const databaseLockModule = {
    DEFAULT_DATABASE_OPERATION_LOCK_FILE: DATABASE_LOCK_FILE,
    async openRetainedDatabaseOperationLock(options) {
      assert.deepEqual(options, {
        expectedEvidenceKind: 'restore',
        lockFile: DATABASE_LOCK_FILE,
      });
      return {
        complete: async () => {
          databaseCompleted = true;
          events.push('database-complete');
        },
        evidence,
        legacy: false,
        reason: 'REMOTE_RESTORE_SETTLEMENT_UNPROVEN',
      };
    },
    async proveDatabaseOperationLockAbsent(options) {
      assert.deepEqual(options, { lockFile: DATABASE_LOCK_FILE });
      if (!databaseCompleted) {
        const error = new Error('retained DB marker exists');
        error.code = 'DATABASE_OPERATION_LOCK_NOT_ABSENT';
        throw error;
      }
      events.push('database-absence-lease');
      return databaseAbsenceLease(DATABASE_LOCK_FILE, {
        release: async () => { events.push('database-absence-release'); },
      });
    },
    async openDatabaseOperationLockAbsenceProof() {
      assert.fail('an existing absence lease must not be opened on the retained-marker path');
    },
  };
  const hostLockModule = {
    DEFAULT_HOST_OPERATION_LOCK_DIRECTORY: HOST_LOCK_DIRECTORY,
    async openRetainedHostOperationLock(options) {
      assert.deepEqual(options, {
        environment: productionEnvironment(),
        expectedOperation: 'database-restore',
      });
      return {
        complete: async () => { events.push('host-complete'); },
        evidence: reorderedEvidence,
        lockDirectory: HOST_LOCK_DIRECTORY,
        operation: 'database-restore',
        reason: 'REMOTE_RESTORE_SETTLEMENT_UNPROVEN',
      };
    },
  };
  const runRecovery = async ({
    completeDatabaseLock,
    completeHostGuard,
    evidence: recoveryEvidence,
    reason,
  }) => {
    assert.deepEqual(recoveryEvidence, evidence);
    assert.equal(reason, 'REMOTE_RESTORE_SETTLEMENT_UNPROVEN');
    await completeDatabaseLock();
    await completeHostGuard();
    return { ok: true };
  };

  const result = await runRetainedProductionRestoreRecoveryCli({
    databaseLockModule,
    environment: productionEnvironment(),
    hostLockModule,
    runRecovery,
  });

  assert.deepEqual(result, { ok: true });
  assert.deepEqual(events, [
    'database-complete',
    'database-absence-lease',
    'host-complete',
    'database-absence-release',
  ]);
});

test('CLI host-only recovery holds a public absence lease through host completion', async () => {
  const events = [];
  const evidence = restoreEvidence();
  const databaseLockModule = {
    DEFAULT_DATABASE_OPERATION_LOCK_FILE: DATABASE_LOCK_FILE,
    async openRetainedDatabaseOperationLock() {
      assert.fail('retained DB marker must not be opened after absence was leased');
    },
    async proveDatabaseOperationLockAbsent(options) {
      assert.deepEqual(options, { lockFile: DATABASE_LOCK_FILE });
      events.push('database-absence-lease');
      return databaseAbsenceLease(DATABASE_LOCK_FILE, {
        release: async () => { events.push('database-absence-release'); },
      });
    },
    async openDatabaseOperationLockAbsenceProof() {
      assert.fail('a fresh absence lease does not need reopening');
    },
  };
  const hostLockModule = {
    DEFAULT_HOST_OPERATION_LOCK_DIRECTORY: HOST_LOCK_DIRECTORY,
    async openRetainedHostOperationLock() {
      return {
        complete: async () => { events.push('host-complete'); },
        evidence,
        lockDirectory: HOST_LOCK_DIRECTORY,
        operation: 'database-restore',
        reason: 'REMOTE_RESTORE_SETTLEMENT_UNPROVEN',
      };
    },
  };
  const result = await runRetainedProductionRestoreRecoveryCli({
    databaseLockModule,
    environment: productionEnvironment(),
    hostLockModule,
    runRecovery: async ({ completeDatabaseLock, completeHostGuard }) => {
      await completeDatabaseLock();
      await completeHostGuard();
      return { resumed: true };
    },
  });

  assert.deepEqual(result, { resumed: true });
  assert.deepEqual(events, [
    'database-absence-lease',
    'host-complete',
    'database-absence-release',
  ]);
});

test('CLI reopens the exact DB absence lease after partial DB-to-host completion', async () => {
  const events = [];
  const evidence = restoreEvidence();
  const absenceLease = databaseAbsenceLease(DATABASE_LOCK_FILE, {
    release: async () => { events.push('database-absence-release'); },
  });
  const databaseLockModule = {
    DEFAULT_DATABASE_OPERATION_LOCK_FILE: DATABASE_LOCK_FILE,
    async proveDatabaseOperationLockAbsent(options) {
      assert.deepEqual(options, { lockFile: DATABASE_LOCK_FILE });
      events.push('database-absence-probe');
      const error = new Error('persistent absence lease exists');
      error.code = 'DATABASE_OPERATION_LOCK_NOT_ABSENT';
      throw error;
    },
    async openRetainedDatabaseOperationLock(options) {
      assert.deepEqual(options, {
        expectedEvidenceKind: 'restore',
        lockFile: DATABASE_LOCK_FILE,
      });
      events.push('database-retained-open');
      throw new Error('database marker is not a retained operation');
    },
    async openDatabaseOperationLockAbsenceProof(options) {
      assert.deepEqual(options, { lockFile: DATABASE_LOCK_FILE });
      events.push('database-absence-open');
      return absenceLease;
    },
  };
  const hostLockModule = {
    DEFAULT_HOST_OPERATION_LOCK_DIRECTORY: HOST_LOCK_DIRECTORY,
    async openRetainedHostOperationLock() {
      return {
        complete: async () => { events.push('host-complete'); },
        evidence,
        lockDirectory: HOST_LOCK_DIRECTORY,
        operation: 'database-restore',
        reason: 'REMOTE_RESTORE_SETTLEMENT_UNPROVEN',
      };
    },
  };

  await runRetainedProductionRestoreRecoveryCli({
    databaseLockModule,
    environment: productionEnvironment(),
    hostLockModule,
    runRecovery: async ({ completeDatabaseLock, completeHostGuard }) => {
      await completeDatabaseLock();
      await completeHostGuard();
      return { resumed: true };
    },
  });

  assert.deepEqual(events, [
    'database-absence-probe',
    'database-retained-open',
    'database-absence-open',
    'host-complete',
    'database-absence-release',
  ]);
});

test('CLI finishes only the exact DB absence lease after host completion survived a restart', async () => {
  const events = [];
  const hostLockDirectory = path.resolve('fake-host-absence.lock');
  const databaseLockModule = {
    DEFAULT_DATABASE_OPERATION_LOCK_FILE: DATABASE_LOCK_FILE,
    async openDatabaseOperationLockAbsenceProof(options) {
      assert.deepEqual(options, { lockFile: DATABASE_LOCK_FILE });
      events.push('database-absence-open');
      return databaseAbsenceLease(DATABASE_LOCK_FILE, {
        release: async () => { events.push('database-absence-release'); },
      });
    },
    async openRetainedDatabaseOperationLock() {
      assert.fail('lease-only cleanup must not open a retained DB marker');
    },
    async proveDatabaseOperationLockAbsent() {
      assert.fail('lease-only cleanup must reopen the persisted lease');
    },
  };
  const hostLockModule = {
    DEFAULT_HOST_OPERATION_LOCK_DIRECTORY: hostLockDirectory,
    async openRetainedHostOperationLock() {
      const error = new Error('host guard already completed');
      error.code = 'ENOENT';
      throw error;
    },
    async acquireHostOperationAbsenceLease(options) {
      assert.deepEqual(options, { environment: productionEnvironment() });
      events.push('host-absence-acquire');
      return {
        lockDirectory: hostLockDirectory,
        release: async () => { events.push('host-absence-release'); },
        state: 'absent-leased',
      };
    },
  };

  const result = await runRetainedProductionRestoreRecoveryCli({
    databaseLockModule,
    environment: productionEnvironment(),
    hostLockModule,
    runRecovery: async () => {
      assert.fail('lease-only finalization must not repeat Docker recovery');
    },
  });

  assert.deepEqual(events, [
    'host-absence-acquire',
    'database-absence-open',
    'database-absence-release',
    'host-absence-release',
  ]);
  assert.deepEqual(result, {
    databaseUsable: false,
    guardRecoveryCompleted: true,
    recoveryMode: 'lease-only-finalization',
    requiredOperatorAction: 'RERUN_FULL_GUARDED_DATABASE_ONLY_RESTORE',
  });
});

test('normal recovery keeps the DB absence lease when retained host completion fails', async () => {
  const events = [];
  let databaseCompleted = false;
  const evidence = restoreEvidence();
  const databaseLockModule = {
    DEFAULT_DATABASE_OPERATION_LOCK_FILE: DATABASE_LOCK_FILE,
    async proveDatabaseOperationLockAbsent(options) {
      assert.deepEqual(options, { lockFile: DATABASE_LOCK_FILE });
      if (!databaseCompleted) {
        const error = new Error('retained DB marker exists');
        error.code = 'DATABASE_OPERATION_LOCK_NOT_ABSENT';
        throw error;
      }
      events.push('database-absence-lease');
      return databaseAbsenceLease(DATABASE_LOCK_FILE, {
        release: async () => { events.push('database-absence-release'); },
      });
    },
    async openRetainedDatabaseOperationLock(options) {
      assert.deepEqual(options, {
        expectedEvidenceKind: 'restore',
        lockFile: DATABASE_LOCK_FILE,
      });
      return {
        complete: async () => {
          databaseCompleted = true;
          events.push('database-complete');
        },
        evidence,
        legacy: false,
        reason: 'REMOTE_RESTORE_SETTLEMENT_UNPROVEN',
      };
    },
    async openDatabaseOperationLockAbsenceProof() {
      assert.fail('retained DB marker must open directly');
    },
  };
  const hostLockModule = {
    DEFAULT_HOST_OPERATION_LOCK_DIRECTORY: HOST_LOCK_DIRECTORY,
    async openRetainedHostOperationLock() {
      return {
        complete: async () => {
          events.push('host-complete');
          throw new Error('host completion failed');
        },
        evidence,
        lockDirectory: HOST_LOCK_DIRECTORY,
        operation: 'database-restore',
        reason: 'REMOTE_RESTORE_SETTLEMENT_UNPROVEN',
      };
    },
  };

  await assert.rejects(runRetainedProductionRestoreRecoveryCli({
    databaseLockModule,
    environment: productionEnvironment(),
    hostLockModule,
    runRecovery: async ({ completeDatabaseLock, completeHostGuard }) => {
      await completeDatabaseLock();
      await completeHostGuard();
    },
  }), /host completion failed/u);
  assert.deepEqual(events, [
    'database-complete',
    'database-absence-lease',
    'host-complete',
  ]);
});

test('lease-only recovery reports host absence release failure after DB finalization', async () => {
  const events = [];
  const hostLockDirectory = path.resolve('fake-host-absence.lock');
  const databaseLockModule = {
    DEFAULT_DATABASE_OPERATION_LOCK_FILE: DATABASE_LOCK_FILE,
    async openDatabaseOperationLockAbsenceProof(options) {
      assert.deepEqual(options, { lockFile: DATABASE_LOCK_FILE });
      events.push('database-absence-open');
      return databaseAbsenceLease(DATABASE_LOCK_FILE, {
        release: async () => { events.push('database-absence-release'); },
      });
    },
    async openRetainedDatabaseOperationLock() {
      assert.fail('lease-only recovery must not open a retained DB marker');
    },
    async proveDatabaseOperationLockAbsent() {
      assert.fail('lease-only recovery must reopen its exact DB lease');
    },
  };
  const hostLockModule = {
    DEFAULT_HOST_OPERATION_LOCK_DIRECTORY: hostLockDirectory,
    async openRetainedHostOperationLock() {
      const error = new Error('host guard already completed');
      error.code = 'ENOENT';
      throw error;
    },
    async acquireHostOperationAbsenceLease() {
      events.push('host-absence-acquire');
      return {
        lockDirectory: hostLockDirectory,
        release: async () => {
          events.push('host-absence-release');
          throw new Error('host absence release failed');
        },
        state: 'absent-leased',
      };
    },
  };

  await assert.rejects(runRetainedProductionRestoreRecoveryCli({
    databaseLockModule,
    environment: productionEnvironment(),
    hostLockModule,
  }), /host absence release failed/u);
  assert.deepEqual(events, [
    'host-absence-acquire',
    'database-absence-open',
    'database-absence-release',
    'host-absence-release',
  ]);
});

test('lease-only recovery releases its host lease when DB lease finalization fails', async () => {
  const events = [];
  const hostLockDirectory = path.resolve('fake-host-absence.lock');
  const databaseLockModule = {
    DEFAULT_DATABASE_OPERATION_LOCK_FILE: DATABASE_LOCK_FILE,
    async openDatabaseOperationLockAbsenceProof(options) {
      assert.deepEqual(options, { lockFile: DATABASE_LOCK_FILE });
      events.push('database-absence-open');
      return databaseAbsenceLease(DATABASE_LOCK_FILE, {
        release: async () => {
          events.push('database-absence-release');
          throw new Error('database absence release failed');
        },
      });
    },
    async openRetainedDatabaseOperationLock() {},
    async proveDatabaseOperationLockAbsent() {},
  };
  const hostLockModule = {
    DEFAULT_HOST_OPERATION_LOCK_DIRECTORY: hostLockDirectory,
    async openRetainedHostOperationLock() {
      const error = new Error('host guard already completed');
      error.code = 'ENOENT';
      throw error;
    },
    async acquireHostOperationAbsenceLease() {
      events.push('host-absence-acquire');
      return {
        lockDirectory: hostLockDirectory,
        release: async () => { events.push('host-absence-release'); },
        state: 'absent-leased',
      };
    },
  };

  await assert.rejects(runRetainedProductionRestoreRecoveryCli({
    databaseLockModule,
    environment: productionEnvironment(),
    hostLockModule,
  }), /database absence release failed/u);
  assert.deepEqual(events, [
    'host-absence-acquire',
    'database-absence-open',
    'database-absence-release',
    'host-absence-release',
  ]);
});

test('lease-only recovery rejects the obsolete one-shot host absence state', async () => {
  const databaseEffects = [];
  const hostLockDirectory = path.resolve('fake-host-absence.lock');
  await assert.rejects(runRetainedProductionRestoreRecoveryCli({
    databaseLockModule: {
      DEFAULT_DATABASE_OPERATION_LOCK_FILE: DATABASE_LOCK_FILE,
      async openDatabaseOperationLockAbsenceProof() { databaseEffects.push('open'); },
      async openRetainedDatabaseOperationLock() { databaseEffects.push('retained'); },
      async proveDatabaseOperationLockAbsent() { databaseEffects.push('prove'); },
    },
    environment: productionEnvironment(),
    hostLockModule: {
      DEFAULT_HOST_OPERATION_LOCK_DIRECTORY: hostLockDirectory,
      async openRetainedHostOperationLock() {
        const error = new Error('host guard already completed');
        error.code = 'ENOENT';
        throw error;
      },
      async acquireHostOperationAbsenceLease() {
        return {
          lockDirectory: hostLockDirectory,
          release: async () => {},
          state: 'absent',
        };
      },
    },
  }), /unsafe authority/u);
  assert.deepEqual(databaseEffects, []);
});

test('lease-only recovery rejects active or ambiguous host state before DB mutation', async () => {
  const effects = [];
  await assert.rejects(runRetainedProductionRestoreRecoveryCli({
    databaseLockModule: {
      DEFAULT_DATABASE_OPERATION_LOCK_FILE: DATABASE_LOCK_FILE,
      async openDatabaseOperationLockAbsenceProof() { effects.push('database-open'); },
      async openRetainedDatabaseOperationLock() { effects.push('database-retained'); },
      async proveDatabaseOperationLockAbsent() { effects.push('database-prove'); },
    },
    environment: productionEnvironment(),
    hostLockModule: {
      DEFAULT_HOST_OPERATION_LOCK_DIRECTORY: HOST_LOCK_DIRECTORY,
      async openRetainedHostOperationLock() {
        const error = new Error('retained host record absent');
        error.code = 'ENOENT';
        throw error;
      },
      async acquireHostOperationAbsenceLease() {
        effects.push('host-absence-attempt');
        const error = new Error('HOST_OPERATION_LOCK_NOT_ABSENT');
        error.code = 'HOST_OPERATION_LOCK_NOT_ABSENT';
        throw error;
      },
    },
  }), /HOST_OPERATION_LOCK_NOT_ABSENT/u);
  assert.deepEqual(effects, ['host-absence-attempt']);
});

test('real retained host and DB restore markers complete through the public recovery APIs', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-real-restore-recovery-'));
  const lockFile = path.join(directory, '.easyboost-database-operation.lock');
  const hostLockDirectory = path.join(directory, '.easyboost-host-operation.lock');
  const evidence = restoreEvidence();
  const reason = 'REMOTE_RESTORE_SETTLEMENT_UNPROVEN';
  const environment = {
    ...productionEnvironment(),
    EASYBOOST_HOST_OPERATION_LOCK_DIR: hostLockDirectory,
  };
  const databaseLock = await import('../scripts/database-operation-lock.js');
  const hostLock = await import('../scripts/host-operation-lock.js');
  try {
    const releaseHost = await hostLock.acquireHostOperationLock({
      environment,
      operation: 'database-restore',
    });
    const releaseDatabase = await databaseLock.acquireDatabaseOperationLock(lockFile);
    await databaseLock.retainDatabaseOperationLock(
      releaseDatabase,
      100,
      reason,
      evidence,
    );
    await hostLock.retainHostOperationLock(releaseHost, 100, {
      ...evidence,
      retentionReason: reason,
    });

    const result = await runRetainedProductionRestoreRecoveryCli({
      databaseLockModule: {
        DEFAULT_DATABASE_OPERATION_LOCK_FILE: lockFile,
        openDatabaseOperationLockAbsenceProof: (options = {}) => (
          databaseLock.openDatabaseOperationLockAbsenceProof({ ...options, lockFile })
        ),
        openRetainedDatabaseOperationLock: (options = {}) => (
          databaseLock.openRetainedDatabaseOperationLock({ ...options, lockFile })
        ),
        proveDatabaseOperationLockAbsent: (options = {}) => (
          databaseLock.proveDatabaseOperationLockAbsent({ ...options, lockFile })
        ),
      },
      environment,
      hostLockModule: hostLock,
      runRecovery: async ({ completeDatabaseLock, completeHostGuard }) => {
        await completeDatabaseLock();
        await completeHostGuard();
        return { exactMarkersCompleted: true };
      },
    });

    assert.deepEqual(result, { exactMarkersCompleted: true });
    const hostAbsenceLease = await hostLock.proveHostOperationLockAbsent({ environment });
    assert.deepEqual({
      lockDirectory: hostAbsenceLease.lockDirectory,
      state: hostAbsenceLease.state,
    }, {
      lockDirectory: hostLockDirectory,
      state: 'absent-leased',
    });
    await hostAbsenceLease.release();
    const finalDatabaseAbsence = await databaseLock.proveDatabaseOperationLockAbsent({
      lockFile,
    });
    await finalDatabaseAbsence.release();
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('real lease-only restart finishes after host completion and a lost DB lease handle', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-real-lease-only-'));
  const lockFile = path.join(directory, '.easyboost-database-operation.lock');
  const hostLockDirectory = path.join(directory, '.easyboost-host-operation.lock');
  const evidence = restoreEvidence();
  const reason = 'REMOTE_RESTORE_SETTLEMENT_UNPROVEN';
  const environment = {
    ...productionEnvironment(),
    EASYBOOST_HOST_OPERATION_LOCK_DIR: hostLockDirectory,
  };
  const databaseLock = await import('../scripts/database-operation-lock.js');
  const hostLock = await import('../scripts/host-operation-lock.js');
  const databaseLockModule = {
    DEFAULT_DATABASE_OPERATION_LOCK_FILE: lockFile,
    openDatabaseOperationLockAbsenceProof: (options = {}) => (
      databaseLock.openDatabaseOperationLockAbsenceProof({
        ...options,
        lockFile,
        processLivenessProbe: async () => false,
      })
    ),
    openRetainedDatabaseOperationLock: (options = {}) => (
      databaseLock.openRetainedDatabaseOperationLock({ ...options, lockFile })
    ),
    proveDatabaseOperationLockAbsent: (options = {}) => (
      databaseLock.proveDatabaseOperationLockAbsent({ ...options, lockFile })
    ),
  };
  try {
    const releaseHost = await hostLock.acquireHostOperationLock({
      environment,
      operation: 'database-restore',
    });
    const releaseDatabase = await databaseLock.acquireDatabaseOperationLock(lockFile);
    await databaseLock.retainDatabaseOperationLock(
      releaseDatabase,
      100,
      reason,
      evidence,
    );
    await hostLock.retainHostOperationLock(releaseHost, 100, {
      ...evidence,
      retentionReason: reason,
    });
    const retainedDatabase = await databaseLock.openRetainedDatabaseOperationLock({
      expectedEvidenceKind: 'restore',
      lockFile,
    });
    const retainedHost = await hostLock.openRetainedHostOperationLock({
      environment,
      expectedOperation: 'database-restore',
    });
    await retainedDatabase.complete();
    await databaseLock.proveDatabaseOperationLockAbsent({ lockFile });
    await retainedHost.complete();

    const result = await runRetainedProductionRestoreRecoveryCli({
      databaseLockModule,
      environment,
      hostLockModule: hostLock,
      runRecovery: async () => {
        assert.fail('lease-only restart must not repeat settlement recovery');
      },
    });
    assert.equal(result.recoveryMode, 'lease-only-finalization');
    const finalDatabaseAbsence = await databaseLock.proveDatabaseOperationLockAbsent({
      lockFile,
    });
    await finalDatabaseAbsence.release();
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('lease-only finalization never touches the DB lease while host absence is unproven', async () => {
  const effects = [];
  await assert.rejects(runRetainedProductionRestoreRecoveryCli({
    databaseLockModule: {
      DEFAULT_DATABASE_OPERATION_LOCK_FILE: DATABASE_LOCK_FILE,
      async openDatabaseOperationLockAbsenceProof() { effects.push('database-open'); },
      async openRetainedDatabaseOperationLock() { effects.push('database-retained'); },
      async proveDatabaseOperationLockAbsent() { effects.push('database-prove'); },
    },
    environment: productionEnvironment(),
    hostLockModule: {
      DEFAULT_HOST_OPERATION_LOCK_DIRECTORY: HOST_LOCK_DIRECTORY,
      async openRetainedHostOperationLock() {
        const error = new Error('host owner is missing but directory remains');
        error.code = 'HOST_OPERATION_LOCK_NOT_ABSENT';
        throw error;
      },
      async acquireHostOperationAbsenceLease() {
        assert.fail('foreign or active host authority must not enter lease-only recovery');
      },
    },
  }), /host owner is missing but directory remains/u);
  assert.deepEqual(effects, []);
});

test('restore retains matching typed host and DB recovery authority instead of a generic host marker', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-restore-host-evidence-'));
  const backup = path.join(directory, 'backup.dump');
  const retained = [];
  const releaseDatabase = async () => {};
  const releaseHost = async () => {};
  const evidence = restoreEvidence();
  await fs.writeFile(backup, 'frozen-backup');
  try {
    await assert.rejects(restorePostgresBackup({
      acquireHostLock: async () => releaseHost,
      acquireOperationLock: async () => releaseDatabase,
      applicationMode: 'absent',
      backup,
      environment: productionEnvironment(),
      log: () => {},
      postgresExpectedImageId: POSTGRES_IMAGE_ID,
      productionAppImageId: APP_IMAGE_ID,
      reserveCapacity: async () => {},
      retainHostLock: async (...args) => { retained.push(['host', ...args]); },
      retainOperationLock: async (...args) => { retained.push(['database', ...args]); },
      runDocker: async (args) => {
        if (args[0] === 'compose' && args.at(-1) === 'postgres') {
          return POSTGRES_CONTAINER_ID;
        }
        if (args[0] === 'compose' && args.at(-1) === 'app') return '';
        if (args[0] === 'inspect' && args.at(-1) === POSTGRES_CONTAINER_ID) {
          return [
            POSTGRES_CONTAINER_ID,
            COMPOSE_PROJECT,
            'postgres',
            'False',
            POSTGRES_IMAGE_ID,
            'true',
          ].join('|');
        }
        if (args[0] === 'exec' && args.includes('pg_restore')) return '';
        throw new Error(`Unexpected Docker command: ${args.join(' ')}`);
      },
      runSupervisedRestore: async () => {
        const error = new Error('remote settlement uncertain');
        error.recoveryEvidence = evidence;
        error.retainOperationLock = true;
        throw error;
      },
    }), /remote settlement uncertain/u);

    assert.deepEqual(retained, [
      [
        'database',
        releaseDatabase,
        2_000,
        'REMOTE_RESTORE_SETTLEMENT_UNPROVEN',
        evidence,
      ],
      [
        'host',
        releaseHost,
        2_000,
        {
          ...evidence,
          retentionReason: 'REMOTE_RESTORE_SETTLEMENT_UNPROVEN',
        },
      ],
    ]);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('active remote restore fails before application or guard mutation', async () => {
  const mutations = [];
  const runDocker = async (args) => {
    if (args[0] === 'compose' && args.at(-1) === 'postgres') return POSTGRES_CONTAINER_ID;
    if (args[0] === 'inspect') {
      return [
        POSTGRES_CONTAINER_ID,
        POSTGRES_IMAGE_ID,
        COMPOSE_PROJECT,
        'postgres',
        'False',
        'true',
      ].join('|');
    }
    if (args[0] === 'exec') return 'PROCESS=ACTIVE\nACTIVITY=1';
    if (args[0] === 'stop') mutations.push('stop');
    throw new Error(`Unexpected Docker command: ${args.join(' ')}`);
  };

  await assert.rejects(recoverRetainedProductionRestore({
    completeDatabaseLock: async () => { mutations.push('database'); },
    completeHostGuard: async () => { mutations.push('host'); },
    environment: productionEnvironment(),
    evidence: restoreEvidence(),
    reason: 'REMOTE_RESTORE_SETTLEMENT_UNPROVEN',
    runDocker,
  }), /remote settlement is unproven/u);
  assert.deepEqual(mutations, []);
});

test('foreign application allocation fails closed without container or guard mutation', async () => {
  const mutations = [];
  const runDocker = async (args) => {
    if (args[0] === 'compose' && args.at(-1) === 'postgres') return POSTGRES_CONTAINER_ID;
    if (args[0] === 'compose' && args.at(-1) === 'app') return APP_CONTAINER_ID;
    if (args[0] === 'inspect' && args.at(-1) === POSTGRES_CONTAINER_ID) {
      return [
        POSTGRES_CONTAINER_ID,
        POSTGRES_IMAGE_ID,
        COMPOSE_PROJECT,
        'postgres',
        'False',
        'false',
      ].join('|');
    }
    if (args[0] === 'inspect' && args.at(-1) === APP_CONTAINER_ID) {
      return [
        APP_CONTAINER_ID,
        APP_IMAGE_ID,
        'foreign-project',
        'app',
        'False',
        'true',
      ].join('|');
    }
    if (args[0] === 'stop') mutations.push('stop');
    throw new Error(`Unexpected Docker command: ${args.join(' ')}`);
  };

  await assert.rejects(recoverRetainedProductionRestore({
    completeDatabaseLock: async () => { mutations.push('database'); },
    completeHostGuard: async () => { mutations.push('host'); },
    environment: productionEnvironment(),
    evidence: restoreEvidence(),
    reason: 'APPLICATION_ISOLATION_UNPROVEN_AFTER_DATABASE_RESTORE',
    runDocker,
  }), /authority is foreign/u);
  assert.deepEqual(mutations, []);
});

test('ambiguous application inventory fails closed before inspection or mutation', async () => {
  const effects = [];
  const runDocker = async (args) => {
    if (args[0] === 'compose' && args.at(-1) === 'postgres') return POSTGRES_CONTAINER_ID;
    if (args[0] === 'compose' && args.at(-1) === 'app') {
      return `${APP_CONTAINER_ID}\n${'e'.repeat(64)}`;
    }
    if (args[0] === 'inspect' && args.at(-1) === POSTGRES_CONTAINER_ID) {
      return [
        POSTGRES_CONTAINER_ID,
        POSTGRES_IMAGE_ID,
        COMPOSE_PROJECT,
        'postgres',
        'False',
        'false',
      ].join('|');
    }
    effects.push(args[0]);
    throw new Error(`Unexpected Docker command: ${args.join(' ')}`);
  };

  await assert.rejects(recoverRetainedProductionRestore({
    completeDatabaseLock: async () => { effects.push('database'); },
    completeHostGuard: async () => { effects.push('host'); },
    environment: productionEnvironment(),
    evidence: restoreEvidence(),
    reason: 'APPLICATION_ISOLATION_UNPROVEN_AFTER_DATABASE_RESTORE',
    runDocker,
  }), /inventory is ambiguous/u);
  assert.deepEqual(effects, []);
});

test('root recovery CLI rejects every argument before opening retained authorities', () => {
  const script = path.resolve('scripts/production-restore-recovery.js');
  const result = spawnSync(process.execPath, [script, 'unexpected'], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /does not accept arguments/u);
});
