# Native Linux lock diagnostic — CI124

Diagnostic preparation for ticket15. This does not fix a deployment or clear a release.
The separate workflow starts on relevant pushes to `prototype/aisy-today-visual-v1`, alongside
the unchanged canonical CI. Its existing `native-lock-diagnostic` job pins Node22.23.2, has a20-minute
job limit, uses only a read-only repository token, and neither installs packages nor accesses any
server or secret. The fixed test
and installed helper import closure use Node builtins/local modules; the existing fixture supplies
fake Docker/curl. Bash, Python3 and flock are provided by the same Ubuntu runner class as CI.

From the repository root on native Linux:

```sh
node --test .scratch/staging-v4-cutover/diagnostics/native-lock-profile.test.mjs
node .scratch/staging-v4-cutover/diagnostics/native-lock-profile.mjs
```

The runner accepts no arguments and launches exactly:

```sh
node --test --test-name-pattern '^real Linux flock excludes deploy and rollback through build, tree activation and recovery$' test/staging-release-lock.integration.test.js
```

All existing assertions, real-flock/PID checks,120000ms barriers and test cleanup are intact.
The original stdout/stderr pass directly through. The runner returns the test's numeric exit code;
a signal exit maps to the standard128+signal number without sending any signal. Diagnostic read
or output failures do not replace that result. The workflow's external20-minute cancellation can
still end the job before a test result; it is not a modified in-test deadline or a passing verdict.

The observer reads only `/proc/<owned-pid>/stat`, `cmdline` and `task/<owned-pid>/children`.
It anchors the direct child to its PID, parent and starttime; traverses only descendants listed
by a verified parent; and rechecks identity after reading each subtree. Reused, missing, invalid,
reparented or older identities are omitted. A changed anchor discards that whole snapshot.
There are no environment reads, process signals, filesystem writes or machine-wide PID scans.
Raw command data is used transiently to select fixed helper/tool categories and never serialized.
Only the first command/script positions are classified, including inherited `/proc/<owner>/fd/9`
executables. Categories name observed command positions; they do not authenticate executable bytes.

Bounds and interpretation:

- Sampling every1000ms, at most900 snapshots or15 minutes of observation. Reaching this limit
  stops observation while the original test continues. One pending sampling timer is cleared when
  the child completes; in-flight reads finish before the final report.
- Each snapshot visits at most64 processes and depth16, attempts at most512 metadata reads,
  and accepts at most4096 bytes per read (a4097-byte buffer detects truncation). There is one
  additional initial stat read. Truncated/missing data means incomplete coverage, not zero work.
- Cumulative category/count/timing reports every30 samples, an optional sample-limit report and
  one final report: at most32 lines of8192 bytes each (256KiB total), excluding the unchanged test
  output. Elapsed time in reports caps at1200000ms. No identities, paths, raw argv, environment,
  recovery records or arbitrary errors appear in the added output.
- `observations` counts observed processes per snapshot; `max_concurrent` is the largest count
  in one snapshot. `sampled_residency_ms` is observations times the nominal interval. It includes
  nested/overlapping parents and children, sleeping/waiting processes, idle supervisors, zombies
  and polling bias. Counts are observations, not total process launches. It is
  neither CPU time nor precise stage duration; it cannot by itself establish the CI124 cause.
- Processes shorter than the interval, forked by other threads, reparented between samples or
  hidden by metadata limits may be missed. Fixed stage categories can repeat during an operation.
  Compare successive cumulative reports with the original test's phase/barrier diagnostics.
  Sampling itself adds bounded work and can affect timing; this is not an uninstrumented baseline.

The public observation seams are `sampleOwnedProcesses` and `profileOwnedChild`. Focused tests use
finite synthetic children and a filesystem reader boundary for disappearing/reused PID cases.
`finite-child-harness.mjs` is a standalone finite test fixture, never a staging/real-flock launcher.
Its two enclosing test invocations have a5-second timeout and8KiB output cap to contain observer
regressions; this test-only containment is not present in the real diagnostic command.
The workflow runs these focused tests explicitly because they are outside the default unit glob.

Local verification is recorded in ticket15. Docker Desktop's exited-flock PID0 behavior is an
independently observed environment difference; its finite-child tests cannot establish native
GitHub full-scenario success. Run the unchanged complete scenario only through the native workflow.

## Bounded-command component baseline — ticket16

The early workflow step runs the following fixed Linux-only command and its focused contracts:

```sh
node --test .scratch/staging-v4-cutover/diagnostics/native-bounded-timing.test.mjs
node .scratch/staging-v4-cutover/diagnostics/native-bounded-timing.mjs
```

The command accepts no arguments. Its six operations match the already executed ticket14 chain
probe: one supervised `true`, four sequential `true` calls, one `true` under one extra supervised
Node, one under two extra Nodes, common `verify_helper_bundle`, and common
`validate_staging_compose_contract`. The latter two run under the real inherited Node chain.
Each run installs one real immutable helper generation/private Node using the existing hermetic
test fixture and its synthetic Docker/Compose data. The fixture's existing trusted command-path
substitution is reused only inside its temporary copy; tracked production files are unchanged.
Shell installer capability scanning and installed launcher/lock binding are outside this baseline.

The actual private executable is opened as fd9 by a live owner, using its computed digest.
Every measured command uses real `createPosixSessionControl`, `createPosixSessionInvocation`,
`runSupervisedCommand`, the production spawned wrapper and normal settlement. The timing wrapper
around invocation returns the original real object after checking descriptor/chain source and
executable digest. No authority, identity, publication or settlement result is replaced.

`control_ms` measures real control creation; `invocation_ms` measures complete authority capture
and invocation creation; `elapsed_ms` on component rows measures supervision including invocation
and settlement, excluding separately reported control creation. Operation totals also include the
descriptor-owner startup and all nested work. Nested timings overlap; they must not be summed.
There are twelve component rows: nine descriptor and three inherited-chain measurements. The
helper/Compose totals include their real common-shell nested calls without instrumenting them.

The added output is JSON with fixed category strings and numeric timings/status only: twenty
lines on success, at most twenty-one lines of512 bytes (10.5KiB). Child streams are captured with
a64KiB cap, validated, and never forwarded verbatim. No paths, identities, digests, raw arguments,
environment or error messages appear. Runtime/version/hash provenance is recorded separately in
the ticket. `component-only` explicitly marks scope; this is not the whole rollback reproduction,
CPU profiling, proof of a cause, or release clearance.

The six-row matrix shares one120000ms enclosing subprocess budget; each real supervised command
retains its60000ms component limit from ticket14. These are diagnostic bounds, not changes to any
production or original scenario deadlines. A numeric child failure is preserved; signal exits use
128+signal and an enclosing timeout reports124. The first failure stops the matrix. Output errors
cannot replace a child failure; an otherwise successful run with broken output returns1.

All synthetic writes stay in one newly created private `/tmp/easyboost-bounded-timing-*` directory.
Successful production settlement precedes cleanup. Cleanup verifies the root's directory identity,
owner, parent and prefix, inspects at most4096 entries/depth12 without following links, and makes
only owned directories writable before removal. Any failed or timed-out owner may have unproven
descendants, so its fixture and evidence remain untouched (`fixture_removed:0`); there is no
process-group/PID0 workaround or blind cleanup after failure. The enclosing runner/container
lifecycle bounds any such residual work. The focused contracts cover arbitrary-argument rejection,
real child failure23, replacement-root/link cleanup, the actual Linux matrix including cleanup,
and the real supervisor's early parent-identity refusal143 before its invocation callback runs.
The worker preserves a nonzero supervisor result before formatting optional timing measurements;
an absent invocation measurement cannot replace that original failure with a diagnostic exception.

This ordinary workflow step must pass before the existing observer checks and unchanged full
scenario run. A baseline failure fails the job and skips those later steps; it is never converted
to a green diagnostic verdict. The original sampler, full scenario, canonical CI and release gate
are unchanged. Local Docker Desktop component success cannot establish native GitHub timings or
full-flock success; ticket16 records local evidence, and root owns the subsequent native run.

## Reduced real rollback on a dedicated native runner — ticket18

The independent `native-rollback-only-diagnostic` job uses a standard GitHub-hosted `ubuntu-latest`
VM, Node22.23.2 and a6-minute total job limit. Checkout does not persist credentials; the workflow
grants only `contents: read`. The job has no container, services, secrets, dependency installation,
SSH, server/provider requests or artifact uploads. Its helper children receive the existing explicit
synthetic environment and fake Docker/curl, with no caller environment inherited. The only added
push paths are the exact two reduced diagnostic files below. The existing full diagnostic job and
canonical CI remain unchanged and independently report their own results.

From the repository root on the dedicated native Linux VM, the fixed steps are:

```sh
node --test .scratch/staging-v4-cutover/debug/ci126-rollback-only.test.mjs
node .scratch/staging-v4-cutover/debug/ci126-rollback-only.mjs
```

The focused contracts must pass before the real rollback runs as the last user-defined step.
The command accepts no arguments, creates its own private `/tmp/easyboost-ci126-rollback-*` fixture,
checks the reviewed synthetic post-deploy boundary, and invokes the real installed rollback launcher.
Its120000ms tree assertion, child status tracking and fixture inputs remain unchanged. Ticket19
extends only later observation to180000ms and the disposable diagnostic watchdog to330000ms.
Output retains separate barrier and settlement results;
raw child streams and authority values remain private. Ticket17 records the boundary proof and
the successful-deployment history omitted from this reduced attempt.

The fixed `cleanup: disposable-environment-lifecycle` label covers either the documented local
disposable container or this dedicated hosted VM. Fixture evidence and uncertain descendants are
retained for outer disposal, without signalling unknown processes or recursively removing an active
fixture. `helperCompletedCleanly` replaces the stronger `descendantsProven` label with the same
condition: clean helper completion. Launcher exit or pipe closure alone is not an independent proof
that all descendants have settled. GitHub provides a fresh
hosted environment per job ([runner documentation](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)).
That outer machine lifetime is separate from the production helper's own cleanup contract.

Ticket18 records the first native reduced result: the120second assertion failed after an observed
build-complete phase, and a further30seconds did not establish settlement. Phase names may recur
within one rollback, so that snapshot alone does not order progress against the original full
scenario's config-json-complete timeout. The known local attempt refused maintenance-lock
evidence at841ms with child125; it did not reproduce the120-second native timeout and is not repeated
here. Root owns the reviewed publication and one native result, including timing, stage, status and
settlement limits. A reached barrier, timeout, environment refusal or retained fixture is diagnostic
evidence; none establishes a production repair or deployment readiness.

## Reduced rollback phase progression — ticket19

The same fixed commands above run the extended diagnostic; there are no CLI arguments or environment
overrides. `observeRollback` is the shared orchestration used by that command and by finite-child
module contracts. Its initial tree observation uses the original120000ms default and freezes that
verdict before releasing the same `release-tree` fixture barrier. A late tree or child exit0 never
changes the failed assertion into success. The final result preserves a real nonzero child status;
an unsettled child with no known exit still reports124. Fixture preparation, helper invocation,
production guards and all original full-test/workflow deadlines remain unchanged.

The added phase sampler reads only the existing private `phase-tree` file and tree marker, at most
once per500ms. It reads at most128bytes and accepts only the original fake-Docker phase allowlist.
The existing file's modification time distinguishes sampled rewrites of the same value; that raw
metadata is never reported. A single `phase-timeline` row contains up to16 `{elapsedMs, phase}`
entries plus `omittedCount`. Changes seen after the cap continue incrementing that count. Invalid,
missing or truncated values do not become timeline entries. Fixed barrier/final snapshots are
separate from periodic sampling. Each JSON output row retains the2048byte cap; private child
streams remain capped in memory and are reported only as byte counts.

`settlement` separately reports `lateTree`, its first-observed time since rollback (or null),
`finalPhase`, elapsed observation time, launcher status and pipe closure. `lateTree: not-late`
means the initial snapshot already saw the marker. Observation waits up to180000ms after release,
stopping when pipes close; the330000ms outer process watchdog takes priority even during setup.
Both fit within the unchanged6-minute dedicated job. No signals, active-fixture recursive cleanup,
new supervisor or process profiler are added; the disposable environment still owns uncertain
descendants. Clean helper completion remains distinct from an independent descendant census.

These are sampled file states and rewrites, not exact phase durations, CPU work or invocation
counts. Writes faster than the poll, overwritten values and unchanged modification timestamps can
be missed. A final snapshot can show a phase absent from the bounded timeline. Extra observation
can affect timing and cannot establish a cause or make the native failure equivalent to the full
scenario. Ticket19 records focused RED/GREEN validation; root owns the next native result.
