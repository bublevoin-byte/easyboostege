import assert from 'node:assert/strict';
import test from 'node:test';

import { createSpeakingTask3BrowserFlow } from '../public/speaking-task3-runtime.js';

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
    this.ondataavailable?.({ data: new Blob(['local interview answer'], { type: this.mimeType }) });
    this.onstop?.();
  }
}

function assignedSession() {
  return {
    id: '73300000-0000-4000-8000-000000000001',
    task: {
      id: 'speaking-pilot-v1.task3.free-time-routines', revision: 1, taskType: 3,
      preparationSeconds: 0, questionSeconds: 40, maxScore: 5, cefr: 'B1',
      topic: 'Свободное время', instruction: 'Give five full answers.',
      questions: Array.from({ length: 5 }, (_, index) => `Original interview question number ${index + 1}?`),
    },
    status: 'assigned',
    currentQuestion: 1,
    answers: Array.from({ length: 5 }, (_, index) => ({ questionNumber: index + 1, status: 'pending' })),
    assessment: { available: false, reason: 'not_requested', message: 'Later.' },
  };
}

test('browser task 3 flow records and completes five local answers without uploading content', async () => {
  const requests = [];
  const streams = [];
  const played = [];
  let urlIndex = 0;
  let currentTime = 1_000;
  let session = assignedSession();
  const flow = createSpeakingTask3BrowserFlow({
    api: {
      async post(path, body) {
        requests.push({ path, body });
        if (path === '/api/v1/speaking/task-3/sessions') return session;
        const questionNumber = Number(path.match(/answers\/(\d+)\/complete$/u)?.[1]);
        session = structuredClone(session);
        session.answers[questionNumber - 1] = { questionNumber, status: 'completed', ...body };
        session.currentQuestion = Math.min(5, questionNumber + 1);
        session.status = questionNumber === 5 ? 'completed' : 'in_progress';
        return session;
      },
    },
    mediaDevices: { async getUserMedia() { const stream = fakeStream(); streams.push(stream); return stream; } },
    MediaRecorder: FakeMediaRecorder,
    Audio: class {
      constructor(url) { this.url = url; }
      async play() { played.push(this.url); }
      pause() {}
    },
    URL: { createObjectURL: () => `blob:task3-answer-${++urlIndex}`, revokeObjectURL() {} },
    Blob,
    now: () => currentTime,
    sampleMicrophone: async () => 0.2,
    setTimeout: () => 1,
    clearTimeout() {},
  });

  assert.equal((await flow.loadAssignment()).currentQuestion, 1);
  assert.deepEqual(await flow.checkMicrophone(), { status: 'passed', level: 0.2 });
  assert.equal(streams[0].track.stopped, true);

  for (let questionNumber = 1; questionNumber <= 5; questionNumber += 1) {
    await flow.startAnswer();
    assert.equal(flow.state().phase, 'recording');
    assert.equal(flow.state().currentQuestion, questionNumber);
    currentTime += (questionNumber + 20) * 1_000;
    const recording = await flow.stopAnswer();
    assert.equal(recording.durationSeconds, questionNumber + 20);
    assert.equal(recording.url, `blob:task3-answer-${questionNumber}`);
    await flow.playAnswer(questionNumber);
    const completed = await flow.completeAnswer('steady');
    assert.equal(completed.answers.filter((answer) => answer.status === 'completed').length, questionNumber);
  }

  assert.equal(flow.state().phase, 'completed');
  assert.equal(flow.state().localRecordings.length, 5);
  assert.deepEqual(played, [
    'blob:task3-answer-1', 'blob:task3-answer-2', 'blob:task3-answer-3',
    'blob:task3-answer-4', 'blob:task3-answer-5',
  ]);
  assert.deepEqual(requests, [
    { path: '/api/v1/speaking/task-3/sessions', body: {} },
    ...[1, 2, 3, 4, 5].map((questionNumber) => ({
      path: `/api/v1/speaking/task-3/sessions/${session.id}/answers/${questionNumber}/complete`,
      body: { recordingDurationSeconds: questionNumber + 20, localPlayback: true, selfRating: 'steady' },
    })),
  ]);
  assert.equal(JSON.stringify(requests).includes('local interview answer'), false);
  assert.equal(JSON.stringify(requests).includes('blob:'), false);
  await assert.rejects(flow.startAnswer(), { code: 'SPEAKING_TASK3_COMPLETED' });
});

test('browser task 3 flow restores exact server progress without inventing recovered audio', async () => {
  const session = assignedSession();
  session.status = 'in_progress';
  session.currentQuestion = 4;
  session.answers[0] = { questionNumber: 1, status: 'completed', recordingDurationSeconds: 22, localPlayback: true, selfRating: 'steady' };
  session.answers[1] = { questionNumber: 2, status: 'completed', recordingDurationSeconds: 23, localPlayback: false, selfRating: 'weak' };
  session.answers[2] = { questionNumber: 3, status: 'completed', recordingDurationSeconds: 24, localPlayback: true, selfRating: 'strong' };

  const flow = createSpeakingTask3BrowserFlow({
    api: { async get(path) {
      assert.equal(path, `/api/v1/speaking/task-3/sessions/${session.id}`);
      return session;
    } },
  });

  const restored = await flow.restoreSession(session.id);
  assert.equal(restored.currentQuestion, 4);
  assert.equal(flow.state().phase, 'ready');
  assert.equal(flow.state().currentQuestion, 4);
  assert.deepEqual(flow.state().localRecordings, []);
  await assert.rejects(flow.playAnswer(1), { code: 'LOCAL_RECORDING_UNAVAILABLE' });
});

test('browser task 3 flow coalesces automatic and screen stop at the 40-second boundary', async () => {
  let automaticStop;
  let currentTime = 1_000;
  class AsyncStopMediaRecorder extends FakeMediaRecorder {
    stop() {
      this.state = 'inactive';
      queueMicrotask(() => {
        this.ondataavailable?.({ data: new Blob(['complete answer'], { type: this.mimeType }) });
        this.onstop?.();
      });
    }
  }
  const flow = createSpeakingTask3BrowserFlow({
    api: { async post() { return assignedSession(); } },
    mediaDevices: { async getUserMedia() { return fakeStream(); } },
    MediaRecorder: AsyncStopMediaRecorder,
    URL: { createObjectURL: () => 'blob:complete-task3-answer', revokeObjectURL() {} },
    Blob,
    now: () => currentTime,
    sampleMicrophone: async () => 0.2,
    setTimeout(callback) { automaticStop = callback; return 1; },
    clearTimeout() {},
  });

  await flow.loadAssignment();
  await flow.checkMicrophone();
  await flow.startAnswer();
  currentTime += 40_000;
  automaticStop();
  const recording = await flow.stopAnswer();

  assert.equal(recording.durationSeconds, 40);
  assert.equal(recording.url, 'blob:complete-task3-answer');
  assert.equal(flow.state().phase, 'review');
});

test('shared sequential flow rejects an inconsistent completion response without replacing valid state', async () => {
  let currentTime = 1_000;
  const original = assignedSession();
  const flow = createSpeakingTask3BrowserFlow({
    api: {
      async post(path) {
        if (path === '/api/v1/speaking/task-3/sessions') return original;
        const inconsistent = structuredClone(original);
        inconsistent.status = 'in_progress';
        inconsistent.currentQuestion = 2;
        return inconsistent;
      },
    },
    mediaDevices: { async getUserMedia() { return fakeStream(); } },
    MediaRecorder: FakeMediaRecorder,
    URL: { createObjectURL: () => 'blob:uncommitted-answer', revokeObjectURL() {} },
    Blob,
    now: () => currentTime,
    sampleMicrophone: async () => 0.2,
    setTimeout: () => 1,
    clearTimeout() {},
  });

  await flow.loadAssignment();
  await flow.checkMicrophone();
  await flow.startAnswer();
  currentTime += 10_000;
  await flow.stopAnswer();

  await assert.rejects(flow.completeAnswer('steady'), { code: 'SPEAKING_TASK3_RESPONSE_INVALID' });
  assert.equal(flow.state().phase, 'review');
  assert.equal(flow.state().status, 'assigned');
  assert.equal(flow.state().currentQuestion, 1);
});
