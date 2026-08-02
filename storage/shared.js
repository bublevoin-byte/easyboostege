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

export function ensureVoiceTutorReservationAllowed(access, reservedSeconds) {
  if (!access.entitlements.voice_tutor) throw new VoiceTutorError('VOICE_TUTOR_PREMIUM_REQUIRED');
  if (access.voice_tutor.active_session) throw new VoiceTutorError('VOICE_TUTOR_SESSION_ACTIVE');
  if (access.voice_tutor.daily_remaining_seconds < reservedSeconds) throw new VoiceTutorError('VOICE_TUTOR_DAILY_QUOTA_EXHAUSTED');
  if (access.voice_tutor.monthly_remaining_seconds < reservedSeconds) throw new VoiceTutorError('VOICE_TUTOR_MONTHLY_QUOTA_EXHAUSTED');
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
  const elapsedSeconds = Math.ceil(Math.max(0, new Date(now).getTime() - new Date(session.started_at).getTime()) / 1000);
  return Math.min(reservedSeconds, elapsedSeconds);
}

export function hashAuthCode(code) {
  return crypto.createHash('sha256').update(String(code)).digest('hex');
}
