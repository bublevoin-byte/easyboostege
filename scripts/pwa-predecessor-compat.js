import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  consumePosixReleaseMaintenanceBinding,
  createPosixReleaseSessionControl,
  launchPosixReleaseMaintenanceBatch,
} from './posix-release-maintenance-scope.js';
import { runBoundedReleaseCommand } from './release-command-supervisor.js';

export const PREDECESSOR_COMMIT = 'd36724181ee04230c1a9709a9213bcd269092282';
export const COMPATIBILITY_SCHEMA = 'aisy-pwa-predecessor-compat-v1';
const SOURCE_COMMAND_TIMEOUT_MS = 2 * 60_000;
const FRONTEND_BUILD_TIMEOUT_MS = 10 * 60_000;
const PREDECESSOR_OUTPUT_LIMIT_BYTES = 4 * 1024 * 1024;

const scriptPath = fileURLToPath(import.meta.url);
const defaultProjectDirectory = path.resolve(path.dirname(scriptPath), '..');

export function compatibilityArtifactDirectory(projectDirectory, commit = PREDECESSOR_COMMIT) {
  if (!/^[a-f0-9]{40}$/u.test(commit)) throw new Error(`Invalid predecessor commit: ${commit}`);
  return path.join(path.resolve(projectDirectory), 'pwa-compat', commit);
}

function sha256(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function compatibilityDigest(files) {
  const digest = crypto.createHash('sha256');
  digest.update(`${COMPATIBILITY_SCHEMA}\0`);
  for (const file of files) {
    digest.update(file.path);
    digest.update('\0');
    digest.update(String(file.bytes));
    digest.update('\0');
    digest.update(file.sha256);
    digest.update('\0');
  }
  return digest.digest('hex');
}

function legacyCacheName(workerSource) {
  const declaration = workerSource.match(/const APP_SHELL=(\[[^\]]*\]);/u)?.[1];
  if (!declaration) throw new Error('Predecessor worker has no APP_SHELL declaration');
  const shell = JSON.parse(declaration.replaceAll("'", '"'));
  const suffix = shell.join('|').split('').reduce(
    (hash, character) => Math.imul(hash ^ character.charCodeAt(0), 16777619) >>> 0,
    2166136261,
  ).toString(36);
  return `easyboost-static-${suffix}`;
}

async function exactFixtureCompatibility(fixtureDirectory, commit) {
  const [assetManifest, workerSource] = await Promise.all([
    fs.readFile(path.join(fixtureDirectory, 'asset-manifest.json'), 'utf8').then(JSON.parse),
    fs.readFile(path.join(fixtureDirectory, 'service-worker.js'), 'utf8'),
  ]);
  const names = Object.keys(assetManifest.assets || {})
    .filter((name) => /^assets\/[^/]+\.(?:css|js)$/u.test(name))
    .sort();
  if (!names.includes(assetManifest.entry) || names.length < 20) {
    throw new Error('Exact predecessor build has an incomplete executable graph');
  }
  const files = [];
  for (const name of names) {
    const content = await fs.readFile(path.join(fixtureDirectory, name));
    files.push({ path: `/${name}`, bytes: content.length, sha256: sha256(content) });
  }
  return Object.freeze({
    schemaVersion: COMPATIBILITY_SCHEMA,
    baseCommit: commit,
    cacheName: legacyCacheName(workerSource),
    contentSha256: compatibilityDigest(files),
    files: Object.freeze(files.map((file) => Object.freeze(file))),
  });
}

function checkedCompatibilityPath(directory, webPath) {
  if (!/^\/assets\/[^/]+\.(?:css|js)$/u.test(webPath)) {
    throw new Error(`Predecessor compatibility path is not a bounded executable: ${webPath}`);
  }
  const target = path.resolve(directory, 'files', webPath.slice(1));
  const root = path.resolve(directory, 'files');
  const outside = path.relative(root, target);
  if (outside.startsWith('..') || path.isAbsolute(outside)) {
    throw new Error(`Predecessor compatibility path escapes artifact: ${webPath}`);
  }
  return target;
}

export async function verifyPredecessorCompatibility({ directory, expectedCommit = PREDECESSOR_COMMIT }) {
  const manifestPath = path.join(directory, 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  if (manifest.schemaVersion !== COMPATIBILITY_SCHEMA) throw new Error('Invalid predecessor compatibility schema');
  if (manifest.baseCommit !== expectedCommit) throw new Error('Predecessor compatibility commit mismatch');
  if (!/^easyboost-static-[a-z0-9]+$/u.test(manifest.cacheName || '')) {
    throw new Error('Invalid predecessor compatibility cache name');
  }
  if (!Array.isArray(manifest.files) || !manifest.files.length) {
    throw new Error('Predecessor compatibility contains no executable files');
  }
  const files = [...manifest.files].sort((first, second) => (
    first.path < second.path ? -1 : first.path > second.path ? 1 : 0
  ));
  if (JSON.stringify(files) !== JSON.stringify(manifest.files)) {
    throw new Error('Predecessor compatibility files must be sorted');
  }
  if (new Set(files.map((file) => file.path)).size !== files.length) {
    throw new Error('Predecessor compatibility contains duplicate paths');
  }
  for (const file of files) {
    if (!Number.isSafeInteger(file.bytes) || file.bytes <= 0 || !/^[a-f0-9]{64}$/u.test(file.sha256 || '')) {
      throw new Error(`Invalid predecessor compatibility digest record: ${file.path}`);
    }
    const content = await fs.readFile(checkedCompatibilityPath(directory, file.path));
    if (content.length !== file.bytes) throw new Error(`Predecessor compatibility bytes mismatch: ${file.path}`);
    if (sha256(content) !== file.sha256) throw new Error(`Predecessor compatibility sha256 mismatch: ${file.path}`);
  }
  if (manifest.contentSha256 !== compatibilityDigest(files)) {
    throw new Error('Predecessor compatibility content digest mismatch');
  }
  return Object.freeze({ ...manifest, files: Object.freeze(files.map((file) => Object.freeze({ ...file }))) });
}

export async function verifyPredecessorArtifactAgainstFixture({
  fixtureDirectory,
  artifactDirectory,
  expectedCommit = PREDECESSOR_COMMIT,
}) {
  const [artifact, exact] = await Promise.all([
    verifyPredecessorCompatibility({ directory: artifactDirectory, expectedCommit }),
    exactFixtureCompatibility(fixtureDirectory, expectedCommit),
  ]);
  for (const field of ['schemaVersion', 'baseCommit', 'cacheName', 'contentSha256']) {
    if (artifact[field] !== exact[field]) {
      throw new Error(`Predecessor compatibility provenance mismatch: ${field}`);
    }
  }
  if (JSON.stringify(artifact.files) !== JSON.stringify(exact.files)) {
    throw new Error('Predecessor compatibility provenance digest records mismatch');
  }
  let rawBytesCompared = 0;
  for (const file of exact.files) {
    const [fixtureBytes, artifactBytes] = await Promise.all([
      fs.readFile(path.join(fixtureDirectory, file.path.slice(1))),
      fs.readFile(checkedCompatibilityPath(artifactDirectory, file.path)),
    ]);
    if (!fixtureBytes.equals(artifactBytes)) {
      throw new Error(`Predecessor compatibility raw bytes mismatch: ${file.path}`);
    }
    rawBytesCompared += 1;
  }
  return Object.freeze({ ...artifact, filesCompared: exact.files.length, rawBytesCompared });
}

export function runPredecessorCommand(command, args, options = {}) {
  const lifecycle = { ...options };
  delete lifecycle.posixReleaseMaintenanceBinding;
  if (options.posixReleaseMaintenanceBinding !== undefined) {
    const maintained = createPosixReleaseSessionControl(
      options.posixReleaseMaintenanceBinding,
      { controlKey: `pwa-predecessor:${options.commandLabel ?? command}` },
    );
    lifecycle.posixControlRoot = maintained.controlRoot;
    lifecycle.posixRecoveryScope = maintained.recoveryScope;
    lifecycle.posixSessionControl = maintained.control;
  }
  return runBoundedReleaseCommand(command, args, {
    ...lifecycle,
    captureOutput: !options.inherit,
    commandLabel: options.commandLabel ?? 'PWA predecessor command',
    hardTimeoutMs: options.hardTimeoutMs ?? SOURCE_COMMAND_TIMEOUT_MS,
    maxOutputBytes: options.maxOutputBytes ?? PREDECESSOR_OUTPUT_LIMIT_BYTES,
    stdio: options.inherit ? 'inherit' : undefined,
  });
}

export async function settleCleanupOperations(operations) {
  const results = await Promise.allSettled(operations.map(([, cleanup]) => (
    Promise.resolve().then(cleanup)
  )));
  return results.flatMap((result, index) => {
    if (result.status === 'fulfilled') return [];
    const [label] = operations[index];
    return [new Error(`${label} cleanup failed`, { cause: result.reason })];
  });
}

export async function buildExactPredecessorFixture({
  projectDirectory = defaultProjectDirectory,
  commit = PREDECESSOR_COMMIT,
  inheritBuildOutput = false,
  posixReleaseMaintenanceBinding,
  runCommand = (command, args, options) => runPredecessorCommand(command, args, {
    ...options,
    posixReleaseMaintenanceBinding,
  }),
  temporaryDirectory = os.tmpdir(),
} = {}) {
  const root = await fs.mkdtemp(path.join(path.resolve(temporaryDirectory), 'aisy-pwa-predecessor-'));
  try {
    const archive = path.join(root, 'source.tar');
    const trustedGitDirectory = path.resolve(projectDirectory).replaceAll('\\', '/');
    await runCommand('git', [
      '-c', `safe.directory=${trustedGitDirectory}`,
      'archive', '--format=tar', `--output=${archive}`, commit,
    ], {
      commandLabel: 'PWA predecessor git archive', cwd: projectDirectory,
    });
    await runCommand('tar', ['-xf', archive, '-C', root], {
      commandLabel: 'PWA predecessor tar extraction',
    });
    await fs.symlink(
      path.join(path.resolve(projectDirectory), 'node_modules'),
      path.join(root, 'node_modules'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await runCommand(process.execPath, ['scripts/build-frontend.js'], {
      commandLabel: 'PWA predecessor frontend build',
      cwd: root,
      hardTimeoutMs: FRONTEND_BUILD_TIMEOUT_MS,
      inherit: inheritBuildOutput,
    });
    return Object.freeze({ rootDirectory: root, distDirectory: path.join(root, 'dist', 'public') });
  } catch (error) {
    const cleanupErrors = await settleCleanupOperations([
      ['partial predecessor fixture', () => fs.rm(root, { recursive: true, force: true })],
    ]);
    if (cleanupErrors.length) {
      throw new AggregateError([error, ...cleanupErrors],
        'Exact predecessor fixture failed and its partial root could not be removed');
    }
    throw error;
  }
}

export async function writePredecessorCompatibilityArtifact({
  fixtureDirectory,
  outputDirectory = compatibilityArtifactDirectory(defaultProjectDirectory),
  commit = PREDECESSOR_COMMIT,
} = {}) {
  const fixtureManifest = JSON.parse(await fs.readFile(path.join(fixtureDirectory, 'asset-manifest.json'), 'utf8'));
  const workerSource = await fs.readFile(path.join(fixtureDirectory, 'service-worker.js'), 'utf8');
  const names = Object.keys(fixtureManifest.assets || {})
    .filter((name) => /^assets\/[^/]+\.(?:css|js)$/u.test(name))
    .sort();
  if (!names.includes(fixtureManifest.entry) || names.length < 20) {
    throw new Error('Exact predecessor build has an incomplete executable graph');
  }

  const expectedRoot = path.resolve(defaultProjectDirectory, 'pwa-compat');
  const resolvedOutput = path.resolve(outputDirectory);
  const outside = path.relative(expectedRoot, resolvedOutput);
  if (outside.startsWith('..') || path.isAbsolute(outside) || resolvedOutput === expectedRoot) {
    throw new Error(`Refusing to replace unsafe compatibility path: ${resolvedOutput}`);
  }
  await fs.rm(resolvedOutput, { recursive: true, force: true });
  const files = [];
  for (const name of names) {
    const content = await fs.readFile(path.join(fixtureDirectory, name));
    const webPath = `/${name}`;
    const target = checkedCompatibilityPath(resolvedOutput, webPath);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
    files.push({ path: webPath, bytes: content.length, sha256: sha256(content) });
  }
  const manifest = {
    schemaVersion: COMPATIBILITY_SCHEMA,
    baseCommit: commit,
    cacheName: legacyCacheName(workerSource),
    contentSha256: compatibilityDigest(files),
    files,
  };
  await fs.writeFile(path.join(resolvedOutput, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return verifyPredecessorCompatibility({ directory: resolvedOutput, expectedCommit: commit });
}

export async function generatePredecessorCompatibility({
  buildFixture = () => buildExactPredecessorFixture({ inheritBuildOutput: true }),
  generateArtifact = (fixture) => writePredecessorCompatibilityArtifact({
    fixtureDirectory: fixture.distDirectory,
  }),
  cleanupFixture = (fixture) => fs.rm(fixture.rootDirectory, { recursive: true, force: true }),
  reportSuccess = (message) => console.log(message),
} = {}) {
  let fixture;
  let artifact;
  let primaryFailure;
  try {
    fixture = await buildFixture();
    artifact = await generateArtifact(fixture);
  } catch (error) {
    primaryFailure = error;
  }
  const cleanupErrors = fixture ? await settleCleanupOperations([
    ['predecessor fixture', () => cleanupFixture(fixture)],
  ]) : [];
  if (primaryFailure && cleanupErrors.length) {
    throw new AggregateError([primaryFailure, ...cleanupErrors],
      'Predecessor compatibility generation and cleanup both failed');
  }
  if (primaryFailure) throw primaryFailure;
  if (cleanupErrors.length) {
    throw new AggregateError(cleanupErrors, 'Predecessor compatibility cleanup failed');
  }
  reportSuccess(`PWA predecessor compatibility: ${artifact.files.length} files, ${artifact.contentSha256}`);
  return artifact;
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  const relaunched = launchPosixReleaseMaintenanceBatch({
    checkoutDirectory: defaultProjectDirectory,
    entrypoint: scriptPath,
    lane: 'pwa-predecessor',
  });
  if (relaunched !== null) {
    if (relaunched.error) console.error(relaunched.error.message);
    process.exitCode = Number.isInteger(relaunched.status) ? relaunched.status : 1;
  } else {
    let binding;
    let bindingFailed = false;
    try {
      binding = consumePosixReleaseMaintenanceBinding({
        checkoutDirectory: defaultProjectDirectory,
        lane: 'pwa-predecessor',
      });
    } catch (error) {
      console.error(error);
      bindingFailed = true;
      process.exitCode = 1;
    }
    if (!bindingFailed) {
      generatePredecessorCompatibility({
        buildFixture: () => buildExactPredecessorFixture({
          inheritBuildOutput: true,
          posixReleaseMaintenanceBinding: binding,
        }),
      }).catch((error) => { console.error(error); process.exitCode = 1; });
    }
  }
}
