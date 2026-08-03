# 02 — Short adaptive diagnostic

**What to build:** Let a new learner complete a server-owned approximately 15-minute diagnostic that samples uncertain/high-impact skills, stops within its bounds and produces an explained preliminary profile. Existing learners with adequate evidence can continue without repeating it.

**Blocked by:** 01

**Status:** blocked

- [ ] Write failing public API and browser tests first.
- [ ] Use a versioned built-in diagnostic item catalog with server-owned answers and skill mappings.
- [ ] Implement idempotent start/current/answer/complete state with owner isolation and time/item bounds.
- [ ] Prevent hints, retries and client-submitted answers/scores from counting as unseen mastery evidence.
- [ ] Add accessible diagnostic UI with progress, time expectation and resume behaviour.
- [ ] Persist/export/delete with file/PostgreSQL parity and no paid network calls.
- [ ] Pass targeted tests and independent Standards + Spec review with zero P0–P2.

