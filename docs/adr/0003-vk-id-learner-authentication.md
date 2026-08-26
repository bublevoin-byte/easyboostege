# ADR 0003 — Ученический вход VK ID и provider-agnostic identity

**Дата:** 26 августа 2026 года
**Статус:** принято
**Обновляет:** ADR 0002 в части ученического входа; платёжное направление ADR 0002 не меняется

## Контекст

ADR 0002 зафиксировала VK ID-only как будущее направление, но намеренно не реализовала OAuth. Production UI
теперь требует единую мобильную цепочку `splash → onboarding → VK ID → cookie-session`, сохраняя отдельные
Telegram/admin/staging контуры и исторические данные. Реального VK application ещё нет, поэтому интеграция должна
быть проверяема без внешней сети и не может изображать live-готовность.

## Решение

- Learner login использует VK ID Authorization Code + PKCE по проверенному контракту Web SDK 2.6.1. Authorization
  идёт через `https://id.vk.ru/authorize`; server-side exchange — через `https://id.vk.ru/oauth2/auth`; минимальный
  профиль — через `https://id.vk.ru/oauth2/user_info`.
- Exchange передаёт `grant_type`, точные `redirect_uri`/`client_id`, `code_verifier`, `state`, `device_id` в query
  и только `code` в form body. `user_info` получает `client_id` в query и `access_token` в form body. Redirects
  провайдера запрещены, ответы ограничены 64 KiB и таймаутом.
- Extended scope запрещён. Email, телефон и другие профильные поля не запрашиваются. Отдельный confidential
  credential в этом Authorization Code + PKCE контракте отсутствует.
- Каждый flow получает cryptographically random state и PKCE verifier. В storage лежат только SHA-256 state и
  AES-256-GCM sealed verifier с HKDF-ключом от `JWT_SECRET`; транзакция имеет TTL, потребляется один раз и при
  consume атомарно стирает verifier. Startup и периодический retention удаляют хвосты.
- Браузер получает только short-lived `eb_vk_flow` (`HttpOnly`, `SameSite=Lax`, точный
  `Path=/api/v1/auth/vk/callback`, `Secure` на HTTPS) и после callback существующую `eb_token` cookie. Provider tokens не попадают в browser, application URL,
  storage или logs. Callback на каждой ветке очищает flow-cookie, возвращает только allowlisted error code и
  запрещает cache/referrer leakage.
- Обычная browser-навигация на start сохраняет redirect-контракт. Запрос start с точным `response=json` проходит
  тот же transaction/cookie/rate-limit seam и возвращает private `{authorizationUrl}` с абсолютным URL; его
  ошибки остаются JSON 429/503 независимо от navigation headers.
- `(provider, subject)` связывается с отдельным provider-agnostic identity row и случайным непрозрачным internal
  username. Имя, email и телефон не используются для auto-link. `/api/v1/me` возвращает безопасный `displayName`,
  сохраняя `username` как внутренний owner contract и не раскрывая VK subject.
- `VK_ID_MODE=disabled` — default/fail-closed. `live` требует числовой `VK_ID_APP_ID`, точный same-origin callback
  и пустой `VK_ID_SCOPE`. `local` не делает сетевых вызовов, проходит те же transaction/identity/session seams,
  не выдаёт подписку и разрешён только при явно присутствующем точном `NODE_ENV=development|test` с HTTP loopback
  `APP_URL`/callback и портом, равным `PORT`. В local mode HTTP server bind-ится только к точному loopback-сокету (`127.0.0.1` либо
  `::1` для `APP_URL` на `[::1]`), отбрасывает forwarded/public authority, а provider возвращает абсолютный
  configured callback вместо относительного URL, поэтому внешний Host не становится authority. Local listener
  не публикуется через reverse proxy или tunnel и принимает только точный configured `Host`; это development/test
  seam для прямого доступа с той же машины, а не preview environment.
- Первый запуск хранит только versioned device preference. Это не identity authority: серверная `/me` остаётся
  единственным источником сессии, а active subscription — единственным входом в learner shell. Logout marker не
  удаляет; профиль может повторить onboarding без повторного входа.

## Последствия

- Production до создания VK application показывает недоступную кнопку и спокойное объяснение. Live callback
  должен быть зарегистрирован как `${APP_URL}/api/v1/auth/vk/callback`; live-проверка выполняется отдельным ручным
  release gate и не заявляется этим решением.
- Learner UI и browser-side Telegram auth polling удалены; server Telegram/admin transport и исторические данные
  остаются поддержанными.
- File и PostgreSQL обязаны иметь одинаковые one-time, identity, export/delete и opaque-username semantics.
- OAuth endpoints используют `no-store`, `Pragma: no-cache`, `Referrer-Policy: no-referrer` и отдельные rate limits.
  Общий anonymous limiter пропускает только exact versioned/legacy VK start и callback к route-specific limiter;
  service worker никогда не перехватывает `/api/`.
- ADR 0002 остаётся действующей для независимого admin/staging доступа и будущего payment adapter.
