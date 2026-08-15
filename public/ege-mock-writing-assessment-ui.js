import { AUTOMATIC_ASSESSMENT_WARNING } from './automatic-assessment-contract.js';

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/gu, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

export function renderEgeMockWritingAssessmentStatus(assessment) {
  const status = escapeHtml(assessment?.status || 'ожидается');
  return `<p><strong>Предварительная автоматическая оценка (experimental / approximate): ${status}.</strong> ${escapeHtml(AUTOMATIC_ASSESSMENT_WARNING)}</p>`;
}

export function renderEgeMockWritingAssessmentActions(
  assessment, { queued = false, revisionBlocked = false } = {},
) {
  if (revisionBlocked) {
    return '<p class="ege-mock__error" role="alert">Автоматическая проверка остановлена: исчерпан внутренний безопасный лимит версии оценки. Повторный запуск заблокирован.</p>';
  }
  if (assessment?.runDisposition === 'subscription_required') {
    if (queued) {
      return '<p class="ege-mock__status" role="status">Явный запуск проверки после продления подписки сохранён и будет отправлен после восстановления сети.</p>';
    }
    return '<p class="ege-mock__error" role="alert">Для предварительной автоматической оценки нужна активная подписка. Продлите подписку, затем запустите проверку явно.</p><button class="ege-mock__action" type="button" data-ege-action="run-assessment-after-renewal">Запустить проверку после продления подписки</button>';
  }
  if (!assessment?.retryAllowed || !['retryable', 'ambiguous'].includes(assessment.status)) return '';
  if (queued) {
    return '<p class="ege-mock__status" role="status">Повтор предварительной оценки сохранён и будет отправлен после восстановления сети.</p>';
  }
  if (assessment.status === 'ambiguous') {
    return '<button class="ege-mock__action" type="button" data-ege-action="retry-assessment-ambiguous">Подтвердить возможный повтор проверки у провайдера</button>';
  }
  return '<button class="ege-mock__action" type="button" data-ege-action="retry-assessment">Повторить предварительную оценку</button>';
}
