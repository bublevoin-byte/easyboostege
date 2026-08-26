import crypto from 'node:crypto';

export function normalizeUsername(displayName, telegramId) {
  const fallback = `tg${telegramId}`;
  const base = String(displayName || fallback)
    .normalize('NFKC')
    .replace(/[^A-Za-zА-Яа-яЁё0-9_]+/gu, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 20);
  return base || fallback;
}

export function normalizeProviderIdentity({ provider, subject, displayName }) {
  const normalizedProvider = String(provider || '').trim().toLowerCase();
  const normalizedSubject = String(subject || '').trim();
  const normalizedDisplayName = String(displayName || '').normalize('NFKC').trim();
  if (!/^[a-z][a-z0-9_-]{0,31}$/u.test(normalizedProvider)
    || !/^[A-Za-z0-9._:-]{1,128}$/u.test(normalizedSubject)
    || !normalizedDisplayName || normalizedDisplayName.length > 160
    || /[\u0000-\u001f\u007f]/u.test(normalizedDisplayName)) {
    throw new Error('PROVIDER_IDENTITY_INVALID');
  }
  return { provider: normalizedProvider, subject: normalizedSubject, displayName: normalizedDisplayName };
}

export function normalizeOAuthTransaction({
  provider, stateHash, verifierSealed, redirectUri, expiresAt, now = new Date(),
}) {
  const normalizedProvider = String(provider || '').trim().toLowerCase();
  const normalizedStateHash = String(stateHash || '').trim().toLowerCase();
  const normalizedVerifier = String(verifierSealed || '');
  const expires = new Date(expiresAt);
  const created = new Date(now);
  let redirect;
  try { redirect = new URL(String(redirectUri || '')); } catch { throw new Error('OAUTH_TRANSACTION_INVALID'); }
  if (!/^[a-z][a-z0-9_-]{0,31}$/u.test(normalizedProvider)
    || !/^[a-f0-9]{64}$/u.test(normalizedStateHash)
    || !normalizedVerifier || normalizedVerifier.length > 1_024
    || !Number.isFinite(expires.getTime()) || !Number.isFinite(created.getTime())
    || expires.getTime() <= created.getTime()
    || !['http:', 'https:'].includes(redirect.protocol)
    || redirect.username || redirect.password || redirect.search || redirect.hash) {
    throw new Error('OAUTH_TRANSACTION_INVALID');
  }
  return {
    provider: normalizedProvider,
    stateHash: normalizedStateHash,
    verifierSealed: normalizedVerifier,
    redirectUri: redirect.toString(),
    expiresAt: expires,
    createdAt: created,
  };
}

export function subscriptionView(user) {
  if (!user) return { sub_until: 0, active: false, trial_used: false };
  const subUntil = Number(user.sub_until || 0);
  return {
    sub_until: subUntil,
    active: subUntil > Date.now(),
    trial_used: Boolean(user.trial_used),
  };
}

export function voiceTutorAccessView({ entitled = false, dailyUsedSeconds = 0, monthlyUsedSeconds = 0, activeSession = false } = {}, limits = {}) {
  const active = Boolean(entitled);
  return {
    entitlements: { voice_tutor: active },
    voice_tutor: {
      daily_remaining_seconds: active ? Math.max(0, Number(limits.dailySeconds || 0) - Number(dailyUsedSeconds || 0)) : 0,
      monthly_remaining_seconds: active ? Math.max(0, Number(limits.monthlySeconds || 0) - Number(monthlyUsedSeconds || 0)) : 0,
      active_session: active && Boolean(activeSession),
    },
  };
}

export function voiceTutorQuotaPeriods(now = new Date()) {
  const instant = new Date(now);
  return {
    dayStart: new Date(Date.UTC(instant.getUTCFullYear(), instant.getUTCMonth(), instant.getUTCDate())),
    monthStart: new Date(Date.UTC(instant.getUTCFullYear(), instant.getUTCMonth(), 1)),
  };
}

export class VoiceTutorError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
    this.name = 'VoiceTutorError';
  }
}

const VOICE_TUTOR_DELIVERY_FIELD = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/u;

export function normalizeVoiceTutorDeliveryMetadata({ provider = null, model = null, promptVersion = null } = {}) {
  const normalized = {
    provider: provider == null || provider === '' ? null : String(provider),
    model: model == null || model === '' ? null : String(model),
    prompt_version: promptVersion == null || promptVersion === '' ? null : String(promptVersion),
  };
  if (Object.values(normalized).some((value) => value != null && !VOICE_TUTOR_DELIVERY_FIELD.test(value))) {
    throw new VoiceTutorError('VOICE_TUTOR_PROVIDER_CONTRACT_INVALID');
  }
  return normalized;
}

export function voiceTutorReservationSeconds(access, sessionSeconds) {
  const requested = Number(sessionSeconds);
  if (!Number.isInteger(requested) || requested <= 0) throw new VoiceTutorError('VOICE_TUTOR_USAGE_INVALID');
  if (!access.entitlements.voice_tutor) throw new VoiceTutorError('VOICE_TUTOR_PREMIUM_REQUIRED');
  if (access.voice_tutor.active_session) throw new VoiceTutorError('VOICE_TUTOR_SESSION_ACTIVE');
  const dailyRemaining = Math.max(0, Number(access.voice_tutor.daily_remaining_seconds) || 0);
  const monthlyRemaining = Math.max(0, Number(access.voice_tutor.monthly_remaining_seconds) || 0);
  if (dailyRemaining === 0) throw new VoiceTutorError('VOICE_TUTOR_DAILY_QUOTA_EXHAUSTED');
  if (monthlyRemaining === 0) throw new VoiceTutorError('VOICE_TUTOR_MONTHLY_QUOTA_EXHAUSTED');
  return Math.min(requested, dailyRemaining, monthlyRemaining);
}

export function voiceTutorBillableSeconds(session, now, confirmedBillableSeconds = null) {
  const reservedSeconds = Number(session.reserved_seconds);
  if (confirmedBillableSeconds != null) {
    const confirmed = Number(confirmedBillableSeconds);
    if (!Number.isInteger(confirmed) || confirmed < 0 || confirmed > reservedSeconds) {
      throw new VoiceTutorError('VOICE_TUTOR_USAGE_INVALID');
    }
    return confirmed;
  }
  const requiresActivation = Boolean(session.capsule_id || session.capsule);
  if (requiresActivation && !session.voice_activated_at) return 0;
  const billingStartedAt = session.voice_activated_at || session.started_at;
  const elapsedSeconds = Math.ceil(Math.max(0, new Date(now).getTime() - new Date(billingStartedAt).getTime()) / 1000);
  return Math.min(reservedSeconds, elapsedSeconds);
}

const VOICE_TUTOR_PROXY_HASH = /^[a-f0-9]{64}$/u;
const VOICE_TUTOR_PROXY_REASON = /^[a-z][a-z0-9_]{0,63}$/u;

export function normalizeVoiceTutorProxyHash(value) {
  const hash = String(value || '').toLowerCase();
  if (!VOICE_TUTOR_PROXY_HASH.test(hash)) throw new VoiceTutorError('VOICE_TUTOR_PROXY_TICKET_INVALID');
  return hash;
}

export function voiceTutorProxyUsage(session, {
  inputAudioBytes,
  outputAudioBytes,
  confirmed,
  reason,
  now,
}) {
  const input = Number(inputAudioBytes);
  const output = Number(outputAudioBytes);
  const normalizedReason = String(reason || '');
  const finalizedAt = new Date(now);
  if (!Number.isSafeInteger(input) || input < 0 || !Number.isSafeInteger(output) || output < 0
    || typeof confirmed !== 'boolean' || !VOICE_TUTOR_PROXY_REASON.test(normalizedReason)
    || !Number.isFinite(finalizedAt.getTime())) {
    throw new VoiceTutorError('VOICE_TUTOR_USAGE_INVALID');
  }
  const exact = confirmed && normalizedReason === 'completed';
  const reservedSeconds = Number(session.reserved_seconds);
  const billableSeconds = exact
    ? Math.min(reservedSeconds, Math.ceil((input + output) / 48_000))
    : reservedSeconds;
  return {
    input_audio_bytes: input,
    output_audio_bytes: output,
    confirmed,
    exact,
    billable_seconds: billableSeconds,
    reason: normalizedReason,
    finalized_at: finalizedAt.toISOString(),
  };
}

export function hashAuthCode(code) {
  return crypto.createHash('sha256').update(String(code)).digest('hex');
}
