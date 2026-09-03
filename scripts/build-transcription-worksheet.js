#!/usr/bin/env node
// Turns the writing stubs into a worksheet a person can fill in without touching JSON.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const stubsFile = path.join(__dirname, '..', 'quality', 'writing-fipi-stubs.json');
const worksheetFile = path.join(__dirname, '..', 'quality', 'transcription-worksheet.md');

function wrap(text, width = 100) {
  const words = String(text || '').split(/\s+/u);
  const lines = [];
  let line = '';
  for (const word of words) {
    if ((line + ' ' + word).trim().length > width) { lines.push(line.trim()); line = word; }
    else line += ' ' + word;
  }
  if (line.trim()) lines.push(line.trim());
  return lines.join('\n');
}

function scoreLine(item) {
  if (!item.human.criteria) return `общий балл ${item.human.total} из ${item.human.max} (по критериям в методичке не разбит)`;
  const parts = Object.entries(item.human.criteria)
    .map(([name, score]) => `${item.human.criteriaLabels[name]} — ${score}`);
  return `${item.human.total} из ${item.human.max}: ${parts.join(', ')}`;
}

function block(item, index) {
  const warnings = [];
  if (item.tags.includes('total-only')) warnings.push('в методичке только общий балл, без разбивки по критериям');
  if (item.tags.includes('assignment-partial')) warnings.push('**таблицу опроса нужно перенести со скана — в тексте её нет**');
  const reprints = item.source.reprintedIn?.length
    ? `\nТа же работа переиздана в: ${item.source.reprintedIn.join(', ')} — брать можно из любого.`
    : '';
  return [
    `## ${index + 1}. ${item.id}`,
    '',
    `- **Файл:** \`${item.source.manual}\`, страница **${item.source.page}**`,
    `- **Работа:** ${item.source.work ? `№ ${item.source.work}` : 'номер бланка не указан — ищите по условию'}`,
    `- **Задание:** ${item.operation === 'writing_37' ? '37, электронное письмо' : '38, проект с данными опроса'}`,
    `- **Объём по подсчёту эксперта:** ${item.source.wordCount ? `${item.source.wordCount} слов` : 'не указан'}`,
    `- **Оценка эксперта:** ${scoreLine(item)}`,
    ...(warnings.length ? [`- **Внимание:** ${warnings.join('; ')}`] : []),
    reprints,
    '',
    '<details><summary>Условие задания (для сверки, что нашли нужную работу)</summary>',
    '',
    '```',
    wrap(item.assignment),
    '```',
    '',
    '</details>',
    '',
    'Наберите текст работы между строками ниже, ничего не исправляя:',
    '',
    `<!-- ${item.id} -->`,
    '```text',
    '',
    '```',
    '',
  ].join('\n');
}

async function main() {
  const stubs = JSON.parse(await fs.readFile(stubsFile, 'utf8'));
  const pending = stubs.filter((item) => !item.answer);
  const t37 = pending.filter((item) => item.operation === 'writing_37');
  const t38 = pending.filter((item) => item.operation === 'writing_38');

  const header = [
    '# Набор работ ЕГЭ со сканов — рабочий лист',
    '',
    `Работ к набору: **${pending.length}** (задание 37 — ${t37.length}, задание 38 — ${t38.length}).`,
    '',
    'Что нужно сделать: открыть указанный PDF на указанной странице, найти скан работы участника',
    'и перенести её текст в поле ниже. Оценки, условие и объём уже проставлены — их менять не нужно.',
    '',
    '## Как набирать',
    '',
    '1. **Переносите текст ровно как в работе.** Все ошибки ученика — орфографические,',
    '   грамматические, пунктуационные — сохраняются. Это и есть предмет проверки: если исправить',
    '   ошибки, набор станет бесполезным.',
    '2. **Сохраняйте деление на абзацы** — пустая строка между абзацами. За организацию текста',
    '   ставится отдельный балл, и абзацы на него влияют.',
    '3. **Обращение, завершающую фразу и подпись** в задании 37 пишите каждое с новой строки,',
    '   как в оригинале.',
    '4. **Ничего не дописывайте и не сокращайте.** Если слово неразборчиво — напишите его так,',
    '   как читаете, и пометьте в конце работы строкой `# неразборчиво: <слово>`.',
    '5. **Проверьте объём.** Указанное число слов посчитал эксперт. Если у вас расходится больше',
    '   чем на 5 слов — скорее всего, найдена не та работа или пропущена строка.',
    '6. Не переносите пометки эксперта: подчёркивания, галочки, цифры на полях.',
    '',
    'Ничего, кроме текста внутри блоков ```text, править в этом файле не нужно.',
    'Комментарии вида `<!-- w37-... -->` служат метками — не удаляйте их.',
    '',
    '---',
    '',
  ].join('\n');

  const body = [
    '# Задание 37 — электронное личное письмо',
    '',
    ...t37.map((item, index) => block(item, index)),
    '---',
    '',
    '# Задание 38 — письменное высказывание с элементами рассуждения',
    '',
    ...t38.map((item, index) => block(item, index + t37.length)),
  ].join('\n');

  await fs.writeFile(worksheetFile, header + body, 'utf8');
  console.log(`Рабочий лист: ${worksheetFile}`);
  console.log(`Работ к набору: ${pending.length} (37 — ${t37.length}, 38 — ${t38.length})`);
  if (stubs.length !== pending.length) console.log(`Уже набрано: ${stubs.length - pending.length}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
