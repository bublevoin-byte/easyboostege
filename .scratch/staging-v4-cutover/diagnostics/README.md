# Native Linux lock diagnostic — CI124

Diagnostic preparation for ticket15. This does not fix a deployment or clear a release.
The separate workflow starts on relevant pushes to `prototype/aisy-today-visual-v1`, alongside
the unchanged canonical CI. It pins Node22.23.2, has a20-minute job limit, uses only a read-only
repository token, and neither installs packages nor accesses any server or secret. The fixed test
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
