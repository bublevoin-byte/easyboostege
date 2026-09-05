# 17 — Reach the original rollback barrier without repeating a successful deploy

Status: done
Blocked by: 16 — native component comparison received; two isolated native failures preserved
Spec: .scratch/staging-v4-cutover/spec.md#rollback-only-feedback-loop-minimisation--native-diagnostic2

## What to deliver

One bounded local diagnostic attempt to remove the successful deployment prefix from the exact
rollback/tree failure. Deliver the fixed invocation, measured outcome and explicit fixture-equivalence
evidence. This is feedback-loop minimisation, not a production repair or deployment clearance.
If the prefix is load-bearing or the environment refuses the reduced scenario, record that concrete
result; do not invent a passing replacement or repeat the whole known Docker Desktop failure.

## Scope

- Reuse existing hermetic release, installer and fake-Docker seams; invoke the real installed
  rollback launcher and unmodified authority, supervision and settlement modules.
- Directly prepare the equivalent post-deploy synthetic candidate state, both retained canonical
  archives/sidecars, exact image/container/release fixture mapping and protected permissions.
- Check the inputs at the boundary before starting rollback. Preserve the original120000ms
  tree-barrier bound and explicitly distinguish the barrier verdict from cleanup/child exit.
- Fixed command, isolated temporary root, finite resource/output bounds, no raw inherited environment
  or authority output. No forced cleanup of unproven descendants or outside owned fixtures.
- Local Docker Desktop has known post-exit flock PID0 behavior; do not accept0 or bypass it.
- No production/test/workflow/sampler edits, dependencies, VPS, network, commit or push by worker.

## Files

- `.scratch/staging-v4-cutover/debug/ci126-rollback-only.mjs` — local diagnostic attempt.
- `.scratch/staging-v4-cutover/debug/ci126-rollback-only.test.mjs` — focused observable contracts.
- This ticket — attempt, timings, equivalence and limitations.
- Root alone owns shared spec, PROGRESS, checkpoint and subsequent publication decisions.

## Definition of Done

- [x] Fixed runnable command and scope/limits documented.
- [x] Synthetic post-deploy input equivalence proved or concrete non-equivalence recorded.
- [x] Cached Linux attempt and exact verdict recorded without calling an environment refusal the bug.
- [x] No existing product, script, test or workflow inputs changed.
- [x] Focused syntax/lint/tests and independent two-axis review completed.
- [x] Root common gates/commit decision recorded; existing full-suite evidence reused only where valid.

## Local answer — 2026-09-05

The prepared rollback boundary passes its checks. One actual invocation of the real installed
rollback launcher then refuses the local maintenance-lock evidence after841ms, with child exit125:
`staging maintenance exclusive lock is not held` (47stderr bytes including newline).
No120-second rollback timeout was reproduced. The last phase is `child-started`, with no tree
or activation count. This is a local authority refusal consistent with the already recorded
Docker Desktop exited-flock PID0 limitation; this attempt did not independently resample PID0.
No production cause, repair, native equivalence of process history or deployment clearance is claimed.

Only the two new debug files and this ticket were edited by the worker. Existing product/scripts,
tests, workflows, diagnostics and shared progress/spec/checkpoint were not changed by this work.
Root retains independent two-axis review, common gates, publication and commit ownership.

### Fixed runnable command

Run from the server repository in PowerShell. This uses the existing cached image and retained
Node22.23.1 file; no pull, install or network is involved. Both host bind mounts are read-only.

```powershell
& 'C:\Program Files\Docker\Docker\resources\bin\docker.exe' --context desktop-linux run --rm --pull=never --network none --read-only --user 1000:1000 --tmpfs /tmp:rw,exec,mode=1777,size=512m --mount 'type=bind,source=C:\Users\4FE4~1\AppData\Local\Temp\easyboost-ci124-linux-runtime-08f4c66031ef4de6ab02c402b93fd3d6,target=/runtime,readonly' --mount 'type=bind,source=C:\Users\Ригер\Desktop\Repetotor\Приложение репетитор\server,target=/workspace,readonly' --workdir /workspace --entrypoint /usr/bin/bash 44f22c911346 --noprofile --norc -c 'cp /runtime/node /tmp/node; chmod 0755 /tmp/node; /tmp/node --test .scratch/staging-v4-cutover/debug/ci126-rollback-only.test.mjs && /tmp/node .scratch/staging-v4-cutover/debug/ci126-rollback-only.mjs'
```

The diagnostic accepts no command/path arguments, inherits no caller environment into children,
and creates a new `/tmp/easyboost-ci126-rollback-*` fixture. The setup installer uses a40-second
settlement bound. The original tree assertion retains120000ms; later settlement has a separate
30000ms budget. An outer210000ms watchdog ends the diagnostic itself. Child buffers are capped
at64KiB per stream, structured output lines at2048bytes; raw environment, authority and child
streams are never emitted. No command group or unknown descendant is signalled.

Private evidence and fixture state remain intact until the disposable container terminates;
the diagnostic does not claim recursive cleanup or descendant settlement based on a failed
launcher's exit alone. Outer container teardown removes this disposable tmpfs. No host fixture
or Docker application/database volume is writable or removed.

### Post-deploy boundary proof and limits

| Original rollback input | Preparation and executed check |
| --- | --- |
| Active candidate tree and marker | Reused original `release(root, 'candidate', 'candidate')`; extracted its real canonical archive; actual `verifyReleaseTree` checks exact file inventory and bytes; candidate SHA marker exact65bytes. Original current tree is absent. |
| Post-copy file modes | Four candidate payload files0444, app directory0700, matching deploy's `chmod -R a-w`, directory-only `prepare-copy`, and `cp -a`. Linux checks owner, type, mode, and single-link file identity. |
| Both retained release pairs | Current and candidate canonical archives copied under `rollbacks/releases/release-<sha>.tar.gz`, each with exact `<sha>\n` sidecar; all four files0600. Checks enforce exact store inventory, independent SHA-256 of retained bytes, and real archive/tree verification against both original source fixtures. |
| Protected runtime metadata | App/backups/rollbacks/releases0700; environment, marker, stable empty release-lock inode, and synthetic backup0600. `.env.staging` is exactly the original synthetic `APP_PORT=3001\n`. |
| Active image/container | Both state files contain the original `candidateImageId`. Direct calls through the unchanged fake-Docker factory return that image for the stable tag and running app container. |
| Temporary release reference | `RELEASE_STATE` absent, as after successful deploy finalization. Direct fake-Docker inspection of both current and candidate temporary tags exits1 with empty output. Seeding candidate there would create an unrelated rollback refusal. |
| Recovery and reservation residue | No recovery marker, host-operation directory, rollback work directory, live/store reservation or transaction-control residue is seeded. Store, backups and rollback directories have exact expected entries. No fake retired authority namespace is introduced. |
| Immutable generation and Node | Original hermetic installer preparation binds only its existing fake command directory. The real helper-bundle `install` CLI publishes one immutable generation and launcher; real `verifyInstalledHelperGeneration` succeeds. All generation payloads except the existing fixture's trusted-PATH adjustment are byte-compared against repository scripts. The installed private Node hashes identically to its input and has a different inode. |

Only after installer exit0 and that private Node independence proof is the preparer's own
`node-authority/node` source copy unlinked and its empty directory removed. This frees119MiB
inside512MiB tmpfs for the real three64MiB rollback reservations. The installed private Node
and original read-only runtime mount stay available; no installed runtime bytes are changed.

Removed history is explicit: no successful deploy, shell installer's host-admission probes or
second idempotent install. The emitted real rollback launcher still performs its full original
authority and generation checks. The synthetic backup has the same bytes and protection but a
fixed inert timestamp/PID in its name. Old build barrier, build phase, Compose invocation log and
curl counter are not reproduced: rollback uses `BLOCK_AT=tree` and reset `up-count`; the fake curl
counter only increments and cannot change success. The rollback fixture never enables the later
recovery scenario's `FAIL_CANDIDATE_READY`. Fresh inode identities and process/retirement history
are necessarily different. Local refusal before transaction work means this history removal has
not been proved non-load-bearing on native Linux. No native publication is part of this ticket.

### Measured single attempt

The command above completed; no background session remains. At that point the three original
focused diagnostic contracts passed on Linux (187.221ms total). Measurements:

| Boundary | Measured result |
| --- | --- |
| Installer |462ms, exit0, stdout139bytes, stderr0bytes |
| All prepared-input/generation/fake-Docker checks |807ms from diagnostic start |
| Real rollback/tree verdict |841ms from rollback start, `environment-refusal`, child exit125, no signal |
| Exact evidence |`lastPhase=child-started`, `upCount=missing`, `tree=absent`, stdout0bytes, stderr47bytes;120000ms deadline not reached |
| Settlement |Already closed, additional wait0ms, total841ms from rollback start; descendants not proved, private fixture retained for container teardown |

The first diagnostic process incorrectly mapped child125 to CLI1 while preserving child125 in
its JSON. Root review identified that result-mapping defect. The final implementation now uses
one tested completion function for both the installer and rollback: settled nonzero child status
is preserved, POSIX signal termination maps to128+signal, unknown/unsettled result remains124,
and a failed barrier followed by child0 remains1. Known failure/signal is preserved even before
inherited pipes close. The measured full invocation above predates that mapping
repair; it was not repeated merely to encounter the same environment refusal again.

### Focused validation and handoff

`implement`, `diagnosing-bugs` and `tdd` were applied at the specified diagnostic command,
fixture-boundary and result-preservation seams. Root's explicit scope retains common/full gates,
review and commits. Phase1 remains incomplete for the native bug because this local command has
not reached the original failure. No hypothesis or production optimization was selected.

- RED/GREEN: argument rejection initially1 instead of64; fixture and exact timeout discriminator
  initially unavailable; all passed after their respective implementations.
- Real child result seam: a finite child exits23 with private stderr; its result survives both
  diagnostic verdict and installer failure handling without emitting that stderr. On Linux a real
  child terminates itself with SIGTERM and preserves143. These were added after root's mapping
  finding; the missing seam went RED before implementation.
- Final focused suite: pinned Windows Node22.23.2 has4pass/1POSIX skip (269.232ms); cached Linux
  Node22.23.1 has5pass/0skip (214.315ms). The second Linux container ran **only these tests**,
  with the same read-only mounts and no real rollback retry.
- New `.mjs` syntax checks and explicit repository ESLint rules pass. Existing product, script,
  test and workflow diff remains empty for this ticket; no hour-long full-suite repeat was run.
- Independent two-axis review, final common checks and commit decision remain with root;
  status stays in-progress until those obligations are recorded. The existing3241-test Windows
  full-suite evidence may cover only byte-identical existing inputs, not native rollout readiness.

### Independent review follow-up

Standards initially0. Spec identified one P2: the launcher can exit while its descendants still
hold stdout/stderr open. Recording only `close` can hide a real exit23 as null/124 and misclassify
the original timeout. A real Linux finite child/grandchild regression went RED with that exact
result, then GREEN after separating `exit` from stream closure. The actual observer used by the
rollback now stops on known exit; its snapshot preserves23 with `closed=false`, and cannot label
an exited launcher a matching timeout. The finite descendant ends naturally after1800ms before
fixture-only test cleanup; no forced signal or rollback retry was used.

Final worker focused validation: Linux6/6pass2058.459ms; Windows6tests/4pass/2Linuxskip264.405ms.
Both syntax checks, explicit repository-rule lint and whitespace checks passed. Corrected hashes:
diagnostic dd2acc814a2a5fc0763c6ca87d6bfde55d51fc6f4ff1b7d3c5346373dbb323af;
test82ffd5694713ce203e0dafb0e9335d76a6702748bf394b8beaf91fa874c3c902.
Independent final re-review and root gate/commit are pending below, not claimed from this worker result.

### Root completion

Final Standards0 / Spec0 after the P2 correction at the exact hashes above. Fresh root focused
contracts plus existing20release/progress consumers:43tests/37pass/6Linuxskip/0fail1882.4667ms;
explicit diagnostic ESLint2filesPASS, full repository lint/checkPASS(571JS,165handlers/106names),
scoped secret scan1567tracked+4explicit candidatesPASS, whitespacePASS. Existing product/scripts,
tests, package inputs and both existing workflows remain byte-identical toabd0e89. The completed
3241-test Windows suite(3140pass/101skip/0fail) is reused only for those unchanged inputs.
Root approved this ticket's local rollback point on the authorized prototype branch; native
execution remains a separate ticket. Original native failure and deployment block remain open.
