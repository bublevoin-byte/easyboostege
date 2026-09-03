import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

async function readText(path) {
  try {
    return await fs.readFile(new URL(path, import.meta.url), 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return '';
    throw error;
  }
}

const [markup, styles, themeStyles, learningStyles, screen, worker, screens] = await Promise.all([
  readText('../public/index.html'),
  readText('../public/speaking.css'),
  readText('../public/aisy-theme.css'),
  readText('../public/reading-listening.css'),
  readText('../public/screens/speaking.js'),
  readText('../public/service-worker.js'),
  readText('../public/screens.js'),
]);

function speakingBlock() {
  const opening = /<div class="screen" id="scr9"[^>]*>/u.exec(markup);
  assert.ok(opening, 'the scr9 screen wrapper must exist');
  const contentStart = opening.index + opening[0].length;
  const nextScreen = /<div class="screen" id="[^"]+"/u.exec(markup.slice(contentStart));
  assert.ok(nextScreen, 'scr9 must end before the next screen');
  return markup.slice(opening.index, contentStart + nextScreen.index);
}

function tagById(source, id) {
  return new RegExp(`<[^>]+\\bid="${id}"[^>]*>`, 'u').exec(source)?.[0] || '';
}

function cssRule(source, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return new RegExp(`${escaped}\\s*\\{[^}]*\\}`, 'u').exec(source)?.[0] || '';
}

function cssDeclarationBlockContaining(source, selector) {
  const selectorIndex = source.indexOf(selector);
  if (selectorIndex < 0) return '';
  const openingBrace = source.indexOf('{', selectorIndex);
  const closingBrace = source.indexOf('}', openingBrace);
  return openingBrace >= 0 && closingBrace > openingBrace ? source.slice(selectorIndex, closingBrace + 1) : '';
}

function hasPhoneBreakpoint(source) {
  return [...source.matchAll(/@media\s*\(max-width:\s*(\d+)px\)/gu)]
    .some((match) => Number(match[1]) >= 320 && Number(match[1]) <= 390);
}

function hasShortLandscapeBreakpoint(source) {
  return /@media\s*\(orientation:\s*landscape\)\s*and\s*\(max-height:\s*420px\)/u.test(source)
    || /@media\s*\(max-height:\s*420px\)\s*and\s*\(orientation:\s*landscape\)/u.test(source);
}

test('Speaking is one semantic Paper A route without fake phone chrome or local navigation', () => {
  const speaking = speakingBlock();
  const main = /<main\b[^>]*>/u.exec(speaking)?.[0] || '';

  assert.match(main, /class="[^"]*\blearning-route\b[^"]*\bspeaking-route\b/u);
  assert.match(main, /aria-labelledby="speaking_title"/u);
  assert.match(main, /tabindex="-1"/u);
  assert.match(main, /data-aisy-shell-focus/u);
  assert.equal((speaking.match(/<main\b/gu) || []).length, 1);
  assert.equal((speaking.match(/<h1\b/gu) || []).length, 1);
  assert.match(speaking, /<h1\b[^>]*id="speaking_title"/u);

  for (const id of ['s9_sumline', 's9_today', 's9_bar', 's9_area']) {
    assert.match(speaking, new RegExp(`\\bid="${id}"`, 'u'), `${id} remains a stable Speaking contract`);
  }
  const progress = /<[^>]+(?=[^>]*class="[^"]*\bspeaking-route__progress\b)(?=[^>]*role="progressbar")(?=[^>]*aria-valuemin="0")(?=[^>]*aria-valuemax="100")(?=[^>]*aria-valuenow="[^"]+")[^>]*>/u;
  assert.match(speaking, progress);
  assert.match(speaking, /speaking-route__progress[\s\S]*?\bid="s9_bar"/u);

  assert.doesNotMatch(speaking, /9:41|\bnavclay\b|\baisy-shell-(?:nav|back)\b|<nav\b/iu);
  assert.doesNotMatch(speaking, /onclick=["'][^"']*\b(?:back|nav)\s*\(/iu);
  assert.doesNotMatch(speaking, /\bstyle=|(?:linear|radial)-gradient\(/iu);
});

test('Speaking keeps one canonical primary CTA in a safe-area deep action dock', () => {
  const speaking = speakingBlock();
  const dock = tagById(speaking, 'speaking_action_dock');

  assert.match(dock, /class="[^"]*\blearning-action-dock\b[^"]*\bspeaking-action-dock\b/u);
  assert.match(screen, /<button\b(?=[^>]*\btype="button")(?=[^>]*\bclass="[^"]*\baisy-button\b[^"]*\bspeaking-action\b[^"]*\bspeaking-action--primary\b)[^>]*>/u);
  assert.match(screen, /getElementById\(['"]speaking_action_dock['"]\)/u);
  assert.match(screen, /querySelectorAll\(['"]\.speaking-action--primary['"]\)[\s\S]*?slice\(1\)/u,
    'the dock normalizes accidental extra primaries to secondary actions');
  assert.match(screen, /SP_VIEW_CONTENT_ROOT[\s\S]*?dockActions[\s\S]*?freshRender\?\[\]:dockActions/u,
    'state-only normalization preserves the already mounted dock instead of deleting recovery actions');
  assert.match(screen, /if\(!freshRender&&!areaActions\.length\)[\s\S]{0,180}?return/u,
    'state-only transitions keep the focused dock node mounted');
  assert.match(screen, /spBtn\('Послушать свою запись','spPlay\(\)',false\)/u,
    'playback stays secondary so evaluation or route advance owns the canonical CTA');
  assert.doesNotMatch(screen, /spBtn\('Послушать (?:вопрос|ответ|монолог)[^\n]*,true\)/u,
    'review playback never competes with the forward coral CTA');
  assert.match(screen, /spBtn\(finishLabel,'spFinish\(\)',true\)/u,
    'recording always keeps one canonical stop/finish action');
  assert.match(screen, /SP\.t===3&&SP\.qi<4&&!officialTask3Active\(\)\?spBtn\('Следующий вопрос'/u,
    'official Task 3 must stop and commit each answer before advancing');

  const primaryRule = cssRule(styles, '.speaking-action--primary');
  assert.match(primaryRule, /min-block-size:\s*var\(--aisy-button-height\)/u);
  assert.match(primaryRule, /border-radius:\s*var\(--aisy-button-radius\)/u);
  assert.match(primaryRule, /padding:\s*0 var\(--aisy-button-padding-end\) 0 var\(--aisy-button-padding-start\)/u);
  assert.match(styles, /\[data-speaking-control="microphone"\]\.speaking-action--primary\s*\{[^}]*min-block-size:\s*var\(--aisy-button-height\)/u,
    'the primary microphone action keeps the approved 58px CTA height at every phone breakpoint');
  assert.match(cssRule(themeStyles, '.aisy-button'), /min-block-size:\s*var\(--aisy-button-height\)/u);
  assert.match(cssRule(learningStyles, '.learning-action-dock'), /env\(safe-area-inset-bottom\)/u);
  assert.match(screen, /speaking-setting-action[^\n]+>Изменить<\/button>/u);
  assert.match(screen, /speaking-setting-status/u);
  assert.match(cssDeclarationBlockContaining(styles, '.speaking-setting-action,'), /white-space:\s*nowrap/u,
    'short setting controls stay legible instead of breaking words on a phone');
});

test('Speaking exposes stable, non-colour-only recording states and accessible microphone controls', () => {
  const stateNames = ['permission', 'recording', 'processing', 'playback', 'retry', 'quota'];

  assert.match(screen, /<[^>]+(?=[^>]*\bdata-state=)(?=[^>]*\brole=)[^>]*>/u,
    'Speaking states share a semantic live-status boundary');
  for (const state of stateNames) {
    assert.match(screen, new RegExp(`['"]${state}['"]`, 'u'), `${state} is a stable Speaking state`);
    const stateStyle = new RegExp(`\\[(?:data-speaking-state|data-state)="${state}(?:-[^"]+)?"\\]`, 'u');
    assert.match(styles, stateStyle, `${state} is visibly styled`);
  }

  assert.match(screen, /aria-busy/u, 'processing exposes a programmatic busy state');
  assert.match(screen, /speakingAction=['"]microphone-check['"][\s\S]{0,220}setAttribute\(['"]aria-pressed['"]/u);
  assert.match(screen, /setAttribute\(['"]aria-describedby['"],\s*['"]speaking_mic_status['"]\)/u);
  assert.match(screen, /<button\b(?=[^>]*\bdata-speaking-control="microphone")(?=[^>]*\baria-label="[^"]+")(?=[^>]*\baria-pressed="false")[^>]*>/u);
  assert.match(screen, /return open\+label\+['"]<\/button>['"]/u,
    'microphone controls keep a visible accessible name in addition to pressed semantics');

  const controlRule = cssDeclarationBlockContaining(styles, '.speaking-control,');
  assert.match(controlRule, /min-inline-size:\s*var\(--aisy-touch-target\)/u);
  const blockSize = /min-block-size:\s*(?:var\(--aisy-touch-target\)|(\d+)px)/u.exec(controlRule);
  assert.ok(blockSize, 'Speaking controls declare a minimum block size');
  if (blockSize[1]) assert.ok(Number(blockSize[1]) >= 44, 'Speaking controls are at least 44px tall');
  assert.match(cssRule(styles, '.speaking-route summary'), /min-block-size:\s*var\(--aisy-touch-target\)/u);
});

test('Speaking announces async AI results and respects reduced-motion scrolling', () => {
  assert.match(screen, /class="clayCard speaking-state[^"]*" data-state="success" role="status" aria-live="polite" aria-atomic="true"/);
  assert.match(screen, /matchMedia\('\(prefers-reduced-motion: reduce\)'\)\.matches/);
  assert.match(screen, /behavior:reducedMotion\?'auto':'smooth'/);
});

test('Speaking serializes commits and evaluation without leaking stale busy or disabled state', () => {
  assert.match(screen, /SP_COMMIT_LOCK=null/u);
  assert.match(screen, /SP_EVALUATION_LOCK=null/u);
  assert.match(screen, /function spCaptureRouteOperation[\s\S]*disabled:Boolean\(control\.disabled\)[\s\S]*ariaDisabled/u,
    'route-wide async locks snapshot the pre-existing disabled state');
  assert.match(screen, /function spClearRouteOperation[\s\S]*control\.disabled=snapshot\.disabled[\s\S]*snapshot\.ariaDisabled/u,
    'cleanup restores rather than indiscriminately enabling controls');
  assert.match(screen, /function spStopAll\(\)[\s\S]{0,180}?spClearActiveRouteOperations\(\)/u,
    'leaving the route clears busy state even when an old request later becomes stale');
  assert.match(screen, /function spFinishEvaluationView[\s\S]*btn\.hidden=true[\s\S]*result\.focus/u,
    'a finished assessment hides its spent action and leaves focus on the announced result');
  assert.match(screen, /function spCompletionView[\s\S]*Новая тренировка[\s\S]*data-speaking-forward/u,
    'official multi-response completion exposes the usable post-assessment forward action');
  assert.match(screen, /function spFinishEvaluationView[\s\S]*spPromoteForwardAction\(\)/u,
    'finishing an assessment promotes the marked new-training action');
  assert.match(screen, /evaluationErrorState==='quota'\)spFinishEvaluationView\(btn\)/u,
    'an exhausted quota retires the unavailable evaluation CTA and promotes a usable forward action');
  assert.doesNotMatch(screen, /\.style\.display\s*=/u);
});

test('adaptive Speaking success keeps the canonical dock action as the forward path', () => {
  const adaptiveReturn = screen.slice(
    screen.indexOf('function showAdaptiveSpeakingReturn'),
    screen.indexOf('async function spSample'),
  );
  assert.match(adaptiveReturn, /adaptive_speaking_retry/u);
  assert.match(adaptiveReturn, /data(?:set)?\.speakingForward|dataset\.speakingForward/u);
  assert.match(adaptiveReturn, /speaking-action--primary/u);
  assert.match(adaptiveReturn, /spPromoteForwardAction\(\)/u);
  assert.doesNotMatch(adaptiveReturn, /retry\.hidden=true/u);
});

test('Speaking CSS covers 320px phones, short landscape, token-driven dark theme and reduced motion', () => {
  assert.equal(hasPhoneBreakpoint(styles), true);
  assert.equal(hasShortLandscapeBreakpoint(styles), true);
  assert.match(styles, /@media\s*\(prefers-reduced-motion:\s*reduce\)/u);
  assert.match(styles, /env\(safe-area-inset-bottom\)/u);
  assert.match(styles, /var\(--aisy-color-(?:background|surface|text)\)/u);
  assert.match(styles, /var\(--aisy-color-selection(?:-soft)?\)/u);
  assert.match(cssRule(styles, '.speaking-timer__value'), /inline-size:\s*100%/u,
    'the timer starts full through its component style');
  const timerTemplate = screen.slice(screen.indexOf('function spTimerChip'), screen.indexOf('function spMicStatusMarkup'));
  assert.doesNotMatch(timerTemplate, /\bstyle=/u,
    'the static timer template stays free of presentation attributes');
  assert.doesNotMatch(styles, /#[0-9a-f]{3,8}\b|rgba?\(|(?:linear|radial)-gradient\(/iu,
    'Speaking must inherit light/dark values from semantic Paper A tokens');
  for (const selector of [
    '.speaking-learning-report__verdict', '.speaking-learning-transcript__copy',
    '.speaking-evaluation-card__verdict', '.speaking-evaluation-card__evidence',
    '.speaking-insight__item', '.speaking-sample-card__copy', '.speaking-state[data-state]',
  ]) {
    assert.match(cssDeclarationBlockContaining(styles, selector), /var\(--aisy-font-size-body\)/u,
      `${selector} keeps the canonical 16px body token`);
  }
});

test('Speaking styles are install-cached while its executable remains route-lazy', () => {
  assert.match(markup, /<link rel="stylesheet" href="\/speaking\.css">/u);
  assert.match(worker, /['"]\/speaking\.css['"]/u);
  const appShell = worker.match(/const APP_SHELL=\[[\s\S]*?\];/u)?.[0] || '';
  assert.doesNotMatch(appShell, /\/screens\/speaking\.js/u);
  assert.match(screens, /scr9:function\(\)\{return import\('\.\/screens\/speaking\.js'\)\}/u);
});
