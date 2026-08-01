import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const script = fileURLToPath(new URL('../scripts/tz-readiness.js', import.meta.url));
const temporary = [];

after(() => temporary.forEach((directory) => fs.rmSync(directory, { recursive: true, force: true })));

function specificationFile() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'easyboost-readiness-'));
  temporary.push(directory);
  const file = path.join(directory, 'ТЗ с пробелами.md');
  const countedSections = ['4', '5', '6', '7', '8', '9', '10', '12', '13', '14', '15', '16', '17', '18', '19', '20', '21'];
  const ordinarySections = countedSections.map((section) => `## ${section}. Раздел ${section}\n- Обычное требование ✅`);
  const contents = [
    ...ordinarySections.slice(0, 7),
    '## 11. Методическая проверка <!-- release-profile:experimental=exclude -->',
    '- Методическое требование A',
    '- Методическое требование B',
    ...ordinarySections.slice(7),
    '## 24. Критерии готовности',
    '1. Общий выполненный критерий ✅',
    '2. Сводная методическая метрика <!-- release-profile:experimental=exclude -->',
    '3. Подтверждено только для эксперимента <!-- release-profile:experimental=done -->',
  ].join('\n');
  fs.writeFileSync(file, contents, 'utf8');
  return file;
}

function readiness(args) {
  return spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8' });
}

test('strict remains the default profile and counts every requirement', () => {
  const file = specificationFile();
  const result = readiness([file]);
  const explicit = readiness([file, '--profile', 'strict']);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(explicit.status, 0, explicit.stderr || explicit.stdout);
  assert.equal(result.stdout, explicit.stdout);
  assert.match(result.stdout, /Профиль:\s+strict/u);
  assert.match(result.stdout, /Выполнено:\s+18/u);
  assert.match(result.stdout, /Открыто:\s+4/u);
  assert.match(result.stdout, /Всего:\s+22/u);
  assert.match(result.stdout, /Готовность:\s+81\.8% \(18 из 22\)/u);
  assert.match(result.stdout, /Исключено:\s+0/u);
});

test('experimental excludes tagged sections and items without calling them done', () => {
  const file = specificationFile();
  const result = readiness([file, '--profile', 'experimental']);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Профиль:\s+experimental/u);
  assert.match(result.stdout, /Выполнено:\s+19/u);
  assert.match(result.stdout, /Открыто:\s+0/u);
  assert.match(result.stdout, /Всего:\s+19/u);
  assert.match(result.stdout, /Готовность:\s+100\.0% \(19 из 19\)/u);
  assert.match(result.stdout, /Исключено:\s+3/u);
});

test('experimental open list omits excluded requirements and reports their count', () => {
  const file = specificationFile();
  const result = readiness([file, '--profile=experimental', '--open']);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Открытые пункты:\s*$/u);
  assert.doesNotMatch(result.stdout, /Методическое требование A/u);
  assert.doesNotMatch(result.stdout, /Сводная методическая метрика/u);
  assert.match(result.stdout, /Исключено:\s+3/u);
});

test('unknown profiles and options fail with a clear non-zero error', () => {
  const file = specificationFile();
  const profile = readiness([file, '--profile', 'preview']);
  const option = readiness([file, '--surprise']);

  assert.equal(profile.status, 2);
  assert.match(profile.stdout, /Неизвестный профиль: preview/u);
  assert.equal(option.status, 2);
  assert.match(option.stdout, /Неизвестный аргумент: --surprise/u);
});
