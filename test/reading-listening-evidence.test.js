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
  READING_KINDS,
  READING_KIND_RULES,
  adaptLegacyReadingFallback,
  assertReadingCatalog,
  assertReadingSet,
  loadReadingCatalog,
  readingSetForLegacyScreen,
  readingSetReference,
} from '../public/reading-catalog-contract.js';
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

const [
  recorderFile,
  syncFile,
  readingModuleFile,
  readingScreenFile,
  listeningModuleFile,
  listeningScreenFile,
] = await Promise.all([
  fs.readFile(new URL('../public/learning-activity-recorder.js', import.meta.url), 'utf8'),
  fs.readFile(new URL('../public/sync.js', import.meta.url), 'utf8'),
  fs.readFile(new URL('../public/modules/reading.js', import.meta.url), 'utf8'),
  fs.readFile(new URL('../public/screens/reading.js', import.meta.url), 'utf8'),
  fs.readFile(new URL('../public/modules/listening.js', import.meta.url), 'utf8'),
  fs.readFile(new URL('../public/screens/listening.js', import.meta.url), 'utf8'),
]);

const recorderSource = recorderFile
  .replace(/^import\s*\{[\s\S]*?\}\s*from\s*'\.\/adaptive-session-runtime\.js';\r?\n/mu, '')
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
      createElement() { created += 1; return element(`created:${created}`); },
    },
  };
}

function createSubjectHarness(subject, { offline = false, slow = false, listeningAudioStatus = 'static' } = {}) {
  let now = 10_000;
  let active = null;
  let uuid = 100;
  const ordinary = [];
  const adaptive = [];
  const posts = [];
  const voiceResults = [];
  const staticPlays = [];
  const values = new Map();
  const navigator = { onLine: !offline };
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
    __sub: { authenticated: true, active: true, username: 'learner-a' },
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
    readingSetForLegacyScreen,
    READING_CATALOG_ID,
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
    loadInterviewCatalog,
    loadMatchingCatalog,
    loadTrueFalseCatalog,
    matchingSetForLegacyScreen,
    trueFalseSetForLegacyScreen,
    adaptiveRuntimeSnapshot: () => ({ active }),
    completeAdaptiveModuleActivity: async (completion) => {
      adaptive.push(JSON.parse(JSON.stringify(completion)));
      return { execution: { revision: 2 } };
    },
    S,
    currentUser: 'learner-a',
    PILOT_CATALOG: readingPilotCatalog,
    SRV: false,
    TOKEN: '',
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
    setInterval: () => 1,
    clearInterval() {},
    setTimeout: (callback) => { callback(); return 1; },
    registerRouteHook() {},
    registerScreenGenerator() {},
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
    generateAiContent: async () => null,
    save() {},
    setTxt() {},
    toast() {},
    ui: { animate() {}, markAnswer() {} },
    wDeco: () => '',
    rWordsHtml: (value) => String(value),
    rEsc: (value) => String(value),
    rSync() {},
    wSync() {},
    wBase: (value) => value,
    normalizeVocabularyWord: (value) => value,
    personalVocabularyCardId: () => null,
    mergePersonalVocabularyCard: () => null,
    srsRecordVocabularyOutcome() {},
    lSync() {},
    lSetSlow() {},
    lPlayRaw() {},
    lPlayListeningSet(set, lines, onStatus) {
      staticPlays.push({ setId: set?.id || null, lines: lines.length });
      if (typeof onStatus === 'function') onStatus(listeningAudioStatus);
      return Promise.resolve(listeningAudioStatus === 'static');
    },
    lStop() {},
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
    vm.runInContext(syncFile, context);
    window.EasyBoostSync.setOwner('learner-a');
  } else {
    window.EasyBoostSync = {
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
    context.readingModule = window.EasyBoostReading;
    vm.runInContext(executableScreen(readingScreenFile, `
      var __readingQuestionIndex=0;
      window.__subjectEvidenceTest={
        installCatalog:function(){catalog=PILOT_CATALOG},
        startHeadings:function(){rHl()},
        completeHeadings:function(correct){training.answers=training.set.task.answers.map(function(answer){return correct===false?(answer+1)%training.set.task.headings.length:answer});submitTraining()},
        startQuestions:function(){__readingQuestionIndex=0;rQs()},
        answerQuestion:function(correct){if(!training||__readingQuestionIndex>=training.set.task.questions.length)return false;
          var question=training.set.task.questions[__readingQuestionIndex];training.answers[__readingQuestionIndex]=correct===false?(question.answer+1)%question.options.length:question.answer;
          __readingQuestionIndex+=1;if(__readingQuestionIndex===training.answers.length)submitTraining();return true},
        startGaps:function(){rGp()},
        completeGaps:function(correct){training.answers=training.set.task.answers.map(function(answer){return correct===false?(answer+1)%training.set.task.fragments.length:answer});submitTraining()},
        startExam:rExamStart,
        completeExam:function(){KINDS.forEach(function(kind){var set=full.attempt.section.sets[kind];full.attempt.answers[kind]=kind==='task12_18'?set.task.questions.map(function(question){return question.answer}):set.task.answers.slice()});confirmFullSubmit()},
      };
    `), context);
    window.__subjectEvidenceTest.installCatalog();
  } else {
    context.lSt = () => S.lis;
    vm.runInContext(listeningModuleSource, context);
    context.listeningModule = window.EasyBoostListening;
    vm.runInContext(executableScreen(listeningScreenFile, `
      window.__subjectEvidenceTest={
        startMatching:lMt,
        installMatchingCatalog:function(sets){lSetMatchingCatalog(sets||LISTENING_MATCHING_SETS)},
        installTrueFalseCatalog:function(sets){lSetTrueFalseCatalog(sets||LISTENING_TRUE_FALSE_SETS)},
        installInterviewCatalog:function(sets){lSetInterviewCatalog(sets||LISTENING_INTERVIEW_SETS)},
        currentSetIds:function(){return {matching:LM&&LM.set.id,trueFalse:LT&&LT.set.id,interview:LI&&LI.set.id,
          exam:LE&&{matching:LE.m.id,trueFalse:LE.tf.id,interview:LE.iq.id}}},
        playMatching:function(){lPlay(lMtLines())},
        completeMatching:function(correct){LM.set.a.forEach(function(answer,index){lMtPick(index,correct===false?(answer+1)%LM.set.st.length:answer)});lMtCheck()},
        startTrueFalse:lTf,
        playTrueFalse:function(){lPlay(LT.set.d)},
        completeTrueFalse:function(correct){LT.set.st.forEach(function(item,index){lTfPick(index,correct===false?(item.a+1)%3:item.a)});lTfCheck()},
        startInterview:lIq,
        playInterview:function(){lPlay(LI.set.d)},
        completeInterview:function(correct){LI.set.qs.forEach(function(item,index){lIqPick(index,correct===false?(item.a+1)%item.o.length:item.a)});lIqCheck()},
        startExam:lExamStart,
        showExamInterview:function(){LE.stage=2;lExamRender()},
        firstExamInterviewExplanation:function(){return LE.iq.qs[0].e},
        completeExam:function(interviewCorrect){LE.m.a.forEach(function(answer,index){LE.selM[index]=answer;lExamDedup('selM',index,answer)});
          LE.tf.st.forEach(function(item,index){LE.selT[index]=item.a});LE.iq.qs.forEach(function(item,index){LE.selI[index]=interviewCorrect===false?(item.a+1)%item.o.length:item.a});lExamFinish()},
      };
    `), context);
    window.__subjectEvidenceTest.installMatchingCatalog();
    window.__subjectEvidenceTest.installTrueFalseCatalog();
    window.__subjectEvidenceTest.installInterviewCatalog();
  }

  return {
    screen: window.__subjectEvidenceTest,
    element,
    ordinary,
    adaptive,
    posts,
    voiceResults,
    staticPlays,
    values,
    navigator,
    sync: window.EasyBoostSync,
    state: S,
    advance(milliseconds) { now += milliseconds; },
    setActive(value) { active = value; },
  };
}

async function settle() {
  await Promise.resolve();
  await Promise.resolve();
}

test('reading screen completions record headings, questions, gaps and distinct combined-exam slices', async () => {
  const harness = createSubjectHarness('reading');

  harness.screen.startHeadings();
  harness.advance(400);
  harness.screen.completeHeadings(true);
  harness.screen.startQuestions();
  harness.advance(700);
  while (harness.screen.answerQuestion(true)) {}
  harness.screen.startGaps();
  harness.advance(300);
  harness.screen.completeGaps(true);
  harness.screen.startExam();
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
  assert.deepEqual(harness.ordinary.map((attempt) => attempt.metadata), [
    { mode: 'reading_headings', source: 'builtin', helpUsed: false, hintsUsed: 0 },
    { mode: 'reading_detail', source: 'builtin', helpUsed: false, hintsUsed: 0 },
    { mode: 'reading_gaps', source: 'builtin', helpUsed: false, hintsUsed: 0 },
    { mode: 'reading_exam', source: 'builtin', helpUsed: false, hintsUsed: 0 },
    { mode: 'reading_exam', source: 'builtin', helpUsed: false, hintsUsed: 0 },
  ]);
  assert.equal(new Set(harness.ordinary.map((attempt) => attempt.id)).size, 5);
  assert.equal(harness.ordinary.slice(-2).reduce((sum, attempt) => sum + attempt.durationMs, 0), 1_001);
});

test('reading exact adaptive completion uses only the claim path and a mismatch fails closed', async () => {
  const harness = createSubjectHarness('reading');
  harness.setActive({
    module: 'reading', activityId: 'reading_headings', executionClaim: 'a'.repeat(43),
  });
  harness.screen.startHeadings();
  harness.advance(250);
  harness.screen.completeHeadings(true);
  await settle();

  assert.deepEqual(harness.adaptive, [{
    module: 'reading', activityId: 'reading_headings', score: 7, maxScore: 7, durationMs: 250,
  }]);
  assert.equal(harness.ordinary.length, 0);

  harness.setActive({
    module: 'reading', activityId: 'reading_detail', executionClaim: 'b'.repeat(43),
  });
  harness.screen.startGaps();
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
  assert.match(exercise, /послушай шесть говорящих/u);
  assert.equal((exercise.match(/Говорящий [A-F]/gu) || []).length, 6);
  assert.doesNotMatch(exercise, /ТРАНСКРИПТ|<b>Ключ:<\/b>/u);

  harness.screen.completeMatching(true);
  await settle();

  assert.match(harness.element('created:1').innerHTML, /ТРАНСКРИПТ/u);
  assert.match(harness.element('lmt_res_0').innerHTML, /<b>Ключ:<\/b>/u);
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

  assert.match(harness.element('created:1').innerHTML, /ТРАНСКРИПТ/u);
  assert.match(harness.element('ltf_res_0').innerHTML, /<b>В записи:<\/b>/u);
  assert.deepEqual(harness.ordinary.map(({ activity, score, maxScore }) => ({ activity, score, maxScore })), [
    { activity: 'listening_true_false', score: 7, maxScore: 7 },
  ]);
});

test('listening screen identifies the synthesized fallback and sends catalog sets to static playback', () => {
  const harness = createSubjectHarness('listening');

  harness.screen.startTrueFalse();
  assert.match(harness.element('l_area').innerHTML, /Тренировочная синтезированная озвучка/u);
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

  assert.match(harness.element('created:1').innerHTML, /ТРАНСКРИПТ/u);
  assert.match(harness.element('liq_res_0').innerHTML, /data-voice-item="listening-pilot-v1\.interview\./u);
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
  harness.screen.startHeadings();
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
