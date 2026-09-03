// Subscription rules, free of any transport: the bot only renders what these return.
export const TRIAL_DAYS = 30;
export const SUB_DAYS = 30;

export function formatDate(ms) {
  return new Date(ms).toLocaleDateString('ru-RU');
}

export function createSubscriptionService({
  trialDays = TRIAL_DAYS,
  subscriptionDays = SUB_DAYS,
  adminId,
  newRequestId,
  activateTrial,
  createPaymentRequest,
  resolvePaymentRequest,
  getUserByTelegram,
}) {
  // The trial is once per account: an already used one is reported, never silently re-granted.
  async function grantTrial(telegramId, name) {
    const existing = await getUserByTelegram(telegramId);
    if (existing && existing.trial_used) return { granted: false, reason: 'already_used' };
    const result = await activateTrial(telegramId, trialDays, name);
    if (!result.applied) return { granted: false, reason: 'already_used' };
    return { granted: true, until: result.sub_until, untilText: formatDate(result.sub_until) };
  }

  async function requestPayment(telegramId, name) {
    const request = await createPaymentRequest(newRequestId(), telegramId, name);
    return { id: request.id, telegramId, name, notifyAdmin: Boolean(adminId) };
  }

  function isAdmin(telegramId) {
    return Boolean(adminId) && String(telegramId) === String(adminId);
  }

  // Idempotent by design: a second decision on the same request changes nothing.
  async function resolvePayment(requestId, decision, telegramId) {
    if (!isAdmin(telegramId)) return { applied: false, reason: 'forbidden' };
    let result;
    try {
      result = await resolvePaymentRequest(requestId, decision, telegramId, subscriptionDays);
    } catch (error) {
      if (error?.message === 'PAYMENT_SELF_APPROVAL_FORBIDDEN') return { applied: false, reason: 'forbidden' };
      throw error;
    }
    if (!result.applied) return { applied: false, reason: 'already_resolved' };
    return {
      applied: true,
      decision,
      telegramId: result.telegram_id,
      until: result.sub_until,
      untilText: result.sub_until ? formatDate(result.sub_until) : '',
      days: subscriptionDays,
    };
  }

  return { grantTrial, requestPayment, resolvePayment, isAdmin, trialDays, subscriptionDays };
}
