import assert from 'node:assert/strict';
import test from 'node:test';

import { createBrowserRealtimeTransport } from '../public/realtime-transport.js';

const SERVER_SESSION = Object.freeze({
  voice: 'ara',
  instructions: 'Follow the server-owned Voice Tutor state machine.',
  tools: [{
    type: 'function',
    name: 'advance_pedagogy',
    description: 'Advance one bounded pedagogy step.',
    parameters: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['diagnosis_complete', 'explanation_complete', 'check_answer', 'transfer_answer'] },
        answer: { type: 'string', maxLength: 200 },
      },
      required: ['type'],
      additionalProperties: false,
    },
  }],
  turn_detection: { type: 'server_vad' },
});

test('browser realtime transport streams bounded tool events through the injected fake socket', async () => {
  let socket;
  class FakeSocket {
    constructor(url, protocols) {
      this.url = url;
      this.protocols = protocols;
      this.readyState = 0;
      this.sent = [];
      socket = this;
      queueMicrotask(() => { this.readyState = 1; this.onopen?.(); });
    }
    send(value) { this.sent.push(JSON.parse(value)); }
    close() { this.readyState = 3; this.onclose?.(); }
    emit(value) { this.onmessage?.({ data: JSON.stringify(value) }); }
  }
  const processor = { connect() {}, disconnect() {}, onaudioprocess: null };
  const audioContext = {
    destination: {},
    createMediaStreamSource: () => ({ connect() {}, disconnect() {} }),
    createScriptProcessor: () => processor,
    createGain: () => ({ gain: { value: 0 }, connect() {}, disconnect() {} }),
    close: async () => {},
  };
  const captions = [];
  const events = [];
  let audioContextCreations = 0;
  const transport = createBrowserRealtimeTransport({
    webSocketFactory: (url, protocols) => new FakeSocket(url, protocols),
    audioContextFactory: () => { audioContextCreations += 1; return audioContext; },
  });

  let connected = false;
  const pending = transport.connect({
    stream: {},
    credential: 'ephemeral-only',
    url: 'wss://fake.invalid/realtime',
    session: SERVER_SESSION,
    onSubtitle: (value) => captions.push(value),
    onPedagogicalEvent: async (event) => {
      events.push(event);
      return { session: { state: 'explain' }, nonce: 'rotated-nonce-0002' };
    },
  });
  pending.then(() => { connected = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(connected, false);
  socket.emit({ type: 'session.updated' });
  const connection = await pending;
  assert.equal(audioContextCreations, 0);
  connection.activate();
  assert.equal(audioContextCreations, 1);
  socket.emit({ type: 'response.audio_transcript.delta', delta: 'Разберём правило.' });
  socket.emit({ type: 'response.created', response_id: 'response-1' });
  socket.emit({
    type: 'response.function_call_arguments.done',
    name: 'advance_pedagogy',
    call_id: 'call-1',
    arguments: JSON.stringify({ type: 'diagnosis_complete' }),
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(events, [{ type: 'diagnosis_complete' }]);
  assert.deepEqual(captions, ['Разберём правило.']);
  assert.deepEqual(socket.protocols, ['xai-client-secret.ephemeral-only']);
  assert.deepEqual(socket.sent[0], { type: 'session.update', session: SERVER_SESSION });
  assert.ok(socket.sent.some((entry) => entry.type === 'conversation.item.create' && entry.item.call_id === 'call-1'));
  assert.ok(socket.sent.some((entry) => entry.type === 'response.create'));
  connection.close();
  assert.equal(socket.readyState, 3);
});

test('browser realtime transport rejects oversized or off-scope tool calls', async () => {
  let socket;
  const transport = createBrowserRealtimeTransport({
    webSocketFactory: () => {
      socket = {
        readyState: 0, sent: [],
        send(value) { this.sent.push(JSON.parse(value)); },
        close() {},
      };
      queueMicrotask(() => { socket.readyState = 1; socket.onopen?.(); });
      return socket;
    },
    audioContextFactory: () => ({
      destination: {}, createMediaStreamSource: () => ({ connect() {}, disconnect() {} }),
      createScriptProcessor: () => ({ connect() {}, disconnect() {}, onaudioprocess: null }),
      createGain: () => ({ gain: { value: 0 }, connect() {}, disconnect() {} }), close: async () => {},
    }),
  });
  let calls = 0;
  const pending = transport.connect({
    stream: {}, credential: 'ephemeral-only', url: 'wss://fake.invalid/realtime',
    session: SERVER_SESSION,
    onPedagogicalEvent: async () => { calls += 1; },
  });
  socket.onmessage({ data: JSON.stringify({ type: 'session.updated' }) });
  const connection = await pending;
  connection.activate();
  socket.onmessage({ data: JSON.stringify({
    type: 'response.function_call_arguments.done', name: 'browse_web', call_id: 'bad', arguments: '{}',
  }) });
  socket.onmessage({ data: JSON.stringify({
    type: 'response.function_call_arguments.done', name: 'advance_pedagogy', call_id: 'large', arguments: 'x'.repeat(1_000),
  }) });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 0);
});

test('browser realtime transport rejects browser-authored or off-scope session configuration', async () => {
  const transport = createBrowserRealtimeTransport({
    webSocketFactory: () => { throw new Error('socket must not open'); },
  });
  await assert.rejects(
    transport.connect({
      stream: {}, credential: 'ephemeral-only', url: 'wss://fake.invalid/realtime',
      session: { ...SERVER_SESSION, tools: [{ type: 'function', name: 'browse_web', parameters: {} }] },
    }),
    /VOICE_TUTOR_REALTIME_INVALID/u,
  );
});

test('browser realtime transport requires session acknowledgement and reports runtime failure once', async () => {
  let socket;
  let ackTimeout;
  let clearedTimeout = false;
  const failures = [];
  const transport = createBrowserRealtimeTransport({
    ackTimeoutMs: 10_000,
    setTimeoutImpl(callback) { ackTimeout = callback; return 17; },
    clearTimeoutImpl(id) { if (id === 17) clearedTimeout = true; },
    webSocketFactory: () => {
      socket = {
        readyState: 0,
        sent: [],
        send(value) { this.sent.push(JSON.parse(value)); },
        close() { this.readyState = 3; },
      };
      queueMicrotask(() => { socket.readyState = 1; socket.onopen?.(); });
      return socket;
    },
    audioContextFactory: () => ({
      destination: {}, createMediaStreamSource: () => ({ connect() {}, disconnect() {} }),
      createScriptProcessor: () => ({ connect() {}, disconnect() {}, onaudioprocess: null }),
      createGain: () => ({ gain: { value: 0 }, connect() {}, disconnect() {} }), close: async () => {},
    }),
  });

  const pending = transport.connect({
    stream: {}, credential: 'ephemeral-only', url: 'wss://fake.invalid/realtime',
    session: SERVER_SESSION,
    onFailure: (code) => failures.push(code),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(typeof ackTimeout, 'function');
  socket.onmessage({ data: JSON.stringify({ type: 'session.updated' }) });
  const connection = await pending;
  connection.activate();
  assert.equal(clearedTimeout, true);

  socket.onmessage({ data: JSON.stringify({ type: 'error' }) });
  socket.onclose?.();
  socket.onerror?.();
  assert.deepEqual(failures, ['VOICE_TUTOR_PROVIDER_UNAVAILABLE']);
  connection.close();
});

test('browser realtime transport rejects when session acknowledgement times out', async () => {
  let ackTimeout;
  let socket;
  const transport = createBrowserRealtimeTransport({
    setTimeoutImpl(callback) { ackTimeout = callback; return 23; },
    clearTimeoutImpl() {},
    webSocketFactory: () => {
      socket = {
        readyState: 0,
        send() {},
        close() { this.readyState = 3; },
      };
      queueMicrotask(() => { socket.readyState = 1; socket.onopen?.(); });
      return socket;
    },
    audioContextFactory: () => ({ close: async () => {} }),
  });
  const pending = transport.connect({
    stream: {}, credential: 'ephemeral-only', url: 'wss://fake.invalid/realtime', session: SERVER_SESSION,
  });
  await new Promise((resolve) => setImmediate(resolve));
  ackTimeout();
  await assert.rejects(pending, /VOICE_TUTOR_REALTIME_UNAVAILABLE/u);
  assert.equal(socket.readyState, 3);
});
