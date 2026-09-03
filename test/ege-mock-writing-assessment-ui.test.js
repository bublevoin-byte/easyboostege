import assert from 'node:assert/strict';
import test from 'node:test';

import { AUTOMATIC_ASSESSMENT_WARNING } from '../public/automatic-assessment-contract.js';
import {
  renderEgeMockWritingAssessmentActions,
  renderEgeMockWritingAssessmentStatus,
} from '../public/ege-mock-writing-assessment-ui.js';

test('public writing-assessment actions render distinct retryable and acknowledged-ambiguous controls', () => {
  const retryable = renderEgeMockWritingAssessmentActions({
    status: 'retryable', retryAllowed: true, retryCount: 1,
  });
  assert.match(retryable, /<button[^>]+data-ege-action="retry-assessment"/u);
  assert.doesNotMatch(retryable, /acknowledge|ambiguous/u);

  const ambiguous = renderEgeMockWritingAssessmentActions({
    status: 'ambiguous', retryAllowed: true, retryCount: 1,
  });
  assert.match(ambiguous, /<button[^>]+data-ege-action="retry-assessment-ambiguous"/u);
  assert.match(ambiguous, /повтор|provider work|провайдер/iu);

  const queued = renderEgeMockWritingAssessmentActions({
    status: 'ambiguous', retryAllowed: true, retryCount: 1,
  }, { queued: true });
  assert.match(queued, /role="status"/u);
  assert.doesNotMatch(queued, /<button/u);
  assert.equal(renderEgeMockWritingAssessmentActions({
    status: 'completed', retryAllowed: false, retryCount: 1,
  }), '');

  const subscriptionBlocked = renderEgeMockWritingAssessmentActions({
    status: 'pending', retryAllowed: false, retryCount: 0,
    runDisposition: 'subscription_required',
  });
  assert.match(subscriptionBlocked, /role="alert"/u);
  assert.match(subscriptionBlocked, /подписк/iu);
  assert.match(subscriptionBlocked,
    /data-ege-action="run-assessment-after-renewal"/u);

  const revisionBlocked = renderEgeMockWritingAssessmentActions({
    status: 'pending', retryAllowed: false, retryCount: 0,
  }, { revisionBlocked: true });
  assert.match(revisionBlocked, /role="alert"/u);
  assert.match(revisionBlocked, /остановлена|лимит/iu);
  assert.doesNotMatch(revisionBlocked, /<button/u,
    'revision exhaustion is nonretryable and exposes no loop-producing action');
});

test('the written terminal renders the exact canonical experimental approximate warning', () => {
  const markup = renderEgeMockWritingAssessmentStatus({
    status: 'pending', mode: 'experimental', scoreKind: 'approximate',
    warning: AUTOMATIC_ASSESSMENT_WARNING,
  });
  assert.match(markup, /Предварительная автоматическая оценка/u);
  assert.match(markup, /experimental/u);
  assert.match(markup, /ориентировоч/u);
  assert.equal(markup.includes(AUTOMATIC_ASSESSMENT_WARNING), true,
    'terminal copy reuses the canonical API/editor warning without paraphrase drift');
});
