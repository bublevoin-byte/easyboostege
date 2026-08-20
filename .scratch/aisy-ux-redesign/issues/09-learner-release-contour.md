# 09 — Сквозной выпуск learner UX

Status: ready-for-agent
Blocked by: 01, 02, 03, 04, 05, 06, 07, 08
Spec: `.scratch/aisy-ux-redesign/spec.md#11-acceptance-criteria`

## Что сделать

Закрепить один настоящий browser path onboarding/Сегодня → practice → EGE → result/progress → profile/Asya,
обновить operator documentation и выполнить полный release gate без deploy.

## Границы

- Входит real router/API/file-backed browser contour and exact reload/offline/cross-tab checks.
- Входит design/operations documentation and final evidence.
- Не входит production deploy, paid provider, secrets, parent/teacher implementation or Ticket 99 content.

## Файлы

- `e2e/aisy-learner-release.test.js`, `package.json` — default/release gate.
- `docs/AISY_UX_OPERATIONS.md`, `PROGRESS.md`, ticket metadata — evidence/closeout.
- Только необходимые regression tests; product code меняется лишь через новый RED.

## Definition of Done

- [ ] Real learner contour covers all five hubs, reload/offline/cross-tab and 320/1440 a11y.
- [ ] Full `npm test`, lint/check/build, full/adaptive/EGE/release Chromium, performance, security and diff-check pass.
- [ ] Fresh PostgreSQL runs only if server/storage changed, after explicit owner approval.
- [ ] Fresh independent Standards and Spec reviews return `ZERO_FINDINGS` on one frozen identity.
- [ ] Ticket 99 is preserved; no push/deploy/provider/install.
- [ ] Один коммит: `test(aisy): add learner ux release contour`.
