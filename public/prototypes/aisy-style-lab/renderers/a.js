import {
  escapeHTML,
  icon,
  renderDuration,
  renderStatus,
  wrapFlow,
} from './common.js';
import {
  renderProgressScreen,
  renderReview,
  renderTask,
} from './foundation.js';

function renderPaperMap(blocks) {
  return `<section class="a-route-map" aria-label="Этапы сегодняшнего маршрута">
    <svg class="a-route-map__line" viewBox="0 0 300 56" preserveAspectRatio="none" aria-hidden="true">
      <path d="M48 28C82 7 112 49 150 28S218 11 252 28"/>
    </svg>
    <span class="a-route-map__goal" aria-hidden="true">✦</span>
    <ol class="a-route-map__stops">${blocks.map((block, index) => `
      <li data-block-state="${escapeHTML(block.state)}">
        <i>${index + 1}</i>
        <span><strong>${escapeHTML(block.label)}</strong><small>${escapeHTML(block.detail)}</small></span>
      </li>`).join('')}
    </ol>
  </section>`;
}

function renderPaperTab(step, label) {
  return `<span class="a-paper-tab" aria-hidden="true"><strong>${step}</strong><small>${escapeHTML(label)}</small></span>`;
}

function renderGoalLandmark() {
  return '<span class="a-goal-landmark" aria-hidden="true">✦</span>';
}

function renderToday(viewModel, runtime) {
  const { content, status } = viewModel;
  const duration = runtime.duration || content.duration;
  const isResume = viewModel.fixtureState === 'resume';
  const cta = isResume ? content.resumeCta : content.cta;
  const body = `
    ${viewModel.fixtureState === 'ready' ? '' : renderStatus(status)}
    <section class="hero recommendation-hero a-paper-surface">
      <span class="eyebrow">${escapeHTML(content.eyebrow)}</span>
      <h1>${escapeHTML(content.title)}</h1>
      <p>${escapeHTML(content.reason)}</p>
      ${renderDuration(content.durationOptions, duration)}
      ${renderPaperMap(content.blocks)}
      <button class="primary-button" type="button" data-action="next" data-target-screen="${escapeHTML(cta.target)}"><span>${escapeHTML(cta.label)}</span>${icon('arrow')}</button>
    </section>
    <section class="a-week-tail" aria-label="${escapeHTML(content.rhythm.label)}. До ЕГЭ ${viewModel.meta.egeCountdownDays} день">
      <span>${icon('sun')}</span>
      <strong>${content.rhythm.completedDays}/${content.rhythm.goalDays} дней · ЕГЭ через ${viewModel.meta.egeCountdownDays}</strong>
      <b>${content.rhythm.completedDays}/${content.rhythm.goalDays}</b>
    </section>`;
  return wrapFlow(viewModel, body);
}

export function renderScreen(viewModel, runtime = {}) {
  if (viewModel.screen === 'task') {
    return renderTask(viewModel, runtime, {
      surfaceClass: 'a-paper-surface',
      surfaceDecoration: renderPaperTab(3, 'Разбор'),
    });
  }
  if (viewModel.screen === 'review') {
    return renderReview(viewModel, {
      surfaceClass: 'a-paper-surface',
      surfaceDecoration: renderPaperTab(4, 'Прогресс'),
    });
  }
  if (viewModel.screen === 'progress') {
    return renderProgressScreen(viewModel, {
      surfaceClass: 'a-paper-surface',
      surfaceDecoration: renderGoalLandmark(),
    });
  }
  return renderToday(viewModel, runtime);
}
