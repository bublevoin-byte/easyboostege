# 07 — Приватность, безопасность и сквозная готовность

**What to build:** Voice Error Tutor получает production-shaped защиту: обновлённое согласие, ZDR fail-closed, kill switch, bounded provider events, secret-safe observability, экспорт/удаление, OpenAPI/операционные документы и бесплатный сквозной E2E всего error-recovery loop.

**Blocked by:** 01–06 — все функциональные slices.

**Status:** ready-for-agent

- [ ] Raw audio и full transcript отсутствуют в БД, export, logs, metrics и evidence.
- [ ] Актуальное voice consent требуется до credential; удаление аккаунта каскадно удаляет summaries/reservations/rule reports.
- [ ] `VOICE_TUTOR_ENABLED` и cost kill switch останавливают новые сессии без поломки text/local fallback.
- [ ] При обязательном ZDR отсутствие подтверждения провайдера завершает запрос безопасной публичной ошибкой.
- [ ] Replayed nonce, parallel session, tampered capsule, prompt injection и oversized events покрыты негативными тестами.
- [ ] OpenAPI, privacy, AI operations, monitoring и deployment env examples документируют только имена переменных.
- [ ] Fake-provider E2E проходит error → voice sheet → micro-check → transfer → recovery map без платного вызова.
- [ ] Полные lint/check/test/E2E/build/secret scans и финальный code review проходят.

