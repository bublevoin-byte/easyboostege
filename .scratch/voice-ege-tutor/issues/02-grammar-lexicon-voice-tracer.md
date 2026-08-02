# 02 — Голосовой разбор грамматики и лексики

**What to build:** после ошибки в грамматике или лексике Premium-ученик нажимает «Разобрать голосом», получает server-owned контекст, проходит diagnose → explain → micro-check → transfer loop через xAI Voice Agent и при отказе продолжает тот же разбор текстом либо по локальному правилу.

**Blocked by:** 01 — Premium-доступ и голосовые лимиты.

**Status:** ready-for-agent

- [ ] Клиент передаёт только идентификатор/ревизию ошибки; эталон, правило и skill извлекаются сервером.
- [ ] Bounded capsule и state machine не позволяют `resolved` без серверно проверенного micro-check.
- [ ] Основной xAI key не возвращается клиенту; выдаётся только короткоживущий credential с one-time reservation.
- [ ] Provider transport внедряемый и полностью тестируется fake-адаптером без платных вызовов.
- [ ] Доступная bottom sheet работает с микрофоном, временными субтитрами, таймером, завершением и возвратом в упражнение.
- [ ] Voice/text/local fallback сохраняют один и тот же capsule и не расходуют voice quota дважды.
- [ ] Targeted tests, `npm run lint`, `npm run check` и `npm test` проходят.

