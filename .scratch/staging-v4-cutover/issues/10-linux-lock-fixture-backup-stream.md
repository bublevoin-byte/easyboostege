# 10 — Непустой поток backup в Linux lock fixture

Status: in-progress
Blocked by: —
Spec: .scratch/staging-v4-cutover/spec.md#linux-lock-fixture-backup-stream--ci-122

## Что сделать

Diagnose and repair the CI122 first-deploy failure in the real-flock integration fixture. Preserve
the production requirement for a nonempty bounded backup before promotion. The exact fake Docker
pg_dump tuple currently exits 0 with empty stdout; the focused diagnostic is already red.

## Границы и файлы

- test/staging-release-lock.integration.test.js and this ticket only. Source/helper files belong to
  issue09 and are frozen. No edits to issue05, workflow, locks, timeout values or production guards.
- Use implement/TDD. First read the fixture and diagnostic at
  .scratch/staging-v4-cutover/debug/fixture-backup-probe.mjs; replace this throwaway diagnostic with
  a regression at a maintainable existing fixture seam. Do not duplicate the entire fake Docker.
- Add only the exact approved pg_dump response needed by this operator test. Payload is explicitly
  synthetic, not a real database backup; this fixture does not prove PostgreSQL restoration.
- Preserve all existing assertions and add backup-stream evidence as appropriate. No network,
  live actions, commit or push. Root owns shared docs, common gates, CI and publication.

## Definition of Done

- [x] Fast exact-command regression is red before the fix and green after it.
- [x] Generated fixture pg_dump emits a deterministic nonempty synthetic stream; no production guard changes.
- [x] Existing first deploy, rollback, recovery and real-lock assertions remain unchanged or stronger.
- [x] Source freeze reported; independent review and common gates complete.
- [ ] Actual Linux CI verifies the full real-flock scenario (Docker Desktop PID-0 limitation is not bypassed).

## Evidence

CI122 test2719: status1 at integration line557 after releasing the first build barrier. A separate
network-disabled Linux diagnostic on exact published b2 fixture returned `[DEBUG-ci122-backup]
status=0 bytes=0` and failed the nonempty-stream assertion. Container node22.23.1. This is evidence
for the missing fixture behavior, not yet proof that no later integration failure exists.

## Implementation evidence — 2026-09-05

- Read implement/TDD, applicable AGENTS and local tracker; the approved seam is execution of the
  same generated fake Docker script with the production `compose exec -T postgres pg_dump` tuple.
- Extracted the existing template into `lockFixtureDockerScript(current, candidate)`, reused by
  both the real-flock scenario and the fast regression. No duplicate fake Docker implementation.
- RED: `node --test --test-name-pattern='lock fixture emits a deterministic nonempty synthetic backup'
  test/staging-release-lock.integration.test.js` failed at the nonempty-stream assertion after
  the command-status assertion passed (0 pass / 1 fail). Runtime: Windows Node v24.16.0 with the
  existing Git Bash executable. This reproduces the production `test -s` failure at the fixture seam.
- GREEN: the same command passed (1 pass / 0 fail). It invokes the generated fixture twice with
  all production pg_dump arguments, requires successful exits and a nonempty stream, and compares
  both streams for determinism. The added response is explicitly synthetic and is not evidence
  of a valid PostgreSQL backup or successful database restoration.
- A read-only comparison against b2b0b0fa382f502e7e54859048ef637f44fd1b2f proved the moved template
  is byte-for-byte unchanged except for the exact pg_dump branch. Existing real-flock, exclusion,
  recovery, image identity and cleanup assertions were retained. No production files were edited.
- Focused ESLint, `node --check`, generated Bash `-n` and scoped `git diff --check` passed.
- Test source freeze reported to root. Root owns independent Standards/Spec review, common gates,
  shared progress files, Linux execution and publication. No commit, push, network or live action.
- Actual Linux CI is still required to prove that the first deploy completes beyond the backup
  gate and the later rollback/recovery/kill scenario remains green. The known local Docker PID-0
  `/proc/fdinfo` limitation has not been bypassed or treated as a successful full integration run.

Coordinator final common gate passed:3233tests,3132passed,101platform skips,0failed/cancelled,
3720731.8831ms; pinned Node22.23.2 for parent/Bash children, concurrency2. Lint/check/secrets
and independent Standards/Spec reviews passed. Exact test SHA66344fa0…a337 stayed frozen.
Actual GitHub Linux real-flock scenario remains the outstanding verification, not a claimed pass.
