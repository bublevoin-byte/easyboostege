import { learningActivityPool, learningActivitySource, listeningActivityId, splitLearningActivityDuration } from '../learning-activity-contract.js';

(function initializeListeningModule(global) {
  'use strict';

  const HISTORY_VERSION = 1;
  const DAY_MS = 86_400_000;
  const SAFE_SET_ID = /^[a-z0-9][a-z0-9.-]{3,119}$/u;
  const SAFE_FORMAT = /^[a-z_]{3,32}$/u;

  function catalogReference(set) {
    const id = String(set?.id || '');
    const revision = Number(set?.revision);
    if (!SAFE_SET_ID.test(id) || !Number.isSafeInteger(revision) || revision < 1 || revision > 10_000) {
      return null;
    }
    return { id, revision, key: `${id}@${revision}` };
  }

  function emptyHistory() {
    return { version: HISTORY_VERSION, items: {}, presented: {}, lastSelected: {} };
  }

  function boundedCount(value, maximum = 1_000_000) {
    return Math.min(maximum, Math.max(0, Math.round(Number(value) || 0)));
  }

  function normalizeHistory(history) {
    const normalized = emptyHistory();
    if (!history || history.version !== HISTORY_VERSION || typeof history.items !== 'object'
      || !history.items || Array.isArray(history.items)) return normalized;
    Object.values(history.items).slice(0, 500).forEach((item) => {
      const reference = catalogReference(item);
      const maximum = boundedCount(item?.lastMaxScore, 1_000);
      const attemptedAt = boundedCount(item?.lastAttemptAt, 9_000_000_000_000);
      if (!reference || !maximum || !attemptedAt) return;
      normalized.items[reference.key] = {
        id: reference.id,
        revision: reference.revision,
        attempts: Math.max(1, boundedCount(item.attempts, 10_000)),
        lastScore: Math.min(maximum, boundedCount(item.lastScore, 1_000)),
        lastMaxScore: maximum,
        lastAttemptAt: attemptedAt,
        transcriptExposed: item.transcriptExposed === true,
        help: {
          slowPlayback: item.help?.slowPlayback === true || boundedCount(item.help?.slowPlaybacks, 10_000) > 0,
          additionalPlaybacks: boundedCount(item.help?.additionalPlaybacks, 10_000),
          synthFallback: item.help?.synthFallback === true || boundedCount(item.help?.synthFallbacks, 10_000) > 0,
        },
      };
    });
    if (history.presented && typeof history.presented === 'object' && !Array.isArray(history.presented)) {
      Object.values(history.presented).slice(0, 500).forEach((item) => {
        const reference = catalogReference(item);
        if (!reference) return;
        normalized.presented[reference.key] = {
          id: reference.id,
          revision: reference.revision,
          presentedAt: boundedCount(item.presentedAt, 9_000_000_000_000),
        };
      });
    }
    const selected = history.lastSelected;
    if (selected && typeof selected === 'object' && !Array.isArray(selected)) {
      Object.entries(selected).slice(0, 10).forEach(([format, item]) => {
        const reference = catalogReference(item);
        if (SAFE_FORMAT.test(format) && reference) {
          normalized.lastSelected[format] = { id: reference.id, revision: reference.revision };
        }
      });
    }
    return normalized;
  }

  function recordCatalogAttempt(history, set, attempt = {}) {
    const reference = catalogReference(set);
    const maximum = boundedCount(attempt.maxScore, 1_000);
    const attemptedAt = boundedCount(attempt.attemptedAt, 9_000_000_000_000);
    const next = normalizeHistory(history);
    if (!reference || !maximum || !attemptedAt) return next;
    const previous = next.items[reference.key];
    next.items[reference.key] = {
      id: reference.id,
      revision: reference.revision,
      attempts: Math.min(10_000, (previous?.attempts || 0) + 1),
      lastScore: Math.min(maximum, boundedCount(attempt.score, 1_000)),
      lastMaxScore: maximum,
      lastAttemptAt: attemptedAt,
      transcriptExposed: previous?.transcriptExposed === true || attempt.transcriptExposed === true,
      help: {
        slowPlayback: attempt.help?.slowPlayback === true,
        additionalPlaybacks: boundedCount(attempt.help?.additionalPlaybacks, 100),
        synthFallback: attempt.help?.synthFallback === true,
      },
    };
    return next;
  }

  function rememberCatalogSelection(history, format, set) {
    const next = normalizeHistory(history);
    const reference = catalogReference(set);
    if (SAFE_FORMAT.test(String(format || '')) && reference) {
      next.lastSelected[format] = { id: reference.id, revision: reference.revision };
      next.presented[reference.key] = {
        id: reference.id, revision: reference.revision, presentedAt: Date.now(),
      };
    }
    return next;
  }

  function catalogAttemptIsAssisted(history, set) {
    const reference = catalogReference(set);
    if (!reference) return false;
    return normalizeHistory(history).items[reference.key]?.transcriptExposed === true;
  }

  function dueInterval(record) {
    const ratio = record.lastScore / record.lastMaxScore;
    const helped = record.help.slowPlayback || record.help.additionalPlaybacks > 0
      || record.help.synthFallback;
    if (helped || ratio < 0.6) return DAY_MS;
    if (ratio < 0.85) return 3 * DAY_MS;
    return 7 * DAY_MS;
  }

  function selectCatalogSet(pool, history, format, now = Date.now()) {
    const candidates = Array.isArray(pool) ? pool.filter(catalogReference) : [];
    if (!candidates.length) return null;
    const normalized = normalizeHistory(history);
    const previous = normalized.lastSelected[String(format || '')];
    const alternatives = candidates.length > 1
      ? candidates.filter((set) => set.id !== previous?.id)
      : candidates;
    const eligible = alternatives.length ? alternatives : candidates;
    const unseen = eligible.filter((set) => {
      const reference = catalogReference(set);
      return !normalized.items[reference.key] && !normalized.presented[reference.key];
    });
    if (unseen.length) {
      const previousIndex = candidates.findIndex((set) => (
        set.id === previous?.id && set.revision === previous?.revision
      ));
      for (let offset = 1; offset <= candidates.length; offset += 1) {
        const candidate = candidates[(previousIndex + offset) % candidates.length];
        if (unseen.includes(candidate)) return candidate;
      }
    }
    return eligible.map((set, index) => {
      const reference = catalogReference(set);
      const record = normalized.items[reference.key] || {
        lastScore: 0, lastMaxScore: 1,
        lastAttemptAt: normalized.presented[reference.key]?.presentedAt || 0,
        help: { slowPlayback: false, additionalPlaybacks: 0, synthFallback: false },
      };
      const dueAt = record.lastAttemptAt + dueInterval(record);
      return { set, record, dueAt, due: dueAt <= now, index };
    }).sort((left, right) => (
      Number(right.due) - Number(left.due)
      || left.record.lastScore / left.record.lastMaxScore - right.record.lastScore / right.record.lastMaxScore
      || left.dueAt - right.dueAt
      || left.record.lastAttemptAt - right.record.lastAttemptAt
      || left.set.id.localeCompare(right.set.id)
      || left.index - right.index
    ))[0].set;
  }

  function normalizeState(state) {
    const target = state && typeof state === 'object' ? state : {};
    target.m = target.m || { ok: 0, tot: 0 };
    target.tf = target.tf || { ok: 0, tot: 0 };
    target.iq = target.iq || { ok: 0, tot: 0 };
    target.done = Math.max(0, Number(target.done) || 0);
    return target;
  }

  function summary(state) {
    const value = normalizeState(state);
    const correct = value.m.ok + value.tf.ok + value.iq.ok;
    const total = value.m.tot + value.tf.tot + value.iq.tot;
    return {
      correct,
      total,
      accuracy: total ? Math.round(correct / total * 100) : 0,
      completed: value.done,
    };
  }

  function permutation(size, random = Math.random) {
    const indexes = Array.from({ length: Math.max(0, size) }, (_, index) => index);
    for (let index = indexes.length - 1; index > 0; index -= 1) {
      const swapIndex = Math.floor(random() * (index + 1));
      [indexes[index], indexes[swapIndex]] = [indexes[swapIndex], indexes[index]];
    }
    const inverse = [];
    indexes.forEach((original, shuffled) => {
      inverse[original] = shuffled;
    });
    return { indexes, inverse };
  }

  function shuffleMatching(set, random = Math.random) {
    const order = permutation(set.st.length, random);
    return {
      ...set,
      st: order.indexes.map((index) => set.st[index]),
      sp: set.sp.slice(),
      a: set.a.map((answer) => order.inverse[answer]),
      k: set.k.slice(),
      evidence: Array.isArray(set.evidence)
        ? set.evidence.map((item) => ({ ...item, statementIndex: order.inverse[item.statementIndex] }))
        : set.evidence,
    };
  }

  function selectUnique(selection, index, value) {
    return selection.map((current, currentIndex) => (
      currentIndex === index ? value : (current === value ? null : current)
    ));
  }

  function scoreSelections(selection, answers) {
    return answers.reduce((score, answer, index) => score + (selection[index] === answer ? 1 : 0), 0);
  }

  function scoreExam(exam) {
    const matching = scoreSelections(exam.selM, exam.m.a);
    const trueFalse = scoreSelections(exam.selT, exam.tf.st.map((item) => item.a));
    const interview = scoreSelections(exam.selI, exam.iq.qs.map((question) => question.a));
    return { matching, trueFalse, interview, total: matching + trueFalse + interview };
  }

  function examEvidenceSlices(scores, durationMs) {
    const matchingMax = Math.max(1, Number(scores?.matchingMax) || 4);
    const detailMax = Math.max(1,
      (Number(scores?.trueFalseMax) || 5) + (Number(scores?.interviewMax) || 4));
    return splitLearningActivityDuration([
      {
        activityId: listeningActivityId('matching'),
        score: Number(scores?.matching) || 0,
        maxScore: matchingMax,
      },
      {
        activityId: listeningActivityId('detail'),
        score: (Number(scores?.trueFalse) || 0) + (Number(scores?.interview) || 0),
        maxScore: detailMax,
      },
    ], durationMs);
  }

  function registerPlay(plays, stage, limit = 2) {
    if (!Array.isArray(plays) || plays[stage] >= limit) return false;
    plays[stage] = (Number(plays[stage]) || 0) + 1;
    return true;
  }

  global.EasyBoostListening = Object.freeze({
    normalizeState,
    summary,
    permutation,
    shuffleMatching,
    selectUnique,
    scoreSelections,
    scoreExam,
    activityId: listeningActivityId,
    examEvidenceSlices,
    sourceOf: learningActivitySource,
    registerPlay,
    pool: learningActivityPool,
    normalizeHistory,
    recordCatalogAttempt,
    rememberCatalogSelection,
    selectCatalogSet,
    catalogAttemptIsAssisted,
  });
})(window);
