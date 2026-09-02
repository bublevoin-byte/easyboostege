import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

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

function runReadingWordSave(lookupState, translation, {
  selectionOwner = 'owner-a', selectionGeneration = 0, activeOwner = 'owner-a', activeGeneration = 0,
} = {}) {
  const calls = { close: 0, save: 0, upsert: 0, sync: 0, toast: 0 };
  const elements = {
    r_pop: { dataset: { lookupState } },
    r_tr: { textContent: translation },
    r_ipa: { textContent: '/ipa/' },
    r_card: { textContent: 'Many students read every day.' },
  };
  const context = vm.createContext({
    EGE_WORDS: [],
    KINDS: ['task10', 'task11', 'task12_18'],
    S: { personalWords: [], personalWordTombstones: [], wstatus: {} },
    closeReadingWordPopover() { calls.close += 1; },
    document: { getElementById: (id) => elements[id] || null },
    full: null,
    currentOwnerBinding: () => ({ username: activeOwner, generation: activeGeneration }),
    normalizeVocabularyWord: (word) => word,
    personalVocabularyCardId: (word) => `card:${word}`,
    readingDictionarySelection: () => ({
      word: 'many', context: 'Many students read every day.', owner: selectionOwner, ownerGeneration: selectionGeneration,
    }),
    readingModule: { sourceContextFromSets: () => ({ source: 'reading' }) },
    save() { calls.save += 1; },
    srsRecordVocabularyOutcome() {},
    toast() { calls.toast += 1; },
    training: { set: { id: 'set-1' } },
    upsertReadingVocabularyCard(_cards, card) { calls.upsert += 1; calls.card = card; return [card]; },
    wBase: (word) => word,
    wSync() { calls.sync += 1; },
  });
  const source = reading.match(/function r_add\(status\)\{[\s\S]*?\r?\n\}/u)[0];
  vm.runInContext(`${source}\nthis.r_add=r_add;`, context);
  context.r_add('learn');
  return calls;
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

  const popoverStart = html.indexOf('<dialog id="r_pop"');
  const popoverEnd = html.indexOf('<section id="pwa_update"', popoverStart);
  assert.ok(popoverStart > 0 && popoverEnd > popoverStart, 'Reading word popover markup must stay bounded');
  const popover = html.slice(popoverStart, popoverEnd);
  assert.match(popover, /class="reading-word-popover"/u);
  assert.doesNotMatch(popover, /\bstyle=/u,
    'word popover surface, text and controls must be owned by semantic component classes');
  assert.doesNotMatch(popover, /#[0-9a-f]{3,8}\b|rgba?\(/iu,
    'word popover markup must not freeze a light-only palette');
  assert.match(styles, /\.reading-word-popover\s*\{[^}]*background:\s*var\(--aisy-surface-background\)[^}]*box-shadow:\s*var\(--aisy-surface-shadow\)/su);
  assert.match(styles, /\.reading-word-popover__word\s*\{[^}]*color:\s*var\(--aisy-color-text-strong\)/su);
  assert.match(styles, /\.reading-word-popover__icon--speak\s*\{[^}]*background:\s*var\(--aisy-color-warning-soft\)[^}]*color:\s*var\(--aisy-color-warning\)/su);
  assert.match(styles, /\.reading-word-popover__icon--close\s*\{[^}]*background:\s*var\(--aisy-color-surface-muted\)[^}]*color:\s*var\(--aisy-color-text-muted\)/su);
  assert.match(styles, /\.reading-word-popover__action--learn\s*\{[^}]*background:\s*var\(--aisy-color-surface\)[^}]*color:\s*var\(--aisy-color-action-text\)/su);
  assert.match(styles, /\.reading-word-popover__action--known\s*\{[^}]*background:\s*var\(--aisy-color-success-soft\)[^}]*color:\s*var\(--aisy-color-success\)/su);
});

test('Reading word translation keeps the locked production body-size floor', () => {
  assert.match(
    styles,
    /\.reading-word-popover__translation\s*\{[^}]*font-size:\s*var\(--aisy-font-size-body\)[^}]*line-height:\s*1\.5/su,
    'the translation is learner body copy, not compact control metadata',
  );
  assert.match(
    styles,
    /\.reading-word-popover__action\s*\{[^}]*font:\s*700\s+var\(--aisy-font-size-body\)\/1\.3\s+var\(--aisy-font-interface\)/su,
    '+ Учить and ✓ Знаю are learner decisions and must resolve to the shared 16px body token',
  );
});

test('Reading word lookup is a native modal with complete boundary focus containment and cleanup', () => {
  assert.match(html, /<dialog id="r_pop"[^>]*role="dialog"[^>]*aria-modal="true"[^>]*aria-labelledby="r_word"[^>]*aria-describedby="r_tr"/u);
  assert.doesNotMatch(html, /<div id="r_pop"/u);
  assert.match(app, /typeof pop\.showModal==='function'&&!pop\.open\)pop\.showModal\(\)/u,
    'opening uses native modal semantics, which make the rest of the document inert');
  assert.match(app, /pop\.open&&typeof pop\.close==='function'\)pop\.close\(\)/u);
  assert.match(app, /addEventListener\('cancel',[\s\S]*closeReadingWordPopover\(\)/u,
    'Escape follows the same close/focus-restoration path');
  const popoverController = app.slice(app.indexOf('function closeReadingWordPopover'), app.indexOf('function dictionaryLookupMessage'));
  assert.match(popoverController, /function readingWordPopoverFocusableControls\(pop\)[\s\S]*button:not\(\[disabled\]\)/u,
    'the fallback cycle excludes actions that cannot currently save a valid dictionary result');
  assert.match(popoverController, /function trapReadingWordPopoverTab\(event\)[\s\S]*event\.shiftKey[\s\S]*controls\.at\(-1\)\.focus\(\)[\s\S]*!event\.shiftKey[\s\S]*controls\[0\]\.focus\(\)/u,
    'the native dialog has a complete two-direction boundary fallback for browser focus edge cases');
  assert.match(reading, /closeReadingWordPopover\(false\)/u,
    'leaving Reading invalidates and closes the modal without restoring focus into a hidden route');
  assert.match(styles, /\.reading-word-popover\s*\{[^}]*position:\s*fixed;[^}]*inline-size:\s*min\(calc\(100vw - 44px\),\s*calc\(var\(--aisy-phone-inline-size\) - 44px\)\)/su,
    'top-layer dialog remains centered inside the portrait phone width on wide viewports');
  assert.match(styles, /inset-block-end:\s*calc\(max\(0px,\s*50vh - 422px\) \+ 110px\);\s*inset-block-end:\s*calc\(max\(0px,\s*50dvh - 422px\) \+ 110px\);/u,
    'top-layer dialog follows the centered phone vertically with vh fallback then dvh');
});

test('Reading saves a word only from an explicit online or built-in dictionary result', () => {
  for (const state of ['loading', 'error']) {
    const calls = runReadingWordSave(state, state === 'loading' ? 'перевод…' : 'Сервис временно недоступен.');
    assert.deepEqual(calls, { close: 0, save: 0, upsert: 0, sync: 0, toast: 0 },
      `${state} is not a translation result and must not become owner vocabulary data`);
  }

  const online = runReadingWordSave('online', 'многие онлайн');
  assert.equal(online.upsert, 1);
  assert.equal(online.card.translation, 'многие онлайн');
  assert.equal(online.save, 1);

  const builtIn = runReadingWordSave('builtin', 'многие · офлайн-словарь');
  assert.equal(builtIn.upsert, 1);
  assert.equal(builtIn.card.translation, 'многие');
  assert.equal(builtIn.save, 1);

  const staleOwner = runReadingWordSave('online', 'чужой перевод', {
    selectionOwner: 'owner-a', activeOwner: 'owner-b', activeGeneration: 3,
  });
  assert.deepEqual(staleOwner, { close: 0, save: 0, upsert: 0, sync: 0, toast: 0 },
    'a completed lookup cannot save into a different active owner');

  const savingSource = reading.match(/function r_add\(status\)\{[\s\S]*?\r?\n\}/u)[0];
  assert.doesNotMatch(savingSource, /translation\.includes/u,
    'display-copy substrings are not dictionary authority');
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
