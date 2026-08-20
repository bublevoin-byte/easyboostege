import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { analyzeInlineHandlers } from '../scripts/check-inline-handlers.js';

const frontendPath = new URL('../public/index.html', import.meta.url);
const frontendApiPath = new URL('../public/api.js', import.meta.url);
const frontendAuthPath = new URL('../public/auth.js', import.meta.url);
/*
 * Порядок повторяет порядок импортов в public/main.js — он же прежний порядок тегов <script>.
 * Чанки экранов идут следом: в точку входа они не подключены, но это тот же код приложения,
 * и требования к нему не меняются от того, что он приезжает позже.
 */
const frontendScriptNames = ['main.js', 'globals.js', 'auth.js', 'access.js', 'owner-incarnation.js', 'sync.js', 'store.js', 'components.js', 'router.js', 'aisy-shell.js', 'learning.js', 'vocabulary-domain.js', 'learning-activity-contract.js', 'learning-activity-recorder.js', 'grammar-domain-contract.js', 'reading-catalog-contract.js', 'listening-catalog-contract.js', 'listening-pilot-v1.js', 'listening-audio-contract.js', 'speaking-catalog-contract.js', 'content/speaking/task1-v1.js', 'content/speaking/task2-v1.js', 'speaking-local-recording.js', 'speaking-task1-runtime.js', 'speaking-task2-runtime.js', 'modules/words.js', 'modules/grammar.js', 'modules/reading.js', 'modules/listening.js', 'modules/writing.js', 'modules/speaking.js', 'modules/exam.js', 'modules/progress.js', 'modules/profile.js', 'app.js', 'voice-tutor.js', 'realtime-transport.js', 'screens.js', 'screens/words.js', 'screens/grammar.js', 'screens/reading.js', 'screens/listening.js', 'screens/writing.js', 'screens/speaking.js', 'screens/progress.js', 'screens/profile.js', 'privacy.js', 'tts.js', 'pwa.js'];
const frontendScriptPaths = frontendScriptNames.map((name) => new URL(`../public/${name}`, import.meta.url));
const serverPath = new URL('../server.js', import.meta.url);
const usersRoutePath = new URL('../routes/users.js', import.meta.url);
const progressRoutePath = new URL('../routes/progress.js', import.meta.url);
const aiRoutePath = new URL('../routes/ai.js', import.meta.url);
const mediaRoutePath = new URL('../routes/media.js', import.meta.url);

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
  const [server, authentication] = await Promise.all([
    fs.readFile(serverPath, 'utf8'),
    fs.readFile(new URL('../middleware/authentication.js', import.meta.url), 'utf8'),
  ]);
  const users = await fs.readFile(usersRoutePath, 'utf8');
  assert.doesNotMatch(users, /res\.json\(\{\s*token\s*[,}]/);
  assert.match(users, /authenticated: true/u);
  assert.doesNotMatch(server, /req\.query\.t(?:\W|$)/u);
  assert.match(authentication, /const user = await getUser\(username\);[\s\S]{0,80}if \(!user\)/u);
  assert.match(authentication, /isSessionActive\(claims\.sid, username\)/u);
  assert.match(authentication, /req\.user = authenticated\.username/u);
  // The session cookie stays HttpOnly and the token never reaches a response body.
  assert.match(authentication, /HttpOnly; SameSite=Lax/u);
  assert.doesNotMatch(authentication, /res\.json\([^)]*token/u);
});

test('startup logs do not expose the Telegram admin identifier', async () => {
  const [server, telegram] = await Promise.all([
    fs.readFile(serverPath, 'utf8'),
    fs.readFile(new URL('../services/telegram.js', import.meta.url), 'utf8'),
  ]);
  assert.doesNotMatch(server, /console\.log\(['"]Telegram admin id:/u);
  assert.doesNotMatch(telegram, /Telegram admin id:/u);
  assert.match(telegram, /Telegram admin notifications:/u);
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

test('frontend loads through a single module entry point that keeps the previous order', async () => {
  const { html } = await readFrontend();

  /* Одна точка входа: всё остальное подключается импортами, а не тегами. */
  const tags = [...html.matchAll(/<script[^>]*>(?:[\s\S]*?<\/script>)?/giu)].map((match) => match[0]);
  assert.deepEqual(tags, ['<script type="module" src="/main.js"></script>']);
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc\s*=)(?:\s[^>]*)?>/iu);

  /*
   * Порядок выполнения модулей — часть контракта, а не деталь оформления: модули предметных
   * экранов кладут себя в window.EasyBoostЧто-то, а app.js читает эти имена на верхнем уровне.
   */
  const entry = await fs.readFile(new URL('../public/main.js', import.meta.url), 'utf8');
  const imported = [...entry.matchAll(/^import\s+(?:[^;']*from\s*)?'\.\/([^']+)'/gmu)].map((match) => match[1]);
  assert.deepEqual(imported, [
    'globals.js', 'api.js', 'auth.js', 'owner-incarnation.js', 'sync.js', 'store.js', 'components.js', 'router.js', 'aisy-shell.js',
    'learning.js', 'modules/words.js', 'modules/grammar.js', 'modules/reading.js',
    'modules/listening.js', 'modules/writing.js', 'modules/speaking.js', 'modules/exam.js',
    'modules/progress.js', 'modules/profile.js', 'app.js', 'voice-tutor.js',
    'screens/words.js', 'screens/grammar.js', 'screens/progress.js', 'screens/profile.js',
    'privacy.js', 'tts.js', 'pwa.js',
  ]);

  /*
   * Разделение экранов на статические и ленивые — требование, а не вкус. Раздел 6.1 ТЗ обещает без
   * сети словарные карточки, интервальное повторение, встроенные грамматические тесты, просмотр
   * сохранённого прогресса и изменение предпочтений, поэтому эти четыре экрана обязаны быть в оболочке.
   *
   * Остальные пять экранов обязаны остаться ленивыми: на них держится бюджет раздела 19. Уже открытый
   * пробник продолжает работу из runtime-cache, который его exact preflight успел заполнить до старта.
   * Ни один список не должен молча съехать в другую сторону, поэтому проверяются оба.
   */
  const eagerScreens = imported.filter((name) => name.startsWith('screens/'));
  assert.deepEqual(eagerScreens, [
    'screens/words.js', 'screens/grammar.js', 'screens/progress.js', 'screens/profile.js',
  ]);
  const loader = await fs.readFile(new URL('../public/screens.js', import.meta.url), 'utf8');
  const lazy = [...loader.matchAll(/import\(\s*'\.\/(screens\/[^']+)'\s*\)/gu)].map((match) => match[1]);
  assert.deepEqual(lazy, [
    'screens/listening.js', 'screens/reading.js',
    'screens/writing.js', 'screens/speaking.js', 'screens/ege-mock.js',
  ]);
  for (const screen of eagerScreens) {
    assert.ok(!lazy.includes(screen), `${screen} не может быть одновременно в оболочке и чанком`);
  }
});

test('every frontend module is syntactically valid as an ES module', async () => {
  /*
   * new Function() здесь больше не годится: он разбирает текст как классический скрипт и споткнётся
   * о первый же import. Node разбирает эти файлы ровно так же, как их разберёт браузер.
   */
  for (const path of [frontendApiPath, ...frontendScriptPaths]) {
    assert.doesNotThrow(
      () => execFileSync(process.execPath, ['--check', fileURLToPath(path)], { stdio: 'pipe' }),
      `${path.pathname} должен оставаться корректным ES-модулем`,
    );
  }
});

test('no frontend module relies on a declaration becoming a global name', async () => {
  /*
   * Инлайновый обработчик ищет имя на window. В классическом скрипте оно попадало туда само,
   * в модуле — нет, и клик молча ломается. Разбор обработчиков — единственная проверка,
   * которая это ловит без браузера.
   */
  const report = await analyzeInlineHandlers();
  assert.deepEqual(report.missing, []);
  assert.ok(report.handlers.length > 100, 'разбор обработчиков не должен схлопнуться до пустого списка');
  assert.ok(report.bound.has('tab'), 'window.tab нужен разметке и e2e-сценарию производительности');
  assert.ok(report.bound.has('startApp'), 'window.startApp вызывает e2e-сценарий demo');
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
    'pickG', 'nextG', 'initListening', 'doLogin',
    'doRegister', 'logout', 'renderProfile', 'tgInit', 'tgPoll', 'tgClick', 'save',
    'genWords', 'initSpeaking', 'r_add', 'setTask', 'lStop',
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
  for (const name of ['doLogin', 'doRegister', 'logout', 'renderProfile', 'tgInit', 'tgPoll', 'tgClick', 'save', 'checkWriting', 'initWords', 'genWords', 'initGrammar', 'initReading', 'r_add', 'initListening', 'setTask', 'initSpeaking', 'lStop', 'lPlayRaw', 'wSpeak']) {
    assert.doesNotMatch(script, new RegExp(`\\b${name}\\s*=\\s*(?:async\\s+)?function`, 'u'));
  }
  assert.match(script, /const PROFILE_HOOKS=\[\]/u);
});

test('legacy prototype screens stay out of the production bundle', async () => {
  const { script } = await readFrontend();
  const removedNames = [
    'showCard', 'flipWord', 'rateCard', 'lOpt', 'resetSpeaking', 'toggleRec', 'playRec',
    'playListen', 'toggleScript',
  ];
  for (const name of removedNames) {
    assert.doesNotMatch(script, new RegExp(`function\\s+${name}\\s*\\(`, 'u'), `${name} is a removed prototype`);
  }
  // These prototypes called a helper that no longer exists and would have thrown if reached.
  assert.doesNotMatch(script, /\bbump\s*\(/u);
  assert.doesNotMatch(script, /\bconst WORDS\s*=/u);
  assert.doesNotMatch(script, /\bconst SPK_Q\s*=/u);
});

test('authentication endpoints are isolated behind the auth module', async () => {
  const [auth, app] = await Promise.all([
    fs.readFile(frontendAuthPath, 'utf8'),
    fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
  ]);
  for (const endpoint of ['/api/v1/login', '/api/v1/register', '/api/v1/logout', '/api/v1/me', '/api/v1/tg/start', '/api/v1/tg/check']) {
    assert.match(auth, new RegExp(endpoint.replaceAll('/', '\\/'), 'u'));
    assert.doesNotMatch(app, new RegExp(`(?:apiGet|apiPost)\\(['"]${endpoint.replaceAll('/', '\\/')}`, 'u'));
  }
  assert.match(auth, /global\.EasyBoostAuth = Object\.freeze/u);
  assert.match(app, /auth\.currentSession\(\)/u);
  assert.match(app, /auth\.startTelegramLogin\(\)/u);
});

test('frontend fonts have system fallbacks and PWA images stay optimized', async () => {
  const html = await fs.readFile(frontendPath, 'utf8');
  assert.match(html, /font-family:Manrope,system-ui,sans-serif/u);
  assert.match(html, /font-family:Nunito,Manrope,sans-serif/u);
  for (const name of ['icon-192.png', 'icon-512.png', 'icon-maskable-512.png']) {
    const image = await fs.stat(new URL(`../public/${name}`, import.meta.url));
    assert.ok(image.size < 50_000, `${name} exceeds the 50 KB PWA image budget`);
  }
});

test('request logs use a pseudonymous internal user identifier', async () => {
  const server = await fs.readFile(serverPath, 'utf8');
  assert.match(server, /createHmac\('sha256', SECRET\)/u);
  assert.equal((server.match(/userId:\s*logUserId\(req\.user\)/gu) || []).length, 2);
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
  // A reload without network must reopen the cached application, not the placeholder page.
  assert.match(worker, /caches\.match\('\/'\)\.then\(shell=>shell\|\|caches\.match\('\/offline\.html'\)\)/u);
  assert.match(worker, /fetch\(request\).*catch\(\(\)=>caches\.match\(request\)\)/u);
  assert.match(worker, /self\.skipWaiting\(\)/u);
  assert.match(worker, /self\.clients\.claim\(\)/u);
  assert.doesNotMatch(offline, /<script|onclick=/iu);
});

test('progress is snapshotted locally so an offline start is not a blank slate', async () => {
  const [app, store] = await Promise.all([
    fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../public/store.js', import.meta.url), 'utf8'),
  ]);
  // Every save writes the snapshot, in server mode too — not only the sync queue.
  assert.match(app, /store\.saveLocal\(currentUser,S,ADOPTED_OWNER_GENERATION\);\s*\n\s*if\(SRV\)\{clearTimeout/u);
  // A failed /api/v1/progress must never reset the visible state to defaults.
  assert.doesNotMatch(app, /catch\(e\)\{S=fillDefaults\(\{\}\)\}/u);
  assert.match(app, /apiResponseOwner\(served\)!==startOwner/u);
  assert.doesNotMatch(app, /delete progressState\.owner/u);
  assert.match(app, /S=store\.restore\(currentUser,served,store\.sync\.pendingModules\(\),ADOPTED_OWNER_GENERATION\)/u);
  assert.match(store, /function restore\(username, serverState, pendingModules, ownerGeneration\)/u);
});

test('frontend keeps zoom, keyboard focus and assistive announcements accessible', async () => {
  const { html, script } = await readFrontend();
  assert.doesNotMatch(html, /user-scalable\s*=\s*no|maximum-scale\s*=\s*1/iu);
  assert.match(html, /viewport-fit=cover/u);
  assert.match(html, /:focus-visible/u);
  assert.match(html, /prefers-reduced-motion/u);
  assert.match(html, /id="w_editor"[^>]*role="textbox"[^>]*aria-label="Письменный ответ"/u);
  assert.match(script, /setAttribute\('aria-live',\s*'polite'\)/u);
});

test('new production users start with zero real progress', async () => {
  const { script } = await readFrontend();
  assert.doesNotMatch(script, /learned==null\?320|streak\|\|7|dayMin\|\|18/u);
  assert.match(script, /state\.learned = state\.learned == null \? 0 : state\.learned/u);
  assert.match(script, /state\.prog = state\.prog \|\| \{ words: 0, gram: 0, read: 0, listen: 0, write: 0, speak: 0 \}/u);
});

test('progress sync queues the latest state and retries when connectivity returns', async () => {
  const sync = await fs.readFile(new URL('../public/sync.js', import.meta.url), 'utf8');
  assert.match(sync, /easyboost_pending_modules_v3/u);
  assert.match(sync, /LEGACY_STORAGE_KEY='easyboost_pending_modules_v2'/u);
  assert.match(sync, /store\.owners\[ownerKey\]=\{modules:merged,queuedAt:Date\.now\(\),ownerGeneration:ownerAuthGeneration\}/u);
  assert.match(sync, /navigator\.onLine===false/u);
  assert.match(sync, /window\.addEventListener\('online',flush\)/u);
  assert.match(sync, /EasyBoostApi\.post\('\/api\/v1\/progress\/modules',\{owner:ownerKey,modules:modules\},true\)/u);
  assert.match(sync, /error\.status>=500/u);
  assert.match(sync, /pendingMatchesOwner\(pending,ownerKey\)&&pending\.modules/u);
  assert.match(sync, /easyboost_pending_module_attempts_v1/u);
  assert.match(sync, /candidate=\{\.\.\.clone\(attempt\),_ownerGeneration:expectedGeneration\}/u);
  assert.match(sync, /store\.owners\[ownerKey\]=attempts\.slice\(-MAX_PENDING_ATTEMPTS\)/u);
  assert.match(sync, /setOwner/u);
  assert.match(sync, /MAX_ATTEMPT_BYTES=20_000/u);
  const privacy = await fs.readFile(new URL('../public/privacy.js', import.meta.url), 'utf8');
  assert.match(privacy, /EasyBoostSync\?\.deleteOwner\(/u);
});

test('module progress endpoint merges validated keys instead of replacing the document', async () => {
  const [progress, postgres] = await Promise.all([
    fs.readFile(progressRoutePath, 'utf8'),
    fs.readFile(new URL('../storage/postgres-repository.js', import.meta.url), 'utf8'),
  ]);
  assert.match(progress, /router\.post\('\/api\/v1\/progress\/modules', auth/u);
  assert.match(progress, /validateProgress\(modules\)/u);
  assert.match(postgres, /\(COALESCE\(user_progress\.data, '\{\}'::jsonb\) - 'grammarRunner'\) \|\| EXCLUDED\.data/u);
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
  const [ai, media, subscriptionMiddleware] = await Promise.all([
    fs.readFile(aiRoutePath, 'utf8'),
    fs.readFile(mediaRoutePath, 'utf8'),
    fs.readFile(new URL('../middleware/subscription.js', import.meta.url), 'utf8'),
  ]);
  const routes = `${ai}
${media}`;
  for (const code of ['AI_NOT_CONFIGURED', 'TTS_UNAVAILABLE', 'STT_NOT_CONFIGURED', 'STT_PROVIDER_UNAVAILABLE', 'STT_UNAVAILABLE']) {
    assert.match(routes, new RegExp(`code: '${code}'`, 'u'));
  }
  assert.match(routes, /'AI_PROVIDER_UNAVAILABLE'/u);
  assert.match(subscriptionMiddleware, /code: 'AI_BUDGET_EXHAUSTED'/u);
  assert.doesNotMatch(routes, /res\.status\((?:502|503)\)\.json\(\{ error: '(?:ИИ|Озвучка|STT)[^']*' \+ /u);
});

test('validated generated content is cached before external AI budget checks', async () => {
  const ai = await fs.readFile(aiRoutePath, 'utf8');
  const cacheLookup = ai.indexOf('const stored = await getGeneratedTask(username, requestHash)');
  const budgetCheck = ai.indexOf('if (!await hasAiBudget())', cacheLookup);
  const providerCall = ai.indexOf('const response = await askProvider(provider', cacheLookup);
  assert.ok(cacheLookup > 0 && budgetCheck > cacheLookup && providerCall > budgetCheck);
  assert.match(ai, /saveGeneratedTask\(username/u);
  assert.match(ai, /promptVersion: CONTENT_PROMPT_VERSION, input/u);
});

test('audio endpoints enforce upload controls, timeouts and private cached responses', async () => {
  const [media, frontend] = await Promise.all([
    fs.readFile(mediaRoutePath, 'utf8'),
    /* Запись голоса живёт в чанке экрана говорения. */
    fs.readFile(new URL('../public/screens/speaking.js', import.meta.url), 'utf8'),
  ]);
  assert.match(media, /validateAudioUpload\(req\.headers\['content-type'\], buf, config\.ai\.sttMaxBytes\)/u);
  assert.match(media, /controller\.abort\(\), config\.ai\.sttTimeoutMs/u);
  assert.match(media, /pruneAudioCache\(TTS_DIR/u);
  assert.match(media, /Cache-Control', 'private, max-age=604800'/u);
  assert.doesNotMatch(media, /Cache-Control', 'public, max-age=604800'/u);
  assert.match(frontend, /function spDeleteRecording\(/u);
  assert.match(frontend, /function spFlagTranscript\(/u);
  assert.match(frontend, /полноту чтения, беглость распознавания/u);
  assert.match(frontend, /Интонация и отдельные фонемы в балл не входили/u);
});

test('production documentation covers local setup, API, database and operations', async () => {
  const paths = ['../README.md', '../docs/openapi.yaml', '../docs/DATABASE_SCHEMA.md', '../docs/AI_OPERATIONS.md', '../docs/KEY_ROTATION.md', '../docs/SUPPORT.md', '../docs/KNOWN_LIMITATIONS.md', '../docs/TELEGRAM_ADMIN.md', '../docs/AI_QUALITY.md'];
  const documents = await Promise.all(paths.map((path) => fs.readFile(new URL(path, import.meta.url), 'utf8')));
  assert.match(documents[0], /npm ci[\s\S]*npm run check[\s\S]*npm test/u);
  for (const route of ['/health/live', '/health/ready', '/api/v1/tg/start', '/api/v1/me', '/api/v1/account/export', '/api/v1/account', '/api/v1/privacy/consent', '/api/v1/progress/modules', '/api/v1/module-attempts', '/api/v1/word-progress', '/api/v1/error-bank', '/api/v1/ai/generate-content', '/api/v1/ai/evaluate-writing', '/api/v1/ai/evaluate-speaking', '/api/v1/ai/generate-speaking-sample', '/api/v1/tts', '/api/v1/stt']) {
    assert.match(documents[1], new RegExp(route.replaceAll('/', '\\/'), 'u'));
  }
  assert.match(documents[1], /\/api\/v1\/account:[\s\S]*?delete:[\s\S]*?required: \[confirmation, owner\][\s\S]*?OWNER_CHANGED/u);
  assert.match(documents[2], /user_progress/u);
  assert.match(documents[2], /журнал пользовательских прогонов/u);
  assert.match(documents[2], /provider, model, prompt_version/u);
  assert.match(documents[3], /WRITING_PROMPT_VERSION/u);
  assert.match(documents[4], /JWT_SECRET/u);
  assert.match(documents[5], /requestId/u);
  assert.match(documents[6], /Известные ограничения/u);
  assert.match(documents[7], /TELEGRAM_BOT_TOKEN/u);
  assert.match(documents[8], /quality:release/u);
  assert.match(documents[8], /не импортируется автоматически в золотой набор/u);
});

test('privacy UI separates text and voice consent and explains external processing', async () => {
  const [script, policy, retention] = await Promise.all([
    fs.readFile(new URL('../public/privacy.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../public/privacy.html', import.meta.url), 'utf8'),
    fs.readFile(new URL('../docs/DATA_RETENTION.md', import.meta.url), 'utf8'),
  ]);
  assert.match(script, /id="privacyText" type="checkbox"/u);
  assert.match(script, /id="privacyVoice" type="checkbox"/u);
  assert.match(script, /xAI[\s\S]*Groq/u);
  assert.match(script, /\/api\/v1\/privacy\/consent/u);
  assert.match(policy, /экспериментальном режиме/u);
  assert.match(policy, /не является экспертным заключением/u);
  assert.match(policy, /не является официальн/u);
  assert.match(policy, /Сроки хранения/u);
  assert.match(policy, /не считаются анонимными/u);
  assert.match(policy, /не попадают автоматически в золотой набор/u);
  assert.match(retention, /псевдонимизац/u);
  assert.match(retention, /очистк[аи] свободного текста/u);
  assert.match(retention, /отдельн.*человеческ.*размет/u);
});

test('frontend has no learning demo entry point or demo-only persistence and AI branches', async () => {
  const { combined } = await readFrontend();
  assert.doesNotMatch(combined, /\bDEMO_MODE\b/u);
  assert.doesNotMatch(combined, /\bstartDemo\b/u);
  assert.doesNotMatch(combined, /\bdemo_btn\b/u);
  assert.doesNotMatch(combined, /\bdemo_banner\b/u);
  assert.doesNotMatch(combined, /Попробовать демо|Демо · войти|демо-режим/iu);
});

test('public startApp cannot accept a caller-supplied access decision', async () => {
  const app = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /async function startApp\(\)\{\s*return runAuthTransition\(async function\(\)\{\s*const access=await checkLearningAccess\(\)/u);
  assert.doesNotMatch(app, /function startApp\([^)]*(?:session|access|profile)/iu);
});
