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
  assert.match(server, /if \(!await getUser\(username\)\)[\s\S]{0,160}req\.user = username/);
});

test('frontend contains no embedded or browser-managed AI credentials', async () => {
  const frontend = await fs.readFile(frontendPath, 'utf8');
  assert.doesNotMatch(frontend, /EMBEDDED_KEY/);
  assert.doesNotMatch(frontend, /localStorage\.(?:getItem|setItem)\(['"]eb_(?:key|groq|model|groq_model)/);
  assert.doesNotMatch(frontend, /x-goog-api-key/i);
  assert.doesNotMatch(frontend, /generativelanguage\.googleapis\.com|api\.groq\.com|api\.x\.ai/i);
  assert.match(frontend, /apiPost\('\/api\/ai'/);
});

test('frontend inline scripts remain syntactically valid', async () => {
  const frontend = await fs.readFile(frontendPath, 'utf8');
  const scripts = [...frontend.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/giu)];
  assert.ok(scripts.length > 0);
  for (const script of scripts) assert.doesNotThrow(() => new Function(script[1]));
});
