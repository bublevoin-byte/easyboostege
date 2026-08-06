import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

const [screen, html, adaptiveLaunch] = await Promise.all([
  fs.readFile(new URL('../public/screens/reading.js', import.meta.url), 'utf8'),
  fs.readFile(new URL('../public/index.html', import.meta.url), 'utf8'),
  fs.readFile(new URL('../public/adaptive-activity-launch.js', import.meta.url), 'utf8'),
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
  assert.match(html, /\.reading2\b/u);
  assert.match(html, /\.reading2[^}]*font-size:16px/su);
  assert.match(html, /\.reading2[^}]*overflow-x:hidden/su);
  assert.match(html, /\.reading-text[^}]*max-width:7[02]ch/su);
  assert.match(html, /\.reading-(?:action|answer)[^}]*min-height:4[48]px/su);
  assert.match(html, /@media\(min-width:768px\)[^{]*\{[^}]*reading/su);
  assert.match(html, /@media\(prefers-reduced-motion:reduce\)[^{]*\{[^}]*reading/su);
});

test('adaptive Reading launches an exact allowlisted kind and CEFR through the canonical screen seam', () => {
  assert.match(adaptiveLaunch, /window\.launchReadingPractice/u);
  assert.match(adaptiveLaunch, /launch\.mode,\s*launch\.cefr,\s*contentRef/u);
  assert.match(screen, /function launchReadingPractice\(kind,cefr,contentRef\)/u);
});
