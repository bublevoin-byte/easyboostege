# 02 — Short adaptive diagnostic

**What to build:** Let a new learner complete a server-owned approximately 15-minute diagnostic that samples uncertain/high-impact skills, stops within its bounds and produces an explained preliminary profile. Existing learners with adequate evidence can continue without repeating it.

**Blocked by:** 01

**Status:** done

**RED evidence:** `node --test test/adaptive-diagnostic.test.js` failed on 2026-08-04 because
`POST /api/v1/adaptive-learning/diagnostics/start` returned 404 instead of the required 201.

- [x] Write failing public API and browser tests first.
- [x] Use a versioned built-in diagnostic item catalog with server-owned answers and skill mappings.
- [x] Implement idempotent start/current/answer/complete state with owner isolation and time/item bounds.
- [x] Prevent hints, retries and client-submitted answers/scores from counting as unseen mastery evidence.
- [x] Add accessible diagnostic UI with progress, time expectation and resume behaviour.
- [x] Persist/export/delete with file/PostgreSQL parity and no paid network calls.
- [x] Preserve v1 in a catalog registry and fail closed for unsupported stored versions.
- [x] Version each catalog together with its policy and use the session's stored version everywhere.
- [x] Adapt the next private probe from accepted answers without exposing profile evidence early.
- [x] Bound start abuse with an early hourly rate and finite 24-hour owner claim retention.
- [x] Give every successful session-bearing start key an immutable owner-bound replay claim.
- [x] Return the exact originally observed answer snapshot for every idempotent replay.
- [x] Apply the same hard deadline to in-progress and ready states.
- [x] Treat replayable browser listening probes as assisted, never independent mastery evidence.
- [x] Build completed-profile evidence through the session's injected catalog-policy registry.
- [x] Render progress and timing from the stored policy projection instead of active v1 constants.
- [x] Atomically persist and replay one immutable allowlisted completion response snapshot.
- [x] Pass the real Chromium keyboard/reload/idempotency/audio/completion tracer with providers disabled.
- [x] Pass targeted tests and independent Standards + Spec review with zero P0–P2.

**Result:** a new learner can start or resume one owner-bound `ege-short-diagnostic-v1` run,
answer only the server-selected current item and complete after the bounded stop policy. The target
is 10 items/about 15 minutes; hard limits are 12 items and 20 minutes, and `ready` does not pause
the deadline. The browser receives no answer key or skill mapping, offers no hint/retry path and
submits only item/choice IDs. Accepted answers privately change the next uncertain/high-impact
probe, while abandoned, expired and merely ready responses remain absent from profile evidence.
Listening probes use local browser speech, so the diagnostic performs no paid or external calls.
They are persisted as assisted with `assisted_local_tts_diagnostic`: they cannot establish
independent mastery or reduce uncertainty, and the UI discloses that limitation.

The registry stores each catalog and stop/expiry/progress policy as one versioned definition. New
runs use the current pair, every resumed run and its final profile use its stored pair, v1 remains
registered and unknown versions fail closed without evidence. Browser progress, item limit, expected
duration and deadline copy are projected from that stored policy; a synthetic v2 with different
9-item/40-minute limits is covered independently. New start keys are checked by a finite per-user process rate before overview
calculation; successful database claims live for at most 24 hours, are capped at 16 per owner and
are pruned. Within that window every successful session-bearing start key, including a second key
that resumed an active run, replays its exact observed session snapshot. Answer rows keep a separate
allowlisted replay snapshot, so an exact retry returns the originally observed answer state even
after later answers or completion. The first completion atomically stores an allowlisted diagnostic,
result and preliminary-profile response with its key/hash. Lost-response and concurrent retries are
served from that immutable snapshot before live profile calculation; another completion key receives
the same canonical response without replacing the first claim. Missing or malformed snapshots fail
closed, and completion replay snapshots and fingerprints are excluded from export.

Migration 032, file/PostgreSQL repositories, concurrency/retention/export/deletion coverage,
OpenAPI/schema/retention docs and the accessible progress-card UI share the same bounded contract.
Verification: targeted diagnostic/adaptive/file tests 55/55, full suite 571 pass with 9 expected
no-URL PostgreSQL skips, disposable PostgreSQL 9/9, real Chromium E2E, lint/check, frontend build
and both secret scans; no paid calls, push, deploy or staging changes.
