import { createSpeakingLocalRecorder } from './speaking-local-recording.js';
import { speakingAssessmentNotRequested } from './speaking-assessment-contract.js';

function flowError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function createSpeakingSequentialBrowserFlow(options = {}, contract) {
  const api = options.api;
  let session = null;
  let phase = 'idle';
  let recordingPosition = null;
  const recordings = new Map();
  const playedPositions = new Set();
  const localRecorder = createSpeakingLocalRecorder({
    ...options,
    onRecordingReady(recording) {
      if (!recordingPosition) return;
      const previous = recordings.get(recordingPosition);
      if (previous) localRecorder.revoke(previous);
      recordings.set(recordingPosition, recording);
      phase = 'review';
    },
  });

  function state() {
    const mic = localRecorder.microphoneState();
    const currentPosition = session?.[contract.currentPublicKey] || null;
    return Object.freeze({
      phase,
      sessionId: session?.id || null,
      task: session?.task || null,
      status: session?.status || null,
      currentQuestion: currentPosition,
      [contract.collectionPublicKey]: session?.[contract.collectionPublicKey] || [],
      micCheck: mic.status,
      micLevel: mic.level,
      currentRecording: currentPosition ? recordings.get(currentPosition) || null : null,
      localRecordings: [...recordings.entries()].sort(([left], [right]) => left - right)
        .map(([questionNumber, recording]) => ({
          questionNumber, url: recording.url, durationSeconds: recording.durationSeconds,
        })),
      assessment: session?.assessment || speakingAssessmentNotRequested(
        'Автоматическая оценка появится после подключения и методической проверки в следующих этапах.',
      ),
    });
  }

  function acceptSession(next, expectedSession = null) {
    const positions = next?.[contract.collectionPublicKey];
    const currentPosition = next?.[contract.currentPublicKey];
    const completedCount = Array.isArray(positions)
      ? positions.filter((position) => position?.status === 'completed').length
      : -1;
    const stateIsConsistent = (
      (next?.status === 'assigned' && completedCount === 0 && currentPosition === 1)
      || (next?.status === 'in_progress' && completedCount > 0
        && completedCount < contract.positionCount && currentPosition === completedCount + 1)
      || (next?.status === 'completed' && completedCount === contract.positionCount
        && currentPosition === contract.positionCount)
    );
    if (!next || !contract.acceptTask(next.task)
      || !Array.isArray(positions) || positions.length !== contract.positionCount
      || !positions.every((position, index) => (
        position?.[contract.positionNumberKey] === index + 1
        && position.status === (index < completedCount ? 'completed' : 'pending')
      ))
      || !stateIsConsistent
      || (expectedSession && (
        next.id !== expectedSession.id
        || next.task.id !== expectedSession.task.id
        || next.task.revision !== expectedSession.task.revision
      ))) {
      throw flowError(contract.invalidResponseCode, contract.invalidResponseMessage);
    }
    session = next;
    phase = session.status === 'completed' ? 'completed' : 'ready';
    recordingPosition = null;
    return session;
  }

  async function loadAssignment() {
    if (!api || typeof api.post !== 'function') throw flowError('SPEAKING_API_UNAVAILABLE', 'Speaking API is unavailable');
    return acceptSession(await api.post(contract.sessionPath, {}));
  }

  async function restoreSession(sessionId) {
    if (!api || typeof api.get !== 'function') throw flowError('SPEAKING_API_UNAVAILABLE', 'Speaking API is unavailable');
    return acceptSession(await api.get(`${contract.sessionPath}/${sessionId}`));
  }

  const checkMicrophone = () => localRecorder.checkMicrophone();

  async function startPosition() {
    if (!session) throw flowError('SPEAKING_ASSIGNMENT_REQUIRED', 'Load an assignment first');
    if (session.status === 'completed') throw flowError(contract.completedCode, contract.completedMessage);
    recordingPosition = session[contract.currentPublicKey];
    await localRecorder.start(session.task.questionSeconds);
    phase = 'recording';
    return state();
  }

  async function stopPosition() {
    try {
      return await localRecorder.stop();
    } catch (error) {
      const recovered = recordings.get(recordingPosition);
      if (recovered && error?.code === 'RECORDING_NOT_ACTIVE') return { ...recovered };
      throw error;
    }
  }

  async function playPosition(positionNumber) {
    const recording = recordings.get(positionNumber);
    if (!recording) throw flowError('LOCAL_RECORDING_UNAVAILABLE', 'Local recording is unavailable');
    await localRecorder.play(recording);
    playedPositions.add(positionNumber);
    return true;
  }

  async function completePosition(selfRating) {
    if (!session) throw flowError('SPEAKING_ASSIGNMENT_REQUIRED', 'Load an assignment first');
    const positionNumber = session[contract.currentPublicKey];
    const recording = recordings.get(positionNumber);
    if (!recording) throw flowError('LOCAL_RECORDING_UNAVAILABLE', 'Record the current position first');
    const nextSession = await api.post(contract.completionPath(session.id, positionNumber), {
      recordingDurationSeconds: recording.durationSeconds,
      localPlayback: playedPositions.has(positionNumber),
      selfRating,
    });
    session = acceptSession(nextSession, session);
    recordingPosition = null;
    return session;
  }

  function assessmentRecordings() {
    if (!session || session.status !== 'completed' || recordings.size !== contract.positionCount) {
      throw flowError('SPEAKING_ASSESSMENT_RECORDINGS_INCOMPLETE', 'All local recordings are required for assessment');
    }
    return [...recordings.entries()]
      .sort(([left], [right]) => left - right)
      .map(([positionNumber, recording]) => Object.freeze({
        positionNumber,
        blob: recording.blob,
        durationSeconds: recording.durationSeconds,
      }));
  }

  function dispose() {
    localRecorder.dispose();
    recordings.forEach((recording) => localRecorder.revoke(recording));
    recordings.clear();
    playedPositions.clear();
    session = null;
    recordingPosition = null;
    phase = 'idle';
  }

  return Object.freeze({
    state, loadAssignment, restoreSession, checkMicrophone,
    startPosition, stopPosition, playPosition, completePosition, assessmentRecordings, dispose,
  });
}
