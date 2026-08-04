# 04 — Duration-aware learning session composer

**What to build:** Compose an executable session from the current plan for 15/30/45/60/90 or custom 15–120 minute durations. Return real eligible activities, meaningful blocks, reasons and breaks; allow exactly one server-validated replacement.

**Blocked by:** 03 is complete.

**Status:** implementation-complete — audit blockers repaired; final review confirmation pending

- [x] Write failing invariant, API and preview UI tests first.
- [x] Enforce five-minute increments, meaningful block minimums, exact duration accounting and breaks over 60 minutes.
- [x] Treat allocation as a rolling weekly budget rather than rigid per-session percentages.
- [x] Prefer due reviews/prerequisites, avoid long monotony and fail closed when content is missing.
- [x] Persist idempotent session creation/current state and one replacement with reason.
- [x] Reject cross-user/tampered content, attempts and session IDs.
- [ ] Pass targeted tests and independent Standards + Spec review with zero P0–P2.

Post-audit implementation truth:

- Learning blocks use each real consumer's registered minimum (15 minutes for vocabulary, grammar,
  gist listening/reading and speaking interaction; 20 for detail listening/reading and speaking
  monologue; 25 for writing email; 30 for writing essay) and never exceed 30 minutes.
- `vocabulary_practice` launches the existing `scr2` EGE word/SRS queue in forced lexical-choice mode.
  Word formation is deliberately not claimed as executable: it appears in `coverageGaps`, while its
  priority is explicitly assigned to lexical practice in the same vocabulary module with
  `content_coverage_fallback`. A small 2–3 minute target may be overshot by a meaningful block; persisted
  planned/selected overshoot lowers its signed module/skill priority in later sessions. A single gap does
  not block useful practice; `ADAPTIVE_SESSION_COVERAGE_GAP` is reserved for cases where no exact
  meaningful sequence can be built from any justified registered activities.
- Create storage recomputes one canonical preview fingerprint and deterministic block IDs inside the
  serialized file mutation / PostgreSQL owner lock. Registered-activity, ID and budget tampering are
  rejected; reordered JSON, exact replay and concurrent create retain file/PostgreSQL parity.
- Replacement scans across the scheduled break to the nearest learning neighbours, tries only exact
  valid transitions and otherwise returns `ADAPTIVE_SESSION_NO_REPLACEMENT` for all four reasons.
- Final-repair verification: targeted session tests 19/19; full suite 616 pass plus 11 expected no-URL
  PostgreSQL skips (627 total); disposable PostgreSQL 11/11; real Chromium low-budget preview plus
  diagnostic/session/replacement/vocabulary handoff; lint, syntax/inline checks, frontend build, both secret scans and
  `git diff --check`. No paid provider call, push, deploy or staging mutation.
