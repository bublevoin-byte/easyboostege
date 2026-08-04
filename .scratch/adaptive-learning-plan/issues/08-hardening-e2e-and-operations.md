# 08 — Hardening, E2E and release evidence

**What to build:** Prove the complete feature locally, close integration/security/performance gaps, update operational docs and prepare owner-readable release evidence without pushing or deploying.

**Blocked by:** 01–07

**Status:** complete

- [x] Add Playwright tracer: new learner → diagnostic → target → session preview → real task handoff → completion → updated plan.
- [x] Cover existing-user bootstrap, unrealistic goal, one replacement, offline/read-only fallback and free/base/Premium gates.
- [x] Verify migration 031+, file/PostgreSQL parity, export/delete, owner isolation and idempotency.
- [x] Add bounded PII-free metrics and monitoring/runbook/OpenAPI/schema/retention updates.
- [x] Run lint, check, full tests, frontend build, functional/performance E2E and secret scans.
- [x] Run whole-feature Standards + Spec review and fix all P0–P2 findings.
- [x] Record local evidence and leave push/merge/deploy as explicit owner gates.
