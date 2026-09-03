import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { calculateQualityMetrics, validateQualityDataset } from '../ai/quality.js';
import { getWritingRules } from '../ai/writing.js';
import {
  applyRuns,
  mapCriteria,
  mergeJournal,
  mergeRuns,
  parseArgs,
  parseJournal,
  toRun,
} from '../scripts/merge-quality-runs.js';

const stubs = JSON.parse(await fs.readFile(new URL('../quality/writing-fipi-stubs.json', import.meta.url), 'utf8'));

/*
 * Слияние проверяется на выдуманных работах, а не поверх настоящих: набор эталонный, и оценка,
 * записанная в quality/writing-fipi-stubs.json «для теста», испортила бы методическую проверку
 * молча. Расшифровки критериев здесь — те же, что у ФИПИ, потому что именно их сопоставление с
 * русскими названиями из разбора ИИ и есть суть этого скрипта.
 */
const LABELS_37 = { k1: 'Решение коммуникативной задачи', k2: 'Организация текста', k3: 'Языковое оформление' };
const LABELS_38 = { k1: 'Решение коммуникативной задачи', k2: 'Организация текста', k3: 'Лексика', k4: 'Грамматика', k5: 'Орфография и пунктуация' };

const fixture = () => [
  {
    id: 'w37-merge-demo-001',
    operation: 'writing_37',
    tags: ['fipi-demo'],
    answer: 'demo answer',
    human: { total: 4, max: 6, criteria: { k1: 2, k2: 2, k3: 0 }, criteriaLabels: { ...LABELS_37 } },
    expectedCriticalErrors: [],
    aiRuns: [],
  },
  {
    // Пять работ набора помечены total-only: в методичке у них есть общий балл и нет разбивки.
    id: 'w37-merge-demo-total',
    operation: 'writing_37',
    tags: ['fipi-demo', 'total-only'],
    answer: 'demo answer',
    human: { total: 3, max: 6, criteria: null, criteriaLabels: { ...LABELS_37 } },
    expectedCriticalErrors: [],
    aiRuns: [],
  },
  {
    id: 'w38-merge-demo-001',
    operation: 'writing_38',
    tags: ['fipi-demo'],
    answer: 'demo answer',
    human: { total: 8, max: 14, criteria: { k1: 2, k2: 2, k3: 2, k4: 1, k5: 1 }, criteriaLabels: { ...LABELS_38 } },
    expectedCriticalErrors: [],
    aiRuns: [],
  },
];

function reviewOf(operation, got) {
  const rules = getWritingRules(operation);
  return {
    words: 120,
    in_range: true,
    overall_got: got.reduce((sum, value) => sum + value, 0),
    overall_max: rules.overallMax,
    verdict: 'В целом неплохо',
    sub: 'Следите за артиклями',
    criteria: rules.criteria.map(([name, max], index) => ({ name, got: got[index], max })),
    errors: [{ title: 'Артикль', wrong: 'a laptop', right: 'the laptop', kind: 'err', note: 'Здесь нужен определённый артикль.' }],
  };
}

function validLine(caseId, run, { operation = 'writing_37', got = [2, 1, 1], provider = 'grok', model = 'grok-4.5', promptVersion = 'writing-v2', repaired = false, review = null } = {}) {
  return {
    caseId,
    run,
    operation,
    provider,
    model,
    promptVersion,
    startedAt: '2026-07-31T10:00:00.000Z',
    durationMs: 8123,
    valid: true,
    repaired,
    review: review || reviewOf(operation, got),
    usage: { promptTokens: 1204, completionTokens: 388, estimatedCostMicrousd: 4200 },
  };
}

function failedLine(caseId, run, { operation = 'writing_37', provider = 'grok', model = 'grok-4.5', promptVersion = 'writing-v2' } = {}) {
  return {
    caseId,
    run,
    operation,
    provider,
    model,
    promptVersion,
    startedAt: '2026-07-31T10:00:00.000Z',
    durationMs: 900,
    valid: false,
    repaired: false,
    errorCode: 'AI_RESPONSE_INVALID_SCHEMA',
    raw: 'это не JSON',
    usage: { promptTokens: 1204, completionTokens: 0, estimatedCostMicrousd: 900 },
  };
}

/* Обрыв до ответа: так выглядела строка первого вызова прогона 1 августа 2026 года — сетевая икота,
 * ответ до модели не дошёл. Разбора в ней нет и быть не может, поэтому и записи прогона тоже. */
function transportLine(caseId, run, { operation = 'writing_37', provider = 'grok', model = 'grok-4.5' } = {}) {
  return {
    caseId,
    run,
    operation,
    provider,
    model,
    startedAt: '2026-08-01T09:31:54.673Z',
    durationMs: 10703,
    valid: false,
    repaired: false,
    errorCode: 'AI_UNAVAILABLE',
    failureKind: 'transport',
    failure: { cause: 'TypeError: fetch failed', causeCode: null, status: 502, timedOut: false, timeoutMs: 300_000 },
    raw: '',
    usage: { promptTokens: null, completionTokens: null, estimatedCostMicrousd: null },
  };
}

const journalText = (lines) => lines.map((line) => JSON.stringify(line)).join('\n') + '\n';

async function workspace(cases = fixture(), lines = []) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-quality-merge-'));
  const dataset = path.join(directory, 'dataset.json');
  const journal = path.join(directory, 'journal.jsonl');
  await fs.writeFile(dataset, `${JSON.stringify(cases, null, 2)}\n`, 'utf8');
  await fs.writeFile(journal, journalText(lines), 'utf8');
  return { directory, dataset, journal, read: async () => JSON.parse(await fs.readFile(dataset, 'utf8')) };
}

test('путь к журналу обязателен, набор берётся по умолчанию', () => {
  assert.deepEqual(parseArgs(['quality/runs/writing-fipi-stubs-grok.jsonl']), {
    journal: 'quality/runs/writing-fipi-stubs-grok.jsonl',
    dataset: 'quality/writing-fipi-stubs.json',
  });
  assert.deepEqual(parseArgs(['a.jsonl', '--dataset=b.json']), { journal: 'a.jsonl', dataset: 'b.json' });
  assert.throws(() => parseArgs([]), /ровно один путь к журналу/u);
  assert.throws(() => parseArgs(['a.jsonl', 'b.jsonl']), /ровно один путь к журналу/u);
});

test('русское название критерия ложится на ключ эксперта, а не на соседний', () => {
  const stub = fixture()[0];
  /* Порядок в разборе намеренно перемешан: сопоставление идёт по названию, а не по позиции —
   * иначе ключ поехал бы молча, и отклонение по критериям §11.2 выглядело бы измерением. */
  const criteria = [
    { name: 'Языковое оформление', got: 0, max: 2 },
    { name: 'Решение коммуникативной задачи', got: 2, max: 2 },
    { name: ' организация   ТЕКСТА ', got: 1, max: 2 },
  ];
  assert.deepEqual(mapCriteria(stub, criteria), { k1: 2, k2: 1, k3: 0 });
});

test('несовпадение названия критерия роняет слияние, называя работу и критерий', () => {
  const cases = fixture();
  const wrong = reviewOf('writing_37', [2, 1, 1]);
  wrong.criteria[2] = { name: 'Языковая грамотность', got: 1, max: 2 };

  assert.throws(
    () => mapCriteria(cases[0], wrong.criteria),
    /критерий «Языковая грамотность» не найден в human\.criteriaLabels/u,
  );

  // В журнале две работы: одна нормальная, одна с чужим названием. Набор не переписывается вовсе.
  const { applied, problems } = applyRuns(cases, [
    validLine('w37-merge-demo-001', 1),
    validLine('w37-merge-demo-001', 2, { review: wrong }),
  ]);
  assert.deepEqual(applied, []);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /^w37-merge-demo-001, прогон 2: /u, 'названы и работа, и номер прогона');
  assert.match(problems[0], /«Языковая грамотность»/u, 'назван критерий, который не сошёлся');
  assert.match(problems[0], /k3 = «Языковое оформление»/u, 'перечислено то, с чем сопоставляли');
  for (const stub of cases) assert.deepEqual(stub.aiRuns, [], 'ни одна работа не тронута');
});

test('пропущенный критерий и парные расшифровки тоже роняют слияние', () => {
  const stub = fixture()[0];
  assert.throws(() => mapCriteria(stub, [{ name: 'Решение коммуникативной задачи', got: 2, max: 2 }]), /нет критериев k2 .*k3/u);

  const twins = fixture()[0];
  twins.human.criteriaLabels.k3 = twins.human.criteriaLabels.k2;
  assert.throws(() => mapCriteria(twins, reviewOf('writing_37', [2, 1, 1]).criteria), /стоит и у k2, и у k3/u);

  const unlabelled = fixture()[0];
  delete unlabelled.human.criteriaLabels;
  assert.throws(() => mapCriteria(unlabelled, reviewOf('writing_37', [2, 1, 1]).criteria), /human\.criteriaLabels нет/u);
});

test('три поля человеческого суждения записаны как null, а не как true', () => {
  const cases = fixture();
  applyRuns(cases, [validLine('w37-merge-demo-001', 1)]);
  const [run] = cases[0].aiRuns;

  for (const field of ['explanationApproved', 'britishEnglishApproved', 'injectionResisted']) {
    assert.ok(field in run, `${field}: поле обязано присутствовать`);
    assert.strictEqual(run[field], null, `${field}: «не измерено» — это null, и подставлять true запрещено`);
  }
  // Именно так ai/quality.js отличает «не измерено» от «не пройдено»: доля равна null, а не нулю.
  const metrics = calculateQualityMetrics(cases.slice(0, 1));
  assert.equal(metrics.explanationApprovalRate, null);
  assert.equal(metrics.britishEnglishRate, null);
  assert.equal(metrics.promptInjectionResistance, null);
});

test('запись прогона повторяет форму engineering-smoke и несёт полное происхождение', () => {
  const cases = fixture();
  applyRuns(cases, [validLine('w38-merge-demo-001', 1, { operation: 'writing_38', got: [3, 2, 2, 1, 1], provider: 'groq', model: 'llama-4', repaired: true })]);
  const [run] = cases[2].aiRuns;

  assert.deepEqual(run, {
    valid: true,
    total: 9,
    criteria: { k1: 3, k2: 2, k3: 2, k4: 1, k5: 1 },
    // Пусто намеренно: разбор возвращает ошибки текстом, а не кодами, таксономии в проекте нет.
    detectedErrors: [],
    explanationApproved: null,
    britishEnglishApproved: null,
    injectionResisted: null,
    repaired: true,
    provider: 'groq',
    model: 'llama-4',
    promptVersion: 'writing-v2',
  });
  assert.deepEqual(Object.keys(run).slice(0, 7), ['valid', 'total', 'criteria', 'detectedErrors', 'explanationApproved', 'britishEnglishApproved', 'injectionResisted']);
});

test('версии промпта одной модели сохраняют происхождение и не затирают друг друга', () => {
  const cases = fixture();

  applyRuns(cases, [validLine('w37-merge-demo-001', 1, { promptVersion: 'writing-v3' })]);
  applyRuns(cases, [validLine('w37-merge-demo-001', 1, { promptVersion: 'writing-v4', got: [1, 1, 1] })]);

  assert.deepEqual(
    cases[0].aiRuns.map(({ provider, model, promptVersion, total }) => ({ provider, model, promptVersion, total })),
    [
      { provider: 'grok', model: 'grok-4.5', promptVersion: 'writing-v3', total: 4 },
      { provider: 'grok', model: 'grok-4.5', promptVersion: 'writing-v4', total: 3 },
    ],
    'замер новой версии промпта не имеет права вытеснить прежний или потерять свою версию',
  );
});

test('работа total-only сливается без поля criteria и не роняет скрипт', () => {
  const cases = fixture();
  const { applied, problems } = applyRuns(cases, [
    validLine('w37-merge-demo-total', 1),
    validLine('w37-merge-demo-total', 2, { got: [1, 1, 1] }),
  ]);

  assert.deepEqual(problems, []);
  assert.deepEqual(applied, ['w37-merge-demo-total']);
  const [first, second] = cases[1].aiRuns;
  assert.ok(!('criteria' in first), 'сопоставлять не с чем: у работы нет разбивки эксперта');
  assert.equal(first.total, 4);
  assert.equal(second.total, 3);
  assert.equal(cases[1].human.criteria, null, 'оценка эксперта не трогается');
});

test('неудачный вызов попадает в aiRuns отказом, а не выбрасывается', () => {
  const cases = fixture();
  applyRuns(cases, [validLine('w37-merge-demo-001', 1), failedLine('w37-merge-demo-001', 2)]);

  assert.deepEqual(cases[0].aiRuns.map((run) => run.valid), [true, false]);
  assert.deepEqual(cases[0].aiRuns[1], { valid: false, repaired: false, provider: 'grok', model: 'grok-4.5', promptVersion: 'writing-v2' });
  /* Доля валидных ответов — метрика §11.2: выброшенный провал показал бы 100% вместо половины. */
  assert.equal(calculateQualityMetrics(cases.slice(0, 1)).schemaPassRate, 0.5);
});

test('обрыв связи в набор не едет вовсе, а нарушение контракта едет', () => {
  const cases = fixture();
  const { problems, transport, runs } = applyRuns(cases, [
    validLine('w37-merge-demo-001', 1),
    transportLine('w37-merge-demo-001', 2),
    failedLine('w37-merge-demo-001', 3),
  ]);

  assert.deepEqual(problems, []);
  assert.equal(transport, 1, 'число обрывов называется, а не прячется');
  assert.equal(runs, 2, 'в набор перенесены ответ и отвергнутый ответ — и ничего больше');
  assert.deepEqual(cases[0].aiRuns.map((run) => run.valid), [true, false]);

  /* Главное: 1 из 2, а не 1 из 3. Модель ответила дважды, и провал схемы у неё один; обрыв связи
   * измерением не является, а посчитанный провалом двигал бы долю валидных ответов вниз при пороге
   * §11.3 в 95 % — «не измерено» выдавалось бы за «не пройдено». */
  assert.equal(calculateQualityMetrics(cases.slice(0, 1)).schemaPassRate, 0.5);
});

test('обрыв опознаётся и в журнале, записанном до появления признака', () => {
  /* Записанные журналы задним числом не правятся. Признак выводится из кода ошибки — того самого
   * error.message, который раннер положил в errorCode, — поэтому строка без поля failureKind
   * читается тем же правилом, что и новая. */
  const legacy = transportLine('w37-merge-demo-001', 1);
  delete legacy.failureKind;

  const cases = fixture();
  const { transport, runs } = applyRuns(cases, [legacy, validLine('w37-merge-demo-001', 2)]);
  assert.equal(transport, 1);
  assert.equal(runs, 1);
  assert.deepEqual(cases[0].aiRuns.map((run) => run.valid), [true]);

  // И тот же запрет держится на уровне записи: обрыв не превращается в отказ ни у какого вызывающего.
  assert.throws(() => toRun(cases[0], legacy), /обрыв до ответа/u);
  assert.throws(() => toRun(cases[0], transportLine('w37-merge-demo-001', 1)), /обрыв до ответа/u);
});

test('слияние называет число обрывов и не переносит их в набор', async () => {
  const { dataset, journal, read } = await workspace(fixture(), [
    validLine('w37-merge-demo-001', 1),
    transportLine('w37-merge-demo-001', 2),
  ]);
  const printed = [];

  const summary = await mergeJournal({ journal, dataset, log: (line) => printed.push(line) });

  assert.equal(summary.transport, 1);
  assert.equal(summary.runs, 1);
  assert.match(printed.join('\n'), /Обрывов связи: 1/u);
  assert.match(printed.join('\n'), /quality:run/u, 'сказано, что их переспросит повторный запуск');
  assert.deepEqual((await read())[0].aiRuns.map((run) => run.valid), [true]);
});

test('повторное слияние того же журнала не удваивает aiRuns и не переставляет их', () => {
  const lines = [validLine('w37-merge-demo-001', 1), validLine('w37-merge-demo-001', 2, { got: [2, 2, 1] }), failedLine('w37-merge-demo-total', 1)];
  const once = fixture();
  applyRuns(once, lines);
  const twice = fixture();
  applyRuns(twice, lines);
  applyRuns(twice, lines);

  assert.equal(once[0].aiRuns.length, 2);
  assert.deepEqual(twice, once, 'второе слияние того же журнала ничего не меняет');
});

test('прогоны другого провайдера остаются на месте', () => {
  const cases = fixture();
  applyRuns(cases, [validLine('w37-merge-demo-001', 1, { provider: 'groq', model: 'llama-4' })]);
  applyRuns(cases, [validLine('w37-merge-demo-001', 1), validLine('w37-merge-demo-001', 2)]);

  assert.deepEqual(cases[0].aiRuns.map((run) => `${run.provider}/${run.model}`), ['groq/llama-4', 'grok/grok-4.5', 'grok/grok-4.5']);
});

test('журнал — источник правды для своей тройки происхождения', () => {
  const older = [{ valid: true, total: 4, provider: 'grok', model: 'grok-4.5' }, { valid: true, total: 5, provider: 'grok', model: 'grok-4.5' }];
  const shorter = mergeRuns(older, [{ valid: true, total: 6, provider: 'grok', model: 'grok-4.5' }]);
  assert.deepEqual(shorter, [{ valid: true, total: 6, provider: 'grok', model: 'grok-4.5' }], 'прогона, которого в журнале больше нет, не остаётся');
  assert.deepEqual(mergeRuns([], []), []);
});

test('строка без поля valid и валидная строка без разбора отвергаются', () => {
  const stub = fixture()[0];
  assert.throws(() => toRun(stub, { caseId: 'x', run: 1 }), /нет поля valid/u);
  assert.throws(() => toRun(stub, { valid: true, review: null }), /разбора с общим баллом/u);
});

test('нечитаемая строка журнала считается, а не пропускается молча', async () => {
  const { entries, damaged } = parseJournal([JSON.stringify(validLine('w37-merge-demo-001', 1)), '', '{это не json', JSON.stringify({ run: 2 })].join('\n'));
  assert.equal(entries.length, 1);
  assert.deepEqual(damaged, [3, 4]);

  const { dataset, journal, read } = await workspace();
  await fs.writeFile(journal, `${JSON.stringify(validLine('w37-merge-demo-001', 1))}\n{обрыв\n`, 'utf8');
  await assert.rejects(() => mergeJournal({ journal, dataset, log: () => {} }), /нечитаемых строк 1 \(2\)/u);
  assert.deepEqual((await read())[0].aiRuns, [], 'набор не переписывается по неполному журналу');
});

test('работа из журнала, которой нет в наборе, названа, а не отброшена', () => {
  const cases = fixture();
  const { applied, problems } = applyRuns(cases, [validLine('w37-которой-нет', 1)]);
  assert.deepEqual(applied, []);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /w37-которой-нет: такой работы нет в наборе/u);
});

test('слитый набор считается отчётом: метрики вместо жалобы на пустой aiRuns', async () => {
  const lines = [];
  for (const [id, operation, got] of [['w37-merge-demo-001', 'writing_37', [2, 2, 0]], ['w37-merge-demo-total', 'writing_37', [1, 1, 1]], ['w38-merge-demo-001', 'writing_38', [2, 2, 2, 1, 1]]]) {
    lines.push(validLine(id, 1, { operation, got }), validLine(id, 2, { operation, got }));
  }
  const { dataset, journal, read } = await workspace(fixture(), lines);

  const summary = await mergeJournal({ journal, dataset, log: () => {} });
  assert.equal(summary.runs, 6);
  assert.equal(summary.valid, 6);
  assert.equal(summary.empty, 0);

  const merged = await read();
  const validation = validateQualityDataset(merged);
  assert.ok(validation.ok, JSON.stringify(validation.errors));

  const metrics = calculateQualityMetrics(merged);
  assert.equal(metrics.schemaPassRate, 1);
  // Ключи отклонения по критериям — те же kN, которыми записана оценка эксперта.
  assert.deepEqual(Object.keys(metrics.criterionMae).sort(), ['k1', 'k2', 'k3', 'k4', 'k5']);
  assert.equal(metrics.criterionMae.k1, 0);
  assert.ok(Number.isFinite(metrics.meanAbsoluteError));
  assert.equal(metrics.promptInjectionResistance, null, 'неизмеренное остаётся неизмеренным');

  // Повторный запуск на том же журнале не меняет набор ни на байт.
  const before = await fs.readFile(dataset, 'utf8');
  await mergeJournal({ journal, dataset, log: () => {} });
  assert.equal(await fs.readFile(dataset, 'utf8'), before);
});

test('эталонный набор пригоден к слиянию: расшифровки критериев совпадают с теми, что вернёт ИИ', () => {
  // Инвариант, а не счётчик: набор пополняется, и число работ меняется по плану.
  assert.ok(stubs.length >= 1);
  for (const stub of stubs) {
    const labels = stub.human?.criteriaLabels;
    if (!labels) continue;
    const rules = getWritingRules(stub.operation);
    assert.ok(rules, `${stub.id}: неизвестная операция ${stub.operation}`);
    /* Именно это равенство делает слияние возможным: parseAndValidateWritingReview требует от ИИ
     * ровно эти названия, и по ним сопоставляются ключи kN. Разойдутся — слияние упадёт, и упадёт
     * оно уже после оплаченного прогона. */
    assert.deepEqual(Object.values(labels).map((label) => label.trim()), rules.criteria.map(([name]) => name), `${stub.id}: расшифровки критериев разошлись с промптом`);
    for (const key of Object.keys(stub.human?.criteria || {})) {
      assert.ok(key in labels, `${stub.id}: у критерия ${key} нет расшифровки — сопоставить его с ответом ИИ будет нечем`);
    }
    // Слияние настоящего разбора этой работы даёт ключи, по которым ai/quality.js считает §11.2.
    const mapped = mapCriteria(stub, reviewOf(stub.operation, rules.criteria.map(() => 1)).criteria);
    assert.deepEqual(mapped === null ? {} : mapped, Object.fromEntries(Object.keys(stub.human?.criteria || {}).map((key) => [key, 1])));
  }
});
