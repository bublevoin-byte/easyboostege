import assert from 'node:assert/strict';
import test from 'node:test';

import { createSpeakingTask4BrowserFlow } from '../public/speaking-task4-runtime.js';

function fakeStream() {
  const track = { readyState: 'live', stopped: false, stop() { this.stopped = true; } };
  return { track, getAudioTracks: () => [track], getTracks: () => [track] };
}

class FakeMediaRecorder {
  static isTypeSupported(type) { return type === 'audio/webm;codecs=opus'; }
  constructor(stream, options = {}) { this.stream = stream; this.mimeType = options.mimeType || 'audio/webm'; this.state = 'inactive'; }
  start() { this.state = 'recording'; }
  stop() {
    this.state = 'inactive';
    this.ondataavailable?.({ data: new Blob(['local task four'], { type: this.mimeType }) });
    this.onstop?.();
  }
}

function assignedSession() {
  return {
    id: '74400000-0000-4000-8000-000000000001',
    task: {
      id: 'speaking-pilot-v1.task4.learning-new-skills', revision: 1, taskType: 4,
      cefr: 'B1', topic: 'Learning new skills', projectTitle: 'Learning new skills',
      preparationSeconds: 150, responseSeconds: 180, maxScore: 10,
      instruction: 'Give a talk for your project.',
      photoPair: {
        assetId: 'speaking-task4-photo-pair.learning-new-skills.v1',
        src: '/assets/speaking/task4-v1/learning-new-skills.png',
        alt: 'Two photographs comparing ways to learn new skills.',
        panels: [
          { number: 1, alt: 'A learner practises pottery with a teacher.' },
          { number: 2, alt: 'A learner follows a guitar lesson at home.' },
        ],
      },
      plan: ['Describe both photographs in detail.', 'Explain what the photographs have in common.',
        'Compare the main differences between the photographs.', 'Say which way you prefer and explain why.'],
    },
    status: 'assigned',
    assessment: { available: false, reason: 'deferred_to_tickets_06_07', message: 'Later.' },
  };
}

test('task 4 browser flow decodes the lazy photo pair before practice and uploads metadata only', async () => {
  const requests = [];
  const imageEvents = [];
  let currentTime = 1_000;
  const session = assignedSession();
  class FakeImage {
    set src(value) { this.currentSrc = value; imageEvents.push(['src', value]); queueMicrotask(() => this.onload?.()); }
    async decode() { imageEvents.push(['decode', this.currentSrc]); }
  }
  const flow = createSpeakingTask4BrowserFlow({
    api: { async post(path, body) {
      requests.push({ path, body });
      return path.endsWith('/complete') ? { ...session, status: 'completed', practice: body } : session;
    } },
    Image: FakeImage,
    mediaDevices: { async getUserMedia() { return fakeStream(); } },
    MediaRecorder: FakeMediaRecorder,
    Audio: class { async play() {} pause() {} },
    URL: { createObjectURL: () => 'blob:local-task4', revokeObjectURL() {} }, Blob,
    now: () => currentTime, sampleMicrophone: async () => 0.2,
    setTimeout: () => 1, clearTimeout() {},
  });

  assert.equal((await flow.loadAssignment()).task.id, session.task.id);
  assert.equal(flow.state().assetStatus, 'idle');
  await flow.prepareAssets();
  assert.equal(flow.state().assetStatus, 'ready');
  assert.deepEqual(imageEvents, [
    ['src', session.task.photoPair.src], ['decode', session.task.photoPair.src],
  ]);
  await flow.checkMicrophone();
  await flow.startRecording();
  currentTime += 171_000;
  assert.equal((await flow.stopRecording()).durationSeconds, 171);
  await flow.playRecording();
  const completed = await flow.complete('steady');
  assert.equal(completed.status, 'completed');
  assert.deepEqual(requests, [
    { path: '/api/v1/speaking/task-4/sessions', body: {} },
    { path: `/api/v1/speaking/task-4/sessions/${session.id}/complete`, body: {
      recordingDurationSeconds: 171, micCheck: 'passed', localPlayback: true, selfRating: 'steady',
    } },
  ]);
  assert.equal(JSON.stringify(requests).includes('local task four'), false);
  assert.equal(JSON.stringify(requests).includes('blob:'), false);
});

test('task 4 browser flow restores server progress without recovered audio and rejects an undecoded image', async () => {
  const session = assignedSession();
  const flow = createSpeakingTask4BrowserFlow({
    api: { async get(path) {
      assert.equal(path, `/api/v1/speaking/task-4/sessions/${session.id}`);
      return session;
    } },
    Image: class { set src(_value) { queueMicrotask(() => this.onerror?.()); } },
  });

  assert.equal((await flow.restoreSession(session.id)).task.id, session.task.id);
  assert.equal(flow.state().recording, null);
  await assert.rejects(flow.prepareAssets(), { code: 'SPEAKING_TASK4_ASSET_UNAVAILABLE' });
  assert.equal(flow.state().assetStatus, 'error');
  await assert.rejects(flow.startRecording(), { code: 'SPEAKING_TASK4_ASSET_NOT_READY' });
});

test('task 4 browser flow rejects malformed nested photo-pair metadata at the API boundary', async () => {
  const invalidSession = assignedSession();
  invalidSession.task.photoPair.panels = [
    { position: 'left', alt: 'A learner practises pottery with a teacher.' },
    { position: 'right', alt: 'A learner follows a guitar lesson at home.' },
  ];
  const flow = createSpeakingTask4BrowserFlow({
    api: { async post() { return invalidSession; } },
  });
  await assert.rejects(flow.loadAssignment(), { code: 'SPEAKING_TASK4_RESPONSE_INVALID' });
});

test('disposing task 4 browser flow cancels a pending image decode without reviving asset state', async () => {
  const session = assignedSession();
  let image;
  class PendingImage {
    constructor() { image = this; }
    set src(value) { this.currentSrc = value; }
  }
  const flow = createSpeakingTask4BrowserFlow({
    api: { async post() { return session; } },
    Image: PendingImage,
  });
  await flow.loadAssignment();
  const pending = flow.prepareAssets();
  flow.dispose();
  const outcome = await Promise.race([
    pending.then(() => 'resolved', (error) => error.code),
    new Promise((resolve) => setTimeout(() => resolve('timeout'), 50)),
  ]);
  assert.equal(outcome, 'SPEAKING_TASK4_ASSET_CANCELLED');
  image.onload?.();
  await Promise.resolve();
  assert.equal(flow.state().assetStatus, 'idle');
  assert.equal(flow.state().sessionId, null);
});
