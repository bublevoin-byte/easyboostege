import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';

import { buildReadingReport, readingReportResponseSchema } from '../reading/report.js';
import { createReadingRoutes } from '../routes/reading.js';
import { createFileRepository } from '../storage/file-repository.js';
import { READING_TASK10_SETS } from '../public/content/reading/task10-v1.js';
import { READING_TASK11_SETS } from '../public/content/reading/task11-v1.js';
import { READING_TASK12_18_SETS } from '../public/content/reading/task12-18-v1.js';
import {
  assertReadingReportRepositoryContract,
  readingReportAttemptMetadata,
} from './support/reading-report-contract.js';

const NOW = new Date('2026-08-06T09:00:00.000Z');
const SETS = Object.freeze({
  task10: READING_TASK10_SETS[0],
  task10b: READING_TASK10_SETS[1],
  task11: READING_TASK11_SETS[0],
  task12_18: READING_TASK12_18_SETS[0],
});

function row({ id = crypto.randomUUID(), set, score, maxScore, createdAt, attemptId = id,
  durationMs = 60_000, metadata = {} }) {
  return {
    id, username: 'owner', module: 'reading',
    activity: set.kind === 'task10' ? 'reading_headings'
      : set.kind === 'task11' ? 'reading_gaps' : 'reading_detail',
    score, max_score: maxScore, duration_ms: durationMs,
    evidence_quality: 'client_reported', created_at: createdAt,
    metadata: { ...readingReportAttemptMetadata(set, attemptId), ...metadata },
  };
}

function fullDetailRow({ attemptId, score, createdAt, durationMs }) {
  return {
    id: crypto.randomUUID(), username: 'owner', module: 'reading', activity: 'reading_detail',
    score, max_score: 13, duration_ms: durationMs, evidence_quality: 'client_reported',
    created_at: createdAt,
    metadata: {
      mode: 'reading_detail', source: 'catalog', helpUsed: false, hintsUsed: 0,
      readingProvenance: 'canonical', readingSetRevision: 1, readingKind: 'full_detail',
      readingCefr: 'mixed', readingContentRef: 'builtin:reading:full:detail:v1',
      readingSetRefs: `${SETS.task11.id}@${SETS.task11.revision}|${SETS.task12_18.id}@${SETS.task12_18.revision}`,
      readingAttemptId: attemptId, readingSlice: 'detail', readingIndependent: true,
    },
  };
}

function reportRows() {
  const fullAttemptId = `reading-full-${crypto.randomUUID()}`;
  const valid = [
    row({ set: SETS.task10, score: 3, maxScore: 7, durationMs: 70_000, createdAt: '2026-08-01T09:00:00.000Z' }),
    row({ set: SETS.task10, score: 4, maxScore: 7, durationMs: 75_000, createdAt: '2026-08-02T09:00:00.000Z' }),
    row({ set: SETS.task11, score: 6, maxScore: 6, durationMs: 90_000,
      createdAt: '2026-08-03T09:00:00.000Z', metadata: { readingIndependent: false, helpUsed: true } }),
    row({ set: SETS.task10b, score: 7, maxScore: 7, durationMs: 420_000,
      createdAt: '2026-08-04T09:00:00.000Z', attemptId: fullAttemptId }),
    fullDetailRow({ attemptId: fullAttemptId, score: 10, durationMs: 780_000,
      createdAt: '2026-08-04T09:00:00.000Z' }),
  ];
  const incompleteId = `reading-full-${crypto.randomUUID()}`;
  const invalid = [
    row({ set: SETS.task10b, score: 7, maxScore: 7, createdAt: '2026-08-05T09:00:00.000Z',
      attemptId: incompleteId }),
    row({ set: SETS.task12_18, score: 7, maxScore: 7, createdAt: '2026-08-05T10:00:00.000Z',
      metadata: { source: 'generated', learnerAnswer: 'must-not-leak' } }),
    { ...valid[0], id: valid[0].id, metadata: { ...valid[0].metadata, learnerAnswer: 'must-not-leak' } },
    { ...valid[1], id: crypto.randomUUID(), metadata: {
      ...valid[1].metadata, readingProvenance: 'technical', learnerAnswer: 'must-not-leak',
    } },
  ];
  return [...valid, ...invalid];
}

test('expanded Reading report uses only deduplicated completed canonical attempts and states evidence limits', () => {
  const report = buildReadingReport({ rows: reportRows(), scope: 'expanded', generatedAt: NOW });
  assert.equal(readingReportResponseSchema.safeParse(report).success, true);
  assert.equal(report.version, 'reading-report-v1');
  assert.equal(report.scope, 'expanded');
  assert.deepEqual(report.evidence, {
    source: 'persisted_canonical_completed_attempts', maximumRows: 120,
    includedRows: 5, includedAttempts: 4, independentAttempts: 3, assistedAttempts: 1, excludedRows: 4,
  });
  assert.deepEqual(report.base.accuracy, { correct: 30, total: 40, percent: 75, sampleSize: 4 });
  assert.equal(report.base.weakestSkill.id, 'ege.reading.gist');
  assert.equal(report.base.recentAttempts.length, 4);
  assert.equal(report.base.recentTrend.state, 'up');
  assert.equal(report.base.recentTrend.recentSampleSize, 2);
  assert.equal(report.base.recentTrend.previousSampleSize, 2);
  assert.match(report.base.recommendation.text, /основн.*содержан/iu);

  assert.deepEqual(report.expanded.skills.map((skill) => [skill.id, skill.correct, skill.total]), [
    ['ege.reading.gist', 14, 21], ['ege.reading.detail', 16, 19],
  ]);
  assert.ok(report.expanded.topics.some((topic) => topic.topic === SETS.task10.topic
    && topic.sampleSize === 2 && topic.confidence !== 'high'));
  assert.ok(report.expanded.cefr.some((level) => level.cefr === SETS.task10.cefr));
  assert.equal(report.expanded.pace.fullSectionSampleSize, 1);
  assert.equal(report.expanded.pace.fullSectionAverageMinutes, 20);
  assert.equal(report.expanded.repeatErrors.state, 'available');
  assert.equal(report.expanded.repeatErrors.sets[0].setId, SETS.task10.id);
  assert.equal(report.expanded.repeatErrors.sets[0].errorAttempts, 2);
  assert.equal(report.expanded.comparison.state, 'available');
  assert.equal(report.expanded.recommendation.timeAllocation[0].skillId, 'ege.reading.gist');
  assert.equal(report.expanded.recommendation.timeAllocation.reduce((sum, item) => sum + item.minutesPer30, 0), 30);
  assert.match(report.expanded.disclosure, /не доказывает освоение/iu);
  assert.match(report.expanded.disclosure, /с поддержкой/iu);
  assert.equal(JSON.stringify(report).includes('must-not-leak'), false);
});

test('Reading report returns explicit insufficient-evidence states without invented conclusions', () => {
  const one = row({ set: SETS.task11, score: 4, maxScore: 6, durationMs: 0,
    createdAt: '2026-08-01T09:00:00.000Z' });
  const report = buildReadingReport({ rows: [one], scope: 'expanded', generatedAt: NOW });
  assert.equal(readingReportResponseSchema.safeParse(report).success, true);
  assert.equal(report.base.recentTrend.state, 'insufficient_evidence');
  assert.equal(report.base.recentTrend.confidence, 'insufficient');
  assert.equal(report.base.weakestSkill, null);
  assert.equal(report.base.recommendation.code, 'complete_skill_coverage');
  assert.equal(report.expanded.repeatErrors.state, 'insufficient_evidence');
  assert.equal(report.expanded.comparison.state, 'insufficient_evidence');
  assert.equal(report.expanded.pace.state, 'insufficient_evidence');
  assert.equal(report.expanded.topics[0].confidence, 'insufficient');
  assert.match(report.expanded.recommendation.text, /недостаточно данных/iu);
  assert.doesNotMatch(JSON.stringify(report), /навык (?:уже )?освоен|доказано мастерство/iu);
});

test('file repository exposes the same bounded owner-isolated Reading attempt seam as PostgreSQL', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-reading-report-repository-'));
  const repository = createFileRepository(path.join(directory, 'data.json'));
  const owner = await repository.createTelegramUser(78001, 'Reading report owner');
  const other = await repository.createTelegramUser(78002, 'Reading report other');
  try { await assertReadingReportRepositoryContract(assert, repository, owner, other, SETS); }
  finally {
    await repository.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

function authentication() {
  return { auth(req, res, next) {
    const username = String(req.headers['x-test-user'] || '');
    if (!username) return res.status(401).json({ error: { code: 'AUTH_REQUIRED' } });
    req.user = username;
    next();
  } };
}

test('single Reading report endpoint keeps Base useful and gates expanded scope on current server entitlement', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-reading-report-route-'));
  const repository = createFileRepository(path.join(directory, 'data.json'));
  const base = await repository.createTelegramUser(78101, 'Reading Base');
  const premium = await repository.createTelegramUser(78102, 'Reading Premium');
  const inactive = await repository.createTelegramUser(78103, 'Reading Inactive');
  const expired = await repository.createTelegramUser(78104, 'Reading Expired Premium');
  await repository.grantDays(78101, 30, base);
  await repository.grantDays(78102, 30, premium);
  await repository.grantDays(78104, 30, expired);
  await repository.setEntitlement(premium, 'voice_tutor', {
    startsAt: new Date('2026-08-01T00:00:00.000Z'), endsAt: new Date('2026-08-20T00:00:00.000Z'),
  });
  await repository.setEntitlement(expired, 'voice_tutor', {
    startsAt: new Date('2026-07-01T00:00:00.000Z'), endsAt: new Date('2026-08-01T00:00:00.000Z'),
  });
  for (const username of [base, premium]) {
    const id = crypto.randomUUID();
    await repository.recordModuleAttempt(username, {
      id, module: 'reading', activity: 'reading_headings', score: 5, maxScore: 7,
      durationMs: 70_000, metadata: readingReportAttemptMetadata(SETS.task10, id),
    });
  }
  const app = express();
  app.use(express.json());
  app.use(createReadingRoutes({
    authentication: authentication(), db: repository, now: () => new Date(NOW),
    voiceTutorLimits: { dailySeconds: 600, monthlySeconds: 7_200, sessionSeconds: 300 },
  }));
  app.use((error, req, res, next) => res.status(500).json({ error: { code: error.message } }));
  const server = http.createServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const request = (username, scope, suffix = '', expectedOwner = username) => fetch(
    `http://127.0.0.1:${server.address().port}/api/v1/reading/report?scope=${scope}${suffix}`,
    { headers: username ? { 'X-Test-User': username, 'X-EasyBoost-Expected-Owner': expectedOwner } : {} },
  );
  try {
    assert.equal((await request('', 'base')).status, 401);
    const baseResponse = await request(base, 'base');
    assert.equal(baseResponse.status, 200);
    assert.equal(baseResponse.headers.get('cache-control'), 'no-store');
    assert.equal(baseResponse.headers.get('x-easyboost-response-owner'), base);
    const baseBody = await baseResponse.json();
    assert.equal(baseBody.scope, 'base');
    assert.equal(Object.hasOwn(baseBody, 'expanded'), false);
    assert.equal(baseBody.base.accuracy.percent, 71);

    const forged = await request(base, 'expanded', '&premium=true&voice_tutor=true');
    assert.equal(forged.status, 403);
    assert.equal((await forged.json()).error.code, 'READING_PREMIUM_REQUIRED');
    const premiumResponse = await request(premium, 'expanded');
    assert.equal(premiumResponse.status, 200);
    assert.equal((await premiumResponse.json()).scope, 'expanded');

    await repository.revokeEntitlement(premium, 'voice_tutor', 999, { now: NOW });
    const revoked = await request(premium, 'expanded');
    assert.equal(revoked.status, 403);
    assert.equal((await revoked.json()).error.code, 'READING_PREMIUM_REQUIRED');
    assert.equal((await request(inactive, 'base')).status, 403);
    const expiredResponse = await request(expired, 'expanded');
    assert.equal(expiredResponse.status, 403);
    assert.equal((await expiredResponse.json()).error.code, 'READING_PREMIUM_REQUIRED');
    assert.equal((await request(base, 'unknown')).status, 400);
    const changedOwner = await request(base, 'base', '', premium);
    assert.equal(changedOwner.status, 409);
    assert.equal((await changedOwner.json()).error.code, 'OWNER_CHANGED');
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await repository.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('Reading report production facade and route wiring stay explicit', async () => {
  const [facade, server] = await Promise.all([
    fs.readFile(new URL('../db.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../server.js', import.meta.url), 'utf8'),
  ]);
  assert.match(facade, /export const getReadingCompletedAttempts =/u);
  assert.match(server, /createReadingRoutes/u);
  assert.match(server, /getReadingCompletedAttempts/u);
});

test('Reading report UI has accessible loading, retry, Premium and non-colour evidence states', async () => {
  const [screen, markup, styles] = await Promise.all([
    fs.readFile(new URL('../public/screens/reading.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../public/index.html', import.meta.url), 'utf8'),
    fs.readFile(new URL('../public/reading-listening.css', import.meta.url), 'utf8'),
  ]);
  assert.match(screen, /apiGet\('\/api\/v1\/reading\/report\?scope='/u);
  assert.match(screen, /aria-live="polite"/u);
  assert.match(screen, /data-reading-action="retry-report"/u);
  assert.match(screen, /Не удалось обновить отчёт/u);
  assert.match(screen, /Статус Premium не изменён/u);
  assert.match(screen, /SUBSCRIPTION_REQUIRED/u);
  assert.match(screen, /Сервер больше не подтверждает активную подписку/u);
  assert.match(screen, /самостоятельн/u);
  assert.match(screen, /insufficient_evidence/u);
  assert.match(screen, /Автоматически проверено/u);
  assert.match(screen, /Формат, ключи, количество элементов и цитаты-доказательства проверены программно/u);
  assert.match(screen, /не официальный вариант ФИПИ и не ручная проверка методистом/u);
  assert.match(screen, /Premium добавляет только/u);
  assert.match(styles, /\.reading-report-action[^\{]*\{[^}]*min-block-size:\s*48px/u);
  assert.match(styles, /\.reading-report-table/u);
  assert.match(styles, /\.reading-expanded-report[^\{]*\{[^}]*display:\s*grid/u);
  assert.match(styles, /\.reading2[^\{]*\{[^}]*inline-size:\s*100%[^}]*max-inline-size:\s*100%/u);
  assert.doesNotMatch(markup, /#frame\.reading-expanded\{[^}]*width:min\(100vw,1100px\)/u);
  assert.match(styles, /@media\s*\(prefers-reduced-motion:\s*reduce\)/u);
  assert.doesNotMatch(screen, /localStorage.*(?:premium|entitlement)|(?:premium|entitlement).*localStorage/iu);
});
