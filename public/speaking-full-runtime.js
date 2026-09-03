import { createSpeakingLocalRecorder } from './speaking-local-recording.js';
import { isSpeakingAssessmentPending } from './speaking-assessment-contract.js';

function flowError(code, message) {
  return Object.assign(new Error(message), { code });
}

function recordingKey(taskType, responseNumber) {
  return `${taskType}:${responseNumber}`;
}

function responseLimit(task) {
  return Number(task?.responseSeconds ?? task?.questionSeconds);
}

function containsForbiddenAnswerField(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);
  return Object.entries(value).some(([key, nested]) => {
    const normalized = key.replace(/[_-]/gu, '').toLowerCase();
    return normalized === 'readyanswer'
      || normalized === 'reference'
      || normalized === 'referenceanswer'
      || normalized === 'rubric'
      || normalized === 'analysis'
      || normalized.startsWith('transcript')
      || normalized.startsWith('audio')
      || containsForbiddenAnswerField(nested, seen);
  });
}

function assertSafeSession(next, expectedId = null) {
  const assessmentPending = next?.earnedScore === null
    && isSpeakingAssessmentPending(next?.assessment);
  const assessmentScored = Number.isInteger(next?.earnedScore)
    && next.earnedScore >= 0 && next.earnedScore <= 20
    && next?.assessment?.available === true
    && next.assessment.mode === 'automatic_training'
    && next.assessment.scoreKind === 'approximate'
    && next.assessment.methodicallyValidated === false;
  if (!next?.id || next.mode !== 'full_section'
    || expectedId && next.id !== expectedId
    || !['in_progress', 'submitted'].includes(next.status)
    || !['ready', 'preparing', 'recording', 'ready_to_submit', 'submitted'].includes(next.phase)
    || next.maximumScore !== 20 || (!assessmentPending && !assessmentScored)
    || !Array.isArray(next.progress) || next.progress.length !== 4
    || next.progress.some((item, index) => item.taskType !== index + 1
      || item.maximumScore !== [1, 4, 5, 10][index])
    || (next.current && (next.current.taskType !== next.task?.taskType
      || !Number.isInteger(next.current.responseNumber)))
    || containsForbiddenAnswerField(next)) {
    throw flowError('SPEAKING_FULL_RESPONSE_INVALID', 'Full Speaking response is invalid');
  }
  return next;
}

export function createSpeakingFullBrowserFlow(options = {}) {
  const api = options.api;
  const Image = options.Image || globalThis.Image;
  const prepareAssessmentRecording = options.prepareAssessmentRecording;
  let session = null;
  let activePosition = null;
  let recording = null;
  let isRecording = false;
  let recordingLostOnRestore = false;
  let assetStatus = 'idle';
  let assetPromise = null;
  let assetGeneration = 0;
  let cancelAssetLoad = null;
  const recordings = new Map();
  const localRecorder = createSpeakingLocalRecorder({
    ...options,
    onRecordingReady(nextRecording) { recording = nextRecording; isRecording = false; },
  });

  function resetAssetLoad() {
    const cancel = cancelAssetLoad;
    assetGeneration += 1;
    cancelAssetLoad = null;
    assetPromise = null;
    assetStatus = 'idle';
    cancel?.(flowError('SPEAKING_TASK4_ASSET_CANCELLED', 'Photo pair loading was cancelled'));
  }

  function state() {
    const microphone = localRecorder.microphoneState();
    return Object.freeze({
      session,
      micCheck: microphone.status,
      micLevel: microphone.level,
      recording: recording ? { url: recording.url, durationSeconds: recording.durationSeconds } : null,
      isRecording,
      localRecordings: [...recordings.entries()].map(([key, value]) => ({
        taskType: Number(key.split(':')[0]),
        responseNumber: Number(key.split(':')[1]),
        url: value.url,
        durationSeconds: value.durationSeconds,
      })),
      recordingLostOnRestore,
      assetStatus,
    });
  }

  function acceptSession(next, expectedId = null) {
    const previousAsset = session?.task?.photoPair?.src || null;
    const nextAsset = next?.task?.photoPair?.src || null;
    if (previousAsset !== nextAsset) resetAssetLoad();
    session = assertSafeSession(next, expectedId);
    recordingLostOnRestore = session.phase === 'recording' && !recording;
    return session;
  }

  async function loadAssignment() {
    if (typeof api?.post !== 'function') throw flowError('SPEAKING_API_UNAVAILABLE', 'Speaking API is unavailable');
    return acceptSession(await api.post('/api/v1/speaking/full-sessions', {}));
  }

  async function restoreSession(sessionId) {
    if (typeof api?.get !== 'function') throw flowError('SPEAKING_API_UNAVAILABLE', 'Speaking API is unavailable');
    return acceptSession(await api.get(`/api/v1/speaking/full-sessions/${sessionId}`), sessionId);
  }

  const checkMicrophone = () => localRecorder.checkMicrophone();

  function prepareCurrentAssets() {
    if (!session?.task) return Promise.reject(flowError('SPEAKING_ASSIGNMENT_REQUIRED', 'Load the full section first'));
    if (session.task.taskType !== 4) {
      assetStatus = 'ready';
      return Promise.resolve(true);
    }
    if (assetStatus === 'ready') return Promise.resolve(true);
    if (assetPromise) return assetPromise;
    if (typeof Image !== 'function') {
      assetStatus = 'error';
      return Promise.reject(flowError('SPEAKING_TASK4_ASSET_UNAVAILABLE', 'Photo pair cannot be loaded'));
    }
    assetStatus = 'loading';
    const generation = ++assetGeneration;
    assetPromise = new Promise((resolve, reject) => {
      cancelAssetLoad = reject;
      const image = new Image();
      image.onload = async () => {
        try {
          if (typeof image.decode === 'function') await image.decode();
          if (generation !== assetGeneration) return;
          cancelAssetLoad = null;
          assetPromise = null;
          assetStatus = 'ready';
          resolve(true);
        } catch {
          if (generation !== assetGeneration) return;
          cancelAssetLoad = null;
          assetPromise = null;
          assetStatus = 'error';
          reject(flowError('SPEAKING_TASK4_ASSET_UNAVAILABLE', 'Photo pair cannot be decoded'));
        }
      };
      image.onerror = () => {
        if (generation !== assetGeneration) return;
        cancelAssetLoad = null;
        assetPromise = null;
        assetStatus = 'error';
        reject(flowError('SPEAKING_TASK4_ASSET_UNAVAILABLE', 'Photo pair cannot be loaded'));
      };
      image.src = session.task.photoPair.src;
    });
    return assetPromise;
  }

  async function beginStage() {
    if (!session) throw flowError('SPEAKING_ASSIGNMENT_REQUIRED', 'Load the full section first');
    return acceptSession(await api.post(`/api/v1/speaking/full-sessions/${session.id}/stage`, {}), session.id);
  }

  async function startRecording() {
    if (!session?.current || !session.task) throw flowError('SPEAKING_FULL_STAGE_INVALID', 'No response is active');
    if (session.phase !== 'recording') await beginStage();
    if (session.phase !== 'recording') throw flowError('SPEAKING_FULL_STAGE_INVALID', 'Recording stage did not start');
    if (session.task.taskType === 4 && assetStatus !== 'ready') {
      throw flowError('SPEAKING_TASK4_ASSET_NOT_READY', 'Wait for the photo pair to load');
    }
    activePosition = { ...session.current };
    if (recording) localRecorder.revoke(recording);
    recording = null;
    const limit = responseLimit(session.task);
    await localRecorder.start(limit);
    isRecording = true;
    recordingLostOnRestore = false;
    return state();
  }

  async function stopRecording() {
    try {
      const stopped = await localRecorder.stop();
      isRecording = false;
      return stopped;
    } catch (error) {
      if (recording && error?.code === 'RECORDING_NOT_ACTIVE') return { ...recording };
      throw error;
    }
  }

  async function playRecording(taskType, responseNumber) {
    const local = recordings.get(recordingKey(taskType, responseNumber));
    if (!local) throw flowError('LOCAL_RECORDING_UNAVAILABLE', 'Local recording is unavailable');
    await localRecorder.play(local);
    return true;
  }

  function assessmentRecordings() {
    return [...recordings.entries()].map(([key, value]) => ({
      taskType: Number(key.split(':')[0]),
      responseNumber: Number(key.split(':')[1]),
      blob: value.assessment?.blob || value.blob,
      durationSeconds: value.assessment?.durationSeconds || value.durationSeconds,
      sha256: value.assessment?.sha256 || null,
    }));
  }

  async function completeResponse(responseStatus, technicalIssueCode = null) {
    if (!session?.current) throw flowError('SPEAKING_FULL_STAGE_INVALID', 'No response is active');
    const position = activePosition || { ...session.current };
    if (position.taskType !== session.current.taskType
      || position.responseNumber !== session.current.responseNumber) {
      throw flowError('SPEAKING_FULL_RESPONSE_OUT_OF_SEQUENCE', 'Response position changed');
    }
    if (responseStatus === 'completed' && !recording) {
      throw flowError('LOCAL_RECORDING_UNAVAILABLE', 'Record the response first');
    }
    let assessment = null;
    if (responseStatus === 'completed' && typeof prepareAssessmentRecording === 'function') {
      try {
        const candidate = await prepareAssessmentRecording(recording);
        if (candidate?.blob && Number.isFinite(candidate.durationSeconds)
          && /^[0-9a-f]{64}$/u.test(candidate.sha256)) assessment = candidate;
      } catch {}
    }
    const body = {
      taskType: position.taskType,
      responseNumber: position.responseNumber,
      responseStatus,
      recordingDurationSeconds: responseStatus === 'completed' ? recording.durationSeconds : 0,
      micCheck: localRecorder.microphoneState().status,
      localPlayback: false,
      ...(technicalIssueCode ? { technicalIssueCode } : {}),
      ...(assessment ? { assessmentAudioSha256: assessment.sha256 } : {}),
    };
    const previousSessionId = session.id;
    const next = await api.post(`/api/v1/speaking/full-sessions/${previousSessionId}/responses`, body);
    if (recording) {
      const key = recordingKey(position.taskType, position.responseNumber);
      const old = recordings.get(key);
      if (old) localRecorder.revoke(old);
      recordings.set(key, { ...recording, ...(assessment ? { assessment } : {}) });
    }
    recording = null;
    isRecording = false;
    activePosition = null;
    return acceptSession(next, previousSessionId);
  }

  async function submit(idempotencyKey) {
    if (!session) throw flowError('SPEAKING_ASSIGNMENT_REQUIRED', 'Load the full section first');
    return api.post(`/api/v1/speaking/full-sessions/${session.id}/submit`, { idempotencyKey });
  }

  function dispose() {
    localRecorder.dispose();
    if (recording) localRecorder.revoke(recording);
    recordings.forEach((item) => localRecorder.revoke(item));
    recordings.clear();
    recording = null;
    isRecording = false;
    activePosition = null;
    recordingLostOnRestore = false;
    resetAssetLoad();
    session = null;
  }

  return Object.freeze({
    state, acceptSession, loadAssignment, restoreSession, checkMicrophone,
    prepareCurrentAssets, beginStage, startRecording, stopRecording, playRecording,
    assessmentRecordings, completeResponse, submit, dispose,
  });
}
