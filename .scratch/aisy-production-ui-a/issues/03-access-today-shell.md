# 03 — Провести ученика от access check к обновлённому «Сегодня»

**What to build:** После VK-сессии показать честную проверку активной подписки и открыть целевой production Today
в стиле «Бумажный маршрут»: рекомендация, причина, реальная длительность, маршрут и одно действие start/continue,
с общей нижней навигацией и без ложного Free/demo обещания.

**Blocked by:** 01 — production-фундамент; 02 — первый запуск и VK ID.

**Status:** ready-for-agent

**Spec anchor:** User Stories 8–15; Implementation Decisions — strict access, Today, motion, phone shell.

- [ ] До завершения `/me` и access check учебная оболочка и персональные данные не видны.
- [ ] Active, inactive, no-session и network-unknown состояния различимы и не подменяют друг друга.
- [ ] Inactive state не обещает Free-доступ или несуществующий checkout; следующее действие сформулировано честно.
- [ ] Today использует один dominant paper hero, реальную recommendation/duration/reason/outcome информацию и один CTA.
- [ ] Ready/resume/loading/offline/error сохраняют общую анатомию без layout jump и двойного CTA.
- [ ] Пять destinations имеют единый порядок, active marker и `aria-current`; Asya не становится шестой вкладкой.
- [ ] Переход paper layer и press feedback имеют reduced-motion эквивалент.
- [ ] Existing learning state, durations, start/continue route и persistence semantics не меняются.
- [ ] Production E2E подтверждает fake VK → active access → Today и inactive/no-network ветви.

