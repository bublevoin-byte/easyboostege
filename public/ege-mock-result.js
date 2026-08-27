import {
  EGE_MOCK_FORECAST_POLICY,
  EGE_MOCK_RESULT_ANSWER_ARRAY_LIMIT,
  EGE_MOCK_RESULT_ANSWER_ITEM_LENGTH,
  EGE_MOCK_RESULT_HISTORY_LIMIT,
  EGE_MOCK_RESULT_ITEM_MAXIMUMS,
  EGE_MOCK_RESULT_PRIMARY_MAXIMUM,
  EGE_MOCK_RESULT_RECOMMENDATION_DEFINITIONS,
  EGE_MOCK_RESULT_RECOMMENDATION_LIMIT,
  EGE_MOCK_RESULT_SCHEMA_VERSION,
  EGE_MOCK_RESULT_SECTION_MATRIX,
  egeMockAvailableResultMatchesComposite,
  egeMockCanonicalResponseStatesMatchItemKinds,
  egeMockCanonicalSectionStatusesMatchItems,
  egeMockForecastScore,
  egeMockResultSkillForPosition,
} from '../shared/ege-mock-result-contract.js';

const SECTION_LABELS = Object.freeze({
  listening: 'Аудирование',
  reading: 'Чтение',
  grammar_lexis: 'Грамматика и лексика',
  writing: 'Письменная речь',
  speaking: 'Говорение',
});
function invalid() {
  throw new TypeError('EGE_MOCK_RESULT_INVALID');
}

export function createEgeMockResultLoadAuthority() {
  let activeAttemptId = '';
  let generation = 0;
  const validAttemptId = (attemptId) => typeof attemptId === 'string' && attemptId.length > 0;
  return Object.freeze({
    begin(attemptId) {
      if (!validAttemptId(attemptId)) return null;
      if (activeAttemptId !== attemptId) {
        activeAttemptId = attemptId;
        generation += 1;
      }
      return Object.freeze({ attemptId, generation });
    },
    invalidate(attemptId) {
      if (!validAttemptId(attemptId)) return false;
      activeAttemptId = attemptId;
      generation += 1;
      return true;
    },
    canCommit(token) {
      return validAttemptId(token?.attemptId) && token.attemptId === activeAttemptId
        && token.generation === generation;
    },
    reset() {
      activeAttemptId = '';
      generation += 1;
    },
  });
}

export function claimEgeMockResultLoad(authority, attemptId, loadingAttemptId = '') {
  if (!authority || typeof authority.begin !== 'function'
    || typeof authority.invalidate !== 'function'
    || typeof attemptId !== 'string' || !attemptId) {
    return Object.freeze({ token: null, queued: false });
  }
  if (loadingAttemptId) {
    authority.invalidate(attemptId);
    return Object.freeze({ token: null, queued: true });
  }
  return Object.freeze({ token: authority.begin(attemptId), queued: false });
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/gu, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function validScore(value, maximum) {
  return Number.isInteger(value) && value >= 0 && value <= maximum;
}

function validAnswer(value) {
  if (value == null) return true;
  if (typeof value === 'string') return value.length <= 20_000;
  return Array.isArray(value) && value.length <= EGE_MOCK_RESULT_ANSWER_ARRAY_LIMIT
    && value.every((item) => typeof item === 'string'
      && item.length <= EGE_MOCK_RESULT_ANSWER_ITEM_LENGTH);
}

function validSafeReview(item) {
  if (item.criteria != null && (!Array.isArray(item.criteria) || item.criteria.length > 5
    || item.criteria.some((criterion) => typeof criterion?.name !== 'string'
      || criterion.name.length < 1 || criterion.name.length > 120
      || !validScore(criterion.got, criterion.max)
      || !Number.isInteger(criterion.max) || criterion.max < 1 || criterion.max > 14))) return false;
  if (item.feedback != null && (typeof item.feedback?.verdict !== 'string'
    || item.feedback.verdict.length < 1 || item.feedback.verdict.length > 160
    || typeof item.feedback?.nextStep !== 'string'
    || item.feedback.nextStep.length < 1 || item.feedback.nextStep.length > 500)) return false;
  if (item.evidence != null && (!Array.isArray(item.evidence) || item.evidence.length > 5
    || item.evidence.some((entry) => typeof entry?.title !== 'string'
      || entry.title.length < 1 || entry.title.length > 160
      || typeof entry.wrong !== 'string' || entry.wrong.length > 500
      || typeof entry.right !== 'string' || entry.right.length > 500
      || !['err', 'warn'].includes(entry.kind)
      || typeof entry.note !== 'string' || entry.note.length < 1 || entry.note.length > 1_000))) {
    return false;
  }
  return true;
}

function assertCanonical(candidate) {
  if (candidate?.schemaVersion !== EGE_MOCK_RESULT_SCHEMA_VERSION
    || !['diagnostic', 'training'].includes(candidate.mode)
    || candidate.label !== (candidate.mode === 'diagnostic'
      ? 'Диагностический' : 'Тренировочный повтор')
    || candidate.score?.maximum !== EGE_MOCK_RESULT_PRIMARY_MAXIMUM
    || candidate.masteryCredit !== false
    || !Array.isArray(candidate.sections)
    || candidate.sections.length !== EGE_MOCK_RESULT_SECTION_MATRIX.length
    || !Array.isArray(candidate.items) || !Array.isArray(candidate.recommendations)
    || candidate.recommendations.length > EGE_MOCK_RESULT_RECOMMENDATION_LIMIT
    || !egeMockCanonicalResponseStatesMatchItemKinds(candidate)
    || !egeMockCanonicalSectionStatusesMatchItems(candidate)) invalid();
  EGE_MOCK_RESULT_SECTION_MATRIX.forEach(([id, maximum, scoreKind], index) => {
    const section = candidate.sections[index];
    if (section?.id !== id || section.maximum !== maximum || section.scoreKind !== scoreKind
      || (section.score != null && !validScore(section.score, maximum))) invalid();
  });
  if (candidate.items.length !== 42) invalid();
  const itemScores = new Map(EGE_MOCK_RESULT_SECTION_MATRIX.map(([id]) => [id, []]));
  const weak = new Map();
  for (let index = 0; index < candidate.items.length; index += 1) {
    const item = candidate.items[index];
    const position = index + 1;
    const section = position <= 9 ? 'listening' : position <= 18 ? 'reading'
      : position <= 36 ? 'grammar_lexis' : position <= 38 ? 'writing' : 'speaking';
    const scoreKind = position <= 36 ? 'exact' : 'approximate';
    const writingStatusInvalid = position >= 37 && position <= 38 && (item?.score == null
      ? !['not_started', 'pending', 'retryable', 'ambiguous'].includes(item.status)
      : item.status !== 'completed');
    const speakingStatusInvalid = position >= 39 && (item?.score == null
      ? !['not_started', 'pending', 'retryable'].includes(item.status)
      : item.status !== 'completed');
    if (item?.position !== position || item.section !== section || item.scoreKind !== scoreKind
      || item.maximum !== EGE_MOCK_RESULT_ITEM_MAXIMUMS[index]
      || writingStatusInvalid
      || speakingStatusInvalid
      || !validAnswer(item.learnerAnswer) || !validAnswer(item.correctAnswer)
      || (scoreKind === 'exact' && (item.status !== 'completed' || item.score == null
        || item.correctAnswer == null))
      || (scoreKind === 'approximate' && (item.learnerAnswer !== null
        || item.correctAnswer !== null || !item.criteriaRef
        || !/^sha256:[a-f0-9]{64}$/u.test(item.criteriaFingerprint || '')
        || (item.score != null
          && (!Array.isArray(item.criteria) || item.criteria.length < (position <= 38 ? 3 : 1)
            || item.feedback == null
            || (position <= 38 && !Array.isArray(item.evidence))))
        || !validSafeReview(item)))
      || (item.score != null && !validScore(item.score, item.maximum))) invalid();
    itemScores.get(section).push(item.score);
    if (item.score != null && item.score < item.maximum) {
      const skillId = egeMockResultSkillForPosition(position);
      const current = weak.get(skillId) || [];
      current.push(position);
      weak.set(skillId, current);
    }
  }
  let objective = 0;
  let provisional = 0;
  let pendingMaximum = 0;
  for (const section of candidate.sections) {
    const scores = itemScores.get(section.id);
    const known = scores.filter((score) => score != null);
    const total = known.length ? known.reduce((sum, score) => sum + score, 0) : null;
    if (section.score !== total) invalid();
    if (section.scoreKind === 'exact') {
      if (known.length !== scores.length) invalid();
      objective += total;
    } else {
      provisional += known.reduce((sum, score) => sum + score, 0);
    }
  }
  const subjective = candidate.items.filter(({ scoreKind }) => scoreKind === 'approximate');
  const scoredSubjective = subjective.filter(({ score }) => score != null);
  pendingMaximum = subjective.filter(({ score }) => score == null)
    .reduce((sum, item) => sum + item.maximum, 0);
  const complete = scoredSubjective.length === subjective.length;
  const minimum = objective + provisional;
  const maximum = minimum + pendingMaximum;
  const diagnostic = candidate.mode === 'diagnostic';
  if (candidate.score.objectivePrimary !== objective
    || candidate.score.provisionalSubjectivePrimary
      !== (scoredSubjective.length ? provisional : null)
    || candidate.score.primaryTotal !== (complete ? minimum : null)
    || candidate.score.range?.minimum !== minimum || candidate.score.range?.maximum !== maximum
    || candidate.forecast?.policyId !== EGE_MOCK_FORECAST_POLICY.id
    || candidate.forecast?.label !== EGE_MOCK_FORECAST_POLICY.label
    || candidate.forecast?.disclaimer !== EGE_MOCK_FORECAST_POLICY.disclaimer
    || candidate.forecast?.score
      !== (diagnostic && complete ? egeMockForecastScore(minimum) : null)
    || (diagnostic && (candidate.forecast?.range?.minimum !== egeMockForecastScore(minimum)
      || candidate.forecast?.range?.maximum !== egeMockForecastScore(maximum)))
    || (!diagnostic && candidate.forecast?.range !== null)
    || candidate.forecast?.baselineEligible !== diagnostic) invalid();
  if (candidate.recommendations.length !== weak.size) invalid();
  const seen = new Set();
  for (const recommendation of candidate.recommendations) {
    const definition = EGE_MOCK_RESULT_RECOMMENDATION_DEFINITIONS[recommendation?.skillId];
    const positions = weak.get(recommendation?.skillId);
    const provisionalEvidence = positions?.some((position) => position >= 37);
    if (!definition || seen.has(recommendation.skillId)
      || recommendation?.masteryCredit !== false || recommendation.id !== recommendation.skillId
      || recommendation.module !== definition.module || recommendation.href !== definition.href
      || !Array.isArray(recommendation.evidencePositions)
      || JSON.stringify(recommendation.evidencePositions) !== JSON.stringify(positions)
      || recommendation.evidenceKind !== (provisionalEvidence
        ? 'provisional_low_score' : 'objective_error')) invalid();
    seen.add(recommendation.skillId);
  }
  return candidate;
}

function displayAnswer(value) {
  if (value == null || (typeof value === 'string' && value.trim() === '')) return 'нет ответа';
  if (Array.isArray(value)) {
    if (!value.length || value.every((entry) => displayAnswer(entry) === 'нет ответа')) {
      return 'нет ответа';
    }
    return value.map(displayAnswer).join(' · ');
  }
  return String(value);
}

function resultItem(item) {
  const partialExactAnswer = item.scoreKind === 'exact' && Array.isArray(item.learnerAnswer)
    && item.learnerAnswer.some((value) => displayAnswer(value) === 'нет ответа')
    && item.learnerAnswer.some((value) => displayAnswer(value) !== 'нет ответа');
  const answerText = item.responseState === 'submitted_hidden'
    ? 'Ответ сохранён; содержимое скрыто в безопасном разборе.'
    : item.responseState === 'technical'
      ? 'Ответ не записан: сохранена техническая отметка.'
      : partialExactAnswer
        ? `Ответ заполнен частично: ${item.learnerAnswer.map(displayAnswer).join(' · ')}`
        : displayAnswer(item.learnerAnswer);
  const answer = `<p>Ваш ответ: ${escapeHtml(answerText)}</p>`;
  let authority = item.scoreKind === 'exact'
    ? `<p>Правильный ответ: ${escapeHtml(displayAnswer(item.correctAnswer))}</p>`
    : '<p>Критерии предварительной оценки:</p>';
  if (item.scoreKind === 'approximate') {
    const criteria = Array.isArray(item.criteria) && item.criteria.length
      ? `<ul>${item.criteria.map((criterion) => `<li>${escapeHtml(criterion.name)}: ${criterion.got} из ${criterion.max}</li>`).join('')}</ul>` : '';
    const feedback = item.feedback
      ? `<p>${escapeHtml(item.feedback.verdict)}</p><p>Следующий шаг: ${escapeHtml(item.feedback.nextStep)}</p>` : '';
    const evidence = Array.isArray(item.evidence) && item.evidence.length
      ? `<ul>${item.evidence.map((entry) => `<li><strong>${escapeHtml(entry.title)}</strong><p>Было: ${escapeHtml(entry.wrong)}</p><p>Лучше: ${escapeHtml(entry.right)}</p><p>${escapeHtml(entry.note)}</p></li>`).join('')}</ul>` : '';
    authority += criteria + feedback + evidence;
  }
  const score = item.score == null ? 'Оценка ещё не готова'
    : `${item.scoreKind === 'exact' ? 'Точный балл' : 'Предварительная оценка'}: ${item.score} из ${item.maximum}`;
  return `<li class="ege-mock__result-item"><details><summary>Задание ${item.position} · ${score}</summary>${answer}${authority}</details></li>`;
}

function historyMarkup(history) {
  if (history == null) return '';
  if (!Array.isArray(history.attempts)
    || history.attempts.length > EGE_MOCK_RESULT_HISTORY_LIMIT) invalid();
  const ids = new Set();
  let baselineCount = 0;
  const attempts = history.attempts.map((attempt) => {
    const result = assertCanonical(attempt?.result);
    if (!attempt?.id || ids.has(attempt.id) || attempt.id !== result.attemptId
      || attempt.formId !== result.formId || Number(attempt.formRevision) !== result.formRevision
      || attempt.mode !== result.mode || Number(attempt.attemptNumber) !== result.attemptNumber
      || attempt.label !== result.label || attempt.replacesBaseline !== false
      || attempt.isBaseline !== (attempt.id === history.baselineAttemptId)
      || (attempt.isBaseline && attempt.mode !== 'diagnostic')) invalid();
    ids.add(attempt.id);
    if (attempt.isBaseline) baselineCount += 1;
    const total = result.score.primaryTotal == null
      ? `${result.score.range.minimum}–${result.score.range.maximum}` : result.score.primaryTotal;
    return `<li><span>${escapeHtml(attempt.label)}${attempt.isBaseline ? ' · Исходная диагностика' : ''}</span><strong>${total} из 82</strong></li>`;
  });
  if ((history.baselineAttemptId == null && baselineCount !== 0)
    || (history.baselineAttemptId != null && baselineCount !== 1)) invalid();
  const content = attempts.length ? `<ol class="ege-mock__result-history">${attempts.join('')}</ol>`
    : '<p>Завершённых попыток пока нет.</p>';
  return `<section class="ege-mock__card"><h3>История пробников</h3>${content}</section>`;
}

export function egeMockResultTupleIsConsistent(envelope, history, attemptId) {
  if (typeof attemptId !== 'string' || attemptId.length === 0
    || !Array.isArray(history?.attempts)) return false;
  const current = history.attempts.filter((attempt) => attempt?.id === attemptId);
  if (current.length !== 1) return false;
  const canonical = envelope?.result?.canonical;
  return canonical?.attemptId === attemptId && current[0]?.result?.attemptId === attemptId
    && JSON.stringify(canonical) === JSON.stringify(current[0].result);
}

export function renderEgeMockResult(envelope, history = null, options = {}) {
  if (envelope?.available !== true || envelope.keysRevealed !== true
    || !egeMockAvailableResultMatchesComposite(envelope)) invalid();
  const result = assertCanonical(envelope.result?.canonical);
  const total = result.score.primaryTotal == null
    ? `${result.score.range.minimum}–${result.score.range.maximum}` : String(result.score.primaryTotal);
  const predicted = result.mode === 'training'
    ? 'Прогноз не пересчитывается по тренировочному повтору. Исходный прогноз сохранён в диагностике.'
    : result.forecast.score == null
      ? `${result.forecast.range.minimum}–${result.forecast.range.maximum}`
      : String(result.forecast.score);
  const pending = result.score.primaryTotal == null
    ? '<p class="ege-mock__status" role="status"><strong>Оценка ещё не готова.</strong> Уже рассчитанные точные баллы сохранены; отсутствующие предварительные компоненты не заменены нулём.</p>' : '';
  const sections = result.sections.map((section) => `<li><span>${escapeHtml(SECTION_LABELS[section.id])}</span><strong>${section.score == null ? '—' : section.score} из ${section.maximum}</strong><small>${section.scoreKind === 'exact' ? 'точно' : 'предварительно'}</small></li>`).join('');
  const recommendations = result.recommendations.length
    ? `<ul class="ege-mock__recommendations">${result.recommendations.map((item) => `<li><button type="button" class="ege-mock__action ege-mock__action--secondary" data-ege-result-screen="${escapeHtml(item.href.slice(1))}">${escapeHtml(item.label)} · задания ${item.evidencePositions.join(', ')}</button></li>`).join('')}</ul>`
    : '<p>По доступным данным отдельный слабый раздел не выделен.</p>';
  const baseline = history?.baselineAttemptId === result.attemptId
    ? '<p class="ege-mock__status">Этот результат закреплён как исходная диагностика.</p>' : '';
  const repeat = options.allowRepeat !== false
    ? '<section class="ege-mock__card"><h3>Повтор</h3><p>Новый проход раскрытого варианта будет тренировочным и не заменит исходную диагностику.</p><button type="button" class="ege-mock__action ege-mock__action--primary" data-ege-action="result-repeat">Начать тренировочный повтор</button></section>'
    : '';
  return `<section class="ege-mock__result" aria-labelledby="ege_mock_result_title">
    <header class="ege-mock__card ege-mock__result-summary"><p>${escapeHtml(result.label)}</p><h2 id="ege_mock_result_title" tabindex="-1">${total} из 82</h2>${baseline}${pending}<p><strong>${escapeHtml(result.forecast.label)}: ${escapeHtml(predicted)}</strong><br>${escapeHtml(result.forecast.disclaimer)} · ${escapeHtml(result.forecast.policyId)}</p><p>${escapeHtml(result.assessmentWarning)}</p></header>
    <section class="ege-mock__card"><h3>Баллы по разделам</h3><ul class="ege-mock__result-sections">${sections}</ul></section>
    ${historyMarkup(history)}
    <section class="ege-mock__card"><h3>Разбор заданий</h3><ol class="ege-mock__result-review">${result.items.map(resultItem).join('')}</ol></section>
    <section class="ege-mock__card"><h3>Что потренировать дальше</h3>${recommendations}<p>Ошибки пробника направляют тренировку, но не засчитываются как освоение темы.</p></section>
    ${repeat}
  </section>`;
}
