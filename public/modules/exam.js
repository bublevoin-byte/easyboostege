(function initializeExamModule(global) {
  'use strict';

  const DEFAULT_BADGES = { gold: 0.9, silver: 0.6 };

  function record(previous, score) {
    const before = previous && typeof previous === 'object' ? previous : { n: 0, last: 0, best: 0 };
    const value = Math.max(0, Number(score) || 0);
    return {
      n: (Number(before.n) || 0) + 1,
      last: value,
      best: Math.max(Number(before.best) || 0, value),
    };
  }

  function elapsedSeconds(startedAt, now) {
    const start = Number(startedAt) || 0;
    const end = Number(now) || 0;
    return Math.max(0, Math.floor((end - start) / 1000));
  }

  function sections(parts) {
    return (parts || []).map((part) => ({
      label: String(part[0]),
      correct: Math.max(0, Number(part[1]) || 0),
      total: Math.max(0, Number(part[2]) || 0),
    }));
  }

  function total(parts) {
    return sections(parts).reduce((sum, part) => sum + part.correct, 0);
  }

  function maxScore(parts) {
    return sections(parts).reduce((sum, part) => sum + part.total, 0);
  }

  function sectionLine(parts) {
    return sections(parts).map((part) => part.label + ' ' + part.correct + '/' + part.total).join(' · ');
  }

  function weakestSection(parts) {
    const list = sections(parts);
    if (!list.length) return null;
    return list.slice().sort((left, right) => (
      (left.total ? left.correct / left.total : 0) - (right.total ? right.correct / right.total : 0)
    ))[0];
  }

  function badge(score, max, thresholds) {
    const bounds = thresholds || DEFAULT_BADGES;
    const ratio = max ? (Number(score) || 0) / max : 0;
    if (ratio >= bounds.gold) return '🏆';
    if (ratio >= bounds.silver) return '💪';
    return '📚';
  }

  function attempt(id, details) {
    const value = details || {};
    return {
      id: String(id),
      module: String(value.module || 'exam'),
      activity: String(value.activity || ''),
      score: Math.max(0, Number(value.score) || 0),
      maxScore: Math.max(0, Number(value.maxScore) || 0),
      durationMs: Math.max(0, Number(value.durationMs) || 0),
      metadata: value.metadata || { source: 'builtin' },
    };
  }

  function normalizeGrammarAnswer(value) {
    return String(value ?? '')
      .trim()
      .toLowerCase()
      .replace(/[\u2018\u2019]/gu, "'")
      .replace(/\s+/gu, ' ')
      .replace(/[.!?,;:]+$/gu, '');
  }

  function masteryExpectation(topicId, record) {
    const value = record && typeof record === 'object' ? record : {};
    const stages = ['not_started', 'learning', 'learned', 'confirmed', 'stable'];
    return {
      topicId,
      expectedRevision: Math.max(0, Math.floor(Number(value.masteryRevision) || 0)),
      expectedStage: stages.includes(value.stage) ? value.stage : 'not_started',
      expectedReviewStep: Math.min(5, Math.max(0, Math.floor(Number(value.reviewStep) || 0))),
    };
  }

  function assessGrammar19To24(options) {
    const value = options && typeof options === 'object' ? options : {};
    const catalog = value.catalog;
    const form = value.form;
    const answers = Array.isArray(value.answers) ? value.answers : [];
    const source = value.source === 'generated' ? 'generated' : 'builtin';
    if (!catalog || typeof catalog.version !== 'string' || !Number.isInteger(catalog.revision)
      || !form || !Array.isArray(form.gaps) || form.gaps.length !== 6 || answers.length !== 6) {
      throw new Error('INVALID_GRAMMAR_EXAM_ASSESSMENT');
    }
    const results = form.gaps.map((gap, index) => {
      const answer = String(answers[index] ?? '');
      const correct = Array.isArray(gap.ans)
        && gap.ans.some((candidate) => normalizeGrammarAnswer(candidate) === normalizeGrammarAnswer(answer));
      return { gap, answer, correct };
    });
    const score = results.filter((result) => result.correct).length;
    const assisted = source === 'generated' || score !== results.length;
    const topicIds = [...new Set(form.gaps.map((gap) => Number(gap.t)))];
    if (topicIds.some((topicId) => !Number.isInteger(topicId) || topicId < 1 || topicId > 20)) {
      throw new Error('INVALID_GRAMMAR_EXAM_TOPIC');
    }
    const topicExpectations = topicIds.map((topicId) => masteryExpectation(topicId, value.records?.[topicId]));
    const items = results.map(({ gap, correct }) => ({
      id: String(gap.id || ''), topicId: Number(gap.t), type: 'input', transfer: false, correct,
      diagnosticId: null,
      errorCode: correct ? null : String(gap.errorSkill || 'word_or_verb_form'),
      confusionPair: correct ? null : gap.confusionPair || null,
      transferStatus: null,
      ...(source === 'generated' ? { source: 'generated', revision: Number(gap.revision) } : {}),
    }));
    const independentErrors = [];
    if (source === 'builtin') {
      for (const item of items) {
        if (item.correct || independentErrors.some((error) => error.topicId === item.topicId)) continue;
        independentErrors.push({
          topicId: item.topicId, itemId: item.id, diagnosticId: null,
          reason: item.errorCode, confusionPair: item.confusionPair,
        });
      }
    }
    const ownerExpectation = topicExpectations[0];
    const id = String(value.id || '');
    const event = {
      type: 'session_completed', id, assisted, source,
      completedTypes: ['input'], typeScores: { input: { correct: score, total: 6 } },
      session: {
        id, scope: 'mixed', mode: 'exam_19_24', source,
        catalog: { version: catalog.version, revision: catalog.revision },
        items, startedAt: Math.max(0, Math.floor(Number(value.startedAt) || 0)), assisted,
        topicExpectations,
      },
      ...(independentErrors.length ? { independentErrors } : {}),
      expectedRevision: ownerExpectation.expectedRevision,
      expectedStage: ownerExpectation.expectedStage,
      expectedReviewStep: ownerExpectation.expectedReviewStep,
    };
    return {
      score,
      event: { topicId: ownerExpectation.topicId, event },
      errorBank: results.filter((result) => !result.correct).map(({ gap }) => ({
        module: 'grammar', itemKey: String(gap.id), errorType: String(gap.errorSkill || 'word_or_verb_form'),
        details: { catalogVersion: catalog.version, catalogRevision: catalog.revision, topicId: Number(gap.t) },
      })),
    };
  }

  function grammarDashboard(records, options) {
    const source = records && typeof records === 'object' ? records : {};
    const now = Number(options?.now) || Date.now();
    const stages = ['not_started', 'learning', 'learned', 'confirmed', 'stable'];
    const topics = Array.from({ length: 20 }, (_, index) => {
      const topicId = index + 1;
      const record = source[topicId] && typeof source[topicId] === 'object' ? source[topicId] : {};
      const stage = stages.includes(record.stage) ? record.stage : 'not_started';
      const eligibleAt = record.eligibleAt != null && Number.isFinite(Number(record.eligibleAt))
        ? Number(record.eligibleAt) : null;
      return { topicId, stage, due: stage !== 'stable' && eligibleAt != null && eligibleAt <= now };
    });
    const stageCounts = Object.fromEntries(stages.map((stage) => [stage, topics.filter((topic) => topic.stage === stage).length]));
    const weak = new Map();
    for (const topic of topics) {
      const record = source[topic.topicId] || {};
      let historyErrors = 0;
      for (const entry of Array.isArray(record.masteryHistory) ? record.masteryHistory : []) {
        const session = entry && entry.session;
        if (!session || session.source !== 'builtin' || !Array.isArray(session.items)) continue;
        for (const outcome of session.items) {
          if (!outcome || outcome.correct !== false || typeof outcome.errorCode !== 'string'
            || (session.scope === 'mixed' && Number(outcome.topicId) !== topic.topicId)) continue;
          const exact = weak.get(outcome.errorCode) || { errorCode: outcome.errorCode, topicIds: new Set(), errors: 0 };
          exact.topicIds.add(topic.topicId);
          exact.errors += 1;
          weak.set(outcome.errorCode, exact);
          historyErrors += 1;
        }
      }
      const errorCode = typeof record.lastRegressionReason === 'string' ? record.lastRegressionReason : null;
      const errors = Math.max(0, Math.floor(Number(record.stats?.errors) || 0));
      if (historyErrors || !errorCode || errors === 0) continue;
      const entry = weak.get(errorCode) || { errorCode, topicIds: new Set(), errors: 0 };
      entry.topicIds.add(topic.topicId);
      entry.errors += errors;
      weak.set(errorCode, entry);
    }
    return {
      topics,
      stageCounts,
      dueTopicIds: topics.filter((topic) => topic.due).map((topic) => topic.topicId),
      weakErrorTypes: [...weak.values()].map((entry) => ({
        errorCode: entry.errorCode, topics: entry.topicIds.size, errors: entry.errors,
      })).sort((left, right) => right.errors - left.errors || left.errorCode.localeCompare(right.errorCode)),
    };
  }

  global.EasyBoostExam = Object.freeze({
    record,
    elapsedSeconds,
    sections,
    total,
    maxScore,
    sectionLine,
    weakestSection,
    badge,
    attempt,
    normalizeGrammarAnswer,
    assessGrammar19To24,
    grammarDashboard,
    DEFAULT_BADGES,
  });
})(window);
