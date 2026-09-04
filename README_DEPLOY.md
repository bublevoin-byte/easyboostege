# Easy Boost: production-развёртывание

Приложение состоит из Node.js/Express-сервера, статического frontend, ученического входа VK ID,
отдельного Telegram/admin-контура, PostgreSQL и серверных интеграций xAI/Groq. В production файловое
хранилище запрещено.

Перед релизом пройдите `RELEASE_CHECKLIST.md`.

## Frontend-модули

До первого stylesheet `index.html` синхронно подключает CSP-safe classic asset
`<script src="/theme-prepaint.js">`: он применяет сохранённую системную/светлую/тёмную тему до
первой отрисовки и не содержит inline-кода. После стилей подключается **одна module-точка входа** —
`<script type="module" src="/main.js">`. Остальные исполняемые модули `main.js` тянет сам,
статическими импортами в указанном ниже порядке. Порядок значим: модули публикуют свои имена через
`window`, и перестановка превращает их в `undefined` ещё до первого экрана.

Оболочка — то, что приезжает при первой загрузке:

- `globals.js` — публикация имён модуля на `window` геттерами; тем же механизмом пользуется загрузчик чанков;
- `theme-prepaint.js` — отдельный ранний classic asset первого paint; сборщик копирует и кэширует его как прямую зависимость HTML, а не как модульный импорт;
- `api.js` и `auth.js` — серверные запросы и cookie-сессия; learner credentials браузеру недоступны;
- `first-launch.js` — versioned splash/onboarding gate, provider discovery и переход на server-side VK ID flow;
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
- `app.js` — единый private startup coordinator: onboarding и `/me` идут параллельно, а login/strict access/Today выбираются только после обеих проверок;
- `screens/words.js` — eager-экран Слов; presentation Грамматики и top-level offline routes остаются
  сетево-ленивыми, но входят в отдельный install-time service-worker closure;
- `privacy.js`, `tts.js`, `pwa.js` — согласия и экспорт данных, озвучка, регистрация service worker.

Presentation Грамматики, Practice, ЕГЭ, Прогресс/Профиль, `screens/listening.js`,
`screens/reading.js`, `screens/writing.js`, `screens/speaking.js` и deep EGE screen при первой
загрузке не запрашиваются. Их регистрирует `screens.js`, а `router.js` подгружает динамическим
`import()` при первом переходе; второй переход не даёт повторного запроса. Неудачная загрузка чанка
даёт видимое состояние с повторной попыткой, а не пустой экран. Install-time cache и исполняемый
first-load graph проверяются отдельно, поэтому offline-ready не означает eager JavaScript.

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

**Перед `npm run production:image:build -- --expected-commit "$EASYBOOST_RELEASE_COMMIT"` frontend
отдельно собирать не нужно.** Единственный production-image wrapper сначала требует clean Git root
на полном owner-approved commit и обязательный `EASYBOOST_NODE_BASE_IMAGE` вида
`node:22-bookworm-slim@sha256:<64 lowercase hex>` из owner-reviewed release-записи. Mutable Node tag
не является authority. Затем wrapper сверяет все non-stage `COPY` inputs с точным объединением
`git ls-files` + audited candidate manifest. Первый проход открывает каждый regular file descriptor
без следования по symlink, фиксирует identity/bytes/SHA-256 и сканирует **все байты**, включая
PNG/gzip/dump. Второй проход тем же способом перечитывает файл целиком, повторно сверяет
identity/digest/secret policy и передаёт этот же проверенный `Buffer` в deterministic USTAR stream.
Wrapper вызывает `docker build --file Dockerfile --tag easyboost-production-app:local -` с
`shell:false`; Docker не читает writable temporary directory. Изменённый или оборванный stream не
может считаться успешной tag-сборкой. Raw `docker compose ... build`/`up --build` закрыт отсутствующим
sentinel-context; обычный `up` использует local image с `pull_policy: never`.

`.dockerignore` сам по себе остаётся только списком именованных исключений: `dist/`, `.env*` (кроме
безопасного `.env.example`), `.scratch`, prototypes, QA/test/evidence и workspace debris. В частности,
`.env.staging` не входит в context или image. Финальная стадия не делает `COPY . .`: explicit runtime
allowlist копирует только root runtime files, необходимые runtime directories, `scripts/migrate.js`,
`scripts/import-json.js` с его explicit lock/bounded-child dependency closure и проверенный `dist/public`
из frontend stage. Стадия сборки получает явный
полный input closure (`public`, `shared`, build/PWA scripts и `pwa-compat`), а финальный образ —
`npm ci --omit=dev`, поэтому `vite` в него не попадает. Dockerfile contract test сверяет источники
named frontend stage и не позволяет забыть `shared`.

Исторический Cycle 8 performance-замер хранится только в
[`docs/PERFORMANCE_BASELINE.md`](docs/PERFORMANCE_BASELINE.md). Текущий финальный
`npm run test:release:aisy` прошёл: artifact
`d518f4a54e7b03beb357a69f7dc6380cd31befc5a11634c1ddd0df216021e290`, 26 уникальных Chromium-сценариев,
first-load JS 90.0 KB / 150 KB, LCP 108 ms, CLS 0.000, INP 64 ms; бюджет спеки не повышался.

**Service worker и обновление.** Список файлов оболочки `APP_SHELL` в `public/service-worker.js`
генерирует сборка: с хешированными именами вести его руками нельзя. В исходнике лежит вариант без
хешей — для случая, когда сервер отдаёт `public/`; `npm run build:frontend` сверяет его со всей
оболочкой первого запуска: графом статических импортов module-entry, прямыми classic scripts из
`index.html` (сейчас это `theme-prepaint.js`) и остальными обязательными статическими assets. При
расхождении сборка падает, поэтому ранний prepaint не может молча исчезнуть из offline closure.
Ленивые top-level маршруты Грамматики, Практики, ЕГЭ hub, Прогресса и Профиля входят в измеряемый
install-time offline closure, хотя не исполняются при первой загрузке. На чистой установке более
глубокие Reading, Listening, Writing, Speaking и exact EGE mock чанки попадают в runtime cache
только после первого явного открытия. При обновлении уже установленной версии worker отдельно
предзагружает и обновляет executable closure exact EGE mock даже без open-marker: это сохраняет
совместимость незавершённого пробника и не переносит эти чанки в clean-install `APP_SHELL`.
Кроме того, candidate image получает из `pwa-compat/` digest-verified hashed executable graph точного
d367 predecessor. Все 26 файлов добавляются по исходным URL в predecessor cache только при update,
поэтому уже открытый old document может впервые открыть свой deep chunk после публикации candidate.
Каждый действительно predecessor-only файл остаётся вне current/clean-install `APP_SHELL`. Пересечение
26 compatibility entries с shell — ровно два byte-identical пути, которые также являются outputs
текущей сборки и законно входят в current shell как её собственные зависимости:
`/assets/asya-assistant-1Lybndln.js` и
`/assets/reading-catalog-contract-HSvgPmNc.js`. Остальные 24 compatibility entries остаются вне shell;
часть из них совпадает с current lazy outputs, поэтому они не называются predecessor-only. Это не добавляет
predecessor-only код в initial execution. Docker stage получает artifact напрямую и не зависит от `.git`, прежнего `dist` или локальной
рабочей сборки.
Release id — SHA-256 worker policy и точных байтов каждого APP_SHELL response,
включая стабильные пути `manifest.json`, icons и `offline.html`; изменение любого из них создаёт
новое имя static cache. Install и runtime refresh current stable paths, а также current EGE compatibility
closure обходят browser HTTP cache, поэтому release id не соседствует со stale stable bytes. Первый
install активируется сразу, но новый worker при существующей версии остаётся waiting. `pwa.js` показывает
верхнее snoozeable in-app уведомление с «Позже», не перекрывает deep/in-progress action и возвращает
keyboard focus. Пока другая участвующая вкладка ещё не согласилась и consent quorum остаётся
незавершённым, Apply не активирует worker и не перезагружает текущую задачу; «Позже» скрывается,
focus возвращается в задачу, а live-status честно сообщает об ожидании других вкладок. Поскольку
controller один на origin, `SKIP_WAITING` выполняется
только после consent quorum всех живых учебных same-origin вкладок; закрытая вкладка выходит из quorum,
но «учебная» определяется положительно: legacy `/`/`/index.html` либо exact WindowClient с
`REGISTER_LEARNER_SHELL_CLIENT` handshake, включая app deep links. Health/API/internal/static/passive
documents и `/privacy.html`/`/offline.html` намеренно не участвуют. До quorum reload нет. Worker
проверяет закрытие каждые 250 мс в течение 60 секунд; Ticket 11 heartbeat приходит каждые 55 секунд.
Если прошлый цикл ещё активен, ставится ровно один следующий bounded cycle, без overlap и без
неограниченного `event.waitUntil`. После quorum каждая согласившаяся вкладка слушает `statechange`
своего exact consented waiting worker, дожидается его состояния `activated` и только тогда перезагружается.
Update-активация намеренно не вызывает `clients.claim()`, поэтому пассивные и несогласившиеся вкладки
не захватываются и не перезагружаются. `controllerchange` — только idempotent fallback для того же
согласованного worker в той же вкладке; общий guard допускает не более одной reload. Прежний cache
удаляется только после `CURRENT_CLIENT_READY` от всех live candidate documents и только по strict
immutable predecessor authority из compatibility record
(schema/full base commit/content SHA-256/exact cache name). Durable record bounded по schema/count/name
и 1024 bytes; missing/oversized/tampered authority означает `no prune`. Worker не сканирует broad prefix,
поэтому уже существующие C, colliding, foreign и unknown CacheStorage namespaces сохраняются.
Navigation/generic offline fallback всегда выбирает exact current cache, поэтому retained predecessor
или foreign same-URL entry не может подменить current root/lazy asset.

Exact d367 page сама знает только старое refresh-уведомление «Доступна новая версия… Обновите
страницу» и не содержит Ticket 11 Apply/heartbeat. Проверенный пользовательский путь: обычный online
reload через old network-first controller загружает candidate document, но controller остаётся old,
а worker — waiting; затем реальная focusable кнопка `#pwa_update_apply` записывает consent. Никакой
synthetic apply callback в доказательстве не вызывается. Old вкладка без reload остаётся nonconsenting,
может завершить задачу на упакованном old lazy graph и либо reload, либо закрыться.

Общие правила доступности: интерактивные элементы — только `button`, `a`, `input`, `textarea`; классы `.cardbtn` и `.iconbtn` сбрасывают вид кнопки; вердикт ответа задаётся через `EasyBoostComponents.markAnswer`, состояния операций — через `EasyBoostComponents.renderState`. Тест `test/frontend-accessibility.test.js` пересчитывает контраст текста и не пропускает значения ниже 4.5:1.

## Backend-модули

`server.js` собирает приложение и владеет только конфигурацией, общими middleware и завершением работы:

- `middleware/authentication.js` — сессионный JWT, HttpOnly cookie, роли и токен мониторинга;
- `services/vk-id.js` и `routes/vk-auth.js` — VK ID Authorization Code + PKCE, одноразовая транзакция и минимальная provider identity;
- `middleware/subscription.js` — активная подписка, согласия на обработку, дневной бюджет ИИ и почасовые лимиты;
- `services/subscription.js` — правила пробного периода и оплаты, без обращений к Telegram;
- `services/telegram.js` — транспорт бота: polling, сообщения и inline-кнопки;
- `routes/users.js` — cookie-сессия, сохранённый Telegram/admin-контур, экспорт и удаление аккаунта, согласия, админ- и internal-метрики;
- `routes/progress.js` — прогресс, модульное слияние, попытки, словарь и банк ошибок;
- `ai/operations.js` — реестр ИИ-операций: лимит токенов, таймаут, часовой лимит, правило fallback и версия промпта для каждой;
- `routes/ai.js` — серверные ИИ-операции с выбором провайдера, кэшем, очередью и учётом стоимости;
- `routes/media.js` — TTS с дисковым кэшем и STT с ограничениями загрузки.

## Требования

- Docker Engine с Compose v2;
- домен с HTTPS на reverse proxy;
- PostgreSQL 17 (включён в `compose.production.yml`);
- зарегистрированное VK ID application для live learner login;
- Telegram bot token для сохранённого admin/операторского контура;
- минимум один AI API key: xAI или Groq.

## Настройка

Создайте `.env` из `.env.example`. Deployment inventory фиксирует только имена переменных;
значения хранятся вне репозитория:

- `NODE_ENV`
- `APP_URL`
- `PORT`
- `DATABASE_PROVIDER`
- `DATABASE_URL`
- `POSTGRES_PASSWORD`
- `JWT_SECRET`
- `TELEGRAM_BOT_TOKEN`
- `ADMIN_TELEGRAM_ID`
- `VK_ID_MODE`
- `VK_ID_APP_ID`
- `VK_ID_REDIRECT_URI`
- `VK_ID_SCOPE`
- `VK_ID_FLOW_TTL_SECONDS`
- `VK_ID_AUTH_STARTS_PER_15_MINUTES`
- `VK_ID_AUTH_CALLBACKS_PER_15_MINUTES`
- `VK_ID_PROVIDER_TIMEOUT_MS`
- `VK_ID_LOCAL_SUBJECT` — только local development/test
- `VK_ID_LOCAL_DISPLAY_NAME` — только local development/test
- `XAI_API_KEY`
- `GROQ_API_KEY`

Не коммитьте `.env`. `APP_URL` должен точно совпадать с внешним origin: схема, домен и нестандартный порт, если он есть.

## VK ID: настройка и проверка

`PLACEHOLDER — создать VK ID application`

В кабинете VK ID зарегистрируйте **точный** callback
`https://<ваш-origin>/api/v1/auth/vk/callback`. `APP_URL` и `VK_ID_REDIRECT_URI` должны иметь один origin;
redirect не может содержать credentials, query или fragment. `VK_ID_APP_ID` — числовой идентификатор приложения,
а `VK_ID_SCOPE` оставляется пустым: Aisy получает только стабильный subject и минимальное отображаемое имя, без
email и телефона. Отдельный confidential credential этот PKCE-контракт не использует.

Режимы fail-closed:

- `VK_ID_MODE=disabled` — значение по умолчанию; `/api/v1/auth/providers` сообщает `enabled: false`, login
  показывает «VK ID пока не подключён», а `/api/v1/auth/vk/start` отвечает `503 VK_ID_UNAVAILABLE`;
- `VK_ID_MODE=live` — сервер отказывается стартовать при неполном APP_ID/callback, непустом scope или callback
  другого origin;
- `VK_ID_MODE=local` — только при явно заданном точном `NODE_ENV=development|test` и HTTP loopback `APP_URL`
  (`localhost`, `127.0.0.1` или `[::1]`): сервер слушает точный loopback-сокет (`127.0.0.1`, либо `::1`
  для `[::1]`), отбрасывает forwarded/public authority, не выполняет внешних сетевых вызовов и сохраняет те же one-time transaction,
  identity и cookie-session seams. Local provider возвращает абсолютный configured callback; отсутствие
  `NODE_ENV`, staging, preview и публичный origin fail closed.
  Local-вход не выдаёт подписку.
  Порт `APP_URL` обязан точно совпадать с `PORT`. Local listener нельзя публиковать через reverse proxy или tunnel:
  он предназначен только для прямого доступа с той же машины и дополнительно требует точный configured `Host`
  без forwarded-заголовков.

### VK callback и access logs

Live callback несёт одноразовые `code`, `state` и `device_id` в query string. Reverse proxy, load balancer и CDN
не должны сохранять query для этого пути. В Nginx не используйте стандартный `$request`/`$request_uri` в access
log; логируйте только метод и нормализованный `$uri`, оставляя исходный query доступным upstream-приложению:

```nginx
log_format aisy_safe '$remote_addr - $remote_user [$time_local] '
                     '"$request_method $uri $server_protocol" $status $body_bytes_sent '
                     '"$http_referer" "$http_user_agent"';
access_log /var/log/nginx/aisy-access.log aisy_safe;

location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

Перед live smoke отдельно проверьте access/error/audit logs каждого CDN/LB/proxy слоя: строка callback может
содержать только `/api/v1/auth/vk/callback`, без `?`, `code`, `state` и `device_id`. Application logger уже
использует только path; это не очищает журналы внешней инфраструктуры.

Production рассчитан ровно на один доверенный reverse-proxy hop (`trust proxy = 1`); не убирайте
`X-Forwarded-Proto` из конфигурации выше и не публикуйте upstream-порт. Cookie-политика дополнительно
выводит `Secure` из канонического HTTPS `APP_URL`, поэтому отсутствие proxy header не может сделать
production session/flow/replay cookie небезопасной.

OAuth endpoints имеют отдельные rate limits, `no-store`, `Pragma: no-cache` и `Referrer-Policy: no-referrer`.
Общий anonymous limiter не перехватывает exact `/api/v1/auth/vk/start|callback` и их legacy compatibility paths:
эти запросы всегда доходят до navigation-aware route limiter. Flow-cookie имеет точный
`Path=/api/v1/auth/vk/callback`, `HttpOnly`, `SameSite=Lax` и получает `Secure` на HTTPS. Provider tokens
не возвращаются браузеру и не сохраняются. Для ручного smoke после регистрации приложения проверьте cancel,
успешный callback, повтор callback, logout и отсутствие provider params в итоговом URL. Эта реализация проверена
автоматически через local provider; живой VK ID вызов в рамках Ticket 02 не выполнялся и не заявляется.

Обычный `GET /api/v1/auth/vk/start` остаётся browser redirect. Для программного handoff используйте
`GET /api/v1/auth/vk/start?response=json`: успешный private/no-store ответ содержит только
`{"authorizationUrl":"<absolute URL>"}` и устанавливает ту же callback-scoped flow-cookie. Затем клиент должен
выполнить top-level navigation на этот URL. Ошибки handshake остаются JSON `429`/`503`, даже если клиент прислал
navigation headers.

## Первый запуск

Все app lifecycle-команды выполняются через root-owned guard
`/var/lib/easyboost/locks/host-operation.lock`. Подготавливайте только его родительский каталог
`/var/lib/easyboost/locks` с `root:root 0750`; сам `host-operation.lock` заранее не создавайте —
его наличие означает активную или retained операцию.

```bash
set -euo pipefail
: "${EASYBOOST_RELEASE_COMMIT:?set the owner-approved full lowercase commit SHA}"
[[ "$EASYBOOST_RELEASE_COMMIT" =~ ^[0-9a-f]{40}$ ]] || exit 1
if git symbolic-ref -q HEAD >/dev/null; then
  echo 'Release checkout must use detached HEAD' >&2
  exit 1
else
  symbolic_ref_status="$?"
  [ "$symbolic_ref_status" -eq 1 ] || exit 1
fi
[ "$(git rev-parse --verify HEAD)" = "$EASYBOOST_RELEASE_COMMIT" ] || exit 1
[ -z "$(git status --porcelain=v1 --untracked-files=all)" ] || exit 1
npm ci
export EASYBOOST_POSTGRES_IMAGE='postgres:17-alpine'
: "${EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID:?set the owner-approved sha256 image ID}"
[[ "$EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID" =~ ^sha256:[0-9a-f]{64}$ ]] || {
  echo 'PostgreSQL image ID must be a full canonical sha256 identity' >&2
  exit 1
}
export EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID
docker pull "$EASYBOOST_POSTGRES_IMAGE"
postgres_seed_image_id="$(docker image inspect --format '{{.Id}}' "$EASYBOOST_POSTGRES_IMAGE")"
[ "$postgres_seed_image_id" = "$EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID" ] || {
  echo 'Pulled PostgreSQL image does not match the owner-approved identity' >&2
  exit 1
}
: "${EASYBOOST_NODE_BASE_IMAGE:?set the owner-reviewed Node base image digest}"
[[ "$EASYBOOST_NODE_BASE_IMAGE" =~ ^node:22-bookworm-slim@sha256:[0-9a-f]{64}$ ]] || {
  echo 'Node base image authority must be an exact owner-reviewed digest' >&2
  exit 1
}
export EASYBOOST_NODE_BASE_IMAGE
npm run production:image:build -- --expected-commit "$EASYBOOST_RELEASE_COMMIT"
production_app_image_id="$(docker image inspect --format '{{.Id}}' easyboost-production-app:local)"
[[ "$production_app_image_id" =~ ^sha256:[0-9a-f]{64}$ ]] || {
  echo 'Built application image has no canonical immutable identity' >&2
  exit 1
}
app_preflight_image_id="$(docker image inspect --format '{{.Id}}' easyboost-production-app:local)"
[ "$app_preflight_image_id" = "$production_app_image_id" ] || {
  echo 'Application image identity changed before immutable Compose binding' >&2
  exit 1
}
export EASYBOOST_PRODUCTION_APP_IMAGE_ID="$production_app_image_id"
docker compose --project-name easyboost-production -f compose.production.yml config --quiet
postgres_preflight_image_id="$(docker image inspect --format '{{.Id}}' "$EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID")"
[ "$postgres_preflight_image_id" = "$EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID" ] || {
  echo 'PostgreSQL image identity changed before Compose start' >&2
  exit 1
}
docker compose --project-name easyboost-production -f compose.production.yml up --pull never --no-build -d postgres
postgres_container_id="$(docker compose --project-name easyboost-production -f compose.production.yml ps -q postgres)"
[ -n "$postgres_container_id" ] || { echo 'PostgreSQL container is missing' >&2; exit 1; }
postgres_running_image_id="$(docker inspect --format '{{.Image}}' "$postgres_container_id")"
[ "$postgres_running_image_id" = "$EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID" ] || {
  docker compose --project-name easyboost-production -f compose.production.yml stop postgres
  echo 'Running PostgreSQL container does not use the owner-approved image' >&2
  exit 1
}
postgres_ready=0
for ((postgres_attempt=1; postgres_attempt<=30; postgres_attempt++)); do
  if docker compose --project-name easyboost-production -f compose.production.yml exec -T postgres pg_isready -t 2 -U easyboost -d easyboost \
    >/dev/null 2>&1; then
    postgres_ready=1
    break
  fi
  [ "$postgres_attempt" -eq 30 ] || sleep 1
done
[ "$postgres_ready" -eq 1 ] || {
  echo 'PostgreSQL did not become ready within 30 attempts' >&2
  exit 1
}
sudo install -d -o root -g root -m 0750 /var/lib/easyboost/locks
sudo --preserve-env=EASYBOOST_PRODUCTION_APP_IMAGE_ID,EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID \
  /usr/bin/node scripts/production-app-lifecycle.js start
docker compose --project-name easyboost-production -f compose.production.yml ps
```

`EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID` берётся из подписанной владельцем release-записи, а не из
результата текущего `docker pull`: pull только загружает bytes, после чего exact ID обязан совпасть
с заранее утверждённым значением.

Контейнер приложения автоматически выполняет SQL-миграции перед запуском сервера. Порт приложения доступен только на `127.0.0.1:3000`; наружу его должен публиковать HTTPS reverse proxy.

Проверка:

```bash
set -euo pipefail
curl --fail http://127.0.0.1:3000/health/live
docker compose --project-name easyboost-production -f compose.production.yml logs --tail=100 app
```

## Обновление

Перед обновлением сделайте backup PostgreSQL. Затем:

```bash
set -euo pipefail
: "${EASYBOOST_PRODUCTION_APP_IMAGE_ID:?set the currently deployed owner-approved app image ID}"
current_app_image_id="$EASYBOOST_PRODUCTION_APP_IMAGE_ID"
[[ "$current_app_image_id" =~ ^sha256:[0-9a-f]{64}$ ]] || {
  echo 'Current application image ID is not canonical' >&2
  exit 1
}
current_app_preflight_image_id="$(docker image inspect --format '{{.Id}}' "$current_app_image_id")"
[ "$current_app_preflight_image_id" = "$current_app_image_id" ] || {
  echo 'Current owner-approved application image is unavailable before backup' >&2
  exit 1
}
export EASYBOOST_PRODUCTION_APP_IMAGE_ID="$current_app_image_id"
: "${EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID:?set the owner-approved PostgreSQL sha256 image ID}"
[[ "$EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID" =~ ^sha256:[0-9a-f]{64}$ ]] || {
  echo 'PostgreSQL image ID must be a full canonical sha256 identity' >&2
  exit 1
}
export EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID
npm run db:backup
: "${EASYBOOST_RELEASE_COMMIT:?set the owner-approved full lowercase commit SHA}"
[[ "$EASYBOOST_RELEASE_COMMIT" =~ ^[0-9a-f]{40}$ ]] || exit 1
git fetch --no-tags origin "$EASYBOOST_RELEASE_COMMIT"
git checkout --detach "$EASYBOOST_RELEASE_COMMIT"
if git symbolic-ref -q HEAD >/dev/null; then
  echo 'Release checkout must use detached HEAD' >&2
  exit 1
else
  symbolic_ref_status="$?"
  [ "$symbolic_ref_status" -eq 1 ] || exit 1
fi
[ "$(git rev-parse --verify HEAD)" = "$EASYBOOST_RELEASE_COMMIT" ] || exit 1
[ -z "$(git status --porcelain=v1 --untracked-files=all)" ] || exit 1
npm ci
: "${EASYBOOST_NODE_BASE_IMAGE:?set the owner-reviewed Node base image digest}"
[[ "$EASYBOOST_NODE_BASE_IMAGE" =~ ^node:22-bookworm-slim@sha256:[0-9a-f]{64}$ ]] || {
  echo 'Node base image authority must be an exact owner-reviewed digest' >&2
  exit 1
}
export EASYBOOST_NODE_BASE_IMAGE
npm run production:image:build -- --expected-commit "$EASYBOOST_RELEASE_COMMIT"
production_app_image_id="$(docker image inspect --format '{{.Id}}' easyboost-production-app:local)"
[[ "$production_app_image_id" =~ ^sha256:[0-9a-f]{64}$ ]] || {
  echo 'Built application image has no canonical immutable identity' >&2
  exit 1
}
app_preflight_image_id="$(docker image inspect --format '{{.Id}}' easyboost-production-app:local)"
[ "$app_preflight_image_id" = "$production_app_image_id" ] || {
  echo 'Application image identity changed before immutable Compose binding' >&2
  exit 1
}
: "${EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID:?set the owner-approved PostgreSQL sha256 image ID}"
[[ "$EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID" =~ ^sha256:[0-9a-f]{64}$ ]] || {
  echo 'PostgreSQL image ID must be a full canonical sha256 identity' >&2
  exit 1
}
postgres_container_id="$(docker compose --project-name easyboost-production -f compose.production.yml ps -q postgres)"
[ -n "$postgres_container_id" ] || { echo 'Running PostgreSQL container is missing' >&2; exit 1; }
postgres_running_image_id="$(docker inspect --format '{{.Image}}' "$postgres_container_id")"
[ "$postgres_running_image_id" = "$EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID" ] || {
  echo 'Running PostgreSQL container does not use the owner-approved image' >&2
  exit 1
}
postgres_ready=0
for ((postgres_attempt=1; postgres_attempt<=30; postgres_attempt++)); do
  if docker compose --project-name easyboost-production -f compose.production.yml exec -T postgres pg_isready -t 2 -U easyboost -d easyboost \
    >/dev/null 2>&1; then
    postgres_ready=1
    break
  fi
  [ "$postgres_attempt" -eq 30 ] || sleep 1
done
[ "$postgres_ready" -eq 1 ] || {
  echo 'PostgreSQL did not become ready within 30 attempts' >&2
  exit 1
}
sudo install -d -o root -g root -m 0750 /var/lib/easyboost/locks
export EASYBOOST_PREVIOUS_APP_IMAGE_ID="$current_app_image_id"
export EASYBOOST_PRODUCTION_APP_IMAGE_ID="$production_app_image_id"
sudo --preserve-env=EASYBOOST_PREVIOUS_APP_IMAGE_ID,EASYBOOST_PRODUCTION_APP_IMAGE_ID,EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID \
  /usr/bin/node scripts/production-app-lifecycle.js replace
docker compose --project-name easyboost-production -f compose.production.yml ps
```

`replace` не обещает неявный rollback. Если readiness нового image не прошёл, но новый allocation
доказанно удалён, app намеренно остаётся отсутствующим. В новой shell заново возьмите сохранённый
owner-approved exact ID прежнего image, перепроверьте `docker image inspect --format '{{.Id}}'`, явно
перевяжите `EASYBOOST_PRODUCTION_APP_IMAGE_ID` на **прежний**, а не провалившийся candidate, и только затем
выполните guarded `start`. Если settlement создания или cleanup не доказан, guard остаётся retained:
сначала выполните typed recovery; start/import/release до его успеха запрещены:

```bash
set -euo pipefail
export EASYBOOST_HOST_OPERATION_LOCK_DIR=/var/lib/easyboost/locks/host-operation.lock
sudo --preserve-env=EASYBOOST_HOST_OPERATION_LOCK_DIR \
  /usr/bin/node scripts/production-app-lifecycle.js recover
```

Не удаляйте volume `postgres-data` при обновлении.

Если обновление меняло файлы в `public/`, отдельного шага не требуется: имя кэша и список
`APP_SHELL` для service worker считает сборка frontend, а её выполняет стадия сборки образа — см.
«Сборка frontend». Сбрасывать кэш на устройстве ученика не нужно и нельзя: он получит уведомление
о новой версии сам.

## Backup и восстановление PostgreSQL

Полный порядок аварийного восстановления, бюджет RTO и последний результат тренировки описаны в [`docs/DISASTER_RECOVERY.md`](docs/DISASTER_RECOVERY.md).

Backup, restore и restore-check используют один exclusive database-operation lock. Destructive restore,
production JSON import, production app lifecycle и staging release дополнительно сериализованы одним
host-operation guard. Его authority — atomic directory
`/var/lib/easyboost/locks/host-operation.lock`; один и тот же exact путь обязан использоваться во всех
этих командах. Parent directory принадлежит `root:root`, а host-mutating entrypoints выполняются только
через `sudo/root`. Не создавайте сам `host-operation.lock`: его наличие означает активную или намеренно
retained операцию.

Один раз на host provision только parent и зафиксировать общий путь:

```bash
set -euo pipefail
sudo install -d -o root -g root -m 0750 /var/lib/easyboost/locks
export EASYBOOST_HOST_OPERATION_LOCK_DIR=/var/lib/easyboost/locks/host-operation.lock
```

Все database-интерфейсы требуют owner-approved identities `app` и PostgreSQL. Они доказывают один full
64-hex PostgreSQL container ID, его `.Id`, exact Compose `project=easyboost-production`,
`service/oneoff` labels, running `.Image` и
`State.Running=true`. После этой границы команды используют только доказанный immutable ID. Destructive
restore идёт через tokenized supervisor с `PGAPPNAME=easyboost_restore_<uuid>` и bounded deadline. До
мутации он физически резервирует exact archive bytes и bounded headroom и на host snapshot, и в container
staging. Supervisor не считает settlement доказанным, пока одновременно не увидит отсутствие tokenized
process и matching `pg_stat_activity` (либо exact stopped PostgreSQL container). При недоказанном settlement
или app isolation оба recovery guards остаются retained.

Перед ручным запуском:

```bash
set -euo pipefail
: "${EASYBOOST_PRODUCTION_APP_IMAGE_ID:?set the currently deployed owner-approved app image ID}"
[[ "$EASYBOOST_PRODUCTION_APP_IMAGE_ID" =~ ^sha256:[0-9a-f]{64}$ ]] || {
  echo 'Application image ID must be a full canonical sha256 identity' >&2
  exit 1
}
export EASYBOOST_PRODUCTION_APP_IMAGE_ID
: "${EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID:?set the owner-approved PostgreSQL sha256 image ID}"
[[ "$EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID" =~ ^sha256:[0-9a-f]{64}$ ]] || {
  echo 'PostgreSQL image ID must be a full canonical sha256 identity' >&2
  exit 1
}
export EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID
export EASYBOOST_HOST_OPERATION_LOCK_DIR=/var/lib/easyboost/locks/host-operation.lock
```

Создать атомарный backup в каталоге `backups/`. Публикация использует no-replace границу: два
конкурентных процесса не могут перезаписать архив друг друга; ошибка удаления partial dump сохраняется
после primary error и печатает exact безопасный путь для ручного восстановления:

```bash
set -euo pipefail
npm run db:backup
```

Проверить последний архив реальным восстановлением в disposable PostgreSQL runtime:

```bash
set -euo pipefail
npm run db:verify-backup
```

Команда descriptor-safe фиксирует один regular/single-link bounded архив без следования по symlink,
физически резервирует exact bytes плюс bounded headroom, считает SHA-256 и использует только frozen
descriptor для `--list` и `pg_restore`. Полный restore **никогда не выполняется в live production
PostgreSQL**: verifier создаёт уникальные token-labeled container и volume из exact owner-approved
PostgreSQL image ID, запрещает network и published ports, ограничивает `/tmp` и повторно доказывает
container/image/volume identity. Внутри disposable runtime используется тот же tokenized supervisor.

После restore verifier сверяет полный локальный список миграций и наличие/счётчики `users`,
`user_progress`, `module_attempts`, `word_progress`, `schema_migrations`. `success` появляется в
`backups/restore-check-status.json` с `backupSha256`, `postgresImageId` и
`verificationIsolation=disposable-exact-image-container` только после доказанного удаления exact
container и volume. Cleanup error публикует `failed`; primary и cleanup errors сохраняются раздельно.
При недоказанном supervisor settlement runtime не удаляется, database-operation marker остаётся retained,
а последующие DB-операции блокируются для ручного recovery. Live база и приложение не останавливаются.

Можно указать собственный путь: `npm run db:backup -- /secure/easyboost.dump`. Храните копии вне VPS и регулярно проверяйте восстановление на отдельном стенде.

### Managed restore на работающем production host

Managed restore полностью заменяет содержимое базы и требует явного подтверждения. Под host guard он
доказывает exact running app allocation, останавливает только этот immutable container, непрерывно
перепроверяет его stopped state до и во время destructive supervisor, а после успеха запускает тот же ID
и держит guard до bounded `/health/ready`:

```bash
set -euo pipefail
: "${EASYBOOST_PRODUCTION_APP_IMAGE_ID:?set the owner-approved canonical app image ID}"
export EASYBOOST_PRODUCTION_APP_IMAGE_ID
: "${EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID:?set the owner-approved PostgreSQL sha256 image ID}"
[[ "$EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID" =~ ^sha256:[0-9a-f]{64}$ ]] || {
  echo 'PostgreSQL image ID must be a full canonical sha256 identity' >&2
  exit 1
}
export EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID
export EASYBOOST_HOST_OPERATION_LOCK_DIR=/var/lib/easyboost/locks/host-operation.lock
sudo --preserve-env=EASYBOOST_HOST_OPERATION_LOCK_DIR,EASYBOOST_PRODUCTION_APP_IMAGE_ID,EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID \
  /usr/bin/node scripts/postgres-restore.js /secure/easyboost.dump --confirm-restore
```

Если supervisor или readiness падает, app остаётся доказанно stopped. При недоказанной изоляции
database-operation marker и host-operation directory остаются retained; запуск app/release/import запрещён
до ручного recovery ниже.

### Database-only restore при отсутствующем app allocation

На свежем recovery-host используется тот же frozen/supervised путь в явном database-only режиме. Он
несколько раз, включая последнюю границу непосредственно перед mutation, доказывает пустой Compose app
allocation и никогда не создаёт, не запускает и не останавливает приложение:

```bash
set -euo pipefail
: "${EASYBOOST_PRODUCTION_APP_IMAGE_ID:?set the owner-approved canonical app image ID}"
export EASYBOOST_PRODUCTION_APP_IMAGE_ID
: "${EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID:?set the owner-approved PostgreSQL sha256 image ID}"
export EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID
export EASYBOOST_HOST_OPERATION_LOCK_DIR=/var/lib/easyboost/locks/host-operation.lock
sudo --preserve-env=EASYBOOST_HOST_OPERATION_LOCK_DIR,EASYBOOST_PRODUCTION_APP_IMAGE_ID,EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID \
  /usr/bin/node scripts/postgres-restore.js /secure/easyboost.dump --database-only --confirm-restore
```

Если database-only нужен на существующем host, сначала идемпотентно удалить approved app allocation тем
же guarded lifecycle. `stop` принимает running, approved stopped или уже absent state; после success он
обязательно доказывает пустой allocation. После успешного restore `start` создаёт новый allocation только
из pinned app image и держит host guard до readiness:

```bash
set -euo pipefail
export EASYBOOST_HOST_OPERATION_LOCK_DIR=/var/lib/easyboost/locks/host-operation.lock
sudo --preserve-env=EASYBOOST_HOST_OPERATION_LOCK_DIR,EASYBOOST_PRODUCTION_APP_IMAGE_ID,EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID \
  /usr/bin/node scripts/production-app-lifecycle.js stop
sudo --preserve-env=EASYBOOST_HOST_OPERATION_LOCK_DIR,EASYBOOST_PRODUCTION_APP_IMAGE_ID,EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID \
  /usr/bin/node scripts/postgres-restore.js /secure/easyboost.dump --database-only --confirm-restore
sudo --preserve-env=EASYBOOST_HOST_OPERATION_LOCK_DIR,EASYBOOST_PRODUCTION_APP_IMAGE_ID,EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID \
  /usr/bin/node scripts/production-app-lifecycle.js start
```

Перед любым restore сделайте дополнительную копию текущей базы. Никогда не заменяйте guarded lifecycle
на raw `docker compose up/start/stop/restart app`: такая команда не участвует в общей сериализации.

### Retained restore marker: проверка и снятие только после settlement

Retained marker не является stale PID-файлом. Он хранит `protocol`, `reason`, restore UUID в
`operationToken`, exact `PGAPPNAME` в `applicationName`, PostgreSQL container ID в
`postgresContainerId` и последний process/`pg_stat_activity` probe в `lastProbe`. Не удаляйте,
не переименовывайте и не копируйте marker или host guard вручную. Для settlement и снятия обеих exact
authority используйте только executable recovery-helper:

```bash
set -euo pipefail
: "${EASYBOOST_PRODUCTION_APP_IMAGE_ID:?set the owner-approved canonical app image ID}"
: "${EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID:?set the owner-approved PostgreSQL sha256 image ID}"
export EASYBOOST_PRODUCTION_APP_IMAGE_ID EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID
export EASYBOOST_HOST_OPERATION_LOCK_DIR=/var/lib/easyboost/locks/host-operation.lock
sudo --preserve-env=EASYBOOST_HOST_OPERATION_LOCK_DIR,EASYBOOST_PRODUCTION_APP_IMAGE_ID,EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID \
  /usr/bin/node scripts/production-restore-recovery.js
```

Helper принимает только совпадающие typed DB/host evidence, exact Compose project/service/one-off/image
authority и либо остановленный exact PostgreSQL container, либо bounded sandwich-проверку
`process NONE → pg_stat_activity 0 → process NONE`. Для application-isolation recovery он останавливает
только exact approved app allocation. Между снятием DB marker и host guard удерживается typed DB
absence-lease; если процесс оборвался после снятия host guard, повтор той же команды завершает только эту
lease. Foreign, неоднозначный или частично опубликованный protocol оставляет все authority на месте и
завершается ошибкой.

Даже после успешного helper считать базу готовой нельзя: оборванный `pg_restore --clean` мог оставить
частичное состояние. Оставьте/приведите app к absent state через guarded lifecycle `stop`, затем повторите
полный database-only restore из проверенного архива. Ручное `rm`, `rmdir` или снятие guard по PID/возрасту
запрещено.

Перед установкой cron сохраните текущую утверждённую identity в root-owned файле вне Git checkout.
Повторите этот шаг после успешного первого запуска, update или rollback, когда running `.Image`
уже сверена с этой identity:

```bash
set -euo pipefail
: "${EASYBOOST_PRODUCTION_APP_IMAGE_ID:?set the currently deployed owner-approved app image ID}"
[[ "$EASYBOOST_PRODUCTION_APP_IMAGE_ID" =~ ^sha256:[0-9a-f]{64}$ ]] || exit 1
: "${EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID:?set the owner-approved PostgreSQL sha256 image ID}"
[[ "$EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID" =~ ^sha256:[0-9a-f]{64}$ ]] || exit 1
sudo install -d -o root -g root -m 0755 /etc/easyboost
production_app_image_authority_tmp="$(mktemp)"
production_app_image_authority_target_tmp="/etc/easyboost/.production-app-image-id.$$"
postgres_image_authority_tmp="$(mktemp)"
postgres_image_authority_target_tmp="/etc/easyboost/.postgres-image-id.$$"
cleanup_production_app_image_authority() {
  rm -f "$production_app_image_authority_tmp" || true
  rm -f "$postgres_image_authority_tmp" || true
  sudo rm -f "$production_app_image_authority_target_tmp" || true
  sudo rm -f "$postgres_image_authority_target_tmp" || true
}
trap cleanup_production_app_image_authority EXIT
printf '%s\n' "$EASYBOOST_PRODUCTION_APP_IMAGE_ID" > "$production_app_image_authority_tmp"
sudo install -o root -g root -m 0644 "$production_app_image_authority_tmp" "$production_app_image_authority_target_tmp"
printf '%s\n' "$EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID" > "$postgres_image_authority_tmp"
sudo install -o root -g root -m 0644 "$postgres_image_authority_tmp" "$postgres_image_authority_target_tmp"
sudo mv -f "$production_app_image_authority_target_tmp" /etc/easyboost/production-app-image-id
sudo mv -f "$postgres_image_authority_target_tmp" /etc/easyboost/postgres-image-id
rm -f "$production_app_image_authority_tmp"
rm -f "$postgres_image_authority_tmp"
trap - EXIT
```

Пример ежедневного cron с хранением 14 дней:

```cron
15 3 * * * cd /opt/easyboost && EASYBOOST_PRODUCTION_APP_IMAGE_ID="$(/bin/cat /etc/easyboost/production-app-image-id)" EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID="$(/bin/cat /etc/easyboost/postgres-image-id)" /usr/bin/npm run db:backup >> /var/log/easyboost-backup.log 2>&1
25 4 * * * find /opt/easyboost/backups -type f -name 'easyboost-*.dump' -mtime +14 -delete
20 5 1 * * cd /opt/easyboost && EASYBOOST_PRODUCTION_APP_IMAGE_ID="$(/bin/cat /etc/easyboost/production-app-image-id)" EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID="$(/bin/cat /etc/easyboost/postgres-image-id)" /usr/bin/npm run db:verify-backup >> /var/log/easyboost-restore-check.log 2>&1
```

## Откат приложения

Оставайтесь на текущем audited checkout с managed lifecycle helper. Укажите exact image ID текущего
app и owner-recorded canonical ID уже локально доступного rollback image. Guarded lifecycle в одной
host-lock сессии удалит только доказанный текущий allocation и поднимет rollback image. Если image
локально отсутствует, процедура закрывается до мутации: восстановите его отдельным owner-approved
процессом. Rollback не делает checkout, rebuild или pull.

```bash
set -euo pipefail
: "${EASYBOOST_PRODUCTION_APP_IMAGE_ID:?set the currently deployed owner-approved app image ID}"
current_app_image_id="$EASYBOOST_PRODUCTION_APP_IMAGE_ID"
[[ "$current_app_image_id" =~ ^sha256:[0-9a-f]{64}$ ]] || {
  echo 'Current application image ID is not canonical' >&2
  exit 1
}
current_app_preflight_image_id="$(docker image inspect --format '{{.Id}}' "$current_app_image_id")"
[ "$current_app_preflight_image_id" = "$current_app_image_id" ] || {
  echo 'Current owner-approved application image is unavailable before rollback' >&2
  exit 1
}
: "${EASYBOOST_ROLLBACK_APP_IMAGE_ID:?set the owner-recorded rollback app sha256 image ID}"
rollback_app_image_id="$EASYBOOST_ROLLBACK_APP_IMAGE_ID"
[[ "$rollback_app_image_id" =~ ^sha256:[0-9a-f]{64}$ ]] || {
  echo 'Rollback application image ID is not canonical' >&2
  exit 1
}
[ "$rollback_app_image_id" != "$current_app_image_id" ] || {
  echo 'Rollback image must differ from the currently deployed image' >&2
  exit 1
}
rollback_app_preflight_image_id="$(docker image inspect --format '{{.Id}}' "$rollback_app_image_id")"
[ "$rollback_app_preflight_image_id" = "$rollback_app_image_id" ] || {
  echo 'Owner-approved rollback image is not already available locally' >&2
  exit 1
}
: "${EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID:?set the owner-approved PostgreSQL sha256 image ID}"
[[ "$EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID" =~ ^sha256:[0-9a-f]{64}$ ]] || {
  echo 'PostgreSQL image ID must be a full canonical sha256 identity' >&2
  exit 1
}
export EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID
postgres_container_id="$(docker compose --project-name easyboost-production -f compose.production.yml ps -q postgres)"
[ -n "$postgres_container_id" ] || { echo 'Running PostgreSQL container is missing' >&2; exit 1; }
postgres_running_image_id="$(docker inspect --format '{{.Image}}' "$postgres_container_id")"
[ "$postgres_running_image_id" = "$EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID" ] || {
  echo 'Running PostgreSQL container does not use the owner-approved image' >&2
  exit 1
}
postgres_ready=0
for ((postgres_attempt=1; postgres_attempt<=30; postgres_attempt++)); do
  if docker compose --project-name easyboost-production -f compose.production.yml exec -T postgres pg_isready -t 2 -U easyboost -d easyboost \
    >/dev/null 2>&1; then
    postgres_ready=1
    break
  fi
  [ "$postgres_attempt" -eq 30 ] || sleep 1
done
[ "$postgres_ready" -eq 1 ] || {
  echo 'PostgreSQL did not become ready within 30 attempts' >&2
  exit 1
}
sudo install -d -o root -g root -m 0750 /var/lib/easyboost/locks
export EASYBOOST_PREVIOUS_APP_IMAGE_ID="$current_app_image_id"
export EASYBOOST_PRODUCTION_APP_IMAGE_ID="$rollback_app_image_id"
sudo --preserve-env=EASYBOOST_PREVIOUS_APP_IMAGE_ID,EASYBOOST_PRODUCTION_APP_IMAGE_ID,EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID \
  /usr/bin/node scripts/production-app-lifecycle.js replace
```

`replace` не обещает неявный возврат текущего image. Если readiness rollback image не прошёл, но
его allocation доказанно удалён, app намеренно остаётся отсутствующим. В новой shell заново возьмите
owner-approved exact ID image, который работал **до** попытки rollback, перепроверьте его локальную
identity, явно перевяжите `EASYBOOST_PRODUCTION_APP_IMAGE_ID` с провалившегося rollback image на этот ID
и только затем выполните guarded `start`. При недоказанном settlement сначала выполните concrete typed
recovery; до её успеха start/import/release запрещены:

```bash
set -euo pipefail
export EASYBOOST_HOST_OPERATION_LOCK_DIR=/var/lib/easyboost/locks/host-operation.lock
sudo --preserve-env=EASYBOOST_HOST_OPERATION_LOCK_DIR \
  /usr/bin/node scripts/production-app-lifecycle.js recover
```

Миграции должны оставаться обратно совместимыми; автоматического отката схемы нет. Raw
`docker compose ... build` и `up --build` намеренно не являются production entrypoint: без wrapper
build context указывает на отсутствующий sentinel и закрывается ошибкой.

## Импорт старого data.json

Импорт — отдельное maintenance-окно. PostgreSQL должен работать, а Compose allocation сервиса `app`
должен полностью отсутствовать: недостаточно оставить остановленный контейнер. Сначала закрепите два
owner-approved image ID и снимите приложение только guarded entrypoint. Import сериализуется с production
lifecycle, destructive restore и staging release одним root-owned host guard
`/var/lib/easyboost/locks/host-operation.lock`, а с backup/restore/verify — отдельным shared database-operation
lock. Bootstrap создаёт только root-owned parent directory `/var/lib/easyboost/locks`, но не сам lock
directory. Поэтому команды ниже выполняются от root и не заменяются raw
`docker compose up/start/stop/restart app`.

```bash
set -euo pipefail
: "${EASYBOOST_PRODUCTION_APP_IMAGE_ID:?set the currently deployed owner-approved app image ID}"
[[ "$EASYBOOST_PRODUCTION_APP_IMAGE_ID" =~ ^sha256:[0-9a-f]{64}$ ]] || {
  echo 'Application image ID must be a full canonical sha256 identity' >&2
  exit 1
}
export EASYBOOST_PRODUCTION_APP_IMAGE_ID
: "${EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID:?set the owner-approved PostgreSQL sha256 image ID}"
[[ "$EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID" =~ ^sha256:[0-9a-f]{64}$ ]] || {
  echo 'PostgreSQL image ID must be a full canonical sha256 identity' >&2
  exit 1
}
export EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID
sudo --preserve-env=EASYBOOST_PRODUCTION_APP_IMAGE_ID,EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID \
  /usr/bin/node scripts/production-app-lifecycle.js stop
sudo --preserve-env=EASYBOOST_PRODUCTION_APP_IMAGE_ID,EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID \
  /usr/bin/node scripts/import-json.js /absolute/host/path/data.json --production-compose --dry-run
```

Production importer до чтения source получает shared host guard, затем shared exclusive
database-operation lock. Он доказывает пустой app allocation, canonical PostgreSQL container
ID/labels/image/running state, единственный Docker network IPv4 endpoint и bounded readiness. One-off
контейнер получает случайный ownership label и используется только по exact immutable ID. До `docker cp`
entrypoint запускает в этом exact owner-approved image команду attestation и требует literal протокол
`easyboost-production-json-import-v1;write=append-only;owner=exact;digest=sha256`. Старый или чужой app
image поэтому не получает bytes импорта.

Dry-run разбирает frozen bytes, но намеренно не проверяет коллизии в живой БД. Он завершает вывод одним
JSON-документом: верхнеуровневое поле `sourceSha256` — SHA-256 exact frozen bytes host-файла, ровно
`64 lowercase hex`; `report` содержит внутренний отчёт. Только это значение из exact dry-run является
authority для live import: изменившийся host-файл отклоняется до one-off allocation.

После ручной проверки dry-run выполните append-only live import. Он не обновляет существующие записи:
любое совпадение username, provider identity или learner progress прерывает транзакцию и откатывает
весь snapshot.

```bash
set -euo pipefail
: "${EASYBOOST_PRODUCTION_APP_IMAGE_ID:?set the currently deployed owner-approved app image ID}"
[[ "$EASYBOOST_PRODUCTION_APP_IMAGE_ID" =~ ^sha256:[0-9a-f]{64}$ ]] || {
  echo 'Application image ID must be a full canonical sha256 identity' >&2
  exit 1
}
export EASYBOOST_PRODUCTION_APP_IMAGE_ID
: "${EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID:?set the owner-approved PostgreSQL sha256 image ID}"
[[ "$EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID" =~ ^sha256:[0-9a-f]{64}$ ]] || {
  echo 'PostgreSQL image ID must be a full canonical sha256 identity' >&2
  exit 1
}
export EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID
: "${EASYBOOST_IMPORT_SOURCE_SHA256:?copy sourceSha256 from the exact dry-run}"
[[ "$EASYBOOST_IMPORT_SOURCE_SHA256" =~ ^[0-9a-f]{64}$ ]] || {
  echo 'Import source SHA-256 must be exactly 64 lowercase hexadecimal characters' >&2
  exit 1
}
sudo --preserve-env=EASYBOOST_PRODUCTION_APP_IMAGE_ID,EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID \
  /usr/bin/node scripts/import-json.js /absolute/host/path/data.json --production-compose \
  --expected-source-sha256 "$EASYBOOST_IMPORT_SOURCE_SHA256"
sudo --preserve-env=EASYBOOST_PRODUCTION_APP_IMAGE_ID,EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID \
  /usr/bin/node scripts/production-app-lifecycle.js start
```

Непосредственно перед внутренним импортом entrypoint повторно доказывает тот же PostgreSQL ID, endpoint
и readiness. Внутренний wrapper меняет только hostname proven `DATABASE_URL`, добавляет уникальный
`application_name=easyboost_import_<operation UUID>` и не передаёт пароль/URL в host args и логи. После
неоднозначного `docker exec` guard освобождается только когда exact owned one-off удалён, а bounded
`pg_stat_activity` по этой метке вернул ноль. Неизвестное создание/cleanup контейнера или оставшаяся
PostgreSQL activity сохраняют оба recovery marker: `backups/.easyboost-database-operation.lock` с typed
owner/container/last-probe evidence и `/var/lib/easyboost/locks/host-operation.lock`. Не удаляйте их по
одному пустому probe: incident recovery должен доказать exact ownership, отсутствие контейнера и нулевую
tagged DB activity; только затем helper может снять обе блокировки:

```bash
set -euo pipefail
: "${EASYBOOST_PRODUCTION_APP_IMAGE_ID:?set the owner-approved canonical app image ID}"
: "${EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID:?set the owner-approved PostgreSQL sha256 image ID}"
export EASYBOOST_PRODUCTION_APP_IMAGE_ID EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID
export EASYBOOST_HOST_OPERATION_LOCK_DIR=/var/lib/easyboost/locks/host-operation.lock
sudo --preserve-env=EASYBOOST_HOST_OPERATION_LOCK_DIR,EASYBOOST_PRODUCTION_APP_IMAGE_ID,EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID \
  /usr/bin/node scripts/production-import-recovery.js
```

Команда принимает только совпадающие typed DB/host evidence, доказывает exact owner/project/service/image,
удаляет только найденный owned one-off, повторно проверяет app isolation и tagged DB activity, затем снимает
DB marker и host guard через удерживаемую absence-lease. Если процесс оборвался между этими фазами, повтор
той же команды безопасно продолжает host-only или lease-only recovery.

Если локальный Docker child не подтвердил `close`/reap после TERM→KILL, importer пишет в stderr один
sanitized JSON envelope с кодом `PRODUCTION_IMPORT_LOCAL_CHILD_RECOVERY_REQUIRED`, флагом
`childSettlementUnproven` и только canonical supervisor `recoveryAuthority`. Команда, аргументы, environment,
source path и credentials туда не попадают. В этот момент host guard уже retained, а database marker остаётся
ACTIVE с exact checksummed local-child hold, поэтому guarded app `start`, новый import и restore продолжают
блокироваться. Запускайте тот же `production-import-recovery.js`: он сверяет persisted host evidence с exact
DB hold, восстанавливает только записанный POSIX-session/Windows-Job controller, атомарно переводит DB marker
в retained import evidence и лишь затем входит в обычную owner/container/PostgreSQL recovery выше. Crash после
controller retirement или во время DB transition возобновляется повтором этой же команды. Mismatch, активный
controller или код `PRODUCTION_IMPORT_LOCAL_CHILD_RECOVERY_UNAVAILABLE` остаются fail-closed; raw удаление
host/DB marker, local-child sidecar или supervisor directory запрещено.

Исходный host-файл скрипт не изменяет и не удаляет. Private host snapshot всегда cleanup-attempted; при
неоднозначном settlement его bytes не считаются recovery authority. Если exact one-off не удалось доказанно
удалить, его in-container copy может сохраниться, а markers сохраняют typed recovery metadata. Legacy-аккаунты
и provider-managed ученики вместе с `learner_identities` и прогрессом переносятся одной транзакцией;
временные OAuth/PKCE-транзакции и provider-токены не импортируются. Если выполнялся только dry-run,
верните приложение тем же guarded `production-app-lifecycle.js start` после завершения проверки.

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
- `npm run security:secrets` сканирует tracked files и явный bounded Ticket 11 candidate inventory
  `scripts/aisy-release-candidate-files.json`. В том же обязательном pre-build gate generic context guard
  обходит все не исключённые `.dockerignore` inputs каждого non-stage Docker `COPY`, включая gitignored
  файлы, и отклоняет любой reachable путь вне этого audited объединения. Secret gate читает все bytes,
  не доверяя суффиксам binary-файлов. Production-image wrapper использует тот же audited closure,
  дважды читает каждый file descriptor с no-follow/identity/digest checks и формирует deterministic
  USTAR stdin только из Buffer, повторно проверенного непосредственно перед передачей в Docker.
  Исключённые protected paths guard не обходит и не изменяет.
  Полную Git-историю отдельно проверяет `npm run security:history`.
- CSP разрешает только hashed inline scripts и свой origin для сетевых запросов; frames и object/embed запрещены. Inline styles и event handlers пока разрешены: разметка `index.html` вызывает обработчики атрибутами `onclick`, и разделение frontend на модули этого не отменило. Разрешимость каждого имени проверяет `scripts/check-inline-handlers.js` в составе `npm run check` — включая имена, которые приезжают вместе с ленивым чанком.

Лимиты каждой ИИ-операции заданы в `ai/operations.js`; переменные окружения работают как потолок и могут только ужесточить их: `AI_REQUESTS_PER_HOUR` ограничивает часовой лимит, `AI_MAX_TIMEOUT_MS` — таймаут. Одновременных обращений к провайдеру не больше `AI_MAX_CONCURRENT_REQUESTS` (по умолчанию 4), остальные ждут очереди и получают `AI_QUEUE_TIMEOUT`, если ожидание затянулось.

Лимиты настраиваются через `SESSION_DAYS`, `TELEGRAM_AUTH_CODE_TTL_MS`, `TELEGRAM_AUTH_STARTS_PER_15_MINUTES`, `TELEGRAM_AUTH_CHECKS_PER_15_MINUTES`, `AI_TIMEOUT_MS`, `AI_REQUESTS_PER_HOUR`, `WRITING_REQUESTS_PER_HOUR`, `TTS_REQUESTS_PER_HOUR` и `STT_REQUESTS_PER_HOUR`.

## Проверка перед релизом

```bash
set -euo pipefail
npm ci
npm run test:release:aisy
```

Resolved production Compose проверяется в основном gate из `RELEASE_CHECKLIST.md` только после того,
как guarded build зафиксировал canonical app image ID, tag preflight подтвердил ту же identity и
`EASYBOOST_PRODUCTION_APP_IMAGE_ID` был экспортирован для immutable binding.

Ticket 11 release wrapper выполняет lint/check/unit, затем непосредственно перед build запускает
Docker-context + tracked/explicit secret guard и создаёт production candidate **ровно один раз**,
после чего запускает единый 26-file built-dist Chromium inventory, performance и history/diff gates.
Unit EGE contract не запускает build и не читает `dist`; единственная сборка валидирует derived asset
closure, а post-build PWA E2E проверяет worker/cache/offline bytes. Не запускайте рядом отдельные
`npm run build:frontend`/`npm run test:e2e`: это разрушит literal one-build evidence. Exact d367 fixture,
который PWA E2E герметично строит во временном каталоге, является provenance старой версии, а не второй
candidate build. На controlled persistent Chromium page CDP `Page.getInstallabilityErrors` обязан
вернуть literal empty list; incognito-only ошибку тест не фильтрует.

CI выполняет чистую установку, синтаксическую проверку и тесты на Node.js 22. Для всей последовательности
задан hard timeout 120 минут: одна только наблюдаемая full-unit фаза занимает примерно 31 минуту, после
неё wrapper продолжает source/artifact/browser/performance проверки, а CI — PostgreSQL,
Android/Firefox/WebKit, установку browser runtime и quality checks. Остаток — запас для cold runner.
`Deploy staging` также явно выбирает Node.js 22 до запуска archive helpers; npm cache там не создаётся,
потому что workflow не устанавливает пакеты.
При отдельном server/storage/schema изменении PostgreSQL integration запускается командой
`npm run test:postgres`. Она
использует отдельный `compose.test.yml`, ждёт healthcheck PostgreSQL 17, применяет все миграции,
выполняет repository integration без skip и затем удаляет test-контейнер, сеть и volume. Compose
использует локальный образ или загружает `postgres:17-alpine`, если его ещё нет; отдельный CI-путь
для миграций не нужен.
Chromium E2E использует установленный Chrome/Edge/Chromium; нестандартный путь можно передать через `CHROME_PATH`. Firefox E2E запускается командой `npm run test:e2e:firefox`. Мобильные профили запускаются командами `npm run test:e2e:android` (Pixel/Chromium с touch и мобильным user-agent) и `npm run test:e2e:iphone-webkit` (iPhone/WebKit). Firefox и WebKit runtime устанавливаются через `npx playwright install firefox webkit`.

Мобильные профили являются автоматической проверкой движка и адаптивного интерфейса, но не заменяют финальный приёмочный прогон на физическом iPhone Safari и Android Chrome.

`npm run test:e2e:performance` измеряет показатели раздела 19 на живом приложении и держит пять бюджетов: LCP, CLS, INP, задержку появления индикатора проверки ИИ и вес JavaScript первой загрузки. Запускается отдельно от функционального набора, потому что тайминги шумные. Текущий финальный release wrapper зелёный: artifact `d518f4a54e7b03beb357a69f7dc6380cd31befc5a11634c1ddd0df216021e290`, 26 уникальных Chromium-сценариев, first-load JS 90.0 KB / 150 KB, LCP 108 ms, CLS 0.000, INP 64 ms; исторические результаты явно помечены и сохранены в [`docs/PERFORMANCE_BASELINE.md`](docs/PERFORMANCE_BASELINE.md). Кроме бюджетов проверяется состав первой загрузки: ленивые экраны не имеют права приехать при старте, а обязательные initial modules должны приехать. Каждый бюджет печатается до падения, поэтому одно превышение не скрывает состояние остальных, и команда годится как release gate.

Перед релизом также выполняйте `npm audit --omit=dev`. Текущий production dependency tree не содержит известных npm audit уязвимостей.

## Staging

Staging полностью отделён от production:

- каталог `/opt/easyboost-staging`;
- compose project `easyboost-staging`;
- PostgreSQL volume и база `easyboost_staging`;
- loopback-порт `127.0.0.1:3001`;
- файл секретов `.env.staging`;
- отдельные Telegram bot token, JWT secret, database password и AI budgets.

Первичная настройка на Linux-сервере выполняется одним idempotent bootstrap из exact audited
checkout. Он создаёт runtime root, backup/store roots и `.env.staging` с root ownership и exact
private modes, а затем устанавливает одну проверенную helper generation v4:

```bash
set -euo pipefail
sudo bash scripts/bootstrap-staging-release-host.sh
sudo editor /opt/easyboost-staging/.env.staging
```

Bootstrap создаёт `/opt/easyboost-staging`, `backups/`, `rollbacks/` и
`rollbacks/releases/` с mode `0700`, а `.env.staging` — с mode `0600`; существующий env-файл он
никогда не перезаписывает. Default production paths требуют root. На повторном запуске installer
сверяет exact source bytes с установленной content-addressed generation и атомарно меняет только
общий `current` pointer. Разные installer-процессы сериализуются отдельным nonblocking kernel
`flock` на fd 7: root использует `/run/lock/easyboost-staging-helper/install.lock`, hermetic non-root
установка — private `/tmp/easyboost-staging-helper-installer.<uid>/install.lock`. Lock inode стабилен;
после crash владение освобождает kernel, а файл не является stale marker и не удаляется.

При проверке пути безопасные ancestors до `/` могут принадлежать только UID 0 или UID вызвавшего
helper. Сам runtime root и каждый protected leaf остаются строго принадлежащими UID вызвавшего helper,
без symlink/hardlink подмены и с exact private modes `0700`/`0600`.

`APP_URL` должен быть staging-origin, например `https://staging.useboost.ru`. Не копируйте production secrets. До создания отдельного Telegram-бота и AI-ключей оставляйте эти интеграции выключенными.

Ручной checksum-bound deploy тем же canonical producer, который использует workflow:

```bash
set -euo pipefail
node scripts/staging-release-archive.js create-git . easyboost-staging-release.tar.gz
node scripts/staging-release-archive.js inspect easyboost-staging-release.tar.gz
sha256sum easyboost-staging-release.tar.gz
helper_sha="$(node scripts/staging-helper-bundle.js digest scripts)"
sudo /usr/local/sbin/easyboost-staging-deploy \
  easyboost-staging-release.tar.gz <sha256> immutable-archive-v4 "$helper_sha"
```

Последние два аргумента — обязательные versioned protocol и полный SHA-256 exact helper bundle.

Если supervisor завершился строкой
`STAGING_TRANSACTION_RECOVERY_REQUIRED <exact-json>`, не удаляйте control-каталоги или соседний
`.tmp` вручную. Сохраните JSON из защищённого журнала как один аргумент и повторите **те же** role и
аргументы через recovery helper той же content-addressed generation:

```bash
set -euo pipefail
authority_json='<exact-json из STAGING_TRANSACTION_RECOVERY_REQUIRED>'
sudo /usr/local/sbin/easyboost-staging-recover deploy \
  easyboost-staging-release.tar.gz <sha256> immutable-archive-v4 "$helper_sha" \
  --recovery-authority "$authority_json"
```

Если после сбоя `current` уже переведён на новую проверенную generation, нельзя подставлять её digest
в обычный `recover deploy`: это изменит transaction key старой операции. Используйте отдельный
cross-generation bridge с восемью аргументами после role `bridge`. Сначала установите новую
проверенную generation под fd 8; старые неактивные deadline/session residue этому не мешают, но app
journal или активный typed cutover lock обязаны отсутствовать:

```bash
set -euo pipefail
sudo bash scripts/install-staging-release-helpers.sh
archive='/tmp/easyboost-staging-release.tar.gz'
archive_sha='<full-archive-sha256>'
old_bundle_sha='<full-bundle-sha256-from-failed-run>'
current_bundle_sha="$(sudo cat /usr/local/lib/easyboost-staging-release/current)"
authority_json='<exact-json из STAGING_TRANSACTION_RECOVERY_REQUIRED>'
sudo /usr/local/sbin/easyboost-staging-recover bridge \
  deploy \
  "$archive" \
  "$archive_sha" \
  immutable-archive-v4 \
  "$old_bundle_sha" \
  "$current_bundle_sha" \
  --recovery-authority \
  "$authority_json"
```

Bridge проверяет обе content-addressed generation, но исполняет только текущий supervisor; старый
deploy script и его исходные аргументы используются как проверенный key material для точной старой
transaction authority. Если команда вернула новый `STAGING_TRANSACTION_RECOVERY_REQUIRED`, повторите
bridge только с этим новым exact JSON. К cutover можно переходить лишь после exit 0 и read-only
подтверждения, что все exact deadline/session control paths и retirement tombstones из authority
отсутствуют. Ручное удаление даже одного из них запрещено.

Для rollback/restart используется тот же суффикс `--recovery-authority`, но исходная role и её
аргументы должны совпасть байт-в-байт. Helper передаёт authority отдельно от transaction key,
проверяет bounded exact JSON и соответствие вычисленным deadline/session control namespaces. Raw
`rm`, ручной rename или prefix/glob cleanup этих namespaces, terminal slots и maintenance journals
запрещены: их продолжает только установленный recovery helper под тем же process-lifetime fd 8 flock.
Чужой/изменённый inode оставляет recovery fail-closed.

Linux session wrapper сообщает первую ошибку durable writer по отдельному закрытому для target fd 3:
одна canonical JSON-строка не длиннее 4096 bytes, привязанная к exact `proofToken` и allowlist record
paths. Родитель ждёт и wrapper close, и EOF этого канала. Если собственные TERM/KILL requests также
оставили residue, recovery JSON хранит bounded `posixSessionPublicationAuthorities` без перезаписи
первого пути. Deadline и session terminal evidence резервируют один из 1024 deterministic
root-global private slots через exclusive `mkdir`, durable canonical `reservation.claim` и bounded
payload. Ordinary success не оставляет permanent tombstone: root-bound maintenance callback сверяет
root/container/payload dev+ino и bounds, а затем reclaim-ит exact slot под живым fd 8 flock; mismatch
или crash сохраняет его для повторного recovery.

Reclaim использует crash-restart-safe journal
`<controlRoot>/.maintenance-deletion.<64hex>/` `0700`. В него через pending→rename+fsync публикуется
canonical `claim` protocol v1 с bounds, root/container/payload/reservation identities, kind, source
name и transaction token; затем exact source container durable-переименовывается в `payload` и тем же
способом публикуется zero-byte `moved`, который один разрешает bounded symlink-free recursive delete.
Claim, moved и пустой journal снимаются по одному с fsync. При каждом bind до выдачи authority helper
сканирует не более 65 536 root entries и 1024 exact journals и возобновляет crash на любой durable
границе: empty/pre-claim, claim-before-move, payload-before-marker, partial delete, payload absent или
marker-only cleanup. Foreign name, malformed claim, identity/mode/device/root mismatch и ABA
сохраняются и блокируют recovery.

Deadline request и ACK используют один paired-publication protocol. Writer exclusive-create/no-replace-ит
private regular record `0600` с `nlink=1`, записывает canonical bytes, выполняет `fsync(record)`,
закрывает его и `fsync(control directory)`; только затем exclusive-create/no-replace-ит zero-byte
private regular `<record>.ready` `0600` с `nlink=1`, выполняет `fsync(marker)`, закрывает его и снова
`fsync(control directory)`. Live reader и для request, и для ACK всегда проверяет `.ready` раньше
record: record без marker не опубликован; orphan marker, unsafe/nonzero marker или malformed sealed
record дают fail-closed. Unsealed record, включая zero-byte crash residue, не является transition и
может быть снят только после доказанного settlement owning session путём retirement всего exact
authenticated control namespace. Отдельные unlink, repair или replacement record/marker запрещены.

Restart-safe handoff использует single-link `retirement.claim` и no-replace hard-link baton
`.recovery-baton.<64hex>.claim`, а не pathname transfer. Epoch ограничен 32 links. При исчерпании только
доказанный root-bound fd 8 callback удаляет successor links в обратном порядке, fsync-ит каждый шаг и
возвращает цепочку к исходному `retirement.claim`; без него текущий tip остаётся replayable и helper
останавливается fail-closed. Deadline завершается раньше session.

Producer создаёт deterministic single-member gzip с USTAR regular-file entries. Helper копирует
загрузку в private temporary file, сверяет полный SHA-256, отклоняет non-canonical/NFC aliases,
links, special entries, runtime paths и архивы выше фиксированных границ (256 MiB compressed,
4096 entries, 16 MiB на файл, 384 MiB суммарно, плюс 64 MiB disk headroom; inspect 60 s,
extract 90 s). Затем он передаёт **эти же checksum-verified gzip bytes** в `docker build` через stdin.
Release image строится до PostgreSQL backup и до изменения live tree; после успеха получает
stable local tag, а Compose запускает его с `up --pull never --no-build`. Raw staging
`build`/`up --build` закрыт
намеренно отсутствующим `.guarded-staging-build-context-required`, поэтому `backups/`, `rollbacks/`,
`.env.staging` и untracked debris из live `/opt/easyboost-staging` не могут стать Docker context.

Точный CI archive сохраняется как
`rollbacks/releases/release-<full-sha256>.tar.gz`, а checksum sidecar публикуется последним. Откат
требует явный полный SHA-256 выбранного сохранённого релиза; «последний» и abbreviated SHA запрещены:

```bash
set -euo pipefail
sudo /usr/local/sbin/easyboost-staging-rollback \
  <full-release-sha256> immutable-archive-v4 \
  "$(sudo cat /usr/local/lib/easyboost-staging-release/current)"
```

Rollback повторно сверяет filename, requested SHA, одно-строчный sidecar и bytes, строит image из exact
retained archive до изменения live tree и запускает его без build. Legacy `code-before-*.tar.gz` и
mutable архив текущего каталога не принимаются. При первом переходе на этот protocol активный staging
переводится только отдельным девятиаргументным cutover-entrypoint. Ручное создание или замена
`.release-sha256`, retained archive/sidecar, Compose, Docker tags, locks и recovery journal запрещены:

```bash
set -euo pipefail
bridge_archive='/tmp/easyboost-staging-bridge.tar.gz'
bridge_sha='<full-bridge-sha256>'
legacy_marker_sha='<full-observed-legacy-marker-sha256>'
legacy_compose_sha='<full-observed-legacy-compose-sha256>'
helper_sha="$(sudo cat /usr/local/lib/easyboost-staging-release/current)"
sudo /usr/local/sbin/easyboost-staging-cutover \
  "$bridge_archive" \
  "$bridge_sha" \
  "$legacy_marker_sha" \
  "$legacy_compose_sha" \
  700 644 664 \
  immutable-archive-v4 \
  "$helper_sha"
```

Обычный deploy нельзя запускать, пока cutover не завершился и оператор не доказал отсутствие recovery
journal, exact bridge marker/archive/sidecar/tree, прежний stable/running app image, зелёный readiness и
byte-for-byte неизменную authority PostgreSQL container/image/mount/named volume. Один оставшийся
completed typed-lock tombstone не означает успех, если journal ещё существует. После этой проверки
выполняйте новый workflow: v1/v2/v3, неверная форма CLI и stale same-v4 bundle digest отвергаются до
lock, release store и Docker.

Оба helper требуют Linux, Node.js, Docker Compose и GNU tools (`timeout`, `sha256sum`, `readlink`,
`stat`, `df`, `fallocate`, `truncate`, `cp`) и `flock`. Локальный seed image
`postgres:17-alpine` должен быть заранее загружен и проверен оператором: helper фиксирует его canonical
SHA256 ID в `EASYBOOST_STAGING_POSTGRES_IMAGE_ID`, а Compose принимает только этот immutable ID с
`pull_policy: never`; последующий retag не меняет authority. Helper не выполняет registry pull.
Deploy/rollback дополнительно держат свой nonblocking release-transaction lock
`.staging-release.lock` от чтения active marker/store до финального state proof; он сохраняется при
замене tree и запрещён внутри release archive/Docker context. После `docker build` frozen gzip хешируется
ещё раз. Active `.release-sha256` остаётся прежним во время запуска candidate и атомарно меняется только
после readiness и публикации verified archive+sidecar. Если после promotion не проходит `up`/readiness,
helper проверяемо возвращает прежний image tag, exact code tree, marker, running image identity и
readiness; failed candidate не появляется как готовая rollback-пара. Если любой шаг восстановления
не доказан, `.staging-recovery-required` блокирует последующие deploy/rollback до отдельного ручного
восстановления. Для первой установки failure после promotion удаляет candidate tree/tag/pair и проверяет
пустое bootstrappable состояние; невозможность доказать cleanup также переводит staging в fail-closed.
Инвариант хранилища: **identity-bound transaction-owned temporary/final publication cleanup requires exact
release-store revalidation**. **Success is emitted only after the reservation is removed and the whole
release store is revalidated**. **Verified prior state restored is printed only after exact recovery-state
verification**; невозможность доказать хотя бы один шаг оставляет `.staging-recovery-required`
и не печатает сообщение о восстановлении. Удаляются только точно записанные пути этой
транзакции; broad prune/delete запрещён.
Rollback печатает success или verified recovery только после exact удаления temporary image, всех
reservations, private workdir и transaction marker, затем reservation-free проверки всего release store
и exact active image/tree/marker/running/readiness state.
Docker image ID обязан быть одной canonical строкой `sha256:` + 64 lowercase hex.
Only a successful empty exact-reference image probe proves absence. A timeout, daemon failure, or any
other error is indeterminate and fail-closed; непосредственно перед удалением exact temporary tag
helper повторно проверяет его ID, сохраняет rebound/mismatched reference и никогда не удаляет immutable
ID. Общий
ordered finalizer выполняет image → reservations → private workdir → transaction marker → точный
operation-specific state proof; deploy publication/backup и rollback target semantics остаются раздельными.
Archive/sidecar final path публикуется atomic no-replace, а cleanup сначала изолирует exact inode в
private quarantine и не удаляет foreign replacement по имени. Bounded output capture использует unique
private entry и no-replace publication; primary failure остаётся первой причиной при cleanup error.
Supervisor после TERM→KILL имеет отдельный post-KILL deadline: group probe различает absent/alive/unknown,
и surviving group, probe/signal error либо отсутствие leader close/reap дают явную fail-closed ошибку.

Root-owned launcher/supervisor ограничивает primary-транзакцию 1800 секундами, а checked recovery —
отдельными 600 секундами; внешний `timeout` вокруг helper намеренно не используется, чтобы он не мог
оборвать recovery и оставить неоднозначного владельца cleanup. Workflow timeout равен 60 минутам и
оставляет запас на archive/upload/SSH и supervisor settlement. Каждая Docker/Compose/archive/readiness/backup и live-tree filesystem операция имеет ещё и
собственный bounded timeout; readiness-запросы используют connect/max-time. До extraction и сразу
перед promotion helper удерживает реальные `fallocate` reservations на каждом отличающемся filesystem:
candidate+predecessor tree/archive, 64 MiB headroom и до 256 MiB для bounded PostgreSQL dump.

Release store допускает не более четырёх полных archive+sidecar пар и 1 GiB архивных байтов. Helper
никогда не удаляет автоматически active/единственного predecessor: при достижении границы новый deploy
останавливается до Docker и operator отдельно архивирует либо удаляет целую неактивную пару по своей
контролируемой процедуре. Orphan, symlink, temporary debris или sidecar не из одной строки блокируют gate.

Этот rollback возвращает только image, code tree и release marker. Он **никогда автоматически не
откатывает и не down-migrate PostgreSQL schema/data**. Каждая миграция staging-релиза должна быть
backward-compatible с сохраняемым predecessor; если это невозможно, нужен отдельный заранее проверенный
DB backup/restore runbook и отдельное owner approval.

Mutable tag `easyboost-staging-app:release-<sha256>` указывает выбранный checksum-verified archive
внутри helper-транзакции, но не является immutable provenance attestation и не объявляет Docker image
побитно воспроизводимым: base-image tags и registry state могут меняться независимо.

Workflow `.github/workflows/deploy-staging.yml` запускается вручную или при push в `main`/`production-hardening`. Для GitHub environment `staging` нужны secrets:

- `STAGING_HOST`;
- `STAGING_USER`;
- `STAGING_SSH_PRIVATE_KEY`;
- `STAGING_SSH_HOST_KEY` — полная закреплённая строка из `ssh-keyscan`, проверенная владельцем сервера.

На VPS должен быть атомарно установлен один digest-verified root-owned bundle v4: deploy, rollback,
общая библиотека, canonical archive tool, process supervisor и resolved-Compose verifier. Скрипты из обновляемого
release-каталога `/opt/easyboost-staging/scripts/` через `sudo` не запускаются. Из отдельного exact
audited checkout bootstrap уже выполняет установку. Для последующего helper-only upgrade выполните:

```bash
set -euo pipefail
sudo bash scripts/install-staging-release-helpers.sh
```

Installer descriptor-captures audited sources под отдельным cross-process fd 7 flock, публикует
read-only content-addressed generation
`/usr/local/lib/easyboost-staging-release/generations/<bundle-sha256>` с exact manifest, оставляет
старые поколения для проверки/ручного retirement и затем атомарно заменяет один 65-byte
`/usr/local/lib/easyboost-staging-release/current` pointer. Один стабильный launcher и четыре тонких
`/usr/local/sbin/easyboost-staging-*` dispatcher всегда разрешают этот pointer ровно один раз.
Смешанная, частично обновлённая generation, tampered pointer, stale same-v4 digest и старые v1/v2/v3
завершаются до lock/state/Docker.

Installer также create-once публикует immutable single-link
`/usr/local/lib/easyboost-staging-release/maintenance.lock` `root:root 0600`. Его exact bytes — одна
canonical JSON-строка с newline:
`{"installRoot":"/usr/local/lib/easyboost-staging-release","protocol":"easyboost-staging-quiescent-maintenance-lock-v1"}\n`.
Повторная установка принимает только эти bytes и никогда не заменяет существующий inode. Launcher
сбрасывает унаследованную maintenance metadata, открывает lock read-only на fd 7, доказывает
path↔descriptor identity, owner/mode/link/size, переоткрывает уже доказанный объект через
`/proc/$BASHPID/fd/7` read-write на fd 8 и закрывает fd 7. После SHA-256 он вызывает внешний
`/usr/bin/flock -n 8`, повторяет identity/digest proof и только затем экспортирует
`EASYBOOST_STAGING_QUIESCENT_MAINTENANCE=easyboost-staging-quiescent-maintenance-v1:8:<sha256>`.
Transaction consumer удаляет metadata из environment до любого bounded target, проверяет exact fd 8
inode/bytes/digest и exclusive kernel FLOCK по `/proc/self/fdinfo/8`, затем связывает отдельные opaque
authorities с exact dev/ino roots `easyboost-staging-deadline-controls` и
`easyboost-posix-session-controls` (owner PID/start time + one-run lease). Metadata без уже открытого
fd 8 не является authority.

Node runtime теперь также захватывается по descriptor в отдельную read-only authority
`/usr/local/lib/easyboost-staging-release/node-authorities/<node-sha256>/node` с exact
`node-authority.json`, который публикуется последним как completion marker. Падение до marker оставляет
строго ограниченную `0700` partial authority: retry либо допубликует доказанные bytes, либо атомарно
перенесёт повреждённый inode в retained `.quarantine.<token>` без `chmod`/удаления возможной подмены.
Перед новой allocation/rotation installer no-follow сканирует только exact quarantine namespace и
резервирует лимиты: не более 1024 quarantine entries, 64 GiB apparent aggregate bytes и 8192
просканированных filesystem entries. Исчерпание останавливает установку до mutation. Quarantine не
auto-prune: owner обслуживает его только в offline/quiescent окне после доказанного отсутствия installer,
staging transaction и recovery, по одному exact имени без glob/prefix cleanup, с последующим fsync parent.
Launcher перед каждым запуском повторно проверяет ownership/mode/ancestor identity и digest, открывает
exact binary на fd 9 и выполняет verifier и supervisor через `/proc/$BASHPID/fd/9`. После final bind он
передаёт только metadata `EASYBOOST_STAGING_NODE_AUTHORITY=easyboost-staging-node-authority-v1:9:<pid>:<sha256>`;
сама строка без уже открытого fd 9 authority не даёт. Transaction/session chain сохраняет exact descriptor
для trusted helper-процессов и удаляет metadata и fd 9 до запуска bounded target. Поэтому current,
historical и вложенный bare `node` не могут незаметно перейти на другой host binary. Отсутствие `/proc`
или fixed `/usr/bin/stat`, `/usr/bin/sha256sum`, `/usr/bin/id` закрывает запуск fail-closed.

Отдельному SSH-пользователю workflow разрешается через `sudo` запускать только `/usr/local/sbin/easyboost-staging-deploy`;
rollback выполняет owner/operator с отдельным правом ровно на `/usr/local/sbin/easyboost-staging-rollback`.
Workflow загружает архив, но не исполняемые root-скрипты. Staging URL публикуется отдельным Cloudflare Tunnel route на `http://127.0.0.1:3001`; production route и контейнеры не изменяются.

### Нагрузочная и длительная проверка staging

Контролируемый smoke-тест по умолчанию создаёт 10 параллельных клиентов, ограничивает суммарную частоту 50 запросами в секунду и работает 30 секунд:

```bash
set -euo pipefail
LOAD_TEST_URL=https://staging.useboost.ru npm run load:smoke
```

Gate требует минимум 100 запросов, error rate не выше 1% и p95 не выше 500 мс. Максимальные ограничения инструмента — 50 клиентов, 200 запросов/с и 5 минут; production URL не используется в эксплуатационной процедуре.

Один замер семидневного soak test:

```bash
set -euo pipefail
STAGING_SOAK_URL=https://staging.useboost.ru \
STAGING_SOAK_DIR=/var/lib/easyboost-staging-soak \
npm run soak:check
```

Команда проверяет homepage и readiness, дописывает обезличенный NDJSON и атомарно обновляет `staging-soak-status.json`. Результат считается завершённым только после семи суток без неуспешных samples.

Установка изолированного systemd timer на VPS:

```bash
set -euo pipefail
install -o root -g root -m 644 deploy/easyboost-staging-soak.service /etc/systemd/system/
install -o root -g root -m 644 deploy/easyboost-staging-soak.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now easyboost-staging-soak.timer
systemctl start easyboost-staging-soak.service
systemctl status easyboost-staging-soak.timer --no-pager
cat /var/lib/easyboost-staging-soak/staging-soak-status.json
```

Service запускается с `DynamicUser`, получает запись только в выделенный `StateDirectory` и не читает staging secrets.
