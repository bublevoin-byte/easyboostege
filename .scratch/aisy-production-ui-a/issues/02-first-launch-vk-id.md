# 02 — Собрать первый запуск и безопасный вход VK ID

**What to build:** Сделать реальный production-контур `Логотип → onboarding → VK ID → cookie-сессия`, включая
повторяемый local fake provider, честное состояние «VK ID не подключён» и server-side identity binding без
передачи OAuth-токенов в браузерное хранилище.

**Blocked by:** 01 — Развернуть production-фундамент «Бумажного маршрута».

**Status:** ready-for-agent

**Spec anchor:** Solution; User Stories 1–8, 41–46; Implementation Decisions — opening and VK adapter.

- [ ] Новый пользователь видит splash, затем утверждённый onboarding, затем вход; completion marker versioned и переживает reload.
- [ ] Вернувшийся пользователь не проходит onboarding повторно; logout не стирает completion marker.
- [ ] Learner login содержит одну доступную primary action VK ID и понятные loading/cancel/error/unconfigured состояния.
- [ ] Server provider boundary использует одноразовые state + PKCE + TTL и точный callback.
- [ ] Успешный callback связывает provider subject с внутренним learner и выдаёт существующую HttpOnly/SameSite cookie-session.
- [ ] Provider tokens и secret values не попадают в URL приложения, localStorage, client bundle или логи.
- [ ] Local fake provider проходит тот же identity/session seam, включается явно и запрещён в production.
- [ ] При отсутствии APP_ID/redirect production fails closed на уровне входа и сообщает операторский placeholder.
- [ ] Password/admin/staging auth остаётся отдельным серверным контуром и не показывается ученику.
- [ ] Unit/integration/E2E покрывают happy path, cancel, expired/replayed state, provider error и неполную конфигурацию.

