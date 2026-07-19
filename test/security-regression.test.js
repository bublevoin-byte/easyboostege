import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const frontendPath = new URL('../public/index.html', import.meta.url);
const serverPath = new URL('../server.js', import.meta.url);

test('frontend never persists or sends the session JWT', async () => {
  const frontend = await fs.readFile(frontendPath, 'utf8');
  assert.doesNotMatch(frontend, /localStorage\.setItem\(['"]eb_token/);
  assert.doesNotMatch(frontend, /Bearer ['"]?\s*\+\s*TOKEN/);
  assert.doesNotMatch(frontend, /c\s*&&\s*c\.token/);
});

test('session endpoints do not expose JWT in JSON', async () => {
  const server = await fs.readFile(serverPath, 'utf8');
  assert.doesNotMatch(server, /res\.json\(\{\s*token\s*[,}]/);
  assert.match(server, /authenticated:\s*true/);
});

