# Adaptive EGE Learning Plan — Specification

Status: implementation in progress (Tickets 01–06 complete)
Date: 2026-08-04
Base branch: `feature/voice-ege-tutor` (`cfce08b`)

## Problem Statement

Easy Boost records module progress, attempts, errors and Voice Tutor recoveries, but the learner must still decide what to study next. A module percentage alone does not answer the practical question: "I have 45 minutes now; what exact work gives me the best chance of reaching my EGE target?"

The feature must turn trustworthy evidence into an understandable, stable and executable plan. It must not pretend to know more than the data supports, promise an exam score, or optimize only the weakest headline module while ignoring EGE impact, prerequisites, retention and the learner's deadline.

## Product Outcome

The learner chooses a target EGE score, exam date and realistic weekly study time. Easy Boost then:

1. reuses prior evidence or runs a required approximately 15-minute adaptive diagnostic for a new learner;
2. shows a score forecast range, profile confidence and the most important gaps;
3. allocates a rolling weekly time budget across micro-skills;
4. composes a useful session for the time available now (15–120 minutes);
5. launches real Easy Boost activities and records their outcomes;
6. updates the evidence after every activity while changing the visible plan gradually;
7. schedules short retention checks and a re-diagnostic every 4–6 weeks.

"35% listening" is a weekly budget, not a requirement that every individual session contain exactly 35% listening. A single session respects meaningful block sizes, fatigue, due reviews, prerequisites and available content.

## Primary User Flow

1. The learner opens "My plan" from the home/progress experience.
2. If no reliable profile exists, the app explains that the result is preliminary and starts the short diagnostic. Existing learners can bootstrap from accumulated attempts.
3. The learner sets a target score, exam date and weekly available minutes.
4. The app returns an honest forecast range, confidence, required weekly time and either a feasible trajectory or choices to increase time/adjust the target.
5. The learner selects 15/30/45/60/90 minutes or a custom duration in five-minute increments (minimum 15, maximum 120).
6. A preview explains each block and its duration. The learner can replace or exclude one unsuitable block; percentages cannot be manually edited.
7. Starting the plan opens the real module/activity for the first block. Completion moves to the next block and records evidence.
8. The final screen reports work completed, evidence gained, what changed and the next useful action.

## Users and Commercial Boundaries

- Free: one short diagnostic, result summary and one demo personalized session.
- Active base subscription: full adaptive EGE plan, arbitrary-duration sessions and regular recalculation.
- Premium entitlement: deep diagnostic, Writing/Speaking evidence, Voice Tutor handoff, detailed reports and secondary CEFR/IELTS orientation.
- EGE target planning is primary. CEFR is a secondary, explicitly approximate language profile; this release does not market the diagnostic as an official IELTS score.

All commercial boundaries are enforced server-side. UI-only locks are insufficient.

## Domain Model

### Goal

An owner-bound current goal contains target exam (`ege_english`), target score (0–100), future exam date, weekly available minutes and timestamps. Updating a goal creates a new plan revision but preserves historical evidence.

### Skill

A stable versioned taxonomy maps micro-skills to the existing modules `vocabulary`, `grammar`, `reading`, `listening`, `writing`, `speaking` and `exam`. Each skill declares EGE relevance, dependencies, recommended block size, eligible task operations and whether deep assessment requires Premium.

### Evidence

Evidence is append-only, owner-bound and points at an existing server-owned attempt, diagnostic response, error/recovery or session completion. It stores only bounded structured attributes, not raw voice, full transcripts or new copies of learner essays.

Evidence quality is ordered:

- unseen timed assessment without help: strongest;
- ordinary unassisted module work: strong;
- due day-1/day-7 transfer check: strong retention evidence;
- repeated or hinted work: weaker;
- assisted/Voice Tutor work: useful for selecting instruction, but not proof of mastery.

Trust quality and pedagogical context are separate axes. A session may record that work was planned
practice, exam practice, a scheduled review or an AI-assisted review, but those labels do not prove
that it was unseen, timed, unassisted or a successful retention transfer. Only a server-verifiable
assessment protocol may assign those stronger qualities. Phase-one module scores submitted by the
browser therefore remain low-weight `client_reported` evidence; Writing/Speaking reviews are
server-owned but assisted. A `due_review` planning reason becomes strong retention evidence only
after the dedicated server-owned day-1/day-7 transfer check is completed.

### Skill Estimate

Each estimate exposes mastery 0–100, uncertainty 0–100, evidence count, last observed time, due state and an explanation code. With sparse evidence it is explicitly preliminary. The first implementation is transparent and rule-based; it does not claim calibrated IRT accuracy.

### Forecast and Allocation

The forecast is a range, not a promise. It includes confidence, assumptions, required weekly minutes and feasibility. Priority conceptually combines target gap, EGE impact, due/forgetting pressure, deadline and uncertainty. High uncertainty creates a diagnostic probe rather than blind repetitive practice.

Visible weekly allocation changes by at most 10 percentage points per skill/module in one recalculation unless the goal changes or a critical due review would otherwise expire. Allocation totals 100%, has explicit reasons and never assigns unavailable content.

### Learning Session

A persisted session is generated from one plan revision and duration. It consists of ordered blocks with module, skill, activity/content reference, planned minutes and reason. Durations over 60 minutes include a break. Blocks have pedagogically meaningful minimum sizes and avoid long monotony. The learner may replace one block; the server records the replacement reason and prevents further replacements for that session.

Session completion consumes actual existing module-attempt evidence; the client cannot assert mastery, score or completion without a server-owned attempt/reference. A short-lived owner/block/launch-bound execution claim binds that attempt. If an attempt was persisted but the final advance response was lost, start recovers the exact attempt reference and durably replays advance instead of issuing a second claim. Writing and Speaking keep the exact canonical task locked until the paid review is confirmed; their review remains visible until the learner explicitly returns to the plan.

### Retention and Premium Depth

Existing Voice Tutor day-1/day-7 repeats are surfaced as high-priority exact activities only while the
server-owned repeat is due, regardless of other same-skill minutes already planned that week. The adaptive
overview and session bind the exact repeat/task identifiers and UTC due/window metadata, never a copied
prompt or learner answer. Repeat submission and claim consumption commit in one repository mutation or
PostgreSQL transaction, so a mismatched advertised repeat leaves no orphan attempt. A successful repeat is
bound to the same execution claim and
becomes independent `scheduled_review` evidence; Voice Tutor instruction itself remains assisted and cannot
establish mastery. A repeat already owed to the learner remains completable after Premium expiry because it
requires no new paid AI or voice session.

Day-7 is executable only after the same recovery chain has a passed day-1 attempt. If both timestamps are
already overdue, the composer surfaces day-1 first and does not advertise the server-rejected day-7 action.

The short diagnostic is scheduled again every 28, 35 or 42 days according to confidence and independently
established skill coverage. Fresh adequate independent evidence may establish the first schedule anchor;
missing/sparse evidence still requires the initial diagnostic. Deep Writing/Speaking consumers, live Voice
Tutor handoff and the secondary CEFR/IELTS orientation require current Premium on the server. Orientation
uses only independently established skills, returns insufficient evidence when coverage is too sparse and
always states that it is approximate and not an official IELTS/CEFR result.

An expiring retention window is persisted as a nullable per-skill timestamp derived from the owner-bound
recovery ledger. Only that repository-verified skill/module scope may bypass the ordinary 10-point plan
stability limit; unrelated skills and modules remain bounded.

## API and Integration Boundaries

All public endpoints live below `/api/v1/adaptive-learning/` and require authentication except no new anonymous API is introduced.

The feature exposes owner-bound contracts for:

- current goal and overview;
- diagnostic start/current/answer/complete;
- current profile, forecast and weekly allocation;
- session preview/create/current/replace/start/bind-attempt/advance/finish;
- Premium-only approximate CEFR/IELTS orientation plus explicit access and retention projections.

Exact payloads are defined ticket-by-ticket with strict Zod schemas, bounded lengths and idempotency keys for mutations. Server time and server-owned task references are authoritative.

The browser UI uses the current frameworkless modular/Vite architecture and can later be migrated to React without changing the API/domain contracts. No separate frontend framework migration is part of this feature.

## Failure and Safety Behaviour

- No sufficient evidence: show a preliminary profile and offer/require diagnostic probes.
- Unrealistic target: return a forecast range and concrete choices; do not guarantee success.
- No eligible content for a block: fail closed or compose from another justified eligible skill; never invent a broken route.
- Offline/network loss: retain the last read-only overview and queued existing attempt sync, but do not fabricate a new server plan.
- Duplicate requests: goal, answer, session create/replace/start/advance/finish mutations are idempotent; a consumed exact attempt is recovered without creating another attempt or claim.
- Tampered attempt/task/session identifiers or cross-user access: reject without leaking existence.
- Paid or external AI: never required by automated tests; provider boundaries use fakes. No paid calls in implementation.

## Privacy, Export and Deletion

Goal, diagnostic state, structured evidence, skill estimates, allocations and learning sessions are included in account export and cascade on account deletion with file/PostgreSQL parity. The implementation does not persist raw audio, full voice transcripts or duplicate full writing/speaking answers. Operational logs contain identifiers/counters and reason codes, not free learner text.

## Success Metrics

- `plan_session_started / plan_session_created` and completion rate by duration;
- share of planned minutes completed;
- due-review completion and day-1/day-7 transfer retention;
- reduction of high-impact skill uncertainty;
- forecast calibration measured only after enough real exam/outcome data exists;
- user block replacement rate and reasons;
- no increase in paid AI use caused solely by opening/previewing a plan.

Metrics must not label an assisted answer as mastery.

## Acceptance Criteria

- A brand-new learner can complete a bounded diagnostic and receive a preliminary, explained plan.
- An existing learner receives a bootstrapped profile from server-owned history without repeating a mandatory full diagnostic.
- A learner can set a target and receive an honest forecast/allocation with stability guards.
- A 15–120 minute request produces a valid, explainable session; sessions over 60 minutes include a break.
- One block can be replaced and only once; the new plan remains duration-valid.
- Completing real activities updates evidence and the next plan without trusting client-submitted mastery.
- Free/base/Premium capabilities are enforced by the server.
- File and PostgreSQL stores have equivalent owner isolation, idempotency, export and deletion behaviour.
- The core flow is keyboard accessible and covered by browser E2E.
- `npm run lint`, `npm run check`, `npm test`, frontend build and relevant E2E pass without paid network calls.

## Testing Decisions

Tests use the highest public seams available:

1. authenticated `/api/v1/adaptive-learning/*` behaviour for goals, diagnostic, plan and sessions;
2. browser flow from plan entry through duration preview, execution handoff and completion using Playwright;
3. file/PostgreSQL repository parity, export and delete;
4. fake/local boundaries only for external AI/provider behaviour.

Pure unit tests are reserved for deterministic taxonomy, evidence weighting, forecast/allocation and session-composition invariants. Integration tests assert owner isolation, entitlement gates, idempotency and server ownership. Existing tests are never weakened or deleted.

## Rollout and Dependencies

The branch is intentionally stacked on the completed Voice Tutor branch because Premium sessions may hand off to Voice Tutor and reuse its recovery evidence. Merge order is therefore Voice Tutor first, adaptive plan second. Neither branch is deployed by this implementation.

Feature exposure must be controlled by configuration until content coverage, migration, legal copy and production analytics are owner-approved. Release operations remain owner-only.

## Out of Scope

- An official IELTS score, IELTS certificate or a claim of equivalence to an official IELTS exam.
- Calibrated IRT/CAT claims before a sufficiently large, reviewed item/outcome dataset exists.
- Fully autonomous generation of an unlimited curriculum or paid AI tasks.
- Manual editing of skill percentages.
- Teacher/admin classroom dashboards, parent accounts, social leaderboards or other subjects.
- Push, merge, staging/production deployment, purchases or paid provider calls.

## Source Basis

- FIPI EGE preparation navigator: https://fipi.ru/navigator-podgotovki/navigator-ege
- FIPI official demos/specifications/codifiers: https://fipi.ru/ege/demoversii-specifikacii-kodifikatory
- IES/WWC guidance on spacing and retrieval practice: https://ies.ed.gov/ncee/wwc/PracticeGuide/1
- Council of Europe CEFR global scale: https://www.coe.int/en/web/common-European-framework-reference-languages/table-1-cefr-3.3-common-reference-levels-global-scale
