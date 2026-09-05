# 07 — Исправить nonce первого перехода staging

Status: in-progress
Blocked by: —
Spec: .scratch/staging-v4-cutover/spec.md#ci-repair-после-run-33870937009

## Что сделать

Устранить ошибочное двойное экранирование Node-выражения внутри Bash, из-за которого nonce
содержит literal backslash-n и три cutover сценария прекращаются с кодом 69.

## Границы и файлы

- Только scripts/staging-cutover.sh и test/staging-deploy.test.js (и этот тикет).
- Проверять существующий operator seam. Не ослаблять nonce, journal или ownership guards.
- Production/staging mutation и issue 05 не входят.

## Definition of Done

- [x] Nonce корректен и существующие cutover success/refusal/roll-forward сценарии проходят.
- [x] Регрессия наблюдает поведение, без implementation-mirroring assertion.
- [x] Focused tests/review пройдены; Linux-only доказательства явно отмечены.
- [x] Общие lint/check/npm test пройдены; отдельный коммит делает координатор.

## Реализация

Исправлены только две escape-последовательности в `derive_cutover_journal_nonce`:
JavaScript внутри одинарных Bash-кавычек получает `\0` как разделитель полей и `\n`
как завершающий перевод строки. Guard на 64 lowercase hex, journal и ownership
проверки сохранены.

Linux-проверка после исправления nonce выявила преждевременное закрытие stdin
тестовой подменой `docker compose -f - ... config --format json`: подмена сразу
возвращала JSON, и producer `emit-compose` получал `EPIPE`. Теперь только этот
вариант команды сначала дочитывает stdin, как настоящий Compose, затем выдаёт
модель. Production pipeline и проверка Compose не изменены.

В сценарии `wrong approved mode tuple` исправлена входная fixture: вместо
недопустимого сочетания `755/644/664` передаётся допустимое `700/600/664`,
которое расходится с наблюдаемыми правами marker `644`. Сценарий достигает
проверки precondition; ожидаемый status `67` и assertions сохранности metadata
остаются прежними. Проверка аргументов production не изменена.

Регрессией остаются три существующих сценария operator seam в
`test/staging-deploy.test.js`: успешное принятие legacy release, продолжение
прерванного journaled cutover и отказ по невыполненным preconditions. Они уже
падали в Linux CI run `33870937009`; дополнительных assertions по исходному тексту
или отдельного helper ради тестирования не добавлено.

Проверки реализации:

- Git Bash `-n scripts/staging-cutover.sh` и `git diff --check` пройдены.
- После исправления Compose fixture пройдены `node --check` и ESLint для
  `test/staging-deploy.test.js`; Linux operator regression повторяет координатор.
- По Linux-прогону координатора success и roll-forward прошли после исправления
  stdin fixture. Refusal повторяется после исправления допустимого mode tuple;
  для последней правки повторно пройдены syntax, ESLint и `git diff --check`.
- Focused запуск трёх cutover-сценариев на Windows: 0 failures, 3 штатных skips
  из-за отсутствия Linux `/proc` и POSIX lock semantics; это не Linux pass.
- Полный Windows-прогон файла остановлен через Ctrl+C: параллельно менялись
  helper-файлы, а тесты фиксируют bundle digest при загрузке. Этот прогон с
  возникшими deploy failures не используется как свидетельство общего gate;
  повтор выполняет координатор после завершения всех правок.
- Реализация передана координатору для Linux regression, общего Standards/Spec
  review, `lint/check/npm test` и отдельного коммита. До этих проверок статус
  остаётся `in-progress`.

2026-09-05 — Финальный Linux rerun координатора после freeze всех helper-файлов:
3 tests, 3 passed, 0 failed/skipped (52.4 s), включая success/refusal/roll-forward.
Независимые Standards/Spec review: 0/0 findings. Общие Windows gates ещё выполняются.

Итог общего Windows gate: 3218 tests, 3119 passed, 99 штатных skips, 0 failed/cancelled
(2999.1 s). Полные lint/check, secret/history scans и diff check прошли. Внешний Linux CI —
следующий release gate; локальные 3/3 cutover operator сценария прошли без skips.
