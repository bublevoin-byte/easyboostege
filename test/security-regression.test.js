import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const frontendPath = new URL('../public/index.html', import.meta.url);
const frontendApiPath = new URL('../public/api.js', import.meta.url);
const frontendScriptPath = new URL('../public/app.js', import.meta.url);
const serverPath = new URL('../server.js', import.meta.url);

async function readFrontend() {
  const [html, api, script] = await Promise.all([
    fs.readFile(frontendPath, 'utf8'),
    fs.readFile(frontendApiPath, 'utf8'),
    fs.readFile(frontendScriptPath, 'utf8'),
  ]);
  return { html, api, script, combined: `${html}\n${api}\n${script}` };
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
  assert.match(frontend, /post\('\/api\/ai'/);
});

test('frontend uses ordered external scripts that remain syntactically valid', async () => {
  const { html, api, script } = await readFrontend();
  assert.match(html, /<script src="\/api\.js" defer><\/script>\s*<script src="\/app\.js" defer><\/script>/u);
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc\s*=)(?:\s[^>]*)?>/iu);
  assert.doesNotThrow(() => new Function(api));
  assert.doesNotThrow(() => new Function(script));
});

test('legacy application code delegates network access to the API layer', async () => {
  const { api, script } = await readFrontend();
  assert.doesNotMatch(script, /\bfetch\s*\(/u);
  assert.match(script, /const apiPost=EasyBoostApi\.post/u);
  assert.match(script, /const apiPostBinary=EasyBoostApi\.postBinary/u);
  assert.match(api, /credentials:\s*'same-origin'/u);
  assert.match(api, /requestId/u);
});

test('legacy application script has no duplicate top-level function declarations', async () => {
  const { script } = await readFrontend();
  const guardedNames = [
    'startApp', 'tab', 'checkWriting', 'trWord', 'initReading', 'initGrammar', 'renderG',
    'pickG', 'nextG', 'initListening', 'playListen', 'toggleScript', 'doLogin',
    'doRegister', 'logout', 'renderProfile', 'tgInit', 'tgPoll', 'tgClick', 'save',
    'fillDefaults', 'genWords', 'initSpeaking', 'r_add', 'setTask',
  ];
  for (const name of guardedNames) {
    const declarations = script.match(new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`, 'gu')) || [];
    assert.equal(declarations.length, 1, `${name} must have one declaration`);
  }
  assert.doesNotMatch(script, /\bstartApp\s*=\s*(?:async\s+)?function/u);
  assert.match(script, /const START_HOOKS=\[\]/u);
  assert.doesNotMatch(script, /\btab\s*=\s*function/u);
  assert.match(script, /const ROUTE_HOOKS=\[\]/u);
  for (const name of ['doLogin', 'doRegister', 'logout', 'renderProfile', 'tgInit', 'tgPoll', 'tgClick', 'save', 'fillDefaults', 'checkWriting', 'initWords', 'genWords', 'initGrammar', 'initReading', 'r_add', 'initListening', 'setTask', 'initSpeaking']) {
    assert.doesNotMatch(script, new RegExp(`\\b${name}\\s*=\\s*(?:async\\s+)?function`, 'u'));
  }
  assert.match(script, /const PROFILE_HOOKS=\[\]/u);
});
