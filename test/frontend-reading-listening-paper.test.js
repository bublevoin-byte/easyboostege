import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

const [html, styles, reading, listening, serviceWorker, app] = await Promise.all([
  fs.readFile(new URL('../public/index.html', import.meta.url), 'utf8'),
  fs.readFile(new URL('../public/reading-listening.css', import.meta.url), 'utf8'),
  fs.readFile(new URL('../public/screens/reading.js', import.meta.url), 'utf8'),
  fs.readFile(new URL('../public/screens/listening.js', import.meta.url), 'utf8'),
  fs.readFile(new URL('../public/service-worker.js', import.meta.url), 'utf8'),
  fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
]);

function screenMarkup(id) {
  const start = html.indexOf(`<div class="screen" id="${id}"`);
  assert.notEqual(start, -1, `missing ${id}`);
  const end = html.indexOf('<div class="screen"', start + 1);
  return html.slice(start, end === -1 ? html.length : end);
}

test('Reading and Listening use one tokenized paper grid with a safe action dock', () => {
  assert.match(html, /<link rel="stylesheet" href="\/reading-listening\.css">/u);
  assert.match(serviceWorker, /'\/reading-listening\.css'/u);
  for (const [id, prefix] of [['scr4', 'l'], ['scr7', 'r']]) {
    const markup = screenMarkup(id);
    assert.match(markup, /<main class="learning-route/u);
    assert.equal((markup.match(/<main\b/gu) || []).length, 1, `${id} owns one main landmark`);
    assert.equal((markup.match(/<h1\b/gu) || []).length, 1, `${id} owns one level-one heading`);
    assert.match(markup, new RegExp(`id="${prefix}_area" class="learning-route__content"`, 'u'));
    assert.match(markup, new RegExp(`id="${prefix}_action_dock" class="learning-action-dock"`, 'u'));
    assert.doesNotMatch(markup, /9:41|navclay|position:absolute;top:236px|linear-gradient/u);
  }
  assert.match(styles, /grid-template-rows:\s*max-content max-content minmax\(0, 1fr\) max-content/u);
  assert.match(styles, /@media \(orientation: landscape\) and \(max-height: 420px\)/u);
  assert.match(styles, /env\(safe-area-inset-bottom\)/u);
  assert.match(styles, /min-block-size:\s*var\(--aisy-button-height\)/u);
  assert.doesNotMatch(styles, /#[0-9a-f]{3,8}\b|rgba?\(/iu,
    'migrated Reading/Listening component rules consume semantic tokens only');
  assert.doesNotMatch(reading, /<main\b|<h1\b/u, 'Reading renderers must not nest a second main or h1');
  assert.doesNotMatch(listening, /<main\b|<h1\b/u, 'Listening renderers must not nest a second main or h1');
  assert.doesNotMatch(app, /background:#FFEDE4|background:#EAF7F0/u,
    'Reading word states must not leak light-only inline palettes');
  assert.match(app, /reading-word--learning/u);
  assert.match(app, /reading-word--known/u);
  assert.match(app, /aria-label=/u);
  assert.match(styles, /\.reading-word--learning[^}]+var\(--aisy-color-warning-soft\)[^}]+var\(--aisy-color-text-strong\)/u);
  assert.match(styles, /\.reading-word--known[^}]+var\(--aisy-color-success-soft\)[^}]+var\(--aisy-color-text-strong\)/u);
  assert.match(styles, /\.reading-text \.iconbtn,[^}]+min-inline-size:\s*var\(--aisy-touch-target\)[^}]+padding:\s*0/u,
    'word controls retain a real target without inflating every visible word by inline padding');
});

test('Reading and Listening expose semantic answer, playback and non-color review states', () => {
  assert.match(reading, /role="radiogroup"/u);
  assert.match(reading, /aria-checked=/u);
  assert.match(reading, /is-selected/u);
  assert.match(reading, /is-correct/u);
  assert.match(reading, /is-incorrect/u);
  assert.match(reading, /Верно/u);
  assert.match(reading, /Ошибка/u);

  assert.match(listening, /role="radiogroup"/u);
  assert.match(listening, /aria-checked=/u);
  assert.match(listening, /aria-label="Остановить воспроизведение"/u);
  assert.match(listening, /aria-label="Приостановить воспроизведение"/u);
  assert.match(listening, /lRadioKey/u);
  assert.match(listening, /data-audio-state/u);
  assert.match(app, /Буферизация|Загружаем запись/u);
  assert.match(app, /Играет/u);
  assert.match(app, /Приостановлено/u);
  assert.match(listening, /Остановлено/u);
  assert.match(app, /Ошибка воспроизведения/u);
  assert.match(styles, /listening-audio__slow\[aria-pressed="true"\]/u);
  assert.match(reading, /function focusViewHeading\(\)/u);
  assert.match(reading, /container\.scrollTop=0;heading\.tabIndex=-1/u);
  assert.match(reading, /else if\(animate\)focusViewHeading\(\)/u);
  assert.match(listening, /function lFocusViewHeading\(\)/u);
  assert.match(listening, /container\.scrollTop=0;heading\.tabIndex=-1/u);
  assert.match(listening, /else if\(animate\)lFocusViewHeading\(\)/u);
});

test('late Reading and Listening work is bound to one owner generation and current route', () => {
  assert.match(reading, /readingRequestCurrent/u);
  assert.match(reading, /apiResponseOwner/u);
  assert.match(reading, /X-EasyBoost-Expected-Owner/u);
  assert.match(listening, /lRequestCurrent/u);
  assert.match(listening, /X-EasyBoost-Expected-Owner/u);
  assert.match(listening, /isCurrent/u);
});

test('offline copy distinguishes loading, cache-ready, cache-required and playback cache truth', () => {
  for (const source of [reading, listening]) {
    assert.match(source, /['"]loading['"]/u);
    assert.match(source, /['"]offline['"]/u);
    assert.match(source, /['"]cache-ready['"]/u);
    assert.match(source, /['"]cache-required['"]/u);
    assert.match(source, /['"]error['"]/u);
  }
  assert.match(reading, /результаты останутся в очереди владельца до подключения/u);
  assert.match(listening, /запись доступна без сети только после первого успешного воспроизведения/u);
  assert.match(styles, /data-network-state="cache-ready"/u);
  assert.match(listening, /lSync\(\);lProgress\(0,1,'Загрузка каталогов аудирования'\)/u,
    'historical accuracy is normalized before the explicit zero-state catalog loader progress');
});
