# 04 — Оформить «Практику» и полный контур слов

**What to build:** Перенести Practice hub и все активные состояния слов в общий язык A, чтобы ученик мог выбрать
режим, начать/продолжить занятие, ответить, увидеть объяснение и вернуться к Practice в одной системе без
изменения словаря, SRS и сохранения прогресса.

**Blocked by:** 03 — access check, Today и общая learner shell.

**Status:** done

**Spec anchor:** User Stories 16, 20, 26–28, 31–36, 40, 48.

- [x] Practice hub показывает шесть реальных модулей с ясной иерархией и одним рекомендуемым следующим действием.
- [x] Words library/session/answer/review/empty/loading/offline/error используют common paper surfaces и state language.
- [x] Choices имеют default/selected/correct/incorrect/disabled/focus признаки без color-only meaning.
- [x] Deep route использует Back + один 58 px CTA dock и не показывает bottom nav одновременно.
- [x] Personal words, adaptive words, SRS, owner isolation и offline continuation сохраняют текущую семантику.
- [x] 320×720 и landscape не теряют answer/CTA и не создают горизонтальный overflow.
- [x] Words browser/unit tests подтверждают прежние ответы и новый видимый navigation/state contract.

## Verification

- Focused Practice/Words/state/service-worker suite: 50 tests, 0 failures; repaired Reading layout contract: 6/6.
- Production Chromium E2E passed for Practice, full Words library/session, Today, shell, first launch, accessibility and learner release, including 320×720, 720×320, fresh-install offline, owner-switch and resume/idempotency seams.
- `npm run lint`, `npm run check` (491 JavaScript files / 197 inline handlers / 116 names), frontend build (527 verified assets / 524.5 KB shell JavaScript / 23 lazy chunks) and diff-check passed.
- The exactly-once full `npm test` run exposed only an inherited Ticket 03 assertion that still required the deliberately removed ≥768 px Reading rail; the assertion was aligned to the approved phone-only/no-rail contract and its focused rerun passed 6/6.
- Independent Standards and Spec re-reviews, including the narrow inherited-test correction: `ZERO_FINDINGS` / `ZERO_FINDINGS`.
