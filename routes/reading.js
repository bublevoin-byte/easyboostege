import express from 'express';
import { bindResponseOwner, requireExpectedOwner } from '../middleware/expected-owner.js';

import {
  buildReadingReport,
  READING_REPORT_MAX_ROWS,
  readingReportResponseSchema,
} from '../reading/report.js';

// One owner-bound API contract serves the useful Base summary and, after a fresh server check,
// the Premium expansion. The client may request a scope; it never supplies the entitlement.
export function createReadingRoutes({
  authentication, db, voiceTutorLimits = {}, now = () => new Date(),
}) {
  const router = express.Router();
  const { auth } = authentication;

  router.get('/api/v1/reading/report', auth, async (req, res, next) => {
    const scope = String(req.query.scope || 'base');
    if (!['base', 'expanded'].includes(scope)) {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Неизвестный вид отчёта Reading.' } });
    }
    if (!requireExpectedOwner(req, res)) return undefined;
    bindResponseOwner(res, req.user);
    try {
      res.setHeader('Cache-Control', 'no-store');
      const subscription = await db.getSub(req.user);
      if (subscription?.active !== true) {
        return res.status(403).json({ error: { code: 'SUBSCRIPTION_REQUIRED', message: 'Для Reading нужен активный доступ.' } });
      }
      if (scope === 'expanded') {
        const access = await db.getVoiceTutorAccess(req.user, voiceTutorLimits, now());
        if (access?.entitlements?.voice_tutor !== true) {
          return res.status(403).json({ error: { code: 'READING_PREMIUM_REQUIRED', message: 'Расширенный отчёт доступен с Premium.' } });
        }
      }
      const rows = await db.getReadingCompletedAttempts(req.user, { limit: READING_REPORT_MAX_ROWS });
      const report = buildReadingReport({ rows, scope, generatedAt: now() });
      const validated = readingReportResponseSchema.safeParse(report);
      if (!validated.success) throw new Error('READING_REPORT_RESPONSE_INVALID');
      return res.json(validated.data);
    } catch (error) { return next(error); }
  });

  return router;
}
