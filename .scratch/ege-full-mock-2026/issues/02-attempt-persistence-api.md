# 02 — Authority попытки, таймеры и хранение

Status: ready-for-agent
Blocked by: 01
Spec: .scratch/ege-full-mock-2026/spec.md#модель-попытки-и-authority

## Что сделать

Добавить owner-bound lifecycle полного пробника в file/PostgreSQL, миграцию и `/api/v1/ege-mocks`: start/current/restore, CAS draft, written submit, oral start/submit, result и bounded assessment retry. Сервер владеет form identity, diagnostic/training mode, deadlines, state/revision, idempotent receipts и score authority.

## Границы

- Входит shared repository contract, migration, API, validation, executable OpenAPI, export/delete/retention и concurrency.
- Start возможен только online и при активной подписке.
- Не входит browser runner, фактический provider-вызов или result UI.

## Файлы

- `migrations/`, `db/`, `services/`, `routes/`, `validation/` — storage/API authority.
- `docs/openapi.yaml`, generator/evaluator — executable schema.
- `test/` — file/PostgreSQL shared contract и HTTP integration.

## Definition of Done

- [ ] TDD RED покрывает owner isolation, deadline, CAS, replay/conflict и mode split.
- [ ] File и PostgreSQL одинаково проходят lifecycle/export/delete/retention.
- [ ] Старый receipt нельзя применить к новой revision/UUID/payload.
- [ ] Result не раскрывает keys до завершения обеих частей.
- [ ] OpenAPI runtime-parity исполняема.
- [ ] Full gates и mandatory live PostgreSQL зелёные с cleanup.
- [ ] Fresh Standards + Spec review даёт literal `ZERO_FINDINGS` ×2.
- [ ] Один локальный commit; push/deploy отсутствуют.
