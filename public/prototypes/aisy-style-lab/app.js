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
let renderedState = null;
let pendingFocusSelector = '';
let activePaperOutgoing = null;
let paperTransitionTimeout = 0;
let bNavigationTimer = 0;
let bNavigationLocked = false;

document.body.dataset.embed = String(state.embed);
document.body.dataset.carrier = String(Boolean(initialCarrier));
document.body.dataset.carrierSize = initialCarrier || 'none';
document.body.dataset.focus = initialFocus || 'none';
toolbar.hidden = state.embed;
app.dataset.bPhase = 'idle';

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

function queueFocus(selector) {
  pendingFocusSelector = selector;
}

function clearPaperOutgoing() {
  if (paperTransitionTimeout) window.clearTimeout(paperTransitionTimeout);
  paperTransitionTimeout = 0;
  activePaperOutgoing?.remove();
  activePaperOutgoing = null;
  app.dataset.paperChromeTransitioning = 'false';
}

function motionDuration(name, fallback) {
  const value = getComputedStyle(app).getPropertyValue(name).trim();
  const amount = Number.parseFloat(value);
  if (!Number.isFinite(amount)) return fallback;
  return value.endsWith('ms') ? amount : value.endsWith('s') ? amount * 1000 : fallback;
}

function clearBNavigation() {
  if (bNavigationTimer) window.clearTimeout(bNavigationTimer);
  bNavigationTimer = 0;
  bNavigationLocked = false;
  app.dataset.bPhase = 'idle';
  app.removeAttribute('aria-busy');
}

function capturePaperOutgoing() {
  clearPaperOutgoing();
  const source = app.querySelector('.a-paper-surface:not(.a-paper-outgoing)');
  if (!source) return null;

  const appRect = app.getBoundingClientRect();
  const sourceRect = source.getBoundingClientRect();
  const clone = source.cloneNode(true);
  clone.classList.add('a-paper-outgoing');
  clone.dataset.paperLeaving = 'false';
  clone.setAttribute('aria-hidden', 'true');
  clone.setAttribute('inert', '');
  clone.querySelectorAll('[id]').forEach((element) => element.removeAttribute('id'));
  clone.querySelectorAll('button, a, [tabindex]').forEach((element) => element.setAttribute('tabindex', '-1'));
  Object.assign(clone.style, {
    left: `${sourceRect.left - appRect.left}px`,
    top: `${sourceRect.top - appRect.top}px`,
    width: `${sourceRect.width}px`,
    height: `${sourceRect.height}px`,
  });
  return clone;
}

function runPaperOutgoing(clone) {
  if (!clone) return;
  activePaperOutgoing = clone;
  const finish = (event) => {
    if (event && event.target !== clone) return;
    if (activePaperOutgoing !== clone) return;
    clearPaperOutgoing();
  };
  clone.addEventListener('transitionend', finish);
  void clone.offsetWidth;
  requestAnimationFrame(() => { clone.dataset.paperLeaving = 'true'; });
  paperTransitionTimeout = window.setTimeout(finish, 620);
}

function restorePendingFocus() {
  if (!pendingFocusSelector) return;
  const selector = pendingFocusSelector;
  pendingFocusSelector = '';
  const target = app.querySelector(selector);
  target?.focus({ preventScroll: true });
}

async function render() {
  const version = ++renderVersion;
  const viewModel = {
    ...projectScreen(state),
    allStates: LAB_FIXTURE.states,
  };
  const renderer = await loadRenderer(state.direction);
  if (version !== renderVersion) return;

  const isViewTransition = Boolean(hasRendered && renderedState && (
    renderedState.direction !== state.direction
    || renderedState.screen !== state.screen
    || renderedState.panel !== state.panel
  ));
  const isPaperTransition = Boolean(
    isViewTransition
    && renderedState.direction === 'a'
    && state.direction === 'a'
    && renderedState.panel === 'flow'
    && state.panel === 'flow'
    && renderedState.screen !== state.screen
  );
  if (!isPaperTransition) clearPaperOutgoing();
  const paperOutgoing = isPaperTransition ? capturePaperOutgoing() : null;

  phone.dataset.direction = state.direction;
  phone.dataset.panel = state.panel;
  app.dataset.direction = state.direction;
  app.dataset.screen = state.screen;
  app.dataset.fixtureState = state.fixtureState;
  app.dataset.transitioning = isViewTransition ? 'true' : 'false';
  app.dataset.paperChromeTransitioning = paperOutgoing ? 'true' : 'false';

  if (state.panel === 'components') app.innerHTML = foundation.renderComponents(viewModel);
  else if (state.panel === 'nav') app.innerHTML = foundation.renderNavProof(viewModel);
  else if (state.panel === 'motion') app.innerHTML = foundation.renderMotion(viewModel, motionPlaying);
  else app.innerHTML = renderer.renderScreen(viewModel, runtime);

  if (paperOutgoing) {
    app.append(paperOutgoing);
    runPaperOutgoing(paperOutgoing);
  }
  if (isViewTransition || pendingFocusSelector) requestAnimationFrame(() => {
    app.dataset.transitioning = 'false';
    restorePendingFocus();
  });
  else app.dataset.transitioning = 'false';
  hasRendered = true;
  renderedState = {
    direction: state.direction,
    screen: state.screen,
    panel: state.panel,
  };
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
  return render();
}

function navigateScreen(target) {
  if (!target || target === state.screen) {
    app.querySelector('.flow-screen')?.focus({ preventScroll: true });
    return;
  }

  const usesTactileTransition = Boolean(
    state.direction === 'b'
    && state.panel === 'flow'
    && app.querySelector('.b-instrument')
  );
  if (!usesTactileTransition) {
    queueFocus('.flow-screen');
    setPartial({ screen: target, panel: 'flow' });
    return;
  }
  if (bNavigationLocked) return;

  bNavigationLocked = true;
  app.dataset.bPhase = 'seat';
  app.setAttribute('aria-busy', 'true');
  const seatDuration = motionDuration('--motion-press-duration', 180);
  bNavigationTimer = window.setTimeout(async () => {
    app.dataset.bPhase = 'release';
    queueFocus('.flow-screen');
    await setPartial({ screen: target, panel: 'flow' });
    requestAnimationFrame(() => {
      app.dataset.bPhase = 'idle';
      const releaseDuration = motionDuration('--motion-feedback-duration', 220);
      bNavigationTimer = window.setTimeout(clearBNavigation, releaseDuration + 40);
    });
  }, seatDuration);
}

function nextScreen() {
  const index = FLOW_SCREENS.findIndex(({ id }) => id === state.screen);
  const target = FLOW_SCREENS[(index + 1) % FLOW_SCREENS.length];
  navigateScreen(target.id);
}

function previousScreen() {
  const index = FLOW_SCREENS.findIndex(({ id }) => id === state.screen);
  const target = FLOW_SCREENS[Math.max(0, index - 1)];
  navigateScreen(target.id);
}

document.addEventListener('click', (event) => {
  const button = event.target.closest('button, [data-set-direction], [data-set-panel]');
  if (!button) return;

  if (button.dataset.setDirection) {
    clearBNavigation();
    setPartial({ direction: button.dataset.setDirection });
    return;
  }
  if (button.dataset.setPanel) {
    clearBNavigation();
    setPartial({ panel: button.dataset.setPanel });
    return;
  }
  if (button.dataset.setScreen) {
    navigateScreen(button.dataset.setScreen);
    return;
  }
  if (button.dataset.duration) {
    runtime.duration = Number(button.dataset.duration);
    queueFocus(`[data-duration="${CSS.escape(button.dataset.duration)}"]`);
    render();
    return;
  }
  if (button.dataset.selectOption) {
    runtime.selectedOptionId = button.dataset.selectOption;
    queueFocus(`[data-select-option="${CSS.escape(button.dataset.selectOption)}"]`);
    render();
    return;
  }
  if (button.dataset.targetScreen) {
    navigateScreen(button.dataset.targetScreen);
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
    queueFocus('.icon-button');
    setPartial({ fixtureState: keys[(index + 1) % keys.length] });
    return;
  }
  if (button.hasAttribute('data-retry')) {
    queueFocus('.icon-button');
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
      navigateScreen(button.dataset.navTarget);
    } else {
      button.dataset.previewed = 'true';
      button.setAttribute('aria-label', `${button.textContent.trim()}: раздел сохранён в навигации, вне контура сравнения`);
    }
  }
});

window.addEventListener('popstate', () => {
  clearBNavigation();
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
  const radio = target?.closest('button[role="radio"]');
  if (radio && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
    const group = radio.closest('[role="radiogroup"]');
    const radios = [...(group?.querySelectorAll('button[role="radio"]') || [])];
    if (!radios.length) return;
    event.preventDefault();
    const index = radios.indexOf(radio);
    const offset = event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1;
    const nextIndex = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? radios.length - 1
        : (index + offset + radios.length) % radios.length;
    radios[nextIndex].click();
    return;
  }
  if (event.key === '[' || event.key === ']') {
    const index = DIRECTIONS.findIndex(({ id }) => id === state.direction);
    const offset = event.key === ']' ? 1 : -1;
    const targetDirection = DIRECTIONS[(index + offset + DIRECTIONS.length) % DIRECTIONS.length];
    setPartial({ direction: targetDirection.id });
  }
});

render();
