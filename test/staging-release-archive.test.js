import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { deflateRawSync } from 'node:zlib';

import {
  ARCHIVE_LIMITS,
  createReleaseArchive,
  extractReleaseArchive,
  prepareReleaseTreeForCopy,
  validateReleaseArchive,
  verifyReleaseTree,
} from '../scripts/staging-release-archive.js';
import { gitTrackedFiles, readCandidateFileManifest } from '../scripts/verify-docker-context.js';

const projectDirectory = path.resolve('.');

const CRC32_TABLE = Uint32Array.from({ length: 256 }, (_, byte) => {
  let value = byte;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
  }
  return value >>> 0;
});

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = CRC32_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function canonicalGzip(tar, { fhcrc = false, level = 9 } = {}) {
  const header = Buffer.from([0x1f, 0x8b, 0x08, fhcrc ? 0x02 : 0x00,
    0x00, 0x00, 0x00, 0x00, 0x02, 0xff]);
  const optional = fhcrc ? Buffer.from([0x00, 0x00]) : Buffer.alloc(0);
  const trailer = Buffer.alloc(8);
  trailer.writeUInt32LE(crc32(tar), 0);
  trailer.writeUInt32LE(tar.length >>> 0, 4);
  return Buffer.concat([header, optional, deflateRawSync(tar, { level }), trailer]);
}

function rawArchive(entries, {
  corruptChecksum = false,
  fhcrc = false,
  level = 9,
  trailing = Buffer.alloc(0),
} = {}) {
  const blocks = [];
  for (const entry of entries) {
    const body = Buffer.from(entry.body ?? '');
    const header = Buffer.alloc(512);
    Buffer.from(entry.rawName ?? entry.name).copy(header, 0, 0, 100);
    header.write('0000644\0', 100, 8, 'ascii');
    header.write(`${(entry.uid ?? 0).toString(8).padStart(7, '0')}\0`, 108, 8, 'ascii');
    header.write('0000000\0', 116, 8, 'ascii');
    const size = entry.declaredSize ?? body.length;
    header.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
    header.write('00000000000\0', 136, 12, 'ascii');
    header.fill(0x20, 148, 156);
    header[156] = (entry.type ?? '0').charCodeAt(0);
    header.write('ustar\0', 257, 6, 'ascii');
    header.write('00', 263, 2, 'ascii');
    header.write('0000000\0', 329, 8, 'ascii');
    header.write('0000000\0', 337, 8, 'ascii');
    const checksum = header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0');
    header.write(checksum, 148, 6, 'ascii');
    header[154] = 0;
    header[155] = 0x20;
    if (corruptChecksum) header[0] ^= 1;
    blocks.push(header, body, Buffer.alloc(Math.ceil(body.length / 512) * 512 - body.length));
  }
  blocks.push(Buffer.alloc(1024), trailing);
  return canonicalGzip(Buffer.concat(blocks), { fhcrc, level });
}

async function writeArchive(root, bytes, name = 'release.tar.gz') {
  const file = path.join(root, name);
  await fs.writeFile(file, bytes);
  return file;
}

test('canonical staging archive creation, extraction and exact tree verification round trip', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-archive-roundtrip-'));
  try {
    const source = path.join(root, 'source');
    const destination = path.join(root, 'destination');
    await fs.mkdir(path.join(source, 'nested'), { recursive: true });
    await Promise.all([
      fs.writeFile(path.join(source, '.dockerignore'), '/backups\n'),
      fs.writeFile(path.join(source, 'Dockerfile'), 'FROM scratch\n'),
      fs.writeFile(path.join(source, 'compose.staging.yml'), 'services: {}\n'),
      fs.writeFile(path.join(source, 'nested', 'caf\u00e9.txt'), 'bounded\n'),
    ]);
    const archive = path.join(root, 'release.tar.gz');
    const created = await createReleaseArchive({
      sourceDirectory: source,
      files: ['.dockerignore', 'Dockerfile', 'compose.staging.yml', 'nested/caf\u00e9.txt'],
      outputPath: archive,
    });
    assert.match(created.sha256, /^[a-f0-9]{64}$/u);
    const inspected = await validateReleaseArchive({ archivePath: archive });
    assert.equal(inspected.files, 4);
    await extractReleaseArchive({ archivePath: archive, destination });
    const verified = await verifyReleaseTree({ archivePath: archive, directory: destination });
    assert.equal(verified.aggregateBytes, inspected.aggregateBytes);
    assert.equal(await fs.readFile(path.join(destination, 'nested', 'caf\u00e9.txt'), 'utf8'), 'bounded\n');
    await fs.writeFile(path.join(destination, 'undeclared.txt'), 'extra\n');
    await assert.rejects(
      verifyReleaseTree({ archivePath: archive, directory: destination }),
      /undeclared\.txt.*undeclared/u,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('copy preparation restores only directory writability after release freezing', async (context) => {
  if (process.platform === 'win32') {
    context.skip('Windows does not expose the POSIX directory modes used by staging');
    return;
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-archive-copy-mode-'));
  try {
    const nested = path.join(root, 'nested');
    const file = path.join(nested, 'immutable.txt');
    await fs.mkdir(nested);
    await fs.writeFile(file, 'immutable\n', { mode: 0o400 });
    await fs.chmod(nested, 0o500);
    await fs.chmod(root, 0o500);

    const result = await prepareReleaseTreeForCopy({ directory: root });

    assert.deepEqual(result, { directories: 2, files: 1 });
    assert.equal((await fs.stat(root)).mode & 0o777, 0o700);
    assert.equal((await fs.stat(nested)).mode & 0o777, 0o700);
    assert.equal((await fs.stat(file)).mode & 0o777, 0o400,
      'copy preparation must preserve immutable file modes');
  } finally {
    await fs.chmod(root, 0o700).catch(() => {});
    await fs.chmod(path.join(root, 'nested'), 0o700).catch(() => {});
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('staging archive accepts only already-canonical relative POSIX NFC names', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-archive-names-'));
  try {
    for (const name of [
      '.env.staging//', './Dockerfile', '/Dockerfile', 'C:/Dockerfile', 'a\\b',
      'a/./b', 'a/../b', 'a//b', 'a/', `control-${String.fromCharCode(1)}`,
      'cafe\u0301.txt',
    ]) {
      const archive = await writeArchive(root, rawArchive([{ name }]),
        `${crypto.createHash('sha256').update(name).digest('hex')}.tar.gz`);
      await assert.rejects(validateReleaseArchive({ archivePath: archive }), /unsafe release archive/iu,
        `must reject noncanonical name ${JSON.stringify(name)}`);
    }
    for (const names of [
      ['Dockerfile', 'dockerfile'],
      ['caf\u00e9.txt', 'cafe\u0301.txt'],
      ['parent', 'parent/child.txt'],
    ]) {
      const archive = await writeArchive(root, rawArchive(names.map((name) => ({ name }))));
      await assert.rejects(validateReleaseArchive({ archivePath: archive }),
        /(?:collision|prefix|canonical)/iu);
    }
    for (const name of [
      '.env.staging', 'backups/private.dump', 'rollbacks/releases/x', '.release-sha256',
      '.staging-release.lock', '.staging-recovery-required',
      '.guarded-staging-build-context-required/Dockerfile',
    ]) {
      const archive = await writeArchive(root, rawArchive([{ name }]));
      await assert.rejects(validateReleaseArchive({ archivePath: archive }), /protected runtime path/iu);
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('staging archive rejects links, directories, metadata, corrupt tables and trailing payloads', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-archive-types-'));
  try {
    for (const type of ['1', '2', '5', '6', 'x', 'g', 'S']) {
      const archive = await writeArchive(root, rawArchive([{ name: `entry-${type}`, type }]));
      await assert.rejects(validateReleaseArchive({ archivePath: archive }), /member type/iu);
    }
    const corrupt = await writeArchive(root, rawArchive([{ name: 'Dockerfile' }], {
      corruptChecksum: true,
    }));
    await assert.rejects(validateReleaseArchive({ archivePath: corrupt }), /checksum/iu);
    const trailing = await writeArchive(root, rawArchive([{ name: 'Dockerfile' }], {
      trailing: Buffer.from('not-zero-trailing-data'),
    }));
    await assert.rejects(validateReleaseArchive({ archivePath: trailing }), /trailing/iu);
    const truncated = await writeArchive(root, canonicalGzip(Buffer.alloc(513)));
    await assert.rejects(validateReleaseArchive({ archivePath: truncated }), /truncated|terminator/iu);
    const member = rawArchive([{ name: 'Dockerfile' }]);
    const concatenated = await writeArchive(root, Buffer.concat([member, member]));
    await assert.rejects(validateReleaseArchive({ archivePath: concatenated }), /concatenated|trailing gzip/iu);
    const compressedTrailing = await writeArchive(root, Buffer.concat([member, Buffer.from('tail')]));
    await assert.rejects(validateReleaseArchive({ archivePath: compressedTrailing }), /trailing gzip/iu);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('staging archive accepts only the exact producer gzip and USTAR byte contract', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-archive-canonical-bytes-'));
  try {
    const invalid = [
      ['FHCRC flag', rawArchive([{ name: 'Dockerfile' }], { fhcrc: true })],
      ['nonzero uid', rawArchive([{ name: 'Dockerfile', uid: 1 }])],
      ['BOM name', rawArchive([{
        name: 'Dockerfile',
        rawName: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('Dockerfile')]),
      }])],
      ['surplus zero trailer', rawArchive([{ name: 'Dockerfile' }], {
        trailing: Buffer.alloc(512),
      })],
      ['alternate deflate level', rawArchive([{ name: 'Dockerfile', body: 'canonical\n' }], {
        level: 1,
      })],
      ['reversed member order', rawArchive([
        { name: 'z-last.txt', body: 'last\n' },
        { name: 'a-first.txt', body: 'first\n' },
      ])],
    ];
    for (const [label, bytes] of invalid) {
      const archive = await writeArchive(root, bytes,
        `${label.replaceAll(' ', '-').toLowerCase()}.tar.gz`);
      await assert.rejects(validateReleaseArchive({ archivePath: archive }),
        /unsafe release archive/iu, label);
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('protected staging runtime namespaces are rejected under canonical case folding', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-archive-protected-fold-'));
  try {
    for (const name of [
      '.ENV.STAGING', 'BACKUPS/private.dump', 'ROLLBACKS/releases/x',
      '.RELEASE-SHA256', '.STAGING-RECOVERY-REQUIRED', '.RELEASE-ARCHIVE-IN-PROGRESS',
    ]) {
      const archive = await writeArchive(root, rawArchive([{ name }]),
        `${crypto.createHash('sha256').update(name).digest('hex')}.tar.gz`);
      await assert.rejects(validateReleaseArchive({ archivePath: archive }),
        /protected runtime path/iu, name);
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('staging archive enforces compressed, member, file, aggregate, disk and time bounds', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-archive-bounds-'));
  try {
    const archive = await writeArchive(root, rawArchive([
      { name: 'a.txt', body: '1234' }, { name: 'b.txt', body: '5678' },
    ]));
    for (const [override, pattern] of [
      [{ maxCompressedBytes: 1 }, /compressed byte bound/u],
      [{ maxMembers: 1 }, /member count bound/u],
      [{ maxFileBytes: 3 }, /per-file byte bound/u],
      [{ maxAggregateBytes: 7 }, /expanded byte bound/u],
    ]) {
      await assert.rejects(validateReleaseArchive({
        archivePath: archive, limits: { ...ARCHIVE_LIMITS, ...override },
      }), pattern);
    }
    await assert.rejects(extractReleaseArchive({
      archivePath: archive,
      destination: path.join(root, 'disk-bound'),
      availableDiskBytes: () => 1,
    }), /disk headroom/u);
    let tick = 0;
    await assert.rejects(validateReleaseArchive({
      archivePath: archive,
      now: () => { tick += 61_000; return tick; },
    }), /validation time bound/u);

    const exactPaddingArchive = await writeArchive(root, rawArchive([
      { name: 'a.txt', body: 'a' }, { name: 'b.txt', body: 'b' },
    ]), 'exact-padding.tar.gz');
    const exactPadding = await validateReleaseArchive({
      archivePath: exactPaddingArchive,
      limits: {
        ...ARCHIVE_LIMITS,
        maxAggregateBytes: 2,
        maxFileBytes: 1,
        maxMembers: 2,
      },
    });
    assert.equal(exactPadding.aggregateBytes, 2,
      'inflate ceiling includes header plus worst-case padding for every member');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('the full tracked plus owned candidate release fits every declared archive bound', () => {
  const files = [...new Set([
    ...gitTrackedFiles(projectDirectory),
    ...readCandidateFileManifest({ projectDirectory }),
  ])].sort();
  let aggregate = 0;
  let tarBytes = 1024;
  for (const file of files) {
    const stat = fsSync.lstatSync(path.join(projectDirectory, file));
    assert.equal(stat.isFile(), true, `${file} must be a regular release input`);
    const bytes = stat.size;
    aggregate += bytes;
    tarBytes += 512 + Math.ceil(bytes / 512) * 512;
    assert.ok(bytes <= ARCHIVE_LIMITS.maxFileBytes, `${file} exceeds per-file bound`);
    assert.ok(Buffer.byteLength(file) <= ARCHIVE_LIMITS.maxPathBytes, `${file} exceeds path bound`);
  }
  assert.ok(files.length <= ARCHIVE_LIMITS.maxMembers);
  assert.ok(aggregate <= ARCHIVE_LIMITS.maxAggregateBytes);
  assert.ok(tarBytes <= ARCHIVE_LIMITS.maxCompressedBytes,
    'even the uncompressed canonical USTAR stays below the compressed input bound');
});
