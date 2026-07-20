import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const frontendPath = new URL('../public/index.html', import.meta.url);
const frontendScriptPath = new URL('../public/app.js', import.meta.url);
const serverPath = new URL('../server.js', import.meta.url);

async function readFrontend() {
  const [html, script] = await Promise.all([
    fs.readFile(frontendPath, 'utf8'),
    fs.readFile(frontendScriptPath, 'utf8'),
  ]);
  return { html, script, combined: `${html}\n${script}` };
}

test('frontend never persists or sends the session JWT', async () => {
  const { combined: frontend } = await readFrontend();
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

test('startup logs do not expose the Telegram admin identifier', async () => {
  const server = await fs.readFile(serverPath, 'utf8');
  assert.doesNotMatch(server, /console\.log\(['"]Telegram admin id:/u);
  assert.match(server, /Telegram admin notifications:/u);
});

test('frontend contains no embedded or browser-managed AI credentials', async () => {
  const { combined: frontend } = await readFrontend();
  assert.doesNotMatch(frontend, /EMBEDDED_KEY/);
  assert.doesNotMatch(frontend, /localStorage\.(?:getItem|setItem)\(['"]eb_(?:key|groq|model|groq_model)/);
  assert.doesNotMatch(frontend, /x-goog-api-key/i);
  assert.doesNotMatch(frontend, /generativelanguage\.googleapis\.com|api\.groq\.com|api\.x\.ai/i);
  assert.match(frontend, /apiPost\('\/api\/ai'/);
});

test('frontend uses one external script that remains syntactically valid', async () => {
  const { html, script } = await readFrontend();
  assert.match(html, /<script src="\/app\.js" defer><\/script>/u);
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc\s*=)(?:\s[^>]*)?>/iu);
  assert.doesNotThrow(() => new Function(script));
});
