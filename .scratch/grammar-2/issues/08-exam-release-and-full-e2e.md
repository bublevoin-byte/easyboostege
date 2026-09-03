# 08 — Экзаменационный режим и release hardening Grammar 2.0

Status: done
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

- [x] Три встроенных exam forms и generated supplements используют versioned catalog refs и новый error taxonomy.
- [x] Результат 19–24 сохраняется идемпотентно, обновляет слабости и даёт next practice без ложного mastery.
- [x] Dashboard показывает 20 stages, due queue, слабые error types, mixed practice и exam entry.
- [x] Полный E2E проходит на 375px/desktop, keyboard/reduced-motion/offline-resume без horizontal overflow.
- [x] OpenAPI/operations/retention/schema docs обновлены; full suite, build, live PostgreSQL, security и independent reviews дают ZERO_FINDINGS.
- [x] `npm test`, `npm run lint` и `npm run check` проходят; один коммит на тикет.

## Release evidence до freeze

- Первый Standards/Spec freeze-review нашёл exact-form/generated-group binding, полноту per-topic ошибок, потерю живого `EX` вторым route hook, неточный exam → targeted focus и неполный desktop/offline-sync E2E. Пять публичных remediation seams дали RED `1/5` → GREEN `5/5`; итоговый affected-контур — `90/90`.
- Полный unit — `1568` tests: `1526` pass, `42` штатных PostgreSQL skip, `0` fail. Первый post-doc запуск при одновременной нагрузке получил известный несвязанный Speaking `service_hung` timing transient; точный isolated seam (`1/1`) и повторный standalone full suite прошли без изменения кода. Lint, generated OpenAPI check и check (`382` JS, `211` inline handlers, `126` names) проходят.
- Frontend build создаёт `482` проверенных assets (`637.3 КБ` shell JS, `9` lazy chunks). Отдельный Grammar, полный последовательный и adaptive Chromium E2E проходят; Grammar release доказан полными mobile+desktop flows с keyboard, reduced motion, 44px controls, offline edit/reload, durable completion queue, reconnect и одним evidence на физическую тему без horizontal overflow.
- Финальный disposable PostgreSQL project `easyboost-postgres-integration-7656` применил миграции `001–052`, прошёл `42/42`, включая exact form/group/error exam atomic/generated persistence, replay, export/delete и cleanup; container, volume и network удалены, Docker остановлен.
- Secrets scan проверил `1134` tracked files, history scan — `307` commits, `git diff --check` проходит. Явно разрешённый свежий `npm audit --omit=dev --audit-level=high` завершился с `0 vulnerabilities`; manifests после него не менялись.
- Следующий Spec review нашёл разные правила нормализации между exam assessment и экраном результата: точный публичный seam дал RED `0/1` → GREEN `1/1`, а полный exam contract — `12/12`. Один экспортированный exam normalizer теперь одинаково определяет score, displayed correctness, error bank и Voice Tutor action; standalone full unit, static/security gates, dedicated/full/adaptive E2E и свежий audit `0 vulnerabilities` повторно зелёные. PostgreSQL evidence `42/42` остаётся применимым: после него менялись только browser exam rendering/module export, тест и evidence, но не validation/repository/persistence.
- Свежие независимые Standards и Spec review вернули буквальный `ZERO_FINDINGS` на canonical identity `52c341453cd4b4f40c3c8fff727f4e31881ac29521f7fc17c22d2c898c2dc0b2` (base `f2fb2ff50d66862685a7061198595457bc1769d9`, `24` пути, physical-LF manifest `2438` bytes). Финальный metadata-only closeout повторно замораживается и проверяется перед единственным локальным коммитом. Нерелевантный `.scratch/product-readiness-audit/` сохранён; provider/платных вызовов, package install, push и deploy не было.
