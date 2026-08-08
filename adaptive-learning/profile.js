import { normalizeModuleAttemptEvidenceQuality } from './evidence-quality.js';
import { requiresServerAssessment } from './evidence-policy.js';
import {
  ADAPTIVE_PROFILE_CALCULATION_REVISION,
  adaptiveProfileMatchesEvidenceSources,
  buildAdaptiveEvidenceWatermark,
  canonicalAdaptiveEvidenceTimestamp,
} from './evidence-watermark.js';
import { resolveVoiceTutorAdaptiveSkill, VOICE_TUTOR_SKILL_COMPATIBILITY } from './skill-compatibility.js';
import {
  DIAGNOSTIC_REGISTRY,
  getDiagnosticCatalog,
  getDiagnosticItem,
} from './diagnostic-catalog.js';
import {
  GRAMMAR_FORMS_ACTIVITY_IDS,
  GRAMMAR_TRANSFORMATIONS_ACTIVITY_IDS,
  LISTENING_DETAIL_ACTIVITY_IDS,
  LISTENING_GIST_ACTIVITY_IDS,
  READING_DETAIL_ACTIVITY_IDS,
  READING_GIST_ACTIVITY_IDS,
} from '../public/learning-activity-contract.js';

const TAXONOMY_VERSION = 'ege-en-v2';
const WEIGHTING_VERSION = 'adaptive-evidence-v2';

export const ADAPTIVE_EVIDENCE_WEIGHTS = Object.freeze({
  moduleAttempt: 0.7,
  clientReportedAttempt: 0.1,
  assistedRecovery: 0,
  retentionCheck: 0.9,
  diagnosticAnswer: 1,
});

const MIN_INDEPENDENT_EVIDENCE = 12;
const MIN_INDEPENDENT_MODULES = 3;
const MIN_INDEPENDENT_EVIDENCE_PER_SKILL = 2;
const MAX_CLIENT_REPORTED_OBSERVATIONS_PER_SKILL = 3;
const MAX_ASSISTED_OBSERVATIONS_PER_SKILL = 3;
const SKILLS = [
  { id: 'ege.vocabulary.lexical_choice', label: 'Лексический выбор', module: 'vocabulary', egeWeight: 0.8, recommendedBlockMinutes: 10, activityIds: ['lexical_choice', 'vocabulary_choice', 'vocabulary', 'vocabulary_lexical_choice_topic_1', 'vocabulary_lexical_choice_topic_6'] },
  { id: 'ege.vocabulary.word_formation', label: 'Словообразование', module: 'vocabulary', egeWeight: 0.8, recommendedBlockMinutes: 10, activityIds: ['word_formation', 'vocabulary_word_formation'] },
  { id: 'ege.grammar.forms', label: 'Грамматические формы', module: 'grammar', egeWeight: 1, recommendedBlockMinutes: 15, activityIds: GRAMMAR_FORMS_ACTIVITY_IDS },
  { id: 'ege.grammar.transformations', label: 'Грамматические преобразования', module: 'grammar', egeWeight: 0.9, recommendedBlockMinutes: 15, activityIds: GRAMMAR_TRANSFORMATIONS_ACTIVITY_IDS },
  { id: 'ege.reading.gist', label: 'Основная мысль текста', module: 'reading', egeWeight: 0.8, recommendedBlockMinutes: 15, activityIds: READING_GIST_ACTIVITY_IDS },
  { id: 'ege.reading.detail', label: 'Детальное понимание текста', module: 'reading', egeWeight: 1, recommendedBlockMinutes: 20, activityIds: READING_DETAIL_ACTIVITY_IDS },
  { id: 'ege.listening.gist', label: 'Основная мысль аудио', module: 'listening', egeWeight: 0.8, recommendedBlockMinutes: 15, activityIds: LISTENING_GIST_ACTIVITY_IDS },
  { id: 'ege.listening.detail', label: 'Детальное понимание аудио', module: 'listening', egeWeight: 1, recommendedBlockMinutes: 20, activityIds: LISTENING_DETAIL_ACTIVITY_IDS },
  { id: 'ege.writing.email', label: 'Электронное письмо', module: 'writing', egeWeight: 0.8, recommendedBlockMinutes: 25, premiumDeepAssessment: true, activityIds: ['writing_37', 'email'] },
  { id: 'ege.writing.essay', label: 'Развёрнутое письменное высказывание', module: 'writing', egeWeight: 1, recommendedBlockMinutes: 30, premiumDeepAssessment: true, activityIds: ['writing_38', 'essay'] },
  { id: 'ege.speaking.reading_aloud', label: 'Чтение вслух', module: 'speaking', egeWeight: 0.8, recommendedBlockMinutes: 15, premiumDeepAssessment: true, activityIds: ['speaking_1', 'speaking_reading_aloud'] },
  { id: 'ege.speaking.direct_questions', label: 'Прямые вопросы', module: 'speaking', egeWeight: 0.9, recommendedBlockMinutes: 15, premiumDeepAssessment: true, activityIds: ['speaking_2', 'speaking_direct_questions', 'speaking_interaction'] },
  { id: 'ege.speaking.interview_completeness', label: 'Полнота интервью', module: 'speaking', egeWeight: 0.9, recommendedBlockMinutes: 20, premiumDeepAssessment: true, activityIds: ['speaking_3', 'speaking_interview'] },
  { id: 'ege.speaking.monologue_content', label: 'Содержание монолога', module: 'speaking', egeWeight: 1, recommendedBlockMinutes: 20, premiumDeepAssessment: true, activityIds: ['speaking_4', 'speaking_monologue', 'speaking'] },
  { id: 'ege.speaking.monologue_organization', label: 'Организация монолога', module: 'speaking', egeWeight: 0.9, recommendedBlockMinutes: 20, premiumDeepAssessment: true, activityIds: ['speaking_4_organization'] },
  { id: 'ege.speaking.spoken_grammar', label: 'Грамматика устной речи', module: 'speaking', egeWeight: 0.9, recommendedBlockMinutes: 20, premiumDeepAssessment: true, activityIds: ['speaking_4_grammar'] },
  { id: 'ege.speaking.spoken_lexis', label: 'Лексика устной речи', module: 'speaking', egeWeight: 0.9, recommendedBlockMinutes: 20, premiumDeepAssessment: true, activityIds: ['speaking_4_lexis'] },
  { id: 'ege.speaking.fluency', label: 'Беглость речи', module: 'speaking', egeWeight: 0.8, recommendedBlockMinutes: 15, premiumDeepAssessment: true, activityIds: ['speaking_1_fluency'] },
  { id: 'ege.speaking.pronunciation_words', label: 'Произношение слов', module: 'speaking', egeWeight: 0.8, recommendedBlockMinutes: 15, premiumDeepAssessment: true, activityIds: ['speaking_1_words'] },
  { id: 'ege.speaking.pronunciation_phonemes', label: 'Произношение фонем', module: 'speaking', egeWeight: 0.8, recommendedBlockMinutes: 15, premiumDeepAssessment: true, activityIds: ['speaking_1_phonemes'] },
  { id: 'ege.speaking.signal_quality', label: 'Качество записи', module: 'speaking', egeWeight: 0.4, recommendedBlockMinutes: 10, premiumDeepAssessment: true, activityIds: ['speaking_1_signal'] },
];

const SKILL_BY_ID = new Map(SKILLS.map((skill) => [skill.id, skill]));
const SKILL_BY_ACTIVITY = new Map(SKILLS.flatMap((skill) => (
  [skill.id, ...skill.activityIds].map((activity) => [activity, skill])
)));
const DEFAULT_SKILL_BY_MODULE = new Map([
  ['vocabulary', SKILL_BY_ID.get('ege.vocabulary.lexical_choice')],
  ['grammar', SKILL_BY_ID.get('ege.grammar.forms')],
  ['reading', SKILL_BY_ID.get('ege.reading.detail')],
  ['listening', SKILL_BY_ID.get('ege.listening.detail')],
  ['writing', SKILL_BY_ID.get('ege.writing.email')],
  ['speaking', SKILL_BY_ID.get('ege.speaking.monologue_content')],
]);

export const EGE_SKILL_TAXONOMY = Object.freeze({
  version: TAXONOMY_VERSION,
  voiceTutorCompatibilityVersion: VOICE_TUTOR_SKILL_COMPATIBILITY.version,
  skills: Object.freeze(SKILLS.map((skill) => Object.freeze({ ...skill }))),
});

function evidenceNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function iso(value) {
  return canonicalAdaptiveEvidenceTimestamp(value);
}

function skillFor(module, activity = '', requestedId = '', { allowModuleFallback = true } = {}) {
  const exact = SKILL_BY_ID.get(requestedId);
  if (exact) return !module || module === 'exam' || exact.module === module ? exact : null;
  const requestedCompatibility = resolveVoiceTutorAdaptiveSkill(requestedId, module);
  if (requestedCompatibility.recognized) {
    return requestedCompatibility.adaptiveSkillId
      ? SKILL_BY_ID.get(requestedCompatibility.adaptiveSkillId) || null
      : null;
  }
  const normalizedActivity = String(activity || '').toLocaleLowerCase('en');
  const mapped = SKILL_BY_ACTIVITY.get(normalizedActivity);
  if (mapped && (module === 'exam' || mapped.module === module)) return mapped;
  const activityCompatibility = resolveVoiceTutorAdaptiveSkill(normalizedActivity, module);
  if (activityCompatibility.recognized) {
    return activityCompatibility.adaptiveSkillId
      ? SKILL_BY_ID.get(activityCompatibility.adaptiveSkillId) || null
      : null;
  }
  return module === 'exam' || !allowModuleFallback ? null : DEFAULT_SKILL_BY_MODULE.get(module) || null;
}

function attemptObservation(attempt) {
  if (String(attempt.activity || '').startsWith('voice_tutor_')) return null;
  const requestedSkill = attempt.metadata?.skill_id ?? attempt.metadata?.skillId ?? '';
  const skill = skillFor(attempt.module, attempt.activity, requestedSkill);
  const score = evidenceNumber(attempt.score);
  const maximum = evidenceNumber(attempt.max_score ?? attempt.maxScore);
  if (!skill || score === null || maximum === null || maximum <= 0) return null;
  const storedQuality = normalizeModuleAttemptEvidenceQuality(attempt.evidence_quality ?? attempt.evidenceQuality);
  const quality = storedQuality === 'server_verified_unassisted'
    ? 'independent'
    : storedQuality === 'server_verified_assisted'
      ? 'assisted'
      : 'client_reported';
  return {
    skillId: skill.id,
    score: Math.max(0, Math.min(100, score / maximum * 100)),
    weight: quality === 'independent'
      ? ADAPTIVE_EVIDENCE_WEIGHTS.moduleAttempt
      : quality === 'assisted'
        ? ADAPTIVE_EVIDENCE_WEIGHTS.assistedRecovery
        : ADAPTIVE_EVIDENCE_WEIGHTS.clientReportedAttempt,
    kind: 'module_attempt',
    quality,
    independent: quality === 'independent',
    independentSourceId: String(attempt.metadata?.source_attempt_id || attempt.id || '') || null,
    observedAt: iso(attempt.created_at ?? attempt.createdAt),
  };
}

function isEligibleAdaptiveAttempt(attempt) {
  if (!requiresServerAssessment(attempt?.module)) return true;
  return normalizeModuleAttemptEvidenceQuality(
    attempt.evidence_quality ?? attempt.evidenceQuality,
  ) !== 'client_reported';
}

function recoveryObservation(recovery) {
  const skill = skillFor(recovery.module, '', recovery.skill_id ?? recovery.skillId, { allowModuleFallback: false });
  const microPassed = recovery.initial_micro_check_passed ?? recovery.initialMicroCheckPassed;
  const transferPassed = recovery.initial_transfer_passed ?? recovery.initialTransferPassed;
  const outcome = recovery.terminal_outcome ?? recovery.terminalOutcome;
  if (!skill || typeof microPassed !== 'boolean' || typeof transferPassed !== 'boolean'
    || !['resolved', 'fallback'].includes(outcome)) return null;
  const fallback = outcome === 'fallback';
  return {
    skillId: skill.id,
    score: fallback ? 35 : transferPassed ? 65 : microPassed ? 50 : 35,
    weight: ADAPTIVE_EVIDENCE_WEIGHTS.assistedRecovery,
    kind: 'assisted_recovery',
    quality: 'assisted',
    independent: false,
    independentSourceId: null,
    observedAt: iso(recovery.observed_at ?? recovery.observedAt),
  };
}

function repeatObservation(attempt) {
  const skill = skillFor(attempt.module, '', attempt.skill_id ?? attempt.skillId, { allowModuleFallback: false });
  if (!skill || typeof attempt.passed !== 'boolean') return null;
  return {
    skillId: skill.id,
    score: attempt.passed ? 100 : 0,
    weight: ADAPTIVE_EVIDENCE_WEIGHTS.retentionCheck,
    kind: 'retention_check',
    quality: 'independent',
    independent: true,
    independentSourceId: String(attempt.id ? `repeat:${attempt.id}` : '') || null,
    observedAt: iso(attempt.observed_at ?? attempt.observedAt),
  };
}

function diagnosticObservation(response, diagnosticRegistry) {
  const catalogVersion = response.catalog_version ?? response.catalogVersion;
  const item = getDiagnosticItem(
    catalogVersion,
    response.item_id ?? response.itemId,
    diagnosticRegistry,
  );
  const requestedSkillId = response.skill_id ?? response.skillId;
  const skill = skillFor(response.module, '', requestedSkillId, { allowModuleFallback: false });
  if (!item || !skill || item.skillId !== requestedSkillId || item.module !== response.module
    || typeof response.correct !== 'boolean') return null;
  const storedEvidenceQuality = response.evidence_quality ?? response.evidenceQuality ?? item.evidenceQuality;
  if (storedEvidenceQuality !== item.evidenceQuality) return null;
  const assisted = item.evidenceQuality === 'assisted';
  const productiveChoiceOnly = assisted && ['writing', 'speaking'].includes(item.module);
  return {
    skillId: skill.id,
    score: response.correct ? 100 : 0,
    weight: assisted
      ? ADAPTIVE_EVIDENCE_WEIGHTS.assistedRecovery
      : ADAPTIVE_EVIDENCE_WEIGHTS.diagnosticAnswer,
    kind: productiveChoiceOnly
      ? 'diagnostic_productive_preliminary'
      : assisted ? 'diagnostic_listening_assisted' : 'diagnostic_answer',
    quality: assisted ? 'assisted' : 'independent',
    independent: !assisted,
    independentSourceId: String(response.id
      ? `diagnostic:${response.id}`
      : `${response.diagnostic_id ?? response.diagnosticId ?? ''}:${response.item_id ?? response.itemId ?? ''}`) || null,
    diagnosticFamily: `${skill.id}:${item.id}`,
    observedAt: iso(response.answered_at ?? response.answeredAt),
  };
}

function text(value) {
  return value == null ? null : String(value);
}

function canonicalAttempt(attempt) {
  const metadata = attempt?.metadata && typeof attempt.metadata === 'object' && !Array.isArray(attempt.metadata)
    ? attempt.metadata : {};
  return {
    id: text(attempt?.id),
    module: text(attempt?.module),
    activity: text(attempt?.activity),
    score: evidenceNumber(attempt?.score),
    max_score: evidenceNumber(attempt?.max_score ?? attempt?.maxScore),
    metadata: {
      skill_id: text(metadata.skill_id ?? metadata.skillId),
      source_attempt_id: text(metadata.source_attempt_id ?? metadata.sourceAttemptId),
    },
    evidence_quality: normalizeModuleAttemptEvidenceQuality(
      attempt?.evidence_quality ?? attempt?.evidenceQuality,
    ),
    created_at: iso(attempt?.created_at ?? attempt?.createdAt),
  };
}

function canonicalRecovery(recovery) {
  return {
    id: text(recovery?.id),
    skill_id: text(recovery?.skill_id ?? recovery?.skillId),
    module: text(recovery?.module),
    initial_micro_check_passed: typeof (
      recovery?.initial_micro_check_passed ?? recovery?.initialMicroCheckPassed
    ) === 'boolean' ? (recovery?.initial_micro_check_passed ?? recovery?.initialMicroCheckPassed) : null,
    initial_transfer_passed: typeof (
      recovery?.initial_transfer_passed ?? recovery?.initialTransferPassed
    ) === 'boolean' ? (recovery?.initial_transfer_passed ?? recovery?.initialTransferPassed) : null,
    terminal_outcome: text(recovery?.terminal_outcome ?? recovery?.terminalOutcome),
    observed_at: iso(recovery?.observed_at ?? recovery?.observedAt),
  };
}

function canonicalRepeatAttempt(attempt) {
  return {
    id: text(attempt?.id),
    skill_id: text(attempt?.skill_id ?? attempt?.skillId),
    module: text(attempt?.module),
    passed: typeof attempt?.passed === 'boolean' ? attempt.passed : null,
    observed_at: iso(attempt?.observed_at ?? attempt?.observedAt),
  };
}

function canonicalDiagnosticResponse(response) {
  return {
    id: text(response?.id),
    diagnostic_id: text(response?.diagnostic_id ?? response?.diagnosticId),
    catalog_version: text(response?.catalog_version ?? response?.catalogVersion),
    item_id: text(response?.item_id ?? response?.itemId),
    skill_id: text(response?.skill_id ?? response?.skillId),
    module: text(response?.module),
    evidence_quality: text(response?.evidence_quality ?? response?.evidenceQuality),
    correct: typeof response?.correct === 'boolean' ? response.correct : null,
    answered_at: iso(response?.answered_at ?? response?.answeredAt),
  };
}

export function projectAdaptiveLearningEvidenceSources({
  attempts = [], recoveries = [], repeatAttempts = [], diagnosticResponses = [],
  diagnosticCompletions = [],
} = {}, { diagnosticRegistry = DIAGNOSTIC_REGISTRY } = {}) {
  const projectedAttempts = attempts.map(canonicalAttempt)
    .filter((attempt) => isEligibleAdaptiveAttempt(attempt) && attemptObservation(attempt));
  const projectedRecoveries = recoveries.map(canonicalRecovery)
    .filter((recovery) => recoveryObservation(recovery));
  const projectedRepeats = repeatAttempts.map(canonicalRepeatAttempt)
    .filter((attempt) => repeatObservation(attempt));
  const projectedResponses = diagnosticResponses.map(canonicalDiagnosticResponse)
    .filter((response) => diagnosticObservation(response, diagnosticRegistry));
  const projectedCompletions = diagnosticCompletions
    .map((completion) => ({
      catalog_version: text(completion?.catalog_version ?? completion?.catalogVersion),
      completed_at: iso(completion?.completed_at ?? completion?.completedAt),
    }))
    .filter((completion) => completion.completed_at && getDiagnosticCatalog(
      completion.catalog_version,
      diagnosticRegistry,
    ));
  return {
    attempts: projectedAttempts,
    recoveries: projectedRecoveries,
    repeatAttempts: projectedRepeats,
    diagnosticResponses: projectedResponses,
    diagnosticCompletions: projectedCompletions,
  };
}

export function adaptiveLearningEvidenceSnapshot(sources = {}, options = {}) {
  const projectedSources = projectAdaptiveLearningEvidenceSources(sources, options);
  const watermark = buildAdaptiveEvidenceWatermark(projectedSources);
  return {
    profileCalculationRevision: ADAPTIVE_PROFILE_CALCULATION_REVISION,
    evidenceWatermarkVersion: watermark.version,
    evidenceObservedAt: watermark.observedAt,
    evidenceSourceCount: watermark.sourceCount,
    evidenceFingerprint: watermark.fingerprint,
    sources: projectedSources,
  };
}

export function adaptiveProfileMatchesCurrentEvidence(profile, sources = {}, options = {}) {
  const snapshot = adaptiveLearningEvidenceSnapshot(sources, options);
  return adaptiveProfileMatchesEvidenceSources(profile, snapshot.sources);
}

function downgradeRepeatedDiagnosticEvidence(observations) {
  const seen = new Set();
  const ordered = observations.map((observation, index) => ({ observation, index }))
    .sort((left, right) => (
      String(left.observation.observedAt || '').localeCompare(String(right.observation.observedAt || ''))
      || left.index - right.index
    ));
  const replacements = new Map();
  for (const { observation, index } of ordered) {
    if (!observation.independent || !observation.diagnosticFamily) continue;
    if (!seen.has(observation.diagnosticFamily)) {
      seen.add(observation.diagnosticFamily);
      continue;
    }
    replacements.set(index, {
      ...observation,
      weight: ADAPTIVE_EVIDENCE_WEIGHTS.assistedRecovery,
      kind: 'diagnostic_repeat',
      quality: 'assisted',
      independent: false,
    });
  }
  return observations.map((observation, index) => replacements.get(index) || observation);
}

function evidenceQualityFor(observations) {
  if (!observations.length) return 'none';
  const qualities = new Set(observations.map((item) => item.quality));
  if (qualities.size > 1) return 'mixed';
  return observations[0].quality;
}

function independentSourceCount(observations) {
  const sources = new Set();
  observations.forEach((observation, index) => {
    if (!observation.independent) return;
    sources.add(observation.independentSourceId || `observation:${index}`);
  });
  return sources.size;
}

function explanationFor(observations) {
  if (!observations.length) return 'no_evidence';
  const kinds = new Set(observations.map((item) => item.kind));
  if (kinds.has('retention_check')) return 'retention_evidence';
  if (kinds.has('diagnostic_repeat')) return 'repeated_diagnostic_item';
  if (kinds.has('diagnostic_productive_preliminary')) return 'productive_choice_only';
  if (kinds.has('diagnostic_listening_assisted')) return 'assisted_local_tts_diagnostic';
  if (kinds.has('diagnostic_answer')) return 'diagnostic_evidence';
  if (kinds.has('assisted_recovery') && kinds.size > 1) return 'mixed_with_assistance';
  if (kinds.has('assisted_recovery')) return 'assisted_recovery_only';
  return 'attempt_evidence';
}

export function buildAdaptiveLearningProfile(sources = {}, { diagnosticRegistry = DIAGNOSTIC_REGISTRY } = {}) {
  const snapshot = adaptiveLearningEvidenceSnapshot(sources, { diagnosticRegistry });
  const {
    attempts: eligibleAttempts,
    recoveries,
    repeatAttempts,
    diagnosticResponses,
    diagnosticCompletions: supportedDiagnosticCompletions,
  } = snapshot.sources;
  const observations = downgradeRepeatedDiagnosticEvidence([
    ...eligibleAttempts.map(attemptObservation),
    ...recoveries.map(recoveryObservation),
    ...repeatAttempts.map(repeatObservation),
    ...diagnosticResponses.map((response) => diagnosticObservation(response, diagnosticRegistry)),
  ].filter(Boolean));

  const skills = SKILLS.map((skill) => {
    const relevant = observations.filter((item) => item.skillId === skill.id);
    const independent = relevant.filter((item) => item.independent);
    const independentCount = independentSourceCount(independent);
    const assisted = relevant.filter((item) => item.quality === 'assisted').slice(-MAX_ASSISTED_OBSERVATIONS_PER_SKILL);
    const clientReported = relevant.filter((item) => item.quality === 'client_reported').slice(-MAX_CLIENT_REPORTED_OBSERVATIONS_PER_SKILL);
    const effective = [...independent, ...assisted, ...clientReported];
    const scoreWeight = effective.reduce((sum, item) => sum + item.weight, 0);
    const rawMastery = scoreWeight
      ? Math.round(effective.reduce((sum, item) => sum + item.score * item.weight, 0) / scoreWeight)
      : 0;
    const mastery = independent.length ? rawMastery : Math.min(49, rawMastery);
    const independentWeight = independent.reduce((sum, item) => sum + item.weight, 0);
    const timestamps = relevant.map((item) => item.observedAt).filter(Boolean).sort();
    const status = !relevant.length
      ? 'unobserved'
      : independentCount >= MIN_INDEPENDENT_EVIDENCE_PER_SKILL
        ? 'established'
        : 'preliminary';
    return {
      id: skill.id,
      label: skill.label,
      module: skill.module,
      mastery,
      uncertainty: Math.round(Math.max(15, 100 - independentWeight * 20)),
      status,
      evidenceCount: relevant.length,
      effectiveEvidenceCount: effective.length,
      independentEvidenceCount: independentCount,
      evidenceQuality: evidenceQualityFor(relevant),
      lastObservedAt: timestamps.at(-1) || null,
      dueState: 'not_due',
      criticalRetentionExpiresAt: null,
      explanationCode: explanationFor(relevant),
    };
  });

  const modules = [...new Set(SKILLS.map((skill) => skill.module))].map((module) => {
    const moduleSkills = skills.filter((skill) => skill.module === module);
    const evidenced = moduleSkills.filter((skill) => skill.evidenceCount > 0);
    return {
      id: module,
      mastery: evidenced.length
        ? Math.round(evidenced.reduce((sum, skill) => sum + skill.mastery, 0) / evidenced.length)
        : 0,
      uncertainty: Math.round(moduleSkills.reduce((sum, skill) => sum + skill.uncertainty, 0) / moduleSkills.length),
      status: moduleSkills.every((skill) => skill.status === 'established') ? 'established' : 'preliminary',
      evidenceCount: moduleSkills.reduce((sum, skill) => sum + skill.evidenceCount, 0),
      independentEvidenceCount: independentSourceCount(
        observations.filter((item) => item.skillId && SKILL_BY_ID.get(item.skillId)?.module === module),
      ),
    };
  });
  const confidence = Math.round(skills.reduce((sum, skill) => sum + 100 - skill.uncertainty, 0) / skills.length);
  const coveredModules = modules.filter((module) => module.evidenceCount > 0).length;
  const independentEvidenceCount = independentSourceCount(observations);
  const assistedEvidenceCount = observations.filter((item) => item.quality === 'assisted').length;
  const clientReportedEvidenceCount = observations.filter((item) => item.quality === 'client_reported').length;
  const independentModuleCount = modules.filter((module) => module.independentEvidenceCount > 0).length;
  const establishedSkillCount = skills.filter((skill) => skill.status === 'established').length;
  const sparseEvidence = observations.length < 6 || coveredModules < 3 || confidence < 50;
  const insufficientIndependentEvidence = independentEvidenceCount < MIN_INDEPENDENT_EVIDENCE
    || independentModuleCount < MIN_INDEPENDENT_MODULES;
  const unconfirmedSkills = establishedSkillCount < skills.length;
  const preliminary = sparseEvidence || insufficientIndependentEvidence || unconfirmedSkills;
  const explanationCodes = [];
  if (sparseEvidence) explanationCodes.push('sparse_evidence');
  if (insufficientIndependentEvidence) explanationCodes.push('insufficient_independent_evidence');
  if (unconfirmedSkills) explanationCodes.push('unconfirmed_skills');
  if (supportedDiagnosticCompletions.length) explanationCodes.push('short_diagnostic_complete');
  if (!preliminary) explanationCodes.push('evidence_backed');

  return {
    taxonomyVersion: TAXONOMY_VERSION,
    weightingVersion: WEIGHTING_VERSION,
    profileCalculationRevision: snapshot.profileCalculationRevision,
    evidenceWatermarkVersion: snapshot.evidenceWatermarkVersion,
    evidenceObservedAt: snapshot.evidenceObservedAt,
    evidenceSourceCount: snapshot.evidenceSourceCount,
    evidenceFingerprint: snapshot.evidenceFingerprint,
    preliminary,
    status: preliminary ? 'preliminary' : 'established',
    confidence,
    evidenceCount: observations.length,
    independentEvidenceCount,
    assistedEvidenceCount,
    clientReportedEvidenceCount,
    independentModuleCount,
    establishedSkillCount,
    needsDiagnostic: preliminary && !supportedDiagnosticCompletions.length,
    explanationCodes,
    skills,
    modules,
  };
}
