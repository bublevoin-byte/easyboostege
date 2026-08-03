import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import test from 'node:test';
import { WebSocket, WebSocketServer } from 'ws';
import {
  buildVoiceTutorProxySessionUpdate,
  createVoiceTutorRealtimeProxy,
  decodedPcm16Bytes,
} from '../voice-tutor/realtime-proxy.js';

const CAPSULE = Object.freeze({
  id: 'capsule-proxy-test',
  module: 'grammar',
  skill: { id: 'ege.grammar.past_simple', label: 'Past Simple' },
  learner_answer: 'goed',
  item: { id: 'past-simple-1', prompt: 'Choose the correct form.', reference: 'went' },
  rule: { id: 'past-simple', version: 1, explanation: 'Use the second form.' },
  checks: {
    micro_check: { id: 'micro-1', prompt: 'Choose: went or goed?', answer: 'went' },
    transfer_task: { id: 'transfer-1', prompt: 'Complete: She ___ home.', answer: 'went' },
  },
});

test('proxy owns a bounded pinned xAI session.update with fixed PCM16 audio and one pedagogy tool', () => {
  const event = buildVoiceTutorProxySessionUpdate({
    capsule: CAPSULE,
    model: 'grok-voice-think-fast-1.0',
    voice: 'ara',
  });

  assert.equal(event.type, 'session.update');
  assert.equal(event.session.model, 'grok-voice-think-fast-1.0');
  assert.equal(event.session.voice, 'ara');
  assert.deepEqual(event.session.audio, {
    input: { format: { type: 'audio/pcm', rate: 24_000 }, transport: 'json' },
    output: { format: { type: 'audio/pcm', rate: 24_000 }, transport: 'json' },
  });
  assert.deepEqual(event.session.turn_detection, { type: 'server_vad' });
  assert.deepEqual(event.session.tools.map((tool) => tool.name), ['advance_pedagogy']);
  assert.match(event.session.instructions, /diagnose → explain → micro_check → transfer_task/u);
  assert.equal(JSON.stringify(event).includes('XAI_API_KEY'), false);
});

test('proxy counts only canonical padded base64 PCM16 and rejects malformed or odd audio', () => {
  assert.equal(decodedPcm16Bytes(Buffer.alloc(4_800).toString('base64'), { maxBytes: 4_800 }), 4_800);
  for (const value of ['', 'AAAA=', 'AA=A', 'A'.repeat(6_401)]) {
    assert.equal(decodedPcm16Bytes(value, { maxBytes: 4_800 }), null);
  }
});

test('proxy permits one pedagogy call per response and requires a fresh learner turn before another', async (t) => {
  const providerServer = http.createServer();
  const providerWss = new WebSocketServer({ server: providerServer, maxPayload: 262_144 });
  const providerSockets = [];
  providerWss.on('connection', (socket) => {
    providerSockets.push(socket);
    socket.on('message', (data) => {
      if (JSON.parse(data.toString()).type === 'session.update') {
        socket.send(JSON.stringify({ type: 'session.updated' }));
      }
    });
  });
  await new Promise((resolve) => providerServer.listen(0, '127.0.0.1', resolve));

  const tickets = Array.from({ length: 3 }, () => crypto.randomBytes(32).toString('base64url'));
  const sessions = new Map(tickets.map((ticket, index) => [
    crypto.createHash('sha256').update(ticket).digest('hex'), `pedagogy-bound-${index + 1}`,
  ]));
  const finalized = [];
  const proxy = createVoiceTutorRealtimeProxy({
    authentication: { async authenticateRequest() { return { username: 'bounded-student' }; } },
    db: {
      async consumeVoiceTutorProxyTicket(_username, input) {
        return {
          capsule: CAPSULE,
          session: {
            id: sessions.get(input.ticketHash), reserved_seconds: 60,
            expires_at: new Date(Date.now() + 60_000).toISOString(),
          },
        };
      },
      async activateVoiceTutorProxySession() {},
      async finalizeVoiceTutorProxySession(_username, sessionId, usage) {
        finalized.push({ sessionId, ...usage });
      },
    },
    providerEndpoint: `ws://127.0.0.1:${providerServer.address().port}/v1/realtime`,
    apiKey: 'test-provider-key',
    model: 'grok-voice-think-fast-1.0',
    voice: 'ara',
    allowInsecureProvider: true,
    policy: () => ({ enabled: true, costKillSwitch: false }),
    authorize: async () => true,
    resolveCapsule: async (_username, capsule) => capsule,
  });
  const appServer = http.createServer();
  proxy.attach(appServer);
  await new Promise((resolve) => appServer.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await proxy.close();
    await new Promise((resolve) => appServer.close(resolve));
    await new Promise((resolve) => providerWss.close(resolve));
    await new Promise((resolve) => providerServer.close(resolve));
  });

  async function connect(index) {
    const browser = new WebSocket(
      `ws://127.0.0.1:${appServer.address().port}/api/v1/voice-tutor/realtime`,
      [`easyboost-voice-ticket.${tickets[index]}`],
    );
    await onceMessage(browser, (event) => event.type === 'easyboost.ready', `bounded ready ${index}`);
    return { browser, provider: providerSockets.at(-1) };
  }
  function sendCall(provider, responseId, suffix) {
    provider.send(JSON.stringify({
      type: 'response.output_item.added', response_id: responseId,
      item: { id: `tool-${suffix}`, type: 'function_call', name: 'advance_pedagogy', call_id: `call-${suffix}` },
    }));
  }

  const sameResponse = await connect(0);
  sameResponse.provider.send(JSON.stringify({ type: 'response.created', response_id: 'response-same' }));
  sendCall(sameResponse.provider, 'response-same', 'same-a');
  await onceMessage(sameResponse.browser, (event) => event.item?.call_id === 'call-same-a', 'first same-response call');
  sendCall(sameResponse.provider, 'response-same', 'same-b');
  assert.equal(await new Promise((resolve) => sameResponse.browser.once('close', (code) => resolve(code))), 1011);

  const automatic = await connect(1);
  automatic.provider.send(JSON.stringify({ type: 'response.created', response_id: 'response-auto-a' }));
  sendCall(automatic.provider, 'response-auto-a', 'auto-a');
  await onceMessage(automatic.browser, (event) => event.item?.call_id === 'call-auto-a', 'first automatic call');
  automatic.provider.send(JSON.stringify({ type: 'response.done', response_id: 'response-auto-a' }));
  automatic.provider.send(JSON.stringify({ type: 'response.created', response_id: 'response-auto-b' }));
  sendCall(automatic.provider, 'response-auto-b', 'auto-b');
  assert.equal(await new Promise((resolve) => automatic.browser.once('close', (code) => resolve(code))), 1011);

  const afterLearner = await connect(2);
  afterLearner.provider.send(JSON.stringify({ type: 'response.created', response_id: 'response-turn-a' }));
  sendCall(afterLearner.provider, 'response-turn-a', 'turn-a');
  await onceMessage(afterLearner.browser, (event) => event.item?.call_id === 'call-turn-a', 'first learner-turn call');
  afterLearner.provider.send(JSON.stringify({ type: 'response.done', response_id: 'response-turn-a' }));
  afterLearner.provider.send(JSON.stringify({ type: 'input_audio_buffer.speech_started' }));
  afterLearner.provider.send(JSON.stringify({ type: 'response.created', response_id: 'response-turn-b' }));
  const accepted = onceMessage(afterLearner.browser, (event) => event.item?.call_id === 'call-turn-b', 'second learner-turn call');
  sendCall(afterLearner.provider, 'response-turn-b', 'turn-b');
  await accepted;
  afterLearner.browser.send(JSON.stringify({ type: 'easyboost.close' }));
  await new Promise((resolve) => afterLearner.browser.once('close', resolve));

  assert.equal(finalized.find((entry) => entry.sessionId === 'pedagogy-bound-1')?.reason, 'provider_order_invalid');
  assert.equal(finalized.find((entry) => entry.sessionId === 'pedagogy-bound-2')?.reason, 'provider_order_invalid');
  assert.equal(finalized.find((entry) => entry.sessionId === 'pedagogy-bound-3')?.confirmed, true);
});

function onceMessage(socket, predicate = () => true, label = 'message') {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timeout`)), 3_000);
    const onMessage = (data) => {
      let value;
      try { value = JSON.parse(data.toString()); } catch { return; }
      if (!predicate(value)) return;
      clearTimeout(timer);
      socket.off('message', onMessage);
      resolve(value);
    };
    socket.on('message', onMessage);
  });
}

test('actual app WebSocket proxy authenticates once, owns provider config, forwards bounded audio/barge-in and finalizes bytes', async (t) => {
  const providerServer = http.createServer();
  const providerWss = new WebSocketServer({ server: providerServer, maxPayload: 262_144 });
  const providerEvidence = { headers: null, messages: [], sockets: [] };
  providerWss.on('connection', (socket, request) => {
    providerEvidence.sockets.push(socket);
    providerEvidence.headers = request.headers;
    socket.send(JSON.stringify({ type: 'session.created', provider_private: 'must-not-reach-browser' }));
    socket.send(JSON.stringify({ type: 'conversation.created' }));
    socket.on('message', (data) => {
      const event = JSON.parse(data.toString());
      providerEvidence.messages.push(event);
      if (event.type === 'session.update') socket.send(JSON.stringify({ type: 'session.updated' }));
      if (event.type === 'input_audio_buffer.append') {
        socket.send(JSON.stringify({ type: 'response.created', response_id: 'response-1' }));
        socket.send(JSON.stringify({
          type: 'response.output_item.added', response_id: 'response-1',
          item: { id: 'assistant-1', type: 'message', role: 'assistant' },
        }));
        socket.send(JSON.stringify({
          type: 'response.output_audio.delta', response_id: 'response-1',
          delta: Buffer.alloc(2_400).toString('base64'),
        }));
        socket.send(JSON.stringify({ type: 'input_audio_buffer.speech_started' }));
      }
      if (event.type === 'response.create') {
        socket.send(JSON.stringify({ type: 'response.created', response_id: 'response-tool-1' }));
        socket.send(JSON.stringify({
          type: 'response.output_item.added', response_id: 'response-tool-1',
          item: { id: 'tool-item-1', type: 'function_call', name: 'advance_pedagogy', call_id: 'call-tool-1' },
        }));
        socket.send(JSON.stringify({
          type: 'response.function_call_arguments.done', response_id: 'response-tool-1', item_id: 'tool-item-1',
          name: 'advance_pedagogy', call_id: 'call-tool-1', arguments: JSON.stringify({ type: 'diagnosis_complete' }),
        }));
        socket.send(JSON.stringify({
          type: 'response.done', response_id: 'response-tool-1',
          response: { usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
        }));
      }
    });
    socket.on('close', () => {});
  });
  await new Promise((resolve) => providerServer.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => providerWss.close(resolve));
    await new Promise((resolve) => providerServer.close(resolve));
  });

  const rawTicket = crypto.randomBytes(32).toString('base64url');
  const revocableTicket = crypto.randomBytes(32).toString('base64url');
  const floodTicket = crypto.randomBytes(32).toString('base64url');
  const earlyCloseTicket = crypto.randomBytes(32).toString('base64url');
  const unsolicitedTicket = crypto.randomBytes(32).toString('base64url');
  const failedSettlementTicket = crypto.randomBytes(32).toString('base64url');
  const hungSettlementTicket = crypto.randomBytes(32).toString('base64url');
  const expectedHash = crypto.createHash('sha256').update(rawTicket).digest('hex');
  const revocableHash = crypto.createHash('sha256').update(revocableTicket).digest('hex');
  const floodHash = crypto.createHash('sha256').update(floodTicket).digest('hex');
  const earlyCloseHash = crypto.createHash('sha256').update(earlyCloseTicket).digest('hex');
  const unsolicitedHash = crypto.createHash('sha256').update(unsolicitedTicket).digest('hex');
  const failedSettlementHash = crypto.createHash('sha256').update(failedSettlementTicket).digest('hex');
  const hungSettlementHash = crypto.createHash('sha256').update(hungSettlementTicket).digest('hex');
  const sessionByHash = new Map([
    [expectedHash, 'session-proxy-1'],
    [revocableHash, 'session-proxy-revoked'],
    [floodHash, 'session-proxy-flood'],
    [earlyCloseHash, 'session-proxy-early-close'],
    [unsolicitedHash, 'session-proxy-unsolicited'],
    [failedSettlementHash, 'session-proxy-failed-settlement'],
    [hungSettlementHash, 'session-proxy-hung-settlement'],
  ]);
  const consumed = new Set();
  let authorized = true;
  let delayCapsule = false;
  let enterDelayedCapsule;
  let releaseDelayedCapsule;
  const finalized = [];
  const finalizationAttempts = new Map();
  let hungFinalizationConcurrent = 0;
  let maxHungFinalizationConcurrent = 0;
  const operationalErrors = [];
  const db = {
    async consumeVoiceTutorProxyTicket(username, input) {
      assert.equal(username, 'student');
      assert.equal(sessionByHash.has(input.ticketHash), true);
      if (consumed.has(input.ticketHash)) throw Object.assign(new Error('replayed'), { code: 'VOICE_TUTOR_PROXY_TICKET_REPLAYED' });
      consumed.add(input.ticketHash);
      return {
        capsule: CAPSULE,
        session: {
          id: sessionByHash.get(input.ticketHash),
          reserved_seconds: 60,
          expires_at: new Date(Date.now() + 10_000).toISOString(),
        },
      };
    },
    async activateVoiceTutorProxySession(username, sessionId) {
      assert.equal(username, 'student');
      assert.equal([...sessionByHash.values()].includes(sessionId), true);
    },
    async finalizeVoiceTutorProxySession(username, sessionId, usage) {
      const attempts = Number(finalizationAttempts.get(sessionId) || 0) + 1;
      finalizationAttempts.set(sessionId, attempts);
      if (sessionId === 'session-proxy-1' && attempts < 3) throw new Error('transient database failure');
      if (sessionId === 'session-proxy-failed-settlement') throw new Error('persistent database failure');
      if (sessionId === 'session-proxy-hung-settlement') {
        hungFinalizationConcurrent += 1;
        maxHungFinalizationConcurrent = Math.max(maxHungFinalizationConcurrent, hungFinalizationConcurrent);
        try {
          await new Promise((_, reject) => setTimeout(
            () => reject(new Error('repository finalization timeout')),
            Number(usage.attemptTimeoutMs) || 200,
          ));
        } finally {
          hungFinalizationConcurrent -= 1;
        }
      }
      finalized.push({ username, sessionId, ...usage });
    },
  };
  const appServer = http.createServer((_req, res) => res.end('ok'));
  const proxy = createVoiceTutorRealtimeProxy({
    authentication: { async authenticateRequest(req) { return req.headers.cookie === 'eb_token=valid' ? { username: 'student' } : null; } },
    db,
    providerEndpoint: `ws://127.0.0.1:${providerServer.address().port}/v1/realtime`,
    apiKey: 'provider-main-key-test-only',
    model: 'grok-voice-think-fast-1.0',
    voice: 'ara',
    policy: () => ({ enabled: true, costKillSwitch: false, requireZdr: true, zdrAttested: true }),
    authorize: async () => authorized,
    resolveCapsule: async (_username, capsule) => {
      if (delayCapsule) {
        enterDelayedCapsule?.();
        await new Promise((resolve) => { releaseDelayedCapsule = resolve; });
      }
      return capsule;
    },
    finalizationRetryDelaysMs: [0, 0],
    finalizationAttemptTimeoutMs: 20,
    onOperationalError: (event) => operationalErrors.push(event),
    allowInsecureProvider: true,
  });
  proxy.attach(appServer);
  await new Promise((resolve) => appServer.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await proxy.close();
    await new Promise((resolve) => appServer.close(resolve));
  });

  const crossOrigin = new WebSocket(
    `ws://127.0.0.1:${appServer.address().port}/api/v1/voice-tutor/realtime`,
    [`easyboost-voice-ticket.${rawTicket}`],
    { headers: { Cookie: 'eb_token=valid', Origin: 'https://evil.example' } },
  );
  const crossOriginStatus = await new Promise((resolve) => {
    crossOrigin.once('unexpected-response', (_request, response) => {
      response.resume();
      resolve(response.statusCode);
    });
  });
  assert.equal(crossOriginStatus, 403);

  const browser = new WebSocket(
    `ws://127.0.0.1:${appServer.address().port}/api/v1/voice-tutor/realtime`,
    [`easyboost-voice-ticket.${rawTicket}`],
    { headers: { Cookie: 'eb_token=valid' } },
  );
  const browserEvents = [];
  browser.on('message', (data) => { try { browserEvents.push(JSON.parse(data.toString())); } catch {} });
  await onceMessage(browser, (event) => event.type === 'easyboost.ready', 'ready');
  assert.equal(providerEvidence.headers.authorization, 'Bearer provider-main-key-test-only');
  assert.equal(providerEvidence.messages[0].type, 'session.update');
  assert.equal(providerEvidence.messages[0].session.model, 'grok-voice-think-fast-1.0');
  assert.equal(JSON.stringify(providerEvidence.messages[0]).includes('provider-main-key-test-only'), false);
  assert.equal(JSON.stringify(browserEvents).includes('must-not-reach-browser'), false);

  browser.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: Buffer.alloc(4_800).toString('base64') }));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(browserEvents.some((event) => event.type === 'input_audio_buffer.speech_started'), true,
    JSON.stringify({ browserEvents, providerMessages: providerEvidence.messages }));
  const toolArguments = onceMessage(
    browser,
    (event) => event.type === 'response.function_call_arguments.done' && event.call_id === 'call-tool-1',
    'tool arguments',
  );
  browser.send(JSON.stringify({ type: 'response.create' }));
  await toolArguments;
  assert.equal(proxy.claimPedagogyCall('student', 'session-proxy-1', 'call-tool-1', { type: 'explanation_complete' }), false);
  assert.equal(proxy.claimPedagogyCall('student', 'session-proxy-1', 'call-tool-1', { type: 'diagnosis_complete' }), true);
  assert.equal(proxy.completePedagogyCall('student', 'session-proxy-1', 'call-tool-1', { state: 'explain' }), true);
  browser.send(JSON.stringify({
    type: 'conversation.item.create',
    item: { type: 'function_call_output', call_id: 'call-tool-1', output: JSON.stringify({ accepted: true, state: 'explain' }) },
  }));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(providerEvidence.messages.some((event) => (
    event.type === 'conversation.item.create' && event.item?.call_id === 'call-tool-1'
  )), true);
  browser.send(JSON.stringify({ type: 'response.cancel', response_id: 'response-1' }));
  browser.send(JSON.stringify({ type: 'conversation.item.truncate', item_id: 'assistant-1', content_index: 0, audio_end_ms: 25 }));
  let settlementResolved = false;
  const settlement = proxy.waitForSettlement('student', 'session-proxy-1').then((settled) => {
    settlementResolved = true;
    return settled;
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(settlementResolved, false);
  browser.send(JSON.stringify({ type: 'easyboost.close' }));
  await new Promise((resolve) => browser.once('close', resolve));
  assert.equal(await settlement, true);
  assert.equal(await proxy.waitForSettlement('student', 'missing-session'), true);

  assert.equal(providerEvidence.messages.some((event) => event.type === 'response.cancel'), true);
  assert.equal(providerEvidence.messages.some((event) => event.type === 'conversation.item.truncate'), true);
  assert.equal(finalized.length, 1);
  assert.equal(finalized[0].inputAudioBytes, 4_800);
  assert.equal(finalized[0].outputAudioBytes, 2_400);
  assert.equal(finalized[0].confirmed, true);
  assert.equal(finalizationAttempts.get('session-proxy-1'), 3);

  const replay = new WebSocket(
    `ws://127.0.0.1:${appServer.address().port}/api/v1/voice-tutor/realtime`,
    [`easyboost-voice-ticket.${rawTicket}`],
    { headers: { Cookie: 'eb_token=valid' } },
  );
  const replayClose = await new Promise((resolve) => replay.once('close', (code) => resolve(code)));
  assert.equal(replayClose, 1008);

  const unsolicited = new WebSocket(
    `ws://127.0.0.1:${appServer.address().port}/api/v1/voice-tutor/realtime`,
    [`easyboost-voice-ticket.${unsolicitedTicket}`],
    { headers: { Cookie: 'eb_token=valid' } },
  );
  await onceMessage(unsolicited, (event) => event.type === 'easyboost.ready', 'unsolicited ready');
  unsolicited.send(JSON.stringify({
    type: 'conversation.item.create',
    item: { type: 'function_call_output', call_id: 'invented-call', output: JSON.stringify({ accepted: true, state: 'resolved' }) },
  }));
  assert.equal(await new Promise((resolve) => unsolicited.once('close', (code) => resolve(code))), 1011);
  assert.equal(finalized.find((usage) => usage.sessionId === 'session-proxy-unsolicited')?.reason, 'client_contract_invalid');

  const failedSettlement = new WebSocket(
    `ws://127.0.0.1:${appServer.address().port}/api/v1/voice-tutor/realtime`,
    [`easyboost-voice-ticket.${failedSettlementTicket}`],
    { headers: { Cookie: 'eb_token=valid' } },
  );
  await onceMessage(failedSettlement, (event) => event.type === 'easyboost.ready', 'failed settlement ready');
  failedSettlement.send(JSON.stringify({ type: 'easyboost.close' }));
  await new Promise((resolve) => failedSettlement.once('close', resolve));
  assert.equal(await proxy.waitForSettlement('student', 'session-proxy-failed-settlement'), false);
  assert.equal(finalizationAttempts.get('session-proxy-failed-settlement'), 3);
  assert.deepEqual(operationalErrors, [{
    code: 'VOICE_TUTOR_PROXY_FINALIZATION_FAILED',
    reason: 'completed',
    attempts: 3,
  }]);

  const hungSettlement = new WebSocket(
    `ws://127.0.0.1:${appServer.address().port}/api/v1/voice-tutor/realtime`,
    [`easyboost-voice-ticket.${hungSettlementTicket}`],
    { headers: { Cookie: 'eb_token=valid' } },
  );
  await onceMessage(hungSettlement, (event) => event.type === 'easyboost.ready', 'hung settlement ready');
  const hungStartedAt = Date.now();
  hungSettlement.send(JSON.stringify({ type: 'easyboost.close' }));
  await Promise.race([
    new Promise((resolve) => hungSettlement.once('close', resolve)),
    new Promise((_, reject) => setTimeout(() => reject(new Error('hung finalization did not close')), 500)),
  ]);
  assert.equal(await proxy.waitForSettlement('student', 'session-proxy-hung-settlement'), false);
  assert.ok(Date.now() - hungStartedAt < 500);
  assert.equal(finalizationAttempts.get('session-proxy-hung-settlement'), 3);
  assert.equal(maxHungFinalizationConcurrent, 1);
  assert.deepEqual(operationalErrors.at(-1), {
    code: 'VOICE_TUTOR_PROXY_FINALIZATION_FAILED', reason: 'completed', attempts: 3,
  });

  const revocable = new WebSocket(
    `ws://127.0.0.1:${appServer.address().port}/api/v1/voice-tutor/realtime`,
    [`easyboost-voice-ticket.${revocableTicket}`],
    { headers: { Cookie: 'eb_token=valid' } },
  );
  await onceMessage(revocable, (event) => event.type === 'easyboost.ready', 'revocable ready');
  authorized = false;
  const revokedClose = await new Promise((resolve) => revocable.once('close', (code) => resolve(code)));
  assert.equal(revokedClose, 1011);
  const revoked = finalized.find((usage) => usage.sessionId === 'session-proxy-revoked');
  assert.equal(revoked?.confirmed, false);
  assert.equal(revoked?.reason, 'authorization_revoked');

  authorized = true;
  const flood = new WebSocket(
    `ws://127.0.0.1:${appServer.address().port}/api/v1/voice-tutor/realtime`,
    [`easyboost-voice-ticket.${floodTicket}`],
    { headers: { Cookie: 'eb_token=valid' } },
  );
  await onceMessage(flood, (event) => event.type === 'easyboost.ready', 'flood ready');
  const floodProvider = providerEvidence.sockets.at(-1);
  for (let index = 0; index < 121; index += 1) {
    floodProvider.send(JSON.stringify({ type: 'input_audio_buffer.speech_stopped' }));
  }
  assert.equal(await new Promise((resolve) => flood.once('close', (code) => resolve(code))), 1011);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(finalized.find((usage) => usage.sessionId === 'session-proxy-flood')?.reason, 'provider_rate_limit');

  delayCapsule = true;
  const capsuleEntered = new Promise((resolve) => { enterDelayedCapsule = resolve; });
  const connectionsBeforeEarlyClose = providerEvidence.sockets.length;
  const earlyClose = new WebSocket(
    `ws://127.0.0.1:${appServer.address().port}/api/v1/voice-tutor/realtime`,
    [`easyboost-voice-ticket.${earlyCloseTicket}`],
    { headers: { Cookie: 'eb_token=valid' } },
  );
  await capsuleEntered;
  if (earlyClose.readyState === WebSocket.CONNECTING) {
    await new Promise((resolve) => earlyClose.once('open', resolve));
  }
  earlyClose.on('error', () => {});
  earlyClose.terminate();
  await new Promise((resolve) => setTimeout(resolve, 20));
  releaseDelayedCapsule();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(providerEvidence.sockets.length, connectionsBeforeEarlyClose);
  assert.equal(finalized.find((usage) => usage.sessionId === 'session-proxy-early-close')?.reason, 'browser_disconnect');
});

test('upgrade boundary caps parallel handshakes and per-user ticket work before repository fan-out', async (t) => {
  let releaseAuthentication;
  let enterAuthentication;
  let authenticationCalls = 0;
  let consumeCalls = 0;
  const authenticationEntered = new Promise((resolve) => { enterAuthentication = resolve; });
  const proxy = createVoiceTutorRealtimeProxy({
    authentication: {
      async authenticateRequest() {
        authenticationCalls += 1;
        if (authenticationCalls === 1) {
          enterAuthentication();
          await new Promise((resolve) => { releaseAuthentication = resolve; });
        }
        return { username: 'rate-limited-student' };
      },
    },
    db: {
      async consumeVoiceTutorProxyTicket() { consumeCalls += 1; throw new Error('invalid ticket'); },
    },
    providerEndpoint: 'wss://api.x.ai/v1/realtime',
    apiKey: 'test-provider-key',
    model: 'grok-voice-think-fast-1.0',
    voice: 'ara',
    maxConcurrentHandshakes: 1,
    maxUpgradesPerUserPerMinute: 1,
    maxUpgradesPerIpPerMinute: 10,
  });
  const server = http.createServer();
  proxy.attach(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await proxy.close();
    await new Promise((resolve) => server.close(resolve));
  });
  const connect = () => new WebSocket(
    `ws://127.0.0.1:${server.address().port}/api/v1/voice-tutor/realtime`,
    [`easyboost-voice-ticket.${crypto.randomBytes(32).toString('base64url')}`],
  );
  const first = connect();
  first.on('error', () => {});
  await authenticationEntered;
  const parallel = connect();
  const parallelStatus = await new Promise((resolve) => parallel.once('unexpected-response', (_request, response) => {
    response.resume(); resolve(response.statusCode);
  }));
  assert.equal(parallelStatus, 429);
  assert.equal(authenticationCalls, 1);
  releaseAuthentication();
  assert.equal(await new Promise((resolve) => first.once('close', (code) => resolve(code))), 1008);
  assert.equal(consumeCalls, 1);

  const repeated = connect();
  const repeatedStatus = await new Promise((resolve) => repeated.once('unexpected-response', (_request, response) => {
    response.resume(); resolve(response.statusCode);
  }));
  assert.equal(repeatedStatus, 429);
  assert.equal(authenticationCalls, 2);
  assert.equal(consumeCalls, 1);
});

test('upgrade windows use the client behind one trusted proxy and evict expired identities', async (t) => {
  let rateLimitClock = 1_000;
  let authenticationCalls = 0;
  let consumeCalls = 0;
  const proxy = createVoiceTutorRealtimeProxy({
    authentication: {
      async authenticateRequest(request) {
        authenticationCalls += 1;
        return { username: String(request.headers.cookie).replace('eb_token=', '') };
      },
    },
    db: {
      async consumeVoiceTutorProxyTicket() { consumeCalls += 1; throw new Error('invalid ticket'); },
    },
    providerEndpoint: 'wss://api.x.ai/v1/realtime',
    apiKey: 'test-provider-key',
    model: 'grok-voice-think-fast-1.0',
    voice: 'ara',
    trustedProxyHops: 1,
    rateLimitNow: () => rateLimitClock,
    maxUpgradeWindowEntries: 2,
    rateLimitCleanupIntervalMs: 10,
    maxUpgradesPerIpPerMinute: 1,
    maxUpgradesPerUserPerMinute: 1,
  });
  const server = http.createServer();
  proxy.attach(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await proxy.close();
    await new Promise((resolve) => server.close(resolve));
  });

  async function connect(ip, username) {
    const socket = new WebSocket(
      `ws://127.0.0.1:${server.address().port}/api/v1/voice-tutor/realtime`,
      [`easyboost-voice-ticket.${crypto.randomBytes(32).toString('base64url')}`],
      { headers: { Cookie: `eb_token=${username}`, 'X-Forwarded-For': ip } },
    );
    socket.on('error', () => {});
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('upgrade outcome timeout')), 2_000);
      socket.once('unexpected-response', (_request, response) => {
        clearTimeout(timer); response.resume(); resolve({ status: response.statusCode });
      });
      socket.once('close', (code) => { clearTimeout(timer); resolve({ close: code }); });
    });
  }

  assert.deepEqual(await connect('198.51.100.1', 'student-one'), { close: 1008 });
  assert.deepEqual(await connect('198.51.100.2', 'student-two'), { close: 1008 });
  assert.deepEqual(proxy.rateLimitState(), { ipEntries: 2, userEntries: 2 });
  rateLimitClock += 60_001;
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.deepEqual(proxy.rateLimitState(), { ipEntries: 0, userEntries: 0 });
  assert.deepEqual(await connect('198.51.100.3', 'student-three'), { close: 1008 });
  assert.deepEqual(await connect('198.51.100.3', 'student-three'), { status: 429 });
  assert.equal(authenticationCalls, 3);
  assert.equal(consumeCalls, 3);
});

test('provider handshake slots remain held until provider acknowledgement', async (t) => {
  const providerServer = http.createServer();
  const providerWss = new WebSocketServer({ server: providerServer });
  const providerSockets = [];
  let notifyProviderConnection;
  let providerConnection = new Promise((resolve) => { notifyProviderConnection = resolve; });
  providerWss.on('connection', (socket) => {
    providerSockets.push(socket);
    socket.on('message', (data) => {
      if (JSON.parse(data.toString()).type === 'session.update') notifyProviderConnection(socket);
    });
  });
  await new Promise((resolve) => providerServer.listen(0, '127.0.0.1', resolve));

  const tickets = [crypto.randomBytes(32).toString('base64url'), crypto.randomBytes(32).toString('base64url')];
  const sessions = new Map(tickets.map((ticket, index) => [
    crypto.createHash('sha256').update(ticket).digest('hex'), `held-handshake-${index + 1}`,
  ]));
  const consumed = new Set();
  const proxy = createVoiceTutorRealtimeProxy({
    authentication: { async authenticateRequest() { return { username: 'handshake-student' }; } },
    db: {
      async consumeVoiceTutorProxyTicket(_username, input) {
        if (!sessions.has(input.ticketHash) || consumed.has(input.ticketHash)) throw new Error('invalid ticket');
        consumed.add(input.ticketHash);
        return {
          capsule: CAPSULE,
          session: { id: sessions.get(input.ticketHash), reserved_seconds: 60, expires_at: new Date(Date.now() + 60_000).toISOString() },
        };
      },
      async activateVoiceTutorProxySession() {},
      async finalizeVoiceTutorProxySession() {},
    },
    providerEndpoint: `ws://127.0.0.1:${providerServer.address().port}/v1/realtime`,
    apiKey: 'test-provider-key',
    model: 'grok-voice-think-fast-1.0',
    voice: 'ara',
    allowInsecureProvider: true,
    maxConcurrentHandshakes: 1,
    maxConcurrentHandshakesPerUser: 1,
    maxUpgradesPerIpPerMinute: 10,
    maxUpgradesPerUserPerMinute: 10,
  });
  const server = http.createServer();
  proxy.attach(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await proxy.close();
    await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => providerWss.close(resolve));
    await new Promise((resolve) => providerServer.close(resolve));
  });
  const connect = (ticket) => new WebSocket(
    `ws://127.0.0.1:${server.address().port}/api/v1/voice-tutor/realtime`,
    [`easyboost-voice-ticket.${ticket}`],
  );
  async function openingOutcome(socket) {
    socket.on('error', () => {});
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('opening outcome timeout')), 2_000);
      socket.once('open', () => { clearTimeout(timer); resolve({ open: true }); });
      socket.once('unexpected-response', (_request, response) => {
        clearTimeout(timer); response.resume(); resolve({ status: response.statusCode });
      });
    });
  }

  const first = connect(tickets[0]);
  assert.deepEqual(await openingOutcome(first), { open: true });
  const firstProvider = await providerConnection;
  const blocked = connect(tickets[1]);
  assert.deepEqual(await openingOutcome(blocked), { status: 429 });

  const ready = onceMessage(first, (event) => event.type === 'easyboost.ready', 'first ready');
  firstProvider.send(JSON.stringify({ type: 'session.updated' }));
  await ready;
  providerConnection = new Promise((resolve) => { notifyProviderConnection = resolve; });
  const second = connect(tickets[1]);
  assert.deepEqual(await openingOutcome(second), { open: true });
  const secondProvider = await providerConnection;
  const secondReady = onceMessage(second, (event) => event.type === 'easyboost.ready', 'second ready');
  secondProvider.send(JSON.stringify({ type: 'session.updated' }));
  await secondReady;
  first.terminate();
  second.terminate();
});

test('proxy shutdown bounds pre-active sockets whose capsule resolution never returns', async () => {
  let entered;
  const capsuleEntered = new Promise((resolve) => { entered = resolve; });
  const proxy = createVoiceTutorRealtimeProxy({
    authentication: { async authenticateRequest() { return { username: 'student' }; } },
    db: {
      async consumeVoiceTutorProxyTicket() {
        return {
          capsule: CAPSULE,
          session: { id: 'shutdown-session', reserved_seconds: 60, expires_at: new Date(Date.now() + 60_000).toISOString() },
        };
      },
      async finalizeVoiceTutorProxySession() {},
    },
    providerEndpoint: 'wss://api.x.ai/v1/realtime',
    apiKey: 'test-provider-key',
    model: 'grok-voice-think-fast-1.0',
    voice: 'ara',
    resolveCapsule: async () => { entered(); return new Promise(() => {}); },
  });
  const server = http.createServer();
  proxy.attach(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const socket = new WebSocket(
    `ws://127.0.0.1:${server.address().port}/api/v1/voice-tutor/realtime`,
    [`easyboost-voice-ticket.${crypto.randomBytes(32).toString('base64url')}`],
  );
  socket.on('error', () => {});
  const socketClosed = new Promise((resolve) => socket.once('close', resolve));
  await capsuleEntered;
  const startedAt = Date.now();
  await proxy.close({ timeoutMs: 50 });
  assert.ok(Date.now() - startedAt < 500);
  await Promise.race([socketClosed, new Promise((resolve) => setTimeout(resolve, 250))]);
  assert.equal(socket.readyState, WebSocket.CLOSED);
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
});

test('one deadline releases a pre-provider slot when capsule resolution hangs', async (t) => {
  let consumeCount = 0;
  const proxy = createVoiceTutorRealtimeProxy({
    authentication: { async authenticateRequest() { return { username: 'deadline-student' }; } },
    db: {
      async consumeVoiceTutorProxyTicket() {
        consumeCount += 1;
        return {
          capsule: CAPSULE,
          session: { id: `deadline-session-${consumeCount}`, reserved_seconds: 60, expires_at: new Date(Date.now() + 60_000).toISOString() },
        };
      },
      async finalizeVoiceTutorProxySession() {},
    },
    providerEndpoint: 'wss://api.x.ai/v1/realtime',
    apiKey: 'test-provider-key',
    model: 'grok-voice-think-fast-1.0',
    voice: 'ara',
    resolveCapsule: async () => new Promise(() => {}),
    providerHandshakeTimeoutMs: 30,
    maxConcurrentHandshakes: 1,
    maxConcurrentHandshakesPerUser: 1,
    maxUpgradesPerIpPerMinute: 10,
    maxUpgradesPerUserPerMinute: 10,
  });
  const server = http.createServer();
  proxy.attach(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await proxy.close({ timeoutMs: 50 });
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  });
  const connect = () => new WebSocket(
    `ws://127.0.0.1:${server.address().port}/api/v1/voice-tutor/realtime`,
    [`easyboost-voice-ticket.${crypto.randomBytes(32).toString('base64url')}`],
  );
  const first = connect();
  first.on('error', () => {});
  await new Promise((resolve) => first.once('open', resolve));
  await Promise.race([
    new Promise((resolve) => first.once('close', resolve)),
    new Promise((_, reject) => setTimeout(() => reject(new Error('pre-provider deadline did not close')), 250)),
  ]);
  const second = connect();
  second.on('error', () => {});
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('replacement handshake did not open')), 250);
    second.once('open', () => { clearTimeout(timer); resolve(); });
    second.once('unexpected-response', (_request, response) => {
      clearTimeout(timer); response.resume(); reject(new Error(`unexpected ${response.statusCode}`));
    });
  });
  assert.equal(consumeCount, 2);
});
