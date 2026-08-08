import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await fs.readFile(new URL('../public/modules/progress.js', import.meta.url), 'utf8');

function createProgressModule() {
  const window = {};
  vm.runInNewContext(source, { window, Object, Number, Math, Array, String, Boolean, Date });
  return window.EasyBoostProgress;
}

// Values built inside the vm realm are not reference-equal to host literals.
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

test('progress module counts whole days to the exam and never goes negative', () => {
  const progress = createProgressModule();
  const exam = Date.parse('2027-06-01T00:00:00Z');

  assert.equal(progress.daysLeft(exam - 10 * 86400000), 10);
  assert.equal(progress.daysLeft(exam), 0);
  assert.equal(progress.daysLeft(exam + 5 * 86400000), 0);
  assert.equal(progress.EXAM_DATE, '2027-06-01');
});

test('progress module caps the daily minute goal at 100 percent', () => {
  const progress = createProgressModule();

  assert.deepEqual({ ...progress.dailyGoal(15) }, { minutes: 15, goal: 30, percent: 50 });
  assert.deepEqual({ ...progress.dailyGoal(90) }, { minutes: 90, goal: 30, percent: 100 });
  assert.deepEqual({ ...progress.dailyGoal(undefined) }, { minutes: 0, goal: 30, percent: 0 });
  assert.deepEqual({ ...progress.dailyGoal(-5) }, { minutes: 0, goal: 30, percent: 0 });
  assert.equal(progress.percent(3, 0), 0);
});

test('progress module normalizes every module value into 0-100', () => {
  const progress = createProgressModule();
  const values = progress.values({ words: 42.6, gram: -10, read: 220, write: '35' });

  assert.deepEqual(plain(values), { words: 43, gram: 0, read: 100, listen: 0, write: 35, speak: 0 });
  assert.deepEqual(Array.from(progress.MODULES), ['words', 'gram', 'read', 'listen', 'write', 'speak']);
  assert.deepEqual(plain(progress.values(null)), { words: 0, gram: 0, read: 0, listen: 0, write: 0, speak: 0 });
});

test('progress module builds the dashboard overview and labels', () => {
  const progress = createProgressModule();
  const exam = Date.parse('2027-06-01T00:00:00Z');
  const view = progress.overview({ streak: 4, learned: 120, dayMin: 30, prog: { words: 50 } }, exam - 86400000);

  assert.equal(view.streak, 4);
  assert.equal(view.learned, 120);
  assert.equal(view.daily.percent, 100);
  assert.equal(view.modules.words, 50);
  assert.equal(view.daysLeft, 1);
  assert.equal(progress.learnedLabel(120), 'учу · 120 / 500');
  assert.equal(progress.learnedLabel(undefined), 'учу · 0 / 500');
  assert.equal(progress.streakLabel(4, true), '🔥 4 дней подряд');
  assert.equal(progress.streakLabel(0), '🔥 0');
});

test('progress module treats a missing state as a zero starting point', () => {
  const progress = createProgressModule();
  const view = progress.overview(null, Date.now());

  assert.equal(view.streak, 0);
  assert.equal(view.learned, 0);
  assert.equal(view.daily.percent, 0);
  assert.deepEqual(plain(view.modules), { words: 0, gram: 0, read: 0, listen: 0, write: 0, speak: 0 });
});

test('progress module presents all six evidence modules without turning missing evidence into a level', () => {
  const progress = createProgressModule();
  const summary = progress.evidenceSummary({
    modules: [
      { id: 'grammar', mastery: 49, uncertainty: 100, status: 'preliminary', evidenceCount: 3 },
      { id: 'reading', mastery: 78, uncertainty: 35, status: 'established', evidenceCount: 8 },
    ],
  });

  assert.deepEqual(plain(summary.map((module) => module.id)), [
    'vocabulary', 'grammar', 'reading', 'listening', 'writing', 'speaking',
  ]);
  assert.deepEqual(plain(summary[0]), {
    id: 'vocabulary', label: 'Лексика', state: 'unobserved',
    stateLabel: 'Недостаточно занятий для оценки', mastery: null,
    confidence: null, uncertainty: null, evidenceCount: 0,
  });
  assert.deepEqual(plain(summary[1]), {
    id: 'grammar', label: 'Грамматика', state: 'preliminary',
    stateLabel: 'Предварительная оценка', mastery: 49,
    confidence: 0, uncertainty: 100, evidenceCount: 3,
  });
  assert.deepEqual(plain(summary[2]), {
    id: 'reading', label: 'Чтение', state: 'established',
    stateLabel: 'Оценка подтверждена', mastery: 78,
    confidence: 65, uncertainty: 35, evidenceCount: 8,
  });
  assert.equal(JSON.stringify(summary).includes('CEFR'), false);
  assert.equal(JSON.stringify(summary).includes('IELTS'), false);
  assert.deepEqual(plain(progress.EVIDENCE_MODULE_LABELS), {
    vocabulary: 'Лексика', grammar: 'Грамматика', reading: 'Чтение', listening: 'Аудирование',
    writing: 'Письмо', speaking: 'Говорение',
  });
});

test('progress module turns the recovery map into adaptive, non-official learning labels', () => {
  const progress = createProgressModule();
  const view = progress.recoveryOverview({
    summary: { open: 2, recovered: 3, relapsed: 1, potential_ege_points: 4 },
    error_recovery_rate: { numerator: 3, denominator: 4, rate: 0.75 },
    voice_minutes: { used_monthly: 12.5, remaining_daily: 7, remaining_monthly: 107.5 },
    due_repeats: [{ id: 'repeat-1', stage: 'day_1', status: 'due' }],
    next_best_review: { type: 'repeat', repeat_id: 'repeat-1', skill_id: 'ege.grammar.past_simple', skill_label: 'Past Simple', potential_ege_points: 1 },
  });

  assert.deepEqual(plain(view.counts), { open: 2, recovered: 3, relapsed: 1 });
  assert.equal(view.nextBest.skill_label, 'Past Simple');
  assert.equal(view.rateLabel, '75% подтверждено');
  assert.equal(view.voiceLabel, '12.5 из 120 мин использовано');
  assert.equal(view.dueLabel, '1 повтор готов');
  assert.equal(view.potentialLabel, 'до 4 учебных баллов потенциала*');
  assert.match(view.notice, /не официальный балл ЕГЭ/u);
  assert.equal(progress.recoveryOverview(null).rateLabel, 'Пока нет проверенных переносов');
});

test('progress screen exposes an accessible recovery card and a server-owned repeat form', async () => {
  const [markup, screen] = await Promise.all([
    fs.readFile(new URL('../public/index.html', import.meta.url), 'utf8'),
    fs.readFile(new URL('../public/screens/progress.js', import.meta.url), 'utf8'),
  ]);

  assert.match(markup, /id="voice_recovery_map"[^>]*aria-label="Карта освоенных ошибок"[^>]*aria-live="polite"/u);
  assert.match(screen, /adaptiveGet\('\/api\/v1\/voice-tutor\/recovery-map',recoveryAuthority\)/u);
  assert.match(screen, /repeat\.task_id/u);
  assert.match(screen, /adaptivePost\('\/api\/v1\/voice-tutor\/repeats\/'/u);
  assert.match(screen, /input\.maxLength=200/u);
  assert.match(screen, /initial_micro_check_passed/u);
  assert.match(screen, /view\.nextBest/u);
  assert.doesNotMatch(screen, /skills\.slice\(0,\s*4\)/u);
  assert.match(source, /не официальный балл ЕГЭ/u);
});

test('progress screen owns an accessible evidence summary and labels cached data as an old snapshot', async () => {
  const [markup, screen] = await Promise.all([
    fs.readFile(new URL('../public/index.html', import.meta.url), 'utf8'),
    fs.readFile(new URL('../public/screens/progress.js', import.meta.url), 'utf8'),
  ]);

  assert.match(markup, /id="evidence_progress_summary"[^>]*aria-labelledby="evidence_progress_title"[^>]*aria-live="polite"/u);
  assert.match(markup, /id="evidence_progress_modules"[^>]*aria-label="Прогресс по разделам"/u);
  assert.doesNotMatch(markup, /id="legacy_progress_state"/u);
  assert.match(screen, /progressModule\.evidenceSummary\(profile\)/u);
  assert.match(screen, /progressModule\.EVIDENCE_MODULE_LABELS/u);
  assert.doesNotMatch(screen, /const adaptiveModuleLabels=/u);
  assert.match(screen, /async function loadAdaptiveOverview\(overviewAuthority=beginAdaptiveView\(\)\)/u);
  assert.doesNotMatch(screen, /async function renderAdaptivePlan\(\)/u);
  assert.doesNotMatch(screen, /function renderProgress\(\)\{if\(!S\)return/u);
  assert.match(screen, /readAdaptiveOverviewCacheSnapshot/u);
  assert.match(screen, /Сохранённая копия/u);
  assert.match(screen, /не свежими/u);
  assert.match(screen, /savedAt/u);
});

test('progress async overview and recovery continuations are exact-owner guarded before cache or redraw', async () => {
  const screen = await fs.readFile(new URL('../public/screens/progress.js', import.meta.url), 'utf8');
  assert.match(screen, /function captureAdaptiveAuthority/u);
  assert.match(screen, /function adaptiveAuthorityCurrent/u);
  assert.match(screen, /async function loadAdaptiveOverview\(overviewAuthority=beginAdaptiveView\(\)\)[\s\S]*?await apiGet\('\/api\/v1\/adaptive-learning\/overview',adaptiveOwnerHeaders\(overviewAuthority\)\)[\s\S]*?adaptivePayloadOwned\(payload,overviewAuthority\)/u);
  assert.match(screen, /const goalAuthority=captureAdaptiveAuthority\(\)[\s\S]*?await adaptivePut\('\/api\/v1\/adaptive-learning\/goal'[\s\S]*?adaptiveAuthorityCurrent\(goalAuthority\)/u);
  assert.match(screen, /async function renderRecoveryMap\(\)\{[^}]*captureAdaptiveAuthority\(\)[\s\S]*?await adaptiveGet\('\/api\/v1\/voice-tutor\/recovery-map',recoveryAuthority\)[\s\S]*?drawRecoveryMap/u);
  assert.match(screen, /async function resumeAdaptiveSession\(authority\)[\s\S]*?await adaptiveGet\('\/api\/v1\/adaptive-learning\/sessions\/current',authority\)[\s\S]*?adaptiveAuthorityCurrent\(authority\)[\s\S]*?drawAdaptiveSession/u,
    'the nested session continuation must validate the captured incarnation before redraw');
  assert.match(screen, /async function resumeAdaptiveDiagnostic\(retention,authority\)[\s\S]*?await adaptiveGet\('\/api\/v1\/adaptive-learning\/diagnostics\/current',authority\)[\s\S]*?adaptiveAuthorityCurrent\(authority\)[\s\S]*?drawAdaptiveDiagnostic/u,
    'the nested diagnostic continuation must validate the captured incarnation before redraw');
  assert.match(screen, /apiGet\('\/api\/v1\/adaptive-learning\/overview',adaptiveOwnerHeaders\(overviewAuthority\)\)/u,
    'adaptive reads carry the intended owner so a shared cookie switch fails closed');
});

test('offline continuity E2E resolves the generation-bound current owner marker', async () => {
  const demo = await fs.readFile(new URL('../e2e/demo.test.js', import.meta.url), 'utf8');
  assert.match(demo, /EasyBoostStore\.readCurrentOwner\(\)/u);
  assert.doesNotMatch(demo, /loadLocal\(localStorage\.getItem\('eb_current'\)\)/u);
});

test('browser evidence tracers share one server and Chromium harness', async () => {
  const [progressTracer, readingTracer, vocabularyTracer] = await Promise.all([
    fs.readFile(new URL('../e2e/learning-progress.test.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../e2e/reading-listening-evidence.test.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../e2e/vocabulary-library.test.js', import.meta.url), 'utf8'),
  ]);

  for (const tracer of [progressTracer, readingTracer, vocabularyTracer]) {
    assert.match(tracer, /from '\.\/browser-server-harness\.js'/u);
    assert.doesNotMatch(tracer, /async function availablePort\(/u);
    assert.doesNotMatch(tracer, /async function chromeExecutable\(/u);
    assert.doesNotMatch(tracer, /async function waitForReady\(/u);
    assert.doesNotMatch(tracer, /async function stopProcess\(/u);
  }
});

test('adaptive async handlers commit notices and controls only for their captured incarnation', async () => {
  const screen = await fs.readFile(new URL('../public/screens/progress.js', import.meta.url), 'utf8');
  assert.match(screen, /viewToken/u);
  assert.match(screen, /complete\.addEventListener\('click',[\s\S]*?await loadAdaptiveOverview\(authority\)[\s\S]*?commitAdaptiveUi\(authority/u);
  assert.match(screen, /list\.replaceChildren\(\);create\.hidden=!preview;start\.hidden=preview\|\|!session;if\(!preview&&session\)start\.disabled=false/u);
  assert.match(screen, /function commitAdaptiveUi\(authority,commit\)\{if\(!adaptiveAuthorityCurrent\(authority\)\)return false;commit\(\);return true\}/u);
  assert.doesNotMatch(screen, /catch\(error\)\{if\(error&&error\.code==='OWNER_CHANGED'\)return;notice\.textContent/u);
  assert.doesNotMatch(screen, /finally\{(?:button|complete)\.disabled=false\}/u);
});

test('adaptive overview uses cached private data only for retryable offline failures', async () => {
  const screen = await fs.readFile(new URL('../public/screens/progress.js', import.meta.url), 'utf8');
  assert.match(screen, /if\(!adaptivePayloadOwned\(payload,overviewAuthority\)\)throw adaptiveOwnerError\(\)/u);
  assert.match(screen, /if\(apiIsAuthorityFailure\(error\)\)\{await invalidateLearningAuthority\(overviewAuthority\);return\}/u);
  assert.match(screen, /await clearAdaptiveOverviewCache\(localStorage,overviewAuthority\);if\(!adaptiveAuthorityCurrent\(overviewAuthority\)\)return/u);
  assert.match(screen, /apiIsAuthorityFailure\(error\)[\s\S]*?invalidateLearningAuthority\(overviewAuthority\)/u);
  assert.match(screen, /async function adaptiveBoundRequest\(request,authority\)[\s\S]*?invalidateAdaptiveAuthority\(authority\)/u,
    'every adaptive Progress request must globally invalidate an exact stale incarnation');
  assert.match(screen, /if\(!apiCanUseOfflineFallback\(error\)\)[\s\S]*?drawEvidenceProgressSummary\(null,\{source:'unavailable',unavailable:true\}\)/u);
  assert.match(screen, /const cached=readAdaptiveOverviewCacheSnapshot/u);
});

test('adaptive authority loss clears every owner-derived private view before logout', async () => {
  const screen = await fs.readFile(new URL('../public/screens/progress.js', import.meta.url), 'utf8');
  assert.match(screen, /registerAuthorityReset\(function\(authority\)\{clearAdaptivePrivateUi\(authority\)\}\)/u);
  assert.match(screen, /function clearAdaptivePrivateUi\(authority/u);
  assert.match(screen, /adaptiveAccessState=null/u);
  for (const id of ['adaptive_target_score', 'adaptive_exam_date', 'adaptive_weekly_minutes']) {
    assert.match(screen, new RegExp(`getElementById\\('${id}'\\)`, 'u'));
  }
  assert.match(screen, /adaptive_report[\s\S]*?hidden=true/u);
  assert.match(screen, /adaptive_report_rows[\s\S]*?replaceChildren\(\)/u);
  assert.match(screen, /adaptive_orientation[\s\S]*?textContent=''/u);
  assert.match(screen, /adaptive_report_disclaimer[\s\S]*?textContent=''/u);
  assert.match(screen, /adaptive_detailed_report[\s\S]*?dataset\.locked='true'/u);
  assert.match(screen, /adaptive_deep_diagnostic_start[\s\S]*?hidden=true/u);
  assert.match(screen, /adaptive_paywall_copy[\s\S]*?textContent=''/u);
  assert.match(screen, /drawEvidenceProgressSummary\(null,\{source:'unavailable',unavailable:true\}\)/u);
  assert.match(screen, /setAdaptiveReadOnly\(true\)/u);
  assert.match(screen, /querySelectorAll\('input,select,textarea,button'\)[\s\S]*?control\.disabled=false/u,
    'owner reset must normalize pending-disabled controls before applying read-only state');
});

test('adaptive authority reset clears only the matching owner recovery view and launch filters', async () => {
  const screen = await fs.readFile(new URL('../public/screens/progress.js', import.meta.url), 'utf8');
  const resetSource = screen.match(
    /function clearAdaptivePrivateUi\(authority=adaptiveViewAuthority\)\{[\s\S]*?\n\}\nregisterAuthorityReset/u,
  )[0].replace(/\nregisterAuthorityReset$/u, '');
  const nodes = new Map();
  function node(id) {
    if (!nodes.has(id)) nodes.set(id, {
      id, hidden: false, value: 'private', textContent: 'private', dataset: {}, children: ['private'],
      replaceChildren() { this.children = []; },
      querySelectorAll() { return []; },
    });
    return nodes.get(id);
  }
  const recovery = node('voice_recovery_map');
  const screenNode = node('scr10');
  Object.assign(screenNode.dataset, {
    adaptiveRecoverySkillId: 'alice-skill',
    adaptiveRecoveryRepeatId: 'alice-repeat',
    adaptiveRecoveryTaskId: 'alice-task',
  });
  const context = vm.createContext({
    adaptiveViewAuthority: { owner: 'alice', ownerGeneration: 0 },
    adaptiveViewToken: 7,
    adaptiveAccessState: {}, adaptiveSessionPreview: {}, adaptiveCurrentSession: {}, adaptiveCurrentExecution: {},
    sameAdaptiveOwner(a, b) { return Boolean(a && b && a.owner === b.owner && a.ownerGeneration === b.ownerGeneration); },
    document: { getElementById: node },
    drawAdaptiveSession() {}, drawAdaptiveDiagnostic() {}, drawEvidenceProgressSummary() {}, setAdaptiveReadOnly() {},
  });
  vm.runInContext(`${resetSource}\nthis.clearAdaptivePrivateUi=clearAdaptivePrivateUi;`, context);

  assert.equal(context.clearAdaptivePrivateUi({ owner: 'bob', ownerGeneration: 0 }), false);
  assert.deepEqual(recovery.children, ['private']);
  assert.equal(screenNode.dataset.adaptiveRecoverySkillId, 'alice-skill');

  assert.equal(context.clearAdaptivePrivateUi({ owner: 'alice', ownerGeneration: 0 }), true);
  assert.equal(recovery.hidden, true);
  assert.deepEqual(recovery.children, []);
  assert.equal('adaptiveRecoverySkillId' in screenNode.dataset, false);
  assert.equal('adaptiveRecoveryRepeatId' in screenNode.dataset, false);
  assert.equal('adaptiveRecoveryTaskId' in screenNode.dataset, false);
  assert.match(screen, /function drawRecoveryMap\(payload\)\{[\s\S]*?root\.hidden=false/u,
    'the next exact-owner recovery response makes the freshly rendered card visible again');
});
