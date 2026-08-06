import { createSpeakingLocalRecorder } from './speaking-local-recording.js';

function flowError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function acceptTask4Session(next) {
  const task = next?.task;
  if (!next?.id || !['assigned', 'completed'].includes(next.status)
    || !task || typeof task !== 'object' || Array.isArray(task)
    || Object.keys(task).sort().join(',') !== 'cefr,id,instruction,maxScore,photoPair,plan,preparationSeconds,projectTitle,responseSeconds,revision,taskType,topic'
    || task?.taskType !== 4 || task.revision !== 1
    || !/^speaking-pilot-v1\.task4\.[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(String(task.id || ''))
    || task.preparationSeconds !== 150 || task.responseSeconds !== 180 || task.maxScore !== 10
    || !['B1', 'B2', 'B2+/C1'].includes(task.cefr)
    || typeof task.topic !== 'string' || !task.topic.trim()
    || typeof task.projectTitle !== 'string' || !task.projectTitle.trim()
    || typeof task.instruction !== 'string' || !task.instruction.trim()
    || !Array.isArray(task.plan) || task.plan.length !== 4
    || task.plan.some((point) => typeof point !== 'string' || !point.trim())
    || !task.photoPair || typeof task.photoPair !== 'object' || Array.isArray(task.photoPair)
    || Object.keys(task.photoPair).sort().join(',') !== 'alt,assetId,panels,src'
    || !/^speaking-task4-photo-pair\.[a-z0-9]+(?:-[a-z0-9]+)*\.v1$/u.test(String(task.photoPair.assetId || ''))
    || !/^\/assets\/speaking\/task4-v1\/[a-z0-9]+(?:-[a-z0-9]+)*\.png$/u.test(String(task.photoPair.src || ''))
    || typeof task.photoPair.alt !== 'string' || !task.photoPair.alt.trim()
    || !Array.isArray(task.photoPair.panels) || task.photoPair.panels.length !== 2
    || task.photoPair.panels.some((panel, index) => !panel || typeof panel !== 'object'
      || Array.isArray(panel) || Object.keys(panel).sort().join(',') !== 'alt,number'
      || panel.number !== index + 1 || typeof panel.alt !== 'string' || !panel.alt.trim())
    || next.assessment?.available !== false
    || next.assessment.reason !== 'deferred_to_tickets_06_07') {
    throw flowError('SPEAKING_TASK4_RESPONSE_INVALID', 'Speaking task 4 response is invalid');
  }
  return next;
}

export function createSpeakingTask4BrowserFlow(options = {}) {
  const api = options.api;
  const Image = options.Image || globalThis.Image;
  let session = null;
  let phase = 'idle';
  let recording = null;
  let localPlayback = false;
  let assetStatus = 'idle';
  let assetPromise = null;
  let assetGeneration = 0;
  let pendingImage = null;
  let pendingAssetReject = null;
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
      phase, sessionId: session?.id || null, task: session?.task || null,
      status: session?.status || null, assetStatus,
      micCheck: mic.status, micLevel: mic.level,
      recording: recording ? { url: recording.url, durationSeconds: recording.durationSeconds } : null,
      localPlayback,
      assessment: session?.assessment || {
        available: false, reason: 'deferred_to_tickets_06_07',
        message: 'Automatic assessment is not available yet.',
      },
    });
  }

  function setSession(next) {
    assetGeneration += 1;
    session = acceptTask4Session(next);
    phase = session.status === 'completed' ? 'completed' : 'assigned';
    assetStatus = 'idle';
    assetPromise = null;
    return session;
  }

  async function loadAssignment() {
    if (!api || typeof api.post !== 'function') throw flowError('SPEAKING_API_UNAVAILABLE', 'Speaking API is unavailable');
    return setSession(await api.post('/api/v1/speaking/task-4/sessions', {}));
  }

  async function restoreSession(sessionId) {
    if (!api || typeof api.get !== 'function') throw flowError('SPEAKING_API_UNAVAILABLE', 'Speaking API is unavailable');
    return setSession(await api.get(`/api/v1/speaking/task-4/sessions/${sessionId}`));
  }

  function prepareAssets() {
    if (!session) return Promise.reject(flowError('SPEAKING_ASSIGNMENT_REQUIRED', 'Load an assignment first'));
    if (assetStatus === 'ready') return Promise.resolve(true);
    if (assetPromise) return assetPromise;
    if (typeof Image !== 'function') {
      assetStatus = 'error';
      return Promise.reject(flowError('SPEAKING_TASK4_ASSET_UNAVAILABLE', 'Photo pair cannot be loaded'));
    }
    assetStatus = 'loading';
    const generation = ++assetGeneration;
    assetPromise = new Promise((resolve, reject) => {
      const image = new Image();
      pendingImage = image;
      pendingAssetReject = reject;
      image.onload = async () => {
        try {
          if (typeof image.decode === 'function') await image.decode();
          if (generation !== assetGeneration) return;
          pendingImage = null;
          pendingAssetReject = null;
          assetStatus = 'ready';
          resolve(true);
        } catch {
          if (generation !== assetGeneration) return;
          pendingImage = null;
          pendingAssetReject = null;
          assetStatus = 'error';
          reject(flowError('SPEAKING_TASK4_ASSET_UNAVAILABLE', 'Photo pair cannot be decoded'));
        }
      };
      image.onerror = () => {
        if (generation !== assetGeneration) return;
        pendingImage = null;
        pendingAssetReject = null;
        assetStatus = 'error';
        reject(flowError('SPEAKING_TASK4_ASSET_UNAVAILABLE', 'Photo pair cannot be loaded'));
      };
      image.src = session.task.photoPair.src;
    }).finally(() => { assetPromise = null; });
    return assetPromise;
  }

  const checkMicrophone = () => localRecorder.checkMicrophone();

  function releaseRecording() {
    localRecorder.revoke(recording);
    recording = null;
    localPlayback = false;
  }

  async function startRecording() {
    if (!session) throw flowError('SPEAKING_ASSIGNMENT_REQUIRED', 'Load an assignment first');
    if (session.status === 'completed') throw flowError('SPEAKING_TASK4_COMPLETED', 'This session is complete');
    if (assetStatus !== 'ready') throw flowError('SPEAKING_TASK4_ASSET_NOT_READY', 'Wait for the photo pair to load');
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
    session = acceptTask4Session(await api.post(`/api/v1/speaking/task-4/sessions/${session.id}/complete`, {
      recordingDurationSeconds: recording.durationSeconds,
      micCheck: localRecorder.microphoneState().status,
      localPlayback,
      selfRating,
    }));
    phase = 'completed';
    return session;
  }

  function dispose() {
    assetGeneration += 1;
    if (pendingImage) {
      pendingImage.onload = null;
      pendingImage.onerror = null;
      try { pendingImage.src = ''; } catch {}
    }
    pendingImage = null;
    const rejectPendingAsset = pendingAssetReject;
    pendingAssetReject = null;
    rejectPendingAsset?.(flowError('SPEAKING_TASK4_ASSET_CANCELLED', 'Photo loading was cancelled'));
    localRecorder.dispose();
    releaseRecording();
    session = null;
    phase = 'idle';
    assetStatus = 'idle';
    assetPromise = null;
  }

  return Object.freeze({
    state, loadAssignment, restoreSession, prepareAssets, checkMicrophone,
    startRecording, stopRecording, playRecording, complete, dispose,
  });
}
