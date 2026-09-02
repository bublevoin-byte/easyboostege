import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  PREDECESSOR_COMMIT,
  buildExactPredecessorFixture,
  compatibilityArtifactDirectory,
  runPredecessorCommand,
  verifyPredecessorArtifactAgainstFixture,
  verifyPredecessorCompatibility,
} from '../scripts/pwa-predecessor-compat.js';
import { createPosixSessionControl } from '../scripts/posix-session-supervisor.js';
import {
  dockerContextIgnores as contextIgnores,
  parseDockerCopySources,
  parseDockerignore,
  validateAuditedPathSet,
  verifyDockerBuildContext,
} from '../scripts/verify-docker-context.js';

const projectDirectory = fileURLToPath(new URL('..', import.meta.url));
let exactPredecessorFixture;
let posixControlRoot;

function testPosixMaintenance(root) {
  const identity = fsSync.lstatSync(root, { bigint: true });
  const authority = Object.freeze({
    descriptor: 8,
    lease: 'a'.repeat(64),
    ownerPid: process.pid,
    ownerStartTime: '1',
    protocol: 'easyboost-staging-quiescent-maintenance-v1',
    rootDev: String(identity.dev),
    rootIno: String(identity.ino),
  });
  return {
    authority,
    reclaimRetainedEvidence(request) {
      if (request.kind === 'QUIESCENT_ABSENCE_PROOF') return true;
      fsSync.rmSync(request.container, { recursive: true });
      return true;
    },
  };
}

before(async () => {
  const controlScope = `pwa-predecessor-compat-test:${process.pid}:${randomUUID()}`;
  posixControlRoot = process.platform === 'linux'
    ? await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-pwa-predecessor-control-'))
    : undefined;
  exactPredecessorFixture = await buildExactPredecessorFixture({
    projectDirectory,
    commit: PREDECESSOR_COMMIT,
    runCommand(command, args, options = {}) {
      const controlKey = `${controlScope}:${options.commandLabel ?? command}`;
      const maintenance = posixControlRoot === undefined
        ? undefined : testPosixMaintenance(posixControlRoot);
      const posixSessionControl = maintenance === undefined
        ? undefined : createPosixSessionControl({
          controlKey,
          controlRoot: posixControlRoot,
          quiescentMaintenanceAuthority: maintenance.authority,
          reclaimRetainedEvidence: maintenance.reclaimRetainedEvidence,
        });
      return runPredecessorCommand(command, args, {
        ...options,
        posixControlKey: controlKey,
        ...(posixSessionControl === undefined ? {} : {
          posixControlRoot,
          posixRecoveryScope: `test:${controlKey}`,
          posixSessionControl,
        }),
        windowsControlKey: controlKey,
      });
    },
  });
});

after(async () => {
  if (exactPredecessorFixture) {
    await fs.rm(exactPredecessorFixture.rootDirectory, { recursive: true, force: true });
  }
  if (posixControlRoot) await fs.rm(posixControlRoot, { recursive: true, force: true });
});

function dockerPatternMatches(pattern, candidate) {
  const normalizedPattern = pattern.replaceAll('\\', '/').replace(/^\.\//u, '').replace(/\/$/u, '');
  const normalizedCandidate = candidate.replaceAll('\\', '/').replace(/^\.\//u, '');
  const escaped = normalizedPattern.replace(/[.+?^${}()|[\]\\]/gu, '\\$&').replaceAll('*', '[^/]*');
  return new RegExp(`^${escaped}(?:/.*)?$`, 'u').test(normalizedCandidate);
}

function dockerContextIgnores(source, candidate) {
  let ignored = false;
  for (const rawLine of source.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const negated = line.startsWith('!');
    const pattern = negated ? line.slice(1) : line;
    if (dockerPatternMatches(pattern, candidate)) ignored = !negated;
  }
  return ignored;
}

function finalContextCopySources(dockerfile) {
  const finalStage = dockerfile.slice(dockerfile.lastIndexOf('\nFROM '));
  const sources = [];
  for (const rawLine of finalStage.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line.startsWith('COPY ') || /\s--from=/u.test(` ${line}`)) continue;
    const tokens = line.slice('COPY '.length).split(/\s+/u).filter((token) => !token.startsWith('--'));
    sources.push(...tokens.slice(0, -1).map((token) => token.replace(/\/$/u, '')));
  }
  return sources;
}

function frontendContextCopySources(dockerfile) {
  const marker = 'FROM ${EASYBOOST_NODE_BASE_IMAGE} AS frontend-build';
  const start = dockerfile.indexOf(marker);
  assert.notEqual(start, -1, 'Dockerfile must declare the frontend-build stage');
  const stage = dockerfile.slice(start, dockerfile.indexOf('\nFROM ', start + marker.length));
  const sources = [];
  for (const rawLine of stage.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line.startsWith('COPY ') || /\s--from=/u.test(` ${line}`)) continue;
    const tokens = line.slice('COPY '.length).split(/\s+/u).filter((token) => !token.startsWith('--'));
    sources.push(...tokens.slice(0, -1).map((token) => token.replace(/\/$/u, '')));
  }
  return sources;
}

function copySourceIncludes(source, candidate) {
  const normalized = source.replace(/^\.\//u, '').replace(/\/$/u, '');
  if (!normalized || normalized === '.') return true;
  return candidate === normalized || candidate.startsWith(`${normalized}/`);
}

async function literalModuleClosure(entrypoint) {
  const files = new Set();
  const packages = new Set();
  async function visit(relativeName) {
    const normalized = relativeName.split(path.sep).join('/');
    if (files.has(normalized)) return;
    files.add(normalized);
    const source = await fs.readFile(path.join(projectDirectory, normalized), 'utf8');
    for (const match of source.matchAll(/\bimport\s*\(([^)]*)\)/gu)) {
      assert.match(match[1].trim(), /^(['"])[^'"]+\1$/u,
        `${normalized} contains a computed dynamic import`);
    }
    const specifiers = [
      ...source.matchAll(/\bimport\s+(?:[^'";]+\s+from\s+)?['"]([^'"]+)['"]/gu),
      ...source.matchAll(/\bexport\s+[^'";]+\s+from\s+['"]([^'"]+)['"]/gu),
    ].map((match) => match[1]);
    for (const specifier of specifiers) {
      if (specifier.startsWith('node:')) continue;
      if (!specifier.startsWith('.')) {
        packages.add(specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/')
          : specifier.split('/')[0]);
        continue;
      }
      const child = path.normalize(path.join(path.dirname(normalized), specifier));
      const relative = child.split(path.sep).join('/');
      assert.doesNotMatch(relative, /^\.\.(?:\/|$)/u, `${normalized} import escapes the project`);
      await visit(relative);
    }
  }
  await visit(entrypoint);
  return { files: [...files].sort(), packages: [...packages].sort() };
}

test('the production Docker image is assembled from an explicit runtime allowlist', async () => {
  const [dockerfile, dockerignore] = await Promise.all([
    fs.readFile(path.join(projectDirectory, 'Dockerfile'), 'utf8'),
    fs.readFile(path.join(projectDirectory, '.dockerignore'), 'utf8'),
  ]);
  const sources = finalContextCopySources(dockerfile);
  const expectedSources = [
    'package.json', 'package-lock.json', 'config.js', 'db.js', 'server.js',
    'adaptive-learning', 'ai', 'audio', 'ege-mock', 'middleware', 'migrations',
    'observability', 'public', 'reading', 'routes', 'security', 'services', 'shared',
    'speaking', 'storage', 'validation', 'voice-tutor', 'scripts/database-operation-lock.js',
    'scripts/host-operation-lock.js', 'scripts/import-json.js', 'scripts/migrate.js',
    'scripts/bounded-child-lifecycle.js', 'scripts/posix-session-supervisor.js',
    'scripts/production-import-local-child-authority.js',
    'scripts/release-command-supervisor.js',
  ].sort();

  assert.deepEqual([...sources].sort(), expectedSources,
    'the final stage may copy only server runtime roots/directories and documented runtime entrypoints');
  assert.doesNotMatch(dockerfile.slice(dockerfile.lastIndexOf('\nFROM ')), /COPY(?:\s+--[^\s]+)*\s+\.\s+\./u,
    'the runtime stage must never copy the whole workspace');
  assert.match(dockerfile, /COPY --from=frontend-build --chown=node:node \/app\/dist\/public \.\/dist\/public/u);

  const sentinels = [
    '.env.staging', '.env.production.local', '.scratch/private-release-notes.md',
    'public/prototypes/aisy-ui-v3/private-sentinel.js', 'scripts/qa-private-sentinel.mjs',
    'test/untracked-secret-sentinel.test.js', 'e2e/untracked-browser-sentinel.test.js',
    'docs/private-workspace-note.md', '.codex/workspace-state.json', '.claude/local-settings.json',
  ];
  for (const sentinel of sentinels) {
    const copiedByRuntimeSource = sources.some((source) => copySourceIncludes(source, sentinel));
    assert.equal(dockerContextIgnores(dockerignore, sentinel) || !copiedByRuntimeSource, true,
      `${sentinel} could enter the final runtime image`);
  }
  assert.equal(dockerContextIgnores(dockerignore, '.env.example'), false,
    'the name-only environment template is the only .env* file allowed into build context');
});

test('guarded production import examples keep their entrypoint in the final image closure', async () => {
  const [dockerfile, readme, packageSource] = await Promise.all([
    fs.readFile(path.join(projectDirectory, 'Dockerfile'), 'utf8'),
    fs.readFile(path.join(projectDirectory, 'README_DEPLOY.md'), 'utf8'),
    fs.readFile(path.join(projectDirectory, 'package.json'), 'utf8'),
  ]);
  const sources = finalContextCopySources(dockerfile);
  const packageJson = JSON.parse(packageSource);
  const importCommands = [...readme.matchAll(
    /^(sudo --preserve-env=EASYBOOST_PRODUCTION_APP_IMAGE_ID,EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID \\\r?\n[ \t]+\/usr\/bin\/node scripts\/import-json\.js (\S+) --production-compose (?:(--dry-run)|\\\r?\n[ \t]+--expected-source-sha256 ("\$EASYBOOST_IMPORT_SOURCE_SHA256")))$/gmu,
  )];
  assert.equal(importCommands.length, 2,
    'README must show guarded dry-run and real production imports');
  assert.deepEqual(importCommands.map((match) => Boolean(match[3])).sort(), [false, true],
    'README must show exactly one dry-run and one digest-bound live import');
  assert.equal(importCommands.find((match) => !match[3])?.[4],
    '"$EASYBOOST_IMPORT_SOURCE_SHA256"',
    'live import must pass the exact dry-run digest authority');
  for (const [, , hostPath] of importCommands) {
    assert.equal(path.posix.isAbsolute(hostPath), true,
      'each guarded import example must use an explicit absolute host path');
  }
  assert.doesNotMatch(readme,
    /^docker compose[^\r\n]*\bapp\s+(?:npm run\s+db:import-json|\/usr\/bin\/node scripts\/import-json\.js)\b/gmu,
    'production import documentation must not bypass the guarded root entrypoint');

  const importScript = packageJson.scripts['db:import-json'];
  assert.equal(typeof importScript, 'string', 'documented npm script db:import-json must exist');
  const importEntrypoint = /^node\s+([^\s]+)/u.exec(importScript)?.[1];
  assert.ok(importEntrypoint, 'db:import-json must name a Node entrypoint');
  assert.equal(sources.some((source) => copySourceIncludes(source, importEntrypoint)), true,
    `${importEntrypoint} for db:import-json must be copied into the final image`);

  const importClosure = await literalModuleClosure('scripts/import-json.js');
  assert.deepEqual(importClosure.files,
    [
      'config.js',
      'scripts/bounded-child-lifecycle.js',
      'scripts/database-operation-lock.js',
      'scripts/host-operation-lock.js',
      'scripts/import-json.js',
      'scripts/posix-session-supervisor.js',
      'scripts/production-import-local-child-authority.js',
      'scripts/release-command-supervisor.js',
    ]);
  assert.deepEqual(importClosure.packages, ['dotenv', 'pg']);
  for (const file of importClosure.files) {
    assert.equal(sources.some((source) => copySourceIncludes(source, file)), true,
      `${file} in the import-json local module closure must be copied into the final image`);
  }
  for (const dependency of importClosure.packages) {
    assert.equal(typeof packageJson.dependencies?.[dependency], 'string',
      `${dependency} in the import-json module closure must be a production dependency`);
  }
});

test('the Docker frontend stage receives the complete hermetic build input closure', async () => {
  const [dockerfile, dockerignore] = await Promise.all([
    fs.readFile(path.join(projectDirectory, 'Dockerfile'), 'utf8'),
    fs.readFile(path.join(projectDirectory, '.dockerignore'), 'utf8'),
  ]);
  const sources = frontendContextCopySources(dockerfile);
  const expectedSources = [
    'package.json', 'package-lock.json', 'vite.config.js',
    'scripts/build-frontend.js', 'scripts/pwa-release-version.js',
    'scripts/pwa-predecessor-compat.js', 'scripts/verify-release-artifact.js',
    'scripts/posix-session-supervisor.js', 'scripts/release-command-supervisor.js',
    'scripts/posix-release-maintenance-launcher.sh',
    'scripts/posix-release-maintenance-scope.js',
    'scripts/staging-quiescent-maintenance.js',
    'pwa-compat', 'public', 'shared',
  ].sort();

  assert.deepEqual([...sources].sort(), expectedSources,
    'the frontend stage must receive every source root used by build-frontend.js and nothing broader');
  for (const source of sources) {
    assert.equal(dockerContextIgnores(dockerignore, source), false,
      `${source} is copied by the frontend stage but excluded from the Docker context`);
    assert.equal((await fs.stat(path.join(projectDirectory, source))).isFile()
      || (await fs.stat(path.join(projectDirectory, source))).isDirectory(), true,
    `${source} must exist in the hermetic Docker build context`);
  }
});

test('the pre-build context verifier rejects every unexpected reachable COPY input generically', async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'aisy-docker-context-'));
  try {
    const trackedFiles = [
      '.dockerignore', 'Dockerfile', 'scripts/aisy-release-candidate-files.json',
      'public/index.html', 'routes/users.js', 'shared/catalog.js', 'ai/provider.js',
    ];
    const files = {
      '.dockerignore': 'public/prototypes\n',
      Dockerfile: [
        'FROM scratch AS frontend-build',
        'COPY public ./public',
        'COPY shared ./shared',
        'FROM scratch',
        'COPY routes ./routes',
        'COPY ai ./ai',
        '',
      ].join('\n'),
      'scripts/aisy-release-candidate-files.json': `${JSON.stringify({
        schemaVersion: 'aisy-release-candidate-files-v1',
        files: ['scripts/aisy-release-candidate-files.json'],
      }, null, 2)}\n`,
      'public/index.html': '<main>Aisy</main>',
      'routes/users.js': 'export const users = true;',
      'shared/catalog.js': 'export const catalog = true;',
      'ai/provider.js': 'export const provider = true;',
      'public/private-release-secret.txt': 'unexpected public file',
      'routes/untracked-secret.js': 'unexpected route',
      'shared/local-private-note.js': 'unexpected shared file',
      'ai/provider-credential.json': '{}',
      'public/prototypes/ignored-private-sentinel.js': 'ignored by Docker context',
    };
    for (const [name, body] of Object.entries(files)) {
      await fs.mkdir(path.dirname(path.join(temporary, name)), { recursive: true });
      await fs.writeFile(path.join(temporary, name), body);
    }
    assert.throws(() => verifyDockerBuildContext({ projectDirectory: temporary, trackedFiles }),
      (error) => {
        for (const unexpected of [
          'public/private-release-secret.txt', 'routes/untracked-secret.js',
          'shared/local-private-note.js', 'ai/provider-credential.json',
        ]) assert.match(error.message, new RegExp(unexpected.replaceAll('.', '\\.'), 'u'));
        assert.doesNotMatch(error.message, /ignored-private-sentinel/u);
        return true;
      });

    for (const unexpected of [
      'public/private-release-secret.txt', 'routes/untracked-secret.js',
      'shared/local-private-note.js', 'ai/provider-credential.json',
    ]) await fs.rm(path.join(temporary, unexpected));
    await fs.writeFile(path.join(temporary, 'public', 'explicit-candidate.txt'), 'audited candidate');
    await fs.writeFile(path.join(temporary, 'scripts', 'aisy-release-candidate-files.json'),
      `${JSON.stringify({
        schemaVersion: 'aisy-release-candidate-files-v1',
        files: [
          'public/explicit-candidate.txt', 'scripts/aisy-release-candidate-files.json',
        ],
      }, null, 2)}\n`);
    const verified = verifyDockerBuildContext({ projectDirectory: temporary, trackedFiles });
    assert.ok(verified.reachable.includes('public/explicit-candidate.txt'));
    assert.equal(verified.unexpected.length, 0);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

test('Docker context grammar and audited paths fail closed on ambiguous future inputs', async () => {
  assert.deepEqual(parseDockerCopySources([
    'FROM scratch', 'COPY --chown=node:node public routes /app/',
    'COPY --from=frontend-build /app/dist /app/dist', '',
  ].join('\n')), ['public', 'routes']);
  for (const invalid of [
    'ADD public /app/public/',
    'RUN --mount=type=bind,source=public,target=/source test -f /source/index.html',
    'COPY ["public", "/app/public"]',
    'COPY public \\',
    'COPY public/*.js /app/public/',
    'COPY --chmod=755 public /app/public/',
    'COPY ../private /app/private/',
    'COPY $SOURCE /app/source/',
    'COPY /absolute /app/absolute/',
    'COPY . /app/',
  ]) assert.throws(() => parseDockerCopySources(`FROM scratch\n${invalid}\n`), /Unsupported|forbidden/iu);

  const ignoreRules = parseDockerignore([
    '.env*', '!.env.example', 'public/prototypes', '',
  ].join('\n'));
  assert.equal(contextIgnores(ignoreRules, '.env.staging'), true);
  assert.equal(contextIgnores(ignoreRules, '.env.example'), false);
  assert.equal(contextIgnores(ignoreRules, 'public/prototypes/private/file.js'), true);
  assert.equal(contextIgnores(ignoreRules, 'public/index.html'), false);

  assert.throws(() => validateAuditedPathSet(['public/A.js', 'public/a.js']), /collision/iu);
  assert.throws(() => validateAuditedPathSet([
    'public/caf\u00e9.js', 'public/cafe\u0301.js',
  ]), /collision/iu);
  assert.throws(() => validateAuditedPathSet(['public/control\u0001.js']), /control/iu);

  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'aisy-docker-link-project-'));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'aisy-docker-link-outside-'));
  try {
    await fs.mkdir(path.join(project, 'public'), { recursive: true });
    await fs.mkdir(path.join(project, 'scripts'), { recursive: true });
    await fs.writeFile(path.join(project, 'Dockerfile'), 'FROM scratch\nCOPY public ./public\n');
    await fs.writeFile(path.join(project, '.dockerignore'), '');
    await fs.writeFile(path.join(project, 'scripts', 'aisy-release-candidate-files.json'),
      `${JSON.stringify({
        schemaVersion: 'aisy-release-candidate-files-v1',
        files: ['scripts/aisy-release-candidate-files.json'],
      }, null, 2)}\n`);
    await fs.symlink(outside, path.join(project, 'public', 'outside-link'), 'junction');
    assert.throws(() => verifyDockerBuildContext({
      projectDirectory: project,
      trackedFiles: [
        '.dockerignore', 'Dockerfile', 'public/outside-link',
        'scripts/aisy-release-candidate-files.json',
      ],
    }), /symlink escapes/iu);
  } finally {
    await fs.rm(project, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test('the actual release workspace has no unexpected reachable Docker COPY inputs', () => {
  const verified = verifyDockerBuildContext({ projectDirectory });
  assert.equal(verified.unexpected.length, 0);
  assert.ok(verified.reachable.length > 0);
  assert.ok(verified.copySources.includes('public'));
  assert.ok(verified.copySources.includes('routes'));
  assert.ok(verified.copySources.includes('shared'));
  assert.ok(verified.copySources.includes('ai'));
});

test('the checked-in exact predecessor executable artifact is digest-complete and Docker-buildable', async () => {
  assert.equal(PREDECESSOR_COMMIT, 'd36724181ee04230c1a9709a9213bcd269092282');
  const verified = await verifyPredecessorCompatibility({
    directory: compatibilityArtifactDirectory(projectDirectory, PREDECESSOR_COMMIT),
    expectedCommit: PREDECESSOR_COMMIT,
  });
  assert.match(verified.cacheName, /^easyboost-static-/u);
  assert.ok(verified.files.length >= 20, 'the complete predecessor executable graph must be retained');
  assert.equal(verified.files.every((entry) => /^\/assets\/[^/]+\.(?:css|js)$/u.test(entry.path)), true);
  assert.equal(verified.files.some((entry) => entry.path.includes('writing-')), true);
  assert.equal(new Set(verified.files.map((entry) => entry.path)).size, verified.files.length);

  const [dockerfile, buildSource] = await Promise.all([
    fs.readFile(path.join(projectDirectory, 'Dockerfile'), 'utf8'),
    fs.readFile(path.join(projectDirectory, 'scripts', 'build-frontend.js'), 'utf8'),
  ]);
  assert.match(dockerfile, /COPY pwa-compat \.\/pwa-compat/u,
    'the Docker frontend stage must receive the checked-in predecessor artifact');
  assert.match(buildSource, /verifyPredecessorCompatibility/u);
  assert.match(buildSource, /predecessorCompatibility/u);
});

test('all packaged predecessor executables are byte-identical to a hermetic d367 build', async () => {
  const compared = await verifyPredecessorArtifactAgainstFixture({
    fixtureDirectory: exactPredecessorFixture.distDirectory,
    artifactDirectory: compatibilityArtifactDirectory(projectDirectory, PREDECESSOR_COMMIT),
    expectedCommit: PREDECESSOR_COMMIT,
  });
  assert.equal(compared.filesCompared, 26);
  assert.equal(compared.rawBytesCompared, 26);
  assert.equal(compared.cacheName, 'easyboost-static-uizoyf');
  assert.equal(compared.contentSha256,
    '299ee5c9cbeb03279dfdc072a8b6f34b5ba3f0a06b28a111a4df61e06258a6ca');
});

test('predecessor compatibility verification fails closed on byte drift', async () => {
  const source = compatibilityArtifactDirectory(projectDirectory, PREDECESSOR_COMMIT);
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'aisy-pwa-compat-tamper-'));
  try {
    await fs.cp(source, temporary, { recursive: true });
    const manifest = JSON.parse(await fs.readFile(path.join(temporary, 'manifest.json'), 'utf8'));
    const target = path.join(temporary, 'files', manifest.files[0].path.slice(1));
    await fs.appendFile(target, '\nbyte drift');
    await assert.rejects(
      verifyPredecessorArtifactAgainstFixture({
        fixtureDirectory: exactPredecessorFixture.distDirectory,
        artifactDirectory: temporary,
        expectedCommit: PREDECESSOR_COMMIT,
      }),
      /digest|bytes|sha256/iu,
    );
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});
