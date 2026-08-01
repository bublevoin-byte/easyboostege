(function initializeWritingModule(global) {
  'use strict';

  const LIMITS = {
    37: { min: 100, max: 140, range: '100–140', maxScore: 6 },
    38: { min: 200, max: 250, range: '200–250', maxScore: 14 },
  };

  const HISTORY_LIMIT = 30;
  const AVERAGE_WINDOW = 5;

  function limits(task) {
    return LIMITS[task] || LIMITS[38];
  }

  function countWords(text) {
    const value = String(text == null ? '' : text).trim();
    return value ? value.split(/\s+/).filter(Boolean).length : 0;
  }

  // Colour alone must not signal the volume, so each state carries its own wording.
  const COUNT_HINTS = {
    short: 'мало',
    ok: 'в норме',
    over: 'превышение',
  };

  function wordCountStatus(text, task) {
    const bounds = limits(task);
    const count = countWords(text);
    let state = 'short';
    if (count > bounds.max) state = 'over';
    else if (count >= bounds.min) state = 'ok';
    return { count, range: bounds.range, state, ok: state === 'ok', hint: COUNT_HINTS[state] };
  }

  function pool(base, generated) {
    return (base || []).concat(generated || []);
  }

  function currentIndex(index, size) {
    if (!size) return 0;
    return ((Math.floor(Number(index) || 0) % size) + size) % size;
  }

  function current(items, index) {
    const list = items || [];
    return list.length ? list[currentIndex(index, list.length)] : null;
  }

  function draftKey(task, index) {
    return 'd' + task + '_' + (Math.floor(Number(index) || 0));
  }

  function appendWork(works, entry, limit = HISTORY_LIMIT) {
    const history = (works || []).concat([entry]);
    return history.length > limit ? history.slice(-limit) : history;
  }

  function summary(works) {
    const history = works || [];
    if (!history.length) return { count: 0, average: 0 };
    const last = history.slice(-AVERAGE_WINDOW);
    const ratio = last.reduce((total, work) => total + ((Number(work.g) || 0) / (Number(work.m) || 1)), 0);
    return { count: history.length, average: Math.round(ratio / last.length * 100) };
  }

  function reviewTotals(review) {
    const criteria = (review && review.criteria) || [];
    const got = review && review.overall_got != null
      ? Number(review.overall_got)
      : criteria.reduce((total, item) => total + (Number(item.got) || 0), 0);
    const max = review && review.overall_max != null
      ? Number(review.overall_max)
      : criteria.reduce((total, item) => total + (Number(item.max) || 0), 0);
    return { got, max, percent: max ? Math.round(got / max * 100) : 0 };
  }

  function evaluationNotice(scope) {
    if (!scope || scope.truncated !== true) return '';
    return 'Из-за превышения объёма оценены первые ' + Number(scope.evaluatedLimit) + ' слов.';
  }

  /*
   * Section 10.1: the request carries the identifier of the task, the type of work and the answer.
   * The assignment itself lives on the server, so nothing here can change what the answer is
   * marked against.
   */
  function buildPayload(task, topic, answer) {
    return {
      taskType: task === 37 ? 'writing_37' : 'writing_38',
      taskId: String((topic && topic.id) || ''),
      answer: String(answer == null ? '' : answer),
    };
  }

  /* A task delivered by the bank always arrives with its identifier; without one it is unusable,
     because the answer could never be submitted for marking. */
  function normalizeGenerated(task, data, taskId) {
    if (!data) return null;
    const id = String(taskId == null ? (data.id || '') : taskId);
    if (!id) return null;
    if (task === 37) {
      const stimulus = String(data.stim || '');
      const questions = (stimulus.match(/\?/g) || []).length;
      if (!data.from || !stimulus || !data.ask || questions < 3) return null;
      return { id: id, from: String(data.from), stim: stimulus, ask: String(data.ask) };
    }
    const rows = Array.isArray(data.rows) ? data.rows : [];
    if (!data.topic || rows.length < 4 || rows.length > 5) return null;
    const valid = rows.every((row) => Array.isArray(row) && row[0] && Number.isFinite(Number(row[1])) && Number(row[1]) > 0);
    if (!valid) return null;
    return { id: id, topic: String(data.topic), rows: rows.map((row) => [String(row[0]), Number(row[1])]) };
  }

  function localReview(count, task, message) {
    const bounds = limits(task);
    const ok = count >= bounds.min && count <= bounds.max;
    return {
      overall_got: ok ? 1 : 0,
      overall_max: 1,
      verdict: 'Черновая проверка',
      sub: 'ИИ офлайн (' + (message || 'нет сети') + '). Показана базовая проверка — для полного разбора нужен интернет/VPN.',
      criteria: [{ name: 'Объём (' + bounds.range + ' слов)', got: ok ? 1 : 0, max: 1 }],
      errors: [
        {
          title: 'Совет по структуре',
          kind: 'warn',
          note: task === 38
            ? 'Проверь: цель проекта → 2–3 факта из таблицы → 1–2 сравнения → проблема и решение → вывод с мнением.'
            : 'Проверь: приветствие, ответы на 3 вопроса, 3 своих вопроса, завершение.',
        },
        {
          title: 'ИИ-разбор',
          kind: 'warn',
          note: 'Полная проверка орфографии и грамматики появится, когда заработает ИИ (VPN/ключ Gemini).',
        },
      ],
    };
  }

  global.EasyBoostWriting = Object.freeze({
    limits,
    countWords,
    wordCountStatus,
    pool,
    currentIndex,
    current,
    draftKey,
    appendWork,
    summary,
    reviewTotals,
    evaluationNotice,
    buildPayload,
    normalizeGenerated,
    localReview,
    HISTORY_LIMIT,
    AVERAGE_WINDOW,
  });
})(window);
