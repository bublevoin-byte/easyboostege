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
