import { GRAMMAR_CATALOG_CONTENT } from './grammar-catalog-content.js';

const BUILTIN_KINDS = Object.freeze(['c', 'c2', 'f']);
const ALLOWED_MARKUP = /<\/?b>|<br\s*\/?>/giu;

function fail(code, details = '') {
  throw new Error(details ? `${code}: ${details}` : code);
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}

function clone(value) {
  return structuredClone(value);
}

function text(value, code, details) {
  const result = String(value ?? '').trim();
  if (!result) fail(code, details);
  const unsupported = result.replace(ALLOWED_MARKUP, '');
  if (/[<>]/u.test(unsupported)) fail('UNSUPPORTED_GRAMMAR_MARKUP', details);
  return result;
}

function promptPart(value, details) {
  const result = String(value ?? '');
  const unsupported = result.replace(ALLOWED_MARKUP, '');
  if (/[<>]/u.test(unsupported)) fail('UNSUPPORTED_GRAMMAR_MARKUP', details);
  return result;
}

function promptFragment(value, details) {
  const result = promptPart(value, details);
  if (!result.trim()) fail('INVALID_GRAMMAR_PROMPT', details);
  return result;
}

function acceptedAnswers(values, details) {
  if (!Array.isArray(values) || values.length === 0) fail('EMPTY_GRAMMAR_ANSWER', details);
  const answers = values.map((answer) => text(answer, 'EMPTY_GRAMMAR_ANSWER', details));
  return [...new Set(answers)];
}

function normalizeRevision(value, fallback, details) {
  const revision = Number(value == null ? fallback : value);
  if (!Number.isInteger(revision) || revision < 1 || revision > 1_000_000) fail('INVALID_GRAMMAR_REVISION', details);
  return revision;
}

function voicePointer(id, revision) {
  return { id, revision };
}

function choiceFields(source, details, optionCount = null) {
  if (!source || !Array.isArray(source.t) || source.t.length !== 2) fail('INVALID_GRAMMAR_PROMPT', details);
  const options = acceptedAnswers(source.o, details);
  if ((optionCount != null && options.length !== optionCount)
    || !Number.isInteger(source.a) || source.a < 0 || source.a >= options.length) {
    fail('INVALID_GRAMMAR_ANSWER_INDEX', details);
  }
  return {
    t: source.t.map((part) => promptPart(part, details)),
    o: options,
    a: source.a,
    e: text(source.e, 'EMPTY_GRAMMAR_EXPLANATION', details),
  };
}

function inputFields(source, details, requireBlank = true) {
  if (!source) fail('INVALID_GRAMMAR_PROMPT', details);
  const prompt = text(source.s, 'INVALID_GRAMMAR_PROMPT', details);
  if (requireBlank && !prompt.includes('_____')) fail('INVALID_GRAMMAR_PROMPT', details);
  return {
    s: prompt,
    b: text(source.b, 'INVALID_GRAMMAR_BASE', details),
    ans: acceptedAnswers(source.ans, details),
    e: text(source.e, 'EMPTY_GRAMMAR_EXPLANATION', details),
  };
}

function choiceItem(source, context) {
  const id = source.id || context.id;
  const revision = normalizeRevision(source.revision, context.revision, id);
  return {
    ...source,
    id,
    revision,
    type: 'choice',
    ...choiceFields(source, id),
    voice: voicePointer(id, revision),
  };
}

function inputItem(source, context) {
  const id = source.id || context.id;
  const revision = normalizeRevision(source.revision, context.revision, id);
  return {
    ...source,
    id,
    revision,
    type: 'input',
    ...inputFields(source, id),
    voice: voicePointer(id, revision),
  };
}

function validateItemType(source, expectedType, id) {
  if (source.type != null && source.type !== expectedType) fail('UNSUPPORTED_GRAMMAR_KIND', id);
}

function registerId(ids, id, expectedId) {
  if (!/^core\.g\.(?:[1-9]|1\d|20)\.(?:c|c2|f)\.\d+$/u.test(id)
    && !/^core\.g\.exam\.\d+\.\d+$/u.test(id)) {
    fail('INVALID_GRAMMAR_ID', id);
  }
  if (ids.has(id)) fail('DUPLICATE_GRAMMAR_ID', id);
  if (id !== expectedId) fail('INVALID_GRAMMAR_IDENTITY', `${id} != ${expectedId}`);
  ids.add(id);
}

function normalizeBank(source, revision, topics, ids) {
  const bank = {};
  for (const topicId of Object.keys(source || {})) {
    if (!topics[topicId]) fail('UNKNOWN_GRAMMAR_TOPIC', topicId);
    const levels = source[topicId];
    for (const kind of Object.keys(levels || {})) {
      if (!BUILTIN_KINDS.includes(kind)) fail('UNSUPPORTED_GRAMMAR_KIND', `${topicId}.${kind}`);
    }
    bank[topicId] = {};
    for (const kind of BUILTIN_KINDS) {
      const questions = levels?.[kind] || [];
      if (!Array.isArray(questions)) fail('UNSUPPORTED_GRAMMAR_KIND', `${topicId}.${kind}`);
      bank[topicId][kind] = questions.map((question, index) => {
        const defaultId = `core.g.${topicId}.${kind}.${index + 1}`;
        validateItemType(question, kind === 'f' ? 'input' : 'choice', defaultId);
        const item = kind === 'f'
          ? inputItem(question, { id: defaultId, revision })
          : choiceItem(question, { id: defaultId, revision });
        registerId(ids, item.id, defaultId);
        return item;
      });
    }
  }
  return bank;
}

function normalizeExams(source, revision, topics, ids) {
  if (!Array.isArray(source)) fail('INVALID_GRAMMAR_EXAMS');
  return source.map((exam, examIndex) => {
    if (!Array.isArray(exam.tx) || !Array.isArray(exam.gaps) || exam.tx.length !== exam.gaps.length + 1) {
      fail('INVALID_GRAMMAR_EXAM', String(examIndex + 1));
    }
    const expectedExamId = `core.g.exam.${examIndex + 1}`;
    const examId = exam.id || expectedExamId;
    if (examId !== expectedExamId) fail('INVALID_GRAMMAR_IDENTITY', `${examId} != ${expectedExamId}`);
    return {
      ...exam,
      id: examId,
      revision: normalizeRevision(exam.revision, revision, `exam.${examIndex + 1}`),
      tx: exam.tx.map((part) => promptFragment(part, `exam.${examIndex + 1}`)),
      gaps: exam.gaps.map((gap, gapIndex) => {
        const expectedId = `core.g.exam.${examIndex + 1}.${gapIndex + 1}`;
        const id = gap.id || expectedId;
        if (!topics[gap.t]) fail('UNKNOWN_GRAMMAR_TOPIC', `${id}.${gap.t}`);
        validateItemType(gap, 'input', id);
        const itemRevision = normalizeRevision(gap.revision, revision, id);
        const item = {
          ...gap,
          id,
          revision: itemRevision,
          type: 'input',
          b: text(gap.b, 'INVALID_GRAMMAR_BASE', id),
          ans: acceptedAnswers(gap.ans, id),
          e: text(gap.e, 'EMPTY_GRAMMAR_EXPLANATION', id),
          voice: voicePointer(id, itemRevision),
        };
        registerId(ids, item.id, expectedId);
        return item;
      }),
    };
  });
}

function normalizeGroups(source, topics) {
  if (!Array.isArray(source) || source.length === 0) fail('INVALID_GRAMMAR_GROUPS');
  const seen = new Set();
  const groups = source.map((group, index) => ({
    ...group,
    id: group.id || `grammar-group-${index + 1}`,
    n: text(group.n, 'INVALID_GRAMMAR_GROUP', String(index + 1)),
    ids: (group.ids || []).map((topicId) => {
      const id = String(topicId);
      if (!topics[id]) fail('UNKNOWN_GRAMMAR_TOPIC', id);
      if (seen.has(id)) fail('DUPLICATE_GRAMMAR_TOPIC_GROUP', id);
      seen.add(id);
      return Number(topicId);
    }),
  }));
  if (seen.size !== Object.keys(topics).length) fail('INCOMPLETE_GRAMMAR_TOPIC_GROUPS');
  return groups;
}

function contentKey(prompt, answers) {
  const normalizedPrompt = String(prompt).toLocaleLowerCase('en')
    .replace(/<[^>]+>/gu, ' ')
    .replace(/[^\p{L}\p{N}_]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  const normalizedAnswers = answers.map((answer) => String(answer).toLocaleLowerCase('en').trim()).sort().join('|');
  return `${normalizedPrompt}::${normalizedAnswers}`;
}

function assertUniqueEntries(entries) {
  const seen = new Map();
  for (const { id, prompt, answers } of entries) {
    const key = contentKey(prompt, answers);
    if (seen.has(key)) fail('DUPLICATE_GRAMMAR_CONTENT', `${seen.get(key)} / ${id}`);
    seen.set(key, id);
  }
}

function assertUniqueContent(bank, exams) {
  const entries = [];
  for (const levels of Object.values(bank)) {
    for (const kind of BUILTIN_KINDS) {
      for (const item of levels[kind]) {
        const prompt = item.type === 'choice' ? `${item.t[0]} _____ ${item.t[1]}` : item.s;
        const answers = item.type === 'choice' ? [item.o[item.a]] : item.ans;
        entries.push({ id: item.id, prompt, answers });
      }
    }
  }
  for (const exam of exams) {
    exam.gaps.forEach((gap, index) => {
      entries.push({
        id: gap.id,
        prompt: `${exam.tx[index]} _____ (${gap.b}) ${exam.tx[index + 1]}`,
        answers: gap.ans,
      });
    });
  }
  assertUniqueEntries(entries);
}

function catalogContentFingerprint(catalog) {
  let hash = 2_166_136_261;
  for (const character of JSON.stringify(catalog)) {
    hash = Math.imul(hash ^ character.charCodeAt(0), 16_777_619) >>> 0;
  }
  return `fnv1a32:${hash.toString(16).padStart(8, '0')}`;
}

export function createGrammarCatalog(input) {
  const source = clone(input);
  const version = text(source.version, 'INVALID_GRAMMAR_VERSION');
  const revision = normalizeRevision(source.revision, null, version);
  const topics = {};
  for (const [topicId, topic] of Object.entries(source.topics || {})) {
    if (!/^(?:[1-9]|1\d|20)$/u.test(topicId)) fail('UNKNOWN_GRAMMAR_TOPIC', topicId);
    topics[topicId] = {
      ...topic,
      id: Number(topicId),
      revision: normalizeRevision(topic.revision, revision, topicId),
      n: text(topic.n, 'INVALID_GRAMMAR_TOPIC', topicId),
      th: text(topic.th, 'INVALID_GRAMMAR_TOPIC', topicId),
    };
  }
  const groups = normalizeGroups(source.groups, topics);
  const ids = new Set();
  const bank = normalizeBank(source.bank, revision, topics, ids);
  if (Object.keys(bank).length !== Object.keys(topics).length) fail('INCOMPLETE_GRAMMAR_BANK');
  const exams = normalizeExams(source.exams, revision, topics, ids);
  assertUniqueContent(bank, exams);
  return deepFreeze({ version, revision, groups, topics, bank, exams });
}

export function grammarCatalogCoverage(catalog) {
  const byKind = { c: 0, c2: 0, f: 0 };
  const byTopic = {};
  const itemIds = [];
  for (const [topicId, levels] of Object.entries(catalog.bank)) {
    const topicCounts = { c: 0, c2: 0, f: 0, total: 0 };
    for (const kind of BUILTIN_KINDS) {
      const count = levels[kind].length;
      byKind[kind] += count;
      topicCounts[kind] = count;
      topicCounts.total += count;
      itemIds.push(...levels[kind].map((item) => item.id));
    }
    byTopic[topicId] = Object.freeze(topicCounts);
  }
  catalog.exams.forEach((exam) => itemIds.push(...exam.gaps.map((gap) => gap.id)));
  return Object.freeze({
    version: catalog.version,
    revision: catalog.revision,
    groups: catalog.groups.length,
    topics: Object.keys(catalog.topics).length,
    exercises: Object.values(byKind).reduce((sum, count) => sum + count, 0),
    exams: catalog.exams.length,
    examGaps: catalog.exams.reduce((sum, exam) => sum + exam.gaps.length, 0),
    byKind: Object.freeze(byKind),
    byTopic: Object.freeze(byTopic),
    itemIds: Object.freeze(itemIds),
    contentFingerprint: catalogContentFingerprint(catalog),
  });
}

export function validateGeneratedGrammarSupplement(operation, input) {
  const source = clone(input);
  if (operation === 'grammar_topic_set') {
    if (!Array.isArray(source.c) || !Array.isArray(source.f)) fail('INVALID_GRAMMAR_SUPPLEMENT');
    const topic = {
      c: source.c.map((question, index) => {
        const details = `generated.c.${index + 1}`;
        validateItemType(question, 'choice', details);
        return {
          ...choiceFields(question, details, 4),
          voice: question.voice || null,
        };
      }),
      f: source.f.map((question, index) => {
        const details = `generated.f.${index + 1}`;
        validateItemType(question, 'input', details);
        return {
          ...inputFields(question, details),
          voice: question.voice || null,
        };
      }),
    };
    assertUniqueEntries([
      ...topic.c.map((question, index) => ({
        id: `generated.c.${index + 1}`,
        prompt: `${question.t[0]} _____ ${question.t[1]}`,
        answers: [question.o[question.a]],
      })),
      ...topic.f.map((question, index) => ({
        id: `generated.f.${index + 1}`,
        prompt: question.s,
        answers: question.ans,
      })),
    ]);
    return deepFreeze(topic);
  }
  if (operation === 'grammar_exam_19_24') {
    if (!Array.isArray(source.tx) || source.tx.length !== 7 || !Array.isArray(source.gaps) || source.gaps.length !== 6) {
      fail('INVALID_GRAMMAR_SUPPLEMENT');
    }
    const exam = {
      tx: source.tx.map((part, index) => promptFragment(part, `generated.exam.tx.${index + 1}`)),
      gaps: source.gaps.map((gap, index) => {
        const details = `generated.exam.gap.${index + 1}`;
        validateItemType(gap, 'input', details);
        const topicId = Number(gap.t);
        if (!Number.isInteger(topicId) || topicId < 1 || topicId > 20) fail('UNKNOWN_GRAMMAR_TOPIC', details);
        return {
          b: text(gap.b, 'INVALID_GRAMMAR_BASE', details),
          ans: acceptedAnswers(gap.ans, details),
          e: text(gap.e, 'EMPTY_GRAMMAR_EXPLANATION', details),
          t: topicId,
          voice: gap.voice || null,
        };
      }),
    };
    assertUniqueEntries(exam.gaps.map((gap, index) => ({
      id: `generated.exam.gap.${index + 1}`,
      prompt: `${exam.tx[index]} _____ (${gap.b}) ${exam.tx[index + 1]}`,
      answers: gap.ans,
    })));
    return deepFreeze(exam);
  }
  fail('UNSUPPORTED_GRAMMAR_SUPPLEMENT', String(operation || ''));
}

export const GRAMMAR_CATALOG = createGrammarCatalog(GRAMMAR_CATALOG_CONTENT);
