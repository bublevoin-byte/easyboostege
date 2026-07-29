/*
 * Инлайновые обработчики — единственное место, где frontend разрешает имена через window.
 *
 * Пока `public/*.js` подключались классическими `<script>`, объявление функции на верхнем уровне
 * само создавало глобальное имя, и обработчик вида onclick="wSubmit()" находил его без чьей-либо
 * помощи. В ES-модуле это не так: объявление остаётся в области видимости модуля, а обработчик
 * молча падает с ReferenceError в момент клика — то есть регрессия проявляется не при сборке и не
 * в unit-тестах, а у ученика.
 *
 * Поэтому список имён нельзя держать в голове или в комментарии. Скрипт разбирает все обработчики
 * (и написанные в разметке, и собираемые из строк в рантайме), достаёт из них имена, которые будут
 * искаться в глобальной области, и сверяет с тем, что frontend действительно кладёт на window.
 * Любое расхождение — ошибка сборки.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectDirectory = fileURLToPath(new URL('..', import.meta.url));
const publicDirectory = path.join(projectDirectory, 'public');

/*
 * Часть обработчиков не написана как атрибут, а собрана хелпером: он принимает готовый текст
 * обработчика строкой и сам подставляет его в onclick. Такой аргумент разбирается как обработчик.
 */
const HANDLER_BUILDERS = new Map([
  ['spBtn', [1]],
  ['lCtl', [0]],
  ['card', [0]],
  ['rExamBtnRow', [2]],
  ['lExamNextBtn', [2]],
]);

/* Имена, которые браузер предоставляет сам: их незачем класть на window. */
const BROWSER_GLOBALS = new Set([
  'window', 'document', 'navigator', 'location', 'history', 'screen', 'console', 'event', 'self',
  'globalThis', 'localStorage', 'sessionStorage', 'alert', 'confirm', 'prompt', 'fetch',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame',
  'cancelAnimationFrame', 'encodeURIComponent', 'decodeURIComponent', 'encodeURI', 'decodeURI',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'Math', 'JSON', 'Date', 'Object', 'Array',
  'String', 'Number', 'Boolean', 'Promise', 'Error', 'RegExp', 'Map', 'Set', 'WeakMap', 'WeakSet',
  'Symbol', 'Audio', 'Image', 'Blob', 'File', 'FormData', 'URL', 'URLSearchParams', 'CustomEvent',
  'Event', 'MediaRecorder', 'AudioContext', 'SpeechSynthesisUtterance', 'speechSynthesis',
  'Intl', 'structuredClone', 'queueMicrotask', 'crypto', 'performance', 'atob', 'btoa',
]);

const RESERVED_WORDS = new Set([
  'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete',
  'do', 'else', 'export', 'extends', 'false', 'finally', 'for', 'function', 'if', 'import', 'in',
  'instanceof', 'let', 'new', 'null', 'return', 'super', 'switch', 'this', 'throw', 'true', 'try',
  'typeof', 'undefined', 'var', 'void', 'while', 'with', 'yield', 'of', 'async', 'static', 'get',
  'set',
]);

/* ---------- разбор JavaScript на строковые литералы ---------- */

/*
 * Полноценный парсер здесь не нужен, но пропустить комментарии и регулярные выражения
 * обязательно: иначе `/^to /` в app.js съедает половину файла как строку.
 */
function scanStringLiterals(source) {
  const literals = [];
  let index = 0;
  let previousMeaningful = '';

  const regexAllowedAfter = new Set(['', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '^', '~', '<', '>', 'return', 'typeof', 'case', 'in', 'of', 'do', 'else']);

  while (index < source.length) {
    const character = source[index];

    if (character === '/' && source[index + 1] === '/') {
      const end = source.indexOf('\n', index);
      index = end === -1 ? source.length : end;
      continue;
    }
    if (character === '/' && source[index + 1] === '*') {
      const end = source.indexOf('*/', index + 2);
      index = end === -1 ? source.length : end + 2;
      continue;
    }
    if (character === '/' && regexAllowedAfter.has(previousMeaningful)) {
      let cursor = index + 1;
      let inClass = false;
      let closed = false;
      while (cursor < source.length) {
        const inner = source[cursor];
        if (inner === '\\') { cursor += 2; continue; }
        if (inner === '\n') break;
        if (inner === '[') inClass = true;
        else if (inner === ']') inClass = false;
        else if (inner === '/' && !inClass) { closed = true; cursor += 1; break; }
        cursor += 1;
      }
      if (closed) {
        while (cursor < source.length && /[a-z]/u.test(source[cursor])) cursor += 1;
        index = cursor;
        previousMeaningful = 'regexp';
        continue;
      }
    }

    if (character === '"' || character === "'" || character === '`') {
      const start = index;
      let cursor = index + 1;
      let value = '';
      while (cursor < source.length) {
        const inner = source[cursor];
        if (inner === '\\') {
          value += unescapeCharacter(source[cursor + 1]);
          cursor += 2;
          continue;
        }
        if (inner === character) { cursor += 1; break; }
        if (inner === '\n' && character !== '`') break;
        value += inner;
        cursor += 1;
      }
      literals.push({ start, end: cursor, value });
      index = cursor;
      previousMeaningful = 'string';
      continue;
    }

    if (!/\s/u.test(character)) previousMeaningful = character;
    index += 1;
  }

  return literals;
}

function unescapeCharacter(character) {
  if (character === 'n') return '\n';
  if (character === 't') return '\t';
  if (character === 'r') return '\r';
  return character === undefined ? '' : character;
}

/* ---------- извлечение обработчиков ---------- */

const ATTRIBUTE_START = /(?:^|[\s;])on([a-z]+)\s*=\s*(["'])/giu;

function handlersFromHtml(html, file) {
  const handlers = [];
  for (const match of html.matchAll(ATTRIBUTE_START)) {
    const quote = match[2];
    const valueStart = match.index + match[0].length;
    const valueEnd = html.indexOf(quote, valueStart);
    if (valueEnd === -1) continue;
    handlers.push({ file, attribute: `on${match[1]}`, code: decodeHtml(html.slice(valueStart, valueEnd)) });
  }
  return handlers;
}

function decodeHtml(text) {
  return text
    .replace(/&quot;/gu, '"')
    .replace(/&#39;/gu, "'")
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&amp;/gu, '&');
}

/*
 * Обработчик, собираемый в рантайме, разрезан конкатенацией: '…onclick="gPick(this,'+i+')"…'.
 * Куски приходят строковыми литералами в порядке исходника, а подставляемые выражения — это как раз
 * то, что между ними, и в имени обработчика их быть не может. Поэтому склеиваем значения литералов,
 * держа состояние «атрибут ещё не закрыт».
 */
function handlersFromScript(source, file) {
  const handlers = [];
  const literals = scanStringLiterals(source);
  let open = null;

  for (const literal of literals) {
    let rest = literal.value;

    while (rest.length) {
      if (open) {
        const closing = rest.indexOf('"');
        if (closing === -1) { open.code += rest; break; }
        open.code += rest.slice(0, closing);
        handlers.push(open);
        open = null;
        rest = rest.slice(closing + 1);
        continue;
      }

      const match = /(?:^|[\s;])on([a-z]+)\s*=\s*"/u.exec(rest);
      if (!match) break;
      open = { file, attribute: `on${match[1]}`, code: '' };
      rest = rest.slice(match.index + match[0].length);
    }
  }

  if (open) handlers.push(open);
  handlers.push(...builderHandlers(source, literals, file));
  return handlers;
}

/* Аргумент-обработчик, переданный хелперу: разбираем сам вызов, чтобы не угадывать по соседству. */
function builderHandlers(source, literals, file) {
  const handlers = [];
  const byStart = new Map(literals.map((literal) => [literal.start, literal]));

  for (const [name, positions] of HANDLER_BUILDERS) {
    const callPattern = new RegExp(`(?<![\\w$.])${name}\\s*\\(`, 'gu');
    for (const call of source.matchAll(callPattern)) {
      const argumentLiterals = topLevelArguments(source, call.index + call[0].length, byStart);
      for (const position of positions) {
        const literal = argumentLiterals[position];
        if (literal && /[A-Za-z_$][\w$]*\s*\(/u.test(literal.value)) {
          handlers.push({ file, attribute: 'onclick', code: literal.value });
        }
      }
    }
  }

  return handlers;
}

/* Возвращает строковый литерал каждого аргумента верхнего уровня, если аргумент — литерал целиком. */
function topLevelArguments(source, start, byStart) {
  const args = [];
  let depth = 0;
  let index = start;
  let current = null;
  let currentIsLiteralOnly = true;

  while (index < source.length) {
    const literal = byStart.get(index);
    if (literal) {
      if (depth === 0) {
        if (current === null && literal.start === index) current = literal;
        else currentIsLiteralOnly = false;
      }
      index = literal.end;
      continue;
    }

    const character = source[index];
    if (character === '(' || character === '[' || character === '{') depth += 1;
    else if (character === ')' || character === ']' || character === '}') {
      if (character === ')' && depth === 0) { args.push(currentIsLiteralOnly ? current : null); break; }
      depth -= 1;
    } else if (character === ',' && depth === 0) {
      args.push(currentIsLiteralOnly ? current : null);
      current = null;
      currentIsLiteralOnly = true;
    } else if (depth === 0 && !/\s/u.test(character) && current !== null) {
      currentIsLiteralOnly = false;
    }
    index += 1;
  }

  return args;
}

/* ---------- имена, которые обработчик будет искать в глобальной области ---------- */

function globalIdentifiers(code) {
  const stripped = code.replace(/'[^']*'/gu, "''").replace(/"[^"]*"/gu, '""');
  const names = new Set();

  for (const match of stripped.matchAll(/[A-Za-z_$][\w$]*/gu)) {
    const name = match[0];
    if (RESERVED_WORDS.has(name) || BROWSER_GLOBALS.has(name)) continue;

    const before = stripped.slice(0, match.index).replace(/\s+$/u, '');
    if (before.endsWith('.') || before.endsWith('?.')) continue;

    const after = stripped.slice(match.index + name.length).replace(/^\s+/u, '');
    const isObjectKey = after.startsWith(':') && !after.startsWith('::')
      && (before.endsWith('{') || before.endsWith(','));
    if (isObjectKey) continue;

    names.add(name);
  }

  return names;
}

/* ---------- имена, которые frontend кладёт на window ---------- */

function assignedGlobals(source) {
  const names = new Set();
  for (const match of source.matchAll(/(?:window|globalThis|global|root)\.([A-Za-z_$][\w$]*)\s*=(?!=)/gu)) {
    names.add(match[1]);
  }
  return names;
}

function exportedNames(source) {
  const names = new Set();
  for (const match of source.matchAll(/export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gu)) names.add(match[1]);
  for (const match of source.matchAll(/export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gu)) names.add(match[1]);
  for (const match of source.matchAll(/export\s*\{([^}]*)\}/gu)) {
    for (const entry of match[1].split(',')) {
      const alias = entry.trim().split(/\s+as\s+/u).pop();
      if (alias) names.add(alias.trim());
    }
  }
  return names;
}

/*
 * main.js — единственное место, где имена появляются на window. Читаем именно его,
 * чтобы список разрешимых имён не расходился с тем, что реально выполняется в браузере.
 */
async function exposedByEntryPoint() {
  const entryPath = path.join(publicDirectory, 'main.js');
  const entry = await fs.readFile(entryPath, 'utf8');
  const namespaces = new Map();
  for (const match of entry.matchAll(/import\s*\*\s*as\s+([A-Za-z_$][\w$]*)\s+from\s*'([^']+)'/gu)) {
    namespaces.set(match[1], match[2]);
  }

  const names = new Set();
  for (const match of entry.matchAll(/(?<!function\s+)exposeGlobals\(\s*([A-Za-z_$][\w$]*)\s*\)/gu)) {
    const specifier = namespaces.get(match[1]);
    if (!specifier) throw new Error(`main.js: exposeGlobals(${match[1]}) без соответствующего импорта`);
    const source = await fs.readFile(path.join(publicDirectory, specifier.replace(/^\.\//u, '')), 'utf8');
    for (const name of exportedNames(source)) names.add(name);
  }
  return names;
}

/* ---------- сборка ---------- */

async function frontendScripts() {
  const files = ['main.js'];
  for (const entry of (await fs.readdir(publicDirectory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isFile() && entry.name.endsWith('.js') && entry.name !== 'main.js') files.push(entry.name);
  }
  for (const entry of (await fs.readdir(path.join(publicDirectory, 'modules'), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isFile() && entry.name.endsWith('.js')) files.push(path.posix.join('modules', entry.name));
  }
  return files;
}

export async function analyzeInlineHandlers() {
  const html = await fs.readFile(path.join(publicDirectory, 'index.html'), 'utf8');
  const handlers = handlersFromHtml(html, 'public/index.html');
  const markupHandlerCount = handlers.length;

  const bound = new Set(await exposedByEntryPoint());
  for (const file of await frontendScripts()) {
    const source = await fs.readFile(path.join(publicDirectory, file), 'utf8');
    handlers.push(...handlersFromScript(source, `public/${file}`));
    for (const name of assignedGlobals(source)) bound.add(name);
  }

  const references = new Map();
  for (const handler of handlers) {
    for (const name of globalIdentifiers(handler.code)) {
      if (!references.has(name)) references.set(name, []);
      references.get(name).push(handler);
    }
  }

  const missing = [...references.keys()].filter((name) => !bound.has(name)).sort();

  return {
    handlers,
    markupHandlerCount,
    generatedHandlerCount: handlers.length - markupHandlerCount,
    names: [...references.keys()].sort(),
    references,
    bound,
    missing,
  };
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const report = await analyzeInlineHandlers();
  const summary = `${report.handlers.length} инлайновых обработчиков (${report.markupHandlerCount} в разметке, ${report.generatedHandlerCount} собираются в рантайме), ${report.names.length} имён`;

  if (report.missing.length) {
    console.error(`${summary}.`);
    console.error('Эти имена обработчик будет искать на window, а frontend их туда не кладёт:');
    for (const name of report.missing) {
      const example = report.references.get(name)[0];
      console.error(`  ${name} — ${example.file}, ${example.attribute}="${example.code.trim().slice(0, 80)}"`);
    }
    process.exitCode = 1;
  } else {
    console.log(`${summary} — все разрешаются.`);
  }
}
