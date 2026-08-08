import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const rawSource = await fs.readFile(new URL('../public/screens/speaking.js', import.meta.url), 'utf8');
const executableSource = `${rawSource
  .replace(/^import[\s\S]*?from '[^']+';\r?\n/gmu, '')
  .replace(/export \{[\s\S]*?\};\s*$/u, '')}
window.__speakingScreen={spOpen,spMicCheck,spPrep,spRec,spFinish,spPlay,spCompleteTask4,getState:function(){return SP}};`;

function task4Session({ id = '74400000-0000-4000-8000-000000000001', slug = 'learning-new-skills' } = {}) {
  return {
    id,
    task: {
      id: `speaking-pilot-v1.task4.${slug}`, revision: 1, taskType: 4,
      cefr: 'B1', topic: 'Learning new skills', projectTitle: 'Learning new skills',
      preparationSeconds: 150, responseSeconds: 180, maxScore: 10,
      instruction: 'Give a talk for your project.',
      photoPair: { assetId: `speaking-task4-photo-pair.${slug}.v1`,
        src: `/assets/speaking/task4-v1/${slug}.png`,
        alt: 'Two photographs comparing ways to learn new skills.',
        panels: [{ number: 1, alt: 'A student attends a pottery lesson.' },
          { number: 2, alt: 'A student follows a guitar lesson.' }] },
      plan: ['Describe both photographs in detail.', 'Explain what the photographs have in common.',
        'Compare the main differences between the photographs.', 'Say which way you prefer and explain why.'],
    }, status: 'assigned',
    assessment: { available: false, reason: 'not_requested', message: 'Later.' },
  };
}

function harness({ recovered = null, restoreError = null, assignments = null, deferredAssets = false } = {}) {
  const requests = [];
  const events = [];
  const routeHooks = [];
  const area = { innerHTML: '' };
  const elements = new Map([['s9_area', area], ['s9_today', { textContent: '' }]]);
  const assignmentQueue = assignments || [recovered || task4Session()];
  let assignmentIndex = 0;
  let session = recovered || assignmentQueue[0];
  let releaseAssets = null;
  let recording = null;
  const speakingModule = {
    config(task) { return task === 4
      ? { name: 'Photo project', prep: 150, rec: 180, max: 10, sub: 'task 4 · 10 points' }
      : { name: 'Other', prep: 0, rec: 40, max: 1, sub: 'other' }; },
    preferredMimeType: () => 'audio/webm', formatTime: (seconds) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`,
    serverTask4Set(value) { return {
      id: value.task.id, revision: value.task.revision, topic: value.task.topic,
      projectTitle: value.task.projectTitle, instruction: value.task.instruction,
      photoPair: value.task.photoPair, plan: value.task.plan, cefr: value.task.cefr,
    }; },
    normalizeState: (value) => value || { t1: { n: 0 }, t2: { n: 0 }, t3: { n: 0 }, t4: { n: 0 } },
    summary: () => ({ trainings: 0 }), pool: (base) => base, select: (items) => items[0],
    sentences: () => [], TASKS: [1, 2, 3, 4], EXAM_MAX: 20,
  };
  const context = {
    window: {}, document: { getElementById: (id) => elements.get(id) || null },
    SPEAKING_TASK1_CATALOG: { tasks: [] }, SPEAKING_TASK2_CATALOG: { tasks: [] },
    SPEAKING_TASK3_CATALOG: { tasks: [] }, SPEAKING_TASK4_CATALOG: { tasks: assignmentQueue.map((item) => ({ id: item.task.id, revision: 1 })) },
    SPEAKING_TASK4_PHOTO_MANIFEST: { assets: assignmentQueue.map((item) => ({ src: item.task.photoPair.src, width: 1536, height: 1024 })) },
    registerRouteHook(callback) { routeHooks.push(callback); }, lPlayRaw() {}, lStop() {},
    S: { spk: { t1: { n: 0 }, t2: { n: 0 }, t3: { n: 0 }, t4: { n: 0 } },
      ...(recovered ? { speakingTask4SessionId: recovered.id } : {}) },
    SRV: true, TOKEN: 'cookie-session', WBTN: 'width:100%;',
    apiMessage: (error) => error.message, apiGet: async () => { if (restoreError) throw restoreError; return session; },
    apiPost: async () => ({}), apiPostBinary() {}, examModule: {}, generateAiContent() {}, save() {},
    setTxt(id, text) { const element = elements.get(id); if (element) element.textContent = text; },
    spSt() { return context.S.spk; }, spSync() {}, speakingModule, toast() {},
    ui: { escapeHtml: (value) => String(value), animate() {}, AI_DISCLAIMER: '' }, wDeco: () => '',
    adaptiveRuntimeSnapshot: () => ({ active: null }), completeAdaptiveServerAttempt() {}, openAdaptivePlan() {},
    adaptiveSpeakingTask: () => ({ taskNumber: 4, assignment: { topic: 'legacy', ph: ['one', 'two'], plan: ['a', 'b', 'c', 'd'] } }),
    voiceTutorButton: () => '',
    createSpeakingTask1BrowserFlow() { throw new Error('task 1 not used'); },
    createSpeakingTask2BrowserFlow() { throw new Error('task 2 not used'); },
    createSpeakingTask3BrowserFlow() { throw new Error('task 3 not used'); },
    createSpeakingTask4BrowserFlow({ api }) { return {
      async loadAssignment() { events.push('assignment'); requests.push({ path: '/api/v1/speaking/task-4/sessions', body: {} });
        session = assignmentQueue[Math.min(assignmentIndex, assignmentQueue.length - 1)]; assignmentIndex += 1; return session; },
      async restoreSession(id) { events.push('restore'); requests.push({ path: `/api/v1/speaking/task-4/sessions/${id}`, method: 'GET' }); return api.get(`/api/v1/speaking/task-4/sessions/${id}`); },
      async prepareAssets() { if (!deferredAssets) { events.push('asset-ready'); return true; }
        events.push('asset-loading'); return new Promise((resolve) => { releaseAssets = () => { events.push('asset-ready'); resolve(true); }; }); },
      async checkMicrophone() { return { status: 'passed', level: 0.2 }; },
      async startRecording() { events.push('recording'); },
      async stopRecording() { recording = { blob: { size: 171 }, url: 'blob:task4', durationSeconds: 171 }; return recording; },
      async playRecording() { events.push('play'); return true; },
      async complete(selfRating) {
        const body = { recordingDurationSeconds: recording.durationSeconds, micCheck: 'passed', localPlayback: true, selfRating };
        requests.push({ path: `/api/v1/speaking/task-4/sessions/${session.id}/complete`, body });
        session = { ...session, status: 'completed', practice: body };
        return session;
      }, dispose() { events.push('disposed'); },
    }; },
    setInterval(callback) { events.push('timer'); context.timerCallback = callback; return 1; }, clearInterval() {}, setTimeout: () => 1,
    URL: { revokeObjectURL() {} }, Blob, Audio: class {}, MediaRecorder: class {},
    console, Object, Number, Math, Array, String, Boolean, Date, Promise,
  };
  vm.runInNewContext(executableSource, context);
  return { screen: context.window.__speakingScreen, requests, events, area, context, routeHooks,
    releaseAssets: () => releaseAssets?.() };
}

test('task 4 screen preloads the responsive accessible photo pair before its 150-second timer and completes locally', async () => {
  const { screen, requests, events, area, context } = harness();
  assert.equal(await screen.spOpen(4), true);
  assert.deepEqual(events, ['assignment', 'asset-ready']);
  assert.match(area.innerHTML, /<img[^>]+loading="lazy"[^>]+decoding="async"/u);
  assert.match(area.innerHTML, /alt="Two photographs comparing ways to learn new skills\."/u);
  assert.match(area.innerHTML, /width:100%/u);
  await screen.spMicCheck({ disabled: false });
  screen.spPrep();
  assert.equal(screen.getState().left, 150);
  assert.deepEqual(events.slice(-1), ['timer']);
  await screen.spRec();
  assert.equal(screen.getState().left, 180);
  await screen.spFinish();
  await screen.spPlay();
  await screen.spCompleteTask4('steady', { disabled: false });
  assert.equal(screen.getState().task4Completed, true);
  assert.equal(context.S.speakingTask4SessionId, undefined);
  assert.equal(/AI|sample|transcript/iu.test(area.innerHTML), false);
  assert.deepEqual(JSON.parse(JSON.stringify(requests)), [
    { path: '/api/v1/speaking/task-4/sessions', body: {} },
    { path: `/api/v1/speaking/task-4/sessions/${task4Session().id}/complete`, body: {
      recordingDurationSeconds: 171, micCheck: 'passed', localPlayback: true, selfRating: 'steady',
    } },
  ]);
});

test('task 4 screen preserves the recovery pointer after a transient restore failure', async () => {
  const recovered = task4Session();
  const offline = Object.assign(new Error('offline'), { status: 503, code: 'NETWORK_ERROR' });
  const { screen, context } = harness({ recovered, restoreError: offline });
  assert.equal(await screen.spOpen(4), false);
  assert.equal(context.S.speakingTask4SessionId, recovered.id);
});

test('task 4 screen cancels stale preload work when navigation leaves the screen', async () => {
  const { screen, context, events, routeHooks, releaseAssets } = harness({ deferredAssets: true });
  const opening = screen.spOpen(4);
  for (let index = 0; index < 10 && !events.includes('asset-loading'); index += 1) await Promise.resolve();
  assert.equal(events.includes('asset-loading'), true);
  routeHooks.forEach((hook) => hook('scr1'));
  releaseAssets();
  assert.equal(await opening, false);
  assert.equal(screen.getState(), null);
  assert.equal(context.S.speakingTask4SessionId, undefined);
});

test('task 4 hides the client-side Другой вариант control for its owner-bound server session', async () => {
  const { screen, area } = harness();
  assert.equal(await screen.spOpen(4), true);
  assert.doesNotMatch(area.innerHTML, /Другой вариант/u);
  assert.doesNotMatch(area.innerHTML, /Шпаргалка|I have found two photos|That is all I wanted to say/iu);
});
