# 05 — Real module execution and evidence feedback

**What to build:** Launch each planned block into the existing grammar, vocabulary, reading, listening, writing, speaking or exam workflow; accept completion only through server-owned attempts and update evidence/next steps after every block.

**Blocked by:** 04

**Status:** done

- [x] Write failing integration/browser tests across representative modules first.
- [x] Add stable route/activity handoff and return-to-plan state.
- [x] Make advance/finish idempotent and derive result from persisted attempts.
- [x] Persist factual session context separately from trust quality; never infer timed/unassisted or retention evidence from a launch/reason label, and keep client-scored work preliminary.
- [x] Recalculate estimates after blocks while respecting visible-plan stability.
- [x] Show completed work, evidence gained, plan changes and next action.
- [x] Preserve queued existing attempt sync without fabricating offline server completion.
- [x] Pass targeted tests and independent Standards + Spec review with zero P0–P2.

Implementation closes the real execution loop for client-scored modules, the fixed grammar exam and
server-owned Writing/Speaking reviews. Claims are exact owner/session/block/launch-bound HMAC bearers;
factual practice context stays separate from evidence trust. The owner-bound browser runtime durably
replays start, break, finish, attempt/bind/advance and consumed-attempt recovery without creating a
second attempt. Writing and Speaking keep the exact task locked and preserve the paid review until an
explicit return. Migration 036 removes legacy plaintext claims safely, including consumed legacy
Writing/Speaking bindings, while preserving new HMAC and recovery replays on an idempotent rerun.

Final verification: 636 tests passed, 11 expected PostgreSQL-without-URL tests skipped, 0 failed;
disposable PostgreSQL 11/11; full Chromium diagnostic/client-module/exam/Writing execution; lint,
syntax/inline handlers, 17-asset frontend build, secret and history scans, and `git diff --check`.
Independent Standards and Spec re-reviews both passed with zero P0–P2. No paid provider call, push,
merge, deploy or staging mutation was performed.
