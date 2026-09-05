# 25 — Match recovery diagnostic permissions to the actual helper

Status: done
Blocked by: None — published ticket24 diagnostic is available; its native proof defect is this slice.
Spec: .scratch/staging-v4-cutover/spec.md#match-recovery-diagnostic-metadata-to-the-real-helper-umask

## What to build

The reduced recovery diagnostic must model the actual helper's frozen0400/recovered0600
current-file permissions under umask077, instead of synthetic0444/0644. Correct its fixture,
final proof and finite successful children together, preserving every original failure guard.
This is diagnostic-only; original120s performance remains unresolved.

## Evidence

Publishedcb29558906b53fbb3abf1d076595cfa94098c22a, native7run33974726837/job101329311878:
contracts28/28; initial120020ms timeout; late recovery199258ms; helperclosed1 at238706ms,
expected restoration diagnostic, independentfinalState not-proven. No other native metadata
was logged, so the claim that this is the only mismatch remains unproved.

Root probe on cached offline Linux22.23.1, real createReleaseArchive/extractReleaseArchive
with inherited shell umask077, then the exact a-w bit removal, completed0 in0.8141855s:
{"umask":"77","extractedMode":"600","frozenMode":"400"}.
Production deploy/rollback start with077 and archive extraction does not override it afterward.
The public archive producer encodes0644; extraction correctly respects the inherited mask.

## Boundaries

- Own only the new recovery-only diagnostic, its focused test and this ticket evidence.
- Reuse the existing highest prepare/finish seams and real archive extraction.
- Preserve imported rollback-only diagnostic, production helpers, default tests and workflows.
- Preserve all28 current tests/assertions; update only wrong permission expectations, add regressions.
- No broad accepted-mode ranges, changed deadlines, weakened identities or result handling.
- No actual local flock/recovery, full-suite repeat, downloads, git commit/push or VPS actions.
- Root handles independent review, publication and eventual native feedback; do not mark done early.

## Files

- `.scratch/staging-v4-cutover/debug/ci133-recovery-only.mjs` — exact prepared/final file modes.
- `.scratch/staging-v4-cutover/debug/ci133-recovery-only.test.mjs` — real077 archive regression and finite restoration.
- This issue — measured RED/GREEN evidence and finalLFhashes.

## Definition of Done

- [x] Real archive extraction under isolated inherited077 makes a deterministic RED comparison against current diagnostic modes.
- [x] Prepared current files prove0400; recovered current files prove0600; all other exact proofs unchanged.
- [x] Finite restored children use real archive extraction, not artificialchmod0644.
- [x] Added regressions reject broad0444 prepared and0644 recovered current-file modes.
- [x] Existing28 behavioral contracts and added cases pass focused Linux; Windows explicitPOSIXskips only.
- [x] Syntax/targeted ESLint pass; tested LF hashes and precise runtime/results recorded.
- [x] Root independent Spec/Standards review, authorized publication and native feedback recorded.
- [x] One scoped commit; no production/deployment readiness claim.

## Comments

### Implementation handoff — 2026-09-05

The ticket worker read root/server instructions, the local tracker and domain conventions,
implement/autopilot/tdd skills and both required TDD references. No root or server CONTEXT.md
exists; the existing ADRs concern unrelated authentication/frontend behavior. The agreed
prepare/finish interfaces remain the test seams. Only this issue and the two owned ci133 files
were edited. The ticket remains in-progress pending the root-owned review/publication/native gates.

The imported ci126 fixture is still verified in its original0444 model before conversion.
Only the recovery fixture is converted to frozen0400 and captures/requires that exact mode.
Recovered current files must be0600. Marker0600, directories0700, retained identities,
archive/inventory/byte proofs, expected diagnostic, closed-child requirements, status handling,
auxiliary124, timing limits and bounded reporting remain unchanged.

Finite children now set077 inside their own process and extract the real current archive into
a fresh private destination. They unlink the old frozen current entries and rename the extracted
files into the retained app directory. A preceding chmod0600 applies only to the old files so
Windows can remove them; it never determines the newly extracted file modes. The negative0644
case uses the same real extraction with child022 instead of manufacturing recovered permissions.
The actual diagnostic CLI acquired no new arguments, logging or production interfaces.

### Measured RED → GREEN

All measurements below use the same cached offline Linux fixture/command shown later.
Each focused pattern selects one actual test (1test/0skip/0cancelled), not the original timed
release/recovery operation. No real local flock or recovery helper was run.

1. Added `prepared current modes match real canonical extraction and freezing under inherited
   umask077` before changing the diagnostic. A finite `/bin/bash` child sets077 and execs pinned
   Node; Node asserts its inherited mask, invokes real createReleaseArchive/extractReleaseArchive,
   verifies source bytes before and after actual a-w bit removal, then reports all four modes.
   Actual archive outputs were0600/frozen0400. Comparison to the unchanged published preparation
   failed at `.dockerignore`: actual292 (0444), expected256 (0400).
   RED: exit1,0pass/1fail, test93.703414ms,total185.340668ms.
   After the prepared-mode correction: GREEN exit0,1pass/0fail,
   test90.365245ms,total185.175219ms.
2. Replaced the finite success fixture's artificialchmod0644 with real masked archive extraction,
   leaving the diagnostic's final0644 expectation unchanged for the RED run. The existing
   `on-time recovery and expected helper exit1 require independently restored final current files
   at the CLI result seam` failed with diagnostic1 versus expected0.
   RED: exit1,0pass/1fail,test121.830668ms,total214.018902ms.
   Changing only the final expected mode to0600 made that same test GREEN:
   exit0,1pass/0fail,test135.364782ms,total226.979886ms.
3. Added explicit refusal of formerly accepted prepared0444 and an on-time closed/evidenced
   helper1 whose real022 extraction produces0644. The latter still returns1/finalState not-proven,
   proving that successful timing/exit/evidence cannot bypass the exact recovered mode.

Pattern arguments used in the Linux command, placed after `--test`:

```text
--test-name-pattern="prepared current modes match real canonical extraction"
--test-name-pattern="on-time recovery and expected helper exit1"
```

### Final focused gates and exact source

Both owned .mjs files were normalized to UTF-8 without BOM and LF before these final runs.

- Linux cached Node22.23.1:31tests/31pass/0skip/0fail/0cancelled,
  total22832.405653ms,exit0.
- Windows pinned Node22.23.2:31tests/18pass/13POSIX skips/0fail/0cancelled,
  total18659.0026ms,exit0. The prior10 skips remain and the three new POSIX cases skip explicitly.
- All28 original behavioral tests remain. A read-only comparison to `git show HEAD:<test>`
  also verified all111 original assertion/test-declaration lines remain; no assertion was removed.
- Both `node --check` commands pass. Targeted ESLint applies the repository's Node globals and
  rules to these .mjs files:2files/0errors/0warnings,exit0. `git diff --check` passes.
- Read-only diff over scripts/,test/,.github/ and both ci126 files is empty. Imported ci126 and
  its test retain their recorded SHA256 values below. Unrelated dirty/untracked files are preserved.
- Full suite was not repeated, as this ticket requires. Root retains existing full-gate evidence.
- Measured Linux contracts plus the unchanged300000ms attempt watchdog total322832.406ms,
  leaving37167.594ms of the existing six-minute job for setup/wrapper overhead. This is an offline
  observation, not a guarantee of native duration or resolution of the original120s failure.

SHA256 of the exact tested files/runtimes:

```text
ci133-recovery-only.mjs
eb97254fe4b84bd1e939ea739293bf110329a9df35f3a8a83ca966e9483626e0
ci133-recovery-only.test.mjs
2822097ae470a6a1da4577da90b65c1e2b305fbd23595a28fd3b9950d858d6fc
unchanged ci126-rollback-only.mjs
e9162cbaef0dcad230d32a8d6f285622260829c13d9d36cd06d34951bd6a633f
unchanged ci126-rollback-only.test.mjs
1267da2184e7eae8d2a15e8f6711eaee6f9973a55cba7ef1e4daed907bee801d
Windows Node22.23.2
0d0f5e39f9f3d9587bc19f73eab3c2c9c4903fd02d6dbf9c853dd81b3d95fad4
Linux Node22.23.1
93956de2e59480474a7b46571da1651180b1a050cdf32641ebec4ce6e478e068
cached image (same established offline image)
sha256:44f22c911346d64eb74edc2af1355825d17d70d91c4fb30294581596293b2360
```

Exact commands from the server root:

```powershell
& 'C:\Users\4FE4~1\AppData\Local\Temp\node-v22.23.2-win-x64\node.exe' --test .scratch/staging-v4-cutover/debug/ci133-recovery-only.test.mjs
& 'C:\Users\4FE4~1\AppData\Local\Temp\node-v22.23.2-win-x64\node.exe' --check .scratch/staging-v4-cutover/debug/ci133-recovery-only.mjs
& 'C:\Users\4FE4~1\AppData\Local\Temp\node-v22.23.2-win-x64\node.exe' --check .scratch/staging-v4-cutover/debug/ci133-recovery-only.test.mjs
& 'C:\Users\4FE4~1\AppData\Local\Temp\node-v22.23.2-win-x64\node.exe' --input-type=module -e 'import { ESLint } from "eslint"; import config from "./eslint.config.js"; const base = config.find((item) => item.files?.includes("**/*.js")); const lint = new ESLint({ overrideConfig: [{ ...base, files: ["**/*.mjs"] }] }); const results = await lint.lintFiles([".scratch/staging-v4-cutover/debug/ci133-recovery-only.mjs", ".scratch/staging-v4-cutover/debug/ci133-recovery-only.test.mjs"]); const formatter = await lint.loadFormatter("stylish"); process.stdout.write(formatter.format(results)); const errors = results.reduce((sum, row) => sum + row.errorCount, 0); const warnings = results.reduce((sum, row) => sum + row.warningCount, 0); console.log(JSON.stringify({ files: results.length, errors, warnings })); process.exitCode = errors || warnings ? 1 : 0;'
& 'C:\Program Files\Docker\Docker\resources\bin\docker.exe' --context desktop-linux run --rm --pull=never --network none --read-only --user 1000:1000 --tmpfs '/tmp:rw,exec,mode=1777,size=512m' --mount 'type=bind,source=C:\Users\Ригер\Desktop\Repetotor\Приложение репетитор\server,target=/workspace,readonly' --mount 'type=bind,source=C:\Users\4FE4~1\AppData\Local\Temp\easyboost-ci124-linux-runtime-08f4c66031ef4de6ab02c402b93fd3d6,target=/runtime,readonly' --workdir /workspace 44f22c911346 /bin/bash --noprofile --norc -c 'set -eu; cp /runtime/node /tmp/node; chmod 0755 /tmp/node; exec /tmp/node --test .scratch/staging-v4-cutover/debug/ci133-recovery-only.test.mjs'
git diff --check -- .scratch/staging-v4-cutover/debug/ci133-recovery-only.mjs .scratch/staging-v4-cutover/debug/ci133-recovery-only.test.mjs
```

The first sandboxed Docker invocation could not read its local context metadata. The same
isolated command succeeded with authorized escalation; no auto-review rejection, network
download, installation or Docker environment repair occurred.

Root separately reported native7 reduced rollback tree104043ms/helperclosed0at165724ms,
while the full original7 failed the earlier rollback/tree120021ms at config-json-complete
(original test line815). That independent native evidence does not become green from this
diagnostic correction. The initial reduced recovery120020ms timeout remains a failure; its
later199258ms barrier and238706ms helper1 still require a corrected native final-state proof.
No claim is made that the observed permissions defect is the only native final-state mismatch.
No commit, push, workflow edit, production change, release packaging or deployment was performed.

### Root pre-publication review

Independent reviews of the exact frozen sources: Spec0 findings; Standards0 hard violations
and0 heuristic findings. Root independently read the entire scoped diff and verified both LF
SHA256 values. All original assertions remain; only wrong diagnostic permissions changed.
Root pinned22.23.2 lint/check pass:573localJS/165handlers/106names, including the known unrelated
untracked local inventory. Root check session31014 closed0. Fresh candidate secret scan passes
1587tracked+22explicit/1589unique,848DockerCOPY inputs; whitespace passes. Staging index was empty.

The production/default-test/canonical-workflow inputs remain unchanged from published4e3b02c.
The recorded complete Windows23 gate remains3286tests/3163pass/122skip/1restricted taskkill
failure; the unchanged affected file subsequently passed33/33 outside that restriction.
CanonicalCI130 still has its sole original rollback120s failure; CI131 oncb295 remains running.
Those original outcomes are not relabelled or repeated for this diagnostic-only change.

Root will commit only these two diagnostic files, this issue, ticket24's terminal native
evidence, the appended spec and staging PROGRESS rows. Local checkpoints/artifact notes,
manifests, baseline source TARs and unrelated files remain out. Publication is only to the
authorized prototype branch for corrected native feedback, not a deployment or release archive.

### Publication and native8 outcome

Published ea00224014a5a756a41c97faf974224230d8592d only to authorized prototype branch,
normal fast-forward from cb29558; exact remote HEAD verified. Postcommit history scan395commits
passes. No production/default-test/workflow changes, release packaging or VPS mutation.

Native8 run33976709565/job101334574483, exact ea00224, Ubuntu24.04.4/Node22.23.2:
all31 contracts pass with0skip/fail/cancel,26588.372842ms. Full raw32567chars/421lines read.
Installer1119ms and equivalence1944ms pass. Original exact timeout occurs120017ms with phase
config-json-complete/upCountmissing/recoveryabsent/staletreepresent/stdout3B/stderr0.
Recovery barrier arrives late203093ms; helper exits and closes1, no signal, expected diagnostic
present at242164ms, stdout3B/stderr75B. Final independent proof remains not-proven, auxiliary null;
diagnostic correctly returns1. Job fails4m42s, attempt4m4s, not an outer timeout/unclosed helper.

This ticket's evidenced mode correction is complete, not a timing or full-final-proof repair.
Ticket26 now reports the exact rejected remaining proof; do not accept broader modes or guess
another fix. CanonicalCI131 on cb295 also failed only original rollback/tree120009ms;
3258tests/3192pass/1fail/65skip, PostgreSQL51/51. CI132 on ea00224 remains pending at this record.
