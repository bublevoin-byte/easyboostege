# 05 — ЕГЭ hub без смешивания с попыткой

Status: done
Blocked by: 02, 03
Spec: `.scratch/aisy-ux-redesign/spec.md#54-ege`

## Что сделать

Добавить отдельный EGE hub для active attempt, full mock, latest result/history и section practice; running
mock остаётся отдельным строгим экраном и использует существующий server-authoritative runner.

## Границы

- Входит pre-start explanation времени, offline/recovery и experimental assessment.
- Входят ссылки на существующие section trainings и exact result/history.
- Не входят новый вариант, вопросы, scoring или помощь с ответами в diagnostic/mock.

## Файлы

- `public/screens/ege-hub.js`, `public/modules/ege-hub.js` — hub projection/render.
- `public/main.js`, `public/router.js`, `public/service-worker.js`, `public/screens/ege-mock.js` — route adapters.
- `test/frontend-aisy-ege-hub.test.js`, `e2e/aisy-ege-hub.test.js` — public behavior.

## Definition of Done

- [x] Nav “ЕГЭ” открывает hub, а не немедленно running mock.
- [x] Active attempt/continue, start, latest result and section practice are distinct actions.
- [x] No answer assistance appears in strict mock.
- [x] Existing written/oral/result/release E2E remain green.
- [x] `npm test`, lint/check/build and focused Chromium pass.
- [x] Один коммит: `feat(aisy): add ege learner hub`.
