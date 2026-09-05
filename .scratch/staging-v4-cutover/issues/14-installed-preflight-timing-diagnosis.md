#14 — Быстрая диагностика времени установленного helper перед откатом

Status: done
Blocked by: — (CI124 phase evidence now available from ticket12)
Spec: .scratch/staging-v4-cutover/spec.md#installed-preflight-timing--ci124-diagnosis

## Что сделать

Build and execute a small faithful timing/phase feedback loop for the actual installed-helper
preflight path implicated by CI124. Diagnose only; do not implement a guessed repair.

## Границы и файлы

- Read-only production/tests, including staging-helper-bundle.js, staging-release-common.sh,
  staging-rollback.sh, staging-release-lock.integration.test.js and hermetic installer helpers.
- Exclusive writes: tagged .scratch/staging-v4-cutover/debug/ci124-* probes and this ticket.
  Root owns spec/PROGRESS/checkpoint and completeCI observation. No overlap with committed code.
- Read diagnosing-bugs/implement; build an actual-seam loop before hypotheses. Prefer existing
  exported verifiers/fixture generation over copies or a generic profiling framework.
- No production/test/workflow changes, no deadline increase, no guard/identity/PID0 workaround,
  no dependencies/pulls/network/VPS, no commit/push/subagents/full-suite rerun.
- Windows pinnedNode22.23.2 available locally. Cached Linux image39c9d2a20465 hasNode22.23.1/Bash,
  noPython. Docker Desktop's post-exit flock PID0 is a known limitation, not a guard to disable.
- End with exact command/results, tightest measured seam and known limits. If no faithful loop
  is possible, say so with evidence rather than proposing speculative implementation.

## Definition of Done

- [x] Actual relevant preflight/verifier seam is timed by an executed agent-runnable command.
- [x] Reproduction versus partial profiling is distinguished; observed phase/cost is recorded.
- [x] One-variable probes distinguish supported explanations, or limitations are explicit.
- [x] No source, timeout, assertion, identity protection or server state changed.

## Exact incoming evidence

CI124 run33947239067/job101255453814 exact7dd3677. Test2736 failed452274.233808ms:
Timed out waiting for /tmp/easyboost-real-flock-5zthoS/barriers/tree.
elapsedMs120007,lastPhase=config-json-complete,upCount=missing,tree=absent,stdout/stderr empty.
Milestones:deploy-build-barrier107453ms;deploy-exit329976ms(status0);rollback-start0.
The first deploy succeeds slowly; rollback has no activation counter within120s. A repeated
config phase could overwrite an earlier build phase: do not infer build absence from one label.
Old100ms cases1494/1495 passed22.835336/6.90335ms. Newdiag2733–2735 passed. Final CI not yet read.

Root subsequently confirmed finalCI124 from its complete raw log:3213 tests,3151 pass,
1 failure (2736 only),61 skip,0 cancelled; duration2561238.213625ms. PostgreSQL51/51 pass.

## Answer — 2026-09-05 initial diagnostic pass at 7dd3677

No CI124 bottleneck or production repair is established. The first Linux image39c9d2a20465 supports
fast **leaf-verifier profiling**, but cannot execute the real bounded preflight, even before
the already known post-exit flock PID0 limitation. The production POSIX no-replace publication
invokes `/usr/bin/python3`; the exact exported operation returns `ENOENT` in this image.
This is a local environment limitation, not an explanation of GitHub's rollback timeout.
The resumed measurements below use a second existing cached image with Python and reach
the real bounded and inherited Node-chain paths; the Python limitation is no longer a
blocker for these component measurements.

### Executed feedback commands

The initial probe is `.scratch/staging-v4-cutover/debug/ci124-preflight-timing.mjs`, tagged
`[DEBUG-ci124-preflight]` / `[DEBUG-ci124-publication]`. It extracts the existing
`prepareHermeticHelperInstaller`, `lockFixtureDockerScript` and `approvedComposeModel`
fixture functions; it does not copy a production module into a new implementation. The
fixture's exported bundle-install CLI publishes an actual immutable generation and private
Node runtime. The shell installer capability scan is not included in this component profile.

Executed from the server repository (PowerShell):

```powershell
& 'C:\Program Files\Docker\Docker\resources\bin\docker.exe' --context desktop-linux run --rm --name easyboost-ci124-preflight-probe --network none --user 1000:1000 --mount 'type=bind,source=C:\Users\Ригер\Desktop\Repetotor\Приложение репетитор\server,target=/workspace,readonly' --workdir /workspace --entrypoint node 39c9d2a20465 .scratch/staging-v4-cutover/debug/ci124-preflight-timing.mjs
```

Final complete leaf-profile run: exit0, process wall time2.148s, Node22.23.1,
124835376-byte executable. All assertions use real verifier results; the harness retains
the120000ms outer timing bound. Three samples on the same installed fixture:

| Actual seam | Sample1 ms | Sample2 ms | Sample3 ms |
| --- | ---: | ---: | ---: |
| Private Node startup |19.01|17.95|18.24|
| Bundle `digest` CLI |35.04|32.65|32.84|
| Installed `verify-generation` CLI |34.30|35.16|40.48|
| Archive `protocol` CLI |26.76|28.54|28.40|
| Compose `--protocol` CLI |24.50|23.93|24.98|
| Runtime `capture-runtime` CLI |35.43|36.01|35.22|
| Compose verifier on actual generated Docker JSON |31.89|27.27|26.28|
| Common shell `verify_protected_runtime` |136.81|116.45|116.69|

Fixture generation install was645.81ms. Actual generated Docker `config --format json`
was2.08ms; its existing phase file was asserted to contain `config-json-complete`.
That output then passed the unchanged Compose verifier with the existing fixture's canonical
synthetic PostgreSQL image authority.

One controlled cost comparison changed only invocation count at the exported in-process
`verifyInstalledHelperGeneration` seam:1 invocation4.83ms;10 invocations26.20ms.
This measures repeated verifier cost on this local fixture. It is not proof about the
number or cost of subprocesses, descriptor hashes or filesystem operations in the CI runner.

The bounded variant was also executed:

```powershell
& 'C:\Program Files\Docker\Docker\resources\bin\docker.exe' --context desktop-linux run --rm --name easyboost-ci124-preflight-probe --network none --user 1000:1000 --mount 'type=bind,source=C:\Users\Ригер\Desktop\Repetotor\Приложение репетитор\server,target=/workspace,readonly' --workdir /workspace --entrypoint node 39c9d2a20465 .scratch/staging-v4-cutover/debug/ci124-preflight-timing.mjs --bounded
```

Final result: exit1 in1.119s; generation install648.32ms; real exported
`runSupervisedCommand` failed before spawning its target in45.58ms. Previous unchanged
bounded attempts also failed before spawn in43.37/50.86ms. The initial attempt through
the installed common shell `verify_helper_bundle` failed with the same top-level error
in61.51ms. Final bounded evidence includes:

```text
bounded staging command could not start: spawn error
POSIX_SESSION_RECOVERY_REQUIRED: <exact private fixture control directory>
POSIX session durable publication failed: POSIX session entry no-replace handoff did not commit exact identity
[DEBUG-ci124-publication] {"command":"/usr/bin/python3","status":null,"error":"ENOENT"}
```

The last line observes the actual exported `movePosixEntryNoReplace` call using its existing
`runMove` seam: the wrapper invokes real `spawnSync`, logs only the command/status/error code,
and returns the original result unchanged. No rename, identity or failure check is replaced.
Source routing: `posix-session-supervisor.js:35`, `:2392`, `:2406`; `writeDurablePosixSessionRecord`
uses that publication path at`:774`.

### Limits and next decision boundary

- This is **not** a red reproduction of the120007ms rollback tree-barrier symptom. The
  bounded loop is reproducibly red on a different, measured local environment failure.
  The fast leaf command could detect a stalled leaf, but cannot assert the whole installed
  rollback symptom. Diagnosing-bugs Phase1 is therefore not complete for the CI124 bug;
  no causal hypotheses were ranked and no production repair was selected.
- Leaf timings exclude installed-launcher descriptor binding, inherited Node-chain validation,
  command/transaction supervision, maintenance and host locks, build, activation, recovery,
  and the GitHub runner's concurrent load/filesystem. The largest measured leaf is the shell
  permission walk; that does not make it the cause of the CI stall.
- `config-json-complete` is observed locally only for this component. It still cannot establish
  whether a prior build already occurred in CI, because configuration validation repeats.
- Fixture setup initially exposed missing synthetic lock inventory and missing synthetic
  PostgreSQL image metadata; those inputs were completed to the existing real fixture contract.
  Neither setup failure was treated as the user bug.
- Reproducing the full path requires an environment with the existing Python publication
  capability and genuine post-exit flock owner visibility. No dependency was installed and
  the known PID0 restriction was neither retried nor bypassed.
- Minimum next measurement prerequisites: a real executable `/usr/bin/python3` with stdlib
  `ctypes` and libc `renameat2(RENAME_NOREPLACE)` on the private temporary filesystem; Linux
  `/proc` identity visibility including positive post-exit flock owner attribution across the
  actual launcher and supervisor; Bash, the existing GNU utilities and the pinned executable
  with unchanged descriptor authority. Existing fixtures already provide Docker/Compose/curl;
  a Docker daemon or live database inside that measurement is unnecessary.
- Source-grounded **unmeasured boundaries**, not ranked hypotheses: common `run_bounded`
  starts the real command supervisor, whose `createPosixSessionInvocation` captures inherited
  Node authority. `capturedStagingNodeExecutable` hashes the executable, and the child wrapper's
  `validateInheritedStagingNodeAuthority` hashes it again. Durable session records use
  `writeDurablePosixSessionRecord` and a real Python no-replace subprocess. None of these costs
  is included in the green leaf measurements. These are concrete places to measure once the
  required environment is available; their presence alone does not establish a bottleneck.
- All generated generations/runtime records were under one validated private temporary
  `easyboost-ci124-preflight-*` fixture and removed on exit. Docker used `--rm`, no network,
  non-root uid1000 and a read-only repository mount. Only this ticket and the tagged debug
  probe were edited; no source/test/workflow, deadline, assertion, process identity, live server,
  dependency, commit or push was changed. Root retains ownership of finalCI evidence and any
  later fresh repair specification/ticket.

## Resumed measurements — real descriptor and inherited Node chain

Root located already cached image44f22c911346 with `/usr/bin/python3`, Bash and flock.
It mounted an unchanged cached Node22.23.1 executable from39c9d2a20465:124835376 bytes,
SHA256`93956de2e59480474a7b46571da1651180b1a050cdf32641ebec4ce6e478e068`.
No runtime or dependency was downloaded or installed. Root first executed the existing
`--bounded` variant successfully in6.3s: simple bounded command185ms, common helper
verification688–724ms, common Compose validation519–534ms. Those initial resumed measurements
still used the documented direct-developer Node path.

The added `debug/ci124-node-chain-timing.mjs` uses the existing real-fd9 bootstrap from
`test/release-command-supervisor.test.js` (test `real fd9 and sanitized-chain invocations stay
on one descriptor-backed Node inode`). The descriptor points at the actual installed private
Node file; its actual hash and live owner PID populate the existing raw authority contract.
Production `createPosixSessionControl`, `createPosixSessionInvocation`,
`runSupervisedCommand`, the spawned production wrapper, inherited-authority validation and
normal settlement all execute. The only invocation seam wrapper records elapsed time and
asserts the returned real authority source/digest before returning the original invocation.
It supplies the real control object, not a fake control or ownership record.

Executed twice without changes, from the server repository:

```powershell
& 'C:\Program Files\Docker\Docker\resources\bin\docker.exe' --context desktop-linux run --rm --pull=never --network none --read-only --user '1000:1000' --tmpfs /tmp:rw,exec,mode=1777,size=512m --mount 'type=bind,source=C:\Users\4FE4~1\AppData\Local\Temp\easyboost-ci124-linux-runtime-08f4c66031ef4de6ab02c402b93fd3d6,target=/runtime,readonly' --mount 'type=bind,source=C:\Users\Ригер\Desktop\Repetotor\Приложение репетитор\server,target=/workspace,readonly' --workdir /workspace --entrypoint /usr/bin/bash 44f22c911346 --noprofile --norc -c 'cp /runtime/node /tmp/node; chmod 0755 /tmp/node; /tmp/node .scratch/staging-v4-cutover/debug/ci124-preflight-timing.mjs --chain'
```

Both runs passed every authority, return-status and completion assertion, all stderr empty.
Whole process wall times7.785/7.624s. Actual top-level command durations:

| Fixed operation and one-variable variation | Run1 ms | Run2 ms |
| --- | ---: | ---: |
| One supervised `true`, depth0 |413.52|387.75|
| Four sequential supervised `true`, depth0 |1404.22|1299.51|
| One `true`, depth1 (one additional supervised Node child) |648.44|643.89|
| One `true`, depth2 (two additional supervised Node children) |924.99|924.98|
| Common `verify_helper_bundle` under real inherited chain |1569.90|1574.17|
| Common `validate_staging_compose_contract` under real inherited chain |1271.69|1284.63|

The top-level operation totals include the descriptor-owner process and its outer supervised
target. Depth variation adds actual nested Node processes, not artificial sleeps. Count
variation repeats the same real command without changing authority or deadlines.

Measured internal boundaries across the two runs:

- Raw-descriptor `createPosixSessionInvocation`:129.73–144.29ms; returned source asserted
  `descriptor`. Fully supervised `true` including invocation and settlement, excluding
  separately measured control creation:296.49–343.24ms.
- Inherited-chain `createPosixSessionInvocation`:67.20–68.51ms; returned source asserted
  `chain`, same Node digest, raw fd9 contract absent in the target. Innermost supervised
  `true` including invocation and settlement:239.08–244.01ms.
- Actual control creation was8.39–14.35ms after initial36.18/36.39ms samples. No fsync,
  no-replace publication, process identity, control inventory or cleanup operation was stubbed.
- Under the inherited-chain common-shell path, the top outer supervised helper operation
  was1513.27/1514.29ms and Compose1208.90/1226.66ms, excluding initial control creation and
  owner startup. These execute real nested `run_bounded` calls and their chain validation.

Supported result: this local fixture has measurable per-supervisor/authority overhead even
when the target is `true`, with additional cost for repeated or nested calls. It is now a
usable fast **component** loop on the actual inherited-authority path. It does not reproduce
CI124's107453ms build milestone,329976ms successful deploy or120007ms rollback timeout.
No assertion that these measured local costs are the CI bottleneck is warranted.

Source explains what the measured invocation phase includes: descriptor capture hashes the
open executable and `capturedStagingNodeExecutable` hashes it again (`:553`,`:577`);
the chain branch uses `capturedStagingNodeExecutable` after proving the live ancestor;
the spawned wrapper revalidates/hashes inherited authority at`:634`. The observed roughly2:1
invocation time matches the different source paths, but this probe measures the complete
capture/validation call, not hashing in isolation. This is a source-grounded measurement
target for any later whole-path profile, not a selected repair.

Remaining exclusions are explicit in the probe output: installed launcher current-pointer
checks and maintenance lock binding; transaction deadline lifecycle; release/host locks;
rollback/deploy/build/activation/recovery; GitHub runner concurrency and disk behavior.
The Docker kernel's post-exit flock PID0 limitation still prevents treating this as a full
launcher/scenario reproduction. The whole real-flock scenario was not rerun or bypassed.

The `--bounded`/`--chain` output now reports their actual scopes instead of incorrectly
excluding bounded supervision for both. Writes remain confined to this ticket and the two
tagged probes. No production/test/workflow, timeout, guard, dependency, server state or commit
changed. Root owns any further environment decision, exactCI diagnosis or fresh repair ticket.
