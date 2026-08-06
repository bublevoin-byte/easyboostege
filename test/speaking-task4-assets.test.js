import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { SPEAKING_TASK4_CATALOG } from '../public/content/speaking/task4-v1.js';
import { SPEAKING_TASK4_PHOTO_MANIFEST } from '../public/assets/speaking/task4-v1/manifest.js';

const ROOT = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngDimensions(buffer) {
  assert.equal(buffer.subarray(0, 8).equals(PNG_SIGNATURE), true, 'asset must have a PNG signature');
  assert.equal(buffer.subarray(12, 16).toString('ascii'), 'IHDR', 'asset must begin with a PNG IHDR chunk');
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

test('Speaking task 4 manifest resolves 60 original built-in generated photo-pair assets with verified integrity', async () => {
  assert.equal(SPEAKING_TASK4_PHOTO_MANIFEST.schemaVersion, 'speaking-task4-photo-pairs-v1');
  assert.equal(SPEAKING_TASK4_PHOTO_MANIFEST.catalog.id, 'speaking-pilot-v1');
  assert.equal(SPEAKING_TASK4_PHOTO_MANIFEST.catalog.revision, 1);
  assert.deepEqual(SPEAKING_TASK4_PHOTO_MANIFEST.generator, {
    mode: 'built_in_image_gen',
    provider: 'OpenAI',
    generatedAt: '2026-08-06',
    originalOnly: true,
    externalSources: [],
  });
  assert.equal(SPEAKING_TASK4_PHOTO_MANIFEST.assets.length, 60);

  const taskAssets = new Map(SPEAKING_TASK4_CATALOG.tasks.map((task) => [task.photoPair.assetId, task.photoPair]));
  const seenHashes = new Set();
  const seenPaths = new Set();
  for (const asset of SPEAKING_TASK4_PHOTO_MANIFEST.assets) {
    assert.deepEqual(Object.keys(asset).sort(), [
      'assetId', 'bytes', 'fileName', 'height', 'mime', 'panels', 'promptId',
      'provenance', 'sha256', 'src', 'width',
    ]);
    assert.equal(asset.mime, 'image/png');
    assert.match(asset.sha256, /^[0-9a-f]{64}$/u);
    assert.match(asset.promptId, /^speaking-task4-photo-pair\.[a-z0-9-]+\.v1$/u);
    assert.equal(asset.width >= 1_024, true);
    assert.equal(asset.height >= 768, true);
    assert.equal(asset.width / asset.height >= 1.4, true);
    assert.equal(asset.bytes >= 100_000 && asset.bytes <= 10_000_000, true);
    assert.equal(asset.panels.length, 2);
    assert.equal(asset.panels[0].number, 1);
    assert.equal(asset.panels[1].number, 2);
    assert.equal(asset.provenance.kind, 'original_ai_generated');
    assert.equal(asset.provenance.tool, 'OpenAI built-in image_gen');
    assert.equal(asset.provenance.externalSource, false);
    assert.equal(asset.provenance.copyrightedSource, false);

    const catalogPair = taskAssets.get(asset.assetId);
    assert.ok(catalogPair, `manifest asset ${asset.assetId} must be referenced by the catalog`);
    assert.equal(asset.src, catalogPair.src);
    assert.deepEqual(asset.panels, catalogPair.panels);
    assert.equal(seenPaths.has(asset.src), false, `duplicate asset path ${asset.src}`);
    assert.equal(seenHashes.has(asset.sha256), false, `duplicate asset content ${asset.sha256}`);
    seenPaths.add(asset.src);
    seenHashes.add(asset.sha256);

    const filePath = path.join(ROOT, 'public', ...asset.src.split('/').filter(Boolean));
    const file = await fs.readFile(filePath);
    const dimensions = pngDimensions(file);
    assert.equal(file.length, asset.bytes);
    assert.deepEqual(dimensions, { width: asset.width, height: asset.height });
    assert.equal(crypto.createHash('sha256').update(file).digest('hex'), asset.sha256);
  }

  assert.equal(taskAssets.size, 60);
  assert.equal(seenPaths.size, 60);
  assert.equal(seenHashes.size, 60);
});

test('task 4 raster pairs remain runtime-managed and outside the application startup shell', async () => {
  const buildSource = await fs.readFile(path.join(ROOT, 'scripts', 'build-frontend.js'), 'utf8');
  const html = await fs.readFile(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const worker = await fs.readFile(path.join(ROOT, 'public', 'service-worker.js'), 'utf8');
  assert.match(buildSource, /name\.startsWith\('assets\/speaking\/task4-v1\/'\) && name\.endsWith\('\.png'\)/u);
  assert.doesNotMatch(html, /assets\/speaking\/task4-v1\//u);
  assert.doesNotMatch(worker, /assets\/speaking\/task4-v1\/[a-z0-9-]+\.png/u);
});
