import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildProductionImage as buildProductionImageWithExplicitAuthority } from '../scripts/build-production-image.js';
import {
  DEFAULT_CANDIDATE_MANIFEST,
  gitTrackedFiles,
  readCandidateFileManifest,
  verifyDockerBuildContext,
} from '../scripts/verify-docker-context.js';

const projectDirectory = fileURLToPath(new URL('..', import.meta.url));
const gitBash = process.platform === 'win32' ? 'C:\\Program Files\\Git\\bin\\bash.exe' : 'bash';
const canonicalPostgresContainerId = '2'.repeat(64);
const productionComposeProjectName = 'easyboost-production';
const TEST_NODE_BASE_IMAGE = `node:22-bookworm-slim@sha256:${'a'.repeat(64)}`;
const testRestoreOperationToken = '12345678-1234-4abc-8def-1234567890ab';

function buildProductionImage(options = {}) {
  const environment = {
    ...(options.environment ?? process.env),
    EASYBOOST_NODE_BASE_IMAGE: TEST_NODE_BASE_IMAGE,
  };
  return buildProductionImageWithExplicitAuthority({ ...options, environment });
}

function exactPostgresProof(imageId, containerId = canonicalPostgresContainerId) {
  return [containerId, productionComposeProjectName, 'postgres', 'False', imageId, 'true'].join('|');
}

function fakeOwnedPosixSession(child, requests, { onRequest = () => {} } = {}) {
  let wrapperClosed = false;
  const control = {
    dispose() {
      if (!wrapperClosed) throw new Error('fake owned-session disposal before exact settlement');
    },
    markWrapperSpawned() {},
    observeWrapperClose() { wrapperClosed = true; },
    proofState() { return { state: wrapperClosed ? 'absent' : 'alive' }; },
    request(signal) {
      requests.push(signal);
      onRequest(signal);
    },
    specification: {
      controlDirectory: path.join(os.tmpdir(), 'easyboost-test-owned-posix-session'),
    },
  };
  return {
    forcePosixSession: true,
    platform: 'linux',
    posixSessionControl: control,
    posixSessionInvocation(command, args, cwd, settlementMilliseconds, environment, authority) {
      return {
        args,
        command,
        cwd,
        environment,
        posixSessionControl: authority,
      };
    },
  };
}

function restoreRecoveryEvidence(containerId = canonicalPostgresContainerId, {
  activityCount = 0,
  process = 'NONE',
  status = 'EXIT:0',
} = {}) {
  return {
    applicationName: `easyboost_restore_${testRestoreOperationToken}`,
    kind: 'restore',
    lastProbe: { activityCount, process, status },
    operationToken: testRestoreOperationToken,
    postgresContainerId: containerId,
  };
}

function createTestVerificationRuntime(containerId = canonicalPostgresContainerId) {
  return async ({ runDocker }) => {
    await runDocker([
      'exec', '-i', containerId, 'createdb', '-U', 'easyboost',
      'easyboost_restore_check_fixture',
    ]);
    return {
      cleanup: async () => runDocker([
        'exec', '-i', containerId, 'dropdb', '-U', 'easyboost', '--force',
        'easyboost_restore_check_fixture',
      ]),
      containerId,
      isolation: 'disposable-exact-image-container',
      volumeName: 'test-disposable-volume',
    };
  };
}

async function runTestSupervisedVerificationRestore({
  inputHandle,
  operationToken = '12345678-1234-4abc-8def-1234567890ab',
  postgresContainerId,
  runDocker,
}) {
  await runDocker([
    'exec', '-i', postgresContainerId, 'pg_restore', '-U', 'easyboost',
    '-d', 'easyboost_restore_check_fixture',
    '--no-owner', '--no-privileges', '--exit-on-error',
  ], { inputHandle });
  return {
    applicationName: `easyboost_restore_${operationToken}`,
    kind: 'restore',
    lastProbe: { activityCount: 0, process: 'NONE', settled: true, status: 'EXIT:0' },
    operationToken,
    postgresContainerId,
    settlement: 'remote-proof',
  };
}
const detachedHeadGuard = [
  'if git symbolic-ref -q HEAD >/dev/null; then',
  "  echo 'Release checkout must use detached HEAD' >&2",
  '  exit 1',
  'else',
  '  symbolic_ref_status="$?"',
  '  [ "$symbolic_ref_status" -eq 1 ] || exit 1',
  'fi',
].join('\n');

async function readDockerInput(options) {
  if (options.inputHandle) {
    const chunks = [];
    for await (const chunk of options.inputHandle.createReadStream({
      autoClose: false,
      start: 0,
    })) chunks.push(chunk);
    return Buffer.concat(chunks);
  }
  return fs.readFile(options.inputFile);
}

function assertFreshPostgresImageSeed(document, label, composeUp = 'up --pull never -d') {
  const orderedTokens = [
    "EASYBOOST_POSTGRES_IMAGE='postgres:17-alpine'",
    'EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID',
    'export EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID',
    'docker pull "$EASYBOOST_POSTGRES_IMAGE"',
    'postgres_seed_image_id="$(docker image inspect --format \'{{.Id}}\' "$EASYBOOST_POSTGRES_IMAGE")"',
    '[ "$postgres_seed_image_id" = "$EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID" ]',
    'postgres_preflight_image_id="$(docker image inspect --format \'{{.Id}}\' "$EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID")"',
    '[ "$postgres_preflight_image_id" = "$EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID" ]',
    composeUp,
    'postgres_container_id="$(docker compose --project-name easyboost-production -f compose.production.yml ps -q postgres)"',
    'postgres_running_image_id="$(docker inspect --format \'{{.Image}}\' "$postgres_container_id")"',
    '[ "$postgres_running_image_id" = "$EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID" ]',
  ];
  let cursor = -1;
  for (const token of orderedTokens) {
    const next = document.indexOf(token, cursor + 1);
    assert.ok(next > cursor, `${label} must contain the ordered PostgreSQL image authority token: ${token}`);
    cursor = next;
  }
  assert.match(document,
    /\[\[ "\$EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID" =~ \^sha256:\[0-9a-f\]\{64\}\$ \]\]/u,
    `${label} must reject empty, abbreviated and non-canonical image identities`);
}

function bashProcedureAfterHeading(document, heading) {
  const headingIndex = document.indexOf(heading);
  assert.ok(headingIndex >= 0, `missing procedure heading: ${heading}`);
  const fenceIndex = document.indexOf('```bash', headingIndex + heading.length);
  const procedureStart = fenceIndex + '```bash'.length;
  const procedureEnd = document.indexOf('```', procedureStart);
  assert.ok(fenceIndex >= 0 && procedureEnd > procedureStart,
    `missing Bash procedure after heading: ${heading}`);
  return document.slice(procedureStart, procedureEnd);
}

function bashProcedureContaining(document, token) {
  const tokenIndex = document.indexOf(token);
  assert.ok(tokenIndex >= 0, `missing Bash procedure token: ${token}`);
  const fenceIndex = document.lastIndexOf('```bash', tokenIndex);
  const procedureStart = fenceIndex + '```bash'.length;
  const procedureEnd = document.indexOf('```', tokenIndex + token.length);
  assert.ok(fenceIndex >= 0 && procedureEnd > tokenIndex,
    `missing Bash procedure containing token: ${token}`);
  return document.slice(procedureStart, procedureEnd);
}

function assertManagedProductionAppStart(procedure, label) {
  const orderedTokens = [
    ': "${EASYBOOST_NODE_BASE_IMAGE:?set the owner-reviewed Node base image digest}"',
    '[[ "$EASYBOOST_NODE_BASE_IMAGE" =~ ^node:22-bookworm-slim@sha256:[0-9a-f]{64}$ ]]',
    'export EASYBOOST_NODE_BASE_IMAGE',
    'npm run production:image:build -- --expected-commit "$EASYBOOST_RELEASE_COMMIT"',
    'production_app_image_id="$(docker image inspect --format \'{{.Id}}\' easyboost-production-app:local)"',
    '[[ "$production_app_image_id" =~ ^sha256:[0-9a-f]{64}$ ]]',
    'app_preflight_image_id="$(docker image inspect --format \'{{.Id}}\' easyboost-production-app:local)"',
    '[ "$app_preflight_image_id" = "$production_app_image_id" ]',
    'export EASYBOOST_PRODUCTION_APP_IMAGE_ID="$production_app_image_id"',
    'sudo install -d -o root -g root -m 0750 /var/lib/easyboost/locks',
    'sudo --preserve-env=EASYBOOST_PRODUCTION_APP_IMAGE_ID,EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID',
    '/usr/bin/node scripts/production-app-lifecycle.js start',
  ];
  let cursor = -1;
  for (const token of orderedTokens) {
    const next = procedure.indexOf(token, cursor + 1);
    assert.ok(next > cursor, `${label} managed start token is missing or out of order: ${token}`);
    cursor = next;
  }
  assert.doesNotMatch(procedure,
    /docker compose\b[^\n]*compose\.production\.yml[^\n]*(?:up|start|stop|restart)[^\n]*\bapp\b/u,
    `${label} must not mutate the app outside the shared host guard`);
}

function assertManagedProductionAppReplace(procedure, label, { rollback = false } = {}) {
  const targetAuthority = rollback
    ? 'export EASYBOOST_PRODUCTION_APP_IMAGE_ID="$rollback_app_image_id"'
    : 'export EASYBOOST_PRODUCTION_APP_IMAGE_ID="$production_app_image_id"';
  const orderedTokens = [
    'current_app_image_id="$EASYBOOST_PRODUCTION_APP_IMAGE_ID"',
    '[[ "$current_app_image_id" =~ ^sha256:[0-9a-f]{64}$ ]]',
    ...(rollback ? [] : [
      ': "${EASYBOOST_NODE_BASE_IMAGE:?set the owner-reviewed Node base image digest}"',
      '[[ "$EASYBOOST_NODE_BASE_IMAGE" =~ ^node:22-bookworm-slim@sha256:[0-9a-f]{64}$ ]]',
      'export EASYBOOST_NODE_BASE_IMAGE',
      'npm run production:image:build -- --expected-commit "$EASYBOOST_RELEASE_COMMIT"',
      'production_app_image_id="$(docker image inspect --format \'{{.Id}}\' easyboost-production-app:local)"',
    ]),
    'sudo install -d -o root -g root -m 0750 /var/lib/easyboost/locks',
    'export EASYBOOST_PREVIOUS_APP_IMAGE_ID="$current_app_image_id"',
    targetAuthority,
    'sudo --preserve-env=EASYBOOST_PREVIOUS_APP_IMAGE_ID,EASYBOOST_PRODUCTION_APP_IMAGE_ID,EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID',
    '/usr/bin/node scripts/production-app-lifecycle.js replace',
  ];
  let cursor = -1;
  for (const token of orderedTokens) {
    const next = procedure.indexOf(token, cursor + 1);
    assert.ok(next > cursor, `${label} managed replace token is missing or out of order: ${token}`);
    cursor = next;
  }
  assert.doesNotMatch(procedure,
    /docker compose\b[^\n]*compose\.production\.yml[^\n]*(?:up|start|stop|restart)[^\n]*\bapp\b/u,
    `${label} must not split replacement across unguarded app mutations`);
  if (rollback) {
    assert.match(procedure,
      /rollback_app_preflight_image_id=.*docker image inspect[\s\S]*?\[ "\$rollback_app_preflight_image_id" = "\$rollback_app_image_id" \]/u,
      `${label} must require the exact retained rollback image before mutation`);
    assert.doesNotMatch(procedure, /\bgit (?:checkout|fetch)|production:image:build|docker pull/u,
      `${label} must use the current helper and an already-local rollback image`);
  }
}

function assertApprovedProductionAppRestart(procedure, label) {
  assert.match(procedure, /EASYBOOST_PRODUCTION_APP_IMAGE_ID/u,
    `${label} must require an approved application image authority`);
  assert.match(procedure, /EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID/u,
    `${label} must require an approved PostgreSQL image authority`);
  assert.match(procedure,
    /sudo --preserve-env=EASYBOOST_PRODUCTION_APP_IMAGE_ID,EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID[\s\\]*\n\s*\/usr\/bin\/node scripts\/production-app-lifecycle\.js restart/u,
    `${label} must use the root managed same-image restart entrypoint`);
  assert.doesNotMatch(procedure,
    /docker compose\b[^\n]*compose\.production\.yml[^\n]*(?:up|start|stop|restart)[^\n]*\bapp\b/u,
    `${label} must not restart the app outside the shared host guard`);
}
function bashProcedures(document) {
  return [...document.matchAll(/```bash\r?\n([\s\S]*?)```/gu)].map((match) => match[1]);
}

async function runTemporaryModuleHarness(directory, source, environment = {}) {
  const harness = path.join(directory, 'harness.mjs');
  await fs.writeFile(harness, source, 'utf8');
  return spawnSync(process.execPath, [harness], {
    cwd: directory,
    encoding: 'utf8',
    env: { ...process.env, ...environment },
  });
}

async function createProjectFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aisy-production-build-source-'));
  const longName = `public/long-segment/${'asset-'.repeat(14)}file.txt`;
  const files = {
    '.dockerignore': 'public/prototypes\n',
    Dockerfile: [
      'FROM scratch AS frontend-build',
      'COPY package.json ./',
      'COPY public ./public',
      'FROM scratch',
      'COPY scripts/runtime.js ./scripts/runtime.js',
      '',
    ].join('\n'),
    'compose.production.yml': [
      'services:',
      '  app:',
      '    image: easyboost-production-app:local',
      '    build:',
      '      context: ./.guarded-production-build-context-required',
      '',
    ].join('\n'),
    'package.json': '{"name":"fixture"}\n',
    'public/index.html': '<main>Aisy</main>\n',
    'public/candidate.txt': 'audited candidate\n',
    [longName]: 'long path bytes\n',
    'public/prototypes/ignored.js': 'ignored\n',
    'scripts/runtime.js': 'export const runtime = true;\n',
  };
  for (const [name, body] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await fs.writeFile(path.join(root, name), body);
  }
  return {
    root,
    longName,
    trackedFiles: [
      '.dockerignore', 'Dockerfile', 'compose.production.yml', 'package.json',
      'public/index.html', longName, 'scripts/runtime.js',
    ],
    candidateFiles: ['public/candidate.txt'],
  };
}

function runGit(directory, args) {
  const result = spawnSync('git', args, { cwd: directory, encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}

async function createExactCheckoutFixture({ ignoredCandidate = false } = {}) {
  const fixture = await createProjectFixture();
  const manifestName = 'scripts/aisy-release-candidate-files.json';
  const candidateFiles = ['public/candidate.txt', manifestName];
  if (ignoredCandidate) {
    candidateFiles.splice(1, 0, 'public/untracked-candidate.txt');
    await Promise.all([
      fs.writeFile(path.join(fixture.root, '.gitignore'), 'public/untracked-candidate.txt\n'),
      fs.writeFile(path.join(fixture.root, 'public', 'untracked-candidate.txt'), 'ignored candidate\n'),
    ]);
  }
  await fs.writeFile(path.join(fixture.root, manifestName), `${JSON.stringify({
    schemaVersion: 'aisy-release-candidate-files-v1',
    files: candidateFiles,
  }, null, 2)}\n`);
  runGit(fixture.root, ['init', '--quiet']);
  runGit(fixture.root, ['config', 'user.email', 'release-test@example.invalid']);
  runGit(fixture.root, ['config', 'user.name', 'Release Test']);
  runGit(fixture.root, ['config', 'core.autocrlf', 'false']);
  runGit(fixture.root, ['add', '--all']);
  runGit(fixture.root, ['commit', '--quiet', '-m', 'exact release candidate']);
  return { ...fixture, head: runGit(fixture.root, ['rev-parse', 'HEAD']) };
}

async function collectContext(context) {
  const chunks = [];
  for await (const chunk of context) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

test('production build exact-checkout authority rejects ambiguous or unaudited release identities before Docker',
  async () => {
    const fixtures = [];
    let dockerRuns = 0;
    const consume = async (_command, _args, _options, context) => {
      dockerRuns += 1;
      await collectContext(context);
      return { status: 0 };
    };
    try {
      const exact = await createExactCheckoutFixture();
      fixtures.push(exact);
      await assert.rejects(buildProductionImage({
        projectDirectory: exact.root,
        expectedCommit: exact.head,
        runBuild: consume,
      }), /detached|symbolic|attached|HEAD/iu,
      'an attached branch must never be accepted as exact release authority');
      assert.equal(dockerRuns, 0, 'attached HEAD must fail before Docker');

      runGit(exact.root, ['checkout', '--detach', '--quiet', exact.head]);
      const valid = await buildProductionImage({
        projectDirectory: exact.root,
        expectedCommit: exact.head,
        runBuild: consume,
      });
      assert.match(valid.fingerprint, /^[a-f0-9]{64}$/u);
      assert.equal(dockerRuns, 1);

      for (const identity of ['main', 'release-v1', exact.head.slice(0, 12), exact.head.toUpperCase()]) {
        await assert.rejects(buildProductionImage({
          projectDirectory: exact.root,
          expectedCommit: identity,
          runBuild: consume,
        }), /full|40|canonical|commit|identity/iu, identity);
      }
      await assert.rejects(buildProductionImage({
        projectDirectory: exact.root,
        expectedCommit: '0'.repeat(40),
        runBuild: consume,
      }), /HEAD|commit|identity|match/iu);
      assert.equal(dockerRuns, 1, 'ambiguous and wrong identities must fail before Docker');

      await fs.appendFile(path.join(exact.root, 'public', 'index.html'), 'dirty\n');
      await assert.rejects(buildProductionImage({
        projectDirectory: exact.root,
        expectedCommit: exact.head,
        runBuild: consume,
      }), /clean|dirty|status|checkout/iu);
      assert.equal(dockerRuns, 1, 'dirty checkout must fail before Docker');

      const archiveOnly = await createProjectFixture();
      fixtures.push(archiveOnly);
      await assert.rejects(buildProductionImage({
        projectDirectory: archiveOnly.root,
        expectedCommit: exact.head,
        runBuild: consume,
      }), /Git|checkout|repository|commit/iu);

      const untracked = await createExactCheckoutFixture({ ignoredCandidate: true });
      fixtures.push(untracked);
      runGit(untracked.root, ['checkout', '--detach', '--quiet', untracked.head]);
      await assert.rejects(buildProductionImage({
        projectDirectory: untracked.root,
        expectedCommit: untracked.head,
        runBuild: consume,
      }), /candidate.*tracked|tracked.*candidate/iu);
      assert.equal(dockerRuns, 1, 'archive-only and untracked-candidate trees must fail before Docker');
    } finally {
      await Promise.all(fixtures.map((fixture) => fs.rm(fixture.root, { recursive: true, force: true })));
    }
  });

function tarFiles(archive) {
  const files = new Map();
  for (let offset = 0; offset + 512 <= archive.length;) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const readField = (start, length) => header.subarray(start, start + length)
      .toString('utf8').replace(/\0.*$/su, '');
    const name = readField(0, 100);
    const prefix = readField(345, 155);
    const file = prefix ? `${prefix}/${name}` : name;
    const size = Number.parseInt(readField(124, 12).trim() || '0', 8);
    const bodyStart = offset + 512;
    files.set(file, Buffer.from(archive.subarray(bodyStart, bodyStart + size)));
    offset = bodyStart + Math.ceil(size / 512) * 512;
  }
  return files;
}

test('production wrapper streams one deterministic audited Docker context into the stable image tag', async () => {
  const fixture = await createProjectFixture();
  try {
    let archive;
    const result = await buildProductionImage({
      projectDirectory: fixture.root,
      trackedFiles: fixture.trackedFiles,
      candidateFiles: fixture.candidateFiles,
      environment: { PATH: 'test-path', EASYBOOST_PRODUCTION_BUILD_CONTEXT: 'untrusted' },
      async runBuild(command, args, options, context) {
        assert.equal(command, 'docker');
        assert.deepEqual(args, [
          'build', '--file', 'Dockerfile', '--tag', 'easyboost-production-app:local',
          '--build-arg', `EASYBOOST_NODE_BASE_IMAGE=${TEST_NODE_BASE_IMAGE}`, '-',
        ]);
        assert.equal(options.cwd, fixture.root);
        assert.equal(options.shell, false);
        assert.equal(options.env.PATH, 'test-path');
        assert.equal(options.env.EASYBOOST_PRODUCTION_BUILD_CONTEXT, undefined);
        assert.equal(options.env.EASYBOOST_NODE_BASE_IMAGE, undefined);
        archive = await collectContext(context);
        return { status: 0, signal: null, error: undefined };
      },
    });
    const files = tarFiles(archive);
    assert.deepEqual([...files.keys()], [
      '.dockerignore', 'Dockerfile', 'package.json', 'public/candidate.txt',
      'public/index.html', fixture.longName, 'scripts/runtime.js',
    ]);
    assert.equal(files.get('Dockerfile').toString('utf8'), [
      'FROM scratch AS frontend-build',
      'COPY package.json ./',
      'COPY public ./public',
      'FROM scratch',
      'COPY scripts/runtime.js ./scripts/runtime.js',
      '',
    ].join('\n'));
    assert.equal(files.get(fixture.longName).toString('utf8'), 'long path bytes\n');
    assert.equal(files.has('public/prototypes/ignored.js'), false);
    const archivePath = path.join(fixture.root, 'verified-context.tar');
    await fs.writeFile(archivePath, archive);
    const listed = spawnSync('tar', ['-tf', archivePath], { encoding: 'utf8' });
    assert.equal(listed.status, 0, listed.stderr);
    assert.ok(listed.stdout.split(/\r?\n/u).includes(fixture.longName), listed.stdout);
    const extractedDockerfile = spawnSync('tar', ['-xOf', archivePath, 'Dockerfile']);
    assert.equal(extractedDockerfile.status, 0, extractedDockerfile.stderr?.toString('utf8'));
    assert.deepEqual(extractedDockerfile.stdout, files.get('Dockerfile'));
    assert.equal(result.files, 7);
    assert.match(result.fingerprint, /^[a-f0-9]{64}$/u);
    assert.equal(result.contextBytes, archive.length);
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test('production build binds both Node stages to one mandatory owner-reviewed digest authority',
  async () => {
    const dockerfile = await fs.readFile(path.join(projectDirectory, 'Dockerfile'), 'utf8');
    assert.match(dockerfile, /^ARG EASYBOOST_NODE_BASE_IMAGE\r?\n/u);
    assert.equal((dockerfile.match(/^FROM \$\{EASYBOOST_NODE_BASE_IMAGE\}(?: AS frontend-build)?$/gmu)
      ?? []).length, 2, 'both build stages must consume the same exact image authority');
    assert.doesNotMatch(dockerfile, /^FROM\s+node:[^@\s]+/gmu,
      'a mutable tag-only Node base must never remain buildable');
    assert.match(dockerfile,
      /COPY --chown=node:node scripts\/bounded-child-lifecycle\.js scripts\/database-operation-lock\.js scripts\/host-operation-lock\.js scripts\/import-json\.js scripts\/migrate\.js scripts\/posix-session-supervisor\.js scripts\/production-import-local-child-authority\.js scripts\/release-command-supervisor\.js \.\/scripts\//u,
      'the runtime import entrypoint must ship its complete bounded lifecycle dependency closure');

    const fixture = await createProjectFixture();
    let dockerRuns = 0;
    const consume = async (_command, args, _options, context) => {
      dockerRuns += 1;
      assert.deepEqual(args.slice(0, 7), [
        'build', '--file', 'Dockerfile', '--tag', 'easyboost-production-app:local',
        '--build-arg', `EASYBOOST_NODE_BASE_IMAGE=${TEST_NODE_BASE_IMAGE}`,
      ]);
      await collectContext(context);
      return { status: 0 };
    };
    try {
      for (const invalid of [undefined, '', 'node:22-bookworm-slim', `node@sha256:${'a'.repeat(64)}`]) {
        await assert.rejects(buildProductionImageWithExplicitAuthority({
          projectDirectory: fixture.root,
          trackedFiles: fixture.trackedFiles,
          candidateFiles: fixture.candidateFiles,
          environment: invalid === undefined ? {} : { EASYBOOST_NODE_BASE_IMAGE: invalid },
          runBuild: consume,
        }), /Node base image.*node:22-bookworm-slim@sha256/iu, String(invalid));
      }
      assert.equal(dockerRuns, 0, 'invalid base authority must fail before Docker or context streaming');
      await buildProductionImageWithExplicitAuthority({
        projectDirectory: fixture.root,
        trackedFiles: fixture.trackedFiles,
        candidateFiles: fixture.candidateFiles,
        environment: { EASYBOOST_NODE_BASE_IMAGE: TEST_NODE_BASE_IMAGE },
        runBuild: consume,
      });
      assert.equal(dockerRuns, 1);
    } finally {
      await fs.rm(fixture.root, { recursive: true, force: true });
    }
  });

test('the streamed Docker context is byte-deterministic for unchanged verified source', async () => {
  const fixture = await createProjectFixture();
  try {
    const digests = [];
    for (let index = 0; index < 2; index += 1) {
      await buildProductionImage({
        projectDirectory: fixture.root,
        trackedFiles: fixture.trackedFiles,
        candidateFiles: fixture.candidateFiles,
        async runBuild(_command, _args, _options, context) {
          digests.push(crypto.createHash('sha256').update(await collectContext(context)).digest('hex'));
          return { status: 0 };
        },
      });
    }
    assert.equal(digests[0], digests[1]);
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test('an unexpected reachable source file fails before the Docker runner', async () => {
  const fixture = await createProjectFixture();
  let runnerCalled = false;
  try {
    await fs.writeFile(path.join(fixture.root, 'public', 'untracked-note.txt'), 'not audited\n');
    await assert.rejects(buildProductionImage({
      projectDirectory: fixture.root,
      trackedFiles: fixture.trackedFiles,
      candidateFiles: fixture.candidateFiles,
      async runBuild(_command, _args, _options, context) {
        runnerCalled = true;
        await collectContext(context);
        return { status: 0 };
      },
    }), /public\/untracked-note\.txt/u);
    assert.equal(runnerCalled, false);
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test('every Docker-bound byte is secret-scanned including PNG metadata', async () => {
  const fixture = await createProjectFixture();
  const assembled = ['g', 'sk_', 'r'.repeat(40)].join('');
  let runnerCalled = false;
  try {
    await fs.writeFile(path.join(fixture.root, 'public', 'icon.png'), Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]), Buffer.from(assembled, 'ascii'),
    ]));
    fixture.trackedFiles.push('public/icon.png');
    await assert.rejects(buildProductionImage({
      projectDirectory: fixture.root,
      trackedFiles: fixture.trackedFiles,
      candidateFiles: fixture.candidateFiles,
      async runBuild(_command, _args, _options, context) {
        runnerCalled = true;
        await collectContext(context);
        return { status: 0 };
      },
    }), (error) => {
      assert.match(error.message, /public\/icon\.png: Groq key/u);
      assert.doesNotMatch(error.message, new RegExp(assembled, 'u'));
      return true;
    });
    assert.equal(runnerCalled, false);
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test('a source ancestor swapped after freezing cannot enter or complete the Docker stream', async () => {
  const fixture = await createProjectFixture();
  const alternate = await fs.mkdtemp(path.join(os.tmpdir(), 'aisy-production-race-target-'));
  let runnerCalled = false;
  try {
    await Promise.all([
      fs.writeFile(path.join(alternate, 'candidate.txt'), 'replacement candidate\n'),
      fs.writeFile(path.join(alternate, 'index.html'), '<main>replacement</main>\n'),
    ]);
    await assert.rejects(buildProductionImage({
      projectDirectory: fixture.root,
      trackedFiles: fixture.trackedFiles,
      candidateFiles: fixture.candidateFiles,
      async runBuild(_command, _args, _options, context) {
        runnerCalled = true;
        await fs.rename(path.join(fixture.root, 'public'), path.join(fixture.root, 'public-original'));
        await fs.symlink(alternate, path.join(fixture.root, 'public'), 'junction');
        await collectContext(context);
        return { status: 0 };
      },
    }), /ancestor|identity|symlink|changed/iu);
    assert.equal(runnerCalled, true);
  } finally {
    await fs.rm(path.join(fixture.root, 'public'), { recursive: true, force: true });
    try {
      await fs.rename(path.join(fixture.root, 'public-original'), path.join(fixture.root, 'public'));
    } catch {}
    await fs.rm(alternate, { recursive: true, force: true });
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test('Dockerfile bytes are descriptor-frozen before COPY parsing and cannot be replaced with ADD', async () => {
  const fixture = await createProjectFixture();
  const dockerfilePath = path.join(fixture.root, 'Dockerfile');
  const originalOpen = fsSync.openSync;
  const originalRead = fsSync.readFileSync;
  let dockerfileDescriptor;
  let replacementInstalled = false;
  let runnerCalled = false;
  try {
    fsSync.openSync = function patchedOpen(file, ...args) {
      const descriptor = originalOpen.call(this, file, ...args);
      if (path.resolve(String(file)) === dockerfilePath) dockerfileDescriptor = descriptor;
      return descriptor;
    };
    fsSync.readFileSync = function patchedRead(file, ...args) {
      const result = originalRead.call(this, file, ...args);
      if (!replacementInstalled && (path.resolve(String(file)) === dockerfilePath
          || file === dockerfileDescriptor)) {
        replacementInstalled = true;
        fsSync.writeFileSync(dockerfilePath, 'FROM scratch\nADD private.txt /private.txt\n');
      }
      return result;
    };
    await assert.rejects(buildProductionImage({
      projectDirectory: fixture.root,
      trackedFiles: fixture.trackedFiles,
      candidateFiles: fixture.candidateFiles,
      async runBuild(_command, _args, _options, context) {
        runnerCalled = true;
        await collectContext(context);
        return { status: 0 };
      },
    }), /Dockerfile|identity|bytes changed|ADD/iu);
    assert.equal(replacementInstalled, true, 'the fixture must replace Dockerfile after its first read');
    assert.equal(runnerCalled, false, 'an unsupported replacement must fail before the Docker runner');
  } finally {
    fsSync.openSync = originalOpen;
    fsSync.readFileSync = originalRead;
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test('candidate manifest bytes are descriptor-frozen before they authorize Docker inputs', async () => {
  const fixture = await createProjectFixture();
  const manifestName = 'scripts/aisy-release-candidate-files.json';
  const manifestPath = path.join(fixture.root, ...manifestName.split('/'));
  const originalOpen = fsSync.openSync;
  const originalRead = fsSync.readFileSync;
  let manifestDescriptor;
  let replacementInstalled = false;
  let runnerCalled = false;
  try {
    await fs.writeFile(manifestPath, `${JSON.stringify({
      schemaVersion: 'aisy-release-candidate-files-v1',
      files: ['public/candidate.txt', manifestName],
    }, null, 2)}\n`);
    await fs.writeFile(path.join(fixture.root, 'Dockerfile'), [
      'FROM scratch',
      'COPY package.json ./',
      'COPY public ./public',
      'COPY scripts ./scripts',
      '',
    ].join('\n'));
    fixture.trackedFiles.push('scripts/runtime.js');
    fsSync.openSync = function patchedOpen(file, ...args) {
      const descriptor = originalOpen.call(this, file, ...args);
      if (path.resolve(String(file)) === manifestPath) manifestDescriptor = descriptor;
      return descriptor;
    };
    fsSync.readFileSync = function patchedRead(file, ...args) {
      const result = originalRead.call(this, file, ...args);
      if (!replacementInstalled && (path.resolve(String(file)) === manifestPath
          || file === manifestDescriptor)) {
        replacementInstalled = true;
        fsSync.writeFileSync(manifestPath, `${JSON.stringify({
          schemaVersion: 'aisy-release-candidate-files-v1',
          files: [manifestName],
        }, null, 2)}\n`);
      }
      return result;
    };
    await assert.rejects(buildProductionImage({
      projectDirectory: fixture.root,
      trackedFiles: fixture.trackedFiles,
      async runBuild(_command, _args, _options, context) {
        runnerCalled = true;
        await collectContext(context);
        return { status: 0 };
      },
    }), /candidate manifest|identity|bytes changed|changed (?:during|while) read/iu);
    assert.equal(replacementInstalled, true, 'fixture must replace the manifest after authorization read');
    assert.equal(runnerCalled, false, 'a transient manifest must fail before Docker is invoked');
  } finally {
    fsSync.openSync = originalOpen;
    fsSync.readFileSync = originalRead;
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test('candidate manifest remains unchanged through immutable context streaming', async () => {
  const fixture = await createProjectFixture();
  const manifestName = 'scripts/aisy-release-candidate-files.json';
  const manifestPath = path.join(fixture.root, ...manifestName.split('/'));
  let runnerCalled = false;
  try {
    const manifest = `${JSON.stringify({
      schemaVersion: 'aisy-release-candidate-files-v1',
      files: ['public/candidate.txt', manifestName],
    }, null, 2)}\n`;
    await fs.writeFile(manifestPath, manifest);
    await fs.writeFile(path.join(fixture.root, 'Dockerfile'), [
      'FROM scratch',
      'COPY package.json ./',
      'COPY public ./public',
      'COPY scripts ./scripts',
      '',
    ].join('\n'));
    await assert.rejects(buildProductionImage({
      projectDirectory: fixture.root,
      trackedFiles: fixture.trackedFiles,
      async runBuild(_command, _args, _options, context) {
        runnerCalled = true;
        await fs.appendFile(manifestPath, ' ');
        await collectContext(context);
        return { status: 0 };
      },
    }), /candidate-files\.json|identity|bytes changed|changed/iu);
    assert.equal(runnerCalled, true);
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test('a runner cannot report success without consuming the immutable context', async () => {
  const fixture = await createProjectFixture();
  try {
    await assert.rejects(buildProductionImage({
      projectDirectory: fixture.root,
      trackedFiles: fixture.trackedFiles,
      candidateFiles: fixture.candidateFiles,
      async runBuild() { return { status: 0 }; },
    }), /did not consume the complete immutable Docker context/iu);
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test('Docker launch failures expose no inherited environment or runner error values', async () => {
  const fixture = await createProjectFixture();
  const assembled = ['private-', 'runtime-', 'value'].join('');
  try {
    await assert.rejects(buildProductionImage({
      projectDirectory: fixture.root,
      trackedFiles: fixture.trackedFiles,
      candidateFiles: fixture.candidateFiles,
      environment: { PRIVATE_RUNTIME_VALUE: assembled },
      async runBuild(_command, _args, _options, context) {
        await collectContext(context);
        return { status: null, error: new Error(assembled) };
      },
    }), (error) => {
      assert.equal(error.message, 'Docker image build could not start');
      assert.doesNotMatch(error.message, new RegExp(assembled, 'u'));
      return true;
    });
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test('production Compose and every operator build procedure require the guarded wrapper', async () => {
  const [compose, packageSource, readme, releaseChecklist, disasterRecovery, experimentalChecklist] = await Promise.all([
    fs.readFile(path.join(projectDirectory, 'compose.production.yml'), 'utf8'),
    fs.readFile(path.join(projectDirectory, 'package.json'), 'utf8'),
    fs.readFile(path.join(projectDirectory, 'README_DEPLOY.md'), 'utf8'),
    fs.readFile(path.join(projectDirectory, 'RELEASE_CHECKLIST.md'), 'utf8'),
    fs.readFile(path.join(projectDirectory, 'docs', 'DISASTER_RECOVERY.md'), 'utf8'),
    fs.readFile(path.join(
      projectDirectory, 'docs', 'EXPERIMENTAL_RELEASE_OPERATIONS_CHECKLIST.md',
    ), 'utf8'),
  ]);
  const packageJson = JSON.parse(packageSource);
  assert.equal(packageJson.scripts['production:image:build'],
    'node scripts/build-production-image.js');
  assert.equal(packageJson.scripts['production:app:start'],
    'node scripts/production-app-lifecycle.js start');
  assert.equal(packageJson.scripts['production:app:stop'],
    'node scripts/production-app-lifecycle.js stop');
  assert.equal(packageJson.scripts['production:app:restart'],
    'node scripts/production-app-lifecycle.js restart');
  assert.equal(packageJson.scripts['production:app:replace'],
    'node scripts/production-app-lifecycle.js replace');
  assert.equal(packageJson.scripts['production:app:recover'],
    'node scripts/production-app-lifecycle.js recover');
  assert.equal(packageJson.scripts['production:import:recover'],
    'node scripts/production-import-recovery.js');
  assert.equal(packageJson.scripts['production:restore:recover'],
    'node scripts/production-restore-recovery.js');
  assert.match(compose,
    /image: \$\{EASYBOOST_PRODUCTION_APP_IMAGE_ID:\?set the canonical production app image ID\}/u);
  assert.match(compose, /pull_policy: never/u);
  assert.match(compose,
    /^\s*context: \.\/\.guarded-production-build-context-required\s*$/mu);
  assert.doesNotMatch(compose, /EASYBOOST_PRODUCTION_BUILD_CONTEXT/u,
    'no caller environment may reopen the raw production build context');
  await assert.rejects(fs.access(
    path.join(projectDirectory, '.guarded-production-build-context-required'),
  ), 'the raw-build sentinel context must remain intentionally absent');

  for (const document of [readme, releaseChecklist, disasterRecovery, experimentalChecklist]) {
    assert.match(document, /npm run production:image:build/u);
  }
  const auditedMarkdown = [...new Set([
    ...gitTrackedFiles(projectDirectory),
    ...readCandidateFileManifest({ projectDirectory }),
  ])].filter((file) => /\.(?:md|txt)$/iu.test(file));
  const rawProductionBuild = /^[^\r\n]*\bdocker\s+compose\b[^\r\n]*\bcompose\.production\.yml\b[^\r\n]*(?:[ \t]build(?:[ \t]|$)|--build(?:[ \t]|$))/imu;
  assert.equal(rawProductionBuild.test(
    'docker compose --project-name easyboost-production -f compose.production.yml up --pull never --no-build -d app',
  ), false, 'the required --no-build path must not be mistaken for a raw build');
  for (const file of auditedMarkdown) {
    const source = await fs.readFile(path.join(projectDirectory, file), 'utf8');
    assert.equal(rawProductionBuild.test(source), false,
      `production documentation must not expose a raw Compose build path: ${file}`);
  }
  assert.match(disasterRecovery,
    /docker compose --project-name easyboost-production -f compose\.production\.yml up --pull never -d postgres/u,
    'the PostgreSQL-only disaster-recovery operation must remain available');
});

test('production Compose resolves the app from a required immutable image ID', async () => {
  const compose = await fs.readFile(path.join(projectDirectory, 'compose.production.yml'), 'utf8');
  assert.match(compose,
    /^\s*image: \$\{EASYBOOST_PRODUCTION_APP_IMAGE_ID:\?set the canonical production app image ID\}\s*$/mu);
  assert.doesNotMatch(compose, /^\s*image: easyboost-production-app:local\s*$/mu,
    'Compose must never resolve the app service through the mutable build tag');
});

test('scheduled PostgreSQL backup commands require canonical app and database image authorities before Docker',
  async () => {
    const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-backup-authority-'));
    try {
      const canonicalAppImageId = `sha256:${'a'.repeat(64)}`;
      const canonicalPostgresImageId = `sha256:${'b'.repeat(64)}`;
      for (const [script, arguments_] of [
        ['postgres-backup.js', [path.join(temporaryDirectory, 'backup.dump')]],
        ['postgres-verify-backup.js', []],
      ]) {
        for (const scenario of [
          {
            application: undefined,
            expectedMessage: 'EASYBOOST_PRODUCTION_APP_IMAGE_ID',
            postgres: canonicalPostgresImageId,
          },
          {
            application: 'not-a-canonical-image-id',
            expectedMessage: 'EASYBOOST_PRODUCTION_APP_IMAGE_ID',
            postgres: canonicalPostgresImageId,
          },
          {
            application: canonicalAppImageId,
            expectedMessage: 'EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID',
            postgres: undefined,
          },
          {
            application: canonicalAppImageId,
            expectedMessage: 'EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID',
            postgres: 'not-a-canonical-image-id',
          },
        ]) {
          const environment = { ...process.env, PATH: '', Path: '' };
          if (scenario.application === undefined) {
            delete environment.EASYBOOST_PRODUCTION_APP_IMAGE_ID;
          } else {
            environment.EASYBOOST_PRODUCTION_APP_IMAGE_ID = scenario.application;
          }
          if (scenario.postgres === undefined) {
            delete environment.EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID;
          } else {
            environment.EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID = scenario.postgres;
          }
          const result = spawnSync(process.execPath, [
            path.join(projectDirectory, 'scripts', script), ...arguments_,
          ], {
            cwd: temporaryDirectory,
            encoding: 'utf8',
            env: environment,
          });
          assert.equal(result.status, 2, `${script}: ${result.stderr}`);
          assert.match(result.stderr, new RegExp(
            `${scenario.expectedMessage} must be an owner-approved canonical sha256 image ID`, 'u',
          ));
          assert.doesNotMatch(result.stderr, /ENOENT|spawn docker/u,
            `${script} must reject invalid authority before it tries Docker`);
        }
      }
    } finally {
      await fs.rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

test('database Docker subprocesses abort streams and use bounded TERM to KILL cleanup',
  async () => {
    for (const script of [
      'postgres-backup.js',
      'postgres-restore.js',
      'postgres-verify-backup.js',
    ]) {
      const module = await import(`../scripts/${script}?bounded=${Date.now()}-${script}`);
      assert.equal(typeof module.runDockerCommand, 'function',
        `${script} must expose its production subprocess boundary for deterministic verification`);
      const signals = [];
      const child = new EventEmitter();
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.kill = (signal) => {
        signals.push(signal);
        if (signal === 'SIGKILL') {
          setImmediate(() => { child.emit('close', null, 'SIGKILL'); });
        }
        return true;
      };
      await assert.rejects(module.runDockerCommand(['version'], {
        childLifecycle: fakeOwnedPosixSession(child, signals, {
          onRequest(signal) {
            if (signal === 'SIGKILL') setImmediate(() => { child.emit('close', null, signal); });
          },
        }),
        commandTimeoutMs: 10,
        killGraceMs: 10,
        reapTimeoutMs: 30,
        spawnProcess: () => child,
      }), /docker version timed out after 10ms/u);
      assert.deepEqual(signals, ['SIGTERM', 'SIGKILL'],
        `${script} must escalate a hung child from TERM to KILL`);

      const unreapedSignals = [];
      const unreapedChild = new EventEmitter();
      unreapedChild.stdin = new PassThrough();
      unreapedChild.stdout = new PassThrough();
      unreapedChild.kill = (signal) => { unreapedSignals.push(signal); return true; };
      await assert.rejects(module.runDockerCommand(['info'], {
        childLifecycle: fakeOwnedPosixSession(unreapedChild, unreapedSignals),
        commandTimeoutMs: 5,
        killGraceMs: 5,
        reapTimeoutMs: 10,
        spawnProcess: () => unreapedChild,
      }), (error) => {
        assert.ok(error instanceof AggregateError);
        assert.match(error.errors[0].message, /docker info timed out after 5ms/u,
          `${script} must retain the timeout as the primary lifecycle error`);
        assert.match(error.errors[1].message, /did not close after SIGKILL within 10ms/u);
        assert.equal(error.cause, error.errors[0]);
        return true;
      });
      assert.deepEqual(unreapedSignals, ['SIGTERM', 'SIGKILL'],
        `${script} must bound its final reap even if a child never closes`);

      const brokenSignals = [];
      const brokenChild = new EventEmitter();
      brokenChild.stdin = new PassThrough();
      brokenChild.stdout = new PassThrough();
      brokenChild.kill = (signal) => {
        brokenSignals.push(signal);
        setImmediate(() => { brokenChild.emit('close', null, signal); });
        return true;
      };
      const brokenStream = script === 'postgres-backup.js'
        ? { outputFile: path.join(os.tmpdir(), crypto.randomUUID(), 'missing.dump') }
        : { inputFile: path.join(os.tmpdir(), `missing-${crypto.randomUUID()}.dump`) };
      await assert.rejects(module.runDockerCommand(['compose', 'exec'], {
        childLifecycle: fakeOwnedPosixSession(brokenChild, brokenSignals, {
          onRequest(signal) { setImmediate(() => { brokenChild.emit('close', null, signal); }); },
        }),
        commandTimeoutMs: 100,
        ...brokenStream,
        killGraceMs: 10,
        reapTimeoutMs: 20,
        spawnProcess: () => brokenChild,
      }), { code: 'ENOENT' });
      assert.deepEqual(brokenSignals, ['SIGTERM'],
        `${script} must terminate a child immediately when its input stream breaks`);
    }
  });

test('database Docker child error does not prove close/reap or permit silent cleanup', async () => {
  for (const script of [
    'postgres-backup.js',
    'postgres-restore.js',
    'postgres-verify-backup.js',
  ]) {
    const module = await import(`../scripts/${script}?error-without-close=${Date.now()}-${script}`);
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    const signals = [];
    child.kill = (signal) => { signals.push(signal); return true; };
    const spawnError = new Error(`${script} synthetic spawn error without close`);
    const started = Date.now();
    const execution = module.runDockerCommand(['version'], {
      childLifecycle: fakeOwnedPosixSession(child, signals),
      commandTimeoutMs: 100,
      killGraceMs: 5,
      reapTimeoutMs: 10,
      spawnProcess: () => child,
    });
    setImmediate(() => { child.emit('error', spawnError); });

    await assert.rejects(execution, (error) => {
      assert.ok(error instanceof AggregateError,
        `${script} must preserve the spawn error together with unproven reap`);
      assert.equal(error.errors[0], spawnError,
        `${script} must retain the child error as the primary failure`);
      assert.match(error.errors[1].message, /did not close after SIGKILL within 10ms/u);
      assert.equal(error.cause, spawnError);
      assert.equal(error.childSettlementUnproven, true,
        `${script} must mark the failure so its database lock cannot be released`);
      assert.equal(path.isAbsolute(error.recoveryAuthority?.controlDirectory), true,
        `${script} must return an absolute durable same-scope controller`);
      assert.equal(path.basename(error.recoveryAuthority.controlDirectory),
        'easyboost-test-owned-posix-session');
      return true;
    });
    assert.deepEqual(signals, ['SIGTERM', 'SIGKILL'],
      `${script} must keep escalating until an actual close/reap event is observed`);
    assert.ok(Date.now() - started < 500,
      `${script} error-without-close cleanup exceeded its own bound`);
  }
});

test('local-child hold finalization preserves every unresolved recovery authority', async () => {
  const { settleLocalChildHold } = await import('../scripts/bounded-child-lifecycle.js');
  const primaryAuthority = Object.freeze({
    controlDirectory: '/tmp/easyboost-primary-session-control',
  });
  const holdAuthority = Object.freeze({
    holdFile: '/tmp/easyboost-database.lock.local-child-fixture',
    lockFile: '/tmp/easyboost-database.lock',
  });
  const primary = Object.assign(new Error('child settlement is unproven'), {
    childSettlementUnproven: true,
    recoveryAuthority: primaryAuthority,
  });
  const holdFailure = Object.assign(new Error('local-child hold cleanup failed'), {
    recoveryAuthority: holdAuthority,
  });

  const failure = await settleLocalChildHold({
    async release() { throw holdFailure; },
  }, primary, 'fixture local-child hold finalization failed');

  assert.ok(failure instanceof AggregateError);
  assert.equal(failure.childSettlementUnproven, true);
  assert.deepEqual(failure.recoveryAuthority, primaryAuthority,
    'the legacy singular recovery authority remains deterministic');
  assert.deepEqual(failure.recoveryAuthorities, [primaryAuthority, holdAuthority],
    'distinct durable recovery authorities must remain completely actionable');
});

test('lifecycle recovery authority collection recursively sanitizes, clones and freezes paths',
  async () => {
    const {
      collectLifecycleRecovery,
      propagateLifecycleRecovery,
    } = await import('../scripts/bounded-child-lifecycle.js');
    const mutableAuthority = {
      authorityToken: 'must-not-escape',
      controlDirectory: '/tmp/easyboost-authority-control',
      password: 'must-not-escape',
      relativeFile: 'relative-marker',
    };
    const mutableHold = {
      holdFile: '/tmp/easyboost-authority-hold',
      holdToken: 'must-not-escape',
      lockFile: '/tmp/easyboost-authority.lock',
    };
    const nested = Object.assign(new Error('nested settlement is unproven'), {
      childSettlementUnproven: true,
      recoveryAuthorities: [
        { controlDirectory: 'relative-control', secret: 'must-not-escape' },
        mutableHold,
      ],
    });
    const primary = Object.assign(new Error('primary settlement is unproven'), {
      recoveryAuthority: mutableAuthority,
    });
    const aggregate = new AggregateError([
      primary,
      new AggregateError([nested], 'nested lifecycle failure'),
    ], 'outer lifecycle failure');

    const collected = collectLifecycleRecovery(aggregate);
    assert.equal(collected.childSettlementUnproven, true);
    assert.deepEqual(collected.recoveryAuthorities, [
      { controlDirectory: '/tmp/easyboost-authority-control' },
      {
        holdFile: '/tmp/easyboost-authority-hold',
        lockFile: '/tmp/easyboost-authority.lock',
      },
    ]);
    assert.ok(Object.isFrozen(collected));
    assert.ok(Object.isFrozen(collected.recoveryAuthorities));
    assert.ok(collected.recoveryAuthorities.every(Object.isFrozen));

    propagateLifecycleRecovery(aggregate);
    mutableAuthority.controlDirectory = '/tmp/changed-after-propagation';
    mutableHold.holdFile = '/tmp/changed-after-propagation';
    assert.equal(aggregate.childSettlementUnproven, true);
    assert.deepEqual(aggregate.recoveryAuthority,
      { controlDirectory: '/tmp/easyboost-authority-control' });
    assert.deepEqual(aggregate.recoveryAuthorities, collected.recoveryAuthorities);
    assert.notEqual(aggregate.recoveryAuthority, mutableAuthority);
    assert.notEqual(aggregate.recoveryAuthorities[1], mutableHold);
    assert.throws(() => { aggregate.recoveryAuthority.controlDirectory = '/tmp/mutated'; }, TypeError);
    assert.doesNotMatch(JSON.stringify(aggregate.recoveryAuthorities),
      /must-not-escape|relative-control|relative-marker/u);

    const invalid = Object.assign(new Error('invalid authority'), {
      recoveryAuthority: { controlDirectory: 'relative-only', token: 'must-not-escape' },
      recoveryAuthorities: { controlDirectory: '/tmp/not-an-authority-list' },
    });
    propagateLifecycleRecovery(invalid);
    assert.equal(Object.hasOwn(invalid, 'recoveryAuthority'), false);
    assert.equal(Object.hasOwn(invalid, 'recoveryAuthorities'), false);
  });

test('lifecycle recovery propagation scrubs every reachable node and orders paths by code units',
  async () => {
    const { propagateLifecycleRecovery } = await import('../scripts/bounded-child-lifecycle.js');
    const mutableNested = Object.assign(new Error('mutable nested diagnostic'), {
      recoveryAuthority: {
        controlDirectory: '/tmp/z-control',
        password: 'must-not-escape',
      },
    });
    const frozenNested = Object.freeze(Object.assign(new Error('frozen nested diagnostic'), {
      recoveryAuthority: {
        authorityToken: 'must-not-escape',
        controlDirectory: '/tmp/ä-control',
      },
      recoveryAuthorities: [{ controlDirectory: 'relative-control' }],
    }));
    const cyclic = Object.assign(new Error('cyclic nested diagnostic'), {
      recoveryAuthority: { controlDirectory: '/tmp/a-control', secret: 'must-not-escape' },
    });
    cyclic.cause = cyclic;
    const outer = new AggregateError([mutableNested, frozenNested, cyclic], 'outer diagnostics', {
      cause: cyclic,
    });

    const propagated = propagateLifecycleRecovery(outer);
    const seen = new Set();
    const nestedMetadata = (error) => {
      if (!error || typeof error !== 'object' || seen.has(error)) return [];
      seen.add(error);
      const own = error === propagated
        ? []
        : ['recoveryAuthority', 'recoveryAuthorities'].filter((key) => Object.hasOwn(error, key));
      const children = error instanceof AggregateError && Array.isArray(error.errors)
        ? error.errors.flatMap(nestedMetadata)
        : [];
      return [...own, ...children, ...nestedMetadata(error.cause)];
    };
    assert.equal(propagated.childSettlementUnproven, undefined);
    assert.deepEqual(propagated.recoveryAuthorities, [
      { controlDirectory: '/tmp/a-control' },
      { controlDirectory: '/tmp/z-control' },
      { controlDirectory: '/tmp/ä-control' },
    ]);
    assert.deepEqual(nestedMetadata(propagated), []);
    assert.doesNotMatch(JSON.stringify(propagated), /must-not-escape|relative-control/u);
    assert.match(propagated.message, /outer diagnostics/u);

    const frozenOuterChild = Object.assign(new Error('frozen outer child'), {
      childSettlementUnproven: true,
      recoveryAuthority: { controlDirectory: '/tmp/frozen-outer-control', token: 'must-not-escape' },
    });
    const frozenOuter = Object.freeze(new AggregateError([frozenOuterChild], 'frozen outer diagnostic'));
    const frozenPropagated = propagateLifecycleRecovery(frozenOuter);
    assert.notEqual(frozenPropagated, frozenOuter);
    assert.equal(frozenPropagated.childSettlementUnproven, true);
    assert.deepEqual(frozenPropagated.recoveryAuthority,
      { controlDirectory: '/tmp/frozen-outer-control' });
    assert.equal(Object.hasOwn(frozenPropagated, 'cause'), false,
      'the fallback must not retain the frozen graph as a reachable cause');
    assert.doesNotMatch(JSON.stringify(frozenPropagated.recoveryAuthority), /must-not-escape/u);
  });

test('restore and verification reject a relative frozen backup root before locks or snapshots',
  async () => {
    const operations = [
      ['restore', (await import('../scripts/postgres-restore.js')).restorePostgresBackup],
      ['verify', (await import('../scripts/postgres-verify-backup.js')).verifyPostgresBackup],
    ];
    for (const [mode, operation] of operations) {
      let lockAttempts = 0;
      await assert.rejects(operation({
        acquireHostLock: async () => { lockAttempts += 1; },
        acquireOperationLock: async () => { lockAttempts += 1; },
        applicationMode: 'absent',
        backup: 'fixture.dump',
        frozenBackupRoot: 'relative-frozen-backups',
        postgresExpectedImageId: `sha256:${'b'.repeat(64)}`,
        productionAppImageId: `sha256:${'a'.repeat(64)}`,
      }), /Frozen backup root must be an absolute filesystem path/u);
      assert.equal(lockAttempts, 0, `${mode} must reject the root before lock or snapshot allocation`);
    }
  });

test('database child signal errors remain handled and preserve the bounded cleanup contract', () => {
  for (const script of [
    'postgres-backup.js',
    'postgres-restore.js',
    'postgres-verify-backup.js',
  ]) {
    const moduleUrl = new URL(`../scripts/${script}`, import.meta.url).href;
    const source = [
      'import { EventEmitter } from "node:events";',
      'import { PassThrough } from "node:stream";',
      `const module = await import(${JSON.stringify(moduleUrl)});`,
      'const child = new EventEmitter();',
      'child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();',
      'let wrapperClosed = false;',
      'const control = { dispose() { if (!wrapperClosed) throw new Error("unproven fake session"); }, markWrapperSpawned() {}, observeWrapperClose() { wrapperClosed = true; }, proofState() { return { state: wrapperClosed ? "absent" : "alive" }; }, request(signal) { queueMicrotask(() => child.emit("error", new Error(`${signal} async delivery failed`))); }, specification: { controlDirectory: "/tmp/easyboost-test-owned-posix-session" } };',
      'const childLifecycle = { forcePosixSession: true, platform: "linux", posixSessionControl: control, posixSessionInvocation(command, args, cwd, settlementMilliseconds, environment, authority) { return { args, command, cwd, environment, posixSessionControl: authority }; } };',
      'const keepAlive = setInterval(() => {}, 1000);',
      'const messages = (error, seen = new Set()) => {',
      '  if (!error || seen.has(error)) return []; seen.add(error);',
      '  return [error.message, ...(error.errors || []).flatMap((item) => messages(item, seen)), ...messages(error.cause, seen)];',
      '};',
      'try {',
      '  await module.runDockerCommand(["version"], { childLifecycle, commandTimeoutMs: 5, killGraceMs: 5, reapTimeoutMs: 10, spawnProcess: () => child });',
      '  process.exitCode = 9;',
      '} catch (error) {',
      '  console.log(JSON.stringify({ childSettlementUnproven: error.childSettlementUnproven, messages: messages(error) }));',
      '} finally {',
      '  clearInterval(keepAlive);',
      '}',
    ].join('\n');
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
      encoding: 'utf8',
      timeout: 2_000,
    });
    assert.equal(result.status, 0, `${script}\n${result.stdout}\n${result.stderr}`);
    const outcome = JSON.parse(result.stdout.trim());
    assert.equal(outcome.childSettlementUnproven, true);
    assert.ok(outcome.messages.some((message) => /timed out after 5ms/u.test(message)));
    assert.ok(outcome.messages.some((message) => /SIGTERM async delivery failed/u.test(message)));
    assert.ok(outcome.messages.some((message) => /SIGKILL async delivery failed/u.test(message)));
  }
});

test('database operation locks remain owned when local child settlement is unproven', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-unsettled-child-lock-'));
  try {
    const backup = path.join(directory, 'source.dump');
    await fs.writeFile(backup, 'source archive bytes', { mode: 0o600 });
    const applicationImageId = `sha256:${'a'.repeat(64)}`;
    const postgresImageId = `sha256:${'b'.repeat(64)}`;
    for (const mode of ['backup', 'restore', 'verify']) {
      let databaseReleases = 0;
      let hostReleases = 0;
      const childLeaf = Object.assign(new Error(`${mode} local Docker child settlement unproven`), {
        childSettlementUnproven: true,
        recoveryAuthority: { controlDirectory: path.join(directory, `${mode}-child-control`) },
      });
      const childFailure = new AggregateError(
        [childLeaf],
        `${mode} local Docker child settlement unproven nested lifecycle failure`,
        { cause: childLeaf },
      );
      const common = {
        acquireOperationLock: async () => async () => { databaseReleases += 1; },
        backup,
        frozenBackupRoot: path.join(directory, 'isolated-frozen-backups'),
        lockFile: path.join(directory, `${mode}.lock`),
        postgresExpectedImageId: postgresImageId,
        productionAppImageId: applicationImageId,
        runDocker: async () => { throw childFailure; },
      };
      let execution;
      if (mode === 'backup') {
        const { createPostgresBackup } = await import('../scripts/postgres-backup.js');
        execution = createPostgresBackup({
          ...common,
          destination: path.join(directory, 'generated.dump'),
          log() {},
        });
      } else if (mode === 'restore') {
        const { restorePostgresBackup } = await import('../scripts/postgres-restore.js');
        execution = restorePostgresBackup({
          ...common,
          acquireHostLock: async () => async () => { hostReleases += 1; },
          hostLockDirectory: path.join(directory, 'host.lock'),
          releaseHostLock: async (release) => { await release(); },
          log() {},
        });
      } else {
        const { verifyPostgresBackup } = await import('../scripts/postgres-verify-backup.js');
        execution = verifyPostgresBackup({
          ...common,
          backupDirectory: directory,
          publishStatus: async () => {},
        });
      }

      await assert.rejects(execution, (error) => {
        assert.equal(error.childSettlementUnproven, true);
        assert.match(error.message, /local Docker child settlement unproven/u);
        return true;
      });
      assert.equal(databaseReleases, 0,
        `${mode} must leave its database operation lock owned for manual recovery`);
      if (mode === 'restore') {
        assert.equal(hostReleases, 0,
          'restore must also leave the host-operation guard owned while child settlement is unknown');
      }
    }
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('restore leaves both guards untouched when remote retention and local hold are unresolved',
  async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-combined-hold-'));
    const frozenBackupRoot = path.join(directory, 'isolated-frozen-backups');
    try {
      const backup = path.join(directory, 'source.dump');
      await fs.writeFile(backup, 'source archive bytes', { mode: 0o600 });
      const settlementError = new Error('remote and local restore settlement are both unproven');
      settlementError.childSettlementUnproven = true;
      settlementError.retainOperationLock = true;
      settlementError.recoveryEvidence = restoreRecoveryEvidence(canonicalPostgresContainerId, {
        activityCount: 1,
        process: 'ACTIVE',
        status: 'RUNNING',
      });
      const finalizations = [];
      const postgresImageId = `sha256:${'b'.repeat(64)}`;
      const runDocker = async (arguments_) => {
        if (arguments_.includes('ps') && arguments_.at(-1) === 'postgres') {
          return canonicalPostgresContainerId;
        }
        if (arguments_[0] === 'inspect'
            && arguments_.at(-1) === canonicalPostgresContainerId) {
          return exactPostgresProof(postgresImageId);
        }
        return '';
      };
      const { restorePostgresBackup } = await import('../scripts/postgres-restore.js');
      let reportedError;
      await assert.rejects(restorePostgresBackup({
        acquireHostLock: async () => async () => { finalizations.push('host-release'); },
        acquireOperationLock: async () => async () => { finalizations.push('db-release'); },
        applicationMode: 'absent',
        backup,
        frozenBackupRoot,
        hostLockDirectory: path.join(directory, 'host.lock'),
        lockFile: path.join(directory, 'database.lock'),
        log() {},
        postgresExpectedImageId: postgresImageId,
        productionAppImageId: `sha256:${'a'.repeat(64)}`,
        releaseHostLock: async (release) => { await release(); },
        retainHostLock: async () => { finalizations.push('host-retain'); },
        retainOperationLock: async () => { finalizations.push('db-retain'); },
        runDocker,
        runSupervisedRestore: async () => { throw settlementError; },
      }), (error) => {
        reportedError = error;
        assert.equal(error, settlementError);
        assert.equal(error.childSettlementUnproven, true);
        return true;
      });
      assert.deepEqual(finalizations, [],
        'the exact local-child hold must block DB and host release or retention alike');
      const frozenDirectories = await fs.readdir(frozenBackupRoot);
      assert.equal(frozenDirectories.length, 1,
        'restore keeps the skipped snapshot in its test-only isolated root');
      const frozenBackupDirectory = path.join(frozenBackupRoot, frozenDirectories[0]);
      assert.ok((await fs.stat(frozenBackupDirectory)).isDirectory());
      assert.deepEqual(reportedError.recoveryAuthority, { frozenBackupDirectory });
      assert.ok(Object.isFrozen(reportedError.recoveryAuthority));
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

test('backup verification leaves its database guard untouched when remote retention and local hold are unresolved',
  async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-verify-combined-hold-'));
    try {
      const backup = path.join(directory, 'source.dump');
      await fs.writeFile(backup, 'source archive bytes', { mode: 0o600 });
      const settlementLeaf = Object.assign(
        new Error('remote and local verification settlement are both unproven'),
        {
          childSettlementUnproven: true,
          recoveryAuthority: { controlDirectory: path.join(directory, 'verify-child-control') },
        },
      );
      const settlementError = new AggregateError([settlementLeaf], 'nested verification settlement');
      settlementError.retainOperationLock = true;
      settlementError.recoveryEvidence = restoreRecoveryEvidence(canonicalPostgresContainerId, {
        activityCount: 1,
        process: 'ACTIVE',
        status: 'RUNNING',
      });
      const finalizations = [];
      const postgresImageId = `sha256:${'b'.repeat(64)}`;
      const { verifyPostgresBackup } = await import('../scripts/postgres-verify-backup.js');
      await assert.rejects(verifyPostgresBackup({
        acquireOperationLock: async () => async () => { finalizations.push('db-release'); },
        backup,
        backupDirectory: directory,
        frozenBackupRoot: path.join(directory, 'isolated-frozen-backups'),
        createVerificationRuntime: async () => ({
          cleanup: async () => { finalizations.push('runtime-cleanup'); },
          containerId: canonicalPostgresContainerId,
          isolation: 'disposable-exact-image-container',
          volumeName: 'test-disposable-volume',
        }),
        lockFile: path.join(directory, 'database.lock'),
        postgresExpectedImageId: postgresImageId,
        productionAppImageId: `sha256:${'a'.repeat(64)}`,
        publishStatus: async () => {},
        retainOperationLock: async () => { finalizations.push('db-retain'); },
        runDocker: async (arguments_) => {
          if (arguments_[0] === 'image') return postgresImageId;
          return '';
        },
        runSupervisedRestore: async () => { throw settlementError; },
      }), (error) => {
        assert.equal(error, settlementError);
        assert.equal(error.childSettlementUnproven, true);
        return true;
      });
      assert.deepEqual(finalizations, [],
        'the exact local-child hold must block verification cleanup, release, and retention');
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

test('backup verification preserves child recovery authority through failure-status publication',
  async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-verify-authority-publication-'));
    try {
      const backup = path.join(directory, 'source.dump');
      await fs.writeFile(backup, 'source archive bytes', { mode: 0o600 });
      const controlDirectory = path.join(directory, 'owned-child-control');
      const childFailure = Object.assign(new Error('verification child settlement is unproven'), {
        childSettlementUnproven: true,
        recoveryAuthority: { controlDirectory, authorityToken: 'must-not-escape' },
      });
      const publicationFailure = new Error('status publication failed');
      const { verifyPostgresBackup } = await import('../scripts/postgres-verify-backup.js');
      await assert.rejects(verifyPostgresBackup({
        acquireOperationLock: async () => async () => {},
        backup,
        backupDirectory: directory,
        frozenBackupRoot: path.join(directory, 'isolated-frozen-backups'),
        createVerificationRuntime: async () => ({
          containerId: canonicalPostgresContainerId,
          isolation: 'disposable-exact-image-container',
        }),
        lockFile: path.join(directory, 'database.lock'),
        postgresExpectedImageId: `sha256:${'b'.repeat(64)}`,
        productionAppImageId: `sha256:${'a'.repeat(64)}`,
        publishStatus: async () => { throw publicationFailure; },
        runDocker: async (arguments_) => (
          arguments_[0] === 'image' ? `sha256:${'b'.repeat(64)}` : ''
        ),
        runSupervisedRestore: async () => { throw childFailure; },
      }), (error) => {
        assert.ok(error instanceof AggregateError);
        assert.equal(error.childSettlementUnproven, true);
        assert.deepEqual(error.recoveryAuthority, { controlDirectory });
        assert.ok(Object.isFrozen(error.recoveryAuthority));
        assert.ok(error.recoveryAuthorities.some((authority) => (
          authority.frozenBackupDirectory
            && path.isAbsolute(authority.frozenBackupDirectory)
        )), 'the retained frozen snapshot directory joins the public authority set');
        assert.doesNotMatch(JSON.stringify(error.recoveryAuthority), /authorityToken/u);
        assert.equal(error.errors.at(-1), publicationFailure);
        return true;
      });
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

test('verification runtime cleanup child recovery retains an exact isolated frozen backup directory',
  async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-verify-runtime-child-'));
    const frozenBackupRoot = path.join(directory, 'isolated-frozen-backups');
    const controlDirectory = path.join(directory, 'runtime-child-control');
    const finalizations = [];
    let runtimeCleanups = 0;
    let reportedError;
    try {
      const backup = path.join(directory, 'source.dump');
      await fs.writeFile(backup, 'source archive bytes', { mode: 0o600 });
      const cleanupLeaf = Object.assign(new Error('verification cleanup child remains unsettled'), {
        childSettlementUnproven: true,
        recoveryAuthority: { controlDirectory, password: 'must-not-escape' },
      });
      const cleanupFailure = new AggregateError([cleanupLeaf], 'nested verification cleanup failure');
      const { verifyPostgresBackup } = await import('../scripts/postgres-verify-backup.js');
      await assert.rejects(verifyPostgresBackup({
        acquireOperationLock: async () => async () => { finalizations.push('db-release'); },
        backup,
        backupDirectory: directory,
        createVerificationRuntime: async () => ({
          cleanup: async () => {
            runtimeCleanups += 1;
            return cleanupFailure;
          },
          containerId: canonicalPostgresContainerId,
          isolation: 'disposable-exact-image-container',
          volumeName: 'runtime-child-volume',
        }),
        frozenBackupRoot,
        lockFile: path.join(directory, 'database.lock'),
        postgresExpectedImageId: `sha256:${'b'.repeat(64)}`,
        productionAppImageId: `sha256:${'a'.repeat(64)}`,
        publishStatus: async () => {},
        retainOperationLock: async () => { finalizations.push('db-retain'); },
        runDocker: async (arguments_) => (arguments_[0] === 'image' ? `sha256:${'b'.repeat(64)}` : ''),
        runSupervisedRestore: async () => { throw new Error('verification work failed'); },
      }), (error) => {
        reportedError = error;
        assert.equal(error.childSettlementUnproven, true);
        assert.doesNotMatch(JSON.stringify(error), /must-not-escape/u);
        return true;
      });
      const frozenDirectories = await fs.readdir(frozenBackupRoot);
      assert.equal(runtimeCleanups, 1);
      assert.deepEqual(finalizations, [],
        'a runtime cleanup child hold blocks frozen-backup release and DB lock finalization');
      assert.equal(frozenDirectories.length, 1,
        'the skipped snapshot remains inside its test-only isolated root');
      const frozenBackupDirectory = path.join(frozenBackupRoot, frozenDirectories[0]);
      assert.ok((await fs.stat(frozenBackupDirectory)).isDirectory());
      assert.ok(reportedError.recoveryAuthorities.some((authority) => (
        authority.frozenBackupDirectory === frozenBackupDirectory
      )), 'the public error must name the exact retained frozen snapshot directory');
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

test('frozen snapshot release child recovery retains its exact directory for restore and verification',
  async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-frozen-release-child-'));
    try {
      const backup = path.join(directory, 'source.dump');
      await fs.writeFile(backup, 'source archive bytes', { mode: 0o600 });
      for (const mode of ['restore', 'verify']) {
        const frozenBackupDirectory = path.join(directory, `${mode}-retained-snapshot`);
        const controlDirectory = path.join(directory, `${mode}-release-child-control`);
        await fs.mkdir(frozenBackupDirectory);
        const releaseLeaf = Object.assign(new Error(`${mode} snapshot release child remains unsettled`), {
          childSettlementUnproven: true,
          recoveryAuthority: { controlDirectory, password: 'must-not-escape' },
        });
        const releaseFailure = new AggregateError([releaseLeaf], `${mode} snapshot release failed`);
        const finalizations = [];
        let releases = 0;
        const freezeBackup = async () => ({
          archiveBytes: 20,
          capacityHeadroomBytes: 1,
          handle: null,
          recoveryAuthority: {
            frozenBackupDirectory,
            authorityToken: 'must-not-escape',
          },
          release: async () => {
            releases += 1;
            throw releaseFailure;
          },
          sha256: 'a'.repeat(64),
        });
        const runDocker = async (arguments_) => {
          if (arguments_[0] === 'image') return `sha256:${'b'.repeat(64)}`;
          if (arguments_.includes('ps') && arguments_.at(-1) === 'postgres') {
            return canonicalPostgresContainerId;
          }
          if (arguments_[0] === 'inspect' && arguments_.at(-1) === canonicalPostgresContainerId) {
            return exactPostgresProof(`sha256:${'b'.repeat(64)}`);
          }
          if (arguments_.includes('pg_restore')) throw new Error(`${mode} pre-release failure`);
          if (arguments_.includes('app')) return '';
          return '';
        };
        const operation = mode === 'restore'
          ? (await import('../scripts/postgres-restore.js')).restorePostgresBackup
          : (await import('../scripts/postgres-verify-backup.js')).verifyPostgresBackup;
        await assert.rejects(operation({
          acquireHostLock: async () => async () => { finalizations.push('host-release'); },
          acquireOperationLock: async () => async () => { finalizations.push('db-release'); },
          applicationMode: 'absent',
          backup,
          backupDirectory: directory,
          createVerificationRuntime: async () => ({
            cleanup: async () => {},
            containerId: canonicalPostgresContainerId,
            isolation: 'disposable-exact-image-container',
          }),
          freezeBackup,
          frozenBackupRoot: path.join(directory, 'unused-isolated-root'),
          hostLockDirectory: path.join(directory, `${mode}.host.lock`),
          lockFile: path.join(directory, `${mode}.lock`),
          log() {},
          postgresExpectedImageId: `sha256:${'b'.repeat(64)}`,
          productionAppImageId: `sha256:${'a'.repeat(64)}`,
          publishStatus: async () => {},
          releaseHostLock: async (release) => { await release(); },
          retainHostLock: async () => { finalizations.push('host-retain'); },
          retainOperationLock: async () => { finalizations.push('db-retain'); },
          runDocker,
          runSupervisedRestore: async () => { throw new Error(`${mode} primary failure`); },
        }), (error) => {
          assert.equal(error.childSettlementUnproven, true);
          assert.ok(error.recoveryAuthorities.some((authority) => (
            authority.frozenBackupDirectory === frozenBackupDirectory
          )));
          assert.doesNotMatch(JSON.stringify(error), /must-not-escape/u);
          return true;
        });
        assert.equal(releases, 1, `${mode} attempted exactly one snapshot release`);
        assert.deepEqual(finalizations, [],
          `${mode} blocks DB and host finalization after its snapshot release child failure`);
        assert.ok((await fs.stat(frozenBackupDirectory)).isDirectory());
      }
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

test('ordinary frozen snapshot release failure preserves its exact directory without blocking locks',
  async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-frozen-release-failure-'));
    try {
      const backup = path.join(directory, 'source.dump');
      await fs.writeFile(backup, 'source archive bytes', { mode: 0o600 });
      for (const mode of ['restore', 'verify']) {
        const frozenBackupDirectory = path.join(directory, `${mode}-retained-snapshot`);
        await fs.mkdir(frozenBackupDirectory);
        const finalizations = [];
        let releases = 0;
        const freezeBackup = async () => ({
          archiveBytes: 20,
          capacityHeadroomBytes: 1,
          handle: null,
          recoveryAuthority: { frozenBackupDirectory, token: 'must-not-escape' },
          release: async () => {
            releases += 1;
            throw new Error(`${mode} snapshot close failed`);
          },
          sha256: 'a'.repeat(64),
        });
        const runDocker = async (arguments_) => {
          if (arguments_[0] === 'image') return `sha256:${'b'.repeat(64)}`;
          if (arguments_.includes('ps') && arguments_.at(-1) === 'postgres') {
            return canonicalPostgresContainerId;
          }
          if (arguments_[0] === 'inspect' && arguments_.at(-1) === canonicalPostgresContainerId) {
            return exactPostgresProof(`sha256:${'b'.repeat(64)}`);
          }
          if (arguments_.includes('pg_restore')) throw new Error(`${mode} primary failure`);
          if (arguments_.includes('app')) return '';
          return '';
        };
        const operation = mode === 'restore'
          ? (await import('../scripts/postgres-restore.js')).restorePostgresBackup
          : (await import('../scripts/postgres-verify-backup.js')).verifyPostgresBackup;
        await assert.rejects(operation({
          acquireHostLock: async () => async () => { finalizations.push('host-release'); },
          acquireOperationLock: async () => async () => { finalizations.push('db-release'); },
          applicationMode: 'absent',
          backup,
          backupDirectory: directory,
          createVerificationRuntime: async () => ({
            cleanup: async () => {},
            containerId: canonicalPostgresContainerId,
            isolation: 'disposable-exact-image-container',
          }),
          freezeBackup,
          frozenBackupRoot: path.join(directory, 'unused-isolated-root'),
          hostLockDirectory: path.join(directory, `${mode}.host.lock`),
          lockFile: path.join(directory, `${mode}.lock`),
          log() {},
          postgresExpectedImageId: `sha256:${'b'.repeat(64)}`,
          productionAppImageId: `sha256:${'a'.repeat(64)}`,
          publishStatus: async () => {},
          releaseHostLock: async (release) => { await release(); },
          retainHostLock: async () => { finalizations.push('host-retain'); },
          retainOperationLock: async () => { finalizations.push('db-retain'); },
          runDocker,
          runSupervisedRestore: async () => { throw new Error(`${mode} supervised failure`); },
        }), (error) => {
          assert.equal(error.childSettlementUnproven, undefined);
          assert.ok(error.recoveryAuthorities?.some((authority) => (
            authority.frozenBackupDirectory === frozenBackupDirectory
          )) || error.recoveryAuthority?.frozenBackupDirectory === frozenBackupDirectory);
          assert.doesNotMatch(JSON.stringify(error), /must-not-escape/u);
          return true;
        });
        assert.equal(releases, 1);
        assert.deepEqual(finalizations, mode === 'restore'
          ? ['db-release', 'host-release']
          : ['db-release']);
        assert.ok((await fs.stat(frozenBackupDirectory)).isDirectory());
      }
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

test('restore retains the host guard only after database retention succeeds', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-retain-order-'));
  try {
    const backup = path.join(directory, 'source.dump');
    await fs.writeFile(backup, 'source archive bytes', { mode: 0o600 });
    const settlementError = new Error('remote restore settlement is unproven');
    settlementError.retainOperationLock = true;
    settlementError.recoveryEvidence = restoreRecoveryEvidence(canonicalPostgresContainerId, {
      activityCount: 1,
      process: 'ACTIVE',
      status: 'RUNNING',
    });
    const databaseRetentionFailure = new Error('database retention failed');
    const finalizations = [];
    const postgresImageId = `sha256:${'b'.repeat(64)}`;
    const runDocker = async (arguments_) => {
      if (arguments_.includes('ps') && arguments_.at(-1) === 'postgres') {
        return canonicalPostgresContainerId;
      }
      if (arguments_[0] === 'inspect'
          && arguments_.at(-1) === canonicalPostgresContainerId) {
        return exactPostgresProof(postgresImageId);
      }
      return '';
    };
    const { restorePostgresBackup } = await import('../scripts/postgres-restore.js');
    await assert.rejects(restorePostgresBackup({
      acquireHostLock: async () => async () => { finalizations.push('host-release'); },
      acquireOperationLock: async () => async () => { finalizations.push('db-release'); },
      applicationMode: 'absent',
      backup,
      hostLockDirectory: path.join(directory, 'host.lock'),
      lockFile: path.join(directory, 'database.lock'),
      log() {},
      postgresExpectedImageId: postgresImageId,
      productionAppImageId: `sha256:${'a'.repeat(64)}`,
      releaseHostLock: async (release) => { await release(); },
      retainHostLock: async () => { finalizations.push('host-retain'); },
      retainOperationLock: async () => {
        finalizations.push('db-retain');
        throw databaseRetentionFailure;
      },
      runDocker,
      runSupervisedRestore: async () => { throw settlementError; },
    }), (error) => {
      assert.ok(error instanceof AggregateError, error?.stack);
      assert.equal(error.errors[0], settlementError);
      assert.equal(error.errors[1], databaseRetentionFailure);
      return true;
    });
    assert.deepEqual(finalizations, ['db-retain'],
      'host retention must depend on successful durable database retention');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('restore keeps the host guard when database lock finalization fails', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-restore-db-release-fail-'));
  try {
    const backup = path.join(directory, 'source.dump');
    await fs.writeFile(backup, 'source archive bytes', { mode: 0o600 });
    const operationFailure = new Error('fixture restore operation failed');
    const databaseFinalizationFailure = new Error(
      'DATABASE_OPERATION_LOCK_LOCAL_CHILD_HELD: fixture',
    );
    let databaseFinalizations = 0;
    let hostReleases = 0;
    const { restorePostgresBackup } = await import('../scripts/postgres-restore.js');
    await assert.rejects(restorePostgresBackup({
      acquireHostLock: async () => async () => { hostReleases += 1; },
      acquireOperationLock: async () => async () => {
        databaseFinalizations += 1;
        throw databaseFinalizationFailure;
      },
      backup,
      hostLockDirectory: path.join(directory, 'host.lock'),
      lockFile: path.join(directory, 'database.lock'),
      log() {},
      postgresExpectedImageId: `sha256:${'b'.repeat(64)}`,
      productionAppImageId: `sha256:${'a'.repeat(64)}`,
      releaseHostLock: async (release) => { await release(); },
      runDocker: async () => { throw operationFailure; },
    }), (error) => {
      assert.ok(error instanceof AggregateError, error?.stack);
      assert.equal(error.errors[0], operationFailure);
      assert.equal(error.errors[1], databaseFinalizationFailure);
      return true;
    });
    assert.equal(databaseFinalizations, 1);
    assert.equal(hostReleases, 0,
      'host guard release must depend on successful database lock finalization');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('database Docker subprocesses share one bounded child lifecycle implementation', async () => {
  const lifecycleFile = path.join(projectDirectory, 'scripts', 'bounded-child-lifecycle.js');
  const [lifecycle, releaseSupervisor, posixSupervisor] = await Promise.all([
    fs.readFile(lifecycleFile, 'utf8'),
    fs.readFile(path.join(projectDirectory, 'scripts', 'release-command-supervisor.js'), 'utf8'),
    fs.readFile(path.join(projectDirectory, 'scripts', 'posix-session-supervisor.js'), 'utf8'),
  ]);
  assert.match(lifecycle, /export async function terminateAndReapChild/u);
  assert.match(lifecycle, /createWindowsJobInvocation/u,
    'native Windows database commands must execute inside the shared Job Object authority');
  assert.match(lifecycle, /detached: platform !== 'win32'/u,
    'POSIX database commands must be leaders of isolated process groups');
  assert.match(lifecycle, /createPosixSessionInvocation/u,
    'database commands must share the tokenized owned-session POSIX authority');
  assert.doesNotMatch(releaseSupervisor, /signalProcess\(-processGroupId/u,
    'the release caller must never signal a numeric PID or PGID');
  assert.match(posixSupervisor, /process\.kill\(0, signal\)/u,
    'only the isolated session leader may signal its own still-existing group');
  assert.match(posixSupervisor, /startTime[\s\S]*sessionId/u,
    'POSIX authority must bind both process birth and session identity');
  assert.doesNotMatch(lifecycle, /child\.kill\(/u,
    'the shared boundary must not retain a leader-only signal fallback');

  for (const script of [
    'postgres-backup.js',
    'postgres-restore.js',
    'postgres-verify-backup.js',
  ]) {
    const source = await fs.readFile(path.join(projectDirectory, 'scripts', script), 'utf8');
    assert.match(source,
      /import \{[\s\S]{0,160}?spawnBoundedChild,[\s\S]{0,160}?terminateAndReapChild,[\s\S]{0,40}?\} from '\.\/bounded-child-lifecycle\.js';/u,
      `${script} must consume the shared lifecycle boundary`);
    assert.match(source,
      /spawned = spawnBoundedChild\('docker'[\s\S]{0,500}?const \{ authority, child, childErrors \} = spawned/u,
      `${script} must spawn Docker through the shared tree authority`);
    assert.match(source, /await terminateAndReapChild\(\{/u,
      `${script} must delegate bounded termination and reap`);
    assert.doesNotMatch(source, /child\.kill\(/u,
      `${script} must not retain a second TERM to KILL implementation`);
  }
});

test('every database Docker spawn observes its durable operation-lock child hold first', async () => {
  const lockModule = await import('../scripts/database-operation-lock.js');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-docker-child-hold-'));
  try {
    for (const script of [
      'postgres-backup.js',
      'postgres-restore.js',
      'postgres-verify-backup.js',
    ]) {
      const lockFile = path.join(directory, `${script}.lock`);
      const release = await lockModule.acquireDatabaseOperationLock(lockFile);
      const child = new EventEmitter();
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => true;
      let holdPresentAtSpawn = false;
      const module = await import(`../scripts/${script}?pre-spawn-hold=${Date.now()}-${script}`);
      const output = await module.runDockerCommand(['version'], {
        capture: true,
        operationLock: release,
        spawnProcess() {
          holdPresentAtSpawn = fsSync.readdirSync(directory).some(
            (entry) => entry.startsWith(`${script}.lock.local-child-`),
          );
          setImmediate(() => {
            child.stdout.end('fixture output');
            child.stderr.end();
            child.emit('close', 0, null);
          });
          return child;
        },
      });
      assert.equal(output, 'fixture output');
      assert.equal(holdPresentAtSpawn, true,
        `${script} must durably publish its local-child hold before spawn`);
      assert.deepEqual(
        fsSync.readdirSync(directory).filter((entry) => entry.startsWith(`${script}.lock.`)).sort(),
        [`${script}.lock.authority`],
        `${script} must remove only the settled child's hold`,
      );
      await lockModule.releaseDatabaseOperationLock(release, 20);
    }
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('unsettled database Docker children leave their durable local-child holds owned', async () => {
  const lockModule = await import('../scripts/database-operation-lock.js');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-docker-child-held-'));
  try {
    for (const script of [
      'postgres-backup.js',
      'postgres-restore.js',
      'postgres-verify-backup.js',
    ]) {
      const module = await import(`../scripts/${script}?held=${Date.now()}-${script}`);
      const lockFile = path.join(directory, `${script}.lock`);
      const release = await lockModule.acquireDatabaseOperationLock(lockFile);
      const child = new EventEmitter();
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => true;
      await assert.rejects(module.runDockerCommand(['version'], {
        commandTimeoutMs: 5,
        killGraceMs: 5,
        operationLock: release,
        reapTimeoutMs: 10,
        spawnProcess: () => child,
      }), (error) => error?.childSettlementUnproven === true);
      await assert.rejects(release(), /DATABASE_OPERATION_LOCK_LOCAL_CHILD_HELD/u);
      const artifacts = (await fs.readdir(directory))
        .filter((entry) => entry.startsWith(`${script}.lock.local-child-`));
      assert.equal(artifacts.length, 1,
        `${script} must retain one durable local-child recovery authority`);
    }
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('staging runbooks match the executable 60-minute workflow timeout', async () => {
  const [workflow, readme, pwaGuide] = await Promise.all([
    fs.readFile(path.join(projectDirectory, '.github', 'workflows', 'deploy-staging.yml'), 'utf8'),
    fs.readFile(path.join(projectDirectory, 'README_DEPLOY.md'), 'utf8'),
    fs.readFile(path.join(projectDirectory, 'docs', 'AISY_PWA_RELEASE.md'), 'utf8'),
  ]);
  assert.match(workflow, /^\s*timeout-minutes:\s*60\s*$/mu);
  assert.match(readme, /workflow timeout — 60 минут/u);
  assert.match(pwaGuide, /60-minute workflow/u);
  for (const document of [readme, pwaGuide]) {
    assert.doesNotMatch(document, /45-minute workflow|workflow timeout — 45 минут/u);
  }
});

test('every database Docker capture has a hard byte cap and aborts overflowing children', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-list-capture-'));
  try {
    const backup = path.join(directory, 'source.dump');
    await fs.writeFile(backup, 'source archive bytes', { mode: 0o600 });
    const postgresContainerId = '2'.repeat(64);
    const postgresImageId = `sha256:${'b'.repeat(64)}`;
    const applicationImageId = `sha256:${'a'.repeat(64)}`;
    const postgresProof = [
      postgresContainerId, productionComposeProjectName, 'postgres', 'False', postgresImageId, 'true',
    ].join('|');
    for (const script of [
      'postgres-backup.js',
      'postgres-restore.js',
      'postgres-verify-backup.js',
    ]) {
      const module = await import(`../scripts/${script}?capture-cap=${Date.now()}-${script}`);
      const signals = [];
      const child = new EventEmitter();
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.kill = (signal) => {
        signals.push(signal);
        setImmediate(() => { child.emit('close', null, signal); });
        return true;
      };
      const execution = module.runDockerCommand(
        ['exec', '-i', postgresContainerId, 'pg_restore', '--list'],
        {
          capture: true,
          childLifecycle: fakeOwnedPosixSession(child, signals, {
            onRequest(signal) { setImmediate(() => { child.emit('close', null, signal); }); },
          }),
          commandTimeoutMs: 500,
          killGraceMs: 20,
          maxCaptureBytes: 16,
          reapTimeoutMs: 20,
          spawnProcess: () => child,
        },
      );
      setImmediate(() => { child.stdout.write(Buffer.alloc(17, 97)); });
      await assert.rejects(execution, /captured output exceeded 16 bytes/u,
        `${script} must reject output immediately at the configured byte boundary`);
      assert.deepEqual(signals, ['SIGTERM'], `${script} must abort the overflowing child`);

      if (script === 'postgres-backup.js') continue;

      let listOptions;
      const stopAtList = new Error('fixture stops after bounded list capture');
      const runDocker = async (arguments_, options = {}) => {
        if (arguments_[0] === 'image') return arguments_.at(-1);
        if (arguments_[0] === 'compose' && arguments_.includes('ps')) {
          return postgresContainerId;
        }
        if (arguments_[0] === 'inspect') return postgresProof;
        if (arguments_.includes('pg_restore') && arguments_.includes('--list')) {
          listOptions = options;
          throw stopAtList;
        }
        return '';
      };
      const common = {
        backup,
        postgresExpectedImageId: postgresImageId,
        productionAppImageId: applicationImageId,
        runDocker,
      };
      await assert.rejects(script === 'postgres-restore.js'
        ? module.restorePostgresBackup({
          ...common,
          lockFile: path.join(directory, 'restore-list.lock'),
          log() {},
        })
        : module.verifyPostgresBackup({
          ...common,
          backupDirectory: directory,
          createVerificationRuntime: createTestVerificationRuntime(postgresContainerId),
          lockFile: path.join(directory, 'verify-list.lock'),
          publishStatus: async () => {},
          runSupervisedRestore: runTestSupervisedVerificationRestore,
        }), (error) => error === stopAtList);
      assert.equal(listOptions.capture, true, `${script} must capture --list through the cap`);
      assert.ok(Number.isSafeInteger(listOptions.maxCaptureBytes)
        && listOptions.maxCaptureBytes > 0
        && listOptions.maxCaptureBytes <= 8 * 1024 * 1024,
      `${script} must apply a finite production --list capture cap`);
    }
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('restore Docker capture applies one hard byte cap across stderr as well as stdout', async () => {
  const { runDockerCommand } = await import('../scripts/postgres-restore.js?stderr-cap');
  const signals = [];
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = (signal) => {
    signals.push(signal);
    setImmediate(() => { child.emit('close', null, signal); });
    return true;
  };
  const stderrDestination = new Writable({
    write(_chunk, _encoding, callback) { callback(); },
  });
  const execution = runDockerCommand(['exec', 'probe'], {
    capture: true,
    childLifecycle: fakeOwnedPosixSession(child, signals, {
      onRequest(signal) { setImmediate(() => { child.emit('close', null, signal); }); },
    }),
    commandTimeoutMs: 500,
    killGraceMs: 20,
    maxCaptureBytes: 16,
    reapTimeoutMs: 20,
    spawnProcess: () => child,
    stderrDestination,
  });
  setImmediate(() => { child.stderr.write(Buffer.alloc(17, 0x65)); });
  await assert.rejects(execution, /captured output exceeded 16 bytes/u,
    'control stderr must be bounded by the same capture budget');
  assert.deepEqual(signals, ['SIGTERM'],
    'stderr overflow must immediately terminate the child');
});

test('database Docker stream errors remain primary through bounded child cleanup', async () => {
  for (const script of [
    'postgres-backup.js',
    'postgres-restore.js',
    'postgres-verify-backup.js',
  ]) {
    const module = await import(`../scripts/${script}?stream-errors=${Date.now()}-${script}`);
    for (const channel of ['stdout', 'stderr']) {
      const streamError = new Error(`${script} ${channel} transport failed`);
      const signals = [];
      const child = new EventEmitter();
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = (signal) => {
        signals.push(signal);
        return true;
      };
      const execution = module.runDockerCommand(['inspect'], {
        capture: true,
        childLifecycle: fakeOwnedPosixSession(child, signals),
        commandTimeoutMs: 500,
        killGraceMs: 5,
        maxCaptureBytes: 64,
        reapTimeoutMs: 10,
        spawnProcess: () => child,
      });
      setImmediate(() => {
        try {
          child[channel].emit('error', streamError);
        } catch {
          child.emit('close', 0, null);
        }
      });
      await assert.rejects(execution, (error) => {
        assert.ok(error instanceof AggregateError,
          `${script} must retain stream and unreaped-child failures`);
        assert.equal(error.errors[0], streamError,
          `${script} ${channel} failure must remain the primary error`);
        assert.match(error.errors[1].message, /did not close after SIGKILL within 10ms/u);
        assert.equal(error.cause, streamError);
        return true;
      });
      assert.deepEqual(signals, ['SIGTERM', 'SIGKILL'],
        `${script} must abort and bound reap immediately after ${channel} failure`);
    }
  }
});

test('database Docker stderr forwarding honors backpressure and destination errors', async () => {
  for (const script of [
    'postgres-backup.js',
    'postgres-restore.js',
    'postgres-verify-backup.js',
  ]) {
    const module = await import(`../scripts/${script}?stderr-sink=${Date.now()}-${script}`);
    const destinationError = new Error(`${script} parent stderr failed`);
    const signals = [];
    let destinationWrites = 0;
    const stderrDestination = new Writable({
      highWaterMark: 1,
      write(_chunk, _encoding, _callback) {
        destinationWrites += 1;
      },
    });
    stderrDestination.on('error', () => {});
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = (signal) => {
      signals.push(signal);
      setImmediate(() => { child.emit('close', null, signal); });
      return true;
    };
    const execution = module.runDockerCommand(['inspect'], {
      capture: true,
      childLifecycle: fakeOwnedPosixSession(child, signals, {
        onRequest(signal) { setImmediate(() => { child.emit('close', null, signal); }); },
      }),
      commandTimeoutMs: 100,
      killGraceMs: 10,
      maxCaptureBytes: 64,
      reapTimeoutMs: 20,
      spawnProcess: () => child,
      stderrDestination,
    });
    setImmediate(() => {
      child.stderr.write(Buffer.alloc(32, 0x65));
      child.stderr.write(Buffer.alloc(32, 0x66));
    });
    setTimeout(() => { stderrDestination.destroy(destinationError); }, 10).unref?.();
    await assert.rejects(execution, (error) => error === destinationError,
      `${script} must route parent stderr failure through child cleanup`);
    assert.equal(destinationWrites, 1,
      `${script} must keep only one destination write in flight under backpressure`);
    assert.deepEqual(signals, ['SIGTERM'],
      `${script} must terminate the child immediately after parent stderr failure`);
  }
});

test('database tools bind every PostgreSQL command to one proven immutable container ID',
  async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-postgres-identity-'));
    try {
      const postgresContainerId = '2'.repeat(64);
      const appContainerId = '1'.repeat(64);
      const postgresImageId = `sha256:${'b'.repeat(64)}`;
      const applicationImageId = `sha256:${'a'.repeat(64)}`;
      const backup = path.join(directory, 'source.dump');
      const generatedBackup = path.join(directory, 'generated.dump');
      const migrationsDirectory = path.join(projectDirectory, 'migrations');
      const expectedMigrations = (await fs.readdir(migrationsDirectory))
        .filter((file) => /^\d{3}_[a-z0-9_]+\.sql$/u.test(file))
        .sort();
      await fs.writeFile(backup, 'immutable fake backup bytes', 'utf8');
      const proof = [postgresContainerId, productionComposeProjectName, 'postgres', 'False', postgresImageId, 'true'].join('|');
      const allCalls = [];
      const makeDocker = ({ appLifecycle = false, backupOutput = false } = {}) => {
        let appRunning = true;
        return async (arguments_, options = {}) => {
          allCalls.push(arguments_);
          if (arguments_[0] === 'image') return arguments_.at(-1);
          if (arguments_[0] === 'compose' && arguments_.includes('ps')
              && arguments_.at(-1) === 'postgres') return postgresContainerId;
          if (arguments_[0] === 'inspect' && arguments_.at(-1) === postgresContainerId) {
            return proof;
          }
          if (appLifecycle && arguments_[0] === 'compose' && arguments_.includes('ps')
              && arguments_.at(-1) === 'app') return appContainerId;
          if (appLifecycle && arguments_[0] === 'inspect'
              && arguments_.at(-1) === appContainerId) {
            return [appContainerId, productionComposeProjectName, 'app', 'False', applicationImageId, String(appRunning)].join('|');
          }
          if (appLifecycle && arguments_[0] === 'stop') appRunning = false;
          if (appLifecycle && arguments_[0] === 'start') appRunning = true;
          if (backupOutput && arguments_.includes('pg_dump')) {
            await fs.writeFile(options.outputFile, 'generated immutable dump', { mode: 0o600 });
          }
          if (arguments_.includes('psql')) {
            const query = arguments_.at(-1);
            if (query.includes('information_schema.tables')) {
              return ['module_attempts', 'schema_migrations', 'user_progress', 'users', 'word_progress'].join('\n');
            }
            if (query.includes('SELECT version')) return expectedMigrations.join('\n');
            return `3:5:7:11:${expectedMigrations.length}`;
          }
          return '';
        };
      };
      const { createPostgresBackup } = await import('../scripts/postgres-backup.js');
      await createPostgresBackup({
        destination: generatedBackup,
        lockFile: path.join(directory, 'backup.lock'),
        postgresExpectedImageId: postgresImageId,
        productionAppImageId: applicationImageId,
        runDocker: makeDocker({ backupOutput: true }),
        log() {},
      });
      const { restorePostgresBackup } = await import('../scripts/postgres-restore.js');
      await restorePostgresBackup({
        backup,
        checkReadiness: async () => ({ ok: true }),
        lockFile: path.join(directory, 'restore.lock'),
        postgresExpectedImageId: postgresImageId,
        productionAppImageId: applicationImageId,
        runDocker: makeDocker({ appLifecycle: true }),
        runSupervisedRestore: async ({ postgresContainerId: supervisedContainerId }) => {
          allCalls.push(['exec', '-i', supervisedContainerId, 'pg_restore', '--supervised']);
        },
        log() {},
      });
      const { verifyPostgresBackup } = await import('../scripts/postgres-verify-backup.js');
      await verifyPostgresBackup({
        backup,
        backupDirectory: directory,
        createVerificationRuntime: createTestVerificationRuntime(postgresContainerId),
        lockFile: path.join(directory, 'verify.lock'),
        migrationsDirectory,
        postgresExpectedImageId: postgresImageId,
        productionAppImageId: applicationImageId,
        runDocker: makeDocker(),
        runSupervisedRestore: runTestSupervisedVerificationRestore,
        statusFile: path.join(directory, 'status.json'),
      });

      const databasePrograms = new Set(['pg_dump', 'pg_restore', 'createdb', 'psql', 'dropdb']);
      const databaseCalls = allCalls.filter((arguments_) => (
        arguments_.some((argument) => databasePrograms.has(argument))
      ));
      assert.ok(databaseCalls.length >= 9, 'fixture must exercise every database command family');
      for (const arguments_ of databaseCalls) {
        assert.deepEqual(arguments_.slice(0, 3), ['exec', '-i', postgresContainerId],
          `database command must target the immutable PostgreSQL ID: ${arguments_.join(' ')}`);
      }
      assert.equal(allCalls.some((arguments_) => (
        arguments_[0] === 'compose' && arguments_.includes('exec')
      )), false, 'no database command may re-resolve the mutable Compose postgres service');
      assert.equal(allCalls.some((arguments_) => (
        arguments_[0] === 'inspect'
          && arguments_.includes('{{.Id}}|{{ index .Config.Labels "com.docker.compose.project" }}|{{ index .Config.Labels "com.docker.compose.service" }}|{{ index .Config.Labels "com.docker.compose.oneoff" }}|{{.Image}}|{{.State.Running}}')
          && arguments_.at(-1) === postgresContainerId
      )), true, 'the canonical ID, service, oneoff, image and running state must be proven together');
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

test('restore and verification keep using frozen backup bytes after replacement or short writes',
  async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-frozen-backup-'));
    try {
      const originalBytes = Buffer.from('owner approved immutable archive bytes');
      const foreignBytes = Buffer.from('attacker replacement archive bytes');
      const expectedDigest = crypto.createHash('sha256').update(originalBytes).digest('hex');
      const postgresContainerId = '2'.repeat(64);
      const appContainerId = '1'.repeat(64);
      const postgresImageId = `sha256:${'b'.repeat(64)}`;
      const applicationImageId = `sha256:${'a'.repeat(64)}`;
      const postgresProof = [
        postgresContainerId, productionComposeProjectName, 'postgres', 'False', postgresImageId, 'true',
      ].join('|');
      const migrationsDirectory = path.join(projectDirectory, 'migrations');
      const expectedMigrations = (await fs.readdir(migrationsDirectory))
        .filter((file) => /^\d{3}_[a-z0-9_]+\.sql$/u.test(file))
        .sort();
      const exercise = async (mode, replacement) => {
        const backup = path.join(directory, `${mode}-${replacement}.dump`);
        await fs.writeFile(backup, originalBytes, { mode: 0o600 });
        const consumed = [];
        let replaced = false;
        let shortWriteCalls = 0;
        let appRunning = true;
        const runDocker = async (arguments_, options = {}) => {
          if (arguments_[0] === 'image') return arguments_.at(-1);
          if (arguments_[0] === 'compose' && arguments_.includes('ps')
              && arguments_.at(-1) === 'postgres') return postgresContainerId;
          if (arguments_[0] === 'inspect' && arguments_.at(-1) === postgresContainerId) {
            return postgresProof;
          }
          if (arguments_[0] === 'compose' && arguments_.includes('ps')
              && arguments_.at(-1) === 'app') return appContainerId;
          if (arguments_[0] === 'inspect' && arguments_.at(-1) === appContainerId) {
            return [appContainerId, productionComposeProjectName, 'app', 'False', applicationImageId, String(appRunning)].join('|');
          }
          if (arguments_[0] === 'stop') appRunning = false;
          if (arguments_[0] === 'start') appRunning = true;
          if (arguments_.includes('pg_restore') && (arguments_.includes('--list')
              || arguments_.includes('--exit-on-error'))) {
            consumed.push(await readDockerInput(options));
            if (arguments_.includes('--list') && !replaced) {
              replaced = true;
              if (replacement === 'path') {
                await fs.rename(backup, `${backup}.validated`);
                await fs.writeFile(backup, foreignBytes, { mode: 0o600 });
              } else if (replacement === 'content') {
                await fs.writeFile(backup, foreignBytes, { mode: 0o600 });
              }
            }
          }
          if (arguments_.includes('psql')) {
            const query = arguments_.at(-1);
            if (query.includes('information_schema.tables')) {
              return ['module_attempts', 'schema_migrations', 'user_progress', 'users', 'word_progress'].join('\n');
            }
            if (query.includes('SELECT version')) return expectedMigrations.join('\n');
            return `3:5:7:11:${expectedMigrations.length}`;
          }
          return '';
        };
        if (mode === 'restore') {
          const { restorePostgresBackup } = await import('../scripts/postgres-restore.js');
          const result = await restorePostgresBackup({
            backup,
            checkReadiness: async () => ({ ok: true }),
            lockFile: path.join(directory, `${mode}.lock`),
            postgresExpectedImageId: postgresImageId,
            productionAppImageId: applicationImageId,
            runDocker,
            runSupervisedRestore: async ({ inputHandle }) => {
              consumed.push(await readDockerInput({ inputHandle }));
            },
            ...(replacement === 'short-write' ? {
              async writeFrozenChunk(handle, chunk, offset, length, position) {
                shortWriteCalls += 1;
                const shortLength = Math.max(1, Math.floor(length / 2));
                return handle.write(chunk, offset, shortLength, position);
              },
            } : {}),
            log() {},
          });
          assert.equal(result.backupSha256, expectedDigest,
            'restore evidence must bind success to the frozen archive digest');
        } else {
          const { verifyPostgresBackup } = await import('../scripts/postgres-verify-backup.js');
          const result = await verifyPostgresBackup({
            backup,
            backupDirectory: directory,
            createVerificationRuntime: createTestVerificationRuntime(postgresContainerId),
            lockFile: path.join(directory, `${mode}-${replacement}.lock`),
            migrationsDirectory,
            postgresExpectedImageId: postgresImageId,
            productionAppImageId: applicationImageId,
            runDocker,
            runSupervisedRestore: runTestSupervisedVerificationRestore,
            statusFile: path.join(directory, `${mode}-status.json`),
            ...(replacement === 'short-write' ? {
              async writeFrozenChunk(handle, chunk, offset, length, position) {
                shortWriteCalls += 1;
                const shortLength = Math.max(1, Math.floor(length / 2));
                return handle.write(chunk, offset, shortLength, position);
              },
            } : {}),
          });
          assert.equal(result.backupSha256, expectedDigest,
            'published verification evidence must identify the frozen archive digest');
        }
        assert.equal(consumed.length, 2, `${mode} fixture must validate and consume the archive`);
        assert.deepEqual(consumed, [originalBytes, originalBytes],
          `${mode} must never reopen replacement bytes through the mutable path`);
        if (replacement === 'short-write') {
          assert.ok(shortWriteCalls > 1,
            `${mode} must retry legal short snapshot writes until every byte is frozen`);
        }
      };
      await exercise('restore', 'path');
      await exercise('verify', 'path');
      await exercise('restore', 'content');
      await exercise('verify', 'content');
      await exercise('restore', 'short-write');
      await exercise('verify', 'short-write');
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

test('restore and verification reject unsafe archive types and size before pg_restore',
  async (context) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-unsafe-backup-'));
    try {
      const regular = path.join(directory, 'regular.dump');
      const hardLinked = path.join(directory, 'hard-linked.dump');
      const secondLink = path.join(directory, 'hard-linked-copy.dump');
      const oversized = path.join(directory, 'oversized.dump');
      const directoryArchive = path.join(directory, 'directory.dump');
      const symlink = path.join(directory, 'symlink.dump');
      await fs.writeFile(regular, 'safe bytes', { mode: 0o600 });
      await fs.writeFile(hardLinked, 'linked bytes', { mode: 0o600 });
      await fs.link(hardLinked, secondLink);
      await fs.writeFile(oversized, 'five!', { mode: 0o600 });
      await fs.mkdir(directoryArchive);
      let symlinkCreated = true;
      try {
        await fs.symlink(regular, symlink, 'file');
      } catch (error) {
        if (error.code !== 'EPERM') throw error;
        symlinkCreated = false;
        context.diagnostic('file symlink creation is unavailable; source still asserts no-follow flags');
      }
      const sources = [
        [directoryArchive, /BACKUP_ARCHIVE_NOT_REGULAR/u, 1024],
        [hardLinked, /BACKUP_ARCHIVE_MULTIPLE_LINKS/u, 1024],
        [oversized, /BACKUP_ARCHIVE_TOO_LARGE/u, 4],
        ...(symlinkCreated ? [[symlink, /BACKUP_ARCHIVE_SYMLINK/u, 1024]] : []),
      ];
      const postgresContainerId = '2'.repeat(64);
      const postgresImageId = `sha256:${'b'.repeat(64)}`;
      const applicationImageId = `sha256:${'a'.repeat(64)}`;
      const postgresProof = [
        postgresContainerId, productionComposeProjectName, 'postgres', 'False', postgresImageId, 'true',
      ].join('|');
      const modules = [
        ['restore', (await import('../scripts/postgres-restore.js')).restorePostgresBackup],
        ['verify', (await import('../scripts/postgres-verify-backup.js')).verifyPostgresBackup],
      ];
      for (const [mode, operation] of modules) {
        for (const [backup, expectedError, maxBackupBytes] of sources) {
          let pgCommandStarted = false;
          const runDocker = async (arguments_) => {
            if (arguments_[0] === 'compose' && arguments_.includes('ps')
                && arguments_.at(-1) === 'postgres') return postgresContainerId;
            if (arguments_[0] === 'inspect' && arguments_.at(-1) === postgresContainerId) {
              return postgresProof;
            }
            if (arguments_.some((argument) => (
              ['pg_restore', 'createdb', 'psql', 'dropdb'].includes(argument)
            ))) pgCommandStarted = true;
            throw new Error(`unexpected Docker call: ${arguments_.join(' ')}`);
          };
          const common = {
            backup,
            maxBackupBytes,
            postgresExpectedImageId: postgresImageId,
            productionAppImageId: applicationImageId,
            runDocker,
          };
          await assert.rejects(mode === 'restore'
            ? operation({
              ...common,
              lockFile: path.join(directory, `${path.basename(backup)}.lock`),
              log() {},
            })
            : operation({
              ...common,
              backupDirectory: directory,
              lockFile: path.join(directory, `verify-${path.basename(backup)}.lock`),
              publishStatus: async () => {},
            }), expectedError, `${mode} must reject ${backup}`);
          assert.equal(pgCommandStarted, false,
            `${mode} must reject an unsafe archive before any PostgreSQL command`);
        }
      }
      if (!symlinkCreated) {
        for (const script of ['postgres-restore.js', 'postgres-verify-backup.js']) {
          const source = await fs.readFile(path.join(projectDirectory, 'scripts', script), 'utf8');
          assert.match(source, /O_NOFOLLOW/u, `${script} must request no-follow where supported`);
        }
      }
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

test('restore and verification reject a hard link added during archive freeze', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-freeze-hardlink-race-'));
  try {
    const postgresContainerId = '2'.repeat(64);
    const postgresImageId = `sha256:${'b'.repeat(64)}`;
    const applicationImageId = `sha256:${'a'.repeat(64)}`;
    const postgresProof = exactPostgresProof(postgresImageId, postgresContainerId);
    const operations = [
      ['restore', (await import('../scripts/postgres-restore.js')).restorePostgresBackup],
      ['verify', (await import('../scripts/postgres-verify-backup.js')).verifyPostgresBackup],
    ];
    for (const [mode, operation] of operations) {
      const backup = path.join(directory, `${mode}.dump`);
      const addedLink = path.join(directory, `${mode}-added-link.dump`);
      await fs.writeFile(backup, 'archive bytes frozen under race', { mode: 0o600 });
      let linkAdded = false;
      let pgCommandStarted = false;
      const runDocker = async (arguments_) => {
        if (arguments_[0] === 'compose' && arguments_.includes('ps')) {
          return postgresContainerId;
        }
        if (arguments_[0] === 'inspect') return postgresProof;
        if (arguments_.includes('pg_restore')) pgCommandStarted = true;
        throw new Error(`unexpected Docker call: ${arguments_.join(' ')}`);
      };
      const common = {
        backup,
        postgresExpectedImageId: postgresImageId,
        productionAppImageId: applicationImageId,
        runDocker,
        async writeFrozenChunk(handle, chunk, offset, length, position) {
          if (!linkAdded) {
            linkAdded = true;
            await fs.link(backup, addedLink);
          }
          return handle.write(chunk, offset, length, position);
        },
      };
      await assert.rejects(mode === 'restore'
        ? operation({
          ...common,
          lockFile: path.join(directory, `${mode}.lock`),
          log() {},
        })
        : operation({
          ...common,
          backupDirectory: directory,
          lockFile: path.join(directory, `${mode}.lock`),
          publishStatus: async () => {},
        }), /BACKUP_ARCHIVE_MULTIPLE_LINKS/u);
      assert.equal(linkAdded, true, `${mode} fixture must add the link after descriptor open`);
      assert.equal(pgCommandStarted, false,
        `${mode} must reject the changed link count before pg_restore`);
    }
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('restore and verification reject same-size in-place mutation during archive freeze',
  async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-freeze-content-race-'));
    try {
      const postgresContainerId = '2'.repeat(64);
      const postgresImageId = `sha256:${'b'.repeat(64)}`;
      const applicationImageId = `sha256:${'a'.repeat(64)}`;
      const postgresProof = exactPostgresProof(postgresImageId, postgresContainerId);
      const operations = [
        ['restore', (await import('../scripts/postgres-restore.js')).restorePostgresBackup],
        ['verify', (await import('../scripts/postgres-verify-backup.js')).verifyPostgresBackup],
      ];
      for (const [mode, operation] of operations) {
        const backup = path.join(directory, `${mode}.dump`);
        const original = Buffer.from('owner-approved-archive');
        const replacement = Buffer.alloc(original.length, 0x58);
        assert.equal(replacement.length, original.length, 'fixture mutation must preserve size');
        await fs.writeFile(backup, original, { mode: 0o600 });
        let mutated = false;
        let pgCommandStarted = false;
        const runDocker = async (arguments_) => {
          if (arguments_[0] === 'compose' && arguments_.includes('ps')) {
            return postgresContainerId;
          }
          if (arguments_[0] === 'inspect') return postgresProof;
          if (arguments_.some((argument) => ['pg_restore', 'createdb', 'psql', 'dropdb']
            .includes(argument))) pgCommandStarted = true;
          throw new Error(`unexpected Docker call: ${arguments_.join(' ')}`);
        };
        const common = {
          backup,
          lockFile: path.join(directory, `${mode}.lock`),
          postgresExpectedImageId: postgresImageId,
          productionAppImageId: applicationImageId,
          runDocker,
          async writeFrozenChunk(handle, chunk, offset, length, position) {
            const result = await handle.write(chunk, offset, length, position);
            if (!mutated) {
              mutated = true;
              await fs.writeFile(backup, replacement, { mode: 0o600 });
            }
            return result;
          },
        };
        await assert.rejects(mode === 'restore'
          ? operation({ ...common, log() {} })
          : operation({
            ...common,
            backupDirectory: directory,
            publishStatus: async () => {},
          }), /BACKUP_ARCHIVE_CHANGED_DURING_FREEZE/u);
        assert.equal(mutated, true, `${mode} fixture must mutate after descriptor binding`);
        assert.equal(pgCommandStarted, false,
          `${mode} must reject a same-size torn archive before pg_restore`);
      }
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

test('backup holds the shared operation lock against restore and verification contenders',
  async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-cross-tool-lock-'));
    let releaseDump;
    let owner;
    try {
      const backupSource = path.join(directory, 'source.dump');
      const backupDestination = path.join(directory, 'generated.dump');
      const lockFile = path.join(directory, '.easyboost-database-operation.lock');
      await fs.writeFile(backupSource, 'source archive bytes', { mode: 0o600 });
      const postgresContainerId = '2'.repeat(64);
      const postgresImageId = `sha256:${'b'.repeat(64)}`;
      const applicationImageId = `sha256:${'a'.repeat(64)}`;
      const postgresProof = [
        postgresContainerId, productionComposeProjectName, 'postgres', 'False', postgresImageId, 'true',
      ].join('|');
      const dumpRelease = new Promise((resolve) => { releaseDump = resolve; });
      let dumpStartedResolve;
      const dumpStarted = new Promise((resolve) => { dumpStartedResolve = resolve; });
      const { createPostgresBackup } = await import('../scripts/postgres-backup.js');
      owner = createPostgresBackup({
        destination: backupDestination,
        lockFile,
        postgresExpectedImageId: postgresImageId,
        productionAppImageId: applicationImageId,
        runDocker: async (arguments_, options = {}) => {
          if (arguments_[0] === 'compose' && arguments_.includes('ps')) {
            return postgresContainerId;
          }
          if (arguments_[0] === 'inspect') return postgresProof;
          if (arguments_.includes('pg_dump')) {
            dumpStartedResolve();
            await dumpRelease;
            await fs.writeFile(options.outputFile, 'generated dump bytes', { mode: 0o600 });
          }
          return '';
        },
        log() {},
      });
      await dumpStarted;
      let contenderDockerCalls = 0;
      const contenderDocker = async () => {
        contenderDockerCalls += 1;
        throw new Error('contender reached Docker');
      };
      const { restorePostgresBackup } = await import('../scripts/postgres-restore.js');
      await assert.rejects(restorePostgresBackup({
        backup: backupSource,
        lockFile,
        postgresExpectedImageId: postgresImageId,
        productionAppImageId: applicationImageId,
        runDocker: contenderDocker,
        log() {},
      }), /DATABASE_OPERATION_LOCKED/u);
      const { verifyPostgresBackup } = await import('../scripts/postgres-verify-backup.js');
      await assert.rejects(verifyPostgresBackup({
        backup: backupSource,
        backupDirectory: directory,
        lockFile,
        postgresExpectedImageId: postgresImageId,
        productionAppImageId: applicationImageId,
        publishStatus: async () => {},
        runDocker: contenderDocker,
      }), /DATABASE_OPERATION_LOCKED/u);
      assert.equal(contenderDockerCalls, 0,
        'every contending database tool must fail before Docker or PostgreSQL work');
      releaseDump();
      await owner;
      await assert.rejects(fs.access(lockFile), { code: 'ENOENT' },
        'successful backup must release the shared operation lock');
    } finally {
      releaseDump?.();
      await owner?.catch(() => {});
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

test('database tools remove their own lock after partial lock initialization failure', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-lock-init-failure-'));
  try {
    const backup = path.join(directory, 'source.dump');
    const prototypeProbe = path.join(directory, 'prototype-probe');
    await fs.writeFile(backup, 'source archive bytes', { mode: 0o600 });
    const probeHandle = await fs.open(prototypeProbe, 'w');
    const fileHandlePrototype = Object.getPrototypeOf(probeHandle);
    await probeHandle.close();
    const originalWrite = fileHandlePrototype.write;
    const applicationImageId = `sha256:${'a'.repeat(64)}`;
    const postgresImageId = `sha256:${'b'.repeat(64)}`;
    const operations = [
      ['backup', async (lockFile, runDocker) => {
        const { createPostgresBackup } = await import('../scripts/postgres-backup.js');
        return createPostgresBackup({
          destination: path.join(directory, 'generated.dump'),
          lockFile,
          postgresExpectedImageId: postgresImageId,
          productionAppImageId: applicationImageId,
          runDocker,
          log() {},
        });
      }],
      ['restore', async (lockFile, runDocker) => {
        const { restorePostgresBackup } = await import('../scripts/postgres-restore.js');
        return restorePostgresBackup({
          backup,
          lockFile,
          postgresExpectedImageId: postgresImageId,
          productionAppImageId: applicationImageId,
          runDocker,
          log() {},
        });
      }],
      ['verify', async (lockFile, runDocker) => {
        const { verifyPostgresBackup } = await import('../scripts/postgres-verify-backup.js');
        return verifyPostgresBackup({
          backup,
          backupDirectory: directory,
          lockFile,
          postgresExpectedImageId: postgresImageId,
          productionAppImageId: applicationImageId,
          publishStatus: async () => {},
          runDocker,
        });
      }],
    ];
    for (const [mode, operation] of operations) {
      const lockFile = path.join(directory, `${mode}.lock`);
      const setupError = new Error(`${mode} lock owner write failed`);
      let injectFailure = true;
      let dockerCalls = 0;
      fileHandlePrototype.write = async function injectedWrite(...arguments_) {
        if (injectFailure) {
          injectFailure = false;
          throw setupError;
        }
        return originalWrite.apply(this, arguments_);
      };
      try {
        await assert.rejects(operation(lockFile, async () => {
          dockerCalls += 1;
          return '';
        }), (error) => error === setupError);
      } finally {
        fileHandlePrototype.write = originalWrite;
      }
      assert.equal(dockerCalls, 0, `${mode} must fail lock setup before Docker`);
      await assert.rejects(fs.access(lockFile), { code: 'ENOENT' },
        `${mode} must remove the lock inode it created before the owner write failed`);
    }
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('database tools await operation-lock release settlement before retaining the primary failure', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-lock-release-'));
  try {
    const backup = path.join(directory, 'source.dump');
    await fs.writeFile(backup, 'source archive bytes', { mode: 0o600 });
    const applicationImageId = `sha256:${'a'.repeat(64)}`;
    const postgresImageId = `sha256:${'b'.repeat(64)}`;
    const primaryError = new Error('primary database operation failure');
    const operations = [
      ['backup', async (acquireOperationLock) => {
        const { createPostgresBackup } = await import('../scripts/postgres-backup.js');
        return createPostgresBackup({
          acquireOperationLock,
          destination: path.join(directory, 'generated.dump'),
          lockReleaseTimeoutMs: 10,
          postgresExpectedImageId: postgresImageId,
          productionAppImageId: applicationImageId,
          runDocker: async () => { throw primaryError; },
          log() {},
        });
      }],
      ['restore', async (acquireOperationLock) => {
        const { restorePostgresBackup } = await import('../scripts/postgres-restore.js');
        return restorePostgresBackup({
          acquireOperationLock,
          backup,
          hostLockDirectory: path.join(directory, 'restore-host.lock'),
          lockReleaseTimeoutMs: 10,
          postgresExpectedImageId: postgresImageId,
          productionAppImageId: applicationImageId,
          runDocker: async () => { throw primaryError; },
          log() {},
        });
      }],
      ['verify', async (acquireOperationLock) => {
        const { verifyPostgresBackup } = await import('../scripts/postgres-verify-backup.js');
        return verifyPostgresBackup({
          acquireOperationLock,
          backup,
          backupDirectory: directory,
          lockReleaseTimeoutMs: 10,
          postgresExpectedImageId: postgresImageId,
          productionAppImageId: applicationImageId,
          publishStatus: async () => {},
          runDocker: async () => { throw primaryError; },
        });
      }],
    ];
    for (const [mode, operation] of operations) {
      let allowRelease;
      let announceRelease;
      let releaseCalls = 0;
      let releaseSideEffects = 0;
      let operationSettled = false;
      const releaseStarted = new Promise((resolve) => { announceRelease = resolve; });
      const releaseBarrier = new Promise((resolve) => { allowRelease = resolve; });
      const delayedRelease = async () => async () => {
        releaseCalls += 1;
        announceRelease();
        await releaseBarrier;
        releaseSideEffects += 1;
      };
      const operationOutcome = operation(delayedRelease)
        .then(() => null, (error) => error)
        .finally(() => { operationSettled = true; });
      await releaseStarted;
      await new Promise((resolve) => { setImmediate(resolve); });
      assert.equal(operationSettled, false,
        `${mode} must not report the primary error while lock release can still mutate state`);
      assert.equal(releaseCalls, 1);
      assert.equal(releaseSideEffects, 0);
      allowRelease();
      const outcome = await operationOutcome;
      assert.equal(outcome, primaryError, `${mode} must retain the exact operation failure`);
      assert.equal(releaseSideEffects, 1);
      await new Promise((resolve) => { setImmediate(resolve); });
      assert.equal(releaseSideEffects, 1,
        `${mode} must have no late lock-release side effect after observed rejection`);
    }
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('concurrent backup writers publish one destination without replacement', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-backup-publish-race-'));
  try {
    const destination = path.join(directory, 'shared.dump');
    const postgresContainerId = '2'.repeat(64);
    const postgresImageId = `sha256:${'b'.repeat(64)}`;
    const applicationImageId = `sha256:${'a'.repeat(64)}`;
    const postgresProof = [
      postgresContainerId, productionComposeProjectName, 'postgres', 'False', postgresImageId, 'true',
    ].join('|');
    let dumpCount = 0;
    let releaseDumps;
    const bothDumpsStarted = new Promise((resolve) => { releaseDumps = resolve; });
    const temporaryPaths = new Set();
    const makeDocker = (bytes) => async (arguments_, options = {}) => {
      if (arguments_[0] === 'compose' && arguments_.includes('ps')) return postgresContainerId;
      if (arguments_[0] === 'inspect') return postgresProof;
      if (arguments_.includes('pg_dump')) {
        temporaryPaths.add(options.outputFile);
        await fs.writeFile(options.outputFile, bytes, { mode: 0o600 });
        dumpCount += 1;
        if (dumpCount === 2) releaseDumps();
        await bothDumpsStarted;
      }
      return '';
    };
    const { createPostgresBackup } = await import('../scripts/postgres-backup.js');
    const outcomes = await Promise.allSettled([
      createPostgresBackup({
        destination,
        lockFile: path.join(directory, 'writer-a.lock'),
        postgresExpectedImageId: postgresImageId,
        productionAppImageId: applicationImageId,
        runDocker: makeDocker('writer-a-bytes'),
        log() {},
      }),
      createPostgresBackup({
        destination,
        lockFile: path.join(directory, 'writer-b.lock'),
        postgresExpectedImageId: postgresImageId,
        productionAppImageId: applicationImageId,
        runDocker: makeDocker('writer-b-bytes'),
        log() {},
      }),
    ]);
    assert.equal(temporaryPaths.size, 2,
      'concurrent writers must own distinct partial dump paths');
    assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1,
      'exactly one concurrent writer may publish the destination');
    const rejected = outcomes.find((outcome) => outcome.status === 'rejected');
    assert.match(rejected.reason.message, /BACKUP_DESTINATION_ALREADY_EXISTS/u,
      'the losing writer must report the atomic no-replace boundary');
    assert.ok(['writer-a-bytes', 'writer-b-bytes'].includes(await fs.readFile(destination, 'utf8')),
      'the published destination must contain one complete writer result');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('partial dump cleanup failure remains secondary with exact recovery evidence', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-partial-cleanup-'));
  try {
    const destination = path.join(directory, 'failed.dump');
    const postgresContainerId = '2'.repeat(64);
    const postgresImageId = `sha256:${'b'.repeat(64)}`;
    const applicationImageId = `sha256:${'a'.repeat(64)}`;
    const postgresProof = [
      postgresContainerId, productionComposeProjectName, 'postgres', 'False', postgresImageId, 'true',
    ].join('|');
    const primaryError = new Error('pg_dump failed with exit code 71');
    let partialPath;
    const logs = [];
    const { createPostgresBackup } = await import('../scripts/postgres-backup.js');
    await assert.rejects(createPostgresBackup({
      destination,
      lockFile: path.join(directory, 'backup.lock'),
      postgresExpectedImageId: postgresImageId,
      productionAppImageId: applicationImageId,
      runDocker: async (arguments_, options = {}) => {
        if (arguments_[0] === 'compose' && arguments_.includes('ps')) return postgresContainerId;
        if (arguments_[0] === 'inspect') return postgresProof;
        if (arguments_.includes('pg_dump')) {
          partialPath = options.outputFile;
          await fs.mkdir(partialPath);
          await fs.writeFile(path.join(partialPath, 'unremovable-partial'), 'partial bytes');
          throw primaryError;
        }
        return '';
      },
      log(message) { logs.push(message); },
    }), (error) => {
      assert.ok(error instanceof AggregateError,
        'a cleanup failure must accompany rather than replace the dump failure');
      assert.equal(error.errors[0], primaryError);
      assert.match(error.errors[1].message, /directory|EISDIR|recursive/iu);
      assert.equal(error.cause, primaryError);
      return true;
    });
    assert.ok(partialPath, 'fixture must create an exact partial dump path');
    assert.ok(logs.some((message) => (
      message.includes(partialPath)
        && /Manual recovery required/u.test(message)
        && !/password|postgres:\/\//iu.test(message)
    )), 'cleanup failure must emit non-secret exact-path manual recovery evidence');
    await fs.access(path.join(partialPath, 'unremovable-partial'));
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('standalone backup rejects a mismatched running PostgreSQL image before pg_dump', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-backup-postgres-image-'));
  try {
    const expectedImageId = `sha256:${'b'.repeat(64)}`;
    const foreignImageId = `sha256:${'c'.repeat(64)}`;
    const backupModule = new URL('../scripts/postgres-backup.js', import.meta.url).href;
    const result = await runTemporaryModuleHarness(directory, [
      `const { createPostgresBackup } = await import(${JSON.stringify(backupModule)});`,
      'let dumpStarted = false;',
      'const runDocker = async (arguments_) => {',
      "  if (arguments_.includes('ps') && arguments_.at(-1) === 'postgres') return process.env.POSTGRES_CONTAINER_ID;",
      "  if (arguments_[0] === 'inspect' && arguments_.at(-1) === process.env.POSTGRES_CONTAINER_ID) return [process.env.POSTGRES_CONTAINER_ID, 'postgres', 'False', process.env.FOREIGN_IMAGE_ID, 'true'].join('|');",
      "  return '';",
      '};',
      'let caught;',
      'try {',
      '  await createPostgresBackup({',
      '    createDumpProcess() { dumpStarted = true; throw new Error(\'pg_dump must not start\'); },',
      '    destination: process.env.BACKUP_PATH,',
      '    postgresExpectedImageId: process.env.POSTGRES_IMAGE_ID,',
      '    productionAppImageId: process.env.APP_IMAGE_ID,',
      '    runDocker,',
      '  });',
      '} catch (error) { caught = error; }',
      "if (!caught || !/Running PostgreSQL identity, ownership or image does not match/.test(caught.message)) throw new Error('backup did not reject the mismatched image');",
      "if (dumpStarted) throw new Error('pg_dump started before exact image proof');",
    ].join('\n'), {
      APP_IMAGE_ID: `sha256:${'a'.repeat(64)}`,
      BACKUP_PATH: path.join(directory, 'backup.dump'),
      EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID: expectedImageId,
      EASYBOOST_PRODUCTION_APP_IMAGE_ID: `sha256:${'a'.repeat(64)}`,
      FOREIGN_IMAGE_ID: foreignImageId,
      POSTGRES_CONTAINER_ID: canonicalPostgresContainerId,
      POSTGRES_IMAGE_ID: expectedImageId,
    });
    assert.equal(result.status, 0,
      `backup image-authority harness failed: ${result.stdout}\n${result.stderr}`);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('backup verification rejects a mismatched running PostgreSQL image before restore work',
  async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-verify-postgres-image-'));
    try {
      const backupDirectory = path.join(directory, 'backups');
      const backup = path.join(backupDirectory, 'easyboost-image-test.dump');
      const statusFile = path.join(backupDirectory, 'restore-check-status.json');
      await fs.mkdir(backupDirectory, { recursive: true });
      await fs.writeFile(backup, 'fake pg dump bytes', 'utf8');
      const expectedImageId = `sha256:${'b'.repeat(64)}`;
      const foreignImageId = `sha256:${'c'.repeat(64)}`;
      let restoreWorkStarted = false;
      const { verifyPostgresBackup } = await import('../scripts/postgres-verify-backup.js');
      await assert.rejects(verifyPostgresBackup({
        backup,
        backupDirectory,
        createVerificationRuntime: createTestVerificationRuntime(),
        lockFile: path.join(directory, 'verify.lock'),
        postgresExpectedImageId: expectedImageId,
        productionAppImageId: `sha256:${'a'.repeat(64)}`,
        runDocker: async (arguments_) => {
          if (arguments_[0] === 'image') return foreignImageId;
          if (arguments_.includes('pg_restore') || arguments_.includes('createdb')) {
            restoreWorkStarted = true;
          }
          if (arguments_.includes('psql')) return '1:1:3:16';
          return '';
        },
        runSupervisedRestore: runTestSupervisedVerificationRestore,
        statusFile,
      }), /Approved PostgreSQL verification image is unavailable/u);
      assert.equal(restoreWorkStarted, false,
        'verification must prove the exact image before any restore work');
      const status = JSON.parse(await fs.readFile(statusFile, 'utf8'));
      assert.equal(status.status, 'failed');
      assert.match(status.errorCode, /Approved PostgreSQL verification image is unavailable/u);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

test('backup verification fails closed when a critical learning table is missing', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-verify-schema-'));
  try {
    const backupDirectory = path.join(directory, 'backups');
    const backup = path.join(backupDirectory, 'easyboost-schema-test.dump');
    const statusFile = path.join(backupDirectory, 'restore-check-status.json');
    await fs.mkdir(backupDirectory, { recursive: true });
    await fs.writeFile(backup, 'fake pg dump bytes', 'utf8');
    const postgresImageId = `sha256:${'b'.repeat(64)}`;
    const calls = [];
    const { verifyPostgresBackup } = await import('../scripts/postgres-verify-backup.js');
    await assert.rejects(verifyPostgresBackup({
      backup,
      backupDirectory,
      createVerificationRuntime: createTestVerificationRuntime(),
      lockFile: path.join(directory, 'verify.lock'),
      postgresExpectedImageId: postgresImageId,
      productionAppImageId: `sha256:${'a'.repeat(64)}`,
      runDocker: async (arguments_) => {
        calls.push(arguments_);
        if (arguments_[0] === 'image') return postgresImageId;
        if (arguments_.includes('ps') && arguments_.at(-1) === 'postgres') {
          return canonicalPostgresContainerId;
        }
        if (arguments_[0] === 'inspect') return exactPostgresProof(postgresImageId);
        if (arguments_.includes('psql')) {
          const query = arguments_.at(-1);
          if (query.includes('information_schema.tables')) {
            return ['schema_migrations', 'user_progress', 'users', 'word_progress'].join('\n');
          }
          return '1:1:3:16';
        }
        return '';
      },
      runSupervisedRestore: runTestSupervisedVerificationRestore,
      statusFile,
    }), /RESTORE_VERIFICATION_MISSING_TABLES: module_attempts/u);
    assert.ok(calls.some((arguments_) => arguments_.includes('dropdb')),
      'temporary database cleanup must still run after schema verification fails');
    const status = JSON.parse(await fs.readFile(statusFile, 'utf8'));
    assert.equal(status.status, 'failed');
    assert.match(status.errorCode, /RESTORE_VERIFICATION_MISSING_TABLES/u);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('backup verification requires the complete local migration authority including latest', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-verify-migrations-'));
  try {
    const backupDirectory = path.join(directory, 'backups');
    const backup = path.join(backupDirectory, 'easyboost-migration-test.dump');
    const statusFile = path.join(backupDirectory, 'restore-check-status.json');
    await fs.mkdir(backupDirectory, { recursive: true });
    await fs.writeFile(backup, 'fake pg dump bytes', 'utf8');
    const migrationsDirectory = path.join(projectDirectory, 'migrations');
    const expectedMigrations = (await fs.readdir(migrationsDirectory))
      .filter((file) => /^\d{3}_[a-z0-9_]+\.sql$/u.test(file))
      .sort();
    const latestMigration = expectedMigrations.at(-1);
    const postgresImageId = `sha256:${'b'.repeat(64)}`;
    const calls = [];
    const { verifyPostgresBackup } = await import('../scripts/postgres-verify-backup.js');
    await assert.rejects(verifyPostgresBackup({
      backup,
      backupDirectory,
      createVerificationRuntime: createTestVerificationRuntime(),
      lockFile: path.join(directory, 'verify.lock'),
      migrationsDirectory,
      postgresExpectedImageId: postgresImageId,
      productionAppImageId: `sha256:${'a'.repeat(64)}`,
      runDocker: async (arguments_) => {
        calls.push(arguments_);
        if (arguments_[0] === 'image') return postgresImageId;
        if (arguments_.includes('ps') && arguments_.at(-1) === 'postgres') {
          return canonicalPostgresContainerId;
        }
        if (arguments_[0] === 'inspect') return exactPostgresProof(postgresImageId);
        if (arguments_.includes('psql')) {
          const query = arguments_.at(-1);
          if (query.includes('information_schema.tables')) {
            return ['module_attempts', 'schema_migrations', 'user_progress', 'users', 'word_progress'].join('\n');
          }
          if (query.includes('SELECT version')) {
            return expectedMigrations.slice(0, -1).join('\n');
          }
          return '1:1:3:16';
        }
        return '';
      },
      runSupervisedRestore: runTestSupervisedVerificationRestore,
      statusFile,
    }), new RegExp(`RESTORE_VERIFICATION_MIGRATION_MISMATCH[\\s\\S]*${latestMigration}`, 'u'));
    assert.ok(calls.some((arguments_) => arguments_.includes('dropdb')),
      'temporary database cleanup must still run after migration verification fails');
    const status = JSON.parse(await fs.readFile(statusFile, 'utf8'));
    assert.equal(status.status, 'failed');
    assert.match(status.errorCode, /RESTORE_VERIFICATION_MIGRATION_MISMATCH/u);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('backup verification publishes counts for every critical learning table only after cleanup',
  async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-verify-complete-'));
    try {
      const backupDirectory = path.join(directory, 'backups');
      const backup = path.join(backupDirectory, 'easyboost-complete-test.dump');
      const statusFile = path.join(backupDirectory, 'restore-check-status.json');
      await fs.mkdir(backupDirectory, { recursive: true });
      await fs.writeFile(backup, 'fake pg dump bytes', 'utf8');
      const migrationsDirectory = path.join(projectDirectory, 'migrations');
      const expectedMigrations = (await fs.readdir(migrationsDirectory))
        .filter((file) => /^\d{3}_[a-z0-9_]+\.sql$/u.test(file))
        .sort();
      const postgresImageId = `sha256:${'b'.repeat(64)}`;
      const calls = [];
      const { verifyPostgresBackup } = await import('../scripts/postgres-verify-backup.js');
      const status = await verifyPostgresBackup({
        backup,
        backupDirectory,
        createVerificationRuntime: createTestVerificationRuntime(),
        lockFile: path.join(directory, 'verify.lock'),
        migrationsDirectory,
        postgresExpectedImageId: postgresImageId,
        productionAppImageId: `sha256:${'a'.repeat(64)}`,
        runDocker: async (arguments_) => {
          calls.push(arguments_);
          if (arguments_[0] === 'image') return postgresImageId;
          if (arguments_.includes('ps') && arguments_.at(-1) === 'postgres') {
            return canonicalPostgresContainerId;
          }
          if (arguments_[0] === 'inspect') return exactPostgresProof(postgresImageId);
          if (arguments_.includes('psql')) {
            const query = arguments_.at(-1);
            if (query.includes('information_schema.tables')) {
              return ['module_attempts', 'schema_migrations', 'user_progress', 'users', 'word_progress'].join('\n');
            }
            if (query.includes('SELECT version')) return expectedMigrations.join('\n');
            if (query.includes('SELECT COUNT(*) FROM user_progress')) return '3:5:7:11:58';
            return '1:1:3:58';
          }
          return '';
        },
        runSupervisedRestore: runTestSupervisedVerificationRestore,
        statusFile,
      });
      assert.deepEqual({
        migrations: status.migrations,
        moduleAttempts: status.moduleAttempts,
        userProgress: status.userProgress,
        users: status.users,
        wordProgress: status.wordProgress,
      }, {
        migrations: 58,
        moduleAttempts: 7,
        userProgress: 5,
        users: 3,
        wordProgress: 11,
      });
      const countIndex = calls.findIndex((arguments_) => (
        arguments_.includes('psql') && arguments_.at(-1).includes('SELECT COUNT(*) FROM user_progress')
      ));
      const cleanupIndex = calls.findIndex((arguments_) => arguments_.includes('dropdb'));
      assert.ok(countIndex >= 0 && cleanupIndex > countIndex,
        'critical-table verification must finish before temporary database cleanup');
      assert.deepEqual(JSON.parse(await fs.readFile(statusFile, 'utf8')), status,
        'success status must be published only after all authority checks and cleanup');
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

test('backup runbook persists and supplies canonical app and PostgreSQL authorities to both cron entrypoints',
  async () => {
    const readme = await fs.readFile(path.join(projectDirectory, 'README_DEPLOY.md'), 'utf8');
    const sectionStart = readme.indexOf('## Backup и восстановление PostgreSQL');
    const sectionEnd = readme.indexOf('## Откат приложения', sectionStart);
    const section = readme.slice(sectionStart, sectionEnd);
    const orderedPersistenceTokens = [
      ': "${EASYBOOST_PRODUCTION_APP_IMAGE_ID:?set the currently deployed owner-approved app image ID}"',
      '[[ "$EASYBOOST_PRODUCTION_APP_IMAGE_ID" =~ ^sha256:[0-9a-f]{64}$ ]]',
      ': "${EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID:?set the owner-approved PostgreSQL sha256 image ID}"',
      '[[ "$EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID" =~ ^sha256:[0-9a-f]{64}$ ]]',
      'set -euo pipefail',
      'printf \'%s\\n\' "$EASYBOOST_PRODUCTION_APP_IMAGE_ID" > "$production_app_image_authority_tmp"',
      'sudo install -o root -g root -m 0644 "$production_app_image_authority_tmp" "$production_app_image_authority_target_tmp"',
      'printf \'%s\\n\' "$EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID" > "$postgres_image_authority_tmp"',
      'sudo install -o root -g root -m 0644 "$postgres_image_authority_tmp" "$postgres_image_authority_target_tmp"',
      'sudo mv -f "$production_app_image_authority_target_tmp" /etc/easyboost/production-app-image-id',
      'sudo mv -f "$postgres_image_authority_target_tmp" /etc/easyboost/postgres-image-id',
    ];
    let cursor = -1;
    for (const token of orderedPersistenceTokens) {
      const next = section.indexOf(token, cursor + 1);
      assert.ok(next > cursor, `backup authority persistence token is missing: ${token}`);
      cursor = next;
    }
    const cronFence = section.indexOf('```cron');
    const cronEnd = section.indexOf('```', cronFence + '```cron'.length);
    const cron = section.slice(cronFence, cronEnd);
    for (const command of ['db:backup', 'db:verify-backup']) {
      assert.match(cron, new RegExp(
        `EASYBOOST_PRODUCTION_APP_IMAGE_ID="\\$\\(/bin/cat /etc/easyboost/production-app-image-id\\)" EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID="\\$\\(/bin/cat /etc/easyboost/postgres-image-id\\)" [^\\n]*${command}`,
        'u',
      ), `${command} cron must supply both persisted immutable image authorities`);
    }
  });

test('cron authority persistence fails atomically without replacing the previous approved ID',
  async (context) => {
    const probe = spawnSync(gitBash, ['--version'], { encoding: 'utf8' });
    if (probe.error?.code === 'ENOENT') return context.skip('Bash is not installed');
    const readme = await fs.readFile(path.join(projectDirectory, 'README_DEPLOY.md'), 'utf8');
    const markerIndex = readme.indexOf('production_app_image_authority_tmp="$(mktemp)"');
    const blockStart = readme.lastIndexOf('```bash', markerIndex);
    const blockEnd = readme.indexOf('```', markerIndex);
    const originalProcedure = readme.slice(blockStart + '```bash'.length, blockEnd);
    assert.ok(blockStart >= 0 && blockEnd > markerIndex,
      'cron authority persistence must remain an executable Bash block');
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-cron-authority-atomic-'));
    try {
      const authorityDirectory = path.join(directory, 'authority');
      const authorityFile = path.join(authorityDirectory, 'production-app-image-id');
      const commandLog = path.join(directory, 'commands.log');
      await fs.mkdir(authorityDirectory, { recursive: true });
      await fs.writeFile(authorityFile, 'sha256:previous-owner-approved-id\n', 'utf8');
      await fs.writeFile(commandLog, '', 'utf8');
      const procedure = originalProcedure.replaceAll(
        '/etc/easyboost', authorityDirectory.replaceAll('\\', '/'),
      );
      const harness = [
        'sudo() {',
        '  printf \'sudo %s\\n\' "$*" >> "$COMMAND_LOG"',
        '  case "$*" in',
        '    "install -d "*) return 0 ;;',
        '    "install -o root -g root -m 0644 "*)',
        '      printf \'partial-new-authority\\n\' > "${@: -1}"',
        '      return 73',
        '      ;;',
        '    *) command "$@" ;;',
        '  esac',
        '}',
      ].join('\n');
      const result = spawnSync(gitBash, ['-c', `${harness}\n${procedure}`], {
        encoding: 'utf8',
        env: {
          ...process.env,
          COMMAND_LOG: commandLog.replaceAll('\\', '/'),
          EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID: `sha256:${'e'.repeat(64)}`,
          EASYBOOST_PRODUCTION_APP_IMAGE_ID: `sha256:${'d'.repeat(64)}`,
        },
      });
      assert.notEqual(result.status, 0,
        `failed authority install must fail the procedure: ${result.stdout}\n${result.stderr}`);
      assert.equal(await fs.readFile(authorityFile, 'utf8'),
        'sha256:previous-owner-approved-id\n',
        'a failed install must leave the previous approved authority byte-identical');
      const commands = await fs.readFile(commandLog, 'utf8');
      assert.doesNotMatch(commands, /^sudo mv /mu,
        'the atomic replacement must not run after its staged install fails');
      assert.deepEqual((await fs.readdir(authorityDirectory)).sort(), ['production-app-image-id']);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

test('disaster recovery builds only from an owner-approved exact clean checkout and pins the started app image',
  async () => {
    const [builder, readme, releaseChecklist, disasterRecovery, experimentalChecklist] = await Promise.all([
      fs.readFile(path.join(projectDirectory, 'scripts', 'build-production-image.js'), 'utf8'),
      fs.readFile(path.join(projectDirectory, 'README_DEPLOY.md'), 'utf8'),
      fs.readFile(path.join(projectDirectory, 'RELEASE_CHECKLIST.md'), 'utf8'),
      fs.readFile(path.join(projectDirectory, 'docs', 'DISASTER_RECOVERY.md'), 'utf8'),
      fs.readFile(path.join(
        projectDirectory, 'docs', 'EXPERIMENTAL_RELEASE_OPERATIONS_CHECKLIST.md',
      ), 'utf8'),
    ]);
    assert.match(builder, /--expected-commit/u);
    assert.match(builder, /\^\[0-9a-f\]\{40\}\$/u,
      'the CLI must accept only a full lowercase commit identity');
    const orderedTokens = [
      'EASYBOOST_RELEASE_COMMIT',
      '^[0-9a-f]{40}$',
      'git fetch --no-tags origin "$EASYBOOST_RELEASE_COMMIT"',
      'git checkout --detach "$EASYBOOST_RELEASE_COMMIT"',
      'if git symbolic-ref -q HEAD >/dev/null; then',
      'symbolic_ref_status="$?"',
      '[ "$symbolic_ref_status" -eq 1 ] || exit 1',
      '[ "$(git rev-parse --verify HEAD)" = "$EASYBOOST_RELEASE_COMMIT" ]',
      '[ -z "$(git status --porcelain=v1 --untracked-files=all)" ]',
      'npm run production:image:build -- --expected-commit "$EASYBOOST_RELEASE_COMMIT"',
      'production_app_image_id="$(docker image inspect --format \'{{.Id}}\' easyboost-production-app:local)"',
      'export EASYBOOST_PRODUCTION_APP_IMAGE_ID="$production_app_image_id"',
      '/usr/bin/node scripts/production-app-lifecycle.js start',
    ];
    let cursor = -1;
    for (const token of orderedTokens) {
      const next = disasterRecovery.indexOf(token, cursor + 1);
      assert.ok(next > cursor, `DR authority token is missing or out of order: ${token}`);
      cursor = next;
    }
    assert.doesNotMatch(disasterRecovery, /release[- ]архив приложения|application release archive/iu,
      'an archive-only tree cannot satisfy the Git-backed production inventory authority');
    for (const [label, document] of [
      ['README', readme],
      ['release checklist', releaseChecklist],
      ['disaster recovery', disasterRecovery],
      ['recovery rehearsal', experimentalChecklist],
    ]) {
      assert.doesNotMatch(document, /^\s*npm run production:image:build\s*$/gmu,
        `${label} must not expose an identity-free production build command`);
      assert.match(document,
        /^\s*npm run production:image:build -- --expected-commit "\$EASYBOOST_RELEASE_COMMIT"\s*$/mu,
        `${label} must bind the wrapper to the exact owner-approved commit`);
      for (const build of document.matchAll(
        /^\s*npm run production:image:build -- --expected-commit "\$EASYBOOST_RELEASE_COMMIT"\s*$/gmu,
      )) {
        const blockStart = document.lastIndexOf('```bash', build.index);
        const blockEnd = document.indexOf('```', blockStart + '```bash'.length);
        const procedure = document.slice(blockStart, blockEnd);
        assert.ok(blockStart >= 0 && blockEnd > build.index,
          `${label} production build must remain inside an executable Bash procedure`);
        const detachedGuardIndex = procedure.indexOf('if git symbolic-ref -q HEAD >/dev/null; then');
        assert.ok(detachedGuardIndex >= 0
          && procedure.includes('symbolic_ref_status="$?"')
          && procedure.includes('[ "$symbolic_ref_status" -eq 1 ] || exit 1')
          && detachedGuardIndex < procedure.indexOf(build[0].trim()),
        `${label} production build must explicitly prove detached HEAD before the wrapper`);
      }
      assert.doesNotMatch(document, /\[ -z "\$\(git symbolic-ref -q HEAD\)" \] \|\| exit 1/u,
        `${label} must distinguish detached status 1 from symbolic-ref error status 128`);
    }
  });

test('first production launch delegates the exact built image to the guarded lifecycle', async () => {
  const readme = await fs.readFile(path.join(projectDirectory, 'README_DEPLOY.md'), 'utf8');
  assertManagedProductionAppStart(
    bashProcedureAfterHeading(readme, '## Первый запуск'),
    'first production launch',
  );
});

test('complete production, staging, disaster-recovery and rehearsal Bash procedures are fail-fast',
  async () => {
    const [readme, disasterRecovery, experimentalChecklist] = await Promise.all([
      fs.readFile(path.join(projectDirectory, 'README_DEPLOY.md'), 'utf8'),
      fs.readFile(path.join(projectDirectory, 'docs', 'DISASTER_RECOVERY.md'), 'utf8'),
      fs.readFile(path.join(
        projectDirectory, 'docs', 'EXPERIMENTAL_RELEASE_OPERATIONS_CHECKLIST.md',
      ), 'utf8'),
    ]);
    const operationalReadme = readme.slice(readme.indexOf('## Первый запуск'));
    const procedures = [
      ...bashProcedures(operationalReadme).map((procedure) => ['production/staging', procedure]),
      ...bashProcedures(disasterRecovery).map((procedure) => ['disaster recovery', procedure]),
      ...bashProcedures(experimentalChecklist).map((procedure) => ['release operations', procedure]),
    ];
    assert.ok(procedures.length >= 32, 'the executable runbook inventory must retain at least 32 procedures');
    for (const [label, procedure] of procedures) {
      assert.match(procedure, /^[ \t]*set -euo pipefail\r?\n/u,
        `${label} Bash fence must establish one fail-fast execution boundary`);
    }
  });

test('manual checksum-bound staging deploy stops when archive creation fails', async (context) => {
  const probe = spawnSync(gitBash, ['--version'], { encoding: 'utf8' });
  if (probe.error?.code === 'ENOENT') return context.skip('Bash is not installed');
  const readme = await fs.readFile(path.join(projectDirectory, 'README_DEPLOY.md'), 'utf8');
  const procedure = bashProcedureContaining(
    readme,
    'node scripts/staging-release-archive.js create-git . easyboost-staging-release.tar.gz',
  ).replace('<sha256>', 'd'.repeat(64));
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-staging-runbook-failfast-'));
  const commandLog = path.join(directory, 'commands.log');
  const harness = [
    'node() {',
    '  printf \'node %s\\n\' "$*" >> "$COMMAND_LOG"',
    '  case "$*" in',
    '    "scripts/staging-release-archive.js create-git "*) return 73 ;;',
    '  esac',
    '  return 0',
    '}',
    'sha256sum() { printf \'sha256sum %s\\n\' "$*" >> "$COMMAND_LOG"; return 0; }',
    'sudo() { printf \'sudo %s\\n\' "$*" >> "$COMMAND_LOG"; return 0; }',
  ].join('\n');
  try {
    await fs.writeFile(commandLog, '', 'utf8');
    const result = spawnSync(gitBash, ['-c', `${harness}\n${procedure}`], {
      cwd: projectDirectory,
      encoding: 'utf8',
      env: {
        ...process.env,
        COMMAND_LOG: commandLog.replaceAll('\\', '/'),
      },
    });
    assert.notEqual(result.status, 0,
      `archive creation failure must fail the deploy fence: ${result.stdout}\n${result.stderr}`);
    const commands = await fs.readFile(commandLog, 'utf8');
    assert.match(commands,
      /^node scripts\/staging-release-archive\.js create-git \. easyboost-staging-release\.tar\.gz$/mu);
    assert.doesNotMatch(commands, /staging-release-archive\.js inspect/u,
      'failed archive creation must not inspect a stale archive');
    assert.doesNotMatch(commands, /^sha256sum /mu,
      'failed archive creation must not checksum a stale archive');
    assert.doesNotMatch(commands, /staging-helper-bundle\.js digest/u,
      'failed archive creation must not continue to helper authority');
    assert.doesNotMatch(commands, /^sudo /mu,
      'failed archive creation must not reach privileged deployment');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('synthetic monitoring procedure accepts only the expected unavailable failure',
  async (context) => {
    const probe = spawnSync(gitBash, ['--version'], { encoding: 'utf8' });
    if (probe.error?.code === 'ENOENT') return context.skip('Bash is not installed');
    const checklist = await fs.readFile(path.join(
      projectDirectory, 'docs', 'EXPERIMENTAL_RELEASE_OPERATIONS_CHECKLIST.md',
    ), 'utf8');
    const procedure = bashProcedureContaining(
      checklist,
      'MONITORING_URL=http://127.0.0.1:1',
    ).replaceAll('<SHORT_SHA>', 'abc123def456');
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-monitor-runbook-failfast-'));
    const harness = [
      'npm() {',
      '  printf \'%s\\n\' "$MONITORING_URL" >> "$COMMAND_LOG"',
      '  if [ "$MONITORING_URL" = "http://127.0.0.1:1" ]; then',
      '    return "$UNAVAILABLE_STATUS"',
      '  fi',
      '  return 0',
      '}',
    ].join('\n');
    try {
      for (const [status, expectedExit, expectedLines] of [
        ['1', 0, ['http://127.0.0.1:1', 'https://staging.useboost.ru']],
        ['0', 1, ['http://127.0.0.1:1']],
      ]) {
        const commandLog = path.join(directory, `commands-${status}.log`);
        await fs.writeFile(commandLog, '', 'utf8');
        const result = spawnSync(gitBash, ['-c', `${harness}\n${procedure}`], {
          cwd: projectDirectory,
          encoding: 'utf8',
          env: {
            ...process.env,
            COMMAND_LOG: commandLog.replaceAll('\\', '/'),
            UNAVAILABLE_STATUS: status,
          },
        });
        assert.equal(result.status, expectedExit,
          `synthetic unavailable status ${status}: ${result.stdout}\n${result.stderr}`);
        const commands = (await fs.readFile(commandLog, 'utf8')).trim().split(/\r?\n/u);
        assert.deepEqual(commands, expectedLines,
          'recovery probe must run only after the exact expected unavailable failure');
      }
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

test('executable production and recovery runbooks cannot reach a stale tag or start after build failure',
  async (context) => {
    const probe = spawnSync(gitBash, ['--version'], { encoding: 'utf8' });
    if (probe.error?.code === 'ENOENT') return context.skip('Bash is not installed');
    const [readme, disasterRecovery, experimentalChecklist] = await Promise.all([
      fs.readFile(path.join(projectDirectory, 'README_DEPLOY.md'), 'utf8'),
      fs.readFile(path.join(projectDirectory, 'docs', 'DISASTER_RECOVERY.md'), 'utf8'),
      fs.readFile(path.join(
        projectDirectory, 'docs', 'EXPERIMENTAL_RELEASE_OPERATIONS_CHECKLIST.md',
      ), 'utf8'),
    ]);
    const procedures = [
      ['first production launch', bashProcedureAfterHeading(readme, '## Первый запуск')],
      ['production update', bashProcedureAfterHeading(readme, '## Обновление')],
      ['disaster recovery', bashProcedureAfterHeading(disasterRecovery,
        '5. Собрать приложение, закрепить его exact image ID')],
      ['recovery rehearsal', bashProcedureAfterHeading(experimentalChecklist,
        '## 7. Полное recovery на втором сервере')],
    ];
    const releaseCommit = 'a'.repeat(40);
    const postgresImageId = `sha256:${'b'.repeat(64)}`;
    const applicationImageId = `sha256:${'c'.repeat(64)}`;
    const harness = [
      'npm() {',
      '  printf \'npm %s\\n\' "$*" >> "$COMMAND_LOG"',
      '  [ "npm $*" != "$FAIL_AT" ] || return 73',
      '}',
      'git() {',
      '  printf \'git %s\\n\' "$*" >> "$COMMAND_LOG"',
      '  case "$*" in',
      '    "symbolic-ref -q HEAD") return 1 ;;',
      '    "rev-parse --verify HEAD") printf \'%s\\n\' "$EASYBOOST_RELEASE_COMMIT" ;;',
      '    "status --porcelain=v1 --untracked-files=all") return 0 ;;',
      '  esac',
      '  return 0',
      '}',
      'docker() {',
      '  printf \'docker %s\\n\' "$*" >> "$COMMAND_LOG"',
      '  case "$*" in',
      '    "image inspect --format {{.Id}} postgres:17-alpine") printf \'%s\\n\' "$EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID" ;;',
      '    "image inspect --format {{.Id}} easyboost-production-app:local") printf \'%s\\n\' "$APPLICATION_IMAGE_ID" ;;',
      '    "image inspect --format {{.Id}} $EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID") printf \'%s\\n\' "$EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID" ;;',
      '    "image inspect --format {{.Id}} sha256:"*) printf \'%s\\n\' "$APPLICATION_IMAGE_ID" ;;',
      '    "compose --project-name easyboost-production -f compose.production.yml ps -q postgres") printf \'postgres-container\\n\' ;;',
      '    "compose --project-name easyboost-production -f compose.production.yml ps -q app") printf \'app-container\\n\' ;;',
      '    "inspect --format {{.Image}} postgres-container") printf \'%s\\n\' "$EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID" ;;',
      '    "inspect --format {{.Image}} app-container") printf \'%s\\n\' "$APPLICATION_IMAGE_ID" ;;',
      '  esac',
      '  return 0',
      '}',
      'curl() { printf \'curl %s\\n\' "$*" >> "$COMMAND_LOG"; return 0; }',
      'rclone() { printf \'rclone %s\\n\' "$*" >> "$COMMAND_LOG"; return 0; }',
      'cd() { printf \'cd %s\\n\' "$*" >> "$COMMAND_LOG"; return 0; }',
      'sudo() { printf \'sudo %s\\n\' "$*" >> "$COMMAND_LOG"; return 0; }',
    ].join('\n');
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-runbook-failfast-'));
    try {
      for (const [index, [label, procedure]] of procedures.entries()) {
        const commandLog = path.join(directory, `commands-${index}.log`);
        await fs.writeFile(commandLog, '', 'utf8');
        const failAt = `npm run production:image:build -- --expected-commit ${releaseCommit}`;
        const result = spawnSync(gitBash, ['-c', `${harness}\n${procedure}`], {
          cwd: projectDirectory,
          encoding: 'utf8',
          env: {
            ...process.env,
            APPLICATION_IMAGE_ID: applicationImageId,
            COMMAND_LOG: commandLog.replaceAll('\\', '/'),
            EASYBOOST_NODE_BASE_IMAGE: `node:22-bookworm-slim@sha256:${'e'.repeat(64)}`,
            EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID: postgresImageId,
            EASYBOOST_PRODUCTION_APP_IMAGE_ID: applicationImageId,
            EASYBOOST_RELEASE_COMMIT: releaseCommit,
            EASYBOOST_RELEASE_REPOSITORY: 'https://owner.invalid/exact.git',
            FAIL_AT: failAt,
          },
        });
        assert.notEqual(result.status, 0,
          `${label} must fail at the build boundary: ${result.stdout}\n${result.stderr}`);
        const commands = await fs.readFile(commandLog, 'utf8');
        assert.match(commands, new RegExp(`^${failAt}$`, 'mu'));
        assert.doesNotMatch(commands,
          /^docker image inspect --format \{\{\.Id\}\} easyboost-production-app:local$/mu,
          `${label} must not inspect a stale mutable tag after failed build`);
        assert.doesNotMatch(commands,
          /^docker compose\b[^\n]*compose\.production\.yml[^\n]* up /mu,
          `${label} must not start any service after failed build`);
      }
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

test('production app starts cannot implicitly start an unchecked PostgreSQL dependency', async () => {
  const [readme, disasterRecovery, experimentalChecklist, restore] = await Promise.all([
    fs.readFile(path.join(projectDirectory, 'README_DEPLOY.md'), 'utf8'),
    fs.readFile(path.join(projectDirectory, 'docs', 'DISASTER_RECOVERY.md'), 'utf8'),
    fs.readFile(path.join(
      projectDirectory, 'docs', 'EXPERIMENTAL_RELEASE_OPERATIONS_CHECKLIST.md',
    ), 'utf8'),
    fs.readFile(path.join(projectDirectory, 'scripts', 'postgres-restore.js'), 'utf8'),
  ]);
  const firstLaunch = bashProcedureAfterHeading(readme, '## Первый запуск');
  const firstLaunchTokens = [
    'docker compose --project-name easyboost-production -f compose.production.yml up --pull never --no-build -d postgres',
    'postgres_container_id="$(docker compose --project-name easyboost-production -f compose.production.yml ps -q postgres)"',
    'postgres_running_image_id="$(docker inspect --format \'{{.Image}}\' "$postgres_container_id")"',
    '[ "$postgres_running_image_id" = "$EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID" ]',
    '/usr/bin/node scripts/production-app-lifecycle.js start',
  ];
  let cursor = -1;
  for (const token of firstLaunchTokens) {
    const next = firstLaunch.indexOf(token, cursor + 1);
    assert.ok(next > cursor, `first launch lifecycle token is missing or out of order: ${token}`);
    cursor = next;
  }
  const postgresMismatch = firstLaunch.slice(
    firstLaunch.indexOf('[ "$postgres_running_image_id" = "$EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID" ]'),
    firstLaunch.indexOf('/usr/bin/node scripts/production-app-lifecycle.js start'),
  );
  assert.match(postgresMismatch,
    /docker compose --project-name easyboost-production -f compose\.production\.yml stop postgres/u,
    'first launch must stop a mismatched PostgreSQL container before app start');

  assertManagedProductionAppReplace(
    bashProcedureAfterHeading(readme, '## Обновление'), 'production update');
  assertManagedProductionAppReplace(
    bashProcedureAfterHeading(readme, '## Откат приложения'), 'production rollback',
    { rollback: true });
  assertApprovedProductionAppRestart(
    bashProcedureAfterHeading(
      experimentalChecklist, '## 1. Ротация ранее использовавшихся секретов',
    ),
    'production secret rotation',
  );
  for (const [label, procedure] of [
    ['disaster recovery', disasterRecovery],
    ['fresh-host rehearsal', bashProcedureAfterHeading(
      experimentalChecklist, '## 7. Полное recovery на втором сервере',
    )],
  ]) {
    assert.match(procedure, /\/usr\/bin\/node scripts\/production-app-lifecycle\.js start/u,
      `${label} must use the guarded production lifecycle start`);
    assert.doesNotMatch(procedure,
      /docker compose\b[^\n]*compose\.production\.yml[^\n]*(?:up|start|stop|restart)[^\n]*\bapp\b/u,
      `${label} must not mutate the app through a raw Compose service selection`);
  }
  assert.match(restore,
    /await docker\(\['start', appContainerId\]\)/u,
    'standalone restore must restart only its already-proven immutable app container');
  assert.doesNotMatch(restore,
    /composeDocker\(\['up',[^\]]*'app'\]\)/u,
    'standalone restore must not allocate an app or implicitly start PostgreSQL');
  const restorePostgresProof = [
    "if (!CANONICAL_IMAGE_ID.test(postgresExpectedImageId || ''))",
    'const postgresContainerId = await proveExactPostgresAllocation({',
    'appContainerId = await composeDocker(',
    "['ps', '--all', '--quiet', 'app']",
    'await stopAndVerifyExactAppContainer({',
  ];
  cursor = -1;
  for (const token of restorePostgresProof) {
    const next = restore.indexOf(token, cursor + 1);
    assert.ok(next > cursor,
      `standalone restore must prove exact running PostgreSQL before app lifecycle: ${token}`);
    cursor = next;
  }
  assert.match(restore,
    /async function proveExactPostgresAllocation[\s\S]*?\['ps', '--all', '--quiet', 'postgres'\][\s\S]*?\['inspect', '--format', POSTGRES_ALLOCATION_FORMAT, postgresContainerId\][\s\S]*?if \(allocation !== expected\)/u,
    'standalone restore must bind PostgreSQL ID, labels, image and running state in one proof');
});

test('production Compose validation never renders hostile secret values or connection strings',
  async (context) => {
    const probe = spawnSync(gitBash, ['--version'], { encoding: 'utf8' });
    if (probe.error?.code === 'ENOENT') return context.skip('Bash is not installed');
    const [releaseChecklist, readme] = await Promise.all([
      fs.readFile(path.join(projectDirectory, 'RELEASE_CHECKLIST.md'), 'utf8'),
      fs.readFile(path.join(projectDirectory, 'README_DEPLOY.md'), 'utf8'),
    ]);
    const procedures = [
      ['release gate', bashProcedureAfterHeading(releaseChecklist, '## Команды release gate')],
      ['first production launch', bashProcedureAfterHeading(readme, '## Первый запуск')],
    ];
    const harness = [
      'npm() { return 0; }',
      'git() {',
      '  case "$*" in',
      '    "symbolic-ref -q HEAD") return 1 ;;',
      '    "rev-parse --verify HEAD") printf \'%s\\n\' "$EASYBOOST_RELEASE_COMMIT" ;;',
      '    "status --porcelain=v1 --untracked-files=all") return 0 ;;',
      '  esac',
      '  return 0',
      '}',
      'docker() {',
      '  case "$*" in',
      '    "image inspect --format {{.Id}} postgres:17-alpine") printf \'%s\\n\' "$EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID" ;;',
      '    "image inspect --format {{.Id}} easyboost-production-app:local") printf \'%s\\n\' "$APPLICATION_IMAGE_ID" ;;',
      '    "compose --project-name easyboost-production -f compose.production.yml config")',
      '      printf \'%s\\n\' "$JWT_SECRET" >&2',
      '      printf \'postgres://easyboost:%s@postgres:5432/easyboost\\n\' "$POSTGRES_PASSWORD"',
      '      return 73',
      '      ;;',
      '    "compose --project-name easyboost-production -f compose.production.yml config --quiet") return 73 ;;',
      '  esac',
      '  return 0',
      '}',
    ].join('\n');
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-compose-secret-'));
    try {
      for (const [index, [label, procedure]] of procedures.entries()) {
        const script = path.join(directory, `procedure-${index}.sh`);
        await fs.writeFile(script, harness + '\n' + procedure, 'utf8');
        const result = spawnSync(gitBash, [script], {
          cwd: directory,
          encoding: 'utf8',
          env: {
            ...process.env,
            APPLICATION_IMAGE_ID: `sha256:${'c'.repeat(64)}`,
            EASYBOOST_NODE_BASE_IMAGE: `node:22-bookworm-slim@sha256:${'d'.repeat(64)}`,
            EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID: `sha256:${'b'.repeat(64)}`,
            EASYBOOST_RELEASE_COMMIT: 'a'.repeat(40),
            JWT_SECRET: 'HOSTILE_JWT_SECRET_VALUE',
            POSTGRES_PASSWORD: 'HOSTILE_DATABASE_PASSWORD',
          },
        });
        assert.equal(result.status, 73,
          `${label} must reach the injected Compose validation failure`);
        const output = result.stdout + result.stderr;
        assert.doesNotMatch(output,
          /HOSTILE_JWT_SECRET_VALUE|HOSTILE_DATABASE_PASSWORD|postgres:\/\//u,
          `${label} must not render resolved production secrets during validation`);
      }
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

test('production lifecycle runbooks delegate app mutation to the shared guarded helper',
  async () => {
    const [releaseChecklist, readme, lifecycle] = await Promise.all([
      fs.readFile(path.join(projectDirectory, 'RELEASE_CHECKLIST.md'), 'utf8'),
      fs.readFile(path.join(projectDirectory, 'README_DEPLOY.md'), 'utf8'),
      fs.readFile(path.join(projectDirectory, 'scripts', 'production-app-lifecycle.js'), 'utf8'),
    ]);
    assertManagedProductionAppStart(
      bashProcedureAfterHeading(releaseChecklist, '## Команды release gate'), 'release gate');
    assertManagedProductionAppStart(
      bashProcedureAfterHeading(readme, '## Первый запуск'), 'first production launch');
    assertManagedProductionAppReplace(
      bashProcedureAfterHeading(readme, '## Обновление'), 'production update');
    assertManagedProductionAppReplace(
      bashProcedureAfterHeading(readme, '## Откат приложения'), 'production rollback',
      { rollback: true });
    const updateSection = readme.slice(
      readme.indexOf('## Обновление'), readme.indexOf('## Backup и восстановление PostgreSQL'));
    const rollbackSection = readme.slice(
      readme.indexOf('## Откат приложения'), readme.indexOf('## Импорт старого data.json'));
    for (const [label, section] of [
      ['production update', updateSection],
      ['production rollback', rollbackSection],
    ]) {
      assert.match(section, /\/usr\/bin\/node scripts\/production-app-lifecycle\.js recover/u,
        `${label} must give the operator a concrete retained-guard recovery entrypoint`);
    }
    assert.match(releaseChecklist,
      /npm run production:app:recover[\s\S]*?npm run production:import:recover[\s\S]*?npm run production:restore:recover/u,
      'the release rehearsal must cover every typed production recovery entrypoint');
    assert.match(lifecycle, /await checkReadiness\(\{ url: readinessUrl \}\)/u,
      'bounded readiness belongs to the executable lifecycle helper');
    assert.match(lifecycle, /await acquireHostLock\(\{/u,
      'every managed app mutation must acquire the shared host guard');
  });
test('legacy production import runbook delegates exact-image readiness to the guarded root entrypoint',
  async () => {
    const readme = await fs.readFile(path.join(projectDirectory, 'README_DEPLOY.md'), 'utf8');
    const section = readme.slice(
      readme.indexOf('## Импорт старого data.json'),
      readme.indexOf('## Наблюдаемость'),
    );
    assert.match(section,
      /canonical PostgreSQL container[\s\S]*?network IPv4 endpoint[\s\S]*?bounded readiness/iu);
    assert.equal((section.match(/\/usr\/bin\/node scripts\/import-json\.js/gmu) || []).length, 2,
      'dry-run and live import must both use the same guarded root entrypoint');
    assert.doesNotMatch(section, /\bpg_isready\b/u,
      'the runbook must not duplicate mutable service readiness outside the guarded importer');
  });

test('recovery completion keeps public readiness and failure isolation inside the host guard', async () => {
  const [disasterRecovery, experimentalChecklist] = await Promise.all([
    fs.readFile(path.join(projectDirectory, 'docs', 'DISASTER_RECOVERY.md'), 'utf8'),
    fs.readFile(path.join(
      projectDirectory, 'docs', 'EXPERIMENTAL_RELEASE_OPERATIONS_CHECKLIST.md',
    ), 'utf8'),
  ]);
  for (const [label, procedure, url] of [
    ['disaster recovery public readiness',
      bashProcedureAfterHeading(disasterRecovery,
        '7. Запустить приложение из закреплённого на шаге 5 immutable image ID'),
      'https://useboost.ru/health/ready'],
    ['recovery rehearsal public readiness',
      bashProcedureAfterHeading(experimentalChecklist,
        '## 7. Полное recovery на втором сервере'),
      'https://<ISOLATED_RECOVERY_HOST>/health/ready'],
  ]) {
    const urlPattern = url.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    assert.match(procedure,
      new RegExp('export EASYBOOST_APP_READINESS_URL=' + urlPattern, 'u'),
      label + ' must bind the public readiness URL before the guarded lifecycle call');
    assert.match(procedure,
      /sudo --preserve-env=[^\n]*EASYBOOST_APP_READINESS_URL[^\n]*\\?[\s\S]*?\/usr\/bin\/node scripts\/production-app-lifecycle\.js start/u,
      label + ' must execute public readiness while the shared host guard is held');
    assert.doesNotMatch(procedure,
      /docker stop|cleanup_(?:candidate|public)_app|public_ready=|app_ready=/u,
      label + ' must not mutate or re-prove the app after the guarded lifecycle releases');
  }
  const retainedRestoreProcedure = disasterRecovery.slice(
    disasterRecovery.indexOf('Если marker retained'),
    disasterRecovery.indexOf('7. Запустить приложение'),
  );
  assert.match(retainedRestoreProcedure,
    /\/usr\/bin\/node scripts\/production-restore-recovery\.js/u,
    'disaster recovery must use the same executable typed restore recovery helper');
  assert.doesNotMatch(retainedRestoreProcedure, /\bsudo\s+(?:awk|rm|rmdir)\b/u,
    'disaster recovery must not parse or remove retained guards with raw shell commands');
});

test('every production Compose authority is pinned to one canonical project', async () => {
  const files = await Promise.all([
    'compose.production.yml',
    'scripts/import-json.js',
    'scripts/postgres-backup.js',
    'scripts/postgres-restore.js',
    'scripts/production-app-lifecycle.js',
    'scripts/production-import-recovery.js',
    'scripts/production-restore-recovery.js',
  ].map(async (relativePath) => [
    relativePath,
    await fs.readFile(path.join(projectDirectory, relativePath), 'utf8'),
  ]));
  const compose = files.find(([relativePath]) => relativePath === 'compose.production.yml')[1];
  assert.match(compose, /^name: easyboost-production$/mu,
    'the production Compose model must declare the canonical project name');
  for (const [relativePath, source] of files.filter(([name]) => name.endsWith('.js'))) {
    assert.match(source,
      /--project-name['",\s]+(?:easyboost-production|PRODUCTION_COMPOSE_PROJECT(?:_NAME)?)/u,
      `${relativePath} must pin the canonical project on every Compose invocation`);
    assert.match(source, /com\.docker\.compose\.project/u,
      `${relativePath} must prove the canonical project label before mutation or trust`);
  }
});

test('production runbooks expose only root-managed app lifecycle entrypoints', async () => {
  const [readme, releaseChecklist] = await Promise.all([
    fs.readFile(path.join(projectDirectory, 'README_DEPLOY.md'), 'utf8'),
    fs.readFile(path.join(projectDirectory, 'RELEASE_CHECKLIST.md'), 'utf8'),
  ]);
  const procedures = [
    bashProcedureAfterHeading(readme, '## Первый запуск'),
    bashProcedureAfterHeading(readme, '## Обновление'),
    bashProcedureAfterHeading(readme, '## Откат приложения'),
    bashProcedureAfterHeading(releaseChecklist, '## Команды release gate'),
  ];
  for (const procedure of procedures) {
    assert.doesNotMatch(procedure,
      /docker compose\b[^\n]*compose\.production\.yml[^\n]*(?:up|start|stop|restart)[^\n]*\bapp\b/u);
    assert.match(procedure, /sudo --preserve-env=/u);
    assert.match(procedure, /\/usr\/bin\/node scripts\/production-app-lifecycle\.js/u);
    assert.doesNotMatch(procedure,
      /sudo install[^\n]*\/var\/lib\/easyboost\/locks\/host-operation\.lock/u,
      'the exact lock directory is created only by the lifecycle helper');
  }
  assert.match(readme, /\/var\/lib\/easyboost\/locks\/host-operation\.lock/u);
  assert.match(readme, /app намеренно остаётся отсутствующим/u);
  assert.match(readme, /guard[\s\S]{0,80}остаётся retained/u);
});

test('the release gate delegates the exact built application image to the guarded lifecycle', async () => {
  const releaseChecklist = await fs.readFile(
    path.join(projectDirectory, 'RELEASE_CHECKLIST.md'), 'utf8',
  );
  assertManagedProductionAppStart(
    bashProcedureAfterHeading(releaseChecklist, '## Команды release gate'),
    'release gate',
  );
});

test('the release gate proves the exact PostgreSQL image before it starts the application',
  async () => {
    const releaseChecklist = await fs.readFile(
      path.join(projectDirectory, 'RELEASE_CHECKLIST.md'), 'utf8',
    );
    const gate = bashProcedureAfterHeading(releaseChecklist, '## Команды release gate');
    const orderedTokens = [
      "export EASYBOOST_POSTGRES_IMAGE='postgres:17-alpine'",
      ': "${EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID:?set the owner-approved sha256 image ID}"',
      '[[ "$EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID" =~ ^sha256:[0-9a-f]{64}$ ]]',
      'docker pull "$EASYBOOST_POSTGRES_IMAGE"',
      'postgres_seed_image_id="$(docker image inspect --format \'{{.Id}}\' "$EASYBOOST_POSTGRES_IMAGE")"',
      '[ "$postgres_seed_image_id" = "$EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID" ]',
      'postgres_preflight_image_id="$(docker image inspect --format \'{{.Id}}\' "$EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID")"',
      '[ "$postgres_preflight_image_id" = "$EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID" ]',
      'docker compose --project-name easyboost-production -f compose.production.yml up --pull never --no-build -d postgres',
      'postgres_container_id="$(docker compose --project-name easyboost-production -f compose.production.yml ps -q postgres)"',
      'postgres_running_image_id="$(docker inspect --format \'{{.Image}}\' "$postgres_container_id")"',
      '[ "$postgres_running_image_id" = "$EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID" ]',
      '/usr/bin/node scripts/production-app-lifecycle.js start',
    ];
    let cursor = -1;
    for (const token of orderedTokens) {
      const next = gate.indexOf(token, cursor + 1);
      assert.ok(next > cursor, `release gate PostgreSQL authority token is missing: ${token}`);
      cursor = next;
    }
    const mismatchIndex = gate.indexOf(
      '[ "$postgres_running_image_id" = "$EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID" ]',
    );
    const applicationStartIndex = gate.indexOf(
      '/usr/bin/node scripts/production-app-lifecycle.js start',
    );
    const mismatchBranch = gate.slice(mismatchIndex, applicationStartIndex);
    assert.match(mismatchBranch,
      /docker compose --project-name easyboost-production -f compose\.production\.yml stop postgres/u,
      'a running PostgreSQL image mismatch must be stopped before the app can start');
    assert.doesNotMatch(gate,
      /docker compose\b[^\n]*compose\.production\.yml[^\n]*up --pull never --no-build -d app/u,
      'release gate app start must never implicitly start an unchecked dependency');
  });

test('the executable release gate stops a foreign PostgreSQL image and never starts the app',
  async (context) => {
    const probe = spawnSync(gitBash, ['--version'], { encoding: 'utf8' });
    if (probe.error?.code === 'ENOENT') return context.skip('Bash is not installed');
    const releaseChecklist = await fs.readFile(
      path.join(projectDirectory, 'RELEASE_CHECKLIST.md'), 'utf8',
    );
    const gate = bashProcedureAfterHeading(releaseChecklist, '## Команды release gate');
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-release-pg-mismatch-'));
    try {
      const commandLog = path.join(directory, 'commands.log');
      await fs.writeFile(commandLog, '', 'utf8');
      const harness = [
        'npm() { printf \'npm %s\\n\' "$*" >> "$COMMAND_LOG"; }',
        'git() {',
        '  printf \'git %s\\n\' "$*" >> "$COMMAND_LOG"',
        '  case "$*" in',
        '    "symbolic-ref -q HEAD") return 1 ;;',
        '    "rev-parse --verify HEAD") printf \'%s\\n\' "$EASYBOOST_RELEASE_COMMIT" ;;',
        '  esac',
        '}',
        'docker() {',
        '  printf \'docker %s\\n\' "$*" >> "$COMMAND_LOG"',
        '  case "$*" in',
        '    "image inspect --format {{.Id}} postgres:17-alpine") printf \'%s\\n\' "$EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID" ;;',
        '    "image inspect --format {{.Id}} easyboost-production-app:local") printf \'%s\\n\' "$APPLICATION_IMAGE_ID" ;;',
        '    "image inspect --format {{.Id}} $EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID") printf \'%s\\n\' "$EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID" ;;',
        '    "compose --project-name easyboost-production -f compose.production.yml ps -q postgres") printf \'postgres-container\\n\' ;;',
        '    "inspect --format {{.Image}} postgres-container") printf \'%s\\n\' "$FOREIGN_POSTGRES_IMAGE_ID" ;;',
        '  esac',
        '}',
        'curl() { printf \'curl %s\\n\' "$*" >> "$COMMAND_LOG"; }',
      ].join('\n');
      const result = spawnSync(gitBash, ['-c', harness + '\n' + gate], {
        cwd: projectDirectory,
        encoding: 'utf8',
        env: {
          ...process.env,
          APPLICATION_IMAGE_ID: 'sha256:' + 'c'.repeat(64),
          COMMAND_LOG: commandLog.replaceAll('\\', '/'),
          EASYBOOST_NODE_BASE_IMAGE: `node:22-bookworm-slim@sha256:${'e'.repeat(64)}`,
          EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID: 'sha256:' + 'b'.repeat(64),
          EASYBOOST_RELEASE_COMMIT: 'a'.repeat(40),
          FOREIGN_POSTGRES_IMAGE_ID: 'sha256:' + 'd'.repeat(64),
        },
      });
      assert.notEqual(result.status, 0,
        'a foreign running PostgreSQL image must fail the gate: '
          + result.stdout + '\n' + result.stderr);
      const commands = await fs.readFile(commandLog, 'utf8');
      assert.match(commands,
        /docker inspect --format \{\{\.Image\}\} postgres-container/u,
        'the executable gate must inspect the running PostgreSQL container');
      assert.match(commands,
        /docker compose --project-name easyboost-production -f compose\.production\.yml stop postgres/u,
        'the executable gate must stop PostgreSQL after an image mismatch');
      assert.doesNotMatch(commands,
        /docker compose\b[^\n]*compose\.production\.yml[^\n]*up --pull never --no-build --no-deps -d app/u,
        'the executable gate must not start the app after a PostgreSQL image mismatch');
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

test('the executable release gate aborts on prerequisite failures before any later command',
  async (context) => {
    const probe = spawnSync(gitBash, ['--version'], { encoding: 'utf8' });
    if (probe.error?.code === 'ENOENT') return context.skip('Bash is not installed');
    const releaseChecklist = await fs.readFile(
      path.join(projectDirectory, 'RELEASE_CHECKLIST.md'), 'utf8',
    );
    const gate = bashProcedureAfterHeading(releaseChecklist, '## Команды release gate');
    const releaseCommit = 'a'.repeat(40);
    const postgresImageId = `sha256:${'b'.repeat(64)}`;
    const applicationImageId = `sha256:${'c'.repeat(64)}`;
    const harness = [
      'npm() {',
      '  printf \'npm %s\\n\' "$*" >> "$COMMAND_LOG"',
      '  [ "npm $*" != "$FAIL_AT" ]',
      '}',
      'git() {',
      '  printf \'git %s\\n\' "$*" >> "$COMMAND_LOG"',
      '  case "$*" in',
      '    "symbolic-ref -q HEAD") return 1 ;;',
      '    "rev-parse --verify HEAD") printf \'%s\\n\' "$EASYBOOST_RELEASE_COMMIT" ;;',
      '    "status --porcelain=v1 --untracked-files=all") return 0 ;;',
      '    *) return 0 ;;',
      '  esac',
      '}',
      'docker() {',
      '  printf \'docker %s\\n\' "$*" >> "$COMMAND_LOG"',
      '  [ "docker $*" != "$FAIL_AT" ] || return 67',
      '  case "$*" in',
      '    "image inspect --format {{.Id}} postgres:17-alpine") printf \'%s\\n\' "$EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID" ;;',
      '    "image inspect --format {{.Id}} easyboost-production-app:local") printf \'%s\\n\' "$APPLICATION_IMAGE_ID" ;;',
      '    "compose --project-name easyboost-production -f compose.production.yml ps -q postgres") printf \'postgres-container\\n\' ;;',
      '    "compose --project-name easyboost-production -f compose.production.yml ps -q app") printf \'app-container\\n\' ;;',
      '    "inspect --format {{.Image}} postgres-container") printf \'%s\\n\' "$EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID" ;;',
      '    "inspect --format {{.Image}} app-container") printf \'%s\\n\' "$APPLICATION_IMAGE_ID" ;;',
      '  esac',
      '}',
      'curl() {',
      '  printf \'curl %s\\n\' "$*" >> "$COMMAND_LOG"',
      '  [ "curl $*" != "$FAIL_AT" ]',
      '}',
    ].join('\n');
    const failures = [
      'npm ci',
      'npm run test:postgres',
      'npm run test:release:aisy',
      'npm audit --omit=dev',
      'docker pull postgres:17-alpine',
      `npm run production:image:build -- --expected-commit ${releaseCommit}`,
    ];
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-release-gate-failfast-'));
    try {
      for (const [index, failAt] of failures.entries()) {
        const commandLog = path.join(directory, `commands-${index}.log`);
        await fs.writeFile(commandLog, '', 'utf8');
        const result = spawnSync(gitBash, ['-c', `${harness}\n${gate}`], {
          cwd: projectDirectory,
          encoding: 'utf8',
          env: {
            ...process.env,
            APPLICATION_IMAGE_ID: applicationImageId,
            COMMAND_LOG: commandLog.replaceAll('\\', '/'),
            EASYBOOST_NODE_BASE_IMAGE: `node:22-bookworm-slim@sha256:${'d'.repeat(64)}`,
            EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID: postgresImageId,
            EASYBOOST_RELEASE_COMMIT: releaseCommit,
            FAIL_AT: failAt,
          },
        });
        assert.notEqual(result.status, 0,
          `${failAt} must fail the executable release boundary: ${result.stdout}\n${result.stderr}`);
        const commands = (await fs.readFile(commandLog, 'utf8')).trim().split(/\r?\n/u);
        assert.equal(commands.at(-1), failAt,
          `${failAt} must be the final external command; got ${commands.join(' -> ')}`);
      }
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

test('production update atomically replaces the exact approved application image', async () => {
  const readme = await fs.readFile(path.join(projectDirectory, 'README_DEPLOY.md'), 'utf8');
  assertManagedProductionAppReplace(
    bashProcedureAfterHeading(readme, '## Обновление'),
    'production update',
  );
});

test('production update binds the currently approved image before its database backup', async () => {
  const readme = await fs.readFile(path.join(projectDirectory, 'README_DEPLOY.md'), 'utf8');
  const update = bashProcedureAfterHeading(readme, '## Обновление');
  const orderedTokens = [
    'current_app_image_id="$EASYBOOST_PRODUCTION_APP_IMAGE_ID"',
    '[[ "$current_app_image_id" =~ ^sha256:[0-9a-f]{64}$ ]]',
    'current_app_preflight_image_id="$(docker image inspect --format \'{{.Id}}\' "$current_app_image_id")"',
    '[ "$current_app_preflight_image_id" = "$current_app_image_id" ]',
    'export EASYBOOST_PRODUCTION_APP_IMAGE_ID="$current_app_image_id"',
    'npm run db:backup',
  ];
  let cursor = -1;
  for (const token of orderedTokens) {
    const next = update.indexOf(token, cursor + 1);
    assert.ok(next > cursor, `production update backup authority token is missing: ${token}`);
    cursor = next;
  }
});

test('production rollback uses the current helper and an already-local exact image', async () => {
  const readme = await fs.readFile(path.join(projectDirectory, 'README_DEPLOY.md'), 'utf8');
  assertManagedProductionAppReplace(
    bashProcedureAfterHeading(readme, '## Откат приложения'),
    'production rollback',
    { rollback: true },
  );
});

test('disaster recovery delegates approved app start to the guarded lifecycle', async () => {
  const disasterRecovery = await fs.readFile(
    path.join(projectDirectory, 'docs', 'DISASTER_RECOVERY.md'), 'utf8',
  );
  assert.match(disasterRecovery,
    /\/usr\/bin\/node scripts\/production-app-lifecycle\.js start/u);
  assert.doesNotMatch(disasterRecovery,
    /docker compose\b[^\n]*compose\.production\.yml[^\n]*(?:up|start|stop|restart)[^\n]*\bapp\b/u);
  assert.ok(
    disasterRecovery.indexOf('export EASYBOOST_PRODUCTION_APP_IMAGE_ID="$production_app_image_id"')
      < disasterRecovery.indexOf('docker compose --project-name easyboost-production -f compose.production.yml'),
    'DR must bind the exact app ID before even the PostgreSQL-only Compose start is resolved',
  );
});

test('fresh-host rehearsal delegates approved app start to the guarded lifecycle', async () => {
  const checklist = await fs.readFile(path.join(
    projectDirectory, 'docs', 'EXPERIMENTAL_RELEASE_OPERATIONS_CHECKLIST.md',
  ), 'utf8');
  const rehearsal = bashProcedureAfterHeading(checklist, '## 7. Полное recovery на втором сервере');
  assert.match(rehearsal, /\/usr\/bin\/node scripts\/production-app-lifecycle\.js start/u);
  assert.doesNotMatch(rehearsal,
    /docker compose\b[^\n]*compose\.production\.yml[^\n]*(?:up|start|stop|restart)[^\n]*\bapp\b/u);
  assert.ok(
    rehearsal.indexOf('export EASYBOOST_PRODUCTION_APP_IMAGE_ID="$production_app_image_id"')
      < rehearsal.indexOf('docker compose --project-name easyboost-production -f compose.production.yml'),
    'rehearsal must bind the exact app ID before PostgreSQL-only Compose is resolved',
  );
});
test('production secret rotation restarts only the owner-approved immutable app image', async () => {
  const checklist = await fs.readFile(path.join(
    projectDirectory, 'docs', 'EXPERIMENTAL_RELEASE_OPERATIONS_CHECKLIST.md',
  ), 'utf8');
  assertApprovedProductionAppRestart(
    bashProcedureAfterHeading(checklist, '## 1. Ротация ранее использовавшихся секретов'),
    'production secret rotation',
  );
});

test('source-only pre-release checks do not resolve Compose before an app image ID is approved', async () => {
  const readme = await fs.readFile(path.join(projectDirectory, 'README_DEPLOY.md'), 'utf8');
  const sourceChecks = bashProcedureAfterHeading(readme, '## Проверка перед релизом');
  assert.doesNotMatch(sourceChecks, /compose\.production\.yml/u,
    'resolved Compose validation belongs after the immutable app image binding in the primary gate');
});

test('PWA runbooks describe the exact consented waiting-worker activation reload boundary',
  async () => {
    const documents = await Promise.all([
      fs.readFile(path.join(projectDirectory, 'README_DEPLOY.md'), 'utf8'),
      fs.readFile(path.join(projectDirectory, 'docs', 'KNOWN_LIMITATIONS.md'), 'utf8'),
    ]);
    for (const document of documents) {
      const qualifiedIncompleteQuorum = (
        /while[\s\S]{0,160}(?:nonconsenting|has not consented)[\s\S]{0,160}quorum is incomplete[\s\S]{0,180}does not activate[\s\S]{0,120}reload/iu
          .test(document)
        || /пока[\s\S]{0,160}не соглас[\s\S]{0,160}quorum[\s\S]{0,120}незаверш[\s\S]{0,180}не активирует[\s\S]{0,120}перезагруж/iu
          .test(document)
      );
      assert.equal(qualifiedIncompleteQuorum, true,
        'no-activation/no-reload behavior must be qualified by an incomplete quorum with another nonconsenting participant');
      assert.match(document,
        /statechange[\s\S]{0,240}activated[\s\S]{0,240}(?:reload|перезагру)/iu,
        'a consenting page must reload from its exact waiting worker activated statechange');
      assert.match(document,
        /(?:does not call|не вызывает) `?clients\.claim\(\)`?/iu,
        'update activation must explicitly avoid claiming passive or nonconsenting tabs');
      assert.match(document,
        /controllerchange[\s\S]{0,200}idempotent[\s\S]{0,120}fallback/iu,
        'controllerchange must be described only as the same consented-worker idempotent fallback');
      assert.doesNotMatch(document,
        /(?:quorum|кворум)[^\r\n]{0,120}controllerchange[^\r\n]{0,120}(?:all live|все[^\r\n]*вклад)/iu,
        'runbooks must not claim that controllerchange reloads every live tab after quorum');
    }
  });

test('standalone database restore restarts only the canonical approved app image', async () => {
  const restore = await fs.readFile(
    path.join(projectDirectory, 'scripts', 'postgres-restore.js'), 'utf8',
  );
  const orderedTokens = [
    'export async function restorePostgresBackup({',
    'productionAppImageId,',
    "if (!CANONICAL_IMAGE_ID.test(productionAppImageId || ''))",
    'acquireOperationLock(',
    'const appPreflightImageId = await docker(',
    "['image', 'inspect', '--format', '{{.Id}}', productionAppImageId]",
    "['exec', '-i', postgresContainerId, 'pg_restore', '--list']",
    "['ps', '--all', '--quiet', 'app']",
    'if (!CANONICAL_CONTAINER_ID.test(appContainerId))',
    'proveExactAppAllocation(',
    'stopAndVerifyExactAppContainer(',
    "log('Restore failed; application remains stopped for operator recovery.');",
    "await docker(['start', appContainerId]);",
    'expectedRunning: true,',
    'await checkReadiness({ url: readinessUrl });',
    "log('Application start verification failed; restored database remains isolated with the app stopped.');",
    "log('Restore completed successfully.');",
  ];
  let cursor = -1;
  for (const token of orderedTokens) {
    const next = restore.indexOf(token, cursor + 1);
    assert.ok(next > cursor, `standalone restore authority token is missing: ${token}`);
    cursor = next;
  }
  assert.doesNotMatch(restore, /easyboost-production-app:local/u,
    'standalone restore must never recover app authority from the mutable build tag');
  assert.doesNotMatch(restore,
    /composeDocker\(\['(?:stop|up)',[^\]]*'app'\]\)/u,
    'standalone restore must never stop or replace a mutable Compose app selection');
});

test('standalone database restore keeps the application stopped after mid-restore failure',
  async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-restore-fail-closed-'));
    try {
      const backup = path.join(directory, 'restore.dump');
      await fs.writeFile(backup, 'fake pg dump bytes', 'utf8');
      const applicationImageId = `sha256:${'f'.repeat(64)}`;
      const restoreModule = new URL('../scripts/postgres-restore.js', import.meta.url).href;
      const result = await runTemporaryModuleHarness(directory, [
        `const { restorePostgresBackup } = await import(${JSON.stringify(restoreModule)});`,
        'const calls = [];',
        'let appRunning = true;',
        "const primaryError = new Error('mid-restore pg_restore failed with exit code 41');",
        'const runDocker = async (arguments_) => {',
        '  calls.push(arguments_);',
        "  if (arguments_[0] === 'image') return process.env.APP_IMAGE_ID;",
        "  if (arguments_.includes('ps') && arguments_.at(-1) === 'postgres') return process.env.POSTGRES_CONTAINER_ID;",
        "  if (arguments_[0] === 'inspect' && arguments_.at(-1) === process.env.POSTGRES_CONTAINER_ID) return [process.env.POSTGRES_CONTAINER_ID, 'easyboost-production', 'postgres', 'False', process.env.POSTGRES_IMAGE_ID, 'true'].join('|');",
        "  if (arguments_.includes('ps') && arguments_.at(-1) === 'app') return process.env.APP_CONTAINER_ID;",
        "  if (arguments_[0] === 'inspect' && arguments_.at(-1) === process.env.APP_CONTAINER_ID) return [process.env.APP_CONTAINER_ID, 'easyboost-production', 'app', 'False', process.env.APP_IMAGE_ID, String(appRunning)].join('|');",
        "  if (arguments_[0] === 'stop' && arguments_.at(-1) === process.env.APP_CONTAINER_ID) { appRunning = false; return ''; }",
        "  if (arguments_[0] === 'start' && arguments_.at(-1) === process.env.APP_CONTAINER_ID) { appRunning = true; return ''; }",
        "  if (arguments_.includes('--clean')) throw primaryError;",
        "  return '';",
        '};',
        'let caught;',
        'try {',
        '  await restorePostgresBackup({',
        '    backup: process.env.BACKUP_PATH,',
        '    composeFile: process.env.COMPOSE_FILE,',
        '    lockFile: process.env.LOCK_FILE,',
        '    postgresExpectedImageId: process.env.POSTGRES_IMAGE_ID,',
        '    productionAppImageId: process.env.APP_IMAGE_ID,',
        '    runDocker,',
        '    runSupervisedRestore: async ({ postgresContainerId }) => {',
        "      calls.push(['supervised-restore', postgresContainerId]);",
        '      throw primaryError;',
        '    },',
        '    log() {},',
        '  });',
        '} catch (error) { caught = error; }',
        "if (caught !== primaryError) throw new Error('restore did not preserve its primary failure');",
        'process.stdout.write(JSON.stringify(calls));',
      ].join('\n'), {
        APP_CONTAINER_ID: '1'.repeat(64),
        APP_IMAGE_ID: applicationImageId,
        BACKUP_PATH: backup,
        COMPOSE_FILE: path.join(directory, 'compose.production.yml'),
        LOCK_FILE: path.join(directory, 'restore.lock'),
        POSTGRES_CONTAINER_ID: canonicalPostgresContainerId,
        POSTGRES_IMAGE_ID: `sha256:${'d'.repeat(64)}`,
      });
      assert.equal(result.status, 0,
        `restore lifecycle harness failed: ${result.stdout}\n${result.stderr}`);
      const calls = JSON.parse(result.stdout);
      assert.ok(calls.some((arguments_) => (
        arguments_[0] === 'supervised-restore'
          && arguments_[1] === canonicalPostgresContainerId
      )), 'the fixture must reach the supervised destructive restore seam');
      assert.equal(calls.some((arguments_) => arguments_.includes('up')), false,
        'the app must remain stopped after any mid-restore failure');
      assert.equal(calls.some((arguments_) => (
        arguments_[0] === 'stop' && arguments_.at(-1) === '1'.repeat(64)
      )), true, 'restore isolation must target only the proven immutable app ID');
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

test('standalone restore retains its lock and stopped app when remote settlement is unproven',
  async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-restore-retained-lock-'));
    try {
      const backup = path.join(directory, 'restore.dump');
      const lockFile = path.join(directory, '.easyboost-database-operation.lock');
      await fs.writeFile(backup, 'fake pg dump bytes', { mode: 0o600 });
      const applicationImageId = `sha256:${'a'.repeat(64)}`;
      const postgresImageId = `sha256:${'b'.repeat(64)}`;
      const appContainerId = '1'.repeat(64);
      const settlementError = new Error('remote restore settlement is unproven');
      settlementError.retainOperationLock = true;
      settlementError.settlementProven = false;
      settlementError.recoveryEvidence = restoreRecoveryEvidence(
        canonicalPostgresContainerId,
        { activityCount: 1, process: 'ACTIVE', status: 'RUNNING' },
      );
      let appRunning = true;
      let propagatedDeadline;
      let appStartCalls = 0;
      const runDocker = async (arguments_) => {
        if (arguments_[0] === 'image') return applicationImageId;
        if (arguments_.includes('ps') && arguments_.at(-1) === 'postgres') {
          return canonicalPostgresContainerId;
        }
        if (arguments_[0] === 'inspect'
            && arguments_.at(-1) === canonicalPostgresContainerId) {
          return exactPostgresProof(postgresImageId);
        }
        if (arguments_.includes('ps') && arguments_.at(-1) === 'app') return appContainerId;
        if (arguments_[0] === 'inspect' && arguments_.at(-1) === appContainerId) {
          return [appContainerId, productionComposeProjectName, 'app', 'False', applicationImageId, String(appRunning)].join('|');
        }
        if (arguments_[0] === 'stop') appRunning = false;
        if (arguments_[0] === 'start') {
          appStartCalls += 1;
          appRunning = true;
        }
        if (arguments_.includes('pg_restore') && arguments_.includes('--clean')) {
          throw new Error('unsupervised destructive restore was invoked');
        }
        return '';
      };
      const { restorePostgresBackup } = await import('../scripts/postgres-restore.js');
      await assert.rejects(restorePostgresBackup({
        backup,
        lockFile,
        postgresExpectedImageId: postgresImageId,
        productionAppImageId: applicationImageId,
        restoreDeadlineMs: 60_000,
        runDocker,
        async runSupervisedRestore(options) {
          propagatedDeadline = options.restoreDeadlineMs;
          throw settlementError;
        },
        log() {},
      }), (error) => error === settlementError);
      assert.equal(propagatedDeadline, 60_000,
        'restore must propagate its validated deadline to the supervisor module');
      assert.equal(appRunning, false);
      assert.equal(appStartCalls, 0,
        'unproven remote settlement must never restart the application');
      const marker = await fs.readFile(lockFile, 'utf8');
      assert.match(marker, /^RETAINED\nprotocol=easyboost-database-operation-lock-v3\n/u);
      assert.match(marker, /reason=REMOTE_RESTORE_SETTLEMENT_UNPROVEN\n/u);
      assert.match(marker,
        /operationToken=12345678-1234-4abc-8def-1234567890ab\n/u);
      assert.match(marker,
        /applicationName=easyboost_restore_12345678-1234-4abc-8def-1234567890ab\n/u);
      assert.match(marker, new RegExp(
        `postgresContainerId=${canonicalPostgresContainerId}\\n`, 'u',
      ));
      assert.match(marker, /lastProbeStatus=RUNNING\nlastProbeProcess=ACTIVE\n/u);
      await fs.access(path.join(directory, '.easyboost-host-operation.lock', 'owner'));
      const { acquireDatabaseOperationLock } = await import(
        '../scripts/database-operation-lock.js'
      );
      await assert.rejects(acquireDatabaseOperationLock(lockFile), /DATABASE_OPERATION_LOCKED/u);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

test('database-only restore proves application absence twice before destructive work and never manages app lifecycle',
  async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-database-only-restore-'));
    try {
      const backup = path.join(directory, 'restore.dump');
      await fs.writeFile(backup, 'fake pg dump bytes', { mode: 0o600 });
      const applicationImageId = `sha256:${'a'.repeat(64)}`;
      const postgresImageId = `sha256:${'b'.repeat(64)}`;
      const postgresContainerId = '2'.repeat(64);
      const events = [];
      let readinessCalls = 0;
      const { restorePostgresBackup } = await import('../scripts/postgres-restore.js');
      const result = await restorePostgresBackup({
        applicationMode: 'absent',
        backup,
        checkReadiness: async () => { readinessCalls += 1; },
        lockFile: path.join(directory, 'restore.lock'),
        postgresExpectedImageId: postgresImageId,
        productionAppImageId: applicationImageId,
        runDocker: async (arguments_) => {
          events.push(['docker', ...arguments_]);
          if (arguments_[0] === 'compose' && arguments_.includes('ps')
              && arguments_.at(-1) === 'postgres') return postgresContainerId;
          if (arguments_[0] === 'compose' && arguments_.includes('ps')
              && arguments_.at(-1) === 'app') return '';
          if (arguments_[0] === 'inspect' && arguments_.at(-1) === postgresContainerId) {
            return exactPostgresProof(postgresImageId, postgresContainerId);
          }
          if (arguments_[0] === 'exec' && arguments_.includes('--list')) return 'archive list';
          throw new Error(`unexpected Docker call: ${arguments_.join(' ')}`);
        },
        runSupervisedRestore: async ({ postgresContainerId: supervisedContainerId }) => {
          assert.equal(supervisedContainerId, postgresContainerId);
          events.push(['supervised-restore']);
        },
        log() {},
      });
      const supervisedIndex = events.findIndex(([kind]) => kind === 'supervised-restore');
      const appProofIndexes = events
        .map((arguments_, index) => ({ arguments_, index }))
        .filter(({ arguments_ }) => arguments_[0] === 'docker'
          && arguments_.includes('ps') && arguments_.at(-1) === 'app')
        .map(({ index }) => index);
      assert.ok(appProofIndexes.length >= 2,
        'database-only restore must prove the Compose app allocation empty at least twice');
      assert.ok(appProofIndexes[0] < appProofIndexes[1]
        && appProofIndexes[1] === supervisedIndex - 1,
      'the second empty-allocation proof must be immediately before supervised destructive work');
      assert.equal(events.some((arguments_) => (
        arguments_[0] === 'docker'
        && (arguments_[1] === 'start' || arguments_[1] === 'stop'
          || (arguments_[1] === 'inspect' && arguments_.at(-1) !== postgresContainerId)
          || (arguments_[1] === 'image' && arguments_[2] === 'inspect'))
      )), false, 'database-only restore must not inspect, start, or stop an application');
      assert.equal(readinessCalls, 0,
        'database-only restore must not check application readiness');
      assert.equal(result.applicationMode, 'absent');
      assert.equal(result.appContainerId, undefined);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

test('database-only restore rejects a newly allocated app before mutation and reproves absence without deleting it',
  async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-database-only-race-'));
    try {
      const backup = path.join(directory, 'restore.dump');
      await fs.writeFile(backup, 'fake pg dump bytes', { mode: 0o600 });
      const applicationImageId = `sha256:${'a'.repeat(64)}`;
      const postgresImageId = `sha256:${'b'.repeat(64)}`;
      const postgresContainerId = '2'.repeat(64);
      const foreignAppContainerId = '9'.repeat(64);
      const appAllocations = ['', foreignAppContainerId, ''];
      const calls = [];
      let supervisedCalls = 0;
      const { restorePostgresBackup } = await import('../scripts/postgres-restore.js');
      await assert.rejects(restorePostgresBackup({
        applicationMode: 'absent',
        backup,
        lockFile: path.join(directory, 'restore.lock'),
        postgresExpectedImageId: postgresImageId,
        productionAppImageId: applicationImageId,
        runDocker: async (arguments_) => {
          calls.push(arguments_);
          if (arguments_[0] === 'compose' && arguments_.includes('ps')
              && arguments_.at(-1) === 'postgres') return postgresContainerId;
          if (arguments_[0] === 'compose' && arguments_.includes('ps')
              && arguments_.at(-1) === 'app') return appAllocations.shift() ?? '';
          if (arguments_[0] === 'inspect' && arguments_.at(-1) === postgresContainerId) {
            return exactPostgresProof(postgresImageId, postgresContainerId);
          }
          if (arguments_[0] === 'exec' && arguments_.includes('--list')) return 'archive list';
          throw new Error(`unexpected Docker call: ${arguments_.join(' ')}`);
        },
        runSupervisedRestore: async () => { supervisedCalls += 1; },
        log() {},
      }), /APPLICATION_ALLOCATION_PRESENT_DURING_DATABASE_ONLY_RESTORE/u);
      assert.equal(supervisedCalls, 0,
        'an app appearing at the last pre-restore proof must prevent destructive work');
      assert.equal(appAllocations.length, 0,
        'failure handling must reprove that the unexpected allocation is absent');
      assert.equal(calls.some((arguments_) => (
        arguments_[0] === 'stop' || arguments_[0] === 'start'
          || arguments_.at(-1) === foreignAppContainerId
      )), false, 'database-only recovery must never manage the foreign app allocation');
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

test('database-only restore retains recovery authority when app absence stays unproven after mutation',
  async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-database-only-retain-'));
    try {
      const backup = path.join(directory, 'restore.dump');
      const lockFile = path.join(directory, 'restore.lock');
      await fs.writeFile(backup, 'fake pg dump bytes', { mode: 0o600 });
      const applicationImageId = `sha256:${'a'.repeat(64)}`;
      const postgresImageId = `sha256:${'b'.repeat(64)}`;
      const postgresContainerId = '2'.repeat(64);
      const foreignAppContainerId = '9'.repeat(64);
      const appAllocations = ['', '', foreignAppContainerId, foreignAppContainerId];
      const calls = [];
      const { restorePostgresBackup } = await import('../scripts/postgres-restore.js');
      await assert.rejects(restorePostgresBackup({
        applicationMode: 'absent',
        backup,
        lockFile,
        postgresExpectedImageId: postgresImageId,
        productionAppImageId: applicationImageId,
        runDocker: async (arguments_) => {
          calls.push(arguments_);
          if (arguments_[0] === 'compose' && arguments_.includes('ps')
              && arguments_.at(-1) === 'postgres') return postgresContainerId;
          if (arguments_[0] === 'compose' && arguments_.includes('ps')
              && arguments_.at(-1) === 'app') {
            return appAllocations.shift() ?? foreignAppContainerId;
          }
          if (arguments_[0] === 'inspect' && arguments_.at(-1) === postgresContainerId) {
            return exactPostgresProof(postgresImageId, postgresContainerId);
          }
          if (arguments_[0] === 'exec' && arguments_.includes('--list')) return 'archive list';
          throw new Error(`unexpected Docker call: ${arguments_.join(' ')}`);
        },
        runSupervisedRestore: async () => restoreRecoveryEvidence(postgresContainerId),
        log() {},
      }), (error) => {
        assert.ok(error instanceof AggregateError);
        assert.match(error.errors[0].message,
          /APPLICATION_ALLOCATION_PRESENT_DURING_DATABASE_ONLY_RESTORE/u);
        assert.equal(error.cause, error.errors[0]);
        return true;
      });
      const marker = await fs.readFile(lockFile, 'utf8');
      assert.match(marker, /^RETAINED\nprotocol=easyboost-database-operation-lock-v3\n/u);
      assert.match(marker,
        /reason=APPLICATION_ISOLATION_UNPROVEN_AFTER_DATABASE_RESTORE\n/u);
      assert.match(marker, /evidenceKind=restore\n/u);
      assert.match(marker, new RegExp(
        `postgresContainerId=${postgresContainerId}\\n`, 'u',
      ));
      await fs.access(path.join(directory, '.easyboost-host-operation.lock', 'owner'));
      assert.equal(calls.some((arguments_) => (
        arguments_[0] === 'stop' || arguments_[0] === 'start'
          || arguments_.at(-1) === foreignAppContainerId
      )), false, 'persistent foreign app allocation must never be managed by database-only restore');
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

test('managed restore retains recovery authority when exact app isolation fails after mutation',
  async () => {
    for (const scenario of ['restore-failure', 'readiness-failure']) {
      const directory = await fs.mkdtemp(path.join(
        os.tmpdir(), `easyboost-managed-isolation-${scenario}-`,
      ));
      try {
        const backup = path.join(directory, 'restore.dump');
        const lockFile = path.join(directory, 'restore.lock');
        await fs.writeFile(backup, 'fake pg dump bytes', { mode: 0o600 });
        const applicationImageId = `sha256:${'a'.repeat(64)}`;
        const postgresImageId = `sha256:${'b'.repeat(64)}`;
        const appContainerId = '1'.repeat(64);
        const postgresContainerId = '2'.repeat(64);
        const primaryError = new Error(`${scenario} primary`);
        const stopError = new Error(`${scenario} exact app stop failed`);
        let appRunning = true;
        let stopCalls = 0;
        const { restorePostgresBackup } = await import('../scripts/postgres-restore.js');
        await assert.rejects(restorePostgresBackup({
          backup,
          checkReadiness: async () => {
            if (scenario === 'readiness-failure') throw primaryError;
            throw new Error('readiness must not run after restore failure');
          },
          lockFile,
          postgresExpectedImageId: postgresImageId,
          productionAppImageId: applicationImageId,
          runDocker: async (arguments_) => {
            if (arguments_[0] === 'image') return applicationImageId;
            if (arguments_[0] === 'compose' && arguments_.includes('ps')
                && arguments_.at(-1) === 'postgres') return postgresContainerId;
            if (arguments_[0] === 'compose' && arguments_.includes('ps')
                && arguments_.at(-1) === 'app') return appContainerId;
            if (arguments_[0] === 'inspect' && arguments_.at(-1) === postgresContainerId) {
              return exactPostgresProof(postgresImageId, postgresContainerId);
            }
            if (arguments_[0] === 'inspect' && arguments_.at(-1) === appContainerId) {
              return [
                appContainerId, productionComposeProjectName, 'app', 'False', applicationImageId, String(appRunning),
              ].join('|');
            }
            if (arguments_[0] === 'exec' && arguments_.includes('--list')) {
              return 'archive list';
            }
            if (arguments_[0] === 'stop' && arguments_.at(-1) === appContainerId) {
              stopCalls += 1;
              if (stopCalls === 1) {
                appRunning = false;
                return appContainerId;
              }
              throw stopError;
            }
            if (arguments_[0] === 'start' && arguments_.at(-1) === appContainerId) {
              appRunning = true;
              return appContainerId;
            }
            throw new Error(`unexpected Docker call: ${arguments_.join(' ')}`);
          },
          runSupervisedRestore: async () => {
            if (scenario === 'restore-failure') {
              appRunning = true;
              primaryError.recoveryEvidence = restoreRecoveryEvidence(postgresContainerId, {
                activityCount: 0,
                process: 'NONE',
                status: 'EXIT:1',
              });
              throw primaryError;
            }
            return restoreRecoveryEvidence(postgresContainerId);
          },
          log() {},
        }), (error) => {
          assert.ok(error instanceof AggregateError);
          assert.equal(error.errors[0], primaryError,
            `${scenario} must remain the primary lifecycle failure`);
          assert.equal(error.cause, primaryError);
          return true;
        });
        const marker = await fs.readFile(lockFile, 'utf8');
        assert.match(marker,
          /reason=APPLICATION_ISOLATION_UNPROVEN_AFTER_DATABASE_RESTORE\n/u,
          `${scenario} must retain exact manual-recovery authority`);
        assert.match(marker,
          /applicationName=easyboost_restore_12345678-1234-4abc-8def-1234567890ab\n/u);
        assert.match(marker, new RegExp(
          `postgresContainerId=${postgresContainerId}\\n`, 'u',
        ));
        await fs.access(path.join(directory, '.easyboost-host-operation.lock', 'owner'));
        assert.equal(appRunning, true,
          `${scenario} fixture must prove exact app isolation remained unproven`);
      } finally {
        await fs.rm(directory, { recursive: true, force: true });
      }
    }
  });

test('restore CLI accepts only explicit managed or confirmed database-only grammar', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-restore-cli-'));
  try {
    const script = path.join(projectDirectory, 'scripts', 'postgres-restore.js');
    const missingBackup = path.join(directory, 'missing.dump');
    const environment = {
      ...process.env,
      EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID: `sha256:${'b'.repeat(64)}`,
      EASYBOOST_PRODUCTION_APP_IMAGE_ID: `sha256:${'a'.repeat(64)}`,
    };
    for (const arguments_ of [
      [missingBackup, '--confirm-restore'],
      [missingBackup, '--database-only', '--confirm-restore'],
    ]) {
      const accepted = spawnSync(process.execPath, [script, ...arguments_], {
        cwd: directory,
        encoding: 'utf8',
        env: environment,
      });
      assert.equal(accepted.status, 1,
        `valid restore grammar must reach backup validation: ${accepted.stderr}`);
      assert.doesNotMatch(accepted.stderr, /Usage:/u);
    }
    for (const arguments_ of [
      [missingBackup, '--database-only'],
      [missingBackup, '--confirm-restore', '--database-only'],
      [missingBackup, '--database-only', '--confirm-restore', '--extra'],
    ]) {
      const rejected = spawnSync(process.execPath, [script, ...arguments_], {
        cwd: directory,
        encoding: 'utf8',
        env: environment,
      });
      assert.equal(rejected.status, 2,
        `invalid restore grammar must fail with usage status: ${rejected.stderr}`);
      assert.match(rejected.stderr,
        /Usage: npm run db:restore -- <backup\.dump> (?:--confirm-restore|--database-only --confirm-restore)/u);
    }
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('standalone restore serializes concurrent operations before any second Docker call',
  async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-restore-lock-'));
    try {
      const backup = path.join(directory, 'restore.dump');
      await fs.writeFile(backup, 'fake pg dump bytes', 'utf8');
      const applicationImageId = `sha256:${'a'.repeat(64)}`;
      const postgresImageId = `sha256:${'b'.repeat(64)}`;
      const appContainerId = '1'.repeat(64);
      const operationLockFile = path.join(directory, '.easyboost-database-operation.lock');
      let appRunning = true;
      let releaseValidation;
      const validationRelease = new Promise((resolve) => { releaseValidation = resolve; });
      let validationStartedResolve;
      const validationStarted = new Promise((resolve) => { validationStartedResolve = resolve; });
      const runDocker = async (arguments_) => {
        if (arguments_[0] === 'image') return applicationImageId;
        if (arguments_.includes('ps') && arguments_.at(-1) === 'postgres') {
          return canonicalPostgresContainerId;
        }
        if (arguments_[0] === 'inspect'
            && arguments_.at(-1) === canonicalPostgresContainerId) {
          return exactPostgresProof(postgresImageId);
        }
        if (arguments_.includes('pg_restore') && arguments_.includes('--list')) {
          validationStartedResolve();
          await validationRelease;
        }
        if (arguments_.includes('ps') && arguments_.at(-1) === 'app') return appContainerId;
        if (arguments_[0] === 'inspect' && arguments_.at(-1) === appContainerId) {
          return [appContainerId, productionComposeProjectName, 'app', 'False', applicationImageId, String(appRunning)].join('|');
        }
        if (arguments_[0] === 'stop') appRunning = false;
        if (arguments_[0] === 'start') appRunning = true;
        return '';
      };
      const { restorePostgresBackup } = await import('../scripts/postgres-restore.js');
      const firstRestore = restorePostgresBackup({
        backup,
        checkReadiness: async () => ({ ok: true }),
        lockFile: operationLockFile,
        postgresExpectedImageId: postgresImageId,
        productionAppImageId: applicationImageId,
        runDocker,
        runSupervisedRestore: async () => {},
        log() {},
      });
      await validationStarted;
      let secondDockerCalled = false;
      await assert.rejects(restorePostgresBackup({
        backup,
        lockFile: operationLockFile,
        postgresExpectedImageId: postgresImageId,
        productionAppImageId: applicationImageId,
        runDocker: async () => { secondDockerCalled = true; return ''; },
        log() {},
      }), /HOST_OPERATION_LOCKED/u);
      assert.equal(secondDockerCalled, false,
        'the contending restore must fail before any Docker or database work');
      releaseValidation();
      await firstRestore;
      await assert.rejects(
        fs.access(operationLockFile),
        { code: 'ENOENT' },
        'successful restore must release its exclusive operation lock',
      );
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

test('standalone restore readiness probe has a finite retry and timeout budget', async () => {
  const { waitForApplicationReadiness } = await import('../scripts/postgres-restore.js');
  let requests = 0;
  let waits = 0;
  await assert.rejects(waitForApplicationReadiness({
    attempts: 3,
    fetchImpl: async () => {
      requests += 1;
      return { ok: false, status: 503 };
    },
    intervalMs: 1,
    requestTimeoutMs: 50,
    wait: async () => { waits += 1; },
  }), /Application readiness failed after 3 attempts/u);
  assert.equal(requests, 3, 'the readiness boundary must stop after its configured finite attempts');
  assert.equal(waits, 2, 'the readiness boundary waits only between attempts');
  const timeoutStartedAt = Date.now();
  await assert.rejects(waitForApplicationReadiness({
    attempts: 1,
    fetchImpl: async () => new Promise(() => {}),
    intervalMs: 1,
    requestTimeoutMs: 20,
  }), /Application readiness failed after 1 attempts/u);
  assert.ok(Date.now() - timeoutStartedAt < 500,
    'a stalled readiness request must remain bounded by its per-request timeout');
});

test('standalone restore stops the exact-image app when bounded readiness fails', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-restore-readiness-'));
  try {
    const backup = path.join(directory, 'restore.dump');
    await fs.writeFile(backup, 'fake pg dump bytes', 'utf8');
    const applicationImageId = `sha256:${'a'.repeat(64)}`;
    const postgresImageId = `sha256:${'b'.repeat(64)}`;
    const appContainerId = '1'.repeat(64);
    const calls = [];
    const logs = [];
    let appRunning = true;
    const readinessError = new Error('bounded readiness exhausted');
    const runDocker = async (arguments_) => {
      calls.push(arguments_);
      if (arguments_[0] === 'image') return applicationImageId;
      if (arguments_.includes('ps') && arguments_.at(-1) === 'postgres') {
        return canonicalPostgresContainerId;
      }
      if (arguments_[0] === 'inspect'
          && arguments_.at(-1) === canonicalPostgresContainerId) {
        return exactPostgresProof(postgresImageId);
      }
      if (arguments_.includes('ps') && arguments_.at(-1) === 'app') return appContainerId;
      if (arguments_[0] === 'inspect' && arguments_.at(-1) === appContainerId) {
        return [appContainerId, productionComposeProjectName, 'app', 'False', applicationImageId, String(appRunning)].join('|');
      }
      if (arguments_[0] === 'stop' && arguments_.at(-1) === appContainerId) {
        appRunning = false;
      }
      if (arguments_[0] === 'start' && arguments_.at(-1) === appContainerId) appRunning = true;
      return '';
    };
    const { restorePostgresBackup } = await import('../scripts/postgres-restore.js');
    await assert.rejects(restorePostgresBackup({
      backup,
      checkReadiness: async () => { throw readinessError; },
      composeFile: path.join(directory, 'compose.production.yml'),
      lockFile: path.join(directory, 'restore.lock'),
      log(message) { logs.push(message); },
      postgresExpectedImageId: postgresImageId,
      productionAppImageId: applicationImageId,
      runDocker,
      runSupervisedRestore: async () => {},
    }), (error) => error === readinessError);
    const appStops = calls.filter((arguments_) => (
      arguments_[0] === 'stop' && arguments_.at(-1) === appContainerId
    ));
    assert.equal(appStops.length, 2,
      'restore must stop once before mutation and again after readiness failure');
    assert.equal(appRunning, false,
      'exact-ID cleanup must verify and retain the stopped state after readiness failure');
    assert.equal(calls.some((arguments_) => (
      arguments_[0] === 'compose' && arguments_.includes('stop')
    )), false, 'restore must never stop a mutable Compose service selection');
    assert.equal(logs.includes('Restore completed successfully.'), false,
      'readiness failure must never publish restore success');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('standalone restore stops the app when post-start exact-image inspection errors', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-restore-app-inspect-'));
  try {
    const backup = path.join(directory, 'restore.dump');
    await fs.writeFile(backup, 'fake pg dump bytes', 'utf8');
    const applicationImageId = `sha256:${'a'.repeat(64)}`;
    const postgresImageId = `sha256:${'b'.repeat(64)}`;
    const appContainerId = '1'.repeat(64);
    const calls = [];
    let appRunning = true;
    let appStarted = false;
    let postStartInspectFailed = false;
    const inspectError = new Error('app inspect daemon failure');
    const runDocker = async (arguments_) => {
      calls.push(arguments_);
      if (arguments_[0] === 'image') return applicationImageId;
      if (arguments_.includes('ps') && arguments_.at(-1) === 'postgres') {
        return canonicalPostgresContainerId;
      }
      if (arguments_[0] === 'inspect'
          && arguments_.at(-1) === canonicalPostgresContainerId) {
        return exactPostgresProof(postgresImageId);
      }
      if (arguments_.includes('ps') && arguments_.at(-1) === 'app') return appContainerId;
      if (arguments_[0] === 'inspect' && arguments_.at(-1) === appContainerId) {
        if (appStarted && appRunning && !postStartInspectFailed) {
          postStartInspectFailed = true;
          throw inspectError;
        }
        return [appContainerId, productionComposeProjectName, 'app', 'False', applicationImageId, String(appRunning)].join('|');
      }
      if (arguments_[0] === 'stop' && arguments_.at(-1) === appContainerId) appRunning = false;
      if (arguments_[0] === 'start' && arguments_.at(-1) === appContainerId) {
        appStarted = true;
        appRunning = true;
      }
      return '';
    };
    const { restorePostgresBackup } = await import('../scripts/postgres-restore.js');
    await assert.rejects(restorePostgresBackup({
      backup,
      checkReadiness: async () => { throw new Error('readiness must not run'); },
      composeFile: path.join(directory, 'compose.production.yml'),
      lockFile: path.join(directory, 'restore.lock'),
      log() {},
      postgresExpectedImageId: postgresImageId,
      productionAppImageId: applicationImageId,
      runDocker,
      runSupervisedRestore: async () => {},
    }), (error) => error === inspectError);
    const appStops = calls.filter((arguments_) => (
      arguments_[0] === 'stop' && arguments_.at(-1) === appContainerId
    ));
    assert.equal(appStops.length, 2,
      'a post-start inspect error must trigger a second fail-closed app stop');
    assert.equal(appRunning, false,
      'post-start inspection failure must leave the exact immutable ID stopped');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('backup verification publishes success only after temporary database cleanup', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-verify-cleanup-'));
  try {
    const backupDirectory = path.join(directory, 'backups');
    const backup = path.join(backupDirectory, 'easyboost-cleanup-test.dump');
    await fs.mkdir(backupDirectory, { recursive: true });
    await fs.writeFile(backup, 'fake pg dump bytes', 'utf8');
    const applicationImageId = `sha256:${'e'.repeat(64)}`;
    const verifyModule = new URL('../scripts/postgres-verify-backup.js', import.meta.url).href;
    for (const scenario of ['verify-cleanup-fails', 'verify-primary-cleanup-fails']) {
      const result = await runTemporaryModuleHarness(directory, [
        "import fs from 'node:fs/promises';",
        `const { verifyPostgresBackup } = await import(${JSON.stringify(verifyModule)});`,
        "const expectedMigrations = (await fs.readdir(process.env.MIGRATIONS_DIRECTORY)).filter((file) => /^\\d{3}_[a-z0-9_]+\\.sql$/u.test(file)).sort();",
        'const calls = [];',
        "const primaryError = new Error('primary pg_restore failed with exit code 42');",
        "const cleanupError = new Error('cleanup dropdb failed with exit code 43');",
        'const runDocker = async (arguments_) => {',
        '  calls.push(arguments_);',
        "  if (arguments_[0] === 'image') return process.env.POSTGRES_IMAGE_ID;",
        "  if (arguments_.includes('ps') && arguments_.at(-1) === 'postgres') return process.env.POSTGRES_CONTAINER_ID;",
        "  if (arguments_[0] === 'inspect' && arguments_.at(-1) === process.env.POSTGRES_CONTAINER_ID) return [process.env.POSTGRES_CONTAINER_ID, 'postgres', 'False', process.env.POSTGRES_IMAGE_ID, 'true'].join('|');",
        "  if (arguments_.includes('pg_restore') && arguments_.some((value) => value.startsWith('easyboost_restore_check_'))",
        "    && process.env.SCENARIO === 'verify-primary-cleanup-fails') throw primaryError;",
        "  if (arguments_.includes('dropdb')) throw cleanupError;",
        "  if (arguments_.includes('psql')) {",
        "    const query = arguments_.at(-1);",
        "    if (query.includes('information_schema.tables')) return ['module_attempts', 'schema_migrations', 'user_progress', 'users', 'word_progress'].join('\\n');",
        "    if (query.includes('SELECT version')) return expectedMigrations.join('\\n');",
        "    return `3:5:7:11:${expectedMigrations.length}`;",
        "  }",
        "  return '';",
        '};',
        'const createVerificationRuntime = async ({ runDocker: docker }) => {',
        "  await docker(['exec', '-i', process.env.POSTGRES_CONTAINER_ID, 'createdb', '-U', 'easyboost', 'easyboost_restore_check_fixture']);",
        '  return {',
        "    containerId: process.env.POSTGRES_CONTAINER_ID, isolation: 'disposable-exact-image-container', volumeName: 'fixture-volume',",
        "    cleanup: async () => docker(['exec', '-i', process.env.POSTGRES_CONTAINER_ID, 'dropdb', '-U', 'easyboost', '--force', 'easyboost_restore_check_fixture']),",
        '  };',
        '};',
        'const runSupervisedRestore = async ({ inputHandle, operationToken, postgresContainerId, runDocker: docker }) => {',
        "  await docker(['exec', '-i', postgresContainerId, 'pg_restore', '-U', 'easyboost', '-d', 'easyboost_restore_check_fixture', '--no-owner', '--no-privileges', '--exit-on-error'], { inputHandle });",
        "  return { applicationName: `easyboost_restore_${operationToken}`, kind: 'restore', lastProbe: { activityCount: 0, process: 'NONE', settled: true, status: 'EXIT:0' }, operationToken, postgresContainerId, settlement: 'remote-proof' };",
        '};',
        'let caught;',
        'try {',
        '  await verifyPostgresBackup({',
        '    backup: process.env.BACKUP_PATH,',
        '    backupDirectory: process.env.BACKUP_DIRECTORY,',
        '    createVerificationRuntime,',
        '    composeFile: process.env.COMPOSE_FILE,',
        '    migrationsDirectory: process.env.MIGRATIONS_DIRECTORY,',
        '    postgresExpectedImageId: process.env.POSTGRES_IMAGE_ID,',
        '    productionAppImageId: process.env.APP_IMAGE_ID,',
        '    runDocker,',
        '    runSupervisedRestore,',
        '  });',
        '} catch (error) { caught = error; }',
        "if (!caught) throw new Error('verification unexpectedly succeeded');",
        "if (process.env.SCENARIO === 'verify-cleanup-fails') throw caught;",
        'const status = JSON.parse(await fs.readFile(process.env.STATUS_FILE, \'utf8\'));',
        'process.stdout.write(JSON.stringify({',
        '  calls,',
        '  error: {',
        '    aggregate: caught instanceof AggregateError,',
        '    cause: caught.cause?.message || null,',
        '    errors: caught.errors?.map((error) => error.message) || [caught.message],',
        '  },',
        '  status,',
        '}));',
      ].join('\n'), {
        APP_IMAGE_ID: applicationImageId,
        BACKUP_DIRECTORY: backupDirectory,
        BACKUP_PATH: backup,
        COMPOSE_FILE: path.join(directory, 'compose.production.yml'),
        MIGRATIONS_DIRECTORY: path.join(projectDirectory, 'migrations'),
        POSTGRES_CONTAINER_ID: canonicalPostgresContainerId,
        POSTGRES_IMAGE_ID: `sha256:${'d'.repeat(64)}`,
        SCENARIO: scenario,
        STATUS_FILE: path.join(backupDirectory, 'restore-check-status.json'),
      });
      if (scenario === 'verify-cleanup-fails') {
        assert.notEqual(result.status, 0,
          'cleanup failure must propagate to a nonzero process outcome');
        assert.equal(fsSync.existsSync(path.join(
          backupDirectory,
          'restore-check-status.json',
        )), true, `verification failure status is missing: ${result.stdout}\n${result.stderr}`);
        const status = JSON.parse(await fs.readFile(
          path.join(backupDirectory, 'restore-check-status.json'), 'utf8',
        ));
        assert.equal(status.status, 'failed');
        assert.match(status.errorCode, /dropdb[\s\S]*exit code 43/u,
          'cleanup-only failure must become the published primary error');
        assert.match(result.stderr, /cleanup dropdb failed with exit code 43/u);
        continue;
      }
      assert.equal(result.status, 0,
        `${scenario} lifecycle harness failed: ${result.stdout}\n${result.stderr}`);
      const { calls, error, status } = JSON.parse(result.stdout);
      assert.equal(status.status, 'failed');
      assert.match(status.errorCode, /pg_restore[\s\S]*exit code 42/u,
        'the original verification failure must remain primary');
      assert.match(status.cleanupErrorCode, /dropdb[\s\S]*exit code 43/u,
        'a concurrent cleanup failure must be published separately');
      assert.equal(error.aggregate, true);
      assert.deepEqual(error.errors, [
        'primary pg_restore failed with exit code 42',
        'cleanup dropdb failed with exit code 43',
      ]);
      assert.equal(error.cause, 'primary pg_restore failed with exit code 42');
      assert.ok(calls.some((arguments_) => arguments_.includes('dropdb')),
        `${scenario} must attempt cleanup`);
    }
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('backup verification retains operation errors when failure-status publication also fails',
  async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-verify-status-failure-'));
    try {
      const backup = path.join(directory, 'backup.dump');
      await fs.writeFile(backup, 'fake pg dump bytes', 'utf8');
      const applicationImageId = `sha256:${'a'.repeat(64)}`;
      const postgresImageId = `sha256:${'b'.repeat(64)}`;
      const primaryError = new Error('primary pg_restore failure');
      const cleanupError = new Error('cleanup dropdb failure');
      const publicationError = new Error('failure status publication failure');
      const runDocker = async (arguments_) => {
        if (arguments_[0] === 'image') return postgresImageId;
        if (arguments_.includes('ps') && arguments_.at(-1) === 'postgres') {
          return canonicalPostgresContainerId;
        }
        if (arguments_[0] === 'inspect'
            && arguments_.at(-1) === canonicalPostgresContainerId) {
          return exactPostgresProof(postgresImageId);
        }
        if (arguments_.includes('pg_restore') && !arguments_.includes('--list')) {
          throw primaryError;
        }
        if (arguments_.includes('dropdb')) throw cleanupError;
        return '';
      };
      const { verifyPostgresBackup } = await import('../scripts/postgres-verify-backup.js');
      await assert.rejects(verifyPostgresBackup({
        backup,
        backupDirectory: directory,
        createVerificationRuntime: createTestVerificationRuntime(),
        composeFile: path.join(directory, 'compose.production.yml'),
        lockFile: path.join(directory, 'verify.lock'),
        postgresExpectedImageId: postgresImageId,
        productionAppImageId: applicationImageId,
        publishStatus: async () => { throw publicationError; },
        runDocker,
        runSupervisedRestore: runTestSupervisedVerificationRestore,
      }), (error) => {
        assert.ok(error instanceof AggregateError);
        assert.equal(error.cause, primaryError);
        assert.deepEqual(error.errors, [primaryError, cleanupError, publicationError]);
        return true;
      });
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

test('database restore runbook supplies the owner-approved image authority to the standalone CLI', async () => {
  const readme = await fs.readFile(path.join(projectDirectory, 'README_DEPLOY.md'), 'utf8');
  const command = '/usr/bin/node scripts/postgres-restore.js /secure/easyboost.dump --confirm-restore';
  const commandIndex = readme.indexOf(command);
  const blockStart = readme.lastIndexOf('```bash', commandIndex);
  const blockEnd = readme.indexOf('```', blockStart + '```bash'.length);
  const procedure = readme.slice(blockStart, blockEnd);
  assert.ok(blockStart >= 0 && blockEnd > commandIndex, 'database restore command must be fenced Bash');
  const authorityIndex = procedure.indexOf('EASYBOOST_PRODUCTION_APP_IMAGE_ID');
  assert.ok(authorityIndex >= 0 && authorityIndex < procedure.indexOf(command),
    'database restore must receive the owner-approved canonical app image ID before it starts');
  const postgresAuthorityIndex = procedure.indexOf('EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID');
  assert.ok(postgresAuthorityIndex >= 0 && postgresAuthorityIndex < procedure.indexOf(command),
    'database restore must receive the owner-approved PostgreSQL image ID before it starts');
  const hostGuardIndex = procedure.indexOf(
    'EASYBOOST_HOST_OPERATION_LOCK_DIR=/var/lib/easyboost/locks/host-operation.lock',
  );
  assert.ok(hostGuardIndex >= 0 && hostGuardIndex < procedure.indexOf(command),
    'destructive restore must receive the exact shared host guard before it starts');
  assert.match(procedure,
    /sudo --preserve-env=EASYBOOST_HOST_OPERATION_LOCK_DIR,EASYBOOST_PRODUCTION_APP_IMAGE_ID,EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID/u,
    'root-owned host guard requires the destructive restore entrypoint to run under sudo/root');
  const backupSection = readme.slice(
    readme.indexOf('## Backup и восстановление PostgreSQL'),
    readme.indexOf('## Откат приложения'),
  );
  const retainedSection = backupSection.slice(
    backupSection.indexOf('### Retained restore marker'),
    backupSection.indexOf('Перед установкой cron'),
  );
  assert.match(backupSection,
    /host-operation guard[\s\S]*?atomic directory[\s\S]*?root:root/iu,
    'restore runbook must describe the shared root-owned host serialization authority');
  assert.match(backupSection,
    /Managed restore[\s\S]*?exact running app allocation[\s\S]*?тот же ID/iu,
    'restore runbook must distinguish exact-ID managed stop and restart semantics');
  assert.match(backupSection,
    /Database-only restore[\s\S]*?пустой Compose app[\s\S]*?никогда не создаёт/iu,
    'database-only runbook must require a continuously absent app allocation');
  assert.match(backupSection,
    /descriptor-safe[\s\S]*?SHA-256[\s\S]*?frozen[\s\S]*?backupSha256/iu,
    'database runbook must describe exact archive-byte authority and published digest evidence');
  assert.match(backupSection,
    /restore \*\*никогда не выполняется в live production[\s\S]*?container и volume[\s\S]*?exact[\s\S]*?network/iu,
    'scheduled verification must be documented as disposable and isolated from live production');
  assert.match(backupSection,
    /operationToken[\s\S]*?applicationName[\s\S]*?postgresContainerId[\s\S]*?lastProbe/iu,
    'retained restore recovery must document its structured non-secret evidence');
  assert.match(retainedSection,
    /\/usr\/bin\/node scripts\/production-restore-recovery\.js/u,
    'retained restore recovery must use the executable typed helper');
  assert.doesNotMatch(retainedSection, /\bsudo\s+(?:awk|rm|rmdir)\b/u,
    'retained restore guards must not be parsed or removed with raw shell commands');
  assert.match(backupSection,
    /no-replace[\s\S]*?partial dump[\s\S]*?ручного восстановления/iu,
    'backup runbook must describe non-overwriting publication and partial cleanup evidence');
  assert.doesNotMatch(backupSection,
    /с `--pull never --no-build --no-deps` только после успешного restore/u,
    'restore runbook must not claim that the standalone CLI replaces a Compose service');
});

test('legacy JSON dry-run and live import use the guarded exact-image production entrypoint',
  async () => {
    const readme = await fs.readFile(path.join(projectDirectory, 'README_DEPLOY.md'), 'utf8');
    const sectionStart = readme.indexOf('## Импорт старого data.json');
    const sectionEnd = readme.indexOf('## Наблюдаемость', sectionStart);
    const section = readme.slice(sectionStart, sectionEnd);
    assert.doesNotMatch(section,
      /docker compose\b[^\n]*compose\.production\.yml[^\n]*run[\s\S]*?db:import-json/u,
      'the runbook must not expose an unverified raw Compose one-off import');
    for (const command of [
      '/usr/bin/node scripts/import-json.js /absolute/host/path/data.json --production-compose --dry-run',
      '/usr/bin/node scripts/import-json.js /absolute/host/path/data.json --production-compose \\',
    ]) {
      const commandIndex = section.indexOf(command);
      const blockStart = section.lastIndexOf('```bash', commandIndex);
      const blockEnd = section.indexOf('```', blockStart + '```bash'.length);
      const procedure = section.slice(blockStart, blockEnd);
      assert.ok(blockStart >= 0 && blockEnd > commandIndex,
        `legacy import command must be fenced Bash: ${command}`);
      const orderedTokens = [
        ': "${EASYBOOST_PRODUCTION_APP_IMAGE_ID:?set the currently deployed owner-approved app image ID}"',
        '[[ "$EASYBOOST_PRODUCTION_APP_IMAGE_ID" =~ ^sha256:[0-9a-f]{64}$ ]]',
        'export EASYBOOST_PRODUCTION_APP_IMAGE_ID',
        ': "${EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID:?set the owner-approved PostgreSQL sha256 image ID}"',
        '[[ "$EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID" =~ ^sha256:[0-9a-f]{64}$ ]]',
        'export EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID',
        ...(command.endsWith('\\') ? [
          ': "${EASYBOOST_IMPORT_SOURCE_SHA256:?copy sourceSha256 from the exact dry-run}"',
          '[[ "$EASYBOOST_IMPORT_SOURCE_SHA256" =~ ^[0-9a-f]{64}$ ]]',
        ] : []),
        'sudo --preserve-env=EASYBOOST_PRODUCTION_APP_IMAGE_ID,EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID',
        command,
      ];
      let cursor = -1;
      for (const token of orderedTokens) {
        const next = procedure.indexOf(token, cursor + 1);
        assert.ok(next > cursor, `legacy import authority token is missing: ${token}`);
        cursor = next;
      }
    }
    assert.match(section,
      /`sourceSha256`[\s\S]*?SHA-256[\s\S]*?`64 lowercase hex`/u,
      'the runbook must identify the exact dry-run source digest authority');
    assert.match(section,
      /shared exclusive\s+database-operation lock[\s\S]*?canonical PostgreSQL(?: container)?\s+ID[\s\S]*?network IPv4 endpoint/iu,
      'the import runbook must serialize database operations and bind one immutable PostgreSQL endpoint');
    assert.match(section,
      /повторно доказывает тот же PostgreSQL ID[\s\S]*?меняет только hostname[\s\S]*?не передаёт пароль\/URL/iu,
      'the import runbook must describe final endpoint reproof without exposing DATABASE_URL');
    assert.match(section,
      /до `docker cp`[\s\S]*?easyboost-production-json-import-v1;write=append-only;owner=exact;digest=sha256/iu,
      'the runbook must describe exact-image protocol attestation before source bytes are copied');
    assert.match(section,
      /не обновляет существующие записи[\s\S]*?provider identity[\s\S]*?откатывает[\s\S]*?весь snapshot/iu,
      'the runbook must describe append-only collision rollback');
    assert.match(section,
      /application_name=easyboost_import_[\s\S]*?pg_stat_activity[\s\S]*?оба recovery marker/iu,
      'the runbook must describe tagged remote settlement and both retained guards');
    assert.match(section,
      /\/usr\/bin\/node scripts\/production-import-recovery\.js/u,
      'retained import recovery must use the executable typed helper');
    assert.doesNotMatch(section, /\bsudo\s+(?:awk|rm|rmdir)\b/u,
      'retained import guards must not be parsed or removed with raw shell commands');
  });

test('documented detached-HEAD shell guard accepts only symbolic-ref status 1', (context) => {
  const probe = spawnSync(gitBash, ['--version'], { encoding: 'utf8' });
  if (probe.error?.code === 'ENOENT') return context.skip('Bash is not installed');
  for (const [status, accepted] of [[0, false], [1, true], [128, false]]) {
    const result = spawnSync(gitBash, ['-c', [
      'git() { return "$FAKE_SYMBOLIC_REF_STATUS"; }',
      detachedHeadGuard,
      "printf 'accepted\\n'",
    ].join('\n')], {
      encoding: 'utf8', env: { ...process.env, FAKE_SYMBOLIC_REF_STATUS: String(status) },
    });
    assert.equal(result.status === 0, accepted,
      `git symbolic-ref status ${status}: ${result.stdout}\n${result.stderr}`);
    assert.equal(result.stdout.includes('accepted'), accepted);
  }
});

test('fresh production, DR and rehearsal seed the owner-approved exact PostgreSQL image before pull-never Compose',
  async () => {
    const [compose, readme, disasterRecovery, experimentalChecklist] = await Promise.all([
      fs.readFile(path.join(projectDirectory, 'compose.production.yml'), 'utf8'),
      fs.readFile(path.join(projectDirectory, 'README_DEPLOY.md'), 'utf8'),
      fs.readFile(path.join(projectDirectory, 'docs', 'DISASTER_RECOVERY.md'), 'utf8'),
      fs.readFile(path.join(
        projectDirectory, 'docs', 'EXPERIMENTAL_RELEASE_OPERATIONS_CHECKLIST.md',
      ), 'utf8'),
    ]);
    assert.match(compose,
      /image: \$\{EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID:\?set the owner-approved PostgreSQL sha256 image ID\}[\s\S]*?pull_policy: never/u,
      'production Compose must resolve the immutable owner-approved PostgreSQL ID, never the seed tag');
    assert.doesNotMatch(compose, /^\s*image:\s*postgres:17-alpine\s*$/mu,
      'the mutable seed tag must never remain a production Compose image authority');
    assertFreshPostgresImageSeed(
      readme,
      'first production launch',
      'up --pull never --no-build -d',
    );
    assertFreshPostgresImageSeed(disasterRecovery, 'disaster recovery');
    assertFreshPostgresImageSeed(experimentalChecklist, 'fresh-host rehearsal');
  });

test('recovery docs keep RPO and current rehearsal evidence truthful and use the supervised restore seam',
  async () => {
    const [disasterRecovery, releaseChecklist, experimentalChecklist] = await Promise.all([
      fs.readFile(path.join(projectDirectory, 'docs', 'DISASTER_RECOVERY.md'), 'utf8'),
      fs.readFile(path.join(projectDirectory, 'RELEASE_CHECKLIST.md'), 'utf8'),
      fs.readFile(path.join(
        projectDirectory, 'docs', 'EXPERIMENTAL_RELEASE_OPERATIONS_CHECKLIST.md',
      ), 'utf8'),
    ]);
    assert.match(disasterRecovery,
      /RPO[\s\S]{0,220}?цель[\s\S]{0,220}?не является текущей гарантией/iu,
      'RPO must remain a target until off-host scheduling and monitoring are evidenced');
    assert.match(disasterRecovery,
      /внешн(?:ее|ий)[^\n]*хранилищ[^\n]*не подтвержден/iu,
      'the runbook must disclose that off-host backup authority is still unconfirmed');
    assert.doesNotMatch(disasterRecovery,
      /Внешние PostgreSQL-копии ежедневно загружаются/u,
      'the runbook must not claim a daily off-host upload before it is configured');
    assert.match(disasterRecovery,
      /историческ[^\n]*25 июля 2026[^\n]*не является current release evidence/iu,
      'the old restore drill must be explicitly historical and non-closing');

    assert.match(releaseChecklist,
      /- \[x\][^\n]*автоматизированн[^\n]*fixture[^\n]*не является current production-like evidence/iu,
      'checked automated coverage must not be presented as a current production rehearsal');
    assert.match(releaseChecklist,
      /- \[ \][^\n]*restore rehearsal[^\n]*production-like/iu,
      'the current production-like restore rehearsal must remain open');
    assert.match(releaseChecklist,
      /exact release commit[^\n]*image ID[^\n]*backup SHA-256[^\n]*migration/iu,
      'the open rehearsal gate must name the exact current evidence required to close it');

    for (const [label, document] of [
      ['disaster recovery', disasterRecovery],
      ['fresh-host rehearsal', experimentalChecklist],
    ]) {
      assert.doesNotMatch(document,
        /docker compose[^\n]*exec[^\n]*postgres[\s\S]{0,160}?pg_restore/u,
        `${label} must not expose an unsupervised raw Compose restore`);
      assert.match(document,
        /sudo --preserve-env=EASYBOOST_HOST_OPERATION_LOCK_DIR,EASYBOOST_PRODUCTION_APP_IMAGE_ID,EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID\s*\\?\s*\n\s*\/usr\/bin\/node scripts\/postgres-restore\.js[\s\S]{0,160}?--database-only --confirm-restore/u,
        `${label} must use the locked, frozen, supervised database-only restore interface`);
      assert.match(document,
        /exact archive bytes[^\n]*bounded headroom|exact archive bytes \+ bounded headroom/iu,
        `${label} must reserve archive bytes and bounded headroom before mutation`);
      assert.match(document,
        /PGAPPNAME|applicationName/iu,
        `${label} must document tokenized PostgreSQL activity recovery evidence`);
    }
  });

test('the real production context is fully scanned and streamed without invoking Docker', async () => {
  let contextBytes = 0;
  const verified = verifyDockerBuildContext({ projectDirectory });
  const expectedFiles = new Set([
    DEFAULT_CANDIDATE_MANIFEST,
    '.dockerignore',
    'Dockerfile',
    ...verified.reachable,
  ]).size;
  const result = await buildProductionImage({
    projectDirectory,
    async runBuild(_command, _args, _options, context) {
      for await (const chunk of context) contextBytes += chunk.length;
      return { status: 0 };
    },
  });
  assert.equal(result.files, expectedFiles,
    'the frozen candidate-manifest authority must accompany every current approved input');
  assert.equal(result.contextBytes, contextBytes);
  assert.ok(contextBytes > result.bytes);
  assert.match(result.fingerprint, /^[a-f0-9]{64}$/u);
});
