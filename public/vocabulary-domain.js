export const VOCABULARY_MASTERY_VERSION = 1;

export const VOCABULARY_DIMENSIONS = Object.freeze([
  'meaning', 'spelling', 'context', 'listening',
]);

export const VOCABULARY_EVIDENCE_LEVELS = Object.freeze([
  'none', 'preliminary', 'guided', 'self_reported', 'objective',
]);

export const VOCABULARY_MODES = Object.freeze([
  'receptive_meaning', 'russian_reveal', 'english_production',
  'contextual_production', 'listening',
]);

export const VOCABULARY_OUTCOMES = Object.freeze([
  'correct', 'knew', 'almost', 'incorrect', 'not_known',
]);

const LEGACY_STAGE_SCORES = Object.freeze([0, 15, 30, 45, 60, 70]);
const EVIDENCE_LEVELS = new Set(VOCABULARY_EVIDENCE_LEVELS);
const EVIDENCE_RANK = Object.freeze({
  none: 0, preliminary: 1, guided: 2, self_reported: 2, objective: 3,
});
const VOCABULARY_OUTCOME_SET = new Set(VOCABULARY_OUTCOMES);
const MODE_RULES = Object.freeze({
  receptive_meaning: Object.freeze({ dimension: 'meaning', evidence: 'guided', correctDelta: 8 }),
  russian_reveal: Object.freeze({ dimension: 'meaning', evidence: 'self_reported', correctDelta: 10 }),
  english_production: Object.freeze({ dimension: 'spelling', evidence: 'objective', correctDelta: 20 }),
  contextual_production: Object.freeze({ dimension: 'context', evidence: 'objective', correctDelta: 20 }),
  listening: Object.freeze({ dimension: 'listening', evidence: 'objective', correctDelta: 20 }),
});
const FAILURE_OUTCOMES = new Set(['almost', 'incorrect', 'not_known']);

function boundedInteger(value, minimum, maximum, fallback = minimum) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.round(number)));
}

function nullableTimestamp(value) {
  if (value == null || value === '') return null;
  const timestamp = value instanceof Date ? value.getTime() : Number(value);
  return Number.isSafeInteger(timestamp) && timestamp >= 0 ? timestamp : null;
}

export function normalizeVocabularyWord(value) {
  return String(value || '')
    .normalize('NFKC')
    .trim()
    .replace(/\s+/gu, ' ')
    .replace(/^to\s+/iu, '')
    .toLocaleLowerCase('en');
}

export function normalizeEnglishAnswer(value) {
  return normalizeVocabularyWord(value);
}

function normalizeFreeText(value) {
  return String(value || '').normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase();
}

function isOneEditAway(left, right) {
  if (Math.abs(left.length - right.length) > 1) return false;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    let rowMinimum = current[0];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const substitution = previous[rightIndex - 1]
        + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1);
      current[rightIndex] = Math.min(
        previous[rightIndex] + 1,
        current[rightIndex - 1] + 1,
        substitution,
      );
      rowMinimum = Math.min(rowMinimum, current[rightIndex]);
    }
    if (rowMinimum > 1) return false;
    previous = current;
  }
  return previous[right.length] === 1;
}

export function gradeVocabularyAnswer({
  mode, answer, acceptedAnswers = [], selfRating = null, notKnown = false,
} = {}) {
  if (mode === 'russian_reveal') {
    const normalizedAnswer = normalizeFreeText(answer);
    const outcome = ['knew', 'almost', 'not_known'].includes(selfRating) ? selfRating : null;
    return {
      outcome,
      normalizedAnswer,
      independentSuccess: false,
      requiresSelfRating: outcome == null,
    };
  }
  if (!MODE_RULES[mode]) throw new TypeError('Unsupported vocabulary answer mode');
  const normalizedAnswer = normalizeEnglishAnswer(answer);
  if (notKnown) return { outcome: 'not_known', normalizedAnswer, independentSuccess: false };
  const accepted = (Array.isArray(acceptedAnswers) ? acceptedAnswers : [])
    .map(normalizeEnglishAnswer)
    .filter(Boolean);
  if (accepted.includes(normalizedAnswer)) {
    return {
      outcome: 'correct',
      normalizedAnswer,
      independentSuccess: MODE_RULES[mode].evidence === 'objective',
    };
  }
  const nearTypo = normalizedAnswer.length >= 4
    && accepted.some((candidate) => candidate.length >= 5 && isOneEditAway(normalizedAnswer, candidate));
  return {
    outcome: nearTypo ? 'almost' : 'incorrect',
    normalizedAnswer,
    independentSuccess: false,
  };
}

function preliminaryDimension(score, attempts = 0) {
  return {
    score,
    attempts,
    independentSuccesses: 0,
    evidence: score > 0 || attempts > 0 ? 'preliminary' : 'none',
    lastPracticedAt: null,
  };
}

function normalizeDimension(value, fallbackScore = 0) {
  const dimension = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const evidence = EVIDENCE_LEVELS.has(dimension.evidence) ? dimension.evidence : 'none';
  return {
    score: boundedInteger(dimension.score, 0, 100, fallbackScore),
    attempts: boundedInteger(dimension.attempts, 0, 1_000_000),
    independentSuccesses: boundedInteger(dimension.independentSuccesses, 0, 1_000_000),
    evidence,
    lastPracticedAt: nullableTimestamp(dimension.lastPracticedAt),
  };
}

export function migrateVocabularyProgress(input) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const word = normalizeVocabularyWord(source.word);
  const stage = boundedInteger(source.stage, 0, 5);
  const errorCount = boundedInteger(source.errorCount ?? source.error_count, 0, 1_000_000);
  const reviewCount = boundedInteger(source.reviewCount ?? source.review_count, 0, 1_000_000);
  const dueAt = nullableTimestamp(source.dueAt ?? source.due_at);
  const version = Number(source.masteryVersion ?? source.mastery_version ?? 0);

  if (version === VOCABULARY_MASTERY_VERSION && source.dimensions) {
    return {
      masteryVersion: VOCABULARY_MASTERY_VERSION,
      word,
      stage,
      errorCount,
      reviewCount,
      dueAt,
      dimensions: Object.fromEntries(VOCABULARY_DIMENSIONS.map((dimension) => [
        dimension, normalizeDimension(source.dimensions[dimension]),
      ])),
      lastMode: Object.hasOwn(MODE_RULES, source.lastMode ?? source.last_mode)
        ? (source.lastMode ?? source.last_mode)
        : null,
      lastOutcome: VOCABULARY_OUTCOME_SET.has(source.lastOutcome ?? source.last_outcome)
        ? (source.lastOutcome ?? source.last_outcome)
        : null,
    };
  }

  const preliminaryScore = LEGACY_STAGE_SCORES[stage];
  const attempts = boundedInteger(reviewCount + errorCount, 0, 1_000_000);
  return {
    masteryVersion: VOCABULARY_MASTERY_VERSION,
    word,
    stage,
    errorCount,
    reviewCount,
    dueAt,
    dimensions: {
      meaning: preliminaryDimension(preliminaryScore, attempts),
      spelling: preliminaryDimension(preliminaryScore),
      context: preliminaryDimension(preliminaryScore),
      listening: preliminaryDimension(preliminaryScore),
    },
    lastMode: null,
    lastOutcome: null,
  };
}

function legacyVocabularyProgress(word, input) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  return {
    word: source.word || word,
    stage: source.stage ?? source.s,
    errorCount: source.errorCount ?? source.error_count ?? source.e,
    reviewCount: source.reviewCount ?? source.review_count ?? source.n,
    dueAt: source.dueAt ?? source.due_at ?? source.due ?? null,
  };
}

export function mergeLegacyVocabularyProgress(existing, legacy) {
  const legacyInput = legacyVocabularyProgress(existing?.word || legacy?.word, legacy);
  if (Number(existing?.masteryVersion ?? existing?.mastery_version) !== VOCABULARY_MASTERY_VERSION) {
    return migrateVocabularyProgress(legacyInput);
  }
  const current = migrateVocabularyProgress(existing);
  const compatible = migrateVocabularyProgress(legacyInput);
  return {
    ...current,
    stage: compatible.stage,
    errorCount: compatible.errorCount,
    reviewCount: compatible.reviewCount,
    dueAt: compatible.dueAt,
  };
}

export function localVocabularyProgress(word, input) {
  const progress = Number(input?.masteryVersion ?? input?.mastery_version) === VOCABULARY_MASTERY_VERSION
    ? migrateVocabularyProgress({ ...input, word: input.word || word })
    : migrateVocabularyProgress(legacyVocabularyProgress(word, input));
  return {
    s: progress.stage,
    e: progress.errorCount,
    n: progress.reviewCount,
    due: progress.dueAt ?? 0,
    ...progress,
  };
}

export function migrateLocalVocabularyProgress(records) {
  return Object.fromEntries(Object.entries(records && typeof records === 'object' ? records : {})
    .map(([word, record]) => [word, localVocabularyProgress(word, record)]));
}

function minimumDimensionScore(progress) {
  return Math.min(...VOCABULARY_DIMENSIONS.map((dimension) => progress.dimensions[dimension].score));
}

function intervalAfterSuccess(progress, evidence) {
  const weakestScore = minimumDimensionScore(progress);
  let interval;
  if (weakestScore < 20) interval = 6 * 60 * 60_000;
  else if (weakestScore < 40) interval = 86_400_000;
  else if (weakestScore < 60) interval = 3 * 86_400_000;
  else if (weakestScore < 75) interval = 7 * 86_400_000;
  else if (weakestScore < 90) interval = 14 * 86_400_000;
  else interval = 30 * 86_400_000;
  return evidence === 'objective' ? interval : Math.min(interval, 3 * 86_400_000);
}

function evidenceAfterAttempt(previous, next) {
  if (next === 'self_reported' && previous !== 'objective') return next;
  if (previous === 'self_reported' && next === 'guided') return previous;
  return EVIDENCE_RANK[next] > EVIDENCE_RANK[previous] ? next : previous;
}

function stageFromScores(progress) {
  const average = VOCABULARY_DIMENSIONS.reduce((sum, dimension) => (
    sum + progress.dimensions[dimension].score
  ), 0) / VOCABULARY_DIMENSIONS.length;
  if (average >= 90) return 5;
  if (average >= 75) return 4;
  if (average >= 55) return 3;
  if (average >= 35) return 2;
  if (average > 0) return 1;
  return 0;
}

export function deriveVocabularyState(input) {
  const progress = migrateVocabularyProgress(input);
  const hasPractice = VOCABULARY_DIMENSIONS.some((dimension) => (
    progress.dimensions[dimension].attempts > 0
  ));
  if (progress.stage === 0 && !hasPractice && minimumDimensionScore(progress) === 0) return 'new';
  const independentlyDemonstrated = ['spelling', 'context', 'listening'].every((dimension) => (
    progress.dimensions[dimension].score >= 75
      && progress.dimensions[dimension].evidence === 'objective'
      && progress.dimensions[dimension].independentSuccesses > 0
  ));
  if (independentlyDemonstrated && progress.dimensions.meaning.score >= 75) return 'strong';
  if (progress.stage >= 3 || stageFromScores(progress) >= 3) return 'review';
  return 'learning';
}

export function applyVocabularyOutcome(input, { mode, outcome, now = Date.now() } = {}) {
  const progress = migrateVocabularyProgress(input);
  const rule = MODE_RULES[mode];
  const timestamp = nullableTimestamp(now);
  if (!rule || timestamp == null) throw new TypeError('Unsupported vocabulary attempt');
  const validOutcomes = mode === 'russian_reveal'
    ? new Set(['knew', 'almost', 'not_known'])
    : new Set(['correct', 'almost', 'incorrect', 'not_known']);
  if (!validOutcomes.has(outcome)) throw new TypeError('Unsupported vocabulary outcome');

  const dimensions = Object.fromEntries(VOCABULARY_DIMENSIONS.map((dimension) => [
    dimension, { ...progress.dimensions[dimension] },
  ]));
  const target = dimensions[rule.dimension];
  const successful = outcome === 'correct' || outcome === 'knew';
  const delta = successful
    ? rule.correctDelta
    : outcome === 'almost' ? -5 : outcome === 'not_known' ? -20 : -15;
  target.score = boundedInteger(target.score + delta, 0, 100);
  target.attempts = boundedInteger(target.attempts + 1, 0, 1_000_000);
  target.independentSuccesses = boundedInteger(
    target.independentSuccesses + (successful && rule.evidence === 'objective' ? 1 : 0),
    0,
    1_000_000,
  );
  target.evidence = evidenceAfterAttempt(target.evidence, rule.evidence);
  target.lastPracticedAt = timestamp;

  const candidate = { ...progress, dimensions };
  const stage = successful
    ? Math.max(progress.stage, stageFromScores(candidate))
    : Math.max(0, progress.stage - 1);
  const dueAt = successful
    ? timestamp + intervalAfterSuccess(candidate, rule.evidence)
    : timestamp + (outcome === 'almost' ? 30 * 60_000 : 10 * 60_000);
  return {
    ...candidate,
    stage,
    errorCount: progress.errorCount + (FAILURE_OUTCOMES.has(outcome) ? 1 : 0),
    reviewCount: progress.reviewCount + 1,
    dueAt,
    lastMode: mode,
    lastOutcome: outcome,
  };
}

function compareByWeakness(left, right) {
  const scoreDifference = minimumDimensionScore(left) - minimumDimensionScore(right);
  if (scoreDifference) return scoreDifference;
  const leftDue = left.dueAt == null ? Number.POSITIVE_INFINITY : left.dueAt;
  const rightDue = right.dueAt == null ? Number.POSITIVE_INFINITY : right.dueAt;
  return leftDue - rightDue || left.word.localeCompare(right.word, 'en');
}

export function buildVocabularyQueue(inputs, {
  now = Date.now(), newWordBudget = 10, reviewLimit = 20,
} = {}) {
  const timestamp = nullableTimestamp(now) ?? Date.now();
  const budget = [5, 10, 15, 20].includes(Number(newWordBudget)) ? Number(newWordBudget) : 10;
  const boundedReviewLimit = boundedInteger(reviewLimit, 1, 500, 20);
  const records = (Array.isArray(inputs) ? inputs : []).map(migrateVocabularyProgress);
  const due = records
    .filter((record) => deriveVocabularyState(record) !== 'new'
      && record.dueAt != null && record.dueAt <= timestamp)
    .sort((left, right) => left.dueAt - right.dueAt || compareByWeakness(left, right));
  const dueWords = new Set(due.map((record) => record.word));
  const weak = records
    .filter((record) => !dueWords.has(record.word)
      && ['learning', 'review'].includes(deriveVocabularyState(record)))
    .sort(compareByWeakness)
    .slice(0, Math.max(0, boundedReviewLimit - due.length));
  const reviewDebt = due.length + weak.length;
  const effectiveNewWordBudget = Math.max(0, budget - reviewDebt);
  const newWords = records
    .filter((record) => deriveVocabularyState(record) === 'new')
    .sort((left, right) => left.word.localeCompare(right.word, 'en'))
    .slice(0, effectiveNewWordBudget);
  return {
    due,
    weak,
    new: newWords,
    effectiveNewWordBudget,
    items: [...due, ...weak, ...newWords],
  };
}

function sessionModeFor(progress) {
  if (progress.stage <= 0) return 'receptive_meaning';
  if (progress.lastMode === 'receptive_meaning'
    && FAILURE_OUTCOMES.has(progress.lastOutcome)) return 'receptive_meaning';
  if (['none', 'preliminary', 'guided'].includes(progress.dimensions.meaning.evidence)) {
    return 'russian_reveal';
  }
  if (progress.lastMode === 'russian_reveal'
    && FAILURE_OUTCOMES.has(progress.lastOutcome)) return 'russian_reveal';
  const objectiveModes = [
    ['spelling', 'english_production'],
    ['context', 'contextual_production'],
    ['listening', 'listening'],
  ];
  const untested = objectiveModes.find(([dimension]) => (
    progress.dimensions[dimension].evidence !== 'objective'
      || progress.dimensions[dimension].attempts === 0
  ));
  if (untested) return untested[1];
  const practiceModes = [['meaning', 'russian_reveal'], ...objectiveModes];
  return practiceModes.sort(([left], [right]) => (
    progress.dimensions[left].score - progress.dimensions[right].score
      || progress.dimensions[left].attempts - progress.dimensions[right].attempts
  ))[0][1];
}

export function composeVocabularySession(items, { progressByWord = {} } = {}) {
  const records = new Map(Object.entries(
    progressByWord && typeof progressByWord === 'object' ? progressByWord : {},
  ).map(([word, progress]) => [normalizeVocabularyWord(progress?.word || word), progress]));
  const tasks = [];
  for (const item of Array.isArray(items) ? items : []) {
    const word = normalizeVocabularyWord(item?.w ?? item?.word);
    if (!word) continue;
    const progress = migrateVocabularyProgress(records.get(word) || { word });
    const isNew = deriveVocabularyState(progress) === 'new';
    if (isNew) {
      tasks.push({ id: `${word}:introduction`, word, mode: 'introduction', introduced: true, reviewed: false });
    }
    const mode = sessionModeFor(progress);
    tasks.push({
      id: `${word}:${mode}`,
      word,
      mode,
      introduced: false,
      reviewed: !isNew,
    });
  }
  return tasks;
}

export function buildVocabularyRecognitionOptions(catalog, target, { limit = 4 } = {}) {
  const answer = normalizeFreeText(target?.tr);
  if (!answer) return [];
  const maximum = boundedInteger(limit, 2, 8, 4);
  const distractors = Array.from(new Set((Array.isArray(catalog) ? catalog : [])
    .map((item) => normalizeFreeText(item?.tr))
    .filter((value) => value && value !== answer)))
    .sort((left, right) => left.localeCompare(right, 'ru'))
    .slice(0, maximum - 1);
  return [answer, ...distractors].sort((left, right) => left.localeCompare(right, 'ru'));
}

export function summarizeVocabularySession(events) {
  const rows = Array.isArray(events) ? events : [];
  const words = new Set();
  const introduced = new Set();
  const reviewed = new Set();
  const attemptsByWord = new Map();
  const errorsByWord = new Map();
  let attempts = 0;
  let independent = 0;
  let assisted = 0;
  let errors = 0;
  for (const event of rows) {
    const word = normalizeVocabularyWord(event?.word);
    if (!word) continue;
    words.add(word);
    if (event.introduced || event.mode === 'introduction') introduced.add(word);
    if (event.reviewed) reviewed.add(word);
    if (event.mode === 'introduction' || !VOCABULARY_OUTCOME_SET.has(event.outcome)) continue;
    attempts += 1;
    attemptsByWord.set(word, (attemptsByWord.get(word) || 0) + 1);
    const successful = event.outcome === 'correct' || event.outcome === 'knew';
    if (successful && event.independentSuccess) independent += 1;
    else if (successful) assisted += 1;
    if (FAILURE_OUTCOMES.has(event.outcome)) {
      errors += 1;
      errorsByWord.set(word, (errorsByWord.get(word) || 0) + 1);
    }
  }
  const difficultWords = Array.from(errorsByWord, ([word, wordErrors]) => ({
    word,
    attempts: attemptsByWord.get(word) || 0,
    errors: wordErrors,
  })).sort((left, right) => (
    right.errors - left.errors || right.attempts - left.attempts || left.word.localeCompare(right.word, 'en')
  ));
  return {
    uniqueWords: words.size,
    attempts,
    introduced: introduced.size,
    reviewed: reviewed.size,
    independent,
    assisted,
    errors,
    difficultWords,
  };
}

export function appendVocabularySessionHistory(history, summary, {
  completedAt = Date.now(), maxEntries = 90,
} = {}) {
  const timestamp = nullableTimestamp(completedAt);
  if (timestamp == null) throw new TypeError('Invalid vocabulary session completion time');
  const entry = {
    completedAt: timestamp,
    uniqueWords: boundedInteger(summary?.uniqueWords, 0, 10_000),
    attempts: boundedInteger(summary?.attempts, 0, 10_000),
    independent: boundedInteger(summary?.independent, 0, 10_000),
    errors: boundedInteger(summary?.errors, 0, 10_000),
  };
  const limit = boundedInteger(maxEntries, 1, 365, 90);
  return [...(Array.isArray(history) ? history : []), entry]
    .filter((item) => nullableTimestamp(item?.completedAt) != null)
    .sort((left, right) => Number(left.completedAt) - Number(right.completedAt))
    .slice(-limit);
}

function localCalendarDay(timestamp, timezoneOffsetMinutes) {
  if (timezoneOffsetMinutes != null && timezoneOffsetMinutes !== ''
    && Number.isFinite(Number(timezoneOffsetMinutes))) {
    const offset = boundedInteger(timezoneOffsetMinutes, -840, 840);
    return new Date(timestamp - offset * 60_000).toISOString().slice(0, 10);
  }
  const date = new Date(timestamp);
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')]
    .join('-');
}

export function buildVocabularyTrend(history, {
  days = 7, now = Date.now(), timezoneOffsetMinutes = null,
} = {}) {
  const period = boundedInteger(days, 1, 365, 7);
  const timestamp = nullableTimestamp(now) ?? Date.now();
  const threshold = timestamp - period * 86_400_000;
  const entries = (Array.isArray(history) ? history : [])
    .filter((entry) => {
      const completedAt = nullableTimestamp(entry?.completedAt);
      return completedAt != null && completedAt > threshold && completedAt <= timestamp;
    });
  const totals = entries.reduce((result, entry) => ({
    attempts: result.attempts + boundedInteger(entry.attempts, 0, 10_000),
    independent: result.independent + boundedInteger(entry.independent, 0, 10_000),
    errors: result.errors + boundedInteger(entry.errors, 0, 10_000),
  }), { attempts: 0, independent: 0, errors: 0 });
  const byDay = new Map();
  for (const entry of entries) {
    const day = localCalendarDay(Number(entry.completedAt), timezoneOffsetMinutes);
    const point = byDay.get(day) || { day, attempts: 0, independent: 0, errors: 0 };
    point.attempts += boundedInteger(entry.attempts, 0, 10_000);
    point.independent += boundedInteger(entry.independent, 0, 10_000);
    point.errors += boundedInteger(entry.errors, 0, 10_000);
    byDay.set(day, point);
  }
  const rate = (independentCount, attemptCount) => (
    attemptCount ? Math.min(100, Math.round(independentCount * 100 / attemptCount)) : 0
  );
  const points = Array.from(byDay.values()).sort((left, right) => left.day.localeCompare(right.day))
    .map((point) => ({
      ...point,
      independentRate: rate(point.independent, point.attempts),
    }));
  return {
    days: period,
    sessions: entries.length,
    ...totals,
    independentRate: rate(totals.independent, totals.attempts),
    points,
  };
}

export function reinsertVocabularyFailure(items, failedItem, {
  afterIndex,
  minInterveningItems = 2,
  repeatCounts = {},
  maxRepeatsPerWord = 2,
  fallbackItems = [],
} = {}) {
  const queue = Array.isArray(items) ? [...items] : [];
  const word = normalizeVocabularyWord(failedItem?.word);
  const counts = { ...repeatCounts };
  const count = boundedInteger(counts[word], 0, 1_000_000);
  const cap = boundedInteger(maxRepeatsPerWord, 0, 20, 2);
  if (!word || count >= cap) return {
    items: queue, repeatCounts: counts, insertedAt: null, interveningAdded: 0,
  };
  const currentIndex = boundedInteger(afterIndex, 0, Math.max(0, queue.length - 1));
  const separation = boundedInteger(minInterveningItems, 0, 100, 2);
  const needed = Math.max(0, separation - (queue.length - currentIndex - 1));
  const bridges = [];
  const bridgeWords = new Set();
  if (needed > 0) {
    for (const candidate of Array.isArray(fallbackItems) ? fallbackItems : []) {
      const candidateWord = normalizeVocabularyWord(candidate?.word);
      if (!candidateWord || candidateWord === word || bridgeWords.has(candidateWord)) continue;
      bridges.push({ ...candidate, bridge: true });
      bridgeWords.add(candidateWord);
      if (bridges.length === needed) break;
    }
  }
  if (bridges.length < needed) {
    return { items: queue, repeatCounts: counts, insertedAt: null, interveningAdded: 0 };
  }
  queue.push(...bridges);
  const insertedAt = currentIndex + separation + 1;
  queue.splice(insertedAt, 0, { ...failedItem, word, relearn: true });
  counts[word] = count + 1;
  return { items: queue, repeatCounts: counts, insertedAt, interveningAdded: bridges.length };
}
