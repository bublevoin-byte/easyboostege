import { decorateGeneratedVoiceTutorContent } from '../voice-tutor/generated-items.js';
import { GENERATED_GRAMMAR_REVISION, parseGeneratedGrammarItemId } from '../public/grammar-domain-contract.js';

export class GeneratedGrammarReferenceError extends Error {
  constructor() {
    super('INVALID_GENERATED_GRAMMAR_REFERENCE');
    this.code = 'INVALID_GENERATED_GRAMMAR_REFERENCE';
  }
}

export function generatedGrammarReference(item) {
  const parsed = parseGeneratedGrammarItemId(item?.id);
  if (!parsed) return null;
  return Object.freeze({
    ...parsed, revision: Number(item?.revision),
  });
}

export async function assertGeneratedGrammarMasteryReferences(topicId, event, loadTask) {
  if (event?.type !== 'session_completed') return;
  const references = (event.session?.items || []).map(generatedGrammarReference).filter(Boolean);
  if (!references.length) return;
  const byRequest = new Map();
  for (const reference of references) {
    if (reference.revision !== GENERATED_GRAMMAR_REVISION) throw new GeneratedGrammarReferenceError();
    if (!byRequest.has(reference.requestHash)) byRequest.set(reference.requestHash, []);
    byRequest.get(reference.requestHash).push(reference);
  }
  for (const [requestHash, requestReferences] of byRequest) {
    const stored = await loadTask(requestHash);
    if (stored?.operation !== 'grammar_topic_set' || Number(stored.request?.topicId) !== Number(topicId)) {
      throw new GeneratedGrammarReferenceError();
    }
    const decorated = decorateGeneratedVoiceTutorContent(stored.operation, requestHash, stored.result);
    const items = [
      ...(decorated?.c || []).map((item) => ({ id: item.voice?.id, revision: item.voice?.revision, type: 'choice' })),
      ...(decorated?.f || []).map((item) => ({ id: item.voice?.id, revision: item.voice?.revision, type: 'input' })),
    ];
    for (const reference of requestReferences) {
      const resolved = items.find((item) => item.id === reference.id);
      if (!resolved || resolved.revision !== reference.revision || resolved.type !== reference.type) {
        throw new GeneratedGrammarReferenceError();
      }
    }
  }
}
