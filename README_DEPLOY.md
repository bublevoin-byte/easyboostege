# Easy Boost: production-развёртывание

Приложение состоит из Node.js/Express-сервера, статического frontend, Telegram-входа, PostgreSQL и серверных интеграций xAI/Groq. В production файловое хранилище запрещено.

## Требования

- Docker Engine с Compose v2;
- домен с HTTPS на reverse proxy;
- PostgreSQL 17 (включён в `compose.production.yml`);
- Telegram bot token;
- минимум один AI API key: xAI или Groq.

## Настройка

Создайте `.env` из `.env.example`. Обязательные production-значения:

```env
NODE_ENV=production
APP_URL=https://example.ru
JWT_SECRET=случайная-строка-минимум-32-символа
POSTGRES_PASSWORD=отдельный-длинный-пароль
TELEGRAM_BOT_TOKEN=...
ADMIN_TELEGRAM_ID=...
XAI_API_KEY=...
```

Не коммитьте `.env`. `APP_URL` должен точно совпадать с внешним origin: схема, домен и нестандартный порт, если он есть.

## Первый запуск

```bash
docker compose -f compose.production.yml config
docker compose -f compose.production.yml build
docker compose -f compose.production.yml up -d
docker compose -f compose.production.yml ps
```

Контейнер приложения автоматически выполняет SQL-миграции перед запуском сервера. Порт приложения доступен только на `127.0.0.1:3000`; наружу его должен публиковать HTTPS reverse proxy.

Проверка:

```bash
curl --fail http://127.0.0.1:3000/health/live
curl --fail http://127.0.0.1:3000/health/ready
docker compose -f compose.production.yml logs --tail=100 app
```

## Обновление

Перед обновлением сделайте backup PostgreSQL. Затем:

```bash
git pull --ff-only
docker compose -f compose.production.yml build app
docker compose -f compose.production.yml up -d app
docker compose -f compose.production.yml ps
curl --fail http://127.0.0.1:3000/health/ready
```

Не удаляйте volume `postgres-data` при обновлении.

## Откат приложения

Переключитесь на предыдущий проверенный commit/tag, пересоберите `app` и снова проверьте readiness. Миграции должны оставаться обратно совместимыми; автоматического отката схемы нет.

## Импорт старого data.json

После запуска PostgreSQL сначала выполните dry-run:

```bash
docker compose -f compose.production.yml run --rm app npm run db:import-json -- /backup/data.json --dry-run
```

Для реального импорта файл должен быть доступен внутри контейнера через read-only bind mount. Исходный файл скрипт не удаляет.

## Наблюдаемость

- `GET /health/live` — процесс принимает запросы;
- `GET /health/ready` — приложение и БД готовы;
- каждый ответ содержит `X-Request-Id`;
- HTTP-события и ошибки пишутся в stdout как JSON без токенов и пользовательских работ.

## Защитные ограничения

- production требует PostgreSQL и JWT secret длиной от 32 символов;
- session JWT хранится в `HttpOnly; SameSite=Lax` cookie;
- изменяющие cookie-запросы сверяются с `APP_URL`;
- JSON API ограничен 1 МБ, прогресс — 512 КБ и структурными лимитами;
- Telegram-вход и дорогие AI/TTS/STT операции ограничены по частоте;
- Telegram login codes одноразовые и хранятся только в виде SHA-256 hash.

Лимиты настраиваются через `SESSION_DAYS`, `TELEGRAM_AUTH_CODE_TTL_MS`, `TELEGRAM_AUTH_STARTS_PER_15_MINUTES`, `TELEGRAM_AUTH_CHECKS_PER_15_MINUTES`, `AI_TIMEOUT_MS` и `AI_REQUESTS_PER_HOUR`.

## Проверка перед релизом

```bash
npm ci
npm run check
npm test
docker compose -f compose.production.yml config
```

CI выполняет чистую установку, синтаксическую проверку и тесты на Node.js 22.
