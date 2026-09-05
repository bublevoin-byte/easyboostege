# 21 — Compose retained release-pair verification

Status: done
Blocked by: 20 — bounded-command overhead attribution
Spec: .scratch/staging-v4-cutover/spec.md#verify-each-retained-release-pair-in-one-bounded-operation

## What to build

Verify the retained archive and its checksum sidecar with all existing capture, canonical,
digest, archive-content and final identity/byte checks in one60second supervised operation,
reducing seven repeated process startups without removing checks or relaxing the120s rollback
assertion. This is a bounded measured production optimization, not guaranteed CI clearance.

## Scope and ownership

- Worker owns scripts/staging-runtime-authority.js, scripts/staging-release-common.sh,
  new test/staging-release-pair.test.js, this issue, and if needed one narrowly scoped
  .scratch/staging-v4-cutover/debug/ci130-release-pair-timing.mjs plus its focused .test.mjs.
- Existing exported primitives and archive validator are reused; do not edit archive format/
  limits or supervisor code. No existing test edits/removals. If this scope cannot preserve a
  safety invariant, report exact blocker before expanding files.
- Read the final spec section completely: ordering, single60s aggregate budget, status
  normalization difference and all existing caller mappings are explicit decisions.
- Read applicable AGENTS/domain/tracker and implement/TDD skills. New module/CLI and shell
  caller are the test seam; use real finite files, showRED, never source-only tests as soleproof.
- Use cached Linux44f22c911346, retained Node22.23.1 only if needed; no pull/network/envdump.
  Real authority-chain component may be reused, never actual Docker Desktop rollback.
- No full-suite repeat by worker, existing diagnostic/workflow edit, commit/push, VPS action.
  Root owns spec/PROGRESS/checkpoint, both independent reviews, common/full gates and publication.
- Fixture cleanup must stay exact identity checked. Preserve failed/uncertain descendants; no
  arbitrary processes/signals/commands or broad deletion.

## Definition of Done

- [x] RED→GREEN through actual composed verification with every existing check preserved.
- [x] Drift/link/mode/malformed/digest/size failures fail closed; no authority stdout payload.
- [x] Shell uses one existing60s bounded call; real nonzero status and caller mappings preserved
      as specified (not stage-by-stage raw-code equivalence).
- [x] Finite real before/after cost evidence and memory/lifetime limits recorded honestly.
- [x] Worker focused gates and fixed changed-file hashes recorded; original tests untouched.
- [x] Root independent reviews, fresh full local lint/check/test and scoped scans.
- [x] One ticket commit and authorized branch publication; native original gates reported exactly.

## Baseline / review cautions

Base before repair: e3bac627308d077b32833e06cf8f6d9e4bf077a4 product bytes; ticket20's diagnostic
commit may be newer but does not alter product. Original helper logical bundle7ab70170…
will change with these production bytes; all existing packaged archives remain historical,
CI-gated and not installable as this new candidate.

Caller locations from current source: common verify_release_pair822–848; validate store892,
candidate910, active snapshot1185, preexisting candidate1395, publication1572; rollback
active203/target204, snapshots228/271. All nonzero caller paths must remain fail-closed.
Do not optimize only descriptor duplicate hash: recurring internal calls use inherited chain.
Do not create generic verify-a-list abstractions. Test boundaries, not private call-count details.

## Worker evidence — 2026-09-05, frozen for root review

One worker, one ticket. Read workspace/server AGENTS, tracker/domain conventions, this ticket,
the final spec section, and implement/TDD/codebase-design instructions. No applicable CONTEXT
or staging ADR exists. Test seams were already authorized by the ticket/spec: the actual
module/CLI and shell caller. Root retains reviews, shared docs, full gates, commit and publication;
status remains in-progress until those requirements are met.

Implementation exports `verifyRetainedReleasePair({ archivePath, expectedSha256, role })` and
adds fixed CLI `verify-release-pair ARCHIVE SHA ROLE`. The archive validator is a direct static
import with no back-import/cycle or new subprocess. This keeps the existing validator's actual
await as the test seam for file changes between real validation and final reproof. No callback,
environment flag, authority cache, new dependency or supervisor change was introduced. Static
import startup overhead on unrelated runtime-authority commands was not isolated by this probe.

Capture order and original primitives are retained: archive/private-0600/512MiB, sidecar/private-
0600/65bytes, canonical SHA read, both digest comparisons, full canonical archive validation,
archive final identity/byte verification, sidecar final identity/byte verification. Shell path,
regular-file and symlink prechecks are unchanged. One existing COMMAND_SECONDS=60 call now
covers the complete operation. This is the intentional tighter aggregate deadline and raw-status
change specified above; no stage-by-stage raw-status equivalence is claimed.

### RED and focused GREEN

- First real canonical archive module test failed because the new exported function did not
  exist, then passed after implementing the composed operation.
- Fixed CLI test next failed with the old usage error, then passed with silent status0.
- Linux shell test ran the actual old seven commands and failed its required single bounded
  call contract. Replacing only that body made it green. This was runtime execution of a real
  archive/sidecar, not a source-only proof or successful fake archive validator.
- Tests mutate archive/sidecar bytes and replace each pathname with equal bytes after the real
  validator yields. Each final reproof fails. A fresh subsequent invocation accepts a legitimate
  equal-byte replacement, proving no prior capture record is cached across calls.
- New pair tests also cover malformed archives with matching SHA, expected/declared/actual digest
  mismatch, noncanonical and oversized sidecars, sparse archive above512MiB, absent/nonregular
  paths, hardlinks, symlinks, mode and foreign-owner refusal. Module/CLI verification emits no
  authority payload on stdout. CLI missing/extra argument refusal is covered.
- At the shell seam, real finite children returning1/23/124/125/137 retain their exact operation
  status. All10 unchanged direct call expressions from common, rollback, restart and cutover
  execute with representative nonzero results and retain their established1/65/67 mapping.
  The surrounding deployment actions are outside this finite test; no rollback was attempted.
- Windows pinned Node22.23.2: `--test test/staging-release-pair.test.js
  test/staging-runtime-authority.test.js test/staging-release-archive.test.js
  .scratch/staging-v4-cutover/debug/ci130-release-pair-timing.test.mjs`:
  total58, pass46, fail0, platform skip12. Existing archive/runtime tests are unedited.
- Cached Linux Node22.23.1 pair suite as uid1000: total21, pass19, fail0, owner-only skip2.
  Same network-none/read-only disposable container as uid0, changing ownership only inside its
  private `/tmp` fixtures:21/21 pass, no skips. `bash -n scripts/staging-release-common.sh` passes.
- Focused ESLint for runtime-authority and the new pair tests passes; explicit `--no-ignore`
  ESLint plus Node syntax checks for both debug files pass. Scoped `git diff --check` passes.
  No full-suite run, commit or publication by the worker.

### Finite comparison and limits

Command inside the existing offline container:
`/tmp/node .scratch/staging-v4-cutover/debug/ci130-release-pair-timing.mjs`.
Docker context desktop-linux, cached image44f22c911346, `--rm --pull=never --network none
--read-only --user 1000:1000`, repository `/workspace` and retained runtime `/runtime` mounted
read-only, `/tmp:rw,exec,mode=1777,size=512m`. Only the retained Node is copied to `/tmp/node`.
Runtime22.23.1,124835376bytes, SHA256
`93956de2e59480474a7b46571da1651180b1a050cdf32641ebec4ce6e478e068`.

The probe reuses the installed hermetic helper fixture and the real inherited Node chain.
Before-source restoration occurs only in the private fixture before installation, and both
entire restored files must hash to the exact6261403 baseline Git bytes (LF-normalized):
runtime `224f98ca86d9710c79bd3b29b752e7117906d00b358ab39bed643db16f708319`,
common `f667daac6d5bc94090f9f027160e2abc04209a26ad747ef4445288b9f8de6b3b`.
Production files and guard code are never patched by the probe. Each phase has three fixed
successful pair calls inside the real supervised shell, with timestamps bracketing the actual
shell function; fixture install/bootstrap/disposal are outside those measured intervals.

| Phase | Real archive bytes | Iteration1 ms | Iteration2 ms | Iteration3 ms |
|---|---:|---:|---:|---:|
| Before, original seven-process composition |113|2359.63|2248.93|2326.25|
| After, composed operation |113|320.35|336.03|344.26|

Both phases returned0 and independently identity-checked fixture removal1. Fixed observer
tests also demonstrated RED then GREEN and preserve real child23 ahead of a forged success row;
oversized/unstructured output is refused. Each phase's fixture command budget is75seconds, its
real outer supervised shell bound60seconds, output rows at most512bytes. Failed or uncertain
fixtures are retained for disposable-container retirement. No arbitrary command mode or unknown
process signalling was added.

These are small local archive measurements, with no timing-threshold unit assertion. The source-
derived pre-tree count remains6pairs/42old commands; seven-to-one composition avoids36 sessions.
Do not project these milliseconds onto the native120second assertion or claim it is fixed.

Memory assessment: only small metadata/digest records remain reachable across phases.
`capturePrivateFile` does allocate a full read buffer internally; the archive validator still
owns its original compressed/decompressed/canonical-reproduction buffers and unchanged limits
(including256MiB compressed,384MiB aggregate,16MiB member and60seconds). Composing processes can
overlap allocations awaiting garbage collection even without retaining an extra archive buffer.
Peak RSS was not measured; a113byte fixture cannot establish maximum-size memory equivalence.
No file/archive limit or resource ceiling was increased. Native original gates remain root-owned.

### Frozen worker file SHA256

- `scripts/staging-runtime-authority.js`:
  `0e3890198ac8c1fbc7bdd9d091402af01c4cf487d43a3372c626094d7e973cb4`
- `scripts/staging-release-common.sh`:
  `edf1f40f425641f2c94c95d6596bd289ae83a039649278412b1bf205c1f7dd0b`
- `test/staging-release-pair.test.js`:
  `3c6b6c2359df021cb09846426b79f723e2e2211af78fbddad20fa7c009ad3bce`
- `.scratch/staging-v4-cutover/debug/ci130-release-pair-timing.mjs`:
  `dfcc13d9b173bd9367118d45767ad091309b3b3893656a21bbff910115bc8dcd`
- `.scratch/staging-v4-cutover/debug/ci130-release-pair-timing.test.mjs`:
  `dfb1e500eba25dba7c10fc245a719b84dcbd24b7313dbbc15f46d5792d9900a8`

## Root review and gates — 2026-09-05

- Fresh independent Spec and Standards reviews: 0 actionable findings on each axis.
  Both verified all five frozen code/test hashes above. No existing test, workflow or
  timeout was changed for this repair.
- Root focused gate: 78 tests, 66 passed, 12 platform skips, 0 failures or cancellations,
  2426.3178 ms. This includes the real pair/runtime/archive tests, diagnostic contracts,
  frontend release contracts and speaking release hardening contracts.
- Common lint/check passed: 572 JavaScript files, 165 handlers, 106 unique handler names.
  Explicit lint for both diagnostic `.mjs` files and scoped whitespace checks passed.
- Scoped secret scan passed: 1575 tracked plus 13 explicit candidate entries, 1580 unique
  files, 848 Docker COPY inputs. A fresh history scan remains required after the commit.
- Fresh full Windows gate began at 16:21 Omsk with pinned Node 22.23.2 for both the parent
  and Git Bash children, concurrency 2. Lint passed in 10231 ms; check in 23361 ms; all
  frozen inputs remained unchanged at both boundaries. Full unit gate completed with status 0:
  3262 tests, 3153 passed, 109 platform skips, 0 failed or cancelled, 4360073.7294 ms TAP
  duration (4360473 ms wrapper elapsed). Frozen inputs remained unchanged at completion.
  Logs: `.scratch/staging-v4-cutover/artifacts/windows-{lint,check,unit}-20260905-release-pair21.log`.
- New logical helper bundle:
  `187556db3d54e7da9b2ce243f7b75b9e33b91a0c96f158d473d0e7c41ecbce24`.
  No release archive has been built for it, and no helper has been uploaded or installed.
  This is not deployment clearance. Publication and unchanged native gates remain pending.

The complete Windows suite took about 72.7 minutes versus the earlier 62.6-minute baseline;
some long scenarios were 1.14–1.25 times the earlier duration. These separate full runs were
not a controlled paired performance measurement. The Windows deploy fixture substitutes its
fixed fake-command/timeout harness for `run_bounded`; it is not the real inherited-chain timing
probe. The root did not change source or weaken tests in response to this timing observation.
The local component improvement is not evidence of a faster whole suite or native timeout fix.

## Publication and native outcome — scoped optimization complete, timeout unresolved

Committed as `528f50889385775f27e53540cd22167e7c738f0d`, exact eight ticket files, five
frozen code/test blobs verified byte-for-byte against Git. Fresh final scoped scan passed;
post-commit secret history scan passed for 391 commits. Normal push published ticket20 and
ticket21 only to `prototype/aisy-today-visual-v1`; remote read-back matched exact528f508.

Native diagnostic5 run33963867027 on that commit:

- Reduced job101300367138: 11/11 contracts passed in23955.250871ms; installer554ms and
  prepared-state equivalence1109ms. Original signature still fails at120006ms: phase
  config-json-complete, missing tree/upCount, empty streams, child still alive. The tree was
  observed at140046ms and helper exit0 with pipes closed at217413ms. Diagnostic correctly
  returns1 because the original120s assertion failed. Job failed in4m12s, final11:42:27UTC.
- Full job101300366935: component5/5 in10354.78502ms and observer12/12 in1068.711653ms
  passed. Unchanged real flock scenario failed at the same tree assertion120015ms, same phase
  and empty streams, total378334.633317ms (TAP378400.571288ms). Successful first deploy
  reached build93822ms and exited256072ms. Job failed in6m50s, final11:45:05UTC.
- Full raw logs were read:22965 and46968characters. Sampled process categories are overlapping
  residency observations, not CPU time, exact invocation counts or permission to remove guards.

Compared with native4, reduced late-tree time144073→140046ms and helper settlement234109→
217413ms improved, but the required120s bound still fails. Full scenario448710.305124→
378334.633317ms is shorter, not green. This ticket's bounded composition/evidence work is done;
the overall CI/deployment repair is not. Canonical CI129 run33963867029/job101300366921
finished failed in42m44s, final2026-09-05T12:21:00UTC. Complete raw1365992characters read:
3234tests/3170pass/1fail/63skip/0cancel,2499579.318014ms; PostgreSQL51/51,15608.395644ms.
The sole failed original flock scenario took416253.665204ms: tree timeout120025ms,
lastPhase build-complete (phase differs from native5), absent tree/upCount, empty streams.
First deploy build108995ms/exit293517ms. Later artifact/browser/performance/quality gates
were not reached. No additional unchanged run, new release package or VPS mutation occurred.
