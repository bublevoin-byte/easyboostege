import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_BOUND = 512 * 1024 * 1024;

function assertMaximumBytes(maximumBytes) {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > MAX_BOUND) {
    throw new Error('bounded staging stream limit is invalid');
  }
}

function noFollowFlag(filesystem = fs) {
  const flag = filesystem.constants.O_NOFOLLOW;
  if (process.platform !== 'win32' && !Number.isInteger(flag)) {
    throw new Error('no-follow descriptor support is required for staging files');
  }
  return flag ?? 0;
}

function sameNodeIdentity(left, right) {
  return String(left.dev) === String(right.dev) && String(left.ino) === String(right.ino);
}

function assertDurableRegularFile(stat, role) {
  if (!stat.isFile() || stat.isSymbolicLink?.()) {
    throw new Error(`${role} must be a regular no-follow file for durable publication`);
  }
}

export function fsyncStagingFile(filePath, {
  filesystem = fs, platform = process.platform,
} = {}) {
  const entry = path.resolve(filePath);
  const before = filesystem.lstatSync(entry);
  assertDurableRegularFile(before, 'staging publication source');
  const descriptor = filesystem.openSync(entry, filesystem.constants.O_RDONLY | noFollowFlag(filesystem));
  try {
    const opened = filesystem.fstatSync(descriptor);
    if (!sameNodeIdentity(before, opened)) {
      throw new Error('staging publication source changed while opening for durability');
    }
    // Production staging helpers are Linux-only. Windows fixture runs retain
    // no-follow/open/fstat/path identity checks but cannot issue fsync(2).
    if (platform !== 'win32') filesystem.fsyncSync(descriptor);
    const after = filesystem.lstatSync(entry);
    if (!sameNodeIdentity(opened, after)) {
      throw new Error('staging publication source changed during durability sync');
    }
  } finally {
    filesystem.closeSync(descriptor);
  }
}

export function fsyncStagingParentDirectory(entryPath, {
  filesystem = fs, platform = process.platform,
} = {}) {
  // Staging helpers execute only on Linux. Windows runs the fixture suite but cannot fsync a directory.
  if (platform === 'win32') return;
  const directory = path.dirname(path.resolve(entryPath));
  const before = filesystem.lstatSync(directory);
  if (!before.isDirectory() || before.isSymbolicLink?.()) {
    throw new Error('staging publication parent must be a real directory for durability');
  }
  const descriptor = filesystem.openSync(
    directory, filesystem.constants.O_RDONLY | noFollowFlag(filesystem),
  );
  try {
    const opened = filesystem.fstatSync(descriptor);
    if (!opened.isDirectory() || !sameNodeIdentity(before, opened)) {
      throw new Error('staging publication parent changed while opening for durability');
    }
    filesystem.fsyncSync(descriptor);
    const after = filesystem.lstatSync(directory);
    if (!sameNodeIdentity(opened, after)) {
      throw new Error('staging publication parent changed during durability sync');
    }
  } finally {
    filesystem.closeSync(descriptor);
  }
}

function fileRecord(stat) {
  return {
    version: 1,
    dev: String(stat.dev),
    ino: String(stat.ino),
    mode: String(stat.mode),
    nlink: String(stat.nlink),
    uid: String(stat.uid),
    gid: String(stat.gid),
    size: String(stat.size),
    mtimeNs: String(stat.mtimeNs),
    ctimeNs: String(stat.ctimeNs),
  };
}

function sameFileRecord(stat, authority) {
  return JSON.stringify(fileRecord(stat)) === JSON.stringify(authority);
}

function assertBoundedRegularFile(stat, maximumBytes, role) {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) {
    throw new Error(`${role} must be a single-link regular no-follow file`);
  }
  if (stat.size < 1n || stat.size > BigInt(maximumBytes)) {
    throw new Error(`${role} exceeds its byte bound`);
  }
}

function openCapturedInput(inputPath, maximumBytes, authority) {
  const source = path.resolve(inputPath);
  const before = fs.lstatSync(source, { bigint: true });
  assertBoundedRegularFile(before, maximumBytes, 'uploaded release archive');
  if (!sameFileRecord(before, authority)) {
    throw new Error('uploaded release archive identity changed before descriptor open');
  }
  const descriptor = fs.openSync(source, fs.constants.O_RDONLY | noFollowFlag());
  try {
    const opened = fs.fstatSync(descriptor, { bigint: true });
    assertBoundedRegularFile(opened, maximumBytes, 'uploaded release archive');
    if (!sameFileRecord(opened, authority)) {
      throw new Error('uploaded release archive identity changed while opening');
    }
    return { descriptor, source };
  } catch (error) {
    fs.closeSync(descriptor);
    throw error;
  }
}

export function captureBoundedFileAuthority({ inputPath, maximumBytes }) {
  assertMaximumBytes(maximumBytes);
  const source = path.resolve(inputPath);
  const before = fs.lstatSync(source, { bigint: true });
  assertBoundedRegularFile(before, maximumBytes, 'uploaded release archive');
  const authority = fileRecord(before);
  const { descriptor } = openCapturedInput(source, maximumBytes, authority);
  fs.closeSync(descriptor);
  const finalPath = fs.lstatSync(source, { bigint: true });
  if (!sameFileRecord(finalPath, authority)) {
    throw new Error('uploaded release archive identity changed during authority capture');
  }
  return authority;
}

function removeOwnedEntry(entry, authority, role) {
  let current;
  try {
    current = fs.lstatSync(entry, { bigint: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  if (!current.isFile() || current.isSymbolicLink()
      || String(current.dev) !== authority.dev || String(current.ino) !== authority.ino) {
    throw new Error(`${role} was replaced before cleanup`);
  }
  fs.unlinkSync(entry);
}

function reservationRecord(stat) {
  const size = Number(stat.size);
  const blocks = process.platform === 'win32' ? null : String(stat.blocks ?? 0);
  return {
    dev: String(stat.dev),
    ino: String(stat.ino),
    mode: String(stat.mode),
    nlink: String(stat.nlink),
    uid: String(stat.uid),
    gid: String(stat.gid),
    size: String(stat.size),
    blocks,
    allocatedBytes: process.platform === 'win32' ? size : Number(blocks) * 512,
  };
}

function assertReservedOutput(stat, outputAuthority, expectedBytes) {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n
      || stat.size !== BigInt(expectedBytes)
      || JSON.stringify(reservationRecord(stat)) !== JSON.stringify(outputAuthority)
      || !Number.isSafeInteger(outputAuthority.allocatedBytes)
      || outputAuthority.allocatedBytes < expectedBytes) {
    throw new Error('frozen release archive reservation identity or capacity changed');
  }
}

function copyDescriptorBytes({ sourceDescriptor, outputDescriptor, maximumBytes }) {
  const digest = crypto.createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let total = 0;
  for (;;) {
    const bytesRead = fs.readSync(sourceDescriptor, buffer, 0, buffer.length, null);
    if (bytesRead === 0) break;
    if (bytesRead > maximumBytes - total) {
      throw new Error('uploaded release archive byte bound exceeded during descriptor copy');
    }
    let written = 0;
    while (written < bytesRead) {
      const count = fs.writeSync(outputDescriptor, buffer, written, bytesRead - written, total + written);
      if (count < 1) throw new Error('frozen release archive descriptor write made no progress');
      written += count;
    }
    digest.update(buffer.subarray(0, bytesRead));
    total += bytesRead;
  }
  return { bytes: total, sha256: digest.digest('hex') };
}

export async function freezeBoundedFileIntoReservation({
  inputPath, outputPath, maximumBytes, authority, outputAuthority,
}) {
  assertMaximumBytes(maximumBytes);
  if (!authority || typeof authority !== 'object' || Array.isArray(authority)
      || !outputAuthority || typeof outputAuthority !== 'object' || Array.isArray(outputAuthority)) {
    throw new Error('uploaded release archive or output reservation authority is invalid');
  }
  const declaredSize = Number(authority.size);
  if (!Number.isSafeInteger(declaredSize) || declaredSize < 1 || declaredSize > maximumBytes) {
    throw new Error('uploaded release archive authority has an invalid byte size');
  }
  const destination = path.resolve(outputPath);
  const outputBefore = fs.lstatSync(destination, { bigint: true });
  assertReservedOutput(outputBefore, outputAuthority, declaredSize);

  let sourceDescriptor;
  let source;
  let outputDescriptor;
  let completedOutputAuthority;
  let primaryFailure;
  let result;
  try {
    ({ descriptor: sourceDescriptor, source } = openCapturedInput(
      inputPath, maximumBytes, authority,
    ));
    outputDescriptor = fs.openSync(destination, fs.constants.O_WRONLY | noFollowFlag());
    const openedOutput = fs.fstatSync(outputDescriptor, { bigint: true });
    assertReservedOutput(openedOutput, outputAuthority, declaredSize);
    result = copyDescriptorBytes({ sourceDescriptor, outputDescriptor, maximumBytes });
    if (result.bytes !== declaredSize) {
      throw new Error('uploaded release archive size changed during descriptor copy');
    }
    fs.fsyncSync(outputDescriptor);
    fs.fchmodSync(outputDescriptor, 0o400);
    const sourceAfter = fs.fstatSync(sourceDescriptor, { bigint: true });
    const sourcePathAfter = fs.lstatSync(source, { bigint: true });
    if (!sameFileRecord(sourceAfter, authority) || !sameFileRecord(sourcePathAfter, authority)) {
      throw new Error('uploaded release archive identity changed during descriptor copy');
    }
    const outputAfter = fs.fstatSync(outputDescriptor, { bigint: true });
    const outputPathAfter = fs.lstatSync(destination, { bigint: true });
    for (const stat of [outputAfter, outputPathAfter]) {
      const allocation = reservationRecord(stat);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n
          || stat.size !== BigInt(declaredSize)
          || String(stat.dev) !== outputAuthority.dev || String(stat.ino) !== outputAuthority.ino
          || !Number.isSafeInteger(allocation.allocatedBytes)
          || allocation.allocatedBytes < declaredSize) {
        throw new Error('frozen release archive reservation changed during descriptor copy');
      }
    }
    completedOutputAuthority = fileRecord(outputAfter);
  } catch (error) {
    primaryFailure = error;
  }

  const cleanupFailures = [];
  const cleanup = (label, operation) => {
    try { operation(); } catch (error) {
      cleanupFailures.push(new Error(`${label}: ${error.message}`, { cause: error }));
    }
  };
  if (sourceDescriptor !== undefined) {
    cleanup('close uploaded release archive descriptor', () => fs.closeSync(sourceDescriptor));
  }
  if (outputDescriptor !== undefined) {
    cleanup('close frozen release archive reservation descriptor', () => fs.closeSync(outputDescriptor));
  }
  if (!primaryFailure && cleanupFailures.length === 0) {
    cleanup('verify frozen release archive after descriptor close', () => {
      const finalPath = fs.lstatSync(destination, { bigint: true });
      if (!sameFileRecord(finalPath, completedOutputAuthority)) {
        throw new Error('frozen release archive changed after descriptor close');
      }
    });
  }
  if (primaryFailure || cleanupFailures.length > 0) {
    cleanup('remove owned frozen release archive reservation', () => {
      removeOwnedEntry(destination, outputAuthority, 'frozen release archive reservation');
    });
  }
  if (primaryFailure && cleanupFailures.length > 0) {
    throw new AggregateError([primaryFailure, ...cleanupFailures],
      'uploaded release archive reserved freeze failed and cleanup was incomplete');
  }
  if (primaryFailure) throw primaryFailure;
  if (cleanupFailures.length > 0) {
    throw new AggregateError(cleanupFailures,
      'uploaded release archive reserved freeze cleanup was incomplete');
  }
  return result;
}

export async function copyBoundedStream({
  input, outputPath, maximumBytes, syncParentDirectory = fsyncStagingParentDirectory,
}) {
  assertMaximumBytes(maximumBytes);
  const destination = path.resolve(outputPath);
  const parent = path.dirname(destination);
  const stagingDirectory = fs.mkdtempSync(path.join(parent, `.${path.basename(destination)}.bounded-`));
  fs.chmodSync(stagingDirectory, 0o700);
  const temporary = path.join(stagingDirectory, 'owned-output');
  let descriptor;
  let published = false;
  let publishedAuthority;
  let total = 0;
  let result;
  let primaryFailure;
  try {
    descriptor = fs.openSync(temporary,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollowFlag(),
      0o600);
    for await (const value of input) {
      const chunk = Buffer.from(value);
      if (chunk.length > maximumBytes - total) {
        throw new Error('bounded staging stream byte bound exceeded');
      }
      let offset = 0;
      while (offset < chunk.length) offset += fs.writeSync(descriptor, chunk, offset);
      total += chunk.length;
    }
    fs.fsyncSync(descriptor);
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.isSymbolicLink?.() || stat.nlink !== 1 || stat.size !== total) {
      throw new Error('bounded staging stream output identity could not be proven');
    }
    fs.linkSync(temporary, destination);
    const publishedStat = fs.lstatSync(destination);
    if (!publishedStat.isFile() || publishedStat.isSymbolicLink?.()
        || publishedStat.dev !== stat.dev || publishedStat.ino !== stat.ino
        || publishedStat.nlink !== 2 || publishedStat.size !== total) {
      throw new Error('bounded staging stream publication identity could not be proven');
    }
    published = true;
    const durablePublishedStat = fs.lstatSync(destination, { bigint: true });
    publishedAuthority = { dev: String(durablePublishedStat.dev), ino: String(durablePublishedStat.ino) };
    syncParentDirectory(destination);
    result = { bytes: total };
  } catch (error) {
    primaryFailure = error;
  }

  const cleanupFailures = [];
  const cleanup = (label, operation) => {
    try { operation(); } catch (error) {
      cleanupFailures.push(new Error(`${label}: ${error.message}`, { cause: error }));
    }
  };
  if (descriptor !== undefined) cleanup('close bounded staging stream descriptor', () => fs.closeSync(descriptor));
  cleanup('remove bounded staging stream private entry', () => {
    fs.unlinkSync(temporary);
    syncParentDirectory(temporary);
  });
  cleanup('remove bounded staging stream private directory', () => {
    fs.rmdirSync(stagingDirectory);
    syncParentDirectory(stagingDirectory);
  });
  if (published && (primaryFailure || cleanupFailures.length > 0)) {
    cleanup('remove unconfirmed bounded staging stream publication', () => {
      removeOwnedEntry(destination, publishedAuthority, 'bounded staging stream publication');
      syncParentDirectory(destination);
    });
  }
  if (published && cleanupFailures.length === 0) {
    cleanup('verify bounded staging stream published identity', () => {
      const stat = fs.lstatSync(destination);
      if (!stat.isFile() || stat.isSymbolicLink?.() || stat.nlink !== 1 || stat.size !== total) {
        throw new Error('published output changed during private cleanup');
      }
    });
  }

  if (primaryFailure && cleanupFailures.length > 0) {
    throw new AggregateError([primaryFailure, ...cleanupFailures],
      'bounded staging stream failed and cleanup was incomplete');
  }
  if (primaryFailure) throw primaryFailure;
  if (cleanupFailures.length > 0) {
    throw new AggregateError(cleanupFailures, 'bounded staging stream cleanup was incomplete');
  }
  return result;
}

async function runCli() {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'fsync-file' && args.length === 1) {
    fsyncStagingFile(args[0]);
    return;
  }
  if (command === 'fsync-parent' && args.length === 1) {
    fsyncStagingParentDirectory(args[0]);
    return;
  }
  if (command === 'capture-file' && args.length === 2 && /^\d+$/u.test(args[1])) {
    const authority = captureBoundedFileAuthority({
      inputPath: args[0], maximumBytes: Number(args[1]),
    });
    process.stdout.write(`${JSON.stringify(authority)}\n`);
    return;
  }
  if (command === 'freeze-reserved-file' && args.length === 5 && /^\d+$/u.test(args[2])) {
    let authority;
    let outputAuthority;
    try {
      authority = JSON.parse(args[3]);
      outputAuthority = JSON.parse(args[4]);
    } catch {
      throw new Error('uploaded release archive or output reservation authority is invalid');
    }
    const result = await freezeBoundedFileIntoReservation({
      inputPath: args[0], outputPath: args[1], maximumBytes: Number(args[2]),
      authority, outputAuthority,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  const [outputPath, maximum] = [command, ...args];
  if (!outputPath || !/^\d+$/u.test(maximum ?? '') || args.length !== 1) {
    throw new Error('Usage: staging-bounded-stream.js fsync-file PATH | fsync-parent PATH | OUTPUT MAXIMUM_BYTES | capture-file INPUT MAXIMUM_BYTES | freeze-reserved-file INPUT OUTPUT MAXIMUM_BYTES INPUT_AUTHORITY OUTPUT_AUTHORITY');
  }
  const result = await copyBoundedStream({
    input: process.stdin, outputPath, maximumBytes: Number(maximum),
  });
  process.stdout.write(`${result.bytes}\n`);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  runCli().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
