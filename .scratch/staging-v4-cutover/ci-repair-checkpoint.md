# CI repair checkpoint — 2026-09-05

## Исходная точка

- Branch: `prototype/aisy-today-visual-v1`; local/remote HEAD confirmed `944b9b8`.
- Failed Linux CI run: `33870937009`, 11 failures; original findings split into tickets 06–08.
- No live server mutations in this repair session. Read-only SSH recheck at 23:31–23:32 UTC proved
  unchanged legacy state and healthy local/public readiness; see server-baseline.md. Existing ignored
  bridge/application release artifacts are unchanged. A new local helper-only candidate is built,
  but not yet cleared for installation; see artifacts/README.md.
- Deferred issue 05 and user prototypes/untracked work remain outside this repair.

## Реализация и проверка

- Issue 07: nonce escaping fixed; fake Compose now drains stdin for `-f -`; invalid-mode fixture uses
  valid approved tuple `700/600/664` against actual marker `644`, preserving refusal status 67.
- Local Linux cutover success and roll-forward passed; final precondition-refusal scenario also passed.
- Issue 08: pinned Node/README assertions and four Linux fixture defects fixed; candidate vs prior
  image behavior and assertions corrected in release-lock fixture.
- Linux host-lock 15/15 and installer maintenance 2/2 passed.
- Issue 06: all three dispose-return authorities retained; transaction-specific strict completion
  and repeated retirement/publication cleanup for POSIX and deadline preserve exact authority,
  payload/inode and absent-side null pointers. Standalone defaults remain unchanged.
- Final isolated Linux recovery/standalone batch: 224 tests, 224 passed, zero failures/skips (81.1 s).
- Final isolated Linux cutover success/refusal/roll-forward: 3/3 passed (52.4 s). Host-lock and
  installer maintenance: 17/17 passed (4.7 s).
- Windows focused recovery/standalone batch: 224 tests, 219 passed, five Linux-only skips.
  Full Windows npm test passed: 3218 tests, 3119 passed, 99 skips, 0 failed/cancelled (2999.1 s).
  This also included the pre-existing untracked issue-05 test file, which is not part of publication.
  Final common lint/check passed (571 JavaScript files, 165 inline
  handlers/106 names). An earlier parallel lint attempt hit ENOENT while tests removed a temporary
  fixture directory; the later complete pass supersedes that environment race.
- Final working-tree secret scan passed (1547 tracked + 92 explicit candidates; 848 Docker COPY
  inputs), history secret scan passed (375 commits), and git diff --check passed.
- Final independent Standards and Spec reviews: zero findings on both axes. The initial Spec P1
  concerning authority loss on replay was fixed and re-reviewed.

The full Windows `npm test` exec session `33660` finished with exit code 0; output is preserved at
`artifacts/windows-unit-20260905.log`. Do not restart it merely because the dialogue was resumed.
Lint/check/security exec session `21485` also finished with exit code 0.

## Local Linux environment limits

- Isolated network-disabled container `easyboost-ci-linux-20260905`, native filesystem and user 1000.
  Node 22.23.1 and Python 3.11.2 from already installed images; remote CI remains Node 22.23.2.
- Snapshot from tracked base + scoped changed files. Shell files normalized to LF in the isolated
  snapshot after Windows export produced CRLF. No user directories or Docker socket mounted.
- Real-flock integration currently cannot prove its maintenance lock on Docker Desktop: fdinfo
  prints `FLOCK ADVISORY WRITE 0`, while the existing production parser accepts -1 or positive PID.
  A minimal owned-file reproduction gives the same result, including Docker VM host PID mode.
  Do not weaken the production parser to get this environment green; actual Linux CI must run it.
  A read-only anonymous-memory flock probe on staging itself reported a positive recorder PID;
  it did not reproduce the Docker Desktop PID-0 limitation or touch an application lock/file.
- Earlier container `easyboost-ci-repair-20260905` lacked Python and was not suitable for these tests.
  Both owned containers were stopped and removed after the final tests. Five owned diagnostic
  files (two base tar exports, copied Node and two probes; about 599 MB) were removed from the exact
  artifacts directory. Final test logs remain locally as ignored `*.log`; previous release archives
  were preserved. No database containers or volumes were started or removed.

## Следующая точка

Implementation, review and local common gates are complete. Ticket 06 is committed as `6c310e9`,
ticket 07 as `d173c64`, ticket 08/coordinator evidence as `b2b0b0f`. All three were pushed together
to the authorized `prototype/aisy-today-visual-v1` branch; remote HEAD is confirmed as
`b2b0b0fa382f502e7e54859048ef637f44fd1b2f`. No other branch was pushed.
CI #122 is running: https://github.com/bublevoin-byte/easyboostege/actions/runs/33932297652
(job `101213218627`, started 2026-09-05 06:14 Omsk). Verify its full Linux/release result before
owner deployment; the push does not trigger the Deploy staging workflow.
Pinned canonical producer is available locally at
`C:/Users/4FE4~1/AppData/Local/Temp/node-v22.23.2-win-x64/node.exe`: verified Node 22.23.2,
zlib 1.3.1-e00f703. New helper candidate `easyboost-staging-helper-bootstrap-aa670f75.tar.gz` is
inspected and source-tree verified (SHA `4a83eb274a143263f0ba3c3d09118da76746144f4b21ba460ecd71e659bd94b6`).
All 18 packaged files match exact Git blobs at `d173c645a1dec4c8e83316350927ec700b218410` and
were rechecked against final published HEAD `b2b0b0f`. The exact owned temporary source staging
directory was removed after comparison; the verified archive is preserved. The old 944b9b8/323d5cb
bootstrap is stale. No live server mutations occurred.

## Additional deployment prerequisite found read-only

Staging `/tmp` is 982 MiB tmpfs with 778 MiB observed free. Current helpers hard-code large release
workspaces under `/tmp`; their unchanged admission calculation for the known b407 candidate + legacy
bridge requires 900201716 free bytes after frozen archive copies. See server-baseline.md for the exact
inputs. Do not attempt the real UI deploy or claim it ready on this host solely from green CI. After
the current CI repair, recompute with the exact candidate and address a disk-backed private workspace
or owner-approved host configuration without weakening the capacity guard. No implementation/mount
change has been made for this separate precondition; tickets 06–08 remain frozen.

After publishing 06–08, bounded issue 09/spec section was created for the disk-backed workspace.
Fresh agent `/root/disk_workspace_repair` is implementing it with the implement/TDD workflow.
Owned production files: staging-deploy.sh, staging-rollback.sh and staging-release-common.sh only
if needed for the shared existing lifecycle; corresponding two operator tests and issue09. Root
owns shared docs/status and all commits/push. No live/config/mount/DB changes authorized or planned.
Wait for source freeze and independent review before the next full operator gate; the previous
3218-test pass remains evidence only for published `b2b0b0f`, not for an unfinished issue09 patch.
The current aa670f75 helper artifact is likewise the verified 06–08 candidate and must be rebuilt
after issue09. CI #122 runs independently against b2b0b0f: setup/audit/config/PostgreSQL integration
passed; canonical one-build release gate was running when last inspected.

## Active issue09 verification workspace

CI #122 was still running at 2026-09-05 06:31 Omsk, with all three Linux cutover scenarios and
deploy/recovery scenarios through test 2602 passing in the visible live log. The complete CI result
is not yet known. Issue09 implementation is not yet frozen; do not reuse the b2 full-suite result
as evidence for it.

Owned isolated container `easyboost-ci-disk-workspace-20260905` contains an exact LF-only Git
archive of `b2b0b0f` at `/tmp/easyboost-ci`; issue09 files have not yet been copied. It is network
disabled, user 1000, no host mounts/socket, 2 CPUs/3 GiB, cached Debian image with Python 3.11.2 and
copied Node 22.23.1. The copied Node source container was already removed. Local temporary test
inputs `artifacts/linux-base-b2b0b0f.tar` and `artifacts/node-linux-issue09` are ours, not release
artifacts; never stage them. Remove this container and these exact two files after evidence is saved.
The implementation agent owns the three release shell files and two operator test files. Root
also added a concise disk-workspace paragraph to docs/KNOWN_LIMITATIONS.md and owns shared docs.
Next: source freeze, independent review, focused Linux checks, new common gates, commit/push and
exact helper-artifact rebuild. Live server and existing recovery evidence remain unchanged.

## CI122 follow-up and current sessions

CI122 test2719 failed at `staging-release-lock.integration.test.js:557`: after first build lock
exclusion, deploy exited1 before active-state mutation. Remaining tests were still running.
The exact generated fake Docker command responds to pg_dump with status0/zero bytes; diagnostic
`debug/fixture-backup-probe.mjs` is red on the production nonempty-stream requirement. This temporary
diagnostic must be removed after issue10's permanent regression replaces it. Fresh agent
`/root/lock_fixture_backup_repair` owns only that integration test and issue10. No production lock,
backup or PID guard changes; actual Linux CI must prove the whole integration scenario.

Issue09 production/tests frozen after the Spec P1 archive-write boundary fix. Final independent
Standards and Spec reviews are both zero findings. Linux focused operator run (20 selected tests)
exec session `36357` is active in the owned container; log is
`artifacts/linux-issue09-focused-20260905.log`. Copies include the exact frozen three helpers, two
operator tests and root operator documentation. The implementation agent's final Windows focused
run also remains active. Do not start common gates until issue10 freezes, and never mutate frozen
helper sources during the common operator gate. No full test for 09/10 has started yet.

CI122 is now final: 3190 tests, 3130 passed, 59 skipped, one failure (test2719), 1912220.7 ms.
The release wrapper stopped in unit tests; build/artifact/browser stages did not run. Issue10 is
frozen with a permanent exact-command regression; Windows and Linux fast checks each passed1/1.
The obsolete throwaway probe source was deleted after replacement; its RED output above is retained
as evidence. It is not a production backup validation and does not prove the later real-flock stages.

Issue09 Linux operator session36357 finished exit0:20/20, zero skips, 101389.3ms. Additional Linux
cutover session71612 finished exit0:3/3, zero skips,45599.8ms. Both logs are preserved under artifacts.
The agent's final Windows targeted verification is18passed/2POSIX-skipped over20distinct cases.
Both implementations are now frozen; helper bundle digest is
`89b506d5b5e74ecce8ce65d29a7e0fe9c2a9b6c4380de9dc515d4c469d465e4e`.
Issue10 independent review and new common gates are next. The verified aa670f75 archive remains
historical b2 evidence and must not be installed as the final disk-workspace fix.

## Frozen 09/10 common gate — active

- Final issue10 Standards/Spec reviews: zero findings; full real-flock Linux verification still pending.
- Common lint/check session76954 completed exit0 (571JS,165handlers/106names). Secret scan passed
  1551tracked+92explicit candidates,848DockerCOPY inputs. Final working helper digest above unchanged.
- Full `npm test` session **54201** started around 2026-09-05 06:50 Omsk and is running; log:
  `artifacts/windows-unit-issue09-10-20260905.log`. Do not restart it just because this task resumes.
  It has one observed failure so far: `watchdog identity capture failure reaps the gate and the exact
  running pg_restore` in unchanged `test/postgres-restore-supervisor.test.js:612` (16068.6ms). Detailed
  failure diagnostics are emitted by the reporter at full completion; no final result yet.
  A separate unchanged focused rerun passed1/1 in3852.3ms, exit0; log
  `artifacts/windows-watchdog-isolated-20260905.log`. This suggests execution instability but does not
  establish the cause or turn the incomplete full gate into a pass. No production/test/timer edits made.
- Linux diagnostics are complete. Owned container `easyboost-ci-disk-workspace-20260905` was verified
  to contain only its sleep process, then stopped/removed. Two exact owned temporary files
  `linux-base-b2b0b0f.tar` and `node-linux-issue09` were removed; logs and release archives are preserved.
  Cleanup session3865 completed exit0. Docker Desktop was not stopped; no unrelated container/image/volume
  was changed. The ephemeral probe inside that container disappeared with it.
- No 09/10 commits or push yet. Source/tests remain frozen; prepare exact helper artifact only with
  a clearly provisional status until gates/commit/source-blob comparison and Linux CI are settled.

Provisional helper package now exists: `artifacts/easyboost-staging-helper-bootstrap-89b506d5.tar.gz`,
archiveSHA `9d6fc415dacf7b3887e8818e11ede65b29ea26cf4b34f04edcd187396d9ea24e`,172803compressed,
904783expanded,18files, canonical Node22.23.2/zlib1.3.1-e00f703. Inspection/tree verification passed;
15 files match raw b2 Git blobs and3 match frozen working helpers. Packaging directory is retained at
`C:/Users/Ригер/AppData/Local/Temp/easyboost-helper-package-20260905-89b506d5/source` (parent also
contains `source.tar`) so all18 can be compared to the implementation commit before cleanup.
Do not install it yet. README explicitly marks the unresolved gates and current source provenance.

## Bounded local harness follow-up (issue11)

The frozen gate's restore test file completed all its bodies but worker20792 remained live with
no current direct descendants. It was identity-checked (node.exe, exact test path, creation
2026-09-05 06:51:17 Omsk) and only that hung worker was stopped around07:09 Omsk. Remaining test
workers continue in session54201. The current gate is failed/intervened, never a pass; stopping
the hung worker allowed buffered later-file output to proceed. No app/server process was stopped.

Exact-function diagnostic `debug/restore-fixture-timeout-probe.mjs` (no DB/filesystem mutation in
Bash child) reproduces the fixture problem: its1s timeout rejects but finite8s child keeps Node
alive8136ms; prompt-exit assertion fails. Log: `artifacts/windows-fixture-timeout-probe-20260905.log`.
Fresh issue11 agent `/root/windows_fixture_settlement_repair` owns ONLY
`test/postgres-restore-supervisor.diagnostic.mjs` (outside npm's test/*.test.js glob) and its ticket
until root explicitly releases the source freeze. It must not patch the original test/helper sources
under the running09/10 gate. Scope is bounded exact local fixture cleanup, preserving timeout failure,
all existing assertions and production restore authority. Do not just hide orphan handles or raise
deadlines. Review/merge proposal after collecting the current gate; then a new final common gate is
required. Consider existing EASYBOOST_TEST_CONCURRENCY=2 and TAP reporter for final Windows gate:
that changes test scheduling/diagnostic output, not timeouts/assertions, and avoids the default mass
parallel launch. CI already intentionally uses concurrency1.

Issue11 diagnostic proposal is now frozen: SHA256
`5A37F72BD1BDAB9DDEDC036F8A19865D9083F7AD989132EFAE5D4DC5D8CA189F`, original test remains identical
to b2. Two new Windows regressions prove exact finite-child termination/ESRCH with ~1180ms worker exit
and explicit unproven settlement for an already exited launcher; focused16/16,36500ms approx,
syntax/ESLint passed. Sandboxed taskkill was denied as expected and remained a test failure; the exact
owned regression passed with normal tool escalation, as required for full local process tests.
Final independent Spec/Standards reviews are both0 findings. Agent awaits root's explicit integration
release after current gate finishes. The root minimal probe now injects spawnSync as well, so it can
be rerun unchanged against the integrated function. No change to deadlines/production authority.

### Current follow-up snapshot — 2026-09-05 07:33 Omsk

Gate54201 remains active on frozen09/10 sources, already failed/intervened. It has additionally
reported the common-finalizer structural test and low-capacity operator test as failures; no final
counts yet. The latter isolated unchanged test failed identically in13151ms at line1902 reading an
absent `commands.log`, after its nonzero-status and capacity-diagnostic assertions passed. Evidence:
`artifacts/windows-capacity-isolated-20260905.log`. This is not evidence of an unsafe successful deploy.
Fresh issue09 retry agent is diagnosing the journal lifecycle using only a separate
`test/staging-deploy.capacity-diagnostic.mjs` copy; original files remain frozen.

The structural-test proposal is a mechanical common-helper copy at
`debug/staging-release-common.finalizer-guard.sh`, SHA256
`f667daac6d5bc94090f9f027160e2abc04209a26ad747ef4445288b9f8de6b3b`. Only the workspace operation
allowlist spelling changes from case to the equivalent boolean predicate. The unchanged static
assertions are RED on actual/GREEN on copy;20 admission inputs have identical statuses. This is not
yet integrated. The provisional89b506d5 helper artifact becomes stale after that line is integrated.

Final integrated full gate should use the existing EASYBOOST_TEST_CONCURRENCY=2 setting and TAP
reporter with pinned Node22.23.2/npm at
`C:/Users/4FE4~1/AppData/Local/Temp/node-v22.23.2-win-x64`. Pin PATH only in that command session;
do not modify machine configuration or weaken existing deadlines/assertions. No actual source
integration until current54201 completes and root releases the freeze. No new commits/push/live writes.

The issue09 capacity follow-up is now frozen/reviewed: diagnostic test SHA256
`88643e141b6f5fdcbdca50086b6a95eb2bbf77e20785c957bccedb45c5988e4d`. The existing fake df response
used six-column text although callers request byte availability; new disk-workspace placement made
it fail during upload admission before Docker logging. The corrected response is128MiB, between
measured upload67109267 and combined738199892 requirements. All previous assertions stay; status68
and the exact combined-capacity error are added. Existing combined-capacity and low-upload refusal
cases pass2/2,32102.2ms. Both follow-up copy reviews (Standards/Spec) report0 findings. No original
helper/test edits yet. Agent `/root/disk_workspace_gate_retry` may integrate its two reviewed copies
and remove them only after explicit root freeze release. Issue11 likewise remains diagnostic-only.

## Gate54201 completed; integration released — 2026-09-05 07:49 Omsk

The frozen09/10 full Windows gate finished EXIT1:3231tests,3127passed,101skipped,3failed,0cancelled,
3471150.4898ms. Exactly the three failures diagnosed above remain: watchdog fixture timeout,
global static mode-switch pattern, and old df fixture's unintended early upload refusal. The earlier
exact hung-worker20792 intervention remains part of this failed run's evidence; this is not a pass.
No further unknown failure was reported. Session54201 is CLOSED and must not be polled/restarted.

Root explicitly released the source freeze for reviewed integration only: issue09 retry agent owns
actual common helper/deploy test and removes its two copies; fresh issue11 integration agent owns
actual restore test and removes its diagnostic copy. Both verify exact reviewed SHA values and run
focused checks on pinned Node22.23.2. Root owns the original timeout probe rerun/removal, shared docs,
new common gates and helper artifact. Production scripts/tests freeze again after exact integration.
No issue09–11 commit/push or live mutation yet. Next full gate must use integrated sources, pinned
runtime, existing concurrency2 and TAP, with its own new log/session recorded here.

## Integrated final gate ACTIVE — 2026-09-05 07:56 Omsk

All reviewed09/11 follow-ups are integrated byte-identically; diagnostic copies and the root finite
timeout probe are deleted after validation. Actual09 focused tests passed3/3,30752.1ms; actual11
focused passed16/16,36970.4ms, with both parent and Bash child proven Node22.23.2. Original root
finite-timeout probe passed at1179ms versus former8136ms; its log remains
`artifacts/windows-fixture-timeout-probe-integrated-20260905.log`. No original assertion/deadline was weakened.

Integrated lint/check/secrets session58703 completed EXIT0:571JS,165handlers/106names,
1551tracked+92explicit candidates,848DockerCOPY. Log:
`artifacts/windows-lint-check-secrets-integrated-20260905.log`.

New full `npm test -- --test-reporter=tap` is RUNNING in exec session **10669**; log:
`artifacts/windows-unit-integrated-20260905.log`. Do not restart on resume. Node22.23.2 and existing
EASYBOOST_TEST_CONCURRENCY=2 are pinned process-locally. IMPORTANT: inherited Windows environment
has both PATH and Path; PowerShell prepend alone did not pin Git Bash. The launch wrapper clones
env, deletes every key whose lowercase is path, sets one PATH with pinned executable directory
first, then invokes npm-cli.js using the exact pinned process.execPath. Preflight proved Bash
`type -P node` resolves `/tmp/node-v22.23.2-win-x64/node` and versionv22.23.2. No global settings changed.
Sources/helpers/tests are frozen for this full gate. No final result, no09–11commits/push/live action yet.

New provisional helper artifact7ab70170 is canonically verified: bundle
`7ab70170bd696eed3be82a067e04faa379ff7d2c2398f7262a9cb10d86732701`, archiveSHA
`b7194b5492277c42e4ee8b79c28121a26d06f44166c9368c1c087691deb16f68`,172800compressed/904791expanded,
18files. Source root `C:/Users/Ригер/AppData/Local/Temp/easyboost-helper-package-20260905-7ab70170`
contains source/ and source.tar. All18 inputs match15raw b2 Git blobs plus3 exact workinghelpers;
compare all18 to implementation Git blobs after commit. Historical89b artifact is superseded;
its own separate packaging root remains until exact validated cleanup. Neither candidate is installed.

Frozen integrated source SHA256 values for final10669:

| File | SHA256 |
|---|---|
| scripts/staging-deploy.sh | 7a0e252e021ddb13e5e7614a3347ab37b567fd384216e8a8b15a44bac94ef2e7 |
| scripts/staging-release-common.sh | f667daac6d5bc94090f9f027160e2abc04209a26ad747ef4445288b9f8de6b3b |
| scripts/staging-rollback.sh | 85aeff1f0d81b575e9b7a78d767539b66291f89e93f51988d77ea9eded2fe153 |
| test/staging-deploy.test.js | 88643e141b6f5fdcbdca50086b6a95eb2bbf77e20785c957bccedb45c5988e4d |
| test/staging-rollback.test.js | b355d7d47717665494473dc0b39d1e1b861e3ada579e7db41bdbc0fea3fc8249 |
| test/staging-release-lock.integration.test.js | 66344fa073389a0ccece238addb960130cd75b089d5624dfbf2d28766433a337 |
| test/postgres-restore-supervisor.test.js | 5a37f72bd1bdab9ddedc036f8a19865d9083f7ad989132efae5d4dc5d8ca189f |

Early full-gate evidence: both new Windows fixture cases passed and the old watchdog identity
failure test passed at3070.2ms (previous failed run hit16068.6ms). No failure reported yet at08:02 Omsk;
operator workspace cases are proceeding. This is partial evidence, not a full pass. Read-only
ls-remote at08:01 confirmed authorized prototype branch is still b2b0b0fa; no intervening remote commit.

Final gate10669 remains active. It now passed all three previously failing scenarios under the
full runner: watchdog identity capture3070.2ms, unchanged finalizer structural test1.5ms, and
combined live/store/temp capacity17500.0ms (TAP2622). Low-upload refusal2624 also passed12838.3ms.
No `not ok` has been reported so far. The remaining operator scenarios still must finish; do not
claim full success or start commits from this partial milestone. Frozen7 hashes were rechecked
against this manifest and matched; no source changes, deploy, upload or new branch push occurred.

## Final integrated gate PASSED — 2026-09-05 08:58 Omsk

Session10669 finished EXIT0 and is CLOSED:3233tests,3132passed,101platform skips,0failed,
0cancelled,3720731.8831ms. All three old failures passed in this full run; no intervention occurred.
All7 frozen source SHA256 values were reverified afterward and match the manifest above. Lint,
syntax/handler checks, secret scan and independent reviews are also complete. Do not rerun the full
gate merely because context resumes. Working branch/HEAD remain authorized prototype/b2b0b0fa;
index is empty, unrelated/deferred untracked paths remain excluded. Next: explicit per-ticket
commits09/10/11, exact helper-package Git-blob proof, final secret/history checks, authorized branch
push and actual Linux CI. No upload/install/recover/cutover/deploy has occurred.
