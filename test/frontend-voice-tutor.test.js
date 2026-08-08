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

  const pronunciationMarkup = voiceTutorButton({
    profile: { entitlements: { voice_tutor: true } }, source: 'speaking',
    attemptId: 501, revision: 1,
    pronunciationError: {
      ref: 'phoneme.501.0.0', label: 'Фонема /w/ в слове «weather»',
    },
  });
  assert.match(pronunciationMarkup, /data-source="speaking"/u);
  assert.match(pronunciationMarkup, /data-pronunciation-error-ref="phoneme\.501\.0\.0"/u);
  assert.match(pronunciationMarkup, /Разобрать: Фонема \/w\/ в слове «weather»/u);
  assert.equal(pronunciationMarkup.includes('data-criterion-index'), false);
});

test('writing and speaking reviews mount the shared tutor and keep only server-issued pointers in the DOM', () => {
  const fullSpeakingSource = speakingSource.slice(
    speakingSource.indexOf('function spExam'),
    speakingSource.indexOf('/* ---- фоновая ИИ-генерация комплектов говорения ---- */'),
  );

  assert.match(writingSource, /import \{voiceTutorButton\} from '\.\.\/voice-tutor\.js'/u);
  assert.match(writingSource, /renderReview\(d,response\.evaluationScope,response\.voiceTutor\)/u);
  assert.match(writingSource, /voiceTutorButton\(voiceTutor\)/u);

  assert.match(speakingSource, /import \{voiceTutorButton\} from '\.\.\/voice-tutor\.js'/u);
  assert.doesNotMatch(speakingSource, /spShowEval\(d,tr,response\.voiceTutor\)/u,
    'the evaluation response must not authorize a Voice Tutor control after the subscription can change');
  assert.match(speakingSource, /freshVoiceReport=await apiGet\('\/api\/v1\/speaking\/learning-report'\)/u,
    'the evaluation screen must re-read fresh server entitlements before mounting Voice Tutor');
  assert.match(speakingSource, /freshVoiceReport\.premium&&freshVoiceReport\.premium\.voiceTutor/u);
  assert.match(speakingSource, /voiceTutorButton\(voiceTutor\)/u);
  assert.match(speakingSource, /profile:\{entitlements:\{voice_tutor:true\}\}/u,
    'fresh report.premium must authorize its own Voice Tutor control');
  assert.match(speakingSource, /contentRef:targetedPractice\.contentRef/u,
    'the browser must replay the exact server-issued pronunciation target reference');
  assert.match(speakingSource, /reportRevision:targetedPractice\.reportRevision/u);
  assert.match(speakingSource, /accentLocale:targetedPractice\.accentLocale\|\|null/u);
  assert.match(speakingSource, /criterionDynamics/u);
  assert.match(speakingSource, /fluencyDynamics/u);
  assert.match(speakingSource, /pauseDynamics/u);
  assert.match(speakingSource, /unexpectedBreakCount/u);
  assert.match(speakingSource, /missingBreakCount/u);
  assert.match(speakingSource, /currentReliableAccentLocale/u);
  assert.match(speakingSource, /report\.activeAccentLocale/u);
  assert.match(speakingSource, /voice\.criterion/u);
  assert.match(speakingSource, /voice\.pronunciationError/u);
  assert.match(speakingSource, /voice\.attemptSummary\.attemptId===voice\.attemptId/u);
  assert.doesNotMatch(speakingSource, /voice&&\(current\.criteria\|\|\[\]\)\[voice\.criterionIndex\]/u);
  assert.match(speakingSource, /comparison\.accentLocale/u);
  assert.match(speakingSource, /item\.direction/u);
  assert.match(speakingSource, /улучшение/u);
  assert.match(speakingSource, /снижение/u);
  assert.match(speakingSource, /personalSummary/u);
  const learningReportSource = speakingSource.slice(
    speakingSource.indexOf('function spLearningReportMarkup'),
    speakingSource.indexOf('function spStartTargetedPractice'),
  );
  assert.match(learningReportSource, /current\.transcript/u,
    'the persistent Base/Premium report must render the latest transcript after navigation or reload');
  assert.match(learningReportSource, /Расшифровка/u);
  assert.match(learningReportSource, /spSpeakingSkillLabel/u);
  assert.match(learningReportSource, /item\.focus/u);
  assert.match(learningReportSource, /item\.offsetSeconds/u);
  assert.match(learningReportSource, /item\.durationSeconds/u);
  assert.match(learningReportSource, /Ответ /u);
  assert.doesNotMatch(learningReportSource, /\(current\.wordIssues\|\|\[\]\)\.slice/u,
    'Base must not truncate the bounded server word-issue list');
  assert.match(speakingSource, /Прямые вопросы/u);
  assert.match(speakingSource, /слово «/u);
  assert.match(speakingSource, /фонема \//u);
  assert.doesNotMatch(learningReportSource, /return item\.skillId/u,
    'Premium must show a localized label instead of an internal adaptive skill id');
  assert.match(speakingSource, /targetedPractice/u);
  assert.doesNotMatch(speakingSource, /гарантированно новый материал/u);
  assert.doesNotMatch(fullSpeakingSource, /(?:evaluate-speaking|spSTT\(|voiceTutorButton\()/u);
  assert.doesNotMatch(speakingSource, /voiceTutor&&d\.got<d\.max/u,
    'a max-score review must still render its server-issued pronunciation control');

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
  assert.match(readingSource, /readingModule\.voiceSet\(item\.set\)/u);
  assert.match(readingSource, /function renderFullResult\(\)[\s\S]*KINDS\.map[\s\S]*readingModule\.voiceSet[\s\S]*prepareVoiceTutorContextResult[\s\S]*KINDS\.forEach[\s\S]*registerVoiceTutorContextResult/u);
  assert.match(readingSource, /function renderTrainingResult\(\)[\s\S]*prepareVoiceTutorContextResult[\s\S]*registerVoiceTutorContextResult\(voiceResult\)/u);
  assert.doesNotMatch(readingSource, /generateAiContent\('reading_questions'/u);

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
