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
const readingModuleSource = readingModuleFile.replace(/^import .*;\r?\n/mu, '');
const listeningModuleSource = listeningModuleFile.replace(/^import .*;\r?\n/mu, '');

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

function createSubjectHarness(subject, { offline = false, slow = false } = {}) {
  let now = 10_000;
  let active = null;
  let uuid = 100;
  const ordinary = [];
  const adaptive = [];
  const posts = [];
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
    adaptiveRuntimeSnapshot: () => ({ active }),
    completeAdaptiveModuleActivity: async (completion) => {
      adaptive.push(JSON.parse(JSON.stringify(completion)));
      return { execution: { revision: 2 } };
    },
    S,
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
    prepareVoiceTutorContextResult: () => null,
    registerVoiceTutorContextResult: async () => null,
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
      window.__subjectEvidenceTest={
        startHeadings:rHl,
        completeHeadings:function(correct){RH.set.txts.forEach(function(item,index){rHlPick(index,correct===false?(item.a+1)%RH.set.hl.length:item.a)});rHlCheck()},
        startQuestions:function(){rQs();RQ.i=0;rQsRender()},
        answerQuestion:function(correct){var q=RQ&&RQ.set.qs[RQ.i];if(!q)return false;
          var buttons=q.o.map(function(){return{dataset:{},style:{},parentElement:null}});
          buttons.forEach(function(button){button.parentElement={querySelectorAll:function(){return buttons}}});
          rQsPick(buttons[correct===false?(q.a+1)%q.o.length:q.a],correct===false?(q.a+1)%q.o.length:q.a);return true},
        startGaps:rGp,
        completeGaps:function(correct){RG.set.a.forEach(function(answer,index){rGpPick(index,correct===false?(answer+1)%RG.set.fr.length:answer)});rGpCheck()},
        startExam:rExamStart,
        completeExam:function(){RE.h.txts.forEach(function(item,index){RE.selH[index]=item.a;rExamDedup('selH',index,item.a)});
          RE.stage=1;RE.g.a.forEach(function(answer,index){RE.selG[index]=answer;rExamDedup('selG',index,answer)});
          RE.stage=2;RE.q.qs.forEach(function(q){RE.ansQ.push(q.a)});rExamRender()},
      };
    `), context);
  } else {
    context.lSt = () => S.lis;
    vm.runInContext(listeningModuleSource, context);
    context.listeningModule = window.EasyBoostListening;
    vm.runInContext(executableScreen(listeningScreenFile, `
      window.__subjectEvidenceTest={
        startMatching:lMt,
        playMatching:function(){lPlay(lMtLines())},
        completeMatching:function(correct){LM.set.a.forEach(function(answer,index){lMtPick(index,correct===false?(answer+1)%LM.set.st.length:answer)});lMtCheck()},
        startTrueFalse:lTf,
        playTrueFalse:function(){lPlay(LT.set.d)},
        completeTrueFalse:function(correct){LT.set.st.forEach(function(item,index){lTfPick(index,correct===false?(item.a+1)%3:item.a)});lTfCheck()},
        startInterview:lIq,
        playInterview:function(){lPlay(LI.set.d)},
        completeInterview:function(correct){LI.set.qs.forEach(function(item,index){lIqPick(index,correct===false?(item.a+1)%item.o.length:item.a)});lIqCheck()},
        startExam:lExamStart,
        completeExam:function(){LE.m.a.forEach(function(answer,index){LE.selM[index]=answer;lExamDedup('selM',index,answer)});
          LE.tf.st.forEach(function(item,index){LE.selT[index]=item.a});LE.iq.qs.forEach(function(item,index){LE.selI[index]=item.a});lExamFinish()},
      };
    `), context);
  }

  return {
    screen: window.__subjectEvidenceTest,
    ordinary,
    adaptive,
    posts,
    values,
    navigator,
    sync: window.EasyBoostSync,
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
    { activity: 'reading_headings', score: 4, maxScore: 4, durationMs: 400 },
    { activity: 'reading_detail', score: 4, maxScore: 4, durationMs: 700 },
    { activity: 'reading_gaps', score: 3, maxScore: 3, durationMs: 300 },
    { activity: 'reading_headings', score: 4, maxScore: 4, durationMs: 364 },
    { activity: 'reading_detail', score: 7, maxScore: 7, durationMs: 637 },
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
    module: 'reading', activityId: 'reading_headings', score: 4, maxScore: 4, durationMs: 250,
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
    { activity: 'listening_matching', score: 4, maxScore: 4, durationMs: 400 },
    { activity: 'listening_true_false', score: 5, maxScore: 5, durationMs: 500 },
    { activity: 'listening_interview', score: 4, maxScore: 4, durationMs: 600 },
    { activity: 'listening_matching', score: 4, maxScore: 4, durationMs: 308 },
    { activity: 'listening_detail', score: 9, maxScore: 9, durationMs: 693 },
  ]);
  assert.deepEqual(harness.ordinary.map((attempt) => attempt.metadata.mode), [
    'listening_matching', 'listening_true_false', 'listening_interview',
    'listening_exam', 'listening_exam',
  ]);
  assert.equal(harness.ordinary.every((attempt) => attempt.metadata.source === 'builtin'), true);
  assert.equal(harness.ordinary.every((attempt) => attempt.metadata.helpUsed === false), true);
  assert.equal(harness.ordinary.slice(-2).reduce((sum, attempt) => sum + attempt.durationMs, 0), 1_001);
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
    module: 'listening', activityId: 'listening_interview', score: 4, maxScore: 4, durationMs: 200,
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
