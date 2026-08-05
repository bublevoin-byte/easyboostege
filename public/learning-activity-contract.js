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
