import {
  DIRECTIONS,
  FLOW_SCREENS,
  LAB_FIXTURE,
  normalizeLabState,
  projectScreen,
  stateFromSearch,
} from './data/fixtures.js';
import * as foundation from './renderers/foundation.js';

const app = document.querySelector('#app');
const phone = document.querySelector('[data-phone]');
const toolbar = document.querySelector('.lab-toolbar');
const params = new URLSearchParams(location.search);

const validPanels = new Set(['flow', 'components', 'motion', 'nav']);
const initialCarrier = params.get('carrier');
const initialFocus = params.get('focus');
let state = {
  ...stateFromSearch(location.search),
  panel: validPanels.has(params.get('panel')) ? params.get('panel') : 'flow',
  embed: params.get('embed') === '1',
};
let runtime = {
  duration: LAB_FIXTURE.today.duration,
  selectedOptionId: LAB_FIXTURE.task.selectedOptionId,
};
let motionPlaying = false;
let renderVersion = 0;
let hasRendered = false;

document.body.dataset.embed = String(state.embed);
document.body.dataset.carrier = String(Boolean(initialCarrier));
document.body.dataset.carrierSize = initialCarrier || 'none';
document.body.dataset.focus = initialFocus || 'none';
toolbar.hidden = state.embed;

function updateUrl({ push = false } = {}) {
  const next = new URL(location.href);
  next.searchParams.set('direction', state.direction);
  next.searchParams.set('screen', state.screen);
  next.searchParams.set('state', state.fixtureState);
  next.searchParams.set('panel', state.panel);
  if (state.embed) next.searchParams.set('embed', '1');
  else next.searchParams.delete('embed');
  history[push ? 'pushState' : 'replaceState'](state, '', next);
}

function syncReviewControls() {
  document.querySelectorAll('[data-set-direction]').forEach((button) => {
    const active = button.dataset.setDirection === state.direction;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  document.querySelectorAll('[data-set-panel]').forEach((button) => {
    const active = button.dataset.setPanel === state.panel;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', String(active));
  });
}

async function loadRenderer(direction) {
  try {
    return await import(`./renderers/${direction}.js`);
  } catch {
    return foundation;
  }
}

async function render() {
  const version = ++renderVersion;
  const viewModel = {
    ...projectScreen(state),
    allStates: LAB_FIXTURE.states,
  };
  const renderer = await loadRenderer(state.direction);
  if (version !== renderVersion) return;

  phone.dataset.direction = state.direction;
  phone.dataset.panel = state.panel;
  app.dataset.direction = state.direction;
  app.dataset.screen = state.screen;
  app.dataset.fixtureState = state.fixtureState;
  app.dataset.transitioning = hasRendered ? 'true' : 'false';

  if (state.panel === 'components') app.innerHTML = foundation.renderComponents(viewModel);
  else if (state.panel === 'nav') app.innerHTML = foundation.renderNavProof(viewModel);
  else if (state.panel === 'motion') app.innerHTML = foundation.renderMotion(viewModel, motionPlaying);
  else app.innerHTML = renderer.renderScreen(viewModel, runtime);

  if (hasRendered) requestAnimationFrame(() => app.dataset.transitioning = 'false');
  else app.dataset.transitioning = 'false';
  hasRendered = true;
  syncReviewControls();
  updateUrl();
}

function setPartial(next, { push = true } = {}) {
  state = { ...state, ...next };
  const normalized = normalizeLabState(state);
  state.direction = normalized.direction;
  state.screen = normalized.screen;
  state.fixtureState = normalized.fixtureState;
  updateUrl({ push });
  render();
}

function nextScreen() {
  const index = FLOW_SCREENS.findIndex(({ id }) => id === state.screen);
  const target = FLOW_SCREENS[(index + 1) % FLOW_SCREENS.length];
  setPartial({ screen: target.id, panel: 'flow' });
}

function previousScreen() {
  const index = FLOW_SCREENS.findIndex(({ id }) => id === state.screen);
  const target = FLOW_SCREENS[Math.max(0, index - 1)];
  setPartial({ screen: target.id, panel: 'flow' });
}

document.addEventListener('click', (event) => {
  const button = event.target.closest('button, [data-set-direction], [data-set-panel]');
  if (!button) return;

  if (button.dataset.setDirection) {
    setPartial({ direction: button.dataset.setDirection });
    return;
  }
  if (button.dataset.setPanel) {
    setPartial({ panel: button.dataset.setPanel });
    return;
  }
  if (button.dataset.setScreen) {
    setPartial({ screen: button.dataset.setScreen, panel: 'flow' });
    return;
  }
  if (button.dataset.duration) {
    runtime.duration = Number(button.dataset.duration);
    render();
    return;
  }
  if (button.dataset.selectOption) {
    runtime.selectedOptionId = button.dataset.selectOption;
    render();
    return;
  }
  if (button.dataset.action === 'next') {
    nextScreen();
    return;
  }
  if (button.dataset.action === 'back') {
    previousScreen();
    return;
  }
  if (button.hasAttribute('data-open-state')) {
    const keys = Object.keys(LAB_FIXTURE.states);
    const index = keys.indexOf(state.fixtureState);
    setPartial({ fixtureState: keys[(index + 1) % keys.length] });
    return;
  }
  if (button.hasAttribute('data-retry')) {
    setPartial({ fixtureState: 'ready' });
    return;
  }
  if (button.hasAttribute('data-replay-motion')) {
    motionPlaying = false;
    render().then(() => requestAnimationFrame(() => {
      motionPlaying = true;
      render();
    }));
    return;
  }
  if (button.dataset.navTarget) {
    if (button.dataset.navTarget === 'today' || button.dataset.navTarget === 'progress') {
      setPartial({ screen: button.dataset.navTarget, panel: 'flow' });
    } else {
      button.dataset.previewed = 'true';
      button.setAttribute('aria-label', `${button.textContent.trim()}: раздел сохранён в навигации, вне контура сравнения`);
    }
  }
});

window.addEventListener('popstate', () => {
  const nextParams = new URLSearchParams(location.search);
  state = {
    ...stateFromSearch(location.search),
    panel: validPanels.has(nextParams.get('panel')) ? nextParams.get('panel') : 'flow',
    embed: nextParams.get('embed') === '1',
  };
  document.body.dataset.embed = String(state.embed);
  const nextCarrier = nextParams.get('carrier');
  document.body.dataset.carrier = String(Boolean(nextCarrier));
  document.body.dataset.carrierSize = nextCarrier || 'none';
  document.body.dataset.focus = nextParams.get('focus') || 'none';
  toolbar.hidden = state.embed;
  render();
});

window.addEventListener('keydown', (event) => {
  const target = event.target instanceof Element ? event.target : null;
  if (target?.closest('input, textarea, [contenteditable="true"]')) return;
  if (event.key === '[' || event.key === ']') {
    const index = DIRECTIONS.findIndex(({ id }) => id === state.direction);
    const offset = event.key === ']' ? 1 : -1;
    const targetDirection = DIRECTIONS[(index + offset + DIRECTIONS.length) % DIRECTIONS.length];
    setPartial({ direction: targetDirection.id });
  }
});

render();
