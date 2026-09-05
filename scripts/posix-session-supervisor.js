import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const POSIX_SESSION_PROTOCOL = 'easyboost-posix-session-v1';
export const POSIX_SESSION_CONTROL_PROTOCOL = 'easyboost-posix-session-control-v2';
export const POSIX_SESSION_PROOF_PROTOCOL = 'easyboost-posix-session-settled-v1';
export const POSIX_SESSION_WRITER_EGRESS_PROTOCOL = 'easyboost-posix-session-writer-egress-v1';
export const POSIX_SESSION_WRITER_EGRESS_FD = 3;
export const POSIX_SESSION_WRITER_EGRESS_MAX_BYTES = 4_096;
export const STAGING_QUIESCENT_MAINTENANCE_DESCRIPTOR = 8;
export const STAGING_QUIESCENT_MAINTENANCE_PROTOCOL =
  'easyboost-staging-quiescent-maintenance-v1';

const CONTROL_ENVIRONMENT = 'EASYBOOST_POSIX_SESSION_CONTROL';
const STAGING_QUIESCENT_MAINTENANCE_ENVIRONMENT =
  'EASYBOOST_STAGING_QUIESCENT_MAINTENANCE';
const POSIX_RELEASE_MAINTENANCE_ENVIRONMENT =
  'EASYBOOST_POSIX_RELEASE_MAINTENANCE_SCOPE';
const STAGING_NODE_AUTHORITY_ENVIRONMENT = 'EASYBOOST_STAGING_NODE_AUTHORITY';
const STAGING_NODE_COMMAND_ENVIRONMENT = 'EASYBOOST_STAGING_NODE_COMMAND';
const STAGING_NODE_CHAIN_ENVIRONMENT = 'EASYBOOST_STAGING_NODE_CHAIN_AUTHORITY';
const STAGING_NODE_AUTHORITY_PROTOCOL = 'easyboost-staging-node-authority-v1';
const STAGING_NODE_CHAIN_PROTOCOL = 'easyboost-staging-node-chain-v1';
const STAGING_NODE_AUTHORITY_DESCRIPTOR = 9;
const STAGING_NODE_AUTHORITY_MAX_BYTES = 512 * 1024 * 1024;
const STAGING_NODE_ANCESTOR_MAX_DEPTH = 64;
const SUPERVISOR_FILE = fileURLToPath(import.meta.url);
const SUPERVISOR_DIRECTORY = path.dirname(SUPERVISOR_FILE);
const POSIX_RENAME_NOREPLACE_INTERPRETER = '/usr/bin/python3';
// Node does not expose renameat2(2). This isolated bridge invokes the kernel
// operation directly with RENAME_NOREPLACE; it never falls back to the
// lstat+rename sequence used by older mv implementations. Any unavailable
// syscall, unsupported filesystem or cross-device boundary returns nonzero and
// leaves both pathnames for typed recovery.
const POSIX_RENAME_NOREPLACE_PROGRAM = [
  'import ctypes, sys',
  'if len(sys.argv) != 3: raise SystemExit(64)',
  'libc = ctypes.CDLL(None, use_errno=True)',
  'renameat2 = getattr(libc, "renameat2", None)',
  'if renameat2 is None: raise SystemExit(69)',
  'renameat2.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]',
  'renameat2.restype = ctypes.c_int',
  'source = sys.argv[1].encode(sys.getfilesystemencoding(), "surrogateescape")',
  'destination = sys.argv[2].encode(sys.getfilesystemencoding(), "surrogateescape")',
  'if renameat2(-100, source, -100, destination, 1) != 0: raise SystemExit(73)',
].join('\n');
const POLL_MILLISECONDS = 20;
const TOKEN = /^[0-9a-f]{64}$/u;
const START_TIME = /^\d+$/u;
const POSIX_SESSION_RECOVERY_HANDOFF_PROTOCOL =
  'easyboost-posix-session-recovery-handoff-v1';
const POSIX_SESSION_RECOVERY_CLAIM_MAX_BYTES = 4_096;
const POSIX_SESSION_RECOVERY_BATON_MAX_LINKS = 32;
// Runtime cleanup never pathname-deletes retained evidence: only an offline,
// quiescent owner-maintenance pass (with every release supervisor stopped) may
// remove it. These high finite ceilings keep that safe terminal policy from
// turning an operational control root into unbounded storage.
const POSIX_SESSION_TOMBSTONE_MAX_COUNT = 1_024;
const POSIX_SESSION_TOMBSTONE_MAX_BYTES = 256 * 1024 * 1024;
const POSIX_SESSION_TOMBSTONE_MAX_ENTRIES = 32_768;
const POSIX_SESSION_TOMBSTONE_PUBLICATION_WAIT_MS = 250;
const POSIX_SESSION_TOMBSTONE_PUBLICATION_POLL_MS = 2;
const POSIX_SESSION_TOMBSTONE_PUBLICATION_WAIT = new Int32Array(new SharedArrayBuffer(4));
const POSIX_SESSION_RETAINED_SOURCE_NAME = 'retained-source';
const POSIX_SESSION_TOMBSTONE_SLOT_TOKENS = Object.freeze(Array.from(
  { length: POSIX_SESSION_TOMBSTONE_MAX_COUNT },
  (_, index) => createHash('sha256')
    .update(`easyboost-staging-quarantine-slot-v1\0${index}`, 'utf8').digest('hex'),
));
const POSIX_SESSION_TOMBSTONE_SLOT_TOKEN_SET = new Set(
  POSIX_SESSION_TOMBSTONE_SLOT_TOKENS,
);
const RECOVERY_PROOFS = new WeakMap();
const POSIX_PUBLICATION_SOURCE_BINDING_KEYS = Object.freeze([
  'birthtimeNs', 'bytes', 'ctimeNs', 'dev', 'gid', 'ino', 'mode', 'sha256', 'uid',
]);
const UNSIGNED_DECIMAL = /^(?:0|[1-9]\d*)$/u;

function canonicalJson(value) {
  return `${JSON.stringify(value)}\n`;
}

function writerDestinationPaths(specification) {
  const names = [
    'startupClaimPath', 'readyPath', 'statusPath', 'termAckPath',
    'killAckPath', 'killArmedPath', 'proofPath',
  ];
  if (!specification || typeof specification !== 'object' || Array.isArray(specification)
      || typeof specification.controlDirectory !== 'string'
      || !path.isAbsolute(specification.controlDirectory)
      || !TOKEN.test(specification.proofToken ?? '')) {
    throw new Error('POSIX session writer egress specification is invalid');
  }
  const destinations = new Set();
  for (const name of names) {
    const destination = specification[name];
    if (typeof destination !== 'string' || !path.isAbsolute(destination)
        || path.resolve(destination) !== destination
        || path.dirname(destination) !== specification.controlDirectory) {
      throw new Error('POSIX session writer egress destination specification is invalid');
    }
    destinations.add(destination);
  }
  if (destinations.size !== names.length) {
    throw new Error('POSIX session writer egress destinations are not unique');
  }
  return destinations;
}

function exactPosixPublicationSourceBinding(binding) {
  if (!binding || typeof binding !== 'object' || Array.isArray(binding)
      || JSON.stringify(Object.keys(binding).sort())
        !== JSON.stringify(POSIX_PUBLICATION_SOURCE_BINDING_KEYS)
      || !Number.isSafeInteger(binding.bytes) || binding.bytes < 0 || binding.bytes > 65_536
      || !TOKEN.test(binding.sha256 ?? '')
      || POSIX_PUBLICATION_SOURCE_BINDING_KEYS
        .filter((key) => !['bytes', 'sha256'].includes(key))
        .some((key) => !UNSIGNED_DECIMAL.test(binding[key] ?? ''))) {
    throw new Error('POSIX session publication source binding is invalid');
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

function exactPosixSessionPublicationAuthority(authority, specification, destinations) {
  const keys = authority && Object.keys(authority).sort();
  if (!authority || typeof authority !== 'object' || Array.isArray(authority)
      || (JSON.stringify(keys)
          !== JSON.stringify(['destination', 'sourceBinding', 'temporary'])
        && JSON.stringify(keys)
          !== JSON.stringify(['destination', 'sourceBinding', 'temporary', 'tombstone']))) {
    throw new Error('POSIX session writer recovery authority is not exact');
  }
  const destination = authority.destination;
  const sourceBinding = exactPosixPublicationSourceBinding(authority.sourceBinding);
  const temporary = authority.temporary;
  const tombstone = authority.tombstone;
  if (typeof destination !== 'string' || path.resolve(destination) !== destination
      || !destinations.has(destination)
      || typeof temporary !== 'string' || path.resolve(temporary) !== temporary) {
    throw new Error('POSIX session writer recovery authority paths are invalid');
  }
  const root = path.dirname(specification.controlDirectory);
  const temporaryPrefix = `.${path.basename(specification.controlDirectory)}.${path.basename(destination)}.`;
  const temporaryName = path.basename(temporary);
  if (path.dirname(temporary) !== root || !temporaryName.startsWith(temporaryPrefix)
      || !/^[0-9a-f]{32}\.tmp$/u.test(temporaryName.slice(temporaryPrefix.length))) {
    throw new Error('POSIX session writer recovery temporary authority is invalid');
  }
  if (tombstone !== undefined) {
    if (typeof tombstone !== 'string' || path.resolve(tombstone) !== tombstone) {
      throw new Error('POSIX session writer recovery tombstone authority is invalid');
    }
    const tombstonePrefix = `.${temporaryName}.cleanup.`;
    const tombstoneName = path.basename(tombstone);
    if (path.dirname(tombstone) !== root || !tombstoneName.startsWith(tombstonePrefix)
        || !tombstoneName.endsWith('.tombstone')
        || !/^[0-9a-f]{64}$/u.test(tombstoneName.slice(
          tombstonePrefix.length, -'.tombstone'.length,
        ))) {
      throw new Error('POSIX session writer recovery tombstone authority is invalid');
    }
  }
  return Object.freeze({
    destination,
    sourceBinding,
    temporary,
    ...(tombstone === undefined ? {} : { tombstone }),
  });
}

function exactPosixSessionWriterAuthority(authority, specification) {
  return exactPosixSessionPublicationAuthority(
    authority,
    specification,
    writerDestinationPaths(specification),
  );
}

function controllerPublicationDestinationPaths(specification) {
  const destinations = writerDestinationPaths(specification);
  for (const name of [
    'controlFile', 'termRequestPath', 'killRequestPath', 'retirementClaimPath',
  ]) {
    const destination = specification[name];
    if (typeof destination !== 'string' || path.resolve(destination) !== destination
        || path.dirname(destination) !== specification.controlDirectory
        || destinations.has(destination)) {
      throw new Error('POSIX session controller publication destination is invalid');
    }
    destinations.add(destination);
  }
  return destinations;
}

// Recovery markers do not retain the private proof token, but they do retain the
// deterministic control directory. Rebuild only the pathname portion of the
// writer specification and reuse the same exact authority validator that
// authenticates fd3 frames. This keeps persisted authority on the existing
// writer-egress protocol instead of introducing a second, weaker path codec.
export function normalizePosixSessionPublicationResidue(authority, controlDirectory) {
  if (typeof controlDirectory !== 'string' || !path.isAbsolute(controlDirectory)
      || path.resolve(controlDirectory) !== controlDirectory) {
    throw new Error('POSIX session publication residue control directory is invalid');
  }
  const paths = controlPaths(controlDirectory);
  const specification = {
    controlFile: paths.controlFile,
    controlDirectory,
    killAckPath: paths.killAckPath,
    killArmedPath: paths.killArmedPath,
    proofPath: paths.proofPath,
    proofToken: '0'.repeat(64),
    readyPath: paths.readyPath,
    startupClaimPath: paths.startupClaimPath,
    statusPath: paths.statusPath,
    termAckPath: paths.termAckPath,
    termRequestPath: paths.termRequestPath,
    killRequestPath: paths.killRequestPath,
    retirementClaimPath: posixRetirementClaimPath(controlDirectory),
  };
  return exactPosixSessionPublicationAuthority(
    authority,
    specification,
    controllerPublicationDestinationPaths(specification),
  );
}

export function normalizePosixSessionPublicationResidues(authorities, controlDirectory) {
  if (!Array.isArray(authorities) || authorities.length < 1 || authorities.length > 9) {
    throw new Error('POSIX session publication residue list is invalid');
  }
  const normalized = [];
  const seen = new Set();
  for (const authority of authorities) {
    const residue = normalizePosixSessionPublicationResidue(authority, controlDirectory);
    const key = JSON.stringify(residue);
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(residue);
  }
  if (normalized.length < 1) {
    throw new Error('POSIX session publication residue list is empty');
  }
  return Object.freeze(normalized);
}

export function encodePosixSessionWriterRecovery(authority, specification) {
  const exact = exactPosixSessionWriterAuthority(authority, specification);
  const frame = Buffer.from(canonicalJson({
    authority: exact,
    event: 'WRITER_RECOVERY_REQUIRED',
    protocol: POSIX_SESSION_WRITER_EGRESS_PROTOCOL,
    token: specification.proofToken,
  }), 'utf8');
  if (frame.length > POSIX_SESSION_WRITER_EGRESS_MAX_BYTES) {
    throw new Error('POSIX session writer recovery frame exceeds its byte bound');
  }
  return frame;
}

function assertPosixSessionWriterEgressBound(specification) {
  const root = path.dirname(specification.controlDirectory);
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
  for (const destination of writerDestinationPaths(specification)) {
    const temporary = path.join(root,
      `.${path.basename(specification.controlDirectory)}.${path.basename(destination)}.${'0'.repeat(32)}.tmp`);
    const tombstone = path.join(root,
      `.${path.basename(temporary)}.cleanup.${'0'.repeat(64)}.tombstone`);
    encodePosixSessionWriterRecovery({
      destination, sourceBinding, temporary, tombstone,
    }, specification);
  }
}

function parsePosixSessionWriterRecovery(frame, specification) {
  let record;
  try {
    record = JSON.parse(frame.subarray(0, -1).toString('utf8'));
  } catch (cause) {
    throw new Error('POSIX session writer recovery frame is not JSON', { cause });
  }
  if (!record || typeof record !== 'object' || Array.isArray(record)
      || JSON.stringify(Object.keys(record).sort())
        !== JSON.stringify(['authority', 'event', 'protocol', 'token'])
      || record.event !== 'WRITER_RECOVERY_REQUIRED'
      || record.protocol !== POSIX_SESSION_WRITER_EGRESS_PROTOCOL
      || record.token !== specification.proofToken) {
    throw new Error('POSIX session writer recovery frame contract is invalid');
  }
  const authority = exactPosixSessionWriterAuthority(record.authority, specification);
  const canonical = encodePosixSessionWriterRecovery(authority, specification);
  if (!canonical.equals(frame)) {
    throw new Error('POSIX session writer recovery frame is not canonical');
  }
  return authority;
}

export function createPosixSessionWriterEgress(specification, {
  descriptor = POSIX_SESSION_WRITER_EGRESS_FD,
  writeFrame = (fd, frame) => fs.writeSync(fd, frame, 0, frame.length, null),
} = {}) {
  if (!Number.isSafeInteger(descriptor) || descriptor < 3 || typeof writeFrame !== 'function') {
    throw new Error('POSIX session writer egress configuration is invalid');
  }
  writerDestinationPaths(specification);
  let attempted = false;
  return Object.freeze({
    get attempted() { return attempted; },
    report(authority) {
      if (attempted) return false;
      attempted = true;
      const frame = encodePosixSessionWriterRecovery(authority, specification);
      const written = writeFrame(descriptor, frame);
      if (written !== frame.length) {
        throw new Error('POSIX session writer recovery frame write was incomplete');
      }
      return true;
    },
  });
}

export function observePosixSessionWriterEgress(stream, specification, {
  maximumBytes = POSIX_SESSION_WRITER_EGRESS_MAX_BYTES,
  onAuthority = () => {},
  onEnd = () => {},
  onProtocolFailure = () => {},
} = {}) {
  if (!stream || typeof stream.on !== 'function' || typeof stream.off !== 'function'
      || !Number.isSafeInteger(maximumBytes) || maximumBytes < 1
      || maximumBytes > POSIX_SESSION_WRITER_EGRESS_MAX_BYTES
      || ![onAuthority, onEnd, onProtocolFailure].every((callback) => typeof callback === 'function')) {
    throw new Error('POSIX session writer egress observer configuration is invalid');
  }
  writerDestinationPaths(specification);
  let bytes = Buffer.alloc(0);
  let cancelled = false;
  let ended = false;
  let failure = null;
  let parsedAuthority = null;

  const detach = () => {
    stream.off('data', onData);
    stream.off('end', onStreamEnd);
    stream.off('error', onStreamError);
    stream.off('close', onStreamClose);
  };
  const notifyFailure = (error) => {
    if (failure !== null) return;
    failure = error instanceof Error ? error : new Error(String(error));
    try { onProtocolFailure(failure); } catch {}
  };
  const finish = () => {
    if (cancelled || ended) return;
    ended = true;
    detach();
    try {
      onEnd(Object.freeze({
        authority: parsedAuthority,
        error: failure,
        state: failure ? 'error' : parsedAuthority ? 'authority' : 'empty',
      }));
    } catch {}
  };
  const parseFirstFrame = () => {
    const newline = bytes.indexOf(0x0a);
    if (newline < 0 || parsedAuthority !== null || failure !== null) return;
    const frame = bytes.subarray(0, newline + 1);
    try {
      parsedAuthority = parsePosixSessionWriterRecovery(frame, specification);
      try { onAuthority(parsedAuthority); } catch (cause) {
        notifyFailure(new Error('POSIX session writer recovery authority callback failed', { cause }));
      }
    } catch (error) {
      notifyFailure(error);
    }
    if (newline + 1 !== bytes.length) {
      notifyFailure(new Error('POSIX session writer egress contains bytes after its sole frame'));
    }
  };
  function onData(value) {
    if (cancelled || ended || failure !== null) return;
    const chunk = Buffer.from(value);
    if (chunk.length > maximumBytes - bytes.length) {
      notifyFailure(new Error('POSIX session writer egress exceeds its byte bound'));
      return;
    }
    bytes = Buffer.concat([bytes, chunk], bytes.length + chunk.length);
    if (parsedAuthority !== null) {
      notifyFailure(new Error('POSIX session writer egress contains more than one frame'));
      return;
    }
    parseFirstFrame();
  }
  function onStreamEnd() {
    if (cancelled || ended) return;
    if (failure === null && bytes.length > 0 && parsedAuthority === null) {
      notifyFailure(new Error('POSIX session writer egress ended with a partial frame'));
    }
    finish();
  }
  function onStreamError(error) {
    if (cancelled || ended) return;
    notifyFailure(new Error('POSIX session writer egress stream failed', { cause: error }));
    finish();
  }
  function onStreamClose() {
    if (cancelled || ended) return;
    notifyFailure(new Error('POSIX session writer egress closed before EOF'));
    finish();
  }
  stream.on('data', onData);
  stream.on('end', onStreamEnd);
  stream.on('error', onStreamError);
  stream.on('close', onStreamClose);
  return Object.freeze({
    cancel() {
      if (cancelled || ended) return false;
      cancelled = true;
      detach();
      return true;
    },
  });
}

function syncDirectory(directory) {
  if (process.platform === 'win32' && process.env.NODE_TEST_CONTEXT) return;
  const descriptor = fs.openSync(directory, 'r');
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function sameFileIdentity(left, right) {
  return String(left.dev) === String(right.dev) && String(left.ino) === String(right.ino);
}

function hashOpenRegularFile(descriptor, identity, label) {
  if (!identity.isFile() || identity.isSymbolicLink?.() || identity.nlink !== 1
      || !Number.isSafeInteger(identity.size) || identity.size < 1
      || identity.size > STAGING_NODE_AUTHORITY_MAX_BYTES
      || (process.platform !== 'win32' && ((identity.mode & 0o111) === 0
        || (identity.mode & 0o022) !== 0
        || identity.uid !== process.getuid()))) {
    throw new Error(`${label} is not a private trusted executable`);
  }
  const digest = createHash('sha256');
  const chunk = Buffer.allocUnsafe(1024 * 1024);
  let position = 0;
  while (position < identity.size) {
    const length = fs.readSync(
      descriptor, chunk, 0, Math.min(chunk.length, identity.size - position), position,
    );
    if (length < 1) throw new Error(`${label} ended before its authenticated size`);
    digest.update(chunk.subarray(0, length));
    position += length;
  }
  const after = fs.fstatSync(descriptor);
  if (!sameFileIdentity(identity, after) || after.size !== identity.size || after.nlink !== 1) {
    throw new Error(`${label} changed during digest capture`);
  }
  return digest.digest('hex');
}

function parseStagingNodeAuthority(value) {
  const match = new RegExp(
    `^${STAGING_NODE_AUTHORITY_PROTOCOL}:${STAGING_NODE_AUTHORITY_DESCRIPTOR}:([1-9][0-9]*):([a-f0-9]{64})$`,
    'u',
  ).exec(value ?? '');
  const ownerPid = Number(match?.[1]);
  if (!match || !Number.isSafeInteger(ownerPid) || ownerPid < 2) {
    throw new Error('staging Node descriptor authority metadata is invalid');
  }
  return Object.freeze({ digest: match[2], ownerPid, raw: value });
}

function parseStagingNodeChain(value) {
  const match = new RegExp(
    `^${STAGING_NODE_CHAIN_PROTOCOL}:([1-9][0-9]*):(0|[1-9][0-9]*):([a-f0-9]{64})$`,
    'u',
  ).exec(value ?? '');
  const ownerPid = Number(match?.[1]);
  if (!match || !Number.isSafeInteger(ownerPid) || ownerPid < 2) {
    throw new Error('staging Node chain authority metadata is invalid');
  }
  return Object.freeze({
    digest: match[3], ownerPid, ownerStartTime: match[2], value,
  });
}

function readLinuxParentIdentity(processId) {
  const value = fs.readFileSync(`/proc/${processId}/stat`, 'utf8');
  const commandEnd = value.lastIndexOf(')');
  if (commandEnd < 1) throw new Error(`Invalid /proc ancestry stat for process ${processId}`);
  const fields = value.slice(commandEnd + 2).trim().split(/\s+/u);
  const parsedProcessId = Number(value.slice(0, value.indexOf(' ')));
  const parentProcessId = Number(fields[1]);
  const startTime = fields[19];
  if (parsedProcessId !== processId || !Number.isSafeInteger(parentProcessId)
      || parentProcessId < 0 || !START_TIME.test(startTime ?? '')) {
    throw new Error(`Invalid /proc ancestry identity for process ${processId}`);
  }
  return Object.freeze({ parentProcessId, processId, startTime });
}

function proveLiveStagingNodeAncestor(ownerPid, ownerStartTime) {
  if (process.platform !== 'linux') {
    throw new Error('staging Node chain authority requires Linux /proc');
  }
  let candidate = process.pid;
  for (let depth = 0; depth < STAGING_NODE_ANCESTOR_MAX_DEPTH; depth += 1) {
    const identity = readLinuxParentIdentity(candidate);
    if (identity.processId === ownerPid) {
      const procIdentity = fs.statSync(`/proc/${ownerPid}`);
      if (identity.startTime !== ownerStartTime || procIdentity.uid !== process.getuid()) {
        throw new Error('staging Node chain owner identity changed');
      }
      return true;
    }
    if (identity.parentProcessId < 2 || identity.parentProcessId === identity.processId) break;
    candidate = identity.parentProcessId;
  }
  throw new Error('staging Node chain owner is not a live bounded ancestor');
}

function capturedStagingNodeExecutable({ command, digest, ownerPid, ownerStartTime, source }) {
  const descriptor = fs.openSync(command, fs.constants.O_RDONLY);
  try {
    const identity = fs.fstatSync(descriptor);
    if (hashOpenRegularFile(descriptor, identity,
      'staging Node chain executable') !== digest) {
      throw new Error('staging Node chain executable digest is invalid');
    }
    return Object.freeze({
      chain: `${STAGING_NODE_CHAIN_PROTOCOL}:${ownerPid}:${ownerStartTime}:${digest}`,
      command,
      digest,
      identity: Object.freeze({
        dev: String(identity.dev), ino: String(identity.ino), size: identity.size,
      }),
      ownerPid,
      ownerStartTime,
      source,
    });
  } finally {
    fs.closeSync(descriptor);
  }
}

function captureStagingNodeAuthority(environment, parentIdentity) {
  const raw = environment?.[STAGING_NODE_AUTHORITY_ENVIRONMENT];
  const commandHint = environment?.[STAGING_NODE_COMMAND_ENVIRONMENT];
  const chainValue = environment?.[STAGING_NODE_CHAIN_ENVIRONMENT];
  if (raw === undefined && commandHint === undefined && chainValue === undefined) return null;
  if (process.platform !== 'linux') {
    throw new Error('staging Node descriptor authority requires Linux /proc');
  }
  if (raw !== undefined) {
    if (commandHint !== undefined || chainValue !== undefined) {
      throw new Error('staging Node descriptor authority inputs are ambiguous');
    }
    const metadata = parseStagingNodeAuthority(raw);
    if (metadata.ownerPid !== process.pid || parentIdentity?.processId !== process.pid) {
      throw new Error('staging Node descriptor authority owner is invalid');
    }
    const descriptorIdentity = fs.fstatSync(STAGING_NODE_AUTHORITY_DESCRIPTOR);
    const command = `/proc/${metadata.ownerPid}/fd/${STAGING_NODE_AUTHORITY_DESCRIPTOR}`;
    const pathIdentity = fs.statSync(command);
    if (!sameFileIdentity(descriptorIdentity, pathIdentity)
        || pathIdentity.size !== descriptorIdentity.size || pathIdentity.nlink !== 1) {
      throw new Error('staging Node descriptor authority path changed during capture');
    }
    const digest = hashOpenRegularFile(
      STAGING_NODE_AUTHORITY_DESCRIPTOR, descriptorIdentity, 'staging Node descriptor authority',
    );
    if (digest !== metadata.digest) {
      throw new Error('staging Node descriptor authority digest is invalid');
    }
    return capturedStagingNodeExecutable({
      command,
      digest,
      ownerPid: metadata.ownerPid,
      ownerStartTime: parentIdentity.startTime,
      source: 'descriptor',
    });
  }
  if (typeof commandHint !== 'string' || chainValue === undefined) {
    throw new Error('staging Node chain authority inputs are incomplete');
  }
  const chain = parseStagingNodeChain(chainValue);
  if (commandHint !== `/proc/${chain.ownerPid}/fd/${STAGING_NODE_AUTHORITY_DESCRIPTOR}`) {
    throw new Error('staging Node chain command is invalid');
  }
  if (chain.ownerPid === process.pid) {
    throw new Error('staging Node chain owner must be an earlier live ancestor');
  }
  proveLiveStagingNodeAncestor(chain.ownerPid, chain.ownerStartTime);
  return capturedStagingNodeExecutable({
    command: commandHint,
    digest: chain.digest,
    ownerPid: chain.ownerPid,
    ownerStartTime: chain.ownerStartTime,
    source: 'chain',
  });
}

function validateInheritedStagingNodeAuthority(authority, parentIdentity) {
  if (authority === null) {
    if ([STAGING_NODE_AUTHORITY_ENVIRONMENT, STAGING_NODE_COMMAND_ENVIRONMENT,
      STAGING_NODE_CHAIN_ENVIRONMENT].some((name) => process.env[name] !== undefined)) {
      throw new Error('unexpected staging Node authority environment');
    }
    return null;
  }
  if (!authority || typeof authority !== 'object' || Array.isArray(authority)
      || JSON.stringify(Object.keys(authority).sort())
        !== JSON.stringify([
          'chain', 'command', 'digest', 'identity', 'ownerPid', 'ownerStartTime', 'source',
        ])
      || authority.command !== `/proc/${authority.ownerPid}/fd/${STAGING_NODE_AUTHORITY_DESCRIPTOR}`
      || authority.chain !== `${STAGING_NODE_CHAIN_PROTOCOL}:${authority.ownerPid}:${authority.ownerStartTime}:${authority.digest}`
      || !TOKEN.test(authority.digest ?? '') || !START_TIME.test(authority.ownerStartTime ?? '')
      || !['chain', 'descriptor'].includes(authority.source)
      || !authority.identity || JSON.stringify(Object.keys(authority.identity).sort())
        !== JSON.stringify(['dev', 'ino', 'size'])
      || !Number.isSafeInteger(authority.identity.size) || !parentIdentityAlive(parentIdentity)) {
    throw new Error('inherited staging Node descriptor authority is invalid');
  }
  if (authority.source === 'descriptor') {
    const metadata = parseStagingNodeAuthority(
      process.env[STAGING_NODE_AUTHORITY_ENVIRONMENT],
    );
    if (metadata.digest !== authority.digest || metadata.ownerPid !== authority.ownerPid
        || authority.ownerPid !== parentIdentity?.processId
        || process.env[STAGING_NODE_COMMAND_ENVIRONMENT] !== undefined
        || process.env[STAGING_NODE_CHAIN_ENVIRONMENT] !== undefined) {
      throw new Error('inherited staging Node descriptor authority metadata changed');
    }
  } else if (process.env[STAGING_NODE_AUTHORITY_ENVIRONMENT] !== undefined
      || process.env[STAGING_NODE_COMMAND_ENVIRONMENT] !== authority.command
      || process.env[STAGING_NODE_CHAIN_ENVIRONMENT] !== authority.chain) {
    throw new Error('inherited staging Node chain authority metadata changed');
  }
  proveLiveStagingNodeAncestor(authority.ownerPid, authority.ownerStartTime);
  const descriptor = fs.openSync(authority.command, fs.constants.O_RDONLY);
  try {
    const identity = fs.fstatSync(descriptor);
    if (String(identity.dev) !== authority.identity.dev
        || String(identity.ino) !== authority.identity.ino
        || identity.size !== authority.identity.size
        || hashOpenRegularFile(descriptor, identity,
          'inherited staging Node descriptor authority') !== authority.digest) {
      throw new Error('inherited staging Node descriptor authority changed');
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return Object.freeze({ chain: authority.chain, command: authority.command });
}

function combinedPublicationError(primary, secondary, message) {
  if (!secondary) return primary;
  const aggregate = new AggregateError([primary, secondary], message, { cause: primary });
  if (primary?.code) aggregate.code = primary.code;
  return aggregate;
}

function provePathsAbsent(filesystem, paths) {
  for (const entry of paths) {
    try {
      filesystem.lstatSync(entry);
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    throw new Error(`POSIX session durable publication path still exists: ${entry}`);
  }
}

// Once the isolated wrapper has spawned a mutating target it must never leave
// that target behind merely because its own polling or proof I/O failed. Fatal
// containment deliberately stops relying on those failed inputs: TERM is sent
// immediately and group 0 is then SIGKILLed after the bounded grace period.
// The retry keeps the wrapper alive if kill(2) itself reports a transient error;
// on a real successful SIGKILL the wrapper is part of group 0 and cannot return.
export function createFatalPosixSessionContainment({
  armKill,
  requestTerm,
  retryMilliseconds = POLL_MILLISECONDS,
  schedule = setTimeout,
  settlementMilliseconds,
  signalOwnGroup,
} = {}) {
  if (![armKill, requestTerm, schedule, signalOwnGroup].every((value) => typeof value === 'function')
      || !Number.isSafeInteger(settlementMilliseconds) || settlementMilliseconds < 1
      || !Number.isSafeInteger(retryMilliseconds) || retryMilliseconds < 1) {
    throw new Error('POSIX fatal containment configuration is invalid');
  }
  let active = false;
  let failure = null;
  const addFailure = (error, message) => {
    if (!error) return;
    failure = failure
      ? new AggregateError([failure, error], message, { cause: failure })
      : error;
  };
  const killOwnedGroup = () => {
    try {
      armKill('supervisor-failure');
    } catch (error) {
      addFailure(error, 'POSIX fatal containment could not publish its kill proof');
    }
    try {
      signalOwnGroup('SIGKILL');
    } catch (error) {
      addFailure(error, 'POSIX fatal containment could not signal its owned group');
    }
    // A successful group-0 SIGKILL terminates this wrapper. Reaching this line
    // is therefore either a test seam or a delivery race/failure; retain control
    // and retry instead of resolving/rejecting and abandoning descendants.
    schedule(killOwnedGroup, retryMilliseconds);
  };
  return Object.freeze({
    activate(error) {
      addFailure(error, 'POSIX session supervisor encountered multiple fatal failures');
      if (active) return false;
      active = true;
      try {
        requestTerm('supervisor-failure');
      } catch (termError) {
        addFailure(termError, 'POSIX fatal containment could not signal TERM');
      }
      schedule(killOwnedGroup, settlementMilliseconds);
      return true;
    },
    get active() { return active; },
    get failure() { return failure; },
  });
}

// The private inode lives beside the deterministic control directory, so a crash
// can never leave a partial JSON file inside the authenticated namespace. The
// final pathname becomes visible only after complete bytes and their inode are
// fsynced. renameat2(RENAME_NOREPLACE) moves one pathname atomically: unlike the
// old hard-link-then-unlink sequence, there is no later pathname deletion that
// could remove a replacement installed after an identity check.
export function writeDurablePosixSessionRecord(file, value, {
  filesystem = fs,
  platform = process.platform,
  randomToken = () => randomBytes(16).toString('hex'),
  runNoReplaceMove = spawnSync,
  synchronizeDirectory = syncDirectory,
} = {}) {
  const destination = path.resolve(file);
  const destinationDirectory = path.dirname(destination);
  const temporaryDirectory = path.dirname(destinationDirectory);
  const temporary = path.join(temporaryDirectory,
    `.${path.basename(destinationDirectory)}.${path.basename(destination)}.${randomToken()}.tmp`);
  let descriptor;
  let primaryError;
  let originalSource;
  let temporaryCreated = false;
  try {
    descriptor = filesystem.openSync(temporary, 'wx', 0o600);
    temporaryCreated = true;
    filesystem.writeFileSync(descriptor, value, 'utf8');
    filesystem.fsyncSync(descriptor);
  } catch (error) {
    primaryError = error;
  }
  if (descriptor !== undefined) {
    try { filesystem.closeSync(descriptor); } catch (error) { primaryError ??= error; }
  }
  if (!primaryError) {
    try {
      originalSource = capturePosixPublicationSourceBinding(temporary, { filesystem });
      const published = movePosixEntryNoReplace(temporary, destination, {
        filesystem,
        platform,
        runMove: runNoReplaceMove,
      });
      if (!sameFileIdentity(originalSource.identity, published)) {
        throw new Error('POSIX session durable publication moved a substituted source');
      }
      synchronizeDirectory(destinationDirectory);
      synchronizeDirectory(temporaryDirectory);
      const final = capturePosixPublicationSourceBinding(destination, { filesystem });
      if (!sameFileIdentity(originalSource.identity, final.identity)
          || !samePosixPublicationStableSourceBinding(originalSource, final)) {
        throw new Error('POSIX session durable publication identity changed before completion');
      }
      try {
        filesystem.lstatSync(temporary);
        throw new Error('POSIX session durable publication source remained after handoff');
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    } catch (error) {
      primaryError = error;
    }
  }
  if (primaryError) {
    const failure = new Error(
      `POSIX session durable publication failed: ${primaryError.message}`,
      { cause: primaryError },
    );
    failure.code = 'POSIX_SESSION_PUBLICATION_CLEANUP_REQUIRED';
    if (temporaryCreated) {
      let sourceBinding = originalSource?.sourceBinding;
      if (sourceBinding === undefined) {
        try {
          sourceBinding = capturePosixPublicationSourceBinding(temporary, { filesystem })
            .sourceBinding;
        } catch {}
      }
      if (sourceBinding !== undefined) {
        failure.recoveryAuthority = Object.freeze({
          destination,
          sourceBinding,
          temporary,
        });
      }
    }
    throw failure;
  }
}

const durableExclusiveWrite = writeDurablePosixSessionRecord;

function proveCompletedPosixPublicationReclaim({
  correlation,
  destination,
  directory,
  quiescentMaintenanceAuthority,
  reclaimRetainedEvidence,
  root,
  sourceBinding,
  synchronizeDirectory,
  temporary,
  tombstone,
}) {
  if (sourceBinding === undefined) return false;
  const configured = quiescentMaintenanceAuthority !== undefined
    || reclaimRetainedEvidence !== undefined;
  if (!configured) return false;
  if (typeof reclaimRetainedEvidence !== 'function'
      || quiescentMaintenanceAuthority === undefined
      || (tombstone !== null && !posixTombstoneSlotName(path.basename(tombstone)))) {
    throw new Error('POSIX session completed publication reclaim configuration is invalid');
  }
  validatePosixQuiescentMaintenanceAuthority(
    quiescentMaintenanceAuthority, { controlRoot: root },
  );
  const rootIdentity = safeOwnedRecoveryDirectory(
    root, 'POSIX session completed publication reclaim root',
  );
  const directoryIdentity = safeOwnedRecoveryDirectory(
    directory, 'POSIX session completed publication reclaim directory',
  );
  const proveLiveQuiescence = () => assertLivePosixQuiescentMaintenance(
    root, quiescentMaintenanceAuthority, reclaimRetainedEvidence,
    'POSIX session completed publication quiescence',
  );
  const exactAbsence = () => {
    if (!posixPathIsAbsent(destination) || !posixPathIsAbsent(temporary)
        || (tombstone !== null && !posixPathIsAbsent(tombstone))) return false;
    return findPosixPublicationResidueTombstone(root, correlation) === null;
  };
  proveLiveQuiescence();
  if (!exactAbsence()) return false;
  synchronizeDirectory(root);
  const synchronizedRoot = safeOwnedRecoveryDirectory(
    root, 'POSIX session completed publication reclaim root',
  );
  const synchronizedDirectory = safeOwnedRecoveryDirectory(
    directory, 'POSIX session completed publication reclaim directory',
  );
  if (!sameFileIdentity(rootIdentity, synchronizedRoot)
      || !sameFileIdentity(directoryIdentity, synchronizedDirectory)
      || !exactAbsence()) {
    throw new Error('POSIX session completed publication reclaim absence is unproven');
  }
  proveLiveQuiescence();
  const finalRoot = safeOwnedRecoveryDirectory(
    root, 'POSIX session completed publication reclaim root',
  );
  const finalDirectory = safeOwnedRecoveryDirectory(
    directory, 'POSIX session completed publication reclaim directory',
  );
  if (!sameFileIdentity(rootIdentity, finalRoot)
      || !sameFileIdentity(directoryIdentity, finalDirectory)
      || !exactAbsence()) {
    throw new Error('POSIX session completed publication reclaim namespace changed');
  }
  return true;
}

// A failed publication can leave its private sibling inode outside the control
// directory.  Cleanup is deliberately an explicit authority operation: callers
// must present the exact destination/temporary pair returned by the writer.
// Replacing either pathname before unlink turns the operation into a typed
// manual-recovery requirement rather than deleting an unproved successor.
export function cleanupPosixSessionPublicationResidue(authority, {
  beforeRetainedSourceMove = () => {},
  beforeUnlink = () => {},
  filesystem = fs,
  quiescentMaintenanceAuthority,
  reclaimRetainedEvidence,
  requireReclaimedPublication = false,
  runNoReplaceMove = spawnSync,
  synchronizeDirectory = syncDirectory,
} = {}) {
  let retainedTombstone;
  let retainedSourceBinding;
  const failure = (cause) => {
    if (retainedTombstone === undefined
        && typeof authority?.destination === 'string'
        && typeof authority?.temporary === 'string') {
      try {
        const destination = path.resolve(authority.destination);
        const temporary = path.resolve(authority.temporary);
        const root = path.dirname(path.dirname(destination));
        const correlated = findPosixPublicationResidueTombstone(
          root, posixPublicationResidueCorrelation(destination, temporary),
        );
        retainedTombstone = correlated?.container;
      } catch {}
    }
    const error = new Error('POSIX session private publication cleanup required', { cause });
    error.code = 'POSIX_SESSION_PUBLICATION_CLEANUP_REQUIRED';
    error.recoveryAuthority = Object.freeze({
      destination: authority?.destination,
      ...(retainedSourceBinding === undefined ? {} : {
        sourceBinding: retainedSourceBinding,
      }),
      temporary: authority?.temporary,
      ...(retainedTombstone === undefined ? {} : { tombstone: retainedTombstone }),
    });
    return error;
  };
  try {
    const keys = authority && Object.keys(authority).sort();
    if (!authority || (JSON.stringify(keys)
          !== JSON.stringify(['destination', 'sourceBinding', 'temporary'])
        && JSON.stringify(keys)
          !== JSON.stringify(['destination', 'sourceBinding', 'temporary', 'tombstone']))) {
      throw new Error('POSIX session publication authority is not exact');
    }
    retainedSourceBinding = authority.sourceBinding === undefined
      ? undefined : exactPosixPublicationSourceBinding(authority.sourceBinding);
    const destination = path.resolve(authority.destination);
    const temporary = path.resolve(authority.temporary);
    let tombstone = authority.tombstone === undefined ? null : path.resolve(authority.tombstone);
    const directory = path.dirname(destination);
    const root = path.dirname(directory);
    const temporaryName = path.basename(temporary);
    const temporaryPrefix = `.${path.basename(directory)}.${path.basename(destination)}.`;
    if (path.dirname(temporary) !== root || !temporaryName.startsWith(temporaryPrefix)
        || !/^[0-9a-f]{32}\.tmp$/u.test(temporaryName.slice(temporaryPrefix.length))) {
      throw new Error('POSIX session publication residue paths are not private siblings');
    }
    safeOwnedRecoveryDirectory(root, 'POSIX session publication root');
    safeOwnedRecoveryDirectory(directory, 'POSIX session publication directory');
    let destinationPresent = true;
    try { filesystem.lstatSync(destination); }
    catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      destinationPresent = false;
    }
    const tombstoneName = tombstone === null ? null : path.basename(tombstone);
    const tombstonePrefix = `.${path.basename(temporary)}.cleanup.`;
    const exactLegacyTombstone = tombstoneName !== null
      && tombstoneName.startsWith(tombstonePrefix) && tombstoneName.endsWith('.tombstone')
      && /^[0-9a-f]{64}$/u.test(tombstoneName.slice(
        tombstonePrefix.length, -'.tombstone'.length,
      ));
    if (tombstone !== null && (path.dirname(tombstone) !== root
        || (!exactLegacyTombstone && !posixTombstoneSlotName(tombstoneName)))) {
      throw new Error('POSIX session publication tombstone is invalid');
    }
    const correlation = posixPublicationResidueCorrelation(destination, temporary);
    let correlatedSlot = null;
    let explicitTombstoneMissing = false;
    if (tombstone === null) {
      correlatedSlot = findPosixPublicationResidueTombstone(root, correlation);
      if (correlatedSlot) {
        tombstone = correlatedSlot.container;
        retainedTombstone = tombstone;
      }
    } else if (posixTombstoneSlotName(path.basename(tombstone))) {
      try {
        const slot = measurePosixTombstoneSlot(tombstone);
        if (slot.record.source !== undefined && slot.record.source !== correlation) {
          throw new Error('POSIX session publication tombstone authority does not match');
        }
        correlatedSlot = Object.freeze({ container: tombstone, ...slot });
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
        explicitTombstoneMissing = true;
      }
    } else if (posixPathIsAbsent(tombstone)) {
      explicitTombstoneMissing = true;
    }
    if (explicitTombstoneMissing) {
      correlatedSlot = findPosixPublicationResidueTombstone(root, correlation);
      if (correlatedSlot) {
        tombstone = correlatedSlot.container;
        retainedTombstone = tombstone;
        explicitTombstoneMissing = false;
      }
    }
    if (correlatedSlot !== null) {
      // A durable reservation counts against the same finite terminal-evidence
      // budget on every replay, not only on its allocating attempt.
      assertPosixTombstoneQuota(root);
    }
    let temporaryPresent = true;
    try {
      filesystem.lstatSync(temporary);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      temporaryPresent = false;
    }
    if (destinationPresent) {
      if (temporaryPresent || correlatedSlot !== null || tombstone !== null
          || retainedSourceBinding === undefined) {
        throw new Error('POSIX session completed publication authority is ambiguous');
      }
      const beforeDestination = capturePosixPublicationSourceBinding(destination, { filesystem });
      if (!samePosixPublicationStableSourceBinding(
        retainedSourceBinding, beforeDestination,
      )) {
        throw new Error('POSIX session completed publication binding does not match');
      }
      synchronizeDirectory(directory);
      synchronizeDirectory(root);
      const afterDestination = capturePosixPublicationSourceBinding(destination, { filesystem });
      if (!sameFileIdentity(beforeDestination.identity, afterDestination.identity)
          || !samePosixPublicationStableSourceBinding(
            retainedSourceBinding, afterDestination,
          )) {
        throw new Error('POSIX session completed publication changed during replay');
      }
      try {
        filesystem.lstatSync(temporary);
        throw new Error('POSIX session completed publication source reappeared');
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
      return true;
    }
    if (!temporaryPresent && correlatedSlot === null
        && (tombstone === null || explicitTombstoneMissing)) {
      if (proveCompletedPosixPublicationReclaim({
        correlation,
        destination,
        directory,
        quiescentMaintenanceAuthority,
        reclaimRetainedEvidence,
        root,
        sourceBinding: retainedSourceBinding,
        synchronizeDirectory,
        temporary,
        tombstone: explicitTombstoneMissing ? tombstone : null,
      })) return true;
      throw new Error('POSIX session completed publication reclaim absence is unproven');
    }
    if (explicitTombstoneMissing) tombstone = null;
    if (tombstone !== null) {
      const retainedPayloadPresent = correlatedSlot?.payloadIdentity !== undefined;
      if (temporaryPresent && correlatedSlot === null) {
        throw new Error('POSIX session publication source reappeared after quarantine');
      }
      if (correlatedSlot !== null
          && correlatedSlot.record.sourceName !== path.basename(temporary)) {
        throw new Error('POSIX session publication quarantine source name does not match');
      }
      try {
        filesystem.lstatSync(tombstone);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
        throw new Error('POSIX session publication tombstone disappeared before exact reclaim proof', {
          cause: error,
        });
      }
      if (!temporaryPresent && correlatedSlot && !retainedPayloadPresent) {
        if (!reclaimReservationOnlyPosixTombstoneSlot(tombstone, root, {
          quiescentMaintenanceAuthority,
          reclaimRetainedEvidence,
        })) {
          throw new Error('POSIX session publication quarantine has no exact payload');
        }
        retainedTombstone = tombstone;
        if (proveCompletedPosixPublicationReclaim({
          correlation,
          destination,
          directory,
          quiescentMaintenanceAuthority,
          reclaimRetainedEvidence,
          root,
          sourceBinding: retainedSourceBinding,
          synchronizeDirectory,
          temporary,
          tombstone,
        })) return true;
        throw new Error('POSIX session reservation-only publication absence is unproven');
      }
    }
    const activeTemporary = temporaryPresent ? temporary
      : (tombstone !== null && posixTombstoneSlotName(path.basename(tombstone))
        ? path.join(tombstone, 'payload') : tombstone);
    const retainedPair = correlatedSlot?.payloadIdentity !== undefined
      && (temporaryPresent || correlatedSlot.retainedSourcePresent);
    const expectedLinks = retainedPair ? 2n : 1n;
    const before = filesystem.lstatSync(activeTemporary, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== expectedLinks
        || before.size > 65_536n) {
      throw new Error('POSIX session publication residue is unsafe or unbounded');
    }
    const descriptor = filesystem.openSync(activeTemporary, filesystem.constants.O_RDONLY
      | (filesystem.constants.O_NOFOLLOW ?? 0));
    try {
      const opened = filesystem.fstatSync(descriptor, { bigint: true });
      if (!sameFileIdentity(before, opened) || !opened.isFile()
          || opened.isSymbolicLink() || opened.nlink !== expectedLinks
          || opened.size !== before.size || opened.size > 65_536n) {
        throw new Error('POSIX session publication residue changed during proof');
      }
    } finally { filesystem.closeSync(descriptor); }
    const expectedSourceBinding = capturePosixPublicationSourceBinding(activeTemporary, {
      expectedLinks,
      filesystem,
    });
    const sourceBindingMatches = correlatedSlot?.payloadIdentity !== undefined
      ? samePosixPublicationStableSourceBinding(
        retainedSourceBinding, expectedSourceBinding,
      )
      : samePosixPublicationSourceBinding(retainedSourceBinding, expectedSourceBinding);
    if (retainedSourceBinding !== undefined && !sourceBindingMatches) {
      throw new Error('POSIX session publication source binding no longer matches');
    }
    retainedSourceBinding ??= expectedSourceBinding.sourceBinding;
    if (expectedSourceBinding !== undefined
        && !sameFileIdentity(before, expectedSourceBinding.identity)) {
      throw new Error('POSIX session publication source changed before cleanup');
    }
    beforeUnlink(Object.freeze({
      destination,
      sourceBinding: retainedSourceBinding,
      temporary,
      ...(tombstone ? { tombstone } : {}),
    }));
    const final = filesystem.lstatSync(activeTemporary, { bigint: true });
    if (!sameFileIdentity(before, final) || !final.isFile()
        || final.isSymbolicLink() || final.nlink !== expectedLinks
        || final.size !== before.size || final.size > 65_536n) {
      throw new Error('POSIX session publication residue changed before cleanup');
    }
    if (expectedSourceBinding !== undefined) {
      const reboundSource = capturePosixPublicationSourceBinding(activeTemporary, {
        expectedLinks, filesystem,
      });
      if (!sameFileIdentity(before, reboundSource.identity)
          || !samePosixPublicationSourceBinding(expectedSourceBinding, reboundSource)) {
        throw new Error('POSIX session publication source changed before cleanup');
      }
    }
    if (correlatedSlot?.payloadIdentity !== undefined) {
      const retained = assertPosixPublicationSourceBinding(
        activeTemporary, correlatedSlot.record,
        temporaryPresent ? 'retained source' : 'retained payload', {
          expectedLinks,
          stable: true,
        },
      );
      if (!sameFileIdentity(before, retained.identity)) {
        throw new Error('POSIX session retained publication residue changed before cleanup');
      }
    }
    const quarantine = correlatedSlot?.payloadIdentity !== undefined
      ? tombstone
      : moveOwnedPosixPublicationResidue({
        correlation,
        expectedSourceBinding,
        filesystem,
        quiescentMaintenanceAuthority,
        quarantine: correlatedSlot === null ? undefined : Object.freeze({
          container: correlatedSlot.container,
          payload: correlatedSlot.payload,
          record: correlatedSlot.record,
        }),
        root,
        reclaimRetainedEvidence,
        temporary,
        temporaryIdentity: before,
      });
    if (temporaryPresent) {
      retainedSourceBinding = capturePosixPublicationSourceBinding(
        temporary, { expectedLinks: 2n, filesystem },
      ).sourceBinding;
    }
    retainedTombstone = quarantine;
    // Standard Node exposes only pathname-based unlink/rm. Runtime therefore
    // preserves both authenticated names as a typed two-link terminal record.
    // The fixed-slot reservation makes restart discovery and quota accounting
    // independent of the original in-memory recovery authority.
    synchronizeDirectory(root);
    const reclaimed = reclaimPosixRetainedEvidence(quarantine, root, {
      beforeRetainedSourceMove,
      filesystem,
      quiescentMaintenanceAuthority,
      reclaimRetainedEvidence,
      runNoReplaceMove,
      synchronizeDirectory,
    });
    if (requireReclaimedPublication && !reclaimed) {
      throw new Error('POSIX session publication evidence remains retained');
    }
    return true;
  } catch (error) {
    throw failure(error);
  }
}

function assertNoPosixPublicationResidue(root, directory) {
  const names = fs.readdirSync(root);
  if (names.length > 4_096) throw new Error('POSIX session publication root is unbounded');
  const prefix = `.${path.basename(directory)}.`;
  const destinationNames = new Set(
    [
      ...Object.values(controlPaths(directory)),
      posixRetirementClaimPath(directory),
    ].map((entry) => path.basename(entry)),
  );
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith('.tmp')
        || !/^[0-9a-f]{32}$/u.test(name.slice(-36, -4))) continue;
    const destinationName = name.slice(prefix.length, -37);
    const temporary = path.join(root, name);
    const destination = path.join(directory, destinationName);
    let retained = null;
    if (destinationNames.has(destinationName)) {
      const correlation = posixPublicationResidueCorrelation(destination, temporary);
      retained = findPosixPublicationResidueTombstone(root, correlation);
    }
    if (!retained?.payloadIdentity || !retained.sourcePresent
        || retained.record.sourceName !== name) {
      throw retirementClaimRequired(directory,
        new Error('POSIX session private publication residue requires exact cleanup authority'));
    }
  }
}

function posixTombstoneName(name) {
  return /^\..+\.(?:cleanup|retire)\.[0-9a-f]{64}\.tombstone$/u.test(name);
}

function posixTombstoneSlotName(name) {
  const match = /^\.easyboost-staging-quarantine-slot\.([0-9a-f]{64})\.tombstone$/u.exec(name);
  return match !== null && POSIX_SESSION_TOMBSTONE_SLOT_TOKEN_SET.has(match[1]);
}

function posixTombstoneReservationName(name) {
  return /^\.posix-tombstone-reservation\.[0-9a-f]{4}\.claim$/u.test(name);
}

function exactPosixTombstoneReservation(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return false;
  const keys = JSON.stringify(Object.keys(record).sort());
  const legacy = keys === JSON.stringify([
    'bytes', 'entries', 'event', 'owner', 'protocol', 'tombstone',
  ]) && posixTombstoneName(record.tombstone ?? '');
  const slotKeys = JSON.stringify([
    'bytes', 'entries', 'event', 'kind', 'owner', 'protocol', 'purpose', 'tombstone',
  ]);
  const correlatedSlotKeys = JSON.stringify([
    'bytes', 'entries', 'event', 'kind', 'owner', 'protocol', 'purpose', 'source',
    'sourceBinding', 'sourceDev', 'sourceIno', 'sourceName', 'sourceSha256', 'tombstone',
  ]);
  const legacyBoundRetirementSlotKeys = JSON.stringify([
    'bytes', 'entries', 'event', 'kind', 'owner', 'protocol', 'purpose',
    'sourceDev', 'sourceIno', 'tombstone',
  ]);
  const boundRetirementSlotKeys = JSON.stringify([
    'bytes', 'entries', 'event', 'kind', 'owner', 'protocol', 'purpose',
    'sourceDev', 'sourceIno', 'sourceName', 'tombstone',
  ]);
  const ordinarySlot = keys === slotKeys;
  const boundRetirementSlot = (keys === boundRetirementSlotKeys
      || keys === legacyBoundRetirementSlotKeys)
    && record.purpose === 'retire'
    && (keys === legacyBoundRetirementSlotKeys
      || (typeof record.sourceName === 'string'
        && path.basename(record.sourceName) === record.sourceName
        && /^[a-f0-9]{64}$/u.test(record.sourceName)))
    && /^(?:0|[1-9]\d*)$/u.test(record.sourceDev ?? '')
    && /^(?:0|[1-9]\d*)$/u.test(record.sourceIno ?? '');
  const correlatedSlot = keys === correlatedSlotKeys
    && record.kind === 'file'
    && record.purpose === 'cleanup'
    && TOKEN.test(record.source ?? '')
    && typeof record.sourceName === 'string'
    && path.basename(record.sourceName) === record.sourceName
    && /^\..+\.[0-9a-f]{32}\.tmp$/u.test(record.sourceName)
    && /^(?:0|[1-9]\d*)$/u.test(record.sourceDev ?? '')
    && /^(?:0|[1-9]\d*)$/u.test(record.sourceIno ?? '')
    && TOKEN.test(record.sourceSha256 ?? '')
    && (() => {
      try {
        const binding = exactPosixPublicationSourceBinding(record.sourceBinding);
        return binding.bytes === record.bytes
          && binding.dev === record.sourceDev
          && binding.ino === record.sourceIno
          && binding.sha256 === record.sourceSha256;
      } catch {
        return false;
      }
    })();
  const slot = (ordinarySlot || boundRetirementSlot || correlatedSlot)
    && posixTombstoneSlotName(record.tombstone ?? '')
    && (record.kind === 'directory' || record.kind === 'file')
    && (record.purpose === 'cleanup' || record.purpose === 'retire');
  return (legacy || slot)
    && record.event === 'TOMBSTONE_RESERVATION'
    && record.protocol === POSIX_SESSION_CONTROL_PROTOCOL
    && TOKEN.test(record.owner ?? '')
    && Number.isSafeInteger(record.bytes) && record.bytes >= 0
    && record.bytes <= POSIX_SESSION_TOMBSTONE_MAX_BYTES
    && Number.isSafeInteger(record.entries) && record.entries >= 1
    && record.entries <= POSIX_SESSION_TOMBSTONE_MAX_ENTRIES
    && (!correlatedSlot || record.entries === 2);
}

function posixPublicationResidueCorrelation(destination, temporary) {
  return createHash('sha256')
    .update(`easyboost-posix-publication-residue-v1\0${destination}\0${temporary}`, 'utf8')
    .digest('hex');
}

function capturePosixPublicationSourceBinding(source, {
  expectedLinks = 1n,
  filesystem = fs,
} = {}) {
  const before = filesystem.lstatSync(source, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== expectedLinks
      || before.size < 0n || before.size > 65_536n) {
    throw new Error('POSIX session publication source is unsafe or unbounded');
  }
  const descriptor = filesystem.openSync(source,
    filesystem.constants.O_RDONLY | (filesystem.constants.O_NOFOLLOW ?? 0));
  try {
    const opened = filesystem.fstatSync(descriptor, { bigint: true });
    if (!sameFileIdentity(before, opened) || !opened.isFile()
        || opened.nlink !== expectedLinks
        || opened.size < 0n || opened.size > 65_536n) {
      throw new Error('POSIX session publication source changed before reservation proof');
    }
    const bytes = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < bytes.length) {
      const length = filesystem.readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (length < 1) {
        throw new Error('POSIX session publication source changed during reservation proof');
      }
      offset += length;
    }
    if (filesystem.readSync(descriptor, Buffer.alloc(1), 0, 1, bytes.length) !== 0) {
      throw new Error('POSIX session publication source exceeded its reservation bound');
    }
    const after = filesystem.fstatSync(descriptor, { bigint: true });
    const finalPath = filesystem.lstatSync(source, { bigint: true });
    if (!sameFileIdentity(opened, after)
        || !sameFileIdentity(after, finalPath)
        || opened.nlink !== expectedLinks || after.nlink !== expectedLinks
        || finalPath.nlink !== expectedLinks
        || opened.size !== BigInt(bytes.length) || after.size !== BigInt(bytes.length)
        || finalPath.size !== BigInt(bytes.length)) {
      throw new Error('POSIX session publication source changed during reservation proof');
    }
    const sourceBinding = exactPosixPublicationSourceBinding({
      birthtimeNs: String(finalPath.birthtimeNs),
      bytes: bytes.length,
      ctimeNs: String(finalPath.ctimeNs),
      dev: String(finalPath.dev),
      gid: String(finalPath.gid),
      ino: String(finalPath.ino),
      mode: String(finalPath.mode),
      sha256: createHash('sha256').update(bytes).digest('hex'),
      uid: String(finalPath.uid),
    });
    return Object.freeze({
      bytes: sourceBinding.bytes,
      identity: finalPath,
      sourceBinding,
      sourceDev: sourceBinding.dev,
      sourceIno: sourceBinding.ino,
      sourceSha256: sourceBinding.sha256,
    });
  } finally {
    filesystem.closeSync(descriptor);
  }
}

function assertPosixPublicationSourceBinding(source, record, label = 'source', {
  expectedLinks = 1n,
  stable = false,
} = {}) {
  const binding = capturePosixPublicationSourceBinding(source, { expectedLinks });
  if (binding.bytes !== record.bytes
      || binding.sourceDev !== record.sourceDev
      || binding.sourceIno !== record.sourceIno
      || binding.sourceSha256 !== record.sourceSha256
      || (record.sourceBinding !== undefined
        && !(stable
          ? samePosixPublicationStableSourceBinding(record.sourceBinding, binding)
          : samePosixPublicationSourceBinding(record.sourceBinding, binding)))) {
    throw new Error(`POSIX session publication ${label} no longer matches its reservation`);
  }
  return binding;
}

function samePosixPublicationSourceBinding(left, right) {
  const leftBinding = left?.sourceBinding ?? left;
  const rightBinding = right?.sourceBinding ?? right;
  return POSIX_PUBLICATION_SOURCE_BINDING_KEYS.every((key) =>
    leftBinding?.[key] === rightBinding?.[key]);
}

function samePosixPublicationStableSourceBinding(left, right) {
  const leftBinding = left?.sourceBinding ?? left;
  const rightBinding = right?.sourceBinding ?? right;
  return POSIX_PUBLICATION_SOURCE_BINDING_KEYS
    .filter((key) => key !== 'ctimeNs')
    .every((key) => leftBinding?.[key] === rightBinding?.[key]);
}

function emptyPosixTombstoneSlotIsOccupied(container) {
  const before = safeOwnedRecoveryDirectory(
    container, 'POSIX session unpublished tombstone slot',
  );
  const names = fs.readdirSync(container);
  const after = safeOwnedRecoveryDirectory(
    container, 'POSIX session unpublished tombstone slot',
  );
  if (!sameFileIdentity(before, after)) {
    throw new Error('POSIX session unpublished tombstone slot changed during proof');
  }
  return names.length === 0;
}

function waitForPosixTombstoneSlotPublication(container) {
  const deadline = performance.now() + POSIX_SESSION_TOMBSTONE_PUBLICATION_WAIT_MS;
  while (emptyPosixTombstoneSlotIsOccupied(container)) {
    const remaining = deadline - performance.now();
    if (remaining <= 0) return null;
    Atomics.wait(
      POSIX_SESSION_TOMBSTONE_PUBLICATION_WAIT,
      0,
      0,
      Math.min(POSIX_SESSION_TOMBSTONE_PUBLICATION_POLL_MS, remaining),
    );
  }
  return measurePosixTombstoneSlot(container);
}

function findPosixPublicationResidueTombstone(root, correlation) {
  const matches = [];
  const names = fs.readdirSync(root);
  if (names.length > POSIX_SESSION_TOMBSTONE_MAX_ENTRIES
      + POSIX_SESSION_TOMBSTONE_MAX_COUNT) {
    throw new Error('POSIX session tombstone root is unbounded');
  }
  for (const name of names) {
    if (!posixTombstoneSlotName(name)) continue;
    const container = path.join(root, name);
    // mkdir(2) is the no-replace reservation boundary. Another owner can see
    // that exact private directory before its reservation.claim is durable;
    // treat the slot as occupied without inspecting, mutating, or deleting it.
    if (emptyPosixTombstoneSlotIsOccupied(container)) continue;
    const slot = measurePosixTombstoneSlot(container);
    if (slot.record.purpose === 'cleanup' && slot.record.source === correlation) {
      matches.push(Object.freeze({ container, ...slot }));
    }
  }
  if (matches.length > 1) {
    throw new Error('POSIX session publication quarantine authority is ambiguous');
  }
  return matches[0] ?? null;
}

function measurePosixTombstonePayload(entry) {
  if (posixTombstoneSlotName(path.basename(entry))) {
    return measurePosixTombstoneSlot(entry).reserved;
  }
  const identity = fs.lstatSync(entry);
  if (identity.isSymbolicLink()) {
    throw new Error('POSIX session retained tombstone cannot be a symbolic link');
  }
  if (identity.isFile()) {
    if (identity.nlink !== 1 || !Number.isSafeInteger(identity.size)
        || identity.size < 0 || identity.size > POSIX_SESSION_TOMBSTONE_MAX_BYTES) {
      throw new Error('POSIX session retained tombstone file is unsafe or unbounded');
    }
    return Object.freeze({ bytes: identity.size, entries: 1 });
  }
  if (!identity.isDirectory()) {
    throw new Error('POSIX session retained tombstone has an unsupported inode type');
  }
  const names = fs.readdirSync(entry);
  if (names.length > POSIX_SESSION_RECOVERY_BATON_MAX_LINKS + 16) {
    throw new Error('POSIX session retained tombstone directory is unbounded');
  }
  // A lone retirement.claim can be legacy retained evidence from an earlier
  // protocol revision and is safe to meter as an ordinary nlink=1 file. Only
  // an actual successor hard-link requires the current canonical chain proof.
  const batonChain = names.some((name) =>
    /^\.recovery-baton\.[a-f0-9]{64}\.claim$/u.test(name))
    ? collectPosixRecoveryBatonChain(entry) : null;
  const batonNames = new Set(batonChain?.names ?? []);
  let bytes = 0;
  let entries = 1;
  for (const name of names) {
    const child = fs.lstatSync(path.join(entry, name));
    const exactBatonLink = batonNames.has(name)
      && Number(child.nlink) === batonNames.size;
    if (!child.isFile() || child.isSymbolicLink()
        || (child.nlink !== 1 && !exactBatonLink)
        || !Number.isSafeInteger(child.size) || child.size < 0) {
      throw new Error('POSIX session retained tombstone record is unsafe');
    }
    bytes += child.size;
    entries += 1;
    if (bytes > POSIX_SESSION_TOMBSTONE_MAX_BYTES
        || entries > POSIX_SESSION_TOMBSTONE_MAX_ENTRIES) {
      throw new Error('POSIX session retained tombstone payload is unbounded');
    }
  }
  return Object.freeze({ bytes, entries });
}

function measurePosixTombstoneSlot(container) {
  const containerIdentity = safeOwnedRecoveryDirectory(
    container, 'POSIX session retained tombstone slot',
  );
  const names = fs.readdirSync(container).sort();
  if (JSON.stringify(names) !== JSON.stringify(['reservation.claim'])
      && JSON.stringify(names) !== JSON.stringify(['payload', 'reservation.claim'])
      && JSON.stringify(names) !== JSON.stringify([
        'payload', 'reservation.claim', POSIX_SESSION_RETAINED_SOURCE_NAME,
      ])) {
    throw new Error('POSIX session retained tombstone slot is invalid');
  }
  const reservationPath = path.join(container, 'reservation.claim');
  const observed = readExactJson(reservationPath, exactPosixTombstoneReservation);
  const reservationIdentity = fs.lstatSync(reservationPath, { bigint: true });
  if (observed.state !== 'present' || observed.record.tombstone !== path.basename(container)
      || !reservationIdentity.isFile() || reservationIdentity.isSymbolicLink()
      || Number(reservationIdentity.nlink) !== 1) {
    throw new Error('POSIX session retained tombstone slot reservation is invalid');
  }
  const reserved = Object.freeze({
    bytes: observed.record.bytes,
    entries: observed.record.entries,
  });
  const payload = path.join(container, 'payload');
  let payloadIdentity;
  const retainedSource = path.join(container, POSIX_SESSION_RETAINED_SOURCE_NAME);
  let retainedSourceIdentity;
  const retainedSourcePresent = names.includes(POSIX_SESSION_RETAINED_SOURCE_NAME);
  let source;
  let sourceIdentity;
  let sourcePresent = false;
  if (names.includes('payload')) {
    const beforePayload = fs.lstatSync(payload, { bigint: true });
    if (observed.record.source !== undefined) {
      source = path.join(path.dirname(container), observed.record.sourceName);
      try {
        fs.lstatSync(source);
        sourcePresent = true;
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
      if (sourcePresent && retainedSourcePresent) {
        throw new Error('POSIX session retained publication has competing source names');
      }
      if (!sourcePresent && !retainedSourcePresent) {
        throw new Error('POSIX session retained publication lost one of its exact links');
      }
      const expectedLinks = 2n;
      const payloadBinding = assertPosixPublicationSourceBinding(
        payload, observed.record, 'retained payload', { expectedLinks, stable: true },
      );
      payloadIdentity = payloadBinding.identity;
      if (sourcePresent) {
        const sourceBinding = assertPosixPublicationSourceBinding(
          source, observed.record, 'retained source', { expectedLinks: 2n, stable: true },
        );
        sourceIdentity = sourceBinding.identity;
        if (!sameFileIdentity(payloadIdentity, sourceIdentity)) {
          throw new Error('POSIX session retained publication links no longer share one inode');
        }
      }
      if (retainedSourcePresent) {
        const retainedSourceBinding = assertPosixPublicationSourceBinding(
          retainedSource, observed.record, 'retired source', { expectedLinks: 2n, stable: true },
        );
        retainedSourceIdentity = retainedSourceBinding.identity;
        if (!sameFileIdentity(payloadIdentity, retainedSourceIdentity)) {
          throw new Error('POSIX session retired publication links no longer share one inode');
        }
      }
      if (payloadBinding.bytes !== reserved.bytes || reserved.entries !== 2) {
        throw new Error('POSIX session retained publication pair no longer matches its slot');
      }
    } else {
      if (retainedSourcePresent) {
        throw new Error('POSIX session retirement tombstone has an unexpected retained source');
      }
      const measured = measurePosixTombstonePayload(payload);
      const afterPayload = fs.lstatSync(payload, { bigint: true });
      if (!sameFileIdentity(beforePayload, afterPayload)) {
        throw new Error('POSIX session retained tombstone payload changed during proof');
      }
      payloadIdentity = afterPayload;
      if (observed.record.purpose === 'retire'
          && (observed.record.sourceDev === undefined
            || observed.record.sourceIno === undefined)) {
        throw new Error('POSIX session retirement tombstone has no source identity binding');
      }
      if (observed.record.purpose === 'retire'
          && (String(payloadIdentity.dev) !== observed.record.sourceDev
            || String(payloadIdentity.ino) !== observed.record.sourceIno)) {
        throw new Error('POSIX session retirement tombstone payload identity changed');
      }
      if (measured.bytes !== reserved.bytes || measured.entries !== reserved.entries) {
        throw new Error('POSIX session retained tombstone payload no longer matches its slot');
      }
    }
    if (!sameFileIdentity(beforePayload, payloadIdentity)) {
      throw new Error('POSIX session retained tombstone payload changed during proof');
    }
  }
  const finalContainer = safeOwnedRecoveryDirectory(
    container, 'POSIX session retained tombstone slot',
  );
  if (!sameFileIdentity(containerIdentity, finalContainer)
      || JSON.stringify(fs.readdirSync(container).sort()) !== JSON.stringify(names)
      || (payloadIdentity !== undefined
        && !sameFileIdentity(payloadIdentity, typeof payloadIdentity.dev === 'bigint'
          ? fs.lstatSync(payload, { bigint: true })
          : fs.lstatSync(payload)))
      || (sourcePresent && !sameFileIdentity(sourceIdentity,
        fs.lstatSync(source, { bigint: typeof sourceIdentity.dev === 'bigint' })))
      || (!sourcePresent && source !== undefined && !posixPathIsAbsent(source))
      || (retainedSourcePresent && !sameFileIdentity(retainedSourceIdentity,
        fs.lstatSync(retainedSource, {
          bigint: typeof retainedSourceIdentity.dev === 'bigint',
        })))
      || (!retainedSourcePresent && !posixPathIsAbsent(retainedSource))) {
    throw new Error('POSIX session retained tombstone slot changed during proof');
  }
  return Object.freeze({
    containerIdentity: finalContainer,
    payload,
    payloadIdentity,
    record: observed.record,
    reservationIdentity,
    reservationPath,
    retainedSource,
    retainedSourceIdentity,
    retainedSourcePresent,
    reserved,
    source,
    sourceIdentity,
    sourcePresent,
  });
}

function exactQuiescentMaintenanceAuthority(authority, rootIdentity) {
  return authority && typeof authority === 'object' && !Array.isArray(authority)
    && JSON.stringify(Object.keys(authority).sort()) === JSON.stringify([
      'descriptor', 'lease', 'ownerPid', 'ownerStartTime',
      'protocol', 'rootDev', 'rootIno',
    ])
    && authority.descriptor === STAGING_QUIESCENT_MAINTENANCE_DESCRIPTOR
    && TOKEN.test(authority.lease ?? '')
    && Number.isSafeInteger(authority.ownerPid) && authority.ownerPid > 0
    && /^[1-9]\d*$/u.test(authority.ownerStartTime ?? '')
    && authority.protocol === STAGING_QUIESCENT_MAINTENANCE_PROTOCOL
    && /^(?:0|[1-9]\d*)$/u.test(authority.rootDev ?? '')
    && /^(?:0|[1-9]\d*)$/u.test(authority.rootIno ?? '')
    && authority.rootDev === String(rootIdentity.dev)
    && authority.rootIno === String(rootIdentity.ino);
}

export function validatePosixQuiescentMaintenanceAuthority(authority, {
  controlRoot,
} = {}) {
  if (typeof controlRoot !== 'string' || !path.isAbsolute(controlRoot)) {
    throw new Error('POSIX session quiescent maintenance control root is invalid');
  }
  const root = path.resolve(controlRoot);
  const rootIdentity = safeOwnedRecoveryDirectory(
    root, 'POSIX session quiescent maintenance control root',
  );
  if (!exactQuiescentMaintenanceAuthority(authority, rootIdentity)) {
    throw new Error('POSIX session quiescent maintenance authority is invalid');
  }
  return Object.freeze({ ...authority });
}

function assertLivePosixQuiescentMaintenance(root, authority, reclaimer, label) {
  if (typeof reclaimer !== 'function') {
    throw new Error(`${label} callback is invalid`);
  }
  const exactAuthority = validatePosixQuiescentMaintenanceAuthority(
    authority, { controlRoot: root },
  );
  const proved = reclaimer(Object.freeze({
    authority: exactAuthority,
    kind: 'QUIESCENT_ABSENCE_PROOF',
    root,
  }));
  if (proved !== true) throw new Error(`${label} is unproven`);
  return exactAuthority;
}

function reclaimPosixRetainedEvidence(tombstone, root, {
  beforeRetainedSourceMove = () => {},
  filesystem = fs,
  quiescentMaintenanceAuthority,
  reclaimRetainedEvidence,
  runNoReplaceMove = spawnSync,
  synchronizeDirectory = syncDirectory,
} = {}) {
  const configured = quiescentMaintenanceAuthority !== undefined
    || reclaimRetainedEvidence !== undefined;
  if (!configured) return false;
  if (typeof beforeRetainedSourceMove !== 'function'
      || typeof reclaimRetainedEvidence !== 'function'
      || typeof runNoReplaceMove !== 'function'
      || typeof synchronizeDirectory !== 'function'
      || !posixTombstoneSlotName(path.basename(tombstone))) {
    throw new Error('POSIX session quiescent maintenance configuration is invalid');
  }
  const rootIdentity = safeOwnedRecoveryDirectory(root,
    'POSIX session quiescent maintenance root');
  const authority = validatePosixQuiescentMaintenanceAuthority(
    quiescentMaintenanceAuthority, { controlRoot: root },
  );
  let slot = measurePosixTombstoneSlot(tombstone);
  if (!slot.payloadIdentity
      || (!slot.payloadIdentity.isFile() && !slot.payloadIdentity.isDirectory())) {
    throw new Error('POSIX session quiescent maintenance payload is invalid');
  }
  const currentRoot = safeOwnedRecoveryDirectory(root,
    'POSIX session quiescent maintenance root');
  const currentContainer = safeOwnedRecoveryDirectory(tombstone,
    'POSIX session quiescent maintenance container');
  if (!sameFileIdentity(rootIdentity, currentRoot)
      || !sameFileIdentity(slot.containerIdentity, currentContainer)) {
    throw new Error('POSIX session quiescent maintenance namespace changed before reclaim');
  }
  if (slot.record.purpose === 'cleanup' && slot.sourcePresent) {
    // Never pathname-unlink this last external name after a separate identity
    // check. Move whatever currently occupies it through a bounded no-replace
    // boundary into the retained slot first. The expected hard link can then be
    // reclaimed as part of the complete container; a last-window replacement is
    // preserved under the retained name and fails the exact pair proof below.
    const sourceBefore = filesystem.lstatSync(slot.source, { bigint: true });
    const payloadBefore = filesystem.lstatSync(slot.payload, { bigint: true });
    if (!sameFileIdentity(sourceBefore, slot.sourceIdentity)
        || !sameFileIdentity(payloadBefore, slot.payloadIdentity)
        || !sameFileIdentity(sourceBefore, payloadBefore)
        || sourceBefore.nlink !== 2n || payloadBefore.nlink !== 2n) {
      throw new Error('POSIX session quiescent publication pair changed before reclaim');
    }
    beforeRetainedSourceMove(Object.freeze({
      destination: slot.retainedSource,
      source: slot.source,
      tombstone,
    }));
    movePosixEntryNoReplace(slot.source, slot.retainedSource, {
      filesystem,
      runMove: runNoReplaceMove,
    });
    synchronizeDirectory(tombstone);
    synchronizeDirectory(root);
    if (!posixPathIsAbsent(slot.source)) {
      throw new Error('POSIX session quiescent publication source remained after reclaim');
    }
    slot = measurePosixTombstoneSlot(tombstone);
    if (slot.sourcePresent || !slot.retainedSourcePresent
        || !sameFileIdentity(slot.payloadIdentity, slot.retainedSourceIdentity)
        || Number(slot.payloadIdentity.nlink) !== 2
        || Number(slot.retainedSourceIdentity.nlink) !== 2) {
      throw new Error('POSIX session quiescent publication source retirement is invalid');
    }
  }
  const reclaimed = reclaimRetainedEvidence(Object.freeze({
    authority,
    bounds: Object.freeze({
      maximumBytes: POSIX_SESSION_TOMBSTONE_MAX_BYTES,
      maximumEntries: POSIX_SESSION_TOMBSTONE_MAX_ENTRIES,
    }),
    container: tombstone,
    containerIdentity: Object.freeze({
      dev: String(slot.containerIdentity.dev),
      ino: String(slot.containerIdentity.ino),
    }),
    kind: slot.record.purpose === 'cleanup' ? 'PUBLICATION' : 'RETIREMENT',
    payload: slot.payload,
    payloadIdentity: Object.freeze({
      dev: String(slot.payloadIdentity.dev),
      ino: String(slot.payloadIdentity.ino),
    }),
    reservationBinding: null,
    root,
    tombstone,
  }));
  if (reclaimed !== true && reclaimed !== false) {
    throw new Error('POSIX session quiescent maintenance result is invalid');
  }
  const finalRoot = safeOwnedRecoveryDirectory(root,
    'POSIX session quiescent maintenance root');
  if (!sameFileIdentity(rootIdentity, finalRoot)) {
    throw new Error('POSIX session quiescent maintenance root changed during reclaim');
  }
  if (reclaimed) {
    if (!posixPathIsAbsent(tombstone)) {
      throw new Error('POSIX session quiescent maintenance reported an unreclaimed container');
    }
    syncDirectory(root);
    const durableRoot = safeOwnedRecoveryDirectory(root,
      'POSIX session quiescent maintenance root');
    if (!sameFileIdentity(rootIdentity, durableRoot)) {
      throw new Error('POSIX session quiescent maintenance root changed after durability');
    }
    return true;
  }
  const retained = safeOwnedRecoveryDirectory(tombstone,
    'POSIX session retained quiescent maintenance container');
  if (!sameFileIdentity(slot.containerIdentity, retained)) {
    throw new Error('POSIX session retained evidence changed during maintenance');
  }
  return false;
}

function reclaimClaimlessPosixTombstoneSlot(container, root, {
  quiescentMaintenanceAuthority,
  reclaimRetainedEvidence,
} = {}) {
  const configured = quiescentMaintenanceAuthority !== undefined
    || reclaimRetainedEvidence !== undefined;
  if (!configured) return false;
  if (typeof reclaimRetainedEvidence !== 'function'
      || !posixTombstoneSlotName(path.basename(container))) {
    throw new Error('POSIX session quiescent maintenance configuration is invalid');
  }
  const rootIdentity = safeOwnedRecoveryDirectory(
    root, 'POSIX session claimless maintenance root',
  );
  const authority = validatePosixQuiescentMaintenanceAuthority(
    quiescentMaintenanceAuthority, { controlRoot: root },
  );
  const containerIdentity = safeOwnedRecoveryDirectory(
    container, 'POSIX session claimless maintenance container',
  );
  if (fs.readdirSync(container).length !== 0) {
    throw new Error('POSIX session claimless maintenance container is not empty');
  }
  const currentContainer = safeOwnedRecoveryDirectory(
    container, 'POSIX session claimless maintenance container',
  );
  if (!sameFileIdentity(containerIdentity, currentContainer)) {
    throw new Error('POSIX session claimless maintenance container changed before reclaim');
  }
  const reclaimed = reclaimRetainedEvidence(Object.freeze({
    authority,
    bounds: Object.freeze({
      maximumBytes: POSIX_SESSION_TOMBSTONE_MAX_BYTES,
      maximumEntries: POSIX_SESSION_TOMBSTONE_MAX_ENTRIES,
    }),
    container,
    containerIdentity: Object.freeze({
      dev: String(containerIdentity.dev),
      ino: String(containerIdentity.ino),
    }),
    kind: 'CLAIMLESS_RESERVATION',
    payload: null,
    payloadIdentity: null,
    reservationBinding: null,
    root,
    tombstone: container,
  }));
  if (reclaimed !== true && reclaimed !== false) {
    throw new Error('POSIX session quiescent maintenance result is invalid');
  }
  const currentRoot = safeOwnedRecoveryDirectory(
    root, 'POSIX session claimless maintenance root',
  );
  if (!sameFileIdentity(rootIdentity, currentRoot)) {
    throw new Error('POSIX session claimless maintenance root changed during reclaim');
  }
  if (reclaimed) {
    if (!posixPathIsAbsent(container)) {
      throw new Error('POSIX session claimless maintenance reported an unreclaimed container');
    }
    syncDirectory(root);
    const durableRoot = safeOwnedRecoveryDirectory(
      root, 'POSIX session claimless maintenance root',
    );
    if (!sameFileIdentity(rootIdentity, durableRoot)) {
      throw new Error('POSIX session claimless maintenance root changed after durability');
    }
    return true;
  }
  const retained = safeOwnedRecoveryDirectory(
    container, 'POSIX session retained claimless maintenance container',
  );
  if (!sameFileIdentity(containerIdentity, retained)
      || fs.readdirSync(container).length !== 0) {
    throw new Error('POSIX session claimless evidence changed during maintenance');
  }
  return false;
}

function reclaimReservationOnlyPosixTombstoneSlot(container, root, {
  quiescentMaintenanceAuthority,
  reclaimRetainedEvidence,
} = {}) {
  const configured = quiescentMaintenanceAuthority !== undefined
    || reclaimRetainedEvidence !== undefined;
  if (!configured) return false;
  if (typeof reclaimRetainedEvidence !== 'function'
      || !posixTombstoneSlotName(path.basename(container))) {
    throw new Error('POSIX session reservation-only maintenance configuration is invalid');
  }
  const rootIdentity = safeOwnedRecoveryDirectory(
    root, 'POSIX session reservation-only maintenance root',
  );
  const authority = validatePosixQuiescentMaintenanceAuthority(
    quiescentMaintenanceAuthority, { controlRoot: root },
  );
  const slot = measurePosixTombstoneSlot(container);
  if (slot.payloadIdentity !== undefined
      || JSON.stringify(fs.readdirSync(container).sort())
        !== JSON.stringify(['reservation.claim'])
      || !TOKEN.test(slot.record.owner ?? '')
      || (slot.record.purpose !== 'cleanup' && slot.record.purpose !== 'retire')
      || !UNSIGNED_DECIMAL.test(slot.record.sourceDev ?? '')
      || !UNSIGNED_DECIMAL.test(slot.record.sourceIno ?? '')) {
    throw new Error('POSIX session reservation-only evidence is invalid');
  }
  const reservationBytes = fs.readFileSync(slot.reservationPath);
  const reservationBinding = Object.freeze({
    owner: slot.record.owner,
    purpose: slot.record.purpose,
    sha256: createHash('sha256').update(reservationBytes).digest('hex'),
    sourceDev: slot.record.sourceDev,
    sourceIno: slot.record.sourceIno,
  });
  const currentReservation = fs.lstatSync(slot.reservationPath, { bigint: true });
  const currentContainer = safeOwnedRecoveryDirectory(
    container, 'POSIX session reservation-only maintenance container',
  );
  if (!sameFileIdentity(slot.containerIdentity, currentContainer)
      || !sameFileIdentity(slot.reservationIdentity, currentReservation)) {
    throw new Error('POSIX session reservation-only evidence changed before reclaim');
  }
  const reclaimed = reclaimRetainedEvidence(Object.freeze({
    authority,
    bounds: Object.freeze({
      maximumBytes: POSIX_SESSION_TOMBSTONE_MAX_BYTES,
      maximumEntries: POSIX_SESSION_TOMBSTONE_MAX_ENTRIES,
    }),
    container,
    containerIdentity: Object.freeze({
      dev: String(slot.containerIdentity.dev),
      ino: String(slot.containerIdentity.ino),
    }),
    kind: 'RESERVATION_ONLY',
    payload: null,
    payloadIdentity: null,
    reservationBinding,
    root,
    tombstone: container,
  }));
  if (reclaimed !== true && reclaimed !== false) {
    throw new Error('POSIX session reservation-only maintenance result is invalid');
  }
  const currentRoot = safeOwnedRecoveryDirectory(
    root, 'POSIX session reservation-only maintenance root',
  );
  if (!sameFileIdentity(rootIdentity, currentRoot)) {
    throw new Error('POSIX session reservation-only maintenance root changed during reclaim');
  }
  if (reclaimed) {
    if (!posixPathIsAbsent(container)) {
      throw new Error(
        'POSIX session reservation-only maintenance reported an unreclaimed container',
      );
    }
    syncDirectory(root);
    const durableRoot = safeOwnedRecoveryDirectory(
      root, 'POSIX session reservation-only maintenance root',
    );
    if (!sameFileIdentity(rootIdentity, durableRoot)) {
      throw new Error('POSIX session reservation-only maintenance root changed after durability');
    }
    return true;
  }
  const retained = measurePosixTombstoneSlot(container);
  if (!sameFileIdentity(slot.containerIdentity, retained.containerIdentity)
      || !sameFileIdentity(slot.reservationIdentity, retained.reservationIdentity)
      || retained.payloadIdentity !== undefined) {
    throw new Error('POSIX session reservation-only evidence changed during maintenance');
  }
  return false;
}

function assertPosixTombstoneQuota(root) {
  const names = fs.readdirSync(root);
  if (names.length > POSIX_SESSION_TOMBSTONE_MAX_ENTRIES
      + POSIX_SESSION_TOMBSTONE_MAX_COUNT) {
    throw new Error('POSIX session tombstone root is unbounded');
  }
  const tombstones = new Map();
  const reservations = new Map();
  for (const name of names) {
    if (posixTombstoneSlotName(name)) {
      const container = path.join(root, name);
      reservations.set(name, emptyPosixTombstoneSlotIsOccupied(container)
        ? Object.freeze({ bytes: 0, entries: 1 })
        : measurePosixTombstoneSlot(container).reserved);
    } else if (posixTombstoneName(name)) {
      tombstones.set(name, measurePosixTombstonePayload(path.join(root, name)));
    } else if (posixTombstoneReservationName(name)) {
      const reservationPath = path.join(root, name);
      const observed = readExactJson(reservationPath, exactPosixTombstoneReservation);
      const identity = fs.lstatSync(reservationPath);
      if (observed.state !== 'present' || !identity.isFile() || identity.isSymbolicLink()
          || identity.nlink !== 1 || reservations.has(observed.record.tombstone)) {
        throw new Error('POSIX session tombstone reservation is invalid');
      }
      reservations.set(observed.record.tombstone, Object.freeze({
        bytes: observed.record.bytes,
        entries: observed.record.entries,
      }));
    }
  }
  let bytes = 0;
  let count = reservations.size;
  let entries = 0;
  for (const [name, reserved] of reservations) {
    const retained = tombstones.get(name);
    if (retained && (retained.bytes !== reserved.bytes
        || retained.entries !== reserved.entries)) {
      throw new Error('POSIX session retained tombstone no longer matches its reservation');
    }
    bytes += reserved.bytes;
    entries += reserved.entries;
  }
  for (const [name, retained] of tombstones) {
    if (reservations.has(name)) continue;
    count += 1;
    bytes += retained.bytes;
    entries += retained.entries;
  }
  if (count > POSIX_SESSION_TOMBSTONE_MAX_COUNT
      || bytes > POSIX_SESSION_TOMBSTONE_MAX_BYTES
      || entries > POSIX_SESSION_TOMBSTONE_MAX_ENTRIES) {
    throw new Error('POSIX session retained tombstone quota is exhausted');
  }
}

export function sweepPosixSessionRetainedEvidence({
  controlRoot,
  quiescentMaintenanceAuthority,
  reclaimRetainedEvidence,
  noReplacePlatform = process.platform,
  runNoReplaceMove = spawnSync,
  synchronizeDirectory = syncDirectory,
} = {}) {
  if (typeof controlRoot !== 'string' || !path.isAbsolute(controlRoot)
      || path.resolve(controlRoot) !== controlRoot) {
    throw new Error('POSIX session retained-evidence sweep root is invalid');
  }
  const root = controlRoot;
  assertLivePosixQuiescentMaintenance(
    root, quiescentMaintenanceAuthority, reclaimRetainedEvidence,
    'POSIX session retained-evidence sweep lease',
  );
  for (const token of POSIX_SESSION_TOMBSTONE_SLOT_TOKENS) {
    const container = path.join(
      root, `.easyboost-staging-quarantine-slot.${token}.tombstone`,
    );
    if (posixPathIsAbsent(container)) continue;
    let slot = emptyPosixTombstoneSlotIsOccupied(container)
      ? waitForPosixTombstoneSlotPublication(container)
      : measurePosixTombstoneSlot(container);
    if (slot === null) {
      if (!reclaimClaimlessPosixTombstoneSlot(container, root, {
        quiescentMaintenanceAuthority,
        reclaimRetainedEvidence,
      })) {
        throw new Error('POSIX session claimless retained-evidence slot could not be reclaimed');
      }
      continue;
    }
    if (slot.record.purpose !== 'retire') {
      throw new Error('POSIX session publication evidence requires explicit recovery before sweep');
    }
    if (typeof slot.record.sourceName !== 'string'
        || !/^[a-f0-9]{64}$/u.test(slot.record.sourceName)) {
      throw new Error('POSIX session legacy retirement evidence requires explicit recovery');
    }
    const authority = Object.freeze({
      controlDirectory: path.join(root, slot.record.sourceName),
      reservationOwner: slot.record.owner,
      sourceDev: slot.record.sourceDev,
      sourceIno: slot.record.sourceIno,
      tombstone: container,
    });
    cleanupPosixSessionRetirementTombstone(authority, {
      noReplacePlatform,
      quiescentMaintenanceAuthority,
      reclaimRetainedEvidence,
      runNoReplaceMove,
      synchronizeDirectory,
    });
    if (!posixPathIsAbsent(container)) {
      throw attachPosixRetirementTombstone(
        new Error('POSIX session retained-evidence sweep left its exact retirement slot'),
        authority,
      );
    }
    slot = null;
  }
  assertLivePosixQuiescentMaintenance(
    root, quiescentMaintenanceAuthority, reclaimRetainedEvidence,
    'POSIX session retained-evidence sweep completion lease',
  );
  assertPosixTombstoneQuota(root);
  return true;
}

function uniquePosixTombstone(root, purpose, source, {
  correlation,
  expectedSourceIdentity,
  expectedSourceBinding,
  quiescentMaintenanceAuthority,
  reclaimRetainedEvidence,
} = {}) {
  if (correlation !== undefined && (!TOKEN.test(correlation) || purpose !== 'cleanup')) {
    throw new Error('POSIX session tombstone correlation is invalid');
  }
  const observedSourceBinding = correlation === undefined
    ? undefined : capturePosixPublicationSourceBinding(source);
  if (expectedSourceBinding !== undefined
      && !samePosixPublicationSourceBinding(expectedSourceBinding, observedSourceBinding)) {
    throw new Error('POSIX session publication source changed before quarantine reservation');
  }
  const sourceBinding = expectedSourceBinding ?? observedSourceBinding;
  const retirementSourceIdentity = sourceBinding === undefined
    ? fs.lstatSync(source, { bigint: true }) : undefined;
  if (purpose === 'retire' && (expectedSourceIdentity === undefined
      || !sameFileIdentity(retirementSourceIdentity, expectedSourceIdentity))) {
    throw new Error('POSIX session retirement source identity is invalid');
  }
  const incoming = sourceBinding === undefined
    ? measurePosixTombstonePayload(source)
    // The payload link and its original private sibling are both retained at
    // runtime. They reference one inode (so bytes are charged once), but they
    // consume two independently named namespace entries until quiescent
    // maintenance retires the complete pair.
    : Object.freeze({ bytes: sourceBinding.bytes, entries: 2 });
  const rootIdentity = safeOwnedRecoveryDirectory(root, 'POSIX session tombstone root');
  const owner = randomBytes(32).toString('hex');
  const start = correlation === undefined
    ? randomBytes(2).readUInt16BE(0) % POSIX_SESSION_TOMBSTONE_MAX_COUNT
    : Number.parseInt(correlation.slice(0, 8), 16) % POSIX_SESSION_TOMBSTONE_MAX_COUNT;
  let container;
  for (let offset = 0; offset < POSIX_SESSION_TOMBSTONE_MAX_COUNT; offset += 1) {
    const slot = (start + offset) % POSIX_SESSION_TOMBSTONE_MAX_COUNT;
    const current = path.join(root,
      `.easyboost-staging-quarantine-slot.${POSIX_SESSION_TOMBSTONE_SLOT_TOKENS[slot]}.tombstone`);
    try {
      fs.mkdirSync(current, { mode: 0o700 });
    } catch (error) {
      if (error?.code === 'EEXIST') {
        if (correlation === undefined) continue;
        let occupied = emptyPosixTombstoneSlotIsOccupied(current)
          ? waitForPosixTombstoneSlotPublication(current)
          : measurePosixTombstoneSlot(current);
        if (occupied === null && offset === 0) {
          assertPosixTombstoneQuota(root);
        }
        if (occupied === null && offset === 0
            && reclaimClaimlessPosixTombstoneSlot(current, root, {
              quiescentMaintenanceAuthority,
              reclaimRetainedEvidence,
            })) {
          fs.mkdirSync(current, { mode: 0o700 });
          syncDirectory(root);
          container = current;
          break;
        }
        if (occupied === null) {
          throw new Error(
            'POSIX session tombstone reservation namespace is exhausted by an unpublished occupied slot',
          );
        }
        if (occupied.record.purpose === purpose
            && occupied.record.source === correlation) {
          if (occupied.record.sourceName !== path.basename(source)) {
            throw new Error('POSIX session publication reservation source name changed');
          }
          assertPosixPublicationSourceBinding(source, occupied.record, 'source', {
            expectedLinks: occupied.payloadIdentity === undefined ? 1n : 2n,
            stable: occupied.payloadIdentity !== undefined,
          });
          assertPosixTombstoneQuota(root);
          return Object.freeze({
            container: current,
            payload: occupied.payload,
            record: occupied.record,
          });
        }
        continue;
      }
      throw error;
    }
    syncDirectory(root);
    container = current;
    break;
  }
  if (!container) {
    throw new Error('POSIX session tombstone reservation namespace is exhausted');
  }
  const record = Object.freeze({
    bytes: incoming.bytes,
    entries: incoming.entries,
    event: 'TOMBSTONE_RESERVATION',
    kind: sourceBinding === undefined
      ? (fs.lstatSync(source).isDirectory() ? 'directory' : 'file')
      : 'file',
    owner,
    protocol: POSIX_SESSION_CONTROL_PROTOCOL,
    purpose,
    ...(sourceBinding === undefined ? {} : {
      source: correlation,
      sourceBinding: sourceBinding.sourceBinding,
      sourceDev: sourceBinding.sourceDev,
      sourceIno: sourceBinding.sourceIno,
      sourceName: path.basename(source),
      sourceSha256: sourceBinding.sourceSha256,
    }),
    ...(retirementSourceIdentity === undefined ? {} : {
      sourceDev: String(retirementSourceIdentity.dev),
      sourceIno: String(retirementSourceIdentity.ino),
      sourceName: path.basename(source),
    }),
    tombstone: path.basename(container),
  });
  const value = canonicalJson(record);
  const reservationPath = path.join(container, 'reservation.claim');
  let descriptor;
  try {
    descriptor = fs.openSync(reservationPath, 'wx', 0o600);
    fs.writeFileSync(descriptor, value, 'utf8');
    fs.fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
  syncDirectory(container);
  syncDirectory(root);
  const observed = readExactJson(reservationPath, exactPosixTombstoneReservation);
  const identity = fs.lstatSync(reservationPath);
  const currentRoot = safeOwnedRecoveryDirectory(root, 'POSIX session tombstone root');
  if (observed.state !== 'present' || canonicalJson(observed.record) !== value
      || !identity.isFile() || identity.isSymbolicLink() || identity.nlink !== 1
      || !sameFileIdentity(rootIdentity, currentRoot)
      || (retirementSourceIdentity !== undefined
        && !sameFileIdentity(retirementSourceIdentity,
          fs.lstatSync(source, { bigint: true })))) {
    throw new Error('POSIX session tombstone reservation changed during publication');
  }
  // Every contender reserves before scanning. Thus at N-1 two concurrent
  // contenders cannot both observe N-1: the later scan includes both durable
  // reservations and fails closed before either unsafe extra tombstone move.
  assertPosixTombstoneQuota(root);
  const payload = path.join(container, 'payload');
  if (!posixPathIsAbsent(payload)) {
    throw new Error('POSIX session reserved tombstone payload is no longer absent');
  }
  return Object.freeze({ container, payload, record });
}

function moveOwnedPosixPublicationResidue({
  correlation,
  expectedSourceBinding,
  filesystem,
  quiescentMaintenanceAuthority,
  quarantine: retainedQuarantine,
  reclaimRetainedEvidence,
  root,
  temporary,
  temporaryIdentity,
}) {
  const quarantine = retainedQuarantine
    ?? uniquePosixTombstone(root, 'cleanup', temporary, {
      correlation,
      expectedSourceBinding,
      quiescentMaintenanceAuthority,
      reclaimRetainedEvidence,
    });
  if (!posixPathIsAbsent(quarantine.payload)) {
    throw new Error('POSIX session publication quarantine payload already exists');
  }
  const sourceBinding = assertPosixPublicationSourceBinding(temporary, quarantine.record);
  if (!sameFileIdentity(temporaryIdentity, sourceBinding.identity)) {
    throw new Error('POSIX session publication source changed before quarantine');
  }
  // A pathname rename can replace a concurrently-created file on POSIX. Publish
  // the exact inode by hard link instead: link(2) is an atomic no-replace
  // boundary. Runtime keeps both proved names. Pathname-unlinking the source
  // after this proof would let a concurrent same-owner replacement be removed
  // in place of the inode just authenticated.
  filesystem.linkSync(temporary, quarantine.payload);
  const linkedSource = capturePosixPublicationSourceBinding(temporary, {
    expectedLinks: 2n,
    filesystem,
  });
  const linkedPayload = capturePosixPublicationSourceBinding(quarantine.payload, {
    expectedLinks: 2n,
    filesystem,
  });
  if (!sameFileIdentity(linkedSource.identity, linkedPayload.identity)
      || !sameFileIdentity(temporaryIdentity, linkedSource.identity)
      || linkedSource.sourceDev !== quarantine.record.sourceDev
      || linkedSource.sourceIno !== quarantine.record.sourceIno
      || linkedSource.sourceSha256 !== quarantine.record.sourceSha256
      || linkedSource.bytes !== quarantine.record.bytes) {
    throw new Error('POSIX session publication residue changed during no-replace handoff');
  }
  const retainedSource = assertPosixPublicationSourceBinding(
    temporary, quarantine.record, 'retained source', {
      expectedLinks: 2n, stable: true,
    },
  );
  const retainedPayload = assertPosixPublicationSourceBinding(
    quarantine.payload, quarantine.record, 'retained payload', {
      expectedLinks: 2n, stable: true,
    },
  );
  if (!sameFileIdentity(temporaryIdentity, retainedSource.identity)
      || !sameFileIdentity(retainedSource.identity, retainedPayload.identity)) {
    throw new Error('POSIX session publication residue changed during quarantine');
  }
  syncDirectory(quarantine.container);
  return quarantine.container;
}

function runPosixRenameNoReplace(runMove, source, destination) {
  return runMove(POSIX_RENAME_NOREPLACE_INTERPRETER, [
    '-I', '-S', '-c', POSIX_RENAME_NOREPLACE_PROGRAM, source, destination,
  ], {
    cwd: '/',
    env: Object.freeze({ LC_ALL: 'C', PATH: '/usr/bin:/bin' }),
    killSignal: 'SIGKILL',
    shell: false,
    stdio: 'ignore',
    timeout: 5_000,
    windowsHide: true,
  });
}

export function movePosixEntryNoReplace(source, destination, {
  filesystem = fs,
  platform = process.platform,
  runMove = spawnSync,
} = {}) {
  if (typeof source !== 'string' || !path.isAbsolute(source)
      || path.resolve(source) !== source
      || typeof destination !== 'string' || !path.isAbsolute(destination)
      || path.resolve(destination) !== destination
      || typeof runMove !== 'function') {
    throw new Error('POSIX session entry handoff configuration is invalid');
  }
  const sourceIdentity = filesystem.lstatSync(source, { bigint: true });
  try {
    filesystem.lstatSync(destination);
    throw new Error('POSIX session entry handoff destination already exists');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  let outcome;
  if (platform === 'win32') {
    // Production POSIX recovery runs on Linux. This branch keeps the exact same
    // observable contract testable on Windows, where rename of an absent target
    // is a single filesystem operation.
    filesystem.renameSync(source, destination);
    outcome = { status: 0 };
  } else if (platform === 'linux') {
    outcome = runPosixRenameNoReplace(runMove, source, destination);
  } else {
    throw new Error('POSIX session entry no-replace handoff is unsupported on this host');
  }
  let sourceAbsent = false;
  try {
    filesystem.lstatSync(source);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    sourceAbsent = true;
  }
  let destinationIdentity;
  try {
    destinationIdentity = filesystem.lstatSync(destination, { bigint: true });
  } catch (error) {
    if (sourceAbsent || error?.code !== 'ENOENT') throw error;
  }
  if (!sourceAbsent || destinationIdentity === undefined
      || !sameFileIdentity(sourceIdentity, destinationIdentity)) {
    const error = new Error('POSIX session entry no-replace handoff did not commit exact identity');
    error.code = 'POSIX_SESSION_ENTRY_HANDOFF_RETAINED';
    error.recoveryAuthority = Object.freeze({ destination, source });
    throw error;
  }
  if (outcome?.error || outcome?.signal || outcome?.status !== 0) {
    const error = new Error('POSIX session entry no-replace handoff command failed');
    error.code = 'POSIX_SESSION_ENTRY_HANDOFF_RETAINED';
    error.recoveryAuthority = Object.freeze({ destination, source });
    throw error;
  }
  return destinationIdentity;
}

export function movePosixDirectoryNoReplace(source, destination, {
  filesystem = fs,
  platform = process.platform,
  runMove = spawnSync,
} = {}) {
  if (typeof source !== 'string' || !path.isAbsolute(source)
      || typeof destination !== 'string' || !path.isAbsolute(destination)
      || typeof runMove !== 'function') {
    throw new Error('POSIX session directory handoff configuration is invalid');
  }
  const sourceIdentity = safeOwnedRecoveryDirectory(
    source, 'POSIX session directory handoff source',
  );
  if (!posixPathIsAbsent(destination)) {
    throw new Error('POSIX session directory handoff destination already exists');
  }
  let outcome;
  if (platform === 'win32') {
    // MoveFileW, which backs Node's Windows rename, fails when the destination
    // directory exists; unlike POSIX rename(2), it does not replace it.
    filesystem.renameSync(source, destination);
    outcome = { status: 0 };
  } else if (platform === 'linux') {
    outcome = runPosixRenameNoReplace(runMove, source, destination);
  } else {
    throw new Error('POSIX session directory no-replace handoff is unsupported on this host');
  }
  let sourceAbsent = false;
  try {
    filesystem.lstatSync(source);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    sourceAbsent = true;
  }
  let destinationIdentity;
  try {
    destinationIdentity = safeOwnedRecoveryDirectory(
      destination, 'POSIX session directory handoff destination',
    );
  } catch (error) {
    if (sourceAbsent || error?.code !== 'ENOENT') throw error;
  }
  if (!sourceAbsent || destinationIdentity === undefined
      || !sameFileIdentity(sourceIdentity, destinationIdentity)) {
    const error = new Error('POSIX session directory no-replace handoff did not commit');
    error.code = 'POSIX_SESSION_DIRECTORY_HANDOFF_RETAINED';
    error.recoveryAuthority = Object.freeze({ destination, source });
    throw error;
  }
  if (outcome?.error || outcome?.signal || outcome?.status !== 0) {
    throw new Error('POSIX session directory no-replace handoff command failed');
  }
  return true;
}

function posixRetirementTombstoneAuthority(controlDirectory, quarantine) {
  const { record, container: tombstone } = quarantine;
  if (record?.purpose !== 'retire' || !TOKEN.test(record.owner ?? '')
      || !UNSIGNED_DECIMAL.test(record.sourceDev ?? '')
      || !UNSIGNED_DECIMAL.test(record.sourceIno ?? '')) {
    throw new Error('POSIX session retirement tombstone reservation authority is invalid');
  }
  return Object.freeze({
    controlDirectory,
    reservationOwner: record.owner,
    sourceDev: record.sourceDev,
    sourceIno: record.sourceIno,
    tombstone,
  });
}

function exactPosixRetirementTombstoneAuthority(authority, controlDirectory) {
  if (!authority || typeof authority !== 'object' || Array.isArray(authority)
      || JSON.stringify(Object.keys(authority).sort()) !== JSON.stringify([
        'controlDirectory', 'reservationOwner', 'sourceDev', 'sourceIno', 'tombstone',
      ])
      || typeof authority.controlDirectory !== 'string'
      || !path.isAbsolute(authority.controlDirectory)
      || path.resolve(authority.controlDirectory) !== authority.controlDirectory
      || (controlDirectory !== undefined
        && authority.controlDirectory !== path.resolve(controlDirectory))
      || typeof authority.tombstone !== 'string' || !path.isAbsolute(authority.tombstone)
      || path.resolve(authority.tombstone) !== authority.tombstone
      || path.dirname(authority.tombstone) !== path.dirname(authority.controlDirectory)
      || !posixTombstoneSlotName(path.basename(authority.tombstone))
      || !TOKEN.test(authority.reservationOwner ?? '')
      || !UNSIGNED_DECIMAL.test(authority.sourceDev ?? '')
      || !UNSIGNED_DECIMAL.test(authority.sourceIno ?? '')) {
    return null;
  }
  return Object.freeze({
    controlDirectory: authority.controlDirectory,
    reservationOwner: authority.reservationOwner,
    sourceDev: authority.sourceDev,
    sourceIno: authority.sourceIno,
    tombstone: authority.tombstone,
  });
}

function moveOwnedPosixControlDirectory({
  directory,
  directoryIdentity,
  retirementSourceIdentity,
  root,
  rootIdentity,
  noReplacePlatform = process.platform,
  runNoReplaceMove = spawnSync,
}) {
  const quarantine = uniquePosixTombstone(root, 'retire', directory, {
    expectedSourceIdentity: retirementSourceIdentity,
  });
  const authority = posixRetirementTombstoneAuthority(directory, quarantine);
  try {
    movePosixDirectoryNoReplace(directory, quarantine.payload, {
      platform: noReplacePlatform,
      runMove: runNoReplaceMove,
    });
  } catch (error) {
    // A source-name substitution can make renameat2 move a successor rather
    // than the directory captured above. The no-replace boundary never deletes
    // either tree, and this typed slot keeps the moved result retained for
    // explicit quiescent inspection instead of attempting pathname rollback.
    throw attachPosixRetirementTombstone(
      retirementClaimRequired(directory, error), authority,
    );
  }
  try {
    const currentRoot = safeOwnedRecoveryDirectory(root, 'POSIX session control root');
    const moved = safeOwnedRecoveryDirectory(
      quarantine.payload, 'POSIX session retirement tombstone payload',
    );
    const movedExact = safeOwnedRecoveryDirectoryExactIdentity(
      quarantine.payload, 'POSIX session retirement tombstone payload',
    );
    if (!sameFileIdentity(rootIdentity, currentRoot)
        || !sameFileIdentity(directoryIdentity, moved)
        || !sameFileIdentity(retirementSourceIdentity, movedExact)) {
      throw new Error('POSIX session retirement directory changed during tombstone move');
    }
    syncDirectory(quarantine.container);
  } catch (error) {
    throw attachPosixRetirementTombstone(
      retirementClaimRequired(directory, error), authority,
    );
  }
  return Object.freeze({ authority, container: quarantine.container });
}

export function cleanupPosixSessionRetirementTombstone(authority, {
  quiescentMaintenanceAuthority,
  reclaimRetainedEvidence,
  requireReclaimedRetirement = false,
  noReplacePlatform = process.platform,
  runNoReplaceMove = spawnSync,
  synchronizeDirectory = syncDirectory,
} = {}) {
  const exactAuthority = exactPosixRetirementTombstoneAuthority(authority);
  if (exactAuthority === null) {
    throw new Error('POSIX session retirement tombstone authority is not exact');
  }
  authority = exactAuthority;
  const directory = authority.controlDirectory;
  const root = path.dirname(directory);
  const tombstone = path.resolve(authority.tombstone);
  const prefix = `.${path.basename(directory)}.retire.`;
  const tombstoneName = path.basename(tombstone);
  const exactLegacyTombstone = tombstoneName.startsWith(prefix)
    && tombstoneName.endsWith('.tombstone')
    && TOKEN.test(tombstoneName.slice(prefix.length, -'.tombstone'.length));
  if (path.dirname(tombstone) !== root
      || (!exactLegacyTombstone && !posixTombstoneSlotName(tombstoneName))) {
    throw new Error('POSIX session retirement tombstone authority is invalid');
  }
  if (!TOKEN.test(authority.reservationOwner ?? '')
      || !UNSIGNED_DECIMAL.test(authority.sourceDev ?? '')
      || !UNSIGNED_DECIMAL.test(authority.sourceIno ?? '')) {
    throw new Error('POSIX session retirement tombstone reservation authority is invalid');
  }
  safeOwnedRecoveryDirectory(root, 'POSIX session retirement tombstone root');
  try {
    safeOwnedRecoveryDirectory(tombstone, 'POSIX session retirement tombstone');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    let sourceIdentity = null;
    try {
      sourceIdentity = safeOwnedRecoveryDirectoryExactIdentity(
        directory, 'POSIX session missing retirement tombstone source',
      );
    } catch (sourceError) {
      if (sourceError?.code !== 'ENOENT') {
        throw attachPosixRetirementTombstone(sourceError, authority);
      }
    }
    if (sourceIdentity !== null) {
      const message = String(sourceIdentity.dev) === authority.sourceDev
          && String(sourceIdentity.ino) === authority.sourceIno
        ? 'POSIX session retirement tombstone is missing while its exact source remains'
        : 'POSIX session retirement tombstone is missing and its source path was replaced';
      throw attachPosixRetirementTombstone(new Error(message), authority);
    }
    try {
      assertLivePosixQuiescentMaintenance(
        root, quiescentMaintenanceAuthority, reclaimRetainedEvidence,
        'POSIX session completed retirement absence proof',
      );
      synchronizeDirectory(root);
      if (!posixPathIsAbsent(directory) || !posixPathIsAbsent(tombstone)) {
        throw new Error('POSIX session completed retirement absence changed during proof');
      }
      assertLivePosixQuiescentMaintenance(
        root, quiescentMaintenanceAuthority, reclaimRetainedEvidence,
        'POSIX session completed retirement durable absence proof',
      );
      return true;
    } catch (absenceError) {
      throw attachPosixRetirementTombstone(absenceError, authority);
    }
  }
  // The tombstone remains immutable terminal evidence. Removing it by pathname
  // after validation would be vulnerable to deleting an ABA successor.
  let slot = measurePosixTombstoneSlot(tombstone);
  if (slot.record.purpose !== 'retire'
      || slot.record.owner !== authority.reservationOwner
      || slot.record.sourceDev !== authority.sourceDev
      || slot.record.sourceIno !== authority.sourceIno
      || (slot.record.sourceName !== undefined
        && slot.record.sourceName !== path.basename(directory))) {
    throw new Error('POSIX session retirement tombstone reservation authority changed');
  }
  if (slot.payloadIdentity === undefined) {
    const rootIdentity = safeOwnedRecoveryDirectory(
      root, 'POSIX session reservation-only retirement root',
    );
    const directoryIdentity = safeOwnedRecoveryDirectory(
      directory, 'POSIX session reservation-only retirement source',
    );
    const retirementSourceIdentity = safeOwnedRecoveryDirectoryExactIdentity(
      directory, 'POSIX session reservation-only retirement source',
    );
    if (String(retirementSourceIdentity.dev) !== authority.sourceDev
        || String(retirementSourceIdentity.ino) !== authority.sourceIno) {
      throw new Error('POSIX session reservation-only retirement source changed');
    }
    try {
      // The durable reservation is the replay authority. Retiring it before the
      // source move creates an unrecoverable crash window and consumes a new
      // fixed slot on every retry. Always finish the no-replace move into this
      // exact slot, then let quiescent maintenance reclaim the complete pair.
      movePosixDirectoryNoReplace(directory, slot.payload, {
        platform: noReplacePlatform,
        runMove: runNoReplaceMove,
      });
      const currentRoot = safeOwnedRecoveryDirectory(
        root, 'POSIX session retried retirement root',
      );
      const currentContainer = safeOwnedRecoveryDirectory(
        tombstone, 'POSIX session retried retirement tombstone',
      );
      const currentReservation = fs.lstatSync(slot.reservationPath, { bigint: true });
      const moved = safeOwnedRecoveryDirectory(
        slot.payload, 'POSIX session retried retirement payload',
      );
      const movedExact = safeOwnedRecoveryDirectoryExactIdentity(
        slot.payload, 'POSIX session retried retirement payload',
      );
      if (!sameFileIdentity(rootIdentity, currentRoot)
          || !sameFileIdentity(slot.containerIdentity, currentContainer)
          || !sameFileIdentity(slot.reservationIdentity, currentReservation)
          || !sameFileIdentity(directoryIdentity, moved)
          || !sameFileIdentity(retirementSourceIdentity, movedExact)
          || !posixPathIsAbsent(directory)) {
        throw new Error('POSIX session retried retirement authority changed during move');
      }
      synchronizeDirectory(tombstone);
      synchronizeDirectory(root);
      slot = measurePosixTombstoneSlot(tombstone);
      if (!slot.payloadIdentity
          || String(slot.payloadIdentity.dev) !== authority.sourceDev
          || String(slot.payloadIdentity.ino) !== authority.sourceIno) {
        throw new Error('POSIX session retried retirement payload is not exact');
      }
    } catch (retryError) {
      throw attachPosixRetirementTombstone(
        retirementClaimRequired(directory, retryError), authority,
      );
    }
  }
  synchronizeDirectory(root);
  const reclaimed = reclaimPosixRetainedEvidence(tombstone, root, {
    quiescentMaintenanceAuthority, reclaimRetainedEvidence,
    runNoReplaceMove, synchronizeDirectory,
  });
  if (requireReclaimedRetirement && !reclaimed) {
    throw attachPosixRetirementTombstone(
      new Error('POSIX session retirement evidence remains retained'), authority,
    );
  }
  return true;
}

function readExactJson(file, predicate) {
  try {
    const value = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(value);
    if (value !== canonicalJson(parsed) || !predicate(parsed)) {
      return { error: new Error(`POSIX session record is invalid: ${file}`), state: 'unknown' };
    }
    return { record: parsed, state: 'present' };
  } catch (error) {
    if (error?.code === 'ENOENT') return { state: 'missing' };
    return { error, state: 'unknown' };
  }
}

function readLinuxProcessStat(processId) {
  const value = fs.readFileSync(`/proc/${processId}/stat`, 'utf8');
  const commandEnd = value.lastIndexOf(')');
  if (commandEnd < 1) throw new Error(`Invalid /proc stat for process ${processId}`);
  const fields = value.slice(commandEnd + 2).trim().split(/\s+/u);
  const parsedProcessId = Number(value.slice(0, value.indexOf(' ')));
  const processGroupId = Number(fields[2]);
  const sessionId = Number(fields[3]);
  const startTime = fields[19];
  if (![parsedProcessId, processGroupId, sessionId].every(Number.isSafeInteger)
      || !/^\d+$/u.test(startTime ?? '')) {
    throw new Error(`Invalid /proc identity for process ${processId}`);
  }
  return { processGroupId, processId: parsedProcessId, sessionId, startTime };
}

function readLinuxProcessStatIfPresent(processId) {
  try {
    return { process: readLinuxProcessStat(processId) };
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ESRCH') return { process: null };
    return { error, process: null };
  }
}

function probeLinuxProcessGroup(processGroupId) {
  try {
    // Signal 0 performs an atomic kernel existence/permission check without
    // delivering a signal. ESRCH is the only exact absence result; EPERM still
    // proves that a process group with this numeric identity exists.
    process.kill(-processGroupId, 0);
    return { state: 'exists' };
  } catch (error) {
    if (error?.code === 'ESRCH') return { state: 'absent' };
    if (error?.code === 'EPERM') return { state: 'exists' };
    return { error, state: 'unknown' };
  }
}

export function inspectPosixSession(identity, {
  platform = process.platform,
  probeProcessGroup = probeLinuxProcessGroup,
  readEntries = () => fs.readdirSync('/proc', { withFileTypes: true }),
  readStat = readLinuxProcessStatIfPresent,
} = {}) {
  if (!identity || !Number.isSafeInteger(identity.processGroupId)
      || identity.processGroupId <= 1 || !Number.isSafeInteger(identity.sessionId)
      || identity.sessionId <= 1 || !START_TIME.test(identity.startTime ?? '')) {
    return { error: new Error('POSIX session identity is invalid'), state: 'unknown' };
  }
  if (platform !== 'linux') {
    return {
      error: new Error('Exact POSIX session inspection currently requires Linux /proc'),
      state: 'unknown',
    };
  }
  let group;
  try {
    group = probeProcessGroup(identity.processGroupId);
  } catch (error) {
    return { error, state: 'unknown' };
  }
  if (group?.state === 'absent') return { state: 'absent' };
  if (group?.state !== 'exists') {
    return {
      error: group?.error ?? new Error('POSIX process-group existence probe is invalid'),
      state: 'unknown',
    };
  }
  let entries;
  try {
    entries = readEntries();
  } catch (error) {
    return { error, state: 'unknown' };
  }
  let originalMember = false;
  let reusedMember = false;
  let unreadableError;
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/u.test(entry.name)) continue;
    const result = readStat(Number(entry.name));
    if (result.error) {
      unreadableError ??= result.error;
      continue;
    }
    if (!result.process || result.process.processGroupId !== identity.processGroupId) continue;
    if (result.process.sessionId === identity.sessionId) originalMember = true;
    else reusedMember = true;
  }
  if (originalMember) return { state: 'alive' };
  if (reusedMember) return { state: 'reused' };
  if (unreadableError) return { error: unreadableError, state: 'unknown' };
  return {
    error: new Error('POSIX process group exists but its membership identity was not proven'),
    state: 'unknown',
  };
}

function controlPaths(directory) {
  return Object.freeze({
    controlFile: path.join(directory, 'control.json'),
    killAckPath: path.join(directory, 'kill.ack'),
    killArmedPath: path.join(directory, 'kill-armed.proof'),
    killRequestPath: path.join(directory, 'kill.request'),
    proofPath: path.join(directory, 'session-settled.proof'),
    readyPath: path.join(directory, 'ready.proof'),
    statusPath: path.join(directory, 'target-status.proof'),
    startupClaimPath: path.join(directory, 'startup.claim'),
    termAckPath: path.join(directory, 'term.ack'),
    termRequestPath: path.join(directory, 'term.request'),
  });
}

function posixRetirementClaimPath(directory) {
  return path.join(directory, 'retirement.claim');
}

function posixRecoveryBatonPath(directory, currentPath, owner) {
  const token = createHash('sha256')
    .update(`easyboost-posix-session-recovery-baton-v1\0${path.basename(currentPath)}\0${owner}`,
      'utf8')
    .digest('hex');
  return path.join(directory, `.recovery-baton.${token}.claim`);
}

function exactPosixRecoveryScope(scope) {
  return scope === null || (typeof scope === 'string'
    && Buffer.byteLength(scope, 'utf8') <= POSIX_SESSION_RECOVERY_CLAIM_MAX_BYTES);
}

function posixPathIsAbsent(file) {
  try {
    fs.lstatSync(file);
    return false;
  } catch (error) {
    if (error?.code === 'ENOENT') return true;
    throw error;
  }
}

function exactPosixRecoveryResult(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return false;
  const keys = Object.keys(record).sort();
  if (JSON.stringify(keys) === JSON.stringify(['absence', 'state'])) {
    return record.absence === 'absent'
      && (record.state === 'incomplete' || record.state === 'not-created');
  }
  const exactIdentity = Number.isSafeInteger(record.processGroupId)
    && record.processGroupId > 1 && Number.isSafeInteger(record.sessionId)
    && record.sessionId > 1;
  if (JSON.stringify(keys) === JSON.stringify(['processGroupId', 'sessionId', 'state'])) {
    return exactIdentity && record.state === 'absent';
  }
  return JSON.stringify(keys)
      === JSON.stringify(['absence', 'processGroupId', 'sessionId', 'state'])
    && record.absence === 'absent' && exactIdentity && record.state === 'incomplete';
}

function exactPosixRecoveryState(record) {
  return record && typeof record === 'object' && !Array.isArray(record)
    && JSON.stringify(Object.keys(record).sort()) === JSON.stringify(['fingerprint', 'result'])
    && TOKEN.test(record.fingerprint ?? '') && exactPosixRecoveryResult(record.result);
}

function canonicalPosixRecoveryResult(record) {
  if (!exactPosixRecoveryResult(record)) {
    throw new Error('POSIX session recovery semantic result is invalid');
  }
  return Object.freeze(Object.fromEntries(
    Object.keys(record).sort().map((key) => [key, record[key]]),
  ));
}

function canonicalPosixRecoveryState(fingerprint, result) {
  const state = Object.freeze({
    fingerprint,
    result: canonicalPosixRecoveryResult(result),
  });
  if (!exactPosixRecoveryState(state)) {
    throw new Error('POSIX session recovery semantic state is invalid');
  }
  return state;
}

function exactPosixRetirementClaim(record) {
  return record && typeof record === 'object' && !Array.isArray(record)
    && record.event === 'RETIREMENT_CLAIM'
    && record.protocol === POSIX_SESSION_CONTROL_PROTOCOL
    && TOKEN.test(record.owner ?? '')
    && (record.purpose === 'DISPOSE' || record.purpose === 'RECOVERY')
    && exactPosixRecoveryScope(record.recoveryScope)
      && exactPosixRecoveryState(record.recoveryState)
      && JSON.stringify(Object.keys(record).sort())
        === JSON.stringify([
          'event', 'owner', 'protocol', 'purpose', 'recoveryScope', 'recoveryState',
        ]);
}

function collectPosixRecoveryBatonChain(directory, {
  expectedOwner,
  expectedScope,
} = {}) {
  const names = fs.readdirSync(directory);
  if (names.length > POSIX_SESSION_RECOVERY_BATON_MAX_LINKS + 16) {
    throw new Error('POSIX session recovery baton namespace is unbounded');
  }
  const candidateNames = names.filter((name) => name === 'retirement.claim'
    || /^\.recovery-baton\.[a-f0-9]{64}\.claim$/u.test(name));
  if (candidateNames.length === 0) return null;
  if (candidateNames.length > POSIX_SESSION_RECOVERY_BATON_MAX_LINKS) {
    throw new Error('POSIX session recovery baton chain is unbounded');
  }
  const originPath = posixRetirementClaimPath(directory);
  if (!candidateNames.includes(path.basename(originPath))) {
    throw new Error('POSIX session recovery baton chain has no durable origin');
  }
  const origin = readExactJson(originPath, exactPosixRetirementClaim);
  const originIdentity = fs.lstatSync(originPath);
  if (origin.state !== 'present'
      || (origin.record.purpose !== 'RECOVERY' && origin.record.purpose !== 'DISPOSE')
      || !originIdentity.isFile() || originIdentity.isSymbolicLink()
      || originIdentity.nlink < 1
      || originIdentity.nlink > POSIX_SESSION_RECOVERY_BATON_MAX_LINKS
      || (expectedOwner !== undefined && origin.record.owner !== expectedOwner)
      || (expectedScope !== undefined && origin.record.recoveryScope !== expectedScope)) {
    throw new Error('POSIX session recovery baton origin is invalid');
  }
  const visited = [];
  let currentPath = originPath;
  while (true) {
    const observed = readExactJson(currentPath, exactPosixRetirementClaim);
    const identity = fs.lstatSync(currentPath);
    if (observed.state !== 'present'
        || canonicalJson(observed.record) !== canonicalJson(origin.record)
        || !identity.isFile() || identity.isSymbolicLink()
        || !sameFileIdentity(originIdentity, identity)) {
      throw new Error('POSIX session recovery baton chain changed during proof');
    }
    visited.push(path.basename(currentPath));
    if (visited.length > POSIX_SESSION_RECOVERY_BATON_MAX_LINKS) {
      throw new Error('POSIX session recovery baton chain is unbounded');
    }
    const successor = posixRecoveryBatonPath(
      directory, currentPath, origin.record.owner,
    );
    if (posixPathIsAbsent(successor)) break;
    currentPath = successor;
  }
  if (candidateNames.length !== visited.length
      || candidateNames.some((name) => !visited.includes(name))) {
    throw new Error('POSIX session recovery baton chain is forked or invalid');
  }
  const tipIdentity = fs.lstatSync(currentPath);
  if (Number(tipIdentity.nlink) !== visited.length) {
    throw new Error('POSIX session recovery baton link count is invalid');
  }
  return Object.freeze({
    identity: tipIdentity,
    names: Object.freeze(visited),
    owner: origin.record.owner,
    path: currentPath,
    purpose: origin.record.purpose,
    record: origin.record,
    recoveryScope: origin.record.recoveryScope,
    recoveryState: origin.record.recoveryState,
  });
}

function retirementClaimRequired(directory, cause) {
  const error = recoveryRequired(directory, cause);
  error.message = `POSIX_SESSION_RETIREMENT_CLAIM_REQUIRED: ${directory}`;
  error.code = 'POSIX_SESSION_RETIREMENT_CLAIM_REQUIRED';
  let publicationResidue;
  try {
    publicationResidue = normalizePosixSessionPublicationResidue(
      cause?.recoveryAuthority, directory,
    );
  } catch {}
  const retirement = exactPosixRetirementTombstoneAuthority(
    cause?.recoveryAuthority, directory,
  );
  const recoveryHandoff = cause?.recoveryHandoff
    ?? cause?.recoveryAuthority?.recoveryHandoff;
  if (retirement !== null) {
    error.recoveryAuthority = retirement;
  } else if (publicationResidue || recoveryHandoff) {
    error.recoveryAuthority = Object.freeze({
      controlDirectory: directory,
      ...(publicationResidue ? { publicationResidue } : {}),
      ...(recoveryHandoff ? { recoveryHandoff } : {}),
    });
  }
  if (recoveryHandoff) {
    Object.defineProperty(error, 'recoveryHandoff', {
      configurable: true, value: recoveryHandoff,
    });
  }
  return error;
}

function attachPosixRetirementTombstone(error, authority) {
  error.recoveryAuthority = authority;
  return error;
}

function acquirePosixRetirementClaim(directory, {
  owner = randomBytes(32).toString('hex'),
  purpose = 'DISPOSE',
  recoveryScope = null,
  recoveryState,
} = {}) {
  const claimPath = posixRetirementClaimPath(directory);
  const expected = Object.freeze({
    event: 'RETIREMENT_CLAIM',
    owner,
    protocol: POSIX_SESSION_CONTROL_PROTOCOL,
    purpose,
    recoveryScope,
    recoveryState,
  });
  const value = canonicalJson(expected);
  if (!exactPosixRetirementClaim(expected)
      || Buffer.byteLength(value, 'utf8') > POSIX_SESSION_RECOVERY_CLAIM_MAX_BYTES) {
    throw new Error('POSIX session retirement claim is invalid or unbounded');
  }
  try {
    durableExclusiveWrite(claimPath, value);
  } catch (error) {
    if (error?.code !== 'EEXIST') throw retirementClaimRequired(directory, error);
  }
  const observed = readExactJson(claimPath, exactPosixRetirementClaim);
  if (observed.state !== 'present' || canonicalJson(observed.record) !== value) {
    throw retirementClaimRequired(directory,
      observed.error ?? new Error('POSIX session retirement is already claimed'));
  }
  const identity = fs.lstatSync(claimPath);
  if (!identity.isFile() || identity.isSymbolicLink() || identity.nlink !== 1) {
    throw retirementClaimRequired(directory,
      new Error('POSIX session retirement claim is not a private regular file'));
  }
  return Object.freeze({
    identity,
    owner: expected.owner,
    path: claimPath,
    purpose: expected.purpose,
    record: expected,
    recoveryScope: expected.recoveryScope ?? null,
    recoveryState: expected.recoveryState,
  });
}

function revalidatePosixRetirementClaim({
  claim,
  directory,
  directoryIdentity,
  retirementSourceIdentity,
  root,
  rootIdentity,
}) {
  try {
    const currentRoot = safeOwnedRecoveryDirectory(root, 'POSIX session control root');
    const currentDirectory = safeOwnedRecoveryDirectory(directory, 'POSIX session control directory');
    const currentDirectoryExact = safeOwnedRecoveryDirectoryExactIdentity(
      directory, 'POSIX session control directory',
    );
    const chain = collectPosixRecoveryBatonChain(directory, {
      expectedOwner: claim.owner,
      expectedScope: claim.recoveryScope,
    });
    const currentClaim = chain?.identity ?? fs.lstatSync(claim.path);
    const observed = readExactJson(chain?.path ?? claim.path, exactPosixRetirementClaim);
    if (!sameFileIdentity(rootIdentity, currentRoot)
        || !sameFileIdentity(directoryIdentity, currentDirectory)
        || !sameFileIdentity(retirementSourceIdentity, currentDirectoryExact)
        || !sameFileIdentity(claim.identity, currentClaim)
        || chain?.path !== claim.path
        || observed.state !== 'present' || observed.record.owner !== claim.owner
        || canonicalJson(observed.record) !== canonicalJson(claim.record)) {
      throw new Error('POSIX session retirement authority changed before removal');
    }
  } catch (error) {
    throw retirementClaimRequired(directory, error);
  }
}

function recoveryRequired(directory, cause) {
  const error = new Error(`POSIX_SESSION_RECOVERY_REQUIRED: ${directory}`, cause ? { cause } : {});
  error.childSettlementUnproven = true;
  error.code = 'POSIX_SESSION_RECOVERY_REQUIRED';
  error.recoveryAuthority = Object.freeze({ controlDirectory: directory });
  return error;
}

function controlDirectoryName(controlKey) {
  if (typeof controlKey !== 'string' || !controlKey) {
    throw new Error('POSIX session controlKey must be a non-empty deterministic scope key');
  }
  return createHash('sha256').update(controlKey, 'utf8').digest('hex');
}

// A control root is part of the authority boundary, not merely a convenient
// parent directory.  `mkdir({recursive:true})` follows a pre-existing link on
// every supported platform, so establish the directory first and then inspect
// its own inode.  Callers retain this identity across child creation so an
// attacker cannot substitute the root between those two operations.
function establishOwnedControlRoot(controlRoot, label) {
  fs.mkdirSync(controlRoot, { mode: 0o700, recursive: true });
  const before = safeOwnedRecoveryDirectory(controlRoot, label);
  // This establishment fsync must not consume the injectable post-disposal
  // durability seam; production still performs the real parent sync here.
  syncDirectory(controlRoot);
  const after = safeOwnedRecoveryDirectory(controlRoot, label);
  if (!sameFileIdentity(before, after)) {
    throw new Error(`${label} changed while being established`);
  }
  return after;
}

function revalidateOwnedControlRoot(controlRoot, expected, label) {
  const current = safeOwnedRecoveryDirectory(controlRoot, label);
  if (!sameFileIdentity(expected, current)) {
    throw new Error(`${label} changed during control creation`);
  }
  return current;
}

export function createPosixSessionControl({
  controlKey,
  controlRoot = path.join(os.tmpdir(), 'easyboost-posix-session-controls'),
  inspectSession = inspectPosixSession,
  noReplacePlatform = process.platform,
  quiescentMaintenanceAuthority,
  reclaimRetainedEvidence,
  runNoReplaceMove = spawnSync,
  syncControlRoot = syncDirectory,
  writeControlRecord = durableExclusiveWrite,
} = {}) {
  const rootIdentity = establishOwnedControlRoot(
    controlRoot, 'POSIX session control root',
  );
  const directory = path.join(controlRoot, controlDirectoryName(controlKey));
  let directoryCreated = false;
  try {
    fs.mkdirSync(directory, { mode: 0o700 });
    directoryCreated = true;
  } catch (error) {
    if (error?.code === 'EEXIST') throw recoveryRequired(directory, error);
    throw error;
  }
  const paths = controlPaths(directory);
  const controlToken = randomBytes(32).toString('hex');
  const proofToken = randomBytes(32).toString('hex');
  const specification = Object.freeze({
    ...paths,
    controlDirectory: directory,
    controlProtocol: POSIX_SESSION_CONTROL_PROTOCOL,
    controlToken,
    proofProtocol: POSIX_SESSION_PROOF_PROTOCOL,
    proofToken,
  });
  try {
    revalidateOwnedControlRoot(controlRoot, rootIdentity, 'POSIX session control root');
    syncControlRoot(controlRoot);
    revalidateOwnedControlRoot(controlRoot, rootIdentity, 'POSIX session control root');
    writeControlRecord(paths.controlFile, canonicalJson(specification));
    const startupClaim = readStartupClaim(specification);
    if (startupClaim.state !== 'missing') {
      throw startupClaim.error
        ?? new Error(`POSIX session startup is already claimed for ${startupClaim.record.kind.toLowerCase()}`);
    }
  } catch (cause) {
    if (!directoryCreated) throw cause;
    const recovery = recoveryRequired(directory, cause);
    const publication = cause?.recoveryAuthority;
    if (publication?.destination && publication?.temporary) {
      recovery.recoveryAuthority = Object.freeze({
        controlDirectory: directory,
        destination: publication.destination,
        ...(publication.sourceBinding === undefined ? {} : {
          sourceBinding: publication.sourceBinding,
        }),
        temporary: publication.temporary,
        ...(publication.tombstone === undefined ? {} : { tombstone: publication.tombstone }),
      });
    }
    throw recovery;
  }
  let disposed = false;
  let exactSettlementProven = false;
  let launchState = 'never-launched';
  let removalComplete = false;
  let retirementTombstone = null;
  let wrapperClosed = false;
  const proofRecord = (file, event) => readExactJson(file, (record) => (
    record.event === event
      && record.protocol === POSIX_SESSION_PROOF_PROTOCOL
      && record.token === proofToken
  ));
  const readyState = () => readExactJson(paths.readyPath, (record) => (
    record.event === 'READY'
      && record.processGroupId === record.wrapperPid
      && record.protocol === POSIX_SESSION_PROOF_PROTOCOL
      && record.sessionId === record.wrapperPid
      && START_TIME.test(record.startTime ?? '')
      && record.token === proofToken
  ));
  const request = (signal) => {
    if (disposed) throw new Error('POSIX session control is already disposed');
    if (signal !== 'SIGTERM' && signal !== 'SIGKILL') {
      throw new Error('POSIX session control signal must be SIGTERM or SIGKILL');
    }
    const requestPath = signal === 'SIGTERM' ? paths.termRequestPath : paths.killRequestPath;
    const value = canonicalJson({
      protocol: POSIX_SESSION_CONTROL_PROTOCOL,
      signal,
      token: controlToken,
    });
    try {
      durableExclusiveWrite(requestPath, value);
    } catch (error) {
      if (error?.code !== 'EEXIST' || fs.readFileSync(requestPath, 'utf8') !== value) throw error;
    }
    return true;
  };
  const control = {
    dispose({
      beforeRetirementValidation = () => {},
      force = false,
      recoveryScope = null,
    } = {}) {
      if (disposed) return;
      if (typeof beforeRetirementValidation !== 'function') {
        throw new Error('POSIX session retirement validation hook is invalid');
      }
      if (!exactPosixRecoveryScope(recoveryScope)) {
        throw new Error('POSIX session disposal recovery scope is invalid');
      }
      const proof = this.proofState();
      if (!force && proof.state !== 'absent') return;
      if (force && launchState !== 'never-launched' && proof.state !== 'absent') {
        throw new Error('POSIX_SESSION_FORCE_DISPOSE_FORBIDDEN');
      }
      if (proof.state === 'absent') exactSettlementProven = true;
      if (!removalComplete) {
        assertNoPosixPublicationResidue(controlRoot, directory);
        const rootIdentity = safeOwnedRecoveryDirectory(controlRoot, 'POSIX session control root');
        const directoryIdentity = safeOwnedRecoveryDirectory(
          directory, 'POSIX session control directory',
        );
        const retirementSourceIdentity = safeOwnedRecoveryDirectoryExactIdentity(
          directory, 'POSIX session control directory',
        );
        const recoveryState = canonicalPosixRecoveryState(
          recoveryDirectoryFingerprint(directory),
          { absence: 'absent', state: 'incomplete' },
        );
        const claim = acquirePosixRetirementClaim(directory, { recoveryScope, recoveryState });
        const handoff = posixSessionRecoveryHandoff({
          claimPath: claim.path,
          controlDirectory: directory,
          controlKey,
          controlRoot,
          recoveryScope: claim.recoveryScope,
          retirementOwner: claim.owner,
        });
        try {
          beforeRetirementValidation();
          revalidatePosixRetirementClaim({
            claim,
            directory,
            directoryIdentity,
            retirementSourceIdentity,
            root: controlRoot,
            rootIdentity,
          });
          const batonNames = exactPosixRecoveryBatonNames(directory, { claim });
          if (recoveryDirectoryFingerprint(directory, { ignoreNames: batonNames })
              !== recoveryState.fingerprint) {
            throw new Error('POSIX session disposal authority changed after its claim');
          }
          retirementTombstone = moveOwnedPosixControlDirectory({
            directory,
            directoryIdentity,
            retirementSourceIdentity,
            root: controlRoot,
            rootIdentity,
            noReplacePlatform,
            runNoReplaceMove,
          });
          removalComplete = true;
        } catch (error) {
          if (error?.recoveryAuthority?.tombstone) throw error;
          throw attachPosixSessionRecoveryHandoff(error, handoff);
        }
      }
      try { syncControlRoot(controlRoot); } catch (error) {
        throw retirementTombstone
          ? attachPosixRetirementTombstone(error, retirementTombstone.authority)
          : error;
      }
      if (retirementTombstone) {
        try {
          reclaimPosixRetainedEvidence(retirementTombstone.container, controlRoot, {
            quiescentMaintenanceAuthority, reclaimRetainedEvidence, runNoReplaceMove,
          });
        } catch (error) {
          throw attachPosixRetirementTombstone(error, retirementTombstone.authority);
        }
      }
      disposed = true;
      return retirementTombstone && !posixPathIsAbsent(retirementTombstone.container)
        ? retirementTombstone.authority : undefined;
    },
    markWrapperSpawned() {
      if (disposed || removalComplete) {
        throw new Error('POSIX session control is already disposed');
      }
      launchState = 'launched';
    },
    observeWrapperClose() {
      wrapperClosed = true;
    },
    proofState() {
      if (exactSettlementProven) return { state: 'absent' };
      if (disposed) return { state: 'unknown' };
      const ready = readyState();
      if (ready.state !== 'present') return ready.state === 'missing'
        ? { state: wrapperClosed ? 'unknown' : 'alive' }
        : { error: ready.error, state: 'unknown' };
      const clean = proofRecord(paths.proofPath, 'SESSION_DRAINED');
      const killArmed = proofRecord(paths.killArmedPath, 'KILL_ARMED');
      if (!wrapperClosed) return { state: 'alive' };
      if (clean.state !== 'present' && killArmed.state !== 'present') {
        return { error: clean.error || killArmed.error, state: 'unknown' };
      }
      let inspected;
      try {
        inspected = inspectSession({
          processGroupId: ready.record.processGroupId,
          sessionId: ready.record.sessionId,
          startTime: ready.record.startTime,
        });
      } catch (error) {
        inspected = { error, state: 'unknown' };
      }
      if (inspected?.state === 'absent') {
        exactSettlementProven = true;
        return { state: 'absent' };
      }
      if (inspected?.state === 'reused') {
        return {
          error: new Error('POSIX session numeric identity was reused before absence proof'),
          state: 'unknown',
        };
      }
      return inspected?.state === 'alive' ? { state: 'alive' } : {
        error: inspected?.error,
        state: 'unknown',
      };
    },
    readyState,
    request,
    requestState(signal) {
      const ackPath = signal === 'SIGTERM' ? paths.termAckPath : paths.killAckPath;
      return proofRecord(ackPath, signal === 'SIGTERM' ? 'TERM_ACK' : 'KILL_ACK');
    },
    specification,
    targetStatus() {
      const result = proofRecord(paths.statusPath, 'TARGET_STATUS');
      return result.state === 'present'
        ? { ...result.record, state: 'present' }
        : { error: result.error, state: result.state };
    },
  };
  return Object.freeze(control);
}

function exactRecoveredPosixControl(value, directory) {
  const paths = controlPaths(directory);
  const expectedKeys = [
    'controlDirectory', 'controlFile', 'controlProtocol', 'controlToken', 'killAckPath',
    'killArmedPath', 'killRequestPath', 'proofPath', 'proofProtocol', 'proofToken', 'readyPath',
    'startupClaimPath', 'statusPath', 'termAckPath', 'termRequestPath',
  ];
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(expectedKeys.sort())
      || value.controlDirectory !== directory
      || value.controlProtocol !== POSIX_SESSION_CONTROL_PROTOCOL
      || value.proofProtocol !== POSIX_SESSION_PROOF_PROTOCOL
      || !TOKEN.test(value.controlToken ?? '') || !TOKEN.test(value.proofToken ?? '')) {
    throw new Error('POSIX session recovery control record is invalid');
  }
  for (const [name, expected] of Object.entries(paths)) {
    if (value[name] !== expected) throw new Error('POSIX session recovery control paths are invalid');
  }
  return Object.freeze({ ...value });
}

function exactRecoveryProof(record, event, token) {
  return record && typeof record === 'object' && !Array.isArray(record)
    && record.event === event && record.protocol === POSIX_SESSION_PROOF_PROTOCOL
    && record.token === token;
}

function startupClaimRecord(specification, { kind, identity } = {}) {
  if (kind === 'RECOVERY') {
    return Object.freeze({
      event: 'STARTUP_CLAIM',
      kind,
      protocol: POSIX_SESSION_PROOF_PROTOCOL,
    });
  }
  if (kind === 'LAUNCH' && identity
      && identity.processGroupId === identity.processId
      && identity.sessionId === identity.processId
      && Number.isSafeInteger(identity.processId)
      && START_TIME.test(identity.startTime ?? '')) {
    return Object.freeze({
      event: 'STARTUP_CLAIM',
      kind,
      processGroupId: identity.processGroupId,
      protocol: POSIX_SESSION_PROOF_PROTOCOL,
      sessionId: identity.sessionId,
      startTime: identity.startTime,
      token: specification.proofToken,
      wrapperPid: identity.processId,
    });
  }
  throw new Error('POSIX session startup claim is invalid');
}

function readStartupClaim(specification) {
  return readExactJson(specification.startupClaimPath, (record) => {
    try {
      return canonicalJson(startupClaimRecord(specification, {
        identity: record.kind === 'LAUNCH' ? {
          processGroupId: record.processGroupId,
          processId: record.wrapperPid,
          sessionId: record.sessionId,
          startTime: record.startTime,
        } : undefined,
        kind: record.kind,
      })) === canonicalJson(record);
    } catch {
      return false;
    }
  });
}

function publishPosixSessionStartupClaim(specification, claim) {
  const value = canonicalJson(claim);
  try {
    durableExclusiveWrite(specification.startupClaimPath, value);
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
  const observed = readStartupClaim(specification);
  if (observed.state !== 'present') {
    throw observed.error ?? new Error('POSIX session startup claim publication is unproven');
  }
  return observed.record;
}

function publishRecoveryStartupClaim(startupClaimPath) {
  return publishPosixSessionStartupClaim(
    { startupClaimPath },
    startupClaimRecord(undefined, { kind: 'RECOVERY' }),
  );
}

// LAUNCH and RECOVERY compete for one no-replace durable pathname. A wrapper
// may publish READY and spawn only after it wins LAUNCH; recovery may retire a
// READY-less control only after it wins RECOVERY. This closes the former
// final-control-read -> READY-write -> rm -> target-spawn race.
export function claimPosixSessionStartup(specification, options) {
  const expected = startupClaimRecord(specification, options);
  const observed = publishPosixSessionStartupClaim(specification, expected);
  if (canonicalJson(observed) !== canonicalJson(expected)) {
    throw new Error(`POSIX session startup is already claimed for ${observed.kind.toLowerCase()}`);
  }
  return observed;
}

function safeOwnedRecoveryDirectory(directory, label) {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory`);
  }
  // Windows does not expose portable POSIX owner/mode evidence. Its release
  // supervisor has a separate Job Object authority; Linux recovery is only
  // admitted after the stronger owner/mode proof below.
  if (process.platform !== 'win32'
      && (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0)) {
    throw new Error(`${label} has unsafe owner or mode`);
  }
  return stat;
}

function safeOwnedRecoveryDirectoryExactIdentity(directory, label) {
  const stat = fs.lstatSync(directory, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory`);
  }
  if (process.platform !== 'win32'
      && (stat.uid !== BigInt(process.getuid()) || (stat.mode & 0o077n) !== 0n)) {
    throw new Error(`${label} has unsafe owner or mode`);
  }
  return stat;
}

function exactRecoveredProof(record, event, token, keys) {
  return exactRecoveryProof(record, event, token)
    && Object.keys(record).sort().join('\0') === ['event', 'protocol', 'token', ...keys].sort().join('\0');
}

function recoveryDirectoryFingerprint(directory, { ignoreNames = [] } = {}) {
  const directoryBefore = safeOwnedRecoveryDirectory(
    directory, 'POSIX session recovery proof directory',
  );
  const ignored = new Set(ignoreNames);
  const allNames = fs.readdirSync(directory).sort();
  const names = allNames.filter((name) => !ignored.has(name));
  if (names.length > 16) throw new Error('POSIX session recovery proof directory is unbounded');
  const aggregate = createHash('sha256');
  aggregate.update(['directory', directoryBefore.dev, directoryBefore.ino,
    directoryBefore.mode, directoryBefore.uid, directoryBefore.gid].join('\0'));
  for (const name of names) {
    const file = path.join(directory, name);
    const before = fs.lstatSync(file, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n
        || before.size > 65_536n) {
      throw new Error('POSIX session recovery proof record is unsafe or unbounded');
    }
    const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try {
      const opened = fs.fstatSync(descriptor, { bigint: true });
      const bytes = fs.readFileSync(descriptor);
      const after = fs.fstatSync(descriptor, { bigint: true });
      const finalPath = fs.lstatSync(file, { bigint: true });
      if (!sameFileIdentity(before, opened) || !sameFileIdentity(opened, after)
          || !sameFileIdentity(after, finalPath)
          || opened.mode !== after.mode || opened.nlink !== 1n || after.nlink !== 1n
          || opened.size !== BigInt(bytes.length) || after.size !== BigInt(bytes.length)) {
        throw new Error('POSIX session recovery proof record changed during capture');
      }
      aggregate.update([
        '', 'file', name, opened.dev, opened.ino, opened.mode,
        opened.uid, opened.gid, opened.nlink, opened.size, '',
      ].join('\0'));
      aggregate.update(createHash('sha256').update(bytes).digest());
    } finally {
      fs.closeSync(descriptor);
    }
  }
  const directoryAfter = safeOwnedRecoveryDirectory(
    directory, 'POSIX session recovery proof directory',
  );
  const finalNames = fs.readdirSync(directory).sort();
  if (!sameFileIdentity(directoryBefore, directoryAfter)
      || JSON.stringify(allNames) !== JSON.stringify(finalNames)) {
    throw new Error('POSIX session recovery authority changed during proof capture');
  }
  return aggregate.digest('hex');
}

function posixSessionRecoveryHandoff({
  claimPath,
  controlDirectory,
  controlKey,
  controlRoot,
  recoveryScope,
  retirementOwner,
} = {}) {
  return Object.freeze({
    claimPath,
    controlDirectory,
    controlKey,
    controlRoot: path.resolve(controlRoot),
    protocol: POSIX_SESSION_RECOVERY_HANDOFF_PROTOCOL,
    recoveryScope,
    retirementOwner,
  });
}

function attachPosixSessionRecoveryHandoff(error, handoff) {
  const existing = error?.recoveryAuthority;
  if (exactPosixRetirementTombstoneAuthority(existing, handoff.controlDirectory) === null) {
    error.recoveryAuthority = Object.freeze({
      controlDirectory: existing?.controlDirectory ?? handoff.controlDirectory,
      recoveryHandoff: handoff,
    });
  }
  Object.defineProperty(error, 'recoveryHandoff', { configurable: true, value: handoff });
  return error;
}

function posixRecoveryFromChain(
  chain,
  directoryIdentity,
  retirementSourceIdentity,
  rootIdentity,
) {
  return Object.freeze({
    claim: Object.freeze({
      identity: chain.identity,
      owner: chain.owner,
      path: chain.path,
      purpose: chain.purpose,
      record: chain.record,
      recoveryScope: chain.recoveryScope,
      recoveryState: chain.recoveryState,
    }),
    directoryIdentity,
    retirementSourceIdentity,
    rootIdentity,
  });
}

function exactPosixRecoveryBatonNames(directory, recovery) {
  const chain = collectPosixRecoveryBatonChain(directory, {
    expectedOwner: recovery.claim.owner,
    expectedScope: recovery.claim.recoveryScope,
  });
  if (!chain || chain.path !== recovery.claim.path
      || chain.purpose !== recovery.claim.purpose
      || canonicalJson(chain.record) !== canonicalJson(recovery.claim.record)
      || !sameFileIdentity(chain.identity, recovery.claim.identity)) {
    throw new Error('POSIX session recovery baton is no longer current');
  }
  return chain.names;
}

function currentPosixSessionRecoveryHandoff(controlKey, root, directory, {
  expectedOwner,
  expectedScope,
} = {}) {
  const rootIdentity = safeOwnedRecoveryDirectory(
    root, 'POSIX session recovery handoff root',
  );
  const directoryIdentity = safeOwnedRecoveryDirectory(
    directory, 'POSIX session recovery handoff directory',
  );
  const chain = collectPosixRecoveryBatonChain(directory, {
    expectedOwner,
    expectedScope,
  });
  if (!chain) throw new Error('POSIX session recovery baton is missing');
  return posixSessionRecoveryHandoff({
    claimPath: chain.path,
    controlDirectory: directory,
    controlKey,
    controlRoot: root,
    recoveryScope: chain.recoveryScope,
    retirementOwner: chain.owner,
  });
}

function recoveredPosixAuthority(controlKey, semanticResult, {
  controlDirectory,
  controlRoot,
  recoveryScope = null,
  retirementClaim,
} = {}) {
  const result = { ...canonicalPosixRecoveryResult(semanticResult) };
  const ignoredNames = retirementClaim
    ? exactPosixRecoveryBatonNames(controlDirectory, retirementClaim) : [];
  const fingerprint = recoveryDirectoryFingerprint(controlDirectory, {
    ignoreNames: ignoredNames,
  });
  if (retirementClaim?.claim
      && (retirementClaim.claim.recoveryState.fingerprint !== fingerprint
        || canonicalJson(retirementClaim.claim.recoveryState.result) !== canonicalJson(result))) {
    throw retirementClaimRequired(controlDirectory,
      new Error('POSIX session durable recovery state does not match its namespace'));
  }
  const recoveryProof = Object.freeze({});
  RECOVERY_PROOFS.set(recoveryProof, {
    consumed: false,
    controlDirectory,
    controlKey,
    controlRoot: path.resolve(controlRoot),
    fingerprint,
    recoveryScope,
    retirementClaim: retirementClaim?.claim,
    directoryIdentity: retirementClaim?.directoryIdentity,
    retirementSourceIdentity: retirementClaim?.retirementSourceIdentity,
    rootIdentity: retirementClaim?.rootIdentity,
  });
  if (retirementClaim?.claim) {
    const handoff = posixSessionRecoveryHandoff({
      claimPath: retirementClaim.claim.path,
      controlDirectory,
      controlKey,
      controlRoot,
      recoveryScope,
      retirementOwner: retirementClaim.claim.owner,
    });
    Object.defineProperty(result, 'recoveryHandoff', { enumerable: false, value: handoff });
  }
  Object.defineProperty(result, 'recoveryProof', { enumerable: false, value: recoveryProof });
  return Object.freeze(result);
}

function recoveredIncompletePosixAuthority(controlKey, state, {
  fields = {},
  includeAbsence = true,
  ...authority
} = {}) {
  return recoveredPosixAuthority(controlKey, {
    ...fields,
    ...(includeAbsence ? { absence: 'absent' } : {}),
    state,
  }, authority);
}

// Introspection remains non-consuming for diagnostics/tests. Production paired
// recovery uses the single-use operation below.
export function hasPosixSessionRecoveryProof(proof, controlKey) {
  const authority = RECOVERY_PROOFS.get(proof);
  return authority?.controlKey === controlKey && authority.consumed === false
    && authority.pairedConsumed !== true;
}

// Every adoption adds an exclusive deterministic hard-link successor and keeps
// every predecessor. A crash before directory fsync therefore leaves either
// the old tip or a discoverable next tip; no transfer deletes or overwrites a
// pathname. The finite chain remains deliberately small and fail-closed; a
// trusted quiescent-maintenance lease is required to reclaim/reset it safely.
export function resumePosixSessionRecoveryHandoff(handoff, {
  afterBatonMutation = () => {},
  linkBaton = fs.linkSync,
  quiescentMaintenanceAuthority,
  reclaimRetainedEvidence,
  rotateRecoveryBatonEpoch,
  synchronizeDirectory = syncDirectory,
} = {}) {
  const expectedKeys = ['claimPath', 'controlDirectory', 'controlKey', 'controlRoot',
    'protocol', 'recoveryScope', 'retirementOwner'];
  if (!handoff || JSON.stringify(Object.keys(handoff).sort()) !== JSON.stringify(expectedKeys)
      || handoff.protocol !== POSIX_SESSION_RECOVERY_HANDOFF_PROTOCOL
      || typeof handoff.controlKey !== 'string' || !handoff.controlKey
      || typeof handoff.controlRoot !== 'string' || !path.isAbsolute(handoff.controlRoot)
      || path.resolve(handoff.controlRoot) !== handoff.controlRoot
      || typeof handoff.controlDirectory !== 'string' || !path.isAbsolute(handoff.controlDirectory)
      || path.resolve(handoff.controlDirectory) !== handoff.controlDirectory
      || typeof handoff.claimPath !== 'string' || !path.isAbsolute(handoff.claimPath)
      || path.resolve(handoff.claimPath) !== handoff.claimPath
      || !exactPosixRecoveryScope(handoff.recoveryScope)
      || !TOKEN.test(handoff.retirementOwner ?? '')
      || typeof afterBatonMutation !== 'function' || typeof linkBaton !== 'function'
      || (reclaimRetainedEvidence !== undefined
        && typeof reclaimRetainedEvidence !== 'function')
      || typeof synchronizeDirectory !== 'function') {
    throw new Error('POSIX session recovery handoff is invalid');
  }
  const root = path.resolve(handoff.controlRoot);
  const directory = path.resolve(handoff.controlDirectory);
  if (directory !== path.join(root, controlDirectoryName(handoff.controlKey))) {
    throw new Error('POSIX session recovery handoff scope is invalid');
  }
  const rootIdentity = safeOwnedRecoveryDirectory(root, 'POSIX session recovery handoff root');
  const directoryIdentity = safeOwnedRecoveryDirectory(
    directory, 'POSIX session recovery handoff directory',
  );
  const retirementSourceIdentity = safeOwnedRecoveryDirectoryExactIdentity(
    directory, 'POSIX session recovery handoff directory',
  );
  const oldPath = path.resolve(handoff.claimPath);
  const oldName = path.basename(oldPath);
  if (path.dirname(oldPath) !== directory
      || (oldName !== 'retirement.claim'
        && !/^\.recovery-baton\.[a-f0-9]{64}\.claim$/u.test(oldName))) {
    throw new Error('POSIX session recovery baton is invalid');
  }
  let initialChain = collectPosixRecoveryBatonChain(directory, {
    expectedOwner: handoff.retirementOwner,
    expectedScope: handoff.recoveryScope,
  });
  if (!initialChain) {
    throw new Error('POSIX session recovery baton is not owned by this handoff');
  }
  if (!initialChain.names.includes(oldName)) {
    const current = posixSessionRecoveryHandoff({
      claimPath: initialChain.path,
      controlDirectory: directory,
      controlKey: handoff.controlKey,
      controlRoot: root,
      recoveryScope: initialChain.recoveryScope,
      retirementOwner: initialChain.owner,
    });
    throw attachPosixSessionRecoveryHandoff(
      new Error('POSIX session recovery baton durability resolved to a surviving tip'), current,
    );
  }
  if (initialChain.path !== oldPath) {
    const current = posixSessionRecoveryHandoff({
      claimPath: initialChain.path,
      controlDirectory: directory,
      controlKey: handoff.controlKey,
      controlRoot: root,
      recoveryScope: initialChain.recoveryScope,
      retirementOwner: initialChain.owner,
    });
    throw attachPosixSessionRecoveryHandoff(
      new Error('POSIX session recovery baton was already adopted'), current,
    );
  }
  let adoptionPath = oldPath;
  let epochMutated = false;
  if (initialChain.names.length >= POSIX_SESSION_RECOVERY_BATON_MAX_LINKS) {
    const exhausted = new Error('POSIX session recovery baton epoch maintenance is required');
    exhausted.code = 'POSIX_SESSION_RECOVERY_EPOCH_MAINTENANCE_REQUIRED';
    const current = posixSessionRecoveryHandoff({
      claimPath: initialChain.path,
      controlDirectory: directory,
      controlKey: handoff.controlKey,
      controlRoot: root,
      recoveryScope: initialChain.recoveryScope,
      retirementOwner: initialChain.owner,
    });
    if (typeof rotateRecoveryBatonEpoch !== 'function'
        || quiescentMaintenanceAuthority === undefined) {
      throw attachPosixSessionRecoveryHandoff(exhausted, current);
    }
    try {
      const maintenance = validatePosixQuiescentMaintenanceAuthority(
        quiescentMaintenanceAuthority, { controlRoot: root },
      );
      const currentRoot = safeOwnedRecoveryDirectory(
        root, 'POSIX session recovery epoch root',
      );
      if (!sameFileIdentity(rootIdentity, currentRoot)) {
        throw new Error('POSIX session recovery epoch root changed before rotation');
      }
      const rotated = rotateRecoveryBatonEpoch(Object.freeze({
        authority: maintenance,
        directory,
        expectedIdentity: Object.freeze({
          dev: String(initialChain.identity.dev),
          ino: String(initialChain.identity.ino),
        }),
        kind: 'RECOVERY_BATON_EPOCH',
        names: initialChain.names,
        root,
        source: initialChain.path,
      }));
      if (rotated !== true) throw exhausted;
      epochMutated = true;
      // The immutable launcher owns the fd8 process-lifetime flock and this
      // privileged, crash-safe reset. JavaScript only proves its durable
      // postcondition; it never unlinks predecessor pathnames itself.
      synchronizeDirectory(directory);
      const resetRoot = safeOwnedRecoveryDirectory(
        root, 'POSIX session recovery epoch root',
      );
      const resetDirectory = safeOwnedRecoveryDirectory(
        directory, 'POSIX session recovery epoch directory',
      );
      const reset = collectPosixRecoveryBatonChain(directory, {
        expectedOwner: handoff.retirementOwner,
        expectedScope: handoff.recoveryScope,
      });
      if (!sameFileIdentity(rootIdentity, resetRoot)
          || !sameFileIdentity(directoryIdentity, resetDirectory)
          || !reset || reset.names.length !== 1 || reset.names[0] !== 'retirement.claim'
          || Number(reset.identity.nlink) !== 1
          || reset.purpose !== initialChain.purpose
          || canonicalJson(reset.record) !== canonicalJson(initialChain.record)) {
        throw new Error('POSIX session recovery baton epoch reset is invalid');
      }
      initialChain = reset;
      adoptionPath = reset.path;
    } catch (error) {
      try {
        const surviving = currentPosixSessionRecoveryHandoff(
          handoff.controlKey, root, directory, {
            expectedOwner: handoff.retirementOwner,
            expectedScope: handoff.recoveryScope,
          },
        );
        throw attachPosixSessionRecoveryHandoff(error, surviving);
      } catch (handoffError) {
        if (handoffError?.recoveryHandoff) throw handoffError;
        throw attachPosixSessionRecoveryHandoff(error, current);
      }
    }
  }
  const nextPath = posixRecoveryBatonPath(
    directory, adoptionPath, handoff.retirementOwner,
  );
  let batonMutated = false;
  try {
    linkBaton(adoptionPath, nextPath);
    batonMutated = true;
    const linked = fs.lstatSync(nextPath);
    if (!linked.isFile() || linked.isSymbolicLink()
        || !sameFileIdentity(initialChain.identity, linked)
        || Number(linked.nlink) !== initialChain.names.length + 1) {
      throw new Error('POSIX session recovery baton changed during adoption');
    }
    const nextHandoff = posixSessionRecoveryHandoff({
      claimPath: nextPath,
      controlDirectory: directory,
      controlKey: handoff.controlKey,
      controlRoot: root,
      recoveryScope: initialChain.recoveryScope,
      retirementOwner: initialChain.owner,
    });
    afterBatonMutation(nextHandoff);
    synchronizeDirectory(directory);
    const currentRoot = safeOwnedRecoveryDirectory(
      root, 'POSIX session recovery handoff root',
    );
    const currentDirectory = safeOwnedRecoveryDirectory(
      directory, 'POSIX session recovery handoff directory',
    );
    if (!sameFileIdentity(rootIdentity, currentRoot)
        || !sameFileIdentity(directoryIdentity, currentDirectory)) {
      throw new Error('POSIX session recovery namespace changed during baton adoption');
    }
    const finalChain = collectPosixRecoveryBatonChain(directory, {
      expectedOwner: handoff.retirementOwner,
      expectedScope: handoff.recoveryScope,
    });
    if (!finalChain || finalChain.path !== nextPath
        || finalChain.names.length !== initialChain.names.length + 1) {
      throw new Error('POSIX session recovery baton changed during adoption');
    }
    const fingerprint = recoveryDirectoryFingerprint(directory, {
      ignoreNames: finalChain.names,
    });
    if (fingerprint !== finalChain.recoveryState.fingerprint) {
      throw new Error('POSIX session recovery namespace changed during baton adoption');
    }
    const finalRoot = safeOwnedRecoveryDirectory(root, 'POSIX session recovery control root');
    const finalDirectory = safeOwnedRecoveryDirectory(
      directory, 'POSIX session recovery control directory',
    );
    if (!sameFileIdentity(rootIdentity, finalRoot)
        || !sameFileIdentity(directoryIdentity, finalDirectory)) {
      throw new Error('POSIX session recovery namespace changed before handoff publication');
    }
    const retirement = posixRecoveryFromChain(
      finalChain, directoryIdentity, retirementSourceIdentity, rootIdentity,
    );
    return recoveredPosixAuthority(handoff.controlKey, finalChain.recoveryState.result, {
      controlDirectory: directory,
      controlRoot: root,
      recoveryScope: finalChain.recoveryScope,
      retirementClaim: retirement,
    });
  } catch (error) {
    if (epochMutated || batonMutated || !posixPathIsAbsent(nextPath)) {
      try {
        const current = currentPosixSessionRecoveryHandoff(
          handoff.controlKey, root, directory, {
            expectedOwner: handoff.retirementOwner,
            expectedScope: handoff.recoveryScope,
          },
        );
        const adoptionError = !batonMutated && error?.code === 'EEXIST'
          ? new Error('POSIX session recovery baton was already adopted', { cause: error })
          : error;
        throw attachPosixSessionRecoveryHandoff(adoptionError, current);
      } catch (handoffError) {
        if (handoffError?.recoveryHandoff) throw handoffError;
      }
    }
    throw error;
  }
}

export function consumePosixSessionRecoveryProof(proof, {
  controlKey,
  controlRoot,
  recoveryScope = null,
} = {}) {
  const authority = RECOVERY_PROOFS.get(proof);
  if (!authority || authority.consumed || authority.pairedConsumed === true
      || authority.controlKey !== controlKey
      || authority.controlRoot !== path.resolve(controlRoot)
      || authority.recoveryScope !== recoveryScope) return false;
  let fingerprint;
  try {
    const batonNames = authority.retirementClaim
      ? exactPosixRecoveryBatonNames(authority.controlDirectory, {
        claim: authority.retirementClaim,
      }) : [];
    fingerprint = recoveryDirectoryFingerprint(authority.controlDirectory, {
      ignoreNames: batonNames,
    });
  } catch {
    return false;
  }
  if (fingerprint !== authority.fingerprint) return false;
  authority.pairedConsumed = true;
  return true;
}

// The process-local proof binds the live claim inode, root/directory identities
// and semantic fingerprint. Its separately exposed durable handoff can be
// serialized across a restart, but adoption must first rotate that exact claim
// inode and re-prove the semantic state stored inside it.
export function completePosixSessionRecovery(proof, {
  controlKey,
  controlRoot,
  quiescentMaintenanceAuthority,
  reclaimRetainedEvidence,
  recoveryScope = null,
  requireReclaimedRetirement = false,
  syncControlRoot = syncDirectory,
} = {}) {
  const authority = RECOVERY_PROOFS.get(proof);
  if (!authority || authority.consumed || !authority.retirementClaim
      || authority.controlKey !== controlKey
      || authority.controlRoot !== path.resolve(controlRoot)
      || authority.recoveryScope !== recoveryScope) {
    throw new Error('POSIX session recovery handoff is invalid');
  }
  try {
    assertNoPosixPublicationResidue(authority.controlRoot, authority.controlDirectory);
    const recovery = {
      claim: authority.retirementClaim,
      directoryIdentity: authority.directoryIdentity,
      retirementSourceIdentity: authority.retirementSourceIdentity,
      rootIdentity: authority.rootIdentity,
    };
    const batonNames = exactPosixRecoveryBatonNames(authority.controlDirectory, recovery);
    revalidatePosixRetirementClaim({
      claim: authority.retirementClaim,
      directory: authority.controlDirectory,
      directoryIdentity: authority.directoryIdentity,
      retirementSourceIdentity: authority.retirementSourceIdentity,
      root: authority.controlRoot,
      rootIdentity: authority.rootIdentity,
    });
    if (recoveryDirectoryFingerprint(authority.controlDirectory, {
      ignoreNames: batonNames,
    }) !== authority.fingerprint) {
      throw new Error('POSIX session recovery authority changed before handoff retirement');
    }
    const tombstone = moveOwnedPosixControlDirectory({
      directory: authority.controlDirectory,
      directoryIdentity: authority.directoryIdentity,
      retirementSourceIdentity: authority.retirementSourceIdentity,
      root: authority.controlRoot,
      rootIdentity: authority.rootIdentity,
    });
    try {
      syncControlRoot(authority.controlRoot);
    } catch (error) {
      throw attachPosixRetirementTombstone(error, tombstone.authority);
    }
    try {
      const reclaimed = reclaimPosixRetainedEvidence(tombstone.container, authority.controlRoot, {
        quiescentMaintenanceAuthority, reclaimRetainedEvidence,
      });
      if (requireReclaimedRetirement && !reclaimed) {
        throw new Error('POSIX session recovery retirement evidence remains retained');
      }
    } catch (error) {
      throw attachPosixRetirementTombstone(error, tombstone.authority);
    }
    authority.consumed = true;
    return true;
  } catch (error) {
    throw retirementClaimRequired(authority.controlDirectory, error);
  }
}

function acquirePosixRecoveryRetirement(
  directory,
  root,
  controlKey,
  recoveryScope,
  semanticResult,
) {
  const rootIdentity = safeOwnedRecoveryDirectory(root, 'POSIX session recovery control root');
  const directoryIdentity = safeOwnedRecoveryDirectory(
    directory, 'POSIX session recovery control directory',
  );
  const retirementSourceIdentity = safeOwnedRecoveryDirectoryExactIdentity(
    directory, 'POSIX session recovery control directory',
  );
  const recoveryState = canonicalPosixRecoveryState(
    recoveryDirectoryFingerprint(directory), semanticResult,
  );
  const claim = acquirePosixRetirementClaim(directory, {
    purpose: 'RECOVERY', recoveryScope, recoveryState,
  });
  const retirement = Object.freeze({
    claim, directoryIdentity, retirementSourceIdentity, rootIdentity,
  });
  const handoff = posixSessionRecoveryHandoff({
    claimPath: claim.path,
    controlDirectory: directory,
    controlKey,
    controlRoot: root,
    recoveryScope,
    retirementOwner: claim.owner,
  });
  try {
    revalidatePosixRetirementClaim({
      claim,
      directory,
      directoryIdentity,
      retirementSourceIdentity,
      root,
      rootIdentity,
    });
    const batonNames = exactPosixRecoveryBatonNames(directory, retirement);
    if (recoveryDirectoryFingerprint(directory, { ignoreNames: batonNames })
        !== recoveryState.fingerprint) {
      throw new Error('POSIX session recovery namespace changed while claiming retirement');
    }
    return retirement;
  } catch (error) {
    throw attachPosixSessionRecoveryHandoff(error, handoff);
  }
}

function retirePosixRecoveryNamespace({
  directory,
  recoveryProof,
  recovery,
  quiescentMaintenanceAuthority,
  reclaimRetainedEvidence,
  root,
  syncControlRoot,
} = {}) {
  assertNoPosixPublicationResidue(root, directory);
  const batonNames = exactPosixRecoveryBatonNames(directory, recovery);
  revalidatePosixRetirementClaim({
    claim: recovery.claim,
    directory,
    directoryIdentity: recovery.directoryIdentity,
    retirementSourceIdentity: recovery.retirementSourceIdentity,
    root,
    rootIdentity: recovery.rootIdentity,
  });
  const authority = RECOVERY_PROOFS.get(recoveryProof);
  if (!authority || recoveryDirectoryFingerprint(directory, {
    ignoreNames: batonNames,
  }) !== authority.fingerprint) {
    throw retirementClaimRequired(directory,
      new Error('POSIX session recovery authority changed before removal'));
  }
  const tombstone = moveOwnedPosixControlDirectory({
    directory,
    directoryIdentity: recovery.directoryIdentity,
    retirementSourceIdentity: recovery.retirementSourceIdentity,
    root,
    rootIdentity: recovery.rootIdentity,
  });
  try {
    syncControlRoot(root);
  } catch (error) {
    throw attachPosixRetirementTombstone(error, tombstone.authority);
  }
  try {
    reclaimPosixRetainedEvidence(tombstone.container, root, {
      quiescentMaintenanceAuthority, reclaimRetainedEvidence,
    });
  } catch (error) {
    throw attachPosixRetirementTombstone(error, tombstone.authority);
  }
}

function rejectExistingPosixRecoveryBaton(
  controlKey,
  root,
  directory,
  recoveryScope,
) {
  let chain;
  try {
    chain = collectPosixRecoveryBatonChain(directory, {
      expectedScope: recoveryScope,
    });
  } catch (cause) {
    throw retirementClaimRequired(directory, cause);
  }
  if (!chain) return;
  const handoff = posixSessionRecoveryHandoff({
    claimPath: chain.path,
    controlDirectory: directory,
    controlKey,
    controlRoot: root,
    recoveryScope: chain.recoveryScope,
    retirementOwner: chain.owner,
  });
  throw attachPosixSessionRecoveryHandoff(
    retirementClaimRequired(
      directory, new Error('POSIX session recovery is already claimed'),
    ),
    handoff,
  );
}

// This is the sole typed retirement path for a deterministic collision. It never
// signals a numeric process identity: recovery first proves the exact recorded
// session absent, then removes only the namespace authenticated by its own records.
export function recoverPosixSessionControl({
  controlKey,
  controlRoot = path.join(os.tmpdir(), 'easyboost-posix-session-controls'),
  inspectSession = inspectPosixSession,
  permitIncompleteRetirement = false,
  publicationResidue,
  publicationResidues,
  quiescentMaintenanceAuthority,
  reclaimRetainedEvidence,
  recoveryScope = null,
  retire = true,
  afterRecoveryStartupClaim,
  syncControlRoot = syncDirectory,
} = {}) {
  if (typeof controlKey !== 'string' || !controlKey) {
    throw new Error('POSIX session recovery controlKey is invalid');
  }
  if (!exactPosixRecoveryScope(recoveryScope)) {
    throw new Error('POSIX session recovery scope is invalid');
  }
  const root = path.resolve(controlRoot);
  const directory = path.join(root, controlDirectoryName(controlKey));
  const paths = controlPaths(directory);
  if (publicationResidue !== undefined && publicationResidues !== undefined) {
    throw new Error('POSIX session recovery publication authority is ambiguous');
  }
  const retainedPublicationResidues = publicationResidues === undefined
    ? (publicationResidue === undefined ? [] : [
      normalizePosixSessionPublicationResidue(publicationResidue, directory),
    ])
    : normalizePosixSessionPublicationResidues(publicationResidues, directory);
  safeOwnedRecoveryDirectory(root, 'POSIX session recovery control root');
  let directoryWasMissing = false;
  try {
    safeOwnedRecoveryDirectory(directory, 'POSIX session recovery control directory');
  } catch (error) {
    if (error?.code === 'ENOENT' && permitIncompleteRetirement) {
      try {
        fs.mkdirSync(directory, { mode: 0o700 });
        syncControlRoot(root);
      } catch (reservationError) {
        throw recoveryRequired(directory, reservationError);
      }
      directoryWasMissing = true;
      safeOwnedRecoveryDirectory(directory, 'POSIX session recovery control directory');
    } else {
      throw error;
    }
  }
  for (const retainedPublicationResidue of retainedPublicationResidues) {
    if (path.resolve(path.dirname(retainedPublicationResidue.destination)) !== path.resolve(directory)) {
      throw recoveryRequired(directory,
        new Error('POSIX session publication residue does not belong to this control directory'));
    }
    cleanupPosixSessionPublicationResidue(retainedPublicationResidue, {
      quiescentMaintenanceAuthority, reclaimRetainedEvidence,
    });
  }
  rejectExistingPosixRecoveryBaton(controlKey, root, directory, recoveryScope);
  let names = fs.readdirSync(directory);
  let control = readExactJson(paths.controlFile, (record) => {
    const exact = exactRecoveredPosixControl(record, directory);
    return canonicalJson(exact) === fs.readFileSync(paths.controlFile, 'utf8');
  });
  if (control.state !== 'present') {
    if (control.state === 'missing' && names.length === 0 && permitIncompleteRetirement) {
      publishRecoveryStartupClaim(paths.startupClaimPath);
      if (afterRecoveryStartupClaim !== undefined) {
        if (typeof afterRecoveryStartupClaim !== 'function') {
          throw new Error('POSIX session recovery claim hook is invalid');
        }
        afterRecoveryStartupClaim(Object.freeze({ controlDirectory: directory }));
      }
      names = fs.readdirSync(directory);
      control = readExactJson(paths.controlFile, (record) => {
        const exact = exactRecoveredPosixControl(record, directory);
        return canonicalJson(exact) === fs.readFileSync(paths.controlFile, 'utf8');
      });
    }
    if (control.state === 'missing'
        && JSON.stringify(names.sort()) === JSON.stringify([path.basename(paths.startupClaimPath)])) {
      const claim = readStartupClaim({ startupClaimPath: paths.startupClaimPath });
      if (claim.state !== 'present' || claim.record.kind !== 'RECOVERY') {
        throw claim.error ?? new Error('POSIX session recovery reservation is invalid');
      }
      const recoveryState = directoryWasMissing ? 'not-created' : 'incomplete';
      const semanticResult = Object.freeze({ absence: 'absent', state: recoveryState });
      const retirement = acquirePosixRecoveryRetirement(
        directory, root, controlKey, recoveryScope, semanticResult,
      );
      const result = recoveredIncompletePosixAuthority(
        controlKey, recoveryState, {
        controlDirectory: directory,
        controlRoot: root,
        recoveryScope,
        retirementClaim: retirement,
      });
      if (!retire) return result;
      retirePosixRecoveryNamespace({
        directory, quiescentMaintenanceAuthority, reclaimRetainedEvidence,
        recoveryProof: result.recoveryProof, recovery: retirement, root, syncControlRoot,
      });
      return Object.freeze({ absence: 'absent', state: directoryWasMissing ? 'not-created' : 'incomplete' });
    }
    if (control.state !== 'present') {
      throw control.error ?? new Error('POSIX session recovery authority is missing');
    }
  }
  const allowed = new Set(Object.values(paths).map((file) => path.basename(file)));
  for (const name of names) {
    if (!allowed.has(name)) throw new Error('POSIX session recovery authority contains an unknown record');
    const stat = fs.lstatSync(path.join(directory, name));
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
      throw new Error('POSIX session recovery authority record is unsafe');
    }
  }
  const specification = control.record;
  let startupClaim = readStartupClaim(specification);
  if (startupClaim.state === 'missing' && permitIncompleteRetirement) {
    startupClaim = {
      record: publishRecoveryStartupClaim(specification.startupClaimPath),
      state: 'present',
    };
    names = fs.readdirSync(directory);
  }
  if (startupClaim.state !== 'present') {
    throw startupClaim.error ?? new Error('POSIX session recovery lacks an exact startup claim');
  }
  if (startupClaim.record.kind === 'RECOVERY') {
    if (!permitIncompleteRetirement
        || JSON.stringify(names.sort()) !== JSON.stringify([
          path.basename(paths.controlFile), path.basename(paths.startupClaimPath),
        ].sort())) {
      throw new Error('POSIX session recovery claim is not an exact never-launched authority');
    }
    const finalControl = readExactJson(paths.controlFile, (record) => (
      canonicalJson(record) === fs.readFileSync(paths.controlFile, 'utf8')
        && exactRecoveredPosixControl(record, directory).controlToken === specification.controlToken
        && exactRecoveredPosixControl(record, directory).proofToken === specification.proofToken
    ));
    const finalClaim = readStartupClaim(specification);
    if (finalControl.state !== 'present' || finalClaim.state !== 'present'
        || finalClaim.record.kind !== 'RECOVERY') {
      throw finalControl.error ?? finalClaim.error
        ?? new Error('POSIX session recovery claim changed before retirement');
    }
    const semanticResult = Object.freeze({ absence: 'absent', state: 'incomplete' });
    const retirement = acquirePosixRecoveryRetirement(
      directory, root, controlKey, recoveryScope, semanticResult,
    );
    const result = recoveredIncompletePosixAuthority(controlKey, 'incomplete', {
      controlDirectory: directory,
      controlRoot: root,
      recoveryScope,
      retirementClaim: retirement,
    });
    if (!retire) return result;
    retirePosixRecoveryNamespace({
      directory, quiescentMaintenanceAuthority, reclaimRetainedEvidence,
      recoveryProof: result.recoveryProof, recovery: retirement, root, syncControlRoot,
    });
    return result;
  }
  const launchIdentity = {
    processGroupId: startupClaim.record.processGroupId,
    sessionId: startupClaim.record.sessionId,
    startTime: startupClaim.record.startTime,
  };
  const ready = readExactJson(paths.readyPath, (record) => (
    exactRecoveryProof(record, 'READY', specification.proofToken)
      && record.processGroupId === record.wrapperPid && record.sessionId === record.wrapperPid
      && Number.isSafeInteger(record.processGroupId) && START_TIME.test(record.startTime ?? '')
      // READY is intentionally written before the wrapper spawns the target.
      // A retained production authority therefore carries this exact null
      // sentinel; accepting an invented PID would make recovery less strict.
      && record.targetPid === null
      && record.processGroupId === launchIdentity.processGroupId
      && record.sessionId === launchIdentity.sessionId
      && record.startTime === launchIdentity.startTime
      && Object.keys(record).sort().join('\0')
        === ['event', 'processGroupId', 'protocol', 'sessionId', 'startTime', 'targetPid', 'token', 'wrapperPid'].join('\0')
  ));
  const target = readExactJson(paths.statusPath, (record) => (
    exactRecoveredProof(record, 'TARGET_STATUS', specification.proofToken,
      ['errorCode', 'exitCode', 'signal'])
      && Object.keys(record).sort().join('\0')
        === ['errorCode', 'event', 'exitCode', 'protocol', 'signal', 'token'].join('\0')
      && (record.errorCode === null || typeof record.errorCode === 'string')
      && (record.exitCode === null || Number.isSafeInteger(record.exitCode))
      && (record.signal === null || typeof record.signal === 'string')
  ));
  const drained = readExactJson(paths.proofPath, (record) => (
    exactRecoveredProof(record, 'SESSION_DRAINED', specification.proofToken, ['activeProcesses'])
      && record.activeProcesses === 0
      && Object.keys(record).sort().join('\0')
        === ['activeProcesses', 'event', 'protocol', 'token'].join('\0')
  ));
  if (ready.state !== 'present') {
    if (ready.state === 'missing' && permitIncompleteRetirement
        && JSON.stringify(names.sort()) === JSON.stringify([
          path.basename(paths.controlFile), path.basename(paths.startupClaimPath),
        ].sort())) {
      const firstAbsence = inspectSession(launchIdentity);
      const secondAbsence = firstAbsence?.state === 'absent'
        ? inspectSession(launchIdentity) : firstAbsence;
      if (firstAbsence?.state !== 'absent' || secondAbsence?.state !== 'absent') {
        throw firstAbsence?.error ?? secondAbsence?.error
          ?? new Error('POSIX session recovery cannot prove the launch-claimed group absent');
      }
      const finalControl = readExactJson(paths.controlFile, (record) => (
        canonicalJson(record) === fs.readFileSync(paths.controlFile, 'utf8')
          && exactRecoveredPosixControl(record, directory).controlToken === specification.controlToken
          && exactRecoveredPosixControl(record, directory).proofToken === specification.proofToken
      ));
      if (finalControl.state !== 'present') {
        throw finalControl.error ?? new Error('POSIX session recovery control changed before retirement');
      }
      const finalClaim = readStartupClaim(specification);
      if (finalClaim.state !== 'present'
          || canonicalJson(finalClaim.record) !== canonicalJson(startupClaim.record)
          || inspectSession(launchIdentity)?.state !== 'absent') {
        throw finalClaim.error
          ?? new Error('POSIX session recovery launch authority changed before retirement');
      }
      const semanticResult = Object.freeze({ absence: 'absent', state: 'incomplete' });
      const retirement = acquirePosixRecoveryRetirement(
        directory, root, controlKey, recoveryScope, semanticResult,
      );
      const result = recoveredIncompletePosixAuthority(controlKey, 'incomplete', {
        controlDirectory: directory,
        controlRoot: root,
        recoveryScope,
        retirementClaim: retirement,
      });
      if (!retire) return result;
      retirePosixRecoveryNamespace({
        directory, quiescentMaintenanceAuthority, reclaimRetainedEvidence,
        recoveryProof: result.recoveryProof, recovery: retirement, root, syncControlRoot,
      });
      return result;
    }
    throw ready.error ?? new Error('POSIX session recovery lacks exact READY authority');
  }
  if (target.state === 'unknown' || drained.state === 'unknown') {
    throw target.error ?? drained.error;
  }
  if (drained.state === 'present' && target.state === 'missing') {
    throw new Error('POSIX session recovery has a non-canonical settlement proof gap');
  }
  const killArmed = readExactJson(paths.killArmedPath, (record) => (
    exactRecoveredProof(record, 'KILL_ARMED', specification.proofToken, ['reason'])
      && typeof record.reason === 'string' && record.reason.length > 0
  ));
  if (killArmed.state === 'unknown') throw killArmed.error;
  let incomplete = target.state !== 'present'
    || (drained.state !== 'present' && killArmed.state !== 'present');
  for (const [signal, requestPath, acknowledgementPath, event] of [
    ['SIGTERM', paths.termRequestPath, paths.termAckPath, 'TERM_ACK'],
    ['SIGKILL', paths.killRequestPath, paths.killAckPath, 'KILL_ACK'],
  ]) {
    const request = readExactJson(requestPath, (record) => (
      record && typeof record === 'object' && !Array.isArray(record)
        && canonicalJson(record) === fs.readFileSync(requestPath, 'utf8')
        && record.protocol === POSIX_SESSION_CONTROL_PROTOCOL && record.signal === signal
        && record.token === specification.controlToken
        && Object.keys(record).sort().join('\0') === ['protocol', 'signal', 'token'].join('\0')
    ));
    const acknowledgement = readExactJson(acknowledgementPath, (record) => (
      exactRecoveredProof(record, event, specification.proofToken, [])
    ));
    if (request.state === 'missing' && acknowledgement.state === 'present') {
      throw new Error('POSIX session recovery signal acknowledgement is incomplete');
    }
    if (request.state === 'unknown' || acknowledgement.state === 'unknown') {
      throw request.error ?? acknowledgement.error;
    }
    if (request.state === 'present' && acknowledgement.state === 'missing') incomplete = true;
  }
  const identity = {
    processGroupId: ready.record.processGroupId,
    sessionId: ready.record.sessionId,
    startTime: ready.record.startTime,
  };
  const absence = inspectSession(identity);
  if (absence?.state !== 'absent') {
    throw absence?.error ?? new Error('POSIX session recovery cannot prove the owned group absent');
  }
  const finalControl = readExactJson(paths.controlFile, (record) => (
    canonicalJson(record) === fs.readFileSync(paths.controlFile, 'utf8')
      && exactRecoveredPosixControl(record, directory).controlToken === specification.controlToken
      && exactRecoveredPosixControl(record, directory).proofToken === specification.proofToken
  ));
  if (finalControl.state !== 'present' || inspectSession(identity)?.state !== 'absent') {
    throw finalControl.error ?? new Error('POSIX session recovery authority changed before retirement');
  }
  if (incomplete && !permitIncompleteRetirement) {
    throw new Error('POSIX session recovery requires session-proven incomplete retirement');
  }
  const semanticResult = Object.freeze({
    ...(incomplete ? { absence: 'absent' } : {}),
    processGroupId: identity.processGroupId,
    sessionId: identity.sessionId,
    state: incomplete ? 'incomplete' : 'absent',
  });
  const retirement = acquirePosixRecoveryRetirement(
    directory, root, controlKey, recoveryScope, semanticResult,
  );
  const result = recoveredIncompletePosixAuthority(
    controlKey,
    incomplete ? 'incomplete' : 'absent',
    {
      controlDirectory: directory,
      controlRoot: root,
      fields: {
        processGroupId: identity.processGroupId,
        sessionId: identity.sessionId,
      },
      includeAbsence: incomplete,
      recoveryScope,
      retirementClaim: retirement,
    },
  );
  if (!retire) return result;
  retirePosixRecoveryNamespace({
    directory, quiescentMaintenanceAuthority, reclaimRetainedEvidence,
    recoveryProof: result.recoveryProof, recovery: retirement, root, syncControlRoot,
  });
  return result;
}

export function createPosixSessionInvocation(
  command,
  args,
  cwd,
  settlementMilliseconds,
  targetEnvironment,
  posixSessionControl,
) {
  if (process.platform === 'win32') {
    throw new Error('Native Windows commands require the Windows Job supervisor');
  }
  assertPosixSessionWriterEgressBound(posixSessionControl?.specification);
  const sourceEnvironment = targetEnvironment ?? process.env;
  const parentIdentity = process.platform === 'linux'
    ? readLinuxProcessStat(process.pid)
    : null;
  const nodeAuthority = captureStagingNodeAuthority(sourceEnvironment, parentIdentity);
  const payload = Buffer.from(JSON.stringify({
    arguments: args,
    command,
    cwd: cwd || process.cwd(),
    nodeAuthority,
    parentIdentity,
    protocol: POSIX_SESSION_PROTOCOL,
    settlementMilliseconds,
  }), 'utf8').toString('base64');
  const environment = {
    ...sourceEnvironment,
    [CONTROL_ENVIRONMENT]: Buffer.from(JSON.stringify(
      posixSessionControl.specification,
    ), 'utf8').toString('base64'),
  };
  delete environment[STAGING_NODE_COMMAND_ENVIRONMENT];
  delete environment[STAGING_NODE_CHAIN_ENVIRONMENT];
  delete environment[STAGING_QUIESCENT_MAINTENANCE_ENVIRONMENT];
  delete environment[POSIX_RELEASE_MAINTENANCE_ENVIRONMENT];
  if (nodeAuthority?.source === 'chain') {
    environment[STAGING_NODE_COMMAND_ENVIRONMENT] = nodeAuthority.command;
    environment[STAGING_NODE_CHAIN_ENVIRONMENT] = nodeAuthority.chain;
  }
  return {
    args: [SUPERVISOR_FILE, '--run', payload],
    command: nodeAuthority?.command ?? process.execPath,
    cwd: SUPERVISOR_DIRECTORY,
    environment,
    posixSessionControl,
    writerEgress: Object.freeze({
      descriptor: POSIX_SESSION_WRITER_EGRESS_FD,
      specification: posixSessionControl.specification,
    }),
  };
}

function parseEncodedJson(value, label) {
  try {
    return JSON.parse(Buffer.from(value, 'base64').toString('utf8'));
  } catch (cause) {
    throw new Error(`Invalid ${label}`, { cause });
  }
}

export function createPosixSessionRecordPublisher(specification, {
  durableWrite = durableExclusiveWrite,
  readRecord = (file) => fs.readFileSync(file, 'utf8'),
  reportRecovery = () => {},
} = {}) {
  if (![durableWrite, readRecord, reportRecovery].every((operation) => typeof operation === 'function')) {
    throw new Error('POSIX session record publisher configuration is invalid');
  }
  const destinations = writerDestinationPaths(specification);
  let failure = null;
  const latch = (destination, error) => {
    if (failure !== null) return failure;
    let retained = error instanceof Error ? error : new Error(String(error));
    const candidate = retained?.recoveryAuthority;
    if (candidate !== undefined) {
      let authority;
      try {
        authority = exactPosixSessionWriterAuthority(candidate, specification);
        if (authority.destination !== destination) {
          throw new Error('POSIX session writer recovery authority belongs to another record');
        }
      } catch (authorityError) {
        retained = combinedPublicationError(retained, authorityError,
          'POSIX session writer failure carried invalid recovery authority');
        authority = undefined;
      }
      if (authority) {
        try {
          reportRecovery(authority);
        } catch (reportError) {
          retained = combinedPublicationError(retained, reportError,
            'POSIX session writer failure egress was not proven');
        }
        try {
          retained.recoveryAuthority = authority;
        } catch (attachmentError) {
          const wrapped = new AggregateError([retained, attachmentError],
            'POSIX session writer failure authority could not be attached', { cause: retained });
          wrapped.recoveryAuthority = authority;
          retained = wrapped;
        }
      }
    }
    failure = retained;
    return failure;
  };
  const guard = (destination, operation) => {
    if (!destinations.has(destination) || typeof operation !== 'function') {
      throw new Error('POSIX session record publisher operation is invalid');
    }
    if (failure !== null) throw failure;
    try {
      return operation();
    } catch (error) {
      throw latch(destination, error);
    }
  };
  const write = (file, event, fields = {}) => guard(file, () => {
    const value = canonicalJson({
      event,
      protocol: POSIX_SESSION_PROOF_PROTOCOL,
      token: specification.proofToken,
      ...fields,
    });
    try {
      durableWrite(file, value);
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      let observed;
      try { observed = readRecord(file); } catch (readError) {
        throw combinedPublicationError(error, readError,
          'POSIX session duplicate record could not be verified');
      }
      if (observed !== value) throw error;
    }
  });
  return Object.freeze({
    get failure() { return failure; },
    guard,
    write,
  });
}

export function inspectOwnedPosixSessionMembers(wrapperIdentity, {
  readEntries = () => fs.readdirSync('/proc', { withFileTypes: true }),
  readStat = readLinuxProcessStatIfPresent,
  wrapperPid = process.pid,
} = {}) {
  const entries = readEntries();
  const members = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/u.test(entry.name)) continue;
    const result = readStat(Number(entry.name));
    if (result.error) throw result.error;
    if (!result.process) continue;
    if (result.process.processGroupId === wrapperIdentity.processGroupId
        && result.process.sessionId === wrapperIdentity.sessionId
        && result.process.processId !== wrapperPid) members.push(result.process.processId);
  }
  return members;
}

function parentIdentityAlive(identity) {
  if (!identity) return true;
  const result = readLinuxProcessStatIfPresent(identity.processId);
  return result.process?.startTime === identity.startTime;
}

async function runSupervisor(payloadValue) {
  if (process.platform !== 'linux') {
    throw new Error('The POSIX session supervisor requires Linux /proc');
  }
  const payload = parseEncodedJson(payloadValue, 'POSIX session payload');
  const specification = parseEncodedJson(
    process.env[CONTROL_ENVIRONMENT],
    'POSIX session control specification',
  );
  const stagingNodeAuthority = validateInheritedStagingNodeAuthority(
    payload.nodeAuthority, payload.parentIdentity,
  );
  delete process.env[CONTROL_ENVIRONMENT];
  delete process.env[STAGING_NODE_AUTHORITY_ENVIRONMENT];
  delete process.env[STAGING_NODE_COMMAND_ENVIRONMENT];
  delete process.env[STAGING_NODE_CHAIN_ENVIRONMENT];
  delete process.env[STAGING_QUIESCENT_MAINTENANCE_ENVIRONMENT];
  delete process.env[POSIX_RELEASE_MAINTENANCE_ENVIRONMENT];
  if (payload.protocol !== POSIX_SESSION_PROTOCOL
      || specification.controlProtocol !== POSIX_SESSION_CONTROL_PROTOCOL
      || specification.proofProtocol !== POSIX_SESSION_PROOF_PROTOCOL
      || !TOKEN.test(specification.controlToken ?? '')
      || !TOKEN.test(specification.proofToken ?? '')
      || !Number.isSafeInteger(payload.settlementMilliseconds)
      || payload.settlementMilliseconds < 1) {
    throw new Error('POSIX session supervisor protocol is invalid');
  }
  const writerEgress = createPosixSessionWriterEgress(specification);
  const publisher = createPosixSessionRecordPublisher(specification, {
    reportRecovery: (authority) => writerEgress.report(authority),
  });
  const write = publisher.write;
  const identity = readLinuxProcessStat(process.pid);
  if (identity.processGroupId !== process.pid || identity.sessionId !== process.pid) {
    throw new Error('POSIX session supervisor is not an isolated session leader');
  }
  process.on('SIGTERM', () => {});
  process.on('SIGINT', () => {});
  let target;
  let targetClosed = false;
  let targetError = null;
  let targetStatusWritten = false;
  let termStartedAt = null;
  let killArmed = false;
  let finishing = false;
  let lifecycleInterval;
  const requestValue = (signal) => canonicalJson({
    protocol: POSIX_SESSION_CONTROL_PROTOCOL,
    signal,
    token: specification.controlToken,
  });
  const hasRequest = (signal) => {
    const file = signal === 'SIGTERM'
      ? specification.termRequestPath
      : specification.killRequestPath;
    try {
      return fs.readFileSync(file, 'utf8') === requestValue(signal);
    } catch (error) {
      if (error?.code === 'ENOENT') return false;
      throw error;
    }
  };
  const armKill = (reason) => {
    if (killArmed) return;
    write(specification.killArmedPath, 'KILL_ARMED', { reason });
    killArmed = true;
  };
  const signalOwnGroup = (signal) => {
    // This is the only signal-delivery boundary: the isolated session leader signals
    // group 0 from inside its own still-existing group. No external PID/PGID is used.
    process.kill(0, signal);
  };
  const requestTerm = (reason) => {
    if (termStartedAt !== null) return;
    if (reason === 'controller') write(specification.termAckPath, 'TERM_ACK');
    signalOwnGroup('SIGTERM');
    termStartedAt = Date.now();
  };
  const requestKill = (reason) => {
    if (reason === 'controller') write(specification.killAckPath, 'KILL_ACK');
    armKill(reason);
    signalOwnGroup('SIGKILL');
  };
  const writeTargetStatus = (code, signal) => {
    if (targetStatusWritten) return;
    targetStatusWritten = true;
    write(specification.statusPath, 'TARGET_STATUS', {
      errorCode: targetError?.code || null,
      exitCode: Number.isInteger(code) ? code : null,
      signal: typeof signal === 'string' ? signal : null,
    });
  };
  const fatalContainment = createFatalPosixSessionContainment({
    armKill,
    requestTerm,
    settlementMilliseconds: payload.settlementMilliseconds,
    signalOwnGroup,
  });
  const enterFatalContainment = (error) => {
    if (lifecycleInterval) {
      clearInterval(lifecycleInterval);
      lifecycleInterval = undefined;
    }
    fatalContainment.activate(error);
  };
  publisher.guard(specification.startupClaimPath,
    () => claimPosixSessionStartup(specification, { kind: 'LAUNCH', identity }));
  write(specification.readyPath, 'READY', {
    processGroupId: identity.processGroupId,
    sessionId: identity.sessionId,
    startTime: identity.startTime,
    targetPid: null,
    wrapperPid: process.pid,
  });
  const targetEnvironment = { ...process.env };
  delete targetEnvironment[CONTROL_ENVIRONMENT];
  delete targetEnvironment[STAGING_NODE_AUTHORITY_ENVIRONMENT];
  delete targetEnvironment[STAGING_QUIESCENT_MAINTENANCE_ENVIRONMENT];
  delete targetEnvironment[POSIX_RELEASE_MAINTENANCE_ENVIRONMENT];
  if (stagingNodeAuthority === null) {
    delete targetEnvironment[STAGING_NODE_COMMAND_ENVIRONMENT];
    delete targetEnvironment[STAGING_NODE_CHAIN_ENVIRONMENT];
  } else {
    targetEnvironment[STAGING_NODE_COMMAND_ENVIRONMENT] = stagingNodeAuthority.command;
    targetEnvironment[STAGING_NODE_CHAIN_ENVIRONMENT] = stagingNodeAuthority.chain;
  }
  try {
    target = spawn(payload.command, payload.arguments, {
      cwd: payload.cwd,
      detached: false,
      env: targetEnvironment,
      shell: false,
      stdio: ['inherit', 'inherit', 'inherit'],
      windowsHide: true,
    });
    target.on('error', (error) => { targetError ??= error; });
    target.once('close', (code, signal) => {
      targetClosed = true;
      try {
        writeTargetStatus(code, signal);
      } catch (error) {
        enterFatalContainment(error);
      }
    });
  } catch (error) {
    targetError = error;
    targetClosed = true;
    writeTargetStatus(null, null);
  }

  return await new Promise(() => {
    lifecycleInterval = setInterval(() => {
      try {
        if (hasRequest('SIGKILL')) {
          clearInterval(lifecycleInterval);
          lifecycleInterval = undefined;
          requestKill('controller');
          return;
        }
        if (hasRequest('SIGTERM')) requestTerm('controller');
        if (!parentIdentityAlive(payload.parentIdentity)) requestTerm('parent-exited');
        if (targetClosed && !finishing) {
          finishing = true;
          clearInterval(lifecycleInterval);
          lifecycleInterval = undefined;
          // There is no atomic kernel query for "this process group contains
          // only me". Once target status is durable, terminate from group 0;
          // the external controller proves ESRCH only after this wrapper closes.
          requestKill('target-closed');
          return;
        }
        if (termStartedAt !== null
            && Date.now() - termStartedAt >= payload.settlementMilliseconds) {
          clearInterval(lifecycleInterval);
          lifecycleInterval = undefined;
          requestKill('settlement-deadline');
        }
      } catch (error) {
        enterFatalContainment(error);
      }
    }, POLL_MILLISECONDS);
  });
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === SUPERVISOR_FILE;
if (isMain && process.argv[2] === '--run') {
  runSupervisor(process.argv[3]).then(
    (result) => { process.exitCode = result.exitCode; },
    (error) => {
      process.stderr.write(`POSIX session supervisor failed: ${error.message}\n`);
      process.exitCode = 125;
    },
  );
}
