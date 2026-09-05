# 27 — Make the hermetic Docker reference probe truthful

Status: in-progress
Blocked by: 26 — done, native first rejection temporary-release-absence.
Spec: .scratch/staging-v4-cutover/spec.md#make-the-hermetic-docker-reference-probe-truthful

## What to build

Correct the shared fake Docker image listing so production cleanup sees the temporary image
it owns, removes it, and can prove it absent. Native9 helper closes1 with restoration evidence
but the independent image-state absence fails. Root's23ms finite Linux command proved current
factory build/inspect sees candidate ID while exact production image-ls returns empty success.

## Boundaries

- Shared test factory plus added short contracts only; no existing assertion deletion/weakening.
- Preserve the original120000ms wait, production helpers, diagnostic final proofs and workflows.
- Exact list shape, present/absent and owned removal behavior; no general Docker emulation.
- Both current/candidate lifecycle and stable/container retention must be tested.
- No downloads, actual local Linux flock/recovery retry, VPS mutation, packaging or deployment.
- Root owns spec/PROGRESS/checkpoint, independent reviews, commit/push and native feedback.

## Files

- `test/staging-release-lock.integration.test.js` — shared factory and new finite contracts.
- This issue — RED/GREEN evidence, exact commands and tested LF/source hashes.

## Definition of Done

- [x] A new short test fails against the old factory at build/inspect/list consistency.
- [x] Exact image-ls query truthfully reflects built/current/candidate and removed state.
- [x] Absence is empty successful list; malformed/unsupported listing is not false success.
- [x] Owned temporary removal preserves stable image and running-container state.
- [x] All old tests/assertions/timing boundaries retained, no production/workflow changes.
- [x] Focused Windows/Linux and existing ci126/ci133 contract suites pass, exact evidence recorded.
- [ ] Root review/publication/native feedback recorded without claiming timing or deploy readiness.

## Initial evidence and ranked hypotheses

1. Missing image-ls implementation causes production probe to skip cleanup. Prediction:
   exact listing sees the built image after the fixture fix; real owned cleanup removes state.
2. Production cleanup is skipped for another reason. Prediction: truthful listing alone still
   leaves state in the unchanged recovery path; retain native failure if so.
3. Independent absence requirement is wrong. Prediction: actual owned image removal succeeds
   but leaves expected state. Current factory rm explicitly unlinks state, so this is less likely.

Root finite probe on cached offline Linux22.23.1: build0, inspect0/candidate matches, list0 with
zero output bytes, sameIdentity false, elapsed23ms. AssertionError actual empty vs candidate ID.
No local installed-helper run or deployment; disposable tmpfs fixture, no project file changes.

## Answer — implementation frozen for root review

The shared generated Bash now handles only the exact six-argument production query
`image ls --quiet --no-trunc --filter reference=<tag>`. Its bounded supported references are
the current release, candidate release and retained stable local image. The existing single
temporary-release state remains the model: its known image ID identifies which release tag
is present. The other known release is absent. Missing temporary state returns successful
empty output. Unknown tags, wildcards, malformed command shapes and invalid temporary IDs
fail instead of falling through to false success. Build, inspect, tag and rm remain unchanged.

Five added default-suite tests execute the actual generated Bash: build/inspect/list
consistency, both release lifecycles, ten malformed/unsupported listings, and the unchanged
real `remove_owned_image_reference` function through a finite direct command adapter. The
latter sources an LF-normalized copy of `scripts/staging-release-common.sh`, replaces only
`run_bounded`, rejects a mismatched owner and observes the actual list/list/rm/list command
sequence for both releases. Both successful empty listing and independent state-file absence
must follow removal; stable image and container bytes must remain intact. This is a finite
command-boundary contract, not real supervisor, flock, installed-recovery or timing proof.

`git diff --numstat -- test/staging-release-lock.integration.test.js` is `166 0`. A read-only
audit asserted that the diff has zero deleted source lines. Every old assertion and test,
including the original 120000ms wait, remains unchanged. The file grows from six tests to
eleven; the two diagnostic suites retain all eleven ci126 and thirty-eight ci133 tests.
Production common.sh and both diagnostic source/test pairs were also verified LF-identical
to HEAD `8b1b69d1509921714a640a644fc53423c2ce6707`.

### RED/GREEN evidence, 2026-09-05

All commands ran from the server repository. Windows used Node22.23.2 at
`C:\Users\4FE4~1\AppData\Local\Temp\node-v22.23.2-win-x64\node.exe` and generated-Bash tests
used `C:\Program Files\Git\bin\bash.exe`. A command-local pinned Node PATH was applied:

```powershell
$env:PATH = 'C:\Users\4FE4~1\AppData\Local\Temp\node-v22.23.2-win-x64;' + $env:PATH
& 'C:\Users\4FE4~1\AppData\Local\Temp\node-v22.23.2-win-x64\node.exe' --test --test-name-pattern='lock fixture image reference listing agrees' test/staging-release-lock.integration.test.js
```

RED before the factory edit: exit1, 1 test, 0 pass, 1 fail, 209.677ms total. Build and inspect
both exited0 and inspect returned the candidate ID; listing exited0 with empty stdout.
The assertion was `built reference must not be reported absent`. The RED file's LF SHA256
was `fbf2c58f867d074b72cf727c772d0fb4c58d575b0afc35e5cf1663a23e84e816`.
GREEN after the minimal listing branch: same command exit0, 1/1 pass, 234.380ms.

Added contracts Windows command:

```powershell
& 'C:\Users\4FE4~1\AppData\Local\Temp\node-v22.23.2-win-x64\node.exe' --test --test-name-pattern='lock fixture image reference' test/staging-release-lock.integration.test.js
```

Result: exit0, 5/5 pass, 2452.261ms. Then the full affected file plus unchanged reduced
diagnostic contract suites ran together:

```powershell
& 'C:\Users\4FE4~1\AppData\Local\Temp\node-v22.23.2-win-x64\node.exe' --test test/staging-release-lock.integration.test.js .scratch/staging-v4-cutover/debug/ci126-rollback-only.test.mjs .scratch/staging-v4-cutover/debug/ci133-recovery-only.test.mjs
```

Windows GREEN: exit0, 60 tests, 39 pass, 21 existing platform skips, 0 failures, 22058.586ms.
The affected file contributed 10 pass and the existing Linux-only flock skip; ci126
contributed 9 pass/2 platform skips; ci133 contributed 20 pass/18 platform skips.

Linux was strictly the cached offline image and pinned Node22.23.1 runtime. Both RED and
GREEN used this exact container boundary (the final quoted Bash command differs below):

```powershell
& 'C:\Program Files\Docker\Docker\resources\bin\docker.exe' --context desktop-linux run --rm --pull=never --network none --read-only --user 1000:1000 --tmpfs /tmp:rw,exec,mode=1777,size=512m --mount 'type=bind,src=C:\Users\Ригер\Desktop\Repetotor\Приложение репетитор\server,dst=/workspace,readonly' --mount 'type=bind,src=C:\Users\4FE4~1\AppData\Local\Temp\easyboost-ci124-linux-runtime-08f4c66031ef4de6ab02c402b93fd3d6,dst=/runtime,readonly' --workdir /workspace 44f22c911346 /bin/bash -c 'set -eu; cp /runtime/node /tmp/node; chmod 0755 /tmp/node; exec /tmp/node --test --test-name-pattern="lock fixture image reference listing agrees" test/staging-release-lock.integration.test.js'
```

Linux RED: exit1, 1 test/1 fail, 86.277ms total, 15.536ms test duration, identical
build0/inspect0/list0-empty inconsistency. It ran against the same recorded RED LF source.
For final GREEN the Bash command was:

```bash
set -eu; cp /runtime/node /tmp/node; chmod 0755 /tmp/node; exec /tmp/node --test --test-skip-pattern="^real Linux flock excludes" test/staging-release-lock.integration.test.js .scratch/staging-v4-cutover/debug/ci126-rollback-only.test.mjs .scratch/staging-v4-cutover/debug/ci133-recovery-only.test.mjs
```

Linux GREEN: exit0, 59/59 pass, 0 failures, 0 reported skips, 23862.922ms. The explicit
skip pattern filters the unchanged canonical Linux flock test out of this local run;
all 10 finite affected-file tests, 11 ci126 tests and 38 ci133 tests ran and passed.
The actual local installed flock/recovery scenario was not retried.

Additional Windows checks with the same pinned Node:

```powershell
& 'C:\Users\4FE4~1\AppData\Local\Temp\node-v22.23.2-win-x64\node.exe' node_modules/eslint/bin/eslint.js test/staging-release-lock.integration.test.js
& 'C:\Users\4FE4~1\AppData\Local\Temp\node-v22.23.2-win-x64\node.exe' scripts/check-syntax.js
& 'C:\Users\4FE4~1\AppData\Local\Temp\node-v22.23.2-win-x64\node.exe' scripts/check-inline-handlers.js
git diff --check -- test/staging-release-lock.integration.test.js
```

All exited0. Syntax checked573 JavaScript files; 165 inline handlers/106 names resolved.
No broad full-suite rerun, downloads, dependencies, workflow edits, live Docker image
changes, packaging, VPS operation, deployment, commit or push was performed by this agent.

### Frozen LF/source identities

Hashes are SHA256 of UTF-8 source with CRLF normalized to LF; they identify the exact final
code tested by the combined Windows/Linux GREEN commands above. No source changed afterward.

| Source | SHA256 |
| --- | --- |
| HEAD affected file, before additions | `43dd8ee425838d038d317930ba18d61add82bbe94b382aa9ef6c35454bfbfb93` |
| Final `test/staging-release-lock.integration.test.js` | `45944c3658ef4e791c4c02b99c0da558807103b14d5341c402fc608db0a71ddd` |
| Unchanged `scripts/staging-release-common.sh` | `17bc4b780913d632bff2b814c514ad4c82d70d95a3d282592c4edfb62aefaaa3` |
| Unchanged `debug/ci126-rollback-only.mjs` | `e9162cbaef0dcad230d32a8d6f285622260829c13d9d36cd06d34951bd6a633f` |
| Unchanged `debug/ci126-rollback-only.test.mjs` | `1267da2184e7eae8d2a15e8f6711eaee6f9973a55cba7ef1e4daed907bee801d` |
| Unchanged `debug/ci133-recovery-only.mjs` | `bb69c57f0da94473bb001257a7b4ac664da386b2e50e8e497746832fd368ef22` |
| Unchanged `debug/ci133-recovery-only.test.mjs` | `bc1902a2b6b263f3dfffbc30fe52831ebd8363a34222e1d14fc1c85644e7dde3` |
| Generated Docker script with synthetic current `a`x64/candidate `c`x64 | `24f8473f618d1edf22b2eb78c9d44ffd5a762ed291fc16d0f0510dab475d29a7` |

### Remaining root-owned work

Implementation is frozen and handed to root for independent Standards/Spec reviews,
publication and genuine native feedback. Status remains in-progress until root records that
work and its verdict. These finite results repair and verify the fixture protocol defect;
they do not claim the original120s timing failure is fixed or authorize deployment.

### Root review and pre-publication gate

Spec0 findings; Standards0 documented violations/0 actionable heuristics. Both fresh reviewers
independently verified the frozen source. Spec reconstructed the entire old file from the
two insertion spans and proved every old assertion/order/timer unchanged. Root read full source
diff and this issue. Root's original23ms RED probe now passes in23ms: list0/72bytes, exactly
the inspect/build candidate ID, without changing its assertion or the disposable boundary.

Root pinned Windows22.23.2 full lint/check passed (session42659closed0),573JS/165handlers/
106names. Fresh secret scan passed1589tracked+24explicit/1591unique/848DockerCOPY inputs.
The existing completed full Windows23 gate remains3286/3163pass/122skip/1restrictedtaskkill
failure, with unchanged affected file33/33 outside restriction. It is not relabelled green.
CanonicalCI132 on pre-fix ea00224 failed solely original recovery120017ms after rollback103269ms;
PG51/51,unit3258/3192pass/1fail/65skip. CI133pre-fix8b1b69d is still running.
Only this test file, this issue, issue26terminal evidence, the appended spec and staging
PROGRESS are selected for prototype publication; no production/workflow/diagnostic edits.
