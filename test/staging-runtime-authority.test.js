import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  captureCutoverJournalPreparing,
  captureLegacyCutoverFile,
  captureLegacyCutoverRoot,
  captureCutoverMarkerPreparing,
  captureOptionalPrivateFile,
  capturePostgresContainerAuthority,
  capturePostgresRuntimeAuthority,
  captureProtectedRuntime,
  captureReleaseStore,
  captureReservation,
  deriveCutoverLegacyAuthoritySha256,
  readCanonicalShaFile,
  readCutoverJournal,
  readEnvironmentPort,
  publishCutoverActiveMarker,
  publishCutoverJournal,
  verifyOptionalPrivateFile,
  verifyLegacyCutoverFile,
  verifyLegacyCutoverRoot,
  verifyCutoverJournalPreparingInventory,
  verifyProtectedRuntime,
  verifyReleaseStore,
  verifyReservation,
} from '../scripts/staging-runtime-authority.js';

const POSTGRES_CONTAINER_ID = 'a'.repeat(64);
const POSTGRES_IMAGE_ID = `sha256:${'b'.repeat(64)}`;
const POSTGRES_VOLUME_SOURCE = '/var/lib/docker/volumes/easyboost-staging_postgres-data/_data';
const CUTOVER_BRIDGE_SHA = '1'.repeat(64);
const CUTOVER_LEGACY_MARKER_SHA = '2'.repeat(64);
const CUTOVER_LEGACY_COMPOSE_SHA = '3'.repeat(64);
const CUTOVER_BUNDLE_SHA = '4'.repeat(64);
const CUTOVER_NONCE = '5'.repeat(64);
const CUTOVER_LEGACY_AUTHORITY_SHA = '6'.repeat(64);
const CUTOVER_LEGACY_APP_MODE = '700';
const CUTOVER_LEGACY_MARKER_MODE = '644';
const CUTOVER_LEGACY_COMPOSE_MODE = '664';
const CUTOVER_LEGACY_MODE_BINDING = Object.freeze({
  legacyAppMode: CUTOVER_LEGACY_APP_MODE,
  legacyMarkerMode: CUTOVER_LEGACY_MARKER_MODE,
  legacyComposeMode: CUTOVER_LEGACY_COMPOSE_MODE,
  legacyAuthoritySha256: CUTOVER_LEGACY_AUTHORITY_SHA,
});

function postgresInspection(overrides = {}) {
  return {
    Id: POSTGRES_CONTAINER_ID,
    Image: POSTGRES_IMAGE_ID,
    Config: {
      Labels: {
        'com.docker.compose.project': 'easyboost-staging',
        'com.docker.compose.service': 'postgres',
        'com.docker.compose.oneoff': 'False',
      },
    },
    State: { Running: true, Health: { Status: 'healthy' } },
    Mounts: [{
      Type: 'volume',
      Name: 'easyboost-staging_postgres-data',
      Source: POSTGRES_VOLUME_SOURCE,
      Destination: '/var/lib/postgresql/data',
      Driver: 'local',
      Mode: 'z',
      Propagation: '',
      RW: true,
    }],
    ...overrides,
  };
}

function postgresVolumeInspection(overrides = {}) {
  return {
    Name: 'easyboost-staging_postgres-data',
    Driver: 'local',
    Scope: 'local',
    Mountpoint: POSTGRES_VOLUME_SOURCE,
    Labels: {
      'com.docker.compose.project': 'easyboost-staging',
      'com.docker.compose.volume': 'postgres-data',
    },
    Options: null,
    ...overrides,
  };
}

function legacyEnvironmentAuthority(overrides = {}) {
  const uid = typeof process.getuid === 'function' ? String(process.getuid()) : '0';
  const gid = typeof process.getgid === 'function' ? String(process.getgid()) : '0';
  return {
    dev: '1',
    ino: '20',
    mode: String(0o100600),
    nlink: '1',
    uid,
    gid,
    size: '18',
    blocks: process.platform === 'win32' ? null : '8',
    mtimeNs: '1',
    ctimeNs: '1',
    sha256: 'e'.repeat(64),
    ...overrides,
  };
}

test('PostgreSQL runtime authority binds the exact healthy Compose container and named volume', () => {
  const inspection = postgresInspection();
  const authority = capturePostgresRuntimeAuthority({
    inspection,
    volumeInspection: postgresVolumeInspection(),
    expectedContainerId: POSTGRES_CONTAINER_ID,
    expectedImageId: POSTGRES_IMAGE_ID,
  });
  assert.deepEqual(authority, {
    version: 2,
    containerId: POSTGRES_CONTAINER_ID,
    imageId: POSTGRES_IMAGE_ID,
    project: 'easyboost-staging',
    service: 'postgres',
    oneoff: 'False',
    running: true,
    health: 'healthy',
    volume: {
      type: 'volume',
      name: 'easyboost-staging_postgres-data',
      source: '/var/lib/docker/volumes/easyboost-staging_postgres-data/_data',
      destination: '/var/lib/postgresql/data',
      driver: 'local',
      mode: 'z',
      propagation: '',
      readWrite: true,
    },
    volumeObject: {
      name: 'easyboost-staging_postgres-data',
      driver: 'local',
      scope: 'local',
      mountpoint: POSTGRES_VOLUME_SOURCE,
      labels: {
        'com.docker.compose.project': 'easyboost-staging',
        'com.docker.compose.volume': 'postgres-data',
      },
      options: null,
    },
  });

  for (const [label, mutate] of [
    ['container ID', (model) => { model.Id = 'c'.repeat(64); }],
    ['image ID', (model) => { model.Image = `sha256:${'c'.repeat(64)}`; }],
    ['project label', (model) => { model.Config.Labels['com.docker.compose.project'] = 'foreign'; }],
    ['service label', (model) => { model.Config.Labels['com.docker.compose.service'] = 'app'; }],
    ['one-off label', (model) => { model.Config.Labels['com.docker.compose.oneoff'] = 'True'; }],
    ['running state', (model) => { model.State.Running = false; }],
    ['health state', (model) => { model.State.Health.Status = 'starting'; }],
    ['mount type', (model) => { model.Mounts[0].Type = 'bind'; }],
    ['volume name', (model) => { model.Mounts[0].Name = 'foreign'; }],
    ['mount source', (model) => { model.Mounts[0].Source = 'relative'; }],
    ['mount destination', (model) => { model.Mounts[0].Destination = '/tmp'; }],
    ['read-only mount', (model) => { model.Mounts[0].RW = false; }],
    ['duplicate data mount', (model) => { model.Mounts.push({ ...model.Mounts[0] }); }],
  ]) {
    const changed = structuredClone(inspection);
    mutate(changed);
    assert.throws(() => capturePostgresRuntimeAuthority({
      inspection: changed,
      volumeInspection: postgresVolumeInspection(),
      expectedContainerId: POSTGRES_CONTAINER_ID,
      expectedImageId: POSTGRES_IMAGE_ID,
    }), /PostgreSQL|container|image|Compose|running|healthy|volume|mount/iu, label);
  }


  for (const [label, mutate] of [
    ['volume object name', (model) => { model.Name = 'foreign'; }],
    ['volume object driver', (model) => { model.Driver = 'nfs'; }],
    ['volume object scope', (model) => { model.Scope = 'global'; }],
    ['volume object mountpoint', (model) => { model.Mountpoint = '/foreign'; }],
    ['volume object project label', (model) => { model.Labels['com.docker.compose.project'] = 'foreign'; }],
    ['volume object logical label', (model) => { model.Labels['com.docker.compose.volume'] = 'foreign'; }],
    ['volume object options', (model) => { model.Options = { type: 42 }; }],
  ]) {
    const changed = structuredClone(postgresVolumeInspection());
    mutate(changed);
    assert.throws(() => capturePostgresRuntimeAuthority({
      inspection,
      volumeInspection: changed,
      expectedContainerId: POSTGRES_CONTAINER_ID,
      expectedImageId: POSTGRES_IMAGE_ID,
    }), /PostgreSQL|volume|driver|scope|mountpoint|label|option/iu, label);
  }
});

test('PostgreSQL inspection CLIs reject oversized input before JSON parsing', () => {
  const modulePath = path.resolve('scripts/staging-runtime-authority.js');
  const containerAuthority = capturePostgresContainerAuthority({
    inspection: postgresInspection(),
    expectedContainerId: POSTGRES_CONTAINER_ID,
    expectedImageId: POSTGRES_IMAGE_ID,
  });
  for (const args of [
    ['capture-postgres-container', POSTGRES_CONTAINER_ID, POSTGRES_IMAGE_ID],
    ['complete-postgres-runtime', JSON.stringify(containerAuthority)],
  ]) {
    const result = spawnSync(process.execPath, [modulePath, ...args], {
      encoding: 'utf8',
      input: 'x'.repeat((4 * 1024 * 1024) + 1),
      maxBuffer: 6 * 1024 * 1024,
    });
    assert.equal(result.status, 1, args[0]);
    assert.match(result.stderr, /byte bound/iu, args[0]);
    assert.doesNotMatch(result.stderr, /JSON/u, args[0]);
  }
});

test('cutover legacy authority digest binds predecessor directories, app and PostgreSQL', () => {
  const uid = typeof process.getuid === 'function' ? String(process.getuid()) : '0';
  const gid = typeof process.getgid === 'function' ? String(process.getgid()) : '0';
  const directory = (ino, mode = '700') => ({
    version: 1, dev: '1', ino, uid, gid, mode,
  });
  const input = {
    appDirectory: path.resolve('cutover-authority-app'),
    appRootAuthority: directory('10'),
    backupsAuthority: directory('11'),
    rollbacksAuthority: directory('12'),
    environmentAuthority: legacyEnvironmentAuthority(),
    runningAppContainer: 'c'.repeat(64),
    runningAppImage: `sha256:${'d'.repeat(64)}`,
    postgresRuntimeAuthority: capturePostgresRuntimeAuthority({
      inspection: postgresInspection(),
      volumeInspection: postgresVolumeInspection(),
      expectedContainerId: POSTGRES_CONTAINER_ID,
      expectedImageId: POSTGRES_IMAGE_ID,
    }),
  };
  const digest = deriveCutoverLegacyAuthoritySha256(input);
  assert.match(digest, /^[a-f0-9]{64}$/u);
  assert.equal(deriveCutoverLegacyAuthoritySha256({
    ...input,
    appRootAuthority: { ...input.appRootAuthority, mode: '755' },
  }), digest, 'journal-authorized root-mode normalization must preserve stable predecessor identity');
  assert.notEqual(deriveCutoverLegacyAuthoritySha256({
    ...input,
    appRootAuthority: { ...input.appRootAuthority, ino: '99' },
  }), digest, 'recreating the app root must change the durable authority binding');
  assert.notEqual(deriveCutoverLegacyAuthoritySha256({
    ...input,
    runningAppContainer: 'e'.repeat(64),
  }), digest, 'recreating the app container must change the durable authority binding');
  assert.notEqual(deriveCutoverLegacyAuthoritySha256({
    ...input,
    environmentAuthority: {
      ...input.environmentAuthority,
      sha256: 'f'.repeat(64),
    },
  }), digest, 'changing the environment bytes must change the durable authority binding');
  assert.notEqual(deriveCutoverLegacyAuthoritySha256({
    ...input,
    environmentAuthority: {
      ...input.environmentAuthority,
      ino: '21',
    },
  }), digest, 'replacing the environment inode must change the durable authority binding');
  const changedPostgres = structuredClone(input.postgresRuntimeAuthority);
  changedPostgres.volumeObject.mountpoint = '/different-volume';
  changedPostgres.volume.source = '/different-volume';
  assert.notEqual(deriveCutoverLegacyAuthoritySha256({
    ...input, postgresRuntimeAuthority: changedPostgres,
  }), digest, 'changing the PostgreSQL volume must change the durable authority binding');
  assert.throws(() => deriveCutoverLegacyAuthoritySha256({
    ...input,
    appDirectory: `${input.appDirectory}${path.sep}..${path.sep}${path.basename(input.appDirectory)}`,
  }), /runtime authority input is invalid/u,
  'a lexical alias must be rejected before it can name durable cutover state');
});

test('cutover shell derives the complete predecessor authority before journal naming', async () => {
  const source = await fs.readFile(path.resolve('scripts/staging-cutover.sh'), 'utf8');
  const canonicalAppCheck = source.indexOf('Staging app directory must be absolute and canonical');
  const environmentCapture = source.indexOf(
    'legacy_environment_authority="$(capture_legacy_file "$env_file"',
  );
  const runtimeCapture = source.indexOf('capture_running_pair || exit 67');
  const authorityDerivation = source.indexOf('derive-cutover-legacy-authority "$app_dir"');
  const nonceDerivation = source.indexOf(
    'expected_cutover_journal_nonce="$(derive_cutover_journal_nonce)"',
  );
  const journalPublication = source.lastIndexOf('begin_cutover_transaction || exit 70');
  assert.ok(canonicalAppCheck >= 0 && canonicalAppCheck < runtimeCapture);
  assert.ok(environmentCapture >= 0 && environmentCapture < runtimeCapture);
  assert.ok(runtimeCapture >= 0 && runtimeCapture < authorityDerivation);
  assert.match(source,
    /"\$legacy_backups_identity" "\$legacy_rollbacks_identity" \\\n\s+"\$legacy_environment_authority" "\$running_app_container"/u);
  assert.ok(authorityDerivation < nonceDerivation);
  assert.ok(nonceDerivation < journalPublication);
  assert.match(source,
    /expected_legacy_compose_mode" "\$legacy_authority_sha" "\$expected_bundle_digest/u);
  assert.match(source,
    /expected_legacy_compose_mode" "\$legacy_authority_sha" \\\n\s+"\$expected_bundle_digest"/u);
});

async function privateDirectory(directory) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o700);
}

test('legacy cutover authority binds the observed 700/644/664 boundary exactly', {
  skip: process.platform === 'win32',
}, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-cutover-legacy-mode-'));
  const marker = path.join(root, '.release-sha256');
  const compose = path.join(root, 'compose.staging.yml');
  const environment = path.join(root, '.env.staging');
  const backups = path.join(root, 'backups');
  const rollbacks = path.join(root, 'rollbacks');
  try {
    await fs.chmod(root, 0o700);
    await privateDirectory(backups);
    await privateDirectory(rollbacks);
    await fs.writeFile(marker, `${CUTOVER_LEGACY_MARKER_SHA}\n`, { mode: 0o644 });
    await fs.writeFile(compose, 'services: {}\n', { mode: 0o664 });
    await fs.writeFile(environment, 'APP_PORT=3001\n', { mode: 0o600 });
    await fs.chmod(marker, 0o644);
    await fs.chmod(compose, 0o664);
    await fs.chmod(environment, 0o600);

    const rootAuthority = captureLegacyCutoverRoot({ directory: root, expectedMode: 0o700 });
    const markerAuthority = captureLegacyCutoverFile({
      file: marker, kind: 'marker', expectedMode: 0o644, maximumBytes: 65,
    });
    const composeAuthority = captureLegacyCutoverFile({
      file: compose, kind: 'compose', expectedMode: 0o664, maximumBytes: 4096,
    });
    assert.doesNotThrow(() => verifyLegacyCutoverRoot({
      directory: root, expectedMode: 0o700, authority: rootAuthority,
    }));
    assert.doesNotThrow(() => verifyLegacyCutoverFile({
      file: marker, kind: 'marker', expectedMode: 0o644, maximumBytes: 65,
      authority: markerAuthority,
    }));
    assert.doesNotThrow(() => verifyLegacyCutoverFile({
      file: compose, kind: 'compose', expectedMode: 0o664, maximumBytes: 4096,
      authority: composeAuthority,
    }));

    const runtimeModule = path.resolve('scripts/staging-runtime-authority.js');
    const captureDirectory = (directory) => spawnSync(process.execPath, [
      runtimeModule, 'capture-cutover-legacy-root', directory, String(0o700),
    ], { encoding: 'utf8' });
    const rootCli = captureDirectory(root);
    const backupsCli = captureDirectory(backups);
    const rollbacksCli = captureDirectory(rollbacks);
    for (const result of [rootCli, backupsCli, rollbacksCli]) {
      assert.equal(result.status, 0, result.stderr);
      assert.doesNotThrow(() => JSON.parse(result.stdout));
    }
    const environmentCli = spawnSync(process.execPath, [
      runtimeModule, 'capture-file', environment, 'legacy staging environment',
      String(0o600), String(4 * 1024 * 1024),
    ], { encoding: 'utf8' });
    assert.equal(environmentCli.status, 0, environmentCli.stderr);
    assert.doesNotThrow(() => JSON.parse(environmentCli.stdout));
    const postgres = capturePostgresRuntimeAuthority({
      inspection: postgresInspection(),
      volumeInspection: postgresVolumeInspection(),
      expectedContainerId: POSTGRES_CONTAINER_ID,
      expectedImageId: POSTGRES_IMAGE_ID,
    });
    const derived = spawnSync(process.execPath, [
      runtimeModule,
      'derive-cutover-legacy-authority',
      root,
      rootCli.stdout.trim(),
      backupsCli.stdout.trim(),
      rollbacksCli.stdout.trim(),
      environmentCli.stdout.trim(),
      'c'.repeat(64),
      `sha256:${'d'.repeat(64)}`,
      JSON.stringify(postgres),
    ], { encoding: 'utf8' });
    assert.equal(derived.status, 0, derived.stderr);
    assert.match(derived.stdout, /^[a-f0-9]{64}\n$/u,
      'the exact shell-captured JSON authorities must cross the CLI boundary');

    const before = await fs.stat(compose, { bigint: true });
    const bytes = await fs.readFile(compose);
    await fs.chmod(compose, 0o644);
    assert.throws(() => verifyLegacyCutoverFile({
      file: compose, kind: 'compose', expectedMode: 0o664, maximumBytes: 4096,
      authority: composeAuthority,
    }), /exact private owner and mode/u);
    const after = await fs.stat(compose, { bigint: true });
    assert.equal(after.ino, before.ino);
    assert.deepEqual(await fs.readFile(compose), bytes,
      'a rejected legacy mode drift must not rewrite the legacy file');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

function cutoverJournalBytes() {
  return Buffer.from([
    'protocol=easyboost-staging-cutover-v1',
    `bridgeSha256=${CUTOVER_BRIDGE_SHA}`,
    `legacyMarkerSha256=${CUTOVER_LEGACY_MARKER_SHA}`,
    `legacyComposeSha256=${CUTOVER_LEGACY_COMPOSE_SHA}`,
    `legacyAppMode=${CUTOVER_LEGACY_APP_MODE}`,
    `legacyMarkerMode=${CUTOVER_LEGACY_MARKER_MODE}`,
    `legacyComposeMode=${CUTOVER_LEGACY_COMPOSE_MODE}`,
    `legacyAuthoritySha256=${CUTOVER_LEGACY_AUTHORITY_SHA}`,
    `bundleSha256=${CUTOVER_BUNDLE_SHA}`,
    `nonce=${CUTOVER_NONCE}`,
    '',
  ].join('\n'), 'ascii');
}

test('cutover journal rolls an exact deterministic prefix forward with no-replace publication',
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-cutover-journal-prefix-'));
    try {
      await fs.chmod(root, 0o700);
      const temporary = path.join(root, '.staging-recovery-required.cutover-prefix.preparing');
      const destination = path.join(root, '.staging-recovery-required');
      const canonical = cutoverJournalBytes();
      assert.throws(() => captureCutoverJournalPreparing({
        file: path.join(root, '.invalid-tuple.preparing'),
        ...CUTOVER_LEGACY_MODE_BINDING,
        legacyAppMode: '755',
        bridgeSha256: CUTOVER_BRIDGE_SHA,
        legacyMarkerSha256: CUTOVER_LEGACY_MARKER_SHA,
        legacyComposeSha256: CUTOVER_LEGACY_COMPOSE_SHA,
        bundleSha256: CUTOVER_BUNDLE_SHA,
        nonce: CUTOVER_NONCE,
      }), /legacy mode tuple is invalid/u,
      'mode 664 is admissible only inside an exact 0700 app root');
      await assert.rejects(fs.lstat(path.join(root, '.invalid-tuple.preparing')), {
        code: 'ENOENT',
      });
      await fs.writeFile(temporary, canonical.subarray(0, 113), { mode: 0o600 });
      await fs.chmod(temporary, 0o600);
      const authority = captureCutoverJournalPreparing({
        file: temporary,
        ...CUTOVER_LEGACY_MODE_BINDING,
        bridgeSha256: CUTOVER_BRIDGE_SHA,
        legacyMarkerSha256: CUTOVER_LEGACY_MARKER_SHA,
        legacyComposeSha256: CUTOVER_LEGACY_COMPOSE_SHA,
        bundleSha256: CUTOVER_BUNDLE_SHA,
        nonce: CUTOVER_NONCE,
      });
      publishCutoverJournal({
        temporary,
        destination,
        ...CUTOVER_LEGACY_MODE_BINDING,
        bridgeSha256: CUTOVER_BRIDGE_SHA,
        legacyMarkerSha256: CUTOVER_LEGACY_MARKER_SHA,
        legacyComposeSha256: CUTOVER_LEGACY_COMPOSE_SHA,
        bundleSha256: CUTOVER_BUNDLE_SHA,
        nonce: CUTOVER_NONCE,
        authority,
      });
      assert.deepEqual(await fs.readFile(destination), canonical);
      await assert.rejects(fs.lstat(temporary), { code: 'ENOENT' });
      assert.equal(readCutoverJournal({
        file: destination,
        ...CUTOVER_LEGACY_MODE_BINDING,
        bridgeSha256: CUTOVER_BRIDGE_SHA,
        legacyMarkerSha256: CUTOVER_LEGACY_MARKER_SHA,
        legacyComposeSha256: CUTOVER_LEGACY_COMPOSE_SHA,
        bundleSha256: CUTOVER_BUNDLE_SHA,
      }), CUTOVER_NONCE);
      const journalBefore = await fs.stat(destination, { bigint: true });
      assert.throws(() => readCutoverJournal({
        file: destination,
        ...CUTOVER_LEGACY_MODE_BINDING,
        legacyMarkerMode: '600',
        bridgeSha256: CUTOVER_BRIDGE_SHA,
        legacyMarkerSha256: CUTOVER_LEGACY_MARKER_SHA,
        legacyComposeSha256: CUTOVER_LEGACY_COMPOSE_SHA,
        bundleSha256: CUTOVER_BUNDLE_SHA,
      }), /does not match/u);
      const journalAfter = await fs.stat(destination, { bigint: true });
      assert.equal(journalAfter.ino, journalBefore.ino);
      assert.deepEqual(await fs.readFile(destination), canonical,
        'a cross-mode request must not mutate the journal');
      assert.throws(() => readCutoverJournal({
        file: destination,
        ...CUTOVER_LEGACY_MODE_BINDING,
        legacyAuthoritySha256: '7'.repeat(64),
        bridgeSha256: CUTOVER_BRIDGE_SHA,
        legacyMarkerSha256: CUTOVER_LEGACY_MARKER_SHA,
        legacyComposeSha256: CUTOVER_LEGACY_COMPOSE_SHA,
        bundleSha256: CUTOVER_BUNDLE_SHA,
      }), /does not match/u);
      assert.equal((await fs.stat(destination, { bigint: true })).ino, journalBefore.ino);
      assert.deepEqual(await fs.readFile(destination), canonical,
        'a recreated runtime authority must not mutate or adopt the journal');

      const second = path.join(root, '.second.preparing');
      await fs.writeFile(second, canonical.subarray(0, 11), { mode: 0o600 });
      await fs.chmod(second, 0o600);
      const secondAuthority = captureCutoverJournalPreparing({
        file: second,
        ...CUTOVER_LEGACY_MODE_BINDING,
        bridgeSha256: CUTOVER_BRIDGE_SHA,
        legacyMarkerSha256: CUTOVER_LEGACY_MARKER_SHA,
        legacyComposeSha256: CUTOVER_LEGACY_COMPOSE_SHA,
        bundleSha256: CUTOVER_BUNDLE_SHA,
        nonce: CUTOVER_NONCE,
      });
      assert.throws(() => publishCutoverJournal({
        temporary: second,
        destination,
        ...CUTOVER_LEGACY_MODE_BINDING,
        bridgeSha256: CUTOVER_BRIDGE_SHA,
        legacyMarkerSha256: CUTOVER_LEGACY_MARKER_SHA,
        legacyComposeSha256: CUTOVER_LEGACY_COMPOSE_SHA,
        bundleSha256: CUTOVER_BUNDLE_SHA,
        nonce: CUTOVER_NONCE,
        authority: secondAuthority,
      }), /already occupied/u);
      assert.deepEqual(await fs.readFile(destination), canonical,
        'no-replace publication must preserve an occupied journal destination');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

test('cutover journal preparing namespace admits only the one expected binding', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-cutover-journal-inventory-'));
  try {
    await fs.chmod(root, 0o700);
    const expected = path.join(
      root, `.staging-recovery-required.cutover-${CUTOVER_NONCE}.preparing`,
    );
    assert.deepEqual(verifyCutoverJournalPreparingInventory({
      appDirectory: root, expectedPath: expected,
    }), { present: false });
    await fs.writeFile(expected, Buffer.alloc(0), { mode: 0o600 });
    assert.deepEqual(verifyCutoverJournalPreparingInventory({
      appDirectory: root, expectedPath: expected,
    }), { name: path.basename(expected), present: true });

    const foreign = path.join(
      root, `.staging-recovery-required.cutover-${'6'.repeat(64)}.preparing`,
    );
    await fs.writeFile(foreign, 'foreign', { mode: 0o600 });
    const before = await fs.stat(foreign, { bigint: true });
    await assert.rejects(async () => verifyCutoverJournalPreparingInventory({
      appDirectory: root, expectedPath: expected,
    }), /foreign|multiple|namespace/iu);
    const after = await fs.stat(foreign, { bigint: true });
    assert.equal(after.ino, before.ino);
    assert.equal(await fs.readFile(foreign, 'utf8'), 'foreign');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('cutover prefix authority rejects foreign bytes, links and pathname swaps without deleting them',
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-cutover-prefix-reject-'));
    try {
      await fs.chmod(root, 0o700);
      const canonical = cutoverJournalBytes();
      for (const [name, bytes] of [
        ['middle', Buffer.from('protocol=Xasyboost-staging-cutover-v1', 'ascii')],
        ['suffix', Buffer.concat([canonical, Buffer.from('x')])],
      ]) {
        const file = path.join(root, name);
        await fs.writeFile(file, bytes, { mode: 0o600 });
        await fs.chmod(file, 0o600);
        assert.throws(() => captureCutoverJournalPreparing({
          file,
          ...CUTOVER_LEGACY_MODE_BINDING,
          bridgeSha256: CUTOVER_BRIDGE_SHA,
          legacyMarkerSha256: CUTOVER_LEGACY_MARKER_SHA,
          legacyComposeSha256: CUTOVER_LEGACY_COMPOSE_SHA,
          bundleSha256: CUTOVER_BUNDLE_SHA,
          nonce: CUTOVER_NONCE,
        }), /canonical prefix|byte bound/u, name);
        assert.deepEqual(await fs.readFile(file), bytes, `${name} bytes must remain untouched`);
      }

      const linked = path.join(root, 'linked');
      const peer = path.join(root, 'linked-peer');
      await fs.writeFile(linked, canonical.subarray(0, 8), { mode: 0o600 });
      await fs.chmod(linked, 0o600);
      await fs.link(linked, peer);
      assert.throws(() => captureCutoverJournalPreparing({
        file: linked,
        ...CUTOVER_LEGACY_MODE_BINDING,
        bridgeSha256: CUTOVER_BRIDGE_SHA,
        legacyMarkerSha256: CUTOVER_LEGACY_MARKER_SHA,
        legacyComposeSha256: CUTOVER_LEGACY_COMPOSE_SHA,
        bundleSha256: CUTOVER_BUNDLE_SHA,
        nonce: CUTOVER_NONCE,
      }), /single-link/u);
      assert.equal((await fs.lstat(linked)).nlink, 2);

      if (process.platform !== 'win32') {
        const target = path.join(root, 'target');
        const symbolic = path.join(root, 'symbolic');
        await fs.writeFile(target, canonical.subarray(0, 8), { mode: 0o600 });
        await fs.symlink(target, symbolic);
        assert.throws(() => captureCutoverJournalPreparing({
          file: symbolic,
          ...CUTOVER_LEGACY_MODE_BINDING,
          bridgeSha256: CUTOVER_BRIDGE_SHA,
          legacyMarkerSha256: CUTOVER_LEGACY_MARKER_SHA,
          legacyComposeSha256: CUTOVER_LEGACY_COMPOSE_SHA,
          bundleSha256: CUTOVER_BUNDLE_SHA,
          nonce: CUTOVER_NONCE,
        }), /regular no-follow/u);
        assert.equal((await fs.lstat(symbolic)).isSymbolicLink(), true);
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

test('cutover marker completes an exact prefix and rejects a destination swap before replacement',
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-cutover-marker-prefix-'));
    try {
      await fs.chmod(root, 0o700);
      const temporary = path.join(root, '.release-sha256.cutover.preparing');
      const destination = path.join(root, '.release-sha256');
      await fs.writeFile(temporary, CUTOVER_BRIDGE_SHA.slice(0, 17), { mode: 0o600 });
      await fs.writeFile(destination, `${CUTOVER_LEGACY_MARKER_SHA}\n`, { mode: 0o600 });
      await Promise.all([temporary, destination].map((file) => fs.chmod(file, 0o600)));
      const temporaryAuthority = captureCutoverMarkerPreparing({
        file: temporary, bridgeSha256: CUTOVER_BRIDGE_SHA,
      });
      const destinationAuthority = captureOptionalPrivateFile({
        file: destination, role: 'active release marker', expectedMode: 0o600,
        maximumBytes: 65,
      });
      assert.throws(() => publishCutoverActiveMarker({
        temporary,
        destination,
        bridgeSha256: CUTOVER_BRIDGE_SHA,
        legacyMarkerSha256: CUTOVER_LEGACY_MARKER_SHA,
        temporaryAuthority,
        destinationAuthority,
        beforeReplace() {
          fsSync.unlinkSync(destination);
          fsSync.writeFileSync(destination, `${'9'.repeat(64)}\n`, { mode: 0o600 });
          fsSync.chmodSync(destination, 0o600);
        },
      }), /presence, identity or bytes changed/u);
      assert.equal(await fs.readFile(destination, 'ascii'), `${'9'.repeat(64)}\n`);
      assert.equal(await fs.readFile(temporary, 'ascii'), `${CUTOVER_BRIDGE_SHA}\n`,
        'the isolated deterministic temporary may roll forward but must not be deleted');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

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
