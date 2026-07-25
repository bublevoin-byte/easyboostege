import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await fs.readFile(new URL('../public/components.js', import.meta.url), 'utf8');

function createElement(tagName = 'DIV') {
  const attributes = new Map();
  const listeners = new Map();
  const classes = new Set();
  return {
    tagName,
    id: '',
    textContent: '',
    style: {},
    dataset: {},
    children: [],
    offsetWidth: 1,
    classList: {
      add: (...names) => names.forEach((name) => classes.add(name)),
      remove: (...names) => names.forEach((name) => classes.delete(name)),
      contains: (name) => classes.has(name),
    },
    setAttribute: (name, value) => attributes.set(name, String(value)),
    getAttribute: (name) => attributes.get(name) ?? null,
    addEventListener: (name, handler) => listeners.set(name, handler),
    dispatch: (name, event = {}) => listeners.get(name)?.(event),
    querySelectorAll: () => [],
  };
}

function createComponents() {
  const elements = new Map();
  const body = createElement('BODY');
  body.appendChild = (element) => elements.set(element.id, element);
  const document = {
    body,
    getElementById: (id) => elements.get(id) ?? null,
    createElement: (tagName) => createElement(tagName.toUpperCase()),
  };
  const window = { document, setTimeout, clearTimeout };
  vm.runInNewContext(source, { window, Object, String, Number, Math });
  return { components: window.EasyBoostComponents, elements };
}

test('frontend components safely render text, progress and HTML values', () => {
  const { components, elements } = createComponents();
  const label = createElement();
  const bar = createElement();
  const ring = createElement('circle');
  elements.set('label', label);
  elements.set('bar', bar);
  elements.set('ring', ring);

  components.setText('label', '<script>alert(1)</script>');
  components.setWidth('bar', 140);
  components.setRingOffset('ring', 200, 25);

  assert.equal(label.textContent, '<script>alert(1)</script>');
  assert.equal(bar.style.width, '100%');
  assert.equal(ring.getAttribute('stroke-dashoffset'), '150');
  assert.equal(components.escapeHtml(`<a title="'">&`), '&lt;a title=&quot;&#39;&quot;&gt;&amp;');
});

test('frontend components provide keyboard-accessible interactions and live notifications', () => {
  const { components, elements } = createComponents();
  const control = createElement('DIV');
  let activations = 0;
  components.makeInteractive(control, 'Открыть', () => {
    activations += 1;
  });

  control.dispatch('click', { stopPropagation() {} });
  control.dispatch('keydown', { key: 'Enter', preventDefault() {}, stopPropagation() {} });
  assert.equal(activations, 2);
  assert.equal(control.getAttribute('role'), 'button');
  assert.equal(control.getAttribute('tabindex'), '0');
  assert.equal(control.getAttribute('aria-label'), 'Открыть');

  const toast = components.notify('Готово', 0);
  assert.equal(elements.get('toast'), toast);
  assert.equal(toast.textContent, 'Готово');
  assert.equal(toast.getAttribute('aria-live'), 'polite');
});
