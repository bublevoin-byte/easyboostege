# 01 — Goal and evidence-backed profile tracer

**What to build:** Add the smallest complete authenticated path in which a learner saves an EGE target and receives a preliminary skill profile bootstrapped from existing server-owned attempts/recoveries. Persist the goal and structured estimates with file/PostgreSQL parity, export/delete coverage, strict validation and a minimal "My plan" summary in the current UI.

**Blocked by:** Voice Tutor base branch is present locally; production merge remains a later owner gate.

**Status:** done

- [x] Write failing API/domain/repository/frontend tests first.
- [x] Add a versioned six-module EGE skill taxonomy and transparent evidence weighting.
- [x] Add owner-bound current-goal/profile persistence and PostgreSQL migration 031.
- [x] Bootstrap only from server-owned attempt/recovery records; sparse data is marked preliminary with confidence.
- [x] Add authenticated goal/overview endpoints under `/api/v1/adaptive-learning/`.
- [x] Add a minimal accessible entry/summary without breaking offline progress rendering.
- [x] Include all new records in export/delete and document schemas/API.
- [x] Pass targeted tests, lint/check and independent Standards + Spec review with zero P0–P2.

**Result:** authenticated learners can save an idempotent, revisioned EGE goal and see a
confidence-labelled preliminary profile derived only from their persisted module attempts and
validated Voice Tutor recovery/retention outcomes. Taxonomy and evidence weights are versioned;
client-reported/assisted/independent provenance is explicit and centrally validated. Exact activity
aliases cover all 12 taxonomy skills. Versioned `voice-tutor-skill-compat-v1` additionally maps every
current nested Voice Tutor grammar/vocabulary/reading/listening/writing/speaking skill family,
including cross-module word-formation/collocation evidence, without unrelated fallback. Unknown
recovery/repeat IDs stay uncredited, and speaking task 1 is explicitly unsupported until the
taxonomy gains a reading-aloud skill; speaking tasks 2–4 retain their intended mappings. Service
`voice_tutor_*` attempts are not credited separately from their exact recovery/repeat ledger, so a
word-formation recovery cannot also leak into the grammar module default. Each skill
now has its own `unobserved`/`preliminary`/
`established` status; assisted-only or client-only history cannot reduce uncertainty, exceed 49
mastery or confirm a skill, and the whole profile stays preliminary until all 12 skills have enough
independent evidence. Client-reported and assisted scoring contributions are capped per skill, so
hundreds of forged public attempts remain only weak diagnostic guidance. File/PostgreSQL
persistence, export/delete, OpenAPI 3.0 nullable references, privacy docs and an explicit accessible
progress summary are covered. A monotonic profile calculation revision is separate from
`adaptive-evidence-watermark-v1`; no algorithm revision may reduce the append-only source count,
larger backfills advance even with an older timestamp, and an older algorithm cannot replace a newer
one. File/PostgreSQL profile save/get/export share one allowlisted DTO with nested sorted estimates,
while goals share a second allowlisted ISO/null DTO without owner/idempotency fields. Overview returns
only the authoritative DTO accepted by persistence. PostgreSQL reads all evidence sources in one SQL
snapshot and profile plus estimates in one snapshot for get/export; save still captures that snapshot
on the transaction client before commit, avoiding orphan repeats, mixed revisions and pool exhaustion. Rollout
remains fail-closed through one server flag projected to both API and UI. Verification counts are
recorded in `PROGRESS.md`; no paid calls, push or deploy were performed.
