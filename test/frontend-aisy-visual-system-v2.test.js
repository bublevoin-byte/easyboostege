import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

const tokensUrl = new URL('../public/prototypes/today-v1/visual-tokens.css', import.meta.url);
const systemUrl = new URL('../docs/AISY_VISUAL_SYSTEM_V2.md', import.meta.url);

function extractLayer(css, name) {
  const start = css.indexOf(`@layer ${name} {`);
  assert.notEqual(start, -1, `missing ${name} layer`);
  const open = css.indexOf('{', start);
  let depth = 1;
  for (let index = open + 1; index < css.length; index += 1) {
    if (css[index] === '{') depth += 1;
    if (css[index] === '}') depth -= 1;
    if (depth === 0) return css.slice(open + 1, index);
  }
  assert.fail(`unterminated ${name} layer`);
}

function customProperties(css) {
  return new Map([...css.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/gu)]
    .map((match) => [match[1], match[2].trim()]));
}

function luminance(hex) {
  const channels = [1, 3, 5].map((index) => {
    const value = Number.parseInt(hex.slice(index, index + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrast(first, second) {
  const a = luminance(first);
  const b = luminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

function colorPair(semantic, primitives, name) {
  const value = semantic.get(name) || '';
  const pair = value.match(/^light-dark\(var\((--[\w-]+)\),\s*var\((--[\w-]+)\)\)$/u);
  assert.ok(pair, `${name} must map light and dark primitives through light-dark()`);
  const colors = pair.slice(1).map((primitive) => primitives.get(primitive));
  for (const color of colors) assert.match(color || '', /^#[0-9a-f]{6}$/iu, `${name} has a missing primitive`);
  return colors;
}

test('candidate visual tokens expose three accessible layers without changing the production theme', async () => {
  const css = await fs.readFile(tokensUrl, 'utf8');

  assert.match(
    css,
    /@layer\s+aisy-v2-primitives,\s*aisy-v2-semantic,\s*aisy-v2-components\s*;/u,
  );
  const primitiveLayer = extractLayer(css, 'aisy-v2-primitives');
  const semanticLayer = extractLayer(css, 'aisy-v2-semantic');
  const componentLayer = extractLayer(css, 'aisy-v2-components');
  const primitives = customProperties(primitiveLayer);
  const semantic = customProperties(semanticLayer);
  const components = customProperties(componentLayer);

  for (const name of [
    '--aisy-v2-color-canvas',
    '--aisy-v2-color-surface',
    '--aisy-v2-color-ink',
    '--aisy-v2-color-ink-muted',
    '--aisy-v2-color-coral-energy',
    '--aisy-v2-color-action',
    '--aisy-v2-color-on-action',
    '--aisy-v2-color-asya',
    '--aisy-v2-color-verified',
    '--aisy-v2-color-border-strong',
    '--aisy-v2-color-focus',
    '--aisy-v2-color-chart-primary',
  ]) assert.ok(semantic.has(name), `missing semantic role ${name}`);

  const pairs = new Map([
    ['canvas', colorPair(semantic, primitives, '--aisy-v2-color-canvas')],
    ['surface', colorPair(semantic, primitives, '--aisy-v2-color-surface')],
    ['ink', colorPair(semantic, primitives, '--aisy-v2-color-ink')],
    ['muted', colorPair(semantic, primitives, '--aisy-v2-color-ink-muted')],
    ['action', colorPair(semantic, primitives, '--aisy-v2-color-action')],
    ['on-action', colorPair(semantic, primitives, '--aisy-v2-color-on-action')],
    ['asya', colorPair(semantic, primitives, '--aisy-v2-color-asya')],
    ['verified', colorPair(semantic, primitives, '--aisy-v2-color-verified')],
    ['border', colorPair(semantic, primitives, '--aisy-v2-color-border-strong')],
    ['focus', colorPair(semantic, primitives, '--aisy-v2-color-focus')],
    ['chart', colorPair(semantic, primitives, '--aisy-v2-color-chart-primary')],
  ]);

  for (const themeIndex of [0, 1]) {
    assert.ok(contrast(pairs.get('ink')[themeIndex], pairs.get('canvas')[themeIndex]) >= 4.5);
    assert.ok(contrast(pairs.get('muted')[themeIndex], pairs.get('surface')[themeIndex]) >= 4.5);
    assert.ok(contrast(pairs.get('on-action')[themeIndex], pairs.get('action')[themeIndex]) >= 4.5);
    assert.ok(contrast(pairs.get('asya')[themeIndex], pairs.get('surface')[themeIndex]) >= 4.5);
    assert.ok(contrast(pairs.get('verified')[themeIndex], pairs.get('surface')[themeIndex]) >= 4.5);
    assert.ok(contrast(pairs.get('border')[themeIndex], pairs.get('surface')[themeIndex]) >= 3);
    assert.ok(contrast(pairs.get('focus')[themeIndex], pairs.get('canvas')[themeIndex]) >= 3);
    assert.ok(contrast(pairs.get('chart')[themeIndex], pairs.get('surface')[themeIndex]) >= 3);
  }

  assert.equal(primitives.get('--aisy-v2-primitive-size-touch'), '44px');
  assert.equal(semantic.get('--aisy-v2-touch-target'), 'var(--aisy-v2-primitive-size-touch)');
  for (const [role, value] of [
    ['expressive-min', '15%'], ['expressive-max', '25%'],
    ['working-min', '5%'], ['working-max', '12%'],
    ['strict-min', '2%'], ['strict-max', '5%'],
  ]) {
    const primitive = `--aisy-v2-primitive-coral-${role}`;
    assert.equal(primitives.get(primitive), value);
    assert.equal(semantic.get(`--aisy-v2-coral-${role}`), `var(${primitive})`);
  }
  assert.equal(components.get('--aisy-v2-button-min-size'), 'var(--aisy-v2-touch-target)');
  assert.doesNotMatch(componentLayer, /#[0-9a-f]{3,8}\b/iu, 'component layer contains a raw hex');
  assert.doesNotMatch(componentLayer, /var\(--aisy-v2-primitive-/u, 'component layer bypasses semantic roles');
  assert.match(componentLayer, /min-block-size:\s*var\(--aisy-v2-button-min-size\)/u);
  assert.match(componentLayer, /:focus-visible[\s\S]*outline:\s*var\(--aisy-v2-focus-width\) solid var\(--aisy-v2-focus-color\)/u);
  assert.match(componentLayer, /touch-action:\s*manipulation/u);
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*animation-duration:\s*0\.01ms/u);
  assert.match(css, /:root\[data-theme="light"\][\s\S]*color-scheme:\s*light/u);
  assert.match(css, /:root\[data-theme="dark"\][\s\S]*color-scheme:\s*dark/u);
});

test('candidate handoff documents Coral Editorial Intelligence without claiming production adoption', async () => {
  const document = await fs.readFile(systemUrl, 'utf8');

  assert.match(document, /^# Aisy\.space — Coral Editorial Intelligence/mu);
  assert.match(document, /Статус:\s*кандидат/u);
  assert.match(document, /не заменяет[^\n]*`public\/aisy-theme\.css`/u);
  assert.match(document, /primitive[^\n]*semantic[^\n]*component/iu);
  assert.match(document, /warm[^\n]*canvas|тёпл[^\n]*холст/iu);
  assert.match(document, /deep coral|глубок[^\n]*коралл/iu);
  assert.match(document, /ink|чернил/iu);
  assert.match(document, /Asya[^\n]*violet|Ася[^\n]*фиолет/iu);
  assert.match(document, /verified[^\n]*teal|подтвержд[^\n]*бирюз/iu);
  assert.match(document, /15–25%/u);
  assert.match(document, /5–12%/u);
  assert.match(document, /2–5%/u);
  assert.match(document, /editorial[^\n]*display|редакцион[^\n]*display/iu);
  assert.match(document, /20–28 px/u);
  assert.match(document, /abstract editorial|абстракт[^\n]*редакцион/iu);
  assert.match(document, /soft 3D|мягк[^\n]*3D/iu);
  assert.match(document, /без маскот/u);
  assert.match(document, /без стоков[^\n]*ученик/u);
  assert.match(document, /charts?[^\n]*label|график[^\n]*подпис/iu);
  assert.match(document, /строг[^\n]*ЕГЭ/iu);
  assert.match(document, /reduced motion|prefers-reduced-motion/iu);
  assert.match(document, /44×44 px/u);
  assert.match(document, /4\.5:1/u);
  assert.match(document, /3:1/u);
  assert.match(document, /320[^\n]*375[^\n]*768[^\n]*1440/u);
  assert.match(document, /service worker[^\n]*не/iu);
});
