import crypto from 'node:crypto';

import {
  GRAMMAR_ERROR_CODES,
  GRAMMAR_RECOMMENDATION_VERSION,
  parseGrammarConfusionPair,
} from '../public/grammar-domain-contract.js';
import { migrateMasteryRecord, masteryView } from '../public/modules/grammar.js';

export { GRAMMAR_RECOMMENDATION_VERSION };
const DAY_MS = 86_400_000;
const STAGE_PRIORITY = Object.freeze({
  not_started: 5, learning: 4, learned: 3, confirmed: 2, stable: 1,
});

function timestamp(value) {
  const parsed = value instanceof Date ? value.getTime() : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

function digest(value) {
  return crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

function completionMaterial({ owner, pointer, itemIds } = {}) {
  if (typeof owner !== 'string' || !owner || !pointer || typeof pointer !== 'object'
    || !Array.isArray(itemIds) || itemIds.length !== 8
    || itemIds.some((itemId) => typeof itemId !== 'string' || !itemId)
    || new Set(itemIds).size !== itemIds.length) return null;
  return { owner, pointer: canonical(pointer), itemIds: itemIds.slice() };
}

export function createGrammarRecommendationCompletionToken(binding, secret) {
  const material = completionMaterial(binding);
  if (!material || typeof secret !== 'string' || secret.length < 8) {
    throw new TypeError('GRAMMAR_RECOMMENDATION_COMPLETION_INPUT_INVALID');
  }
  return crypto.createHmac('sha256', secret)
    .update(JSON.stringify(canonical(material))).digest('base64url');
}

export function verifyGrammarRecommendationCompletionToken(binding, secret, token) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(token)) return false;
  let expected;
  try {
    expected = createGrammarRecommendationCompletionToken(binding, secret);
  } catch {
    return false;
  }
  const actualBuffer = Buffer.from(token, 'utf8');
  const expectedBuffer = Buffer.from(expected, 'utf8');
  return actualBuffer.length === expectedBuffer.length
    && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

function catalogIndex(catalog) {
  const result = new Map();
  for (const [topicText, levels] of Object.entries(catalog?.bank || {})) {
    const topicId = Number(topicText);
    for (const kind of ['c', 'f', 'correction', 'transform']) {
      for (const item of levels?.[kind] || []) result.set(item.id, { item, topicId });
    }
  }
  for (const form of catalog?.exams || []) {
    for (const gap of form?.gaps || []) result.set(gap.id, { item: gap, topicId: Number(gap.t) });
  }
  return result;
}

function exactOutcomeWeakness(outcome, indexed, fallbackTopicId) {
  if (!outcome || outcome.correct !== false || outcome.source === 'generated') return null;
  const entry = indexed.get(String(outcome.id || ''));
  const topicId = Number(outcome.topicId) || fallbackTopicId;
  if (!entry || entry.topicId !== topicId) return null;
  const item = entry.item;
  if (item.type === 'choice') {
    const diagnostic = item.diagnostics?.find((candidate) => candidate?.id === outcome.diagnosticId);
    if (!diagnostic || diagnostic.errorCode !== outcome.errorCode
      || (diagnostic.confusionPair || null) !== (outcome.confusionPair || null)) return null;
    return {
      topicId, errorCode: diagnostic.errorCode,
      confusionPair: diagnostic.confusionPair || null,
    };
  }
  const errorSkill = item.errorSkill || (item.type === 'input' ? 'word_or_verb_form' : null);
  if (outcome.diagnosticId != null || errorSkill !== outcome.errorCode
    || (item.confusionPair || null) !== (outcome.confusionPair || null)) return null;
  return { topicId, errorCode: errorSkill, confusionPair: item.confusionPair || null };
}

function fallbackWeakness(catalog, topicId) {
  const levels = catalog?.bank?.[topicId] || {};
  for (const item of levels.c || []) {
    const diagnostic = item.diagnostics?.find(Boolean);
    if (diagnostic) return {
      topicId, errorCode: diagnostic.errorCode,
      confusionPair: diagnostic.confusionPair || null,
    };
  }
  for (const kind of ['f', 'correction', 'transform']) {
    const item = levels[kind]?.[0];
    if (item?.errorSkill) return {
      topicId, errorCode: item.errorSkill, confusionPair: item.confusionPair || null,
    };
  }
  return null;
}

function masterySnapshot(mastery, nowMs) {
  return Array.from({ length: 20 }, (_, offset) => {
    const topicId = offset + 1;
    const record = migrateMasteryRecord(mastery?.[topicId], { now: nowMs });
    return {
      topicId,
      masteryRevision: record.masteryRevision,
      stage: record.stage,
      reviewStep: record.reviewStep,
      eligibleAt: record.eligibleAt,
      lastAttemptAt: record.lastAttemptAt,
    };
  });
}

function recommendationCandidate({ mastery, catalog, nowMs }) {
  const indexed = catalogIndex(catalog);
  const candidates = new Map();
  for (let topicId = 1; topicId <= 20; topicId += 1) {
    const record = migrateMasteryRecord(mastery?.[topicId], { now: nowMs });
    for (const entry of record.masteryHistory || []) {
      if (entry?.type !== 'session_completed' || entry.session?.source !== 'builtin') continue;
      const observedAt = timestamp(entry.at) || 0;
      for (const outcome of entry.session?.items || []) {
        if (entry.session.scope === 'mixed' && Number(outcome?.topicId) !== topicId) continue;
        const weakness = exactOutcomeWeakness(outcome, indexed, topicId);
        if (!weakness) continue;
        const key = `${weakness.topicId}:${weakness.errorCode}:${weakness.confusionPair || '-'}`;
        const current = candidates.get(key) || { ...weakness, count: 0, observedAt: 0 };
        current.count += 1;
        current.observedAt = Math.max(current.observedAt, observedAt);
        candidates.set(key, current);
      }
    }
  }
  const ranked = [...candidates.values()].sort((left, right) => (
    right.observedAt - left.observedAt || right.count - left.count
      || left.topicId - right.topicId || left.errorCode.localeCompare(right.errorCode)
      || String(left.confusionPair || '').localeCompare(String(right.confusionPair || ''))
  ));
  if (ranked.length) return { weakness: ranked[0], fallback: false };

  const topics = Array.from({ length: 20 }, (_, offset) => {
    const topicId = offset + 1;
    const record = migrateMasteryRecord(mastery?.[topicId], { now: nowMs });
    const view = masteryView(record, { now: nowMs });
    return { topicId, record, due: view.due };
  }).sort((left, right) => Number(right.due) - Number(left.due)
    || STAGE_PRIORITY[right.record.stage] - STAGE_PRIORITY[left.record.stage]
    || (left.record.lastAttemptAt || 0) - (right.record.lastAttemptAt || 0)
    || left.topicId - right.topicId);
  for (const topic of topics) {
    const weakness = fallbackWeakness(catalog, topic.topicId);
    if (weakness) return { weakness: { ...weakness, count: 0, observedAt: 0 }, fallback: true };
  }
  return null;
}

export function buildGrammarRecommendation({ mastery, catalog, examDate = null, now = new Date() } = {}) {
  const nowMs = timestamp(now);
  if (nowMs == null || !catalog?.version || !Number.isInteger(catalog?.revision)) {
    throw new TypeError('GRAMMAR_RECOMMENDATION_INPUT_INVALID');
  }
  const selected = recommendationCandidate({ mastery, catalog, nowMs });
  if (!selected || !GRAMMAR_ERROR_CODES.includes(selected.weakness.errorCode)
    || (selected.weakness.confusionPair != null
      && parseGrammarConfusionPair(selected.weakness.confusionPair) == null)) {
    throw new Error('GRAMMAR_RECOMMENDATION_UNAVAILABLE');
  }
  const record = migrateMasteryRecord(mastery?.[selected.weakness.topicId], { now: nowMs });
  const examMs = typeof examDate === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(examDate)
    ? new Date(`${examDate}T00:00:00.000Z`).getTime() : Number.NaN;
  const daysToExam = Number.isFinite(examMs) ? Math.max(0, Math.ceil((examMs - nowMs) / DAY_MS)) : null;
  const deadlinePressure = daysToExam != null && daysToExam < 84;
  const earlyPractice = deadlinePressure && record.eligibleAt != null && record.eligibleAt > nowMs;
  const state = masterySnapshot(mastery, nowMs);
  const pointerMaterial = {
    version: GRAMMAR_RECOMMENDATION_VERSION,
    catalogVersion: catalog.version,
    catalogRevision: catalog.revision,
    topicId: selected.weakness.topicId,
    errorCode: selected.weakness.errorCode,
    confusionPair: selected.weakness.confusionPair || null,
    masteryRevision: record.masteryRevision,
    eligibleAt: record.eligibleAt,
    earlyPractice,
    stateFingerprint: digest(state),
  };
  const pointer = { ...pointerMaterial, ref: digest(pointerMaterial) };
  const reasonCodes = [selected.fallback ? 'catalog_fallback' : 'recent_weakness'];
  if (record.eligibleAt != null && record.eligibleAt <= nowMs) reasonCodes.push('due_review');
  if (deadlinePressure) reasonCodes.push('deadline_pressure');
  return {
    pointer,
    reasonCodes,
    observedErrorCount: selected.weakness.count,
    observedAt: selected.weakness.observedAt || null,
  };
}

export function resolveGrammarRecommendation(pointer, context = {}) {
  if (!pointer || typeof pointer !== 'object' || Array.isArray(pointer)) return null;
  let current;
  try {
    current = buildGrammarRecommendation(context);
  } catch {
    return null;
  }
  return JSON.stringify(canonical(pointer)) === JSON.stringify(canonical(current.pointer))
    ? current : null;
}
