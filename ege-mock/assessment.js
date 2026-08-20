import { getEgeMockForm } from './catalog.js';

function invalid(details) {
  throw new TypeError(`EGE_MOCK_ANSWER_INVALID: ${details}`);
}

function canonicalChoice(value) {
  const result = (Number.isSafeInteger(value) ? String(value) : String(value ?? ''))
    .normalize('NFKC').trim().toLocaleLowerCase('en');
  if (!/^[a-z0-9]+(?:_[a-z0-9]+)*$/u.test(result) || result.length > 40) {
    invalid('choice must be a bounded option id');
  }
  return result;
}

function canonicalText(value) {
  if (typeof value !== 'string') invalid('text answer must be a string');
  const result = value.normalize('NFKC').trim().toLocaleLowerCase('en').replace(/\s+/gu, ' ');
  if (!result || result.length > 100 || !/^[a-z]+(?:[ '-][a-z]+)*$/u.test(result)) {
    invalid('text answer contains unsupported characters');
  }
  return result;
}

function allowedChoiceIds(item) {
  if (Array.isArray(item.presentation.options)) {
    return new Set(item.presentation.options.map(({ id }) => String(id)));
  }
  if (item.presentation.kind === 'listening_matching') {
    return new Set(item.presentation.statements.map((_, index) => String(index + 1)));
  }
  return new Set();
}

function resultForScalar(canonical, accepted) {
  const correctness = accepted.includes(canonical);
  return Object.freeze({ canonical, correctness, correctCount: correctness ? 1 : 0, isAccepted: correctness });
}

export function normalizeEgeMockAnswer({
  formId, formRevision, position, value, allowIncomplete = false,
}) {
  const form = getEgeMockForm(formId, formRevision);
  const item = form?.positions?.find((candidate) => candidate.position === Number(position));
  if (!item) invalid('form or position is unknown');
  const { assessment } = item;
  if (assessment.type === 'provisional') {
    throw new TypeError(`EGE_MOCK_ANSWER_NOT_OBJECTIVE: position ${item.position}`);
  }
  if (assessment.type === 'short_text') {
    return resultForScalar(canonicalText(value), assessment.accepted.map(canonicalText));
  }
  if (assessment.type === 'single_choice') {
    const canonical = canonicalChoice(value);
    if (!allowedChoiceIds(item).has(canonical)) invalid('choice id is not offered at this position');
    return resultForScalar(canonical, assessment.accepted.map(canonicalChoice));
  }
  if (assessment.type !== 'ordered_choice_list' || !Array.isArray(value)
    || value.length !== assessment.accepted.length) {
    invalid('ordered answer has the wrong shape');
  }
  const allowed = allowedChoiceIds(item);
  const canonical = value.map((entry) => (allowIncomplete === true
    && (entry == null || (typeof entry === 'string' && entry.trim() === ''))
    ? null : canonicalChoice(entry)));
  if (canonical.some((choice) => choice != null && !allowed.has(choice))) {
    invalid('ordered answer contains an unknown choice');
  }
  const provided = canonical.filter((choice) => choice != null);
  if (item.presentation.kind !== 'listening_true_false'
    && new Set(provided).size !== provided.length) {
    invalid('ordered answer must not repeat a choice');
  }
  const expected = assessment.accepted.map(canonicalChoice);
  const correctness = canonical.map((choice, index) => choice === expected[index]);
  const correctCount = correctness.filter(Boolean).length;
  return Object.freeze({
    canonical: Object.freeze(canonical),
    correctness: Object.freeze(correctness),
    correctCount,
    isAccepted: correctCount === expected.length,
  });
}
