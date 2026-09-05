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
| 09 — Disk-backed workspace | implemented; local gates passed, Linux CI pending | Linux20/20 и cutover3/3; final focused3/3 и common3233/0fail, helpers frozen. |
| 10 — Lock-fixture backup | implemented; local gates passed, Linux CI pending | Точный pg_dump fixture исправлен, Windows/Linux regression1/1 и reviews0/0; real-flock CI ещё обязателен. |
| 11 — Windows fixture settlement | done | Точная reviewed правка интегрирована; pinned Node22 parent/child16/16, common3233/0fail, Standards/Spec0/0; отдельный коммит. |

Общий Windows gate: 3218 tests, 3119 passed, 99 штатных skips, 0 failed (2999.1 s).
Linux recovery/standalone 224/224; lint/check, secret/history scans и оба независимых review зелёные.
Helper candidate и read-only server evidence: `artifacts/README.md`, `server-baseline.md`.
До настоящего UI deploy нужно отдельно решить наблюдаемое ограничение `/tmp` tmpfs; ни БД,
ни live scripts, ни mounts не менялись. Issue 05 и посторонние prototypes остаются вне ремонта.

09 frozen for verification: parent/workspace rebound and archive-copy write-boundary regressions;
initial final Standards/Spec0/0, Linux20/20 and cutover3/3 passed. Published b2 CI122 is final:
3190 tests,3130passed,59skipped,1failed; build/artifact/browser stages did not run. Windows gate54201
finished3231tests/3127pass/101skip/3knownfail; all09/11 follow-ups are now integrated. Final full gate
10669 completed EXIT0:3233tests,3132passed,101platform skips,0failed/cancelled,3720731.8831ms,
on pinned Node22.23.2 with normalized PATH, concurrency2 and TAP. Sources remain frozen.
The prior successful Windows gate above applies only to issues06–08.
No owner installation has been requested with an unverified bundle. Current details/session/log paths:
`ci-repair-checkpoint.md`, final gate completed2026-09-05 08:58 Omsk.
