import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';

/*
 * The runner is measured here without a network, without a key and without a database. The values
 * below are stub credentials for a stub endpoint: globalThis.fetch is replaced in every test that
 * makes a call, and DATABASE_URL is removed on purpose — a run must never need one, because the
 * owner pays for it and no student's budget may be touched.
 */
process.env.XAI_API_KEY = 'stub-xai';
process.env.XAI_API_URL = 'https://xai.stub.test/v1/chat/completions';
process.env.XAI_MODEL = 'stub-grok';
process.env.GROQ_API_KEY = 'stub-groq';
process.env.GROQ_API_URL = 'https://groq.stub.test/v1/chat/completions';
process.env.GROQ_MODEL = 'stub-llama';
delete process.env.DATABASE_URL;

const runner = await import('../scripts/ai-quality-run.js');
const { countWords, getWritingRules } = await import('../ai/writing.js');
const { sanitizeStudentText } = await import('../validation/student-text.js');
const { AI_OPERATIONS } = await import('../ai/operations.js');
const { createProviderClient } = await import('../ai/provider-client.js');

const repositoryRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/* Two works: one ready to run, one whose condition has not been parsed yet. The set is refilled
 * over time and the next batch arrives without an assignment, so that case is the normal one. */
const READY_ANSWER = 'Hi Mike! Thanks for your <b>letter</b>. My favourite device is a laptop​ and I use it for studying every single day. Could you tell me where the camp was, how long you stayed and what you liked most about it? Write back soon!';

function sampleCases() {
  return [
    {
      id: 'w37-stub-ready',
      operation: 'writing_37',
      assignment: 'raw condition text',
      assignmentData: { from: 'Mike@mail.uk', stimulus: 'Subject: Mobile devices. What device is your favourite and why?', questionsTopic: 'the summer camp' },
      answer: READY_ANSWER,
      human: { total: 4, max: 6, criteria: { k1: 2, k2: 1, k3: 1 } },
      aiRuns: [],
    },
    {
      id: 'w38-stub-blank',
      operation: 'writing_38',
      assignment: 'raw condition text',
      assignmentData: null,
      answer: 'A project about sport in our school and the numbers we have collected from the survey.',
      human: { total: 8, max: 14, criteria: {} },
      aiRuns: [],
    },
  ];
}

async function workspace(cases = sampleCases()) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-quality-run-'));
  const dataset = path.join(directory, 'dataset.json');
  await fs.writeFile(dataset, JSON.stringify(cases, null, 2), 'utf8');
  return { directory, dataset, out: path.join(directory, 'runs', 'journal.jsonl') };
}

async function journalLines(file) {
  const text = await fs.readFile(file, 'utf8').catch(() => '');
  return text.split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line));
}

/* The prompt carries the normalised answer, so a stub provider can answer any work correctly by
 * reading it back — exactly what a real model has to do to satisfy parseAndValidateWritingReview. */
function answerFromPrompt(user) {
  const marker = 'Ответ ученика: ';
  // Просьба о починке формата приписывается к тому же промпту, поэтому берётся ровно одна строка.
  return JSON.parse(user.slice(user.indexOf(marker) + marker.length).split('\n')[0]);
}

function validReview(user) {
  const taskType = /Тип задания: (\w+)\./u.exec(user)[1];
  const rules = getWritingRules(taskType);
  const words = countWords(answerFromPrompt(user));
  const criteria = rules.criteria.map(([name, max]) => ({ name, got: 1, max }));
  return JSON.stringify({
    words,
    in_range: words >= rules.minWords && words <= rules.maxWords,
    overall_got: criteria.length,
    overall_max: rules.overallMax,
    verdict: 'В целом неплохо',
    sub: 'Следите за артиклями',
    criteria,
    errors: [{ title: 'Артикль', wrong: 'a laptop', right: 'the laptop', kind: 'err', note: 'Здесь нужен определённый артикль.' }],
  });
}

/* Records every outbound call, answers it from `reply`, and fails loudly if two calls are ever in
 * flight at once: section «Темп» requires a strictly sequential run. */
function stubFetch(reply) {
  const calls = [];
  let inFlight = 0;
  globalThis.fetch = async (url, init) => {
    inFlight += 1;
    assert.equal(inFlight, 1, 'вызовы провайдера должны идти последовательно, без параллельности');
    const body = JSON.parse(init.body);
    const call = { url, user: body.messages.at(-1).content, model: body.model };
    calls.push(call);
    const content = reply(call, calls.length);
    inFlight -= 1;
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content } }], usage: { prompt_tokens: 100, completion_tokens: 20 } }),
    };
  };
  return calls;
}

test('ключи разбираются, а провайдер обязателен', () => {
  const parsed = runner.parseArgs(['--provider=grok']);
  assert.equal(parsed.provider, 'grok');
  assert.equal(parsed.runs, runner.DEFAULT_RUNS);
  assert.equal(parsed.delayMs, runner.DEFAULT_DELAY_MS);
  assert.equal(parsed.dataset, runner.DEFAULT_DATASET);
  assert.equal(parsed.only, null);
  /* Имя журнала выводится из набора и провайдера, а не из времени запуска: повторный запуск той
   * же командой обязан попасть в тот же файл и дочитать его, а не оплатить второй проход. */
  assert.equal(parsed.out, runner.defaultJournal(runner.DEFAULT_DATASET, 'grok'));

  const full = runner.parseArgs(['--provider=groq', '--runs=3', '--delay=0', '--dataset=a/b.json', '--out=c.jsonl', '--only=w37-x']);
  assert.deepEqual(full, { provider: 'groq', runs: 3, delayMs: 0, dataset: 'a/b.json', out: 'c.jsonl', only: 'w37-x' });

  assert.throws(() => runner.parseArgs([]), /--provider/u);
  assert.throws(() => runner.parseArgs(['--provider=grok', '--runs=0']), /--runs/u);
  assert.throws(() => runner.parseArgs(['--provider=grok', 'runs=2']), /не понимаю аргумент/u);
});

test('--model называет модель прогона: она уходит в тело запроса, в журнал и в имя журнала', async () => {
  const parsed = runner.parseArgs(['--provider=grok', '--model=grok-4.3']);
  assert.equal(parsed.model, 'grok-4.3');
  assert.equal(parsed.out, runner.defaultJournal(runner.DEFAULT_DATASET, 'grok', 'grok-4.3'));
  assert.notEqual(parsed.out, runner.defaultJournal(runner.DEFAULT_DATASET, 'grok'));
  /* Имя модели становится именем файла, поэтому проверяется до того, как им станет. */
  assert.throws(() => runner.parseArgs(['--provider=grok', '--model=../журнал']), /--model/u);

  const { dataset, out } = await workspace();
  const calls = stubFetch((call) => validReview(call.user));

  const summary = await runner.runQuality({ provider: 'grok', model: 'grok-4.3', runs: 1, delayMs: 0, dataset, out, log: () => {} });

  assert.deepEqual(calls.map((call) => call.model), ['grok-4.3'], 'модель ключа доходит до тела запроса, а не остаётся в аргументах');
  assert.equal(summary.model, 'grok-4.3');
  const [line] = await journalLines(out);
  assert.equal(line.model, 'grok-4.3');
  assert.equal(line.provider, 'grok');
});

test('прогоны двух моделей расходятся по журналам и не засчитывают чужие ответы себе', async () => {
  const { directory, dataset } = await workspace();
  const journalOf = (model) => path.join(directory, 'runs', path.basename(runner.defaultJournal(dataset, 'grok', model)));
  assert.notEqual(journalOf('grok-4.3'), journalOf('grok-4.20-non-reasoning'));

  let calls = stubFetch((call) => validReview(call.user));
  await runner.runQuality({ provider: 'grok', model: 'grok-4.3', runs: 2, delayMs: 0, dataset, out: journalOf('grok-4.3'), log: () => {} });
  assert.equal(calls.length, 2);

  calls = stubFetch((call) => validReview(call.user));
  const second = await runner.runQuality({
    provider: 'grok', model: 'grok-4.20-non-reasoning', runs: 2, delayMs: 0, dataset, out: journalOf('grok-4.20-non-reasoning'), log: () => {},
  });

  /* Главное этого теста: второй прогон оплачен и состоялся. Возобновление опознаёт пару «работа +
   * номер прогона», модель в неё не входит — общий файл заставил бы раннер отчитаться, что всё уже
   * сделано, и вторая модель осталась бы неопрошенной. */
  assert.equal(calls.length, 2, 'вторая модель спрашивается заново, а не считается уже прогнанной');
  assert.equal(second.resumedFrom, 0);
  assert.equal(second.calls, 2);
  const lines = await journalLines(journalOf('grok-4.20-non-reasoning'));
  assert.deepEqual([...new Set(lines.map((line) => line.model))], ['grok-4.20-non-reasoning']);

  // А если модели всё-таки сведены в один файл, прогон отказывается до первого платного вызова.
  calls = stubFetch((call) => validReview(call.user));
  await assert.rejects(
    () => runner.runQuality({ provider: 'grok', model: 'grok-4.3', runs: 2, delayMs: 0, dataset, out: journalOf('grok-4.20-non-reasoning'), log: () => {} }),
    /grok-4.20-non-reasoning/u,
  );
  assert.equal(calls.length, 0, 'чужой журнал распознан до вызовов, а не после оплаты');
});

test('отказ несёт причину и применённый бюджет: таймаут читается из записи, ключ в неё не попадает', async () => {
  const { dataset, out } = await workspace();
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(url);
    // Ровно так обрывается вызов, когда AbortController срабатывает по бюджету операции.
    throw new DOMException('This operation was aborted', 'AbortError');
  };

  const summary = await runner.runQuality({ provider: 'grok', runs: 1, delayMs: 0, dataset, out, log: () => {} });

  assert.equal(urls.length, 1);
  assert.equal(summary.invalid, 1);
  const [line] = await journalLines(out);
  assert.equal(line.valid, false);
  assert.equal(line.errorCode, 'AI_UNAVAILABLE', 'обёртка остаётся кодом отказа');
  /* …а под ней теперь видно, что произошло: отсечка по таймауту и бюджет, по которому она сработала.
   * До этого поля диагноз ставили сопоставлением durationMs с бюджетом. */
  assert.equal(line.failure.timedOut, true);
  assert.equal(line.failure.timeoutMs, createProviderClient().limitsFor('writing_37').timeoutMs);
  assert.ok(line.failure.timeoutMs <= AI_OPERATIONS.writing_37.timeoutMs);
  assert.equal(line.failure.maxTokens, AI_OPERATIONS.writing_37.maxTokens);
  assert.match(line.failure.cause, /AbortError/u);
  assert.match(line.failure.fallbackReason, /grok/u);
  assert.match(
    runner.formatProgress({ position: 1, total: 1, caseId: 'w37-x', run: 1, entry: line, human: null }),
    /отказ AI_UNAVAILABLE — таймаут/u,
  );

  /* Причина отказа — сообщение и статус, и ничего больше: заголовки запроса несут ключ провайдера,
   * а журнал — файл, который владелец хранит и показывает. */
  const written = await fs.readFile(out, 'utf8');
  assert.ok(!written.includes(process.env.XAI_API_KEY), 'ключ провайдера в журнал не попадает');
  assert.ok(!/authorization/iu.test(written), 'заголовки запроса в журнал не попадают');
});

test('ответ нормализуется ровно так же, как в приложении', () => {
  const stub = sampleCases()[0];
  const normalized = runner.normalizeAnswer(stub);

  assert.equal(normalized, sanitizeStudentText(stub.answer.trim()));
  assert.ok(!normalized.includes('<b>'), 'разметка снимается до промпта');
  assert.ok(!normalized.includes('​'), 'невидимые символы снимаются до промпта');
  /* Именно ради этого нормализация здесь и живёт: parseAndValidateWritingReview сверяет
   * review.words с countWords нормализованной строки, и сырой текст дал бы другое число. */
  assert.notEqual(countWords(stub.answer), countWords(normalized));

  const tooShort = { id: 'x', operation: 'writing_37', answer: 'hi' };
  assert.throws(() => runner.normalizeAnswer(tooShort), /нормализацию/u);
});

test('работа без разобранного условия пропускается с причиной, а не роняет прогон', () => {
  const { work, skipped } = runner.planWork(sampleCases());
  assert.deepEqual(work.map((item) => item.id), ['w37-stub-ready']);
  assert.deepEqual(skipped.map((item) => item.id), ['w38-stub-blank']);
  assert.match(skipped[0].reason, /assignmentData/u);
});

test('эталонный набор разбирается целиком: каждая работа либо в прогоне, либо пропущена с причиной', async () => {
  const cases = JSON.parse(await fs.readFile(path.join(repositoryRoot, 'quality', 'writing-fipi-stubs.json'), 'utf8'));
  const { work, skipped } = runner.planWork(cases);

  // Инварианты, а не счётчики: набор пополняется, и точное число работ меняется по плану.
  assert.equal(work.length + skipped.length, cases.length);
  assert.ok(work.length >= 1, 'хотя бы одна работа набора должна быть готова к прогону');
  assert.equal(work.length, cases.filter((item) => item.assignmentData).length);
  for (const item of skipped) assert.ok(item.reason.length > 0, `${item.id}: причина пропуска обязательна`);
  for (const item of work) {
    assert.ok(['writing_37', 'writing_38'].includes(item.input.taskType));
    assert.equal(item.input.answer, sanitizeStudentText(String(item.input.answer).trim()));
  }

  const single = runner.planWork(cases, { only: work[0].id });
  assert.deepEqual(single.work.map((item) => item.id), [work[0].id]);
  assert.throws(() => runner.planWork(cases, { only: 'нет-такой-работы' }), /нет в наборе/u);
});

test('два прогона дают две строки на готовую работу, с полным разбором и расходом', async () => {
  const { dataset, out } = await workspace();
  const calls = stubFetch((call) => validReview(call.user));
  const slept = [];

  const summary = await runner.runQuality({
    provider: 'grok', runs: 2, delayMs: 2000, dataset, out, log: () => {},
    sleep: async (ms) => { slept.push(ms); },
  });

  assert.equal(calls.length, 2, 'одна готовая работа × два прогона');
  assert.ok(calls.every((call) => call.url === process.env.XAI_API_URL), 'закреплённый провайдер — единственный');
  assert.deepEqual(slept, [2000], 'пауза между вызовами есть, но не после последнего');

  const lines = await journalLines(out);
  assert.deepEqual(lines.map((line) => [line.caseId, line.run]), [['w37-stub-ready', 1], ['w37-stub-ready', 2]]);
  for (const line of lines) {
    assert.equal(line.valid, true);
    assert.equal(line.repaired, false);
    assert.equal(line.operation, 'writing_37');
    assert.equal(line.provider, 'grok');
    assert.equal(line.model, 'stub-grok');
    assert.ok(typeof line.startedAt === 'string' && line.startedAt.endsWith('Z'));
    assert.ok(Number.isInteger(line.durationMs));
    assert.equal(line.usage.promptTokens, 100);
    assert.equal(line.usage.completionTokens, 20);
    assert.ok(Number.isInteger(line.usage.estimatedCostMicrousd));
    /* Разбор пишется целиком: таксономию ошибок и проверку формулировок выводят из журнала, а
     * не оплачивают вторым прогоном. */
    assert.equal(line.review.criteria.length, 3);
    assert.deepEqual(Object.keys(line.review.errors[0]).sort(), ['kind', 'note', 'right', 'title', 'wrong']);
    assert.equal(line.review.verdict, 'В целом неплохо');
  }

  assert.equal(summary.calls, 2);
  assert.equal(summary.valid, 2);
  assert.equal(summary.invalid, 0);
  assert.equal(summary.remaining, 0);
  assert.equal(summary.promptTokens, 200);
  assert.equal(summary.completionTokens, 40);
  assert.deepEqual(summary.skipped.map((item) => item.id), ['w38-stub-blank']);
});

test('восстановление формата отмечено полем repaired, а отклонённый ответ сохранён', async () => {
  const { dataset, out } = await workspace();
  const calls = stubFetch((call, index) => (index === 1 ? 'это не JSON' : validReview(call.user)));

  await runner.runQuality({ provider: 'grok', runs: 1, delayMs: 0, dataset, out, log: () => {} });

  assert.equal(calls.length, 2, 'ровно одна попытка восстановления');
  const [line] = await journalLines(out);
  assert.equal(line.valid, true);
  assert.equal(line.repaired, true);
  assert.equal(line.repair.reason, 'AI_RESPONSE_INVALID_JSON');
  assert.equal(line.repair.raw, 'это не JSON');
  assert.equal(line.repair.usage.promptTokens, 100);
});

test('неудачный вызов записывается, а не выбрасывается', async () => {
  const { dataset, out } = await workspace();
  const calls = stubFetch(() => 'не JSON и после починки тоже');

  const summary = await runner.runQuality({ provider: 'grok', runs: 2, delayMs: 0, dataset, out, log: () => {} });

  const lines = await journalLines(out);
  assert.equal(lines.length, 2, 'отказ не отменяет следующий прогон');
  for (const line of lines) {
    assert.equal(line.valid, false);
    assert.equal(line.errorCode, 'AI_RESPONSE_INVALID_JSON');
    assert.equal(line.raw, 'не JSON и после починки тоже');
    assert.equal(line.provider, 'grok');
  }
  assert.equal(summary.invalid, 2);
  assert.equal(summary.valid, 0);
  // Каждый вызов оплачен дважды: сам ответ и попытка починки.
  assert.equal(calls.length, 4);
});

test('повторный запуск с тем же журналом не делает ни одного лишнего вызова', async () => {
  const { dataset, out } = await workspace();
  stubFetch((call) => validReview(call.user));
  await runner.runQuality({ provider: 'grok', runs: 2, delayMs: 0, dataset, out, log: () => {} });
  const before = await journalLines(out);

  const calls = stubFetch((call) => validReview(call.user));
  const summary = await runner.runQuality({ provider: 'grok', runs: 2, delayMs: 0, dataset, out, log: () => {} });

  assert.equal(calls.length, 0, 'прогон платный: за уже полученный ответ второй раз не платят');
  assert.equal(summary.calls, 0);
  assert.equal(summary.planned, 0);
  assert.equal(summary.resumedFrom, 2);
  assert.deepEqual(await journalLines(out), before, 'журнал не изменился');
});

test('прерывание дописывает текущий вызов, а следующий запуск доводит прогон до конца', async () => {
  const { dataset, out } = await workspace();
  // Флаг поднимается ровно так же, как его поднимает обработчик SIGINT: после первого вызова.
  let calls = stubFetch((call) => validReview(call.user));
  const summary = await runner.runQuality({
    provider: 'grok', runs: 3, delayMs: 0, dataset, out, log: () => {},
    stopRequested: () => calls.length >= 1,
  });

  assert.equal(calls.length, 1, 'после запроса на остановку новых вызовов нет');
  assert.equal(summary.interrupted, true);
  assert.equal(summary.calls, 1);
  assert.equal(summary.remaining, 2);
  const afterStop = await journalLines(out);
  assert.equal(afterStop.length, 1, 'вызов, который был в работе, записан');
  assert.equal(afterStop[0].valid, true);

  calls = stubFetch((call) => validReview(call.user));
  const finished = await runner.runQuality({ provider: 'grok', runs: 3, delayMs: 0, dataset, out, log: () => {} });
  assert.equal(calls.length, 2, 'дописываются только недостающие прогоны');
  assert.equal(finished.resumedFrom, 1);
  assert.deepEqual((await journalLines(out)).map((line) => line.run), [1, 2, 3]);
});

test('SIGINT поднимает флаг, а не убивает прогон на середине', () => {
  const target = new EventEmitter();
  const printed = [];
  const stopRequested = runner.createStopFlag(target, ['SIGINT'], (line) => printed.push(line));

  assert.equal(stopRequested(), false);
  target.emit('SIGINT');
  assert.equal(stopRequested(), true);
  target.emit('SIGINT');
  assert.equal(printed.length, 1, 'второй Ctrl+C не печатает то же самое ещё раз');
  assert.match(printed[0], /SIGINT/u);
});

test('незакреплённый или ненастроенный провайдер до вызовов не доходит', async () => {
  const { dataset, out } = await workspace();
  const calls = stubFetch((call) => validReview(call.user));

  await assert.rejects(
    () => runner.runQuality({ provider: 'нет-такого', runs: 1, delayMs: 0, dataset, out, log: () => {} }),
    /XAI_API_KEY/u,
  );
  assert.equal(calls.length, 0);
  assert.equal((await journalLines(out)).length, 0, 'журнал не создаётся ради строки отказа');
});

test('--only прогоняет одну работу, а закрепление провайдера видно в журнале', async () => {
  const cases = sampleCases();
  cases[1].assignmentData = { topic: 'sport at school', rows: [{ label: 'football', percent: 40 }, { label: 'hockey', percent: 35 }, { label: 'chess', percent: 25 }] };
  cases[1].answer = 'This project looks at sport at our school and the survey we have collected shows what students really prefer to do after lessons every week.';
  const { dataset, out } = await workspace(cases);
  const calls = stubFetch((call) => validReview(call.user));

  await runner.runQuality({ provider: 'groq', runs: 1, delayMs: 0, dataset, out, only: 'w38-stub-blank', log: () => {} });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, process.env.GROQ_API_URL, 'закреплён groq — grok не зовётся вовсе');
  const [line] = await journalLines(out);
  assert.equal(line.caseId, 'w38-stub-blank');
  assert.equal(line.operation, 'writing_38');
  assert.equal(line.provider, 'groq');
  assert.equal(line.model, 'stub-llama');
  assert.equal(line.review.criteria.length, 5);
});

test('раннер не притрагивается к базе данных', async () => {
  const source = await fs.readFile(path.join(repositoryRoot, 'scripts', 'ai-quality-run.js'), 'utf8');
  assert.ok(!/from '\.\.\/db\.js'/u.test(source), 'соединение с базой не открывается');
  assert.ok(!/logAiRequest|ai_requests|DATABASE_URL/u.test(source), 'дневной бюджет учеников прогоном не расходуется');
  assert.equal(process.env.DATABASE_URL, undefined, 'тест обязан проходить без DATABASE_URL');
});

test('строка прогресса называет работу, номер прогона, балл и оценку эксперта', () => {
  const entry = { valid: true, repaired: false, review: { overall_got: 4, overall_max: 6 } };
  assert.equal(
    runner.formatProgress({ position: 7, total: 42, caseId: 'w37-fipi-2023-8447', run: 1, entry, human: { total: 0 } }),
    '[7/42] w37-fipi-2023-8447 прогон 1: 4 из 6 (эксперт 0), схема ok',
  );
  assert.match(runner.formatProgress({ position: 1, total: 2, caseId: 'w38-x', run: 2, entry: { ...entry, repaired: true }, human: null }), /схема ok после починки/u);
  assert.equal(
    runner.formatProgress({ position: 2, total: 2, caseId: 'w38-x', run: 2, entry: { valid: false, errorCode: 'AI_RESPONSE_INVALID_SCHEMA' }, human: null }),
    '[2/2] w38-x прогон 2: отказ AI_RESPONSE_INVALID_SCHEMA',
  );
});
