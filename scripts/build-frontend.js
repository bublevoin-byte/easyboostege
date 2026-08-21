/*
 * Сборка frontend.
 *
 * `public/` остаётся каталогом исходников: сервер умеет отдавать его напрямую, `npm start` на
 * чистом клоне работает без сборки, и все тесты читают именно эти файлы. Здесь из тех же исходников
 * собирается `dist/public` — бандл с минификацией и хешированными именами, — который сервер
 * предпочитает, если каталог существует.
 *
 * Скрипт делает три вещи, которые Vite сам не делает:
 *
 * 1. копирует статику, на которую никто не ссылается импортом (страницы offline и privacy, банк
 *    заданий, иконки): publicDir у Vite отключён, потому что она лежит в самом root;
 * 2. подставляет в service worker список оболочки по манифесту сборки — с хешированными именами
 *    вести его руками нельзя;
 * 3. проверяет целостность: отсутствующий или неверный импорт обязан валить сборку, а не
 *    оставлять ученику молча неработающий экран.
 */
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const projectDirectory = fileURLToPath(new URL('..', import.meta.url));
const sourceDirectory = path.join(projectDirectory, 'public');
const sharedSourceDirectory = path.join(projectDirectory, 'shared');
const outputDirectory = path.join(projectDirectory, 'dist', 'public');
const stagingDirectory = path.join(projectDirectory, 'dist', 'public.building');
const configFile = path.join(projectDirectory, 'vite.config.js');

const SHELL_MARKER_START = '/* build:app-shell */';
const SHELL_MARKER_END = '/* end build:app-shell */';
const EGE_MOCK_FORM_MARKER_START = '/* build:ege-mock-form */';
const EGE_MOCK_FORM_MARKER_END = '/* end build:ege-mock-form */';
const EGE_MOCK_EXEC_MARKER_START = '/* build:ege-mock-exec */';
const EGE_MOCK_EXEC_MARKER_END = '/* end build:ege-mock-exec */';

/* ---------- исходники ---------- */

async function listFiles(directory, prefix = '') {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relativePath = path.posix.join(prefix, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(path.join(directory, entry.name), relativePath));
    else if (entry.isFile()) files.push(relativePath);
  }
  return files;
}

const publicSourceFiles = (await listFiles(sourceDirectory)).sort();
const sharedSourceFiles = (await listFiles(sharedSourceDirectory))
  .map((name) => `../shared/${name}`);
const sourceFiles = [...publicSourceFiles, ...sharedSourceFiles].sort();

function sourceFilePath(name) {
  return path.resolve(sourceDirectory, name);
}

function sourceUrl(name) {
  return name.startsWith('../shared/') ? name.slice(2) : `/${name}`;
}

/*
 * Импорт — всегда инструкция верхнего уровня, поэтому статические ищем от начала строки: иначе
 * `from '…'` внутри учебного текста будет принят за зависимость. Экран приезжает динамическим
 * import(): опечатка в его пути не сломает старт приложения, но ученик увидит пустой переход вместо
 * экрана, поэтому такие пути проверяются наравне со статическими.
 */
function importsOf(source, name) {
  const statics = [];
  const dynamics = [];
  const resolve = (specifier) => {
    if (!specifier.startsWith('.')) throw new Error(`Frontend module ${name} imports outside the bundle: ${specifier}`);
    return path.posix.normalize(path.posix.join(path.posix.dirname(name), specifier));
  };
  for (const statement of source.matchAll(/^import\s+[^;']*from\s*'([^']+)'|^import\s*'([^']+)'/gmu)) {
    statics.push(resolve(statement[1] || statement[2]));
  }
  for (const statement of source.matchAll(/import\(\s*'([^']+)'\s*\)/gu)) dynamics.push(resolve(statement[1]));
  return { statics, dynamics };
}

/*
 * Обход графа от точки входа. `staticOnly` отделяет оболочку от чанков: то, до чего можно дойти
 * только динамическим import(), при первой загрузке не приезжает и в APP_SHELL не входит.
 */
async function walkModuleGraph(entry, { staticOnly = false } = {}) {
  const seen = new Set();
  const queue = [entry];
  while (queue.length) {
    const name = queue.shift();
    if (seen.has(name)) continue;
    seen.add(name);
    if (!sourceFiles.includes(name)) throw new Error(`Missing frontend module: ${name}`);
    const source = await fs.readFile(sourceFilePath(name), 'utf8');
    const { statics, dynamics } = importsOf(source, name);
    queue.push(...statics);
    if (!staticOnly) queue.push(...dynamics);
  }
  return seen;
}

const html = await fs.readFile(path.join(sourceDirectory, 'index.html'), 'utf8');
const entryPoints = [...html.matchAll(/<script[^>]+src="\/([^"]+)"/gu)].map((match) => match[1]);
if (!entryPoints.length) throw new Error('index.html подключает ноль скриптов — приложение не запустится');
for (const entry of entryPoints) {
  if (!sourceFiles.includes(entry)) throw new Error(`Missing frontend script: ${entry}`);
}

const reachable = new Set();
const shellModules = new Set();
for (const entry of entryPoints) {
  for (const name of await walkModuleGraph(entry)) reachable.add(name);
  for (const name of await walkModuleGraph(entry, { staticOnly: true })) shellModules.add(name);
}
const offlineEntryModules = [
  'screens/practice.js', 'screens/ege-hub.js', 'screens/progress.js', 'screens/profile.js',
  'asya-assistant.js', 'privacy.js', 'adaptive-session-runtime.js',
];
const offlineLazyModules = [...new Set((await Promise.all(offlineEntryModules.map(
  (entry) => walkModuleGraph(entry, { staticOnly: true }),
))).flatMap((closure) => [...closure]))].filter((name) => !shellModules.has(name));
const egeMockSourceEntry = 'screens/ege-mock.js';
const egeMockStaticClosure = await walkModuleGraph(egeMockSourceEntry, { staticOnly: true });
const sourceEgeMockExecModules = [
  egeMockSourceEntry,
  ...[...egeMockStaticClosure]
    .filter((name) => name !== egeMockSourceEntry && !shellModules.has(name))
    .sort(),
];
const sourceEgeMockExecPaths = sourceEgeMockExecModules.map(sourceUrl);

/*
 * Файл, до которого не дотягивается ни один импорт, не попадёт ни в бандл, ни в кэш оболочки —
 * а выглядеть будет как рабочий код. Единственное исключение — сам service worker: его загружает
 * браузер, а не точка входа.
 */
function previewOnlyAsset(name) {
  return name.startsWith('prototypes/');
}

const orphaned = sourceFiles.filter((name) => name.endsWith('.js') && name !== 'service-worker.js' && !previewOnlyAsset(name) && !reachable.has(name));
if (orphaned.length) throw new Error(`Эти модули не подключены ни статически, ни динамически: ${orphaned.join(', ')}`);

/* Статика, которую никто не импортирует: разметку собирает Vite, остальное копируется как есть. */
function copiedStaticAsset(name) {
  return previewOnlyAsset(name) || (!name.endsWith('.js') && name !== 'index.html');
}
const staticAssets = publicSourceFiles.filter(copiedStaticAsset);

/*
 * Большие listening MP3 — runtime-данные, а не оболочка приложения. Их всё равно нужно положить в
 * dist и включить в итоговый asset-manifest, но service worker получает их по требованию и хранит
 * в отдельном Range-aware runtime cache. Предзагрузка всего каталога сделала бы первый install
 * тяжелее примерно на 55 MB и сломала бы честную прогрессивную offline-модель. Сам небольшой
 * listening manifest остаётся частью APP_SHELL.
 */
function runtimeManagedAsset(name) {
  return (name.startsWith('audio/listening/') && name.endsWith('.mp3'))
    || (name.startsWith('assets/speaking/task4-v1/') && name.endsWith('.png'));
}

/* Локальные visual prototypes собираются для preview, но не являются исполняемой offline-оболочкой. */
const shellStaticAssets = staticAssets.filter((name) => !runtimeManagedAsset(name) && !previewOnlyAsset(name));

/* ---------- сборка ---------- */

/*
 * Собирается во временный каталог, а на место встаёт последним шагом. Сервер отдаёт `dist/public`
 * по факту существования разметки в нём: недособранный каталог он бы отдал наравне с полным —
 * без service worker и с недосчитанной целостностью.
 */
await fs.rm(stagingDirectory, { recursive: true, force: true });
const result = await build({ configFile, logLevel: 'warn', build: { outDir: stagingDirectory } });
const output = (Array.isArray(result) ? result[0] : result).output;

/*
 * Карта «исходный модуль → файл, в который он попал». Имена в сборке хешированные, и это
 * единственный способ узнать, где оказался экран: по имени файла больше не видно.
 */
const chunks = output.filter((item) => item.type === 'chunk');
const chunkByFile = new Map(chunks.map((chunk) => [chunk.fileName, chunk]));
const modules = {};
for (const chunk of chunks) {
  for (const id of Object.keys(chunk.modules)) {
    const normalized = path.resolve(id);
    if (normalized.startsWith(sourceDirectory + path.sep)) {
      modules[path.relative(sourceDirectory, normalized).split(path.sep).join('/')] = chunk.fileName;
    } else if (normalized.startsWith(sharedSourceDirectory + path.sep)) {
      const relative = path.relative(sharedSourceDirectory, normalized).split(path.sep).join('/');
      modules[`../shared/${relative}`] = chunk.fileName;
    }
  }
}

for (const name of reachable) {
  if (!modules[name]) throw new Error(`Модуль ${name} не попал в сборку — проверьте импорты`);
}
const builtEgeMockFormModule = modules['ege-mock-form-1-v1.js'];
if (!builtEgeMockFormModule) throw new Error('Exact EGE mock form module не попал в сборку');
const builtEgeMockFormPath = `/${builtEgeMockFormModule}`;
const builtEgeMockScreenModule = modules['screens/ege-mock.js'];
if (!builtEgeMockScreenModule) throw new Error('Lazy EGE mock executable не попал в сборку');
const builtEgeMockExecPaths = [...new Set(sourceEgeMockExecModules.map((name) => `/${modules[name]}`))];

const entryChunk = chunks.find((chunk) => chunk.isEntry);
if (!entryChunk) throw new Error('Сборка не дала точки входа');

/* Оболочка — точка входа и то, что она тянет статически. Чанки экранов сюда не входят. */
const shellChunks = new Set();
const pending = [entryChunk.fileName];
while (pending.length) {
  const fileName = pending.shift();
  if (shellChunks.has(fileName)) continue;
  shellChunks.add(fileName);
  pending.push(...(chunkByFile.get(fileName)?.imports || []));
}
const dynamicChunks = chunks.map((chunk) => chunk.fileName).filter((fileName) => !shellChunks.has(fileName));

for (const name of shellModules) {
  if (!shellChunks.has(modules[name])) {
    throw new Error(`${name} импортируется статически, но оказался в чанке ${modules[name]} — оболочка разъехалась с первой загрузкой`);
  }
}

/* ---------- статика и service worker ---------- */

const emitted = new Set(output.map((item) => item.fileName));
for (const name of staticAssets) {
  if (emitted.has(name)) continue;
  const destination = path.join(stagingDirectory, name);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.copyFile(path.join(sourceDirectory, name), destination);
}

function shellFrom(files) {
  return ['/', ...files.map(sourceUrl).sort()];
}

const workerSource = await fs.readFile(path.join(sourceDirectory, 'service-worker.js'), 'utf8');
const shellStart = workerSource.indexOf(SHELL_MARKER_START);
const shellEnd = workerSource.indexOf(SHELL_MARKER_END);
if (shellStart === -1 || shellEnd === -1) {
  throw new Error('public/service-worker.js потерял маркеры build:app-shell — сборке некуда подставить список оболочки');
}

/*
 * Список в исходнике ведётся руками только потому, что сервер отдаёт `public/`, когда сборки нет.
 * Чтобы он не разъехался с реальным графом импортов, сборка его сверяет: набор тот же, что в
 * dist, только без хешей.
 */
const sourceShell = shellFrom([...shellModules, ...offlineLazyModules, ...shellStaticAssets]);
const declaredShell = JSON.parse(workerSource.slice(shellStart, shellEnd).match(/const APP_SHELL=(\[[^\]]*\]);/u)[1].replaceAll("'", '"'));
const declaredSorted = [...declaredShell].sort();
const expectedSorted = [...sourceShell].sort();
if (declaredSorted.join('\n') !== expectedSorted.join('\n')) {
  const missing = expectedSorted.filter((name) => !declaredSorted.includes(name));
  const extra = declaredSorted.filter((name) => !expectedSorted.includes(name));
  throw new Error(`APP_SHELL в public/service-worker.js разошёлся с графом импортов main.js.${missing.length ? `\n  не хватает: ${missing.join(', ')}` : ''}${extra.length ? `\n  лишнее: ${extra.join(', ')}` : ''}`);
}

const offlineLazyChunks = new Set(offlineLazyModules.map((name) => modules[name]));
const builtShell = shellFrom([...shellChunks, ...offlineLazyChunks, ...shellStaticAssets]);
let workerBuilt = `${workerSource.slice(0, shellStart)}${SHELL_MARKER_START}\nconst APP_SHELL=${JSON.stringify(builtShell).replaceAll('"', "'")};\n${workerSource.slice(shellEnd)}`;
const egeMockFormStart = workerBuilt.indexOf(EGE_MOCK_FORM_MARKER_START);
const egeMockFormEnd = workerBuilt.indexOf(EGE_MOCK_FORM_MARKER_END);
if (egeMockFormStart === -1 || egeMockFormEnd === -1) {
  throw new Error('public/service-worker.js потерял exact EGE form markers');
}
const sourceEgeMockFormBlock = workerBuilt.slice(egeMockFormStart, egeMockFormEnd);
if (!sourceEgeMockFormBlock.includes("const EGE_MOCK_FORM_PATH='/ege-mock-form-1-v1.js';")) {
  throw new Error('Source service worker потерял exact EGE form path');
}
workerBuilt = `${workerBuilt.slice(0, egeMockFormStart)}${EGE_MOCK_FORM_MARKER_START}\nconst EGE_MOCK_FORM_PATH='${builtEgeMockFormPath}';\n${workerBuilt.slice(egeMockFormEnd)}`;
const egeMockExecStart = workerBuilt.indexOf(EGE_MOCK_EXEC_MARKER_START);
const egeMockExecEnd = workerBuilt.indexOf(EGE_MOCK_EXEC_MARKER_END);
if (egeMockExecStart === -1 || egeMockExecEnd === -1) {
  throw new Error('public/service-worker.js потерял markers build:ege-mock-exec');
}
const sourceEgeMockExecBlock = workerBuilt.slice(egeMockExecStart, egeMockExecEnd);
const sourceEgeMockExecDeclaration = `const EGE_MOCK_EXEC_PATHS=${JSON.stringify(sourceEgeMockExecPaths).replaceAll('"', "'")};`;
if (!sourceEgeMockExecBlock.includes(sourceEgeMockExecDeclaration)) {
  throw new Error(`Source service worker потерял EGE executable paths: ${sourceEgeMockExecDeclaration}`);
}
workerBuilt = `${workerBuilt.slice(0, egeMockExecStart)}${EGE_MOCK_EXEC_MARKER_START}\nconst EGE_MOCK_EXEC_PATHS=${JSON.stringify(builtEgeMockExecPaths).replaceAll('"', "'")};\n${workerBuilt.slice(egeMockExecEnd)}`;
await fs.writeFile(path.join(stagingDirectory, 'service-worker.js'), workerBuilt, 'utf8');

/* ---------- целостность ---------- */

const builtHtml = await fs.readFile(path.join(stagingDirectory, 'index.html'), 'utf8');
const builtFiles = (await listFiles(stagingDirectory)).sort();
const assets = {};
for (const name of builtFiles) {
  const content = await fs.readFile(path.join(stagingDirectory, name));
  assets[name] = { bytes: content.length, sha256: crypto.createHash('sha256').update(content).digest('hex') };
}

const builtScripts = [...builtHtml.matchAll(/<script[^>]+src="\/([^"]+)"/gu)].map((match) => match[1]);
if (!builtScripts.length) throw new Error('Собранный index.html подключает ноль скриптов');
for (const name of builtScripts) {
  if (!assets[name]) throw new Error(`Собранный index.html подключает отсутствующий файл: ${name}`);
}
if (!assets[builtEgeMockFormPath.slice(1)]) {
  throw new Error(`Exact EGE mock form module отсутствует в dist: ${builtEgeMockFormPath}`);
}
if (!builtScripts.includes(entryChunk.fileName)) {
  throw new Error(`Собранный index.html не подключает точку входа ${entryChunk.fileName}`);
}
/* Собранная разметка не должна приносить инлайновых скриптов: CSP держит script-src как 'self'. */
if (/<script(?![^>]*\bsrc\s*=)(?:\s[^>]*)?>/iu.test(builtHtml)) {
  throw new Error('Сборка добавила инлайновый <script> — CSP считается по этой же разметке и разъедется с ней');
}
for (const name of builtShell.slice(1)) {
  if (!assets[name.slice(1)]) throw new Error(`APP_SHELL ссылается на отсутствующий файл: ${name}`);
}

await fs.writeFile(
  path.join(stagingDirectory, 'asset-manifest.json'),
  `${JSON.stringify({
    generatedBy: 'npm run build:frontend',
    entry: entryChunk.fileName,
    shell: builtShell,
    dynamicChunks: dynamicChunks.sort(),
    modules,
    assets,
  }, null, 2)}\n`,
  'utf8',
);

/* Проверенная сборка встаёт на место прежней одним шагом — до этого момента сервер отдаёт старую. */
await fs.rm(outputDirectory, { recursive: true, force: true });
await fs.rename(stagingDirectory, outputDirectory);

const shellBytes = [...shellChunks].reduce((total, name) => total + assets[name].bytes, 0);
console.log(`Frontend build created ${builtFiles.length} verified assets in dist/public: оболочка — ${shellChunks.size} файлов и ${(shellBytes / 1024).toFixed(1)} КБ JavaScript, ленивых чанков ${dynamicChunks.length}.`);
