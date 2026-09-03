import { grammarActivityId, splitLearningActivityDuration } from '../learning-activity-contract.js';
import {
  GENERATED_GRAMMAR_REVISION,
  GRAMMAR_ACTIVE_PRACTICE_TYPES,
  GRAMMAR_ERROR_CODES,
  GRAMMAR_PRACTICE_MODES,
  GRAMMAR_TARGETED_MIN_ERROR_ITEMS,
  GRAMMAR_TARGETED_MIN_EXACT_ITEMS,
  parseGeneratedGrammarItemId,
  parseGeneratedGrammarItemReference,
} from '../grammar-domain-contract.js';

export const EasyBoostGrammar = (function initializeGrammarModule(global) {
  'use strict';

  const REVIEW_INTERVAL_DAYS = Object.freeze([7, 16, 35]);
  const MASTERY_INTERVAL_DAYS = Object.freeze([1, 3, 7, 16, 35]);
  const MASTERY_STAGES = Object.freeze(['not_started', 'learning', 'learned', 'confirmed', 'stable']);
  const REQUIRED_PRACTICE_TYPES = GRAMMAR_ACTIVE_PRACTICE_TYPES;
  const MASTERY_VERSION = 2;
  const DAY_MS = 86_400_000;
  const MAX_RECENT_EVENT_IDS = 64;
  const MAX_MASTERY_HISTORY = 64;
  const MAX_REPLAY_MATERIAL_LENGTH = 65_536;
  const MIN_CORRECT_PER_TYPE = 4;
  const MIN_ACCURACY_PER_TYPE = 0.75;
  const REGRESSION_REASON_CODES = GRAMMAR_ERROR_CODES;
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

  function generatedHistoryPointerType(item) {
    return parseGeneratedGrammarItemId(item?.id)?.type || null;
  }

  function hasValidGeneratedHistoryProvenance(item) {
    const reference = parseGeneratedGrammarItemReference(item);
    return reference != null && item?.source === 'generated' && item?.type === reference.type;
  }

  function historySessionHasValidGeneratedProvenance(session) {
    if (!session || typeof session !== 'object' || !Array.isArray(session.items)
      || session.items.length === 0 || typeof session.assisted !== 'boolean') return false;
    const itemsValid = session.items.every((item) => {
      const claimsGenerated = item?.source === 'generated'
        || String(item?.id || '').startsWith('generated.g.q.');
      return !claimsGenerated || hasValidGeneratedHistoryProvenance(item);
    });
    if (!itemsValid) return false;
    const generatedCount = session.items.filter((item) => generatedHistoryPointerType(item) != null).length;
    const expectedSource = generatedCount === 0 ? 'builtin'
      : (generatedCount === session.items.length ? 'generated' : 'mixed');
    return session.source === expectedSource && (generatedCount === 0 || session.assisted === true);
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
    const normalizeHistorySession = (session) => {
      if (!session || typeof session !== 'object') return null;
      if (!historySessionHasValidGeneratedProvenance(session)) return null;
      return {
        id: typeof session.id === 'string' ? session.id : null,
        scope: ['topic', 'mixed'].includes(session.scope) ? session.scope : null,
        mode: GRAMMAR_PRACTICE_MODES.includes(session.mode) ? session.mode : null,
        source: ['builtin', 'mixed', 'generated'].includes(session.source) ? session.source : null,
        catalog: {
          version: typeof session.catalog?.version === 'string' ? session.catalog.version : null,
          revision: boundedInteger(session.catalog?.revision),
        },
        items: Array.isArray(session.items) ? session.items.slice(0, 32).map((item) => ({
          id: typeof item?.id === 'string' ? item.id : null,
          ...(Number.isInteger(item?.topicId) && item.topicId >= 1 && item.topicId <= 20
            ? { topicId: item.topicId } : {}),
          type: REQUIRED_PRACTICE_TYPES.includes(item?.type) ? item.type : null,
          transfer: Boolean(item?.transfer),
          correct: Boolean(item?.correct),
          diagnosticId: typeof item?.diagnosticId === 'string' ? item.diagnosticId : null,
          errorCode: normalizeRegressionReason(item?.errorCode),
          confusionPair: typeof item?.confusionPair === 'string' ? item.confusionPair : null,
          transferStatus: item?.transferStatus === 'due_next_session' ? 'due_next_session' : null,
          ...(hasValidGeneratedHistoryProvenance(item)
            ? { source: 'generated', revision: GENERATED_GRAMMAR_REVISION }
            : {}),
        })) : [],
        startedAt: finiteTimestamp(session.startedAt),
        assisted: Boolean(session.assisted),
        endedAt: finiteTimestamp(session.endedAt),
      };
    };
    const masteryHistory = Array.isArray(source.masteryHistory)
      ? source.masteryHistory.filter((entry) => entry && typeof entry === 'object').slice(-MAX_MASTERY_HISTORY).map((entry) => {
        const session = entry.type === 'session_completed' ? normalizeHistorySession(entry.session) : null;
        return {
          eventId: typeof entry.eventId === 'string' ? entry.eventId : null,
          type: entry.type === 'session_completed' ? 'session_completed' : 'review_completed',
          replayFingerprint: (() => {
            const replayMaterial = String(entry.replayFingerprint || '');
            return replayMaterial.startsWith('canonical-json-v1:')
              && replayMaterial.length <= MAX_REPLAY_MATERIAL_LENGTH ? replayMaterial : null;
          })(),
          at: finiteTimestamp(entry.at),
          outcome: typeof entry.outcome === 'string' ? entry.outcome : 'recorded',
          fromStage: MASTERY_STAGES.includes(entry.fromStage) ? entry.fromStage : 'not_started',
          toStage: MASTERY_STAGES.includes(entry.toStage) ? entry.toStage : stage,
          reviewStep: boundedInteger(entry.reviewStep, 0, MASTERY_INTERVAL_DAYS.length),
          ...(session ? { session } : {}),
        };
      })
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
    return typeof event?.id === 'string' && event.id && Array.isArray(record?.recentEventIds)
      && record.recentEventIds.includes(event.id);
  }

  function canonicalReplayValue(value) {
    if (Array.isArray(value)) return value.map(canonicalReplayValue);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.keys(value).sort().flatMap((key) => (
      value[key] === undefined ? [] : [[key, canonicalReplayValue(value[key])]]
    )));
  }

  function masteryEventReplayFingerprint(event) {
    return `canonical-json-v1:${JSON.stringify(canonicalReplayValue(event))}`;
  }

  function masteryEventReplayMatches(record, event) {
    if (!eventWasApplied(record, event)) return false;
    if (!['session_completed', 'review_completed'].includes(event?.type)) return true;
    const storedEntry = record.masteryHistory.find((entry) => entry.eventId === event.id);
    if (event.type === 'session_completed'
      && (!storedEntry?.session || !historySessionHasValidGeneratedProvenance(storedEntry.session))) return false;
    return Boolean(storedEntry?.replayFingerprint)
      && storedEntry.replayFingerprint === masteryEventReplayFingerprint(event);
  }

  function completionEventIsDurable({ record, event, result = null } = {}) {
    if (!event || typeof event.id !== 'string') return false;
    const outcomes = Array.isArray(result?.results) ? result.results : [result];
    const serverOutcome = outcomes.find((item) => item?.eventId === event.id);
    if (serverOutcome?.applied === true || serverOutcome?.replay === true) return true;
    return Boolean(record && masteryEventReplayMatches(record, event));
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

  function independentRegressionReason(event, topicId = null) {
    const multiTopic = ['mixed_practice', 'exam_19_24'].includes(event?.session?.mode);
    const evidence = multiTopic
      ? event?.independentErrors?.find((candidate) => candidate?.topicId === topicId)
      : event?.independentError;
    const reason = normalizeRegressionReason(evidence?.reason);
    if (!reason || event?.source === 'generated' || event?.assisted !== true) return null;
    if (event.type === 'review_completed') {
      return event.passed === false && typeof evidence.itemId === 'string' && evidence.itemId
        ? reason : null;
    }
    if (event.type !== 'session_completed' || !Array.isArray(event.session?.items)) return null;
    const matched = event.session.items.some((outcome) => outcome && outcome.correct === false
      && (!multiTopic || outcome.topicId === topicId)
      && outcome.id === evidence.itemId
      && outcome.diagnosticId === evidence.diagnosticId
      && outcome.errorCode === reason
      && (outcome.confusionPair || null) === (evidence.confusionPair || null));
    return matched ? reason : null;
  }

  function markLateRegression(record, reason, at) {
    if (!normalizeRegressionReason(reason)) return false;
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

  function advanceEligibleRecall(record, at) {
    if (!['learned', 'confirmed'].includes(record.stage)
      || record.eligibleAt == null || at < record.eligibleAt) return false;
    record.reviewStep = Math.min(MASTERY_INTERVAL_DAYS.length, record.reviewStep + 1);
    record.highestReviewStep = Math.max(record.highestReviewStep, record.reviewStep);
    setStage(record, record.reviewStep >= MASTERY_INTERVAL_DAYS.length ? 'stable' : 'confirmed', at);
    record.eligibleAt = record.reviewStep >= MASTERY_INTERVAL_DAYS.length
      ? null
      : at + MASTERY_INTERVAL_DAYS[record.reviewStep] * DAY_MS;
    record.lastRegressionReason = null;
    return true;
  }

  function completedRequiredPractice(event) {
    if (event.assisted || event.source !== 'builtin'
      || (event.session && event.session.mode !== 'topic_practice')) return false;
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
      replayFingerprint: masteryEventReplayFingerprint(event),
      at,
      outcome,
      fromStage,
      toStage: record.stage,
      reviewStep: record.reviewStep,
      ...(event.type === 'session_completed' && event.session ? {
        session: { ...event.session, items: event.session.items.map((item) => ({ ...item })), endedAt: at },
      } : {}),
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
      const topicStageEligible = stageEligible && (!event.session
        || ['topic_practice', 'legacy_practice'].includes(event.session.mode));
      const sessionMode = event.session?.mode;
      const topicId = Number(options.topicId);
      const multiTopic = ['mixed_practice', 'exam_19_24'].includes(sessionMode);
      const scopedItems = multiTopic
        ? event.session.items.filter((item) => item?.topicId === topicId)
        : event.session?.items || [];
      const independentRecall = event.source === 'builtin'
        && ['mixed_practice', 'targeted_practice'].includes(sessionMode)
        && scopedItems.some((item) => item?.transfer !== true)
        && scopedItems.every((item) => item?.correct === true)
        && (sessionMode === 'mixed_practice' || event.assisted !== true);
      const fromStage = next.stage;
      next.lastAttemptAt = at;
      if (event.assisted) next.stats.assistedAttempts += 1;
      if (multiTopic) {
        next.stats.correct += scopedItems.filter((item) => item?.correct === true).length;
        next.stats.errors += scopedItems.filter((item) => item?.correct === false).length;
      } else {
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
      }
      const regressionReason = independentRegressionReason(event, topicId);
      const sessionRegressed = regressionReason != null && markLateRegression(next, regressionReason, at);
      if (topicStageEligible && next.stage === 'not_started') setStage(next, 'learning', at);
      if (topicStageEligible && next.stage === 'learning' && completedRequiredPractice(event)) {
        setStage(next, 'learned', at);
        next.reviewStep = 0;
        next.eligibleAt = at + MASTERY_INTERVAL_DAYS[0] * DAY_MS;
        next.lastRegressionReason = null;
      }
      const recallAdvanced = !sessionRegressed && independentRecall
        && advanceEligibleRecall(next, at);
      const stageAdvanced = MASTERY_STAGES.indexOf(next.stage) > MASTERY_STAGES.indexOf(fromStage);
      const outcome = sessionRegressed ? 'regressed'
        : recallAdvanced || stageAdvanced ? 'advanced' : 'recorded';
      appendMasteryHistory(next, event, at, fromStage, outcome);
      next.masteryRevision += 1;
    } else if (event.type === 'review_completed') {
      if (!serverCanonical || !matchesExpectedMastery(next, event)) return next;
      const fromStage = next.stage;
      next.lastAttemptAt = at;
      if (event.assisted) next.stats.assistedAttempts += 1;
      let reviewRegressed = false;
      const regressionReason = independentRegressionReason(event, Number(options.topicId));
      if (!event.passed && regressionReason != null) {
        reviewRegressed = markLateRegression(next, regressionReason, at);
      } else if (stageEligible) advanceEligibleRecall(next, at);
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
      .replace(/[\u2018\u2019]/gu, "'")
      .replace(/\s+/gu, ' ')
      .trim()
      .replace(/[.?!]+$/u, '')
      .trim();
  }

  function seededRandom(seed) {
    let state = 2_166_136_261;
    for (const character of String(seed ?? 'grammar-active-runner')) {
      state = Math.imul(state ^ character.charCodeAt(0), 16_777_619) >>> 0;
    }
    return function nextSeededValue() {
      state += 0x6D2B79F5;
      let value = state;
      value = Math.imul(value ^ (value >>> 15), value | 1);
      value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
      return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
    };
  }

  function practiceRandom(seedOrRandom) {
    return typeof seedOrRandom === 'function' ? seedOrRandom : seededRandom(seedOrRandom);
  }

  function activePracticeLevels(bank) {
    const source = bank || {};
    return {
      choice: Array.isArray(source.c) ? source.c : [],
      input: Array.isArray(source.f) ? source.f : [],
      correction: Array.isArray(source.correction) ? source.correction : [],
      transform: Array.isArray(source.transform) ? source.transform : [],
    };
  }

  function hasActivePractice(bank) {
    const levels = activePracticeLevels(bank);
    return REQUIRED_PRACTICE_TYPES.every((type) => levels[type].length >= 8);
  }

  function activeQueueItem(type, question, topic, transfer = false) {
    return {
      k: type,
      q: question,
      t: topic,
      voice: question.voice || null,
      source: 'builtin',
      transfer,
    };
  }

  function buildActiveTopicQueue(bank, topic, seedOrRandom) {
    if (!hasActivePractice(bank)) return [];
    const levels = activePracticeLevels(bank);
    const random = practiceRandom(seedOrRandom);
    const selected = [];
    for (const type of REQUIRED_PRACTICE_TYPES) {
      const pairs = new Map();
      for (const question of levels[type]) {
        if (!question.transferPair) return [];
        if (!pairs.has(question.transferPair)) pairs.set(question.transferPair, []);
        pairs.get(question.transferPair).push(question);
      }
      const candidates = shuffled([...pairs.values()], random).filter((pair) => pair.length === 2);
      if (candidates.length < 4) return [];
      const originals = candidates.slice(0, 4).map((pair) => shuffled(pair, random)[0]);
      selected.push(...originals.map((question) => activeQueueItem(type, question, topic)));
    }
    return selected;
  }

  function itemWeaknesses(question) {
    const result = [];
    if (question?.type === 'choice') {
      for (const diagnostic of question.diagnostics || []) {
        if (!diagnostic) continue;
        result.push({ errorCode: diagnostic.errorCode, confusionPair: diagnostic.confusionPair || null });
      }
    } else if (question?.errorSkill) {
      result.push({ errorCode: question.errorSkill, confusionPair: question.confusionPair || null });
    }
    return result;
  }

  function weaknessHistory(records) {
    const weights = new Map();
    const seen = new Set();
    for (const [topicText, rawRecord] of Object.entries(records || {})) {
      const topicId = Number(topicText);
      if (!Number.isInteger(topicId) || topicId < 1 || topicId > 20) continue;
      const record = migrateMasteryRecord(rawRecord);
      for (const entry of record.masteryHistory || []) {
        if (entry?.session?.source !== 'builtin') continue;
        const at = finiteTimestamp(entry?.at) || 0;
        for (const outcome of entry?.session?.items || []) {
          if (entry.session.scope === 'mixed' && Number(outcome?.topicId) !== topicId) continue;
          if (outcome?.source === 'generated') continue;
          const outcomeTopic = Number(outcome?.topicId) || topicId;
          if (typeof outcome?.id === 'string') seen.add(outcome.id);
          if (outcome?.correct || !normalizeRegressionReason(outcome?.errorCode)) continue;
          const key = `${outcomeTopic}:${outcome.errorCode}:${outcome.confusionPair || '-'}`;
          const current = weights.get(key) || { count: 0, lastAt: 0 };
          current.count += 1;
          current.lastAt = Math.max(current.lastAt, at);
          weights.set(key, current);
        }
      }
    }
    return { weights, seen };
  }

  function buildMixedPracticeQueue(bankByTopic, records, options = {}) {
    const random = practiceRandom(options.seed ?? options.random);
    const { weights, seen } = weaknessHistory(records);
    const topicUse = new Map();
    const selected = [];
    for (const type of REQUIRED_PRACTICE_TYPES) {
      const candidates = [];
      for (let topicId = 1; topicId <= 20; topicId += 1) {
        const levels = activePracticeLevels(bankByTopic?.[topicId]);
        for (const question of levels[type]) {
          if (!question?.id || !question.transferPair) continue;
          const weaknessWeight = itemWeaknesses(question).reduce((maximum, weakness) => {
            const exact = weights.get(`${topicId}:${weakness.errorCode}:${weakness.confusionPair || '-'}`);
            const broad = weights.get(`${topicId}:${weakness.errorCode}:-`);
            return Math.max(maximum, (exact?.count || 0) * 80 + (broad?.count || 0) * 25
              + Math.min(20, Math.floor(Math.max(exact?.lastAt || 0, broad?.lastAt || 0) / DAY_MS)));
          }, 0);
          const record = records?.[topicId] ? migrateMasteryRecord(records[topicId]) : null;
          const dueWeight = record && masteryView(record, { now: finiteTimestamp(options.now) ?? Date.now() }).due ? 50 : 0;
          candidates.push({
            topicId, question,
            score: weaknessWeight + dueWeight + (seen.has(question.id) ? 0 : 30) + random(),
          });
        }
      }
      candidates.sort((left, right) => right.score - left.score
        || left.topicId - right.topicId || left.question.id.localeCompare(right.question.id));
      const usedPairs = new Set();
      for (const candidate of candidates) {
        if (selected.filter((item) => item.k === type).length >= 4) break;
        if ((topicUse.get(candidate.topicId) || 0) >= 2 || usedPairs.has(candidate.question.transferPair)) continue;
        selected.push(activeQueueItem(type, candidate.question, candidate.topicId));
        topicUse.set(candidate.topicId, (topicUse.get(candidate.topicId) || 0) + 1);
        usedPairs.add(candidate.question.transferPair);
      }
    }
    return selected.length === 16 ? selected : [];
  }

  function supportsFocus(question, focus, exactPair = true) {
    return itemWeaknesses(question).some((weakness) => weakness.errorCode === focus?.errorCode
      && (!exactPair || (weakness.confusionPair || null) === (focus?.confusionPair || null)));
  }

  function buildTargetedPracticeQueue(bankByTopic, focus, options = {}) {
    const topicId = Number(focus?.topicId);
    if (!Number.isInteger(topicId) || topicId < 1 || topicId > 20
      || !normalizeRegressionReason(focus?.errorCode)) return [];
    const levels = activePracticeLevels(bankByTopic?.[topicId]);
    if (!REQUIRED_PRACTICE_TYPES.every((type) => levels[type].length >= 8)) return [];
    const random = practiceRandom(options.seed ?? options.random);
    const all = REQUIRED_PRACTICE_TYPES.flatMap((type) => levels[type].map((question) => ({ type, question })));
    const exactPairs = new Set(all.filter((candidate) => supportsFocus(candidate.question, focus, true))
      .map((candidate) => candidate.question.transferPair));
    const errorPairs = new Set(all.filter((candidate) => supportsFocus(candidate.question, focus, false))
      .map((candidate) => candidate.question.transferPair));
    if (exactPairs.size < GRAMMAR_TARGETED_MIN_EXACT_ITEMS
      || errorPairs.size < GRAMMAR_TARGETED_MIN_ERROR_ITEMS) return [];
    const ordered = shuffled(all, random).sort((left, right) => {
      const leftExact = supportsFocus(left.question, focus, true) ? 2 : supportsFocus(left.question, focus, false) ? 1 : 0;
      const rightExact = supportsFocus(right.question, focus, true) ? 2 : supportsFocus(right.question, focus, false) ? 1 : 0;
      return rightExact - leftExact;
    });
    const selected = [];
    const pairs = new Set();
    for (const candidate of ordered) {
      if (selected.length >= 8) break;
      if (pairs.has(candidate.question.transferPair)) continue;
      selected.push(activeQueueItem(candidate.type, candidate.question, topicId));
      pairs.add(candidate.question.transferPair);
    }
    const exactCount = selected.filter((item) => supportsFocus(item.q, focus, true)).length;
    const errorCount = selected.filter((item) => supportsFocus(item.q, focus, false)).length;
    return selected.length === 8
      && exactCount >= Math.min(4, exactPairs.size)
      && errorCount >= Math.min(4, errorPairs.size)
      ? selected : [];
  }

  function checkPracticeAnswer(item, answer) {
    const question = item?.q || item;
    const type = question?.type || item?.k;
    let correct = false;
    let normalized = null;
    if (type === 'choice') {
      const index = typeof answer === 'number' ? answer : Number(answer?.choiceIndex);
      correct = Number.isInteger(index) && index === question?.a;
      normalized = Number.isInteger(index) ? String(index) : '';
      const diagnostic = !correct && Number.isInteger(index) ? question?.diagnostics?.[index] : null;
      return {
        correct,
        normalized,
        diagnosticId: correct ? null : (diagnostic?.id || null),
        errorCode: correct ? null : (diagnostic ? diagnostic.errorCode : question?.errorSkill || null),
        confusionPair: correct ? null : (diagnostic ? diagnostic.confusionPair ?? null : question?.confusionPair ?? null),
      };
    } else {
      normalized = normalizeAnswer(answer);
      correct = Array.isArray(question?.ans)
        && question.ans.some((accepted) => normalizeAnswer(accepted) === normalized);
    }
    return {
      correct,
      normalized,
      diagnosticId: null,
      errorCode: correct ? null : (question?.errorSkill || null),
      confusionPair: correct ? null : (question?.confusionPair || null),
    };
  }

  function dueNextSession(weakness) {
    return {
      status: 'due_next_session',
      errorCode: weakness?.errorCode || null,
      confusionPair: weakness?.confusionPair ?? null,
      maxTransferAttempts: 1,
    };
  }

  function enqueueTransferAfterFailure(session, bank, failedItem, seedOrRandom, chosenWeakness = null) {
    if (!session?.activeRunner || !failedItem?.q) return null;
    const weakness = chosenWeakness || {
      errorCode: failedItem.q.errorSkill,
      confusionPair: failedItem.q.confusionPair || null,
    };
    if (failedItem.transfer) return dueNextSession(weakness);
    const levels = activePracticeLevels(bank);
    const reserved = new Set(Array.isArray(session.reservedItemIds) ? session.reservedItemIds : []);
    const supportsWeakness = (question) => question?.type === 'choice'
      ? question.diagnostics?.some((diagnostic) => diagnostic
        && diagnostic.errorCode === weakness.errorCode
        && (diagnostic.confusionPair || null) === (weakness.confusionPair || null))
      : question?.errorSkill === weakness.errorCode
        && (question.confusionPair || null) === (weakness.confusionPair || null);
    if (chosenWeakness && !supportsWeakness(failedItem.q)) return dueNextSession(weakness);
    const sameWeakness = (question) => question.id !== failedItem.q.id
      && !reserved.has(question.id)
      && question.transferPair === failedItem.q.transferPair
      && (!chosenWeakness || supportsWeakness(question));
    const sameType = (levels[failedItem.k] || []).filter(sameWeakness);
    const candidates = sameType;
    if (!candidates.length) return dueNextSession(weakness);
    const random = practiceRandom(seedOrRandom);
    const question = shuffled(candidates, random)[0];
    const type = question.type;
    const transfer = activeQueueItem(type, question, failedItem.t, true);
    session.reservedItemIds = [...reserved, question.id];
    session.queue.splice(Math.min(session.queue.length, session.i + 1), 0, transfer);
    return transfer;
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
    const ai = (generated || []).filter((item) => {
      const question = item?.q;
      const expectedType = item?.k === 'c' ? 'choice' : item?.k === 'f' ? 'input' : null;
      const reference = parseGeneratedGrammarItemReference(question);
      return expectedType && question?.type === expectedType
        && reference?.type === expectedType;
    });
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
    } else if (!session.activeRunner) {
      const outcomes = Array.isArray(session.itemOutcomes) ? session.itemOutcomes : [];
      const attempts = outcomes.filter((outcome) => outcome.id === item?.q?.id).length;
      if (attempts < 2) {
        session.queue.push(item);
      } else if (outcomes.length) {
        outcomes[outcomes.length - 1].transferStatus = 'due_next_session';
      }
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
    masteryEventReplayMatches,
    masteryEventReplayFingerprint,
    completionEventIsDurable,
    masteryView,
    regressionReasonLabel,
    effectiveBank,
    levelTwo,
    shuffled,
    buildTopicQueue,
    hasActivePractice,
    buildActiveTopicQueue,
    buildMixedPracticeQueue,
    buildTargetedPracticeQueue,
    checkPracticeAnswer,
    enqueueTransferAfterFailure,
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
  masteryEventReplayMatches,
  masteryEventReplayFingerprint,
} = EasyBoostGrammar;
