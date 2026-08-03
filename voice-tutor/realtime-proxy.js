import crypto from 'node:crypto';
import net from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';
import { buildVoiceTutorRealtimeInstructions, VOICE_TUTOR_PROMPT_VERSION } from './prompt.js';

export const VOICE_TUTOR_AUDIO = Object.freeze({
  codec: 'audio/pcm',
  sampleRate: 24_000,
  channels: 1,
  bytesPerSample: 2,
  bytesPerSecond: 48_000,
});

function ticketHash(ticket) {
  return crypto.createHash('sha256').update(ticket).digest('hex');
}

const MAX_SESSION_BYTES = 81_920;
const MAX_FRAME_BYTES = 262_144;
const MAX_AUDIO_CHUNK_BYTES = 24_000;
const MAX_TOOL_BYTES = 1_024;
const MAX_PROVIDER_TOOL_RESPONSES = 8;
const MAX_EVENTS_PER_SECOND = 120;
const MAX_PROVIDER_BYTES_PER_SECOND = 1_048_576;
const MAX_BUFFERED_BYTES = 524_288;
const SAFE_MODEL = /^grok-voice-[a-z0-9][a-z0-9.-]*-(?:\d{4}-\d{2}-\d{2}|\d+\.\d+)$/u;
const UNSAFE_MODEL_ALIAS = /(?:^|[-_.])(?:alias|current|latest|preview|stable)(?:$|[-_.])/iu;
const SAFE_VOICE = /^[a-z][a-z0-9_-]{0,63}$/u;
const SAFE_ID = /^[A-Za-z0-9._:-]{1,128}$/u;
const SAFE_TICKET = /^[A-Za-z0-9_-]{32,128}$/u;
const PEDAGOGY_TYPES = new Set(['diagnosis_complete', 'explanation_complete', 'check_answer', 'transfer_answer']);
const PEDAGOGY_STATES = new Set(['diagnose', 'explain', 'micro_check', 'transfer_task', 'resolved', 'fallback', 'ended']);
const PASSIVE_PROVIDER_EVENTS = new Set([
  'session.created', 'session.updated', 'conversation.created', 'conversation.item.added', 'conversation.item.created',
  'conversation.item.truncated', 'input_audio_buffer.committed', 'input_audio_buffer.cleared',
  'input_audio_buffer.speech_started', 'input_audio_buffer.speech_stopped',
  'response.created', 'response.output_item.added', 'response.output_item.done',
  'response.content_part.added', 'response.content_part.done',
  'response.output_audio.delta', 'response.audio.delta',
  'response.output_audio.done', 'response.audio.done',
  'response.output_audio_transcript.delta', 'response.output_audio_transcript.done',
  'response.audio_transcript.delta', 'response.audio_transcript.done',
  'conversation.item.input_audio_transcription.updated',
  'conversation.item.input_audio_transcription.completed',
  'response.function_call_arguments.delta', 'response.function_call_arguments.done',
  'response.done', 'response.cancelled', 'error',
]);
const PUBLIC_PASSIVE_PROVIDER_EVENTS = new Set([
  'conversation.item.created',
  'input_audio_buffer.committed', 'input_audio_buffer.cleared',
  'input_audio_buffer.speech_stopped',
  'response.content_part.added', 'response.content_part.done',
  'response.output_audio.done', 'response.audio.done',
  'response.output_audio_transcript.done', 'response.audio_transcript.done',
]);

function encodedBytes(value) {
  return Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
}

function immutableModel(value) {
  const model = String(value || '');
  return SAFE_MODEL.test(model) && !UNSAFE_MODEL_ALIAS.test(model);
}

function pedagogyTool() {
  return {
    type: 'function',
    name: 'advance_pedagogy',
    description: 'Передать серверу завершение шага или ответ ученика для canonical проверки.',
    parameters: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: [...PEDAGOGY_TYPES] },
        answer: { type: 'string', maxLength: 200 },
      },
      required: ['type'],
      additionalProperties: false,
    },
  };
}

export function buildVoiceTutorProxySessionUpdate({ capsule, model, voice }) {
  if (!capsule || !immutableModel(model) || !SAFE_VOICE.test(String(voice || ''))) {
    throw Object.assign(new Error('VOICE_TUTOR_PROVIDER_NOT_CONFIGURED'), { code: 'VOICE_TUTOR_PROVIDER_NOT_CONFIGURED' });
  }
  const event = {
    type: 'session.update',
    session: {
      model,
      voice,
      instructions: buildVoiceTutorRealtimeInstructions(capsule),
      reasoning: { effort: 'high' },
      audio: {
        input: { format: { type: VOICE_TUTOR_AUDIO.codec, rate: VOICE_TUTOR_AUDIO.sampleRate }, transport: 'json' },
        output: { format: { type: VOICE_TUTOR_AUDIO.codec, rate: VOICE_TUTOR_AUDIO.sampleRate }, transport: 'json' },
      },
      tools: [pedagogyTool()],
      turn_detection: { type: 'server_vad' },
    },
  };
  if (encodedBytes(event) > MAX_SESSION_BYTES) {
    throw Object.assign(new Error('VOICE_TUTOR_PROVIDER_CONTRACT_INVALID'), { code: 'VOICE_TUTOR_PROVIDER_CONTRACT_INVALID' });
  }
  return event;
}

export function decodedPcm16Bytes(value, { maxBytes = MAX_AUDIO_CHUNK_BYTES } = {}) {
  if (typeof value !== 'string' || !value || value.length > Math.ceil(maxBytes / 3) * 4
    || value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) return null;
  let decoded;
  try { decoded = Buffer.from(value, 'base64'); } catch { return null; }
  if (!decoded.length || decoded.length > maxBytes || decoded.length % VOICE_TUTOR_AUDIO.bytesPerSample !== 0
    || decoded.toString('base64') !== value) return null;
  return decoded.length;
}

function publicPolicyBlock(policy = {}) {
  if (policy.enabled === false) return 'VOICE_TUTOR_DISABLED';
  if (policy.costKillSwitch === true) return 'VOICE_TUTOR_COST_KILL_SWITCH';
  if (policy.requireZdr === true && policy.zdrAttested !== true) return 'VOICE_TUTOR_ZDR_NOT_CONFIRMED';
  return null;
}

function providerUrl(endpoint, model, { allowInsecureLoopback = false } = {}) {
  try {
    const url = new URL(endpoint);
    if (url.protocol !== 'wss:' && !(allowInsecureLoopback && url.protocol === 'ws:' && ['127.0.0.1', 'localhost', '::1'].includes(url.hostname))) throw new Error();
    url.searchParams.set('model', model);
    return url.toString();
  } catch {
    throw Object.assign(new Error('VOICE_TUTOR_PROVIDER_NOT_CONFIGURED'), { code: 'VOICE_TUTOR_PROVIDER_NOT_CONFIGURED' });
  }
}

function jsonObject(raw) {
  if (typeof raw !== 'string' || !raw || encodedBytes(raw) > MAX_FRAME_BYTES) return null;
  try {
    const value = JSON.parse(raw);
    return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length <= 20 ? value : null;
  } catch { return null; }
}

function providerPedagogyEvent(message) {
  if (message?.type !== 'response.function_call_arguments.done' || message.name !== 'advance_pedagogy'
    || !SAFE_ID.test(String(message.call_id || '')) || !SAFE_ID.test(String(message.item_id || ''))
    || typeof message.arguments !== 'string' || encodedBytes(message.arguments) > MAX_TOOL_BYTES) return null;
  const parsed = jsonObject(message.arguments);
  if (!parsed || !PEDAGOGY_TYPES.has(parsed.type)) return null;
  const needsAnswer = ['check_answer', 'transfer_answer'].includes(parsed.type);
  if (needsAnswer !== Object.hasOwn(parsed, 'answer')
    || (needsAnswer && (typeof parsed.answer !== 'string' || parsed.answer.length > 200))) return null;
  return { type: parsed.type, ...(needsAnswer ? { answer: parsed.answer } : {}) };
}

function providerResponseId(message) {
  const value = String(message?.response_id ?? message?.response?.id ?? '');
  return SAFE_ID.test(value) ? value : null;
}

function providerItemId(message) {
  const value = String(message?.item_id ?? message?.item?.id ?? '');
  return SAFE_ID.test(value) ? value : null;
}

function validProviderEvent(message) {
  if (!message || typeof message.type !== 'string' || !PASSIVE_PROVIDER_EVENTS.has(message.type)) return false;
  if (message.type === 'response.output_audio.delta' || message.type === 'response.audio.delta') {
    return providerResponseId(message) != null && decodedPcm16Bytes(message.delta) != null;
  }
  if (message.type === 'response.function_call_arguments.done') {
    return providerResponseId(message) != null && providerPedagogyEvent(message) != null;
  }
  if (message.type === 'response.function_call_arguments.delta') {
    return providerResponseId(message) != null && providerItemId(message) != null
      && SAFE_ID.test(String(message.call_id || '')) && typeof message.delta === 'string'
      && encodedBytes(message.delta) <= MAX_TOOL_BYTES;
  }
  if (message.type === 'response.output_item.added' && message.item?.type === 'function_call') {
    return providerResponseId(message) != null && SAFE_ID.test(String(message.item.id || ''))
      && message.item.name === 'advance_pedagogy' && SAFE_ID.test(String(message.item.call_id || ''));
  }
  if (message.type === 'response.output_item.added') {
    return providerResponseId(message) != null && providerItemId(message) != null
      && message.item?.type === 'message' && message.item.role === 'assistant';
  }
  if (message.type === 'response.created' || message.type === 'response.output_item.done'
    || message.type === 'response.done' || message.type === 'response.cancelled') {
    if (providerResponseId(message) == null) return false;
    if (message.type === 'response.output_item.done' && providerItemId(message) == null) return false;
  }
  if (message.type === 'response.done' && message.response?.usage != null) {
    const usage = message.response.usage;
    if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return false;
    for (const key of ['input_tokens', 'output_tokens', 'total_tokens']) {
      if (!Number.isSafeInteger(usage[key]) || usage[key] < 0 || usage[key] > 1_000_000_000) return false;
    }
  }
  if (message.type.endsWith('transcript.delta') || message.type.endsWith('transcription.updated')
    || message.type.endsWith('transcription.completed')) {
    const caption = message.delta ?? message.transcript ?? '';
    if (typeof caption !== 'string' || encodedBytes(caption) > 4_096) return false;
    if (message.type.startsWith('response.') && providerResponseId(message) == null) return false;
  }
  return true;
}

function publicProviderEvent(message) {
  const type = message.type;
  if (type === 'error') return { type: 'error', code: 'VOICE_TUTOR_PROVIDER_UNAVAILABLE' };
  if (type === 'response.created') return { type, response_id: providerResponseId(message) };
  if (type === 'response.output_item.added') {
    const item = message.item.type === 'function_call'
      ? { id: providerItemId(message), type: 'function_call', name: 'advance_pedagogy', call_id: String(message.item.call_id) }
      : { id: providerItemId(message), type: 'message', role: 'assistant' };
    return { type, response_id: providerResponseId(message), item };
  }
  if (type === 'response.output_item.done') {
    return { type, response_id: providerResponseId(message), item_id: providerItemId(message) };
  }
  if (type === 'response.function_call_arguments.delta') {
    return {
      type, response_id: providerResponseId(message), item_id: providerItemId(message),
      call_id: String(message.call_id), delta: '',
    };
  }
  if (type === 'response.function_call_arguments.done') {
    const event = providerPedagogyEvent(message);
    return {
      type, response_id: providerResponseId(message), item_id: providerItemId(message),
      call_id: String(message.call_id), name: 'advance_pedagogy', arguments: JSON.stringify(event),
    };
  }
  if (type === 'response.done' || type === 'response.cancelled') {
    return { type, response_id: providerResponseId(message) };
  }
  if (type === 'response.output_audio.delta' || type === 'response.audio.delta') {
    return { type, response_id: providerResponseId(message), delta: message.delta };
  }
  if (type === 'response.output_audio_transcript.delta' || type === 'response.audio_transcript.delta') {
    return { type, response_id: providerResponseId(message), delta: message.delta ?? message.transcript ?? '' };
  }
  if (type === 'conversation.item.input_audio_transcription.completed') {
    return { type, transcript: message.transcript ?? message.delta ?? '' };
  }
  if (type === 'input_audio_buffer.speech_started' || PUBLIC_PASSIVE_PROVIDER_EVENTS.has(type)) return { type };
  return null;
}

function validBrowserEvent(message) {
  if (!message || typeof message.type !== 'string') return null;
  if (message.type === 'input_audio_buffer.append') {
    const bytes = decodedPcm16Bytes(message.audio);
    return bytes == null || Object.keys(message).length !== 2 ? null : { bytes };
  }
  if (message.type === 'response.cancel') {
    return Object.keys(message).every((key) => ['type', 'response_id'].includes(key))
      && (message.response_id == null || SAFE_ID.test(String(message.response_id))) ? {} : null;
  }
  if (message.type === 'conversation.item.truncate') {
    return Object.keys(message).length === 4 && SAFE_ID.test(String(message.item_id || ''))
      && message.content_index === 0 && Number.isInteger(message.audio_end_ms)
      && message.audio_end_ms >= 0 && message.audio_end_ms <= 60_000 ? {} : null;
  }
  if (message.type === 'conversation.item.create') {
    const item = message.item;
    if (Object.keys(message).length !== 2 || !item || Object.keys(item).length !== 3
      || item.type !== 'function_call_output' || !SAFE_ID.test(String(item.call_id || ''))
      || typeof item.output !== 'string' || encodedBytes(item.output) > MAX_TOOL_BYTES) return null;
    const output = jsonObject(item.output);
    return output && Object.keys(output).length === 2 && output.accepted === true
      && PEDAGOGY_STATES.has(output.state)
      ? { toolOutput: { callId: String(item.call_id), output } }
      : null;
  }
  if (message.type === 'response.create') return Object.keys(message).length === 1 ? {} : null;
  if (message.type === 'easyboost.close') return Object.keys(message).length === 1 ? { clean: true } : null;
  return null;
}

function rejectUpgrade(socket, status = 401) {
  const statusText = {
    400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found',
    429: 'Too Many Requests', 503: 'Service Unavailable',
  }[status] || 'Bad Request';
  if (!socket.destroyed) socket.end(`HTTP/1.1 ${status} ${statusText}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

function sameOriginUpgrade(request) {
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    return ['http:', 'https:'].includes(parsed.protocol) && parsed.host === request.headers.host;
  } catch {
    return false;
  }
}

function ticketFromProtocols(header) {
  const values = String(header || '').split(',').map((value) => value.trim());
  if (values.length !== 1 || !values[0].startsWith('easyboost-voice-ticket.')) return null;
  const ticket = values[0].slice('easyboost-voice-ticket.'.length);
  return SAFE_TICKET.test(ticket) ? ticket : null;
}

export function createVoiceTutorRealtimeProxy({
  authentication,
  db,
  providerEndpoint,
  apiKey,
  model,
  voice,
  policy = () => ({}),
  authorize = async () => true,
  resolveCapsule = async (_username, capsule) => capsule,
  now = () => new Date(),
  webSocketFactory = (url, options) => new WebSocket(url, options),
  providerHandshakeTimeoutMs = 10_000,
  allowInsecureProvider = false,
  finalizationRetryDelaysMs = [25, 100],
  finalizationAttemptTimeoutMs = 1_000,
  onOperationalError = (event) => console.error(JSON.stringify({
    timestamp: new Date().toISOString(), level: 'error', type: 'voice_tutor_proxy_error', ...event,
  })),
  maxConcurrentHandshakes = 32,
  maxConcurrentHandshakesPerUser = 2,
  maxUpgradesPerIpPerMinute = 30,
  maxUpgradesPerUserPerMinute = 20,
  trustedProxyHops = 0,
  rateLimitNow = () => Date.now(),
  maxUpgradeWindowEntries = 10_000,
  rateLimitCleanupIntervalMs = 5_000,
} = {}) {
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_FRAME_BYTES,
    perMessageDeflate: false,
    handleProtocols: (protocols) => [...protocols][0] || false,
  });
  const active = new Set();
  const activeBySession = new Map();
  const sessionKey = (username, sessionId) => `${username}\u0000${sessionId}`;
  const ipWindows = new Map();
  const userWindows = new Map();
  const userHandshakes = new Map();
  const pendingUpgradeSockets = new Set();
  const rateLimitKey = crypto.randomBytes(32);
  const retryDelays = (Array.isArray(finalizationRetryDelaysMs) ? finalizationRetryDelaysMs : [])
    .slice(0, 3).map((value) => Math.max(0, Math.min(1_000, Number(value) || 0)));
  const handshakeLimit = Math.max(1, Math.min(256, Number(maxConcurrentHandshakes) || 32));
  const userHandshakeLimit = Math.max(1, Math.min(8, Number(maxConcurrentHandshakesPerUser) || 2));
  const ipUpgradeLimit = Math.max(1, Math.min(600, Number(maxUpgradesPerIpPerMinute) || 30));
  const userUpgradeLimit = Math.max(1, Math.min(300, Number(maxUpgradesPerUserPerMinute) || 20));
  const proxyHops = Math.max(0, Math.min(4, Number(trustedProxyHops) || 0));
  const windowEntryLimit = Math.max(1, Math.min(50_000, Number(maxUpgradeWindowEntries) || 10_000));
  const windowCleanupInterval = Math.max(10, Math.min(60_000, Number(rateLimitCleanupIntervalMs) || 5_000));
  const handshakeTimeout = Math.max(25, Math.min(30_000, Number(providerHandshakeTimeoutMs) || 10_000));
  const finalizationAttemptTimeout = Math.max(1, Math.min(5_000, Number(finalizationAttemptTimeoutMs) || 1_000));
  let pendingHandshakes = 0;
  let accepting = true;

  function normalizedIp(value) {
    const candidate = String(value || '').trim();
    const ipv4 = candidate.startsWith('::ffff:') ? candidate.slice(7) : candidate;
    if (net.isIP(ipv4)) return ipv4;
    return net.isIP(candidate) ? candidate : null;
  }

  function clientIp(request) {
    const remote = normalizedIp(request.socket?.remoteAddress) || 'unknown';
    if (!proxyHops) return remote;
    const rawForwarded = request.headers['x-forwarded-for'];
    if (typeof rawForwarded !== 'string' || rawForwarded.length > 1_024) return remote;
    const forwarded = rawForwarded.split(',').map((value) => value.trim()).slice(-16);
    const selected = forwarded[Math.max(0, forwarded.length - proxyHops)];
    return normalizedIp(selected) || remote;
  }

  function rateWindowKey(scope, identity) {
    return crypto.createHmac('sha256', rateLimitKey).update(`${scope}\u0000${identity}`).digest('base64url');
  }

  function rateLimitObservedAt() {
    const value = Number(rateLimitNow());
    return Number.isFinite(value) ? value : Date.now();
  }

  function pruneExpiredWindows(windows, observedAt = rateLimitObservedAt()) {
    for (const [storedKey, storedWindow] of windows) {
      if (observedAt - storedWindow.startedAt >= 60_000) windows.delete(storedKey);
    }
  }

  function consumeWindow(windows, key, limit) {
    const observedAt = rateLimitObservedAt();
    let window = windows.get(key);
    if (!window || observedAt - window.startedAt >= 60_000) {
      if (!window && windows.size >= windowEntryLimit) {
        pruneExpiredWindows(windows, observedAt);
      }
      if (!window && windows.size >= windowEntryLimit) return false;
      window = { startedAt: observedAt, count: 0 };
      windows.set(key, window);
    }
    window.count += 1;
    return window.count <= limit;
  }

  const rateLimitCleanupTimer = setInterval(() => {
    const observedAt = rateLimitObservedAt();
    pruneExpiredWindows(ipWindows, observedAt);
    pruneExpiredWindows(userWindows, observedAt);
  }, windowCleanupInterval);
  rateLimitCleanupTimer.unref?.();

  const wait = (milliseconds) => new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref?.();
  });

  async function persistFinalization(username, sessionId, usage) {
    let attempts = 0;
    for (let attempt = 0; attempt <= retryDelays.length; attempt += 1) {
      attempts = attempt + 1;
      try {
        await db.finalizeVoiceTutorProxySession(username, sessionId, {
          ...usage,
          attemptTimeoutMs: finalizationAttemptTimeout,
        });
        return true;
      } catch {
        if (attempt < retryDelays.length) await wait(retryDelays[attempt]);
      }
    }
    try {
      onOperationalError({ code: 'VOICE_TUTOR_PROXY_FINALIZATION_FAILED', reason: usage.reason, attempts });
    } catch {}
    return false;
  }

  async function handleBrowser(browserSocket, authenticated, ticket) {
    let browserGone = browserSocket.readyState !== WebSocket.OPEN;
    const markBrowserGone = () => { browserGone = true; };
    browserSocket.once('close', markBrowserGone);
    browserSocket.once('error', markBrowserGone);
    const finalizeBeforeProvider = async (consumedSession, reason, closeReason) => {
      try { if (browserSocket.readyState < 2) browserSocket.close(1011, closeReason); } catch {}
      await persistFinalization(authenticated.username, consumedSession.id, {
        inputAudioBytes: 0, outputAudioBytes: 0, confirmed: false, reason, now: now(),
      });
    };
    let consumed;
    try {
      const block = publicPolicyBlock(policy());
      if (block) throw Object.assign(new Error(block), { code: block });
      if (!await authorize(authenticated.username)) throw Object.assign(new Error('authorization revoked'), { code: 'AUTHORIZATION_REVOKED' });
      if (browserGone || browserSocket.readyState !== WebSocket.OPEN) throw Object.assign(new Error('browser disconnected'), { code: 'BROWSER_DISCONNECTED' });
      consumed = await db.consumeVoiceTutorProxyTicket(authenticated.username, {
        ticketHash: ticketHash(ticket),
        now: now(),
        provider: 'xai',
        model,
        promptVersion: VOICE_TUTOR_PROMPT_VERSION,
      });
    } catch {
      browserSocket.close(1008, 'ticket rejected');
      return;
    }
    if (browserGone || browserSocket.readyState !== WebSocket.OPEN) {
      await finalizeBeforeProvider(consumed.session, 'browser_disconnect', 'browser disconnected');
      return;
    }

    let resolvedCapsule;
    try {
      resolvedCapsule = await resolveCapsule(authenticated.username, consumed.capsule);
    } catch {
      await finalizeBeforeProvider(consumed.session, 'context_rebuild_failed', 'context unavailable');
      return;
    }
    if (browserGone || browserSocket.readyState !== WebSocket.OPEN) {
      await finalizeBeforeProvider(consumed.session, 'browser_disconnect', 'browser disconnected');
      return;
    }
    let sessionUpdate;
    try {
      sessionUpdate = buildVoiceTutorProxySessionUpdate({ capsule: resolvedCapsule, model, voice });
    } catch {
      await finalizeBeforeProvider(consumed.session, 'session_config_invalid', 'session unavailable');
      return;
    }
    let providerSocket;
    try {
      if (!String(apiKey || '') || !immutableModel(model)) throw new Error();
      providerSocket = webSocketFactory(providerUrl(providerEndpoint, model, { allowInsecureLoopback: allowInsecureProvider }), {
        headers: { Authorization: `Bearer ${apiKey}` },
        maxPayload: MAX_FRAME_BYTES,
        perMessageDeflate: false,
        handshakeTimeout,
      });
    } catch {
      await finalizeBeforeProvider(consumed.session, 'provider_connect_failed', 'provider unavailable');
      return;
    }

    let resolveSettlement;
    const settlement = new Promise((resolve) => { resolveSettlement = resolve; });
    let resolveProviderHandshake;
    let providerHandshakeSettled = false;
    const providerHandshake = new Promise((resolve) => { resolveProviderHandshake = resolve; });
    const settleProviderHandshake = () => {
      if (providerHandshakeSettled) return;
      providerHandshakeSettled = true;
      resolveProviderHandshake();
    };
    const key = sessionKey(authenticated.username, consumed.session.id);
    const providerCalls = new Map();
    const providerToolResponseIds = new Set();
    const connection = {
      browserSocket,
      providerSocket,
      finalize: null,
      settlement,
      settlementOutcome: null,
      username: authenticated.username,
      sessionId: consumed.session.id,
      providerCalls,
      acceptingToolCalls: true,
    };
    active.add(connection);
    activeBySession.set(key, connection);
    let finalized = false;
    let cleanRequested = false;
    let providerAcknowledged = false;
    let providerReady = false;
    let learnerTurnRequired = false;
    let authorizationCheckRunning = false;
    let inputAudioBytes = 0;
    let outputAudioBytes = 0;
    let eventWindowAt = Date.now();
    let eventCount = 0;
    let providerEventWindowAt = Date.now();
    let providerEventCount = 0;
    let providerEventBytes = 0;
    let deadlineTimer = null;
    let policyTimer = null;
    const maxAudioBytes = Number(consumed.session.reserved_seconds) * VOICE_TUTOR_AUDIO.bytesPerSecond;
    const deadlineMs = new Date(consumed.session.expires_at).getTime();

    const finalize = async ({ confirmed = false, reason = 'abnormal_disconnect' } = {}) => {
      if (finalized) return settlement;
      finalized = true;
      settleProviderHandshake();
      connection.acceptingToolCalls = false;
      clearTimeout(deadlineTimer);
      clearInterval(policyTimer);
      const closeSockets = () => {
        try { if (browserSocket.readyState < 2) browserSocket.close(confirmed ? 1000 : 1011, confirmed ? 'complete' : 'fallback'); } catch {}
        try { if (providerSocket.readyState < 2) providerSocket.close(confirmed ? 1000 : 1011); } catch {}
      };
      if (!confirmed) closeSockets();
      const persisted = await persistFinalization(authenticated.username, consumed.session.id, {
        inputAudioBytes, outputAudioBytes, confirmed, reason, now: now(),
      });
      active.delete(connection);
      connection.settlementOutcome = persisted;
      resolveSettlement(persisted);
      const settlementRetention = setTimeout(() => {
        if (activeBySession.get(key) === connection) activeBySession.delete(key);
      }, 5_000);
      settlementRetention.unref?.();
      if (confirmed) closeSockets();
      const forceCloseTimer = setTimeout(() => {
        try { if (browserSocket.readyState !== WebSocket.CLOSED) browserSocket.terminate(); } catch {}
        try { if (providerSocket.readyState !== WebSocket.CLOSED) providerSocket.terminate(); } catch {}
      }, 250);
      forceCloseTimer.unref?.();
    };
    connection.finalize = finalize;
    deadlineTimer = setTimeout(() => { void finalize({ confirmed: false, reason: 'hard_deadline' }); }, Math.max(1, deadlineMs - new Date(now()).getTime()));
    deadlineTimer.unref?.();
    policyTimer = setInterval(() => {
      if (publicPolicyBlock(policy())) return void finalize({ confirmed: false, reason: 'kill_switch' });
      if (authorizationCheckRunning) return;
      authorizationCheckRunning = true;
      void Promise.resolve(authorize(authenticated.username))
        .then((allowed) => {
          if (!allowed) return finalize({ confirmed: false, reason: 'authorization_revoked' });
          return undefined;
        })
        .catch(() => finalize({ confirmed: false, reason: 'authorization_check_failed' }))
        .finally(() => { authorizationCheckRunning = false; });
    }, 500);
    policyTimer.unref?.();

    browserSocket.off('close', markBrowserGone);
    browserSocket.off('error', markBrowserGone);
    if (browserGone || browserSocket.readyState !== WebSocket.OPEN) {
      void finalize({ confirmed: false, reason: 'browser_disconnect' });
      return;
    }

    providerSocket.on('unexpected-response', (_request, response) => {
      let bytes = 0;
      response.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > 8_192) response.destroy();
      });
      response.resume();
      void finalize({ confirmed: false, reason: 'provider_handshake_rejected' });
    });
    providerSocket.on('open', () => {
      if (publicPolicyBlock(policy())) return void finalize({ confirmed: false, reason: 'kill_switch' });
      providerSocket.send(JSON.stringify(sessionUpdate));
    });
    providerSocket.on('message', (data, isBinary) => {
      if (finalized || isBinary || publicPolicyBlock(policy())) return void finalize({ confirmed: false, reason: isBinary ? 'unexpected_binary' : 'kill_switch' });
      const raw = data.toString('utf8');
      const observed = Date.now();
      if (observed - providerEventWindowAt >= 1_000) {
        providerEventWindowAt = observed;
        providerEventCount = 0;
        providerEventBytes = 0;
      }
      providerEventCount += 1;
      providerEventBytes += Buffer.byteLength(raw, 'utf8');
      if (providerEventCount > MAX_EVENTS_PER_SECOND || providerEventBytes > MAX_PROVIDER_BYTES_PER_SECOND) {
        return void finalize({ confirmed: false, reason: 'provider_rate_limit' });
      }
      const message = jsonObject(raw);
      if (!validProviderEvent(message)) return void finalize({ confirmed: false, reason: 'provider_contract_invalid' });
      if (message.type === 'session.updated') {
        if (providerAcknowledged) return void finalize({ confirmed: false, reason: 'provider_order_invalid' });
        providerAcknowledged = true;
        void db.activateVoiceTutorProxySession(authenticated.username, consumed.session.id, { now: now() })
          .then(() => {
            if (finalized) return;
            providerReady = true;
            settleProviderHandshake();
            if (browserSocket.readyState === WebSocket.OPEN) {
              browserSocket.send(JSON.stringify({ type: 'easyboost.ready', audio: { codec: 'pcm16le', rate: 24_000, channels: 1 } }));
            }
          })
          .catch(() => finalize({ confirmed: false, reason: 'activation_failed' }));
        return;
      }
      if (!providerReady && !['session.created', 'conversation.created'].includes(message.type)) {
        return void finalize({ confirmed: false, reason: 'provider_order_invalid' });
      }
      if (message.type === 'response.output_item.added' && message.item?.type === 'function_call') {
        const callId = String(message.item.call_id);
        const responseId = providerResponseId(message);
        if (providerCalls.size >= MAX_PROVIDER_TOOL_RESPONSES
          || providerToolResponseIds.size >= MAX_PROVIDER_TOOL_RESPONSES || providerCalls.has(callId)
          || providerToolResponseIds.has(responseId) || learnerTurnRequired) {
          return void finalize({ confirmed: false, reason: 'provider_order_invalid' });
        }
        providerToolResponseIds.add(responseId);
        learnerTurnRequired = true;
        providerCalls.set(callId, {
          itemId: String(message.item.id), event: null, claimed: false, authorizedOutput: null,
        });
      }
      if (message.type === 'input_audio_buffer.speech_started') learnerTurnRequired = false;
      if (message.type === 'response.function_call_arguments.done') {
        const call = providerCalls.get(String(message.call_id));
        const event = providerPedagogyEvent(message);
        if (!call || call.itemId !== String(message.item_id) || call.event || !event) {
          return void finalize({ confirmed: false, reason: 'provider_order_invalid' });
        }
        call.event = event;
      }
      if (message.type === 'response.output_audio.delta' || message.type === 'response.audio.delta') {
        outputAudioBytes += decodedPcm16Bytes(message.delta);
        if (inputAudioBytes + outputAudioBytes > maxAudioBytes) return void finalize({ confirmed: false, reason: 'audio_quota_limit' });
      }
      const publicEvent = publicProviderEvent(message);
      if (browserSocket.bufferedAmount > MAX_BUFFERED_BYTES) return void finalize({ confirmed: false, reason: 'browser_backpressure' });
      if (publicEvent && browserSocket.readyState === WebSocket.OPEN) browserSocket.send(JSON.stringify(publicEvent));
    });
    providerSocket.on('error', () => { void finalize({ confirmed: false, reason: 'provider_error' }); });
    providerSocket.on('close', (code) => {
      void finalize({ confirmed: cleanRequested && code === 1000, reason: cleanRequested && code === 1000 ? 'completed' : 'provider_disconnect' });
    });

    browserSocket.on('message', (data, isBinary) => {
      if (finalized || isBinary || !providerReady || publicPolicyBlock(policy())) return void finalize({ confirmed: false, reason: isBinary ? 'unexpected_binary' : 'client_order_or_policy' });
      const observed = Date.now();
      if (observed - eventWindowAt >= 1_000) { eventWindowAt = observed; eventCount = 0; }
      eventCount += 1;
      if (eventCount > MAX_EVENTS_PER_SECOND) return void finalize({ confirmed: false, reason: 'rate_limit' });
      const raw = data.toString('utf8');
      const message = jsonObject(raw);
      const accepted = validBrowserEvent(message);
      if (!accepted) return void finalize({ confirmed: false, reason: 'client_contract_invalid' });
      if (accepted.clean) {
        cleanRequested = true;
        if (providerSocket.readyState === WebSocket.OPEN) providerSocket.close(1000);
        return;
      }
      if (accepted.bytes) {
        inputAudioBytes += accepted.bytes;
        if (inputAudioBytes + outputAudioBytes > maxAudioBytes) return void finalize({ confirmed: false, reason: 'audio_quota_limit' });
      }
      if (accepted.toolOutput) {
        const call = providerCalls.get(accepted.toolOutput.callId);
        if (!call?.authorizedOutput
          || call.authorizedOutput.accepted !== accepted.toolOutput.output.accepted
          || call.authorizedOutput.state !== accepted.toolOutput.output.state) {
          return void finalize({ confirmed: false, reason: 'client_contract_invalid' });
        }
        providerCalls.delete(accepted.toolOutput.callId);
      }
      if (providerSocket.bufferedAmount > MAX_BUFFERED_BYTES) return void finalize({ confirmed: false, reason: 'provider_backpressure' });
      if (providerSocket.readyState === WebSocket.OPEN) providerSocket.send(raw);
    });
    browserSocket.on('error', () => { void finalize({ confirmed: false, reason: 'browser_error' }); });
    browserSocket.on('close', () => { if (!cleanRequested) void finalize({ confirmed: false, reason: 'browser_disconnect' }); });
    await providerHandshake;
  }

  function claimPedagogyCall(username, sessionId, callId, event) {
    const connection = activeBySession.get(sessionKey(username, sessionId));
    const call = connection?.providerCalls.get(String(callId || ''));
    if (!connection?.acceptingToolCalls || !call?.event || call.claimed || call.authorizedOutput
      || JSON.stringify(call.event) !== JSON.stringify(event)) return false;
    call.claimed = true;
    return true;
  }

  function completePedagogyCall(username, sessionId, callId, { state } = {}) {
    const connection = activeBySession.get(sessionKey(username, sessionId));
    const call = connection?.providerCalls.get(String(callId || ''));
    if (!connection?.acceptingToolCalls || !call?.claimed || call.authorizedOutput || !PEDAGOGY_STATES.has(state)) return false;
    call.authorizedOutput = { accepted: true, state };
    return true;
  }

  function failPedagogyCall(username, sessionId, callId) {
    const connection = activeBySession.get(sessionKey(username, sessionId));
    const call = connection?.providerCalls.get(String(callId || ''));
    if (!call?.claimed || call.authorizedOutput) return false;
    call.claimed = false;
    return true;
  }

  async function handleUpgrade(request, socket, head) {
    let url;
    try { url = new URL(request.url, 'http://localhost'); } catch { return rejectUpgrade(socket, 400); }
    if (url.pathname !== '/api/v1/voice-tutor/realtime' || url.search) return rejectUpgrade(socket, 404);
    if (!accepting) return rejectUpgrade(socket, 503);
    const remoteAddress = clientIp(request);
    if (!consumeWindow(ipWindows, rateWindowKey('ip', remoteAddress), ipUpgradeLimit)) return rejectUpgrade(socket, 429);
    if (!sameOriginUpgrade(request)) return rejectUpgrade(socket, 403);
    const ticket = ticketFromProtocols(request.headers['sec-websocket-protocol']);
    if (!ticket) return rejectUpgrade(socket, 401);
    if (pendingHandshakes >= handshakeLimit) return rejectUpgrade(socket, 429);
    pendingHandshakes += 1;
    pendingUpgradeSockets.add(socket);
    let username = null;
    let userSlot = false;
    let released = false;
    let browserSocket = null;
    let handshakeExpired = false;
    let handshakeTimer = null;
    const releaseHandshake = () => {
      if (released) return;
      released = true;
      clearTimeout(handshakeTimer);
      pendingUpgradeSockets.delete(socket);
      pendingHandshakes = Math.max(0, pendingHandshakes - 1);
      if (userSlot && username) {
        const remaining = Math.max(0, Number(userHandshakes.get(username) || 0) - 1);
        if (remaining) userHandshakes.set(username, remaining);
        else userHandshakes.delete(username);
      }
    };
    handshakeTimer = setTimeout(() => {
      handshakeExpired = true;
      releaseHandshake();
      try {
        if (browserSocket && browserSocket.readyState !== WebSocket.CLOSED) browserSocket.terminate();
        else if (!socket.destroyed) socket.destroy();
      } catch {}
    }, handshakeTimeout);
    handshakeTimer.unref?.();
    try {
      const authenticated = await authentication.authenticateRequest(request).catch(() => null);
      if (handshakeExpired || socket.destroyed) return;
      if (!authenticated) {
        releaseHandshake();
        return rejectUpgrade(socket, 401);
      }
      username = String(authenticated.username || '');
      const concurrentForUser = Number(userHandshakes.get(username) || 0);
      if (!username || concurrentForUser >= userHandshakeLimit
        || !consumeWindow(userWindows, rateWindowKey('user', username), userUpgradeLimit)) {
        releaseHandshake();
        return rejectUpgrade(socket, 429);
      }
      userHandshakes.set(username, concurrentForUser + 1);
      userSlot = true;
      wss.handleUpgrade(request, socket, head, (acceptedSocket) => {
        browserSocket = acceptedSocket;
        if (handshakeExpired) {
          try { acceptedSocket.terminate(); } catch {}
          return;
        }
        void handleBrowser(acceptedSocket, authenticated, ticket).finally(releaseHandshake);
      });
    } catch {
      releaseHandshake();
      if (!socket.destroyed) socket.destroy();
    }
  }

  function attach(server) {
    const listener = (request, socket, head) => { void handleUpgrade(request, socket, head); };
    server.on('upgrade', listener);
    return () => server.off('upgrade', listener);
  }

  async function waitForSettlement(username, sessionId, { timeoutMs = 2_500 } = {}) {
    const connection = activeBySession.get(sessionKey(username, sessionId));
    if (!connection) return true;
    let timer;
    const timedOut = new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), Math.max(1, Math.min(5_000, Number(timeoutMs) || 2_500)));
      timer.unref?.();
    });
    const settled = await Promise.race([connection.settlement, timedOut]);
    clearTimeout(timer);
    return settled;
  }

  async function close({ timeoutMs = 2_500 } = {}) {
    accepting = false;
    clearInterval(rateLimitCleanupTimer);
    for (const socket of pendingUpgradeSockets) {
      try { if (!socket.destroyed) socket.destroy(); } catch {}
    }
    const boundedTimeout = Math.max(25, Math.min(5_000, Number(timeoutMs) || 2_500));
    const connections = [...active];
    const finalized = Promise.allSettled(connections.map((connection) => connection.finalize({
      confirmed: false,
      reason: 'server_shutdown',
    })));
    for (const client of wss.clients) {
      if (!connections.some((connection) => connection.browserSocket === client)) {
        try { client.terminate(); } catch {}
      }
    }
    await Promise.race([finalized, wait(boundedTimeout)]);
    for (const connection of connections) {
      try { if (connection.browserSocket.readyState !== WebSocket.CLOSED) connection.browserSocket.terminate(); } catch {}
      try { if (connection.providerSocket.readyState !== WebSocket.CLOSED) connection.providerSocket.terminate(); } catch {}
    }
    for (const client of wss.clients) {
      try { if (client.readyState !== WebSocket.CLOSED) client.terminate(); } catch {}
    }
    await Promise.race([
      new Promise((resolve) => wss.close(() => resolve())),
      wait(boundedTimeout),
    ]);
  }

  return Object.freeze({
    attach,
    close,
    waitForSettlement,
    claimPedagogyCall,
    completePedagogyCall,
    failPedagogyCall,
    activeCount: () => active.size,
    rateLimitState: () => ({ ipEntries: ipWindows.size, userEntries: userWindows.size }),
  });
}
