const browser = globalThis.window || globalThis;
const MAX_EVENT_BYTES = 262_144;
const MAX_AUDIO_DELTA_CHARS = 131_072;
const MAX_TOOL_ARGUMENT_CHARS = 512;
const MAX_TOOL_CALL_ID_CHARS = 128;
const MAX_SESSION_BYTES = 81_920;
const MAX_INSTRUCTION_BYTES = 65_536;
const PEDAGOGICAL_EVENTS = new Set(['diagnosis_complete', 'explanation_complete', 'check_answer', 'transfer_answer']);
const SAFE_CALL_ID = /^[A-Za-z0-9._:-]{1,128}$/u;
const SAFE_CREDENTIAL = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,2048}$/u;
const SAFE_VOICE = /^[a-z][a-z0-9_-]{0,63}$/u;
const MAX_TOOL_CALLS_PER_RESPONSE = 4;
const PASSIVE_SERVER_EVENTS = new Set([
  'session.created', 'conversation.created', 'conversation.item.created',
  'input_audio_buffer.committed', 'input_audio_buffer.cleared', 'input_audio_buffer.speech_stopped',
  'rate_limits.updated', 'response.content_part.added', 'response.content_part.done',
  'response.audio.done', 'response.output_audio.done',
  'response.audio_transcript.done', 'response.output_audio_transcript.done',
]);
const INVALID_STREAM_MESSAGE = 'Voice API прислал недопустимый поток. Переключаемся на безопасный режим.';

function bytesToBase64(bytes) {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index]);
  return browser.btoa(binary);
}

function floatAudioToBase64(samples) {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < samples.length; index += 1) {
    const value = Math.max(-1, Math.min(1, samples[index]));
    view.setInt16(index * 2, value < 0 ? value * 0x8000 : value * 0x7fff, true);
  }
  return bytesToBase64(bytes);
}

function parsePedagogicalToolEvent(value) {
  const raw = String(value || '');
  if (!raw || raw.length > MAX_TOOL_ARGUMENT_CHARS) return null;
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return null; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const keys = Object.keys(parsed);
  if (keys.some((key) => !['type', 'answer'].includes(key)) || !PEDAGOGICAL_EVENTS.has(parsed.type)) return null;
  const requiresAnswer = parsed.type === 'check_answer' || parsed.type === 'transfer_answer';
  if (requiresAnswer !== keys.includes('answer')) return null;
  if (requiresAnswer && (typeof parsed.answer !== 'string' || parsed.answer.length > 200)) return null;
  return { type: parsed.type, ...(requiresAnswer ? { answer: parsed.answer } : {}) };
}

function boundedSessionConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const allowedKeys = ['voice', 'instructions', 'tools', 'turn_detection'];
  const keys = Object.keys(value);
  if (keys.length !== allowedKeys.length || keys.some((key) => !allowedKeys.includes(key))) return null;
  if (!SAFE_VOICE.test(value.voice) || typeof value.instructions !== 'string' || !value.instructions) return null;
  const instructionBytes = new TextEncoder().encode(value.instructions).byteLength;
  if (instructionBytes > MAX_INSTRUCTION_BYTES || !Array.isArray(value.tools) || value.tools.length !== 1
    || !value.turn_detection || typeof value.turn_detection !== 'object' || Array.isArray(value.turn_detection)
    || value.turn_detection.type !== 'server_vad' || Object.keys(value.turn_detection).length !== 1) return null;
  const tool = value.tools[0];
  if (!tool || typeof tool !== 'object' || Array.isArray(tool)
    || Object.keys(tool).length !== 4
    || Object.keys(tool).some((key) => !['type', 'name', 'description', 'parameters'].includes(key))
    || tool.type !== 'function' || tool.name !== 'advance_pedagogy'
    || typeof tool.description !== 'string' || !tool.description || tool.description.length > 500
    || !tool.parameters || typeof tool.parameters !== 'object' || Array.isArray(tool.parameters)) return null;
  const parameters = tool.parameters;
  const properties = parameters.properties;
  const typeSchema = properties?.type;
  const answerSchema = properties?.answer;
  if (Object.keys(parameters).length !== 4 || parameters.type !== 'object'
    || !properties || typeof properties !== 'object' || Array.isArray(properties)
    || Object.keys(properties).length !== 2 || !typeSchema || !answerSchema
    || typeSchema.type !== 'string' || !Array.isArray(typeSchema.enum)
    || typeSchema.enum.length !== PEDAGOGICAL_EVENTS.size
    || typeSchema.enum.some((eventType) => !PEDAGOGICAL_EVENTS.has(eventType))
    || answerSchema.type !== 'string' || answerSchema.maxLength !== 200
    || !Array.isArray(parameters.required) || parameters.required.length !== 1 || parameters.required[0] !== 'type'
    || parameters.additionalProperties !== false) return null;
  let encoded;
  try { encoded = JSON.stringify(value); } catch { return null; }
  if (!encoded || new TextEncoder().encode(encoded).byteLength > MAX_SESSION_BYTES) return null;
  return JSON.parse(encoded);
}

export function createBrowserRealtimeTransport({
  webSocketFactory = (url, protocols) => new browser.WebSocket(url, protocols),
  audioContextFactory = () => new (browser.AudioContext || browser.webkitAudioContext)({ sampleRate: 24_000 }),
  now = () => Date.now(),
  maxEventsPerSecond = 120,
  ackTimeoutMs = 10_000,
  setTimeoutImpl = (callback, delay) => browser.setTimeout(callback, delay),
  clearTimeoutImpl = (timer) => browser.clearTimeout(timer),
} = {}) {
  return Object.freeze({
    async connect({
      stream, credential, url, session, onSubtitle = () => {}, onStatus = () => {},
      onPedagogicalEvent = null, onFailure = () => {},
    }) {
      const sessionCredential = String(credential || '');
      const configuredSession = boundedSessionConfig(session);
      if (!stream || !/^wss:\/\//u.test(String(url || '')) || !SAFE_CREDENTIAL.test(sessionCredential) || !configuredSession
        || !Number.isInteger(ackTimeoutMs) || ackTimeoutMs < 1 || ackTimeoutMs > 30_000) {
        throw new Error('VOICE_TUTOR_REALTIME_INVALID');
      }
      const socket = webSocketFactory(String(url), [`xai-client-secret.${sessionCredential}`]);
      let audioContext = null;
      let source = null;
      let processor = null;
      let silentGain = null;
      let closed = false;
      let playbackAt = 0;
      let responseOpen = false;
      let activeResponseId = null;
      let activeAssistantItemId = null;
      let responseAudioStartedAt = null;
      let activeResponse = null;
      let sessionAcknowledged = false;
      let sessionConfigured = false;
      let intentionalClose = false;
      let connectSettled = false;
      let resolveConnect;
      let rejectConnect;
      let ackTimer = null;
      let eventWindowStartedAt = now();
      let eventCount = 0;
      const seenResponseIds = new Set();
      const seenItemIds = new Set();
      const seenCallIds = new Set();
      const interruptedResponseIds = new Set();
      const activeOutputs = new Set();
      const connected = new Promise((resolve, reject) => {
        resolveConnect = resolve;
        rejectConnect = reject;
      });

      function send(value) {
        if (socket.readyState === 1 && !closed) socket.send(JSON.stringify(value));
      }

      function cleanup() {
        if (closed) return;
        closed = true;
        if (ackTimer != null) clearTimeoutImpl(ackTimer);
        ackTimer = null;
        processor?.disconnect?.();
        source?.disconnect?.();
        silentGain?.disconnect?.();
        for (const output of activeOutputs) {
          try { output.stop(); } catch {}
          try { output.disconnect?.(); } catch {}
        }
        activeOutputs.clear();
        try { socket.close(); } catch {}
        try {
          const closing = audioContext?.close?.();
          closing?.catch?.(() => {});
        } catch {}
      }

      function fail() {
        if (closed || intentionalClose) return;
        const configured = sessionConfigured;
        cleanup();
        if (!connectSettled) {
          connectSettled = true;
          rejectConnect(new Error('VOICE_TUTOR_REALTIME_UNAVAILABLE'));
        } else if (configured) {
          try { onFailure('VOICE_TUTOR_PROVIDER_UNAVAILABLE'); } catch {}
        }
      }

      function closeInvalidStream() {
        if (closed) return;
        onStatus(INVALID_STREAM_MESSAGE);
        fail();
      }

      function acceptsEvent(raw) {
        if (closed || typeof raw !== 'string' || !raw) return false;
        if (new TextEncoder().encode(raw).byteLength > MAX_EVENT_BYTES) {
          closeInvalidStream();
          return false;
        }
        const observedAt = now();
        if (observedAt - eventWindowStartedAt >= 1_000) {
          eventWindowStartedAt = observedAt;
          eventCount = 0;
        }
        eventCount += 1;
        if (!Number.isInteger(maxEventsPerSecond) || maxEventsPerSecond < 1 || eventCount > maxEventsPerSecond) {
          closeInvalidStream();
          return false;
        }
        return true;
      }

      function playPcm(value) {
        if (!responseOpen || !value || typeof browser.atob !== 'function' || typeof audioContext.createBuffer !== 'function') return;
        let binary;
        try { binary = browser.atob(value); } catch { return; }
        const sampleCount = Math.floor(binary.length / 2);
        const buffer = audioContext.createBuffer(1, sampleCount, 24_000);
        const channel = buffer.getChannelData(0);
        for (let index = 0; index < sampleCount; index += 1) {
          const low = binary.charCodeAt(index * 2);
          const high = binary.charCodeAt(index * 2 + 1);
          const signed = (high << 8) | low;
          channel[index] = (signed & 0x8000 ? signed - 0x10000 : signed) / 0x8000;
        }
        const output = audioContext.createBufferSource();
        output.buffer = buffer;
        output.connect(audioContext.destination);
        playbackAt = Math.max(audioContext.currentTime || 0, playbackAt);
        if (responseAudioStartedAt == null) responseAudioStartedAt = audioContext.currentTime || 0;
        output.start(playbackAt);
        playbackAt += buffer.duration;
        activeOutputs.add(output);
        output.onended = () => activeOutputs.delete(output);
      }

      function interruptAssistant() {
        if (!responseOpen || !activeResponseId || activeResponse?.phase !== 'streaming'
          || interruptedResponseIds.has(activeResponseId)) return;
        interruptedResponseIds.add(activeResponseId);
        for (const output of activeOutputs) {
          try { output.stop(); } catch {}
          try { output.disconnect?.(); } catch {}
        }
        activeOutputs.clear();
        playbackAt = audioContext?.currentTime || 0;
        send({ type: 'response.cancel' });
        if (activeAssistantItemId) {
          const elapsed = Math.max(0, Math.min(60_000, Math.round(((audioContext?.currentTime || 0) - (responseAudioStartedAt || 0)) * 1_000)));
          send({
            type: 'conversation.item.truncate', item_id: activeAssistantItemId,
            content_index: 0, audio_end_ms: elapsed,
          });
        }
        responseOpen = false;
        activeResponse.phase = 'awaiting_cancel';
        activeAssistantItemId = null;
        responseAudioStartedAt = null;
      }

      async function completeToolResponse(response) {
        const outputs = [];
        for (const call of response.calls) {
          let output;
          try {
            const result = await onPedagogicalEvent(call.event);
            output = JSON.stringify({ state: result?.session?.state || null, accepted: true });
          } catch {
            output = JSON.stringify({ accepted: false });
          }
          outputs.push({ callId: call.callId, output });
        }
        if (closed || activeResponse !== response || response.phase !== 'processing') return;
        for (const result of outputs) {
          send({
            type: 'conversation.item.create',
            item: { type: 'function_call_output', call_id: result.callId, output: result.output },
          });
        }
        if (closed || activeResponse !== response) return;
        response.phase = 'awaiting_continuation';
        send({ type: 'response.create' });
      }

      function lifecycleId(message, field = 'response_id') {
        const value = message[field];
        return typeof value === 'string' && SAFE_CALL_ID.test(value) ? value : null;
      }

      function matchesActiveResponse(message) {
        return activeResponse && lifecycleId(message) === activeResponse.id;
      }

      socket.onmessage = (event) => {
        const raw = typeof event.data === 'string' ? event.data : '';
        if (!acceptsEvent(raw)) return;
        let message;
        try { message = JSON.parse(raw); } catch { return closeInvalidStream(); }
        if (!message || typeof message !== 'object' || Array.isArray(message) || Object.keys(message).length > 20
          || typeof message.type !== 'string' || message.type.length > 100) return closeInvalidStream();
        if (message.type === 'session.updated') {
          if (sessionAcknowledged) return closeInvalidStream();
          if (ackTimer != null) clearTimeoutImpl(ackTimer);
          ackTimer = null;
          sessionAcknowledged = true;
          if (!connectSettled) {
            connectSettled = true;
            resolveConnect();
          }
          return;
        }
        if (message.type === 'error') {
          onStatus('Voice API временно недоступен.');
          fail();
          return;
        }
        if (!sessionConfigured) {
          if (message.type === 'session.created') return;
          return closeInvalidStream();
        }
        if (message.type === 'response.created') {
          const responseId = message.response_id ?? message.response?.id;
          if (typeof responseId !== 'string' || !SAFE_CALL_ID.test(responseId)
            || responseOpen || seenResponseIds.has(responseId) || interruptedResponseIds.has(responseId)
            || (activeResponse && activeResponse.phase !== 'awaiting_continuation')) return closeInvalidStream();
          seenResponseIds.add(responseId);
          activeResponse = {
            id: responseId, phase: 'streaming', items: new Map(), calls: [], callById: new Map(),
          };
          activeResponseId = responseId;
          activeAssistantItemId = null;
          responseAudioStartedAt = null;
          responseOpen = true;
          return;
        }
        if (message.type === 'response.output_item.added') {
          const item = message.item;
          if (!responseOpen || activeResponse?.phase !== 'streaming' || !matchesActiveResponse(message)
            || typeof item?.id !== 'string' || !SAFE_CALL_ID.test(item.id) || seenItemIds.has(item.id)) {
            return closeInvalidStream();
          }
          seenItemIds.add(item.id);
          if (item.type === 'function_call') {
            if (item.name !== 'advance_pedagogy' || typeof item.call_id !== 'string'
              || !SAFE_CALL_ID.test(item.call_id) || item.call_id.length > MAX_TOOL_CALL_ID_CHARS
              || seenCallIds.has(item.call_id) || activeResponse.calls.length >= MAX_TOOL_CALLS_PER_RESPONSE
              || typeof onPedagogicalEvent !== 'function') return closeInvalidStream();
            seenCallIds.add(item.call_id);
            const call = { itemId: item.id, callId: item.call_id, name: item.name, event: null, itemDone: false };
            activeResponse.items.set(item.id, { type: item.type, done: false, callId: item.call_id });
            activeResponse.calls.push(call);
            activeResponse.callById.set(item.call_id, call);
            return;
          }
          if (item.type !== 'message' || item.role !== 'assistant') return closeInvalidStream();
          activeResponse.items.set(item.id, { type: item.type, done: false });
          activeAssistantItemId = item.id;
          return;
        }
        if (message.type === 'input_audio_buffer.speech_started') {
          if (responseOpen) interruptAssistant();
          return;
        }
        if (message.type === 'response.output_item.done') {
          const itemId = lifecycleId(message, 'item_id');
          const item = activeResponse?.items.get(itemId);
          if (!responseOpen || activeResponse?.phase !== 'streaming' || !matchesActiveResponse(message)
            || !item || item.done) return closeInvalidStream();
          item.done = true;
          const call = item.callId ? activeResponse.callById.get(item.callId) : null;
          if (call) call.itemDone = true;
          return;
        }
        if (message.type === 'response.function_call_arguments.delta') {
          const callId = lifecycleId(message, 'call_id');
          const itemId = lifecycleId(message, 'item_id');
          const call = activeResponse?.callById.get(callId);
          if (!responseOpen || activeResponse?.phase !== 'streaming' || !matchesActiveResponse(message)
            || !call || call.itemId !== itemId || call.event || typeof message.delta !== 'string'
            || message.delta.length > MAX_TOOL_ARGUMENT_CHARS) return closeInvalidStream();
          return;
        }
        if (message.type === 'response.function_call_arguments.done') {
          const callId = lifecycleId(message, 'call_id');
          const itemId = lifecycleId(message, 'item_id');
          const call = activeResponse?.callById.get(callId);
          const eventValue = parsePedagogicalToolEvent(message.arguments);
          if (!responseOpen || activeResponse?.phase !== 'streaming' || !matchesActiveResponse(message)
            || !call || call.itemId !== itemId || call.event
            || (message.name != null && message.name !== call.name) || !eventValue) return closeInvalidStream();
          call.event = eventValue;
          return;
        }
        if (message.type === 'response.done') {
          if (!responseOpen || activeResponse?.phase !== 'streaming' || !matchesActiveResponse(message)
            || activeResponse.calls.some((call) => !call.event)) return closeInvalidStream();
          responseOpen = false;
          activeResponseId = null;
          activeAssistantItemId = null;
          responseAudioStartedAt = null;
          if (activeResponse.calls.length) {
            activeResponse.phase = 'processing';
            void completeToolResponse(activeResponse);
          } else {
            activeResponse = null;
          }
          return;
        }
        if (message.type === 'response.cancelled') {
          if (activeResponse?.phase !== 'awaiting_cancel' || !matchesActiveResponse(message)) return closeInvalidStream();
          activeResponse = null;
          activeResponseId = null;
          return;
        }
        if (['response.audio_transcript.delta', 'response.output_audio_transcript.delta', 'conversation.item.input_audio_transcription.completed'].includes(message.type)) {
          if (message.type !== 'conversation.item.input_audio_transcription.completed'
            && (!responseOpen || !matchesActiveResponse(message))) return closeInvalidStream();
          const rawCaption = message.delta || message.transcript || '';
          if (typeof rawCaption !== 'string' || new TextEncoder().encode(rawCaption).byteLength > 4_096) return closeInvalidStream();
          const caption = rawCaption.slice(0, 1_000);
          if (caption) onSubtitle(caption);
          return;
        }
        if (message.type === 'response.audio.delta' || message.type === 'response.output_audio.delta') {
          if (!responseOpen || !matchesActiveResponse(message)) return closeInvalidStream();
          if (typeof message.delta === 'string' && message.delta.length <= MAX_AUDIO_DELTA_CHARS && /^[A-Za-z0-9+/]*={0,2}$/u.test(message.delta)) {
            playPcm(message.delta);
          } else return closeInvalidStream();
          return;
        }
        if (PASSIVE_SERVER_EVENTS.has(message.type)) return;
        return closeInvalidStream();
      };

      socket.onerror = () => fail();
      socket.onclose = () => fail();
      socket.onopen = () => {
        ackTimer = setTimeoutImpl(() => fail(), ackTimeoutMs);
        send({ type: 'session.update', session: configuredSession });
      };

      await connected;

      return Object.freeze({
        activate() {
          if (closed || !sessionAcknowledged) throw new Error('VOICE_TUTOR_REALTIME_UNAVAILABLE');
          if (sessionConfigured) return;
          try {
            audioContext = audioContextFactory();
            source = audioContext.createMediaStreamSource(stream);
            processor = audioContext.createScriptProcessor(4_096, 1, 1);
            silentGain = audioContext.createGain();
            silentGain.gain.value = 0;
            processor.onaudioprocess = (audioEvent) => {
              const samples = audioEvent.inputBuffer?.getChannelData?.(0);
              if (samples && sessionConfigured) send({ type: 'input_audio_buffer.append', audio: floatAudioToBase64(samples) });
            };
            source.connect(processor);
            processor.connect(silentGain);
            silentGain.connect(audioContext.destination);
            sessionConfigured = true;
            onStatus('Голосовой репетитор подключён.');
          } catch {
            fail();
            throw new Error('VOICE_TUTOR_REALTIME_UNAVAILABLE');
          }
        },
        close() {
          if (closed) return;
          intentionalClose = true;
          cleanup();
        },
      });
    },
  });
}

export const browserRealtimeTransport = createBrowserRealtimeTransport();
