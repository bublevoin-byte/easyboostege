import {
  EGE_MOCK_ORAL_DURATION_MS,
  EGE_MOCK_ORAL_POSITIONS,
  EGE_MOCK_ORAL_TASK_BY_POSITION,
} from '../shared/ege-mock-oral-contract.js';

const ORAL_POSITIONS = EGE_MOCK_ORAL_POSITIONS;

function copy(value) { return value == null ? value : structuredClone(value); }
function ownerStorageKey(owner) {
  return `easyboost-ege-mock-oral-v1:${owner.username}:${owner.generation}`;
}
function validForm(form) {
  return form && typeof form.id === 'string' && Number.isInteger(form.revision)
    && typeof form.fingerprint === 'string' && Array.isArray(form.positions)
    && ORAL_POSITIONS.every((position) => form.positions[position - 1]?.position === position);
}
function validAttempt(attempt, expectedAttemptId, expectedAttemptOwnerGeneration, form) {
  return attempt && typeof attempt.id === 'string'
    && (!expectedAttemptId || attempt.id === expectedAttemptId)
    && typeof attempt.ownerGeneration === 'string' && attempt.ownerGeneration
    && (!expectedAttemptOwnerGeneration
      || attempt.ownerGeneration === expectedAttemptOwnerGeneration)
    && attempt.formId === form.id && Number(attempt.formRevision) === Number(form.revision)
    && attempt.catalogFingerprint === form.fingerprint && Number.isInteger(attempt.revision)
    && ['oral_ready', 'oral_in_progress', 'assessment_pending', 'completed', 'expired'].includes(attempt.state);
}
function validProgress(progress) {
  return progress && progress.schemaVersion === 'ege-mock-oral-progress-v1'
    && ORAL_POSITIONS.includes(Number(progress.position))
    && Number.isInteger(Number(progress.responseNumber))
    && Number(progress.responseNumber) >= 1
    && Number(progress.responseNumber) <= EGE_MOCK_ORAL_TASK_BY_POSITION[Number(progress.position)].responseCount
    && ['ready', 'preparing', 'recording', 'ready_to_submit'].includes(progress.phase)
    && progress.recordings && typeof progress.recordings === 'object' && !Array.isArray(progress.recordings);
}
function currentProjection(progress) {
  if (!progress || progress.phase === 'ready_to_submit') return null;
  return {
    position: Number(progress.position),
    taskType: EGE_MOCK_ORAL_TASK_BY_POSITION[Number(progress.position)].taskType,
    responseNumber: Number(progress.responseNumber), phase: progress.phase,
    stageStartedAt: progress.stageStartedAt || null, stageDeadlineAt: progress.stageDeadlineAt || null,
  };
}

function deterministicStageUuid(attemptId, position, responseNumber, kind) {
  const source = String(attemptId || '').replaceAll('-', '').toLowerCase();
  if (!/^[0-9a-f]{32}$/u.test(source)) throw new Error('EGE_MOCK_ORAL_ATTEMPT_INVALID');
  const tag = ((Number(position) * 100 + Number(responseNumber)) * 16 + Number(kind))
    .toString(16).padStart(6, '0');
  return `${source.slice(0, 8)}-${source.slice(8, 12)}-4${source.slice(13, 16)}`
    + `-8${source.slice(17, 20)}-${source.slice(20, 26)}${tag}`;
}

function createEgeMockOralRunner(options = {}) {
  const { owner, storage, media, transport } = options;
  const authority = options.authority || null;
  const lockManager = options.lockManager || globalThis.navigator?.locks || null;
  const expectedAttemptId = options.attemptId || null;
  const expectedAttemptOwnerGeneration = options.attemptOwnerGeneration || null;
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const performanceClock = options.performanceClock || globalThis.performance;
  const crossNavigationMonotonicNow = () => {
    const origin = Number(performanceClock?.timeOrigin);
    const elapsed = Number(performanceClock?.now?.());
    return Number.isFinite(origin) && Number.isFinite(elapsed) ? origin + elapsed : Date.now();
  };
  const monotonicNow = typeof options.monotonicNow === 'function' ? options.monotonicNow
    : options.performanceClock ? crossNavigationMonotonicNow
      : typeof options.now === 'function' ? now : crossNavigationMonotonicNow;
  const online = typeof options.online === 'function' ? options.online : () => true;
  if (!owner?.username || owner?.generation == null || owner.generation === ''
    || !storage?.getItem || !storage?.setItem || !storage?.removeItem
    || !media?.preflight || !media?.put || !media?.has || !transport?.attempt
    || (globalThis.window && typeof lockManager?.request !== 'function')) {
    throw new TypeError('EGE_MOCK_ORAL_DEPENDENCIES_INVALID');
  }
  const listeners = new Set();
  const storageKey = ownerStorageKey(owner);
  let form = null;
  let state = {
    phase: 'idle', attemptId: null, revision: null, oralStartedAt: null,
    oralDeadlineAt: null, current: null, recordings: {}, remainingMs: null,
    timerAuthority: null, authorityNowMs: null, assessmentEvidenceReady: false,
    prepared: false, saveStatus: 'saved', error: null,
    pendingCommand: null, pendingCommands: [], readyToSubmit: false, speakingAssessment: null,
    localRevision: 0,
  };
  let timerRuntime = null;
  let localLock = Promise.resolve();

  function snapshot() { return copy(state); }
  function networkUnavailable(error) {
    return error?.code === 'NETWORK_ERROR' || (error?.status === 0 && error?.name === 'ApiError');
  }
  function notify() { const value = snapshot(); listeners.forEach((listener) => listener(value)); return value; }
  function setPendingCommands(commands) {
    state.pendingCommands = copy(commands || []);
    state.pendingCommand = copy(state.pendingCommands[0] || null);
  }
  function localStorageFailure(cause) {
    const error = new Error('EGE_MOCK_LOCAL_STORAGE_FAILED', { cause });
    error.code = 'EGE_MOCK_LOCAL_STORAGE_FAILED';
    return error;
  }
  function readStored() {
    try { return JSON.parse(storage.getItem(storageKey) || 'null'); }
    catch { return null; }
  }
  function storedEnvelopeMatches(saved) {
    return saved?.schemaVersion === 'ege-mock-oral-local-v1'
      && saved.formId === form?.id && Number(saved.formRevision) === Number(form?.revision)
      && saved.catalogFingerprint === form?.fingerprint
      && (!expectedAttemptId || saved.attemptId === expectedAttemptId)
      && Number.isInteger(saved.localRevision) && saved.localRevision >= 0
      && Array.isArray(saved.pendingCommands);
  }
  function mergeStoredState() {
    const saved = readStored();
    if (!storedEnvelopeMatches(saved) || saved.localRevision <= state.localRevision) return;
    for (const key of Object.keys(state)) {
      if (Object.hasOwn(saved, key)) state[key] = copy(saved[key]);
    }
    setPendingCommands(saved.pendingCommands);
    timerRuntime = null;
  }
  function persist() {
    const nextLocalRevision = state.localRevision + 1;
    const serialized = JSON.stringify({
      schemaVersion: 'ege-mock-oral-local-v1', formId: form?.id, formRevision: form?.revision,
      catalogFingerprint: form?.fingerprint, ...state, localRevision: nextLocalRevision,
    });
    try { storage.setItem(storageKey, serialized); }
    catch (error) { throw localStorageFailure(error); }
    state.localRevision = nextLocalRevision;
  }
  async function persistWithAuthority() {
    if (typeof authority?.commit === 'function') {
      await authority.commit(() => persist());
      return;
    }
    persist();
  }
  function withDurableLock(task, { merge = false } = {}) {
    const run = async () => {
      if (merge) mergeStoredState();
      const before = copy(state);
      try { return await task(); }
      catch (error) {
        if (['EGE_MOCK_LOCAL_STORAGE_FAILED', 'EGE_MOCK_OWNER_AUTHORITY_CHANGED']
          .includes(error?.code)) {
          state = before;
          timerRuntime = null;
        }
        throw error;
      }
    };
    if (typeof lockManager?.request === 'function') {
      return lockManager.request(`easyboost-ege-mock-oral:${storageKey}`, { mode: 'exclusive' }, run);
    }
    const result = localLock.then(run, run);
    localLock = result.catch(() => {});
    return result;
  }
  function timerIdentity() {
    return `${state.oralStartedAt || ''}:${state.oralDeadlineAt || ''}`;
  }
  function seedTimerAuthority(attempt, serverTimeMs = null, inherited = state.timerAuthority) {
    if (!attempt.oralStartedAt || !attempt.oralDeadlineAt) {
      state.timerAuthority = null;
      state.authorityNowMs = null;
      timerRuntime = null;
      return;
    }
    const startedAt = Date.parse(attempt.oralStartedAt);
    const wallNow = Number(now());
    const sample = Number(serverTimeMs);
    const hasSample = serverTimeMs != null && Number.isFinite(sample);
    const inheritedValid = inherited?.oralStartedAt === attempt.oralStartedAt
      && inherited?.oralDeadlineAt === attempt.oralDeadlineAt
      && Number.isFinite(Number(inherited.serverOffsetMs))
      && Number.isFinite(Number(inherited.observedNowMs));
    const sampledNow = hasSample ? Math.max(startedAt, sample) : null;
    const serverOffsetMs = hasSample ? sampledNow - wallNow
      : inheritedValid ? Number(inherited.serverOffsetMs) : Math.max(0, startedAt - wallNow);
    const observedNowMs = Math.max(
      startedAt,
      inheritedValid ? Number(inherited.observedNowMs) : 0,
      sampledNow ?? 0,
      hasSample || !inheritedValid ? wallNow + serverOffsetMs : 0,
    );
    state.timerAuthority = {
      oralStartedAt: attempt.oralStartedAt,
      oralDeadlineAt: attempt.oralDeadlineAt,
      serverOffsetMs,
      observedNowMs,
      observedMonotonicMs: !hasSample && inheritedValid
        ? Number(inherited.observedMonotonicMs) : Number(monotonicNow()),
    };
    state.authorityNowMs = observedNowMs;
    timerRuntime = null;
  }
  function authoritativeNow() {
    const authority = state.timerAuthority;
    if (!authority || authority.oralStartedAt !== state.oralStartedAt
      || authority.oralDeadlineAt !== state.oralDeadlineAt) return Number(now());
    const startedAt = Date.parse(state.oralStartedAt);
    const monotonic = Number(monotonicNow());
    const wallEstimate = 0;
    const identity = timerIdentity();
    if (!timerRuntime || timerRuntime.identity !== identity || !Number.isFinite(monotonic)) {
      const inheritedMonotonic = Number(authority.observedMonotonicMs);
      const reusableMonotonic = Number.isFinite(inheritedMonotonic)
        && Number.isFinite(monotonic) && monotonic >= inheritedMonotonic;
      timerRuntime = {
        identity,
        baseAuthorityMs: Math.max(startedAt, Number(authority.observedNowMs) || 0, wallEstimate),
        baseMonotonicMs: reusableMonotonic ? inheritedMonotonic : monotonic,
      };
    }
    const monotonicEstimate = Number.isFinite(monotonic) && Number.isFinite(timerRuntime.baseMonotonicMs)
      ? timerRuntime.baseAuthorityMs + Math.max(0, monotonic - timerRuntime.baseMonotonicMs)
      : timerRuntime.baseAuthorityMs;
    const effective = Math.max(startedAt, Number(authority.observedNowMs) || 0, monotonicEstimate);
    authority.observedNowMs = effective;
    authority.observedMonotonicMs = monotonic;
    state.authorityNowMs = effective;
    return effective;
  }
  function updateRemaining(attempt, sampled = false) {
    if (!attempt.oralDeadlineAt) { state.remainingMs = null; return; }
    const deadline = new Date(attempt.oralDeadlineAt).getTime();
    state.remainingMs = Math.max(0, deadline - (sampled ? state.authorityNowMs : authoritativeNow()));
  }
  function assessmentEvidenceReady() {
    return ORAL_POSITIONS.every((position) => Array.from(
      { length: EGE_MOCK_ORAL_TASK_BY_POSITION[position].responseCount },
      (_, index) => state.recordings[`${position}:${index + 1}`],
    ).every((recording) => recording && (
      recording.status === 'completed' ? recording.availableLocally === true
        : ['technical_issue', 'skipped'].includes(recording.status)
    )));
  }
  async function localRecordings(progress) {
    const projected = {};
    for (const [key, recording] of Object.entries(progress?.recordings || {})) {
      const [position, responseNumber] = key.split(':').map(Number);
      const binding = {
        username: owner.username, ownerGeneration: owner.generation, attemptId: state.attemptId,
        formId: form.id, formRevision: form.revision, catalogFingerprint: form.fingerprint,
        position, taskType: EGE_MOCK_ORAL_TASK_BY_POSITION[position].taskType, responseNumber,
        recordingId: recording.recordingId, sha256: recording.sha256,
      };
      projected[key] = { ...copy(recording), availableLocally: await media.has(binding) };
    }
    return projected;
  }
  async function adopt(attempt, { serverTimeMs = null } = {}) {
    if (!validAttempt(attempt, expectedAttemptId, expectedAttemptOwnerGeneration, form)) {
      throw new Error('EGE_MOCK_ORAL_ATTEMPT_INVALID');
    }
    state.attemptId = attempt.id;
    state.revision = attempt.revision;
    state.oralStartedAt = attempt.oralStartedAt || null;
    state.oralDeadlineAt = attempt.oralDeadlineAt || null;
    seedTimerAuthority(attempt, serverTimeMs);
    state.speakingAssessment = copy(attempt.speakingAssessment || null);
    if (attempt.state === 'oral_ready') {
      state.phase = state.prepared ? 'prepared' : 'ready';
      state.current = null;
      state.recordings = {};
      state.remainingMs = null;
    } else if (attempt.state === 'oral_in_progress') {
      if (!validProgress(attempt.oralProgress)) throw new Error('EGE_MOCK_ORAL_PROGRESS_INVALID');
      state.phase = 'oral';
      state.current = currentProjection(attempt.oralProgress);
      state.readyToSubmit = attempt.oralProgress.phase === 'ready_to_submit';
      state.recordings = await localRecordings(attempt.oralProgress);
      updateRemaining(attempt, serverTimeMs != null);
    } else {
      state.phase = attempt.state === 'expired' ? 'expired' : 'submitted';
      state.current = null;
      state.readyToSubmit = false;
      state.recordings = attempt.oralProgress?.recordings
        ? await localRecordings(attempt.oralProgress) : state.recordings;
      updateRemaining(attempt);
    }
    state.assessmentEvidenceReady = assessmentEvidenceReady();
    state.saveStatus = 'saved';
    await persistWithAuthority();
    return notify();
  }
  async function restore(candidateForm) {
    if (!validForm(candidateForm)) throw new Error('EGE_MOCK_ORAL_FORM_INVALID');
    form = candidateForm;
    let saved = readStored();
    if (saved && expectedAttemptId && saved.attemptId !== expectedAttemptId) {
      storage.removeItem(storageKey);
      saved = null;
    }
    let pendingCommands = [];
    if (saved?.schemaVersion === 'ege-mock-oral-local-v1'
      && saved.formId === form.id && Number(saved.formRevision) === Number(form.revision)
      && saved.catalogFingerprint === form.fingerprint) {
      state.prepared = false;
      state.localRevision = Number.isInteger(saved.localRevision) ? saved.localRevision : 0;
      pendingCommands = Array.isArray(saved.pendingCommands)
        ? saved.pendingCommands : saved.pendingCommand ? [saved.pendingCommand] : [];
    }
    const savedStarted = new Date(saved?.oralStartedAt).getTime();
    const savedDeadline = new Date(saved?.oralDeadlineAt).getTime();
    const savedProgress = (saved?.current || saved?.readyToSubmit === true) ? {
      schemaVersion: 'ege-mock-oral-progress-v1',
      position: saved.current?.position ?? 42,
      responseNumber: saved.current?.responseNumber ?? 1,
      phase: saved.current?.phase ?? 'ready_to_submit',
      stageStartedAt: saved.current?.stageStartedAt || null,
      stageDeadlineAt: saved.current?.stageDeadlineAt || null,
      recordings: saved.recordings || {},
    } : null;
    const offlineProjectionValid = saved?.phase === 'oral'
      && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(saved.attemptId || '')
      && Number.isInteger(saved.revision) && saved.revision >= 0
      && Number.isFinite(savedStarted) && Number.isFinite(savedDeadline)
      && savedDeadline - savedStarted === EGE_MOCK_ORAL_DURATION_MS
      && validProgress(savedProgress);
    async function restoreOfflineProjection() {
      state.attemptId = saved.attemptId;
      state.revision = saved.revision;
      state.oralStartedAt = new Date(savedStarted).toISOString();
      state.oralDeadlineAt = new Date(savedDeadline).toISOString();
      state.phase = 'oral';
      state.current = currentProjection(savedProgress);
      state.readyToSubmit = savedProgress.phase === 'ready_to_submit';
      state.recordings = await localRecordings(savedProgress);
      state.speakingAssessment = copy(saved.speakingAssessment || null);
      state.timerAuthority = copy(saved.timerAuthority || null);
      seedTimerAuthority({
        oralStartedAt: state.oralStartedAt, oralDeadlineAt: state.oralDeadlineAt,
      }, null, state.timerAuthority);
      state.remainingMs = Math.max(0, savedDeadline - authoritativeNow());
      state.assessmentEvidenceReady = assessmentEvidenceReady();
      setPendingCommands(pendingCommands);
      state.saveStatus = pendingCommands.length ? 'queued' : 'saved';
      await persistWithAuthority();
      return notify();
    }
    if (offlineProjectionValid && pendingCommands.length) {
      await restoreOfflineProjection();
      if (!online()) return notify();
      try { return await replayPending(); }
      catch (error) {
        if (!networkUnavailable(error)) throw error;
        state.saveStatus = 'queued';
        await persistWithAuthority();
        return notify();
      }
    }
    if (!online() && offlineProjectionValid) return restoreOfflineProjection();
    if (!online()) throw new Error('EGE_MOCK_ORAL_ATTEMPT_UNAVAILABLE');
    let result;
    try { result = await transport.attempt(expectedAttemptId || saved?.attemptId || null); }
    catch (error) {
      if (offlineProjectionValid) return restoreOfflineProjection();
      throw error;
    }
    if (!result?.attempt) throw new Error('EGE_MOCK_ORAL_ATTEMPT_UNAVAILABLE');
    await adopt(result.attempt, { serverTimeMs: result.serverTimeMs });
    setPendingCommands(['submitted', 'expired'].includes(state.phase) ? [] : pendingCommands);
    if (state.pendingCommands.length && online()) return replayPending();
    state.saveStatus = state.pendingCommands.length ? 'queued' : 'saved';
    await persistWithAuthority();
    return notify();
  }
  async function preflight() {
    if (state.phase !== 'ready' && state.phase !== 'prepared') throw new Error('EGE_MOCK_ORAL_NOT_READY');
    await media.preflight({
      form: copy(form),
      tasks: ORAL_POSITIONS.map((position) => copy(form.positions[position - 1])),
      assets: copy(form.assets || []),
    });
    state.prepared = true;
    state.phase = 'prepared';
    await persistWithAuthority();
    return notify();
  }
  async function start() {
    if (state.phase !== 'prepared') throw new Error('EGE_MOCK_ORAL_PREFLIGHT_REQUIRED');
    if (typeof transport.start !== 'function') throw new Error('EGE_MOCK_ORAL_TRANSPORT_INVALID');
    return runMutation('start', {
      expectedRevision: state.revision, idempotencyKey: crypto.randomUUID(),
    });
  }

  function advanceLocalCursor() {
    const task = EGE_MOCK_ORAL_TASK_BY_POSITION[state.current.position];
    if (state.current.responseNumber < task.responseCount) {
      state.current = { ...state.current, responseNumber: state.current.responseNumber + 1 };
    } else if (state.current.position < 42) {
      const position = state.current.position + 1;
      state.current = {
        ...state.current, position, taskType: EGE_MOCK_ORAL_TASK_BY_POSITION[position].taskType,
        responseNumber: 1,
      };
    } else {
      state.current = null;
      state.readyToSubmit = true;
      return;
    }
    state.current.phase = 'ready';
    state.current.stageStartedAt = null;
    state.current.stageDeadlineAt = null;
  }

  function applyOptimisticStage(command) {
    const payload = command.payload;
    if (payload.action === 'advance') {
      if (!state.current || !['ready', 'preparing'].includes(state.current.phase)) {
        throw new Error('EGE_MOCK_ORAL_STAGE_INVALID');
      }
      const task = EGE_MOCK_ORAL_TASK_BY_POSITION[state.current.position];
      const observedAt = Date.parse(command.observedAt);
      if (!Number.isFinite(observedAt)) throw new Error('EGE_MOCK_ORAL_OBSERVATION_INVALID');
      const previousDeadline = Date.parse(state.current.stageDeadlineAt);
      if (state.current.phase === 'preparing' && observedAt < previousDeadline) {
        throw new Error('EGE_MOCK_ORAL_STAGE_TOO_EARLY');
      }
      const fromPhase = state.current.phase;
      const phase = fromPhase === 'ready'
        ? (state.current.responseNumber === 1 && task.preparationSeconds > 0 ? 'preparing' : 'recording')
        : 'recording';
      const anchoredAt = fromPhase === 'preparing' && Number.isFinite(previousDeadline)
        ? previousDeadline : observedAt;
      const seconds = phase === 'preparing' ? task.preparationSeconds : task.responseSeconds;
      state.current = {
        ...state.current, phase,
        stageStartedAt: new Date(anchoredAt).toISOString(),
        stageDeadlineAt: new Date(Math.min(
          anchoredAt + seconds * 1_000, Date.parse(state.oralDeadlineAt),
        )).toISOString(),
      };
    } else if (payload.action === 'complete') {
      if (!state.current || state.current.phase !== 'recording') {
        throw new Error('EGE_MOCK_ORAL_STAGE_INVALID');
      }
      const key = `${state.current.position}:${state.current.responseNumber}`;
      state.recordings[key] = {
        ...copy(payload.recording), position: state.current.position,
        taskType: state.current.taskType, responseNumber: state.current.responseNumber,
        availableLocally: payload.recording.status === 'completed',
      };
      advanceLocalCursor();
    }
    state.revision += 1;
    state.assessmentEvidenceReady = assessmentEvidenceReady();
  }

  async function runMutation(kind, payload, adoptOptions = {}, commandOptions = {}) {
    const queue = copy(state.pendingCommands || []);
    const offlineSubmitAfterStages = !online() && kind === 'submit'
      && state.readyToSubmit && queue.length > 0
      && queue.every((command) => command.kind === 'stage');
    if (queue.length && !offlineSubmitAfterStages && (online() || kind !== 'stage')) {
      throw new Error('EGE_MOCK_ORAL_PENDING_EXISTS');
    }
    const command = {
      kind, payload: copy(payload), attemptId: state.attemptId,
      ...(commandOptions.transition ? { transition: commandOptions.transition } : {}),
      ...(commandOptions.observedAt ? { observedAt: commandOptions.observedAt } : {}),
    };
    queue.push(command);
    setPendingCommands(queue);
    state.saveStatus = 'queued';
    if (!online() && kind === 'stage') applyOptimisticStage(command);
    await persistWithAuthority();
    if (!online()) return notify();
    return replayPending(adoptOptions);
  }

  function commandSuperseded(attempt, command) {
    if (!attempt) return false;
    if (['assessment_pending', 'completed', 'expired'].includes(attempt.state)) return true;
    if (command.kind === 'start') return attempt.state === 'oral_in_progress';
    if (command.kind !== 'stage' || attempt.state !== 'oral_in_progress') return false;
    const progress = attempt.oralProgress;
    if (!progress) return false;
    const targetOrder = ORAL_POSITIONS.slice(0, command.payload.position - 39)
      .reduce((total, position) => total + EGE_MOCK_ORAL_TASK_BY_POSITION[position].responseCount, 0)
      + command.payload.responseNumber;
    const progressOrder = ORAL_POSITIONS.slice(0, progress.position - 39)
      .reduce((total, position) => total + EGE_MOCK_ORAL_TASK_BY_POSITION[position].responseCount, 0)
      + progress.responseNumber;
    if (progressOrder > targetOrder || progress.phase === 'ready_to_submit') return true;
    if (command.payload.action === 'complete') {
      return progress.recordings?.[`${command.payload.position}:${command.payload.responseNumber}`]
        ?.recordingId === command.payload.recording?.recordingId;
    }
    if (progressOrder !== targetOrder) return false;
    return command.transition === 'ready'
      ? ['preparing', 'recording'].includes(progress.phase)
      : command.transition === 'preparing' && progress.phase === 'recording';
  }

  function commandRecordingAccepted(attempt, command) {
    if (command?.kind !== 'stage' || command.payload?.action !== 'complete') return false;
    const key = `${command.payload.position}:${command.payload.responseNumber}`;
    return attempt?.oralProgress?.recordings?.[key]?.recordingId
      === command.payload.recording?.recordingId;
  }

  function commandRecordingBinding(command) {
    const recording = command?.payload?.recording;
    if (command?.kind !== 'stage' || command.payload?.action !== 'complete'
      || recording?.status !== 'completed') return null;
    return {
      username: owner.username, ownerGeneration: owner.generation,
      attemptId: command.attemptId, formId: form.id, formRevision: form.revision,
      catalogFingerprint: form.fingerprint,
      position: command.payload.position,
      taskType: EGE_MOCK_ORAL_TASK_BY_POSITION[command.payload.position].taskType,
      responseNumber: command.payload.responseNumber,
      recordingId: recording.recordingId, sha256: recording.sha256,
    };
  }

  async function discardUnacceptedCommandRecording(attempt, command) {
    const binding = commandRecordingBinding(command);
    if (binding && !commandRecordingAccepted(attempt, command)) await media.remove?.(binding);
  }

  const reconcilableCommandErrors = new Set([
    'EGE_MOCK_IDEMPOTENCY_CONFLICT', 'EGE_MOCK_REVISION_CONFLICT', 'EGE_MOCK_ORAL_CLOSED',
    'EGE_MOCK_ORAL_STAGE_CONFLICT', 'EGE_MOCK_ORAL_STAGE_EXPIRED',
    'EGE_MOCK_ORAL_NOT_READY_TO_SUBMIT', 'EGE_MOCK_ORAL_STAGE_TOO_EARLY',
  ]);

  async function replayPending(adoptOptions = {}) {
    while (state.pendingCommands.length) {
      const pending = copy(state.pendingCommands[0]);
      if (!pending || pending.attemptId !== state.attemptId) {
        throw new Error('EGE_MOCK_ORAL_PENDING_INVALID');
      }
      const method = transport[pending.kind];
      if (typeof method !== 'function') throw new Error('EGE_MOCK_ORAL_TRANSPORT_INVALID');
      let authoritativeAttempt = null;
      try {
        const result = await method(pending.attemptId, pending.payload);
        if (result?.replayed === true) {
          const current = await transport.attempt(state.attemptId);
          authoritativeAttempt = current?.attempt || null;
          await adopt(authoritativeAttempt, { serverTimeMs: current?.serverTimeMs });
        } else {
          authoritativeAttempt = result?.attempt || null;
          await adopt(authoritativeAttempt, {
            ...adoptOptions, serverTimeMs: result?.serverTimeMs,
          });
        }
      } catch (error) {
        const code = error?.code || error?.message;
        if (!reconcilableCommandErrors.has(code)) throw error;
        const current = await transport.attempt(state.attemptId);
        authoritativeAttempt = current?.attempt || null;
        await adopt(current?.attempt, { serverTimeMs: current?.serverTimeMs });
        const prematureSubmit = pending.kind === 'submit'
          && code === 'EGE_MOCK_ORAL_NOT_READY_TO_SUBMIT';
        if (!commandSuperseded(current?.attempt, pending) && !prematureSubmit) {
          setPendingCommands(state.pendingCommands);
          state.saveStatus = 'queued';
          await persistWithAuthority();
          if (code === 'EGE_MOCK_ORAL_STAGE_TOO_EARLY') return notify();
          throw error;
        }
      }
      if (['submitted', 'expired'].includes(state.phase)) {
        for (const command of state.pendingCommands) {
          await discardUnacceptedCommandRecording(authoritativeAttempt, command);
        }
        setPendingCommands([]);
        state.saveStatus = 'saved';
        await persistWithAuthority();
        break;
      }
      await discardUnacceptedCommandRecording(authoritativeAttempt, pending);
      setPendingCommands(state.pendingCommands.slice(1));
      state.saveStatus = state.pendingCommands.length ? 'queued' : 'saved';
      await persistWithAuthority();
    }
    state.saveStatus = 'saved';
    await persistWithAuthority();
    return notify();
  }
  async function completeResponse(command) {
    if (state.phase !== 'oral' || state.current?.phase !== 'recording'
      || typeof transport.stage !== 'function') throw new Error('EGE_MOCK_ORAL_STAGE_INVALID');
    const recording = copy(command.recording);
    if (!recording || typeof recording.recordingId !== 'string'
      || !Number.isFinite(recording.durationSeconds)
      || (recording.status === 'completed' && !/^[a-f0-9]{64}$/u.test(recording.sha256 || ''))
      || !['completed', 'technical_issue', 'skipped'].includes(recording.status)) {
      throw new Error('EGE_MOCK_ORAL_RECORDING_INVALID');
    }
    recording.recordingId = deterministicStageUuid(
      state.attemptId, state.current.position, state.current.responseNumber, 1,
    );
    const binding = commandRecordingBinding({
      kind: 'stage', attemptId: state.attemptId,
      payload: {
        action: 'complete', position: state.current.position,
        responseNumber: state.current.responseNumber, recording,
      },
    });
    const persistedAudio = recording.status === 'completed';
    if (persistedAudio) await media.put(binding, command.blob);
    const observedAt = new Date(authoritativeNow()).toISOString();
    try {
      return await runMutation('stage', {
        action: 'complete', expectedRevision: state.revision,
        position: state.current.position, responseNumber: state.current.responseNumber,
        recording: copy(recording), idempotencyKey: deterministicStageUuid(
          state.attemptId, state.current.position, state.current.responseNumber, 2,
        ),
      }, {}, { transition: 'recording', observedAt });
    } catch (error) {
      if (persistedAudio && error?.code === 'EGE_MOCK_OWNER_AUTHORITY_CHANGED') {
        await media.remove?.(binding);
      }
      throw error;
    }
  }
  async function advance() {
    if (state.phase !== 'oral' || !state.current || typeof transport.stage !== 'function') {
      throw new Error('EGE_MOCK_ORAL_STAGE_INVALID');
    }
    const transition = state.current.phase;
    const observedAt = new Date(authoritativeNow()).toISOString();
    return runMutation('stage', {
      action: 'advance', expectedRevision: state.revision,
      position: state.current.position, responseNumber: state.current.responseNumber,
      idempotencyKey: deterministicStageUuid(
        state.attemptId, state.current.position, state.current.responseNumber,
        transition === 'preparing' ? 5 : 3,
      ),
    }, {}, { transition, observedAt });
  }
  async function submit() {
    if (state.phase !== 'oral' || !state.readyToSubmit) {
      throw new Error('EGE_MOCK_ORAL_NOT_READY_TO_SUBMIT');
    }
    return runMutation('submit', {
      expectedRevision: state.revision,
      idempotencyKey: deterministicStageUuid(state.attemptId, 42, 1, 4),
    });
  }
  async function tick() {
    if (state.phase !== 'oral') return notify();
    state.remainingMs = Math.max(0, new Date(state.oralDeadlineAt).getTime() - authoritativeNow());
    if (state.remainingMs === 0) {
      if (state.pendingCommand) {
        state.saveStatus = 'queued';
        await persistWithAuthority();
        return notify();
      }
      if (!online()) {
        state.saveStatus = 'saved';
        await persistWithAuthority();
        return notify();
      }
      if (typeof transport.submit !== 'function') throw new Error('EGE_MOCK_ORAL_TRANSPORT_INVALID');
      return runMutation('submit', {
        expectedRevision: state.revision,
        idempotencyKey: deterministicStageUuid(state.attemptId, 42, 1, 4),
      });
    }
    await persistWithAuthority();
    return notify();
  }
  async function dispatch(command = {}) {
    return withDurableLock(async () => {
      if (command.type === 'restore') return restore(command.form);
      if (command.type === 'preflight') return preflight();
      if (command.type === 'start') return start();
      if (command.type === 'advance') return advance();
      if (command.type === 'completeResponse') return completeResponse(command);
      if (command.type === 'submit') return submit();
      if (command.type === 'sync') {
        return state.pendingCommands.length && online() ? replayPending() : notify();
      }
      if (command.type === 'refreshLocal') return notify();
      if (command.type === 'tick') return tick();
      throw new TypeError(`EGE_MOCK_ORAL_COMMAND_INVALID: ${String(command.type || '')}`);
    }, { merge: command.type !== 'restore' });
  }
  function subscribe(listener) {
    if (typeof listener !== 'function') throw new TypeError('EGE_MOCK_ORAL_LISTENER_INVALID');
    listeners.add(listener);
    return () => listeners.delete(listener);
  }
  return Object.freeze({ dispatch, snapshot, subscribe });
}

export { ORAL_POSITIONS, createEgeMockOralRunner };
