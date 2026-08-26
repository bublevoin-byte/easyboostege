import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const tokenUrl = new URL('public/prototypes/aisy-style-lab/styles/tokens.css', root);
const labCssUrl = new URL('public/prototypes/aisy-style-lab/styles/lab.css', root);
const fixtureUrl = new URL('public/prototypes/aisy-style-lab/data/fixtures.js', root);
const appUrl = new URL('public/prototypes/aisy-style-lab/app.js', root);
const directionAUrl = new URL('public/prototypes/aisy-style-lab/renderers/a.js', root);
const directionBUrl = new URL('public/prototypes/aisy-style-lab/renderers/b.js', root);
const directionCUrl = new URL('public/prototypes/aisy-style-lab/renderers/c.js', root);
const commonRendererUrl = new URL('public/prototypes/aisy-style-lab/renderers/common.js', root);

const [tokens, labCss, fixtureSource, appSource, directionASource, directionBSource, directionCSource, commonRendererSource] = await Promise.all([
  readFile(tokenUrl, 'utf8'),
  readFile(labCssUrl, 'utf8'),
  readFile(fixtureUrl, 'utf8'),
  readFile(appUrl, 'utf8'),
  readFile(directionAUrl, 'utf8'),
  readFile(directionBUrl, 'utf8'),
  readFile(directionCUrl, 'utf8'),
  readFile(commonRendererUrl, 'utf8'),
]);

const semanticMarker = tokens.indexOf('LAYER 2');
assert.notEqual(semanticMarker, -1, 'semantic token layer marker is missing');
assert.equal(
  /#[0-9a-f]{3,8}\b/i.test(tokens.slice(semanticMarker)),
  false,
  'raw palette value found outside primitive token layer',
);
assert.equal(/#[0-9a-f]{3,8}\b/i.test(labCss), false, 'raw palette value found in component CSS');
assert.equal(/@media\s*\(\s*min-width[^}]+\.bottom-nav/is.test(labCss), false, 'bottom nav becomes a wide-screen rail');
assert.match(labCss, /grid-template-columns:\s*repeat\(5,\s*1fr\)/, 'five-column bottom nav contract is missing');
assert.match(labCss, /min\(100%,\s*var\(--phone-max-width\)\)/, 'phone canvas maximum is missing');
assert.match(tokens, /@media\s*\(prefers-reduced-motion:\s*reduce\)/, 'reduced-motion token override is missing');
assert.match(appSource, /searchParams\.set\('direction'/, 'direction is not persisted in the URL');
assert.match(appSource, /searchParams\.set\('screen'/, 'screen is not persisted in the URL');
assert.match(appSource, /searchParams\.set\('state'/, 'fixture state is not persisted in the URL');
assert.match(appSource, /dataset\.targetScreen/, 'fixture CTA targets are not used for flow navigation');
assert.match(appSource, /capturePaperOutgoing/, 'Direction A has no outgoing paper transition seam');
assert.match(directionASource, /a-route-map/, 'Direction A folded route map is missing');
assert.match(directionASource, /a-paper-surface/, 'Direction A paper deck is missing');
assert.match(directionBSource, /b-instrument/, 'Direction B tactile instrument is missing');
assert.match(directionBSource, /renderFoundationScreen/, 'Direction B must project the shared fixture renderer');
assert.match(directionCSource, /c-journey/, 'Direction C illustrated route is missing');
assert.match(directionCSource, /renderFoundationScreen/, 'Direction C must project the shared fixture renderer');
assert.match(directionCSource, /pathLength="1"/, 'Direction C route needs a normalized draw path');
assert.match(directionCSource, /focusable="false"/, 'Direction C decorative SVG must stay outside keyboard focus');
assert.match(commonRendererSource, /aria-hidden="true" focusable="false"/, 'Shared decorative SVG icons must stay outside keyboard focus');
assert.equal(/cloneNode/.test(directionCSource), false, 'Direction C must not clone readable screens');
assert.match(commonRendererSource, /routeBlocksForDuration/, 'duration choice must update route estimates in-place');
assert.match(appSource, /dataset\.bPhase\s*=\s*'seat'/, 'Direction B seat phase is missing');
assert.match(appSource, /dataset\.bPhase\s*=\s*'release'/, 'Direction B release phase is missing');
assert.match(labCss, /data-direction="b"[\s\S]+var\(--widget-seat-y\)/, 'Direction B vertical seat motion is missing');
assert.match(
  labCss,
  /data-b-phase="release"[\s\S]+opacity:\s*1;[\s\S]+var\(--widget-release-y\)/,
  'Direction B normal release must stay opaque',
);
assert.match(
  labCss,
  /@media \(prefers-reduced-motion: reduce\)[\s\S]+data-direction="b"[\s\S]+transform:\s*none/,
  'Direction B reduced motion must remove spatial movement',
);
assert.match(
  labCss,
  /c-journey__trail--progress[\s\S]+stroke-dashoffset:\s*var\(--c-route-offset\)[\s\S]+var\(--story-route-duration\)/,
  'Direction C normalized route-draw transition is missing',
);
assert.match(appSource, /dataset\.cRouteTransition\s*=\s*isStoryForwardTransition/, 'Direction C forward-only motion state is missing');
assert.match(labCss, /data-c-route-transition="forward"[\s\S]+var\(--c-route-from-offset\)/, 'Direction C must draw only the next route leg');
assert.match(
  labCss,
  /prefers-reduced-motion[\s\S]+data-direction="c"[\s\S]+stroke-dashoffset:\s*var\(--c-route-offset\)[\s\S]+transition:\s*none/,
  'Direction C reduced motion must remove route drawing',
);
assert.match(labCss, /var\(--paper-enter-x\)/, 'Direction A incoming 16px paper displacement is missing');
assert.match(labCss, /var\(--paper-exit-x\)/, 'Direction A outgoing paper displacement is missing');
assert.match(
  labCss,
  /prefers-reduced-motion[\s\S]+a-paper-outgoing[\s\S]+transform:\s*none/,
  'Direction A reduced-motion transform removal is missing',
);

const fixtureModule = await import(fixtureUrl.href);
assert.equal(fixtureModule.DIRECTIONS.length, 3, 'comparison must have exactly three directions');
assert.equal(fixtureModule.FLOW_SCREENS.length, 4, 'comparison flow must have exactly four screens');
assert.deepEqual(
  fixtureModule.NAV_ITEMS.map(({ label }) => label),
  ['Сегодня', 'Практика', 'ЕГЭ', 'Прогресс', 'Профиль'],
  'bottom navigation order differs from the approved IA',
);
for (const duration of fixtureModule.LAB_FIXTURE.today.durationOptions) {
  const estimate = fixtureModule.LAB_FIXTURE.today.durationEstimates[duration];
  assert.equal(
    Object.values(estimate).reduce((total, minutes) => total + minutes, 0),
    duration,
    `route estimates must add up to the selected ${duration} minutes`,
  );
}
assert.equal(fixtureModule.projectScreen({ direction: 'z', screen: 'z' }).direction, 'a');
assert.equal(fixtureModule.projectScreen({ direction: 'z', screen: 'z' }).screen, 'today');
assert.match(fixtureSource, /Object\.freeze/, 'fixtures must be immutable');

console.log(JSON.stringify({
  status: 'PASS',
  directions: fixtureModule.DIRECTIONS.length,
  screens: fixtureModule.FLOW_SCREENS.length,
  navigation: fixtureModule.NAV_ITEMS.length,
  directionARenderer: true,
  directionBRenderer: true,
  directionCRenderer: true,
  rawComponentColors: 0,
  desktopSideRail: false,
}, null, 2));
