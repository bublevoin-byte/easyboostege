(function initializeReadingModule(global) {
  'use strict';

  function normalizeState(state) {
    const target = state && typeof state === 'object' ? state : {};
    target.h = target.h || { ok: 0, tot: 0 };
    target.q = target.q || { ok: 0, tot: 0 };
    target.g = target.g || { ok: 0, tot: 0 };
    target.texts = Math.max(0, Number(target.texts) || 0);
    return target;
  }

  function summary(state) {
    const value = normalizeState(state);
    const correct = value.h.ok + value.q.ok + value.g.ok;
    const total = value.h.tot + value.q.tot + value.g.tot;
    return {
      correct,
      total,
      accuracy: total ? Math.round(correct / total * 100) : 0,
      texts: value.texts,
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

  function shuffleHeadings(set, random = Math.random) {
    const order = permutation(set.hl.length, random);
    return {
      hl: order.indexes.map((index) => set.hl[index]),
      txts: set.txts.map((text) => ({ ...text, a: order.inverse[text.a] })),
    };
  }

  function shuffleGaps(set, random = Math.random) {
    const order = permutation(set.fr.length, random);
    return {
      tx: set.tx.slice(),
      fr: order.indexes.map((index) => set.fr[index]),
      a: set.a.map((answer) => order.inverse[answer]),
      k: set.k.slice(),
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

  function scoreQuestions(questions, answers) {
    return questions.reduce((score, question, index) => score + (answers[index] === question.a ? 1 : 0), 0);
  }

  function scoreExam(exam) {
    const headings = scoreSelections(exam.selH, exam.h.txts.map((text) => text.a));
    const gaps = scoreSelections(exam.selG, exam.g.a);
    const questions = scoreQuestions(exam.q.qs, exam.ansQ);
    return { headings, gaps, questions, total: headings + gaps + questions };
  }

  function pool(base, generated) {
    return (base || []).concat(generated || []);
  }

  global.EasyBoostReading = Object.freeze({
    normalizeState,
    summary,
    permutation,
    shuffleHeadings,
    shuffleGaps,
    selectUnique,
    scoreSelections,
    scoreQuestions,
    scoreExam,
    pool,
  });
})(window);
