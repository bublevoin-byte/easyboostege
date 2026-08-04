const DAY_MS = 86_400_000;
const SKILL_COUNT = 12;

function instant(value) {
  const parsed = value instanceof Date ? new Date(value) : new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error('ADAPTIVE_RETENTION_TIME_INVALID');
  return parsed;
}

function iso(value) {
  return instant(value).toISOString();
}

function optionalIso(value) {
  return value == null ? null : iso(value);
}

function cadenceDays(profile = {}) {
  const confidence = Number(profile.confidence || 0);
  const coverage = Number(profile.establishedSkillCount || 0) / SKILL_COUNT;
  if (confidence < 60 || coverage < 0.5) return 28;
  if (confidence < 80 || coverage < 1) return 35;
  return 42;
}

function repeatUrgency(repeat, now) {
  if (!['due', 'overdue'].includes(repeat?.status)) return null;
  const windowEnd = instant(repeat.window_ends_at ?? repeat.windowEndsAt);
  if (repeat.status === 'overdue' || windowEnd.getTime() - now.getTime() <= 6 * 60 * 60_000) {
    return 'critical_due';
  }
  return 'due';
}

function dueCheck(skill, repeat, now) {
  const repeatId = String(repeat?.id || '');
  const taskId = String(repeat?.task_id ?? repeat?.taskId ?? '');
  const skillId = String(skill?.skill_id ?? skill?.skillId ?? '');
  const module = String(skill?.module || '');
  const stage = String(repeat?.stage || '');
  if (!/^[0-9a-f-]{36}$/iu.test(repeatId)
    || !/^[a-z0-9][a-z0-9._:-]{3,179}$/u.test(taskId)
    || !/^[a-z0-9][a-z0-9._-]{2,119}$/u.test(skillId)
    || !['vocabulary', 'grammar', 'reading', 'listening', 'writing', 'speaking'].includes(module)
    || !['day_1', 'day_7'].includes(stage)) return null;
  const status = repeatUrgency(repeat, now);
  if (!status) return null;
  return Object.freeze({
    repeatId,
    taskId,
    skillId,
    module,
    stage,
    status,
    dueAt: iso(repeat.due_at ?? repeat.dueAt),
    windowEndsAt: iso(repeat.window_ends_at ?? repeat.windowEndsAt),
  });
}

export function buildAdaptiveRetentionState({
  profile = {},
  recoveryMap = {},
  diagnosticCompletions = [],
  now = new Date(),
} = {}) {
  const calculatedAt = instant(now);
  const checks = (Array.isArray(recoveryMap?.skills) ? recoveryMap.skills : [])
    .flatMap((skill) => {
      const repeats = Array.isArray(skill?.repeats) ? skill.repeats : [];
      const dayOne = repeats.find((repeat) => repeat?.stage === 'day_1');
      const dayOnePassed = dayOne?.status === 'passed' || dayOne?.attempt?.passed === true;
      return repeats
        .filter((repeat) => repeat?.stage !== 'day_7' || dayOnePassed)
        .map((repeat) => dueCheck(skill, repeat, calculatedAt));
    })
    .filter(Boolean)
    .sort((left, right) => (
      Number(right.status === 'critical_due') - Number(left.status === 'critical_due')
      || Number(right.stage === 'day_1') - Number(left.stage === 'day_1')
      || left.dueAt.localeCompare(right.dueAt)
      || left.repeatId.localeCompare(right.repeatId)
    ));
  const completions = (Array.isArray(diagnosticCompletions) ? diagnosticCompletions : [])
    .map((item) => item?.completed_at ?? item?.completedAt)
    .filter(Boolean)
    .map(instant)
    .sort((left, right) => left - right);
  const lastCompleted = completions.at(-1) || null;
  const cadence = cadenceDays(profile);
  const establishedEvidence = !profile.needsDiagnostic && profile.evidenceObservedAt
    ? instant(profile.evidenceObservedAt) : null;
  const scheduleAnchor = lastCompleted || establishedEvidence;
  const nextDue = scheduleAnchor ? new Date(scheduleAnchor.getTime() + cadence * DAY_MS) : null;
  return Object.freeze({
    version: 'adaptive-retention-v1',
    calculatedAt: calculatedAt.toISOString(),
    dueChecks: Object.freeze(checks),
    rediagnostic: Object.freeze({
      cadenceDays: cadence,
      confidenceBand: cadence === 28 ? 'low' : cadence === 35 ? 'medium' : 'high',
      lastCompletedAt: lastCompleted?.toISOString() || null,
      nextDueAt: nextDue?.toISOString() || null,
      due: nextDue
        ? calculatedAt.getTime() >= nextDue.getTime()
        : Boolean(profile.needsDiagnostic),
      reasonCode: cadence === 28
        ? 'low_confidence_or_coverage'
        : cadence === 35 ? 'partial_confidence_or_coverage' : 'stable_profile_refresh',
    }),
  });
}

export function applyAdaptiveRetentionState(profile, retention) {
  const next = structuredClone(profile);
  const urgency = new Map();
  for (const check of retention?.dueChecks || []) {
    const current = urgency.get(check.skillId);
    if (!current || check.status === 'critical_due') urgency.set(check.skillId, check);
  }
  next.skills = (next.skills || []).map((skill) => {
    const dueCheck = urgency.get(skill.id) || null;
    const dueState = dueCheck?.status || 'not_due';
    return {
      ...skill,
      dueState,
      criticalRetentionExpiresAt: dueState === 'critical_due'
        ? dueCheck.windowEndsAt : null,
      explanationCode: dueState === 'not_due' ? skill.explanationCode : 'retention_check_due',
    };
  });
  if (retention?.rediagnostic?.due) {
    next.needsDiagnostic = true;
    next.explanationCodes = [...new Set([...(next.explanationCodes || []), 'rediagnostic_due'])];
  }
  return next;
}

function orientationBand(score) {
  if (score < 15) return ['A0', 'A1'];
  if (score < 30) return ['A1', 'A2'];
  if (score < 45) return ['A2', 'B1'];
  if (score < 60) return ['B1', 'B2'];
  if (score < 75) return ['B2', 'C1'];
  if (score < 90) return ['C1', 'C2'];
  return ['C2', 'C2'];
}

function ieltsBand(score) {
  if (score < 30) return '2.0–3.5';
  if (score < 45) return '3.5–4.5';
  if (score < 60) return '4.5–5.5';
  if (score < 75) return '5.5–6.5';
  if (score < 90) return '6.5–7.5';
  return '7.5–8.5';
}

export function buildAdaptiveLanguageOrientation(profile = {}) {
  const established = (Array.isArray(profile.skills) ? profile.skills : [])
    .filter((skill) => skill.status === 'established'
      && Number(skill.independentEvidenceCount || 0) >= 2);
  const insufficient = established.length < 4;
  const score = established.length
    ? Math.round(established.reduce((sum, skill) => sum + Number(skill.mastery || 0), 0) / established.length)
    : 0;
  const cefr = orientationBand(score);
  return Object.freeze({
    version: 'adaptive-language-orientation-v1',
    approximate: true,
    officialIeltsResult: false,
    disclaimer: 'Ориентир основан на заданиях ЕГЭ и не является официальным результатом IELTS или сертификатом CEFR.',
    cefr: Object.freeze({
      range: insufficient ? 'insufficient_evidence' : `${cefr[0]}–${cefr[1]}`,
      lower: insufficient ? null : cefr[0],
      upper: insufficient ? null : cefr[1],
    }),
    ielts: Object.freeze({ range: insufficient ? 'insufficient_evidence' : ieltsBand(score) }),
    basis: Object.freeze({
      independentlyEstablishedSkills: established.length,
      totalSkills: SKILL_COUNT,
      confidence: Number(profile.confidence || 0),
      assistedEvidenceDoesNotEstablishLevel: true,
    }),
  });
}

const DUE_RANK = Object.freeze({ not_due: 0, due: 1, overdue: 2, critical_due: 3 });

function sameNumber(left, right) {
  return Number(left) === Number(right);
}

export function isMonotonicAdaptiveRetentionRefresh(candidate, persistedProfile, persistedEstimates = []) {
  if (!candidate || !persistedProfile || !Array.isArray(candidate.skills)
    || candidate.skills.length !== persistedEstimates.length) return false;
  const scalarPairs = [
    ['taxonomyVersion', 'taxonomy_version'], ['weightingVersion', 'weighting_version'],
    ['status', 'status'], ['preliminary', 'preliminary'], ['confidence', 'confidence'],
    ['evidenceCount', 'evidence_count'], ['independentEvidenceCount', 'independent_evidence_count'],
    ['assistedEvidenceCount', 'assisted_evidence_count'],
    ['clientReportedEvidenceCount', 'client_reported_evidence_count'],
    ['independentModuleCount', 'independent_module_count'],
    ['establishedSkillCount', 'established_skill_count'],
  ];
  if (scalarPairs.some(([camel, snake]) => (
    typeof candidate[camel] === 'number'
      ? !sameNumber(candidate[camel], persistedProfile[snake])
      : candidate[camel] !== persistedProfile[snake]
  ))) return false;
  const diagnosticProgressed = candidate.needsDiagnostic === true
    && persistedProfile.needs_diagnostic !== true
    && candidate.explanationCodes?.includes('rediagnostic_due');
  const persistedCodes = [...new Set(Array.isArray(persistedProfile.explanation_codes)
    ? persistedProfile.explanation_codes : [])].sort();
  const expectedCodes = [...new Set([
    ...persistedCodes,
    ...(diagnosticProgressed ? ['rediagnostic_due'] : []),
  ])].sort();
  const candidateCodes = [...new Set(Array.isArray(candidate.explanationCodes)
    ? candidate.explanationCodes : [])].sort();
  if (JSON.stringify(candidateCodes) !== JSON.stringify(expectedCodes)) return false;
  const persistedBySkill = new Map(persistedEstimates.map((item) => [item.skill_id, item]));
  let progressed = false;
  for (const skill of candidate.skills) {
    const current = persistedBySkill.get(skill.id);
    if (!current || skill.module !== current.module || skill.status !== current.status
      || skill.evidenceQuality !== current.evidence_quality
      || !sameNumber(skill.mastery, current.mastery)
      || !sameNumber(skill.uncertainty, current.uncertainty)
      || !sameNumber(skill.evidenceCount, current.evidence_count)
      || !sameNumber(skill.effectiveEvidenceCount, current.effective_evidence_count)
      || !sameNumber(skill.independentEvidenceCount, current.independent_evidence_count)
      || (skill.lastObservedAt || null) !== (current.last_observed_at || null)) return false;
    const before = DUE_RANK[current.due_state];
    const after = DUE_RANK[skill.dueState];
    if (!Number.isInteger(before) || !Number.isInteger(after) || after < before) return false;
    if (after > before) progressed = true;
    if (after === before && skill.explanationCode !== current.explanation_code) return false;
    if (after > before && skill.explanationCode !== 'retention_check_due') return false;
    const candidateExpiry = optionalIso(skill.criticalRetentionExpiresAt);
    const persistedExpiry = optionalIso(current.critical_retention_expires_at);
    if (after === 3 && (!candidateExpiry || (before === 3 && candidateExpiry !== persistedExpiry))) return false;
    if (after < 3 && candidateExpiry !== persistedExpiry) return false;
  }
  if (candidate.needsDiagnostic !== Boolean(persistedProfile.needs_diagnostic)
    && !diagnosticProgressed) return false;
  return progressed || diagnosticProgressed;
}
