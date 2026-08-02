# 05 — Поиск и проверка отсутствующих правил

**What to build:** если canonical rule отсутствует, Easy Boost ищет материал только в trusted allowlist, требует два согласующихся источника, показывает ссылки в текущем разборе и создаёт rule card `pending_review`, которую преподаватель может одобрить или отклонить.

**Blocked by:** 02 — Голосовой разбор грамматики и лексики.

**Status:** ready-for-agent

- [ ] Open web/X search и произвольные connectors не доступны voice-клиенту.
- [ ] Provider-neutral discovery seam ограничивает домены, размер/тип ответа, таймаут и redirects.
- [ ] Один источник, запрещённый домен или противоречие не создают объяснение как установленный факт.
- [ ] Rule card хранит status, skill, exam year, source URLs, content hashes и review audit без копирования полной страницы.
- [ ] Только approved card входит в общий canonical retrieval; current-session provisional explanation имеет явную маркировку.
- [ ] Reviewer endpoints защищены admin role и идемпотентны.
- [ ] Targeted tests используют только fixtures; `npm run lint`, `npm run check` и `npm test` проходят.

