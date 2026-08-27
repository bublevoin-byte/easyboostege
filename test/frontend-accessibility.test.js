import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

const htmlPath = new URL('../public/index.html', import.meta.url);

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

async function readFrontend() {
  const [html, app, speakingCss, themeCss] = await Promise.all([
    fs.readFile(htmlPath, 'utf8'),
    readApplicationSource(),
    fs.readFile(new URL('../public/speaking.css', import.meta.url), 'utf8'),
    fs.readFile(new URL('../public/aisy-theme.css', import.meta.url), 'utf8'),
  ]);
  return { html, app, speakingCss, themeCss, combined: `${html}\n${app}` };
}

function relativeLuminance(hex) {
  const channels = [1, 3, 5].map((index) => {
    const value = Number.parseInt(hex.slice(index, index + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrast(foreground, background) {
  const first = relativeLuminance(foreground);
  const second = relativeLuminance(background);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

function attributeValue(openingTag, name) {
  const match = openingTag.match(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'iu'));
  return match?.[1] ?? match?.[2] ?? null;
}

function associatedLabelIds(source) {
  return new Set([...source.matchAll(/<label\b([^>]*)>/giu)]
    .map(([, attributes]) => attributeValue(attributes, 'for'))
    .filter(Boolean));
}

test('contrast helper matches the WCAG reference values', () => {
  assert.equal(Math.round(contrast('#000000', '#FFFFFF')), 21);
  assert.equal(Math.round(contrast('#FFFFFF', '#FFFFFF')), 1);
  assert.ok(contrast('#767676', '#FFFFFF') >= 4.5);
  assert.ok(contrast('#8A8F98', '#FFFFFF') < 4.5);
});

test('individual Speaking assessment action uses the canonical AA primary tokens', async () => {
  const { speakingCss, themeCss } = await readFrontend();
  assert.match(speakingCss, /\.speaking-action--primary\s*\{[^}]*background:\s*var\(--aisy-button-background\)[^}]*color:\s*var\(--aisy-button-foreground\)/su);
  assert.match(themeCss, /--aisy-button-background:\s*var\(--aisy-color-primary\)/u);
  assert.match(themeCss, /--aisy-button-foreground:\s*var\(--aisy-color-on-primary\)/u);
  assert.match(themeCss, /\.aisy-button::after\s*\{\s*content:\s*"";/u);
  assert.match(themeCss, /\.aisy-button::before\s*\{[^}]*content:\s*"";[^}]*border-block-start:\s*2px solid var\(--aisy-button-affordance-foreground\)[^}]*border-inline-end:\s*2px solid var\(--aisy-button-affordance-foreground\)/su);
  assert.match(speakingCss, /\.speaking-action--primary::after\s*\{\s*content:\s*"";/u);
  assert.doesNotMatch(themeCss.match(/\.aisy-button::after\s*\{[^}]*\}/su)?.[0] ?? '', /gradient\(/u);
  assert.doesNotMatch(speakingCss.match(/\.speaking-action--primary::after\s*\{[^}]*\}/su)?.[0] ?? '', /gradient\(/u);
  assert.doesNotMatch(themeCss + speakingCss, /content:\s*["']→["']/u);
});

test('interactive elements are real buttons, links or fields', async () => {
  const { html, app } = await readFrontend();
  // A div or span carrying onclick cannot be reached from the keyboard.
  assert.doesNotMatch(html, /<(?:div|span)\b[^>]*\bonclick=/iu);
  assert.doesNotMatch(app, /<(?:div|span)[^>]*\bonclick=/iu);
  assert.match(html, /\.cardbtn\{/u);
  assert.match(html, /\.iconbtn\{/u);
});

test('every rendered text field carries a programmatic label', async () => {
  const { combined } = await readFrontend();
  const fields = combined.match(/<(?:input|textarea)\b[^>]*>/giu) || [];
  const labelledControlIds = associatedLabelIds(combined);
  const wrappedFields = new Set([...combined.matchAll(/<label\b[^>]*>([\s\S]*?)<\/label>/giu)]
    .flatMap(([, body]) => body.match(/<(?:input|textarea)\b[^>]*>/giu) || []));
  assert.ok(fields.length >= 3, 'expected the word, grammar and exam gap inputs');
  for (const field of fields) {
    const directLabel = attributeValue(field, 'aria-label') || attributeValue(field, 'aria-labelledby');
    const controlId = attributeValue(field, 'id');
    assert.ok(directLabel || wrappedFields.has(field) || (controlId && labelledControlIds.has(controlId)), `field without a label: ${field}`);
  }
  const writingLabel = [...combined.matchAll(/<label\b([^>]*)>([\s\S]*?)<\/label>/giu)]
    .find(([, attributes]) => attributeValue(attributes, 'for') === 'w_editor');
  assert.ok(writingLabel, 'Writing editor must retain its associated visible label');
  assert.equal(writingLabel[2].trim(), 'Письменный ответ');
});

test('icon-only controls expose an accessible name', async () => {
  const { combined } = await readFrontend();
  const buttons = combined.matchAll(/<button\b([^>]*)>((?:(?!<\/button>).){0,600})<\/button>/gsu);
  for (const [, attributes, body] of buttons) {
    const withoutIcons = body.replace(/<svg[\s\S]*?<\/svg>/gu, '').replace(/<[^>]*>/gu, '');
    // Runtime interpolation ('+value+') counts as text: only static markup is checked here.
    const visibleText = withoutIcons.replace(/'\s*\+[\s\S]*?\+\s*'/gu, 'X').replace(/['+]/gu, '').trim();
    if (visibleText.length > 0) continue;
    assert.match(attributes, /aria-label=/u, `icon-only button without aria-label: ${attributes.slice(0, 120)}`);
  }
});

test('status is never carried by colour alone', async () => {
  const { app } = await readFrontend();
  // Every subject screen pairs semantic colour classes with visible verdict text or an accessible name.
  assert.doesNotMatch(app, /btn\.style\.background='#EAF7F0'/u);
  assert.doesNotMatch(app, /btn\.style\.background='#FDEDEA'/u);
  assert.match(app, /grammar-verdict[^\n]*\?\s*'✓ Верно':'✕ Неверно'/u);
  assert.match(app, /reading-review[\s\S]*?'✓':'×'[\s\S]*?'Верно':'Ошибка'/u);
  assert.match(app, /listening-answer-state[^\n]*\?\s*'Верно':'Ошибка'/u);
  assert.match(app, /setAttribute\('aria-label',label\+' — верно'\)/u);
  assert.match(app, /st\.count\+' \/ '\+st\.range\+' слов · '\+st\.hint/u);
});

test('normal text meets the WCAG 2.1 AA contrast ratio of 4.5:1', async () => {
  const { combined } = await readFrontend();
  const failures = [];
  const seen = new Set();
  for (const match of combined.matchAll(/(?<![-\w])color:(#[0-9A-Fa-f]{6})/gu)) {
    const hex = match[1].toUpperCase();
    if (seen.has(hex)) continue;
    seen.add(hex);
    const onLight = contrast(hex, '#FFFFFF');
    // Light text is allowed when it sits on the dark cards used across the app.
    const onDark = contrast(hex, '#2B2B2B');
    if (onLight < 4.5 && onDark < 4.5) failures.push(`${hex} (${onLight.toFixed(2)} on #fff)`);
  }
  assert.deepEqual(failures, [], `text colours below 4.5:1: ${failures.join(', ')}`);
});
