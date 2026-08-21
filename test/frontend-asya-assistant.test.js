import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

import {
  ASYA_SESSION_STATES,
  authorizeAsyaRequest,
  classifyAsyaRequest,
  createAsyaConversation,
  exactWakeName,
  installAsyaAssistant,
  projectAsyaContext,
  reduceAsyaConversation,
} from '../public/asya-assistant.js';

test('exact wake name starts one bounded conversation and follow-up turns need no repeated name', () => {
  let conversation = createAsyaConversation({ now: 1_000, timeoutMs: 60_000 });
  conversation = reduceAsyaConversation(conversation, { type: 'open' }, 1_010);
  conversation = reduceAsyaConversation(conversation, { type: 'accept-disclosure' }, 1_020);
  conversation = reduceAsyaConversation(conversation, { type: 'microphone-on' }, 1_030);

  const ignored = reduceAsyaConversation(conversation, { type: 'speech', text: 'Алиса, помоги' }, 1_040);
  assert.equal(ignored.active, false);
  assert.equal(ignored.state, 'listening');

  conversation = reduceAsyaConversation(ignored, { type: 'speech', text: 'Ася, объясни правило' }, 1_050);
  assert.equal(conversation.active, true);
  assert.equal(conversation.state, 'transmitting');

  conversation = reduceAsyaConversation(conversation, { type: 'ready' }, 1_060);
  conversation = reduceAsyaConversation(conversation, { type: 'speech', text: 'А можно ещё пример?' }, 1_070);
  assert.equal(conversation.active, true);
  assert.equal(conversation.state, 'transmitting');
});

test('wake matching rejects other names and every bounded exit requires wake name again', () => {
  assert.equal(exactWakeName('Настя, помоги'), false);
  assert.equal(exactWakeName('Алиса'), false);
  assert.equal(exactWakeName('Ксюша, Ася, помоги'), false);
  assert.equal(exactWakeName('Ася'), true);
  assert.equal(exactWakeName('  АСЯ — помоги'), true);
  assert.deepEqual(ASYA_SESSION_STATES, ['off', 'listening', 'transmitting', 'paused', 'error']);

  for (const exitType of ['finish', 'leave', 'microphone-off', 'timeout']) {
    let conversation = createAsyaConversation({ now: 1_000, timeoutMs: 10_000 });
    for (const event of [
      { type: 'open' }, { type: 'accept-disclosure' }, { type: 'microphone-on' },
      { type: 'speech', text: 'Ася, начнём' }, { type: 'ready' },
    ]) conversation = reduceAsyaConversation(conversation, event, conversation.lastActivityAt + 1);
    conversation = reduceAsyaConversation(conversation, { type: exitType }, 2_000);
    assert.equal(conversation.active, false, exitType);
    assert.equal(conversation.microphoneEnabled, false, exitType);
    const withoutWake = reduceAsyaConversation(conversation, { type: 'speech', text: 'Продолжим' }, 2_010);
    assert.equal(withoutWake.active, false, exitType);
  }
});

test('diagnostic and full mock refuse answer help while keeping technical timer and navigation help', () => {
  const diagnostic = projectAsyaContext({ screenId: 'scr10', diagnosticActive: true });
  const mock = projectAsyaContext({ screenId: 'scr16', mockActive: true });
  const practice = projectAsyaContext({ screenId: 'scr3' });

  for (const strict of [diagnostic, mock]) {
    assert.equal(strict.answerHelpAllowed, false);
    assert.deepEqual(authorizeAsyaRequest(strict, { kind: 'answer' }), {
      allowed: false,
      reason: 'В диагностике и полном пробнике Ася не подсказывает ответы. Могу помочь с таймером, навигацией или технической ошибкой.',
    });
    assert.equal(authorizeAsyaRequest(strict, { kind: 'timer' }).allowed, true);
    assert.equal(authorizeAsyaRequest(strict, { kind: 'navigation' }).allowed, true);
    assert.equal(authorizeAsyaRequest(strict, { kind: 'technical' }).allowed, true);
  }
  assert.equal(practice.answerHelpAllowed, true);
  assert.equal(authorizeAsyaRequest(practice, { kind: 'answer' }).allowed, true);
});

test('typed and keyboard alternatives classify strict-safe requests without sending content anywhere', () => {
  assert.equal(typeof installAsyaAssistant, 'function');
  assert.equal(classifyAsyaRequest('Сколько осталось на таймере?').kind, 'timer');
  assert.equal(classifyAsyaRequest('Как вернуться в раздел?').kind, 'navigation');
  assert.equal(classifyAsyaRequest('Микрофон не работает').kind, 'technical');
  assert.equal(classifyAsyaRequest('Какой здесь правильный ответ?').kind, 'answer');
});

test('assistant surface is contextual, token-driven, offline-safe and makes no persistence or provider calls', async () => {
  const [source, launcher, styles, main, markup, worker, privacy] = await Promise.all([
    fs.readFile(new URL('../public/asya-assistant.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../public/asya-launcher.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../public/asya-assistant.css', import.meta.url), 'utf8'),
    fs.readFile(new URL('../public/main.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../public/index.html', import.meta.url), 'utf8'),
    fs.readFile(new URL('../public/service-worker.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../public/privacy.html', import.meta.url), 'utf8'),
  ]);

  assert.match(source, /id = 'asya-assistant'/u);
  assert.match(source, /role', 'dialog'/u);
  assert.match(source, /aria-live="polite"/u);
  assert.match(source, /Alt\+A/u);
  assert.match(source, /id="asya-microphone" class="aisy-button asya-assistant__microphone"/u);
  assert.match(source, /type="submit" class="aisy-button aisy-button--secondary"/u);
  assert.match(source, /id="asya-finish" class="aisy-button aisy-button--secondary asya-assistant__finish"/u);
  assert.match(source, /close\('finish', \{ restoreFocus: false \}\)/u);
  assert.match(source, /только в открытом приложении/iu);
  assert.match(source, /передаётся внешнему AI-провайдеру/iu);
  assert.match(source, /полный transcript не сохраняются/iu);
  assert.doesNotMatch(source, /localStorage|sessionStorage|indexedDB|fetch\(|api\(|WebSocket|SpeechRecognition/u);
  assert.match(styles, /min-(?:width|height):\s*var\(--aisy-touch-target\)/u);
  assert.match(styles, /right:\s*calc\(var\(--aisy-space-4\) \+ env\(safe-area-inset-right\)\)/u);
  assert.match(styles, /padding-inline:\s*calc\(var\(--aisy-space-4\) \+ env\(safe-area-inset-left\)\)\s+calc\(var\(--aisy-space-4\) \+ env\(safe-area-inset-right\)\)/u);
  assert.doesNotMatch(styles, /padding:\s*(?:9|10|11|14|20)px|margin:\s*0 0 2px/u);
  assert.doesNotMatch(styles, /#[0-9a-f]{3,8}\b/iu);
  assert.match(main, /installAsyaLauncher/u);
  assert.doesNotMatch(main, /installAsyaAssistant/u);
  assert.match(launcher, /import\('\.\/asya-assistant\.js'\)/u);
  assert.match(markup, /href="\/asya-assistant\.css"/u);
  for (const path of ['/asya-assistant.css', '/asya-assistant.js']) assert.match(worker, new RegExp(`'${path}'`, 'u'));
  assert.match(privacy, /имя «Ася»[\s\S]*?работает[\s\S]*?открыто/iu);
  assert.doesNotMatch(source, /OS-wide|background wake|Siri|Алиса/u);
});
