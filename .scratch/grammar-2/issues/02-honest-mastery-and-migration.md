# 02 — Честные стадии освоения и миграция старого прогресса

Status: ready-for-agent
Blocked by: 01 — Версионированный каталог
Spec: `.scratch/grammar-2/spec.md#implementation-decisions`

## Что сделать

Заменить раннее «закреплено после четырёх ответов» на жизненный цикл `not_started → learning → learned → confirmed → stable` с допустимыми проверками через 1/3/7/16/35 дней. Помощь не повышает stage, ранняя практика не перескакивает интервал, поздняя ошибка возвращает слабость в работу, а старое `st=2` безопасно мигрирует в `learned`.

## Границы

- Входят единый reducer стадий, миграция legacy-состояния, owner-bound persistence и честное отображение stage/due.
- Не входят новый четырёхуровневый runner и расширение банка заданий из тикетов 03–06.

## Файлы

- `public/modules/grammar.js`, `public/screens/grammar.js` — доменная модель и UI стадий.
- `storage/file-repository.js`, `storage/postgres-repository.js`, `public/sync.js` — durable/offline state и миграция.
- `test/` — migration, reducer, race и persistence contracts.

## Definition of Done

- [ ] Один доменный reducer определяет stage, eligibleAt, due state, assistance и late regression.
- [ ] Ранние/повторные/replayed события не могут повысить stage дважды или пройти несколько интервалов за день.
- [ ] Старые ok/err/sr/rs/due сохраняются, но ни одна legacy-запись не становится confirmed/stable.
- [ ] Карта тем и результат показывают честный stage, ближайшую проверку и причину возврата.
- [ ] Durable progress, offline queue и file/PostgreSQL-compatible evidence проходят migration/property/race tests.
- [ ] `npm test`, `npm run lint` и `npm run check` проходят; один коммит на тикет.
