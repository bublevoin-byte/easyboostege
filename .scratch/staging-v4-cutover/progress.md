# Staging v4 cutover — progress

| Issue | Status | Summary |
|---|---|---|
| 01 — Recovery collision | implemented; Linux/live verification pending | Reserved-slot recovery и ограниченный cross-generation bridge готовы; exact live recovery pending. |
| 02 — Adopt legacy staging | implemented; Linux/live verification pending | Transactional roll-forward cutover, journal-bound prefixes, typed lock, exact PostgreSQL volume authority и idempotency готовы; Linux CI и live cutover pending. |
| 03 — Workflow launcher | implemented; publish/live verification pending | Direct allowlisted sudo launcher и exact Node 22.23.2 pin готовы; publish и новый staging run pending. |
| 04 — Cutover host-lock | implemented; Linux/live verification pending | Crash-safe typed authority, deterministic recovery, cutover wiring и helper bundle готовы; Linux SIGKILL/host proof pending. |
