import assert from 'node:assert/strict';
import test from 'node:test';

import { createBrowserRealtimeTransport } from '../public/realtime-transport.js';

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
  const transport = createBrowserRealtimeTransport({
    webSocketFactory: (url, protocols) => new FakeSocket(url, protocols),
    audioContextFactory: () => audioContext,
  });

  const connection = await transport.connect({
    stream: {},
    credential: 'ephemeral-only',
    url: 'wss://fake.invalid/realtime',
    onSubtitle: (value) => captions.push(value),
    onPedagogicalEvent: async (event) => {
      events.push(event);
      return { session: { state: 'explain' }, nonce: 'rotated-nonce-0002' };
    },
  });
  socket.emit({ type: 'response.audio_transcript.delta', delta: 'Разберём правило.' });
  socket.emit({
    type: 'response.function_call_arguments.done',
    name: 'advance_pedagogy',
    call_id: 'call-1',
    arguments: JSON.stringify({ type: 'diagnosis_complete' }),
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(events, [{ type: 'diagnosis_complete' }]);
  assert.deepEqual(captions, ['Разберём правило.']);
  assert.ok(socket.protocols.includes('openai-insecure-api-key.ephemeral-only'));
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
  await transport.connect({
    stream: {}, credential: 'ephemeral-only', url: 'wss://fake.invalid/realtime',
    onPedagogicalEvent: async () => { calls += 1; },
  });
  socket.onmessage({ data: JSON.stringify({
    type: 'response.function_call_arguments.done', name: 'browse_web', call_id: 'bad', arguments: '{}',
  }) });
  socket.onmessage({ data: JSON.stringify({
    type: 'response.function_call_arguments.done', name: 'advance_pedagogy', call_id: 'large', arguments: 'x'.repeat(1_000),
  }) });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 0);
});
