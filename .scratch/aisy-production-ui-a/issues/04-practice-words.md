# 04 — Оформить «Практику» и полный контур слов

**What to build:** Перенести Practice hub и все активные состояния слов в общий язык A, чтобы ученик мог выбрать
режим, начать/продолжить занятие, ответить, увидеть объяснение и вернуться к Practice в одной системе без
изменения словаря, SRS и сохранения прогресса.

**Blocked by:** 03 — access check, Today и общая learner shell.

**Status:** ready-for-agent

**Spec anchor:** User Stories 16, 20, 26–28, 31–36, 40, 48.

- [ ] Practice hub показывает шесть реальных модулей с ясной иерархией и одним рекомендуемым следующим действием.
- [ ] Words library/session/answer/review/empty/loading/offline/error используют common paper surfaces и state language.
- [ ] Choices имеют default/selected/correct/incorrect/disabled/focus признаки без color-only meaning.
- [ ] Deep route использует Back + один 58 px CTA dock и не показывает bottom nav одновременно.
- [ ] Personal words, adaptive words, SRS, owner isolation и offline continuation сохраняют текущую семантику.
- [ ] 320×720 и landscape не теряют answer/CTA и не создают горизонтальный overflow.
- [ ] Words browser/unit tests подтверждают прежние ответы и новый видимый navigation/state contract.

