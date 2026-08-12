export const GRAMMAR_ERROR_CODES = Object.freeze([
  'construction_choice', 'word_or_verb_form', 'auxiliary', 'agreement',
  'word_order', 'negation_or_question', 'confusion_pair',
]);

export const GRAMMAR_ACTIVE_PRACTICE_TYPES = Object.freeze([
  'choice', 'input', 'correction', 'transform',
]);

export const GENERATED_GRAMMAR_REVISION = 1;

const GENERATED_GRAMMAR_ITEM_ID = /^generated\.g\.q\.([a-f0-9]{64})\.([a-f0-9]{16})\.(c|f)([1-9]\d*)$/u;
const GRAMMAR_CONFUSION_PAIR = /^[a-z0-9]+(?:_[a-z0-9]+)*__(?:[a-z0-9]+(?:_[a-z0-9]+)*)$/u;

export function isGrammarErrorCode(value) {
  return GRAMMAR_ERROR_CODES.includes(value);
}

export function isGrammarConfusionPair(value) {
  return typeof value === 'string' && GRAMMAR_CONFUSION_PAIR.test(value);
}

export function parseGrammarConfusionPair(value) {
  if (value == null) return null;
  const normalized = String(value).trim();
  return isGrammarConfusionPair(normalized) ? normalized : null;
}

export function parseGeneratedGrammarItemId(value) {
  const match = GENERATED_GRAMMAR_ITEM_ID.exec(String(value || ''));
  if (!match) return null;
  const kind = match[3];
  return Object.freeze({
    id: match[0],
    groupId: `generated.g.q.${match[1]}.${match[2]}`,
    requestHash: match[1],
    resultDigest: match[2],
    kind,
    index: Number(match[4]),
    type: kind === 'c' ? 'choice' : 'input',
    revision: GENERATED_GRAMMAR_REVISION,
  });
}

export function parseGeneratedGrammarItemReference(value) {
  const parsed = parseGeneratedGrammarItemId(value?.id);
  return parsed && Number(value?.revision) === GENERATED_GRAMMAR_REVISION ? parsed : null;
}

export const EasyBoostGrammarDomain = Object.freeze({
  GRAMMAR_ERROR_CODES,
  GRAMMAR_ACTIVE_PRACTICE_TYPES,
  GENERATED_GRAMMAR_REVISION,
  isGrammarConfusionPair,
  isGrammarErrorCode,
  parseGrammarConfusionPair,
  parseGeneratedGrammarItemId,
  parseGeneratedGrammarItemReference,
});

if (typeof globalThis !== 'undefined') globalThis.EasyBoostGrammarDomain = EasyBoostGrammarDomain;
