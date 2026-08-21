import { readAdaptiveOverviewCacheSnapshot } from '../adaptive-overview-cache.js';
import '../modules/reading.js';
import { S, currentOwnerBinding, readingModule } from '../app.js';
import { projectPractice } from '../modules/practice.js';
import { cur, nav, registerRouteHook } from '../router.js';

const ICON_PATHS = Object.freeze({
  cards: ['M5 4h12a2 2 0 0 1 2 2v12H7a2 2 0 0 1-2-2V4Z', 'M9 8h6M9 12h6', 'M3 8v10a2 2 0 0 0 2 2h10'],
  grammar: ['M6 4h12v16H6z', 'M9 8h6M9 12h4M9 16h6'],
  reading: ['M4 5.5h5a3 3 0 0 1 3 3V20H7a3 3 0 0 0-3 3V5.5Z', 'M20 5.5h-5a3 3 0 0 0-3 3V20h5a3 3 0 0 1 3 3V5.5Z'],
  headphones: ['M4 14v-2a8 8 0 0 1 16 0v2', 'M4 14h3v6H5a2 2 0 0 1-2-2v-2a2 2 0 0 1 1-2ZM20 14h-3v6h2a2 2 0 0 0 2-2v-2a2 2 0 0 0-1-2Z'],
  pen: ['m4 20 4.5-1 10-10a2.1 2.1 0 0 0-3-3l-10 10L4 20Z', 'm13.5 8.5 3 3'],
  microphone: ['M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Z', 'M5 11v1a7 7 0 0 0 14 0v-1M12 19v3M8 22h8'],
});
let readingCatalog = null;
let readingCatalogRequest = null;

function ensureReadingDraftCatalog() {
  if (!S?.readingPilotDraft || readingCatalog || readingCatalogRequest) return;
  readingCatalogRequest = readingModule.loadPilotCatalog()
    .then((catalog) => {
      readingCatalog = catalog;
      readingCatalogRequest = null;
      if (cur() === 'aisy-practice') renderPractice();
    })
    .catch(() => { readingCatalogRequest = null; });
}

function skillIcon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '24');
  svg.setAttribute('height', '24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  (ICON_PATHS[name] || []).forEach((data) => {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', data);
    svg.appendChild(path);
  });
  return svg;
}

function cachedPlanFocus() {
  const owner = currentOwnerBinding();
  if (!owner) return null;
  const snapshot = readAdaptiveOverviewCacheSnapshot(localStorage, owner.username, Date.now(), owner.generation);
  const modules = snapshot?.payload?.plan?.allocation?.modules || [];
  return modules.reduce((best, candidate) => (
    Number(candidate?.percentage) > Number(best?.percentage) ? candidate : best
  ), modules[0])?.id || null;
}

function currentActiveSkills() {
  const active = [];
  if (window.hasActiveVocabularyPractice?.()) active.push('vocabulary');
  if (window.hasActiveReadingPractice?.()) active.push('reading');
  if (window.hasActiveListeningPractice?.()) active.push('listening');
  return active;
}

function loadedSkills() {
  const loaded = ['vocabulary', 'grammar'];
  if (typeof window.initReading === 'function') loaded.push('reading');
  if (typeof window.lHub === 'function') loaded.push('listening');
  if (typeof window.setTask === 'function') loaded.push('writing');
  if (typeof window.initSpeaking === 'function') loaded.push('speaking');
  return loaded;
}

function focusOpenedScreen(screenId) {
  requestAnimationFrame(() => {
    const screen = document.getElementById(screenId);
    if (!screen?.classList.contains('on')) return;
    const target = screen.querySelector('main, h1, [role="main"]') || screen;
    if (!target.hasAttribute('tabindex')) target.tabIndex = -1;
    target.focus({ preventScroll: true });
  });
}

function openSkill(screenId) {
  nav(screenId, (canCommit) => {
    if (canCommit()) focusOpenedScreen(screenId);
  });
}

function skillRow(skill, primarySkillId) {
  const item = document.createElement('li');
  item.className = 'practice-row aisy-surface';
  item.dataset.skill = skill.id;
  item.dataset.state = skill.state;
  item.dataset.availability = skill.availability;

  const icon = document.createElement('span');
  icon.className = 'practice-row__icon';
  icon.appendChild(skillIcon(skill.icon));

  const copy = document.createElement('div');
  copy.className = 'practice-row__copy';
  const heading = document.createElement('h2');
  heading.textContent = skill.label;
  const description = document.createElement('p');
  description.textContent = skill.description;
  const reason = document.createElement('p');
  reason.className = 'practice-row__reason';
  reason.textContent = skill.reason;
  const outcome = document.createElement('p');
  outcome.className = 'practice-row__outcome';
  outcome.textContent = skill.outcome;
  const availability = document.createElement('p');
  availability.className = 'practice-row__availability';
  availability.textContent = skill.availabilityLabel;
  copy.append(heading, description, reason, outcome, availability);

  const controls = document.createElement('div');
  controls.className = 'practice-row__controls';
  const state = document.createElement('span');
  state.className = 'practice-row__state';
  state.textContent = skill.stateLabel;
  const action = document.createElement('button');
  action.type = 'button';
  action.className = skill.id === primarySkillId
    ? 'aisy-button practice-row__action' : 'aisy-button aisy-button--secondary practice-row__action';
  action.textContent = skill.action.label;
  action.setAttribute('aria-label', `${skill.action.label}: ${skill.label}`);
  action.addEventListener('click', () => openSkill(skill.action.screenId));
  controls.append(state, action);
  item.append(icon, copy, controls);
  return item;
}

function primarySkill(skills) {
  for (const state of ['continue', 'review', 'recommended', 'available']) {
    const skill = skills.find((candidate) => candidate.state === state);
    if (skill) return skill.id;
  }
  return null;
}

function renderPractice() {
  const root = document.getElementById('practice-skills');
  if (!root) return;
  ensureReadingDraftCatalog();
  const view = projectPractice({
    learnerState: S,
    ownerBinding: currentOwnerBinding(),
    readingCatalog,
    activeSkills: currentActiveSkills(),
    loadedSkills: loadedSkills(),
    recommendedSkill: cachedPlanFocus(),
    online: navigator.onLine !== false,
  });
  const primarySkillId = primarySkill(view.skills);
  const title = document.getElementById('aisy-practice-title');
  const intro = document.getElementById('practice-intro');
  if (title) title.textContent = view.title;
  if (intro) intro.textContent = view.description;
  root.replaceChildren(...view.skills.map((skill) => skillRow(skill, primarySkillId)));
  const network = document.getElementById('practice-network-state');
  if (network) {
    network.hidden = navigator.onLine !== false;
    network.textContent = navigator.onLine === false
      ? 'Сейчас нет сети. В каждой строке указано, что уже доступно офлайн.' : '';
  }
}

registerRouteHook((id) => {
  if (id === 'aisy-practice') renderPractice();
});
window.addEventListener('online', () => { if (cur() === 'aisy-practice') renderPractice(); });
window.addEventListener('offline', () => { if (cur() === 'aisy-practice') renderPractice(); });

export { openSkill, renderPractice };
