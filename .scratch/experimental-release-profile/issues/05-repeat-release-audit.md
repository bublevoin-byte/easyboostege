# 05 — Повторить локальный релизный аудит и подготовить операционные ворота

Status: done
Blocked by: 03, 04
Spec: .scratch/experimental-release-profile/spec.md#testing-decisions

## Что сделать

На новом зафиксированном кандидате выполнить полный бесплатный локальный аудит, обновить доказательства и точные readiness-профили, а затем выпустить конкретный пошаговый чек-лист оставшихся ручных ворот без их выполнения.

## Границы

- Входит: lint/check/tests, PostgreSQL integration, все доступные browser E2E, performance, frontend build, secret scans, целевые ИИ-схемы, quality engineering-smoke, readiness strict/experimental, обновление аудита, прогресса и внешнего ТЗ.
- Не входит: push/deploy, ротация секретов, платные ИИ-вызовы, физическая приёмка устройств, staging soak, фактическая доставка внешних alerts и восстановление на втором сервере.

## Definition of Done

- [x] Все доступные команды выполнены на зафиксированном commit и их точные результаты записаны.
- [x] §24.1, §24.4 и §24.10 изменены только в объёме фактически доказанного; §11 и strict-профиль не подменены.
- [x] `docs/EXPERIMENTAL_RELEASE_AUDIT.md`, `PROGRESS.md`, внешний файл ТЗ и readiness-числа согласованы.
- [x] Отдельный операционный чек-лист перечисляет владельца, предусловия, шаги, доказательство и критерий завершения каждого оставшегося gate.
- [x] Недоступная или пропущенная проверка явно остаётся открытой.
- [x] Проведён двухосевой review относительно исходного коммита тикета; замечания устранены или обоснованы.
- [x] Один локальный коммит на тикет; рабочее дерево чистое.

## Result

- Повторный аудит проведён на application candidate `661a98974aac7bbc69dc321a876eacee65ec9819`; полная матрица команд и точные exit/results записаны в `docs/EXPERIMENTAL_RELEASE_AUDIT.md`.
- Выделенный disposable PostgreSQL прошёл `1/1`, `0` skip после миграций `001`–`020`; контейнер, сеть и volume удалены. Карта content/writing/speaking/STT/TTS прошла `58/58` tests без skip.
- §24.4 и §24.10 закрыты в обоих профилях; §24.1 засчитан только для experimental. Strict сохраняет §11 `0/28` и §24.12 strict-open; experimental исключает их, не объявляя выполненными.
- Итоги CLI: strict `439/477 = 92.0%`, 38 open; experimental `440/448 = 98.2%`, 8 open, 29 excluded.
- `docs/EXPERIMENTAL_RELEASE_OPERATIONS_CHECKLIST.md` задаёт порядок, owner, prerequisites, safe steps, evidence, success и stop/rollback для семи оставшихся операционных ворот. Ни одно gated-действие не выполнялось.
- Внешнее ТЗ обновлено физически вне Git; в коммит тикета оно не войдёт.
- Двухосевой review относительно `661a98974aac7bbc69dc321a876eacee65ec9819`: Standards — 3 замечания, Spec — 2; все устранены. Добавлен post-build Chromium E2E для `dist/public`, rollback переведён на root-owned helper, recovery изолирован от production credentials, а три доказанных P0 отмечены во внешнем ТЗ. Итог сохранён одним amended commit.
