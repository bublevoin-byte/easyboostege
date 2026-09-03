export const SPEAKING_ASSESSMENT_NOT_REQUESTED = 'not_requested';
export const SPEAKING_ASSESSMENT_EVIDENCE_NEEDS_RETRY = 'evidence_needs_retry';

export function speakingAssessmentNotRequested(message) {
  return {
    available: false,
    reason: SPEAKING_ASSESSMENT_NOT_REQUESTED,
    message,
  };
}

export function isSpeakingAssessmentNotRequested(assessment) {
  return assessment?.available === false
    && assessment.reason === SPEAKING_ASSESSMENT_NOT_REQUESTED;
}

export function isSpeakingAssessmentPending(assessment) {
  return assessment?.available === false
    && [SPEAKING_ASSESSMENT_NOT_REQUESTED, SPEAKING_ASSESSMENT_EVIDENCE_NEEDS_RETRY]
      .includes(assessment.reason);
}
