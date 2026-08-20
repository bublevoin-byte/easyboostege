import {
  EGE_MOCK_FORECAST_POLICY,
  EGE_MOCK_RESULT_PRIMARY_MAXIMUM,
} from './ege-mock-forecast-policy.js';

export {
  EGE_MOCK_FORECAST_POLICY,
  EGE_MOCK_RESULT_PRIMARY_MAXIMUM,
  egeMockForecastScore,
} from './ege-mock-forecast-policy.js';

export const EGE_MOCK_RESULT_SCHEMA_VERSION = 'ege-mock-result-v1';
export const EGE_MOCK_RESULT_HISTORY_LIMIT = 20;
export const EGE_MOCK_RESULT_ANSWER_ARRAY_LIMIT = 20;
export const EGE_MOCK_RESULT_ANSWER_ITEM_LENGTH = 500;

export const EGE_MOCK_RESULT_SECTION_MATRIX = Object.freeze([
  Object.freeze(['listening', 12, 'exact']),
  Object.freeze(['reading', 12, 'exact']),
  Object.freeze(['grammar_lexis', 18, 'exact']),
  Object.freeze(['writing', 20, 'approximate']),
  Object.freeze(['speaking', 20, 'approximate']),
]);

export const EGE_MOCK_RESULT_ITEM_MAXIMUMS = Object.freeze([
  2, 3, 1, 1, 1, 1, 1, 1, 1,
  3, 2, 1, 1, 1, 1, 1, 1, 1,
  ...Array(18).fill(1), 6, 14, 1, 4, 5, 10,
]);

export const EGE_MOCK_RESULT_SPEAKING_REVIEW_DEFINITIONS = Object.freeze({
  'speaking-ege-2026-task1-v1': Object.freeze({
    maximum: 1,
    name: 'Чтение вслух: произношение и интонация',
    nextStep: 'Сохраняйте естественный темп, словесное ударение и завершённую интонацию.',
  }),
  'speaking-ege-2026-task2-v1': Object.freeze({
    maximum: 4,
    name: 'Прямые вопросы: полнота и языковое оформление',
    nextStep: 'Сформулируйте четыре прямых вопроса по всем опорам задания.',
  }),
  'speaking-ege-2026-task3-v1': Object.freeze({
    maximum: 5,
    name: 'Интервью: полнота и уместность ответов',
    nextStep: 'Дайте полный уместный ответ на каждый из пяти вопросов.',
  }),
  'speaking-ege-2026-task4-v1': Object.freeze({
    maximum: 10,
    name: 'Монолог: содержание, организация и языковое оформление',
    nextStep: 'Следуйте всем пунктам плана, связывайте мысли и проверяйте языковое оформление.',
  }),
});

export const EGE_MOCK_RESULT_RECOMMENDATION_DEFINITIONS = Object.freeze({
  'ege.listening.gist': Object.freeze({ module: 'listening', label: 'Основная мысль аудио', href: '#scr4' }),
  'ege.listening.detail': Object.freeze({ module: 'listening', label: 'Детальное понимание аудио', href: '#scr4' }),
  'ege.reading.gist': Object.freeze({ module: 'reading', label: 'Основная мысль текста', href: '#scr7' }),
  'ege.reading.detail': Object.freeze({ module: 'reading', label: 'Детальное понимание текста', href: '#scr7' }),
  'ege.grammar.forms': Object.freeze({ module: 'grammar', label: 'Грамматические формы', href: '#scr3' }),
  'ege.vocabulary.word_formation': Object.freeze({ module: 'vocabulary', label: 'Словообразование', href: '#scr2' }),
  'ege.vocabulary.lexical_choice': Object.freeze({ module: 'vocabulary', label: 'Лексический выбор', href: '#scr2' }),
  'ege.writing.email': Object.freeze({ module: 'writing', label: 'Электронное письмо', href: '#scr8' }),
  'ege.writing.essay': Object.freeze({ module: 'writing', label: 'Развёрнутое письменное высказывание', href: '#scr8' }),
  'ege.speaking.reading_aloud': Object.freeze({ module: 'speaking', label: 'Чтение вслух', href: '#scr9' }),
  'ege.speaking.direct_questions': Object.freeze({ module: 'speaking', label: 'Прямые вопросы', href: '#scr9' }),
  'ege.speaking.interview_completeness': Object.freeze({ module: 'speaking', label: 'Полнота интервью', href: '#scr9' }),
  'ege.speaking.monologue_content': Object.freeze({ module: 'speaking', label: 'Содержание монолога', href: '#scr9' }),
});

export const EGE_MOCK_RESULT_RECOMMENDATION_LIMIT = Object.freeze(
  Object.keys(EGE_MOCK_RESULT_RECOMMENDATION_DEFINITIONS),
).length;

export function egeMockResultSkillForPosition(position) {
  if (position === 1) return 'ege.listening.gist';
  if (position >= 2 && position <= 9) return 'ege.listening.detail';
  if (position === 10) return 'ege.reading.gist';
  if (position >= 11 && position <= 18) return 'ege.reading.detail';
  if (position >= 19 && position <= 24) return 'ege.grammar.forms';
  if (position >= 25 && position <= 29) return 'ege.vocabulary.word_formation';
  if (position >= 30 && position <= 36) return 'ege.vocabulary.lexical_choice';
  if (position === 37) return 'ege.writing.email';
  if (position === 38) return 'ege.writing.essay';
  if (position === 39) return 'ege.speaking.reading_aloud';
  if (position === 40) return 'ege.speaking.direct_questions';
  if (position === 41) return 'ege.speaking.interview_completeness';
  if (position === 42) return 'ege.speaking.monologue_content';
  return null;
}

function projectionMatchesCanonicalSection(canonical, projection, sectionId, positions) {
  const section = canonical?.sections?.find((candidate) => candidate?.id === sectionId);
  if (!section || !projection || section.status !== projection.status) return false;
  const projectedItems = Array.isArray(projection.items)
    ? projection.items : Object.values(projection.items || {});
  const projectedPositions = new Set(projectedItems.map(({ position }) => position));
  if (projectedPositions.size !== projectedItems.length) return false;
  for (const projected of projectedItems) {
    if (!positions.includes(projected?.position)) return false;
    const canonicalItem = canonical.items?.[projected.position - 1];
    if (canonicalItem?.position !== projected.position
      || canonicalItem.status !== projected.status
      || canonicalItem.score !== projected.score
      || (sectionId === 'writing' && projected.status === 'completed'
        && !fieldsMatch(projected, canonicalItem, ['criteria', 'feedback', 'evidence']))) return false;
  }
  const requiredPositions = positions.filter((position) => {
    const item = canonical.items?.[position - 1];
    return item?.status === 'completed' || item?.score != null;
  });
  if (!requiredPositions.every((position) => projectedPositions.has(position))) return false;
  if (projection.status !== 'completed') return true;
  return projection.score === section.score
    && projectedItems.length === positions.length
    && projectedPositions.size === positions.length
    && positions.every((position) => projectedPositions.has(position));
}

export function egeMockCanonicalSectionStatusesMatchItems(canonical) {
  if (!Array.isArray(canonical?.sections) || !Array.isArray(canonical?.items)) return false;
  return canonical.sections.every((section) => {
    const items = canonical.items.filter((item) => item?.section === section?.id);
    if (!items.length) return false;
    const unscored = items.filter((item) => item.score == null);
    const expected = unscored.length ? unscored[0].status : 'completed';
    return section.status === expected && unscored.every((item) => item.status === expected);
  });
}

export function egeMockCanonicalResponseStatesMatchItemKinds(canonical) {
  if (!Array.isArray(canonical?.items)) return false;
  return canonical.items.every((item) => {
    if (!Number.isInteger(item?.position) || item.position < 1 || item.position > 42) return false;
    const allowed = item.position <= 36
      ? ['provided', 'blank']
      : ['submitted_hidden', 'technical', 'blank'];
    return allowed.includes(item.responseState);
  });
}

function valuesMatch(left, right) {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length
      && left.every((value, index) => valuesMatch(value, right[index]));
  }
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index]
      && valuesMatch(left[key], right[key]));
}

function fieldsMatch(left, right, fields) {
  return fields.every((field) => valuesMatch(left?.[field], right?.[field]));
}

function speakingItemsMatch(left, right) {
  const leftItems = Object.values(left?.items || {});
  const rightItems = new Map(Object.values(right?.items || {})
    .map((item) => [item?.position, item]));
  const fields = ['position', 'maximum', 'status', 'score', 'mode', 'scoreKind', 'errorCode'];
  return leftItems.length === rightItems.size
    && leftItems.every((item) => fieldsMatch(item, rightItems.get(item?.position), fields));
}

export function egeMockCompositeResultMatchesCanonical(composite) {
  const canonical = composite?.canonical;
  return projectionMatchesCanonicalSection(canonical, composite?.writing, 'writing', [37, 38])
    && projectionMatchesCanonicalSection(canonical, composite?.speaking, 'speaking', [39, 40, 41, 42]);
}

export function egeMockAvailableResultMatchesComposite(envelope) {
  if (envelope?.available !== true || !egeMockCompositeResultMatchesCanonical(envelope.result)) return false;
  const writingStatus = envelope.result.writing.status;
  const speakingStatus = envelope.result.speaking.status;
  const completed = writingStatus === 'completed' && speakingStatus === 'completed';
  const assessmentFields = [
    'status', 'mode', 'scoreKind', 'warning', 'label', 'retryAllowed', 'retryCount',
  ];
  return fieldsMatch(envelope.writingAssessment, envelope.result.writing,
    ['status', 'assessmentRevision'])
    && fieldsMatch(envelope.speakingAssessment, envelope.result.speaking, assessmentFields)
    && speakingItemsMatch(envelope.speakingAssessment, envelope.result.speaking)
    && envelope.assessment?.retryAllowed === envelope.writingAssessment?.retryAllowed
    && envelope.assessment?.retryCount === envelope.writingAssessment?.retryCount
    && envelope.state === (completed ? 'completed' : 'assessment_pending')
    && (completed
      ? envelope.assessment?.status === 'completed'
      : ['pending', 'retryable'].includes(envelope.assessment?.status));
}
