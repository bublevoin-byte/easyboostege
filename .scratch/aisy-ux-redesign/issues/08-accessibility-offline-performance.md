# 08 — Accessibility, offline, themes и first-load budget

Status: done
Blocked by: 01, 02, 03, 04, 05, 06, 07
Spec: `.scratch/aisy-ux-redesign/spec.md#9-performance-and-quality-budgets`

## Что сделать

Провести системный hardening новой оболочки: keyboard/screen-reader/touch, 320–1440 px, light/dark,
reduced motion, offline closure и route splitting до initial JS <=150 KB gzip.

## Границы

- Входит перенос тяжёлого ниже первого экрана в lazy modules, если public contracts сохранены.
- Входит измеряемый service-worker closure и no-CLS skeletons.
- Не входит ослабление performance бюджета или исключение теста.
- Если 150 KB невозможно без отдельной архитектурной миграции, остановиться с измеренным blocker report.

## Файлы

- `public/main.js`, `public/app.js`, `public/service-worker.js`, Aisy CSS/modules — route splitting/hardening.
- `scripts/build-frontend.js`, `e2e/performance.test.js`, `e2e/aisy-accessibility.test.js` — executable budgets.
- `test/frontend-offline-contract.test.js`, Aisy contracts — offline/a11y parity.

## Definition of Done

- [x] Initial JavaScript <=150 KB gzip.
- [x] LCP<=2.5s, CLS<=0.1, INP<=200ms on existing contour.
- [x] 320/375/768/1440, portrait/landscape, dark/light, reduced motion pass.
- [x] All top-level controls >=44px, visible focus, semantic headings/nav/live states.
- [x] Offline reload never claims unavailable network functionality.
- [x] `npm test`, full Chromium, adaptive/EGE, lint/check/build/security pass.
- [x] Один коммит: `perf(aisy): harden learner experience`.

## Замер закрытия

- Initial JavaScript: 144,1 КБ gzip, 1 файл / 510 КБ без сжатия; 23 ленивых чанка.
- LCP 120 мс; CLS 0,096; INP 136 мс; индикатор ИИ 28 мс.
- Персональный план 139 мс; preview занятия 48 мс.
- Full sequential Chromium, adaptive diagnostic, Reading/Listening evidence, accessibility/offline
  matrix, security, lint/check/build прошли без ослабления бюджетов.
