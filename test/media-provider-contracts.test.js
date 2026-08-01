import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

process.env.XAI_API_KEY = 'media-provider-contract-test-key';

const { createMediaRoutes } = await import('../routes/media.js');

const pass = (_request, _response, next) => next();

function requestMedia(port, pathname, { method = 'GET', contentType, body } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: '127.0.0.1',
      port,
      path: pathname,
      method,
      headers: contentType ? { 'Content-Type': contentType } : {},
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks),
      }));
    });
    request.on('error', reject);
    if (body) request.write(body);
    request.end();
  });
}

function requestStt(port, contentType = 'audio/webm') {
  return requestMedia(port, '/api/v1/stt', {
    method: 'POST',
    contentType,
    body: Buffer.from([1, 2, 3, 4]),
  });
}

async function withMediaServer(provider, run) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-media-contract-'));
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('Unexpected global provider fetch'); };
  const app = express();
  app.use(createMediaRoutes({
    authentication: { auth: pass },
    access: {
      ttsLimiter: pass,
      sttLimiter: pass,
      requireActiveSubscription: pass,
      requirePrivacyConsent: () => pass,
    },
    provider,
    ttsDirectory: directory,
  }));
  const server = http.createServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    return await run(server.address().port, directory);
  } finally {
    globalThis.fetch = previousFetch;
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test('STT returns a normalized transcript only after the provider contract passes', async () => {
  await withMediaServer({
    fetch: async () => new Response(JSON.stringify({ text: '  A clear answer.  ', duration: 42.5 }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  }, async (port) => {
    const response = await requestStt(port, 'audio/webm;codecs=opus');

    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(response.body), { text: 'A clear answer.', duration: 42.5 });
  });
});

test('STT rejects malformed provider JSON without returning partial success', async () => {
  await withMediaServer({
    fetch: async () => new Response('{"text":', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  }, async (port) => {
    const response = await requestStt(port);

    assert.equal(response.status, 502);
    assert.deepEqual(JSON.parse(response.body), {
      error: { code: 'STT_UNAVAILABLE', message: 'Не удалось распознать запись.' },
    });
  });
});

test('STT rejects unexpected provider response fields', async () => {
  await withMediaServer({
    fetch: async () => new Response(JSON.stringify({ text: 'answer', duration: 1, confidence: 0.99 }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  }, async (port) => {
    const response = await requestStt(port);

    assert.equal(response.status, 502);
    assert.equal(JSON.parse(response.body).error.code, 'STT_UNAVAILABLE');
  });
});

test('STT rejects empty, non-string and overlong provider transcripts', async () => {
  const payloads = [
    { text: '   \n ', duration: 1 },
    { text: 42, duration: 1 },
    { text: 'x'.repeat(10_001), duration: 1 },
  ];
  let index = 0;
  await withMediaServer({
    fetch: async () => new Response(JSON.stringify(payloads[index++]), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  }, async (port) => {
    for (const _payload of payloads) {
      const response = await requestStt(port);
      assert.equal(response.status, 502);
      assert.equal(JSON.parse(response.body).error.code, 'STT_UNAVAILABLE');
    }
  });
});

test('STT rejects duration with the wrong type, non-finite value or value outside 0–300 seconds', async () => {
  const bodies = [
    '{"text":"answer","duration":"1"}',
    '{"text":"answer","duration":1e400}',
    '{"text":"answer","duration":-0.1}',
    '{"text":"answer","duration":300.001}',
  ];
  let index = 0;
  await withMediaServer({
    fetch: async () => new Response(bodies[index++], {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  }, async (port) => {
    for (const _body of bodies) {
      const response = await requestStt(port);
      assert.equal(response.status, 502);
      assert.equal(JSON.parse(response.body).error.code, 'STT_UNAVAILABLE');
    }
  });
});

test('STT rejects a non-JSON or oversized provider response envelope', async () => {
  const responses = [
    () => new Response('{"text":"answer","duration":1}', {
      status: 200,
      headers: { 'Content-Type': 'text/plain' },
    }),
    () => new Response('{"text":"answer","duration":1}', {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Content-Length': String(64 * 1024 + 1) },
    }),
  ];
  let index = 0;
  await withMediaServer({
    fetch: async () => responses[index++](),
  }, async (port) => {
    for (const _response of responses) {
      const response = await requestStt(port);
      assert.equal(response.status, 502);
      assert.equal(JSON.parse(response.body).error.code, 'STT_UNAVAILABLE');
    }
  });
});

test('STT preserves the typed provider-unavailable error for a non-success HTTP status', async () => {
  await withMediaServer({
    fetch: async () => new Response('<html>unavailable</html>', {
      status: 503,
      headers: { 'Content-Type': 'text/html' },
    }),
  }, async (port) => {
    const response = await requestStt(port);

    assert.equal(response.status, 502);
    assert.deepEqual(JSON.parse(response.body), {
      error: { code: 'STT_PROVIDER_UNAVAILABLE', message: 'Распознавание речи временно недоступно.' },
    });
  });
});

test('TTS preserves the Edge fallback when the primary provider is unavailable', async () => {
  const fallbackAudio = Buffer.from([0xff, 0xfb, 0x90, 0x64]);
  await withMediaServer({
    fetch: async () => new Response('{"error":"unavailable"}', {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    }),
    edgeTts: async () => fallbackAudio,
  }, async (port) => {
    const response = await requestMedia(port, '/api/v1/tts?text=fallback-contract');

    assert.equal(response.status, 200);
    assert.equal(response.headers['content-type'], 'audio/mpeg');
    assert.deepEqual(response.body, fallbackAudio);
  });
});

test('TTS rejects a non-MP3 Content-Type and never caches that primary response as audio', async () => {
  const fallbackAudio = Buffer.from([0xff, 0xfb, 0x90, 0x64]);
  let primaryCalls = 0;
  await withMediaServer({
    fetch: async () => {
      primaryCalls += 1;
      return new Response('<html>provider error</html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    },
    edgeTts: async () => fallbackAudio,
  }, async (port) => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await requestMedia(port, '/api/v1/tts?text=content-type-contract');
      assert.equal(response.status, 200);
      assert.deepEqual(response.body, fallbackAudio);
    }
    assert.equal(primaryCalls, 2, 'an invalid primary response must not create a primary cache hit');
  });
});

test('TTS rejects a primary audio response larger than the 5 MiB per-response limit', async () => {
  const fallbackAudio = Buffer.from([0xff, 0xfb, 0x90, 0x64]);
  const responses = [
    () => new Response(Buffer.from([1, 2, 3, 4]), {
      status: 200,
      headers: { 'Content-Type': 'audio/mpeg', 'Content-Length': String(5 * 1024 * 1024 + 1) },
    }),
    () => new Response(Buffer.alloc(5 * 1024 * 1024 + 1, 1), {
      status: 200,
      headers: { 'Content-Type': 'audio/mpeg' },
    }),
  ];
  let index = 0;
  await withMediaServer({
    fetch: async () => responses[index++](),
    edgeTts: async () => fallbackAudio,
  }, async (port) => {
    for (let attempt = 0; attempt < responses.length; attempt += 1) {
      const response = await requestMedia(port, `/api/v1/tts?text=size-contract-${attempt}`);
      assert.equal(response.status, 200);
      assert.deepEqual(response.body, fallbackAudio);
    }
  });
});

test('TTS rejects an empty fallback response instead of caching it as audio', async () => {
  await withMediaServer({
    fetch: async () => new Response(null, { status: 503 }),
    edgeTts: async () => Buffer.alloc(0),
  }, async (port, directory) => {
    const response = await requestMedia(port, '/api/v1/tts?text=empty-fallback-contract');

    assert.equal(response.status, 503);
    assert.equal(JSON.parse(response.body).error.code, 'TTS_UNAVAILABLE');
    assert.deepEqual(await fs.readdir(directory), []);
  });
});

test('TTS rejects an oversized fallback response instead of caching it as audio', async () => {
  await withMediaServer({
    fetch: async () => new Response(null, { status: 503 }),
    edgeTts: async () => Buffer.alloc(5 * 1024 * 1024 + 1, 1),
  }, async (port, directory) => {
    const response = await requestMedia(port, '/api/v1/tts?text=oversized-fallback-contract');

    assert.equal(response.status, 503);
    assert.equal(JSON.parse(response.body).error.code, 'TTS_UNAVAILABLE');
    assert.deepEqual(await fs.readdir(directory), []);
  });
});

test('TTS accepts and caches a bounded audio/mpeg primary response', async () => {
  const primaryAudio = Buffer.from([0xff, 0xfb, 0x90, 0x64]);
  let primaryCalls = 0;
  await withMediaServer({
    fetch: async () => {
      primaryCalls += 1;
      return new Response(primaryAudio, {
        status: 200,
        headers: { 'Content-Type': 'audio/mpeg', 'Content-Length': String(primaryAudio.length) },
      });
    },
    edgeTts: async () => { throw new Error('fallback must not run'); },
  }, async (port) => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await requestMedia(port, '/api/v1/tts?text=valid-primary-contract');
      assert.equal(response.status, 200);
      assert.equal(response.headers['content-type'], 'audio/mpeg');
      assert.deepEqual(response.body, primaryAudio);
    }
    assert.equal(primaryCalls, 1);
  });
});

test('TTS rejects an empty primary response and serves the existing fallback', async () => {
  const fallbackAudio = Buffer.from([0xff, 0xfb, 0x90, 0x64]);
  await withMediaServer({
    fetch: async () => new Response(null, {
      status: 200,
      headers: { 'Content-Type': 'audio/mpeg', 'Content-Length': '0' },
    }),
    edgeTts: async () => fallbackAudio,
  }, async (port) => {
    const response = await requestMedia(port, '/api/v1/tts?text=empty-primary-contract');

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, fallbackAudio);
  });
});
