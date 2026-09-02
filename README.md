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

По умолчанию development использует файловое хранилище, а приложение открывается на
`http://127.0.0.1:3000/`. VK ID и внешние ИИ-провайдеры без конфигурации отключены; первый запуск
честно показывает недоступность входа. Ученические разделы, включая все 60 комплектов Reading 2.0,
открываются только после входа с активной серверной подпиской; локального учебного demo mode нет.
Telegram остаётся отдельным административным backend-контуром и не используется для входа ученика.

Для изолированной локальной проверки VK-потока без аккаунта провайдера укажите в `.env` строго
loopback-origin с тем же портом, что и сервер:

```dotenv
NODE_ENV=development
PORT=3000
APP_URL=http://127.0.0.1:3000
VK_ID_MODE=local
```

Этот режим запрещён для production, staging, preview, прокси и публичных URL. Live-настройка VK ID
и обязательные переменные перечислены в [README_DEPLOY.md](./README_DEPLOY.md).

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

Frontend использует обычный JavaScript с отдельными слоями: `theme-prepaint.js` применяет тему до
первой отрисовки; `first-launch.js` управляет заставкой, onboarding, discovery провайдера и приватным
JSON-handoff; `auth.js` читает текущую cookie-сессию и выполняет logout; `api.js` отвечает за HTTP;
`sync.js` — за очередь прогресса; `store.js` — за нормализацию, локальное хранение и единый доступ к
синхронизации; `router.js` — за навигацию; `learning.js` — за детерминированную учебную логику.
Серверные `routes/vk-auth.js` и `services/vk-id.js` владеют VK OAuth/PKCE-потоком и никогда не
передают provider tokens браузеру. Telegram-контур остаётся отдельным административным backend.
`app.js` пока содержит экраны и предметные модули; их перенос выполняется инкрементально под
E2E-защитой.

Никогда не коммитьте `.env`, дампы БД и реальные токены. Перед PR выполните `npm run security:secrets`, `npm run security:history` и `npm run audit:production`.
