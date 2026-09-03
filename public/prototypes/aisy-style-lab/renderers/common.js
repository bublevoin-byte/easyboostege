import { FLOW_SCREENS, NAV_ITEMS } from '../data/fixtures.js';

export const escapeHTML = (value = '') => String(value)
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#039;');

const iconPaths = {
  sun: '<circle cx="12" cy="12" r="3.5"/><path d="M12 2v2.2M12 19.8V22M2 12h2.2M19.8 12H22M4.9 4.9l1.6 1.6M17.5 17.5l1.6 1.6M19.1 4.9l-1.6 1.6M6.5 17.5l-1.6 1.6"/>',
  cards: '<rect x="5" y="4" width="14" height="16" rx="3"/><path d="M9 9h6M9 13h4"/>',
  target: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/><path d="M12 4V2M20 12h2"/>',
  chart: '<path d="M4 19V9M10 19V5M16 19v-7M22 19H2"/>',
  person: '<circle cx="12" cy="8" r="4"/><path d="M4.5 21c.8-4 3.3-6 7.5-6s6.7 2 7.5 6"/>',
  arrow: '<path d="m9 5 7 7-7 7"/>',
  back: '<path d="m15 5-7 7 7 7"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  cross: '<path d="m6 6 12 12M18 6 6 18"/>',
  spark: '<path d="m12 2 1.8 6.2L20 10l-6.2 1.8L12 18l-1.8-6.2L4 10l6.2-1.8L12 2Z"/>',
  cloud: '<path d="M7 18h10a4 4 0 0 0 .6-8 6 6 0 0 0-11.4 1.4A3.4 3.4 0 0 0 7 18Z"/>',
  alert: '<path d="M12 3 2.8 20h18.4L12 3Z"/><path d="M12 9v5M12 17h.01"/>',
};

export function icon(name, className = '') {
  const path = iconPaths[name] || iconPaths.spark;
  return `<svg class="icon ${escapeHTML(className)}" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;
}

export function renderProgress(value, label, className = '') {
  const percent = Math.max(0, Math.min(100, Math.round(Number(value) * 100)));
  return `<div class="progress ${escapeHTML(className)}" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}" aria-label="${escapeHTML(label)}"><span style="--progress:${percent}%"></span></div>`;
}

export function renderDuration(options, selected) {
  return `<div class="duration" role="radiogroup" aria-label="Длительность маршрута">${options.map((minutes) => `
    <button class="duration__option" type="button" role="radio" aria-checked="${minutes === selected}" tabindex="${minutes === selected ? '0' : '-1'}" data-duration="${minutes}">
      <strong>${minutes}</strong><span>мин</span>
    </button>`).join('')}</div>`;
}

function minutesLabel(minutes) {
  const mod10 = minutes % 10;
  const mod100 = minutes % 100;
  if (mod10 === 1 && mod100 !== 11) return 'минута';
  if ([2, 3, 4].includes(mod10) && ![12, 13, 14].includes(mod100)) return 'минуты';
  return 'минут';
}

export function routeBlocksForDuration(content, duration) {
  const estimates = content.durationEstimates?.[duration];
  if (!estimates) return content.blocks;
  return content.blocks.map((block) => {
    const minutes = estimates[block.id];
    if (!Number.isFinite(minutes)) return block;
    return { ...block, detail: `${minutes} ${minutesLabel(minutes)}` };
  });
}

export function renderChoice(option, state = 'default') {
  const marker = state === 'correct' ? icon('check') : state === 'incorrect' ? icon('cross') : `<span>${escapeHTML(option.id.toUpperCase())}</span>`;
  const suffix = state === 'correct' ? '<small>Верно</small>' : state === 'incorrect' ? '<small>Твой ответ</small>' : '';
  return `<button class="choice" type="button" role="radio" aria-checked="${state === 'selected'}" tabindex="${state === 'selected' ? '0' : '-1'}" data-choice-state="${escapeHTML(state)}" data-select-option="${escapeHTML(option.id)}">
    <i>${marker}</i><span>${escapeHTML(option.label)}</span>${suffix}
  </button>`;
}

export function renderStatus(status) {
  const iconName = status.tone === 'error' || status.tone === 'warning' ? 'alert' : status.tone === 'success' ? 'check' : 'cloud';
  return `<div class="state-strip" data-tone="${escapeHTML(status.tone)}" role="status">${icon(iconName)}<span>${escapeHTML(status.label)}</span>${status.action ? `<button type="button" data-retry>${escapeHTML(status.action)}</button>` : ''}</div>`;
}

export function renderFlowStepper(activeId) {
  return `<ol class="flow-stepper" aria-label="Этапы сравнения">${FLOW_SCREENS.map((item) => `
    <li class="${item.id === activeId ? 'is-active' : ''}">
      <button type="button" data-set-screen="${item.id}" aria-current="${item.id === activeId ? 'step' : 'false'}"><span>${item.step}</span><small>${escapeHTML(item.label)}</small></button>
    </li>`).join('')}</ol>`;
}

export function renderBottomNav(activeId = 'today') {
  return `<nav class="bottom-nav" aria-label="Основная навигация">${NAV_ITEMS.map((item) => `
    <button type="button" data-nav-target="${item.id}" class="${item.id === activeId ? 'is-active' : ''}" aria-current="${item.id === activeId ? 'page' : 'false'}">
      <span>${icon(item.icon)}</span><small>${escapeHTML(item.label)}</small>
    </button>`).join('')}</nav>`;
}

export function renderPhoneHeader(viewModel, { deep = false } = {}) {
  return `<header class="app-header">
    <img class="app-mark" src="../onboarding-v1/assets/aisy-mark-primary-color-transparent.png" alt="Aisy">
    <div><small>${escapeHTML(viewModel.directionMeta.label)} · ${escapeHTML(viewModel.directionMeta.name)}</small><strong>${deep ? escapeHTML(viewModel.flowMeta.label) : 'Твой маршрут'}</strong></div>
    <button class="icon-button" type="button" data-open-state aria-label="Показать состояния">${icon('spark')}</button>
  </header>`;
}

export function wrapFlow(viewModel, content, {
  deep = false,
  activeNav,
  deepAction = 'Продолжить',
  deepTarget = '',
} = {}) {
  const navId = activeNav || (viewModel.screen === 'progress' ? 'progress' : 'today');
  return `${renderPhoneHeader(viewModel, { deep })}
    <div class="app-scroll" data-screen-scroll>
      ${renderFlowStepper(viewModel.screen)}
      <main class="flow-screen" data-flow-screen="${escapeHTML(viewModel.screen)}" tabindex="-1">${content}</main>
    </div>
    ${deep ? `<div class="deep-dock">
      <button class="deep-dock__back" type="button" data-action="back" aria-label="Назад">${icon('back')}</button>
      <button class="deep-dock__primary" type="button" data-action="next"${deepTarget ? ` data-target-screen="${escapeHTML(deepTarget)}"` : ''}><span>${escapeHTML(deepAction)}</span>${icon('arrow')}</button>
    </div>` : renderBottomNav(navId)}`;
}
