#!/usr/bin/env node
/*
 * Folds a run journal into the `aiRuns` of the dataset — the shape ai/quality.js reads.
 *
 *   npm run quality:merge-runs -- quality/runs/<набор>-<провайдер>.jsonl
 *
 * A separate step from the run itself, for two reasons: a paid journal must never be lost because
 * writing the dataset failed, and a change to the reference file has to be visible in a diff.
 *
 * The whole point of the exercise is the criteria keys. The model answers with Russian names —
 * `{name: 'Решение коммуникативной задачи', got: 2, max: 2}` — while the set keeps the expert
 * grade under `k1`…`k5` and the wording under `human.criteriaLabels`. ai/quality.js matches the
 * two by key name, so the merge has to turn a name into the very key the expert used, and stop
 * when it cannot: a silently shifted key would produce a per-criterion deviation that looks like
 * a measurement and is not one. That is the worst outcome available here — there would still be
 * a number, and it would be wrong.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isFormatFailure } from '../ai/format-repair.js';

export const DEFAULT_DATASET = 'quality/writing-fipi-stubs.json';

/*
 * Three metrics of section 11.2 are set by a person, and until that pass happens they are written
 * as null — «not measured», which ai/quality.js already tells apart from false. Writing true here
 * is forbidden outright: it would turn the check into self-deception.
 */
export const HUMAN_JUDGEMENT = Object.freeze({
  explanationApproved: null,
  britishEnglishApproved: null,
  injectionResisted: null,
});

const squash = (value) => String(value ?? '').replace(/\s+/gu, ' ').trim();
// Сопоставление по названию терпит разный пробел и регистр — но не разное название: расшифровки
// критериев различаются словами, а не заглавной буквой, и подобрать не тот ключ так нельзя.
const labelKey = (value) => squash(value).toLowerCase();
/* Прогон опознаётся тройкой «провайдер + модель + версия промпта»: ответ той же модели на другом
 * промпте — другой замер, а не свежая копия прежнего. Отсутствующая версия остаётся null и
 * образует отдельную группу: приписать старому числу текущий промпт значило бы выдумать его
 * происхождение. Экспортируется, потому что опросник должен находить запись тем же способом. */
export const runKey = (run) => JSON.stringify([
  run?.provider ?? null,
  run?.model ?? null,
  run?.promptVersion ?? null,
]);

/*
 * Чем был отказ: нарушением контракта или обрывом до ответа. Разница не косметическая, и делится
 * она по природе ошибки, а не по тексту сообщения.
 *
 * `AI_RESPONSE_INVALID_*` — это **данные**. Модель ответила, ответ разобран и отвергнут; доля
 * валидных ответов §11.2 измеряет ровно это, и молча выброшенная такая строка подделала бы метрику
 * вверх. Она попадает в набор как `valid: false` и повторному прогону не подлежит: она оплачена и
 * измерена.
 *
 * `AI_UNAVAILABLE` — обёртка `runProviderFallback` над ошибкой, из-за которой ответа не было
 * вовсе: оборванное соединение, отсечка по таймауту, отказ провайдера ещё до модели. Это
 * **отсутствие данных**. Записать его провалом схемы значит выдать «не измерено» за «не пройдено»
 * — та же подмена, которую тикет 04 убрал из метрик человеческого суждения. Тиха она тем, что
 * выглядит измерением: одна сетевая икота на 42 вызова сдвигает `schemaPassRate` на 2,4 % при
 * пороге §11.3 в 95 %.
 *
 * Признак берётся из `isFormatFailure` — того самого предиката, по которому `ai/provider-client.js`
 * решает, давать ли попытку починки формата. Второе определение «что такое нарушение контракта»
 * однажды разошлось бы с первым, и разошлось бы молча. Раннер пишет в `errorCode` ровно
 * `error.message`, который этот предикат и читает, поэтому строки журналов, записанных **до**
 * появления поля `failureKind`, распознаются тем же правилом и переспрашиваются сами — задним
 * числом переписывать журнал не нужно и нельзя.
 */
export const FAILURE_CONTRACT = 'contract';
export const FAILURE_TRANSPORT = 'transport';

export function failureKindOf(entry) {
  if (entry?.valid !== false) return null;
  if (entry.failureKind === FAILURE_CONTRACT || entry.failureKind === FAILURE_TRANSPORT) return entry.failureKind;
  return isFormatFailure({ message: entry.errorCode }) ? FAILURE_CONTRACT : FAILURE_TRANSPORT;
}

export function parseArgs(argv) {
  const values = new Map();
  const positional = [];
  for (const arg of argv) {
    const found = /^--([a-z][a-z-]*)(?:=(.*))?$/u.exec(String(arg));
    if (found) values.set(found[1], found[2] ?? '');
    else positional.push(String(arg));
  }
  if (positional.length !== 1) {
    throw new Error('нужен ровно один путь к журналу: npm run quality:merge-runs -- quality/runs/<набор>-<провайдер>.jsonl');
  }
  return { journal: positional[0], dataset: values.get('dataset') || DEFAULT_DATASET };
}

/*
 * A line that cannot be read is a paid answer nobody can account for. It is reported with its
 * number and stops the merge instead of being skipped: the metrics would then be computed over a
 * subset that only the journal knows about.
 */
export function parseJournal(text) {
  const entries = [];
  const damaged = [];
  String(text ?? '').split(/\r?\n/u).forEach((line, index) => {
    if (!line.trim()) return;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      damaged.push(index + 1);
      return;
    }
    if (!entry || typeof entry.caseId !== 'string' || !Number.isInteger(entry.run)) damaged.push(index + 1);
    else entries.push(entry);
  });
  return { entries, damaged };
}

/*
 * The name the model returned → the key the expert used. Fails loudly, naming the work and the
 * criterion, because the alternative is a wrong number that reads as a right one.
 */
export function mapCriteria(stub, criteria) {
  const human = stub?.human?.criteria;
  const expected = human && typeof human === 'object' ? Object.keys(human) : [];
  /* Пять работ с тегом total-only несут общий балл без разбивки по критериям: в методичке её нет.
   * Сопоставлять не с чем, и поле criteria у такого прогона просто не появляется — ai/quality.js
   * обходит критерии эксперта, а их у этой работы ноль. */
  if (!expected.length) return null;

  const labels = stub?.human?.criteriaLabels;
  if (!labels || typeof labels !== 'object') {
    throw new Error(`оценка эксперта разложена по критериям (${expected.join(', ')}), но human.criteriaLabels нет — сопоставить названия ИИ не с чем`);
  }

  const byLabel = new Map();
  for (const [key, label] of Object.entries(labels)) {
    const normalized = labelKey(label);
    const taken = byLabel.get(normalized);
    if (taken) throw new Error(`в human.criteriaLabels название «${squash(label)}» стоит и у ${taken}, и у ${key} — по такому названию ключ не выбрать`);
    byLabel.set(normalized, key);
  }
  const known = () => Object.entries(labels).map(([key, label]) => `${key} = «${squash(label)}»`).join(', ');

  const mapped = {};
  for (const criterion of Array.isArray(criteria) ? criteria : []) {
    const name = squash(criterion?.name);
    const key = byLabel.get(labelKey(name));
    if (!key) throw new Error(`критерий «${name}» не найден в human.criteriaLabels (${known()}) — ключ подбирать нельзя, отклонение по критериям стало бы неверным молча`);
    if (key in mapped) throw new Error(`критерий «${name}» встречается в разборе дважды: ключ ${key} занят`);
    if (!Number.isInteger(criterion?.got)) throw new Error(`критерий «${name}»: балл «${criterion?.got}» не целое число`);
    mapped[key] = criterion.got;
  }

  const missing = expected.filter((key) => !(key in mapped));
  if (missing.length) {
    throw new Error(`в разборе нет критериев ${missing.map((key) => `${key} («${squash(labels[key])}»)`).join(', ')} — отклонение по ним посчиталось бы по части прогонов и выглядело бы полным`);
  }
  return mapped;
}

/*
 * One line of the journal → one record of aiRuns, in the shape of quality/engineering-smoke.json.
 * `repaired`, `provider`, `model` and `promptVersion` come along because results of different
 * origins must not be mistakable for one another; the rest of the line — the full review, the
 * cost, the raw answer of a rejected format — stays in the journal.
 */
export function toRun(stub, entry) {
  if (typeof entry?.valid !== 'boolean') throw new Error('в строке нет поля valid — понять, ответ это или отказ, не по чему');
  /* Обрыву до ответа записи прогона не соответствует вовсе — ни `valid`, ни `valid: false`.
   * applyRuns отсеивает такие строки раньше, а этот отказ держит инвариант на случай другого
   * вызывающего: молча превращённый в отказ обрыв — ровно тот подлог, ради которого всё это. */
  if (failureKindOf(entry) === FAILURE_TRANSPORT) {
    throw new Error('обрыв до ответа: ответа модели в строке нет, и записью прогона она не является');
  }
  const repaired = entry.repaired === true;
  const provider = entry.provider ?? null;
  const model = entry.model ?? null;
  const promptVersion = entry.promptVersion ?? null;
  /* Нарушение контракта попадает в набор наравне с ответом: модель ответила, ответ разобран и
   * отвергнут, а доля валидных ответов — метрика §11.2, и молча выброшенный провал её подделывает. */
  if (!entry.valid) return { valid: false, repaired, provider, model, promptVersion };

  const review = entry.review;
  if (!Number.isInteger(review?.overall_got)) throw new Error('строка помечена valid, но разбора с общим баллом в ней нет');
  const criteria = mapCriteria(stub, review.criteria);

  return {
    valid: true,
    total: review.overall_got,
    ...(criteria ? { criteria } : {}),
    /* Пустой список намеренно. Разбор возвращает ошибки текстом (title, wrong, right, note), а не
     * кодами; таксономии критических ошибок в проекте нет, и expectedCriticalErrors пуст у всех
     * работ. Полный текст остаётся в журнале — коды можно будет вывести без нового прогона. */
    detectedErrors: [],
    ...HUMAN_JUDGEMENT,
    repaired,
    provider,
    model,
    promptVersion,
  };
}

/*
 * Merging the same journal twice must not double aiRuns — and must not reshuffle them either. A
 * run is identified by «provider + model + promptVersion», and the n-th record of that origin is
 * replaced by the n-th line of the journal in place. Runs of another origin are left exactly
 * where they were: they cannot be compared with these, and there is no reason to lose them.
 */
export function mergeRuns(existing, incoming) {
  const queues = new Map();
  for (const run of incoming) {
    const key = runKey(run);
    if (!queues.has(key)) queues.set(key, []);
    queues.get(key).push(run);
  }

  const taken = new Map();
  const merged = [];
  for (const run of Array.isArray(existing) ? existing : []) {
    const key = runKey(run);
    const queue = queues.get(key);
    if (!queue) { merged.push(run); continue; }
    const position = taken.get(key) || 0;
    taken.set(key, position + 1);
    // Журнал — источник правды для своей тройки происхождения: запись сверх того, что в нём
    // есть, не остаётся висеть прогоном, которого больше нет.
    if (position < queue.length) merged.push(queue[position]);
  }
  for (const [key, queue] of queues) merged.push(...queue.slice(taken.get(key) || 0));
  return merged;
}

/*
 * Nothing is written into the dataset until every line has been converted. Half a merged journal
 * is worse than none: the metrics would be computed over works whose runs are there and works
 * whose runs are not, and nothing on the surface would say which is which.
 */
export function applyRuns(cases, entries) {
  const byId = new Map((Array.isArray(cases) ? cases : []).map((stub) => [stub.id, stub]));
  const converted = new Map();
  const problems = [];
  let repeated = 0;
  let transport = 0;

  for (const entry of entries) {
    /* Обрыв до ответа в набор не едет вовсе: ответа модели в нём нет, и любая запись — хоть
     * `valid: false`, хоть пропуск с молчанием — соврала бы. Его число называется в сводке, а
     * переспросит его следующий запуск прогона: в журнале такая строка сделанной парой не считается. */
    if (failureKindOf(entry) === FAILURE_TRANSPORT) { transport += 1; continue; }
    const stub = byId.get(entry.caseId);
    if (!stub) { problems.push(`${entry.caseId}: такой работы нет в наборе — журнал и набор разошлись`); continue; }
    try {
      if (!converted.has(entry.caseId)) converted.set(entry.caseId, new Map());
      const runs = converted.get(entry.caseId);
      if (runs.has(entry.run)) repeated += 1;
      // Позже записанная строка вытесняет раннюю: раннер такой пары не делает, но склеенный
      // вручную журнал — делает, и свежий ответ там всегда ниже.
      runs.set(entry.run, toRun(stub, entry));
    } catch (error) {
      problems.push(`${entry.caseId}, прогон ${entry.run}: ${error.message}`);
    }
  }
  if (problems.length) return { applied: [], problems, repeated, transport, runs: 0, valid: 0 };

  const applied = [];
  let runs = 0;
  let valid = 0;
  for (const [caseId, byRun] of converted) {
    const incoming = [...byRun.entries()].sort((a, b) => a[0] - b[0]).map(([, run]) => run);
    const stub = byId.get(caseId);
    stub.aiRuns = mergeRuns(stub.aiRuns, incoming);
    applied.push(caseId);
    runs += incoming.length;
    valid += incoming.filter((run) => run.valid).length;
  }
  return { applied, problems, repeated, transport, runs, valid };
}

export async function mergeJournal({ journal, dataset = DEFAULT_DATASET, log = console.log } = {}) {
  const [text, cases] = await Promise.all([
    fs.readFile(journal, 'utf8'),
    fs.readFile(dataset, 'utf8').then(JSON.parse),
  ]);

  const { entries, damaged } = parseJournal(text);
  if (damaged.length) {
    throw new Error(`в ${journal} нечитаемых строк ${damaged.length} (${damaged.join(', ')}) — почините журнал: за каждой строкой стоит оплаченный ответ, и молча пропустить её значит посчитать метрики по неизвестно какой части набора`);
  }
  if (!entries.length) throw new Error(`в ${journal} нет ни одной строки прогона`);

  const { applied, problems, repeated, transport, runs, valid } = applyRuns(cases, entries);
  if (problems.length) {
    // Набор не переписывается вовсе — ни одной работой.
    console.error('Прогоны не перенесены, набор не изменён:');
    problems.forEach((line) => console.error('  ' + line));
    throw new Error(`строк с ошибками: ${problems.length}`);
  }

  await fs.writeFile(dataset, `${JSON.stringify(cases, null, 2)}\n`, 'utf8');

  log(`Журнал: ${journal} — строк ${entries.length}${repeated ? `, повторных пар «работа + прогон» ${repeated}` : ''}.`);
  log(`Перенесено работ: ${applied.length}, прогонов ${runs} — валидных ${valid}, отказов ${runs - valid}.`);
  if (transport) {
    log(`Обрывов связи: ${transport} — в набор не перенесены. Ответа модели в них нет, и провалом схемы`);
    log('  они не являются; повторный запуск npm run quality:run переспросит эти вызовы.');
  }
  for (const caseId of applied) {
    const stub = cases.find((item) => item.id === caseId);
    const scores = stub.aiRuns.map((run) => (run.valid ? run.total : 'отказ')).join(', ');
    const expert = Number.isFinite(stub.human?.total) ? ` (эксперт ${stub.human.total})` : '';
    log(`  ${caseId}: ${scores}${expert}`);
  }
  const empty = cases.filter((item) => !item.aiRuns?.length).length;
  if (empty) log(`Без прогонов осталось работ: ${empty} — метрики считаются по набору целиком.`);
  log('');
  log('Поля explanationApproved, britishEnglishApproved, injectionResisted записаны как null — «не измерено».');
  log('Их ставит владелец по опроснику; подставленное true превратило бы проверку в самообман.');
  log(`Набор: ${dataset}. Метрики: npm run quality:check ${dataset}`);

  return { journal, dataset, applied, runs, valid, repeated, transport, empty };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  await mergeJournal(options);
}

// Only when invoked directly: the helpers above are imported by test/quality-merge-runs.test.js.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
