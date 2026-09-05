import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  HELPER_BUNDLE_FILES,
  STAGING_QUIESCENT_MAINTENANCE_LOCK_NAME,
  captureHelperBundle,
} from '../scripts/staging-helper-bundle.js';

const installerSource = path.resolve('scripts/install-staging-release-helpers.sh');
const LINUX = process.platform === 'linux';

async function copyBundleSource(destination) {
  await fs.mkdir(destination, { recursive: true });
  await Promise.all(HELPER_BUNDLE_FILES.map((name) => (
    fs.copyFile(path.resolve('scripts', name), path.join(destination, name))
  )));
  const source = await fs.readFile(installerSource, 'utf8');
  const fixtureSource = source.replace(
    "PATH='/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'",
    'PATH="${EASYBOOST_TEST_INSTALLER_NODE_DIRECTORY}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"',
  );
  assert.notEqual(fixtureSource, source, 'fixture installer must select its private safe Node');
  await fs.writeFile(path.join(destination, path.basename(installerSource)), fixtureSource);
}

async function makeWritable(candidate) {
  const identity = await fs.lstat(candidate).catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (identity === null || identity.isSymbolicLink()) return;
  if (identity.isDirectory()) {
    await fs.chmod(candidate, 0o700);
    for (const name of await fs.readdir(candidate)) {
      await makeWritable(path.join(candidate, name));
    }
  } else {
    await fs.chmod(candidate, 0o600);
  }
}

async function removeFixture(root) {
  await makeWritable(root);
  await fs.rm(root, { force: true, recursive: true });
}

async function durableReplace(destination, bytes) {
  const temporary = `${destination}.tmp.${process.pid}`;
  const descriptor = await fs.open(temporary, 'wx', 0o600);
  try {
    await descriptor.writeFile(bytes);
    await descriptor.sync();
  } finally {
    await descriptor.close();
  }
  await fs.rename(temporary, destination);
  const parent = await fs.open(path.dirname(destination), 'r');
  try {
    await parent.sync();
  } finally {
    await parent.close();
  }
}

function waitForLine(stream, expected) {
  return new Promise((resolve, reject) => {
    let buffered = '';
    const timeout = setTimeout(() => reject(new Error(`timed out waiting for ${expected}`)), 5_000);
    const onData = (chunk) => {
      buffered += chunk;
      const newline = buffered.indexOf('\n');
      if (newline < 0) return;
      const line = buffered.slice(0, newline);
      clearTimeout(timeout);
      stream.off('data', onData);
      if (line === expected) resolve();
      else reject(new Error(`unexpected holder output: ${line}`));
    };
    stream.on('data', onData);
    stream.once('error', reject);
  });
}

function runInstaller(installer, environment) {
  return spawnSync('/bin/bash', ['--noprofile', '--norc', installer], {
    encoding: 'utf8',
    env: environment,
  });
}

test('helper installer binds fd8 before generation publication and checks cutover residue',
  async () => {
    const source = await fs.readFile(installerSource, 'utf8');
    const maintenanceOpen = source.indexOf('exec 8<> "$maintenance_lock"');
    const maintenanceFlock = source.indexOf('flock -n 8');
    const journalTemporaryScan = source.indexOf("cutover_temporary_scan=''");
    const journalCheck = source.indexOf('if [ -e "$cutover_journal" ]');
    const hostLockCheck = source.indexOf("cutover_lock_namespace_scan=''");
    const installation = source.lastIndexOf(
      'node "$source_dir/staging-helper-bundle.js" install',
    );
    assert.ok(maintenanceOpen >= 0, 'installer must bind the canonical maintenance inode as fd8');
    assert.ok(maintenanceOpen < maintenanceFlock, 'fd8 must be open before flock');
    assert.ok(maintenanceFlock < journalTemporaryScan
      && journalTemporaryScan < journalCheck,
      'cutover residue must be checked while the maintenance flock is held');
    assert.match(source, /\.staging-recovery-required\.cutover-/u,
      'installer must reserve the cutover pre-journal prefix');
    assert.match(source, /entry\.name\.startsWith\(reservedPrefix\)/u,
      'installer must inventory the reserved prefix without newline-sensitive regex');
    assert.match(source, /entry\.name\.endsWith\(reservedSuffix\)/u,
      'installer must reserve the whole pre-journal suffix without newline-sensitive regex');
    assert.match(source,
      /O_RDONLY \| fs\.constants\.O_DIRECTORY \| fs\.constants\.O_NOFOLLOW/u,
      'installer must bind the app root through a no-follow directory descriptor');
    assert.match(source, /`\/proc\/self\/fd\/\$\{rootDescriptor\}`/u,
      'installer inventory must remain anchored to the opened app-root descriptor');
    assert.match(source,
      /rootIdentity[^]*openedRoot[^]*rootAfterOpen[^]*rootAfterInventory[^]*descriptorAfterInventory/u,
      'installer must prove the app-root identity before, during, and after inventory');
    assert.ok(journalCheck < hostLockCheck && hostLockCheck < installation,
      'both cutover authorities must block before helper generation publication');
    assert.match(source,
      /host-operation parent[^]*O_RDONLY \| fs\.constants\.O_DIRECTORY \| fs\.constants\.O_NOFOLLOW[^]*`\/proc\/self\/fd\/\$\{descriptor\}`/u,
      'installer must inventory the entire cutover lease namespace through a bound parent descriptor');
    assert.match(source, /\.released\.tombstone/u,
      'installer must document why a completed cutover tombstone is not active cutover residue');
    assert.match(source,
      /current_present[^]*maintenance_present[^]*Installed staging helper current pointer has no maintenance lock/u,
      'an installed current pointer may not silently fall back to an unlocked installer');
  });

test('crashed cutover A prevents helper B installation both before and after fd8 release', {
  skip: !LINUX,
}, async (context) => {
  if (spawnSync('/usr/bin/python3', ['--version']).status !== 0
      || spawnSync('/bin/bash', ['--version']).status !== 0
      || spawnSync('flock', ['--version']).status !== 0) {
    return context.skip('Linux installer prerequisites are unavailable');
  }

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-helper-install-cutover-'));
  const appRoot = path.join(root, 'app');
  const installRoot = path.join(root, 'lib');
  const linkRoot = path.join(root, 'bin');
  const sourceA = path.join(root, 'source-a');
  const sourceB = path.join(root, 'source-b');
  const nodeDirectory = path.join(root, 'node-authority');
  const nodeExecutable = path.join(nodeDirectory, 'node');
  const hostLock = path.join(root, 'host-operations', 'host-operation.lock');
  let holder;
  try {
    await fs.mkdir(appRoot, { mode: 0o700 });
    await fs.mkdir(nodeDirectory, { mode: 0o755 });
    await fs.copyFile(process.execPath, nodeExecutable);
    await fs.chmod(nodeDirectory, 0o755);
    await fs.chmod(nodeExecutable, 0o755);
    await copyBundleSource(sourceA);
    await copyBundleSource(sourceB);
    const bundleA = captureHelperBundle({ sourceDirectory: sourceA });
    await fs.appendFile(path.join(sourceB, 'staging-restart-app.sh'),
      '\n# distinct helper B fixture\n');
    const bundleB = captureHelperBundle({ sourceDirectory: sourceB });
    assert.notEqual(bundleB.bundleDigest, bundleA.bundleDigest);

    const environment = {
      ...process.env,
      EASYBOOST_HOST_OPERATION_LOCK_DIR: hostLock,
      EASYBOOST_TEST_INSTALLER_NODE_DIRECTORY: nodeDirectory,
      STAGING_APP_DIR: appRoot,
      STAGING_HELPER_ALLOWED_PREFIX: root,
      STAGING_HELPER_INSTALL_ROOT: installRoot,
      STAGING_HELPER_LINK_ROOT: linkRoot,
    };
    const installed = spawnSync(nodeExecutable, [
      path.join(sourceA, 'staging-helper-bundle.js'), 'install', sourceA, installRoot, linkRoot,
    ], {
      encoding: 'utf8',
      env: environment,
    });
    assert.equal(installed.status, 0, `${installed.stdout}\n${installed.stderr}`);
    const current = path.join(installRoot, 'current');
    const maintenance = path.join(installRoot, STAGING_QUIESCENT_MAINTENANCE_LOCK_NAME);
    assert.equal(await fs.readFile(current, 'utf8'), `${bundleA.bundleDigest}\n`);

    holder = spawn('/bin/bash', [
      '--noprofile', '--norc', '-c', [
        'set -euo pipefail',
        'exec 8<> "$1"',
        'flock -n 8',
        'printf "LOCKED\\n"',
        'IFS= read -r _',
      ].join('\n'),
      'cutover-a-holder', maintenance,
    ], { stdio: ['pipe', 'pipe', 'pipe'] });
    await waitForLine(holder.stdout, 'LOCKED');

    const journal = path.join(appRoot, '.staging-recovery-required');
    const sha = (character) => character.repeat(64);
    await durableReplace(journal, Buffer.from([
      'protocol=easyboost-staging-cutover-v1',
      `bridgeSha256=${sha('1')}`,
      `legacyMarkerSha256=${sha('2')}`,
      `legacyComposeSha256=${sha('3')}`,
      `bundleSha256=${bundleA.bundleDigest}`,
      `nonce=${sha('4')}`,
      '',
    ].join('\n')));

    const installerB = path.join(sourceB, path.basename(installerSource));
    const whileLive = runInstaller(installerB, environment);
    assert.equal(whileLive.status, 75, `${whileLive.stdout}\n${whileLive.stderr}`);
    assert.match(whileLive.stderr, /Another staging helper transaction is active/u);
    assert.equal(await fs.readFile(current, 'utf8'), `${bundleA.bundleDigest}\n`);

    holder.kill('SIGKILL');
    await new Promise((resolve) => holder.once('exit', resolve));
    holder = undefined;

    const afterCrash = runInstaller(installerB, environment);
    assert.equal(afterCrash.status, 75, `${afterCrash.stdout}\n${afterCrash.stderr}`);
    assert.match(afterCrash.stderr, /active cutover journal/u);
    assert.equal(await fs.readFile(current, 'utf8'), `${bundleA.bundleDigest}\n`);
    await assert.rejects(
      fs.access(path.join(installRoot, 'generations', bundleB.bundleDigest)),
      { code: 'ENOENT' },
      'helper B generation must not be published while cutover A is recoverable',
    );

    await fs.rm(journal);
    const journalTemporary = `${journal}.cutover-${sha('4')}.preparing`;
    await durableReplace(journalTemporary,
      Buffer.from('protocol=easyboost-staging-cutover-v1\nbridgeSha256='));
    const afterPreJournalCrash = runInstaller(installerB, environment);
    assert.equal(afterPreJournalCrash.status, 75,
      `${afterPreJournalCrash.stdout}\n${afterPreJournalCrash.stderr}`);
    assert.match(afterPreJournalCrash.stderr, /active cutover journal temporary/u);
    assert.equal(await fs.readFile(current, 'utf8'), `${bundleA.bundleDigest}\n`);
    await assert.rejects(
      fs.access(path.join(installRoot, 'generations', bundleB.bundleDigest)),
      { code: 'ENOENT' },
      'helper B generation must not be published while cutover A has only its journal temporary',
    );

    await fs.rm(journalTemporary);
    const malformedTemporary = `${journal}.cutover-not-a-nonce.preparing`;
    await durableReplace(malformedTemporary, Buffer.alloc(0));
    const malformedResidue = runInstaller(installerB, environment);
    assert.equal(malformedResidue.status, 75,
      `${malformedResidue.stdout}\n${malformedResidue.stderr}`);
    assert.match(malformedResidue.stderr, /unsafe cutover journal temporary namespace/u);
    assert.equal(await fs.readFile(current, 'utf8'), `${bundleA.bundleDigest}\n`);
    await fs.rm(malformedTemporary);

    const newlineTemporary = `${journal}.cutover-${sha('4')}\nshadow.preparing`;
    await durableReplace(newlineTemporary, Buffer.alloc(0));
    const newlineResidue = runInstaller(installerB, environment);
    assert.equal(newlineResidue.status, 75,
      `${newlineResidue.stdout}\n${newlineResidue.stderr}`);
    assert.match(newlineResidue.stderr, /unsafe cutover journal temporary namespace/u);
    assert.equal(await fs.readFile(current, 'utf8'), `${bundleA.bundleDigest}\n`);
    await fs.rm(newlineTemporary);

    await fs.symlink('missing-pre-journal-target', journalTemporary);
    const unsafeResidue = runInstaller(installerB, environment);
    assert.equal(unsafeResidue.status, 75,
      `${unsafeResidue.stdout}\n${unsafeResidue.stderr}`);
    assert.match(unsafeResidue.stderr, /unsafe cutover journal temporary namespace/u);
    assert.equal(await fs.readFile(current, 'utf8'), `${bundleA.bundleDigest}\n`);
    await fs.rm(journalTemporary);

    await durableReplace(journalTemporary,
      Buffer.from('protocol=easyboost-staging-cutover-v1\nbridgeSha256='));
    const swapInstaller = path.join(sourceB, 'install-staging-release-helpers-swap.sh');
    const installerBytes = await fs.readFile(installerB, 'utf8');
    const hookNeedle = 'const afterPhase = (_phase) => {};';
    assert.ok(installerBytes.includes(hookNeedle), 'installer scan phase seam is unavailable');
    await fs.writeFile(swapInstaller, installerBytes.replace(hookNeedle, [
      'const afterPhase = (phase) => {',
      '  if (phase !== "after-root-open") return;',
      '  fs.renameSync(root, `${root}.descriptor-scan-original`);',
      '  fs.mkdirSync(root, { mode: 0o700 });',
      '};',
    ].join('\n')), { mode: 0o700 });
    const swappedRoot = runInstaller(swapInstaller, environment);
    assert.equal(swappedRoot.status, 69,
      `${swappedRoot.stdout}\n${swappedRoot.stderr}`);
    assert.match(swappedRoot.stderr,
      /could not safely inventory cutover journal temporaries/u);
    assert.equal(await fs.readFile(current, 'utf8'), `${bundleA.bundleDigest}\n`);
    await fs.rm(appRoot, { recursive: true });
    await fs.rename(`${appRoot}.descriptor-scan-original`, appRoot);
    await fs.rm(journalTemporary);

    await fs.mkdir(path.dirname(hostLock), { recursive: true, mode: 0o700 });
    await fs.mkdir(hostLock, { mode: 0o700 });
    const typedResidue = runInstaller(installerB, environment);
    assert.equal(typedResidue.status, 75, `${typedResidue.stdout}\n${typedResidue.stderr}`);
    assert.match(typedResidue.stderr, /active host-operation lock/u);
    assert.equal(await fs.readFile(current, 'utf8'), `${bundleA.bundleDigest}\n`);

    await fs.rm(hostLock, { recursive: true });
    const cutoverLeaseResidues = [
      `${hostLock}.preparing`,
      `${hostLock}.claim-${sha('6')}.preparing`,
    ];
    for (const residue of cutoverLeaseResidues) {
      await fs.mkdir(residue, { recursive: true, mode: 0o700 });
      const blocked = runInstaller(installerB, environment);
      assert.equal(blocked.status, 75, `${residue}: ${blocked.stdout}\n${blocked.stderr}`);
      assert.match(blocked.stderr, /active host-operation lock/u);
      assert.equal(await fs.readFile(current, 'utf8'), `${bundleA.bundleDigest}\n`);
      await fs.rm(residue, { recursive: true });
    }

    const malformedLeaseResidue = `${hostLock}.claim-not-a-digest.preparing`;
    await fs.mkdir(malformedLeaseResidue, { recursive: true, mode: 0o700 });
    const malformedLease = runInstaller(installerB, environment);
    assert.equal(malformedLease.status, 75,
      `${malformedLease.stdout}\n${malformedLease.stderr}`);
    assert.match(malformedLease.stderr, /unsafe host-operation lock namespace/u);
    await fs.rm(malformedLeaseResidue, { recursive: true });

    const releasedTombstone = `${hostLock}.released.tombstone`;
    await fs.mkdir(releasedTombstone, { recursive: true, mode: 0o700 });
    await durableReplace(journal, Buffer.from('cutover recovery still required\n'));
    const tombstoneWithJournal = runInstaller(installerB, environment);
    assert.equal(tombstoneWithJournal.status, 75,
      `${tombstoneWithJournal.stdout}\n${tombstoneWithJournal.stderr}`);
    assert.match(tombstoneWithJournal.stderr, /active cutover journal/u);
    assert.equal(await fs.readFile(current, 'utf8'), `${bundleA.bundleDigest}\n`);
    await fs.rm(journal);

    const completedCutover = runInstaller(installerB, environment);
    assert.equal(completedCutover.status, 0,
      `${completedCutover.stdout}\n${completedCutover.stderr}`);
    assert.equal(await fs.readFile(current, 'utf8'), `${bundleB.bundleDigest}\n`,
      'a completed cutover tombstone must not permanently block helper upgrades');
  } finally {
    if (holder && holder.exitCode === null && holder.signalCode === null) {
      holder.kill('SIGKILL');
      await new Promise((resolve) => holder.once('exit', resolve));
    }
    await removeFixture(root);
  }
});
