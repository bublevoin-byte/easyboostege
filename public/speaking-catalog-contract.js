export const SPEAKING_CATALOG_ID = 'speaking-pilot-v1';
export const SPEAKING_TASK1_CONTRACT_VERSION = 'speaking-task1-catalog-v1';
export const SPEAKING_TASK1_INSTRUCTION = 'Read the text aloud. You have 90 seconds to prepare and 90 seconds to read the text aloud.';
export const SPEAKING_TASK1_CEFR_COUNTS = Object.freeze({ B1: 12, B2: 36, 'B2+/C1': 12 });
export const SPEAKING_TASK2_CONTRACT_VERSION = 'speaking-task2-catalog-v1';
export const SPEAKING_TASK2_INSTRUCTION = 'Study the advertisement. You have 60 seconds to prepare. Then ask four direct questions. You have 20 seconds to ask each question.';
export const SPEAKING_TASK2_CEFR_COUNTS = Object.freeze({ B1: 12, B2: 36, 'B2+/C1': 12 });
export const SPEAKING_TASK3_CONTRACT_VERSION = 'speaking-task3-catalog-v1';
export const SPEAKING_TASK3_INSTRUCTION = 'Take part in an interview. Give a full answer to each of the five questions. You have 40 seconds to answer each question. Give 2–3 sentences for each answer.';
export const SPEAKING_TASK3_CEFR_COUNTS = Object.freeze({ B1: 12, B2: 36, 'B2+/C1': 12 });
export const SPEAKING_TASK3_CODIFIER_AREA_COUNTS = Object.freeze({
  personal_and_family_life: 11,
  education_and_careers: 11,
  culture_and_media: 14,
  travel_and_places: 9,
  science_technology_and_environment: 9,
  health_sport_and_community: 6,
});
export const SPEAKING_TASK4_CONTRACT_VERSION = 'speaking-task4-catalog-v1';
export const SPEAKING_TASK4_INSTRUCTION = 'Prepare a voice message about the photo project. Cover all four points in the plan. You have 150 seconds to prepare and up to 180 seconds to speak.';
export const SPEAKING_TASK4_CEFR_COUNTS = Object.freeze({ B1: 12, B2: 36, 'B2+/C1': 12 });

const SAFE_TASK_ID = /^speaking-pilot-v1\.task1\.[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const SAFE_TASK2_ID = /^speaking-pilot-v1\.task2\.[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const SAFE_TASK3_ID = /^speaking-pilot-v1\.task3\.[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const SAFE_TASK4_ID = /^speaking-pilot-v1\.task4\.[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const SAFE_TASK4_ASSET_ID = /^speaking-task4-photo-pair\.[a-z0-9]+(?:-[a-z0-9]+)*\.v1$/u;
const SAFE_TASK4_ASSET_PATH = /^\/assets\/speaking\/task4-v1\/[a-z0-9]+(?:-[a-z0-9]+)*\.png$/u;
const SAFE_MARKUP = /<\/?[a-z][^>]*>|javascript:|data:text\/html/iu;
const UNSAFE_TASK3_CONTENT = Object.freeze([
  ['medical advice', /\b(?:stop|skip|double|replace)\b[^?.]{0,80}\b(?:medicine|medication|treatment|prescription|doctor)\b|\b(?:medicine|medication|treatment)\b[^?.]{0,80}\bwithout\b[^?.]{0,30}\b(?:doctor|clinician)\b/iu],
  ['discriminatory stereotype', /\b(?:race|nationality|religion|gender|disability)\b[^?.]{0,80}\b(?:naturally\s+)?(?:superior|inferior|better|worse)\b/iu],
  ['time-sensitive fact', /\b(?:19|20)\d{2}\b|\bcurrent\s+(?:president|prime minister|exchange rate|price)\b/iu],
  ['sensitive or harmful subject', /\b(?:suicide|self-harm|illegal drugs|gambling|extremist propaganda)\b/iu],
]);
const TASK_KEYS = Object.freeze([
  'cefr', 'id', 'instruction', 'maxScore', 'preparationSeconds', 'provenance', 'reference',
  'responseSeconds', 'revision', 'taskType', 'text', 'topic',
]);
const TASK2_KEYS = Object.freeze([
  'advertisement', 'cefr', 'id', 'instruction', 'maxScore', 'preparationSeconds', 'provenance',
  'questionSeconds', 'revision', 'rubric', 'supports', 'taskType', 'topic',
]);
const TASK3_KEYS = Object.freeze([
  'cefr', 'codifierArea', 'completeness', 'id', 'instruction', 'maxScore', 'preparationSeconds', 'provenance',
  'questionSeconds', 'questions', 'revision', 'taskType', 'topic',
]);
const TASK4_KEYS = Object.freeze([
  'cefr', 'id', 'instruction', 'maxScore', 'photoPair', 'plan', 'preparationSeconds',
  'projectTitle', 'provenance', 'responseSeconds', 'revision', 'rubric', 'taskType', 'topic',
]);

function fail(location, message) {
  throw new Error(`SPEAKING_CATALOG_INVALID: ${location} ${message}`);
}

function plainObject(value, location) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(location, 'must be an object');
  return value;
}

function exactKeys(value, keys, location) {
  const received = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (received.join('\n') !== expected.join('\n')) fail(location, `must contain exactly ${expected.join(', ')}`);
}

function safeString(value, location, { min, max }) {
  if (typeof value !== 'string' || value !== value.trim() || value.length < min || value.length > max) {
    fail(location, `must be a trimmed string between ${min} and ${max} characters`);
  }
  if (SAFE_MARKUP.test(value)) fail(location, 'contains unsafe markup');
  return value;
}

function safeTask3Content(value, location, limits) {
  safeString(value, location, limits);
  const unsafeRule = UNSAFE_TASK3_CONTENT.find(([, pattern]) => pattern.test(value));
  if (unsafeRule) fail(location, `contains ${unsafeRule[0]}`);
  return value;
}

function wordCount(value) {
  return value.trim().split(/\s+/u).filter(Boolean).length;
}

function lexicalTokens(value) {
  return value.toLocaleLowerCase('en').match(/[a-z]+(?:'[a-z]+)?/gu) || [];
}

export function analyzeSpeakingTask1CatalogQuality(catalog) {
  const tokenLists = catalog.tasks.map((task) => lexicalTokens(task.text));
  let maximumPairSimilarity = 0;
  let sharedEightWordSequence = null;
  for (let leftIndex = 0; leftIndex < tokenLists.length; leftIndex += 1) {
    const leftTokens = tokenLists[leftIndex];
    const leftWords = new Set(leftTokens);
    const leftSequences = new Set(Array.from(
      { length: Math.max(0, leftTokens.length - 7) },
      (_, index) => leftTokens.slice(index, index + 8).join(' '),
    ));
    for (let rightIndex = leftIndex + 1; rightIndex < tokenLists.length; rightIndex += 1) {
      const rightTokens = tokenLists[rightIndex];
      const rightWords = new Set(rightTokens);
      const intersection = [...leftWords].filter((word) => rightWords.has(word)).length;
      maximumPairSimilarity = Math.max(
        maximumPairSimilarity,
        intersection / new Set([...leftWords, ...rightWords]).size,
      );
      if (!sharedEightWordSequence) {
        sharedEightWordSequence = Array.from(
          { length: Math.max(0, rightTokens.length - 7) },
          (_, index) => rightTokens.slice(index, index + 8).join(' '),
        ).find((sequence) => leftSequences.has(sequence)) || null;
      }
    }
  }
  return Object.freeze({
    uniqueOpenings: new Set(tokenLists.map((tokens) => tokens.slice(0, 4).join(' '))).size,
    uniqueTopics: new Set(catalog.tasks.map((task) => task.topic.toLocaleLowerCase('ru-RU'))).size,
    minimumLexicalDiversity: Math.min(...tokenLists.map((tokens) => new Set(tokens).size / tokens.length)),
    maximumPairSimilarity,
    sharedEightWordSequence,
  });
}

export function analyzeSpeakingTask2CatalogQuality(catalog) {
  const supportSets = catalog.tasks.map((task) => task.supports.join('\n').toLocaleLowerCase('en'));
  const repeatedSupportSet = supportSets.find((set, index) => supportSets.indexOf(set) !== index) || null;
  return Object.freeze({
    uniqueAdvertisements: new Set(catalog.tasks.map((task) => task.advertisement)).size,
    uniqueSupportSets: new Set(supportSets).size,
    uniqueTopics: new Set(catalog.tasks.map((task) => task.topic.toLocaleLowerCase('ru-RU'))).size,
    supportsChecked: catalog.tasks.reduce((count, task) => count + task.supports.length, 0),
    sharedFourSupportSequence: repeatedSupportSet,
  });
}

export function analyzeSpeakingTask3CatalogQuality(catalog) {
  const questionSets = catalog.tasks.map((task) => task.questions.join('\n').toLocaleLowerCase('en'));
  const questionTokens = catalog.tasks.flatMap((task) => task.questions.map(lexicalTokens));
  const repeatedQuestionSet = questionSets.find((set, index) => questionSets.indexOf(set) !== index) || null;
  const openings = questionTokens.map((tokens) => tokens.slice(0, 4).join(' '));
  const openingCounts = openings.reduce((counts, opening) => (
    counts.set(opening, (counts.get(opening) || 0) + 1)
  ), new Map());
  const seenSequences = new Set();
  let sharedSixWordSequence = null;
  for (const tokens of questionTokens) {
    const currentSequences = new Set(Array.from(
      { length: Math.max(0, tokens.length - 5) },
      (_, index) => tokens.slice(index, index + 6).join(' '),
    ));
    if (!sharedSixWordSequence) {
      sharedSixWordSequence = [...currentSequences].find((sequence) => seenSequences.has(sequence)) || null;
    }
    currentSequences.forEach((sequence) => seenSequences.add(sequence));
  }
  const codifierAreaCounts = Object.fromEntries(
    Object.keys(SPEAKING_TASK3_CODIFIER_AREA_COUNTS).map((area) => [
      area, catalog.tasks.filter((task) => task.codifierArea === area).length,
    ]),
  );
  return Object.freeze({
    uniqueInterviewSets: new Set(questionSets).size,
    uniqueQuestions: new Set(catalog.tasks.flatMap((task) => (
      task.questions.map((question) => question.toLocaleLowerCase('en'))
    ))).size,
    uniqueTopics: new Set(catalog.tasks.map((task) => task.topic.toLocaleLowerCase('ru-RU'))).size,
    codifierAreaCounts,
    missingCodifierAreas: Object.entries(codifierAreaCounts)
      .filter(([, count]) => count === 0).map(([area]) => area),
    completenessChecks: catalog.tasks.reduce((count, task) => count + task.completeness.length, 0),
    sharedFiveQuestionSequence: repeatedQuestionSet,
    sharedSixWordSequence,
    maximumFourWordOpeningCount: Math.max(...openingCounts.values()),
  });
}

export function assertSpeakingTask1(task, location = 'task') {
  plainObject(task, location);
  exactKeys(task, TASK_KEYS, location);
  if (!SAFE_TASK_ID.test(task.id || '')) fail(`${location}.id`, 'must be a stable speaking-pilot-v1 task 1 id');
  if (task.revision !== 1) fail(`${location}.revision`, 'must be 1');
  if (task.taskType !== 1) fail(`${location}.taskType`, 'must be 1');
  if (!Object.hasOwn(SPEAKING_TASK1_CEFR_COUNTS, task.cefr)) fail(`${location}.cefr`, 'is unsupported');
  safeString(task.topic, `${location}.topic`, { min: 3, max: 80 });
  if (task.preparationSeconds !== 90) fail(`${location}.preparationSeconds`, 'must be 90');
  if (task.responseSeconds !== 90) fail(`${location}.responseSeconds`, 'must be 90');
  if (task.maxScore !== 1) fail(`${location}.maxScore`, 'must be 1');
  if (task.instruction !== SPEAKING_TASK1_INSTRUCTION) fail(`${location}.instruction`, 'must use the task 1 instruction');
  safeString(task.text, `${location}.text`, { min: 300, max: 1_200 });
  const words = wordCount(task.text);
  if (words < 70 || words > 160) fail(`${location}.text`, 'must contain between 70 and 160 words');
  if ((task.text.match(/[.!?](?:\s|$)/gu) || []).length < 4) fail(`${location}.text`, 'must contain at least four sentences');

  plainObject(task.provenance, `${location}.provenance`);
  exactKeys(task.provenance, ['author', 'createdAt', 'kind', 'reviewStatus'], `${location}.provenance`);
  if (task.provenance.kind !== 'original' || task.provenance.author !== 'Easy Boost') {
    fail(`${location}.provenance`, 'must identify original Easy Boost material');
  }
  if (task.provenance.createdAt !== '2026-08-06' || task.provenance.reviewStatus !== 'automatically_checked') {
    fail(`${location}.provenance`, 'must contain the catalog review metadata');
  }

  plainObject(task.reference, `${location}.reference`);
  exactKeys(task.reference, ['assessmentStatus', 'methodicalProfile', 'script'], `${location}.reference`);
  safeString(task.reference.script, `${location}.reference.script`, { min: 300, max: 1_200 });
  if (task.reference.script !== task.text) fail(`${location}.reference.script`, 'must match the reading text');
  if (task.reference.methodicalProfile !== 'ege-2026-task1-v1') fail(`${location}.reference.methodicalProfile`, 'is unsupported');
  if (task.reference.assessmentStatus !== 'provider_not_connected') fail(`${location}.reference.assessmentStatus`, 'must be provider_not_connected');
  return task;
}

export function assertSpeakingTask1Catalog(catalog) {
  plainObject(catalog, 'catalog');
  exactKeys(catalog, ['contractVersion', 'format', 'id', 'revision', 'tasks'], 'catalog');
  if (catalog.id !== SPEAKING_CATALOG_ID) fail('catalog.id', `must be ${SPEAKING_CATALOG_ID}`);
  if (catalog.revision !== 1) fail('catalog.revision', 'must be 1');
  if (catalog.contractVersion !== SPEAKING_TASK1_CONTRACT_VERSION) fail('catalog.contractVersion', 'is unsupported');
  plainObject(catalog.format, 'catalog.format');
  exactKeys(catalog.format, ['exam', 'maxScore', 'preparationSeconds', 'responseSeconds', 'source', 'sourceRevision', 'taskType'], 'catalog.format');
  if (catalog.format.exam !== 'ege-english-2026' || catalog.format.taskType !== 1
    || catalog.format.preparationSeconds !== 90 || catalog.format.responseSeconds !== 90
    || catalog.format.maxScore !== 1 || catalog.format.source !== 'fipi-ege-2026'
    || catalog.format.sourceRevision !== '2026-08-06') {
    fail('catalog.format', 'must match the fixed EGE-2026 task 1 contract');
  }
  if (!Array.isArray(catalog.tasks) || catalog.tasks.length !== 60) fail('catalog.tasks', 'must contain exactly 60 tasks');

  const ids = new Set();
  const texts = new Set();
  const counts = Object.fromEntries(Object.keys(SPEAKING_TASK1_CEFR_COUNTS).map((cefr) => [cefr, 0]));
  catalog.tasks.forEach((task, index) => {
    assertSpeakingTask1(task, `catalog.tasks[${index}]`);
    if (ids.has(task.id)) fail('catalog.tasks', 'id must be unique');
    if (texts.has(task.text)) fail('catalog.tasks', 'text must be unique');
    ids.add(task.id);
    texts.add(task.text);
    counts[task.cefr] += 1;
  });
  for (const [cefr, expected] of Object.entries(SPEAKING_TASK1_CEFR_COUNTS)) {
    if (counts[cefr] !== expected) fail('catalog.tasks', `must contain ${expected} ${cefr} tasks`);
  }
  return catalog;
}

export function speakingTask1PublicAssignment(task) {
  assertSpeakingTask1(task);
  return Object.freeze({
    id: task.id,
    revision: task.revision,
    taskType: task.taskType,
    cefr: task.cefr,
    topic: task.topic,
    preparationSeconds: task.preparationSeconds,
    responseSeconds: task.responseSeconds,
    maxScore: task.maxScore,
    instruction: task.instruction,
    text: task.text,
  });
}

export function assertSpeakingTask2(task, location = 'task') {
  plainObject(task, location);
  exactKeys(task, TASK2_KEYS, location);
  if (!SAFE_TASK2_ID.test(task.id || '')) fail(`${location}.id`, 'must be a stable speaking-pilot-v1 task 2 id');
  if (task.revision !== 1) fail(`${location}.revision`, 'must be 1');
  if (task.taskType !== 2) fail(`${location}.taskType`, 'must be 2');
  if (!Object.hasOwn(SPEAKING_TASK2_CEFR_COUNTS, task.cefr)) fail(`${location}.cefr`, 'is unsupported');
  safeString(task.topic, `${location}.topic`, { min: 3, max: 80 });
  if (task.preparationSeconds !== 60) fail(`${location}.preparationSeconds`, 'must be 60');
  if (task.questionSeconds !== 20) fail(`${location}.questionSeconds`, 'must be 20');
  if (task.maxScore !== 4) fail(`${location}.maxScore`, 'must be 4');
  if (task.instruction !== SPEAKING_TASK2_INSTRUCTION) fail(`${location}.instruction`, 'must use the task 2 instruction');
  safeString(task.advertisement, `${location}.advertisement`, { min: 40, max: 600 });
  if (!Array.isArray(task.supports) || task.supports.length !== 4) fail(`${location}.supports`, 'must contain exactly four supports');
  task.supports.forEach((support, index) => safeString(support, `${location}.supports[${index}]`, { min: 3, max: 80 }));
  if (new Set(task.supports.map((support) => support.toLocaleLowerCase('en'))).size !== 4) {
    fail(`${location}.supports`, 'must be unique within the task');
  }

  plainObject(task.rubric, `${location}.rubric`);
  exactKeys(task.rubric, ['directQuestionRequired', 'perQuestionMaxScore', 'questionCount'], `${location}.rubric`);
  if (task.rubric.questionCount !== 4 || task.rubric.perQuestionMaxScore !== 1
    || task.rubric.directQuestionRequired !== true) {
    fail(`${location}.rubric`, 'must define four separately scored direct questions');
  }

  plainObject(task.provenance, `${location}.provenance`);
  exactKeys(task.provenance, ['author', 'createdAt', 'kind', 'reviewStatus'], `${location}.provenance`);
  if (task.provenance.kind !== 'original' || task.provenance.author !== 'Easy Boost'
    || task.provenance.createdAt !== '2026-08-06'
    || task.provenance.reviewStatus !== 'automatically_checked') {
    fail(`${location}.provenance`, 'must identify automatically checked original Easy Boost material');
  }

  return task;
}

export function assertSpeakingTask2Catalog(catalog) {
  plainObject(catalog, 'catalog');
  exactKeys(catalog, ['contractVersion', 'format', 'id', 'revision', 'tasks'], 'catalog');
  if (catalog.id !== SPEAKING_CATALOG_ID) fail('catalog.id', `must be ${SPEAKING_CATALOG_ID}`);
  if (catalog.revision !== 1) fail('catalog.revision', 'must be 1');
  if (catalog.contractVersion !== SPEAKING_TASK2_CONTRACT_VERSION) fail('catalog.contractVersion', 'is unsupported');
  plainObject(catalog.format, 'catalog.format');
  exactKeys(catalog.format, [
    'exam', 'maxScore', 'preparationSeconds', 'questionCount', 'questionSeconds',
    'source', 'sourceRevision', 'taskType',
  ], 'catalog.format');
  if (catalog.format.exam !== 'ege-english-2026' || catalog.format.taskType !== 2
    || catalog.format.preparationSeconds !== 60 || catalog.format.questionSeconds !== 20
    || catalog.format.questionCount !== 4 || catalog.format.maxScore !== 4
    || catalog.format.source !== 'fipi-ege-2026' || catalog.format.sourceRevision !== '2026-08-06') {
    fail('catalog.format', 'must match the fixed EGE-2026 task 2 four-question contract');
  }
  if (!Array.isArray(catalog.tasks) || catalog.tasks.length !== 60) fail('catalog.tasks', 'must contain exactly 60 tasks');

  const ids = new Set();
  const advertisements = new Set();
  const supportSets = new Set();
  const counts = Object.fromEntries(Object.keys(SPEAKING_TASK2_CEFR_COUNTS).map((cefr) => [cefr, 0]));
  catalog.tasks.forEach((task, index) => {
    assertSpeakingTask2(task, `catalog.tasks[${index}]`);
    const advertisementKey = task.advertisement.toLocaleLowerCase('en');
    const supportKey = task.supports.join('\n').toLocaleLowerCase('en');
    if (ids.has(task.id)) fail('catalog.tasks', 'id must be unique');
    if (advertisements.has(advertisementKey)) fail('catalog.tasks', 'advertisement must be unique');
    if (supportSets.has(supportKey)) fail('catalog.tasks', 'four-support sequence must be unique');
    ids.add(task.id);
    advertisements.add(advertisementKey);
    supportSets.add(supportKey);
    counts[task.cefr] += 1;
  });
  for (const [cefr, expected] of Object.entries(SPEAKING_TASK2_CEFR_COUNTS)) {
    if (counts[cefr] !== expected) fail('catalog.tasks', `must contain ${expected} ${cefr} tasks`);
  }
  return catalog;
}

export function speakingTask2PublicAssignment(task) {
  assertSpeakingTask2(task);
  return Object.freeze({
    id: task.id,
    revision: task.revision,
    taskType: task.taskType,
    cefr: task.cefr,
    topic: task.topic,
    preparationSeconds: task.preparationSeconds,
    questionSeconds: task.questionSeconds,
    maxScore: task.maxScore,
    instruction: task.instruction,
    advertisement: task.advertisement,
    supports: Object.freeze([...task.supports]),
  });
}

export function assertSpeakingTask3(task, location = 'task') {
  plainObject(task, location);
  exactKeys(task, TASK3_KEYS, location);
  if (!SAFE_TASK3_ID.test(task.id || '')) fail(`${location}.id`, 'must be a stable speaking-pilot-v1 task 3 id');
  if (task.revision !== 1) fail(`${location}.revision`, 'must be 1');
  if (task.taskType !== 3) fail(`${location}.taskType`, 'must be 3');
  if (!Object.hasOwn(SPEAKING_TASK3_CEFR_COUNTS, task.cefr)) fail(`${location}.cefr`, 'is unsupported');
  if (!Object.hasOwn(SPEAKING_TASK3_CODIFIER_AREA_COUNTS, task.codifierArea)) {
    fail(`${location}.codifierArea`, 'must identify a supported EGE codifier area');
  }
  safeTask3Content(task.topic, `${location}.topic`, { min: 3, max: 80 });
  if (task.preparationSeconds !== 0) fail(`${location}.preparationSeconds`, 'must be 0');
  if (task.questionSeconds !== 40) fail(`${location}.questionSeconds`, 'must be 40');
  if (task.maxScore !== 5) fail(`${location}.maxScore`, 'must be 5');
  if (task.instruction !== SPEAKING_TASK3_INSTRUCTION) fail(`${location}.instruction`, 'must use the task 3 instruction');
  if (!Array.isArray(task.questions) || task.questions.length !== 5) {
    fail(`${location}.questions`, 'must contain exactly five questions');
  }
  task.questions.forEach((question, index) => {
    safeTask3Content(question, `${location}.questions[${index}]`, { min: 12, max: 180 });
    if (!question.endsWith('?')) fail(`${location}.questions[${index}]`, 'must be a question');
    const words = wordCount(question);
    if (words < 4 || words > 30) fail(`${location}.questions[${index}]`, 'must contain between 4 and 30 words');
  });
  if (new Set(task.questions.map((question) => question.toLocaleLowerCase('en'))).size !== 5) {
    fail(`${location}.questions`, 'must be unique within the interview');
  }

  if (!Array.isArray(task.completeness) || task.completeness.length !== 5) {
    fail(`${location}.completeness`, 'must contain exactly five checks');
  }
  task.completeness.forEach((check, index) => {
    plainObject(check, `${location}.completeness[${index}]`);
    exactKeys(check, [
      'maximumSentences', 'minimumSentences', 'questionNumber', 'requiredElements',
    ], `${location}.completeness[${index}]`);
    if (check.questionNumber !== index + 1 || check.minimumSentences !== 2 || check.maximumSentences !== 3) {
      fail(`${location}.completeness[${index}]`, 'must require 2–3 sentences for its question');
    }
    if (!Array.isArray(check.requiredElements)
      || check.requiredElements.join(',') !== 'direct_answer,supporting_detail') {
      fail(`${location}.completeness[${index}].requiredElements`, 'must require a direct answer and supporting detail');
    }
  });

  plainObject(task.provenance, `${location}.provenance`);
  exactKeys(task.provenance, ['author', 'createdAt', 'kind', 'reviewStatus'], `${location}.provenance`);
  if (task.provenance.kind !== 'original' || task.provenance.author !== 'Easy Boost'
    || task.provenance.createdAt !== '2026-08-06'
    || task.provenance.reviewStatus !== 'automatically_checked') {
    fail(`${location}.provenance`, 'must identify automatically checked original Easy Boost material');
  }
  return task;
}

export function assertSpeakingTask3Catalog(catalog) {
  plainObject(catalog, 'catalog');
  exactKeys(catalog, ['contractVersion', 'format', 'id', 'revision', 'tasks'], 'catalog');
  if (catalog.id !== SPEAKING_CATALOG_ID) fail('catalog.id', `must be ${SPEAKING_CATALOG_ID}`);
  if (catalog.revision !== 1) fail('catalog.revision', 'must be 1');
  if (catalog.contractVersion !== SPEAKING_TASK3_CONTRACT_VERSION) fail('catalog.contractVersion', 'is unsupported');
  plainObject(catalog.format, 'catalog.format');
  exactKeys(catalog.format, [
    'exam', 'maxScore', 'preparationSeconds', 'questionCount', 'questionSeconds',
    'source', 'sourceRevision', 'taskType',
  ], 'catalog.format');
  if (catalog.format.exam !== 'ege-english-2026' || catalog.format.taskType !== 3
    || catalog.format.preparationSeconds !== 0 || catalog.format.questionSeconds !== 40
    || catalog.format.questionCount !== 5 || catalog.format.maxScore !== 5
    || catalog.format.source !== 'fipi-ege-2026' || catalog.format.sourceRevision !== '2026-08-06') {
    fail('catalog.format', 'must match the fixed EGE-2026 task 3 five-answer contract');
  }
  if (!Array.isArray(catalog.tasks) || catalog.tasks.length !== 60) fail('catalog.tasks', 'must contain exactly 60 tasks');

  const ids = new Set();
  const questionSets = new Set();
  const questions = new Set();
  const counts = Object.fromEntries(Object.keys(SPEAKING_TASK3_CEFR_COUNTS).map((cefr) => [cefr, 0]));
  const codifierCounts = Object.fromEntries(
    Object.keys(SPEAKING_TASK3_CODIFIER_AREA_COUNTS).map((area) => [area, 0]),
  );
  catalog.tasks.forEach((task, index) => {
    assertSpeakingTask3(task, `catalog.tasks[${index}]`);
    const questionSetKey = task.questions.join('\n').toLocaleLowerCase('en');
    if (ids.has(task.id)) fail('catalog.tasks', 'id must be unique');
    if (questionSets.has(questionSetKey)) fail('catalog.tasks', 'five-question sequence must be unique');
    task.questions.forEach((question) => {
      const questionKey = question.toLocaleLowerCase('en');
      if (questions.has(questionKey)) fail('catalog.tasks', 'questions must be unique across interviews');
      questions.add(questionKey);
    });
    ids.add(task.id);
    questionSets.add(questionSetKey);
    counts[task.cefr] += 1;
    codifierCounts[task.codifierArea] += 1;
  });
  for (const [cefr, expected] of Object.entries(SPEAKING_TASK3_CEFR_COUNTS)) {
    if (counts[cefr] !== expected) fail('catalog.tasks', `must contain ${expected} ${cefr} tasks`);
  }
  for (const [area, expected] of Object.entries(SPEAKING_TASK3_CODIFIER_AREA_COUNTS)) {
    if (codifierCounts[area] !== expected) {
      fail('catalog.tasks', `must contain ${expected} tasks for codifier area ${area}`);
    }
  }
  return catalog;
}

export function speakingTask3PublicAssignment(task) {
  assertSpeakingTask3(task);
  return Object.freeze({
    id: task.id,
    revision: task.revision,
    taskType: task.taskType,
    cefr: task.cefr,
    topic: task.topic,
    preparationSeconds: task.preparationSeconds,
    questionSeconds: task.questionSeconds,
    maxScore: task.maxScore,
    instruction: task.instruction,
    questions: Object.freeze([...task.questions]),
  });
}

export function assertSpeakingTask4(task, location = 'task') {
  plainObject(task, location);
  exactKeys(task, TASK4_KEYS, location);
  if (!SAFE_TASK4_ID.test(task.id || '')) fail(`${location}.id`, 'must be a stable speaking-pilot-v1 task 4 id');
  if (task.revision !== 1) fail(`${location}.revision`, 'must be 1');
  if (task.taskType !== 4) fail(`${location}.taskType`, 'must be 4');
  if (!Object.hasOwn(SPEAKING_TASK4_CEFR_COUNTS, task.cefr)) fail(`${location}.cefr`, 'is unsupported');
  safeString(task.topic, `${location}.topic`, { min: 3, max: 100 });
  safeString(task.projectTitle, `${location}.projectTitle`, { min: 8, max: 120 });
  if (task.preparationSeconds !== 150) fail(`${location}.preparationSeconds`, 'must be 150');
  if (task.responseSeconds !== 180) fail(`${location}.responseSeconds`, 'must be 180');
  if (task.maxScore !== 10) fail(`${location}.maxScore`, 'must be 10');
  if (task.instruction !== SPEAKING_TASK4_INSTRUCTION) fail(`${location}.instruction`, 'must use the task 4 instruction');

  if (!Array.isArray(task.plan) || task.plan.length !== 4) fail(`${location}.plan`, 'must contain exactly four points');
  task.plan.forEach((point, index) => {
    safeString(point, `${location}.plan[${index}]`, { min: 1, max: 220 });
    if (point.length < 30 || wordCount(point) < 6) fail(`${location}.plan[${index}]`, 'must be substantive');
  });
  if (new Set(task.plan.map((point) => point.toLocaleLowerCase('en'))).size !== 4) {
    fail(`${location}.plan`, 'must contain four distinct substantive points');
  }

  plainObject(task.rubric, `${location}.rubric`);
  exactKeys(task.rubric, ['content', 'language', 'organisation', 'zeroContentMeansZero'], `${location}.rubric`);
  for (const [criterion, maximum] of [['content', 4], ['organisation', 3], ['language', 3]]) {
    plainObject(task.rubric[criterion], `${location}.rubric.${criterion}`);
    exactKeys(task.rubric[criterion], ['maxScore'], `${location}.rubric.${criterion}`);
    if (task.rubric[criterion].maxScore !== maximum) fail(`${location}.rubric`, 'must use the EGE 4/3/3 rubric');
  }
  if (task.rubric.zeroContentMeansZero !== true) fail(`${location}.rubric`, 'must apply the zero-content rule');

  plainObject(task.photoPair, `${location}.photoPair`);
  exactKeys(task.photoPair, ['alt', 'assetId', 'panels', 'src'], `${location}.photoPair`);
  if (!SAFE_TASK4_ASSET_ID.test(task.photoPair.assetId || '')) fail(`${location}.photoPair.assetId`, 'must be a stable local speaking asset id');
  if (!SAFE_TASK4_ASSET_PATH.test(task.photoPair.src || '')) fail(`${location}.photoPair.src`, 'must be a local speaking asset');
  safeString(task.photoPair.alt, `${location}.photoPair.alt`, { min: 20, max: 260 });
  if (!Array.isArray(task.photoPair.panels) || task.photoPair.panels.length !== 2) {
    fail(`${location}.photoPair.panels`, 'must contain exactly two photo panels');
  }
  task.photoPair.panels.forEach((panel, index) => {
    plainObject(panel, `${location}.photoPair.panels[${index}]`);
    exactKeys(panel, ['alt', 'number'], `${location}.photoPair.panels[${index}]`);
    if (panel.number !== index + 1) fail(`${location}.photoPair.panels[${index}].number`, 'must match panel order');
    safeString(panel.alt, `${location}.photoPair.panels[${index}].alt`, { min: 15, max: 180 });
  });

  plainObject(task.provenance, `${location}.provenance`);
  exactKeys(task.provenance, ['author', 'createdAt', 'kind', 'reviewStatus'], `${location}.provenance`);
  if (task.provenance.kind !== 'original' || task.provenance.author !== 'Easy Boost'
    || task.provenance.createdAt !== '2026-08-06'
    || task.provenance.reviewStatus !== 'automatically_checked') {
    fail(`${location}.provenance`, 'must identify automatically checked original Easy Boost material');
  }
  return task;
}

export function assertSpeakingTask4Catalog(catalog) {
  plainObject(catalog, 'catalog');
  exactKeys(catalog, ['contractVersion', 'format', 'id', 'revision', 'tasks'], 'catalog');
  if (catalog.id !== SPEAKING_CATALOG_ID) fail('catalog.id', `must be ${SPEAKING_CATALOG_ID}`);
  if (catalog.revision !== 1) fail('catalog.revision', 'must be 1');
  if (catalog.contractVersion !== SPEAKING_TASK4_CONTRACT_VERSION) fail('catalog.contractVersion', 'is unsupported');
  plainObject(catalog.format, 'catalog.format');
  exactKeys(catalog.format, [
    'exam', 'maxScore', 'photoCount', 'planPointCount', 'preparationSeconds', 'responseSeconds',
    'source', 'sourceRevision', 'taskType',
  ], 'catalog.format');
  if (catalog.format.exam !== 'ege-english-2026' || catalog.format.taskType !== 4
    || catalog.format.preparationSeconds !== 150 || catalog.format.responseSeconds !== 180
    || catalog.format.photoCount !== 2 || catalog.format.planPointCount !== 4
    || catalog.format.maxScore !== 10 || catalog.format.source !== 'fipi-ege-2026'
    || catalog.format.sourceRevision !== '2026-08-06') {
    fail('catalog.format', 'must match the fixed EGE-2026 task 4 contract');
  }
  if (!Array.isArray(catalog.tasks) || catalog.tasks.length !== 60) fail('catalog.tasks', 'must contain exactly 60 tasks');

  const ids = new Set();
  const projects = new Set();
  const assets = new Set();
  const counts = Object.fromEntries(Object.keys(SPEAKING_TASK4_CEFR_COUNTS).map((cefr) => [cefr, 0]));
  catalog.tasks.forEach((task, index) => {
    assertSpeakingTask4(task, `catalog.tasks[${index}]`);
    const projectKey = task.projectTitle.toLocaleLowerCase('en');
    if (ids.has(task.id)) fail('catalog.tasks', 'id must be unique');
    if (projects.has(projectKey)) fail('catalog.tasks', 'project title must be unique');
    if (assets.has(task.photoPair.assetId)) fail('catalog.tasks', 'photo-pair asset must be unique');
    ids.add(task.id);
    projects.add(projectKey);
    assets.add(task.photoPair.assetId);
    counts[task.cefr] += 1;
  });
  for (const [cefr, expected] of Object.entries(SPEAKING_TASK4_CEFR_COUNTS)) {
    if (counts[cefr] !== expected) fail('catalog.tasks', `must contain ${expected} ${cefr} tasks`);
  }
  return catalog;
}

export function speakingTask4PublicAssignment(task) {
  assertSpeakingTask4(task);
  return Object.freeze({
    id: task.id,
    revision: task.revision,
    taskType: task.taskType,
    cefr: task.cefr,
    topic: task.topic,
    projectTitle: task.projectTitle,
    preparationSeconds: task.preparationSeconds,
    responseSeconds: task.responseSeconds,
    maxScore: task.maxScore,
    instruction: task.instruction,
    photoPair: Object.freeze({
      assetId: task.photoPair.assetId,
      src: task.photoPair.src,
      alt: task.photoPair.alt,
      panels: Object.freeze(task.photoPair.panels.map((panel) => Object.freeze({ ...panel }))),
    }),
    plan: Object.freeze([...task.plan]),
  });
}

export function deepFreezeSpeakingCatalog(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.values(value).forEach(deepFreezeSpeakingCatalog);
  return Object.freeze(value);
}
