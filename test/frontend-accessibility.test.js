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
  const [html, app] = await Promise.all([
    fs.readFile(htmlPath, 'utf8'),
    readApplicationSource(),
  ]);
  return { html, app, combined: `${html}\n${app}` };
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

test('individual Speaking assessment action meets 4.5:1 at every gradient stop', async () => {
  const { app } = await readFrontend();
  const match = app.match(/assessmentAction[\s\S]{0,1600}?background:linear-gradient\(135deg,(#[0-9A-F]{6}),(#[0-9A-F]{6})\)[\s\S]{0,300}?color:#fff/iu);
  assert.ok(match, 'individual Speaking assessment gradient was not found');
  for (const background of match.slice(1)) {
    assert.ok(
      contrast('#FFFFFF', background) >= 4.5,
      `individual Speaking assessment contrast is below 4.5:1 on ${background}`,
    );
  }
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
  assert.ok(fields.length >= 3, 'expected the word, grammar and exam gap inputs');
  for (const field of fields) {
    const directLabel = attributeValue(field, 'aria-label') || attributeValue(field, 'aria-labelledby');
    const controlId = attributeValue(field, 'id');
    assert.ok(directLabel || (controlId && labelledControlIds.has(controlId)), `field without a label: ${field}`);
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
  // Answer verdicts go through the shared helper, which adds a glyph and a label.
  assert.doesNotMatch(app, /btn\.style\.background='#EAF7F0'/u);
  assert.doesNotMatch(app, /btn\.style\.background='#FDEDEA'/u);
  const marks = (app.match(/ui\.markAnswer\(/gu) || []).length;
  assert.ok(marks >= 6, `expected every answer verdict to use markAnswer, found ${marks}`);
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
