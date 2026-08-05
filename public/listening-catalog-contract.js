const CATALOG_ID = 'listening-pilot-v1';
const MATCHING_ROLES = Object.freeze([
  'speaker_a', 'speaker_b', 'speaker_c', 'speaker_d', 'speaker_e', 'speaker_f',
]);
const CEFR_LEVELS = new Set(['B1', 'B2']);
const SAFE_SET_ID = /^listening-pilot-v1\.matching\.[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const SAFE_VOICE_SLOT = /^(?:female|male)_[1-3]$/u;
const SAFE_AUDIO_PATH = /^\/audio\/listening\/listening-pilot-v1\/matching\/[a-z0-9]+(?:-[a-z0-9]+)*-r[1-9]\d*\.mp3$/u;
const SAFE_TRUE_FALSE_ID = /^listening-pilot-v1\.true-false\.[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const SAFE_TRUE_FALSE_AUDIO_PATH = /^\/audio\/listening\/listening-pilot-v1\/true-false\/[a-z0-9]+(?:-[a-z0-9]+)*-r[1-9]\d*\.mp3$/u;
const TRUE_FALSE_ANSWERS = Object.freeze(['true', 'false', 'not_stated']);
const TRUE_FALSE_ANSWER_INDEX = Object.freeze({ true: 0, false: 1, not_stated: 2 });
const SAFE_INTERVIEW_ID = /^listening-pilot-v1\.interview\.[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const SAFE_INTERVIEW_ITEM_ID = /^listening-pilot-v1\.interview\.[a-z0-9]+(?:-[a-z0-9]+)*\.q[1-7]$/u;
const SAFE_INTERVIEW_AUDIO_PATH = /^\/audio\/listening\/listening-pilot-v1\/interview\/[a-z0-9]+(?:-[a-z0-9]+)*-r[1-9]\d*\.mp3$/u;

function fail(location, message) {
  throw new TypeError(`${location}: ${message}`);
}

function plainObject(value, location) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(location, 'must be an object');
  return value;
}

function nonEmptyString(value, location, { min = 1, max = 2_000 } = {}) {
  if (typeof value !== 'string' || value.trim().length < min || value.length > max) {
    fail(location, `must be a string between ${min} and ${max} characters`);
  }
  return value;
}

function positiveRevision(value, location) {
  if (!Number.isSafeInteger(value) || value < 1) fail(location, 'revision must be a positive integer');
}

function assertSetEnvelope(set, index, {
  type, idPattern, idDescription, idPrefix, audioDirectory, audioPattern,
}) {
  const fallback = `sets[${index}]`;
  plainObject(set, fallback);
  const location = typeof set.id === 'string' ? set.id : fallback;
  if (!idPattern.test(set.id || '')) fail(location, `id must be a safe stable id for ${idDescription}`);
  positiveRevision(set.revision, location);
  if (set.type !== type) fail(location, `type must be ${type}`);
  if (set.provenance !== 'original') fail(location, 'provenance must be original');
  nonEmptyString(set.title, `${location}.title`, { min: 4, max: 100 });
  nonEmptyString(set.topic, `${location}.topic`, { min: 3, max: 50 });
  if (!CEFR_LEVELS.has(set.cefr)) fail(location, 'cefr must be B1 or B2');

  plainObject(set.audio, `${location}.audio`);
  const slug = set.id.replace(idPrefix, '');
  const expectedAudioPath = `/audio/listening/listening-pilot-v1/${audioDirectory}/${slug}-r${set.revision}.mp3`;
  if (!audioPattern.test(set.audio.path || '') || set.audio.path.includes('..')
    || set.audio.path !== expectedAudioPath) {
    fail(location, `audio.path must be an immutable safe MP3 path inside the ${audioDirectory} catalog`);
  }
  return location;
}

function evidenceQuoteAndExplanation(item, evidenceLocation) {
  plainObject(item, evidenceLocation);
  const quote = nonEmptyString(item.quote, `${evidenceLocation}.quote`, { min: 8, max: 240 });
  const explanation = nonEmptyString(item.explanationRu, `${evidenceLocation}.explanationRu`, { min: 20, max: 500 });
  if (!/[А-Яа-яЁё]/u.test(explanation)) fail(evidenceLocation, 'explanationRu must contain a Russian explanation');
  return quote;
}

function assertSevenUniqueStatements(task, location) {
  plainObject(task, `${location}.task`);
  const { statements } = task;
  if (!Array.isArray(statements) || statements.length !== 7) {
    fail(location, 'task.statements must contain exactly 7 statements');
  }
  statements.forEach((statement, statementIndex) => {
    nonEmptyString(statement, `${location}.task.statements[${statementIndex}]`, { min: 12, max: 180 });
  });
  if (new Set(statements.map((statement) => statement.trim().toLocaleLowerCase('en'))).size !== 7) {
    fail(location, 'task.statements must be unique');
  }
  return statements;
}

function assertMatchingSet(set, index) {
  const location = assertSetEnvelope(set, index, {
    type: 'matching',
    idPattern: SAFE_SET_ID,
    idDescription: 'listening-pilot-v1 matching',
    idPrefix: 'listening-pilot-v1.matching.',
    audioDirectory: 'matching',
    audioPattern: SAFE_AUDIO_PATH,
  });

  if (!Array.isArray(set.script) || set.script.length !== 6) fail(location, 'script must contain exactly 6 speakers');
  const roles = new Set();
  set.script.forEach((segment, speakerIndex) => {
    const segmentLocation = `${location}.script[${speakerIndex}]`;
    plainObject(segment, segmentLocation);
    if (segment.role !== MATCHING_ROLES[speakerIndex]) {
      fail(segmentLocation, `role must be ${MATCHING_ROLES[speakerIndex]}`);
    }
    if (roles.has(segment.role)) fail(segmentLocation, 'role must be unique');
    roles.add(segment.role);
    if (!SAFE_VOICE_SLOT.test(segment.voiceSlot || '')) fail(segmentLocation, 'voiceSlot is unknown');
    nonEmptyString(segment.text, `${segmentLocation}.text`, { min: 80, max: 900 });
  });

  assertSevenUniqueStatements(set.task, location);
  const { answers, evidence } = set.task;
  if (!Array.isArray(answers) || answers.length !== 6) fail(location, 'task.answers must contain exactly 6 answers');
  if (!answers.every((answer) => Number.isSafeInteger(answer) && answer >= 0 && answer < 7)) {
    fail(location, 'task.answers must reference statement indexes 0 through 6');
  }
  if (new Set(answers).size !== 6) fail(location, 'task.answers must contain 6 unique keys and leave one extra statement');

  if (!Array.isArray(evidence) || evidence.length !== 6) fail(location, 'task.evidence must contain exactly 6 entries');
  evidence.forEach((item, speakerIndex) => {
    const evidenceLocation = `${location}.task.evidence[${speakerIndex}]`;
    const quote = evidenceQuoteAndExplanation(item, evidenceLocation);
    if (item.statementIndex !== answers[speakerIndex]) fail(evidenceLocation, 'statementIndex must equal the speaker answer');
    if (!set.script[speakerIndex].text.includes(quote)) fail(evidenceLocation, 'quote must occur verbatim in the speaker script');
  });
}

function assertTrueFalseSet(set, index) {
  const location = assertSetEnvelope(set, index, {
    type: 'true_false',
    idPattern: SAFE_TRUE_FALSE_ID,
    idDescription: 'listening-pilot-v1 true-false',
    idPrefix: 'listening-pilot-v1.true-false.',
    audioDirectory: 'true-false',
    audioPattern: SAFE_TRUE_FALSE_AUDIO_PATH,
  });

  if (!Array.isArray(set.script) || set.script.length < 2 || set.script.length > 16) {
    fail(location, 'script must contain between 2 and 16 dialogue segments');
  }
  const roles = new Set();
  const voiceByRole = new Map();
  set.script.forEach((segment, segmentIndex) => {
    const segmentLocation = `${location}.script[${segmentIndex}]`;
    plainObject(segment, segmentLocation);
    if (segment.role !== 'speaker_a' && segment.role !== 'speaker_b') {
      fail(segmentLocation, 'role must be speaker_a or speaker_b');
    }
    if (segmentIndex > 0 && segment.role === set.script[segmentIndex - 1].role) {
      fail(segmentLocation, 'dialogue roles must alternate');
    }
    roles.add(segment.role);
    if (!SAFE_VOICE_SLOT.test(segment.voiceSlot || '')) fail(segmentLocation, 'voiceSlot is unknown');
    if (voiceByRole.has(segment.role) && voiceByRole.get(segment.role) !== segment.voiceSlot) {
      fail(segmentLocation, 'each role must keep one voiceSlot throughout the dialogue');
    }
    voiceByRole.set(segment.role, segment.voiceSlot);
    nonEmptyString(segment.text, `${segmentLocation}.text`, { min: 20, max: 900 });
  });
  if (roles.size !== 2) fail(location, 'script must contain both speaker_a and speaker_b');

  assertSevenUniqueStatements(set.task, location);
  const { answers, evidence } = set.task;
  if (!Array.isArray(answers) || answers.length !== 7) {
    fail(location, 'task.answers must contain exactly 7 answers');
  }
  if (!answers.every((answer) => TRUE_FALSE_ANSWERS.includes(answer))) {
    fail(location, 'task.answers may contain only true, false or not_stated');
  }
  for (const answer of TRUE_FALSE_ANSWERS) {
    if (!answers.includes(answer)) fail(location, 'task.answers must include true, false and not_stated');
  }

  if (!Array.isArray(evidence) || evidence.length !== 7) {
    fail(location, 'task.evidence must contain exactly 7 entries');
  }
  evidence.forEach((item, statementIndex) => {
    const evidenceLocation = `${location}.task.evidence[${statementIndex}]`;
    const quote = evidenceQuoteAndExplanation(item, evidenceLocation);
    if (item.answer !== answers[statementIndex]) fail(evidenceLocation, 'answer must equal the statement answer');
    if (!set.script.some((segment) => segment.text.includes(quote))) {
      fail(evidenceLocation, 'quote must occur verbatim in the dialogue script');
    }
  });
}

function assertInterviewSet(set, index) {
  const location = assertSetEnvelope(set, index, {
    type: 'interview',
    idPattern: SAFE_INTERVIEW_ID,
    idDescription: 'listening-pilot-v1 interview',
    idPrefix: 'listening-pilot-v1.interview.',
    audioDirectory: 'interview',
    audioPattern: SAFE_INTERVIEW_AUDIO_PATH,
  });

  if (!Array.isArray(set.script) || set.script.length < 2 || set.script.length > 20) {
    fail(location, 'script must contain between 2 and 20 interview segments');
  }
  const roles = new Set();
  const voiceByRole = new Map();
  set.script.forEach((segment, segmentIndex) => {
    const segmentLocation = `${location}.script[${segmentIndex}]`;
    plainObject(segment, segmentLocation);
    if (segment.role !== 'interviewer' && segment.role !== 'guest') {
      fail(segmentLocation, 'role must be interviewer or guest');
    }
    if (segmentIndex > 0 && segment.role === set.script[segmentIndex - 1].role) {
      fail(segmentLocation, 'interview roles must alternate');
    }
    roles.add(segment.role);
    if (!SAFE_VOICE_SLOT.test(segment.voiceSlot || '')) fail(segmentLocation, 'voiceSlot is unknown');
    if (voiceByRole.has(segment.role) && voiceByRole.get(segment.role) !== segment.voiceSlot) {
      fail(segmentLocation, 'each role must keep one voiceSlot throughout the interview');
    }
    voiceByRole.set(segment.role, segment.voiceSlot);
    nonEmptyString(segment.text, `${segmentLocation}.text`, { min: 20, max: 1_400 });
  });
  if (roles.size !== 2) fail(location, 'script must contain interviewer and guest');

  plainObject(set.task, `${location}.task`);
  const { questions } = set.task;
  if (!Array.isArray(questions) || questions.length !== 7) {
    fail(location, 'task.questions must contain exactly 7 questions');
  }
  const itemIds = new Set();
  questions.forEach((question, questionIndex) => {
    const questionLocation = `${location}.task.questions[${questionIndex}]`;
    plainObject(question, questionLocation);
    const expectedId = `${set.id}.q${questionIndex + 1}`;
    if (!SAFE_INTERVIEW_ITEM_ID.test(question.id || '') || question.id !== expectedId) {
      fail(questionLocation, 'id must be a stable voice-tutor item id ending in its q1-q7 position');
    }
    if (itemIds.has(question.id)) fail(location, 'question ids must be unique');
    itemIds.add(question.id);
    nonEmptyString(question.prompt, `${questionLocation}.prompt`, { min: 12, max: 220 });
    if (!Array.isArray(question.options) || question.options.length !== 4) {
      fail(questionLocation, 'options must contain exactly 4 answers');
    }
    question.options.forEach((option, optionIndex) => {
      nonEmptyString(option, `${questionLocation}.options[${optionIndex}]`, { min: 2, max: 160 });
    });
    if (new Set(question.options.map((option) => option.trim().toLocaleLowerCase('en'))).size !== 4) {
      fail(questionLocation, 'options must be unique');
    }
    if (!Number.isSafeInteger(question.answer) || question.answer < 0 || question.answer > 3) {
      fail(questionLocation, 'answer must reference option indexes 0 through 3');
    }
    const quote = evidenceQuoteAndExplanation(question, questionLocation);
    if (!set.script.some((segment) => segment.text.includes(quote))) {
      fail(questionLocation, 'quote must occur verbatim in the interview script');
    }
  });
}

export function assertListeningCatalog(catalog, { expectedCounts = null, minimumTopics = 1 } = {}) {
  plainObject(catalog, 'catalog');
  if (catalog.id !== CATALOG_ID) fail('catalog', `id must be ${CATALOG_ID}`);
  positiveRevision(catalog.revision, 'catalog');
  if (!Array.isArray(catalog.sets)) fail('catalog', 'sets must be an array');

  const ids = new Set();
  const counts = {};
  const topics = new Set();
  catalog.sets.forEach((set, index) => {
    if (set?.type === 'matching') assertMatchingSet(set, index);
    else if (set?.type === 'true_false') assertTrueFalseSet(set, index);
    else if (set?.type === 'interview') assertInterviewSet(set, index);
    else fail(typeof set?.id === 'string' ? set.id : `sets[${index}]`, 'type must be matching, true_false or interview');
    if (ids.has(set.id)) fail(set.id, 'id must be unique inside the catalog');
    ids.add(set.id);
    counts[set.type] = (counts[set.type] || 0) + 1;
    topics.add(set.topic);
  });

  if (expectedCounts) {
    Object.entries(expectedCounts).forEach(([type, expected]) => {
      if ((counts[type] || 0) !== expected) fail('catalog', `expected ${expected} ${type} sets, received ${counts[type] || 0}`);
    });
  }
  if (topics.size < minimumTopics) fail('catalog', `must cover at least ${minimumTopics} different topics`);
  return catalog;
}

export function deepFreezeCatalog(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.values(value).forEach(deepFreezeCatalog);
  return Object.freeze(value);
}

/* Изолированный перевод описательной модели каталога в короткие legacy-поля текущего экрана. */
export function matchingSetForLegacyScreen(set) {
  assertMatchingSet(set, 0);
  return {
    id: set.id,
    revision: set.revision,
    title: set.title,
    topic: set.topic,
    cefr: set.cefr,
    provenance: set.provenance,
    audioPath: set.audio.path,
    st: set.task.statements.slice(),
    sp: set.script.map((segment) => ({
      role: segment.role,
      voiceSlot: segment.voiceSlot,
      t: segment.text,
    })),
    a: set.task.answers.slice(),
    k: set.task.evidence.map((item) => `“${item.quote}” — ${item.explanationRu}`),
    evidence: set.task.evidence.map((item) => ({ ...item })),
    maxScore: set.task.answers.length,
    evidenceSource: 'builtin',
  };
}

/* Изолированный перевод task/evidence-модели в поля существующего экрана задания 2. */
export function trueFalseSetForLegacyScreen(set) {
  assertTrueFalseSet(set, 0);
  return {
    id: set.id,
    revision: set.revision,
    title: set.title,
    topic: set.topic,
    cefr: set.cefr,
    provenance: set.provenance,
    audioPath: set.audio.path,
    d: set.script.map((segment) => ({
      role: segment.role,
      voiceSlot: segment.voiceSlot,
      s: segment.role === 'speaker_a' ? 0 : 1,
      t: segment.text,
    })),
    st: set.task.statements.map((statement, index) => ({
      t: statement,
      a: TRUE_FALSE_ANSWER_INDEX[set.task.answers[index]],
      ev: set.task.evidence[index].quote,
      e: set.task.evidence[index].explanationRu,
    })),
    evidence: set.task.evidence.map((item) => ({ ...item })),
    maxScore: set.task.answers.length,
    evidenceSource: 'builtin',
  };
}

/* Изолированный перевод модели интервью в поля существующего экрана заданий 3–9. */
export function interviewSetForLegacyScreen(set) {
  assertInterviewSet(set, 0);
  return {
    id: set.id,
    revision: set.revision,
    title: set.title,
    topic: set.topic,
    cefr: set.cefr,
    provenance: set.provenance,
    audioPath: set.audio.path,
    d: set.script.map((segment) => ({
      role: segment.role,
      voiceSlot: segment.voiceSlot,
      s: segment.role === 'interviewer' ? 0 : 1,
      t: segment.text,
    })),
    voice: { id: set.id, revision: set.revision },
    qs: set.task.questions.map((question) => ({
      q: question.prompt,
      o: question.options.slice(),
      a: question.answer,
      ev: question.quote,
      e: question.explanationRu,
      voice: { id: question.id, revision: set.revision },
    })),
    maxScore: set.task.questions.length,
    evidenceSource: 'builtin',
  };
}

async function loadCatalogSets(loadCatalog, exportName, adapter) {
  try {
    if (typeof loadCatalog !== 'function') return [];
    const catalogModule = await loadCatalog();
    const sets = catalogModule?.[exportName];
    if (!Array.isArray(sets) || !sets.length) return [];
    return sets.map(adapter);
  } catch {
    return [];
  }
}

export async function loadMatchingCatalog(loadCatalog) {
  return loadCatalogSets(loadCatalog, 'LISTENING_MATCHING_SETS', matchingSetForLegacyScreen);
}

export async function loadTrueFalseCatalog(loadCatalog) {
  return loadCatalogSets(loadCatalog, 'LISTENING_TRUE_FALSE_SETS', trueFalseSetForLegacyScreen);
}

export async function loadInterviewCatalog(loadCatalog) {
  return loadCatalogSets(loadCatalog, 'LISTENING_INTERVIEW_SETS', interviewSetForLegacyScreen);
}
