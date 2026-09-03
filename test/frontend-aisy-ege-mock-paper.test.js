import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

const [markup, styles, hubStyles, screen, shell, worker, packageSource] = await Promise.all([
  fs.readFile(new URL('../public/index.html', import.meta.url), 'utf8'),
  fs.readFile(new URL('../public/ege-mock.css', import.meta.url), 'utf8'),
  fs.readFile(new URL('../public/ege-hub.css', import.meta.url), 'utf8'),
  fs.readFile(new URL('../public/screens/ege-mock.js', import.meta.url), 'utf8'),
  fs.readFile(new URL('../public/aisy-shell.js', import.meta.url), 'utf8'),
  fs.readFile(new URL('../public/service-worker.js', import.meta.url), 'utf8'),
  fs.readFile(new URL('../package.json', import.meta.url), 'utf8'),
]);

function screenBlock(id) {
  const start = markup.indexOf(`<div class="screen" id="${id}"`);
  const next = markup.indexOf('<div class="screen" id="', start + 1);
  assert.ok(start >= 0 && next > start, `${id} block exists`);
  return markup.slice(start, next);
}

test('strict EGE presentation is external, token-only Paper A and install cached', () => {
  const strict = screenBlock('scr16');
  const inline = markup.slice(markup.indexOf('<style>'), markup.indexOf('</style>'));
  assert.match(markup, /<link rel="stylesheet" href="\/ege-mock\.css">/u);
  assert.doesNotMatch(inline, /\.ege-mock/u);
  assert.doesNotMatch(strict, /\bstyle=|(?:linear|radial)-gradient\(/iu);
  assert.doesNotMatch(styles, /#[0-9a-f]{3,8}\b|rgba?\(|(?:linear|radial)-gradient\(/iu);
  assert.doesNotMatch(hubStyles, /#[0-9a-f]{3,8}\b|rgba?\(|(?:linear|radial)-gradient\(/iu);
  assert.match(styles, /var\(--aisy-color-background\)/u);
  assert.match(styles, /var\(--aisy-color-surface-raised\)/u);
  assert.match(styles, /var\(--aisy-color-text\)/u);
  assert.match(worker, /['"]\/ege-mock\.css['"]/u);
});

test('strict EGE owns one accessible deep header and a Paper confirmation', () => {
  const strict = screenBlock('scr16');
  assert.equal((strict.match(/aria-label="Назад в раздел ЕГЭ"/gu) || []).length, 1);
  assert.match(strict, /<dialog id="ege_mock_confirm_dialog"[^>]+aria-labelledby="ege_mock_confirm_title"[^>]+aria-describedby="ege_mock_confirm_copy"/u);
  assert.match(strict, /id="ege_mock_confirm_cancel"/u);
  assert.match(strict, /id="ege_mock_confirm_accept"[^>]+class="aisy-button ege-mock__confirm-primary"/u);
  assert.match(shell, /EXAM_CHROME_SCREENS/u);
  assert.match(shell, /ownsDeepChrome/u);
  assert.match(screen, /showModal\(\)/u);
  assert.match(screen, /event\.key !== ["']Tab["']/u);
  assert.match(screen, /event\.key === ["']Escape["']/u);
  assert.doesNotMatch(screen, /window\.confirm|\bconfirm\(/u);
});

test('strict EGE keeps canonical CTA anatomy, grouped answers and non-colour state copy', () => {
  assert.match(styles, /\.ege-mock__action--primary\s*\{[^}]*min-block-size:\s*var\(--aisy-button-height\)[^}]*border-radius:\s*var\(--aisy-button-radius\)[^}]*padding:\s*0 var\(--aisy-button-padding-end\) 0 var\(--aisy-button-padding-start\)/su);
  assert.match(styles, /\.ege-mock__action--primary::after\s*\{[^}]*inline-size:\s*var\(--aisy-button-affordance-size\)[^}]*block-size:\s*var\(--aisy-button-affordance-size\)/su);
  assert.match(screen, /<fieldset class="ege-mock__field ege-mock__choice-group">[\s\S]*?<legend/u);
  assert.match(screen, /ege-mock__timer-warning-label/u);
  assert.match(screen, /Осталось[^<]*мин/u);
  assert.match(screen, /data-state="(?:warning|error|success|locked|submitted)"/u);
});

test('strict EGE guards delayed hub navigation and stale answer delivery', async () => {
  const hub = await fs.readFile(new URL('../public/screens/ege-hub.js', import.meta.url), 'utf8');
  assert.match(hub, /const originRevision = loadRevision/u);
  assert.match(hub, /strictMockIntentStillCurrent/u);
  assert.match(hub, /ownerKey/u);
  assert.match(hub, /Не удалось открыть пробник/u);
  assert.match(hub, /Перезагрузить приложение/u);
  assert.match(hub, /window\.location\.reload\(\)/u);
  assert.match(screen, /captureAnswerOperation/u);
  assert.match(screen, /answerOperationCurrent/u);
  assert.match(screen, /handleAnswer\(input, operation\)/u);
  assert.match(screen, /renderedPresentationPhase/u);
  assert.match(screen, /commitPresentationPhase\(presentationPhase\)/u);
  assert.match(screen, /screen\.scrollTo\(\{ top: 0, left: 0, behavior: 'auto' \}\)/u);
  assert.match(screen, /refreshRunningProjection\(snapshot\)/u);
});

test('strict EGE release gate includes the migrated hub and every full mock contour', () => {
  const pkg = JSON.parse(packageSource);
  assert.match(pkg.scripts['test:e2e:ege-mock'], /aisy-ege-hub\.test\.js/u);
  for (const name of ['ege-mock-written', 'ege-mock-oral', 'ege-mock-result', 'ege-mock-release']) {
    assert.match(pkg.scripts['test:e2e:ege-mock'], new RegExp(`${name}\\.test\\.js`, 'u'));
  }
});

test('strict EGE covers phone, short landscape, dark tokens and reduced motion', () => {
  assert.match(styles, /@media\s*\(max-width:\s*359px\)/u);
  assert.match(styles, /@media\s*\(orientation:\s*landscape\)\s*and\s*\(max-height:\s*420px\)/u);
  assert.match(styles, /@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*transform:\s*none\s*!important/u);
  assert.match(styles, /env\(safe-area-inset-(?:top|bottom|left|right)\)/u);
  assert.match(styles, /font-size:\s*var\(--aisy-font-size-body\)/u);
});
