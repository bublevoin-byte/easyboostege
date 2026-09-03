import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { calculateQualityMetrics } from '../ai/quality.js';
import { getWritingRules } from '../ai/writing.js';
import { applyRuns, mergeJournal, parseJournal } from '../scripts/merge-quality-runs.js';
import {
  answerLines,
  buildWorksheet,
  parseArgs as parseBuildArgs,
  planBlocks,
} from '../scripts/build-review-worksheet.js';
import {
  applyAnswers,
  locateRun,
  mergeWorksheet,
  parseAnswers,
  parseArgs as parseMergeArgs,
  parseWorksheet,
  QUESTIONS,
} from '../scripts/merge-review-worksheet.js';

/*
 * Опросник проверяется на выдуманных работах, а не поверх настоящих: набор эталонный, и ответ
 * владельца, записанный в quality/writing-fipi-stubs.json «для теста», подделал бы ровно ту
 * метрическую проверку, ради которой этот опросник существует. Настоящий платный прогон здесь тоже
 * не запускается: журнал собирается руками, как его собрал бы раннер.
 */
const LABELS_37 = { k1: 'Решение коммуникативной задачи', k2: 'Организация текста', k3: 'Языковое оформление' };

const ANSWER = 'Hey Mike. My favourite device is a laptop, and I use it for studying every single day.';
const ASSIGNMENT = 'You have received an email message from your English-speaking pen-friend Mike: From: Mike@mail.uk … Write an email to Mike. Write 100–140 words.';

const fixture = () => [
  {
    id: 'w37-review-demo-001',
    operation: 'writing_37',
    tags: ['fipi-demo'],
    assignment: ASSIGNMENT,
    answer: ANSWER,
    human: { total: 4, max: 6, criteria: { k1: 2, k2: 2, k3: 0 }, criteriaLabels: { ...LABELS_37 } },
    expectedCriticalErrors: [],
    aiRuns: [],
  },
  {
    id: 'w37-review-demo-002',
    operation: 'writing_37',
    tags: ['fipi-demo'],
    assignment: ASSIGNMENT,
    answer: ANSWER,
    human: { total: 3, max: 6, criteria: { k1: 1, k2: 1, k3: 1 }, criteriaLabels: { ...LABELS_37 } },
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
    verdict: 'В целом неплохо, но письмо не дотягивает по объёму',
    sub: 'Следите за артиклями',
    criteria: rules.criteria.map(([name, max], index) => ({ name, got: got[index], max })),
    errors: [
      { title: 'Артикль', wrong: 'a laptop', right: 'the laptop', kind: 'err', note: 'Здесь нужен определённый артикль.' },
      { title: 'Регистр', wrong: '', right: '', kind: 'warn', note: 'Обращение в письме пишется с новой строки.' },
    ],
  };
}

function validLine(caseId, run, { got = [2, 1, 1], provider = 'grok', model = 'grok-4.5', promptVersion = 'writing-v2', repaired = false } = {}) {
  return {
    caseId,
    run,
    operation: 'writing_37',
    provider,
    model,
    promptVersion,
    startedAt: '2026-07-31T10:00:00.000Z',
    durationMs: 8123,
    valid: true,
    repaired,
    review: reviewOf('writing_37', got),
    usage: { promptTokens: 1204, completionTokens: 388, estimatedCostMicrousd: 4200 },
  };
}

function failedLine(caseId, run, { provider = 'grok', model = 'grok-4.5' } = {}) {
  return {
    caseId,
    run,
    operation: 'writing_37',
    provider,
    model,
    startedAt: '2026-07-31T10:00:00.000Z',
    durationMs: 900,
    valid: false,
    repaired: false,
    errorCode: 'AI_RESPONSE_INVALID_SCHEMA',
    raw: 'это не JSON',
    usage: { promptTokens: 1204, completionTokens: 0, estimatedCostMicrousd: 900 },
  };
}

const journalText = (lines) => lines.map((line) => JSON.stringify(line)).join('\n') + '\n';

const build = (lines, cases = fixture(), previous = new Map()) => buildWorksheet({
  journal: 'quality/runs/demo.jsonl',
  dataset: 'quality/demo.json',
  entries: parseJournal(journalText(lines)).entries,
  cases,
  previous,
});

/* Вписывает ответы в блок так, как это сделал бы владелец в редакторе: заменяет три строки внутри
 * блока с меткой нужного прогона, не трогая саму метку. */
function fill(markdown, caseId, run, answers) {
  const pattern = new RegExp(`(<!-- review ${caseId} run=${run} [^\\n]*-->\\n\`\`\`text\\n)[\\s\\S]*?(\`\`\`)`, 'u');
  assert.match(markdown, pattern, `в опроснике нет блока ${caseId} прогон ${run}`);
  const body = QUESTIONS.map((question, index) => `${question.label} |${answers[index] ? ` ${answers[index]}` : ''}`).join('\n');
  return markdown.replace(pattern, `$1${body}\n$2`);
}

async function workspace(cases = fixture(), lines = []) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-review-worksheet-'));
  const dataset = path.join(directory, 'dataset.json');
  const journal = path.join(directory, 'journal.jsonl');
  const worksheet = path.join(directory, 'review-worksheet.md');
  await fs.writeFile(dataset, `${JSON.stringify(cases, null, 2)}\n`, 'utf8');
  await fs.writeFile(journal, journalText(lines), 'utf8');
  // Опросник живёт после слияния журнала: без aiRuns вопросы задавать не к чему.
  await mergeJournal({ journal, dataset, log: () => {} });
  const built = buildWorksheet({
    journal,
    dataset,
    entries: parseJournal(journalText(lines)).entries,
    cases: JSON.parse(await fs.readFile(dataset, 'utf8')),
  });
  await fs.writeFile(worksheet, built.markdown, 'utf8');
  return {
    directory,
    dataset,
    journal,
    worksheet,
    read: async () => JSON.parse(await fs.readFile(dataset, 'utf8')),
    sheet: async () => fs.readFile(worksheet, 'utf8'),
    write: (markdown) => fs.writeFile(worksheet, markdown, 'utf8'),
  };
}

test('ключи команд: журнал обязателен для сборки, опросник и набор берутся по умолчанию', () => {
  assert.deepEqual(parseBuildArgs(['quality/runs/writing-fipi-stubs-grok.jsonl']), {
    journal: 'quality/runs/writing-fipi-stubs-grok.jsonl',
    dataset: 'quality/writing-fipi-stubs.json',
    out: 'quality/review-worksheet.md',
  });
  assert.throws(() => parseBuildArgs([]), /ровно один путь к журналу/u);
  assert.throws(() => parseBuildArgs(['a.jsonl', 'b.jsonl']), /ровно один путь к журналу/u);

  assert.deepEqual(parseMergeArgs([]), {
    worksheet: 'quality/review-worksheet.md',
    dataset: 'quality/writing-fipi-stubs.json',
  });
  assert.deepEqual(parseMergeArgs(['--dataset=b.json']), { worksheet: 'quality/review-worksheet.md', dataset: 'b.json' });
});

test('блок прогона несёт всё, чем судят, — не открывая ни методичку, ни журнал', () => {
  const { markdown, runs, works, refusals } = build([validLine('w37-review-demo-001', 1)]);

  assert.equal(runs, 1);
  assert.equal(works, 1);
  assert.equal(refusals, 0);
  assert.match(markdown, /## 1\. w37-review-demo-001 — прогон 1/u, 'идентификатор работы и номер прогона');
  assert.match(markdown, /\*\*Провайдер:\*\* grok, модель grok-4\.5/u, 'провайдер и модель');
  assert.ok(markdown.includes(ASSIGNMENT.slice(0, 40)), 'условие задания');
  assert.ok(markdown.includes(ANSWER), 'ответ ученика целиком, как его видел ИИ');
  assert.match(markdown, /\*\*Оценка эксперта:\*\* 4 из 6: Решение коммуникативной задачи — 2, Организация текста — 2, Языковое оформление — 0/u);
  assert.match(markdown, /\*\*Оценка ИИ:\*\* 4 из 6: Решение коммуникативной задачи — 2 из 2, Организация текста — 1 из 2, Языковое оформление — 1 из 2/u);
  assert.match(markdown, /\*\*Вердикт ИИ:\*\* В целом неплохо, но письмо не дотягивает по объёму/u);
  assert.match(markdown, /\*\*Главный совет ИИ:\*\* Следите за артиклями/u);

  // Разобранные ошибки — с фрагментом, исправлением и пояснением: без них о методичности не судят.
  assert.match(markdown, /\*\*Разобранные ошибки — 2:\*\*/u);
  assert.match(markdown, /1\. \*\*Артикль\*\* \(ошибка\)/u);
  assert.match(markdown, /- было: «a laptop»/u);
  assert.match(markdown, /- надо: «the laptop»/u);
  assert.match(markdown, /- пояснение: Здесь нужен определённый артикль\./u);
  assert.match(markdown, /2\. \*\*Регистр\*\* \(замечание\)/u, 'пустые wrong и right не печатаются пустыми строками');

  // Три галочки — ровно три, каждая пустая.
  const answers = [...parseWorksheet(markdown).values()][0];
  assert.deepEqual(answers.lines, QUESTIONS.map((question) => `${question.label} |`));
  assert.equal(parseAnswers(answers.lines).size, 0, 'опросник приезжает к владельцу пустым');
});

test('шапка объясняет, что читать и что запускать, и честно оговаривает третий вопрос', () => {
  const { markdown } = build([validLine('w37-review-demo-001', 1)]);
  const head = markdown.split('---')[0];

  assert.match(head, /npm run quality:merge-review/u, 'сказано, что запускать после заполнения');
  assert.match(head, /`да`, `нет` или `не знаю`/u, 'сказано, что ставить');
  assert.match(head, /ни методичку, ни журнал прогона открывать не нужно/u);
  // Прямой запрет тикета: подставленного true быть не должно, и шапка говорит об этом словами.
  assert.match(head, /самообман/u);

  /* Оговорка про третий вопрос. В наборе ФИПИ работ с внедрённой инструкцией нет по определению,
   * честный ответ по ним — «не знаю», и опросник обязан сказать это прямо: иначе владелец поставит
   * «да» из вежливости, и §11.2 получит выдуманную единицу вместо честного «не измерено». */
  assert.match(head, /В наборе ФИПИ работ со спрятанной инструкцией нет/u);
  assert.match(head, /честный ответ — \*\*«не знаю»\*\*/u);
  assert.match(head, /Ставить «да» из вежливости не нужно/u);

  // Никакой автоматической проверки британского английского: владелец выбрал ручной проход.
  assert.match(head, /британский английский выдержан/u);
});

test('отказ провайдера попадает в лист справочно и вопросов не получает', () => {
  const { markdown, runs, refusals, blocks } = build([
    validLine('w37-review-demo-001', 1),
    failedLine('w37-review-demo-001', 2),
  ]);

  assert.equal(blocks, 2);
  assert.equal(runs, 1, 'вопросы задаются только там, где есть разбор');
  assert.equal(refusals, 1);
  assert.match(markdown, /## 2\. w37-review-demo-001 — прогон 2: отказ/u);
  assert.match(markdown, /AI_RESPONSE_INVALID_SCHEMA/u);
  assert.equal(parseWorksheet(markdown).size, 1, 'у отказа нет метки — заполнять в нём нечего');
});

test('порядковый номер прогона в метке считается так же, как при слиянии журнала', () => {
  const lines = [
    validLine('w37-review-demo-001', 2, { got: [2, 2, 1] }),
    validLine('w37-review-demo-001', 1, { got: [1, 1, 1] }),
    validLine('w37-review-demo-001', 3, { got: [2, 2, 2], provider: 'groq', model: 'llama-4' }),
  ];
  const planned = planBlocks(parseJournal(journalText(lines)).entries);

  /* Прогон опознаётся тройкой происхождения и порядком внутри неё — ровно так его кладёт
   * mergeRuns() в scripts/merge-quality-runs.js. Второй способ сопоставления однажды разошёлся бы
   * с первым, и разошёлся бы молча. */
  assert.deepEqual(planned.map((item) => `${item.run}/${item.entry.provider}/${item.position}`), [
    '1/grok/0',
    '2/grok/1',
    '3/groq/0',
  ]);

  // Соответствие проверяется не на словах: набор сливается настоящим scripts/merge-quality-runs.js,
  // и метка каждого блока обязана привести к записи ровно того прогона, из которого напечатана.
  const cases = fixture();
  applyRuns(cases, parseJournal(journalText(lines)).entries);
  for (const item of planned) {
    const located = locateRun(cases[0], {
      provider: item.entry.provider,
      model: item.entry.model,
      promptVersion: item.entry.promptVersion,
      position: item.position,
    });
    assert.equal(located.total, item.entry.review.overall_got, `прогон ${item.run}: метка привела не к тому прогону`);
  }
});

test('обрыв связи блока не получает — иначе нумерация уехала бы от набора', () => {
  /* Слияние не переносит обрыв до ответа в aiRuns: разбора в нём нет. Блок, напечатанный для него,
   * сдвинул бы порядковый номер каждого следующего прогона, и суждение владельца легло бы на чужую
   * запись — тихо и необратимо. */
  const broken = { ...failedLine('w37-review-demo-001', 1), errorCode: 'AI_UNAVAILABLE', failureKind: 'transport' };
  const lines = [broken, validLine('w37-review-demo-001', 2, { got: [2, 2, 1] })];
  const planned = planBlocks(parseJournal(journalText(lines)).entries);

  assert.deepEqual(planned.map((item) => `${item.run}/${item.position}`), ['2/0'], 'обрыва в опроснике нет вовсе');

  const cases = fixture();
  applyRuns(cases, parseJournal(journalText(lines)).entries);
  assert.equal(cases[0].aiRuns.length, 1, 'фикстура: в наборе ровно один прогон — тот же');
  for (const item of planned) {
    const located = locateRun(cases[0], {
      provider: item.entry.provider,
      model: item.entry.model,
      promptVersion: item.entry.promptVersion,
      position: item.position,
    });
    assert.equal(located.total, item.entry.review.overall_got, `прогон ${item.run}: метка привела не к тому прогону`);
  }
});

test('«да», «нет» и «не знаю» разбираются в true, false и null', () => {
  const answers = parseAnswers([
    'объяснение методически верно | да',
    'Британский Английский Выдержан: НЕТ.',
    'инструкция из текста ученика не выполнена — не  знаю',
  ]);
  assert.strictEqual(answers.get('explanationApproved'), true);
  assert.strictEqual(answers.get('britishEnglishApproved'), false);
  assert.strictEqual(answers.get('injectionResisted'), null, '«не знаю» — это тоже ответ, и он null');
  assert.equal(answers.size, 3);
});

test('незаполненная строка не превращается в ответ, а непонятная роняет разбор', () => {
  const partial = parseAnswers([
    'объяснение методически верно | да',
    'британский английский выдержан |',
    'инструкция из текста ученика не выполнена |',
  ]);
  assert.deepEqual([...partial.keys()], ['explanationApproved'], 'пустая галочка не значит ни true, ни false');

  assert.throws(() => parseAnswers(['объяснение методически верно | наверное']), /ответ «наверное» непонятен/u);
  assert.throws(() => parseAnswers(['американизмов нет | да']), /не из опросника/u);
  assert.throws(() => parseAnswers(['да']), /не похожа на «пункт \| ответ»/u);
  assert.throws(() => parseAnswers(['объяснение методически верно | да', 'объяснение методически верно | нет']), /встречается в прогоне дважды/u);
});

test('ответ ложится на тот прогон, из которого напечатан блок, а не на соседний', () => {
  const cases = fixture();
  cases[0].aiRuns = [
    { valid: true, total: 4, provider: 'groq', model: 'llama-4', explanationApproved: null },
    { valid: true, total: 4, provider: 'grok', model: 'grok-4.5', explanationApproved: null },
    { valid: true, total: 5, provider: 'grok', model: 'grok-4.5', explanationApproved: null },
  ];

  assert.equal(locateRun(cases[0], { provider: 'grok', model: 'grok-4.5', position: 1 }).total, 5);
  assert.equal(locateRun(cases[0], { provider: 'groq', model: 'llama-4', position: 0 }).total, 4);
  assert.throws(() => locateRun(cases[0], { provider: 'grok', model: 'grok-4.5', position: 2 }), /нет прогона № 3 происхождения grok\/grok-4\.5\/промпт не указан \(их там 2\)/u);
  assert.throws(() => locateRun(cases[0], { provider: 'gemini', model: 'x', position: 0 }), /npm run quality:merge-runs/u);
});

test('опросник различает версии промпта одной модели', () => {
  const cases = fixture();
  cases[0].aiRuns = [
    { valid: true, total: 4, provider: 'grok', model: 'grok-4.5', promptVersion: 'writing-v3', explanationApproved: null },
    { valid: true, total: 5, provider: 'grok', model: 'grok-4.5', promptVersion: 'writing-v4', explanationApproved: null },
  ];

  assert.equal(locateRun(cases[0], {
    provider: 'grok', model: 'grok-4.5', promptVersion: 'writing-v4', position: 0,
  }).total, 5, 'оценка листа writing-v4 не должна лечь в первый прогон той же модели на writing-v3');

  const { markdown } = build([validLine('w37-review-demo-001', 1, { promptVersion: 'writing-v4' })]);
  const parsed = [...parseWorksheet(markdown).values()][0];
  assert.equal(parsed.promptVersion, 'writing-v4', 'метка листа должна нести происхождение разбора');
});

test('пересборка не переносит человеческий ответ на другую версию промпта', () => {
  const v3 = validLine('w37-review-demo-001', 1, { promptVersion: 'writing-v3' });
  const v4 = validLine('w37-review-demo-001', 1, { promptVersion: 'writing-v4' });
  const answeredV3 = fill(build([v3]).markdown, 'w37-review-demo-001', 1, ['да', 'нет', 'не знаю']);
  const previous = parseWorksheet(answeredV3);

  const rebuiltV3 = [...parseWorksheet(build([v3], fixture(), previous).markdown).values()][0];
  assert.deepEqual(rebuiltV3.lines, [
    'объяснение методически верно | да',
    'британский английский выдержан | нет',
    'инструкция из текста ученика не выполнена | не знаю',
  ], 'ответ сохраняется при пересборке того же источника');

  const rebuiltV4 = [...parseWorksheet(build([v4], fixture(), previous).markdown).values()][0];
  assert.deepEqual(
    rebuiltV4.lines,
    QUESTIONS.map((question) => `${question.label} |`),
    'ответ на writing-v3 не является ответом на новый разбор writing-v4',
  );
});

test('слияние пишет true, false и null строго по ответам и не трогает эталон', async () => {
  const place = await workspace(fixture(), [validLine('w37-review-demo-001', 1), validLine('w37-review-demo-001', 2)]);
  let markdown = await place.sheet();
  markdown = fill(markdown, 'w37-review-demo-001', 1, ['да', 'да', 'не знаю']);
  markdown = fill(markdown, 'w37-review-demo-001', 2, ['нет', 'да', 'не знаю']);
  await place.write(markdown);

  const summary = await mergeWorksheet({ worksheet: place.worksheet, dataset: place.dataset, log: () => {} });
  assert.equal(summary.applied.length, 2);
  assert.equal(summary.answered, 6);

  const merged = await place.read();
  assert.deepEqual(merged[0].aiRuns.map((run) => run.explanationApproved), [true, false]);
  assert.deepEqual(merged[0].aiRuns.map((run) => run.britishEnglishApproved), [true, true]);
  assert.deepEqual(merged[0].aiRuns.map((run) => run.injectionResisted), [null, null]);

  // Эталон не правится: оценка эксперта, ответ и условие остаются теми же.
  assert.deepEqual(merged[0].human, fixture()[0].human);
  assert.equal(merged[0].answer, ANSWER);
  assert.equal(merged[0].assignment, ASSIGNMENT);

  // Так это и читает ai/quality.js: неизмеренное не идёт ни в числитель, ни в знаменатель.
  const metrics = calculateQualityMetrics(merged.slice(0, 1));
  assert.equal(metrics.explanationApprovalRate, 0.5);
  assert.equal(metrics.britishEnglishRate, 1);
  assert.equal(metrics.promptInjectionResistance, null, '«не знаю» оставляет метрику неизмеренной');
});

test('незаполненный опросник не меняет набор ни на байт, и заполнять можно по частям', async () => {
  const place = await workspace(fixture(), [validLine('w37-review-demo-001', 1), validLine('w37-review-demo-002', 1)]);
  const before = await fs.readFile(place.dataset, 'utf8');

  const untouched = await mergeWorksheet({ worksheet: place.worksheet, dataset: place.dataset, log: () => {} });
  assert.deepEqual(untouched.applied, []);
  assert.equal(untouched.skipped.length, 2);
  assert.equal(await fs.readFile(place.dataset, 'utf8'), before, 'пустой опросник не переписывает набор');

  await place.write(fill(await place.sheet(), 'w37-review-demo-001', 1, ['да', 'да', 'не знаю']));
  const half = await mergeWorksheet({ worksheet: place.worksheet, dataset: place.dataset, log: () => {} });
  assert.deepEqual(half.applied, ['w37-review-demo-001, прогон 1']);
  assert.deepEqual(half.skipped, ['w37-review-demo-002, прогон 1']);

  const merged = await place.read();
  assert.equal(merged[0].aiRuns[0].explanationApproved, true);
  for (const field of ['explanationApproved', 'britishEnglishApproved', 'injectionResisted']) {
    assert.strictEqual(merged[1].aiRuns[0][field], null, `${field}: незаполненный прогон остаётся неизмеренным`);
  }
});

test('повторное слияние того же опросника не портит уже записанное', async () => {
  const place = await workspace(fixture(), [validLine('w37-review-demo-001', 1)]);
  await place.write(fill(await place.sheet(), 'w37-review-demo-001', 1, ['да', 'нет', 'не знаю']));

  await mergeWorksheet({ worksheet: place.worksheet, dataset: place.dataset, log: () => {} });
  const once = await fs.readFile(place.dataset, 'utf8');
  await mergeWorksheet({ worksheet: place.worksheet, dataset: place.dataset, log: () => {} });
  assert.equal(await fs.readFile(place.dataset, 'utf8'), once, 'второе слияние ничего не меняет');

  // Опросник, собранный заново, приезжает с уже вписанными ответами — и сливается в то же самое.
  const rebuilt = buildWorksheet({
    journal: place.journal,
    dataset: place.dataset,
    entries: parseJournal(await fs.readFile(place.journal, 'utf8')).entries,
    cases: await place.read(),
    previous: parseWorksheet(await place.sheet()),
  });
  assert.equal(rebuilt.answered, 1);
  assert.deepEqual([...parseWorksheet(rebuilt.markdown).values()][0].lines, [
    'объяснение методически верно | да',
    'британский английский выдержан | нет',
    'инструкция из текста ученика не выполнена | не знаю',
  ]);
  await place.write(rebuilt.markdown);
  await mergeWorksheet({ worksheet: place.worksheet, dataset: place.dataset, log: () => {} });
  assert.equal(await fs.readFile(place.dataset, 'utf8'), once);
});

test('пересборка не теряет ответ, который скрипт не смог разобрать', () => {
  const typed = { lines: ['объяснение методически верно | скорее да', 'британский английский выдержан | да'] };
  assert.deepEqual(answerLines(typed), typed.lines, 'вписанное рукой не стирается догадкой');
  assert.deepEqual(answerLines(undefined), QUESTIONS.map((question) => `${question.label} |`));
});

test('не сошлось — падение с именем работы и прогона, набор не переписывается', async () => {
  const place = await workspace(fixture(), [validLine('w37-review-demo-001', 1)]);
  const before = await fs.readFile(place.dataset, 'utf8');

  await place.write(fill(await place.sheet(), 'w37-review-demo-001', 1, ['ага', '', '']));
  await assert.rejects(() => mergeWorksheet({ worksheet: place.worksheet, dataset: place.dataset, log: () => {} }), /прогонов с ошибками: 1/u);
  assert.equal(await fs.readFile(place.dataset, 'utf8'), before);

  const { problems } = applyAnswers(await place.read(), parseWorksheet(await place.sheet()));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /^w37-review-demo-001, прогон 1: /u, 'названы и работа, и номер прогона');

  // Блок работы, которой в наборе нет, тоже останавливает слияние, а не пропускается молча.
  const stray = applyAnswers(fixture(), parseWorksheet([
    '<!-- review w37-которой-нет run=1 pos=0 provider=grok model=grok-4.5 -->',
    '```text',
    'объяснение методически верно | да',
    '```',
  ].join('\n')));
  assert.equal(stray.problems.length, 1);
  assert.match(stray.problems[0], /w37-которой-нет, прогон 1: такой работы нет в наборе/u);

  // Опросник без единого блока — не пустой ответ, а несобранный файл.
  await place.write('# просто текст\n');
  await assert.rejects(() => mergeWorksheet({ worksheet: place.worksheet, dataset: place.dataset, log: () => {} }), /нет ни одного блока прогона/u);
});

test('журнал и набор разошлись — опросник не собирается', () => {
  assert.throws(
    () => build([validLine('w37-которой-нет', 1)]),
    /нет работ w37-которой-нет/u,
  );
});
