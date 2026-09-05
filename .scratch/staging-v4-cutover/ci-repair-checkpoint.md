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
ticket 07 as `d173c64`; ticket 08/coordinator evidence are being committed next. Publish only to the
authorized `prototype/aisy-today-visual-v1` branch and verify Linux CI before owner deployment.
Pinned canonical producer is available locally at
`C:/Users/4FE4~1/AppData/Local/Temp/node-v22.23.2-win-x64/node.exe`: verified Node 22.23.2,
zlib 1.3.1-e00f703. New helper candidate `easyboost-staging-helper-bootstrap-aa670f75.tar.gz` is
inspected and source-tree verified (SHA `4a83eb274a143263f0ba3c3d09118da76746144f4b21ba460ecd71e659bd94b6`).
All 18 packaged files match exact Git blobs at `d173c645a1dec4c8e83316350927ec700b218410`;
the following fixture-only ticket does not change those files. Recheck against final HEAD before push.
Its owned source staging directory is `C:/Users/4FE4~1/AppData/Local/Temp/easyboost-helper-package-20260905-y5rfy5`;
remove only that exact validated temporary directory after comparison. The old 944b9b8/323d5cb
bootstrap is stale. No live server mutations or push yet.

## Additional deployment prerequisite found read-only

Staging `/tmp` is 982 MiB tmpfs with 778 MiB observed free. Current helpers hard-code large release
workspaces under `/tmp`; their unchanged admission calculation for the known b407 candidate + legacy
bridge requires 900201716 free bytes after frozen archive copies. See server-baseline.md for the exact
inputs. Do not attempt the real UI deploy or claim it ready on this host solely from green CI. After
the current CI repair, recompute with the exact candidate and address a disk-backed private workspace
or owner-approved host configuration without weakening the capacity guard. No implementation/mount
change has been made for this separate precondition; tickets 06–08 remain frozen.
