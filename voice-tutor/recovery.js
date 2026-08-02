import crypto from 'node:crypto';

import { normalizeTutorAnswer } from './state-machine.js';

export const RECOVERY_DAY_MS = 86_400_000;
export const REPEAT_WINDOW_MS = RECOVERY_DAY_MS;
export const RECOVERY_STAGES = Object.freeze(['day_1', 'day_7']);

const POINT_CAPS = Object.freeze({
  grammar: 1,
  vocabulary: 1,
  reading: 1,
  listening: 1,
  writing: 2,
  speaking: 2,
});

const MODULE_REPEAT_TASKS = Object.freeze({
  grammar: Object.freeze({
    day_1: Object.freeze({ prompt: 'Two days ago, Maria _____ home early. (COME)', answers: Object.freeze(['came']) }),
    day_7: Object.freeze({ prompt: 'Last month, they _____ their new teacher. (MEET)', answers: Object.freeze(['met']) }),
  }),
  vocabulary: Object.freeze({
    day_1: Object.freeze({ prompt: 'Complete: The course gave me practical _____ I can use at work.', answers: Object.freeze(['experience']) }),
    day_7: Object.freeze({ prompt: 'Complete: Her calm response made a positive _____ on the team.', answers: Object.freeze(['impression']) }),
  }),
  reading: Object.freeze({
    day_1: Object.freeze({ prompt: 'Text: “The museum closes at five on Saturdays.” When does it close on Saturdays?', answers: Object.freeze(['at five', 'five']) }),
    day_7: Object.freeze({ prompt: 'Text: “Rain was forecast, so Maya moved the picnic indoors.” Why did Maya move it indoors?', answers: Object.freeze(['because rain was forecast', 'rain was forecast']) }),
  }),
  listening: Object.freeze({
    day_1: Object.freeze({ prompt: 'Transcript: “Our lesson begins at half past ten.” When does the lesson begin?', answers: Object.freeze(['at half past ten', 'half past ten', '10:30']) }),
    day_7: Object.freeze({ prompt: 'Transcript: “Leo walked home because the last bus had left.” Why did Leo walk home?', answers: Object.freeze(['because the last bus had left', 'the last bus had left']) }),
  }),
});

const SKILL_REPEAT_TASKS = Object.freeze({
  'ege.grammar.future_passive': Object.freeze({
    day_1: Object.freeze({ prompt: 'The test results _____ tomorrow. (PUBLISH)', answers: Object.freeze(['will be published']) }),
    day_7: Object.freeze({ prompt: 'The new rules _____ next September. (INTRODUCE)', answers: Object.freeze(['will be introduced']) }),
  }),
});

const REVIEW_REPEAT_TASKS = Object.freeze({
  communicative: Object.freeze({
    day_1: Object.freeze({ prompt: 'Add an example marker: “Volunteering develops useful skills. _____, it teaches teamwork.”', answers: Object.freeze(['for example']) }),
    day_7: Object.freeze({ prompt: 'Add a result marker: “The course includes weekly practice. _____, students gain confidence.”', answers: Object.freeze(['as a result']) }),
  }),
  organization: Object.freeze({
    day_1: Object.freeze({ prompt: 'Complete the contrast: “The task was difficult. _____, I completed it.”', answers: Object.freeze(['nevertheless']) }),
    day_7: Object.freeze({ prompt: 'Complete the closing sentence: “_____, regular practice is the best choice.”', answers: Object.freeze(['in conclusion']) }),
  }),
  language: Object.freeze({
    day_1: Object.freeze({ prompt: 'Complete: “There are three _____ in the picture.” (PERSON)', answers: Object.freeze(['people']) }),
    day_7: Object.freeze({ prompt: 'Complete: “Yesterday she _____ the exhibition.” (VISIT)', answers: Object.freeze(['visited']) }),
  }),
  lexicon: Object.freeze({
    day_1: Object.freeze({ prompt: 'Complete the collocation: “_____ responsibility for the result.”', answers: Object.freeze(['take']) }),
    day_7: Object.freeze({ prompt: 'Complete the collocation: “_____ attention to the instructions.”', answers: Object.freeze(['pay']) }),
  }),
  grammar: Object.freeze({
    day_1: Object.freeze({ prompt: 'Complete: “The community centre _____ in 2019.” (BUILD)', answers: Object.freeze(['was built']) }),
    day_7: Object.freeze({ prompt: 'Complete: “Online practice is _____ than memorising one answer.” (USEFUL)', answers: Object.freeze(['more useful']) }),
  }),
  spelling: Object.freeze({
    day_1: Object.freeze({ prompt: 'Write the correct English word: «успешный».', answers: Object.freeze(['successful']) }),
    day_7: Object.freeze({ prompt: 'Write the correct English word: «жильё».', answers: Object.freeze(['accommodation']) }),
  }),
  reading_aloud: Object.freeze({
    day_1: Object.freeze({ prompt: 'Type the sentence without omissions: “The gallery opens at eleven on Mondays.”', answers: Object.freeze(['the gallery opens at eleven on mondays']) }),
    day_7: Object.freeze({ prompt: 'Type the sentence without omissions: “Visitors can book tickets online in advance.”', answers: Object.freeze(['visitors can book tickets online in advance']) }),
  }),
  direct_questions: Object.freeze({
    day_1: Object.freeze({ prompt: 'Ask a correct direct question about the duration of the tour.', answers: Object.freeze(['how long does the tour last']) }),
    day_7: Object.freeze({ prompt: 'Ask a correct direct question about contacting the organiser.', answers: Object.freeze(['how can i contact the organiser', 'how can i contact the organizer']) }),
  }),
  extended_answer: Object.freeze({
    day_1: Object.freeze({ prompt: 'Add a result: “Team sports improve communication. _____, players learn to cooperate.”', answers: Object.freeze(['therefore']) }),
    day_7: Object.freeze({ prompt: 'Add an example: “Daily English practice is useful. _____, learners can describe their day aloud.”', answers: Object.freeze(['for instance']) }),
  }),
});

const REVIEW_SKILL_FAMILIES = Object.freeze({
  'ege.writing.writing_37.criterion.1': 'communicative',
  'ege.writing.writing_37.criterion.2': 'organization',
  'ege.writing.writing_37.criterion.3': 'language',
  'ege.writing.writing_38.criterion.1': 'communicative',
  'ege.writing.writing_38.criterion.2': 'organization',
  'ege.writing.writing_38.criterion.3': 'lexicon',
  'ege.writing.writing_38.criterion.4': 'grammar',
  'ege.writing.writing_38.criterion.5': 'spelling',
  'ege.speaking.1.criterion.1': 'reading_aloud',
  'ege.speaking.2.criterion.1': 'direct_questions',
  'ege.speaking.2.criterion.2': 'direct_questions',
  'ege.speaking.2.criterion.3': 'direct_questions',
  'ege.speaking.2.criterion.4': 'direct_questions',
  'ege.speaking.3.criterion.1': 'extended_answer',
  'ege.speaking.3.criterion.2': 'extended_answer',
  'ege.speaking.3.criterion.3': 'extended_answer',
  'ege.speaking.3.criterion.4': 'extended_answer',
  'ege.speaking.3.criterion.5': 'extended_answer',
  'ege.speaking.4.criterion.1': 'communicative',
  'ege.speaking.4.criterion.2': 'organization',
  'ege.speaking.4.criterion.3': 'language',
});

function reviewTaskFamily(skillId) {
  return REVIEW_SKILL_FAMILIES[skillId] || null;
}

export class VoiceTutorRecoveryError extends Error {
  constructor(code) {
    super(code);
    this.name = 'VoiceTutorRecoveryError';
    this.code = code;
  }
}

function bounded(value, maximum, code = 'VOICE_TUTOR_RECOVERY_INVALID') {
  const text = String(value ?? '').trim();
  if (!text || text.length > maximum) throw new VoiceTutorRecoveryError(code);
  return text;
}

function deterministicUuid(value) {
  const chars = crypto.createHash('sha256').update(value).digest('hex').slice(0, 32).split('');
  chars[12] = '5';
  chars[16] = ['8', '9', 'a', 'b'][Number.parseInt(chars[16], 16) % 4];
  const compact = chars.join('');
  return `${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-${compact.slice(16, 20)}-${compact.slice(20)}`;
}

function iso(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new VoiceTutorRecoveryError('VOICE_TUTOR_RECOVERY_INVALID');
  return date.toISOString();
}

export function recoveryPotentialPoints(capsule) {
  const cap = POINT_CAPS[capsule?.module] || 0;
  const loss = Number(capsule?.error?.lost_points);
  return Math.max(0, Math.min(cap, Number.isFinite(loss) && loss > 0 ? Math.ceil(loss) : cap));
}

export function createRecoveryOutcome({ sessionId, capsule, pedagogicalState, observedAt }) {
  if (!capsule || !pedagogicalState || pedagogicalState.transfer_passed == null) {
    throw new VoiceTutorRecoveryError('VOICE_TUTOR_RECOVERY_EVENT_INVALID');
  }
  const skillId = bounded(capsule.skill?.id, 120);
  if (!/^[a-z0-9][a-z0-9._-]{2,119}$/u.test(skillId)) throw new VoiceTutorRecoveryError('VOICE_TUTOR_RECOVERY_INVALID');
  const module = bounded(capsule.module, 24);
  if (!Object.hasOwn(POINT_CAPS, module)) throw new VoiceTutorRecoveryError('VOICE_TUTOR_RECOVERY_INVALID');
  const observed = iso(observedAt);
  const id = deterministicUuid(`voice-recovery:${sessionId}`);
  return Object.freeze({
    id,
    session_id: bounded(sessionId, 64),
    skill_id: skillId,
    skill_label: bounded(capsule.skill?.label, 160),
    module,
    rule_id: bounded(capsule.rule?.id, 160),
    origin_item_id: bounded(capsule.item?.id, 160),
    origin_transfer_task_id: bounded(capsule.checks?.transfer_task?.id, 160),
    initial_micro_check_passed: pedagogicalState.micro_check_passed === true,
    initial_transfer_passed: pedagogicalState.transfer_passed === true,
    terminal_outcome: pedagogicalState.outcome === 'resolved' ? 'resolved' : 'fallback',
    potential_ege_points: recoveryPotentialPoints(capsule),
    observed_at: observed,
  });
}

export function repeatTaskFor(recovery, stage) {
  if (!RECOVERY_STAGES.includes(stage)) throw new VoiceTutorRecoveryError('VOICE_TUTOR_REPEAT_INVALID');
  const family = reviewTaskFamily(recovery.skill_id);
  const source = SKILL_REPEAT_TASKS[recovery.skill_id]?.[stage]
    || (family ? REVIEW_REPEAT_TASKS[family]?.[stage] : null)
    || (!['writing', 'speaking'].includes(recovery.module) ? MODULE_REPEAT_TASKS[recovery.module]?.[stage] : null);
  if (!source) throw new VoiceTutorRecoveryError('VOICE_TUTOR_REPEAT_TASK_UNAVAILABLE');
  const taskId = `voice-repeat.${bounded(recovery.id, 64, 'VOICE_TUTOR_REPEAT_INVALID')}.${stage}.v1`;
  if (taskId === recovery.origin_item_id || taskId === recovery.origin_transfer_task_id) {
    throw new VoiceTutorRecoveryError('VOICE_TUTOR_REPEAT_SAME_ITEM');
  }
  return { id: taskId, prompt: source.prompt, answers: [...source.answers] };
}

export function createRecoveryRepeats(recovery) {
  const origin = new Date(recovery.observed_at).getTime();
  return RECOVERY_STAGES.map((stage, index) => {
    const dayOffset = index === 0 ? 1 : 7;
    const dueAt = new Date(origin + dayOffset * RECOVERY_DAY_MS);
    const task = repeatTaskFor(recovery, stage);
    return Object.freeze({
      id: deterministicUuid(`voice-repeat:${recovery.id}:${stage}`),
      recovery_id: recovery.id,
      stage,
      task_id: task.id,
      due_at: dueAt.toISOString(),
      window_ends_at: new Date(dueAt.getTime() + REPEAT_WINDOW_MS).toISOString(),
      superseded_at: null,
    });
  });
}

export function repeatAnswerMatches(recovery, repeat, answer) {
  const normalized = normalizeTutorAnswer(answer);
  if (!normalized || normalized.length > 200) throw new VoiceTutorRecoveryError('VOICE_TUTOR_REPEAT_ANSWER_INVALID');
  const task = repeatTaskFor(recovery, repeat.stage);
  return task.answers.some((accepted) => normalizeTutorAnswer(accepted) === normalized);
}

export function createRecoveryLedger({ recoveries = [], repeats = [], attempts = [] } = {}) {
  const recoveryById = new Map(recoveries.map((recovery) => [recovery.id, recovery]));
  const recoveryBySessionId = new Map(recoveries.map((recovery) => [recovery.session_id, recovery]));
  const repeatById = new Map(repeats.map((repeat) => [repeat.id, repeat]));
  const repeatsByRecoveryId = new Map();
  for (const repeat of repeats) {
    const owned = repeatsByRecoveryId.get(repeat.recovery_id) || [];
    owned.push(repeat);
    repeatsByRecoveryId.set(repeat.recovery_id, owned);
  }
  const attemptById = new Map(attempts.map((attempt) => [attempt.id, attempt]));
  const attemptByRepeatId = new Map(attempts.map((attempt) => [attempt.repeat_id, attempt]));
  return Object.freeze({
    recoveries: Object.freeze([...recoveries]),
    recovery(id) { return recoveryById.get(id) || null; },
    recoveryForSession(sessionId) { return recoveryBySessionId.get(sessionId) || null; },
    repeat(id) { return repeatById.get(id) || null; },
    repeatsForRecovery(recoveryId) { return [...(repeatsByRecoveryId.get(recoveryId) || [])]; },
    attempt(id) { return attemptById.get(id) || null; },
    attemptForRepeat(repeatId) { return attemptByRepeatId.get(repeatId) || null; },
    recoveryForRepeat(repeatId) {
      const repeat = repeatById.get(repeatId);
      return repeat ? recoveryById.get(repeat.recovery_id) || null : null;
    },
  });
}

export function planRecoveryFromTransfer({ ledger, username, sessionId, capsule, pedagogicalState, observedAt }) {
  if (ledger.recoveryForSession(sessionId)) return null;
  const recovery = { username, ...createRecoveryOutcome({ sessionId, capsule, pedagogicalState, observedAt }) };
  const supersededRepeatIds = ledger.recoveries
    .filter((entry) => entry.username === username && entry.skill_id === recovery.skill_id)
    .flatMap((entry) => ledger.repeatsForRecovery(entry.id))
    .filter((repeat) => !repeat.superseded_at && !ledger.attemptForRepeat(repeat.id))
    .map((repeat) => repeat.id);
  return Object.freeze({
    recovery,
    repeats: createRecoveryRepeats(recovery),
    supersededRepeatIds: Object.freeze(supersededRepeatIds),
  });
}

export function publicRepeatAttempt(attempt) {
  return {
    id: attempt.id,
    repeat_id: attempt.repeat_id,
    task_id: attempt.task_id,
    passed: Boolean(attempt.passed),
    observed_at: iso(attempt.observed_at),
  };
}

export function planRepeatAttempt({ ledger, username, repeatId, attemptId, taskId, answer, now }) {
  const repeat = ledger.repeat(repeatId);
  const recovery = ledger.recoveryForRepeat(repeatId);
  if (!repeat || !recovery || recovery.username !== username) {
    throw new VoiceTutorRecoveryError('VOICE_TUTOR_REPEAT_NOT_FOUND');
  }
  const fingerprint = repeatAttemptFingerprint({ attemptId, taskId, answer });
  const existingForRepeat = ledger.attemptForRepeat(repeat.id);
  if (existingForRepeat) {
    if (existingForRepeat.id === attemptId && existingForRepeat.fingerprint === fingerprint) {
      return Object.freeze({ created: false, attempt: existingForRepeat, daySevenReschedule: null });
    }
    throw new VoiceTutorRecoveryError('VOICE_TUTOR_REPEAT_ALREADY_ATTEMPTED');
  }
  if (ledger.attempt(attemptId)) throw new VoiceTutorRecoveryError('VOICE_TUTOR_REPEAT_ATTEMPT_CONFLICT');
  if (taskId !== repeat.task_id || taskId === recovery.origin_item_id || taskId === recovery.origin_transfer_task_id) {
    throw new VoiceTutorRecoveryError('VOICE_TUTOR_REPEAT_TASK_MISMATCH');
  }
  if (repeat.superseded_at) throw new VoiceTutorRecoveryError('VOICE_TUTOR_REPEAT_EXPIRED');
  const observedAt = iso(now);
  const instant = new Date(observedAt).getTime();
  if (instant < new Date(repeat.due_at).getTime()) throw new VoiceTutorRecoveryError('VOICE_TUTOR_REPEAT_NOT_DUE');
  const ownedRepeats = ledger.repeatsForRecovery(recovery.id);
  if (repeat.stage === 'day_7') {
    const dayOne = ownedRepeats.find((entry) => entry.stage === 'day_1');
    if (!dayOne || ledger.attemptForRepeat(dayOne.id)?.passed !== true) {
      throw new VoiceTutorRecoveryError('VOICE_TUTOR_REPEAT_OUT_OF_ORDER');
    }
  }
  const attempt = Object.freeze({
    id: attemptId,
    repeat_id: repeat.id,
    task_id: repeat.task_id,
    passed: repeatAnswerMatches(recovery, repeat, answer),
    fingerprint,
    observed_at: observedAt,
  });
  let daySevenReschedule = null;
  if (repeat.stage === 'day_1' && attempt.passed) {
    const daySeven = ownedRepeats.find((entry) => entry.stage === 'day_7');
    const dueAt = new Date(instant + 6 * RECOVERY_DAY_MS);
    if (daySeven && dueAt.getTime() > new Date(daySeven.due_at).getTime()) {
      daySevenReschedule = Object.freeze({
        repeatId: daySeven.id,
        dueAt: dueAt.toISOString(),
        windowEndsAt: new Date(dueAt.getTime() + REPEAT_WINDOW_MS).toISOString(),
      });
    }
  }
  return Object.freeze({ created: true, attempt, daySevenReschedule });
}

export function repeatStatus(repeat, attempt, now) {
  if (attempt) return attempt.passed ? 'passed' : 'failed';
  if (repeat.superseded_at) return 'expired';
  const instant = new Date(now).getTime();
  if (instant < new Date(repeat.due_at).getTime()) return 'upcoming';
  if (instant >= new Date(repeat.window_ends_at).getTime()) return 'overdue';
  return 'due';
}

export function recoveryState(recovery, ledger) {
  const repeats = ledger.repeatsForRecovery(recovery.id);
  const observed = repeats.map((repeat) => ledger.attemptForRepeat(repeat.id));
  if (observed.some((attempt) => attempt?.passed === false)) return 'relapsed';
  if (recovery.initial_transfer_passed && observed.length === RECOVERY_STAGES.length && observed.every((attempt) => attempt?.passed === true)) {
    return 'recovered';
  }
  if (repeats.some((repeat) => repeat.superseded_at)) return 'superseded';
  return 'open';
}

export function publicRepeat(recovery, repeat, ledger, now) {
  const task = repeatTaskFor(recovery, repeat.stage);
  const attempt = ledger.attemptForRepeat(repeat.id);
  return {
    id: repeat.id,
    stage: repeat.stage,
    task_id: repeat.task_id,
    prompt: task.prompt,
    due_at: repeat.due_at,
    window_ends_at: repeat.window_ends_at,
    status: repeatStatus(repeat, attempt, now),
    ...(attempt ? { attempt: { id: attempt.id, passed: attempt.passed, observed_at: attempt.observed_at } } : {}),
  };
}

export function recoveryView(recovery, ledger, now) {
  const ownedRepeats = ledger.repeatsForRecovery(recovery.id);
  return {
    recovery_id: recovery.id,
    skill_id: recovery.skill_id,
    skill_label: recovery.skill_label,
    module: recovery.module,
    rule_id: recovery.rule_id,
    state: recoveryState(recovery, ledger),
    potential_ege_points: recovery.potential_ege_points,
    observed_at: recovery.observed_at,
    initial_micro_check_passed: recovery.initial_micro_check_passed,
    initial_transfer_passed: recovery.initial_transfer_passed,
    repeats: ownedRepeats.map((repeat) => publicRepeat(recovery, repeat, ledger, now)),
  };
}

export function recoveryRate(views) {
  const numerator = views.filter((view) => view.state === 'recovered').length;
  const relapsed = views.filter((view) => view.state === 'relapsed').length;
  const denominator = numerator + relapsed;
  return { numerator, denominator, rate: denominator ? numerator / denominator : 0 };
}

export function recoveryMap({ ledger, access, monthlyUsedSeconds = 0, now }) {
  const allViews = ledger.recoveries.map((recovery) => recoveryView(recovery, ledger, now));
  const latestBySkill = new Map();
  for (const view of allViews.sort((left, right) => left.observed_at.localeCompare(right.observed_at) || left.recovery_id.localeCompare(right.recovery_id))) {
    latestBySkill.set(view.skill_id, view);
  }
  const skills = [...latestBySkill.values()].sort((left, right) => (
    right.potential_ege_points - left.potential_ege_points || left.skill_id.localeCompare(right.skill_id)
  ));
  const dueRepeats = skills.flatMap((skill) => skill.repeats
    .filter((repeat) => repeat.status === 'due' || repeat.status === 'overdue')
    .map((repeat) => ({ ...repeat, skill_id: skill.skill_id, skill_label: skill.skill_label, potential_ege_points: skill.potential_ege_points })))
    .sort((left, right) => (left.status === 'due' ? -1 : 1) - (right.status === 'due' ? -1 : 1)
      || right.potential_ege_points - left.potential_ege_points || left.due_at.localeCompare(right.due_at));
  const summary = {
    open: skills.filter((view) => view.state === 'open').length,
    recovered: skills.filter((view) => view.state === 'recovered').length,
    relapsed: skills.filter((view) => view.state === 'relapsed').length,
    potential_ege_points: skills.filter((view) => view.state !== 'recovered').reduce((sum, view) => sum + view.potential_ege_points, 0),
  };
  const nextSkill = skills.find((view) => view.state !== 'recovered') || null;
  const nextBest = dueRepeats[0]
    ? { type: 'repeat', repeat_id: dueRepeats[0].id, skill_id: dueRepeats[0].skill_id, skill_label: dueRepeats[0].skill_label, potential_ege_points: dueRepeats[0].potential_ege_points }
    : nextSkill
      ? { type: 'skill', skill_id: nextSkill.skill_id, skill_label: nextSkill.skill_label, potential_ege_points: nextSkill.potential_ege_points }
      : null;
  const monthlyRemaining = Math.max(0, Number(access?.voice_tutor?.monthly_remaining_seconds) || 0);
  const monthlyUsed = Math.max(0, Number(monthlyUsedSeconds) || 0);
  return {
    generated_at: iso(now),
    summary,
    error_recovery_rate: recoveryRate(allViews),
    voice_minutes: {
      used_monthly: Math.round((monthlyUsed / 60) * 100) / 100,
      remaining_daily: Math.round((Math.max(0, Number(access?.voice_tutor?.daily_remaining_seconds) || 0) / 60) * 100) / 100,
      remaining_monthly: Math.round((monthlyRemaining / 60) * 100) / 100,
    },
    due_repeats: dueRepeats,
    next_best_review: nextBest,
    skills,
    potential_points_notice: 'Оценочный учебный потенциал Easy Boost, не официальный балл ЕГЭ.',
  };
}

export function recoveryMetrics({
  ledger,
  now,
  billableSeconds = 0,
  sessionCount = 0,
  microCheckPasses = 0,
  microCheckAttempts = 0,
  delivery = {},
  providerErrors = 0,
  costMicrousdPerMinute = 0,
}) {
  const views = ledger.recoveries.map((recovery) => recoveryView(recovery, ledger, now));
  const rate = recoveryRate(views);
  const passMetric = (passed, observed) => ({ passed, observed, rate: observed ? passed / observed : 0 });
  const initialTransferPassed = ledger.recoveries.filter((recovery) => recovery.initial_transfer_passed).length;
  const repeatPassMetric = (stage) => {
    const stageAttempts = views.flatMap((view) => view.repeats)
      .filter((repeat) => repeat.stage === stage && repeat.attempt);
    return passMetric(stageAttempts.filter((repeat) => repeat.attempt.passed).length, stageAttempts.length);
  };
  const deliveryCounts = {
    voice: Math.max(0, Number(delivery.voice) || 0),
    text: Math.max(0, Number(delivery.text) || 0),
    local: Math.max(0, Number(delivery.local) || 0),
  };
  const fallbackCount = deliveryCounts.text + deliveryCounts.local;
  const deliveredSessionCount = deliveryCounts.voice + fallbackCount;
  const safeSessionCount = Math.max(0, Number(sessionCount) || 0);
  const safeBillableSeconds = Math.max(0, Number(billableSeconds) || 0);
  const safeRate = Math.max(0, Number(costMicrousdPerMinute) || 0);
  return {
    open: views.filter((view) => view.state === 'open').length,
    recovered: views.filter((view) => view.state === 'recovered').length,
    relapsed: views.filter((view) => view.state === 'relapsed').length,
    numerator: rate.numerator,
    denominator: rate.denominator,
    error_recovery_rate: rate.rate,
    due_repeats: views.flatMap((view) => view.repeats).filter((repeat) => repeat.status === 'due').length,
    overdue_repeats: views.flatMap((view) => view.repeats).filter((repeat) => repeat.status === 'overdue').length,
    micro_check: passMetric(Math.max(0, Number(microCheckPasses) || 0), Math.max(0, Number(microCheckAttempts) || 0)),
    initial_transfer: passMetric(initialTransferPassed, ledger.recoveries.length),
    repeat_passes: { day_1: repeatPassMetric('day_1'), day_7: repeatPassMetric('day_7') },
    sessions: safeSessionCount,
    voice_minutes: Math.round((safeBillableSeconds / 60) * 100) / 100,
    delivery: deliveryCounts,
    fallback_rate: deliveredSessionCount ? fallbackCount / deliveredSessionCount : 0,
    provider_errors: Math.max(0, Number(providerErrors) || 0),
    estimated_cost_microusd: Math.round((safeBillableSeconds / 60) * safeRate),
  };
}

export function repeatAttemptFingerprint({ attemptId, taskId, answer }) {
  return crypto.createHash('sha256').update(JSON.stringify({ attemptId, taskId, answer: normalizeTutorAnswer(answer) })).digest('hex');
}
