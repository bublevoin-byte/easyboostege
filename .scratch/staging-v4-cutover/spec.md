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
