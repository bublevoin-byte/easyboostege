import crypto from 'node:crypto';
import { createContextVoiceTutorItem } from './canonical-items.js';

const GENERATED_CONTEXT_OPERATIONS = Object.freeze({
  reading_questions: Object.freeze({ module: 'reading' }),
  listening_interview: Object.freeze({ module: 'listening' }),
});

const OPERATION_BY_MODULE = Object.freeze(Object.fromEntries(
  Object.entries(GENERATED_CONTEXT_OPERATIONS).map(([operation, descriptor]) => [descriptor.module, operation]),
));

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function resultDigest(data) {
  return crypto.createHash('sha256').update(canonicalJson(data)).digest('hex').slice(0, 32);
}

function generatedMetadata(operation, requestHash, data) {
  const descriptor = GENERATED_CONTEXT_OPERATIONS[operation];
  const hash = String(requestHash || '');
  if (!descriptor || !/^[a-f0-9]{64}$/u.test(hash) || !data || typeof data !== 'object' || Array.isArray(data)) return null;
  const setId = `generated.${descriptor.module}.${hash}.${resultDigest(data)}`;
  return Object.freeze({
    set_id: setId,
    revision: 1,
    item_ids: Object.freeze(Array.from({ length: 4 }, (_, index) => `${setId}.${index + 1}`)),
  });
}

export function decorateGeneratedVoiceTutorContent(operation, requestHash, data) {
  const voiceTutor = generatedMetadata(operation, requestHash, data);
  if (!voiceTutor || !data || typeof data !== 'object' || Array.isArray(data)) return data;
  return { ...data, voice_tutor: voiceTutor };
}

export function parseGeneratedVoiceTutorSetId(setId, module) {
  const match = /^generated\.(reading|listening)\.([a-f0-9]{64})\.([a-f0-9]{32})$/u.exec(String(setId || ''));
  if (!match || match[1] !== module) return null;
  return { operation: OPERATION_BY_MODULE[module], requestHash: match[2], resultDigest: match[3] };
}

export function buildGeneratedVoiceTutorDefinitions(operation, requestHash, data) {
  const descriptor = GENERATED_CONTEXT_OPERATIONS[operation];
  const metadata = generatedMetadata(operation, requestHash, data);
  if (!descriptor || !metadata || !Array.isArray(data?.qs) || data.qs.length !== metadata.item_ids.length) return null;
  const items = new Map(data.qs.map((question, index) => {
    const item = createContextVoiceTutorItem({
      id: metadata.item_ids[index],
      module: descriptor.module,
      prompt: question.q,
      options: question.o,
      answer: question.a,
      evidence: question.ev,
      explanation: question.e,
    });
    return [item.id, item];
  }));
  return Object.freeze({
    resultSet: Object.freeze({
      id: metadata.set_id,
      revision: metadata.revision,
      module: descriptor.module,
      items: metadata.item_ids,
    }),
    getItem(itemId) {
      return items.get(String(itemId || '')) || null;
    },
  });
}
