# 05 — Умная ротация, индивидуальный план и выпускной контур

**What to build:** приложение сначала показывает невстречавшиеся записи, затем возвращает слабые и давно не выполнявшиеся, честно учитывает помощь/раскрытый транскрипт и подтверждает полный пользовательский путь «каталог → запись → разбор → индивидуальный план».

**Blocked by:** 04 — Статические записи и безопасный xAI TTS-конвейер.

**Status:** done

- [x] Owner-bound история хранит только безопасные метаданные попыток по id/revision.
- [x] Выбор предпочитает unseen, не повторяет предыдущий id при наличии альтернативы и затем учитывает слабость/давность.
- [x] Замедление, дополнительные прослушивания и повтор после раскрытого транскрипта отмечаются assisted/help и не завышают независимую диагностику.
- [x] Каталог и доступные MP3 корректно участвуют в offline shell/cache без раскрытия ответов до проверки.
- [x] Chromium E2E проходит по одному сценарию каждого формата и подтверждает adaptive evidence.
- [x] Полный набор тестов, lint/check, frontend build и secret scan проходят.
- [x] Выпускная проверка фиксирует, что платных вызовов, push и deploy не было до отдельного разрешения.
- [x] Один коммит закрывает только этот тикет.

## Release evidence

- `npm test`: 795 tests, 780 passed, 15 штатных PostgreSQL skips, 0 failed.
- `npm run lint`, `npm run check`, `npm run build:frontend`: прошли; проверены 256 JS-файлов, 181 inline handler/126 имён, собраны 19 assets (1 shell, 336.2 KB JS, 6 lazy chunks).
- `npm run test:e2e`, `npm run test:e2e:evidence`, `npm run test:e2e:adaptive`: Chromium-сценарии прошли, включая полный desktop-контур, три listening-формата, ротацию и adaptive evidence.
- `npm run security:secrets`, `npm run security:history`: прошли для 479 tracked files и 275 commits.
- `npm run listening:audio:dry-run`: 60 sets, 400 requests/assets, 400 ожидаемо отсутствующих MP3, 56 914 characters, оценка `$0.853710`; файлов и сетевых запросов не создавалось.
- Фактические paid/xAI/network calls: 0; сгенерированные MP3: 0; push: 0; deploy: 0.
