#12 — Диагностика точного этапа тайм-аута Linux lock scenario

Status: in-progress
Blocked by: — (ticket10 backup implementation already published; its later full CI remains unresolved)
Spec: .scratch/staging-v4-cutover/spec.md#observable-linux-lock-lifecycle--ci123-diagnostic-loop

## Что сделать

Add bounded phase/timing evidence to the existing real-flock integration test so that its actual
CI rollback/tree timeout identifies the last reached operation before cleanup. This delivers a
diagnostic loop, not a production repair or a passing full Linux scenario.

## Границы и файлы

- Exclusive implementation scope: test/staging-release-lock.integration.test.js and this ticket.
  Root owns spec/PROGRESS/checkpoint and publication. No production, workflow, package or other test edits.
- Read implement/TDD and diagnosing-bugs. Use the existing generated fixture and barrier-wait seam.
- Fixed, bounded synthetic phase labels and monotonic elapsed time; bounded stdout/stderr snapshot
  on failure plus last phase/up-count/tree presence. No arbitrary command/environment logging.
- Preserve all existing assertions, default120000ms wait, operation order, exact tuples,
  real-flock/PID/image/container authority and cleanup semantics. No deadline increases or guard bypass.
- New regression proves diagnostics on a finite stalled child while retaining the original failure.
  Do not duplicate the whole fake Docker script or add a generic tracing framework.
- Read the scratch ci123-fixture-tree-probe.mjs result as negative diagnostic evidence: direct
  sequence passes Windows422/397ms and Linux56ms, so it did not reproduce the CI failure.
- No commits, pushes, network, VPS or independent full-suite run. Root integrates one final gate.
  Report exact source hash/freeze and focused commands/results for independent review.

## Definition of Done

- [x] Existing diagnostic seam has a fast RED→GREEN regression for bounded phase/timing output.
- [x] Missing evidence is reported without masking the original failure or bypassing cleanup.
- [x] Original dispatch/gates/assertions/deadlines remain unchanged and focused fixture tests pass.
- [x] Syntax/targeted lint/scoped diff checks pass; instrumentation contains no secret-bearing values.
- [ ] Independent reviews and root common gates pass; one scoped commit published by root.
- [ ] Actual CI captures the needed phase or full scenario passes; no unsupported root-cause claim.

## Current evidence

CI123/exact0898f55 test2728 failed after432379.347363ms: `Timed out waiting for
/tmp/easyboost-real-flock-9OBsRy/barriers/tree`, waitForFile217/caller598, stderr empty. The first
deploy status0 assertion590 preceded this failure. Old backup regression2727 passed. Root reports
final CI123:3205 tests,3141 pass,61 skip,3 fail,0 cancelled. The other two failures belong to a
separate root-owned diagnosis. No production repair or root-cause claim is made here.

## Implementation freeze — 2026-09-05

Source: `test/staging-release-lock.integration.test.js`.
SHA256: `43dd8ee425838d038d317930ba18d61add82bbe94b382aa9ef6c35454bfbfb93`.
Frozen for root independent Standards/Spec reviews and the common gate; status remains
`in-progress` until those checks, publication and actual CI observation complete.

- Fixed fixture phases at config/build/up entry/completion, build input drain and existing barriers.
  Evidence files use only the existing test-owned barrier directory. A new child resets its phase
  to `child-started`; failed diagnostic writes are ignored and reported as unavailable.
- Existing `waitForFile` failures retain their timeout/exit verdict and status/signal. Before
  cleanup they include `[DEBUG-ci123-lock]` JSON: monotonic elapsed milliseconds since child spawn,
  allowlisted last phase, validated up-count, tree presence, and stdout/stderr tails capped at
  1024 UTF-8 bytes each. Metadata reads cap at128 bytes and reject unknown values. No new
  argument/environment/container/config payload logging was added.
- Twelve fixed start/barrier/exit milestones annotate the four original child lifecycles.
  Original assertions,120000ms default deadline, operation order, command tuples, PID/lock/image
  authority and cleanup/settlement implementations are unchanged.
- Three fast regressions use the generated Docker script and existing barrier/cleanup seams:
  finite stalled child; normal config/build/tree activation including a failed diagnostic write;
  absent, unreadable or invalid phase/count evidence with retained nonzero child exit and cleanup.

## RED→GREEN and focused verification

Initial RED, Windows Node24.16.0:

```text
node --test --test-name-pattern='lock barrier timeout preserves' test/staging-release-lock.integration.test.js
FAIL: a stalled child must expose lifecycle evidence before cleanup (154.1665ms)
```

The child executes the generated `compose ... config --quiet` dispatch, emits finite synthetic
output and waits at most4s. The test requests the absent tree barrier with a50ms test-only
deadline, so RED does not require waiting for the production scenario's120000ms deadline.
After implementation the same test passed161.886ms, retaining the timeout and resource cleanup.

Second vertical slice, same runtime:

```text
node --test --test-name-pattern='lock fixture lifecycle evidence follows' test/staging-release-lock.integration.test.js
RED: ENOENT phase-tree after successful config JSON dispatch (50.3127ms)
GREEN: normal config/build/tree lifecycle evidence test passed (259.1886ms)
```

Final frozen source verification:

- Windows Node22.23.2 from `C:/Users/4FE4~1/AppData/Local/Temp/node-v22.23.2-win-x64/node.exe`,
  inherited case variants PATH/Path collapsed to one PATH and pinned runtime directory prepended:
  `--test test/staging-release-lock.integration.test.js` →6 tests,5 pass,0 fail,1 unchanged Linux
  skip,0 cancelled;778.1329ms. New timeout/normal/missing tests193.6375/280.1735/123.7379ms.
- Linux cached image `sha256:39c9d2a20465b52c87a96dda3d64eb84dcf6e4edb7bf2f14f68d0007bb851f17`,
  existing Node22.23.1/Bash, Docker context desktop-linux, read-only repository mount:

```text
docker --context desktop-linux run --rm --pull never --network none \
  --mount 'type=bind,source=C:/Users/Ригер/Desktop/Repetotor/Приложение репетитор/server,target=/workspace,readonly' \
  --workdir /workspace --entrypoint node 39c9d2a20465 \
  --test --test-name-pattern='lock integration cleanup|lock fixture|lock barrier' \
  test/staging-release-lock.integration.test.js
5 tests,5 pass,0 fail,0 skipped,0 cancelled;297.952694ms
```

- Node22.23.2 `--check test/staging-release-lock.integration.test.js` passed.
- Node22.23.2 `node_modules/eslint/bin/eslint.js test/staging-release-lock.integration.test.js` passed.
- `git diff --check -- test/staging-release-lock.integration.test.js .scratch/staging-v4-cutover/issues/12-observable-linux-lock-lifecycle.md` passed.
- Scope audit: source diff231 insertions/6 deletions; edits only this source and this ticket.
  Root owns other concurrent working-tree modifications, the common full gate and publication.

The Linux command intentionally selects only focused regressions, not the full real-flock scenario.
The earlier scratch direct sequence remains negative diagnostic evidence, not an exact reproduction.
No PID0 workaround, production/workflow/package edit, network, VPS action, commit or push was performed.
Keep the explicitly tagged diagnostic evidence until actual CI identifies the stalled phase; remove
temporary instrumentation when the independently justified repair is verified.

## Root common gate — 2026-09-05 11:23 Omsk

Fresh independent Standards/Spec reviews:0/0findings. Integrated pinned WindowsNode22.23.2/Bash,
concurrency2:3241tests,3140passed,101platform skips,0failed,0cancelled;3758432.7868ms. Lint and
syntax/handler checks passed; frozen source hash unchanged. These totals include the disjoint
ticket13 regressions. An earlier sandbox run was interrupted after a verified Windows taskkill
permission refusal; the authorized complete run passed unchanged and is the gate cited here.
Root scoped publication follows. Actual Linux CI evidence remains required; no repair/readiness claim.
