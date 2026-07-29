import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

/*
 * Код предметных экранов приезжает отдельными чанками, поэтому «приложение» — это оболочка
 * public/app.js плюс всё, что лежит в public/screens.
 */
async function readApplicationSource() {
  const screensDirectory = new URL('../public/screens/', import.meta.url);
  const names = (await fs.readdir(screensDirectory)).filter((name) => name.endsWith('.js')).sort();
  const sources = await Promise.all([
    fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
    ...names.map((name) => fs.readFile(new URL(name, screensDirectory), 'utf8')),
  ]);
  return sources.join('\n');
}

const source = await fs.readFile(new URL('../public/components.js', import.meta.url), 'utf8');
const appSource = await readApplicationSource();
const htmlSource = await fs.readFile(new URL('../public/index.html', import.meta.url), 'utf8');

function createComponents() {
  const window = { document: { getElementById: () => null, createElement: () => ({ setAttribute() {} }) } };
  vm.runInNewContext(source, { window, Object, Number, Math, Array, String, Boolean });
  return window.EasyBoostComponents;
}

test('loading state announces itself politely and shows a spinner', () => {
  const ui = createComponents();
  const markup = ui.stateMarkup({ kind: 'loading', title: 'ИИ придумывает задание', description: 'Несколько секунд' });

  assert.match(markup, /role="status"/u);
  assert.match(markup, /aria-live="polite"/u);
  assert.match(markup, /ebstate-spin/u);
  assert.match(markup, /ИИ придумывает задание/u);
  assert.doesNotMatch(markup, /ebstate-action/u);
});

test('success and empty states are distinct and carry a glyph', () => {
  const ui = createComponents();
  const success = ui.stateMarkup({ kind: 'success', title: 'Готово' });
  const empty = ui.stateMarkup({ kind: 'empty', title: 'Пока пусто', actionLabel: 'Начать занятие' });

  assert.match(success, /ebstate-success/u);
  assert.match(success, /✓/u);
  assert.match(empty, /ebstate-empty/u);
  assert.match(empty, /<button type="button" class="ebstate-action sq">Начать занятие<\/button>/u);
  assert.notEqual(success, empty);
});

test('error state is assertive and offers a retry action', () => {
  const ui = createComponents();
  const markup = ui.stateMarkup({ kind: 'error', title: 'ИИ недоступен', description: 'Сеть не отвечает', actionLabel: 'Повторить' });

  assert.match(markup, /role="alert"/u);
  assert.doesNotMatch(markup, /aria-live/u);
  assert.match(markup, /Повторить/u);
});

test('state content is escaped', () => {
  const ui = createComponents();
  const markup = ui.stateMarkup({ kind: 'empty', title: '<img src=x onerror=alert(1)>', description: '"&<>' });

  assert.doesNotMatch(markup, /<img/u);
  assert.match(markup, /&lt;img/u);
  assert.match(markup, /&quot;&amp;&lt;&gt;/u);
});

test('an unknown kind falls back to loading instead of breaking the screen', () => {
  const ui = createComponents();
  assert.match(ui.stateMarkup({ kind: 'nonsense', title: 'x' }), /ebstate-loading/u);
  assert.match(ui.stateMarkup(), /ebstate-loading/u);
});

test('the application wires all four states to real operations', () => {
  assert.match(appSource, /kind:'loading',title:'ИИ придумывает задание'/u);
  assert.match(appSource, /kind:'success',title:'Готово — новое задание'/u);
  assert.match(appSource, /kind:'error',title:'ИИ недоступен'[\s\S]{0,200}actionLabel:'Повторить'/u);
  assert.match(appSource, /kind:'empty',title:'Пока пусто'/u);
  assert.match(appSource, /kind:'empty',title:'Проверенных работ пока нет'/u);
  // Leaving the screen must not leave a stale banner behind.
  assert.match(appSource, /if\(!show\)genStateClear\(\)/u);
  assert.match(htmlSource, /\.ebstate\{/u);
  assert.match(htmlSource, /#genstate:empty\{display:none\}/u);
});
