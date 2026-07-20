# Схема базы данных

Источником истины являются SQL-файлы в `migrations/`.

| Таблица | Назначение | Ключевые данные |
|---|---|---|
| `schema_migrations` | применённые миграции | `version`, `applied_at` |
| `users` | аккаунты Telegram/legacy и роли | `username`, `telegram_id`, `role`, subscription fields |
| `sessions` | серверные пользовательские сессии | `id`, `username`, expiry, revoke timestamp |
| `subscriptions` | текущее состояние доступа | `username`, status, source, start/end timestamps |
| `payment_requests` | ручные заявки на оплату | status, administrator, result and resolution time |
| `user_progress` | JSONB-прогресс пользователя | `username`, `data`, `updated_at` |
| `telegram_auth_codes` | одноразовые коды входа | hash кода, expiry, consumed state |
| `writing_attempts` | попытки заданий 37/38 | assignment, answer, review, provider status |
| `speaking_attempts` | текстовые результаты устной части | assignment, transcript, review, provider status; audio is not stored |
| `generated_tasks` | валидированные результаты генерации | operation, versioned request hash, request/result and provider |
| `ai_requests` | технический журнал ИИ | operation, provider, model, duration, status, error code, tokens, estimated cost |

Связи привязаны к `users.username`; API всегда определяет пользователя из HttpOnly-сессии. Изменения схемы добавляются новой нумерованной миграцией и проверяются `npm run db:migrate`.
