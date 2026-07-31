#!/usr/bin/env node
/*
 * Печатает состав набора, метрики §11.2 и решение гейта §11.3 по готовым `aiRuns`. К ИИ не
 * обращается вовсе.
 *
 *   npm run quality:check -- quality/writing-fipi-stubs.json [--provider=grok] [--model=grok-4.3]
 *
 * Ключи `--provider` и `--model` выбирают, по каким прогонам считать. После слияния двух журналов
 * (scripts/merge-quality-runs.js) у каждой работы лежат прогоны обеих моделей, и метрики по ним
 * всем сразу смешиваются: среднее отклонение усредняется по обеим моделям, а
 * `stabilityWithinOnePoint` сравнивает ответ одной модели с ответом другой и называет расхождение
 * между разными моделями нестабильностью одной. Поэтому выбранный фильтр печатается в самом
 * отчёте рядом с именем набора — по чему считали, должно быть видно в отчёте, а не только в
 * истории команд, — а набор, в котором прогонов больше чем одной пары «провайдер + модель»,
 * посчитанный без фильтра, печатает громкое предупреждение. Молча смешать — единственный
 * по-настоящему опасный исход: смешанные метрики выглядят как измерение, а решение о продукте
 * принимают по ним.
 *
 * Без ключей поведение прежнее: у набора с прогонами одной модели (и у набора, где полей
 * `provider` и `model` нет вовсе) вывод не меняется ни на символ.
 */
import fs from 'node:fs/promises';
import {
  calculateQualityMetrics,
  evaluateQualityGate,
  filterQualityRuns,
  listRunVariants,
  validateQualityDataset,
} from '../ai/quality.js';

const DEFAULT_DATASET = 'quality/engineering-smoke.json';

/*
 * Значение пишется через знак равенства. Форма `--model grok-4.3` не поддерживается намеренно:
 * `grok-4.3` уехал бы в позиционный аргумент и стал бы именем набора — отчёт бы не о том наборе.
 */
function readOption(args, name) {
  const prefix = `--${name}=`;
  const found = args.filter((arg) => arg === `--${name}` || arg.startsWith(prefix));
  if (!found.length) return null;
  if (found.length > 1) throw new Error(`ключ --${name} указан ${found.length} раз(а): ${found.join(' ')} — по какому значению считать, выбирать нельзя`);
  if (!found[0].startsWith(prefix)) throw new Error(`ключ --${name} пишется со значением через знак равенства: --${name}=<значение>`);
  const value = found[0].slice(prefix.length).trim();
  if (!value) throw new Error(`у ключа --${name} пустое значение: --${name}=<значение>`);
  return value;
}

const variantLabel = ({ provider, model }) => `${provider ?? 'провайдер не указан'} / ${model ?? 'модель не указана'}`;
const variantCommand = (file, { provider, model }) => [
  `npm run quality:check -- ${file}`,
  provider ? ` --provider=${provider}` : '',
  model ? ` --model=${model}` : '',
].join('');

function warnAboutMixing(file, variants, log) {
  log('');
  log('#############################################################################');
  log('###  ВНИМАНИЕ: МЕТРИКИ СЧИТАЮТСЯ ПО ПРОГОНАМ НЕСКОЛЬКИХ МОДЕЛЕЙ СРАЗУ');
  log('#############################################################################');
  log(`### В отбор попали прогоны ${variants.length} пар «провайдер + модель» набора ${file}:`);
  for (const variant of variants) log(`###   - ${variantLabel(variant)}`);
  log('### Метрики ниже посчитаны по ним ВСЕМ СРАЗУ и смешивают разные модели.');
  log('### Ответ одной модели сравнивается с ответом другой.');
  log('### stabilityWithinOnePoint при этом называет расхождение МЕЖДУ моделями');
  log('### нестабильностью одной, а среднее отклонение усредняется по обеим.');
  log('### Такое число выглядит измерением и измерением не является.');
  log('### Считайте по одной модели:');
  for (const variant of variants) log(`###   ${variantCommand(file, variant)}`);
  log('#############################################################################');
  log('');
}

async function main() {
  const args = process.argv.slice(2);
  const release = args.includes('--release');
  const file = args.find((arg) => !arg.startsWith('--')) || DEFAULT_DATASET;
  const provider = readOption(args, 'provider');
  const model = readOption(args, 'model');

  const cases = JSON.parse(await fs.readFile(file, 'utf8'));
  // Проверка состава идёт по набору целиком: пустой `aiRuns` — это дыра в наборе, а не следствие
  // фильтра, и фильтр не должен ни создавать такую жалобу, ни скрывать её.
  const validation = validateQualityDataset(cases, { release });
  if (!validation.ok) {
    console.error(JSON.stringify({ validation }, null, 2));
    process.exitCode = 1;
    return;
  }

  const variants = listRunVariants(cases);
  const selection = filterQualityRuns(cases, { provider, model });
  if (selection.filtered && selection.matched === 0) {
    throw new Error(`под фильтром (провайдер ${provider ?? 'любой'}, модель ${model ?? 'любая'}) в наборе ${file} нет ни одного прогона.`
      + ` Есть прогоны: ${variants.map(variantLabel).join('; ') || '<ни одного>'}.`
      + ' Метрики по пустому отбору были бы сплошными null и выглядели бы отчётом');
  }
  /* Считается по тому, что осталось после отбора, а не по набору: `--provider=grok` при двух
   * моделях одного провайдера смешивает их ровно так же, как отсутствие ключей вовсе. */
  const mixed = listRunVariants(selection.cases);
  if (mixed.length > 1) warnAboutMixing(file, mixed, console.error);
  if (selection.emptied.length) {
    console.error(`Под фильтром не осталось ни одного прогона у работ (${selection.emptied.length}): ${selection.emptied.join(', ')}.`);
    console.error('Набор, измеренный наполовину, — не то же самое, что измеренный целиком.');
  }

  const metrics = calculateQualityMetrics(selection.cases);
  const gate = evaluateQualityGate(metrics);
  console.log(JSON.stringify({
    dataset: file,
    ...(selection.filtered ? { filter: { provider, model } } : {}),
    release,
    counts: validation.counts,
    ...(mixed.length > 1 ? { warning: `в отбор попали прогоны нескольких пар «провайдер + модель» (${mixed.map(variantLabel).join('; ')}): метрики смешивают разные модели и измерением не являются — считайте с --model=<id>` } : {}),
    ...(selection.emptied.length ? { casesWithoutRuns: selection.emptied } : {}),
    metrics,
    gate,
  }, null, 2));
  if (release && !gate.pass) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
