# 23 — Compose measured protected-state boundaries without removing proofs

Status: in-progress
Blocked by: 22 — measured protected-boundary attribution (done15906c9)
Spec: .scratch/staging-v4-cutover/spec.md#compose-the-measured-protected-state-boundaries

## What to build

Reduce process startup inside the three measured read-only checks while preserving all their
filesystem validation, transaction boundaries and failure/recovery behavior. This is one
coherent production repair; original120s regression remains the eventual native acceptance.

## Scope and ownership

- Fresh isolated worker owns this issue, scripts/staging-runtime-authority.js,
  scripts/staging-release-common.sh and new test/staging-protected-boundaries.test.js only.
- Read the final spec section completely before code, applicable AGENTS/tracker/domain,
  implement/diagnosing-bugs/TDD/codebase-design instructions. Existing tests are immutable here.
- Keep shared protected_identity_record and cutover consumers unchanged; use Linux-only
  exact GNU-record interpretation with existing non-Linux fallback. No platform inference
  may create a success bypass. Preserve missing-authority ordering and authority_violation.
- Use existing primitives for Compose and reservations. Keep first-match association for
  duplicate reservation paths, empty slots and prior workspace flag semantics.
- No commit/push, full suite, VPS/browser, workflow/old-test/diagnostic changes or packaging.
  Root owns shared docs, fresh review/gates and publication after freeze.
- Pinned Windows Node22.23.2; cached Linux image44f22c911346, runtime22.23.1, networknone,
  readonly repo, private512MiB exec tmpfs and uid1000. Paths/provenance are in issue22.
  Root may authorize uid0 only for a disposable foreign-owner focused test if necessary.
- After frozen focused contracts, run unchanged ci131-protected-boundary-timing.mjs once
  in that established offline fixture. Compare earlier issue22 observations honestly as
  separate runs; no unchanged baseline/actual flock retry or PID0 acceptance.
- Preserve baseline source HEAD15906c9 (production equal528f508), commonSHA
  edf1f40f425641f2c94c95d6596bd289ae83a039649278412b1bf205c1f7dd0b,
  runtimeSHA0e3890198ac8c1fbc7bdd9d091402af01c4cf487d43a3372c626094d7e973cb4.

## Acceptance criteria

- [x] Three purpose-specific operations retain real checks/order/failure mapping and60s guard.
- [x] Existing callers, identity helper, cutover, original tests/workflows remain unchanged.
- [x] Real-file module/CLI and shell finite-failure contracts demonstrate RED→GREEN;
      Linux GNU-record equivalence and non-Linux fallback behavior covered.
- [x] Focused Windows/Linux checks and unchanged diagnostic after-measurement documented
      with exact source/runtime/hashes and honest limits; no native success projection.
- [ ] Root independent reviews, fresh full gate, commit and original native/CI feedback recorded.

## Notes

Worker ci132_compose_protected claimed this ticket only. Read the complete final spec and
implement/diagnosing-bugs/TDD/codebase-design instructions plus required references and repo
guidance. Root owns shared docs, independent review, full gate and commit/publication. Tests
exercise the agreed real module/CLI and shell seams; existing tests remain unchanged.

The selected Linux populated-success path can avoid61 guarded starts (100to39); this is a
source-derived target, not a measured speedup. The current native tree arrives around140s.
No120s/deadline relaxation or claim of resolved deployment is permitted by this ticket.

## Worker implementation and focused evidence

Production/test source is frozen for root independent review. Status stays in-progress until
root records its review, fresh gate and commit. No full suite, commit, push, native rollback,
VPS, archive packaging, dependency download or existing-test/workflow edit was performed here.

Three purpose-specific module/CLI operations were added. They accept only their fixed paths
and captured records. Compose parses each JSON at its existing proof, in runtime/active/transaction
order. Its shell fast path requires all captures populated; the original sequential path remains
for missing captures. Workspace first performs the same protected-runtime proof, then requires
Linux and a direct private child of the captured rollback root. Native BigInt lstat is compared
to the existing exact GNU device/inode/full-mode/uid/gid/permissions record. The full permission
mask includes special bits; workspace must be exactly0700 and currently owned. The unchanged
shell implementation remains for non-Linux hints and missing-capture/invalid-parent ordering.
The verifier independently refuses non-Linux GNU interpretation. Shared protected_identity_record,
its initial capture and cutover consumers did not change.

Reservations retain the preceding workspace proof, and then process the fixed temporary/live/store
slots in order. Empty paths are skipped; duplicate paths use the first matching slot's capture.
Only canonical decimal safe-integer captured sizes with at least67108864 bytes proceed to the
existing verifyReservation primitive, preserving exact JSON, owner/mode/no-follow/single-link,
stable descriptor, actual size and allocated-block proofs. All-empty slots retain only the old
workspace call. Allocation, consumption, truncation, removal and all callers are unchanged.

Every new shell operation retains COMMAND_SECONDS=60 and run_bounded. A failed Compose/workspace
proof returns1 and sets authority_violation=1. Empty earlier captures retain their previous
return1 without newly setting the flag; reservation-only refusal returns1 without newly setting
it or clearing an earlier flag. Original120s regression and every existing guard remain unchanged.

### RED→GREEN checkpoints

- Windows pinned22.23.2 Compose real module/CLI fixture: absent export RED, then GREEN for
  present/absent markers. Linux real shell invocation RED showed three original guarded command
  entries versus the new single Compose operation, then GREEN.
- Linux workspace module RED absent export, then GREEN against actual GNU stat. Shell RED
  showed runtime+stat versus one workspace operation, then GREEN, with the original GNU path
  still succeeding under a non-Linux OSTYPE hint. Actual Windows verifier rejects GNU interpretation.
- Windows reservation module RED absent export, then GREEN with three actually allocated64MiB
  files. Linux shell RED showed six reservation-only commands after workspace versus one,
  then GREEN.
- All-empty reservation finite-guard regression RED returned1:0 when an unnecessary new guard
  failed23; preserving the original all-empty skip made it GREEN0:0.
- Linux finite child exit statuses1/23/124/125/137 pass at Compose, workspace, reservation-only
  and earlier fallback proofs with the exact expected return/flag mapping and unchanged60s
  arguments. Earlier real runtime/active failures retain precedence over later empty/malformed
  captures. Real reservation truncation leaves flag0; a preceding changed workspace setsflag1.

New tests additionally cover both marker byte bounds and presence/bytes/identity/mode/link/type
changes; all six GNU identity fields; actual1700/2700/4700 workspace modes; direct-parent, missing,
replacement, symlink and file workspace changes; missing/invalid/underflow/unsafe reservation
capacities; duplicate and empty slots; exact JSON changes; hardlinks, mode/type/identity and real
sparse allocation loss; and fixed CLI argument arity. Successful shell probes invoke the real
CLI through a finite tracing adapter at run_bounded. They do not pretend to exercise the actual
supervisor. The separate unchanged ci131 diagnostic below exercises the actual inherited guard.

### Focused gates and immutable provenance

- Windows22.23.2: new test plus unchanged staging-runtime-authority and staging-release-pair
  tests:65 tests,43 pass,22 platform skips,0 fail;1462.10ms. New test alone contributes24 tests,
  11 passing and13 platform skips.
- Linux22.23.1 uid1000: same three files, sequential file execution:65 tests,61 pass,4 skips,
  0 fail;6298.48ms. New test contributes22 pass and2 skips. Bash syntax passed.
- Root explicitly authorized one separate uid0 execution of only the new foreign-owner test:
  1 pass,0 skip/fail;126.64ms. It changes actual owner of environment, active marker, transaction
  marker, workspace and reservation inside newly created private /tmp fixtures. Before chown,
  every resolved target is strictly under its fixture root, equals its realpath, is a real
  directory/file owned byuid0; after chown, dev/inode are unchanged and uid1 is asserted. Cleanup
  verifies the original root's no-follow directory type/dev/inode before recursive removal.
  Readonly host mounts were never targets; the disposable container exited0 and was retired.
- Targeted ESLint, Node syntax for changed JS/new test, Bash syntax and git diff --check pass.
  git diff for existing tests/workflows/deploy/rollback/cutover is empty. Root retains full-gate
  and independent-review responsibility; these focused results are not native rollback success.
- Source HEAD15906c92cf6e7cf0a3a02d9714f0df2b2e766396.
- Frozen common SHA256:17bc4b780913d632bff2b814c514ad4c82d70d95a3d282592c4edfb62aefaaa3.
- Frozen runtime SHA256:daed4f7d3d309a848d20b803a85890bceccd774d782f702f63499db1601600bd.
- New test SHA256:cb456e16dac8b4c77e21fe338c727d8e8d6ba3c38da8e38d03bb6ccca7125ac2.
- Unchanged ci131 SHA256:40bf8db067893232447d5947f9f736ea88c0ef9b1b88cb37e22811c9fd635ab4.
- Unchanged rollback SHA256:85aeff1f0d81b575e9b7a78d767539b66291f89e93f51988d77ea9eded2fe153.
- Windows runtime SHA256:0d0f5e39f9f3d9587bc19f73eab3c2c9c4903fd02d6dbf9c853dd81b3d95fad4.
- Cached image:sha256:44f22c911346d64eb74edc2af1355825d17d70d91c4fb30294581596293b2360.
- Linux runtime:v22.23.1,124835376 bytes,
  SHA25693956de2e59480474a7b46571da1651180b1a050cdf32641ebec4ce6e478e068.

Exact focused Windows command, from server root:

```powershell
& 'C:\Users\4FE4~1\AppData\Local\Temp\node-v22.23.2-win-x64\node.exe' --test test/staging-protected-boundaries.test.js test/staging-runtime-authority.test.js test/staging-release-pair.test.js
```

Exact focused Linux command (after the same cached fixture required the authorized Docker
sandbox escalation for context access; no automatic approval rejection):

```powershell
& 'C:\Program Files\Docker\Docker\resources\bin\docker.exe' --context desktop-linux run --rm --pull=never --network none --read-only --user 1000:1000 --tmpfs '/tmp:rw,exec,mode=1777,size=512m' --mount 'type=bind,source=C:\Users\Ригер\Desktop\Repetotor\Приложение репетитор\server,target=/workspace,readonly' --mount 'type=bind,source=C:\Users\4FE4~1\AppData\Local\Temp\easyboost-ci124-linux-runtime-08f4c66031ef4de6ab02c402b93fd3d6,target=/runtime,readonly' --workdir /workspace 44f22c911346 /bin/bash --noprofile --norc -c 'set -eu; cp /runtime/node /tmp/node; chmod 0755 /tmp/node; /bin/bash -n scripts/staging-release-common.sh; exec /tmp/node --test --test-concurrency=1 test/staging-protected-boundaries.test.js test/staging-runtime-authority.test.js test/staging-release-pair.test.js'
```

Exact root-authorized foreign-owner command (only that new test runs):

```powershell
& 'C:\Program Files\Docker\Docker\resources\bin\docker.exe' --context desktop-linux run --rm --pull=never --network none --read-only --user 0:0 --tmpfs '/tmp:rw,exec,mode=1777,size=512m' --mount 'type=bind,source=C:\Users\Ригер\Desktop\Repetotor\Приложение репетитор\server,target=/workspace,readonly' --mount 'type=bind,source=C:\Users\4FE4~1\AppData\Local\Temp\easyboost-ci124-linux-runtime-08f4c66031ef4de6ab02c402b93fd3d6,target=/runtime,readonly' --workdir /workspace 44f22c911346 /bin/bash --noprofile --norc -c 'set -eu; cp /runtime/node /tmp/node; chmod 0755 /tmp/node; exec /tmp/node --test --test-name-pattern=foreign-owner test/staging-protected-boundaries.test.js'
```

### Single unchanged after-measurement

After the above production/test freeze, unchanged ci131 ran exactly once, successfully. Every
observation and the overall diagnostic status is0. The original inherited Node chain and real
run_bounded are used. Existing fixture setup, two retained pairs, present transaction marker,
three genuinely allocated67108864-byte reservations and disposable cleanup are unchanged from22.

| Operation | Recorded22-before median ms | After1 ms | After2 ms | After3 ms | After median ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| Compose reproof |1023.05|336.50|336.58|328.66|336.50|
| Workspace reproof |703.88|348.22|328.31|347.19|347.19|
| Reservations including workspace |2727.75|717.92|679.65|653.94|679.65|

The earlier before and this after are separate runs, not an interleaved comparison or native
CPU measurement. They support less repeated startup in these component checks. The static
populated path is100→39 selected guarded starts; neither these timings nor that count prove
the original native120s regression now passes. No actual Docker Desktop flock retry or PID0
acceptance occurred. Native/CI feedback remains for root.

Private installed fixture bundle after:
a426ad80a921085f5150ffbb2df32d51b2ddb647d0fcad76d88cfb4c160ce388.
The diagnostic independently verified installed helper generation and exact helper bytes
except the established fixture-specific helper-bundle PATH binding. Its reported common,
runtime source and Linux executable hashes match the frozen values above. This is a hermetic
fixture generation, not a packaged production bundle. Docker --rm exited0 and retired the
private fixture; no host release state was changed.

Exact after command:

```powershell
& 'C:\Program Files\Docker\Docker\resources\bin\docker.exe' --context desktop-linux run --rm --pull=never --network none --read-only --user 1000:1000 --tmpfs '/tmp:rw,exec,mode=1777,size=512m' --mount 'type=bind,source=C:\Users\Ригер\Desktop\Repetotor\Приложение репетитор\server,target=/workspace,readonly' --mount 'type=bind,source=C:\Users\4FE4~1\AppData\Local\Temp\easyboost-ci124-linux-runtime-08f4c66031ef4de6ab02c402b93fd3d6,target=/runtime,readonly' --workdir /workspace 44f22c911346 /bin/bash --noprofile --norc -c 'set -eu; cp /runtime/node /tmp/node; chmod 0755 /tmp/node; exec /tmp/node .scratch/staging-v4-cutover/debug/ci131-protected-boundary-timing.mjs'
```

## Root review and gates underway

Fresh independent Spec and Standards reviews of all three frozen files each returned0 findings.
Root read the complete new test and production diff and verified the frozen hashes. Root pinned
Windows22.23.2 focused four-file set (new boundary tests, existing runtime/pair tests and unchanged
ci131 contracts):69tests/47pass/22platform skips/0fail,1522.0611ms. New logical production helper
bundle798ec4c8d5f62dd953ecfed04ceffcca41fea68adf5dd1a9ec888c21d332f71b is not packaged or installed.

Additional root Linux compatibility probe selected five unchanged deploy/rollback tests using
the cached22.23.1/image fixture, uid1000, readonly mounts and no network. Its private executable
tmpfs was2GiB, not512MiB: existing deployment cases reserve two256MiB backup capacities plus
three64MiB headrooms, so the smaller component-only mount is insufficient. No guard/deadline
or live-server capacity changed. This probe is NOT the actual Linux flock scenario.

Result:5tests/1pass/4fail/0skip,24639.125701ms. The pinned-runtime replacement case passed.
Workspace replacement in deploy/rollback and post-reservation-store debris correctly refused
the operation but returned125 instead of70; sparse upload correctly refused but returned125
instead of68. Each additional failure was exactly 'staging deadline retirement source after
claim namespace no longer matches its reservation'. This local Linux run is not a green gate.

Root compared every failing case against exact pre-change15906c9 source in separate disposable
containers. A test-source-only Git export included scripts/test/Compose/package, NOT a release
artifact. The first export was rejected before tests because core.autocrlf=true changed bytes;
the second used command-local core.autocrlf=false/core.eol=lf. Extracted common/runtime/deploytest
SHA256 matched exact Git blobs before execution:edf1f40f.../0e389019.../88643e141b6f5fdcbdca50086b6a95eb2bbf77e20785c957bccedb45c5988e4d.
No working-tree replacement or mixed helper generation occurred. Baseline sparse test reproduced
the same125-versus68 in1744.23657ms (TAP1804.891087ms); the remaining three reproduced identical
125-versus70 failures in2562.993566/11868.444493/1982.254633ms (TAP16549.356568ms).
Thus all four observed local compatibility failures also exist without ticket23. The precise
Docker/kernel/runtime cause remains unproven and no guard was relaxed or patched. These cases
passed on the native CI129 baseline; native CI is still required on this new candidate.

Fresh complete pinned Windows lint/check/test started at2026-09-05~18:55Omsk, source unchanged.
Parent and Bash child both22.23.2, concurrency2. Lint0/8642ms, check0/24571ms; unit in progress.
Logs windows-{lint,check,unit}-20260905-protected23.log; root session8745. No commit/push for23
or VPS action occurred; publication/native feedback await this full gate.

### Windows fixture permission diagnostic during the full gate

The full gate reported one failure at test1549, the unchanged Windows-only owned-descendant
timeout test in postgres-restore-supervisor.test.js:226. Its 1000ms deadline correctly fired,
but taskkill returned1 with an access-denied diagnostic; the fixture explicitly reported
childSettlementUnproven. A single focused repeat under the same restricted execution context
reproduced it (1test/0pass/1fail,1237.4793ms). The exact unchanged test outside that restriction,
after authorized tool escalation, passed (1test/1pass/0fail,1345.2764ms). No source, assertion,
deadline or cleanup proof was changed. This supports an execution-permission cause, not a
ticket23 production regression. The complete original gate continues and remains non-green;
root also started the entire unchanged supervisor test file outside the restriction to verify
its companion cases, pinned Node22.23.2 and Bash-child PATH, session51750. No VPS access.

The complete unchanged supervisor file finished successfully outside the restriction:
33tests/33pass/0fail/0skip/0cancelled,45594.3599ms, exit0. Both exact Windows descendant cases and
all restore-supervisor companion cases passed. This does not rewrite the original full-gate
failure or substitute for its remaining tests/native CI. No full-suite restart was launched.

Root subsequently compared the affected supervisor test to the exact15906c9 Git blob: both
SHA2565a37f72bd1bdab9ddedc036f8a19865d9083f7ad989132efae5d4dc5d8ca189f, byte-identical.

### Completed root gate; native publication pending

The single complete pinned Windows gate finished with its original nonzero result retained:
3286tests/3163pass/1fail/122skips/0cancelled, TAP3585915.9431ms. Lint and check passed as above.
Runner unit exit1, elapsed3586399ms, frozen input hashes unchanged. Session8745 is closed.
The only failed case is the documented restricted-context Windows taskkill refusal. The exact
unchanged affected file passed33/33 outside that restriction, including the failed case; no
test, timer, cleanup proof, platform skip or production guard was relaxed. The original failed
log remains intact, and this is not described as a fully green run or deployment clearance.

Root will publish the reviewed repair only to the already authorized prototype branch for
native validation. This is candidate publication, not installation. All remaining local cases
passed or explicitly skipped; the four Linux compatibility failures reproduced on the exact
old baseline remain disclosed above. Original native120s and canonical CI on this candidate
are still mandatory. No unchanged full-suite restart is justified by the isolated permission
restriction. Root retains native feedback and final issue-status responsibility.

## Published native6 outcome — former barrier passes; next recovery barrier fails

Exact six-file commit4e3b02c88f2c02cd2c4f7b1bdf9c6ffbf2910e23 was normally pushed with the
preceding diagnostic15906c9 to the authorized prototype branch only. Remote HEAD confirmed.
Fresh candidate secrets and393-commit history scans passed. No archive or installation.

Native run33970687905 reduced job101318538174 succeeds:11/11contracts,23704.766619ms;
verified fixture installer562ms/equivalence3051ms; original120000ms tree barrier reached at
104352ms, upCount1. The actual helper exited and closed0 at166440ms,138stdout bytes/0stderr,
clean settlement. All11phase rows retained, no omissions. Full23308-character raw log read.

The full original job101318538073 fails at a newly reached later operation, not the old rollback
tree barrier. Node22.23.2; component5/5,10099.359513ms; observer12/12,1070.655877ms. Real chain
component358.10/358.54ms remains measured startup, not a CPU profile. Original successful deploy
build72871ms/exit210601ms; rollback tree111700ms/exit177817ms. It then waits for recovery and
times out120010ms at test line833: phaseconfig-json-complete,upCountmissing,treepresent,three
synthetic stdout bytes30-newline,empty stderr. The tree marker remains from the earlier rollback;
it does not prove this recovery advanced. Original511228.614408ms/TAP511302.784909ms,0pass/1fail.
Observer511334ms/509samples/8omissions/0truncations/18824metadata reads/exit1. Full53861-character
raw log read. No cleanup failure masked the primary timeout. Both jobs are final.

Thus ticket23's measured composition clears the former barrier in both native paths, but does
not clear the full recovery test or deployment. CanonicalCI130run33970687937/job101318538312
still runs; PostgreSQL/preflight steps pass, final totals pending. Ticket24 constructs narrower
feedback for the newly reached recovery deadline without changing production or old tests.

## Canonical CI130 final — rollback clearance is not yet stable

Run33970687937/job101318538312 on the same exact4e3b02c completed with failure in36m39s.
Root read all1375166characters/20371lines of the raw log for failures and totals. PostgreSQL
passed51/51,0fail/skip,15231.983182ms. Lint/check passed; canonical unit3258tests/3192pass/
1fail/65skip/0cancelled,2138426.789157ms. All subsequent release/artifact/browser/performance
and quality steps were not reached. The high-severity production audit threshold passed,
but its three moderate advisories remain; this is not an all-severity clean audit.

The sole failure2760 is still the ORIGINAL rollback tree barrier, line815, not recovery:
scenario353712.808127ms; wait120004ms,phaseconfig-json-complete,upCountmissing,treeabsent,
both streams empty. Successful preceding deploy build79972ms/exit231195ms. No rollback-tree,
rollback-exit or recovery milestone in this canonical run. No new failure was hidden by cleanup.

This qualifies the preceding native6 conclusion: the reduced and isolated full native paths
passed the former barrier on their own runners, but canonical CI has not. The repair reduced
measured overhead, but stable original-test acceptance and deployment clearance are unproved.
Do not mark this issue done or relabel CI130 green. Ticket24 remains useful diagnostic-only
feedback for the later recovery failure already observed in isolated native6; it does not
supersede or dismiss the outstanding canonical rollback deadline. No unchanged rerun was made.
