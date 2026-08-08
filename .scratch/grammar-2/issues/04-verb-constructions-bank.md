# 04 — Активный банк глагольных конструкций

Status: ready-for-agent
Blocked by: 03 — Активный runner
Spec: `.scratch/grammar-2/spec.md#implementation-decisions`

## Что сделать

Дать темам пассива, условий, косвенной речи, модальных глаголов, инфинитива/герундия и вопросов полный четырёхуровневый путь с минимум 24 заданиями на тему и точными ошибками/transfer practice.

## Границы

- Входят шесть названных тем, 144 задания, разметка ошибок и transfer-связей.
- Не входят времена, части речи, служебные слова и смешанный selector.

## Файлы

- `public/grammar-catalog-content.js`, `public/grammar-catalog.js` — контент и coverage.
- `public/modules/grammar.js`, `public/screens/grammar.js` — общий runner без тематических обходов.
- `test/`, `e2e/` — catalog/domain/browser contracts.

## Definition of Done

- [ ] Шесть тем содержат минимум 144 уникальных задания, по 6 каждого из четырёх типов на тему.
- [ ] Автопроверка принимает только перечисленные эквивалентные ответы и отклоняет ложные варианты.
- [ ] Error taxonomy различает construction, auxiliary, agreement, word order, negation/question и confusion pair.
- [ ] Каждая тема проходит полный learning/result/due flow без специальных веток экрана.
- [ ] Catalog coverage и focused browser/domain tests проходят.
- [ ] `npm test`, `npm run lint` и `npm run check` проходят; один коммит на тикет.
