#13 — Различить успешное завершение и ошибку при host-lock timeout

Status: in-progress
Blocked by: — (disjoint from ticket12)
Spec: .scratch/staging-v4-cutover/spec.md#observable-host-lock-settlement--ci123-diagnostic-loop

## Что сделать

Attach bounded safe settlement/timing evidence to the exact two failing100ms host-lock test calls,
without changing their verdict or deadlines. This is a diagnostic loop, not a production repair.

## Границы и файлы

- Exclusive implementation: test/postgres-restore-recovery.test.js and this ticket only.
  Root owns spec/PROGRESS/checkpoint, reviews, one common full gate and publication.
- Use implement/TDD/diagnosing-bugs. Two existing calls: abandoned canonical directory release
  and typed lifecycle evidence retention (base0898 lines432/454). Keep100ms and all assertions.
- Fixed action label, monotonic elapsed, existing hostOperationActionSettled/Succeeded booleans,
  safe bounded cause classification only. Original error object is rethrown even if diagnostics fail.
- Small existing test-local seam, no generic logger. No production code, workflow/runner changes,
  runtime tuning, speculative fix, retried mutation, new timeout, weakened test or broad refactor.
- Preserve the existing deliberate5ms timeout test, cleanup and fixture state/authority proofs.
- Fast RED→GREEN regressions exercise actual exported bounded release/retain operations with a
  finite slow callback. Cover success/underlying failure/diagnostic failure and exact error identity.
- No network, VPS, full suite, commits, pushes or subagents. Report frozen SHA and focused evidence.

## Definition of Done

- [x] Bounded classified evidence reaches diagnostics at the two actual CI call sites.
- [x] Fast real-seam RED→GREEN proves evidence and unchanged error/timeout/settlement semantics.
- [x] Original tests/assertions/deadlines preserved; focused suite, syntax/lint/diff checks pass.
- [ ] Independent Standards/Spec reviews and root common gates pass, scoped commit published.
- [ ] Actual CI evidence examined; no unsupported cause or deploy-readiness claim.

## Evidence

CI123 tests1489/1490 failed with release/retention100ms messages (scenario131.431193/411.695896ms).
Root60repetitions x2 unchanged tests at parallel4 passed on WindowsNode22.23.2 and localLinux22.23.1.
Run pinnedNode `.scratch/staging-v4-cutover/debug/ci123-host-lock-timing-probe.mjs`:
baseline2/2passed172ms; controlled125ms sync latency produces exact both100ms errors in3022ms.
No observed actual runner disk timing. Do not mistake injected latency for proof of CI cause.

## Implementation and frozen handoff — 2026-09-05

Source is frozen for root review/common gate; status remains in-progress until publication and
actual CI observation. Only this ticket and `test/postgres-restore-recovery.test.js` were edited.
Base HEAD: `0898f55a64af162321f7f9668026cfe874a19053`.
Frozen test-file SHA256: `B63621A850C23AA4D40F673E6F176570421E443CC0004E7218D9288E8D8452ED`.

The small test-local `withHostLockFailureEvidence` seam emits one failure-only
`[host-lock-settlement]` record with allowlisted release/retention labels, monotonic integer
elapsed milliseconds, existing boolean settlement flags (null when absent), and cause class
none/other or exact allowlisted EIO, ENOSPC, EACCES, EPERM, ENOENT, EEXIST. No error messages,
paths, stacks, arguments or environment values are copied. Each allowed record fits256characters.
Diagnostic read/write failures cannot replace the exact original exception. Successful calls
retain their normal result and produce no diagnostic. No mutation is retried.

The two original100ms call sites now use this seam before their existing finally cleanup.
All original assertions, callback ordering, fixture authority proofs and the intentional5ms
timeout test remain unchanged. Production modules, workflows, runner and ticket12 were untouched.

### Local feedback loop and TDD

Every command below used the pinned executable
`C:\Users\4FE4~1\AppData\Local\Temp\node-v22.23.2-win-x64\node.exe` (v22.23.2), from server root.

- Before implementation, unchanged command
  `node .scratch/staging-v4-cutover/debug/ci123-host-lock-timing-probe.mjs`:
  zero-delay baseline2/2passed in176.4659ms;125ms delay reproduced both exact100ms timeout
  messages/exit1 in3034.5246ms. The probe itself exited0 after checking both expected verdicts.
- RED: `node --test --test-reporter=tap --test-name-pattern='host lock failure evidence preserves settled successful timeout errors' test/postgres-restore-recovery.test.js`
  failed with missing diagnostics (`0 !== 1`),134.0537ms. After adding failure evidence,
  the same test passed in196.9464ms, exercising real exported release and retain callbacks.
- RED: the pattern `host lock failure evidence classifies settled failed timeout causes without details`
  failed with causeClass none versus expected EIO,133.6059ms. After allowlisted cause classification,
  both new tests passed (305.2961ms), including oversized unapproved cause codes mapped to other.
- RED: the pattern `host lock failure evidence preserves direct action errors without inventing settlement`
  failed with none versus ENOSPC,113.9261ms. After direct-error classification, all3passed339.2567ms.
- Five new tests cover14 parameter cases through actual exported bounded operations: settled
  success/failure after a finite30ms callback and5ms deadline, direct failure, ordinary success
  including retain evidence/result identity, and diagnostic cause-read/output-write failure.
  Regressions assert exact exception identity, unchanged settlement flags, bounded safe output,
  and no repeated action. Normal-success and diagnostic-failure cases also passed without
  further implementation changes.
- The5new tests plus the unchanged intentional5ms and two original100ms cases:8/8passed597.1383ms.
- `node --test --test-reporter=tap test/postgres-restore-recovery.test.js`:68/68passed2925.281ms
  (63original tests plus5new tests).
- Scoped `node --check`, pinned-node ESLint on this file and `git diff --check` passed.
  No full repository suite or Linux full-flock scenario was run by this agent.

### Evidence at the exact two CI call sites

The unchanged root timing-probe file was run after implementation with an in-memory read-only
observer on its existing spawn result to inspect diagnostic lines omitted by its summary filter.
Zero-delay baseline remained2/2green170.7407ms with no failure diagnostics. Injected125ms fsync
delay still produced both original100ms errors/exit1 in3019.7093ms. Exactly two bounded records
were present in captured stdout:

```json
{"action":"release","elapsedMs":697,"hostOperationActionSettled":true,"hostOperationActionSucceeded":true,"causeClass":"none"}
{"action":"retention","elapsedMs":276,"hostOperationActionSettled":true,"hostOperationActionSucceeded":true,"causeClass":"none"}
```

These records establish that this controlled slow-success case is now distinguishable from
the tested underlying-failure case. They do not establish actual CI123 disk latency or its cause.
Root still owns independent Standards/Spec reviews, one common final gate, publication and
actual CI inspection. No install/deploy-readiness claim is made.

## Root common gate — 2026-09-05 11:23 Omsk

Fresh independent Standards/Spec reviews:0/0findings. Integrated pinned WindowsNode22.23.2/Bash,
concurrency2:3241tests,3140passed,101platform skips,0failed,0cancelled;3758432.7868ms. Lint and
syntax/handler checks passed; frozen source hash unchanged. These totals include ticket12's
disjoint regressions. An earlier sandbox run was interrupted after a verified Windows taskkill
permission refusal; the complete authorized run passed unchanged and is the gate cited here.
Root scoped publication follows. Actual Linux CI evidence remains required; no repair/readiness claim.
