import { normalizeTutorAnswer } from './state-machine.js';

export function practicePromptKey(value) {
  return normalizeTutorAnswer(value);
}

export function maskAcceptedAnswers(example, reference) {
  return [...reference]
    .sort((left, right) => right.length - left.length)
    .reduce((text, answer) => {
      const escaped = String(answer).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
      if (!escaped) return text;
      return text.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?:es|s|ed|d|ing)?(?![\\p{L}\\p{N}])`, 'giu'), '_____');
    }, String(example || ''));
}

function lexemeReference(word) {
  return [...new Set([String(word.w), String(word.w).replace(/^to\s+/iu, '')].filter(Boolean))];
}

function peerPriority(target, candidate) {
  if (candidate.t === target.t && candidate.p === target.p) return 0;
  if (candidate.t === target.t) return 1;
  if (candidate.p === target.p) return 2;
  return 3;
}

function answerPositionSeed(value) {
  let seed = 0;
  for (const character of practicePromptKey(value)) seed = (seed * 31 + character.codePointAt(0)) % 4;
  return seed;
}

function authoredVocabularyContexts(target, contexts) {
  const reference = lexemeReference(target);
  const sourceKey = practicePromptKey(maskAcceptedAnswers(target.ex, reference));
  const seen = new Set([sourceKey]);
  const result = [];
  for (const example of contexts) {
    const context = maskAcceptedAnswers(example, reference);
    const key = practicePromptKey(context);
    if (!context.includes('_____') || !key || seen.has(key)) continue;
    seen.add(key);
    result.push(`Новый пример: «${context}».`);
  }
  return result;
}

export function vocabularyTargetCandidates(words, target, contexts = [], limit = 4) {
  const peers = words
    .map((candidate, index) => ({ candidate, index }))
    .filter(({ candidate }) => candidate !== target
      && String(candidate.w).toLocaleLowerCase() !== String(target.w).toLocaleLowerCase()
      && String(candidate.tr).toLocaleLowerCase() !== String(target.tr).toLocaleLowerCase())
    .sort((left, right) => peerPriority(target, left.candidate) - peerPriority(target, right.candidate)
      || left.index - right.index);
  const distractors = [];
  for (const { candidate } of peers) {
    distractors.push(candidate);
    if (distractors.length === 3) break;
  }
  if (distractors.length < 3) return [];
  const taskContexts = authoredVocabularyContexts(target, contexts);
  if (taskContexts.length < limit) return [];
  const targetReference = lexemeReference(target);
  const startPosition = answerPositionSeed(`${target.w}:${target.tr}`);
  return taskContexts.slice(0, limit).map((context, index) => {
    const correctPosition = (startPosition + index) % 4;
    const remaining = [...distractors];
    const options = [];
    for (let optionIndex = 0; optionIndex < 4; optionIndex += 1) {
      options.push(optionIndex === correctPosition ? target : remaining.shift());
    }
    const renderedOptions = options.map((option, optionIndex) => `${'ABCD'[optionIndex]} — ${option.w}`).join('; ');
    const answer = 'abcd'[correctPosition];
    return {
      prompt: `${context} Какая лексема подходит по смыслу: ${renderedOptions}?`,
      reference: [...targetReference, answer, `вариант ${answer}`],
    };
  });
}
