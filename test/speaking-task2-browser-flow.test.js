import assert from 'node:assert/strict';
import test from 'node:test';

import { createSpeakingLocalRecorder } from '../public/speaking-local-recording.js';
import { createSpeakingTask2BrowserFlow } from '../public/speaking-task2-runtime.js';

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
    this.ondataavailable?.({ data: new Blob(['local direct question'], { type: this.mimeType }) });
    this.onstop?.();
  }
}

function assignedSession() {
  return {
    id: '72200000-0000-4000-8000-000000000001',
    task: {
      id: 'speaking-pilot-v1.task2.weekend-pottery', revision: 1, taskType: 2,
      preparationSeconds: 60, questionSeconds: 20, maxScore: 4, cefr: 'B1',
      topic: 'Творческие курсы', instruction: 'Ask four questions.',
      advertisement: 'An original server-owned advertisement for a pottery weekend.',
      supports: ['course dates', 'participation fee', 'group size', 'tools provided'],
    },
    status: 'assigned',
    currentQuestion: 1,
    questions: Array.from({ length: 4 }, (_, index) => ({ questionNumber: index + 1, status: 'pending' })),
    assessment: { available: false, reason: 'deferred_to_tickets_06_07', message: 'Later.' },
  };
}

test('browser task 2 flow records and completes four local questions without uploading content', async () => {
  const requests = [];
  const streams = [];
  const played = [];
  let urlIndex = 0;
  let currentTime = 1_000;
  let session = assignedSession();
  const flow = createSpeakingTask2BrowserFlow({
    api: {
      async post(path, body) {
        requests.push({ path, body });
        if (path === '/api/v1/speaking/task-2/sessions') return session;
        const questionNumber = Number(path.match(/questions\/(\d+)\/complete$/u)?.[1]);
        session = structuredClone(session);
        session.questions[questionNumber - 1] = { questionNumber, status: 'completed', ...body };
        session.currentQuestion = Math.min(4, questionNumber + 1);
        session.status = questionNumber === 4 ? 'completed' : 'in_progress';
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
    URL: { createObjectURL: () => `blob:task2-question-${++urlIndex}`, revokeObjectURL() {} },
    Blob,
    now: () => currentTime,
    sampleMicrophone: async () => 0.2,
    setTimeout: () => 1,
    clearTimeout() {},
  });

  assert.equal((await flow.loadAssignment()).currentQuestion, 1);
  assert.deepEqual(await flow.checkMicrophone(), { status: 'passed', level: 0.2 });
  assert.equal(streams[0].track.stopped, true);

  for (let questionNumber = 1; questionNumber <= 4; questionNumber += 1) {
    await flow.startQuestion();
    assert.equal(flow.state().phase, 'recording');
    assert.equal(flow.state().currentQuestion, questionNumber);
    currentTime += (questionNumber + 10) * 1_000;
    const recording = await flow.stopQuestion();
    assert.equal(recording.durationSeconds, questionNumber + 10);
    assert.equal(recording.url, `blob:task2-question-${questionNumber}`);
    await flow.playQuestion(questionNumber);
    const completed = await flow.completeQuestion('steady');
    assert.equal(completed.questions.filter((question) => question.status === 'completed').length, questionNumber);
  }

  assert.equal(flow.state().phase, 'completed');
  assert.equal(flow.state().localRecordings.length, 4);
  assert.deepEqual(
    flow.assessmentRecordings().map(({ positionNumber, durationSeconds, blob }) => ({
      positionNumber, durationSeconds, text: blob.size > 0,
    })),
    [1, 2, 3, 4].map((positionNumber) => ({
      positionNumber, durationSeconds: positionNumber + 10, text: true,
    })),
  );
  assert.deepEqual(played, [
    'blob:task2-question-1', 'blob:task2-question-2', 'blob:task2-question-3', 'blob:task2-question-4',
  ]);
  assert.deepEqual(requests.map(({ path, body }) => ({ path, body })), [
    { path: '/api/v1/speaking/task-2/sessions', body: {} },
    ...[1, 2, 3, 4].map((questionNumber) => ({
      path: `/api/v1/speaking/task-2/sessions/${session.id}/questions/${questionNumber}/complete`,
      body: { recordingDurationSeconds: questionNumber + 10, localPlayback: true, selfRating: 'steady' },
    })),
  ]);
  assert.equal(JSON.stringify(requests).includes('local direct question'), false);
  assert.equal(JSON.stringify(requests).includes('blob:'), false);
  await assert.rejects(flow.startQuestion(), { code: 'SPEAKING_TASK2_COMPLETED' });
});

test('browser task 2 flow restores the server current question without inventing recovered audio', async () => {
  const session = assignedSession();
  session.status = 'in_progress';
  session.currentQuestion = 3;
  session.questions[0] = { questionNumber: 1, status: 'completed', recordingDurationSeconds: 12, localPlayback: true, selfRating: 'steady' };
  session.questions[1] = { questionNumber: 2, status: 'completed', recordingDurationSeconds: 13, localPlayback: false, selfRating: 'weak' };

  const flow = createSpeakingTask2BrowserFlow({
    api: { async get(path) {
      assert.equal(path, `/api/v1/speaking/task-2/sessions/${session.id}`);
      return session;
    } },
  });

  const restored = await flow.restoreSession(session.id);
  assert.equal(restored.currentQuestion, 3);
  assert.equal(flow.state().phase, 'ready');
  assert.equal(flow.state().currentQuestion, 3);
  assert.deepEqual(flow.state().localRecordings, []);
  assert.throws(() => flow.assessmentRecordings(), { code: 'SPEAKING_ASSESSMENT_RECORDINGS_INCOMPLETE' });
  await assert.rejects(flow.playQuestion(1), { code: 'LOCAL_RECORDING_UNAVAILABLE' });
});

test('browser task 2 flow coalesces automatic and screen stop at the 20-second boundary', async () => {
  let automaticStop;
  let currentTime = 1_000;
  class AsyncStopMediaRecorder extends FakeMediaRecorder {
    stop() {
      this.state = 'inactive';
      queueMicrotask(() => {
        this.ondataavailable?.({ data: new Blob(['complete question'], { type: this.mimeType }) });
        this.onstop?.();
      });
    }
  }
  const flow = createSpeakingTask2BrowserFlow({
    api: { async post() { return assignedSession(); } },
    mediaDevices: { async getUserMedia() { return fakeStream(); } },
    MediaRecorder: AsyncStopMediaRecorder,
    URL: { createObjectURL: () => 'blob:complete-task2-question', revokeObjectURL() {} },
    Blob,
    now: () => currentTime,
    sampleMicrophone: async () => 0.2,
    setTimeout(callback) { automaticStop = callback; return 1; },
    clearTimeout() {},
  });

  await flow.loadAssignment();
  await flow.checkMicrophone();
  await flow.startQuestion();
  currentTime += 20_000;
  automaticStop();
  const recording = await flow.stopQuestion();

  assert.equal(recording.durationSeconds, 20);
  assert.equal(recording.url, 'blob:complete-task2-question');
  assert.equal(flow.state().phase, 'review');
});

test('shared local recorder releases the microphone and blob URL when finalization fails', async () => {
  const streams = [];
  const revoked = [];
  let currentTime = 1_000;
  const recorder = createSpeakingLocalRecorder({
    mediaDevices: { async getUserMedia() { const stream = fakeStream(); streams.push(stream); return stream; } },
    MediaRecorder: FakeMediaRecorder,
    URL: {
      createObjectURL: () => 'blob:failed-finalization',
      revokeObjectURL: (url) => revoked.push(url),
    },
    Blob,
    now: () => currentTime,
    sampleMicrophone: async () => 0.2,
    setTimeout: () => 1,
    clearTimeout() {},
    onRecordingReady() { throw new Error('recording callback failed'); },
  });

  await recorder.checkMicrophone();
  await recorder.start(20);
  currentTime += 5_000;

  await assert.rejects(recorder.stop(), /recording callback failed/u);
  assert.equal(streams[1].track.stopped, true);
  assert.deepEqual(revoked, ['blob:failed-finalization']);
});
