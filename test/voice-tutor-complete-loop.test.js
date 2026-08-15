import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { persistedVoiceTutorCapsule } from '../voice-tutor/capsule.js';
import { canUseXaiRuleSearch, createXaiRuleSearchProvider } from '../voice-tutor/rule-search.js';
import { createAiTextTutor } from '../voice-tutor/text-fallback.js';
import { createFileRepository } from '../storage/file-repository.js';

const NOW = new Date('2026-08-03T10:00:00.000Z');
const LIMITS = Object.freeze({ dailySeconds: 600, monthlySeconds: 7_200, sessionSeconds: 300 });
const SESSION_ID = 'a04bf579-ed5e-40c8-99a2-fc9196b41df2';
const CAPSULE_ID = 'voice-capsule:ef80d251-4a44-48ce-97ad-9f68466a130d';

function fullCapsule() {
  return {
    id: CAPSULE_ID,
    version: 'grammar-lexicon-v1',
    source: { attempt_id: 'ef80d251-4a44-48ce-97ad-9f68466a130d', item_revision: 1 },
    module: 'grammar',
    item: { id: 'grammar.test', prompt: 'Sensitive prompt', reference: ['answer'] },
    learner_answer: 'wrong answer', error: { type: 'grammar' },
    skill: { id: 'ege.grammar.test', label: 'Grammar test' },
    rule: { id: 'missing:ege.grammar.test', explanation: 'Missing', examples: [], discovery_required: true },
    checks: {
      micro_check: { id: 'micro', prompt: 'Sensitive check', answers: ['secret'] },
      transfer_task: { id: 'transfer', prompt: 'Sensitive transfer', answers: ['secret'] },
    },
  };
}

function aiSlotFixture(events = []) {
  return {
    claimAiOperation: async (request) => {
      events.push({ type: 'claim', request });
      return { claim_id: 'c728ae20-8f0d-4f1b-b332-6cb9bde450e7' };
    },
    settleAiOperation: async (username, claimId, settlement) => {
      events.push({ type: 'settle', username, claimId, settlement });
      return { applied: true, status: settlement.status };
    },
  };
}

test('persisted capsule is a reconstructable pointer and contains no learner-derived fingerprint, content, answers, prompts or rubrics', () => {
  const stored = persistedVoiceTutorCapsule(fullCapsule());
  assert.deepEqual(Object.keys(stored).sort(), ['id', 'module', 'schema', 'skill_id', 'source', 'version']);
  const encoded = JSON.stringify(stored);
  for (const forbidden of ['wrong answer', 'Sensitive prompt', 'Sensitive check', 'Sensitive transfer', 'secret', '"reference":', '"checks":']) {
    assert.equal(encoded.includes(forbidden), false, forbidden);
  }
});

test('grammar, vocabulary, writing and speaking pointers never persist an answer-derived hash', () => {
  for (const module of ['grammar', 'vocabulary', 'writing', 'speaking']) {
    const first = fullCapsule();
    first.module = module;
    first.id = `voice-capsule:${module}:server-attempt`;
    first.source = { attempt_type: module, attempt_id: 17, item_revision: 1 };
    first.skill.id = `ege.${module}.server-owned`;
    first.learner_answer = `private-${module}-answer-a`;
    const second = structuredClone(first);
    second.learner_answer = `private-${module}-answer-b`;
    assert.deepEqual(persistedVoiceTutorCapsule(first), persistedVoiceTutorCapsule(second));
    assert.equal(JSON.stringify(persistedVoiceTutorCapsule(first)).includes('hash'), false);
  }
});

test('file storage rewrites legacy full and hashed reference capsules before persistence or export', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-ticket-09-legacy-'));
  const file = path.join(directory, 'data.json');
  await fs.writeFile(file, JSON.stringify({
    users: { legacy: { created: NOW.getTime() } },
    voice_tutor_sessions: [
      {
        id: SESSION_ID, username: 'legacy', capsule_id: CAPSULE_ID, capsule: fullCapsule(),
        status: 'completed', pedagogical_state: 'ended', clarification_turns: 0,
      },
      {
        id: 'b04bf579-ed5e-40c8-99a2-fc9196b41df3', username: 'legacy', capsule_id: 'voice-capsule:legacy-pointer',
        capsule: {
          schema: 'voice-tutor-reference-v1', id: 'voice-capsule:legacy-pointer', version: 'grammar-lexicon-v1',
          source: { attempt_id: 'ef80d251-4a44-48ce-97ad-9f68466a130d', item_revision: 1 },
          module: 'grammar', skill_id: 'ege.grammar.test', content_hash: 'f'.repeat(64),
          unexpected_private: 'wrong answer',
        },
        status: 'completed', pedagogical_state: 'ended', clarification_turns: 0,
      },
    ],
  }), 'utf8');
  const repository = createFileRepository(file, { voiceTutorMutationNow: () => NOW });
  try {
    const exported = await repository.exportUserData('legacy');
    const encoded = JSON.stringify(exported.voice_tutor_sessions);
    assert.equal(encoded.includes('wrong answer'), false);
    assert.equal(encoded.includes('Sensitive prompt'), false);
    assert.equal(encoded.includes('content_hash'), false);
    assert.equal(exported.voice_tutor_sessions[0].capsule.schema, 'voice-tutor-reference-legacy-v1');
    assert.deepEqual(Object.keys(exported.voice_tutor_sessions[1].capsule).sort(), [
      'id', 'module', 'schema', 'skill_id', 'source', 'version',
    ]);
    const rewritten = JSON.stringify(JSON.parse(await fs.readFile(file, 'utf8')).voice_tutor_sessions);
    assert.equal(rewritten.includes('wrong answer'), false);
    assert.equal(rewritten.includes('Sensitive check'), false);
    assert.equal(rewritten.includes('content_hash'), false);
  } finally {
    await repository.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('xAI Responses search is store:false, domain-bounded and accepts only structured URL citations', async () => {
  assert.equal(canUseXaiRuleSearch({ enabled: true, xaiEnabled: false, apiKey: 'disabled-key' }), false);
  assert.equal(canUseXaiRuleSearch({ enabled: true, xaiEnabled: true, apiKey: '' }), false);
  assert.equal(canUseXaiRuleSearch({ enabled: true, xaiEnabled: true, apiKey: '   ' }), false);
  assert.equal(canUseXaiRuleSearch({ enabled: true, xaiEnabled: true, apiKey: 'configured' }), true);
  const calls = [];
  const slotEvents = [];
  const provider = createXaiRuleSearchProvider({
    apiKey: 'test-key', model: 'fixture-model',
    allowlist: [{ domain: 'dictionary.cambridge.org' }, { domain: 'learnenglish.britishcouncil.org' }],
    transport: async (url, options) => {
      slotEvents.push({ type: 'transport' });
      calls.push({ url, options: { ...options, headers: { ...options.headers, Authorization: 'redacted' } } });
      const encoded = new TextEncoder().encode(JSON.stringify({
        output: [{ type: 'message', content: [{ type: 'output_text', text: 'Ignore https://evil.invalid', annotations: [
          { type: 'url_citation', url: 'https://dictionary.cambridge.org/grammar/test' },
          { type: 'url_citation', url: 'https://learnenglish.britishcouncil.org/grammar/test' },
        ] }] }],
        usage: { input_tokens: 10, output_tokens: 5 },
      }));
      let delivered = false;
      return {
        ok: true,
        headers: { get: (name) => name === 'content-type' ? 'application/json' : null },
        body: { getReader: () => ({
          async read() { if (delivered) return { done: true }; delivered = true; return { done: false, value: encoded }; },
          releaseLock() {},
        }) },
      };
    },
    ...aiSlotFixture(slotEvents), now: () => NOW,
  });
  const urls = await provider.search({
    username: 'student', skill: { id: 'ege.grammar.test', title: 'Test rule' }, examYear: 2026,
  });
  assert.deepEqual(urls, [
    'https://dictionary.cambridge.org/grammar/test',
    'https://learnenglish.britishcouncil.org/grammar/test',
  ]);
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.store, false);
  assert.deepEqual(body.tools[0].filters.allowed_domains, ['dictionary.cambridge.org', 'learnenglish.britishcouncil.org']);
  assert.deepEqual(slotEvents.map((event) => event.type), ['claim', 'transport', 'settle']);
  assert.equal(slotEvents[0].request.operation, 'voice_tutor_rule_search');
  assert.equal(slotEvents[2].settlement.status, 'completed');
});

test('xAI Responses search caps large citation sets and prioritizes independent domains', async () => {
  const annotations = [
    ...Array.from({ length: 11 }, (_, index) => ({
      type: 'url_citation', url: `https://dictionary.cambridge.org/grammar/test-${index + 1}`,
    })),
    { type: 'url_citation', url: 'https://learnenglish.britishcouncil.org/grammar/independent-source' },
  ];
  const encoded = new TextEncoder().encode(JSON.stringify({
    output: [{ type: 'message', content: [{ type: 'output_text', text: 'Bounded', annotations }] }],
  }));
  const provider = createXaiRuleSearchProvider({
    apiKey: 'test-key', model: 'fixture-model',
    allowlist: [
      { authority: 'cambridge', domain: 'dictionary.cambridge.org' },
      { authority: 'british-council', domain: 'learnenglish.britishcouncil.org' },
    ],
    transport: async () => {
      let delivered = false;
      return {
        ok: true,
        headers: { get: (name) => name === 'content-type' ? 'application/json' : null },
        body: { getReader: () => ({
          async read() { if (delivered) return { done: true }; delivered = true; return { done: false, value: encoded }; },
          releaseLock() {},
        }) },
      };
    },
    ...aiSlotFixture(), now: () => NOW,
  });
  const urls = await provider.search({
    username: 'student', skill: { id: 'ege.grammar.test', title: 'Test rule' }, examYear: 2026,
  });
  assert.equal(urls.length, 5);
  assert.equal(urls.some((url) => url.includes('britishcouncil.org')), true);
});

test('xAI Responses search fails closed when the transport cannot expose a streaming body', async () => {
  let textCalled = false;
  const provider = createXaiRuleSearchProvider({
    apiKey: 'test-key', model: 'fixture-model',
    allowlist: [{ domain: 'dictionary.cambridge.org' }, { domain: 'learnenglish.britishcouncil.org' }],
    transport: async () => ({
      ok: true,
      headers: { get: (name) => name === 'content-type' ? 'application/json' : null },
      body: null,
      async text() { textCalled = true; return '{}'; },
    }),
    ...aiSlotFixture(),
  });
  await assert.rejects(
    provider.search({ username: 'student', skill: { id: 'ege.grammar.test', title: 'Test rule' }, examYear: 2026 }),
    (error) => error.code === 'TRUSTED_RULE_RESPONSE_BLOCKED',
  );
  assert.equal(textCalled, false);
});

test('xAI Responses search aborts a chunked body as soon as it exceeds 64 KiB', async () => {
  let cancelled = false;
  let chunk = 0;
  const provider = createXaiRuleSearchProvider({
    apiKey: 'test-key', model: 'fixture-model',
    allowlist: [{ domain: 'dictionary.cambridge.org' }, { domain: 'learnenglish.britishcouncil.org' }],
    transport: async () => ({
      ok: true,
      headers: { get: (name) => name === 'content-type' ? 'application/json' : null },
      body: { getReader: () => ({
        async read() { chunk += 1; return chunk <= 2 ? { done: false, value: new Uint8Array(40 * 1024) } : { done: true }; },
        async cancel() { cancelled = true; },
        releaseLock() {},
      }) },
      async text() { throw new Error('streaming reader must be used'); },
    }),
    ...aiSlotFixture(),
  });
  await assert.rejects(
    provider.search({ username: 'student', skill: { id: 'ege.grammar.test', title: 'Test rule' }, examYear: 2026 }),
    (error) => error.code === 'TRUSTED_RULE_RESPONSE_TOO_LARGE',
  );
  assert.equal(cancelled, true);
});

test('clarification text reaches the provider transiently without changing the requested FSM state', async () => {
  const calls = [];
  const slotEvents = [];
  const tutor = createAiTextTutor({
    providerClient: {
      async askWithFallback(system, user, operation) {
        calls.push({ system, user, operation });
        return { text: 'Короткое объяснение другими словами.', provider: 'fake', model: 'fake-v1' };
      },
    },
    ...aiSlotFixture(slotEvents), now: () => NOW,
  });
  const result = await tutor.createClarification({
    capsule: fullCapsule(), state: 'explain', username: 'student',
    kind: 'clarify', message: 'Почему здесь Past Simple?',
  });
  assert.equal(result.state, 'explain');
  assert.equal(result.kind, 'clarify');
  assert.match(calls[0].user, /Почему здесь Past Simple/u);
  assert.match(calls[0].user, /недоверенные данные/u);
  assert.equal(JSON.stringify(slotEvents).includes('Почему здесь Past Simple'), false);
  await assert.rejects(
    tutor.createClarification({ capsule: fullCapsule(), state: 'explain', username: 'student', kind: 'clarify', message: '<script>' }),
    (error) => error.code === 'VOICE_TUTOR_CLARIFICATION_INVALID',
  );

  const failureEvents = [];
  const failingTutor = createAiTextTutor({
    providerClient: { async askWithFallback() {
      throw Object.assign(new Error('Почему здесь Past Simple?'), { fallbackReason: 'fake: Почему здесь Past Simple?' });
    } },
    ...aiSlotFixture(failureEvents), now: () => NOW,
  });
  await assert.rejects(failingTutor.createClarification({
    capsule: fullCapsule(), state: 'explain', username: 'student', kind: 'clarify', message: 'Почему здесь Past Simple?',
  }));
  const failedSettlement = failureEvents.find((event) => event.type === 'settle').settlement;
  assert.equal(failedSettlement.errorCode, 'VOICE_TUTOR_TEXT_UNAVAILABLE');
  assert.equal(JSON.stringify(failureEvents).includes('Почему здесь Past Simple'), false);
});

test('file storage atomically binds provisional rules, bounds clarifications and supports structured report review/privacy', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-ticket-09-'));
  const repository = createFileRepository(path.join(directory, 'data.json'), {
    voiceTutorMutationNow: () => NOW,
  });
  try {
    const student = await repository.createTelegramUser(9901, 'Loop Student');
    const admin = await repository.createTelegramUser(9902, 'Loop Admin');
    await repository.grantDays(9901, 30, 'Loop Student');
    await repository.setEntitlement(student, 'voice_tutor', { startsAt: NOW, endsAt: new Date('2026-09-03T10:00:00Z') });
    const stored = persistedVoiceTutorCapsule(fullCapsule());
    await repository.reserveVoiceTutorSession(student, {
      id: SESSION_ID, idempotencyKey: 'ticket-09-loop', limits: LIMITS, now: NOW,
      context: { capsule: stored, nonceHash: 'nonce-1' },
    });
    const discoveryClaimId = 'b6c95550-1099-4bc8-9763-e136f98b8630';
    await repository.claimVoiceTutorRuleDiscovery(student, SESSION_ID, {
      claimId: discoveryClaimId, nonceHash: 'nonce-1', now: NOW,
    });
    const card = await repository.createRuleCardForVoiceTutorSession(student, SESSION_ID, CAPSULE_ID, {
      id: '55ee0cf9-17ad-4ac1-b33b-2fc64480ea6a', skill: { id: stored.skill_id, title: 'Grammar test' },
      examYear: 2026, rule: { title: 'Rule', explanation: 'Bounded provisional explanation.', examples: ['Example.'] },
      agreementHash: 'a'.repeat(64), sources: [], discrepancies: [], createdAt: NOW,
    }, {
      claimId: discoveryClaimId, expectedNonceHash: 'nonce-1', nextNonceHash: 'nonce-2',
    });
    assert.equal(card.status, 'pending_review');
    const bound = await repository.getVoiceTutorSession(student, SESSION_ID);
    assert.equal(bound.capsule.rule_card_id, card.id);
    assert.equal(bound.pedagogical_state, 'explain');
    await repository.setVoiceTutorSessionDelivery(student, SESSION_ID, { mode: 'text' });

    let nonce = 'nonce-2';
    for (let index = 0; index < 3; index += 1) {
      const next = `nonce-${index + 2}`;
      const result = await repository.clarifyVoiceTutorSession(student, SESSION_ID, {
        nonceHash: nonce, nextNonceHash: next, now: NOW,
      });
      assert.equal(result.session.state, 'explain');
      nonce = next;
    }
    await assert.rejects(
      repository.clarifyVoiceTutorSession(student, SESSION_ID, { nonceHash: nonce, nextNonceHash: 'nonce-5', now: NOW }),
      (error) => error.code === 'VOICE_TUTOR_CLARIFICATION_LIMIT',
    );

    const created = await repository.createVoiceTutorReport(student, {
      id: '404ffca3-f267-47b0-be7f-fd2e0bb3f8fc', sessionId: SESSION_ID,
      reason: 'unclear_explanation', createdAt: NOW,
    });
    assert.equal(created.report.rule_card_id, card.id);
    assert.equal((await repository.listVoiceTutorReports({ status: 'pending' })).length, 1);
    const reviewed = await repository.reviewVoiceTutorReport(created.report.id, {
      decision: 'confirmed', reviewer: admin, reviewedAt: NOW,
    });
    assert.equal(reviewed.applied, true);
    assert.equal(reviewed.report.review_audit.length, 1);
    const exported = await repository.exportUserData(student);
    assert.equal(exported.voice_tutor_reports[0].reason, 'unclear_explanation');
    assert.equal(JSON.stringify(exported.voice_tutor_sessions).includes('wrong answer'), false);
    await repository.deleteUserData(student);
    assert.equal((await repository.listVoiceTutorReports({ status: '' })).length, 0);
  } finally {
    await repository.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('file storage claims discovery before external work and a finish during discovery cannot bind a provisional rule', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-ticket-09-discovery-race-'));
  const repository = createFileRepository(path.join(directory, 'data.json'), {
    voiceTutorMutationNow: () => NOW,
  });
  try {
    const student = await repository.createTelegramUser(9911, 'Discovery Race Student');
    await repository.grantDays(9911, 30, 'Discovery Race Student');
    await repository.setEntitlement(student, 'voice_tutor', { startsAt: NOW, endsAt: new Date('2026-09-03T10:00:00Z') });
    const stored = persistedVoiceTutorCapsule(fullCapsule());
    await repository.reserveVoiceTutorSession(student, {
      id: SESSION_ID, idempotencyKey: 'ticket-09-discovery-race', limits: LIMITS, now: NOW,
      context: { capsule: stored, nonceHash: 'race-nonce-1' },
    });
    const claimId = '4c854c5d-7b2a-4360-b25f-7040ee3f2740';
    const claimed = await repository.claimVoiceTutorRuleDiscovery(student, SESSION_ID, {
      claimId, nonceHash: 'race-nonce-1', now: NOW,
    });
    assert.equal(claimed.claim_id, claimId);
    await assert.rejects(
      repository.claimVoiceTutorRuleDiscovery(student, SESSION_ID, {
        claimId: '3fbb9528-1dfd-42ef-b300-5464f20a8fc5', nonceHash: 'race-nonce-1', now: NOW,
      }),
      (error) => error.code === 'TRUSTED_RULE_DISCOVERY_IN_PROGRESS',
    );
    await repository.finishVoiceTutorSession(student, SESSION_ID, { limits: LIMITS, now: NOW });
    await assert.rejects(
      repository.createRuleCardForVoiceTutorSession(student, SESSION_ID, CAPSULE_ID, {
        id: 'e2388cbf-b965-4ee2-9d44-868f1940a176', skill: { id: stored.skill_id, title: 'Grammar test' },
        examYear: 2026, rule: { title: 'Rule', explanation: 'Must never bind.', examples: ['Example.'] },
        agreementHash: 'b'.repeat(64), sources: [], discrepancies: [], createdAt: NOW,
      }, { claimId, expectedNonceHash: 'race-nonce-1', nextNonceHash: 'race-nonce-2' }),
      (error) => error.code === 'TRUSTED_RULE_DISCOVERY_NOT_REQUIRED',
    );
    assert.equal((await repository.listRuleCards({ status: 'pending_review' })).length, 0);
    assert.equal((await repository.getVoiceTutorSession(student, SESSION_ID)).capsule.rule_card_id, undefined);
  } finally {
    await repository.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('file storage atomically claims and observably settles paid AI rate/budget slots', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-ticket-09-ai-slot-'));
  const repository = createFileRepository(path.join(directory, 'data.json'), {
    voiceTutorMutationNow: () => NOW,
  });
  try {
    const student = await repository.createTelegramUser(9921, 'AI Slot Student');
    const claims = await Promise.allSettled([
      repository.claimAiOperationSlot(student, {
        claimId: 'ea4141be-dddd-4738-a861-541400d59a9f', operation: 'voice_tutor_rule_search',
        promptVersion: 'voice-tutor-rule-search-v1', requestsPerHour: 1, dailyLimit: 1, now: NOW,
      }),
      repository.claimAiOperationSlot(student, {
        claimId: 'cccb92a1-2b56-4a1d-bc63-04fae73cced0', operation: 'voice_tutor_rule_search',
        promptVersion: 'voice-tutor-rule-search-v1', requestsPerHour: 1, dailyLimit: 1, now: NOW,
      }),
    ]);
    assert.equal(claims.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(claims.filter((result) => result.status === 'rejected').length, 1);
    assert.match(claims.find((result) => result.status === 'rejected').reason.code, /^(AI_BUDGET_EXHAUSTED|RATE_LIMITED)$/u);
    const claim = claims.find((result) => result.status === 'fulfilled').value;
    const settled = await repository.settleAiOperationSlot(student, claim.claim_id, {
      status: 'failed', provider: 'xai', model: 'fixture-v1', durationMs: 27,
      errorCode: 'TRUSTED_RULE_SEARCH_FAILED', now: NOW,
    });
    assert.equal(settled.applied, true);
    assert.equal((await repository.settleAiOperationSlot(student, claim.claim_id, {
      status: 'failed', errorCode: 'TRUSTED_RULE_SEARCH_FAILED', now: NOW,
    })).applied, false);
    const exported = await repository.exportUserData(student);
    assert.equal(exported.ai_requests.length, 1);
    assert.equal(exported.ai_requests[0].status, 'failed');
    assert.equal(exported.ai_requests[0].error_code, 'TRUSTED_RULE_SEARCH_FAILED');
  } finally {
    await repository.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
