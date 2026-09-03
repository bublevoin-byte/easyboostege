import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import { cssLayer as layer } from './helpers/css.js';

const publicUrl = new URL('../public/', import.meta.url);

async function readPublic(name) {
  return fs.readFile(new URL(name, publicUrl), 'utf8');
}

function properties(css) {
  return new Map([...css.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/gu)]
    .map((match) => [match[1], match[2].trim()]));
}

test('production A foundation publishes three token layers and self-hosted typography', async () => {
  const [css, html] = await Promise.all([
    readPublic('aisy-theme.css'),
    readPublic('index.html'),
  ]);

  assert.match(css, /@layer\s+aisy-primitives,\s*aisy-semantic,\s*aisy-components\s*;/u);
  const primitives = properties(layer(css, 'aisy-primitives'));
  const semanticLayer = layer(css, 'aisy-semantic');
  const semantic = properties(semanticLayer);
  const componentLayer = layer(css, 'aisy-components');
  const components = properties(componentLayer);

  assert.equal(primitives.get('--aisy-primitive-paper-0'), '#fffdf9');
  assert.equal(primitives.get('--aisy-primitive-ink-plum'), '#35263d');
  assert.equal(primitives.get('--aisy-primitive-coral-action'), '#b9433a');
  assert.equal(primitives.get('--aisy-primitive-font-body'), '16px');
  assert.equal(
    semantic.get('--aisy-color-background'),
    'light-dark(var(--aisy-primitive-paper-1), var(--aisy-primitive-night-canvas))',
  );
  assert.equal(
    semantic.get('--aisy-color-primary'),
    'light-dark(var(--aisy-primitive-coral-action), var(--aisy-primitive-coral-action-dark))',
  );
  assert.equal(
    semantic.get('--aisy-color-action-affordance'),
    'light-dark(var(--aisy-primitive-paper-0), var(--aisy-primitive-paper-0))',
  );
  assert.equal(components.get('--aisy-button-height'), 'var(--aisy-primitive-size-button)');
  assert.equal(components.get('--aisy-button-radius'), 'var(--aisy-primitive-radius-action)');
  assert.equal(components.get('--aisy-button-padding-start'), '26px');
  assert.equal(components.get('--aisy-button-padding-end'), '10px');
  assert.equal(components.get('--aisy-button-affordance-size'), 'var(--aisy-primitive-size-affordance)');
  assert.equal(primitives.get('--aisy-primitive-motion-reduced'), '0.01ms');
  assert.equal(primitives.get('--aisy-primitive-motion-reduced-opacity'), '100ms');
  assert.doesNotMatch(semanticLayer, /#[0-9a-f]{3,8}\b/iu);
  assert.doesNotMatch(componentLayer, /#[0-9a-f]{3,8}\b/iu);
  assert.doesNotMatch(componentLayer, /--aisy-(?:button|choice|alert)[^:]*:\s*var\(--aisy-primitive-(?:paper|ink|coral|plum|aqua|goal|success|warning|danger|info|night|border|focus)/u);

  assert.match(css, /font-family:\s*"Aisy Manrope"[\s\S]*url\("\/assets\/fonts\/manrope-cyrillic-variable\.woff2"\)/u);
  assert.match(css, /font-family:\s*"Aisy Nunito"[\s\S]*url\("\/assets\/fonts\/nunito-cyrillic-variable\.woff2"\)/u);
  assert.doesNotMatch(html, /fonts\.(?:googleapis|gstatic)\.com/iu);
});

test('theme bootstrap applies light, dark and system preferences through one public controller', async () => {
  const [{ installTheme, normalizeThemePreference }, main] = await Promise.all([
    import('../public/theme.js'),
    readPublic('main.js'),
  ]);
  assert.equal(normalizeThemePreference('dark'), 'dark');
  assert.equal(normalizeThemePreference('light'), 'light');
  assert.equal(normalizeThemePreference('unexpected'), 'system');
  assert.match(main, /^import '\.\/theme\.js';/u, 'theme must be the first production import');

  const values = new Map([['aisy.theme.preference.v1', 'dark']]);
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
  const root = {
    dataset: {},
    removeAttribute(name) {
      if (name === 'data-theme') delete this.dataset.theme;
    },
  };
  const meta = { content: '' };
  const document = {
    documentElement: root,
    querySelector: (selector) => selector === 'meta[name="theme-color"]' ? meta : null,
  };
  const controller = installTheme({ document, storage });

  assert.equal(root.dataset.theme, 'dark');
  assert.equal(root.dataset.themePreference, 'dark');
  assert.equal(meta.content, '#171219');
  controller.set('light');
  assert.equal(root.dataset.theme, 'light');
  assert.equal(meta.content, '#fff9f3');
  controller.set('system');
  assert.equal(root.dataset.theme, undefined);
  assert.equal(root.dataset.themePreference, 'system');
  assert.equal(values.get('aisy.theme.preference.v1'), 'system');
});

test('a CSP-safe classic asset prepaints the theme before the single module starts', async () => {
  const [html, css] = await Promise.all([readPublic('index.html'), readPublic('aisy-theme.css')]);
  const prepaint = '<script src="/theme-prepaint.js"></script>';
  const entry = '<script type="module" src="/main.js"></script>';
  const prepaintOffset = html.indexOf(prepaint);
  const scriptOffset = html.indexOf(entry);
  const styleOffset = html.indexOf('<link rel="stylesheet" href="/aisy-theme.css">');
  assert.ok(prepaintOffset > 0 && prepaintOffset < styleOffset,
    'stored theme must be applied before the first stylesheet can paint');
  assert.ok(styleOffset < scriptOffset, 'system-aware theme CSS must precede the module entry');
  const scripts = [...html.matchAll(/<script[^>]*>(?:[\s\S]*?<\/script>)?/gu)].map((match) => match[0]);
  assert.deepEqual(scripts, [prepaint, entry]);
  assert.equal(scripts.filter((tag) => /\btype="module"/u.test(tag)).length, 1);
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc\s*=)(?:\s[^>]*)?>/iu,
    'theme prepaint must remain an external CSP-safe asset');
  assert.match(css, /:root\s*\{[^}]*color-scheme:\s*light dark/su);
  assert.match(css, /--aisy-color-background:\s*light-dark\(/u);
});

test('shared production components expose full-width, loading, disabled and non-color answer states', async () => {
  const css = await readPublic('aisy-theme.css');
  assert.match(css, /\.aisy-button\s*\{[^}]*inline-size:\s*100%/su);
  assert.match(css, /\.aisy-button\[aria-busy="true"\]::after\s*\{[^}]*animation:\s*aisy-button-spinner/su);
  assert.match(css, /\.aisy-choice:is\(\[aria-disabled="true"\],\s*:has\(input:disabled\)\)/u);
  assert.match(css, /\.aisy-choice\.is-correct::after\s*\{[^}]*content:\s*"✓ Верно"/su);
  assert.match(css, /\.aisy-choice\.is-incorrect::after\s*\{[^}]*content:\s*"× Ошибка"/su);
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*\.aisy-paper-transition\s*\{[^}]*transition-property:\s*opacity\s*!important;[^}]*transition-duration:\s*var\(--aisy-motion-reduced-opacity\)\s*!important;[^}]*transform:\s*none\s*!important;/u);
});

test('production shell keeps one 390px phone and bottom navigation at every viewport width', async () => {
  const [css, html, practice, ege, progress, assistant] = await Promise.all([
    readPublic('aisy-shell.css'),
    readPublic('index.html'),
    readPublic('practice.css'),
    readPublic('ege-hub.css'),
    readPublic('progress-profile.css'),
    readPublic('asya-assistant.css'),
  ]);

  assert.match(css, /#frame\s*\{[^}]*inline-size:\s*min\(100vw,\s*var\(--aisy-phone-inline-size\)\)/su);
  assert.match(css, /#frame\s*>\s*\.screen\s*\{[^}]*inline-size:\s*100%[^}]*block-size:\s*100%/su);
  assert.match(css, /\.aisy-shell-nav\s*\{[^}]*inset:\s*auto 0 0/su);
  assert.match(css, /\.aisy-shell-nav__list\s*\{[^}]*grid-template-columns:\s*repeat\(5,\s*minmax\(0,\s*1fr\)\)/su);
  assert.doesNotMatch(css, /@media\s*\(min-width:\s*900px\)/u);
  assert.doesNotMatch(css, /grid-template-columns:\s*1fr\s*;\s*grid-template-rows:\s*repeat\(5/iu);
  const composed = [html, practice, ege, progress, assistant].join('\n');
  assert.doesNotMatch(composed, /#frame\.(?:reading|ege-mock)-expanded[^}]*\b(?:1100|1180)px/u,
    'deep routes must not widen the production phone canvas');
  assert.doesNotMatch(composed, /@media\s*\(min-width/u,
    'wide viewports must not mutate the inner portrait-phone composition');
});

test('mobile shell declares vh fallbacks before dynamic viewport overrides', async () => {
  const [css, html] = await Promise.all([readPublic('aisy-shell.css'), readPublic('index.html')]);
  assert.match(css, /height:\s*min\(844px,\s*100vh\);\s*height:\s*min\(844px,\s*100dvh\);\s*block-size:\s*min\(844px,\s*100vh\);\s*block-size:\s*min\(844px,\s*100dvh\);/u);
  assert.match(css, /@media \(max-width: 430px\)[\s\S]*?#frame\s*\{\s*height:\s*100vh;\s*height:\s*100dvh;\s*block-size:\s*100vh;\s*block-size:\s*100dvh;/u);
  assert.match(css, /@media \(max-height: 600px\)[\s\S]*?#frame\s*\{\s*height:\s*100vh;\s*height:\s*100dvh;\s*block-size:\s*100vh;\s*block-size:\s*100dvh;/u);
  assert.match(html, /body\{[^}]*min-height:100vh;min-height:100dvh;/u);
  assert.ok(html.includes('@media(max-width:430px){body{background:#F5F6F8}#frame{width:100vw;height:100vh;height:100dvh;'));
  assert.ok(html.includes('.screen{width:100vw;height:100vh;height:100dvh;'));
  assert.ok(html.includes('@media(orientation:landscape) and (max-height:600px){#frame{height:100vh;height:100dvh;'));
  assert.ok(html.includes('.screen{height:100vh;height:100dvh}'));
});

test('production UI custom properties resolve and update notice keeps Paper depth', async () => {
  const [theme, shell, reading] = await Promise.all([
    readPublic('aisy-theme.css'),
    readPublic('aisy-shell.css'),
    readPublic('reading-listening.css'),
  ]);
  const definitions = new Set([...theme.matchAll(/(--aisy-[\w-]+)\s*:/gu)]
    .map((match) => match[1]));
  const references = new Set([...`${theme}\n${shell}\n${reading}`.matchAll(/var\((--aisy-[\w-]+)/gu)]
    .map((match) => match[1]));
  assert.deepEqual([...references].filter((name) => !definitions.has(name)), [],
    'every Aisy custom-property reference in the production theme, shell and Reading UI must resolve');

  const primitives = properties(layer(theme, 'aisy-primitives'));
  const semantic = properties(layer(theme, 'aisy-semantic'));
  const components = properties(layer(theme, 'aisy-components'));
  assert.equal(components.get('--aisy-surface-shadow'), 'var(--aisy-depth-sheet)');
  assert.equal(
    semantic.get('--aisy-depth-sheet'),
    'light-dark(var(--aisy-primitive-depth-sheet-light), var(--aisy-primitive-depth-sheet-dark))',
  );
  assert.match(primitives.get('--aisy-primitive-depth-sheet-light'), /^10px 12px 30px/u,
    'light Paper sheet depth must fall down and right');
  assert.match(primitives.get('--aisy-primitive-depth-sheet-dark'), /^10px 12px 30px/u,
    'dark Paper sheet depth must fall down and right');
  assert.match(shell, /\.pwa-update\s*\{[^}]*box-shadow:\s*var\(--aisy-surface-shadow\)/su,
    'update notice must consume the defined component-level Paper sheet shadow');
});

test('PWA update supporting copy keeps the locked production body-size floor', async () => {
  const shell = await readPublic('aisy-shell.css');
  assert.match(
    shell,
    /\.pwa-update__message p\s*\{[^}]*font:\s*600\s+var\(--aisy-font-size-body\)\/1\.45\s+var\(--aisy-font-interface\)/su,
    'update explanations are body copy and must not fall below the shared 16px token',
  );
});

test('PWA Later action keeps the locked 16px body-size floor', async () => {
  const shell = await readPublic('aisy-shell.css');
  assert.match(
    shell,
    /\.pwa-update__dismiss\s*\{[^}]*font:\s*800\s+var\(--aisy-font-size-body\)\/1\s+var\(--aisy-font-interface\)/su,
    'Позже is a learner decision, not compact metadata',
  );
});
