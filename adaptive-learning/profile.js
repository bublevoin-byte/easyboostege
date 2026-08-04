import { normalizeModuleAttemptEvidenceQuality } from './evidence-quality.js';
import {
  ADAPTIVE_PROFILE_CALCULATION_REVISION,
  buildAdaptiveEvidenceWatermark,
} from './evidence-watermark.js';
import { resolveVoiceTutorAdaptiveSkill, VOICE_TUTOR_SKILL_COMPATIBILITY } from './skill-compatibility.js';
import {
  DIAGNOSTIC_REGISTRY,
  getDiagnosticCatalog,
  getDiagnosticItem,
} from './diagnostic-catalog.js';

const TAXONOMY_VERSION = 'ege-en-v1';
const WEIGHTING_VERSION = 'adaptive-evidence-v1';

export const ADAPTIVE_EVIDENCE_WEIGHTS = Object.freeze({
  moduleAttempt: 0.7,
  clientReportedAttempt: 0.1,
  assistedRecovery: 0.2,
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
  { id: 'ege.grammar.forms', label: 'Грамматические формы', module: 'grammar', egeWeight: 1, recommendedBlockMinutes: 15, activityIds: ['grammar_19_24', 'grammar_forms', 'grammar_forms_topic_3', 'grammar_forms_topic_4'] },
  { id: 'ege.grammar.transformations', label: 'Грамматические преобразования', module: 'grammar', egeWeight: 0.9, recommendedBlockMinutes: 15, activityIds: ['grammar_25_29', 'grammar_transformations', 'grammar_transformations_topic_18'] },
  { id: 'ege.reading.gist', label: 'Основная мысль текста', module: 'reading', egeWeight: 0.8, recommendedBlockMinutes: 15, activityIds: ['reading_gist', 'reading_headings'] },
  { id: 'ege.reading.detail', label: 'Детальное понимание текста', module: 'reading', egeWeight: 1, recommendedBlockMinutes: 20, activityIds: ['reading_detail', 'reading'] },
  { id: 'ege.listening.gist', label: 'Основная мысль аудио', module: 'listening', egeWeight: 0.8, recommendedBlockMinutes: 15, activityIds: ['listening_gist', 'listening_matching'] },
  { id: 'ege.listening.detail', label: 'Детальное понимание аудио', module: 'listening', egeWeight: 1, recommendedBlockMinutes: 20, activityIds: ['listening_detail', 'listening', 'listening_interview'] },
  { id: 'ege.writing.email', label: 'Электронное письмо', module: 'writing', egeWeight: 0.8, recommendedBlockMinutes: 25, premiumDeepAssessment: true, activityIds: ['writing_37', 'email'] },
  { id: 'ege.writing.essay', label: 'Развёрнутое письменное высказывание', module: 'writing', egeWeight: 1, recommendedBlockMinutes: 30, premiumDeepAssessment: true, activityIds: ['writing_38', 'essay'] },
  { id: 'ege.speaking.interaction', label: 'Устное взаимодействие', module: 'speaking', egeWeight: 0.9, recommendedBlockMinutes: 15, premiumDeepAssessment: true, activityIds: ['speaking_2', 'speaking_3', 'speaking_interaction'] },
  { id: 'ege.speaking.monologue', label: 'Монологическое высказывание', module: 'speaking', egeWeight: 1, recommendedBlockMinutes: 20, premiumDeepAssessment: true, activityIds: ['speaking_4', 'speaking_monologue', 'speaking'] },
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
  ['speaking', SKILL_BY_ID.get('ege.speaking.monologue')],
]);

export const EGE_SKILL_TAXONOMY = Object.freeze({
  version: TAXONOMY_VERSION,
  voiceTutorCompatibilityVersion: VOICE_TUTOR_SKILL_COMPATIBILITY.version,
  skills: Object.freeze(SKILLS.map((skill) => Object.freeze({ ...skill }))),
});

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function iso(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
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
  const skill = skillFor(attempt.module, attempt.activity);
  const maximum = number(attempt.max_score ?? attempt.maxScore);
  if (!skill || maximum <= 0) return null;
  const storedQuality = normalizeModuleAttemptEvidenceQuality(attempt.evidence_quality ?? attempt.evidenceQuality);
  const quality = storedQuality === 'server_verified_unassisted'
    ? 'independent'
    : storedQuality === 'server_verified_assisted'
      ? 'assisted'
      : 'client_reported';
  return {
    skillId: skill.id,
    score: Math.max(0, Math.min(100, number(attempt.score) / maximum * 100)),
    weight: quality === 'independent'
      ? ADAPTIVE_EVIDENCE_WEIGHTS.moduleAttempt
      : quality === 'assisted'
        ? ADAPTIVE_EVIDENCE_WEIGHTS.assistedRecovery
        : ADAPTIVE_EVIDENCE_WEIGHTS.clientReportedAttempt,
    kind: 'module_attempt',
    quality,
    independent: quality === 'independent',
    observedAt: iso(attempt.created_at ?? attempt.createdAt),
  };
}

function recoveryObservation(recovery) {
  const skill = skillFor(recovery.module, '', recovery.skill_id ?? recovery.skillId, { allowModuleFallback: false });
  if (!skill) return null;
  const microPassed = Boolean(recovery.initial_micro_check_passed ?? recovery.initialMicroCheckPassed);
  const transferPassed = Boolean(recovery.initial_transfer_passed ?? recovery.initialTransferPassed);
  const fallback = (recovery.terminal_outcome ?? recovery.terminalOutcome) === 'fallback';
  return {
    skillId: skill.id,
    score: fallback ? 35 : transferPassed ? 65 : microPassed ? 50 : 35,
    weight: ADAPTIVE_EVIDENCE_WEIGHTS.assistedRecovery,
    kind: 'assisted_recovery',
    quality: 'assisted',
    independent: false,
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
    observedAt: iso(attempt.observed_at ?? attempt.observedAt),
  };
}

function diagnosticObservation(response, diagnosticRegistry) {
  const item = getDiagnosticItem(
    response.catalog_version ?? response.catalogVersion,
    response.item_id ?? response.itemId,
    diagnosticRegistry,
  );
  const skill = SKILL_BY_ID.get(response.skill_id ?? response.skillId);
  if (!item || !skill || item.skillId !== skill.id || item.module !== response.module
    || typeof response.correct !== 'boolean') return null;
  const storedEvidenceQuality = response.evidence_quality ?? response.evidenceQuality ?? item.evidenceQuality;
  if (storedEvidenceQuality !== item.evidenceQuality) return null;
  const assisted = item.evidenceQuality === 'assisted';
  return {
    skillId: skill.id,
    score: response.correct ? 100 : 0,
    weight: assisted
      ? ADAPTIVE_EVIDENCE_WEIGHTS.assistedRecovery
      : ADAPTIVE_EVIDENCE_WEIGHTS.diagnosticAnswer,
    kind: assisted ? 'diagnostic_listening_assisted' : 'diagnostic_answer',
    quality: assisted ? 'assisted' : 'independent',
    independent: !assisted,
    observedAt: iso(response.answered_at ?? response.answeredAt),
  };
}

function evidenceQualityFor(observations) {
  if (!observations.length) return 'none';
  const qualities = new Set(observations.map((item) => item.quality));
  if (qualities.size > 1) return 'mixed';
  return observations[0].quality;
}

function explanationFor(observations) {
  if (!observations.length) return 'no_evidence';
  const kinds = new Set(observations.map((item) => item.kind));
  if (kinds.has('retention_check')) return 'retention_evidence';
  if (kinds.has('diagnostic_listening_assisted')) return 'assisted_local_tts_diagnostic';
  if (kinds.has('diagnostic_answer')) return 'diagnostic_evidence';
  if (kinds.has('assisted_recovery') && kinds.size > 1) return 'mixed_with_assistance';
  if (kinds.has('assisted_recovery')) return 'assisted_recovery_only';
  return 'attempt_evidence';
}

export function buildAdaptiveLearningProfile({
  attempts = [], recoveries = [], repeatAttempts = [], diagnosticResponses = [],
  diagnosticCompletions = [],
} = {}, { diagnosticRegistry = DIAGNOSTIC_REGISTRY } = {}) {
  const supportedDiagnosticCompletions = diagnosticCompletions
    .filter((completion) => getDiagnosticCatalog(
      completion.catalog_version ?? completion.catalogVersion,
      diagnosticRegistry,
    ))
    .map((completion) => ({
      catalog_version: completion.catalog_version ?? completion.catalogVersion,
      completed_at: iso(completion.completed_at ?? completion.completedAt),
    }))
    .filter((completion) => completion.completed_at);
  const watermark = buildAdaptiveEvidenceWatermark({
    attempts, recoveries, repeatAttempts, diagnosticResponses,
    diagnosticCompletions: supportedDiagnosticCompletions,
  });
  const observations = [
    ...attempts.map(attemptObservation),
    ...recoveries.map(recoveryObservation),
    ...repeatAttempts.map(repeatObservation),
    ...diagnosticResponses.map((response) => diagnosticObservation(response, diagnosticRegistry)),
  ].filter(Boolean);

  const skills = SKILLS.map((skill) => {
    const relevant = observations.filter((item) => item.skillId === skill.id);
    const independent = relevant.filter((item) => item.independent);
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
      : independent.length >= MIN_INDEPENDENT_EVIDENCE_PER_SKILL
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
      independentEvidenceCount: independent.length,
      evidenceQuality: evidenceQualityFor(relevant),
      lastObservedAt: timestamps.at(-1) || null,
      dueState: 'not_due',
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
      independentEvidenceCount: moduleSkills.reduce((sum, skill) => sum + skill.independentEvidenceCount, 0),
    };
  });
  const confidence = Math.round(skills.reduce((sum, skill) => sum + 100 - skill.uncertainty, 0) / skills.length);
  const coveredModules = modules.filter((module) => module.evidenceCount > 0).length;
  const independentEvidenceCount = observations.filter((item) => item.independent).length;
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
    profileCalculationRevision: ADAPTIVE_PROFILE_CALCULATION_REVISION,
    evidenceWatermarkVersion: watermark.version,
    evidenceObservedAt: watermark.observedAt,
    evidenceSourceCount: watermark.sourceCount,
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
