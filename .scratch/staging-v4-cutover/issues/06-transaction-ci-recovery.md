# 06 — Сохранить authority незавершённого transaction recovery

Status: in-progress
Blocked by: —
Spec: .scratch/staging-v4-cutover/spec.md#ci-repair-после-run-33870937009

## Что сделать

Исправить потерю возвращаемой dispose retirement authority и преждевременный успех transaction
recovery при retained evidence. Standalone cleanup/complete сохраняет действующий контракт.

## Границы и файлы

- scripts/staging-transaction-supervisor.js, scripts/posix-session-supervisor.js,
  scripts/staging-deadline-control.js и test/staging-transaction-supervisor.test.js (и этот тикет).
- Проверить все три dispose call sites. Для transaction recovery использовать узкий opt-in
  строгого reclaim, не менять глобально semantics standalone cleanup.
- Issue 05, live operations, новые абстрактные recovery механизмы не входят.

## Definition of Done

- [x] Регрессии доказывают exact authority + status 125 при неполном завершении.
- [x] Existing standalone recovery tests сохраняют прежнее поведение.
- [x] Focused tests и review пройдены; Linux-only доказательства явно отмечены.
- [x] Общие lint/check/npm test пройдены; отдельный коммит делает координатор.

## Comments

2026-09-05 — Implementation готова; статус остаётся `in-progress` до общих проверок,
независимого review и отдельного коммита координатора.

- Все три transaction dispose call sites сохраняют возвращённую exact retirement authority:
  синхронный startup, штатное settlement и spawn error без PID. Retained authority даёт status 125.
- `completePosixSessionRecovery` использует `requireReclaimedRetirement = false` по умолчанию;
  только transaction recovery передаёт `true`. При retained evidence отказ содержит точную
  tombstone authority через существующий error/serialization contract.
- Четыре новые регрессии прошли red → green на согласованных exported supervisor seams,
  включая реальную filesystem-проверку source/payload inode и сериализации recovery authority.
  Две прежние success fixtures получили явный session maintenance reclaimer; их assertions
  сохранены. Установленный launcher уже связывает fd8 maintenance lock перед run/recover.
- Windows, Node 24.16.0: transaction файл — 48 tests, 46 pass, 2 Linux CLI skip;
  release-command-supervisor + staging-deadline-control — 173 tests, 170 pass, 3 skip.
  Focused ESLint, `node --check` для трёх файлов и scoped `git diff --check` прошли.
- Linux CLI, общие lint/check/npm test и независимый Standards/Spec review выполняет координатор.
  Коммита, push и live operations в рамках этого implementation не было.

2026-09-05 — Дополнение после независимого Spec review: воспроизведена потеря старой authority
при повторном вызове cleanup с retained evidence. Координатор расширил тот же тикет на
`scripts/staging-deadline-control.js`: аналогичный дефект затрагивал deadline cleanup/completion.

- Transaction передаёт явные strict opt-in для POSIX publication/retirement cleanup и deadline
  publication/retirement cleanup/completion. Обычные standalone defaults остаются `false`.
- Реальные повторные вызовы с сериализованной первой ошибкой проверяют прежнюю exact authority,
  payload inode/bytes, неизменные записи control root и session handoff. Исправлено также добавление
  выдуманного пути вместо ранее подтверждённой `null` authority на отсутствующей стороне.
- Linux CLI publication test теперь останавливается раньше с exact publication authority;
  повторный CLI вызов обязан сохранить ту же authority, payload и набор root entries.
- Успешная collision fixture передаёт maintenance для обеих сторон и требует полного удаления
  точного deadline tombstone. Семь новых тестов покрывают подтверждённые дефекты; existing
  standalone assertions не менялись. Focused lint/syntax/diff checks для всех четырёх файлов прошли.
- Финальные common gates и Linux rerun выполняет координатор перед отдельным коммитом.

2026-09-05 — Финальная проверка координатора: Linux transaction + release-command + deadline —
224 tests, 224 passed, 0 failed/skipped (81.1 s); Windows тот же batch — 219 passed, 5 Linux skips.
Повторные независимые Standards/Spec review: 0/0 findings; исходный Spec P1 закрыт. Общий Windows
`npm test` ещё выполняется, затем последуют lint/check и отдельный коммит.

Итог общего Windows gate: 3218 tests, 3119 passed, 99 штатных skips, 0 failed/cancelled
(2999.1 s). Полные lint/check, secret/history scans и diff check прошли. Отдельный Linux batch
224/224 и оба review остаются зелёными; внешний Linux CI — следующий release gate.
