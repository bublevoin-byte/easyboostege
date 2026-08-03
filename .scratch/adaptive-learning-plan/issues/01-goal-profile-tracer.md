# 01 — Goal and evidence-backed profile tracer

**What to build:** Add the smallest complete authenticated path in which a learner saves an EGE target and receives a preliminary skill profile bootstrapped from existing server-owned attempts/recoveries. Persist the goal and structured estimates with file/PostgreSQL parity, export/delete coverage, strict validation and a minimal "My plan" summary in the current UI.

**Blocked by:** Voice Tutor base branch is present locally; production merge remains a later owner gate.

**Status:** ready

- [ ] Write failing API/domain/repository/frontend tests first.
- [ ] Add a versioned six-module EGE skill taxonomy and transparent evidence weighting.
- [ ] Add owner-bound current-goal/profile persistence and PostgreSQL migration 031.
- [ ] Bootstrap only from server-owned attempt/recovery records; sparse data is marked preliminary with confidence.
- [ ] Add authenticated goal/overview endpoints under `/api/v1/adaptive-learning/`.
- [ ] Add a minimal accessible entry/summary without breaking offline progress rendering.
- [ ] Include all new records in export/delete and document schemas/API.
- [ ] Pass targeted tests, lint/check and independent Standards + Spec review with zero P0–P2.

