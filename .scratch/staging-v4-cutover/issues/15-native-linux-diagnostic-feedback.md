#15 — Наблюдать проблемный Linux-сценарий отдельно от полного CI

Status: done
Blocked by: 14 (bounded local profile completed; native full scenario limitation recorded)
Spec: .scratch/staging-v4-cutover/spec.md#native-linux-diagnostic-feedback--ci124

## Что сделать

Add one separate bounded native-Linux diagnostic job which runs the unchanged exact failing
real-flock integration scenario and emits a small read-only profile of its owned child stages.
This is diagnostic feedback, not a deployment fix and not replacement release clearance.

## Границы и файлы

- Exclusive writes: .github/workflows/staging-lock-diagnostic.yml,
  .scratch/staging-v4-cutover/diagnostics/ (small runner, focused tests, usage/limits), this ticket.
- Canonical .github/workflows/ci.yml, all production/scripts, existing test files and package/lock
  files are read-only. Root owns spec, PROGRESS and checkpoint.
- Workflow only authorized prototype/aisy-today-visual-v1 branch pushes, relevant paths; Node22.23.2,
  contents:read, no secrets/network tools/SSH/deploy. Existing action setup/npm ci conventions may
  be reused in CI; no new dependency or local downloads. No commit/push from worker.
- Use unchanged existing test via fixed exact --test-name-pattern. No edited fixture/helper copy,
  skipped assertions, retries, permissive PID0 parsing, original120s deadline change or fake clock.
- Observation only: bounded Linux /proc sampling of proven descendant identities of that owned
  test child. No signals, no environment reads; allowlisted category summaries only, no raw argv,
  sensitive paths or JSON recovery authority. Preserve original test exit result and cleanup.
- Prefer a small purpose-built runner; no generic tracing framework. Output/count/timer bounds and
  limitations explicit. Sampled nested residency is not CPU time or a causal diagnosis.
- Read implement/TDD/diagnosing-bugs; tests at actual observation/aggregation seam before changes.
  No full suite from worker, no new agents; root coordinates independent reviews/common gate.

## Definition of Done

- [x] Separate bounded workflow does not alter the canonical CI or deploy any environment.
- [x] Exact existing failing scenario/assertions/guards/deadlines remain intact.
- [x] Focused tests prove output bounds, category-only reporting, identity/missing-process safety,
      original failure status and timer completion with a finite child.
- [x] Exact local commands/results and Docker Desktop full-scenario limitation recorded.
- [x] Independent Standards/Spec reviews and root integration gate before scoped publication.

## Incoming evidence

CI1247dd3677:3213tests/3151pass/1fail/61skip/0cancel; only2736 failed452274ms.
First deploy reached build107453ms and exited0 at329976ms. Rollback120007ms snapshot lastphase
config-json-complete, upCountmissing, treeabsent, stdout/stderr empty. Config may repeat.
Ticket14 direct/nested real bounded commands pass locally; no actualCIcause proved.

## Implementation and focused evidence — 2026-09-05

Worker implementation complete; status remains in-progress pending root-owned reviews,
integration checks and the scoped commit. No production fix or native full-scenario result claimed.

Files: separate `.github/workflows/staging-lock-diagnostic.yml`; diagnostic-only
`native-lock-profile.mjs`, `native-lock-profile.test.mjs`, `finite-child-harness.mjs` and README
under `.scratch/staging-v4-cutover/diagnostics/`; this ticket. Canonical CI, production scripts,
existing test and package files have no worker changes. `CONTEXT.md` is absent and no relevant
release ADR exists (current ADRs cover frontend and learner authentication/payments).

The fixed CLI preserves the exact real-flock test invocation/result. The observer has no command
arguments, signals, environment reads or writes; category summaries only. Limits:1s sampling,
900 snapshots/15m observation,64 processes/depth16,512 reads per snapshot/4096 accepted bytes
each; at most32 added8KiB report lines. The workflow independently ends after20m and executes
the diagnostic self-tests explicitly. No npm installation is required: inspected imports of the
existing test and its complete helper-bundle closure use only Node builtins and local modules.
The supplied fake Docker/curl remain part of the unchanged fixture.

TDD executed at agreed observation/aggregation seams:

- Initial category test was red with missing runner module; implementation made it green.
- Helper-looking data argument case was red (`runtime-authority` instead of `sleep`); constrained
  executable/script-position classification made it green.
- Finite-child failure/report test was red with missing observer export; implementation preserved
  status23 and produced the bounded final report.
- Actual inherited `/proc/<positive-owner>/fd/9` helper category was red (`unknown`); recognizing
  this executable shape made it green without serializing the descriptor path or owner PID.
- Additional safety coverage verifies changed/disappearing/root identities, missing/reparented/
  older/PID0 entries, process/read/metadata caps, observation completion before child completion,
  failed reporting, actual Linux grandchild sampling, and natural process exit without a live timer.

Exact focused Windows command (repository root):

```powershell
& 'C:\Users\4FE4~1\AppData\Local\Temp\node-v22.23.2-win-x64\node.exe' --test .scratch/staging-v4-cutover/diagnostics/native-lock-profile.test.mjs
```

Result:12 tests,11 pass/1 Linux-only skip/0 fail,737.0494ms on Node22.23.2 (final rerun).

Exact cached Linux command (no network/download, read-only repository/runtime, uid1000):

```powershell
docker run --rm --network none --read-only --user 1000:1000 --mount 'type=bind,source=C:\Users\Ригер\Desktop\Repetotor\Приложение репетитор\server,target=/repo,readonly' --mount 'type=bind,source=C:\Users\4FE4~1\AppData\Local\Temp\easyboost-ci124-linux-runtime-08f4c66031ef4de6ab02c402b93fd3d6,target=/runtime,readonly' --tmpfs '/tmp:rw,exec,nosuid,size=512m' --workdir /repo 44f22c911346 /bin/bash -c 'cp /runtime/node /tmp/node && chmod 0755 /tmp/node && /tmp/node --version && /tmp/node --test .scratch/staging-v4-cutover/diagnostics/native-lock-profile.test.mjs'
```

Result:Node22.23.1;12/12 pass,0 skips/failures,1041.968653ms (final rerun after adding5s/8KiB
outer containment to the two standalone test harness calls). This exercises finite children,
not the actual complete flock scenario. Docker Desktop's independent post-exit flock PID0
behavior remains an environment limitation; no guard was bypassed and no complete local replay
was attempted. The native workflow still must provide the actual full-scenario evidence.

Additional worker checks: pinned Node `--check` on all three new `.mjs` files; pinned
`node node_modules/eslint/bin/eslint.js .scratch/staging-v4-cutover/diagnostics/*.mjs`; and
`git diff --check` all passed. `git diff -- .github/workflows/ci.yml
test/staging-release-lock.integration.test.js` is empty. Root owns the common gate/reviews;
worker did not run the full suite, commit, push, deploy, use SSH or publish recovery data.

## Root validation / scoped publication — 2026-09-05

Independent fresh Standards and Spec reviews:0 findings on each axis. Root pinned Windows
diagnostic rerun:12tests/11pass/1Linux-onlyskip/0fail,753.4057ms. Fresh npm lint and check passed
(571JSfiles,165handlers/106names); scoped secret scan1556tracked+8explicit candidates and normal
1556tracked+92candidates passed,848DockerCOPY inputs verified. Five frozen workflow/diagnostic
source hashes remained unchanged through these checks. Optional additional YAML parsing was not
available locally (no js-yaml installed); no package was installed and no parser success is claimed.

Full pinned npm-test gate48724 already completed this turn:3241tests/3140pass/101skip/0fail,
3758432.7868ms. It remains the full baseline because the entire product/source/test/package and
canonicalCI/deploy workflow diff against7dd3677 is empty. The new diagnostic is outside npm's
test/*.test.js glob and is explicitly self-tested locally and in its new native workflow. Root also
re-ran the20existing tests consuming changed progress/release evidence:20/20PASS2468.8949ms.
No repeated hour-long identical unit run or canonical gate weakening was introduced.

This closes implementation of the diagnostic feedback mechanism, not the CI124 root cause or
release readiness. Native execution follows the root-owned scoped commit/push. CI124 remains
failed; later canonical release/browser gates and owner deployment are still outstanding.
