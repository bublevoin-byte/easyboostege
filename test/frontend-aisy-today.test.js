import assert from 'node:assert/strict';
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

function readyInput(selectedMinutes) {
  return {
    status: 'ready',
    now: Date.parse('2026-08-20T08:00:00.000Z'),
    username: 'Аня',
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

test('Today projects one evidence-led recommendation and an honest diagnostic deferral', () => {
  const view = projectToday(readyInput(20));

  assert.equal(view.status, 'ready');
  assert.match(view.greeting, /Аня/u);
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
