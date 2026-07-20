import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const frontendPath = new URL('../public/index.html', import.meta.url);
const frontendApiPath = new URL('../public/api.js', import.meta.url);
const frontendScriptPaths = ['sync.js', 'router.js', 'app.js', 'privacy.js', 'tts.js', 'pwa.js'].map(
  (name) => new URL(`../public/${name}`, import.meta.url),
);
const serverPath = new URL('../server.js', import.meta.url);

async function readFrontend() {
  const [html, api, scripts] = await Promise.all([
    fs.readFile(frontendPath, 'utf8'),
    fs.readFile(frontendApiPath, 'utf8'),
    Promise.all(frontendScriptPaths.map((path) => fs.readFile(path, 'utf8'))),
  ]);
  const script = scripts.join('\n');
  return { html, api, scripts, script, combined: `${html}\n${api}\n${script}` };
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
  assert.match(server, /const user = await getUser\(username\);[\s\S]{0,80}if \(!user\)/u);
  assert.match(server, /isSessionActive\(claims\.sid, username\)/u);
  assert.match(server, /req\.user = username/u);
  assert.doesNotMatch(server, /req\.query\.t(?:\W|$)/u);
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
  assert.doesNotMatch(frontend, /\/api\/ai|legacyAi|callGemini/u);
  assert.match(frontend, /post\('\/api\/v1\/ai\/generate-content'/);
});

test('frontend uses ordered external scripts that remain syntactically valid', async () => {
  const { html, api, scripts } = await readFrontend();
  assert.match(html, /<script src="\/api\.js" defer><\/script>\s*<script src="\/sync\.js" defer><\/script>\s*<script src="\/router\.js" defer><\/script>\s*<script src="\/app\.js" defer><\/script>\s*<script src="\/privacy\.js" defer><\/script>\s*<script src="\/tts\.js" defer><\/script>/u);
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc\s*=)(?:\s[^>]*)?>/iu);
  assert.doesNotThrow(() => new Function(api));
  for (const script of scripts) assert.doesNotThrow(() => new Function(script));
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
    'fillDefaults', 'genWords', 'initSpeaking', 'r_add', 'setTask', 'lStop',
    'lPlayRaw', 'wSpeak',
  ];
  for (const name of guardedNames) {
    const declarations = script.match(new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`, 'gu')) || [];
    assert.equal(declarations.length, 1, `${name} must have one declaration`);
  }
  assert.doesNotMatch(script, /\bstartApp\s*=\s*(?:async\s+)?function/u);
  assert.match(script, /const START_HOOKS=\[\]/u);
  assert.doesNotMatch(script, /\btab\s*=\s*function/u);
  assert.match(script, /const ROUTE_HOOKS=\[\]/u);
  for (const name of ['doLogin', 'doRegister', 'logout', 'renderProfile', 'tgInit', 'tgPoll', 'tgClick', 'save', 'fillDefaults', 'checkWriting', 'initWords', 'genWords', 'initGrammar', 'initReading', 'r_add', 'initListening', 'setTask', 'initSpeaking', 'lStop', 'lPlayRaw', 'wSpeak']) {
    assert.doesNotMatch(script, new RegExp(`\\b${name}\\s*=\\s*(?:async\\s+)?function`, 'u'));
  }
  assert.match(script, /const PROFILE_HOOKS=\[\]/u);
});

test('PWA shell is installable and never caches API responses', async () => {
  const { html } = await readFrontend();
  const [manifestText, worker, offline] = await Promise.all([
    fs.readFile(new URL('../public/manifest.json', import.meta.url), 'utf8'),
    fs.readFile(new URL('../public/service-worker.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../public/offline.html', import.meta.url), 'utf8'),
  ]);
  const manifest = JSON.parse(manifestText);
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.start_url, '/');
  assert.ok(manifest.icons.some((icon) => icon.sizes === '192x192' && icon.type === 'image/png'));
  assert.ok(manifest.icons.some((icon) => icon.sizes === '512x512' && icon.type === 'image/png'));
  assert.ok(manifest.icons.some((icon) => icon.purpose === 'maskable'));
  assert.match(html, /<link rel="manifest" href="\/manifest\.json">/u);
  assert.match(worker, /url\.pathname\.startsWith\('\/api\/'\)/u);
  assert.match(worker, /caches\.match\('\/offline\.html'\)/u);
  assert.doesNotMatch(offline, /<script|onclick=/iu);
});

test('frontend keeps zoom, keyboard focus and assistive announcements accessible', async () => {
  const { html, script } = await readFrontend();
  assert.doesNotMatch(html, /user-scalable\s*=\s*no|maximum-scale\s*=\s*1/iu);
  assert.match(html, /viewport-fit=cover/u);
  assert.match(html, /:focus-visible/u);
  assert.match(html, /prefers-reduced-motion/u);
  assert.match(html, /id="w_editor"[^>]*role="textbox"[^>]*aria-label="Письменный ответ"/u);
  assert.match(script, /setAttribute\('aria-live','polite'\)/u);
});

test('new production users start with zero real progress', async () => {
  const { script } = await readFrontend();
  assert.doesNotMatch(script, /learned==null\?320|streak\|\|7|dayMin\|\|18/u);
  assert.match(script, /learned=d\.learned==null\?0:d\.learned/u);
  assert.match(script, /prog=d\.prog\|\|\{words:0,gram:0,read:0,listen:0,write:0,speak:0\}/u);
});

test('progress sync queues the latest state and retries when connectivity returns', async () => {
  const sync = await fs.readFile(new URL('../public/sync.js', import.meta.url), 'utf8');
  assert.match(sync, /easyboost_pending_modules_v2/u);
  assert.match(sync, /navigator\.onLine===false/u);
  assert.match(sync, /window\.addEventListener\('online',flush\)/u);
  assert.match(sync, /EasyBoostApi\.post\('\/api\/progress\/modules',\{modules:modules\},true\)/u);
  assert.match(sync, /error\.status>=500/u);
  assert.match(sync, /pending&&pending\.modules/u);
  assert.doesNotMatch(sync, /push\(/u);
});

test('module progress endpoint merges validated keys instead of replacing the document', async () => {
  const [server, postgres] = await Promise.all([
    fs.readFile(serverPath, 'utf8'),
    fs.readFile(new URL('../storage/postgres-repository.js', import.meta.url), 'utf8'),
  ]);
  assert.match(server, /app\.post\('\/api\/progress\/modules', auth/u);
  assert.match(server, /validateProgress\(modules\)/u);
  assert.match(postgres, /COALESCE\(user_progress\.data, '\{\}'::jsonb\) \|\| EXCLUDED\.data/u);
});

test('frontend maps network, auth, subscription, limit and provider errors separately', async () => {
  const { api, script } = await readFrontend();
  assert.match(api, /code === 'NETWORK_ERROR'/u);
  assert.match(api, /status === 401/u);
  assert.match(api, /status === 402 \|\| status === 403/u);
  assert.match(api, /status === 429/u);
  assert.match(api, /context === 'telegram'/u);
  assert.match(api, /context === 'ai'/u);
  assert.doesNotMatch(script, /Сервер недоступен/u);
});

test('AI, TTS and STT endpoints return stable public error codes', async () => {
  const server = await fs.readFile(serverPath, 'utf8');
  for (const code of ['AI_NOT_CONFIGURED', 'TTS_UNAVAILABLE', 'STT_NOT_CONFIGURED', 'STT_PROVIDER_UNAVAILABLE', 'STT_UNAVAILABLE']) {
    assert.match(server, new RegExp(`code: '${code}'`, 'u'));
  }
  assert.match(server, /'AI_PROVIDER_UNAVAILABLE'/u);
  assert.match(server, /code: 'AI_BUDGET_EXHAUSTED'/u);
  assert.doesNotMatch(server, /res\.status\((?:502|503)\)\.json\(\{ error: '(?:ИИ|Озвучка|STT)[^']*' \+ /u);
});

test('validated generated content is cached before external AI budget checks', async () => {
  const server = await fs.readFile(serverPath, 'utf8');
  const cacheLookup = server.indexOf('const stored = await getGeneratedTask(req.user, requestHash)');
  const budgetCheck = server.indexOf('if (!await hasAiBudget())', cacheLookup);
  const providerCall = server.indexOf('const response = await askProvider(provider', cacheLookup);
  assert.ok(cacheLookup > 0 && budgetCheck > cacheLookup && providerCall > budgetCheck);
  assert.match(server, /saveGeneratedTask\(req\.user/u);
  assert.match(server, /promptVersion: CONTENT_PROMPT_VERSION, input/u);
});

test('audio endpoints enforce upload controls, timeouts and private cached responses', async () => {
  const [server, frontend] = await Promise.all([
    fs.readFile(serverPath, 'utf8'),
    fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
  ]);
  assert.match(server, /validateAudioUpload\(req\.headers\['content-type'\], buf, config\.ai\.sttMaxBytes\)/u);
  assert.match(server, /controller\.abort\(\), config\.ai\.sttTimeoutMs/u);
  assert.match(server, /pruneAudioCache\(TTS_DIR/u);
  assert.match(server, /Cache-Control', 'private, max-age=604800'/u);
  assert.doesNotMatch(server, /Cache-Control', 'public, max-age=604800'/u);
  assert.match(frontend, /function spDeleteRecording\(/u);
  assert.match(frontend, /function spFlagTranscript\(/u);
  assert.match(frontend, /Произношение, интонация, паузы и беглость не оценивались/u);
});

test('production documentation covers local setup, API, database and operations', async () => {
  const paths = ['../README.md', '../docs/openapi.yaml', '../docs/DATABASE_SCHEMA.md', '../docs/AI_OPERATIONS.md', '../docs/KEY_ROTATION.md', '../docs/SUPPORT.md', '../docs/KNOWN_LIMITATIONS.md', '../docs/TELEGRAM_ADMIN.md', '../docs/AI_QUALITY.md'];
  const documents = await Promise.all(paths.map((path) => fs.readFile(new URL(path, import.meta.url), 'utf8')));
  assert.match(documents[0], /npm ci[\s\S]*npm run check[\s\S]*npm test/u);
  for (const route of ['/health/live', '/health/ready', '/api/tg/start', '/api/me', '/api/account/export', '/api/account', '/api/privacy/consent', '/api/progress/modules', '/api/module-attempts', '/api/v1/ai/generate-content', '/api/v1/ai/evaluate-writing', '/api/v1/ai/evaluate-speaking', '/api/v1/ai/generate-speaking-sample', '/api/tts', '/api/stt']) {
    assert.match(documents[1], new RegExp(route.replaceAll('/', '\\/'), 'u'));
  }
  assert.match(documents[2], /user_progress/u);
  assert.match(documents[3], /WRITING_PROMPT_VERSION/u);
  assert.match(documents[4], /JWT_SECRET/u);
  assert.match(documents[5], /requestId/u);
  assert.match(documents[6], /Известные ограничения/u);
  assert.match(documents[7], /TELEGRAM_BOT_TOKEN/u);
  assert.match(documents[8], /quality:release/u);
});

test('privacy UI separates text and voice consent and explains external processing', async () => {
  const [script, policy] = await Promise.all([
    fs.readFile(new URL('../public/privacy.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../public/privacy.html', import.meta.url), 'utf8'),
  ]);
  assert.match(script, /id="privacyText" type="checkbox"/u);
  assert.match(script, /id="privacyVoice" type="checkbox"/u);
  assert.match(script, /xAI[\s\S]*Groq/u);
  assert.match(script, /\/api\/privacy\/consent/u);
  assert.match(policy, /не является официальн/u);
  assert.match(policy, /Сроки хранения/u);
});

test('demo mode is isolated from persistence and paid AI calls', async () => {
  const { html, script } = await readFrontend();
  assert.match(html, /id="demo_btn"[^>]*onclick="startDemo\(\)"/u);
  assert.match(script, /function save\(\)\{\s*if\(DEMO_MODE\)return;/u);
  assert.match(script, /function generateAiContent\(operation,payload\)\{if\(DEMO_MODE\)return Promise\.reject/u);
  assert.match(script, /if\(DEMO_MODE\)\{renderReview\(localReview/u);
  assert.match(script, /Демо · войти для сохранения/u);
});
