import { EgeMockAttemptError } from './attempt.js';
import { nextEgeMockWritingAssessmentRevision } from './writing-assessment.js';

const PENDING_SNAPSHOT = Object.freeze({ commandStatus: 'pending' });
const NONTERMINAL_STATUSES = Object.freeze(['pending', 'in_progress']);
const TERMINAL_STATUSES = Object.freeze(['completed', 'retryable', 'ambiguous']);

function hasTerminalSnapshot(assessment) {
  return TERMINAL_STATUSES.includes(assessment?.status)
    || (assessment?.status === 'pending'
      && assessment?.runDisposition === 'subscription_required');
}

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function stateError() {
  return new EgeMockAttemptError('EGE_MOCK_ASSESSMENT_STATE_INVALID');
}

function replay(responseSnapshot) {
  return {
    kind: 'replay', finalized: true,
    response: { ...clone(responseSnapshot), applied: true, replayed: true },
  };
}

function requireAttempt(attempt) {
  if (!attempt || typeof attempt !== 'object' || !attempt.writingAssessment) throw stateError();
  return attempt;
}

function attemptWithDisposition(attempt, disposition) {
  const current = requireAttempt(attempt);
  const writingAssessment = clone(current.writingAssessment);
  if (writingAssessment.runDisposition !== disposition) {
    writingAssessment.assessmentRevision = nextEgeMockWritingAssessmentRevision({
      assessment_revision: writingAssessment.assessmentRevision,
    });
  }
  return {
    ...clone(current),
    writingAssessment: { ...writingAssessment, runDisposition: disposition },
  };
}

function subscriptionRequired(attempt) {
  const blocked = attemptWithDisposition(attempt, 'subscription_required');
  const response = {
    applied: true,
    replayed: false,
    disposition: 'subscription_required',
    attempt: blocked,
  };
  return { kind: 'finalize', finalized: true, responseSnapshot: clone(response), response };
}

export function applyEgeMockAssessmentRunDisposition(row, decision, { now = null } = {}) {
  if (!row?.writing_assessment || !decision || typeof decision !== 'object') throw stateError();
  const next = decision.kind === 'start'
    ? null
    : decision.kind === 'finalize' && decision.response?.disposition === 'subscription_required'
      ? 'subscription_required'
      : undefined;
  if (next === undefined) return false;
  const current = row.writing_assessment.run_disposition ?? null;
  if (current === next) return false;
  let instant = null;
  if (now != null) {
    instant = new Date(now);
    if (!Number.isFinite(instant.getTime())) throw stateError();
  }
  const nextRevision = nextEgeMockWritingAssessmentRevision(row.writing_assessment);
  if (next == null) delete row.writing_assessment.run_disposition;
  else row.writing_assessment.run_disposition = next;
  row.writing_assessment.assessment_revision = nextRevision;
  if (instant) {
    row.writing_assessment.updated_at = instant.toISOString();
    row.updated_at = instant.toISOString();
  }
  return true;
}

export function egeMockAssessmentRunBeginDecision({
  responseSnapshot = null,
  attempt = null,
  subscriptionActive = false,
  hasFrozenAuthorization = false,
  explicitRenewal = false,
}) {
  if (responseSnapshot && responseSnapshot.commandStatus !== 'pending') {
    return replay(responseSnapshot);
  }
  const current = requireAttempt(attempt);
  const subscriptionBlocked = current.writingAssessment?.runDisposition === 'subscription_required';
  if (subscriptionBlocked && (responseSnapshot || !subscriptionActive || explicitRenewal !== true)) {
    return subscriptionRequired(current);
  }
  if (!subscriptionActive && !hasFrozenAuthorization) {
    return subscriptionRequired(current);
  }
  if (responseSnapshot) return { kind: 'resume', finalized: false };
  return { kind: 'start', finalized: false, responseSnapshot: clone(PENDING_SNAPSHOT) };
}

export function egeMockAssessmentRunCanSettleTerminalSnapshot({
  responseSnapshot = null, attempt = null,
}) {
  if (responseSnapshot?.commandStatus !== 'pending') return false;
  const current = requireAttempt(attempt);
  return hasTerminalSnapshot(current.writingAssessment);
}

export function egeMockAssessmentRunSettlement({
  responseSnapshot = null,
  attempt = null,
  attemptChanged = false,
}) {
  if (!responseSnapshot) throw stateError();
  if (responseSnapshot.commandStatus !== 'pending') return replay(responseSnapshot);
  const current = requireAttempt(attempt);
  const status = current.writingAssessment?.status;
  if (NONTERMINAL_STATUSES.includes(status)) {
    return {
      kind: 'pending', persistAttempt: attemptChanged,
      response: { applied: false, replayed: false, attempt: clone(current) },
    };
  }
  if (!TERMINAL_STATUSES.includes(status)) throw stateError();
  return {
    kind: 'finalize', persistAttempt: attemptChanged,
    response: { applied: true, replayed: false, attempt: clone(current) },
  };
}
