import { TODAY_FIXTURE } from './fixture.js';
import { renderCoralRoute, renderLivingCanvas, renderProgressPulse } from './variants.js';

const VARIANTS = Object.freeze([
  Object.freeze({ key: 'A', name: 'Coral Route', render: renderCoralRoute }),
  Object.freeze({ key: 'B', name: 'Living Canvas', render: renderLivingCanvas }),
  Object.freeze({ key: 'C', name: 'Progress Pulse', render: renderProgressPulse }),
]);

const content = document.getElementById('prototype-variant');
const variantLabel = document.getElementById('prototype-variant-label');
const notice = document.getElementById('prototype-notice');
const DEFAULT_NOTICE = 'PROTOTYPE · Данные не изменяются.';

function variantFromUrl() {
  const requested = new URL(window.location.href).searchParams.get('variant')?.toUpperCase();
  return VARIANTS.find((variant) => variant.key === requested) || VARIANTS[0];
}

function replaceVariantInUrl(key) {
  const url = new URL(window.location.href);
  url.searchParams.set('variant', key);
  window.history.replaceState({ variant: key }, '', url);
}

function renderVariant({ normalizeUrl = false } = {}) {
  const variant = variantFromUrl();
  if (normalizeUrl) replaceVariantInUrl(variant.key);
  document.title = `${variant.key} — ${variant.name} · Aisy Today PROTOTYPE`;
  variantLabel.textContent = `${variant.key} — ${variant.name}`;
  content.innerHTML = variant.render(TODAY_FIXTURE);
  notice.textContent = DEFAULT_NOTICE;
  bindPrototypeActions();
}

function selectVariant(offset) {
  const current = variantFromUrl();
  const index = VARIANTS.findIndex((variant) => variant.key === current.key);
  const next = VARIANTS[(index + offset + VARIANTS.length) % VARIANTS.length];
  replaceVariantInUrl(next.key);
  renderVariant();
}

function bindPrototypeActions() {
  content.querySelectorAll('[data-minutes]').forEach((button) => {
    button.addEventListener('click', () => {
      notice.textContent = `PROTOTYPE · ${button.dataset.minutes} минут не выбраны.`;
    });
  });
  content.querySelector('[data-prototype-action]')?.addEventListener('click', () => {
    notice.textContent = 'PROTOTYPE · Запуск отключён.';
  });
}

document.querySelector('[data-switch="previous"]').addEventListener('click', () => selectVariant(-1));
document.querySelector('[data-switch="next"]').addEventListener('click', () => selectVariant(1));
window.addEventListener('popstate', () => renderVariant({ normalizeUrl: true }));
window.addEventListener('keydown', (event) => {
  const target = event.target;
  if (target instanceof Element && target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) return;
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  if (event.key === 'ArrowLeft') {
    event.preventDefault();
    selectVariant(-1);
  }
  if (event.key === 'ArrowRight') {
    event.preventDefault();
    selectVariant(1);
  }
});

renderVariant({ normalizeUrl: true });
