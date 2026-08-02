# 02 — Голосовой разбор грамматики и лексики

**What to build:** после ошибки в грамматике или лексике Premium-ученик нажимает «Разобрать голосом», получает server-owned контекст, проходит diagnose → explain → micro-check → transfer loop через xAI Voice Agent и при отказе продолжает тот же разбор текстом либо по локальному правилу.

**Blocked by:** 01 — Premium-доступ и голосовые лимиты.

**Status:** done

- [x] Кнопка появляется только после серверной проверки исходной ошибочной попытки; дальше клиент передаёт только её идентификатор/ревизию, а эталон, правило и skill извлекаются сервером.
- [x] Bounded capsule и state machine не позволяют `resolved` без серверно проверенного micro-check.
- [x] Основной xAI key не возвращается клиенту; выдаётся только короткоживущий credential с one-time reservation.
- [x] Браузерный realtime WebSocket/audio transport использует ephemeral credential, а provider seam и tool events полностью тестируются fake-адаптерами без платных вызовов.
- [x] Доступная bottom sheet работает с микрофоном, временными субтитрами, таймером, завершением и возвратом в упражнение.
- [x] Voice/AI-text/canonical-local fallback сохраняют один и тот же capsule и не расходуют voice quota дважды.
- [x] Каждый AI-text turn требует отдельного актуального `text_processing` consent; одного voice consent недостаточно, и без text consent используется только canonical-local rule.
- [x] Targeted tests, `npm run lint`, `npm run check` и `npm test` проходят.

Реализован tracer только для grammar/lexicon: server-owned canonical capsule, конечный педагогический автомат,
одноразовый nonce и credential seam, браузерный realtime transport, общая доступная bottom sheet и сохранение
одного capsule при AI-text/canonical-local fallback.
Нормализованный ошибочный ответ до 200 символов хранится только в исходной `module_attempt`, чтобы
точный capsule можно было заново собрать для каждого AI-text шага. В `voice_tutor_sessions` и её
экспорте ответа нет; аудио, временные субтитры и nonce hash также не сохраняются.
Чтение, аудирование, письмо, устная часть, trusted discovery и recovery map оставлены следующим тикетам.
