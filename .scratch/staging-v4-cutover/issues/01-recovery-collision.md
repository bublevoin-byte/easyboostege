# 01 — Завершить collision deadline/session recovery

Status: implemented; Linux/live verification pending
Blocked by: —
Spec: .scratch/staging-v4-cutover/spec.md#recovery-collision

## Что сделать

Устранить детерминированную петлю recovery, когда deadline retirement уже зарезервировал terminal
slot, но ещё не переместил живой control namespace, а session recovery уже передал baton следующему
процессу. Recovery должен сохранить обе точные authority, сначала завершить живой deadline namespace
в ранее зарезервированный slot, затем продолжить session recovery и никогда не ослаблять fail-closed
проверки identity, scope или payload.

## Границы

- Входит точное распознавание отсутствующего и ещё живого deadline retirement source.
- Входит round-trip predecessor `deadlineRetirementAuthority` вместе с текущим
  `deadlineRecoveryHandoff` и приоритетный resume deadline handoff до следующей мутации session baton.
- Входит реальный filesystem regression для reserved tombstone без payload, живого deadline source и
  уже принятого session recovery baton.
- Не входят ручное удаление control namespaces, broad/glob cleanup, ослабление authority parser,
  migration/cutover PostgreSQL и изменение deploy payload.
- Cross-generation operator dispatch в установленном helper bundle координируется с issue 02, чтобы
  исправленный current supervisor мог восстановить exact key старой проверенной generation, не
  исполняя её deploy script.

## Файлы

- `scripts/staging-transaction-supervisor.js` — порядок recovery и состав точной combined authority.
- `test/staging-transaction-supervisor.test.js` — unit и реальный filesystem regressions collision.

## Definition of Done

- [x] RED→GREEN: cleanup заведомо отсутствующего predecessor source не продвигает session baton.
- [x] RED→GREEN: reserved deadline tombstone + live source + session baton выдаёт combined authority и
  завершается следующим точным recovery без повторного collision.
- [x] Parser принимает только одну текущую deadline recovery role вместе с predecessor retirement.
- [x] Focused test file, targeted ESLint и `git diff --check` проходят.
- [x] Current verified helper имеет строго ограниченный cross-generation recovery entrypoint.
- [ ] Исправление установлено и exact staging authority успешно завершена.
- [ ] Коммит выполняет координатор после проверки общего diff.
