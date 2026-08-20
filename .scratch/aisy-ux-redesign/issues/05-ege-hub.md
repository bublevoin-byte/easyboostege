# 05 — ЕГЭ hub без смешивания с попыткой

Status: ready-for-agent
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

- [ ] Nav “ЕГЭ” открывает hub, а не немедленно running mock.
- [ ] Active attempt/continue, start, latest result and section practice are distinct actions.
- [ ] No answer assistance appears in strict mock.
- [ ] Existing written/oral/result/release E2E remain green.
- [ ] `npm test`, lint/check/build and focused Chromium pass.
- [ ] Один коммит: `feat(aisy): add ege learner hub`.
