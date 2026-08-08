# 08 — Экзаменационный режим и release hardening Grammar 2.0

Status: ready-for-agent
Blocked by: 07 — смешанная практика и adaptive focus
Spec: `.scratch/grammar-2/spec.md#testing-decisions`

## Что сделать

Перевести задания 19–24 на новый catalog/evidence/mastery contract, показать итоговый dashboard Grammar 2.0 и доказать весь пользовательский путь на mobile и desktop. Старый режим сохраняет смысл, но ошибки создают точный следующий фокус.

## Границы

- Входят 19–24, итоговый dashboard, offline/resume, документация контрактов и полный выпускной набор проверок.
- Не входят полный пробник ЕГЭ, новые коммерческие контуры и платные provider-вызовы.

## Файлы

- `public/grammar-catalog.js`, `public/screens/grammar.js`, `public/modules/grammar.js` — exam refs, dashboard и новый evidence contract.
- `docs/openapi.yaml`, `docs/`, `storage/` — публичный контракт, retention и persistence parity.
- `test/`, `e2e/` — полный release flow.

## Definition of Done

- [ ] Три встроенных exam forms и generated supplements используют versioned catalog refs и новый error taxonomy.
- [ ] Результат 19–24 сохраняется идемпотентно, обновляет слабости и даёт next practice без ложного mastery.
- [ ] Dashboard показывает 20 stages, due queue, слабые error types, mixed practice и exam entry.
- [ ] Полный E2E проходит на 375px/desktop, keyboard/reduced-motion/offline-resume без horizontal overflow.
- [ ] OpenAPI/operations/retention/schema docs обновлены; full suite, build, live PostgreSQL, security и independent reviews дают ZERO_FINDINGS.
- [ ] `npm test`, `npm run lint` и `npm run check` проходят; один коммит на тикет.
