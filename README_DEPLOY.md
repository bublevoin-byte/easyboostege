# Easy Boost: production-развёртывание

Приложение состоит из Node.js/Express-сервера, статического frontend, Telegram-входа, PostgreSQL и серверных интеграций xAI/Groq. В production файловое хранилище запрещено.

Перед релизом пройдите `RELEASE_CHECKLIST.md`.

## Frontend-модули

`index.html` подключает **одну** точку входа — `<script type="module" src="/main.js">`. Всё остальное
`main.js` тянет сам, статическими импортами в том порядке, в котором они перечислены ниже. Порядок
значим: модули публикуют свои имена через `window`, и перестановка превращает их в `undefined` ещё до
первого экрана.

Оболочка — то, что приезжает при первой загрузке:

- `globals.js` — публикация имён модуля на `window` геттерами; тем же механизмом пользуется загрузчик чанков;
- `api.js` и `auth.js` — серверные запросы и cookie-сессия;
- `sync.js` и `store.js` — offline-синхронизация, локальный снимок прогресса и восстановление без сети;
- `components.js` — общие безопасные UI-примитивы;
- `router.js` и `learning.js` — навигация и общие алгоритмы обучения;
- `modules/words.js` — SRS-статистика, дневная очередь, режимы упражнений, миграция и объединение AI-словаря;
- `modules/grammar.js` — нормализация ответов, карта прогресса, очереди практики и интервальное повторение грамматики;
- `modules/reading.js` — статистика чтения, перемешивание вариантов, уникальный выбор и подсчёт экзамена;
- `modules/listening.js` — статистика аудирования, перемешивание соответствий, лимит воспроизведений и подсчёт экзамена;
- `modules/writing.js` — лимиты объёма 37/38, счётчик слов, банк тем и черновики, история работ, payload и валидация ИИ-тем, офлайн-разбор;
- `modules/speaking.js` — экзаменационные тайминги четырёх заданий, статистика и средний балл, выбор MIME записи, комплекты заданий, ограничение оценок ИИ и подсчёт устного экзамена;
- `modules/exam.js` — общие правила пробных экзаменов: запись попытки, длительность, разделы и слабое место, значок результата и тело `module-attempts`;
- `modules/progress.js` — обратный отсчёт до ЕГЭ, дневная норма минут, нормализация показателей шести модулей и подписи серии и словаря;
- `modules/profile.js` — отображаемое имя и инициал, приветствие и три состояния подписки с текстом и цветами;
- `app.js` — запуск и общая конфигурация: вход, демо-режим, карты маршрутов, главный экран, сводки плиток и набор слов `EGE_WORDS`;
- `screens/words.js`, `screens/grammar.js`, `screens/progress.js` — экраны, которые раздел 6.1 ТЗ обещает без сети, поэтому они статические;
- `privacy.js`, `tts.js`, `pwa.js` — согласия и экспорт данных, озвучка, регистрация service worker.

Пять остальных экранов — `screens/listening.js`, `screens/reading.js`, `screens/writing.js`,
`screens/speaking.js`, `screens/profile.js` — при первой загрузке не запрашиваются. Их регистрирует
`screens.js`, а `router.js` подгружает динамическим `import()` при первом переходе на экран; второй
переход не даёт ни одного запроса. Неудачная загрузка чанка даёт видимое состояние с повторной
попыткой, а не пустой экран.

Состав первой загрузки закреплён тестом `e2e/performance.test.js`: он падает и если ленивый экран
приедет при старте, и если статический не приедет. Экран сопоставляется с файлом по манифесту
сборки, потому что в `dist/public` имена хешированные, а три статических экрана вовсе растворяются
в точке входа.

## Сборка frontend

```bash
npm run build:frontend
```

Собирает `public/` в `dist/public` через Vite (`vite.config.js`, `root: 'public'`): бандлинг,
минификация, хешированные имена, автоматическое разделение динамических `import()` на чанки.
Проверяет целостность — отсутствующий или неверный импорт, статический или динамический, валит
сборку, — и подставляет в service worker список оболочки по манифесту сборки. Результат встаёт на
место прежнего последним шагом, уже проверенным: недособранный каталог сервер бы отдал наравне с
полным. `vite` живёт в `devDependencies` и в production-образ не попадает.

**Сервер отдаёт `dist/public`, если каталог существует, и `public/` иначе.** Один и тот же каталог
используется для статики, SPA-fallback и подсчёта хешей инлайновых скриптов под CSP: считать
политику по одной разметке, а отдавать другую нельзя. Строка запуска в логе называет выбранный
источник. Разработка от этого не зависит — на чистом клоне `npm start` работает из `public/` без
сборки, и все тесты читают исходники оттуда же.

**Перед `docker compose build` эту команду выполнять не нужно.** Frontend собирает отдельная стадия
`Dockerfile` из тех же исходников, а `.dockerignore` исключает `dist/`, поэтому каталог с рабочей
машины в контекст сборки не попадает вовсе. Содержимое образа определяется репозиторием, а не тем,
что случайно лежит на диске: ни отсутствующая, ни устаревшая локальная сборка на образ не влияют.
Стадия сборки ставит полный набор зависимостей, финальный образ — по-прежнему `npm ci --omit=dev`,
так что `vite` в него не попадает.

Вес первой загрузки, замер 30 июля 2026 года: исходники — 26 файлов, 229 КБ несжатого JavaScript,
81,9 КБ по сети; сборка — 1 файл, 165 КБ несжатого, 54,5 КБ по сети. Бюджет спеки — 150 КБ.

**Service worker и обновление.** Список файлов оболочки `APP_SHELL` в `public/service-worker.js`
генерирует сборка: с хешированными именами вести его руками нельзя. В исходнике лежит вариант без
хешей — для случая, когда сервер отдаёт `public/`; `npm run build:frontend` сверяет его с графом
статических импортов `main.js` и падает при расхождении, так что и он не разъезжается молча.
Пяти ленивых чанков в списке нет намеренно: они попадают в кэш в обработчике `fetch`, когда ученик
впервые открывает свой экран, — поэтому офлайн-запуск открывает уже виденные экраны. Имя кэша
больше не поднимают руками: оно считается по самому списку, а в сборке любое изменение содержимого
меняет хеш в имени файла, а значит и имя кэша. Ученику ничего сбрасывать вручную не нужно —
`pwa.js` показывает уведомление о новой версии, а `skipWaiting` применяет её.

Общие правила доступности: интерактивные элементы — только `button`, `a`, `input`, `textarea`; классы `.cardbtn` и `.iconbtn` сбрасывают вид кнопки; вердикт ответа задаётся через `EasyBoostComponents.markAnswer`, состояния операций — через `EasyBoostComponents.renderState`. Тест `test/frontend-accessibility.test.js` пересчитывает контраст текста и не пропускает значения ниже 4.5:1.

## Backend-модули

`server.js` собирает приложение и владеет только конфигурацией, общими middleware и завершением работы:

- `middleware/authentication.js` — сессионный JWT, HttpOnly cookie, роли и токен мониторинга;
- `middleware/subscription.js` — активная подписка, согласия на обработку, дневной бюджет ИИ и почасовые лимиты;
- `services/subscription.js` — правила пробного периода и оплаты, без обращений к Telegram;
- `services/telegram.js` — транспорт бота: polling, сообщения и inline-кнопки;
- `routes/users.js` — вход по Telegram, сессия, экспорт и удаление аккаунта, согласия, админ- и internal-метрики;
- `routes/progress.js` — прогресс, модульное слияние, попытки, словарь и банк ошибок;
- `ai/operations.js` — реестр ИИ-операций: лимит токенов, таймаут, часовой лимит, правило fallback и версия промпта для каждой;
- `routes/ai.js` — серверные ИИ-операции с выбором провайдера, кэшем, очередью и учётом стоимости;
- `routes/media.js` — TTS с дисковым кэшем и STT с ограничениями загрузки.

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
npm ci
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
npm ci
docker compose -f compose.production.yml build app
docker compose -f compose.production.yml up -d app
docker compose -f compose.production.yml ps
curl --fail http://127.0.0.1:3000/health/ready
```

Не удаляйте volume `postgres-data` при обновлении.

Если обновление меняло файлы в `public/`, отдельного шага не требуется: имя кэша и список
`APP_SHELL` для service worker считает сборка frontend, а её выполняет стадия сборки образа — см.
«Сборка frontend». Сбрасывать кэш на устройстве ученика не нужно и нельзя: он получит уведомление
о новой версии сам.

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

## Версия API

Все маршруты приложения опубликованы под `/api/v1/`. Служебные `/health/live`,
`/health/ready` и `/internal/metrics` версии не имеют — они не часть продуктового контракта.
Неизвестный путь под `/api/` отвечает JSON-ошибкой `UNKNOWN_ENDPOINT` со статусом 404,
а не HTML-оболочкой приложения.

`API_ACCEPT_LEGACY_PATHS=true` (значение по умолчанию) заставляет сервер принимать
и старые пути без версии: они переписываются в `/api/v1/...`, а в лог один раз на
маршрут пишется предупреждение `api_legacy_path`. Слой нужен ровно для одного случая —
устройство с закэшированной прежней сборкой PWA продолжает работать сразу после деплоя,
пока не заберёт новую.

Порядок вывода из эксплуатации:

1. Развернуть новую версию, оставив `API_ACCEPT_LEGACY_PATHS=true`.
2. Наблюдать за `api_legacy_path` в логах. Пока предупреждения появляются, где-то
   живёт старый клиент.
3. Когда за сутки не осталось ни одного предупреждения — поставить
   `API_ACCEPT_LEGACY_PATHS=false` и перезапустить. Старые пути начнут отвечать 404.

Оставлять слой включённым бессрочно нельзя: тогда версия в адресе перестаёт что-либо значить.

## Защитные ограничения

- production требует PostgreSQL и JWT secret длиной от 32 символов;
- session JWT хранится в `HttpOnly; SameSite=Lax` cookie;
- изменяющие cookie-запросы сверяются с `APP_URL`;
- JSON API ограничен 1 МБ, прогресс — 512 КБ и структурными лимитами;
- Telegram-вход и дорогие AI/TTS/STT операции ограничены по частоте;
- Telegram login codes одноразовые и хранятся только в виде SHA-256 hash.
- AI API keys используются только сервером; frontend очищает старые browser-managed ключи и не обращается к провайдерам напрямую.
- Telegram updates валидируются по ограниченной серверной схеме до обработки.
- Сгенерированные ИИ строки с HTML-разметкой отклоняются до передачи во frontend, а вывод модели попадает в DOM только экранированным.
- Текст ученика и расшифровка STT нормализуются на границе API: снимаются управляющие символы, невидимые и bidi-символы, HTML-теги и комментарии.
- Причина переключения на резервного провайдера пишется в `ai_requests.fallback_reason`.
- Одинаковые сгенерированные задания берутся из общего кэша по хешу запроса, а не генерируются заново для каждого ученика.
- Запросы без сессии ограничены по адресу: `ANONYMOUS_REQUESTS_PER_15_MINUTES` (по умолчанию 300).
- CI сканирует на секреты как рабочее дерево, так и полную Git-историю (`npm run security:history`).
- CSP разрешает только hashed inline scripts и свой origin для сетевых запросов; frames и object/embed запрещены. Inline styles и event handlers пока разрешены: разметка `index.html` вызывает обработчики атрибутами `onclick`, и разделение frontend на модули этого не отменило. Разрешимость каждого имени проверяет `scripts/check-inline-handlers.js` в составе `npm run check` — включая имена, которые приезжают вместе с ленивым чанком.

Лимиты каждой ИИ-операции заданы в `ai/operations.js`; переменные окружения работают как потолок и могут только ужесточить их: `AI_REQUESTS_PER_HOUR` ограничивает часовой лимит, `AI_MAX_TIMEOUT_MS` — таймаут. Одновременных обращений к провайдеру не больше `AI_MAX_CONCURRENT_REQUESTS` (по умолчанию 4), остальные ждут очереди и получают `AI_QUEUE_TIMEOUT`, если ожидание затянулось.

Лимиты настраиваются через `SESSION_DAYS`, `TELEGRAM_AUTH_CODE_TTL_MS`, `TELEGRAM_AUTH_STARTS_PER_15_MINUTES`, `TELEGRAM_AUTH_CHECKS_PER_15_MINUTES`, `AI_TIMEOUT_MS`, `AI_REQUESTS_PER_HOUR`, `WRITING_REQUESTS_PER_HOUR`, `TTS_REQUESTS_PER_HOUR` и `STT_REQUESTS_PER_HOUR`.

## Проверка перед релизом

```bash
npm ci
npm run check
npm test
npm run test:postgres
npm run test:e2e
npm run build:frontend
npm run test:e2e
docker compose -f compose.production.yml config
```

`npm run test:e2e` выполняется дважды намеренно: до сборки сервер отдаёт `public/`, после —
`dist/public`. Оба пути должны быть зелёными; в production уезжает второй. CI устроен так же.

CI выполняет чистую установку, синтаксическую проверку и тесты на Node.js 22.
Локально и в CI PostgreSQL integration запускается одной командой `npm run test:postgres`. Она
использует отдельный `compose.test.yml`, ждёт healthcheck PostgreSQL 17, применяет все миграции,
выполняет repository integration без skip и затем удаляет test-контейнер, сеть и volume. Compose
использует локальный образ или загружает `postgres:17-alpine`, если его ещё нет; отдельный CI-путь
для миграций не нужен.
Chromium E2E использует установленный Chrome/Edge/Chromium; нестандартный путь можно передать через `CHROME_PATH`. Firefox E2E запускается командой `npm run test:e2e:firefox`. Мобильные профили запускаются командами `npm run test:e2e:android` (Pixel/Chromium с touch и мобильным user-agent) и `npm run test:e2e:iphone-webkit` (iPhone/WebKit). Firefox и WebKit runtime устанавливаются через `npx playwright install firefox webkit`.

Мобильные профили являются автоматической проверкой движка и адаптивного интерфейса, но не заменяют финальный приёмочный прогон на физическом iPhone Safari и Android Chrome.

`npm run test:e2e:performance` измеряет показатели раздела 19 на живом приложении и держит пять бюджетов: LCP, CLS, INP, задержку появления индикатора проверки ИИ и вес JavaScript первой загрузки. Запускается отдельно от функционального набора, потому что тайминги шумные. На 30 июля 2026 года все пять в бюджете: LCP 92–100 мс (2500), CLS 0.000 (0.1), INP 56 мс (200), индикатор 34–36 мс (200), первая загрузка 81,9 КБ по сети на исходниках и 54,5 КБ на сборке (150 КБ). Кроме бюджетов проверяется состав первой загрузки: ни один из пяти ленивых экранов не имеет права приехать при старте, а все три экрана раздела 6.1 обязаны приехать. Каждый бюджет печатается до падения, поэтому одно превышение не скрывает состояние остальных, и команда годится как release gate. Как измеряется и почему вес снимается на отдельном контексте с отключённым service worker — в [`docs/PERFORMANCE_BASELINE.md`](docs/PERFORMANCE_BASELINE.md).

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
