import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

import { projectToday } from '../public/modules/today.js';

const READY_OVERVIEW = Object.freeze({
  goal: { examDate: '2027-06-01', weeklyMinutes: 300 },
  profile: { needsDiagnostic: false, evidenceCount: 8, modules: [] },
  plan: {
    allocation: {
      modules: [{ id: 'grammar', percentage: 45, reasonCodes: ['target_gap'] }],
    },
  },
  retention: { rediagnostic: { due: false } },
  access: { tier: 'base', capabilities: { adaptivePlan: true }, usage: {}, limits: {} },
});

test('Today publishes one stable Direction A paper hero and one route action slot', async () => {
  const [markup, css] = await Promise.all([
    fs.readFile(new URL('../public/index.html', import.meta.url), 'utf8'),
    fs.readFile(new URL('../public/today.css', import.meta.url), 'utf8'),
  ]);
  const todayMarkup = markup.match(/<div class="screen today-screen" id="scr1"[\s\S]*?(?=<div class="screen" id="scr2")/u)?.[0] || '';

  assert.match(todayMarkup, /id="today-hero"[\s\S]*id="today-ready"[\s\S]*id="today-state"[\s\S]*id="today-primary"/u);
  assert.match(todayMarkup, /id="today-route"[\s\S]*id="today-route-steps"/u);
  assert.equal((todayMarkup.match(/<button\b/gu) || []).length, 1,
    'duration radios are generated controls; the static Today route has one CTA slot');
  assert.match(css, /\.today-hero\s*\{[^}]*min-block-size:\s*var\(--today-hero-min-block-size\)/su);
  assert.match(css, /\.today-hero::before[\s\S]*\.today-hero::after/u);
  assert.match(css, /@keyframes\s+today-paper-settle/u);
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*\.today-hero[^{]*\{[^}]*animation-name:\s*today-paper-fade[^}]*transform:\s*none/su);
});

function readyInput(selectedMinutes) {
  return {
    status: 'ready',
    now: Date.parse('2026-08-20T08:00:00.000Z'),
    username: 'learner_internal_01',
    displayName: 'Аня',
    selectedMinutes,
    preferences: { version: 1, schoolGrade: 11, preferredSessionMinutes: 30 },
    localProgress: { dayMin: 12, streak: 4 },
    overview: READY_OVERVIEW,
    session: null,
    diagnostic: null,
  };
}

test('Today keeps ten-minute quick practice outside the adaptive session contract', () => {
  const quick = projectToday(readyInput(10));

  assert.deepEqual(quick.duration.choices, [10, 20, 30, 40]);
  assert.equal(quick.duration.selected, 10);
  assert.equal(quick.recommendation.action.kind, 'quick-practice');
  assert.equal(quick.recommendation.action.adaptiveMinutes, null);
  assert.equal(quick.duration.preferenceMinutes, null);
  assert.match(quick.duration.help, /не меняет обычную длительность/u);

  for (const minutes of [20, 30, 40]) {
    const planned = projectToday(readyInput(minutes));
    assert.equal(planned.recommendation.action.kind, 'adaptive-session');
    assert.equal(planned.recommendation.action.adaptiveMinutes, minutes);
    assert.equal(planned.duration.preferenceMinutes, minutes);
  }
});

test('Today preserves every production adaptive duration while keeping the four quick presets', () => {
  for (const minutes of [15, 45, 90, 120]) {
    const input = readyInput(null);
    input.preferences = { ...input.preferences, preferredSessionMinutes: minutes };
    const view = projectToday(input);

    assert.equal(view.duration.selected, minutes);
    assert.ok(view.duration.choices.includes(minutes));
    assert.deepEqual(view.duration.choices.filter((value) => [10, 20, 30, 40].includes(value)),
      [10, 20, 30, 40]);
    assert.equal(view.recommendation.action.kind, 'adaptive-session');
    assert.equal(view.recommendation.action.adaptiveMinutes, minutes);
    assert.equal(view.recommendation.estimatedMinutes, minutes);
  }
});

test('a neutral no-allocation fallback keeps the selected duration honest', () => {
  const input = readyInput(45);
  input.overview = {
    ...READY_OVERVIEW,
    plan: { allocation: { modules: [] } },
  };
  const view = projectToday(input);

  assert.equal(view.recommendation.action.kind, 'quick-practice');
  assert.equal(view.duration.selected, 45);
  assert.equal(view.recommendation.estimatedMinutes, 45);
  assert.match(view.route.label, /45 минут/u);
});

test('Today projects one evidence-led recommendation and an honest diagnostic deferral', () => {
  const view = projectToday(readyInput(20));

  assert.equal(view.status, 'ready');
  assert.match(view.greeting, /Аня/u);
  assert.doesNotMatch(view.greeting, /learner_internal_01/u,
    'the owner key is not learner-facing identity copy');
  assert.match(view.context, /20 августа/u);
  assert.match(view.recommendation.title, /Грамматик/u);
  assert.match(view.recommendation.reason, /пробел/u);
  assert.equal(view.recommendation.ctaLabel, 'Начать занятие');
  assert.equal(view.rhythm.todayMinutes, 12);
  assert.equal(view.rhythm.streakDays, 4);
  assert.ok(view.countdown.days > 0);

  const provisionalInput = readyInput(20);
  provisionalInput.overview = {
    ...READY_OVERVIEW,
    profile: { ...READY_OVERVIEW.profile, needsDiagnostic: true, evidenceCount: 0 },
  };
  const recommended = projectToday(provisionalInput);
  assert.equal(recommended.diagnostic.state, 'recommended');
  assert.equal(recommended.diagnostic.action.kind, 'open-diagnostic');
  assert.equal(recommended.recommendation.action.kind, 'quick-practice');
  assert.match(recommended.recommendation.reason, /предварител/u);

  const deferred = projectToday({ ...provisionalInput, diagnosticDeferred: true });
  assert.equal(deferred.diagnostic.state, 'deferred');
  assert.match(deferred.diagnostic.copy, /не оценк/u);
  assert.doesNotMatch(deferred.diagnostic.copy, /ваш уровень/u);
});

test('Today makes a resumable session the only primary route', () => {
  const input = readyInput(40);
  input.session = {
    id: '9da05af7-a49d-4d3f-bd12-214747b8192f',
    status: 'created',
    durationMinutes: 30,
    blocks: [{ id: 'asb_0123456789abcdef_01', kind: 'activity', module: 'reading' }],
  };
  input.execution = { currentBlockId: 'asb_0123456789abcdef_01', readyToFinish: false };

  const view = projectToday(input);
  assert.equal(view.recommendation.action.kind, 'continue-adaptive-session');
  assert.equal(view.recommendation.action.sessionId, input.session.id);
  assert.equal(view.recommendation.ctaLabel, 'Продолжить занятие');
  assert.match(view.recommendation.reason, /начал/u);
  assert.match(view.duration.help, /следующ/u);

  const quickChoice = projectToday({ ...input, selectedMinutes: 10 });
  assert.equal(quickChoice.duration.preferenceMinutes, null);
  assert.match(quickChoice.duration.help, /быстрая практик/u);
  assert.doesNotMatch(quickChoice.duration.help, /применится к следующ/u);
});

test('Today refuses to advertise an adaptive session without a goal and plan', () => {
  const input = readyInput(20);
  input.overview = {
    ...READY_OVERVIEW,
    goal: null,
    plan: null,
    profile: { ...READY_OVERVIEW.profile, needsDiagnostic: false },
  };

  const view = projectToday(input);
  assert.equal(view.status, 'empty');
  assert.equal(view.state.recovery.kind, 'open-plan');
  assert.match(view.state.recovery.label, /настроить цель/iu);
  assert.equal(view.recommendation, undefined);
});

test('Today explains the highest-allocation focus and what completion changes', () => {
  const input = readyInput(30);
  input.overview = {
    ...READY_OVERVIEW,
    plan: { allocation: { modules: [
      { id: 'vocabulary', percentage: 5, reasonCodes: ['maintenance'] },
      { id: 'grammar', percentage: 60, reasonCodes: ['target_gap'] },
      { id: 'reading', percentage: 35, reasonCodes: ['high_ege_impact'] },
    ] } },
  };

  const view = projectToday(input);
  assert.match(view.recommendation.title, /Грамматик/u);
  assert.match(view.recommendation.reason, /пробел/u);
  assert.match(view.recommendation.outcome, /план/u);
});

test('Today never fabricates a personalized focus when the plan has no usable allocation', () => {
  const input = readyInput(45);
  input.overview = {
    ...READY_OVERVIEW,
    plan: { allocation: { modules: [] } },
  };

  const view = projectToday(input);
  assert.equal(view.recommendation.action.kind, 'quick-practice');
  assert.match(view.recommendation.reason, /не назвал следующий учебный блок/u);
  assert.doesNotMatch(JSON.stringify(view), /персональн/iu);
  assert.deepEqual(view.route.steps.map((step) => step.label), [
    'Повторение слов',
    'Сохранение результата',
  ]);
});

test('Today turns the server-owned plan and active session into one truthful route', () => {
  const plannedInput = readyInput(30);
  plannedInput.overview = {
    ...READY_OVERVIEW,
    plan: { allocation: { modules: [
      { id: 'vocabulary', percentage: 5, reasonCodes: ['maintenance'] },
      { id: 'grammar', percentage: 60, reasonCodes: ['target_gap'] },
      { id: 'reading', percentage: 35, reasonCodes: ['high_ege_impact'] },
    ] } },
  };
  const planned = projectToday(plannedInput);
  assert.deepEqual(planned.route.steps, [
    { position: 1, label: 'Грамматика', detail: '60% недельного плана', state: 'current' },
    { position: 2, label: 'Чтение', detail: '35% недельного плана', state: 'next' },
    { position: 3, label: 'Итог занятия', detail: 'Прогресс обновит следующий шаг', state: 'next' },
  ]);

  const resumedInput = readyInput(45);
  resumedInput.session = {
    id: '9da05af7-a49d-4d3f-bd12-214747b8192f',
    status: 'in_progress',
    durationMinutes: 90,
    currentBlockId: 'asb_0123456789abcdef_02',
    blocks: [
      { id: 'asb_0123456789abcdef_01', position: 1, kind: 'learning', module: 'grammar', activityLabel: 'Грамматика: формы', plannedMinutes: 20 },
      { id: 'asb_0123456789abcdef_02', position: 2, kind: 'learning', module: 'reading', activityLabel: 'Чтение: детали', plannedMinutes: 25 },
      { id: 'asb_0123456789abcdef_03', position: 3, kind: 'break', module: null, activityLabel: null, plannedMinutes: 10 },
      { id: 'asb_0123456789abcdef_04', position: 4, kind: 'learning', module: 'listening', activityLabel: 'Аудирование: интервью', plannedMinutes: 25 },
    ],
  };
  resumedInput.execution = {
    currentBlockId: 'asb_0123456789abcdef_02',
    completedBlockIds: ['asb_0123456789abcdef_01'],
    readyToFinish: false,
  };
  const resumed = projectToday(resumedInput);
  assert.equal(resumed.recommendation.estimatedMinutes, 90);
  assert.deepEqual(resumed.route.steps, [
    { position: 1, label: 'Грамматика: формы', detail: '20 мин · готово', state: 'complete' },
    { position: 2, label: 'Чтение: детали', detail: '25 мин · сейчас', state: 'current' },
    { position: 3, label: 'Перерыв', detail: '10 мин · дальше', state: 'next' },
  ]);
});

test('Today labels an expired diagnostic as restartable, never resumable', () => {
  const input = readyInput(20);
  input.diagnostic = { diagnostic: { id: 'expired-diagnostic', status: 'expired' }, item: null };
  const view = projectToday(input);

  assert.equal(view.diagnostic.state, 'expired');
  assert.match(view.diagnostic.action.label, /начать заново/iu);
  assert.doesNotMatch(view.diagnostic.title, /начата/iu);
  assert.doesNotMatch(view.diagnostic.copy, /того же места/iu);
});

test('Today never presents a cached adaptive plan as launchable offline', () => {
  const input = readyInput(40);
  input.source = 'offline';
  const view = projectToday(input);

  assert.equal(view.source, 'offline');
  assert.equal(view.recommendation.action.kind, 'quick-practice');
  assert.equal(view.recommendation.action.adaptiveMinutes, null);
  assert.match(view.recommendation.reason, /сохранённый план не выдаём за актуальный/u);
});

test('Today keeps a scheduled re-diagnostic optional while the existing plan stays usable', () => {
  const input = readyInput(30);
  input.overview = {
    ...READY_OVERVIEW,
    retention: { rediagnostic: { due: true } },
  };

  const view = projectToday(input);
  assert.equal(view.diagnostic.state, 'recommended');
  assert.equal(view.recommendation.action.kind, 'adaptive-session');
  assert.equal(view.recommendation.action.adaptiveMinutes, 30);
  assert.doesNotMatch(view.recommendation.reason, /предварител/u);
});

test('Today uses the learner calendar day and distinguishes an exam date that has passed', () => {
  const examDay = readyInput(20);
  examDay.now = Date.parse('2027-05-31T19:30:00.000Z');
  examDay.timeZone = 'Asia/Omsk';
  const today = projectToday(examDay);
  assert.match(today.context, /1 июня/u);
  assert.equal(today.countdown.days, 0);
  assert.equal(today.countdown.label, 'ЕГЭ сегодня');

  const expired = readyInput(20);
  expired.now = Date.parse('2027-06-02T08:00:00.000Z');
  expired.timeZone = 'Asia/Omsk';
  const past = projectToday(expired);
  assert.equal(past.countdown.days, null);
  assert.match(past.countdown.label, /прошла/u);
});

test('Today lets offline truth dominate diagnostic and missing-plan cache branches', () => {
  const diagnosticNeeded = readyInput(20);
  diagnosticNeeded.source = 'offline';
  diagnosticNeeded.overview = {
    ...READY_OVERVIEW,
    profile: { ...READY_OVERVIEW.profile, needsDiagnostic: true },
  };
  const diagnosticView = projectToday(diagnosticNeeded);
  assert.equal(diagnosticView.status, 'ready');
  assert.equal(diagnosticView.recommendation.action.kind, 'quick-practice');
  assert.equal(diagnosticView.diagnostic.state, 'offline');
  assert.equal(diagnosticView.diagnostic.action, null);

  const missingPlan = readyInput(20);
  missingPlan.source = 'offline';
  missingPlan.overview = {
    ...READY_OVERVIEW,
    goal: null,
    plan: null,
  };
  const missingPlanView = projectToday(missingPlan);
  assert.equal(missingPlanView.status, 'ready');
  assert.equal(missingPlanView.recommendation.action.kind, 'quick-practice');
  assert.match(missingPlanView.recommendation.reason, /сохранённый план не выдаём за актуальный/u);
});

test('Today exposes recoverable loading, empty, offline, access and error states', () => {
  for (const status of ['loading', 'empty', 'offline', 'access', 'error']) {
    const view = projectToday({ status, username: 'Аня', selectedMinutes: 20 });
    assert.equal(view.status, status);
    assert.ok(view.state.message);
    assert.ok(view.state.recovery.label);
    assert.ok(['retry', 'quick-practice', 'open-plan', 'open-profile'].includes(view.state.recovery.kind));
  }
});
