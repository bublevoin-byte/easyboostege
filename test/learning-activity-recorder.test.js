import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { grammarActivityId, splitLearningActivityDuration } from '../public/learning-activity-contract.js';
import { GRAMMAR_CATALOG, validateGeneratedGrammarSupplement } from '../public/grammar-catalog.js';

const rawSource = await fs.readFile(new URL('../public/learning-activity-recorder.js', import.meta.url), 'utf8');
const grammarScreenSource = await fs.readFile(new URL('../public/screens/grammar.js', import.meta.url), 'utf8');
const grammarModuleSource = (await fs.readFile(new URL('../public/modules/grammar.js', import.meta.url), 'utf8'))
  .replace(/^import .*;\r?\n/mu, '')
  .replace(/^export /gmu, '');
const source = rawSource
  .replace(/^import\s*\{[\s\S]*?\}\s*from\s*'\.\/adaptive-session-runtime\.js';\r?\n/mu, '')
  .replace(/^export /gmu, '')
  .concat('\nwindow.__learningActivityRecorderTest={recordCompletedLearningActivity};');

const ATTEMPT_ID = '10000000-0000-4000-8000-000000000031';

function recorderHarness(active = null) {
  const adaptive = [];
  const ordinary = [];
  const window = {
    EasyBoostSync: {
      async saveModuleAttempt(attempt) {
        ordinary.push(attempt);
        return false;
      },
    },
  };
  vm.runInNewContext(source, {
    window,
    GRAMMAR_CATALOG, validateGeneratedGrammarSupplement,
    adaptiveRuntimeSnapshot: () => ({ active }),
    completeAdaptiveModuleActivity: async (completion) => {
      adaptive.push(completion);
      return { execution: { revision: 2 } };
    },
    Object, Array, String, Number, Boolean, JSON, Math, Promise, RegExp, Error, TypeError,
  });
  return { recorder: window.__learningActivityRecorderTest, adaptive, ordinary };
}

function grammarScreenHarness(options = {}) {
  let now = 1_000;
  let active = null;
  let uuid = 40;
  let random = 1;
  const ordinary = [];
  const adaptive = [];
  const capacityRequests = [];
  const masteryBatches = [];
  const masteryEvents = [];
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) {
      elements.set(id, {
        id, innerHTML: '', textContent: '', value: '', style: {}, dataset: {}, children: [],
        setAttribute() {}, querySelector() { return element(`${id}:child`); },
        querySelectorAll() { return []; }, appendChild() {},
      });
    }
    return elements.get(id);
  };
  class TestDate extends Date {
    static now() { return now; }
  }
  const S = {
    gram: {
      3: { st: 2, ok: 0, err: 0, sr: 4, due: 1 },
      18: { st: 2, ok: 0, err: 0, sr: 4, due: 1 },
    },
    grammarMastery: options.grammarMastery || {
      3: { masteryVersion: 2, masteryRevision: 0, stage: 'learned', reviewStep: 0, eligibleAt: 1 },
      18: { masteryVersion: 2, masteryRevision: 0, stage: 'learned', reviewStep: 0, eligibleAt: 1 },
    },
    gramAi: {
      18: [
        { k: 'f', q: { s: 'A _____ (ACT).', b: 'ACT', ans: ['action'], e: '' } },
        { k: 'f', q: { s: 'B _____ (MOVE).', b: 'MOVE', ans: ['movement'], e: '' } },
      ],
    },
  };
  const testMath = Object.create(Math);
  testMath.random = () => { random -= 0.01; return random; };
  const window = {
    EasyBoostSync: {
      async saveModuleAttempt(attempt) {
        ordinary.push(JSON.parse(JSON.stringify(attempt)));
        return true;
      },
      async saveGrammarMasteryEvent(topicId, event) {
        masteryEvents.push(JSON.parse(JSON.stringify({ topicId, event })));
        return options.saveGrammarMasteryEvent ? options.saveGrammarMasteryEvent(topicId, event) : false;
      },
      async saveGrammarMasteryEvents(entries) {
        masteryBatches.push(JSON.parse(JSON.stringify(entries)));
        return options.saveGrammarMasteryEvents ? options.saveGrammarMasteryEvents(entries) : false;
      },
      canQueueGrammarMasteryEvent(required = 1) { capacityRequests.push(required); return true; },
    },
  };
  const context = vm.createContext({
    window,
    GRAMMAR_CATALOG, validateGeneratedGrammarSupplement,
    grammarActivityId, splitLearningActivityDuration,
    adaptiveRuntimeSnapshot: () => ({ active }),
    completeAdaptiveModuleActivity: async (completion) => {
      adaptive.push(JSON.parse(JSON.stringify(completion)));
      return { execution: { revision: 2 } };
    },
    S, SRV: false, TOKEN: '', WBTN: 'background:#fff;color:#2B2B2B;border:1px solid #F0EAE2;',
    apiPost: async () => ({}),
    examModule: {
      elapsedSeconds: (startedAt, endedAt) => Math.floor((endedAt - startedAt) / 1_000),
      record: (record, score) => ({ ...(record || {}), n: Number(record?.n || 0) + 1, last: score, best: Math.max(Number(record?.best || 0), score) }),
      badge: () => '',
    },
    gExamFmt: (seconds) => String(seconds),
    gSync() {}, generateAiContent: async () => null,
    registerScreenGenerator() {}, registerRouteHook() {},
    registerVoiceTutorError: async () => null, voiceTutorButton: () => '',
    save() {}, setTxt() {}, tab() {},
    ui: { animate() {}, markAnswer() {} }, wDeco: () => '',
    decorateCoreGrammar() {},
    document: { getElementById: element, createElement: () => element(`created:${elements.size}`) },
    crypto: { randomUUID: () => `10000000-0000-4000-8000-${String(++uuid).padStart(12, '0')}` },
    Date: TestDate, Math: testMath,
    setInterval: () => 1, clearInterval() {}, setTimeout: (callback) => callback(),
    console,
  });
  vm.runInContext(grammarModuleSource, context);
  context.grammarModule = window.EasyBoostGrammar;
  vm.runInContext(source, context);
  context.recordCompletedLearningActivity = window.__learningActivityRecorderTest.recordCompletedLearningActivity;
  const executableScreen = grammarScreenSource
    .replace(/^import(?:[\s\S]*?)from '[^']+';\r?\n/gmu, '')
    .replace(/^export \{[\s\S]*?\};\r?\n?/mu, '')
    .concat(`
      window.__grammarScreenTest={
        gStart:gStart,gReview:gReview,gTheory:gTheory,gResume:gResume,gExamStart:gExamStart,gExamCheck:gExamCheck,
        finish:gFinish,finishReview:gFinishRev,sessionMode:function(){return GS&&GS.mode},sessionTopic:function(){return GS&&GS.t},
        masteryAssisted:function(){return Boolean(GS&&GS.masteryAssisted)},masteryStage:function(topic){return gRec(topic).stage},
        commitCurrentAnswer:function(correct){var item=GS&&GS.queue[GS.i];if(item)gAnswer(correct,item)},
        ruleDisabled:function(){return Boolean(document.getElementById('g_rule_btn').disabled)},
        currentItem:function(){var item=GS&&GS.queue[GS.i];return item?{topic:item.t||GS.t,kind:item.k}:null},
        answerCurrent:function(correct){var item=GS&&GS.queue[GS.i];if(!item)return;
          if(item.k==='f'){var input=document.getElementById('g_inp');input.dataset={};input.style={};
            input.value=correct?item.q.ans[0]:'definitely wrong';gSubmit()}
          else{var buttons=item.q.o.map(function(){return{dataset:{},style:{},setAttribute:function(){},
            querySelector:function(){return{setAttribute:function(){},innerHTML:''}}}});
            buttons.forEach(function(button){button.parentElement={querySelectorAll:function(){return buttons}}});
            var choice=correct?item.q.a:(item.q.a+1)%item.q.o.length;gPick(buttons[choice],choice)}
          if(!correct)gAfterExplain()}
      };
    `);
  vm.runInContext(executableScreen, context);
  return {
    screen: window.__grammarScreenTest,
    ordinary,
    adaptive,
    capacityRequests,
    masteryBatches,
    masteryEvents,
    area: element('g_area'),
    advance(milliseconds) { now += milliseconds; },
    setActive(value) { active = value; },
  };
}

test('automatic post-answer explanation does not retroactively mark independent errors assisted', async () => {
  const harness = grammarScreenHarness();
  harness.screen.gStart(3);
  harness.screen.answerCurrent(false);
  while (harness.screen.currentItem()) harness.screen.answerCurrent(true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.masteryEvents.length, 1);
  assert.equal(harness.masteryEvents[0].event.assisted, false);
  assert.ok(['construction_choice', 'word_or_verb_form', 'auxiliary', 'agreement',
    'word_order', 'negation_or_question', 'confusion_pair'].includes(harness.masteryEvents[0].event.reason));
  assert.equal(harness.ordinary[0].metadata.helpUsed, true, 'the automatic explanation stays observable');

  harness.screen.gReview();
  harness.screen.answerCurrent(false);
  while (harness.screen.currentItem()) harness.screen.answerCurrent(true);
  await new Promise((resolve) => setImmediate(resolve));
  const failed = harness.masteryBatches.at(-1).find((entry) => entry.event.passed === false);
  assert.equal(failed.event.assisted, false);
  assert.ok(['construction_choice', 'word_or_verb_form', 'auxiliary', 'agreement',
    'word_order', 'negation_or_question', 'confusion_pair'].includes(failed.event.reason));
});

test('a rule click after answer commitment cannot retroactively mark the answer assisted', () => {
  const harness = grammarScreenHarness();
  harness.screen.gStart(3);
  harness.screen.commitCurrentAnswer(true);
  assert.equal(harness.screen.ruleDisabled(), true);
  harness.screen.gTheory(3);
  assert.equal(harness.screen.masteryAssisted(), false);
});

test('single mastery submission selects its exact event result instead of the first batch sibling', async () => {
  const harness = grammarScreenHarness({
    saveGrammarMasteryEvent: async (topicId, event) => ({ results: [
      { eventId: '00000000-0000-4000-8000-000000009999', applied: true, conflict: false, replay: false,
        record: { masteryVersion: 2, masteryRevision: 7, stage: 'stable', reviewStep: 5 } },
      { eventId: event.id, applied: true, conflict: false, replay: false,
        record: { masteryVersion: 2, masteryRevision: 1, stage: 'confirmed', reviewStep: 1 } },
    ] }),
  });
  harness.screen.gStart(3);
  while (harness.screen.currentItem()) harness.screen.answerCurrent(true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.screen.masteryStage(3), 'confirmed');
});

test('an assisted failed review never claims that the topic regressed', async () => {
  const harness = grammarScreenHarness({
    saveGrammarMasteryEvents: async (entries) => ({ results: entries.map((entry) => ({
      eventId: entry.event.id, applied: true, conflict: false, replay: false,
      record: { masteryVersion: 2, masteryRevision: 1, stage: 'learned', reviewStep: 0,
        eligibleAt: 1, lastRegressionReason: null },
    })) }),
  });
  harness.screen.gReview();
  const topic = harness.screen.currentItem().topic;
  harness.screen.gTheory(topic); harness.screen.gResume(); harness.screen.answerCurrent(false);
  while (harness.screen.currentItem()) harness.screen.answerCurrent(true);
  await new Promise((resolve) => setImmediate(resolve));
  const assistedEvent = harness.masteryBatches[0].find((entry) => entry.event.assisted).event;
  assert.equal(Object.hasOwn(assistedEvent, 'reason'), false,
    'assisted evidence cannot claim a specific independent weakness');
  assert.doesNotMatch(harness.area.innerHTML, /СНОВА В РАБОТЕ/u);
  assert.match(harness.area.innerHTML, /ИЗУЧЕНО/u);
});

test('assisted topic errors omit the independent regression reason', async () => {
  const harness = grammarScreenHarness();
  harness.screen.gStart(3);
  harness.screen.gTheory(3); harness.screen.gResume(); harness.screen.answerCurrent(false);
  while (harness.screen.currentItem()) harness.screen.answerCurrent(true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.masteryEvents[0].event.assisted, true);
  assert.equal(Object.hasOwn(harness.masteryEvents[0].event, 'reason'), false);
});

test('an early passed review never reuses an older regression badge', async () => {
  const harness = grammarScreenHarness({
    saveGrammarMasteryEvents: async (entries) => ({ results: entries.map((entry) => ({
      eventId: entry.event.id, applied: true, conflict: false, replay: false,
      record: { masteryVersion: 2, masteryRevision: 2, stage: 'learned', reviewStep: 0,
        eligibleAt: 9_999_999, lastRegressionReason: 'auxiliary' },
    })) }),
  });
  harness.screen.gReview();
  while (harness.screen.currentItem()) harness.screen.answerCurrent(true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.doesNotMatch(harness.area.innerHTML, /СНОВА В РАБОТЕ/u);
  assert.match(harness.area.innerHTML, /ИЗУЧЕНО/u);
});

test('Grammar completion explicitly reports typed unsaved results instead of claiming success', async () => {
  const harness = grammarScreenHarness({
    saveGrammarMasteryEvent: async () => ({ queued: false, code: 'GRAMMAR_MASTERY_QUEUE_LOCK_UNAVAILABLE' }),
  });
  harness.screen.gStart(3);
  while (harness.screen.currentItem()) harness.screen.answerCurrent(true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(harness.area.innerHTML, /Результат не сохранён/u);
  assert.match(harness.area.innerHTML, /безопасное сохранение недоступно|повторите/iu);
  assert.doesNotMatch(harness.area.innerHTML, /Подход завершён/u);
});

test('an offline queued Grammar error stays provisional instead of reusing the old stable proof', async () => {
  const harness = grammarScreenHarness({
    grammarMastery: {
      3: {
        masteryVersion: 2, masteryRevision: 5, stage: 'stable', reviewStep: 5,
        eligibleAt: null, lastRegressionReason: null,
      },
    },
    saveGrammarMasteryEvent: async () => false,
  });
  harness.screen.gStart(3);
  harness.screen.answerCurrent(false);
  while (harness.screen.currentItem()) harness.screen.answerCurrent(true);
  await new Promise((resolve) => setImmediate(resolve));

  assert.match(harness.area.innerHTML, /Результат ждёт синхронизации/u);
  assert.match(harness.area.innerHTML, /СТАТУС ОБНОВИТСЯ ПОСЛЕ СИНХРОНИЗАЦИИ/u);
  assert.doesNotMatch(harness.area.innerHTML, /Навык устойчив!/u);
  assert.doesNotMatch(harness.area.innerHTML, /\u{1F3C6}/u);
});

test('an offline queued Grammar review shows only a provisional status badge', async () => {
  const harness = grammarScreenHarness({
    saveGrammarMasteryEvents: async () => false,
  });
  harness.screen.gReview();
  while (harness.screen.currentItem()) harness.screen.answerCurrent(true);
  await new Promise((resolve) => setImmediate(resolve));

  assert.match(harness.area.innerHTML, /Результат ждёт синхронизации/u);
  assert.match(harness.area.innerHTML, /ОЖИДАЕТ СИНХРОНИЗАЦИИ/u);
  assert.doesNotMatch(harness.area.innerHTML, /ИЗУЧЕНО|УСТОЙЧИВО|СНОВА В РАБОТЕ/u);
});

test('a conflicted Grammar review remains explicitly unsaved instead of claiming completion', async () => {
  const harness = grammarScreenHarness({
    saveGrammarMasteryEvents: async (entries) => ({ results: entries.map((entry) => ({
      eventId: entry.event.id, applied: false, conflict: true, replay: false,
      record: { masteryVersion: 2, masteryRevision: 2, stage: 'learned', reviewStep: 0, eligibleAt: 1 },
    })) }),
  });
  harness.screen.gReview();
  while (harness.screen.currentItem()) harness.screen.answerCurrent(true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(harness.area.innerHTML, /Результат не сохранён/u);
  assert.match(harness.area.innerHTML, /прогресс изменился/iu);
  assert.doesNotMatch(harness.area.innerHTML, /Повторение завершено/u);
});

test('a delayed review response cannot render over or clear a replacement Grammar session', async () => {
  let release;
  let started;
  const requested = new Promise((resolve) => { started = resolve; });
  const harness = grammarScreenHarness({
    saveGrammarMasteryEvents: async (entries) => {
      started();
      await new Promise((resolve) => { release = resolve; });
      return { results: entries.map((entry) => ({
        eventId: entry.event.id, applied: true, conflict: false, replay: false,
        record: { masteryVersion: 2, masteryRevision: 1, stage: 'confirmed', reviewStep: 1 },
      })) };
    },
  });
  harness.screen.gReview();
  while (harness.screen.currentItem()) harness.screen.answerCurrent(true);
  await requested;
  harness.screen.gStart(3);
  const replacementMarkup = harness.area.innerHTML;
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.screen.sessionTopic(), 3);
  assert.equal(harness.area.innerHTML, replacementMarkup);
  assert.doesNotMatch(harness.area.innerHTML, /Повторение завершено/u);
});

test('ordinary completion creates one bounded owner-synced attempt with the supplied stable UUID', async () => {
  const harness = recorderHarness();
  const completion = {
    id: ATTEMPT_ID,
    module: 'grammar',
    activityId: 'grammar_forms_topic_6',
    score: 4,
    maxScore: 5,
    durationMs: 90_250,
    metadata: {
      mode: 'topic_practice', source: 'builtin', helpUsed: false, hintsUsed: 0,
      question: 'private question text', answer: 'private learner answer', nested: { unsafe: true },
      evidenceQuality: 'server_verified_unassisted', contentRef: 'private:question:1',
    },
  };

  const first = await harness.recorder.recordCompletedLearningActivity(completion);
  const replay = await harness.recorder.recordCompletedLearningActivity(completion);

  assert.equal(first.path, 'ordinary');
  assert.equal(first.saved, false, 'offline-compatible sync result remains honest');
  assert.equal(replay.path, 'ordinary');
  assert.equal(harness.adaptive.length, 0);
  assert.equal(harness.ordinary.length, 2, 'a retry reaches the idempotent sync boundary');
  assert.deepEqual(JSON.parse(JSON.stringify(harness.ordinary[0])), {
    id: ATTEMPT_ID,
    module: 'grammar',
    activity: 'grammar_forms_topic_6',
    score: 4,
    maxScore: 5,
    durationMs: 90_250,
    metadata: { mode: 'topic_practice', source: 'builtin', helpUsed: false, hintsUsed: 0 },
  });
  assert.equal(harness.ordinary[1].id, ATTEMPT_ID, 'retry must preserve the exact UUID');
});

test('an exact active adaptive block uses only its execution-claim path', async () => {
  const active = {
    module: 'grammar', activityId: 'grammar_forms_topic_3', executionClaim: 'a'.repeat(43),
  };
  const harness = recorderHarness(active);

  const result = await harness.recorder.recordCompletedLearningActivity({
    id: ATTEMPT_ID,
    module: 'grammar', activityId: 'grammar_forms_topic_3',
    score: 3, maxScore: 4, durationMs: 45_000,
    metadata: { mode: 'topic_practice', source: 'builtin', helpUsed: true, hintsUsed: 1 },
  });

  assert.equal(result.path, 'adaptive');
  assert.deepEqual(JSON.parse(JSON.stringify(harness.adaptive)), [{
    module: 'grammar', activityId: 'grammar_forms_topic_3',
    score: 3, maxScore: 4, durationMs: 45_000,
    metadata: { mode: 'topic_practice', source: 'builtin', helpUsed: true, hintsUsed: 1 },
  }]);
  assert.equal(harness.ordinary.length, 0, 'the same completion cannot create an ordinary duplicate');
});

test('metadata accepts only named modes, sources and bounded primitive help signals', async () => {
  const harness = recorderHarness();

  await harness.recorder.recordCompletedLearningActivity({
    id: '10000000-0000-4000-8000-000000000032',
    module: 'grammar', activityId: 'grammar_forms_topic_2',
    score: 1, maxScore: 2, durationMs: 15_000,
    metadata: {
      mode: 'learner_answer', source: 'private_question', helpUsed: 'false', hintsUsed: 101,
    },
  });

  assert.deepEqual(JSON.parse(JSON.stringify(harness.ordinary[0].metadata)), {});
});

test('canonical Reading metadata survives ordinary sync and exact adaptive content matching', async () => {
  const metadata = {
    mode: 'reading_gaps', source: 'catalog', helpUsed: false, hintsUsed: 0,
    readingProvenance: 'canonical', readingSetId: 'reading-pilot-v1.task11.future-01',
    readingSetRevision: 1, readingKind: 'task11', readingCefr: 'B1',
    readingContentRef: 'builtin:reading:task11:b1:v1',
    readingAttemptId: 'reading-training-01', readingSlice: 'detail',
  };
  const ordinary = recorderHarness();
  await ordinary.recorder.recordCompletedLearningActivity({
    id: ATTEMPT_ID, module: 'reading', activityId: 'reading_gaps',
    score: 5, maxScore: 6, durationMs: 12_345, metadata,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(ordinary.ordinary[0].metadata)), metadata);

  const mismatch = recorderHarness({
    module: 'reading', activityId: 'reading_gaps',
    contentRef: 'builtin:reading:task11:b2:v1', executionClaim: 'a'.repeat(43),
  });
  assert.deepEqual(JSON.parse(JSON.stringify(await mismatch.recorder.recordCompletedLearningActivity({
    id: ATTEMPT_ID, module: 'reading', activityId: 'reading_gaps',
    score: 5, maxScore: 6, durationMs: 12_345, metadata,
  }))), { path: 'blocked', reason: 'adaptive_content_mismatch', recorded: false });
  assert.equal(mismatch.adaptive.length, 0);

  const exact = recorderHarness({
    module: 'reading', activityId: 'reading_gaps',
    contentRef: metadata.readingContentRef, executionClaim: 'a'.repeat(43),
  });
  await exact.recorder.recordCompletedLearningActivity({
    id: ATTEMPT_ID, module: 'reading', activityId: 'reading_gaps',
    score: 5, maxScore: 6, durationMs: 12_345, metadata,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(exact.adaptive[0].metadata)), metadata);
});

test('a different active adaptive block fails closed without recording disguised ordinary evidence', async () => {
  const active = {
    module: 'grammar', activityId: 'grammar_transformations_topic_18', executionClaim: 'a'.repeat(43),
  };
  const harness = recorderHarness(active);

  const result = await harness.recorder.recordCompletedLearningActivity({
    id: ATTEMPT_ID,
    module: 'grammar', activityId: 'grammar_forms_topic_4',
    score: 4, maxScore: 4, durationMs: 30_000,
  });

  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    path: 'blocked', reason: 'adaptive_activity_mismatch', recorded: false,
  });
  assert.equal(harness.adaptive.length, 0);
  assert.equal(harness.ordinary.length, 0);
});

test('grammar topic, mixed review and exam completions emit observable owner-bound or adaptive calls', async () => {
  assert.match(
    grammarScreenSource,
    /import \{recordCompletedLearningActivity\} from '\.\.\/learning-activity-recorder\.js';/u,
  );
  assert.doesNotMatch(grammarScreenSource, /completeAdaptiveModuleActivity/u);
  assert.doesNotMatch(grammarScreenSource, /apiPost\('\/api\/v1\/module-attempts'/u);
  const harness = grammarScreenHarness();

  harness.screen.gStart(3);
  harness.advance(500);
  while (harness.screen.currentItem()) harness.screen.answerCurrent(true);
  await Promise.resolve();
  assert.equal(harness.ordinary.length, 1);
  assert.equal(harness.ordinary[0].module, 'grammar');
  assert.equal(harness.ordinary[0].activity, 'grammar_forms_topic_3');
  assert.equal(harness.ordinary[0].score, harness.ordinary[0].maxScore);
  assert.ok(harness.ordinary[0].maxScore > 0);
  assert.equal(harness.ordinary[0].durationMs, 500);
  assert.deepEqual(harness.ordinary[0].metadata, {
    mode: 'topic_practice', source: 'builtin', helpUsed: false, hintsUsed: 0,
  });

  harness.screen.gReview();
  assert.equal(harness.capacityRequests.at(-1), 2,
    'the screen reserves one offline event slot for every due topic before review');
  harness.advance(1_001);
  let transformationMistakeMade = false;
  let transformationHelpOpened = false;
  while (harness.screen.currentItem()) {
    const item = harness.screen.currentItem();
    if (item.topic === 18 && !transformationHelpOpened) {
      harness.screen.gTheory(18);
      harness.screen.gResume();
      transformationHelpOpened = true;
    }
    const correct = item.topic !== 18 || transformationMistakeMade;
    if (item.topic === 18 && !correct) transformationMistakeMade = true;
    harness.screen.answerCurrent(correct);
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.masteryBatches.length, 1, 'all due topics use one owner-bound batch submission');
  assert.equal(harness.masteryBatches[0].length, 2);
  assert.equal(harness.ordinary.length, 3, 'mixed review emits one distinct attempt per skill family');
  const review = harness.ordinary.slice(1).sort((left, right) => left.activity.localeCompare(right.activity));
  assert.deepEqual(review.map(({ activity, score, maxScore, metadata }) => ({ activity, score, maxScore, metadata })), [
    {
      activity: 'grammar_forms_review', score: 2, maxScore: 2,
      metadata: { mode: 'spaced_review', source: 'builtin', helpUsed: false, hintsUsed: 0 },
    },
    {
      activity: 'grammar_transformations_review', score: 2, maxScore: 3,
      metadata: { mode: 'spaced_review', source: 'generated', helpUsed: true, hintsUsed: 0 },
    },
  ]);
  assert.equal(review.reduce((sum, attempt) => sum + attempt.durationMs, 0), 1_001);

  harness.setActive({
    module: 'grammar', activityId: 'grammar_forms_exam_19_24', executionClaim: 'a'.repeat(43),
  });
  harness.screen.gExamStart('builtin:exam:grammar:19-24:v1');
  harness.advance(2_000);
  harness.screen.gExamCheck();
  await Promise.resolve();
  assert.equal(harness.ordinary.length, 3, 'adaptive exam does not emit an ordinary duplicate');
  assert.deepEqual(harness.adaptive, [{
    module: 'grammar', activityId: 'grammar_forms_exam_19_24', score: 0, maxScore: 6, durationMs: 2_000,
  }]);
});
