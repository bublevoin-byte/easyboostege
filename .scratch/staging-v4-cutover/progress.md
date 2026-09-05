# Staging v4 cutover — progress

| Issue | Status | Summary |
|---|---|---|
| 01 — Recovery collision | implemented; Linux/live verification pending | Reserved-slot recovery и ограниченный cross-generation bridge готовы; exact live recovery pending. |
| 02 — Adopt legacy staging | implemented; Linux/live verification pending | Transactional roll-forward cutover, journal-bound prefixes, typed lock, exact PostgreSQL volume authority и idempotency готовы; Linux CI и live cutover pending. |
| 03 — Workflow launcher | implemented; publish/live verification pending | Direct allowlisted sudo launcher и exact Node 22.23.2 pin готовы; publish и новый staging run pending. |
| 04 — Cutover host-lock | implemented; Linux/live verification pending | Crash-safe typed authority, deterministic recovery, cutover wiring и helper bundle готовы; Linux SIGKILL/host proof pending. |
| 06 — CI recovery authority | implemented; local gates passed, Linux CI pending | Exact retirement/publication authority сохраняется при повторных попытках для POSIX/deadline; standalone совместимость подтверждена. |
| 07 — Cutover nonce | implemented; local gates passed, Linux CI pending | Ошибка экранирования исправлена; Linux success/refusal/roll-forward 3/3. |
| 08 — CI fixtures | implemented; local gates passed, Linux CI pending | Шесть причин устранены; host-lock/installer 17/17; real-flock integration требует GitHub Linux. |

Общий Windows gate: 3218 tests, 3119 passed, 99 штатных skips, 0 failed (2999.1 s).
Linux recovery/standalone 224/224; lint/check, secret/history scans и оба независимых review зелёные.
Helper candidate и read-only server evidence: `artifacts/README.md`, `server-baseline.md`.
До настоящего UI deploy нужно отдельно решить наблюдаемое ограничение `/tmp` tmpfs; ни БД,
ни live scripts, ни mounts не менялись. Issue 05 и посторонние prototypes остаются вне ремонта.
