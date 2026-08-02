import { operationLimits } from '../ai/operations.js';
import { buildVoiceTutorRealtimeInstructions, VOICE_TUTOR_PROMPT_VERSION } from './prompt.js';

const MAX_PROVIDER_RESPONSE_BYTES = 16_384;
const MAX_BROWSER_SESSION_BYTES = 81_920;
const SAFE_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/u;
const SAFE_VOICE = /^[a-z][a-z0-9_-]{0,63}$/u;
const SAFE_CREDENTIAL = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,2048}$/u;

function realtimeUrlForModel(realtimeUrl, model) {
  try {
    const url = new URL(realtimeUrl);
    if (url.protocol !== 'wss:') throw new Error('invalid protocol');
    url.searchParams.set('model', model);
    return url.toString();
  } catch {
    throw new VoiceTutorProviderError('VOICE_TUTOR_PROVIDER_NOT_CONFIGURED');
  }
}

function browserSessionConfig(capsule, voice) {
  return {
    voice,
    instructions: buildVoiceTutorRealtimeInstructions(capsule),
    tools: [{
      type: 'function',
      name: 'advance_pedagogy',
      description: 'Передать серверу завершение шага или ответ ученика для canonical проверки.',
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
  };
}

export class VoiceTutorProviderError extends Error {
  constructor(code = 'VOICE_TUTOR_PROVIDER_UNAVAILABLE') {
    super(code);
    this.name = 'VoiceTutorProviderError';
    this.code = code;
  }
}

export function createRealtimeFetchTransport({ fetchImpl = globalThis.fetch, timeoutMs = 10_000 } = {}) {
  return async ({ url, method, headers, body }) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetchImpl(url, {
        method,
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch {
      throw new VoiceTutorProviderError();
    } finally {
      clearTimeout(timer);
    }
  };
}

async function readProviderPayload(response) {
  if (!response?.ok) throw new VoiceTutorProviderError();
  const declaredBytes = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declaredBytes) && declaredBytes > MAX_PROVIDER_RESPONSE_BYTES) {
    throw new VoiceTutorProviderError('VOICE_TUTOR_PROVIDER_CONTRACT_INVALID');
  }
  let payload = null;
  if (typeof response.text === 'function') {
    const encoded = await response.text().catch(() => '');
    if (!encoded || new TextEncoder().encode(encoded).byteLength > MAX_PROVIDER_RESPONSE_BYTES) {
      throw new VoiceTutorProviderError('VOICE_TUTOR_PROVIDER_CONTRACT_INVALID');
    }
    try { payload = JSON.parse(encoded); } catch {}
  } else if (typeof response.json === 'function') {
    payload = await response.json().catch(() => null);
  }
  const encoded = JSON.stringify(payload || {});
  if (!payload || new TextEncoder().encode(encoded).byteLength > MAX_PROVIDER_RESPONSE_BYTES) {
    throw new VoiceTutorProviderError('VOICE_TUTOR_PROVIDER_CONTRACT_INVALID');
  }
  return payload;
}

export function createXaiRealtimeCredentialAdapter({
  apiKey,
  endpoint = 'https://api.x.ai/v1/realtime/client_secrets',
  realtimeUrl = 'wss://api.x.ai/v1/realtime',
  model,
  voice,
  ttlSeconds = 60,
  requireZdr = false,
  zdrAttested = false,
  transport = null,
} = {}) {
  const operation = operationLimits('voice_tutor_realtime');
  const providerTransport = transport || createRealtimeFetchTransport({ timeoutMs: operation.timeoutMs });
  const mainKey = String(apiKey || '');
  const pinnedModel = String(model || '');
  const selectedVoice = String(voice || '');
  const ttl = Number(ttlSeconds);

  async function createCredential({ capsule }) {
    if (requireZdr && !zdrAttested) {
      throw new VoiceTutorProviderError('VOICE_TUTOR_ZDR_NOT_CONFIRMED');
    }
    if (!mainKey || !SAFE_MODEL.test(pinnedModel) || !SAFE_VOICE.test(selectedVoice)
      || !Number.isInteger(ttl) || ttl !== 60) {
      throw new VoiceTutorProviderError('VOICE_TUTOR_PROVIDER_NOT_CONFIGURED');
    }
    const session = browserSessionConfig(capsule, selectedVoice);
    if (new TextEncoder().encode(JSON.stringify(session)).byteLength > MAX_BROWSER_SESSION_BYTES) {
      throw new VoiceTutorProviderError('VOICE_TUTOR_PROVIDER_CONTRACT_INVALID');
    }
    const response = await providerTransport({
      url: endpoint,
      method: 'POST',
      headers: { Authorization: `Bearer ${mainKey}` },
      body: {
        expires_after: { seconds: ttl },
      },
    });
    const payload = await readProviderPayload(response);
    const secret = payload.client_secret || payload;
    const credential = String(secret?.value || '');
    const expiresAt = Number(secret?.expires_at);
    if (!SAFE_CREDENTIAL.test(credential) || credential === mainKey || !Number.isFinite(expiresAt)) {
      throw new VoiceTutorProviderError('VOICE_TUTOR_PROVIDER_CONTRACT_INVALID');
    }
    return {
      credential,
      expires_at: expiresAt,
      realtime_url: realtimeUrlForModel(realtimeUrl, pinnedModel),
      session,
    };
  }

  return Object.freeze({
    createCredential,
    provider: 'xai',
    model: pinnedModel,
    promptVersion: VOICE_TUTOR_PROMPT_VERSION,
  });
}
