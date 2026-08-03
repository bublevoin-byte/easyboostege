# 04 — Duration-aware learning session composer

**What to build:** Compose an executable session from the current plan for 15/30/45/60/90 or custom 15–120 minute durations. Return real eligible activities, meaningful blocks, reasons and breaks; allow exactly one server-validated replacement.

**Blocked by:** 03

**Status:** blocked

- [ ] Write failing invariant, API and preview UI tests first.
- [ ] Enforce five-minute increments, meaningful block minimums, exact duration accounting and breaks over 60 minutes.
- [ ] Treat allocation as a rolling weekly budget rather than rigid per-session percentages.
- [ ] Prefer due reviews/prerequisites, avoid long monotony and fail closed when content is missing.
- [ ] Persist idempotent session creation/current state and one replacement with reason.
- [ ] Reject cross-user/tampered content, attempts and session IDs.
- [ ] Pass targeted tests and independent Standards + Spec review with zero P0–P2.

