import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SPEAKING_TASK4_CATALOG } from '../public/content/speaking/task4-v1.js';

const ROOT = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const ASSET_DIRECTORY = path.join(ROOT, 'public', 'assets', 'speaking', 'task4-v1');
const OUTPUT = path.join(ASSET_DIRECTORY, 'manifest.js');
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngDimensions(buffer, fileName) {
  if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)
    || buffer.subarray(12, 16).toString('ascii') !== 'IHDR') {
    throw new Error(`SPEAKING_TASK4_ASSET_NOT_PNG: ${fileName}`);
  }
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

const assets = [];
for (const task of SPEAKING_TASK4_CATALOG.tasks) {
  const fileName = path.basename(task.photoPair.src);
  const file = await fs.readFile(path.join(ASSET_DIRECTORY, fileName));
  const dimensions = pngDimensions(file, fileName);
  assets.push({
    assetId: task.photoPair.assetId,
    fileName,
    src: task.photoPair.src,
    mime: 'image/png',
    ...dimensions,
    bytes: file.length,
    sha256: crypto.createHash('sha256').update(file).digest('hex'),
    promptId: task.photoPair.assetId,
    provenance: {
      kind: 'original_ai_generated',
      tool: 'OpenAI built-in image_gen',
      generatedAt: '2026-08-06',
      externalSource: false,
      copyrightedSource: false,
    },
    panels: task.photoPair.panels,
  });
}

const manifest = {
  schemaVersion: 'speaking-task4-photo-pairs-v1',
  catalog: { id: SPEAKING_TASK4_CATALOG.id, revision: SPEAKING_TASK4_CATALOG.revision },
  generator: {
    mode: 'built_in_image_gen',
    provider: 'OpenAI',
    generatedAt: '2026-08-06',
    originalOnly: true,
    externalSources: [],
  },
  assets,
};

const source = `import { deepFreezeSpeakingCatalog } from '../../../speaking-catalog-contract.js';\n\n`
  + `export const SPEAKING_TASK4_PHOTO_MANIFEST = deepFreezeSpeakingCatalog(${JSON.stringify(manifest, null, 2)});\n`;
await fs.writeFile(OUTPUT, source, 'utf8');
