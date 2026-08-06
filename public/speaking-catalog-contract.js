export const SPEAKING_CATALOG_ID = 'speaking-pilot-v1';
export const SPEAKING_TASK1_CONTRACT_VERSION = 'speaking-task1-catalog-v1';
export const SPEAKING_TASK1_INSTRUCTION = 'Read the text aloud. You have 90 seconds to prepare and 90 seconds to read the text aloud.';
export const SPEAKING_TASK1_CEFR_COUNTS = Object.freeze({ B1: 12, B2: 36, 'B2+/C1': 12 });

const SAFE_TASK_ID = /^speaking-pilot-v1\.task1\.[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const SAFE_MARKUP = /<\/?[a-z][^>]*>|javascript:|data:text\/html/iu;
const TASK_KEYS = Object.freeze([
  'cefr', 'id', 'instruction', 'maxScore', 'preparationSeconds', 'provenance', 'reference',
  'responseSeconds', 'revision', 'taskType', 'text', 'topic',
]);

function fail(location, message) {
  throw new Error(`SPEAKING_TASK1_CATALOG_INVALID: ${location} ${message}`);
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

export function deepFreezeSpeakingCatalog(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.values(value).forEach(deepFreezeSpeakingCatalog);
  return Object.freeze(value);
}
