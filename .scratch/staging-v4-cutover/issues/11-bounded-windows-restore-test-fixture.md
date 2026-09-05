# 11 — Ограниченное завершение Windows restore test fixture

Status: done
Blocked by: —
Spec: .scratch/staging-v4-cutover/spec.md#bounded-windows-test-fixture-timeout--local-gate

## Цель

Repair the confirmed local test-harness timeout/worker hang without changing production restore,
staging helpers or timeout/refusal assertions. First work in an isolated diagnostic copy because
the real 09/10 common gate is still active and its sources are frozen.

## Границы

- Read test/postgres-restore-supervisor.test.js, existing process lifecycle utilities, and the diagnostic
  .scratch/staging-v4-cutover/debug/restore-fixture-timeout-probe.mjs (already RED:8136ms vs3s bound).
- Own only test/postgres-restore-supervisor.diagnostic.mjs and this ticket initially. Copy the original
  test file mechanically; the .diagnostic.mjs name is outside test/*.test.js and retains relative imports.
- Do NOT edit test/postgres-restore-supervisor.test.js until root explicitly releases its freeze.
  Final integration is limited to that original test file plus this ticket; remove the diagnostic copy.
- Follow implement/TDD. Keep original timeout as failure, retain stderr/cause where useful, and bound
  cleanup of exact test-owned processes/streams. Merely masking the error or hiding orphan processes is
  not a fix. No broad process killing, production code changes, new process framework, timeout increases,
  package installation, network or live database operations. No commit/push/full npm test.
- Root owns the currently hung worker, common gates, independent review and integration authorization.

## Definition of Done

- [x] Original finite-child timeout probe demonstrates RED before the change.
- [x] Fast regression proves bounded worker exit and owned child settlement while timeout stays a failure.
- [x] Existing watchdog and related success/failure fixture cases pass without weakening their assertions.
- [x] Source-freeze release obtained; only scoped harness changes integrated, diagnostic copy removed.
- [x] Independent reviews and final common gates verified before completion.

## Evidence

Frozen gate session54201: watchdog test failed at16068.6ms, remaining bodies in that file completed,
but Node worker20792 (created2026-09-05 06:51:17 Omsk) remained live afterward. No direct descendants
were visible in the later Windows process tree. Separate unchanged watchdog test passed1/1 in3852.3ms.
Exact-function finite-sleep probe: timeout rejection at1s, worker exit0 only after8136ms; assertion
requiring prompt exit failed. This isolates fixture settlement, not production restore correctness.

### Isolated diagnostic proposal — 2026-09-05

Seam: the existing `runBashFixture` callable, exercised in a separate Node worker with real finite
test-owned children. The original file remains unchanged and frozen; all code below is currently in
`test/postgres-restore-supervisor.diagnostic.mjs`, mechanically copied before edits.

- Re-ran the original exact-function finite Bash sleep probe before changes: RED, worker exit 8122ms
  versus a 3000ms bound despite the 1000ms timeout rejection.
- Added the real descendant/worker regression before the fix: RED, worker exit 8164ms. The child
  publishes its own Windows PID and has an 8s natural lifetime, bounding even the broken reproduction.
- Timeout-only fix: terminate the still-owned Windows launcher tree with bounded
  `taskkill /PID <child.pid> /T /F` before any leader-only termination; close inherited stdio and wait
  at most another 1000ms for launcher close. The fixture's existing deadline is unchanged.
- Retain timeout `killed=true`, `code=null`, original message and captured stdout/stderr. Tree-kill
  failure, already-exited launcher or missing close produces an explicit `childSettlementUnproven`
  marker and cleanup cause; only after failed bounded termination may a remaining launcher handle
  detach under that failure, following the existing bounded-child uncertainty contract.
- Existing native Job/session wrappers were inspected but are unsuitable unchanged: the reused-PID
  fixture intentionally returns 74 while a replacement remains live for follow-up assertions. Those
  wrappers would terminate it or alter the semantic status. Normal completion/refusal paths are kept.
- Sandbox execution returned taskkill status 1/access denied and correctly failed the descendant
  settlement assertion. The exact scoped test was approved for escalated execution; no unrelated or
  previously hung worker was targeted.
- GREEN, native Windows Node v24.16.0: descendant regression 1179–1189ms, with its published PID
  independently returning ESRCH after worker exit. The exited-launcher/inherited-pipe case also passes:
  worker returns a marked timeout promptly, then the test observes its finite 3s descendant's natural
  exit without treating the stale launcher PID as kill authority.
- Escalated focused command:
  `node --test --test-name-pattern='Windows Bash fixture|read-only.*Bash|remote staging reserves|remote restore success|watchdog|restore identity capture failure|direct restore child|delayed launch|unexpected post-handshake|reused child PID' test/postgres-restore-supervisor.diagnostic.mjs`
  passed 16/16, no skips/cancellations, 36454.6ms, including watchdog identity failure and live reused-PID
  assertions. No old assertion was changed. `node --check` and targeted ESLint passed.

Diagnostic proposal frozen for root read-only review. Integration/source-freeze release and final
common gates remain pending; no full npm test, commit, push, network or live database action was run.
The old standalone debug probe extracts dependencies manually; after integration it needs `spawnSync`
injected alongside `spawn` if reused. The regression already supplies both explicitly.

### Reviewed integration — 2026-09-05

Root explicitly released the original test's source freeze after the previous common gate completed
(session 54201: 3231 tests, 3127 pass, 101 skip, 3 fail, 0 cancelled). Before integration,
`test/postgres-restore-supervisor.test.js` matched the original blob
`7b16b2bff1244eeecdc5dfff69f9c9418e9b5d55` at
`b2b0b0fa382f502e7e54859048ef637f44fd1b2f`. The diagnostic proposal's SHA-256 was verified as
`5A37F72BD1BDAB9DDEDC036F8A19865D9083F7AD989132EFAE5D4DC5D8CA189F`.

- Integrated the exact reviewed 148-insertion / 3-deletion diff with `apply_patch`. The actual test's
  SHA-256 then matched that diagnostic SHA-256 byte for byte; the diagnostic copy was removed with
  `apply_patch`. No further test logic, original assertions, normal-exit or reused-PID behavior,
  existing fixture deadline, production script, or unrelated file was changed by this integration.
- Root's completed independent reviews of this exact proposal reported Standards: 0 findings and
  Spec: 0 findings. Byte identity preserves that reviewed scope.
- Actual-file syntax check with pinned Node v22.23.2, targeted ESLint, and `git diff --check` passed.
- First actual-file TAP run (session 67652) passed 16/16 in 35805.0759ms with no failures, skips or
  cancellations. Its parent, worker and two new regression descendants used explicit Node v22.23.2.
  A follow-up read-only probe found that a PowerShell PATH prepend alone left a stale mixed-case
  `Path` entry, causing ambient Git Bash `node` resolution to choose v24.16.0; this first run is not
  used as proof of ambient child-runtime pinning.
- Repeated the same focused command against the actual file using a process-local Node environment
  clone: remove every key whose lowercase form is `path`, then set exactly `env.PATH` to the pinned
  directory plus the inherited path. Before spawning the test process, Git Bash proved
  `/tmp/node-v22.23.2-win-x64/node` and `v22.23.2`; the parent also reported `v22.23.2`.
  No source or machine configuration changed for this runtime selection.
- Correctly pinned actual-file TAP run (session 81381): exit 0, 16 tests / 16 pass / 0 fail /
  0 cancelled / 0 skipped, 36970.4018ms. The owned descendant timeout case passed in 1182.0039ms;
  the existing watchdog identity failure and live reused-PID assertions also passed. Execution was
  escalated solely for the test fixture's exact owned process-tree termination.

At the integration handoff, status remained `in-progress`: root owned the standalone debug-probe
verification/removal, final integrated common gates and commit. This integration ran no full npm
suite, commit, push, network, live database operation or broad process cleanup.

### Coordinator completion

The original finite-timeout probe passed at1179ms and was removed after its permanent regression
replaced it. Final integrated full gate10669 passed:3233tests,3132passed,101platform skips,
0failed/cancelled,3720731.8831ms, pinned Node22.23.2 parent/Bash child and concurrency2. The old
watchdog failure passed at3070.2ms in that run; both new regressions also passed. All7 tested source
hashes matched after completion. Lint/check/secrets and both independent reviews passed.
This completed local harness repair is recorded in its separate coordinator commit; full Linux CI
and owner installation remain release-level requirements, not claimed live results.
