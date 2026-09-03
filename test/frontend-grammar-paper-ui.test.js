import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

const index = await fs.readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const screen = await fs.readFile(new URL('../public/screens/grammar.js', import.meta.url), 'utf8');
const styles = await fs.readFile(new URL('../public/grammar.css', import.meta.url), 'utf8');
const serviceWorker = await fs.readFile(new URL('../public/service-worker.js', import.meta.url), 'utf8');
const api = await fs.readFile(new URL('../public/api.js', import.meta.url), 'utf8');
const app = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const aiRoutes = await fs.readFile(new URL('../routes/ai.js', import.meta.url), 'utf8');
const voiceTutor = await fs.readFile(new URL('../public/voice-tutor.js', import.meta.url), 'utf8');
const voiceTutorLoader = await fs.readFile(new URL('../public/voice-tutor-loader.js', import.meta.url), 'utf8');
const voiceTutorRoutes = await fs.readFile(new URL('../routes/voice-tutor.js', import.meta.url), 'utf8');

test('Grammar uses the shared paper route and one safe-area action dock', () => {
  assert.match(index, /<link rel="stylesheet" href="\/grammar\.css">/u);
  assert.match(index, /<main class="grammar-route"[^>]+aria-labelledby="g_header_title"/u);
  assert.match(index, /id="g_area" class="grammar-route__content"/u);
  assert.match(index, /id="g_action_dock" class="grammar-action-dock"/u);
  assert.doesNotMatch(index, /id="scr3"[\s\S]*?status bar white[\s\S]*?<div class="screen" id="scr4"/u);
});

test('Grammar choices select first and submit only through the shared primary action', () => {
  assert.match(screen, /role="radiogroup"/u);
  assert.match(screen, /role="radio"/u);
  assert.match(screen, /function gSelectChoice\(/u);
  assert.match(screen, /function gSubmitChoice\(/u);
  assert.match(screen, /function gChoiceKey\(/u);
  assert.match(screen, /gSetPrimaryAction\('Проверить ответ','gSubmitChoice\(/u);
  assert.doesNotMatch(screen, /function gPick\(btn,i\)[\s\S]{0,320}gAnswer\(/u);
});

test('Grammar styling stays semantic and ships in the offline app shell', () => {
  assert.match(styles, /\.grammar-primary[^}]+min-block-size:\s*var\(--aisy-button-height\)/u);
  assert.match(screen, /class="aisy-choice grammar-choice"/u);
  assert.match(screen, /class="aisy-button aisy-button--secondary grammar-secondary"/u);
  assert.match(screen, /class="aisy-button aisy-button--secondary grammar-rule-button"/u);
  assert.doesNotMatch(styles, /#scr3\s+:where\([^}]+:focus-visible/u,
    'Grammar inherits the shared focus contract instead of defining a parallel ring');
  assert.doesNotMatch(styles, /\.grammar-choice\[aria-checked="true"\]/u);
  assert.doesNotMatch(styles, /\.grammar-choice\.is-(?:correct|incorrect)/u);
  assert.match(styles, /@media \(orientation: landscape\) and \(max-height: 420px\)/u);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/u);
  assert.doesNotMatch(styles, /#[0-9a-f]{3,8}\b|\brgba?\(/iu);
  assert.match(serviceWorker, /'\/grammar\.css'/u);
});

test('Grammar recommendation and generated supplements are owner-generation guarded', () => {
  assert.match(screen, /'X-EasyBoost-Expected-Owner':owner\.username/u);
  assert.match(screen, /gConfirmOwnerResponse\(owner,issued\)/u);
  assert.match(screen, /gConfirmOwnerResponse\(owner,resolved\)/u);
  assert.match(screen, /requestGeneration!==G_EXAM_GENERATION\|\|!gSameOwner\(owner,currentOwnerBinding\(\)\)/u);
  assert.match(screen, /requestGeneration!==G_TOPIC_GENERATION\|\|!gSameOwner\(owner,currentOwnerBinding\(\)\)/u);
  assert.match(screen, /registerAuthorityReset\(/u);
  assert.match(screen, /apiIsAuthorityFailure\(error\)/u);
  assert.match(screen, /generateAiContent\([^\n]+expectedOwnerHeaders/u);
  assert.match(screen, /apiResponseOwner\(payload\)===owner\.username/u);
  assert.match(api, /async function generateContent\(operation, payload = \{\}, headers = \{\}\)/u);
  assert.match(api, /responseOwners\.set\(data, owner\)/u);
  assert.match(app, /function generateAiContent\(operation,payload,headers\)/u);
  assert.match(aiRoutes, /bindOptionalExpectedOwner/u);
  assert.match(aiRoutes, /bindResponseOwner\(res, req\.user\)/u);
});

test('Grammar uses truthful progress, assisted labels, focus visibility and reduced-motion replacement', () => {
  assert.match(screen, /function gSetProgress\(/u);
  assert.match(screen, /Завершено заданий в подходе/u);
  assert.match(screen, /ответ с опорой/u);
  assert.match(screen, /scrollIntoView\(\{block:'nearest',inline:'nearest'\}\)/u);
  assert.match(styles, /@keyframes grammar-paper-enter/u);
  assert.match(styles, /translateX\(16px\)/u);
  assert.match(styles, /@keyframes grammar-paper-fade/u);
  assert.match(styles, /prefers-reduced-motion:[\s\S]+transform:\s*none\s*!important/u);
  assert.match(styles, /\.grammar-copy[^}]+font-size:\s*var\(--aisy-font-size-body\)/u);
  assert.match(styles, /\.grammar-feedback__example[^}]+font-size:\s*var\(--aisy-font-size-body\)/u);
  assert.match(styles, /\.grammar-exam-text[^}]+font-size:\s*var\(--aisy-font-size-body\)/u);
});

test('Grammar review, Voice Tutor and pasted exam answers keep their approved bounded contracts', () => {
  assert.match(screen, /checkedControl\+'<div class="grammar-rule-sheet"[\s\S]+grammar-feedback__example/u,
    'the reusable rule precedes the example in the review sheet');
  assert.match(screen, /registerVoiceTutorError\(details,\{owner:owner\.username\},function\(\)\{return gVoiceRegistrationCurrent/u);
  assert.match(screen, /function gVoiceRegistrationCurrent\(/u);
  assert.match(screen, /maxlength="200"/u);
  assert.match(screen, /id="g_exam_timer" class="grammar-exam-timer">Время:/u);
  assert.doesNotMatch(screen, /id="g_exam_timer"[^>]+aria-(?:label|live)/u,
    'the visible timer value remains its accessible name without becoming a per-second live announcement');
  assert.match(screen, /input\?input\.value:EX\.answers\[index\]\|\|''\)\.slice\(0,200\)/u);
  assert.match(styles, /\.grammar-status[^}]+overflow-wrap:\s*anywhere/u);
  assert.match(voiceTutor, /'X-EasyBoost-Expected-Owner': owner/u);
  assert.match(voiceTutor, /api\(\)\.responseOwner\(result\) !== owner/u);
  assert.match(voiceTutorLoader, /await loadVoiceTutor\(\)[\s\S]+typeof isCurrent==='function'&& !isCurrent\(\)/u);
  assert.match(voiceTutorRoutes, /voice-tutor\/errors'[\s\S]{0,180}requireExpectedOwner\(req, res\)/u);
  assert.match(voiceTutorRoutes, /voice-tutor\/errors'[\s\S]{0,220}bindResponseOwner\(res, req\.user\)/u);
});
