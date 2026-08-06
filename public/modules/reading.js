import { learningActivityPool, learningActivitySource, readingActivityId, splitLearningActivityDuration } from '../learning-activity-contract.js';
import {
  READING_CATALOG_ID,
  READING_KINDS,
  READING_KIND_RULES,
  adaptLegacyReadingFallback,
  assertReadingCatalog,
  assertReadingSet,
  loadReadingCatalog,
  readingSetForLegacyScreen,
  readingSetReference,
} from '../reading-catalog-contract.js';
import {
  assembleReadingPilotCatalog,
  loadReadingPilotCatalog,
  loadReadingTask10Shard,
  loadReadingTask11Shard,
  loadReadingTask12Shard,
} from '../reading-pilot-v1.js';

(function initializeReadingModule(global) {
  'use strict';

  const HISTORY_VERSION = 2;
  const HISTORY_LIMIT = 200;
  const SUBMISSION_LIMIT = 100;
  const FULL_ATTEMPT_VERSION = 1;
  const DAY_MS = 86_400_000;
  const KINDS = READING_KINDS;
  const SAFE_OWNER_ID = /^[^\s][^\r\n]{0,127}$/u;
  const SAFE_ATTEMPT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
  const ALLOWED_SOURCES = new Set(['catalog', 'generated', 'legacy', 'adaptive', 'manual', 'full']);
  const KIND_OPERATIONS = Object.freeze({
    task10: Object.freeze({
      composite: true,
      extract: (set) => ({ answers: set.task.answers, evidence: set.task.evidence }),
      officialScore: (rawScore) => Math.max(0, 3 - (7 - rawScore)),
      position: (index) => String.fromCharCode(65 + index),
      review: (set, correctAnswers, index) => ({ sourceText: set.task.texts[index].text }),
    }),
    task11: Object.freeze({
      composite: true,
      extract: (set) => ({ answers: set.task.answers, evidence: set.task.evidence }),
      officialScore: (rawScore) => Math.max(0, 2 - (6 - rawScore)),
      position: (index) => String.fromCharCode(65 + index),
      review: (set, correctAnswers, index) => ({
        leftContext: set.task.segments[index],
        rightContext: set.task.segments[index + 1],
        fragment: set.task.fragments[correctAnswers[index]],
      }),
    }),
    task12_18: Object.freeze({
      composite: false,
      extract: (set) => ({
        answers: set.task.questions.map((question) => question.answer),
        evidence: set.task.questions.map((question) => question.evidence),
      }),
      officialScore: (rawScore) => rawScore,
      position: (index) => index + 12,
      review: (set, correctAnswers, index) => ({
        prompt: set.task.questions[index].prompt,
        options: set.task.questions[index].options.slice(),
      }),
    }),
  });

  function ownerIdOf(ownerId) {
    if (typeof ownerId !== 'string' || !SAFE_OWNER_ID.test(ownerId)) {
      throw new TypeError('ownerId must be a non-empty bounded string');
    }
    return ownerId;
  }

  function boundedInteger(value, maximum = 9_000_000_000_000) {
    const number = Math.round(Number(value));
    return Number.isFinite(number) ? Math.min(maximum, Math.max(0, number)) : 0;
  }

  function setReference(set) {
    return readingSetReference(set);
  }

  function emptyHistory(ownerId) {
    return { version: HISTORY_VERSION, ownerId: ownerIdOf(ownerId), items: [], submissions: [], lastSelected: {} };
  }

  function normalizedAssistance(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).slice(0, 20).flatMap(([key, raw]) => {
      if (!/^[a-z][a-zA-Z0-9]{0,39}$/u.test(key)) return [];
      if (raw === true) return [[key, true]];
      const count = boundedInteger(raw, 10_000);
      return count ? [[key, count]] : [];
    }));
  }

  function assistanceWasUsed(value) {
    return Object.values(normalizedAssistance(value)).some((item) => item === true || item > 0);
  }

  function normalizeHistoryItem(item) {
    const reference = setReference(item);
    const attempts = boundedInteger(item?.attempts, 10_000);
    const maximum = boundedInteger(item?.maxScore, 1_000_000);
    const attemptedAt = boundedInteger(item?.lastAttemptAt);
    if (!reference || !attempts || !maximum || !attemptedAt) return null;
    const score = Math.min(maximum, boundedInteger(item.score, 1_000_000));
    const firstAttemptAt = boundedInteger(item.firstAttemptAt) || attemptedAt;
    const source = ALLOWED_SOURCES.has(item.source) ? item.source : 'catalog';
    return {
      id: reference.id,
      revision: reference.revision,
      kind: reference.kind,
      attempts,
      score,
      maxScore: maximum,
      durationMs: boundedInteger(item.durationMs),
      firstAttemptAt: Math.min(firstAttemptAt, attemptedAt),
      lastAttemptAt: attemptedAt,
      assistance: normalizedAssistance(item.assistance),
      source,
    };
  }

  function normalizeHistory(ownerId, history) {
    const owner = ownerIdOf(ownerId);
    const normalized = emptyHistory(owner);
    if (!history || history.version !== HISTORY_VERSION || history.ownerId !== owner) return normalized;
    const sourceItems = Array.isArray(history.items)
      ? history.items
      : (history.items && typeof history.items === 'object' ? Object.values(history.items) : []);
    normalized.items = sourceItems.slice(0, 1_000).map(normalizeHistoryItem).filter(Boolean)
      .sort((left, right) => right.lastAttemptAt - left.lastAttemptAt || left.id.localeCompare(right.id))
      .slice(0, HISTORY_LIMIT);
    if (Array.isArray(history.submissions)) {
      const seenSubmissions = new Set();
      normalized.submissions = history.submissions.slice(0, 500).flatMap((submission) => {
        if (!submission || typeof submission !== 'object' || Array.isArray(submission)
          || !SAFE_ATTEMPT_ID.test(submission.id || '') || seenSubmissions.has(submission.id)) return [];
        seenSubmissions.add(submission.id);
        return [{ id: submission.id, recordedAt: boundedInteger(submission.recordedAt) }];
      }).sort((left, right) => right.recordedAt - left.recordedAt || left.id.localeCompare(right.id))
        .slice(0, SUBMISSION_LIMIT);
    }
    if (history.lastSelected && typeof history.lastSelected === 'object' && !Array.isArray(history.lastSelected)) {
      KINDS.forEach((kind) => {
        const reference = setReference(history.lastSelected[kind]);
        if (reference?.kind === kind) {
          normalized.lastSelected[kind] = {
            id: reference.id,
            revision: reference.revision,
            kind,
            selectedAt: boundedInteger(history.lastSelected[kind].selectedAt),
          };
        }
      });
    }
    return normalized;
  }

  function recordAttempt(ownerId, history, set, attempt = {}) {
    const owner = ownerIdOf(ownerId);
    if (set?.recordable === false || set?.provenance === 'legacy') {
      throw new TypeError('technical legacy Reading sets cannot be recorded');
    }
    const reference = setReference(set);
    if (!reference) throw new TypeError('set must have a valid Reading catalog id, revision and kind');
    const maxScore = boundedInteger(attempt.maxScore, 20);
    const score = boundedInteger(attempt.score, 20);
    const attemptedAt = boundedInteger(attempt.attemptedAt);
    const durationMs = boundedInteger(attempt.durationMs);
    const attemptId = String(attempt.attemptId || '');
    if (!SAFE_ATTEMPT_ID.test(attemptId)) throw new TypeError('attemptId must be a safe stable id');
    if (!maxScore || score > maxScore || !attemptedAt) throw new TypeError('attempt score, maxScore and attemptedAt are invalid');
    const source = attempt.source || 'catalog';
    if (!ALLOWED_SOURCES.has(source)) throw new TypeError('attempt source is unknown');
    const next = normalizeHistory(owner, history);
    if (next.submissions.some((submission) => submission.id === attemptId)) return next;
    const previousIndex = next.items.findIndex((item) => item.id === reference.id && item.revision === reference.revision);
    const previous = previousIndex >= 0 ? next.items[previousIndex] : null;
    const assistance = normalizedAssistance(attempt.assistance);
    const item = {
      id: reference.id,
      revision: reference.revision,
      kind: reference.kind,
      attempts: Math.min(10_000, (previous?.attempts || 0) + 1),
      score: Math.min(1_000_000, (previous?.score || 0) + score),
      maxScore: Math.min(1_000_000, (previous?.maxScore || 0) + maxScore),
      durationMs: Math.min(9_000_000_000_000, (previous?.durationMs || 0) + durationMs),
      firstAttemptAt: previous ? Math.min(previous.firstAttemptAt, attemptedAt) : attemptedAt,
      lastAttemptAt: previous ? Math.max(previous.lastAttemptAt, attemptedAt) : attemptedAt,
      assistance: previous && assistanceWasUsed(previous.assistance)
        ? { ...previous.assistance, ...assistance }
        : assistance,
      source,
    };
    if (previousIndex >= 0) next.items.splice(previousIndex, 1);
    next.items.push(item);
    next.items.sort((left, right) => right.lastAttemptAt - left.lastAttemptAt || left.id.localeCompare(right.id));
    next.items = next.items.slice(0, HISTORY_LIMIT);
    next.submissions.unshift({ id: attemptId, recordedAt: attemptedAt });
    next.submissions.sort((left, right) => right.recordedAt - left.recordedAt || left.id.localeCompare(right.id));
    next.submissions = next.submissions.slice(0, SUBMISSION_LIMIT);
    return next;
  }

  function rememberSelection(ownerId, history, kind, set, selectedAt = Date.now()) {
    const owner = ownerIdOf(ownerId);
    const reference = setReference(set);
    if (!KINDS.includes(kind) || !reference || reference.kind !== kind) {
      throw new TypeError('selection kind and set reference must match');
    }
    const next = normalizeHistory(owner, history);
    next.lastSelected[kind] = {
      id: reference.id,
      revision: reference.revision,
      kind,
      selectedAt: boundedInteger(selectedAt),
    };
    return next;
  }

  function smoothedAccuracy(record) {
    return (record.score + 1) / (record.maxScore + 2);
  }

  function dueInterval(record) {
    const accuracy = smoothedAccuracy(record);
    if (assistanceWasUsed(record.assistance) || accuracy < 0.6) return DAY_MS;
    if (accuracy < 0.85) return 3 * DAY_MS;
    return 7 * DAY_MS;
  }

  function selectNextSet(pool, ownerId, history, kind, { now = Date.now(), preferredCefr = null } = {}) {
    const owner = ownerIdOf(ownerId);
    if (!KINDS.includes(kind)) throw new TypeError('Reading kind is unknown');
    const candidates = (Array.isArray(pool) ? pool : []).filter((set) => setReference(set)?.kind === kind);
    if (!candidates.length) return null;
    const normalizedHistory = normalizeHistory(owner, history);
    const previous = normalizedHistory.lastSelected[kind];
    const withoutImmediateRepeat = candidates.length > 1
      ? candidates.filter((set) => set.id !== previous?.id)
      : candidates;
    const alternatives = withoutImmediateRepeat.length ? withoutImmediateRepeat : candidates;
    const eligible = alternatives;
    const records = new Map(normalizedHistory.items.map((item) => [`${item.id}@${item.revision}`, item]));
    const ranked = eligible.map((set) => {
      const reference = setReference(set);
      const record = records.get(reference.key);
      const dueAt = record ? record.lastAttemptAt + dueInterval(record) : 0;
      let tier = 0;
      if (record) {
        if (dueAt <= now) tier = 1;
        else if (record.attempts >= 2 && smoothedAccuracy(record) < 0.7) tier = 2;
        else tier = 3;
      }
      return { set, record, dueAt, tier, preferred: set.cefr === preferredCefr };
    });
    ranked.sort((left, right) => (
      left.tier - right.tier
      || Number(right.preferred) - Number(left.preferred)
      || (left.tier === 1 ? left.dueAt - right.dueAt : 0)
      || (left.tier === 2 ? smoothedAccuracy(left.record) - smoothedAccuracy(right.record) : 0)
      || (left.tier === 3 ? left.record.lastAttemptAt - right.record.lastAttemptAt : 0)
      || left.set.id.localeCompare(right.set.id)
    ));
    return ranked[0].set;
  }

  function selectFullSection(catalog, ownerId, history, options = {}) {
    const owner = ownerIdOf(ownerId);
    if (!catalog || catalog.id !== READING_CATALOG_ID || !Number.isSafeInteger(catalog.revision)) {
      throw new TypeError('catalog version and revision are invalid');
    }
    let nextHistory = normalizeHistory(owner, history);
    const sets = {};
    KINDS.forEach((kind) => {
      const selected = selectNextSet(catalog.sets, owner, nextHistory, kind, options);
      if (!selected) throw new TypeError(`catalog has no ${kind} set`);
      sets[kind] = selected;
      nextHistory = rememberSelection(owner, nextHistory, kind, selected, options.now);
    });
    return { catalogId: catalog.id, catalogRevision: catalog.revision, sets, history: nextHistory };
  }

  function catalogSummary(catalog, ownerId, history, now = Date.now()) {
    const owner = ownerIdOf(ownerId);
    if (!catalog || catalog.id !== READING_CATALOG_ID || !Array.isArray(catalog.sets)) {
      throw new TypeError('catalog is invalid');
    }
    const normalized = normalizeHistory(owner, history);
    const records = new Map(normalized.items.map((item) => [`${item.id}@${item.revision}`, item]));
    const perKind = Object.fromEntries(KINDS.map((kind) => {
      const sets = catalog.sets.filter((set) => setReference(set)?.kind === kind);
      const completed = sets.flatMap((set) => {
        const record = records.get(`${set.id}@${set.revision}`);
        return record ? [record] : [];
      });
      const correct = completed.reduce((total, item) => total + item.score, 0);
      const total = completed.reduce((sum, item) => sum + item.maxScore, 0);
      return [kind, {
        totalSets: sets.length,
        newSets: Math.max(0, sets.length - completed.length),
        completedSets: completed.length,
        weakSets: completed.filter((item) => item.attempts >= 2 && smoothedAccuracy(item) < 0.7).length,
        dueSets: completed.filter((item) => item.lastAttemptAt + dueInterval(item) <= now).length,
        correct,
        total,
        accuracy: total ? Math.round(correct / total * 100) : null,
      }];
    }));
    const recent = normalized.items.slice().sort((left, right) => right.lastAttemptAt - left.lastAttemptAt).slice(0, 2);
    let trend = 'insufficient';
    if (recent.length === 2) {
      const difference = smoothedAccuracy(recent[0]) - smoothedAccuracy(recent[1]);
      trend = difference > 0.05 ? 'up' : (difference < -0.05 ? 'down' : 'steady');
    }
    const attemptedKinds = KINDS.filter((kind) => perKind[kind].total > 0);
    attemptedKinds.sort((left, right) => perKind[left].accuracy - perKind[right].accuracy || left.localeCompare(right));
    return {
      totalSets: catalog.sets.length,
      completedSets: KINDS.reduce((sum, kind) => sum + perKind[kind].completedSets, 0),
      perKind,
      trend,
      weakestKind: attemptedKinds[0] || null,
    };
  }

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
      evidenceSource: set.evidenceSource,
    };
  }

  function shuffleGaps(set, random = Math.random) {
    const order = permutation(set.fr.length, random);
    return {
      tx: set.tx.slice(),
      fr: order.indexes.map((index) => set.fr[index]),
      a: set.a.map((answer) => order.inverse[answer]),
      k: set.k.slice(),
      evidenceSource: set.evidenceSource,
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

  function examEvidenceSlices(scores, durationMs, metadata = {}) {
    const task10 = boundedInteger(scores?.task10 ?? scores?.headings, 7);
    const task11 = boundedInteger(scores?.task11 ?? scores?.gaps, 6);
    const task12 = boundedInteger(scores?.task12_18 ?? scores?.questions, 7);
    const slices = splitLearningActivityDuration([
      {
        activityId: readingActivityId('headings'),
        score: task10,
        maxScore: 7,
      },
      {
        activityId: readingActivityId('detail'),
        score: task11 + task12,
        maxScore: 13,
      },
    ], durationMs);
    if (!Array.isArray(metadata.sets)) return slices;
    const references = metadata.sets.map(setReference).filter(Boolean)
      .map(({ id, revision, kind }) => ({ id, revision, kind }));
    const assisted = assistanceWasUsed(metadata.assistance);
    return slices.map((slice) => ({
      ...slice,
      source: ALLOWED_SOURCES.has(metadata.source) ? metadata.source : 'catalog',
      independent: metadata.complete === true && !assisted,
      sets: references.filter((set) => (
        slice.activityId === readingActivityId('headings') ? set.kind === 'task10' : set.kind !== 'task10'
      )),
      ...(SAFE_ATTEMPT_ID.test(metadata.attemptId || '')
        ? { idempotencyKey: `${metadata.attemptId}:${slice.activityId}` }
        : {}),
    }));
  }

  function reviewRow(set, operation, answers, correctAnswers, evidence, position) {
    const base = {
      id: set.kind === 'task12_18' ? set.task.questions[position].id : `${set.id}.${position + 1}`,
      kind: set.kind,
      position: operation.position(position),
      userAnswer: answers[position] ?? null,
      correctAnswer: correctAnswers[position],
      correct: answers[position] === correctAnswers[position],
      evidence: { ...evidence[position] },
    };
    return { ...base, ...operation.review(set, correctAnswers, position) };
  }

  function scoreSet(set, submittedAnswers) {
    const reference = setReference(set);
    const technicalFallback = set?.recordable === false && set?.provenance === 'legacy'
      && KINDS.includes(set?.kind) && set?.task && typeof set.task === 'object';
    if (!reference && !technicalFallback) throw new TypeError('set must have a valid Reading catalog reference');
    const operation = KIND_OPERATIONS[set.kind];
    const { answers: correctAnswers, evidence } = operation.extract(set);
    const answers = Array.isArray(submittedAnswers) ? submittedAnswers : [];
    const rawMaxScore = technicalFallback
      ? correctAnswers.length
      : READING_KIND_RULES[set.kind].rawMaxScore;
    const rawScore = correctAnswers.reduce((total, answer, position) => (
      total + (answers[position] === answer ? 1 : 0)
    ), 0);
    const tooManyCompositeAnswers = operation.composite && answers.length > rawMaxScore;
    return {
      kind: set.kind,
      rawScore,
      rawMaxScore,
      officialScore: technicalFallback || tooManyCompositeAnswers ? 0 : operation.officialScore(rawScore),
      officialMaxScore: technicalFallback ? 0 : READING_KIND_RULES[set.kind].officialMaxScore,
      review: correctAnswers.map((answer, position) => (
        reviewRow(set, operation, answers, correctAnswers, evidence, position)
      )),
    };
  }

  function answeredFieldCount(answersByKind) {
    return KINDS.reduce((total, kind) => total + (
      Array.isArray(answersByKind?.[kind])
        ? answersByKind[kind].filter((answer) => answer !== null && answer !== undefined).length
        : 0
    ), 0);
  }

  function scoreFullSection(section, answersByKind, {
    durationMs = 0, submitted = false, source = 'catalog', assistance = {}, attemptId = null,
  } = {}) {
    const sets = section?.sets;
    if (!sets || KINDS.some((kind) => !setReference(sets[kind]) || sets[kind].kind !== kind)) {
      throw new TypeError('full Reading section must contain task10, task11 and task12_18');
    }
    if (submitted !== true) {
      return {
        submitted: false,
        answeredFields: answeredFieldCount(answersByKind),
        totalFields: 20,
        officialMaxScore: 12,
        diagnosticMaxScore: 20,
        review: null,
        evidenceSlices: [],
      };
    }
    const perKind = Object.fromEntries(KINDS.map((kind) => [kind, scoreSet(sets[kind], answersByKind?.[kind])]));
    const rawScore = KINDS.reduce((total, kind) => total + perKind[kind].rawScore, 0);
    const officialTotal = KINDS.reduce((total, kind) => total + perKind[kind].officialScore, 0);
    const complete = answeredFieldCount(answersByKind) === 20;
    const evidenceSlices = examEvidenceSlices({
      task10: perKind.task10.rawScore,
      task11: perKind.task11.rawScore,
      task12_18: perKind.task12_18.rawScore,
    }, durationMs, {
      sets: KINDS.map((kind) => sets[kind]), source, assistance, complete, attemptId,
    });
    return {
      submitted: true,
      officialScore: officialTotal,
      officialMaxScore: 12,
      rawScore,
      rawMaxScore: 20,
      durationMs: boundedInteger(durationMs),
      perKind,
      review: KINDS.flatMap((kind) => perKind[kind].review),
      evidenceSlices,
    };
  }

  function submitFullAttempt(ownerId, history, attempt, answersByKind, {
    durationMs = 0, submittedAt = Date.now(), source = 'catalog', assistance = {},
  } = {}) {
    const owner = ownerIdOf(ownerId);
    if (!attempt || !SAFE_ATTEMPT_ID.test(attempt.id || '') || (attempt.ownerId && attempt.ownerId !== owner)) {
      throw new TypeError('full attempt id and owner are invalid');
    }
    if (KINDS.some((kind) => (
      attempt.section?.sets?.[kind]?.recordable === false
      || attempt.section?.sets?.[kind]?.provenance === 'legacy'
    ))) throw new TypeError('technical legacy Reading sets cannot be submitted or recorded');
    const normalizedHistory = normalizeHistory(owner, history);
    const recordIds = Object.fromEntries(KINDS.map((kind) => [kind, `${attempt.id}:${kind}`]));
    const duplicate = KINDS.every((kind) => (
      normalizedHistory.submissions.some((submission) => submission.id === recordIds[kind])
    ));
    const result = scoreFullSection(attempt.section, answersByKind, {
      durationMs, submitted: true, source, assistance, attemptId: attempt.id,
    });
    if (duplicate) return { duplicate: true, history: normalizedHistory, result: { ...result, evidenceSlices: [] } };

    const durations = splitLearningActivityDuration(KINDS.map((kind) => ({
      kind, maxScore: READING_KIND_RULES[kind].rawMaxScore,
    })), durationMs);
    let nextHistory = normalizedHistory;
    KINDS.forEach((kind, index) => {
      nextHistory = recordAttempt(owner, nextHistory, attempt.section.sets[kind], {
        attemptId: recordIds[kind],
        score: result.perKind[kind].rawScore,
        maxScore: result.perKind[kind].rawMaxScore,
        durationMs: durations[index].durationMs,
        attemptedAt: submittedAt,
        source,
        assistance,
      });
    });
    return { duplicate: false, history: nextHistory, result };
  }

  function emptyTotals() {
    return Object.fromEntries(KINDS.map((kind) => [kind, { correct: 0, total: 0 }]));
  }

  function normalizedTotal(value) {
    const total = boundedInteger(value?.total ?? value?.tot, 1_000_000);
    return {
      correct: Math.min(total, boundedInteger(value?.correct ?? value?.ok, 1_000_000)),
      total,
    };
  }

  function migrateLegacyState(ownerId, state) {
    const owner = ownerIdOf(ownerId);
    if (state?.version === HISTORY_VERSION && state.ownerId !== owner) {
      return {
        version: HISTORY_VERSION, ownerId: owner, totals: emptyTotals(), completedSets: 0,
        legacyFullSections: { attempts: 0, bestScore: 0, maxScore: 11 },
        history: emptyHistory(owner),
      };
    }
    const currentTotals = state?.version === HISTORY_VERSION ? state.totals : null;
    const totals = {
      task10: normalizedTotal(currentTotals?.task10 || state?.h),
      task11: normalizedTotal(currentTotals?.task11 || state?.g),
      task12_18: normalizedTotal(currentTotals?.task12_18 || state?.q),
    };
    return {
      version: HISTORY_VERSION,
      ownerId: owner,
      totals,
      completedSets: boundedInteger(state?.completedSets ?? state?.texts, 1_000_000),
      legacyFullSections: {
        attempts: boundedInteger(state?.legacyFullSections?.attempts ?? state?.readExam?.n, 1_000_000),
        bestScore: boundedInteger(state?.legacyFullSections?.bestScore ?? state?.readExam?.best, 11),
        maxScore: 11,
      },
      history: normalizeHistory(owner, state?.history),
    };
  }

  function snapshotAnswers(kind, answers) {
    const length = READING_KIND_RULES[kind].rawMaxScore;
    const maximum = READING_KIND_RULES[kind].answerUpperBound;
    return Array.from({ length }, (_, index) => {
      const answer = answers?.[index];
      return Number.isSafeInteger(answer) && answer >= 0 && answer <= maximum ? answer : null;
    });
  }

  function serializeFullAttempt(attempt) {
    const owner = ownerIdOf(attempt?.ownerId);
    if (typeof attempt?.id !== 'string' || !attempt.id.trim() || attempt.id.length > 160) {
      throw new TypeError('attempt id must be a non-empty bounded string');
    }
    const section = attempt.section;
    if (section?.catalogId !== READING_CATALOG_ID || !Number.isSafeInteger(section.catalogRevision)
      || section.catalogRevision < 1) throw new TypeError('attempt catalog version and revision are invalid');
    const sets = KINDS.map((kind) => {
      const reference = setReference(section.sets?.[kind]);
      if (!reference || reference.kind !== kind) throw new TypeError(`attempt is missing ${kind}`);
      return { id: reference.id, revision: reference.revision, kind };
    });
    return {
      version: FULL_ATTEMPT_VERSION,
      id: attempt.id,
      ownerId: owner,
      catalogId: section.catalogId,
      catalogRevision: section.catalogRevision,
      sets,
      answers: Object.fromEntries(KINDS.map((kind) => [kind, snapshotAnswers(kind, attempt.answers?.[kind])])),
      currentKind: KINDS.includes(attempt.currentKind) ? attempt.currentKind : 'task10',
      currentPosition: boundedInteger(attempt.currentPosition, 6),
      startedAt: boundedInteger(attempt.startedAt),
      durationMs: boundedInteger(attempt.durationMs),
    };
  }

  function restoreFullAttempt(snapshot, catalog, ownerId) {
    const owner = ownerIdOf(ownerId);
    if (!snapshot || snapshot.version !== FULL_ATTEMPT_VERSION) return { ok: false, reason: 'attempt-version-mismatch' };
    if (snapshot.ownerId !== owner) return { ok: false, reason: 'owner-mismatch' };
    if (snapshot.catalogId !== catalog?.id) return { ok: false, reason: 'catalog-version-mismatch' };
    if (snapshot.catalogRevision !== catalog?.revision) return { ok: false, reason: 'catalog-revision-mismatch' };
    if (!Array.isArray(catalog.sets) || !Array.isArray(snapshot.sets) || snapshot.sets.length !== 3) {
      return { ok: false, reason: 'set-revision-mismatch' };
    }
    const sets = {};
    for (const kind of KINDS) {
      const saved = snapshot.sets.find((set) => set?.kind === kind);
      const current = catalog.sets.find((set) => set?.id === saved?.id);
      if (!saved || !current || current.revision !== saved.revision || current.kind !== kind) {
        return { ok: false, reason: 'set-revision-mismatch' };
      }
      sets[kind] = current;
    }
    return {
      ok: true,
      attempt: {
        id: snapshot.id,
        ownerId: owner,
        section: { catalogId: catalog.id, catalogRevision: catalog.revision, sets },
        answers: Object.fromEntries(KINDS.map((kind) => [kind, snapshotAnswers(kind, snapshot.answers?.[kind])])),
        currentKind: KINDS.includes(snapshot.currentKind) ? snapshot.currentKind : 'task10',
        currentPosition: boundedInteger(snapshot.currentPosition, 6),
        startedAt: boundedInteger(snapshot.startedAt),
        durationMs: boundedInteger(snapshot.durationMs),
      },
    };
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
    activityId: readingActivityId,
    examEvidenceSlices,
    sourceOf: learningActivitySource,
    pool: learningActivityPool,
    validateCatalog: assertReadingCatalog,
    validateSet: assertReadingSet,
    loadCatalog: loadReadingCatalog,
    adaptSet: readingSetForLegacyScreen,
    adaptLegacyFallback: adaptLegacyReadingFallback,
    assembleCatalog: assembleReadingPilotCatalog,
    loadPilotCatalog: loadReadingPilotCatalog,
    loadTask10Shard: loadReadingTask10Shard,
    loadTask11Shard: loadReadingTask11Shard,
    loadTask12Shard: loadReadingTask12Shard,
    normalizeHistory,
    recordAttempt,
    rememberSelection,
    selectNextSet,
    selectFullSection,
    catalogSummary,
    migrateLegacyState,
    scoreSet,
    scoreFullSection,
    submitFullAttempt,
    serializeFullAttempt,
    restoreFullAttempt,
  });
})(window);
