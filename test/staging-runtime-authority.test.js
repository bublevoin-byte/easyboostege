import assert from 'node:assert/strict';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  captureOptionalPrivateFile,
  captureProtectedRuntime,
  captureReleaseStore,
  captureReservation,
  readCanonicalShaFile,
  readEnvironmentPort,
  verifyOptionalPrivateFile,
  verifyProtectedRuntime,
  verifyReleaseStore,
  verifyReservation,
} from '../scripts/staging-runtime-authority.js';

async function privateDirectory(directory) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o700);
}

async function createRuntime(root) {
  const appDirectory = path.join(root, 'app');
  await privateDirectory(appDirectory);
  await privateDirectory(path.join(appDirectory, 'backups'));
  await privateDirectory(path.join(appDirectory, 'rollbacks'));
  await privateDirectory(path.join(appDirectory, 'rollbacks', 'releases'));
  await fs.writeFile(path.join(appDirectory, '.env.staging'),
    'APP_URL=https://staging.useboost.ru\nSECRET=private\n', { mode: 0o600 });
  await fs.chmod(path.join(appDirectory, '.env.staging'), 0o600);
  await fs.writeFile(path.join(appDirectory, '.staging-release.lock'), '', { mode: 0o600 });
  await fs.chmod(path.join(appDirectory, '.staging-release.lock'), 0o600);
  return appDirectory;
}

test('protected runtime authority pins exact environment bytes and private role metadata', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-runtime-authority-'));
  try {
    const appDirectory = await createRuntime(root);
    const authority = captureProtectedRuntime({ appDirectory });
    verifyProtectedRuntime({ appDirectory, authority });
    const environment = path.join(appDirectory, '.env.staging');
    const before = await fs.readFile(environment, 'utf8');
    const changed = before.replace('private', 'changed');
    assert.equal(Buffer.byteLength(changed), Buffer.byteLength(before));
    await fs.writeFile(environment, changed);
    await assert.rejects(async () => verifyProtectedRuntime({ appDirectory, authority }),
      /environment.*changed|runtime authority changed/iu);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('canonical active and retained SHA files are bounded, private, no-follow and single-link', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-sha-authority-'));
  const sha = 'a'.repeat(64);
  try {
    const valid = path.join(root, 'valid.sha256');
    await fs.writeFile(valid, `${sha}\n`, { mode: 0o600 });
    await fs.chmod(valid, 0o600);
    assert.equal(readCanonicalShaFile({ file: valid, role: 'test marker' }), sha);

    for (const [name, body] of [
      ['multiline', `${sha}\nextra\n`],
      ['huge', `${sha}\n${'x'.repeat(1024 * 1024)}`],
    ]) {
      const invalid = path.join(root, name);
      await fs.writeFile(invalid, body, { mode: 0o600 });
      await assert.rejects(async () => readCanonicalShaFile({ file: invalid, role: name }),
        /exactly one|byte bound|65/iu);
    }
    const hardlink = path.join(root, 'hardlink.sha256');
    await fs.link(valid, hardlink);
    await assert.rejects(async () => readCanonicalShaFile({ file: valid, role: 'hardlink marker' }),
      /single-link|link count/iu);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('reservation authority rejects a same-size sparse replacement before capacity is consumed', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-reservation-authority-'));
  const reservation = path.join(root, 'reservation');
  try {
    await fs.writeFile(reservation, Buffer.alloc(64 * 1024, 1), { mode: 0o600 });
    await fs.chmod(reservation, 0o600);
    const authority = captureReservation({ file: reservation, minimumBytes: 64 * 1024 });
    verifyReservation({ file: reservation, minimumBytes: 64 * 1024, authority });
    const replacement = path.join(root, 'replacement');
    await fs.writeFile(replacement, Buffer.alloc(0), { mode: 0o600 });
    await fs.truncate(replacement, 64 * 1024);
    await fs.rm(reservation);
    await fs.rename(replacement, reservation);
    await assert.rejects(async () => verifyReservation({
      file: reservation, minimumBytes: 64 * 1024, authority,
    }), /reservation.*(?:identity|allocated|changed)/iu);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('reservation authority proves allocation from descriptor metadata without reading its payload',
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-reservation-no-read-'));
    const reservation = path.join(root, 'reservation');
    try {
      await fs.writeFile(reservation, Buffer.alloc(4096), { mode: 0o600 });
      await fs.chmod(reservation, 0o600);
      const operations = {
        closeSync: fsSync.closeSync.bind(fsSync),
        fstatSync: fsSync.fstatSync.bind(fsSync),
        lstatSync: fsSync.lstatSync.bind(fsSync),
        openSync: fsSync.openSync.bind(fsSync),
        readFileSync() {
          throw new Error('reservation payload must not be read');
        },
      };
      const authority = captureReservation({
        file: reservation, minimumBytes: 4096, operations,
      });
      assert.equal(authority.size, '4096');
      assert.ok(Number(authority.allocatedBytes) >= 4096);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

test('Windows reservation authority ignores non-authoritative block-count drift', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-reservation-windows-blocks-'));
  const reservation = path.join(root, 'reservation');
  try {
    await fs.writeFile(reservation, Buffer.alloc(4096), { mode: 0o600 });
    await fs.chmod(reservation, 0o600);
    let reportedBlocks = 8n;
    const withReportedBlocks = (stat) => new Proxy(stat, {
      get(target, property) {
        if (property === 'blocks') return reportedBlocks;
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const operations = {
      closeSync: fsSync.closeSync.bind(fsSync),
      fstatSync(descriptor, options) {
        return withReportedBlocks(fsSync.fstatSync(descriptor, options));
      },
      lstatSync(file, options) {
        return withReportedBlocks(fsSync.lstatSync(file, options));
      },
      openSync: fsSync.openSync.bind(fsSync),
    };
    const first = captureReservation({
      file: reservation, minimumBytes: 4096, operations, platform: 'win32',
    });
    reportedBlocks = 16n;
    const second = captureReservation({
      file: reservation, minimumBytes: 4096, operations, platform: 'win32',
    });
    assert.deepEqual(second, first,
      'Windows uses exact size as capacity authority; delayed block reporting is not authoritative');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('Windows reservation capture ignores block-count drift within one descriptor capture', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-reservation-windows-capture-'));
  const reservation = path.join(root, 'reservation');
  try {
    await fs.writeFile(reservation, Buffer.alloc(4096), { mode: 0o600 });
    await fs.chmod(reservation, 0o600);
    let metadataRead = 0n;
    const withDriftingBlocks = (stat) => new Proxy(stat, {
      get(target, property) {
        if (property === 'blocks') return 8n + metadataRead++;
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const operations = {
      closeSync: fsSync.closeSync.bind(fsSync),
      fstatSync(descriptor, options) {
        return withDriftingBlocks(fsSync.fstatSync(descriptor, options));
      },
      lstatSync(file, options) {
        return withDriftingBlocks(fsSync.lstatSync(file, options));
      },
      openSync: fsSync.openSync.bind(fsSync),
    };

    const authority = captureReservation({
      file: reservation, minimumBytes: 4096, operations, platform: 'win32',
    });
    assert.equal(authority.blocks, null);
    assert.equal(authority.allocatedBytes, 4096);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('Linux reservation authority still requires descriptor-proven allocated blocks', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-reservation-linux-blocks-'));
  const reservation = path.join(root, 'reservation');
  try {
    await fs.writeFile(reservation, Buffer.alloc(4096), { mode: 0o600 });
    await fs.chmod(reservation, 0o600);
    const withInsufficientBlocks = (stat) => new Proxy(stat, {
      get(target, property) {
        if (property === 'blocks') return 1n;
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const operations = {
      closeSync: fsSync.closeSync.bind(fsSync),
      fstatSync(descriptor, options) {
        return withInsufficientBlocks(fsSync.fstatSync(descriptor, options));
      },
      lstatSync(file, options) {
        return withInsufficientBlocks(fsSync.lstatSync(file, options));
      },
      openSync: fsSync.openSync.bind(fsSync),
    };
    assert.throws(() => captureReservation({
      file: reservation, minimumBytes: 4096, operations, platform: 'linux',
    }), /allocated capacity could not be proven/iu);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('runtime directory authority tolerates intentional tree topology but not root replacement',
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-runtime-topology-'));
    try {
      const appDirectory = await createRuntime(root);
      const authority = captureProtectedRuntime({ appDirectory });
      await fs.mkdir(path.join(appDirectory, 'candidate-top-level-directory'));
      assert.doesNotThrow(() => verifyProtectedRuntime({ appDirectory, authority }));
      await fs.rmdir(path.join(appDirectory, 'candidate-top-level-directory'));
      const replacement = path.join(root, 'replacement');
      await fs.rename(appDirectory, replacement);
      await privateDirectory(appDirectory);
      await assert.rejects(async () => verifyProtectedRuntime({ appDirectory, authority }),
        /authority changed|missing|no such file/iu);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

test('release-store authority closes membership and identity while excluding only the pinned reservation',
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-store-authority-'));
    try {
      const store = path.join(root, 'releases');
      await privateDirectory(store);
      const archive = path.join(store, `release-${'a'.repeat(64)}.tar.gz`);
      const sidecar = `${archive}.sha256`;
      const reservation = path.join(store, '.staging-space-reservation.1');
      await fs.writeFile(archive, 'archive', { mode: 0o600 });
      await fs.writeFile(sidecar, `${'a'.repeat(64)}\n`, { mode: 0o600 });
      await fs.writeFile(reservation, Buffer.alloc(4096), { mode: 0o600 });
      await Promise.all([archive, sidecar, reservation].map((file) => fs.chmod(file, 0o600)));
      const authority = captureReleaseStore({ directory: store, ignoredReservation: reservation });
      verifyReleaseStore({ directory: store, ignoredReservation: reservation, authority });

      await fs.truncate(reservation, 2048);
      assert.doesNotThrow(() => verifyReleaseStore({
        directory: store, ignoredReservation: reservation, authority,
      }), 'the separately pinned reservation may change size without opening store membership');

      const injected = path.join(store, 'unowned');
      await fs.writeFile(injected, 'unexpected', { mode: 0o600 });
      await assert.rejects(async () => verifyReleaseStore({
        directory: store, ignoredReservation: reservation, authority,
      }), /store.*(?:identity|membership|changed)/iu);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

test('optional marker authority pins absence and exact later bytes without leaking the marker body',
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-marker-authority-'));
    const marker = path.join(root, '.marker');
    try {
      const absent = captureOptionalPrivateFile({ file: marker, role: 'transaction marker' });
      verifyOptionalPrivateFile({ file: marker, role: 'transaction marker', authority: absent });
      await fs.writeFile(marker, 'release transaction in progress\n', { mode: 0o600 });
      await fs.chmod(marker, 0o600);
      await assert.rejects(async () => verifyOptionalPrivateFile({
        file: marker, role: 'transaction marker', authority: absent,
      }), /presence|identity|bytes changed/iu);
      const present = captureOptionalPrivateFile({ file: marker, role: 'transaction marker' });
      verifyOptionalPrivateFile({ file: marker, role: 'transaction marker', authority: present });
      await fs.writeFile(marker, 'manual recovery required\n', { mode: 0o600 });
      await assert.rejects(async () => verifyOptionalPrivateFile({
        file: marker, role: 'transaction marker', authority: present,
      }), (error) => {
        assert.match(error.message, /identity|bytes changed/iu);
        assert.doesNotMatch(error.message, /manual recovery required/iu);
        return true;
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

test('environment port is descriptor-read from the pinned private file and is exact', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-env-port-'));
  const environment = path.join(root, '.env.staging');
  try {
    await fs.writeFile(environment, 'APP_PORT=3001\n', { mode: 0o600 });
    await fs.chmod(environment, 0o600);
    assert.equal(readEnvironmentPort({ file: environment }), '3001');
    await fs.writeFile(environment, 'APP_PORT=3002\n', { mode: 0o600 });
    assert.throws(() => readEnvironmentPort({ file: environment }), /exactly 3001/iu);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
