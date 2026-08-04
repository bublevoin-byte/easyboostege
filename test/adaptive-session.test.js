import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';

import {
  ADAPTIVE_ACTIVITY_REGISTRY,
  ADAPTIVE_SESSION_COMPOSER_POLICY_VERSION,
  buildAdaptiveSessionPreview,
  isAdaptiveSessionDuration,
} from '../adaptive-learning/session.js';
import { EGE_SKILL_TAXONOMY } from '../adaptive-learning/profile.js';
import { createAdaptiveLearningRoutes } from '../routes/adaptive-learning.js';
import { createFileRepository } from '../storage/file-repository.js';
import { assertAdaptiveSessionRepositoryContract } from './support/adaptive-session-contract.js';

const NOW = new Date('2026-08-05T09:30:00.000Z');

function plan() {
  return {
    id: '71000000-0000-4000-8000-000000000001', revision: 3,
    version: 'adaptive-plan-v1', taxonomyVersion: 'ege-en-v1',
    allocation: {
      skills: EGE_SKILL_TAXONOMY.skills.map((skill, index) => ({
        id: skill.id, label: skill.label, module: skill.module,
        percentage: [12, 8, 12, 8, 8, 12, 15, 20, 1, 1, 1, 2][index],
        activityType: skill.id === 'ege.grammar.forms' ? 'retention_review' : 'practice',
        reasonCodes: skill.id === 'ege.grammar.forms' ? ['due_review', 'target_gap'] : ['target_gap'],
      })),
    },
  };
}

function goal() {
  return { weekly_minutes: 300 };
}

test('composer accepts only 15-120 five-minute durations and accounts for breaks exactly', () => {
  for (const duration of Array.from({ length: 22 }, (_, index) => 15 + index * 5)) {
    assert.equal(isAdaptiveSessionDuration(duration), true);
    const preview = buildAdaptiveSessionPreview({
      plan: plan(), goal: goal(), weekUsage: [], durationMinutes: duration, now: NOW,
    });
    assert.equal(preview.composerPolicyVersion, ADAPTIVE_SESSION_COMPOSER_POLICY_VERSION);
    assert.equal(preview.blocks.reduce((sum, block) => sum + block.plannedMinutes, 0), duration);
    assert.equal(preview.learningMinutes + preview.breakMinutes, duration);
    assert.equal(preview.blocks.some((block) => block.kind === 'break'), duration > 60);
    assert.ok(preview.blocks.filter((block) => block.kind === 'learning')
      .every((block) => block.plannedMinutes >= ADAPTIVE_ACTIVITY_REGISTRY.activities
        .find((activity) => activity.contentRef === block.contentRef).minimumMinutes
        && block.plannedMinutes <= 30));
  }
  for (const duration of [0, 14, 16, 61, 121, '30']) {
    assert.equal(isAdaptiveSessionDuration(duration), false);
  }
});

test('composer uses a rolling UTC-week deficit, prioritizes due work and stays deterministic', () => {
  const input = {
    plan: plan(), goal: goal(), durationMinutes: 45, now: NOW,
    weekUsage: [{ skillId: 'ege.listening.detail', plannedMinutes: 58, completedMinutes: 20 }],
  };
  const first = buildAdaptiveSessionPreview(input);
  const second = buildAdaptiveSessionPreview(structuredClone(input));
  assert.deepEqual(second, first);
  assert.equal(first.weekStart, '2026-08-03T00:00:00.000Z');
  assert.equal(first.blocks.find((block) => block.kind === 'learning').skillId, 'ege.grammar.forms');
  assert.ok(first.blocks.some((block) => block.reasonCodes.includes('weekly_budget_deficit')));
  assert.notEqual(
    first.blocks.filter((block) => block.skillId === 'ege.listening.detail')
      .reduce((sum, block) => sum + block.plannedMinutes, 0),
    Math.round(first.learningMinutes * 0.2),
    'a weekly 20% allocation must not be copied rigidly into one session',
  );
  assert.ok(first.blocks.every((block, index, blocks) => (
    block.kind === 'break' || index === 0 || blocks[index - 1].kind === 'break'
      || block.module !== blocks[index - 1].module
  )));
});

test('composer reports a coverage gap instead of inventing a route when eligible content is unavailable', () => {
  assert.throws(() => buildAdaptiveSessionPreview({
    plan: plan(), goal: goal(), weekUsage: [], durationMinutes: 30, now: NOW,
    registry: { ...ADAPTIVE_ACTIVITY_REGISTRY, activities: [] },
  }), (error) => error?.code === 'ADAPTIVE_SESSION_COVERAGE_GAP');
});

function authentication() {
  return { auth(req, res, next) {
    const username = String(req.headers['x-test-user'] || '');
    if (!username) return res.status(401).json({ error: { code: 'UNAUTHORIZED' } });
    req.user = username;
    next();
  } };
}

async function withApp(run, { registry } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-session-api-'));
  const repository = createFileRepository(path.join(directory, 'data.json'));
  const owner = await repository.createTelegramUser(9401, 'Session Owner');
  const stranger = await repository.createTelegramUser(9402, 'Session Stranger');
  await repository.grantDays(9401, 30, owner);
  const app = express();
  app.use(express.json());
  app.use(createAdaptiveLearningRoutes({
    authentication: authentication(), db: repository, enabled: true, now: () => new Date(NOW),
    executionTokenSecret: 'adaptive-test-token-secret-32-characters',
    activityRegistry: registry,
  }));
  app.use((error, req, res, next) => res.status(500).json({ error: { code: error.message } }));
  const server = http.createServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const request = (username, pathname, options = {}) => fetch(
    `http://127.0.0.1:${server.address().port}${pathname}`,
    { ...options, headers: {
      'Content-Type': 'application/json',
      ...(username ? { 'X-Test-User': username } : {}),
      ...(options.headers || {}),
    } },
  );
  try { await run({ repository, owner, stranger, request }); }
  finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await repository.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
}

async function saveGoal(request, owner) {
  const response = await request(owner, '/api/v1/adaptive-learning/goal', {
    method: 'PUT', headers: { 'Idempotency-Key': 'adaptive-session-goal-0001' },
    body: JSON.stringify({
      targetExam: 'ege_english', targetScore: 85, examDate: '2027-06-01', weeklyMinutes: 300,
    }),
  });
  assert.equal(response.status, 201);
  return response.json();
}

test('authenticated session API previews, creates, restores and replaces exactly once', async () => {
  await withApp(async ({ repository, owner, stranger, request }) => {
    assert.equal((await request('', '/api/v1/adaptive-learning/sessions/preview', {
      method: 'POST', body: JSON.stringify({ durationMinutes: 45 }),
    })).status, 401);
    await saveGoal(request, owner);

    const invalid = await request(owner, '/api/v1/adaptive-learning/sessions/preview', {
      method: 'POST', body: JSON.stringify({ durationMinutes: 46, extra: true }),
    });
    assert.equal(invalid.status, 400);

    const previewResponse = await request(owner, '/api/v1/adaptive-learning/sessions/preview', {
      method: 'POST', body: JSON.stringify({ durationMinutes: 90 }),
    });
    assert.equal(previewResponse.status, 200);
    const preview = (await previewResponse.json()).preview;
    assert.equal(preview.blocks.some((block) => block.kind === 'break'), true);
    assert.ok(preview.blocks.filter((block) => block.kind === 'learning')
      .every((block) => /^scr(?:2|3|4|7|8|9)$/u.test(block.launch.screenId)));

    const stalePreview = await request(owner, '/api/v1/adaptive-learning/sessions', {
      method: 'POST', headers: { 'Idempotency-Key': 'adaptive-session-create-tamper-01' },
      body: JSON.stringify({ durationMinutes: 90, previewFingerprint: 'a'.repeat(64) }),
    });
    assert.equal(stalePreview.status, 409);
    assert.equal((await stalePreview.json()).error.code, 'ADAPTIVE_SESSION_PREVIEW_STALE');

    const createKey = 'adaptive-session-create-0001';
    const createBody = { durationMinutes: 90, previewFingerprint: preview.previewFingerprint };
    const createdResponse = await request(owner, '/api/v1/adaptive-learning/sessions', {
      method: 'POST', headers: { 'Idempotency-Key': createKey }, body: JSON.stringify(createBody),
    });
    assert.equal(createdResponse.status, 201);
    const created = await createdResponse.json();
    assert.equal(created.created, true);
    assert.equal(created.session.planRevision, preview.planRevision);
    assert.equal(created.session.status, 'created');

    const replay = await request(owner, '/api/v1/adaptive-learning/sessions', {
      method: 'POST', headers: { 'Idempotency-Key': createKey }, body: JSON.stringify(createBody),
    });
    assert.equal(replay.status, 200);
    assert.deepEqual((await replay.json()).session, created.session);
    const changedReplay = await request(owner, '/api/v1/adaptive-learning/sessions', {
      method: 'POST', headers: { 'Idempotency-Key': createKey },
      body: JSON.stringify({ durationMinutes: 60, previewFingerprint: preview.previewFingerprint }),
    });
    assert.equal(changedReplay.status, 409);

    const current = await (await request(owner, '/api/v1/adaptive-learning/sessions/current')).json();
    assert.equal(current.session.id, created.session.id);
    assert.equal((await request(stranger, '/api/v1/adaptive-learning/sessions/current')).status, 404);

    const learningBlock = created.session.blocks.filter((block) => block.kind === 'learning')
      .sort((left, right) => right.difficulty - left.difficulty)[0];
    const replacementKey = 'adaptive-session-replace-0001';
    const replacementPath = `/api/v1/adaptive-learning/sessions/${created.session.id}/replace`;
    const replacementBody = { blockId: learningBlock.id, reason: 'excluded' };
    assert.equal((await request(owner, replacementPath, {
      method: 'POST', headers: { 'Idempotency-Key': 'adaptive-session-replace-tamper-01' },
      body: JSON.stringify({ blockId: 'asb_0000000000000000_99', reason: 'excluded' }),
    })).status, 404);
    assert.equal((await request(owner, '/api/v1/adaptive-learning/sessions/not-a-session/replace', {
      method: 'POST', headers: { 'Idempotency-Key': 'adaptive-session-replace-tamper-02' },
      body: JSON.stringify(replacementBody),
    })).status, 400);
    const replacedResponse = await request(owner, replacementPath, {
      method: 'POST', headers: { 'Idempotency-Key': replacementKey }, body: JSON.stringify(replacementBody),
    });
    assert.equal(replacedResponse.status, 200);
    const replaced = await replacedResponse.json();
    assert.equal(replaced.replaced, true);
    assert.equal(replaced.session.replacement.reason, 'excluded');
    assert.ok(replaced.session.blocks.find((block) => block.id === learningBlock.id)
      .reasonCodes.includes('learner_exclusion'));
    assert.equal(replaced.session.blocks.reduce((sum, block) => sum + block.plannedMinutes, 0), 90);
    assert.deepEqual(replaced.session.blocks.map((block) => block.id), created.session.blocks.map((block) => block.id));
    assert.notEqual(replaced.session.blocks.find((block) => block.id === learningBlock.id).contentRef,
      learningBlock.contentRef);

    const replacementReplay = await request(owner, replacementPath, {
      method: 'POST', headers: { 'Idempotency-Key': replacementKey }, body: JSON.stringify(replacementBody),
    });
    assert.deepEqual((await replacementReplay.json()).session, replaced.session);
    assert.equal((await request(owner, replacementPath, {
      method: 'POST', headers: { 'Idempotency-Key': 'adaptive-session-replace-0002' },
      body: JSON.stringify({ blockId: learningBlock.id, reason: 'not_relevant' }),
    })).status, 409);
    assert.equal((await request(stranger, replacementPath, {
      method: 'POST', headers: { 'Idempotency-Key': 'adaptive-session-replace-0003' },
      body: JSON.stringify(replacementBody),
    })).status, 404);

    const exported = await repository.exportUserData(owner);
    assert.equal(exported.adaptive_learning_sessions.length, 1);
    assert.equal(JSON.stringify(exported).includes('learnerAnswer'), false);
  });
});

test('session API returns a typed coverage response when no content can be composed', async () => {
  await withApp(async ({ owner, request }) => {
    await saveGoal(request, owner);
    const response = await request(owner, '/api/v1/adaptive-learning/sessions/preview', {
      method: 'POST', body: JSON.stringify({ durationMinutes: 30 }),
    });
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: { code: 'ADAPTIVE_SESSION_COVERAGE_GAP' } });
  }, { registry: { ...ADAPTIVE_ACTIVITY_REGISTRY, activities: [] } });
});

test('file repository matches the adaptive session replay, race, export and deletion contract', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-session-file-'));
  const repository = createFileRepository(path.join(directory, 'data.json'));
  const username = await repository.createTelegramUser(9499, 'Session Contract');
  try {
    await assertAdaptiveSessionRepositoryContract(assert, repository, username);
    assert.equal(await repository.deleteUserData(username), true);
    assert.equal(await repository.getCurrentAdaptiveLearningSession(username), null);
  } finally {
    await repository.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('progress screen exposes accessible duration, preview, replacement and real handoff controls', async () => {
  const [html, source, apiSource] = await Promise.all([
    fs.readFile(new URL('../public/index.html', import.meta.url), 'utf8'),
    fs.readFile(new URL('../public/screens/progress.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../public/api.js', import.meta.url), 'utf8'),
  ]);
  for (const duration of [15, 30, 45, 60, 90]) {
    assert.match(html, new RegExp(`value="${duration}"`, 'u'));
  }
  assert.match(html, /id="adaptive_session_custom"[^>]*min="15"[^>]*max="120"[^>]*step="5"/u);
  assert.match(html, /id="adaptive_session_preview"/u);
  assert.match(html, /id="adaptive_session_blocks"[^>]*aria-live="polite"/u);
  assert.match(source, /adaptive-learning\/sessions\/preview/u);
    assert.match(source, /adaptive-learning\/sessions\/'\+encodeURIComponent\(session\.id\)\+'\/replace/u);
    assert.match(source, /reason:'excluded'/u);
    assert.match(source, /Исключить этот блок/u);
    assert.match(source, /Почему изменить блок\?/u);
    assert.match(source, /reasonLabel\.htmlFor=reason\.id/u);
    assert.match(source, /focusAdaptiveSessionAfterAdjustment\(\)/u);
  assert.match(source, /beginAdaptiveBlock\(session,block,execution\)/u);
  assert.match(source, /advanceAdaptiveBreak\(session,block,execution\)/u);
  assert.match(source, /finishAdaptiveSession\(session,execution\)/u);
  assert.match(source, /summary\.completedWork/u);
  assert.match(source, /adaptiveEvidenceContextLabels/u);
  assert.match(source, /summary\.planChange\.planRevisionBefore/u);
  assert.match(source, /нет точного встроенного задания/u);
  assert.match(apiSource, /ADAPTIVE_SESSION_COVERAGE_GAP/u);
  assert.match(apiSource, /нельзя составить занятие выбранной длительности/u);
});

test('session API, storage and retention contracts are documented', async () => {
  const [openapi, schema, retention] = await Promise.all([
    fs.readFile(new URL('../docs/openapi.yaml', import.meta.url), 'utf8'),
    fs.readFile(new URL('../docs/DATABASE_SCHEMA.md', import.meta.url), 'utf8'),
    fs.readFile(new URL('../docs/DATA_RETENTION.md', import.meta.url), 'utf8'),
  ]);
  for (const endpoint of [
    '/api/v1/adaptive-learning/sessions/preview:',
    '/api/v1/adaptive-learning/sessions:',
    '/api/v1/adaptive-learning/sessions/current:',
    '/api/v1/adaptive-learning/sessions/{sessionId}/replace:',
    '/api/v1/adaptive-learning/sessions/{sessionId}/start:',
    '/api/v1/adaptive-learning/sessions/{sessionId}/bind-attempt:',
    '/api/v1/adaptive-learning/sessions/{sessionId}/advance:',
    '/api/v1/adaptive-learning/sessions/{sessionId}/finish:',
  ]) assert.match(openapi, new RegExp(endpoint.replace(/[{}]/gu, '\\$&'), 'u'));
  assert.match(openapi, /AdaptiveLearningSession:/u);
  assert.match(schema, /034_adaptive_learning_sessions\.sql/u);
  assert.match(schema, /035_adaptive_session_execution\.sql/u);
  assert.match(schema, /036_adaptive_execution_hardening\.sql/u);
  assert.match(schema, /adaptive_learning_sessions/u);
  assert.match(schema, /adaptive_learning_execution_claims/u);
  assert.match(schema, /adaptive_learning_session_events/u);
  assert.match(schema, /vocabulary_practice\|grammar_practice\|exam_workflow/u);
  assert.match(schema, /content_coverage_fallback/u);
  assert.match(retention, /Адаптивные учебные сессии и события исполнения/u);
  assert.match(retention, /не более 2 часов/u);
  assert.match(retention, /30 КБ/u);
  assert.match(retention, /без исходных ответов, эссе, transcript и audio/u);
});
