# 20 — Attribute successful bounded-command overhead

Status: done
Blocked by: 19 — exact reduced timeout and late clean helper observed
Spec: .scratch/staging-v4-cutover/spec.md#attribute-successful-bounded-command-overhead-before-changing-production

## Deliverable

Measured attribution of the existing real bounded-command overhead, with a falsifiable conclusion
and a concrete next repair proposal. This ticket diagnoses; it does not change production behavior.

## Scope

- Read the final spec section/ranked predictions. Reuse installed real helper/component fixtures,
  finite children, existing lifecycle seams and read-only profiling where possible.
- Source paths: scripts/staging-command-supervisor.js, scripts/posix-session-supervisor.js,
  scripts/staging-release-common.sh; existing diagnostics/native-bounded-timing.mjs and
  diagnostics/bounded-timing-chain.mjs under .scratch/staging-v4-cutover/.
- Own only this ticket and, if necessary, new narrowly scoped local debug/ci129-supervisor-cost.mjs
  and debug/ci129-supervisor-cost.test.mjs under the same feature. No changes to existing diagnostic
  commands, workflow, product, scripts or existing tests. Root owns shared spec/PROGRESS/checkpoint.
- Diagnostic code must use real child/seam, bounded lifetime/output, private synthetic state and
  preserve failure/uncertain descendants. No raw args/env/authority/stream dumps or generic CLI.
  Test a new observer seam before using its output; do not invent callback evidence.
- Existing cached Linux only, no pulls/downloads; no actual Docker Desktop rollback repeat.
  No full-suite repeat, live/VPS action, commit or push. If a proposed production optimization
  changes a safety invariant, flag that explicitly instead of implementing or disabling it.

## Definition of Done

- [x] Reproducible measured separation of meaningful startup/invocation/settlement costs.
- [x] Ranked predictions evaluated with evidence and limits, not sampled-residency-as-CPU claims.
- [x] Concrete minimal next repair proposal or clearly identified missing evidence.
- [x] Any new observer contracts/lint pass; production and existing test inputs untouched.
- [x] Root review and safe checkpoint recorded.

Baseline: native reduced run33957694010/job101283898728 at e3bac62: original signature120024ms,
late tree144073ms, helper clean234109ms, diagnostic1. Native prior empty supervised true repeated
calls each443–447ms (invocation174–175ms, control14–15ms; measurements overlap, not additive).
One empty true total546.54ms on that earlier run. Existing paired matrix and provenance live in
ticket16; no hardware-normalized or causal conclusion follows from those timing differences.

## Answer — local component attribution, 2026-09-05

The inherited-chain case, which corresponds to recurring `run_bounded` calls in rollback, spends
74.31–76.50ms wall /77.60–78.34ms controller process CPU in invocation construction alone on this
cached Linux environment. A real finite `true` plus its real control and settlement costs
284.84–300.53ms. Repeated supervision is therefore a material candidate for the slow transaction;
the full transaction's exact invocation count and savings from a composed operation are not measured
here, so these observations do not establish that any proposed change clears the120second barrier.

Descriptor-owner capture is more expensive:145.31–156.74ms invocation wall, with two full executable
hash stacks versus one on the chain. That duplicate is an admission optimization opportunity,
not evidence of a repeated duplicate hash at each internal rollback command.

### Runtime and reproduction

Baseline HEAD `e3bac627308d077b32833e06cf8f6d9e4bf077a4`. Cached Docker Desktop Linux image
`44f22c911346`; no pull, network, packages, full rollback or actual flock attempt. Linux Node22.23.1,
124835376bytes, SHA256
`93956de2e59480474a7b46571da1651180b1a050cdf32641ebec4ce6e478e068`.
The small Node22.23.1 versus native22.23.2 and environment differences prohibit treating the local
timings as hardware-normalized native predictions.

Exact PowerShell evidence command from the server root:

```powershell
& 'C:\Program Files\Docker\Docker\resources\bin\docker.exe' --context desktop-linux run --rm --pull=never --network none --read-only --user 1000:1000 --tmpfs /tmp:rw,exec,mode=1777,size=512m --mount 'type=bind,source=C:\Users\4FE4~1\AppData\Local\Temp\easyboost-ci124-linux-runtime-08f4c66031ef4de6ab02c402b93fd3d6,target=/runtime,readonly' --mount 'type=bind,source=C:\Users\Ригер\Desktop\Repetotor\Приложение репетитор\server,target=/workspace,readonly' --workdir /workspace --entrypoint /usr/bin/bash 44f22c911346 --noprofile --norc -c 'cp /runtime/node /tmp/node; chmod 0755 /tmp/node; /tmp/node .scratch/staging-v4-cutover/debug/ci129-supervisor-cost.mjs'
```

Focused Linux contracts use exactly the same container command with the last invocation replaced
by `/tmp/node --test .scratch/staging-v4-cutover/debug/ci129-supervisor-cost.test.mjs`.
The measured command accepts no arguments and runs three descriptor and three chain finite `true`
commands. Chain observations run inside one real extra supervised Node; the outer duration contains
the nested observations and is deliberately not reported or added to them. This is the existing
component's installed-helper/fd9 bootstrap and real production export path, restricted to the
needed cases. The fixture reuses its existing synthetic trusted-command-directory substitution.
All writes are in a new private `/tmp` fixture; no tracked helper bytes are edited.

### Measurements

Final evidence command returned0 in4.98seconds. All six component statuses0; final row
`{"event":"component-only","status":0,"fixture_removed":1}`.

| Source / iteration | Total wall | Controller CPU | Control wall / CPU | Invocation wall / CPU | Disposal wall / CPU |
| --- | ---: | ---: | ---: | ---: | ---: |
| descriptor1 | 380.96 | 186.80 | 15.01 /8.21 | 149.97 /153.14 | 35.58 /11.97 |
| descriptor2 | 380.29 | 181.86 | 12.24 /2.46 | 156.74 /161.02 | 26.30 /6.24 |
| descriptor3 | 356.04 | 171.58 | 12.49 /2.22 | 145.31 /150.31 | 25.42 /9.08 |
| chain1 | 295.34 | 108.13 | 14.92 /7.99 | 76.50 /78.34 | 26.68 /8.82 |
| chain2 | 284.84 | 95.44 | 11.80 /2.38 | 76.04 /77.60 | 24.78 /6.04 |
| chain3 | 300.53 | 102.48 | 11.00 /1.90 | 74.31 /78.19 | 35.23 /12.60 |

All durations are milliseconds. `total_ms` includes control creation, unlike the earlier
component's `elapsed_ms`; invocation and disposal are contained within this total. The controller
CPU values are real `process.cpuUsage` deltas, include profiler/runtime threads and exclude the
spawned wrapper, its Python publication processes, and target CPU. Multithreaded CPU can exceed
wall time. The final profiler stop/formatting is outside these timing and CPU intervals.

| Source / iteration | Spawn→READY write | READY→status write | Status→kill-arm write | Kill-arm→wrapper close | Close→finish |
| --- | ---: | ---: | ---: | ---: | ---: |
| descriptor1 | 110.70 | 20 | 20 | 24.96 | 37.16 |
| descriptor2 | 118.98 | 20 | 20 | 23.87 | 26.81 |
| descriptor3 | 114.13 | 10 | 20 | 26.67 | 26.21 |
| chain1 | 110.29 | 20 | 20 | 22.12 | 28.33 |
| chain2 | 113.69 | 10 | 20 | 26.74 | 25.13 |
| chain3 | 115.69 | 20 | 20 | 22.47 | 35.78 |

Spawn and close are actual existing control callback boundaries, forwarded to their real methods.
Record timestamps are file modification times read after actual wrapper close, before real
disposal; they denote record-content writes, not exact READY/child-close/publication-complete
callbacks. Their observed granularity is10ms and their clock differs from the monotonic wall clock.
They include durable publication work and must not be interpreted as precise target runtime or
sleep duration. Close→finish includes disposal; do not add both. No sampled process residency is
used as CPU or as an invocation count.

V8 in-process sampling at1000microseconds located the expensive synchronous work. Counts below
are stack samples, not CPU milliseconds and not observed file-read counts:

| Source / iteration | All samples | Direct descriptor hash stack | Reopened executable hash stack | Hash update stack | Hash read stack |
| --- | ---: | ---: | ---: | ---: | ---: |
| descriptor1 | 350 | 68 | 68 | 106 | 29 |
| descriptor2 | 349 | 71 | 72 | 110 | 33 |
| descriptor3 | 329 | 68 | 66 | 107 | 25 |
| chain1 | 272 | 0 | 68 | 58 | 10 |
| chain2 | 262 | 0 | 69 | 53 | 16 |
| chain3 | 276 | 0 | 68 | 56 | 12 |

The last two columns are subsets of the hash stack observations, not additional independent work.
This does not profile the spawned wrapper or establish its CPU split. No raw profiler trees,
paths, identities, arguments, environment, authority records, child streams or errors are emitted.

### Evaluation of the ranked predictions

1. Repeated supervision: supported for actual finite descriptor and chain components. Each of
   three repeated chain commands still costs285–301ms with almost no useful target work. There
   is no observed warm-repeat elimination. Nested timings from ticket16 remain overlapping.
2. Runtime/file verification: strongly supported for controller invocation CPU. In
   `posix-session-supervisor.js:465`, `hashOpenRegularFile` reads the private executable in1MiB
   chunks and feeds SHA256; descriptor capture at600 then calls `capturedStagingNodeExecutable`
   at606, which reopens and hashes again at557. Chain capture at625 takes only the latter route.
   Profiles observe both descriptor stacks and only the reopened stack on chain; invocation
   CPU approximately halves on chain. Source establishes a125MB scan per hash, but neither exact
   dynamic byte/read counts nor wrapper CPU are claimed measured. Wrapper validation at678
   performs another full hash before READY for both sources; that is source evidence, not a
   measured wrapper CPU attribution.
3. Fixed settlement waits: present but not supported as the principal invocation cost. Wrapper
   success checks `targetClosed` in its20ms interval (`posix-session-supervisor.js:4930–4961`).
   Recorded status→kill-arm writes differ by20ms in these runs, but the interval includes durable
   publication, so it is not a20ms pure-sleep measurement. On actual wrapper close the controller
   calls `maybeSettle` immediately (`staging-command-supervisor.js:572–597`); the25ms group timer
   is a termination-path watcher, not a mandatory successful-command delay. Close→finish25–37ms
   is mostly measured real disposal25–36ms; reducing a poll constant cannot remove invocation
   CPU or durable retirement work. No wait, proof or fsync was removed.

Actual rollback relevance: the wrapper deletes raw descriptor metadata and supplies the live
sanitized chain to its target (`posix-session-supervisor.js:4788–4905`). The common shell saves
that chain and injects it for each `node` call (`staging-release-common.sh:8–42`); `run_bounded`
launches `staging-command-supervisor` using this function and explicitly closes fd9 at249.
Consequently the descriptor's duplicate caller hash is not the recurring bulk rollback pattern.

### Concrete minimal next repair proposal — not implemented

Start with the two adjacent read-only `capture-file` calls in `verify_release_pair`,
`scripts/staging-release-common.sh:830–833`, as one purpose-specific operation in
`scripts/staging-runtime-authority.js`, e.g. `capture-release-pair`. This is not a generic list of
commands or a new long-lived supervisor. It would:

- Call the existing `capturePrivateFile` for the archive first (mode384, maximum536870912),
  then the sidecar (mode384, maximum65), preserving roles and existing owner/link/identity/size/
  byte validation. Emit exactly two bounded canonical JSON records only after both captures
  succeed. The shell can split the two records with `read`, without evaluation or new Node calls.
- Keep the symlink/existence checks before capture; keep canonical sidecar `read-sha`, expected
  SHA comparisons, archive inspection, and both later `verify-file` calls exactly where they
  are. In particular, do not reuse captured records beyond their present operation or remove
  the final drift checks.
- Preserve the current capture failure result: each original capture already uses `|| return1`,
  so failure of the single replacement remains1. Keep the remaining calls' failure/status
  behavior unchanged. One existing60second outer bound would cover both reads, which is a
  stricter budget than two separate60second bounds; this difference must be explicit in the
  next spec and tested rather than hidden or compensated by raising a deadline.

This changes two recurring supervised boundaries to one per pair. `validate_release_store`
calls `verify_release_pair` for each retained archive at892, and rollback then explicitly checks
active and target pairs at203–204 before the tree barrier. The function currently has seven
sequential supervised commands in total; this minimal proposal changes that to six. It does not
remove six boundaries: a broader seven-to-one verifier would require a separate scope and review.

The straight successful rollback source path before tree copying invokes the pair verifier
`n + 4` times: `n` retained pairs in the initial `validate_release_store`, active and target at
rollback203–204, and one active pair inside each `verify_active_snapshot` at228 and271 (common1185).
The reduced fixture explicitly installs exactly two pairs (`ci126-rollback-only.mjs:71–76`, checked
again at124–135), so this source-derived pre-tree count is six pair-verifier calls /42 supervised
subcommands. It is not a sampled native invocation count or the full rollback's total; retries,
recovery and later finalization are outside this count. The minimal capture-pair change avoids
six pre-tree sessions, so it is unlikely by itself to explain the24second native barrier gap.

A larger, still purpose-specific read-only `verify-release-pair` operation could execute all seven
steps in their existing order in one supervised process: both `capturePrivateFile` calls,
`readCanonicalShaFile`, captured SHA comparison, existing `validateReleaseArchive`, then archive
and sidecar `verifyPrivateFile`. Keep every byte/identity/canonical/archive-content check and keep
this verifier at every existing callsite. That saves six boundaries per pair /36 on the same
straight pre-tree fixture path. Both COMMAND_SECONDS and ARCHIVE_INSPECT_SECONDS are60, so one60s
bound would tighten the old aggregate budget of seven separately bounded calls. It also merges
the final raw-status and preceding normalized-status branches, requiring an explicit status model
and focused failure tests; it is not an automatic equivalent replacement. The measured component
cost suggests a larger opportunity than the minimal pair, but neither projected savings nor
120second success is established without a real composed benchmark and native validation.

The measured near-empty chain admission+settlement cost is the reason to test this proposal,
not a promise of285–301ms savings per pair or a claim that one small change closes the native gap.
The remaining missing evidence is a real paired-call benchmark on the current composition and
the proposed fixed operation, plus unchanged native reduced and full rollback validation. Use
finite valid archives plus sidecar/archive drift and malformed/linked/oversized input failures;
assert the existing later drift checks still run and statuses remain fail-closed. Keep the
original120000ms assertion and all command/session/transaction limits.

The adjacent final two `verify-file` calls at845–848 are another possible group, but are not the
first recommendation: the first normalizes failure to1 while the final returns its raw status,
so collapsing them needs explicit timeout-stage status design. Removing the descriptor's
redundant second hash is only a secondary admission optimization; it must retain open-fd/proc-path
identity, owner/mode/link/size checks and the later wrapper hash. No stat-only cache, cross-command
memoization or downstream handoff-check removal is proposed.

### Observer bounds and verification

Owned new files only: `debug/ci129-supervisor-cost.mjs` and `.test.mjs`, plus this ticket. Root
owns spec/PROGRESS/checkpoint. No product, workflow, existing diagnostic or existing test edits;
no commit/push/full suite/VPS action. Root review/checkpoint remains pending.

- Public observer seams are `runCostFixture` (only finite0/23 status,1/3 iterations and the two
  fixed authority-source cases), `finishCostObservation` (real child status has priority over
  optional profiler-stop failure), and `reportCostRows` (known nonzero result survives a throwing
  output boundary; output failure after success returns1). Existing lifecycle methods/results
  are forwarded unchanged.
- Each fixture has one35000ms enclosing subprocess budget; each observed true/failure command
  has5000ms real supervision and the chain's outer finite Node15000ms. Default TERM/KILL
  settlement behavior is untouched. The CLI stops on first failure. An uncertain/failed fixture
  is retained; disposable-container lifecycle is the only additional containment. Successful
  cleanup reuses the existing identity-checked bounded `removeFixture`.
- Captured child output16KiB; at most seven1024byte added JSON lines on CLI success; profile
  processing accepts at most8192nodes/60000samples/128stack entries. Runtime deadline bounds
  in-memory profiling. Metadata reads only the three known private record files after close;
  no signals or process enumeration added. Profiling and observer work may affect timings.
- Initial RED: new test command failed with missing module. Linux real fixture then exposed a
  missing existing allowed-prefix setting; restored that synthetic fixture input. After adding
  the inherited case, the deliberately retained failure fixture exhausted the512MiB tmpfs for
  a later test, so the retained-failure contract now runs last. No cleanup bypass or fixture
  deletion was used to make that case pass.
- Initial Linux focused contracts:5passed,0failed,4200.26ms. Covers real descriptor and inherited
  success/settlement, bounded ordered fields and safe output, exact supervised child23 retained,
  arbitrary-command refusal64, and known real finite child23 surviving a throwing profiler-stop
  boundary. Windows Node22.23.2:2passed,3Linux-only skips,0failed. No native rollback is claimed.
- Targeted ESLint with the repository's five error rules and Node globals passed. `git diff
  --check` passed. No full-suite repeat because ticket20 explicitly excludes it.

Frozen SHA256:

| File | SHA256 |
| --- | --- |
| New cost probe, after reporting review fix | `3d183f7f21065ff271128bcf42bda8a7b0873d9dd24cc9f594a48d55f0e08bb0` |
| New cost tests, after reporting review fix | `dc1f68fb0419dd037f59602acdafa83d6eacb5dbfdad2595025d1906001d6ed7` |
| Unchanged staging-command-supervisor.js | `f2c667f41623e99fad6559a7322090a5d961e46d8a473b7e4c7f659b226bfbd7` |
| Unchanged posix-session-supervisor.js | `f486eeed31ca1ea1f167a1b6b446a2ebad79e78f95fe28ad2405dc0810c17237` |
| Unchanged staging-release-common.sh | `f667daac6d5bc94090f9f027160e2abc04209a26ad747ef4445288b9f8de6b3b` |
| Unchanged native-bounded-timing.mjs | `5d6831ac56849ed1c7410be23198cffe5063240be882f8a930a11d22522d1d45` |
| Unchanged bounded-timing-chain.mjs | `00c1bcc8fae3b7888524ebf4ac1ec9f853c760fd82ccbe84e86e60b7293ad687` |

### Root review follow-up — reporting-status P2

The standards review found that the outer CLI wrote result rows before assigning the known
fixture status, so throwing stdout could replace an established failure23 with generic1. The
small `reportCostRows` boundary now forwards the original bounded records and returns the known
nonzero status on output failure; only an otherwise successful result becomes1. Both the fixture
rows and final summary use this boundary; invalid-invocation64 and Linux-required69 use it too.
An output failure stops the fixture loop and cannot be erased by a later successful summary.

Focused RED: the new throwing-output test failed because `reportCostRows` did not yet exist.
GREEN uses real finite Node children exiting23 and0, then a throwing output boundary: results
remain23 and become1 respectively, and only one write is attempted. The final Linux contract
command passed6/6,0failed,3547.79ms; Windows Node22.23.2 passed3 with3Linux-only skips,259.85ms.
The same targeted ESLint and `git diff --check` passed. No new timing experiment or rollback ran.

The timing tables above were collected before this output-only fix with probe SHA256
`f8817e5666ff5edd4fc8f338abf3777d625fd9b93f0c213690a7f3203e8a6ad7` and test SHA256
`85c8a06808d7fee660811c413b77412dfe972bdc1a5cdbf07ea3f2b8d220296d`. Their real owner profiling,
control/invocation/settlement measurement code and data are unchanged. Spec review reported0
findings; root retains final review/checkpoint ownership.

Root final gate:26tests23pass3Linux-only skips0fail0cancel2173.5942ms, including release/PROGRESS
consumers. Common lint/checkPASS571JS165handlers106names; final explicitmjslint2PASS. Scoped
secrets1572tracked+9explicit/1576unique PASS; whitespace PASS. Spec and Standards final reviews
both0remaining findings (initial Standards P2 corrected above). Product/scripts/test/package/
canonicalCI remain byte-identical to7dd3677fef6aea81563e46a26958dd4074a3ffa9; completed full
Windows baseline3241tests3140pass101platformskip0fail remains applicable and was not repeated.
Ticket is complete as diagnosis, not production repair. Root checkpoint records pendingCI128
and CI127's unchanged original failure. No VPS action or release clearance.
