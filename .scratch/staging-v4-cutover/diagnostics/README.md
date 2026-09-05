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
