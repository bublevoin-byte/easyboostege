import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const rawSource = await fs.readFile(new URL('../public/screens/speaking.js', import.meta.url), 'utf8');
const executableSource = `${rawSource
  .replace(/^import[\s\S]*?from '[^']+';\r?\n/gmu, '')
  .replace(/export \{[\s\S]*?\};\s*$/u, '')}
window.__speakingScreen={spOpen,spMicCheck,spPrep,spRec,spFinish,spCompleteTask3Answer,spPlayTask3Answer,getState:function(){return SP}};`;

const TASK3_INSTRUCTION = 'Take part in an interview. Give a full answer to each of the five questions. You have 40 seconds to answer each question. Give 2–3 sentences for each answer.';

function task3Session() {
  return {
    id: '73300000-0000-4000-8000-000000000001',
    task: {
      id: 'speaking-pilot-v1.task3.free-time-routines', revision: 1, taskType: 3,
      cefr: 'B1', topic: 'Свободное время', preparationSeconds: 0, questionSeconds: 40,
      maxScore: 5, instruction: TASK3_INSTRUCTION,
      questions: Array.from({ length: 5 }, (_, index) => `Original interview question number ${index + 1}?`),
    },
    status: 'assigned', currentQuestion: 1,
    answers: Array.from({ length: 5 }, (_, index) => ({ questionNumber: index + 1, status: 'pending' })),
    assessment: { available: false, reason: 'deferred_to_tickets_06_07', message: 'Later.' },
  };
}

function harness({ recovered = null, restoreError = null, deferQuestion = false } = {}) {
  const requests = [];
  const area = { innerHTML: '' };
  const elements = new Map([['s9_area', area], ['s9_today', { textContent: '' }]]);
  let session = recovered || task3Session();
  let recording = null;
  let startAnswerCalls = 0;
  let resolveQuestion;
  const questionPlayback = deferQuestion
    ? new Promise((resolve) => { resolveQuestion = resolve; })
    : Promise.resolve(true);
  const speakingModule = {
    config(task) {
      return task === 3
        ? { name: 'Интервью', prep: 0, rec: 40, max: 5, sub: 'задание 3 · 5 баллов' }
        : task === 2
          ? { name: 'Вопросы к объявлению', prep: 60, rec: 80, per: 20, max: 4, sub: 'задание 2 · 4 балла' }
          : { name: 'Чтение вслух', prep: 90, rec: 90, max: 1, sub: 'задание 1 · 1 балл' };
    },
    preferredMimeType: () => 'audio/webm', formatTime: (seconds) => `0:${seconds}`,
    serverTask3Set(value) {
      return value?.task?.questions?.length === 5 && value?.task?.questionSeconds === 40
        ? { id: value.task.id, revision: 1, topic: value.task.topic, instruction: value.task.instruction, qs: value.task.questions, cefr: value.task.cefr }
        : null;
    },
    normalizeState: (value) => value || { t1: { n: 0 }, t2: { n: 0 }, t3: { n: 0 }, t4: { n: 0 } },
    summary: () => ({ trainings: 0 }), pool: (base) => base, select: (items) => items[0],
    sentences: () => [], TASKS: [1, 2, 3, 4], EXAM_MAX: 20,
  };
  const context = {
    window: {}, document: { getElementById: (id) => elements.get(id) || null },
    SPEAKING_TASK1_CATALOG: { tasks: [{ id: 'speaking-pilot-v1.task1.one', revision: 1 }] },
    SPEAKING_TASK2_CATALOG: { tasks: [{ id: 'speaking-pilot-v1.task2.one', revision: 1 }] },
    SPEAKING_TASK3_CATALOG: { tasks: [{ id: session.task.id, revision: 1 }] },
    registerRouteHook() {}, lPlayRaw() { return questionPlayback; }, lStop() {},
    S: { spk: { t1: { n: 0 }, t2: { n: 0 }, t3: { n: 0 }, t4: { n: 0 } },
      ...(recovered ? { speakingTask3SessionId: recovered.id } : {}) },
    SRV: true, TOKEN: 'cookie-session', WBTN: 'width:100%;',
    apiMessage: (error) => error.message,
    apiGet: async () => { if (restoreError) throw restoreError; return session; },
    apiPost: async () => ({}), apiPostBinary() {}, examModule: {}, generateAiContent() {}, save() {},
    setTxt(id, text) { const element = elements.get(id); if (element) element.textContent = text; },
    spSt() { return context.S.spk; }, spSync() {}, speakingModule, toast() {},
    ui: { escapeHtml: (value) => String(value), animate() {}, AI_DISCLAIMER: '' }, wDeco: () => '',
    adaptiveRuntimeSnapshot: () => ({ active: null }), completeAdaptiveServerAttempt() {}, openAdaptivePlan() {},
    adaptiveSpeakingTask: (reference) => reference.includes(':2:')
      ? { taskNumber: 2, assignment: { ad: 'legacy', points: ['a', 'b', 'c', 'd'] } }
      : { taskNumber: 4, assignment: { topic: 'topic', ph: ['one', 'two'], plan: ['a', 'b', 'c', 'd'] } },
    voiceTutorButton: () => '',
    createSpeakingTask1BrowserFlow() { throw new Error('task 1 not used'); },
    createSpeakingTask2BrowserFlow() { throw new Error('task 2 not used'); },
    createSpeakingTask3BrowserFlow({ api }) {
      return {
        state() { return { currentQuestion: session.currentQuestion, answers: session.answers }; },
        async loadAssignment() { requests.push({ path: '/api/v1/speaking/task-3/sessions', body: {} }); return session; },
        async restoreSession(id) { requests.push({ path: `/api/v1/speaking/task-3/sessions/${id}`, method: 'GET' }); return api.get(`/api/v1/speaking/task-3/sessions/${id}`); },
        async checkMicrophone() { return { status: 'passed', level: 0.2 }; },
        async startAnswer() { startAnswerCalls += 1; },
        async stopAnswer() {
          recording = { blob: { size: 22 }, url: `blob:answer-${session.currentQuestion}`, durationSeconds: 22 };
          return recording;
        },
        async playAnswer() { return true; },
        async completeAnswer(selfRating) {
          const questionNumber = session.currentQuestion;
          const body = { recordingDurationSeconds: recording.durationSeconds, localPlayback: true, selfRating };
          requests.push({ path: `/api/v1/speaking/task-3/sessions/${session.id}/answers/${questionNumber}/complete`, body });
          session = structuredClone(session);
          session.answers[questionNumber - 1] = { questionNumber, status: 'completed', ...body };
          session.currentQuestion = Math.min(5, questionNumber + 1);
          session.status = questionNumber === 5 ? 'completed' : 'in_progress';
          return session;
        },
        dispose() {},
      };
    },
    setInterval: () => 1, clearInterval() {}, setTimeout: () => 1,
    URL: { revokeObjectURL() {} }, Blob, Audio: class {}, MediaRecorder: class {},
    console, Object, Number, Math, Array, String, Boolean, Date, Promise,
  };
  vm.runInNewContext(executableSource, context);
  return {
    screen: context.window.__speakingScreen, requests, area, context,
    resolveQuestion: () => resolveQuestion?.(true),
    startAnswerCalls: () => startAnswerCalls,
  };
}

test('real Speaking screen runs five task 3 recordings without preparation or early AI assessment', async () => {
  const { screen, requests, area, context } = harness();

  assert.equal(await screen.spOpen(3), true);
  assert.match(area.innerHTML, /Подготовки нет/u);
  assert.match(area.innerHTML, /40 секунд/u);
  assert.match(area.innerHTML, new RegExp(TASK3_INSTRUCTION, 'u'));
  await screen.spMicCheck({ disabled: false });

  for (let questionNumber = 1; questionNumber <= 5; questionNumber += 1) {
    if (questionNumber === 1) await screen.spPrep();
    else await screen.spRec();
    assert.equal(screen.getState().qi, questionNumber - 1);
    await screen.spFinish();
    await screen.spPlayTask3Answer(questionNumber);
    await screen.spCompleteTask3Answer('steady', { disabled: false });
  }

  assert.equal(screen.getState().task3Completed, true);
  assert.equal(context.S.speakingTask3SessionId, undefined);
  assert.match(area.innerHTML, /5 отдельных записей/u);
  assert.match(area.innerHTML, /оценка появится/u);
  assert.doesNotMatch(area.innerHTML, /Оценить с ИИ|Образец ответа|Расшифровка/u);
  assert.deepEqual(JSON.parse(JSON.stringify(requests)), [
    { path: '/api/v1/speaking/task-3/sessions', body: {} },
    ...[1, 2, 3, 4, 5].map((questionNumber) => ({
      path: `/api/v1/speaking/task-3/sessions/${task3Session().id}/answers/${questionNumber}/complete`,
      body: { recordingDurationSeconds: 22, localPlayback: true, selfRating: 'steady' },
    })),
  ]);
});

test('real Speaking screen finishes asking the task 3 question before recording and timing the answer', async () => {
  const { screen, resolveQuestion, startAnswerCalls } = harness({ deferQuestion: true });

  assert.equal(await screen.spOpen(3), true);
  await screen.spMicCheck({ disabled: false });
  const recordingStarted = screen.spRec();
  await Promise.resolve();

  assert.equal(startAnswerCalls(), 0);
  resolveQuestion();
  await recordingStarted;
  assert.equal(startAnswerCalls(), 1);
  assert.equal(screen.getState().left, 40);
});

test('real Speaking screen restores the exact current task 3 question', async () => {
  const recovered = task3Session();
  recovered.status = 'in_progress';
  recovered.currentQuestion = 4;
  recovered.answers.slice(0, 3).forEach((answer) => { answer.status = 'completed'; });
  const { screen, requests, area } = harness({ recovered });

  assert.equal(await screen.spOpen(3), true);
  assert.equal(screen.getState().qi, 3);
  assert.match(area.innerHTML, /Продолжить с вопроса 4 из 5/u);
  assert.deepEqual(JSON.parse(JSON.stringify(requests)), [
    { path: `/api/v1/speaking/task-3/sessions/${recovered.id}`, method: 'GET' },
  ]);
});

test('real Speaking screen keeps task 3 recovery pointer after a transient failure', async () => {
  const recovered = task3Session();
  recovered.status = 'in_progress';
  recovered.currentQuestion = 3;
  const offline = Object.assign(new Error('Нет подключения'), { status: 503, code: 'NETWORK_ERROR' });
  const { screen, context } = harness({ recovered, restoreError: offline });

  assert.equal(await screen.spOpen(3), false);
  assert.equal(context.S.speakingTask3SessionId, recovered.id);
});
