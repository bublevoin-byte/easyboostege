import {
  ATTEMPT_POLICY_ID, STORAGE_VERSION, WRITTEN_DURATION_MS, egeMockLocalContinuation,
  egeMockWrittenInvalidationKey as runnerInvalidationKey,
  egeMockWrittenStorageKey as runnerStorageKey, validEgeMockWrittenTiming as validServerTiming,
} from './ege-mock-written-continuation.js';
import { countEgeWritingWords, sanitizeEgeWritingText } from './ege-writing-text.js';
import { validEgeMockWritingAssessmentState } from './automatic-assessment-contract.js';
import { sameSemanticJsonValue } from '../shared/semantic-json.js';

const OBJECTIVE_POSITIONS = Object.freeze(Array.from({ length: 36 }, (_, index) => index + 1));
const WRITTEN_POSITIONS = Object.freeze(Array.from({ length: 38 }, (_, index) => index + 1));
const AUDIO_GROUPS = Object.freeze(['matching', 'true_false', 'interview']);
const AUDIO_LEASE_MS = 15 * 60 * 1000;
const WRITING_TEXT_LIMITS = Object.freeze({ 37: 12_000, 38: 20_000 });
const ASSESSMENT_TERMINAL_STATUSES = Object.freeze(['completed', 'retryable', 'ambiguous']);
const ASSESSMENT_RESPONSE_STATUSES = Object.freeze([
  'pending', 'in_progress', ...ASSESSMENT_TERMINAL_STATUSES,
]);
const ASSESSMENT_EXHAUSTION_SENTINEL = Number.MAX_SAFE_INTEGER;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const ASSESSMENT_COMMANDS = Object.freeze({
  run: Object.freeze({
    action: 'run', transportMethod: 'runAssessment', requiresAcknowledgementFlag: false,
    requestFields: (command) => (command.explicitRenewal === true ? { explicitRenewal: true } : {}),
    queueAutomaticRunAfterAck: false,
    acceptsResponse(status, acknowledged, disposition) {
      if (disposition === 'subscription_required') return acknowledged && status === 'pending';
      if (disposition != null) return false;
      return ASSESSMENT_RESPONSE_STATUSES.includes(status)
        && ASSESSMENT_TERMINAL_STATUSES.includes(status) === acknowledged;
    },
    retainsAfterResponse(acknowledged, terminal) { return !acknowledged || !terminal; },
  }),
  retry: Object.freeze({
    action: 'retry', transportMethod: 'retryAssessment', requiresAcknowledgementFlag: true,
    requestFields: (command) => ({
      acknowledgePossibleProviderRepeat: command.acknowledgePossibleProviderRepeat,
    }),
    queueAutomaticRunAfterAck: true,
    acceptsResponse(status, acknowledged, disposition) {
      return disposition == null && acknowledged && ASSESSMENT_RESPONSE_STATUSES.includes(status);
    },
    retainsAfterResponse(acknowledged) { return !acknowledged; },
  }),
});

function assessmentCommandDescriptor(command) {
  if (!command || typeof command !== 'object') return null;
  if (command.action === 'run') return ASSESSMENT_COMMANDS.run;
  if (command.action === 'retry') return ASSESSMENT_COMMANDS.retry;
  return null;
}

function copy(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function normalizeEgeMockSelection(selection) {
  if (!Array.isArray(selection)) throw new TypeError('EGE_MOCK_WRITTEN_SELECTION_INVALID');
  return selection.map((value) => value == null ? '' : String(value));
}

function assertForm(form) {
  const positions = Array.isArray(form?.positions) ? form.positions.slice(0, 38) : [];
  if (!form || typeof form.identity !== 'string' || typeof form.fingerprint !== 'string'
    || positions.length !== 38 || positions.some((item, index) => item?.position !== index + 1)) {
    throw new TypeError('EGE_MOCK_WRITTEN_FORM_INVALID');
  }
  return form;
}

function assertOwner(owner) {
  const username = String(owner?.username || '').trim();
  const generation = Number(owner?.generation);
  if (!username || !Number.isSafeInteger(generation) || generation < 0) {
    throw new TypeError('EGE_MOCK_WRITTEN_OWNER_INVALID');
  }
  return Object.freeze({ username, generation });
}

function createEgeMockWrittenRunner(options = {}) {
  const owner = assertOwner(options.owner);
  const storage = options.storage;
  const assets = options.assets;
  const transport = options.transport;
  const online = typeof options.online === 'function' ? options.online : () => true;
  const clock = typeof options.clock === 'function' ? options.clock : () => Date.now();
  const localNow = typeof options.localNow === 'function' ? options.localNow : () => Date.now();
  const monotonicNow = typeof options.monotonicNow === 'function' ? options.monotonicNow
    : typeof options.clock === 'function' ? clock
      : () => globalThis.performance?.now?.() ?? Date.now();
  const uuid = typeof options.uuid === 'function' ? options.uuid : () => crypto.randomUUID();
  const lockManager = options.lockManager || (globalThis.window ? globalThis.navigator?.locks : null);
  const authority = options.authority;
  if (!storage || !assets || !transport) throw new TypeError('EGE_MOCK_WRITTEN_DEPENDENCY_MISSING');

  let form = null;
  let state = {
    version: STORAGE_VERSION,
    owner,
    phase: 'idle',
    formIdentity: null,
    catalogFingerprint: null,
    attemptId: null,
    attemptOwnerGeneration: null,
    revision: null,
    policyId: null,
    writtenStartedAt: null,
    writtenDeadlineAt: null,
    timerAuthority: null,
    answers: {},
    answerVersions: {},
    writingDraftRecovery: null,
    audioPlays: { matching: 0, true_false: 0, interview: 0 },
    currentPosition: 1,
    preflight: null,
    pendingStartId: null,
    saveStatus: 'idle',
    queue: [],
    compactedThrough: null,
    canceledSubmit: null,
    assessmentCommand: null,
    assessmentCommandThrough: null,
    assessmentCommandBlockedRevision: null,
    assetBlockedAt: 0,
    assetReadyAt: 0,
    assetResumePhase: null,
    audioLease: null,
    audioLeaseThrough: null,
    invalidationWatermark: 0,
  };
  const listeners = new Set();
  let flushing = null;
  let logicalTime = 0;
  let localLock = Promise.resolve();
  let timerRuntime = null;
  let invalidationWatermark = readInvalidationWatermark();
  state.invalidationWatermark = invalidationWatermark;

  function assessmentRevisionExhausted(candidate = state) {
    return candidate?.assessmentCommandBlockedRevision === ASSESSMENT_EXHAUSTION_SENTINEL;
  }

  function withDurableLock(task) {
    if (lockManager?.request) {
      const identity = state.formIdentity || form?.identity || 'pending';
      return lockManager.request(`easyboost-ege-mock-written-v1:${owner.username}:${owner.generation}:${identity}`, {
        mode: 'exclusive',
      }, task);
    }
    const result = localLock.then(task, task);
    localLock = result.catch(() => {});
    return result;
  }

  async function withAuthorityCommit(task) {
    if (typeof authority?.commit !== 'function') return task();
    return authority.commit(task);
  }

  function invalidatedError() {
    return Object.assign(new Error('EGE_MOCK_WRITTEN_LOCAL_STATE_INVALIDATED'), {
      code: 'EGE_MOCK_WRITTEN_LOCAL_STATE_INVALIDATED',
    });
  }

  function readInvalidationWatermark() {
    let marker;
    try { marker = JSON.parse(storage.getItem(runnerInvalidationKey(owner)) || 'null'); } catch (_) { return 0; }
    return marker?.version === 1 && marker.owner?.username === owner.username
      && marker.owner?.generation === owner.generation
      && Number.isSafeInteger(marker.watermark) && marker.watermark >= 0 ? marker.watermark : 0;
  }

  function assertInvalidationCurrent() {
    if (readInvalidationWatermark() !== invalidationWatermark) throw invalidatedError();
  }

  function retryableTransportError(error) {
    const status = Number(error?.status);
    return error?.code === 'NETWORK_ERROR' || status === 0 || status === 429
      || (Number.isFinite(status) && status >= 500);
  }

  function assessmentResponseError() {
    return Object.assign(new Error('EGE_MOCK_ASSESSMENT_RESPONSE_INVALID'), {
      code: 'EGE_MOCK_ASSESSMENT_RESPONSE_INVALID',
    });
  }

  function localStateError() {
    return Object.assign(new Error('EGE_MOCK_WRITTEN_LOCAL_STATE_INVALID'), {
      code: 'EGE_MOCK_WRITTEN_LOCAL_STATE_INVALID',
    });
  }

  function validAssessmentProjection(value) {
    return validEgeMockWritingAssessmentState(value);
  }

  function mergeWritingAssessmentProjection(incoming) {
    if (!validAssessmentProjection(incoming)) throw assessmentResponseError();
    const current = state.result?.writingAssessment;
    if (!validAssessmentProjection(current)) return copy(incoming);
    if (incoming.assessmentRevision < current.assessmentRevision) return copy(current);
    if (incoming.assessmentRevision === current.assessmentRevision
      && !sameSemanticJsonValue(incoming, current)) throw assessmentResponseError();
    return copy(incoming);
  }

  function assertAssessmentResponse(result, descriptor) {
    if (!result || typeof result !== 'object'
      || typeof result.applied !== 'boolean' || typeof result.replayed !== 'boolean'
      || (!result.applied && result.replayed)) throw assessmentResponseError();
    let attempt;
    try { attempt = assertCurrentAttempt(result.attempt); } catch (_) { throw assessmentResponseError(); }
    const status = attempt.writingAssessment?.status;
    const disposition = result.disposition ?? null;
    const attemptDisposition = attempt.writingAssessment?.runDisposition ?? null;
    if ((disposition === 'subscription_required')
      !== (attemptDisposition === 'subscription_required')
      || (attemptDisposition != null && attemptDisposition !== 'subscription_required')) {
      throw assessmentResponseError();
    }
    const terminal = ASSESSMENT_TERMINAL_STATUSES.includes(status)
      || disposition === 'subscription_required';
    const acknowledged = result.applied || result.replayed;
    if (!descriptor?.acceptsResponse(status, acknowledged, disposition)) {
      throw assessmentResponseError();
    }
    return { attempt, acknowledged, terminal, disposition };
  }

  function nextLocalTime() {
    const wallTime = Number(localNow());
    const next = Math.max(logicalTime + 1,
      Number.isSafeInteger(wallTime) && wallTime >= 0 ? wallTime : 0);
    if (!Number.isSafeInteger(next) || next < 0) throw localStateError();
    logicalTime = next;
    return logicalTime;
  }

  function timerIdentity() {
    return `${state.policyId || ''}:${state.writtenStartedAt || ''}:${state.writtenDeadlineAt || ''}`;
  }

  function seedTimerAuthority(candidate, previous = null, observedServerNow = null) {
    if (!validServerTiming(candidate, previous)) throw new Error('EGE_MOCK_TIMER_AUTHORITY_INVALID');
    const startedAt = Date.parse(candidate.writtenStartedAt);
    const wallNow = Number(clock());
    const inherited = candidate.timerAuthority;
    const inheritedIsValid = inherited?.policyId === ATTEMPT_POLICY_ID
      && inherited.writtenStartedAt === candidate.writtenStartedAt
      && inherited.writtenDeadlineAt === candidate.writtenDeadlineAt
      && Number.isFinite(Number(inherited.serverOffsetMs))
      && Number.isFinite(Number(inherited.observedNowMs))
      && Number(inherited.observedNowMs) >= startedAt;
    const serverSample = Number(observedServerNow);
    const hasServerSample = observedServerNow != null && Number.isFinite(serverSample);
    const sampledAuthorityNow = hasServerSample ? Math.max(startedAt, serverSample) : null;
    const serverOffsetMs = hasServerSample ? sampledAuthorityNow - wallNow
      : inheritedIsValid ? Number(inherited.serverOffsetMs) : Math.max(0, startedAt - wallNow);
    const observedNowMs = Math.max(
      startedAt,
      inheritedIsValid ? Number(inherited.observedNowMs) : 0,
      sampledAuthorityNow ?? 0,
      wallNow + serverOffsetMs,
    );
    state.timerAuthority = {
      policyId: ATTEMPT_POLICY_ID,
      writtenStartedAt: candidate.writtenStartedAt,
      writtenDeadlineAt: candidate.writtenDeadlineAt,
      serverOffsetMs,
      observedNowMs,
    };
    timerRuntime = null;
  }

  function authoritativeNow() {
    const authority = state.timerAuthority;
    if (!authority || authority.policyId !== ATTEMPT_POLICY_ID
      || authority.writtenStartedAt !== state.writtenStartedAt
      || authority.writtenDeadlineAt !== state.writtenDeadlineAt) return Number(clock());
    const startedAt = Date.parse(state.writtenStartedAt);
    const monotonic = Number(monotonicNow());
    const wallEstimate = Number(clock()) + (Number(authority.serverOffsetMs) || 0);
    const identity = timerIdentity();
    if (!timerRuntime || timerRuntime.identity !== identity || !Number.isFinite(monotonic)) {
      timerRuntime = {
        identity,
        baseAuthorityMs: Math.max(startedAt, Number(authority.observedNowMs) || 0, wallEstimate),
        baseMonotonicMs: monotonic,
      };
    }
    const monotonicEstimate = Number.isFinite(monotonic) && Number.isFinite(timerRuntime.baseMonotonicMs)
      ? timerRuntime.baseAuthorityMs + Math.max(0, monotonic - timerRuntime.baseMonotonicMs)
      : timerRuntime.baseAuthorityMs;
    const effective = Math.max(startedAt, Number(authority.observedNowMs) || 0, monotonicEstimate);
    authority.observedNowMs = effective;
    return effective;
  }

  function remainingSeconds() {
    if (!state.writtenDeadlineAt) return null;
    return Math.max(0, Math.ceil((Date.parse(state.writtenDeadlineAt) - authoritativeNow()) / 1000));
  }

  function answerComplete(position, answer) {
    const item = form?.positions?.[position - 1];
    const presentation = item?.presentation;
    const counts = {
      listening_matching: item?.assetIds?.length,
      listening_true_false: presentation?.statements?.length,
      reading_headings: presentation?.texts?.length,
      reading_gaps: presentation?.segments?.length - 1,
    };
    const required = counts[presentation?.kind];
    if (Number.isInteger(required)) {
      return Array.isArray(answer) && answer.length >= required
        && answer.slice(0, required).every((value) => typeof value === 'string' && value.trim());
    }
    return typeof answer === 'string' && Boolean(answer.trim());
  }

  function snapshot() {
    const answers = copy(state.answers);
    const completedObjective = OBJECTIVE_POSITIONS.filter((position) => answerComplete(position, answers[String(position)]));
    const completedWritten = WRITTEN_POSITIONS.filter((position) => answerComplete(position, answers[String(position)]));
    const remaining = remainingSeconds();
    const timerWarningMinutes = remaining > 0
      ? ([1, 5, 10, 30].find((minutes) => remaining <= minutes * 60) || null) : null;
    return Object.freeze({
      phase: state.phase,
      formIdentity: state.formIdentity,
      catalogFingerprint: state.catalogFingerprint,
      attemptId: state.attemptId,
      revision: state.revision,
      writtenStartedAt: state.writtenStartedAt,
      writtenDeadlineAt: state.writtenDeadlineAt,
      remainingSeconds: remaining,
      timerWarningMinutes,
      currentPosition: state.currentPosition,
      answers,
      audioPlays: copy(state.audioPlays),
      audioInFlight: state.audioLease ? {
        group: state.audioLease.group, token: state.audioLease.token,
      } : null,
      answeredCount: completedObjective.length,
      blankPositions: OBJECTIVE_POSITIONS.filter((position) => !completedObjective.includes(position)),
      writtenAnsweredCount: completedWritten.length,
      writtenBlankPositions: WRITTEN_POSITIONS.filter((position) => !completedWritten.includes(position)),
      writingWordCounts: Object.freeze(Object.fromEntries([37, 38].map((position) => [
        String(position), typeof answers[String(position)] === 'string'
          ? countEgeWritingWords(answers[String(position)], {
            taskType: `writing_${position}`, assignment: form?.positions?.[position - 1]?.presentation,
          }) : 0,
      ]))),
      writingDraftRecovery: copy(state.writingDraftRecovery),
      assessmentRunQueued: assessmentCommandDescriptor(state.assessmentCommand)?.action === 'run',
      assessmentRetryQueued: assessmentCommandDescriptor(state.assessmentCommand)?.action === 'retry',
      assessmentRunBlocked: assessmentRevisionExhausted(),
      saveStatus: state.saveStatus,
      result: copy(state.result || null),
    });
  }

  function normalizeDurableShape(value) {
    const durableInvalidation = Number.isSafeInteger(value.invalidationWatermark)
      && value.invalidationWatermark >= 0 ? value.invalidationWatermark : 0;
    if (durableInvalidation !== invalidationWatermark) throw invalidatedError();
    value.invalidationWatermark = durableInvalidation;
    if (typeof value.attemptId === 'string') {
      if (!validServerTiming(value)) throw new Error('EGE_MOCK_WRITTEN_LOCAL_STATE_INVALID');
      if (typeof value.attemptOwnerGeneration !== 'string' || !value.attemptOwnerGeneration) {
        throw new Error('EGE_MOCK_WRITTEN_LOCAL_STATE_INVALID');
      }
      const startedAt = Date.parse(value.writtenStartedAt);
      const wallNow = Number(clock());
      if (value.timerAuthority != null) {
        const authority = value.timerAuthority;
        if (authority?.policyId !== ATTEMPT_POLICY_ID
          || authority.writtenStartedAt !== value.writtenStartedAt
          || authority.writtenDeadlineAt !== value.writtenDeadlineAt
          || !Number.isFinite(Number(authority.serverOffsetMs))
          || !Number.isFinite(Number(authority.observedNowMs)) || Number(authority.observedNowMs) < startedAt) {
          throw new Error('EGE_MOCK_WRITTEN_LOCAL_STATE_INVALID');
        }
      } else {
        const serverOffsetMs = Math.max(0, startedAt - wallNow);
        value.timerAuthority = {
          policyId: ATTEMPT_POLICY_ID,
          writtenStartedAt: value.writtenStartedAt,
          writtenDeadlineAt: value.writtenDeadlineAt,
          serverOffsetMs,
          observedNowMs: Math.max(startedAt, wallNow + serverOffsetMs),
        };
      }
    }
    value.answerVersions = value.answerVersions && typeof value.answerVersions === 'object'
      && !Array.isArray(value.answerVersions) ? value.answerVersions : {};
    Object.entries(value.answers || {}).forEach(([position, answer]) => {
      value.answerVersions[position] ||= {
        id: `server:${Number(value.revision) || 0}:${position}`, recordedAt: 0, value: copy(answer),
      };
    });
    value.audioPlays = Object.fromEntries(AUDIO_GROUPS.map((group) => [
      group, Math.min(2, Math.max(0, Number(value.audioPlays?.[group]) || 0)),
    ]));
    value.compactedThrough = value.compactedThrough && typeof value.compactedThrough === 'object'
      && Number.isFinite(Number(value.compactedThrough.createdAt))
      && typeof value.compactedThrough.idempotencyKey === 'string'
      ? value.compactedThrough : null;
    value.canceledSubmit = value.canceledSubmit && typeof value.canceledSubmit === 'object'
      && Number.isFinite(Number(value.canceledSubmit.createdAt))
      && typeof value.canceledSubmit.idempotencyKey === 'string'
      ? value.canceledSubmit : null;
    const hasCurrentCommandThrough = Object.hasOwn(value, 'assessmentCommandThrough');
    const hasLegacyCommandThrough = !hasCurrentCommandThrough
      && Object.hasOwn(value, 'assessmentRetryThrough');
    const storedCommandThrough = hasCurrentCommandThrough
      ? value.assessmentCommandThrough : hasLegacyCommandThrough ? value.assessmentRetryThrough : null;
    if (storedCommandThrough != null && (!storedCommandThrough
      || typeof storedCommandThrough !== 'object' || Array.isArray(storedCommandThrough)
      || !Number.isSafeInteger(storedCommandThrough.createdAt)
      || storedCommandThrough.createdAt < 0
      || !UUID_V4.test(storedCommandThrough.idempotencyKey)
      || Object.keys(storedCommandThrough).sort().join(',') !== 'createdAt,idempotencyKey')) {
      throw localStateError();
    }
    value.assessmentCommandThrough = storedCommandThrough == null ? null : storedCommandThrough;
    if (value.assessmentCommandBlockedRevision == null) {
      value.assessmentCommandBlockedRevision = null;
    } else if (!Number.isSafeInteger(value.assessmentCommandBlockedRevision)
      || value.assessmentCommandBlockedRevision < 0) {
      throw localStateError();
    } else {
      value.assessmentCommandBlockedRevision = ASSESSMENT_EXHAUSTION_SENTINEL;
    }
    const hasCurrentCommand = Object.hasOwn(value, 'assessmentCommand');
    const hasLegacyCommand = !hasCurrentCommand && Object.hasOwn(value, 'assessmentRetry');
    const storedCommand = hasCurrentCommand
      ? value.assessmentCommand : hasLegacyCommand ? value.assessmentRetry : null;
    let descriptor = assessmentCommandDescriptor(storedCommand);
    if (storedCommand && !descriptor && hasLegacyCommand
      && !Object.hasOwn(storedCommand, 'action')) descriptor = ASSESSMENT_COMMANDS.retry;
    if (storedCommand != null) {
      const normalizedCommand = descriptor && typeof storedCommand === 'object'
        && !Array.isArray(storedCommand) ? { ...storedCommand, action: descriptor.action } : null;
      const allowedKeys = descriptor?.action === 'run' && normalizedCommand?.explicitRenewal === true
        ? 'acknowledgePossibleProviderRepeat,action,createdAt,explicitRenewal,idempotencyKey'
        : 'acknowledgePossibleProviderRepeat,action,createdAt,idempotencyKey';
      if (!normalizedCommand
        || Object.keys(normalizedCommand).sort().join(',') !== allowedKeys
        || !UUID_V4.test(normalizedCommand.idempotencyKey)
        || !Number.isSafeInteger(normalizedCommand.createdAt) || normalizedCommand.createdAt < 0
        || typeof normalizedCommand.acknowledgePossibleProviderRepeat !== 'boolean'
        || (descriptor.action === 'run'
          && normalizedCommand.acknowledgePossibleProviderRepeat !== false)
        || (Object.hasOwn(normalizedCommand, 'explicitRenewal')
          && (descriptor.action !== 'run' || normalizedCommand.explicitRenewal !== true))
        || !queueEventAfter(normalizedCommand, value.assessmentCommandThrough)) {
        throw localStateError();
      }
      value.assessmentCommand = normalizedCommand;
    } else {
      value.assessmentCommand = null;
    }
    delete value.assessmentRetry;
    delete value.assessmentRetryThrough;
    retireExhaustedAssessmentCommand(value);
    value.assetBlockedAt = Math.max(0, Number(value.assetBlockedAt) || (value.phase === 'asset_blocked' ? 1 : 0));
    value.assetReadyAt = Math.max(0, Number(value.assetReadyAt) || 0);
    value.assetResumePhase = value.assetResumePhase === 'writing' ? 'writing' : null;
    value.audioLease = value.audioLease && AUDIO_GROUPS.includes(value.audioLease.group)
      && typeof value.audioLease.token === 'string' && Number(value.audioLease.expiresAt) > Number(localNow())
      ? value.audioLease : null;
    value.audioLeaseThrough = value.audioLeaseThrough && typeof value.audioLeaseThrough === 'object'
      && Number.isFinite(Number(value.audioLeaseThrough.createdAt))
      && typeof value.audioLeaseThrough.idempotencyKey === 'string'
      ? value.audioLeaseThrough : null;
    delete value.canceledSubmitId;
    delete value.acknowledgedIds;
    value.queue = Array.isArray(value.queue) ? value.queue : [];
    const recoveredWritingPositions = new Set(
      Array.isArray(value.writingDraftRecovery?.positions)
        ? value.writingDraftRecovery.positions.filter((position) => position === 37 || position === 38)
        : [],
    );
    function normalizeWritingContainer(container) {
      if (!container || typeof container !== 'object' || Array.isArray(container)) return;
      for (const position of [37, 38]) {
        const key = String(position);
        if (!Object.hasOwn(container, key) || container[key] == null) continue;
        const limit = WRITING_TEXT_LIMITS[position];
        if (typeof container[key] === 'string') {
          if (container[key].length > limit) throw new Error('EGE_MOCK_WRITTEN_LOCAL_STATE_INVALID');
          continue;
        }
        if (Array.isArray(container[key])
          && container[key].every((part) => typeof part === 'string')) {
          const restored = container[key].join('\n');
          if (restored.length > limit) throw new Error('EGE_MOCK_WRITTEN_LOCAL_STATE_INVALID');
          container[key] = restored;
          recoveredWritingPositions.add(position);
          continue;
        }
        throw new Error('EGE_MOCK_WRITTEN_LOCAL_STATE_INVALID');
      }
    }
    normalizeWritingContainer(value.answers);
    Object.entries(value.answerVersions).forEach(([position, record]) => {
      if (record && typeof record === 'object' && (position === '37' || position === '38')) {
        const candidate = { [position]: record.value };
        normalizeWritingContainer(candidate);
        record.value = candidate[position];
      }
    });
    value.queue.forEach((event) => {
      if (event?.type === 'draft') normalizeWritingContainer(event.answers);
    });
    value.writingDraftRecovery = recoveredWritingPositions.size ? {
      positions: [...recoveredWritingPositions].sort((left, right) => left - right),
      kind: 'legacy_array',
    } : null;
    if (value.result?.writingAssessment != null
      && !validAssessmentProjection(value.result.writingAssessment)) throw localStateError();
    logicalTime = Math.max(logicalTime,
      ...Object.values(value.answerVersions).map((record) => (
        serverAnswerRevision(record) != null && record?.recordedAt === Number.MAX_SAFE_INTEGER
          ? 0 : Number(record?.recordedAt) || 0
      )),
      ...value.queue.map((event) => Number(event?.createdAt) || 0),
      Number(value.compactedThrough?.createdAt) || 0,
      Number(value.canceledSubmit?.createdAt) || 0,
      Number(value.assessmentCommand?.createdAt) || 0,
      Number(value.assessmentCommandThrough?.createdAt) || 0,
      value.assetBlockedAt, value.assetReadyAt,
      Number(value.audioLease?.createdAt) || 0,
      Number(value.audioLeaseThrough?.createdAt) || 0);
    return value;
  }

  function serverAnswerRevision(record) {
    const match = /^server:(\d+):\d+$/u.exec(String(record?.id || ''));
    if (!match) return null;
    const revision = Number(match[1]);
    return Number.isSafeInteger(revision) && revision >= 0 ? revision : null;
  }

  function recordIsNewer(left, right) {
    const leftServerRevision = serverAnswerRevision(left);
    const rightServerRevision = serverAnswerRevision(right);
    if (leftServerRevision != null && rightServerRevision != null
      && leftServerRevision !== rightServerRevision) {
      return leftServerRevision > rightServerRevision;
    }
    const leftTime = Number(left?.recordedAt) || 0;
    const rightTime = Number(right?.recordedAt) || 0;
    return leftTime > rightTime || (leftTime === rightTime && String(left?.id || '') > String(right?.id || ''));
  }

  function compareQueueOrder(left, right) {
    return (Number(left?.createdAt) || 0) - (Number(right?.createdAt) || 0)
      || String(left?.idempotencyKey || '').localeCompare(String(right?.idempotencyKey || ''));
  }

  function queueEventAfter(event, watermark) {
    return !watermark || compareQueueOrder(event, watermark) > 0;
  }

  function ensureAutomaticAssessmentRun() {
    const status = state.result?.writingAssessment?.status;
    if (state.phase !== 'written_submitted' || typeof transport.runAssessment !== 'function'
      || state.result?.writingAssessment?.runDisposition === 'subscription_required'
      || assessmentRevisionExhausted()
      || !['pending', 'in_progress'].includes(status) || state.assessmentCommand) return false;
    state.assessmentCommand = {
      action: 'run', idempotencyKey: uuid(), createdAt: nextLocalTime(),
      acknowledgePossibleProviderRepeat: false,
    };
    state.saveStatus = 'queued';
    return true;
  }

  function newerWatermark(left, right) {
    const selected = !left ? right : !right ? left : compareQueueOrder(left, right) >= 0 ? left : right;
    return selected ? {
      createdAt: Number(selected.createdAt) || 0,
      idempotencyKey: String(selected.idempotencyKey || ''),
    } : null;
  }

  function retireExhaustedAssessmentCommand(candidate) {
    if (!assessmentRevisionExhausted(candidate) || !candidate.assessmentCommand) return false;
    candidate.assessmentCommandThrough = newerWatermark(
      candidate.assessmentCommandThrough, candidate.assessmentCommand,
    );
    candidate.assessmentCommand = null;
    if (!candidate.queue?.length) candidate.saveStatus = 'saved';
    return true;
  }

  function compactQueue(events, watermark) {
    const unique = new Map();
    events.forEach((event) => {
      if (!event?.idempotencyKey || !queueEventAfter(event, watermark)
        || (event.type === 'submit'
          && state.canceledSubmit
          && compareQueueOrder(event, state.canceledSubmit) <= 0)) return;
      const existing = unique.get(event.idempotencyKey);
      if (!existing || event.attempted === true || existing.attempted !== true) {
        unique.set(event.idempotencyKey, copy(event));
      }
    });
    const ordered = [...unique.values()].sort(compareQueueOrder);
    const newestUnattemptedDraft = ordered.filter((event) => (
      event.type === 'draft' && event.attempted !== true
    )).at(-1);
    if (newestUnattemptedDraft) {
      newestUnattemptedDraft.dirtyPositions = [...new Set(ordered
        .filter((event) => event.type === 'draft' && event.attempted !== true)
        .flatMap((event) => Array.isArray(event.dirtyPositions) ? event.dirtyPositions : []))];
      newestUnattemptedDraft.dirtyVersions = Object.fromEntries(newestUnattemptedDraft.dirtyPositions
        .flatMap((position) => {
          const key = String(position);
          const version = ordered.filter((event) => event.type === 'draft' && event.attempted !== true
            && typeof event.dirtyVersions?.[key] === 'string').at(-1)?.dirtyVersions?.[key];
          return version ? [[key, version]] : [];
        }));
      newestUnattemptedDraft.completesObjective = ordered.some((event) => (
        event.type === 'draft' && event.attempted !== true && event.completesObjective === true
      ));
    }
    const newestSubmit = ordered.filter((event) => event.type === 'submit').at(-1);
    return ordered.filter((event) => event.type !== 'draft' || event.attempted === true
      || event.idempotencyKey === newestUnattemptedDraft?.idempotencyKey)
      .filter((event) => event.type !== 'submit'
        || event.idempotencyKey === newestSubmit?.idempotencyKey);
  }

  function retireThrough(event) {
    state.compactedThrough = newerWatermark(state.compactedThrough, event);
    state.queue = compactQueue(state.queue, state.compactedThrough);
  }

  function acknowledgeDraftVersions(event, appliedDraft, revision) {
    for (const position of event.dirtyPositions || []) {
      const key = String(position);
      const acknowledgedVersion = event.dirtyVersions?.[key];
      if (typeof acknowledgedVersion !== 'string') continue;
      state.queue.forEach((candidate) => {
        if (candidate === event || candidate.type !== 'draft'
          || candidate.dirtyVersions?.[key] !== acknowledgedVersion) return;
        candidate.dirtyPositions = (candidate.dirtyPositions || [])
          .filter((dirtyPosition) => String(dirtyPosition) !== key);
        delete candidate.dirtyVersions[key];
      });
      if (state.answerVersions[key]?.id !== acknowledgedVersion) continue;
      if (Object.hasOwn(appliedDraft, key)) {
        state.answers[key] = copy(appliedDraft[key]);
        state.answerVersions[key] = {
          id: `server:${revision}:${key}`, recordedAt: nextLocalTime(), value: copy(appliedDraft[key]),
        };
      } else {
        delete state.answers[key];
        delete state.answerVersions[key];
      }
    }
  }

  function mergeStoredState() {
    assertInvalidationCurrent();
    let saved;
    try { saved = JSON.parse(storage.getItem(storageKey()) || 'null'); } catch (_) { return; }
    if (saved?.version !== STORAGE_VERSION
      || saved.formIdentity !== state.formIdentity || saved.catalogFingerprint !== state.catalogFingerprint
      || saved.owner?.username !== owner.username || saved.owner?.generation !== owner.generation) return;
    if (!state.attemptId) {
      if (typeof saved.attemptId === 'string' && Number.isInteger(saved.revision)) {
        const previousLogicalTime = logicalTime;
        try {
          const adopted = normalizeDurableShape(copy(saved));
          state = adopted;
        } catch (error) {
          logicalTime = previousLogicalTime;
          throw error;
        }
      }
      return;
    }
    if (saved.attemptId !== state.attemptId) return;
    const previousState = state;
    const previousLogicalTime = logicalTime;
    state = copy(previousState);
    saved = copy(saved);
    try {
      normalizeDurableShape(state);
      normalizeDurableShape(saved);
    function storedAssessment(result) {
      const candidate = result?.writingAssessment;
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)
        || !Object.hasOwn(candidate, 'assessmentRevision')) return null;
      if (!validAssessmentProjection(candidate)) throw assessmentResponseError();
      return candidate;
    }
    const localAssessment = storedAssessment(state.result);
    const savedAssessment = storedAssessment(saved.result);
    if (localAssessment && savedAssessment
      && localAssessment.assessmentRevision === savedAssessment.assessmentRevision
      && !sameSemanticJsonValue(localAssessment, savedAssessment)) throw assessmentResponseError();
    const savedAssessmentWins = Boolean(savedAssessment && (!localAssessment
      || savedAssessment.assessmentRevision > localAssessment.assessmentRevision));
    const mergedAssessment = savedAssessmentWins ? savedAssessment : localAssessment || savedAssessment;
    const localRevisionBeforeMerge = Number(state.revision) || 0;
    const localObservedNow = Number(state.timerAuthority.observedNowMs) || 0;
    const savedObservedNow = Number(saved.timerAuthority.observedNowMs) || 0;
    if (savedObservedNow > localObservedNow
      || (savedObservedNow === localObservedNow
        && Number(saved.timerAuthority.serverOffsetMs) > Number(state.timerAuthority.serverOffsetMs))) {
      state.timerAuthority.serverOffsetMs = Number(saved.timerAuthority.serverOffsetMs);
    }
    state.timerAuthority.observedNowMs = Math.max(
      Number(state.timerAuthority.observedNowMs) || 0,
      Number(saved.timerAuthority.observedNowMs) || 0,
    );
    state.compactedThrough = newerWatermark(state.compactedThrough, saved.compactedThrough);
    state.canceledSubmit = newerWatermark(state.canceledSubmit, saved.canceledSubmit);
    state.assessmentCommandThrough = newerWatermark(
      state.assessmentCommandThrough, saved.assessmentCommandThrough,
    );
    state.assessmentCommandBlockedRevision = assessmentRevisionExhausted(state)
      || assessmentRevisionExhausted(saved) ? ASSESSMENT_EXHAUSTION_SENTINEL : null;
    const assessmentCommands = [state.assessmentCommand, saved.assessmentCommand]
      .filter((event) => event && queueEventAfter(event, state.assessmentCommandThrough))
      .sort(compareQueueOrder);
    state.assessmentCommand = assessmentCommands.at(-1) || null;
    retireExhaustedAssessmentCommand(state);
    const localAssetBlockedAt = state.assetBlockedAt;
    const savedAssetBlockedAt = saved.assetBlockedAt;
    if (savedAssetBlockedAt > localAssetBlockedAt
      || (savedAssetBlockedAt === localAssetBlockedAt && saved.assetResumePhase === 'writing')) {
      state.assetBlockedAt = savedAssetBlockedAt;
      state.assetResumePhase = saved.assetResumePhase === 'writing' ? 'writing' : null;
    }
    state.assetReadyAt = Math.max(state.assetReadyAt, saved.assetReadyAt);
    state.audioLeaseThrough = newerWatermark(state.audioLeaseThrough, saved.audioLeaseThrough);
    const positions = new Set([...Object.keys(state.answerVersions), ...Object.keys(saved.answerVersions)]);
    positions.forEach((position) => {
      const local = state.answerVersions[position];
      const remote = saved.answerVersions[position];
      if (!local || (remote && recordIsNewer(remote, local))) state.answerVersions[position] = copy(remote);
      if (state.answerVersions[position]) state.answers[position] = copy(state.answerVersions[position].value);
    });
    state.queue = compactQueue([...saved.queue, ...state.queue], state.compactedThrough);
    AUDIO_GROUPS.forEach((group) => {
      state.audioPlays[group] = Math.max(state.audioPlays[group], saved.audioPlays[group]);
    });
    const leases = [state.audioLease, saved.audioLease].filter((lease) => lease
      && queueEventAfter({ createdAt: lease.createdAt, idempotencyKey: lease.token }, state.audioLeaseThrough))
      .sort((left, right) => (
      Number(right.createdAt) - Number(left.createdAt)
    ));
    state.audioLease = leases[0] || null;
    if (Number.isInteger(saved.revision) && saved.revision > state.revision) state.revision = saved.revision;
    if (saved.phase === 'written_submitted'
      && (state.phase !== 'written_submitted' || saved.revision > localRevisionBeforeMerge)) {
      state.phase = saved.phase;
      state.queue = [];
      state.result = copy(saved.result);
      state.saveStatus = 'saved';
    } else {
      const ranks = {
        running: 0, asset_blocked: 0, objective_queued: 1, objective_completed: 2,
        writing: 3, submit_queued: 4, written_submitted: 5,
      };
      const savedPhaseStillPending = saved.phase !== 'submit_queued'
        || state.queue.some((event) => event.type === 'submit');
      if (savedPhaseStillPending && (ranks[saved.phase] ?? -1) > (ranks[state.phase] ?? -1)) {
        state.phase = saved.phase;
        if (saved.phase === 'objective_completed') state.result = copy(saved.result);
      }
    }
    if (state.phase === 'written_submitted' && mergedAssessment) {
      if (savedAssessmentWins) state.result = copy(saved.result);
      else if (state.result) state.result.writingAssessment = copy(mergedAssessment);
    }
    if (state.assetBlockedAt > state.assetReadyAt && ['running', 'writing'].includes(state.phase)) {
      state.assetResumePhase = state.phase === 'writing' ? 'writing' : null;
      state.phase = 'asset_blocked';
    }
    if (state.assetReadyAt >= state.assetBlockedAt && state.phase === 'asset_blocked') {
      state.phase = state.assetResumePhase || 'running';
      state.assetResumePhase = null;
    }
    } catch (error) {
      state = previousState;
      logicalTime = previousLogicalTime;
      throw error;
    }
  }

  function markAssetBlocked() {
    state.assetBlockedAt = nextLocalTime();
    if (state.phase === 'writing') state.assetResumePhase = 'writing';
    state.phase = 'asset_blocked';
  }

  function markAssetsReady() {
    state.assetReadyAt = nextLocalTime();
    if (state.phase === 'asset_blocked') state.phase = state.assetResumePhase || 'running';
    state.assetResumePhase = null;
  }

  function rebaseUnattemptedQueue() {
    let revision = Number(state.revision) || 0;
    state.queue.forEach((event) => {
      if (event.attempted !== true) event.expectedRevision = revision;
      revision = Math.max(revision, Number(event.expectedRevision) || 0) + 1;
    });
  }

  function notify() {
    const value = snapshot();
    listeners.forEach((listener) => listener(value));
    return value;
  }

  function persist() {
    if (!state.formIdentity) return;
    try {
      assertInvalidationCurrent();
      mergeStoredState();
      normalizeDurableShape(state);
      rebaseUnattemptedQueue();
      if ((state.queue.length && ['running', 'writing', 'submit_queued'].includes(state.phase))
        || state.assessmentCommand) state.saveStatus = 'queued';
      state.invalidationWatermark = invalidationWatermark;
      storage.setItem(storageKey(), JSON.stringify(state));
    } catch (cause) {
      if (cause?.code === 'EGE_MOCK_WRITTEN_LOCAL_STATE_INVALIDATED') throw cause;
      throw Object.assign(new Error('EGE_MOCK_LOCAL_STORAGE_FAILED', { cause }), {
        code: 'EGE_MOCK_LOCAL_STORAGE_FAILED',
      });
    }
  }

  function persistLocked() {
    return withDurableLock(() => withAuthorityCommit(() => persist()));
  }

  function storageKey() {
    return runnerStorageKey(owner);
  }

  function invalidate() {
    return withDurableLock(() => withAuthorityCommit(() => {
      assertInvalidationCurrent();
      const nextWatermark = invalidationWatermark + 1;
      let encoded;
      try {
        encoded = storage.getItem(storageKey());
        storage.removeItem(storageKey());
      } catch (cause) {
        throw Object.assign(new Error('EGE_MOCK_LOCAL_STORAGE_FAILED', { cause }), {
          code: 'EGE_MOCK_LOCAL_STORAGE_FAILED',
        });
      }
      try {
        storage.setItem(runnerInvalidationKey(owner), JSON.stringify({
          version: 1, owner, watermark: nextWatermark,
        }));
      } catch (cause) {
        try { if (encoded != null) storage.setItem(storageKey(), encoded); } catch (_) {}
        throw Object.assign(new Error('EGE_MOCK_LOCAL_STORAGE_FAILED', { cause }), {
          code: 'EGE_MOCK_LOCAL_STORAGE_FAILED',
        });
      }
      invalidationWatermark = nextWatermark;
      state.invalidationWatermark = nextWatermark;
      return true;
    }));
  }

  async function prepare(candidate) {
    if (!online()) throw Object.assign(new Error('EGE_MOCK_START_REQUIRES_NETWORK'), { code: 'NETWORK_ERROR' });
    form = assertForm(candidate);
    state.phase = 'preflighting';
    notify();
    let result;
    try {
      result = await assets.preflight(form);
    } catch (error) {
      state.phase = 'error';
      notify();
      throw error;
    }
    if (result?.identity !== form.identity || result?.fingerprint !== form.fingerprint) {
      state.phase = 'error';
      notify();
      throw new Error('EGE_MOCK_ASSET_PREFLIGHT_MISMATCH');
    }
    state = {
      ...state,
      phase: 'ready',
      formIdentity: form.identity,
      catalogFingerprint: form.fingerprint,
      preflight: copy(result),
    };
    await persistLocked();
    return notify();
  }

  async function start() {
    return withDurableLock(async () => {
      mergeStoredState();
      if (state.attemptId) return notify();
      if (state.phase !== 'ready' || !form || !state.preflight) throw new Error('EGE_MOCK_PREFLIGHT_REQUIRED');
      if (!online()) throw Object.assign(new Error('EGE_MOCK_START_REQUIRES_NETWORK'), { code: 'NETWORK_ERROR' });
      state.pendingStartId ||= uuid();
      try {
        const ready = typeof assets.isReady === 'function'
          ? await assets.isReady(form, state.preflight) : true;
        if (!ready) throw new Error('EGE_MOCK_ASSET_PREFLIGHT_REQUIRED');
      } catch (error) {
        state.phase = 'error';
        state.preflight = null;
        await withAuthorityCommit(() => persist());
        notify();
        throw error;
      }
      await withAuthorityCommit(() => persist());
      if (state.attemptId) return notify();
      const result = await transport.start({
        formId: form.id,
        formRevision: form.revision,
        catalogFingerprint: form.fingerprint,
        idempotencyKey: state.pendingStartId,
      });
      const attempt = result?.attempt;
      if (!attempt || typeof attempt.id !== 'string' || !attempt.id
        || typeof attempt.ownerGeneration !== 'string' || !attempt.ownerGeneration
        || !Number.isInteger(attempt.revision) || attempt.revision < 0
        || !attempt.draft || typeof attempt.draft !== 'object' || Array.isArray(attempt.draft)
        || !validServerTiming(attempt) || attempt.formId !== form.id || attempt.formRevision !== form.revision
        || attempt.catalogFingerprint !== form.fingerprint || attempt.state !== 'written_in_progress') {
        throw new Error('EGE_MOCK_START_RESPONSE_INVALID');
      }
      state = {
        ...state,
        phase: 'running',
        attemptId: attempt.id,
        attemptOwnerGeneration: attempt.ownerGeneration,
        revision: attempt.revision,
        policyId: attempt.policyId,
        writtenStartedAt: attempt.writtenStartedAt,
        writtenDeadlineAt: attempt.writtenDeadlineAt,
        answers: copy(attempt.draft || {}),
        answerVersions: Object.fromEntries(Object.entries(attempt.draft || {}).map(([position, value]) => [
          position, { id: `server:${attempt.revision}:${position}`, recordedAt: 0, value: copy(value) },
        ])),
        audioPlays: { matching: 0, true_false: 0, interview: 0 },
        compactedThrough: null,
        canceledSubmit: null,
        assetBlockedAt: 0,
        assetReadyAt: nextLocalTime(),
        audioLease: null,
        audioLeaseThrough: null,
        pendingStartId: null,
        saveStatus: 'saved',
      };
      seedTimerAuthority(attempt, null, result?.serverTimeMs);
      await withAuthorityCommit(() => persist());
      return notify();
    });
  }

  async function answer(position, value) {
    return withDurableLock(async () => {
      mergeStoredState();
      if (!['running', 'writing'].includes(state.phase)) throw new Error('EGE_MOCK_WRITTEN_NOT_RUNNING');
      if (!WRITTEN_POSITIONS.includes(position)) throw new TypeError('EGE_MOCK_WRITTEN_POSITION_INVALID');
      if (state.phase === 'running' && !OBJECTIVE_POSITIONS.includes(position)) {
        throw new TypeError('EGE_MOCK_WRITTEN_POSITION_INVALID');
      }
      const textLimit = WRITING_TEXT_LIMITS[position] || 100;
      const writingPosition = position === 37 || position === 38;
      const valid = value == null || (typeof value === 'string' && value.length <= textLimit)
        || (!writingPosition && Array.isArray(value) && value.length <= 20
          && value.every((item) => typeof item === 'string' && item.length <= 40));
      if (!valid) throw new TypeError('EGE_MOCK_WRITTEN_ANSWER_INVALID');
      const normalizedValue = writingPosition && typeof value === 'string'
        ? sanitizeEgeWritingText(value) : value;
      const previous = copy(state);
      const eventId = uuid();
      const recordedAt = nextLocalTime();
      state.answers[String(position)] = copy(normalizedValue);
      state.answerVersions[String(position)] = {
        id: eventId, recordedAt, value: copy(normalizedValue),
      };
      if (writingPosition && state.writingDraftRecovery?.positions.includes(position)) {
        const positions = state.writingDraftRecovery.positions.filter((candidate) => candidate !== position);
        state.writingDraftRecovery = positions.length
          ? { positions, kind: state.writingDraftRecovery.kind } : null;
      }
      const dirtyPositions = [...new Set([
        ...state.queue.filter((event) => event.type === 'draft')
          .flatMap((event) => Array.isArray(event.dirtyPositions) ? event.dirtyPositions : []),
        position,
      ])];
      const dirtyVersions = Object.fromEntries(dirtyPositions.flatMap((dirtyPosition) => {
        const version = state.answerVersions[String(dirtyPosition)]?.id;
        return typeof version === 'string' ? [[String(dirtyPosition), version]] : [];
      }));
      state.queue = state.queue.filter((event) => !(event.type === 'draft' && event.attempted !== true));
      state.queue = compactQueue([...state.queue, {
        type: 'draft', idempotencyKey: eventId, expectedRevision: state.revision,
        answers: copy(state.answers), createdAt: recordedAt, attempted: false,
        dirtyPositions, dirtyVersions,
      }], state.compactedThrough);
      state.saveStatus = 'queued';
      try { await withAuthorityCommit(() => persist()); } catch (error) { state = previous; throw error; }
      return notify();
    });
  }

  async function navigate(position) {
    return withDurableLock(async () => {
      mergeStoredState();
      if (!['running', 'writing'].includes(state.phase)) throw new Error('EGE_MOCK_WRITTEN_NOT_RUNNING');
      if (!WRITTEN_POSITIONS.includes(position)) throw new TypeError('EGE_MOCK_WRITTEN_POSITION_INVALID');
      if (state.phase === 'running' && !OBJECTIVE_POSITIONS.includes(position)) {
        throw new TypeError('EGE_MOCK_WRITTEN_POSITION_INVALID');
      }
      const previous = copy(state);
      state.currentPosition = position;
      try { await withAuthorityCommit(() => persist()); } catch (error) { state = previous; throw error; }
      return notify();
    });
  }

  function assertCurrentAttempt(attempt) {
    if (typeof attempt?.ownerGeneration !== 'string' || !attempt.ownerGeneration
      || attempt.ownerGeneration !== state.attemptOwnerGeneration) {
      throw Object.assign(new Error('EGE_MOCK_ATTEMPT_OWNER_CHANGED'), { code: 'EGE_MOCK_ATTEMPT_OWNER_CHANGED' });
    }
    if (!attempt || attempt.id !== state.attemptId || !Number.isInteger(attempt.revision)
      || attempt.revision < 0 || !validServerTiming(attempt, state.attemptId ? state : null) || attempt.formId !== form.id
      || attempt.formRevision !== form.revision || attempt.catalogFingerprint !== form.fingerprint
      || ![
        'written_in_progress', 'written_submitted', 'oral_ready', 'oral_in_progress',
        'assessment_pending', 'completed', 'expired',
      ].includes(attempt.state) || !validAssessmentProjection(attempt.writingAssessment)
      || !attempt.draft || typeof attempt.draft !== 'object' || Array.isArray(attempt.draft)) {
      throw new Error('EGE_MOCK_RESTORE_RESPONSE_INVALID');
    }
    return attempt;
  }

  function adoptServerAttempt(candidate, serverTimeMs = null) {
    if (!candidate || typeof candidate.id !== 'string'
      || typeof candidate.ownerGeneration !== 'string' || !candidate.ownerGeneration
      || !Number.isInteger(candidate.revision) || candidate.revision < 0
      || !validServerTiming(candidate) || candidate.formId !== form.id
      || candidate.formRevision !== form.revision || candidate.catalogFingerprint !== form.fingerprint
      || ![
        'written_in_progress', 'written_submitted', 'oral_ready', 'oral_in_progress',
        'assessment_pending', 'completed', 'expired',
      ].includes(candidate.state) || !validAssessmentProjection(candidate.writingAssessment)
      || !candidate.draft || typeof candidate.draft !== 'object' || Array.isArray(candidate.draft)) {
      throw new Error('EGE_MOCK_RESTORE_RESPONSE_INVALID');
    }
    timerRuntime = null;
    state = {
      ...state,
      phase: 'running',
      formIdentity: form.identity,
      catalogFingerprint: form.fingerprint,
      attemptId: candidate.id,
      attemptOwnerGeneration: candidate.ownerGeneration,
      revision: candidate.revision,
      policyId: candidate.policyId,
      writtenStartedAt: candidate.writtenStartedAt,
      writtenDeadlineAt: candidate.writtenDeadlineAt,
      timerAuthority: null,
      answers: {},
      answerVersions: {},
      audioPlays: { matching: 0, true_false: 0, interview: 0 },
      currentPosition: 1,
      preflight: null,
      pendingStartId: null,
      saveStatus: 'saved',
      queue: [],
      compactedThrough: null,
      canceledSubmit: null,
      assessmentCommand: null,
      assessmentCommandThrough: null,
      assessmentCommandBlockedRevision: null,
      assetBlockedAt: 0,
      assetReadyAt: 0,
      audioLease: null,
      audioLeaseThrough: null,
      result: null,
    };
    applyServerCurrent(candidate, serverTimeMs);
  }

  function writtenAnswers(candidate = {}) {
    return Object.fromEntries(WRITTEN_POSITIONS.flatMap((position) => (
      Object.hasOwn(candidate, String(position)) ? [[String(position), copy(candidate[String(position)])]] : []
    )));
  }

  function objectiveResult(kind, serverState, answers, extra = {}) {
    const positions = kind === 'objective_written_checkpoint' ? OBJECTIVE_POSITIONS : WRITTEN_POSITIONS;
    return {
      kind, attemptId: state.attemptId, state: serverState,
      ...(kind === 'objective_written_checkpoint'
        ? { checkpointPositions: [...OBJECTIVE_POSITIONS] }
        : { submittedPositions: [...WRITTEN_POSITIONS] }),
      blankPositions: positions.filter((position) => !answerComplete(position, answers[String(position)])),
      ...extra,
    };
  }

  function applyServerCurrent(candidate, serverTimeMs = null) {
    const attempt = assertCurrentAttempt(candidate);
    const writingAssessment = mergeWritingAssessmentProjection(attempt.writingAssessment);
    if (attempt.id === state.attemptId && Number.isInteger(state.revision)
      && attempt.revision < state.revision) {
      if (state.result) state.result.writingAssessment = copy(writingAssessment);
      return;
    }
    const resumePhase = state.phase === 'writing' || state.assetResumePhase === 'writing' ? 'writing' : 'running';
    const resumeAssetBlocked = state.assetBlockedAt > state.assetReadyAt || state.phase === 'asset_blocked'
      || state.queue.some((event) => event.type === 'submit' && event.resumeAssetBlocked === true);
    const inheritedTimerAuthority = copy(state.timerAuthority);
    state.policyId = attempt.policyId;
    state.writtenStartedAt = attempt.writtenStartedAt;
    state.writtenDeadlineAt = attempt.writtenDeadlineAt;
    seedTimerAuthority({ ...attempt, timerAuthority: inheritedTimerAuthority }, state, serverTimeMs);
    if (attempt.state !== 'written_in_progress') {
      const localAnswers = copy(state.answers);
      const serverAnswers = writtenAnswers(attempt.draft);
      const offlineChangesNotAccepted = state.queue.some((event) => event.type === 'draft')
        && JSON.stringify(localAnswers) !== JSON.stringify(serverAnswers);
      [...state.queue].forEach(retireThrough);
      state.queue = [];
      state.revision = attempt.revision;
      state.answers = serverAnswers;
      state.answerVersions = Object.fromEntries(WRITTEN_POSITIONS.map((position) => [
        String(position), {
          id: `server:${attempt.revision}:${position}`, recordedAt: Number.MAX_SAFE_INTEGER,
          value: copy(serverAnswers[String(position)]),
        },
      ]));
      state.phase = 'written_submitted';
      state.saveStatus = 'saved';
      state.result = objectiveResult('objective_written_submission', attempt.state, serverAnswers, {
        offlineChangesNotAccepted,
        writingAssessment,
      });
      ensureAutomaticAssessmentRun();
      return;
    }
    const localSubmit = state.queue.findLast((event) => event.type === 'submit');
    if (localSubmit) state.canceledSubmit = newerWatermark(state.canceledSubmit, localSubmit);
    state.queue = compactQueue(state.queue.filter((event) => event.type !== 'submit'), state.compactedThrough);
    state.saveStatus = state.queue.length ? 'queued' : 'saved';
    if (!state.queue.length) {
      state.revision = attempt.revision;
      state.answers = writtenAnswers(attempt.draft);
      state.answerVersions = Object.fromEntries(Object.entries(state.answers).map(([position, value]) => [
        position, { id: `server:${attempt.revision}:${position}`, recordedAt: nextLocalTime(), value: copy(value) },
      ]));
    } else {
      const localAnswers = copy(state.answers);
      const localVersions = copy(state.answerVersions);
      const dirtyPositions = new Set(state.queue.filter((event) => event.type === 'draft')
        .flatMap((event) => Array.isArray(event.dirtyPositions) ? event.dirtyPositions
          : Object.keys(event.answers || {}).filter((position) => !String(localVersions[position]?.id || '').startsWith('server:')))
        .map(String));
      state.answers = writtenAnswers(attempt.draft);
      state.answerVersions = Object.fromEntries(Object.entries(state.answers).map(([position, value]) => [
        position, { id: `server:${attempt.revision}:${position}`, recordedAt: nextLocalTime(), value: copy(value) },
      ]));
      dirtyPositions.forEach((position) => {
        if (Object.hasOwn(localAnswers, position)) state.answers[position] = copy(localAnswers[position]);
        else delete state.answers[position];
        if (localVersions[position]) state.answerVersions[position] = copy(localVersions[position]);
        else delete state.answerVersions[position];
      });
      if (attempt.revision > state.revision) state.revision = attempt.revision;
    }
    if (state.result?.kind === 'objective_written_checkpoint' && resumePhase !== 'writing') {
      state.phase = 'objective_completed';
      state.answers = writtenAnswers(attempt.draft);
      state.result = objectiveResult('objective_written_checkpoint', attempt.state, state.answers);
    } else if (state.queue.some((event) => event.completesObjective === true)) {
      state.phase = 'objective_queued';
    } else {
      state.assetResumePhase = resumeAssetBlocked && resumePhase === 'writing' ? 'writing' : null;
      state.phase = resumeAssetBlocked ? 'asset_blocked' : resumePhase;
    }
  }

  async function reconcileClosedQueue() {
    const result = typeof transport.attempt === 'function'
      ? await transport.attempt(state.attemptId) : await transport.current?.();
    if (!result) return false;
    applyServerCurrent(result?.attempt, result?.serverTimeMs);
    await persistLocked();
    notify();
    return state.phase === 'written_submitted';
  }

  async function rebaseAfterRevisionConflict(event) {
    const result = typeof transport.attempt === 'function'
      ? await transport.attempt(state.attemptId) : await transport.current?.();
    if (!result) return false;
    applyServerCurrent(result?.attempt, result?.serverTimeMs);
    if (state.phase === 'written_submitted') {
      await persistLocked();
      notify();
      return true;
    }
    const completesObjective = event.completesObjective === true
      || state.queue.some((candidate) => candidate.type === 'draft' && candidate.completesObjective === true);
    const dirtyPositions = [...new Set([
      ...(Array.isArray(event.dirtyPositions) ? event.dirtyPositions : []),
      ...state.queue.filter((candidate) => candidate.type === 'draft')
        .flatMap((candidate) => Array.isArray(candidate.dirtyPositions) ? candidate.dirtyPositions : []),
    ])];
    const dirtyVersions = Object.fromEntries(dirtyPositions.flatMap((position) => {
      const version = state.answerVersions[String(position)]?.id;
      return typeof version === 'string' ? [[String(position), version]] : [];
    }));
    retireThrough(event);
    const replacementId = uuid();
    state.queue.unshift(event.type === 'draft' ? {
      type: 'draft', idempotencyKey: replacementId, expectedRevision: state.revision,
      answers: copy(state.answers), createdAt: nextLocalTime(), attempted: false,
      completesObjective, dirtyPositions, dirtyVersions,
    } : {
      type: 'submit', idempotencyKey: replacementId, expectedRevision: state.revision,
      createdAt: nextLocalTime(), attempted: false,
      manual: event.manual === true,
      resumeAssetBlocked: event.resumeAssetBlocked === true,
    });
    await persistLocked();
    notify();
    return true;
  }

  async function restore(candidate) {
    form = assertForm(candidate);
    assertInvalidationCurrent();
    const encoded = storage.getItem(storageKey());
    let pendingStart = false;
    if (encoded) {
      let saved;
      try { saved = JSON.parse(encoded); } catch (_) { throw new Error('EGE_MOCK_WRITTEN_LOCAL_STATE_INVALID'); }
      pendingStart = ['ready', 'error'].includes(saved?.phase) && typeof saved.pendingStartId === 'string'
        && saved.attemptId == null && saved.revision == null;
      const activeAttempt = typeof saved?.attemptId === 'string' && Number.isInteger(saved.revision);
      if (saved?.version !== STORAGE_VERSION || saved.owner?.username !== owner.username
        || saved.owner?.generation !== owner.generation || saved.formIdentity !== form.identity
        || saved.catalogFingerprint !== form.fingerprint || (!pendingStart && !activeAttempt)
        || (Number.isSafeInteger(saved.invalidationWatermark) ? saved.invalidationWatermark : 0) !== invalidationWatermark
        || !Array.isArray(saved.queue) || (activeAttempt && (typeof saved.attemptOwnerGeneration !== 'string'
          || !saved.attemptOwnerGeneration || !validServerTiming(saved)))) {
        throw new Error('EGE_MOCK_WRITTEN_LOCAL_STATE_INVALID');
      }
      timerRuntime = null;
      state = normalizeDurableShape(saved);
      if (assessmentRevisionExhausted()) await persistLocked();
    } else {
      if (!online() || typeof transport.current !== 'function') return notify();
      const result = await transport.current();
      if (!result?.attempt) return notify();
      adoptServerAttempt(result.attempt, result.serverTimeMs);
      await persistLocked();
    }
    if (ensureAutomaticAssessmentRun()) await persistLocked();
    if (pendingStart && state.phase === 'error') return notify();
    if (state.phase === 'written_submitted' && !online()) return notify();
    async function ensureAssetsReady() {
      if (typeof assets.isReady !== 'function' || await assets.isReady(form, state.preflight)) {
        if (state.attemptId && state.phase === 'asset_blocked') {
          markAssetsReady();
          await persistLocked();
        }
        return true;
      }
      if (!online()) {
        if (state.attemptId) {
          markAssetBlocked();
          state.saveStatus = state.queue.length ? 'queued' : state.saveStatus;
          await persistLocked();
          notify();
          return false;
        }
        throw new Error('EGE_MOCK_ASSET_PREFLIGHT_REQUIRED');
      }
      try {
        const evidence = await assets.preflight(form);
        if (evidence?.identity !== form.identity || evidence?.fingerprint !== form.fingerprint) {
          throw new Error('EGE_MOCK_ASSET_PREFLIGHT_MISMATCH');
        }
        state.preflight = copy(evidence);
        if (state.attemptId) markAssetsReady();
        await persistLocked();
        return true;
      } catch (error) {
        if (state.attemptId) {
          markAssetBlocked();
          await persistLocked();
          notify();
        } else {
          state.phase = 'error';
          state.preflight = null;
          await persistLocked();
          notify();
        }
        throw error;
      }
    }
    if (pendingStart) {
      if (!await ensureAssetsReady()) return snapshot();
      if (!online()) return notify();
      return start();
    }
    if (online() && (typeof transport.attempt === 'function' || typeof transport.current === 'function')) {
      try {
        const result = typeof transport.attempt === 'function'
          ? await transport.attempt(state.attemptId) : await transport.current();
        applyServerCurrent(result?.attempt, result?.serverTimeMs);
        await persistLocked();
        if (state.phase === 'written_submitted' && !state.assessmentCommand) return notify();
      } catch (error) {
        if (!retryableTransportError(error)) throw error;
      }
    }
    if (['running', 'writing', 'asset_blocked'].includes(state.phase) && !await ensureAssetsReady()) return snapshot();
    notify();
    if (['running', 'writing', 'objective_queued', 'objective_completed'].includes(state.phase)
      && remainingSeconds() === 0) return queueSubmit();
    if (state.queue.length || state.assessmentCommand) return sync();
    return snapshot();
  }

  async function flushAssessmentCommand() {
    mergeStoredState();
    if (assessmentRevisionExhausted()) {
      retireExhaustedAssessmentCommand(state);
      await persistLocked();
      notify();
      return false;
    }
    const pending = copy(state.assessmentCommand);
    if (!pending) return false;
    const descriptor = assessmentCommandDescriptor(pending);
    const operation = transport[descriptor.transportMethod];
    if (!online() || typeof operation !== 'function') {
      state.saveStatus = 'queued';
      await persistLocked();
      notify();
      return true;
    }
    try {
      const result = await operation({
        attemptId: state.attemptId,
        idempotencyKey: pending.idempotencyKey,
        ...descriptor.requestFields(pending),
      });
      const {
        acknowledged, terminal,
      } = assertAssessmentResponse(result, descriptor);
      applyServerCurrent(result.attempt, result.serverTimeMs);
      if (descriptor.retainsAfterResponse(acknowledged, terminal)) {
        state.saveStatus = 'queued';
        await persistLocked();
        notify();
        return true;
      }
      state.assessmentCommandThrough = newerWatermark(state.assessmentCommandThrough, pending);
      state.assessmentCommand = null;
      if (descriptor.queueAutomaticRunAfterAck) ensureAutomaticAssessmentRun();
      state.saveStatus = 'saved';
      await persistLocked();
      notify();
      return true;
    } catch (error) {
      if (error?.code === 'ASSESSMENT_REVISION_EXHAUSTED') {
        const revision = state.result?.writingAssessment?.assessmentRevision;
        if (!Number.isSafeInteger(revision) || revision < 0) throw assessmentResponseError();
        state.assessmentCommandThrough = newerWatermark(state.assessmentCommandThrough, pending);
        state.assessmentCommand = null;
        state.assessmentCommandBlockedRevision = ASSESSMENT_EXHAUSTION_SENTINEL;
        state.saveStatus = 'saved';
        await persistLocked();
        notify();
        return true;
      }
      if (error?.code !== 'EGE_MOCK_ASSESSMENT_RESPONSE_INVALID'
        && !retryableTransportError(error)
        && (typeof transport.attempt === 'function' || typeof transport.current === 'function')) {
        try {
          const result = typeof transport.attempt === 'function'
            ? await transport.attempt(state.attemptId) : await transport.current();
          applyServerCurrent(result?.attempt, result?.serverTimeMs);
          if (!state.assessmentCommand) {
            state.saveStatus = 'saved';
            await persistLocked();
            notify();
            return true;
          }
        } catch (_) {}
      }
      state.saveStatus = 'queued';
      await persistLocked();
      notify();
      if (retryableTransportError(error)) return true;
      throw error;
    }
  }

  async function flushQueue() {
    if (await flushAssessmentCommand()) return snapshot();
    if (!online() || !state.attemptId) {
      if (state.queue.length) state.saveStatus = 'queued';
      await persistLocked();
      return notify();
    }
    while (state.queue.length) {
      mergeStoredState();
      if (state.phase === 'written_submitted' || !state.queue.length) return snapshot();
      const pending = state.queue[0];
      if (pending.type === 'submit') {
        try {
          const result = pending.manual === true
            ? await transport.submitWritten({
              attemptId: state.attemptId,
              expectedRevision: pending.expectedRevision,
              idempotencyKey: pending.idempotencyKey,
            })
            : typeof transport.attempt === 'function'
              ? await transport.attempt(state.attemptId) : await transport.current?.();
          if (!result) throw new Error('EGE_MOCK_CURRENT_REQUIRED');
          applyServerCurrent(result?.attempt, result?.serverTimeMs);
          if (pending.manual === true && state.phase === 'written_submitted') {
            state.result.kind = 'written_submission';
          }
          await persistLocked();
          notify();
          if (state.phase === 'written_submitted') {
            await flushAssessmentCommand();
            return snapshot();
          }
          return snapshot();
        } catch (error) {
          state.saveStatus = 'queued';
          await persistLocked();
          notify();
          if (retryableTransportError(error)) return snapshot();
          if (error?.code === 'EGE_MOCK_WRITTEN_CLOSED' && await reconcileClosedQueue()) return snapshot();
          if (error?.code === 'EGE_MOCK_REVISION_CONFLICT' && await rebaseAfterRevisionConflict(pending)) continue;
          throw error;
        }
      }
      if (pending.attempted !== true) {
        if (pending.type === 'draft') pending.answers = copy(state.answers);
        rebaseUnattemptedQueue();
        pending.attempted = true;
        await persistLocked();
      }
      const event = copy(state.queue.find((candidate) => candidate.idempotencyKey === pending.idempotencyKey));
      try {
        let result;
        if (event.type === 'draft') {
          result = await transport.saveDraft({
            attemptId: state.attemptId,
            expectedRevision: event.expectedRevision,
            answers: event.answers,
            idempotencyKey: event.idempotencyKey,
          });
        } else throw new Error('EGE_MOCK_WRITTEN_QUEUE_EVENT_INVALID');
        const attempt = assertCurrentAttempt(result?.attempt);
        seedTimerAuthority({ ...attempt, timerAuthority: copy(state.timerAuthority) }, state, result?.serverTimeMs);
        const appliedDraft = writtenAnswers(attempt.draft);
        const expectedDraft = writtenAnswers(event.answers);
        if (attempt.state !== 'written_in_progress' || attempt.revision !== event.expectedRevision + 1
          || JSON.stringify(appliedDraft) !== JSON.stringify(expectedDraft)) {
          throw new Error('EGE_MOCK_DRAFT_RESPONSE_INVALID');
        }
        acknowledgeDraftVersions(event, appliedDraft, attempt.revision);
        retireThrough(event);
        state.revision = attempt.revision;
        if (event.completesObjective === true) {
          state.answers = writtenAnswers(attempt.draft);
          state.answerVersions = Object.fromEntries(Object.entries(state.answers).map(([position, value]) => [
            position, {
              id: `server:${attempt.revision}:${position}`, recordedAt: nextLocalTime(), value: copy(value),
            },
          ]));
          state.result = objectiveResult('objective_written_checkpoint', attempt.state, state.answers);
          state.phase = state.queue.some((candidate) => candidate.type === 'submit')
            ? 'submit_queued' : 'objective_completed';
        }
        state.saveStatus = state.queue.length ? 'queued' : 'saved';
        await persistLocked();
        notify();
      } catch (error) {
        state.saveStatus = 'queued';
        await persistLocked();
        notify();
        if (retryableTransportError(error)) return snapshot();
        if (error?.code === 'EGE_MOCK_WRITTEN_CLOSED' && await reconcileClosedQueue()) return snapshot();
        if (error?.code === 'EGE_MOCK_REVISION_CONFLICT' && await rebaseAfterRevisionConflict(event)) continue;
        throw error;
      }
    }
    return snapshot();
  }

  function sync() {
    if (!flushing) flushing = flushQueue().finally(() => { flushing = null; });
    return flushing;
  }

  async function retryAssessment(acknowledgePossibleProviderRepeat = false) {
    const queued = await withDurableLock(async () => {
      mergeStoredState();
      const status = state.result?.writingAssessment?.status;
      if (state.phase !== 'written_submitted'
        || !['retryable', 'ambiguous'].includes(status)
        || state.result?.writingAssessment?.retryAllowed !== true) {
        throw new Error('EGE_MOCK_WRITING_ASSESSMENT_RETRY_NOT_ALLOWED');
      }
      if (assessmentRevisionExhausted()) {
        throw Object.assign(new Error('ASSESSMENT_REVISION_EXHAUSTED'), {
          code: 'ASSESSMENT_REVISION_EXHAUSTED',
        });
      }
      if (status === 'ambiguous' && acknowledgePossibleProviderRepeat !== true) {
        throw new Error('EGE_MOCK_WRITING_AMBIGUOUS_RETRY_ACK_REQUIRED');
      }
      if (!state.assessmentCommand) {
        state.assessmentCommand = {
          action: 'retry', idempotencyKey: uuid(), createdAt: nextLocalTime(),
          acknowledgePossibleProviderRepeat: status === 'ambiguous',
        };
      }
      state.saveStatus = 'queued';
      await withAuthorityCommit(() => persist());
      notify();
      return true;
    });
    if (!queued) return snapshot();
    return sync();
  }

  async function runAssessmentAfterRenewal() {
    const queued = await withDurableLock(async () => {
      mergeStoredState();
      const assessment = state.result?.writingAssessment;
      if (state.phase !== 'written_submitted' || assessment?.status !== 'pending'
        || assessment?.runDisposition !== 'subscription_required') {
        throw new Error('EGE_MOCK_WRITING_ASSESSMENT_RENEWAL_NOT_ALLOWED');
      }
      if (assessmentRevisionExhausted()) {
        throw Object.assign(new Error('ASSESSMENT_REVISION_EXHAUSTED'), {
          code: 'ASSESSMENT_REVISION_EXHAUSTED',
        });
      }
      if (state.assessmentCommand?.explicitRenewal !== true) {
        if (state.assessmentCommand) {
          state.assessmentCommandThrough = newerWatermark(
            state.assessmentCommandThrough, state.assessmentCommand,
          );
        }
        state.assessmentCommand = {
          action: 'run', idempotencyKey: uuid(), createdAt: nextLocalTime(),
          acknowledgePossibleProviderRepeat: false,
          explicitRenewal: true,
        };
      }
      state.saveStatus = 'queued';
      await withAuthorityCommit(() => persist());
      notify();
      return true;
    });
    if (!queued) return snapshot();
    return sync();
  }

  async function queueSubmit() {
    const queued = await withDurableLock(async () => {
      mergeStoredState();
      if (!['running', 'writing', 'asset_blocked', 'objective_queued', 'objective_completed', 'submit_queued'].includes(state.phase)) {
        return false;
      }
      const previous = copy(state);
      if (!state.queue.some((event) => event.type === 'submit')) {
        const pendingDrafts = state.queue.filter((event) => event.type === 'draft').length;
        state.queue.push({
          type: 'submit', idempotencyKey: uuid(), expectedRevision: state.revision + pendingDrafts,
          createdAt: nextLocalTime(), attempted: false,
          resumeAssetBlocked: state.phase === 'asset_blocked',
        });
      }
      state.phase = 'submit_queued';
      state.saveStatus = 'queued';
      try { await withAuthorityCommit(() => persist()); } catch (error) { state = previous; throw error; }
      if (!state.queue.some((event) => event.type === 'submit')) {
        state.phase = previous.phase;
        state.saveStatus = state.queue.length ? 'queued' : 'saved';
        await withAuthorityCommit(() => persist());
        notify();
        return false;
      }
      notify();
      return true;
    });
    if (!queued) return snapshot();
    return sync();
  }

  async function continueWriting() {
    return withDurableLock(async () => {
      mergeStoredState();
      if (state.phase === 'writing') return notify();
      if (state.phase !== 'objective_completed') throw new Error('EGE_MOCK_OBJECTIVE_CHECKPOINT_REQUIRED');
      const previous = copy(state);
      state.phase = 'writing';
      state.currentPosition = 37;
      try { await withAuthorityCommit(() => persist()); } catch (error) { state = previous; throw error; }
      return notify();
    });
  }

  async function completeWritten() {
    const queued = await withDurableLock(async () => {
      mergeStoredState();
      if (state.phase !== 'writing') throw new Error('EGE_MOCK_WRITING_NOT_READY');
      const previous = copy(state);
      const dirtyPositions = [...new Set(state.queue.filter((candidate) => candidate.type === 'draft')
        .flatMap((candidate) => Array.isArray(candidate.dirtyPositions) ? candidate.dirtyPositions : []))];
      const dirtyVersions = Object.fromEntries(dirtyPositions.flatMap((position) => {
        const version = state.answerVersions[String(position)]?.id;
        return typeof version === 'string' ? [[String(position), version]] : [];
      }));
      state.queue = state.queue.filter((event) => !(event.type === 'draft' && event.attempted !== true));
      state.queue = compactQueue([...state.queue, {
        type: 'draft', idempotencyKey: uuid(), expectedRevision: state.revision,
        answers: copy(state.answers), createdAt: nextLocalTime(), attempted: false,
        dirtyPositions, dirtyVersions,
      }, {
        type: 'submit', manual: true, idempotencyKey: uuid(), expectedRevision: state.revision + 1,
        createdAt: nextLocalTime(), attempted: false,
      }], state.compactedThrough);
      state.phase = 'submit_queued';
      state.saveStatus = 'queued';
      try { await withAuthorityCommit(() => persist()); } catch (error) { state = previous; throw error; }
      notify();
      return true;
    });
    if (!queued) return snapshot();
    return sync();
  }

  async function completeObjective() {
    const queued = await withDurableLock(async () => {
      mergeStoredState();
      if (state.phase === 'objective_completed') return false;
      if (!['running', 'objective_queued'].includes(state.phase)) {
        throw new Error('EGE_MOCK_WRITTEN_NOT_RUNNING');
      }
      const previous = copy(state);
      const dirtyPositions = [...new Set(state.queue.filter((candidate) => candidate.type === 'draft')
        .flatMap((candidate) => Array.isArray(candidate.dirtyPositions) ? candidate.dirtyPositions : []))];
      const dirtyVersions = Object.fromEntries(dirtyPositions.flatMap((position) => {
        const version = state.answerVersions[String(position)]?.id;
        return typeof version === 'string' ? [[String(position), version]] : [];
      }));
      state.queue = state.queue.filter((event) => !(event.type === 'draft' && event.attempted !== true));
      state.queue = compactQueue([...state.queue, {
        type: 'draft', idempotencyKey: uuid(), expectedRevision: state.revision,
        answers: copy(state.answers), createdAt: nextLocalTime(), attempted: false,
        completesObjective: true, dirtyPositions, dirtyVersions,
      }], state.compactedThrough);
      state.phase = 'objective_queued';
      state.saveStatus = 'queued';
      try { await withAuthorityCommit(() => persist()); } catch (error) { state = previous; throw error; }
      notify();
      return true;
    });
    if (!queued) return snapshot();
    return sync();
  }

  async function tick() {
    let expired = false;
    await withDurableLock(async () => {
      mergeStoredState();
      expired = ['running', 'writing', 'asset_blocked', 'objective_queued', 'objective_completed'].includes(state.phase)
        && remainingSeconds() === 0;
      await withAuthorityCommit(() => persist());
    });
    if (expired) return queueSubmit();
    return notify();
  }

  async function audioStart(group) {
    return withDurableLock(async () => {
      mergeStoredState();
      if (state.phase !== 'running') throw new Error('EGE_MOCK_WRITTEN_NOT_RUNNING');
      if (!AUDIO_GROUPS.includes(group)) throw new TypeError('EGE_MOCK_AUDIO_GROUP_INVALID');
      if (state.audioLease) throw new Error('EGE_MOCK_AUDIO_PLAYBACK_ACTIVE');
      const next = state.audioPlays[group] + 1;
      if (next > 2) throw new Error('EGE_MOCK_AUDIO_PLAYBACK_LIMIT');
      const previous = copy(state);
      state.audioPlays[group] = next;
      state.audioLease = {
        group, token: uuid(), createdAt: nextLocalTime(), expiresAt: Number(localNow()) + AUDIO_LEASE_MS,
      };
      try { await withAuthorityCommit(() => persist()); } catch (error) { state = previous; throw error; }
      return notify();
    });
  }

  async function audioFinish(token) {
    return withDurableLock(async () => {
      mergeStoredState();
      if (!state.audioLease || state.audioLease.token !== token) throw new Error('EGE_MOCK_AUDIO_PLAYBACK_LEASE_INVALID');
      const previous = copy(state);
      state.audioLeaseThrough = newerWatermark(state.audioLeaseThrough, {
        createdAt: state.audioLease.createdAt, idempotencyKey: state.audioLease.token,
      });
      state.audioLease = null;
      try { await withAuthorityCommit(() => persist()); } catch (error) { state = previous; throw error; }
      return notify();
    });
  }

  async function dispatch(command = {}) {
    if (command.type === 'prepare') return prepare(command.form);
    if (command.type === 'start') return start();
    if (command.type === 'restore') return restore(command.form);
    if (command.type === 'answer') return answer(Number(command.position), command.answer);
    if (command.type === 'navigate') return navigate(Number(command.position));
    if (command.type === 'sync') return sync();
    if (command.type === 'submit') return queueSubmit();
    if (command.type === 'completeObjective') return completeObjective();
    if (command.type === 'continueWriting') return continueWriting();
    if (command.type === 'completeWritten') return completeWritten();
    if (command.type === 'retryAssessment') {
      return retryAssessment(command.acknowledgePossibleProviderRepeat === true);
    }
    if (command.type === 'runAssessmentAfterRenewal') return runAssessmentAfterRenewal();
    if (command.type === 'tick') return tick();
    if (command.type === 'audioStart') return audioStart(String(command.group || ''));
    if (command.type === 'audioFinish') return audioFinish(String(command.token || ''));
    if (command.type === 'invalidate') return invalidate();
    if (command.type === 'refreshLocal') { mergeStoredState(); return notify(); }
    throw new TypeError(`EGE_MOCK_WRITTEN_COMMAND_INVALID: ${String(command.type || '')}`);
  }

  function subscribe(listener) {
    if (typeof listener !== 'function') throw new TypeError('EGE_MOCK_WRITTEN_LISTENER_INVALID');
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  return Object.freeze({ dispatch, snapshot, subscribe });
}

export {
  OBJECTIVE_POSITIONS, WRITTEN_POSITIONS, createEgeMockWrittenRunner,
  egeMockLocalContinuation, normalizeEgeMockSelection,
};
