import {
  escapeHTML,
  icon,
  renderBottomNav,
  renderChoice,
  renderDuration,
  renderFlowStepper,
  renderPhoneHeader,
  renderProgress,
  renderStatus,
  routeBlocksForDuration,
  wrapFlow,
} from './common.js';
import { BORROWINGS, DIRECTIONS } from '../data/fixtures.js';

const surfaceClassName = (base, extra = '') => [base, extra].filter(Boolean).join(' ');

export function renderToday(viewModel, runtime, { surfaceClass = '', surfaceDecoration = '' } = {}) {
  const { content, status } = viewModel;
  const duration = runtime.duration || content.duration;
  const routeBlocks = routeBlocksForDuration(content, duration);
  const isResume = viewModel.fixtureState === 'resume';
  const cta = isResume ? content.resumeCta : content.cta;
  const body = `
    ${viewModel.fixtureState === 'ready' ? '' : renderStatus(status)}
    <section class="${surfaceClassName('hero recommendation-hero', surfaceClass)}">
      ${surfaceDecoration}
      <div class="hero__ornament" aria-hidden="true">${icon('spark')}</div>
      <span class="eyebrow">${escapeHTML(content.eyebrow)}</span>
      <h1>${escapeHTML(content.title)}</h1>
      <p>${escapeHTML(content.reason)}</p>
      ${renderDuration(content.durationOptions, duration)}
      <ol class="route-list" aria-live="polite" aria-label="Маршрут на ${duration} минут">${routeBlocks.map((block, index) => `<li data-block-state="${escapeHTML(block.state)}"><i>${index + 1}</i><span><strong>${escapeHTML(block.label)}</strong><small>${escapeHTML(block.detail)}</small></span></li>`).join('')}</ol>
      <button class="primary-button" type="button" data-action="next" data-target-screen="${escapeHTML(cta.target)}"><span>${escapeHTML(cta.label)}</span>${icon('arrow')}</button>
    </section>
    <section class="mini-proof" aria-label="Ритм недели">
      <span>${icon('sun')}</span><div><strong>${escapeHTML(content.rhythm.label)}</strong><small>До ЕГЭ ${viewModel.meta.egeCountdownDays} день</small></div>
      <b>${content.rhythm.completedDays}/${content.rhythm.goalDays}</b>
    </section>`;
  return wrapFlow(viewModel, body);
}

export function renderTask(viewModel, runtime, { surfaceClass = '', surfaceDecoration = '' } = {}) {
  const { content } = viewModel;
  const selected = runtime.selectedOptionId || content.selectedOptionId;
  const body = `
    <section class="${surfaceClassName('task-sheet', surfaceClass)}">
      ${surfaceDecoration}
      <div class="task-meta"><span class="badge">${escapeHTML(content.section)}</span><strong>${escapeHTML(content.progressLabel)}</strong></div>
      ${renderProgress(content.progress, content.progressLabel)}
      <span class="eyebrow">${escapeHTML(content.promptLead)}</span>
      <h1 class="task-prompt">${escapeHTML(content.sentenceBefore)}<mark>${escapeHTML(content.gap)}</mark>${escapeHTML(content.sentenceAfter)}</h1>
      <div class="choices" role="radiogroup" aria-label="Варианты ответа">${content.options.map((option) => renderChoice(option, option.id === selected ? 'selected' : 'default')).join('')}</div>
      <div class="task-assistance">${icon('check')}<span>${escapeHTML(content.assistance.label)}</span></div>
    </section>`;
  return wrapFlow({ ...viewModel, taskLabel: content.section }, body, {
    deep: true,
    deepAction: content.cta.label,
    deepTarget: content.cta.target,
  });
}

export function renderReview(viewModel, { surfaceClass = '', surfaceDecoration = '' } = {}) {
  const { content } = viewModel;
  const body = `
    <section class="${surfaceClassName('review-sheet', surfaceClass)}">
      ${surfaceDecoration}
      <div class="result-mark">${icon('cross')}<span>${escapeHTML(content.resultLabel)}</span></div>
      <span class="eyebrow">${escapeHTML(content.eyebrow)}</span>
      <h1>${escapeHTML(content.title)}</h1>
      <div class="answer-compare"><del>${escapeHTML(content.selectedAnswer)}</del>${icon('arrow')}<ins>${escapeHTML(content.correctAnswer)}</ins></div>
      <p>${escapeHTML(content.explanation)}</p>
      <div class="rule-card"><small>Правило, которое пригодится снова</small><strong>${escapeHTML(content.reusableRule)}</strong><span>${escapeHTML(content.example)}</span></div>
      <div class="evidence-row"><span>${icon('spark')}</span><div><strong>${escapeHTML(content.evidence.label)}</strong><small>Прогресс изменён только по твоей попытке</small></div><b>+${content.evidence.masteryDelta}</b></div>
    </section>`;
  return wrapFlow(viewModel, body, {
    deep: true,
    deepAction: content.cta.label,
    deepTarget: content.cta.target,
  });
}

export function renderProgressScreen(viewModel, { surfaceClass = '', surfaceDecoration = '' } = {}) {
  const { content } = viewModel;
  const body = `
    <section class="${surfaceClassName('hero progress-hero', surfaceClass)}">
      ${surfaceDecoration}
      <span class="eyebrow">${escapeHTML(content.eyebrow)}</span>
      <h1>${escapeHTML(content.title)}</h1>
      <div class="score-change"><span>${content.before}</span>${icon('arrow')}<strong>${content.after}%</strong><em>${escapeHTML(content.scoreLabel)}</em></div>
      ${renderProgress(content.after / 100, `${content.skill}: ${content.after}%`)}
      <div class="progress-copy"><small>Что улучшилось</small><strong>${escapeHTML(content.skill)}</strong><p>${escapeHTML(content.improvement)}</p></div>
      <div class="next-step"><span>${icon('spark')}</span><div><small>Следующий шаг</small><strong>${escapeHTML(content.next)}</strong></div></div>
      <button class="primary-button" type="button" data-action="next" data-target-screen="${escapeHTML(content.cta.target)}"><span>${escapeHTML(content.cta.label)}</span>${icon('arrow')}</button>
    </section>
    <section class="mini-proof"><span>${icon('chart')}</span><div><strong>${content.week.completedDays} из ${content.week.goalDays} дней</strong><small>${content.week.minutes} минут практики</small></div><b>${content.week.completedDays}/${content.week.goalDays}</b></section>`;
  return wrapFlow(viewModel, body, { activeNav: 'progress' });
}

export function renderScreen(viewModel, runtime = {}, options = {}) {
  if (viewModel.screen === 'task') return renderTask(viewModel, runtime, options);
  if (viewModel.screen === 'review') return renderReview(viewModel, options);
  if (viewModel.screen === 'progress') return renderProgressScreen(viewModel, options);
  return renderToday(viewModel, runtime, options);
}

export function renderComponents(viewModel) {
  const sampleOptions = viewModel.content?.options || [
    { id: 'a', label: 'had left' },
    { id: 'b', label: 'would leave' },
  ];
  return `${renderPhoneHeader(viewModel)}
    <div class="app-scroll gallery-scroll">
      <div class="gallery-heading"><span class="eyebrow">Общая система</span><h1>Компоненты и состояния</h1><p>Одинаковые контракты для A, B и C.</p></div>
      <section class="gallery-section"><h2>Действия</h2>
        <button class="primary-button" type="button"><span>Продолжить маршрут</span>${icon('arrow')}</button>
        <button class="secondary-button" type="button">Изменить длительность</button>
        <button class="primary-button" type="button" disabled aria-disabled="true"><span>Маршрут недоступен</span></button>
      </section>
      <section class="gallery-section"><h2>Длительность</h2>${renderDuration([10, 20, 30, 40], 20)}</section>
      <section class="gallery-section"><h2>Ответ</h2><div class="choices">
        ${renderChoice(sampleOptions[0], 'selected')}
        ${renderChoice(sampleOptions[1], 'incorrect')}
        ${renderChoice({ id: 'c', label: 'had left' }, 'correct')}
      </div></section>
      <section class="gallery-section"><h2>Системные состояния</h2>
        ${['ready', 'diagnostic', 'offline', 'error'].map((id) => renderStatus(viewModel.allStates[id])).join('')}
      </section>
      <section class="gallery-section"><h2>Прогресс</h2>${renderProgress(0.65, 'Точность 65%')}<div class="badge-row"><span class="badge">Самостоятельно</span><span class="badge badge--support">Нужна практика</span></div></section>
    </div>${renderBottomNav('today')}`;
}

export function renderMotion(viewModel, playing = false) {
  return `${renderPhoneHeader(viewModel)}
    <div class="app-scroll motion-scroll">
      <div class="gallery-heading"><span class="eyebrow">Motion lab</span><h1>${escapeHTML(viewModel.directionMeta.name)}</h1><p>Один signature-эффект за переход.</p></div>
      <section class="motion-stage" data-signature="${escapeHTML(viewModel.directionMeta.signature)}" data-motion-playing="${playing}">
        <div class="motion-paper" aria-hidden="true"><i></i><i></i><i></i></div>
        <div class="motion-widget" aria-hidden="true"><span></span><b>20</b></div>
        <svg class="motion-route" viewBox="0 0 220 260" aria-hidden="true"><path d="M28 230C65 205 45 165 95 145s40-66 92-92"/><circle cx="28" cy="230" r="8"/><circle cx="187" cy="53" r="10"/></svg>
        <strong>Сегодня</strong><span>Задание</span><em>Прогресс</em>
      </section>
      <div class="motion-spec"><span>Нажатие <b>180 мс</b></span><span>Переход <b>420 мс</b></span><span>Signature <b>до 500 мс</b></span></div>
      <button class="primary-button" type="button" data-replay-motion><span>Повторить анимацию</span>${icon('spark')}</button>
      <p class="motion-note">При reduced motion маршрут не перемещается: остаётся короткая смена opacity.</p>
    </div>${renderBottomNav('today')}`;
}

export function renderNavProof(viewModel) {
  return `${renderPhoneHeader(viewModel)}
    <div class="app-scroll nav-proof-scroll">
      <div class="gallery-heading"><span class="eyebrow">Shell contract</span><h1>Пять разделов снизу</h1><p>Один порядок на любом viewport; side rail не существует.</p></div>
      <section class="nav-proof-card">
        <small>Четыре этапа в полном размере</small>
        <div class="flow-specimen">${renderFlowStepper('progress')}</div>
      </section>
      <section class="nav-proof-card">
        <small>Пять разделов в полном размере</small>
        <div class="nav-specimen">${renderBottomNav('today')}</div>
      </section>
    </div>${renderBottomNav('today')}`;
}

export function renderDecision(viewModel, decision = { base: '', borrowings: [] }) {
  const selectedBorrowings = new Set(decision.borrowings);
  const selectedBase = DIRECTIONS.find(({ id }) => id === decision.base);
  const borrowingLimitReached = selectedBorrowings.size >= 2;
  const availableBorrowings = selectedBase
    ? BORROWINGS.filter((item) => item.direction !== selectedBase.id)
    : BORROWINGS;
  const baseOptions = DIRECTIONS.map((direction) => {
    const selected = direction.id === decision.base;
    const tabStop = selected || (!decision.base && direction.id === DIRECTIONS[0].id);
    return `<button class="decision-base-card${selected ? ' is-selected' : ''}" type="button" role="radio" aria-checked="${selected}" tabindex="${tabStop ? '0' : '-1'}" data-set-base="${escapeHTML(direction.id)}">
      <span>${escapeHTML(direction.label)}</span>
      <strong>${escapeHTML(direction.name)}</strong>
      <small>${escapeHTML(direction.decisionHint)}</small>
    </button>`;
  }).join('');
  const borrowingOptions = availableBorrowings.map((item) => {
    const selected = selectedBorrowings.has(item.id);
    const disabled = !decision.base || (borrowingLimitReached && !selected);
    const direction = DIRECTIONS.find(({ id }) => id === item.direction);
    const stateLabel = selected
      ? 'Выбрано'
      : !decision.base
          ? 'Сначала основа'
          : borrowingLimitReached
            ? 'Лимит 2 из 2'
            : `Из ${direction.label}`;
    return `<button class="decision-borrow${selected ? ' is-selected' : ''}" type="button" role="checkbox" aria-checked="${selected}" data-toggle-borrowing="${escapeHTML(item.id)}"${disabled ? ' disabled aria-disabled="true"' : ''}>
      <span><b>${escapeHTML(direction.label)}</b><strong>${escapeHTML(item.label)}</strong></span>
      <small>${escapeHTML(item.detail)}</small>
      <em>${escapeHTML(stateLabel)}</em>
    </button>`;
  }).join('');
  const selectedLabels = decision.borrowings.map((id) => BORROWINGS.find((item) => item.id === id)?.label).filter(Boolean);
  const summaryTitle = selectedBase ? `${selectedBase.label} · ${selectedBase.name}` : 'Основа ещё не выбрана';

  return `${renderPhoneHeader(viewModel)}
    <div class="app-scroll decision-scroll">
      <div class="gallery-heading decision-heading"><span class="eyebrow">Лист решения</span><h1>Зафиксируй стилистику</h1><p>Одна основа и максимум два точных заимствования.</p></div>
      <section class="decision-section" aria-labelledby="decision-base-title">
        <div class="decision-section__heading"><span><b>1</b><strong id="decision-base-title">Выбери основу</strong></span><small>Обязательный выбор</small></div>
        <div class="decision-base-group" role="radiogroup" aria-label="Основная стилистика">${baseOptions}</div>
      </section>
      <section class="decision-section" aria-labelledby="decision-borrow-title">
        <div class="decision-section__heading"><span><b>2</b><strong id="decision-borrow-title">Добавь детали</strong></span><small class="decision-counter" role="status">${selectedBorrowings.size} из 2</small></div>
        <div class="decision-borrow-group" role="group" aria-label="Заимствования из других направлений">${borrowingOptions}</div>
      </section>
      <section class="decision-summary" data-complete="${Boolean(selectedBase)}" aria-label="Итог выбора">
        <small>Твой выбор</small>
        <strong>${escapeHTML(summaryTitle)}</strong>
        <p>${selectedBase
          ? selectedLabels.length
            ? `Заимствования: ${selectedLabels.map(escapeHTML).join(' · ')}`
            : 'Без заимствований — чистое направление.'
          : 'Сначала выбери A, B или C. Ссылка обновится автоматически.'}</p>
        <button class="secondary-button" type="button" data-reset-decision${selectedBase || selectedBorrowings.size ? '' : ' disabled'}>Сбросить выбор</button>
      </section>
    </div>${renderBottomNav('today')}`;
}
