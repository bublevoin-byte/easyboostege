const TERMINAL_STATES = new Set(['resolved', 'fallback', 'ended']);

export class VoiceTutorTransitionError extends Error {
  constructor(code = 'VOICE_TUTOR_TRANSITION_INVALID') {
    super(code);
    this.name = 'VoiceTutorTransitionError';
    this.code = code;
  }
}

export function normalizeTutorAnswer(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .toLocaleLowerCase('en')
    .replace(/[’']/gu, '')
    .replace(/\s+/gu, ' ')
    .replace(/[.!?]+$/gu, '')
    .trim();
}

function answerMatches(value, accepted) {
  const normalized = normalizeTutorAnswer(value);
  return normalized.length > 0 && accepted.some((answer) => normalizeTutorAnswer(answer) === normalized);
}

export function initialPedagogicalState() {
  return {
    state: 'diagnose',
    micro_check_passed: null,
    transfer_passed: null,
    outcome: null,
  };
}

export function transitionPedagogicalState(current, event, capsule) {
  const snapshot = { ...initialPedagogicalState(), ...(current || {}) };
  if (TERMINAL_STATES.has(snapshot.state)) return snapshot;
  const type = String(event?.type || '');

  if (type === 'fallback') return { ...snapshot, state: 'fallback', outcome: 'fallback' };
  if (type === 'end') return { ...snapshot, state: 'ended', outcome: 'ended' };
  if (snapshot.state === 'diagnose' && type === 'diagnosis_complete') {
    return { ...snapshot, state: 'explain' };
  }
  if (snapshot.state === 'explain' && type === 'explanation_complete') {
    return { ...snapshot, state: 'micro_check' };
  }
  if (snapshot.state === 'micro_check' && type === 'check_answer') {
    const passed = answerMatches(event.answer, capsule.checks.micro_check.answers);
    return { ...snapshot, state: passed ? 'transfer_task' : 'explain', micro_check_passed: passed };
  }
  if (snapshot.state === 'transfer_task' && type === 'transfer_answer') {
    if (snapshot.micro_check_passed !== true) throw new VoiceTutorTransitionError();
    const passed = answerMatches(event.answer, capsule.checks.transfer_task.answers);
    return {
      ...snapshot,
      state: passed ? 'resolved' : 'fallback',
      transfer_passed: passed,
      outcome: passed ? 'resolved' : 'fallback',
    };
  }
  throw new VoiceTutorTransitionError();
}
