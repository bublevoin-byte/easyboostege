# 09 — Оформить ЕГЭ и полный пробник без ослабления режима

**What to build:** Перенести EGE hub, письменный и устный runners, результаты и переходы полного пробника в
строгий вариант бумажной системы A, сохранив таймеры, lock order, recovery, scoring и экзаменационные ограничения.

**Blocked by:** 03 — access check, Today и общая learner shell.

**Status:** ready-for-agent

**Spec anchor:** User Stories 17, 24, 26–28, 31–36, 40, 48.

- [ ] EGE hub ясно разделяет practice sections и полный mock, не превращаясь в равноправный dashboard.
- [ ] Written/oral intro, runner, timer, navigation, submit confirmation, recovery и result используют calm strict surfaces.
- [ ] Timer/warning/locked/submitted/error states не зависят только от coral и остаются читаемыми в dark theme.
- [ ] Deep exam chrome не показывает global bottom nav и не теряет emergency/back semantics.
- [ ] Existing catalogs, attempt persistence, oral media, writing assessment, scoring и lock order не меняются.
- [ ] Reload/offline/reconnect и small-phone/landscape сохраняют честное состояние попытки.
- [ ] Полный EGE unit/E2E release contour остаётся зелёным после визуальной миграции.

