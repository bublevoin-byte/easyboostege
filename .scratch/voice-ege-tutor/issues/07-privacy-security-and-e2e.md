# 07 — Приватность, безопасность и сквозная готовность

**What to build:** Voice Error Tutor получает production-shaped защиту: обновлённое согласие, ZDR fail-closed, kill switch, bounded provider events, secret-safe observability, экспорт/удаление, OpenAPI/операционные документы и бесплатный сквозной E2E всего error-recovery loop.

**Blocked by:** 01–06 — все функциональные slices.

**Status:** done

Post-review hardening: runtime `error`/`close`/ACK timeout atomically switches the same capsule to
text/local. `session.updated` is followed by an authenticated idempotent server activation; browser
audio starts only after that response, so pre-activation failure bills zero and later fallback bills
only elapsed activated time while preserving provider/model/prompt cost evidence. PostgreSQL
locks the rule-card owner against concurrent account deletion. Direct xAI ephemeral access is an
explicit residual-risk exception with a 60-second credential window and a fail-closed owner gate;
see `adr-001-direct-xai-ephemeral.md`.

- [x] Raw audio и full transcript отсутствуют в БД, export, logs, metrics и evidence.
- [x] Актуальное voice consent требуется до credential; удаление аккаунта каскадно удаляет summaries/reservations/rule reports.
- [x] `VOICE_TUTOR_ENABLED` и cost kill switch останавливают новые сессии без поломки text/local fallback.
- [x] При обязательном ZDR отсутствие подтверждения провайдера завершает запрос безопасной публичной ошибкой.
- [x] Replayed nonce, parallel session, tampered capsule, prompt injection и oversized events покрыты негативными тестами.
- [x] xAI ephemeral body, model URL, browser subprotocol, server-issued `session.update` и обе формы `response.created` покрыты contract/E2E тестами.
- [x] `session.updated` → authenticated idempotent activation → audio start и нулевое списание до activation покрыты file/PostgreSQL/browser тестами.
- [x] Browser-visible realtime prompt не содержит server-owned `reference` и массивов ответов будущих проверок.
- [x] Fallback/cost metrics исключают legacy quota-only строки; file storage сериализует delete с rule/voice mutations и запрещает orphan reports.
- [x] OpenAPI, privacy, AI operations, monitoring и deployment env examples документируют только имена переменных.
- [x] Fake-provider E2E проходит error → voice sheet → micro-check → transfer → recovery map без платного вызова.
- [x] Полные lint/check/test/E2E/build/secret scans и финальный code review проходят.
