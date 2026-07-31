# 02 — Структурированные условия для набора ФИПИ

Status: done
Blocked by: —
Spec: .scratch/ai-quality-runner/spec.md#что-мешает-прямо-сейчас

## Что сделать

У каждой работы набора появляется поле `assignmentData` — условие в той форме, которую принимает
`buildWritingPrompt`: для задания 37 `{from, stimulus, questionsTopic}`, для задания 38
`{topic, rows: [{label, percent}]}`. Сегодня в наборе лежит только плоская строка со скана, и
промпт из неё не собрать. После тикета 18 работ из 21 готовы к прогону, а три работы с круговыми
диаграммами остаются с `assignmentData: null` и тегом `assignment-partial` — их цифры существуют
только картинкой и переносятся руками в тикете 03.

## Границы

Входит:

- Скрипт `scripts/build-quality-assignments.js` (`npm run quality:assignments`), который заполняет
  `assignmentData` в `quality/writing-fipi-stubs.json`.
- Задание 37, все 12 работ: `from` берётся из `From: …` в условии, `questionsTopic` — из
  «ask questions about …», `stimulus` — текст входящего письма.
- Задание 38, шесть табличных работ: подписи и проценты берутся из `quality/sources/fipi-pch-*.txt`
  — в тексте методичек они есть, их потеряла прошлая выгрузка. Работа ищется по `source.manual`
  и `source.assignmentPage`.
- Каждое заполненное `assignmentData` проверяется схемой `writingAssignmentSchema` из
  `ai/writing.js`. Не прошло схему — скрипт падает и говорит, на какой работе.
- Три работы с диаграммами: `assignmentData` остаётся `null`, тег `assignment-partial` сохраняется.
- Новые файлы добавляются в список `npm run check`.

Не входит:

- Придумывание процентов, которых нет в источнике. Ни одной цифры «по смыслу»: набор эталонный,
  и подставленное число делает оценку эксперта несопоставимой с оценкой ИИ.
- Правка `answer`, `human` и `source` — они выверены владельцем и не трогаются.
- Изменение существующего поля `assignment`: строка со скана остаётся как есть, она нужна для
  сверки и для теста набора.

## Файлы

- `scripts/build-quality-assignments.js` — новый: разбор условий.
- `quality/writing-fipi-stubs.json` — добавляется `assignmentData` у 18 работ, `null` у трёх.
- `package.json` — команда `quality:assignments`, новый файл в `check`.
- `test/quality-writing-assignments.test.js` — новый: каждое непустое `assignmentData` проходит
  `writingAssignmentSchema`; у работ с тегом `assignment-partial` оно `null`; проценты таблиц
  задания 38 совпадают с текстом методички.

## Definition of Done

- [x] 12 работ задания 37 и 6 табличных работ задания 38 имеют `assignmentData`, прошедшее схему.
- [x] Три работы с тегом `assignment-partial` имеют `assignmentData: null` и не считаются готовыми.
- [x] `npm run quality:assignments` повторно даёт тот же результат — на уже заполненном наборе
      ничего не меняется.
- [x] `test/quality-writing-stubs.test.js` проходит без правок.
- [x] `npm test` проходит: 277 тестов, 276 проходят, 1 пропущен, 0 падают.
- [x] `npm run lint` и `npm run check` проходят.
- [x] Один коммит на тикет.
