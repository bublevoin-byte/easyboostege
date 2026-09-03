# 06 — Оформить чтение и аудирование как спокойную рабочую среду

**What to build:** Привести reading и listening catalogs/runners/reviews к единой бумажной системе, сохранив
официальные типы заданий, media controls, evidence и offline truth.

**Blocked by:** 03 — access check, Today и общая learner shell.

**Status:** done

**Spec anchor:** User Stories 16, 21, 26–28, 31–36, 40, 48.

- [x] Reading/listening hubs, instructions, task, answer, review, result, loading/offline/error используют общий deep layout.
- [x] Длинные тексты и варианты имеют устойчивую типографику, sticky action не перекрывает последние строки.
- [x] Audio controls имеют доступные names, 44 px targets и видимые buffering/playing/paused/error состояния.
- [x] Selected/submitted/correct/incorrect states семантичны и не используют цвет как единственный сигнал.
- [x] Existing catalogs, evidence recording, playback/storage и adaptive route contracts не меняются.
- [x] Offline copy отличает cached reading/audio от сетевых операций, которые нельзя выполнить.
- [x] Reading/listening unit/E2E и компактный responsive smoke проходят на production build.

## Verification

- Focused Node suite: 120 tests, 120 passed; lint/check passed; production build verified 529 assets.
- Chromium: Paper A matrix, evidence, Practice, Reading 2 and learning-progress flows passed sequentially.
- Independent Spec and Standards reviews both returned `ZERO_FINDINGS` on the final diff.
- The required full `npm test` ran exactly once and exited 1. A focused 20-test proof reproduced only four
  pre-existing HEAD failures (16 passed): stale first-launch shell-inert text expectation, two legacy Grammar
  accessibility scanner expectations, and the stale Aisy release-script expectation. Ticket 06 did not change
  their source/test seams; the full suite was not rerun.
