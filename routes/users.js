import crypto from 'crypto';
import express from 'express';
import jwt from 'jsonwebtoken';

// Session lifecycle, account data and the operator endpoints.
export function createUserRoutes({
  secret,
  telegramEnabled,
  botUsername,
  authCodeTtlMs,
  privacyPolicyVersion,
  limiters,
  authentication,
  buildMonitoringSnapshot,
  promoteConfiguredAdmin,
  db,
  voiceTutorLimits = {},
  featureFlags = {},
  now = () => new Date(),
  newPaymentRequestId = () => crypto.randomUUID(),
  premiumSubscriptionDays = 30,
}) {
  const router = express.Router();
  const { auth, requireRole, monitoringAuth, issueToken, readCookie, setAuthCookie, clearAuthCookie } = authentication;

  async function currentSubscription(username) {
    const subscription = await db.getSub(username);
    const voiceTutor = typeof db.getVoiceTutorAccess === 'function'
      ? await db.getVoiceTutorAccess(username, voiceTutorLimits, now())
      : { entitlements: { voice_tutor: false }, voice_tutor: { daily_remaining_seconds: 0, monthly_remaining_seconds: 0, active_session: false } };
    return {
      ...subscription,
      ...voiceTutor,
      features: { adaptive_learning: featureFlags.adaptiveLearning === true },
    };
  }

  router.post('/api/v1/tg/start', limiters.telegramStart, async (req, res, next) => {
    try {
      if (!telegramEnabled() || !botUsername()) {
        return res.status(503).json({ error: 'Telegram-вход не настроен на сервере' });
      }
      const code = crypto.randomBytes(24).toString('base64url');
      await db.createTelegramAuthCode(code, Date.now() + authCodeTtlMs);
      res.json({ code, url: `https://t.me/${botUsername()}?start=${code}` });
    } catch (error) { next(error); }
  });

  router.get('/api/v1/tg/check', limiters.telegramCheck, async (req, res, next) => {
    try {
      const code = String(req.query.code || '');
      const confirmed = code && await db.consumeTelegramAuthCode(code);
      if (!confirmed) return res.json({ pending: true });
      const existing = await db.getUserByTelegram(confirmed.telegram_id);
      const username = existing ? existing.username : await db.createTelegramUser(confirmed.telegram_id, confirmed.name);
      await promoteConfiguredAdmin(username, confirmed.telegram_id);
      setAuthCookie(req, res, await issueToken(username));
      res.json({ authenticated: true, username, ...await currentSubscription(username), bot: botUsername() });
    } catch (error) { next(error); }
  });

  router.get('/api/v1/me', auth, async (req, res, next) => {
    try {
      res.setHeader('Cache-Control', 'no-store');
      const token = req.sessionId ? req.authToken : await issueToken(req.user);
      setAuthCookie(req, res, token);
      res.json({ authenticated: true, username: req.user, role: req.role, bot: botUsername(), ...await currentSubscription(req.user) });
    } catch (error) { next(error); }
  });

  function publicPaymentRequest(request) {
    return request ? { id: request.id, product: request.product || 'base', status: request.status } : null;
  }

  router.post('/api/v1/payments/requests', auth, async (req, res, next) => {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)
      || Object.keys(req.body).length !== 1 || req.body.product !== 'premium_voice') {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Некорректный тариф заявки.' } });
    }
    try {
      const id = newPaymentRequestId();
      const request = await db.createPaymentRequestForUser(id, req.user, 'premium_voice', { now: now() });
      return res.status(request.id === id ? 201 : 200).json({ request: publicPaymentRequest(request) });
    } catch (error) { return next(error); }
  });

  router.get('/api/v1/payments/requests', auth, async (req, res, next) => {
    if (String(req.query.product || '') !== 'premium_voice') {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Некорректный тариф заявки.' } });
    }
    try {
      const [request, access] = await Promise.all([
        db.getPaymentRequestForUser(req.user, 'premium_voice'),
        db.getVoiceTutorAccess(req.user, voiceTutorLimits, now()),
      ]);
      return res.json({ request: publicPaymentRequest(request), entitlement_active: access.entitlements.voice_tutor });
    } catch (error) { return next(error); }
  });

  router.get('/api/v1/admin/payment-requests', auth, requireRole('admin'), async (req, res, next) => {
    if (String(req.query.product || '') !== 'premium_voice' || String(req.query.status || '') !== 'new') {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Некорректный фильтр заявок.' } });
    }
    try {
      const requests = await db.listPaymentRequests({ product: 'premium_voice', status: 'new' });
      return res.json({ requests: requests.map((request) => ({
        id: request.id, username: request.username, product: request.product || 'base', status: request.status,
      })) });
    } catch (error) { return next(error); }
  });

  router.post('/api/v1/admin/payment-requests/:requestId/resolve', auth, requireRole('admin'), async (req, res, next) => {
    const decision = req.body?.decision;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(req.params.requestId)
      || !req.body || typeof req.body !== 'object' || Array.isArray(req.body)
      || Object.keys(req.body).length !== 1 || !['approved', 'rejected'].includes(decision)) {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Некорректное решение по оплате.' } });
    }
    try {
      const actor = await db.getUser(req.user);
      if (actor?.telegram_id == null) return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Недостаточно прав.' } });
      const result = await db.resolvePaymentRequest(
        req.params.requestId, decision, actor.telegram_id, premiumSubscriptionDays, { now: now() },
      );
      return res.json({
        applied: result.applied,
        request: { id: req.params.requestId, product: result.product || 'base', status: result.status },
        sub_until: result.sub_until,
      });
    } catch (error) {
      if (error?.message === 'PAYMENT_REQUEST_NOT_FOUND') {
        return res.status(404).json({ error: { code: 'PAYMENT_REQUEST_NOT_FOUND', message: 'Заявка не найдена.' } });
      }
      if (error?.message === 'PAYMENT_SELF_APPROVAL_FORBIDDEN') {
        return res.status(403).json({ error: { code: 'PAYMENT_SELF_APPROVAL_FORBIDDEN', message: 'Нельзя подтверждать собственную заявку.' } });
      }
      return next(error);
    }
  });

  router.post('/api/v1/admin/users/:username/entitlements/voice_tutor/revoke', auth, requireRole('admin'), async (req, res, next) => {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body) || Object.keys(req.body).length !== 0
      || !/^[A-Za-zА-Яа-яЁё0-9_]{1,64}$/u.test(req.params.username)) {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Некорректный запрос отзыва Premium.' } });
    }
    try {
      const actor = await db.getUser(req.user);
      if (actor?.telegram_id == null) return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Недостаточно прав.' } });
      const revoked = await db.revokeEntitlement(req.params.username, 'voice_tutor', actor.telegram_id, { now: now() });
      return res.json({ revoked });
    } catch (error) { return next(error); }
  });

  router.get('/api/v1/admin/status', auth, requireRole('admin'), (req, res) => {
    res.json({ status: 'ok', role: req.role });
  });

  router.get('/api/v1/admin/metrics', auth, requireRole('admin'), async (req, res, next) => {
    try {
      res.setHeader('Cache-Control', 'no-store');
      res.json(await buildMonitoringSnapshot());
    } catch (error) { next(error); }
  });

  router.get('/internal/metrics', monitoringAuth, async (req, res, next) => {
    try {
      res.setHeader('Cache-Control', 'no-store');
      res.json(await buildMonitoringSnapshot());
    } catch (error) { next(error); }
  });

  // Logging out revokes the session server-side, so a stolen cookie stops working too.
  router.post('/api/v1/logout', async (req, res, next) => {
    try {
      const token = readCookie(req, 'eb_token') || String(req.headers.authorization || '').replace(/^Bearer\s+/u, '');
      if (token) {
        try {
          const claims = jwt.verify(token, secret);
          if (claims.sid && claims.u) await db.revokeSession(claims.sid, claims.u);
        } catch (error) { /* expired or invalid cookies are cleared as well */ }
      }
      clearAuthCookie(req, res);
      res.json({ ok: true });
    } catch (error) { next(error); }
  });

  router.get('/api/v1/account/export', auth, async (req, res, next) => {
    try {
      const data = await db.exportUserData(req.user);
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Disposition', 'attachment; filename="easyboost-data.json"');
      res.json(data);
    } catch (error) { next(error); }
  });

  router.delete('/api/v1/account', auth, async (req, res, next) => {
    try {
      if (req.body?.confirmation !== 'DELETE') {
        return res.status(400).json({ error: { code: 'CONFIRMATION_REQUIRED', message: 'Подтвердите удаление аккаунта.' } });
      }
      await db.deleteUserData(req.user);
      clearAuthCookie(req, res);
      res.json({ ok: true });
    } catch (error) { next(error); }
  });

  router.get('/api/v1/privacy/consent', auth, async (req, res, next) => {
    try { res.json({ ...(await db.getPrivacyConsent(req.user)), current_policy_version: privacyPolicyVersion }); }
    catch (error) { next(error); }
  });

  router.put('/api/v1/privacy/consent', auth, async (req, res, next) => {
    try {
      const body = req.body;
      if (!body || typeof body !== 'object' || typeof body.text_processing !== 'boolean' || typeof body.voice_processing !== 'boolean') {
        return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Укажите согласие на обработку текста и голоса.' } });
      }
      res.json(await db.setPrivacyConsent(req.user, {
        text_processing: body.text_processing,
        voice_processing: body.voice_processing,
        policy_version: privacyPolicyVersion,
      }));
    } catch (error) { next(error); }
  });

  return router;
}
