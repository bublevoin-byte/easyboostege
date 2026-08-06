import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const rawSource = await fs.readFile(new URL('../public/screens/speaking.js', import.meta.url), 'utf8');
const executableSource = `${rawSource
  .replace(/^import[\s\S]*?from '[^']+';\r?\n/gmu, '')
  .replace(/export \{[\s\S]*?\};\s*$/u, '')}
window.__speakingScreen={spOpen,spMicCheck,spPrep,spRec,spFinish,spPlay,spCompleteTask1,speStart,getState:function(){return SP},getExamState:function(){return SPE}};`;

test('real Speaking screen path posts task 1 completion metadata and renders an honest no-provider state', async () => {
  const requests = [];
  const area = { innerHTML: '' };
  const elements = new Map([['s9_area', area], ['s9_today', { textContent: '' }]]);
  const session = {
    id: '71100000-0000-4000-8000-000000000001',
    task: {
      id: 'speaking-pilot-v1.task1.community-garden', revision: 1, taskType: 1,
      cefr: 'B1', topic: 'Город и природа', preparationSeconds: 90, responseSeconds: 90,
      maxScore: 1, instruction: 'Read aloud.', text: 'A server-owned reading text for the browser screen.',
    },
    pronunciationAssessment: { available: false, reason: 'provider_not_connected' },
  };
  const speakingModule = {
    config: () => ({ name: 'Чтение вслух', prep: 90, rec: 90, max: 1, sub: 'задание 1 · 1 балл' }),
    preferredMimeType: () => 'audio/webm', formatTime: (seconds) => `0:${seconds}`,
    serverTask1Set(value) {
      return value?.task?.preparationSeconds === 90 && value?.pronunciationAssessment?.available === false
        ? { id: value.task.id, revision: 1, tx: value.task.text, topic: value.task.topic, cefr: value.task.cefr }
        : null;
    },
    normalizeState: (value) => value || { t1: { n: 0 }, t2: { n: 0 }, t3: { n: 0 }, t4: { n: 0 } },
    summary: () => ({ trainings: 0 }), pool: (base) => base, select: (items) => items[0],
    sentences: () => [], TASKS: [1, 2, 3, 4], EXAM_MAX: 20,
  };
  const context = {
    window: {}, document: { getElementById: (id) => elements.get(id) || null },
    SPEAKING_TASK1_CATALOG: { tasks: [{ id: session.task.id, revision: 1, text: 'Full-exam fallback reading text.' }] },
    SPEAKING_TASK2_CATALOG: { tasks: [] },
    registerRouteHook() {}, lPlayRaw() {}, lStop() {},
    S: { spk: { t1: { n: 0 }, t2: { n: 0 }, t3: { n: 0 }, t4: { n: 0 } } },
    SRV: true, TOKEN: 'cookie-session', WBTN: 'width:100%;',
    apiMessage: (error) => error.message, apiPost: async (path, body) => {
      requests.push({ path, body });
      return path.endsWith('/complete') ? { ...session, status: 'completed', practice: body } : session;
    },
    apiPostBinary() {}, examModule: {}, generateAiContent() {}, save() {},
    setTxt(id, text) { const element = elements.get(id); if (element) element.textContent = text; },
    spSt() { return context.S.spk; }, spSync() {}, speakingModule, toast() {},
    ui: { escapeHtml: (value) => String(value), animate() {}, AI_DISCLAIMER: '' }, wDeco: () => '',
    adaptiveRuntimeSnapshot: () => ({ active: null }), completeAdaptiveServerAttempt() {}, openAdaptivePlan() {},
    adaptiveSpeakingTask: (reference) => reference.includes(':2:')
      ? { taskNumber: 2, assignment: { ad: 'ad', points: ['a', 'b', 'c', 'd'] } }
      : { taskNumber: 4, assignment: { topic: 'topic', ph: ['one', 'two'], plan: ['a', 'b', 'c', 'd'] } },
    voiceTutorButton: () => '',
    createSpeakingTask1BrowserFlow({ api }) {
      let recording = null;
      return {
        async loadAssignment() { return api.post('/api/v1/speaking/task-1/sessions', {}); },
        async checkMicrophone() { return { status: 'passed', level: 0.2 }; },
        async startRecording() {},
        async stopRecording() { recording = { blob: { size: 11 }, url: 'blob:local', durationSeconds: 72 }; return recording; },
        async playRecording() { return true; },
        async complete(selfRating) {
          return api.post(`/api/v1/speaking/task-1/sessions/${session.id}/complete`, {
            recordingDurationSeconds: recording.durationSeconds,
            micCheck: 'passed', localPlayback: true, selfRating,
          });
        },
        dispose() {},
      };
    },
    createSpeakingTask2BrowserFlow() { throw new Error('task 2 not used'); },
    setInterval: () => 1, clearInterval() {}, setTimeout: () => 1,
    URL: { revokeObjectURL() {} }, Blob, Audio: class {}, MediaRecorder: class {},
    console, Object, Number, Math, Array, String, Boolean, Date, Promise,
  };
  vm.runInNewContext(executableSource, context);
  const screen = context.window.__speakingScreen;

  assert.equal(await screen.spOpen(1), true);
  assert.match(area.innerHTML, /назначенный сервером текст/u);
  await screen.spMicCheck({ disabled: false });
  screen.spPrep();
  await screen.spRec();
  await screen.spFinish();
  await screen.spPlay();
  await screen.spCompleteTask1('steady', { disabled: false });

  assert.deepEqual(JSON.parse(JSON.stringify(requests)), [
    { path: '/api/v1/speaking/task-1/sessions', body: {} },
    {
      path: `/api/v1/speaking/task-1/sessions/${session.id}/complete`,
      body: { recordingDurationSeconds: 72, micCheck: 'passed', localPlayback: true, selfRating: 'steady' },
    },
  ]);
  assert.match(area.innerHTML, /Оценка произношения пока не подключена/u);
  assert.match(area.innerHTML, /Безопасная история тренировки сохранена/u);
  assert.doesNotMatch(area.innerHTML, /Оценить с ИИ/u);
  assert.equal(screen.getState().task1Completed, true);

  screen.speStart();
  assert.match(screen.getExamState().sets[1].tx, /Libraries are changing fast/u);
  assert.doesNotMatch(screen.getExamState().sets[1].tx, /Full-exam fallback/u);
});
