# Easy Boost

Backend и PWA для подготовки к ЕГЭ по английскому языку.

## Локальный запуск

Требования: Node.js 22+, npm и, для production-подобного режима, PostgreSQL 17.

```bash
cp .env.example .env
npm ci
npm run check
npm test
npm start
```

По умолчанию development использует файловое хранилище. Приложение откроется на `http://localhost:3000`. Telegram-вход и внешние ИИ-провайдеры без ключей отключены; для просмотра встроенных заданий используйте demo mode.

## PostgreSQL

Укажите `DATABASE_PROVIDER=postgres` и `DATABASE_URL`, затем выполните:

```bash
npm run db:migrate
```

Repository integration запускается отдельно и не требует локального `.env`:

```bash
npm run test:postgres
```

Команда использует `compose.test.yml`: поднимает отдельную PostgreSQL 17 на случайном loopback-порту,
ждёт healthcheck, применяет все миграции, запускает только `test/postgres-repository.test.js` без
skip и в любом исходе удаляет test-контейнер, сеть и volume. Для защиты от случайного обращения к
production/staging она сама задаёт test-only URL и использует уникальный Compose project; образ
`postgres:17-alpine` автоматически загружается Docker только если его ещё нет локально.

Production-развёртывание, backup, restore и rollback описаны в [README_DEPLOY.md](./README_DEPLOY.md). API — в [docs/openapi.yaml](./docs/openapi.yaml).

## Frontend-архитектура

Frontend использует обычный JavaScript с отдельными слоями: `api.js` отвечает за HTTP, `auth.js` — за login, cookie-сессию и Telegram-вход, `sync.js` — за очередь прогресса, `store.js` — за нормализацию, локальное хранение и единый доступ к синхронизации, `router.js` — за навигацию, `learning.js` — за детерминированную учебную логику. `app.js` пока содержит экраны и предметные модули; их перенос выполняется инкрементально под E2E-защитой.

Никогда не коммитьте `.env`, дампы БД и реальные токены. Перед PR выполните `npm run security:secrets`, `npm run security:history` и `npm run audit:production`.
