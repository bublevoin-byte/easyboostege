import { EGE_SKILL_TAXONOMY } from './profile.js';

const PROFILE_FIELDS = Object.freeze([
  'taxonomy_version', 'weighting_version', 'status', 'preliminary', 'confidence', 'evidence_count',
  'independent_evidence_count', 'assisted_evidence_count', 'client_reported_evidence_count',
  'independent_module_count', 'established_skill_count', 'needs_diagnostic', 'explanation_codes',
  'evidence_watermark_version', 'evidence_observed_at', 'evidence_source_count',
  'profile_calculation_revision',
]);

const ESTIMATE_FIELDS = Object.freeze([
  'taxonomy_version', 'skill_id', 'module', 'mastery', 'uncertainty', 'evidence_count',
  'effective_evidence_count', 'independent_evidence_count', 'evidence_quality', 'status',
  'last_observed_at', 'due_state', 'critical_retention_expires_at', 'explanation_code',
]);

const SKILL_LABELS = new Map(EGE_SKILL_TAXONOMY.skills.map((skill) => [skill.id, skill.label]));
const TAXONOMY_MODULES = [...new Set(EGE_SKILL_TAXONOMY.skills.map((skill) => skill.module))];

function timestamp(value) {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function allowlist(source, fields) {
  return Object.fromEntries(fields.map((field) => [field, source[field]]));
}

export function adaptiveLearningProfileRepositoryDto(profile, estimates = []) {
  if (!profile) return null;
  return {
    ...allowlist(profile, PROFILE_FIELDS),
    explanation_codes: Array.isArray(profile.explanation_codes) ? structuredClone(profile.explanation_codes) : [],
    evidence_observed_at: timestamp(profile.evidence_observed_at),
    updated_at: timestamp(profile.updated_at),
    estimates: estimates
      .map((estimate) => ({
        ...allowlist(estimate, ESTIMATE_FIELDS),
        last_observed_at: timestamp(estimate.last_observed_at),
        critical_retention_expires_at: timestamp(estimate.critical_retention_expires_at),
        updated_at: timestamp(estimate.updated_at),
      }))
      .sort((left, right) => String(left.skill_id).localeCompare(String(right.skill_id))),
  };
}

export function adaptiveLearningProfileExportDto(profile, estimates = []) {
  const repositoryDto = adaptiveLearningProfileRepositoryDto(profile, estimates);
  if (!repositoryDto) return { profile: null, estimates: [] };
  const { estimates: normalizedEstimates, ...normalizedProfile } = repositoryDto;
  return { profile: normalizedProfile, estimates: normalizedEstimates };
}

export function adaptiveLearningProfilePublicDto(profile) {
  if (!profile) return null;
  const skills = (profile.estimates || []).map((estimate) => ({
    id: estimate.skill_id,
    label: SKILL_LABELS.get(estimate.skill_id) || estimate.skill_id,
    module: estimate.module,
    mastery: Number(estimate.mastery),
    uncertainty: Number(estimate.uncertainty),
    status: estimate.status,
    evidenceCount: Number(estimate.evidence_count),
    effectiveEvidenceCount: Number(estimate.effective_evidence_count),
    independentEvidenceCount: Number(estimate.independent_evidence_count),
    evidenceQuality: estimate.evidence_quality,
    lastObservedAt: estimate.last_observed_at,
    dueState: estimate.due_state,
    criticalRetentionExpiresAt: estimate.critical_retention_expires_at,
    explanationCode: estimate.explanation_code,
  }));
  const modules = TAXONOMY_MODULES.map((module) => {
    const moduleSkills = skills.filter((skill) => skill.module === module);
    const evidenced = moduleSkills.filter((skill) => skill.evidenceCount > 0);
    return {
      id: module,
      mastery: evidenced.length
        ? Math.round(evidenced.reduce((sum, skill) => sum + skill.mastery, 0) / evidenced.length)
        : 0,
      uncertainty: moduleSkills.length
        ? Math.round(moduleSkills.reduce((sum, skill) => sum + skill.uncertainty, 0) / moduleSkills.length)
        : 100,
      status: moduleSkills.length && moduleSkills.every((skill) => skill.status === 'established')
        ? 'established'
        : 'preliminary',
      evidenceCount: moduleSkills.reduce((sum, skill) => sum + skill.evidenceCount, 0),
      independentEvidenceCount: moduleSkills.reduce((sum, skill) => sum + skill.independentEvidenceCount, 0),
    };
  });
  return {
    taxonomyVersion: profile.taxonomy_version,
    weightingVersion: profile.weighting_version,
    profileCalculationRevision: Number(profile.profile_calculation_revision),
    evidenceWatermarkVersion: profile.evidence_watermark_version,
    evidenceObservedAt: profile.evidence_observed_at,
    evidenceSourceCount: Number(profile.evidence_source_count),
    preliminary: Boolean(profile.preliminary),
    status: profile.status,
    confidence: Number(profile.confidence),
    evidenceCount: Number(profile.evidence_count),
    independentEvidenceCount: Number(profile.independent_evidence_count),
    assistedEvidenceCount: Number(profile.assisted_evidence_count),
    clientReportedEvidenceCount: Number(profile.client_reported_evidence_count),
    independentModuleCount: Number(profile.independent_module_count),
    establishedSkillCount: Number(profile.established_skill_count),
    needsDiagnostic: Boolean(profile.needs_diagnostic),
    explanationCodes: structuredClone(profile.explanation_codes || []),
    skills,
    modules,
  };
}

export function adaptiveLearningProfileSnapshotDto(profile) {
  if (!profile) return null;
  return {
    taxonomyVersion: profile.taxonomyVersion,
    weightingVersion: profile.weightingVersion,
    profileCalculationRevision: Number(profile.profileCalculationRevision),
    evidenceWatermarkVersion: profile.evidenceWatermarkVersion,
    evidenceObservedAt: timestamp(profile.evidenceObservedAt),
    evidenceSourceCount: Number(profile.evidenceSourceCount),
    preliminary: Boolean(profile.preliminary),
    status: profile.status,
    confidence: Number(profile.confidence),
    evidenceCount: Number(profile.evidenceCount),
    independentEvidenceCount: Number(profile.independentEvidenceCount),
    assistedEvidenceCount: Number(profile.assistedEvidenceCount),
    clientReportedEvidenceCount: Number(profile.clientReportedEvidenceCount),
    independentModuleCount: Number(profile.independentModuleCount),
    establishedSkillCount: Number(profile.establishedSkillCount),
    needsDiagnostic: Boolean(profile.needsDiagnostic),
    explanationCodes: Array.isArray(profile.explanationCodes)
      ? structuredClone(profile.explanationCodes)
      : [],
    skills: Array.isArray(profile.skills) ? profile.skills.map((skill) => ({
      id: skill.id,
      label: SKILL_LABELS.get(skill.id) || skill.id,
      module: skill.module,
      mastery: Number(skill.mastery),
      uncertainty: Number(skill.uncertainty),
      status: skill.status,
      evidenceCount: Number(skill.evidenceCount),
      effectiveEvidenceCount: Number(skill.effectiveEvidenceCount),
      independentEvidenceCount: Number(skill.independentEvidenceCount),
      evidenceQuality: skill.evidenceQuality,
      lastObservedAt: timestamp(skill.lastObservedAt),
      dueState: skill.dueState,
      criticalRetentionExpiresAt: timestamp(skill.criticalRetentionExpiresAt),
      explanationCode: skill.explanationCode,
    })) : [],
    modules: Array.isArray(profile.modules) ? profile.modules.map((module) => ({
      id: module.id,
      mastery: Number(module.mastery),
      uncertainty: Number(module.uncertainty),
      status: module.status,
      evidenceCount: Number(module.evidenceCount),
      independentEvidenceCount: Number(module.independentEvidenceCount),
    })) : [],
  };
}
