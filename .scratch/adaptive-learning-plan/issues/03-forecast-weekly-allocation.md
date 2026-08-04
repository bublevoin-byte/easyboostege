# 03 — Honest forecast and stable weekly allocation

**What to build:** Convert the goal and evidence profile into an explained forecast range, required weekly time, feasibility choices and a rolling weekly allocation across modules/micro-skills.

**Blocked by:** 01 and 02 are complete; diagnostic evidence from 02 is consumed when present.

**Status:** done

**RED evidence:** `node --test test/adaptive-plan.test.js` initially failed because
`adaptive-learning/plan.js` did not exist (`ERR_MODULE_NOT_FOUND`).

- [x] Write failing deterministic and API/UI tests first.
- [x] Prioritize target gap, EGE impact, due retention, deadline and uncertainty.
- [x] Return a range/confidence/assumptions and never a guaranteed score.
- [x] Provide increase-time/adjust-target choices when the goal is unrealistic.
- [x] Keep allocation totals at 100% and cap ordinary revision changes at 10 percentage points.
- [x] Explain every major allocation and create diagnostic probes for high uncertainty.
- [x] Persist plan revisions and cover export/delete/file/PostgreSQL parity.
- [x] Pass targeted tests and independent Standards + Spec review with zero P0–P2.

**Result:** `adaptive-plan-v1` now converts the current owner-bound goal and authoritative evidence
profile into an explicitly rule-based score range with confidence, assumptions, required weekly
minutes and feasibility. Required time inverts the same capacity equation used by the range, including
the 0.75 effectiveness factor and uncertainty, then rounds upward to five minutes. It never returns a
guaranteed score. An unrealistic goal produces only actionable choices: an increase is strictly above
the learner's current time, never above 2520 minutes, and is marked insufficient when capped; at the
maximum, only a valid target adjustment is shown. Weekly priorities combine target gap, EGE weight,
due/overdue retention, deadline pressure and uncertainty; highly uncertain skills become diagnostic
probes rather than invented mastery. Near deadlines relatively favour high-impact/large-gap work
instead of multiplying all priorities by a factor that cancels during normalization. Final days use
real fractional weeks; a reached/past exam date removes the range and requires a new date.
Every time-dependent calculation uses the UTC start of `recalculationBucket`: the forecast horizon,
deadline priority, critical-reason window, allocation and deterministic `calculatedAt` therefore remain
identical throughout the day. The exam-date bucket itself is expired, while the preceding bucket keeps
an exact final-day horizon of `1/7` week. Actual persistence receipt timestamps remain separate.
Goal exam dates and plan buckets share one SQL-calendar normalizer, so PostgreSQL `DATE` values keep
their local calendar components instead of shifting to the previous UTC day in positive timezones.

Integer module and skill allocations each total exactly 100%. Ordinary recalculations keep every
visible module and micro-skill within 10 percentage points of the previous plan. Ordinary overdue
and `critical_due` work both remain bounded; only a goal revision change may reset the allocation.
`critical_retention_expiry` remains an explainable priority reason, but its persistence bypass is
disabled until Ticket 06 supplies owner/profile-bound persisted expiry that the repository can derive.
Canonical 6-module/12-skill membership, exact totals and module/skill sums are checked from the first
revision. The authenticated overview, goal
response and dedicated `/api/v1/adaptive-learning/plan` endpoint return the authoritative persisted
revision. Migration 033 and both repositories provide owner isolation, idempotent daily/evidence
fingerprints bound to `base_plan_revision`, compare-and-set retries, current-first historical replay,
calculation-first evidence ordering, repository-side stability validation, export/delete parity and
a shared allowlisted DTO. A single shared strict validator rejects malformed or incoherent candidate,
forecast, allocation and stability JSON in both backends and recomputes the supplied metadata fingerprint
before duplicate lookup. A matching retained fingerprint is replayed only when the complete normalized
candidate envelope and plan semantics exactly match that retained revision; IDs and actual receipt
timestamps are the only ignored transport fields. Under the same serialized owner mutation/locked PostgreSQL transaction, the
repository rebuilds the deterministic plan from the full current persisted goal, all 12 persisted skill
estimates, the full profile and the current plan, then requires the candidate envelope and plan JSON to
match exactly. A bare hash or synthetic skill/goal/forecast/allocation cannot replay or persist. Complete
retained fingerprints from an older goal still return current before current-goal/profile checks, while
forged unknown fingerprints fail closed. Goal PUT replay/concurrency responses expose one matching
current goal/profile/plan snapshot with created/replayed/superseded metadata. The browser
renders the range, confidence caveat, explained allocation and feasibility choices accessibly.

Verification: plan domain/API/UI 25/25, adaptive regressions plus file repository contracts 81/81,
full suite 597 pass with 10 expected no-URL PostgreSQL skips (607 total), disposable PostgreSQL 10/10, real
Chromium diagnostic-to-plan E2E, lint/check, frontend build and both secret scans; no paid calls,
push, deploy or staging changes.
