import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createFileRepository } from '../storage/file-repository.js';

const NOW = new Date('2026-08-03T10:00:00.000Z');
const LIMITS = Object.freeze({ dailySeconds: 600, monthlySeconds: 7_200, sessionSeconds: 300 });

async function withRepository(run) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-ticket-10-storage-'));
  const file = path.join(directory, 'data.json');
  const repository = createFileRepository(file);
  try {
    await run(repository, file);
  } finally {
    await repository.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
}

function ruleCard({ id = crypto.randomUUID(), username, skillId = 'ege.grammar.future_passive' } = {}) {
  return {
    id,
    createdForUsername: username,
    skill: { id: skillId, title: 'Future passive' },
    examYear: 2026,
    rule: { title: 'Future passive', explanation: 'Use will be and the past participle.', examples: ['It will be built.'] },
    agreementHash: 'a'.repeat(64),
    sources: [],
    discrepancies: [],
    createdAt: NOW,
  };
}

async function createVoiceSession(repository, telegramId, { now = NOW } = {}) {
  const username = await repository.createTelegramUser(telegramId, `Proxy Student ${telegramId}`);
  await repository.grantDays(telegramId, 30, `Proxy Student ${telegramId}`);
  await repository.setEntitlement(username, 'voice_tutor', {
    startsAt: now,
    endsAt: new Date(now.getTime() + 86_400_000),
  });
  const sessionId = crypto.randomUUID();
  const idempotencyKey = crypto.randomUUID();
  await repository.reserveVoiceTutorSession(username, {
    id: sessionId,
    idempotencyKey,
    limits: LIMITS,
    now,
    context: {
      capsule: {
        schema: 'voice-tutor-reference-v1', id: `voice-capsule:${sessionId}`, version: 'grammar-lexicon-v1',
        source: { attempt_id: crypto.randomUUID(), item_revision: 1 }, module: 'grammar', skill_id: 'ege.grammar.proxy',
      },
      nonceHash: '1'.repeat(64),
    },
  });
  return { username, sessionId, idempotencyKey };
}

test('file repository reissues and atomically consumes one-use proxy tickets without storing raw credentials', async () => {
  await withRepository(async (repository, file) => {
    const { username, sessionId, idempotencyKey } = await createVoiceSession(repository, 7100);
    const ticketHash = 'a'.repeat(64);
    const replacementHash = 'b'.repeat(64);
    const expiresAt = new Date(NOW.getTime() + 60_000);

    const issued = await repository.issueVoiceTutorProxyTicket(username, sessionId, {
      ticketHash, idempotencyKey, expiresAt, now: NOW,
    });
    assert.deepEqual(issued, {
      issued: true, reissued: false,
      ticket: { session_id: sessionId, expires_at: expiresAt.toISOString(), consumed_at: null },
    });
    assert.equal((await repository.issueVoiceTutorProxyTicket(username, sessionId, {
      ticketHash, idempotencyKey, expiresAt, now: NOW,
    })).issued, false);

    const replacement = await repository.issueVoiceTutorProxyTicket(username, sessionId, {
      ticketHash: replacementHash, idempotencyKey, expiresAt, now: NOW, reissue: true, nextNonceHash: '2'.repeat(64),
    });
    assert.equal(replacement.reissued, true);
    assert.equal((await repository.getVoiceTutorSession(username, sessionId)).nonce_hash, '2'.repeat(64));
    await assert.rejects(
      repository.issueVoiceTutorProxyTicket(username, sessionId, {
        ticketHash: '9'.repeat(64), idempotencyKey, expiresAt, now: NOW,
        reissue: true, nextNonceHash: '3'.repeat(64),
      }),
      (error) => error.code === 'VOICE_TUTOR_PROXY_TICKET_REISSUE_LIMIT',
    );
    assert.equal((await repository.getVoiceTutorSession(username, sessionId)).proxy_ticket_reissue_count, 1);
    await assert.rejects(
      repository.consumeVoiceTutorProxyTicket(username, { ticketHash }, { now: NOW }),
      /VOICE_TUTOR_PROXY_TICKET_INVALID/u,
    );

    const consumed = await Promise.allSettled([
      repository.consumeVoiceTutorProxyTicket(username, { ticketHash: replacementHash }, {
        now: NOW, provider: 'xai', model: 'grok-voice-v1', promptVersion: 'voice-tutor-error-v4',
      }),
      repository.consumeVoiceTutorProxyTicket(username, { ticketHash: replacementHash }, {
        now: NOW, provider: 'xai', model: 'grok-voice-v1', promptVersion: 'voice-tutor-error-v4',
      }),
    ]);
    assert.equal(consumed.filter((result) => result.status === 'fulfilled').length, 1);
    const accepted = consumed.find((result) => result.status === 'fulfilled').value;
    assert.deepEqual(accepted.session, { id: sessionId, reserved_seconds: 300, expires_at: new Date(NOW.getTime() + 300_000).toISOString() });
    assert.equal(accepted.capsule.id, `voice-capsule:${sessionId}`);
    assert.match(consumed.find((result) => result.status === 'rejected').reason.message, /VOICE_TUTOR_PROXY_TICKET_REPLAYED/u);
    const activated = await repository.activateVoiceTutorProxySession(username, sessionId, { now: NOW });
    assert.equal(activated.activated, true);
    assert.equal((await repository.activateVoiceTutorProxySession(username, sessionId, { now: NOW })).activated, false);
    assert.equal(new Date((await repository.getVoiceTutorSession(username, sessionId)).voice_activated_at).getTime(), NOW.getTime());

    const stored = await fs.readFile(file, 'utf8');
    assert.equal(stored.includes(ticketHash), false);
    assert.equal(stored.includes(replacementHash), true);
    assert.equal(stored.includes('raw-ticket'), false);
    const exported = JSON.stringify(await repository.exportUserData(username));
    assert.equal(exported.includes(replacementHash), false);
    assert.equal(exported.includes('proxy_ticket_reissue_count'), false);
  });
});

test('file repository rotates a lost fallback response nonce exactly once', async () => {
  await withRepository(async (repository) => {
    const { username, sessionId, idempotencyKey } = await createVoiceSession(repository, 7106);
    await repository.setVoiceTutorSessionDelivery(username, sessionId, {
      mode: 'local', errorCode: 'VOICE_TUTOR_PROVIDER_NOT_CONFIGURED',
    });
    await repository.finishVoiceTutorSession(username, sessionId, {
      limits: LIMITS, now: NOW, confirmedBillableSeconds: 0, preservePedagogicalState: true,
    });

    const rotated = await Promise.allSettled([
      repository.reissueVoiceTutorFallbackNonce(username, sessionId, {
        idempotencyKey, nextNonceHash: '2'.repeat(64), now: NOW,
      }),
      repository.reissueVoiceTutorFallbackNonce(username, sessionId, {
        idempotencyKey, nextNonceHash: '3'.repeat(64), now: NOW,
      }),
    ]);
    assert.equal(rotated.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(rotated.filter((result) => result.status === 'rejected').length, 1);
    assert.equal(rotated.find((result) => result.status === 'rejected').reason.code, 'VOICE_TUTOR_PROXY_TICKET_REISSUE_LIMIT');
    const stored = await repository.getVoiceTutorSession(username, sessionId);
    assert.equal(['2'.repeat(64), '3'.repeat(64)].includes(stored.nonce_hash), true);
    assert.equal(stored.proxy_ticket_reissue_count, 1);
  });
});

test('file repository converts a lost realtime reissue into zero-bill local recovery', async () => {
  await withRepository(async (repository) => {
    const { username, sessionId, idempotencyKey } = await createVoiceSession(repository, 7108);
    const expiresAt = new Date(NOW.getTime() + 60_000);
    await repository.setVoiceTutorSessionDelivery(username, sessionId, { mode: 'voice' });
    await repository.issueVoiceTutorProxyTicket(username, sessionId, {
      ticketHash: '5'.repeat(64), idempotencyKey, expiresAt, now: NOW,
    });
    await repository.issueVoiceTutorProxyTicket(username, sessionId, {
      ticketHash: '6'.repeat(64), idempotencyKey, expiresAt, now: NOW,
      reissue: true, nextNonceHash: '7'.repeat(64),
    });

    const recovered = await repository.reissueVoiceTutorFallbackNonce(username, sessionId, {
      idempotencyKey, nextNonceHash: '8'.repeat(64), now: NOW, recoverLostRealtime: true,
    });
    assert.equal(recovered.session.status, 'completed');
    const stored = await repository.getVoiceTutorSession(username, sessionId);
    assert.equal(stored.delivery_mode, 'local');
    assert.equal(stored.billable_seconds, 0);
    assert.equal(stored.nonce_hash, '8'.repeat(64));
    assert.equal(stored.proxy_ticket_hash, null);
    assert.equal(stored.proxy_ticket_issued_at, null);
    assert.equal(stored.proxy_ticket_expires_at, null);
    assert.equal(stored.proxy_ticket_consumed_at, null);
    await assert.rejects(
      repository.consumeVoiceTutorProxyTicket(username, { ticketHash: '6'.repeat(64) }, { now: NOW }),
      /VOICE_TUTOR_PROXY_TICKET_INVALID/u,
    );
    await assert.rejects(
      repository.reissueVoiceTutorFallbackNonce(username, sessionId, {
        idempotencyKey, nextNonceHash: '9'.repeat(64), now: NOW, recoverLostRealtime: true,
      }),
      /VOICE_TUTOR_PROXY_TICKET_REISSUE_LIMIT/u,
    );
  });
});

test('file repository atomically recovers a partial null-delivery creation into local mode', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-ticket-10-partial-'));
  const file = path.join(directory, 'data.json');
  const repository = createFileRepository(file);
  try {
    const { username, sessionId, idempotencyKey } = await createVoiceSession(repository, 7107);
    await repository.close();
    const data = JSON.parse(await fs.readFile(file, 'utf8'));
    const partial = data.voice_tutor_sessions.find((session) => session.id === sessionId);
    partial.delivery_mode = null;
    await fs.writeFile(file, JSON.stringify(data));
    const reopened = createFileRepository(file);
    try {
      const recovered = await reopened.reissueVoiceTutorFallbackNonce(username, sessionId, {
        idempotencyKey, nextNonceHash: '4'.repeat(64), now: NOW,
      });
      assert.equal(recovered.session.status, 'completed');
      const stored = await reopened.getVoiceTutorSession(username, sessionId);
      assert.equal(stored.delivery_mode, 'local');
      assert.equal(stored.billable_seconds, 0);
      assert.equal(stored.nonce_hash, '4'.repeat(64));
      assert.equal(stored.proxy_ticket_reissue_count, 1);
    } finally { await reopened.close(); }
  } finally {
    await repository.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('file repository finalizes confirmed proxy audio exactly and abnormal usage conservatively', async () => {
  await withRepository(async (repository) => {
    const exact = await createVoiceSession(repository, 7102);
    await repository.issueVoiceTutorProxyTicket(exact.username, exact.sessionId, {
      ticketHash: 'c'.repeat(64), idempotencyKey: exact.idempotencyKey,
      expiresAt: new Date(NOW.getTime() + 60_000), now: NOW,
    });
    await repository.consumeVoiceTutorProxyTicket(exact.username, { ticketHash: 'c'.repeat(64) }, { now: NOW });
    const finalized = await repository.finalizeVoiceTutorProxySession(exact.username, exact.sessionId, {
      inputAudioBytes: 48_000, outputAudioBytes: 1, confirmed: true, reason: 'completed',
      now: new Date(NOW.getTime() + 20_000), limits: LIMITS,
    });
    assert.equal(finalized.finalized, true);
    assert.deepEqual(finalized.usage, {
      input_audio_bytes: 48_000, output_audio_bytes: 1, confirmed: true, exact: true,
      billable_seconds: 2, reason: 'completed', finalized_at: new Date(NOW.getTime() + 20_000).toISOString(),
    });
    const retry = await repository.finalizeVoiceTutorProxySession(exact.username, exact.sessionId, {
      inputAudioBytes: 999_999, outputAudioBytes: 999_999, confirmed: false, reason: 'provider_error',
      now: new Date(NOW.getTime() + 30_000), limits: LIMITS,
    });
    assert.equal(retry.finalized, false);
    assert.deepEqual(retry.usage, finalized.usage);

    const conservativeStart = new Date(NOW.getTime() + 40_000);
    const conservative = await createVoiceSession(repository, 7103, { now: conservativeStart });
    await repository.issueVoiceTutorProxyTicket(conservative.username, conservative.sessionId, {
      ticketHash: 'd'.repeat(64), idempotencyKey: conservative.idempotencyKey,
      expiresAt: new Date(conservativeStart.getTime() + 60_000), now: conservativeStart,
    });
    await repository.consumeVoiceTutorProxyTicket(conservative.username, { ticketHash: 'd'.repeat(64) }, { now: conservativeStart });
    const failed = await repository.finalizeVoiceTutorProxySession(conservative.username, conservative.sessionId, {
      inputAudioBytes: 0, outputAudioBytes: 0, confirmed: false, reason: 'provider_error',
      now: new Date(conservativeStart.getTime() + 1_000), limits: LIMITS,
    });
    assert.equal(failed.usage.exact, false);
    assert.equal(failed.usage.billable_seconds, 300);
    assert.equal((await repository.getVoiceTutorSession(conservative.username, conservative.sessionId)).billable_seconds, 300);

    const legacyFinishStart = new Date(NOW.getTime() + 50_000);
    const legacyFinish = await createVoiceSession(repository, 7104, { now: legacyFinishStart });
    await repository.issueVoiceTutorProxyTicket(legacyFinish.username, legacyFinish.sessionId, {
      ticketHash: 'e'.repeat(64), idempotencyKey: legacyFinish.idempotencyKey,
      expiresAt: new Date(legacyFinishStart.getTime() + 60_000), now: legacyFinishStart,
    });
    await repository.consumeVoiceTutorProxyTicket(legacyFinish.username, { ticketHash: 'e'.repeat(64), now: legacyFinishStart });
    await repository.activateVoiceTutorProxySession(legacyFinish.username, legacyFinish.sessionId, { now: legacyFinishStart });
    await repository.finishVoiceTutorSession(legacyFinish.username, legacyFinish.sessionId, {
      confirmedBillableSeconds: 0, now: new Date(legacyFinishStart.getTime() + 1_000), limits: LIMITS,
    });
    const legacyStored = await repository.getVoiceTutorSession(legacyFinish.username, legacyFinish.sessionId);
    assert.equal(legacyStored.billable_seconds, 300);
    assert.equal(legacyStored.proxy_usage_confirmed, false);
    assert.equal(legacyStored.proxy_finalization_reason, 'server_finish');

    const fallbackStart = new Date(NOW.getTime() + 55_000);
    const fallback = await createVoiceSession(repository, 7107, { now: fallbackStart });
    await repository.issueVoiceTutorProxyTicket(fallback.username, fallback.sessionId, {
      ticketHash: '7'.repeat(64), idempotencyKey: fallback.idempotencyKey,
      expiresAt: new Date(fallbackStart.getTime() + 60_000), now: fallbackStart,
    });
    await repository.consumeVoiceTutorProxyTicket(fallback.username, { ticketHash: '7'.repeat(64), now: fallbackStart });
    await repository.switchVoiceTutorSessionDelivery(fallback.username, fallback.sessionId, {
      nonceHash: '1'.repeat(64), nextNonceHash: '2'.repeat(64), mode: 'local',
      errorCode: 'VOICE_TUTOR_PROVIDER_UNAVAILABLE', limits: LIMITS,
      now: new Date(fallbackStart.getTime() + 1_000),
    });
    const fallbackStored = await repository.getVoiceTutorSession(fallback.username, fallback.sessionId);
    assert.equal(fallbackStored.billable_seconds, 300);
    assert.equal(fallbackStored.proxy_usage_confirmed, false);
    assert.equal(fallbackStored.proxy_finalization_reason, 'runtime_fallback');
    const lateProxyFinalize = await repository.finalizeVoiceTutorProxySession(fallback.username, fallback.sessionId, {
      inputAudioBytes: 48_000, outputAudioBytes: 48_000, confirmed: true, reason: 'completed',
      now: new Date(fallbackStart.getTime() + 2_000), limits: LIMITS,
    });
    assert.equal(lateProxyFinalize.finalized, false);
    assert.equal(lateProxyFinalize.usage.billable_seconds, 300);

    const timeoutStart = new Date(NOW.getTime() + 60_000);
    const timeout = await createVoiceSession(repository, 7105, { now: timeoutStart });
    await repository.issueVoiceTutorProxyTicket(timeout.username, timeout.sessionId, {
      ticketHash: 'f'.repeat(64), idempotencyKey: timeout.idempotencyKey,
      expiresAt: new Date(timeoutStart.getTime() + 60_000), now: timeoutStart,
    });
    await repository.consumeVoiceTutorProxyTicket(timeout.username, { ticketHash: 'f'.repeat(64), now: timeoutStart });
    await repository.activateVoiceTutorProxySession(timeout.username, timeout.sessionId, { now: timeoutStart });
    await repository.finishVoiceTutorSession(timeout.username, timeout.sessionId, {
      now: new Date(timeoutStart.getTime() + 301_000), limits: LIMITS,
    });
    const timedOut = await repository.getVoiceTutorSession(timeout.username, timeout.sessionId);
    assert.equal(timedOut.status, 'expired');
    assert.equal(timedOut.billable_seconds, 300);
    assert.equal(timedOut.proxy_finalization_reason, 'timeout');
  });
});

test('file repository approves at most one canonical card per skill and exam year', async () => {
  await withRepository(async (repository) => {
    const reviewer = await repository.createTelegramUser(7101, 'Canonical Reviewer');
    const first = ruleCard({ username: reviewer });
    const second = ruleCard({ username: reviewer });
    await repository.createRuleCard(first);
    await repository.createRuleCard(second);

    const reviewed = await Promise.allSettled([
      repository.reviewRuleCard(first.id, { decision: 'approved', reviewer, reviewedAt: NOW }),
      repository.reviewRuleCard(second.id, { decision: 'approved', reviewer, reviewedAt: NOW }),
    ]);

    assert.equal(reviewed.filter((result) => result.status === 'fulfilled').length, 1);
    const rejected = reviewed.find((result) => result.status === 'rejected');
    assert.equal(rejected.reason.code, 'RULE_CARD_CANONICAL_EXISTS');
    const approved = await repository.listRuleCards({ status: 'approved' });
    assert.equal(approved.length, 1);
    assert.equal((await repository.getApprovedRuleCard(first.skill.id, first.examYear)).id, approved[0].id);
  });
});

test('file repository deterministically reconciles legacy duplicate approved canonicals on load', async () => {
  await withRepository(async (repository, file) => {
    const olderId = crypto.randomUUID();
    const newerId = crypto.randomUUID();
    await fs.writeFile(file, JSON.stringify({
      rule_cards: [
        {
          ...ruleCard({ id: olderId, skillId: 'ege.grammar.legacy_duplicate' }),
          status: 'approved', skill: { id: 'ege.grammar.legacy_duplicate', title: 'Legacy' }, exam_year: 2026,
          review_audit: [], created_at: '2026-01-01T00:00:00.000Z', reviewed_at: '2026-02-01T00:00:00.000Z',
        },
        {
          ...ruleCard({ id: newerId, skillId: 'ege.grammar.legacy_duplicate' }),
          status: 'approved', skill: { id: 'ege.grammar.legacy_duplicate', title: 'Legacy' }, exam_year: 2026,
          review_audit: [], created_at: '2026-01-02T00:00:00.000Z', reviewed_at: '2026-03-01T00:00:00.000Z',
        },
      ],
    }), 'utf8');

    assert.equal((await repository.getApprovedRuleCard('ege.grammar.legacy_duplicate', 2026)).id, newerId);
    const approved = await repository.listRuleCards({ status: 'approved' });
    const rejected = await repository.listRuleCards({ status: 'rejected' });
    assert.deepEqual(approved.map((card) => card.id), [newerId]);
    assert.deepEqual(rejected.map((card) => card.id), [olderId]);
    assert.equal(rejected[0].review_audit.at(-1).reason, 'canonical_deduplicated_by_migration_029');
  });
});

test('file repository serializes privacy consent with account deletion', async () => {
  await withRepository(async (repository) => {
    const username = await repository.createTelegramUser(7106, 'Privacy Delete Race');
    const race = await Promise.allSettled([
      repository.deleteUserData(username),
      repository.setPrivacyConsent(username, {
        text_processing: true, voice_processing: true, policy_version: 'ticket-10-v1',
      }),
    ]);
    assert.equal(race[0].status, 'fulfilled');
    assert.equal(race[0].value, true);
    assert.equal(race[1].status, 'rejected');
    assert.match(race[1].reason.message, /USER_NOT_FOUND/u);
    assert.equal(await repository.getUser(username), null);
  });
});
