# 04 — Сделать PostgreSQL integration воспроизводимым без skip

Status: done
Blocked by: —
Spec: .scratch/experimental-release-profile/spec.md#testing-decisions

## Что сделать

Локальная и CI-проверка должна поднимать отдельную disposable PostgreSQL, автоматически применять все миграции, выполнять существующий repository integration и гарантированно очищать тестовые данные, не касаясь production/staging.

## Границы

- Входит: существующий Docker/Compose-контур, отдельные тестовые реквизиты, запуск миграций и repository integration, изоляция и cleanup, документированные локальная и CI-команды.
- Не входит: production/staging базы, новые зависимости без необходимости, формальное снятие skip без фактического запуска PostgreSQL, push/deploy.

## Definition of Done

- [x] Одна воспроизводимая локальная команда поднимает disposable PostgreSQL с отдельной БД и без production/staging данных.
- [x] Все миграции автоматически применяются до repository integration.
- [x] `test/postgres-repository.test.js` реально выполняется без skip и проходит.
- [x] Повторный прогон не зависит от данных предыдущего и cleanup выполняется даже после ошибки теста.
- [x] CI использует тот же проверяемый путь или документированно эквивалентный путь.
- [x] `npm run lint`, `npm run check` и полный `npm test` проходят; §24.4 меняется только при отсутствии обязательных skip.
- [x] Проведён двухосевой review относительно исходного коммита тикета; замечания устранены или обоснованы.
- [x] Один локальный коммит на тикет.

## Result

- `npm run test:postgres` поднимает уникальный test-only Compose project и базу
  `easyboost_repository_test`, ждёт healthcheck, применяет миграции `001`–`020` и запускает только
  публичный repository integration: `1/1` проходит, `0` skip.
- Два последовательных прогона начали с применения всех миграций; после каждого test-контейнер,
  сеть и volume удалены. Намеренный отказ мигратора вернул non-zero и также оставил ноль ресурсов.
- CI вызывает тот же `npm run test:postgres`; обычный `npm test` остаётся Docker-независимым и
  сохраняет один защитный PostgreSQL skip.
- `npm run lint` и `npm run check` прошли; полный `npm test`: 425 тестов, 424 проходят, 1 штатно
  пропущен, 0 падают. Внешнее ТЗ, `docs/EXPERIMENTAL_RELEASE_AUDIT.md` и §24.4 не изменялись:
  формальную отметку пересмотрит полный аудит тикета 05.
- Review относительно `7898357`: Standards — 1 P2, Spec — 1 P1; оба замечания устранены.
