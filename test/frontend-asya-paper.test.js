import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

const [styles, assistant, launcher, voiceTutor, shell, main] = await Promise.all([
  fs.readFile(new URL('../public/asya-assistant.css', import.meta.url), 'utf8'),
  fs.readFile(new URL('../public/asya-assistant.js', import.meta.url), 'utf8'),
  fs.readFile(new URL('../public/asya-launcher.js', import.meta.url), 'utf8'),
  fs.readFile(new URL('../public/voice-tutor.js', import.meta.url), 'utf8'),
  fs.readFile(new URL('../public/aisy-shell.js', import.meta.url), 'utf8'),
  fs.readFile(new URL('../public/main.js', import.meta.url), 'utf8'),
]);

function cssRule(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return new RegExp(`${escaped}\\s*\\{[^}]*\\}`, 'u').exec(styles)?.[0] || '';
}

function hasPhoneBreakpoint(source) {
  return [...source.matchAll(/@media\s*\(max-width:\s*(\d+)px\)/gu)]
    .some((match) => Number(match[1]) >= 320 && Number(match[1]) <= 390);
}

function hasShortLandscapeBreakpoint(source) {
  return /@media\s*\(orientation:\s*landscape\)\s*and\s*\(max-height:\s*420px\)/u.test(source)
    || /@media\s*\(max-height:\s*420px\)\s*and\s*\(orientation:\s*landscape\)/u.test(source);
}

test('Asya remains a lazy contextual launcher outside the five-item learner navigation', () => {
  const destinations = shell.match(/const LEARNER_DESTINATIONS=Object\.freeze\(\[[\s\S]*?\]\);/u)?.[0] || '';

  assert.equal((destinations.match(/screenId:/gu) || []).length, 5);
  assert.doesNotMatch(destinations, /asya/iu);
  assert.match(launcher, /launcher\.id\s*=\s*['"]asya-launcher['"]/u);
  assert.match(launcher, /launcher\.setAttribute\(['"]aria-haspopup['"],\s*['"]dialog['"]\)/u);
  assert.match(launcher, /frame\.append\(launcher\)/u);
  assert.match(launcher, /import\(['"]\.\/asya-assistant\.js['"]\)/u);
  assert.match(main, /installAsyaLauncher/u);
  assert.doesNotMatch(main, /installAsyaAssistant/u);
});

test('Asya uses only the bounded plum context accent and semantic light-dark tokens', () => {
  assert.match(styles, /--asya-semantic-accent:\s*var\(--aisy-color-selection\)/u);
  assert.match(styles, /--asya-semantic-accent-soft:\s*var\(--aisy-color-selection-soft\)/u);
  assert.match(styles, /#voiceTutorSheet,\s*#frame \.voiceTutorTrigger\s*\{[^}]*--asya-semantic-accent:/u,
    'lazy Voice Tutor triggers must inherit the Asya token scope before its runtime loads');
  assert.match(cssRule('.asya-launcher'), /var\(--asya-semantic-accent\)/u);
  assert.match(cssRule('.asya-assistant__mark'), /var\(--asya-semantic-accent\)/u);
  assert.match(styles, /#frame\[data-speaking-dock-active="true"\]\s*>\s*\.asya-launcher\s*\{[^}]*display:\s*none/u,
    'the launcher never competes with the Speaking deep dock');
  const voiceTutorRules = styles.match(/#frame \.voiceTutorTrigger\s*\{[^}]*\}/gu) || [];
  const voiceTutorTrigger = voiceTutorRules.find((rule) => /background:/u.test(rule)) || '';
  assert.match(voiceTutorTrigger, /background:\s*var\(--asya-semantic-accent-soft\)/u);
  assert.match(voiceTutorTrigger, /color:\s*var\(--asya-semantic-accent\)/u);
  assert.doesNotMatch(voiceTutorTrigger, /--aisy-button-background/u,
    'a contextual Voice Tutor action is not a second coral route CTA');
  assert.doesNotMatch(styles, /var\(--aisy-color-accent\)/u);
  assert.doesNotMatch(styles, /#[0-9a-f]{3,8}\b|rgba?\(|(?:linear|radial)-gradient\(/iu,
    'Asya and Voice Tutor must inherit warm light/dark values from semantic tokens');
});

test('Voice Tutor presentation lives in external CSS with responsive and reduced-motion rules', () => {
  for (const selector of ['.voiceTutorTrigger', '#voiceTutorSheet', '.vtPanel', '.vtMic', '.vtState']) {
    assert.match(styles, new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'), `${selector} is externally styled`);
  }
  assert.doesNotMatch(voiceTutor, /createElement\(['"]style['"]\)|style\.textContent\s*[+=]/u);
  assert.doesNotMatch(voiceTutor, /#[0-9a-f]{3,8}\b|rgba?\(/iu);

  assert.equal(hasPhoneBreakpoint(styles), true);
  assert.equal(hasShortLandscapeBreakpoint(styles), true);
  assert.match(styles, /@media\s*\(prefers-reduced-motion:\s*reduce\)/u);
  assert.match(styles, /prefers-reduced-motion:[\s\S]*?animation-name:\s*none\s*!important/u,
    'reduced motion removes sheet translation keyframes instead of only shortening them');
  assert.match(styles, /env\(safe-area-inset-bottom\)/u);

  const micRule = cssRule('.vtMic');
  assert.match(micRule, /min-inline-size:\s*var\(--aisy-touch-target\)/u);
  assert.match(micRule, /min-block-size:\s*var\(--aisy-touch-target\)/u);
  assert.match(cssRule('#voiceTutorSheet .vtSources a'), /min-block-size:\s*var\(--aisy-touch-target\)/u);
  for (const selector of ['#voiceTutorSheet .vtHeadCopy > p:last-child', '#voiceTutorSheet .vtCapsule span', '#voiceTutorSheet .vtState', '#voiceTutorSheet .vtReportStatus']) {
    assert.match(cssRule(selector), /var\(--aisy-font-size-body\)/u,
      `${selector} keeps the canonical 16px body token`);
  }
  assert.match(styles, /#voiceTutorSheet \.vtCaptions\s*\{[^}]*var\(--aisy-font-size-body\)/u,
    'Voice Tutor captions keep the canonical 16px body token');
});

test('Voice Tutor exposes stable realtime, recovery, text fallback and error states', () => {
  assert.match(voiceTutor, /(?:\.dataset\.state\s*=|setAttribute\(['"]data-state['"])/u);
  for (const state of ['connecting', 'recovering', 'text-fallback', 'error']) {
    assert.match(voiceTutor, new RegExp(`['"]${state}['"]`, 'u'), `${state} is a stable Voice Tutor state`);
    assert.match(styles, new RegExp(`\\[data-state=['"]${state}['"]\\]`, 'u'), `${state} has a visible treatment`);
  }
  assert.match(voiceTutor, /aria-busy/u);
  assert.match(voiceTutor, /id="voiceTutorStatus"[^>]*data-state="connecting"[^>]*role="status"[^>]*aria-live="polite"/u);
  assert.match(voiceTutor, /id="voiceTutorState"/u);
});

test('Voice Tutor privacy and microphone state are programmatically exposed', () => {
  assert.match(voiceTutor, /id="voiceTutorPrivacy"/u);
  assert.match(voiceTutor, /aria-describedby['"],\s*['"]voiceTutorPrivacy['"]/u);
  const microphone = /<button\b(?=[^>]*\bid="voiceTutorMic")(?=[^>]*\baria-label="[^"]+")(?=[^>]*\baria-pressed="false")[^>]*>/u;
  assert.match(voiceTutor, microphone);
  assert.match(assistant, /id="asya-state"[^>]*data-state="off"[^>]*role="status"/u);
});

test('Asya and Voice Tutor focus traps stay inside their visible panels', () => {
  assert.match(assistant, /asya-assistant__backdrop"[^>]*tabindex="-1"/u);
  assert.match(assistant, /querySelector\('\.asya-assistant__panel'\)[\s\S]*panel\?\.querySelectorAll\('button,input,select,a\[href\],textarea'\)/u);
  assert.match(voiceTutor, /vtBackdrop"[^>]*tabindex="-1"/u);
  assert.match(voiceTutor, /querySelector\('\.vtPanel'\)[\s\S]*panel\?\.querySelectorAll\('button,input,select,a\[href\],textarea'\)/u);
});

test('Voice Tutor report submission is single-flight and owner-bound', () => {
  const report = voiceTutor.slice(
    voiceTutor.indexOf('async function submitTutorReport'),
    voiceTutor.indexOf('async function advanceTutorSession'),
  );
  assert.match(report, /reportOperation/u);
  assert.match(report, /sessionOperation/u);
  assert.match(report, /currentSession\?\.session\?\.id === sessionId/u);
  assert.match(report, /setTutorReportBusy\(true\)/u);
  assert.match(report, /setTutorReportBusy\(false\)/u);
  assert.match(report, /setTutorReportStatus\(['"](?:success|error)['"]/u);
  assert.doesNotMatch(report, /text\(['"]voiceTutorState['"]|showVoiceTutorError/u,
    'report feedback stays local and cannot replace the pedagogical step status');
});

test('Voice Tutor failures offer explicit retry and continue-by-text actions', () => {
  assert.match(voiceTutor, /id="voiceTutorRetry"/u);
  assert.match(voiceTutor, /id="voiceTutorUseText"/u);
  assert.match(voiceTutor, /getElementById\(['"]voiceTutorRetry['"]\)[\s\S]*addEventListener/u);
  assert.match(voiceTutor, /getElementById\(['"]voiceTutorUseText['"]\)[\s\S]*addEventListener/u);
});

test('Voice Tutor quota has a distinct visible state', () => {
  assert.match(voiceTutor, /id="voiceTutorQuota"/u);
  assert.match(voiceTutor, /['"]quota['"]/u);
  assert.match(styles, /\[data-state=['"]quota['"]\]/u);
});
