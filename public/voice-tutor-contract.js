/* Pure, first-load-safe Voice Tutor presentation and authorization contract. */
const browser = globalThis.window || globalThis;

function canStartVoiceTutor(profile = browser.__sub) {
  return profile?.entitlements?.voice_tutor === true;
}

function eventForVoiceTutorState(state, answer = '') {
  if (state === 'diagnose') return { type: 'diagnosis_complete', answer: String(answer) };
  if (state === 'explain') return { type: 'explanation_complete' };
  if (state === 'micro_check') return { type: 'check_answer', answer: String(answer) };
  if (state === 'transfer_task') return { type: 'transfer_answer', answer: String(answer) };
  return null;
}

function escapedButtonLabel(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function voiceTutorButton({
  profile = browser.__sub, source = '', attemptId, revision, criterionChoices,
  pronunciationError,
} = {}) {
  if (!canStartVoiceTutor(profile)) return '';
  const reviewSource = source === 'writing' || source === 'speaking' ? source : '';
  const validAttempt = reviewSource
    ? Number.isSafeInteger(Number(attemptId)) && Number(attemptId) > 0
    : /^[0-9a-f-]{36}$/iu.test(String(attemptId || ''));
  if (!validAttempt || !Number.isInteger(revision) || revision < 1 || revision > 10_000) return '';
  const sourceAttribute = reviewSource ? ` data-source="${reviewSource}"` : '';
  const safeAttemptId = reviewSource ? Number(attemptId) : String(attemptId);
  if (!reviewSource) {
    return `<button type="button" class="voiceTutorTrigger" data-attempt="${safeAttemptId}" data-revision="${revision}" onclick="openVoiceTutorError(this)">Разобрать голосом</button>`;
  }
  if (reviewSource === 'speaking' && pronunciationError != null) {
    const ref = typeof pronunciationError?.ref === 'string' ? pronunciationError.ref.trim() : '';
    const label = typeof pronunciationError?.label === 'string' ? pronunciationError.label.trim() : '';
    if (!/^(?:word|phoneme)\.[0-9]+\.[0-9]+(?:\.[0-9]+)?$/u.test(ref)
      || !ref.startsWith(`word.${safeAttemptId}.`) && !ref.startsWith(`phoneme.${safeAttemptId}.`)
      || !label || label.length > 160) return '';
    return `<button type="button" class="voiceTutorTrigger"${sourceAttribute} data-attempt="${safeAttemptId}" data-revision="${revision}" data-pronunciation-error-ref="${ref}" onclick="openVoiceTutorError(this)">Разобрать: ${escapedButtonLabel(label)}</button>`;
  }
  const seen = new Set();
  const choices = (Array.isArray(criterionChoices) ? criterionChoices : []).filter((choice) => {
    const label = typeof choice?.label === 'string' ? choice.label.trim() : '';
    if (!Number.isInteger(choice?.index) || choice.index < 0 || choice.index > 20
      || !label || label.length > 160 || seen.has(choice.index)) return false;
    seen.add(choice.index);
    return true;
  });
  return choices.map(({ index, label }) => `<button type="button" class="voiceTutorTrigger"${sourceAttribute} data-attempt="${safeAttemptId}" data-revision="${revision}" data-criterion-index="${index}" onclick="openVoiceTutorError(this)">Разобрать: ${escapedButtonLabel(label.trim())}</button>`).join('');
}

function voiceTutorSlotId(itemId) {
  const value = String(itemId || '');
  if (!/^[a-z0-9._-]{4,120}$/u.test(value)) return '';
  return `voice_tutor_result_${value.replaceAll('.', '_')}`;
}

function voiceTutorResultSlot(itemId) {
  const id = voiceTutorSlotId(itemId);
  return id ? `<div id="${id}"></div>` : '';
}

function prepareVoiceTutorContextResult({ module, set, selections } = {}) {
  const questions = set?.qs;
  if (!set?.voice || !Array.isArray(questions) || !Array.isArray(selections)
    || questions.length !== selections.length) return null;
  const answers = questions.map((question, index) => question?.o?.[selections[index]]);
  if (answers.some((answer) => typeof answer !== 'string' || !answer)) return null;
  return {
    module,
    setId: set.voice.id,
    revision: set.voice.revision,
    answers,
    resultSlot(question, index) {
      return question?.voice && selections[index] !== question.a
        ? voiceTutorResultSlot(question.voice.id) : '';
    },
  };
}

export {
  canStartVoiceTutor,
  eventForVoiceTutorState,
  prepareVoiceTutorContextResult,
  voiceTutorButton,
  voiceTutorResultSlot,
  voiceTutorSlotId,
};
