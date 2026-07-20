import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import jwt from 'jsonwebtoken';

const projectDirectory = fileURLToPath(new URL('..', import.meta.url));
const serverPath = fileURLToPath(new URL('../server.js', import.meta.url));

async function findAvailablePort() {
  const listener = net.createServer();
  await new Promise((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', resolve);
  });
  const { port } = listener.address();
  await new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function waitForReady(baseUrl, child, output) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Server exited early (${child.exitCode}).\n${output.join('')}`);
    try {
      const response = await fetch(`${baseUrl}/health/ready`);
      if (response.ok) return response;
    } catch {
      // The socket is expected to reject connections while the process starts.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Server did not become ready.\n${output.join('')}`);
}

async function stopProcess(child) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 3_000)),
  ]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

test('application starts and serves health, security headers and PWA assets', { timeout: 20_000 }, async () => {
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-smoke-'));
  const port = await findAvailablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const dataFile = path.join(temporaryDirectory, 'data.json');
  const jwtSecret = 'smoke-test-secret-with-at-least-32-characters';
  const sessionId = '750f111c-1f2f-48c7-9956-b2c284722a2b';
  await fs.writeFile(dataFile, JSON.stringify({
    users: {
      expired: { created: Date.now(), sub_until: Date.now() - 60_000 },
      active: { created: Date.now(), sub_until: Date.now() + 60_000, privacy_consent: { text_processing: true, voice_processing: true, policy_version: '2026-07-20', updated_at: new Date().toISOString() } },
      sessionuser: { created: Date.now(), sub_until: Date.now() + 60_000 },
      admin: { created: Date.now(), sub_until: Date.now() + 60_000, role: 'admin' },
    },
    progress: { expired: {}, active: {}, sessionuser: {}, admin: {} },
    sessions: { [sessionId]: { username: 'sessionuser', expires_at: Date.now() + 60_000, created_at: Date.now(), revoked_at: null } },
  }), 'utf8');
  const output = [];
  const child = spawn(process.execPath, [serverPath], {
    cwd: projectDirectory,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(port),
      APP_URL: baseUrl,
      DATABASE_PROVIDER: 'file',
      DATA_FILE: dataFile,
      JWT_SECRET: jwtSecret,
      TELEGRAM_BOT_TOKEN: '',
      ADMIN_TELEGRAM_ID: '',
      XAI_API_KEY: '',
      GROQ_API_KEY: '',
      AI_REQUESTS_PER_HOUR: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => output.push(chunk.toString()));
  child.stderr.on('data', (chunk) => output.push(chunk.toString()));

  try {
    const ready = await waitForReady(baseUrl, child, output);
    assert.deepEqual(await ready.json(), { status: 'ready', storage: 'file' });

    const live = await fetch(`${baseUrl}/health/live`);
    assert.equal(live.status, 200);
    assert.deepEqual(await live.json(), { status: 'ok' });

    const home = await fetch(`${baseUrl}/`);
    assert.equal(home.status, 200);
    assert.match(home.headers.get('content-security-policy') || '', /default-src 'self'/u);
    assert.match(home.headers.get('cache-control') || '', /no-store/u);
    assert.match(await home.text(), /<title>Easy Boost<\/title>/u);

    const manifest = await fetch(`${baseUrl}/manifest.json`);
    assert.equal(manifest.status, 200);
    assert.equal((await manifest.json()).display, 'standalone');

    const serviceWorker = await fetch(`${baseUrl}/service-worker.js`);
    assert.equal(serviceWorker.status, 200);
    const serviceWorkerSource = await serviceWorker.text();
    assert.match(serviceWorkerSource, /CACHE_NAME/u);
    assert.match(serviceWorkerSource, /url\.pathname\.startsWith\('\/api\/'\)/u);

    const expiredAuthorization = { Authorization: `Bearer ${jwt.sign({ u: 'expired' }, jwtSecret)}` };
    const paidRequests = [
      fetch(`${baseUrl}/api/v1/ai/generate-content`, { method: 'POST', headers: { ...expiredAuthorization, 'Content-Type': 'application/json' }, body: JSON.stringify({ operation: 'grammar_quiz' }) }),
      fetch(`${baseUrl}/api/tts?text=hello`, { headers: expiredAuthorization }),
      fetch(`${baseUrl}/api/stt`, { method: 'POST', headers: { ...expiredAuthorization, 'Content-Type': 'audio/webm' }, body: new Uint8Array([1]) }),
    ];
    for (const response of await Promise.all(paidRequests)) {
      assert.equal(response.status, 403);
      assert.equal((await response.json()).error.code, 'SUBSCRIPTION_REQUIRED');
    }

    const activeAuthorization = { Authorization: `Bearer ${jwt.sign({ u: 'active' }, jwtSecret)}`, 'Content-Type': 'application/json' };
    const activeAi = await fetch(`${baseUrl}/api/v1/ai/generate-content`, {
      method: 'POST',
      headers: activeAuthorization,
      body: JSON.stringify({ operation: 'grammar_quiz' }),
    });
    assert.equal(activeAi.status, 503);
    assert.equal((await activeAi.json()).error.code, 'AI_NOT_CONFIGURED');

    const rateLimitedAi = await fetch(`${baseUrl}/api/v1/ai/generate-content`, {
      method: 'POST',
      headers: activeAuthorization,
      body: JSON.stringify({ operation: 'grammar_quiz' }),
    });
    assert.equal(rateLimitedAi.status, 429);
    assert.equal((await rateLimitedAi.json()).error.code, 'RATE_LIMITED');

    const consent = await fetch(`${baseUrl}/api/privacy/consent`, { headers: activeAuthorization });
    assert.equal(consent.status, 200);
    assert.equal((await consent.json()).text_processing, true);

    const revokedConsent = await fetch(`${baseUrl}/api/privacy/consent`, {
      method: 'PUT', headers: activeAuthorization, body: JSON.stringify({ text_processing: false, voice_processing: false }),
    });
    assert.equal(revokedConsent.status, 200);
    assert.equal((await revokedConsent.json()).text_processing, false);
    const blockedByConsent = await fetch(`${baseUrl}/api/v1/ai/generate-content`, {
      method: 'POST', headers: activeAuthorization, body: JSON.stringify({ operation: 'grammar_quiz' }),
    });
    assert.equal(blockedByConsent.status, 403);
    assert.equal((await blockedByConsent.json()).error.code, 'PRIVACY_CONSENT_REQUIRED');

    const exported = await fetch(`${baseUrl}/api/account/export`, { headers: activeAuthorization });
    assert.equal(exported.status, 200);
    assert.match(exported.headers.get('content-disposition') || '', /easyboost-data\.json/u);
    assert.equal((await exported.json()).account.username, 'active');

    const moduleAttempt = { id: '58ffc848-99ab-4a9d-99c4-f960558c1e51', module: 'exam', activity: 'grammar_19_24', score: 5, maxScore: 6, durationMs: 45_000 };
    const recordedAttempt = await fetch(`${baseUrl}/api/module-attempts`, { method: 'POST', headers: activeAuthorization, body: JSON.stringify(moduleAttempt) });
    assert.equal(recordedAttempt.status, 201);
    assert.equal((await recordedAttempt.json()).created, true);
    const duplicateAttempt = await fetch(`${baseUrl}/api/module-attempts`, { method: 'POST', headers: activeAuthorization, body: JSON.stringify(moduleAttempt) });
    assert.equal(duplicateAttempt.status, 200);
    assert.equal((await duplicateAttempt.json()).created, false);

    const studentAdminRequest = await fetch(`${baseUrl}/api/admin/status`, { headers: activeAuthorization });
    assert.equal(studentAdminRequest.status, 403);
    assert.equal((await studentAdminRequest.json()).error.code, 'FORBIDDEN');
    const adminAuthorization = { Authorization: `Bearer ${jwt.sign({ u: 'admin' }, jwtSecret)}` };
    const adminRequest = await fetch(`${baseUrl}/api/admin/status`, { headers: adminAuthorization });
    assert.equal(adminRequest.status, 200);
    assert.equal((await adminRequest.json()).role, 'admin');

    const revocableToken = jwt.sign({ u: 'sessionuser', sid: sessionId }, jwtSecret, { expiresIn: '1h' });
    const sessionBeforeLogout = await fetch(`${baseUrl}/api/me`, { headers: { Authorization: `Bearer ${revocableToken}` } });
    assert.equal(sessionBeforeLogout.status, 200);
    const logout = await fetch(`${baseUrl}/api/logout`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${revocableToken}` },
    });
    assert.equal(logout.status, 200);
    assert.match(logout.headers.get('set-cookie') || '', /Max-Age=0/u);
    const sessionAfterLogout = await fetch(`${baseUrl}/api/me`, { headers: { Authorization: `Bearer ${revocableToken}` } });
    assert.equal(sessionAfterLogout.status, 401);
    assert.equal((await sessionAfterLogout.json()).error.code, 'SESSION_REVOKED');

    const unconfirmedDeletion = await fetch(`${baseUrl}/api/account`, {
      method: 'DELETE',
      headers: activeAuthorization,
      body: JSON.stringify({ confirmation: 'NO' }),
    });
    assert.equal(unconfirmedDeletion.status, 400);
    assert.equal((await unconfirmedDeletion.json()).error.code, 'CONFIRMATION_REQUIRED');

    const deletion = await fetch(`${baseUrl}/api/account`, {
      method: 'DELETE',
      headers: activeAuthorization,
      body: JSON.stringify({ confirmation: 'DELETE' }),
    });
    assert.equal(deletion.status, 200);
    assert.equal((await deletion.json()).ok, true);
    const deletedSession = await fetch(`${baseUrl}/api/me`, { headers: activeAuthorization });
    assert.equal(deletedSession.status, 401);
  } finally {
    await stopProcess(child);
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
});
