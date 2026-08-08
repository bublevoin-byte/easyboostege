import { grammarActivityId, splitLearningActivityDuration } from '../learning-activity-contract.js';

export const EasyBoostGrammar = (function initializeGrammarModule(global) {
  'use strict';

  const REVIEW_INTERVAL_DAYS = Object.freeze([7, 16, 35]);
  const MASTERY_INTERVAL_DAYS = Object.freeze([1, 3, 7, 16, 35]);
  const MASTERY_STAGES = Object.freeze(['not_started', 'learning', 'learned', 'confirmed', 'stable']);
  const REQUIRED_PRACTICE_TYPES = Object.freeze(['choice', 'input', 'correction', 'transform']);
  const MASTERY_VERSION = 2;
  const DAY_MS = 86_400_000;
  const MAX_RECENT_EVENT_IDS = 64;
  const MAX_MASTERY_HISTORY = 64;
  const MIN_CORRECT_PER_TYPE = 4;
  const MIN_ACCURACY_PER_TYPE = 0.75;
  const REGRESSION_REASON_CODES = Object.freeze([
    'construction_choice', 'word_or_verb_form', 'auxiliary', 'agreement',
    'word_order', 'negation_or_question', 'confusion_pair',
  ]);
  const REGRESSION_REASON_LABELS = Object.freeze({
    construction_choice: 'выбор конструкции',
    word_or_verb_form: 'форма слова или глагола',
    auxiliary: 'вспомогательный глагол',
    agreement: 'согласование',
    word_order: 'порядок слов',
    negation_or_question: 'отрицание или вопрос',
    confusion_pair: 'смешение похожих конструкций',
  });
  function normalizeRegressionReason(value) {
    if (REGRESSION_REASON_CODES.includes(value)) return value;
    return null;
  }

  function finiteTimestamp(value) {
    if (value == null || value === '') return null;
    const timestamp = Number(value);
    return Number.isFinite(timestamp) && timestamp >= 0 ? timestamp : null;
  }

  function boundedInteger(value, fallback = 0, maximum = Number.MAX_SAFE_INTEGER) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(maximum, Math.max(0, Math.floor(number)));
  }

  function migrateMasteryRecord(record, options = {}) {
    const source = record && typeof record === 'object' ? record : {};
    const now = finiteTimestamp(options.now) ?? Date.now();
    const isCurrent = source.masteryVersion === MASTERY_VERSION && MASTERY_STAGES.includes(source.stage);
    const legacySource = source.legacy && typeof source.legacy === 'object' ? source.legacy : source;
    const parsedLegacyDue = finiteTimestamp(legacySource.due);
    const legacyDue = parsedLegacyDue != null && parsedLegacyDue > 0 ? parsedLegacyDue : null;
    const legacy = {
      st: boundedInteger(legacySource.st),
      ok: boundedInteger(legacySource.ok),
      err: boundedInteger(legacySource.err),
      sr: boundedInteger(legacySource.sr),
      rs: boundedInteger(legacySource.rs),
      due: legacyDue ?? 0,
    };
    const statsSource = source.stats && typeof source.stats === 'object' ? source.stats : {};
    const stats = {
      correct: boundedInteger(statsSource.correct, legacy.ok),
      errors: boundedInteger(statsSource.errors, legacy.err),
      advancedStreak: boundedInteger(statsSource.advancedStreak, legacy.sr),
      assistedAttempts: boundedInteger(statsSource.assistedAttempts, source.assistedAttempts),
    };
    const legacyStage = legacy.st >= 2
      ? 'learned'
      : (legacy.st >= 1 || legacy.ok > 0 || legacy.err > 0 || legacy.sr > 0 ? 'learning' : 'not_started');
    const stage = isCurrent ? source.stage : legacyStage;
    const defaultEligibleAt = stage === 'learned' ? (legacyDue ?? now) : null;
    const recentEventIds = Array.isArray(source.recentEventIds)
      ? [...new Set(source.recentEventIds.filter((id) => typeof id === 'string' && id).slice(-MAX_RECENT_EVENT_IDS))]
      : [];
    const masteryHistory = Array.isArray(source.masteryHistory)
      ? source.masteryHistory.filter((entry) => entry && typeof entry === 'object').slice(-MAX_MASTERY_HISTORY).map((entry) => ({
        eventId: typeof entry.eventId === 'string' ? entry.eventId : null,
        type: entry.type === 'session_completed' ? 'session_completed' : 'review_completed',
        at: finiteTimestamp(entry.at),
        outcome: typeof entry.outcome === 'string' ? entry.outcome : 'recorded',
        fromStage: MASTERY_STAGES.includes(entry.fromStage) ? entry.fromStage : 'not_started',
        toStage: MASTERY_STAGES.includes(entry.toStage) ? entry.toStage : stage,
        reviewStep: boundedInteger(entry.reviewStep, 0, MASTERY_INTERVAL_DAYS.length),
      }))
      : [];
    let reviewStep = isCurrent ? boundedInteger(source.reviewStep, 0, MASTERY_INTERVAL_DAYS.length) : 0;
    if (stage === 'stable') reviewStep = MASTERY_INTERVAL_DAYS.length;
    const highestReviewStep = isCurrent
      ? Math.max(reviewStep, boundedInteger(source.highestReviewStep, reviewStep, MASTERY_INTERVAL_DAYS.length))
      : 0;
    const eligibleAt = ['not_started', 'learning', 'stable'].includes(stage)
      ? null
      : (isCurrent ? finiteTimestamp(source.eligibleAt) : defaultEligibleAt);
    return {
      masteryVersion: MASTERY_VERSION,
      masteryRevision: isCurrent ? boundedInteger(source.masteryRevision) : 0,
      stage,
      reviewStep,
      highestReviewStep,
      eligibleAt,
      stats,
      legacy,
      recentEventIds,
      masteryHistory,
      lastStageAt: finiteTimestamp(source.lastStageAt),
      lastAttemptAt: finiteTimestamp(source.lastAttemptAt),
      lastRegressionReason: normalizeRegressionReason(source.lastRegressionReason),
    };
  }

  function migrateLegacyMasteryRecord(record, options = {}) {
    const source = record && typeof record === 'object' ? record : {};
    return migrateMasteryRecord({
      st: source.st,
      ok: source.ok,
      err: source.err,
      sr: source.sr,
      rs: source.rs,
      due: source.due,
    }, options);
  }

  function hasCanonicalMasteryRecords(records) {
    if (!records || typeof records !== 'object' || Array.isArray(records)) return false;
    return Object.entries(records).some(([topicId, record]) => {
      const topic = Number(topicId);
      return Number.isInteger(topic) && topic >= 1 && topic <= 20
        && record != null && typeof record === 'object' && !Array.isArray(record);
    });
  }

  function eventWasApplied(record, event) {
    return typeof event?.id === 'string' && event.id && record.recentEventIds.includes(event.id);
  }

  function migrateMasteryRecords(records, options = {}) {
    const source = records && typeof records === 'object' ? records : {};
    const migrated = {};
    for (const [topicId, record] of Object.entries(source)) {
      migrated[topicId] = migrateMasteryRecord(record, options);
    }
    return migrated;
  }

  function migrateLegacyMasteryRecords(records, options = {}) {
    const source = records && typeof records === 'object' ? records : {};
    const migrated = {};
    for (const [topicId, record] of Object.entries(source)) {
      const topic = Number(topicId);
      if (!Number.isInteger(topic) || topic < 1 || topic > 20) continue;
      migrated[topicId] = migrateLegacyMasteryRecord(record, options);
    }
    return migrated;
  }

  function rememberEvent(record, event) {
    if (typeof event?.id !== 'string' || !event.id) return record;
    record.recentEventIds = record.recentEventIds.concat(event.id).slice(-MAX_RECENT_EVENT_IDS);
    return record;
  }

  function setStage(record, stage, at) {
    if (record.stage !== stage) record.lastStageAt = at;
    record.stage = stage;
  }

  function markLateRegression(record, event, at) {
    const reason = normalizeRegressionReason(event.reason);
    if (!reason) return false;
    const isLate = record.stage === 'stable'
      || (record.eligibleAt != null && at >= record.eligibleAt);
    if (!isLate || !['learned', 'confirmed', 'stable'].includes(record.stage)) return false;
    if (record.stage === 'stable') {
      setStage(record, 'confirmed', at);
      record.reviewStep = MASTERY_INTERVAL_DAYS.length - 1;
    } else if (record.stage === 'confirmed') {
      setStage(record, 'learned', at);
    }
    record.eligibleAt = at;
    record.lastRegressionReason = reason;
    return true;
  }

  function completedRequiredPractice(event) {
    if (event.assisted || event.source !== 'builtin') return false;
    const completedTypes = new Set(Array.isArray(event.completedTypes) ? event.completedTypes : []);
    if (!REQUIRED_PRACTICE_TYPES.every((type) => completedTypes.has(type))) return false;
    if (!event.typeScores || typeof event.typeScores !== 'object') return false;
    return REQUIRED_PRACTICE_TYPES.every((type) => {
      const score = event.typeScores[type];
      const correct = Number(score?.correct);
      const total = Number(score?.total);
      return Number.isInteger(correct) && Number.isInteger(total)
        && correct >= MIN_CORRECT_PER_TYPE && total >= MIN_CORRECT_PER_TYPE
        && correct / total >= MIN_ACCURACY_PER_TYPE;
    });
  }

  function matchesExpectedMastery(record, event) {
    return Number(event.expectedRevision) === record.masteryRevision
      && event.expectedStage === record.stage
      && Number(event.expectedReviewStep) === record.reviewStep;
  }

  function appendMasteryHistory(record, event, at, fromStage, outcome) {
    record.masteryHistory = record.masteryHistory.concat({
      eventId: typeof event.id === 'string' ? event.id : null,
      type: event.type,
      at,
      outcome,
      fromStage,
      toStage: record.stage,
      reviewStep: record.reviewStep,
    }).slice(-MAX_MASTERY_HISTORY);
  }

  function reduceMastery(record, event, options = {}) {
    const next = migrateMasteryRecord(record, options);
    if (!event || typeof event !== 'object' || eventWasApplied(next, event)) return next;
    const at = finiteTimestamp(options.now) ?? Date.now();
    const serverCanonical = options.clockAuthority === 'server';
    const stageEligible = !event.assisted && event.source !== 'generated';

    if (event.type === 'practice_answer') {
      next.lastAttemptAt = at;
      if (event.assisted) next.stats.assistedAttempts += 1;
      if (stageEligible && next.stage === 'not_started') setStage(next, 'learning', at);
      if (event.correct) {
        next.stats.correct += 1;
        if (event.advanced) next.stats.advancedStreak += 1;
      } else {
        next.stats.errors += 1;
        if (event.advanced) next.stats.advancedStreak = 0;
      }
    } else if (event.type === 'session_completed') {
      if (!serverCanonical || !matchesExpectedMastery(next, event)) return next;
      const fromStage = next.stage;
      next.lastAttemptAt = at;
      if (event.assisted) next.stats.assistedAttempts += 1;
      const completedTypes = new Set(Array.isArray(event.completedTypes) ? event.completedTypes : []);
      for (const type of REQUIRED_PRACTICE_TYPES) {
        if (!completedTypes.has(type)) continue;
        const score = event.typeScores?.[type];
        const correct = boundedInteger(score?.correct);
        const total = boundedInteger(score?.total);
        if (total < 1 || correct > total) continue;
        next.stats.correct += correct;
        next.stats.errors += total - correct;
      }
      const hasIndependentError = stageEligible && [...completedTypes].some((type) => {
        const score = event.typeScores?.[type];
        return Number.isInteger(Number(score?.correct)) && Number.isInteger(Number(score?.total))
          && Number(score.total) > Number(score.correct);
      });
      const sessionRegressed = hasIndependentError && markLateRegression(next, event, at);
      if (stageEligible && next.stage === 'not_started') setStage(next, 'learning', at);
      if (stageEligible && next.stage === 'learning' && completedRequiredPractice(event)) {
        setStage(next, 'learned', at);
        next.reviewStep = 0;
        next.eligibleAt = at + MASTERY_INTERVAL_DAYS[0] * DAY_MS;
        next.lastRegressionReason = null;
      }
      const stageAdvanced = MASTERY_STAGES.indexOf(next.stage) > MASTERY_STAGES.indexOf(fromStage);
      const outcome = sessionRegressed ? 'regressed' : stageAdvanced ? 'advanced' : 'recorded';
      appendMasteryHistory(next, event, at, fromStage, outcome);
      next.masteryRevision += 1;
    } else if (event.type === 'review_completed') {
      if (!serverCanonical || !matchesExpectedMastery(next, event)) return next;
      const fromStage = next.stage;
      next.lastAttemptAt = at;
      if (event.assisted) next.stats.assistedAttempts += 1;
      let reviewRegressed = false;
      if (!event.passed && stageEligible) {
        reviewRegressed = markLateRegression(next, event, at);
      } else if (stageEligible
        && ['learned', 'confirmed'].includes(next.stage)
        && next.eligibleAt != null && at >= next.eligibleAt) {
        next.reviewStep = Math.min(MASTERY_INTERVAL_DAYS.length, next.reviewStep + 1);
        next.highestReviewStep = Math.max(next.highestReviewStep, next.reviewStep);
        setStage(next, next.reviewStep >= MASTERY_INTERVAL_DAYS.length ? 'stable' : 'confirmed', at);
        next.eligibleAt = next.reviewStep >= MASTERY_INTERVAL_DAYS.length
          ? null
          : at + MASTERY_INTERVAL_DAYS[next.reviewStep] * DAY_MS;
        next.lastRegressionReason = null;
      }
      appendMasteryHistory(next, event, at, fromStage, reviewRegressed ? 'regressed'
        : event.assisted ? 'assisted' : !event.passed ? 'failed' : 'passed');
      next.masteryRevision += 1;
    }

    return rememberEvent(next, event);
  }

  function masteryView(record, options = {}) {
    const now = finiteTimestamp(options.now) ?? Date.now();
    const current = migrateMasteryRecord(record, { now });
    const due = current.eligibleAt != null && current.eligibleAt <= now && current.stage !== 'stable';
    const labels = {
      not_started: 'Не начата',
      learning: 'Изучается',
      learned: 'Изучено',
      confirmed: 'Подтверждено',
      stable: 'Устойчиво',
    };
    const progress = current.stage === 'not_started' ? 0
      : current.stage === 'learning' ? 20
        : current.stage === 'learned' ? 40
          : current.stage === 'confirmed' ? Math.min(90, 50 + current.reviewStep * 10)
            : 100;
    const nextLabel = due
      ? (current.stage === 'learned' ? 'Пора подтвердить' : 'Пора повторить')
      : current.stage === 'stable' ? 'Устойчиво'
        : current.eligibleAt != null ? 'Проверка запланирована'
          : current.stage === 'learning' ? 'Завершите четыре уровня' : 'Начните практику';
    return {
      stage: current.stage,
      label: labels[current.stage],
      due,
      eligibleAt: current.eligibleAt,
      progress,
      nextLabel,
      regressionReason: current.lastRegressionReason,
    };
  }

  function regressionReasonLabel(reason) {
    return REGRESSION_REASON_LABELS[reason] || 'нужно подтвердить навык';
  }

  function normalizeAnswer(value) {
    return String(value || '')
      .toLowerCase()
      .replace(/[’’']/gu, '')
      .replace(/\s+/gu, ' ')
      .trim()
      .replace(/\.+$/u, '')
      .trim();
  }

  function countClosed(records, topicCount = 20) {
    let closed = 0;
    for (let topic = 1; topic <= topicCount; topic += 1) {
      if (records?.[topic]?.st === 2) closed += 1;
    }
    return closed;
  }

  function dueTopics(records, options = {}) {
    const now = Number(options.now) || Date.now();
    const topicCount = Math.max(0, Number(options.topicCount) || 20);
    const due = [];
    for (let topic = 1; topic <= topicCount; topic += 1) {
      const record = records?.[topic];
      if (record && masteryView(record, { now }).due) due.push(topic);
    }
    return due;
  }

  function countStable(records, topicCount = 20) {
    let stable = 0;
    for (let topic = 1; topic <= topicCount; topic += 1) {
      if (records?.[topic] && migrateMasteryRecord(records[topic]).stage === 'stable') stable += 1;
    }
    return stable;
  }

  function effectiveBank(bank, generated) {
    const source = bank || {};
    const ai = generated || [];
    return {
      c: (source.c || []).map((question) => ({ ...question, evidenceSource: 'builtin' }))
        .concat(ai.filter((item) => item.k === 'c').map((item) => ({ ...item.q, voice: item.voice || item.q?.voice || null, evidenceSource: 'generated' }))),
      f: (source.f || []).map((question) => ({ ...question, evidenceSource: 'builtin' }))
        .concat(ai.filter((item) => item.k === 'f').map((item) => ({ ...item.q, voice: item.voice || item.q?.voice || null, evidenceSource: 'generated' }))),
      c2: (source.c2 || []).map((question) => ({ ...question, evidenceSource: 'builtin' })),
    };
  }

  function levelTwo(bank, topic) {
    if (bank.f.length) return bank.f.map((question) => ({ k: 'f', q: question, t: topic, voice: question.voice || null, source: question.evidenceSource || 'builtin' }));
    if (bank.c2.length) return bank.c2.map((question) => ({ k: 'c2', q: question, t: topic, voice: question.voice || null, source: question.evidenceSource || 'builtin' }));
    return bank.c.map((question) => ({ k: 'c2', q: question, t: topic, voice: question.voice || null, source: question.evidenceSource || 'builtin' }));
  }

  function shuffled(values, random = Math.random) {
    return values
      .map((value) => ({ value, order: random() }))
      .sort((left, right) => left.order - right.order)
      .map(({ value }) => value);
  }

  function buildTopicQueue(bank, topic, record, random = Math.random) {
    const levelOne = bank.c.map((question) => ({ k: 'c', q: question, t: topic, voice: question.voice || null, source: question.evidenceSource || 'builtin' }));
    const advanced = levelTwo(bank, topic);
    if (migrateMasteryRecord(record).stage !== 'not_started') {
      return shuffled(levelOne, random).slice(0, 2).concat(shuffled(advanced, random).slice(0, 6));
    }
    return shuffled(levelOne, random).slice(0, 4).concat(shuffled(advanced, random).slice(0, 3));
  }

  function applyAnswer(record, session, item, correct, now = Date.now()) {
    if (session.mode === 'rev') {
      session.done += 1;
      if (correct) {
        session.ok += 1;
      } else {
        session.errT[item.t] = 1;
        session.queue.push(item);
      }
      return record;
    }
    if (correct) {
      session.ok += 1;
    } else {
      session.queue.push(item);
    }
    session.done += 1;
    return record;
  }

  function formatDuration(seconds) {
    const safeSeconds = Math.max(0, Math.floor(Number(seconds) || 0));
    const minutes = Math.floor(safeSeconds / 60);
    const remainder = safeSeconds % 60;
    return `${minutes}:${remainder < 10 ? '0' : ''}${remainder}`;
  }

  function queueSource(queue) {
    const sources = new Set((queue || []).map((item) => item?.source).filter((source) => source));
    if (sources.size > 1) return 'mixed';
    return sources.has('generated') ? 'generated' : 'builtin';
  }

  function reviewEvidenceSlices(evidenceByActivity, durationMs) {
    const slices = Object.keys(evidenceByActivity || {}).sort().map((activityId) => ({
      ...evidenceByActivity[activityId],
      activityId,
    }));
    return splitLearningActivityDuration(slices, durationMs);
  }

  const grammarModule = Object.freeze({
    REVIEW_INTERVAL_DAYS,
    MASTERY_INTERVAL_DAYS,
    MASTERY_STAGES,
    REQUIRED_PRACTICE_TYPES,
    MIN_CORRECT_PER_TYPE,
    MIN_ACCURACY_PER_TYPE,
    normalizeAnswer,
    countClosed,
    countStable,
    dueTopics,
    migrateMasteryRecord,
    migrateMasteryRecords,
    migrateLegacyMasteryRecord,
    migrateLegacyMasteryRecords,
    hasCanonicalMasteryRecords,
    reduceMastery,
    masteryView,
    regressionReasonLabel,
    effectiveBank,
    levelTwo,
    shuffled,
    buildTopicQueue,
    applyAnswer,
    formatDuration,
    queueSource,
    activityId: grammarActivityId,
    reviewEvidenceSlices,
  });
  global.EasyBoostGrammar = grammarModule;
  return grammarModule;
})(typeof window === 'undefined' ? globalThis : window);

export const {
  masteryView,
  migrateMasteryRecord,
  migrateMasteryRecords,
  migrateLegacyMasteryRecord,
  migrateLegacyMasteryRecords,
  hasCanonicalMasteryRecords,
  reduceMastery,
} = EasyBoostGrammar;
