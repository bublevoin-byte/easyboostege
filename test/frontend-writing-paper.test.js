import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

const [screen, markup, styles, aiRoute, taskRoute, worker, screens] = await Promise.all([
  fs.readFile(new URL('../public/screens/writing.js', import.meta.url), 'utf8'),
  fs.readFile(new URL('../public/index.html', import.meta.url), 'utf8'),
  fs.readFile(new URL('../public/writing.css', import.meta.url), 'utf8'),
  fs.readFile(new URL('../routes/ai.js', import.meta.url), 'utf8'),
  fs.readFile(new URL('../routes/tasks.js', import.meta.url), 'utf8'),
  fs.readFile(new URL('../public/service-worker.js', import.meta.url), 'utf8'),
  fs.readFile(new URL('../public/screens.js', import.meta.url), 'utf8'),
]);

function screenBlock(id, nextId) {
  const start = markup.indexOf(`<div class="screen" id="${id}"`);
  const end = markup.indexOf(`<div class="screen" id="${nextId}"`, start);
  assert.ok(start >= 0 && end > start, `${id} block must exist`);
  return markup.slice(start, end);
}

test('Writing uses one Paper A route, semantic editor and no legacy local chrome', () => {
  const writing = screenBlock('scr8', 'scr9');
  const review = screenBlock('scr12', 'scr13');
  const waiting = screenBlock('scr13', 'scr10');

  assert.match(markup, /<link rel="stylesheet" href="\/writing\.css">/u);
  assert.match(writing, /<main class="learning-route writing-route"/u);
  assert.match(writing, /<label[^>]+for="w_editor"[^>]*>Письменный ответ<\/label>/u);
  assert.match(writing, /<textarea[^>]+id="w_editor"[^>]+aria-describedby="w_count w_draft_status w_editor_error"/u);
  assert.doesNotMatch(writing, /<textarea[^>]+(?:aria-label|role="textbox")/u,
    'the native textarea receives its accessible name from the visible label');
  assert.match(writing, /id="writing_action_dock" class="learning-action-dock[^"]*"/u);
  assert.equal((markup.match(/id="w_action_dock"/gu)||[]).length, 1,
    'the vocabulary dock keeps its legacy ID without colliding with Writing');
  assert.match(writing, /id="writing_primary_action"[^>]+class="aisy-button/u);
  assert.doesNotMatch(writing, /id="w_primary_action"/u,
    'Writing must not collide with the Vocabulary primary action created at runtime');
  assert.match(review, /id="rv_content"/u);
  assert.match(review, /id="rv_status"[^>]+role="status"[^>]+aria-live="polite"/u);
  assert.match(waiting, /aria-busy="true"/u);
  assert.match(waiting, /id="writing_waiting_summary"[^>]*>Готовим безопасную отправку ответа/u);
  assert.match(waiting, /id="writing_waiting_title"[^>]*>Готовим проверку/u);
  assert.doesNotMatch(`${writing}${review}${waiting}`, /9:41|navclay|linear-gradient|Сохранить в прогресс|~15 секунд/u);
  assert.doesNotMatch(`${writing}${review}${waiting}`, /style="/u);
});

test('Writing confirmations, task disclosure and threshold feedback are semantic and keyboard reachable', () => {
  const writing = screenBlock('scr8', 'scr9');
  assert.match(writing, /id="w_limit_status" class="aisy-visually-hidden" role="status" aria-live="polite" aria-atomic="true"/u);
  assert.match(markup, /<dialog id="writing_confirm_dialog"[^>]+aria-labelledby="writing_confirm_title"[^>]+aria-describedby="writing_confirm_copy"/u);
  assert.match(markup, /id="writing_confirm_cancel"/u);
  assert.match(markup, /id="writing_confirm_accept"[^>]+class="aisy-button writing-primary"/u);
  assert.match(screen, /showModal\(\)/u);
  assert.match(screen, /event\.key==='Tab'/u);
  assert.match(screen, /event\.key==='Escape'/u);
  assert.doesNotMatch(screen, /window\.confirm|\bconfirm\(/u);
  assert.match(screen, /aria-controls="w_guide"/u);
  assert.match(screen, /aria-expanded="'\+String\(W_SHEET\)\+'"/u);
  assert.match(screen, /restoreFocus/u);
});

test('Writing keeps a single shell Back, one primary dock action and exact CTA anatomy', () => {
  assert.doesNotMatch(screenBlock('scr8', 'scr9'), /onclick="back\(|aria-label="Назад/u);
  assert.doesNotMatch(screenBlock('scr12', 'scr13'), /onclick="back\(|aria-label="Назад/u);
  assert.match(styles, /\.writing-primary[\s\S]*min-block-size:\s*var\(--aisy-button-height\)/u);
  assert.match(styles, /\.writing-primary[\s\S]*border-radius:\s*var\(--aisy-button-radius\)/u);
  assert.match(styles, /\.writing-primary[\s\S]*padding:\s*0 var\(--aisy-button-padding-end\) 0 var\(--aisy-button-padding-start\)/u);
  assert.match(styles, /@media \(max-height: 420px\)/u);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/u);
  assert.match(styles, /padding-block-end:\s*max\([^;]*env\(safe-area-inset-bottom\)\)/u,
    'the compact dock retains the device safe-area inset');
  assert.match(styles, /#rv_edit_action\[hidden\] \+ #rv_primary_action[\s\S]*grid-column:\s*1 \/ -1/u);
  assert.match(styles, /\.writing-confirm__actions\s*\{[^}]*grid-template-columns:\s*1fr/u,
    'the Paper confirmation gives its canonical primary CTA a full-width row at every phone width');
  assert.doesNotMatch(styles, /\.writing-confirm__actions \.aisy-button\s*\{[^}]*min-block-size:\s*48px/u,
    'the compact cancel height must not shrink the canonical primary CTA');
  assert.match(styles, /\.writing-confirm__actions \.aisy-button--secondary\s*\{[^}]*min-block-size:\s*48px/u);
  assert.doesNotMatch(styles, /#[0-9a-f]{3,8}\b/iu, 'migrated Writing CSS consumes semantic tokens only');
});

test('Writing late task and evaluation responses are owner and view bound', () => {
  assert.match(screen, /currentOwnerBinding/u);
  assert.match(screen, /apiResponseOwner/u);
  assert.match(screen, /X-EasyBoost-Expected-Owner/u);
  assert.match(screen, /writingModule\.requestIsCurrent/u);
  assert.match(screen, /registerAuthorityReset/u);
  assert.match(screen, /apiPostIdempotent\('\/api\/v1\/ai\/evaluate-writing'/u);
  assert.match(screen, /SUBMISSION/u);
  assert.match(screen, /localStorage/u, 'ambiguous evaluation retries survive reload and PWA process loss with the same key');
  assert.match(screen, /sameEvaluationPayload/u);
  assert.match(screen, /runEvaluationTransaction/u, 'the retry identity and network request share one owner Web Lock');
  assert.match(screen, /terminalAt/u, 'cross-tab waiters can distinguish a settled predecessor from a new retry');
  assert.match(screen, /retireOldestEvaluation/u, 'a full bounded envelope store has an explicit recovery path');
  assert.match(screen, /RETIRE_PENDING/u, 'record retirement is reentrancy guarded');
  assert.match(screen, /requestCurrent\(request,new Set\(\['scr12'\]\)\)/u,
    'record retirement is scoped to the current review generation');
  assert.match(screen, /SUBMIT_PREFLIGHT=\{run,state,authority,payload,promise\}/u,
    'preflight ownership is scoped and can be replaced by a new authority');
  assert.match(screen, /editor\?\.dataset\.draftKey!==draftKey/u,
    'delayed draft announcements are scoped to the exact visible draft');
  assert.match(screen, /validEvaluationResponse/u, 'only a complete bounded server contract can become evidence');
  assert.match(screen, /response\.writingProgress/u, 'Writing history is replaced by server-authoritative progress');
  assert.match(screen, /canCommit/u, 'a response that arrived after leaving the view keeps its exact recovery key');
  assert.match(screen, /MAX_WRITING_DUPLICATE_DRAIN/u, 'duplicate bank deliveries are drained with a finite bound');
  assert.match(screen, /focusWritingRoute/u, 'route changes move focus out of hidden Writing DOM');
  assert.doesNotMatch(screen, /localReview\(/u, 'client failures must never render local scored evidence');
});

test('Writing draft and waiting copy never overclaim persistence or provider dispatch', () => {
  assert.doesNotMatch(markup, /Черновик сохраняется в прогрессе и синхронизируется с аккаунтом/u);
  assert.doesNotMatch(screen, /Черновик сохранён в прогрессе · синхронизация включена/u);
  assert.match(screen, /Черновик сохранён на этом устройстве/u);
  assert.match(screen, /setWaitingPhase\(false\)/u);
  assert.match(screen, /setWaitingPhase\(true\)/u);
  assert.match(screen, /busyNodes\.forEach\(function\(node\)\{node\.setAttribute\('aria-busy','true'\)\}\)/u,
    'preflight keeps the live region busy while its copy is assembled');
  assert.match(screen, /if\(dispatched\)busyNodes\.forEach\(function\(node\)\{node\.setAttribute\('aria-busy','false'\)\}\)/u,
    'actual dispatch releases the live region so its truthful update can be announced');
});

test('Writing HTTP routes require and bind the captured owner', () => {
  assert.match(aiRoute, /function bindRequiredExpectedOwner[\s\S]{0,600}requireExpectedOwner[\s\S]{0,120}bindResponseOwner/u);
  assert.match(aiRoute, /evaluate-writing', auth, bindRequiredExpectedOwner/u);
  assert.match(taskRoute, /function bindRequiredExpectedOwner[\s\S]{0,600}requireExpectedOwner[\s\S]{0,120}bindResponseOwner/u);
  assert.match(taskRoute, /tasks\/next', auth, bindRequiredExpectedOwner/u);
});

test('Writing styles are install-cached while its executable stays lazy', () => {
  assert.match(worker, /['"]\/writing\.css['"]/u);
  const appShell = worker.match(/const APP_SHELL=\[[\s\S]*?\];/u)?.[0] || '';
  assert.doesNotMatch(appShell, /\/screens\/writing\.js/u);
  assert.match(screens, /scr8:function\(\)\{return import\('\.\/screens\/writing\.js'\)\}/u);
});
