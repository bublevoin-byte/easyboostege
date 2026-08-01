# 04 — Сделать PostgreSQL integration воспроизводимым без skip

Status: ready-for-agent
Blocked by: —
Spec: .scratch/experimental-release-profile/spec.md#testing-decisions

## Что сделать

Локальная и CI-проверка должна поднимать отдельную disposable PostgreSQL, автоматически применять все миграции, выполнять существующий repository integration и гарантированно очищать тестовые данные, не касаясь production/staging.

## Границы

- Входит: существующий Docker/Compose-контур, отдельные тестовые реквизиты, запуск миграций и repository integration, изоляция и cleanup, документированные локальная и CI-команды.
- Не входит: production/staging базы, новые зависимости без необходимости, формальное снятие skip без фактического запуска PostgreSQL, push/deploy.

## Definition of Done

- [ ] Одна воспроизводимая локальная команда поднимает disposable PostgreSQL с отдельной БД и без production/staging данных.
- [ ] Все миграции автоматически применяются до repository integration.
- [ ] `test/postgres-repository.test.js` реально выполняется без skip и проходит.
- [ ] Повторный прогон не зависит от данных предыдущего и cleanup выполняется даже после ошибки теста.
- [ ] CI использует тот же проверяемый путь или документированно эквивалентный путь.
- [ ] `npm run lint`, `npm run check` и полный `npm test` проходят; §24.4 меняется только при отсутствии обязательных skip.
- [ ] Проведён двухосевой review относительно исходного коммита тикета; замечания устранены или обоснованы.
- [ ] Один локальный коммит на тикет.
