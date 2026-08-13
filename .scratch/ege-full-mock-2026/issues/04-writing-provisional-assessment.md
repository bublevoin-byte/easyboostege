# 04 — Задания 37–38 и предварительная оценка

Status: ready-for-agent
Blocked by: 01, 02, 03
Spec: .scratch/ege-full-mock-2026/spec.md#развёрнутые-ответы

## Что сделать

Включить authored задания 37 и 38 в written runner, связать ответы с exact form/attempt и существующей серверной deterministic + rubric evaluation. После written submit assessment выполняется replay-safe; pending/failure не уничтожает objective result и не превращается в ноль. В UI/API рядом с каждым автоматическим баллом постоянно видна маркировка `предварительный`/`experimental`.

## Границы

- Входит accessible editors, word-count boundaries, exact assignment binding, reservation/idempotency, retry state и safe review projection.
- Не входит ручная экспертная проверка, качество §11 или реальный provider-прогон агентом.
- Keys/rubrics не раскрываются до обеих завершённых частей.

## Файлы

- `public/screens/`, `public/modules/` — exam writing UI/state.
- `ai/`, `routes/`, `services/`, `validation/` — exact attempt-bound evaluation.
- `test/`, `e2e/`, `docs/openapi.yaml` — parity/UX/security.

## Definition of Done

- [ ] RED фиксирует missing exact attempt binding/pending semantics.
- [ ] 37/38 принимают только assignment текущей immutable form.
- [ ] Replay не создаёт повторную платную reservation/evaluation.
- [ ] Full/evaluated answer и word truncation остаются воспроизводимы и приватны.
- [ ] Preliminary disclaimer присутствует в UI и API при всех исходах.
- [ ] Full gates, fresh double ZERO review и один локальный commit.
