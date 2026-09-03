# 02 — Собрать первый запуск и безопасный вход VK ID

**What to build:** Сделать реальный production-контур `Логотип → onboarding → VK ID → cookie-сессия`, включая
повторяемый local fake provider, честное состояние «VK ID не подключён» и server-side identity binding без
передачи OAuth-токенов в браузерное хранилище.

**Blocked by:** 01 — Развернуть production-фундамент «Бумажного маршрута».

**Status:** done

**Spec anchor:** Solution; User Stories 1–8, 41–46; Implementation Decisions — opening and VK adapter.

- [x] Новый пользователь видит splash, затем утверждённый onboarding, затем вход; completion marker versioned и переживает reload.
- [x] Вернувшийся пользователь не проходит onboarding повторно; logout не стирает completion marker.
- [x] Learner login содержит одну доступную primary action VK ID и понятные loading/cancel/error/unconfigured состояния.
- [x] Server provider boundary использует одноразовые state + PKCE + TTL и точный callback.
- [x] Успешный callback связывает provider subject с внутренним learner и выдаёт существующую HttpOnly/SameSite cookie-session.
- [x] Provider tokens и secret values не попадают в URL приложения, localStorage, client bundle или логи.
- [x] Local fake provider проходит тот же identity/session seam, включается явно и запрещён в production.
- [x] При отсутствии APP_ID/redirect production fails closed на уровне входа и сообщает операторский placeholder.
- [x] Password/admin/staging auth остаётся отдельным серверным контуром и не показывается ученику.
- [x] Unit/integration/E2E покрывают happy path, cancel, expired/replayed state, provider error и неполную конфигурацию.

## Evidence

- Production first launch собран из `public/first-launch.js`, `public/first-launch.css` и оптимизированных
  `public/assets/opening/*`; service-worker build closure проверяется сборкой.
- VK ID boundary реализован в `services/vk-id.js`, `routes/vk-auth.js` и migration 056 с одинаковыми file/PostgreSQL
  contracts. Provider response bounded/timeout/redirect policy, one-time consume, cookie composition, retention,
  opaque username, export/delete и local-mode production ban покрыты focused tests.
- `e2e/aisy-first-launch.test.js` проходит через production bundle без live VK network: splash → onboarding →
  local callback → inactive access, active return без login flash, profile replay, logout marker, retry и disabled.
- Final gates: независимые security и spec/a11y review — `ZERO_FINDINGS`; финальный focused opening/VK/security
  набор — `50/50`; полный `npm test` — `1966 total / 1916 pass / 50 expected PostgreSQL skip / 0 fail`.
  `lint`, syntax/inline check (`491` JavaScript / `208` handlers / `124` names), production build (`526`
  assets), OpenAPI sync, secret scan (`1394` tracked files), history scan (`336` commits), diff-check и три
  Aisy Chromium E2E прошли без ошибок.
- Live VK application ещё не создано; реальный provider smoke сознательно не выполнялся. После integration review и
  настройки live-провайдера нужен отдельный operator smoke; local provider уже проходит тот же identity/session seam.
