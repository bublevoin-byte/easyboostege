# 03 — Сегодня и первый персональный маршрут

Status: done
Blocked by: 02
Spec: `.scratch/aisy-ux-redesign/spec.md#52-today`

## Что сделать

Заменить сетку всех модулей на экран Сегодня: одна рекомендованная сессия, duration 10/20/30/40,
понятная причина рекомендации, продолжение, диагностический CTA и честный provisional/offline/error state.

## Границы

- Использовать существующие adaptive overview/goal/session и локальный progress state.
- Диагностика рекомендуется, но её можно отложить; draft/route resumable.
- Не добавлять выдуманные profile поля или новую backend schema.
- Не менять алгоритм адаптивного плана.

## Файлы

- `public/screens/today.js`, `public/modules/today.js` — public projection и rendering.
- `public/index.html`, `public/app.js`, `public/main.js`, `public/service-worker.js` — route integration.
- `test/frontend-aisy-today.test.js`, `e2e/aisy-today.test.js` — states и mobile journey.

## Definition of Done

- [x] Главный экран приводит к занятию максимум за два решения.
- [x] Duration 10/20/30/40 имеет label, selected state и сохраняет допустимое предпочтение.
- [x] Diagnostic skip создаёт только честный provisional UX, не фальшивую оценку.
- [x] Loading/empty/offline/access/error состояния имеют recovery.
- [x] `npm test`, `npm run lint`, `npm run check`, build и focused Chromium проходят.
- [x] Один коммит: `feat(aisy): add personalized today route`.
