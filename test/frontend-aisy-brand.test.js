import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { inflateSync } from 'node:zlib';
import { cssLayer as layer } from './helpers/css.js';

const publicUrl = new URL('../public/', import.meta.url);

async function readPublic(name) {
  return fs.readFile(new URL(name, publicUrl), 'utf8');
}

function rule(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, 'u'))?.[1] || '';
}

function customProperties(body) {
  return new Map([...body.matchAll(/(--[\w-]+)\s*:\s*(#[0-9a-f]{6}|[\d.]+(?:px|ms)|[^;]+)\s*;/giu)]
    .map((match) => [match[1], match[2].trim()]));
}

function semanticColorPair(value, primitives, name) {
  const pair = value.match(/^light-dark\(var\((--[\w-]+)\),\s*var\((--[\w-]+)\)\)$/u);
  assert.ok(pair, `canonical theme misses the primitive light/dark pair for ${name}`);
  const colors = pair.slice(1).map((primitive) => primitives.get(primitive));
  for (const color of colors) assert.match(color || '', /^#[0-9a-f]{6}$/iu, `${name} has a missing color primitive`);
  return colors;
}

function luminance(hex) {
  const channels = [1, 3, 5].map((index) => {
    const value = Number.parseInt(hex.slice(index, index + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrast(first, second) {
  const a = luminance(first);
  const b = luminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

test('stored theme bootstrap applies forced light or dark before stylesheets can paint', async () => {
  const [html, offline, privacy, source] = await Promise.all([
    readPublic('index.html'), readPublic('offline.html'), readPublic('privacy.html'), readPublic('theme-prepaint.js'),
  ]);
  for (const [name, documentSource] of Object.entries({ html, offline, privacy })) {
    assert.ok(documentSource.indexOf('<script src="/theme-prepaint.js"></script>') < documentSource.indexOf('/aisy-theme.css'),
      `${name} must initialize the stored theme before render-blocking CSS`);
    assert.match(documentSource, /<meta name="theme-color" content="#fff9f3">/u);
  }
  for (const preference of ['light', 'dark']) {
    const root = {
      dataset: {},
      removeAttribute(name) { if (name === 'data-theme') delete this.dataset.theme; },
    };
    const themeColor = { content: '' };
    const window = {
      localStorage: { getItem(key) { assert.equal(key, 'aisy.theme.preference.v1'); return preference; } },
      matchMedia() { return { matches: preference !== 'dark' }; },
    };
    const document = {
      documentElement: root,
      querySelector(selector) { assert.equal(selector, 'meta[name="theme-color"]'); return themeColor; },
    };
    vm.runInContext(source, vm.createContext({ window, document }));
    assert.equal(root.dataset.themePreference, preference);
    assert.equal(root.dataset.theme, preference);
    assert.equal(themeColor.content, preference === 'dark' ? '#171219' : '#fff9f3');
  }
});

function paeth(left, up, upperLeft) {
  const estimate = left + up - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const upDistance = Math.abs(estimate - up);
  const diagonalDistance = Math.abs(estimate - upperLeft);
  if (leftDistance <= upDistance && leftDistance <= diagonalDistance) return left;
  return upDistance <= diagonalDistance ? up : upperLeft;
}

function decodeInstallPng(buffer) {
  assert.equal(buffer.subarray(1, 4).toString('ascii'), 'PNG');
  const idat = [];
  let width;
  let height;
  let channels;
  for (let offset = 8; offset < buffer.length;) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString('ascii');
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      assert.equal(data[8], 8, 'install icon must use 8-bit channels');
      assert.ok(data[9] === 2 || data[9] === 6, 'install icon must use RGB or RGBA channels');
      channels = data[9] === 6 ? 4 : 3;
    } else if (type === 'IDAT') idat.push(data);
    offset += length + 12;
  }
  const packed = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const pixels = Buffer.alloc(stride * height);
  let sourceOffset = 0;
  let previous = Buffer.alloc(stride);
  for (let y = 0; y < height; y += 1) {
    const filter = packed[sourceOffset];
    sourceOffset += 1;
    const row = Buffer.alloc(stride);
    for (let x = 0; x < stride; x += 1) {
      const raw = packed[sourceOffset + x];
      const left = x >= channels ? row[x - channels] : 0;
      const up = previous[x];
      const upperLeft = x >= channels ? previous[x - channels] : 0;
      const predictor = [0, left, up, Math.floor((left + up) / 2), paeth(left, up, upperLeft)][filter];
      assert.notEqual(predictor, undefined, `unsupported PNG filter ${filter}`);
      row[x] = (raw + predictor) & 0xff;
    }
    row.copy(pixels, y * stride);
    previous = row;
    sourceOffset += stride;
  }
  return { width, height, channels, pixels };
}

test('public documents and install metadata present the Aisy learner brand', async () => {
  const [html, manifestText, offline, privacy, pwa] = await Promise.all([
    readPublic('index.html'),
    readPublic('manifest.json'),
    readPublic('offline.html'),
    readPublic('privacy.html'),
    readPublic('pwa.js'),
  ]);
  const manifest = JSON.parse(manifestText);

  assert.equal(manifest.name, 'Aisy ЕГЭ — Английский');
  assert.equal(manifest.short_name, 'Aisy.space');
  assert.match(manifest.description, /Aisy\.space/u);
  assert.match(html, /<title>Aisy ЕГЭ — Английский · Aisy\.space<\/title>/u);
  assert.match(html, /src="\/assets\/opening\/logo\.webp"/u);
  assert.match(html, />Aisy ЕГЭ — Английский<\/p>/u);
  assert.match(html, /Войди — и продолжим с твоего шага/u);
  assert.match(offline, /Aisy\.space/u);
  assert.match(offline, /Ася/u);
  assert.match(privacy, /Aisy\.space/u);
  assert.match(privacy, /Ася/u);
  assert.match(html, /id="pwa_update_title">Новая версия готова/u);
  assert.match(pwa, /Обновление отложено\. Aisy\.space/u);
  assert.match(pwa, /easyboost:update-ready/u, 'internal update event is a compatibility contract');
  assert.match(pwa, /let consentedWorker = null/u);
  assert.doesNotMatch(pwa, /reloadAfterConsent/u,
    'document-wide consent must not leak into a successor worker generation');
  assert.match(pwa,
    /const worker = offeredWorker[\s\S]*?consentedWorker = worker[\s\S]*?worker\.postMessage\(\{ type: 'SKIP_WAITING' \}\)/u,
    'the visible Apply action must bind consent to the exact offered worker');
  assert.match(pwa,
    /function offerUpdate\(worker\) \{[\s\S]*?if \(!worker \|\| offeredWorker === worker\) return;[\s\S]*?stopQuorumRetry\(\);[\s\S]*?offeredWorker = worker;[\s\S]*?consentedWorker = null;/u,
    'a successor worker must discard the predecessor consent and retry state');
  assert.match(pwa,
    /function reloadForConsentedWorker\(worker\) \{[\s\S]*?!worker \|\| worker !== offeredWorker \|\| worker !== consentedWorker[\s\S]*?\(worker\.state !== 'activated' && navigator\.serviceWorker\.controller !== worker\)\) return false;[\s\S]*?if \(reloadingWorker === worker\) return true;[\s\S]*?reloadingWorker = worker;[\s\S]*?window\.location\.reload\(\);[\s\S]*?return true;[\s\S]*?\}/u,
    'reload requires the exact offered consented generation to be active and remains one-shot');
  assert.match(pwa,
    /consentedWorker = worker;[\s\S]*?worker\.addEventListener\('statechange', function \(\) \{[\s\S]*?reloadForConsentedWorker\(worker\);[\s\S]*?\}\)/u,
    'an applying tab must follow activation of its exact consented waiting worker');
  assert.match(pwa,
    /navigator\.serviceWorker\.addEventListener\('controllerchange', function \(\) \{[\s\S]*?const controller = navigator\.serviceWorker\.controller;[\s\S]*?reloadForConsentedWorker\(controller\);[\s\S]*?\}\);/u,
    'controller changes must delegate through the same exact-worker reload guard');
  assert.match(pwa, /event\.source !== worker/u,
    'stale predecessor quorum messages must not mutate successor UI');
  assert.doesNotMatch(pwa, /detail:\s*\{\s*apply/u,
    'the compatibility event must not expose a hidden consent bypass');
  assert.match(pwa, /WAITING_FOR_OTHER_TABS[\s\S]*?dismissButton\.hidden = true/u,
    'after consent, the misleading Later action must disappear while quorum is pending');
  assert.match(pwa, /WAITING_FOR_OTHER_TABS[\s\S]*?restoreTaskFocus\(\)/u,
    'after keyboard Apply, focus must return deterministically to the active task');
  assert.match(pwa, /перезагрузится автоматически/u,
    'the pending status must disclose the automatic reload that consent authorized');
  assert.match(pwa, /const UPDATE_QUORUM_RETRY_MS = 55_000/u);
  assert.match(pwa,
    /setInterval\([\s\S]*?worker !== offeredWorker[\s\S]*?worker !== consentedWorker[\s\S]*?RECHECK_UPDATE_CONSENT[\s\S]*?UPDATE_QUORUM_RETRY_MS/u,
    'a current candidate must renew the bounded worker-side quorum watch without another click');

  for (const [surface, source] of Object.entries({ html, manifestText, offline, privacy, pwa })) {
    assert.doesNotMatch(source, /Easy Boost/u, `${surface} exposes the retired public brand`);
  }
});

test('shared Aisy theme keeps light and dark interaction states accessible', async () => {
  const css = await readPublic('aisy-theme.css');
  const primitives = customProperties(layer(css, 'aisy-primitives'));
  const canonical = customProperties(layer(css, 'aisy-semantic'));
  const light = new Map();
  const dark = new Map();
  const requiredColors = [
    '--aisy-color-background', '--aisy-color-surface', '--aisy-color-text', '--aisy-color-text-muted',
    '--aisy-color-primary', '--aisy-color-action-text', '--aisy-color-on-primary', '--aisy-color-focus', '--aisy-color-success',
    '--aisy-color-warning', '--aisy-color-danger',
  ];

  for (const name of requiredColors) {
    const pair = semanticColorPair(canonical.get(name) || '', primitives, name);
    light.set(name, pair[0]);
    dark.set(name, pair[1]);
  }
  for (const theme of [light, dark]) {
    assert.ok(contrast(theme.get('--aisy-color-text'), theme.get('--aisy-color-background')) >= 4.5);
    assert.ok(contrast(theme.get('--aisy-color-text-muted'), theme.get('--aisy-color-surface')) >= 4.5);
    assert.ok(contrast(theme.get('--aisy-color-on-primary'), theme.get('--aisy-color-primary')) >= 4.5);
    assert.ok(contrast(theme.get('--aisy-color-action-text'), theme.get('--aisy-color-surface')) >= 4.5);
    assert.ok(contrast(theme.get('--aisy-color-action-text'), theme.get('--aisy-color-background')) >= 4.5);
    assert.ok(contrast(theme.get('--aisy-color-focus'), theme.get('--aisy-color-background')) >= 3);
  }

  assert.equal(primitives.get('--aisy-primitive-size-touch'), '44px');
  assert.equal(canonical.get('--aisy-touch-target'), 'var(--aisy-primitive-size-touch)');
  assert.match(css, /:root\[data-theme="light"\]\s*\{\s*color-scheme:\s*light;/u);
  assert.match(css, /:root\[data-theme="dark"\]\s*\{\s*color-scheme:\s*dark;/u);
  assert.doesNotMatch(rule(css, ':root[data-theme="dark"]'), /--aisy-color-/u);
  assert.match(css, /@media\s*\(prefers-color-scheme:\s*dark\)[\s\S]*:root:not\(\[data-theme\]\)/u);
  assert.match(css, /:focus-visible[\s\S]{0,180}outline:\s*3px solid var\(--aisy-focus-color\)/u);
  assert.match(css, /min-block-size:\s*var\(--aisy-touch-target\)/u);
  assert.match(css, /touch-action:\s*manipulation/u);
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*animation-duration:\s*0\.01ms/u);
});

test('the accessible Asya mark and shared theme stay inside the offline public shell', async () => {
  const [html, offline, privacy, privacyScript, privacyStyles, launcher, icon, worker] = await Promise.all([
    readPublic('index.html'),
    readPublic('offline.html'),
    readPublic('privacy.html'),
    readPublic('privacy.js'),
    readPublic('progress-profile.css'),
    readPublic('asya-launcher.js'),
    readPublic('pwa-icon.svg'),
    readPublic('service-worker.js'),
  ]);

  for (const [surface, source] of Object.entries({ html, offline, privacy })) {
    assert.match(source, /<link rel="stylesheet" href="\/aisy-theme\.css">/u, `${surface} misses the theme`);
  }
  assert.match(worker, /['"]\/aisy-theme\.css['"]/u);
  assert.match(worker, /['"]\/pwa-icon\.svg['"]/u);
  assert.match(icon, /<svg[^>]*role="img"[^>]*aria-labelledby="asya-mark-title asya-mark-description"/u);
  assert.match(icon, /<title id="asya-mark-title">Абстрактный знак Аси<\/title>/u);
  assert.match(icon, /<desc id="asya-mark-description">[^<]*голосов[^<]*<\/desc>/u);
  assert.doesNotMatch(icon, /<text\b/u);
  assert.match(html, /<img[^>]*src="\/assets\/opening\/logo\.webp"/u);
  assert.match(worker, /['"]\/assets\/opening\/logo\.webp['"]/u);
  assert.match(launcher, /setAttribute\('aria-label','Открыть Асю'\)/u);
  assert.match(privacyScript, /голосового разбора с Асей/u);
  assert.match(privacyScript, /global\.EasyBoostApi/u, 'internal frontend namespace must remain stable');
  assert.doesNotMatch(privacyScript, /Easy Boost не сохраняет/u);
  assert.doesNotMatch(privacyScript, /document\.createElement\(['"]style['"]\)|\.style\./u);
  assert.match(privacyStyles, /#privacySheet p,[\s\S]*?#privacySheet li\s*\{[^}]*var\(--aisy-font-size-body\)/u);
  assert.match(privacyStyles, /\.privacyChoice (?:b|span)\s*\{[^}]*font-size:\s*var\(--aisy-font-size-body\)/u);
  assert.match(privacyStyles, /\.privacyBtn\s*\{[^}]*min-block-size:\s*var\(--aisy-touch-target\)[^}]*var\(--aisy-font-size-body\)/su);
  assert.match(privacyStyles, /\.privacyLink\s*\{[^}]*min-block-size:\s*var\(--aisy-touch-target\)/su);
});

test('every raster install icon carries the Paper A coral and wave mark', async () => {
  for (const [name, expectedSize] of [
    ['icon-192.png', 192],
    ['icon-512.png', 512],
    ['icon-maskable-512.png', 512],
  ]) {
    const image = decodeInstallPng(await fs.readFile(new URL(name, publicUrl)));
    assert.equal(image.width, expectedSize);
    assert.equal(image.height, expectedSize);
    let coral = 0;
    let warmWhite = 0;
    let aqua = 0;
    let retiredOrange = 0;
    let visible = 0;
    const safeZoneColors = new Set();
    for (let offset = 0, index = 0; offset < image.pixels.length; offset += image.channels, index += 1) {
      const rgb = image.pixels.subarray(offset, offset + 3);
      const alpha = image.channels === 4 ? image.pixels[offset + 3] : 255;
      if (alpha === 0) continue;
      visible += 1;
      if (rgb[0] === 0xb9 && rgb[1] === 0x43 && rgb[2] === 0x3a) coral += 1;
      if (rgb[0] >= 0xf7 && rgb[1] >= 0xf7 && rgb[2] >= 0xf4) warmWhite += 1;
      if (rgb[0] >= 0x78 && rgb[0] <= 0x92 && rgb[1] >= 0xcc && rgb[1] <= 0xe4 && rgb[2] >= 0x9f && rgb[2] <= 0xb9) aqua += 1;
      if (rgb[0] === 0xf2 && rgb[1] === 0x68 && rgb[2] === 0x3f) retiredOrange += 1;
      const x = index % image.width;
      const y = Math.floor(index / image.width);
      if (x >= image.width * 0.2 && x < image.width * 0.8
        && y >= image.height * 0.2 && y < image.height * 0.8) {
        safeZoneColors.add(`${rgb[0]},${rgb[1]},${rgb[2]}`);
      }
    }
    const total = image.width * image.height;
    assert.ok(coral / visible >= 0.35, `${name} does not visibly carry the Paper A coral field`);
    assert.ok(warmWhite / total >= 0.005, `${name} is missing the warm-white Aisy wave`);
    assert.ok(aqua / total >= 0.002, `${name} is missing the aqua Aisy wave`);
    assert.ok(safeZoneColors.size >= 4, `${name} has no visible mark inside the maskable safe zone`);
    assert.ok(retiredOrange / total < 0.001, `${name} still carries the retired Easy Boost field`);
  }
});
