import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  acquireHostOperationLock,
  openRetainedHostOperationLock,
  releaseHostOperationLock,
  retainHostOperationLock,
} from './host-operation-lock.js';
import {
  runDockerCommand,
  waitForApplicationReadiness,
} from './postgres-restore.js';
import { collectLifecycleRecovery, propagateLifecycleRecovery } from './bounded-child-lifecycle.js';

const CANONICAL_IMAGE_ID = /^sha256:[0-9a-f]{64}$/u;
const CANONICAL_CONTAINER_ID = /^[0-9a-f]{64}$/u;
const PRODUCTION_COMPOSE_PROJECT_NAME = 'easyboost-production';
const DEFAULT_APP_READINESS_URL = 'http://127.0.0.1:3000/health/ready';
const ALLOCATION_FORMAT = '{{.Id}}|{{ index .Config.Labels "com.docker.compose.project" }}|{{ index .Config.Labels "com.docker.compose.service" }}|{{ index .Config.Labels "com.docker.compose.oneoff" }}|{{.Image}}|{{.State.Running}}';

function usageError(message) {
  const error = new Error(message);
  error.exitCode = 2;
  return error;
}

function resolveReadinessUrl({ environment, readinessUrl }) {
  const configured = readinessUrl
    ?? environment?.EASYBOOST_APP_READINESS_URL
    ?? DEFAULT_APP_READINESS_URL;
  if (typeof configured !== 'string' || configured === '' || configured.trim() !== configured) {
    throw usageError('EASYBOOST_APP_READINESS_URL must be one strict http/https URL');
  }
  let parsed;
  try {
    parsed = new URL(configured);
  } catch {
    throw usageError('EASYBOOST_APP_READINESS_URL must be one strict http/https URL');
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname || parsed.hash) {
    throw usageError('EASYBOOST_APP_READINESS_URL must be one strict http/https URL');
  }
  if (parsed.username || parsed.password) {
    throw usageError('EASYBOOST_APP_READINESS_URL must not contain credentials');
  }
  return configured;
}

function lifecycleFailure(primaryError, cleanupError, message) {
  if (!primaryError) return cleanupError;
  if (!cleanupError) return primaryError;
  return propagateLifecycleRecovery(
    new AggregateError([primaryError, cleanupError], message, { cause: primaryError }),
    primaryError,
    cleanupError,
  );
}

async function inspectAllocationState({
  composeDocker,
  containerId,
  docker,
  service,
}) {
  const current = await composeDocker(
    ['ps', '--all', '--quiet', service],
    { capture: true },
  );
  if (current !== containerId) {
    throw new Error(`Production ${service} allocation changed during application lifecycle`);
  }
  const actual = await docker(
    ['inspect', '--format', ALLOCATION_FORMAT, containerId],
    { capture: true },
  );
  const fields = actual.split('|');
  if (fields.length !== 6
      || fields[0] !== containerId
      || fields[1] !== PRODUCTION_COMPOSE_PROJECT_NAME
      || fields[2] !== service
      || fields[3] !== 'False'
      || !CANONICAL_IMAGE_ID.test(fields[4])
      || !['false', 'true'].includes(fields[5])) {
    throw new Error(`Production ${service} identity, ownership, image or running state changed`);
  }
  return { imageId: fields[4], running: fields[5] === 'true' };
}

async function proveAllocationState(options) {
  const actual = await inspectAllocationState(options);
  if (actual.imageId !== options.expectedImageId) {
    throw new Error(
      `Production ${options.service} identity, ownership, image or running state changed`,
    );
  }
  return actual.running;
}

async function proveAllocation(options) {
  const actualRunning = await proveAllocationState(options);
  if (actualRunning !== options.expectedRunning) {
    throw new Error(
      `Production ${options.service} identity, ownership, image or running state changed`,
    );
  }
}

async function stopExactApp({
  appContainerId,
  composeDocker,
  docker,
  productionAppImageId,
  requireStopCommandSuccess = false,
}) {
  let stopError;
  try {
    await docker(['stop', '--time', '10', appContainerId]);
  } catch (error) {
    stopError = error;
  }
  let proofError;
  try {
    await proveAllocation({
      composeDocker,
      containerId: appContainerId,
      docker,
      expectedImageId: productionAppImageId,
      expectedRunning: false,
      service: 'app',
    });
  } catch (error) {
    proofError = error;
  }
  if (proofError) {
    const failure = lifecycleFailure(stopError, proofError,
      'Production application stop and exact stopped-state proof both failed');
    failure.hostOperationSettlementUnproven = true;
    throw failure;
  }
  if (stopError && requireStopCommandSuccess) {
    stopError.hostOperationSettlementUnproven = true;
    throw stopError;
  }
}

async function ensureExactAppStopped({
  appContainerId,
  composeDocker,
  docker,
  forceStop = false,
  productionAppImageId,
}) {
  if (forceStop) {
    await stopExactApp({
      appContainerId,
      composeDocker,
      docker,
      productionAppImageId,
      requireStopCommandSuccess: true,
    });
    return;
  }
  let running;
  try {
    running = await proveAllocationState({
      composeDocker,
      containerId: appContainerId,
      docker,
      expectedImageId: productionAppImageId,
      service: 'app',
    });
  } catch (error) {
    error.hostOperationSettlementUnproven = true;
    throw error;
  }
  if (!running) return;
  await stopExactApp({ appContainerId, composeDocker, docker, productionAppImageId });
}

async function removeExactAppAllocation({ appContainerId, composeDocker, docker }) {
  let removalError;
  try {
    await docker(['rm', appContainerId]);
  } catch (error) {
    removalError = error;
  }
  let proofError;
  try {
    const allocation = await composeDocker(
      ['ps', '--all', '--quiet', 'app'],
      { capture: true },
    );
    if (allocation !== '') {
      throw new Error('Production application allocation remains after exact removal');
    }
  } catch (error) {
    proofError = error;
  }
  if (proofError) {
    const failure = lifecycleFailure(removalError, proofError,
      'Production application removal and empty-allocation proof both failed');
    failure.hostOperationSettlementUnproven = true;
    throw failure;
  }
}

async function recoverAbsentAppAllocation({
  composeDocker,
  docker,
  productionAppImageId,
}) {
  let appContainerId;
  try {
    appContainerId = await composeDocker(
      ['ps', '--all', '--quiet', 'app'],
      { capture: true },
    );
  } catch (error) {
    error.hostOperationSettlementUnproven = true;
    throw error;
  }
  if (appContainerId === '') return;
  if (!CANONICAL_CONTAINER_ID.test(appContainerId)) {
    const error = new Error(
      'Production application recovery found a non-canonical application allocation',
    );
    error.hostOperationSettlementUnproven = true;
    throw error;
  }
  await ensureExactAppStopped({
    appContainerId,
    composeDocker,
    docker,
    productionAppImageId,
  });
  await removeExactAppAllocation({ appContainerId, composeDocker, docker });
}

export async function recoverRetainedProductionAppLifecycle({
  allowUnknownContainerDiscovery = false,
  composeFile = path.resolve('compose.production.yml'),
  environment = process.env,
  hostLockDirectory,
  openRetainedHostLock = openRetainedHostOperationLock,
  runDocker = runDockerCommand,
} = {}) {
  if (typeof allowUnknownContainerDiscovery !== 'boolean') {
    throw usageError('Lifecycle recovery unknown-container discovery must be a boolean');
  }
  const retained = await openRetainedHostLock({
    environment,
    expectedOperation: 'production-app-lifecycle',
    lockDirectory: hostLockDirectory,
  });
  const dockerEnvironment = {
    ...environment,
    EASYBOOST_PREVIOUS_APP_IMAGE_ID: retained.evidence.previousImageId,
    EASYBOOST_PRODUCTION_APP_IMAGE_ID: retained.evidence.newImageId,
  };
  const docker = (arguments_, options = {}) => runDocker(arguments_, {
    environment: dockerEnvironment,
    ...options,
  });
  const composeDocker = (arguments_, options) => docker(
    ['compose', '--project-name', PRODUCTION_COMPOSE_PROJECT_NAME,
      '-f', composeFile, ...arguments_],
    options,
  );

  const appContainerId = await composeDocker(
    ['ps', '--all', '--quiet', 'app'],
    { capture: true },
  );
  if (appContainerId !== '') {
    if (!CANONICAL_CONTAINER_ID.test(appContainerId)) {
      throw new Error('Retained lifecycle recovery found an ambiguous application allocation');
    }
    const recordedContainerAuthority = new Set([
      retained.evidence.currentContainerId,
      retained.evidence.previousContainerId,
    ].filter(Boolean));
    if (!recordedContainerAuthority.has(appContainerId)
        && !(recordedContainerAuthority.size === 0 && allowUnknownContainerDiscovery)) {
      throw new Error(
        'Retained lifecycle recovery found an allocation outside recorded container authority',
      );
    }
    const state = await inspectAllocationState({
      composeDocker,
      containerId: appContainerId,
      docker,
      service: 'app',
    });
    const approvedImages = new Set([
      retained.evidence.previousImageId,
      retained.evidence.newImageId,
    ]);
    if (!approvedImages.has(state.imageId)) {
      throw new Error('Retained lifecycle recovery found an application outside image authority');
    }
    const available = await docker(
      ['image', 'inspect', '--format', '{{.Id}}', state.imageId],
      { capture: true },
    );
    if (available !== state.imageId) {
      throw new Error('Retained lifecycle recovery image authority is unavailable');
    }
    if (state.running) {
      await stopExactApp({
        appContainerId,
        composeDocker,
        docker,
        productionAppImageId: state.imageId,
      });
    }
    await removeExactAppAllocation({ appContainerId, composeDocker, docker });
  }
  await retained.release();
  return {
    action: 'recover',
    ...(appContainerId ? { appContainerId } : {}),
    recoveredLifecycleAction: retained.evidence.lifecycleAction,
    state: 'app-absent',
  };
}

export async function runProductionAppLifecycle({
  action,
  acquireHostLock = acquireHostOperationLock,
  checkReadiness = waitForApplicationReadiness,
  composeFile = path.resolve('compose.production.yml'),
  environment = process.env,
  hostLockDirectory,
  hostLockReleaseTimeoutMs = 2_000,
  postgresExpectedImageId,
  previousAppImageId,
  productionAppImageId,
  readinessUrl: configuredReadinessUrl,
  releaseHostLock = releaseHostOperationLock,
  retainHostLock = retainHostOperationLock,
  runDocker = runDockerCommand,
} = {}) {
  if (!['replace', 'restart', 'start', 'stop'].includes(action)) {
    throw usageError('Production app lifecycle action must be replace, start, restart or stop');
  }
  if (!CANONICAL_IMAGE_ID.test(productionAppImageId || '')) {
    throw usageError('EASYBOOST_PRODUCTION_APP_IMAGE_ID must be a canonical sha256 image ID');
  }
  if (action !== 'stop' && !CANONICAL_IMAGE_ID.test(postgresExpectedImageId || '')) {
    throw usageError('EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID must be a canonical sha256 image ID');
  }
  if (action === 'replace' && !CANONICAL_IMAGE_ID.test(previousAppImageId || '')) {
    throw usageError('EASYBOOST_PREVIOUS_APP_IMAGE_ID must be a canonical sha256 image ID');
  }
  if (action === 'replace' && previousAppImageId === productionAppImageId) {
    throw usageError('Replacement application image IDs must be different');
  }
  if (!Number.isSafeInteger(hostLockReleaseTimeoutMs) || hostLockReleaseTimeoutMs < 1) {
    throw usageError('Host operation lock release timeout must be a positive safe integer');
  }
  const readinessUrl = action === 'stop'
    ? undefined
    : resolveReadinessUrl({ environment, readinessUrl: configuredReadinessUrl });

  const releaseHostOperation = await acquireHostLock({
    environment,
    lockDirectory: hostLockDirectory,
    operation: 'production-app-lifecycle',
  });
  const dockerEnvironment = {
    ...environment,
    ...(action !== 'stop' && postgresExpectedImageId
      ? { EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID: postgresExpectedImageId }
      : {}),
    ...(previousAppImageId ? { EASYBOOST_PREVIOUS_APP_IMAGE_ID: previousAppImageId } : {}),
    EASYBOOST_PRODUCTION_APP_IMAGE_ID: productionAppImageId,
  };
  const docker = (arguments_, options = {}) => runDocker(arguments_, {
    environment: dockerEnvironment,
    ...options,
  });
  const composeDocker = (arguments_, options) => docker(
    ['compose', '--project-name', PRODUCTION_COMPOSE_PROJECT_NAME,
      '-f', composeFile, ...arguments_],
    options,
  );
  let operationError;
  let retainGuard = false;
  let result;
  let appContainerId;
  let previousAppContainerId;
  let appCreatedByCompose = false;
  let appStartCommandRejected = false;
  let appStartMutationPending = false;
  let priorAppAllocationAbsent = false;
  let lastProof = 'host-guard-acquired';
  let lastState = 'preflight-pending';
  try {
    const approvedImageIds = [productionAppImageId];
    if (action !== 'stop') approvedImageIds.push(postgresExpectedImageId);
    if (action === 'replace') approvedImageIds.push(previousAppImageId);
    for (const imageId of approvedImageIds) {
      const available = await docker(
        ['image', 'inspect', '--format', '{{.Id}}', imageId],
        { capture: true },
      );
      if (available !== imageId) {
        throw new Error('Production lifecycle approved image authority is unavailable');
      }
    }
    if (action !== 'stop') {
      const postgresContainerId = await composeDocker(
        ['ps', '--all', '--quiet', 'postgres'],
        { capture: true },
      );
      if (!CANONICAL_CONTAINER_ID.test(postgresContainerId)) {
        throw new Error('Production lifecycle requires one canonical PostgreSQL container ID');
      }
      await proveAllocation({
        composeDocker,
        containerId: postgresContainerId,
        docker,
        expectedImageId: postgresExpectedImageId,
        expectedRunning: true,
        service: 'postgres',
      });
    }
    appContainerId = await composeDocker(
      ['ps', '--all', '--quiet', 'app'],
      { capture: true },
    );
    lastProof = 'compose-app-inventory-proved';
    lastState = appContainerId ? 'app-allocation-observed' : 'app-absent';
    if (action === 'replace') {
      if (!CANONICAL_CONTAINER_ID.test(appContainerId || '')) {
        throw new Error('Production replacement requires one canonical application container ID');
      }
      previousAppContainerId = appContainerId;
      await proveAllocation({
        composeDocker,
        containerId: previousAppContainerId,
        docker,
        expectedImageId: previousAppImageId,
        expectedRunning: true,
        service: 'app',
      });
      lastProof = 'exact-previous-app-running-proved';
      lastState = 'app-running';
      await stopExactApp({
        appContainerId: previousAppContainerId,
        composeDocker,
        docker,
        productionAppImageId: previousAppImageId,
      });
      lastProof = 'exact-previous-app-stopped-proved';
      lastState = 'app-stopped';
      await removeExactAppAllocation({
        appContainerId: previousAppContainerId,
        composeDocker,
        docker,
      });
      lastProof = 'exact-app-absence-proved';
      lastState = 'app-absent';
      priorAppAllocationAbsent = true;
      appContainerId = undefined;
      appStartMutationPending = true;
      lastProof = 'compose-up-dispatched';
      lastState = 'mutation-pending';
      try {
        await composeDocker(['up', '--pull', 'never', '--no-build', '--no-deps', '-d', 'app']);
      } catch (error) {
        appStartCommandRejected = true;
        error.hostOperationSettlementUnproven = true;
        throw error;
      }
      appContainerId = await composeDocker(
        ['ps', '--all', '--quiet', 'app'],
        { capture: true },
      );
      if (appContainerId === previousAppContainerId) {
        throw new Error('Production replacement did not create a new application allocation');
      }
      appCreatedByCompose = true;
    }
    if (!appContainerId && action === 'stop') {
      result = { action };
    } else {
      if (!appContainerId && action === 'start') {
        priorAppAllocationAbsent = true;
        appStartMutationPending = true;
        lastProof = 'compose-up-dispatched';
        lastState = 'mutation-pending';
        try {
          await composeDocker(['up', '--pull', 'never', '--no-build', '--no-deps', '-d', 'app']);
        } catch (error) {
          appStartCommandRejected = true;
          error.hostOperationSettlementUnproven = true;
          throw error;
        }
        appContainerId = await composeDocker(
          ['ps', '--all', '--quiet', 'app'],
          { capture: true },
        );
        appCreatedByCompose = true;
      }
      if (!CANONICAL_CONTAINER_ID.test(appContainerId || '')) {
        throw new Error('Production lifecycle requires one canonical application container ID');
      }

      let appRunning;
      if (appCreatedByCompose) {
        appRunning = await proveAllocationState({
          composeDocker,
          containerId: appContainerId,
          docker,
          expectedImageId: productionAppImageId,
          service: 'app',
        });
        if (!appRunning) {
          throw new Error('New production application allocation did not start');
        }
        lastProof = 'exact-app-running-proved';
        lastState = 'app-running';
      } else if (action === 'stop') {
        appRunning = await proveAllocationState({
          composeDocker,
          containerId: appContainerId,
          docker,
          expectedImageId: productionAppImageId,
          service: 'app',
        });
        lastProof = appRunning ? 'exact-app-running-proved' : 'exact-app-stopped-proved';
        lastState = appRunning ? 'app-running' : 'app-stopped';
      } else {
        const expectedRunning = action === 'restart';
        await proveAllocation({
          composeDocker,
          containerId: appContainerId,
          docker,
          expectedImageId: productionAppImageId,
          expectedRunning,
          service: 'app',
        });
        appRunning = expectedRunning;
        lastProof = expectedRunning ? 'exact-app-running-proved' : 'exact-app-stopped-proved';
        lastState = expectedRunning ? 'app-running' : 'app-stopped';
      }

      if (action === 'restart' || (action === 'stop' && appRunning)) {
        await stopExactApp({ appContainerId, composeDocker, docker, productionAppImageId });
        lastProof = 'exact-app-stopped-proved';
        lastState = 'app-stopped';
      }
      if (action === 'stop') {
        await removeExactAppAllocation({ appContainerId, composeDocker, docker });
        lastProof = 'exact-app-absence-proved';
        lastState = 'app-absent';
      }
      if (action === 'replace' || action === 'start' || action === 'restart') {
        if (!appCreatedByCompose) {
          appStartMutationPending = true;
          lastProof = 'exact-start-dispatched';
          lastState = 'mutation-pending';
          try {
            await docker(['start', appContainerId]);
          } catch (error) {
            appStartCommandRejected = true;
            throw error;
          }
        }
        await proveAllocation({
          composeDocker,
          containerId: appContainerId,
          docker,
          expectedImageId: productionAppImageId,
          expectedRunning: true,
          service: 'app',
        });
        lastProof = 'exact-app-running-proved';
        lastState = 'app-running-readiness-pending';
        await checkReadiness({ url: readinessUrl });
        lastProof = 'application-readiness-proved';
        lastState = 'app-running';
        appStartMutationPending = false;
      }
      result = {
        action,
        appContainerId,
        ...(previousAppContainerId ? { previousAppContainerId } : {}),
      };
    }
  } catch (error) {
    operationError = propagateLifecycleRecovery(error);
    retainGuard = Boolean(operationError.hostOperationSettlementUnproven);
    const childSettlementUnproven = collectLifecycleRecovery(operationError)
      .childSettlementUnproven;
    if (appStartMutationPending && !childSettlementUnproven) {
      let isolationError;
      try {
        if (priorAppAllocationAbsent) {
          await recoverAbsentAppAllocation({
            composeDocker,
            docker,
            productionAppImageId,
          });
          lastProof = 'immediate-app-absence-proved';
          lastState = retainGuard ? 'mutation-settlement-unproven' : 'app-absent';
        } else if (appContainerId) {
          await ensureExactAppStopped({
            appContainerId,
            composeDocker,
            docker,
            forceStop: appStartCommandRejected,
            productionAppImageId,
          });
          lastProof = 'exact-app-stopped-proved';
          lastState = retainGuard ? 'mutation-settlement-unproven' : 'app-stopped';
        } else {
          isolationError = new Error(
            'Production application start settlement has no exact allocation authority',
          );
          isolationError.hostOperationSettlementUnproven = true;
          retainGuard = true;
        }
      } catch (failure) {
        isolationError = failure;
        retainGuard ||= Boolean(failure.hostOperationSettlementUnproven);
        lastProof = 'app-isolation-proof-rejected';
        lastState = 'mutation-settlement-unproven';
      }
      operationError = lifecycleFailure(
        operationError,
        isolationError,
        'Production lifecycle failed and exact application isolation was not recovered',
      );
    }
  }

  const hostRecoveryEvidence = (reason) => ({
    currentContainerId: CANONICAL_CONTAINER_ID.test(appContainerId || '')
      ? appContainerId
      : null,
    lastProof,
    lastState,
    lifecycleAction: action,
    newImageId: productionAppImageId,
    previousContainerId: CANONICAL_CONTAINER_ID.test(
      previousAppContainerId || appContainerId || '',
    ) ? (previousAppContainerId || appContainerId) : null,
    previousImageId: previousAppImageId || productionAppImageId,
    reason,
  });
  let guardError;
  try {
    if (operationError?.childSettlementUnproven === true) {
      // Exact child recovery is the only authority until its durable controller
      // proves settlement; the enclosing host guard must not transition around it.
    } else if (retainGuard) {
      await retainHostLock(
        releaseHostOperation,
        hostLockReleaseTimeoutMs,
        hostRecoveryEvidence('APP_MUTATION_SETTLEMENT_UNPROVEN'),
      );
    } else {
      try {
        await releaseHostLock(releaseHostOperation, hostLockReleaseTimeoutMs);
      } catch (releaseError) {
        let retentionError;
        try {
          await retainHostLock(
            releaseHostOperation,
            hostLockReleaseTimeoutMs,
            hostRecoveryEvidence('HOST_GUARD_FINALIZATION_UNPROVEN'),
          );
        } catch (error) {
          retentionError = error;
        }
        throw lifecycleFailure(
          releaseError,
          retentionError,
          'Production lifecycle succeeded but host guard finalization was not recoverable',
        );
      }
    }
  } catch (error) {
    guardError = error;
  }
  if (operationError) {
    throw lifecycleFailure(operationError, guardError,
      'Production application lifecycle and host guard finalization both failed');
  }
  if (guardError) throw guardError;
  return result;
}

async function main() {
  const [action, ...extra] = process.argv.slice(2);
  if (extra.length || !['recover', 'replace', 'restart', 'start', 'stop'].includes(action)) {
    throw usageError(
      'Usage: node scripts/production-app-lifecycle.js <recover|replace|start|restart|stop>',
    );
  }
  if (action === 'recover') {
    await recoverRetainedProductionAppLifecycle();
    return;
  }
  await runProductionAppLifecycle({
    action,
    postgresExpectedImageId: process.env.EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID,
    previousAppImageId: process.env.EASYBOOST_PREVIOUS_APP_IMAGE_ID,
    productionAppImageId: process.env.EASYBOOST_PRODUCTION_APP_IMAGE_ID,
  });
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = error.exitCode || 1;
  });
}
