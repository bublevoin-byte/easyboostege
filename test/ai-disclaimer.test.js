import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

const REQUIRED = 'Оценка сформирована искусственным интеллектом и является ориентировочной.'
  + ' Официальным источником требований являются актуальные критерии ФИПИ.'
  + ' Для спорных случаев обратитесь к преподавателю.';

const [html, components, app] = await Promise.all([
  fs.readFile(new URL('../public/index.html', import.meta.url), 'utf8'),
  fs.readFile(new URL('../public/components.js', import.meta.url), 'utf8'),
  fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
]);

function normalize(value) {
  return value.replace(/\s+/gu, ' ');
}

test('the wording required by section 10.9 is defined once and used verbatim', () => {
  const defined = components.match(/const AI_DISCLAIMER = ([\s\S]*?);\n/u);
  assert.ok(defined, 'components.js must define AI_DISCLAIMER');
  const literal = defined[1].match(/'([^']*)'/gu).map((part) => part.slice(1, -1)).join('');
  assert.equal(literal, REQUIRED, 'the constant must match the wording from the specification');
  assert.match(components, /AI_DISCLAIMER,\n\s*\}\);/u, 'the constant must be exported');
});

test('the written review screen shows the disclaimer', () => {
  assert.match(normalize(html), new RegExp(REQUIRED.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
  assert.match(html, /id="ai_disclaimer"/u);
});

test('the speaking review shows the same disclaimer from the shared constant', () => {
  assert.match(app, /ui\.escapeHtml\(ui\.AI_DISCLAIMER\)/u);
  assert.match(app, /class="ai-disclaimer"/u);
  // Nobody may paste a second, drifting copy of the sentence into the application code.
  assert.doesNotMatch(app, /Оценка сформирована искусственным интеллектом/u);
});
