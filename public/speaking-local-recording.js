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

function recordingError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function createSpeakingLocalRecorder(options = {}) {
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
  const onRecordingReady = options.onRecordingReady || (() => {});

  let micCheck = 'skipped';
  let micLevel = null;
  let recorder = null;
  let stream = null;
  let chunks = [];
  let startedAt = 0;
  let maximumSeconds = 0;
  let playback = null;
  let stopTimer = null;
  let stopPromise = null;

  const microphoneState = () => Object.freeze({ status: micCheck, level: micLevel });

  async function checkMicrophone() {
    if (!mediaDevices?.getUserMedia) throw recordingError('MICROPHONE_UNAVAILABLE', 'Microphone is unavailable');
    let checkStream;
    try {
      checkStream = await mediaDevices.getUserMedia({ audio: true });
      const live = checkStream.getAudioTracks?.().some((track) => track.readyState === 'live');
      if (!live) throw recordingError('MICROPHONE_NO_TRACK', 'No live microphone track');
      const measured = await sampleMicrophone(checkStream);
      micLevel = measured == null ? null : Math.max(0, Math.min(1, Number(measured) || 0));
      micCheck = micLevel == null || micLevel >= MIN_SIGNAL_LEVEL ? 'passed' : 'quiet';
      return microphoneState();
    } catch (error) {
      micCheck = 'skipped';
      if (error?.code) throw error;
      throw recordingError('MICROPHONE_PERMISSION_DENIED', 'Microphone permission was not granted');
    } finally {
      stopStream(checkStream);
    }
  }

  async function start(maxSeconds) {
    if (micCheck === 'skipped') throw recordingError('MIC_CHECK_REQUIRED', 'Check the microphone first');
    if (!MediaRecorder || !mediaDevices?.getUserMedia) throw recordingError('RECORDER_UNAVAILABLE', 'Recording is unavailable');
    if (recorder?.state && recorder.state !== 'inactive') throw recordingError('RECORDING_ACTIVE', 'Recording is already active');
    maximumSeconds = Number(maxSeconds);
    if (!Number.isFinite(maximumSeconds) || maximumSeconds <= 0) {
      throw recordingError('RECORDING_LIMIT_INVALID', 'Recording limit is invalid');
    }
    stopPromise = null;
    stream = await mediaDevices.getUserMedia({ audio: true });
    try {
      const mimeType = preferredMimeType(MediaRecorder);
      recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      chunks = [];
      recorder.ondataavailable = (event) => { if (event.data?.size) chunks.push(event.data); };
      recorder.start();
    } catch (error) {
      stopStream(stream);
      stream = null;
      recorder = null;
      chunks = [];
      throw error;
    }
    startedAt = Number(now());
    stopTimer = setTimeout(() => { void stop(); }, maximumSeconds * 1_000);
  }

  function stop() {
    if (stopPromise) return stopPromise;
    if (!recorder || recorder.state === 'inactive') {
      return Promise.reject(recordingError('RECORDING_NOT_ACTIVE', 'Recording is not active'));
    }
    if (stopTimer != null) clearTimeout(stopTimer);
    stopTimer = null;
    const activeStop = new Promise((resolve, reject) => {
      recorder.onstop = () => {
        let recording = null;
        try {
          const mimeType = recorder.mimeType || chunks[0]?.type || 'application/octet-stream';
          const blob = new Blob(chunks, { type: mimeType });
          const durationSeconds = Math.max(1, Math.min(
            maximumSeconds,
            Math.round((Number(now()) - startedAt) / 1_000),
          ));
          recording = { blob, url: URL.createObjectURL(blob), durationSeconds };
          onRecordingReady(recording);
          resolve(recording);
        } catch (error) {
          if (recording?.url) URL?.revokeObjectURL?.(recording.url);
          reject(error);
        } finally {
          stopStream(stream);
          stream = null;
        }
      };
      try { recorder.stop(); } catch (error) {
        stopStream(stream);
        stream = null;
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

  async function play(recording) {
    if (!recording?.url || !Audio) throw recordingError('LOCAL_RECORDING_UNAVAILABLE', 'Local recording is unavailable');
    playback?.pause?.();
    playback = new Audio(recording.url);
    await playback.play();
    return true;
  }

  function revoke(recording) {
    if (recording?.url) URL?.revokeObjectURL?.(recording.url);
  }

  function dispose() {
    if (stopTimer != null) clearTimeout(stopTimer);
    playback?.pause?.();
    if (recorder?.state && recorder.state !== 'inactive') {
      recorder.ondataavailable = null;
      recorder.onstop = null;
      try { recorder.stop(); } catch {}
    }
    stopStream(stream);
    stream = null;
    chunks = [];
    stopPromise = null;
  }

  return Object.freeze({ microphoneState, checkMicrophone, start, stop, play, revoke, dispose });
}
