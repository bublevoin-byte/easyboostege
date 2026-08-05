import { learningActivityPool, learningActivitySource, listeningActivityId, splitLearningActivityDuration } from '../learning-activity-contract.js';

(function initializeListeningModule(global) {
  'use strict';

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
  });
})(window);
