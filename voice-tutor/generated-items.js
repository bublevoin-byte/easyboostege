import crypto from 'node:crypto';
import { createContextVoiceTutorItem } from './canonical-items.js';

const GENERATED_OPERATIONS = Object.freeze({
  reading_questions: Object.freeze({ module: 'reading', kind: 'context' }),
  listening_interview: Object.freeze({ module: 'listening', kind: 'context' }),
  grammar_topic_set: Object.freeze({ module: 'grammar', kind: 'direct', code: 'q' }),
  grammar_exam_19_24: Object.freeze({ module: 'grammar', kind: 'direct', code: 'e' }),
  vocabulary_cards: Object.freeze({ module: 'vocabulary', kind: 'direct', code: 'v' }),
});

const CONTEXT_OPERATION_BY_MODULE = Object.freeze({ reading: 'reading_questions', listening: 'listening_interview' });
const DIRECT_OPERATION_BY_CODE = Object.freeze({ q: 'grammar_topic_set', e: 'grammar_exam_19_24', v: 'vocabulary_cards' });
const DIRECT_MODULE_CODE = Object.freeze({ grammar: 'g', vocabulary: 'v' });

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function resultDigest(data) {
  return crypto.createHash('sha256').update(canonicalJson(data)).digest('hex');
}

function contextMetadata(operation, requestHash, data) {
  const descriptor = GENERATED_OPERATIONS[operation];
  const hash = String(requestHash || '');
  if (descriptor?.kind !== 'context' || !/^[a-f0-9]{64}$/u.test(hash) || !data || typeof data !== 'object' || Array.isArray(data)) return null;
  const setId = `generated.${descriptor.module}.${hash}.${resultDigest(data).slice(0, 32)}`;
  return Object.freeze({
    set_id: setId,
    revision: 1,
    item_ids: Object.freeze(Array.from({ length: 4 }, (_, index) => `${setId}.${index + 1}`)),
  });
}

function directPrefix(operation, requestHash, data) {
  const descriptor = GENERATED_OPERATIONS[operation];
  const hash = String(requestHash || '');
  if (descriptor?.kind !== 'direct' || !/^[a-f0-9]{64}$/u.test(hash)) return null;
  return `generated.${DIRECT_MODULE_CODE[descriptor.module]}.${descriptor.code}.${hash}.${resultDigest(data).slice(0, 16)}`;
}

function directPointers(operation, requestHash, data) {
  const prefix = directPrefix(operation, requestHash, data);
  if (!prefix) return null;
  const pointer = (suffix) => Object.freeze({ id: `${prefix}.${suffix}`, revision: 1 });
  if (operation === 'grammar_topic_set') {
    return {
      c: data.c.map((_, index) => pointer(`c${index + 1}`)),
      f: data.f.map((_, index) => pointer(`f${index + 1}`)),
    };
  }
  if (operation === 'grammar_exam_19_24') return { gaps: data.gaps.map((_, index) => pointer(String(index + 1))) };
  return data.map((_, index) => Object.freeze({
    c1: pointer(`${index + 1}c1`), c2: pointer(`${index + 1}c2`), type: pointer(`${index + 1}type`),
  }));
}

export function decorateGeneratedVoiceTutorContent(operation, requestHash, data) {
  const context = contextMetadata(operation, requestHash, data);
  if (context) return { ...data, voice_tutor: context };
  const pointers = directPointers(operation, requestHash, data);
  if (!pointers) return data;
  if (operation === 'grammar_topic_set') {
    return {
      ...data,
      c: data.c.map((item, index) => ({ ...item, voice: pointers.c[index] })),
      f: data.f.map((item, index) => ({ ...item, voice: pointers.f[index] })),
    };
  }
  if (operation === 'grammar_exam_19_24') {
    return { ...data, gaps: data.gaps.map((item, index) => ({ ...item, voice: pointers.gaps[index] })) };
  }
  return data.map((item, index) => ({ ...item, voice_tutor: pointers[index] }));
}

export function parseGeneratedVoiceTutorSetId(setId, module) {
  const match = /^generated\.(reading|listening)\.([a-f0-9]{64})\.([a-f0-9]{32})$/u.exec(String(setId || ''));
  if (!match || match[1] !== module) return null;
  return { operation: CONTEXT_OPERATION_BY_MODULE[module], requestHash: match[2], resultDigest: match[3] };
}

export function parseGeneratedVoiceTutorItemId(itemId, module) {
  const match = /^generated\.([gv])\.([qev])\.([a-f0-9]{64})\.([a-f0-9]{16})\.([a-z0-9]+)$/u.exec(String(itemId || ''));
  const operation = match ? DIRECT_OPERATION_BY_CODE[match[2]] : null;
  const descriptor = operation ? GENERATED_OPERATIONS[operation] : null;
  if (!match || !descriptor || DIRECT_MODULE_CODE[module] !== match[1] || descriptor.module !== module) return null;
  return { operation, requestHash: match[3], resultDigest: match[4] };
}

function directPractice(id, candidate, suffix) {
  return Object.freeze({ id: `${id}.${suffix}.v1`, prompt: candidate.prompt, answers: Object.freeze([...candidate.reference]) });
}

function directItem({ id, module, prompt, reference, errorType, skill, explanation, practice }) {
  return Object.freeze({
    id, revision: 1, module, prompt, reference: Object.freeze([...reference]), errorType,
    skill: Object.freeze(skill),
    rule: explanation ? Object.freeze({
      id: `${id}.rule.v1`, revision: 1, title: skill.label,
      explanation, examples: Object.freeze([prompt]),
    }) : null,
    microCheck: directPractice(id, practice[0], 'micro'),
    transferTask: directPractice(id, practice[1], 'transfer'),
  });
}

function grammarCandidate(question, kind) {
  return kind === 'c'
    ? { prompt: `${question.t[0]}_____${question.t[1]}`, reference: [String(question.o[question.a])], explanation: String(question.e) }
    : { prompt: String(question.s), reference: question.ans.map(String), explanation: String(question.e) };
}

function vocabularyCandidate(word, mode) {
  if (mode === 'c1') return { prompt: `Выбери точный перевод слова ${word.w}.`, reference: [String(word.tr)] };
  const reference = [...new Set([String(word.w), String(word.w).replace(/^to\s+/iu, '')])];
  return mode === 'c2'
    ? { prompt: `Выбери английское слово для значения «${word.tr}».`, reference }
    : { prompt: `Впиши слово со значением «${word.tr}» в контекст: ${word.ex}`, reference };
}

function buildDirectDefinitions(operation, requestHash, data) {
  const pointers = directPointers(operation, requestHash, data);
  if (!pointers) return null;
  const items = new Map();
  if (operation === 'grammar_topic_set') {
    const candidates = [
      ...data.c.map((question) => ({ ...grammarCandidate(question, 'c'), kind: 'c' })),
      ...data.f.map((question) => ({ ...grammarCandidate(question, 'f'), kind: 'f' })),
    ];
    candidates.forEach((candidate, index) => {
      const withinKind = index < data.c.length ? index : index - data.c.length;
      const id = (candidate.kind === 'c' ? pointers.c : pointers.f)[withinKind].id;
      items.set(id, directItem({
        id, module: 'grammar', prompt: candidate.prompt, reference: candidate.reference,
        errorType: candidate.kind === 'f' ? 'incorrect_word_formation' : 'incorrect_form',
        skill: { id: 'ege.grammar.generated', label: 'Сгенерированная грамматическая практика' },
        explanation: candidate.explanation,
        practice: [candidates[(index + 1) % candidates.length], candidates[(index + 2) % candidates.length]],
      }));
    });
  } else if (operation === 'grammar_exam_19_24') {
    const candidates = data.gaps.map((gap, index) => ({
      prompt: `${data.tx[index]}_____ (${gap.b})${data.tx[index + 1]}`,
      reference: gap.ans.map(String), explanation: String(gap.e), topic: Number(gap.t),
    }));
    candidates.forEach((candidate, index) => {
      const id = pointers.gaps[index].id;
      items.set(id, directItem({
        id, module: 'grammar', prompt: candidate.prompt, reference: candidate.reference,
        errorType: [16, 17, 20].includes(candidate.topic) ? 'incorrect_word_formation' : 'incorrect_form',
        skill: { id: `ege.grammar.topic_${candidate.topic}`, label: `ЕГЭ 19–24: тема ${candidate.topic}` },
        explanation: candidate.explanation,
        practice: [candidates[(index + 1) % candidates.length], candidates[(index + 2) % candidates.length]],
      }));
    });
  } else {
    for (const mode of ['c1', 'c2', 'type']) {
      const candidates = data.map((word) => vocabularyCandidate(word, mode));
      candidates.forEach((candidate, index) => {
        const id = pointers[index][mode].id;
        const word = data[index];
        items.set(id, directItem({
          id, module: 'vocabulary', prompt: candidate.prompt, reference: candidate.reference,
          errorType: ['ph', 'id'].includes(word.p) ? 'incorrect_collocation' : 'incorrect_meaning',
          skill: { id: `ege.vocabulary.generated.${word.p}`, label: `${word.w} — ${word.tr}` },
          explanation: `Сервер сохранил значение «${word.tr}» и пример: ${word.ex}`,
          practice: [candidates[(index + 1) % candidates.length], candidates[(index + 2) % candidates.length]],
        }));
      });
    }
  }
  return Object.freeze({
    resultSet: null,
    getItem(itemId) { return items.get(String(itemId || '')) || null; },
  });
}

export function buildGeneratedVoiceTutorDefinitions(operation, requestHash, data) {
  const descriptor = GENERATED_OPERATIONS[operation];
  if (descriptor?.kind === 'direct') return buildDirectDefinitions(operation, requestHash, data);
  const metadata = contextMetadata(operation, requestHash, data);
  if (!descriptor || !metadata || !Array.isArray(data?.qs) || data.qs.length !== metadata.item_ids.length) return null;
  const items = new Map(data.qs.map((question, index) => {
    const item = createContextVoiceTutorItem({
      id: metadata.item_ids[index], module: descriptor.module,
      prompt: question.q, options: question.o, answer: question.a,
      evidence: question.ev, explanation: question.e,
    });
    return [item.id, item];
  }));
  return Object.freeze({
    resultSet: Object.freeze({ id: metadata.set_id, revision: metadata.revision, module: descriptor.module, items: metadata.item_ids }),
    getItem(itemId) { return items.get(String(itemId || '')) || null; },
  });
}
