import crypto from 'node:crypto';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function posixPath(value) {
  return value.split(path.sep).join('/');
}

function digest(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function statIdentity(stat) {
  return ['dev', 'ino', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs']
    .map((key) => String(stat[key])).join(':');
}

function snapshotTree(directory, prefix = '', snapshot = {
  directories: new Map(), files: new Map(),
}) {
  const directoryStat = fs.lstatSync(directory, { bigint: true });
  if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
    throw new Error(`${prefix || '.'}: release artifact directory must be a real directory`);
  }
  snapshot.directories.set(prefix, statIdentity(directoryStat));
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name, 'en'))) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolute = path.join(directory, entry.name);
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) throw new Error(`${name}: release artifact symlink is forbidden`);
    if (stat.isDirectory()) snapshotTree(absolute, name, snapshot);
    else if (stat.isFile()) snapshot.files.set(name, statIdentity(
      fs.lstatSync(absolute, { bigint: true }),
    ));
    else throw new Error(`${name}: unsupported release artifact entry`);
  }
  return snapshot;
}

function assertSameSnapshot(expected, actual) {
  for (const kind of ['directories', 'files']) {
    const expectedEntries = [...expected[kind].entries()];
    const actualEntries = [...actual[kind].entries()];
    if (JSON.stringify(actualEntries) !== JSON.stringify(expectedEntries)) {
      const expectedNames = new Set(expected[kind].keys());
      const changed = actualEntries.find(([name, identity]) => (
        !expectedNames.has(name) || expected[kind].get(name) !== identity
      ))?.[0] ?? expectedEntries.find(([name]) => !actual[kind].has(name))?.[0] ?? '.';
      throw new Error(`${changed}: release artifact inventory changed during verification`);
    }
  }
}

function readRegularFile(publicDirectory, name, expectedIdentity) {
  const absolute = path.join(publicDirectory, ...name.split('/'));
  let before;
  try {
    before = fs.lstatSync(absolute, { bigint: true });
  } catch {
    throw new Error(`${name}: release artifact file missing`);
  }
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error(`${name}: release artifact entry must be a regular file`);
  }
  if (expectedIdentity && statIdentity(before) !== expectedIdentity) {
    throw new Error(`${name}: release artifact identity changed during verification`);
  }
  const descriptor = fs.openSync(
    absolute,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
  );
  try {
    const opened = fs.fstatSync(descriptor, { bigint: true });
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor, { bigint: true });
    const finalPath = fs.lstatSync(absolute, { bigint: true });
    const openedIdentity = statIdentity(opened);
    const same = openedIdentity === statIdentity(before)
      && statIdentity(after) === openedIdentity
      && statIdentity(finalPath) === openedIdentity;
    if (!same || BigInt(bytes.length) !== opened.size) {
      throw new Error(`${name}: release artifact changed during verification`);
    }
    return bytes;
  } finally {
    fs.closeSync(descriptor);
  }
}

export async function verifyReleaseArtifact({
  publicDirectory = fileURLToPath(new URL('../dist/public', import.meta.url)),
} = {}) {
  const manifestName = 'asset-manifest.json';
  const initialSnapshot = snapshotTree(publicDirectory);
  const manifestIdentity = initialSnapshot.files.get(manifestName);
  if (!manifestIdentity) throw new Error(`${manifestName}: release artifact file missing`);
  const manifestBytes = readRegularFile(publicDirectory, manifestName, manifestIdentity);
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString('utf8'));
  } catch {
    throw new Error(`${manifestName}: release artifact authority is not valid JSON`);
  }
  if (manifest.generatedBy !== 'npm run build:frontend'
      || !/^sha256-[a-f0-9]{64}$/u.test(manifest.releaseVersion ?? '')
      || !manifest.assets || typeof manifest.assets !== 'object' || Array.isArray(manifest.assets)) {
    throw new Error(`${manifestName}: invalid release artifact authority contract`);
  }

  const declared = Object.keys(manifest.assets).sort();
  const actual = [...initialSnapshot.files.keys()]
    .filter((name) => name !== manifestName).sort();
  const declaredSet = new Set(declared);
  for (const name of actual) {
    if (!declaredSet.has(name)) throw new Error(`${name}: release artifact file is undeclared`);
  }
  const actualSet = new Set(actual);
  for (const name of declared) {
    if (!actualSet.has(name)) throw new Error(`${name}: release artifact file missing`);
  }

  const aggregate = crypto.createHash('sha256');
  aggregate.update('aisy-release-artifact-v1\0');
  let totalBytes = 0;
  const verified = new Map([[manifestName, {
    bytes: manifestBytes.length, identity: manifestIdentity, sha256: digest(manifestBytes),
  }]]);
  for (const name of declared) {
    if (name !== posixPath(name) || name.startsWith('/') || name.split('/').includes('..')) {
      throw new Error(`${name}: invalid release artifact path`);
    }
    const fileIdentity = initialSnapshot.files.get(name);
    const bytes = readRegularFile(publicDirectory, name, fileIdentity);
    const sha256 = digest(bytes);
    const record = manifest.assets[name];
    if (!record || record.bytes !== bytes.length || record.sha256 !== sha256) {
      throw new Error(`${name}: release artifact bytes/digest mismatch`);
    }
    aggregate.update(`F\0${name}\0${bytes.length}\0${sha256}\0`);
    totalBytes += bytes.length;
    verified.set(name, { bytes: bytes.length, identity: fileIdentity, sha256 });
  }
  assertSameSnapshot(initialSnapshot, snapshotTree(publicDirectory));
  for (const [name, record] of verified) {
    const bytes = readRegularFile(publicDirectory, name, record.identity);
    if (bytes.length !== record.bytes || digest(bytes) !== record.sha256) {
      throw new Error(`${name}: release artifact changed during final verification`);
    }
  }
  assertSameSnapshot(initialSnapshot, snapshotTree(publicDirectory));
  const manifestSha256 = digest(manifestBytes);
  aggregate.update(`M\0${manifestName}\0${manifestBytes.length}\0${manifestSha256}\0`);
  return {
    aggregateSha256: aggregate.digest('hex'),
    assets: declared.length,
    bytes: totalBytes + manifestBytes.length,
    files: declared.length + 1,
    releaseVersion: manifest.releaseVersion,
  };
}

async function pathExists(file, operations) {
  try {
    await operations.lstat(file);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function sameVerifiedArtifact(left, right) {
  return ['aggregateSha256', 'assets', 'bytes', 'files', 'releaseVersion']
    .every((name) => left[name] === right[name]);
}

export async function publishReleaseArtifact({
  stagingDirectory,
  publicDirectory,
  verify = verifyReleaseArtifact,
  operations = fsPromises,
} = {}) {
  const staging = path.resolve(stagingDirectory);
  const target = path.resolve(publicDirectory);
  if (staging === target || path.dirname(staging) !== path.dirname(target)) {
    throw new Error('Release artifact staging and public directories must be distinct siblings');
  }
  const recovery = `${target}.previous`;
  const rejected = `${target}.rejected`;
  const verifyAt = (directory) => verify({ publicDirectory: directory });

  const stagedArtifact = await verifyAt(staging);
  await operations.rm(rejected, { recursive: true, force: true });

  if (await pathExists(recovery, operations)) {
    if (await pathExists(target, operations)) {
      try {
        await verifyAt(target);
        await operations.rm(recovery, { recursive: true, force: true });
      } catch {
        await operations.rename(target, rejected);
        await operations.rename(recovery, target);
        await verifyAt(target);
        await operations.rm(rejected, { recursive: true, force: true });
      }
    } else {
      await operations.rename(recovery, target);
      await verifyAt(target);
    }
  }

  const hadPrevious = await pathExists(target, operations);
  if (hadPrevious) await verifyAt(target);
  if (hadPrevious) await operations.rename(target, recovery);
  let candidatePublished = false;
  let candidateCommitted = false;
  try {
    await operations.rename(staging, target);
    candidatePublished = true;
    const publishedArtifact = await verifyAt(target);
    if (!sameVerifiedArtifact(stagedArtifact, publishedArtifact)) {
      throw new Error('Published release artifact differs from verified staging generation');
    }
    candidateCommitted = true;
    if (hadPrevious) await operations.rm(recovery, { recursive: true, force: true });
    return publishedArtifact;
  } catch (primaryError) {
    // Post-verification is the publication commit point. A partial retirement failure can make
    // the previous generation untrustworthy, so it must never displace the verified candidate.
    if (candidateCommitted) throw primaryError;
    try {
      if (candidatePublished && await pathExists(target, operations)) {
        await operations.rename(target, rejected);
      }
      if (hadPrevious) {
        await operations.rename(recovery, target);
        await verifyAt(target);
      } else if (candidatePublished && await pathExists(rejected, operations)) {
        await operations.rm(rejected, { recursive: true, force: true });
      }
      await operations.rm(rejected, { recursive: true, force: true });
    } catch (recoveryError) {
      throw new AggregateError(
        [primaryError, recoveryError],
        'Release artifact publication and previous-generation recovery both failed',
      );
    }
    throw primaryError;
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    const result = await verifyReleaseArtifact();
    console.log(`Release artifact verified (${result.assets} assets; ${result.aggregateSha256}).`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
