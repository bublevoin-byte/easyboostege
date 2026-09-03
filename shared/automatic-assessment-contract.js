export const AUTOMATIC_ASSESSMENT_MODE = 'experimental';
export const AUTOMATIC_ASSESSMENT_SCORE_KIND = 'approximate';
export const AUTOMATIC_ASSESSMENT_WARNING = 'Экспериментальная ИИ-оценка. Балл ориентировочный, может содержать ошибки и не является экспертным заключением.';
export const EGE_MOCK_WRITING_ASSESSMENT_LABEL = 'Предварительная автоматическая оценка';
export const EGE_MOCK_WRITING_AMBIGUOUS_RETRY_WARNING = 'Предыдущий результат провайдера нельзя подтвердить. Явный повтор может повторно отправить ответ на проверку и учесть ещё один вызов.';

export const AUTOMATIC_ASSESSMENT_PUBLIC_CONTRACT = Object.freeze({
  mode: AUTOMATIC_ASSESSMENT_MODE,
  scoreKind: AUTOMATIC_ASSESSMENT_SCORE_KIND,
  warning: AUTOMATIC_ASSESSMENT_WARNING,
});

const EGE_MOCK_WRITING_ASSESSMENT_REQUIRED_KEYS = Object.freeze([
  'assessmentRevision', 'label', 'mode', 'retryAllowed', 'retryCount', 'scoreKind', 'status',
  'warning',
]);
const EGE_MOCK_WRITING_ASSESSMENT_PLAIN_STATUSES = Object.freeze([
  'not_started', 'pending', 'in_progress', 'completed',
]);

function hasExactKeys(value, optionalKeys = []) {
  const expected = [...EGE_MOCK_WRITING_ASSESSMENT_REQUIRED_KEYS, ...optionalKeys].sort();
  return Object.keys(value).sort().join('\u0000') === expected.join('\u0000');
}

export function validEgeMockWritingAssessmentState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !Number.isSafeInteger(value.assessmentRevision) || value.assessmentRevision < 0
    || value.mode !== AUTOMATIC_ASSESSMENT_MODE
    || value.scoreKind !== AUTOMATIC_ASSESSMENT_SCORE_KIND
    || value.warning !== AUTOMATIC_ASSESSMENT_WARNING
    || value.label !== EGE_MOCK_WRITING_ASSESSMENT_LABEL
    || !Number.isInteger(value.retryCount) || value.retryCount < 0 || value.retryCount > 3
    || typeof value.retryAllowed !== 'boolean') return false;

  if (value.status === 'pending' && value.runDisposition === 'subscription_required') {
    return hasExactKeys(value, ['runDisposition']) && value.retryAllowed === false;
  }
  if (EGE_MOCK_WRITING_ASSESSMENT_PLAIN_STATUSES.includes(value.status)) {
    return hasExactKeys(value) && value.retryAllowed === false;
  }
  if (value.status === 'retryable') {
    return hasExactKeys(value) && value.retryAllowed === (value.retryCount < 3);
  }
  if (value.status === 'ambiguous') {
    return hasExactKeys(value, ['retryWarning'])
      && value.retryWarning === EGE_MOCK_WRITING_AMBIGUOUS_RETRY_WARNING
      && value.retryAllowed === (value.retryCount < 3);
  }
  return false;
}
