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
npm test
```

Production-развёртывание, backup, restore и rollback описаны в [README_DEPLOY.md](./README_DEPLOY.md). API — в [docs/openapi.yaml](./docs/openapi.yaml).

Никогда не коммитьте `.env`, дампы БД и реальные токены. Перед PR выполните `npm run security:secrets` и `npm run audit:production`.
