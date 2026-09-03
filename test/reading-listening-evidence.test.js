import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import {
  learningActivityPool,
  learningActivitySource,
  listeningActivityId,
  readingActivityId,
  splitLearningActivityDuration,
} from '../public/learning-activity-contract.js';
import {
  interviewSetForLegacyScreen,
  loadInterviewCatalog,
  loadMatchingCatalog,
  loadTrueFalseCatalog,
  matchingSetForLegacyScreen,
  trueFalseSetForLegacyScreen,
} from '../public/listening-catalog-contract.js';
import {
  READING_CATALOG_ID,
  READING_CATALOG_REVISION,
  READING_FULL_ATTEMPT_VERSION,
  READING_KINDS,
  READING_KIND_RULES,
  adaptLegacyReadingFallback,
  assertReadingCatalog,
  assertReadingSet,
  loadReadingCatalog,
  parseReadingAdaptiveContentRef,
  readingAdaptiveContentRef,
  readingLearningActivityContract,
  readingSourceContext,
  readingSourceContextFromSets,
  readingSetForLegacyScreen,
  readingSetForVoiceTutor,
  readingSetReference,
} from '../public/reading-catalog-contract.js';
import {
  normalizeVocabularyWord,
  personalVocabularyCardId,
  upsertReadingVocabularyCard,
} from '../public/vocabulary-domain.js';
import {
  assembleReadingPilotCatalog,
  loadReadingPilotCatalog,
  loadReadingTask10Shard,
  loadReadingTask11Shard,
  loadReadingTask12Shard,
} from '../public/reading-pilot-v1.js';
import {
  LISTENING_INTERVIEW_SETS,
  LISTENING_MATCHING_SETS,
  LISTENING_TRUE_FALSE_SETS,
} from '../public/listening-pilot-v1.js';
import {
  GRAMMAR_PRACTICE_MODES,
  isGrammarErrorCode,
  parseGrammarConfusionPair,
} from '../public/grammar-domain-contract.js';

const [
  recorderFile,
  ownerIncarnationFile,
  syncFile,
  readingModuleFile,
  readingScreenFile,
  listeningModuleFile,
  listeningScreenFile,
] = await Promise.all([
  fs.readFile(new URL('../public/learning-activity-recorder.js', import.meta.url), 'utf8'),
  fs.readFile(new URL('../public/owner-incarnation.js', import.meta.url), 'utf8'),
  fs.readFile(new URL('../public/sync.js', import.meta.url), 'utf8'),
  fs.readFile(new URL('../public/modules/reading.js', import.meta.url), 'utf8'),
  fs.readFile(new URL('../public/screens/reading.js', import.meta.url), 'utf8'),
  fs.readFile(new URL('../public/modules/listening.js', import.meta.url), 'utf8'),
  fs.readFile(new URL('../public/screens/listening.js', import.meta.url), 'utf8'),
]);

const recorderSource = recorderFile
  .replace(/^import\s*\{[\s\S]*?\}\s*from\s*'\.\/adaptive-session-runtime\.js';\r?\n/mu, '')
  .replace(/^import .*;\r?\n/gmu, '')
  .replace(/^export /gmu, '')
  .concat('\nwindow.__learningActivityRecorderTest={createLearningActivityEvidence,recordCompletedLearningActivity,recordLearningActivityEvidence};');
const readingModuleSource = readingModuleFile.replace(/^import[\s\S]*?from ['"][^'"]+['"];\r?\n/gmu, '');
const listeningModuleSource = listeningModuleFile.replace(/^import .*;\r?\n/mu, '');
const readingPilotCatalog = await loadReadingPilotCatalog();

function executableScreen(source, exposed) {
  return source
    .replace(/^import(?:[\s\S]*?)from '[^']+';\r?\n/gmu, '')
    .replace(/^export \{[\s\S]*?\};\r?\n?/mu, '')
    .concat(exposed);
}

function elementStore() {
  const elements = new Map();
  let created = 0;
  function element(id) {
    if (!elements.has(id)) {
      elements.set(id, {
        id,
        innerHTML: '',
        textContent: '',
        value: '',
        style: {},
        dataset: {},
        children: [],
        firstChild: null,
        setAttribute() {},
        addEventListener() {},
        focus() {},
        classList: { contains() { return true; }, add() {}, remove() {} },
        appendChild(child) { this.children.push(child); },
        insertBefore(child) { this.children.unshift(child); },
        scrollIntoView() {},
        querySelector() { return element(`${id}:child`); },
        querySelectorAll() { return []; },
      });
    }
    return elements.get(id);
  }
  return {
    element,
    document: {
      getElementById: element,
      querySelector() { return element('query'); },
      createElement() { created += 1; return element(`created:${created}`); },
    },
  };
}

function createSubjectHarness(subject, {
  offline = false,
  slow = false,
  listeningAudioStatus = 'static',
  generateAiContentImpl = null,
  apiGetImpl = null,
  readingCatalogLoader = null,
  listeningCatalogLoaders = null,
  verifyLearningAccessImpl = null,
  preinstallCatalogs = true,
  server = false,
  deferTimers = false,
} = {}) {
  let now = 10_000;
  let intervalSequence = 0;
  let stopCalls = 0;
  const intervals = new Map();
  let active = null;
  let activeOwner = { username: 'learner-a', generation: 0 };
  let uuid = 100;
  const ordinary = [];
  const adaptive = [];
  const posts = [];
  const voiceResults = [];
  const staticPlays = [];
  const invalidations = [];
  const routeHooks = [];
  const authorityResetHooks = [];
  const values = new Map();
  const navigator = { onLine: !offline, locks: {
    request(_name, _options, callback) { return Promise.resolve(callback({ name: 'owner-incarnation' })); },
  } };
  const localStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
  const { element, document } = elementStore();
  class TestDate extends Date {
    static now() { return now; }
  }
  const window = {
    localStorage,
    navigator,
    __sub: { authenticated: true, active: true, username: activeOwner.username },
    addEventListener() {},
    EasyBoostApi: {
      async post(path, body) {
        posts.push({ path, body: JSON.parse(JSON.stringify(body)) });
        return { ok: true };
      },
    },
  };
  const S = subject === 'reading'
    ? { read: { h: { ok: 0, tot: 0 }, q: { ok: 0, tot: 0 }, g: { ok: 0, tot: 0 }, texts: 0 } }
    : { lis: { m: { ok: 0, tot: 0 }, tf: { ok: 0, tot: 0 }, iq: { ok: 0, tot: 0 }, done: 0 } };
  const context = vm.createContext({
    window,
    localStorage,
    navigator,
    EasyBoostApi: window.EasyBoostApi,
    readingActivityId,
    listeningActivityId,
    learningActivityPool,
    learningActivitySource,
    splitLearningActivityDuration,
    assertReadingCatalog,
    loadReadingCatalog,
    parseReadingAdaptiveContentRef,
    readingAdaptiveContentRef,
    readingLearningActivityContract,
    readingSourceContext,
    readingSourceContextFromSets,
    readingSetForLegacyScreen,
    readingSetForVoiceTutor,
    READING_CATALOG_ID,
    READING_CATALOG_REVISION,
    READING_FULL_ATTEMPT_VERSION,
    READING_KINDS,
    READING_KIND_RULES,
    assertReadingSet,
    readingSetReference,
    adaptLegacyReadingFallback,
    assembleReadingPilotCatalog,
    loadReadingPilotCatalog,
    loadReadingTask10Shard,
    loadReadingTask11Shard,
    loadReadingTask12Shard,
    LISTENING_MATCHING_SETS,
    LISTENING_INTERVIEW_SETS,
    LISTENING_TRUE_FALSE_SETS,
    interviewSetForLegacyScreen,
    loadInterviewCatalog: listeningCatalogLoaders?.interview || loadInterviewCatalog,
    loadMatchingCatalog: listeningCatalogLoaders?.matching || loadMatchingCatalog,
    loadTrueFalseCatalog: listeningCatalogLoaders?.trueFalse || loadTrueFalseCatalog,
    matchingSetForLegacyScreen,
    trueFalseSetForLegacyScreen,
    loadAdaptiveSessionRuntime: async () => ({
      adaptiveRuntimeSnapshot: () => ({ active }),
      completeAdaptiveModuleActivity: async (completion) => {
        adaptive.push(JSON.parse(JSON.stringify(completion)));
        return { execution: { revision: 2 } };
      },
    }),
    S,
    currentUser: activeOwner.username,
    PILOT_CATALOG: readingPilotCatalog,
    SRV: server,
    TOKEN: server ? 'test-token' : '',
    WBTN: 'background:#fff;color:#2B2B2B;border:1px solid #F0EAE2;',
    EGE_WORDS: [],
    LSLOW: slow,
    L_PLAYSVG: '',
    document,
    crypto: { randomUUID: () => `10000000-0000-4000-8000-${String(++uuid).padStart(12, '0')}` },
    Date: TestDate,
    Math,
    JSON,
    Object,
    Number,
    String,
    Boolean,
    Array,
    Set,
    Promise,
    RegExp,
    Error,
    TypeError,
    console,
    setInterval: (callback) => { const id = ++intervalSequence; intervals.set(id, callback); return id; },
    clearInterval: (id) => { intervals.delete(id); },
    setTimeout: (callback) => { if (!deferTimers) callback(); return 1; },
    clearTimeout() {},
    queueMicrotask: (callback) => callback(),
    matchMedia: () => ({ matches: false }),
    registerRouteHook(callback) { routeHooks.push(callback); },
    registerAuthorityReset(callback) { authorityResetHooks.push(callback); },
    registerScreenGenerator() {},
    currentOwnerBinding: () => ({ ...activeOwner }),
    apiGet: (...args) => (apiGetImpl ? apiGetImpl(...args) : Promise.reject(new Error('Unexpected Reading report request'))),
    apiResponseOwner: (payload) => payload?.__owner || '',
    apiIsAuthorityFailure: () => false,
    invalidateLearningAuthority: async (authority) => { invalidations.push({ ...authority }); },
    verifyLearningAccessForLaunch: (...args) => verifyLearningAccessImpl ? verifyLearningAccessImpl(...args) : Promise.resolve(true),
    prepareVoiceTutorContextResult: ({ module, set, selections }) => ({
      module,
      setId: set.voice.id,
      revision: set.voice.revision,
      answers: set.qs.map((question, index) => question.o[selections[index]]),
      resultSlot(question, index) {
        return selections[index] === question.a ? '' : `<div data-voice-item="${question.voice.id}"></div>`;
      },
    }),
    registerVoiceTutorContextResult: async (result) => { voiceResults.push(result); return result; },
    generateAiContent: (...args) => (generateAiContentImpl ? generateAiContentImpl(...args) : Promise.resolve(null)),
    save() {},
    setTxt() {},
    toast() {},
    ui: { animate() {}, markAnswer() {} },
    wDeco: () => '',
    rWordsHtml: (value) => String(value),
    rEsc: (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;'),
    rSync() {},
    wSync() {},
    wBase: (value) => value,
    normalizeVocabularyWord,
    personalVocabularyCardId,
    upsertReadingVocabularyCard,
    GRAMMAR_PRACTICE_MODES,
    isGrammarErrorCode,
    parseGrammarConfusionPair,
    srsRecordVocabularyOutcome() {},
    lSync() {},
    lSetSlow() {},
    lPlayRaw() {},
    lPlayListeningSet(set, lines, onStatus) {
      staticPlays.push({ setId: set?.id || null, lines: lines.length });
      if (typeof onStatus === 'function') onStatus(listeningAudioStatus);
      return Promise.resolve(listeningAudioStatus === 'static');
    },
    lPause() { return true; },
    lResume() { return Promise.resolve(true); },
    lStop() { stopCalls += 1; },
    examModule: {
      elapsedSeconds: (startedAt, endedAt) => Math.floor((endedAt - startedAt) / 1_000),
      record: (record, score) => ({
        ...(record || {}),
        n: Number(record?.n || 0) + 1,
        last: score,
        best: Math.max(Number(record?.best || 0), score),
      }),
      maxScore: (parts) => parts.reduce((sum, part) => sum + part[2], 0),
      weakestSection: (parts) => ({ label: parts[0][0] }),
      badge: () => '',
      sectionLine: () => '',
    },
    gExamFmt: (seconds) => String(seconds),
  });

  if (offline) {
    vm.runInContext(ownerIncarnationFile, context);
    vm.runInContext(syncFile, context);
    window.EasyBoostSync.setOwner('learner-a');
  } else {
    window.EasyBoostSync = {
      currentOwnerBinding() { return { ...activeOwner }; },
      async saveModuleAttempt(attempt) {
        ordinary.push(JSON.parse(JSON.stringify(attempt)));
        return true;
      },
    };
  }
  vm.runInContext(recorderSource, context);
  context.recordCompletedLearningActivity = window.__learningActivityRecorderTest.recordCompletedLearningActivity;
  context.createLearningActivityEvidence = window.__learningActivityRecorderTest.createLearningActivityEvidence;
  context.recordLearningActivityEvidence = window.__learningActivityRecorderTest.recordLearningActivityEvidence;

  if (subject === 'reading') {
    context.rSt = () => S.read;
    vm.runInContext(readingModuleSource, context);
    context.readingModule = readingCatalogLoader
      ? { ...window.EasyBoostReading, loadPilotCatalog: readingCatalogLoader }
      : window.EasyBoostReading;
    vm.runInContext(executableScreen(readingScreenFile, `
      var __readingQuestionIndex=0;
      window.__subjectEvidenceTest={
        installCatalog:function(){catalog=PILOT_CATALOG},
        init:initReading,
        hub:rHub,
        loadReport:loadReadingReport,
        invalidateView:function(){readingViewGeneration+=1;reportRequestId+=1},
        startAdaptive:function(kind,cefr,contentRef){return launchReadingPractice(kind,cefr,contentRef)},
        currentContract:function(){return training&&readingModule.learningContract(training.set)},
        currentOwner:function(){return training&&training.authority.username},
        startHeadings:function(){return rHl()},
        completeHeadings:function(correct){training.answers=training.set.task.answers.map(function(answer){return correct===false?(answer+1)%training.set.task.headings.length:answer});submitTraining()},
        startQuestions:function(){__readingQuestionIndex=0;return rQs()},
        answerQuestion:function(correct){if(!training||__readingQuestionIndex>=training.set.task.questions.length)return false;
          var question=training.set.task.questions[__readingQuestionIndex];training.answers[__readingQuestionIndex]=correct===false?(question.answer+1)%question.options.length:question.answer;
          __readingQuestionIndex+=1;if(__readingQuestionIndex===training.answers.length)submitTraining();return true},
        startGaps:function(){return rGp()},
        completeGaps:function(correct){training.answers=training.set.task.answers.map(function(answer){return correct===false?(answer+1)%training.set.task.fragments.length:answer});submitTraining()},
        startExam:rExamStart,
        completeExam:function(){KINDS.forEach(function(kind){var set=full.attempt.section.sets[kind];full.attempt.answers[kind]=kind==='task12_18'?set.task.questions.map(function(question){return question.answer}):set.task.answers.slice()});confirmFullSubmit()},
      };
    `), context);
    if (preinstallCatalogs) window.__subjectEvidenceTest.installCatalog();
  } else {
    context.lSt = () => S.lis;
    vm.runInContext(listeningModuleSource, context);
    context.listeningModule = window.EasyBoostListening;
    vm.runInContext(executableScreen(listeningScreenFile, `
      window.__subjectEvidenceTest={
        init:initListening,
        generateDialog:genListening,
        generateBackground:lGen,
        invalidateView:function(){L_VIEW_GENERATION+=1;L_AI_GENERATION+=1},
        dialog:function(){return LIS},
        ai:function(){return S.lisAi},
        startMatching:lMt,
        installMatchingCatalog:function(sets){lSetMatchingCatalog(sets||LISTENING_MATCHING_SETS)},
        installTrueFalseCatalog:function(sets){lSetTrueFalseCatalog(sets||LISTENING_TRUE_FALSE_SETS)},
        installInterviewCatalog:function(sets){lSetInterviewCatalog(sets||LISTENING_INTERVIEW_SETS)},
        currentSetIds:function(){return {matching:LM&&LM.set.id,trueFalse:LT&&LT.set.id,interview:LI&&LI.set.id,
          exam:LE&&{matching:LE.m.id,trueFalse:LE.tf.id,interview:LE.iq.id}}},
        playMatching:function(){lPlay(lMtLines())},
        completeMatching:function(correct){LM.set.a.forEach(function(answer,index){lMtPick(index,correct===false?(answer+1)%LM.set.st.length:answer)});lMtCheck()},
        nextMatching:lMtNext,
        startTrueFalse:lTf,
        playTrueFalse:function(){lPlay(LT.set.d)},
        completeTrueFalse:function(correct){LT.set.st.forEach(function(item,index){lTfPick(index,correct===false?(item.a+1)%3:item.a)});lTfCheck()},
        nextTrueFalse:lTfNext,
        startInterview:lIq,
        playInterview:function(){lPlay(LI.set.d)},
        completeInterview:function(correct){LI.set.qs.forEach(function(item,index){lIqPick(index,correct===false?(item.a+1)%item.o.length:item.a)});lIqCheck()},
        nextInterview:lIqNext,
        startExam:lExamStart,
        hub:lHub,
        resumeExam:lExamResume,
        examState:function(){return LE&&{stage:LE.stage,t0:LE.t0,pausedAt:LE.pausedAt,interval:LE.iv,selections:LE.selM.slice(),plays:LE.plays.slice()}},
        showExamInterview:function(){LE.stage=2;lExamRender()},
        firstExamInterviewExplanation:function(){return LE.iq.qs[0].e},
        completeExam:function(interviewCorrect){LE.m.a.forEach(function(answer,index){LE.selM[index]=answer;lExamDedup('selM',index,answer)});
          LE.tf.st.forEach(function(item,index){LE.selT[index]=item.a});LE.iq.qs.forEach(function(item,index){LE.selI[index]=interviewCorrect===false?(item.a+1)%item.o.length:item.a});lExamFinish()},
        finishExam:lExamFinish,
        restartExam:lExamRestart,
      };
    `), context);
    if (preinstallCatalogs) {
      window.__subjectEvidenceTest.installMatchingCatalog();
      window.__subjectEvidenceTest.installTrueFalseCatalog();
      window.__subjectEvidenceTest.installInterviewCatalog();
    }
  }

  return {
    screen: window.__subjectEvidenceTest,
    element,
    ordinary,
    adaptive,
    posts,
    voiceResults,
    staticPlays,
    invalidations,
    values,
    navigator,
    sync: window.EasyBoostSync,
    state: S,
    intervals,
    stopCount: () => stopCalls,
    advance(milliseconds) { now += milliseconds; },
    setActive(value) { active = value; },
    setOwner(username, generation) {
      activeOwner = { username, generation };
      context.currentUser = username;
      window.__sub = { ...window.__sub, username };
    },
    navigate(id) { routeHooks.forEach((hook) => hook(id)); },
    resetAuthority(authority) { authorityResetHooks.forEach((hook) => hook(authority)); },
  };
}

async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test('Reading submit, finish and explicit next seams are idempotent', async () => {
  const harness = createSubjectHarness('reading');

  const firstLaunch = harness.screen.startHeadings();
  const duplicateLaunch = harness.screen.startHeadings();
  assert.equal(await duplicateLaunch, false, 'a second Next cannot replace an in-flight launch');
  assert.equal(await firstLaunch, true);
  harness.screen.completeHeadings(true);
  harness.screen.completeHeadings(true);
  await settle();
  assert.equal(harness.ordinary.length, 1, 'double submit records one ordinary attempt');

  await harness.screen.startExam();
  harness.screen.completeExam();
  harness.screen.completeExam();
  await settle();
  assert.equal(harness.ordinary.length, 3, 'double finish records exactly gist plus detail once');
});

test('a stale owner launch cannot clear the replacement owner launch lock', async () => {
  const ownerA = deferred(), ownerB = deferred();let accessCalls = 0;
  const harness = createSubjectHarness('reading', {
    verifyLearningAccessImpl: () => (++accessCalls === 1 ? ownerA.promise : ownerB.promise),
  });

  const staleA = harness.screen.startHeadings();
  harness.resetAuthority({ owner: 'learner-a', ownerGeneration: 0 });
  harness.setOwner('learner-b', 1);
  const currentB = harness.screen.startHeadings();
  assert.equal(await harness.screen.startHeadings(), false, 'a second B launch is blocked while B access is pending');

  ownerA.resolve(true);assert.equal(await staleA, false, 'late A access cannot create owner B practice');
  assert.equal(await harness.screen.startHeadings(), false, 'A finally cannot clear B launch ownership');
  ownerB.resolve(true);assert.equal(await currentB, true);
  assert.equal(harness.screen.currentOwner(), 'learner-b');
  assert.equal(accessCalls, 2, 'exactly one access launch runs for each owner');
});

test('Listening submit, finish and explicit next seams are idempotent', async () => {
  const harness = createSubjectHarness('listening');

  harness.screen.startMatching();
  harness.screen.completeMatching(true);
  harness.screen.completeMatching(true);
  await settle();
  assert.equal(harness.ordinary.length, 1, 'double ordinary submit records once');
  assert.equal(harness.screen.nextMatching(), true);
  const afterNext = harness.screen.currentSetIds().matching;
  assert.equal(harness.screen.nextMatching(), false, 'the replacement session rejects a second Next');
  assert.equal(harness.screen.currentSetIds().matching, afterNext);

  harness.screen.startExam();
  harness.screen.completeExam(true);
  harness.screen.finishExam();
  await settle();
  assert.equal(harness.ordinary.length, 3, 'double exam finish records exactly gist plus detail once');
  assert.equal(harness.state.lisExam.n, 1);
  assert.equal(harness.screen.restartExam(), true);
  assert.equal(harness.screen.restartExam(), false, 'a second restart cannot replace the new exam');
  assert.equal(harness.state.lisExam.n, 1);
});

test('Listening hub pauses an exact exam and resume excludes hub time', () => {
  const harness = createSubjectHarness('listening');
  harness.screen.startExam();
  const before = harness.screen.examState();
  assert.equal(harness.intervals.size, 1);

  harness.advance(2_000);
  harness.screen.hub();
  const paused = harness.screen.examState();
  assert.equal(paused.stage, before.stage);
  assert.deepEqual(paused.selections, before.selections);
  assert.deepEqual(paused.plays, before.plays);
  assert.equal(paused.pausedAt, 12_000);
  assert.equal(paused.interval, null);
  assert.equal(harness.intervals.size, 0);

  harness.advance(5_000);
  assert.equal(harness.screen.resumeExam(), true);
  const resumed = harness.screen.examState();
  assert.equal(resumed.t0, before.t0 + 5_000, 'hub time is excluded from elapsed exam time');
  assert.equal(resumed.pausedAt, null);
  assert.notEqual(resumed.interval, null);
  assert.deepEqual(resumed.selections, before.selections);
  assert.deepEqual(resumed.plays, before.plays);
  assert.equal(harness.intervals.size, 1);
});

test('Listening catalog retry replaces rejected loader promises and recovers', async () => {
  const calls = { matching: 0, trueFalse: 0, interview: 0 };
  function retrying(key, value) {
    return () => {
      calls[key] += 1;
      return calls[key] === 1 ? Promise.reject(new Error(`${key} unavailable`)) : Promise.resolve(value);
    };
  }
  const harness = createSubjectHarness('listening', {
    preinstallCatalogs: false,
    listeningCatalogLoaders: {
      matching: retrying('matching', LISTENING_MATCHING_SETS),
      trueFalse: retrying('trueFalse', LISTENING_TRUE_FALSE_SETS),
      interview: retrying('interview', LISTENING_INTERVIEW_SETS),
    },
  });

  harness.screen.init();
  await settle();
  await settle();
  assert.match(harness.element('l_area').innerHTML, /Каталог аудирования недоступен/u);
  harness.screen.init();
  await settle();
  await settle();
  assert.match(harness.element('l_area').innerHTML, /Каталог аудирования/u);
  assert.deepEqual(calls, { matching: 2, trueFalse: 2, interview: 2 });
});

test('Listening answer rerender stops active transport and escapes catalog markup', () => {
  const harness = createSubjectHarness('listening');
  const hostile = JSON.parse(JSON.stringify(LISTENING_MATCHING_SETS));
  hostile[0].task.statements[0] = '<img src=x onerror=alert(1)>';
  hostile[0].task.evidence[0].explanationRu = '<script>alert(2)</script> Русское объяснение.';
  harness.screen.installMatchingCatalog([hostile[0]]);
  harness.screen.startMatching();
  const markup = harness.element('l_area').innerHTML;
  assert.doesNotMatch(markup, /<img|<script/u);
  assert.match(markup, /&lt;img/u);

  const stopsBefore = harness.stopCount();
  harness.screen.playMatching();
  harness.screen.completeMatching(true);
  assert.ok(harness.stopCount() > stopsBefore, 'answer-driven rerender must not leave hidden audio playing');
});

test('late Reading catalog and report responses from owner A cannot render for owner B', async () => {
  const catalogWork = deferred();
  const reportWork = deferred();
  const requests = [];
  const catalogHarness = createSubjectHarness('reading', {
    preinstallCatalogs: false,
    readingCatalogLoader: () => catalogWork.promise,
  });

  const loading = catalogHarness.screen.init();
  assert.match(catalogHarness.element('r_area').innerHTML, /Каталог загружается/u);
  catalogHarness.setOwner('learner-b', 1);
  catalogWork.resolve(readingPilotCatalog);
  await loading;
  assert.doesNotMatch(catalogHarness.element('r_area').innerHTML, /Каталог чтения/u);

  const reportHarness = createSubjectHarness('reading', {
    apiGetImpl: (path, options) => {
      requests.push({ path, options });
      return reportWork.promise;
    },
  });
  reportHarness.screen.hub();
  await settle();
  const reportShell = reportHarness.element('r_area:child');
  const loadingReport = reportShell.innerHTML;
  assert.match(loadingReport, /Обновляем отчёт/u);
  assert.equal(requests[0].options.headers['X-EasyBoost-Expected-Owner'], 'learner-a');
  reportHarness.setOwner('learner-b', 1);
  reportWork.resolve({ __owner: 'learner-a' });
  await settle();
  assert.equal(reportShell.innerHTML, loadingReport, 'owner A report cannot replace owner B view');
});

test('late Listening catalogs and AI generation from owner A cannot render or write for owner B', async () => {
  const matchingWork = deferred();
  const trueFalseWork = deferred();
  const interviewWork = deferred();
  const catalogHarness = createSubjectHarness('listening', {
    preinstallCatalogs: false,
    listeningCatalogLoaders: {
      matching: () => matchingWork.promise,
      trueFalse: () => trueFalseWork.promise,
      interview: () => interviewWork.promise,
    },
  });
  catalogHarness.screen.init();
  const loadingMarkup = catalogHarness.element('l_area').innerHTML;
  catalogHarness.setOwner('learner-b', 1);
  matchingWork.resolve(LISTENING_MATCHING_SETS);
  trueFalseWork.resolve(LISTENING_TRUE_FALSE_SETS);
  interviewWork.resolve(LISTENING_INTERVIEW_SETS);
  await settle();
  await settle();
  assert.equal(catalogHarness.element('l_area').innerHTML, loadingMarkup);

  const dialogWork = deferred();
  const dialogRequests = [];
  const dialogHarness = createSubjectHarness('listening', {
    generateAiContentImpl: (operation, body, headers) => {
      dialogRequests.push({ operation, body, headers });
      return dialogWork.promise;
    },
  });
  const originalDialog = JSON.stringify(dialogHarness.screen.dialog());
  const dialogPromise = dialogHarness.screen.generateDialog();
  dialogHarness.setOwner('learner-b', 1);
  dialogWork.resolve({
    __owner: 'learner-a', title: 'Late A', dialog: 'late owner A dialog',
    q1: { q: 'one', o: ['a'], a: 0 }, q2: { q: 'two', o: ['b'], a: 0 },
  });
  assert.equal(await dialogPromise, false);
  assert.equal(JSON.stringify(dialogHarness.screen.dialog()), originalDialog);
  assert.equal(dialogRequests[0].headers['X-EasyBoost-Expected-Owner'], 'learner-a');

  const backgroundWork = deferred();
  const backgroundHarness = createSubjectHarness('listening', {
    preinstallCatalogs: false,
    server: true,
    generateAiContentImpl: () => backgroundWork.promise,
  });
  const backgroundPromise = backgroundHarness.screen.generateBackground();
  backgroundHarness.setOwner('learner-b', 1);
  backgroundWork.resolve({
    __owner: 'learner-a',
    st: ['one', 'two', 'three', 'four', 'five'],
    sp: [{ t: 'a' }, { t: 'b' }, { t: 'c' }, { t: 'd' }],
    a: [0, 1, 2, 3], k: ['a', 'b', 'c', 'd'],
  });
  await backgroundPromise;
  assert.equal(JSON.stringify(backgroundHarness.screen.ai()), JSON.stringify({ m: [], tf: [], iq: [] }));
});

test('a stale Listening generator cannot keep a re-entered owner dormant or clear its run', async () => {
  const ownerA = deferred();
  let requestCount = 0;
  const generated = (owner, label) => ({
    __owner: owner,
    st: [`${label} one`, `${label} two`, `${label} three`, `${label} four`, `${label} five`],
    sp: [{ t: `${label} a` }, { t: `${label} b` }, { t: `${label} c` }, { t: `${label} d` }],
    a: [0, 1, 2, 3], k: ['Русское объяснение а', 'Русское объяснение б', 'Русское объяснение в', 'Русское объяснение г'],
  });
  const harness = createSubjectHarness('listening', {
    preinstallCatalogs: false,
    server: true,
    deferTimers: true,
    generateAiContentImpl: () => {
      requestCount += 1;
      return requestCount === 1 ? ownerA.promise : Promise.resolve(generated('learner-b', 'B'));
    },
  });

  const staleRun = harness.screen.generateBackground();
  harness.navigate('scr1');
  harness.setOwner('learner-b', 1);
  const currentRun = harness.screen.generateBackground();
  await currentRun;
  assert.equal(requestCount, 2, 'owner B starts immediately while owner A generation is pending');
  assert.equal(harness.screen.ai().m.length, 1);
  assert.equal(harness.screen.ai().m[0].st[0], 'B one');

  ownerA.resolve(generated('learner-a', 'A'));
  await staleRun;
  assert.equal(harness.screen.ai().m.length, 1, 'late owner A completion cannot write or clear owner B run state');
  assert.equal(harness.screen.ai().m[0].st[0], 'B one');
});

test('reading screen completions record headings, questions, gaps and distinct combined-exam slices', async () => {
  const harness = createSubjectHarness('reading');

  await harness.screen.startHeadings();
  harness.advance(400);
  harness.screen.completeHeadings(true);
  await harness.screen.startQuestions();
  harness.advance(700);
  while (harness.screen.answerQuestion(true)) {}
  await harness.screen.startGaps();
  harness.advance(300);
  harness.screen.completeGaps(true);
  await harness.screen.startExam();
  harness.advance(1_001);
  harness.screen.completeExam();
  await settle();

  assert.deepEqual(harness.ordinary.map(({ activity, score, maxScore, durationMs }) => (
    { activity, score, maxScore, durationMs }
  )), [
    { activity: 'reading_headings', score: 7, maxScore: 7, durationMs: 400 },
    { activity: 'reading_detail', score: 7, maxScore: 7, durationMs: 700 },
    { activity: 'reading_gaps', score: 6, maxScore: 6, durationMs: 300 },
    { activity: 'reading_headings', score: 7, maxScore: 7, durationMs: 350 },
    { activity: 'reading_detail', score: 13, maxScore: 13, durationMs: 651 },
  ]);
  for (const [index, attempt] of harness.ordinary.entries()) {
    assert.equal(attempt.metadata.source, 'catalog');
    assert.equal(attempt.metadata.readingProvenance, 'canonical');
    assert.equal(typeof attempt.metadata.readingAttemptId, 'string');
    assert.equal(attempt.metadata.readingSetRevision, 1);
    if (index < 3) assert.equal(attempt.metadata.readingSetId.startsWith('reading-pilot-v1.'), true);
  }
  assert.deepEqual(harness.ordinary.slice(0, 3).map((attempt) => (
    [attempt.metadata.readingKind, attempt.metadata.mode, attempt.metadata.readingSlice]
  )), [
    ['task10', 'reading_headings', 'gist'],
    ['task12_18', 'reading_detail', 'detail'],
    ['task11', 'reading_gaps', 'detail'],
  ]);
  assert.equal(harness.ordinary[3].metadata.readingSlice, 'gist');
  assert.equal(harness.ordinary[4].metadata.readingSlice, 'detail');
  assert.equal(harness.ordinary[3].metadata.readingAttemptId, harness.ordinary[4].metadata.readingAttemptId);
  assert.equal(harness.ordinary[4].metadata.readingSetRefs.split('|').length, 2);
  assert.equal(new Set(harness.ordinary.map((attempt) => attempt.id)).size, 5);
  assert.equal(harness.ordinary.slice(-2).reduce((sum, attempt) => sum + attempt.durationMs, 0), 1_001);
  assert.equal(harness.voiceResults.length, 6, 'three separate results and all three full-section sets are registered');
});

test('reading exact adaptive completion uses only the claim path and a mismatch fails closed', async () => {
  const harness = createSubjectHarness('reading');
  await harness.screen.startAdaptive('task10', 'B1', 'builtin:reading:task10:b1:v1');
  const contract = harness.screen.currentContract();
  assert.equal(contract.kind, 'task10');
  assert.equal(contract.cefr, 'B1');
  harness.setActive({
    module: 'reading', activityId: 'reading_headings', contentRef: contract.contentRef,
    executionClaim: 'a'.repeat(43),
  });
  harness.advance(250);
  harness.screen.completeHeadings(true);
  await settle();

  assert.deepEqual(harness.adaptive.map((item) => ({
    ...item, metadata: { ...item.metadata, readingSetId: '<canonical>' },
  })), [{
    module: 'reading', activityId: 'reading_headings', score: 7, maxScore: 7, durationMs: 250,
    metadata: {
      mode: 'reading_headings', source: 'catalog', helpUsed: false, hintsUsed: 0,
      readingProvenance: 'canonical', readingSetId: '<canonical>', readingSetRevision: 1,
      readingKind: 'task10', readingCefr: 'B1', readingContentRef: contract.contentRef,
      readingAttemptId: harness.adaptive[0].metadata.readingAttemptId, readingSlice: 'gist',
      readingIndependent: true,
    },
  }]);
  assert.equal(harness.ordinary.length, 0);

  harness.setActive({
    module: 'reading', activityId: 'reading_detail', contentRef: 'builtin:reading:task12_18:b1:v1',
    executionClaim: 'b'.repeat(43),
  });
  await harness.screen.startGaps();
  harness.advance(100);
  harness.screen.completeGaps(true);
  await settle();
  assert.equal(harness.adaptive.length, 1);
  assert.equal(harness.ordinary.length, 0);
});

test('listening screen completions record matching, true-false, interview and distinct exam slices', async () => {
  const harness = createSubjectHarness('listening');

  harness.screen.startMatching();
  harness.advance(400);
  harness.screen.completeMatching(true);
  harness.screen.startTrueFalse();
  harness.advance(500);
  harness.screen.completeTrueFalse(true);
  harness.screen.startInterview();
  harness.advance(600);
  harness.screen.completeInterview(true);
  harness.screen.startExam();
  harness.advance(1_001);
  harness.screen.completeExam();
  await settle();

  assert.deepEqual(harness.ordinary.map(({ activity, score, maxScore, durationMs }) => (
    { activity, score, maxScore, durationMs }
  )), [
    { activity: 'listening_matching', score: 6, maxScore: 6, durationMs: 400 },
    { activity: 'listening_true_false', score: 7, maxScore: 7, durationMs: 500 },
    { activity: 'listening_interview', score: 7, maxScore: 7, durationMs: 600 },
    { activity: 'listening_matching', score: 6, maxScore: 6, durationMs: 300 },
    { activity: 'listening_detail', score: 14, maxScore: 14, durationMs: 701 },
  ]);
  assert.deepEqual(harness.ordinary.map((attempt) => attempt.metadata.mode), [
    'listening_matching', 'listening_true_false', 'listening_interview',
    'listening_exam', 'listening_exam',
  ]);
  assert.equal(harness.ordinary.every((attempt) => attempt.metadata.source === 'builtin'), true);
  assert.equal(harness.ordinary.every((attempt) => attempt.metadata.helpUsed === false), true);
  assert.equal(harness.ordinary.slice(-2).reduce((sum, attempt) => sum + attempt.durationMs, 0), 1_001);
});

test('matching screen renders six speakers and keeps the transcript and explanations behind checking', async () => {
  const harness = createSubjectHarness('listening');

  harness.screen.startMatching();
  const exercise = harness.element('l_area').innerHTML;
  assert.match(exercise, /Сначала прочитай утверждения/u);
  assert.equal((exercise.match(/<h2>Говорящий [A-F]<\/h2>/gu) || []).length, 6);
  assert.doesNotMatch(exercise, /ТРАНСКРИПТ|<b>Ключ:<\/b>/u);

  harness.screen.completeMatching(true);
  await settle();

  assert.match(harness.element('l_area').innerHTML, /Транскрипт/u);
  assert.match(harness.element('l_area').innerHTML, /Правильный ответ/u);
  assert.deepEqual(harness.ordinary.map(({ activity, score, maxScore }) => ({ activity, score, maxScore })), [
    { activity: 'listening_matching', score: 6, maxScore: 6 },
  ]);
});

test('true-false screen renders seven statements and reveals auditable answers only after checking', async () => {
  const harness = createSubjectHarness('listening');

  harness.screen.startTrueFalse();
  const exercise = harness.element('l_area').innerHTML;
  assert.equal((exercise.match(/id="ltf_row_\d+"/gu) || []).length, 7);
  assert.doesNotMatch(exercise, /ТРАНСКРИПТ|<b>В записи:<\/b>/u);

  harness.advance(700);
  harness.screen.completeTrueFalse(true);
  await settle();

  assert.match(harness.element('l_area').innerHTML, /Транскрипт/u);
  assert.match(harness.element('l_area').innerHTML, /В записи:/u);
  assert.deepEqual(harness.ordinary.map(({ activity, score, maxScore }) => ({ activity, score, maxScore })), [
    { activity: 'listening_true_false', score: 7, maxScore: 7 },
  ]);
});

test('listening screen identifies the synthesized fallback and sends catalog sets to static playback', () => {
  const harness = createSubjectHarness('listening');

  harness.screen.startTrueFalse();
  assert.match(harness.element('l_area').innerHTML, /Источник определится при запуске/u);
  harness.screen.playTrueFalse();

  assert.deepEqual(harness.staticPlays, [{
    setId: LISTENING_TRUE_FALSE_SETS[0].id,
    lines: LISTENING_TRUE_FALSE_SETS[0].script.length,
  }]);
});

test('interview screen uses seven four-option questions and publishes wrong answers for voice tutor', async () => {
  const harness = createSubjectHarness('listening');

  harness.screen.startInterview();
  const exercise = harness.element('l_area').innerHTML;
  assert.equal((exercise.match(/id="liq_row_\d+"/gu) || []).length, 7);
  assert.equal((exercise.match(/onclick="lIqPick\(\d+,\d+\)"/gu) || []).length, 28);
  assert.match(exercise, />3\./u);
  assert.match(exercise, />9\./u);
  assert.doesNotMatch(exercise, /ТРАНСКРИПТ|data-voice-item/iu);

  harness.advance(750);
  harness.screen.completeInterview(false);
  await settle();

  assert.match(harness.element('l_area').innerHTML, /Транскрипт/u);
  assert.match(harness.element('l_area').innerHTML, /data-voice-item="listening-pilot-v1\.interview\./u);
  assert.equal(harness.voiceResults.length, 1);
  assert.match(harness.voiceResults[0].setId, /^listening-pilot-v1\.interview\./u);
  assert.equal(harness.voiceResults[0].answers.length, 7);
  assert.deepEqual(harness.ordinary.map(({ activity, maxScore }) => ({ activity, maxScore })), [
    { activity: 'listening_interview', maxScore: 7 },
  ]);
});

test('combined exam numbers interview tasks 3–9 and keeps the Russian explanation in its review', async () => {
  const harness = createSubjectHarness('listening');

  harness.screen.startExam();
  harness.screen.showExamInterview();
  const exercise = harness.element('l_area').innerHTML;
  assert.match(exercise, />3\./u);
  assert.match(exercise, />9\./u);
  const explanation = harness.screen.firstExamInterviewExplanation();

  harness.screen.completeExam(false);
  await settle();

  assert.match(harness.element('l_area').innerHTML, new RegExp(explanation.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
});

test('matching adaptive completion publishes one gist result and no duplicate ordinary attempt', async () => {
  const harness = createSubjectHarness('listening');
  harness.setActive({
    module: 'listening', activityId: 'listening_matching', executionClaim: 'm'.repeat(43),
  });

  harness.screen.startMatching();
  harness.advance(350);
  harness.screen.completeMatching(true);
  harness.screen.completeMatching(true);
  await settle();

  assert.deepEqual(harness.adaptive, [{
    module: 'listening', activityId: 'listening_matching', score: 6, maxScore: 6, durationMs: 350,
  }]);
  assert.equal(harness.ordinary.length, 0);
});

test('listening exact adaptive completion is exclusive, mismatch is blocked and slow playback is disclosed', async () => {
  const adaptive = createSubjectHarness('listening');
  adaptive.setActive({
    module: 'listening', activityId: 'listening_interview', executionClaim: 'a'.repeat(43),
  });
  adaptive.screen.startInterview();
  adaptive.advance(200);
  adaptive.screen.completeInterview(true);
  await settle();
  assert.deepEqual(adaptive.adaptive, [{
    module: 'listening', activityId: 'listening_interview', score: 7, maxScore: 7, durationMs: 200,
  }]);
  assert.equal(adaptive.ordinary.length, 0);

  adaptive.screen.startTrueFalse();
  adaptive.advance(100);
  adaptive.screen.completeTrueFalse(true);
  await settle();
  assert.equal(adaptive.adaptive.length, 1);
  assert.equal(adaptive.ordinary.length, 0);

  const assisted = createSubjectHarness('listening', { slow: true });
  assisted.screen.startTrueFalse();
  assisted.screen.playTrueFalse();
  assisted.advance(300);
  assisted.screen.completeTrueFalse(true);
  await settle();
  assert.deepEqual(assisted.ordinary[0].metadata, {
    mode: 'listening_true_false', source: 'builtin', helpUsed: true, hintsUsed: 0,
  });
});

test('ordinary and combined listening modes rotate through unseen catalog sets', async () => {
  const ordinary = createSubjectHarness('listening');
  ordinary.screen.startMatching();
  const firstMatching = ordinary.screen.currentSetIds().matching;
  ordinary.screen.completeMatching(true);
  ordinary.screen.startMatching();
  assert.notEqual(ordinary.screen.currentSetIds().matching, firstMatching);

  ordinary.screen.startTrueFalse();
  const firstTrueFalse = ordinary.screen.currentSetIds().trueFalse;
  ordinary.screen.completeTrueFalse(true);
  ordinary.screen.startTrueFalse();
  assert.notEqual(ordinary.screen.currentSetIds().trueFalse, firstTrueFalse);

  ordinary.screen.startInterview();
  const firstInterview = ordinary.screen.currentSetIds().interview;
  ordinary.screen.completeInterview(true);
  ordinary.screen.startInterview();
  assert.notEqual(ordinary.screen.currentSetIds().interview, firstInterview);

  const combined = createSubjectHarness('listening');
  combined.screen.startExam();
  const firstExam = combined.screen.currentSetIds().exam;
  combined.screen.completeExam(true);
  combined.screen.startExam();
  const secondExam = combined.screen.currentSetIds().exam;
  assert.notEqual(secondExam.matching, firstExam.matching);
  assert.notEqual(secondExam.trueFalse, firstExam.trueFalse);
  assert.notEqual(secondExam.interview, firstExam.interview);
});

test('revealed transcript and synthesized fallback make later evidence assisted without storing content', async () => {
  const transcript = createSubjectHarness('listening');
  transcript.screen.installMatchingCatalog([LISTENING_MATCHING_SETS[0]]);
  transcript.screen.startMatching();
  transcript.screen.completeMatching(true);
  transcript.screen.startMatching();
  transcript.screen.completeMatching(true);
  await settle();

  assert.equal(transcript.ordinary[0].metadata.helpUsed, false);
  assert.equal(transcript.ordinary[1].metadata.helpUsed, true);
  assert.doesNotMatch(JSON.stringify(transcript.state.listeningPilotHistory), /Speaker|statement|audio\/listening/iu);

  const fallback = createSubjectHarness('listening', { listeningAudioStatus: 'fallback' });
  fallback.screen.startInterview();
  fallback.screen.playInterview();
  await settle();
  fallback.screen.completeInterview(true);
  await settle();

  assert.equal(fallback.ordinary[0].metadata.helpUsed, true);
  const record = Object.values(fallback.state.listeningPilotHistory.items)[0];
  assert.equal(record.help.synthFallback, true);
});

test('a third ordinary playback is recorded as help while two static MP3 plays stay unassisted', async () => {
  const independent = createSubjectHarness('listening');
  independent.screen.startTrueFalse();
  independent.screen.playTrueFalse();
  independent.screen.playTrueFalse();
  independent.screen.completeTrueFalse(true);
  await settle();
  assert.equal(independent.ordinary[0].metadata.helpUsed, false);

  const assisted = createSubjectHarness('listening');
  assisted.screen.startTrueFalse();
  assisted.screen.playTrueFalse();
  assisted.screen.playTrueFalse();
  assisted.screen.playTrueFalse();
  assisted.screen.completeTrueFalse(true);
  await settle();
  assert.equal(assisted.ordinary[0].metadata.helpUsed, true);
  const record = Object.values(assisted.state.listeningPilotHistory.items)[0];
  assert.equal(record.help.additionalPlaybacks, 1);
});

test('a reading screen completion stays in the production offline queue for its owner and flushes once', async () => {
  const harness = createSubjectHarness('reading', { offline: true });
  await harness.screen.startHeadings();
  harness.advance(450);
  harness.screen.completeHeadings(true);
  await settle();

  assert.equal(harness.posts.length, 0);
  assert.equal(harness.sync.pendingModuleAttempts().length, 1);
  assert.equal(harness.sync.pendingModuleAttempts()[0].activity, 'reading_headings');

  harness.sync.setOwner('learner-b');
  assert.equal(harness.sync.pendingModuleAttempts().length, 0);
  harness.navigator.onLine = true;
  assert.equal(await harness.sync.flush(), false);
  assert.equal(harness.posts.length, 0);

  harness.sync.setOwner('learner-a');
  assert.equal(await harness.sync.flush(), true);
  assert.equal(harness.posts.length, 1);
  assert.equal(harness.posts[0].path, '/api/v1/module-attempts');
  assert.equal(harness.posts[0].body.activity, 'reading_headings');
  assert.equal(await harness.sync.flush(), false);
  assert.equal(harness.posts.length, 1);
});
