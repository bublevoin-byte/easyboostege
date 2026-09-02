import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import {
  HELPER_BUNDLE_FILES,
  HELPER_GENERATION_FILES,
  STAGING_HELPER_PROTOCOL,
  STAGING_NODE_AUTHORITY_ENVIRONMENT,
  STAGING_NODE_AUTHORITY_PROTOCOL,
  STAGING_QUIESCENT_MAINTENANCE_DESCRIPTOR,
  STAGING_QUIESCENT_MAINTENANCE_ENVIRONMENT,
  STAGING_QUIESCENT_MAINTENANCE_LOCK_NAME,
  STAGING_QUIESCENT_MAINTENANCE_LOCK_PROTOCOL,
  STAGING_QUIESCENT_MAINTENANCE_PROTOCOL,
  captureHelperBundle,
  installStagingHelperBundle,
  stagingQuiescentMaintenanceEnvironmentValue,
  stagingQuiescentMaintenanceLockBytes,
  validateStagingRootLayout,
  verifyInstalledHelperGeneration,
} from '../scripts/staging-helper-bundle.js';

const gitBash = process.platform === 'win32' ? 'C:\\Program Files\\Git\\bin\\bash.exe' : 'bash';
const bootstrapScript = path.resolve('scripts/bootstrap-staging-release-host.sh');
const helperBundleScript = path.resolve('scripts/staging-helper-bundle.js');
const helperInstallerScript = path.resolve('scripts/install-staging-release-helpers.sh');

function posixPath(value) {
  return value.replace(/^([A-Za-z]):/u, (_, drive) => `/${drive.toLowerCase()}`).replaceAll('\\', '/');
}

async function renameAfterWindowsImageRelease(source, destination) {
  const deadline = Date.now() + 2_000;
  for (;;) {
    try {
      await fs.rename(source, destination);
      return;
    } catch (error) {
      if (process.platform !== 'win32' || error?.code !== 'EPERM' || Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

async function copyBundleSource(destination) {
  await fs.mkdir(destination, { recursive: true });
  await Promise.all(HELPER_BUNDLE_FILES.map((name) => (
    fs.copyFile(path.resolve('scripts', name), path.join(destination, name))
  )));
}

async function prepareCopiedNodeInstaller(root) {
  const nodeDirectory = path.join(root, 'node-authority');
  const nodeExecutable = path.join(nodeDirectory, process.platform === 'win32' ? 'node.exe' : 'node');
  const harness = path.join(root, 'install-helper-bundle.mjs');
  await fs.mkdir(nodeDirectory, { mode: 0o755 });
  await fs.chmod(nodeDirectory, 0o755);
  await fs.copyFile(process.execPath, nodeExecutable);
  await fs.chmod(nodeExecutable, 0o755);
  await fs.writeFile(harness, [
    `import { installStagingHelperBundle } from ${JSON.stringify(pathToFileURL(helperBundleScript).href)};`,
    'const [sourceDirectory, installRoot, linkRoot, allowedPrefix] = process.argv.slice(2);',
    'await installStagingHelperBundle({',
    '  sourceDirectory, installRoot, linkRoot, allowedPrefix,',
    '});',
    '',
  ].join('\n'));
  return { harness, nodeDirectory, nodeExecutable };
}

function runCopiedNodeInstaller(authority, sourceDirectory, installRoot, linkRoot, allowedPrefix) {
  return spawnSync(authority.nodeExecutable, [
    authority.harness, sourceDirectory, installRoot, linkRoot, allowedPrefix,
  ], { encoding: 'utf8' });
}

test('helper installer serializes root production and non-root hermetic installations', async () => {
  const installer = await fs.readFile(helperInstallerScript, 'utf8');
  assert.match(installer,
    /installer_uid="\$\(id -u\)"[\s\S]*if \[ "\$installer_uid" = 0 \]; then[\s\S]*installer_lock_root='\/run\/lock\/easyboost-staging-helper'[\s\S]*else[\s\S]*installer_lock_root="\/tmp\/easyboost-staging-helper-installer\.\$installer_uid"/u,
    'production root and unprivileged CI installs need separate owner-safe lock roots');
  assert.match(installer,
    /mkdir -m 700 -- "\$installer_lock_root"[\s\S]*stat -c '%F:%u:%g:%a'[\s\S]*directory:\$installer_uid:\$installer_gid:700/u);
  assert.match(installer,
    /exec 7<> "\$installer_lock_file"[\s\S]*installer_lock_opened=.*\/proc\/\$\$\/fd\/7[\s\S]*flock -n 7[\s\S]*node "\$source_dir\/staging-helper-bundle\.js" install/u,
    'the same identity-proved inode must remain locked across the complete installer mutation');
});

test('staging root policy rejects filesystem aliases, broad parents, escapes and overlaps', () => {
  const approvedPrefix = path.join(os.tmpdir(), 'easyboost-approved-root-policy');
  const validLayout = {
    allowedPrefix: approvedPrefix,
    appRoot: path.join(approvedPrefix, 'app'),
    installRoot: path.join(approvedPrefix, 'lib'),
    linkRoot: path.join(approvedPrefix, 'bin'),
  };
  assert.deepEqual(validateStagingRootLayout(validLayout), validLayout);

  const filesystemRootAlias = `${path.parse(os.tmpdir()).root}tmp${path.sep}..`;
  assert.throws(() => validateStagingRootLayout({
    ...validLayout,
    appRoot: filesystemRootAlias,
  }), /filesystem root|approved prefix/iu);
  assert.throws(() => validateStagingRootLayout({
    ...validLayout,
    appRoot: path.join(path.dirname(approvedPrefix), 'outside'),
  }), /approved prefix/iu);
  assert.throws(() => validateStagingRootLayout({
    ...validLayout,
    allowedPrefix: undefined,
  }), /explicit approved prefix/iu);
  assert.throws(() => validateStagingRootLayout({
    ...validLayout,
    installRoot: path.join(validLayout.appRoot, 'helpers'),
  }), /overlap/iu);
  assert.throws(() => validateStagingRootLayout({
    ...validLayout,
    linkRoot: validLayout.installRoot,
  }), /overlap/iu);
  if (process.platform !== 'win32') {
    assert.throws(() => validateStagingRootLayout({
      allowedPrefix: '/tmp',
      appRoot: '/tmp/easyboost-app',
      installRoot: '/tmp/easyboost-lib',
      linkRoot: '/tmp/easyboost-bin',
    }), /broad|reserved/iu);
    assert.throws(() => validateStagingRootLayout({
      ...validLayout,
      appRoot: '/tmp/..',
    }), /filesystem root/iu);
  }
});

test('root-layout CLI rejects unsafe paths before any installer mutation', () => {
  const approvedPrefix = path.join(os.tmpdir(), 'easyboost-root-cli-approved');
  const valid = [
    path.join(approvedPrefix, 'app'),
    path.join(approvedPrefix, 'lib'),
    path.join(approvedPrefix, 'bin'),
    approvedPrefix,
  ];
  const cases = [
    ['filesystem-root alias', [`${path.parse(os.tmpdir()).root}tmp${path.sep}..`, ...valid.slice(1)],
      /filesystem root/iu],
    ['prefix escape', [path.join(path.dirname(approvedPrefix), 'outside'), ...valid.slice(1)],
      /approved prefix/iu],
    ['overlap', [valid[0], path.join(valid[0], 'helpers'), valid[2], valid[3]], /overlap/iu],
  ];
  for (const [label, roots, errorPattern] of cases) {
    const invocation = spawnSync(process.execPath, [
      helperBundleScript, 'validate-root-layout', ...roots,
    ], { encoding: 'utf8' });
    assert.notEqual(invocation.status, 0, `${label}: ${invocation.stdout}\n${invocation.stderr}`);
    assert.match(invocation.stderr, errorPattern, label);
  }
});

test('bootstrap provisions only the canonical owner-writable shared host-operation parent',
  async () => {
    const [bootstrap, common] = await Promise.all([
      fs.readFile(bootstrapScript, 'utf8'),
      fs.readFile(path.resolve('scripts/staging-release-common.sh'), 'utf8'),
    ]);
    const canonicalLock = '/var/lib/easyboost/locks/host-operation.lock';
    assert.match(common, new RegExp(
      `EASYBOOST_HOST_OPERATION_LOCK_DIR:-${canonicalLock.replaceAll('/', '\\/')}`,
      'u',
    ));
    assert.match(bootstrap, new RegExp(
      `EASYBOOST_HOST_OPERATION_LOCK_DIR:-${canonicalLock.replaceAll('/', '\\/')}`,
      'u',
    ));
    assert.match(bootstrap,
      /host_operation_owner_uid="\$\{EASYBOOST_HOST_OPERATION_OWNER_UID:-0\}"/u);
    assert.match(bootstrap,
      /host_operation_owner_gid="\$\{EASYBOOST_HOST_OPERATION_OWNER_GID:-0\}"/u);
    assert.match(bootstrap,
      /host_operation_lock_directory" = \/var\/lib\/easyboost\/locks\/host-operation\.lock[\s\S]*!= 0:0/u,
      'the canonical lock parent must never be delegated to an ordinary deploy account');
    assert.match(bootstrap,
      /install -d -o "\$host_operation_owner_uid" -g "\$host_operation_owner_gid" -m 750 --\s+"\$host_operation_lock_parent"/u);
    assert.doesNotMatch(bootstrap,
      /install -d[^\n]*host_operation_lock_directory/u,
      'atomic lock authority itself must never exist before an operation acquires it');
  });

test('v4 helper installation atomically advances one digest pointer to exact current source bytes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-helper-bundle-'));
  const source = path.join(root, 'source');
  const installRoot = path.join(root, 'lib');
  const linkRoot = path.join(root, 'bin');
  try {
    await copyBundleSource(source);
    const firstSource = captureHelperBundle({ sourceDirectory: source });
    assert.equal(STAGING_HELPER_PROTOCOL, 'immutable-archive-v4');
    const first = await installStagingHelperBundle({
      sourceDirectory: source, installRoot, linkRoot, allowedPrefix: root,
    });
    assert.equal(first.bundleDigest, firstSource.bundleDigest);
    assert.equal(await fs.readFile(path.join(installRoot, 'current'), 'utf8'),
      `${first.bundleDigest}\n`);
    const nodeAuthorities = await fs.readdir(path.join(installRoot, 'node-authorities'));
    assert.equal(nodeAuthorities.length, 1);
    assert.match(nodeAuthorities[0], /^[a-f0-9]{64}$/u);
    const maintenanceLock = path.join(installRoot, STAGING_QUIESCENT_MAINTENANCE_LOCK_NAME);
    const expectedMaintenanceBytes = Buffer.from(`${JSON.stringify({
      installRoot,
      protocol: STAGING_QUIESCENT_MAINTENANCE_LOCK_PROTOCOL,
    })}\n`);
    assert.deepEqual(stagingQuiescentMaintenanceLockBytes(installRoot), expectedMaintenanceBytes);
    assert.deepEqual(await fs.readFile(maintenanceLock), expectedMaintenanceBytes);
    const maintenanceStat = await fs.lstat(maintenanceLock);
    assert.equal(maintenanceStat.isFile(), true);
    assert.equal(maintenanceStat.isSymbolicLink(), false);
    assert.equal(maintenanceStat.nlink, 1);
    if (process.platform !== 'win32') {
      assert.equal(maintenanceStat.mode & 0o777, 0o600);
      assert.equal(maintenanceStat.uid, process.getuid());
    }
    const firstGenerationDirectory = path.join(installRoot, 'generations', first.bundleDigest);
    assert.deepEqual((await fs.readdir(firstGenerationDirectory)).sort(),
      [...HELPER_GENERATION_FILES, 'staging-release-bundle.json'].sort(),
      'the host-specific private Node runtime must stay outside the historical v4 schema');
    const firstManifest = JSON.parse(await fs.readFile(
      path.join(firstGenerationDirectory, 'staging-release-bundle.json'), 'utf8',
    ));
    assert.equal(firstManifest.files.some((record) => record.name.includes('node-authorit')), false);
    await verifyInstalledHelperGeneration({
      generationDirectory: firstGenerationDirectory,
      expectedDigest: first.bundleDigest,
    });
    assert.ok(HELPER_BUNDLE_FILES.includes('staging-restart-app.sh'),
      'the root-owned restart implementation must be digest-bound with deploy/rollback');
    assert.ok(HELPER_BUNDLE_FILES.includes('staging-quiescent-maintenance.js'),
      'the fd8 consumer and maintenance root authority must be digest-bound with the transaction');
    const restartDispatcher = path.join(linkRoot, 'easyboost-staging-restart');
    assert.match(await fs.readFile(restartDispatcher, 'utf8'),
      /staging-release-entry\.sh' restart "\$@"/u);
    const invalidRestart = spawnSync(gitBash, [posixPath(restartDispatcher)], {
      encoding: 'utf8',
    });
    if (invalidRestart.error?.code !== 'ENOENT') {
      assert.equal(invalidRestart.status, 64,
        invalidRestart.stdout + '\n' + invalidRestart.stderr);
    }
    const recoveryDispatcher = path.join(linkRoot, 'easyboost-staging-recover');
    assert.match(await fs.readFile(recoveryDispatcher, 'utf8'),
      /staging-release-entry\.sh' recover "\$@"/u);
    const invalidRecovery = spawnSync(gitBash, [posixPath(recoveryDispatcher)], {
      encoding: 'utf8',
    });
    if (invalidRecovery.error?.code !== 'ENOENT') {
      assert.equal(invalidRecovery.status, 64,
        invalidRecovery.stdout + '\n' + invalidRecovery.stderr);
    }

    await fs.appendFile(path.join(source, 'staging-release-common.sh'),
      '\n# audited same-v4 source advancement\n');
    const secondSource = captureHelperBundle({ sourceDirectory: source });
    assert.notEqual(secondSource.bundleDigest, first.bundleDigest);
    const second = await installStagingHelperBundle({
      sourceDirectory: source, installRoot, linkRoot, allowedPrefix: root,
    });
    assert.equal(second.bundleDigest, secondSource.bundleDigest);
    assert.equal(await fs.readFile(path.join(installRoot, 'current'), 'utf8'),
      `${second.bundleDigest}\n`);
    await verifyInstalledHelperGeneration({
      generationDirectory: path.join(installRoot, 'generations', second.bundleDigest),
      expectedDigest: second.bundleDigest,
    });
    await verifyInstalledHelperGeneration({
      generationDirectory: path.join(installRoot, 'generations', first.bundleDigest),
      expectedDigest: first.bundleDigest,
    });

    const staleInvocation = spawnSync(gitBash, [
      posixPath(path.join(linkRoot, 'easyboost-staging-deploy')),
      '/missing-release.tar.gz', 'a'.repeat(64), STAGING_HELPER_PROTOCOL, first.bundleDigest,
    ], { encoding: 'utf8' });
    if (staleInvocation.error?.code !== 'ENOENT') {
      assert.equal(staleInvocation.status, 69,
        `${staleInvocation.stdout}\n${staleInvocation.stderr}`);
      assert.match(staleInvocation.stderr, /bundle.*(?:digest|requested)/iu);
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('maintenance lock is create-once canonical state and is never replaced on retry', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-helper-maintenance-lock-'));
  const source = path.join(root, 'source');
  const installRoot = path.join(root, 'lib');
  const linkRoot = path.join(root, 'bin');
  try {
    await copyBundleSource(source);
    await installStagingHelperBundle({
      sourceDirectory: source, installRoot, linkRoot, allowedPrefix: root,
    });
    const lock = path.join(installRoot, STAGING_QUIESCENT_MAINTENANCE_LOCK_NAME);
    const before = await fs.lstat(lock, { bigint: true });
    await installStagingHelperBundle({
      sourceDirectory: source, installRoot, linkRoot, allowedPrefix: root,
    });
    const after = await fs.lstat(lock, { bigint: true });
    assert.equal(`${after.dev}:${after.ino}`, `${before.dev}:${before.ino}`,
      'idempotent installation must exact-verify rather than replace the stable lock inode');

    await fs.writeFile(lock, 'non-canonical-maintenance-lock');
    await assert.rejects(installStagingHelperBundle({
      sourceDirectory: source, installRoot, linkRoot, allowedPrefix: root,
    }), /maintenance lock bytes are not canonical/u);
    const rejected = await fs.lstat(lock, { bigint: true });
    assert.equal(`${rejected.dev}:${rejected.ino}`, `${before.dev}:${before.ino}`,
      'an invalid existing maintenance lock must never be replaced');
    assert.equal(await fs.readFile(lock, 'utf8'), 'non-canonical-maintenance-lock');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('v4 helper installation durably publishes one complete generation before current', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-helper-durable-order-'));
  const source = path.join(root, 'source');
  const installRoot = path.join(root, 'lib');
  const linkRoot = path.join(root, 'bin');
  const events = [];
  const relative = (value) => path.relative(root, value).replaceAll('\\', '/');
  const operations = {
    chmod: fs.chmod.bind(fs),
    mkdir: async (directory, options) => {
      events.push({ directory: relative(directory), kind: 'mkdir' });
      return fs.mkdir(directory, options);
    },
    rename: async (from, to) => {
      events.push({ from: relative(from), kind: 'rename', to: relative(to) });
      return fs.rename(from, to);
    },
    rm: fs.rm.bind(fs),
    syncDirectory: async (directory) => {
      events.push({ directory: relative(directory), kind: 'sync-directory' });
    },
    syncFile: async (file) => {
      events.push({ file: relative(file), kind: 'sync-file' });
    },
    writeFile: fs.writeFile.bind(fs),
  };
  try {
    await copyBundleSource(source);
    const captured = captureHelperBundle({ sourceDirectory: source });
    await installStagingHelperBundle({
      sourceDirectory: source, installRoot, linkRoot, allowedPrefix: root, operations,
    });

    const generationDestination = relative(path.join(
      installRoot, 'generations', captured.bundleDigest,
    ));
    const generationRenameIndex = events.findIndex((event) => (
      event.kind === 'rename' && event.to === generationDestination
    ));
    assert.notEqual(generationRenameIndex, -1, 'the immutable generation must be published');
    const nodeAuthorityAllocationIndex = events.findIndex((event) => event.kind === 'mkdir'
      && /^lib\/node-authorities\/[a-f0-9]{64}$/u.test(event.directory));
    assert.ok(nodeAuthorityAllocationIndex >= 0 && nodeAuthorityAllocationIndex < generationRenameIndex,
      'the private content-addressed Node runtime must reserve without replacement before helpers');
    assert.equal(events.some((event) => event.kind === 'rename'
      && /^lib\/node-authorities\/[a-f0-9]{64}$/u.test(event.to)), false,
    'a private Node authority must never replace an existing content-addressed path');
    assert.ok(events.slice(nodeAuthorityAllocationIndex + 1, generationRenameIndex).some((event) => (
      event.kind === 'sync-directory' && event.directory === 'lib/node-authorities'
    )), 'the private Node authority parent must be durable before helper publication continues');
    const stagingDirectory = events[generationRenameIndex].from;
    const stagingFileSyncs = events.slice(0, generationRenameIndex).filter((event) => (
      event.kind === 'sync-file' && path.posix.dirname(event.file) === stagingDirectory
    ));
    assert.equal(stagingFileSyncs.length, HELPER_GENERATION_FILES.length + 1,
      'every helper and the manifest must be durable before generation publication');
    assert.ok(events.slice(0, generationRenameIndex).some((event) => (
      event.kind === 'sync-directory' && event.directory === stagingDirectory
    )), 'the complete staging directory must be durable before generation publication');
    const generationsSyncIndex = events.findIndex((event, index) => (
      index > generationRenameIndex && event.kind === 'sync-directory'
        && event.directory === relative(path.join(installRoot, 'generations'))
    ));
    assert.notEqual(generationsSyncIndex, -1,
      'the generations parent must be durable after generation publication');

    const destinations = [
      path.join(installRoot, 'staging-release-entry.sh'),
      path.join(linkRoot, 'easyboost-staging-deploy'),
      path.join(linkRoot, 'easyboost-staging-rollback'),
      path.join(linkRoot, 'easyboost-staging-restart'),
      path.join(linkRoot, 'easyboost-staging-recover'),
      path.join(installRoot, 'current'),
    ].map(relative);
    const publicationIndexes = destinations.map((destination) => events.findIndex((event) => (
      event.kind === 'rename' && event.to === destination
    )));
    assert.ok(publicationIndexes.every((index) => index > generationsSyncIndex),
      'entrypoints must not publish before the immutable generation is durable');
    for (const [destinationIndex, publicationIndex] of publicationIndexes.entries()) {
      const publication = events[publicationIndex];
      assert.ok(events.slice(0, publicationIndex).some((event) => (
        event.kind === 'sync-file' && event.file === publication.from
      )), `${destinations[destinationIndex]} must sync its private file before rename`);
      assert.ok(events.slice(publicationIndex + 1).some((event) => (
        event.kind === 'sync-directory'
          && event.directory === path.posix.dirname(destinations[destinationIndex])
      )), `${destinations[destinationIndex]} must sync its parent after rename`);
    }
    assert.equal(publicationIndexes.at(-1), Math.max(...publicationIndexes),
      'current must be the final published install artifact');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('custom helper roots durably publish every newly created ancestor before its child', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-helper-recursive-root-'));
  const source = path.join(root, 'source');
  const installRoot = path.join(root, 'install-parent', 'nested', 'lib');
  const linkRoot = path.join(root, 'link-parent', 'nested', 'bin');
  const events = [];
  const relative = (value) => path.relative(root, value).replaceAll('\\', '/') || '.';
  try {
    await copyBundleSource(source);
    await installStagingHelperBundle({
      sourceDirectory: source,
      installRoot,
      linkRoot,
      allowedPrefix: root,
      operations: {
        mkdir: async (directory, options) => {
          events.push({ directory: relative(directory), kind: 'mkdir', options });
          return fs.mkdir(directory, options);
        },
        syncDirectory: async (directory) => {
          events.push({ directory: relative(directory), kind: 'sync-directory' });
        },
      },
    });
    for (const chain of [
      ['install-parent', 'install-parent/nested', 'install-parent/nested/lib',
        'install-parent/nested/lib/generations'],
      ['link-parent', 'link-parent/nested', 'link-parent/nested/bin'],
    ]) {
      for (const [index, directory] of chain.entries()) {
        const creationIndex = events.findIndex((event) => (
          event.kind === 'mkdir' && event.directory === directory
        ));
        assert.notEqual(creationIndex, -1, `${directory} must be created as one exact directory`);
        assert.notEqual(events[creationIndex].options?.recursive, true,
          `${directory} must not be hidden inside recursive mkdir`);
        const parentSyncIndex = events.findIndex((event, eventIndex) => (
          eventIndex > creationIndex && event.kind === 'sync-directory'
            && event.directory === path.posix.dirname(directory)
        ));
        assert.notEqual(parentSyncIndex, -1,
          `${directory} must be durable in its own parent`);
        if (index + 1 < chain.length) {
          const childCreationIndex = events.findIndex((event) => (
            event.kind === 'mkdir' && event.directory === chain[index + 1]
          ));
          assert.ok(parentSyncIndex < childCreationIndex,
            `${directory} must be durable before ${chain[index + 1]} is created`);
        }
      }
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('unrelated metadata drift on a shared ancestor does not impersonate directory replacement',
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-helper-ancestor-drift-'));
    const source = path.join(root, 'source');
    const installRoot = path.join(root, 'install-parent', 'nested', 'lib');
    const linkRoot = path.join(root, 'link-parent', 'nested', 'bin');
    let drifted = false;
    try {
      await copyBundleSource(source);
      const installed = await installStagingHelperBundle({
        sourceDirectory: source,
        installRoot,
        linkRoot,
        allowedPrefix: root,
        operations: {
          syncDirectory: async (directory) => {
            if (drifted || directory !== root) return;
            await fs.utimes(root, new Date(10_000), new Date(20_000));
            drifted = true;
          },
        },
      });
      assert.equal(drifted, true, 'the regression must change only shared-ancestor metadata');
      await verifyInstalledHelperGeneration({
        generationDirectory: path.join(installRoot, 'generations', installed.bundleDigest),
        expectedDigest: installed.bundleDigest,
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

test('default directory fsync accepts benign metadata drift on the same open directory object',
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-helper-default-sync-drift-'));
    const source = path.join(root, 'source');
    const installRoot = path.join(root, 'install-parent', 'nested', 'lib');
    const linkRoot = path.join(root, 'link-parent', 'nested', 'bin');
    let drifted = false;
    try {
      await copyBundleSource(source);
      const installed = await installStagingHelperBundle({
        sourceDirectory: source,
        installRoot,
        linkRoot,
        allowedPrefix: root,
        operations: {
          directorySyncSupported: true,
          open: async (target, flags) => {
            const descriptor = await fs.open(target, flags);
            if (typeof flags !== 'number') return descriptor;
            return {
              chmod: descriptor.chmod.bind(descriptor),
              close: descriptor.close.bind(descriptor),
              stat: descriptor.stat.bind(descriptor),
              sync: async () => {
                if (!drifted && target === root) {
                  await fs.utimes(root, new Date(30_000), new Date(40_000));
                  drifted = true;
                }
              },
              writeFile: descriptor.writeFile.bind(descriptor),
            };
          },
        },
      });
      assert.equal(drifted, true, 'the default descriptor-sync branch must observe metadata drift');
      await verifyInstalledHelperGeneration({
        generationDirectory: path.join(installRoot, 'generations', installed.bundleDigest),
        expectedDigest: installed.bundleDigest,
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

test('default directory fsync rejects a path replacement after syncing the opened object', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-helper-default-sync-replace-'));
  const source = path.join(root, 'source');
  const installRoot = path.join(root, 'install-parent', 'nested', 'lib');
  const replacedRoot = `${installRoot}.replaced`;
  const linkRoot = path.join(root, 'link-parent', 'nested', 'bin');
  let replaced = false;
  try {
    await copyBundleSource(source);
    await assert.rejects(installStagingHelperBundle({
      sourceDirectory: source,
      installRoot,
      linkRoot,
      allowedPrefix: root,
      operations: {
        directorySyncSupported: true,
        open: async (target, flags) => {
          const descriptor = await fs.open(target, flags);
          if (typeof flags !== 'number') return descriptor;
          return {
            chmod: descriptor.chmod.bind(descriptor),
            close: descriptor.close.bind(descriptor),
            stat: descriptor.stat.bind(descriptor),
            sync: async () => {
              if (!replaced && target === installRoot) {
                await fs.rename(installRoot, replacedRoot);
                await fs.mkdir(installRoot, { mode: 0o755 });
                replaced = true;
                }
              },
            writeFile: descriptor.writeFile.bind(descriptor),
          };
        },
      },
    }), /helper directory changed during sync/u);
    assert.equal(replaced, true, 'the regression must replace the exact synced path');
    await assert.rejects(fs.access(path.join(installRoot, 'generations')), { code: 'ENOENT' });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('custom helper roots explicitly establish and durably sync 0755 after restrictive umask creation',
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-helper-umask-model-'));
    const source = path.join(root, 'source');
    const installRoot = path.join(root, 'install-parent', 'nested', 'lib');
    const linkRoot = path.join(root, 'link-parent', 'nested', 'bin');
    const events = [];
    const createdModes = new Map();
    try {
      await copyBundleSource(source);
      await installStagingHelperBundle({
        sourceDirectory: source,
        installRoot,
        linkRoot,
        allowedPrefix: root,
        operations: {
          chmod: async (target, mode) => {
            if (createdModes.has(target)) createdModes.set(target, mode);
            events.push({ kind: 'chmod', mode, target });
            await fs.chmod(target, mode);
          },
          mkdir: async (directory, options) => {
            await fs.mkdir(directory, { ...options, mode: 0o700 });
            await fs.chmod(directory, 0o700);
            createdModes.set(directory, 0o700);
            events.push({ kind: 'mkdir', target: directory });
          },
          syncDirectory: async (directory) => {
            events.push({ kind: 'sync-directory', target: directory });
          },
        },
      });
      const nodeAuthorityRoot = path.join(installRoot, 'node-authorities');
      const privateRuntimeDirectory = [...createdModes.keys()].find((directory) => (
        path.dirname(directory) === nodeAuthorityRoot
      ));
      assert.ok(privateRuntimeDirectory);
      const expectedDirectoryModes = new Map([
        [path.join(root, 'install-parent'), 0o755],
        [path.join(root, 'install-parent', 'nested'), 0o755],
        [installRoot, 0o755],
        [nodeAuthorityRoot, 0o755],
        [privateRuntimeDirectory, 0o555],
        [path.join(installRoot, 'generations'), 0o755],
        [path.join(root, 'link-parent'), 0o755],
        [path.join(root, 'link-parent', 'nested'), 0o755],
        [linkRoot, 0o755],
      ]);
      assert.deepEqual([...createdModes.keys()].sort(), [...expectedDirectoryModes.keys()].sort());
      for (const [directory, expectedMode] of expectedDirectoryModes) {
        assert.equal(createdModes.get(directory), expectedMode,
          `${directory} must override the restrictive creation mode`);
        const chmodIndex = events.findIndex((event) => (
          event.kind === 'chmod' && event.target === directory && event.mode === expectedMode
        ));
        const directorySyncIndex = events.findIndex((event, index) => (
          index > chmodIndex && event.kind === 'sync-directory' && event.target === directory
        ));
        const parentSyncIndex = events.findIndex((event, index) => (
          index > directorySyncIndex && event.kind === 'sync-directory'
            && event.target === path.dirname(directory)
        ));
        assert.ok(chmodIndex >= 0 && directorySyncIndex > chmodIndex
          && parentSyncIndex > directorySyncIndex,
        `${directory} mode must be durable before its parent entry is published`);
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

test('fresh helper installation succeeds in a real child process with umask 077', async (context) => {
  if (process.platform === 'win32') {
    return context.skip('POSIX umask and directory durability execute on the production host');
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-helper-real-umask-'));
  const source = path.join(root, 'source');
  const installRoot = path.join(root, 'install-parent', 'nested', 'lib');
  const linkRoot = path.join(root, 'link-parent', 'nested', 'bin');
  try {
    await copyBundleSource(source);
    const childSource = [
      `import { installStagingHelperBundle } from ${JSON.stringify(pathToFileURL(helperBundleScript).href)};`,
      'process.umask(0o077);',
      'await installStagingHelperBundle({',
      `  sourceDirectory: ${JSON.stringify(source)},`,
      `  installRoot: ${JSON.stringify(installRoot)},`,
      `  linkRoot: ${JSON.stringify(linkRoot)},`,
      `  allowedPrefix: ${JSON.stringify(root)},`,
      '});',
    ].join('\n');
    const child = spawnSync(process.execPath, ['--input-type=module', '--eval', childSource], {
      encoding: 'utf8',
    });
    assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`);
    for (const directory of [
      path.join(root, 'install-parent'),
      path.join(root, 'install-parent', 'nested'),
      installRoot,
      path.join(installRoot, 'generations'),
      path.join(root, 'link-parent'),
      path.join(root, 'link-parent', 'nested'),
      linkRoot,
    ]) {
      assert.equal((await fs.lstat(directory)).mode & 0o777, 0o755, directory);
    }
    const nodeAuthorityRoot = path.join(installRoot, 'node-authorities');
    assert.equal((await fs.lstat(nodeAuthorityRoot)).mode & 0o777, 0o755);
    const [nodeDigest] = await fs.readdir(nodeAuthorityRoot);
    const privateRuntimeDirectory = path.join(nodeAuthorityRoot, nodeDigest);
    assert.equal((await fs.lstat(privateRuntimeDirectory)).mode & 0o777, 0o555);
    assert.equal((await fs.lstat(path.join(privateRuntimeDirectory, 'node'))).mode & 0o777, 0o555);
    const digest = (await fs.readFile(path.join(installRoot, 'current'), 'utf8')).trim();
    await verifyInstalledHelperGeneration({
      generationDirectory: path.join(installRoot, 'generations', digest),
      expectedDigest: digest,
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('custom helper root publication rejects directory identity replacement during parent sync', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-helper-root-identity-'));
  const source = path.join(root, 'source');
  const installRoot = path.join(root, 'install-parent', 'nested', 'lib');
  const replacedRoot = `${installRoot}.replaced`;
  const linkRoot = path.join(root, 'link-parent', 'nested', 'bin');
  let swapped = false;
  try {
    await copyBundleSource(source);
    await assert.rejects(installStagingHelperBundle({
      sourceDirectory: source,
      installRoot,
      linkRoot,
      allowedPrefix: root,
      operations: {
        syncDirectory: async (directory) => {
          if (swapped || directory !== path.dirname(installRoot)) return;
          const installRootExists = await fs.lstat(installRoot).then(() => true, (error) => {
            if (error?.code === 'ENOENT') return false;
            throw error;
          });
          if (!installRootExists) return;
          await fs.rename(installRoot, replacedRoot);
          await fs.mkdir(installRoot, { mode: 0o755 });
          swapped = true;
        },
      },
    }), /helper directory identity changed|changed during durable publication/iu);
    assert.equal(swapped, true, 'the regression must replace the just-created directory during sync');
    await assert.rejects(fs.access(path.join(installRoot, 'generations')), { code: 'ENOENT' },
      'installation must stop before publishing descendants under a replaced directory');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('recover verifies and executes an explicit historical generation after current advances',
  async (context) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-helper-historical-recovery-'));
    const source = path.join(root, 'source');
    const installRoot = path.join(root, 'lib');
    const linkRoot = path.join(root, 'bin');
    const marker = path.join(root, 'recovery-marker.json');
    const supervisorBytes = (generation) => Buffer.from([
      "import fsSync from 'node:fs';",
      `fsSync.writeFileSync(process.env.EASYBOOST_TEST_RECOVERY_MARKER, JSON.stringify({ generation: ${JSON.stringify(generation)}, values: process.argv.slice(2) }));`,
      '',
    ].join('\n'));
    try {
      await copyBundleSource(source);
      await fs.writeFile(path.join(source, 'staging-transaction-supervisor.js'),
        supervisorBytes('A'));
      const generationA = await installStagingHelperBundle({
        sourceDirectory: source, installRoot, linkRoot, allowedPrefix: root,
      });
      await fs.writeFile(path.join(source, 'staging-transaction-supervisor.js'),
        supervisorBytes('B'));
      const generationB = await installStagingHelperBundle({
        sourceDirectory: source, installRoot, linkRoot, allowedPrefix: root,
      });
      assert.notEqual(generationA.bundleDigest, generationB.bundleDigest);
      assert.equal(await fs.readFile(path.join(installRoot, 'current'), 'utf8'),
        `${generationB.bundleDigest}\n`);

      for (const [role, values] of [
        ['deploy', [
          '/missing-release.tar.gz', 'a'.repeat(64), STAGING_HELPER_PROTOCOL,
          generationA.bundleDigest,
        ]],
        ['rollback', ['a'.repeat(64), STAGING_HELPER_PROTOCOL, generationA.bundleDigest]],
        ['restart', [generationA.bundleDigest]],
      ]) {
        const staleInvocation = spawnSync(gitBash, [
          posixPath(path.join(linkRoot, `easyboost-staging-${role}`)), ...values,
        ], { encoding: 'utf8' });
        if (staleInvocation.error?.code === 'ENOENT') {
          return context.skip('Git Bash is not installed');
        }
        assert.equal(staleInvocation.status, 69,
          `${role}: ${staleInvocation.stdout}\n${staleInvocation.stderr}`);
      }

      const recovery = spawnSync(gitBash, [
        posixPath(path.join(linkRoot, 'easyboost-staging-recover')),
        'deploy', '/missing-release.tar.gz', 'a'.repeat(64), STAGING_HELPER_PROTOCOL,
        generationA.bundleDigest,
      ], {
        encoding: 'utf8',
        env: { ...process.env, EASYBOOST_TEST_RECOVERY_MARKER: marker },
      });
      assert.equal(recovery.status, 0, `${recovery.stdout}\n${recovery.stderr}`);
      const recoveryRecord = JSON.parse(await fs.readFile(marker, 'utf8'));
      assert.equal(recoveryRecord.generation, 'A');
      assert.equal(recoveryRecord.values[0], '--recover');
      assert.equal(path.resolve(recoveryRecord.values[1]), path.join(
        installRoot, 'generations', generationA.bundleDigest, 'staging-deploy.sh',
      ));
      assert.equal(path.basename(recoveryRecord.values[2]), 'missing-release.tar.gz');
      assert.deepEqual(recoveryRecord.values.slice(3), [
        'a'.repeat(64), STAGING_HELPER_PROTOCOL, generationA.bundleDigest,
      ]);

      await fs.rm(marker);
      const recoveryAuthority = JSON.stringify({
        deadlineControlDirectory: '/tmp/easyboost-staging-deadline-controls/fixture',
        deadlinePublicationAuthority: {
          destination: '/tmp/easyboost-staging-deadline-controls/fixture/control.json',
          temporary: '/tmp/easyboost-staging-deadline-controls/.fixture.control.json.11111111111111111111111111111111.tmp',
        },
        posixSessionControlDirectory: null,
        protocol: 'easyboost-staging-transaction-recovery-v1',
      });
      const typedRecovery = spawnSync(gitBash, [
        posixPath(path.join(linkRoot, 'easyboost-staging-recover')),
        'deploy', '/missing-release.tar.gz', 'a'.repeat(64), STAGING_HELPER_PROTOCOL,
        generationA.bundleDigest, '--recovery-authority', recoveryAuthority,
      ], {
        encoding: 'utf8',
        env: { ...process.env, EASYBOOST_TEST_RECOVERY_MARKER: marker },
      });
      assert.equal(typedRecovery.status, 0,
        `${typedRecovery.stdout}\n${typedRecovery.stderr}`);
      const typedRecord = JSON.parse(await fs.readFile(marker, 'utf8'));
      assert.deepEqual(typedRecord.values.slice(0, 3), [
        '--recover-with-authority', recoveryAuthority, '--',
      ]);
      assert.equal(path.resolve(typedRecord.values[3]), path.join(
        installRoot, 'generations', generationA.bundleDigest, 'staging-deploy.sh',
      ));
      assert.equal(path.basename(typedRecord.values[4]), 'missing-release.tar.gz');
      assert.deepEqual(typedRecord.values.slice(5), [
        'a'.repeat(64), STAGING_HELPER_PROTOCOL, generationA.bundleDigest,
      ]);

      await fs.rm(marker);
      const historicalCommon = path.join(installRoot, 'generations', generationA.bundleDigest,
        'staging-release-common.sh');
      await fs.chmod(historicalCommon, 0o755);
      await fs.appendFile(historicalCommon, '\n# tampered historical generation\n');
      const tamperedRecovery = spawnSync(gitBash, [
        posixPath(path.join(linkRoot, 'easyboost-staging-recover')),
        'deploy', '/missing-release.tar.gz', 'a'.repeat(64), STAGING_HELPER_PROTOCOL,
        generationA.bundleDigest,
      ], {
        encoding: 'utf8',
        env: { ...process.env, EASYBOOST_TEST_RECOVERY_MARKER: marker },
      });
      assert.notEqual(tamperedRecovery.status, 0,
        `${tamperedRecovery.stdout}\n${tamperedRecovery.stderr}`);
      await assert.rejects(fs.access(marker), { code: 'ENOENT' },
        'a changed historical generation must never execute');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

test('explicit historical recovery ignores missing malformed or unrelated current pointers',
  async (context) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-helper-pointerless-recovery-'));
    const source = path.join(root, 'source');
    const installRoot = path.join(root, 'lib');
    const linkRoot = path.join(root, 'bin');
    const marker = path.join(root, 'historical-recovery-marker');
    const current = path.join(installRoot, 'current');
    try {
      await copyBundleSource(source);
      await fs.writeFile(path.join(source, 'staging-transaction-supervisor.js'), [
        "import fsSync from 'node:fs';",
        "fsSync.writeFileSync(process.env.EASYBOOST_TEST_POINTERLESS_RECOVERY_MARKER, 'A');",
        '',
      ].join('\n'));
      const generationA = await installStagingHelperBundle({
        sourceDirectory: source, installRoot, linkRoot, allowedPrefix: root,
      });
      await fs.appendFile(path.join(source, 'staging-release-common.sh'), '\n# generation B\n');
      await installStagingHelperBundle({
        sourceDirectory: source, installRoot, linkRoot, allowedPrefix: root,
      });

      const states = [
        ['missing', null],
        ['malformed', 'not-a-generation\n'],
        ['unrelated-valid-digest', `${'f'.repeat(64)}\n`],
      ];
      for (const [label, pointerBytes] of states) {
        await fs.rm(current, { force: true });
        if (pointerBytes !== null) {
          await fs.writeFile(current, pointerBytes, { mode: 0o444 });
          await fs.chmod(current, 0o444);
        }
        await fs.rm(marker, { force: true });
        const environment = {
          ...process.env,
          EASYBOOST_TEST_POINTERLESS_RECOVERY_MARKER: marker,
        };
        const normal = spawnSync(gitBash, [
          posixPath(path.join(linkRoot, 'easyboost-staging-restart')), generationA.bundleDigest,
        ], { encoding: 'utf8', env: environment });
        if (normal.error?.code === 'ENOENT') return context.skip('Git Bash is not installed');
        assert.notEqual(normal.status, 0, `${label}: normal role must reject the pointer`);
        await assert.rejects(fs.access(marker), { code: 'ENOENT' }, label);

        const recovery = spawnSync(gitBash, [
          posixPath(path.join(linkRoot, 'easyboost-staging-recover')),
          'restart', generationA.bundleDigest,
        ], { encoding: 'utf8', env: environment });
        assert.equal(recovery.status, 0, `${label}: ${recovery.stdout}\n${recovery.stderr}`);
        assert.equal(await fs.readFile(marker, 'utf8'), 'A', label);
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

test('launcher verifies target bytes without executing untrusted generation code and keeps historical recovery',
  async (context) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-helper-independent-verifier-'));
    const source = path.join(root, 'source');
    const installRoot = path.join(root, 'lib');
    const linkRoot = path.join(root, 'bin');
    const untrustedMarker = path.join(root, 'untrusted-generation-executed');
    const recoveryMarker = path.join(root, 'historical-recovery-executed');
    const markerProgram = (environmentName) => Buffer.from([
      "import fsSync from 'node:fs';",
      `fsSync.writeFileSync(process.env.${environmentName}, 'executed');`,
      '',
    ].join('\n'));
    try {
      await copyBundleSource(source);
      await fs.writeFile(path.join(source, 'staging-transaction-supervisor.js'),
        markerProgram('EASYBOOST_TEST_HISTORICAL_RECOVERY_MARKER'));
      const generationA = await installStagingHelperBundle({
        sourceDirectory: source, installRoot, linkRoot, allowedPrefix: root,
      });
      await fs.appendFile(path.join(source, 'staging-release-common.sh'),
        '\n# generation B with a distinct trusted source digest\n');
      const generationB = await installStagingHelperBundle({
        sourceDirectory: source, installRoot, linkRoot, allowedPrefix: root,
      });
      const environment = {
        ...process.env,
        EASYBOOST_TEST_HISTORICAL_RECOVERY_MARKER: recoveryMarker,
        EASYBOOST_TEST_UNTRUSTED_GENERATION_MARKER: untrustedMarker,
      };
      const validCurrent = spawnSync(gitBash, [
        posixPath(path.join(linkRoot, 'easyboost-staging-restart')), generationB.bundleDigest,
      ], { encoding: 'utf8', env: environment });
      if (validCurrent.error?.code === 'ENOENT') return context.skip('Git Bash is not installed');
      assert.equal(validCurrent.status, 0, `${validCurrent.stdout}\n${validCurrent.stderr}`);
      assert.equal(await fs.readFile(recoveryMarker, 'utf8'), 'executed');
      await fs.rm(recoveryMarker);

      const generationBRoot = path.join(installRoot, 'generations', generationB.bundleDigest);
      await fs.chmod(generationBRoot, 0o755);
      for (const name of ['staging-helper-bundle.js', 'staging-transaction-supervisor.js']) {
        const target = path.join(generationBRoot, name);
        await fs.chmod(target, 0o755);
        await fs.writeFile(target, markerProgram('EASYBOOST_TEST_UNTRUSTED_GENERATION_MARKER'));
        await fs.chmod(target, 0o555);
      }
      await fs.chmod(generationBRoot, 0o555);

      const currentInvocation = spawnSync(gitBash, [
        posixPath(path.join(linkRoot, 'easyboost-staging-restart')), generationB.bundleDigest,
      ], { encoding: 'utf8', env: environment });
      assert.notEqual(currentInvocation.status, 0,
        `${currentInvocation.stdout}\n${currentInvocation.stderr}`);
      await assert.rejects(fs.access(untrustedMarker), { code: 'ENOENT' },
        'the current generation must not execute before independent whole-generation verification');

      const recovery = spawnSync(gitBash, [
        posixPath(path.join(linkRoot, 'easyboost-staging-recover')),
        'restart', generationA.bundleDigest,
      ], { encoding: 'utf8', env: environment });
      assert.equal(recovery.status, 0, `${recovery.stdout}\n${recovery.stderr}`);
      await assert.rejects(fs.access(untrustedMarker), { code: 'ENOENT' },
        'historical recovery must not import or execute the untrusted current generation');
      assert.equal(await fs.readFile(recoveryMarker, 'utf8'), 'executed');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

test('privileged entrypoints ignore BASH_ENV hostile PATH and Node preload injection',
  async (context) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-helper-hostile-environment-'));
    const source = path.join(root, 'source');
    const installRoot = path.join(root, 'lib');
    const linkRoot = path.join(root, 'bin');
    const hostileBin = path.join(root, 'hostile-bin');
    const bashEnv = path.join(root, 'bash-env.sh');
    const preload = path.join(root, 'preload.cjs');
    const bashMarker = path.join(root, 'bash-env-executed');
    const pathMarker = path.join(root, 'hostile-path-executed');
    const preloadMarker = path.join(root, 'node-preload-executed');
    const targetMarker = path.join(root, 'authenticated-target-executed');
    try {
      await copyBundleSource(source);
      await fs.mkdir(hostileBin);
      await fs.writeFile(bashEnv,
        'printf bash-env > "$EASYBOOST_TEST_BASH_ENV_MARKER"\n');
      await fs.writeFile(preload, [
        "require('node:fs').writeFileSync(",
        "  process.env.EASYBOOST_TEST_NODE_PRELOAD_MARKER, 'preload',",
        ');',
        '',
      ].join('\n'));
      const hostileCommand = [
        '#!/bin/bash',
        'printf hostile-path > "$EASYBOOST_TEST_HOSTILE_PATH_MARKER"',
        'exit 97',
        '',
      ].join('\n');
      for (const name of ['env', 'id', 'node', 'stat']) {
        const command = path.join(hostileBin, name);
        await fs.writeFile(command, hostileCommand);
        await fs.chmod(command, 0o755);
      }
      await fs.writeFile(path.join(source, 'staging-transaction-supervisor.js'), [
        "import fsSync from 'node:fs';",
        "if (process.env.NODE_OPTIONS || process.env.NODE_PATH || process.env.EASYBOOST_LEGACY_GENERATION_ROOT) {",
        "  throw new Error('current generation inherited an unapproved Node environment');",
        '}',
        "fsSync.writeFileSync(process.env.EASYBOOST_TEST_AUTHENTICATED_TARGET_MARKER, 'target');",
        '',
      ].join('\n'));
      const installed = await installStagingHelperBundle({
        sourceDirectory: source, installRoot, linkRoot, allowedPrefix: root,
      });
      const launcher = path.join(installRoot, 'staging-release-entry.sh');
      const dispatcher = path.join(linkRoot, 'easyboost-staging-restart');
      assert.match(await fs.readFile(launcher, 'utf8'), /^#!\/bin\/bash -p$/mu);
      assert.match(await fs.readFile(dispatcher, 'utf8'), /^#!\/bin\/bash -p$/mu);

      const environment = {
        ...process.env,
        BASH_ENV: posixPath(bashEnv),
        EASYBOOST_TEST_AUTHENTICATED_TARGET_MARKER: targetMarker,
        EASYBOOST_TEST_BASH_ENV_MARKER: bashMarker,
        EASYBOOST_TEST_HOSTILE_PATH_MARKER: pathMarker,
        EASYBOOST_TEST_NODE_PRELOAD_MARKER: preloadMarker,
        NODE_OPTIONS: `--require=${preload}`,
        NODE_PATH: path.join(root, 'hostile-node-modules'),
        PATH: posixPath(hostileBin),
      };
      const valid = spawnSync(gitBash, [
        '-p', posixPath(dispatcher), installed.bundleDigest,
      ], { encoding: 'utf8', env: environment });
      if (valid.error?.code === 'ENOENT') return context.skip('Git Bash is not installed');
      assert.equal(valid.status, 0, `${valid.stdout}\n${valid.stderr}`);
      assert.equal(await fs.readFile(targetMarker, 'utf8'), 'target');
      for (const marker of [bashMarker, pathMarker, preloadMarker]) {
        await assert.rejects(fs.access(marker), { code: 'ENOENT' }, marker);
      }

      await fs.rm(targetMarker);
      const generationRoot = path.join(installRoot, 'generations', installed.bundleDigest);
      const supervisor = path.join(generationRoot, 'staging-transaction-supervisor.js');
      await fs.chmod(generationRoot, 0o755);
      await fs.chmod(supervisor, 0o755);
      await fs.appendFile(supervisor, '\n// tampered generation\n');
      await fs.chmod(supervisor, 0o555);
      await fs.chmod(generationRoot, 0o555);
      const rejected = spawnSync(gitBash, [
        '-p', posixPath(dispatcher), installed.bundleDigest,
      ], { encoding: 'utf8', env: environment });
      assert.notEqual(rejected.status, 0, `${rejected.stdout}\n${rejected.stderr}`);
      for (const marker of [bashMarker, pathMarker, preloadMarker, targetMarker]) {
        await assert.rejects(fs.access(marker), { code: 'ENOENT' }, marker);
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

test('installer rejects writable pinned Node binaries and writable non-sticky ancestors',
  async (context) => {
    if (process.platform === 'win32') {
      return context.skip('POSIX executable ownership and mode authority execute on Linux');
    }
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-helper-node-install-authority-'));
    const source = path.join(root, 'source');
    try {
      await copyBundleSource(source);
      const authority = await prepareCopiedNodeInstaller(root);

      await fs.chmod(authority.nodeExecutable, 0o777);
      const writableBinary = runCopiedNodeInstaller(authority, source,
        path.join(root, 'binary-lib'), path.join(root, 'binary-bin'), root);
      assert.notEqual(writableBinary.status, 0, `${writableBinary.stdout}\n${writableBinary.stderr}`);
      assert.match(writableBinary.stderr, /Node executable.*unsafe owner or mode/iu);

      await fs.chmod(authority.nodeExecutable, 0o755);
      await fs.chmod(authority.nodeDirectory, 0o777);
      const writableAncestor = runCopiedNodeInstaller(authority, source,
        path.join(root, 'ancestor-lib'), path.join(root, 'ancestor-bin'), root);
      assert.notEqual(writableAncestor.status, 0,
        `${writableAncestor.stdout}\n${writableAncestor.stderr}`);
      assert.match(writableAncestor.stderr, /Node executable ancestor.*unsafe owner or mode/iu);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

test('private Node authority publication retains and adopts a typed partial before current',
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-helper-node-publication-'));
    const source = path.join(root, 'source');
    try {
      await copyBundleSource(source);
      const fileFailureInstall = path.join(root, 'file-failure-lib');
      await assert.rejects(installStagingHelperBundle({
        sourceDirectory: source,
        installRoot: fileFailureInstall,
        linkRoot: path.join(root, 'file-failure-bin'),
        allowedPrefix: root,
        operations: {
          syncFile: async (file) => {
            if (path.basename(path.dirname(path.dirname(file))) === 'node-authorities'
                && /^[a-f0-9]{64}$/u.test(path.basename(path.dirname(file)))) {
              throw new Error('injected private Node file sync failure');
            }
          },
        },
      }), /injected private Node file sync failure/u);
      await assert.rejects(fs.access(path.join(fileFailureInstall, 'current')), { code: 'ENOENT' });
      const partialAuthorities = await fs.readdir(path.join(fileFailureInstall, 'node-authorities'));
      assert.equal(partialAuthorities.length, 1);
      assert.match(partialAuthorities[0], /^[a-f0-9]{64}$/u);
      assert.deepEqual(await fs.readdir(path.join(
        fileFailureInstall, 'node-authorities', partialAuthorities[0],
      )), [process.platform === 'win32' ? 'node.exe' : 'node'],
      'a failed durable write must retain a typed, restart-adoptable partial publication');
      const adopted = await installStagingHelperBundle({
        sourceDirectory: source,
        installRoot: fileFailureInstall,
        linkRoot: path.join(root, 'file-failure-bin'),
        allowedPrefix: root,
      });
      assert.equal(await fs.readFile(path.join(fileFailureInstall, 'current'), 'utf8'),
        `${adopted.bundleDigest}\n`);

      const parentFailureInstall = path.join(root, 'parent-failure-lib');
      const authorityParent = path.join(parentFailureInstall, 'node-authorities');
      await assert.rejects(installStagingHelperBundle({
        sourceDirectory: source,
        installRoot: parentFailureInstall,
        linkRoot: path.join(root, 'parent-failure-bin'),
        allowedPrefix: root,
        operations: {
          syncDirectory: async (directory) => {
            if (directory === authorityParent && (await fs.readdir(directory)).some(
              (name) => /^[a-f0-9]{64}$/u.test(name),
            )) {
              throw new Error('injected private Node parent sync failure');
            }
          },
        },
      }), /injected private Node parent sync failure/u);
      await assert.rejects(fs.access(path.join(parentFailureInstall, 'current')), { code: 'ENOENT' });
      const retained = await fs.readdir(authorityParent);
      assert.equal(retained.length, 1);
      assert.match(retained[0], /^[a-f0-9]{64}$/u);
      assert.deepEqual(await fs.readdir(path.join(authorityParent, retained[0])), [],
        'a parent-sync interruption may retain the exact empty allocation for typed retry');

      const retry = await installStagingHelperBundle({
        sourceDirectory: source,
        installRoot: parentFailureInstall,
        linkRoot: path.join(root, 'parent-failure-bin'),
        allowedPrefix: root,
      });
      assert.equal(await fs.readFile(path.join(parentFailureInstall, 'current'), 'utf8'),
        `${retry.bundleDigest}\n`);
      const privateRuntimeDirectory = path.join(authorityParent, retained[0]);
      const privateExecutable = path.join(privateRuntimeDirectory,
        process.platform === 'win32' ? 'node.exe' : 'node');
      await fs.chmod(privateRuntimeDirectory, 0o755);
      await fs.chmod(privateExecutable, 0o755);
      await fs.appendFile(privateExecutable, Buffer.from([0]));
      await fs.chmod(privateExecutable, 0o555);
      await fs.chmod(privateRuntimeDirectory, 0o555);
      await assert.rejects(installStagingHelperBundle({
        sourceDirectory: source,
        installRoot: parentFailureInstall,
        linkRoot: path.join(root, 'parent-failure-bin'),
        allowedPrefix: root,
      }), /(?:digest|byte-count) mismatch|executable is incomplete/u);
      assert.equal(await fs.readFile(path.join(parentFailureInstall, 'current'), 'utf8'),
        `${retry.bundleDigest}\n`, 'an invalid retained runtime must not advance current');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

test('durable file creation stays bound to its no-follow FileHandle across a path swap', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-helper-filehandle-swap-'));
  const source = path.join(root, 'source');
  const installRoot = path.join(root, 'lib');
  const linkRoot = path.join(root, 'bin');
  const pathChmods = [];
  let original;
  let replacement;
  let openedFlags;
  try {
    await copyBundleSource(source);
    await assert.rejects(installStagingHelperBundle({
      sourceDirectory: source,
      installRoot,
      linkRoot,
      allowedPrefix: root,
      operations: {
        chmod: async (target, mode) => {
          pathChmods.push(target);
          await fs.chmod(target, mode);
        },
        open: async (target, flags, mode) => {
          const descriptor = await fs.open(target, flags, mode);
          const isPrivateNode = path.basename(target)
            === (process.platform === 'win32' ? 'node.exe' : 'node')
            && /^[a-f0-9]{64}$/u.test(path.basename(path.dirname(target)));
          if (!isPrivateNode || replacement) return descriptor;
          openedFlags = flags;
          original = `${target}.opened-original`;
          replacement = target;
          await fs.rename(target, original);
          await fs.writeFile(replacement, 'unrelated-replacement', { mode: 0o600 });
          return descriptor;
        },
      },
    }), /durable helper file changed while opening no-follow/u);
    assert.equal(openedFlags & fs.constants.O_CREAT, fs.constants.O_CREAT);
    assert.equal(openedFlags & fs.constants.O_EXCL, fs.constants.O_EXCL);
    if (fs.constants.O_NOFOLLOW) {
      assert.equal(openedFlags & fs.constants.O_NOFOLLOW, fs.constants.O_NOFOLLOW);
    }
    assert.equal(await fs.readFile(replacement, 'utf8'), 'unrelated-replacement');
    assert.equal(pathChmods.includes(replacement), false,
      'the swapped pathname must never receive the requested file mode');
    assert.equal((await fs.stat(original)).size, 0,
      'the opened original must be rejected before descriptor-bound writes start');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('publication rename success never cleans reused old names and removes empty temp containers',
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-helper-rename-success-'));
    const source = path.join(root, 'source');
    const installRoot = path.join(root, 'lib');
    const linkRoot = path.join(root, 'bin');
    const replacements = [];
    const removed = [];
    try {
      await copyBundleSource(source);
      await installStagingHelperBundle({
        sourceDirectory: source,
        installRoot,
        linkRoot,
        allowedPrefix: root,
        operations: {
          rename: async (from, to) => {
            await fs.rename(from, to);
            if (path.dirname(to) === path.join(installRoot, 'generations')) {
              await fs.mkdir(from, { mode: 0o700 });
              const sentinel = path.join(from, 'unrelated-successor');
              await fs.writeFile(sentinel, 'generation-successor');
              replacements.push(sentinel);
            } else if (to === path.join(installRoot, 'staging-release-entry.sh')) {
              await fs.writeFile(from, 'file-successor');
              replacements.push(from);
            }
          },
          rm: async (target, options) => {
            removed.push(target);
            await fs.rm(target, options);
          },
        },
      });
      assert.equal(await fs.readFile(replacements[0], 'utf8'), 'generation-successor');
      assert.equal(await fs.readFile(replacements[1], 'utf8'), 'file-successor');
      assert.equal(replacements.some((candidate) => removed.includes(candidate)), false);

      const cleanRoot = await fs.mkdtemp(path.join(root, 'routine-'));
      const cleanInstall = path.join(cleanRoot, 'lib');
      const cleanLinks = path.join(cleanRoot, 'bin');
      await installStagingHelperBundle({
        sourceDirectory: source,
        installRoot: cleanInstall,
        linkRoot: cleanLinks,
        allowedPrefix: cleanRoot,
      });
      for (const directory of [cleanInstall, cleanLinks]) {
        assert.equal((await fs.readdir(directory)).some((name) => name.includes('.new.')), false,
          `${directory} must not retain empty publication containers after routine success`);
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

test('publication rename failure preserves its private original and an unrelated replacement',
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-helper-rename-failure-'));
    const source = path.join(root, 'source');
    const installRoot = path.join(root, 'lib');
    const linkRoot = path.join(root, 'bin');
    let original;
    let replacement;
    const removed = [];
    try {
      await copyBundleSource(source);
      const installed = await installStagingHelperBundle({
        sourceDirectory: source, installRoot, linkRoot, allowedPrefix: root,
      });
      await assert.rejects(installStagingHelperBundle({
        sourceDirectory: source,
        installRoot,
        linkRoot,
        allowedPrefix: root,
        operations: {
          rename: async (from, to) => {
            if (!original && to === path.join(installRoot, 'staging-release-entry.sh')) {
              original = path.join(path.dirname(from), 'known-original');
              replacement = from;
              await fs.rename(from, original);
              await fs.writeFile(replacement, 'unrelated-replacement');
              throw new Error('injected publication rename failure');
            }
            await fs.rename(from, to);
          },
          rm: async (target, options) => {
            removed.push(target);
            await fs.rm(target, options);
          },
        },
      }), /injected publication rename failure/u);
      assert.match(await fs.readFile(original, 'utf8'), /#!\/bin\/bash -p/u);
      assert.equal(await fs.readFile(replacement, 'utf8'), 'unrelated-replacement');
      assert.equal(removed.includes(original), false);
      assert.equal(removed.includes(replacement), false);
      assert.equal(await fs.readFile(path.join(installRoot, 'current'), 'utf8'),
        `${installed.bundleDigest}\n`);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

test('simultaneous local installers serialize private authority and quarantine accounting',
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-helper-local-lock-'));
    const source = path.join(root, 'source');
    const installRoot = path.join(root, 'lib');
    const firstLinks = path.join(root, 'bin-first');
    const secondLinks = path.join(root, 'bin-second');
    let releaseFirst;
    let firstPaused;
    const paused = new Promise((resolve) => { firstPaused = resolve; });
    const release = new Promise((resolve) => { releaseFirst = resolve; });
    let held = false;
    try {
      await copyBundleSource(source);
      const first = installStagingHelperBundle({
        sourceDirectory: source,
        installRoot,
        linkRoot: firstLinks,
        allowedPrefix: root,
        operations: {
          syncFile: async (file, descriptor) => {
            if (!held && path.basename(file) === (process.platform === 'win32' ? 'node.exe' : 'node')) {
              held = true;
              firstPaused();
              await release;
            }
            await descriptor.sync();
          },
        },
      });
      await paused;
      const second = installStagingHelperBundle({
        sourceDirectory: source,
        installRoot,
        linkRoot: secondLinks,
        allowedPrefix: root,
      });
      await new Promise((resolve) => setImmediate(resolve));
      await assert.rejects(fs.access(secondLinks), { code: 'ENOENT' },
        'the second local installer must not mutate before the first releases its critical section');
      releaseFirst();
      const [firstResult, secondResult] = await Promise.all([first, second]);
      assert.equal(firstResult.bundleDigest, secondResult.bundleDigest);
      const authorityNames = await fs.readdir(path.join(installRoot, 'node-authorities'));
      assert.equal(authorityNames.filter((name) => /^[a-f0-9]{64}$/u.test(name)).length, 1);
      assert.equal(authorityNames.filter((name) => /quarantine/u.test(name)).length, 0);
    } finally {
      releaseFirst?.();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

test('private Node retry quarantines a crash-truncated executable and republishes its digest',
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-helper-node-crash-retry-'));
    const source = path.join(root, 'source');
    const installRoot = path.join(root, 'lib');
    const linkRoot = path.join(root, 'bin');
    let interrupted = false;
    try {
      await copyBundleSource(source);
      await assert.rejects(installStagingHelperBundle({
        sourceDirectory: source,
        installRoot,
        linkRoot,
        allowedPrefix: root,
        operations: {
          open: async (file, flags, mode) => {
            const descriptor = await fs.open(file, flags, mode);
            const isPrivateNode = path.basename(file)
              === (process.platform === 'win32' ? 'node.exe' : 'node')
              && /^[a-f0-9]{64}$/u.test(path.basename(path.dirname(file)));
            if (interrupted || !isPrivateNode) return descriptor;
            return {
              chmod: descriptor.chmod.bind(descriptor),
              close: descriptor.close.bind(descriptor),
              stat: descriptor.stat.bind(descriptor),
              sync: descriptor.sync.bind(descriptor),
              writeFile: async (bytes) => {
                interrupted = true;
                await descriptor.writeFile(bytes.subarray(0, Math.max(1, bytes.length >>> 1)));
                throw new Error('injected crash during private Node byte publication');
              },
            };
          },
        },
      }), /injected crash during private Node byte publication/u);
      await assert.rejects(fs.access(path.join(installRoot, 'current')), { code: 'ENOENT' });

      const installed = await installStagingHelperBundle({
        sourceDirectory: source, installRoot, linkRoot, allowedPrefix: root,
      });
      assert.equal(await fs.readFile(path.join(installRoot, 'current'), 'utf8'),
        `${installed.bundleDigest}\n`);
      const authorities = await fs.readdir(path.join(installRoot, 'node-authorities'));
      const digest = authorities.find((name) => /^[a-f0-9]{64}$/u.test(name));
      const quarantines = authorities.filter((name) => (
        /^\.[a-f0-9]{64}\.quarantine\.[a-f0-9]{64}$/u.test(name)
      ));
      assert.ok(digest);
      assert.equal(quarantines.length, 1,
        'the crash-truncated inode must remain retained under one typed quarantine');
      assert.deepEqual((await fs.readdir(path.join(installRoot, 'node-authorities', digest))).sort(), [
        'node-authority.json', process.platform === 'win32' ? 'node.exe' : 'node',
      ].sort());
      const retainedExecutable = path.join(
        installRoot, 'node-authorities', quarantines[0],
        process.platform === 'win32' ? 'node.exe' : 'node',
      );
      assert.ok((await fs.stat(retainedExecutable)).size < (await fs.stat(process.execPath)).size);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

test('private Node quarantine never chmods or removes a successor swapped at rotate time',
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-helper-node-quarantine-aba-'));
    const source = path.join(root, 'source');
    const installRoot = path.join(root, 'lib');
    const linkRoot = path.join(root, 'bin');
    try {
      await copyBundleSource(source);
      await assert.rejects(installStagingHelperBundle({
        sourceDirectory: source,
        installRoot,
        linkRoot,
        allowedPrefix: root,
        operations: {
          syncFile: async (file) => {
            if (path.basename(file) === (process.platform === 'win32' ? 'node.exe' : 'node')) {
              throw new Error('injected typed publication interruption');
            }
          },
        },
      }), /injected typed publication interruption/u);
      const authorityRoot = path.join(installRoot, 'node-authorities');
      const digest = (await fs.readdir(authorityRoot)).find((name) => /^[a-f0-9]{64}$/u.test(name));
      assert.ok(digest);
      const runtimeDirectory = path.join(authorityRoot, digest);
      await fs.writeFile(path.join(runtimeDirectory, 'unexpected'), 'forces typed quarantine');
      const original = `${runtimeDirectory}.original`;
      const chmodTargets = [];
      const removedTargets = [];
      let swapped = false;
      let retainedAuthority;
      await assert.rejects(installStagingHelperBundle({
        sourceDirectory: source,
        installRoot,
        linkRoot,
        allowedPrefix: root,
        operations: {
          chmod: async (target, mode) => {
            chmodTargets.push(target);
            return fs.chmod(target, mode);
          },
          rename: async (from, to) => {
            if (!swapped && from === runtimeDirectory && /\.quarantine\.[a-f0-9]{64}$/u.test(to)) {
              swapped = true;
              await fs.rename(from, original);
              await fs.mkdir(from, { mode: 0o700 });
              await fs.writeFile(path.join(from, 'successor'), 'must-survive', { mode: 0o600 });
            }
            return fs.rename(from, to);
          },
          rm: async (target, options) => {
            removedTargets.push(target);
            return fs.rm(target, options);
          },
        },
      }), (error) => {
        retainedAuthority = error?.recoveryAuthority;
        return /successor was retained in quarantine/iu.test(error?.message ?? '');
      });
      assert.equal(swapped, true);
      assert.equal(retainedAuthority?.protocol, STAGING_NODE_AUTHORITY_PROTOCOL);
      assert.equal(await fs.readFile(path.join(retainedAuthority.quarantine, 'successor'), 'utf8'),
        'must-survive');
      assert.equal(chmodTargets.includes(retainedAuthority.quarantine), false);
      assert.equal(chmodTargets.includes(path.join(retainedAuthority.quarantine, 'successor')), false);
      assert.equal(removedTargets.includes(retainedAuthority.quarantine), false);
      assert.equal(removedTargets.includes(path.join(retainedAuthority.quarantine, 'successor')), false);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

test('private Node quarantine quota blocks a new digest allocation before mutation', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-helper-node-quarantine-quota-'));
  const source = path.join(root, 'source');
  const installRoot = path.join(root, 'lib');
  const authorityRoot = path.join(installRoot, 'node-authorities');
  const linkRoot = path.join(root, 'bin');
  try {
    await copyBundleSource(source);
    await fs.mkdir(authorityRoot, { recursive: true, mode: 0o755 });
    await fs.chmod(installRoot, 0o755);
    await fs.chmod(authorityRoot, 0o755);
    for (let index = 0; index < 1024; index += 1) {
      const token = index.toString(16).padStart(64, '0');
      await fs.mkdir(path.join(authorityRoot,
        `.${'a'.repeat(64)}.quarantine.${token}`), { mode: 0o700 });
    }
    await assert.rejects(installStagingHelperBundle({
      sourceDirectory: source, installRoot, linkRoot, allowedPrefix: root,
    }), /private Node quarantine count quota is exceeded/u);
    const names = await fs.readdir(authorityRoot);
    assert.equal(names.length, 1024);
    assert.equal(names.some((name) => /^[a-f0-9]{64}$/u.test(name)), false,
      'quota exhaustion must fail before allocating the deterministic digest directory');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('launcher revalidates pinned Node ancestors identity and digest before every execution',
  async (context) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-helper-node-runtime-authority-'));
    const source = path.join(root, 'source');
    const installRoot = path.join(root, 'lib');
    const linkRoot = path.join(root, 'bin');
    const marker = path.join(root, 'generation-executed');
    try {
      await copyBundleSource(source);
      await fs.writeFile(path.join(source, 'staging-transaction-supervisor.js'), [
        "import fsSync from 'node:fs';",
        'fsSync.writeFileSync(process.env.EASYBOOST_TEST_NODE_AUTHORITY_MARKER, JSON.stringify({',
        `  authority: process.env.${STAGING_NODE_AUTHORITY_ENVIRONMENT} ?? null,`,
        '  pid: process.pid,',
        '}));',
        '',
      ].join('\n'));
      const authority = await prepareCopiedNodeInstaller(root);
      const pinnedDigest = crypto.createHash('sha256')
        .update(await fs.readFile(authority.nodeExecutable)).digest('hex');
      const installation = runCopiedNodeInstaller(authority, source, installRoot, linkRoot, root);
      assert.equal(installation.status, 0, `${installation.stdout}\n${installation.stderr}`);
      const pinnedDirectory = path.join(installRoot, 'node-authorities', pinnedDigest);
      const pinnedExecutable = path.join(pinnedDirectory,
        process.platform === 'win32' ? 'node.exe' : 'node');
      assert.deepEqual((await fs.readdir(pinnedDirectory)).sort(), [
        'node-authority.json', path.basename(pinnedExecutable),
      ].sort());
      const launcher = await fs.readFile(path.join(installRoot, 'staging-release-entry.sh'), 'utf8');
      const dispatcher = await fs.readFile(path.join(linkRoot, 'easyboost-staging-restart'), 'utf8');
      assert.match(launcher,
        /verify_generation\(\) \{\s+bind_node_authority[\s\S]*"\$node_bound_executable" --input-type=module/u,
        'the pinned authority must be revalidated immediately before every verifier process');
      assert.equal((launcher.match(
        /generation_schema="\$\(verify_generation[^\n]+\n\s*bind_node_authority/gu,
      ) ?? []).length, 2,
      'current and recovery roles must both revalidate after verification and before final exec');
      assert.match(launcher, /node_digest_expected='[a-f0-9]{64}'/u);
      assert.match(launcher, /exec 9< "\$node_executable"[\s\S]*node_bound_executable="\/proc\/\$BASHPID\/fd\/9"/u);
      assert.match(launcher, new RegExp(
        `${STAGING_NODE_AUTHORITY_ENVIRONMENT}=\"\\$node_authority_contract_protocol:9:\\$owner_pid:\\$node_digest_expected\"`,
        'u',
      ));
      assert.equal((launcher.match(/publish_node_authority_contract \|\|/gu) ?? []).length, 2,
        'current and recovery final execs must receive the descriptor metadata contract');
      assert.match(launcher, new RegExp(
        `unset [^\n]*${STAGING_QUIESCENT_MAINTENANCE_ENVIRONMENT}`,
        'u',
      ));
      assert.match(dispatcher, new RegExp(
        `unset [^\n]*${STAGING_QUIESCENT_MAINTENANCE_ENVIRONMENT}`,
        'u',
      ));
      assert.match(launcher,
        /maintenance_lock=.*maintenance\.lock[\s\S]*exec 7< "\$maintenance_lock"[\s\S]*exec 8<> "\$maintenance_preopened"/u,
        'fd8 must be reopened read-write from the already identity-proved fd7 object');
      assert.match(launcher, /flock_tool='\/usr\/bin\/flock'/u);
      assert.match(launcher,
        /exec 8<> "\$maintenance_preopened"[\s\S]*"\$flock_tool" -n 8 \|\| return 1/u,
        'flock must bind the already identity-proved fd8 rather than reopen a pathname');
      assert.doesNotMatch(launcher, /"\$flock_tool" --no-fork[^\n]* 8 --/u,
        'util-linux flock does not support combining an fd operand with a command');
      assert.match(launcher, new RegExp(
        `${STAGING_QUIESCENT_MAINTENANCE_ENVIRONMENT}="\\$maintenance_environment_expected"`,
        'u',
      ));
      assert.match(launcher, new RegExp(
        `maintenance_environment_expected='${STAGING_QUIESCENT_MAINTENANCE_PROTOCOL}:${STAGING_QUIESCENT_MAINTENANCE_DESCRIPTOR}:[a-f0-9]{64}'`,
        'u',
      ));
      assert.equal((launcher.match(/bind_quiescent_maintenance \|\|/gu) ?? []).length, 2,
        'current and recovery exec paths must both bind and prove fd8');
      assert.match(launcher, /exec 9< "\$node_executable"/u,
        'the existing pinned Node fd9 contract must stay unchanged');
      assert.doesNotMatch(launcher, /exec 8< "\$pointer"/u,
        'the current pointer must no longer occupy reserved maintenance fd8');
      assert.doesNotMatch(launcher,
        /exec "\$node_executable" "\$generation_root\/staging-transaction-supervisor\.js"/u,
        'no verifier or final process may reopen the checked Node pathname');
      const currentDigest = (await fs.readFile(path.join(installRoot, 'current'), 'utf8')).trim();
      const invoke = () => spawnSync(gitBash, [
        '-p', posixPath(path.join(linkRoot, 'easyboost-staging-restart')), currentDigest,
      ], {
        encoding: 'utf8',
        env: { ...process.env, EASYBOOST_TEST_NODE_AUTHORITY_MARKER: marker },
      });
      const assertValid = async () => {
        const result = invoke();
        if (result.error?.code === 'ENOENT') return false;
        assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
        const observed = JSON.parse(await fs.readFile(marker, 'utf8'));
        const [protocol, descriptor, ownerPid, digest] = observed.authority.split(':');
        assert.deepEqual({ descriptor, digest, protocol }, {
          descriptor: '9', digest: pinnedDigest, protocol: STAGING_NODE_AUTHORITY_PROTOCOL,
        });
        assert.match(ownerPid, /^[1-9][0-9]*$/u);
        if (process.platform !== 'win32') assert.equal(Number(ownerPid), observed.pid);
        await fs.rm(marker);
        return true;
      };
      if (!await assertValid()) return context.skip('Git Bash is not installed');

      if (process.platform !== 'win32') {
        await fs.chmod(pinnedDirectory, 0o777);
        const writableAncestor = invoke();
        assert.notEqual(writableAncestor.status, 0,
          `${writableAncestor.stdout}\n${writableAncestor.stderr}`);
        await assert.rejects(fs.access(marker), { code: 'ENOENT' });
        await fs.chmod(pinnedDirectory, 0o555);
        assert.equal(await assertValid(), true);
      }

      const oldNodeDirectory = `${pinnedDirectory}.old`;
      await renameAfterWindowsImageRelease(pinnedDirectory, oldNodeDirectory);
      await fs.mkdir(pinnedDirectory, { mode: 0o755 });
      await fs.copyFile(path.join(oldNodeDirectory, path.basename(pinnedExecutable)),
        pinnedExecutable);
      await fs.chmod(pinnedExecutable, 0o555);
      await fs.chmod(pinnedDirectory, 0o555);
      const replacedAncestor = invoke();
      assert.notEqual(replacedAncestor.status, 0,
        `${replacedAncestor.stdout}\n${replacedAncestor.stderr}`);
      await assert.rejects(fs.access(marker), { code: 'ENOENT' });
      await fs.chmod(pinnedDirectory, 0o755);
      await fs.rm(pinnedDirectory, { recursive: true, force: true });
      await renameAfterWindowsImageRelease(oldNodeDirectory, pinnedDirectory);
      assert.equal(await assertValid(), true);

      const originalSize = (await fs.stat(pinnedExecutable)).size;
      await fs.chmod(pinnedExecutable, 0o755);
      await fs.appendFile(pinnedExecutable, Buffer.from([0]));
      await fs.chmod(pinnedExecutable, 0o555);
      const changedBinary = invoke();
      assert.notEqual(changedBinary.status, 0, `${changedBinary.stdout}\n${changedBinary.stderr}`);
      await assert.rejects(fs.access(marker), { code: 'ENOENT' });
      await fs.chmod(pinnedExecutable, 0o755);
      await fs.truncate(pinnedExecutable, originalSize);
      await fs.chmod(pinnedExecutable, 0o555);
      assert.equal(await assertValid(), true);

      const oldExecutable = `${pinnedExecutable}.old`;
      const replacement = `${pinnedExecutable}.replacement`;
      await fs.chmod(pinnedDirectory, 0o755);
      await fs.copyFile(pinnedExecutable, replacement);
      await fs.chmod(replacement, 0o555);
      await renameAfterWindowsImageRelease(pinnedExecutable, oldExecutable);
      await renameAfterWindowsImageRelease(replacement, pinnedExecutable);
      await fs.chmod(pinnedDirectory, 0o555);
      const replacedBinary = invoke();
      assert.notEqual(replacedBinary.status, 0, `${replacedBinary.stdout}\n${replacedBinary.stderr}`);
      await assert.rejects(fs.access(marker), { code: 'ENOENT' });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

test('current schema pins a real supervisor to shell to nested Node chain', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-helper-current-nested-node-'));
  const source = path.join(root, 'source');
  const installRoot = path.join(root, 'lib');
  const linkRoot = path.join(root, 'bin');
  const marker = path.join(root, 'nested-node.json');
  try {
    await copyBundleSource(source);
    await fs.writeFile(path.join(source, 'staging-transaction-supervisor.js'), [
      "import { spawnSync } from 'node:child_process';",
      "const result = spawnSync('bash', ['-c', 'node \"$EASYBOOST_TEST_CURRENT_NODE_CHILD\"'], {",
      "  env: process.env, stdio: 'inherit',",
      '});',
      'process.exitCode = result.status ?? 1;',
      '',
    ].join('\n'));
    await fs.writeFile(path.join(source, 'staging-command-supervisor.js'), [
      "import crypto from 'node:crypto';",
      "import fsSync from 'node:fs';",
      'const executable = fsSync.realpathSync.native(process.execPath);',
      "const digest = crypto.createHash('sha256').update(fsSync.readFileSync(executable)).digest('hex');",
      'fsSync.writeFileSync(process.env.EASYBOOST_TEST_CURRENT_NODE_MARKER, JSON.stringify({',
      '  digest,',
      '  executable,',
      '  legacyRoot: process.env.EASYBOOST_LEGACY_GENERATION_ROOT ?? null,',
      '  nodeOptions: process.env.NODE_OPTIONS ?? null,',
      '}));',
      '',
    ].join('\n'));
    const authority = await prepareCopiedNodeInstaller(root);
    const expectedDigest = crypto.createHash('sha256')
      .update(await fs.readFile(authority.nodeExecutable)).digest('hex');
    const installation = runCopiedNodeInstaller(authority, source, installRoot, linkRoot, root);
    assert.equal(installation.status, 0, `${installation.stdout}\n${installation.stderr}`);
    await fs.rename(authority.nodeExecutable, `${authority.nodeExecutable}.removed-after-install`);
    const digest = (await fs.readFile(path.join(installRoot, 'current'), 'utf8')).trim();
    const generationRoot = path.join(installRoot, 'generations', digest);
    const invocation = spawnSync(gitBash, [
      '-p', posixPath(path.join(linkRoot, 'easyboost-staging-restart')), digest,
    ], {
      encoding: 'utf8',
      env: {
        ...process.env,
        EASYBOOST_TEST_CURRENT_NODE_CHILD: path.join(generationRoot,
          'staging-command-supervisor.js'),
        EASYBOOST_TEST_CURRENT_NODE_MARKER: marker,
      },
    });
    if (invocation.error?.code === 'ENOENT') return context.skip('Git Bash is not installed');
    assert.equal(invocation.status, 0, `${invocation.stdout}\n${invocation.stderr}`);
    const nested = JSON.parse(await fs.readFile(marker, 'utf8'));
    const expectedExecutable = await fs.realpath(path.join(
      installRoot,
      'node-authorities',
      expectedDigest,
      process.platform === 'win32' ? 'node.exe' : 'node',
    ));
    assert.deepEqual(nested, {
      digest: expectedDigest,
      executable: expectedExecutable,
      legacyRoot: null,
      nodeOptions: null,
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('current launcher keeps one private Node through transaction wrapper bash and nested helper',
  async (context) => {
    if (process.platform !== 'linux') {
      return context.skip('the production transaction and POSIX wrapper chain executes on Linux');
    }
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-helper-current-wrapper-chain-'));
    const source = path.join(root, 'source');
    const installRoot = path.join(root, 'lib');
    const linkRoot = path.join(root, 'bin');
    const marker = path.join(root, 'runtime-chain.jsonl');
    try {
      await copyBundleSource(source);
      const transactionPath = path.join(source, 'staging-transaction-supervisor.js');
      let transaction = await fs.readFile(transactionPath, 'utf8');
      transaction = transaction.replace(
        "import { spawn } from 'node:child_process';",
        "import { spawn } from 'node:child_process';\nimport fsSync from 'node:fs';",
      ).replace(
        'const DEFAULT_POLL_MILLISECONDS = 20;',
        [
          "if (process.env.EASYBOOST_TEST_RUNTIME_CHAIN_MARKER) {",
          '  const executable = fsSync.realpathSync.native(process.execPath);',
          "  const digest = createHash('sha256').update(fsSync.readFileSync(executable)).digest('hex');",
          "  const role = process.argv.includes('--ready') ? 'transaction-ready' : 'transaction-main';",
          '  fsSync.appendFileSync(process.env.EASYBOOST_TEST_RUNTIME_CHAIN_MARKER,',
          "    `${JSON.stringify({ digest, executable, role })}\\n`);",
          '}',
          '',
          'const DEFAULT_POLL_MILLISECONDS = 20;',
        ].join('\n'),
      );
      await fs.writeFile(transactionPath, transaction);

      const posixPathname = path.join(source, 'posix-session-supervisor.js');
      let posix = await fs.readFile(posixPathname, 'utf8');
      posix = posix.replace(
        'const POLL_MILLISECONDS = 20;',
        [
          "if (process.env.EASYBOOST_TEST_RUNTIME_CHAIN_MARKER) {",
          '  const executable = fs.realpathSync.native(process.execPath);',
          "  const digest = createHash('sha256').update(fs.readFileSync(executable)).digest('hex');",
          "  const role = path.basename(process.argv[1] ?? '') === path.basename(SUPERVISOR_FILE)",
          "    ? 'posix-wrapper' : 'posix-import';",
          '  fs.appendFileSync(process.env.EASYBOOST_TEST_RUNTIME_CHAIN_MARKER,',
          "    `${JSON.stringify({ digest, executable, role })}\\n`);",
          '}',
          '',
          'const POLL_MILLISECONDS = 20;',
        ].join('\n'),
      );
      await fs.writeFile(posixPathname, posix);

      await fs.writeFile(path.join(source, 'staging-restart-app.sh'), [
        '#!/bin/bash',
        'set -Eeuo pipefail',
        'script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"',
        'node "$script_dir/staging-transaction-supervisor.js" --ready 1800 5000',
        "printf '%s\\n' '{\"role\":\"bash\"}' >> \"$EASYBOOST_TEST_RUNTIME_CHAIN_MARKER\"",
        'node "$EASYBOOST_TEST_RUNTIME_CHAIN_CHILD"',
        '',
      ].join('\n'));
      await fs.writeFile(path.join(source, 'staging-command-supervisor.js'), [
        "import crypto from 'node:crypto';",
        "import fsSync from 'node:fs';",
        'const executable = fsSync.realpathSync.native(process.execPath);',
        "const digest = crypto.createHash('sha256').update(fsSync.readFileSync(executable)).digest('hex');",
        'fsSync.appendFileSync(process.env.EASYBOOST_TEST_RUNTIME_CHAIN_MARKER,',
        "  `${JSON.stringify({ digest, executable, role: 'nested' })}\\n`);",
        '',
      ].join('\n'));

      const authority = await prepareCopiedNodeInstaller(root);
      const expectedDigest = crypto.createHash('sha256')
        .update(await fs.readFile(authority.nodeExecutable)).digest('hex');
      const installation = runCopiedNodeInstaller(authority, source, installRoot, linkRoot, root);
      assert.equal(installation.status, 0, `${installation.stdout}\n${installation.stderr}`);
      await fs.rename(authority.nodeExecutable, `${authority.nodeExecutable}.removed-after-install`);
      const bundleDigest = (await fs.readFile(path.join(installRoot, 'current'), 'utf8')).trim();
      const generationRoot = path.join(installRoot, 'generations', bundleDigest);
      const expectedExecutable = await fs.realpath(path.join(
        installRoot, 'node-authorities', expectedDigest, 'node',
      ));
      const invocation = spawnSync('bash', [
        '-p', path.join(linkRoot, 'easyboost-staging-restart'), bundleDigest,
      ], {
        encoding: 'utf8',
        env: {
          ...process.env,
          EASYBOOST_TEST_RUNTIME_CHAIN_CHILD: path.join(generationRoot,
            'staging-command-supervisor.js'),
          EASYBOOST_TEST_RUNTIME_CHAIN_MARKER: marker,
        },
      });
      assert.equal(invocation.status, 0, `${invocation.stdout}\n${invocation.stderr}`);
      const records = (await fs.readFile(marker, 'utf8')).trim().split('\n').map(JSON.parse);
      assert.ok(records.some((record) => record.role === 'bash'));
      for (const role of ['transaction-main', 'posix-wrapper', 'transaction-ready', 'nested']) {
        assert.ok(records.some((record) => record.role === role
          && record.digest === expectedDigest && record.executable === expectedExecutable),
        `${role} must execute through the same private content-addressed Node runtime`);
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

test('Linux launcher exports a live fd8 flock proof for the exact canonical maintenance lock',
  async (context) => {
    if (process.platform !== 'linux') {
      return context.skip('the production fd8 and /usr/bin/flock contract executes on Linux');
    }
    try {
      await fs.access('/usr/bin/flock');
    } catch {
      return context.skip('/usr/bin/flock is unavailable');
    }
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-helper-maintenance-fd8-'));
    const source = path.join(root, 'source');
    const installRoot = path.join(root, 'lib');
    const linkRoot = path.join(root, 'bin');
    const marker = path.join(root, 'maintenance-proof.json');
    const recoveryMarker = path.join(root, 'maintenance-recovery-proof.json');
    try {
      await copyBundleSource(source);
      await fs.writeFile(path.join(source, 'staging-transaction-supervisor.js'), [
        "import fsSync from 'node:fs';",
        "import { consumeStagingQuiescentMaintenanceLock } from './staging-quiescent-maintenance.js';",
        `const contract = process.env.${STAGING_QUIESCENT_MAINTENANCE_ENVIRONMENT} ?? null;`,
        'const proof = consumeStagingQuiescentMaintenanceLock({',
        '  environment: process.env,',
        '  expectedInstallRoot: process.env.EASYBOOST_TEST_MAINTENANCE_INSTALL_ROOT,',
        '});',
        `const stat = fsSync.fstatSync(${STAGING_QUIESCENT_MAINTENANCE_DESCRIPTOR}, { bigint: true });`,
        `const fdinfoLock = fsSync.readFileSync('/proc/self/fdinfo/${STAGING_QUIESCENT_MAINTENANCE_DESCRIPTOR}', 'utf8')`,
        "  .split(/\\r?\\n/u).find((line) => line.startsWith('lock:'));",
        "if (!fdinfoLock) throw new Error('fd8 does not carry a kernel flock record');",
        `const nodeAuthority = process.env.${STAGING_NODE_AUTHORITY_ENVIRONMENT} ?? '';`,
        'fsSync.writeFileSync(process.env.EASYBOOST_TEST_MAINTENANCE_MARKER, JSON.stringify({',
        '  contract,',
        '  consumerDescriptor: proof.descriptor,',
        '  consumerProtocol: proof.protocol,',
        '  dev: String(stat.dev),',
        '  fdinfoLock,',
        '  ino: String(stat.ino),',
        '  nodeAuthorityOwnerPid: Number(nodeAuthority.split(\':\')[2]),',
        '  pid: process.pid,',
        '}));',
        '',
      ].join('\n'));
      const installed = await installStagingHelperBundle({
        sourceDirectory: source, installRoot, linkRoot, allowedPrefix: root,
      });
      const lockPath = path.join(installRoot, STAGING_QUIESCENT_MAINTENANCE_LOCK_NAME);
      const lockBytes = stagingQuiescentMaintenanceLockBytes(installRoot);
      const lockStat = await fs.lstat(lockPath, { bigint: true });
      const invoke = (dispatcher, arguments_, markerPath) => spawnSync('bash', [
        '-p', path.join(linkRoot, dispatcher), ...arguments_,
      ], {
        encoding: 'utf8',
        env: {
          ...process.env,
          EASYBOOST_TEST_MAINTENANCE_INSTALL_ROOT: installRoot,
          EASYBOOST_TEST_MAINTENANCE_MARKER: markerPath,
          [STAGING_QUIESCENT_MAINTENANCE_ENVIRONMENT]: 'hostile-inherited-value',
        },
      });
      const assertAcceptedProof = async (markerPath) => {
        const observed = JSON.parse(await fs.readFile(markerPath, 'utf8'));
        assert.equal(observed.contract, stagingQuiescentMaintenanceEnvironmentValue(lockBytes));
        assert.deepEqual({
          descriptor: observed.consumerDescriptor,
          protocol: observed.consumerProtocol,
        }, {
          descriptor: STAGING_QUIESCENT_MAINTENANCE_DESCRIPTOR,
          protocol: STAGING_QUIESCENT_MAINTENANCE_PROTOCOL,
        });
        assert.equal(observed.dev, String(lockStat.dev));
        assert.equal(observed.ino, String(lockStat.ino));
        assert.match(observed.fdinfoLock, new RegExp(
          `^lock:\\s+[0-9]+:\\s+FLOCK\\s+ADVISORY\\s+WRITE\\s+[1-9][0-9]*`
          + `\\s+[0-9a-f]+:[0-9a-f]+:${observed.ino}\\s+0\\s+EOF$`,
          'iu',
        ), 'the actual consumer must observe an exclusive kernel lock attached to exact fd8');
        assert.equal(observed.nodeAuthorityOwnerPid, observed.pid,
          'the Bash launcher and final Node process must keep one pinned-authority PID');
      };
      const accepted = invoke('easyboost-staging-restart', [installed.bundleDigest], marker);
      assert.equal(accepted.status, 0, `${accepted.stdout}\n${accepted.stderr}`);
      await assertAcceptedProof(marker);

      const recovered = invoke('easyboost-staging-recover', [
        'restart', installed.bundleDigest,
      ], recoveryMarker);
      assert.equal(recovered.status, 0, `${recovered.stdout}\n${recovered.stderr}`);
      await assertAcceptedProof(recoveryMarker);

      await fs.rm(marker);
      await fs.writeFile(lockPath, 'tampered-maintenance-lock');
      const rejected = invoke('easyboost-staging-restart', [installed.bundleDigest], marker);
      assert.equal(rejected.status, 75, `${rejected.stdout}\n${rejected.stderr}`);
      await assert.rejects(fs.access(marker), { code: 'ENOENT' });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

test('descriptor-bound final Node survives pathname replacement after its last authority check',
  async (context) => {
    if (process.platform === 'win32') {
      return context.skip('descriptor-bound rename execution is enforced on the production POSIX host');
    }
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-helper-node-exec-gap-'));
    const source = path.join(root, 'source');
    const installRoot = path.join(root, 'lib');
    const linkRoot = path.join(root, 'bin');
    const marker = path.join(root, 'bound-node-executed');
    const hook = path.join(root, 'replace-node-after-check.sh');
    try {
      await copyBundleSource(source);
      await fs.writeFile(path.join(source, 'staging-transaction-supervisor.js'), [
        "import fsSync from 'node:fs';",
        "fsSync.writeFileSync(process.env.EASYBOOST_TEST_BOUND_NODE_MARKER, 'executed');",
        '',
      ].join('\n'));
      const authority = await prepareCopiedNodeInstaller(root);
      const pinnedDigest = crypto.createHash('sha256')
        .update(await fs.readFile(authority.nodeExecutable)).digest('hex');
      const installation = runCopiedNodeInstaller(authority, source, installRoot, linkRoot, root);
      assert.equal(installation.status, 0, `${installation.stdout}\n${installation.stderr}`);
      const pinnedExecutable = path.join(installRoot, 'node-authorities', pinnedDigest, 'node');
      await fs.writeFile(hook, [
        '#!/bin/bash -p',
        'set -Eeuo pipefail',
        'chmod 0755 -- "${EASYBOOST_TEST_PINNED_NODE%/*}"',
        'mv -- "$EASYBOOST_TEST_PINNED_NODE" "$EASYBOOST_TEST_PINNED_NODE.old"',
        'printf "not a Node executable\\n" > "$EASYBOOST_TEST_PINNED_NODE"',
        'chmod 0755 -- "$EASYBOOST_TEST_PINNED_NODE"',
        '',
      ].join('\n'));
      await fs.chmod(hook, 0o755);
      const launcherPath = path.join(installRoot, 'staging-release-entry.sh');
      let launcher = await fs.readFile(launcherPath, 'utf8');
      const checkpoint = 'publish_node_authority_contract || { echo "pinned Node authority contract could not be exported" >&2; exit 69; }\ncase "$generation_schema" in';
      const checkpointIndex = launcher.lastIndexOf(checkpoint);
      assert.notEqual(checkpointIndex, -1, 'the test must intercept the exact final authority-to-exec gap');
      launcher = `${launcher.slice(0, checkpointIndex)}${checkpoint.replace(
        '\ncase "$generation_schema" in',
        '\n"$EASYBOOST_TEST_NODE_GAP_HOOK"\ncase "$generation_schema" in',
      )}${launcher.slice(checkpointIndex + checkpoint.length)}`;
      await fs.chmod(launcherPath, 0o755);
      await fs.writeFile(launcherPath, launcher);
      await fs.chmod(launcherPath, 0o555);
      const digest = (await fs.readFile(path.join(installRoot, 'current'), 'utf8')).trim();
      const invocation = spawnSync(gitBash, [
        '-p', posixPath(path.join(linkRoot, 'easyboost-staging-restart')), digest,
      ], {
        encoding: 'utf8',
        env: {
          ...process.env,
          EASYBOOST_TEST_BOUND_NODE_MARKER: marker,
          EASYBOOST_TEST_NODE_GAP_HOOK: posixPath(hook),
          EASYBOOST_TEST_PINNED_NODE: posixPath(pinnedExecutable),
        },
      });
      if (invocation.error?.code === 'ENOENT') return context.skip('Git Bash is not installed');
      assert.equal(invocation.status, 0, `${invocation.stdout}\n${invocation.stderr}`);
      assert.equal(await fs.readFile(marker, 'utf8'), 'executed');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

test('authenticated generation carries an exact local ESM boundary under a CommonJS ancestor',
  async (context) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-helper-esm-boundary-'));
    const source = path.join(root, 'source');
    const installRoot = path.join(root, 'custom', 'lib');
    const linkRoot = path.join(root, 'custom', 'bin');
    const marker = path.join(root, 'esm-supervisor-executed');
    try {
      await fs.writeFile(path.join(root, 'package.json'), '{"type":"commonjs"}\n');
      await copyBundleSource(source);
      await fs.writeFile(path.join(source, 'staging-transaction-supervisor.js'), [
        "import fsSync from 'node:fs';",
        "fsSync.writeFileSync(process.env.EASYBOOST_TEST_ESM_MARKER, 'executed');",
        '',
      ].join('\n'));
      const installed = await installStagingHelperBundle({
        sourceDirectory: source, installRoot, linkRoot, allowedPrefix: root,
      });
      const generationRoot = path.join(installRoot, 'generations', installed.bundleDigest);
      assert.deepEqual((await fs.readdir(generationRoot)).sort(),
        [...HELPER_GENERATION_FILES, 'staging-release-bundle.json'].sort());
      assert.equal(await fs.readFile(path.join(generationRoot, 'package.json'), 'utf8'),
        '{"type":"module"}\n');
      const manifest = JSON.parse(await fs.readFile(
        path.join(generationRoot, 'staging-release-bundle.json'), 'utf8',
      ));
      assert.deepEqual(manifest.files.find((record) => record.name === 'package.json'), {
        name: 'package.json',
        bytes: 18,
        sha256: '1239d4d885dcad42201a27ed9324f8f0f760b78700d8db9ced39a511cffe7eae',
        mode: '0444',
      });
      await verifyInstalledHelperGeneration({
        generationDirectory: generationRoot,
        expectedDigest: installed.bundleDigest,
      });
      const invocation = spawnSync(gitBash, [
        posixPath(path.join(linkRoot, 'easyboost-staging-restart')), installed.bundleDigest,
      ], {
        encoding: 'utf8',
        env: { ...process.env, EASYBOOST_TEST_ESM_MARKER: marker },
      });
      if (invocation.error?.code === 'ENOENT') return context.skip('Git Bash is not installed');
      assert.equal(invocation.status, 0, `${invocation.stdout}\n${invocation.stderr}`);
      assert.equal(await fs.readFile(marker, 'utf8'), 'executed');
      await fs.rm(marker);
      const generationBoundary = path.join(generationRoot, 'package.json');
      await fs.chmod(generationRoot, 0o755);
      await fs.chmod(generationBoundary, 0o644);
      await fs.writeFile(generationBoundary, '{"type":"commonjs"}\n');
      await fs.chmod(generationBoundary, 0o444);
      await fs.chmod(generationRoot, 0o555);
      const tampered = spawnSync(gitBash, [
        posixPath(path.join(linkRoot, 'easyboost-staging-restart')), installed.bundleDigest,
      ], {
        encoding: 'utf8',
        env: { ...process.env, EASYBOOST_TEST_ESM_MARKER: marker },
      });
      assert.notEqual(tampered.status, 0, `${tampered.stdout}\n${tampered.stderr}`);
      await assert.rejects(fs.access(marker), { code: 'ENOENT' },
        'a changed ESM boundary must fail before generation code executes');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

test('upgraded launcher verifies and recovers an exact retained pre-ESM v4 generation',
  async (context) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-helper-legacy-v4-'));
    const source = path.join(root, 'source');
    const installRoot = path.join(root, 'lib');
    const linkRoot = path.join(root, 'bin');
    const marker = path.join(root, 'legacy-generation-executed');
    try {
      await fs.writeFile(path.join(root, 'package.json'), '{"type":"commonjs"}\n');
      await copyBundleSource(source);
      await fs.writeFile(path.join(source, 'staging-transaction-supervisor.js'), [
        "import fsSync from 'node:fs';",
        "fsSync.writeFileSync(process.env.EASYBOOST_TEST_LEGACY_V4_MARKER, 'current');",
        '',
      ].join('\n'));
      await installStagingHelperBundle({
        sourceDirectory: source, installRoot, linkRoot, allowedPrefix: root,
      });

      await fs.writeFile(path.join(source, 'staging-transaction-supervisor.js'), [
        "import { spawnSync } from 'node:child_process';",
        "const result = spawnSync('bash', ['-c', 'node \"$EASYBOOST_TEST_LEGACY_V4_CHILD\"'], {",
        "  env: process.env, stdio: 'inherit',",
        '});',
        'process.exitCode = result.status ?? 1;',
        '',
      ].join('\n'));
      await fs.writeFile(path.join(source, 'staging-command-supervisor.js'), [
        "import fsSync from 'node:fs';",
        "if (!/^--experimental-loader=data:text\\/javascript;base64,[A-Za-z0-9+/=]+$/u.test(process.env.NODE_OPTIONS ?? '')) {",
        "  throw new Error('legacy nested Node did not inherit only the trusted loader');",
        '}',
        "fsSync.writeFileSync(process.env.EASYBOOST_TEST_LEGACY_V4_MARKER, 'nested');",
        '',
      ].join('\n'));
      const aggregate = crypto.createHash('sha256');
      aggregate.update(`easyboost-staging-helper-bundle-v4\0${STAGING_HELPER_PROTOCOL}\0`);
      const legacyFiles = [];
      const legacyBytes = new Map();
      for (const name of HELPER_BUNDLE_FILES) {
        const bytes = await fs.readFile(path.join(source, name));
        const digest = crypto.createHash('sha256').update(bytes).digest('hex');
        aggregate.update(`F\0${name}\0${bytes.length}\0${digest}\0${'0555'}\0`);
        legacyBytes.set(name, bytes);
        legacyFiles.push({ name, bytes: bytes.length, sha256: digest, mode: '0555' });
      }
      const legacyDigest = aggregate.digest('hex');
      const legacyManifest = Buffer.from(`${JSON.stringify({
        protocol: STAGING_HELPER_PROTOCOL,
        bundleDigest: legacyDigest,
        files: legacyFiles,
      }, null, 2)}\n`);
      const generationRoot = path.join(installRoot, 'generations', legacyDigest);
      await fs.mkdir(generationRoot, { mode: 0o755 });
      for (const [name, bytes] of legacyBytes) {
        const destination = path.join(generationRoot, name);
        await fs.writeFile(destination, bytes, { mode: 0o555 });
        await fs.chmod(destination, 0o555);
      }
      const manifestPath = path.join(generationRoot, 'staging-release-bundle.json');
      await fs.writeFile(manifestPath, legacyManifest, { mode: 0o444 });
      await fs.chmod(manifestPath, 0o444);
      await fs.chmod(generationRoot, 0o555);

      assert.deepEqual((await fs.readdir(generationRoot)).sort(),
        [...HELPER_BUNDLE_FILES, 'staging-release-bundle.json'].sort());
      await verifyInstalledHelperGeneration({
        generationDirectory: generationRoot,
        expectedDigest: legacyDigest,
      });
      const recovery = spawnSync(gitBash, [
        '-p', posixPath(path.join(linkRoot, 'easyboost-staging-recover')),
        'restart', legacyDigest,
      ], {
        encoding: 'utf8',
        env: {
          ...process.env,
          EASYBOOST_TEST_LEGACY_V4_CHILD: path.join(generationRoot,
            'staging-command-supervisor.js'),
          EASYBOOST_TEST_LEGACY_V4_MARKER: marker,
          NODE_OPTIONS: '--require=must-be-discarded-before-legacy-loader',
        },
      });
      if (recovery.error?.code === 'ENOENT') return context.skip('Git Bash is not installed');
      assert.equal(recovery.status, 0, `${recovery.stdout}\n${recovery.stderr}`);
      assert.equal(await fs.readFile(marker, 'utf8'), 'nested');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

test('v4 helper installation rejects sync failures before current advances', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-helper-sync-failure-'));
  const source = path.join(root, 'source');
  const installRoot = path.join(root, 'lib');
  const linkRoot = path.join(root, 'bin');
  try {
    await copyBundleSource(source);
    const generationA = await installStagingHelperBundle({
      sourceDirectory: source, installRoot, linkRoot, allowedPrefix: root,
    });
    await fs.appendFile(path.join(source, 'staging-release-common.sh'),
      '\n# generation B before parent sync failure\n');
    const generationB = captureHelperBundle({ sourceDirectory: source });
    await assert.rejects(installStagingHelperBundle({
      sourceDirectory: source,
      installRoot,
      linkRoot,
      allowedPrefix: root,
      operations: {
        syncDirectory: async (directory) => {
          if (directory === path.join(installRoot, 'generations')) {
            throw new Error('injected generations parent sync failure');
          }
        },
      },
    }), /injected generations parent sync failure/u);
    assert.equal(await fs.readFile(path.join(installRoot, 'current'), 'utf8'),
      `${generationA.bundleDigest}\n`);
    await verifyInstalledHelperGeneration({
      generationDirectory: path.join(installRoot, 'generations', generationB.bundleDigest),
      expectedDigest: generationB.bundleDigest,
    });

    const retryDirectorySyncs = [];
    const installedB = await installStagingHelperBundle({
      sourceDirectory: source,
      installRoot,
      linkRoot,
      allowedPrefix: root,
      operations: {
        syncDirectory: async (directory) => retryDirectorySyncs.push(directory),
      },
    });
    assert.equal(installedB.bundleDigest, generationB.bundleDigest);
    assert.ok(retryDirectorySyncs.includes(path.join(installRoot, 'generations')),
      'retry must durably adopt a generation left visible by a failed parent sync');
    await fs.appendFile(path.join(source, 'staging-release-common.sh'),
      '\n# generation C before launcher file sync failure\n');
    await assert.rejects(installStagingHelperBundle({
      sourceDirectory: source,
      installRoot,
      linkRoot,
      allowedPrefix: root,
      operations: {
        syncFile: async (file) => {
          if (path.basename(file).startsWith('staging-release-entry.sh.new.')) {
            throw new Error('injected launcher file sync failure');
          }
        },
      },
    }), /injected launcher file sync failure/u);
    assert.equal(await fs.readFile(path.join(installRoot, 'current'), 'utf8'),
      `${generationB.bundleDigest}\n`);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('v4 bundle pointer swap failure preserves the prior generation and tampering fails closed', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-helper-pointer-'));
  const source = path.join(root, 'source');
  const installRoot = path.join(root, 'lib');
  const linkRoot = path.join(root, 'bin');
  try {
    await copyBundleSource(source);
    const first = await installStagingHelperBundle({
      sourceDirectory: source, installRoot, linkRoot, allowedPrefix: root,
    });
    await fs.appendFile(path.join(source, 'staging-release-common.sh'), '\n# v4 generation B\n');
    const secondSource = captureHelperBundle({ sourceDirectory: source });
    const operations = {
      chmod: fs.chmod.bind(fs),
      rename: async (from, to) => {
        if (to === path.join(installRoot, 'current')) throw new Error('injected current swap failure');
        return fs.rename(from, to);
      },
      rm: fs.rm.bind(fs),
      writeFile: fs.writeFile.bind(fs),
    };
    await assert.rejects(
      installStagingHelperBundle({
        sourceDirectory: source, installRoot, linkRoot, allowedPrefix: root, operations,
      }),
      /injected current swap failure/u,
    );
    assert.equal(await fs.readFile(path.join(installRoot, 'current'), 'utf8'),
      `${first.bundleDigest}\n`);
    await verifyInstalledHelperGeneration({
      generationDirectory: path.join(installRoot, 'generations', secondSource.bundleDigest),
      expectedDigest: secondSource.bundleDigest,
    });

    await fs.chmod(path.join(installRoot, 'current'), 0o600);
    await fs.writeFile(path.join(installRoot, 'current'), `${secondSource.bundleDigest}\nextra\n`);
    const invocation = spawnSync(gitBash, [
      posixPath(path.join(linkRoot, 'easyboost-staging-deploy')),
      '/missing-release.tar.gz', 'a'.repeat(64), STAGING_HELPER_PROTOCOL, secondSource.bundleDigest,
    ], { encoding: 'utf8' });
    if (invocation.error?.code !== 'ENOENT') {
      assert.equal(invocation.status, 69, `${invocation.stdout}\n${invocation.stderr}`);
      assert.match(invocation.stderr, /pointer/iu);
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('partial, mixed or linked helper generations fail closed without changing current', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-helper-mixed-'));
  const source = path.join(root, 'source');
  const installRoot = path.join(root, 'lib');
  const linkRoot = path.join(root, 'bin');
  try {
    await copyBundleSource(source);
    const installed = await installStagingHelperBundle({
      sourceDirectory: source, installRoot, linkRoot, allowedPrefix: root,
    });
    const pointerBefore = await fs.readFile(path.join(installRoot, 'current'), 'utf8');
    await fs.chmod(path.join(installRoot, 'generations', installed.bundleDigest), 0o755);
    await fs.chmod(path.join(installRoot, 'generations', installed.bundleDigest,
      'staging-release-common.sh'), 0o644);
    await fs.appendFile(path.join(installRoot, 'generations', installed.bundleDigest,
      'staging-release-common.sh'), '\n# corruption\n');
    await assert.rejects(
      installStagingHelperBundle({
        sourceDirectory: source, installRoot, linkRoot, allowedPrefix: root,
      }),
      /generation.*(?:changed|digest|invalid)/iu,
    );
    assert.equal(await fs.readFile(path.join(installRoot, 'current'), 'utf8'), pointerBefore);

    if (process.platform !== 'win32') {
      await fs.rm(path.join(source, 'staging-rollback.sh'));
      await fs.symlink(path.resolve('scripts/staging-rollback.sh'),
        path.join(source, 'staging-rollback.sh'));
      assert.throws(() => captureHelperBundle({ sourceDirectory: source }), /symlink|regular/iu);
      const linkedSource = path.join(root, 'linked-source');
      await fs.symlink(source, linkedSource, 'dir');
      assert.throws(() => captureHelperBundle({ sourceDirectory: linkedSource }),
        /source directory chain.*no-follow/iu);
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('bootstrap rejects prefix escapes, symlink aliases and overlapping roots before mutation',
  async (context) => {
    if (process.platform === 'win32') {
      return context.skip('POSIX bootstrap path authority executes on Linux');
    }
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-bootstrap-roots-'));
    context.after(() => fs.rm(root, { recursive: true, force: true }));
    const approvedPrefix = path.join(root, 'approved');
    const outside = path.join(root, 'outside');
    const aliasTarget = path.join(root, 'alias-target');
    const template = path.join(root, 'staging.env.example');
    await Promise.all([
      fs.mkdir(approvedPrefix), fs.mkdir(outside), fs.mkdir(aliasTarget),
      fs.writeFile(template, 'NODE_ENV=production\n'),
    ]);
    await fs.symlink(aliasTarget, path.join(approvedPrefix, 'linked-root'), 'dir');
    const cases = [
      {
        appRoot: path.join(outside, 'app'),
        installRoot: path.join(approvedPrefix, 'escape-lib'),
        label: 'approved-prefix escape',
        linkRoot: path.join(approvedPrefix, 'escape-bin'),
        untouched: path.join(outside, 'app'),
      },
      {
        appRoot: path.join(approvedPrefix, 'linked-root', 'app'),
        installRoot: path.join(approvedPrefix, 'linked-lib'),
        label: 'symlinked ancestor',
        linkRoot: path.join(approvedPrefix, 'linked-bin'),
        untouched: path.join(aliasTarget, 'app'),
      },
      {
        appRoot: path.join(approvedPrefix, 'overlap-app'),
        installRoot: path.join(approvedPrefix, 'overlap-app', 'helpers'),
        label: 'overlapping application and helper roots',
        linkRoot: path.join(approvedPrefix, 'overlap-bin'),
        untouched: path.join(approvedPrefix, 'overlap-app'),
      },
    ];
    for (const scenario of cases) {
      const invocation = spawnSync(gitBash, [posixPath(bootstrapScript)], {
        encoding: 'utf8',
        env: {
          ...process.env,
          STAGING_APP_DIR: posixPath(scenario.appRoot),
          STAGING_BOOTSTRAP_ALLOWED_PREFIX: posixPath(approvedPrefix),
          STAGING_ENV_TEMPLATE: posixPath(template),
          STAGING_HELPER_INSTALL_ROOT: posixPath(scenario.installRoot),
          STAGING_HELPER_LINK_ROOT: posixPath(scenario.linkRoot),
          EASYBOOST_HOST_OPERATION_LOCK_DIR: posixPath(path.join(
            approvedPrefix, 'host-operations', 'host-operation.lock',
          )),
          EASYBOOST_HOST_OPERATION_OWNER_UID: String(process.getuid()),
          EASYBOOST_HOST_OPERATION_OWNER_GID: String(process.getgid()),
        },
      });
      assert.equal(invocation.status, 64,
        `${scenario.label}: ${invocation.stdout}\n${invocation.stderr}`);
      await assert.rejects(fs.access(scenario.untouched), { code: 'ENOENT' }, scenario.label);
    }
  });

test('first-setup executable creates the private staging roots and installs one v4 bundle',
  async (context) => {
    if (process.platform === 'win32') {
      return context.skip('POSIX ownership and private-mode bootstrap executes on Linux');
    }
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-staging-bootstrap-'));
    context.after(() => fs.rm(root, { recursive: true, force: true }));
    const appRoot = path.join(root, 'app');
    const installRoot = path.join(root, 'lib');
    const linkRoot = path.join(root, 'bin');
    const template = path.join(root, 'staging.env.example');
    const hostLockDirectory = path.join(root, 'host-operations', 'host-operation.lock');
    const templateBytes = Buffer.from('NODE_ENV=production\nAPP_PORT=3001\n');
    await fs.writeFile(template, templateBytes);
    const invocation = spawnSync(gitBash, [posixPath(bootstrapScript)], {
      encoding: 'utf8',
      env: {
        ...process.env,
        STAGING_APP_DIR: posixPath(appRoot),
        STAGING_BOOTSTRAP_ALLOWED_PREFIX: posixPath(root),
        STAGING_ENV_TEMPLATE: posixPath(template),
        STAGING_HELPER_INSTALL_ROOT: posixPath(installRoot),
        STAGING_HELPER_LINK_ROOT: posixPath(linkRoot),
        EASYBOOST_HOST_OPERATION_LOCK_DIR: posixPath(hostLockDirectory),
        EASYBOOST_HOST_OPERATION_OWNER_UID: String(process.getuid()),
        EASYBOOST_HOST_OPERATION_OWNER_GID: String(process.getgid()),
      },
    });
    if (invocation.error?.code === 'ENOENT') return context.skip('Git Bash is not installed');
    assert.equal(invocation.status, 0, `${invocation.stdout}\n${invocation.stderr}`);
    for (const directory of [
      appRoot, path.join(appRoot, 'backups'), path.join(appRoot, 'rollbacks'),
      path.join(appRoot, 'rollbacks', 'releases'),
    ]) assert.equal((await fs.lstat(directory)).isDirectory(), true, directory);
    assert.deepEqual(await fs.readFile(path.join(appRoot, '.env.staging')), templateBytes);
    const captured = captureHelperBundle({ sourceDirectory: path.resolve('scripts') });
    assert.equal(await fs.readFile(path.join(installRoot, 'current'), 'utf8'),
      `${captured.bundleDigest}\n`);
    await verifyInstalledHelperGeneration({
      generationDirectory: path.join(installRoot, 'generations', captured.bundleDigest),
      expectedDigest: captured.bundleDigest,
    });
    assert.equal((await fs.stat(path.dirname(hostLockDirectory)).then(
      (entry) => entry.mode & 0o777,
    )), 0o750, 'bootstrap must create an owner-writable parent with the exact shared mode');
    await assert.rejects(fs.access(hostLockDirectory), { code: 'ENOENT' },
      'bootstrap must not pre-create the atomic lock directory itself');

    await fs.writeFile(path.join(appRoot, '.env.staging'), 'CUSTOM_FLAG=preserved\n');
    const repeated = spawnSync(gitBash, [posixPath(bootstrapScript)], {
      encoding: 'utf8',
      env: {
        ...process.env,
        STAGING_APP_DIR: posixPath(appRoot),
        STAGING_BOOTSTRAP_ALLOWED_PREFIX: posixPath(root),
        STAGING_ENV_TEMPLATE: posixPath(template),
        STAGING_HELPER_INSTALL_ROOT: posixPath(installRoot),
        STAGING_HELPER_LINK_ROOT: posixPath(linkRoot),
        EASYBOOST_HOST_OPERATION_LOCK_DIR: posixPath(hostLockDirectory),
        EASYBOOST_HOST_OPERATION_OWNER_UID: String(process.getuid()),
        EASYBOOST_HOST_OPERATION_OWNER_GID: String(process.getgid()),
      },
    });
    assert.equal(repeated.status, 0, `${repeated.stdout}\n${repeated.stderr}`);
    assert.equal(await fs.readFile(path.join(appRoot, '.env.staging'), 'utf8'),
      'CUSTOM_FLAG=preserved\n', 'idempotent setup must not overwrite staging configuration');
  });
