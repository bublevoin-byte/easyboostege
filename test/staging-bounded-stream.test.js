import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  captureBoundedFileAuthority,
  copyBoundedStream,
  freezeBoundedFileIntoReservation,
  fsyncStagingFile,
} from '../scripts/staging-bounded-stream.js';
import { captureReservation } from '../scripts/staging-runtime-authority.js';

const copyScript = path.resolve('scripts/staging-bounded-stream.js');

async function runCopy({ chunks, limit, output }) {
  const child = spawn(process.execPath, [copyScript, output, String(limit)], {
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  for (const chunk of chunks) {
    if (!child.stdin.write(chunk)) await new Promise((resolve) => child.stdin.once('drain', resolve));
  }
  child.stdin.end();
  const [code] = await new Promise((resolve) => child.once('close', (...args) => resolve(args)));
  return { code, stderr };
}

test('bounded staging stream accepts chunked EOF and exact limit but rejects the first overflow byte', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-bounded-stream-'));
  try {
    const chunked = path.join(root, 'chunked.dump');
    const chunkedResult = await runCopy({
      chunks: Array.from({ length: 1024 }, () => Buffer.from('x')),
      limit: 2048,
      output: chunked,
    });
    assert.equal(chunkedResult.code, 0, chunkedResult.stderr);
    assert.equal((await fs.stat(chunked)).size, 1024);

    const exact = path.join(root, 'exact.dump');
    const exactResult = await runCopy({ chunks: [Buffer.alloc(4096, 1)], limit: 4096, output: exact });
    assert.equal(exactResult.code, 0, exactResult.stderr);
    assert.equal((await fs.stat(exact)).size, 4096);

    const overflow = path.join(root, 'overflow.dump');
    const overflowResult = await runCopy({
      chunks: [Buffer.alloc(4096, 1), Buffer.from([2])], limit: 4096, output: overflow,
    });
    assert.notEqual(overflowResult.code, 0);
    assert.match(overflowResult.stderr, /byte bound exceeded/iu);
    await assert.rejects(fs.access(overflow), { code: 'ENOENT' });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('bounded staging stream fails closed when its no-replace link cannot durably reach the parent directory',
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-bounded-stream-parent-sync-'));
    const output = path.join(root, 'backup.dump');
    const originalFsync = fsSync.fsyncSync;
    const events = [];
    let injected = false;
    try {
      fsSync.fsyncSync = function recordFileSync(descriptor) {
        events.push('file-sync');
        return originalFsync(descriptor);
      };

      const failure = await copyBoundedStream({
        input: [Buffer.from('durable staging output')], outputPath: output, maximumBytes: 1024,
        syncParentDirectory(entry) {
          events.push('parent-directory-sync');
          if (!injected) {
            assert.equal(path.resolve(entry), path.resolve(output));
            injected = true;
            throw new Error('injected parent-directory durability failure');
          }
        },
      }).then(() => null, (error) => error);
      assert.match(failure.errors?.[0]?.message ?? failure.message,
        /injected parent-directory durability failure/iu);
      assert.equal(injected, true,
        'publication must fsync its parent after the private file is durable and linked');
      assert.deepEqual(events.slice(0, 2), ['file-sync', 'parent-directory-sync'],
        'file durability must precede publication-parent durability');
      await assert.rejects(fs.access(output), { code: 'ENOENT' },
        'an unconfirmed publication must not remain reachable after cleanup');
    } finally {
      fsSync.fsyncSync = originalFsync;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

test('Windows fixture durability verifies file identity but never invokes unsupported fsync', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-bounded-stream-windows-fsync-'));
  const file = path.join(root, 'fixture.txt');
  const originalFsync = fsSync.fsyncSync;
  let fsyncCalls = 0;
  try {
    await fs.writeFile(file, 'fixture');
    fsSync.fsyncSync = () => {
      fsyncCalls += 1;
      throw Object.assign(new Error('Windows fsync is unsupported'), { code: 'EPERM' });
    };
    assert.doesNotThrow(() => fsyncStagingFile(file, { filesystem: fsSync, platform: 'win32' }));
    assert.equal(fsyncCalls, 0);
  } finally {
    fsSync.fsyncSync = originalFsync;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('overflow cleanup never path-deletes a replacement created after descriptor close', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-bounded-stream-race-'));
  const output = path.join(root, 'backup.dump');
  const displaced = path.join(root, 'owned-before-race.dump');
  const originalClose = fsSync.closeSync;
  let injected = false;
  fsSync.closeSync = function closeAndReplace(descriptor) {
    originalClose(descriptor);
    if (injected) return;
    injected = true;
    if (fsSync.existsSync(output)) fsSync.renameSync(output, displaced);
    fsSync.writeFileSync(output, 'foreign replacement', { mode: 0o600 });
  };
  try {
    await assert.rejects(copyBoundedStream({
      input: [Buffer.alloc(8), Buffer.from([1])], outputPath: output, maximumBytes: 8,
    }), /byte bound exceeded/iu);
    assert.equal(injected, true, 'the race must occur immediately after descriptor close');
    assert.equal(await fs.readFile(output, 'utf8'), 'foreign replacement',
      'cleanup must never remove a path replacement it did not create');
  } finally {
    fsSync.closeSync = originalClose;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('bounded stream preserves overflow before every cleanup failure', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-bounded-stream-cleanup-'));
  const output = path.join(root, 'backup.dump');
  const originalUnlink = fsSync.unlinkSync;
  fsSync.unlinkSync = function failOwnedEntryCleanup(target, options) {
    if (path.basename(String(target)) === 'owned-output') throw new Error('injected private-entry cleanup failure');
    return originalUnlink(target, options);
  };
  try {
    const failure = await copyBoundedStream({
      input: [Buffer.alloc(4), Buffer.from([1])], outputPath: output, maximumBytes: 4,
    }).then(() => null, (error) => error);
    assert.ok(failure instanceof AggregateError);
    assert.match(failure.errors[0].message, /byte bound exceeded/iu,
      'the stream failure must remain the first error');
    assert.match(failure.errors[1].message, /private entry.*injected/iu,
      'cleanup failure must be retained instead of swallowed');
  } finally {
    fsSync.unlinkSync = originalUnlink;
    await fs.rm(root, { recursive: true, force: true });
  }
});

async function reserveOutput(output, bytes) {
  await fs.writeFile(output, Buffer.alloc(bytes), { mode: 0o600 });
  await fs.chmod(output, 0o600);
  return captureReservation({ file: output, minimumBytes: bytes });
}

test('uploaded release capture rejects a real final-component symlink', async (context) => {
  if (process.platform === 'win32') {
    return context.skip('Windows test host cannot create an unprivileged file symlink');
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-upload-freeze-symlink-'));
  const target = path.join(root, 'target.tar.gz');
  const source = path.join(root, 'release.tar.gz');
  try {
    await fs.writeFile(target, 'canonical archive');
    await fs.symlink(target, source, 'file');
    assert.throws(() => captureBoundedFileAuthority({ inputPath: source, maximumBytes: 1024 }),
      /single-link regular no-follow file/iu);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('uploaded release freeze rejects a byte-identical path replacement after authority capture', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-upload-freeze-swap-'));
  const source = path.join(root, 'release.tar.gz');
  const displaced = path.join(root, 'captured-release.tar.gz');
  const replacement = path.join(root, 'replacement.tar.gz');
  const output = path.join(root, 'frozen.tar.gz');
  try {
    const bytes = Buffer.from('same canonical archive bytes');
    await Promise.all([fs.writeFile(source, bytes), fs.writeFile(replacement, bytes)]);
    const authority = captureBoundedFileAuthority({ inputPath: source, maximumBytes: 1024 });
    const outputAuthority = await reserveOutput(output, bytes.length);
    await fs.rename(source, displaced);
    await fs.rename(replacement, source);

    await assert.rejects(freezeBoundedFileIntoReservation({
      inputPath: source, outputPath: output, maximumBytes: 1024, authority, outputAuthority,
    }), /identity.*changed|changed.*identity/iu);
    await assert.rejects(fs.access(output), { code: 'ENOENT' });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('uploaded release freeze rejects a final-component swap between lstat and no-follow open', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-upload-freeze-open-race-'));
  const source = path.join(root, 'release.tar.gz');
  const displaced = path.join(root, 'captured-release.tar.gz');
  const replacement = path.join(root, 'replacement.tar.gz');
  const output = path.join(root, 'frozen.tar.gz');
  const originalOpen = fsSync.openSync;
  let swapped = false;
  try {
    const bytes = Buffer.from('same canonical archive bytes');
    await Promise.all([fs.writeFile(source, bytes), fs.writeFile(replacement, bytes)]);
    const authority = captureBoundedFileAuthority({ inputPath: source, maximumBytes: 1024 });
    const outputAuthority = await reserveOutput(output, bytes.length);
    fsSync.openSync = function swapImmediatelyBeforeOpen(target, flags, ...args) {
      if (!swapped && path.resolve(String(target)) === path.resolve(source)) {
        if (process.platform !== 'win32') {
          assert.equal((flags & fsSync.constants.O_NOFOLLOW) !== 0, true,
            'the production descriptor open must fail closed against symlinks');
        }
        fsSync.renameSync(source, displaced);
        fsSync.renameSync(replacement, source);
        swapped = true;
      }
      return originalOpen(target, flags, ...args);
    };
    await assert.rejects(freezeBoundedFileIntoReservation({
      inputPath: source, outputPath: output, maximumBytes: 1024, authority, outputAuthority,
    }), /identity changed while opening/iu);
    assert.equal(swapped, true);
    await assert.rejects(fs.access(output), { code: 'ENOENT' });
  } finally {
    fsSync.openSync = originalOpen;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('uploaded release freeze rechecks descriptor identity after the bounded copy', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-upload-freeze-drift-'));
  const source = path.join(root, 'release.tar.gz');
  const output = path.join(root, 'frozen.tar.gz');
  const originalRead = fsSync.readSync;
  let mutated = false;
  try {
    await fs.writeFile(source, Buffer.alloc(2 * 1024 * 1024, 7));
    const authority = captureBoundedFileAuthority({
      inputPath: source, maximumBytes: 3 * 1024 * 1024,
    });
    const outputAuthority = await reserveOutput(output, Number(authority.size));
    fsSync.readSync = function readThenMutate(...args) {
      const count = originalRead(...args);
      if (!mutated && count > 0) {
        mutated = true;
        fsSync.appendFileSync(source, Buffer.from([8]));
        fsSync.truncateSync(source, Number(authority.size));
      }
      return count;
    };
    await assert.rejects(freezeBoundedFileIntoReservation({
      inputPath: source,
      outputPath: output,
      maximumBytes: 3 * 1024 * 1024,
      authority,
      outputAuthority,
    }), /identity changed during descriptor copy/iu);
    assert.equal(mutated, true, 'the mutation must occur while the source descriptor is open');
    await assert.rejects(fs.access(output), { code: 'ENOENT' });
  } finally {
    fsSync.readSync = originalRead;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('uploaded release freeze removes its owned reservation when descriptor close fails', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-upload-freeze-close-'));
  const source = path.join(root, 'release.tar.gz');
  const output = path.join(root, 'frozen.tar.gz');
  const originalOpen = fsSync.openSync;
  const originalClose = fsSync.closeSync;
  let outputDescriptor;
  let injected = false;
  try {
    const bytes = Buffer.from('canonical archive');
    await fs.writeFile(source, bytes);
    const authority = captureBoundedFileAuthority({ inputPath: source, maximumBytes: 1024 });
    const outputAuthority = await reserveOutput(output, bytes.length);
    fsSync.openSync = function captureOutputDescriptor(target, flags, ...args) {
      const descriptor = originalOpen(target, flags, ...args);
      if (path.resolve(String(target)) === path.resolve(output)) outputDescriptor = descriptor;
      return descriptor;
    };
    fsSync.closeSync = function closeThenFail(descriptor) {
      originalClose(descriptor);
      if (!injected && descriptor === outputDescriptor) {
        injected = true;
        throw new Error('injected reserved descriptor close failure');
      }
    };
    const failure = await freezeBoundedFileIntoReservation({
      inputPath: source, outputPath: output, maximumBytes: 1024, authority, outputAuthority,
    }).then(() => null, (error) => error);
    assert.ok(failure instanceof AggregateError);
    assert.match(failure.errors[0].message, /reserved descriptor.*close failure/iu);
    assert.equal(injected, true);
    await assert.rejects(fs.access(output), { code: 'ENOENT' });
  } finally {
    fsSync.openSync = originalOpen;
    fsSync.closeSync = originalClose;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('uploaded release freeze preserves primary drift and never deletes a cleanup replacement', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-upload-freeze-replacement-'));
  const source = path.join(root, 'release.tar.gz');
  const output = path.join(root, 'frozen.tar.gz');
  const displacedOutput = path.join(root, 'owned-frozen.tar.gz');
  const originalRead = fsSync.readSync;
  const originalOpen = fsSync.openSync;
  const originalClose = fsSync.closeSync;
  let outputDescriptor;
  let sourceMutated = false;
  let outputReplaced = false;
  try {
    const bytes = Buffer.alloc(2 * 1024 * 1024, 13);
    await fs.writeFile(source, bytes);
    const authority = captureBoundedFileAuthority({
      inputPath: source, maximumBytes: 3 * 1024 * 1024,
    });
    const outputAuthority = await reserveOutput(output, bytes.length);
    fsSync.openSync = function captureOutputDescriptor(target, flags, ...args) {
      const descriptor = originalOpen(target, flags, ...args);
      if (path.resolve(String(target)) === path.resolve(output)) outputDescriptor = descriptor;
      return descriptor;
    };
    fsSync.readSync = function readThenMutate(...args) {
      const count = originalRead(...args);
      if (!sourceMutated && count > 0) {
        sourceMutated = true;
        fsSync.appendFileSync(source, Buffer.from([14]));
        fsSync.truncateSync(source, Number(authority.size));
      }
      return count;
    };
    fsSync.closeSync = function closeAndReplace(descriptor) {
      originalClose(descriptor);
      if (!outputReplaced && descriptor === outputDescriptor) {
        outputReplaced = true;
        fsSync.renameSync(output, displacedOutput);
        fsSync.writeFileSync(output, 'foreign replacement', { mode: 0o600 });
      }
    };
    const failure = await freezeBoundedFileIntoReservation({
      inputPath: source,
      outputPath: output,
      maximumBytes: 3 * 1024 * 1024,
      authority,
      outputAuthority,
    }).then(() => null, (error) => error);
    assert.ok(failure instanceof AggregateError);
    assert.match(failure.errors[0].message, /identity changed during descriptor copy/iu,
      'the source drift must remain the first error');
    assert.match(failure.errors[1].message, /was replaced before cleanup/iu);
    assert.equal(sourceMutated, true);
    assert.equal(outputReplaced, true);
    assert.equal(await fs.readFile(output, 'utf8'), 'foreign replacement');
  } finally {
    fsSync.readSync = originalRead;
    fsSync.openSync = originalOpen;
    fsSync.closeSync = originalClose;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('uploaded release freeze rejects a silent output swap during descriptor close', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-upload-freeze-close-swap-'));
  const source = path.join(root, 'release.tar.gz');
  const output = path.join(root, 'frozen.tar.gz');
  const displacedOutput = path.join(root, 'owned-frozen.tar.gz');
  const originalOpen = fsSync.openSync;
  const originalClose = fsSync.closeSync;
  let outputDescriptor;
  let outputReplaced = false;
  try {
    const bytes = Buffer.from('canonical archive');
    await fs.writeFile(source, bytes);
    const authority = captureBoundedFileAuthority({ inputPath: source, maximumBytes: 1024 });
    const outputAuthority = await reserveOutput(output, bytes.length);
    fsSync.openSync = function captureOutputDescriptor(target, flags, ...args) {
      const descriptor = originalOpen(target, flags, ...args);
      if (path.resolve(String(target)) === path.resolve(output)) outputDescriptor = descriptor;
      return descriptor;
    };
    fsSync.closeSync = function closeAndReplace(descriptor) {
      originalClose(descriptor);
      if (!outputReplaced && descriptor === outputDescriptor) {
        outputReplaced = true;
        fsSync.renameSync(output, displacedOutput);
        fsSync.writeFileSync(output, 'foreign replacement', { mode: 0o600 });
      }
    };
    const failure = await freezeBoundedFileIntoReservation({
      inputPath: source, outputPath: output, maximumBytes: 1024, authority, outputAuthority,
    }).then(() => null, (error) => error);
    assert.ok(failure instanceof AggregateError);
    assert.match(failure.errors[0].message, /changed after descriptor close/iu);
    assert.match(failure.errors[1].message, /was replaced before cleanup/iu);
    assert.equal(outputReplaced, true);
    assert.equal(await fs.readFile(output, 'utf8'), 'foreign replacement');
  } finally {
    fsSync.openSync = originalOpen;
    fsSync.closeSync = originalClose;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('uploaded release freeze writes through an identity-bound preallocated destination', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-upload-freeze-reserved-'));
  const source = path.join(root, 'release.tar.gz');
  const output = path.join(root, 'reserved-release.tar.gz');
  try {
    const bytes = Buffer.alloc(1024 * 1024, 11);
    await fs.writeFile(source, bytes);
    const authority = captureBoundedFileAuthority({
      inputPath: source, maximumBytes: 2 * 1024 * 1024,
    });
    const outputAuthority = await reserveOutput(output, bytes.length);
    const result = await freezeBoundedFileIntoReservation({
      inputPath: source,
      outputPath: output,
      maximumBytes: 2 * 1024 * 1024,
      authority,
      outputAuthority,
    });
    assert.equal(result.bytes, bytes.length);
    assert.equal(result.sha256, crypto.createHash('sha256').update(bytes).digest('hex'));
    assert.deepEqual(await fs.readFile(output), bytes);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
