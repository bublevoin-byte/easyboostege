import {
  AUTOMATIC_ASSESSMENT_PUBLIC_CONTRACT,
  EGE_MOCK_WRITING_ASSESSMENT_LABEL,
} from '../shared/automatic-assessment-contract.js';
import {
  EGE_MOCK_ORAL_MAXIMUM_SCORE,
  EGE_MOCK_ORAL_TASKS,
} from '../shared/ege-mock-oral-contract.js';

export const EGE_MOCK_SPEAKING_ASSESSMENT_VERSION = 'ege-mock-speaking-assessment-v1';

function iso(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw Object.assign(new Error('EGE_MOCK_TIME_INVALID'), {
    code: 'EGE_MOCK_TIME_INVALID',
  });
  return date.toISOString();
}

export function beginEgeMockSpeakingAssessment(row, now) {
  if (row.speaking_assessment) return row;
  row.speaking_assessment = {
    version: EGE_MOCK_SPEAKING_ASSESSMENT_VERSION,
    status: 'pending',
    retry_count: 0,
    items: Object.fromEntries(EGE_MOCK_ORAL_TASKS.map((task) => [task.position, {
      position: task.position, maximum: task.maximumScore, status: 'pending', score: null,
      mode: 'experimental', score_kind: 'approximate', error_code: null,
    }])),
    updated_at: iso(now),
  };
  return row;
}

export function reconcileEgeMockSubjectiveAssessmentState(row) {
  const writingStatus = row?.writing_assessment?.status || 'not_started';
  const speakingStatus = row?.speaking_assessment?.status || 'not_started';
  const complete = writingStatus === 'completed' && speakingStatus === 'completed';
  const retryable = ['retryable', 'ambiguous'].includes(writingStatus)
    || speakingStatus === 'retryable';
  row.assessment_status = complete ? 'completed' : retryable ? 'retryable' : 'pending';
  if (row.oral_submitted_at != null || ['assessment_pending', 'completed'].includes(row.state)) {
    row.state = complete ? 'completed' : 'assessment_pending';
  }
  return row;
}

export function egeMockSpeakingAssessmentPublicDto(row) {
  const assessment = row?.speaking_assessment;
  const status = assessment?.status || 'not_started';
  return {
    status,
    ...AUTOMATIC_ASSESSMENT_PUBLIC_CONTRACT,
    label: EGE_MOCK_WRITING_ASSESSMENT_LABEL,
    retryAllowed: false,
    retryCount: Number(assessment?.retry_count || 0),
    items: Object.fromEntries(Object.entries(assessment?.items || {}).map(([position, item]) => [
      position,
      {
        position: Number(item.position), maximum: Number(item.maximum),
        status: item.status, score: item.score == null ? null : Number(item.score),
        mode: item.mode, scoreKind: item.score_kind,
        ...(item.error_code ? { errorCode: item.error_code } : {}),
      },
    ])),
  };
}

export function egeMockSpeakingResultPublicDto(row) {
  const assessment = egeMockSpeakingAssessmentPublicDto(row);
  const scored = Object.values(assessment.items).filter(({ score }) => Number.isFinite(score));
  return {
    ...assessment,
    score: scored.length === 4 ? scored.reduce((total, item) => total + item.score, 0) : null,
    maximum: EGE_MOCK_ORAL_MAXIMUM_SCORE,
  };
}
