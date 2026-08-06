import assert from 'node:assert/strict';
import test from 'node:test';

import { createSpeakingTask1BrowserFlow } from '../public/speaking-task1-runtime.js';

function fakeStream() {
  const track = { readyState: 'live', stopped: false, stop() { this.stopped = true; } };
  return { track, getAudioTracks: () => [track], getTracks: () => [track] };
}

class FakeMediaRecorder {
  static isTypeSupported(type) { return type === 'audio/webm;codecs=opus'; }

  constructor(stream, options = {}) {
    this.stream = stream;
    this.mimeType = options.mimeType || 'audio/webm';
    this.state = 'inactive';
  }

  start() { this.state = 'recording'; }

  stop() {
    this.state = 'inactive';
    this.ondataavailable?.({ data: new Blob(['local voice'], { type: this.mimeType }) });
    this.onstop?.();
  }
}

test('browser task 1 flow checks the microphone, records for local review and completes with metadata only', async () => {
  const requests = [];
  const streams = [];
  const audio = [];
  let currentTime = 1_000;
  const session = {
    id: '71100000-0000-4000-8000-000000000001',
    task: {
      id: 'speaking-pilot-v1.task1.community-garden', revision: 1, taskType: 1,
      preparationSeconds: 90, responseSeconds: 90, maxScore: 1,
      cefr: 'B1', topic: 'Город и природа', instruction: 'Read aloud.', text: 'A valid assigned text.',
    },
    pronunciationAssessment: {
      available: false, reason: 'provider_not_connected', message: 'Оценка произношения пока не подключена.',
    },
  };
  const flow = createSpeakingTask1BrowserFlow({
    api: {
      async post(path, body) {
        requests.push({ path, body });
        return path.endsWith('/complete') ? { ...session, status: 'completed', practice: body } : session;
      },
    },
    mediaDevices: { async getUserMedia() { const stream = fakeStream(); streams.push(stream); return stream; } },
    MediaRecorder: FakeMediaRecorder,
    Audio: class {
      constructor(url) { this.url = url; audio.push(this); }
      async play() { this.played = true; }
      pause() { this.paused = true; }
    },
    URL: { createObjectURL: () => 'blob:local-speaking-task1', revokeObjectURL() {} },
    Blob,
    now: () => currentTime,
    sampleMicrophone: async () => 0.18,
    setTimeout: () => 91,
    clearTimeout() {},
  });

  assert.equal((await flow.loadAssignment()).task.id, session.task.id);
  assert.equal(flow.state().phase, 'assigned');
  assert.deepEqual(await flow.checkMicrophone(), { status: 'passed', level: 0.18 });
  assert.equal(streams[0].track.stopped, true);

  await flow.startRecording();
  assert.equal(flow.state().phase, 'recording');
  currentTime += 72_000;
  const recording = await flow.stopRecording();
  assert.equal(recording.url, 'blob:local-speaking-task1');
  assert.equal(recording.durationSeconds, 72);
  assert.equal(flow.state().phase, 'review');
  assert.equal(streams[1].track.stopped, true);

  await flow.playRecording();
  assert.equal(audio[0].played, true);
  const completed = await flow.complete('steady');
  assert.equal(completed.status, 'completed');
  assert.deepEqual(requests, [
    { path: '/api/v1/speaking/task-1/sessions', body: {} },
    {
      path: `/api/v1/speaking/task-1/sessions/${session.id}/complete`,
      body: {
        recordingDurationSeconds: 72, micCheck: 'passed', localPlayback: true, selfRating: 'steady',
      },
    },
  ]);
  assert.equal(JSON.stringify(requests).includes('local voice'), false);
  assert.equal(JSON.stringify(requests).includes('blob:'), false);
  assert.equal(flow.state().pronunciationAssessment.available, false);
});

test('browser task 1 flow releases the microphone when recorder construction fails', async () => {
  const streams = [];
  const flow = createSpeakingTask1BrowserFlow({
    api: { async post() {
      return {
        id: '71100000-0000-4000-8000-000000000002',
        task: { responseSeconds: 90 },
        pronunciationAssessment: { available: false, reason: 'provider_not_connected' },
      };
    } },
    mediaDevices: { async getUserMedia() { const stream = fakeStream(); streams.push(stream); return stream; } },
    MediaRecorder: class { constructor() { throw new Error('recorder construction failed'); } },
    sampleMicrophone: async () => 0.18,
    setTimeout: () => 1,
    clearTimeout() {},
  });

  await flow.loadAssignment();
  await flow.checkMicrophone();
  await assert.rejects(flow.startRecording(), /recorder construction failed/u);
  assert.equal(streams[1].track.stopped, true);
  assert.equal(flow.state().phase, 'assigned');
});

test('browser task 1 flow coalesces the automatic and screen stop at the 90-second boundary', async () => {
  let automaticStop;
  let currentTime = 1_000;
  class AsyncStopMediaRecorder extends FakeMediaRecorder {
    stop() {
      this.state = 'inactive';
      queueMicrotask(() => {
        this.ondataavailable?.({ data: new Blob(['complete local voice'], { type: this.mimeType }) });
        this.onstop?.();
      });
    }
  }
  const flow = createSpeakingTask1BrowserFlow({
    api: { async post() {
      return {
        id: '71100000-0000-4000-8000-000000000003',
        task: { responseSeconds: 90 },
        pronunciationAssessment: { available: false, reason: 'provider_not_connected' },
      };
    } },
    mediaDevices: { async getUserMedia() { return fakeStream(); } },
    MediaRecorder: AsyncStopMediaRecorder,
    URL: { createObjectURL: () => 'blob:complete-local-voice', revokeObjectURL() {} },
    Blob,
    now: () => currentTime,
    sampleMicrophone: async () => 0.18,
    setTimeout(callback) { automaticStop = callback; return 1; },
    clearTimeout() {},
  });

  await flow.loadAssignment();
  await flow.checkMicrophone();
  await flow.startRecording();
  currentTime += 90_000;
  automaticStop();
  const recording = await flow.stopRecording();

  assert.equal(recording.url, 'blob:complete-local-voice');
  assert.equal(recording.durationSeconds, 90);
  assert.equal(flow.state().phase, 'review');
});
