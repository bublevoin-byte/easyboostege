import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';

import { createAdaptiveLearningRoutes } from '../routes/adaptive-learning.js';
import { createProgressRoutes } from '../routes/progress.js';
import { createFileRepository } from '../storage/file-repository.js';
import { buildAdaptiveDetailedReport } from '../adaptive-learning/report.js';
import { completeShortAdaptiveDiagnostic } from './support/adaptive-diagnostic-public.js';

const NOW = new Date('2026-08-12T09:00:00.000Z');

function authentication() {
  return { auth(req, res, next) {
    const username = String(req.headers['x-test-user'] || '');
    if (!username) return res.status(401).json({ error: { code: 'AUTH_REQUIRED' } });
    req.user = username;
    next();
  } };
}

async function withCommercialApp(run) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-adaptive-commercial-'));
  const repository = createFileRepository(path.join(directory, 'data.json'));
  const free = await repository.createTelegramUser(9901, 'Adaptive Free');
  const base = await repository.createTelegramUser(9902, 'Adaptive Base');
  const premium = await repository.createTelegramUser(9903, 'Adaptive Premium');
  await repository.grantDays(9902, 30, base);
  await repository.grantDays(9903, 30, premium);
  await repository.setEntitlement(premium, 'voice_tutor', {
    startsAt: new Date('2026-08-01T00:00:00.000Z'),
    endsAt: new Date('2026-09-01T00:00:00.000Z'),
  });

  const app = express();
  app.use(express.json());
  app.use(createProgressRoutes({
    authentication: authentication(), db: repository, now: () => new Date(NOW),
  }));
  app.use(createAdaptiveLearningRoutes({
    authentication: authentication(), db: repository, enabled: true, now: () => new Date(NOW),
    executionTokenSecret: 'adaptive-commercial-test-secret-32-characters',
  }));
  app.use((error, req, res, next) => res.status(500).json({
    error: { code: error.code || error.message || 'INTERNAL_ERROR' },
  }));
  const server = http.createServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const request = (username, pathname, options = {}) => fetch(
    `http://127.0.0.1:${server.address().port}${pathname}`,
    { ...options, headers: {
      'Content-Type': 'application/json', 'X-Test-User': username, ...(options.headers || {}),
    } },
  );
  try { await run({ repository, free, base, premium, request }); }
  finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await repository.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
}

async function saveGoal(request, username, suffix) {
  return request(username, '/api/v1/adaptive-learning/goal', {
    method: 'PUT', headers: { 'Idempotency-Key': `commercial-goal-${suffix}-0001` },
    body: JSON.stringify({
      targetExam: 'ege_english', targetScore: 85,
      examDate: '2027-06-01', weeklyMinutes: 300,
    }),
  });
}

async function createSession(request, username, durationMinutes, suffix) {
  const previewResponse = await request(username, '/api/v1/adaptive-learning/sessions/preview', {
    method: 'POST', body: JSON.stringify({ durationMinutes }),
  });
  assert.equal(previewResponse.status, 200);
  const preview = (await previewResponse.json()).preview;
  const createdResponse = await request(username, '/api/v1/adaptive-learning/sessions', {
    method: 'POST', headers: { 'Idempotency-Key': `commercial-create-${suffix}-0001` },
    body: JSON.stringify({ durationMinutes, previewFingerprint: preview.previewFingerprint }),
  });
  assert.equal(createdResponse.status, 201);
  return (await createdResponse.json()).session;
}

async function completeSingleBlockSession(request, username, session, suffix) {
  assert.equal(session.blocks.length, 1);
  const block = session.blocks[0];
  assert.equal(block.kind, 'learning');
  const startResponse = await request(username, `/api/v1/adaptive-learning/sessions/${session.id}/start`, {
    method: 'POST', headers: { 'Idempotency-Key': `commercial-start-${suffix}-0001` },
    body: JSON.stringify({ blockId: block.id, expectedRevision: 0 }),
  });
  assert.equal(startResponse.status, 201);
  const started = await startResponse.json();
  const attemptId = crypto.randomUUID();
  const attempt = await request(username, '/api/v1/module-attempts', {
    method: 'POST', body: JSON.stringify({
      id: attemptId, module: block.module, activity: block.activityId,
      score: 1, maxScore: 1, durationMs: 60_000,
      adaptiveExecutionClaim: started.executionClaim,
    }),
  });
  assert.equal(attempt.status, 201);
  const advance = await request(username, `/api/v1/adaptive-learning/sessions/${session.id}/advance`, {
    method: 'POST', headers: { 'Idempotency-Key': `commercial-advance-${suffix}-0001` },
    body: JSON.stringify({
      blockId: block.id, expectedRevision: started.execution.revision,
      attempt: { type: 'module', id: attemptId },
    }),
  });
  const advanced = await advance.json();
  assert.equal(advance.status, 200, JSON.stringify(advanced));
  const finish = await request(username, `/api/v1/adaptive-learning/sessions/${session.id}/finish`, {
    method: 'POST', headers: { 'Idempotency-Key': `commercial-finish-${suffix}-0001` },
    body: JSON.stringify({ expectedRevision: advanced.execution.revision }),
  });
  assert.equal(finish.status, 200);
  return finish.json();
}

test('server enforces Free demo, Base continuous plan and Premium depth at every public boundary', async () => {
  await withCommercialApp(async ({ free, base, premium, request }) => {
    for (const [username, suffix] of [[free, 'free'], [base, 'base'], [premium, 'premium']]) {
      assert.equal((await saveGoal(request, username, suffix)).status, 201);
    }

    for (const username of [free, base, premium]) {
      const blocked = await request(username, '/api/v1/adaptive-learning/sessions/preview', {
        method: 'POST', body: JSON.stringify({ durationMinutes: 15 }),
      });
      assert.equal(blocked.status, 409);
      assert.equal((await blocked.json()).error.code, 'ADAPTIVE_INITIAL_DIAGNOSTIC_REQUIRED');
    }
    await completeShortAdaptiveDiagnostic(request, free, 'commercial-free');
    await completeShortAdaptiveDiagnostic(request, base, 'commercial-base');

    const freeOverview = await (await request(free, '/api/v1/adaptive-learning/overview')).json();
    assert.deepEqual({
      tier: freeOverview.access.tier,
      shortDiagnostic: freeOverview.access.capabilities.shortDiagnostic,
      demoSession: freeOverview.access.capabilities.demoSession,
      continuousPlan: freeOverview.access.capabilities.continuousPlan,
      arbitrarySessions: freeOverview.access.capabilities.arbitrarySessions,
      detailedReports: freeOverview.access.capabilities.detailedReports,
      demoSessionUsed: freeOverview.access.usage.demoSessionUsed,
    }, {
      tier: 'free', shortDiagnostic: false, demoSession: true, continuousPlan: false,
      arbitrarySessions: false, detailedReports: false, demoSessionUsed: false,
    });
    const freeLong = await request(free, '/api/v1/adaptive-learning/sessions/preview', {
      method: 'POST', body: JSON.stringify({ durationMinutes: 30 }),
    });
    assert.equal(freeLong.status, 403);
    assert.equal((await freeLong.json()).error.code, 'ADAPTIVE_BASE_REQUIRED');

    const freeSession = await createSession(request, free, 15, 'free');
    const freeFinal = await completeSingleBlockSession(request, free, freeSession, 'free');
    assert.equal(freeFinal.summary.completedLearningBlocks, 1);
    const exhaustedPreview = await request(free, '/api/v1/adaptive-learning/sessions/preview', {
      method: 'POST', body: JSON.stringify({ durationMinutes: 15 }),
    });
    assert.equal(exhaustedPreview.status, 403);
    assert.equal((await exhaustedPreview.json()).error.code, 'ADAPTIVE_FREE_DEMO_USED');
    const lockedGoal = await request(free, '/api/v1/adaptive-learning/goal', {
      method: 'PUT', headers: { 'Idempotency-Key': 'commercial-goal-free-after-demo' },
      body: JSON.stringify({
        targetExam: 'ege_english', targetScore: 90,
        examDate: '2027-06-01', weeklyMinutes: 420,
      }),
    });
    assert.equal(lockedGoal.status, 403);
    assert.equal((await lockedGoal.json()).error.code, 'ADAPTIVE_BASE_REQUIRED');

    assert.equal((await request(base, '/api/v1/adaptive-learning/sessions/preview', {
      method: 'POST', body: JSON.stringify({ durationMinutes: 90 }),
    })).status, 200);
    const baseReport = await request(base, '/api/v1/adaptive-learning/reports/detailed');
    assert.equal(baseReport.status, 403);
    assert.equal((await baseReport.json()).error.code, 'ADAPTIVE_PREMIUM_REQUIRED');
    const baseDeep = await request(base, '/api/v1/adaptive-learning/diagnostics/start', {
      method: 'POST', headers: { 'Idempotency-Key': 'commercial-base-deep-diagnostic' },
      body: JSON.stringify({ depth: 'deep' }),
    });
    assert.equal(baseDeep.status, 403);

    const premiumDeep = await request(premium, '/api/v1/adaptive-learning/diagnostics/start', {
      method: 'POST', headers: { 'Idempotency-Key': 'commercial-premium-deep-diagnostic' },
      body: JSON.stringify({ depth: 'deep' }),
    });
    assert.equal(premiumDeep.status, 201);
    const deep = await premiumDeep.json();
    assert.equal(deep.diagnostic.catalogVersion, 'ege-deep-diagnostic-v1');
    assert.equal(deep.diagnostic.depth, 'deep');
    assert.ok(deep.diagnostic.estimatedMinutes > 15);

    const premiumReport = await request(premium, '/api/v1/adaptive-learning/reports/detailed');
    assert.equal(premiumReport.status, 200);
    const report = await premiumReport.json();
    assert.equal(report.report.version, 'adaptive-detailed-report-v1');
    assert.equal(report.report.secondaryOrientation.approximate, true);
    assert.equal(report.report.secondaryOrientation.officialIeltsResult, false);
    assert.match(report.report.secondaryOrientation.disclaimer, /не является официальным/u);
  });
});

test('concurrent Free creates persist one demo and preserve its exact replay', async () => {
  await withCommercialApp(async ({ repository, free, request }) => {
    assert.equal((await saveGoal(request, free, 'free-race')).status, 201);
    await completeShortAdaptiveDiagnostic(request, free, 'commercial-free-race');
    const previewResponse = await request(free, '/api/v1/adaptive-learning/sessions/preview', {
      method: 'POST', body: JSON.stringify({ durationMinutes: 15 }),
    });
    const preview = (await previewResponse.json()).preview;
    const body = JSON.stringify({
      durationMinutes: 15, previewFingerprint: preview.previewFingerprint,
    });
    const responses = await Promise.all(['race-a', 'race-b'].map((suffix) => request(
      free, '/api/v1/adaptive-learning/sessions', {
        method: 'POST', headers: { 'Idempotency-Key': `commercial-free-${suffix}-0001` }, body,
      },
    )));
    assert.deepEqual(responses.map((response) => response.status).sort(), [201, 403]);
    const winnerIndex = responses.findIndex((response) => response.status === 201);
    const winnerKey = `commercial-free-${winnerIndex === 0 ? 'race-a' : 'race-b'}-0001`;
    const replay = await request(free, '/api/v1/adaptive-learning/sessions', {
      method: 'POST', headers: { 'Idempotency-Key': winnerKey }, body,
    });
    assert.equal(replay.status, 200);
    assert.equal((await replay.json()).replayed, true);
    assert.equal((await repository.getAdaptiveLearningCommercialUsage(free)).sessionsCreated, 1);
  });
});

test('detailed report is bounded and never copies learner content or source references', () => {
  const entries = Array.from({ length: 14 }, (_, index) => ({
    session: {
      id: crypto.randomUUID(), status: 'completed', completedAt: NOW.toISOString(),
      durationMinutes: 15, planRevision: index + 1,
    },
    summary: {
      completedLearningBlocks: 1, plannedLearningMinutes: 15,
      actualLearningMinutes: 1, actualMinutesComplete: true,
      completedWork: [{
        module: 'listening', skillId: 'ege.listening.detail', activityLabel: 'Детали',
        plannedMinutes: 15, actualMinutes: 1, evidenceQuality: 'server_verified_unassisted',
        evidenceContext: 'planned_practice', sourceRef: 'private-attempt',
        learnerAnswer: 'must-not-leak', prompt: 'must-not-leak',
      }],
    },
  }));
  const report = buildAdaptiveDetailedReport({
    entries, profile: {}, plan: null, generatedAt: NOW,
    orientation: {
      version: 'adaptive-language-orientation-v1', approximate: true,
      officialIeltsResult: false, disclaimer: 'not official',
      cefr: { range: 'B1–B2', lower: 'B1', upper: 'B2' },
      ielts: { range: '4.5–5.5' },
      basis: {
        independentlyEstablishedSkills: 4, totalSkills: 12, confidence: 50,
        assistedEvidenceDoesNotEstablishLevel: true,
      },
    },
  });
  assert.equal(report.sessions.length, 12);
  assert.equal(report.modules[0].completedBlocks, 12);
  assert.equal(report.modules[0].independentEvidence, 12);
  assert.equal(JSON.stringify(report).includes('must-not-leak'), false);
  assert.equal(JSON.stringify(report).includes('private-attempt'), false);
});

test('commercial plan UI has complete labelled controls, paywall, accessible reports and responsive entries', async () => {
  const [markup, screen] = await Promise.all([
    fs.readFile(new URL('../public/index.html', import.meta.url), 'utf8'),
    fs.readFile(new URL('../public/screens/progress.js', import.meta.url), 'utf8'),
  ]);
  assert.doesNotMatch(markup, /id="(?:home|profile)_adaptive_plan"[^>]*onclick=/u);
  assert.match(markup, /<h2[^>]*id="adaptive_plan_title"[^>]*tabindex="-1"/u);
  assert.match(markup, /id="adaptive_goal_errors"[^>]*role="alert"[^>]*aria-live="assertive"/u);
  for (const duration of [15, 30, 45, 60, 90]) {
    assert.match(markup, new RegExp(`name="adaptive_session_duration" value="${duration}"`, 'u'));
  }
  assert.match(markup, /id="adaptive_session_custom"[^>]*step="5"/u);
  assert.match(markup, /id="adaptive_upgrade"/u);
  assert.match(markup, /id="adaptive_detailed_report"/u);
  assert.match(markup, /<table[^>]*id="adaptive_report_table"/u);
  assert.match(markup, /@media\(max-width:430px\)[\s\S]*\.adaptive-plan/u);
  assert.match(markup, /@media\(min-width:768px\)[\s\S]*\.adaptive-report/u);
  assert.match(markup, /\.adaptive-action[^{]*\{[^}]*min-height:44px/u);
  assert.match(markup, /@media\(prefers-reduced-motion:reduce\)/u);
  assert.doesNotMatch(markup, /name="adaptive_(?:module|skill)_percentage"/u);
  assert.match(screen, /ADAPTIVE_FREE_DEMO_USED/u);
  assert.match(screen, /ADAPTIVE_BASE_REQUIRED/u);
  assert.match(screen, /\['home_adaptive_plan','profile_adaptive_plan'\]/u);
  assert.match(markup, /id="home_adaptive_plan"[^>]*hidden/u);
  assert.match(markup, /id="profile_adaptive_plan"[^>]*hidden/u);
  assert.match(markup, /\.adaptive-entry\[hidden\],#profile_adaptive_plan\[hidden\]\{display:none!important\}/u);
  assert.match(screen, /registerStartHook\(syncAdaptivePlanEntries\)/u);
  assert.match(screen, /features\?\.adaptive_learning===true/u);
  assert.doesNotMatch(screen, /writeAdaptiveOverviewCache\(localStorage,adaptiveOverviewOwner\(\),saved\)/u);
  assert.match(screen, /destination\.focus/u);
  assert.match(screen, /apiGet\('\/api\/v1\/adaptive-learning\/reports\/detailed'\)/u);
  assert.match(screen, /примерн/u);
  assert.match(screen, /неофициальн/u);
});

test('production facade wires every commercial repository boundary used by routes', async () => {
  const [facade, server] = await Promise.all([
    fs.readFile(new URL('../db.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../server.js', import.meta.url), 'utf8'),
  ]);
  for (const method of [
    'getAdaptiveLearningSessionCommercialScope',
    'getAdaptiveLearningCommercialUsage',
    'getAdaptiveLearningCompletedSessionReports',
  ]) {
    assert.match(facade, new RegExp(`export const ${method} =`, 'u'));
    assert.match(server, new RegExp(`\\b${method}\\b`, 'u'));
  }
});
