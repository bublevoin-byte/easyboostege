# 06 — Итог, прогноз, разбор и повтор

Status: ready-for-agent
Blocked by: 03, 04, 05
Spec: .scratch/ege-full-mock-2026/spec.md#результат-и-повтор

## Что сделать

Собрать server-authoritative result 12/12/18/20/20 и max 82, versioned прогноз 100-балльной шкалы, exact/preliminary/pending labels, полный безопасный разбор и module-specific next steps. Первый завершённый проход закрепить как diagnostic baseline; последующие проходы той же раскрытой формы — training only и не заменяют прогноз. Exam errors могут направлять adaptive focus, но не доказывают mastery.

## Границы

- Входит result aggregation, conversion policy, history, diagnostic/training semantics, review screen, dashboard/adaptive/error-bank projection.
- Не входит официальный балл, teacher review, ranking или новый authored form.

## Файлы

- `ege-mock/`, `services/`, `routes/` — result/forecast/history authority.
- `public/screens/`, `public/modules/` — result/review/dashboard UI.
- `test/`, `e2e/`, `docs/openapi.yaml` — executable parity.

## Definition of Done

- [ ] RED фиксирует incomplete/mislabeled aggregate и repeat overwrite risk.
- [ ] Primary max строго 82; pending subjective не превращается в ноль.
- [ ] Forecast имеет version/disclaimer и не называется официальным.
- [ ] Keys появляются только после обеих частей.
- [ ] Training repeat не меняет diagnostic baseline/adaptive independent evidence.
- [ ] Full gates, fresh double ZERO review и один локальный commit.
