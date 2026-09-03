import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

import { EGE_SECTION_PRACTICE, projectEgeHub } from '../public/modules/ege-hub.js';

test('EGE hub separates a resumable attempt from a new full mock and the latest result', () => {
  const view = projectEgeHub({
    currentAttempt: { id: 'active-attempt', state: 'written_in_progress' },
    history: {
      baselineAttemptId: 'completed-attempt',
      attempts: [{
        id: 'completed-attempt', label: 'Диагностический', completedAt: '2026-08-20T10:00:00.000Z',
        result: { score: { primaryTotal: 61, range: { minimum: 61, maximum: 61 } } },
      }],
    },
    online: true,
  });

  assert.equal(view.current.action.kind, 'continue');
  assert.equal(view.current.action.attemptId, 'active-attempt');
  assert.equal(view.fullMock.action.kind, 'start');
  assert.equal(view.fullMock.action.disabled, true);
  assert.match(view.fullMock.rationale, /короткой работы выберите раздел/u);
  assert.equal(view.latestResult.action.kind, 'result');
  assert.equal(view.latestResult.action.attemptId, 'completed-attempt');
});

test('EGE hub blocks a new server-timed mock offline but keeps an exact local continuation', () => {
  const view = projectEgeHub({
    localContinuation: { attemptId: 'offline-attempt', phase: 'writing' },
    online: false,
  });

  assert.equal(view.network.online, false);
  assert.match(view.network.label, /таймер продолжает идти/u);
  assert.equal(view.current.action.attemptId, 'offline-attempt');
  assert.equal(view.current.action.disabled, false);
  assert.equal(view.fullMock.action.disabled, true);
  assert.match(view.fullMock.action.reason, /завершите текущую попытку/u);
});

test('EGE section practice reuses the existing section routes without claiming missing tasks', () => {
  assert.deepEqual(
    EGE_SECTION_PRACTICE.map(({ label, range, screenId, start }) => ({ label, range, screenId, start })),
    [
      { label: 'Аудирование', range: 'Задания 1–9', screenId: 'scr4', start: 'lExam' },
      { label: 'Чтение', range: 'Задания 10–18', screenId: 'scr7', start: 'rExam' },
      { label: 'Грамматика и лексика', range: 'Задания 19–24', screenId: 'scr3', start: 'gExam' },
      { label: 'Письмо', range: 'Задания 37–38', screenId: 'scr8', start: null },
      { label: 'Говорение', range: 'Задания 39–42', screenId: 'scr9', start: 'spExam' },
    ],
  );
});

test('EGE hub is a lazy offline-safe route and keeps the strict runner behind an explicit action', async () => {
  const [markup, main, loader, worker, hubScreen] = await Promise.all([
    fs.readFile(new URL('../public/index.html', import.meta.url), 'utf8'),
    fs.readFile(new URL('../public/main.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../public/screens.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../public/service-worker.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../public/screens/ege-hub.js', import.meta.url), 'utf8'),
  ]);

  assert.match(markup, /id="aisy-ege"[\s\S]*?id="ege-hub-current"[\s\S]*?id="ege-hub-sections"/u);
  assert.match(loader, /'aisy-ege':function\(\)\{return import\('\.\/screens\/ege-hub\.js'\)\}/u);
  assert.doesNotMatch(main, /screens\/ege-hub\.js/u);
  const shell = worker.match(/const APP_SHELL=\[[^\]]*\]/u)?.[0] || '';
  assert.match(shell, /'\/ege-hub\.css'/u);
  assert.match(shell, /'\/screens\/ege-hub\.js'/u);
  assert.match(shell, /'\/modules\/ege-hub\.js'/u);
  assert.match(hubScreen, /nav\('scr16'/u);
  assert.doesNotMatch(hubScreen, /answerKey|correctAnswer|showHint|Ася|подсказк/iu);
});

test('historical result intent reuses the exact authoritative result and its training repeat', async () => {
  const mockScreen = await fs.readFile(
    new URL('../public/screens/ege-mock.js', import.meta.url), 'utf8',
  );
  assert.match(mockScreen, /export function setEgeMockOpenIntent/u);
  assert.match(mockScreen, /historicalResultAttemptId/u);
  assert.match(mockScreen, /allowRepeat: current\.attempt == null/u);
});
