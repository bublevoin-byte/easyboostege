# Active Vocabulary System — локальное release evidence

- Дата: **5 августа 2026 года**.
- Ветка: `feature/adaptive-learning-plan`.
- База feature: `089d0cd`.
- База финального Ticket 06: `5c4a3f5`.
- Режим: локальная разработка и проверка без push, merge, deploy, feature flag, staging/production
  mutations, production-данных и платных provider-вызовов.

Финальный SHA Ticket 06 создаётся одним локальным commit после включения этого документа. SHA самого
commit намеренно не записывается внутрь него; он передаётся владельцу вместе с итоговым `git status`.

## Что доказано

- Chromium проходит полный Words 2.0 путь с клавиатуры и на viewport 375×812 с reduced motion:
  главная, библиотека, карточка, активное воспроизведение, ошибка/повтор и итог тренировки.
- Завершённая без сети обычная словарная сессия остаётся в owner-bound ограниченной очереди. После
  восстановления сети один UUID сохраняется на сервере ровно один раз; повторный flush не создаёт
  дубль.
- Смена аккаунта во время незавершённого flush не смешивает очереди, не очищает прогресс другого
  owner и не переносит общий baseline. Небезопасная глобальная очередь progress v2 удаляется
  fail-closed; новая v3 разделена по owner.
- Обычный результат остаётся `client_reported`: objective, guided и self-reported counters не
  превращаются в server-trusted mastery. Очередь не хранит слова, ответы, prompts, transcripts или
  audio и очищается при удалении аккаунта.
- File repository tests подтверждают owner isolation, idempotency, export/delete и совместимость
  richer/legacy word progress. Текущий Ticket 06 не меняет schema, migrations или repository code.
- Автоматические browser tests блокируют/подменяют внешние AI/TTS пути; реальных provider-вызовов не
  было.

## Финальные проверки

Все команды выполнялись из каталога `server` на Windows через `npm.cmd`.

| Команда | Exit | Результат |
|---|---:|---|
| `npm.cmd run lint` | 0 | ESLint без ошибок. |
| `npm.cmd run check` | 0 | 238 JS-файлов; 180 inline handlers, 124 имени — все разрешаются. |
| `npm.cmd test` | 0 | 720 total: 705 pass, 0 fail, 15 ожидаемых skip. |
| `npm.cmd run build:frontend` | 0 | 17 verified assets; shell — 313.0 KB JS, 5 lazy chunks. |
| `npm.cmd run test:e2e` | 0 | Demo/critical Chromium и полный vocabulary library + authenticated offline-sync прошли. |
| `npm.cmd run test:e2e:adaptive` | 0 | Diagnostic, vocabulary client module, exam launch и exact writing execution прошли. |
| `npm.cmd run test:e2e:performance` | 0 | LCP 60 ms, CLS 0.000, INP 104 ms, first JS 96.9 KB; все бюджеты пройдены. |
| `node --test test/frontend-offline-contract.test.js test/frontend-words.test.js test/security-regression.test.js` | 0 | 54/54 pass после финального owner-switch hardening. |
| `npm.cmd run security:secrets` | 0 | Финальный staged/tracked candidate проверен, совпадений нет. |
| `npm.cmd run security:history` | 0 | История проверена, совпадений нет. |
| `git diff --cached --check` | 0 | Whitespace errors нет. |

## PostgreSQL и review infrastructure

Последний живой disposable PostgreSQL-прогон этого feature после Ticket 05 прошёл все 40 migrations
и 15/15 PostgreSQL contract tests с последующей очисткой контейнера. Повтор Ticket 06 был запущен, но
Docker-доступ потребовал escalation, а approval stream оборвался; повторять или обходить отклонённое
разрешение не стали. Поскольку Ticket 06 не меняет DB/repository/migrations, актуальные file/shared
контракты и полный test suite используются как финальное доказательство его diff; это не выдаётся за
новый живой PostgreSQL-прогон.

Основной и один повторный Ticket 06 agent оборвались до правок из-за stream disconnect. Попытки
независимых Standards/Spec reviewers также не дали результата по той же инфраструктурной причине.
После исчерпания разрешённого retry выполнен локальный fallback-аудит всего Ticket 06 и feature diff:
незакрытых P0–P2 не найдено. В ходе аудита дополнительно найден и устранён риск cross-account race
при незавершённой синхронизации; он закреплён функциональными тестами.

## Остаточные границы

- Не проверялись физическое устройство, реальная установка PWA, production latency/billing и
  многодневная педагогическая эффективность.
- Не выполнялись push, PR, merge, deploy или включение feature flag. Production rollout остаётся
  отдельным решением владельца после staging smoke и backup.
- Из предыдущего Ticket 02 остаётся неблокирующий P3-долг: дублирование части E2E harness и нескольких
  state/provenance constants. Он не влияет на текущие пользовательские и security contracts.

Rollback до rollout: отменить локальный Ticket 06 commit. После rollout миграции данных автоматически
не откатывать; сначала выключить feature flag и проверить owner isolation/idempotency.
