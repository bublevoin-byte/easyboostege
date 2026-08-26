import { rateLimit } from 'express-rate-limit';

const VK_AUTH_RATE_LIMIT_PATHS = new Set([
  '/api/v1/auth/vk/start',
  '/api/v1/auth/vk/callback',
  '/api/auth/vk/start',
  '/api/auth/vk/callback',
]);

function originalPath(req) {
  const url = String(req.originalUrl || req.url || '');
  const queryStart = url.indexOf('?');
  return queryStart === -1 ? url : url.slice(0, queryStart);
}

// Section 10.8: a caller without a session is bounded by address, since there is no user to count
// against. VK start/callback have stricter, navigation-aware route limiters and must reach those
// authorities even while the generic anonymous bucket is exhausted.
export function createAnonymousIpLimiter(limit = 120) {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    skip: (req) => (req.method === 'GET' && VK_AUTH_RATE_LIMIT_PATHS.has(originalPath(req)))
      || Boolean(req.user)
      || Boolean(req.headers.authorization)
      || /(?:^|;\s*)eb_token=/u.test(req.headers.cookie || ''),
    message: { error: { code: 'RATE_LIMITED', message: 'Слишком много запросов. Попробуйте позже.' } },
  });
}

// Everything that decides whether a paid operation may run: access, consent, budget and rate.
export function createAccessControl({ ai, privacyPolicyVersion, countAiRequestsSince, getSub, getPrivacyConsent }) {
  function createUserRateLimiter(limit) {
    return rateLimit({
      windowMs: 60 * 60 * 1000,
      limit,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      keyGenerator: (req) => req.user,
      message: { error: { code: 'RATE_LIMITED', message: 'Слишком много запросов. Попробуйте позже.' } },
    });
  }

  async function hasAiBudget(now = new Date()) {
    const startOfUtcDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const used = await countAiRequestsSince(startOfUtcDay);
    return used < ai.dailyRequestBudget;
  }

  async function requireAiBudget(req, res, next) {
    try {
      if (!await hasAiBudget()) {
        return res.status(503).json({ error: { code: 'AI_BUDGET_EXHAUSTED', message: 'Дневной лимит ИИ исчерпан. Попробуйте завтра.' } });
      }
      next();
    } catch (error) { next(error); }
  }

  async function requireActiveSubscription(req, res, next) {
    try {
      const subscription = await getSub(req.user);
      if (!subscription.active) {
        return res.status(403).json({ error: { code: 'SUBSCRIPTION_REQUIRED', message: 'Для этой функции требуется активный доступ.' } });
      }
      next();
    } catch (error) { next(error); }
  }

  // Consent is version-bound: a new policy text invalidates the previous approval.
  function requirePrivacyConsent(kind) {
    return async (req, res, next) => {
      try {
        const consent = await getPrivacyConsent(req.user);
        if (consent.policy_version !== privacyPolicyVersion || !consent[kind]) {
          return res.status(403).json({ error: { code: 'PRIVACY_CONSENT_REQUIRED', message: 'Перед отправкой данных подтвердите согласие в профиле.' } });
        }
        next();
      } catch (error) { next(error); }
    };
  }

  // Section 10.2: each operation has its own hourly allowance, so a cheap dictionary lookup is not
  // rationed like a full essay review. Limiters are built once and reused per operation.
  function createOperationLimiter(resolveOperation, limitFor) {
    const limiters = new Map();
    return (req, res, next) => {
      const operation = resolveOperation(req);
      if (!operation) return next();
      if (!limiters.has(operation)) limiters.set(operation, createUserRateLimiter(limitFor(operation)));
      return limiters.get(operation)(req, res, next);
    };
  }

  return {
    privacyPolicyVersion,
    createUserRateLimiter,
    createOperationLimiter,
    hasAiBudget,
    requireAiBudget,
    requireActiveSubscription,
    requirePrivacyConsent,
    chatLimiter: createUserRateLimiter(ai.maxRequestsPerHour),
    writingLimiter: createUserRateLimiter(ai.maxWritingRequestsPerHour),
    ttsLimiter: createUserRateLimiter(ai.maxTtsRequestsPerHour),
    sttLimiter: createUserRateLimiter(ai.maxSttRequestsPerHour),
  };
}
