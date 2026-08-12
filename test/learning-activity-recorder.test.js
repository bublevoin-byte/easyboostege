import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { grammarActivityId, splitLearningActivityDuration } from '../public/learning-activity-contract.js';
import {
  GENERATED_GRAMMAR_REVISION,
  GRAMMAR_ACTIVE_PRACTICE_TYPES,
  GRAMMAR_ERROR_CODES,
  GRAMMAR_PREACTIVATION_LEGACY_TOPIC_IDS,
  isBuiltinGrammarDiagnosticId,
  isGrammarConfusionPair,
  isGrammarErrorCode,
  parseGrammarConfusionPair,
  parseGeneratedGrammarItemId,
  parseGeneratedGrammarItemReference,
} from '../public/grammar-domain-contract.js';
import { GRAMMAR_CATALOG, validateGeneratedGrammarSupplement } from '../public/grammar-catalog.js';
import { migrateMasteryRecord, reduceMastery } from '../public/modules/grammar.js';
import { grammarMasteryEventSchema } from '../validation/grammar-mastery.js';

const rawSource = await fs.readFile(new URL('../public/learning-activity-recorder.js', import.meta.url), 'utf8');
const grammarScreenSource = await fs.readFile(new URL('../public/screens/grammar.js', import.meta.url), 'utf8');
const grammarModuleSource = (await fs.readFile(new URL('../public/modules/grammar.js', import.meta.url), 'utf8'))
  .replace(/^import .*;\r?\n/gmu, '')
  .replace(/^export /gmu, '');
const source = rawSource
  .replace(/^import\s*\{[\s\S]*?\}\s*from\s*'\.\/adaptive-session-runtime\.js';\r?\n/mu, '')
  .replace(/^import .*;\r?\n/gmu, '')
  .replace(/^export /gmu, '')
  .concat('\nwindow.__learningActivityRecorderTest={recordCompletedLearningActivity};');

const ATTEMPT_ID = '10000000-0000-4000-8000-000000000031';
const GENERATED_REQUEST_HASH = 'a'.repeat(64);
const GENERATED_RESULT_HASH = 'b'.repeat(16);

function generatedVoice(kind, index) {
  return { id: `generated.g.q.${GENERATED_REQUEST_HASH}.${GENERATED_RESULT_HASH}.${kind}${index}`, revision: 1 };
}

function generatedTopicSupplement() {
  return validateGeneratedGrammarSupplement('grammar_topic_set', {
    c: Array.from({ length: 3 }, (_, index) => ({
      t: [`Generated choice ${index + 1}: She `, ' every day.'],
      o: ['go', 'goes', 'going', 'went'], a: 1, e: 'Present Simple.', voice: generatedVoice('c', index + 1),
    })),
    f: Array.from({ length: 3 }, (_, index) => ({
      s: `Generated input ${index + 1}: She _____ (GO) every day.`,
      b: 'GO', ans: ['goes'], e: 'Third person singular.', voice: generatedVoice('f', index + 1),
    })),
  });
}

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
    isGrammarErrorCode, parseGrammarConfusionPair,
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
  const randomValues = Array.isArray(options.randomValues) ? [...options.randomValues] : null;
  const ordinary = [];
  const adaptive = [];
  const capacityRequests = [];
  const masteryBatches = [];
  const masteryEvents = [];
  const timers = [];
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
  const S = options.state ? JSON.parse(JSON.stringify(options.state)) : {
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
  testMath.random = () => {
    if (randomValues?.length) return randomValues.shift();
    random -= 0.01;
    return random;
  };
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
      pendingGrammarMasteryEvents() {
        const pending = typeof options.pendingGrammarMasteryEvents === 'function'
          ? options.pendingGrammarMasteryEvents() : options.pendingGrammarMasteryEvents;
        return JSON.parse(JSON.stringify(pending || []));
      },
      canQueueGrammarMasteryEvent(required = 1) { capacityRequests.push(required); return true; },
    },
  };
  const context = vm.createContext({
    window,
    GRAMMAR_CATALOG, validateGeneratedGrammarSupplement,
    grammarActivityId, splitLearningActivityDuration,
    GENERATED_GRAMMAR_REVISION, GRAMMAR_ACTIVE_PRACTICE_TYPES, GRAMMAR_ERROR_CODES,
    GRAMMAR_PREACTIVATION_LEGACY_TOPIC_IDS,
    isBuiltinGrammarDiagnosticId, isGrammarConfusionPair, isGrammarErrorCode, parseGrammarConfusionPair,
    parseGeneratedGrammarItemId, parseGeneratedGrammarItemReference,
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
    document: { getElementById: (id) => (window.__skipGrammarArea && id === 'g_area' ? null : element(id)), createElement: () => element(`created:${elements.size}`) },
    crypto: { randomUUID: () => `10000000-0000-4000-8000-${String(++uuid).padStart(12, '0')}` },
    Date: TestDate, Math: testMath,
    setInterval: () => 1, clearInterval() {},
    setTimeout: (callback) => { if (options.deferTimers) timers.push(callback); else callback(); },
    console,
  });
  context.isGrammarErrorCode = isGrammarErrorCode;
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
        restore:initGrammar,
        finish:gFinish,finishReview:gFinishRev,sessionMode:function(){return GS&&GS.mode},sessionTopic:function(){return GS&&GS.t},
        sessionSnapshot:function(){var item=GS&&GS.queue[GS.i];return GS?{sessionId:GS.sessionId,topic:GS.t,index:GS.i,
          itemId:item&&item.q.id,phase:GS.phase,done:GS.done,ok:GS.ok}:null},
        gToThemes:function(){window.__skipGrammarArea=true;try{gToThemes()}finally{window.__skipGrammarArea=false}},
        masteryAssisted:function(){return Boolean(GS&&GS.masteryAssisted)},masteryStage:function(topic){return gRec(topic).stage},
        commitCurrentAnswer:function(correct){var item=GS&&GS.queue[GS.i];if(item)gAnswer(correct,item)},
        ruleDisabled:function(){return Boolean(document.getElementById('g_rule_btn').disabled)},
        currentItem:function(){var item=GS&&GS.queue[GS.i];return item?{topic:item.t||GS.t,kind:item.k,id:item.q.id,
          errorSkill:item.q.errorSkill,confusionPair:item.q.confusionPair||null}:null},
        renderTransfer:function(topic,type){var levels=G_BANK[topic],kind=type==='choice'?'c':type==='input'?'f':type;
          var question=levels[kind][0];GS={activeRunner:false,t:topic,queue:[{k:type,q:question,t:topic,transfer:true}],i:0,
            ok:0,done:0,phase:'question'};gRenderQ();return document.getElementById('g_area').innerHTML},
        answerCurrent:function(correct){var item=GS&&GS.queue[GS.i];if(!item)return;
          if(['f','input','correction','transform'].includes(item.k)){var input=document.getElementById('g_inp');input.dataset={};input.style={};
            input.value=correct?item.q.ans[0]:'definitely wrong';gSubmit()}
          else{var buttons=item.q.o.map(function(){return{dataset:{},style:{},setAttribute:function(){},
            querySelector:function(){return{setAttribute:function(){},innerHTML:''}}}});
            buttons.forEach(function(button){button.parentElement={querySelectorAll:function(){return buttons}}});
            var choice=correct?item.q.a:(item.q.a+1)%item.q.o.length;gPick(buttons[choice],choice)}
          if(!correct)gAfterExplain()}
        ,answerChoice:function(choice){var item=GS&&GS.queue[GS.i];if(!item||!['c','c2','choice'].includes(item.k))return;
          var buttons=item.q.o.map(function(){return{dataset:{},style:{},setAttribute:function(){},
            querySelector:function(){return{setAttribute:function(){},innerHTML:''}}}});
          buttons.forEach(function(button){button.parentElement={querySelectorAll:function(){return buttons}}});
          var correct=choice===item.q.a;gPick(buttons[choice],choice);if(!correct)gAfterExplain()}
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
    stateSnapshot() { return JSON.parse(JSON.stringify(S)); },
    runTimers() { while (timers.length) timers.shift()(); },
    advance(milliseconds) { now += milliseconds; },
    setActive(value) { active = value; },
  };
}

test('automatic disclosure keeps the run assisted while preserving the independently committed wrong pointer', async () => {
  const harness = grammarScreenHarness({
    saveGrammarMasteryEvent: (topicId, event) => ({ eventId: event.id, applied: true }),
  });
  harness.screen.gStart(3);
  const failedItem = harness.screen.currentItem();
  harness.screen.answerCurrent(false);
  while (harness.screen.currentItem()) harness.screen.answerCurrent(true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.masteryEvents.length, 1);
  assert.equal(harness.masteryEvents[0].event.assisted, true);
  assert.equal(Object.hasOwn(harness.masteryEvents[0].event, 'reason'), false);
  assert.equal(harness.ordinary[0].metadata.helpUsed, true, 'the automatic explanation stays observable');
  const failedQuestion = GRAMMAR_CATALOG.bank[failedItem.topic].c.find((item) => item.id === failedItem.id);
  const selectedDiagnostic = failedQuestion.diagnostics[(failedQuestion.a + 1) % failedQuestion.o.length];
  assert.deepEqual(JSON.parse(JSON.stringify(harness.masteryEvents[0].event.independentError)), {
    itemId: failedItem.id,
    diagnosticId: selectedDiagnostic.id,
    reason: selectedDiagnostic.errorCode,
    confusionPair: selectedDiagnostic.confusionPair || null,
  }, 'the pre-disclosure wrong answer remains exact bounded regression evidence');
  assert.equal(harness.ordinary[0].metadata.grammarErrorCode, selectedDiagnostic.errorCode);
  assert.equal(harness.ordinary[0].metadata.grammarConfusionPair, selectedDiagnostic.confusionPair ?? undefined);
  assert.equal(harness.ordinary[0].metadata.grammarTopicId, 3);

  harness.screen.gReview();
  const failedReviewItem = harness.screen.currentItem();
  harness.screen.answerCurrent(false);
  while (harness.screen.currentItem()) harness.screen.answerCurrent(true);
  await new Promise((resolve) => setImmediate(resolve));
  const failed = harness.masteryBatches.at(-1).find((entry) => entry.event.passed === false);
  assert.equal(failed.event.assisted, true);
  assert.equal(Object.hasOwn(failed.event, 'reason'), false);
  assert.equal(failed.event.independentError.itemId, failedReviewItem.id);
  assert.ok(GRAMMAR_ERROR_CODES.includes(failed.event.independentError.reason));
});

test('a failed current review of a migrated active item emits runtime-valid exact evidence', async () => {
  const harness = grammarScreenHarness({
    state: {
      gram: { 10: { st: 2, ok: 0, err: 0, sr: 4, due: 1 } },
      grammarMastery: {
        10: { masteryVersion: 2, masteryRevision: 1, stage: 'learned', reviewStep: 0, eligibleAt: 1 },
      },
      gramAi: {},
    },
    randomValues: [0, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0, 1],
  });
  harness.screen.gReview();
  assert.equal(harness.screen.currentItem()?.id, 'core.g.10.f.1',
    'the regression fixture exercises the migrated input through the real review queue');
  harness.screen.answerCurrent(false);
  while (harness.screen.currentItem()) harness.screen.answerCurrent(true);
  await new Promise((resolve) => setImmediate(resolve));

  const { topicId, event } = harness.masteryBatches[0][0];
  const item = GRAMMAR_CATALOG.bank[10].f[0];
  assert.deepEqual(JSON.parse(JSON.stringify(event.independentError)), {
    itemId: item.id, diagnosticId: null,
    reason: item.errorSkill, confusionPair: item.confusionPair || null,
  }, 'the current review publishes the item current exact weakness tuple');
  const parsed = grammarMasteryEventSchema.safeParse({ topicId, event });
  assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues));
});

test('an explicitly null chosen confusion pair survives the client event, server validation and canonical history', async () => {
  const harness = grammarScreenHarness();
  harness.screen.gStart(3);
  let failed = false;
  while (harness.screen.currentItem()) {
    const current = harness.screen.currentItem();
    const question = current.kind === 'choice'
      ? GRAMMAR_CATALOG.bank[current.topic].c.find((item) => item.id === current.id)
      : null;
    const nullPairChoice = question?.diagnostics.findIndex((diagnostic, index) => (
      index !== question.a && diagnostic?.confusionPair === null
    ));
    if (!failed && Number.isInteger(nullPairChoice) && nullPairChoice >= 0) {
      harness.screen.answerChoice(nullPairChoice);
      assert.equal(harness.screen.currentItem()?.kind, 'choice', 'the paired authored transfer is rendered next');
      harness.screen.answerCurrent(false);
      failed = true;
    } else {
      harness.screen.answerCurrent(true);
    }
  }
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(failed, true, 'the deterministic queue contains a reviewed null-pair distractor');
  assert.equal(harness.masteryEvents.length, 1);
  const { topicId, event } = harness.masteryEvents[0];
  const wrong = event.session.items.filter((item) => !item.correct);
  assert.equal(wrong.length, 2);
  assert.deepEqual(wrong.map((item) => [item.transfer, item.confusionPair, item.transferStatus]), [
    [false, null, null],
    [true, null, 'due_next_session'],
  ]);
  assert.equal(grammarMasteryEventSchema.safeParse({ topicId, event }).success, true,
    'the server accepts the exact catalog-owned null diagnostic and adjacent transfer');

  const initial = migrateMasteryRecord({
    masteryVersion: 2, masteryRevision: event.expectedRevision, stage: event.expectedStage,
    reviewStep: event.expectedReviewStep, eligibleAt: 1,
  });
  const stored = reduceMastery(initial, event, { now: 2_000, clockAuthority: 'server' });
  const storedWrong = stored.masteryHistory.at(-1).session.items.filter((item) => !item.correct);
  assert.deepEqual(storedWrong.map((item) => [item.transfer, item.confusionPair, item.transferStatus]), [
    [false, null, null],
    [true, null, 'due_next_session'],
  ], 'canonical history preserves null instead of substituting the item-level confusion pair');
});

test('a stale correct-answer timer cannot advance a replacement Grammar session', () => {
  const harness = grammarScreenHarness({ deferTimers: true });
  harness.screen.gStart(3);
  harness.screen.answerCurrent(true);
  assert.equal(harness.screen.sessionSnapshot().phase, 'advance');
  harness.screen.gStart(4);
  const replacement = harness.screen.sessionSnapshot();

  harness.runTimers();

  assert.deepEqual(harness.screen.sessionSnapshot(), replacement);
});

test('topic completion emits one stable answer-free session identity and ordered bounded outcomes', async () => {
  const harness = grammarScreenHarness();
  harness.screen.gStart(3);
  const sessionId = harness.screen.sessionSnapshot().sessionId;
  while (harness.screen.currentItem()) harness.screen.answerCurrent(true);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(harness.masteryEvents.length, 1);
  const event = harness.masteryEvents[0].event;
  assert.equal(event.id, sessionId);
  assert.equal(event.session.id, sessionId);
  assert.equal(event.session.scope, 'topic');
  assert.equal(event.session.mode, 'topic_practice');
  assert.equal(event.session.source, 'builtin');
  assert.deepEqual(event.session.catalog, { version: GRAMMAR_CATALOG.version, revision: GRAMMAR_CATALOG.revision });
  assert.equal(event.session.items.length, 16);
  assert.equal(new Set(event.session.items.map((item) => item.id)).size, 16);
  assert.deepEqual(new Set(event.session.items.map((item) => item.type)), new Set(['choice', 'input', 'correction', 'transform']));
  assert.ok(event.session.items.every((item) => item.correct === true && item.transfer === false
    && item.errorCode === null && item.confusionPair === null));
  assert.equal(Number.isSafeInteger(event.session.startedAt), true);
  assert.equal(Object.hasOwn(event.session, 'endedAt'), false, 'the server owns the canonical completion time');
  assert.equal(event.session.assisted, false);
  assert.equal(JSON.stringify(event.session).includes('answer'), false, 'server evidence cannot expose answer keys');
});

test('a real legacy topic emits one stable bounded session without claiming four-type mastery', async () => {
  const harness = grammarScreenHarness();
  harness.screen.gStart(14);
  const sessionId = harness.screen.sessionSnapshot().sessionId;
  while (harness.screen.currentItem()) harness.screen.answerCurrent(true);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(harness.masteryEvents.length, 1);
  const { topicId, event } = harness.masteryEvents[0];
  assert.equal(topicId, 14);
  assert.equal(event.id, sessionId);
  assert.equal(event.session.id, sessionId);
  assert.equal(event.session.mode, 'legacy_practice');
  assert.equal(event.session.items.length, 7);
  assert.deepEqual(event.session.items.map((item) => item.id),
    [...new Set(event.session.items.map((item) => item.id))], 'legacy outcomes retain exact queue order and identity');
  assert.deepEqual(new Set(event.completedTypes), new Set(['choice']));
  assert.ok(event.session.items.every((item) => item.correct && !item.transfer
    && item.diagnosticId === null && item.errorCode === null && item.confusionPair === null));
  assert.equal(grammarMasteryEventSchema.safeParse({ topicId, event }).success, true,
    'the production server schema accepts the real legacy runner event');
  assert.equal(harness.ordinary[0].metadata.mode, 'legacy_practice',
    'ordinary evidence and the mastery session use the same canonical mode');
  assert.equal(harness.ordinary[0].activity, 'grammar_forms_topic_14',
    'the stable topic activity id remains compatible with existing adaptive mappings');

  const stored = reduceMastery(migrateMasteryRecord(), event, { now: 2_000, clockAuthority: 'server' });
  assert.equal(stored.stage, 'learning', 'choice/input-only legacy evidence cannot claim four-type learned mastery');
  assert.deepEqual(stored.masteryHistory.at(-1).session.items, event.session.items);
});

test('legacy completion_pending survives a crash and retries the exact UUID without duplicate history', async () => {
  const first = grammarScreenHarness();
  first.screen.gStart(14);
  while (first.screen.currentItem()) first.screen.answerCurrent(true);
  await new Promise((resolve) => setImmediate(resolve));
  const pendingState = first.stateSnapshot();
  const pendingEvent = pendingState.grammarRunner.completionEvent;
  assert.equal(pendingState.grammarRunner.mode, 'legacy_practice');
  assert.equal(pendingState.grammarRunner.phase, 'completion_pending');
  assert.equal(pendingEvent.session.items.length, 7);

  first.screen.gToThemes();
  const navigatedState = first.stateSnapshot();
  assert.deepEqual(navigatedState.grammarRunner, pendingState.grammarRunner,
    'ordinary navigation preserves the exact non-durable completion for later reload and replay');

  for (const [label, begin] of [
    ['new topic practice', (screen) => screen.gStart(3)],
    ['due review', (screen) => screen.gReview()],
  ]) {
    const attempted = grammarScreenHarness({ state: navigatedState });
    begin(attempted.screen);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(attempted.masteryEvents.length, 1, `${label} retries the pending completion first`);
    assert.deepEqual(attempted.masteryEvents[0].event, pendingEvent,
      `${label} cannot replace the exact pending UUID and outcomes`);
    const retainedRunner = attempted.stateSnapshot().grammarRunner;
    assert.equal(retainedRunner.phase, 'completion_pending');
    assert.equal(retainedRunner.sessionId, navigatedState.grammarRunner.sessionId);
    assert.deepEqual(retainedRunner.completionEvent, navigatedState.grammarRunner.completionEvent,
      `${label} leaves the exact recoverable event intact until durable acceptance`);
  }

  const reloaded = grammarScreenHarness({ state: navigatedState });
  reloaded.screen.restore();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reloaded.masteryEvents.length, 1);
  assert.deepEqual(reloaded.masteryEvents[0].event, pendingEvent,
    'startup retry reuses the exact persisted completion event and UUID');
  assert.equal(reloaded.stateSnapshot().grammarRunner.phase, 'completion_pending',
    'a non-durable result retains the same recoverable legacy completion');

  const initial = migrateMasteryRecord();
  const once = reduceMastery(initial, pendingEvent, { now: 2_000, clockAuthority: 'server' });
  const replayed = reduceMastery(once, pendingEvent, { now: 3_000, clockAuthority: 'server' });
  assert.equal(replayed.masteryRevision, once.masteryRevision);
  assert.equal(replayed.masteryHistory.length, 1, 'the exact startup replay cannot duplicate history');
  const changed = { ...pendingEvent, expectedRevision: pendingEvent.expectedRevision + 1 };
  assert.equal(reloaded.screen.sessionSnapshot().phase, 'completion_pending');
  assert.equal(JSON.stringify(changed) === JSON.stringify(pendingEvent), false,
    'changed material remains distinguishable for the canonical conflict path');
});

test('a queued conflict marker never clears the exact completion_pending runner', async () => {
  let pending = [];
  const first = grammarScreenHarness({
    pendingGrammarMasteryEvents: () => pending,
    saveGrammarMasteryEvent: async (topicId, event) => {
      pending = [{ topicId, event, _conflictRevision: 4 }];
      return {
        eventId: event.id, applied: false, replay: false, conflict: true,
        record: { masteryVersion: 2, masteryRevision: 4, stage: 'learning', reviewStep: 0 },
      };
    },
  });
  first.screen.gStart(10);
  while (first.screen.currentItem()) first.screen.answerCurrent(true);
  await new Promise((resolve) => setImmediate(resolve));

  const state = first.stateSnapshot();
  assert.equal(state.grammarRunner.phase, 'completion_pending');
  assert.equal(pending[0].event.id, state.grammarRunner.completionEvent.id);
  assert.deepEqual(JSON.parse(JSON.stringify(pending[0].event)), state.grammarRunner.completionEvent);

  first.screen.gToThemes();
  const reloaded = grammarScreenHarness({ state: first.stateSnapshot(), pendingGrammarMasteryEvents: () => pending });
  assert.equal(reloaded.stateSnapshot().grammarRunner.phase, 'completion_pending',
    'navigation and reload retain the exact UUID until applied or exact replay is acknowledged');
});

test('a legacy choice answered incorrectly after mid-session reload keeps its canonical weakness', async () => {
  const first = grammarScreenHarness();
  first.screen.gStart(14);
  let guard = 0;
  while (first.screen.currentItem()?.kind !== 'c' && guard < 8) {
    first.screen.answerCurrent(true);
    guard += 1;
  }
  assert.equal(first.screen.currentItem()?.kind, 'c', 'the real topic-14 queue reaches a legacy choice');
  const state = first.stateSnapshot();
  assert.equal(state.grammarRunner.phase, 'question');

  const reloaded = grammarScreenHarness({ state });
  reloaded.screen.restore();
  assert.equal(reloaded.screen.currentItem()?.kind, 'choice',
    'addressable reload restores the catalog type instead of the legacy queue alias');
  reloaded.screen.answerCurrent(false);
  while (reloaded.screen.currentItem()) reloaded.screen.answerCurrent(true);
  await new Promise((resolve) => setImmediate(resolve));

  const { topicId, event } = reloaded.masteryEvents[0];
  const failedChoice = event.session.items.find((item) => item.type === 'choice' && !item.correct);
  assert.equal(failedChoice?.errorCode, 'construction_choice');
  const parsed = grammarMasteryEventSchema.safeParse({ topicId, event });
  assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues));
});

test('a queued pre-activation legacy input survives topic activation and reload with its historical weakness', async () => {
  const first = grammarScreenHarness();
  first.screen.gStart(14);
  const state = first.stateSnapshot();
  Object.assign(state.grammarRunner, {
    topicId: 10,
    queue: [{ id: 'core.g.10.f.1', transfer: false }],
    i: 0,
    ok: 0,
    done: 0,
    source: 'builtin',
    helpUsed: false,
    masteryAssisted: false,
    phase: 'question',
    answerAssisted: false,
    errorReasons: {},
    confusionPairs: {},
    independentErrors: {},
    types: {},
    typeScores: {},
    reservedItemIds: ['core.g.10.f.1'],
    itemOutcomes: [],
    completionEvent: null,
  });

  const reloaded = grammarScreenHarness({ state });
  reloaded.screen.restore();
  assert.equal(reloaded.screen.currentItem()?.kind, 'input',
    'a v1 input pointer remains addressable after its topic becomes active');
  reloaded.screen.answerCurrent(false);
  while (reloaded.screen.currentItem()) reloaded.screen.answerCurrent(true);
  await new Promise((resolve) => setImmediate(resolve));

  const { topicId, event } = reloaded.masteryEvents[0];
  assert.equal(topicId, 10);
  assert.equal(event.session.mode, 'legacy_practice');
  assert.equal(event.session.items[0].errorCode, 'word_or_verb_form',
    'a v1 input keeps the error code emitted by the pre-activation runner');
  const parsed = grammarMasteryEventSchema.safeParse({ topicId, event });
  assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues));
});

test('a queued pre-activation legacy choice keeps independent regression evidence after activation', async () => {
  const first = grammarScreenHarness();
  first.screen.gStart(14);
  const state = first.stateSnapshot();
  Object.assign(state.grammarRunner, {
    topicId: 10,
    queue: [{ id: 'core.g.10.c.1', transfer: false }],
    i: 0, ok: 0, done: 0, source: 'builtin', helpUsed: false,
    masteryAssisted: false, phase: 'question', answerAssisted: false,
    errorReasons: {}, confusionPairs: {}, independentErrors: {}, types: {}, typeScores: {},
    reservedItemIds: ['core.g.10.c.1'], itemOutcomes: [], completionEvent: null,
  });

  const reloaded = grammarScreenHarness({ state });
  reloaded.screen.restore();
  assert.equal(reloaded.screen.currentItem()?.kind, 'choice');
  reloaded.screen.answerCurrent(false);
  while (reloaded.screen.currentItem()) reloaded.screen.answerCurrent(true);
  await new Promise((resolve) => setImmediate(resolve));

  const { topicId, event } = reloaded.masteryEvents[0];
  assert.deepEqual(JSON.parse(JSON.stringify(event.independentError)), {
    itemId: 'core.g.10.c.1', diagnosticId: null,
    reason: 'construction_choice', confusionPair: null,
  }, 'active selected-option metadata cannot replace the queued Grammar 1 weakness contract');
  const parsed = grammarMasteryEventSchema.safeParse({ topicId, event });
  assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues));
  const regressionEvent = {
    ...parsed.data.event, expectedRevision: 9, expectedStage: 'stable', expectedReviewStep: 5,
  };
  const regressed = reduceMastery({
    masteryVersion: 2, masteryRevision: 9, stage: 'stable', reviewStep: 5,
    highestReviewStep: 5, eligibleAt: null,
  }, regressionEvent, { now: 20_000, clockAuthority: 'server' });
  assert.equal(regressed.stage, 'confirmed');
  assert.equal(regressed.lastRegressionReason, 'construction_choice');
});

test('a legacy wrong answer is automatically assisted and cannot claim learned mastery', async () => {
  const harness = grammarScreenHarness();
  harness.screen.gStart(14);
  harness.screen.answerCurrent(false);
  while (harness.screen.currentItem()) harness.screen.answerCurrent(true);
  await new Promise((resolve) => setImmediate(resolve));

  const { topicId, event } = harness.masteryEvents[0];
  assert.equal(topicId, 14);
  assert.equal(event.assisted, true);
  assert.equal(event.session.assisted, true);
  assert.equal(Object.hasOwn(event, 'reason'), false);
  assert.equal(event.session.items.filter((item) => !item.correct).length, 1);
  const parsed = grammarMasteryEventSchema.safeParse({ topicId, event });
  assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues));
  const stored = reduceMastery(migrateMasteryRecord(), event, { now: 2_000, clockAuthority: 'server' });
  assert.equal(stored.stage, 'not_started', 'assisted legacy evidence remains visible without stage advancement');
  assert.equal(stored.masteryHistory.length, 1);

  const pendingState = harness.stateSnapshot();
  assert.equal(pendingState.grammarRunner.phase, 'completion_pending');
  const reloaded = grammarScreenHarness({ state: pendingState });
  reloaded.screen.restore();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reloaded.masteryEvents.length, 1,
    'a failed legacy retry queue remains restorable instead of being discarded as a duplicate');
  assert.deepEqual(reloaded.masteryEvents[0].event, event,
    'startup flush retries the exact assisted legacy UUID and outcomes');
});

test('generated legacy practice is addressable, assisted and reloads the exact durable event', async () => {
  const generated = generatedTopicSupplement();
  const harness = grammarScreenHarness({ state: {
    gram: {}, grammarMastery: {},
    gramAi: { 14: [
      ...generated.c.map((q) => ({ k: 'c', q, voice: q.voice })),
      ...generated.f.map((q) => ({ k: 'f', q, voice: q.voice })),
    ] },
  } });
  harness.screen.gStart(14);
  let sawGenerated = false;
  let attempts = 0;
  while (harness.screen.currentItem() && attempts < 20) {
    sawGenerated ||= String(harness.screen.currentItem().id).startsWith('generated.g.q.');
    harness.screen.answerCurrent(true);
    attempts += 1;
  }
  await new Promise((resolve) => setImmediate(resolve));

  assert.ok(attempts <= 8 && harness.screen.currentItem() === null,
    `the generated legacy queue completes without turning an unaddressable answer into retries: ${JSON.stringify({ attempts, current: harness.screen.currentItem() })}`);
  assert.equal(sawGenerated, true, 'the deterministic legacy queue actually selected generated content');
  const { topicId, event } = harness.masteryEvents[0];
  assert.equal(topicId, 14);
  assert.equal(event.source, 'mixed');
  assert.equal(event.assisted, true, 'any generated participation is conservative assisted evidence');
  assert.ok(event.session.items.some((item) => item.id.startsWith('generated.g.q.')));
  assert.equal(JSON.stringify(event.session).includes('answer'), false);
  assert.equal(grammarMasteryEventSchema.safeParse({ topicId, event }).success, true);
  const pendingState = harness.stateSnapshot();
  assert.equal(pendingState.grammarRunner.phase, 'completion_pending');

  const reloaded = grammarScreenHarness({ state: pendingState });
  reloaded.screen.restore();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(reloaded.masteryEvents[0].event, event,
    'reload/startup retries the exact generated-addressable UUID without persisting prompts or answers');
  const stored = reduceMastery(migrateMasteryRecord(), event, { now: 2_000, clockAuthority: 'server' });
  assert.equal(stored.stage, 'not_started');
});

test('a generated input answered incorrectly after reload retains its pointer type and weakness', async () => {
  const generated = generatedTopicSupplement();
  const state = {
    gram: {}, grammarMastery: {},
    gramAi: { 14: [
      ...generated.c.map((q) => ({ k: 'c', q, voice: q.voice })),
      ...generated.f.map((q) => ({ k: 'f', q, voice: q.voice })),
    ] },
  };
  const first = grammarScreenHarness({ state });
  first.screen.gStart(14);
  let guard = 0;
  while (!(first.screen.currentItem()?.kind === 'f'
    && first.screen.currentItem()?.id.startsWith('generated.g.q.')) && guard < 8) {
    first.screen.answerCurrent(true);
    guard += 1;
  }
  assert.equal(first.screen.currentItem()?.kind, 'f');
  assert.match(first.screen.currentItem().id, /^generated\.g\.q\./u);

  const reloaded = grammarScreenHarness({ state: first.stateSnapshot() });
  reloaded.screen.restore();
  assert.equal(reloaded.screen.currentItem()?.kind, 'input');
  reloaded.screen.answerCurrent(false);
  while (reloaded.screen.currentItem()) reloaded.screen.answerCurrent(true);
  await new Promise((resolve) => setImmediate(resolve));

  const { topicId, event } = reloaded.masteryEvents[0];
  const failedInput = event.session.items.find((item) => item.type === 'input'
    && item.source === 'generated' && !item.correct);
  assert.equal(failedInput?.errorCode, 'word_or_verb_form');
  assert.equal(failedInput?.revision, 1);
  assert.equal(event.assisted, true);
  const parsed = grammarMasteryEventSchema.safeParse({ topicId, event });
  assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues));
});

test('legacy practice gives every original at most one retry and closes a second miss as due', async () => {
  const harness = grammarScreenHarness();
  harness.screen.gStart(14);
  let attempts = 0;
  while (harness.screen.currentItem() && attempts < 15) {
    harness.screen.answerCurrent(false);
    attempts += 1;
  }
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(attempts, 14, 'seven originals produce at most seven retries, never an unbounded queue');
  assert.equal(harness.screen.currentItem(), null);
  const { topicId, event } = harness.masteryEvents[0];
  assert.equal(event.session.items.length, 14);
  assert.equal(event.session.items.filter((item) => item.transferStatus === 'due_next_session').length, 7);
  assert.equal(grammarMasteryEventSchema.safeParse({ topicId, event }).success, true);
  const pendingState = harness.stateSnapshot();
  const reloaded = grammarScreenHarness({ state: pendingState });
  reloaded.screen.restore();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(reloaded.masteryEvents[0].event, event,
    'the bounded unresolved legacy event survives reload with the exact UUID');
});

test('transfer renderer keeps all four authored types labelled and natively keyboard reachable', () => {
  const harness = grammarScreenHarness();
  const labels = {
    choice: 'УРОВЕНЬ 1 · ВЫБОР',
    input: 'УРОВЕНЬ 2 · ВВОД',
    correction: 'УРОВЕНЬ 3 · ИСПРАВЛЕНИЕ',
    transform: 'УРОВЕНЬ 4 · ПРЕОБРАЗОВАНИЕ',
  };
  for (const [type, label] of Object.entries(labels)) {
    const html = harness.screen.renderTransfer(2, type);
    assert.match(html, new RegExp(`data-grammar-level="${type}"[^>]*>ТРАНСФЕР · ${label}`), type);
    assert.doesNotMatch(html, /tabindex="-1"/u, `${type} is not removed from keyboard order`);
    if (type === 'choice') {
      assert.match(html, /<button[^>]+onclick="gPick\(this,0\)"/u);
      assert.doesNotMatch(html, /id="g_inp"/u);
    } else {
      assert.match(html, /<input id="g_inp" aria-label="[^"]+"/u, `${type} input label`);
      assert.match(html, /onkeydown="if\(event\.key==='Enter'\)gSubmit\(\)"/u, `${type} Enter submit`);
    }
  }
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
  assert.equal(Object.hasOwn(assistedEvent, 'independentError'), false,
    'help before commitment cannot be turned into late-error regression evidence');
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
  assert.equal(Object.hasOwn(harness.masteryEvents[0].event, 'independentError'), false);
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

test('grammar topic, filtered review and exam completions emit observable owner-bound or adaptive calls', async () => {
  assert.match(
    grammarScreenSource,
    /import \{recordCompletedLearningActivity\} from '\.\.\/learning-activity-recorder\.js';/u,
  );
  assert.doesNotMatch(grammarScreenSource, /completeAdaptiveModuleActivity/u);
  assert.doesNotMatch(grammarScreenSource, /apiPost\('\/api\/v1\/module-attempts'/u);
  const harness = grammarScreenHarness({
    saveGrammarMasteryEvent: (topicId, event) => ({ eventId: event.id, applied: true }),
  });

  harness.screen.gStart(3);
  harness.advance(500);
  while (harness.screen.currentItem()) harness.screen.answerCurrent(true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.ordinary.length, 1);
  assert.equal(harness.ordinary[0].module, 'grammar');
  assert.equal(harness.ordinary[0].activity, 'grammar_forms_topic_3');
  assert.equal(harness.ordinary[0].score, harness.ordinary[0].maxScore);
  assert.ok(harness.ordinary[0].maxScore > 0);
  assert.equal(harness.ordinary[0].durationMs, 500);
  assert.deepEqual(harness.ordinary[0].metadata, {
    mode: 'topic_practice', source: 'builtin', helpUsed: false, hintsUsed: 0, grammarTopicId: 3,
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
      metadata: { mode: 'spaced_review', source: 'builtin', helpUsed: true, hintsUsed: 0 },
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
