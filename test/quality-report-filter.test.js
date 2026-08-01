import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { calculateQualityMetrics, filterQualityRuns, listRunVariants } from '../ai/quality.js';

/*
 * Отчёт считает по подмножеству прогонов. После слияния двух журналов у работы лежат прогоны обеих
 * моделей, и метрика по ним всем сразу измерением не является: stabilityWithinOnePoint назвала бы
 * расхождение между разными моделями нестабильностью одной. Проверяется отбор, громкость
 * предупреждения о смешивании, поимённое называние работ, оставшихся без прогонов, — и то, что без
 * ключей вывод прежний.
 */

const root = fileURLToPath(new URL('..', import.meta.url));
const script = fileURLToPath(new URL('../scripts/ai-quality-report.js', import.meta.url));

const aiRun = (model, total, fields = {}) => ({
  valid: true,
  total,
  criteria: { task: 2 },
  detectedErrors: [],
  explanationApproved: true,
  britishEnglishApproved: true,
  injectionResisted: true,
  provider: 'grok',
  model,
  ...fields,
});

// Две модели на трёх работах: у третьей прогоны только второй модели — под фильтром первой она
// остаётся без единого прогона, и назвать её обязаны поимённо.
const twoModels = () => [
  {
    id: 'w37-a', operation: 'writing_37', human: { total: 4, criteria: { task: 2 }, reviewer: 'fixture' },
    expectedCriticalErrors: [],
    aiRuns: [aiRun('model-a', 4), aiRun('model-a', 4), aiRun('model-b', 9), aiRun('model-b', 9)],
  },
  {
    id: 'w38-b', operation: 'writing_38', human: { total: 4, criteria: { task: 2 }, reviewer: 'fixture' },
    expectedCriticalErrors: [],
    aiRuns: [aiRun('model-a', 4), aiRun('model-a', 4)],
  },
  {
    id: 'w38-c', operation: 'writing_38', human: { total: 4, criteria: { task: 2 }, reviewer: 'fixture' },
    expectedCriticalErrors: [],
    aiRuns: [aiRun('model-b', 8), aiRun('model-b', 8)],
  },
];

// Фикстуры живут во временном каталоге: настоящий набор и журналы прогона отчёт только читает.
const temporary = [];
after(() => temporary.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

function datasetFile(cases) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quality-report-'));
  temporary.push(dir);
  const file = path.join(dir, 'dataset.json');
  fs.writeFileSync(file, JSON.stringify(cases, null, 2), 'utf8');
  return file;
}

function report(args) {
  const result = spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

test('filterQualityRuns keeps the runs of one model and names the works left without any', () => {
  const cases = twoModels();
  const selection = filterQualityRuns(cases, { model: 'model-a' });
  assert.equal(selection.filtered, true);
  assert.equal(selection.matched, 4);
  assert.deepEqual(selection.emptied, ['w38-c']);
  assert.deepEqual(selection.cases.map((item) => item.aiRuns.length), [2, 2, 0]);
  assert.ok(selection.cases.every((item) => item.aiRuns.every((run) => run.model === 'model-a')));
  // Набор читается, а не правится: отчёт не должен уметь испортить эталонный файл в памяти.
  assert.deepEqual(cases.map((item) => item.aiRuns.length), [4, 2, 2]);
});

test('without a filter the set is passed through untouched', () => {
  const cases = twoModels();
  const selection = filterQualityRuns(cases, {});
  assert.equal(selection.filtered, false);
  assert.deepEqual(selection.emptied, []);
  assert.equal(selection.cases, cases);
});

test('run variants include the prompt version, and a missing field is its own origin', () => {
  assert.deepEqual(listRunVariants(twoModels()), [
    { provider: 'grok', model: 'model-a', promptVersion: null },
    { provider: 'grok', model: 'model-b', promptVersion: null },
  ]);
  assert.deepEqual(listRunVariants([{ id: 'x', aiRuns: [{ valid: true, total: 1 }] }]), [{ provider: null, model: null, promptVersion: null }]);
});

test('a filtered set no longer calls a disagreement between models an instability of one', () => {
  const cases = twoModels();
  const mixed = calculateQualityMetrics(cases);
  const single = calculateQualityMetrics(filterQualityRuns(cases, { model: 'model-a' }).cases);
  // Смешанные прогоны w37-a расходятся на 5 баллов — это разница между моделями, а не разброс одной.
  assert.ok(mixed.stabilityWithinOnePoint < single.stabilityWithinOnePoint);
  assert.equal(single.stabilityWithinOnePoint, 1);
  assert.equal(single.runs, 4);
  assert.equal(single.meanAbsoluteError, 0);
});

test('a set of two models without a filter warns loudly and says so in the report itself', () => {
  const file = datasetFile(twoModels());
  const { status, stdout, stderr } = report([file]);
  assert.equal(status, 0);
  assert.match(stderr, /ВНИМАНИЕ/u);
  assert.match(stderr, /model-a/u);
  assert.match(stderr, /model-b/u);
  assert.match(stderr, /--model=model-a/u);
  const parsed = JSON.parse(stdout);
  assert.ok(parsed.warning, 'предупреждение должно доезжать и до самого отчёта, а не только до stderr');
  assert.match(parsed.warning, /model-b/u);
  assert.equal('filter' in parsed, false);
});

test('the chosen filter stands in the report next to the dataset name', () => {
  const file = datasetFile(twoModels());
  const { status, stdout, stderr } = report([file, '--provider=grok', '--model=model-a']);
  assert.equal(status, 0);
  const parsed = JSON.parse(stdout);
  assert.deepEqual(Object.keys(parsed).slice(0, 2), ['dataset', 'filter']);
  assert.deepEqual(parsed.filter, { provider: 'grok', model: 'model-a' });
  assert.equal(parsed.warning, undefined);
  assert.deepEqual(parsed.casesWithoutRuns, ['w38-c']);
  assert.equal(parsed.metrics.runs, 4);
  assert.match(stderr, /w38-c/u);
});

test('a filter that still leaves two models warns just as loudly', () => {
  const file = datasetFile(twoModels());
  const { status, stdout, stderr } = report([file, '--provider=grok']);
  assert.equal(status, 0);
  assert.match(stderr, /ВНИМАНИЕ/u);
  assert.ok(JSON.parse(stdout).warning);
});

test('two prompt versions of one model are separate variants and require an explicit prompt filter', () => {
  const cases = twoModels().map((item) => ({
    ...item,
    aiRuns: item.aiRuns
      .filter((run) => run.model === 'model-a')
      .flatMap((run) => [
        { ...run, promptVersion: 'writing-v3' },
        { ...run, promptVersion: 'writing-v4', total: run.total + 1 },
      ]),
  })).filter((item) => item.aiRuns.length);

  assert.deepEqual(listRunVariants(cases), [
    { provider: 'grok', model: 'model-a', promptVersion: 'writing-v3' },
    { provider: 'grok', model: 'model-a', promptVersion: 'writing-v4' },
  ]);
  const selected = filterQualityRuns(cases, { model: 'model-a', promptVersion: 'writing-v4' });
  assert.equal(selected.filtered, true);
  assert.ok(selected.cases.every((item) => item.aiRuns.every((run) => run.promptVersion === 'writing-v4')));

  const file = datasetFile(cases);
  const mixed = report([file, '--model=model-a']);
  assert.equal(mixed.status, 0);
  assert.match(mixed.stderr, /ВНИМАНИЕ/u);
  assert.match(mixed.stderr, /writing-v3/u);
  assert.match(mixed.stderr, /--prompt-version=writing-v4/u);

  const single = report([file, '--model=model-a', '--prompt-version=writing-v4']);
  assert.equal(single.status, 0);
  assert.equal(single.stderr, '');
  assert.deepEqual(JSON.parse(single.stdout).filter, { model: 'model-a', promptVersion: 'writing-v4' });
});

test('an unversioned run stays unknown next to a named prompt instead of borrowing its version', () => {
  const cases = [{
    id: 'w37-unknown', operation: 'writing_37', human: { total: 4, criteria: { task: 2 }, reviewer: 'fixture' },
    expectedCriticalErrors: [],
    aiRuns: [aiRun('model-a', 4), aiRun('model-a', 5, { promptVersion: 'writing-v4' })],
  }];
  assert.deepEqual(listRunVariants(cases), [
    { provider: 'grok', model: 'model-a', promptVersion: null },
    { provider: 'grok', model: 'model-a', promptVersion: 'writing-v4' },
  ]);

  const { status, stderr } = report([datasetFile(cases), '--model=model-a']);
  assert.equal(status, 0);
  assert.match(stderr, /версия промпта не указана/u);
  assert.match(stderr, /восстановите источник из журнала/u);
});

test('a filter matching no run at all stops instead of printing a report of nulls', () => {
  const file = datasetFile(twoModels());
  const { status, stdout, stderr } = report([file, '--model=model-typo']);
  assert.equal(status, 1);
  assert.equal(stdout, '');
  assert.match(stderr, /model-typo/u);
  assert.match(stderr, /model-a/u);
});

test('an option without a value is refused instead of becoming the dataset path', () => {
  const file = datasetFile(twoModels());
  assert.equal(report([file, '--model']).status, 1);
  assert.equal(report([file, '--model=']).status, 1);
  assert.equal(report([file, '--model=model-a', '--model=model-b']).status, 1);
});

test('without the options the report is what it was: no filter, no warning, same keys', () => {
  const { status, stdout, stderr } = report(['quality/engineering-smoke.json']);
  assert.equal(status, 0);
  assert.equal(stderr, '');
  const parsed = JSON.parse(stdout);
  // Порядок и состав ключей, а не числа: числа меняются от пополнения набора, ключи — контракт.
  assert.deepEqual(Object.keys(parsed), ['dataset', 'release', 'counts', 'metrics', 'gate']);
});
