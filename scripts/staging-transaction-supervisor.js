import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  STAGING_DEADLINE_CONTROL_ENVIRONMENT,
  awaitStagingDeadlineReady,
  cleanupStagingDeadlinePublicationResidue,
  cleanupStagingDeadlineRetirementTombstone,
  completeStagingDeadlineRecovery,
  createStagingDeadlineController,
  createStagingDeadlineMailbox,
  recoverStagingDeadlineMailbox,
  requestStagingDeadlineTransition,
  resumeStagingDeadlineRecoveryHandoff,
} from './staging-deadline-control.js';
import {
  completePosixSessionRecovery,
  cleanupPosixSessionPublicationResidue,
  cleanupPosixSessionRetirementTombstone,
  createPosixSessionControl,
  createPosixSessionInvocation,
  observePosixSessionWriterEgress,
  recoverPosixSessionControl,
  resumePosixSessionRecoveryHandoff,
} from './posix-session-supervisor.js';
import {
  STAGING_QUIESCENT_MAINTENANCE_ENVIRONMENT,
  bindStagingQuiescentMaintenanceRoot,
  consumeStagingQuiescentMaintenanceLock,
} from './staging-quiescent-maintenance.js';

const DEFAULT_POLL_MILLISECONDS = 20;
const DEFAULT_STARTUP_MILLISECONDS = 5_000;
const DEFAULT_TERM_GRACE_MILLISECONDS = 5_000;
const DEFAULT_SETTLEMENT_MILLISECONDS = 7_000;
// Three bounded fd3 writer frames plus one deadline authority can legitimately
// exceed the old 16 KiB envelope when the private control root is deeply nested.
// Keep every constituent string bounded and use one shared aggregate limit for
// both publication and parsing so a report we emit is always replayable.
const MAX_RECOVERY_AUTHORITY_BYTES = 65_536;
const MAX_RECOVERY_PATH_BYTES = 4_096;
const MAX_RECOVERY_KEY_BYTES = 4_096;
const MAX_RECOVERY_SCOPE_BYTES = 8_192;
const MAX_SESSION_PUBLICATION_AUTHORITIES = 3;
const STAGING_TRANSACTION_RECOVERY_PROTOCOL = 'easyboost-staging-transaction-recovery-v1';
const TOKEN_PATTERN = /^[a-f0-9]{64}$/u;
const POSIX_PUBLICATION_SOURCE_BINDING_KEYS = Object.freeze([
  'birthtimeNs', 'bytes', 'ctimeNs', 'dev', 'gid', 'ino', 'mode', 'sha256', 'uid',
]);
const UNSIGNED_DECIMAL = /^(?:0|[1-9]\d*)$/u;

function installedHelperRootForMaintenance() {
  const generation = path.dirname(fileURLToPath(import.meta.url));
  const generations = path.dirname(generation);
  if (!TOKEN_PATTERN.test(path.basename(generation))
      || path.basename(generations) !== 'generations') {
    throw new Error('staging maintenance authority requires an installed helper generation');
  }
  return path.dirname(generations);
}

function prepareQuiescentMaintenance(environment, roots) {
  const sanitizedEnvironment = { ...environment };
  if (sanitizedEnvironment[STAGING_QUIESCENT_MAINTENANCE_ENVIRONMENT] === undefined) {
    return Object.freeze({ bindings: new Map(), environment: sanitizedEnvironment });
  }
  const lockProof = consumeStagingQuiescentMaintenanceLock({
    environment: sanitizedEnvironment,
    expectedInstallRoot: installedHelperRootForMaintenance(),
  });
  const bindings = new Map();
  for (const root of roots) {
    fs.mkdirSync(root, { mode: 0o700, recursive: true });
    bindings.set(root, bindStagingQuiescentMaintenanceRoot(lockProof, root));
  }
  return Object.freeze({ bindings, environment: sanitizedEnvironment });
}

function quiescentOptions(binding) {
  return binding === undefined ? {} : {
    quiescentMaintenanceAuthority: binding.authority,
    reclaimRetainedEvidence: binding.reclaimRetainedEvidence,
    rotateRecoveryBatonEpoch: binding.rotateRecoveryBatonEpoch,
  };
}

function positiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${label} is invalid`);
  return parsed;
}

function statusFromTarget(status) {
  if (Number.isInteger(status?.exitCode)) return status.exitCode;
  if (status?.signal === 'SIGTERM') return 143;
  if (status?.signal === 'SIGKILL') return 137;
  return 125;
}

function transactionControlKey(script, args) {
  if (typeof script !== 'string' || !path.isAbsolute(script) || !Array.isArray(args)) {
    throw new Error('staging transaction command is invalid');
  }
  const key = `${path.resolve(script)}:${JSON.stringify(args)}`;
  if (Buffer.byteLength(key, 'utf8') > MAX_RECOVERY_KEY_BYTES) {
    throw new Error('staging transaction command authority is too large');
  }
  return key;
}

function pathIsAbsent(entry) {
  try {
    fs.lstatSync(entry);
    return false;
  } catch (error) {
    if (error?.code === 'ENOENT') return true;
    throw error;
  }
}

function boundedString(value, maximumBytes) {
  return typeof value === 'string' && value.length > 0
    && Buffer.byteLength(value, 'utf8') <= maximumBytes;
}

function boundedRecoveryAuthority(authority) {
  const serialized = JSON.stringify(authority);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_RECOVERY_AUTHORITY_BYTES) {
    throw new Error('staging transaction recovery authority payload is too large');
  }
  return authority;
}

function exactPosixPublicationSourceBinding(binding) {
  if (!binding || typeof binding !== 'object' || Array.isArray(binding)
      || JSON.stringify(Object.keys(binding).sort())
        !== JSON.stringify(POSIX_PUBLICATION_SOURCE_BINDING_KEYS)
      || !Number.isSafeInteger(binding.bytes) || binding.bytes < 0 || binding.bytes > 65_536
      || !/^[a-f0-9]{64}$/u.test(binding.sha256 ?? '')
      || POSIX_PUBLICATION_SOURCE_BINDING_KEYS
        .filter((key) => key !== 'bytes' && key !== 'sha256')
        .some((key) => !UNSIGNED_DECIMAL.test(binding[key] ?? ''))) {
    return null;
  }
  return Object.freeze({
    birthtimeNs: binding.birthtimeNs,
    bytes: binding.bytes,
    ctimeNs: binding.ctimeNs,
    dev: binding.dev,
    gid: binding.gid,
    ino: binding.ino,
    mode: binding.mode,
    sha256: binding.sha256,
    uid: binding.uid,
  });
}

function exactPublicationAuthority(authority, { sourceBindingRequired = false } = {}) {
  const sourceBinding = sourceBindingRequired
    ? exactPosixPublicationSourceBinding(authority?.sourceBinding) : undefined;
  if (!boundedString(authority?.destination, MAX_RECOVERY_PATH_BYTES)
      || !boundedString(authority?.temporary, MAX_RECOVERY_PATH_BYTES)
      || (authority?.tombstone !== undefined
        && !boundedString(authority.tombstone, MAX_RECOVERY_PATH_BYTES))
      || (sourceBindingRequired && sourceBinding === null)) {
    return null;
  }
  return Object.freeze({
    destination: authority.destination,
    ...(sourceBindingRequired ? { sourceBinding } : {}),
    temporary: authority.temporary,
    ...(typeof authority.tombstone === 'string' && authority.tombstone.length > 0
      ? { tombstone: authority.tombstone } : {}),
  });
}

function mergeSessionPublicationAuthorities(...groups) {
  const exact = new Map();
  for (const group of groups) {
    const values = Array.isArray(group) ? group : group === undefined || group === null ? [] : [group];
    for (const value of values) {
      const authority = exactPublicationAuthority(value, { sourceBindingRequired: true });
      if (authority === null) {
        throw new Error('POSIX session publication authority is invalid');
      }
      exact.set(`${authority.destination}\0${authority.temporary}`, authority);
    }
  }
  if (exact.size > MAX_SESSION_PUBLICATION_AUTHORITIES) {
    throw new Error('staging transaction has too many exact session publication authorities');
  }
  return Object.freeze([...exact.values()]);
}

function sessionPublicationAuthorityFields(authorities) {
  if (authorities.length === 0) return {};
  if (authorities.length === 1) {
    return { posixSessionPublicationAuthority: authorities[0] };
  }
  return { posixSessionPublicationAuthorities: authorities };
}

function exactRetirementAuthority(authority, { posixSession = false } = {}) {
  const expectedKeys = posixSession
    ? ['controlDirectory', 'reservationOwner', 'sourceDev', 'sourceIno', 'tombstone']
    : ['controlDirectory', 'tombstone'];
  if (!authority || JSON.stringify(Object.keys(authority).sort())
      !== JSON.stringify(expectedKeys)
      || !boundedString(authority.controlDirectory, MAX_RECOVERY_PATH_BYTES)
      || !path.isAbsolute(authority.controlDirectory)
      || !boundedString(authority.tombstone, MAX_RECOVERY_PATH_BYTES)
      || !path.isAbsolute(authority.tombstone)
      || path.dirname(authority.tombstone) !== path.dirname(authority.controlDirectory)
      || (posixSession && (!TOKEN_PATTERN.test(authority.reservationOwner ?? '')
        || !UNSIGNED_DECIMAL.test(authority.sourceDev ?? '')
        || !UNSIGNED_DECIMAL.test(authority.sourceIno ?? '')
        || !/^\.easyboost-staging-quarantine-slot\.[a-f0-9]{64}\.tombstone$/u
          .test(path.basename(authority.tombstone))))) {
    return null;
  }
  return Object.freeze({
    controlDirectory: authority.controlDirectory,
    ...(posixSession ? {
      reservationOwner: authority.reservationOwner,
      sourceDev: authority.sourceDev,
      sourceIno: authority.sourceIno,
    } : {}),
    tombstone: authority.tombstone,
  });
}

function exactRecoveryHandoff(handoff, {
  controlDirectory,
  expectedControlKey,
  expectedProtocol,
  expectedRecoveryScope,
  label,
} = {}) {
  const keys = ['claimPath', 'controlDirectory', 'controlKey', 'controlRoot',
    'protocol', 'recoveryScope', 'retirementOwner'];
  if (!handoff || typeof handoff !== 'object' || Array.isArray(handoff)
      || JSON.stringify(Object.keys(handoff).sort()) !== JSON.stringify(keys)
      || handoff.protocol !== expectedProtocol
      || !boundedString(handoff.controlKey, MAX_RECOVERY_KEY_BYTES)
      || (expectedControlKey !== undefined && handoff.controlKey !== expectedControlKey)
      || !boundedString(handoff.controlRoot, MAX_RECOVERY_PATH_BYTES)
      || !path.isAbsolute(handoff.controlRoot)
      || path.resolve(handoff.controlRoot) !== handoff.controlRoot
      || !boundedString(handoff.controlDirectory, MAX_RECOVERY_PATH_BYTES)
      || !path.isAbsolute(handoff.controlDirectory)
      || path.resolve(handoff.controlDirectory) !== handoff.controlDirectory
      || !boundedString(handoff.claimPath, MAX_RECOVERY_PATH_BYTES)
      || !path.isAbsolute(handoff.claimPath)
      || path.resolve(handoff.claimPath) !== handoff.claimPath
      || !boundedString(handoff.recoveryScope, MAX_RECOVERY_SCOPE_BYTES)
      || !TOKEN_PATTERN.test(handoff.retirementOwner ?? '')) {
    throw new Error(`${label} recovery handoff is invalid`);
  }
  const root = path.resolve(handoff.controlRoot);
  const directory = path.resolve(handoff.controlDirectory);
  const claim = path.resolve(handoff.claimPath);
  const claimName = path.basename(claim);
  if (directory !== path.join(
    root, createHash('sha256').update(handoff.controlKey, 'utf8').digest('hex'),
  ) || (controlDirectory !== undefined && directory !== controlDirectory)
      || path.dirname(claim) !== directory
      || (claimName !== 'retirement.claim'
        && !/^\.recovery-baton\.[a-f0-9]{64}\.claim$/u.test(claimName))
      || (expectedRecoveryScope !== undefined
        && handoff.recoveryScope !== expectedRecoveryScope)) {
    throw new Error(`${label} recovery handoff scope is invalid`);
  }
  return Object.freeze({
    claimPath: claim,
    controlDirectory: directory,
    controlKey: handoff.controlKey,
    controlRoot: root,
    protocol: handoff.protocol,
    recoveryScope: handoff.recoveryScope,
    retirementOwner: handoff.retirementOwner,
  });
}

function exactTransactionRecoveryAuthority(authority) {
  if (!authority || typeof authority !== 'object' || Array.isArray(authority)) {
    throw new Error('staging transaction recovery authority is invalid');
  }
  const required = [
    'deadlineControlDirectory', 'posixSessionControlDirectory', 'protocol',
  ];
  const optional = [
    'deadlinePublicationAuthority', 'deadlineRecoveryHandoff', 'deadlineRetirementAuthority',
    'posixSessionPublicationAuthorities', 'posixSessionPublicationAuthority',
    'posixSessionRecoveryHandoff',
    'posixSessionRetirementAuthority',
  ];
  const keys = Object.keys(authority).sort();
  if (required.some((key) => !keys.includes(key))
      || keys.some((key) => !required.includes(key) && !optional.includes(key))
      || authority.protocol !== STAGING_TRANSACTION_RECOVERY_PROTOCOL) {
    throw new Error('staging transaction recovery authority contract is invalid');
  }
  const exactDirectory = (value, label) => {
    if (value === null) return null;
    if (!boundedString(value, MAX_RECOVERY_PATH_BYTES)
        || !path.isAbsolute(value) || path.resolve(value) !== value) {
      throw new Error(`${label} is invalid`);
    }
    return path.resolve(value);
  };
  const deadlineControlDirectory = exactDirectory(
    authority.deadlineControlDirectory, 'staging deadline recovery directory',
  );
  const posixSessionControlDirectory = exactDirectory(
    authority.posixSessionControlDirectory, 'POSIX session recovery directory',
  );
  const exactPair = (value, controlDirectory, label, sourceBindingRequired = false) => {
    if (value === undefined) return undefined;
    const pairKeys = JSON.stringify(Object.keys(value ?? {}).sort());
    const expectedKeys = sourceBindingRequired
      ? [
        JSON.stringify(['destination', 'sourceBinding', 'temporary']),
        JSON.stringify(['destination', 'sourceBinding', 'temporary', 'tombstone']),
      ]
      : [
        JSON.stringify(['destination', 'temporary']),
        JSON.stringify(['destination', 'temporary', 'tombstone']),
      ];
    if (!expectedKeys.includes(pairKeys)) {
      throw new Error(`${label} publication authority is invalid`);
    }
    const pair = exactPublicationAuthority(value, { sourceBindingRequired });
    if (pair === null || !path.isAbsolute(pair.destination) || !path.isAbsolute(pair.temporary)
        || (pair.tombstone !== undefined && !path.isAbsolute(pair.tombstone))
        || path.resolve(pair.destination) !== pair.destination
        || path.resolve(pair.temporary) !== pair.temporary
        || (pair.tombstone !== undefined && path.resolve(pair.tombstone) !== pair.tombstone)
        || controlDirectory === null
        || path.resolve(path.dirname(pair.destination)) !== controlDirectory) {
      throw new Error(`${label} publication authority does not match its control directory`);
    }
    return pair;
  };
  const deadlinePublicationAuthority = exactPair(
    authority.deadlinePublicationAuthority, deadlineControlDirectory, 'staging deadline',
  );
  const posixSessionPublicationAuthority = exactPair(
    authority.posixSessionPublicationAuthority, posixSessionControlDirectory, 'POSIX session', true,
  );
  if (authority.posixSessionPublicationAuthority !== undefined
      && authority.posixSessionPublicationAuthorities !== undefined) {
    throw new Error('POSIX session publication authority inputs are ambiguous');
  }
  let posixSessionPublicationAuthorities;
  if (authority.posixSessionPublicationAuthorities !== undefined) {
    if (!Array.isArray(authority.posixSessionPublicationAuthorities)
        || authority.posixSessionPublicationAuthorities.length < 2
        || authority.posixSessionPublicationAuthorities.length
          > MAX_SESSION_PUBLICATION_AUTHORITIES) {
      throw new Error('POSIX session publication authorities are invalid');
    }
    posixSessionPublicationAuthorities = Object.freeze(
      authority.posixSessionPublicationAuthorities.map((value) => exactPair(
        value, posixSessionControlDirectory, 'POSIX session', true,
      )),
    );
    if (mergeSessionPublicationAuthorities(posixSessionPublicationAuthorities).length
        !== posixSessionPublicationAuthorities.length) {
      throw new Error('POSIX session publication authorities are not unique');
    }
  }
  const exactRetirement = (value, controlDirectory, label) => {
    if (value === undefined) return undefined;
    const posixSession = label === 'POSIX session';
    const exact = exactRetirementAuthority(value, { posixSession });
    if (exact === null || controlDirectory === null
        || path.resolve(exact.controlDirectory) !== exact.controlDirectory
        || path.resolve(exact.tombstone) !== exact.tombstone
        || path.resolve(exact.controlDirectory) !== controlDirectory) {
      throw new Error(`${label} retirement authority does not match its control directory`);
    }
    return Object.freeze({
      controlDirectory: path.resolve(exact.controlDirectory),
      ...(posixSession ? {
        reservationOwner: exact.reservationOwner,
        sourceDev: exact.sourceDev,
        sourceIno: exact.sourceIno,
      } : {}),
      tombstone: path.resolve(exact.tombstone),
    });
  };
  const deadlineRetirementAuthority = exactRetirement(
    authority.deadlineRetirementAuthority, deadlineControlDirectory, 'staging deadline',
  );
  const posixSessionRetirementAuthority = exactRetirement(
    authority.posixSessionRetirementAuthority, posixSessionControlDirectory, 'POSIX session',
  );
  const posixSessionRecoveryHandoff = authority.posixSessionRecoveryHandoff === undefined
    ? undefined : exactRecoveryHandoff(authority.posixSessionRecoveryHandoff, {
      controlDirectory: posixSessionControlDirectory,
      expectedProtocol: 'easyboost-posix-session-recovery-handoff-v1',
      label: 'POSIX session',
    });
  const deadlineRecoveryHandoff = authority.deadlineRecoveryHandoff === undefined
    ? undefined : exactRecoveryHandoff(authority.deadlineRecoveryHandoff, {
      controlDirectory: deadlineControlDirectory,
      expectedProtocol: 'easyboost-staging-deadline-recovery-handoff-v1',
      label: 'staging deadline',
    });
  if (deadlinePublicationAuthority !== undefined
      && (deadlineRecoveryHandoff !== undefined
        || deadlineRetirementAuthority !== undefined)) {
    throw new Error('staging deadline current recovery authority roles are mutually exclusive');
  }
  if ([posixSessionPublicationAuthority, posixSessionPublicationAuthorities,
    posixSessionRecoveryHandoff, posixSessionRetirementAuthority]
    .filter((value) => value !== undefined).length > 1) {
    throw new Error('POSIX session recovery authority roles are mutually exclusive');
  }
  return boundedRecoveryAuthority(Object.freeze({
    deadlineControlDirectory,
    ...(deadlinePublicationAuthority === undefined ? {} : { deadlinePublicationAuthority }),
    ...(deadlineRecoveryHandoff === undefined ? {} : { deadlineRecoveryHandoff }),
    ...(deadlineRetirementAuthority === undefined ? {} : { deadlineRetirementAuthority }),
    posixSessionControlDirectory,
    ...(posixSessionPublicationAuthority === undefined
      ? {} : { posixSessionPublicationAuthority }),
    ...(posixSessionPublicationAuthorities === undefined
      ? {} : { posixSessionPublicationAuthorities }),
    ...(posixSessionRecoveryHandoff === undefined ? {} : { posixSessionRecoveryHandoff }),
    ...(posixSessionRetirementAuthority === undefined
      ? {} : { posixSessionRetirementAuthority }),
    protocol: STAGING_TRANSACTION_RECOVERY_PROTOCOL,
  }));
}

export function parseStagingTransactionRecoveryAuthority(serialized) {
  if (typeof serialized !== 'string' || Buffer.byteLength(serialized, 'utf8') < 1
      || Buffer.byteLength(serialized, 'utf8') > MAX_RECOVERY_AUTHORITY_BYTES) {
    throw new Error('staging transaction recovery authority payload is invalid');
  }
  let parsed;
  try { parsed = JSON.parse(serialized); } catch (cause) {
    throw new Error('staging transaction recovery authority payload is not JSON', { cause });
  }
  return exactTransactionRecoveryAuthority(parsed);
}

function transactionRecoveryFailure(cause, {
  deadlineDirectory,
  deadlinePublicationAuthority,
  deadlineRecoveryHandoff,
  deadlineRetirementAuthority,
  publicationRole,
  sessionDirectory,
  sessionPublicationAuthorities,
  sessionPublicationAuthority,
  sessionRecoveryHandoff,
  sessionRetirementAuthority,
} = {}) {
  const publication = exactPublicationAuthority(cause?.recoveryAuthority, {
    sourceBindingRequired: publicationRole === 'session',
  });
  const retirement = exactRetirementAuthority(cause?.recoveryAuthority, {
    posixSession: publicationRole === 'session',
  });
  const rawHandoff = cause?.recoveryHandoff ?? cause?.recoveryAuthority?.recoveryHandoff;
  const currentHandoff = (role) => {
    if (publicationRole !== role || publication !== null || retirement !== null
        || rawHandoff === undefined) {
      return undefined;
    }
    try {
      return exactRecoveryHandoff(rawHandoff, {
        controlDirectory: role === 'deadline' ? deadlineDirectory : sessionDirectory,
        expectedProtocol: role === 'deadline'
          ? 'easyboost-staging-deadline-recovery-handoff-v1'
          : 'easyboost-posix-session-recovery-handoff-v1',
        label: role === 'deadline' ? 'staging deadline' : 'POSIX session',
      });
    } catch { return undefined; }
  };
  const currentDeadlineHandoff = currentHandoff('deadline');
  const currentSessionHandoff = currentHandoff('session');
  const includeDeadline = deadlineDirectory !== null && deadlineDirectory !== undefined;
  const includeSession = sessionDirectory !== null && sessionDirectory !== undefined;
  const deadlineRoleChanged = publicationRole === 'deadline'
    && (publication !== null || retirement !== null || currentDeadlineHandoff !== undefined);
  const deadlineRetirementChanged = publicationRole === 'deadline' && retirement !== null;
  const sessionRoleChanged = publicationRole === 'session'
    && (publication !== null || retirement !== null || currentSessionHandoff !== undefined);
  const retainedSessionPublications = includeSession
    && (!sessionRoleChanged || publication !== null)
    ? mergeSessionPublicationAuthorities(
      sessionPublicationAuthorities,
      sessionPublicationAuthority,
      publicationRole === 'session' ? publication : undefined,
    ) : Object.freeze([]);
  const authority = boundedRecoveryAuthority(Object.freeze({
    deadlineControlDirectory: includeDeadline ? deadlineDirectory : null,
    ...(includeDeadline && publicationRole === 'deadline' && publication !== null
      ? { deadlinePublicationAuthority: publication }
      : includeDeadline && !deadlineRoleChanged && deadlinePublicationAuthority
        ? { deadlinePublicationAuthority } : {}),
    ...(includeDeadline && currentDeadlineHandoff
      ? { deadlineRecoveryHandoff: currentDeadlineHandoff }
      : includeDeadline && !deadlineRoleChanged && deadlineRecoveryHandoff
        ? { deadlineRecoveryHandoff } : {}),
    ...(includeDeadline && publicationRole === 'deadline' && retirement !== null
      ? { deadlineRetirementAuthority: retirement }
      : includeDeadline && !deadlineRetirementChanged && deadlineRetirementAuthority
        ? { deadlineRetirementAuthority } : {}),
    posixSessionControlDirectory: includeSession ? sessionDirectory : null,
    ...sessionPublicationAuthorityFields(retainedSessionPublications),
    ...(includeSession && currentSessionHandoff
      ? { posixSessionRecoveryHandoff: currentSessionHandoff }
      : includeSession && !sessionRoleChanged && sessionRecoveryHandoff
        ? { posixSessionRecoveryHandoff: sessionRecoveryHandoff } : {}),
    ...(includeSession && publicationRole === 'session' && retirement !== null
      ? { posixSessionRetirementAuthority: retirement }
      : includeSession && !sessionRoleChanged && sessionRetirementAuthority
        ? { posixSessionRetirementAuthority: sessionRetirementAuthority }
        : {}),
    protocol: STAGING_TRANSACTION_RECOVERY_PROTOCOL,
  }));
  const error = new Error('staging transaction recovery remains incomplete', { cause });
  error.exitCode = 125;
  error.recoveryAuthority = authority;
  return error;
}

// This root-owned ingress is the only recovery path for deterministic retained
// staging authority. It proves the session empty before it retires a final DISARM,
// then re-proves and retires the exact session namespace; it never sends signals.
export function recoverStagingTransaction({
  script,
  args = [],
  environment = process.env,
  platform = process.platform,
  deadlineControlRoot,
  deadlinePublicationAuthority,
  deadlineRecoveryHandoff,
  deadlineRetirementAuthority,
  recoveryAuthority,
  sessionControlRoot,
  posixSessionPublicationAuthorities,
  posixSessionPublicationAuthority,
  posixSessionRecoveryHandoff,
  posixSessionRetirementAuthority,
  cleanupDeadlinePublication = cleanupStagingDeadlinePublicationResidue,
  cleanupDeadlineRetirement = cleanupStagingDeadlineRetirementTombstone,
  cleanupSessionPublication = cleanupPosixSessionPublicationResidue,
  cleanupSessionRetirement = cleanupPosixSessionRetirementTombstone,
  completeDeadlineRecovery = completeStagingDeadlineRecovery,
  recoverDeadline = recoverStagingDeadlineMailbox,
  recoverSession = recoverPosixSessionControl,
  completeSessionRecovery = completePosixSessionRecovery,
  resumeDeadlineRecovery = resumeStagingDeadlineRecoveryHandoff,
  resumeSessionRecovery = resumePosixSessionRecoveryHandoff,
  prepareMaintenance = prepareQuiescentMaintenance,
} = {}) {
  if (platform !== 'linux') {
    const error = new Error('staging transaction recovery requires Linux /proc proof');
    error.exitCode = 125;
    throw error;
  }
  if (typeof recoverDeadline !== 'function' || typeof recoverSession !== 'function'
      || typeof completeDeadlineRecovery !== 'function'
      || typeof completeSessionRecovery !== 'function'
      || typeof resumeDeadlineRecovery !== 'function'
      || typeof resumeSessionRecovery !== 'function'
      || typeof cleanupDeadlinePublication !== 'function'
      || typeof cleanupDeadlineRetirement !== 'function'
      || typeof cleanupSessionPublication !== 'function'
      || typeof cleanupSessionRetirement !== 'function') {
    throw new Error('staging transaction recovery dependencies are invalid');
  }
  const key = transactionControlKey(script, args);
  const resolvedDeadlineRoot = path.resolve(
    deadlineControlRoot ?? path.join(os.tmpdir(), 'easyboost-staging-deadline-controls'),
  );
  const resolvedSessionRoot = path.resolve(
    sessionControlRoot ?? path.join(os.tmpdir(), 'easyboost-posix-session-controls'),
  );
  if (typeof prepareMaintenance !== 'function') {
    throw new Error('staging transaction maintenance dependency is invalid');
  }
  const maintenance = prepareMaintenance(environment, [
    resolvedDeadlineRoot, resolvedSessionRoot,
  ]);
  const deadlineMaintenance = quiescentOptions(
    maintenance.bindings.get(resolvedDeadlineRoot),
  );
  const sessionMaintenance = quiescentOptions(
    maintenance.bindings.get(resolvedSessionRoot),
  );
  const deadlineKey = `staging-deadline:${key}`;
  const deadlineDirectory = path.join(
    resolvedDeadlineRoot, createHash('sha256').update(deadlineKey, 'utf8').digest('hex'),
  );
  const sessionOptions = {
    controlKey: `staging-transaction:${key}`,
    controlRoot: resolvedSessionRoot,
  };
  const sessionDirectory = path.join(
    resolvedSessionRoot,
    createHash('sha256').update(sessionOptions.controlKey, 'utf8').digest('hex'),
  );
  let resolvedDeadlinePublication = deadlinePublicationAuthority;
  let resolvedDeadlineHandoff = deadlineRecoveryHandoff;
  let resolvedDeadlineRetirement = deadlineRetirementAuthority;
  let resolvedSessionPublications = mergeSessionPublicationAuthorities(
    posixSessionPublicationAuthorities,
    posixSessionPublicationAuthority,
  );
  let resolvedSessionHandoff = posixSessionRecoveryHandoff;
  let resolvedSessionRetirement = posixSessionRetirementAuthority;
  if (recoveryAuthority !== undefined) {
    if (deadlinePublicationAuthority !== undefined
        || deadlineRecoveryHandoff !== undefined
        || deadlineRetirementAuthority !== undefined
        || posixSessionPublicationAuthorities !== undefined
        || posixSessionPublicationAuthority !== undefined
        || posixSessionRecoveryHandoff !== undefined
        || posixSessionRetirementAuthority !== undefined) {
      throw new Error('staging transaction recovery authority inputs are ambiguous');
    }
    const exact = exactTransactionRecoveryAuthority(recoveryAuthority);
    if ((exact.deadlineControlDirectory !== null
          && exact.deadlineControlDirectory !== deadlineDirectory)
        || (exact.posixSessionControlDirectory !== null
          && exact.posixSessionControlDirectory !== sessionDirectory)) {
      throw new Error('staging transaction recovery authority belongs to another transaction');
    }
    resolvedDeadlinePublication = exact.deadlinePublicationAuthority;
    resolvedDeadlineHandoff = exact.deadlineRecoveryHandoff;
    resolvedDeadlineRetirement = exact.deadlineRetirementAuthority;
    resolvedSessionPublications = mergeSessionPublicationAuthorities(
      exact.posixSessionPublicationAuthorities,
      exact.posixSessionPublicationAuthority,
    );
    resolvedSessionHandoff = exact.posixSessionRecoveryHandoff;
    resolvedSessionRetirement = exact.posixSessionRetirementAuthority;
  }
  if (resolvedSessionHandoff !== undefined) {
    resolvedSessionHandoff = exactRecoveryHandoff(resolvedSessionHandoff, {
      controlDirectory: sessionDirectory,
      expectedControlKey: sessionOptions.controlKey,
      expectedProtocol: 'easyboost-posix-session-recovery-handoff-v1',
      expectedRecoveryScope: deadlineDirectory,
      label: 'POSIX session',
    });
  }
  if (resolvedDeadlineHandoff !== undefined) {
    resolvedDeadlineHandoff = exactRecoveryHandoff(resolvedDeadlineHandoff, {
      controlDirectory: deadlineDirectory,
      expectedControlKey: deadlineKey,
      expectedProtocol: 'easyboost-staging-deadline-recovery-handoff-v1',
      label: 'staging deadline',
    });
  }
  if (resolvedSessionRetirement !== undefined) {
    try {
      cleanupSessionRetirement(resolvedSessionRetirement, sessionMaintenance);
      resolvedSessionRetirement = undefined;
    } catch (cause) {
      throw transactionRecoveryFailure(cause, {
        deadlineDirectory,
        deadlinePublicationAuthority: resolvedDeadlinePublication,
        deadlineRecoveryHandoff: resolvedDeadlineHandoff,
        deadlineRetirementAuthority: resolvedDeadlineRetirement,
        publicationRole: 'session',
        sessionDirectory,
        sessionPublicationAuthorities: resolvedSessionPublications,
        sessionRecoveryHandoff: resolvedSessionHandoff,
        sessionRetirementAuthority: resolvedSessionRetirement,
      });
    }
  }
  while (resolvedSessionPublications.length > 0) {
    const [currentPublication, ...remainingPublications] = resolvedSessionPublications;
    try {
      cleanupSessionPublication(currentPublication, sessionMaintenance);
      resolvedSessionPublications = Object.freeze(remainingPublications);
    } catch (cause) {
      throw transactionRecoveryFailure(cause, {
        deadlineDirectory,
        deadlinePublicationAuthority: resolvedDeadlinePublication,
        deadlineRecoveryHandoff: resolvedDeadlineHandoff,
        deadlineRetirementAuthority: resolvedDeadlineRetirement,
        publicationRole: 'session',
        sessionDirectory,
        sessionPublicationAuthorities: resolvedSessionPublications,
        sessionRecoveryHandoff: resolvedSessionHandoff,
        sessionRetirementAuthority: resolvedSessionRetirement,
      });
    }
  }
  const deadlineRecoveryFailure = (cause) => transactionRecoveryFailure(cause, {
    deadlineDirectory,
    deadlinePublicationAuthority: resolvedDeadlinePublication,
    deadlineRecoveryHandoff: resolvedDeadlineHandoff,
    deadlineRetirementAuthority: resolvedDeadlineRetirement,
    publicationRole: 'deadline',
    sessionDirectory,
    sessionPublicationAuthorities: resolvedSessionPublications,
    sessionRecoveryHandoff: resolvedSessionHandoff,
    sessionRetirementAuthority: resolvedSessionRetirement,
  });
  const cleanupResolvedDeadlineRetirement = () => {
    if (resolvedDeadlineRetirement === undefined) return;
    try {
      cleanupDeadlineRetirement(resolvedDeadlineRetirement, deadlineMaintenance);
      resolvedDeadlineRetirement = undefined;
    } catch (cause) {
      throw deadlineRecoveryFailure(cause);
    }
  };
  const completeResolvedDeadlineRecovery = (candidate) => {
    resolvedDeadlineHandoff = candidate?.recoveryHandoff;
    if (candidate?.recoveryProof !== undefined) {
      let completed;
      try {
        completed = completeDeadlineRecovery(candidate.recoveryProof, {
          controlKey: deadlineKey,
          controlRoot: resolvedDeadlineRoot,
          ...deadlineMaintenance,
        });
      } catch (cause) {
        throw deadlineRecoveryFailure(cause);
      }
      if (completed !== true) {
        throw deadlineRecoveryFailure(
          new Error('staging transaction recovery could not retire the deadline authority'),
        );
      }
    }
    resolvedDeadlineHandoff = undefined;
  };

  // A terminal authority normally has no live source and can be reconciled
  // before any restart baton is adopted. A present source means retirement was
  // interrupted after reserving its terminal slot: retain that slot while
  // recovering the same deadline namespace under the session-absence protocol.
  let deadlineRetirementDeferred = false;
  if (resolvedDeadlineRetirement !== undefined) {
    try {
      deadlineRetirementDeferred = !pathIsAbsent(
        resolvedDeadlineRetirement.controlDirectory,
      );
    } catch (cause) {
      throw deadlineRecoveryFailure(cause);
    }
    if (!deadlineRetirementDeferred) cleanupResolvedDeadlineRetirement();
  }
  if (resolvedDeadlinePublication !== undefined) {
    try {
      cleanupDeadlinePublication(resolvedDeadlinePublication, deadlineMaintenance);
      resolvedDeadlinePublication = undefined;
    } catch (cause) {
      throw deadlineRecoveryFailure(cause);
    }
  }

  let deadline;
  let deadlineRecoveredBeforeSession = false;
  if (deadlineRetirementDeferred && resolvedDeadlineHandoff !== undefined) {
    try {
      deadline = resumeDeadlineRecovery(resolvedDeadlineHandoff, deadlineMaintenance);
    } catch (cause) {
      throw deadlineRecoveryFailure(cause);
    }
    completeResolvedDeadlineRecovery(deadline);
    cleanupResolvedDeadlineRetirement();
    deadlineRetirementDeferred = false;
    deadlineRecoveredBeforeSession = true;
  }
  let proven;
  try {
    proven = resolvedSessionHandoff === undefined
      ? recoverSession({
        ...sessionOptions,
        permitIncompleteRetirement: true,
        ...sessionMaintenance,
        recoveryScope: deadlineDirectory,
        retire: false,
      })
      : resumeSessionRecovery(resolvedSessionHandoff, sessionMaintenance);
  } catch (cause) {
    throw transactionRecoveryFailure(cause, {
      deadlineDirectory,
      deadlinePublicationAuthority: resolvedDeadlinePublication,
      deadlineRecoveryHandoff: resolvedDeadlineHandoff,
      deadlineRetirementAuthority: resolvedDeadlineRetirement,
      publicationRole: 'session',
      sessionDirectory,
      sessionPublicationAuthorities: resolvedSessionPublications,
      sessionRecoveryHandoff: resolvedSessionHandoff,
      sessionRetirementAuthority: resolvedSessionRetirement,
    });
  }
  resolvedSessionHandoff = proven?.recoveryHandoff;
  if (proven?.state !== 'absent' && proven?.absence !== 'absent') {
    throw transactionRecoveryFailure(
      new Error('staging transaction recovery cannot prove the owned session absent'), {
        deadlineDirectory,
        deadlinePublicationAuthority: resolvedDeadlinePublication,
        deadlineRecoveryHandoff: resolvedDeadlineHandoff,
        deadlineRetirementAuthority: resolvedDeadlineRetirement,
        publicationRole: 'session',
        sessionDirectory,
        sessionRecoveryHandoff: resolvedSessionHandoff,
        sessionRetirementAuthority: resolvedSessionRetirement,
      },
    );
  }
  if (!deadlineRecoveredBeforeSession) {
    try {
      deadline = resolvedDeadlineHandoff === undefined
        ? recoverDeadline({
          controlKey: deadlineKey,
          controlRoot: resolvedDeadlineRoot,
          ...deadlineMaintenance,
          permitIncompleteRetirement: true,
          retire: false,
          sessionControlRoot: resolvedSessionRoot,
          sessionRecoveryProof: proven.recoveryProof,
        })
        : resumeDeadlineRecovery(resolvedDeadlineHandoff, deadlineMaintenance);
    } catch (cause) {
      throw deadlineRecoveryFailure(cause);
    }
    completeResolvedDeadlineRecovery(deadline);
    if (deadlineRetirementDeferred) {
      cleanupResolvedDeadlineRetirement();
      deadlineRetirementDeferred = false;
    }
  }
  let sessionCompleted;
  try {
    sessionCompleted = completeSessionRecovery(proven.recoveryProof, {
      controlKey: sessionOptions.controlKey,
      controlRoot: sessionOptions.controlRoot,
      ...sessionMaintenance,
      recoveryScope: deadlineDirectory,
    });
  } catch (cause) {
    throw transactionRecoveryFailure(cause, {
      deadlineDirectory: null,
      deadlinePublicationAuthority: resolvedDeadlinePublication,
      deadlineRecoveryHandoff: resolvedDeadlineHandoff,
      publicationRole: 'session',
      sessionDirectory,
      sessionPublicationAuthorities: resolvedSessionPublications,
      sessionRecoveryHandoff: resolvedSessionHandoff,
      sessionRetirementAuthority: resolvedSessionRetirement,
    });
  }
  if (sessionCompleted !== true) {
    throw transactionRecoveryFailure(
      new Error('staging transaction recovery could not retire the proven session authority'), {
        deadlineDirectory: null,
        publicationRole: 'session',
        sessionDirectory,
        sessionRecoveryHandoff: resolvedSessionHandoff,
        sessionRetirementAuthority: resolvedSessionRetirement,
      },
    );
  }
  return Object.freeze({ deadline, session: proven });
}

export function runStagingTransaction({
  script,
  args = [],
  cwd = process.cwd(),
  deadlineControlRoot = path.join(os.tmpdir(), 'easyboost-staging-deadline-controls'),
  transactionSeconds,
  recoverySeconds,
  startupMilliseconds = DEFAULT_STARTUP_MILLISECONDS,
  termGraceMilliseconds = DEFAULT_TERM_GRACE_MILLISECONDS,
  settlementMilliseconds = DEFAULT_SETTLEMENT_MILLISECONDS,
  pollMilliseconds = DEFAULT_POLL_MILLISECONDS,
  platform = process.platform,
  environment = process.env,
  sessionControlRoot = path.join(os.tmpdir(), 'easyboost-posix-session-controls'),
  spawnProcess = spawn,
  posixSessionControl: suppliedPosixSessionControl,
  createSessionControl = createPosixSessionControl,
  createSessionInvocation = createPosixSessionInvocation,
  createDeadlineMailbox = createStagingDeadlineMailbox,
  createDeadlineController = createStagingDeadlineController,
  observeSessionWriterEgress = observePosixSessionWriterEgress,
  prepareMaintenance = prepareQuiescentMaintenance,
  processObject = process,
  reportRecoveryRequired = (authority) => processObject.stderr?.write(
    `STAGING_TRANSACTION_RECOVERY_REQUIRED ${JSON.stringify(authority)}\n`,
  ),
} = {}) {
  if (platform !== 'linux') {
    const error = new Error(
      'staging transaction supervision requires an isolated Linux session with /proc proof',
    );
    error.exitCode = 125;
    throw error;
  }
  transactionControlKey(script, args);
  const transactionBound = positiveInteger(transactionSeconds, 'staging transaction deadline');
  const recoveryBound = positiveInteger(recoverySeconds, 'staging recovery deadline');
  const startupBound = positiveInteger(startupMilliseconds, 'staging deadline startup bound');
  const termGrace = positiveInteger(termGraceMilliseconds, 'staging deadline TERM grace');
  const settlementBound = positiveInteger(
    settlementMilliseconds, 'staging deadline settlement bound',
  );
  const pollBound = positiveInteger(pollMilliseconds, 'staging deadline poll interval');

  const controlKey = transactionControlKey(script, args);
  const resolvedDeadlineRoot = path.resolve(deadlineControlRoot);
  const resolvedSessionRoot = path.resolve(sessionControlRoot);
  if (typeof prepareMaintenance !== 'function') {
    throw new Error('staging transaction maintenance dependency is invalid');
  }
  const maintenance = prepareMaintenance(environment, [
    resolvedDeadlineRoot, resolvedSessionRoot,
  ]);
  const deadlineMaintenance = quiescentOptions(
    maintenance.bindings.get(resolvedDeadlineRoot),
  );
  const sessionMaintenance = quiescentOptions(
    maintenance.bindings.get(resolvedSessionRoot),
  );
  const deadlineTimers = new Set();
  const setDeadlineTimer = (callback, milliseconds) => {
    let timer;
    timer = setTimeout(() => {
      deadlineTimers.delete(timer);
      callback();
    }, milliseconds);
    deadlineTimers.add(timer);
    return timer;
  };
  const clearDeadlineTimer = (timer) => {
    clearTimeout(timer);
    deadlineTimers.delete(timer);
  };
  let deadlineExpired = false;
  let requestTermination = () => {};
  let deadlineMailbox;
  let deadlineController;
  let posixSessionControl = suppliedPosixSessionControl;
  let invocation;
  let child;
  let wrapperSpawned = false;
  let writerEgressMetadata;
  let writerEgressStream;
  let startupStage = 'session-control';
  try {
    posixSessionControl ??= createSessionControl({
      controlKey: `staging-transaction:${controlKey}`,
      controlRoot: resolvedSessionRoot,
      ...sessionMaintenance,
    });
    startupStage = 'deadline-mailbox';
    deadlineMailbox = createDeadlineMailbox({
      controlKey: `staging-deadline:${controlKey}`,
      controlRoot: resolvedDeadlineRoot,
      ...deadlineMaintenance,
    });
    startupStage = 'deadline-controller';
    deadlineController = createDeadlineController({
      clearTimer: clearDeadlineTimer,
      onDeadline() {
        deadlineExpired = true;
        requestTermination(new Error('staging transaction deadline expired'));
      },
      recoverySeconds: recoveryBound,
      setTimer: setDeadlineTimer,
      token: deadlineMailbox.specification.token,
      transactionSeconds: transactionBound,
    });
    startupStage = 'session-invocation';
    invocation = createSessionInvocation(
      '/bin/bash',
      ['--noprofile', '--norc', script, ...args],
      cwd,
      settlementBound,
      {
        ...maintenance.environment,
        [STAGING_DEADLINE_CONTROL_ENVIRONMENT]: deadlineMailbox.environmentValue,
      },
      posixSessionControl,
    );
    posixSessionControl = invocation.posixSessionControl ?? posixSessionControl;
    if (!posixSessionControl) throw new Error('staging transaction has no owned-session control');
    writerEgressMetadata = invocation.writerEgress;
    startupStage = 'wrapper-spawn';
    child = spawnProcess(invocation.command, invocation.args, {
      cwd: invocation.cwd ?? cwd,
      detached: true,
      env: invocation.environment,
      shell: false,
      stdio: writerEgressMetadata === undefined
        ? 'inherit' : ['inherit', 'inherit', 'inherit', 'pipe'],
      windowsHide: true,
    });
    if (child?.pid) {
      wrapperSpawned = true;
      posixSessionControl.markWrapperSpawned();
    }
    if (writerEgressMetadata !== undefined) {
      if (writerEgressMetadata?.descriptor !== 3
          || writerEgressMetadata.specification !== posixSessionControl.specification
          || typeof observeSessionWriterEgress !== 'function'
          || !child?.stdio?.[writerEgressMetadata.descriptor]) {
        throw new Error('staging transaction writer egress pipe is invalid');
      }
      writerEgressStream = child.stdio[writerEgressMetadata.descriptor];
    }
  } catch (cause) {
    for (const timer of deadlineTimers) clearTimeout(timer);
    deadlineTimers.clear();
    const cleanupFailures = [];
    let deadlineCleanupUnproven = false;
    let deadlineCleanupPublication = null;
    let deadlineCleanupRecoveryHandoff = null;
    let deadlineCleanupRetirement = null;
    let sessionCleanupUnproven = false;
    let sessionCleanupPublication = null;
    let sessionCleanupRecoveryHandoff = null;
    let sessionCleanupRetirement = null;
    if (wrapperSpawned) {
      deadlineCleanupUnproven = deadlineMailbox !== undefined;
      sessionCleanupUnproven = posixSessionControl !== undefined;
      try { posixSessionControl?.request('SIGTERM'); } catch (error) {
        sessionCleanupPublication = exactPublicationAuthority(error?.recoveryAuthority, {
          sourceBindingRequired: true,
        });
        sessionCleanupRetirement = exactRetirementAuthority(error?.recoveryAuthority, {
          posixSession: true,
        });
        const raw = error?.recoveryHandoff ?? error?.recoveryAuthority?.recoveryHandoff;
        if (sessionCleanupPublication === null && sessionCleanupRetirement === null && raw) {
          try {
            sessionCleanupRecoveryHandoff = exactRecoveryHandoff(raw, {
              controlDirectory: posixSessionControl?.specification?.controlDirectory,
              expectedControlKey: `staging-transaction:${controlKey}`,
              expectedProtocol: 'easyboost-posix-session-recovery-handoff-v1',
              expectedRecoveryScope: deadlineMailbox?.specification?.controlDirectory,
              label: 'POSIX session',
            });
          } catch {}
        }
        cleanupFailures.push(error);
      }
      child?.on?.('error', () => {});
      child?.unref?.();
    } else {
      try {
        posixSessionControl?.dispose({
          force: true,
          recoveryScope: deadlineMailbox?.specification?.controlDirectory
            ?? (startupStage === 'deadline-mailbox'
              ? cause?.recoveryAuthority?.controlDirectory ?? null : null),
        });
      } catch (error) {
        sessionCleanupUnproven = true;
        sessionCleanupPublication = exactPublicationAuthority(error?.recoveryAuthority, {
          sourceBindingRequired: true,
        });
        sessionCleanupRetirement = exactRetirementAuthority(error?.recoveryAuthority, {
          posixSession: true,
        });
        const raw = error?.recoveryHandoff ?? error?.recoveryAuthority?.recoveryHandoff;
        if (sessionCleanupPublication === null && sessionCleanupRetirement === null && raw) {
          try {
            sessionCleanupRecoveryHandoff = exactRecoveryHandoff(raw, {
              controlDirectory: posixSessionControl?.specification?.controlDirectory,
              expectedControlKey: `staging-transaction:${controlKey}`,
              expectedProtocol: 'easyboost-posix-session-recovery-handoff-v1',
              expectedRecoveryScope: deadlineMailbox?.specification?.controlDirectory
                ?? (startupStage === 'deadline-mailbox'
                  ? cause?.recoveryAuthority?.controlDirectory : undefined),
              label: 'POSIX session',
            });
          } catch {}
        }
        cleanupFailures.push(error);
      }
      try { deadlineMailbox?.dispose(); } catch (error) {
        deadlineCleanupUnproven = true;
        deadlineCleanupPublication = exactPublicationAuthority(error?.recoveryAuthority);
        deadlineCleanupRetirement = exactRetirementAuthority(error?.recoveryAuthority);
        const raw = error?.recoveryHandoff ?? error?.recoveryAuthority?.recoveryHandoff;
        if (deadlineCleanupPublication === null && deadlineCleanupRetirement === null && raw) {
          try {
            deadlineCleanupRecoveryHandoff = exactRecoveryHandoff(raw, {
              controlDirectory: deadlineMailbox?.specification?.controlDirectory,
              expectedControlKey: `staging-deadline:${controlKey}`,
              expectedProtocol: 'easyboost-staging-deadline-recovery-handoff-v1',
              label: 'staging deadline',
            });
          } catch {}
        }
        cleanupFailures.push(error);
      }
    }
    const partialDirectory = cause?.recoveryAuthority?.controlDirectory ?? null;
    const partialPublication = exactPublicationAuthority(cause?.recoveryAuthority, {
      sourceBindingRequired: startupStage === 'session-control',
    });
    const partialRetirement = exactRetirementAuthority(cause?.recoveryAuthority, {
      posixSession: startupStage === 'session-control',
    });
    const deadlinePartial = (startupStage === 'deadline-mailbox' || startupStage === 'deadline-controller')
      ? partialDirectory : null;
    const sessionPartial = startupStage === 'session-control' ? partialDirectory : null;
    const deadlinePublication = deadlinePartial === null
      ? deadlineCleanupPublication : partialPublication;
    const sessionPublication = sessionPartial === null
      ? sessionCleanupPublication : partialPublication;
    const deadlineRetirement = deadlinePartial === null
      ? deadlineCleanupRetirement : partialRetirement;
    const sessionRetirement = sessionPartial === null
      ? sessionCleanupRetirement : partialRetirement;
    const deadlineHandoff = deadlinePartial === null
      ? deadlineCleanupRecoveryHandoff : null;
    const sessionHandoff = sessionPartial === null
      ? sessionCleanupRecoveryHandoff : null;
    const deadlineDirectory = deadlinePartial
      ?? (deadlineCleanupUnproven ? deadlineMailbox?.specification?.controlDirectory ?? null : null);
    const sessionDirectory = sessionPartial
      ?? (sessionCleanupUnproven ? posixSessionControl?.specification?.controlDirectory ?? null : null);
    const recoveryAuthority = boundedRecoveryAuthority(Object.freeze({
      deadlineControlDirectory: deadlineDirectory,
      ...(deadlinePublication === null
        ? {} : { deadlinePublicationAuthority: deadlinePublication }),
      ...(deadlineHandoff === null || deadlinePublication !== null || deadlineRetirement !== null
        ? {} : { deadlineRecoveryHandoff: deadlineHandoff }),
      ...(deadlineRetirement === null
        ? {} : { deadlineRetirementAuthority: deadlineRetirement }),
      posixSessionControlDirectory: sessionDirectory,
      ...(sessionPublication === null
        ? {} : { posixSessionPublicationAuthority: sessionPublication }),
      ...(sessionHandoff === null || sessionPublication !== null || sessionRetirement !== null
        ? {} : { posixSessionRecoveryHandoff: sessionHandoff }),
      ...(sessionRetirement === null
        ? {} : { posixSessionRetirementAuthority: sessionRetirement }),
      protocol: STAGING_TRANSACTION_RECOVERY_PROTOCOL,
    }));
    const aggregated = cleanupFailures.length === 0 ? cause : new AggregateError(
      [cause, ...cleanupFailures],
      'staging transaction startup and authority cleanup both failed',
      { cause },
    );
    const error = new Error('staging transaction supervisor could not start', { cause: aggregated });
    error.exitCode = 125;
    if (deadlineDirectory !== null || sessionDirectory !== null) {
      error.recoveryAuthority = recoveryAuthority;
    }
    throw error;
  }

  return new Promise((resolve) => {
    let readyAcknowledged = false;
    let wrapperClosed = false;
    let targetStatus;
    let primaryFailure;
    let cleanupFailure;
    let recoveryNeeded = false;
    let deadlineAuthorityRetained = true;
    let deadlinePublicationAuthority = null;
    let deadlineRecoveryHandoff = null;
    let deadlineRetirementAuthority = null;
    let sessionAuthorityRetained = true;
    let sessionPublicationAuthorities = Object.freeze([]);
    let sessionRecoveryHandoff = null;
    let sessionRetirementAuthority = null;
    let writerEgressEnded = writerEgressMetadata === undefined;
    let writerEgressObserver;
    let terminationStarted = false;
    let settled = false;
    let recoveryReported = false;
    let startupTimer;
    let termTimer;
    let settlementTimer;
    let pollTimer;

    const clearLifecycle = () => {
      clearTimeout(startupTimer);
      clearTimeout(termTimer);
      clearTimeout(settlementTimer);
      clearInterval(pollTimer);
      for (const timer of deadlineTimers) clearTimeout(timer);
      deadlineTimers.clear();
      processObject.off?.('SIGINT', onInterrupt);
      processObject.off?.('SIGTERM', onTerminate);
      writerEgressObserver?.cancel();
      // Cancelling only detaches observers.  The pipe itself is a referenced
      // event-loop handle, so a malicious/stuck wrapper that keeps fd3 open
      // would otherwise keep the recovery CLI alive after the settlement bound.
      if (writerEgressStream?.destroyed !== true) writerEgressStream?.destroy?.();
    };
    const retainCleanupFailure = (failure, role) => {
      recoveryNeeded = true;
      const publication = exactPublicationAuthority(failure?.recoveryAuthority, {
        sourceBindingRequired: role === 'session',
      });
      const retirement = exactRetirementAuthority(failure?.recoveryAuthority, {
        posixSession: role === 'session',
      });
      if (role === 'deadline' && publication !== null) {
        deadlinePublicationAuthority = publication;
      }
      if (role === 'deadline' && retirement !== null) {
        deadlineRetirementAuthority = retirement;
      }
      const rawHandoff = failure?.recoveryHandoff
        ?? failure?.recoveryAuthority?.recoveryHandoff;
      if (publication === null && retirement === null && rawHandoff !== undefined) {
        try {
          if (role === 'deadline') {
            deadlineRecoveryHandoff = exactRecoveryHandoff(rawHandoff, {
              controlDirectory: deadlineMailbox.specification.controlDirectory,
              expectedControlKey: `staging-deadline:${controlKey}`,
              expectedProtocol: 'easyboost-staging-deadline-recovery-handoff-v1',
              label: 'staging deadline',
            });
          } else if (role === 'session') {
            sessionRecoveryHandoff = exactRecoveryHandoff(rawHandoff, {
              controlDirectory: posixSessionControl.specification.controlDirectory,
              expectedControlKey: `staging-transaction:${controlKey}`,
              expectedProtocol: 'easyboost-posix-session-recovery-handoff-v1',
              expectedRecoveryScope: deadlineMailbox.specification.controlDirectory,
              label: 'POSIX session',
            });
          }
        } catch {}
      }
      if (role === 'session' && publication !== null) {
        sessionPublicationAuthorities = mergeSessionPublicationAuthorities(
          sessionPublicationAuthorities, publication,
        );
      }
      if (role === 'session' && retirement !== null) {
        sessionRetirementAuthority = retirement;
      }
      cleanupFailure = cleanupFailure === undefined ? failure : new AggregateError(
        [cleanupFailure, failure],
        'staging transaction cleanup produced multiple failures',
        { cause: cleanupFailure },
      );
      primaryFailure ??= cleanupFailure;
    };
    const complete = (status, { disposeMailbox = false, failure, failureRole } = {}) => {
      if (settled) return;
      settled = true;
      clearLifecycle();
      if (failure) retainCleanupFailure(failure, failureRole);
      if (disposeMailbox) {
        try {
          deadlineMailbox.dispose();
          deadlineAuthorityRetained = false;
        } catch (error) {
          retainCleanupFailure(error, 'deadline');
          status = 125;
        }
      }
      if (recoveryNeeded && (deadlineAuthorityRetained || sessionAuthorityRetained)
          && !recoveryReported) {
        recoveryReported = true;
        try {
          reportRecoveryRequired(boundedRecoveryAuthority(Object.freeze({
            deadlineControlDirectory: deadlineAuthorityRetained
              ? deadlineMailbox.specification.controlDirectory : null,
            ...(deadlineAuthorityRetained && deadlinePublicationAuthority !== null
              ? { deadlinePublicationAuthority } : {}),
            ...(deadlineAuthorityRetained && deadlineRecoveryHandoff !== null
                && deadlinePublicationAuthority === null
                && deadlineRetirementAuthority === null
              ? { deadlineRecoveryHandoff } : {}),
            ...(deadlineAuthorityRetained && deadlineRetirementAuthority !== null
              ? { deadlineRetirementAuthority } : {}),
            posixSessionControlDirectory: sessionAuthorityRetained
              ? posixSessionControl.specification?.controlDirectory ?? null : null,
            ...(sessionAuthorityRetained
              ? sessionPublicationAuthorityFields(sessionPublicationAuthorities) : {}),
            ...(sessionAuthorityRetained && sessionRecoveryHandoff !== null
                && sessionPublicationAuthorities.length === 0
                && sessionRetirementAuthority === null
              ? { posixSessionRecoveryHandoff: sessionRecoveryHandoff } : {}),
            ...(sessionAuthorityRetained && sessionRetirementAuthority !== null
              ? { posixSessionRetirementAuthority: sessionRetirementAuthority } : {}),
            protocol: STAGING_TRANSACTION_RECOVERY_PROTOCOL,
          })));
        } catch {}
      }
      if (!wrapperClosed) child.unref?.();
      resolve(status);
    };
    const finishIfProven = () => {
      if (!wrapperClosed || !writerEgressEnded || settled) return;
      let proof;
      try {
        proof = posixSessionControl.proofState();
      } catch {
        recoveryNeeded = true;
        complete(125);
        return;
      }
      if (proof.state !== 'absent') return;
      if (sessionPublicationAuthorities.length > 0 || sessionRetirementAuthority !== null) {
        recoveryNeeded = true;
        complete(125);
        return;
      }
      try {
        posixSessionControl.dispose({
          recoveryScope: deadlineMailbox.specification.controlDirectory,
        });
        sessionAuthorityRetained = false;
      } catch (error) {
        complete(125, { failure: error, failureRole: 'session' });
        return;
      }
      const disarmed = deadlineController.state() === 'DISARMED';
      if (primaryFailure || deadlineExpired || !disarmed) {
        recoveryNeeded = true;
        complete(125);
        return;
      }
      complete(statusFromTarget(targetStatus), { disposeMailbox: true });
    };
    const failAtSettlementBound = () => {
      let proof;
      try {
        proof = posixSessionControl.proofState();
      } catch {
        recoveryNeeded = true;
        complete(125);
        return;
      }
      if (proof.state === 'absent' && wrapperClosed && writerEgressEnded) {
        finishIfProven();
        return;
      }
      recoveryNeeded = true;
      complete(125);
    };
    const armSettlementBound = (milliseconds = settlementBound) => {
      if (settled || settlementTimer !== undefined) return;
      settlementTimer = setTimeout(failAtSettlementBound, milliseconds);
    };
    requestTermination = (failure) => {
      primaryFailure ??= failure;
      recoveryNeeded = true;
      if (terminationStarted || settled) return;
      terminationStarted = true;
      if (!wrapperClosed) {
        try { posixSessionControl.request('SIGTERM'); } catch (error) {
          retainCleanupFailure(error, 'session');
        }
      }
      termTimer = setTimeout(() => {
        if (!wrapperClosed) {
          try { posixSessionControl.request('SIGKILL'); } catch (error) {
            retainCleanupFailure(error, 'session');
          }
        }
      }, termGrace);
      armSettlementBound(termGrace + settlementBound);
    };
    const acknowledgeReady = () => {
      let ready;
      try {
        ready = posixSessionControl.readyState();
      } catch (error) {
        requestTermination(error);
        return;
      }
      if (ready.state === 'missing') return;
      if (ready.state !== 'present') {
        requestTermination(new Error('staging owned-session READY proof is invalid'));
        return;
      }
      try {
        deadlineMailbox.acknowledge(deadlineController.ready());
        readyAcknowledged = true;
        clearTimeout(startupTimer);
      } catch (error) {
        retainCleanupFailure(error, 'deadline');
        requestTermination(error);
      }
    };
    const consumeTransition = () => {
      const state = deadlineController.state();
      if (state !== 'TRANSACTION' && state !== 'RECOVERY') return;
      const sequence = state === 'TRANSACTION' ? 1 : 2;
      const request = deadlineMailbox.requestState(sequence);
      if (request.state === 'missing') return;
      if (request.state !== 'present') {
        requestTermination(request.error ?? new Error('staging deadline request is invalid'));
        return;
      }
      try {
        const acknowledgement = deadlineController.transition(request.record);
        deadlineMailbox.acknowledge(acknowledgement);
      } catch (error) {
        retainCleanupFailure(error, 'deadline');
        requestTermination(error);
      }
    };
    const poll = () => {
      if (settled) return;
      if (!readyAcknowledged) acknowledgeReady();
      else consumeTransition();
      finishIfProven();
    };
    const onInterrupt = () => requestTermination(new Error('staging transaction interrupted'));
    const onTerminate = () => requestTermination(new Error('staging transaction terminated'));

    if (writerEgressMetadata !== undefined) {
      try {
        writerEgressObserver = observeSessionWriterEgress(
          writerEgressStream,
          writerEgressMetadata.specification,
          {
            onAuthority(authority) {
              const failure = new Error(
                'staging transaction wrapper retained exact writer residue',
              );
              failure.recoveryAuthority = authority;
              retainCleanupFailure(failure, 'session');
              requestTermination(failure);
            },
            onEnd() {
              writerEgressEnded = true;
              poll();
              if (wrapperClosed) armSettlementBound();
            },
            onProtocolFailure(cause) {
              requestTermination(new Error(
                'staging transaction wrapper writer egress is invalid', { cause },
              ));
            },
          },
        );
      } catch (cause) {
        requestTermination(new Error(
          'staging transaction could not observe wrapper writer egress', { cause },
        ));
      }
    }

    child.once('error', (error) => {
      if (!child?.pid) {
        primaryFailure ??= error;
        try {
          posixSessionControl.dispose({
            force: true,
            recoveryScope: deadlineMailbox.specification.controlDirectory,
          });
          sessionAuthorityRetained = false;
        } catch (cleanupError) {
          retainCleanupFailure(cleanupError, 'session');
        }
        try {
          deadlineMailbox.dispose();
          deadlineAuthorityRetained = false;
        } catch (cleanupError) {
          retainCleanupFailure(cleanupError, 'deadline');
        }
        complete(125);
        return;
      }
      requestTermination(new Error('staging transaction wrapper emitted a post-spawn error', {
        cause: error,
      }));
    });
    child.once('close', (code, signal) => {
      wrapperClosed = true;
      try {
        posixSessionControl.observeWrapperClose?.(code, signal);
        targetStatus = posixSessionControl.targetStatus();
      } catch (error) {
        primaryFailure ??= error;
        targetStatus = { state: 'unknown' };
      }
      if (targetStatus.state !== 'present') {
        primaryFailure ??= new Error('staging transaction target status was not proven');
        recoveryNeeded = true;
      }
      poll();
      armSettlementBound();
    });
    processObject.on?.('SIGINT', onInterrupt);
    processObject.on?.('SIGTERM', onTerminate);
    startupTimer = setTimeout(() => requestTermination(
      new Error('staging transaction READY acknowledgement deadline expired'),
    ), startupBound);
    pollTimer = setInterval(poll, pollBound);
    poll();
  });
}

async function runCli() {
  const [mode, ...values] = process.argv.slice(2);
  if (mode === '--recover-with-authority') {
    if (values.length < 3 || values[1] !== '--') {
      throw new Error(
        'Usage: staging-transaction-supervisor.js --recover-with-authority AUTHORITY_JSON -- SCRIPT [ARG...]',
      );
    }
    const recovered = recoverStagingTransaction({
      args: values.slice(3),
      recoveryAuthority: parseStagingTransactionRecoveryAuthority(values[0]),
      script: path.resolve(values[2]),
    });
    process.stdout.write(`${JSON.stringify(recovered)}\n`);
    return;
  }
  if (mode === '--recover' && values.length >= 1) {
    const recovered = recoverStagingTransaction({
      args: values.slice(1),
      script: path.resolve(values[0]),
    });
    process.stdout.write(`${JSON.stringify(recovered)}\n`);
    return;
  }
  if (mode === '--ready' && values.length === 2) {
    await awaitStagingDeadlineReady({
      timeoutMilliseconds: positiveInteger(
        values[1], 'staging READY acknowledgement timeout',
      ),
      transactionSeconds: positiveInteger(values[0], 'staging transaction deadline'),
    });
    return;
  }
  if (mode === '--request' && values.length === 4) {
    await requestStagingDeadlineTransition({
      action: values[0],
      seconds: Number(values[1]),
      sequence: Number(values[2]),
      timeoutMilliseconds: positiveInteger(values[3], 'staging deadline request timeout'),
    });
    return;
  }
  const separator = values.indexOf('--');
  if (mode !== '--run' || separator !== 5 || separator + 1 >= values.length) {
    throw new Error(
      'Usage: staging-transaction-supervisor.js --recover SCRIPT [ARG...] '
      + '| --recover-with-authority AUTHORITY_JSON -- SCRIPT [ARG...] '
      + '| --run TRANSACTION_SECONDS RECOVERY_SECONDS TERM_GRACE_MS '
      + 'SETTLEMENT_MS STARTUP_MS -- SCRIPT [ARG...]',
    );
  }
  const status = await runStagingTransaction({
    args: values.slice(separator + 2),
    recoverySeconds: positiveInteger(values[1], 'staging recovery deadline'),
    script: path.resolve(values[separator + 1]),
    settlementMilliseconds: positiveInteger(values[3], 'staging settlement bound'),
    startupMilliseconds: positiveInteger(values[4], 'staging startup bound'),
    termGraceMilliseconds: positiveInteger(values[2], 'staging TERM grace'),
    transactionSeconds: positiveInteger(values[0], 'staging transaction deadline'),
  });
  process.exitCode = status;
}

function diagnosticErrorMessages(error) {
  const pending = [error];
  const seen = new Set();
  const messages = [];
  while (pending.length > 0 && seen.size < 32) {
    const current = pending.shift();
    if (!current || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);
    if (typeof current.message === 'string' && !messages.includes(current.message)) {
      messages.push(current.message);
    }
    if (current instanceof AggregateError) pending.push(...current.errors);
    pending.push(current.cause);
  }
  return messages;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli().catch((error) => {
    if (error?.recoveryAuthority) {
      process.stderr.write(`STAGING_TRANSACTION_RECOVERY_REQUIRED ${JSON.stringify(error.recoveryAuthority)}\n`);
    }
    for (const [index, message] of diagnosticErrorMessages(error).entries()) {
      console.error(index === 0 ? message : `caused by: ${message}`);
    }
    process.exitCode = error?.exitCode ?? 125;
  });
}
