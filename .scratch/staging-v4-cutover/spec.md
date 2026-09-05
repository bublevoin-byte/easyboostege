# Staging v4 cutover

## Цель

Без потери работающего staging и PostgreSQL volume завершить первый переход с legacy release state
на проверяемый `immutable-archive-v4`, после чего штатные deploy/rollback снова должны работать.

## Наблюдаемое исходное состояние

- На staging работает pre-v4 code tree и контейнеры; readiness остаётся зелёным.
- `.release-sha256` относится к старому `git archive`, но `rollbacks/releases/` не был создан/заполнен.
- v4 helper установлен, а неуспешная попытка оставила authenticated deadline/session recovery residue.
- Старый archive не является canonical v4 archive, а старый `compose.staging.yml` не соответствует v4
  local-only image/guarded-context contract.

## Инварианты

- Ни recovery, ни cutover не удаляют staging PostgreSQL container, volume, network, данные или backup.
- Обычный deploy не угадывает legacy state и продолжает fail-closed без explicit cutover.
- Все mutable operator paths находятся под существующими release/host locks и bounded supervisor.
- Любая authority/identity/byte mismatch останавливает операцию до мутации либо оставляет точную
  recovery authority; broad/glob cleanup запрещён.
- Успех заявляется только после exact archive+sidecar+marker/store, stable/running image и readiness proof.

## Recovery collision

Issue 01 устраняет зацикливание authenticated deadline/session retirement, не ослабляя identity checks и
не превращая ручное удаление `/tmp` control namespaces в допустимый runbook.

## Adopt legacy staging

Issue 02 добавляет отдельный one-time cutover entrypoint. Operator передаёт canonical bridge archive,
его full SHA, наблюдаемый legacy marker SHA и SHA legacy Compose. Bridge обязан совпасть с live tree во
всех именах/байтах кроме exact `compose.staging.yml`; новый Compose проходит v4 validator. Команда
доказывает running app/PostgreSQL image identities, привязывает уже работающий app image к stable tag,
атомарно публикует bridge archive+sidecar+marker и не вызывает Compose `down`, `up` или DB migration.

## Не входит

- Production deploy, перенос или публикация секретов.
- Откат/down-migration PostgreSQL.
- Удаление старого staging ради clean first-deploy.
- Ослабление canonical archive, release-store, Compose, image или recovery проверок.

## CI repair после run 33870937009

Исходная точка: `944b9b8`; 11 падений Linux CI объединены в 9 причин. Цель — устранить
подтверждённые ошибки в существующих operator seams, сохранив контракты и работающий staging.

- Transaction supervisor сохраняет точную retirement authority, возвращённую POSIX `dispose()`,
  во всех трёх путях завершения. Неполное transaction recovery возвращает status 125 и authority.
- Standalone POSIX/deadline cleanup сохраняет прежний контракт логического завершения с retained
  evidence; transaction cleanup/completion использует явное строгое требование reclaim, в том числе
  при повторном retirement/publication recovery. Ранее подтверждённые отсутствующие стороны
  сохраняют `null`, а не получают новый путь. Глобальная замена standalone контракта или ослабление
  identity/ownership checks запрещены.
- Cutover вычисляет корректный 64-символьный hex nonce и проходит существующие Linux
  success/refusal/roll-forward сценарии.
- Тестовые assertions соответствуют закреплённому Node 22.23.2 и действующему runbook. Linux
  fixtures используют приватный безопасный Node, правильный displaced inode path и полную
  PostgreSQL container/volume authority. Проверки отказа и защиты остаются обязательными.
- Проверки: существующие CLI/operator и exported supervisor seams; новые регрессии только для
  подтверждённых ошибок. Focused checks, независимый Standards/Spec review, lint/check/npm test
  перед коммитами; Linux CI обязателен перед следующим deploy.

Вне объёма: issue 05, изменение UI/БД, ручное удаление recovery evidence и запуск живого deploy.

## Disk-backed release workspace — preflight 2026-09-05

Read-only preflight подтвердил отдельный blocker настоящего deploy: `/tmp` — tmpfs размером
982 MiB, 778 MiB свободно. Уже известная пара candidate/bridge требует 900201716 свободных байт
на temporary device после замораживания двух archive copies; даже перенос upload не доказывает
admission. Root filesystem имеет около 4490 MiB свободного места. Действующий staging здоров.

Issue 09 — узкая совместимость существующего release workflow с этим storage layout:

- Большие приватные workspaces deploy/rollback размещаются на диске, обслуживающем staging,
  а не в глобальном RAM-backed `/tmp`. Предпочтителен уже защищённый persistent runtime root,
  если его сохранность через tree replacement и независимость от backup files доказаны кодом.
- После чтения lifecycle выбран existing captured `$app_dir/rollbacks`: workspace — приватный
  sibling `releases/`, не часть retained archive inventory. `clear_release_tree` сохраняет весь
  `rollbacks/`; backup pruning работает только в `backups/`. Read-only VPS probe подтвердил
  `rollbacks/` на disk device 64769, root:root 0700, available 4490 MiB.
- Сохраняются private ownership/mode, exact captured directory identity, bounded cleanup,
  capacity admission/reservations, locking и восстановление предыдущей версии.
- До создания workspace проверяется безопасная authority родителя. Symlink/rebound/unsafe mode
  должны приводить к отказу; чужие файлы, настоящие backups и recovery evidence не удаляются.
- Не добавлять общую систему storage или произвольный небезопасный environment override.
  Сначала использовать существующие helpers/seams. First-deploy и rollback не должны регрессировать.
- Добавить поведенческие регрессии на существующем operator seam; проверить normal/failure/recovery,
  отсутствие больших workspace в `/tmp` и сохранность соседнего backup sentinel.
- Локальные общие gates, независимые review и Linux CI остаются обязательными. Existing helper
  candidate `aa670f75` относится только к issues 06–08; после issue 09 нужен новый exact artifact.

Не входит: remount/reconfigure `/tmp`, изменение сервисов VPS, root-wide cleanup, уменьшение
запасов места, сжатие/урезание release inventory ради обхода admission, DB migration/restore,
production deployment или переработка отложенного issue 05. Установка новых helpers — только owner action.

## Linux lock-fixture backup stream — CI 122

CI run 33932297652 at b2b0b0f passed the build lock exclusion, then the first deploy in
`staging-release-lock.integration.test.js:557` exited 1 before active-state mutation. The fixture
has no `compose exec ... pg_dump` response; the production deploy requires a nonempty bounded
backup stream for its active predecessor. A diagnostic that executes the exact generated fake
Docker script with the production pg_dump argument tuple reproduces status 0 / zero bytes.

Issue10 is restricted to this existing test fixture and its verification: provide a deterministic
nonempty synthetic backup response for the exact approved pg_dump command, retain every real-flock,
identity, exclusion, recovery and cleanup assertion, and add a fast regression at the fixture seam.
Confirm the first deploy can continue beyond backup, and require actual Linux CI for the complete
real-flock scenario. Do not weaken production backup checks, change timeout/lock protocols, claim a
synthetic payload is a valid PostgreSQL restore backup, or modify issue09's production files.

## Bounded Windows test-fixture timeout — local gate

The frozen 09/10 common Windows gate exposed an existing test-harness liveness defect in
`test/postgres-restore-supervisor.test.js`. Its watchdog fault case exceeded the15s fixture deadline;
all test bodies subsequently reported, but its Node worker retained open handles and did not exit.
The unchanged isolated watchdog case passed. A minimal exact-`runBashFixture` probe with a finite
8s child sleep rejects at the1s timeout but keeps the Node worker alive for8136ms, reproducing the
missing bounded local fixture settlement independently of real database logic.

Issue11 is restricted to this local behavioral test harness and regression tests. Preserve the
original timeout error and all existing assertions; settle the exact test-owned child/process resources
within a bound, or report settlement uncertainty without hanging the test worker. Do not hide live
children by merely unref-ing handles, increase existing deadlines, weaken remote restore authority,
or change production scripts. Use existing process-lifecycle seams where suitable; no new generic
process framework. During the active frozen 09/10 gate, work only in a separately named diagnostic
copy that is outside the npm unit-test glob. Integrate into the real test file only after root releases
the source freeze. A final full gate remains required for the integrated version.

## Observable Linux lock lifecycle — CI123 diagnostic loop

### Problem Statement

The owner still cannot install the verified release: CI123 now gets past its first successful
deploy but times out before the rollback tree barrier. Its432379ms failure contains empty stderr,
so it does not distinguish slow installed preflight, build, activation or test dispatch. The
generated-fixture sequence passes locally; Docker Desktop also reports PID0 for an exited flock
recorder even in the host PID namespace under an unprivileged probe. Neither is an exact red loop.

### Solution

Make this existing integration scenario report a small, bounded, test-owned phase/timing snapshot
when a barrier fails, and emit a few lifecycle milestones during the actual scenario. This builds
the missing diagnostic feedback loop. It is not a claimed fix for the rollback timeout.

### User Stories

1. As the owner, I want the failed test to name the last completed phase so that repair is based
   on evidence instead of another guessed production change.
2. As the maintainer, I want elapsed time from the actual child start so that slowness can be
   separated from dispatch failure without increasing the barrier deadline.
3. As the maintainer, I want bounded captured output and fixture state before cleanup so that
   teardown does not erase the only evidence.
4. As the owner, I want the same safety assertions and resource cleanup to run so that diagnostic
   work does not make a failing deployment appear successful.
5. As the owner, I want no live server access or secret values in diagnostics.

### Implementation Decisions

- Change only the existing real-flock integration test and its test-local helpers/fast regressions.
  Reuse its generated fake Docker and existing barrier directory; no production abstraction,
  workflow change, package/dependency change, configurable diagnostic service or new operator mode.
- Record a fixed allowlist of synthetic phase names around existing build/config/up operations;
  no arbitrary command arguments, environment values, database output or secret-bearing text.
- Capture existing stdout/stderr only under a strict small output limit on failure, as the current
  test already captures stderr. Include monotonic child elapsed time, last observed phase and
  existing activation-count/tree-barrier state before the common cleanup. Keep errors honest if
  diagnostics cannot be read; never mask the original failure or skip cleanup.
- Preserve every original assertion, default120000ms barrier deadline, operation ordering,
  command tuple, image/container/lock authority and process-settlement behavior. Milestones
  must not wait for consumer input or alter the fixture's activation/recovery gates.

### Testing Decisions

Use the existing generated-fixture lifecycle and barrier-wait seams. New fast tests must first
show that a stalled finite test-owned child lacks the required diagnostic, then prove that the
failure includes bounded phase/timing/state evidence without changing the failure verdict. Cover
normal dispatch, missing diagnostic data and retained cleanup behavior. The full actual Linux
scenario still must run in CI; local fixtures are not proof of its cause or success.

### Out of Scope

No guessed production fix, timeout increase, guard bypass, public API/UI change, PID0 workaround,
VPS instrumentation, install/recover/cutover/deploy, new CI pipeline or issue05 redesign.

### Further Notes

This is a bounded continuation under the owner's autopilot request, not a declaration that the
remaining failure is only cosmetic or that more changes will be necessary. Root owns review,
common gates, authorized branch publication and the actual CI observation. Once the exact stalled
phase is known, choose only the repair justified by it and remove temporary instrumentation.

## Observable host-lock settlement — CI123 diagnostic loop

### Problem Statement

Two additional CI123 failures stop the same release: the unchanged successful-release and typed
retention scenarios report100ms timeouts. Sixty focused repetitions on WindowsNode22.23.2 and
sixty on localLinuxNode22.23.1 all pass. Injecting125ms of durable-I/O latency into the actual
unchanged test cases reproduces both exact timeout messages; this demonstrates sensitivity but
does not establish that the actual GitHub runner had this latency.

### Solution

Report whether the timed-out operation had settled successfully, together with its elapsed time
and a safe classification of any underlying error. Keep the existing failure and every deadline.
This supplies discriminating evidence in the next actual CI run instead of guessing a repair.

### User Stories

1. As the owner, I want to distinguish a slow successful operation from a failed lock mutation.
2. As the maintainer, I want evidence captured at the existing call before fixture cleanup.
3. As the maintainer, I want the original exception and timeout behavior preserved exactly.
4. As the owner, I want no database, live server, secret or production behavior change.

### Implementation Decisions

- Restrict changes to the two failing host-lock integration test call sites and a small test-local
  evidence seam. Record a fixed action label, monotonic elapsed time, existing settled/succeeded
  boolean flags and allowlisted cause classification. No arbitrary paths, arguments or environment.
- Diagnostic failures must not mask or replace the original operation error. Pass the same error
  object through. Do not retry the mutation, swallow errors, adjust100ms/5ms deadlines or alter
  any original assertion/order/ownership/inode/link/retention/cleanup requirement.
- Do not change the production lock module, test runner, workflow or unrelated scenarios.

### Testing Decisions

Use the real exported bounded release/retain operations and existing test-local callback seam.
First prove missing evidence with a finite deliberately slow action; then assert exact rethrow,
settlement flags and bounded classification after instrumentation. Cover success, underlying
failure and diagnostic failure. Preserve the existing intentional5ms deadline test unchanged.
Focused tests, independent reviews and one integrated root gate precede a scoped commit.

### Out of Scope

No claimed repair of unobserved CI I/O, deadline increase, fake clock bypass, production change,
generic tracing framework, retry loop, live server instrumentation or deployment.

### Further Notes

Ticket13 is disjoint from ticket12. Both are diagnostic preparation for the same next CI; neither
clears0898f55 for installation. The tagged scratch latency probe remains diagnostic-only.

## Installed preflight timing — CI124 diagnosis

### Problem Statement

CI124 repeats the exact rollback barrier timeout while the two100ms host-lock cases pass. The
new evidence shows successful first deploy build barrier107453ms and completion329976ms; rollback
times out120007ms after its start, last phase config-json-complete, no activation count, no output.
Configuration checks may repeat, so the single last phase does not identify the entire earlier path.

### Solution and User Stories

1. As the owner, I want the cost of the actual installed helper preflight measured, so the next
   repair addresses observed behavior instead of increasing a deadline by guesswork.
2. As the maintainer, I want a fast reproducible command at an existing verifier/operator seam,
   so each proposed cause can be falsified without another blind full-CI cycle.
3. As the owner, I want lock, identity, archive, runtime and cleanup protections preserved.
4. As the owner, I want no server instrumentation, paid service or source mutation for diagnosis.

### Implementation and Testing Decisions

- Diagnosis only. Reuse actual installed-helper generation/runtime verification and the existing
  integration fixture or its narrow exported seams. Prefer small fixed local inputs and existing
  cached runtimes. Keep throwaway probes explicitly tagged under a local debug directory.
- First produce an executed fast red-capable timing/phase loop on the relevant actual path;
  distinguish observed bottleneck from an exact reproduction of the whole CI failure. State
  limitations if the local Linux PID0 behavior prevents faithful installed execution.
- Compare one variable at a time and record exact invocations, durations and evidence. Do not
  select a production repair or rank speculative causes without a usable feedback loop.
- Do not bypass process identity/real-flock guards, fabricate PID evidence, raise deadlines,
  remove assertions or duplicate a whole production module just to make a probe run.

### Out of Scope

No implementation fix, production/test/workflow edits, new dependency or runtime installation,
network/VPS actions, commit or push from the diagnosis worker. Root owns any later justified
repair specification, fresh implementation ticket, review and common gates.

## Native Linux diagnostic feedback — CI124

### Problem Statement

The sole CI124 failure is a real-flock rollback tree-barrier timeout. Local bounded descriptor
and inherited-chain profiling is now available and passes, but Docker Desktop reports a different
flock owner identity and cannot faithfully execute the whole scenario. Waiting for the entire
canonical suite before seeing each diagnostic result makes this repair unnecessarily slow.

### Solution and User Stories

1. As the owner, I want the exact failing Linux scenario observed early on the same native runner
   class as CI, so the repair is based on actual runtime evidence.
2. As the maintainer, I want a short separate diagnostic job without changing the required release
   gate, so diagnostic success can never be mistaken for release clearance.
3. As the owner, I want no deployment, server access, credentials, dependency changes or weakening
   of any lock, identity, archive, deadline or original test assertion.
4. As the maintainer, I want a small bounded read-only profile of owned child-process stages,
   so a repeated timeout identifies where time was spent without printing arguments or environment.
5. As the maintainer, I want measurement limitations stated, so sampled residency is not presented
   as CPU time or proof of a root cause.

### Implementation Decisions

- Add a separate native-Linux diagnostic workflow, restricted to pushes on the already-authorized
  prototype branch and relevant diagnostic/lock changes. Keep the canonical workflow byte-for-byte
  unchanged. Read-only repository token; no secrets, SSH, deploy steps or global settings.
- Use the existing pinned Node version and existing exact integration test with all assertions
  and its original120000ms barrier deadlines unchanged. No patched copy of production code.
- A diagnostic-only runner may spawn only that fixed test invocation and sample its proven owned
  descendants through Linux process metadata. Do not read process environments; never emit full
  argv, paths, user content or command output beyond the original test's own output.
- Emit only fixed allowlisted helper/tool categories and bounded counts/timing summaries. Unknown
  or disappearing processes are omitted or classified as unknown; never infer authority from a PID
  alone. Sampling must not signal children or replace the original test's exit status.
- Bound the diagnostic job independently. State that snapshots measure sampled process residency,
  include nested/overlapping processes, and do not establish the CI124 cause by themselves.

### Testing Decisions

Keep all existing tests intact. Test the runner's narrow observation/aggregation boundary using
finite synthetic processes and classification/identity-change/missing-process cases. Demonstrate
that test failures retain their exit status, raw arguments are never serialized, output stays
bounded, and sampling does not leak a timer after the child exits. Existing full local gates remain
historical evidence; required integration checks and independent reviews precede publication.

### Out of Scope

No production fix, timeout increase, PID0 acceptance, generic profiler framework, extra packages,
VPS work, deployment, changes to main/production-hardening or publication of local recovery data.

## Native bounded-command timing baseline — diagnostic1

### Problem Statement

The exact rollback tree timeout also reproduces in the isolated native diagnostic job: successful
deploy304610ms then rollback still absent at120021ms. Category residency cannot distinguish CPU,
durable-publication or repeated command startup costs. Existing fast local component measurements
exercise real descriptor/inherited authority but have not run on the same GitHub runner class.

### Solution and User Stories

1. As the owner, I want a short measurement of actual bounded helper commands on native Linux,
   so we can compare the same path with the already measured local baseline before selecting a fix.
2. As the maintainer, I want component measurements separated from the full failing scenario,
   so a green component cannot be mistaken for deployment readiness or an exact reproduction.
3. As the owner, I want no additional runtime installation, server access or weakened guard.

### Implementation Decisions

- Reuse the existing local descriptor/inherited-chain timing approach at real exported control,
  invocation and supervision boundaries; no patched production module, fake authority or bypass.
- A fixed Linux-only diagnostic command measures a small declared matrix of real no-op commands,
  repeat/nesting variants and existing common helper/Compose validation. Accept no arbitrary CLI
  command, environment dump or server input. Synthetic fixture data stays in one private temporary
  directory; validate its scope and clean only owned artifacts with normal production settlement.
- Run this short baseline as an early step in the existing separate diagnostic workflow before
  the unchanged real-flock scenario. Keep canonical CI and existing product/test inputs unchanged.
- Emit bounded fixed-category numeric timings/status only. Retain a clear component-scope disclaimer;
  measured overhead is not a chosen cause. Existing sampling and original scenario remain intact.

### Testing Decisions

Run the exact component baseline on the cached local Linux runtime, then the published native job.
Check fixed invocation, finite execution, real authority/status assertions, safe owned cleanup and
bounded output. Reuse already tested production seams instead of adding a profiling framework.
Independent reviews and fresh common checks precede publication; root owns full gate reuse evidence.

### Out of Scope

No production repair, changed deadline/assertion, dependency installation, new remote service,
canonical workflow change, live host action, mutable recovery data or machine-wide tracing.

## Rollback-only feedback-loop minimisation — native diagnostic2

### Problem Statement

Two isolated native runs reproduce the original rollback/tree120-second timeout, but each first
spends305–325seconds completing a successful fixture deployment. The native component matrix
is green and around1.5times slower than local; it cannot establish the cause of the full timeout.
We need a smaller real rollback invocation before choosing or implementing a production change.

### Solution and User Stories

1. As the owner, I want diagnosis to reach the failing rollback directly, without repeating the
   already successful deployment setup whenever that setup is not load-bearing.
2. As the maintainer, I want the prepared synthetic state checked against the original scenario's
   post-deploy contract, so a shortcut cannot manufacture an unrelated missing-state failure.
3. As the owner, I want existing security guards, tests, server state and deployment permissions
   unchanged; an unsuccessful minimisation must be recorded honestly rather than called a fix.

### Implementation Decisions

- Build one fixed local diagnostic attempt using existing hermetic release/installer/fake-Docker
  fixture seams and the actual installed rollback launcher, without changing production modules.
- Prepare only synthetic state equivalent to the successful first deployment: active candidate
  tree/marker, both canonical retained archives and sidecars, image/container/release fixture state,
  protected metadata and generation binding. Prove the equivalence requirements explicitly.
- Retain the original tree-barrier expectation and120000ms bound. Record timing and verdict
  separately from later process settlement. Do not increase deadlines, accept PID0, fake authority,
  disable hashing, patch scripts or seed any live application directory.
- All writes and cleanup belong to a new private disposable fixture. Preserve exact child failure
  and evidence on uncertain settlement. Accept no arbitrary command or production path input.
- Native publication remains a separate root decision after the attempt and independent reviews.
  The diagnostic workflow, sampler and canonical CI stay unchanged for this local attempt.

### Testing Decisions

Run fixed fixture/equivalence contracts and the finite local cached-Linux attempt, without repeating
the known full Docker Desktop exited-flock PID0 failure. Distinguish a real matching timeout from
environment refusal, setup error, green barrier, and incomplete cleanup. If the setup cannot be
removed safely, deliver the concrete evidence and retain the existing native reproduction.

### Out of Scope

No production optimisation or architectural rewrite, weakened test, new workflow push, live host
work, dependency download, generic profiler, whole-machine process control or readiness claim.

## Native rollback-only diagnostic execution

### Problem Statement

The reduced rollback fixture is now locally reviewed, but Docker Desktop refuses maintenance-lock
evidence before the native failure. Another local attempt cannot establish whether removing the
successful-deployment prefix preserves the original timeout. Native Linux is already available
through the authorized diagnostic branch's GitHub Actions workflow.

### Solution and User Stories

1. As the owner, I want the reduced real rollback attempted on native Linux to shorten diagnosis.
2. As the maintainer, I want exact barrier timing and launcher outcome separate from settlement.
3. As the owner, I want a failed diagnostic confined to its disposable test machine, never my VPS.
4. As the maintainer, I want the existing full reproduction and canonical release gate unchanged.

### Implementation Decisions

- Add one independent standard GitHub-hosted Ubuntu job, not a Docker container, self-hosted
  runner or live server. Pin the same22.23.2 runtime. Its total job bound is6minutes.
- Reuse the fixed reviewed rollback-only command and its focused contracts. No generic command
  interface, extra parameters, new supervisor or alternate production implementation.
- The actual rollback is the last user-defined step in its dedicated job. Retain the private
  fixture and any uncertain descendants for outer disposable-machine retirement; never equate
  launcher exit or pipe closure with independent proof that all descendants have settled.
- Clarify the diagnostic's lifecycle label/documentation for either the existing disposable local
  container or this dedicated hosted VM. Do not change its120000ms tree assertion,210000ms outer
  lifetime,30000ms settlement budget, fake-Docker inputs or production safety authorities.
- Checkout has no persisted credentials; contents-read permission only. No environment secrets,
  npm installation, Docker service, server network requests, uploads, deployment or artifact reuse.
- Preserve the existing component/sampler/full-scenario job and canonical workflow byte-for-byte
  apart from the diagnostic workflow's added job and its exact reduced-script path trigger.
- Root owns review, scoped commit/push to the authorized branch and collection of the native
  result. Red, green, environment refusal and incomplete settlement are evidence, not clearance.

### Testing Decisions

Existing finite-child/status/equivalence diagnostic contracts are the test seam. Run focused
contracts and syntax/lint after the lifecycle wording change; review the workflow configuration
and execute the exact reviewed command on the new native job. Preserve the original scenario's
independent result. Record native outcome once, including stage, timing, status and limitations.
No unchanged full local suite repetition; existing input equality must be checked by root.

### Out of Scope

No production optimization, raised deadline, weakened assertion, dependency change, VPS action,
process-control framework, recovery authority mutation or claim the application is ready to deploy.

### Runner evidence

GitHub documents a fresh hosted runner image per job, with standard Ubuntu runners using VMs:
[GitHub-hosted runners](https://docs.github.com/en/actions/reference/runners/github-hosted-runners).
This outer disposal boundary is not evidence of the production helper's own successful cleanup.

## Reduced rollback phase progression after the unchanged assertion

### Problem Statement

The first native reduced rollback exceeds120seconds after build-complete, rather than the full
scenario's config-json-complete snapshot. Its launcher is still unsettled after150seconds. This
does not distinguish slow forward progress from a stopped operation or prove the cause.

### Solution and User Stories

1. As the owner, I want measured phase progression before selecting a production change.
2. As the maintainer, I want the original120second failure preserved even if completion is late.
3. As the owner, I want this extra observation bounded and restricted to the disposable native job.

### Implementation Decisions

- Keep the actual tree assertion at120000ms, original full test, every production helper/guard,
  prepared fixture, invocation and workflow unchanged. A late tree or clean exit never erases the
  frozen initial failure or turns the diagnostic green.
- Observe only the existing allowlisted fake-Docker phase file and tree marker. Capture a bounded
  timeline of observed phase-file updates, not raw command arguments or internal authority data.
  The same phase name can recur at different rollback sites; sampled modification metadata may
  distinguish observed rewrites, but cannot establish exact call counts or capture every fast write.
  Use a low-rate bounded poll (at most once per500ms), a fixed maximum16rows and explicit omitted
  count; one report must fit the existing2048byte line cap. This is sampling, not exact CPU timing.
- After capturing the initial assertion, release the same fixture barrier and allow up to180000ms
  of further observation/settlement. Raise only the disposable diagnostic process's outer watchdog
  to330000ms, still inside the existing6minute dedicated-job limit. These are evidence-collection
  budgets, not production timeouts or a relaxed120second assertion. The outer bound takes priority.
- Track any late tree appearance and final phase separately from initial snapshot and actual
  launcher exit/pipe settlement. Preserve exact child failure and uncertain-descendant evidence;
  do not signal or erase unproved descendants. No new supervisor, generic profiler or command CLI.

### Testing Decisions

Use the existing real child/observer seam with finite synthetic children that advance the existing
phase file and create a late tree marker. Test the same orchestration used by the actual command
with a short injected observation budget only through its module test seam, never CLI/env input.
Prove a late successful child cannot erase the earlier failed assertion, nonzero exit is retained,
and timeline/output bounds hold. No120second local retry; native publication remains root-owned.

### Out of Scope

No production fix, altered canonical or full-test deadline/assertion, dependency download, VPS
mutation, machine-wide process control, arbitrary trace output or premature cause/readiness claim.

## Attribute successful bounded-command overhead before changing production

### Problem and diagnostic phase decision

Native ticket19 now reproduces the exact120second timeout in the reduced real rollback, then
observes late tree144073ms and clean helper234109ms. This is slow forward progress on that run,
not a proven deadlock. The original assertion itself cannot fail in seconds; requiring its full
120seconds for each component experiment is not a useful tight loop. Explicitly retain that
unchanged native scenario as the red-capable final validation, while using the already executed
real bounded-command component (seconds, not minutes) for attribution. This is a justified
performance-branch refinement of diagnosing-bugs phase1, not a bypass of original validation.

### User stories and ranked predictions

1. As the owner, I want the next production change selected by measurements, not another guess.
2. As the maintainer, I want to separate useful child work from per-command admission/settlement.
3. As the owner, I want investigation confined to synthetic local fixtures without touching the VPS.

Ranked, potentially cumulative hypotheses announced to the owner before experiments:
- Repeated command-supervision overhead: nearly-empty true commands still consume substantial
  time, and sequential/nested totals grow with command count/depth. Existing matrix supports
  investigating this pattern but does not attribute its cost to one function.
- Repeated runtime/file verification: measured CPU/file work in real authority construction and
  validation accounts for a material part of the empty command's cost. A bounded CPU/timing
  profile should show that work rather than treating sampled process residency as CPU usage.
- Fixed waits during child settlement: wall time after useful child completion exceeds measured
  CPU/work and aligns with actual supervisor wait sites. Existing lifecycle seams should separate
  these costs without substituting fake success, bypassing guards or signalling unknown processes.

### Deliverable and boundaries

Use the existing installed real bounded-command/component setup and finite true/Node children to
attribute startup/invocation/settlement cost. Prefer existing seams and read-only profiling; add
only a narrowly scoped local debug probe if necessary. Do not build a general profiler, additional
workflow, process-control framework or production logging. Any added observer must have bounded
output/lifetime and preserve real child errors; test that seam before claiming its evidence.
Record exact commands/runtime/provenance, measurements, limitations and the best-supported next
fix proposal in ticket20. No production edits in this ticket, raised deadline, weakened tests,
dependency/network installation, arbitrary environment dump, full Docker Desktop rollback retry,
VPS actions, publication by the worker or claim of readiness. Root retains scope/review/publication
and original native validation. Do not repeat unchanged full suites or unchanged failed attempts.

## Verify each retained release pair in one bounded operation

### Problem Statement

Ticket19's real reduced rollback reaches its tree barrier only at144073ms against the unchanged
120000ms assertion and completes at234109ms. Ticket20 measures a real recurring inherited-chain
near-empty command at285–301ms; seven separate supervised commands currently implement one
retained archive/sidecar verification. This repeats six times before the reduced fixture's tree
copy. These source-derived counts and local timings justify a composed-operation experiment,
not a promise that this change alone clears the native timeout.

### Solution and User Stories

1. As the owner, I want release verification to avoid repeated command startup while retaining
   every archive, checksum, ownership and identity check.
2. As the maintainer, I want one purpose-specific read-only operation, not a general batch-command
   framework, daemon or authority cache.
3. As the owner, I want malformed, replaced, linked or changed files to fail closed before any
   image or live-tree action exactly as the existing release callers require.
4. As the maintainer, I want all original tests and120second assertions retained, with new tests
   covering the composed operation and a real finite comparison before native validation.
5. As the owner, I want local validation and branch publication distinguished from live deploy;
   this work does not authorize an agent to install or deploy on the VPS.

### Implementation Decisions

- Add one retained-release-pair verification interface to the existing runtime-authority module:
  archive path, expected canonical SHA and role. The sidecar path is derived from the archive.
  The fixed CLI accepts only these arguments; no user-selectable command list, stages, limits,
  callback, cache, filesystem bypass or environment switch.
- Reuse the existing private-file capture, canonical SHA reader, archive validator, and final
  private-file verification implementations. Preserve this order: archive capture (mode0600,
  maximum512MiB), sidecar capture (mode0600, maximum65bytes), canonical sidecar read, compare both
  declared and initially captured digest to expected SHA, full canonical archive inspection,
  final archive identity/bytes verification, final sidecar identity/bytes verification. An invalid
  expected SHA also fails closed. No captured authority is reused across separate invocations.
- Keep shell path/existence/symlink prechecks, every existing caller and its relative transaction
  ordering, but replace that seven-process body with one supervised call. No archive/tree/store/
  snapshot check elsewhere is removed or skipped.
- Use one existing60second command bound for the whole operation; both current command and archive
  inspection bounds are60seconds. This intentionally tightens seven separately bounded commands
  into one60second total budget, never lengthens a deadline. The archive validator retains its
  own existing bounds. Do not add a second nested supervisor or a subcommand launcher.
- Normal verification errors return1 and success returns0 with no authority payload on stdout.
  The shell returns the real supervised operation status on timeout/infrastructure failure.
  This changes the old internal distinction where the first six stages normalized failures to1
  while the last returned raw status. Existing release callers already map any nonzero result to
  their established fail-closed transaction outcome; prove that mapping remains unchanged. Do not
  claim stage-by-stage raw status equivalence. No timeout/cancellation becomes success.
- Keep existing buffer/file/archive limits. Retain only small capture records across phases, not
  a second long-lived full-archive buffer. Assess peak-memory implications of composing formerly
  separate processes; no maximum-archive-size or resource-ceiling increase is permitted.

### Testing Decisions

Use the new operation through its actual module/CLI and the actual shell caller seam. Existing
files and tests remain present and unweakened (repository contract overrides any skill suggestion
to delete old shallow tests). Prefer real small canonical archives and real filesystem mutations
over mocked successful validators. Show RED before implementation, then GREEN for valid pair,
noncanonical/mismatched SHA, malformed/oversized input, mode/link/owner/identity refusal where the
platform supports it, and archive/sidecar drift between capture and final reproof. Test shell
composition uses one bounded command and retains nonzero status/caller fail-closed mapping without
waiting60seconds. Keep any test seam internal; no production fault-injection CLI or env flag.

Run a finite real before/after pair-verification comparison using the already available cached
Linux helper fixture and inherited chain, preserving guard code and recording exact source,
runtime, whole-operation timing and measurement limits. No Docker Desktop actual rollback retry
because its known flock/PID0 limitation is unrelated. Do not rely on a timing threshold assertion
in routine unit tests or present local milliseconds as a native projection.

Root owns fresh focused gates, independent reviews, full local lint/check/test after production
freeze, safe authorized-branch publication, and unchanged native reduced/full CI evidence.
No unchanged diagnostic-only full-suite repeats. Native improvement is not proven until observed.

### Out of Scope

No supervisor/runtime-authority hash removal or cache, broader batching/refactor, new process
control, new workflow, dependency change/download, raised120s or other deadline, deleted/weakened
existing test, VPS upload/install/recovery/cutover/deploy, archive overwrite, or readiness claim.

## Measure remaining protected-boundary startup cost

### Problem Statement

After the measured retained-pair optimization, native diagnostic5 still observes the original
120s empty-output rollback timeout. Its reduced tree arrives at140046ms and clean settlement
at217413ms. The full original scenario is shorter at378334.633317ms but still fails the same
assertion. The owner needs the next change chosen from evidence, not another speculative patch.

### Solution and User Stories

1. As the owner, I want the remaining delay attributed to a small repeated operation before
   another production change and hour-long local gate.
2. As the maintainer, I want real guarded component timings and clearly labelled source-derived
   call counts, so neither sampled residency nor static call counts masquerade as native CPU time.
3. As the owner, I want every protected-runtime, marker, workspace and reservation check retained.
4. As the maintainer, I want finite reproducible diagnostic output with failure status preserved.
5. As the owner, I want the ongoing canonical CI result preserved and no live-server experiment.

### Implementation Decisions

This is diagnosis only: do not edit production helpers or existing tests/workflows. Reuse the
installed hermetic helper and real inherited authority chain in a small private local fixture.
Measure three narrowly selected existing boundaries: compose-authority reproof, workspace
reproof, and reservation verification. The fixed probe may expose only these known operations,
never a caller-provided command, path, environment or process selector. Three repetitions per
operation are sufficient; setup/capture/cleanup must be separate from operation timing.

Ranked falsifiable hypotheses:

1. Repeated protected-boundary process starts dominate useful filesystem work. Prediction:
   the real guarded boundary is much slower than executing its same read-only primitives in
   one process, with no omitted validation. First establish its actual unmodified baseline.
2. Reservation JSON-field reads and repeated workspace checks contribute disproportionate
   startup. Prediction: the verified source call tree and corresponding real component show
   materially more command boundaries than the small amount of state being checked.
3. Loading the archive module slows unrelated authority operations. Prediction: a finite
   equivalent unrelated operation with exact pre-ticket21 versus current source differs
   consistently; isolate this only if it can be done without changing repository files or
   executing an unverified mixed helper generation. Otherwise explicitly leave it unmeasured.

Count the successful reduced pre-tree call path from exact current source, including nested
calls and fixed two-archive/three-reservation fixture conditions. Label static counts as static,
include call-site provenance, and state uncertain branches. Do not present sample residency as
CPU time or extrapolate a guaranteed native completion time. Identify the smallest supported
next purpose-specific composition and its invariants; root will separately specify any fix.

Use only cached offline Linux runtime/fixture resources already recorded. Failed or uncertain
fixtures are preserved for disposable-container retirement; cleanup requires exact ownership
and identity. Fixed output bounds and child deadlines remain real. No signals to unproven PIDs.

### Testing Decisions

Use the actual installed helper and existing exported primitives, not successful fake validators.
Diagnostic contract tests must cover finite child nonzero status, bounded reporting and refusal
of arbitrary input. Record exact commands, hashes/runtime and measurements. Original120s feedback
cannot run in seconds by definition, and Docker Desktop has a separately proven PID0 refusal;
therefore use seconds-scale components for attribution, explicitly not as an exact-bug regression.
Original native feedback must still be rerun after any future production fix, not repeated now.

### Out of Scope

No production edit, caching/removal of authority proofs, new batching daemon, deadline increase,
existing test deletion/weakening, existing diagnostic/workflow edit, package download, VPS action,
new release archive, unchanged full-suite repeat, or claim that the original bug is resolved.

## Compose the measured protected-state boundaries

### Problem Statement

The retained-pair repair reduced native work but did not satisfy the unchanged120s rollback
barrier. Canonical CI129 also fails only that barrier. Ticket22 measured approximately1.02s
for Compose reproof,0.70s for workspace reproof and2.73s for three-reservation verification.
Their successful reduced pre-tree path contains100 selected guarded starts. The owner needs
less repeated process startup without losing any filesystem or recovery protection.

### Solution and User Stories

1. As the owner, I want the existing protected checks executed with fewer process launches,
   so deployment preparation can progress faster without changing its safety conditions.
2. As the maintainer, I want three named operations, not a generic caller-controlled batch.
3. As the owner, I want every transaction boundary rechecked freshly, never cached.
4. As the maintainer, I want missing authority, drift and supervisor failure to retain their
   current fail-closed ordering and authority_violation/recovery behavior.
5. As the maintainer, I want existing GNU identity records and non-Linux behavior preserved.
6. As the owner, I want measured local improvement followed by unchanged native feedback,
   not a promised120s result extrapolated from static counts.

### Implementation Decisions

One coherent repair covers the three measured read-only boundaries in the existing runtime
argument/CLI and shell caller seams. Keep all call sites and mutation placement unchanged.
Each composed invocation uses the existing inherited-chain run_bounded60s guard; replacing
several separate60s calls with one60s operation tightens the aggregate bound, never raises it.
No new stateful service, cache, generic operation array or subprocess command interface.

Compose reproof: reuse protected-runtime, optional active-marker and optional transaction-marker
primitives in exactly that order with their current path bindings, sizes, metadata and JSON
identity comparisons. The normal populated-authority case should require one guarded start.
An empty authority currently returns1 without setting authority_violation, whereas a failed
proof sets it to1. Preserve ordering for combined failures; retaining the unchanged sequential
fallback when any capture is empty is acceptable. Do not prevalidate later captures ahead of
an earlier proof when that changes causal behavior.

Workspace reproof: preserve initial capture and the GNU stat device/inode/fullmode/uid/gid/
permissions record; do not change the shared identity helper or cutover consumers. For Linux,
a named operation may verify protected runtime then a direct private workspace child of the
captured rollback root and compare the exact existing record from native BigInt lstat fields.
Prove equivalence against actual GNU stat, including full mode and special permission bits;
exact0700/current owner, no-follow directory type, device/inode/group and existing record
comparison all remain mandatory. Do not use lossy Number conversion for device/inode. Existing
non-Linux shell behavior remains the fallback because Node/GNU stat Windows metadata differs.
The runtime verifier itself must reject non-Linux use of this Linux record interpretation.
Missing capture/invalid-parent cases must retain earlier runtime-proof/failure-flag ordering;
the existing path may remain as a fallback. Do not recapture an identity to forgive drift.

Reservation reproof: retain preceding workspace reproof. Replace only the subsequent bounded
JSON size parsing and verification of the three known temporary/live/store slots with one
fixed-purpose operation. Preserve slot order, empty-path skips, first-match record association
when paths repeat, safe integer/minimum64MiB headroom validation, exact captured JSON comparison,
owner0600/no-follow/single-link/stable descriptor proof and actual size/allocated blocks proof.
No allocation, truncation or removal moves into this verifier. A reservation-only failure still
returns1 without newly setting authority_violation; a preceding workspace failure retains its
existing flag. Do not expose arbitrary command lists or accept unsafe numeric coercions.

For the populated Linux success path this can reduce selected starts from100 to39: Compose
30to10, workspace52to26, reservation-only18to3. These are source-derived counts and a hypothesis,
not native measurements or a guarantee that the approximately20s barrier gap disappears.

### Testing Decisions

Use TDD at real module/CLI and actual shell boundary seams, as in the retained-pair ticket.
Prefer real protected files/directories/reservation metadata mutations. Cover valid populated
and optional-absent cases, missing and malformed captures, identity/bytes/owner/mode/link/type
and parent changes, special mode bits, record equality, invalid/underflow/nonnumeric capacity,
empty/duplicate reservation slots, and ordering/authority_violation behavior for finite guard
statuses1/23/124/125/137. Check GNU stat equality on actual Linux without changing old tests.
Only new tests are added; all existing production tests and workflows stay byte-identical.

After production freeze, run the unchanged ticket22 finite guarded diagnostic on the same cached
Linux22.23.1/container fixture for three observations per boundary. Compare to the recorded
pre-change ticket22 baseline and disclose that these are separate runs, not interleaved timing
or native CPU measurements. Verify exact source/bundle/runtime provenance; no Docker Desktop
actual rollback retry because of its known PID0 refusal. The probe itself must not be modified
to accommodate the repair. Root owns focused gates, independent two-axis reviews, one complete
fresh pinned local lint/check/test gate, authorized-branch publication and original native/CI
feedback. Failed native feedback remains a failure regardless of faster local components.

### Out of Scope

No new supervisor/daemon, authority cache/removal, deadline increase, changed original test or
workflow, dependency/network download, shared GNU record-format migration, unrelated archive
refactor, source-generation bypass, VPS mutation, archive packaging or deployment readiness claim.

## Minimize the newly reached recovery deadline feedback

### Problem Statement

Native6 on the published protected-boundary repair passes the formerly failing rollback tree
barrier at111700ms and completes that rollback. The unchanged original test then reaches its
next operation and fails waiting for recovery at120010ms. Repeating successful deployment and
rollback before every recovery observation costs several minutes. The owner needs a narrower
feedback loop before another production change, not a relaxed deadline or an assumed cause.

Subsequent canonicalCI130 on the same4e3b02c still fails the earlier rollback/tree barrier at
120004ms (phaseconfig-json-complete), despite both isolated native6 paths passing it. Stable
rollback acceptance is therefore still outstanding. This recovery diagnostic addresses an
observed later failure without dismissing the earlier canonical failure or claiming repair.

### Solution and User Stories

Create a diagnostic-only recovery attempt using independently verified post-rollback fixture
state and the real installed deploy helper, with original failed-readiness/recovery semantics.

1. As the owner, I want the next failure observed without redoing two already successful operations.
2. As the maintainer, I want the prepared state proven against the original fixture and archives.
3. As the maintainer, I want the recovery marker, not the stale tree marker, to determine progress.
4. As the owner, I want the original120s failure preserved even if recovery succeeds later.
5. As the maintainer, I want expected recovered helper exit1 distinguished from arbitrary failure.
6. As the owner, I want uncertainty and late processes reported without erasing active evidence.
7. As the maintainer, I want a bounded native diagnostic alongside unchanged original tests.
8. As the owner, I want measured feedback before any additional production repair.

### Implementation Decisions

This is Phase1 feedback construction only. The existing exact native command is red-capable and
agent-run, but takes511s; its120s time-based symptom cannot honestly become a seconds-long exact
local loop. Local Docker Desktop already refuses real flock ownership with PID0 before this bug.
Do not retry that known environment or pretend a finite contract fixture is the real reproduction.
Build and verify a shorter native path, and record that native execution remains required before
hypothesis testing or a production fix. The full original test remains authoritative.

Use the established fixture factories and installed-generation verification. Prefer reuse of
existing exported diagnostic preparation utilities without changing them. Start from a fresh
private fixture only, with real current/candidate archives and two retained verified pairs.
Reconstruct the state immediately after successful rollback: current source/marker/stable image/
running container, the prior synthetic backup history, protected file/directory metadata and
no active transaction, recovery-required state, reservations or host-operation lock. Account for
the original removal of up-count/curl-count and its retained tree/release-tree markers. A stale
tree marker is expressly not proof that this recovery operation advanced. Verify byte/mode/
identity/store inventories against real archive verification before starting the timed operation.
Expose a concise equivalence report and disclose any deliberately omitted inert fixture history.

Invoke only the real installed deploy helper with the fixed candidate tuple and the original
failed-readiness/recovery fixture behavior. No caller-supplied command, arbitrary path, script or
environment input is allowed through the CLI. Fixture setup is outside the unchanged120000ms
recovery-barrier observation. Report the fixed allowlisted phase and bounded byte counts, not
raw process arguments, environment, file identities, PIDs or child streams. Use a bounded phase
timeline (at least500ms spacing, at most16rows) only to locate progress, never as a CPU profile.

When the recovery barrier appears, release its exact owned fixture barrier so the actual helper
can settle. The intentional failed release normally exits1 after verified prior-state recovery.
Diagnostic success requires on-time recovery barrier, child closed with expected status1 and
the expected verified-prior-state diagnostic plus independent final source/marker/image/container
proof. Unexpected status0 must fail; other nonzero statuses and signals must remain distinguishable.
A late barrier or later expected exit1 cannot turn an initial120s timeout green. Missing/invalid
evidence cannot mask an original failure. Report-write failure must not mask a known nonzero result.

Bound later observation/settlement separately and retain a hard outer watchdog. Keep the entire
native job within six minutes including fixture setup and focused contracts. If settlement is
unproved, preserve the fixture and report124/uncertainty; do not delete active state or signal
unproved numeric process identities. Disposal belongs to the private diagnostic environment.
The new job may be added to the existing prototype-only diagnostic workflow after review, but
the two existing jobs, their deadlines, commands and the canonical workflow stay unchanged.

### Testing Decisions

Use real temporary files/archive verification for prepared-state and final-state proof, and real
finite children for the observation/result seam. Test current-state reconstruction, missing or
contradictory metadata, stale-tree-only non-success, on-time expected exit1, late expected exit1,
unexpected exit0/23, signals, launcher exit with inherited pipes, bounded unsettled children and
report-write failure. Exercise the actual CLI result seam rather than only a detached mapper.
Pin local Node22.23.2; Linux focused contracts may use the established offline cached fixture.
Do not execute the actual Linux recovery on the known incompatible local flock environment.
Root owns fresh independent reviews, exact-source provenance, focused gates, publication to the
authorized branch and actual native feedback. No green production or deployment claim follows
from diagnostic contracts. Existing production/default-test bytes remain unchanged.

### Out of Scope

No production helper changes, original-test edits, raised limits, weakened cleanup or identity
guards, new daemon/cache, dependency download, unrelated local environment repair, VPS access,
artifact packaging, paid provider action, workflow rerun/cancellation or installation.

## Match recovery diagnostic metadata to the real helper umask

### Problem Statement

Native7's reduced recovery reproduces the original120s timeout at120020ms. It later reaches
the recovery barrier at199258ms and closes the real helper with expected status1/restoration
diagnostic at238706ms, but the independent final-state proof fails. The diagnostic currently
constructs frozen files0444 and expects recovered files0644. The actual deploy/rollback shell
uses umask077; a root-run offline Linux probe through the real canonical archive producer and
extractor confirms extracted0600 and frozen0400. This is a separate diagnostic-contract defect,
not the cause or a repair of the original production timing failure.

### Solution and User Stories

Correct the diagnostic's exact metadata model and protect it with a real masked-extraction
regression. Preserve the timeout failure and every other independent proof requirement.

1. As the owner, I want a genuine restoration distinguished from a mistaken test expectation.
2. As the maintainer, I want prepared file permissions derived from actual helper behavior.
3. As the maintainer, I want finite successful fixtures to reproduce the real extraction mask.
4. As the owner, I want late recovery to stay a failed timing check even when restoration verifies.
5. As the maintainer, I want incorrect broad permissions rejected, not accepted as alternatives.
6. As the owner, I want this diagnostic correction kept separate from production changes.

### Implementation Decisions

Reuse the existing prepared-state and finish-attempt seams. The imported rollback-only base
fixture is independently checked using its existing model before conversion; do not modify that
older diagnostic in this slice. Transform only the new recovery fixture to the actual frozen
0400 current-file model and require0600 after real recovery. Marker0600, directories0700 and
all retained identity/inventory/byte checks remain exact and unchanged. No acceptance ranges.

Use a real canonical archive and extraction in a finite isolated child with inherited umask077
to establish the model, avoiding process-global umask changes in a concurrent test runner.
Finite recovered fixtures must derive actual source bytes/modes from this real extraction path
instead of forcing the expected mode with chmod0644. Keep the existing28 behavioral contracts
and their assertions; update only expectations shown wrong by real helper behavior, add explicit
regressions rejecting0444 prepared and0644 recovered current files. Preserve all result status,
expected diagnostic, closed-child, auxiliary124, stale-marker and bounded-output contracts.

Do not add general-purpose logging or new production seams. If another final-state assertion
fails after this correction, retain the failure and report it rather than broadening the scope.

### Testing Decisions

First add/run a real masked-extraction comparison that fails against the published diagnostic.
Then correct the model and run all focused contracts on pinned Windows22.23.2 and cached offline
Linux22.23.1; POSIX mode assertions skip explicitly on Windows. Use existing short finite-child
test seams only. Do not rerun real local Linux flock/recovery in the known incompatible container.
Root owns independent two-axis review, exact LF/source provenance, existing full-gate evidence,
publication to the authorized prototype branch and native feedback. The original120s check and
full canonical CI remain authoritative; a correctly failed diagnostic is not deployment clearance.

### Out of Scope

No production/default-test or workflow edits, modified archive semantics, deadline increases,
authority bypass, real local recovery, external downloads, VPS mutation, release packaging or
deployment. No claim that the native final-state mismatch is exclusively this defect until a
corrected native run proves all remaining final-state assertions.
