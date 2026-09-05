# 16 — Compare the real bounded-command component on native Linux

Status: done
Blocked by: 14, 15 — complete; diagnostic1 native result captured
Spec: .scratch/staging-v4-cutover/spec.md#native-bounded-command-timing-baseline--diagnostic1

## What to build

An early fixed, finite native component timing step using the already executed local real-fd9 and
inherited-chain approach. It should distinguish environment-dependent component cost from the
whole isolated rollback timeout without selecting a speculative production fix.

## Evidence

Diagnostic1 run33951238186/job101266338908 at89a70a1: exact unchanged scenario fails427420.723302ms,
deploy build99461ms, successful deploy304610ms, rollback tree absent120021ms; empty stdout/stderr,
last fakeDocker phaseconfig-json-complete. Selftests12/12pass. Category residency not CPU or exact
invocation count. Full CI125 still running. Local ticket14 --chain passes in7.5–8.6s for the whole
matrix; ordinary layer versus tmpfs has modest differences, not the native symptom.

## Scope / ownership

- Reuse local debug/ci124-preflight-timing.mjs and debug/ci124-node-chain-timing.mjs as prior art.
  Read both completely. Keep the published implementation small and diagnostic-only; synthetic
  fixture/import closure uses builtins/local modules and the real immutable generation/Node chain.
- Own only new bounded-command timing files under diagnostics/, its README section, this ticket,
  and one early step in .github/workflows/staging-lock-diagnostic.yml. Do not edit existing sampler
  or its tests. Do not copy entire production modules or introduce a generic profiler framework.
- Root owns spec, PROGRESS, checkpoint, commits, pushes and native runs. Do not edit those files
  or publish anything yourself. No production/script/test/package/canonical CI/deploy changes.
- No server/network work, installs/pulls, lock/PID0 bypass, authority fabrication, deadline changes,
  full real-flock rerun on Docker Desktop, broad deletion or raw arguments/environment output.

## Definition of Done

- [x] Fixed Linux-only invocation and small declared matrix use real exported production boundaries.
- [x] Finite behavior, original failure preserved, synthetic fixture scoped/cleaned and output bounded.
- [x] Exact cached Linux command executed successfully; limitations recorded, no native pass claimed.
- [x] Focused checks of diagnostic contract and syntax/lint pass; meaningful regression evidence.
- [x] Existing separate diagnostic runs baseline before original unchanged full scenario.
- [x] Root independent reviews/common checks complete; scoped commit records this implementation, native evidence remains pending.

## Available local environment

Existing cached image44f22c911346 has Bash/Python3/flock. Existing Node22.23.1 binary is at
C:/Users/4FE4~1/AppData/Local/Temp/easyboost-ci124-linux-runtime-08f4c66031ef4de6ab02c402b93fd3d6/node
(124835376bytes). Use the exact nonnetwork read-only bind/tmpfs command recorded in ticket14;
Docker calls need escalation for the local engine pipe. Do not install or rediscover environments.
Pinned Windows22.23.2 executable is C:/Users/4FE4~1/AppData/Local/Temp/node-v22.23.2-win-x64/node.exe.
Root's completed full local gate3241tests/3140pass/101skip0fail remains evidence for byte-identical
existing product/test inputs, not for unfinished diagnostic files or native deployment clearance.

## Answer — local implementation and source freeze, 2026-09-05

Implementation is ready for root's independent review/common checks and scoped commit; status stays
in-progress until those obligations are complete. No native result or production repair is claimed.

Changed files only:

- `.scratch/staging-v4-cutover/diagnostics/native-bounded-timing.mjs` — fixed six-operation command,
  existing fixture extraction/immutable install, finite captured execution, bounded output and cleanup.
- `.scratch/staging-v4-cutover/diagnostics/bounded-timing-chain.mjs` — real fd9 owner/inherited-chain
  worker; real exported control/invocation/supervision and ordinary settlement.
- `.scratch/staging-v4-cutover/diagnostics/native-bounded-timing.test.mjs` — five focused contracts.
- `.scratch/staging-v4-cutover/diagnostics/README.md` — invocation, timing meaning, bounds and limits.
- `.github/workflows/staging-lock-diagnostic.yml` — one ordinary early step, focused tests then baseline.
- This ticket — status and local evidence. Root's spec/PROGRESS/checkpoint were not edited by worker.

### Focused RED/GREEN and local checks

`implement` and `tdd` were applied at the specified command/result/owned-cleanup seams.
`diagnosing-bugs` is used for measurement discipline: existing native diagnostic1 reproduces the
exact timeout, whereas this component matrix does not; no causal repair hypotheses were selected.
Root explicitly retains independent code review, full/common gate ownership and commits.

1. Windows pinned Node22.23.2 argument-rejection test initially failed1!=64 because the command
   did not exist, then passed after fixed invocation handling.
2. The exact cached Linux invocation below initially failed the real matrix with
   `baseline-unavailable,status:1` (1!=0). After implementing the actual production path, both
   tests passed; matrix7163.061882ms. This is feature-contract RED, not reproduction of CI's bug.
3. Real finite child failure23 and cleanup identity/link contract tests were introduced at their
   diagnostic boundaries; the initial imports failed before those boundaries were exported.
   Final Linux focused run:4tests/4pass/0fail/0skip, matrix7110.446937ms, full test7276.273284ms.
   The cleanup test rejects a mismatched inode and proves an outside symlink target's contents
   and0500 permissions remain unchanged. The real failure test proves23 survives private stderr.
4. Explicit `node --check` on all three new mjs files passed. Explicit ESLint with the repository's
   existing Node JavaScript rules applied to these mjs files:3files/0errors/0warnings.
   `git diff --check` passed. Default mjs lint coverage was not assumed.

Exact command executed from the server repository (PowerShell):

```powershell
& 'C:\Program Files\Docker\Docker\resources\bin\docker.exe' --context desktop-linux run --rm --pull=never --network none --read-only --user '1000:1000' --tmpfs /tmp:rw,exec,mode=1777,size=512m --mount 'type=bind,source=C:\Users\4FE4~1\AppData\Local\Temp\easyboost-ci124-linux-runtime-08f4c66031ef4de6ab02c402b93fd3d6,target=/runtime,readonly' --mount 'type=bind,source=C:\Users\Ригер\Desktop\Repetotor\Приложение репетитор\server,target=/workspace,readonly' --workdir /workspace --entrypoint /usr/bin/bash 44f22c911346 --noprofile --norc -c 'cp /runtime/node /tmp/node; chmod 0755 /tmp/node; /tmp/node .scratch/staging-v4-cutover/diagnostics/native-bounded-timing.mjs'
```

For the RED/GREEN contract runs, the final Node invocation was instead
`/tmp/node --test .scratch/staging-v4-cutover/diagnostics/native-bounded-timing.test.mjs`;
all Docker flags, image and runtime mounts were identical. These are local Docker engine calls,
not network/server access; no image pull, dependency/runtime install or full-flock rerun occurred.

Final direct command exited0, stderr empty,20 fixed JSON lines, final
`{"event":"component-only","status":0,"fixture_removed":1}`. Actual timings:

| Fixed operation | Elapsed ms |
| --- | ---: |
| Immutable generation install |461.41|
| One supervised true |368.48|
| Four sequential supervised true |1298.82|
| True under one extra supervised Node |671.44|
| True under two extra supervised Nodes |1009.38|
| Common helper bundle validation |1622.80|
| Common Compose validation |1302.56|

All12 real measured supervisor results were0 (9 descriptor,3 chain). Descriptor invocation
130.35–137.14ms; inherited invocation68.28–77.03ms; control creation8.69–17.21ms. Installed
common helper total includes actual inherited nested commands, without instrumenting their internals.
These timings remain comparable component evidence, not CPU-only cost or proof of the native cause.

### Freeze and limitations

Baseline HEAD `89a70a12c9f185240c371640c09f107824cb110a`. Current source SHA256 after review repair:

| File | SHA256 |
| --- | --- |
| native-bounded-timing.mjs |5d6831ac56849ed1c7410be23198cffe5063240be882f8a930a11d22522d1d45|
| bounded-timing-chain.mjs |00c1bcc8fae3b7888524ebf4ac1ec9f853c760fd82ccbe84e86e60b7293ad687|
| native-bounded-timing.test.mjs |a6555aa5ef9773dc7edc679acf0d37dfd8005b03ec497d0971bb6a7c6fd06a6d|
| diagnostics/README.md |80f2777f74091ef6c3288011dddf5793cd72b211a2e752ecd4b421a46943f576|
| staging-lock-diagnostic.yml |04a610531bfabab8165895f8d8951eef0ddc1c1950334954c49d124026d881a9|

Actual cached Linux executable remains Node22.23.1,124835376bytes,
SHA256`93956de2e59480474a7b46571da1651180b1a050cdf32641ebec4ce6e478e068`.
Native workflow still pins22.23.2; that patch-version/environment difference must accompany comparison.
Tracked product/scripts/tests/packages, canonical CI and existing observer files have no diff from
HEAD. Key unchanged on-disk source SHA256 values:

- staging-command-supervisor.js: `f2c667f41623e99fad6559a7322090a5d961e46d8a473b7e4c7f659b226bfbd7`
- posix-session-supervisor.js: `f486eeed31ca1ea1f167a1b6b446a2ebad79e78f95fe28ad2405dc0810c17237`
- staging-helper-bundle.js: `77ce7a19d40b5fee568764cda71215608bfd9bf724d2be85673068ac5961f6d8`
- staging-release-common.sh: `f667daac6d5bc94090f9f027160e2abc04209a26ad747ef4445288b9f8de6b3b`
- staging-release-lock.integration.test.js: `43dd8ee425838d038d317930ba18d61add82bbe94b382aa9ef6c35454bfbfb93`

The whole matrix has a120000ms enclosing subprocess budget and unchanged60000ms component
supervision limits. Child failures stay failures; numeric status is preserved, signals map128+signal,
outer timeout124. Failed or uncertain settlement retains the exact private fixture; only successful
normal production settlement allows scoped cleanup. No destructive PID/group fallback is introduced.
Output is bounded to at most21lines of512bytes, without raw arguments/environment/authority.

The ordinary early workflow step deliberately fails the job on failed baseline contracts/measurement;
later observer/original-scenario steps then skip. There is no continue-on-error or green failure mask.
Original full scenario and sampler are byte-identical. Excluded: launcher/current-pointer and lock
binding, transaction lifecycle, deploy/rollback/build/activation/recovery, native runner disk/load,
and the known Docker post-exit-flock PID0 behavior. No deployment or native full-scenario pass follows
from this local result. Root still owns originalCI125 observation, reviews/common checks, commit/push
and subsequent native timing evidence.

## Same-scope review repair — early supervisor refusal preserves143

Root review reported Standards0findings and Spec1P2: the worker formatted `invocationMs` before
returning a nonzero result. The unchanged production supervisor can return143 on parent identity
mismatch before calling `posixSessionInvocation`, leaving that optional timing undefined. Formatting
then threw and the worker catch replaced143 with1.

The worker now uses a small `completeComponent` result seam which returns any nonzero supervisor
status before formatting measurements. The measured caller uses that same function. Exporting this
seam required an ordinary direct-entry guard so importing it in focused tests does not run a worker.
The production supervisor/module and all authority, invocation and settlement paths remain unchanged.

Actual RED was executed before adding the nonzero-status guard, retaining the original formatter
behavior in the shared seam. The test calls real `runSupervisedCommand` with the real current PID,
the actual `/proc` starttime plus1 (a mismatched positive identity), and the same real invocation
callback pattern. It asserts supervisor143, callback count0 and undefined invocation timing, then
passes the result through the exact worker result seam and outer diagnostic result check. No whole
module mock, fabricated authority, child launch or production edit is involved in this refusal case.

The exact cached Docker command above was used for RED with final Node invocation:

```sh
/tmp/node --test --test-name-pattern="early parent-identity refusal" .scratch/staging-v4-cutover/diagnostics/native-bounded-timing.test.mjs
```

RED:1test/0pass/1fail,1.391154ms; `TypeError: Cannot read properties of undefined (reading 'toFixed')`
at the worker result seam. This is the review defect itself, not a missing-export test failure.
After the guard, the same case passes in0.939957ms while retaining143 through both diagnostic layers.

Final cached Linux focused run:5tests/5pass/0fail/0skip,7412.454896ms total; unchanged real matrix
7238.760227ms. Pinned Windows22.23.2 run:5tests/2pass/3explicit Linux skips/0fail,182.4016ms.
All three explicit syntax checks passed; repository Node-rule ESLint on the three mjs files:
3files/0errors/0warnings. `git diff --check` passed. The tracked production/test/package/canonical
workflow and existing observer paths still show no diff from HEAD.

The exact direct cached command above was rerun after the repair: exit0 in7.881496s Docker command
wall time, stderr empty,20fixed lines,12successful real supervisor results and fixture_removed1.
Operation totals: install460.74ms; true403.61ms; repeat1301.62ms; depth1 672.48ms;
depth2 963.68ms; helper1618.84ms; Compose1326.32ms. Descriptor invocation130.39–136.32ms,
inherited invocation68.48–69.54ms. These replace no original timeout evidence and imply no native pass.

This repair changes only the chain worker, its existing focused test, README and this ticket within
the original six-file ownership. The main baseline and workflow hashes stay unchanged. The current
freeze table above supersedes the first chain/test/README hashes. No commit, push, native run, full
suite rerun or originalCI125 interruption was performed; root retains re-review/publication authority.
