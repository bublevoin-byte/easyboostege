import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

import { canStartVoiceTutor, eventForVoiceTutorState, voiceTutorButton } from '../public/voice-tutor.js';

const source = await fs.readFile(new URL('../public/voice-tutor.js', import.meta.url), 'utf8');

test('voice tutor trigger is a Premium-only real button with bounded data attributes', () => {
  assert.equal(canStartVoiceTutor({ entitlements: { voice_tutor: false } }), false);
  assert.equal(voiceTutorButton({ profile: { entitlements: { voice_tutor: false } } }), '');
  const markup = voiceTutorButton({
    profile: { entitlements: { voice_tutor: true } },
    attemptId: '0c0d11fd-8acd-4622-99a2-8b185bd0086b',
    revision: 1,
  });
  assert.match(markup, /^<button type="button"/u);
  assert.match(markup, /Разобрать голосом/u);
  assert.match(markup, /data-attempt="0c0d11fd-8acd-4622-99a2-8b185bd0086b"/u);
  assert.equal(markup.includes('data-learner'), false);
});

test('voice tutor controls drive the finite pedagogical states', () => {
  assert.deepEqual(eventForVoiceTutorState('diagnose'), { type: 'diagnosis_complete' });
  assert.deepEqual(eventForVoiceTutorState('explain'), { type: 'explanation_complete' });
  assert.deepEqual(eventForVoiceTutorState('micro_check', 'went'), { type: 'check_answer', answer: 'went' });
  assert.deepEqual(eventForVoiceTutorState('transfer_task', 'bought'), { type: 'transfer_answer', answer: 'bought' });
  assert.equal(eventForVoiceTutorState('resolved'), null);
});

test('shared voice tutor sheet exposes microphone, transient captions, quota, timer and accessible return controls', () => {
  assert.match(source, /role', 'dialog'/u);
  assert.match(source, /aria-modal', 'true'/u);
  assert.match(source, /voiceTutorMic/u);
  assert.match(source, /voiceTutorCaptions/u);
  assert.match(source, /aria-live="polite"/u);
  assert.match(source, /voiceTutorTimer/u);
  assert.match(source, /voiceTutorQuota/u);
  assert.match(source, /getUserMedia/u);
  assert.match(source, /browserRealtimeTransport/u);
  assert.match(source, /onPedagogicalEvent/u);
  assert.match(source, /\/fallback/u);
  assert.match(source, /returnFocus/u);
  assert.match(source, /transientCaptions\.length = 0/u);
  assert.match(source, /const sessionId = currentSession\?\.session\?\.id;\s+closeSheet\(\);\s+if \(sessionId\)/u);
});
