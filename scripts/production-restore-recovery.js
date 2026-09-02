import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runDockerCommand } from './postgres-restore.js';

const CANONICAL_CONTAINER_ID = /^[0-9a-f]{64}$/u;
const CANONICAL_IMAGE_ID = /^sha256:[0-9a-f]{64}$/u;
const CANONICAL_OPERATION_TOKEN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SAFE_PROBE_STATUS = /^(?:PENDING|STAGING|STAGED|RUNNING|EXIT:(?:0|[1-9]\d*)|UNKNOWN)$/u;
const PRODUCTION_COMPOSE_PROJECT = 'easyboost-production';
const ABSENCE_LEASE_PROTOCOL = 'easyboost-database-operation-lock-absence-lease-v1';
const SHELL_DOLLAR = '$';
const RESTORE_RETENTION_REASONS = new Set([
  'APPLICATION_ISOLATION_UNPROVEN_AFTER_DATABASE_RESTORE',
  'REMOTE_RESTORE_SETTLEMENT_UNPROVEN',
]);
const RESTORE_SETTLEMENT_SCRIPT = String.raw`
set -eu
token="$1"
application_name="$2"
probe_process() {
  process='NONE'
  for environment_file in /proc/[0-9]*/environ; do
    [ -r "$environment_file" ] || continue
    if tr '\000' '\n' < "$environment_file" 2>/dev/null \
      | grep -Fqx "EASYBOOST_RESTORE_OPERATION_TOKEN=${SHELL_DOLLAR}{token}"; then
      process='ACTIVE'
      break
    fi
  done
  printf '%s' "$process"
}
process_before="$(probe_process)"
activity="$(psql --no-password -U easyboost -d easyboost -At \
  --set "appname=${SHELL_DOLLAR}{application_name}" \
  -c "SELECT count(*) FROM pg_stat_activity WHERE application_name = :'appname';")"
case "$activity" in ''|*[!0-9]*) echo EASYBOOST_RESTORE_ACTIVITY_UNPROVEN >&2; exit 74;; esac
process_after="$(probe_process)"
printf 'PROCESS_BEFORE=%s\nACTIVITY=%s\nPROCESS_AFTER=%s\n' \
  "$process_before" "$activity" "$process_after"
`;

function usageError(message) {
  const error = new Error(message);
  error.exitCode = 2;
  return error;
}

function validateEvidence(evidence) {
  const status = evidence?.lastProbe?.status ?? 'UNKNOWN';
  const processState = evidence?.lastProbe?.process ?? 'UNKNOWN';
  const activityCount = evidence?.lastProbe?.activityCount ?? 'unknown';
  if (evidence?.kind !== 'restore'
      || !CANONICAL_OPERATION_TOKEN.test(evidence.operationToken || '')
      || evidence.applicationName !== `easyboost_restore_${evidence.operationToken}`
      || !CANONICAL_CONTAINER_ID.test(evidence.postgresContainerId || '')
      || !SAFE_PROBE_STATUS.test(status)
      || !/^(?:ACTIVE|NONE|UNKNOWN)$/u.test(processState)
      || !(activityCount === 'unknown'
        || (Number.isSafeInteger(activityCount) && activityCount >= 0))) {
    throw usageError('Production restore recovery evidence is invalid');
  }
  return {
    applicationName: evidence.applicationName,
    kind: 'restore',
    lastProbe: { activityCount, process: processState, status },
    operationToken: evidence.operationToken,
    postgresContainerId: evidence.postgresContainerId,
  };
}

function sameEvidence(left, right) {
  const normalizedLeft = validateEvidence(left);
  const normalizedRight = validateEvidence(right);
  return [
    'applicationName',
    'kind',
    'operationToken',
    'postgresContainerId',
  ].every((field) => normalizedLeft[field] === normalizedRight[field])
    && ['activityCount', 'process', 'status'].every((field) => (
      normalizedLeft.lastProbe[field] === normalizedRight.lastProbe[field]
    ));
}

function resolveCanonicalDatabaseLockFile(databaseLockModule) {
  const configuredLockFile = databaseLockModule?.DEFAULT_DATABASE_OPERATION_LOCK_FILE;
  if (typeof configuredLockFile !== 'string' || !configuredLockFile) {
    throw new Error('Database operation lock adapter has no canonical marker path');
  }
  return path.resolve(configuredLockFile);
}

function validateAbsenceLease(lease, databaseLockFile) {
  if (lease?.absent !== true
      || lease.protocol !== ABSENCE_LEASE_PROTOCOL
      || lease.lockFile !== databaseLockFile
      || typeof lease.release !== 'function') {
    throw new Error('Database operation lock absence lease is invalid');
  }
  return lease;
}

function resolveCanonicalHostLockDirectory(hostLockModule, environment) {
  const configuredDirectory = environment?.EASYBOOST_HOST_OPERATION_LOCK_DIR
    || hostLockModule?.DEFAULT_HOST_OPERATION_LOCK_DIRECTORY;
  if (typeof configuredDirectory !== 'string' || !configuredDirectory
      || !(path.isAbsolute(configuredDirectory)
        || path.posix.isAbsolute(configuredDirectory))) {
    throw new Error('Host operation lock adapter has no canonical lock directory');
  }
  return path.resolve(configuredDirectory);
}

function validateHostAbsenceLease(lease, hostLockDirectory) {
  if (lease?.state !== 'absent-leased'
      || lease.lockDirectory !== hostLockDirectory
      || typeof lease.release !== 'function') {
    throw new Error('Host operation absence lease adapter returned unsafe authority');
  }
  return lease;
}

async function releaseTemporaryHostAbsenceLease(hostAbsenceLease, primaryError = null) {
  try {
    await hostAbsenceLease.release();
  } catch (releaseError) {
    if (!primaryError) throw releaseError;
    throw new AggregateError(
      [primaryError, releaseError],
      'Restore recovery failed and releasing its temporary host absence lease also failed',
      { cause: primaryError },
    );
  }
  if (primaryError) throw primaryError;
}

async function completeLeaseOnlyRecovery({
  databaseLockFile,
  databaseLockModule,
  environment,
  hostLockDirectory,
  hostLockModule,
}) {
  if (typeof hostLockModule.acquireHostOperationAbsenceLease !== 'function') {
    throw new Error('Host operation absence lease adapter is unavailable');
  }
  const hostAbsenceLease = validateHostAbsenceLease(
    await hostLockModule.acquireHostOperationAbsenceLease({ environment }),
    hostLockDirectory,
  );
  try {
    const databaseAbsenceLease = validateAbsenceLease(
      await databaseLockModule.openDatabaseOperationLockAbsenceProof({
        lockFile: databaseLockFile,
      }),
      databaseLockFile,
    );
    await databaseAbsenceLease.release();
  } catch (error) {
    await releaseTemporaryHostAbsenceLease(hostAbsenceLease, error);
  }
  await releaseTemporaryHostAbsenceLease(hostAbsenceLease);
  return {
    databaseUsable: false,
    guardRecoveryCompleted: true,
    recoveryMode: 'lease-only-finalization',
    requiredOperatorAction: 'RERUN_FULL_GUARDED_DATABASE_ONLY_RESTORE',
  };
}

function approvedImageIds(environment) {
  const appImageId = environment?.EASYBOOST_PRODUCTION_APP_IMAGE_ID;
  const postgresImageId = environment?.EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID;
  if (!CANONICAL_IMAGE_ID.test(appImageId || '')
      || !CANONICAL_IMAGE_ID.test(postgresImageId || '')) {
    throw usageError('Production restore recovery requires owner-approved canonical image IDs');
  }
  return { appImageId, postgresImageId };
}

function composeArguments(composeFile, ...args) {
  return [
    'compose', '--project-name', PRODUCTION_COMPOSE_PROJECT,
    '-f', composeFile, ...args,
  ];
}

function oneContainerId(output, label) {
  const ids = String(output || '').split(/\r?\n/u).filter(Boolean);
  if (ids.length !== 1 || !CANONICAL_CONTAINER_ID.test(ids[0])) {
    throw new Error(`${label} requires exactly one canonical container ID`);
  }
  return ids[0];
}

async function provePostgresAuthority({ composeFile, dockerOptions, evidence, postgresImageId, runDocker }) {
  const postgresContainerId = oneContainerId(await runDocker(
    composeArguments(composeFile, 'ps', '--all', '--quiet', '--no-trunc', 'postgres'),
    { ...dockerOptions, capture: true },
  ), 'Production restore recovery PostgreSQL inventory');
  if (postgresContainerId !== evidence.postgresContainerId) {
    throw new Error('Production restore recovery PostgreSQL allocation changed');
  }
  const template = [
    '{{.Id}}',
    '{{.Image}}',
    '{{ index .Config.Labels "com.docker.compose.project" }}',
    '{{ index .Config.Labels "com.docker.compose.service" }}',
    '{{ index .Config.Labels "com.docker.compose.oneoff" }}',
    '{{.State.Running}}',
  ].join('|');
  const authority = await runDocker(
    ['inspect', '--format', template, postgresContainerId],
    { ...dockerOptions, capture: true },
  );
  const authorityPrefix = [
    postgresContainerId,
    postgresImageId,
    PRODUCTION_COMPOSE_PROJECT,
    'postgres',
    'False',
  ];
  const stopped = [...authorityPrefix, 'false'].join('|');
  const running = [...authorityPrefix, 'true'].join('|');
  if (authority !== stopped && authority !== running) {
    throw new Error('Production restore recovery PostgreSQL authority is unproven');
  }
  if (authority === stopped) {
    return { postgresContainerId, postgresState: 'stopped' };
  }
  const settlement = await runDocker([
    'exec', '-i', postgresContainerId,
    'sh', '-ceu', RESTORE_SETTLEMENT_SCRIPT,
    'easyboost-restore-recovery', evidence.operationToken, evidence.applicationName,
  ], {
    ...dockerOptions,
    capture: true,
    commandTimeoutMs: 10_000,
    maxCaptureBytes: 4_096,
  });
  if (settlement !== 'PROCESS_BEFORE=NONE\nACTIVITY=0\nPROCESS_AFTER=NONE') {
    throw new Error('Production restore recovery remote settlement is unproven');
  }
  return { postgresContainerId, postgresState: 'running' };
}

async function proveAppIsolation({ appImageId, composeFile, dockerOptions, runDocker }) {
  const output = await runDocker(
    composeArguments(composeFile, 'ps', '--all', '--quiet', '--no-trunc', 'app'),
    { ...dockerOptions, capture: true },
  );
  const inventory = String(output || '').split(/\r?\n/u).filter(Boolean);
  if (inventory.length === 0) return null;
  if (inventory.length !== 1 || !CANONICAL_CONTAINER_ID.test(inventory[0])) {
    throw new Error('Production application isolation inventory is ambiguous');
  }
  const [appContainerId] = inventory;
  const template = [
    '{{.Id}}',
    '{{.Image}}',
    '{{ index .Config.Labels "com.docker.compose.project" }}',
    '{{ index .Config.Labels "com.docker.compose.service" }}',
    '{{ index .Config.Labels "com.docker.compose.oneoff" }}',
    '{{.State.Running}}',
  ].join('|');
  const authorityPrefix = [
    appContainerId,
    appImageId,
    PRODUCTION_COMPOSE_PROJECT,
    'app',
    'False',
  ];
  const inspect = () => runDocker(
    ['inspect', '--format', template, appContainerId],
    { ...dockerOptions, capture: true },
  );
  const initialAuthority = await inspect();
  const stopped = [...authorityPrefix, 'false'].join('|');
  const running = [...authorityPrefix, 'true'].join('|');
  if (initialAuthority !== stopped && initialAuthority !== running) {
    throw new Error('Production application isolation authority is foreign');
  }
  if (initialAuthority === running) {
    await runDocker(
      ['stop', '--time', '10', appContainerId],
      { ...dockerOptions, capture: true, commandTimeoutMs: 20_000 },
    );
    const finalInventory = await runDocker(
      composeArguments(composeFile, 'ps', '--all', '--quiet', '--no-trunc', 'app'),
      { ...dockerOptions, capture: true },
    );
    if (finalInventory !== appContainerId || await inspect() !== stopped) {
      throw new Error('Production application isolation stop is unproven');
    }
  }
  return 'exact-app-stopped';
}

export async function recoverRetainedProductionRestore({
  completeDatabaseLock,
  completeHostGuard,
  composeFile = path.resolve('compose.production.yml'),
  environment = process.env,
  evidence,
  reason,
  runDocker = runDockerCommand,
} = {}) {
  const retainedEvidence = validateEvidence(evidence);
  if (!RESTORE_RETENTION_REASONS.has(reason)) {
    throw usageError('Production restore recovery reason is invalid');
  }
  if (typeof runDocker !== 'function'
      || typeof completeDatabaseLock !== 'function'
      || typeof completeHostGuard !== 'function') {
    throw usageError('Production restore recovery requires Docker and guard completion adapters');
  }
  const { appImageId, postgresImageId } = approvedImageIds(environment);
  const dockerOptions = {
    capture: true,
    commandTimeoutMs: 10_000,
    environment: { ...environment },
    maxCaptureBytes: 4_096,
  };
  await provePostgresAuthority({
    composeFile,
    dockerOptions,
    evidence: retainedEvidence,
    postgresImageId,
    runDocker,
  });
  const applicationIsolation = await proveAppIsolation({
    appImageId,
    composeFile,
    dockerOptions,
    runDocker,
  });
  const settlement = await provePostgresAuthority({
    composeFile,
    dockerOptions,
    evidence: retainedEvidence,
    postgresImageId,
    runDocker,
  });
  const finalApplicationIsolation = await proveAppIsolation({
    appImageId,
    composeFile,
    dockerOptions,
    runDocker,
  });
  await completeDatabaseLock();
  await completeHostGuard();
  return {
    databaseUsable: false,
    guardRecoveryCompleted: true,
    ...settlement,
    ...(finalApplicationIsolation || applicationIsolation
      ? { applicationIsolation: finalApplicationIsolation || applicationIsolation }
      : {}),
    requiredOperatorAction: 'RERUN_FULL_GUARDED_DATABASE_ONLY_RESTORE',
  };
}

export async function runRetainedProductionRestoreRecoveryCli({
  databaseLockModule,
  environment = process.env,
  hostLockModule,
  runRecovery = recoverRetainedProductionRestore,
} = {}) {
  if (typeof databaseLockModule?.openRetainedDatabaseOperationLock !== 'function'
      || typeof databaseLockModule?.openDatabaseOperationLockAbsenceProof !== 'function'
      || typeof databaseLockModule?.proveDatabaseOperationLockAbsent !== 'function'
      || typeof hostLockModule?.openRetainedHostOperationLock !== 'function') {
    throw new Error('Retained restore recovery lock adapters are unavailable');
  }
  const databaseLockFile = resolveCanonicalDatabaseLockFile(databaseLockModule);
  const hostLockDirectory = resolveCanonicalHostLockDirectory(hostLockModule, environment);
  let hostGuard;
  try {
    hostGuard = await hostLockModule.openRetainedHostOperationLock({
      environment,
      expectedOperation: 'database-restore',
    });
  } catch (hostOpenError) {
    if (hostOpenError?.code !== 'ENOENT') throw hostOpenError;
    return completeLeaseOnlyRecovery({
      databaseLockFile,
      databaseLockModule,
      environment,
      hostLockDirectory,
      hostLockModule,
    });
  }
  if (hostGuard?.lockDirectory !== hostLockDirectory) {
    throw new Error('Retained host operation lock authority is invalid');
  }
  let databaseLock;
  let absenceLease;
  try {
    absenceLease = validateAbsenceLease(
      await databaseLockModule.proveDatabaseOperationLockAbsent({
        lockFile: databaseLockFile,
      }),
      databaseLockFile,
    );
  } catch (error) {
    if (error.code !== 'DATABASE_OPERATION_LOCK_NOT_ABSENT') throw error;
    try {
      databaseLock = await databaseLockModule.openRetainedDatabaseOperationLock({
        expectedEvidenceKind: 'restore',
        lockFile: databaseLockFile,
      });
    } catch (retainedError) {
      try {
        absenceLease = validateAbsenceLease(
          await databaseLockModule.openDatabaseOperationLockAbsenceProof({
            lockFile: databaseLockFile,
          }),
          databaseLockFile,
        );
      } catch (absenceError) {
        throw new AggregateError(
          [retainedError, absenceError],
          'Database recovery authority is neither a retained restore nor an exact absence lease',
          { cause: retainedError },
        );
      }
    }
  }
  const hostEvidence = validateEvidence(hostGuard?.evidence);
  const databaseEvidence = databaseLock ? validateEvidence(databaseLock.evidence) : null;
  if (hostGuard?.operation !== 'database-restore'
      || !RESTORE_RETENTION_REASONS.has(hostGuard.reason)
      || (databaseLock && hostGuard.reason !== databaseLock.reason)
      || databaseLock?.legacy === true
      || (databaseEvidence && !sameEvidence(hostEvidence, databaseEvidence))
      || (hostGuard.evidence?.retentionReason !== undefined
        && hostGuard.evidence.retentionReason !== hostGuard.reason)
      || (databaseLock && typeof databaseLock.complete !== 'function')
      || typeof (hostGuard?.complete || hostGuard?.release) !== 'function') {
    throw new Error('Retained restore recovery guards do not share exact authority');
  }
  return runRecovery({
    completeDatabaseLock: async () => {
      if (databaseLock) {
        await databaseLock.complete();
        absenceLease = validateAbsenceLease(
          await databaseLockModule.proveDatabaseOperationLockAbsent({
            lockFile: databaseLockFile,
          }),
          databaseLockFile,
        );
      }
    },
    completeHostGuard: async () => {
      if (!absenceLease) {
        throw new Error('Database operation lock absence lease was not held at host completion');
      }
      await (hostGuard.complete || hostGuard.release)();
      await absenceLease.release();
      absenceLease = null;
    },
    environment,
    evidence: databaseEvidence || hostEvidence,
    reason: databaseLock?.reason || hostGuard.reason,
  });
}

async function main() {
  if (process.argv.length !== 2) {
    throw usageError('Production restore recovery CLI does not accept arguments');
  }
  const databaseLockModule = await import('./database-operation-lock.js');
  const hostLockModule = await import('./host-operation-lock.js');
  const result = await runRetainedProductionRestoreRecoveryCli({
    databaseLockModule,
    hostLockModule,
  });
  console.log(JSON.stringify(result, null, 2));
}

const currentModule = path.resolve(fileURLToPath(import.meta.url));
if (process.argv[1] && currentModule === path.resolve(process.argv[1])) {
  try {
    await main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = Number.isInteger(error.exitCode) ? error.exitCode : 1;
  }
}
