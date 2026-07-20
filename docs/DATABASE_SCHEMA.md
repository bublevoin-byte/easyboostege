# Схема базы данных

Источником истины являются SQL-файлы в `migrations/`.

| Таблица | Назначение | Ключевые данные |
|---|---|---|
| `schema_migrations` | применённые миграции | `version`, `applied_at` |
| `users` | аккаунты Telegram/legacy | `username`, `telegram_id`, subscription fields |
| `user_progress` | JSONB-прогресс пользователя | `username`, `data`, `updated_at` |
| `telegram_auth_codes` | одноразовые коды входа | hash кода, expiry, consumed state |
| `writing_attempts` | попытки заданий 37/38 | assignment, answer, review, provider status |
| `ai_requests` | технический журнал ИИ | operation, provider, model, duration, status, error code |

Связи привязаны к `users.username`; API всегда определяет пользователя из HttpOnly-сессии. Изменения схемы добавляются новой нумерованной миграцией и проверяются `npm run db:migrate`.
