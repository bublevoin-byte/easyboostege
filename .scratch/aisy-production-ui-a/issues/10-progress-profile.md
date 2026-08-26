# 10 — Завершить систему на Прогрессе и Профиле

**What to build:** Перенести Progress и Profile в A, чтобы ученик видел изменение/слабое место/следующий шаг,
управлял light/dark/system, мог повторить onboarding и безопасно выполнить privacy/export/delete/logout без
ложного Free-плана.

**Blocked by:** 03 — access check, Today и общая learner shell.

**Status:** ready-for-agent

**Spec anchor:** User Stories 18–19, 29–30, 31–36, 37–40, 49.

- [ ] Progress ведёт с outcome delta, weak point и next action; графики имеют текстовые значения и пояснения.
- [ ] Empty/loading/offline/error и assisted/independent evidence различимы без color-only meaning.
- [ ] Profile группирует identity, preferences, access, privacy и account actions в ясной иерархии.
- [ ] Theme selector `system | light | dark` применяется без reload, хранится и корректно инициализируется до paint.
- [ ] «Повторить знакомство» открывает onboarding, а возврат не разрушает активную сессию.
- [ ] Subscription copy отражает strict active access и не заявляет Free/demo или готовую оплату.
- [ ] Export/delete/logout сохраняют подтверждение, focus management, owner reset и существующие server contracts.
- [ ] Progress/profile/accessibility unit и browser tests проходят в обеих темах.

