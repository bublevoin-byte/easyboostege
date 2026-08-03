import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

import { canStartVoiceTutor, eventForVoiceTutorState, voiceTutorButton } from '../public/voice-tutor.js';

const source = await fs.readFile(new URL('../public/voice-tutor.js', import.meta.url), 'utf8');
const readingSource = await fs.readFile(new URL('../public/screens/reading.js', import.meta.url), 'utf8');
const listeningSource = await fs.readFile(new URL('../public/screens/listening.js', import.meta.url), 'utf8');
const writingSource = await fs.readFile(new URL('../public/screens/writing.js', import.meta.url), 'utf8');
const speakingSource = await fs.readFile(new URL('../public/screens/speaking.js', import.meta.url), 'utf8');

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

  const reviewMarkup = voiceTutorButton({
    profile: { entitlements: { voice_tutor: true } }, source: 'writing', attemptId: 42, revision: 1,
    criterionChoices: [
      { index: 0, label: 'Решение коммуникативной задачи' },
      { index: 1, label: 'Организация текста' },
    ],
  });
  assert.match(reviewMarkup, /data-source="writing"/u);
  assert.match(reviewMarkup, /data-attempt="42"/u);
  assert.match(reviewMarkup, /data-criterion-index="0"/u);
  assert.match(reviewMarkup, /data-criterion-index="1"/u);
  assert.match(reviewMarkup, /Разобрать: Решение коммуникативной задачи/u);
  assert.match(reviewMarkup, /Разобрать: Организация текста/u);
  assert.equal((reviewMarkup.match(/voiceTutorTrigger/gu) || []).length, 2);
  assert.equal(reviewMarkup.includes('answer'), false);
});

test('writing and speaking reviews mount the shared tutor and keep only server-issued pointers in the DOM', () => {
  assert.match(writingSource, /import \{voiceTutorButton\} from '\.\.\/voice-tutor\.js'/u);
  assert.match(writingSource, /renderReview\(d,response\.evaluationScope,response\.voiceTutor\)/u);
  assert.match(writingSource, /voiceTutorButton\(voiceTutor\)/u);

  assert.match(speakingSource, /import \{voiceTutorButton\} from '\.\.\/voice-tutor\.js'/u);
  assert.match(speakingSource, /spShowEval\(d,tr,response\.voiceTutor\)/u);
  assert.match(speakingSource, /voiceTutorButton\(voiceTutor\)/u);
  assert.match(speakingSource, /voiceTutor:response\.voiceTutor/u);

  for (const screenSource of [writingSource, speakingSource]) {
    assert.doesNotMatch(screenSource, /voiceTutorButton\([^)]*(?:answer|transcript|review)/u);
  }
});

test('voice tutor controls drive the finite pedagogical states', () => {
  assert.deepEqual(eventForVoiceTutorState('diagnose', 'because'), { type: 'diagnosis_complete', answer: 'because' });
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
  assert.match(source, /Осталось \$\{Math\.floor\(remaining \/ 60\)\}/u);
  assert.match(source, /voiceTutorTimeWarning/u);
  assert.match(source, /Осталась последняя минута голосового разбора/u);
  assert.match(source, /tutorEvent\.answer/u);
  assert.match(source, /voiceTutorQuota/u);
  assert.match(source, /voiceTutorContext/u);
  assert.match(source, /getUserMedia/u);
  assert.match(source, /browserRealtimeTransport/u);
  assert.match(source, /onPedagogicalEvent/u);
  assert.match(source, /onFailure/u);
  assert.match(source, /provider_unavailable/u);
  assert.match(source, /session_timeout/u);
  assert.match(source, /realtime\.ticket/u);
  assert.match(source, /realtime\.reissue_url/u);
  assert.doesNotMatch(source, /\/activate/u);
  assert.match(source, /\/fallback/u);
  assert.match(source, /returnFocus/u);
  assert.match(source, /transientCaptions\.length = 0/u);
  assert.match(source, /const sessionId = currentSession\?\.session\?\.id;\s+await closeSheet\(\{ clean: true \}\);\s+if \(sessionId\)/u);
  assert.match(source, /switchToFallback\(realtimeConnection \? 'microphone_unavailable' : 'provider_unavailable'\)/u);
  assert.match(source, /sessionOperation/u);
  assert.match(source, /operationActive\(operation\)/u);
  assert.match(source, /pendingSessionKeys/u);
  assert.match(source, /postIdempotentWithNetworkRetry/u);
  assert.match(source, /error\?\.code !== 'NETWORK_ERROR'/u);
  assert.match(source, /finishCancelledSession\(result\)/u);
  assert.match(source, /updateProfileAccess\(await api\(\)\.post/u);
  assert.match(source, /stream\?\.getTracks\?\.\(\)\.forEach/u);
  assert.match(source, /currentSession\.mode === 'voice'[\s\S]{0,120}form\.style\.display = 'none'/u);
});

test('a discovery-required session requests and renders provisional trusted sources in the same sheet', () => {
  assert.match(source, /if \(result\.discovery_required\) await discoverMissingRule\(result, operation\)/u);
  assert.match(source, /discoverMissingRule[\s\S]*\/api\/v1\/voice-tutor\/rule-discoveries/u);
  assert.match(source, /session_id:\s*result\.session\.id/u);
  assert.match(source, /voiceTutorSources/u);
  assert.match(source, /result\?\.provisional/u);
  assert.match(source, /sourceLink\.textContent/u);
  assert.doesNotMatch(source, /sourceLink\.innerHTML/u);
});

test('the shared sheet exposes bounded transient clarification and structured learner reports only', () => {
  assert.match(source, /\/clarifications/u);
  assert.match(source, /explain_differently/u);
  assert.match(source, /voiceTutorExplainDifferently/u);
  assert.match(source, /\/api\/v1\/voice-tutor\/reports/u);
  for (const reason of ['incorrect_rule', 'unclear_explanation', 'bad_example', 'technical_issue']) {
    assert.match(source, new RegExp(reason, 'u'));
  }
  assert.doesNotMatch(source, /reports[\s\S]{0,180}(?:message|comment|details):/u);
});

test('reading and listening result screens register completed canonical sets before mounting the shared bottom-sheet trigger', () => {
  assert.match(readingSource, /import \{prepareVoiceTutorContextResult,registerVoiceTutorContextResult\} from '\.\.\/voice-tutor\.js'/u);
  assert.match(readingSource, /reading\.gap-year\.before-university/u);
  assert.match(readingSource, /reading\.exam\.questions\.gap-year/u);
  assert.match(readingSource, /generateAiContent\('reading_questions'\)[\s\S]*d\.voice_tutor[\s\S]*voice:\{id:String\(voice\.item_ids\[i\]\),revision:1\}/u);
  assert.match(readingSource, /function rExamFinish\(\)[\s\S]*prepareVoiceTutorContextResult[\s\S]*registerVoiceTutorContextResult\(voiceResult\)/u);
  assert.match(readingSource, /function rQsRender\(\)[\s\S]*prepareVoiceTutorContextResult[\s\S]*registerVoiceTutorContextResult\(voiceResult\)/u);

  assert.match(listeningSource, /import \{prepareVoiceTutorContextResult,registerVoiceTutorContextResult\} from '\.\.\/voice-tutor\.js'/u);
  assert.match(listeningSource, /listening\.alex-swimming\.reason/u);
  assert.match(listeningSource, /listening\.exam\.interview\.alex/u);
  assert.match(listeningSource, /generateAiContent\('listening_interview'\)[\s\S]*d\.voice_tutor[\s\S]*voice:\{id:String\(voice\.item_ids\[i\]\),revision:1\}/u);
  assert.match(listeningSource, /function lExamFinish\(\)[\s\S]*prepareVoiceTutorContextResult[\s\S]*registerVoiceTutorContextResult\(voiceResult\)/u);
  assert.match(listeningSource, /function lIqCheck\(\)[\s\S]*prepareVoiceTutorContextResult[\s\S]*registerVoiceTutorContextResult\(voiceResult\)/u);

  for (const screenSource of [readingSource, listeningSource]) {
    assert.doesNotMatch(screenSource, /sourceExcerpt|transcriptSegment|reference:/u);
  }
});
