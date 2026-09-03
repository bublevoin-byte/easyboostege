# 03 — Провести ученика от access check к обновлённому «Сегодня»

**What to build:** После VK-сессии показать честную проверку активной подписки и открыть целевой production Today
в стиле «Бумажный маршрут»: рекомендация, причина, реальная длительность, маршрут и одно действие start/continue,
с общей нижней навигацией и без ложного Free/demo обещания.

**Blocked by:** 01 — production-фундамент; 02 — первый запуск и VK ID.

**Status:** done

**Spec anchor:** User Stories 8–15; Implementation Decisions — strict access, Today, motion, phone shell.

- [x] До завершения `/me` и access check учебная оболочка и персональные данные не видны.
- [x] Active, inactive, no-session и network-unknown состояния различимы и не подменяют друг друга.
- [x] Inactive state не обещает Free-доступ или несуществующий checkout; следующее действие сформулировано честно.
- [x] Today использует один dominant paper hero, реальную recommendation/duration/reason/outcome информацию и один CTA.
- [x] Ready/resume/loading/offline/error сохраняют общую анатомию без layout jump и двойного CTA.
- [x] Пять destinations имеют единый порядок, active marker и `aria-current`; Asya не становится шестой вкладкой.
- [x] Переход paper layer и press feedback имеют reduced-motion эквивалент.
- [x] Existing learning state, durations, start/continue route и persistence semantics не меняются.
- [x] Production E2E подтверждает fake VK → active access → Today и inactive/no-network ветви.

## Verification

- Focused changed-suite: 101 tests, 0 failures; syntax/inline-handler check and exact changed-JS ESLint passed.
- Frontend build and Aisy Today, first-launch, accessibility, learner-release, adaptive-diagnostic and Progress/Profile Chromium E2E passed.
- Full `npm test` was run once: it exposed one stale Reading layout assertion (corrected; focused rerun green) and one unrelated 50 ms speaking-service timeout under parallel load (focused rerun green).
- Independent Standards and Spec re-reviews: `ZERO_FINDINGS` / `ZERO_FINDINGS`.
