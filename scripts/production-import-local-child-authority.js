import { createHash } from 'node:crypto';
import path from 'node:path';

import {
  normalizePosixSessionPublicationResidue,
  normalizePosixSessionPublicationResidues,
} from './posix-session-supervisor.js';

export const PRODUCTION_IMPORT_LOCAL_CHILD_RECOVERY_PROTOCOL =
  'easyboost-production-import-local-child-recovery-v1';
export const PRODUCTION_IMPORT_LOCAL_CHILD_RETENTION_REASON =
  'IMPORT_LOCAL_CHILD_SETTLEMENT_UNPROVEN';

const WINDOWS_JOB_RECOVERY_PROTOCOL = 'easyboost-windows-job-recovery-v2';
const TOKEN = /^[0-9a-f]{64}$/u;
const BASE64URL = /^[A-Za-z0-9_-]+$/u;
// Both durable guard protocols cap their complete marker at 16 KiB.  An 11 KiB
// JSON payload base64url-encodes to at most 15,019 bytes, leaving enough room
// for the larger checksummed database marker envelope.  Keep this bound here so
// controller paths are rejected before a child can exist rather than later,
// when guard retention has become mandatory.
const MAX_AUTHORITY_BYTES = 11 * 1024;
// One writer-egress failure plus the controller's single TERM and KILL writes
// are the complete set that bounded-child-lifecycle can retain for one child.
// Each direct publication failure carries the destination/private-inode pair
// plus the exact original file identity/content descriptor.
const POSIX_IMPORT_PUBLICATION_NAMES = Object.freeze([
  'session-settled.proof',
  'term.request',
  'kill.request',
]);

function windowsControllerAuthority(controlRoot, controlKey) {
  if (typeof controlRoot !== 'string' || !path.isAbsolute(controlRoot)
      || typeof controlKey !== 'string' || controlKey.length === 0) {
    throw new Error('Production import Windows controller retention authority is invalid');
  }
  const root = path.resolve(controlRoot);
  const controlKeyHash = createHash('sha256').update(controlKey, 'utf8').digest('hex');
  const controlName = `easyboost-windows-job-${controlKeyHash}`;
  const retirementName = `.${controlName}.retired`;
  const retirementProof = path.join(root, `${retirementName}.proof`);
  return Object.freeze({
    authorityFile: retirementProof,
    controlDirectory: path.join(root, controlName),
    proofToken: '0'.repeat(64),
    protocol: WINDOWS_JOB_RECOVERY_PROTOCOL,
    retirementDirectory: path.join(root, retirementName),
    retirementProof,
  });
}

function exactKeys(value, expected) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function exactAbsolutePath(value) {
  return typeof value === 'string'
    && Buffer.byteLength(value, 'utf8') <= 4_096
    && !value.includes('\0')
    && path.isAbsolute(value)
    && path.normalize(value) === value;
}

function normalizeWindowsController(authority) {
  const expectedKeys = [
    'authorityFile',
    'controlDirectory',
    'proofToken',
    'protocol',
    'retirementDirectory',
    'retirementProof',
  ];
  if (!exactKeys(authority, expectedKeys)
      || authority.protocol !== WINDOWS_JOB_RECOVERY_PROTOCOL
      || !TOKEN.test(authority.proofToken || '')
      || expectedKeys.filter((key) => !['proofToken', 'protocol'].includes(key))
        .some((key) => !exactAbsolutePath(authority[key]))) {
    throw new Error('Production import local-child controller authority is invalid');
  }
  const match = /^easyboost-windows-job-([0-9a-f]{64})$/u.exec(
    path.basename(authority.controlDirectory),
  );
  if (!match) {
    throw new Error('Production import local-child Windows controller namespace is invalid');
  }
  const root = path.dirname(authority.controlDirectory);
  const retirementName = `.easyboost-windows-job-${match[1]}.retired`;
  const expected = {
    authorityFile: path.join(root, `${retirementName}.proof`),
    controlDirectory: path.join(root, `easyboost-windows-job-${match[1]}`),
    proofToken: authority.proofToken,
    protocol: WINDOWS_JOB_RECOVERY_PROTOCOL,
    retirementDirectory: path.join(root, retirementName),
    retirementProof: path.join(root, `${retirementName}.proof`),
  };
  if (expectedKeys.some((key) => authority[key] !== expected[key])) {
    throw new Error('Production import local-child Windows controller paths are not exact');
  }
  return Object.freeze(expected);
}

export function normalizeProductionImportChildControllerAuthority(authority) {
  if (authority?.protocol === WINDOWS_JOB_RECOVERY_PROTOCOL) {
    return normalizeWindowsController(authority);
  }
  const hasPublicationResidue = authority?.publicationResidue !== undefined;
  const hasPublicationResidues = authority?.publicationResidues !== undefined;
  if (hasPublicationResidue && hasPublicationResidues) {
    throw new Error('Production import local-child POSIX controller authority is ambiguous');
  }
  const posixKeys = hasPublicationResidue
    ? ['controlDirectory', 'publicationResidue']
    : hasPublicationResidues
      ? ['controlDirectory', 'publicationResidues']
      : ['controlDirectory'];
  if (!exactKeys(authority, posixKeys)
      || !exactAbsolutePath(authority.controlDirectory)
      || !TOKEN.test(path.basename(authority.controlDirectory))) {
    throw new Error('Production import local-child POSIX controller authority is invalid');
  }
  return Object.freeze({
    controlDirectory: authority.controlDirectory,
    ...(!hasPublicationResidue ? {} : {
      publicationResidue: normalizePosixSessionPublicationResidue(
        authority.publicationResidue,
        authority.controlDirectory,
      ),
    }),
    ...(!hasPublicationResidues ? {} : {
      publicationResidues: normalizePosixSessionPublicationResidues(
        authority.publicationResidues,
        authority.controlDirectory,
      ),
    }),
  });
}

export function normalizeProductionImportLocalChildRecovery(authority) {
  if (!exactKeys(authority, ['controller', 'hold', 'protocol'])
      || authority.protocol !== PRODUCTION_IMPORT_LOCAL_CHILD_RECOVERY_PROTOCOL
      || !exactKeys(authority.hold, [
        'authorityToken', 'commandSha256', 'holdToken',
      ])
      || !TOKEN.test(authority.hold.authorityToken || '')
      || !TOKEN.test(authority.hold.commandSha256 || '')
      || !TOKEN.test(authority.hold.holdToken || '')) {
    throw new Error('Production import local-child recovery authority is invalid');
  }
  return Object.freeze({
    controller: normalizeProductionImportChildControllerAuthority(authority.controller),
    hold: Object.freeze({
      authorityToken: authority.hold.authorityToken,
      commandSha256: authority.hold.commandSha256,
      holdToken: authority.hold.holdToken,
    }),
    protocol: PRODUCTION_IMPORT_LOCAL_CHILD_RECOVERY_PROTOCOL,
  });
}

export function createProductionImportLocalChildRecovery(controller, hold) {
  return normalizeProductionImportLocalChildRecovery({
    controller,
    hold,
    protocol: PRODUCTION_IMPORT_LOCAL_CHILD_RECOVERY_PROTOCOL,
  });
}

export function assertProductionImportPosixControllerRetentionBound(controlDirectory) {
  if (!exactAbsolutePath(controlDirectory) || !TOKEN.test(path.basename(controlDirectory))) {
    throw new Error('Production import POSIX controller retention authority is invalid');
  }
  const controlRoot = path.dirname(controlDirectory);
  const sourceBinding = Object.freeze({
    birthtimeNs: '18446744073709551615',
    bytes: 65_536,
    ctimeNs: '18446744073709551615',
    dev: '18446744073709551615',
    gid: '4294967295',
    ino: '18446744073709551615',
    mode: '4294967295',
    sha256: 'f'.repeat(64),
    uid: '4294967295',
  });
  const publicationResidues = POSIX_IMPORT_PUBLICATION_NAMES.map((name) => {
    const temporary = path.join(
      controlRoot,
      `.${path.basename(controlDirectory)}.${name}.${'0'.repeat(32)}.tmp`,
    );
    return {
      destination: path.join(controlDirectory, name),
      sourceBinding,
      temporary,
      tombstone: path.join(
        controlRoot,
        `.${path.basename(temporary)}.cleanup.${'0'.repeat(64)}.tombstone`,
      ),
    };
  });
  try {
    encodeProductionImportLocalChildRecovery(createProductionImportLocalChildRecovery(
      { controlDirectory, publicationResidues },
      {
        authorityToken: '0'.repeat(64),
        commandSha256: '0'.repeat(64),
        holdToken: '0'.repeat(64),
      },
    ));
  } catch (cause) {
    throw new Error('Production import POSIX controller exceeds its durable retention bound', {
      cause,
    });
  }
}

export function assertProductionImportWindowsControllerRetentionBound(controlRoot, controlKey) {
  const controller = windowsControllerAuthority(controlRoot, controlKey);
  try {
    encodeProductionImportLocalChildRecovery(createProductionImportLocalChildRecovery(
      controller,
      {
        authorityToken: '0'.repeat(64),
        commandSha256: '0'.repeat(64),
        holdToken: '0'.repeat(64),
      },
    ));
  } catch (cause) {
    throw new Error('Production import Windows controller exceeds its durable retention bound', {
      cause,
    });
  }
}

export function encodeProductionImportLocalChildRecovery(authority) {
  const normalized = normalizeProductionImportLocalChildRecovery(authority);
  const json = JSON.stringify(normalized);
  if (Buffer.byteLength(json, 'utf8') > MAX_AUTHORITY_BYTES) {
    throw new Error('Production import local-child recovery authority is too large');
  }
  return Buffer.from(json, 'utf8').toString('base64url');
}

export function decodeProductionImportLocalChildRecovery(encoded) {
  if (typeof encoded !== 'string' || !encoded || encoded.length > MAX_AUTHORITY_BYTES * 2
      || !BASE64URL.test(encoded)) {
    throw new Error('Production import local-child recovery encoding is invalid');
  }
  const bytes = Buffer.from(encoded, 'base64url');
  if (bytes.toString('base64url') !== encoded || bytes.length > MAX_AUTHORITY_BYTES) {
    throw new Error('Production import local-child recovery encoding is invalid');
  }
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error('Production import local-child recovery encoding is invalid');
  }
  const normalized = normalizeProductionImportLocalChildRecovery(parsed);
  if (encodeProductionImportLocalChildRecovery(normalized) !== encoded) {
    throw new Error('Production import local-child recovery encoding is not canonical');
  }
  return normalized;
}
