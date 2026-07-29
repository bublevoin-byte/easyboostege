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
}) {
  const router = express.Router();
  const { auth, requireRole, monitoringAuth, issueToken, readCookie, setAuthCookie, clearAuthCookie } = authentication;

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
      res.json({ authenticated: true, username, ...await db.getSub(username), bot: botUsername() });
    } catch (error) { next(error); }
  });

  router.get('/api/v1/me', auth, async (req, res, next) => {
    try {
      const token = req.sessionId ? req.authToken : await issueToken(req.user);
      setAuthCookie(req, res, token);
      res.json({ authenticated: true, username: req.user, role: req.role, bot: botUsername(), ...await db.getSub(req.user) });
    } catch (error) { next(error); }
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
