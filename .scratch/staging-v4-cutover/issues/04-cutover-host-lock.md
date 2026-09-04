# 04 — Сделать cutover host-lock восстанавливаемым

Status: implemented; Linux/live verification pending
Blocked by: —
Spec: .scratch/staging-v4-cutover/spec.md#adopt-legacy-staging

## Что сделать

Добавить отдельную persistent authority для host-lock cutover: она атомарно привязана к точному
journal nonce и SHA всех входов, переживает SIGKILL/reboot и разрешает adoption только после
доказанной смерти exact Linux owner process.

## Границы

- Входит bounded `/proc` ancestry proof для переданного cutover `$$`: PID, start time, boot ID и UID.
- Входят deterministic preparing/adoption/released paths, no-replace publication и exact recovery.
- Входят Linux real-filesystem SIGKILL regressions и переносимый deterministic seam.
- Не входят wiring в `staging-cutover.sh` и упаковка в helper bundle: ими владеет issue 02.
- Broad/glob cleanup, PID-age guessing и принятие malformed/foreign state запрещены.

## Файлы

- `scripts/staging-cutover-host-lock.js` — typed acquire/verify/release authority и CLI.
- `test/staging-cutover-host-lock.test.js` — deterministic и Linux SIGKILL regressions.

## Definition of Done

- [x] Initial/adoption/release publication boundaries восстанавливаются детерминированно.
- [x] Live owner возвращает 75; malformed, foreign binding/path/inode и forged PID fail closed.
- [x] Namespace не растёт от tombstones разных journal bindings.
- [x] Syntax, focused ESLint и переносимые focused tests проходят.
- [ ] Linux SIGKILL tests выполнены в Linux CI/host.
- [x] CLI wired после durable journal publication и включён в verified helper bundle.
- [ ] Коммит выполняет координатор после проверки общего diff.
