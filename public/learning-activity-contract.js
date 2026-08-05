const TOPICS = Object.freeze(Array.from({ length: 20 }, (_, index) => index + 1));

export const GRAMMAR_ACTIVITY_IDS = Object.freeze({
  formsReview: 'grammar_forms_review',
  transformationsReview: 'grammar_transformations_review',
  exam19to24: 'grammar_forms_exam_19_24',
});

export function grammarActivityId(topic, mode = 'topic_practice') {
  if (mode === 'exam_19_24') return GRAMMAR_ACTIVITY_IDS.exam19to24;
  const transformation = Number(topic) === 18;
  if (mode === 'spaced_review') {
    return transformation
      ? GRAMMAR_ACTIVITY_IDS.transformationsReview
      : GRAMMAR_ACTIVITY_IDS.formsReview;
  }
  return transformation ? 'grammar_transformations_topic_18' : `grammar_forms_topic_${Number(topic)}`;
}

export const GRAMMAR_FORMS_ACTIVITY_IDS = Object.freeze([
  'grammar_19_24', 'grammar_forms', GRAMMAR_ACTIVITY_IDS.formsReview,
  GRAMMAR_ACTIVITY_IDS.exam19to24,
  ...TOPICS.filter((topic) => topic !== 18).map((topic) => grammarActivityId(topic)),
]);

export const GRAMMAR_TRANSFORMATIONS_ACTIVITY_IDS = Object.freeze([
  'grammar_25_29', 'grammar_transformations', GRAMMAR_ACTIVITY_IDS.transformationsReview,
  grammarActivityId(18),
]);

export const READING_ACTIVITY_IDS = Object.freeze({
  headings: 'reading_headings',
  gaps: 'reading_gaps',
  questions: 'reading_detail',
  detail: 'reading_detail',
});

export function readingActivityId(format) {
  return READING_ACTIVITY_IDS[format] || null;
}

export const READING_GIST_ACTIVITY_IDS = Object.freeze([
  'reading_gist', READING_ACTIVITY_IDS.headings,
]);

export const READING_DETAIL_ACTIVITY_IDS = Object.freeze([
  'reading', READING_ACTIVITY_IDS.detail, READING_ACTIVITY_IDS.gaps,
]);

export const LISTENING_ACTIVITY_IDS = Object.freeze({
  matching: 'listening_matching',
  trueFalse: 'listening_true_false',
  interview: 'listening_interview',
  detail: 'listening_detail',
});

export function listeningActivityId(format) {
  if (format === 'true_false') return LISTENING_ACTIVITY_IDS.trueFalse;
  return LISTENING_ACTIVITY_IDS[format] || null;
}

export const LISTENING_GIST_ACTIVITY_IDS = Object.freeze([
  'listening_gist', LISTENING_ACTIVITY_IDS.matching,
]);

export const LISTENING_DETAIL_ACTIVITY_IDS = Object.freeze([
  'listening', LISTENING_ACTIVITY_IDS.detail,
  LISTENING_ACTIVITY_IDS.trueFalse, LISTENING_ACTIVITY_IDS.interview,
]);

export function learningActivitySource(...sets) {
  const sources = new Set(sets.map((set) => set?.evidenceSource || 'builtin'));
  return sources.size > 1 ? 'mixed' : [...sources][0];
}

export function learningActivityPool(base, generated) {
  const tagged = (items, evidenceSource) => (items || []).map((item) => (
    item && typeof item === 'object' ? { ...item, evidenceSource } : item
  ));
  return tagged(base, 'builtin').concat(tagged(generated, 'generated'));
}

export function splitLearningActivityDuration(slices, totalDurationMs) {
  const duration = Math.max(0, Math.round(Number(totalDurationMs) || 0));
  const normalized = (Array.isArray(slices) ? slices : []).map((slice) => ({
    ...slice,
    maxScore: Math.max(1, Math.round(Number(slice.maxScore) || 1)),
  }));
  if (!normalized.length) return [];
  const totalWeight = normalized.reduce((sum, slice) => sum + slice.maxScore, 0);
  const remainders = [];
  let assigned = 0;
  const result = normalized.map((slice, index) => {
    const exact = duration * slice.maxScore / totalWeight;
    const durationMs = Math.floor(exact);
    assigned += durationMs;
    remainders.push({ index, fraction: exact - durationMs, activityId: String(slice.activityId || '') });
    return { ...slice, durationMs };
  });
  remainders.sort((left, right) => right.fraction - left.fraction
    || left.activityId.localeCompare(right.activityId));
  for (let index = 0; index < duration - assigned; index += 1) {
    result[remainders[index].index].durationMs += 1;
  }
  return result;
}
