import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const APP_IMAGE_ID = `sha256:${'a'.repeat(64)}`;
const POSTGRES_IMAGE_ID = `sha256:${'b'.repeat(64)}`;
const IMPORT_CONTAINER_ID = 'c'.repeat(64);
const POSTGRES_CONTAINER_ID = 'd'.repeat(64);
const OPERATION_TOKEN = '12345678-1234-4abc-8def-1234567890ab';
const OWNERSHIP_TOKEN = 'e'.repeat(64);
const APPLICATION_NAME = `easyboost_import_${OPERATION_TOKEN}`;
const DATABASE_ABSENCE_LEASE_PROTOCOL =
  'easyboost-database-operation-lock-absence-lease-v1';
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
const COMPOSE_PREFIX = [
  'compose', '--project-name', 'easyboost-production',
  '-f', 'compose.production.yml',
];
const recoveryCliPath = fileURLToPath(new URL(
  '../scripts/production-import-recovery.js',
  import.meta.url,
));
const projectDirectory = fileURLToPath(new URL('..', import.meta.url));

function localChildRecoveryAuthority(overrides = {}) {
  const controlKey = `database:${projectDirectory}:docker`;
  const controller = {
    controlDirectory: path.join(
      projectDirectory,
      '.local-child-controls',
      createHash('sha256').update(controlKey, 'utf8').digest('hex'),
    ),
  };
  return {
    protocol: 'easyboost-production-import-local-child-recovery-v1',
    controller,
    hold: {
      authorityToken: '1'.repeat(64),
      commandSha256: '2'.repeat(64),
      holdToken: '3'.repeat(64),
    },
    ...overrides,
  };
}

function withPosixPublicationResidue(controller) {
  const destination = path.join(controller.controlDirectory, 'ready.proof');
  return {
    ...controller,
    publicationResidue: {
      destination,
      sourceBinding: SYNTHETIC_POSIX_PUBLICATION_SOURCE_BINDING,
      temporary: path.join(
        path.dirname(controller.controlDirectory),
        `.${path.basename(controller.controlDirectory)}.${path.basename(destination)}.${'4'.repeat(32)}.tmp`,
      ),
    },
  };
}

function withPosixPublicationResidues(controller) {
  const names = ['ready.proof', 'term.request', 'kill.request'];
  return {
    ...controller,
    publicationResidues: names.map((name, index) => ({
      destination: path.join(controller.controlDirectory, name),
      sourceBinding: SYNTHETIC_POSIX_PUBLICATION_SOURCE_BINDING,
      temporary: path.join(
        path.dirname(controller.controlDirectory),
        `.${path.basename(controller.controlDirectory)}.${name}.${String(index + 4).repeat(32)}.tmp`,
      ),
    })),
  };
}

function recoveryEvidence(overrides = {}) {
  return {
    kind: 'import',
    operationToken: OPERATION_TOKEN,
    applicationName: APPLICATION_NAME,
    ownershipToken: OWNERSHIP_TOKEN,
    importContainerId: 'unknown',
    postgresContainerId: POSTGRES_CONTAINER_ID,
    lastProbe: { activityCount: 'unknown', process: 'UNKNOWN', status: 'UNKNOWN' },
    ...overrides,
  };
}

function recoveryEnvironment() {
  return {
    EASYBOOST_PRODUCTION_APP_IMAGE_ID: APP_IMAGE_ID,
    EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID: POSTGRES_IMAGE_ID,
  };
}

function databaseProtocolError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function databaseAbsenceLease(lockFile, release = async () => {}) {
  return {
    absent: true,
    lockFile,
    protocol: DATABASE_ABSENCE_LEASE_PROTOCOL,
    release,
  };
}

test('retained import recovery CLI rejects arguments before opening guards or Docker', () => {
  const result = spawnSync(process.execPath, [recoveryCliPath, '--unknown'], {
    encoding: 'utf8',
    env: { ...process.env, ...recoveryEnvironment() },
  });

  assert.equal(result.status, 2);
  assert.match(result.stderr, /does not accept arguments/u);
});

test('production import CLI recovery output round-trips only sanitized exact authority',
  async () => {
    const secret = 'postgresql://easyboost:must-not-leak@postgres/easyboost';
    const localChildRecovery = localChildRecoveryAuthority();
    localChildRecovery.controller = withPosixPublicationResidue(
      localChildRecovery.controller,
    );
    const error = Object.assign(new Error(`docker ${secret} never closed`), {
      childSettlementUnproven: true,
      code: 'PRODUCTION_IMPORT_LOCAL_CHILD_RECOVERY_REQUIRED',
      command: `docker exec --env DATABASE_URL=${secret}`,
      environment: { DATABASE_URL: secret },
      recoveryAuthority: localChildRecovery.controller,
    });
    const { formatProductionImportCliFailure } = await import('../scripts/import-json.js');

    const serialized = formatProductionImportCliFailure(error);
    const roundTripped = JSON.parse(serialized);

    assert.deepEqual(roundTripped, {
      childSettlementUnproven: true,
      code: 'PRODUCTION_IMPORT_LOCAL_CHILD_RECOVERY_REQUIRED',
      recoveryAuthority: localChildRecovery.controller,
    });
    assert.doesNotMatch(serialized, /must-not-leak|DATABASE_URL|docker exec/u);
  });

test('production import recovery codec round-trips the real deterministic Windows Job authority',
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-import-windows-authority-'));
    let control;
    try {
      const { createWindowsJobControl } = await import(
        '../scripts/release-command-supervisor.js'
      );
      const {
        createProductionImportLocalChildRecovery,
        decodeProductionImportLocalChildRecovery,
        encodeProductionImportLocalChildRecovery,
      } = await import('../scripts/production-import-local-child-authority.js');
      control = createWindowsJobControl({
        controlKey: 'database:C:\\app:docker',
        temporaryDirectory: root,
      });
      const authority = createProductionImportLocalChildRecovery(
        control.recoveryAuthority,
        {
          authorityToken: '1'.repeat(64),
          commandSha256: '2'.repeat(64),
          holdToken: '3'.repeat(64),
        },
      );

      assert.deepEqual(
        decodeProductionImportLocalChildRecovery(
          encodeProductionImportLocalChildRecovery(authority),
        ),
        authority,
      );
      assert.match(
        authority.controller.retirementDirectory,
        /\.easyboost-windows-job-[0-9a-f]{64}\.retired$/u,
      );
    } finally {
      control?.dispose({ force: true });
      await fs.rm(root, { recursive: true, force: true });
    }
  });

test('production import recovery codec round-trips every exact POSIX publication residue',
  async () => {
    const controller = withPosixPublicationResidues(
      localChildRecoveryAuthority().controller,
    );
    const {
      createProductionImportLocalChildRecovery,
      decodeProductionImportLocalChildRecovery,
      encodeProductionImportLocalChildRecovery,
    } = await import('../scripts/production-import-local-child-authority.js');
    const authority = createProductionImportLocalChildRecovery(
      controller,
      localChildRecoveryAuthority().hold,
    );

    assert.deepEqual(
      decodeProductionImportLocalChildRecovery(
        encodeProductionImportLocalChildRecovery(authority),
      ),
      authority,
    );
    assert.deepEqual(authority.controller.publicationResidues, controller.publicationResidues);
  });

test('production import POSIX retention preflight includes every optional tombstone', async () => {
  const controlRoot = path.join(
    path.parse(projectDirectory).root,
    ...Array.from({ length: 11 }, () => 't'.repeat(100)),
  );
  const controlDirectory = path.join(controlRoot, 'a'.repeat(64));
  const publicationResidues = ['session-settled.proof', 'term.request', 'kill.request']
    .map((name, index) => {
      const temporary = path.join(
        controlRoot,
        `.${path.basename(controlDirectory)}.${name}.${String(index + 4).repeat(32)}.tmp`,
      );
      return {
        destination: path.join(controlDirectory, name),
        sourceBinding: SYNTHETIC_POSIX_PUBLICATION_SOURCE_BINDING,
        temporary,
        tombstone: path.join(
          controlRoot,
          `.${path.basename(temporary)}.cleanup.${String(index + 1).repeat(64)}.tombstone`,
        ),
      };
    });
  const {
    assertProductionImportPosixControllerRetentionBound,
    createProductionImportLocalChildRecovery,
    encodeProductionImportLocalChildRecovery,
  } = await import('../scripts/production-import-local-child-authority.js');
  const authority = createProductionImportLocalChildRecovery(
    { controlDirectory, publicationResidues },
    localChildRecoveryAuthority().hold,
  );

  assert.throws(() => encodeProductionImportLocalChildRecovery(authority), /too large/u,
    'fixture must exceed the fixed durable marker codec only when tombstones are retained');
  assert.throws(
    () => assertProductionImportPosixControllerRetentionBound(controlDirectory),
    /exceeds its durable retention bound/u,
  );
});

test('production import durable host recovery retains three bounded POSIX residues from a long control root',
  async () => {
    const controlRoot = path.join(
      path.parse(projectDirectory).root,
      ...Array.from({ length: 8 }, () => 'x'.repeat(100)),
    );
    const controlDirectory = path.join(controlRoot, 'a'.repeat(64));
    const publicationResidues = ['ready.proof', 'term.request', 'kill.request']
      .map((name, index) => {
        const temporary = path.join(
          controlRoot,
          `.${path.basename(controlDirectory)}.${name}.${String(index + 4).repeat(32)}.tmp`,
        );
        return {
          destination: path.join(controlDirectory, name),
          sourceBinding: SYNTHETIC_POSIX_PUBLICATION_SOURCE_BINDING,
          temporary,
        };
      });
    const controller = { controlDirectory, publicationResidues };
    const {
      assertProductionImportPosixControllerRetentionBound,
      createProductionImportLocalChildRecovery,
      decodeProductionImportLocalChildRecovery,
      encodeProductionImportLocalChildRecovery,
    } = await import('../scripts/production-import-local-child-authority.js');
    const authority = createProductionImportLocalChildRecovery(
      controller,
      localChildRecoveryAuthority().hold,
    );

    assert.ok(Buffer.byteLength(JSON.stringify(authority), 'utf8') > 6 * 1_024,
      'fixture must exercise a substantial aggregate codec payload');
    assert.doesNotThrow(() => {
      assertProductionImportPosixControllerRetentionBound(controlDirectory);
    });
    assert.deepEqual(
      decodeProductionImportLocalChildRecovery(
        encodeProductionImportLocalChildRecovery(authority),
      ),
      authority,
    );

    const hostRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-import-long-authority-'));
    try {
      const {
        acquireHostOperationLock,
        retainHostOperationLock,
      } = await import('../scripts/host-operation-lock.js');
      const release = await acquireHostOperationLock({
        lockDirectory: path.join(hostRoot, 'host-operation.lock'),
        operation: 'database-import',
      });
      const complete = await retainHostOperationLock(release, 1_000, {
        ...recoveryEvidence({ localChildRecovery: authority }),
        retentionReason: 'IMPORT_LOCAL_CHILD_SETTLEMENT_UNPROVEN',
      });
      assert.equal(typeof complete, 'function');
      await complete();
    } finally {
      await fs.rm(hostRoot, { recursive: true, force: true });
    }
  });

test('production import local-child recovery derives one exact deterministic supervisor scope',
  async () => {
    const controller = withPosixPublicationResidue(
      localChildRecoveryAuthority().controller,
    );
    let recoveryCalls = 0;
    const { recoverProductionImportLocalChildControl } = await import(
      '../scripts/production-import-recovery.js'
    );

    const result = await recoverProductionImportLocalChildControl({
      recoveryAuthority: controller,
      workingDirectory: projectDirectory,
      recoverPosixControl: async (options) => {
        recoveryCalls += 1;
        assert.deepEqual(options, {
          controlKey: `database:${projectDirectory}:docker`,
          controlRoot: path.dirname(controller.controlDirectory),
          permitIncompleteRetirement: true,
          publicationResidue: controller.publicationResidue,
          recoveryScope: null,
        });
        return { absence: 'absent', state: 'not-created' };
      },
      recoverWindowsControl: async () => {
        throw new Error('POSIX authority must not dispatch Windows recovery');
      },
    });

    assert.deepEqual(result, { recoveryAuthority: controller, state: 'absent' });
    assert.equal(recoveryCalls, 1);
  });

test('production import local-child recovery dispatches every retained POSIX residue',
  async () => {
    const controller = withPosixPublicationResidues(
      localChildRecoveryAuthority().controller,
    );
    const { recoverProductionImportLocalChildControl } = await import(
      '../scripts/production-import-recovery.js'
    );

    const result = await recoverProductionImportLocalChildControl({
      recoveryAuthority: controller,
      workingDirectory: projectDirectory,
      recoverPosixControl: async (options) => {
        assert.deepEqual(options, {
          controlKey: `database:${projectDirectory}:docker`,
          controlRoot: path.dirname(controller.controlDirectory),
          permitIncompleteRetirement: true,
          publicationResidues: controller.publicationResidues,
          recoveryScope: null,
        });
        return { absence: 'absent', state: 'not-created' };
      },
      recoverWindowsControl: async () => {
        throw new Error('POSIX authority must not dispatch Windows recovery');
      },
    });

    assert.deepEqual(result, { recoveryAuthority: controller, state: 'absent' });
  });

test('retained import never transitions its DB guard when explicit Windows child namespace vanished',
  async () => {
    const temporaryDirectory = await fs.mkdtemp(path.join(
      path.resolve('test'), '.tmp-import-windows-missing-',
    ));
    const controlKey = `database:${projectDirectory}:docker`;
    const { createWindowsJobControl } = await import(
      `../scripts/release-command-supervisor.js?import-missing=${Date.now()}`
    );
    const control = createWindowsJobControl({ controlKey, temporaryDirectory });
    control.markWrapperSpawned();
    const localChildRecovery = localChildRecoveryAuthority({
      controller: JSON.parse(JSON.stringify(control.recoveryAuthority)),
    });
    const evidence = recoveryEvidence({ localChildRecovery });
    let databaseTransitions = 0;
    try {
      await fs.rm(temporaryDirectory, { force: true, recursive: true });
      const { runRetainedProductionImportRecoveryCli } = await import(
        '../scripts/production-import-recovery.js'
      );

      await assert.rejects(runRetainedProductionImportRecoveryCli({
        databaseLockModule: {
          DEFAULT_DATABASE_OPERATION_LOCK_FILE: 'missing-windows-child-database-marker',
          async openDatabaseOperationLockAbsenceProof() {
            throw new Error('database recovery must not open before exact child settlement');
          },
          async openRetainedDatabaseOperationLock() {
            throw new Error('database recovery must not open before exact child settlement');
          },
          async proveDatabaseOperationLockAbsent() {
            throw new Error('database recovery must not probe before exact child settlement');
          },
          async retainDatabaseOperationLocalChildRecovery() {
            databaseTransitions += 1;
          },
        },
        environment: recoveryEnvironment(),
        fileSystem: {},
        hostLockModule: {
          async openRetainedHostOperationLock() {
            return {
              evidence,
              operation: 'database-import',
              reason: 'IMPORT_LOCAL_CHILD_SETTLEMENT_UNPROVEN',
            };
          },
        },
        workingDirectory: projectDirectory,
      }), (error) => {
        assert.equal(error?.code, 'WINDOWS_JOB_RECOVERY_REQUIRED');
        assert.equal(error?.childSettlementUnproven, true);
        return true;
      });
      assert.equal(databaseTransitions, 0,
        'missing Windows namespace must not advance the retained DB marker');
    } finally {
      await fs.rm(temporaryDirectory, { force: true, recursive: true });
    }
  });

test('retained import recovery completes an interrupted active DB guard before host completion',
  async () => {
    const evidence = recoveryEvidence();
    const reason = 'IMPORT_CONTAINER_SETTLEMENT_UNPROVEN';
    const events = [];
    let databaseState = 'active';
    const lockFile = 'interrupted-active-database-marker';
    const { runRetainedProductionImportRecoveryCli } = await import(
      '../scripts/production-import-recovery.js'
    );

    const result = await runRetainedProductionImportRecoveryCli({
      databaseLockModule: {
        DEFAULT_DATABASE_OPERATION_LOCK_FILE: lockFile,
        async proveDatabaseOperationLockAbsent() {
          if (databaseState === 'absent') return databaseAbsenceLease(lockFile, async () => {
            events.push('absence-release');
          });
          throw databaseProtocolError('DATABASE_OPERATION_LOCK_NOT_ABSENT');
        },
        async openDatabaseOperationLockAbsenceProof() {
          throw databaseProtocolError('DATABASE_OPERATION_LOCK_ABSENCE_LEASE_AMBIGUOUS');
        },
        async openRetainedDatabaseOperationLock() {
          throw new Error('DATABASE_OPERATION_LOCK_NOT_RETAINED');
        },
        async openDatabaseOperationLockProtocolRecovery(options) {
          assert.equal(options.expectedEvidenceKind, 'import');
          assert.equal(options.lockFile, lockFile);
          return {
            async recover() {
              events.push('database-protocol-finalize');
              databaseState = 'absent';
              return { state: 'absent' };
            },
          };
        },
      },
      hostLockModule: {
        async openRetainedHostOperationLock() {
          return {
            operation: 'database-import',
            reason,
            evidence,
            async complete() {
              assert.equal(databaseState, 'absent');
              events.push('host-complete');
            },
          };
        },
      },
      fileSystem: {},
      environment: recoveryEnvironment(),
      runRecovery: async ({ completeDatabaseLock, completeHostGuard }) => {
        await completeDatabaseLock();
        await completeHostGuard();
        return { recovered: true };
      },
    });

    assert.deepEqual(result, { recovered: true });
    assert.deepEqual(events, [
      'database-protocol-finalize',
      'host-complete',
      'absence-release',
    ]);
  });

test('local-child import recovery stays blocked until exact child proof, then resumes idempotently',
  async () => {
    const localChildRecovery = localChildRecoveryAuthority();
    const evidence = recoveryEvidence({ localChildRecovery });
    const reason = 'IMPORT_LOCAL_CHILD_SETTLEMENT_UNPROVEN';
    const childStillActive = new Error('exact child supervisor still reports activity');
    const remoteRecoveryFailure = new Error('simulated crash after DB transition');
    let childRecoveryCalls = 0;
    let databaseState = 'local-child';
    let databaseTransitions = 0;
    let databaseCompletions = 0;
    let hostCompletions = 0;
    let hostRetained = true;
    let remoteRecoveryRuns = 0;
    const assertAppStartBlocked = () => {
      if (hostRetained) throw new Error('HOST_OPERATION_LOCK_RETAINED');
    };
    const { runRetainedProductionImportRecoveryCli } = await import(
      '../scripts/production-import-recovery.js'
    );
    const adapters = {
      databaseLockModule: {
        DEFAULT_DATABASE_OPERATION_LOCK_FILE: 'retained-database-marker',
        async proveDatabaseOperationLockAbsent() {
          if (databaseState === 'absent') {
            return databaseAbsenceLease('retained-database-marker');
          }
          throw databaseProtocolError('DATABASE_OPERATION_LOCK_NOT_ABSENT');
        },
        async openDatabaseOperationLockAbsenceProof() {
          throw databaseProtocolError('DATABASE_OPERATION_LOCK_ABSENCE_LEASE_AMBIGUOUS');
        },
        async openRetainedDatabaseOperationLock() {
          assert.equal(databaseState, 'retained');
          return {
            evidence,
            reason,
            complete: async () => {
              databaseCompletions += 1;
              databaseState = 'absent';
            },
          };
        },
        async retainDatabaseOperationLocalChildRecovery(options) {
          databaseTransitions += 1;
          assert.deepEqual(options.expectedLocalChildRecovery, localChildRecovery);
          assert.deepEqual(options.recoveryEvidence, evidence);
          assert.equal(options.reason, reason);
          assert.ok(databaseState === 'local-child' || databaseState === 'retained');
          databaseState = 'retained';
        },
      },
      hostLockModule: {
        async openRetainedHostOperationLock() {
          assert.equal(hostRetained, true);
          return {
            operation: 'database-import',
            reason,
            evidence,
            complete: async () => {
              assert.equal(databaseState, 'absent');
              hostCompletions += 1;
              hostRetained = false;
            },
          };
        },
      },
      fileSystem: {},
      environment: recoveryEnvironment(),
      workingDirectory: projectDirectory,
      recoverLocalChildControl: async ({ recoveryAuthority }) => {
        childRecoveryCalls += 1;
        assert.deepEqual(recoveryAuthority, localChildRecovery.controller);
        if (childRecoveryCalls === 1) throw childStillActive;
        if (childRecoveryCalls === 2) {
          return {
            recoveryAuthority: {
              controlDirectory: path.join(
                path.dirname(recoveryAuthority.controlDirectory),
                'f'.repeat(64),
              ),
            },
            state: 'absent',
          };
        }
        return { recoveryAuthority, state: 'absent' };
      },
      runRecovery: async ({ completeDatabaseLock, completeHostGuard }) => {
        remoteRecoveryRuns += 1;
        assert.throws(assertAppStartBlocked, /HOST_OPERATION_LOCK_RETAINED/u);
        if (remoteRecoveryRuns === 1) throw remoteRecoveryFailure;
        await completeDatabaseLock();
        await completeHostGuard();
        return { recovered: true };
      },
    };

    await assert.rejects(
      runRetainedProductionImportRecoveryCli(adapters),
      (error) => error === childStillActive,
    );
    assert.equal(databaseTransitions, 0);
    assert.throws(assertAppStartBlocked, /HOST_OPERATION_LOCK_RETAINED/u);

    await assert.rejects(
      runRetainedProductionImportRecoveryCli(adapters),
      /supervisor authority changed during recovery/u,
    );
    assert.equal(databaseTransitions, 0);
    assert.throws(assertAppStartBlocked, /HOST_OPERATION_LOCK_RETAINED/u);

    await assert.rejects(
      runRetainedProductionImportRecoveryCli(adapters),
      (error) => error === remoteRecoveryFailure,
    );
    assert.equal(databaseState, 'retained');
    assert.throws(assertAppStartBlocked, /HOST_OPERATION_LOCK_RETAINED/u);

    const result = await runRetainedProductionImportRecoveryCli(adapters);
    assert.deepEqual(result, { recovered: true });
    assert.doesNotThrow(assertAppStartBlocked);
    assert.equal(childRecoveryCalls, 4);
    assert.equal(databaseTransitions, 2);
    assert.equal(remoteRecoveryRuns, 2);
    assert.equal(databaseCompletions, 1);
    assert.equal(hostCompletions, 1);
  });

test('retained import recovery discovers an unknown owned container and completes both guards only after exact proofs',
  async () => {
    const calls = [];
    const events = [];
    let ownershipInventoryCalls = 0;
    const runDocker = async (arguments_, options = {}) => {
      calls.push({ arguments_, options });
      if (arguments_[0] === 'ps') {
        ownershipInventoryCalls += 1;
        return ownershipInventoryCalls === 1 ? IMPORT_CONTAINER_ID : '';
      }
      if (arguments_[0] === 'inspect' && arguments_.at(-1) === IMPORT_CONTAINER_ID) {
        return [
          IMPORT_CONTAINER_ID,
          OWNERSHIP_TOKEN,
          'easyboost-production',
          'app',
          'True',
          APP_IMAGE_ID,
        ].join('|');
      }
      if (arguments_[0] === 'compose' && arguments_.at(-1) === 'postgres') {
        return POSTGRES_CONTAINER_ID;
      }
      if (arguments_[0] === 'inspect' && arguments_.at(-1) === POSTGRES_CONTAINER_ID) {
        return [
          POSTGRES_CONTAINER_ID,
          POSTGRES_IMAGE_ID,
          'easyboost-production',
          'postgres',
          'False',
          'true',
        ].join('|');
      }
      if (arguments_[0] === 'exec' && arguments_.some((argument) => (
        String(argument).includes('pg_stat_activity')
      ))) return '0';
      if (arguments_[0] === 'compose' && arguments_.at(-1) === 'app') return '';
      if (arguments_[0] === 'rm') return IMPORT_CONTAINER_ID;
      throw new Error(`Unexpected Docker call: ${arguments_.join(' ')}`);
    };
    const { recoverRetainedProductionImport } = await import(
      '../scripts/production-import-recovery.js'
    );

    const result = await recoverRetainedProductionImport({
      evidence: recoveryEvidence(),
      environment: recoveryEnvironment(),
      composeFile: 'compose.production.yml',
      runDocker,
      completeDatabaseLock: async () => { events.push('database-complete'); },
      completeHostGuard: async () => { events.push('host-complete'); },
    });

    assert.deepEqual(result, {
      applicationName: APPLICATION_NAME,
      importContainerId: IMPORT_CONTAINER_ID,
      postgresContainerId: POSTGRES_CONTAINER_ID,
      recovered: true,
    });
    assert.deepEqual(events, ['database-complete', 'host-complete']);
    assert.ok(calls.filter(({ arguments_ }) => arguments_[0] === 'compose')
      .every(({ arguments_ }) => (
        assert.deepEqual(arguments_.slice(0, COMPOSE_PREFIX.length), COMPOSE_PREFIX) === undefined
      )));
    assert.deepEqual(calls.filter(({ arguments_ }) => arguments_[0] === 'rm')
      .map(({ arguments_ }) => arguments_), [
      ['rm', '--force', IMPORT_CONTAINER_ID],
    ]);
    const removalIndex = calls.findIndex(({ arguments_ }) => arguments_[0] === 'rm');
    assert.ok(removalIndex > calls.findIndex(({ arguments_ }) => (
      arguments_[0] === 'compose' && arguments_.at(-1) === 'app'
    )), 'foreign authority and activity proofs must finish before the first mutation');
    assert.ok(calls.slice(removalIndex + 1).some(({ arguments_ }) => (
      arguments_[0] === 'exec' && arguments_.some((argument) => (
        String(argument).includes('pg_stat_activity')
      ))
    )), 'database settlement must be re-proven after container removal');
  });

test('retained import recovery rejects a foreign Compose project before mutation', async () => {
  const calls = [];
  const completions = [];
  const runDocker = async (arguments_, options = {}) => {
    calls.push({ arguments_, options });
    if (arguments_[0] === 'ps') return IMPORT_CONTAINER_ID;
    if (arguments_[0] === 'inspect' && arguments_.at(-1) === IMPORT_CONTAINER_ID) {
      if (!arguments_[2].includes('{{.Image}}')) {
        return [
          IMPORT_CONTAINER_ID,
          OWNERSHIP_TOKEN,
          'easyboost-production',
          'app',
          'True',
        ].join('|');
      }
      return [
        IMPORT_CONTAINER_ID,
        OWNERSHIP_TOKEN,
        'foreign-project',
        'app',
        'True',
        APP_IMAGE_ID,
      ].join('|');
    }
    throw new Error(`Unexpected Docker call: ${arguments_.join(' ')}`);
  };
  const { recoverRetainedProductionImport } = await import(
    '../scripts/production-import-recovery.js'
  );

  await assert.rejects(recoverRetainedProductionImport({
    evidence: recoveryEvidence(),
    environment: recoveryEnvironment(),
    composeFile: 'compose.production.yml',
    runDocker,
    completeDatabaseLock: async () => { completions.push('database'); },
    completeHostGuard: async () => { completions.push('host'); },
  }), /foreign or lacks exact authority/u);

  assert.deepEqual(completions, []);
  assert.equal(calls.some(({ arguments_ }) => arguments_[0] === 'rm'), false);
  assert.equal(calls.some(({ arguments_ }) => arguments_[0] === 'exec'), false);
});

test('retained import recovery rejects ambiguous ownership without inspecting or deleting', async () => {
  const calls = [];
  const firstContainerId = '1'.repeat(64);
  const secondContainerId = '2'.repeat(64);
  const runDocker = async (arguments_, options = {}) => {
    calls.push({ arguments_, options });
    if (arguments_[0] === 'ps') return `${firstContainerId}\n${secondContainerId}`;
    throw new Error(`Unexpected Docker call: ${arguments_.join(' ')}`);
  };
  const { recoverRetainedProductionImport } = await import(
    '../scripts/production-import-recovery.js'
  );

  await assert.rejects(recoverRetainedProductionImport({
    evidence: recoveryEvidence(),
    environment: recoveryEnvironment(),
    composeFile: 'compose.production.yml',
    runDocker,
    completeDatabaseLock: async () => {},
    completeHostGuard: async () => {},
  }), /ownership inventory is ambiguous/u);

  assert.equal(calls.some(({ arguments_ }) => arguments_[0] === 'inspect'), false);
  assert.equal(calls.some(({ arguments_ }) => arguments_[0] === 'rm'), false);
});

test('retained import recovery keeps both guards while tagged PostgreSQL activity is active',
  async () => {
    const calls = [];
    const completions = [];
    const runDocker = async (arguments_, options = {}) => {
      calls.push({ arguments_, options });
      if (arguments_[0] === 'ps') return '';
      if (arguments_[0] === 'compose' && arguments_.at(-1) === 'postgres') {
        return POSTGRES_CONTAINER_ID;
      }
      if (arguments_[0] === 'inspect' && arguments_.at(-1) === POSTGRES_CONTAINER_ID) {
        return [
          POSTGRES_CONTAINER_ID,
          POSTGRES_IMAGE_ID,
          'easyboost-production',
          'postgres',
          'False',
          'true',
        ].join('|');
      }
      if (arguments_[0] === 'exec') return '1';
      throw new Error(`Unexpected Docker call: ${arguments_.join(' ')}`);
    };
    const { recoverRetainedProductionImport } = await import(
      '../scripts/production-import-recovery.js'
    );

    await assert.rejects(recoverRetainedProductionImport({
      evidence: recoveryEvidence(),
      environment: recoveryEnvironment(),
      composeFile: 'compose.production.yml',
      runDocker,
      completeDatabaseLock: async () => { completions.push('database'); },
      completeHostGuard: async () => { completions.push('host'); },
    }), /activity is still active/u);

    assert.deepEqual(completions, []);
    assert.equal(calls.some(({ arguments_ }) => arguments_[0] === 'rm'), false);
  });

test('retained import recovery keeps both guards when exact container removal fails', async () => {
  const calls = [];
  const completions = [];
  const removalError = new Error('simulated exact removal failure');
  const runDocker = async (arguments_, options = {}) => {
    calls.push({ arguments_, options });
    if (arguments_[0] === 'ps') return IMPORT_CONTAINER_ID;
    if (arguments_[0] === 'inspect' && arguments_.at(-1) === IMPORT_CONTAINER_ID) {
      if (!arguments_[2].includes('{{.Image}}')) {
        return [
          IMPORT_CONTAINER_ID,
          OWNERSHIP_TOKEN,
          'easyboost-production',
          'app',
          'True',
        ].join('|');
      }
      return [
        IMPORT_CONTAINER_ID,
        OWNERSHIP_TOKEN,
        'easyboost-production',
        'app',
        'True',
        APP_IMAGE_ID,
      ].join('|');
    }
    if (arguments_[0] === 'compose' && arguments_.at(-1) === 'postgres') {
      return POSTGRES_CONTAINER_ID;
    }
    if (arguments_[0] === 'inspect' && arguments_.at(-1) === POSTGRES_CONTAINER_ID) {
      return [
        POSTGRES_CONTAINER_ID,
        POSTGRES_IMAGE_ID,
        'easyboost-production',
        'postgres',
        'False',
        'true',
      ].join('|');
    }
    if (arguments_[0] === 'exec') return '0';
    if (arguments_[0] === 'compose' && arguments_.at(-1) === 'app') {
      return IMPORT_CONTAINER_ID;
    }
    if (arguments_[0] === 'rm') throw removalError;
    throw new Error(`Unexpected Docker call: ${arguments_.join(' ')}`);
  };
  const { recoverRetainedProductionImport } = await import(
    '../scripts/production-import-recovery.js'
  );

  await assert.rejects(recoverRetainedProductionImport({
    evidence: recoveryEvidence(),
    environment: recoveryEnvironment(),
    composeFile: 'compose.production.yml',
    runDocker,
    completeDatabaseLock: async () => { completions.push('database'); },
    completeHostGuard: async () => { completions.push('host'); },
  }), (error) => error === removalError);

  assert.deepEqual(completions, []);
  assert.deepEqual(calls.filter(({ arguments_ }) => arguments_[0] === 'rm')
    .map(({ arguments_ }) => arguments_), [['rm', '--force', IMPORT_CONTAINER_ID]]);
});

test('retained import recovery CLI rejects DB absence leases outside exact protocol authority',
  async (t) => {
    const databaseLockFile = 'retained-database-marker';
    const scenarios = [
      {
        label: 'wrong protocol',
        lease: {
          ...databaseAbsenceLease(databaseLockFile),
          protocol: 'easyboost-database-operation-lock-absence-lease-obsolete',
        },
      },
      {
        label: 'foreign lock file',
        lease: databaseAbsenceLease('foreign-database-marker'),
      },
    ];
    for (const scenario of scenarios) {
      await t.test(scenario.label, async () => {
        let databaseLeaseReleases = 0;
        let hostCompletions = 0;
        let recoveryRuns = 0;
        const unsafeLease = {
          ...scenario.lease,
          release: async () => { databaseLeaseReleases += 1; },
        };
        const { runRetainedProductionImportRecoveryCli } = await import(
          '../scripts/production-import-recovery.js'
        );

        await assert.rejects(runRetainedProductionImportRecoveryCli({
          databaseLockModule: {
            DEFAULT_DATABASE_OPERATION_LOCK_FILE: databaseLockFile,
            async proveDatabaseOperationLockAbsent() { return unsafeLease; },
            async openDatabaseOperationLockAbsenceProof() {
              throw new Error('unsafe absence lease must fail before a reopen attempt');
            },
            async openRetainedDatabaseOperationLock() {
              throw new Error('unsafe absence lease must fail before retained DB open');
            },
          },
          hostLockModule: {
            async openRetainedHostOperationLock() {
              return {
                operation: 'database-import',
                reason: 'IMPORT_CONTAINER_SETTLEMENT_UNPROVEN',
                evidence: recoveryEvidence(),
                complete: async () => { hostCompletions += 1; },
              };
            },
          },
          fileSystem: {},
          environment: recoveryEnvironment(),
          runRecovery: async ({ completeDatabaseLock, completeHostGuard }) => {
            recoveryRuns += 1;
            await completeDatabaseLock();
            await completeHostGuard();
          },
        }), /Database operation absence lease adapter returned unsafe authority/u);

        await new Promise((resolve) => { setImmediate(resolve); });
        assert.equal(recoveryRuns, 0);
        assert.equal(hostCompletions, 0);
        assert.equal(databaseLeaseReleases, 0);
      });
    }
  });

test('retained import recovery validates the DB absence lease created after DB completion',
  async (t) => {
    const databaseLockFile = 'retained-database-marker';
    const scenarios = [
      {
        label: 'wrong protocol',
        lease: {
          ...databaseAbsenceLease(databaseLockFile),
          protocol: 'easyboost-database-operation-lock-absence-lease-obsolete',
        },
      },
      {
        label: 'foreign lock file',
        lease: databaseAbsenceLease('foreign-database-marker'),
      },
    ];
    for (const scenario of scenarios) {
      await t.test(scenario.label, async () => {
        let absenceProofCalls = 0;
        let databaseCompletions = 0;
        let databaseLeaseReleases = 0;
        let hostCompletions = 0;
        let recoveryRuns = 0;
        const unsafeLease = {
          ...scenario.lease,
          release: async () => { databaseLeaseReleases += 1; },
        };
        const evidence = recoveryEvidence();
        const { runRetainedProductionImportRecoveryCli } = await import(
          '../scripts/production-import-recovery.js'
        );

        await assert.rejects(runRetainedProductionImportRecoveryCli({
          databaseLockModule: {
            DEFAULT_DATABASE_OPERATION_LOCK_FILE: databaseLockFile,
            async proveDatabaseOperationLockAbsent() {
              absenceProofCalls += 1;
              if (absenceProofCalls === 1) {
                throw databaseProtocolError('DATABASE_OPERATION_LOCK_NOT_ABSENT');
              }
              return unsafeLease;
            },
            async openDatabaseOperationLockAbsenceProof() {
              throw databaseProtocolError(
                'DATABASE_OPERATION_LOCK_ABSENCE_LEASE_AMBIGUOUS',
              );
            },
            async openRetainedDatabaseOperationLock() {
              return {
                evidence,
                reason: 'IMPORT_CONTAINER_SETTLEMENT_UNPROVEN',
                complete: async () => { databaseCompletions += 1; },
              };
            },
          },
          hostLockModule: {
            async openRetainedHostOperationLock() {
              return {
                operation: 'database-import',
                reason: 'IMPORT_CONTAINER_SETTLEMENT_UNPROVEN',
                evidence,
                complete: async () => { hostCompletions += 1; },
              };
            },
          },
          fileSystem: {},
          environment: recoveryEnvironment(),
          runRecovery: async ({ completeDatabaseLock, completeHostGuard }) => {
            recoveryRuns += 1;
            await completeDatabaseLock();
            await completeHostGuard();
          },
        }), /Database operation absence lease adapter returned unsafe authority/u);

        await new Promise((resolve) => { setImmediate(resolve); });
        assert.equal(recoveryRuns, 1);
        assert.equal(databaseCompletions, 1);
        assert.equal(hostCompletions, 0);
        assert.equal(databaseLeaseReleases, 0);
      });
    }
  });

test('retained import recovery validates a reopened DB absence lease before host-only retry',
  async (t) => {
    const databaseLockFile = 'retained-database-marker';
    const scenarios = [
      {
        label: 'wrong protocol',
        lease: {
          ...databaseAbsenceLease(databaseLockFile),
          protocol: 'easyboost-database-operation-lock-absence-lease-obsolete',
        },
      },
      {
        label: 'foreign lock file',
        lease: databaseAbsenceLease('foreign-database-marker'),
      },
    ];
    for (const scenario of scenarios) {
      await t.test(scenario.label, async () => {
        let databaseLeaseReleases = 0;
        let hostCompletions = 0;
        let recoveryRuns = 0;
        let retainedDatabaseOpens = 0;
        const unsafeLease = {
          ...scenario.lease,
          release: async () => { databaseLeaseReleases += 1; },
        };
        const { runRetainedProductionImportRecoveryCli } = await import(
          '../scripts/production-import-recovery.js'
        );

        await assert.rejects(runRetainedProductionImportRecoveryCli({
          databaseLockModule: {
            DEFAULT_DATABASE_OPERATION_LOCK_FILE: databaseLockFile,
            async proveDatabaseOperationLockAbsent() {
              throw databaseProtocolError('DATABASE_OPERATION_LOCK_NOT_ABSENT');
            },
            async openDatabaseOperationLockAbsenceProof() { return unsafeLease; },
            async openRetainedDatabaseOperationLock() { retainedDatabaseOpens += 1; },
          },
          hostLockModule: {
            async openRetainedHostOperationLock() {
              return {
                operation: 'database-import',
                reason: 'IMPORT_CONTAINER_SETTLEMENT_UNPROVEN',
                evidence: recoveryEvidence(),
                complete: async () => { hostCompletions += 1; },
              };
            },
          },
          fileSystem: {},
          environment: recoveryEnvironment(),
          runRecovery: async () => { recoveryRuns += 1; },
        }), /Database operation absence lease adapter returned unsafe authority/u);

        await new Promise((resolve) => { setImmediate(resolve); });
        assert.equal(recoveryRuns, 0);
        assert.equal(retainedDatabaseOpens, 0);
        assert.equal(hostCompletions, 0);
        assert.equal(databaseLeaseReleases, 0);
      });
    }
  });

test('retained import recovery CLI compares DB and host evidence semantically, not by property order',
  async () => {
    const databaseEvidence = recoveryEvidence();
    const hostEvidence = {
      postgresContainerId: databaseEvidence.postgresContainerId,
      ownershipToken: databaseEvidence.ownershipToken,
      operationToken: databaseEvidence.operationToken,
      lastProbe: {
        status: databaseEvidence.lastProbe.status,
        activityCount: databaseEvidence.lastProbe.activityCount,
        process: databaseEvidence.lastProbe.process,
      },
      kind: databaseEvidence.kind,
      importContainerId: databaseEvidence.importContainerId,
      applicationName: databaseEvidence.applicationName,
    };
    const events = [];
    const fileSystem = {};
    let absenceProofCalls = 0;
    const { runRetainedProductionImportRecoveryCli } = await import(
      '../scripts/production-import-recovery.js'
    );

    const result = await runRetainedProductionImportRecoveryCli({
      databaseLockModule: {
        DEFAULT_DATABASE_OPERATION_LOCK_FILE: 'retained-database-marker',
        async proveDatabaseOperationLockAbsent(options) {
          absenceProofCalls += 1;
          assert.deepEqual(options, {
            fileSystem,
            lockFile: 'retained-database-marker',
          });
          if (absenceProofCalls === 1) {
            throw databaseProtocolError('DATABASE_OPERATION_LOCK_NOT_ABSENT');
          }
          events.push('absence-lease-acquire');
          return databaseAbsenceLease(
            'retained-database-marker',
            async () => { events.push('absence-lease-release'); },
          );
        },
        async openDatabaseOperationLockAbsenceProof(options) {
          assert.deepEqual(options, {
            fileSystem,
            lockFile: 'retained-database-marker',
          });
          throw databaseProtocolError(
            'DATABASE_OPERATION_LOCK_ABSENCE_LEASE_AMBIGUOUS',
          );
        },
        async openRetainedDatabaseOperationLock(options) {
          assert.deepEqual(options, {
            expectedEvidenceKind: 'import',
            fileSystem,
            lockFile: 'retained-database-marker',
          });
          return {
            evidence: databaseEvidence,
            reason: 'IMPORT_CONTAINER_SETTLEMENT_UNPROVEN',
            complete: async () => { events.push('database-complete'); },
          };
        },
      },
      hostLockModule: {
        async openRetainedHostOperationLock(options) {
          assert.equal(options.expectedOperation, 'database-import');
          return {
            operation: 'database-import',
            reason: 'IMPORT_CONTAINER_SETTLEMENT_UNPROVEN',
            evidence: hostEvidence,
            complete: async () => { events.push('host-complete'); },
          };
        },
      },
      fileSystem,
      environment: recoveryEnvironment(),
      runRecovery: async ({
        completeDatabaseLock,
        completeHostGuard,
        evidence,
      }) => {
        assert.deepEqual(evidence, databaseEvidence);
        await completeDatabaseLock();
        await completeHostGuard();
        return { recovered: true };
      },
    });

    assert.deepEqual(result, { recovered: true });
    assert.deepEqual(events, [
      'database-complete',
      'absence-lease-acquire',
      'host-complete',
      'absence-lease-release',
    ]);
  });

test('retained import recovery CLI resumes host-only after DB completion and a failed host completion',
  async () => {
    const evidence = recoveryEvidence();
    const hostCompletionError = new Error('simulated host completion failure');
    let databasePresent = true;
    let databaseOpenCalls = 0;
    let databaseCompletionCalls = 0;
    let absenceLeaseHeld = false;
    let absenceLeaseAcquisitions = 0;
    let absenceLeaseReleases = 0;
    let hostOpenCalls = 0;
    let hostCompletionCalls = 0;
    let proofRuns = 0;
    const { runRetainedProductionImportRecoveryCli } = await import(
      '../scripts/production-import-recovery.js'
    );
    const adapters = {
      databaseLockModule: {
        DEFAULT_DATABASE_OPERATION_LOCK_FILE: 'retained-database-marker',
        async proveDatabaseOperationLockAbsent() {
          if (databasePresent || absenceLeaseHeld) {
            throw databaseProtocolError('DATABASE_OPERATION_LOCK_NOT_ABSENT');
          }
          absenceLeaseHeld = true;
          absenceLeaseAcquisitions += 1;
          return databaseAbsenceLease(
            'retained-database-marker',
            async () => {
              absenceLeaseHeld = false;
              absenceLeaseReleases += 1;
            },
          );
        },
        async openDatabaseOperationLockAbsenceProof() {
          if (!absenceLeaseHeld) {
            throw databaseProtocolError(
              'DATABASE_OPERATION_LOCK_ABSENCE_LEASE_AMBIGUOUS',
            );
          }
          return databaseAbsenceLease(
            'retained-database-marker',
            async () => {
              absenceLeaseHeld = false;
              absenceLeaseReleases += 1;
            },
          );
        },
        async openRetainedDatabaseOperationLock() {
          databaseOpenCalls += 1;
          return {
            evidence,
            reason: 'IMPORT_CONTAINER_SETTLEMENT_UNPROVEN',
            complete: async () => {
              databaseCompletionCalls += 1;
              databasePresent = false;
            },
          };
        },
      },
      hostLockModule: {
        async openRetainedHostOperationLock() {
          hostOpenCalls += 1;
          return {
            operation: 'database-import',
            reason: 'IMPORT_CONTAINER_SETTLEMENT_UNPROVEN',
            evidence,
            complete: async () => {
              hostCompletionCalls += 1;
              assert.equal(absenceLeaseHeld, true,
                'host completion must run while the DB absence lease is held');
              if (hostCompletionCalls === 1) throw hostCompletionError;
            },
          };
        },
      },
      fileSystem: {},
      environment: recoveryEnvironment(),
      runRecovery: async ({ completeDatabaseLock, completeHostGuard }) => {
        proofRuns += 1;
        await completeDatabaseLock();
        await completeHostGuard();
        return { recovered: true };
      },
    };

    await assert.rejects(
      runRetainedProductionImportRecoveryCli(adapters),
      (error) => error === hostCompletionError,
    );
    assert.equal(databasePresent, false);
    const result = await runRetainedProductionImportRecoveryCli(adapters);

    assert.deepEqual(result, { recovered: true });
    assert.equal(proofRuns, 2, 'host-only retry must re-run every Docker/PG/app proof');
    assert.equal(databaseOpenCalls, 1, 'host-only retry must not fabricate a DB marker handle');
    assert.equal(databaseCompletionCalls, 1);
    assert.equal(absenceLeaseAcquisitions, 1,
      'the failed host completion must leave the original DB absence lease held');
    assert.equal(absenceLeaseReleases, 1);
    assert.equal(absenceLeaseHeld, false);
    assert.equal(hostOpenCalls, 2);
    assert.equal(hostCompletionCalls, 2);
  });

test('retained import recovery CLI reopens a held DB absence lease for host-only recovery',
  async () => {
    const evidence = recoveryEvidence();
    const events = [];
    let proofRuns = 0;
    const { runRetainedProductionImportRecoveryCli } = await import(
      '../scripts/production-import-recovery.js'
    );

    const result = await runRetainedProductionImportRecoveryCli({
      databaseLockModule: {
        DEFAULT_DATABASE_OPERATION_LOCK_FILE: 'retained-database-marker',
        async proveDatabaseOperationLockAbsent() {
          throw databaseProtocolError('DATABASE_OPERATION_LOCK_NOT_ABSENT');
        },
        async openDatabaseOperationLockAbsenceProof() {
          events.push('absence-lease-reopened');
          return databaseAbsenceLease(
            'retained-database-marker',
            async () => { events.push('absence-lease-release'); },
          );
        },
        async openRetainedDatabaseOperationLock() {
          throw new Error('retained DB marker must not be opened in host-only recovery');
        },
      },
      hostLockModule: {
        async openRetainedHostOperationLock() {
          return {
            operation: 'database-import',
            reason: 'IMPORT_CONTAINER_SETTLEMENT_UNPROVEN',
            evidence,
            complete: async () => { events.push('host-complete'); },
          };
        },
      },
      fileSystem: {},
      environment: recoveryEnvironment(),
      runRecovery: async ({ completeDatabaseLock, completeHostGuard }) => {
        proofRuns += 1;
        await completeDatabaseLock();
        await completeHostGuard();
        return { recovered: true };
      },
    });

    assert.deepEqual(result, { recovered: true });
    assert.equal(proofRuns, 1);
    assert.deepEqual(events, [
      'absence-lease-reopened',
      'host-complete',
      'absence-lease-release',
    ]);
  });

test('retained import recovery CLI never treats an arbitrary DB open failure as host-only',
  async () => {
    const databaseOpenError = new Error('simulated retained DB marker read failure');
    let proofRuns = 0;
    const { runRetainedProductionImportRecoveryCli } = await import(
      '../scripts/production-import-recovery.js'
    );

    await assert.rejects(runRetainedProductionImportRecoveryCli({
      databaseLockModule: {
        DEFAULT_DATABASE_OPERATION_LOCK_FILE: 'retained-database-marker',
        async proveDatabaseOperationLockAbsent() {
          throw databaseProtocolError('DATABASE_OPERATION_LOCK_NOT_ABSENT');
        },
        async openDatabaseOperationLockAbsenceProof() {
          throw databaseProtocolError(
            'DATABASE_OPERATION_LOCK_ABSENCE_LEASE_AMBIGUOUS',
          );
        },
        async openRetainedDatabaseOperationLock() { throw databaseOpenError; },
      },
      hostLockModule: {
        async openRetainedHostOperationLock() {
          return {
            operation: 'database-import',
            reason: 'IMPORT_CONTAINER_SETTLEMENT_UNPROVEN',
            evidence: recoveryEvidence(),
            complete: async () => {},
          };
        },
      },
      fileSystem: {},
      environment: recoveryEnvironment(),
      runRecovery: async () => { proofRuns += 1; },
    }), (error) => error === databaseOpenError);

    assert.equal(proofRuns, 0);
  });

test('retained import recovery CLI fails closed on unexpected retained-host state',
  async () => {
    const hostStateError = new Error('simulated ambiguous retained host state');
    hostStateError.code = 'HOST_OPERATION_LOCK_OWNERSHIP_CHANGED';
    let databaseCalls = 0;
    let hostAbsenceLeaseCalls = 0;
    const { runRetainedProductionImportRecoveryCli } = await import(
      '../scripts/production-import-recovery.js'
    );

    await assert.rejects(runRetainedProductionImportRecoveryCli({
      databaseLockModule: {
        DEFAULT_DATABASE_OPERATION_LOCK_FILE: 'retained-database-marker',
        async openDatabaseOperationLockAbsenceProof() { databaseCalls += 1; },
      },
      hostLockModule: {
        async openRetainedHostOperationLock() { throw hostStateError; },
        async acquireHostOperationAbsenceLease() {
          hostAbsenceLeaseCalls += 1;
        },
      },
      fileSystem: {},
      environment: recoveryEnvironment(),
    }), (error) => error === hostStateError);

    assert.equal(databaseCalls, 0);
    assert.equal(hostAbsenceLeaseCalls, 0);
  });

test('retained import recovery lease-only restart rejects DB absence leases outside exact authority',
  async (t) => {
    const databaseLockFile = 'retained-database-marker';
    const scenarios = [
      {
        label: 'wrong protocol',
        lease: {
          ...databaseAbsenceLease(databaseLockFile),
          protocol: 'easyboost-database-operation-lock-absence-lease-obsolete',
        },
      },
      {
        label: 'foreign lock file',
        lease: databaseAbsenceLease('foreign-database-marker'),
      },
    ];
    for (const scenario of scenarios) {
      await t.test(scenario.label, async () => {
        let databaseLeaseReleases = 0;
        let hostAbsenceLeaseReleases = 0;
        let recoveryRuns = 0;
        const unsafeLease = {
          ...scenario.lease,
          release: async () => { databaseLeaseReleases += 1; },
        };
        const hostMissing = new Error('retained host marker is absent');
        hostMissing.code = 'ENOENT';
        const { runRetainedProductionImportRecoveryCli } = await import(
          '../scripts/production-import-recovery.js'
        );

        await assert.rejects(runRetainedProductionImportRecoveryCli({
          databaseLockModule: {
            DEFAULT_DATABASE_OPERATION_LOCK_FILE: databaseLockFile,
            async openDatabaseOperationLockAbsenceProof() { return unsafeLease; },
          },
          hostLockModule: {
            async openRetainedHostOperationLock() { throw hostMissing; },
            async acquireHostOperationAbsenceLease() {
              return {
                state: 'absent-leased',
                release: async () => { hostAbsenceLeaseReleases += 1; },
              };
            },
          },
          fileSystem: {},
          environment: recoveryEnvironment(),
          runRecovery: async () => { recoveryRuns += 1; },
        }), /Database operation absence lease adapter returned unsafe authority/u);

        await new Promise((resolve) => { setImmediate(resolve); });
        assert.equal(recoveryRuns, 0);
        assert.equal(databaseLeaseReleases, 0);
        assert.equal(hostAbsenceLeaseReleases, 1,
          'the temporary host absence lease must settle before rejection');
      });
    }
  });

test('retained import recovery CLI completes exact real DB and host import markers', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-import-recovery-locks-'));
  const databaseLockFile = path.join(directory, 'database-operation.lock');
  const hostLockDirectory = path.join(directory, 'host-operation.lock');
  try {
    const databaseLockModule = await import('../scripts/database-operation-lock.js');
    const hostLockModule = await import('../scripts/host-operation-lock.js');
    const evidence = recoveryEvidence();
    const reason = 'IMPORT_CONTAINER_SETTLEMENT_UNPROVEN';
    const releaseDatabaseLock = await databaseLockModule.acquireDatabaseOperationLock(
      databaseLockFile,
    );
    await databaseLockModule.retainDatabaseOperationLock(
      releaseDatabaseLock,
      1_000,
      reason,
      evidence,
    );
    const releaseHostGuard = await hostLockModule.acquireHostOperationLock({
      environment: recoveryEnvironment(),
      lockDirectory: hostLockDirectory,
      operation: 'database-import',
    });
    await hostLockModule.retainHostOperationLock(releaseHostGuard, 1_000, {
      ...evidence,
      retentionReason: reason,
    });
    const { runRetainedProductionImportRecoveryCli } = await import(
      '../scripts/production-import-recovery.js'
    );

    const result = await runRetainedProductionImportRecoveryCli({
      databaseLockModule: {
        ...databaseLockModule,
        DEFAULT_DATABASE_OPERATION_LOCK_FILE: databaseLockFile,
      },
      hostLockModule,
      environment: {
        ...recoveryEnvironment(),
        EASYBOOST_HOST_OPERATION_LOCK_DIR: hostLockDirectory,
      },
      runRecovery: async ({ completeDatabaseLock, completeHostGuard }) => {
        await completeDatabaseLock();
        await completeHostGuard();
        return { recovered: true };
      },
    });

    assert.deepEqual(result, { recovered: true });
    await assert.rejects(fs.lstat(databaseLockFile), { code: 'ENOENT' });
    await assert.rejects(fs.lstat(`${databaseLockFile}.authority`), { code: 'ENOENT' });
    await assert.rejects(fs.lstat(hostLockDirectory), { code: 'ENOENT' });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('retained import recovery CLI restarts from a real DB lease after host completion',
  async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-import-lease-restart-'));
    const databaseLockFile = path.join(directory, 'database-operation.lock');
    const hostLockDirectory = path.join(directory, 'host-operation.lock');
    try {
      const databaseLockModule = await import('../scripts/database-operation-lock.js');
      const hostLockModule = await import('../scripts/host-operation-lock.js');
      const evidence = recoveryEvidence();
      const reason = 'IMPORT_CONTAINER_SETTLEMENT_UNPROVEN';
      const releaseDatabaseLock = await databaseLockModule.acquireDatabaseOperationLock(
        databaseLockFile,
      );
      await databaseLockModule.retainDatabaseOperationLock(
        releaseDatabaseLock,
        1_000,
        reason,
        evidence,
      );
      const environment = {
        ...recoveryEnvironment(),
        EASYBOOST_HOST_OPERATION_LOCK_DIR: hostLockDirectory,
      };
      const releaseHostGuard = await hostLockModule.acquireHostOperationLock({
        environment,
        operation: 'database-import',
      });
      await hostLockModule.retainHostOperationLock(releaseHostGuard, 1_000, {
        ...evidence,
        retentionReason: reason,
      });
      const leaseReleaseError = new Error('simulated interruption before DB lease release');
      let leaseReleaseAttempts = 0;
      const interruptedDatabaseModule = {
        ...databaseLockModule,
        DEFAULT_DATABASE_OPERATION_LOCK_FILE: databaseLockFile,
        async proveDatabaseOperationLockAbsent(options) {
          const lease = await databaseLockModule.proveDatabaseOperationLockAbsent(options);
          return {
            ...lease,
            async release() {
              leaseReleaseAttempts += 1;
              throw leaseReleaseError;
            },
          };
        },
      };
      const { runRetainedProductionImportRecoveryCli } = await import(
        '../scripts/production-import-recovery.js'
      );

      await assert.rejects(runRetainedProductionImportRecoveryCli({
        databaseLockModule: interruptedDatabaseModule,
        hostLockModule,
        environment,
        runRecovery: async ({ completeDatabaseLock, completeHostGuard }) => {
          await completeDatabaseLock();
          await completeHostGuard();
        },
      }), (error) => error === leaseReleaseError);

      assert.equal(leaseReleaseAttempts, 1);
      await fs.lstat(databaseLockFile);
      await fs.lstat(`${databaseLockFile}.authority`);
      await assert.rejects(fs.lstat(hostLockDirectory), { code: 'ENOENT' });

      const result = await runRetainedProductionImportRecoveryCli({
        databaseLockModule: {
          ...databaseLockModule,
          DEFAULT_DATABASE_OPERATION_LOCK_FILE: databaseLockFile,
          async openDatabaseOperationLockAbsenceProof(options) {
            return databaseLockModule.openDatabaseOperationLockAbsenceProof({
              ...options,
              processLivenessProbe: async () => false,
            });
          },
        },
        hostLockModule,
        environment,
        runRecovery: async () => {
          throw new Error('lease-only restart must not repeat data-plane recovery');
        },
      });

      assert.deepEqual(result, { leaseOnly: true, recovered: true });
      await assert.rejects(fs.lstat(databaseLockFile), { code: 'ENOENT' });
      await assert.rejects(fs.lstat(`${databaseLockFile}.authority`), { code: 'ENOENT' });
      await assert.rejects(fs.lstat(hostLockDirectory), { code: 'ENOENT' });
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
