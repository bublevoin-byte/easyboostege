import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectDirectory = fileURLToPath(new URL('..', import.meta.url));
const sourceDirectory = path.join(projectDirectory, 'public');
const outputDirectory = path.join(projectDirectory, 'dist', 'public');

await fs.rm(outputDirectory, { recursive: true, force: true });
await fs.mkdir(path.dirname(outputDirectory), { recursive: true });
await fs.cp(sourceDirectory, outputDirectory, { recursive: true });

const names = (await fs.readdir(outputDirectory)).sort();
const assets = {};
for (const name of names) {
  const file = path.join(outputDirectory, name);
  const stat = await fs.stat(file);
  if (!stat.isFile()) continue;
  const content = await fs.readFile(file);
  assets[name] = {
    bytes: content.length,
    sha256: crypto.createHash('sha256').update(content).digest('hex'),
  };
}

const html = await fs.readFile(path.join(outputDirectory, 'index.html'), 'utf8');
for (const source of html.matchAll(/<script[^>]+src="\/([^"]+)"/gu)) {
  if (!assets[source[1]]) throw new Error(`Missing frontend script: ${source[1]}`);
}

await fs.writeFile(
  path.join(outputDirectory, 'asset-manifest.json'),
  `${JSON.stringify({ generatedBy: 'npm run build:frontend', assets }, null, 2)}\n`,
  'utf8',
);
console.log(`Frontend build created ${Object.keys(assets).length} verified assets in dist/public.`);
