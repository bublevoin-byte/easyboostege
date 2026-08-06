import { createSpeakingLocalRecorder } from './speaking-local-recording.js';

function flowError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function createSpeakingTask2BrowserFlow(options = {}) {
  const api = options.api;
  let session = null;
  let phase = 'idle';
  let recordingQuestion = null;
  const recordings = new Map();
  const playedQuestions = new Set();
  const localRecorder = createSpeakingLocalRecorder({
    ...options,
    onRecordingReady(recording) {
      if (!recordingQuestion) return;
      const previous = recordings.get(recordingQuestion);
      if (previous) localRecorder.revoke(previous);
      recordings.set(recordingQuestion, recording);
      phase = 'review';
    },
  });

  function state() {
    const mic = localRecorder.microphoneState();
    return Object.freeze({
      phase,
      sessionId: session?.id || null,
      task: session?.task || null,
      status: session?.status || null,
      currentQuestion: session?.currentQuestion || null,
      questions: session?.questions || [],
      micCheck: mic.status,
      micLevel: mic.level,
      currentRecording: session ? recordings.get(session.currentQuestion) || null : null,
      localRecordings: [...recordings.entries()].sort(([left], [right]) => left - right)
        .map(([questionNumber, recording]) => ({
          questionNumber, url: recording.url, durationSeconds: recording.durationSeconds,
        })),
      assessment: session?.assessment || {
        available: false,
        reason: 'deferred_to_tickets_06_07',
        message: 'Автоматическая оценка появится после подключения и методической проверки в следующих этапах.',
      },
    });
  }

  function acceptSession(next) {
    if (!next || next.task?.taskType !== 2 || next.task?.supports?.length !== 4
      || next.task?.preparationSeconds !== 60 || next.task?.questionSeconds !== 20
      || next.task?.maxScore !== 4 || next.questions?.length !== 4
      || !next.questions.every((question, index) => question?.questionNumber === index + 1
        && ['pending', 'completed'].includes(question.status))
      || !Number.isInteger(next.currentQuestion) || next.currentQuestion < 1 || next.currentQuestion > 4) {
      throw flowError('SPEAKING_TASK2_RESPONSE_INVALID', 'Speaking task 2 response is invalid');
    }
    session = next;
    phase = session.status === 'completed' ? 'completed' : 'ready';
    recordingQuestion = null;
    return session;
  }

  async function loadAssignment() {
    if (!api || typeof api.post !== 'function') throw flowError('SPEAKING_API_UNAVAILABLE', 'Speaking API is unavailable');
    return acceptSession(await api.post('/api/v1/speaking/task-2/sessions', {}));
  }

  async function restoreSession(sessionId) {
    if (!api || typeof api.get !== 'function') throw flowError('SPEAKING_API_UNAVAILABLE', 'Speaking API is unavailable');
    return acceptSession(await api.get(`/api/v1/speaking/task-2/sessions/${sessionId}`));
  }

  const checkMicrophone = () => localRecorder.checkMicrophone();

  async function startQuestion() {
    if (!session) throw flowError('SPEAKING_ASSIGNMENT_REQUIRED', 'Load an assignment first');
    if (session.status === 'completed') throw flowError('SPEAKING_TASK2_COMPLETED', 'All four questions are complete');
    recordingQuestion = session.currentQuestion;
    await localRecorder.start(session.task.questionSeconds);
    phase = 'recording';
    return state();
  }

  async function stopQuestion() {
    try {
      return await localRecorder.stop();
    } catch (error) {
      const recovered = recordings.get(recordingQuestion);
      if (recovered && error?.code === 'RECORDING_NOT_ACTIVE') return { ...recovered };
      throw error;
    }
  }

  async function playQuestion(questionNumber) {
    const recording = recordings.get(questionNumber);
    if (!recording) throw flowError('LOCAL_RECORDING_UNAVAILABLE', 'Local recording is unavailable');
    await localRecorder.play(recording);
    playedQuestions.add(questionNumber);
    return true;
  }

  async function completeQuestion(selfRating) {
    if (!session) throw flowError('SPEAKING_ASSIGNMENT_REQUIRED', 'Load an assignment first');
    const questionNumber = session.currentQuestion;
    const recording = recordings.get(questionNumber);
    if (!recording) throw flowError('LOCAL_RECORDING_UNAVAILABLE', 'Record the current question first');
    session = await api.post(
      `/api/v1/speaking/task-2/sessions/${session.id}/questions/${questionNumber}/complete`,
      {
        recordingDurationSeconds: recording.durationSeconds,
        localPlayback: playedQuestions.has(questionNumber),
        selfRating,
      },
    );
    phase = session.status === 'completed' ? 'completed' : 'ready';
    recordingQuestion = null;
    return session;
  }

  function dispose() {
    localRecorder.dispose();
    recordings.forEach((recording) => localRecorder.revoke(recording));
    recordings.clear();
    playedQuestions.clear();
    session = null;
    recordingQuestion = null;
    phase = 'idle';
  }

  return Object.freeze({
    state, loadAssignment, restoreSession, checkMicrophone,
    startQuestion, stopQuestion, playQuestion, completeQuestion, dispose,
  });
}
