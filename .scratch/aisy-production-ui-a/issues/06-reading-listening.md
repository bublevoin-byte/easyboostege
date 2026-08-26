# 06 — Оформить чтение и аудирование как спокойную рабочую среду

**What to build:** Привести reading и listening catalogs/runners/reviews к единой бумажной системе, сохранив
официальные типы заданий, media controls, evidence и offline truth.

**Blocked by:** 03 — access check, Today и общая learner shell.

**Status:** ready-for-agent

**Spec anchor:** User Stories 16, 21, 26–28, 31–36, 40, 48.

- [ ] Reading/listening hubs, instructions, task, answer, review, result, loading/offline/error используют общий deep layout.
- [ ] Длинные тексты и варианты имеют устойчивую типографику, sticky action не перекрывает последние строки.
- [ ] Audio controls имеют доступные names, 44 px targets и видимые buffering/playing/paused/error состояния.
- [ ] Selected/submitted/correct/incorrect states семантичны и не используют цвет как единственный сигнал.
- [ ] Existing catalogs, evidence recording, playback/storage и adaptive route contracts не меняются.
- [ ] Offline copy отличает cached reading/audio от сетевых операций, которые нельзя выполнить.
- [ ] Reading/listening unit/E2E и компактный responsive smoke проходят на production build.

