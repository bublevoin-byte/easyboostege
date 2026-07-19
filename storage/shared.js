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

export function hashAuthCode(code) {
  return crypto.createHash('sha256').update(String(code)).digest('hex');
}
