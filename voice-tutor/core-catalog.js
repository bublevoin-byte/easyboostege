import { CORE_VOICE_CATALOG_SOURCE } from './generated-core-catalog.js';
import { GRAMMAR_CATALOG } from '../public/grammar-catalog.js';
import { maskAcceptedAnswers, practicePromptKey, vocabularyTargetCandidates } from './practice.js';

function cleanHtml(value) {
  return String(value || '')
    .replace(/<br\s*\/?\s*>/giu, ' ')
    .replace(/<[^>]+>/gu, '')
    .replace(/&nbsp;/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function baseWord(word) {
  return String(word || '').replace(/^to\s+/iu, '');
}

function grammarFields(question, kind) {
  if (kind === 'c' || kind === 'c2') {
    return {
      prompt: `${question.t[0]}_____${question.t[1]}`,
      reference: [String(question.o[question.a])],
    };
  }
  return { prompt: String(question.s), reference: question.ans.map(String) };
}

function grammarDomain(topicId) {
  if ([16, 17, 20].includes(Number(topicId))) return { type: 'incorrect_word_formation', skill: 'word_formation' };
  if ([15, 19].includes(Number(topicId))) return { type: 'incorrect_collocation', skill: 'collocation' };
  return { type: 'incorrect_form', skill: 'grammar' };
}

function frozenPractice(id, candidate, skillId) {
  return Object.freeze({ id, skillId, prompt: candidate.prompt, answers: Object.freeze([...candidate.reference]) });
}

function grammarItem({ id, topicId, question, kind, practice }) {
  const fields = grammarFields(question, kind);
  const topic = GRAMMAR_CATALOG.topics[topicId];
  const domain = grammarDomain(topicId);
  const skillId = `ege.${domain.skill}.topic_${topicId}`;
  const itemVersion = `v${question.revision}`;
  const topicVersion = `v${topic.revision}`;
  return Object.freeze({
    id, revision: question.revision, module: 'grammar', prompt: fields.prompt,
    reference: Object.freeze(fields.reference), errorType: domain.type,
    skill: Object.freeze({ id: skillId, label: cleanHtml(topic.n) }),
    rule: Object.freeze({
      id: `core.grammar.topic.${topicId}.${topicVersion}`, revision: topic.revision,
      title: cleanHtml(topic.n), explanation: cleanHtml(topic.th),
      examples: Object.freeze([cleanHtml(question.e), fields.prompt]),
    }),
    microCheck: frozenPractice(`${id}.micro.${itemVersion}`, practice[0], skillId),
    transferTask: frozenPractice(`${id}.transfer.${itemVersion}`, practice[1], skillId),
    recoveryTasks: Object.freeze({
      day1: frozenPractice(`${id}.recovery.day1.${itemVersion}`, practice[2], skillId),
      day7: frozenPractice(`${id}.recovery.day7.${itemVersion}`, practice[3], skillId),
    }),
  });
}

function vocabularyFields(word, mode) {
  if (mode === 'c1') return { prompt: `Выбери точный перевод слова ${word.w}.`, reference: [String(word.tr)] };
  const reference = [...new Set([String(word.w), baseWord(word.w)].filter(Boolean))];
  if (mode === 'c2') return { prompt: `Выбери английское слово для значения «${word.tr}».`, reference };
  return { prompt: `Впиши слово со значением «${word.tr}» в контекст: ${maskAcceptedAnswers(word.ex, reference)}`, reference };
}

function vocabularyDomain(word) {
  return ['ph', 'id'].includes(word.p)
    ? { type: 'incorrect_collocation', skill: 'collocation', label: 'Устойчивое сочетание' }
    : { type: 'incorrect_meaning', skill: 'vocabulary', label: 'Лексика в контексте' };
}

function vocabularyItem({ id, word, mode, practice }) {
  const fields = vocabularyFields(word, mode);
  const domain = vocabularyDomain(word);
  const skillId = `ege.${domain.skill}.lexeme_${id.split('.')[2]}`;
  return Object.freeze({
    id, revision: 1, module: 'vocabulary', prompt: fields.prompt,
    reference: Object.freeze(fields.reference), errorType: domain.type,
    skill: Object.freeze({ id: skillId, label: `${domain.label}: ${word.w}` }),
    rule: Object.freeze({
      id: `core.vocabulary.${id.split('.')[2]}.v1`, revision: 1,
      title: `${word.w} — ${word.tr}`,
      explanation: `Серверная карточка фиксирует значение «${word.tr}» и употребление слова ${word.w} в контексте.`,
      examples: Object.freeze([String(word.ex), `${word.w} — ${word.tr}`]),
    }),
    microCheck: frozenPractice(`${id}.micro.v1`, practice[0], skillId),
    transferTask: frozenPractice(`${id}.transfer.v1`, practice[1], skillId),
    recoveryTasks: Object.freeze({
      day1: frozenPractice(`${id}.recovery.day1.v1`, practice[2], skillId),
      day7: frozenPractice(`${id}.recovery.day7.v1`, practice[3], skillId),
    }),
  });
}

function vocabularyPractice(words, word, mode) {
  const sourceKey = practicePromptKey(vocabularyFields(word, mode).prompt);
  const candidates = vocabularyTargetCandidates(words, word, word.practice, 4)
    .filter((candidate) => practicePromptKey(candidate.prompt) !== sourceKey);
  if (candidates.length < 4) throw new Error('CORE_VOICE_TUTOR_ANALOGS_UNAVAILABLE');
  return candidates;
}

function buildItems() {
  const result = {};
  const grammarPools = {};
  for (const [topicId, levels] of Object.entries(GRAMMAR_CATALOG.bank)) {
    grammarPools[topicId] = ['c', 'c2', 'f'].flatMap((kind) => (
      (levels[kind] || []).map((question) => ({ ...grammarFields(question, kind), question, kind }))
    ));
  }
  for (const [topicId, pool] of Object.entries(grammarPools)) {
    pool.forEach((candidate, index) => {
      const id = candidate.question.id;
      result[id] = grammarItem({
        id, topicId, question: candidate.question, kind: candidate.kind,
        practice: [1, 2, 3, 4].map((offset) => pool[(index + offset) % pool.length]),
      });
    });
  }
  GRAMMAR_CATALOG.exams.forEach((exam) => {
    exam.gaps.forEach((gap, gapIndex) => {
      const topicId = String(gap.t);
      const id = gap.id;
      const pool = grammarPools[topicId];
      const question = { s: `${exam.tx[gapIndex]}_____ (${gap.b})${exam.tx[gapIndex + 1]}`, ans: gap.ans, e: gap.e, revision: gap.revision };
      result[id] = grammarItem({
        id, topicId, question, kind: 'f',
        practice: [0, 1, 2, 3].map((offset) => pool[(gapIndex + offset) % pool.length]),
      });
    });
  });
  const words = CORE_VOICE_CATALOG_SOURCE.vocabulary;
  for (const mode of ['c1', 'c2', 'type']) {
    words.forEach((word, index) => {
      const id = `core.v.${index + 1}.${mode}`;
      result[id] = vocabularyItem({
        id, word, mode,
        practice: vocabularyPractice(words, word, mode),
      });
    });
  }
  return Object.freeze(result);
}

export const CORE_VOICE_TUTOR_ITEMS = buildItems();

export function getCoreVoiceTutorItem(itemId) {
  return CORE_VOICE_TUTOR_ITEMS[String(itemId || '')] || null;
}

export function corePracticeCandidatesForSkill(skillId, excludedPrompts = [], limit = 4) {
  const excluded = new Set(excludedPrompts.map(practicePromptKey).filter(Boolean));
  const candidates = [];
  const seen = new Set(excluded);
  for (const item of Object.values(CORE_VOICE_TUTOR_ITEMS)) {
    if (item.skill.id !== skillId) continue;
    for (const candidate of [
      { prompt: item.prompt, reference: item.reference },
      item.microCheck, item.transferTask, item.recoveryTasks.day1, item.recoveryTasks.day7,
    ]) {
      const key = practicePromptKey(candidate.prompt);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      candidates.push({ prompt: candidate.prompt, reference: [...(candidate.reference || candidate.answers)], skillId });
      if (candidates.length === limit) return candidates;
    }
  }
  return candidates;
}

export const CORE_VOICE_TUTOR_COVERAGE = Object.freeze({
  grammar: Object.values(CORE_VOICE_TUTOR_ITEMS).filter((item) => item.module === 'grammar').length,
  vocabulary: Object.values(CORE_VOICE_TUTOR_ITEMS).filter((item) => item.module === 'vocabulary').length,
});
