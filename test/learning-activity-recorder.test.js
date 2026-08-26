import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { grammarActivityId, splitLearningActivityDuration } from '../public/learning-activity-contract.js';
import {
  GENERATED_GRAMMAR_REVISION,
  GRAMMAR_ACTIVE_PRACTICE_TYPES,
  GRAMMAR_ERROR_CODES,
  GRAMMAR_PRACTICE_MODES,
  GRAMMAR_PREACTIVATION_LEGACY_TOPIC_IDS,
  GRAMMAR_RECOMMENDATION_VERSION,
  GRAMMAR_TARGETED_MIN_ERROR_ITEMS,
  GRAMMAR_TARGETED_MIN_EXACT_ITEMS,
  isBuiltinGrammarDiagnosticId,
  isGrammarConfusionPair,
  isGrammarErrorCode,
  parseGrammarConfusionPair,
  parseGeneratedGrammarItemId,
  parseGeneratedGrammarItemReference,
} from '../public/grammar-domain-contract.js';
import { GRAMMAR_CATALOG, GRAMMAR_CATALOG_V1, GRAMMAR_CATALOG_V2, getGrammarCatalogRuntime, validateGeneratedGrammarSupplement } from '../public/grammar-catalog.js';
import { EasyBoostGrammar, migrateMasteryRecord, reduceMastery } from '../public/modules/grammar.js';
import { grammarMasteryEventSchema, hasExactActiveTransferPairCoverage } from '../validation/grammar-mastery.js';

const rawSource = await fs.readFile(new URL('../public/learning-activity-recorder.js', import.meta.url), 'utf8');
const grammarScreenSource = await fs.readFile(new URL('../public/screens/grammar.js', import.meta.url), 'utf8');
const examModuleSource = await fs.readFile(new URL('../public/modules/exam.js', import.meta.url), 'utf8');
const grammarModuleSource = (await fs.readFile(new URL('../public/modules/grammar.js', import.meta.url), 'utf8'))
  .replace(/^import(?:[\s\S]*?)from '[^']+';\r?\n/gmu, '')
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

function generatedExamSupplement() {
  return {
    tx: ['A ', ' B ', ' C ', ' D ', ' E ', ' F ', '.'],
    gaps: Array.from({ length: 6 }, (_, index) => ({
      b: `WORD${index}`, ans: [`answer${index}`], e: `Reason ${index}.`, t: index + 1,
      voice: { id: `generated.g.e.${GENERATED_REQUEST_HASH}.${GENERATED_RESULT_HASH}.${index + 1}`, revision: 1 },
    })),
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => { resolve = onResolve; reject = onReject; });
  return { promise, resolve, reject };
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
    GRAMMAR_CATALOG, GRAMMAR_CATALOG_V1, GRAMMAR_CATALOG_V2, getGrammarCatalogRuntime, validateGeneratedGrammarSupplement,
    GRAMMAR_PRACTICE_MODES, isGrammarErrorCode, parseGrammarConfusionPair,
    loadAdaptiveSessionRuntime: async () => ({
      adaptiveRuntimeSnapshot: () => ({ active }),
      completeAdaptiveModuleActivity: async (completion) => {
        adaptive.push(completion);
        return { execution: { revision: 2 } };
      },
    }),
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
  const apiCalls = [];
  const voiceErrors = [];
  const voiceAuthorities = [];
  const voiceGuards = [];
  const invalidatedAuthorities = [];
  const timers = [];
  const routeHooks = [];
  const authorityResetHooks = [];
  let owner = options.owner || { username: 'grammar-owner', generation: 1 };
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) {
      elements.set(id, {
        id, innerHTML: '', textContent: '', value: '', style: {}, dataset: {}, children: [], hidden: false, disabled: false,
        attributes: {}, setAttribute(name, value) { this.attributes[name] = String(value); },
        getAttribute(name) { return this.attributes[name] ?? null; }, removeAttribute(name) { delete this.attributes[name]; },
        querySelector() { return element(`${id}:child`); }, querySelectorAll() { return []; }, appendChild() {},
        replaceChildren() { this.innerHTML = ''; this.children = []; }, focus() { this.focused = true; },
        scrollIntoView() {},
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
    addEventListener() {},
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
      canQueueGrammarMasteryEvent(required = 1) {
        capacityRequests.push(required);
        return options.canQueueGrammarMasteryEvent
          ? options.canQueueGrammarMasteryEvent(required)
          : true;
      },
    },
  };
  const context = vm.createContext({
    window,
    GRAMMAR_CATALOG, GRAMMAR_CATALOG_V1, GRAMMAR_CATALOG_V2, getGrammarCatalogRuntime, validateGeneratedGrammarSupplement,
    grammarActivityId, splitLearningActivityDuration,
    GENERATED_GRAMMAR_REVISION, GRAMMAR_ACTIVE_PRACTICE_TYPES, GRAMMAR_ERROR_CODES,
    GRAMMAR_PRACTICE_MODES, GRAMMAR_PREACTIVATION_LEGACY_TOPIC_IDS, GRAMMAR_RECOMMENDATION_VERSION,
    GRAMMAR_TARGETED_MIN_ERROR_ITEMS, GRAMMAR_TARGETED_MIN_EXACT_ITEMS,
    isBuiltinGrammarDiagnosticId, isGrammarConfusionPair, isGrammarErrorCode, parseGrammarConfusionPair,
    parseGeneratedGrammarItemId, parseGeneratedGrammarItemReference,
    loadAdaptiveSessionRuntime: async () => ({
      adaptiveRuntimeSnapshot: () => ({ active }),
      completeAdaptiveModuleActivity: async (completion) => {
        adaptive.push(JSON.parse(JSON.stringify(completion)));
        return { execution: { revision: 2 } };
      },
    }),
    S, SRV: Boolean(options.serverEnabled), TOKEN: options.serverEnabled ? 'test-token' : '',
    apiGet: async (path, requestOptions) => { apiCalls.push({ method: 'GET', path, options: JSON.parse(JSON.stringify(requestOptions || {})) }); return options.apiGet ? options.apiGet(path, requestOptions) : {}; },
    apiPost: async (path, body, headers) => { apiCalls.push({ method: 'POST', path, body: JSON.parse(JSON.stringify(body || null)), headers: JSON.parse(JSON.stringify(headers || {})) }); return options.apiPost ? options.apiPost(path, body, headers) : {}; },
    apiResponseOwner: (payload) => options.apiResponseOwner ? options.apiResponseOwner(payload) : payload?.__responseOwner || owner?.username || '',
    apiIsAuthorityFailure: (error) => options.apiIsAuthorityFailure
      ? options.apiIsAuthorityFailure(error)
      : error?.code === 'OWNER_CHANGED' || error?.status === 401 || (error?.status === 403 && error?.code === 'FORBIDDEN'),
    currentOwnerBinding: () => owner ? { ...owner } : null,
    invalidateLearningAuthority: async (authority) => { invalidatedAuthorities.push(JSON.parse(JSON.stringify(authority))); },
    examModule: {
      elapsedSeconds: (startedAt, endedAt) => Math.floor((endedAt - startedAt) / 1_000),
      record: (record, score) => ({ ...(record || {}), n: Number(record?.n || 0) + 1, last: score, best: Math.max(Number(record?.best || 0), score) }),
      badge: () => '',
    },
    gExamFmt: (seconds) => String(seconds),
    gSync() {}, generateAiContent: (...args) => options.generateAiContent ? options.generateAiContent(...args) : Promise.resolve(null),
    registerScreenGenerator() {}, registerRouteHook(callback) { routeHooks.push(callback); },
    registerAuthorityReset(callback) { authorityResetHooks.push(callback); },
    registerVoiceTutorError: async (details, authority, isCurrent) => {
      voiceErrors.push(JSON.parse(JSON.stringify(details)));
      voiceAuthorities.push(JSON.parse(JSON.stringify(authority || null)));
      voiceGuards.push(isCurrent);
      return options.registerVoiceTutorError ? options.registerVoiceTutorError(details, authority, isCurrent) : details;
    }, voiceTutorButton: options.voiceTutorButton || (() => ''),
    save() {}, setTxt() {}, tab() {},
    ui: { animate() {}, markAnswer() {}, escapeHtml(value) { return String(value); } }, wDeco: () => '',
    decorateCoreGrammar() {},
    document: {
      getElementById: (id) => (window.__skipGrammarArea && id === 'g_area' ? null : element(id)),
      createElement: () => element(`created:${elements.size}`), querySelector: (selector) => element(`selector:${selector}`), querySelectorAll: () => [],
    },
    navigator: { onLine: true },
    crypto: { randomUUID: () => `10000000-0000-4000-8000-${String(++uuid).padStart(12, '0')}` },
    Date: TestDate, Math: testMath,
    setInterval: () => 1, clearInterval() {},
    setTimeout: (callback) => { if (options.deferTimers) timers.push(callback); else callback(); },
    requestAnimationFrame: (callback) => callback(),
    console,
  });
  context.isGrammarErrorCode = isGrammarErrorCode;
  vm.runInContext(examModuleSource, context);
  context.examModule = window.EasyBoostExam;
  vm.runInContext(grammarModuleSource, context);
  context.grammarModule = window.EasyBoostGrammar;
  vm.runInContext(source, context);
  context.recordCompletedLearningActivity = window.__learningActivityRecorderTest.recordCompletedLearningActivity;
  const executableScreen = grammarScreenSource
    .replace(/^import(?:[\s\S]*?)from '[^']+';\r?\n/gmu, '')
    .replace(/^import '[^']+';\r?\n/gmu, '')
    .replace(/^export \{[\s\S]*?\};\r?\n?/mu, '')
    .concat(`
      window.__grammarScreenTest={
        gStart:gStart,gReview:gReview,gTheory:gTheory,gResume:gResume,gExamStart:gExamStart,gExamCheck:gExamCheck,gExamInput:gExamInput,
        gStartMixed:function(){return gStartMixed()},
        gStartTargeted:function(){return gStartTargeted()},
        generateTopic:function(topic){return gGen(topic)},generateExam:function(){return gExamGen()},generateScreen:function(){return genGrammar()},
        restore:initGrammar,
        finish:gFinish,finishReview:gFinishRev,sessionMode:function(){return GS&&GS.mode},sessionTopic:function(){return GS&&GS.t},
        sessionSnapshot:function(){var item=GS&&GS.queue[GS.i];return GS?{sessionId:GS.sessionId,topic:GS.t,index:GS.i,
          practiceMode:GS.practiceMode,scope:GS.scope,focus:GS.recommendation&&GS.recommendation.pointer||null,itemId:item&&item.q.id,phase:GS.phase,done:GS.done,ok:GS.ok,
          queue:GS.queue.map(function(entry){return{id:entry.q.id,topicId:entry.t||GS.t}})}:null},
        markup:function(){return document.getElementById('g_area').innerHTML+document.getElementById('g_action_dock').innerHTML},
        gToThemes:function(){window.__skipGrammarArea=true;try{gToThemes()}finally{window.__skipGrammarArea=false}},
        next:function(){return gAfterExplain()},
        masteryAssisted:function(){return Boolean(GS&&GS.masteryAssisted)},masteryStage:function(topic){return gRec(topic).stage},
        commitCurrentAnswer:function(correct){var item=GS&&GS.queue[GS.i];if(item)gAnswer(correct,item)},
        ruleDisabled:function(){return Boolean(document.getElementById('g_rule_btn').disabled)},
        currentItem:function(){var item=GS&&GS.queue[GS.i];return item?{topic:item.t||GS.t,kind:item.k,id:item.q.id,
          prompt:item.q.t||item.q.s,options:item.q.o||null,answer:Number.isInteger(item.q.a)?item.q.a:null,
          voice:item.q.voice||null,
          errorSkill:item.q.errorSkill,confusionPair:item.q.confusionPair||null}:null},
        renderTransfer:function(topic,type){var levels=G_BANK[topic],kind=type==='choice'?'c':type==='input'?'f':type;
          var question=levels[kind][0];GS={activeRunner:false,t:topic,queue:[{k:type,q:question,t:topic,transfer:true}],i:0,
            ok:0,done:0,phase:'question'};gRenderQ();return document.getElementById('g_area').innerHTML},
        answerCurrent:function(correct,advanceExplanation=true){var item=GS&&GS.queue[GS.i];if(!item)return;
          var answer=['f','input','correction','transform'].includes(item.k)?(correct?item.q.ans[0]:'definitely wrong'):(correct?item.q.a:(item.q.a+1)%item.q.o.length);
          var checked=grammarModule.checkPracticeAnswer(item,answer),accepted=gAnswer(checked.correct,item,checked);if(!accepted)return;
          if(!checked.correct)gCommitWrongState(item,checked);else{GS.phase='explain';if(gIsPracticeSession())gPersistRunner()}
          gExplain(item,String(answer),false,checked.correct);if(advanceExplanation)gAfterExplain()}
        ,answerChoice:function(choice){var item=GS&&GS.queue[GS.i];if(!item||!['c','c2','choice'].includes(item.k))return;
          var checked=grammarModule.checkPracticeAnswer(item,choice),accepted=gAnswer(checked.correct,item,checked);if(!accepted)return;
          if(!checked.correct)gCommitWrongState(item,checked);else{GS.phase='explain';if(gIsPracticeSession())gPersistRunner()}
          gExplain(item,String(choice),false,checked.correct);gAfterExplain()}
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
    voiceErrors,
    voiceAuthorities,
    voiceGuards,
    invalidatedAuthorities,
    apiCalls,
    area: element('g_area'),
    elementMarkup(id) { return element(id).innerHTML; },
    stateSnapshot() { return JSON.parse(JSON.stringify(S)); },
    runTimers() { while (timers.length) timers.shift()(); },
    advance(milliseconds) { now += milliseconds; },
    setActive(value) { active = value; },
    setOnline(value) { context.navigator.onLine = Boolean(value); },
    resetOwner(nextOwner) {
      const previous = owner ? { owner: owner.username, ownerGeneration: owner.generation } : null;
      owner = nextOwner ? { ...nextOwner } : null;
      authorityResetHooks.forEach((hook) => hook(previous));
    },
    navigate(id) { routeHooks.forEach((hook) => hook(id)); },
  };
}

test('mixed browser practice hides topic hints and restores its exact device-local queue offline', () => {
  const first = grammarScreenHarness();
  first.screen.gStartMixed();
  const started = first.screen.sessionSnapshot();
  const current = first.screen.currentItem();

  assert.equal(started.practiceMode, 'mixed_practice');
  assert.equal(started.scope, 'mixed');
  assert.equal(started.queue.length, 16);
  assert.ok(new Set(started.queue.map((entry) => entry.topicId)).size >= 8);
  assert.match(first.screen.markup(), /Смешанная практика/u);
  assert.doesNotMatch(first.screen.markup(), new RegExp(GRAMMAR_CATALOG.topics[current.topic].n, 'u'));
  assert.doesNotMatch(first.screen.markup(), /id="g_rule_btn"/u,
    'a rule button would disclose the hidden topic before the answer');

  const local = first.stateSnapshot();
  assert.equal(local.grammarRunner.schema, 'grammar-runner-v5');
  assert.equal(local.grammarRunner.scope, 'mixed');
  assert.ok(local.grammarRunner.queue.every((entry) => Number.isInteger(entry.topicId)));

  const reloaded = grammarScreenHarness({ state: local });
  reloaded.screen.restore();
  assert.deepEqual(JSON.parse(JSON.stringify(reloaded.screen.sessionSnapshot())), JSON.parse(JSON.stringify(started)),
    'reload uses only the addressable local snapshot and does not rebuild a different queue');
  assert.match(reloaded.screen.markup(), /Смешанная практика/u);
});

test('targeted browser practice resolves the exact server focus once and resumes it offline', async () => {
  const focusItem = GRAMMAR_CATALOG.bank[3].c[0];
  const diagnostic = focusItem.diagnostics.find(Boolean);
  const pointer = {
    version: 'grammar-focus-v1', catalogVersion: GRAMMAR_CATALOG.version,
    catalogRevision: GRAMMAR_CATALOG.revision, topicId: 3,
    errorCode: diagnostic.errorCode, confusionPair: diagnostic.confusionPair || null,
    masteryRevision: 0, eligibleAt: null, earlyPractice: false,
    stateFingerprint: 'a'.repeat(64), ref: 'b'.repeat(64),
  };
  const recommendation = { pointer, reasonCodes: ['recent_weakness'], observedErrorCount: 1, observedAt: 900 };
  const selected = EasyBoostGrammar.buildTargetedPracticeQueue(
    GRAMMAR_CATALOG.bank, pointer, { seed: pointer.ref },
  );
  const first = grammarScreenHarness({
    apiGet: async () => ({ recommendation }),
    apiPost: async () => ({
      recommendation,
      catalog: { version: GRAMMAR_CATALOG.version, revision: GRAMMAR_CATALOG.revision },
      itemIds: selected.map((entry) => entry.q.id),
      completionToken: 'g'.repeat(43),
    }),
  });

  await first.screen.gStartTargeted();
  const started = first.screen.sessionSnapshot();
  assert.equal(started.practiceMode, 'targeted_practice');
  assert.equal(started.scope, 'topic');
  assert.deepEqual(JSON.parse(JSON.stringify(started.focus)), pointer);
  assert.equal(started.queue.length, 8);
  assert.ok(started.queue.every((entry) => entry.topicId === pointer.topicId));
  assert.deepEqual(first.apiCalls.map((call) => `${call.method} ${call.path}`), [
    'GET /api/v1/grammar/recommendation',
    'POST /api/v1/grammar/recommendation/resolve',
  ]);
  assert.deepEqual(first.apiCalls[0].options.headers, { 'X-EasyBoost-Expected-Owner': 'grammar-owner' });
  assert.deepEqual(first.apiCalls[1].headers, { 'X-EasyBoost-Expected-Owner': 'grammar-owner' });
  assert.deepEqual(first.apiCalls[1].body, { pointer });
  assert.match(first.screen.markup(), /Точечная практика/u);
  assert.doesNotMatch(first.screen.markup(), new RegExp(GRAMMAR_CATALOG.topics[pointer.topicId].n, 'u'));
  assert.doesNotMatch(first.screen.markup(), /id="g_rule_btn"/u);

  const local = first.stateSnapshot();
  const reloaded = grammarScreenHarness({ state: local });
  reloaded.screen.restore();
  assert.deepEqual(JSON.parse(JSON.stringify(reloaded.screen.sessionSnapshot())), JSON.parse(JSON.stringify(started)));
  assert.equal(reloaded.apiCalls.length, 0, 'an already authorized local queue resumes without network calls');
});

test('targeted recommendation fails closed on response-owner mismatch', async () => {
  const harness = grammarScreenHarness({
    apiGet: async () => ({ recommendation: {}, __responseOwner: 'different-owner' }),
  });

  await harness.screen.gStartTargeted();

  assert.equal(harness.screen.sessionSnapshot(), null);
  assert.deepEqual(harness.apiCalls.map((call) => call.method), ['GET']);
  assert.deepEqual(harness.invalidatedAuthorities, [{ owner: 'grammar-owner', ownerGeneration: 1 }]);
});

test('targeted recommendation authority failure invalidates the learner shell instead of showing retry', async () => {
  const failure = Object.assign(new Error('expired'), { status: 401, code: 'AUTH_REQUIRED' });
  const harness = grammarScreenHarness({ apiGet: async () => { throw failure; } });

  await harness.screen.gStartTargeted();

  assert.equal(harness.screen.sessionSnapshot(), null);
  assert.deepEqual(harness.invalidatedAuthorities, [{ owner: 'grammar-owner', ownerGeneration: 1 }]);
  assert.doesNotMatch(harness.screen.markup(), /Повторить/u,
    'an authority failure must not leave a retryable stale-owner screen behind');
});

test('delayed targeted recommendation from owner A cannot create a runner or DOM for owner B', async () => {
  const issued = deferred();
  const harness = grammarScreenHarness({ apiGet: () => issued.promise });
  const pending = harness.screen.gStartTargeted();
  assert.deepEqual(harness.apiCalls[0].options.headers, { 'X-EasyBoost-Expected-Owner': 'grammar-owner' });

  harness.resetOwner({ username: 'owner-b', generation: 2 });
  issued.resolve({ recommendation: {}, __responseOwner: 'grammar-owner' });
  await pending;

  assert.equal(harness.screen.sessionSnapshot(), null);
  assert.equal(harness.stateSnapshot().grammarRunner, undefined);
  assert.equal(harness.apiCalls.length, 1, 'stale owner A response cannot reach the resolver call');
  assert.equal(harness.area.innerHTML, '', 'authority reset remains the last DOM write');
});

test('delayed topic and exam generation from owner A cannot write owner B state', async () => {
  const topicRequest = deferred();
  const examRequest = deferred();
  const generationCalls = [];
  const harness = grammarScreenHarness({
    serverEnabled: true,
    generateAiContent(operation, payload, headers) {
      generationCalls.push({ operation, payload, headers });
      if (operation === 'grammar_topic_set') return topicRequest.promise;
      if (operation === 'grammar_exam_19_24') return examRequest.promise;
      return Promise.resolve(null);
    },
  });
  const topicPending = harness.screen.generateTopic(3);
  const examPending = harness.screen.generateExam();
  assert.deepEqual(JSON.parse(JSON.stringify(generationCalls.map((call) => call.headers))), [
    { 'X-EasyBoost-Expected-Owner': 'grammar-owner' },
    { 'X-EasyBoost-Expected-Owner': 'grammar-owner' },
  ]);

  harness.resetOwner({ username: 'owner-b', generation: 2 });
  topicRequest.resolve(generatedTopicSupplement());
  examRequest.resolve(generatedExamSupplement());
  await Promise.all([topicPending, examPending]);

  const state = harness.stateSnapshot();
  assert.equal(state.gramAi[3], undefined);
  assert.equal(state.examAi, undefined);
  assert.equal(state.grammarRunner, undefined);
  assert.equal(harness.area.innerHTML, '', 'stale generators cannot repaint after authority reset');
});

test('generated Grammar supplements reject a mismatched response owner before validation or storage', async () => {
  const supplement = { ...generatedTopicSupplement(), __responseOwner: 'different-owner' };
  const harness = grammarScreenHarness({
    serverEnabled: true,
    generateAiContent: async () => supplement,
  });

  await harness.screen.generateTopic(3);

  assert.equal(harness.stateSnapshot().gramAi[3], undefined);
  assert.deepEqual(harness.invalidatedAuthorities, [{ owner: 'grammar-owner', ownerGeneration: 1 }]);
});

test('delayed Grammar Voice Tutor registration cannot post or render across owner switch or route leave', async () => {
  const ownerRequest = deferred();
  const ownerHarness = grammarScreenHarness({
    registerVoiceTutorError: () => ownerRequest.promise,
    voiceTutorButton: () => '<button>Voice Tutor</button>',
  });
  ownerHarness.screen.gStart(3);
  assert.ok(ownerHarness.screen.currentItem().voice, 'the canonical item exposes only its Voice Tutor pointer');
  ownerHarness.screen.answerCurrent(false, false);
  assert.deepEqual(ownerHarness.voiceAuthorities, [{ owner: 'grammar-owner' }]);

  ownerHarness.resetOwner({ username: 'owner-b', generation: 2 });
  assert.equal(ownerHarness.voiceGuards[0](), false, 'the lazy-loader guard becomes false before it may POST for owner A');
  ownerRequest.resolve({ attemptId: 'voice-owner-a', revision: 1 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ownerHarness.elementMarkup('voice_tutor_grammar_practice'), '',
    'owner A registration cannot populate a reused owner B slot');

  const routeRequest = deferred();
  const routeHarness = grammarScreenHarness({
    registerVoiceTutorError: () => routeRequest.promise,
    voiceTutorButton: () => '<button>Voice Tutor</button>',
  });
  routeHarness.screen.gStart(3);
  routeHarness.screen.answerCurrent(false, false);
  routeHarness.navigate('scr1');
  assert.equal(routeHarness.voiceGuards[0](), false, 'the lazy-loader guard becomes false before it may POST for a departed route');
  routeRequest.resolve({ attemptId: 'voice-old-route', revision: 1 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(routeHarness.elementMarkup('voice_tutor_grammar_practice'), '',
    'a departed Grammar route cannot receive a late Voice Tutor control');
});

test('mixed completion persists exact cross-topic history without granting a topic stage', async () => {
  const harness = grammarScreenHarness({
    saveGrammarMasteryEvent: (topicId, event) => ({
      eventId: event.id, applied: true, replay: false, conflict: false,
      record: reduceMastery(migrateMasteryRecord(), event, { now: 10_000, clockAuthority: 'server' }),
    }),
  });
  harness.screen.gStartMixed();
  while (harness.screen.currentItem()) harness.screen.answerCurrent(true);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(harness.masteryEvents.length, 1);
  const submitted = harness.masteryEvents[0];
  assert.equal(submitted.event.session.scope, 'mixed');
  assert.equal(submitted.event.session.mode, 'mixed_practice');
  assert.equal(submitted.event.session.items.length, 16);
  assert.ok(submitted.event.session.items.every((item) => Number.isInteger(item.topicId)));
  assert.equal(grammarMasteryEventSchema.safeParse(submitted).success, true);
  assert.equal(harness.stateSnapshot().grammarMastery[submitted.topicId].stage, 'not_started');
  assert.equal(harness.ordinary.length, 1);
  assert.equal(harness.ordinary[0].activity, 'grammar_mixed_practice');
  assert.deepEqual(harness.ordinary[0].metadata, {
    mode: 'mixed_practice', source: 'builtin', helpUsed: false, hintsUsed: 0,
  });
  assert.match(harness.screen.markup(), /Смешанная практика/u);
  assert.match(harness.screen.markup(), /onclick="gStartMixed\(\)"/u);
});

test('a failed mixed item keeps its paired transfer and exact pending event across reload', async () => {
  const first = grammarScreenHarness();
  first.screen.gStartMixed();
  first.screen.answerCurrent(false);
  while (first.screen.currentItem()) first.screen.answerCurrent(true);
  await new Promise((resolve) => setImmediate(resolve));

  const submitted = first.masteryEvents[0];
  assert.equal(submitted.event.session.items.length, 17);
  assert.equal(submitted.event.session.items.filter((item) => item.transfer).length, 1);
  assert.equal(submitted.event.assisted, true);
  assert.equal(Object.hasOwn(submitted.event, 'independentError'), false);
  assert.equal(grammarMasteryEventSchema.safeParse(submitted).success, true);
  const pendingState = first.stateSnapshot();
  assert.equal(pendingState.grammarRunner.phase, 'completion_pending');

  const reloaded = grammarScreenHarness({ state: pendingState });
  reloaded.screen.restore();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reloaded.masteryEvents.length, 1,
    'a mixed disclosure must not make the exact device-local pending event unrestorable');
  assert.deepEqual(reloaded.masteryEvents[0].event, submitted.event);
});

test('targeted completion reports its server-selected exact weakness but cannot advance mastery', async () => {
  const focusItem = GRAMMAR_CATALOG.bank[3].c[0];
  const diagnostic = focusItem.diagnostics.find(Boolean);
  const pointer = {
    version: 'grammar-focus-v1', catalogVersion: GRAMMAR_CATALOG.version,
    catalogRevision: GRAMMAR_CATALOG.revision, topicId: 3,
    errorCode: diagnostic.errorCode, confusionPair: diagnostic.confusionPair || null,
    masteryRevision: 0, eligibleAt: null, earlyPractice: false,
    stateFingerprint: 'c'.repeat(64), ref: 'd'.repeat(64),
  };
  const recommendation = { pointer, reasonCodes: ['recent_weakness'], observedErrorCount: 1, observedAt: 900 };
  const selected = EasyBoostGrammar.buildTargetedPracticeQueue(
    GRAMMAR_CATALOG.bank, pointer, { seed: pointer.ref },
  );
  const harness = grammarScreenHarness({
    apiGet: async () => ({ recommendation }),
    apiPost: async () => ({
      recommendation,
      catalog: { version: GRAMMAR_CATALOG.version, revision: GRAMMAR_CATALOG.revision },
      itemIds: selected.map((entry) => entry.q.id),
      completionToken: 'h'.repeat(43),
    }),
    saveGrammarMasteryEvent: (topicId, event) => ({
      eventId: event.id, applied: true, replay: false, conflict: false,
      record: reduceMastery(migrateMasteryRecord(), event, { now: 10_000, clockAuthority: 'server' }),
    }),
  });

  await harness.screen.gStartTargeted();
  while (harness.screen.currentItem()) harness.screen.answerCurrent(true);
  await new Promise((resolve) => setImmediate(resolve));

  const submitted = harness.masteryEvents[0];
  assert.equal(grammarMasteryEventSchema.safeParse(submitted).success, true);
  assert.equal(submitted.event.session.mode, 'targeted_practice');
  assert.equal(harness.stateSnapshot().grammarMastery[3].stage, 'not_started');
  assert.deepEqual(harness.ordinary[0].metadata, {
    mode: 'targeted_practice', source: 'builtin', helpUsed: false, hintsUsed: 0,
    grammarTopicId: 3, grammarErrorCode: pointer.errorCode,
    ...(pointer.confusionPair ? { grammarConfusionPair: pointer.confusionPair } : {}),
  });
  assert.match(harness.screen.markup(), /Точечная практика/u);
  assert.match(harness.screen.markup(), /onclick="gStartTargeted\(\)"/u);
});

test('a failed targeted item keeps its exact authorized transfer queue across reload', async () => {
  const focusItem = GRAMMAR_CATALOG.bank[3].c[0];
  const diagnostic = focusItem.diagnostics.find(Boolean);
  const pointer = {
    version: 'grammar-focus-v1', catalogVersion: GRAMMAR_CATALOG.version,
    catalogRevision: GRAMMAR_CATALOG.revision, topicId: 3,
    errorCode: diagnostic.errorCode, confusionPair: diagnostic.confusionPair || null,
    masteryRevision: 0, eligibleAt: null, earlyPractice: false,
    stateFingerprint: 'e'.repeat(64), ref: 'f'.repeat(64),
  };
  const recommendation = { pointer, reasonCodes: ['recent_weakness'], observedErrorCount: 1, observedAt: 900 };
  const selected = EasyBoostGrammar.buildTargetedPracticeQueue(
    GRAMMAR_CATALOG.bank, pointer, { seed: pointer.ref },
  );
  const first = grammarScreenHarness({
    apiGet: async () => ({ recommendation }),
    apiPost: async () => ({
      recommendation,
      catalog: { version: GRAMMAR_CATALOG.version, revision: GRAMMAR_CATALOG.revision },
      itemIds: selected.map((entry) => entry.q.id),
      completionToken: 'i'.repeat(43),
    }),
  });

  await first.screen.gStartTargeted();
  first.screen.answerCurrent(false);
  while (first.screen.currentItem()) first.screen.answerCurrent(true);
  await new Promise((resolve) => setImmediate(resolve));
  const submitted = first.masteryEvents[0];
  assert.equal(submitted.event.session.items.length, 9);
  assert.equal(submitted.event.session.items.filter((item) => item.transfer).length, 1);
  assert.equal(grammarMasteryEventSchema.safeParse(submitted).success, true);

  const reloaded = grammarScreenHarness({ state: first.stateSnapshot() });
  reloaded.screen.restore();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(reloaded.masteryEvents[0].event, submitted.event);
  assert.equal(reloaded.apiCalls.length, 0,
    'an authorized targeted transfer queue restores without resolving a new focus');
});

function preActivationLegacyState({ topicId = 14, queueIds = null, gramAi = {} } = {}) {
  const seed = grammarScreenHarness({ state: { gram: {}, grammarMastery: {}, gramAi } });
  seed.screen.gStart(topicId);
  const state = seed.stateSnapshot();
  const ids = queueIds || [
    `core.g.${topicId}.c.1`, `core.g.${topicId}.c.2`, `core.g.${topicId}.c.3`, `core.g.${topicId}.c.4`,
    `core.g.${topicId}.c2.1`, `core.g.${topicId}.c2.2`, `core.g.${topicId}.c2.3`,
  ];
  Object.assign(state.grammarRunner, {
    catalogVersion: GRAMMAR_CATALOG_V1.version,
    catalogRevision: GRAMMAR_CATALOG_V1.revision,
    topicId,
    mode: 'legacy_practice',
    queue: ids.map((id) => ({ id, transfer: false })),
    i: 0,
    ok: 0,
    done: 0,
    source: ids.some((id) => id.startsWith('generated.')) ? 'mixed' : 'builtin',
    helpUsed: false,
    masteryAssisted: ids.some((id) => id.startsWith('generated.')),
    phase: 'question',
    answerAssisted: false,
    errorReasons: {},
    confusionPairs: {},
    independentErrors: {},
    types: {},
    typeScores: {},
    reservedItemIds: [...ids],
    itemOutcomes: [],
    completionEvent: null,
  });
  return state;
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

test('a stale explicit Next action cannot advance a replacement Grammar session', () => {
  const harness = grammarScreenHarness();
  harness.screen.gStart(3);
  harness.screen.answerCurrent(true, false);
  assert.equal(harness.screen.sessionSnapshot().phase, 'explain');
  harness.screen.gStart(4);
  const replacement = harness.screen.sessionSnapshot();

  harness.screen.next();

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

test('a queued pre-activation legacy topic emits one stable bounded session without claiming four-type mastery', async () => {
  const harness = grammarScreenHarness({ state: preActivationLegacyState() });
  harness.screen.restore();
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

test('a real pre-Ticket06 v2 queue restores and records its immutable historical item after activation', async () => {
  const state = preActivationLegacyState({ topicId: 19, queueIds: ['core.g.19.c.2'] });
  state.grammarRunner.catalogVersion = GRAMMAR_CATALOG_V2.version;
  state.grammarRunner.catalogRevision = GRAMMAR_CATALOG_V2.revision;
  assert.deepEqual({
    version: state.grammarRunner.catalogVersion,
    revision: state.grammarRunner.catalogRevision,
  }, { version: GRAMMAR_CATALOG_V2.version, revision: GRAMMAR_CATALOG_V2.revision },
  'the pre-Ticket06 runner really persisted the then-current v2 identity');

  const reloaded = grammarScreenHarness({ state });
  reloaded.screen.restore();
  const current = reloaded.screen.currentItem();
  assert.deepEqual(JSON.parse(JSON.stringify(current?.prompt)), GRAMMAR_CATALOG_V2.bank[19].c[1].t);
  assert.deepEqual(JSON.parse(JSON.stringify(current?.options)), GRAMMAR_CATALOG_V2.bank[19].c[1].o);
  assert.equal(current?.answer, GRAMMAR_CATALOG_V2.bank[19].c[1].a);
  assert.equal(current?.voice?.revision, GRAMMAR_CATALOG_V2.bank[19].c[1].voice.revision);
  assert.notDeepEqual(GRAMMAR_CATALOG.bank[19].c[1].o, GRAMMAR_CATALOG_V2.bank[19].c[1].o,
    'the seam proves restore did not silently substitute the active v2 override');
  reloaded.screen.answerCurrent(true);
  await new Promise((resolve) => setImmediate(resolve));
  const { topicId, event } = reloaded.masteryEvents[0];
  assert.deepEqual(event.session.catalog, {
    version: GRAMMAR_CATALOG_V2.version,
    revision: GRAMMAR_CATALOG_V2.revision,
  });
  const parsed = grammarMasteryEventSchema.safeParse({ topicId, event });
  assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues));
});

test('an active v2 failure keeps its transfer, reload, Voice pointer and completion in immutable v2', async () => {
  const seed = grammarScreenHarness({ state: { gram: {}, grammarMastery: {}, gramAi: {} } });
  seed.screen.gStart(1);
  const state = seed.stateSnapshot();
  state.grammarRunner.catalogVersion = GRAMMAR_CATALOG_V2.version;
  state.grammarRunner.catalogRevision = GRAMMAR_CATALOG_V2.revision;

  const first = grammarScreenHarness({ state });
  first.screen.restore();
  const original = first.screen.currentItem();
  assert.equal(original.voice.revision, 2);
  first.screen.answerCurrent(false);
  assert.equal(first.screen.currentItem()?.voice?.revision, 2,
    'the in-memory transfer must use the resolved v2 bank before any reload can reinterpret its ID');
  const interrupted = first.stateSnapshot();
  assert.equal(interrupted.grammarRunner.queue[interrupted.grammarRunner.i].transfer, true);

  const reloaded = grammarScreenHarness({
    state: interrupted,
    saveGrammarMasteryEvent: (topicId, event) => ({ eventId: event.id, applied: true }),
  });
  reloaded.screen.restore();
  const transfer = reloaded.screen.currentItem();
  assert.equal(transfer.voice.revision, 2, 'the restored transfer uses the immutable v2 question pointer');
  assert.equal(transfer.voice.revision, GRAMMAR_CATALOG_V2.bank[1].c.find((item) => item.id === transfer.id).revision);
  reloaded.screen.answerCurrent(false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reloaded.voiceErrors.at(-1)?.revision, 2, 'Voice Tutor records the displayed historical transfer revision');

  while (reloaded.screen.currentItem()) reloaded.screen.answerCurrent(true);
  await new Promise((resolve) => setImmediate(resolve));
  const { topicId, event } = reloaded.masteryEvents[0];
  assert.deepEqual(event.session.catalog, { version: GRAMMAR_CATALOG_V2.version, revision: GRAMMAR_CATALOG_V2.revision });
  assert.equal(event.session.items.find((item) => item.transfer)?.id, transfer.id);
  const parsed = grammarMasteryEventSchema.safeParse({ topicId, event });
  assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues));
});

test('a failed active answer durably snapshots explain and transfer before explicit Next', () => {
  const harness = grammarScreenHarness({
    state: { gram: {}, grammarMastery: {}, gramAi: {} }, deferTimers: true,
  });
  harness.screen.gStart(1);
  harness.screen.answerCurrent(false, false);
  const interrupted = harness.stateSnapshot().grammarRunner;
  assert.equal(interrupted.phase, 'explain');
  assert.equal(interrupted.queue[interrupted.i + 1].transfer, true);
});

test('active transfer-pair ownership is resolved from the submitted immutable session catalog', () => {
  const outcomes = ['one', 'two', 'three', 'four'].map((id) => ({ id, type: 'choice', transfer: false }));
  const immutableV2 = new Map(outcomes.map((outcome, index) => [outcome.id, { transferPair: `v2-pair-${index}` }]));
  const mismatchedCurrent = new Map(outcomes.map((outcome, index) => [
    outcome.id, { transferPair: index === 3 ? 'current-pair-0' : `current-pair-${index}` },
  ]));

  assert.equal(hasExactActiveTransferPairCoverage(
    outcomes, (id) => immutableV2.get(id), ['choice'],
  ), true, 'the submitted immutable catalog owns four distinct authored pairs');
  assert.equal(hasExactActiveTransferPairCoverage(
    outcomes, (id) => mismatchedCurrent.get(id), ['choice'],
  ), false, 'a current-catalog lookup cannot validate the immutable session by accident');
});

test('legacy completion_pending survives a crash and retries the exact UUID without duplicate history', async () => {
  const first = grammarScreenHarness({ state: preActivationLegacyState() });
  first.screen.restore();
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
  const first = grammarScreenHarness({ state: preActivationLegacyState() });
  first.screen.restore();
  let guard = 0;
  while (first.screen.currentItem()?.kind !== 'choice' && guard < 8) {
    first.screen.answerCurrent(true);
    guard += 1;
  }
  assert.equal(first.screen.currentItem()?.kind, 'choice', 'the queued topic-14 run reaches a legacy choice');
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
  const state = preActivationLegacyState({ topicId: 10, queueIds: ['core.g.10.f.1'] });

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
  const state = preActivationLegacyState({ topicId: 10, queueIds: ['core.g.10.c.1'] });

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
  const harness = grammarScreenHarness({ state: preActivationLegacyState() });
  harness.screen.restore();
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
  const gramAi = { 14: [
    ...generated.c.map((q) => ({ k: 'c', q, voice: q.voice })),
    ...generated.f.map((q) => ({ k: 'f', q, voice: q.voice })),
  ] };
  const queueIds = [
    'core.g.14.c.1', 'core.g.14.c2.1',
    generated.c[0].id, generated.c[1].id, generated.f[0].id, generated.f[1].id,
  ];
  const harness = grammarScreenHarness({ state: preActivationLegacyState({ gramAi, queueIds }) });
  harness.screen.restore();
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
  const gramAi = { 14: [
    ...generated.c.map((q) => ({ k: 'c', q, voice: q.voice })),
    ...generated.f.map((q) => ({ k: 'f', q, voice: q.voice })),
  ] };
  const state = preActivationLegacyState({ gramAi, queueIds: [
    generated.f[0].id, 'core.g.14.c.1', generated.c[0].id,
  ] });
  const first = grammarScreenHarness({ state });
  first.screen.restore();
  let guard = 0;
  while (!(first.screen.currentItem()?.kind === 'input'
    && first.screen.currentItem()?.id.startsWith('generated.g.q.')) && guard < 8) {
    first.screen.answerCurrent(true);
    guard += 1;
  }
  assert.equal(first.screen.currentItem()?.kind, 'input');
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
  const harness = grammarScreenHarness({ state: preActivationLegacyState() });
  harness.screen.restore();
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
    if (type === 'choice') {
      assert.match(html, /role="radiogroup"[^>]+aria-labelledby="g_task_title"/u);
      assert.match(html, /<button[^>]+role="radio"[^>]+aria-checked="false"[^>]+tabindex="0"[^>]+onclick="gSelectChoice\(this,0,\d+\)"/u);
      assert.doesNotMatch(html, /id="g_inp"/u);
    } else {
      assert.match(html, /<label class="grammar-label" for="g_inp">[^<]+<\/label>/u, `${type} input label`);
      assert.match(html, /<input id="g_inp" class="grammar-answer-input"[^>]+onkeydown="if\(event\.key==='Enter'\)\{event\.preventDefault\(\);gSubmit\(\d+\)\}"/u, `${type} Enter submit`);
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

test('a correct answer after opening the rule is labelled as assisted in review copy', () => {
  const harness = grammarScreenHarness();
  harness.screen.gStart(3);
  harness.screen.gTheory(3);
  harness.screen.gResume();
  harness.screen.answerCurrent(true, false);

  assert.match(harness.screen.markup(), /ответ с опорой/u);
  assert.doesNotMatch(harness.screen.markup(), /самостоятельный ответ/u);
  assert.equal(harness.screen.masteryAssisted(), true);
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
  assert.doesNotMatch(harness.area.innerHTML, /Снова в работе/u);
  assert.match(harness.area.innerHTML, /Изучено/u);
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
  assert.doesNotMatch(harness.area.innerHTML, /Снова в работе/u);
  assert.match(harness.area.innerHTML, /Изучено/u);
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
  assert.match(harness.area.innerHTML, /Статус обновится после синхронизации/u);
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
  assert.match(harness.area.innerHTML, /Ожидает синхронизации/u);
  assert.doesNotMatch(harness.area.innerHTML, /Изучено|Устойчиво|Снова в работе/u);
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
  await harness.screen.gExamCheck();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.ordinary.length, 3, 'adaptive exam does not emit an ordinary duplicate');
  assert.deepEqual(JSON.parse(JSON.stringify(harness.adaptive)), [{
    module: 'grammar', activityId: 'grammar_forms_exam_19_24', score: 0, maxScore: 6, durationMs: 2_000,
  }]);
});

test('grammar exam reserves its one atomic offline event slot before starting', () => {
  const harness = grammarScreenHarness({
    canQueueGrammarMasteryEvent: () => false,
  });

  harness.screen.gExamStart('builtin:exam:grammar:19-24:v1');

  assert.deepEqual(harness.capacityRequests, [1]);
  assert.equal(harness.stateSnapshot().grammarRunner, undefined,
    'a full queue cannot create a runner whose atomic multi-topic completion cannot be stored');
  assert.match(harness.screen.markup(), /Подключитесь для синхронизации/u);
});

test('grammar exam keeps its exact runner and evidence local until the atomic result is durable', async () => {
  let submission = 0;
  const harness = grammarScreenHarness({
    saveGrammarMasteryEvent: (_topicId, event) => (++submission === 1 ? {
      queued: false, code: 'GRAMMAR_MASTERY_QUEUE_FULL',
    } : { eventId: event.id, applied: true }),
  });
  harness.screen.gExamStart('builtin:exam:grammar:19-24:v1');
  const started = harness.stateSnapshot().grammarRunner;

  await harness.screen.gExamCheck();

  const retained = harness.stateSnapshot().grammarRunner;
  assert.equal(retained.schema, 'grammar-exam-runner-v1');
  assert.equal(retained.sessionId, started.sessionId);
  assert.equal(retained.formId, started.formId);
  assert.equal(retained.startedAt, started.startedAt);
  assert.equal(harness.stateSnapshot().exam19, undefined,
    'a failed atomic write cannot become a completed local exam attempt');
  assert.equal(harness.ordinary.length, 0);
  assert.equal(harness.adaptive.length, 0);
  assert.match(harness.screen.markup(), /Повторить сохранение/u);

  await harness.screen.gExamCheck();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(harness.stateSnapshot().grammarRunner, null);
  assert.equal(harness.stateSnapshot().exam19.n, 1,
    'the recovered exact event becomes one completed local exam attempt');
  assert.equal(harness.masteryEvents.length, 2);
  assert.equal(harness.masteryEvents[0].event.id, harness.masteryEvents[1].event.id,
    'retry reuses the stable session UUID');
  assert.equal(harness.ordinary.length, 1,
    'ordinary learning evidence is emitted once, only after durable acceptance');
});

test('grammar exam error-bank evidence is owner-bound and stale responses cannot finalize another view', async () => {
  for (const staleAction of ['owner-switch', 'route-leave']) {
    const pending = deferred();
    const harness = grammarScreenHarness({
      serverEnabled: true,
      saveGrammarMasteryEvent: (_topicId, event) => ({ eventId: event.id, applied: true }),
      apiPost: (path) => path === '/api/v1/error-bank' ? pending.promise : {},
    });
    harness.screen.gExamStart('builtin:exam:grammar:19-24:v1');
    const checking = harness.screen.gExamCheck();
    await new Promise((resolve) => setImmediate(resolve));

    const mutation = harness.apiCalls.find((call) => call.path === '/api/v1/error-bank');
    assert.deepEqual(mutation?.headers, { 'X-EasyBoost-Expected-Owner': 'grammar-owner' });
    if (staleAction === 'owner-switch') harness.resetOwner({ username: 'owner-b', generation: 2 });
    else harness.navigate('scr1');
    pending.resolve({ __responseOwner: 'grammar-owner' });
    await checking;

    assert.equal(harness.stateSnapshot().exam19, undefined,
      `${staleAction} prevents the delayed owner-A response from finalizing local exam state`);
    assert.equal(harness.ordinary.length, 0,
      `${staleAction} prevents delayed evidence from being attributed to the replacement view`);
  }
});

test('grammar exam rejects an error-bank response owned by another account', async () => {
  const harness = grammarScreenHarness({
    serverEnabled: true,
    saveGrammarMasteryEvent: (_topicId, event) => ({ eventId: event.id, applied: true }),
    apiPost: (path) => path === '/api/v1/error-bank' ? { __responseOwner: 'owner-b' } : {},
  });
  harness.screen.gExamStart('builtin:exam:grammar:19-24:v1');

  await harness.screen.gExamCheck();

  assert.deepEqual(harness.invalidatedAuthorities, [{ owner: 'grammar-owner', ownerGeneration: 1 }]);
  assert.equal(harness.stateSnapshot().exam19, undefined);
  assert.equal(harness.ordinary.length, 0);
});

test('route entry restores an exam that remains editable and submittable', () => {
  const seed = grammarScreenHarness();
  seed.screen.gExamStart('builtin:exam:grammar:19-24:v1');
  seed.screen.gExamInput(0, 'saved draft');
  const state = seed.stateSnapshot();

  const restored = grammarScreenHarness({ state });
  restored.navigate('scr3');
  restored.screen.gExamInput(0, 'edited after restore');

  assert.equal(restored.stateSnapshot().grammarRunner.answers[0], 'edited after restore',
    'the screen cleanup hook cannot discard the live restored EX state');
});
