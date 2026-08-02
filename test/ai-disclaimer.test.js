import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

const REQUIRED = 'Экспериментальная ИИ-оценка. Балл ориентировочный, может содержать ошибки и не является экспертным заключением.';

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

const [html, components, app] = await Promise.all([
  fs.readFile(new URL('../public/index.html', import.meta.url), 'utf8'),
  fs.readFile(new URL('../public/components.js', import.meta.url), 'utf8'),
  readApplicationSource(),
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
  assert.match(html, /id="ai_disclaimer"/u);
  assert.match(app, /getElementById\('ai_disclaimer'\)\.textContent=ui\.AI_DISCLAIMER/u);
  assert.match(
    normalize(html),
    /id="rv_score"[\s\S]{0,1200}id="ai_disclaimer"/u,
    'the warning must be part of the score banner, not below the whole review',
  );
});

test('the written review screen shows the server evaluation scope without replacing the disclaimer', () => {
  assert.match(html, /id="rv_scope_notice" hidden/u);
  assert.match(app, /writingModule\.evaluationNotice\(evaluationScope\)/u);
  assert.match(app, /renderReview\(d,response\.evaluationScope,response\.voiceTutor\)/u);
  assert.match(app, /getElementById\('ai_disclaimer'\)\.textContent=ui\.AI_DISCLAIMER/u);
});

test('the speaking review shows the same disclaimer from the shared constant', () => {
  assert.match(app, /ui\.escapeHtml\(ui\.AI_DISCLAIMER\)/u);
  assert.match(app, /class="ai-disclaimer"/u);
  assert.match(app, /speakingModule\.isExperimentalTask\(SP\.t\)/u, 'only free-response speaking tasks 3–4 carry the experimental warning');
  assert.match(
    normalize(app),
    /d\.got\+' из '\+d\.max[\s\S]{0,1200}class="ai-disclaimer"/u,
    'the warning must be rendered immediately with the speaking score',
  );
  // Nobody may paste a second, drifting copy of the sentence into the application code.
  assert.doesNotMatch(app, /Экспериментальная ИИ-оценка/u);
});
