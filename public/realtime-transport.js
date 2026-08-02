const browser = globalThis.window || globalThis;
const MAX_EVENT_CHARS = 524_288;
const MAX_TOOL_ARGUMENT_CHARS = 512;
const PEDAGOGICAL_EVENTS = new Set(['diagnosis_complete', 'explanation_complete', 'check_answer', 'transfer_answer']);

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

export function createBrowserRealtimeTransport({
  webSocketFactory = (url, protocols) => new browser.WebSocket(url, protocols),
  audioContextFactory = () => new (browser.AudioContext || browser.webkitAudioContext)({ sampleRate: 24_000 }),
} = {}) {
  return Object.freeze({
    async connect({ stream, credential, url, onSubtitle = () => {}, onStatus = () => {}, onPedagogicalEvent = null }) {
      const sessionCredential = String(credential || '');
      if (!stream || !/^wss:\/\//u.test(String(url || '')) || !sessionCredential || sessionCredential.length > 2_048) {
        throw new Error('VOICE_TUTOR_REALTIME_INVALID');
      }
      const socket = webSocketFactory(String(url), [
        'realtime',
        `openai-insecure-api-key.${sessionCredential}`,
        'openai-beta.realtime-v1',
      ]);
      const audioContext = audioContextFactory();
      let source = null;
      let processor = null;
      let silentGain = null;
      let closed = false;
      let playbackAt = 0;

      function send(value) {
        if (socket.readyState === 1 && !closed) socket.send(JSON.stringify(value));
      }

      function playPcm(value) {
        if (!value || typeof browser.atob !== 'function' || typeof audioContext.createBuffer !== 'function') return;
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
        output.start(playbackAt);
        playbackAt += buffer.duration;
      }

      async function handleToolCall(message) {
        if (message.name !== 'advance_pedagogy' || typeof onPedagogicalEvent !== 'function') return;
        const event = parsePedagogicalToolEvent(message.arguments);
        if (!event) return;
        try {
          const result = await onPedagogicalEvent(event);
          const output = JSON.stringify({ state: result?.session?.state || null, accepted: true });
          send({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: String(message.call_id || ''), output } });
          send({ type: 'response.create' });
        } catch {
          send({
            type: 'conversation.item.create',
            item: { type: 'function_call_output', call_id: String(message.call_id || ''), output: JSON.stringify({ accepted: false }) },
          });
          send({ type: 'response.create' });
        }
      }

      socket.onmessage = (event) => {
        const raw = typeof event.data === 'string' ? event.data : '';
        if (!raw || raw.length > MAX_EVENT_CHARS) return;
        let message;
        try { message = JSON.parse(raw); } catch { return; }
        if (['response.audio_transcript.delta', 'response.output_audio_transcript.delta', 'conversation.item.input_audio_transcription.completed'].includes(message.type)) {
          const caption = String(message.delta || message.transcript || '').slice(0, 1_000);
          if (caption) onSubtitle(caption);
        }
        if (message.type === 'response.audio.delta' || message.type === 'response.output_audio.delta') playPcm(message.delta);
        if (message.type === 'response.function_call_arguments.done') void handleToolCall(message);
        if (message.type === 'error') onStatus('Voice API временно недоступен.');
      };

      await new Promise((resolve, reject) => {
        socket.onerror = () => reject(new Error('VOICE_TUTOR_REALTIME_UNAVAILABLE'));
        socket.onopen = () => {
          source = audioContext.createMediaStreamSource(stream);
          processor = audioContext.createScriptProcessor(4_096, 1, 1);
          silentGain = audioContext.createGain();
          silentGain.gain.value = 0;
          processor.onaudioprocess = (audioEvent) => {
            const samples = audioEvent.inputBuffer?.getChannelData?.(0);
            if (samples) send({ type: 'input_audio_buffer.append', audio: floatAudioToBase64(samples) });
          };
          source.connect(processor);
          processor.connect(silentGain);
          silentGain.connect(audioContext.destination);
          onStatus('Голосовой репетитор подключён.');
          resolve();
        };
      });

      return Object.freeze({
        close() {
          if (closed) return;
          closed = true;
          processor?.disconnect?.();
          source?.disconnect?.();
          silentGain?.disconnect?.();
          socket.close();
          void audioContext.close?.();
        },
      });
    },
  });
}

export const browserRealtimeTransport = createBrowserRealtimeTransport();
