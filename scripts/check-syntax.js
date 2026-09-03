import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const targets = [
  'ai', 'audio', 'e2e', 'middleware', 'observability', 'performance', 'public', 'routes', 'scripts',
  'security', 'services', 'storage', 'test', 'validation', 'voice-tutor',
  'config.js', 'db.js', 'server.js', 'vite.config.js',
];

function javascriptFiles(target) {
  const absolute = path.join(root, target);
  const stat = fs.statSync(absolute);
  if (stat.isFile()) return absolute.endsWith('.js') ? [absolute] : [];
  return fs.readdirSync(absolute, { withFileTypes: true })
    .filter((entry) => entry.name !== 'node_modules' && entry.name !== 'dist')
    .flatMap((entry) => javascriptFiles(path.join(target, entry.name)));
}

const files = targets.flatMap(javascriptFiles).sort();
for (const file of files) execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' });
console.log(`Syntax check passed for ${files.length} JavaScript files.`);
