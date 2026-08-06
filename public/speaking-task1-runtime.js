const MIME_CANDIDATES = Object.freeze(['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm']);
const MIN_SIGNAL_LEVEL = 0.02;

function stopStream(stream) {
  try { stream?.getTracks().forEach((track) => track.stop()); } catch {}
}

function preferredMimeType(MediaRecorder) {
  if (typeof MediaRecorder?.isTypeSupported !== 'function') return '';
  return MIME_CANDIDATES.find((type) => {
    try { return MediaRecorder.isTypeSupported(type); } catch { return false; }
  }) || '';
}

async function defaultSampleMicrophone(stream, { AudioContext, setTimeout }) {
  if (!AudioContext) return null;
  const context = new AudioContext();
  try {
    const source = context.createMediaStreamSource(stream);
    const analyser = context.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    await new Promise((resolve) => setTimeout(resolve, 250));
    const values = new Uint8Array(analyser.fftSize);
    analyser.getByteTimeDomainData(values);
    return values.reduce((sum, value) => sum + Math.abs(value - 128), 0) / values.length / 128;
  } finally {
    await context.close().catch(() => {});
  }
}

function flowError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function createSpeakingTask1BrowserFlow(options = {}) {
  const api = options.api;
  const mediaDevices = options.mediaDevices || globalThis.navigator?.mediaDevices;
  const MediaRecorder = options.MediaRecorder || globalThis.MediaRecorder;
  const Audio = options.Audio || globalThis.Audio;
  const URL = options.URL || globalThis.URL;
  const Blob = options.Blob || globalThis.Blob;
  const AudioContext = options.AudioContext || globalThis.AudioContext || globalThis.webkitAudioContext;
  const now = options.now || Date.now;
  const setTimeout = options.setTimeout || globalThis.setTimeout;
  const clearTimeout = options.clearTimeout || globalThis.clearTimeout;
  const sampleMicrophone = options.sampleMicrophone
    || ((stream) => defaultSampleMicrophone(stream, { AudioContext, setTimeout }));

  let session = null;
  let phase = 'idle';
  let micCheck = 'skipped';
  let micLevel = null;
  let recorder = null;
  let recordingStream = null;
  let chunks = [];
  let recordingStartedAt = 0;
  let recording = null;
  let playback = null;
  let localPlayback = false;
  let stopTimer = null;
  let stopPromise = null;

  function state() {
    return Object.freeze({
      phase,
      sessionId: session?.id || null,
      task: session?.task || null,
      micCheck,
      micLevel,
      recording: recording ? { url: recording.url, durationSeconds: recording.durationSeconds } : null,
      localPlayback,
      pronunciationAssessment: session?.pronunciationAssessment || {
        available: false, reason: 'provider_not_connected', message: 'Оценка произношения пока не подключена.',
      },
    });
  }

  async function loadAssignment() {
    if (!api || typeof api.post !== 'function') throw flowError('SPEAKING_API_UNAVAILABLE', 'Speaking API is unavailable');
    session = await api.post('/api/v1/speaking/task-1/sessions', {});
    phase = 'assigned';
    return session;
  }

  async function checkMicrophone() {
    if (!mediaDevices?.getUserMedia) throw flowError('MICROPHONE_UNAVAILABLE', 'Microphone is unavailable');
    let stream;
    try {
      stream = await mediaDevices.getUserMedia({ audio: true });
      const live = stream.getAudioTracks?.().some((track) => track.readyState === 'live');
      if (!live) throw flowError('MICROPHONE_NO_TRACK', 'No live microphone track');
      const measured = await sampleMicrophone(stream);
      micLevel = measured == null ? null : Math.max(0, Math.min(1, Number(measured) || 0));
      micCheck = micLevel == null || micLevel >= MIN_SIGNAL_LEVEL ? 'passed' : 'quiet';
      return { status: micCheck, level: micLevel };
    } catch (error) {
      micCheck = 'skipped';
      if (error?.code) throw error;
      throw flowError('MICROPHONE_PERMISSION_DENIED', 'Microphone permission was not granted');
    } finally {
      stopStream(stream);
    }
  }

  function releaseRecording() {
    if (recording?.url) URL?.revokeObjectURL?.(recording.url);
    recording = null;
    chunks = [];
    localPlayback = false;
  }

  async function startRecording() {
    if (!session) throw flowError('SPEAKING_ASSIGNMENT_REQUIRED', 'Load an assignment first');
    if (micCheck === 'skipped') throw flowError('MIC_CHECK_REQUIRED', 'Check the microphone first');
    if (!MediaRecorder || !mediaDevices?.getUserMedia) throw flowError('RECORDER_UNAVAILABLE', 'Recording is unavailable');
    releaseRecording();
    stopPromise = null;
    recordingStream = await mediaDevices.getUserMedia({ audio: true });
    try {
      const mimeType = preferredMimeType(MediaRecorder);
      recorder = mimeType ? new MediaRecorder(recordingStream, { mimeType }) : new MediaRecorder(recordingStream);
      chunks = [];
      recorder.ondataavailable = (event) => { if (event.data?.size) chunks.push(event.data); };
      recorder.start();
    } catch (error) {
      stopStream(recordingStream);
      recordingStream = null;
      recorder = null;
      chunks = [];
      throw error;
    }
    recordingStartedAt = Number(now());
    phase = 'recording';
    stopTimer = setTimeout(() => { void stopRecording(); }, session.task.responseSeconds * 1_000);
    return state();
  }

  function stopRecording() {
    if (stopPromise) return stopPromise;
    if (!recorder || recorder.state === 'inactive') {
      if (recording) return Promise.resolve(recording);
      return Promise.reject(flowError('RECORDING_NOT_ACTIVE', 'Recording is not active'));
    }
    if (stopTimer != null) clearTimeout(stopTimer);
    stopTimer = null;
    const activeStop = new Promise((resolve, reject) => {
      recorder.onstop = () => {
        try {
          const mimeType = recorder.mimeType || chunks[0]?.type || 'application/octet-stream';
          const blob = new Blob(chunks, { type: mimeType });
          const durationSeconds = Math.max(1, Math.min(
            session.task.responseSeconds,
            Math.round((Number(now()) - recordingStartedAt) / 1_000),
          ));
          recording = { blob, url: URL.createObjectURL(blob), durationSeconds };
          phase = 'review';
          stopStream(recordingStream);
          recordingStream = null;
          resolve({ ...recording });
        } catch (error) { reject(error); }
      };
      try { recorder.stop(); } catch (error) {
        stopStream(recordingStream);
        recordingStream = null;
        reject(error);
      }
    });
    stopPromise = activeStop;
    activeStop.then(
      () => { if (stopPromise === activeStop) stopPromise = null; },
      () => { if (stopPromise === activeStop) stopPromise = null; },
    );
    return activeStop;
  }

  async function playRecording() {
    if (!recording?.url || !Audio) throw flowError('LOCAL_RECORDING_UNAVAILABLE', 'Local recording is unavailable');
    playback?.pause?.();
    playback = new Audio(recording.url);
    await playback.play();
    localPlayback = true;
    return true;
  }

  async function complete(selfRating) {
    if (!session || !recording) throw flowError('LOCAL_RECORDING_UNAVAILABLE', 'Record an answer first');
    session = await api.post(`/api/v1/speaking/task-1/sessions/${session.id}/complete`, {
      recordingDurationSeconds: recording.durationSeconds,
      micCheck,
      localPlayback,
      selfRating,
    });
    phase = 'completed';
    return session;
  }

  function dispose() {
    if (stopTimer != null) clearTimeout(stopTimer);
    playback?.pause?.();
    if (recorder?.state && recorder.state !== 'inactive') {
      recorder.ondataavailable = null;
      recorder.onstop = null;
      try { recorder.stop(); } catch {}
    }
    stopStream(recordingStream);
    recordingStream = null;
    releaseRecording();
    phase = 'idle';
  }

  return Object.freeze({ state, loadAssignment, checkMicrophone, startRecording, stopRecording, playRecording, complete, dispose });
}
