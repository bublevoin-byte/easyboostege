# 24 — Isolate the newly reached recovery deadline

Status: in-progress
Blocked by: None — published23/native6 evidence exists; independent of pending canonicalCI130.
Spec: .scratch/staging-v4-cutover/spec.md#minimize-the-newly-reached-recovery-deadline-feedback

## What to build

A diagnostic-only real installed recovery attempt from verified post-rollback fixture state,
so the next120s failure can be observed without replaying successful deploy and rollback.
This ticket constructs feedback only; no production hypothesis/fix is authorized here.

## Evidence

Published HEAD4e3b02c88f2c02cd2c4f7b1bdf9c6ffbf2910e23. Native6 full run33970687905,
job101318538073, original test line833 now fails waiting for barriers/recovery:
elapsed120010ms,phaseconfig-json-complete,upCountmissing,treepresent,stdout three synthetic
bytes30-newline,empty stderr. The tree marker is retained from the prior rollback, NOT evidence
of this operation's progress. Successful preceding deploy build72871ms/exit210601ms;
rollback tree111700ms/exit177817ms. Whole scenario511228.614408ms. Node22.23.2.
The separate unchanged reduced rollback job101318538174 now succeeds: tree104352ms,
clean closed exit0 at166440ms; contracts11/11. No new recovery-only native loop exists yet.

## Ownership and boundaries

- Fresh isolated worker owns ONLY this issue and two new files:
  .scratch/staging-v4-cutover/debug/ci133-recovery-only.mjs and its .test.mjs companion.
- Read the complete final spec section, applicable AGENTS/tracker/domain instructions,
  implement/diagnosing-bugs/TDD/codebase-design skills and their required references before code.
- Reuse existing diagnostic/factory exports where sound; do not alter existing diagnostics,
  production code, tests, workflows, shared docs, package files or default test inventory.
- Main references: test/staging-release-lock.integration.test.js (especially687–end),
  debug/ci126-rollback-only.mjs and .test.mjs, diagnostics/native-bounded-timing.mjs and the
  real helper installer/generation/archive verification APIs. Read required files completely.
- Root owns spec/PROGRESS, the eventual additive six-minute native job, independent reviews,
  commit/push, canonicalCI observation and actual native execution. No worker commit/push.
- No VPS/browser, new downloads, full-suite repeat, actual local flock/recovery attempt or
  PID0 acceptance. Local focused Node22.23.2 path and cached Linux22.23.1/image44f22c911346
  provenance are in issue23. Use readonly/no-network/private executable temp fixtures only.
- Record exact RED→GREEN contract evidence and remaining inability to reproduce native locally.
  Finite simulated observer contracts do not count as observing the real120s performance bug.
- Keep original120s, bounded later observation, exact expected helper exit1/final-state proof,
  stale-tree non-success and output-error precedence. Retain unsettled fixture evidence safely.
- If full-body duplication would be needed, explain the seam limitation before expanding scope;
  do not change established exported modules silently.

## Definition of Done

- [ ] New fixed CLI proves prepared post-rollback state and observes the real recovery path.
- [x] Real finite-child/result and real-file/archive equivalence contracts show RED→GREEN.
- [x] Local focused syntax/lint/contracts and immutable provenance recorded honestly.
- [x] Root independent reviews and additive bounded native feedback integration recorded.
- [ ] Commit and actual native feedback recorded; no production readiness inferred.

## Worker implementation — frozen for root review

Only this ticket and the two new ci133 files were changed by the worker. No production,
existing test, prior diagnostic, workflow, shared spec/checkpoint/PROGRESS, package or default
test-inventory edit; no commit/push, full suite, download, VPS, browser, actual local recovery
or flock attempt. The initial failed worker made no edits; this one authorized retry succeeded.
Status stays in-progress until root independent review, additive native integration, publication
and actual native feedback. These finite contracts are not the real120s performance reproduction.

Read applicable workspace/server instructions, local tracker/domain guidance (CONTEXT absent;
existing ADRs concern unrelated frontend/auth), complete final spec section, original lock test,
ci126 diagnostic/contracts, native-bounded-timing diagnostic and real archive/installer/generation
APIs. Applied implement, diagnosing-bugs Phase1, TDD at the ticket-approved real-file/archive and
finite-child/result seams, and codebase-design. Explicit ticket ownership overrides implement's
default full-suite/commit/review actions: root owns those actions and independent reviews.

The diagnostic reuses ci126 prepareFixture/verifyFixture/startChild and its original test
factories. It first proves the inherited post-deploy candidate fixture, transforms only its fresh
private payload into archive-extracted current, and independently proves post-rollback bytes,
0444 payload modes,0600 protected files,0700 directories, captured retained identities, exactly
two archive/sidecar pairs, synthetic backup, stable image and container. Current marker/payload
identity is captured before the final preparation proof. Metadata replacement, missing/corrupt
archives/sidecars, unexpected store entries, transaction/host-lock/reservation residue and reset
counter contradictions are refused. Linux proof additionally invokes the real fixture Docker
inspection commands and confirms both temporary image tags absent.

The installer adapter is needed because ci126's installation function is private. It reuses the
exported fixture.factories.prepareInstaller and public generation verifier, compares installed
production helper bytes (except the original trusted-PATH binding), and verifies the distinct
private Node copy/digest. It then removes only the inactive private installer Node input, never
the installed generation or any active fixture. This is not full diagnostic-body duplication.

Prepared stale tree/release-tree are retained, up-count/curl-count/recovery/release-recovery are
absent, and the old phase-tree is retained. Inert build/phase-build/PID/release-build history and
Compose invocation log are omitted; backup timestamp/PID are normalized synthetic history.
Prior supervisor control-root history under TMPDIR is also not replayed: the minimizer starts
with fresh deadline/session control roots, as ci126 does. It does not claim equivalence of OS
caches or prior process history. Any influence of this omission on measured performance remains
native-pending; the unchanged complete original scenario remains authoritative.

The no-argument Linux CLI runs only the installed deploy launcher with the fixed candidate
archive/SHA/protocol/bundle tuple and original BLOCK_AT=recovery,FAIL_CANDIDATE_READY=1. It
accepts no caller command/path/environment arguments. Observation stays120000ms; later
settlement is separately bounded150000ms, with a300000ms hard watchdog covering all setup and
the attempt. The fixed recovery barrier is released only when it appears, after verifying its
private directory identity, using exclusive creation of release-recovery. A retained tree marker
cannot release or satisfy recovery. No arbitrary PID signaling or active-state deletion occurs.

Diagnostic0 requires on-time recovery, closed helper exit1 without a signal, the exact original
verified-prior-state-restored diagnostic, independent final current tree/marker/protected/store/
backup/image/container proof, real Linux Docker inspection and successful report publication.
Recovered payload modes are0644, reflecting the original extracted previous-tree copy. Late
expected1, unexpected0, wrong/missing final evidence and output overflow remain nonzero.
Closed23 and signals retain their exact status. Unclosed inherited pipes return124/uncertainty
while preserving the known child23 in the initial and settlement reports. Private fixture and
capped64KiB stream evidence remain for disposable-environment retirement. Report-write failure
cannot replace a known23 or turn an expected1 result into0. Each emitted row is allowlisted and
at most2048bytes; only byte counts leave child buffers. Phase timeline samples at least500ms
apart and retains at most16rows plus omittedCount, without exposing metadata or claiming CPU data.

### RED→GREEN observations

- First real-file fixture contract: missing module ERR_MODULE_NOT_FOUND,1fail/0pass,
  61.0353ms →1pass/0fail,214.2268ms after post-rollback preparation/proof implementation.
- On-time real finite child with final-file restoration: finishRecoveryAttempt missing,
  1fail/1pass,3279.4753ms →2pass/0fail,353.7271ms through the same seam the CLI calls.
- Same-byte active-marker replacement was wrongly accepted (Missing expected rejection),
  and the missing CLI fell through with0 instead of64 →both green after captured marker proof
  and fixed CLI wiring;4pass/0fail,470.6368ms.
- Linux final Docker disagreement while backing files remained current: wrong0 versus1,
  1fail,220.237078ms →green after final real command inspection was added.
- Actual Linux CLI with closed stdout descriptor returned1 instead of required64, and same-byte
  image symlink was accepted:2fail,204.499886ms →both green after output-failure preservation
  and no-follow/type/mode/link metadata proof. Windows descriptor closure behaves differently;
  that POSIX case is explicitly skipped there, with real read-only-descriptor writer contracts
  passing on Windows. The failed preliminary Windows descriptor assumption is not reported as
  production evidence.

Additional finite contracts exercise late expected1, unexpected0/23, stale-tree-only state,
missing restored diagnostic, unrestored files, output overflow, real report writer/file failure,
signals, exited launchers with finite descendants holding inherited pipes, bounded unsettled
children, missing/invalid/unreadable evidence, Linux special modes/symlinks/hardlinks, and the
actual16row phase cap with repeated same-phase rewrites. Finite children settle naturally before
their test fixtures are removed; the immutable installer fixture is retained for container/VM
retirement. No local real120s loop was run, and Phase2/production hypotheses are not authorized.

### Exact frozen focused checks and provenance

Both new files were normalized to UTF-8 LF before these final checks. Windows Node22.23.2:
25tests/18pass/7POSIX skips/0fail/0cancelled,18461.9439ms,exit0. Linux cached Node22.23.1:
25tests/25pass/0skip/0fail/0cancelled,18867.609733ms,exit0. Syntax for both files, targeted
ESLint using repository rules and Node globals, and git diff --check pass. Existing scripts,
tests and workflows have no diff. No broad/full-suite check was run by this worker.

With measured Linux contracts18867.610ms plus the300000ms attempt watchdog, the six-minute job
has41132.390ms left for checkout/setup/wrapper overhead. This is a measured local contract budget,
not a promise of native timing; root owns the final six-minute job and its observed duration.

- Published source HEAD:4e3b02c88f2c02cd2c4f7b1bdf9c6ffbf2910e23.
- New diagnostic SHA256:838c011fcd38eb69fe46ad5abe798053e1e719725bb7071a66daa28e01aaf990.
- New test SHA256:96bb75daafe28a4e0d367ab4c0b3f5b1b0928a3764f22e87ef563419faebdc32.
- Unchanged common SHA256:17bc4b780913d632bff2b814c514ad4c82d70d95a3d282592c4edfb62aefaaa3.
- Unchanged runtime SHA256:daed4f7d3d309a848d20b803a85890bceccd774d782f702f63499db1601600bd.
- Unchanged deploy SHA256:7a0e252e021ddb13e5e7614a3347ab37b567fd384216e8a8b15a44bac94ef2e7.
- Unchanged rollback SHA256:85aeff1f0d81b575e9b7a78d767539b66291f89e93f51988d77ea9eded2fe153.
- Unchanged original lock test SHA256:43dd8ee425838d038d317930ba18d61add82bbe94b382aa9ef6c35454bfbfb93.
- Unchanged ci126 SHA256:e9162cbaef0dcad230d32a8d6f285622260829c13d9d36cd06d34951bd6a633f.
- Unchanged ci126 test SHA256:1267da2184e7eae8d2a15e8f6711eaee6f9973a55cba7ef1e4daed907bee801d.
- Pinned Windows runtime SHA256:0d0f5e39f9f3d9587bc19f73eab3c2c9c4903fd02d6dbf9c853dd81b3d95fad4.
- Cached Linux runtime SHA256:93956de2e59480474a7b46571da1651180b1a050cdf32641ebec4ce6e478e068.
- Cached image:sha256:44f22c911346d64eb74edc2af1355825d17d70d91c4fb30294581596293b2360.

Windows command (server root):

```powershell
& 'C:\Users\4FE4~1\AppData\Local\Temp\node-v22.23.2-win-x64\node.exe' --test .scratch/staging-v4-cutover/debug/ci133-recovery-only.test.mjs
```

Linux focused command (existing cached fixture; sandbox Docker context access was denied,
then the authorized escalation succeeded, with no auto-review rejection and no download):

```powershell
& 'C:\Program Files\Docker\Docker\resources\bin\docker.exe' --context desktop-linux run --rm --pull=never --network none --read-only --user 1000:1000 --tmpfs '/tmp:rw,exec,mode=1777,size=512m' --mount 'type=bind,source=C:\Users\Ригер\Desktop\Repetotor\Приложение репетитор\server,target=/workspace,readonly' --mount 'type=bind,source=C:\Users\4FE4~1\AppData\Local\Temp\easyboost-ci124-linux-runtime-08f4c66031ef4de6ab02c402b93fd3d6,target=/runtime,readonly' --workdir /workspace 44f22c911346 /bin/bash --noprofile --norc -c 'set -eu; cp /runtime/node /tmp/node; chmod 0755 /tmp/node; exec /tmp/node --test .scratch/staging-v4-cutover/debug/ci133-recovery-only.test.mjs'
```

Native-only feedback command, NOT executed locally:

```bash
node .scratch/staging-v4-cutover/debug/ci133-recovery-only.mjs
```

### New canonical evidence supplied by root

CanonicalCI130run33970687937/job101318538312 on the same4e3 HEAD is final:3258tests,
3192pass/1fail/65skip/0cancelled,2138426.789157ms; PostgreSQL51/51. Its sole failure is still
the original rollback/tree at line815:120004ms/config-json-complete/upCountmissing/treeabsent/
empty streams, original test353712.808127ms; deploy build79972ms/exit231195ms. Canonical never
reached recovery. Native6's independent rollback successes and later recovery failure remain
true, but the old barrier is not sustainably cleared. Ticket24 remains diagnostic-only.
Preserve the separately documented original Windows full-gate taskkill permission failure;
the authorized unchanged supervisor33/33 pass does not turn that full gate green.

## Review correction — current freeze supersedes the first hashes above

Root's independent Spec review found that an unclosed auxiliary Docker inspection became a
generic assertion failure; the final-result catch then returned1 instead of required124.
The same lifetime gap existed in the private installer: waitClosed(false) was ignored before
ci126 requireChildSuccess, which can preserve exited23 despite still-open inherited pipes.
These are diagnostic-only corrections within this ticket; original ci126 exports remain intact.

A small internal auxiliary-settlement operation now requires close before any installer/proof
result is accepted. Timeout throws typed status124 with a fixed allowlisted record containing
role, exited/closed, original status/signal and byte counts. It emits auxiliary-unsettled and
retains the fixture. The actual setup catch preserves typed124 and this record. Final recovery
proof propagates auxiliary124 while retaining the closed recovery helper's original1, signal,
expected diagnostic and unproved final-state evidence in its normal settlement row. Neither
path signals a numeric PID, deletes active state, or allows a report error to replace124.
CLI default installer40s, Docker proof3s, recovery120s, later settlement150s and outer300s are
unchanged. Shorter installer/proof budgets exist only for finite module contracts.

Three added Linux regressions use real finite children whose descendants inherit pipes after
launcher exit0/23. Corrected RED fixture run:3fail/0pass,9857.240650ms; the initial proof threw
false-versus-true at3039.993039ms, final result returned1 instead of124 at3112.636646ms, and the
installer retained generic child23 at3614.431766ms. The installer RED predates the new short
module budget; its real finite descendant closed naturally before the old40s bound, so this
RED establishes the requested shorter seam as well as result mismatch. GREEN with the short
200ms observation checks3regressions plus the unchanged successful proof:4pass/0fail,
4263.480201ms including natural finite descendant closure. At the new deadline, records prove
exited0/23 with closedfalse; final helper1/evidence and all private fixture data are preserved.
The finite auxiliary fixture source was corrected before the cited RED run; an earlier draft
used unsupported static-import-in-eval and was discarded as an invalid reproduction fixture.

The installer regression substitutes only the copied installer source returned from the
existing fixture.factory seam. Real pinned Node executes that private finite source; production
installer and generation bytes are untouched. All original25contract assertions remain; the
successful scenario now uses existing withFixture/finiteRecovery instead of repeating its child
body, retaining all final current-state, verdict, report and private stderr assertions.
The concise equivalence report now explicitly names fresh-supervisor-control-roots alongside
omitted build markers/Compose log. Prior-history/native-equivalence limits above still apply.

The private installer/proof seam rationale was communicated to root before the original build:
ci126 installFixture/proveDockerBoundary are private and unavailable for direct reuse. This
diagnostic reuses its exported preparation/child functions, exposed original fixture factories
and public generation verifier through a focused installed-deploy adapter. No full diagnostic
module duplication, production module edit or broad new abstraction was needed.

Final corrected LF checks:

- Windows pinned22.23.2:28tests/18pass/10POSIX skips/0fail/0cancelled,18474.6745ms,exit0.
- Linux cached22.23.1:28tests/28pass/0skip/0fail/0cancelled,22644.473273ms,exit0.
- Both Node syntax checks and targeted ESLint with repository rules/Node globals pass.
- New diagnostic SHA256:03a11e06be04bc4df7c2594068945ffa9c5f2d55dd48f42f55295adc654e5071.
- New test SHA256:1504d7f5b307ead99404597ea044b0423782e1dbc05349ac02aaa0c679735ff0.
- Exact commands/runtime/container provenance are unchanged from the focused commands above.
- Measured contracts22644.473ms plus300000ms hard attempt leave37355.527ms of the six-minute
  job for checkout/setup/wrapper overhead. This replaces the earlier25-case budget estimate.

Root re-review, commit and actual native feedback remain pending. No broad test, actual local
recovery/flock attempt, guard relaxation, production/workflow edit, commit or push occurred.

## Root final review and publication boundary

Both independent corrected-freeze reviews completed: Spec0 findings (previous P2 resolved),
Standards0 findings (previous P3 duplicate-fixture judgment resolved; no hard-rule violation).
Root read the complete diagnostic/tests, verified both exact SHA256 values and reviewed the
auxiliary124 correction. The worker saved all corrected code, test outcomes and this evidence
before its final reporting turn encountered model capacity. No further worker retry or source
change is needed to preserve or publish these independently verified results.

Root added only two exact ci133 path filters and a third native-recovery-only-diagnostic job
to the existing prototype-only workflow. Six-minute job: checkout with persist-credentials
false, Node22.23.2, the28 focused contracts, then the fixed real diagnostic as the last step.
Independent reviews include this addition. Both existing job bodies and the previous workflow
header except those two filters match4e3b02c after LF normalization; the canonical CI workflow
and tracked production/default tests remain unchanged. No workflow was manually rerun/cancelled.

Root pinned22.23.2 lint/check passed; syntax573localJS,165handlers/106names, including the
known unrelated local untracked inventory. Corrected focused checks above cover the new .mjs
files. Fresh candidate secret scan passed1584tracked+21explicit/1588unique,848DockerCOPY inputs;
git diff --check passes. The complete original Windows23 and canonicalCI130 unit results are
already recorded against identical production/default-test bytes and remain non-green for
their disclosed reasons. Do not relabel them, weaken tests or repeat the full suite merely
for these diagnostic-only files. This publication is solely for native feedback, not a release.

Intended scoped commit: two new diagnostic files, this issue, final spec, PROGRESS, issue23's
terminal CI evidence and the additive diagnostic workflow. Local checkpoint, artifact notes,
historical owner handoff, manifests, baseline source TARs and unrelated files stay out.
Commit, authorized branch push and actual native outcome will be recorded after execution.
