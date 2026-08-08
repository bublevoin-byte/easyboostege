# 07 — Смешанная практика и точный фокус плана

Status: ready-for-agent
Blocked by: 04 — глагольные конструкции; 05 — части речи; 06 — служебные слова
Spec: `.scratch/grammar-2/spec.md#implementation-decisions`

## Что сделать

Собрать все 20 тем в смешанные и targeted sessions без подсказки названием темы. История показывает конкретные слабости и пары-конфликты, а индивидуальный план назначает точную тему/error focus с учётом срока ЕГЭ, не пропуская доказательные интервалы.

## Границы

- Входят mixed selector, targeted selection, weak-skill history, adaptive recommendation, offline/persistence/export/delete parity.
- Не входят расширение тематических банков и финальная интеграция режима 19–24.

## Файлы

- `public/modules/grammar.js`, `public/screens/grammar.js` — mixed/targeted runner и UI.
- `adaptive/`, `storage/file-repository.js`, `storage/postgres-repository.js`, `public/sync.js` — plan focus и durable state.
- `test/`, `e2e/` — selection, adaptive, offline и parity contracts.

## Definition of Done

- [ ] Mixed selector балансирует темы, типы, новизну и слабости и не раскрывает ответ названием экрана.
- [ ] Recommendation выбирает exact topic/error/confusion focus, имеет server-owned pointer и не доверяет client substitution.
- [ ] Deadline pressure может назначить раннюю практику, но не продвигает stage до eligibleAt.
- [ ] Generated/AI items проходят строгий quarantine и не могут быть sole mastery evidence.
- [ ] Reload/offline sync/adaptive overview/file/PostgreSQL/export/delete tests проходят.
- [ ] `npm test`, `npm run lint` и `npm run check` проходят; один коммит на тикет.
