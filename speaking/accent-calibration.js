export const SPEAKING_ACCENT_LOCALES = Object.freeze(['en-GB', 'en-US']);
export const SPEAKING_ACCENT_SUGGESTION_POLICY = 'speaking-accent-suggestion-v1';
export const SPEAKING_CALIBRATION_CONSENT_POLICY = 'speaking-calibration-consent-v1';
export const SPEAKING_CALIBRATION_RETENTION_DAYS = 180;
export const SPEAKING_CALIBRATION_CLAIM_LEASE_MS = 15 * 60 * 1000;

const MAXIMUM_BY_TASK = Object.freeze({ 1: 1, 2: 4, 3: 5, 4: 10 });
const RUBRIC_CRITERIA = Object.freeze({
  1: Object.freeze(['correct_reading']),
  2: Object.freeze(['question_form', 'communicative_relevance']),
  3: Object.freeze(['content', 'interaction', 'language']),
  4: Object.freeze(['content', 'organization', 'language']),
});

export function speakingAccentError(code) {
  return Object.assign(new Error(code), { code });
}

function validAssessment(value, locale) {
  return value && value.status === 'success' && value.isFinal === true
    && value.locale === locale && value.quality?.acceptable === true
    && Number.isFinite(Number(value.overallScore))
    && Number(value.overallScore) >= 0 && Number(value.overallScore) <= 100;
}

export function selectSpeakingAccentSuggestion({ enGB, enUS }) {
  if (!validAssessment(enGB, 'en-GB') || !validAssessment(enUS, 'en-US')) {
    throw speakingAccentError('SPEAKING_ACCENT_CALIBRATION_EVIDENCE_INVALID');
  }
  const scoreGap = Math.round(Math.abs(Number(enGB.overallScore) - Number(enUS.overallScore)) * 100) / 100;
  const clear = scoreGap >= 4;
  return {
    locale: clear && Number(enUS.overallScore) > Number(enGB.overallScore) ? 'en-US' : 'en-GB',
    confidence: clear ? 'clear' : 'close',
    scoreGap,
    policyVersion: SPEAKING_ACCENT_SUGGESTION_POLICY,
  };
}

export function speakingCalibrationMaximum(taskType) {
  const maximum = MAXIMUM_BY_TASK[Number(taskType)];
  if (!maximum) throw speakingAccentError('SPEAKING_CALIBRATION_TASK_INVALID');
  return maximum;
}

export function speakingCalibrationRubric(taskType) {
  const maximumScore = speakingCalibrationMaximum(taskType);
  return {
    version: 'ege-speaking-expert-rubric-v1',
    maximumScore,
    criteria: [...RUBRIC_CRITERIA[Number(taskType)]],
    sufficientDefinition: 'The complete response is audible and can be scored against every criterion.',
  };
}

export function materialSpeakingCalibrationDisagreement(taskType, first, second) {
  speakingCalibrationMaximum(taskType);
  if (!first || !second) return false;
  if (Boolean(first.criticalError) !== Boolean(second.criticalError)) return true;
  if (Number(taskType) === 1) return Number(first.score) !== Number(second.score);
  return Math.abs(Number(first.score) - Number(second.score)) > 1;
}

export function speakingCalibrationExpiresAt(now = new Date()) {
  const instant = new Date(now);
  if (!Number.isFinite(instant.getTime())) throw speakingAccentError('SPEAKING_CALIBRATION_TIME_INVALID');
  return new Date(instant.getTime() + SPEAKING_CALIBRATION_RETENTION_DAYS * 86_400_000);
}

export function speakingCalibrationReviewClaim(sample, reviewer, now = new Date()) {
  const instant = new Date(now);
  if (!Number.isFinite(instant.getTime())) throw speakingAccentError('SPEAKING_CALIBRATION_TIME_INVALID');
  const reviews = Array.isArray(sample?.reviews) ? sample.reviews : [];
  const sufficientReviews = reviews.filter((review) => review?.sufficient !== false);
  const accessAudit = Array.isArray(sample?.access_audit) ? sample.access_audit : [];
  const reviewRound = reviews.length + 1;
  let current = null;
  for (const entry of accessAudit) {
    if (Number(entry?.review_round) === reviewRound) current = entry;
  }
  const accessedAt = new Date(current?.accessed_at || 0).getTime();
  const active = Boolean(current) && Number.isFinite(accessedAt)
    && accessedAt + SPEAKING_CALIBRATION_CLAIM_LEASE_MS > instant.getTime();
  return {
    reviewRound,
    currentReviewer: current?.reviewer || null,
    ownsActiveClaim: active && current?.reviewer === reviewer,
    canClaim: reviews.length < 12 && sufficientReviews.length < 3
      && (!active || current?.reviewer === reviewer),
    resume: active && current?.reviewer === reviewer,
  };
}

export function assertSpeakingAccentProfileChange(input) {
  const locale = String(input?.locale || '');
  const source = String(input?.source || '');
  const now = new Date(input?.now ?? new Date());
  if (!SPEAKING_ACCENT_LOCALES.includes(locale) || !['manual', 'calibration'].includes(source)
    || !Number.isFinite(now.getTime())) {
    throw speakingAccentError('SPEAKING_ACCENT_PROFILE_INVALID');
  }
  return { locale, source, now };
}

export function assertSpeakingCalibrationConsent(input) {
  const granted = input?.granted;
  const ageGroup = String(input?.ageGroup || '');
  const guardianConfirmed = input?.guardianConfirmed;
  const policyVersion = String(input?.policyVersion || '');
  const now = new Date(input?.now ?? new Date());
  if (typeof granted !== 'boolean' || !['adult', 'minor'].includes(ageGroup)
    || typeof guardianConfirmed !== 'boolean'
    || policyVersion !== SPEAKING_CALIBRATION_CONSENT_POLICY
    || !Number.isFinite(now.getTime())) {
    throw speakingAccentError('SPEAKING_CALIBRATION_CONSENT_INVALID');
  }
  if (granted && ageGroup === 'minor' && guardianConfirmed !== true) {
    throw speakingAccentError('SPEAKING_CALIBRATION_GUARDIAN_REQUIRED');
  }
  if (ageGroup === 'adult' && guardianConfirmed) {
    throw speakingAccentError('SPEAKING_CALIBRATION_CONSENT_INVALID');
  }
  return { granted, ageGroup, guardianConfirmed, policyVersion, now };
}

export function assertSpeakingCalibrationSample(input) {
  const id = String(input?.id || '');
  const assessmentKey = String(input?.assessmentKey || '');
  const taskType = Number(input?.taskType);
  const taskRef = String(input?.taskRef || '');
  const locale = String(input?.locale || '');
  const maximumScore = Number(input?.maximumScore);
  const audio = Buffer.isBuffer(input?.audio) ? input.audio : null;
  const now = new Date(input?.now ?? new Date());
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
  const taskMatch = /^task[1-4]:[a-zA-Z0-9._-]+:([a-zA-Z0-9._-]+)@(\d+)$/u.exec(taskRef);
  let taskSnapshot = null;
  let rubricSnapshot = null;
  try {
    const taskJson = JSON.stringify(input?.taskSnapshot);
    const rubricJson = JSON.stringify(input?.rubricSnapshot);
    if (!taskJson || Buffer.byteLength(taskJson, 'utf8') > 32 * 1024
      || !rubricJson || Buffer.byteLength(rubricJson, 'utf8') > 4 * 1024) {
      throw new Error('snapshot_bounds');
    }
    taskSnapshot = JSON.parse(taskJson);
    rubricSnapshot = JSON.parse(rubricJson);
  } catch {
    throw speakingAccentError('SPEAKING_CALIBRATION_SAMPLE_INVALID');
  }
  const expectedRubric = speakingCalibrationRubric(taskType);
  if (!uuid.test(id) || !uuid.test(assessmentKey) || !MAXIMUM_BY_TASK[taskType]
    || maximumScore !== MAXIMUM_BY_TASK[taskType]
    || !/^[a-zA-Z0-9:@._-]{1,300}$/u.test(taskRef)
    || !taskMatch || taskSnapshot == null || Array.isArray(taskSnapshot)
    || taskSnapshot.id !== taskMatch[1]
    || Number(taskSnapshot.revision) !== Number(taskMatch[2])
    || Number(taskSnapshot.taskType) !== taskType
    || Number(taskSnapshot.maxScore) !== maximumScore
    || rubricSnapshot == null || Array.isArray(rubricSnapshot)
    || rubricSnapshot.version !== expectedRubric.version
    || Number(rubricSnapshot.maximumScore) !== maximumScore
    || JSON.stringify(rubricSnapshot.criteria) !== JSON.stringify(expectedRubric.criteria)
    || rubricSnapshot.sufficientDefinition !== expectedRubric.sufficientDefinition
    || !SPEAKING_ACCENT_LOCALES.includes(locale)
    || !audio || audio.length < 1 || audio.length > 10 * 1024 * 1024
    || !Number.isFinite(now.getTime())) {
    throw speakingAccentError('SPEAKING_CALIBRATION_SAMPLE_INVALID');
  }
  return {
    id, assessmentKey, taskType, taskRef, taskSnapshot, rubricSnapshot,
    locale, maximumScore, audio, now,
  };
}

export function assertSpeakingCalibrationReview(sample, input) {
  const sufficient = input?.sufficient;
  const score = Number(input?.score);
  const criticalError = input?.criticalError;
  const now = new Date(input?.now ?? new Date());
  if (typeof sufficient !== 'boolean' || !Number.isFinite(now.getTime())
    || (sufficient && (!Number.isInteger(score) || score < 0 || score > Number(sample?.maximum_score)
      || typeof criticalError !== 'boolean'))
    || (!sufficient && (input?.score != null || input?.criticalError != null))) {
    throw speakingAccentError('SPEAKING_CALIBRATION_REVIEW_INVALID');
  }
  return {
    sufficient, score: sufficient ? score : null,
    criticalError: sufficient ? criticalError : null, now,
  };
}

export function publicSpeakingAccentProfile(profile) {
  if (!profile) return null;
  return {
    locale: profile.locale,
    revision: Number(profile.revision),
    source: profile.source,
    effective_at: new Date(profile.effective_at).toISOString(),
    calibration_used: Boolean(profile.calibration_used),
  };
}

export function publicSpeakingAccentCalibration(setup) {
  if (!setup) return null;
  return {
    id: setup.id,
    status: setup.status,
    started_at: new Date(setup.started_at).toISOString(),
    completed_at: setup.completed_at ? new Date(setup.completed_at).toISOString() : null,
    locale: setup.locale || null,
    confidence: setup.confidence || null,
    policy_version: setup.policy_version || null,
  };
}

export function publicSpeakingCalibrationSample(sample) {
  return {
    id: sample.id,
    task_type: Number(sample.task_type),
    task_ref: sample.task_ref,
    accent_locale: sample.locale,
    status: sample.status,
    created_at: new Date(sample.created_at).toISOString(),
    expires_at: new Date(sample.expires_at).toISOString(),
    audio_retained: Boolean(sample.audio),
    raw_deleted_at: sample.raw_deleted_at ? new Date(sample.raw_deleted_at).toISOString() : null,
  };
}

export function blindSpeakingCalibrationCard(sample) {
  const reviewRound = sample.reviews.length + 1;
  return {
    sampleId: sample.id,
    taskType: Number(sample.task_type),
    taskRef: sample.task_ref,
    task: structuredClone(sample.task_snapshot),
    rubric: structuredClone(sample.rubric_snapshot),
    accentLocale: sample.locale,
    maximumScore: Number(sample.maximum_score),
    reviewRound,
    expiresAt: new Date(sample.expires_at).toISOString(),
  };
}
