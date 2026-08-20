# 04 — Практика по навыкам

Status: ready-for-agent
Blocked by: 02, 03
Spec: `.scratch/aisy-ux-redesign/spec.md#53-practice`

## Что сделать

Собрать отдельный Practice hub с шестью навыками, честным состоянием и одним действием на строку,
который открывает существующие модули без сброса незавершённой работы.

## Границы

- Входят слова, грамматика, чтение, аудирование, письмо и говорение.
- Входят recommendation/continue/review/available states на существующих данных.
- Не входит изменение учебного контента или scoring.
- Не входят emoji как структурные иконки.

## Файлы

- `public/screens/practice.js`, `public/modules/practice.js` — hub interface.
- `public/main.js`, `public/router.js`, `public/service-worker.js` — lazy route/offline closure.
- `test/frontend-aisy-practice.test.js`, `e2e/aisy-practice.test.js` — route/state coverage.

## Definition of Done

- [ ] Все шесть навыков доступны и объясняют текущее действие.
- [ ] Existing active module state переживает переход hub → module → hub.
- [ ] Keyboard/focus/touch semantics и offline availability честны.
- [ ] `npm test`, `npm run lint`, `npm run check`, build и focused Chromium проходят.
- [ ] Один коммит: `feat(aisy): add practice hub`.
