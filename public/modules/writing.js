(function initializeWritingModule(global) {
  'use strict';

  const LIMITS = {
    37: { min: 100, max: 140, range: '100–140', maxScore: 6 },
    38: { min: 200, max: 250, range: '200–250', maxScore: 14 },
  };

  const HISTORY_LIMIT = 30;
  const AVERAGE_WINDOW = 5;
  const CRITERIA = Object.freeze({
    37: Object.freeze([
      Object.freeze(['Решение коммуникативной задачи', 2]),
      Object.freeze(['Организация текста', 2]),
      Object.freeze(['Языковое оформление', 2]),
    ]),
    38: Object.freeze([
      Object.freeze(['Решение коммуникативной задачи', 3]),
      Object.freeze(['Организация текста', 3]),
      Object.freeze(['Лексика', 3]),
      Object.freeze(['Грамматика', 3]),
      Object.freeze(['Орфография и пунктуация', 2]),
    ]),
  });

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

  function selectedTaskType(value) {
    return Number(value) === 37 ? 37 : 38;
  }

  function draftText(value) {
    return typeof value === 'string' ? value : '';
  }

  function sameOwner(left, right) {
    return Boolean(left && right
      && left.username === right.username
      && Number(left.generation) === Number(right.generation));
  }

  function requestIsCurrent(capturedOwner, capturedView, currentOwner, currentView) {
    return sameOwner(capturedOwner, currentOwner)
      && Number.isSafeInteger(capturedView)
      && capturedView === currentView;
  }

  function sameEvaluationPayload(left, right) {
    return Boolean(left && right
      && left.taskType === right.taskType
      && left.taskId === right.taskId
      && left.answer === right.answer);
  }

  function evaluationMayBeInFlight(error = {}) {
    return ['NETWORK_ERROR', 'REQUEST_TIMEOUT', 'TIMEOUT', 'WRITING_EVALUATION_IN_PROGRESS',
      'WRITING_EVALUATION_SETTLEMENT_UNKNOWN', 'WRITING_EVALUATION_RESPONSE_INVALID',
      'WRITING_PROGRESS_UNAVAILABLE', 'WRITING_REPLAY_CONTRACT_UNAVAILABLE']
      .includes(String(error.code || ''));
  }

  const FAILURE_STATES = Object.freeze({
    offline: Object.freeze({
      title: 'Нет связи для проверки',
      description: 'Текст остаётся в редакторе. После подключения сохранённый черновик синхронизируется с аккаунтом; затем повторите отправку.',
      retryable: true,
    }),
    recoverable: Object.freeze({
      title: 'Разбор пока не готов',
      description: 'Сервис проверки временно недоступен. Текст остаётся в редакторе; синхронизация черновика с аккаунтом будет повторена.',
      retryable: true,
    }),
    ambiguous: Object.freeze({
      title: 'Результат ещё не подтверждён',
      description: 'Провайдер мог принять работу. Сначала проверьте статус; новая проверка может повторить платную обработку.',
      retryable: true,
    }),
    superseded: Object.freeze({
      title: 'Эта проверка уже заменена',
      description: 'В другой вкладке был подтверждён повтор этой работы. Вернитесь к редактору: старый ключ больше не запускает проверку.',
      retryable: false,
    }),
    'retry-storage': Object.freeze({
      title: 'Не удалось безопасно начать проверку',
      description: 'Текст остался в редакторе. Локальную запись для безопасного повтора создать не удалось.',
      retryable: false,
    }),
    'retry-storage-full': Object.freeze({
      title: 'Есть незавершённые проверки',
      description: 'Хранилище безопасных повторов заполнено. Можно удалить самую старую запись, понимая, что её неподтверждённый результат восстановить не получится.',
      retryable: false,
    }),
    'progress-pending': Object.freeze({
      title: 'Разбор сохранён, сводка обновляется',
      description: 'Сервер уже сохранил эту проверку. Проверьте статус с тем же черновиком — новая платная обработка не нужна.',
      retryable: true,
    }),
    rate: Object.freeze({
      title: 'Слишком много запросов',
      description: 'Сервис временно ограничил частоту проверок. Текст остаётся в редакторе; попробуйте ещё раз позже.',
      retryable: true,
    }),
    'daily-limit': Object.freeze({
      title: 'Дневной лимит ИИ исчерпан',
      description: 'Новая проверка будет доступна после обновления дневного лимита. Текст остаётся в редакторе.',
      retryable: false,
    }),
    consent: Object.freeze({
      title: 'Нужно согласие на обработку текста',
      description: 'Подтвердите согласие в профиле, затем вернитесь к сохранённому черновику.',
      retryable: false,
    }),
    access: Object.freeze({
      title: 'Нужен активный доступ',
      description: 'Сервер не подтвердил активную подписку. Текст остаётся в редакторе, но проверка не выполнена.',
      retryable: false,
    }),
    'client-update': Object.freeze({
      title: 'Нужно обновить приложение',
      description: 'Текст остаётся в редакторе. Полностью закройте и снова откройте приложение перед повторной проверкой.',
      retryable: false,
    }),
    authority: Object.freeze({
      title: 'Сессия изменилась',
      description: 'Ответ проверки не применён. Войдите снова, чтобы продолжить в правильном аккаунте.',
      retryable: false,
    }),
    'task-mismatch': Object.freeze({
      title: 'Задание больше не совпадает',
      description: 'Сервер не принял идентификатор задания. Текст сохранён; откройте тему заново перед отправкой.',
      retryable: false,
    }),
    validation: Object.freeze({
      title: 'Ответ не принят',
      description: 'Сервер отклонил формат ответа. Текст сохранён — проверьте объём и повторите отправку.',
      retryable: false,
    }),
  });

  function classifyEvaluationFailure(error = {}) {
    const code = String(error.code || 'REQUEST_FAILED');
    const status = Number(error.status) || 0;
    let kind = 'recoverable';
    if (code === 'NETWORK_ERROR') kind = 'offline';
    else if (code === 'REQUEST_TIMEOUT' || code === 'TIMEOUT'
      || code === 'WRITING_EVALUATION_SETTLEMENT_UNKNOWN'
      || code === 'WRITING_EVALUATION_RESPONSE_INVALID'
      || code === 'WRITING_EVALUATION_REPEAT_ACK_NOT_READY') kind = 'ambiguous';
    else if (code === 'WRITING_EVALUATION_REPEAT_ACKNOWLEDGED') kind = 'superseded';
    else if (code === 'WRITING_PROGRESS_UNAVAILABLE'
      || code === 'WRITING_REPLAY_CONTRACT_UNAVAILABLE') kind = 'progress-pending';
    else if (code === 'WRITING_RETRY_STORAGE_FULL') kind = 'retry-storage-full';
    else if (code === 'WRITING_RETRY_STORAGE_UNAVAILABLE'
      || code === 'WRITING_RETRY_LOCK_UNAVAILABLE') kind = 'retry-storage';
    else if (code === 'AI_BUDGET_EXHAUSTED') kind = 'daily-limit';
    else if (code === 'RATE_LIMITED' || status === 429) kind = 'rate';
    else if (code === 'PRIVACY_CONSENT_REQUIRED') kind = 'consent';
    else if (code === 'SUBSCRIPTION_REQUIRED' || status === 402
      || (status === 403 && code !== 'FORBIDDEN')) kind = 'access';
    else if (code === 'CLIENT_UPDATE_REQUIRED' || status === 428) kind = 'client-update';
    else if (code === 'OWNER_CHANGED' || code === 'FORBIDDEN' || status === 401) kind = 'authority';
    else if (code === 'UNKNOWN_TASK' || code === 'TASK_TYPE_MISMATCH') kind = 'task-mismatch';
    else if (code === 'VALIDATION_ERROR' || code === 'WRITING_EVALUATION_IDEMPOTENCY_CONFLICT'
      || code === 'WRITING_EVALUATION_REPEAT_ACK_INVALID'
      || status === 400 || status === 422) kind = 'validation';
    const state = FAILURE_STATES[kind];
    return Object.freeze({
      kind, title: state.title, description: state.description, retryable: state.retryable,
      allowPaidRepeat: kind === 'ambiguous' && code !== 'WRITING_EVALUATION_RESPONSE_INVALID',
    });
  }

  function appendWork(works, entry, limit = HISTORY_LIMIT) {
    const history = (works || []).concat([entry]);
    return history.length > limit ? history.slice(-limit) : history;
  }

  function appendServerWork(works, entry, limit = HISTORY_LIMIT) {
    const history = serverWorks(works);
    const attemptId = Number(entry?.attemptId);
    if (!Number.isSafeInteger(attemptId) || attemptId < 1) return { works: history, added: false };
    if (history.some((work) => Number(work?.attemptId) === attemptId)) return { works: history, added: false };
    return { works: appendWork(history, { ...entry, attemptId }, limit), added: true };
  }

  function serverWorks(works) {
    return (works || []).filter((work) => {
      const attemptId = Number(work && work.attemptId);
      return Number.isSafeInteger(attemptId) && attemptId > 0;
    });
  }

  function summary(works) {
    const history = serverWorks(works);
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

  function plainObject(value) {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value));
  }

  function exactKeys(value, expected) {
    if (!plainObject(value)) return false;
    const keys = Object.keys(value);
    return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
  }

  function validReviewText(value, maximum, { required = true } = {}) {
    return typeof value === 'string' && value.length <= maximum
      && (!required || Boolean(value.trim())) && !/[<>]/u.test(value);
  }

  function validReviewError(error) {
    if (!exactKeys(error, ['title', 'wrong', 'right', 'kind', 'note', 'example'])
      || !validReviewText(error.title, 160)
      || !validReviewText(error.wrong, 500, { required: false })
      || !validReviewText(error.right, 500, { required: false })
      || !['err', 'warn'].includes(error.kind) || !validReviewText(error.note, 1000)
      || !validReviewText(error.example, 500, { required: false })) return false;
    const normalized = (value) => String(value || '').normalize('NFKC').trim().toLocaleLowerCase('en-US');
    const example = normalized(error.example);
    if ((error.kind === 'err' || Boolean(normalized(error.right))) && !example) return false;
    return !example || ![error.wrong, error.right].some((value) => normalized(value) === example);
  }

  function validAuthoritativeWork(work) {
    const maximum = work?.t === 37 ? 6 : work?.t === 38 ? 14 : 0;
    return exactKeys(work, ['attemptId', 't', 'taskId', 'g', 'm', 'n', 'ts'])
      && Number.isSafeInteger(work.attemptId) && work.attemptId > 0
      && maximum && Number.isInteger(work.g) && work.g >= 0 && work.g <= maximum
      && work.m === maximum && Number.isSafeInteger(work.n) && work.n >= 0
      && (work.taskId === null || validReviewText(work.taskId, 120))
      && Number.isSafeInteger(work.ts) && work.ts >= 0;
  }

  function validAuthoritativeProgress(progress, attemptId, taskNumber, taskId, review) {
    if (!exactKeys(progress, ['version', 'attemptCount', 'average', 'works', 'confirmedAttempt'])
      || progress.version !== 'writing-progress-v1'
      || !Number.isSafeInteger(progress.attemptCount) || progress.attemptCount < 1
      || !Number.isInteger(progress.average) || progress.average < 0 || progress.average > 100
      || !Array.isArray(progress.works) || progress.works.length < 1 || progress.works.length > 30
      || progress.works.length !== Math.min(progress.attemptCount, HISTORY_LIMIT)
      || !validReviewText(taskId, 120)) return false;
    const seen = new Set();
    let previous = null;
    for (const work of progress.works) {
      if (!validAuthoritativeWork(work) || seen.has(work.attemptId)) return false;
      if (previous && (work.ts < previous.ts
        || (work.ts === previous.ts && work.attemptId <= previous.attemptId))) return false;
      seen.add(work.attemptId);
      previous = work;
    }
    const recent = progress.works.slice(-AVERAGE_WINDOW);
    const average = Math.round(recent.reduce((total, work) => total + work.g / work.m, 0)
      / recent.length * 100);
    if (progress.average !== average) return false;
    const confirmed = progress.confirmedAttempt;
    return Number.isSafeInteger(attemptId) && attemptId > 0
      && validAuthoritativeWork(confirmed) && confirmed.attemptId === attemptId
      && confirmed.t === taskNumber && confirmed.g === review.overall_got
      && confirmed.m === review.overall_max && confirmed.n === review.words
      && confirmed.taskId === taskId;
  }

  function validEvaluationResponse(response, task, warning, taskId) {
    if (!exactKeys(response, [
      'contractVersion', 'review', 'provider', 'attemptId', 'voiceTutor', 'assessment',
      'evaluationScope', 'writingProgress',
    ]) || response.contractVersion !== 'writing-evaluation-response-v1'
      || !(response.provider === null || validReviewText(response.provider, 80))) return false;
    const taskNumber = selectedTaskType(task);
    const expectedCriteria = CRITERIA[taskNumber];
    const bounds = limits(taskNumber);
    const attemptId = response.attemptId;
    const review = response.review;
    if (!Number.isSafeInteger(attemptId) || attemptId < 1
      || !exactKeys(review, [
        'words', 'in_range', 'overall_got', 'overall_max', 'verdict', 'sub', 'criteria', 'errors',
      ]) || !Number.isSafeInteger(review.words) || review.words < 0 || typeof review.in_range !== 'boolean'
      || !Number.isInteger(review.overall_got) || review.overall_got < 0
      || review.overall_max !== bounds.maxScore || review.overall_got > review.overall_max
      || !validReviewText(review.verdict, 160) || !validReviewText(review.sub, 500)
      || !Array.isArray(review.criteria) || review.criteria.length !== expectedCriteria.length
      || !Array.isArray(review.errors) || review.errors.length > 5
      || !review.errors.every(validReviewError)) return false;
    let total = 0;
    for (let index = 0; index < expectedCriteria.length; index += 1) {
      const criterion = review.criteria[index];
      const [name, maximum] = expectedCriteria[index];
      if (!exactKeys(criterion, ['name', 'got', 'max']) || criterion.name !== name || criterion.max !== maximum
        || !Number.isInteger(criterion.got) || criterion.got < 0 || criterion.got > maximum) return false;
      total += criterion.got;
    }
    if (total !== review.overall_got || (review.criteria[0].got === 0 && total !== 0)) return false;
    const gradableMinimum = Math.round(bounds.min * 0.9);
    const gradableMaximum = Math.round(bounds.max * 1.1);
    if (review.in_range !== (review.words >= gradableMinimum && review.words <= gradableMaximum)) return false;
    if (review.words < gradableMinimum && (review.overall_got !== 0
      || review.criteria.some((criterion) => criterion.got !== 0))) return false;
    const scope = response.evaluationScope;
    const expectedTruncation = scope?.fullWords > gradableMaximum;
    if (!exactKeys(scope, ['fullWords', 'evaluatedWords', 'truncated', 'evaluatedLimit'])
      || !Number.isSafeInteger(scope.fullWords) || scope.fullWords !== review.words
      || !Number.isSafeInteger(scope.evaluatedWords) || scope.evaluatedWords < 0
      || typeof scope.truncated !== 'boolean' || scope.evaluatedLimit !== bounds.max
      || scope.truncated !== expectedTruncation
      || scope.evaluatedWords !== (expectedTruncation ? bounds.max : scope.fullWords)) return false;
    const assessment = response.assessment;
    if (!exactKeys(assessment, ['mode', 'scoreKind', 'warning']) || assessment.mode !== 'experimental'
      || assessment.scoreKind !== 'approximate' || assessment.warning !== warning) return false;
    const voiceTutor = response.voiceTutor;
    if (!exactKeys(voiceTutor, ['source', 'attemptId', 'revision', 'criterionChoices'])
      || voiceTutor.source !== 'writing'
      || voiceTutor.attemptId !== attemptId || voiceTutor.revision !== 1
      || !Array.isArray(voiceTutor.criterionChoices)) return false;
    const expectedChoices = review.criteria.flatMap((criterion, index) => (
      criterion.got < criterion.max ? [{ index, label: criterion.name }] : []
    ));
    if (voiceTutor.criterionChoices.length !== expectedChoices.length) return false;
    for (let index = 0; index < expectedChoices.length; index += 1) {
      const choice = voiceTutor.criterionChoices[index];
      const expected = expectedChoices[index];
      if (!exactKeys(choice, ['index', 'label']) || choice.index !== expected.index
        || choice.label !== expected.label) return false;
    }
    return validAuthoritativeProgress(response.writingProgress, attemptId, taskNumber, taskId, review);
  }

  function evaluationNotice(scope) {
    if (!scope || scope.truncated !== true) return '';
    const boundary = Number(scope.evaluatedLimit);
    return 'Из-за превышения объёма оценён официальный фрагмент у границы ' + boundary
      + ' слов — до целого ' + (boundary === 140 ? 'вопроса' : 'предложения') + '.';
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

  global.EasyBoostWriting = Object.freeze({
    limits,
    countWords,
    wordCountStatus,
    pool,
    currentIndex,
    current,
    draftKey,
    selectedTaskType,
    draftText,
    sameOwner,
    requestIsCurrent,
    sameEvaluationPayload,
    evaluationMayBeInFlight,
    classifyEvaluationFailure,
    appendWork,
    appendServerWork,
    serverWorks,
    summary,
    reviewTotals,
    validEvaluationResponse,
    evaluationNotice,
    buildPayload,
    normalizeGenerated,
    HISTORY_LIMIT,
    AVERAGE_WINDOW,
  });
})(window);
