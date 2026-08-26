# 11 — Закрыть PWA, доступность и production release evidence

**What to build:** Собрать и проверить весь обновлённый learner-контур как installable PWA, обновить app-shell cache,
закрыть responsive/light-dark/reduced-motion/offline/performance/security матрицу и передать владельцу один
кликабельный production build с известными внешними placeholder.

**Blocked by:** 02–10 — первый запуск, auth, access и все learner surfaces.

**Status:** ready-for-agent

**Spec anchor:** User Stories 31–38, 42–50; Testing Decisions; Further Notes.

- [ ] Service worker version и production app-shell включают новые runtime assets; prototypes не входят в cache.
- [ ] Auth/callback/me/subscription/personal APIs имеют no-store semantics и не обслуживаются stale cache.
- [ ] Manifest/icons/splash/install/update/offline upgrade проходят на собранном `dist/public`.
- [ ] Chromium matrix 320/375/768/1440, portrait/landscape, light/dark/system и reduced motion не имеет rail/overflow/target failures.
- [ ] Main journey и каждый активный deep screen проходят ready + неблагополучный smoke state.
- [ ] Accessibility проверяет keyboard, visible focus, roles/names/live regions, contrast и dialog/dock focus containment.
- [ ] JS/LCP/CLS/INP остаются в release budgets или документированное отклонение блокирует готовность.
- [ ] Lint, syntax/inline checks, unit, relevant E2E, production build и secret scans зелёные.
- [ ] Документация перечисляет только env names/callback setup и `PLACEHOLDER — создать VK ID application`, без secret values.
- [ ] Release handoff содержит точный локальный URL, проверенные команды, известные ограничения и не заявляет deployment.

