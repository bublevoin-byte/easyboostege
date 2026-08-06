import assert from 'node:assert/strict';
import test from 'node:test';

import { createSpeakingFullBrowserFlow } from '../public/speaking-full-runtime.js';

function fakeStream() {
  const track = { readyState: 'live', stop() {} };
  return { getAudioTracks: () => [track], getTracks: () => [track] };
}

class FakeMediaRecorder {
  static isTypeSupported(type) { return type === 'audio/webm'; }
  constructor() { this.mimeType = 'audio/webm'; this.state = 'inactive'; }
  start() { this.state = 'recording'; }
  stop() {
    this.state = 'inactive';
    this.ondataavailable?.({ data: new Blob(['local-only-full-answer'], { type: this.mimeType }) });
    this.onstop?.();
  }
}

function session() {
  return {
    id: '75500000-0000-4000-8000-000000000010', mode: 'full_section', status: 'in_progress',
    phase: 'ready', current: { taskType: 1, responseNumber: 1 },
    task: { taskType: 1, preparationSeconds: 90, responseSeconds: 90, maxScore: 1 },
    progress: [
      { taskType: 1, maximumScore: 1, responseCount: 1, completedResponses: 0, status: 'pending' },
      { taskType: 2, maximumScore: 4, responseCount: 4, completedResponses: 0, status: 'pending' },
      { taskType: 3, maximumScore: 5, responseCount: 5, completedResponses: 0, status: 'pending' },
      { taskType: 4, maximumScore: 10, responseCount: 1, completedResponses: 0, status: 'pending' },
    ],
    maximumScore: 20, earnedScore: null,
    assessment: { available: false, reason: 'deferred_to_tickets_06_07', message: 'Unavailable.' },
  };
}

test('full Speaking browser flow keeps bytes local and sends only bounded response metadata', async () => {
  const requests = [];
  let current = session();
  let time = 1_000;
  const flow = createSpeakingFullBrowserFlow({
    api: { async post(path, body) {
      requests.push({ path, body });
      if (path.endsWith('/stage')) {
        current = { ...current, phase: current.phase === 'ready' ? 'preparing' : 'recording' };
      } else if (path.endsWith('/responses')) {
        current = { ...current, phase: 'ready', current: { taskType: 2, responseNumber: 1 },
          task: { taskType: 2, preparationSeconds: 60, questionSeconds: 20, maxScore: 4 } };
      }
      return current;
    } },
    mediaDevices: { async getUserMedia() { return fakeStream(); } },
    MediaRecorder: FakeMediaRecorder,
    Audio: class { async play() {} pause() {} },
    URL: { createObjectURL: () => 'blob:full-local-1', revokeObjectURL() {} },
    Blob, now: () => time, sampleMicrophone: async () => 0.2,
    setTimeout: () => 1, clearTimeout() {},
  });

  flow.acceptSession(current);
  await flow.checkMicrophone();
  assert.equal((await flow.beginStage()).phase, 'preparing');
  await flow.startRecording();
  time += 72_000;
  const recording = await flow.stopRecording();
  assert.equal(recording.url, 'blob:full-local-1');
  await flow.completeResponse('completed');
  assert.equal(flow.state().session.current.taskType, 2);
  assert.equal(JSON.stringify(requests).includes('local-only-full-answer'), false);
  assert.equal(JSON.stringify(requests).includes('blob:'), false);
  assert.deepEqual(requests.at(-1), {
    path: `/api/v1/speaking/full-sessions/${session().id}/responses`,
    body: {
      taskType: 1, responseNumber: 1, responseStatus: 'completed',
      recordingDurationSeconds: 72, micCheck: 'passed', localPlayback: false,
    },
  });
});

test('full Speaking browser restore preserves server phase without inventing lost local audio', async () => {
  const restored = { ...session(), phase: 'recording' };
  const flow = createSpeakingFullBrowserFlow({
    api: { async get() { return restored; }, async post() { return restored; } },
  });
  await flow.restoreSession(restored.id);
  assert.equal(flow.state().session.phase, 'recording');
  assert.deepEqual(flow.state().localRecordings, []);
  assert.equal(flow.state().recordingLostOnRestore, true);
  await assert.rejects(flow.playRecording(1, 1), { code: 'LOCAL_RECORDING_UNAVAILABLE' });
});

test('full Speaking response guard rejects hidden answer fields without scanning ordinary task prose', () => {
  const flow = createSpeakingFullBrowserFlow({ api: {} });
  const benign = {
    ...session(),
    task: { ...session().task, text: 'Describe how you checked the audio equipment.' },
  };

  assert.equal(flow.acceptSession(benign).task.text, benign.task.text);
  assert.throws(
    () => flow.acceptSession({ ...benign, task: { ...benign.task, rubric: ['hidden'] } }),
    { code: 'SPEAKING_FULL_RESPONSE_INVALID' },
  );
});

test('full Speaking preloads the pinned task 4 photo before its preparation stage', async () => {
  const task4 = {
    ...session(),
    current: { taskType: 4, responseNumber: 1 },
    task: {
      taskType: 4, preparationSeconds: 150, responseSeconds: 180, maxScore: 10,
      photoPair: { src: '/assets/speaking/task4-v1/pinned.png' },
    },
  };
  const loaded = [];
  class FakeImage {
    async decode() { loaded.push('decoded'); }
    set src(value) { loaded.push(value); queueMicrotask(() => this.onload?.()); }
  }
  const flow = createSpeakingFullBrowserFlow({ api: {}, Image: FakeImage });
  flow.acceptSession(task4);
  await flow.prepareCurrentAssets();
  assert.deepEqual(loaded, ['/assets/speaking/task4-v1/pinned.png', 'decoded']);
  assert.equal(flow.state().assetStatus, 'ready');
});

test('full Speaking cancels a pending task 4 preload during route cleanup', async () => {
  const task4 = {
    ...session(),
    current: { taskType: 4, responseNumber: 1 },
    task: {
      taskType: 4, preparationSeconds: 150, responseSeconds: 180, maxScore: 10,
      photoPair: { src: '/assets/speaking/task4-v1/pending.png' },
    },
  };
  class PendingImage { set src(_value) {} }
  const flow = createSpeakingFullBrowserFlow({ api: {}, Image: PendingImage });
  flow.acceptSession(task4);
  const pending = flow.prepareCurrentAssets();

  flow.dispose();

  await assert.rejects(pending, { code: 'SPEAKING_TASK4_ASSET_CANCELLED' });
  assert.equal(flow.state().assetStatus, 'idle');
});
