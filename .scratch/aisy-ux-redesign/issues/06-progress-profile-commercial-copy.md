# 06 — Прогресс, профиль и два публичных тарифа

Status: ready-for-agent
Blocked by: 01, 02, 03, 04, 05
Spec: `.scratch/aisy-ux-redesign/spec.md#55-progress`

## Что сделать

Перестроить Progress вокруг улучшений/рисков/следующего шага, Profile — вокруг study/privacy/subscription/data,
и убрать публичный третий тариф Base, сохранив внутреннюю entitlement совместимость.

## Границы

- Входит shared presentation mapping Free/Premium.
- Входит честное различение independent/assisted/approximate evidence.
- Не входит изменение entitlement, цены, payment provider или OAuth.
- Не показывать неработающие parent/teacher controls.

## Файлы

- `public/commercial-copy.js` — public two-plan presentation.
- `public/screens/progress.js`, `public/screens/profile.js`, `public/modules/profile.js`, `public/index.html` — IA/copy.
- `public/main.js`, `public/service-worker.js` — module/offline closure.
- `test/frontend-aisy-progress-profile.test.js`, existing adaptive/profile tests — contract.

## Definition of Done

- [ ] Progress начинается с next action, а не несопоставимых процентов.
- [ ] Profile имеет понятные study/Asya/privacy/subscription/data группы.
- [ ] UI содержит только Free/Premium; capability locks remain honest.
- [ ] No IELTS/official-score drift and no raw private evidence leak.
- [ ] Full adaptive/profile tests, `npm test`, lint/check/build pass.
- [ ] Один коммит: `feat(aisy): clarify progress and profile`.
