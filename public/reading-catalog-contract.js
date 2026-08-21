export const READING_CATALOG_ID = 'reading-pilot-v1';
export const READING_CATALOG_REVISION = 1;
export const READING_FULL_ATTEMPT_VERSION = 1;
export const READING_CONTRACT_VERSION = 'reading-catalog-v1';
export const READING_KIND_RULES = Object.freeze({
  task10: Object.freeze({ rawMaxScore: 7, officialMaxScore: 3, answerUpperBound: 7 }),
  task11: Object.freeze({ rawMaxScore: 6, officialMaxScore: 2, answerUpperBound: 6 }),
  task12_18: Object.freeze({ rawMaxScore: 7, officialMaxScore: 7, answerUpperBound: 3 }),
});
export const READING_KINDS = Object.freeze(Object.keys(READING_KIND_RULES));

const KINDS = READING_KINDS;
const CEFR_LEVELS = Object.freeze(['B1', 'B2', 'B2+/C1']);
const EXPECTED_CEFR_COUNTS = Object.freeze({ B1: 4, B2: 12, 'B2+/C1': 4 });
const POSITION_LABELS = Object.freeze(['A', 'B', 'C', 'D', 'E', 'F', 'G']);
const SAFE_SET_ID = /^reading-pilot-v1\.(?:task10|task11|task12_18)\.[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const READING_ACTIVITY_BY_KIND = Object.freeze({
  task10: Object.freeze({ skillId: 'ege.reading.gist', activityId: 'reading_headings', mode: 'reading_headings' }),
  task11: Object.freeze({ skillId: 'ege.reading.detail', activityId: 'reading_gaps', mode: 'reading_gaps' }),
  task12_18: Object.freeze({ skillId: 'ege.reading.detail', activityId: 'reading_detail', mode: 'reading_detail' }),
});
const READING_CEFR_SLUGS = Object.freeze({ B1: 'b1', B2: 'b2', 'B2+/C1': 'b2-plus-c1' });
const READING_CEFR_BY_SLUG = Object.freeze(Object.fromEntries(
  Object.entries(READING_CEFR_SLUGS).map(([cefr, slug]) => [slug, cefr]),
));

function fail(location, message) {
  throw new TypeError(`${location}: ${message}`);
}

function plainObject(value, location) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(location, 'must be an object');
  return value;
}

function exactArray(value, length, location, label) {
  if (!Array.isArray(value) || value.length !== length) {
    fail(location, `must contain exactly ${length} ${label}`);
  }
  return value;
}

function nonEmptyString(value, location, { min = 1, max = 4_000 } = {}) {
  if (typeof value !== 'string' || value.trim().length < min || value.length > max) {
    fail(location, `must be a string between ${min} and ${max} characters`);
  }
  return value;
}

function positiveRevision(value, location) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 10_000) {
    fail(location, 'revision must be a positive integer');
  }
}

function normalized(value) {
  return value.trim().toLocaleLowerCase('en');
}

function assertUniqueStrings(values, location, label) {
  if (new Set(values.map(normalized)).size !== values.length) fail(location, `${label} must be unique`);
}

function assertValidation(value, location) {
  plainObject(value, location);
  if (value.contract !== READING_CONTRACT_VERSION) {
    fail(location, `validation.contract must be ${READING_CONTRACT_VERSION}`);
  }
}

function assertSetEnvelope(set, index, expectedKind) {
  const fallback = `sets[${index}]`;
  plainObject(set, fallback);
  const location = typeof set.id === 'string' ? set.id : fallback;
  if (set.kind !== expectedKind) fail(location, `kind must be ${KINDS.join(', ')}`);
  if (!SAFE_SET_ID.test(set.id || '') || !set.id.startsWith(`${READING_CATALOG_ID}.${expectedKind}.`)) {
    fail(location, `id must be a safe stable id for ${expectedKind}`);
  }
  positiveRevision(set.revision, location);
  nonEmptyString(set.title, `${location}.title`, { min: 4, max: 120 });
  nonEmptyString(set.topic, `${location}.topic`, { min: 3, max: 80 });
  if (!CEFR_LEVELS.includes(set.cefr)) fail(location, `cefr must be ${CEFR_LEVELS.join(', ')}`);
  if (set.provenance !== 'original') fail(location, 'provenance must be original');
  assertValidation(set.validation, `${location}.validation`);
  plainObject(set.task, `${location}.task`);
  return location;
}

function assertExplanation(value, location) {
  nonEmptyString(value, location, { min: 20, max: 700 });
  if (!/[А-Яа-яЁё]/u.test(value)) fail(location, 'explanationRu must contain a Russian explanation');
}

function assertEvidenceEntry(item, location, expectedPosition, expectedAnswer, source) {
  plainObject(item, location);
  if (item.position !== expectedPosition) fail(location, `position must be ${expectedPosition}`);
  if (item.answer !== expectedAnswer) fail(location, 'answer must equal the task answer');
  const quote = nonEmptyString(item.quote, `${location}.quote`, { min: 6, max: 320 });
  assertExplanation(item.explanationRu, `${location}.explanationRu`);
  if (!source.includes(quote)) fail(location, 'quote must occur verbatim in its source text');
}

function assertAnswers(answers, length, upperBound, location) {
  exactArray(answers, length, location, 'answers');
  if (!answers.every((answer) => Number.isSafeInteger(answer) && answer >= 0 && answer < upperBound)) {
    fail(location, `answers must reference indexes 0 through ${upperBound - 1}`);
  }
  if (new Set(answers).size !== length) fail(location, `answers must contain ${length} unique keys`);
}

function assertTask10Set(set, index) {
  const location = assertSetEnvelope(set, index, 'task10');
  const { texts, headings, answers, evidence } = set.task;
  exactArray(texts, 7, `${location}.task.texts`, 'texts');
  texts.forEach((item, position) => {
    const itemLocation = `${location}.task.texts[${position}]`;
    plainObject(item, itemLocation);
    if (item.id !== POSITION_LABELS[position]) fail(itemLocation, `id must be ${POSITION_LABELS[position]}`);
    nonEmptyString(item.text, `${itemLocation}.text`, { min: 50, max: 1_500 });
  });
  exactArray(headings, 8, `${location}.task.headings`, 'headings');
  headings.forEach((heading, headingIndex) => {
    nonEmptyString(heading, `${location}.task.headings[${headingIndex}]`, { min: 4, max: 160 });
  });
  assertUniqueStrings(headings, `${location}.task.headings`, 'headings');
  assertAnswers(answers, 7, 8, `${location}.task.answers`);
  exactArray(evidence, 7, `${location}.task.evidence`, 'evidence entries');
  evidence.forEach((item, position) => assertEvidenceEntry(
    item,
    `${location}.task.evidence[${position}]`,
    POSITION_LABELS[position],
    answers[position],
    texts[position].text,
  ));
}

function assertTask11Set(set, index) {
  const location = assertSetEnvelope(set, index, 'task11');
  const { segments, fragments, answers, evidence } = set.task;
  exactArray(segments, 7, `${location}.task.segments`, 'segments');
  segments.forEach((segment, segmentIndex) => {
    nonEmptyString(segment, `${location}.task.segments[${segmentIndex}]`, { min: 20, max: 1_500 });
  });
  exactArray(fragments, 7, `${location}.task.fragments`, 'fragments');
  fragments.forEach((fragment, fragmentIndex) => {
    nonEmptyString(fragment, `${location}.task.fragments[${fragmentIndex}]`, { min: 8, max: 500 });
  });
  assertUniqueStrings(fragments, `${location}.task.fragments`, 'fragments');
  assertAnswers(answers, 6, 7, `${location}.task.answers`);
  exactArray(evidence, 6, `${location}.task.evidence`, 'evidence entries');
  evidence.forEach((item, position) => {
    const itemLocation = `${location}.task.evidence[${position}]`;
    assertEvidenceEntry(
      item,
      itemLocation,
      POSITION_LABELS[position],
      answers[position],
      `${segments[position]} ${segments[position + 1]}`,
    );
    const left = nonEmptyString(item.leftContext, `${itemLocation}.leftContext`, { min: 8, max: 500 });
    const right = nonEmptyString(item.rightContext, `${itemLocation}.rightContext`, { min: 8, max: 500 });
    if (!segments[position].includes(left)) fail(itemLocation, 'leftContext must occur verbatim in the left segment');
    if (!segments[position + 1].includes(right)) fail(itemLocation, 'rightContext must occur verbatim in the right segment');
  });
}

function assertTask12Set(set, index) {
  const location = assertSetEnvelope(set, index, 'task12_18');
  const text = nonEmptyString(set.task.text, `${location}.task.text`, { min: 300, max: 12_000 });
  const questions = exactArray(set.task.questions, 7, `${location}.task.questions`, 'questions');
  const ids = new Set();
  questions.forEach((question, position) => {
    const questionLocation = `${location}.task.questions[${position}]`;
    plainObject(question, questionLocation);
    const expectedId = `${set.id}.q${position + 1}`;
    if (question.id !== expectedId) fail(questionLocation, `id must be ${expectedId}`);
    if (ids.has(question.id)) fail(questionLocation, 'question id must be unique');
    ids.add(question.id);
    nonEmptyString(question.prompt, `${questionLocation}.prompt`, { min: 12, max: 300 });
    const options = exactArray(question.options, 4, `${questionLocation}.options`, 'options');
    options.forEach((option, optionIndex) => {
      nonEmptyString(option, `${questionLocation}.options[${optionIndex}]`, { min: 2, max: 240 });
    });
    assertUniqueStrings(options, `${questionLocation}.options`, 'options');
    if (!Number.isSafeInteger(question.answer) || question.answer < 0 || question.answer > 3) {
      fail(questionLocation, 'answer must reference option indexes 0 through 3');
    }
    plainObject(question.evidence, `${questionLocation}.evidence`);
    const quote = nonEmptyString(question.evidence.quote, `${questionLocation}.evidence.quote`, { min: 6, max: 320 });
    assertExplanation(question.evidence.explanationRu, `${questionLocation}.evidence.explanationRu`);
    if (!text.includes(quote)) fail(questionLocation, 'quote must occur verbatim in the passage text');
  });
}

export function readingSetReference(set) {
  const id = String(set?.id || '');
  const revision = Number(set?.revision);
  const kind = String(set?.kind || '');
  if (!SAFE_SET_ID.test(id) || !Number.isSafeInteger(revision) || revision < 1 || revision > 10_000
    || !KINDS.includes(kind) || !id.startsWith(`${READING_CATALOG_ID}.${kind}.`)) return null;
  return { id, revision, kind, key: `${id}@${revision}` };
}

export function readingAdaptiveContentRef(kind, cefr) {
  if (!KINDS.includes(kind) || !CEFR_LEVELS.includes(cefr)) {
    throw new TypeError('Reading adaptive kind and CEFR must be allowlisted');
  }
  return `builtin:reading:${kind}:${READING_CEFR_SLUGS[cefr]}:v1`;
}

export function parseReadingAdaptiveContentRef(value) {
  const match = /^builtin:reading:(task10|task11|task12_18):(b1|b2|b2-plus-c1):v1$/u.exec(String(value || ''));
  if (!match) return null;
  return { kind: match[1], cefr: READING_CEFR_BY_SLUG[match[2]] };
}

export function readingLearningActivityContract(set) {
  const reference = readingSetReference(set);
  if (!reference || !CEFR_LEVELS.includes(set?.cefr) || set?.recordable === false) {
    throw new TypeError('Reading learning evidence requires a canonical recordable set');
  }
  const activity = READING_ACTIVITY_BY_KIND[reference.kind];
  return {
    module: 'reading',
    ...activity,
    source: 'catalog',
    setId: reference.id,
    setRevision: reference.revision,
    kind: reference.kind,
    cefr: set.cefr,
    maxScore: READING_KIND_RULES[reference.kind].rawMaxScore,
    contentRef: readingAdaptiveContentRef(reference.kind, set.cefr),
  };
}

export function assertReadingSet(set, index = 0) {
  plainObject(set, `sets[${index}]`);
  if (set?.kind === 'task10') return assertTask10Set(set, index);
  if (set?.kind === 'task11') return assertTask11Set(set, index);
  if (set?.kind === 'task12_18') return assertTask12Set(set, index);
  const location = typeof set?.id === 'string' ? set.id : `sets[${index}]`;
  return fail(location, `kind must be ${KINDS.join(', ')}`);
}

export function assertReadingCatalog(catalog) {
  plainObject(catalog, 'catalog');
  if (catalog.id !== READING_CATALOG_ID) fail('catalog', `id must be ${READING_CATALOG_ID}`);
  positiveRevision(catalog.revision, 'catalog');
  assertValidation(catalog.validation, 'catalog.validation');
  if (!Array.isArray(catalog.sets)) fail('catalog', 'sets must be an array');
  if (catalog.sets.length !== 60) fail('catalog', `expected 60 sets, received ${catalog.sets.length}`);

  const ids = new Set();
  const counts = Object.fromEntries(KINDS.map((kind) => [kind, 0]));
  const cefrCounts = Object.fromEntries(KINDS.map((kind) => [kind, Object.fromEntries(CEFR_LEVELS.map((cefr) => [cefr, 0]))]));
  const contentFingerprints = new Map();
  const registerUniqueContent = (value, location, label) => {
    const fingerprint = normalized(value).replace(/\s+/gu, ' ');
    if (contentFingerprints.has(fingerprint)) {
      fail(location, `${label} must be globally unique; duplicates ${contentFingerprints.get(fingerprint)}`);
    }
    contentFingerprints.set(fingerprint, location);
  };
  catalog.sets.forEach((set, index) => {
    assertReadingSet(set, index);
    if (ids.has(set.id)) fail(set.id, 'id must be unique inside the catalog');
    ids.add(set.id);
    counts[set.kind] += 1;
    cefrCounts[set.kind][set.cefr] += 1;
    if (set.kind === 'task10') {
      set.task.texts.forEach((text, position) => {
        registerUniqueContent(text.text, `${set.id}.task.texts[${position}]`, 'normalized task text');
      });
      const unusedHeadingIndex = set.task.headings.findIndex((heading, headingIndex) => (
        heading && !set.task.answers.includes(headingIndex)
      ));
      const unusedHeading = normalized(set.task.headings[unusedHeadingIndex]);
      if (set.task.texts.some((text) => normalized(text.text).includes(unusedHeading))) {
        fail(set.id, 'unused heading must not appear verbatim in any task text');
      }
    } else if (set.kind === 'task11') {
      const restoredText = set.task.segments.map((segment, position) => (
        position < 6 ? `${segment}${set.task.fragments[set.task.answers[position]]}` : segment
      )).join(' ');
      registerUniqueContent(restoredText, `${set.id}.task`, 'normalized restored text');
    } else {
      registerUniqueContent(set.task.text, `${set.id}.task.text`, 'normalized passage text');
      set.task.questions.forEach((question, position) => {
        registerUniqueContent(question.prompt, `${set.id}.task.questions[${position}].prompt`, 'normalized question');
        if (normalized(question.prompt).includes(normalized(question.options[question.answer]))) {
          fail(`${set.id}.task.questions[${position}]`, 'question must not reveal its correct option verbatim');
        }
      });
    }
  });
  KINDS.forEach((kind) => {
    if (counts[kind] !== 20) fail('catalog', `expected 20 ${kind} sets, received ${counts[kind]}`);
    CEFR_LEVELS.forEach((cefr) => {
      if (cefrCounts[kind][cefr] !== EXPECTED_CEFR_COUNTS[cefr]) {
        fail('catalog', `${kind} CEFR distribution must be 4 B1 / 12 B2 / 4 B2+/C1`);
      }
    });
  });
  return catalog;
}

function legacyEnvelope(kind, metadata) {
  if (!KINDS.includes(kind)) throw new TypeError(`legacy kind must be ${KINDS.join(', ')}`);
  const requestedId = typeof metadata.id === 'string' ? metadata.id : 'technical';
  const safeSuffix = requestedId.toLocaleLowerCase('en').replace(/[^a-z0-9]+/gu, '-').replace(/^-|-$/gu, '')
    .slice(0, 80) || 'technical';
  return {
    id: `legacy-reading.${kind}.${safeSuffix}`,
    revision: Number.isSafeInteger(metadata.revision) && metadata.revision > 0 ? metadata.revision : 1,
    kind,
    title: typeof metadata.title === 'string' && metadata.title.trim() ? metadata.title : 'Техническая тренировка',
    topic: typeof metadata.topic === 'string' && metadata.topic.trim() ? metadata.topic : 'legacy-fallback',
    cefr: CEFR_LEVELS.includes(metadata.cefr) ? metadata.cefr : null,
    provenance: 'legacy',
    validation: { contract: 'reading-legacy-adapter-v1' },
    recordable: false,
    evidenceSource: 'builtin',
  };
}

function legacyExplanation(value) {
  return typeof value === 'string' && value.trim() ? value : 'Технический разбор старого задания.';
}

/* Старый встроенный fallback остаётся технической тренировкой и не может попасть в прогресс 2.0. */
export function adaptLegacyReadingFallback(kind, legacySet, metadata = {}) {
  plainObject(legacySet, 'legacySet');
  const envelope = legacyEnvelope(kind, metadata);
  if (kind === 'task10') {
    const texts = Array.isArray(legacySet.txts) ? legacySet.txts : [];
    return {
      ...envelope,
      task: {
        texts: texts.map((item, index) => ({ id: POSITION_LABELS[index] || String(index + 1), text: String(item?.t || '') })),
        headings: Array.isArray(legacySet.hl) ? legacySet.hl.map(String) : [],
        answers: texts.map((item) => Number(item?.a)),
        evidence: texts.map((item, index) => ({
          position: POSITION_LABELS[index] || String(index + 1),
          answer: Number(item?.a),
          quote: String(item?.t || '').trim().slice(0, 160),
          explanationRu: legacyExplanation(item?.k),
        })),
      },
    };
  }
  if (kind === 'task11') {
    const segments = Array.isArray(legacySet.tx) ? legacySet.tx.map(String) : [];
    const answers = Array.isArray(legacySet.a) ? legacySet.a.map(Number) : [];
    return {
      ...envelope,
      task: {
        segments,
        fragments: Array.isArray(legacySet.fr) ? legacySet.fr.map(String) : [],
        answers,
        evidence: answers.map((answer, index) => ({
          position: POSITION_LABELS[index] || String(index + 1),
          answer,
          leftContext: segments[index] || '',
          rightContext: segments[index + 1] || '',
          quote: (segments[index] || '').trim().slice(0, 160),
          explanationRu: legacyExplanation(legacySet.k?.[index]),
        })),
      },
    };
  }
  const questions = Array.isArray(legacySet.qs) ? legacySet.qs : [];
  return {
    ...envelope,
    task: {
      text: String(legacySet.tx || ''),
      questions: questions.map((question, index) => ({
        id: `${envelope.id}.q${index + 1}`,
        prompt: String(question?.q || ''),
        options: Array.isArray(question?.o) ? question.o.map(String) : [],
        answer: Number(question?.a),
        evidence: {
          quote: String(question?.ev || ''),
          explanationRu: legacyExplanation(question?.e),
        },
      })),
    },
  };
}

export function deepFreezeReadingCatalog(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.values(value).forEach(deepFreezeReadingCatalog);
  return Object.freeze(value);
}

export function readingSetForLegacyScreen(set) {
  assertReadingSet(set, 0);
  const envelope = {
    id: set.id,
    revision: set.revision,
    kind: set.kind,
    title: set.title,
    topic: set.topic,
    cefr: set.cefr,
    provenance: set.provenance,
    evidenceSource: 'builtin',
  };
  if (set.kind === 'task10') {
    return {
      ...envelope,
      hl: set.task.headings.slice(),
      txts: set.task.texts.map((text, position) => ({
        t: text.text,
        a: set.task.answers[position],
        k: set.task.evidence[position].explanationRu,
        evidence: { ...set.task.evidence[position] },
      })),
      maxScore: 7,
    };
  }
  if (set.kind === 'task11') {
    return {
      ...envelope,
      tx: set.task.segments.slice(),
      fr: set.task.fragments.slice(),
      a: set.task.answers.slice(),
      k: set.task.evidence.map((item) => item.explanationRu),
      evidence: set.task.evidence.map((item) => ({ ...item })),
      maxScore: 6,
    };
  }
  return {
    ...envelope,
    tx: set.task.text,
    qs: set.task.questions.map((question) => ({
      q: question.prompt,
      o: question.options.slice(),
      a: question.answer,
      ev: question.evidence.quote,
      e: question.evidence.explanationRu,
      voice: { id: question.id, revision: set.revision },
    })),
    voice: { id: set.id, revision: set.revision },
    maxScore: 7,
  };
}

export function readingSetForVoiceTutor(set) {
  assertReadingSet(set, 0);
  const reference = readingSetReference(set);
  if (!reference || set.recordable === false) throw new TypeError('Voice Tutor requires a canonical Reading set');
  let items;
  if (set.kind === 'task10') {
    items = set.task.texts.map((text, index) => ({
      id: `${set.id}.p${index + 1}`,
      prompt: `Какой заголовок подходит к тексту ${text.id}?`,
      options: set.task.headings.slice(), answer: set.task.answers[index],
      evidence: set.task.evidence[index].quote,
      explanation: set.task.evidence[index].explanationRu,
      position: text.id,
    }));
  } else if (set.kind === 'task11') {
    items = set.task.answers.map((answer, index) => ({
      id: `${set.id}.p${index + 1}`,
      prompt: `Какой фрагмент подходит в пропуск ${POSITION_LABELS[index]}?`,
      options: set.task.fragments.slice(), answer,
      evidence: set.task.evidence[index].quote,
      explanation: set.task.evidence[index].explanationRu,
      position: POSITION_LABELS[index],
    }));
  } else {
    items = set.task.questions.map((question, index) => ({
      id: question.id, prompt: question.prompt, options: question.options.slice(),
      answer: question.answer, evidence: question.evidence.quote,
      explanation: question.evidence.explanationRu,
      position: String(index + 12), questionId: question.id,
    }));
  }
  const skillId = set.kind === 'task10' ? 'ege.reading.gist' : 'ege.reading.detail';
  return {
    id: set.id, revision: set.revision, module: 'reading', kind: set.kind, skillId,
    items,
    voice: { id: set.id, revision: set.revision },
    qs: items.map((item) => ({
      q: item.prompt, o: item.options.slice(), a: item.answer,
      ev: item.evidence, e: item.explanation,
      voice: { id: item.id, revision: set.revision },
    })),
  };
}

export function readingSourceContext(set, exactText) {
  const text = String(exactText || '').normalize('NFKC').trim().replace(/\s+/gu, ' ').slice(0, 600);
  if (!text || !set || !KINDS.includes(set.kind)) return null;
  const reference = readingSetReference(set);
  const contains = (value) => String(value || '').normalize('NFKC').trim().replace(/\s+/gu, ' ').includes(text);
  let position = 'passage';
  let questionId = null;
  let exactCanonicalSource = false;
  if (set.kind === 'task10') {
    const index = set.task?.texts?.findIndex((item) => contains(item.text)) ?? -1;
    if (index >= 0) { position = set.task.texts[index].id; exactCanonicalSource = true; }
  } else if (set.kind === 'task11') {
    const index = set.task?.segments?.findIndex(contains) ?? -1;
    if (index >= 0) { position = POSITION_LABELS[Math.min(index, 5)]; exactCanonicalSource = true; }
  } else {
    exactCanonicalSource = contains(set.task?.text);
    const index = set.task?.questions?.findIndex((question) => (
      text.includes(question.evidence.quote) || question.evidence.quote.includes(text)
    )) ?? -1;
    if (index >= 0) {
      position = String(index + 12);
      questionId = set.task.questions[index].id;
    }
  }
  return {
    text, source: 'reading', readingProvenance: reference && exactCanonicalSource ? 'canonical' : 'technical',
    readingSetId: reference?.id || String(set.id || 'legacy-reading.technical'),
    readingSetRevision: reference?.revision || Number(set.revision) || 1,
    readingKind: set.kind, position,
    ...(questionId ? { questionId } : {}),
  };
}

export function readingSourceContextFromSets(sets, exactText) {
  const contexts = (Array.isArray(sets) ? sets : []).map((set) => readingSourceContext(set, exactText))
    .filter(Boolean);
  return contexts.find((context) => context.readingProvenance === 'canonical') || contexts[0] || null;
}

export async function loadReadingCatalog(loadCatalog) {
  if (typeof loadCatalog !== 'function') throw new TypeError('loadCatalog must be a function');
  const loaded = await loadCatalog();
  const catalog = loaded?.READING_CATALOG || loaded?.default || loaded;
  assertReadingCatalog(catalog);
  return deepFreezeReadingCatalog(catalog);
}

export const READING_CEFR_LEVELS = CEFR_LEVELS;
