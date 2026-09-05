# 22 — Measure remaining protected-boundary startup cost

Status: done
Blocked by: 21 — measured retained-pair composition and native outcome
Spec: .scratch/staging-v4-cutover/spec.md#measure-remaining-protected-boundary-startup-cost

## What to build

A finite, evidence-backed comparison of the remaining repeated protected-state checks, with
the smallest supported next optimization identified. This is diagnosis only, not a production
fix or another unchanged native/full-suite run.

## Scope and ownership

- Fresh worker owns this issue and, if needed, new
  .scratch/staging-v4-cutover/debug/ci131-protected-boundary-timing.mjs and its .test.mjs only.
- Read the final spec section fully plus applicable AGENTS/domain/tracker, implement,
  diagnosing-bugs, TDD and codebase-design instructions. Existing tests must never be weakened.
- Relevant implementation: staging-release-common's reverify_compose_authority,
  reverify_release_workspace, verify_space_reservations and callers in staging-rollback;
  existing staging-runtime-authority primitives. Prior fixtures/probes: native-bounded-timing,
  ci126-rollback-only, ci129-supervisor-cost and ci130-release-pair-timing. Locate exact files.
- Preserve the production bytes and all existing diagnostics/workflows. If the real finite
  fixture cannot be reused within this scope, report the exact obstacle before expanding it.
- First map/count the successful reduced pre-tree path (two archives, three reservations),
  explicitly source-derived with caller locations. Then measure real finite existing boundaries,
  three repetitions each, setup/disposal outside timing. Do not simulate successful validation.
- Cached offline Linux44f22c911346, nonroot uid1000, retained Node22.23.1 as recorded in the
  checkpoint. No pull/network. It differs from GitHub22.23.2 and cannot run the real flock bug
  because Docker Desktop reports PID0. Do not retry or relax that refusal.
- No full local suite, commit/push, VPS action, source-cache bypass or unproved process cleanup.
  Root owns shared spec/PROGRESS/checkpoint, fresh independent reviews, gates and publication.

## Acceptance criteria

- [x] Exact source-derived counts and uncertain paths recorded, no native-count claim.
- [x] Real guarded component baseline recorded for supported selected boundaries, with exact
      source/runtime provenance and retained validation; unsupported comparisons clearly stated.
- [x] Fixed finite diagnostic contracts demonstrate RED→GREEN, real nonzero status preservation,
      output bounds and refusal of arbitrary paths/commands.
- [x] Ranked hypotheses assessed from measurements; smallest next candidate and invariants
      reported without implementing production code or promising120s success.
- [x] Focused gates and frozen hashes recorded; root reviews and existing-gate applicability
      evaluated without repeating a full unchanged suite.

## Comments

Worker ci131_protected_boundary_cost claimed this diagnostic only. Implement/diagnosing-bugs/TDD/
codebase-design and workspace/server instructions were read; CONTEXT and relevant staging ADR
are absent. The spec explicitly refines the original120s feedback loop to finite real component
attribution; no exact-bug regression or production fix is claimed. Root owns review, gates,
commit/publication and shared progress. The agreed diagnostic seam is fixed invocation plus
finite real-child status and bounded observation reporting, not mocked successful validators.

### Source-derived successful reduced path (HEAD528f508)

The endpoint is first Compose `up` at staging-rollback.sh:293–294, where the existing fake Docker
creates the `tree` marker (test/staging-release-lock.integration.test.js:136–138). This is after
the live tree copy, so the checks at rollback:290 and292 are included. These are static counts,
not observed native invocations or sampled CPU time.

| Existing function | Call-site breakdown through that endpoint | Calls |
| --- | --- | ---: |
| reverify_compose_authority | validate_staging_compose_contract at rollback:222,253,290 =3; verify_active_snapshot at228,271 each calls it directly (common:1164), through validate (common:1173→910), and through verify_running_image (common:1176→1125) =6; rollback:292 =1 |10|
| reverify_release_workspace | create_release_workspace (rollback:196→common:478) =1; four freeze cp/chmod (rollback:211,213,233,235) =4; reserve_release_space (241→common:789 plus reserve_file fallocate/chmod for three reservations plus verify_space_reservations) =8; two temporary consume_reservation truncate (243,247→common:698) =2; two mkdir (244,248) + two archive extract (245,249) =4; candidate chmod (256) =1; explicit reservation checks (257,276) =2; prepare-copy (282), live consume (285), clear (286), copy (287) =4 |26|
| verify_space_reservations | reserve_release_space (common:805), rollback:257,276 |3|
| verify_release_pair | validate_release_store loops over two archives; explicit previous/target pair; two verify_active_snapshot |6|

Function bodies: compose reproof common:1135–1139 has three guarded Node calls; workspace reproof
common:481–492 has guarded verify-runtime plus guarded stat (protected_identity_record:383),
alongside unsupervised `stat`×3 and `id`×1 in verify_protected_path with ancestors disabled.
Reservation reproof common:707–723 includes one workspace call, then guarded record-field and
verify-reservation per each of three reservations. Thus the selected functions account for
10×3 +26×2 +3×6 =100 distinct guarded starts, avoiding double counting nested workspace calls;
26×4 =104 direct stat/id invocations are a separate static quantity. This is not the total
transaction command count. Standalone runtime checks, captures, image/PG/tree/archive/store,
lock/startup and transaction-marker work outside these three functions remain outside this sum.
Failure/recovery, readiness retries, other retained inventories and empty reservation branches
are excluded; timing samples cannot prove those paths were absent on a native runner.

### Real installed guarded baseline

One successful offline run; nine whole-operation observations, three per selected function:

| Operation | Guarded starts per call, static | Repetition1 ms | Repetition2 ms | Repetition3 ms | Median ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| reverify_compose_authority |3|1023.05|1006.80|1037.12|1023.05|
| reverify_release_workspace |2 plus4 direct stat/id|647.96|704.79|703.88|703.88|
| verify_space_reservations, including workspace |8 plus4 direct stat/id|2730.42|2651.88|2727.75|2727.75|

All operation and fixture statuses were0. Timers use Bash EPOCHREALTIME immediately around the
unmodified shell functions; output and setup/capture are outside timing. These are wall times,
not CPU profiles or individual startup durations. The owner is a real inherited descriptor/Node
chain created by the installed supervisor, and run_bounded is never replaced. Every command's
existing60s guard remains; the fixture shell has90s aggregate bound inside the diagnostic120s
budget. The final diagnostic additionally has an outer120s watchdog; this was added after the
successful measurement without changing any timed body, fixture, installed guard or production
byte. Its focused contracts/syntax/lint were rerun. No unchanged component or native retry followed.

The fixture reuses ci126 prepareFixture + verifyFixture, including two real small canonical
retained pairs and exact protected runtime files/directories. It calls the real existing
bind_release_runtime_authority, create_release_workspace, reserve_release_space and
begin_release_transaction outside timing. Reservations are three genuinely allocated67108864
byte files, mode0600, not sparse stand-ins; zero expanded-byte arguments select the unchanged
minimum-headroom case. Every measured reservation call checks all three files. The transaction
marker is present (the real synthetic transaction marker); the absent-marker alternative used
by five of the ten static pre-tree Compose reproofs was not separately measured. There is no
release-tree/rollback execution, Docker call, cache or successful-validator replacement here.

Fixture transformations are exactly the existing prepareHermeticHelperInstaller transformations:
its private staging-helper-bundle.js binds TRUSTED_SHELL_PATH to the private fake-command
directory followed by the original system PATH; its installer shell binds the private Node
directory, although this probe installs through the existing Node bundle installer. Private
Node copies preserve the pinned bytes. The fixture's synthetic docker/curl/sleep files and
synthetic release payloads are those supplied by ci126; the selected protected checks do not
invoke those fake commands. Installed production helpers other than the established private
helper-bundle PATH binding are compared byte-for-byte to repository scripts, and the installed
manifest/generation is independently verified before execution. The measured installed digest
below is therefore a private hermetic fixture generation, NOT an installable production bundle.

The settled installer-input Node copy alone was removed after owner/type/single-link/digest and
distinct-inode checks, following ci126, to leave room for192MiB reservations in512MiB tmpfs.
The remaining private fixture, including transaction marker and reservations, was retained for
disposable-container retirement. Docker --rm exited0 and retired the container. No host fixture,
unproved descendant, production marker or process was deleted/signalled.

Provenance:

- Source HEAD:528f50889385775f27e53540cd22167e7c738f0d.
- Cached image:sha256:44f22c911346d64eb74edc2af1355825d17d70d91c4fb30294581596293b2360.
- Runtime:v22.23.1,124835376 bytes,
  SHA25693956de2e59480474a7b46571da1651180b1a050cdf32641ebec4ce6e478e068.
- Private installed fixture bundle:
  fe8df3ed17ccf6035741489a24a6ffbe7bfd413fd0eed929f28d7c77d4bd10b1.
- staging-release-common.sh:
  edf1f40f425641f2c94c95d6596bd289ae83a039649278412b1bf205c1f7dd0b.
- staging-runtime-authority.js:
  0e3890198ac8c1fbc7bdd9d091402af01c4cf487d43a3372c626094d7e973cb4.
- staging-rollback.sh:
  85aeff1f0d81b575e9b7a78d767539b66291f89e93f51988d77ea9eded2fe153.
- Reused ci126-rollback-only.mjs:
  e9162cbaef0dcad230d32a8d6f285622260829c13d9d36cd06d34951bd6a633f.
- Reused staging-release-lock.integration.test.js:
  43dd8ee425838d038d317930ba18d61add82bbe94b382aa9ef6c35454bfbfb93.

Exact successful PowerShell invocation from server root (Docker permission initially required
the existing authorized sandbox escalation; image was already cached, no pull/download):

```powershell
& 'C:\Program Files\Docker\Docker\resources\bin\docker.exe' --context desktop-linux run --rm --pull=never --network none --read-only --user 1000:1000 --tmpfs '/tmp:rw,exec,mode=1777,size=512m' --mount 'type=bind,source=C:\Users\Ригер\Desktop\Repetotor\Приложение репетитор\server,target=/workspace,readonly' --mount 'type=bind,source=C:\Users\4FE4~1\AppData\Local\Temp\easyboost-ci124-linux-runtime-08f4c66031ef4de6ab02c402b93fd3d6,target=/runtime,readonly' --workdir /workspace 44f22c911346 /bin/bash --noprofile --norc -c 'set -eu; cp /runtime/node /tmp/node; chmod 0755 /tmp/node; exec /tmp/node .scratch/staging-v4-cutover/debug/ci131-protected-boundary-timing.mjs'
```

### Hypotheses and smallest supported next candidate

1. Repeated protected checks are material: the three selected calls take approximately1.02,
   0.70 and2.73 seconds, and roughly scale with their3,2 and8 guarded starts. This supports
   investigation of repeated startup, consistent with ticket20's inherited-chain component.
   It does NOT isolate useful filesystem cost versus startup or prove dominance: no equivalent
   one-process protected-state implementation was executed in this diagnosis.
2. Reservation parsing adds six guarded calls beyond its nested workspace reproof: one
   record-field and one verify-reservation per file. The measured reservation operation is
   materially larger than workspace alone. Across three static reservation reproofs there are
   nine record-field starts and nine verification starts, plus their already-counted workspace
   calls. A purpose-specific reservation composition is supported as a later candidate, but
   its improvement has not been measured.
3. Unrelated-operation archive-module import cost remains unmeasured. ci130 has a verified
   pre-ticket21 pair comparison but does not expose an equivalent unrelated operation in that
   exact installed generation. No mixed generation or repository-source modification was used
   to invent that comparison.

The smallest safest next candidate is one purpose-specific Compose-authority reproof that reuses
the exact three existing runtime-authority primitives in their existing order. Ten static calls
would become ten guarded starts instead of30:20 avoided starts, not a measured20-second saving.
The current approximately20-second native barrier gap cannot be assumed to disappear; require a
real finite before/after comparison and the unchanged original native120s feedback after any fix.
Root may choose a coherent further group only in a separately specified ticket.

Required Compose invariants: reverify protected app/backups/rollbacks/store directory owner,
mode, type and captured identity; re-read and reprove environment and lock identity/bytes;
then verify active marker optional presence, mode0600,65-byte bound and captured identity/bytes;
then transaction marker optional presence, mode0600,4096-byte bound and captured identity/bytes.
Keep no-follow, single-link, open/fstat/final-path reproof and JSON authority equality from the
existing implementations. No cache, held descriptor across separate invocations, check removal,
new caller-controlled command list or deadline increase is justified. Preserve missing-authority
failures and ordering: each current wrapper first rejects an empty capture with1; a failed
supervised proof sets authority_violation=1 and returns1. Do not turn timeout/infrastructure
failure into success or silently change the authority_violation/recovery mapping. Preserve all
call sites, transaction placement and caller fail-closed status mapping.

Reservation follow-up must retain three known file/record associations, minimum-headroom checks,
full capture JSON equality, owner0600/no-follow/single-link metadata and actual allocated-byte
proof (size and blocks×512), plus the existing preceding workspace reproof and its failure flag.
Missing record/field, underflow, invalid numeric capacity, drift and nonzero guard status must
continue failing closed. Workspace composition has a separate compatibility concern: its record
is GNU stat '%d:%i:%f:%u:%g:%a', also used by staging-cutover.sh:712,1029. No assumption that Node
and GNU stat encode mode/device/inode identically on Windows/Git Bash is justified by this Linux
baseline, and no cutover record-format change is proposed.

### Initial focused verification and freeze

RED→GREEN was executed in three vertical slices with pinned Windows Node22.23.2:

- Real finite child exit23 initially failed because the new module was absent, then passed
  through the existing requireComponentSuccess; valid-looking child output cannot mask23.
- Three-row parsing initially failed with undefined result, then passed exact count/order/
  operation and finite0–60000ms contracts,1024-byte group bound, malformed/oversized output,
  unexpected stderr, and timeout-result status124.
- Fixed CLI refusal initially returned0 instead of64, then passed for arbitrary path, command,
  environment option and attempted internal-owner mode. Public CLI accepts no arguments and
  builds a fresh fixed environment for its real children.

Initial contracts: Windows3/3 (0failed,0skipped;440.1307ms) and offline Linux3/3 (0failed,0skipped;
404.437123ms). Linux used the same cached container/runtime with only `--test` added to the fixed
Node invocation; no component timing was repeated. Both new .mjs syntax checks passed. ESLint
was explicitly applied with this repository's five Node rules/globals to both .mjs files:
2files,0errors,0warnings (the ordinary repository config targets .js). Scoped diff check passed.
Tracked production/tests/workflows/package diff is empty. Existing full3262-test gate and native
CI applicability remain root-owned; no unchanged full suite was rerun by this worker.

Initial frozen diagnostic SHA256, before the root reporting correction below:

- ci131-protected-boundary-timing.mjs:
  d9b2425eed0ed16476d37c71de79c285080be43f79606bb3d261398ece16b32e.
- ci131-protected-boundary-timing.test.mjs:
  eb22054134d9df3b4b2683cdc749d3f7d08988ad96e67f56d2f938cc1faf7a28.

Worker scope is complete and frozen for root review. Status remains in-progress until root's
independent reviews/gate-applicability decision and owned publication. No production change,
commit/push, existing-test edit, source-cache bypass, browser/VPS action or deployment occurred.

### Root finding: report-write failure must not mask child failure

Independent Spec and Standards reviews of the initial freeze each reported0 findings. Root's
additional review then identified an uncovered reporting defect: after a real child23,
baseline's catch block could call report, encounter EPIPE, and escape with an unhandled error
instead of retaining23. The independent0/0 results did not establish this contract. Root asked
for this bounded diagnostic-only correction, analogous to ticket20's existing report seam.

The actual finalization/reporting seam is now reportBoundaryRows(status, rows, writer). It is
used by baseline success and failure, the120s watchdog, and fixed CLI refusals64/69. It catches
writer failure without printing/serializing the Error: an existing nonzero status remains
unchanged; success0 becomes1 when its report cannot be written. In particular real child23
remains23, watchdog124 remains124 and refusal64/69 remain64/69. The production timing functions,
fixed operation list, child commands, guards, deadlines and fixture setup are unchanged.

RED→GREEN: first extracted the actual unguarded report loop into this seam and added one
finite-child regression. Windows run was3pass/1fail: real child23 reached the throwing writer,
and EPIPE escaped. Catching only the reporting failure then made4/4 pass. The regression runs
real finite Node children with statuses23 and0, injects the failing writer, and also checks
124/64/69 preservation and normal successful reporting. No raw writer-error detail leaves the
fixed code path after the correction.

Corrected focused gates: pinned Windows22.23.2 tests4/4,0failed/0skipped,482.1757ms; cached offline
Linux22.23.1 tests4/4,0failed/0skipped,434.926246ms. Both .mjs syntax checks passed; explicit
repository five-rule Node ESLint reports2files,0errors,0warnings; scoped diff check passed.
The three production hashes above are unchanged and tracked production/test/workflow/package
diff remains empty. No component timing, rollback, full suite, commit/push or VPS action was run.
The earlier nine measurements remain evidence from before this reporting correction; they are
not represented as a new run of the final diagnostic file. Root owns final review/publication.

Current frozen diagnostic SHA256:

- ci131-protected-boundary-timing.mjs:
  40bf8db067893232447d5947f9f736ea88c0ef9b1b88cb37e22811c9fd635ab4.
- ci131-protected-boundary-timing.test.mjs:
  f517da412b577ec8ed12b790ecdb6b4df0126bcf1f54cc9a816361cb3d9d540f.

### Root acceptance and gate applicability

Fresh independent Spec and Standards delta reviews each returned0 actionable findings after
the reporting correction; root read the complete final code/test and verified the shared seam.
Root pinned Windows22.23.2 combined diagnostic contracts:12total/9pass/3Linux skips/0fail,
545.4488ms. Explicit .mjs ESLint2files passed. Ordinary lint and direct pinned syntax/handler
checks passed (572JS files,165handlers,106names). Candidate secret scan passed:1579tracked+
16explicit,1583unique files,848Docker COPY inputs. Scoped diff checks passed.

Tracked production/default tests/workflows/package files are byte-identical to528f508, including
the original120s lock test and all inherited-chain guards. The completed ticket21 Windows
gate3262/3153pass/109skip/0fail therefore remains applicable to those unchanged inputs; the
four new .mjs diagnostic contracts are separately executed above and are outside default
unit discovery. No redundant unchanged72-minute suite was started for this diagnosis-only
ticket. This applicability does not turn failed native/CI feedback into success.

Canonical CI129 on528f508 finished with the sole original tree timeout:3234tests/3170pass/
1fail/63skip, PostgreSQL51/51; full outcome is recorded in issue21. Ticket22 completes only
the measured attribution and supported-next-candidate deliverable. Root records this as a
local diagnostic commit and defers its push until a separately specified production repair,
so no unchanged full GitHub run is triggered solely by these measurements. No new archive,
VPS upload/installation/recovery/cutover/deploy or removal of original recovery input occurred.
