import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { aiRequestExportDto } from './ai-request-export.js';
import { hashAuthCode, normalizeOAuthTransaction, normalizeProviderIdentity, normalizeUsername, normalizeVoiceTutorDeliveryMetadata, normalizeVoiceTutorProxyHash, subscriptionView, VoiceTutorError, voiceTutorAccessView, voiceTutorBillableSeconds, voiceTutorProxyUsage, voiceTutorQuotaPeriods, voiceTutorReservationSeconds } from './shared.js';
import { transitionPedagogicalState } from '../voice-tutor/state-machine.js';
import { transitionRuleCardReview } from '../voice-tutor/rule-card.js';
import {
  persistedVoiceTutorCapsule,
  revalidateSpeakingPronunciationCapsule,
} from '../voice-tutor/capsule.js';
import { createRecoveryLedger, planRecoveryFromTransfer, planRepeatAttempt, publicRepeatAttempt, recoveryMap, recoveryMetrics } from '../voice-tutor/recovery.js';
import { adaptiveAssistedMetadata, adaptiveReadingMetadata, requireModuleAttemptEvidenceQuality } from '../adaptive-learning/evidence-quality.js';
import {
  adaptiveEvidenceFingerprintConflict,
  compareAdaptiveEvidenceWatermarks,
} from '../adaptive-learning/evidence-watermark.js';
import { adaptiveProfileMatchesCurrentEvidence } from '../adaptive-learning/profile.js';
import { adaptiveLearningGoalRepositoryDto } from '../adaptive-learning/goal-dto.js';
import {
  adaptiveLearningProfileExportDto,
  adaptiveLearningProfileRepositoryDto,
} from '../adaptive-learning/repository-dto.js';
import {
  adaptiveDiagnosticAnswerClaimRepositoryDto,
  adaptiveDiagnosticCompletionSnapshotDto,
  adaptiveDiagnosticExportDto,
  adaptiveDiagnosticRepositoryDto,
  adaptiveDiagnosticResponseExportDto,
  adaptiveDiagnosticStartClaimRepositoryDto,
} from '../adaptive-learning/diagnostic-dto.js';
import {
  ADAPTIVE_DIAGNOSTIC_START_CLAIM_LIMIT,
  adaptiveDiagnosticClaimExpiresAt,
} from '../adaptive-learning/diagnostic-claims.js';
import { adaptiveLearningPlanRepositoryDto } from '../adaptive-learning/plan-dto.js';
import { buildAdaptiveLearningMetrics } from '../adaptive-learning/metrics.js';
import { adaptiveSpeakingActivityMatchesTask, adaptiveSpeakingTask } from '../public/adaptive-speaking-tasks.js';
import {
  newSpeakingTask1Session,
  speakingTask1CompletionMetadata,
} from '../speaking/task1-session.js';
import { applySpeakingTask2QuestionCompletion, newSpeakingTask2Session } from '../speaking/task2-session.js';
import { applySpeakingTask3AnswerCompletion, newSpeakingTask3Session } from '../speaking/task3-session.js';
import {
  newSpeakingTask4Session,
  speakingTask4CompletionMetadata,
} from '../speaking/task4-session.js';
import { selectSpeakingTrainingAssignment } from '../speaking/training-session.js';
import {
  abandonFullSpeakingSession,
  advanceFullSpeakingStage,
  applyFullSpeakingEvaluation,
  assertFullSpeakingSessionCompatibility,
  claimFullSpeakingResponseAssessment,
  completeFullSpeakingResponse,
  createFullSpeakingSession,
  fullSpeakingResponseAssessmentClaimState,
  selectFullSpeakingVariant,
  submitFullSpeakingSession,
} from '../speaking/full-section-session.js';
import {
  recoverSpeakingEvaluationAttempt,
  speakingEvaluationClaimRecoverable,
} from '../speaking/evaluation-claim.js';
import {
  assertSpeakingLearningSource,
  buildSpeakingLearningAttempt,
  canonicalSpeakingLearningSource,
  SPEAKING_ADAPTIVE_EVIDENCE_ATTEMPT_LIMIT,
  speakingTargetedPracticeAssignment,
  speakingAdaptiveEvidenceAttempts,
  speakingAdaptiveEvidenceMatchesTarget,
} from '../speaking/learning-loop.js';
import { isMonotonicAdaptiveRetentionRefresh } from '../adaptive-learning/retention.js';
import {
  applyEgeMockAssessmentRetryable,
  applyEgeMockAssessmentRetryMutation,
  applyEgeMockDraftMutation,
  applyEgeMockOralMutation,
  applyEgeMockOralStageMutation,
  applyEgeMockOralStartMutation,
  applyEgeMockWrittenMutation,
  createEgeMockAttempt,
  egeMockAttemptExportDto,
  egeMockAttemptPublicDto,
  EgeMockAttemptError,
  egeMockResultPublicDto,
  egeMockStartDecision,
  reconcileEgeMockAttempt,
  shouldSettleEgeMockOralStageBeforeReconcile,
} from '../ege-mock/attempt.js';
import {
  applyEgeMockAssessmentRunDisposition,
  egeMockAssessmentRunBeginDecision,
  egeMockAssessmentRunCanSettleTerminalSnapshot,
  egeMockAssessmentRunSettlement,
} from '../ege-mock/assessment-run-command.js';
import { getEgeMockForm } from '../ege-mock/catalog.js';
import {
  buildEgeMockHistory,
  egeMockAdaptiveEvidenceAttempts,
  egeMockErrorFocusEntries,
  refreshEgeMockStoredResult,
  selectEgeMockHistoryRows,
} from '../ege-mock/result.js';
import {
  applyEgeMockSpeakingBridgeEvaluation,
  syncEgeMockFullSpeakingSession,
} from '../ege-mock/speaking-bridge.js';
import {
  assertEgeMockWritingAssessmentRevisionAvailable,
  applyEgeMockWritingAssessmentClaim,
  applyEgeMockWritingAssessmentClaimRenewal,
  applyEgeMockWritingAssessmentFailure,
  applyEgeMockWritingAssessmentItemCompletion,
  applyEgeMockWritingAssessmentItemOutcome,
  applyEgeMockWritingAssessmentItemOutcomePreparation,
} from '../ege-mock/writing-assessment.js';
import { adaptiveRepeatExecutionMatches } from '../adaptive-learning/repeat-execution.js';
import {
  adaptiveLearningSessionPublicDto,
  adaptiveLearningSessionRepositoryDto,
} from '../adaptive-learning/session-dto.js';
import {
  adaptiveActivityRequiresPremiumDepth,
  assertAdaptiveSessionCreateCandidate,
  assertAdaptiveSessionReplacementTransition,
} from '../adaptive-learning/session.js';
import {
  ADAPTIVE_EXECUTION_CLAIM_TTL_MS,
  adaptiveCompletedBlockDto,
  adaptiveConsumedClaimAttempt,
  adaptiveExecutionEventExportDto,
  adaptiveExecutionRequestHash,
  adaptiveExecutionSummary,
  adaptiveExecutionTokenHash,
  adaptiveExecutionView,
  adaptiveLaunchFingerprint,
} from '../adaptive-learning/session-execution.js';
import {
  assertAdaptivePlanAuthoritativeCandidate,
  assertAdaptivePlanDuplicateReplay,
  assertAdaptivePlanPersistenceCandidate,
  assertAdaptivePlanStabilityTransition,
  compareAdaptivePlanInputs,
} from '../adaptive-learning/plan.js';
import {
  assertSpeakingAssessmentIdempotencyKey,
  assertSpeakingAssessmentReservation,
  interruptedSpeakingAssessmentResult,
  SPEAKING_ASSESSMENT_LEASE_MS,
  SpeakingAssessmentQuotaError,
  speakingAssessmentExportDto,
  speakingAssessmentPeriodStart,
  speakingAssessmentQuotaView,
} from '../speaking/assessment-quota.js';
import {
  assertSpeakingAccentProfileChange,
  assertSpeakingCalibrationConsent,
  assertSpeakingCalibrationReview,
  assertSpeakingCalibrationSample,
  blindSpeakingCalibrationCard,
  materialSpeakingCalibrationDisagreement,
  publicSpeakingAccentCalibration,
  publicSpeakingAccentProfile,
  publicSpeakingCalibrationSample,
  speakingAccentError,
  speakingCalibrationExpiresAt,
  speakingCalibrationReviewClaim,
} from '../speaking/accent-calibration.js';
import {
  migrateFileWordProgress,
  wordProgressApiDto,
  wordProgressExportDto,
  wordProgressPersistenceCandidate,
  wordProgressStorageDto,
} from './word-progress-dto.js';
import {
  hasCanonicalMasteryRecords,
  migrateLegacyMasteryRecords,
  masteryEventReplayMatches,
  migrateMasteryRecords,
  reduceMastery,
} from '../public/modules/grammar.js';
import { assertGeneratedGrammarMasteryReferences } from '../validation/generated-grammar-mastery.js';

function normalizeAttemptModels(attempts) {
  return attempts.map((attempt) => ({
    ...attempt,
    model: attempt.model ?? null,
  }));
}

function normalizeSpeakingAttempts(attempts) {
  return normalizeAttemptModels(attempts).map((attempt) => ({
    ...attempt,
    assistance_used: typeof attempt.assistance_used === 'boolean' ? attempt.assistance_used : true,
    assistance_updated_at: attempt.assistance_updated_at ?? null,
    accent_locale: ['en-GB', 'en-US'].includes(attempt.accent_locale)
      ? attempt.accent_locale
      : (['en-GB', 'en-US'].includes(attempt.review?.acousticFacts?.accentLocale)
        ? attempt.review.acousticFacts.accentLocale : null),
    targeted_practice: attempt.targeted_practice ?? null,
  }));
}

function compactSpeakingEvidenceAttempt(attempt) {
  return {
    id: attempt.id,
    task_type: attempt.task_type,
    review: attempt.review,
    status: attempt.status,
    source_session_id: attempt.source_session_id,
    source_task_ref: attempt.source_task_ref,
    source_task_revision: attempt.source_task_revision,
    source_catalog_id: attempt.source_catalog_id,
    source_catalog_revision: attempt.source_catalog_revision,
    assistance_used: attempt.assistance_used,
    assistance_updated_at: attempt.assistance_updated_at,
    accent_locale: attempt.accent_locale,
    targeted_practice: attempt.targeted_practice,
    created_at: attempt.created_at,
    evaluated_at: attempt.evaluated_at,
  };
}

function boundedSpeakingEvidenceRows(attempts, username) {
  return attempts
    .filter((entry) => entry.username === username && ['completed', 'needs_retry'].includes(entry.status))
    .sort((first, second) => {
      const firstTimestamp = new Date(first.evaluated_at ?? first.created_at).getTime();
      const secondTimestamp = new Date(second.evaluated_at ?? second.created_at).getTime();
      const firstObserved = Number.isFinite(firstTimestamp) ? firstTimestamp : Number.NEGATIVE_INFINITY;
      const secondObserved = Number.isFinite(secondTimestamp) ? secondTimestamp : Number.NEGATIVE_INFINITY;
      if (firstObserved !== secondObserved) return secondObserved - firstObserved;
      const firstId = Number(first.id);
      const secondId = Number(second.id);
      if (Number.isSafeInteger(firstId) && Number.isSafeInteger(secondId)) return secondId - firstId;
      return String(second.id).localeCompare(String(first.id), 'en');
    })
    .slice(0, SPEAKING_ADAPTIVE_EVIDENCE_ATTEMPT_LIMIT)
    .map(compactSpeakingEvidenceAttempt);
}

function normalizeSpeakingSessions(sessions) {
  return sessions.map((session) => ({
    ...session,
    assistance_used: typeof session.assistance_used === 'boolean' ? session.assistance_used : true,
    targeted_practice: session.targeted_practice ?? null,
  }));
}

function normalizeWritingAttempts(attempts) {
  return normalizeAttemptModels(attempts).map((attempt) => ({
    ...attempt,
    evaluated_answer: attempt.evaluated_answer ?? attempt.answer ?? null,
  }));
}

function minimizeLegacyVoiceTutorCapsule(capsule) {
  if (!capsule || typeof capsule !== 'object' || Array.isArray(capsule)) return capsule;
  const referenceSchema = ['voice-tutor-reference-v1', 'voice-tutor-reference-legacy-v1'].includes(capsule.schema)
    ? capsule.schema
    : 'voice-tutor-reference-legacy-v1';
  const ruleId = capsule.rule_id ?? capsule.rule?.id;
  return {
    schema: referenceSchema,
    id: capsule.id,
    version: capsule.version,
    source: structuredClone(capsule.source),
    module: capsule.module,
    skill_id: capsule.skill_id ?? capsule.skill?.id,
    ...(ruleId ? { rule_id: ruleId } : {}),
    ...(capsule.rule_card_id ? { rule_card_id: capsule.rule_card_id } : {}),
  };
}

function reconcileLegacyApprovedRuleCards(cards) {
  const groups = new Map();
  for (const card of cards) {
    if (card?.status !== 'approved' || !card.skill?.id || !Number.isInteger(Number(card.exam_year))) continue;
    const key = `${card.skill.id}\u0000${Number(card.exam_year)}`;
    const group = groups.get(key) || [];
    group.push(card);
    groups.set(key, group);
  }
  let changed = false;
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    group.sort((first, second) => {
      const reviewed = String(second.reviewed_at || '').localeCompare(String(first.reviewed_at || ''));
      if (reviewed) return reviewed;
      const created = String(second.created_at || '').localeCompare(String(first.created_at || ''));
      return created || String(second.id || '').localeCompare(String(first.id || ''));
    });
    for (const duplicate of group.slice(1)) {
      duplicate.status = 'rejected';
      duplicate.review_audit = [...(Array.isArray(duplicate.review_audit) ? duplicate.review_audit : []), {
        reviewer: null,
        decision: 'rejected',
        reviewed_at: duplicate.reviewed_at || duplicate.created_at,
        reason: 'canonical_deduplicated_by_migration_029',
      }];
      changed = true;
    }
  }
  return changed;
}

function validAdaptiveRecoverySnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object'
    || Object.hasOwn(snapshot, 'executionClaim') || Object.hasOwn(snapshot, 'executionClaimId')
    || !snapshot.session || !snapshot.execution || !snapshot.block || !snapshot.launch
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
      .test(String(snapshot.session.id || ''))
    || !/^asb_[0-9a-f]{16}_[0-9]{2}$/u.test(String(snapshot.block.id || ''))
    || !Number.isInteger(Number(snapshot.execution.revision)) || Number(snapshot.execution.revision) < 0
    || !['exam_practice', 'planned_practice', 'scheduled_review', 'ai_assisted_review']
      .includes(snapshot.evidenceContext)) return false;
  const attempt = snapshot.recoveryAttempt;
  if (!attempt || typeof attempt !== 'object' || Object.keys(attempt).sort().join(',') !== 'id,type') {
    return false;
  }
  if (['module', 'voice_tutor_repeat'].includes(attempt.type)) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
      .test(String(attempt.id || ''));
  }
  return ['writing', 'speaking'].includes(attempt.type)
    && Number.isSafeInteger(Number(attempt.id)) && Number(attempt.id) > 0;
}

function sanitizeLegacyAdaptiveExecution(state, now = Date.now()) {
  let changed = false;
  const hmacClaimIds = new Set(state.adaptive_learning_session_mutations
    .filter((mutation) => mutation?.operation === 'start'
      && !Object.hasOwn(mutation.response_snapshot || {}, 'executionClaim')
      && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
        .test(String(mutation.response_snapshot?.executionClaimId || '')))
    .map((mutation) => mutation.response_snapshot.executionClaimId));
  for (const claim of state.adaptive_learning_execution_claims) {
    if (claim && !claim.revoked_at && !hmacClaimIds.has(claim.id)) {
      claim.consumed_at = null;
      claim.attempt_type = null;
      claim.attempt_ref = null;
      claim.revoked_at = now;
      changed = true;
    }
  }
  const safeMutations = state.adaptive_learning_session_mutations.filter((mutation) => (
    mutation?.operation !== 'start'
      || hmacClaimIds.has(mutation.response_snapshot?.executionClaimId)
      || validAdaptiveRecoverySnapshot(mutation.response_snapshot)
  ));
  if (safeMutations.length !== state.adaptive_learning_session_mutations.length) {
    state.adaptive_learning_session_mutations = safeMutations;
    changed = true;
  }
  return changed;
}

export function createFileRepository(filePath, {
  adaptiveMutationNow = () => new Date(),
  speakingLearningNow = () => new Date(),
  voiceTutorMutationNow = () => new Date(),
} = {}) {
  let loaded = false;
  let state = { users: {}, learner_identities: [], oauth_auth_transactions: {}, progress: {}, progress_summary: {}, auth_codes: {}, writing_attempts: [], speaking_attempts: [], speaking_task1_sessions: [], speaking_task2_sessions: [], speaking_task3_sessions: [], speaking_task4_sessions: [], speaking_full_sessions: [], speaking_assessments: [], speaking_accent_profiles: {}, speaking_accent_history: [], speaking_accent_calibrations: [], speaking_calibration_consents: {}, speaking_calibration_samples: [], generated_tasks: [], task_bank: [], task_deliveries: [], module_attempts: [], word_progress: {}, error_bank: [], ai_requests: [], audit_log: [], sessions: {}, subscriptions: {}, subscription_entitlements: {}, voice_tutor_sessions: [], voice_tutor_recoveries: [], voice_tutor_repeats: [], voice_tutor_repeat_attempts: [], voice_tutor_reports: [], rule_cards: [], payment_requests: {}, subscription_events: [], adaptive_learning_goals: [], adaptive_learning_profiles: {}, adaptive_learning_skill_estimates: {}, adaptive_learning_plan_revisions: [], adaptive_learning_sessions: [], adaptive_learning_execution_claims: [], adaptive_learning_session_events: [], adaptive_learning_session_mutations: [], adaptive_diagnostic_sessions: [], adaptive_diagnostic_start_claims: [], adaptive_diagnostic_responses: [], ege_mock_attempts: [], ege_mock_mutations: [] };
  let writeQueue = Promise.resolve();
  let coordinatedMutationQueue = Promise.resolve();
  let ruleCardQueue = Promise.resolve();

  async function load() {
    if (loaded) return;
    loaded = true;
    try {
      const parsed = JSON.parse(await fs.readFile(filePath, 'utf8'));
      if (parsed && typeof parsed === 'object') {
        let minimizedLegacyCapsule = false;
        state = {
          users: parsed.users && typeof parsed.users === 'object' ? parsed.users : {},
          learner_identities: Array.isArray(parsed.learner_identities) ? parsed.learner_identities : [],
          oauth_auth_transactions: parsed.oauth_auth_transactions && typeof parsed.oauth_auth_transactions === 'object'
            ? parsed.oauth_auth_transactions : {},
          progress: parsed.progress && typeof parsed.progress === 'object' ? parsed.progress : {},
          progress_summary: parsed.progress_summary && typeof parsed.progress_summary === 'object' ? parsed.progress_summary : {},
          auth_codes: parsed.auth_codes && typeof parsed.auth_codes === 'object' ? parsed.auth_codes : {},
          writing_attempts: Array.isArray(parsed.writing_attempts) ? normalizeWritingAttempts(parsed.writing_attempts) : [],
          speaking_attempts: Array.isArray(parsed.speaking_attempts) ? normalizeSpeakingAttempts(parsed.speaking_attempts) : [],
          speaking_task1_sessions: Array.isArray(parsed.speaking_task1_sessions) ? normalizeSpeakingSessions(parsed.speaking_task1_sessions) : [],
          speaking_task2_sessions: Array.isArray(parsed.speaking_task2_sessions) ? normalizeSpeakingSessions(parsed.speaking_task2_sessions) : [],
          speaking_task3_sessions: Array.isArray(parsed.speaking_task3_sessions) ? normalizeSpeakingSessions(parsed.speaking_task3_sessions) : [],
          speaking_task4_sessions: Array.isArray(parsed.speaking_task4_sessions) ? normalizeSpeakingSessions(parsed.speaking_task4_sessions) : [],
          speaking_full_sessions: Array.isArray(parsed.speaking_full_sessions) ? parsed.speaking_full_sessions : [],
          speaking_assessments: Array.isArray(parsed.speaking_assessments)
            ? parsed.speaking_assessments.map((row) => ({
              ...row,
              dispatch_started_at: row.dispatch_started_at
                || (['started', 'finalized'].includes(row.status) ? row.provider_started_at : null),
            })) : [],
          speaking_accent_profiles: parsed.speaking_accent_profiles
            && typeof parsed.speaking_accent_profiles === 'object'
            ? parsed.speaking_accent_profiles : {},
          speaking_accent_history: Array.isArray(parsed.speaking_accent_history)
            ? parsed.speaking_accent_history : [],
          speaking_accent_calibrations: Array.isArray(parsed.speaking_accent_calibrations)
            ? parsed.speaking_accent_calibrations : [],
          speaking_calibration_consents: parsed.speaking_calibration_consents
            && typeof parsed.speaking_calibration_consents === 'object'
            ? parsed.speaking_calibration_consents : {},
          speaking_calibration_samples: Array.isArray(parsed.speaking_calibration_samples)
            ? parsed.speaking_calibration_samples : [],
          generated_tasks: Array.isArray(parsed.generated_tasks) ? parsed.generated_tasks : [],
          task_bank: Array.isArray(parsed.task_bank) ? parsed.task_bank : [],
          task_deliveries: Array.isArray(parsed.task_deliveries) ? parsed.task_deliveries : [],
          module_attempts: Array.isArray(parsed.module_attempts) ? parsed.module_attempts : [],
          word_progress: parsed.word_progress && typeof parsed.word_progress === 'object' ? parsed.word_progress : {},
          error_bank: Array.isArray(parsed.error_bank) ? parsed.error_bank : [],
          ai_requests: Array.isArray(parsed.ai_requests) ? parsed.ai_requests : [],
          audit_log: Array.isArray(parsed.audit_log) ? parsed.audit_log : [],
          sessions: parsed.sessions && typeof parsed.sessions === 'object' ? parsed.sessions : {},
          subscriptions: parsed.subscriptions && typeof parsed.subscriptions === 'object' ? parsed.subscriptions : {},
          subscription_entitlements: parsed.subscription_entitlements && typeof parsed.subscription_entitlements === 'object' ? parsed.subscription_entitlements : {},
          voice_tutor_sessions: Array.isArray(parsed.voice_tutor_sessions) ? parsed.voice_tutor_sessions.map((session) => {
            const capsule = minimizeLegacyVoiceTutorCapsule(session.capsule);
            if (capsule !== session.capsule) minimizedLegacyCapsule = true;
            return {
              ...session, capsule,
              voice_activated_at: session.voice_activated_at ?? null,
              micro_check_attempts: Number(session.micro_check_attempts || 0),
              micro_check_passes: Number(session.micro_check_passes || 0),
              clarification_turns: Number(session.clarification_turns || 0),
              discovery_status: session.discovery_status ?? null,
              discovery_claim_id: session.discovery_claim_id ?? null,
              discovery_error_code: session.discovery_error_code ?? null,
              proxy_ticket_reissue_count: Number(session.proxy_ticket_reissue_count || 0),
            };
          }) : [],
          voice_tutor_recoveries: Array.isArray(parsed.voice_tutor_recoveries) ? parsed.voice_tutor_recoveries : [],
          voice_tutor_repeats: Array.isArray(parsed.voice_tutor_repeats) ? parsed.voice_tutor_repeats : [],
          voice_tutor_repeat_attempts: Array.isArray(parsed.voice_tutor_repeat_attempts) ? parsed.voice_tutor_repeat_attempts : [],
          voice_tutor_reports: Array.isArray(parsed.voice_tutor_reports) ? parsed.voice_tutor_reports : [],
          rule_cards: Array.isArray(parsed.rule_cards) ? parsed.rule_cards : [],
          payment_requests: parsed.payment_requests && typeof parsed.payment_requests === 'object' ? parsed.payment_requests : {},
          subscription_events: Array.isArray(parsed.subscription_events) ? parsed.subscription_events : [],
          adaptive_learning_goals: Array.isArray(parsed.adaptive_learning_goals) ? parsed.adaptive_learning_goals : [],
          adaptive_learning_profiles: parsed.adaptive_learning_profiles && typeof parsed.adaptive_learning_profiles === 'object' ? parsed.adaptive_learning_profiles : {},
          adaptive_learning_skill_estimates: parsed.adaptive_learning_skill_estimates && typeof parsed.adaptive_learning_skill_estimates === 'object' ? parsed.adaptive_learning_skill_estimates : {},
          adaptive_learning_plan_revisions: Array.isArray(parsed.adaptive_learning_plan_revisions) ? parsed.adaptive_learning_plan_revisions : [],
          adaptive_learning_sessions: Array.isArray(parsed.adaptive_learning_sessions) ? parsed.adaptive_learning_sessions : [],
          adaptive_learning_execution_claims: Array.isArray(parsed.adaptive_learning_execution_claims) ? parsed.adaptive_learning_execution_claims : [],
          adaptive_learning_session_events: Array.isArray(parsed.adaptive_learning_session_events) ? parsed.adaptive_learning_session_events : [],
          adaptive_learning_session_mutations: Array.isArray(parsed.adaptive_learning_session_mutations) ? parsed.adaptive_learning_session_mutations : [],
          adaptive_diagnostic_sessions: Array.isArray(parsed.adaptive_diagnostic_sessions) ? parsed.adaptive_diagnostic_sessions : [],
          adaptive_diagnostic_start_claims: Array.isArray(parsed.adaptive_diagnostic_start_claims) ? parsed.adaptive_diagnostic_start_claims : [],
          adaptive_diagnostic_responses: Array.isArray(parsed.adaptive_diagnostic_responses) ? parsed.adaptive_diagnostic_responses : [],
          ege_mock_attempts: Array.isArray(parsed.ege_mock_attempts) ? parsed.ege_mock_attempts : [],
          ege_mock_mutations: Array.isArray(parsed.ege_mock_mutations) ? parsed.ege_mock_mutations : [],
        };
        const reconciledLegacyCanonical = reconcileLegacyApprovedRuleCards(state.rule_cards);
        const sanitizedLegacyAdaptiveExecution = sanitizeLegacyAdaptiveExecution(state);
        const migratedWordProgress = migrateFileWordProgress(state.word_progress);
        state.word_progress = migratedWordProgress.wordProgress;
        if (minimizedLegacyCapsule || reconciledLegacyCanonical || sanitizedLegacyAdaptiveExecution
          || migratedWordProgress.changed) {
          await persist();
        }
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  function persist() {
    const snapshot = JSON.stringify(state, null, 2);
    writeQueue = writeQueue.then(async () => {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      const temporary = `${filePath}.${process.pid}.tmp`;
      await fs.writeFile(temporary, snapshot, 'utf8');
      await fs.rename(temporary, filePath);
    });
    return writeQueue;
  }

  async function getUser(username) {
    await load();
    return state.users[username] ? { username, ...state.users[username] } : null;
  }

  async function createUser(username, hash) {
    await load();
    if (state.users[username]) throw new Error('USER_EXISTS');
    state.users[username] = { hash, role: 'student', created: Date.now() };
    state.progress[username] ||= {};
    await persist();
    return { username, ...state.users[username] };
  }

  async function findOrCreateProviderUser(input) {
    return serializeCoordinatedMutation(async () => {
      await load();
      const identity = normalizeProviderIdentity(input);
      const existingIdentity = state.learner_identities.find((entry) => (
        entry.provider === identity.provider && entry.subject === identity.subject
      ));
      if (existingIdentity) {
        const existingUser = state.users[existingIdentity.username];
        if (!existingUser) throw new Error('PROVIDER_IDENTITY_ORPHANED');
        if (existingUser.display_name !== identity.displayName) {
          existingUser.display_name = identity.displayName;
          existingIdentity.updated_at = new Date(input.now || Date.now()).toISOString();
          await persist();
        }
        return { username: existingIdentity.username, ...structuredClone(existingUser) };
      }

      let username = '';
      for (let attempt = 0; attempt < 32 && !username; attempt += 1) {
        const candidate = `learner_${crypto.randomBytes(12).toString('base64url')}`;
        if (!state.users[candidate]) username = candidate;
      }
      if (!username) throw new Error('PROVIDER_IDENTITY_USERNAME_EXHAUSTED');
      const instant = new Date(input.now || Date.now()).toISOString();
      state.users[username] = {
        identity_managed: true,
        display_name: identity.displayName,
        role: 'student',
        created: new Date(instant).getTime(),
      };
      state.learner_identities.push({
        provider: identity.provider,
        subject: identity.subject,
        username,
        created_at: instant,
        updated_at: instant,
      });
      state.progress[username] ||= {};
      await persist();
      return { username, ...structuredClone(state.users[username]) };
    });
  }

  async function createOAuthTransaction(input) {
    return serializeCoordinatedMutation(async () => {
      await load();
      const transaction = normalizeOAuthTransaction(input);
      if (state.oauth_auth_transactions[transaction.stateHash]) throw new Error('OAUTH_STATE_COLLISION');
      const retentionCutoff = transaction.createdAt.getTime() - 86_400_000;
      for (const [stateHash, entry] of Object.entries(state.oauth_auth_transactions)) {
        if (new Date(entry.expires_at).getTime() <= retentionCutoff) delete state.oauth_auth_transactions[stateHash];
      }
      state.oauth_auth_transactions[transaction.stateHash] = {
        provider: transaction.provider,
        verifier_sealed: transaction.verifierSealed,
        redirect_uri: transaction.redirectUri,
        expires_at: transaction.expiresAt.toISOString(),
        created_at: transaction.createdAt.toISOString(),
        consumed_at: null,
      };
      await persist();
      return true;
    });
  }

  async function consumeOAuthTransaction(stateHash, { now = new Date() } = {}) {
    return serializeCoordinatedMutation(async () => {
      await load();
      const normalizedHash = String(stateHash || '').toLowerCase();
      const instant = new Date(now);
      if (!/^[a-f0-9]{64}$/u.test(normalizedHash) || !Number.isFinite(instant.getTime())) {
        throw new Error('OAUTH_TRANSACTION_INVALID');
      }
      const entry = state.oauth_auth_transactions[normalizedHash];
      if (!entry) return { status: 'missing' };
      if (entry.consumed_at) return { status: 'replayed' };
      if (new Date(entry.expires_at).getTime() <= instant.getTime()) return { status: 'expired' };
      const verifierSealed = entry.verifier_sealed;
      entry.consumed_at = instant.toISOString();
      entry.verifier_sealed = null;
      await persist();
      return {
        status: 'ready',
        transaction: {
          provider: entry.provider,
          verifierSealed,
          redirectUri: entry.redirect_uri,
          expiresAt: entry.expires_at,
        },
      };
    });
  }

  async function purgeOAuthTransactions({ now = new Date() } = {}) {
    return serializeCoordinatedMutation(async () => {
      await load();
      const instant = new Date(now);
      if (!Number.isFinite(instant.getTime())) throw new Error('OAUTH_TRANSACTION_INVALID');
      let purged = 0;
      for (const [stateHash, entry] of Object.entries(state.oauth_auth_transactions)) {
        if (new Date(entry.expires_at).getTime() <= instant.getTime()) {
          delete state.oauth_auth_transactions[stateHash];
          purged += 1;
        }
      }
      if (purged) await persist();
      return purged;
    });
  }

  async function getProgress(username) {
    await migrateGrammarMastery(username);
    return structuredClone(state.progress[username] || {});
  }

  async function saveProgress(username, data) {
    await load();
    const canonicalMastery = state.progress[username]?.grammarMastery;
    const accepted = structuredClone(data || {});
    delete accepted.grammarMastery;
    delete accepted.grammarRunner;
    state.progress[username] = accepted;
    if (canonicalMastery) state.progress[username].grammarMastery = canonicalMastery;
    await persist();
  }

  async function mergeProgress(username, modules) {
    await load();
    const accepted = structuredClone(modules || {});
    delete accepted.grammarMastery;
    delete accepted.grammarRunner;
    const current = { ...(state.progress[username] || {}) };
    delete current.grammarRunner;
    state.progress[username] = { ...current, ...accepted };
    await persist();
    return structuredClone(state.progress[username]);
  }

  async function migrateGrammarMastery(username) {
    return serializeCoordinatedMutation(async () => {
      await load();
      const progress = state.progress[username] || {};
      const canonicalOwnsTruth = hasCanonicalMasteryRecords(progress.grammarMastery);
      const source = canonicalOwnsTruth ? progress.grammarMastery : progress.gram;
      if (!source || typeof source !== 'object') return structuredClone(canonicalOwnsTruth ? progress.grammarMastery : {});
      const migrated = canonicalOwnsTruth
        ? migrateMasteryRecords(source, { now: Date.now() })
        : migrateLegacyMasteryRecords(source, { now: Date.now() });
      if (JSON.stringify(progress.grammarMastery) !== JSON.stringify(migrated)) {
        state.progress[username] = { ...progress, grammarMastery: migrated };
        await persist();
      }
      return structuredClone(migrated);
    });
  }

  async function applyGrammarMasteryEvents(username, entries) {
    return serializeCoordinatedMutation(async () => {
      await load();
      if (!state.users[username]) throw new Error('USER_NOT_FOUND');
      const now = Date.now();
      const progress = state.progress[username] || {};
      const canonicalOwnsTruth = hasCanonicalMasteryRecords(progress.grammarMastery);
      const source = canonicalOwnsTruth ? progress.grammarMastery : (progress.gram || {});
      const grammarMastery = canonicalOwnsTruth
        ? migrateMasteryRecords(source, { now })
        : migrateLegacyMasteryRecords(source, { now });
      const authoritativeMastery = structuredClone(grammarMastery);
      const pendingResults = [];
      let changed = !canonicalOwnsTruth;
      for (const { topicId, event } of entries) {
        const current = grammarMastery[topicId]
          || migrateMasteryRecords({ [topicId]: {} }, { now })[topicId];
        const eventSeen = current.recentEventIds.includes(event.id);
        const replay = eventSeen && masteryEventReplayMatches(current, event);
        if (!eventSeen) {
          await assertGeneratedGrammarMasteryReferences(topicId, event, async (requestHash) => {
            const task = state.generated_tasks.find((item) => (
              item.username === username && item.request_hash === requestHash
            ));
            return task ? {
              operation: task.operation, request: task.request, result: task.result,
            } : null;
          });
        }
        const record = eventSeen
          ? current
          : reduceMastery(current, event, { now, clockAuthority: 'server', topicId });
        const applied = !replay && record.masteryRevision === current.masteryRevision + 1;
        if (applied) {
          grammarMastery[topicId] = record;
          changed = true;
        }
        pendingResults.push({
          topicId,
          eventId: event.id,
          applied,
          conflict: !applied && !replay,
          replay,
          record: structuredClone(applied ? record : current),
        });
      }
      const hasConflict = pendingResults.some((result) => result.conflict);
      const results = hasConflict
        ? pendingResults.map(({ topicId, eventId, replay }) => {
          const record = authoritativeMastery[topicId]
            || migrateMasteryRecords({ [topicId]: {} }, { now })[topicId];
          return {
            eventId,
            applied: false,
            conflict: !replay,
            replay,
            record: structuredClone(record),
          };
        })
        : pendingResults.map(({ topicId: _topicId, ...result }) => result);
      if (changed && !hasConflict) {
        state.progress[username] = { ...progress, grammarMastery };
        await persist();
      }
      return results;
    });
  }

  async function applyGrammarMasteryEvent(username, topicId, event) {
    return (await applyGrammarMasteryEvents(username, [{ topicId, event }]))[0];
  }

  async function getUserByTelegram(telegramId) {
    await load();
    const id = String(telegramId);
    for (const [username, user] of Object.entries(state.users)) {
      if (String(user.telegram_id) === id) return { username, ...user };
    }
    return null;
  }

  async function createTelegramUser(telegramId, displayName) {
    await load();
    const existing = await getUserByTelegram(telegramId);
    if (existing) return existing.username;
    const base = normalizeUsername(displayName, telegramId);
    let username = base;
    let suffix = 1;
    while (state.users[username]) username = `${base.slice(0, 16)}_${suffix++}`;
    state.users[username] = { telegram_id: Number(telegramId), role: 'student', created: Date.now() };
    state.progress[username] ||= {};
    await persist();
    return username;
  }

  async function ensureTelegramUser(telegramId, displayName) {
    const existing = await getUserByTelegram(telegramId);
    return existing ? existing.username : createTelegramUser(telegramId, displayName);
  }

  async function grantDays(telegramId, days, displayName) {
    await load();
    const username = await ensureTelegramUser(telegramId, displayName);
    const user = state.users[username];
    const now = Date.now();
    user.sub_until = Math.max(now, Number(user.sub_until || 0)) + Number(days) * 86_400_000;
    state.subscriptions[username] = { status: 'active', source: displayName ? 'trial' : 'manual', starts_at: now, ends_at: user.sub_until, updated_at: now };
    await persist();
    return { username, sub_until: user.sub_until };
  }

  function serializePaymentMutation(run) {
    return serializeCoordinatedMutation(run);
  }

  function paymentRequestView(request) {
    return request ? { ...structuredClone(request), product: request.product || 'base' } : null;
  }

  async function createPaymentRequestForUser(id, username, product = 'base', { now = new Date() } = {}) {
    return serializePaymentMutation(async () => {
      await load();
      if (!state.users[username]) throw new Error('USER_NOT_FOUND');
      if (!['base', 'premium_voice'].includes(product)) throw new Error('INVALID_PAYMENT_PRODUCT');
      const existing = Object.values(state.payment_requests).find((request) => request.username === username
        && (request.product || 'base') === product && request.status === 'new');
      if (existing) return paymentRequestView(existing);
      if (state.payment_requests[id]) throw new Error('PAYMENT_REQUEST_ID_CONFLICT');
      const request = { id, username, product, status: 'new', created_at: new Date(now).getTime() };
      state.payment_requests[id] = request;
      await persist();
      return paymentRequestView(request);
    });
  }

  async function createPaymentRequest(id, telegramId, displayName, options = {}) {
    const username = await ensureTelegramUser(telegramId, displayName);
    return createPaymentRequestForUser(id, username, options.product || 'base', options);
  }

  async function getPaymentRequestForUser(username, product = 'premium_voice') {
    await load();
    const requests = Object.values(state.payment_requests).filter((request) => request.username === username
      && (request.product || 'base') === product);
    return paymentRequestView(requests.at(-1));
  }

  async function listPaymentRequests({ product = 'premium_voice', status = 'new' } = {}) {
    await load();
    if (!['base', 'premium_voice'].includes(product) || !['new', 'approved', 'rejected', 'cancelled'].includes(status)) {
      throw new Error('INVALID_PAYMENT_FILTER');
    }
    return Object.values(state.payment_requests)
      .filter((request) => (request.product || 'base') === product && request.status === status)
      .sort((left, right) => Number(left.created_at) - Number(right.created_at))
      .map(paymentRequestView);
  }

  async function resolvePaymentRequest(id, decision, actorTelegramId, days, { now = new Date() } = {}) {
    return serializePaymentMutation(async () => {
      await load();
      if (!['approved', 'rejected', 'cancelled'].includes(decision)) throw new Error('INVALID_PAYMENT_DECISION');
      const requestedDays = Number(days);
      if (!Number.isInteger(requestedDays) || requestedDays < 1 || requestedDays > 365) throw new Error('INVALID_SUBSCRIPTION_PERIOD');
      const request = state.payment_requests[id];
      if (!request) throw new Error('PAYMENT_REQUEST_NOT_FOUND');
      const user = state.users[request.username];
      const product = request.product || 'base';
      if (request.status !== 'new') return { applied: false, status: request.status, product, username: request.username, telegram_id: user.telegram_id, sub_until: user.sub_until || 0 };
      if (decision === 'approved' && Number(actorTelegramId) === Number(user.telegram_id)) {
        throw new Error('PAYMENT_SELF_APPROVAL_FORBIDDEN');
      }
      const instant = new Date(now).getTime();
      if (!Number.isFinite(instant)) throw new Error('INVALID_PAYMENT_TIME');
      if (decision === 'approved') {
        user.sub_until = Math.max(instant, Number(user.sub_until || 0)) + requestedDays * 86_400_000;
        state.subscriptions[request.username] = { status: 'active', source: 'manual', starts_at: instant, ends_at: user.sub_until, updated_at: instant };
        if (product === 'premium_voice') {
          const existing = state.subscription_entitlements[request.username]?.voice_tutor;
          state.subscription_entitlements[request.username] ||= {};
          state.subscription_entitlements[request.username].voice_tutor = {
            starts_at: existing?.starts_at && new Date(existing.starts_at).getTime() < instant
              ? existing.starts_at
              : new Date(instant).toISOString(),
            ends_at: new Date(user.sub_until).toISOString(),
          };
        }
        state.subscription_events.push({
          username: request.username,
          event_type: product === 'premium_voice' ? 'premium_payment_approved' : 'payment_approved',
          days: requestedDays,
          actor_telegram_id: Number(actorTelegramId),
          metadata: { payment_request_id: id, ...(product === 'premium_voice' ? { product } : {}) },
          created_at: instant,
        });
      }
      request.product = product;
      request.status = decision;
      request.actor_telegram_id = Number(actorTelegramId);
      request.result = decision;
      request.resolved_at = instant;
      state.audit_log.push({ id: (state.audit_log.at(-1)?.id || 0) + 1, actor_telegram_id: Number(actorTelegramId), action: 'payment.resolve', target_type: 'payment_request', target_id: id, result: decision, metadata: { username: request.username, product, days: decision === 'approved' ? requestedDays : 0 }, created_at: instant });
      await persist();
      return { applied: true, status: decision, product, username: request.username, telegram_id: user.telegram_id, sub_until: user.sub_until || 0 };
    });
  }

  async function revokeEntitlement(username, entitlement, actorTelegramId, { now = new Date() } = {}) {
    return serializePaymentMutation(async () => {
      await load();
      if (entitlement !== 'voice_tutor') throw new Error('INVALID_ENTITLEMENT');
      const period = state.subscription_entitlements[username]?.[entitlement];
      const instant = new Date(now).getTime();
      if (!state.users[username]) throw new Error('USER_NOT_FOUND');
      const active = period && new Date(period.starts_at).getTime() < instant
        && (period.ends_at == null || new Date(period.ends_at).getTime() > instant);
      if (!active) return false;
      period.ends_at = new Date(instant).toISOString();
      state.subscription_events.push({ username, event_type: 'premium_revoked', days: 0, actor_telegram_id: Number(actorTelegramId), metadata: { entitlement }, created_at: instant });
      state.audit_log.push({ id: (state.audit_log.at(-1)?.id || 0) + 1, actor_telegram_id: Number(actorTelegramId), action: 'entitlement.revoke', target_type: 'subscription_entitlement', target_id: entitlement, result: 'revoked', metadata: { username }, created_at: instant });
      await persist();
      return true;
    });
  }

  async function markTrialUsed(telegramId, displayName) {
    await load();
    const username = await ensureTelegramUser(telegramId, displayName);
    state.users[username].trial_used = true;
    await persist();
    return username;
  }

  async function activateTrial(telegramId, days, displayName) {
    await load();
    const username = await ensureTelegramUser(telegramId, displayName);
    const user = state.users[username];
    if (user.trial_used) return { applied: false, username, sub_until: user.sub_until || 0 };
    const now = Date.now();
    user.trial_used = true;
    user.sub_until = Math.max(now, Number(user.sub_until || 0)) + Number(days) * 86_400_000;
    state.subscriptions[username] = { status: 'active', source: 'trial', starts_at: now, ends_at: user.sub_until, updated_at: now };
    state.subscription_events.push({ username, event_type: 'trial_activated', days: Number(days), actor_telegram_id: Number(telegramId), metadata: {}, created_at: now });
    await persist();
    return { applied: true, username, sub_until: user.sub_until };
  }

  async function getSub(username) {
    return subscriptionView(await getUser(username));
  }

  async function setEntitlement(username, entitlement, { startsAt = new Date(), endsAt = null } = {}) {
    return serializeCoordinatedMutation(async () => {
      await load();
      if (!state.users[username]) throw new Error('USER_NOT_FOUND');
      if (!/^[a-z0-9_]{1,64}$/u.test(entitlement)) throw new Error('INVALID_ENTITLEMENT');
      const startsAtMs = new Date(startsAt).getTime();
      const endsAtMs = endsAt == null ? null : new Date(endsAt).getTime();
      if (!Number.isFinite(startsAtMs) || (endsAtMs != null && (!Number.isFinite(endsAtMs) || endsAtMs <= startsAtMs))) {
        throw new Error('INVALID_ENTITLEMENT_PERIOD');
      }
      state.subscription_entitlements[username] ||= {};
      state.subscription_entitlements[username][entitlement] = {
        starts_at: new Date(startsAtMs).toISOString(),
        ends_at: endsAtMs == null ? null : new Date(endsAtMs).toISOString(),
      };
      await persist();
    });
  }

  function hasVoiceTutorEntitlement(username, nowMs) {
    const entitlement = state.subscription_entitlements[username]?.voice_tutor;
    return Number(state.users[username]?.sub_until || 0) > nowMs
      && Boolean(entitlement)
      && new Date(entitlement.starts_at).getTime() <= nowMs
      && (entitlement.ends_at == null || new Date(entitlement.ends_at).getTime() > nowMs);
  }

  function requireVoiceTutorEntitlement(username, nowMs) {
    if (Number(state.users[username]?.sub_until || 0) <= nowMs) {
      throw new VoiceTutorError('SUBSCRIPTION_REQUIRED');
    }
    const entitlement = state.subscription_entitlements[username]?.voice_tutor;
    if (!entitlement || new Date(entitlement.starts_at).getTime() > nowMs
      || (entitlement.ends_at != null && new Date(entitlement.ends_at).getTime() <= nowMs)) {
      throw new VoiceTutorError('VOICE_TUTOR_PREMIUM_REQUIRED');
    }
  }

  function voiceTutorMutationEffectiveNow() {
    const effectiveNow = new Date(voiceTutorMutationNow());
    if (!Number.isFinite(effectiveNow.getTime())) {
      throw new VoiceTutorError('VOICE_TUTOR_USAGE_INVALID');
    }
    return effectiveNow;
  }

  function revalidateVoiceTutorPronunciationCapsule(username, storedCapsule, effectiveNow) {
    if (!storedCapsule?.source?.pronunciation_error_ref) return null;
    const attemptId = Number(storedCapsule.source.attempt_id);
    const attempt = state.speaking_attempts.find((entry) => (
      entry.username === username && entry.id === attemptId
    ));
    return revalidateSpeakingPronunciationCapsule({
      attempt, storedCapsule, referenceTime: effectiveNow,
    });
  }

  function voiceTutorUsage(username, now) {
    const nowMs = new Date(now).getTime();
    const { dayStart, monthStart } = voiceTutorQuotaPeriods(now);
    const sessions = state.voice_tutor_sessions.filter((session) => session.username === username);
    const billableSeconds = (session) => Number(session.billable_seconds ?? session.reserved_seconds ?? 0);
    return {
      dailyUsedSeconds: sessions
        .filter((session) => new Date(session.started_at).getTime() >= dayStart.getTime())
        .reduce((total, session) => total + billableSeconds(session), 0),
      monthlyUsedSeconds: sessions
        .filter((session) => new Date(session.started_at).getTime() >= monthStart.getTime())
        .reduce((total, session) => total + billableSeconds(session), 0),
      activeSession: sessions.some((session) => session.status === 'active' && new Date(session.expires_at).getTime() > nowMs),
    };
  }

  function expireVoiceTutorSessions(username, now) {
    const nowMs = new Date(now).getTime();
    let changed = false;
    for (const session of state.voice_tutor_sessions) {
      if (session.username !== username || session.status !== 'active' || new Date(session.expires_at).getTime() > nowMs) continue;
      session.status = 'expired';
      if (session.proxy_ticket_consumed_at && !session.proxy_finalized_at) {
        const usage = voiceTutorProxyUsage(session, {
          inputAudioBytes: Number(session.proxy_input_audio_bytes || 0),
          outputAudioBytes: Number(session.proxy_output_audio_bytes || 0),
          confirmed: false,
          reason: 'timeout',
          now: session.expires_at,
        });
        session.billable_seconds = usage.billable_seconds;
        session.proxy_input_audio_bytes = usage.input_audio_bytes;
        session.proxy_output_audio_bytes = usage.output_audio_bytes;
        session.proxy_usage_confirmed = usage.confirmed;
        session.proxy_finalization_reason = usage.reason;
        session.proxy_finalized_at = usage.finalized_at;
      } else {
        session.billable_seconds = voiceTutorBillableSeconds(session, session.expires_at);
      }
      session.ended_at = session.expires_at;
      if (session.capsule) {
        if (!['resolved', 'fallback', 'ended'].includes(session.pedagogical_state)) {
          session.pedagogical_state = 'ended';
          session.outcome = 'ended';
        }
        session.nonce_hash = null;
      }
      changed = true;
    }
    return changed;
  }

  function serializeCoordinatedMutation(run) {
    const result = coordinatedMutationQueue.then(run, run);
    coordinatedMutationQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  function serializeVoiceTutorMutation(run) { return serializeCoordinatedMutation(run); }

  function requireEgeMockProviderAuthorization(username, now, voiceConsentPolicyVersion) {
    const instant = new Date(now);
    if (!Number.isFinite(instant.getTime())) throw new Error('SPEAKING_EVALUATION_CLAIM_TIME_INVALID');
    if (Number(state.users[username]?.sub_until || 0) <= instant.getTime()) {
      throw Object.assign(new Error('SUBSCRIPTION_REQUIRED'), {
        code: 'SUBSCRIPTION_REQUIRED', status: 403,
      });
    }
    const consent = state.users[username]?.privacy_consent || {};
    if (!voiceConsentPolicyVersion || consent.policy_version !== voiceConsentPolicyVersion
      || consent.voice_processing !== true) {
      throw Object.assign(new Error('PRIVACY_CONSENT_REQUIRED'), {
        code: 'PRIVACY_CONSENT_REQUIRED', status: 403,
      });
    }
  }

  function egeMockInstant(clock) {
    const instant = new Date(typeof clock === 'function' ? clock() : clock);
    if (!Number.isFinite(instant.getTime())) throw new EgeMockAttemptError('EGE_MOCK_TIME_INVALID');
    return instant;
  }

  async function startEgeMockAttempt(username, candidate, { now = () => new Date() } = {}) {
    return serializeCoordinatedMutation(async () => {
      await load();
      const user = state.users[username];
      const instant = egeMockInstant(now);
      if (!user) throw new EgeMockAttemptError('EGE_MOCK_OWNER_NOT_FOUND');
      if (Number(user.sub_until || 0) <= instant.getTime()) {
        throw new EgeMockAttemptError('SUBSCRIPTION_REQUIRED');
      }
      const form = getEgeMockForm(candidate.formId, candidate.formRevision);
      if (!form || form.fingerprint !== candidate.catalogFingerprint) {
        throw new EgeMockAttemptError('EGE_MOCK_FORM_UNAVAILABLE');
      }
      const replay = state.ege_mock_attempts.find((attempt) => (
        attempt.username === username && attempt.start_idempotency_key === candidate.idempotencyKey
      ));
      if (replay) {
        if (replay.start_request_hash !== candidate.requestHash) {
          throw new EgeMockAttemptError('EGE_MOCK_IDEMPOTENCY_CONFLICT');
        }
        return {
          created: false,
          replayed: true,
          attempt: structuredClone(replay.start_response_attempt || egeMockAttemptPublicDto(replay)),
        };
      }
      const mutationReplay = state.ege_mock_mutations.find((entry) => (
        entry.username === username && entry.idempotency_key === candidate.idempotencyKey
      ));
      if (mutationReplay) {
        if (mutationReplay.operation !== 'start' || mutationReplay.request_hash !== candidate.requestHash) {
          throw new EgeMockAttemptError('EGE_MOCK_IDEMPOTENCY_CONFLICT');
        }
        return { ...structuredClone(mutationReplay.response_snapshot), replayed: true };
      }
      const exactFormAttempts = state.ege_mock_attempts.filter((attempt) => (
        attempt.username === username && attempt.form_id === form.id && attempt.form_revision === form.revision
      ));
      for (const attempt of exactFormAttempts) {
        reconcileEgeMockAttemptWithDerivedProjections(username, attempt, instant);
      }
      const decision = egeMockStartDecision(exactFormAttempts);
      const { active } = decision;
      if (active) {
        const response = {
          created: false, replayed: false, resumed: true,
          attempt: egeMockAttemptPublicDto(active),
        };
        state.ege_mock_mutations.push({
          username, attempt_id: active.id, operation: 'start',
          idempotency_key: candidate.idempotencyKey, request_hash: candidate.requestHash,
          response_snapshot: structuredClone(response), created_at: instant.toISOString(),
        });
        await persist();
        return response;
      }
      const ownerGeneration = `account:${new Date(user.created).toISOString()}`;
      const attempt = createEgeMockAttempt({
        id: crypto.randomUUID(), username, ownerGeneration, form,
        mode: decision.mode,
        attemptNumber: decision.attemptNumber,
        idempotencyKey: candidate.idempotencyKey,
        requestHash: candidate.requestHash,
        now: instant,
      });
      state.ege_mock_attempts.push(attempt);
      await persist();
      return { created: true, replayed: false, attempt: egeMockAttemptPublicDto(attempt) };
    });
  }

  async function getCurrentEgeMockAttempt(username, { now = () => new Date() } = {}) {
    return serializeCoordinatedMutation(async () => {
      await load();
      const instant = egeMockInstant(now);
      let changed = false;
      for (const entry of state.ege_mock_attempts) {
        if (entry.username === username) {
          changed = reconcileEgeMockAttemptWithDerivedProjections(username, entry, instant) || changed;
        }
      }
      if (changed) await persist();
      const attempts = state.ege_mock_attempts.filter((entry) => entry.username === username)
        .sort((left, right) => String(right.created_at).localeCompare(String(left.created_at)));
      return egeMockAttemptPublicDto(egeMockStartDecision(attempts).active);
    });
  }

  async function getEgeMockAttempt(username, attemptId, { now = () => new Date() } = {}) {
    return serializeCoordinatedMutation(async () => {
      await load();
      const instant = egeMockInstant(now);
      const attempt = state.ege_mock_attempts.find((entry) => (
        entry.username === username && entry.id === attemptId
      ));
      if (attempt && reconcileEgeMockAttemptWithDerivedProjections(username, attempt, instant)) {
        await persist();
      }
      return egeMockAttemptPublicDto(attempt);
    });
  }

  function egeMockMutationReplay(username, attemptId, idempotencyKey, operation, requestHash) {
    const reusedStart = state.ege_mock_attempts.find((attempt) => (
      attempt.username === username && attempt.start_idempotency_key === idempotencyKey
    ));
    if (reusedStart) throw new EgeMockAttemptError('EGE_MOCK_IDEMPOTENCY_CONFLICT');
    const mutation = state.ege_mock_mutations.find((entry) => (
      entry.username === username && entry.idempotency_key === idempotencyKey
    ));
    if (!mutation) return null;
    if (mutation.attempt_id !== attemptId || mutation.operation !== operation
      || mutation.request_hash !== requestHash) {
      throw new EgeMockAttemptError('EGE_MOCK_IDEMPOTENCY_CONFLICT');
    }
    return structuredClone(mutation.response_snapshot);
  }

  function egeMockAssessmentRunMutation(username, attemptId, candidate) {
    const reusedStart = state.ege_mock_attempts.find((attempt) => (
      attempt.username === username && attempt.start_idempotency_key === candidate.idempotencyKey
    ));
    if (reusedStart) throw new EgeMockAttemptError('EGE_MOCK_IDEMPOTENCY_CONFLICT');
    const mutation = state.ege_mock_mutations.find((entry) => (
      entry.username === username && entry.idempotency_key === candidate.idempotencyKey
    ));
    if (!mutation) return null;
    if (mutation.attempt_id !== attemptId || mutation.operation !== 'assessment_run'
      || mutation.request_hash !== candidate.requestHash) {
      throw new EgeMockAttemptError('EGE_MOCK_IDEMPOTENCY_CONFLICT');
    }
    return mutation;
  }

  function requireEgeMockOwner(username, now) {
    const instant = egeMockInstant(now);
    if (!state.users[username]) throw new EgeMockAttemptError('EGE_MOCK_OWNER_NOT_FOUND');
    return instant;
  }

  function requireEgeMockSubscription(username, now) {
    const instant = requireEgeMockOwner(username, now);
    if (Number(state.users[username].sub_until || 0) <= instant.getTime()) {
      throw new EgeMockAttemptError('SUBSCRIPTION_REQUIRED');
    }
    return instant;
  }

  function syncEgeMockErrorFocus(username, attempt) {
    const entries = egeMockErrorFocusEntries(
      attempt, getEgeMockForm(attempt.form_id, attempt.form_revision),
    );
    let changed = false;
    for (const item of entries) {
      const existing = state.error_bank.find((entry) => entry.username === username
        && entry.module === item.module && entry.item_key === item.itemKey
        && entry.error_type === item.errorType);
      if (existing) continue;
      const observedAt = Date.parse(attempt.oral_submitted_at);
      state.error_bank.push({
        id: Math.max(0, ...state.error_bank.map(({ id }) => Number(id) || 0)) + 1,
        username,
        module: item.module,
        item_key: item.itemKey,
        error_type: item.errorType,
        details: structuredClone(item.details),
        occurrence_count: 1,
        first_seen_at: observedAt,
        last_seen_at: observedAt,
        resolved_at: null,
      });
      changed = true;
    }
    return changed;
  }

  function syncEgeMockDerivedProjections(username, attempt, { focus = true } = {}) {
    const form = getEgeMockForm(attempt.form_id, attempt.form_revision);
    const resultChanged = refreshEgeMockStoredResult(attempt, form);
    const focusChanged = focus ? syncEgeMockErrorFocus(username, attempt) : false;
    return resultChanged || focusChanged;
  }

  function reconcileEgeMockAttemptWithDerivedProjections(username, attempt, instant) {
    const reconciled = reconcileEgeMockAttempt(attempt, instant);
    if (reconciled) syncEgeMockDerivedProjections(username, attempt);
    return reconciled;
  }

  async function mutateEgeMockAttempt(
    username, attemptId, operation, candidate, { now = () => new Date() } = {}, apply,
  ) {
    return serializeCoordinatedMutation(async () => {
      await load();
      const instant = requireEgeMockSubscription(username, now);
      const replay = egeMockMutationReplay(
        username, attemptId, candidate.idempotencyKey, operation, candidate.requestHash,
      );
      if (replay) return { ...replay, replayed: true };
      const attempt = state.ege_mock_attempts.find((entry) => (
        entry.username === username && entry.id === attemptId
      ));
      if (!attempt) throw new EgeMockAttemptError('EGE_MOCK_ATTEMPT_NOT_FOUND');
      const settlementDeferred = shouldSettleEgeMockOralStageBeforeReconcile(
        attempt, operation, candidate, instant,
      );
      const reconciled = settlementDeferred
        ? false : reconcileEgeMockAttemptWithDerivedProjections(username, attempt, instant);
      let response;
      try {
        response = await apply(attempt, instant, reconciled);
      } catch (error) {
        const reconciledAfterRejectedSettlement = settlementDeferred
          ? reconcileEgeMockAttemptWithDerivedProjections(username, attempt, instant) : false;
        if (reconciled || reconciledAfterRejectedSettlement) await persist();
        throw error;
      }
      syncEgeMockDerivedProjections(username, attempt);
      state.ege_mock_mutations.push({
        username, attempt_id: attempt.id, operation,
        idempotency_key: candidate.idempotencyKey, request_hash: candidate.requestHash,
        response_snapshot: structuredClone(response), created_at: instant.toISOString(),
      });
      await persist();
      return response;
    });
  }

  async function saveEgeMockDraft(username, attemptId, candidate, { now = () => new Date() } = {}) {
    return mutateEgeMockAttempt(username, attemptId, 'draft', candidate, { now },
      (attempt, instant) => applyEgeMockDraftMutation(attempt, {
        form: getEgeMockForm(attempt.form_id, attempt.form_revision),
        expectedRevision: candidate.expectedRevision,
        answers: candidate.answers,
        now: instant,
      }));
  }

  async function submitEgeMockWritten(username, attemptId, candidate, { now = () => new Date() } = {}) {
    return mutateEgeMockAttempt(username, attemptId, 'written_submit', candidate, { now },
      (attempt, instant, reconciled) => applyEgeMockWrittenMutation(attempt, {
        expectedRevision: candidate.expectedRevision,
        now: instant,
        receiptId: crypto.randomUUID(),
        reconciled,
      }));
  }

  async function startEgeMockOral(username, attemptId, candidate, { now = () => new Date() } = {}) {
    return mutateEgeMockAttempt(username, attemptId, 'oral_start', candidate, { now },
      (attempt, instant) => applyEgeMockOralStartMutation(attempt, {
        expectedRevision: candidate.expectedRevision,
        now: instant,
        form: getEgeMockForm(attempt.form_id, attempt.form_revision),
      }));
  }

  async function submitEgeMockOral(username, attemptId, candidate, { now = () => new Date() } = {}) {
    return mutateEgeMockAttempt(username, attemptId, 'oral_submit', candidate, { now },
      (attempt, instant, reconciled) => applyEgeMockOralMutation(attempt, {
        expectedRevision: candidate.expectedRevision,
        recordings: candidate.recordings,
        now: instant,
        receiptId: crypto.randomUUID(),
        reconciled,
      }));
  }

  async function advanceEgeMockOralStage(username, attemptId, candidate, { now = () => new Date() } = {}) {
    return mutateEgeMockAttempt(username, attemptId, 'oral_stage', candidate, { now },
      (attempt, instant) => applyEgeMockOralStageMutation(attempt, {
        form: getEgeMockForm(attempt.form_id, attempt.form_revision),
        expectedRevision: candidate.expectedRevision,
        action: candidate.action,
        position: candidate.position,
        responseNumber: candidate.responseNumber,
        recording: candidate.recording,
        now: instant,
      }));
  }

  async function syncEgeMockSpeakingBridge(username, attemptId, { now = () => new Date() } = {}) {
    return serializeCoordinatedMutation(async () => {
      await load();
      const instant = requireEgeMockOwner(username, now);
      const attempt = state.ege_mock_attempts.find((entry) => (
        entry.username === username && entry.id === attemptId
      ));
      if (!attempt) throw new EgeMockAttemptError('EGE_MOCK_ATTEMPT_NOT_FOUND');
      const index = state.speaking_full_sessions.findIndex((entry) => (
        entry.username === username && entry.id === attemptId
      ));
      const existing = index < 0 ? null : state.speaking_full_sessions[index];
      const session = syncEgeMockFullSpeakingSession(existing, {
        username,
        attempt,
        form: getEgeMockForm(attempt.form_id, attempt.form_revision),
        accentProfile: state.speaking_accent_profiles[username] || null,
        now: instant,
      });
      if (index < 0) state.speaking_full_sessions.push(session);
      else state.speaking_full_sessions[index] = session;
      await persist();
      return structuredClone(session);
    });
  }

  async function getEgeMockResult(username, attemptId) {
    return serializeCoordinatedMutation(async () => {
      await load();
      const attempt = state.ege_mock_attempts.find((entry) => (
        entry.username === username && entry.id === attemptId
      ));
      if (!attempt) return null;
      return egeMockResultPublicDto(attempt);
    });
  }

  async function getEgeMockHistory(username, {
    now = () => new Date(), includeAttemptId = null,
  } = {}) {
    return serializeCoordinatedMutation(async () => {
      await load();
      if (!state.users[username]) return { baselineAttemptId: null, attempts: [] };
      const instant = egeMockInstant(now);
      let changed = false;
      for (const entry of state.ege_mock_attempts) {
        if (entry.username === username) {
          changed = reconcileEgeMockAttemptWithDerivedProjections(username, entry, instant) || changed;
        }
      }
      if (changed) await persist();
      const attempts = selectEgeMockHistoryRows(
        state.ege_mock_attempts.filter((entry) => entry.username === username),
        { includeAttemptId },
      );
      return buildEgeMockHistory(attempts, getEgeMockForm, { includeAttemptId });
    });
  }

  async function beginEgeMockAssessmentRun(
    username, attemptId, candidate, { now = () => new Date() } = {},
  ) {
    return serializeCoordinatedMutation(async () => {
      await load();
      const instant = requireEgeMockOwner(username, now);
      const existing = egeMockAssessmentRunMutation(username, attemptId, candidate);
      if (existing && existing.response_snapshot?.commandStatus !== 'pending') {
        const replay = egeMockAssessmentRunBeginDecision({
          responseSnapshot: existing.response_snapshot,
        });
        return { finalized: replay.finalized, response: replay.response };
      }
      const attempt = state.ege_mock_attempts.find((entry) => (
        entry.username === username && entry.id === attemptId
      ));
      if (!attempt) throw new EgeMockAttemptError('EGE_MOCK_ATTEMPT_NOT_FOUND');
      const reconciled = reconcileEgeMockAttemptWithDerivedProjections(username, attempt, instant);
      if (!attempt.writing_assessment) {
        throw new EgeMockAttemptError('EGE_MOCK_ASSESSMENT_STATE_INVALID');
      }
      const publicAttempt = egeMockAttemptPublicDto(attempt);
      if (!egeMockAssessmentRunCanSettleTerminalSnapshot({
        responseSnapshot: existing?.response_snapshot || null,
        attempt: publicAttempt,
      })) assertEgeMockWritingAssessmentRevisionAvailable(attempt.writing_assessment);
      const decision = egeMockAssessmentRunBeginDecision({
        responseSnapshot: existing?.response_snapshot || null,
        attempt: publicAttempt,
        subscriptionActive: Number(state.users[username].sub_until || 0) > instant.getTime(),
        hasFrozenAuthorization: Boolean(attempt.writing_assessment.authorization),
        explicitRenewal: candidate.explicitRenewal === true,
      });
      applyEgeMockAssessmentRunDisposition(attempt, decision, { now: instant });
      if (decision.kind === 'start') {
        state.ege_mock_mutations.push({
          username, attempt_id: attempt.id, operation: 'assessment_run',
          idempotency_key: candidate.idempotencyKey, request_hash: candidate.requestHash,
          response_snapshot: structuredClone(decision.responseSnapshot), created_at: instant.toISOString(),
        });
      } else if (decision.kind === 'finalize') {
        if (existing) existing.response_snapshot = structuredClone(decision.responseSnapshot);
        else {
          state.ege_mock_mutations.push({
            username, attempt_id: attempt.id, operation: 'assessment_run',
            idempotency_key: candidate.idempotencyKey, request_hash: candidate.requestHash,
            response_snapshot: structuredClone(decision.responseSnapshot), created_at: instant.toISOString(),
          });
        }
      }
      if (decision.kind !== 'resume' || reconciled) await persist();
      return decision.finalized
        ? { finalized: true, response: decision.response }
        : { finalized: false };
    });
  }

  async function settleEgeMockAssessmentRun(
    username, attemptId, candidate, { now = () => new Date() } = {},
  ) {
    return serializeCoordinatedMutation(async () => {
      await load();
      const instant = requireEgeMockOwner(username, now);
      const mutation = egeMockAssessmentRunMutation(username, attemptId, candidate);
      if (!mutation) throw new EgeMockAttemptError('EGE_MOCK_ASSESSMENT_STATE_INVALID');
      if (mutation.response_snapshot?.commandStatus !== 'pending') {
        return egeMockAssessmentRunSettlement({
          responseSnapshot: mutation.response_snapshot,
        }).response;
      }
      const attempt = state.ege_mock_attempts.find((entry) => (
        entry.username === username && entry.id === attemptId
      ));
      if (!attempt) throw new EgeMockAttemptError('EGE_MOCK_ATTEMPT_NOT_FOUND');
      const reconciled = reconcileEgeMockAttemptWithDerivedProjections(username, attempt, instant);
      const publicAttempt = egeMockAttemptPublicDto(attempt);
      const decision = egeMockAssessmentRunSettlement({
        responseSnapshot: mutation.response_snapshot,
        attempt: publicAttempt,
        attemptChanged: reconciled,
      });
      if (decision.kind === 'finalize') {
        mutation.response_snapshot = structuredClone(decision.response);
      }
      if (decision.kind === 'finalize' || decision.persistAttempt) await persist();
      return decision.response;
    });
  }

  async function markEgeMockAssessmentRetryable(username, attemptId, {
    reason, now = () => new Date(),
  } = {}) {
    return serializeCoordinatedMutation(async () => {
      await load();
      const attempt = state.ege_mock_attempts.find((entry) => (
        entry.username === username && entry.id === attemptId
      ));
      const instant = egeMockInstant(now);
      if (!attempt) throw new EgeMockAttemptError('EGE_MOCK_ASSESSMENT_STATE_INVALID');
      const response = applyEgeMockAssessmentRetryable(attempt, { reason, now: instant });
      syncEgeMockDerivedProjections(username, attempt);
      await persist();
      return response;
    });
  }

  async function retryEgeMockAssessment(username, attemptId, candidate, { now = () => new Date() } = {}) {
    return mutateEgeMockAttempt(username, attemptId, 'assessment_retry', candidate, { now },
      (attempt, instant) => applyEgeMockAssessmentRetryMutation(attempt, {
        now: instant,
        acknowledgePossibleProviderRepeat: candidate?.acknowledgePossibleProviderRepeat,
      }));
  }

  async function claimEgeMockWritingAssessment(username, attemptId, {
    claimToken, authorization = null, now = () => new Date(),
  } = {}) {
    return serializeCoordinatedMutation(async () => {
      await load();
      const instant = requireEgeMockOwner(username, now);
      const attempt = state.ege_mock_attempts.find((entry) => (
        entry.username === username && entry.id === attemptId
      ));
      if (!attempt) throw new EgeMockAttemptError('EGE_MOCK_ATTEMPT_NOT_FOUND');
      let frozenAuthorization = authorization;
      if (!attempt.writing_assessment?.authorization) {
        const subscriptionUntil = Number(state.users[username].sub_until || 0);
        if (subscriptionUntil <= instant.getTime()) {
          throw new EgeMockAttemptError('SUBSCRIPTION_REQUIRED');
        }
        const consent = state.users[username].privacy_consent || {};
        const requiredPolicyVersion = typeof authorization?.consentPolicyVersion === 'string'
          && authorization.consentPolicyVersion ? authorization.consentPolicyVersion : null;
        frozenAuthorization = {
          textProcessingConsent: requiredPolicyVersion != null
            && consent.text_processing === true
            && consent.policy_version === requiredPolicyVersion,
          consentPolicyVersion: requiredPolicyVersion,
          subscriptionExpiresAt: new Date(subscriptionUntil).toISOString(),
        };
      }
      reconcileEgeMockAttemptWithDerivedProjections(username, attempt, instant);
      const response = applyEgeMockWritingAssessmentClaim(attempt, {
        form: getEgeMockForm(attempt.form_id, attempt.form_revision), claimToken,
        authorization: frozenAuthorization, now: instant,
      });
      syncEgeMockDerivedProjections(username, attempt, { focus: false });
      await persist();
      return response;
    });
  }

  async function renewEgeMockWritingAssessmentClaim(username, attemptId, {
    claimToken, now = () => new Date(),
  } = {}) {
    return serializeCoordinatedMutation(async () => {
      await load();
      const instant = requireEgeMockOwner(username, now);
      const attempt = state.ege_mock_attempts.find((entry) => (
        entry.username === username && entry.id === attemptId
      ));
      if (!attempt) throw new EgeMockAttemptError('EGE_MOCK_ATTEMPT_NOT_FOUND');
      const response = applyEgeMockWritingAssessmentClaimRenewal(attempt, {
        claimToken, now: instant,
      });
      syncEgeMockDerivedProjections(username, attempt, { focus: false });
      await persist();
      return response;
    });
  }

  async function completeEgeMockWritingAssessmentItem(username, attemptId, {
    claimToken, position, outcomeToken, now = () => new Date(),
  } = {}) {
    return serializeCoordinatedMutation(async () => {
      await load();
      const instant = requireEgeMockOwner(username, now);
      const attempt = state.ege_mock_attempts.find((entry) => (
        entry.username === username && entry.id === attemptId
      ));
      if (!attempt) throw new EgeMockAttemptError('EGE_MOCK_ATTEMPT_NOT_FOUND');
      const response = applyEgeMockWritingAssessmentItemCompletion(attempt, {
        claimToken, position, outcomeToken, now: instant,
      });
      syncEgeMockDerivedProjections(username, attempt);
      await persist();
      return response;
    });
  }

  async function prepareEgeMockWritingAssessmentItemOutcome(username, attemptId, {
    claimToken, position, outcomeToken, now = () => new Date(),
  } = {}) {
    return serializeCoordinatedMutation(async () => {
      await load();
      const instant = requireEgeMockOwner(username, now);
      const attempt = state.ege_mock_attempts.find((entry) => (
        entry.username === username && entry.id === attemptId
      ));
      if (!attempt) throw new EgeMockAttemptError('EGE_MOCK_ATTEMPT_NOT_FOUND');
      const response = applyEgeMockWritingAssessmentItemOutcomePreparation(attempt, {
        claimToken, position, outcomeToken, now: instant,
      });
      syncEgeMockDerivedProjections(username, attempt, { focus: false });
      await persist();
      return response;
    });
  }

  async function recordEgeMockWritingAssessmentItemOutcome(username, attemptId, candidate = {}) {
    return serializeCoordinatedMutation(async () => {
      await load();
      const instant = requireEgeMockOwner(username, candidate.now || (() => new Date()));
      const attempt = state.ege_mock_attempts.find((entry) => (
        entry.username === username && entry.id === attemptId
      ));
      if (!attempt) throw new EgeMockAttemptError('EGE_MOCK_ATTEMPT_NOT_FOUND');
      const response = applyEgeMockWritingAssessmentItemOutcome(attempt, {
        ...candidate, now: instant,
      });
      syncEgeMockDerivedProjections(username, attempt);
      await persist();
      return response;
    });
  }

  async function failEgeMockWritingAssessment(username, attemptId, {
    claimToken, reason, discardPreparedOutcome = false, now = () => new Date(),
  } = {}) {
    return serializeCoordinatedMutation(async () => {
      await load();
      const instant = requireEgeMockOwner(username, now);
      const attempt = state.ege_mock_attempts.find((entry) => (
        entry.username === username && entry.id === attemptId
      ));
      if (!attempt) throw new EgeMockAttemptError('EGE_MOCK_ATTEMPT_NOT_FOUND');
      const response = applyEgeMockWritingAssessmentFailure(attempt, {
        claimToken, reason, discardPreparedOutcome, now: instant,
      });
      syncEgeMockDerivedProjections(username, attempt);
      await persist();
      return response;
    });
  }

  function speakingAssessmentRows(username) {
    return state.speaking_assessments.filter((row) => row.username === username);
  }

  function speakingAssessmentQuota(username, now) {
    return speakingAssessmentQuotaView(speakingAssessmentRows(username), {
      premium: hasVoiceTutorEntitlement(username, new Date(now).getTime()), now,
    });
  }

  function publicSpeakingAssessment(row) {
    return structuredClone(row);
  }

  function reconcileSpeakingAssessmentLeases(username, now) {
    const instant = new Date(now);
    speakingAssessmentPeriodStart(instant);
    const cutoffMs = instant.getTime() - SPEAKING_ASSESSMENT_LEASE_MS;
    let changed = false;
    for (const row of speakingAssessmentRows(username)) {
      if (row.status === 'reserved' && Date.parse(row.reserved_at) <= cutoffMs) {
        row.status = 'released';
        row.billable_seconds = 0;
        row.released_at = instant.toISOString();
        row.release_reason = 'process_interrupted_before_start';
        row.result = interruptedSpeakingAssessmentResult(row, { processingStarted: false });
        changed = true;
      } else if (row.status === 'dispatching' && Date.parse(row.dispatch_started_at) <= cutoffMs) {
        row.status = 'finalized';
        row.billable_seconds = Number(row.reserved_seconds);
        row.finalized_at = instant.toISOString();
        row.result = interruptedSpeakingAssessmentResult(row, {
          reason: 'process_interrupted_during_dispatch',
        });
        changed = true;
      } else if (row.status === 'started' && Date.parse(row.provider_started_at) <= cutoffMs) {
        row.status = 'finalized';
        row.billable_seconds = Number(row.reserved_seconds);
        row.finalized_at = instant.toISOString();
        row.result = interruptedSpeakingAssessmentResult(row);
        changed = true;
      }
    }
    return changed;
  }

  async function getSpeakingAssessmentQuota(username, { now = new Date() } = {}) {
    return serializeCoordinatedMutation(async () => {
      await load();
      if (!state.users[username]) throw new Error('USER_NOT_FOUND');
      if (reconcileSpeakingAssessmentLeases(username, now)) await persist();
      return speakingAssessmentQuota(username, now);
    });
  }

  async function getSpeakingAssessmentReservation(username, idempotencyKey, { now = new Date() } = {}) {
    return serializeCoordinatedMutation(async () => {
      await load();
      if (!state.users[username]) throw new Error('USER_NOT_FOUND');
      const key = assertSpeakingAssessmentIdempotencyKey(idempotencyKey);
      if (reconcileSpeakingAssessmentLeases(username, now)) await persist();
      const reservation = state.speaking_assessments.find((row) => (
        row.username === username && row.idempotency_key === key
      ));
      return {
        reservation: reservation ? publicSpeakingAssessment(reservation) : null,
        quota: speakingAssessmentQuota(username, now),
      };
    });
  }

  async function reserveSpeakingAssessment(username, input) {
    return serializeCoordinatedMutation(async () => {
      await load();
      if (!state.users[username]) throw new Error('USER_NOT_FOUND');
      const candidate = assertSpeakingAssessmentReservation(input);
      if (reconcileSpeakingAssessmentLeases(username, candidate.now)) await persist();
      const existing = state.speaking_assessments.find((row) => (
        row.username === username && row.idempotency_key === candidate.idempotencyKey
      ));
      if (existing) {
        if (existing.request_hash !== candidate.requestHash) {
          throw new SpeakingAssessmentQuotaError('SPEAKING_ASSESSMENT_IDEMPOTENCY_CONFLICT');
        }
        return {
          created: false,
          reservation: publicSpeakingAssessment(existing),
          quota: speakingAssessmentQuota(username, candidate.now),
        };
      }
      const quota = speakingAssessmentQuota(username, candidate.now);
      if (candidate.reservedSeconds > quota.remainingSeconds) {
        throw new SpeakingAssessmentQuotaError('SPEAKING_ASSESSMENT_QUOTA_EXHAUSTED');
      }
      const row = {
        id: candidate.id,
        username,
        idempotency_key: candidate.idempotencyKey,
        request_hash: candidate.requestHash,
        audio_hash: candidate.audioHash,
        status: 'reserved',
        locale: candidate.locale,
        context_id: candidate.contextId,
        period_start: candidate.periodStart.toISOString(),
        allowance_seconds: quota.limitSeconds,
        reserved_seconds: candidate.reservedSeconds,
        billable_seconds: null,
        reserved_at: candidate.now.toISOString(),
        dispatch_started_at: null,
        provider_started_at: null,
        finalized_at: null,
        released_at: null,
        release_reason: null,
        result: null,
      };
      state.speaking_assessments.push(row);
      await persist();
      return {
        created: true,
        reservation: publicSpeakingAssessment(row),
        quota: speakingAssessmentQuota(username, candidate.now),
      };
    });
  }

  async function dispatchSpeakingAssessment(username, idempotencyKey, { now = new Date() } = {}) {
    return serializeCoordinatedMutation(async () => {
      await load();
      const row = state.speaking_assessments.find((item) => (
        item.username === username && item.idempotency_key === idempotencyKey
      ));
      if (!row) throw new SpeakingAssessmentQuotaError('SPEAKING_ASSESSMENT_RESERVATION_NOT_FOUND');
      if (row.status === 'released') throw new SpeakingAssessmentQuotaError('SPEAKING_ASSESSMENT_ALREADY_RELEASED');
      let dispatched = false;
      if (row.status === 'reserved') {
        const instant = new Date(now);
        if (!Number.isFinite(instant.getTime())) throw new SpeakingAssessmentQuotaError('SPEAKING_ASSESSMENT_TIME_INVALID');
        row.status = 'dispatching';
        row.dispatch_started_at = instant.toISOString();
        dispatched = true;
        await persist();
      }
      return {
        dispatched,
        reservation: publicSpeakingAssessment(row),
        quota: speakingAssessmentQuota(username, now),
      };
    });
  }

  async function startSpeakingAssessment(username, idempotencyKey, { now = new Date() } = {}) {
    return serializeCoordinatedMutation(async () => {
      await load();
      const row = state.speaking_assessments.find((item) => (
        item.username === username && item.idempotency_key === idempotencyKey
      ));
      if (!row) throw new SpeakingAssessmentQuotaError('SPEAKING_ASSESSMENT_RESERVATION_NOT_FOUND');
      if (row.status === 'released') throw new SpeakingAssessmentQuotaError('SPEAKING_ASSESSMENT_ALREADY_RELEASED');
      if (row.status === 'reserved') throw new SpeakingAssessmentQuotaError('SPEAKING_ASSESSMENT_NOT_DISPATCHED');
      let started = false;
      if (row.status === 'dispatching') {
        const instant = new Date(now);
        if (!Number.isFinite(instant.getTime())) throw new SpeakingAssessmentQuotaError('SPEAKING_ASSESSMENT_TIME_INVALID');
        row.status = 'started';
        row.provider_started_at = instant.toISOString();
        started = true;
        await persist();
      }
      return {
        started,
        reservation: publicSpeakingAssessment(row),
        quota: speakingAssessmentQuota(username, now),
      };
    });
  }

  async function finalizeSpeakingAssessment(username, idempotencyKey, {
    billableSeconds, result, now = new Date(),
  } = {}) {
    return serializeCoordinatedMutation(async () => {
      await load();
      const row = state.speaking_assessments.find((item) => (
        item.username === username && item.idempotency_key === idempotencyKey
      ));
      if (!row) throw new SpeakingAssessmentQuotaError('SPEAKING_ASSESSMENT_RESERVATION_NOT_FOUND');
      if (row.status === 'finalized') return {
        finalized: false,
        reservation: publicSpeakingAssessment(row),
        quota: speakingAssessmentQuota(username, now),
      };
      if (row.status !== 'started') throw new SpeakingAssessmentQuotaError('SPEAKING_ASSESSMENT_NOT_STARTED');
      const seconds = Number(billableSeconds);
      const instant = new Date(now);
      if (!Number.isInteger(seconds) || seconds < 0 || seconds > Number(row.reserved_seconds)
        || !result || typeof result !== 'object' || Array.isArray(result)
        || !Number.isFinite(instant.getTime())) {
        throw new SpeakingAssessmentQuotaError('SPEAKING_ASSESSMENT_FINALIZATION_INVALID');
      }
      row.status = 'finalized';
      row.billable_seconds = seconds;
      row.result = structuredClone(result);
      row.finalized_at = instant.toISOString();
      await persist();
      return {
        finalized: true,
        reservation: publicSpeakingAssessment(row),
        quota: speakingAssessmentQuota(username, instant),
      };
    });
  }

  async function releaseSpeakingAssessment(username, idempotencyKey, {
    reason, result, now = new Date(),
  } = {}) {
    return serializeCoordinatedMutation(async () => {
      await load();
      const row = state.speaking_assessments.find((item) => (
        item.username === username && item.idempotency_key === idempotencyKey
      ));
      if (!row) throw new SpeakingAssessmentQuotaError('SPEAKING_ASSESSMENT_RESERVATION_NOT_FOUND');
      if (row.status === 'released' || row.status === 'finalized') return {
        released: false,
        reservation: publicSpeakingAssessment(row),
        quota: speakingAssessmentQuota(username, now),
      };
      if (!['reserved', 'dispatching'].includes(row.status)
        || !/^[a-z][a-z0-9_]{0,63}$/u.test(String(reason || ''))
        || !result || typeof result !== 'object' || Array.isArray(result)) {
        throw new SpeakingAssessmentQuotaError('SPEAKING_ASSESSMENT_RELEASE_INVALID');
      }
      const instant = new Date(now);
      if (!Number.isFinite(instant.getTime())) throw new SpeakingAssessmentQuotaError('SPEAKING_ASSESSMENT_TIME_INVALID');
      row.status = 'released';
      row.billable_seconds = 0;
      row.released_at = instant.toISOString();
      row.release_reason = String(reason);
      row.result = structuredClone(result);
      await persist();
      return {
        released: true,
        reservation: publicSpeakingAssessment(row),
        quota: speakingAssessmentQuota(username, instant),
      };
    });
  }

  function publicVoiceTutorSession(session) {
    return {
      id: session.id,
      status: session.status,
      state: session.pedagogical_state || null,
      micro_check_passed: session.micro_check_passed ?? null,
      transfer_passed: session.transfer_passed ?? null,
      outcome: session.outcome ?? null,
      started_at: session.started_at,
      expires_at: session.expires_at,
      ended_at: session.ended_at,
    };
  }

  async function getVoiceTutorAccess(username, limits, now = new Date()) {
    await load();
    const nowMs = new Date(now).getTime();
    return voiceTutorAccessView({ entitled: hasVoiceTutorEntitlement(username, nowMs), ...voiceTutorUsage(username, now) }, limits);
  }

  async function reserveVoiceTutorSession(username, {
    id, idempotencyKey, limits, context = null, allowFallbackOnly = false,
  }) {
    return serializeVoiceTutorMutation(async () => {
      await load();
      const stateBeforeReservation = structuredClone(state);
      try {
        if (!state.users[username]) throw new Error('USER_NOT_FOUND');
        const effectiveNow = voiceTutorMutationEffectiveNow();
        const expired = expireVoiceTutorSessions(username, effectiveNow);
        const usage = voiceTutorUsage(username, effectiveNow);
        const access = voiceTutorAccessView({
          entitled: hasVoiceTutorEntitlement(username, effectiveNow.getTime()), ...usage,
        }, limits);
        requireVoiceTutorEntitlement(username, effectiveNow.getTime());
        const existing = state.voice_tutor_sessions.find((session) => session.username === username && session.idempotency_key === idempotencyKey);
        if (existing) {
          const validatedCapsule = revalidateVoiceTutorPronunciationCapsule(
            username, existing.capsule, effectiveNow,
          );
          if (expired) await persist();
          return {
            created: false, session: publicVoiceTutorSession(existing), ...access,
            ...(validatedCapsule ? { capsule: validatedCapsule } : {}),
          };
        }
        const validatedCapsule = context?.capsule
          ? revalidateVoiceTutorPronunciationCapsule(username, context.capsule, effectiveNow) : null;
        const storedContextCapsule = validatedCapsule
          ? persistedVoiceTutorCapsule(validatedCapsule) : context?.capsule;
        let reservedSeconds;
        let fallbackOnly = false;
        try {
          reservedSeconds = voiceTutorReservationSeconds(access, limits.sessionSeconds);
        } catch (error) {
          if (!context || !allowFallbackOnly || !['VOICE_TUTOR_DAILY_QUOTA_EXHAUSTED', 'VOICE_TUTOR_MONTHLY_QUOTA_EXHAUSTED'].includes(error?.code)) throw error;
          reservedSeconds = 0;
          fallbackOnly = true;
        }
        const startedAt = effectiveNow;
        const session = {
          id,
          username,
          idempotency_key: idempotencyKey,
          status: 'active',
          reserved_seconds: reservedSeconds,
          billable_seconds: null,
          started_at: startedAt.toISOString(),
          expires_at: new Date(startedAt.getTime() + (fallbackOnly ? limits.sessionSeconds : reservedSeconds) * 1000).toISOString(),
          ended_at: null,
          ...(context ? {
            capsule: structuredClone(storedContextCapsule),
            capsule_id: storedContextCapsule.id,
            nonce_hash: context.nonceHash,
            delivery_mode: fallbackOnly ? 'local' : 'voice',
            voice_activated_at: null,
            provider: null,
            model: null,
            prompt_version: null,
            proxy_ticket_reissue_count: 0,
            pedagogical_state: 'diagnose',
            micro_check_passed: null,
            micro_check_attempts: 0,
            micro_check_passes: 0,
            clarification_turns: 0,
            transfer_passed: null,
            outcome: null,
          } : {}),
        };
        state.voice_tutor_sessions.push(session);
        const updatedAccess = voiceTutorAccessView({
          entitled: true, ...voiceTutorUsage(username, effectiveNow),
        }, limits);
        await persist();
        return {
          created: true, fallback_only: fallbackOnly,
          session: publicVoiceTutorSession(session), ...updatedAccess,
          ...(validatedCapsule ? { capsule: validatedCapsule } : {}),
        };
      } catch (error) {
        state = stateBeforeReservation;
        throw error;
      }
    });
  }

  async function getVoiceTutorSession(username, sessionId) {
    await load();
    const session = state.voice_tutor_sessions.find((entry) => entry.username === username && entry.id === sessionId);
    return session ? structuredClone(session) : null;
  }

  async function activateVoiceTutorSession(username, sessionId, { nonceHash, now = new Date() }) {
    return serializeVoiceTutorMutation(async () => {
      await load();
      const session = state.voice_tutor_sessions.find((entry) => entry.username === username && entry.id === sessionId);
      if (!session || !session.capsule || session.delivery_mode !== 'voice' || session.status !== 'active') {
        throw new VoiceTutorError('VOICE_TUTOR_SESSION_NOT_FOUND');
      }
      if (!session.nonce_hash || session.nonce_hash !== nonceHash) throw new VoiceTutorError('VOICE_TUTOR_NONCE_REPLAYED');
      const nowMs = new Date(now).getTime();
      if (nowMs < new Date(session.started_at).getTime() || new Date(session.expires_at).getTime() <= nowMs) {
        throw new VoiceTutorError('VOICE_TUTOR_SESSION_EXPIRED');
      }
      if (!session.voice_activated_at) {
        session.voice_activated_at = new Date(now).toISOString();
        session.updated_at = session.voice_activated_at;
        await persist();
      }
      return { session: publicVoiceTutorSession(session), capsule: structuredClone(session.capsule) };
    });
  }

  function proxyTicketView(session) {
    return {
      session_id: session.id,
      expires_at: session.proxy_ticket_expires_at,
      consumed_at: session.proxy_ticket_consumed_at || null,
    };
  }

  async function issueVoiceTutorProxyTicket(username, sessionId, {
    ticketHash, idempotencyKey, expiresAt, reissue = false, nextNonceHash,
  }) {
    return serializeVoiceTutorMutation(async () => {
      await load();
      const instant = voiceTutorMutationEffectiveNow();
      const ticketExpiresAt = new Date(expiresAt);
      const hash = normalizeVoiceTutorProxyHash(ticketHash);
      requireVoiceTutorEntitlement(username, instant.getTime());
      const session = state.voice_tutor_sessions.find((entry) => entry.username === username && entry.id === sessionId);
      if (!session?.capsule) throw new VoiceTutorError('VOICE_TUTOR_SESSION_NOT_FOUND');
      revalidateVoiceTutorPronunciationCapsule(username, session.capsule, instant);
      if (session.idempotency_key !== idempotencyKey) throw new VoiceTutorError('VOICE_TUTOR_PROXY_TICKET_INVALID');
      if (session.status !== 'active' || !Number.isFinite(instant.getTime())
        || new Date(session.expires_at).getTime() <= instant.getTime()) {
        throw new VoiceTutorError('VOICE_TUTOR_SESSION_EXPIRED');
      }
      if (!Number.isFinite(ticketExpiresAt.getTime()) || ticketExpiresAt.getTime() <= instant.getTime()
        || ticketExpiresAt.getTime() > new Date(session.expires_at).getTime()) {
        throw new VoiceTutorError('VOICE_TUTOR_PROXY_TICKET_INVALID');
      }
      if (session.proxy_ticket_hash === hash) {
        return { issued: false, reissued: false, ticket: proxyTicketView(session) };
      }
      const replacing = Boolean(session.proxy_ticket_hash);
      const rotatingNonce = nextNonceHash != null;
      if (replacing && !reissue) throw new VoiceTutorError('VOICE_TUTOR_PROXY_TICKET_ALREADY_ISSUED');
      if (replacing && session.proxy_ticket_consumed_at) throw new VoiceTutorError('VOICE_TUTOR_PROXY_TICKET_REPLAYED');
      if ((replacing || rotatingNonce) && Number(session.proxy_ticket_reissue_count || 0) >= 1) {
        throw new VoiceTutorError('VOICE_TUTOR_PROXY_TICKET_REISSUE_LIMIT');
      }
      if (state.voice_tutor_sessions.some((entry) => entry.id !== session.id && entry.proxy_ticket_hash === hash)) {
        throw new VoiceTutorError('VOICE_TUTOR_PROXY_TICKET_INVALID');
      }
      if (rotatingNonce) session.nonce_hash = normalizeVoiceTutorProxyHash(nextNonceHash);
      if (replacing || rotatingNonce) session.proxy_ticket_reissue_count = Number(session.proxy_ticket_reissue_count || 0) + 1;
      session.proxy_ticket_hash = hash;
      session.proxy_ticket_issued_at = instant.toISOString();
      session.proxy_ticket_expires_at = ticketExpiresAt.toISOString();
      session.proxy_ticket_consumed_at = null;
      session.updated_at = instant.toISOString();
      await persist();
      return { issued: true, reissued: replacing, ticket: proxyTicketView(session) };
    });
  }

  async function reissueVoiceTutorFallbackNonce(username, sessionId, {
    idempotencyKey, nextNonceHash, recoverLostRealtime = false,
  }) {
    return serializeVoiceTutorMutation(async () => {
      await load();
      const effectiveNow = voiceTutorMutationEffectiveNow();
      requireVoiceTutorEntitlement(username, effectiveNow.getTime());
      const session = state.voice_tutor_sessions.find((entry) => entry.username === username && entry.id === sessionId);
      revalidateVoiceTutorPronunciationCapsule(username, session?.capsule, effectiveNow);
      const provisionalVoice = session?.delivery_mode === 'voice' && !session.proxy_ticket_hash && !session.voice_activated_at;
      const lostRealtime = recoverLostRealtime && session?.delivery_mode === 'voice'
        && Boolean(session.proxy_ticket_hash) && !session.proxy_ticket_consumed_at && !session.voice_activated_at
        && Number(session.proxy_ticket_reissue_count || 0) === 1 && session.status === 'active';
      if (!session?.capsule || (!provisionalVoice && !lostRealtime
        && ![null, undefined, 'text', 'local'].includes(session.delivery_mode))) {
        throw new VoiceTutorError('VOICE_TUTOR_SESSION_NOT_FOUND');
      }
      if (session.idempotency_key !== idempotencyKey) throw new VoiceTutorError('VOICE_TUTOR_PROXY_TICKET_INVALID');
      if (!lostRealtime && Number(session.proxy_ticket_reissue_count || 0) >= 1) {
        throw new VoiceTutorError('VOICE_TUTOR_PROXY_TICKET_REISSUE_LIMIT');
      }
      session.nonce_hash = normalizeVoiceTutorProxyHash(nextNonceHash);
      if (!lostRealtime) session.proxy_ticket_reissue_count = Number(session.proxy_ticket_reissue_count || 0) + 1;
      const recoveredAt = effectiveNow.toISOString();
      if (session.delivery_mode == null || provisionalVoice || lostRealtime) {
        session.delivery_mode = 'local';
        session.status = 'completed';
        session.billable_seconds = 0;
        session.ended_at = recoveredAt;
        session.error_code = 'VOICE_TUTOR_PROVIDER_UNAVAILABLE';
      }
      if (lostRealtime) {
        session.proxy_ticket_hash = null;
        session.proxy_ticket_issued_at = null;
        session.proxy_ticket_expires_at = null;
        session.proxy_ticket_consumed_at = null;
      }
      session.updated_at = recoveredAt;
      await persist();
      return { reissued: true, session: publicVoiceTutorSession(session) };
    });
  }

  async function consumeVoiceTutorProxyTicket(username, input, options = {}) {
    const { ticketHash, now = new Date(), provider, model, promptVersion } = { ...input, ...options };
    return serializeVoiceTutorMutation(async () => {
      await load();
      const hash = normalizeVoiceTutorProxyHash(ticketHash);
      const instant = new Date(now);
      const session = state.voice_tutor_sessions.find((entry) => entry.username === username
        && entry.proxy_ticket_hash === hash);
      if (!session) throw new VoiceTutorError('VOICE_TUTOR_PROXY_TICKET_INVALID');
      if (session.proxy_ticket_consumed_at) throw new VoiceTutorError('VOICE_TUTOR_PROXY_TICKET_REPLAYED');
      if (!Number.isFinite(instant.getTime()) || new Date(session.proxy_ticket_expires_at).getTime() <= instant.getTime()) {
        throw new VoiceTutorError('VOICE_TUTOR_PROXY_TICKET_EXPIRED');
      }
      if (session.status !== 'active' || new Date(session.expires_at).getTime() <= instant.getTime()) {
        throw new VoiceTutorError('VOICE_TUTOR_SESSION_EXPIRED');
      }
      const metadata = normalizeVoiceTutorDeliveryMetadata({ provider, model, promptVersion });
      session.proxy_ticket_consumed_at = instant.toISOString();
      session.provider = metadata.provider;
      session.model = metadata.model;
      session.prompt_version = metadata.prompt_version;
      session.updated_at = instant.toISOString();
      await persist();
      return {
        session: { id: session.id, reserved_seconds: session.reserved_seconds, expires_at: session.expires_at },
        capsule: structuredClone(session.capsule),
      };
    });
  }

  async function activateVoiceTutorProxySession(username, sessionId, { now = new Date() } = {}) {
    return serializeVoiceTutorMutation(async () => {
      await load();
      const instant = new Date(now);
      const session = state.voice_tutor_sessions.find((entry) => entry.username === username && entry.id === sessionId);
      if (!session?.capsule) throw new VoiceTutorError('VOICE_TUTOR_SESSION_NOT_FOUND');
      if (!session.proxy_ticket_consumed_at || session.proxy_finalized_at) {
        throw new VoiceTutorError('VOICE_TUTOR_PROXY_TICKET_INVALID');
      }
      if (session.status !== 'active' || !Number.isFinite(instant.getTime())
        || instant.getTime() < new Date(session.started_at).getTime()
        || new Date(session.expires_at).getTime() <= instant.getTime()) {
        throw new VoiceTutorError('VOICE_TUTOR_SESSION_EXPIRED');
      }
      const activated = !session.voice_activated_at;
      if (activated) {
        session.voice_activated_at = instant.toISOString();
        session.updated_at = instant.toISOString();
        await persist();
      }
      return {
        activated,
        session: { id: session.id, reserved_seconds: session.reserved_seconds, expires_at: session.expires_at },
        capsule: structuredClone(session.capsule),
      };
    });
  }

  function proxyUsageView(session) {
    return {
      input_audio_bytes: Number(session.proxy_input_audio_bytes || 0),
      output_audio_bytes: Number(session.proxy_output_audio_bytes || 0),
      confirmed: Boolean(session.proxy_usage_confirmed),
      exact: Boolean(session.proxy_usage_confirmed) && session.proxy_finalization_reason === 'completed',
      billable_seconds: Number(session.billable_seconds),
      reason: session.proxy_finalization_reason,
      finalized_at: session.proxy_finalized_at,
    };
  }

  async function finalizeVoiceTutorProxySession(username, sessionId, {
    inputAudioBytes, outputAudioBytes, confirmed, reason, now = new Date(), limits,
  }) {
    return serializeVoiceTutorMutation(async () => {
      await load();
      const session = state.voice_tutor_sessions.find((entry) => entry.username === username && entry.id === sessionId);
      if (!session?.capsule) throw new VoiceTutorError('VOICE_TUTOR_SESSION_NOT_FOUND');
      if (!session.proxy_ticket_consumed_at) throw new VoiceTutorError('VOICE_TUTOR_PROXY_TICKET_INVALID');
      if (session.proxy_finalized_at) {
        return {
          finalized: false, session: publicVoiceTutorSession(session), usage: proxyUsageView(session),
          ...await getVoiceTutorAccess(username, limits, now),
        };
      }
      const usage = voiceTutorProxyUsage(session, { inputAudioBytes, outputAudioBytes, confirmed, reason, now });
      session.status = 'completed';
      session.billable_seconds = usage.billable_seconds;
      session.ended_at = usage.finalized_at;
      session.proxy_input_audio_bytes = usage.input_audio_bytes;
      session.proxy_output_audio_bytes = usage.output_audio_bytes;
      session.proxy_usage_confirmed = usage.confirmed;
      session.proxy_finalization_reason = usage.reason;
      session.proxy_finalized_at = usage.finalized_at;
      session.updated_at = usage.finalized_at;
      await persist();
      return {
        finalized: true, session: publicVoiceTutorSession(session), usage,
        ...await getVoiceTutorAccess(username, limits, now),
      };
    });
  }

  async function advanceVoiceTutorSession(username, sessionId, { nonceHash, nextNonceHash, event, capsule = null, now = new Date() }) {
    return serializeVoiceTutorMutation(async () => {
      await load();
      const session = state.voice_tutor_sessions.find((entry) => entry.username === username && entry.id === sessionId);
      if (!session || !session.capsule) throw new VoiceTutorError('VOICE_TUTOR_SESSION_NOT_FOUND');
      if (session.delivery_mode === 'voice' && new Date(session.expires_at).getTime() <= new Date(now).getTime()) {
        throw new VoiceTutorError('VOICE_TUTOR_SESSION_EXPIRED');
      }
      if (!session.nonce_hash || session.nonce_hash !== nonceHash) throw new VoiceTutorError('VOICE_TUTOR_NONCE_REPLAYED');
      const transientCapsule = capsule || session.capsule;
      if (transientCapsule.id !== session.capsule_id || transientCapsule.version !== session.capsule.version) {
        throw new VoiceTutorError('VOICE_TUTOR_REVISION_MISMATCH');
      }
      const evaluatedMicroCheck = session.pedagogical_state === 'micro_check' && event?.type === 'check_answer';
      const next = transitionPedagogicalState({
        state: session.pedagogical_state,
        micro_check_passed: session.micro_check_passed,
        transfer_passed: session.transfer_passed,
        outcome: session.outcome,
      }, event, transientCapsule);
      session.pedagogical_state = next.state;
      session.micro_check_passed = next.micro_check_passed;
      session.transfer_passed = next.transfer_passed;
      session.outcome = next.outcome;
      if (evaluatedMicroCheck) {
        const attempts = Number(session.micro_check_attempts || 0);
        if (attempts < 100) {
          session.micro_check_attempts = attempts + 1;
          if (next.micro_check_passed) session.micro_check_passes = Number(session.micro_check_passes || 0) + 1;
        }
      }
      session.nonce_hash = nextNonceHash;
      session.updated_at = new Date(now).toISOString();
      if (event?.type === 'transfer_answer') {
        const plan = planRecoveryFromTransfer({
          ledger: createRecoveryLedger({
            recoveries: state.voice_tutor_recoveries,
            repeats: state.voice_tutor_repeats,
            attempts: state.voice_tutor_repeat_attempts,
          }),
          username,
          sessionId: session.id,
          capsule: transientCapsule,
          pedagogicalState: next,
          observedAt: now,
        });
        if (plan) {
          const superseded = new Set(plan.supersededRepeatIds);
          for (const repeat of state.voice_tutor_repeats) {
            if (superseded.has(repeat.id)) repeat.superseded_at = new Date(now).toISOString();
          }
          state.voice_tutor_recoveries.push({ ...plan.recovery });
          state.voice_tutor_repeats.push(...plan.repeats.map((repeat) => ({ ...repeat })));
        }
      }
      await persist();
      return { session: publicVoiceTutorSession(session), capsule: structuredClone(session.capsule) };
    });
  }

  async function clarifyVoiceTutorSession(username, sessionId, { nonceHash, nextNonceHash, now = new Date() }) {
    return serializeVoiceTutorMutation(async () => {
      await load();
      const session = state.voice_tutor_sessions.find((entry) => entry.username === username && entry.id === sessionId);
      if (!session?.capsule) throw new VoiceTutorError('VOICE_TUTOR_SESSION_NOT_FOUND');
      if (session.delivery_mode !== 'text' || !['diagnose', 'explain'].includes(session.pedagogical_state)) {
        throw new VoiceTutorError('VOICE_TUTOR_TRANSITION_INVALID');
      }
      if (!session.nonce_hash || session.nonce_hash !== nonceHash) throw new VoiceTutorError('VOICE_TUTOR_NONCE_REPLAYED');
      if (Number(session.clarification_turns || 0) >= 3) throw new VoiceTutorError('VOICE_TUTOR_CLARIFICATION_LIMIT');
      session.clarification_turns = Number(session.clarification_turns || 0) + 1;
      session.nonce_hash = nextNonceHash;
      session.updated_at = new Date(now).toISOString();
      await persist();
      return { session: publicVoiceTutorSession(session), capsule: structuredClone(session.capsule), clarification_turns: session.clarification_turns };
    });
  }

  function adaptiveClaimMutationContext(username, sessionId, executionClaim, now) {
    const instant = new Date(now).getTime();
    const claim = state.adaptive_learning_execution_claims.find((entry) => (
      entry.token_hash === adaptiveExecutionTokenHash(executionClaim)
    ));
    if (!claim || claim.username !== username || claim.session_id !== sessionId) {
      throw new Error('ADAPTIVE_EXECUTION_CLAIM_INVALID');
    }
    const row = adaptiveSessionRow(username, sessionId);
    const block = row?.blocks.find((item) => item.id === claim.block_id);
    if (!row || !block || row.status !== 'in_progress' || row.current_block_id !== block.id
      || Number(row.execution_revision || 0) !== Number(claim.session_execution_revision)
      || claim.revoked_at || Number(claim.expires_at) <= instant
      || claim.launch_fingerprint !== adaptiveLaunchFingerprint(block)) {
      throw new Error(Number(claim.expires_at) <= instant
        ? 'ADAPTIVE_EXECUTION_CLAIM_EXPIRED' : 'ADAPTIVE_EXECUTION_CLAIM_INVALID');
    }
    return { instant, claim, row, block };
  }

  function adaptiveRepeatBindingPlan(username, context, source, repeat, recovery) {
    const { instant, claim, row, block } = context;
    if (claim.consumed_at) {
      if (claim.attempt_type !== 'voice_tutor_repeat'
        || String(claim.attempt_ref) !== String(source?.id)) {
        throw new Error('ADAPTIVE_EXECUTION_CLAIM_CONSUMED');
      }
      return { created: false, instant, claim, row, block };
    }
    if (!adaptiveRepeatExecutionMatches({
      username, block, repeat, recovery, attempt: source, claimIssuedAt: claim.issued_at,
    })) {
      throw new Error('ADAPTIVE_EXECUTION_ATTEMPT_MISMATCH');
    }
    return { created: true, instant, claim, row, block };
  }

  function adaptiveRepeatBindingResult(plan, attemptId) {
    return {
      created: plan.created,
      evidenceQuality: 'server_verified_unassisted',
      adaptiveExecution: {
        sessionId: plan.row.id,
        blockId: plan.block.id,
        attemptType: 'voice_tutor_repeat',
        attemptId: String(attemptId),
      },
    };
  }

  async function submitVoiceTutorRepeat(username, repeatId, {
    attemptId,
    taskId,
    answer,
    adaptiveExecutionClaim = null,
    adaptiveSessionId = null,
    now = new Date(),
  }) {
    return serializeVoiceTutorMutation(async () => {
      await load();
      const effectiveNow = adaptiveExecutionClaim ? adaptiveMutationEffectiveNow() : now;
      const plan = planRepeatAttempt({
        ledger: createRecoveryLedger({
          recoveries: state.voice_tutor_recoveries,
          repeats: state.voice_tutor_repeats,
          attempts: state.voice_tutor_repeat_attempts,
        }),
        username, repeatId, attemptId, taskId, answer, now: effectiveNow,
      });
      let binding = null;
      if (adaptiveExecutionClaim) {
        const context = adaptiveClaimMutationContext(
          username, adaptiveSessionId, adaptiveExecutionClaim, effectiveNow,
        );
        const repeat = state.voice_tutor_repeats.find((item) => item.id === repeatId);
        const recovery = state.voice_tutor_recoveries.find((item) => (
          item.id === repeat?.recovery_id && item.username === username
        ));
        binding = adaptiveRepeatBindingPlan(username, context, plan.attempt, repeat, recovery);
      }
      if (plan.created) {
        state.voice_tutor_repeat_attempts.push({ ...plan.attempt });
        if (plan.daySevenReschedule) {
          const daySeven = state.voice_tutor_repeats.find((entry) => entry.id === plan.daySevenReschedule.repeatId);
          daySeven.due_at = plan.daySevenReschedule.dueAt;
          daySeven.window_ends_at = plan.daySevenReschedule.windowEndsAt;
        }
      }
      if (binding?.created) {
        binding.claim.consumed_at = binding.instant;
        binding.claim.attempt_type = 'voice_tutor_repeat';
        binding.claim.attempt_ref = String(plan.attempt.id);
      }
      if (plan.created || binding?.created) await persist();
      return {
        created: plan.created,
        attempt: publicRepeatAttempt(plan.attempt),
        ...(binding ? { adaptiveExecution: adaptiveRepeatBindingResult(binding, plan.attempt.id) } : {}),
      };
    });
  }

  async function getVoiceTutorRecoveryMap(username, { limits, now = new Date() }) {
    await load();
    const recoveries = state.voice_tutor_recoveries.filter((entry) => entry.username === username);
    const recoveryIds = new Set(recoveries.map((entry) => entry.id));
    const repeats = state.voice_tutor_repeats.filter((entry) => recoveryIds.has(entry.recovery_id));
    const repeatIds = new Set(repeats.map((entry) => entry.id));
    const attempts = state.voice_tutor_repeat_attempts.filter((entry) => repeatIds.has(entry.repeat_id));
    const usage = voiceTutorUsage(username, now);
    const access = await getVoiceTutorAccess(username, limits, now);
    return recoveryMap({
      ledger: createRecoveryLedger({ recoveries, repeats, attempts }),
      access,
      monthlyUsedSeconds: usage.monthlyUsedSeconds,
      now,
    });
  }

  async function getVoiceTutorRecoveryMetrics(now = new Date(), { costMicrousdPerMinute = 0 } = {}) {
    await load();
    const delivery = { voice: 0, text: 0, local: 0 };
    for (const session of state.voice_tutor_sessions) {
      if (Object.hasOwn(delivery, session.delivery_mode)) delivery[session.delivery_mode] += 1;
    }
    return recoveryMetrics({
      ledger: createRecoveryLedger({
        recoveries: state.voice_tutor_recoveries,
        repeats: state.voice_tutor_repeats,
        attempts: state.voice_tutor_repeat_attempts,
      }),
      billableSeconds: state.voice_tutor_sessions.reduce((sum, session) => (
        session.delivery_mode === 'voice' || session.provider
          ? sum + Number(session.billable_seconds || 0)
          : sum
      ), 0),
      sessionCount: state.voice_tutor_sessions.length,
      microCheckPasses: state.voice_tutor_sessions.reduce((sum, session) => sum + Number(session.micro_check_passes || 0), 0),
      microCheckAttempts: state.voice_tutor_sessions.reduce((sum, session) => sum + Number(session.micro_check_attempts || 0), 0),
      delivery,
      providerErrors: state.voice_tutor_sessions.filter((session) => (
        session.error_code === 'VOICE_TUTOR_PROVIDER_UNAVAILABLE'
        || session.error_code === 'VOICE_TUTOR_PROVIDER_CONTRACT_INVALID'
      )).length,
      costMicrousdPerMinute,
      now,
    });
  }

  async function setVoiceTutorSessionDelivery(username, sessionId, {
    mode, errorCode = null, provider, model, promptVersion,
  }) {
    return serializeVoiceTutorMutation(async () => {
      await load();
      if (!['voice', 'text', 'local'].includes(mode)) throw new VoiceTutorError('VOICE_TUTOR_DELIVERY_INVALID');
      const session = state.voice_tutor_sessions.find((entry) => entry.username === username && entry.id === sessionId);
      if (!session || !session.capsule) throw new VoiceTutorError('VOICE_TUTOR_SESSION_NOT_FOUND');
      const metadataProvided = provider !== undefined || model !== undefined || promptVersion !== undefined;
      const metadata = metadataProvided ? normalizeVoiceTutorDeliveryMetadata({ provider, model, promptVersion }) : null;
      session.delivery_mode = mode;
      session.error_code = errorCode;
      if (metadata) {
        session.provider = metadata.provider;
        session.model = metadata.model;
        session.prompt_version = metadata.prompt_version;
      }
      await persist();
      return { session: publicVoiceTutorSession(session), capsule: structuredClone(session.capsule) };
    });
  }

  async function switchVoiceTutorSessionDelivery(username, sessionId, {
    nonceHash, nextNonceHash, mode, limits, errorCode = null,
  }) {
    return serializeVoiceTutorMutation(async () => {
      await load();
      if (!['text', 'local'].includes(mode)) throw new VoiceTutorError('VOICE_TUTOR_DELIVERY_INVALID');
      const effectiveNow = voiceTutorMutationEffectiveNow();
      requireVoiceTutorEntitlement(username, effectiveNow.getTime());
      const session = state.voice_tutor_sessions.find((entry) => entry.username === username && entry.id === sessionId);
      if (!session || !session.capsule) throw new VoiceTutorError('VOICE_TUTOR_SESSION_NOT_FOUND');
      const validatedCapsule = revalidateVoiceTutorPronunciationCapsule(
        username, session.capsule, effectiveNow,
      );
      if (!session.nonce_hash || session.nonce_hash !== nonceHash) throw new VoiceTutorError('VOICE_TUTOR_NONCE_REPLAYED');
      if (session.status === 'active') {
        session.status = 'completed';
        if (session.proxy_ticket_consumed_at && !session.proxy_finalized_at) {
          const usage = voiceTutorProxyUsage(session, {
            inputAudioBytes: Number(session.proxy_input_audio_bytes || 0),
            outputAudioBytes: Number(session.proxy_output_audio_bytes || 0),
            confirmed: false,
            reason: 'runtime_fallback',
            now: effectiveNow,
          });
          session.billable_seconds = usage.billable_seconds;
          session.proxy_input_audio_bytes = usage.input_audio_bytes;
          session.proxy_output_audio_bytes = usage.output_audio_bytes;
          session.proxy_usage_confirmed = usage.confirmed;
          session.proxy_finalization_reason = usage.reason;
          session.proxy_finalized_at = usage.finalized_at;
          session.ended_at = usage.finalized_at;
        } else {
          session.billable_seconds = voiceTutorBillableSeconds(session, effectiveNow);
          session.ended_at = effectiveNow.toISOString();
        }
      }
      session.delivery_mode = mode;
      session.error_code = errorCode;
      session.nonce_hash = nextNonceHash;
      const access = voiceTutorAccessView({
        entitled: true, ...voiceTutorUsage(username, effectiveNow),
      }, limits);
      await persist();
      return {
        session: publicVoiceTutorSession(session),
        capsule: structuredClone(validatedCapsule || session.capsule),
        ...access,
      };
    });
  }

  async function finishVoiceTutorSession(username, sessionId, { limits, now = new Date(), confirmedBillableSeconds = null, preservePedagogicalState = false }) {
    return serializeVoiceTutorMutation(async () => {
      await load();
      const expired = expireVoiceTutorSessions(username, now);
      const session = state.voice_tutor_sessions.find((entry) => entry.username === username && entry.id === sessionId);
      if (!session) throw new VoiceTutorError('VOICE_TUTOR_SESSION_NOT_FOUND');
      const finished = session.status === 'active';
      let pedagogicalEnded = false;
      if (finished) {
        session.status = 'completed';
        if (session.proxy_ticket_consumed_at && !session.proxy_finalized_at) {
          const usage = voiceTutorProxyUsage(session, {
            inputAudioBytes: Number(session.proxy_input_audio_bytes || 0),
            outputAudioBytes: Number(session.proxy_output_audio_bytes || 0),
            confirmed: false,
            reason: 'server_finish',
            now,
          });
          session.billable_seconds = usage.billable_seconds;
          session.proxy_input_audio_bytes = usage.input_audio_bytes;
          session.proxy_output_audio_bytes = usage.output_audio_bytes;
          session.proxy_usage_confirmed = usage.confirmed;
          session.proxy_finalization_reason = usage.reason;
          session.proxy_finalized_at = usage.finalized_at;
          session.ended_at = usage.finalized_at;
        } else {
          session.billable_seconds = voiceTutorBillableSeconds(session, now, confirmedBillableSeconds);
          session.ended_at = new Date(now).toISOString();
        }
      }
      if (session.capsule && !preservePedagogicalState) {
        if (!['resolved', 'fallback', 'ended'].includes(session.pedagogical_state)) {
          session.pedagogical_state = 'ended';
          session.outcome = 'ended';
          pedagogicalEnded = true;
        }
        if (session.nonce_hash) pedagogicalEnded = true;
        session.nonce_hash = null;
      }
      if (finished || expired || pedagogicalEnded) await persist();
      return { finished, session: publicVoiceTutorSession(session), ...await getVoiceTutorAccess(username, limits, now) };
    });
  }

  async function setUserRole(username, role) {
    await load();
    if (!['student', 'admin'].includes(role)) throw new Error('INVALID_ROLE');
    if (!state.users[username]) throw new Error('USER_NOT_FOUND');
    state.users[username].role = role;
    await persist();
    return role;
  }

  function withRuleCardLock(operation) {
    const result = ruleCardQueue.then(operation, operation);
    ruleCardQueue = result.catch(() => {});
    return result;
  }

  async function createRuleCard(card) {
    return withRuleCardLock(async () => {
      await load();
      if (state.rule_cards.some((item) => item.id === card.id)) throw new Error('RULE_CARD_EXISTS');
      if (card.createdForUsername && !state.users[card.createdForUsername]) throw new Error('USER_NOT_FOUND');
      const stored = {
        id: card.id,
        created_for_username: card.createdForUsername || null,
        status: 'pending_review',
        skill: structuredClone(card.skill),
        exam_year: Number(card.examYear),
        rule: structuredClone(card.rule),
        agreement_hash: card.agreementHash,
        sources: structuredClone(card.sources),
        discrepancies: structuredClone(card.discrepancies || []),
        review_audit: [],
        created_at: new Date(card.createdAt).toISOString(),
        reviewed_at: null,
      };
      state.rule_cards.push(stored);
      await persist();
      return structuredClone(stored);
    });
  }

  async function claimVoiceTutorRuleDiscovery(username, sessionId, { claimId, nonceHash, now = new Date() }) {
    return serializeVoiceTutorMutation(async () => {
      await load();
      const session = state.voice_tutor_sessions.find((entry) => entry.username === username && entry.id === sessionId);
      if (!session?.capsule) throw new VoiceTutorError('VOICE_TUTOR_SESSION_NOT_FOUND');
      if (session.discovery_status === 'in_progress') throw new VoiceTutorError('TRUSTED_RULE_DISCOVERY_IN_PROGRESS');
      if (session.status !== 'active' || ['resolved', 'fallback', 'ended'].includes(session.pedagogical_state)
        || session.pedagogical_state !== 'diagnose' || new Date(session.expires_at).getTime() <= new Date(now).getTime()
        || session.capsule.rule_card_id) throw new VoiceTutorError('TRUSTED_RULE_DISCOVERY_NOT_REQUIRED');
      if (!session.nonce_hash || session.nonce_hash !== nonceHash) throw new VoiceTutorError('VOICE_TUTOR_NONCE_REPLAYED');
      session.discovery_status = 'in_progress';
      session.discovery_claim_id = claimId;
      session.discovery_error_code = null;
      session.updated_at = new Date(now).toISOString();
      await persist();
      return { claim_id: claimId, capsule: structuredClone(session.capsule), state: session.pedagogical_state };
    });
  }

  async function failVoiceTutorRuleDiscovery(username, sessionId, { claimId, errorCode, now = new Date() }) {
    return serializeVoiceTutorMutation(async () => {
      await load();
      const session = state.voice_tutor_sessions.find((entry) => entry.username === username && entry.id === sessionId);
      if (!session?.capsule || session.discovery_status !== 'in_progress' || session.discovery_claim_id !== claimId) return false;
      session.discovery_status = 'failed';
      session.discovery_claim_id = null;
      session.discovery_error_code = String(errorCode || 'TRUSTED_RULE_SEARCH_FAILED').slice(0, 80);
      session.updated_at = new Date(now).toISOString();
      await persist();
      return true;
    });
  }

  async function createRuleCardForVoiceTutorSession(username, sessionId, expectedCapsuleId, card, {
    claimId, expectedNonceHash, nextNonceHash,
  } = {}) {
    return serializeVoiceTutorMutation(() => withRuleCardLock(async () => {
      await load();
      const session = state.voice_tutor_sessions.find((entry) => entry.username === username && entry.id === sessionId);
      if (!session?.capsule || session.status !== 'active' || session.pedagogical_state !== 'diagnose'
        || session.capsule_id !== expectedCapsuleId || session.capsule.rule_card_id
        || session.capsule.skill_id !== card.skill?.id || session.discovery_status !== 'in_progress'
        || session.discovery_claim_id !== claimId || !session.nonce_hash || session.nonce_hash !== expectedNonceHash) {
        throw new VoiceTutorError('TRUSTED_RULE_DISCOVERY_NOT_REQUIRED');
      }
      if (state.rule_cards.some((item) => item.id === card.id)) throw new Error('RULE_CARD_EXISTS');
      const stored = {
        id: card.id, created_for_username: username, status: 'pending_review',
        skill: structuredClone(card.skill), exam_year: Number(card.examYear), rule: structuredClone(card.rule),
        agreement_hash: card.agreementHash, sources: structuredClone(card.sources),
        discrepancies: structuredClone(card.discrepancies || []), review_audit: [],
        created_at: new Date(card.createdAt).toISOString(), reviewed_at: null,
      };
      state.rule_cards.push(stored);
      session.capsule.rule_card_id = stored.id;
      session.pedagogical_state = 'explain';
      session.nonce_hash = nextNonceHash;
      session.discovery_status = 'completed';
      session.discovery_claim_id = null;
      session.discovery_error_code = null;
      session.updated_at = new Date(card.createdAt).toISOString();
      await persist();
      return structuredClone(stored);
    }));
  }

  async function getRuleCard(cardId) {
    await load();
    const card = state.rule_cards.find((entry) => entry.id === cardId);
    return card ? structuredClone(card) : null;
  }

  async function createVoiceTutorReport(username, report) {
    return serializeVoiceTutorMutation(async () => {
      await load();
      const session = state.voice_tutor_sessions.find((entry) => entry.username === username && entry.id === report.sessionId);
      if (!session?.capsule) throw new VoiceTutorError('VOICE_TUTOR_SESSION_NOT_FOUND');
      const existing = state.voice_tutor_reports.find((entry) => entry.username === username
        && entry.session_id === report.sessionId && entry.reason === report.reason);
      if (existing) return { created: false, report: structuredClone(existing) };
      const stored = {
        id: report.id, username, session_id: report.sessionId, rule_card_id: session.capsule.rule_card_id || null,
        reason: report.reason, status: 'pending', review_audit: [],
        created_at: new Date(report.createdAt).toISOString(), reviewed_at: null,
      };
      state.voice_tutor_reports.push(stored);
      await persist();
      return { created: true, report: structuredClone(stored) };
    });
  }

  async function listVoiceTutorReports({ status = 'pending' } = {}) {
    await load();
    return state.voice_tutor_reports.filter((entry) => !status || entry.status === status)
      .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at))).slice(0, 100)
      .map((entry) => structuredClone(entry));
  }

  async function reviewVoiceTutorReport(reportId, { decision, reviewer, reviewedAt }) {
    return serializeVoiceTutorMutation(async () => {
      await load();
      if (!state.users[reviewer]) throw new Error('USER_NOT_FOUND');
      const report = state.voice_tutor_reports.find((entry) => entry.id === reportId);
      if (!report) throw new VoiceTutorError('VOICE_TUTOR_REPORT_NOT_FOUND');
      if (report.status !== 'pending') {
        if (report.status !== decision) throw new VoiceTutorError('VOICE_TUTOR_REPORT_REVIEW_CONFLICT');
        return { applied: false, report: structuredClone(report) };
      }
      report.status = decision;
      report.reviewed_at = new Date(reviewedAt).toISOString();
      report.review_audit.push({ decision, reviewer, reviewed_at: report.reviewed_at });
      state.audit_log.push({ action: 'voice_tutor.report.review', at: report.reviewed_at, metadata: { report_id: report.id, username: report.username, reviewer } });
      await persist();
      return { applied: true, report: structuredClone(report) };
    });
  }

  async function listRuleCards({ status = 'pending_review' } = {}) {
    await load();
    return state.rule_cards
      .filter((card) => !status || card.status === status)
      .sort((first, second) => String(first.created_at).localeCompare(String(second.created_at)))
      .slice(0, 100)
      .map((card) => structuredClone(card));
  }

  async function reviewRuleCard(cardId, { decision, reviewer, reviewedAt }) {
    return withRuleCardLock(async () => {
      await load();
      if (!state.users[reviewer]) throw new Error('USER_NOT_FOUND');
      const card = state.rule_cards.find((item) => item.id === cardId);
      const transition = transitionRuleCardReview(card, { decision, reviewer, reviewedAt });
      if (!transition.applied) return { applied: false, card: structuredClone(card) };
      if (decision === 'approved' && state.rule_cards.some((item) => item.id !== cardId
        && item.status === 'approved' && item.skill?.id === card.skill?.id
        && Number(item.exam_year) === Number(card.exam_year))) {
        throw new VoiceTutorError('RULE_CARD_CANONICAL_EXISTS');
      }
      Object.assign(card, transition.card);
      await persist();
      return { applied: true, card: structuredClone(card) };
    });
  }

  async function getApprovedRuleCard(skillId, examYear) {
    await load();
    const cards = state.rule_cards.filter((card) => card.status === 'approved'
      && card.skill?.id === skillId && card.exam_year === Number(examYear));
    const card = cards.sort((first, second) => String(second.reviewed_at).localeCompare(String(first.reviewed_at)))[0];
    return card ? structuredClone(card) : null;
  }

  async function getPrivacyConsent(username) {
    await load();
    const consent = state.users[username]?.privacy_consent || {};
    return {
      text_processing: Boolean(consent.text_processing),
      voice_processing: Boolean(consent.voice_processing),
      policy_version: consent.policy_version || null,
      updated_at: consent.updated_at || null,
    };
  }

  async function setPrivacyConsent(username, consent) {
    return serializeVoiceTutorMutation(async () => {
      await load();
      if (!state.users[username]) throw new Error('USER_NOT_FOUND');
      const previous = state.users[username].privacy_consent || {};
      const now = new Date().toISOString();
      state.users[username].privacy_consent = {
        text_processing: Boolean(consent.text_processing),
        voice_processing: Boolean(consent.voice_processing),
        policy_version: consent.policy_version,
        text_consented_at: consent.text_processing ? (previous.text_consented_at || now) : null,
        voice_consented_at: consent.voice_processing ? (previous.voice_consented_at || now) : null,
        updated_at: now,
      };
      await persist();
      return getPrivacyConsent(username);
    });
  }

  async function getSpeakingAccentProfile(username) {
    await load();
    return publicSpeakingAccentProfile(state.speaking_accent_profiles[username] || null);
  }

  async function getSpeakingAccentHistory(username) {
    await load();
    return state.speaking_accent_history
      .filter((entry) => entry.username === username)
      .sort((left, right) => Number(left.revision) - Number(right.revision))
      .map(({ username: owner, ...entry }) => structuredClone(entry));
  }

  async function setSpeakingAccentProfile(username, input) {
    const parsed = assertSpeakingAccentProfileChange(input);
    return serializeSpeakingSessionMutation(async () => {
      await load();
      if (!state.users[username]) throw new Error('USER_NOT_FOUND');
      const previous = state.speaking_accent_profiles[username] || null;
      const calibration = state.speaking_accent_calibrations.find((entry) => entry.username === username);
      if (parsed.source === 'manual' && calibration?.status === 'pending') {
        Object.assign(calibration, {
          status: 'cancelled', completed_at: parsed.now.toISOString(), locale: null,
          confidence: null, evidence_keys: null, policy_version: null,
        });
      }
      if (previous?.locale === parsed.locale) {
        if (calibration?.status === 'cancelled') await persist();
        return { changed: false, profile: publicSpeakingAccentProfile(previous) };
      }
      const profile = {
        username,
        locale: parsed.locale,
        revision: Number(previous?.revision || 0) + 1,
        source: parsed.source,
        effective_at: parsed.now.toISOString(),
        calibration_used: Boolean(previous?.calibration_used
          || calibration),
      };
      state.speaking_accent_profiles[username] = profile;
      state.speaking_accent_history.push({
        id: crypto.randomUUID(), username, locale: profile.locale, revision: profile.revision,
        source: profile.source, effective_at: profile.effective_at,
      });
      await persist();
      return { changed: true, profile: publicSpeakingAccentProfile(profile) };
    });
  }

  async function startSpeakingAccentCalibration(username, { now = new Date() } = {}) {
    const instant = new Date(now);
    if (!Number.isFinite(instant.getTime())) throw speakingAccentError('SPEAKING_ACCENT_CALIBRATION_INVALID');
    return serializeSpeakingSessionMutation(async () => {
      await load();
      if (!state.users[username]) throw new Error('USER_NOT_FOUND');
      if (state.speaking_accent_calibrations.some((entry) => entry.username === username)
        || state.speaking_accent_profiles[username]) {
        throw speakingAccentError('SPEAKING_ACCENT_CALIBRATION_ALREADY_USED');
      }
      const setup = {
        id: crypto.randomUUID(), username, status: 'pending',
        started_at: instant.toISOString(), completed_at: null,
        locale: null, confidence: null, evidence_keys: null, policy_version: null,
      };
      state.speaking_accent_calibrations.push(setup);
      await persist();
      return { id: setup.id, status: setup.status, started_at: setup.started_at };
    });
  }

  async function getSpeakingAccentCalibration(username, setupId) {
    await load();
    const setup = state.speaking_accent_calibrations.find((entry) => (
      entry.username === username && entry.id === setupId
    ));
    return setup ? structuredClone(setup) : null;
  }

  async function getPendingSpeakingAccentCalibration(username) {
    await load();
    const setup = state.speaking_accent_calibrations.find((entry) => (
      entry.username === username && entry.status === 'pending'
    ));
    return setup ? { id: setup.id, status: setup.status, started_at: setup.started_at } : null;
  }

  async function completeSpeakingAccentCalibration(username, input) {
    const locale = String(input?.locale || '');
    const confidence = String(input?.suggestionConfidence || '');
    const setupId = String(input?.setupId || '');
    const policyVersion = String(input?.policyVersion || '');
    const evidenceKeys = Array.isArray(input?.evidenceKeys) ? input.evidenceKeys.map(String) : [];
    const instant = new Date(input?.now ?? new Date());
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
    if (!['en-GB', 'en-US'].includes(locale) || !['clear', 'close'].includes(confidence)
      || !uuid.test(setupId) || policyVersion !== 'speaking-accent-suggestion-v1'
      || evidenceKeys.length !== 2 || evidenceKeys[0] === evidenceKeys[1]
      || evidenceKeys.some((key) => !uuid.test(key)) || !Number.isFinite(instant.getTime())) {
      throw speakingAccentError('SPEAKING_ACCENT_CALIBRATION_INVALID');
    }
    return serializeSpeakingSessionMutation(async () => {
      await load();
      const setup = state.speaking_accent_calibrations.find((entry) => (
        entry.username === username && entry.id === setupId
      ));
      if (!setup) throw speakingAccentError('SPEAKING_ACCENT_CALIBRATION_NOT_FOUND');
      if (setup.status !== 'pending') throw speakingAccentError('SPEAKING_ACCENT_CALIBRATION_ALREADY_USED');
      const previous = state.speaking_accent_profiles[username] || null;
      const profile = {
        username, locale, revision: Number(previous?.revision || 0) + 1,
        source: 'calibration', effective_at: instant.toISOString(), calibration_used: true,
      };
      Object.assign(setup, {
        status: 'completed', completed_at: instant.toISOString(), locale,
        confidence, evidence_keys: evidenceKeys, policy_version: policyVersion,
      });
      state.speaking_accent_profiles[username] = profile;
      state.speaking_accent_history.push({
        id: crypto.randomUUID(), username, locale, revision: profile.revision,
        source: 'calibration', effective_at: profile.effective_at,
      });
      await persist();
      return { profile: publicSpeakingAccentProfile(profile), suggestionConfidence: confidence };
    });
  }

  function deleteCalibrationAudio(sample, instant, status) {
    if (sample.audio) sample.audio = null;
    sample.raw_deleted_at ||= instant.toISOString();
    if (status) sample.status = status;
  }

  function purgeExpiredCalibrationSamplesInMemory(instant) {
    let deletedAudio = 0;
    for (const sample of state.speaking_calibration_samples) {
      if (sample.audio && new Date(sample.expires_at).getTime() <= instant.getTime()) {
        deleteCalibrationAudio(sample, instant, 'expired');
        deletedAudio += 1;
      }
    }
    return deletedAudio;
  }

  async function getSpeakingCalibrationConsent(username) {
    await load();
    const consent = state.speaking_calibration_consents[username];
    return consent ? structuredClone(consent) : null;
  }

  async function setSpeakingCalibrationConsent(username, input) {
    const parsed = assertSpeakingCalibrationConsent(input);
    return serializeSpeakingSessionMutation(async () => {
      await load();
      if (!state.users[username]) throw new Error('USER_NOT_FOUND');
      const previous = state.speaking_calibration_consents[username] || null;
      const consent = {
        granted: parsed.granted,
        age_group: parsed.ageGroup,
        guardian_confirmed: parsed.guardianConfirmed,
        policy_version: parsed.policyVersion,
        granted_at: parsed.granted ? (previous?.granted_at || parsed.now.toISOString()) : null,
        revoked_at: parsed.granted ? null : parsed.now.toISOString(),
        updated_at: parsed.now.toISOString(),
      };
      state.speaking_calibration_consents[username] = consent;
      if (!parsed.granted) {
        for (const sample of state.speaking_calibration_samples) {
          if (sample.username === username && sample.audio) deleteCalibrationAudio(sample, parsed.now, 'consent_revoked');
        }
      }
      await persist();
      return structuredClone(consent);
    });
  }

  async function createSpeakingCalibrationSample(username, input) {
    const parsed = assertSpeakingCalibrationSample(input);
    return serializeSpeakingSessionMutation(async () => {
      await load();
      const consent = state.speaking_calibration_consents[username];
      if (!consent?.granted) throw speakingAccentError('SPEAKING_CALIBRATION_CONSENT_REQUIRED');
      const duplicate = state.speaking_calibration_samples.find((sample) => (
        sample.username === username && sample.assessment_key === parsed.assessmentKey
      ));
      if (duplicate) return publicSpeakingCalibrationSample(duplicate);
      const sample = {
        id: parsed.id, username, assessment_key: parsed.assessmentKey,
        task_type: parsed.taskType, task_ref: parsed.taskRef, locale: parsed.locale,
        task_snapshot: parsed.taskSnapshot, rubric_snapshot: parsed.rubricSnapshot,
        maximum_score: parsed.maximumScore, status: 'awaiting_reviews',
        audio: parsed.audio.toString('base64'), reviews: [], access_audit: [],
        created_at: parsed.now.toISOString(),
        expires_at: speakingCalibrationExpiresAt(parsed.now).toISOString(),
        raw_deleted_at: null, completed_at: null,
      };
      state.speaking_calibration_samples.push(sample);
      await persist();
      return publicSpeakingCalibrationSample(sample);
    });
  }

  async function purgeExpiredSpeakingCalibrationSamples({ now = new Date() } = {}) {
    const instant = new Date(now);
    if (!Number.isFinite(instant.getTime())) throw speakingAccentError('SPEAKING_CALIBRATION_TIME_INVALID');
    return serializeSpeakingSessionMutation(async () => {
      await load();
      const deletedAudio = purgeExpiredCalibrationSamplesInMemory(instant);
      if (deletedAudio) await persist();
      return { deletedAudio };
    });
  }

  async function claimSpeakingCalibrationSample(reviewer, { now = new Date() } = {}) {
    const instant = new Date(now);
    if (!Number.isFinite(instant.getTime())) throw speakingAccentError('SPEAKING_CALIBRATION_TIME_INVALID');
    return serializeSpeakingSessionMutation(async () => {
      await load();
      const purged = purgeExpiredCalibrationSamplesInMemory(instant);
      const sample = state.speaking_calibration_samples
        .filter((entry) => entry.audio && ['awaiting_reviews', 'adjudication_pending'].includes(entry.status)
          && !entry.reviews.some((review) => review.reviewer === reviewer)
          && state.speaking_calibration_consents[entry.username]?.granted
          && speakingCalibrationReviewClaim(entry, reviewer, instant).canClaim)
        .sort((left, right) => new Date(left.created_at) - new Date(right.created_at))[0] || null;
      if (!sample) {
        if (purged) await persist();
        return null;
      }
      const claim = speakingCalibrationReviewClaim(sample, reviewer, instant);
      if (!claim.resume) {
        sample.access_audit.push({
          reviewer, review_round: claim.reviewRound, accessed_at: instant.toISOString(),
        });
        sample.access_audit = sample.access_audit.slice(-12);
        await persist();
      } else if (purged) await persist();
      return blindSpeakingCalibrationCard(sample);
    });
  }

  async function getSpeakingCalibrationAudio(sampleId, reviewer, { now = new Date() } = {}) {
    const instant = new Date(now);
    if (!Number.isFinite(instant.getTime())) throw speakingAccentError('SPEAKING_CALIBRATION_TIME_INVALID');
    return serializeSpeakingSessionMutation(async () => {
      await load();
      const sample = state.speaking_calibration_samples.find((entry) => entry.id === sampleId);
      if (sample?.audio && new Date(sample.expires_at).getTime() <= instant.getTime()) {
        deleteCalibrationAudio(sample, instant, 'expired');
        await persist();
        return null;
      }
      const claim = sample ? speakingCalibrationReviewClaim(sample, reviewer, instant) : null;
      if (!sample?.audio || !claim.ownsActiveClaim) return null;
      return Buffer.from(sample.audio, 'base64');
    });
  }

  async function submitSpeakingCalibrationReview(reviewer, sampleId, input) {
    return serializeSpeakingSessionMutation(async () => {
      await load();
      const sample = state.speaking_calibration_samples.find((entry) => entry.id === sampleId);
      const reviewInstant = new Date(input?.now ?? new Date());
      if (sample?.audio && Number.isFinite(reviewInstant.getTime())
        && new Date(sample.expires_at).getTime() <= reviewInstant.getTime()) {
        deleteCalibrationAudio(sample, reviewInstant, 'expired');
        await persist();
        throw speakingAccentError('SPEAKING_CALIBRATION_SAMPLE_NOT_AVAILABLE');
      }
      if (!sample || !sample.audio || !['awaiting_reviews', 'adjudication_pending'].includes(sample.status)) {
        throw speakingAccentError('SPEAKING_CALIBRATION_SAMPLE_NOT_AVAILABLE');
      }
      if (sample.reviews.some((review) => review.reviewer === reviewer)) {
        throw speakingAccentError('SPEAKING_CALIBRATION_REVIEWER_NOT_INDEPENDENT');
      }
      if (!speakingCalibrationReviewClaim(sample, reviewer, input?.now).ownsActiveClaim) {
        throw speakingAccentError('SPEAKING_CALIBRATION_REVIEW_CLAIM_REQUIRED');
      }
      const review = assertSpeakingCalibrationReview(sample, input);
      sample.reviews.push({
        reviewer, sufficient: review.sufficient, score: review.score, critical_error: review.criticalError,
        reviewed_at: review.now.toISOString(),
      });
      const sufficientReviews = sample.reviews.filter((entry) => entry.sufficient !== false);
      sample.status = 'awaiting_reviews';
      if (sufficientReviews.length === 2) {
        const material = materialSpeakingCalibrationDisagreement(sample.task_type,
          { score: sufficientReviews[0].score, criticalError: sufficientReviews[0].critical_error },
          { score: sufficientReviews[1].score, criticalError: sufficientReviews[1].critical_error });
        if (material) sample.status = 'adjudication_pending';
        else {
          sample.completed_at = review.now.toISOString();
          deleteCalibrationAudio(sample, review.now, 'completed');
        }
      } else if (sufficientReviews.length === 3) {
        sample.completed_at = review.now.toISOString();
        deleteCalibrationAudio(sample, review.now, 'completed');
      }
      await persist();
      return {
        sampleId: sample.id, status: sample.status,
        audio_retained: Boolean(sample.audio), reviewCount: sufficientReviews.length,
      };
    });
  }

  async function listSpeakingCalibrationSamplesForOwner(username) {
    await load();
    return state.speaking_calibration_samples.filter((sample) => sample.username === username)
      .map(publicSpeakingCalibrationSample);
  }

  async function listAnonymousSpeakingCalibrationLabels() {
    await load();
    return state.speaking_calibration_samples
      .filter((sample) => sample.status === 'completed')
      .map((sample) => ({
        sampleId: sample.id, taskType: sample.task_type, accentLocale: sample.locale,
        ratings: sample.reviews.map(({ reviewer, ...rating }) => structuredClone(rating)),
      }));
  }

  function removeExpiredAuthCodes(now = Date.now()) {
    let changed = false;
    for (const [codeHash, entry] of Object.entries(state.auth_codes)) {
      if (Number(entry.expires_at) <= now) {
        delete state.auth_codes[codeHash];
        changed = true;
      }
    }
    return changed;
  }

  async function createTelegramAuthCode(code, expiresAt) {
    await load();
    removeExpiredAuthCodes();
    const codeHash = hashAuthCode(code);
    state.auth_codes[codeHash] = {
      status: 'pending',
      expires_at: Number(expiresAt),
      created_at: Date.now(),
    };
    await persist();
  }

  async function confirmTelegramAuthCode(code, telegramId, displayName) {
    await load();
    const codeHash = hashAuthCode(code);
    const entry = state.auth_codes[codeHash];
    if (!entry || Number(entry.expires_at) <= Date.now() || entry.status !== 'pending') {
      if (entry) {
        delete state.auth_codes[codeHash];
        await persist();
      }
      return false;
    }
    entry.status = 'ready';
    entry.telegram_id = Number(telegramId);
    entry.display_name = String(displayName || '').slice(0, 160);
    entry.confirmed_at = Date.now();
    await persist();
    return true;
  }

  async function consumeTelegramAuthCode(code) {
    await load();
    const codeHash = hashAuthCode(code);
    const entry = state.auth_codes[codeHash];
    if (!entry || Number(entry.expires_at) <= Date.now() || entry.status !== 'ready') {
      if (entry && Number(entry.expires_at) <= Date.now()) {
        delete state.auth_codes[codeHash];
        await persist();
      }
      return null;
    }
    delete state.auth_codes[codeHash];
    await persist();
    return { telegram_id: entry.telegram_id, name: entry.display_name };
  }

  async function createWritingAttempt(username, input, promptVersion) {
    await load();
    const id = (state.writing_attempts.at(-1)?.id || 0) + 1;
    state.writing_attempts.push({
      id,
      username,
      task_type: input.taskType,
      source_task_ref: input.sourceTaskRef || null,
      assignment: structuredClone(input.assignment),
      answer: input.answer,
      evaluated_answer: input.evaluatedAnswer ?? input.answer,
      prompt_version: promptVersion,
      model: null,
      status: 'pending',
      created_at: Date.now(),
    });
    await persist();
    return id;
  }

  async function finishWritingAttempt(id, result) {
    return serializeCoordinatedMutation(async () => {
      await load();
      const attempt = state.writing_attempts.find((item) => item.id === Number(id));
      if (!attempt) throw new Error('WRITING_ATTEMPT_NOT_FOUND');
      attempt.status = result.status;
      attempt.review = result.review ? structuredClone(result.review) : null;
      attempt.provider = result.provider || null;
      attempt.model = result.model || null;
      attempt.error_code = result.errorCode || null;
      attempt.evaluated_at = Date.now();
      await persist();
    });
  }

  async function getWritingAttempt(username, id) {
    await load();
    const attempt = state.writing_attempts.find((item) => item.username === username && item.id === Number(id));
    return attempt ? structuredClone(attempt) : null;
  }

  async function createSpeakingAttempt(username, input, promptVersion) {
    await load();
    const id = (state.speaking_attempts.at(-1)?.id || 0) + 1;
    state.speaking_attempts.push({ id, username, task_type: input.taskType, assignment: structuredClone(input.assignment), assignment_fingerprint: adaptiveExecutionRequestHash(input.assignment), transcript: input.transcript, prompt_version: promptVersion, model: null, status: 'pending', source_session_id: null, source_task_ref: null, source_task_revision: null, source_catalog_id: null, source_catalog_revision: null, assistance_used: true, assistance_updated_at: Date.now(), accent_locale: null, targeted_practice: null, created_at: Date.now() });
    await persist();
    return id;
  }

  async function claimSpeakingEvaluation(username, input, promptVersion, evaluationFingerprint, {
    now = null, source = null, allowRecovery = true, allowInvalidRecovery = false,
    voiceConsentPolicyVersion = null,
  } = {}) {
    if (!/^[a-f0-9]{64}$/u.test(evaluationFingerprint)) {
      throw new Error('SPEAKING_EVALUATION_FINGERPRINT_INVALID');
    }
    const requestedSource = source == null ? null : assertSpeakingLearningSource(source);
    return serializeCoordinatedMutation(async () => {
      await load();
      if (!state.users[username]) throw new Error('USER_NOT_FOUND');
      const claimedAt = new Date(typeof now === 'function' ? now() : (now ?? new Date()));
      if (!Number.isFinite(claimedAt.getTime())) {
        throw new Error('SPEAKING_EVALUATION_CLAIM_TIME_INVALID');
      }
      const sourceSessions = requestedSource?.sessionMode === 'full_section'
        ? state.speaking_full_sessions : state[`speaking_task${Number(input.taskType)}_sessions`];
      const sourceSession = requestedSource && Array.isArray(sourceSessions)
        ? sourceSessions.find((item) => item.username === username && item.id === requestedSource.sessionId)
        : null;
      const learningSource = requestedSource ? canonicalSpeakingLearningSource(requestedSource, {
        taskType: input.taskType,
        session: sourceSession,
      }) : null;
      const replay = state.speaking_attempts.find((item) => (
        item.username === username && item.evaluation_fingerprint === evaluationFingerprint
      ));
      const recovering = Boolean(replay && allowRecovery && speakingEvaluationClaimRecoverable(
        replay, claimedAt, { allowInvalidProviderResponse: allowInvalidRecovery },
      ));
      if (sourceSession?.selection_reason === 'ege_mock' && (!replay || recovering)) {
        requireEgeMockProviderAuthorization(username, claimedAt, voiceConsentPolicyVersion);
      }
      if (replay) {
        if (allowRecovery && recoverSpeakingEvaluationAttempt(replay, claimedAt, {
          allowInvalidProviderResponse: allowInvalidRecovery,
        })) {
          if (learningSource) Object.assign(replay, {
            source_session_id: learningSource.sessionId,
            source_task_ref: learningSource.taskRef,
            source_task_revision: learningSource.taskRevision,
            source_catalog_id: learningSource.catalogId,
            source_catalog_revision: learningSource.catalogRevision,
            accent_locale: learningSource.accentLocale,
            assistance_used: Boolean(replay.assistance_used || learningSource.assistanceUsed),
            assistance_updated_at: replay.assistance_used || !learningSource.assistanceUsed
              ? replay.assistance_updated_at : claimedAt.getTime(),
            targeted_practice: learningSource.targetedPractice || null,
          });
          await persist();
          return { created: true, attempt: structuredClone(replay) };
        }
        return { created: false, attempt: structuredClone(replay) };
      }
      const id = (state.speaking_attempts.at(-1)?.id || 0) + 1;
      const attempt = {
        id,
        username,
        task_type: input.taskType,
        assignment: structuredClone(input.assignment),
        assignment_fingerprint: adaptiveExecutionRequestHash(input.assignment),
        evaluation_fingerprint: evaluationFingerprint,
        transcript: input.transcript,
        prompt_version: promptVersion,
        provider: null,
        model: null,
        status: 'pending',
        created_at: Date.now(),
        evaluation_claimed_at: claimedAt.getTime(),
        evaluation_claim_generation: 1,
        source_session_id: learningSource?.sessionId || null,
        source_task_ref: learningSource?.taskRef || null,
        source_task_revision: learningSource?.taskRevision || null,
        source_catalog_id: learningSource?.catalogId || null,
        source_catalog_revision: learningSource?.catalogRevision || null,
        accent_locale: learningSource?.accentLocale || null,
        assistance_used: learningSource?.assistanceUsed ?? true,
        assistance_updated_at: learningSource?.assistanceUsed === false ? null : claimedAt.getTime(),
        targeted_practice: learningSource?.targetedPractice || null,
      };
      state.speaking_attempts.push(attempt);
      await persist();
      return { created: true, attempt: structuredClone(attempt) };
    });
  }

  async function finishSpeakingAttempt(id, result, { claimGeneration = null } = {}) {
    return serializeCoordinatedMutation(async () => {
      await load();
      const attempt = state.speaking_attempts.find((item) => item.id === Number(id));
      if (!attempt) throw new Error('SPEAKING_ATTEMPT_NOT_FOUND');
      if (claimGeneration != null && (attempt.status !== 'pending'
        || Number(attempt.evaluation_claim_generation) !== Number(claimGeneration))) {
        throw new Error('SPEAKING_EVALUATION_CLAIM_LOST');
      }
      const resultLocale = result.review?.acousticFacts?.accentLocale;
      if (resultLocale && !['en-GB', 'en-US'].includes(resultLocale)) {
        throw new Error('SPEAKING_ACCENT_LOCALE_INVALID');
      }
      if (attempt.accent_locale && resultLocale && attempt.accent_locale !== resultLocale) {
        throw new Error('SPEAKING_LEARNING_SOURCE_MISMATCH');
      }
      attempt.accent_locale ||= resultLocale || null;
      attempt.status = result.status;
      attempt.review = result.review ? structuredClone(result.review) : null;
      attempt.provider = result.provider || null;
      attempt.model = result.model || null;
      attempt.error_code = result.errorCode || null;
      attempt.evaluated_at = Date.now();
      await persist();
    });
  }

  async function getSpeakingEvaluationClaim(username, evaluationFingerprint) {
    await load();
    const attempt = state.speaking_attempts.find((item) => (
      item.username === username && item.evaluation_fingerprint === evaluationFingerprint
    ));
    return attempt ? structuredClone(attempt) : null;
  }

  async function getSpeakingAttempt(username, id) {
    await load();
    const attempt = state.speaking_attempts.find((item) => item.username === username && item.id === Number(id));
    return attempt ? structuredClone(attempt) : null;
  }

  function speakingLearningAttempts(username, { limit = 120 } = {}) {
    const boundedLimit = Math.min(120, Math.max(1, Number.isInteger(limit) ? limit : 120));
    return state.speaking_attempts
      .filter((item) => item.username === username && ['completed', 'needs_retry'].includes(item.status))
      .sort((left, right) => Number(right.evaluated_at || right.created_at) - Number(left.evaluated_at || left.created_at)
        || Number(right.id) - Number(left.id))
      .slice(0, boundedLimit)
      .map(buildSpeakingLearningAttempt)
      .filter(Boolean)
      .map((item) => structuredClone(item));
  }

  async function getSpeakingLearningAttempts(username, options = {}) {
    await load();
    return speakingLearningAttempts(username, options);
  }

  async function getSpeakingLearningReportSnapshot(username, { limit = 120 } = {}) {
    return serializeCoordinatedMutation(async () => {
      await load();
      if (!state.users[username]) throw new Error('USER_NOT_FOUND');
      const effectiveNow = new Date(speakingLearningNow());
      if (Number.isNaN(effectiveNow.getTime())) throw new Error('SPEAKING_LEARNING_CLOCK_INVALID');
      const subscriptionUntilMs = Number(state.users[username].sub_until || 0);
      if (!Number.isFinite(subscriptionUntilMs) || subscriptionUntilMs <= effectiveNow.getTime()) {
        throw Object.assign(new Error('SUBSCRIPTION_REQUIRED'), { code: 'SUBSCRIPTION_REQUIRED' });
      }
      if (reconcileSpeakingAssessmentLeases(username, effectiveNow)) await persist();
      return {
        attempts: speakingLearningAttempts(username, { limit }),
        quota: speakingAssessmentQuota(username, effectiveNow),
        accentProfile: publicSpeakingAccentProfile(state.speaking_accent_profiles[username] || null),
        effectiveNow: effectiveNow.toISOString(),
      };
    });
  }

  function serializeSpeakingSessionMutation(run) {
    return serializeCoordinatedMutation(run);
  }

  async function assignSpeakingCatalogSession(stateKey, createSession, username, {
    catalogId, catalogRevision, tasks, accentProfile = null, calibrationSetupId = null, now,
    excludeTaskIds = [], preferredTaskIds = [], selectionReason = null, targetedPractice = null,
    targetedPracticeRequest = null,
  }) {
    return serializeCoordinatedMutation(async () => {
      await load();
      if (!state.users[username]) throw new Error('USER_NOT_FOUND');
      let targetedPracticeNow = null;
      if (targetedPracticeRequest) {
        targetedPracticeNow = new Date(speakingLearningNow());
        if (Number.isNaN(targetedPracticeNow.getTime())) throw new Error('SPEAKING_LEARNING_CLOCK_INVALID');
        const subscriptionUntilMs = Number(state.users[username].sub_until || 0);
        if (!Number.isFinite(subscriptionUntilMs) || subscriptionUntilMs <= targetedPracticeNow.getTime()) {
          throw Object.assign(new Error('SUBSCRIPTION_REQUIRED'), { code: 'SUBSCRIPTION_REQUIRED' });
        }
      }
      const canonicalAccentProfile = state.speaking_accent_profiles[username] || null;
      const effectiveAccentProfile = canonicalAccentProfile || accentProfile || null;
      const effectiveCalibrationSetupId = effectiveAccentProfile ? null : calibrationSetupId;
      if (effectiveCalibrationSetupId) {
        const calibration = state.speaking_accent_calibrations.find((entry) => (
          entry.id === effectiveCalibrationSetupId && entry.username === username && entry.status === 'pending'
        ));
        if (!calibration) throw speakingAccentError('SPEAKING_ACCENT_PROFILE_REQUIRED');
      }
      let effectiveAssignment = {
        excludeTaskIds, preferredTaskIds, selectionReason, targetedPractice,
      };
      if (targetedPracticeRequest) {
        const learningAttempts = state.speaking_attempts
          .filter((item) => item.username === username && ['completed', 'needs_retry'].includes(item.status))
          .sort((left, right) => Number(right.evaluated_at || right.created_at)
            - Number(left.evaluated_at || left.created_at) || Number(right.id) - Number(left.id))
          .slice(0, 120).map(buildSpeakingLearningAttempt).filter(Boolean);
        effectiveAssignment = speakingTargetedPracticeAssignment(
          learningAttempts, targetedPracticeRequest, tasks[0]?.taskType, {
            tier: hasVoiceTutorEntitlement(username, targetedPracticeNow.getTime()) ? 'premium' : 'base',
            activeAccentLocale: effectiveAccentProfile?.locale || null,
          },
        );
      }
      const history = state[stateKey].filter((session) => session.username === username
        && session.catalog_id === catalogId && Number(session.catalog_revision) === Number(catalogRevision));
      const selection = selectSpeakingTrainingAssignment(tasks, history, now, {
        ...effectiveAssignment,
      });
      const session = createSession({
        username, catalogId, catalogRevision, selection, accentProfile: effectiveAccentProfile,
        calibrationSetupId: effectiveCalibrationSetupId, now,
      });
      state[stateKey].push(session);
      await persist();
      return structuredClone(session);
    });
  }

  async function getSpeakingCatalogSession(stateKey, username, id) {
    await load();
    const session = state[stateKey].find((item) => item.username === username && item.id === id);
    return session ? structuredClone(session) : null;
  }

  async function markSpeakingSessionAssisted(username, taskType, id, { now = new Date() } = {}) {
    const stateKey = `speaking_task${Number(taskType)}_sessions`;
    if (![1, 2, 3, 4].includes(Number(taskType))) throw new Error('SPEAKING_SESSION_KIND_INVALID');
    return serializeCoordinatedMutation(async () => {
      await load();
      const session = state[stateKey].find((item) => item.username === username && item.id === id);
      if (!session) return null;
      if (!session.assistance_used) {
        const changedAt = new Date(now).getTime();
        if (!Number.isFinite(changedAt)) throw new Error('SPEAKING_ASSISTANCE_TIME_INVALID');
        session.assistance_used = true;
        state.speaking_attempts.filter((attempt) => (
          attempt.username === username && attempt.source_session_id === id
        )).forEach((attempt) => {
          if (!attempt.assistance_used) {
            attempt.assistance_used = true;
            attempt.assistance_updated_at = changedAt;
          }
        });
        await persist();
      }
      return structuredClone(session);
    });
  }

  const assignSpeakingTask1Session = (username, options) => assignSpeakingCatalogSession(
    'speaking_task1_sessions', newSpeakingTask1Session, username, options,
  );

  const getSpeakingTask1Session = (username, id) => getSpeakingCatalogSession(
    'speaking_task1_sessions', username, id,
  );

  async function completeSpeakingTask1Session(username, id, completion, { now = new Date() } = {}) {
    return serializeSpeakingSessionMutation(async () => {
      await load();
      const session = state.speaking_task1_sessions.find((item) => item.username === username && item.id === id);
      if (!session) return null;
      if (session.status === 'completed') return structuredClone(session);
      Object.assign(session, speakingTask1CompletionMetadata(completion, now), { status: 'completed' });
      await persist();
      return structuredClone(session);
    });
  }

  const assignSpeakingTask2Session = (username, options) => assignSpeakingCatalogSession(
    'speaking_task2_sessions', newSpeakingTask2Session, username, options,
  );

  const getSpeakingTask2Session = (username, id) => getSpeakingCatalogSession(
    'speaking_task2_sessions', username, id,
  );

  async function completeSequentialSpeakingPosition(
    stateKey, applyCompletion, username, id, positionNumber, completion, { now = new Date() } = {},
  ) {
    return serializeSpeakingSessionMutation(async () => {
      await load();
      const session = state[stateKey].find((item) => item.username === username && item.id === id);
      if (!session) return null;
      applyCompletion(session, positionNumber, completion, now);
      await persist();
      return structuredClone(session);
    });
  }

  const completeSpeakingTask2Question = (username, id, questionNumber, completion, options) => (
    completeSequentialSpeakingPosition(
      'speaking_task2_sessions', applySpeakingTask2QuestionCompletion,
      username, id, questionNumber, completion, options,
    )
  );

  const assignSpeakingTask3Session = (username, options) => assignSpeakingCatalogSession(
    'speaking_task3_sessions', newSpeakingTask3Session, username, options,
  );

  const getSpeakingTask3Session = (username, id) => getSpeakingCatalogSession(
    'speaking_task3_sessions', username, id,
  );

  const completeSpeakingTask3Answer = (username, id, questionNumber, completion, options) => (
    completeSequentialSpeakingPosition(
      'speaking_task3_sessions', applySpeakingTask3AnswerCompletion,
      username, id, questionNumber, completion, options,
    )
  );

  const assignSpeakingTask4Session = (username, options) => assignSpeakingCatalogSession(
    'speaking_task4_sessions', newSpeakingTask4Session, username, options,
  );

  const getSpeakingTask4Session = (username, id) => getSpeakingCatalogSession(
    'speaking_task4_sessions', username, id,
  );

  async function completeSpeakingTask4Session(username, id, completion, { now = new Date() } = {}) {
    return serializeSpeakingSessionMutation(async () => {
      await load();
      const session = state.speaking_task4_sessions.find((item) => item.username === username && item.id === id);
      if (!session) return null;
      if (session.status === 'completed') return structuredClone(session);
      Object.assign(session, speakingTask4CompletionMetadata(completion, now), { status: 'completed' });
      await persist();
      return structuredClone(session);
    });
  }

  async function assignFullSpeakingSession(username, { catalogs, accentProfile = null, now = new Date() }) {
    return serializeSpeakingSessionMutation(async () => {
      await load();
      if (!state.users[username]) throw new Error('USER_NOT_FOUND');
      const active = state.speaking_full_sessions.find((item) => item.username === username
        && item.status === 'in_progress'
        && item.catalog_id === catalogs[0]?.id
        && Number(item.catalog_revision) === Number(catalogs[0]?.revision));
      if (active) {
        try {
          assertFullSpeakingSessionCompatibility(active, catalogs);
          return structuredClone(active);
        } catch (error) {
          if (error?.code !== 'SPEAKING_FULL_CATALOG_REVISION_MISMATCH') throw error;
          abandonFullSpeakingSession(active);
        }
      }
      const history = state.speaking_full_sessions.filter((item) => item.username === username
        && item.catalog_id === catalogs[0]?.id
        && Number(item.catalog_revision) === Number(catalogs[0]?.revision));
      const selection = selectFullSpeakingVariant(catalogs, history);
      const effectiveAccentProfile = state.speaking_accent_profiles[username] || accentProfile || null;
      const session = createFullSpeakingSession({
        username, catalogs, variantIndex: selection.variantIndex,
        selectionReason: selection.reason, accentProfile: effectiveAccentProfile, now,
      });
      state.speaking_full_sessions.push(session);
      await persist();
      return structuredClone(session);
    });
  }

  async function getFullSpeakingSession(username, id) {
    await load();
    const session = state.speaking_full_sessions.find((item) => item.username === username
      && item.id === id && item.status !== 'abandoned');
    return session ? structuredClone(session) : null;
  }

  function assertOrdinaryFullSpeakingMutation(session) {
    if (session.selection_reason === 'ege_mock') {
      throw Object.assign(new Error('SPEAKING_FULL_EGE_LIFECYCLE_REQUIRED'), {
        code: 'SPEAKING_FULL_EGE_LIFECYCLE_REQUIRED',
      });
    }
  }

  async function advanceFullSpeakingSessionStage(username, id, { now = new Date() } = {}) {
    return serializeSpeakingSessionMutation(async () => {
      await load();
      const session = state.speaking_full_sessions.find((item) => item.username === username && item.id === id);
      if (!session) return null;
      assertOrdinaryFullSpeakingMutation(session);
      advanceFullSpeakingStage(session, now);
      await persist();
      return structuredClone(session);
    });
  }

  async function completeFullSpeakingSessionResponse(username, id, completion, { now = new Date() } = {}) {
    return serializeSpeakingSessionMutation(async () => {
      await load();
      const session = state.speaking_full_sessions.find((item) => item.username === username && item.id === id);
      if (!session) return null;
      assertOrdinaryFullSpeakingMutation(session);
      if (Number(session.current_task) !== Number(completion.taskType)
        || Number(session.current_response) !== Number(completion.responseNumber)) {
        throw Object.assign(new Error('SPEAKING_FULL_RESPONSE_OUT_OF_SEQUENCE'), {
          code: 'SPEAKING_FULL_RESPONSE_OUT_OF_SEQUENCE',
        });
      }
      completeFullSpeakingResponse(session, completion, now);
      await persist();
      return structuredClone(session);
    });
  }

  async function claimFullSpeakingSessionAssessment(
    username, id, binding, { voiceConsentPolicyVersion = null } = {},
  ) {
    return serializeSpeakingSessionMutation(async () => {
      await load();
      const session = state.speaking_full_sessions.find((item) => item.username === username && item.id === id);
      if (!session) return null;
      if (session.selection_reason === 'ege_mock') {
        const egeAttempt = state.ege_mock_attempts.find((item) => (
          item.username === username && item.id === session.id
        ));
        if (!egeAttempt) throw Object.assign(new Error('EGE_MOCK_ATTEMPT_NOT_FOUND'), {
          code: 'EGE_MOCK_ATTEMPT_NOT_FOUND',
        });
        if (!['assessment_pending', 'completed'].includes(egeAttempt.state)
          || egeAttempt.oral_submitted_at == null) {
          throw Object.assign(new Error('SPEAKING_FULL_EGE_LIFECYCLE_REQUIRED'), {
            code: 'SPEAKING_FULL_EGE_LIFECYCLE_REQUIRED',
          });
        }
        if (fullSpeakingResponseAssessmentClaimState(session, binding) === 'replayed') {
          return structuredClone(session);
        }
        const effectiveNow = new Date(speakingLearningNow());
        if (!Number.isFinite(effectiveNow.getTime())) throw new Error('SPEAKING_LEARNING_CLOCK_INVALID');
        requireEgeMockProviderAuthorization(
          username, effectiveNow, voiceConsentPolicyVersion,
        );
      }
      claimFullSpeakingResponseAssessment(session, binding);
      await persist();
      return structuredClone(session);
    });
  }

  async function submitFullSpeakingSessionResult(username, id, idempotencyKey, { now = new Date() } = {}) {
    return serializeSpeakingSessionMutation(async () => {
      await load();
      const session = state.speaking_full_sessions.find((item) => item.username === username && item.id === id);
      if (!session) return null;
      assertOrdinaryFullSpeakingMutation(session);
      const result = submitFullSpeakingSession(session, idempotencyKey, now);
      await persist();
      return { session: structuredClone(session), result };
    });
  }

  async function completeFullSpeakingSessionEvaluation(
    username, id, attemptIds, { now = new Date() } = {},
  ) {
    return serializeSpeakingSessionMutation(async () => {
      await load();
      const session = state.speaking_full_sessions.find((item) => item.username === username && item.id === id);
      if (!session) return null;
      let effectiveNow = now;
      let egeAttempt = null;
      if (session.selection_reason === 'ege_mock') {
        effectiveNow = new Date(speakingLearningNow());
        if (!Number.isFinite(effectiveNow.getTime())) throw new Error('SPEAKING_LEARNING_CLOCK_INVALID');
        if (Number(state.users[username]?.sub_until || 0) <= effectiveNow.getTime()) {
          throw Object.assign(new Error('SUBSCRIPTION_REQUIRED'), { code: 'SUBSCRIPTION_REQUIRED' });
        }
        egeAttempt = state.ege_mock_attempts.find((item) => (
          item.username === username && item.id === session.id
        ));
        if (!egeAttempt) throw Object.assign(new Error('EGE_MOCK_ATTEMPT_NOT_FOUND'), {
          code: 'EGE_MOCK_ATTEMPT_NOT_FOUND',
        });
        if (!['assessment_pending', 'completed'].includes(egeAttempt.state)
          || egeAttempt.oral_submitted_at == null) {
          throw Object.assign(new Error('SPEAKING_FULL_EGE_LIFECYCLE_REQUIRED'), {
            code: 'SPEAKING_FULL_EGE_LIFECYCLE_REQUIRED',
          });
        }
      }
      const requestedIds = Array.isArray(attemptIds) ? attemptIds.map(Number) : [];
      const attempts = requestedIds.map((attemptId) => state.speaking_attempts.find((item) => (
        item.username === username && Number(item.id) === attemptId
      )));
      if (attempts.some((attempt) => !attempt)) {
        throw Object.assign(new Error('SPEAKING_FULL_EVALUATION_INVALID'), {
          code: 'SPEAKING_FULL_EVALUATION_INVALID',
        });
      }
      const result = applyFullSpeakingEvaluation(session, attempts, effectiveNow);
      if (session.selection_reason === 'ege_mock') {
        applyEgeMockSpeakingBridgeEvaluation(egeAttempt, result, effectiveNow);
        syncEgeMockDerivedProjections(username, egeAttempt);
      }
      await persist();
      return { session: structuredClone(session), result };
    });
  }

  async function getGeneratedTask(username, requestHash) {
    await load();
    const task = state.generated_tasks.find((item) => item.username === username && item.request_hash === requestHash);
    return task ? structuredClone({ operation: task.operation, request: task.request, result: task.result, provider: task.provider, prompt_version: task.prompt_version, created_at: task.created_at }) : null;
  }

  // Section 10.8: an identical task is reused whoever generated it first.
  async function getSharedGeneratedTask(requestHash) {
    await load();
    const tasks = state.generated_tasks.filter((item) => item.request_hash === requestHash);
    const task = tasks.at(-1);
    return task ? structuredClone({ result: task.result, provider: task.provider, prompt_version: task.prompt_version, created_at: task.created_at }) : null;
  }

  async function saveGeneratedTask(username, entry) {
    await load();
    const existing = state.generated_tasks.find((item) => item.username === username && item.request_hash === entry.requestHash);
    if (existing) return existing.id;
    const id = (state.generated_tasks.at(-1)?.id || 0) + 1;
    state.generated_tasks.push({ id, username, operation: entry.operation, request_hash: entry.requestHash, request: structuredClone(entry.request), result: structuredClone(entry.result), provider: entry.provider, prompt_version: entry.promptVersion, created_at: Date.now() });
    await persist();
    return id;
  }

  async function deleteGeneratedTask(username, requestHash) {
    return serializeCoordinatedMutation(async () => {
      await load();
      const before = state.generated_tasks.length;
      state.generated_tasks = state.generated_tasks.filter((item) => (
        item.username !== username || item.request_hash !== requestHash
      ));
      if (state.generated_tasks.length === before) return false;
      await persist();
      return true;
    });
  }

  /* ---------- Section 10.1: the shared task bank ---------- */

  async function upsertBankTask(task) {
    await load();
    const existing = state.task_bank.find((item) => item.operation === task.operation && item.content_hash === task.contentHash);
    if (existing) return existing.id;
    const id = (state.task_bank.at(-1)?.id || 0) + 1;
    state.task_bank.push({
      id,
      operation: task.operation,
      external_id: task.externalId || null,
      content_hash: task.contentHash,
      content: structuredClone(task.content),
      source: task.source || 'generated',
      provider: task.provider || '',
      prompt_version: task.promptVersion || '',
      retired_at: null,
      created_at: Date.now(),
    });
    await persist();
    return id;
  }

  function viewBankTask(row) {
    return row
      ? structuredClone({ id: row.id, operation: row.operation, externalId: row.external_id, content: row.content, source: row.source })
      : null;
  }

  async function getBankTask(taskId) {
    await load();
    return viewBankTask(state.task_bank.find((item) => item.id === Number(taskId)));
  }

  async function getBankTaskByExternalId(externalId) {
    await load();
    return viewBankTask(state.task_bank.find((item) => item.external_id === externalId));
  }

  async function claimUnseenBankTask(username, operation) {
    await load();
    const delivered = new Set(state.task_deliveries.filter((item) => item.username === username).map((item) => item.task_id));
    const row = state.task_bank
      .filter((item) => item.operation === operation && !item.retired_at && !delivered.has(item.id))
      .sort((first, second) => first.created_at - second.created_at || first.id - second.id)[0];
    if (!row) return null;
    state.task_deliveries.push({ username, task_id: row.id, delivered_at: Date.now() });
    await persist();
    return viewBankTask(row);
  }

  async function recordTaskDelivery(username, taskId) {
    await load();
    const id = Number(taskId);
    if (state.task_deliveries.some((item) => item.username === username && item.task_id === id)) return;
    state.task_deliveries.push({ username, task_id: id, delivered_at: Date.now() });
    await persist();
  }

  async function listBankTaskContents(operation, limit = 60) {
    await load();
    return state.task_bank
      .filter((item) => item.operation === operation && !item.retired_at)
      .sort((first, second) => second.created_at - first.created_at)
      .slice(0, limit)
      .map((item) => structuredClone(item.content));
  }

  async function saveAdaptiveLearningGoal(username, goal) {
    return serializeCoordinatedMutation(async () => {
      await load();
      if (!state.users[username]) throw new Error('USER_NOT_FOUND');
      const duplicate = state.adaptive_learning_goals.find((entry) => (
        entry.username === username && entry.idempotency_key === goal.idempotencyKey
      ));
      if (duplicate) {
        if (duplicate.request_hash !== goal.requestHash) throw new Error('ADAPTIVE_GOAL_IDEMPOTENCY_CONFLICT');
        return { created: false, goal: adaptiveLearningGoalRepositoryDto(duplicate) };
      }
      const current = state.adaptive_learning_goals.filter((entry) => entry.username === username && entry.current);
      for (const entry of current) entry.current = false;
      const stored = {
        id: goal.id,
        username,
        target_exam: goal.targetExam,
        target_score: goal.targetScore,
        exam_date: goal.examDate,
        weekly_minutes: goal.weeklyMinutes,
        revision: Math.max(0, ...state.adaptive_learning_goals
          .filter((entry) => entry.username === username)
          .map((entry) => Number(entry.revision) || 0)) + 1,
        idempotency_key: goal.idempotencyKey,
        request_hash: goal.requestHash,
        current: true,
        created_at: new Date(goal.now).getTime(),
        updated_at: new Date(goal.now).getTime(),
      };
      state.adaptive_learning_goals.push(stored);
      await persist();
      return { created: true, goal: adaptiveLearningGoalRepositoryDto(stored) };
    });
  }

  async function getAdaptiveLearningGoal(username) {
    await load();
    const goals = state.adaptive_learning_goals
      .filter((entry) => entry.username === username && entry.current)
      .sort((first, second) => Number(second.revision) - Number(first.revision));
    return adaptiveLearningGoalRepositoryDto(goals[0]);
  }

  async function getAdaptiveLearningEvidenceSources(username) {
    await load();
    const recoveries = state.voice_tutor_recoveries.filter((entry) => entry.username === username);
    const recoveryById = new Map(recoveries.map((entry) => [entry.id, entry]));
    const repeatById = new Map(state.voice_tutor_repeats
      .filter((entry) => recoveryById.has(entry.recovery_id))
      .map((entry) => [entry.id, entry]));
    const diagnostics = state.adaptive_diagnostic_sessions.filter((entry) => entry.username === username);
    const diagnosticById = new Map(diagnostics.map((entry) => [entry.id, entry]));
    const completedDiagnosticIds = new Set(diagnostics
      .filter((entry) => entry.status === 'completed')
      .map((entry) => entry.id));
    const diagnosticCompletions = diagnostics
      .filter((entry) => entry.status === 'completed' && entry.completed_at)
      .map((entry) => ({ catalog_version: entry.catalog_version, completed_at: entry.completed_at }));
    const assessedAttempts = [
      ...state.writing_attempts
        .filter((entry) => entry.username === username && entry.status === 'completed')
        .map((entry) => ({ entry, module: 'writing', activity: String(entry.task_type), score: entry.review?.overall_got, maxScore: entry.review?.overall_max })),
    ].filter((item) => typeof item.score === 'number' && Number.isFinite(item.score)
        && typeof item.maxScore === 'number' && Number.isFinite(item.maxScore) && item.maxScore > 0)
      .map((item) => ({
        id: `${item.module}:${item.entry.id}`, module: item.module, activity: item.activity,
        score: Math.max(0, Math.min(item.maxScore, item.score)), max_score: item.maxScore,
        duration_ms: null, metadata: {}, evidence_quality: 'server_verified_assisted',
        created_at: item.entry.evaluated_at || item.entry.created_at,
      }));
    return structuredClone({
      attempts: [
        ...state.module_attempts
          .filter((entry) => entry.username === username)
          .map((entry) => ({ ...entry, evidence_quality: entry.evidence_quality || 'client_reported' })),
        ...assessedAttempts,
        ...speakingAdaptiveEvidenceAttempts(boundedSpeakingEvidenceRows(state.speaking_attempts, username)
          .map(buildSpeakingLearningAttempt)
          .filter(Boolean)),
        ...egeMockAdaptiveEvidenceAttempts(
          state.ege_mock_attempts.filter((entry) => entry.username === username),
          getEgeMockForm,
        ),
      ],
      recoveries,
      repeatAttempts: state.voice_tutor_repeat_attempts
        .filter((entry) => repeatById.has(entry.repeat_id))
        .map((entry) => {
          const recovery = recoveryById.get(repeatById.get(entry.repeat_id).recovery_id);
          return { ...entry, skill_id: recovery.skill_id, module: recovery.module };
        }),
      diagnosticResponses: state.adaptive_diagnostic_responses
        .filter((entry) => completedDiagnosticIds.has(entry.diagnostic_id))
        .map((entry) => ({
          id: entry.id,
          diagnostic_id: entry.diagnostic_id,
          item_id: entry.item_id,
          catalog_version: diagnosticById.get(entry.diagnostic_id).catalog_version,
          skill_id: entry.skill_id,
          module: entry.module,
          evidence_quality: entry.evidence_quality,
          correct: entry.correct,
          answered_at: entry.answered_at,
        })),
      diagnosticCompletions,
    });
  }

  async function saveAdaptiveLearningProfile(username, profile, {
    now = new Date(), verifyCurrentEvidence = false, diagnosticRegistry,
  } = {}) {
    return serializeCoordinatedMutation(async () => {
      await load();
      if (!state.users[username]) throw new Error('USER_NOT_FOUND');
      if (verifyCurrentEvidence) {
        const currentSources = await getAdaptiveLearningEvidenceSources(username);
        if (!adaptiveProfileMatchesCurrentEvidence(profile, currentSources, { diagnosticRegistry })) {
          throw new Error('ADAPTIVE_PROFILE_EVIDENCE_STALE');
        }
      }
      const persistedProfile = state.adaptive_learning_profiles[username];
      if (persistedProfile && adaptiveEvidenceFingerprintConflict(profile, persistedProfile)) {
        const currentSources = await getAdaptiveLearningEvidenceSources(username);
        if (!adaptiveProfileMatchesCurrentEvidence(profile, currentSources, { diagnosticRegistry })) {
          return adaptiveLearningProfileRepositoryDto(
            persistedProfile,
            state.adaptive_learning_skill_estimates[username] || [],
          );
        }
      }
      const evidenceOrder = persistedProfile
        ? compareAdaptiveEvidenceWatermarks(profile, persistedProfile)
        : 1;
      const retainedEstimates = state.adaptive_learning_skill_estimates[username] || [];
      if (persistedProfile && (evidenceOrder < 0
        || (evidenceOrder === 0 && !isMonotonicAdaptiveRetentionRefresh(
          profile, persistedProfile, retainedEstimates,
        )))) {
        return adaptiveLearningProfileRepositoryDto(
          persistedProfile,
          retainedEstimates,
        );
      }
      const updatedAt = new Date(now).getTime();
      state.adaptive_learning_profiles[username] = {
        taxonomy_version: profile.taxonomyVersion,
        weighting_version: profile.weightingVersion,
        status: profile.status,
        preliminary: Boolean(profile.preliminary),
        confidence: profile.confidence,
        evidence_count: profile.evidenceCount,
        independent_evidence_count: profile.independentEvidenceCount,
        assisted_evidence_count: profile.assistedEvidenceCount,
        client_reported_evidence_count: profile.clientReportedEvidenceCount,
        independent_module_count: profile.independentModuleCount,
        established_skill_count: profile.establishedSkillCount,
        profile_calculation_revision: profile.profileCalculationRevision,
        evidence_watermark_version: profile.evidenceWatermarkVersion,
        evidence_observed_at: profile.evidenceObservedAt,
        evidence_source_count: profile.evidenceSourceCount,
        evidence_fingerprint: profile.evidenceFingerprint,
        needs_diagnostic: Boolean(profile.needsDiagnostic),
        explanation_codes: structuredClone(profile.explanationCodes),
        updated_at: updatedAt,
      };
      state.adaptive_learning_skill_estimates[username] = profile.skills.map((skill) => ({
        username,
        taxonomy_version: profile.taxonomyVersion,
        skill_id: skill.id,
        module: skill.module,
        mastery: skill.mastery,
        uncertainty: skill.uncertainty,
        evidence_count: skill.evidenceCount,
        effective_evidence_count: skill.effectiveEvidenceCount,
        independent_evidence_count: skill.independentEvidenceCount,
        evidence_quality: skill.evidenceQuality,
        status: skill.status,
        last_observed_at: skill.lastObservedAt,
        due_state: skill.dueState,
        critical_retention_expires_at: skill.criticalRetentionExpiresAt,
        explanation_code: skill.explanationCode,
        updated_at: updatedAt,
      }));
      await persist();
      return adaptiveLearningProfileRepositoryDto(
        state.adaptive_learning_profiles[username],
        state.adaptive_learning_skill_estimates[username],
      );
    });
  }

  async function getAdaptiveLearningProfile(username) {
    await load();
    const profile = state.adaptive_learning_profiles[username];
    if (!profile) return null;
    return adaptiveLearningProfileRepositoryDto(
      profile,
      state.adaptive_learning_skill_estimates[username] || [],
    );
  }

  async function saveAdaptiveLearningPlan(username, candidate, { diagnosticRegistry } = {}) {
    return serializeCoordinatedMutation(async () => {
      await load();
      if (!state.users[username]) throw new Error('USER_NOT_FOUND');
      const current = state.adaptive_learning_plan_revisions
        .filter((entry) => entry.username === username && entry.current)
        .sort((left, right) => Number(right.revision) - Number(left.revision))[0];
      assertAdaptivePlanPersistenceCandidate(candidate);
      const authoritativeProfile = adaptiveLearningProfileRepositoryDto(
        state.adaptive_learning_profiles[username] || null,
        state.adaptive_learning_skill_estimates[username] || [],
      );
      const currentSources = await getAdaptiveLearningEvidenceSources(username);
      if (!adaptiveProfileMatchesCurrentEvidence(authoritativeProfile, currentSources, { diagnosticRegistry })
        || !adaptiveProfileMatchesCurrentEvidence(candidate, currentSources, { diagnosticRegistry })) {
        throw new Error('ADAPTIVE_PLAN_EVIDENCE_STALE');
      }
      const duplicate = state.adaptive_learning_plan_revisions.find((entry) => (
        entry.username === username && entry.input_fingerprint === candidate.inputFingerprint
      ));
      if (duplicate) {
        assertAdaptivePlanDuplicateReplay(candidate, duplicate);
        const historical = Boolean(current) && duplicate.id !== current.id;
        return {
          created: false,
          stale: historical,
          replayed: true,
          conflict: false,
          reason: historical ? 'historical_fingerprint' : 'current_fingerprint',
          plan: adaptiveLearningPlanRepositoryDto(current || duplicate),
        };
      }
      const goal = state.adaptive_learning_goals.find((entry) => entry.username === username && entry.current);
      if (!goal || goal.id !== candidate.goalId || Number(goal.revision) !== Number(candidate.goalRevision)) {
        throw new Error('ADAPTIVE_PLAN_GOAL_STALE');
      }
      assertAdaptivePlanPersistenceCandidate(candidate, {
        authoritativeProfile,
      });
      const currentRevision = current ? Number(current.revision) : null;
      const basePlanRevision = candidate.basePlanRevision == null ? null : Number(candidate.basePlanRevision);
      if (basePlanRevision !== currentRevision) {
        return {
          created: false,
          stale: true,
          replayed: false,
          conflict: true,
          reason: 'base_plan_revision_mismatch',
          plan: adaptiveLearningPlanRepositoryDto(current),
        };
      }
      if (current && compareAdaptivePlanInputs(candidate, current) <= 0) {
        return {
          created: false,
          stale: true,
          replayed: false,
          conflict: false,
          reason: 'evidence_or_bucket_stale',
          plan: adaptiveLearningPlanRepositoryDto(current),
        };
      }
      assertAdaptivePlanAuthoritativeCandidate(candidate, {
        authoritativeGoal: adaptiveLearningGoalRepositoryDto(goal),
        authoritativeProfile,
        currentPlan: adaptiveLearningPlanRepositoryDto(current),
      });
      if (Number(candidate.plan?.goalRevision) !== Number(candidate.goalRevision)) {
        throw new Error('ADAPTIVE_PLAN_STABILITY_VIOLATION');
      }
      assertAdaptivePlanStabilityTransition(current, candidate.plan);
      for (const entry of state.adaptive_learning_plan_revisions) {
        if (entry.username === username && entry.current) entry.current = false;
      }
      const instant = new Date(candidate.now).getTime();
      const stored = {
        id: candidate.id,
        username,
        plan_version: candidate.plan.version,
        revision: Math.max(0, ...state.adaptive_learning_plan_revisions
          .filter((entry) => entry.username === username)
          .map((entry) => Number(entry.revision) || 0)) + 1,
        base_plan_revision: basePlanRevision,
        goal_id: candidate.goalId,
        goal_revision: candidate.goalRevision,
        taxonomy_version: candidate.taxonomyVersion,
        profile_calculation_revision: candidate.profileCalculationRevision,
        profile_evidence_watermark_version: candidate.profileEvidenceWatermarkVersion,
        profile_evidence_observed_at: candidate.profileEvidenceObservedAt,
        profile_evidence_source_count: candidate.profileEvidenceSourceCount,
        profile_evidence_fingerprint: candidate.profileEvidenceFingerprint,
        recalculation_bucket: candidate.recalculationBucket,
        input_fingerprint: candidate.inputFingerprint,
        forecast: structuredClone(candidate.plan.forecast),
        allocation: structuredClone(candidate.plan.allocation),
        stability: structuredClone(candidate.plan.stability),
        current: true,
        created_at: instant,
        updated_at: instant,
      };
      state.adaptive_learning_plan_revisions.push(stored);
      await persist();
      return {
        created: true,
        stale: false,
        replayed: false,
        conflict: false,
        reason: null,
        plan: adaptiveLearningPlanRepositoryDto(stored),
      };
    });
  }

  async function getCurrentAdaptiveLearningPlan(username) {
    await load();
    const plan = state.adaptive_learning_plan_revisions
      .filter((entry) => entry.username === username && entry.current)
      .sort((left, right) => Number(right.revision) - Number(left.revision))[0];
    return adaptiveLearningPlanRepositoryDto(plan);
  }

  async function getAdaptiveLearningPlanRevision(username, revision) {
    await load();
    const plan = state.adaptive_learning_plan_revisions.find((entry) => (
      entry.username === username && Number(entry.revision) === Number(revision)
    ));
    return adaptiveLearningPlanRepositoryDto(plan);
  }

  async function getAdaptiveLearningSessionCreateReplay(username, candidate) {
    await load();
    const duplicate = state.adaptive_learning_sessions.find((entry) => (
      entry.username === username && entry.create_idempotency_key === candidate.idempotencyKey
    ));
    if (!duplicate) return null;
    if (duplicate.create_request_hash !== candidate.requestHash) {
      throw new Error('ADAPTIVE_SESSION_IDEMPOTENCY_CONFLICT');
    }
    return adaptiveLearningSessionPublicDto(duplicate.created_response_snapshot);
  }

  async function createAdaptiveLearningSession(username, candidate) {
    return serializeCoordinatedMutation(async () => {
      await load();
      if (!state.users[username]) throw new Error('USER_NOT_FOUND');
      assertAdaptiveSessionCreateCandidate(candidate);
      const duplicate = state.adaptive_learning_sessions.find((entry) => (
        entry.username === username && entry.create_idempotency_key === candidate.idempotencyKey
      ));
      if (duplicate) {
        if (duplicate.create_request_hash !== candidate.requestHash) {
          throw new Error('ADAPTIVE_SESSION_IDEMPOTENCY_CONFLICT');
        }
        return {
          created: false, replayed: true,
          session: adaptiveLearningSessionPublicDto(duplicate.created_response_snapshot),
        };
      }
      if (candidate.commercialMode === 'free_demo' && state.adaptive_learning_sessions.some((entry) => (
        entry.username === username
      ))) {
        throw new Error('ADAPTIVE_FREE_DEMO_USED');
      }
      const currentPlan = state.adaptive_learning_plan_revisions.find((entry) => (
        entry.username === username && entry.current
      ));
      if (!currentPlan || currentPlan.id !== candidate.planId
        || Number(currentPlan.revision) !== Number(candidate.planRevision)) {
        throw new Error('ADAPTIVE_SESSION_PLAN_STALE');
      }
      const active = state.adaptive_learning_sessions.find((entry) => (
        entry.username === username && ['created', 'in_progress'].includes(entry.status)
      ));
      if (active) throw new Error('ADAPTIVE_SESSION_ALREADY_CURRENT');
      const row = {
        ...adaptiveLearningSessionRepositoryDto(candidate.session),
        commercial_scope: candidate.commercialScope || 'base',
        username,
        create_idempotency_key: candidate.idempotencyKey,
        create_request_hash: candidate.requestHash,
        created_response_snapshot: structuredClone(candidate.session),
        replacement_idempotency_key: null,
        replacement_request_hash: null,
        replacement_response_snapshot: null,
        execution_revision: 0,
        started_at: null,
        completed_at: null,
        completion_summary: null,
      };
      state.adaptive_learning_sessions.push(row);
      await persist();
      return { created: true, replayed: false, session: adaptiveLearningSessionPublicDto(row) };
    });
  }

  async function getCurrentAdaptiveLearningSession(username) {
    await load();
    const row = state.adaptive_learning_sessions
      .filter((entry) => entry.username === username && ['created', 'in_progress'].includes(entry.status))
      .sort((left, right) => new Date(right.created_at) - new Date(left.created_at))[0];
    return adaptiveLearningSessionPublicDto(row);
  }

  async function getAdaptiveLearningSessionCommercialScope(username, sessionId) {
    await load();
    const row = state.adaptive_learning_sessions.find((entry) => (
      entry.username === username && entry.id === sessionId
    ));
    return row?.commercial_scope || (row ? 'base' : null);
  }

  async function getAdaptiveLearningSessionReplacementReplay(username, sessionId, candidate) {
    return serializeCoordinatedMutation(async () => {
      await load();
      const row = state.adaptive_learning_sessions.find((entry) => (
        entry.username === username && entry.replacement_idempotency_key === candidate.idempotencyKey
      ));
      if (row && (row.id !== sessionId || row.replacement_request_hash !== candidate.requestHash)) {
        throw new Error('ADAPTIVE_SESSION_IDEMPOTENCY_CONFLICT');
      }
      const target = state.adaptive_learning_sessions.find((entry) => (
        entry.username === username && entry.id === sessionId
      ));
      if (!target) return null;
      assertAdaptiveSessionReplacementOpen(username, target);
      if (!row) return null;
      return adaptiveLearningSessionPublicDto(row.replacement_response_snapshot);
    });
  }

  function assertAdaptiveSessionReplacementOpen(username, row) {
    const hasClaim = state.adaptive_learning_execution_claims.some((claim) => (
      claim.username === username && claim.session_id === row.id
    ));
    const hasEvent = state.adaptive_learning_session_events.some((event) => (
      event.username === username && event.session_id === row.id
    ));
    if (row.status !== 'created' || row.started_at != null
      || Number(row.execution_revision || 0) > 0 || hasClaim || hasEvent) {
      throw new Error('ADAPTIVE_SESSION_REPLACEMENT_LOCKED');
    }
  }

  async function replaceAdaptiveLearningSessionBlock(username, candidate) {
    return serializeCoordinatedMutation(async () => {
      await load();
      const replay = state.adaptive_learning_sessions.find((entry) => (
        entry.username === username && entry.replacement_idempotency_key === candidate.idempotencyKey
      ));
      if (replay) {
        if (replay.id !== candidate.sessionId || replay.replacement_request_hash !== candidate.requestHash) {
          throw new Error('ADAPTIVE_SESSION_IDEMPOTENCY_CONFLICT');
        }
        assertAdaptiveSessionReplacementOpen(username, replay);
        return {
          replaced: false, replayed: true,
          session: adaptiveLearningSessionPublicDto(replay.replacement_response_snapshot),
        };
      }
      const row = state.adaptive_learning_sessions.find((entry) => (
        entry.username === username && entry.id === candidate.sessionId
      ));
      if (!row) throw new Error('ADAPTIVE_SESSION_NOT_FOUND');
      assertAdaptiveSessionReplacementOpen(username, row);
      if (row.replacement_idempotency_key || row.replacement) {
        throw new Error('ADAPTIVE_SESSION_REPLACEMENT_ALREADY_USED');
      }
      if (Number(row.revision) !== Number(candidate.expectedRevision)) {
        throw new Error('ADAPTIVE_SESSION_REVISION_CONFLICT');
      }
      assertAdaptiveSessionReplacementTransition(adaptiveLearningSessionPublicDto(row), candidate);
      const updated = adaptiveLearningSessionRepositoryDto(candidate.session);
      for (const [key, value] of Object.entries(updated)) row[key] = structuredClone(value);
      row.replacement_idempotency_key = candidate.idempotencyKey;
      row.replacement_request_hash = candidate.requestHash;
      row.replacement_response_snapshot = structuredClone(candidate.session);
      await persist();
      return { replaced: true, replayed: false, session: adaptiveLearningSessionPublicDto(row) };
    });
  }

  function adaptiveSessionRow(username, sessionId) {
    return state.adaptive_learning_sessions.find((entry) => (
      entry.username === username && entry.id === sessionId
    ));
  }

  function adaptiveSessionEvents(username, sessionId) {
    return state.adaptive_learning_session_events
      .filter((entry) => entry.username === username && entry.session_id === sessionId)
      .sort((left, right) => Number(left.sequence) - Number(right.sequence));
  }

  function adaptiveSpeakingSourceMatches(username, block, source, claimIssuedAt) {
    const descriptor = adaptiveSpeakingTask(block?.contentRef);
    const taskType = Number(source?.task_type);
    const sessions = state[`speaking_task${taskType}_sessions`];
    const taskSession = Array.isArray(sessions) ? sessions.find((entry) => (
      entry.username === username && entry.id === source?.source_session_id
    )) : null;
    const evidence = buildSpeakingLearningAttempt(source);
    return Boolean(descriptor
      && descriptor.taskNumber === taskType
      && descriptor.skillId === block.skillId
      && block.module === 'speaking'
      && adaptiveSpeakingActivityMatchesTask(block.activityId, taskType)
      && taskSession
      && taskSession.task_id === source.source_task_ref
      && Number(taskSession.task_revision) === Number(source.source_task_revision)
      && taskSession.catalog_id === source.source_catalog_id
      && Number(taskSession.catalog_revision) === Number(source.source_catalog_revision)
      && taskSession.assistance_used === false
      && source.assistance_used === false
      && new Date(taskSession.assigned_at).getTime() >= new Date(claimIssuedAt).getTime()
      && Number(source.created_at) >= Number(claimIssuedAt)
      && speakingAdaptiveEvidenceMatchesTarget(evidence, {
        skillId: block.skillId,
        focusRef: descriptor.focusRef,
      }));
  }

  function adaptiveMutationReplay(username, candidate) {
    const replay = state.adaptive_learning_session_mutations.find((entry) => (
      entry.username === username && entry.idempotency_key === candidate.idempotencyKey
    ));
    if (!replay) return null;
    if (replay.operation !== candidate.operation || replay.session_id !== candidate.sessionId
      || replay.request_hash !== candidate.requestHash) {
      throw new Error('ADAPTIVE_SESSION_IDEMPOTENCY_CONFLICT');
    }
    return structuredClone(replay.response_snapshot);
  }

  function addAdaptiveMutation(username, candidate, responseSnapshot) {
    state.adaptive_learning_session_mutations.push({
      username,
      idempotency_key: candidate.idempotencyKey,
      operation: candidate.operation,
      session_id: candidate.sessionId,
      request_hash: candidate.requestHash,
      response_snapshot: structuredClone(responseSnapshot),
      created_at: new Date(candidate.now).getTime(),
    });
  }

  function requireAdaptivePremiumDepthEntitlement(username, block, now) {
    if (adaptiveActivityRequiresPremiumDepth(block)
      && !hasVoiceTutorEntitlement(username, new Date(now).getTime())) {
      throw new Error('ADAPTIVE_PREMIUM_REQUIRED');
    }
  }

  function adaptiveMutationEffectiveNow() {
    const effectiveNow = new Date(adaptiveMutationNow());
    if (Number.isNaN(effectiveNow.getTime())) throw new Error('ADAPTIVE_MUTATION_CLOCK_INVALID');
    return effectiveNow;
  }

  function assertAdaptiveStartSnapshotMatchesLockedSession(row, block, snapshot) {
    const lockedSession = adaptiveLearningSessionPublicDto(row);
    if (Number(snapshot?.session?.revision) !== Number(lockedSession.revision)) {
      throw new Error('ADAPTIVE_SESSION_REVISION_CONFLICT');
    }
    if (snapshot.session.id !== lockedSession.id
      || snapshot.session.previewFingerprint !== lockedSession.previewFingerprint
      || JSON.stringify(snapshot.session.replacement ?? null) !== JSON.stringify(lockedSession.replacement ?? null)
      || adaptiveLaunchFingerprint(snapshot.block || {}) !== adaptiveLaunchFingerprint(block)
      || JSON.stringify(snapshot.launch) !== JSON.stringify(block.launch)) {
      throw new Error('ADAPTIVE_SESSION_EXECUTION_SNAPSHOT_INVALID');
    }
  }

  async function getAdaptiveLearningSessionMutationReplay(username, candidate) {
    if (!candidate.blockId) {
      await load();
      return adaptiveMutationReplay(username, candidate);
    }
    return serializeCoordinatedMutation(async () => {
      await load();
      const row = adaptiveSessionRow(username, candidate.sessionId);
      if (!row) throw new Error('ADAPTIVE_SESSION_NOT_FOUND');
      const block = row.blocks.find((item) => item.id === candidate.blockId);
      requireAdaptivePremiumDepthEntitlement(username, block, adaptiveMutationEffectiveNow());
      return adaptiveMutationReplay(username, candidate);
    });
  }

  async function startAdaptiveLearningSessionBlock(username, candidate) {
    return serializeCoordinatedMutation(async () => {
      await load();
      const row = adaptiveSessionRow(username, candidate.sessionId);
      if (!row) throw new Error('ADAPTIVE_SESSION_NOT_FOUND');
      const block = row.blocks.find((item) => item.id === candidate.blockId);
      const effectiveNow = adaptiveMutationEffectiveNow();
      const instant = effectiveNow.getTime();
      requireAdaptivePremiumDepthEntitlement(username, block, effectiveNow);
      const replay = adaptiveMutationReplay(username, { ...candidate, operation: 'start' });
      if (replay) {
        const replayClaim = state.adaptive_learning_execution_claims.find((claim) => (
          claim.id === replay.executionClaimId && claim.username === username
        ));
        if (replayClaim && Number(replayClaim.expires_at) <= instant) {
          throw new Error('ADAPTIVE_EXECUTION_CLAIM_EXPIRED');
        }
        return { created: false, replayed: true, responseSnapshot: replay };
      }
      if (!['created', 'in_progress'].includes(row.status)) throw new Error('ADAPTIVE_SESSION_STATE_CONFLICT');
      if (Number(row.execution_revision || 0) !== Number(candidate.expectedRevision)) {
        throw new Error('ADAPTIVE_SESSION_REVISION_CONFLICT');
      }
      if (row.current_block_id !== candidate.blockId) throw new Error('ADAPTIVE_SESSION_BLOCK_NOT_CURRENT');
      if (!block || block.kind !== 'learning') throw new Error('ADAPTIVE_SESSION_BLOCK_NOT_LAUNCHABLE');
      assertAdaptiveStartSnapshotMatchesLockedSession(row, block, candidate.responseSnapshot);
      let consumedClaim = null;
      for (const claim of state.adaptive_learning_execution_claims) {
        if (claim.username !== username || claim.session_id !== row.id || claim.block_id !== block.id
          || claim.revoked_at) continue;
        if (claim.consumed_at) {
          if (consumedClaim) throw new Error('ADAPTIVE_SESSION_BLOCK_ALREADY_STARTED');
          consumedClaim = claim;
          continue;
        }
        if (Number(claim.expires_at) > instant) {
          throw new Error('ADAPTIVE_SESSION_BLOCK_ALREADY_STARTED');
        }
        claim.revoked_at = instant;
      }
      if (consumedClaim) {
        const recoveryAttempt = adaptiveConsumedClaimAttempt(consumedClaim);
        if (!recoveryAttempt
          || candidate.recoveryResponseSnapshot?.execution?.revision !== Number(row.execution_revision || 0)
          || candidate.recoveryResponseSnapshot?.block?.id !== block.id
          || 'executionClaim' in (candidate.recoveryResponseSnapshot || {})
          || 'executionClaimId' in (candidate.recoveryResponseSnapshot || {})) {
          throw new Error('ADAPTIVE_SESSION_EXECUTION_SNAPSHOT_INVALID');
        }
        const recoverySnapshot = {
          ...structuredClone(candidate.recoveryResponseSnapshot), recoveryAttempt,
        };
        addAdaptiveMutation(username, { ...candidate, operation: 'start' }, recoverySnapshot);
        await persist();
        return {
          created: false, replayed: false, recovered: true,
          responseSnapshot: structuredClone(recoverySnapshot),
        };
      }
      const nextRevision = Number(row.execution_revision || 0) + 1;
      const expiresAt = new Date(instant + ADAPTIVE_EXECUTION_CLAIM_TTL_MS);
      const responseSnapshot = {
        ...structuredClone(candidate.responseSnapshot),
        session: {
          ...structuredClone(candidate.responseSnapshot?.session),
          status: 'in_progress',
          updatedAt: effectiveNow.toISOString(),
        },
        execution: {
          ...structuredClone(candidate.responseSnapshot?.execution),
          startedAt: row.started_at
            ? new Date(row.started_at).toISOString() : effectiveNow.toISOString(),
        },
        claimExpiresAt: expiresAt.toISOString(),
      };
      if (candidate.responseSnapshot?.execution?.revision !== nextRevision
        || candidate.responseSnapshot?.block?.id !== block.id
        || candidate.responseSnapshot?.executionClaimId !== candidate.claimId
        || JSON.stringify(candidate.responseSnapshot).includes(candidate.token)
        || adaptiveExecutionTokenHash(candidate.token) !== candidate.tokenHash) {
        throw new Error('ADAPTIVE_SESSION_EXECUTION_SNAPSHOT_INVALID');
      }
      state.adaptive_learning_execution_claims.push({
        id: candidate.claimId,
        username,
        session_id: row.id,
        block_id: block.id,
        session_execution_revision: nextRevision,
        token_hash: candidate.tokenHash,
        launch_fingerprint: adaptiveLaunchFingerprint(block),
        evidence_context: candidate.evidenceContext,
        issued_at: instant,
        expires_at: expiresAt.getTime(),
        consumed_at: null,
        revoked_at: null,
        attempt_type: null,
        attempt_ref: null,
      });
      row.execution_revision = nextRevision;
      row.status = 'in_progress';
      row.started_at ||= instant;
      row.updated_at = instant;
      addAdaptiveMutation(username, { ...candidate, operation: 'start' }, responseSnapshot);
      await persist();
      return { created: true, replayed: false, responseSnapshot: structuredClone(responseSnapshot) };
    });
  }

  async function getAdaptiveLearningSessionExecution(username, sessionId) {
    await load();
    const row = adaptiveSessionRow(username, sessionId);
    if (!row) return null;
    const events = adaptiveSessionEvents(username, sessionId);
    return {
      session: adaptiveLearningSessionPublicDto(row),
      execution: adaptiveExecutionView(row, events),
      events: events.map(adaptiveExecutionEventExportDto),
      summary: row.completion_summary ? structuredClone(row.completion_summary) : null,
    };
  }

  function sourceEventForAdvance(username, row, block, attempt, authorityNow = null) {
    if (block.kind === 'break') {
      if (attempt != null) throw new Error('ADAPTIVE_SESSION_BREAK_ATTEMPT_FORBIDDEN');
      return {
        source_type: null, source_ref: null, evidence_quality: null, evidence_context: null,
        actual_minutes: null,
      };
    }
    if (!attempt) throw new Error('ADAPTIVE_SESSION_ATTEMPT_REQUIRED');
    const claim = state.adaptive_learning_execution_claims.find((entry) => (
      entry.username === username && entry.session_id === row.id && entry.block_id === block.id
      && entry.attempt_type === attempt.type && String(entry.attempt_ref) === String(attempt.id)
      && entry.consumed_at && !entry.revoked_at
    ));
    if (!claim) throw new Error('ADAPTIVE_SESSION_ATTEMPT_NOT_BOUND');
    if (authorityNow && Number(claim.expires_at) <= new Date(authorityNow).getTime()) {
      throw new Error('ADAPTIVE_EXECUTION_CLAIM_EXPIRED');
    }
    if (claim.launch_fingerprint !== adaptiveLaunchFingerprint(block)
      || Number(claim.session_execution_revision) !== Number(row.execution_revision || 0)) {
      throw new Error('ADAPTIVE_SESSION_ATTEMPT_MISMATCH');
    }
    if (attempt.type === 'voice_tutor_repeat') {
      const source = state.voice_tutor_repeat_attempts.find((item) => item.id === attempt.id);
      const repeat = state.voice_tutor_repeats.find((item) => item.id === source?.repeat_id);
      const recovery = state.voice_tutor_recoveries.find((item) => (
        item.id === repeat?.recovery_id && item.username === username
      ));
      if (!adaptiveRepeatExecutionMatches({
        username, block, repeat, recovery, attempt: source, claimIssuedAt: claim.issued_at,
      })) {
        throw new Error('ADAPTIVE_SESSION_ATTEMPT_MISMATCH');
      }
      return {
        source_type: 'voice_tutor_repeat', source_ref: source.id,
        evidence_quality: 'server_verified_unassisted', evidence_context: claim.evidence_context,
        actual_minutes: null,
      };
    }
    if (attempt.type === 'module') {
      const source = state.module_attempts.find((item) => (
        item.username === username && item.id === attempt.id
      ));
      if (!source || source.module !== block.module || source.activity !== block.activityId
        || source.metadata?.adaptive_session_id !== row.id
        || source.metadata?.adaptive_block_id !== block.id
        || Number(source.created_at) < Number(claim.issued_at)) {
        throw new Error('ADAPTIVE_SESSION_ATTEMPT_MISMATCH');
      }
      return {
        source_type: 'module', source_ref: source.id,
        evidence_quality: source.evidence_quality, evidence_context: claim.evidence_context,
        actual_minutes: source.duration_ms == null ? null : Math.max(0, Math.round(source.duration_ms / 60_000)),
      };
    }
    const source = attempt.type === 'writing'
      ? state.writing_attempts.find((item) => item.username === username && Number(item.id) === Number(attempt.id))
      : state.speaking_attempts.find((item) => item.username === username && Number(item.id) === Number(attempt.id));
    const exactTask = attempt.type === 'writing'
      ? source?.source_task_ref === block.launch?.taskId
      : adaptiveSpeakingSourceMatches(username, block, source, claim.issued_at);
    if (!source || source.status !== 'completed' || Number(source.created_at) < Number(claim.issued_at)
      || !exactTask) {
      throw new Error('ADAPTIVE_SESSION_ATTEMPT_MISMATCH');
    }
    return {
      source_type: attempt.type, source_ref: String(source.id),
      evidence_quality: attempt.type === 'speaking'
        ? 'server_verified_unassisted' : 'server_verified_assisted',
      evidence_context: claim.evidence_context,
      actual_minutes: null,
    };
  }

  async function getAdaptiveLearningSessionAdvanceContext(username, candidate) {
    await load();
    const row = adaptiveSessionRow(username, candidate.sessionId);
    if (!row) return null;
    if (Number(row.execution_revision || 0) !== Number(candidate.expectedRevision)) {
      throw new Error('ADAPTIVE_SESSION_REVISION_CONFLICT');
    }
    if (row.current_block_id !== candidate.blockId) throw new Error('ADAPTIVE_SESSION_BLOCK_NOT_CURRENT');
    const block = row.blocks.find((item) => item.id === candidate.blockId);
    if (!block) throw new Error('ADAPTIVE_SESSION_BLOCK_NOT_CURRENT');
    const source = sourceEventForAdvance(username, row, block, candidate.attempt);
    const nextBlock = row.blocks.find((item) => item.position === block.position + 1) || null;
    return {
      session: adaptiveLearningSessionPublicDto(row),
      execution: adaptiveExecutionView(row, adaptiveSessionEvents(username, row.id)),
      block: structuredClone(block),
      source,
      nextBlock: nextBlock ? structuredClone(nextBlock) : null,
    };
  }

  async function advanceAdaptiveLearningSession(username, candidate) {
    return serializeCoordinatedMutation(async () => {
      await load();
      const row = adaptiveSessionRow(username, candidate.sessionId);
      if (!row) throw new Error('ADAPTIVE_SESSION_NOT_FOUND');
      const block = row.blocks.find((item) => item.id === candidate.blockId);
      const effectiveNow = adaptiveMutationEffectiveNow();
      requireAdaptivePremiumDepthEntitlement(username, block, effectiveNow);
      const replay = adaptiveMutationReplay(username, { ...candidate, operation: 'advance' });
      if (replay) return { advanced: false, replayed: true, responseSnapshot: replay };
      if (Number(row.execution_revision || 0) !== Number(candidate.expectedRevision)) {
        throw new Error('ADAPTIVE_SESSION_REVISION_CONFLICT');
      }
      if (row.current_block_id !== candidate.blockId) throw new Error('ADAPTIVE_SESSION_BLOCK_NOT_CURRENT');
      const source = sourceEventForAdvance(username, row, block, candidate.attempt, effectiveNow);
      if (adaptiveSessionEvents(username, row.id).some((event) => event.block_id === block.id)) {
        throw new Error('ADAPTIVE_SESSION_BLOCK_ALREADY_COMPLETED');
      }
      const nextBlock = row.blocks.find((item) => item.position === block.position + 1) || null;
      const instant = effectiveNow.getTime();
      const event = {
        id: candidate.eventId,
        username,
        session_id: row.id,
        sequence: adaptiveSessionEvents(username, row.id).length + 1,
        event_type: 'block_completed',
        block_id: block.id,
        block_kind: block.kind,
        module: block.module,
        skill_id: block.skillId,
        activity_id: block.activityId,
        source_type: source.source_type,
        source_ref: source.source_ref,
        evidence_quality: source.evidence_quality,
        evidence_context: source.evidence_context,
        planned_minutes: block.plannedMinutes,
        actual_minutes: source.actual_minutes,
        created_at: instant,
      };
      const nextRevision = Number(row.execution_revision || 0) + 1;
      if (candidate.responseSnapshot?.execution?.revision !== nextRevision
        || candidate.responseSnapshot?.completedBlock?.blockId !== block.id
        || candidate.responseSnapshot?.session?.currentBlockId !== (nextBlock?.id || null)) {
        throw new Error('ADAPTIVE_SESSION_EXECUTION_SNAPSHOT_INVALID');
      }
      state.adaptive_learning_session_events.push(event);
      row.execution_revision = nextRevision;
      row.current_block_id = nextBlock?.id || null;
      if (block.kind === 'learning') {
        row.completed_learning_minutes = Number(row.completed_learning_minutes || 0) + block.plannedMinutes;
      }
      row.updated_at = instant;
      addAdaptiveMutation(username, { ...candidate, operation: 'advance' }, candidate.responseSnapshot);
      await persist();
      return { advanced: true, replayed: false, event: adaptiveExecutionEventExportDto(event), responseSnapshot: structuredClone(candidate.responseSnapshot) };
    });
  }

  async function getAdaptiveLearningSessionFinishContext(username, candidate) {
    await load();
    const row = adaptiveSessionRow(username, candidate.sessionId);
    if (!row) return null;
    const events = adaptiveSessionEvents(username, row.id);
    return {
      session: adaptiveLearningSessionPublicDto(row),
      execution: adaptiveExecutionView(row, events),
      events: events.map(adaptiveExecutionEventExportDto),
    };
  }

  async function finishAdaptiveLearningSession(username, candidate) {
    return serializeCoordinatedMutation(async () => {
      await load();
      const replay = adaptiveMutationReplay(username, { ...candidate, operation: 'finish' });
      if (replay) return { finished: false, replayed: true, responseSnapshot: replay };
      const row = adaptiveSessionRow(username, candidate.sessionId);
      if (!row) throw new Error('ADAPTIVE_SESSION_NOT_FOUND');
      if (Number(row.execution_revision || 0) !== Number(candidate.expectedRevision)) {
        throw new Error('ADAPTIVE_SESSION_REVISION_CONFLICT');
      }
      if (row.status !== 'in_progress' || row.current_block_id !== null) {
        throw new Error('ADAPTIVE_SESSION_NOT_READY_TO_FINISH');
      }
      const events = adaptiveSessionEvents(username, row.id);
      if (events.filter((event) => event.event_type === 'block_completed').length !== row.blocks.length) {
        throw new Error('ADAPTIVE_SESSION_NOT_READY_TO_FINISH');
      }
      const nextRevision = Number(row.execution_revision || 0) + 1;
      const summary = adaptiveExecutionSummary(row, events, candidate.nextRecommendedAction, {
        planRevisionAfter: candidate.planRevisionAfter,
      });
      if (candidate.responseSnapshot?.execution?.revision !== nextRevision
        || candidate.responseSnapshot?.session?.status !== 'completed'
        || JSON.stringify(candidate.responseSnapshot?.summary) !== JSON.stringify(summary)) {
        throw new Error('ADAPTIVE_SESSION_EXECUTION_SNAPSHOT_INVALID');
      }
      const instant = new Date(candidate.now).getTime();
      row.execution_revision = nextRevision;
      row.status = 'completed';
      row.completed_at = instant;
      row.completion_summary = structuredClone(summary);
      row.updated_at = instant;
      state.adaptive_learning_session_events.push({
        id: candidate.eventId, username, session_id: row.id, sequence: events.length + 1,
        event_type: 'session_finished', block_id: null, block_kind: null, module: null,
        skill_id: null, activity_id: null, source_type: null, source_ref: null,
        evidence_quality: null, evidence_context: null, planned_minutes: 0, actual_minutes: null,
        created_at: instant,
      });
      addAdaptiveMutation(username, { ...candidate, operation: 'finish' }, candidate.responseSnapshot);
      await persist();
      return { finished: true, replayed: false, responseSnapshot: structuredClone(candidate.responseSnapshot) };
    });
  }

  async function getAdaptiveLearningWeekUsage(username, weekStart) {
    await load();
    const totals = new Map();
    for (const row of state.adaptive_learning_sessions) {
      if (row.username !== username || row.week_start !== weekStart || row.status === 'abandoned') continue;
      for (const block of row.blocks.filter((item) => item.kind === 'learning')) {
        const current = totals.get(block.skillId) || { skillId: block.skillId, plannedMinutes: 0, completedMinutes: 0 };
        current.plannedMinutes += block.plannedMinutes;
        totals.set(block.skillId, current);
      }
    }
    return [...totals.values()].sort((left, right) => left.skillId.localeCompare(right.skillId));
  }

  async function getAdaptiveLearningCommercialUsage(username) {
    await load();
    const sessions = state.adaptive_learning_sessions.filter((entry) => entry.username === username);
    const diagnostics = state.adaptive_diagnostic_sessions.filter((entry) => entry.username === username);
    return {
      shortDiagnosticsCompleted: diagnostics.filter((entry) => (
        entry.status === 'completed'
          && ['ege-short-diagnostic-v1', 'ege-short-diagnostic-v2'].includes(entry.catalog_version)
      )).length,
      deepDiagnosticsCompleted: diagnostics.filter((entry) => (
        entry.status === 'completed'
          && ['ege-deep-diagnostic-v1', 'ege-deep-diagnostic-v2'].includes(entry.catalog_version)
      )).length,
      sessionsCreated: sessions.length,
      sessionsCompleted: sessions.filter((entry) => entry.status === 'completed').length,
    };
  }

  async function getAdaptiveLearningCompletedSessionReports(username, { limit = 12 } = {}) {
    await load();
    return state.adaptive_learning_sessions
      .filter((entry) => entry.username === username && entry.status === 'completed' && entry.completion_summary)
      .sort((left, right) => Number(right.completed_at) - Number(left.completed_at))
      .slice(0, Math.max(1, Math.min(12, Number(limit) || 12)))
      .map((entry) => ({
        session: {
          ...adaptiveLearningSessionPublicDto(entry),
          completedAt: new Date(entry.completed_at).toISOString(),
        },
        summary: structuredClone(entry.completion_summary),
      }));
  }

  async function getAdaptiveLearningMetrics({ now = new Date() } = {}) {
    await load();
    const repeatStageById = new Map(state.voice_tutor_repeats.map((repeat) => [
      String(repeat.id), String(repeat.stage || ''),
    ]));
    return buildAdaptiveLearningMetrics({
      sessions: state.adaptive_learning_sessions,
      events: state.adaptive_learning_session_events,
      diagnosticSessions: state.adaptive_diagnostic_sessions,
      skillEstimates: Object.values(state.adaptive_learning_skill_estimates).flat(),
      repeatAttempts: state.voice_tutor_repeat_attempts.map((attempt) => ({
        id: attempt.id,
        stage: repeatStageById.get(String(attempt.repeat_id)) || '',
        passed: attempt.passed === true,
      })),
    }, { now });
  }

  async function startAdaptiveDiagnostic(username, diagnostic) {
    return serializeCoordinatedMutation(async () => {
      await load();
      if (!state.users[username]) throw new Error('USER_NOT_FOUND');
      const instant = new Date(diagnostic.now).getTime();
      state.adaptive_diagnostic_start_claims = state.adaptive_diagnostic_start_claims
        .filter((entry) => Number(entry.claim_expires_at) > instant);
      const duplicate = state.adaptive_diagnostic_start_claims.find((entry) => (
        entry.username === username && entry.idempotency_key === diagnostic.idempotencyKey
      ));
      if (duplicate) {
        if (duplicate.request_hash !== diagnostic.requestHash) throw new Error('ADAPTIVE_DIAGNOSTIC_IDEMPOTENCY_CONFLICT');
        return { created: false, diagnostic: adaptiveDiagnosticStartClaimRepositoryDto(duplicate) };
      }
      if (diagnostic.commercialMode === 'free_short' && state.adaptive_diagnostic_sessions.some((entry) => (
        entry.username === username && entry.status === 'completed'
          && ['ege-short-diagnostic-v1', 'ege-short-diagnostic-v2'].includes(entry.catalog_version)
      ))) {
        throw new Error('ADAPTIVE_FREE_DIAGNOSTIC_USED');
      }
      const ownerClaimCount = state.adaptive_diagnostic_start_claims
        .filter((entry) => entry.username === username).length;
      if (ownerClaimCount >= ADAPTIVE_DIAGNOSTIC_START_CLAIM_LIMIT) {
        throw new Error('ADAPTIVE_DIAGNOSTIC_START_LIMIT');
      }
      for (const entry of state.adaptive_diagnostic_sessions) {
        if (entry.username === username && ['in_progress', 'ready'].includes(entry.status)
          && Number(entry.expires_at) <= instant) {
          entry.status = 'expired';
          entry.current_item_id = null;
          entry.stop_reason = 'maximum_time';
          entry.updated_at = instant;
        }
      }
      let active = state.adaptive_diagnostic_sessions.find((entry) => (
        entry.username === username && ['in_progress', 'ready'].includes(entry.status)
      ));
      if (active && active.catalog_version !== diagnostic.catalogVersion) {
        throw new Error('ADAPTIVE_DIAGNOSTIC_ALREADY_CURRENT');
      }
      const created = !active;
      if (!active) {
        active = {
          id: diagnostic.id,
          username,
          catalog_version: diagnostic.catalogVersion,
          status: 'in_progress',
          current_item_id: diagnostic.currentItemId,
          answered_items: 0,
          correct_items: 0,
          stop_reason: null,
          idempotency_key: diagnostic.idempotencyKey,
          request_hash: diagnostic.requestHash,
          started_at: instant,
          expires_at: new Date(diagnostic.expiresAt).getTime(),
          completed_at: null,
          updated_at: instant,
        };
        state.adaptive_diagnostic_sessions.push(active);
      }
      const claim = {
        username,
        idempotency_key: diagnostic.idempotencyKey,
        request_hash: diagnostic.requestHash,
        diagnostic_id: active.id,
        catalog_version: active.catalog_version,
        status: active.status,
        current_item_id: active.current_item_id,
        answered_items: active.answered_items,
        correct_items: active.correct_items,
        stop_reason: active.stop_reason,
        started_at: active.started_at,
        expires_at: active.expires_at,
        completed_at: active.completed_at,
        updated_at: active.updated_at,
        claimed_at: instant,
        claim_expires_at: adaptiveDiagnosticClaimExpiresAt(diagnostic.now).getTime(),
      };
      state.adaptive_diagnostic_start_claims.push(claim);
      await persist();
      return { created, diagnostic: adaptiveDiagnosticStartClaimRepositoryDto(claim) };
    });
  }

  async function getAdaptiveDiagnosticStartClaim(username, claim) {
    await load();
    const instant = new Date(claim.now ?? Date.now()).getTime();
    const stored = state.adaptive_diagnostic_start_claims.find((entry) => (
      entry.username === username && entry.idempotency_key === claim.idempotencyKey
        && Number(entry.claim_expires_at) > instant
    ));
    if (!stored) return null;
    if (stored.request_hash !== claim.requestHash) throw new Error('ADAPTIVE_DIAGNOSTIC_IDEMPOTENCY_CONFLICT');
    return adaptiveDiagnosticStartClaimRepositoryDto(stored);
  }

  async function getCurrentAdaptiveDiagnostic(username) {
    await load();
    const session = state.adaptive_diagnostic_sessions
      .filter((entry) => entry.username === username)
      .sort((left, right) => Number(right.started_at) - Number(left.started_at))[0];
    if (!session || session.status === 'completed') return null;
    const responses = state.adaptive_diagnostic_responses.filter((entry) => entry.diagnostic_id === session.id);
    return adaptiveDiagnosticRepositoryDto(session, responses);
  }

  async function getAdaptiveDiagnostic(username, diagnosticId) {
    await load();
    const session = state.adaptive_diagnostic_sessions.find((entry) => (
      entry.username === username && entry.id === diagnosticId
    ));
    if (!session) return null;
    const responses = state.adaptive_diagnostic_responses.filter((entry) => entry.diagnostic_id === session.id);
    return adaptiveDiagnosticRepositoryDto(session, responses);
  }

  async function getAdaptiveDiagnosticCompletionReplay(username, completion) {
    await load();
    const session = state.adaptive_diagnostic_sessions.find((entry) => (
      entry.id === completion.diagnosticId && entry.username === username
    ));
    if (!session || session.status !== 'completed') return null;
    if (session.completion_idempotency_key === completion.idempotencyKey
      && session.completion_request_hash !== completion.requestHash) {
      throw new Error('ADAPTIVE_DIAGNOSTIC_IDEMPOTENCY_CONFLICT');
    }
    const responseSnapshot = adaptiveDiagnosticCompletionSnapshotDto(
      session.completion_response_snapshot,
    );
    if (!responseSnapshot) throw new Error('ADAPTIVE_DIAGNOSTIC_COMPLETION_SNAPSHOT_MISSING');
    return responseSnapshot;
  }

  async function answerAdaptiveDiagnostic(username, answer) {
    return serializeCoordinatedMutation(async () => {
      await load();
      const session = state.adaptive_diagnostic_sessions.find((entry) => (
        entry.id === answer.diagnosticId && entry.username === username
      ));
      if (!session) throw new Error('ADAPTIVE_DIAGNOSTIC_NOT_FOUND');
      const responses = state.adaptive_diagnostic_responses.filter((entry) => entry.diagnostic_id === session.id);
      const duplicate = responses.find((entry) => entry.idempotency_key === answer.idempotencyKey);
      if (duplicate) {
        if (duplicate.request_hash !== answer.requestHash) throw new Error('ADAPTIVE_DIAGNOSTIC_IDEMPOTENCY_CONFLICT');
        return { created: false, diagnostic: adaptiveDiagnosticAnswerClaimRepositoryDto(duplicate) };
      }
      if (session.status === 'expired' && session.stop_reason === 'maximum_time') {
        throw new Error('ADAPTIVE_DIAGNOSTIC_TIME_EXPIRED');
      }
      if (['in_progress', 'ready'].includes(session.status)
        && Number(session.expires_at) <= new Date(answer.now).getTime()) {
        session.status = 'expired';
        session.current_item_id = null;
        session.stop_reason = 'maximum_time';
        session.updated_at = new Date(answer.now).getTime();
        await persist();
        throw new Error('ADAPTIVE_DIAGNOSTIC_TIME_EXPIRED');
      }
      if (responses.some((entry) => entry.item_id === answer.itemId)) {
        throw new Error('ADAPTIVE_DIAGNOSTIC_ITEM_ALREADY_ANSWERED');
      }
      if (session.status !== 'in_progress' || session.current_item_id !== answer.itemId) {
        throw new Error('ADAPTIVE_DIAGNOSTIC_ITEM_NOT_CURRENT');
      }
      const stored = {
        id: answer.id,
        diagnostic_id: session.id,
        item_id: answer.itemId,
        skill_id: answer.skillId,
        module: answer.module,
        evidence_quality: answer.evidenceQuality,
        choice_id: answer.choiceId,
        correct: Boolean(answer.correct),
        response_ms: answer.responseMs,
        idempotency_key: answer.idempotencyKey,
        request_hash: answer.requestHash,
        answered_at: new Date(answer.now).getTime(),
      };
      state.adaptive_diagnostic_responses.push(stored);
      const updatedResponses = [...responses, stored];
      session.current_item_id = answer.nextItemId;
      session.status = answer.status || 'in_progress';
      session.stop_reason = answer.stopReason || null;
      session.answered_items = updatedResponses.length;
      session.correct_items = updatedResponses.filter((entry) => entry.correct).length;
      session.updated_at = new Date(answer.now).getTime();
      Object.assign(stored, {
        replay_catalog_version: session.catalog_version,
        replay_status: session.status,
        replay_current_item_id: session.current_item_id,
        replay_answered_items: session.answered_items,
        replay_correct_items: session.correct_items,
        replay_stop_reason: session.stop_reason,
        replay_started_at: session.started_at,
        replay_expires_at: session.expires_at,
        replay_completed_at: session.completed_at,
        replay_updated_at: session.updated_at,
      });
      await persist();
      return { created: true, diagnostic: adaptiveDiagnosticRepositoryDto(session, updatedResponses) };
    });
  }

  async function completeAdaptiveDiagnostic(username, completion) {
    return serializeCoordinatedMutation(async () => {
      await load();
      const session = state.adaptive_diagnostic_sessions.find((entry) => (
        entry.id === completion.diagnosticId && entry.username === username
      ));
      if (!session) throw new Error('ADAPTIVE_DIAGNOSTIC_NOT_FOUND');
      const responses = state.adaptive_diagnostic_responses.filter((entry) => entry.diagnostic_id === session.id);
      if (session.status === 'completed') {
        if (session.completion_idempotency_key === completion.idempotencyKey
          && session.completion_request_hash !== completion.requestHash) {
          throw new Error('ADAPTIVE_DIAGNOSTIC_IDEMPOTENCY_CONFLICT');
        }
        const responseSnapshot = adaptiveDiagnosticCompletionSnapshotDto(
          session.completion_response_snapshot,
        );
        if (!responseSnapshot) throw new Error('ADAPTIVE_DIAGNOSTIC_COMPLETION_SNAPSHOT_MISSING');
        return {
          created: false,
          diagnostic: adaptiveDiagnosticRepositoryDto(session, responses),
          responseSnapshot,
        };
      }
      if (session.status === 'expired' && session.stop_reason === 'maximum_time') {
        throw new Error('ADAPTIVE_DIAGNOSTIC_TIME_EXPIRED');
      }
      if (session.status === 'ready'
        && Number(session.expires_at) <= new Date(completion.now).getTime()) {
        session.status = 'expired';
        session.current_item_id = null;
        session.stop_reason = 'maximum_time';
        session.updated_at = new Date(completion.now).getTime();
        await persist();
        throw new Error('ADAPTIVE_DIAGNOSTIC_TIME_EXPIRED');
      }
      if (session.status !== 'ready') throw new Error('ADAPTIVE_DIAGNOSTIC_NOT_READY');
      const responseSnapshot = adaptiveDiagnosticCompletionSnapshotDto(completion.responseSnapshot);
      if (!responseSnapshot
        || responseSnapshot.diagnostic.id !== session.id
        || responseSnapshot.diagnostic.catalogVersion !== session.catalog_version
        || responseSnapshot.diagnostic.status !== 'completed'
        || responseSnapshot.diagnostic.answeredItems !== Number(session.answered_items)
        || responseSnapshot.result.correctItems !== Number(session.correct_items)) {
        throw new Error('ADAPTIVE_DIAGNOSTIC_COMPLETION_SNAPSHOT_INVALID');
      }
      session.status = 'completed';
      session.current_item_id = null;
      session.completion_idempotency_key = completion.idempotencyKey;
      session.completion_request_hash = completion.requestHash;
      session.completion_response_snapshot = responseSnapshot;
      session.completed_at = new Date(completion.now).getTime();
      session.updated_at = session.completed_at;
      await persist();
      return {
        created: true,
        diagnostic: adaptiveDiagnosticRepositoryDto(session, responses),
        responseSnapshot: structuredClone(responseSnapshot),
      };
    });
  }

  async function recordModuleAttempt(username, attempt, { evidenceQuality = 'client_reported' } = {}) {
    return serializeCoordinatedMutation(async () => {
      await load();
      const trustedEvidenceQuality = requireModuleAttemptEvidenceQuality(evidenceQuality);
      if (state.module_attempts.some((item) => item.id === attempt.id)) return { id: attempt.id, created: false };
      state.module_attempts.push({ id: attempt.id, username, module: attempt.module, activity: attempt.activity, score: attempt.score, max_score: attempt.maxScore, duration_ms: attempt.durationMs ?? null, metadata: structuredClone(attempt.metadata || {}), evidence_quality: trustedEvidenceQuality, created_at: Date.now() });
      state.progress_summary[username] ||= {};
      const summary = state.progress_summary[username][attempt.module] ||= { module: attempt.module, attempt_count: 0, best_score: 0, best_max_score: 1, total_duration_ms: 0, last_attempt_at: null, updated_at: null };
      summary.attempt_count += 1;
      if (attempt.score / attempt.maxScore > summary.best_score / summary.best_max_score) {
        summary.best_score = attempt.score;
        summary.best_max_score = attempt.maxScore;
      }
      summary.total_duration_ms += attempt.durationMs ?? 0;
      summary.last_attempt_at = Date.now();
      summary.updated_at = summary.last_attempt_at;
      await persist();
      return { id: attempt.id, created: true };
    });
  }

  async function recordModuleAttemptWithAdaptiveClaim(username, attempt, { executionClaim }) {
    return serializeCoordinatedMutation(async () => {
      await load();
      const tokenHash = adaptiveExecutionTokenHash(executionClaim);
      const claim = state.adaptive_learning_execution_claims.find((entry) => entry.token_hash === tokenHash);
      const instant = adaptiveMutationEffectiveNow().getTime();
      if (!claim || claim.username !== username) throw new Error('ADAPTIVE_EXECUTION_CLAIM_INVALID');
      const row = adaptiveSessionRow(username, claim.session_id);
      const block = row?.blocks.find((item) => item.id === claim.block_id);
      if (!row || !block || row.current_block_id !== block.id || row.status !== 'in_progress'
        || Number(row.execution_revision || 0) !== Number(claim.session_execution_revision)
        || claim.revoked_at || Number(claim.expires_at) <= instant
        || claim.launch_fingerprint !== adaptiveLaunchFingerprint(block)) {
        throw new Error(Number(claim.expires_at) <= instant
          ? 'ADAPTIVE_EXECUTION_CLAIM_EXPIRED' : 'ADAPTIVE_EXECUTION_CLAIM_INVALID');
      }
      const existing = state.module_attempts.find((item) => item.id === attempt.id);
      if (['writing', 'speaking'].includes(block.module)) {
        throw new Error('ADAPTIVE_EXECUTION_ATTEMPT_MISMATCH');
      }
      if (claim.consumed_at) {
        if (claim.attempt_type !== 'module' || claim.attempt_ref !== attempt.id || !existing
          || existing.username !== username || existing.module !== attempt.module
          || existing.activity !== attempt.activity || existing.score !== attempt.score
          || existing.max_score !== attempt.maxScore || existing.duration_ms !== (attempt.durationMs ?? null)) {
          throw new Error('ADAPTIVE_EXECUTION_CLAIM_CONSUMED');
        }
        return {
          id: attempt.id, created: false, evidenceQuality: existing.evidence_quality,
          adaptiveExecution: {
            sessionId: row.id, blockId: block.id, attemptType: 'module', attemptId: attempt.id,
          },
        };
      }
      if (existing || attempt.module !== block.module || attempt.activity !== block.activityId) {
        throw new Error('ADAPTIVE_EXECUTION_ATTEMPT_MISMATCH');
      }
      const metadata = {
        adaptive_session_id: row.id,
        adaptive_block_id: block.id,
        adaptive_content_ref: block.contentRef,
        ...(block.module === 'reading'
          ? adaptiveReadingMetadata(attempt.metadata, block)
          : adaptiveAssistedMetadata(attempt.metadata)),
      };
      state.module_attempts.push({
        id: attempt.id, username, module: attempt.module, activity: attempt.activity,
        score: attempt.score, max_score: attempt.maxScore, duration_ms: attempt.durationMs ?? null,
        metadata, evidence_quality: 'client_reported', created_at: instant,
      });
      state.progress_summary[username] ||= {};
      const summary = state.progress_summary[username][attempt.module] ||= {
        module: attempt.module, attempt_count: 0, best_score: 0, best_max_score: 1,
        total_duration_ms: 0, last_attempt_at: null, updated_at: null,
      };
      summary.attempt_count += 1;
      if (attempt.score / attempt.maxScore > summary.best_score / summary.best_max_score) {
        summary.best_score = attempt.score;
        summary.best_max_score = attempt.maxScore;
      }
      summary.total_duration_ms += attempt.durationMs ?? 0;
      summary.last_attempt_at = instant;
      summary.updated_at = instant;
      claim.consumed_at = instant;
      claim.attempt_type = 'module';
      claim.attempt_ref = attempt.id;
      await persist();
      return {
        id: attempt.id, created: true, evidenceQuality: 'client_reported',
        adaptiveExecution: {
          sessionId: row.id, blockId: block.id, attemptType: 'module', attemptId: attempt.id,
        },
      };
    });
  }

  async function bindAdaptiveLearningServerAttempt(username, {
    sessionId, executionClaim, attempt,
  }) {
    return serializeCoordinatedMutation(async () => {
      await load();
      const effectiveNow = adaptiveMutationEffectiveNow();
      const context = adaptiveClaimMutationContext(
        username, sessionId, executionClaim, effectiveNow,
      );
      const { instant, claim, row, block } = context;
      requireAdaptivePremiumDepthEntitlement(username, block, effectiveNow);
      if (attempt.type === 'voice_tutor_repeat') {
        const source = state.voice_tutor_repeat_attempts.find((item) => item.id === attempt.id);
        const repeat = state.voice_tutor_repeats.find((item) => item.id === source?.repeat_id);
        const recovery = state.voice_tutor_recoveries.find((item) => (
          item.id === repeat?.recovery_id && item.username === username
        ));
        const binding = adaptiveRepeatBindingPlan(username, context, source, repeat, recovery);
        if (binding.created) {
          claim.consumed_at = instant;
          claim.attempt_type = attempt.type;
          claim.attempt_ref = String(attempt.id);
          await persist();
        }
        return adaptiveRepeatBindingResult(binding, attempt.id);
      }
      if (claim.consumed_at) {
        if (claim.attempt_type !== attempt.type || String(claim.attempt_ref) !== String(attempt.id)) {
          throw new Error('ADAPTIVE_EXECUTION_CLAIM_CONSUMED');
        }
        return {
          created: false,
          evidenceQuality: ['voice_tutor_repeat', 'speaking'].includes(attempt.type)
            ? 'server_verified_unassisted' : 'server_verified_assisted',
          adaptiveExecution: {
            sessionId: row.id, blockId: block.id,
            attemptType: attempt.type,
            attemptId: attempt.type === 'voice_tutor_repeat' ? String(attempt.id) : Number(attempt.id),
          },
        };
      }
      const source = attempt.type === 'writing'
        ? state.writing_attempts.find((item) => item.username === username && Number(item.id) === Number(attempt.id))
        : state.speaking_attempts.find((item) => item.username === username && Number(item.id) === Number(attempt.id));
      const activityMatches = attempt.type === 'writing'
        ? block.activityId === String(source?.task_type || '')
        : adaptiveSpeakingActivityMatchesTask(block.activityId, source?.task_type);
      const exactTask = attempt.type === 'writing'
        ? source?.source_task_ref === block.launch?.taskId
        : adaptiveSpeakingSourceMatches(username, block, source, claim.issued_at);
      if (!source || source.status !== 'completed'
        || (attempt.type === 'speaking' && (source.review?.status !== 'scored'
          || typeof source.review?.got !== 'number' || typeof source.review?.max !== 'number'))
        || Number(source.created_at) < Number(claim.issued_at)
        || block.module !== attempt.type || !activityMatches || !exactTask) {
        throw new Error('ADAPTIVE_EXECUTION_ATTEMPT_MISMATCH');
      }
      claim.consumed_at = instant;
      claim.attempt_type = attempt.type;
      claim.attempt_ref = String(attempt.id);
      await persist();
      return {
        created: true, evidenceQuality: attempt.type === 'speaking'
          ? 'server_verified_unassisted' : 'server_verified_assisted',
        adaptiveExecution: {
          sessionId: row.id, blockId: block.id,
          attemptType: attempt.type, attemptId: Number(attempt.id),
        },
      };
    });
  }

  async function getModuleAttempt(username, attemptId) {
    await load();
    const attempt = state.module_attempts.find((item) => item.username === username && item.id === attemptId);
    return attempt ? structuredClone(attempt) : null;
  }

  async function getReadingCompletedAttempts(username, { limit = 120 } = {}) {
    await load();
    const boundedLimit = Math.min(120, Math.max(1, Number.isInteger(limit) ? limit : 120));
    return state.module_attempts
      .filter((attempt) => attempt.username === username && attempt.module === 'reading')
      .sort((left, right) => new Date(right.created_at).getTime() - new Date(left.created_at).getTime()
        || String(right.id).localeCompare(String(left.id)))
      .slice(0, boundedLimit)
      .map((attempt) => structuredClone(attempt));
  }

  async function upsertWordProgress(username, words) {
    await load();
    state.word_progress[username] ||= {};
    const now = Date.now();
    for (const item of words) {
      const normalized = wordProgressApiDto(item);
      const candidate = wordProgressPersistenceCandidate(
        state.word_progress[username][normalized.word],
        item,
      );
      const stored = wordProgressStorageDto(candidate, now);
      state.word_progress[username][stored.word] = stored;
    }
    await persist();
    return { updated: words.length };
  }

  async function getWordProgress(username) {
    await load();
    return Object.values(state.word_progress[username] || {})
      .map(wordProgressApiDto)
      .sort((left, right) => left.word.localeCompare(right.word, 'en'));
  }

  async function upsertErrorBank(username, errors) {
    await load();
    const now = Date.now();
    for (const item of errors) {
      const existing = state.error_bank.find((entry) => entry.username === username && entry.module === item.module && entry.item_key === item.itemKey && entry.error_type === item.errorType);
      if (existing) {
        existing.details = structuredClone(item.details || {});
        existing.occurrence_count += 1;
        existing.last_seen_at = now;
        existing.resolved_at = null;
      } else {
        state.error_bank.push({ id: (state.error_bank.at(-1)?.id || 0) + 1, username, module: item.module, item_key: item.itemKey, error_type: item.errorType, details: structuredClone(item.details || {}), occurrence_count: 1, first_seen_at: now, last_seen_at: now, resolved_at: null });
      }
    }
    await persist();
    return { updated: errors.length };
  }

  async function logAiRequest(entry) {
    await load();
    const id = (state.ai_requests.at(-1)?.id || 0) + 1;
    state.ai_requests.push({ id, ...structuredClone(entry), created_at: Date.now() });
    if (state.ai_requests.length > 5000) state.ai_requests = state.ai_requests.slice(-5000);
    await persist();
    return id;
  }

  async function claimAiOperationSlot(username, {
    claimId, operation, promptVersion, contextFingerprint = null,
    requestsPerHour, dailyLimit, now = new Date(),
  }) {
    return serializeVoiceTutorMutation(async () => {
      await load();
      if (!state.users[username]) throw new Error('USER_NOT_FOUND');
      if (contextFingerprint != null && !/^sha256:[a-f0-9]{64}$/u.test(contextFingerprint)) {
        throw new VoiceTutorError('AI_OPERATION_CLAIM_INVALID');
      }
      const existing = state.ai_requests.find((entry) => entry.claim_key === claimId);
      if (existing) {
        if (existing.username !== username || existing.operation !== operation
          || (existing.contextFingerprint ?? null) !== contextFingerprint) {
          throw new VoiceTutorError('AI_OPERATION_CLAIM_CONFLICT');
        }
        return { applied: false, claim_id: claimId, id: existing.id, status: existing.status };
      }
      const instant = new Date(now);
      const startOfDay = Date.UTC(instant.getUTCFullYear(), instant.getUTCMonth(), instant.getUTCDate());
      const startOfHour = instant.getTime() - 3_600_000;
      if (!Number.isInteger(dailyLimit) || dailyLimit < 1
        || state.ai_requests.filter((entry) => Number(entry.created_at) >= startOfDay).length >= dailyLimit) {
        throw new VoiceTutorError('AI_BUDGET_EXHAUSTED');
      }
      if (!Number.isInteger(requestsPerHour) || requestsPerHour < 1
        || state.ai_requests.filter((entry) => entry.username === username && entry.operation === operation
          && Number(entry.created_at) >= startOfHour).length >= requestsPerHour) {
        throw new VoiceTutorError('RATE_LIMITED');
      }
      const id = (state.ai_requests.at(-1)?.id || 0) + 1;
      state.ai_requests.push({
        id, username, operation, provider: null, model: null, promptVersion: promptVersion || null,
        contextFingerprint,
        status: 'in_progress', durationMs: null, errorCode: null, promptTokens: null,
        completionTokens: null, claim_key: claimId, created_at: instant.getTime(), settled_at: null,
      });
      await persist();
      return { applied: true, claim_id: claimId, id, status: 'in_progress' };
    });
  }

  async function settleAiOperationSlot(username, claimId, {
    status, provider = null, model = null, durationMs = null, errorCode = null,
    promptTokens = null, completionTokens = null, now = new Date(),
  }) {
    return serializeVoiceTutorMutation(async () => {
      await load();
      if (!['completed', 'failed'].includes(status)) throw new VoiceTutorError('AI_OPERATION_SETTLEMENT_INVALID');
      const entry = state.ai_requests.find((item) => item.claim_key === claimId && item.username === username);
      if (!entry) throw new VoiceTutorError('AI_OPERATION_CLAIM_NOT_FOUND');
      if (entry.status !== 'in_progress') return { applied: false, status: entry.status };
      entry.status = status;
      entry.provider = provider;
      entry.model = model;
      entry.durationMs = Number.isFinite(durationMs) ? Math.max(0, Math.round(durationMs)) : null;
      entry.errorCode = errorCode;
      entry.promptTokens = Number.isFinite(promptTokens) ? Math.max(0, Math.round(promptTokens)) : null;
      entry.completionTokens = Number.isFinite(completionTokens) ? Math.max(0, Math.round(completionTokens)) : null;
      entry.settled_at = new Date(now).getTime();
      await persist();
      return { applied: true, status: entry.status };
    });
  }

  async function countAiRequestsSince(since) {
    await load();
    const timestamp = since instanceof Date ? since.getTime() : Number(since);
    return state.ai_requests.filter((item) => Number(item.created_at) >= timestamp).length;
  }

  async function countAiOperationRequestsSince(username, operation, since) {
    await load();
    const timestamp = since instanceof Date ? since.getTime() : Number(since);
    return state.ai_requests.filter((item) => item.username === username && item.operation === operation && Number(item.created_at) >= timestamp).length;
  }

  async function getAiUsageMetrics(hours = 24) {
    await load();
    const safeHours = Math.max(1, Math.min(Number(hours) || 24, 168));
    const since = Date.now() - safeHours * 3_600_000;
    const entries = state.ai_requests.filter((item) => Number(item.created_at) >= since);
    return {
      windowHours: safeHours,
      requests: entries.length,
      promptTokens: entries.reduce((sum, item) => sum + (Number(item.promptTokens) || 0), 0),
      completionTokens: entries.reduce((sum, item) => sum + (Number(item.completionTokens) || 0), 0),
      estimatedCostMicrousd: entries.reduce((sum, item) => sum + (Number(item.estimatedCostMicrousd) || 0), 0),
    };
  }

  function removeExpiredSessions(now = Date.now()) {
    for (const [id, session] of Object.entries(state.sessions)) {
      if (Number(session.expires_at) <= now) delete state.sessions[id];
    }
  }

  async function createSession(id, username, expiresAt) {
    await load();
    if (!state.users[username]) throw new Error('USER_NOT_FOUND');
    removeExpiredSessions();
    state.sessions[id] = { username, expires_at: Number(expiresAt), created_at: Date.now(), last_seen_at: Date.now(), revoked_at: null };
    await persist();
  }

  async function isSessionActive(id, username) {
    await load();
    const session = state.sessions[id];
    if (!session || session.username !== username || session.revoked_at || Number(session.expires_at) <= Date.now()) return false;
    return true;
  }

  async function revokeSession(id, username) {
    await load();
    const session = state.sessions[id];
    if (!session || session.username !== username || session.revoked_at) return false;
    session.revoked_at = Date.now();
    await persist();
    return true;
  }

  async function exportUserData(username) {
    return serializeCoordinatedMutation(async () => {
      await load();
      const user = state.users[username];
      if (!user) return null;
      const instant = new Date();
      const changed = state.ege_mock_attempts
        .filter((item) => item.username === username)
        .reduce((anyChanged, item) => (
          reconcileEgeMockAttemptWithDerivedProjections(username, item, instant) || anyChanged
        ), false);
      if (changed) await persist();
      const adaptiveExport = adaptiveLearningProfileExportDto(
        state.adaptive_learning_profiles[username] || null,
        state.adaptive_learning_skill_estimates[username] || [],
      );
      const identity = state.learner_identities.find((entry) => entry.username === username) || null;
      return structuredClone({
      exported_at: new Date().toISOString(),
      account: {
        username,
        telegram_id: user.telegram_id ?? null,
        identity_provider: identity?.provider ?? null,
        identity_subject: identity?.subject ?? null,
        display_name: user.display_name ?? null,
        role: user.role || 'student',
        trial_used: Boolean(user.trial_used),
        subscription_until: user.sub_until ?? null,
        created_at: user.created ?? null,
      },
      progress: state.progress[username] || {},
      privacy_consent: await getPrivacyConsent(username),
      subscription_events: state.subscription_events.filter((item) => item.username === username),
      subscription_entitlements: Object.entries(state.subscription_entitlements[username] || {}).map(([entitlement, period]) => ({ entitlement, ...period })),
      voice_tutor_sessions: state.voice_tutor_sessions
        .filter((item) => item.username === username)
        .map(({
          username: owner, idempotency_key, nonce_hash, proxy_ticket_hash,
          proxy_ticket_issued_at, proxy_ticket_expires_at, proxy_ticket_consumed_at,
          proxy_ticket_reissue_count,
          ...item
        }) => item),
      voice_tutor_recoveries: state.voice_tutor_recoveries
        .filter((item) => item.username === username)
        .map(({ username: owner, ...item }) => item),
      voice_tutor_repeats: state.voice_tutor_repeats.filter((item) => (
        state.voice_tutor_recoveries.some((recovery) => recovery.username === username && recovery.id === item.recovery_id)
      )),
      voice_tutor_repeat_attempts: state.voice_tutor_repeat_attempts
        .filter((item) => state.voice_tutor_repeats.some((repeat) => repeat.id === item.repeat_id
          && state.voice_tutor_recoveries.some((recovery) => recovery.username === username && recovery.id === repeat.recovery_id)))
        .map(({ fingerprint, ...item }) => item),
      voice_tutor_reports: state.voice_tutor_reports.filter((item) => item.username === username)
        .map(({ username: owner, ...item }) => item),
      rule_cards: state.rule_cards.filter((item) => item.created_for_username === username),
      payment_requests: Object.values(state.payment_requests).filter((item) => item.username === username),
      writing_attempts: state.writing_attempts.filter((item) => item.username === username),
      speaking_attempts: state.speaking_attempts
        .filter((item) => item.username === username)
        .map(({
          evaluation_fingerprint, evaluation_claimed_at, evaluation_claim_generation, ...item
        }) => item),
      speaking_task1_sessions: state.speaking_task1_sessions
        .filter((item) => item.username === username)
        .map(({ username: owner, ...item }) => item),
      speaking_task2_sessions: state.speaking_task2_sessions
        .filter((item) => item.username === username)
        .map(({ username: owner, ...item }) => item),
      speaking_task3_sessions: state.speaking_task3_sessions
        .filter((item) => item.username === username)
        .map(({ username: owner, ...item }) => item),
      speaking_task4_sessions: state.speaking_task4_sessions
        .filter((item) => item.username === username)
        .map(({ username: owner, ...item }) => item),
      speaking_full_sessions: state.speaking_full_sessions
        .filter((item) => item.username === username)
        .map(({ username: owner, submission_key, ...item }) => item),
      speaking_assessments: state.speaking_assessments
        .filter((item) => item.username === username)
        .map(speakingAssessmentExportDto),
      speaking_accent_profile: await getSpeakingAccentProfile(username),
      speaking_accent_history: await getSpeakingAccentHistory(username),
      speaking_accent_calibration: publicSpeakingAccentCalibration(
        state.speaking_accent_calibrations.find((item) => item.username === username) || null,
      ),
      speaking_calibration_consent: await getSpeakingCalibrationConsent(username),
      speaking_calibration_samples: state.speaking_calibration_samples
        .filter((item) => item.username === username)
        .map(publicSpeakingCalibrationSample),
      generated_tasks: state.generated_tasks.filter((item) => item.username === username).map(({ request_hash, username: owner, ...item }) => item),
      module_attempts: state.module_attempts.filter((item) => item.username === username),
      progress_summary: Object.values(state.progress_summary[username] || {}),
      word_progress: Object.values(state.word_progress[username] || {})
        .map(wordProgressExportDto)
        .sort((left, right) => left.word.localeCompare(right.word, 'en')),
      error_bank: state.error_bank.filter((item) => item.username === username),
      ai_requests: state.ai_requests.filter((item) => item.username === username)
        .map(aiRequestExportDto),
      audit_log: state.audit_log.filter((item) => item.metadata?.username === username),
      adaptive_learning_goals: state.adaptive_learning_goals
        .filter((item) => item.username === username)
        .map(adaptiveLearningGoalRepositoryDto),
      adaptive_learning_profile: adaptiveExport.profile,
      adaptive_learning_skill_estimates: adaptiveExport.estimates,
      adaptive_learning_plan_revisions: state.adaptive_learning_plan_revisions
        .filter((item) => item.username === username)
        .sort((left, right) => Number(left.revision) - Number(right.revision))
        .map(adaptiveLearningPlanRepositoryDto),
      adaptive_learning_sessions: state.adaptive_learning_sessions
        .filter((item) => item.username === username)
        .sort((left, right) => new Date(left.created_at) - new Date(right.created_at))
        .map(adaptiveLearningSessionRepositoryDto),
      adaptive_learning_reports: state.adaptive_learning_sessions
        .filter((item) => item.username === username && item.status === 'completed' && item.completion_summary)
        .sort((left, right) => new Date(left.completed_at) - new Date(right.completed_at))
        .map((item) => ({
          session_id: item.id,
          completed_at: new Date(item.completed_at).toISOString(),
          summary: structuredClone(item.completion_summary),
        })),
      adaptive_learning_session_events: state.adaptive_learning_session_events
        .filter((item) => item.username === username)
        .sort((left, right) => Number(left.sequence) - Number(right.sequence))
        .map(adaptiveExecutionEventExportDto),
      adaptive_diagnostic_sessions: state.adaptive_diagnostic_sessions
        .filter((item) => item.username === username)
        .map(adaptiveDiagnosticExportDto),
      adaptive_diagnostic_responses: state.adaptive_diagnostic_responses
        .filter((item) => state.adaptive_diagnostic_sessions.some((session) => (
          session.username === username && session.id === item.diagnostic_id
        )))
        .map(adaptiveDiagnosticResponseExportDto),
      ege_mock_attempts: state.ege_mock_attempts
        .filter((item) => item.username === username)
        .sort((left, right) => String(left.created_at).localeCompare(String(right.created_at)))
        .map(egeMockAttemptExportDto),
      });
    });
  }

  async function deleteUserData(username) {
    return serializeVoiceTutorMutation(() => withRuleCardLock(async () => {
      await load();
      const user = state.users[username];
      if (!user) return false;
      const telegramId = user.telegram_id == null ? null : String(user.telegram_id);
      for (const entry of state.audit_log) {
        if (entry.metadata?.username === username) {
          delete entry.metadata.username;
          entry.metadata.account_deleted = true;
        }
        if (entry.metadata?.reviewer === username) {
          delete entry.metadata.reviewer;
          entry.metadata.reviewer_account_deleted = true;
        }
      }
      for (const sample of state.speaking_calibration_samples) {
        sample.reviews = sample.reviews.map((review) => (review.reviewer === username
          ? { ...review, reviewer: null, reviewer_account_deleted: true }
          : review));
        sample.access_audit = sample.access_audit.map((entry) => (entry.reviewer === username
          ? { ...entry, reviewer: null, reviewer_account_deleted: true }
          : entry));
      }
      state.learner_identities = state.learner_identities.filter((entry) => entry.username !== username);
      delete state.users[username];
      delete state.progress[username];
      state.writing_attempts = state.writing_attempts.filter((item) => item.username !== username);
      state.speaking_attempts = state.speaking_attempts.filter((item) => item.username !== username);
      state.speaking_task1_sessions = state.speaking_task1_sessions.filter((item) => item.username !== username);
      state.speaking_task2_sessions = state.speaking_task2_sessions.filter((item) => item.username !== username);
      state.speaking_task3_sessions = state.speaking_task3_sessions.filter((item) => item.username !== username);
      state.speaking_task4_sessions = state.speaking_task4_sessions.filter((item) => item.username !== username);
      state.speaking_full_sessions = state.speaking_full_sessions.filter((item) => item.username !== username);
      state.speaking_assessments = state.speaking_assessments.filter((item) => item.username !== username);
      delete state.speaking_accent_profiles[username];
      state.speaking_accent_history = state.speaking_accent_history.filter((item) => item.username !== username);
      state.speaking_accent_calibrations = state.speaking_accent_calibrations.filter((item) => item.username !== username);
      delete state.speaking_calibration_consents[username];
      state.speaking_calibration_samples = state.speaking_calibration_samples.flatMap((sample) => {
        if (sample.username !== username) return [sample];
        if (sample.status !== 'completed') return [];
        return [{
          ...sample,
          username: null,
          assessment_key: null,
          reviews: sample.reviews.map((review) => ({ ...review, reviewer: null })),
          access_audit: [],
        }];
      });
      state.generated_tasks = state.generated_tasks.filter((item) => item.username !== username);
      state.module_attempts = state.module_attempts.filter((item) => item.username !== username);
      delete state.progress_summary[username];
      delete state.word_progress[username];
      state.error_bank = state.error_bank.filter((item) => item.username !== username);
      state.ai_requests = state.ai_requests.filter((item) => item.username !== username);
      delete state.subscriptions[username];
      delete state.subscription_entitlements[username];
      state.adaptive_learning_goals = state.adaptive_learning_goals.filter((item) => item.username !== username);
      delete state.adaptive_learning_profiles[username];
      delete state.adaptive_learning_skill_estimates[username];
      state.adaptive_learning_plan_revisions = state.adaptive_learning_plan_revisions
        .filter((item) => item.username !== username);
      state.adaptive_learning_sessions = state.adaptive_learning_sessions
        .filter((item) => item.username !== username);
      state.adaptive_learning_execution_claims = state.adaptive_learning_execution_claims
        .filter((item) => item.username !== username);
      state.adaptive_learning_session_events = state.adaptive_learning_session_events
        .filter((item) => item.username !== username);
      state.adaptive_learning_session_mutations = state.adaptive_learning_session_mutations
        .filter((item) => item.username !== username);
      const diagnosticIds = new Set(state.adaptive_diagnostic_sessions
        .filter((item) => item.username === username).map((item) => item.id));
      state.adaptive_diagnostic_responses = state.adaptive_diagnostic_responses
        .filter((item) => !diagnosticIds.has(item.diagnostic_id));
      state.adaptive_diagnostic_start_claims = state.adaptive_diagnostic_start_claims
        .filter((item) => item.username !== username);
      state.adaptive_diagnostic_sessions = state.adaptive_diagnostic_sessions
        .filter((item) => item.username !== username);
      state.ege_mock_attempts = state.ege_mock_attempts.filter((item) => item.username !== username);
      state.ege_mock_mutations = state.ege_mock_mutations.filter((item) => item.username !== username);
      state.voice_tutor_sessions = state.voice_tutor_sessions.filter((item) => item.username !== username);
      const recoveryIds = new Set(state.voice_tutor_recoveries.filter((item) => item.username === username).map((item) => item.id));
      const repeatIds = new Set(state.voice_tutor_repeats.filter((item) => recoveryIds.has(item.recovery_id)).map((item) => item.id));
      state.voice_tutor_repeat_attempts = state.voice_tutor_repeat_attempts.filter((item) => !repeatIds.has(item.repeat_id));
      state.voice_tutor_repeats = state.voice_tutor_repeats.filter((item) => !recoveryIds.has(item.recovery_id));
      state.voice_tutor_recoveries = state.voice_tutor_recoveries.filter((item) => item.username !== username);
      state.voice_tutor_reports = state.voice_tutor_reports.filter((item) => item.username !== username);
      for (const report of state.voice_tutor_reports) {
        for (const audit of report.review_audit || []) {
          if (audit.reviewer === username) {
            audit.reviewer = null;
            audit.account_deleted = true;
          }
        }
      }
      state.rule_cards = state.rule_cards.filter((card) => card.created_for_username !== username || card.status === 'approved');
      for (const card of state.rule_cards) {
        if (card.created_for_username === username) card.created_for_username = null;
        for (const audit of card.review_audit || []) {
          if (audit.reviewer === username) {
            audit.reviewer = null;
            audit.account_deleted = true;
          }
        }
      }
      state.subscription_events = state.subscription_events.filter((item) => item.username !== username);
      for (const [id, request] of Object.entries(state.payment_requests)) if (request.username === username) delete state.payment_requests[id];
      for (const [id, session] of Object.entries(state.sessions)) {
        if (session.username === username) delete state.sessions[id];
      }
      if (telegramId) {
        for (const [codeHash, entry] of Object.entries(state.auth_codes)) {
          if (String(entry.telegram_id) === telegramId) delete state.auth_codes[codeHash];
        }
      }
      await persist();
      return true;
    }));
  }

  async function healthCheck() {
    await load();
    await writeQueue;
    return true;
  }

  return {
    getUser,
    createUser,
    findOrCreateProviderUser,
    createOAuthTransaction,
    consumeOAuthTransaction,
    purgeOAuthTransactions,
    getProgress,
    saveProgress,
    mergeProgress,
    migrateGrammarMastery,
    applyGrammarMasteryEvent,
    applyGrammarMasteryEvents,
    getUserByTelegram,
    createTelegramUser,
    ensureTelegramUser,
    grantDays,
    createPaymentRequest,
    createPaymentRequestForUser,
    getPaymentRequestForUser,
    listPaymentRequests,
    resolvePaymentRequest,
    revokeEntitlement,
    markTrialUsed,
    activateTrial,
    getSub,
    setEntitlement,
    getSpeakingAssessmentQuota,
    getSpeakingAssessmentReservation,
    reserveSpeakingAssessment,
    dispatchSpeakingAssessment,
    startSpeakingAssessment,
    finalizeSpeakingAssessment,
    releaseSpeakingAssessment,
    getVoiceTutorAccess,
    reserveVoiceTutorSession,
    issueVoiceTutorProxyTicket,
    reissueVoiceTutorFallbackNonce,
    consumeVoiceTutorProxyTicket,
    activateVoiceTutorProxySession,
    finalizeVoiceTutorProxySession,
    finishVoiceTutorSession,
    getVoiceTutorSession,
    activateVoiceTutorSession,
    advanceVoiceTutorSession,
    clarifyVoiceTutorSession,
    setVoiceTutorSessionDelivery,
    switchVoiceTutorSessionDelivery,
    submitVoiceTutorRepeat,
    getVoiceTutorRecoveryMap,
    getVoiceTutorRecoveryMetrics,
    createRuleCard,
    claimVoiceTutorRuleDiscovery,
    failVoiceTutorRuleDiscovery,
    createRuleCardForVoiceTutorSession,
    getRuleCard,
    listRuleCards,
    reviewRuleCard,
    getApprovedRuleCard,
    createVoiceTutorReport,
    listVoiceTutorReports,
    reviewVoiceTutorReport,
    setUserRole,
    getPrivacyConsent,
    setPrivacyConsent,
    getSpeakingAccentProfile,
    getSpeakingAccentHistory,
    setSpeakingAccentProfile,
    startSpeakingAccentCalibration,
    getSpeakingAccentCalibration,
    getPendingSpeakingAccentCalibration,
    completeSpeakingAccentCalibration,
    getSpeakingCalibrationConsent,
    setSpeakingCalibrationConsent,
    createSpeakingCalibrationSample,
    purgeExpiredSpeakingCalibrationSamples,
    claimSpeakingCalibrationSample,
    getSpeakingCalibrationAudio,
    submitSpeakingCalibrationReview,
    listSpeakingCalibrationSamplesForOwner,
    listAnonymousSpeakingCalibrationLabels,
    createTelegramAuthCode,
    confirmTelegramAuthCode,
    consumeTelegramAuthCode,
    createWritingAttempt,
    finishWritingAttempt,
    getWritingAttempt,
    createSpeakingAttempt,
    claimSpeakingEvaluation,
    getSpeakingEvaluationClaim,
    finishSpeakingAttempt,
    getSpeakingAttempt,
    getSpeakingLearningAttempts,
    getSpeakingLearningReportSnapshot,
    markSpeakingSessionAssisted,
    assignSpeakingTask1Session,
    getSpeakingTask1Session,
    completeSpeakingTask1Session,
    assignSpeakingTask2Session,
    getSpeakingTask2Session,
    completeSpeakingTask2Question,
    assignSpeakingTask3Session,
    getSpeakingTask3Session,
    completeSpeakingTask3Answer,
    assignSpeakingTask4Session,
    getSpeakingTask4Session,
    completeSpeakingTask4Session,
    assignFullSpeakingSession,
    getFullSpeakingSession,
    advanceFullSpeakingSessionStage,
    completeFullSpeakingSessionResponse,
    claimFullSpeakingSessionAssessment,
    submitFullSpeakingSessionResult,
    completeFullSpeakingSessionEvaluation,
    getGeneratedTask,
    deleteGeneratedTask,
    getSharedGeneratedTask,
    saveGeneratedTask,
    upsertBankTask,
    getBankTask,
    getBankTaskByExternalId,
    claimUnseenBankTask,
    recordTaskDelivery,
    listBankTaskContents,
    saveAdaptiveLearningGoal,
    getAdaptiveLearningGoal,
    getAdaptiveLearningEvidenceSources,
    saveAdaptiveLearningProfile,
    getAdaptiveLearningProfile,
    saveAdaptiveLearningPlan,
    getCurrentAdaptiveLearningPlan,
    getAdaptiveLearningPlanRevision,
    getAdaptiveLearningSessionCreateReplay,
    createAdaptiveLearningSession,
    getCurrentAdaptiveLearningSession,
    getAdaptiveLearningSessionCommercialScope,
    getAdaptiveLearningSessionReplacementReplay,
    replaceAdaptiveLearningSessionBlock,
    getAdaptiveLearningSessionMutationReplay,
    startAdaptiveLearningSessionBlock,
    getAdaptiveLearningSessionExecution,
    getAdaptiveLearningSessionAdvanceContext,
    advanceAdaptiveLearningSession,
    getAdaptiveLearningSessionFinishContext,
    finishAdaptiveLearningSession,
    getAdaptiveLearningWeekUsage,
    getAdaptiveLearningCommercialUsage,
    getAdaptiveLearningCompletedSessionReports,
    getAdaptiveLearningMetrics,
    startAdaptiveDiagnostic,
    getAdaptiveDiagnosticStartClaim,
    getCurrentAdaptiveDiagnostic,
    getAdaptiveDiagnostic,
    getAdaptiveDiagnosticCompletionReplay,
    answerAdaptiveDiagnostic,
    completeAdaptiveDiagnostic,
    startEgeMockAttempt,
    getCurrentEgeMockAttempt,
    getEgeMockAttempt,
    saveEgeMockDraft,
    submitEgeMockWritten,
    startEgeMockOral,
    advanceEgeMockOralStage,
    submitEgeMockOral,
    syncEgeMockSpeakingBridge,
    getEgeMockResult,
    getEgeMockHistory,
    beginEgeMockAssessmentRun,
    settleEgeMockAssessmentRun,
    markEgeMockAssessmentRetryable,
    retryEgeMockAssessment,
    claimEgeMockWritingAssessment,
    renewEgeMockWritingAssessmentClaim,
    prepareEgeMockWritingAssessmentItemOutcome,
    recordEgeMockWritingAssessmentItemOutcome,
    completeEgeMockWritingAssessmentItem,
    failEgeMockWritingAssessment,
    recordModuleAttempt,
    recordModuleAttemptWithAdaptiveClaim,
    bindAdaptiveLearningServerAttempt,
    getModuleAttempt,
    getReadingCompletedAttempts,
    upsertWordProgress,
    getWordProgress,
    upsertErrorBank,
    logAiRequest,
    claimAiOperationSlot,
    settleAiOperationSlot,
    countAiRequestsSince,
    countAiOperationRequestsSince,
    getAiUsageMetrics,
    createSession,
    isSessionActive,
    revokeSession,
    exportUserData,
    deleteUserData,
    healthCheck,
    async close() { await writeQueue; },
  };
}
