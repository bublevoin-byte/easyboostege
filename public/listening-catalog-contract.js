const CATALOG_ID = 'listening-pilot-v1';
const MATCHING_ROLES = Object.freeze([
  'speaker_a', 'speaker_b', 'speaker_c', 'speaker_d', 'speaker_e', 'speaker_f',
]);
const CEFR_LEVELS = new Set(['B1', 'B2']);
const SAFE_SET_ID = /^listening-pilot-v1\.matching\.[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const SAFE_VOICE_SLOT = /^(?:female|male)_[1-3]$/u;
const SAFE_AUDIO_PATH = /^\/audio\/listening\/listening-pilot-v1\/matching\/[a-z0-9]+(?:-[a-z0-9]+)*-r[1-9]\d*\.mp3$/u;

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

function assertMatchingSet(set, index) {
  const fallback = `sets[${index}]`;
  plainObject(set, fallback);
  const location = typeof set.id === 'string' ? set.id : fallback;
  if (!SAFE_SET_ID.test(set.id || '')) fail(location, 'id must be a safe stable id for listening-pilot-v1 matching');
  positiveRevision(set.revision, location);
  if (set.type !== 'matching') fail(location, 'type must be matching');
  if (set.provenance !== 'original') fail(location, 'provenance must be original');
  nonEmptyString(set.title, `${location}.title`, { min: 4, max: 100 });
  nonEmptyString(set.topic, `${location}.topic`, { min: 3, max: 50 });
  if (!CEFR_LEVELS.has(set.cefr)) fail(location, 'cefr must be B1 or B2');

  plainObject(set.audio, `${location}.audio`);
  const slug = set.id.replace('listening-pilot-v1.matching.', '');
  const expectedAudioPath = `/audio/listening/listening-pilot-v1/matching/${slug}-r${set.revision}.mp3`;
  if (!SAFE_AUDIO_PATH.test(set.audio.path || '') || set.audio.path.includes('..')
    || set.audio.path !== expectedAudioPath) {
    fail(location, 'audio.path must be an immutable safe MP3 path inside the matching catalog');
  }

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

  plainObject(set.task, `${location}.task`);
  const { statements, answers, evidence } = set.task;
  if (!Array.isArray(statements) || statements.length !== 7) fail(location, 'task.statements must contain exactly 7 statements');
  statements.forEach((statement, statementIndex) => {
    nonEmptyString(statement, `${location}.task.statements[${statementIndex}]`, { min: 12, max: 180 });
  });
  if (new Set(statements.map((statement) => statement.trim().toLocaleLowerCase('en'))).size !== 7) {
    fail(location, 'task.statements must be unique');
  }
  if (!Array.isArray(answers) || answers.length !== 6) fail(location, 'task.answers must contain exactly 6 answers');
  if (!answers.every((answer) => Number.isSafeInteger(answer) && answer >= 0 && answer < 7)) {
    fail(location, 'task.answers must reference statement indexes 0 through 6');
  }
  if (new Set(answers).size !== 6) fail(location, 'task.answers must contain 6 unique keys and leave one extra statement');

  if (!Array.isArray(evidence) || evidence.length !== 6) fail(location, 'task.evidence must contain exactly 6 entries');
  evidence.forEach((item, speakerIndex) => {
    const evidenceLocation = `${location}.task.evidence[${speakerIndex}]`;
    plainObject(item, evidenceLocation);
    if (item.statementIndex !== answers[speakerIndex]) fail(evidenceLocation, 'statementIndex must equal the speaker answer');
    const quote = nonEmptyString(item.quote, `${evidenceLocation}.quote`, { min: 8, max: 240 });
    if (!set.script[speakerIndex].text.includes(quote)) fail(evidenceLocation, 'quote must occur verbatim in the speaker script');
    const explanation = nonEmptyString(item.explanationRu, `${evidenceLocation}.explanationRu`, { min: 20, max: 500 });
    if (!/[А-Яа-яЁё]/u.test(explanation)) fail(evidenceLocation, 'explanationRu must contain a Russian explanation');
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
    assertMatchingSet(set, index);
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

export async function loadMatchingCatalog(loadCatalog) {
  try {
    if (typeof loadCatalog !== 'function') return [];
    const catalogModule = await loadCatalog();
    const sets = catalogModule?.LISTENING_MATCHING_SETS;
    if (!Array.isArray(sets) || !sets.length) return [];
    return sets.map(matchingSetForLegacyScreen);
  } catch {
    return [];
  }
}
