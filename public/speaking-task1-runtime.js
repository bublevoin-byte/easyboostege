import { createSpeakingLocalRecorder } from './speaking-local-recording.js';

function flowError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function createSpeakingTask1BrowserFlow(options = {}) {
  const api = options.api;
  let session = null;
  let phase = 'idle';
  let recording = null;
  let localPlayback = false;
  const localRecorder = createSpeakingLocalRecorder({
    ...options,
    onRecordingReady(nextRecording) {
      recording = nextRecording;
      phase = 'review';
    },
  });

  function state() {
    const mic = localRecorder.microphoneState();
    return Object.freeze({
      phase,
      sessionId: session?.id || null,
      task: session?.task || null,
      micCheck: mic.status,
      micLevel: mic.level,
      recording: recording ? { url: recording.url, durationSeconds: recording.durationSeconds } : null,
      localPlayback,
      pronunciationAssessment: session?.pronunciationAssessment || {
        available: false,
        reason: 'provider_not_connected',
        message: 'Оценка произношения пока не подключена.',
      },
    });
  }

  async function loadAssignment() {
    if (!api || typeof api.post !== 'function') throw flowError('SPEAKING_API_UNAVAILABLE', 'Speaking API is unavailable');
    session = await api.post('/api/v1/speaking/task-1/sessions', {});
    phase = 'assigned';
    return session;
  }

  const checkMicrophone = () => localRecorder.checkMicrophone();

  function releaseRecording() {
    localRecorder.revoke(recording);
    recording = null;
    localPlayback = false;
  }

  async function startRecording() {
    if (!session) throw flowError('SPEAKING_ASSIGNMENT_REQUIRED', 'Load an assignment first');
    releaseRecording();
    await localRecorder.start(session.task.responseSeconds);
    phase = 'recording';
    return state();
  }

  async function stopRecording() {
    try {
      return await localRecorder.stop();
    } catch (error) {
      if (recording && error?.code === 'RECORDING_NOT_ACTIVE') return { ...recording };
      throw error;
    }
  }

  async function playRecording() {
    await localRecorder.play(recording);
    localPlayback = true;
    return true;
  }

  async function complete(selfRating) {
    if (!session || !recording) throw flowError('LOCAL_RECORDING_UNAVAILABLE', 'Record an answer first');
    session = await api.post(`/api/v1/speaking/task-1/sessions/${session.id}/complete`, {
      recordingDurationSeconds: recording.durationSeconds,
      micCheck: localRecorder.microphoneState().status,
      localPlayback,
      selfRating,
    });
    phase = 'completed';
    return session;
  }

  function dispose() {
    localRecorder.dispose();
    releaseRecording();
    session = null;
    phase = 'idle';
  }

  return Object.freeze({
    state, loadAssignment, checkMicrophone, startRecording,
    stopRecording, playRecording, complete, dispose,
  });
}
