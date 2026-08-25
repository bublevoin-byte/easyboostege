import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const tokenUrl = new URL('public/prototypes/aisy-style-lab/styles/tokens.css', root);
const labCssUrl = new URL('public/prototypes/aisy-style-lab/styles/lab.css', root);
const fixtureUrl = new URL('public/prototypes/aisy-style-lab/data/fixtures.js', root);
const appUrl = new URL('public/prototypes/aisy-style-lab/app.js', root);

const [tokens, labCss, fixtureSource, appSource] = await Promise.all([
  readFile(tokenUrl, 'utf8'),
  readFile(labCssUrl, 'utf8'),
  readFile(fixtureUrl, 'utf8'),
  readFile(appUrl, 'utf8'),
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

const fixtureModule = await import(fixtureUrl.href);
assert.equal(fixtureModule.DIRECTIONS.length, 3, 'comparison must have exactly three directions');
assert.equal(fixtureModule.FLOW_SCREENS.length, 4, 'comparison flow must have exactly four screens');
assert.deepEqual(
  fixtureModule.NAV_ITEMS.map(({ label }) => label),
  ['Сегодня', 'Практика', 'ЕГЭ', 'Прогресс', 'Профиль'],
  'bottom navigation order differs from the approved IA',
);
assert.equal(fixtureModule.projectScreen({ direction: 'z', screen: 'z' }).direction, 'a');
assert.equal(fixtureModule.projectScreen({ direction: 'z', screen: 'z' }).screen, 'today');
assert.match(fixtureSource, /Object\.freeze/, 'fixtures must be immutable');

console.log(JSON.stringify({
  status: 'PASS',
  directions: fixtureModule.DIRECTIONS.length,
  screens: fixtureModule.FLOW_SCREENS.length,
  navigation: fixtureModule.NAV_ITEMS.length,
  rawComponentColors: 0,
  desktopSideRail: false,
}, null, 2));
