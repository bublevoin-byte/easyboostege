# 03 — Голосовой разбор чтения и аудирования

**What to build:** тот же Voice Error Tutor запускается с результатов чтения и аудирования, объясняя выбранный ответ по server-owned фрагменту/транскрипту и критерию без преждевременного раскрытия ответов незавершённой попытки.

**Blocked by:** 02 — Голосовой разбор грамматики и лексики.

**Status:** done

- [x] Capsule adapters покрывают reading и listening и не принимают от клиента эталон или произвольный текст источника.
- [x] Помощник ссылается на разрешённый фрагмент и не раскрывает ответы других пунктов попытки.
- [x] Micro-check и transfer task проверяются сервером для обоих модулей.
- [x] Кнопка, fallback и восстановление состояния работают на обоих экранах.
- [x] Targeted tests, `npm run lint`, `npm run check` и `npm test` проходят.

**Result:** built-in и динамические `reading_questions`/`listening_interview` получают server-issued
set/item IDs; сервер проверяет весь завершённый набор по canonical или owner-bound `generated_tasks`
result и создаёт детерминированные error attempts. Practice и exam results используют общий UI
adapter; capsule, text/local fallback и восстановление получают только exact bounded evidence одного
пункта. Повтор UUID неизменяем: тот же answer hash возвращает те же children, другой даёт `409`.
Целевые тесты 32/32; `lint`, `check`, frontend build и полный набор 455 (454 pass, 1 PostgreSQL skip)
проходят без ошибок.
