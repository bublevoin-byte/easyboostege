import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import { inflateSync } from 'node:zlib';

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

function paeth(left, up, upperLeft) {
  const estimate = left + up - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const upDistance = Math.abs(estimate - up);
  const diagonalDistance = Math.abs(estimate - upperLeft);
  if (leftDistance <= upDistance && leftDistance <= diagonalDistance) return left;
  return upDistance <= diagonalDistance ? up : upperLeft;
}

function decodeRgbPng(buffer) {
  assert.equal(buffer.subarray(1, 4).toString('ascii'), 'PNG');
  const idat = [];
  let width;
  let height;
  for (let offset = 8; offset < buffer.length;) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString('ascii');
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      assert.equal(data[8], 8, 'install icon must use 8-bit channels');
      assert.equal(data[9], 2, 'install icon must use RGB channels');
    } else if (type === 'IDAT') idat.push(data);
    offset += length + 12;
  }
  const packed = inflateSync(Buffer.concat(idat));
  const stride = width * 3;
  const pixels = Buffer.alloc(stride * height);
  let sourceOffset = 0;
  let previous = Buffer.alloc(stride);
  for (let y = 0; y < height; y += 1) {
    const filter = packed[sourceOffset];
    sourceOffset += 1;
    const row = Buffer.alloc(stride);
    for (let x = 0; x < stride; x += 1) {
      const raw = packed[sourceOffset + x];
      const left = x >= 3 ? row[x - 3] : 0;
      const up = previous[x];
      const upperLeft = x >= 3 ? previous[x - 3] : 0;
      const predictor = [0, left, up, Math.floor((left + up) / 2), paeth(left, up, upperLeft)][filter];
      assert.notEqual(predictor, undefined, `unsupported PNG filter ${filter}`);
      row[x] = (raw + predictor) & 0xff;
    }
    row.copy(pixels, y * stride);
    previous = row;
    sourceOffset += stride;
  }
  return { width, height, pixels };
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
  assert.match(html, />Aisy\.space<\/div>/u);
  assert.match(html, />Aisy ЕГЭ — Английский<\/div>/u);
  assert.match(html, /«Эйси»/u);
  assert.match(offline, /Aisy\.space/u);
  assert.match(offline, /Ася/u);
  assert.match(privacy, /Aisy\.space/u);
  assert.match(privacy, /Ася/u);
  assert.match(pwa, /Доступна новая версия Aisy\.space/u);
  assert.match(pwa, /easyboost:update-ready/u, 'internal update event is a compatibility contract');

  for (const [surface, source] of Object.entries({ html, manifestText, offline, privacy, pwa })) {
    assert.doesNotMatch(source, /Easy Boost/u, `${surface} exposes the retired public brand`);
  }
});

test('shared Aisy theme keeps light and dark interaction states accessible', async () => {
  const css = await readPublic('aisy-theme.css');
  const canonical = customProperties(rule(css, ':root'));
  const light = new Map();
  const dark = new Map();
  const requiredColors = [
    '--aisy-color-background', '--aisy-color-surface', '--aisy-color-text', '--aisy-color-text-muted',
    '--aisy-color-primary', '--aisy-color-on-primary', '--aisy-color-focus', '--aisy-color-success',
    '--aisy-color-warning', '--aisy-color-danger',
  ];

  for (const name of requiredColors) {
    const pair = (canonical.get(name) || '').match(/^light-dark\((#[0-9a-f]{6}),\s*(#[0-9a-f]{6})\)$/iu);
    assert.ok(pair, `canonical theme misses the light/dark pair for ${name}`);
    light.set(name, pair[1]);
    dark.set(name, pair[2]);
  }
  for (const theme of [light, dark]) {
    assert.ok(contrast(theme.get('--aisy-color-text'), theme.get('--aisy-color-background')) >= 4.5);
    assert.ok(contrast(theme.get('--aisy-color-text-muted'), theme.get('--aisy-color-surface')) >= 4.5);
    assert.ok(contrast(theme.get('--aisy-color-on-primary'), theme.get('--aisy-color-primary')) >= 4.5);
    assert.ok(contrast(theme.get('--aisy-color-focus'), theme.get('--aisy-color-background')) >= 3);
  }

  assert.equal(canonical.get('--aisy-touch-target'), '44px');
  assert.match(css, /:root\[data-theme="light"\]\s*\{\s*color-scheme:\s*light;/u);
  assert.match(css, /:root\[data-theme="dark"\]\s*\{\s*color-scheme:\s*dark;/u);
  assert.doesNotMatch(rule(css, ':root[data-theme="dark"]'), /--aisy-color-/u);
  assert.match(css, /@media\s*\(prefers-color-scheme:\s*dark\)[\s\S]*:root:not\(\[data-theme\]\)/u);
  assert.match(css, /:focus-visible[\s\S]{0,180}outline:\s*3px solid var\(--aisy-color-focus\)/u);
  assert.match(css, /min-block-size:\s*var\(--aisy-touch-target\)/u);
  assert.match(css, /touch-action:\s*manipulation/u);
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*animation-duration:\s*0\.01ms/u);
});

test('the accessible Asya mark and shared theme stay inside the offline public shell', async () => {
  const [html, offline, privacy, privacyScript, icon, worker] = await Promise.all([
    readPublic('index.html'),
    readPublic('offline.html'),
    readPublic('privacy.html'),
    readPublic('privacy.js'),
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
  assert.match(html, /<img[^>]*src="\/pwa-icon\.svg"[^>]*alt="Ася — голосовой помощник Aisy\.space"/u);
  assert.match(privacyScript, /разговора с Асей/u);
  assert.match(privacyScript, /global\.EasyBoostApi/u, 'internal frontend namespace must remain stable');
  assert.doesNotMatch(privacyScript, /Easy Boost не сохраняет/u);
  const privacyFontSizes = [...privacyScript.matchAll(/font(?:-size)?\s*:[^;{}]*?(\d+(?:\.\d+)?)px/gu)]
    .map((match) => Number(match[1]));
  assert.ok(privacyFontSizes.length >= 8);
  assert.equal(privacyFontSizes.every((size) => size >= 16), true, 'privacy body/control text must stay >=16px');
});

test('every declared raster install icon carries the Aisy indigo mark instead of the retired orange B', async () => {
  for (const [name, expectedSize] of [
    ['icon-192.png', 192],
    ['icon-512.png', 512],
    ['icon-maskable-512.png', 512],
  ]) {
    const image = decodeRgbPng(await fs.readFile(new URL(name, publicUrl)));
    assert.equal(image.width, expectedSize);
    assert.equal(image.height, expectedSize);
    let indigo = 0;
    let retiredOrange = 0;
    for (let offset = 0; offset < image.pixels.length; offset += 3) {
      const rgb = image.pixels.subarray(offset, offset + 3);
      if (rgb[0] === 0x58 && rgb[1] === 0x46 && rgb[2] === 0xc7) indigo += 1;
      if (rgb[0] === 0xf2 && rgb[1] === 0x68 && rgb[2] === 0x3f) retiredOrange += 1;
    }
    const total = image.width * image.height;
    assert.ok(indigo / total >= 0.35, `${name} does not visibly carry the Aisy indigo field`);
    assert.ok(retiredOrange / total < 0.001, `${name} still carries the retired Easy Boost field`);
  }
});
