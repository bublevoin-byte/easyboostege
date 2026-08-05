import { grammarActivityId, splitLearningActivityDuration } from '../learning-activity-contract.js';

(function initializeGrammarModule(global) {
  'use strict';

  const REVIEW_INTERVAL_DAYS = Object.freeze([7, 16, 35]);

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
      if (record?.st === 2 && Number(record.due) > 0 && Number(record.due) <= now) due.push(topic);
    }
    return due;
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
    if ((Number(record?.st) || 0) >= 1) {
      return shuffled(levelOne, random).slice(0, 2).concat(shuffled(advanced, random).slice(0, 6));
    }
    return shuffled(levelOne, random).slice(0, 4).concat(shuffled(advanced, random).slice(0, 3));
  }

  function applyAnswer(record, session, item, correct, now = Date.now()) {
    const target = record;
    if (session.mode === 'rev') {
      session.done += 1;
      if (correct) {
        target.ok += 1;
        session.ok += 1;
      } else {
        target.err += 1;
        session.errT[item.t] = 1;
        session.queue.push(item);
      }
      return target;
    }
    if (target.st === 0) target.st = 1;
    if (correct) {
      target.ok += 1;
      session.ok += 1;
      if (item.k !== 'c') {
        target.sr += 1;
        if (target.sr >= 4 && target.st !== 2) {
          target.st = 2;
          target.rs = 0;
          target.due = now + REVIEW_INTERVAL_DAYS[0] * 86_400_000;
        }
      }
    } else {
      target.err += 1;
      if (item.k !== 'c') {
        target.sr = 0;
        if (target.st === 2) {
          target.st = 1;
          target.due = 0;
        }
      }
      session.queue.push(item);
    }
    session.done += 1;
    return target;
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

  global.EasyBoostGrammar = Object.freeze({
    REVIEW_INTERVAL_DAYS,
    normalizeAnswer,
    countClosed,
    dueTopics,
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
})(window);
