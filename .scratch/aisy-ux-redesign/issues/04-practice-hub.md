# 04 — Практика по навыкам

Status: done
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

- [x] Все шесть навыков доступны и объясняют текущее действие.
- [x] Existing active module state переживает переход hub → module → hub.
- [x] Keyboard/focus/touch semantics и offline availability честны.
- [x] `npm test`, `npm run lint`, `npm run check`, build и focused Chromium проходят.
- [x] Один коммит: `feat(aisy): add practice hub`.

## Подтверждённые публичные seams

- `projectPractice(input)` — чистая проекция шести строк, их честного состояния, действия и
  offline-пояснения на основе уже существующих данных ученика.
- Переход `Практика → существующий screen id → Практика` — наблюдаемый браузерный маршрут без
  запуска нового задания и без очистки сохранённого черновика.

## Verification

- Public RED зафиксировал отсутствие Practice projection/route; GREEN покрывает шесть навыков,
  state precedence, owner-bound continuity/reset, completion outcomes и offline closure (`8/8`).
- Focused regression: `72/72`; full unit: `1888 total / 1840 pass / 48 skip / 0 fail`.
- `npm run lint`, `npm run check`, `npm run build:frontend`, `npm run security:secrets` — green.
- Chromium Practice и legacy demo — green; Practice включает сохранение Words/Reading/Listening,
  pause/resume listening timer, authority reset и первый offline-open через настоящий service worker.
- Fresh Standards review: `APPROVED — zero findings`; fresh Spec review: `APPROVED — zero findings`.
