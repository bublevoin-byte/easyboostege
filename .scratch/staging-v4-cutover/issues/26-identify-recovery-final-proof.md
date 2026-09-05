# 26 — Identify the exact rejected recovery final proof

Status: in-progress
Blocked by: None — ticket25 diagnostic is published as ea00224; original timing repair remains open.
Spec: .scratch/staging-v4-cutover/spec.md#identify-the-exact-rejected-recovery-final-proof

## What to build

Make the real reduced recovery result identify its first rejected independent proof using a
static allowlisted label, so the next correction is based on native evidence rather than guesses.
Native8 helperclosed1/expected evidence at242164ms still yields not-proven/auxiliary null after
the genuine0400/0600 model correction. Its120017ms original timeout must remain a failure.

## Boundaries

- Only proof-stage observability in the existing recovery diagnostic and finite real-file tests.
- Preserve all31 contracts, assertion order/content, exact modes, return statuses,120000/150000/
  300000ms bounds, auxiliary124 priority and2048B report limit. No new replacement-proof seam.
- No raw exceptions, expected/actual bytes, paths, commands, environment or stream publication.
- No correction of the unknown proof failure, production/default-test/workflow edits or new gates.
- No downloads, real local flock/recovery retry, VPS mutation, packaging or deployment.
- Root owns commit/push, PROGRESS/spec/checkpoint, independent reviews and native observation.

## Files

- `.scratch/staging-v4-cutover/debug/ci133-recovery-only.mjs` — existing verify/finish/prove seams.
- `.scratch/staging-v4-cutover/debug/ci133-recovery-only.test.mjs` — existing finite recovery fixtures.
- This issue — precise RED/GREEN evidence, commands, tested LF hashes and handoff.

## Definition of Done

- [x] Finite real restored-file mismatch first reproduces missing precise stage (RED), then GREEN.
- [x] Static first-failure stage covers distinct current-state groups and four Docker inspections.
- [x] Success and proof-not-attempted are unambiguous; error contents/private sentinel never leak.
- [x] All31 prior contracts preserved; new representative early/late and Docker failure tests pass.
- [x] Unclosed auxiliary124 and report-failure priority remain unchanged; reports remain bounded.
- [x] Focused pinned Windows/cached offline Linux, syntax and targeted ESLint pass; exact LF hashes.
- [ ] Root reviews, existing full-gate outcomes, authorized publication and native result recorded.
- [ ] One scoped commit, without claiming a production timing fix or deployment readiness.

## Comments

### Agreed implementation/test seam — 2026-09-05

The worker owns only this issue and the two ci133 files. The existing finishRecoveryAttempt,
verifyCurrent and proveCurrentDocker boundaries are the agreed seams from this ticket/spec;
real finite child restoration and real file/command faults exercise the reported result.
The implement and TDD skills plus both TDD references were read, as were root/server tracker
and domain instructions and existing ADRs. Neither root nor server has CONTEXT.md; ADRs concern
unrelated frontend/authentication behavior. Root retains review, commit/push, full-gate evidence
and native observation authority. This issue remains in-progress until those steps finish.

### Frozen implementation handoff

The settlement row now carries `proofFailureStage`: one of32 source-owned static identifiers,
or `unknown` if a rejected proof has no known stage. Verified success has null; proof not
attempted has null plus the existing not-proven finalState. In particular a late verified
restoration has null but keeps its original failed timing verdict/status.

Each existing verifier tracks its current assertion group locally, catches once around the
whole proof, records only allowlisted metadata in a private WeakMap keyed by the original
error, then rethrows that same error. There is no catch-and-continue, exported stage control,
replacement-proof callback, raw error serialization or change to the proof's return value.
The existing finish catch reads the metadata and preserves the original auxiliary object.

Current-state labels separately cover root identity, retained capture, release-tree bytes,
current-file metadata, active inventory, marker metadata/content, environment/lock content,
retained identities, each current/candidate archive digest/marker/tree, archive/rollback
inventories, backup count/name/metadata/content, temporary release, host-operation residue,
and image/container metadata/content. Four Docker labels distinguish local image, container
image, current release tag and candidate release tag. Labels never interpolate file names,
digests, commands, paths, environment or error contents.

All original31 contracts and their assertions remain; seven added contracts cover first early
file failure, the final file-content failure, each of four actual fixture Docker inspections,
and simultaneous unclosed auxiliary23 plus a real failed report write. Existing success,
late-success, skipped-proof, auxiliary124 and wrong0644 assertions were strengthened with
stage expectations. Real private sentinel bytes are deliberately included in rejected files
and Docker stdout/stderr; emitted rows reject sentinel/path/error text and error-field keys.
Every representative report and the existing bounded timeline remains at most2048B per row.

No original assertion was corrected or weakened. A read-only Espree AST comparison against
ea00224014a5a756a41c97faf974224230d8592d found identical ordered proof calls and arguments:
verifyCurrent26/26, proveCurrentDocker6/6 (assert calls plus entry/absent/verifyReleaseTree/
requireAuxiliarySettlement). Manual scoped-diff inspection confirms exact0400/0600 modes,
all four command expectations, output bounds, original120000ms observation,150000ms settlement,
300000ms watchdog and existing status/signal/auxiliary precedence are unchanged.

### Measured RED → GREEN

1. On pinned Windows22.23.2, first added the finite real-restoration test that corrupts the
   retained environment bytes and a later container-state file. Before implementation it
   already returned1 with closed helper1, expected evidence, not-proven and auxiliary null,
   then failed because proofFailureStage was undefined rather than environment-content.
   RED exit1:1test/0pass/1fail/0skip, test228.984ms,total314.8748ms. Adding current-proof stage
   metadata made that same contract GREEN exit0:1test/1pass/0fail/0skip,
   test232.4398ms,total322.1461ms. Thus the new assertion detects the missing observability
   through the real result seam, including precedence over the deliberately later mismatch.
2. Before adding Docker stage metadata, a cached offline Linux contract preserved the real
   Docker fixture command except for private sentinel output at the selected inspection.
   RED exit1:1test/0pass/1fail/0skip,test128.125978ms,total222.80352ms,
   actual unknown versus expected docker-local-image. Adding only Docker stage metadata
   made all four selected-inspection cases GREEN exit0:4tests/4pass/0fail/0skip,
   total597.053309ms; individual durations134.258231/120.165376/118.707677/118.008236ms.
3. Final complete focused file on normalized LF sources: Windows22.23.2 exit0,
   38tests/20pass/18explicit POSIX skips/0fail/0cancelled,total19016.7242ms.
   Cached offline Linux22.23.1 exit0,38tests/38pass/0skip/0fail/0cancelled,
   total23782.473701ms. The new auxiliary/report-write contract passes at305.177987ms,
   keeping status124, helper1 evidence, auxiliary exited23/closedfalse, its Docker stage,
   fixture retention and outputFailedtrue simultaneously.
4. Both files pass pinned syntax checks. Targeted ESLint reuses the repository's Node JS
   configuration for mjs:2files/0errors/0warnings. Scoped git diff --check passes.
   Windows session24680 and Linux session47539 both closed0; all other commands completed.
   Each Linux test invocation used --rm and an isolated tmpfs. Unproved fixtures were retained
   until that disposable environment's lifecycle ended, without signalling numeric identities.

Only the two owned mjs files were mechanically normalized to LF before final checks.
Final source sizes are27112B and34858B, with zero CR bytes in each. SHA256:

```text
ci133-recovery-only.mjs
bb69c57f0da94473bb001257a7b4ac664da386b2e50e8e497746832fd368ef22
ci133-recovery-only.test.mjs
bc1902a2b6b263f3dfffbc30fe52831ebd8363a34222e1d14fc1c85644e7dde3
unchanged ci126-rollback-only.mjs
e9162cbaef0dcad230d32a8d6f285622260829c13d9d36cd06d34951bd6a633f
unchanged ci126-rollback-only.test.mjs
1267da2184e7eae8d2a15e8f6711eaee6f9973a55cba7ef1e4daed907bee801d
Windows Node22.23.2
0d0f5e39f9f3d9587bc19f73eab3c2c9c4903fd02d6dbf9c853dd81b3d95fad4
Linux Node22.23.1
93956de2e59480474a7b46571da1651180b1a050cdf32641ebec4ce6e478e068
established cached offline Docker image
sha256:44f22c911346d64eb74edc2af1355825d17d70d91c4fb30294581596293b2360
```

Exact focused commands from the server root (the first Windows command was run before and
after the current-proof change; the three Linux commands are respectively RED, Docker GREEN
and final complete focused verification):

```powershell
& 'C:\Users\4FE4~1\AppData\Local\Temp\node-v22.23.2-win-x64\node.exe' --test --test-name-pattern='final proof reports the first early file mismatch' .scratch/staging-v4-cutover/debug/ci133-recovery-only.test.mjs
& 'C:\Program Files\Docker\Docker\resources\bin\docker.exe' --context desktop-linux run --rm --pull=never --network none --read-only --user 1000:1000 --tmpfs '/tmp:rw,exec,mode=1777,size=512m' --mount 'type=bind,source=C:\Users\Ригер\Desktop\Repetotor\Приложение репетитор\server,target=/workspace,readonly' --mount 'type=bind,source=C:\Users\4FE4~1\AppData\Local\Temp\easyboost-ci124-linux-runtime-08f4c66031ef4de6ab02c402b93fd3d6,target=/runtime,readonly' --workdir /workspace 44f22c911346 /bin/bash --noprofile --norc -c 'set -eu; cp /runtime/node /tmp/node; chmod 0755 /tmp/node; exec /tmp/node --test --test-name-pattern="final Docker proof identifies docker-local-image" .scratch/staging-v4-cutover/debug/ci133-recovery-only.test.mjs'
& 'C:\Program Files\Docker\Docker\resources\bin\docker.exe' --context desktop-linux run --rm --pull=never --network none --read-only --user 1000:1000 --tmpfs '/tmp:rw,exec,mode=1777,size=512m' --mount 'type=bind,source=C:\Users\Ригер\Desktop\Repetotor\Приложение репетитор\server,target=/workspace,readonly' --mount 'type=bind,source=C:\Users\4FE4~1\AppData\Local\Temp\easyboost-ci124-linux-runtime-08f4c66031ef4de6ab02c402b93fd3d6,target=/runtime,readonly' --workdir /workspace 44f22c911346 /bin/bash --noprofile --norc -c 'set -eu; cp /runtime/node /tmp/node; chmod 0755 /tmp/node; exec /tmp/node --test --test-name-pattern="final Docker proof identifies" .scratch/staging-v4-cutover/debug/ci133-recovery-only.test.mjs'
& 'C:\Program Files\Docker\Docker\resources\bin\docker.exe' --context desktop-linux run --rm --pull=never --network none --read-only --user 1000:1000 --tmpfs '/tmp:rw,exec,mode=1777,size=512m' --mount 'type=bind,source=C:\Users\Ригер\Desktop\Repetotor\Приложение репетитор\server,target=/workspace,readonly' --mount 'type=bind,source=C:\Users\4FE4~1\AppData\Local\Temp\easyboost-ci124-linux-runtime-08f4c66031ef4de6ab02c402b93fd3d6,target=/runtime,readonly' --workdir /workspace 44f22c911346 /bin/bash --noprofile --norc -c 'set -eu; cp /runtime/node /tmp/node; chmod 0755 /tmp/node; exec /tmp/node --test .scratch/staging-v4-cutover/debug/ci133-recovery-only.test.mjs'
& 'C:\Users\4FE4~1\AppData\Local\Temp\node-v22.23.2-win-x64\node.exe' --test .scratch/staging-v4-cutover/debug/ci133-recovery-only.test.mjs
& 'C:\Users\4FE4~1\AppData\Local\Temp\node-v22.23.2-win-x64\node.exe' --check .scratch/staging-v4-cutover/debug/ci133-recovery-only.mjs
& 'C:\Users\4FE4~1\AppData\Local\Temp\node-v22.23.2-win-x64\node.exe' --check .scratch/staging-v4-cutover/debug/ci133-recovery-only.test.mjs
& 'C:\Users\4FE4~1\AppData\Local\Temp\node-v22.23.2-win-x64\node.exe' --input-type=module -e 'import { ESLint } from "eslint"; import config from "./eslint.config.js"; const base = config.find((item) => item.files?.includes("**/*.js")); const lint = new ESLint({ overrideConfig: [{ ...base, files: ["**/*.mjs"] }] }); const results = await lint.lintFiles([".scratch/staging-v4-cutover/debug/ci133-recovery-only.mjs", ".scratch/staging-v4-cutover/debug/ci133-recovery-only.test.mjs"]); const formatter = await lint.loadFormatter("stylish"); process.stdout.write(formatter.format(results)); const errors = results.reduce((sum, row) => sum + row.errorCount, 0); const warnings = results.reduce((sum, row) => sum + row.warningCount, 0); console.log(JSON.stringify({ files: results.length, errors, warnings })); process.exitCode = errors || warnings ? 1 : 0;'
git diff --check -- .scratch/staging-v4-cutover/debug/ci133-recovery-only.mjs .scratch/staging-v4-cutover/debug/ci133-recovery-only.test.mjs
```

Exact mechanical normalization command, applied only to the two owned sources before final tests:

```powershell
$proofPaths = @('.scratch\staging-v4-cutover\debug\ci133-recovery-only.mjs', '.scratch\staging-v4-cutover\debug\ci133-recovery-only.test.mjs'); foreach ($proofPath in $proofPaths) { $proofFull = (Resolve-Path -LiteralPath $proofPath).Path; $proofBytes = [System.IO.File]::ReadAllText($proofFull); [System.IO.File]::WriteAllText($proofFull, $proofBytes.Replace("`r`n", "`n"), [System.Text.UTF8Encoding]::new($false)) }
```

The first sandboxed Docker attempt could not read local context metadata. The identical
isolated command succeeded with authorized escalation. There was no auto-review rejection,
dependency/image download, local environment repair or actual local flock/recovery retry.

Root retains the completed full Windows23 gate:3286tests/3163pass/122skip/1restricted taskkill
failure, followed by the unchanged affected file passing33/33 outside that restriction.
Those outcomes were neither relabelled nor repeated by this diagnostic-only worker.
Root also recorded native8 full original recovery failure at120004ms after successful rollback;
the reduced recovery's original120017ms timeout and not-proven result remain failures.
Its exact native rejected proof remains UNKNOWN until a subsequent native observation reads
the new field. No production timing fix, deployment readiness, commit or push is claimed here.

### Root independent review and pre-publication gate

Spec0 findings; Standards0 hard violations/0 actionable heuristic findings. Both reviewers read
the complete frozen sources and independently verified exact LF hashes. Spec also confirmed
all26+6 ordered proof calls and all109 prior test assertions remain unchanged/in order.
Root read the complete scoped source diff and this handoff. Root pinned22.23.2 lint/check pass,
573localJS/165handlers/106names; session39094closed0. Fresh candidate scan passes1588tracked+
23explicit/1590unique/848DockerCOPY inputs. Scoped whitespace passes. Index empty before staging.

Production/default tests remain identical to4e3b02c; workflows identical toea00224. The complete
Windows23 outcome and subsequent unchanged33/33 permission-separated result above remain the
existing full local evidence. CanonicalCI131 failed only original rollback120009ms; CI132 is
still running. Neither is relabelled green. Root publication includes only the two diagnostic
sources, this issue, ticket25 terminal evidence, the appended spec and staging PROGRESS rows.
Local checkpoints, artifact inventories, source TARs and unrelated dirty files stay excluded.
