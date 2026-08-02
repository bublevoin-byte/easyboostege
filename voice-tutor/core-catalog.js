import { CORE_VOICE_CATALOG_SOURCE } from './generated-core-catalog.js';

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

function frozenPractice(id, candidate) {
  return Object.freeze({ id, prompt: candidate.prompt, answers: Object.freeze([...candidate.reference]) });
}

function grammarItem({ id, topicId, question, kind, practice }) {
  const fields = grammarFields(question, kind);
  const topic = CORE_VOICE_CATALOG_SOURCE.topics[topicId];
  const domain = grammarDomain(topicId);
  return Object.freeze({
    id, revision: 1, module: 'grammar', prompt: fields.prompt,
    reference: Object.freeze(fields.reference), errorType: domain.type,
    skill: Object.freeze({ id: `ege.${domain.skill}.topic_${topicId}`, label: cleanHtml(topic.n) }),
    rule: Object.freeze({
      id: `core.grammar.topic.${topicId}.v1`, revision: 1,
      title: cleanHtml(topic.n), explanation: cleanHtml(topic.th),
      examples: Object.freeze([cleanHtml(question.e), fields.prompt]),
    }),
    microCheck: frozenPractice(`${id}.micro.v1`, practice[0]),
    transferTask: frozenPractice(`${id}.transfer.v1`, practice[1]),
  });
}

function vocabularyFields(word, mode) {
  if (mode === 'c1') return { prompt: `Выбери точный перевод слова ${word.w}.`, reference: [String(word.tr)] };
  const reference = [...new Set([String(word.w), baseWord(word.w)].filter(Boolean))];
  if (mode === 'c2') return { prompt: `Выбери английское слово для значения «${word.tr}».`, reference };
  return { prompt: `Впиши слово со значением «${word.tr}» в контекст: ${word.ex}`, reference };
}

function vocabularyDomain(word) {
  return ['ph', 'id'].includes(word.p)
    ? { type: 'incorrect_collocation', skill: 'collocation', label: 'Устойчивое сочетание' }
    : { type: 'incorrect_meaning', skill: 'vocabulary', label: 'Лексика в контексте' };
}

function vocabularyItem({ id, word, mode, practice }) {
  const fields = vocabularyFields(word, mode);
  const domain = vocabularyDomain(word);
  return Object.freeze({
    id, revision: 1, module: 'vocabulary', prompt: fields.prompt,
    reference: Object.freeze(fields.reference), errorType: domain.type,
    skill: Object.freeze({ id: `ege.${domain.skill}.${word.p}`, label: `${domain.label}: ${word.w}` }),
    rule: Object.freeze({
      id: `core.vocabulary.${id.split('.')[2]}.v1`, revision: 1,
      title: `${word.w} — ${word.tr}`,
      explanation: `Серверная карточка фиксирует значение «${word.tr}» и употребление слова ${word.w} в контексте.`,
      examples: Object.freeze([String(word.ex), `${word.w} — ${word.tr}`]),
    }),
    microCheck: frozenPractice(`${id}.micro.v1`, practice[0]),
    transferTask: frozenPractice(`${id}.transfer.v1`, practice[1]),
  });
}

function buildItems() {
  const result = {};
  const grammarPools = {};
  for (const [topicId, levels] of Object.entries(CORE_VOICE_CATALOG_SOURCE.grammar)) {
    grammarPools[topicId] = ['c', 'c2', 'f'].flatMap((kind) => (
      (levels[kind] || []).map((question) => ({ ...grammarFields(question, kind), question, kind }))
    ));
  }
  for (const [topicId, pool] of Object.entries(grammarPools)) {
    pool.forEach((candidate, index) => {
      const kindIndex = CORE_VOICE_CATALOG_SOURCE.grammar[topicId][candidate.kind].indexOf(candidate.question) + 1;
      const id = `core.g.${topicId}.${candidate.kind}.${kindIndex}`;
      result[id] = grammarItem({
        id, topicId, question: candidate.question, kind: candidate.kind,
        practice: [pool[(index + 1) % pool.length], pool[(index + 2) % pool.length]],
      });
    });
  }
  CORE_VOICE_CATALOG_SOURCE.exams.forEach((exam, examIndex) => {
    exam.gaps.forEach((gap, gapIndex) => {
      const topicId = String(gap.t);
      const id = `core.g.exam.${examIndex + 1}.${gapIndex + 1}`;
      const pool = grammarPools[topicId];
      const question = { s: `${exam.tx[gapIndex]}_____ (${gap.b})${exam.tx[gapIndex + 1]}`, ans: gap.ans, e: gap.e };
      result[id] = grammarItem({ id, topicId, question, kind: 'f', practice: [pool[gapIndex % pool.length], pool[(gapIndex + 1) % pool.length]] });
    });
  });
  const words = CORE_VOICE_CATALOG_SOURCE.vocabulary;
  for (const mode of ['c1', 'c2', 'type']) {
    words.forEach((word, index) => {
      const id = `core.v.${index + 1}.${mode}`;
      result[id] = vocabularyItem({
        id, word, mode,
        practice: [vocabularyFields(words[(index + 1) % words.length], mode), vocabularyFields(words[(index + 2) % words.length], mode)],
      });
    });
  }
  return Object.freeze(result);
}

export const CORE_VOICE_TUTOR_ITEMS = buildItems();

export function getCoreVoiceTutorItem(itemId) {
  return CORE_VOICE_TUTOR_ITEMS[String(itemId || '')] || null;
}

export const CORE_VOICE_TUTOR_COVERAGE = Object.freeze({
  grammar: Object.values(CORE_VOICE_TUTOR_ITEMS).filter((item) => item.module === 'grammar').length,
  vocabulary: Object.values(CORE_VOICE_TUTOR_ITEMS).filter((item) => item.module === 'vocabulary').length,
});
