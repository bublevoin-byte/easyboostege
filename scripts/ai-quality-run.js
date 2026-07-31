#!/usr/bin/env node
/*
 * Section 11.2 asks how close the AI grade is to the expert grade. The reference set is collected
 * and the metrics are written, but nobody has ever put these works through the model: `aiRuns` is
 * empty everywhere, and section 11 stands at zero because of one missing step. This is that step.
 *
 *   npm run quality:run -- --provider=grok --runs=2
 *
 * The run is paid for by the owner, one call at a time, so the shape of this script follows from
 * the money rather than from convenience:
 *
 *   - it calls the same chain the students get (ai/provider-client.js), not a copy of it;
 *   - it appends a line to the journal right after each answer, so an interruption on the
 *     nineteenth work does not cost the eighteen before it;
 *   - a repeated run reads the journal first and pays for nothing it already has;
 *   - a failed call is written down too: the share of valid answers is a metric of section 11.2,
 *     and a silently dropped failure forges it;
 *   - the whole review is stored, not a summary. Whatever has to be derived from the answer later
 *     — an error taxonomy, a wording check, a look with human eyes — must come out of the journal
 *     instead of being bought a second time.
 *
 * The database takes no part. The owner runs this, not a student, and its cost must not look like
 * somebody's daily AI budget.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createProviderClient } from '../ai/provider-client.js';
import { estimateCostMicrousd } from '../ai/provider-control.js';
import {
  buildWritingPrompt,
  parseAndValidateWritingReview,
  WRITING_PROMPT_VERSION,
  writingAssignmentSchema,
  writingRequestSchema,
} from '../ai/writing.js';

export const DEFAULT_RUNS = 2;
// Section «Темп»: 12 requests per hour in ai/operations.js protect the service from one student,
// not the provider from us. Two seconds is the owner's pace, and it stays adjustable.
export const DEFAULT_DELAY_MS = 2000;
export const DEFAULT_DATASET = 'quality/writing-fipi-stubs.json';
export const RUNS_DIR = 'quality/runs';
// A rejected answer is evidence, but it is bounded evidence: maxTokens caps a review far below
// this, and a provider that answers with a web page must not blow up a line of the journal.
export const MAX_RAW_CHARS = 20_000;

const WRITING_OPERATIONS = new Set(['writing_37', 'writing_38']);

const key = (caseId, run) => `${caseId}#${run}`;
const truncate = (value) => String(value ?? '').slice(0, MAX_RAW_CHARS);

function readInteger(values, name, fallback, { min, max }) {
  const raw = values.get(name);
  if (raw == null || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`--${name}=${raw}: нужно целое от ${min} до ${max}`);
  }
  return value;
}

/*
 * The journal name is derived, not stamped with the time, and that is the point: a repeated run
 * with the same keys lands on the same file and resumes instead of starting a second paid pass.
 * `--out` is there for the owner who really wants a separate journal.
 */
export function defaultJournal(dataset, provider) {
  const label = path.basename(dataset).replace(/\.json$/u, '');
  return path.posix.join(RUNS_DIR, `${label}-${provider}.jsonl`);
}

export function parseArgs(argv) {
  const values = new Map();
  for (const arg of argv) {
    const found = /^--([a-z][a-z-]*)(?:=(.*))?$/u.exec(String(arg));
    if (!found) throw new Error(`не понимаю аргумент «${arg}»: ключи пишутся как --provider=grok`);
    values.set(found[1], found[2] ?? '');
  }

  const provider = values.get('provider');
  if (!provider) {
    // Section 11.3 compares repeated runs of the same works; a run that quietly changed provider
    // halfway would make the stability figure unreadable. So the provider is named out loud.
    throw new Error('нужен ключ --provider=<имя>: прогон закреплён за одним провайдером, подмена на запасного выключена');
  }

  const dataset = values.get('dataset') || DEFAULT_DATASET;
  return {
    provider,
    dataset,
    runs: readInteger(values, 'runs', DEFAULT_RUNS, { min: 1, max: 20 }),
    delayMs: readInteger(values, 'delay', DEFAULT_DELAY_MS, { min: 0, max: 600_000 }),
    out: values.get('out') || defaultJournal(dataset, provider),
    only: values.get('only') || null,
  };
}

/*
 * The application normalises the answer at the API boundary — `writingRequestSchema` trims it,
 * runs sanitizeStudentText over it and demands at least 20 characters of what survives. Both
 * buildWritingPrompt and parseAndValidateWritingReview then work on that normalised string, and
 * the latter compares `review.words` with countWords of it.
 *
 * A runner that fed the raw dataset text would count words against a different string than the
 * application does, and would collect either a different prompt or false schema rejections — it
 * would measure something students never get. Hence the schema itself is reused rather than its
 * rules restated: there is no second copy that can drift.
 */
export function normalizeAnswer(stub) {
  const parsed = writingRequestSchema.safeParse({
    taskType: stub.operation,
    taskId: stub.id,
    answer: stub.answer,
  });
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => `${issue.path.join('.') || 'answer'}: ${issue.message}`).join('; ');
    throw new Error(`ответ не прошёл нормализацию приложения — ${details}`);
  }
  return parsed.data.answer;
}

/*
 * What can actually be sent, and why the rest cannot. The set grows — the next batch of works
 * arrives without a parsed condition — so an unusable work is skipped with a reason and never
 * stops the run.
 */
export function planWork(cases, { only = null } = {}) {
  const work = [];
  const skipped = [];
  let matched = 0;

  for (const stub of Array.isArray(cases) ? cases : []) {
    if (only && stub?.id !== only) continue;
    matched += 1;
    const id = stub?.id || '(без идентификатора)';

    if (!WRITING_OPERATIONS.has(stub?.operation)) {
      skipped.push({ id, reason: `операция «${stub?.operation}» не письменная — этот раннер прогоняет только задания 37 и 38` });
      continue;
    }
    if (!stub.assignmentData) {
      skipped.push({ id, reason: 'условие не разобрано: assignmentData пусто' });
      continue;
    }

    const assignment = writingAssignmentSchema.safeParse({ taskType: stub.operation, assignment: stub.assignmentData });
    if (!assignment.success) {
      const details = assignment.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
      skipped.push({ id, reason: `условие не прошло writingAssignmentSchema — ${details}` });
      continue;
    }

    try {
      work.push({
        id,
        human: stub.human || null,
        input: { taskType: stub.operation, answer: normalizeAnswer(stub), assignment: assignment.data.assignment },
      });
    } catch (error) {
      skipped.push({ id, reason: error.message });
    }
  }

  if (only && !matched) throw new Error(`работы «${only}» нет в наборе`);
  return { work, skipped };
}

/*
 * What is already paid for. A line that cannot be read is not counted as done — re-asking is
 * cheaper than pretending an unusable line is an answer — but it is reported, because a damaged
 * journal is worth knowing about before the run adds to it.
 */
export async function readJournal(file) {
  let text;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { done: new Set(), damaged: 0 };
    throw error;
  }

  const done = new Set();
  let damaged = 0;
  for (const line of text.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry && typeof entry.caseId === 'string' && Number.isInteger(entry.run)) done.add(key(entry.caseId, entry.run));
      else damaged += 1;
    } catch {
      damaged += 1;
    }
  }
  return { done, damaged };
}

function usageOf(usage, prices) {
  return {
    promptTokens: Number.isInteger(usage?.promptTokens) ? usage.promptTokens : null,
    completionTokens: Number.isInteger(usage?.completionTokens) ? usage.completionTokens : null,
    estimatedCostMicrousd: estimateCostMicrousd(usage, prices),
  };
}

export function formatProgress({ position, total, caseId, run, entry, human }) {
  const head = `[${position}/${total}] ${caseId} прогон ${run}:`;
  if (!entry.valid) return `${head} отказ ${entry.errorCode}`;
  const expert = Number.isFinite(human?.total) ? ` (эксперт ${human.total})` : '';
  const schema = entry.repaired ? 'схема ok после починки' : 'схема ok';
  return `${head} ${entry.review.overall_got} из ${entry.review.overall_max}${expert}, ${schema}`;
}

/*
 * Ctrl+C means «stop after this answer», not «throw away the answer in flight». The handler only
 * raises a flag; the loop finishes the current call, writes its line and leaves with code 0.
 * Exported with an injectable target so the wiring can be tested without sending real signals.
 */
export function createStopFlag(target = process, signals = ['SIGINT', 'SIGTERM'], log = console.log) {
  let requested = false;
  for (const signal of signals) {
    target.on(signal, () => {
      if (requested) return;
      requested = true;
      log(`\n${signal}: заканчиваю текущий вызов и выхожу — уже полученные ответы записаны.`);
    });
  }
  return () => requested;
}

export async function runQuality({
  provider,
  runs = DEFAULT_RUNS,
  delayMs = DEFAULT_DELAY_MS,
  dataset = DEFAULT_DATASET,
  out = null,
  only = null,
  client = null,
  log = console.log,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  stopRequested = () => false,
} = {}) {
  if (!provider) throw new Error('runQuality: не указан провайдер');
  const journalFile = out || defaultJournal(dataset, provider);
  const chain = client || createProviderClient({ provider });

  /*
   * The provider is checked before a single work is read. A run without a key would otherwise
   * write a journal full of identical refusals and call it a measurement. Only the names of the
   * environment variables appear here — never their values.
   */
  const pinned = chain.aiProviders();
  if (!pinned.length) {
    throw new Error(`провайдер «${provider}» не настроен: проверьте XAI_ENABLED и XAI_API_KEY либо GROQ_ENABLED и GROQ_API_KEY в .env`);
  }
  if (pinned.length > 1) throw new Error(`провайдер «${provider}» не закрепил цепочку — подмена на запасного должна быть выключена`);

  const cases = JSON.parse(await fs.readFile(dataset, 'utf8'));
  const { work, skipped } = planWork(cases, { only });

  const { done, damaged } = await readJournal(journalFile);
  await fs.mkdir(path.dirname(journalFile), { recursive: true });

  // Work first, run number second: an interrupted pass leaves whole works finished, and section
  // 11.3 compares repeats within a work.
  const tasks = [];
  for (const item of work) {
    for (let run = 1; run <= runs; run += 1) tasks.push({ item, run });
  }
  const pending = tasks.filter(({ item, run }) => !done.has(key(item.id, run)));

  log(`Набор: ${dataset} — работ к прогону ${work.length}, пропущено ${skipped.length}.`);
  log(`Журнал: ${journalFile} — уже записано ${done.size} пар «работа + прогон»${damaged ? `, нечитаемых строк ${damaged}` : ''}.`);
  log(`Провайдер: ${pinned[0].name}, модель ${pinned[0].model}. Вызовов осталось: ${pending.length}.`);

  const totals = { calls: 0, valid: 0, invalid: 0, promptTokens: 0, completionTokens: 0, estimatedCostMicrousd: 0 };
  let interrupted = false;
  let position = 0;

  for (const { item, run } of pending) {
    if (stopRequested()) { interrupted = true; break; }
    position += 1;

    const startedAt = new Date().toISOString();
    const startedMs = Date.now();
    const head = {
      caseId: item.id,
      run,
      operation: item.input.taskType,
      provider: pinned[0].name,
      model: pinned[0].model,
      promptVersion: WRITING_PROMPT_VERSION,
      startedAt,
    };

    let entry;
    let first = null;
    try {
      const prompt = buildWritingPrompt(item.input);
      first = await chain.askWithFallback(prompt.system, prompt.user, item.input.taskType);
      /* Section 10.3: exactly one corrected attempt, the same as routes/ai.js gives a student.
       * §11.3 counts the schema as passed with that attempt included, so the fact of a repair is
       * a separate field rather than something folded into `valid`. */
      const outcome = await chain.parseWithOneRepair({
        provider: pinned.find((candidate) => candidate.name === first.provider) || pinned[0],
        text: first.text,
        parse: (text) => parseAndValidateWritingReview(text, item.input),
        system: prompt.system,
        user: prompt.user,
        operation: item.input.taskType,
      });

      const accepted = outcome.repair ? outcome.repair.usage : first;
      entry = {
        ...head,
        provider: first.provider,
        model: first.model,
        durationMs: Date.now() - startedMs,
        valid: true,
        repaired: Boolean(outcome.repair),
        review: outcome.value,
        usage: usageOf(accepted, pinned[0]),
      };
      if (outcome.repair) {
        /* A repaired request really did cost two calls; the rejected one is kept whole so the
         * cost stays truthful and the format failure can be studied without paying again. */
        entry.repair = {
          reason: outcome.repair.reason,
          durationMs: outcome.repair.durationMs,
          usage: usageOf(first, pinned[0]),
          raw: truncate(first.text),
        };
      }
    } catch (error) {
      const errorCode = String(error?.message || 'AI_UNAVAILABLE');
      if (errorCode === 'AI_NOT_CONFIGURED') throw error;
      entry = {
        ...head,
        provider: first?.provider || error.provider || error.cause?.provider || pinned[0].name,
        model: first?.model || error.model || error.cause?.model || pinned[0].model,
        durationMs: Date.now() - startedMs,
        valid: false,
        repaired: false,
        errorCode,
        /* The chain does not hand back the text of a failed repair, so this is the first answer:
         * the one the contract check rejected. */
        raw: truncate(first?.text),
        usage: usageOf(first, pinned[0]),
      };
    }

    // Written before anything else happens: the next call must never be able to lose this one.
    await fs.appendFile(journalFile, `${JSON.stringify(entry)}\n`, 'utf8');

    totals.calls += 1;
    totals[entry.valid ? 'valid' : 'invalid'] += 1;
    for (const usage of [entry.usage, entry.repair?.usage]) {
      if (!usage) continue;
      totals.promptTokens += usage.promptTokens || 0;
      totals.completionTokens += usage.completionTokens || 0;
      totals.estimatedCostMicrousd += usage.estimatedCostMicrousd || 0;
    }

    log(formatProgress({ position, total: pending.length, caseId: item.id, run, entry, human: item.human }));

    // Sequential by design: no parallelism, and no pause bought after the last answer.
    if (delayMs > 0 && position < pending.length && !stopRequested()) await sleep(delayMs);
  }

  const summary = {
    journal: journalFile,
    provider: pinned[0].name,
    model: pinned[0].model,
    planned: pending.length,
    calls: totals.calls,
    valid: totals.valid,
    invalid: totals.invalid,
    remaining: pending.length - totals.calls,
    interrupted,
    resumedFrom: done.size,
    skipped,
    promptTokens: totals.promptTokens,
    completionTokens: totals.completionTokens,
    estimatedCostMicrousd: totals.estimatedCostMicrousd,
  };

  log('');
  log(`Вызовов сделано: ${summary.calls} — валидных ${summary.valid}, отказов ${summary.invalid}.`);
  log(`Токены: ${summary.promptTokens} на вход, ${summary.completionTokens} на выход. Оценка стоимости: ${summary.estimatedCostMicrousd} микро-USD.`);
  if (skipped.length) {
    log(`Пропущено работ: ${skipped.length}`);
    for (const item of skipped) log(`  ${item.id}: ${item.reason}`);
  }
  if (summary.remaining > 0) {
    log(`Осталось вызовов: ${summary.remaining}. Повторите ту же команду — журнал дочитается, и заново оплачено ничего не будет.`);
  }
  log(`Журнал: ${journalFile}`);

  return summary;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const stopRequested = createStopFlag();
  await runQuality({ ...options, stopRequested });
}

// Only when invoked directly: the helpers above are imported by test/ai-quality-run.test.js.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
