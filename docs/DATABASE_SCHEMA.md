# Схема базы данных

Источником истины являются SQL-файлы в `migrations/`.

| Таблица | Назначение | Ключевые данные |
|---|---|---|
| `schema_migrations` | применённые миграции | `version`, `applied_at` |
| `users` | аккаунты Telegram/legacy и роли | `username`, `telegram_id`, `role`, subscription fields |
| `sessions` | серверные пользовательские сессии | `id`, `username`, expiry, revoke timestamp |
| `subscriptions` | текущее состояние доступа | `username`, status, source, start/end timestamps |
| `subscription_entitlements` | отдельные тарифные права Premium | `username`, entitlement, start/end timestamps |
| `voice_tutor_sessions` | голосовая квота и структурированный ход разбора без аудио и полного transcript | bounded capsule, delivery/state/outcome, micro-check/transfer flags, reserved/billable seconds and timestamps |
| `payment_requests` | ручные заявки на оплату | status, administrator, result and resolution time |
| `user_progress` | JSONB-прогресс пользователя | `username`, `data`, `updated_at` |
| `telegram_auth_codes` | одноразовые коды входа | hash кода, expiry, consumed state |
| `writing_attempts` | журнал пользовательских прогонов заданий 37/38 | assignment, answer, evaluated_answer, review, provider, model, prompt_version, status, error_code |
| `speaking_attempts` | журнал пользовательских прогонов устной части | assignment, transcript, review, provider, model, prompt_version, status, error_code; audio is not stored |
| `generated_tasks` | валидированные результаты генерации | operation, versioned request hash, request/result and provider |
| `module_attempts` | нормализованная история учебных результатов | module, activity, score, duration and bounded metadata |
| `progress_summary` | серверная агрегированная сводка прогресса | attempts, best normalized score, total duration and last attempt |
| `word_progress` | состояние интервального повторения слов | word, stage, errors, reviews and due time |
| `error_bank` | агрегированный банк учебных ошибок | module, item key, type, bounded details and occurrence count |
| `audit_log` | неизменяемый журнал административных действий | actor, action, target, result and bounded metadata |
| `ai_requests` | технический журнал ИИ | operation, provider, model, duration, status, error code, tokens, estimated cost |

Связи привязаны к `users.username`; API всегда определяет пользователя из HttpOnly-сессии. Изменения схемы добавляются новой нумерованной миграцией и проверяются `npm run db:migrate`.

`writing_attempts` и `speaking_attempts` — пользовательские данные, а не эталонная выборка:
запись в этих таблицах не даёт ответу экспертной оценки и не создаёт пути автоматического импорта
в `quality/`. Они включаются в экспорт аккаунта и удаляются каскадно вместе с пользователем.
Миграция `019_attempt_models.sql` добавляет nullable-поле `model`, поэтому прежние строки остаются
валидными с неизвестной моделью (`NULL`), а новые завершённые прогоны сохраняют полную тройку
`provider`, `model`, `prompt_version`.

Миграция `020_writing_evaluated_answer.sql` добавляет обязательный `evaluated_answer`. Для прежних
строк он заполняется полным `answer`; в новых попытках `answer` хранит весь очищенный ответ, а
`evaluated_answer` — ровно тот фрагмент, который получил провайдер. Оба поля входят в экспорт и
удаляются каскадно вместе с аккаунтом.

Миграция `021_voice_tutor_entitlements_and_quotas.sql` не повышает существующие подписки до
Premium: без отдельной строки `voice_tutor` пользователь остаётся на базовом тарифе. Резерв квоты
и единственная активная сессия защищены транзакционной блокировкой пользователя и уникальным
частичным индексом. Записи входят в экспорт и удаляются каскадно вместе с аккаунтом; аудио и
свободный transcript в таблице отсутствуют.

Миграция `022_voice_tutor_tracer.sql` добавляет bounded server-owned capsule, hash одноразового
nonce, способ доставки и конечное педагогическое состояние. Исходный ответ проверяется сервером до
создания capsule и в нормализованном bounded-виде остаётся только в metadata исходной
`module_attempt`: так каждый следующий AI-text turn может заново собрать точный контекст по
server-owned attempt id. В `voice_tutor_sessions`, её capsule и экспорт этой таблицы ответ не
копируется. В записи сессии остаются только результаты micro-check/transfer и технический outcome;
аудио и временные субтитры не записываются.
Для reading/listening capsule сохраняет только server-owned фрагмент текущего пункта до 600
символов (`source_excerpt` или `transcript_segment`), но не полный текст/транскрипт и не ответы
соседних пунктов попытки. Такие ошибки нельзя создать по одному присланному варианту: endpoint
`/api/v1/voice-tutor/context-attempts` сначала сверяет весь завершённый набор и все ответы с
канонической ревизией. Он сохраняет родительскую `voice_tutor_context_result` и детерминированные
дочерние `voice_tutor_error`; только дочерняя запись с marker родительской проверки допускается к
созданию reading/listening capsule. Для ИИ-наборов server-issued идентификатор связывает request
hash и digest точного typed result из пользовательской строки `generated_tasks`; перед созданием
результата и при каждом fallback сервер заново загружает эту owner-bound запись, проверяет digest и
валидирует typed result, а не доверяет присланному клиентом тексту. Повтор result UUID допустим
только с тем же hash нормализованных ответов и возвращает те же детерминированные child IDs.

## Проверка миграций и repository

```bash
npm run test:postgres
```

Команда создаёт уникальный Compose project из `compose.test.yml` с базой
`easyboost_repository_test`, применяет каждый файл из `migrations/` через `scripts/migrate.js` и
проверяет публичный `createPostgresRepository` на реальной PostgreSQL 17. Порт публикуется только на
loopback и выбирается автоматически. Переданный извне `DATABASE_URL` не используется: runner задаёт
test-only URL сам. В блоке `finally` выполняется `docker compose down --volumes --remove-orphans`,
поэтому повторный прогон начинает с пустого volume и не зависит от прежних данных.

Обычный `npm test` сохраняет защитный skip этого integration-теста, если `TEST_DATABASE_URL` не
задан: он остаётся доступен в окружениях без Docker. Обязательный PostgreSQL gate локально и в CI —
именно `npm run test:postgres`: Docker использует локальный `postgres:17-alpine` или автоматически
загружает его на чистой машине.
