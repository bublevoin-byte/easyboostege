import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createApiVersionRewrite, isApiPath, isVersionedApiPath, VERSIONED_API_PREFIX } from '../middleware/api-version.js';
import { contentRequestSchema } from '../ai/content.js';

/*
 * Section 13.1: the API is versioned as /api/v1/...
 *
 * Two things have to hold at once. Every route the server publishes must live
 * under the version, otherwise the version is decorative. And a client that was
 * built before the change must not silently break, because on a PWA the old
 * build can outlive the deploy inside a cached service worker shell.
 */

function run(middleware, { method = 'GET', url, requestId = 'req-1' } = {}) {
  const req = { method, url, requestId };
  let passed = false;
  middleware(req, {}, () => { passed = true; });
  return { url: req.url, passed };
}

function collectLogger() {
  const lines = [];
  return { log: (line) => lines.push(JSON.parse(line)), lines };
}

test('every published API route lives under the version prefix', async () => {
  const files = ['users', 'progress', 'media', 'ai'];
  const sources = await Promise.all(
    files.map((name) => fs.readFile(new URL(`../routes/${name}.js`, import.meta.url), 'utf8')),
  );

  const declared = [];
  for (const source of sources) {
    for (const match of source.matchAll(/router\.(get|post|put|delete)\('([^']+)'/gu)) {
      declared.push({ method: match[1].toUpperCase(), path: match[2] });
    }
  }

  assert.ok(declared.length >= 20, 'маршруты должны находиться разбором, иначе тест бессмысленен');

  for (const route of declared) {
    if (!isApiPath(route.path)) {
      /* Operational endpoints are deliberately outside the product API. */
      assert.match(
        route.path,
        /^\/(internal|health)\//u,
        `${route.method} ${route.path} не относится ни к API, ни к служебным путям`,
      );
      continue;
    }
    assert.ok(
      isVersionedApiPath(route.path),
      `${route.method} ${route.path} опубликован вне ${VERSIONED_API_PREFIX} — раздел 13.1 требует версию`,
    );
  }
});

test('the client calls the versioned contract and nothing else', async () => {
  const clientFiles = ['api.js', 'auth.js', 'app.js', 'sync.js', 'tts.js', 'privacy.js'];
  const sources = await Promise.all(
    clientFiles.map(async (name) => [name, await fs.readFile(new URL(`../public/${name}`, import.meta.url), 'utf8')]),
  );

  for (const [name, source] of sources) {
    for (const match of source.matchAll(/['"`](\/api\/[^'"`\s]*)['"`]/gu)) {
      const path = match[1];
      assert.ok(
        isVersionedApiPath(path),
        `public/${name} обращается к неверсионированному ${path}`,
      );
    }
  }
});

test('an unversioned call is rewritten so a cached shell survives the deploy', () => {
  const { log, lines } = collectLogger();
  const middleware = createApiVersionRewrite({ enabled: true, log });

  const result = run(middleware, { method: 'POST', url: '/api/progress/modules' });

  assert.equal(result.url, '/api/v1/progress/modules');
  assert.equal(result.passed, true);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].type, 'api_legacy_path');
  assert.equal(lines[0].level, 'warn');
  assert.equal(lines[0].from, '/api/progress/modules');
  assert.equal(lines[0].to, '/api/v1/progress/modules');
  assert.equal(lines[0].requestId, 'req-1');
});

test('the query string survives the rewrite', () => {
  const { log } = collectLogger();
  const middleware = createApiVersionRewrite({ enabled: true, log });

  const result = run(middleware, { url: '/api/tg/check?code=123456' });
  assert.equal(result.url, '/api/v1/tg/check?code=123456');

  const tts = run(middleware, { url: '/api/tts?text=hello%20there&voice=en-GB-SoniaNeural&slow=1' });
  assert.equal(tts.url, '/api/v1/tts?text=hello%20there&voice=en-GB-SoniaNeural&slow=1');
});

test('an already versioned call is left exactly as it is', () => {
  const { log, lines } = collectLogger();
  const middleware = createApiVersionRewrite({ enabled: true, log });

  const result = run(middleware, { method: 'POST', url: '/api/v1/ai/evaluate-writing' });

  assert.equal(result.url, '/api/v1/ai/evaluate-writing', 'путь не должен получить второй префикс версии');
  assert.equal(lines.length, 0, 'нормальный вызов не обязан засорять лог');
});

test('paths outside the API are untouched', () => {
  const { log } = collectLogger();
  const middleware = createApiVersionRewrite({ enabled: true, log });

  for (const url of ['/', '/app.js', '/health/ready', '/internal/metrics', '/privacy.html']) {
    assert.equal(run(middleware, { url }).url, url);
  }
});

test('the legacy path is reported once per route, not once per request', () => {
  const { log, lines } = collectLogger();
  const middleware = createApiVersionRewrite({ enabled: true, log });

  run(middleware, { method: 'GET', url: '/api/me' });
  run(middleware, { method: 'GET', url: '/api/me' });
  run(middleware, { method: 'GET', url: '/api/me' });
  run(middleware, { method: 'POST', url: '/api/me' });

  assert.equal(lines.length, 2, 'застрявший клиент не должен затопить лог');
  assert.deepEqual(lines.map((line) => line.method), ['GET', 'POST']);
});

test('with the compatibility layer off a legacy path is simply gone', () => {
  const { log, lines } = collectLogger();
  const middleware = createApiVersionRewrite({ enabled: false, log });

  const result = run(middleware, { url: '/api/me' });

  assert.equal(result.url, '/api/me', 'без переписывания путь остаётся прежним и не найдёт маршрута');
  assert.equal(result.passed, true, 'ответ 404 выдаёт обработчик, а не middleware');
  assert.equal(lines.length, 0);
});

test('the compatibility layer can be switched off from the environment', async () => {
  const source = await fs.readFile(new URL('../config.js', import.meta.url), 'utf8');
  assert.match(source, /API_ACCEPT_LEGACY_PATHS/u, 'выключатель должен быть настраиваемым, иначе слой останется навсегда');

  const example = await fs.readFile(new URL('../.env.example', import.meta.url), 'utf8');
  assert.match(example, /API_ACCEPT_LEGACY_PATHS/u, 'переменная обязана быть в .env.example');
});

/* ---------- the running server ---------- */

async function findAvailablePort() {
  const listener = net.createServer();
  await new Promise((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', resolve);
  });
  const { port } = listener.address();
  await new Promise((resolve, reject) => listener.close((error) => (error ? reject(error) : resolve())));
  return port;
}

async function startServer(environment = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-version-'));
  const port = await findAvailablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const output = [];

  const child = spawn(process.execPath, [fileURLToPath(new URL('../server.js', import.meta.url))], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(port),
      APP_URL: baseUrl,
      JWT_SECRET: 'api-version-test-secret-with-at-least-32-chars',
      DATABASE_PROVIDER: 'file',
      DATA_FILE: path.join(directory, 'data.json'),
      ...environment,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => output.push(String(chunk)));
  child.stderr.on('data', (chunk) => output.push(String(chunk)));

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Сервер завершился раньше времени:\n${output.join('')}`);
    try {
      const response = await fetch(`${baseUrl}/health/ready`);
      if (response.ok) break;
    } catch { /* the socket rejects connections while the process starts */ }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  return {
    baseUrl,
    output,
    async stop() {
      child.kill('SIGTERM');
      await Promise.race([
        new Promise((resolve) => child.once('exit', resolve)),
        new Promise((resolve) => setTimeout(resolve, 3_000)),
      ]);
      if (child.exitCode === null) child.kill('SIGKILL');
    },
  };
}

test('the running server answers the versioned path and rewrites the legacy one', { timeout: 30_000 }, async () => {
  const server = await startServer();
  try {
    /* Without a session both answer 401 — the point is that neither answers 404,
       which is what a missing route would give. */
    const versioned = await fetch(`${server.baseUrl}/api/v1/me`);
    const legacy = await fetch(`${server.baseUrl}/api/me`);

    assert.equal(versioned.status, 401, 'версионированный путь обязан существовать');
    assert.equal(legacy.status, 401, 'старый путь должен переписываться, а не пропадать');

    const unknown = await fetch(`${server.baseUrl}/api/v1/nothing-here`);
    assert.equal(unknown.status, 404, 'несуществующий путь по-прежнему 404 — тест не пропускает всё подряд');
    /* Section 13.2: an unknown endpoint answers in the single error format,
       not with the HTML shell of the application. */
    assert.match(unknown.headers.get('content-type') || '', /application\/json/u);
    const body = await unknown.json();
    assert.equal(body.error.code, 'UNKNOWN_ENDPOINT');
    assert.ok(body.error.requestId, 'ошибка должна нести request id');

    await new Promise((resolve) => setTimeout(resolve, 100));
    const log = server.output.join('');
    assert.match(log, /api_legacy_path/u, 'обращение по старому пути обязано попасть в лог');
    assert.match(log, /"from":"\/api\/me"/u);
    assert.match(log, /"to":"\/api\/v1\/me"/u);
  } finally {
    await server.stop();
  }
});

test('with the compatibility layer disabled the legacy path is a plain 404', { timeout: 30_000 }, async () => {
  const server = await startServer({ API_ACCEPT_LEGACY_PATHS: 'false' });
  try {
    const versioned = await fetch(`${server.baseUrl}/api/v1/me`);
    const legacy = await fetch(`${server.baseUrl}/api/me`);

    assert.equal(versioned.status, 401);
    assert.equal(legacy.status, 404, 'выключенный слой совместимости обязан действительно убирать старый путь');
    assert.doesNotMatch(server.output.join(''), /api_legacy_path/u);
  } finally {
    await server.stop();
  }
});

test('the OpenAPI vocabulary batch bounds match the runtime contract', async () => {
  const specification = await fs.readFile(new URL('../docs/openapi.yaml', import.meta.url), 'utf8');
  const start = specification.indexOf('  /api/v1/ai/generate-content:');
  const tail = start < 0 ? '' : specification.slice(start);
  const nextPath = tail.indexOf('\n  /api/v1/', 1);
  const operation = nextPath < 0 ? tail : tail.slice(0, nextPath);

  assert.match(operation, /required: \[operation, count\]/u);
  assert.match(operation || '', /count: \{ type: integer, minimum: 4, maximum: 8 \}/u);
  assert.equal(contentRequestSchema.safeParse({ operation: 'vocabulary_cards' }).success, false);
  for (const count of [4, 8]) {
    assert.equal(contentRequestSchema.safeParse({ operation: 'vocabulary_cards', count }).success, true);
  }
  for (const count of [1, 3, 9, 30]) {
    assert.equal(contentRequestSchema.safeParse({ operation: 'vocabulary_cards', count }).success, false);
  }
});

test('the OpenAPI description documents the versioned paths', async () => {
  const specification = await fs.readFile(new URL('../docs/openapi.yaml', import.meta.url), 'utf8');

  for (const match of specification.matchAll(/^ {2}(\/api\/[^:\s]+):/gmu)) {
    assert.ok(
      isVersionedApiPath(match[1]),
      `OpenAPI описывает неверсионированный путь ${match[1]}`,
    );
  }
  assert.match(specification, /\/api\/v1\/me/u, 'спецификация должна остаться непустой');
});
