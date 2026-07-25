# Easy Boost: production-развёртывание

Приложение состоит из Node.js/Express-сервера, статического frontend, Telegram-входа, PostgreSQL и серверных интеграций xAI/Groq. В production файловое хранилище запрещено.

Перед релизом пройдите `RELEASE_CHECKLIST.md`.

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
npm run db:backup
git pull --ff-only
docker compose -f compose.production.yml build app
docker compose -f compose.production.yml up -d app
docker compose -f compose.production.yml ps
curl --fail http://127.0.0.1:3000/health/ready
```

Не удаляйте volume `postgres-data` при обновлении.

## Backup и восстановление PostgreSQL

Полный порядок аварийного восстановления, бюджет RTO и последний результат тренировки описаны в [`docs/DISASTER_RECOVERY.md`](docs/DISASTER_RECOVERY.md).

Создать атомарный backup в каталоге `backups/`:

```bash
npm run db:backup
```

Проверить последний архив реальным восстановлением в изолированную временную базу:

```bash
npm run db:verify-backup
```

Команда проверяет структуру архива, создаёт временную БД, выполняет `pg_restore`, проверяет основные таблицы и миграции, а затем удаляет временную БД. Рабочая база и приложение не останавливаются. Результат и длительность записываются в `backups/restore-check-status.json`.

Можно указать собственный путь: `npm run db:backup -- /secure/easyboost.dump`. Храните копии вне VPS и регулярно проверяйте восстановление на отдельном стенде.

Восстановление полностью заменяет содержимое базы из архива и требует явного подтверждения:

```bash
npm run db:restore -- /secure/easyboost.dump --confirm-restore
```

Скрипт сначала проверяет структуру архива, затем останавливает `app`, выполняет `pg_restore` и снова запускает приложение. Перед восстановлением сделайте дополнительную копию текущей базы.

Пример ежедневного cron с хранением 14 дней:

```cron
15 3 * * * cd /opt/easyboost && /usr/bin/npm run db:backup >> /var/log/easyboost-backup.log 2>&1
25 4 * * * find /opt/easyboost/backups -type f -name 'easyboost-*.dump' -mtime +14 -delete
20 5 1 * * cd /opt/easyboost && /usr/bin/npm run db:verify-backup >> /var/log/easyboost-restore-check.log 2>&1
```

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
- AI API keys используются только сервером; frontend очищает старые browser-managed ключи и не обращается к провайдерам напрямую.
- Telegram updates валидируются по ограниченной серверной схеме до обработки.
- Сгенерированные ИИ строки с HTML-разметкой отклоняются до передачи во frontend.
- CI сканирует на секреты как рабочее дерево, так и полную Git-историю (`npm run security:history`).
- CSP разрешает только hashed inline scripts и свой origin для сетевых запросов; frames и object/embed запрещены. Inline styles и event handlers временно разрешены до разделения монолитного frontend.

Лимиты настраиваются через `SESSION_DAYS`, `TELEGRAM_AUTH_CODE_TTL_MS`, `TELEGRAM_AUTH_STARTS_PER_15_MINUTES`, `TELEGRAM_AUTH_CHECKS_PER_15_MINUTES`, `AI_TIMEOUT_MS`, `AI_REQUESTS_PER_HOUR`, `WRITING_REQUESTS_PER_HOUR`, `TTS_REQUESTS_PER_HOUR` и `STT_REQUESTS_PER_HOUR`.

## Проверка перед релизом

```bash
npm ci
npm run check
npm test
npm run test:e2e
docker compose -f compose.production.yml config
```

CI выполняет чистую установку, синтаксическую проверку и тесты на Node.js 22.
PostgreSQL integration-тест запускается при наличии `TEST_DATABASE_URL`; CI поднимает для него отдельный PostgreSQL 17 и сначала применяет все миграции.
Chromium E2E использует установленный Chrome/Edge/Chromium; нестандартный путь можно передать через `CHROME_PATH`. Firefox E2E запускается командой `npm run test:e2e:firefox`. Мобильные профили запускаются командами `npm run test:e2e:android` (Pixel/Chromium с touch и мобильным user-agent) и `npm run test:e2e:iphone-webkit` (iPhone/WebKit). Firefox и WebKit runtime устанавливаются через `npx playwright install firefox webkit`.

Мобильные профили являются автоматической проверкой движка и адаптивного интерфейса, но не заменяют финальный приёмочный прогон на физическом iPhone Safari и Android Chrome.

Перед релизом также выполняйте `npm audit --omit=dev`. Текущий production dependency tree не содержит известных npm audit уязвимостей.

## Staging

Staging полностью отделён от production:

- каталог `/opt/easyboost-staging`;
- compose project `easyboost-staging`;
- PostgreSQL volume и база `easyboost_staging`;
- loopback-порт `127.0.0.1:3001`;
- файл секретов `.env.staging`;
- отдельные Telegram bot token, JWT secret, database password и AI budgets.

Первичная настройка на сервере:

```bash
install -d -m 755 /opt/easyboost-staging
install -m 600 .env.staging.example /opt/easyboost-staging/.env.staging
editor /opt/easyboost-staging/.env.staging
```

`APP_URL` должен быть staging-origin, например `https://staging.useboost.ru`. Не копируйте production secrets. До создания отдельного Telegram-бота и AI-ключей оставляйте эти интеграции выключенными.

Ручной неизменяемый deploy:

```bash
git archive --format=tar.gz --output=easyboost-staging-release.tar.gz HEAD
sha256sum easyboost-staging-release.tar.gz
sudo scripts/staging-deploy.sh easyboost-staging-release.tar.gz <sha256>
```

Скрипт сверяет checksum, перед обновлением создаёт PostgreSQL backup и архив кода для rollback, пересобирает контейнеры и ждёт readiness. Откат к последнему сохранённому коду:

```bash
sudo /opt/easyboost-staging/scripts/staging-rollback.sh
```

Workflow `.github/workflows/deploy-staging.yml` запускается вручную или при push в `main`/`production-hardening`. Для GitHub environment `staging` нужны secrets:

- `STAGING_HOST`;
- `STAGING_USER`;
- `STAGING_SSH_PRIVATE_KEY`;
- `STAGING_SSH_HOST_KEY` — полная закреплённая строка из `ssh-keyscan`, проверенная владельцем сервера.

На VPS должна быть установлена root-owned копия deploy script:

```bash
install -o root -g root -m 755 scripts/staging-deploy.sh /usr/local/sbin/easyboost-staging-deploy
```

Отдельному SSH-пользователю разрешается через `sudo` запускать только `/usr/local/sbin/easyboost-staging-deploy`; workflow загружает архив, но не исполняемый root-скрипт. Staging URL публикуется отдельным Cloudflare Tunnel route на `http://127.0.0.1:3001`; production route и контейнеры не изменяются.

### Нагрузочная и длительная проверка staging

Контролируемый smoke-тест по умолчанию создаёт 10 параллельных клиентов, ограничивает суммарную частоту 50 запросами в секунду и работает 30 секунд:

```bash
LOAD_TEST_URL=https://staging.useboost.ru npm run load:smoke
```

Gate требует минимум 100 запросов, error rate не выше 1% и p95 не выше 500 мс. Максимальные ограничения инструмента — 50 клиентов, 200 запросов/с и 5 минут; production URL не используется в эксплуатационной процедуре.

Один замер семидневного soak test:

```bash
STAGING_SOAK_URL=https://staging.useboost.ru \
STAGING_SOAK_DIR=/var/lib/easyboost-staging-soak \
npm run soak:check
```

Команда проверяет homepage и readiness, дописывает обезличенный NDJSON и атомарно обновляет `staging-soak-status.json`. Результат считается завершённым только после семи суток без неуспешных samples.

Установка изолированного systemd timer на VPS:

```bash
install -o root -g root -m 644 deploy/easyboost-staging-soak.service /etc/systemd/system/
install -o root -g root -m 644 deploy/easyboost-staging-soak.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now easyboost-staging-soak.timer
systemctl start easyboost-staging-soak.service
systemctl status easyboost-staging-soak.timer --no-pager
cat /var/lib/easyboost-staging-soak/staging-soak-status.json
```

Service запускается с `DynamicUser`, получает запись только в выделенный `StateDirectory` и не читает staging secrets.
