import { renderScreen as renderFoundationScreen } from './foundation.js';

const STAGES = [
  { id: 'today', offset: 1, fromOffset: 1, icon: '<path d="M7 19V6m0 2c4-3 7 3 11-1v8c-4 4-7-2-11 1"/>' },
  { id: 'task', offset: 0.67, fromOffset: 1, icon: '<path d="M6 7h12M6 12h8M6 17h10"/>' },
  { id: 'review', offset: 0.33, fromOffset: 0.67, icon: '<path d="M5 5h14v14H5zM8 12l2.5 2.5L16 9"/>' },
  { id: 'progress', offset: 0, fromOffset: 0.33, icon: '<path d="m12 3 2.5 5.5 6 .7-4.4 4 1.2 5.8-5.3-3-5.3 3 1.2-5.8-4.4-4 6-.7Z"/>' },
];

function renderJourneyStage(screen) {
  const activeIndex = Math.max(0, STAGES.findIndex(({ id }) => id === screen));
  const stage = STAGES[activeIndex];
  const stops = STAGES.map(({ id, icon }, index) => {
    const state = index === activeIndex ? 'is-current' : index < activeIndex ? 'is-reached' : 'is-ahead';
    return `<i class="c-journey__stop c-journey__stop--${id} ${state}"><svg viewBox="0 0 24 24">${icon}</svg></i>`;
  }).join('');

  return `<div class="c-journey c-journey--${stage.id}" style="--c-route-offset:${stage.offset};--c-route-from-offset:${stage.fromOffset}" aria-hidden="true">
    <svg class="c-journey__art" width="320" height="112" viewBox="0 0 320 112" preserveAspectRatio="none" focusable="false">
      <path class="c-journey__paper c-journey__paper--back" d="M0 74C42 48 75 63 112 51s73-39 116-25 57-7 92-26v112H0Z"/>
      <path class="c-journey__paper c-journey__paper--front" d="M0 96c49-27 87-6 129-24s80-2 116-20 49-10 75-25v85H0Z"/>
      <path class="c-journey__trail c-journey__trail--base" pathLength="1" d="M38 92C72 88 72 72 111 71s49-18 94-22 43-17 79-27"/>
      <path class="c-journey__trail c-journey__trail--progress" pathLength="1" d="M38 92C72 88 72 72 111 71s49-18 94-22 43-17 79-27"/>
      <path class="c-journey__tomorrow" d="M284 22c12-5 20-10 30-17"/>
    </svg>
    ${stops}
  </div>`;
}

export function renderScreen(viewModel, runtime = {}) {
  const screenClass = `c-story-stage c-story-stage--${viewModel.screen}`;
  return renderFoundationScreen(viewModel, runtime, {
    surfaceClass: screenClass,
    surfaceDecoration: renderJourneyStage(viewModel.screen),
  });
}
