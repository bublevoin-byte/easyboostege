# 09 — Дисковое приватное рабочее пространство релиза

Status: in-progress
Blocked by: —
Spec: .scratch/staging-v4-cutover/spec.md#disk-backed-release-workspace--preflight-2026-09-05

## Что сделать

Устранить подтверждённый preflight blocker: большие deploy/rollback workspaces сейчас жёстко
создаются в `/tmp`, который на VPS является маленьким tmpfs. Разместить их в уже защищённой
дисковой области staging без перенастройки хоста, сохранив все проверки пространства и identity.

## Границы

- Сначала прочитать текущие initialization/cleanup/tree-replacement seams и обосновать root выбора.
  Предпочитать уже проверенный persistent runtime root; ни backup files, ни release-store inventory
  не должны смешиваться с временными артефактами или удаляться.
- Узкая правка существующих deploy/rollback и их общего lifecycle, без общего нового storage framework.
- Не ослаблять guards, не редактировать issue 05, UI, БД, secrets, workflow timeouts.
- Никаких live/network/deploy операций. Коммит и публикацию делает координатор после общих gates.

## Файлы

- scripts/staging-deploy.sh, scripts/staging-rollback.sh — создание private workspace.
- scripts/staging-release-common.sh — только если нужен общий существующий seam/проверка parent authority.
- test/staging-deploy.test.js, test/staging-rollback.test.js — поведенческие регрессии на operator seam.
- Этот тикет; ограниченное уточнение operator docs только после согласования списка с координатором.

## Definition of Done

- [x] Новый workspace не размещается на RAM-backed `/tmp`; родитель проверен до создания.
- [x] Normal/failure/recovery сохраняют exact identity и соседний backup sentinel; cleanup ограничен owned workspace.
- [x] First-deploy и rollback сохраняют контракт; guards и existing tests не ослаблены.
- [x] Focused TDD и независимые Standards/Spec review пройдены.
- [x] Общие lint/check/npm test прошли; новый helper artifact подготовлен, отдельный коммит делает координатор.
- [ ] Linux CI проверен до owner installation.

## Evidence

Workspace parent: `$app_dir/rollbacks`, with private random children beside `releases/`.
`captureProtectedRuntime` already binds its device/inode/owner/mode, `clear_release_tree`
preserves the whole parent during promotion and recovery, and backup pruning scans only
`backups/`. Capacity accounting already sums requirements sharing one device. Implementation
and focused TDD use the existing deploy/rollback operator seam; common gates, review,
commit/push and helper artifact remain coordinated by the root agent.

Implementation: both entrypoints initialize cleanup state and install their cleanup trap before
creating `$app_dir/rollbacks/easyboost-staging-{deploy,rollback}.XXXXXX`. Parent authority is
verified before and after `mktemp`; the private directory's device/inode/type/owner/group/mode
is captured. Known workspace writes use the existing bounded-command lifecycle with a fresh
workspace check; recovery and each final chmod/removal boundary retain that same authority.
Admission arithmetic, headroom, reservations, release inventory and locking are unchanged.

Focused TDD demonstrated the original RAM/caller-TMPDIR placement in both entrypoints and
foreign workspace deletion on early deploy cleanup. Spec review additionally reproduced late
archive writes into a replaced directory: deploy wrote `previous.tar.gz`; rollback wrote
`previous.tar.gz` and `target.tar.gz`. Both archive-write regressions now pass with only the
foreign sentinel remaining, and byte-identical sibling release-store inventory. The final
rollback removal regression replaces the workspace specifically after recursive `chmod u+w`
and confirms both directories survive with an explicit recovery-required marker.

Final-source targeted archive/write/removal run: 3 tests passed, 0 failed (44.7 s). Final targeted
normal/failure/recovery/first-deploy and parent-refusal run: 17 tests, 15 passed, 0 failed, 2 skipped
(366.8 s). Across these two final-source commands: 20 tests, 18 passed, 0 failed, 2 skipped.
The skips are POSIX insecure-mode cases on Windows; they remain required in the coordinator's
Linux gate. All three shell files pass `bash -n`; both test files pass local ESLint; scoped
`git diff --check` passes. Independent Standards and final Spec re-review each report 0 findings.
No existing test was removed. Three helper files and two operator test files are frozen for
the coordinator's broad gates; no full test file, `npm test`, commit/push or live operation was
run by the implementation agent.

Предыдущий полный Windows gate для issues 06–08 уже завершён успешно (3218 tests, 0 failures)
и опубликован как `b2b0b0f`; при старте тикета CI #122 ещё шёл в отдельном GitHub checkout.
Текущее состояние Linux CI и общих gates ведёт координатор. Во время нового общего operator gate
helpers должны быть frozen.
Точные read-only disk metrics и формула сохранены в server-baseline.md. Урезание archive не является решением.

### Frozen-source follow-up: workspace operation allowlist

The common Windows gate exposed the existing static test at `test/staging-deploy.test.js:1525`:
its global no-mode-switch assertion also matches the workspace admission line
`case "$operation" in deploy|rollback) ;; *) return 1 ;; esac`. The ordered finalizer and
literal callback assertions pass; this is unrelated to finalizer dispatch behavior.

While common gate 54201 still owns the source freeze, the proposed change exists only in
`.scratch/staging-v4-cutover/debug/staging-release-common.finalizer-guard.sh`. It is a mechanical
copy of the common helper with exactly one replaced line:
`[ "$operation" = deploy ] || [ "$operation" = rollback ] || return 1`.
The real helper and deploy test remain byte-identical to their frozen inputs.

Focused proof: the unchanged existing test callback, extracted without modifying any assertion,
fails at its existing `doesNotMatch` assertion against the frozen helper (RED), then passes every
assertion against the proposed copy (GREEN). Twenty isolated Git Bash admission probes confirm
both spellings accept exactly `deploy` / `rollback` and reject all 18 tested invalid values with
status 1, including empty, mixed-case, whitespace, newline, path, wildcard and shell-token inputs.
The full proposed copy passes `bash -n`. A byte comparison proves no other source changes.

Frozen actual common SHA256: `4c000e2193e82f6bd7b012697ca833cd083574386067ce2af4d2052a2f19447e`.
Proposed copy SHA256: `f667daac6d5bc94090f9f027160e2abc04209a26ad747ef4445288b9f8de6b3b`.
Frozen deploy-test SHA256: `3494de7a88682f532ad4a3617e3d0b4c04c518fba906ac05e15c279ca160dcfe`.
No real workspace function, full suite, network/live operation or commit was run in this follow-up.
Integration, the unchanged focused test under the real runner, final review/common gates and a
fresh exact helper artifact remain coordinated by root after its explicit source-freeze release.

### Frozen-source follow-up: combined capacity fixture

The existing capacity scenario at `test/staging-deploy.test.js:1896` also fails on the frozen
helper bundle. A mechanically copied `test/staging-deploy.capacity-diagnostic.mjs` reproduced
the same `ENOENT` reading `commands.log` in 13.26 s. Targeted temporary instrumentation then
proved status 68 with `Insufficient upload storage capacity and headroom`: the first `df`
targets the new disk workspace under `app/rollbacks/`, where the Docker journal does not yet
exist. Cleanup removes only that owned workspace; the journal was absent before cleanup too.
The expected `commands.log.*` state and workspace sidecars exist beside the expected journal,
ruling out a Node/Bash path mismatch. All temporary instrumentation has been removed.

The fixture's `FAKE_LOW_APP_DISK` prefix now includes the disk workspace, and its previous
six-column `df` response is invalid for the requested `--output=avail -B1`. This makes the old
scenario stop at upload preflight instead of exercising combined live/store/temp admission.
The isolated proposal emits the truthful one-column response `Avail\n134217728\n` (128 MiB),
with a comment documenting the chosen range. Every existing assertion remains. New assertions
require status 68 and exactly `Insufficient staging disk capacity before release mutation`,
so an unrelated early refusal cannot satisfy the scenario. No journal is pre-created and no
read error is swallowed; other tests' intentional absent-journal checks are unaffected.

Measured canonical fixture archive metrics, using the real archive validator:
candidate expanded 295 / compressed 403 bytes; predecessor expanded 295 / compressed 402 bytes.
The unchanged constants in `scripts/staging-release-common.sh:53` are 67,108,864-byte headroom
and 268,435,456-byte maximum backup. `reserve_uploaded_archive_space` therefore requires
403 + 67,108,864 = 67,109,267 bytes. `admit_release_space` requires temporary 335,545,715 bytes,
live 335,544,910 bytes and store 67,109,267 bytes. Git Bash `stat -c %d` confirms all three
fixture paths share device 3838503261, so their combined requirement is 738,199,892 bytes.
Thus 67,109,267 < 134,217,728 < 738,199,892: the fixture admits upload and rejects the combined peak.

TDD: the added exact-stage assertion first failed on the original fixture response (13.18 s),
reporting upload preflight refusal. The corrected scenario then passed (18.61 s). Final frozen
copy verification used:

```text
node --test --test-reporter=tap --test-name-pattern='^deploy (admits live/store/temp peak capacity before Docker or active-tree mutation|fails before upload copy when exact pre-copy capacity cannot be reserved)$' test/staging-deploy.capacity-diagnostic.mjs
ok 1 - deploy admits live/store/temp peak capacity before Docker or active-tree mutation
ok 2 - deploy fails before upload copy when exact pre-copy capacity cannot be reserved
1..2
# tests 2
# pass 2
# fail 0
# cancelled 0
# skipped 0
# duration_ms 32102.222
```

The nearby upload refusal test is byte-unchanged. Scoped ESLint passes. Final diagnostic copy
SHA256: `88643e141b6f5fdcbdca50086b6a95eb2bbf77e20785c957bccedb45c5988e4d`.
The actual deploy test remains `3494de7a88682f532ad4a3617e3d0b4c04c518fba906ac05e15c279ca160dcfe`
and actual common helper remains `4c000e2193e82f6bd7b012697ca833cd083574386067ce2af4d2052a2f19447e`.
Review-ready diff: one fake `df` response/comment and three added assertion lines; no other
test/helper changes. Integration and final shared gates remain with root after the source freeze.

### Reviewed follow-up integration after gate 54201

Root reported gate 54201 completed with exit 1 (3231 tests, 3127 passed, 101 skipped,
3 known failures, 0 cancelled) and both frozen follow-up review axes returned 0 findings.
After explicit release of the issue09 source freeze, only the exact reviewed operation
allowlist and capacity fixture/assertion changes were integrated with `apply_patch`.
The actual files were byte-compared against their reviewed copies before copy removal:

- `scripts/staging-release-common.sh` SHA256:
  `f667daac6d5bc94090f9f027160e2abc04209a26ad747ef4445288b9f8de6b3b`.
- `test/staging-deploy.test.js` SHA256:
  `88643e141b6f5fdcbdca50086b6a95eb2bbf77e20785c957bccedb45c5988e4d`.

The two owned diagnostic copies were removed with `apply_patch` only after matching their
reviewed bytes to the integrated files. Their reviewed content remains in the actual files;
no other implementation changes followed. Both actual files are frozen for root's next gate.

Final focused verification uses the actual test file and pinned Node 22.23.2. An initial
runner-only pinned pass (3/3) was superseded after a read-only check exposed duplicate Windows
environment keys `PATH` and `Path`: PowerShell prepending uppercase `PATH` alone left Git Bash
resolving the system Node 24. The final process-local launch clones the environment, removes
all case variants of its path key, then sets one `PATH` with the pinned Node directory first.
Before launching tests, it asserts both the runner version and Git Bash `node --version` are
`v22.23.2`; `type -P node` resolves `/tmp/node-v22.23.2-win-x64/node`.
No persistent environment setting or source change was needed.

```text
node --test --test-reporter=tap --test-name-pattern='^deploy (and rollback use one common ordered release finalizer without mode switches|admits live/store/temp peak capacity before Docker or active-tree mutation|fails before upload copy when exact pre-copy capacity cannot be reserved)$' test/staging-deploy.test.js
ok 1 - deploy and rollback use one common ordered release finalizer without mode switches
ok 2 - deploy admits live/store/temp peak capacity before Docker or active-tree mutation
ok 3 - deploy fails before upload copy when exact pre-copy capacity cannot be reserved
1..3
# tests 3
# pass 3
# fail 0
# cancelled 0
# skipped 0
# duration_ms 30752.0842
```

Scoped whitespace checks pass. No full suite, commit, push, network or VPS operation was run
by this integration task. Root retains the final common gate, artifact rebuild and publication.

Coordinator final gate: pinned Node22.23.2, normalized PATH, concurrency2, TAP;3233tests,
3132passed,101platform skips,0failed/cancelled,3720731.8831ms. All7 frozen source hashes match
after completion. Lint/check/secrets and independent reviews passed. Helper bundle7ab70170
is canonically verified; post-commit Git-blob comparison and actual Linux CI remain required
before owner installation. No live mutation was performed.
