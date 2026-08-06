import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const rawSource = await fs.readFile(new URL('../public/screens/speaking.js', import.meta.url), 'utf8');
const executableSource = `${rawSource
  .replace(/^import[\s\S]*?from '[^']+';\r?\n/gmu, '')
  .replace(/export \{[\s\S]*?\};\s*$/u, '')}
window.__speakingScreen={spOpen,spMicCheck,spPrep,spRec,spFinish,spCompleteTask2Question,spPlayTask2Question,getState:function(){return SP}};`;

function task2Session() {
  return {
    id: '72200000-0000-4000-8000-000000000001',
    task: {
      id: 'speaking-pilot-v1.task2.weekend-pottery', revision: 1, taskType: 2,
      cefr: 'B1', topic: 'Творческие курсы', preparationSeconds: 60, questionSeconds: 20,
      maxScore: 4, instruction: 'Ask four questions.', advertisement: 'A server-owned pottery advertisement.',
      supports: ['course dates', 'participation fee', 'group size', 'tools provided'],
    },
    status: 'assigned', currentQuestion: 1,
    questions: Array.from({ length: 4 }, (_, index) => ({ questionNumber: index + 1, status: 'pending' })),
    assessment: { available: false, reason: 'deferred_to_tickets_06_07', message: 'Later.' },
  };
}

function harness({ recovered = null, restoreError = null } = {}) {
  const requests = [];
  const area = { innerHTML: '' };
  const elements = new Map([['s9_area', area], ['s9_today', { textContent: '' }]]);
  let session = recovered || task2Session();
  let recording = null;
  const speakingModule = {
    config(task) {
      return task === 2
        ? { name: 'Вопросы к объявлению', prep: 60, rec: 80, per: 20, max: 4, sub: 'задание 2 · 4 балла' }
        : { name: 'Чтение вслух', prep: 90, rec: 90, max: 1, sub: 'задание 1 · 1 балл' };
    },
    preferredMimeType: () => 'audio/webm', formatTime: (seconds) => `0:${seconds}`,
    serverTask2Set(value) {
      return value?.task?.supports?.length === 4 && value?.task?.questionSeconds === 20
        ? { id: value.task.id, revision: 1, ad: value.task.advertisement, points: value.task.supports,
          topic: value.task.topic, cefr: value.task.cefr }
        : null;
    },
    normalizeState: (value) => value || { t1: { n: 0 }, t2: { n: 0 }, t3: { n: 0 }, t4: { n: 0 } },
    summary: () => ({ trainings: 0 }), pool: (base) => base, select: (items) => items[0],
    sentences: () => [], TASKS: [1, 2, 3, 4], EXAM_MAX: 20,
  };
  const context = {
    window: {}, document: { getElementById: (id) => elements.get(id) || null },
    SPEAKING_TASK1_CATALOG: { tasks: [{ id: 'speaking-pilot-v1.task1.one', revision: 1 }] },
    SPEAKING_TASK2_CATALOG: { tasks: [{ id: session.task.id, revision: 1 }] },
    SPEAKING_TASK3_CATALOG: { tasks: [{ id: 'speaking-pilot-v1.task3.one', revision: 1 }] },
    registerRouteHook() {}, lPlayRaw() {}, lStop() {},
    S: { spk: { t1: { n: 0 }, t2: { n: 0 }, t3: { n: 0 }, t4: { n: 0 } },
      ...(recovered ? { speakingTask2SessionId: recovered.id } : {}) },
    SRV: true, TOKEN: 'cookie-session', WBTN: 'width:100%;',
    apiMessage: (error) => error.message,
    apiGet: async () => { if (restoreError) throw restoreError; return session; },
    apiPost: async () => ({}),
    apiPostBinary() {}, examModule: {}, generateAiContent() {}, save() {},
    setTxt(id, text) { const element = elements.get(id); if (element) element.textContent = text; },
    spSt() { return context.S.spk; }, spSync() {}, speakingModule, toast() {},
    ui: { escapeHtml: (value) => String(value), animate() {}, AI_DISCLAIMER: '' }, wDeco: () => '',
    adaptiveRuntimeSnapshot: () => ({ active: null }), completeAdaptiveServerAttempt() {}, openAdaptivePlan() {},
    adaptiveSpeakingTask: (reference) => reference.includes(':2:')
      ? { taskNumber: 2, assignment: { ad: 'legacy', points: ['a', 'b', 'c', 'd'] } }
      : { taskNumber: 4, assignment: { topic: 'topic', ph: ['one', 'two'], plan: ['a', 'b', 'c', 'd'] } },
    voiceTutorButton: () => '', createSpeakingTask1BrowserFlow() { throw new Error('task 1 not used'); },
    createSpeakingTask2BrowserFlow({ api }) {
      return {
        state() { return { currentQuestion: session.currentQuestion, questions: session.questions }; },
        async loadAssignment() { requests.push({ path: '/api/v1/speaking/task-2/sessions', body: {} }); return session; },
        async restoreSession(id) { requests.push({ path: `/api/v1/speaking/task-2/sessions/${id}`, method: 'GET' }); return api.get(`/api/v1/speaking/task-2/sessions/${id}`); },
        async checkMicrophone() { return { status: 'passed', level: 0.2 }; },
        async startQuestion() {},
        async stopQuestion() {
          recording = { blob: { size: 12 }, url: `blob:question-${session.currentQuestion}`, durationSeconds: 12 };
          return recording;
        },
        async playQuestion() { return true; },
        async completeQuestion(selfRating) {
          const questionNumber = session.currentQuestion;
          const body = { recordingDurationSeconds: recording.durationSeconds, localPlayback: true, selfRating };
          requests.push({ path: `/api/v1/speaking/task-2/sessions/${session.id}/questions/${questionNumber}/complete`, body });
          session = structuredClone(session);
          session.questions[questionNumber - 1] = { questionNumber, status: 'completed', ...body };
          session.currentQuestion = Math.min(4, questionNumber + 1);
          session.status = questionNumber === 4 ? 'completed' : 'in_progress';
          return session;
        },
        dispose() {},
      };
    },
    createSpeakingTask3BrowserFlow() { throw new Error('task 3 not used'); },
    setInterval: () => 1, clearInterval() {}, setTimeout: () => 1,
    URL: { revokeObjectURL() {} }, Blob, Audio: class {}, MediaRecorder: class {},
    console, Object, Number, Math, Array, String, Boolean, Date, Promise,
  };
  vm.runInNewContext(executableSource, context);
  return { screen: context.window.__speakingScreen, requests, area, context };
}

test('real Speaking screen runs four task 2 recordings and never offers early AI evaluation', async () => {
  const { screen, requests, area, context } = harness();

  assert.equal(await screen.spOpen(2), true);
  assert.match(area.innerHTML, /4 прямых вопроса/u);
  assert.match(area.innerHTML, /20 секунд/u);
  await screen.spMicCheck({ disabled: false });
  screen.spPrep();

  for (let questionNumber = 1; questionNumber <= 4; questionNumber += 1) {
    await screen.spRec();
    assert.equal(screen.getState().qi, questionNumber - 1);
    await screen.spFinish();
    await screen.spPlayTask2Question(questionNumber);
    await screen.spCompleteTask2Question('steady', { disabled: false });
  }

  assert.equal(screen.getState().task2Completed, true);
  assert.equal(context.S.speakingTask2SessionId, undefined);
  assert.match(area.innerHTML, /4 отдельные записи/u);
  assert.match(area.innerHTML, /оценка появится/u);
  assert.doesNotMatch(area.innerHTML, /Оценить с ИИ|Образец ответа|Расшифровка/u);
  assert.deepEqual(JSON.parse(JSON.stringify(requests)), [
    { path: '/api/v1/speaking/task-2/sessions', body: {} },
    ...[1, 2, 3, 4].map((questionNumber) => ({
      path: `/api/v1/speaking/task-2/sessions/${task2Session().id}/questions/${questionNumber}/complete`,
      body: { recordingDurationSeconds: 12, localPlayback: true, selfRating: 'steady' },
    })),
  ]);
});

test('real Speaking screen restores the exact current task 2 question before recording', async () => {
  const recovered = task2Session();
  recovered.status = 'in_progress';
  recovered.currentQuestion = 3;
  recovered.questions[0].status = 'completed';
  recovered.questions[1].status = 'completed';
  const { screen, requests, area } = harness({ recovered });

  assert.equal(await screen.spOpen(2), true);
  assert.equal(screen.getState().qi, 2);
  assert.match(area.innerHTML, /Продолжить с вопроса 3 из 4/u);
  assert.deepEqual(JSON.parse(JSON.stringify(requests)), [
    { path: `/api/v1/speaking/task-2/sessions/${recovered.id}`, method: 'GET' },
  ]);
});

test('real Speaking screen keeps its recovery pointer after a transient restore failure', async () => {
  const recovered = task2Session();
  recovered.status = 'in_progress';
  recovered.currentQuestion = 3;
  const offline = Object.assign(new Error('Нет подключения к интернету.'), {
    code: 'NETWORK_ERROR', status: 0,
  });
  const { screen, requests, context } = harness({ recovered, restoreError: offline });

  assert.equal(await screen.spOpen(2), false);
  assert.equal(context.S.speakingTask2SessionId, recovered.id);
  assert.deepEqual(JSON.parse(JSON.stringify(requests)), [
    { path: `/api/v1/speaking/task-2/sessions/${recovered.id}`, method: 'GET' },
  ]);
});
