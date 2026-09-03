# 01 — Развернуть production-фундамент «Бумажного маршрута»

**What to build:** Подготовить безопасный общий визуальный фундамент, на котором существующее learner-приложение
может поэкранно перейти на утверждённое направление A: трёхслойные light/dark токены, локальную типографику,
общие поверхности, кнопки, choices, статусы, фокус и phone-only оболочку без боковой навигации.

**Blocked by:** None — can start immediately.

**Status:** done

**Spec anchor:** Solution; Implementation Decisions — стек, canvas, tokens, typography, buttons, motion, dark theme.

- [x] Production learner canvas остаётся `min(100vw, 390px)` и центрируется на 768/1440 px без side rail.
- [x] Bottom navigation остаётся снизу; deep screen может использовать нижний action dock.
- [x] Primitive → semantic → component tokens покрывают light/dark canvas, surfaces, text, action, state, focus, depth и motion.
- [x] Nunito + Manrope загружаются локально и не создают сетевого font dependency.
- [x] Primary CTA соблюдает анатомию `58 / 28 / 26 / 10 / 38`, AA-safe coral и все interaction states.
- [x] Raised paper secondary/choice controls, alerts и focus ring имеют единый production-контракт.
- [x] Theme bootstrap следует system preference без заметного неправильного первого кадра.
- [x] 320/375/768/1440 не имеют горизонтального overflow; активные цели не меньше 44×44 px.
- [x] Existing router/API/store/learning tests остаются зелёными.

**Evidence:** independent Standards/Spec re-review — zero remaining Ticket 01 findings; `npm run lint`;
`npm run check`; `npm test` — 1919 total / 1871 passed / 48 skipped / 0 failed; `npm run build:frontend`;
`node e2e/aisy-accessibility.test.js`; `git diff --check`.
