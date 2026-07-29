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

async function listFiles(directory, prefix = '') {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relativePath = path.posix.join(prefix, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listFiles(path.join(directory, entry.name), relativePath));
    } else if (entry.isFile()) {
      files.push(relativePath);
    }
  }
  return files;
}

const names = (await listFiles(outputDirectory)).sort();
const assets = {};
for (const name of names) {
  const file = path.join(outputDirectory, name);
  const content = await fs.readFile(file);
  assets[name] = {
    bytes: content.length,
    sha256: crypto.createHash('sha256').update(content).digest('hex'),
  };
}

/*
 * Разметка подключает одну точку входа, поэтому проверить только теги <script> уже недостаточно:
 * опечатка в импорте внутри модуля сломала бы приложение молча. Идём по статическим импортам от
 * точки входа и убеждаемся, что каждый файл действительно попал в сборку.
 */
async function verifyModuleGraph(entry) {
  const seen = new Set();
  const queue = [entry];
  while (queue.length) {
    const name = queue.shift();
    if (seen.has(name)) continue;
    seen.add(name);
    if (!assets[name]) throw new Error(`Missing frontend module: ${name}`);
    const source = await fs.readFile(path.join(outputDirectory, name), 'utf8');
    /* Импорт — всегда инструкция верхнего уровня, поэтому ищем от начала строки:
       иначе `from '…'` внутри учебного текста будет принят за зависимость. */
    for (const statement of source.matchAll(/^import\s+[^;']*from\s*'([^']+)'|^import\s*'([^']+)'/gmu)) {
      const specifier = statement[1] || statement[2];
      if (!specifier.startsWith('.')) throw new Error(`Frontend module ${name} imports outside the bundle: ${specifier}`);
      queue.push(path.posix.normalize(path.posix.join(path.posix.dirname(name), specifier)));
    }
  }
  return seen;
}

const html = await fs.readFile(path.join(outputDirectory, 'index.html'), 'utf8');
const entryPoints = [];
for (const source of html.matchAll(/<script[^>]+src="\/([^"]+)"/gu)) {
  if (!assets[source[1]]) throw new Error(`Missing frontend script: ${source[1]}`);
  entryPoints.push(source[1]);
}
if (!entryPoints.length) throw new Error('index.html подключает ноль скриптов — приложение не запустится');
for (const entry of entryPoints) await verifyModuleGraph(entry);

await fs.writeFile(
  path.join(outputDirectory, 'asset-manifest.json'),
  `${JSON.stringify({ generatedBy: 'npm run build:frontend', assets }, null, 2)}\n`,
  'utf8',
);
console.log(`Frontend build created ${Object.keys(assets).length} verified assets in dist/public.`);
