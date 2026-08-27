import {
  apiGet, apiMessage, apiResponseOwner, currentEgeMockOwnerBinding,
} from '../app.js';
import {
  EGE_MOCK_PUBLIC_FORM_FINGERPRINT,
  EGE_MOCK_PUBLIC_FORM_ID,
  EGE_MOCK_PUBLIC_FORM_REVISION,
} from '../ege-mock-catalog-contract.js';
import { egeMockLocalContinuation } from '../ege-mock-written-continuation.js';
import { projectEgeHub } from '../modules/ege-hub.js';
import { cur, nav, registerRouteHook } from '../router.js';

const ICON_PATHS = Object.freeze({
  headphones: ['M4 14v-2a8 8 0 0 1 16 0v2', 'M4 14h3v6H5a2 2 0 0 1-2-2v-2a2 2 0 0 1 1-2ZM20 14h-3v6h2a2 2 0 0 0 2-2v-2a2 2 0 0 0-1-2Z'],
  reading: ['M4 5.5h5a3 3 0 0 1 3 3V20H7a3 3 0 0 0-3 3V5.5Z', 'M20 5.5h-5a3 3 0 0 0-3 3V20h5a3 3 0 0 1 3 3V5.5Z'],
  grammar: ['M6 4h12v16H6z', 'M9 8h6M9 12h4M9 16h6'],
  pen: ['m4 20 4.5-1 10-10a2.1 2.1 0 0 0-3-3l-10 10L4 20Z', 'm13.5 8.5 3 3'],
  microphone: ['M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Z', 'M5 11v1a7 7 0 0 0 14 0v-1M12 19v3M8 22h8'],
});

let loadRevision = 0;

function ownerKey(owner) { return owner ? `${owner.username}\u0000${owner.generation}` : ''; }

function icon(name) {
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

function localContinuation(owner) {
  if (!owner) return null;
  return egeMockLocalContinuation(localStorage, owner, {
    identity: `${EGE_MOCK_PUBLIC_FORM_ID}@${EGE_MOCK_PUBLIC_FORM_REVISION}`,
    fingerprint: EGE_MOCK_PUBLIC_FORM_FINGERPRINT,
  });
}

function ownerStillCurrent(owner) {
  const current = currentEgeMockOwnerBinding();
  return cur() === 'aisy-ege' && current?.username === owner?.username
    && current?.generation === owner?.generation;
}

function strictMockIntentStillCurrent(revision, expectedOwnerKey) {
  return cur() === 'aisy-ege' && loadRevision === revision
    && ownerKey(currentEgeMockOwnerBinding()) === expectedOwnerKey;
}

function responseOwned(payload, owner) {
  return apiResponseOwner(payload) === owner?.username;
}

function button(label, className, action, disabled = false) {
  const control = document.createElement('button');
  control.type = 'button';
  control.className = className;
  control.textContent = label;
  control.disabled = disabled;
  control.addEventListener('click', action);
  return control;
}

async function openStrictMock(kind = 'start', attemptId = '') {
  const originRevision = loadRevision;
  const originOwnerKey = ownerKey(currentEgeMockOwnerBinding());
  let mockScreen;
  try {
    mockScreen = await import('./ege-mock.js');
  } catch {
    if (!strictMockIntentStillCurrent(originRevision, originOwnerKey)) return;
    const status = document.getElementById('ege-hub-state');
    if (!status) return;
    status.hidden = false;
    status.dataset.state = 'error';
    status.replaceChildren();
    const message = document.createElement('span');
    message.textContent = 'Не удалось открыть пробник. Проверьте соединение и повторите загрузку.';
    const retry = button(
      'Перезагрузить приложение', 'aisy-button aisy-button--secondary',
      () => window.location.reload(),
    );
    status.append(message, retry);
    return;
  }
  if (!strictMockIntentStillCurrent(originRevision, originOwnerKey)) return;
  mockScreen.setEgeMockOpenIntent(kind === 'result' ? { kind, attemptId }
    : kind === 'start' ? { kind: 'start' } : null);
  nav('scr16');
}

function openSection(section) {
  nav(section.screenId, (canCommit) => {
    if (!canCommit()) return;
    if (section.start && typeof window[section.start] === 'function') window[section.start]();
  });
}

function renderCurrent(view) {
  const root = document.getElementById('ege-hub-current');
  if (!root) return;
  root.replaceChildren();
  root.hidden = !view.current;
  if (!view.current) return;
  const copy = document.createElement('div');
  const title = document.createElement('h2');
  title.textContent = view.current.title;
  const description = document.createElement('p');
  description.textContent = view.current.description;
  copy.append(title, description);
  const action = button(
    view.current.action.label,
    'aisy-button ege-hub__action',
    () => { void openStrictMock('continue', view.current.action.attemptId); },
  );
  root.append(copy, action);
}

function renderFullMock(view) {
  const root = document.getElementById('ege-hub-full-mock');
  if (!root) return;
  const description = root.querySelector('[data-ege-hub-full-description]');
  const rationale = root.querySelector('[data-ege-hub-rationale]');
  const assessment = root.querySelector('[data-ege-hub-assessment]');
  const reason = root.querySelector('[data-ege-hub-start-reason]');
  const action = root.querySelector('[data-ege-hub-start]');
  if (description) description.textContent = view.fullMock.description;
  if (rationale) rationale.textContent = view.fullMock.rationale;
  if (assessment) assessment.textContent = view.fullMock.assessment;
  if (reason) {
    reason.textContent = view.fullMock.action.reason;
    reason.hidden = !view.fullMock.action.reason;
  }
  if (action) {
    action.textContent = view.fullMock.action.label;
    action.disabled = view.fullMock.action.disabled;
    action.onclick = () => { void openStrictMock('start'); };
    action.className = view.current
      ? 'aisy-button aisy-button--secondary ege-hub__action' : 'aisy-button ege-hub__action';
  }
}

function formatDate(value) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }).format(date)
    : '';
}

function resultCard(result, { latest = false } = {}) {
  const item = document.createElement('li');
  item.className = 'ege-hub-result';
  const copy = document.createElement('div');
  const heading = document.createElement(latest ? 'h2' : 'h3');
  heading.textContent = latest ? result.title : result.label;
  const summary = document.createElement('p');
  summary.textContent = `${result.label}${result.baseline ? ' · исходная диагностика' : ''}`;
  const meta = document.createElement('p');
  meta.className = 'ege-hub-result__meta';
  meta.textContent = [result.score, formatDate(result.completedAt)].filter(Boolean).join(' · ');
  copy.append(heading, summary, meta);
  const action = button(
    latest ? result.action.label : 'Открыть',
    'aisy-button aisy-button--secondary ege-hub__action',
    () => { void openStrictMock('result', result.attemptId); },
    latest ? result.action.disabled : navigator.onLine === false,
  );
  action.setAttribute('aria-label', `Открыть результат: ${result.label}`);
  item.append(copy, action);
  return item;
}

function renderResults(view) {
  const latestRoot = document.getElementById('ege-hub-latest');
  if (latestRoot) {
    latestRoot.replaceChildren();
    latestRoot.hidden = !view.latestResult;
    if (view.latestResult) latestRoot.appendChild(resultCard(view.latestResult, { latest: true }));
  }
  const historyRoot = document.getElementById('ege-hub-history');
  const historyList = document.getElementById('ege-hub-history-list');
  if (!historyRoot || !historyList) return;
  historyList.replaceChildren(...view.history.map((entry) => resultCard(entry)));
  historyRoot.hidden = view.history.length === 0;
}

function renderSections(view) {
  const root = document.getElementById('ege-hub-sections');
  if (!root) return;
  root.replaceChildren(...view.sections.map((section) => {
    const item = document.createElement('li');
    item.className = 'ege-hub-section';
    const mark = document.createElement('span');
    mark.className = 'ege-hub-section__icon';
    mark.appendChild(icon(section.icon));
    const copy = document.createElement('div');
    const heading = document.createElement('h3');
    heading.textContent = section.label;
    const range = document.createElement('p');
    range.textContent = section.range;
    copy.append(heading, range);
    const action = button(
      'Открыть', 'aisy-button aisy-button--secondary ege-hub__action', () => openSection(section),
    );
    action.setAttribute('aria-label', `Открыть раздел: ${section.label}`);
    item.append(mark, copy, action);
    return item;
  }));
}

function renderEgeHub(view) {
  const status = document.getElementById('ege-hub-state');
  if (status) {
    delete status.dataset.state;
    status.hidden = !view.network.label;
    status.textContent = view.network.label;
  }
  renderCurrent(view);
  renderFullMock(view);
  renderResults(view);
  renderSections(view);
}

function renderLoadError(error) {
  const status = document.getElementById('ege-hub-state');
  if (!status) return;
  status.hidden = false;
  status.dataset.state = 'error';
  status.replaceChildren();
  const message = document.createElement('span');
  message.textContent = apiMessage(error, 'request');
  const retry = button('Повторить', 'aisy-button aisy-button--secondary', () => { void loadEgeHub(); });
  status.append(message, retry);
}

function renderUnavailableHub(error, saved) {
  renderEgeHub(projectEgeHub({ localContinuation: saved, online: false }));
  const reason = document.querySelector('[data-ege-hub-start-reason]');
  if (reason) {
    reason.hidden = false;
    reason.textContent = 'Новую попытку нельзя начать, пока текущее состояние не подтверждено.';
  }
  renderLoadError(error);
}

async function loadEgeHub() {
  const revision = ++loadRevision;
  const owner = currentEgeMockOwnerBinding();
  const saved = localContinuation(owner);
  const loading = document.getElementById('ege-hub-state');
  if (loading) {
    loading.hidden = false;
    loading.textContent = navigator.onLine === false ? 'Проверяем сохранённую попытку…' : 'Проверяем попытки и результаты…';
  }
  if (navigator.onLine === false) {
    if (revision === loadRevision && cur() === 'aisy-ege') renderEgeHub(projectEgeHub({ localContinuation: saved, online: false }));
    return;
  }
  if (!owner) {
    renderUnavailableHub(new Error('Сессия ученика не подтверждена. Войдите снова.'), saved);
    return;
  }
  const headers = { 'X-EasyBoost-Expected-Owner': owner.username };
  try {
    const [current, history] = await Promise.all([
      apiGet('/api/v1/ege-mocks/attempts/current', { headers }),
      apiGet('/api/v1/ege-mocks/attempts/history', { headers }),
    ]);
    if (revision !== loadRevision || !ownerStillCurrent(owner)) return;
    if (!responseOwned(current, owner) || !responseOwned(history, owner)) {
      throw Object.assign(new Error('OWNER_CHANGED'), { code: 'OWNER_CHANGED', status: 409 });
    }
    renderEgeHub(projectEgeHub({
      currentAttempt: current.attempt,
      history,
      localContinuation: saved,
      online: true,
    }));
  } catch (error) {
    if (revision === loadRevision && ownerStillCurrent(owner)) renderUnavailableHub(error, saved);
  }
}

registerRouteHook((id) => {
  if (id === 'aisy-ege') void loadEgeHub();
  else loadRevision += 1;
});
window.addEventListener('online', () => { if (cur() === 'aisy-ege') void loadEgeHub(); });
window.addEventListener('offline', () => { if (cur() === 'aisy-ege') void loadEgeHub(); });

export { loadEgeHub, openSection, openStrictMock, renderEgeHub };
