import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

const [screen, html, styles, adaptiveLaunch, app, api, auth] = await Promise.all([
  fs.readFile(new URL('../public/screens/reading.js', import.meta.url), 'utf8'),
  fs.readFile(new URL('../public/index.html', import.meta.url), 'utf8'),
  fs.readFile(new URL('../public/reading-listening.css', import.meta.url), 'utf8'),
  fs.readFile(new URL('../public/adaptive-activity-launch.js', import.meta.url), 'utf8'),
  fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
  fs.readFile(new URL('../public/api.js', import.meta.url), 'utf8'),
  fs.readFile(new URL('../public/auth.js', import.meta.url), 'utf8'),
]);

test('Reading 2 screen is a lazy 60-set catalog client, not a second domain implementation', () => {
  for (const call of [
    'loadPilotCatalog(', 'selectNextSet(', 'selectFullSection(', 'scoreSet(',
    'submitFullAttempt(', 'serializeFullAttempt(', 'restoreFullAttempt(',
  ]) assert.match(screen, new RegExp(call.replace('(', '\\('), 'u'), `missing Reading domain call ${call}`);

  assert.doesNotMatch(screen, /const R_HL=|const R_QS=|const R_GAPS=|generateAiContent\(/u);
  assert.match(screen, /Task 10/u);
  assert.match(screen, /Task 11/u);
  assert.match(screen, /Task 12–18/u);
  assert.match(screen, /Полный раздел 10–18/u);
  assert.match(screen, /60 комплект/u);
});

test('Reading 2 wording is honest about fields, timing and automated validation', () => {
  assert.match(screen, /20 полей ответ/u);
  assert.doesNotMatch(screen, /20 задани(?:й|я) ЕГЭ/iu);
  assert.match(screen, /рекомендация ФИПИ — 30 минут/iu);
  assert.match(screen, /не завершается автоматически/iu);
  assert.match(screen, /Автоматически проверено/u);
  assert.match(screen, /Формат, ключи, количество элементов и цитаты-доказательства проверены программно/u);
  assert.match(screen, /не официальный вариант ФИПИ/u);
  assert.match(screen, /не ручная проверка методистом/u);
});

test('Reading 2 exposes accessible status, review and responsive styling contracts', () => {
  assert.match(screen, /aria-live="polite"/u);
  assert.match(screen, /role="(?:status|alert|timer|dialog)"/u);
  assert.match(screen, /Ответ ученика/u);
  assert.match(screen, /Правильный ответ/u);
  assert.match(screen, /Цитата-доказательство/u);
  assert.match(screen, /Объяснение/u);
  assert.match(html, /<link rel="stylesheet" href="\/reading-listening\.css">/u);
  assert.match(styles, /\.reading2\b/u);
  assert.match(styles, /\.reading2[^}]*font-size:\s*var\(--aisy-font-size-body\)/su);
  assert.match(styles, /#scr7 #r_area\.learning-route__content[^}]*overflow-x:\s*hidden/su);
  assert.match(styles, /\.reading-text[^}]*overflow-wrap:\s*anywhere/su);
  assert.match(styles, /\.reading-(?:action|answer)[^}]*min-(?:block-size|height):\s*(?:48px|var\(--aisy-touch-target\))/su);
  assert.match(styles, /\.reading2[^}]*max-inline-size:\s*100%/su);
  assert.doesNotMatch(styles, /@media\s*\(min-width:[^)]+\)[^{]*\{[^}]*reading/su,
    'Reading must keep the portrait-phone layout instead of widening at desktop viewports');
  assert.match(styles, /@media\s*\(prefers-reduced-motion:\s*reduce\)[^{]*\{[^}]*reading/su);
});

test('adaptive Reading launches an exact allowlisted kind and CEFR through the canonical screen seam', () => {
  assert.match(adaptiveLaunch, /window\.launchReadingPractice/u);
  assert.match(adaptiveLaunch, /launch\.mode,\s*launch\.cefr,\s*contentRef/u);
  assert.match(screen, /function launchReadingPractice\(kind,cefr,contentRef,\{signal=null,authorityCurrent=null\}=\{\}\)/u);
});

test('every new Reading session waits for the shared fresh server access gate', () => {
  assert.match(app, /async function verifyLearningAccessForLaunch/u);
  assert.match(app, /export \{[^}]*verifyLearningAccessForLaunch/su);
  assert.match(screen, /verifyLearningAccessForLaunch/u);
  assert.match(screen, /await verifyLearningAccessForLaunch\(\)/u);
  assert.match(screen, /async function startTraining/u);
  assert.match(screen, /async function startFullAttempt/u);
  assert.match(screen, /async function launchReadingPractice/u);
  assert.match(adaptiveLaunch, /await window\.launchReadingPractice/u);
});

test('adaptive Reading cancellation reaches the fresh session fetch and releases its launch lock', () => {
  assert.match(api, /async function get\(path, options = \{\}\)/u);
  assert.match(api, /request\(baseUrl \+ path, \{ \.\.\.options, cache: 'no-store', credentials: 'same-origin' \}\)/u);
  assert.match(auth, /async function currentSession\(options = \{\}\)/u);
  assert.match(auth, /api\.get\('\/api\/v1\/me', options\)/u);
  assert.match(app, /async function verifyLearningAccessForLaunch\(\{signal=null\}=\{\}\)/u);
  assert.match(app, /auth\.currentSession\(\{signal,cache:'no-store'\}\)/u);
  assert.match(screen, /verifyLearningAccessForLaunch\(\{signal\}\)/u);
  assert.match(screen, /finally\{if\(launchPending===launch\)launchPending=null\}/u);
});
