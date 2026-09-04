# Aisy PWA — локальный release handoff Ticket 11

## Результат

Production frontend находится в `dist/public` и собирается только из production-источников:
prototype paths отсутствуют в asset manifest и install closure. Manifest допускает portrait и
landscape, использует Paper A warm canvas/coral theme, SVG/192/512/maskable icons и Apple touch icon.
Worker получает content-addressed release id из своей policy и точных байтов каждого APP_SHELL
response, включая файлы со стабильными именами.

Update не прерывает занятие: новая версия остаётся waiting, верхний live-status предлагает
«Обновить после задания» и доступное 44×44 действие «Позже», не перекрывая deep-task dock. Snooze
скрывает только notice, сохраняет waiting worker и возвращает focus точному deep-task control (или
фокусу активного экрана, если прежний control уже исчез). Service worker имеет один active controller
 на origin, поэтому активация ждёт consent quorum только положительно распознанных learner-shell
 вкладок: legacy `/`/`/index.html` либо exact same-origin window, выполнившее
 `REGISTER_LEARNER_SHELL_CLIENT` handshake (включая настоящие deep links приложения). Закрытая
 participating вкладка выходит из quorum. Health/API/internal/static и иные passive same-origin
 documents, включая `/privacy.html` и `/offline.html`, не исполняют занятие и намеренно не участвуют
 в consent/ready quorum. После первого согласия A worker
 остаётся waiting, A и B не reload; post-consent действие «Позже» скрыто, focus возвращается в задачу,
 а честный live-status сообщает, что ожидаются другие вкладки. B может договорить со старым document
 и впервые открыть его настоящий old hashed Speaking chunk. Позднее согласие **или закрытие** B
 завершает quorum; каждый согласившийся document наблюдает `activated` у своего exact waiting worker
 и перезагружает только себя. Candidate не вызывает blind `clients.claim()` для update, поэтому passive
 или несогласившаяся вкладка не обновляется чужим consent; Writing draft восстанавливается после
 согласованного reload. Worker перепроверяет закрытие каждые 250 мс в течение 60 секунд;
клиент Ticket 11 посылает heartbeat каждые 55 секунд. Heartbeat, пришедший во время активного
60-секундного цикла, ставит ровно один следующий bounded cycle в очередь: циклы не перекрываются и
`event.waitUntil` не становится неограниченным. Прежний Aisy cache удаляется только после
`CURRENT_CLIENT_READY` от всех живых участвующих вкладок;
 чужие CacheStorage namespaces не затрагиваются. Navigation и generic offline fallback читают только
 exact current cache, поэтому retained predecessor/foreign collision не может подменить `/` или lazy asset.
 Worker выходит до `respondWith` для segment-bounded `/api`, `/internal`, `/health` и точного legacy
 callback `/?login_code=…`; эти ответы не получают offline replay, а server возвращает их с `no-store`.
 Отдельный privacy → offline-root regression возвращает приложение, а не privacy document.

На `activate` worker атомарно сохраняет в своём release-qualified client-state cache только strict
immutable predecessor authority из проверенного compatibility record: schema, full base commit,
content SHA-256 и exact cache name. Запись ограничена schema/count/name и 1024 байтами; missing,
oversized или tampered authority означает fail-safe `no prune`. Поздний `CURRENT_CLIENT_READY`
удаляет только этот exact predecessor cache и никогда не классифицирует `caches.keys()`, поэтому
уже существующие static/EGE/client-state caches будущего C, colliding prefix, foreign и unknown
namespaces сохраняются. Executable-cache ЕГЭ включает `CACHE_NAME` в identity, так что даже
одинаковый path graph разных release-поколений не разделяет mutable cache.

Точный d367 document не содержит Ticket 11 Apply/quorum UI: при появлении candidate он показывает
своё production-уведомление «Доступна новая версия… Обновите страницу». Обычный **online reload**
через его network-first controller загружает candidate document, но не активирует waiting worker и не
меняет controller. Уже этот настоящий candidate UI показывает focusable `#pwa_update_apply`; только
его keyboard Apply записывает consent. Поэтому проверка не внедряет и не вызывает synthetic
`event.detail.apply`. Если old tab не reload и не закрыт, он остаётся честным nonconsenting участником
quorum; reloaded/consenting Ticket 11 tab продолжает bounded heartbeat и замечает его более позднее закрытие.

Consent принадлежит не документу вообще, а конкретному waiting worker. Если согласованный, но
заблокированный вкладкой worker B становится redundant и его заменяет C, клиент останавливает B retry,
отбрасывает B consent/controller state, игнорирует поздние сообщения B и заново показывает для C
доступные «Обновить после задания» и «Позже». C остаётся waiting без `SKIP_WAITING`, reload или consent
marker до нового явного нажатия реальной кнопки; reduced-motion меняет только движение, не этот consent.

Candidate package содержит digest-verified executable graph точного predecessor
`d36724181ee04230c1a9709a9213bcd269092282` в `pwa-compat/`. Эти bytes сохраняют исходные hashed URLs,
доступны Docker frontend stage без `.git`/старого `dist`, и все 26 устанавливаются в predecessor cache
только compatibility-update worker. Каждый действительно predecessor-only entry остаётся вне
current/clean-install `APP_SHELL`. Пересечение всех 26 compatibility entries с shell — ровно два
byte-identical current-emitted path, которые законно входят в current shell как текущие
dependencies: `/assets/asya-assistant-1Lybndln.js` (14 642 bytes,
`f2a2e4371e15daa72b46777eb4fe61b4a694a7f3bf573f8a6603947db380d176`) и
`/assets/reading-catalog-contract-HSvgPmNc.js` (13 036 bytes,
`518cc358031b6c9b8a61b615a03515395effe4e5001b6cd6a999280bfcbb8414`). Остальные 24 entries остаются
вне shell; среди них есть unchanged current lazy outputs, поэтому они не называются predecessor-only.
Compatibility package не добавляет predecessor-only код в initial execution.

`.dockerignore` исключает именованные non-runtime категории: `.env*` (кроме безопасного
`.env.example`), `.scratch`, prototypes, QA/test/evidence и workspace debris. После unit и непосредственно
перед единственным candidate build обязательный release context guard парсит каждый non-`--from` Docker
`COPY`, рекурсивно обходит его реальные inputs
без следования по symlink-каталогам и падает на любом reachable файле вне точного объединения
`git ls-files` + audited candidate manifest. Поэтому denylist не считается самостоятельной гарантией.
Отдельный `npm run production:image:build -- --expected-commit "$EASYBOOST_RELEASE_COMMIT"` —
единственная разрешённая production-image точка входа. Он принимает обе Node stages только через
owner-reviewed exact `EASYBOOST_NODE_BASE_IMAGE=node:22-bookworm-slim@sha256:<64hex>` и отклоняет
отсутствующий либо tag-only base до Docker. Затем он требует exact clean Git root на полном
owner-approved commit и дважды descriptor/no-follow читает ровно verified closure плюс
`Dockerfile`/`.dockerignore`, сверяет
ancestor/file identity и SHA-256, сканирует все bytes и пишет deterministic USTAR из того же повторно
проверенного Buffer прямо в stdin `docker build`. Docker не получает writable temporary context;
оборванный или изменившийся stream не может завершиться успешным tag. Прямой Compose build по умолчанию
указывает на намеренно отсутствующий sentinel, обычный `up` использует local image с
`pull_policy: never`, а PostgreSQL-only операции остаются доступны без build override.
Финальный image не использует `COPY . .`: runtime получает только явно перечисленные root-файлы,
runtime-каталоги, `scripts/migrate.js`, `scripts/import-json.js` с его explicit lock/bounded-child
dependency closure и проверенный `dist/public` из frontend
stage. Frontend stage получает полный явный build-input closure, включая `public/`, `shared/`, PWA
compatibility artifact и build scripts.

Staging image меняется только через атомарно установленный root-owned `immutable-archive-v4` helper
bundle: deploy, rollback, shared common library, canonical Node archive tool и resolved-Compose verifier.
Producer создаёт checksum-bound single-member gzip
с regular-file USTAR; validator до Docker требует уже canonical relative POSIX NFC names, запрещает
aliases/links/special/protected entries и применяет границы 256 MiB compressed, 4096 entries, 16 MiB
на файл, 384 MiB aggregate, 64 MiB disk headroom и 60/90/600 s inspect/extract/build. Primary deadline
1800 s и отдельные 600 s recovery принадлежат root-owned launcher/supervisor; внешний `timeout` вокруг
helper не используется, чтобы не оборвать recovery. 60-minute workflow оставляет запас на
archive/upload/SSH и supervisor settlement.
Filesystem reservations удерживают candidate/predecessor peak и до 256 MiB DB backup на каждом
distinct filesystem. Блокировки разделены по назначению: helper installer сериализует разные
процессы своим nonblocking kernel `flock` на fd 7, launcher удерживает отдельный process-lifetime
maintenance `flock` на fd 8, а release-транзакция — `.staging-release.lock` во время validation,
build, tree replacement и checked recovery. Raw Compose build остаётся закрыт literal отсутствующим
sentinel.

Helper installer использует стабильный `install.lock`: для root это
`/run/lock/easyboost-staging-helper/install.lock`, для hermetic non-root запуска — private
`/tmp/easyboost-staging-helper-installer.<uid>/install.lock`. Каталог имеет mode `0700`, lock inode —
`0600`, single-link и совпадает с уже открытым fd 7; после crash kernel освобождает flock, но сам
inode не трактуется как stale owner marker и не удаляется. В install root create-once публикуется
single-link `maintenance.lock` `0600` с exact canonical bytes
`{"installRoot":"<absolute install root>","protocol":"easyboost-staging-quiescent-maintenance-lock-v1"}\n`.
Retry принимает только те же bytes и никогда не заменяет существующий inode.

Стабильный launcher сначала открывает exact `maintenance.lock` read-only на fd 7, доказывает
path↔descriptor identity, ownership/mode/link/size, затем переоткрывает уже доказанный объект через
`/proc/$BASHPID/fd/7` read-write на fd 8, закрывает fd 7, сверяет SHA-256 и вызывает внешний
`/usr/bin/flock -n 8`. После повторной identity/digest проверки он экспортирует только bounded
`easyboost-staging-quiescent-maintenance-v1:8:<sha256>` metadata. Transaction consumer немедленно
удаляет эту переменную из передаваемого environment, повторно доказывает exact inode/bytes/digest и
exclusive FLOCK через `/proc/self/fdinfo/8`, после чего выдаёт разные opaque authorities, связанные
с exact dev/ino deadline- и session-control roots. Одна строка environment без живого fd 8 такой
authority не даёт; bounded target не наследует metadata.

Helper installer хранит audited generation и захваченный по descriptor Node runtime раздельно:
`node-authorities/<sha256>/node` имеет read-only identity и exact `node-authority.json`, публикуемый
последним как completion marker. Валидный crash-partial retry допубликует, повреждённый partial сначала
атомарно изолируется в retained quarantine без `chmod`/удаления pathname successor. Runtime повторно
проверяется перед каждым запуском. Quarantine ограничен до любой новой mutation: 1024 entries, 64 GiB
apparent aggregate и 8192 no-follow scan entries; превышение fail-closed. Очистка допускается только
owner-ом в доказанно quiescent offline окне, по exact имени без wildcard/prefix, с fsync parent.
Runtime исполняется через открытый fd 9. Final bind экспортирует только
metadata `EASYBOOST_STAGING_NODE_AUTHORITY=easyboost-staging-node-authority-v1:9:<pid>:<sha256>`;
transaction/session chain проверяет уже открытый descriptor, сохраняет его для trusted current,
historical и вложенных `node`, а перед bounded target удаляет metadata и fd 9. Поэтому host pathname
replacement после проверки не становится исполняемой authority.

Recovery считается успешным только после проверки stable image identity, exact predecessor tree,
marker, running image и readiness. Иначе `.staging-recovery-required` блокирует следующие операции.
Отдельная строка `STAGING_TRANSACTION_RECOVERY_REQUIRED <exact-json>` восстанавливается только
установленным `easyboost-staging-recover` с теми же role/аргументами и дополнительным суффиксом
`--recovery-authority '<exact-json>'`; raw `rm` control namespace или соседнего `.tmp` запрещён.
Wrapper передаёт первую exact writer-authority через приватный bounded fd 3, который target не
наследует. Несколько собственных session publications сохраняются массивом без потери более раннего
пути. Deadline и session terminal evidence сначала резервируют один из 1024 deterministic root-global
private slots через exclusive `mkdir`, затем записывают canonical `reservation.claim` и только после
этого помещают exact payload внутрь слота. Ordinary successful evidence не становится permanent:
удалять доказанный container может только root-bound callback под живым fd 8 flock; mismatch или crash
оставляет bounded evidence для следующего recovery. Deadline/session state machines не выполняют
raw pathname delete самостоятельно.

Сам reclaim journaled в `<controlRoot>/.maintenance-deletion.<64hex>/` `0700`: durable empty
transaction публикует canonical protocol-v1 `claim` через `claim.pending` + rename/fsync; claim
фиксирует bounds, root/container/payload/reservation identities, kind, source name и transaction token.
Только затем exact source container переименовывается в `payload` с fsync transaction+root, а
zero-byte deletion authority `moved` публикуется через `moved.pending` + rename/fsync. Recursive
symlink-free bounded delete разрешён только после `moved`; затем с отдельными fsync удаляются claim,
moved и пустая transaction directory. Каждый bind до выдачи новой authority bounded-сканирует не
более 65 536 root entries и 1024 exact deletion transactions и продолжает empty/pre-claim,
claim-before-move, payload-before-marker, partial-delete, payload-absent и marker-only состояния.
Foreign name, malformed record, identity/mode/device/root mismatch или ABA сохраняются и дают
fail-closed вместо ручной очистки.

Deadline request и ACK используют один paired-publication protocol. Writer exclusive-create/no-replace-ит
private regular record `0600` с `nlink=1`, записывает canonical bytes, выполняет `fsync(record)`,
закрывает его и `fsync(control directory)`; только затем exclusive-create/no-replace-ит zero-byte
private regular `<record>.ready` `0600` с `nlink=1`, выполняет `fsync(marker)`, закрывает его и снова
`fsync(control directory)`. Live reader и для request, и для ACK всегда проверяет `.ready` раньше
record: record без marker не опубликован; orphan marker, unsafe/nonzero marker или malformed sealed
record дают fail-closed. Unsealed record, включая zero-byte crash residue, не является transition и
может быть снят только после доказанного settlement owning session путём retirement всего exact
authenticated control namespace. Отдельные unlink, repair или replacement record/marker запрещены.

Restart-safe session/deadline handoff — это `retirement.claim` и цепочка no-replace hard links
`.recovery-baton.<64hex>.claim`, а не pathname move. Цепочка ограничена 32 links; после durable
successor текущая authority определяется по доказанному tip. На границе только root-bound fd 8
maintenance callback может crash-safely свернуть epoch обратно к single-link `retirement.claim`,
удаляя successors в обратном порядке с fsync после каждого шага. Без доказанной maintenance authority
recovery сохраняет тот же replayable handoff и останавливается fail-closed. Deadline retirement
завершается до session retirement; sibling namespace и prefix никогда не сканируются для удаления.
**Identity-bound transaction-owned temporary/final publication cleanup requires exact release-store
revalidation. Success is emitted only after the reservation is removed and the whole release store is
revalidated. Verified prior state restored is printed only after exact recovery-state verification.**
Rollback success/recovery claims additionally require exact temporary-image, reservation, private-workdir
and transaction-marker cleanup, followed by reservation-free whole-store validation and exact active-state proof.
Docker image identity принимается только как одна canonical строка `sha256:` + 64 lowercase hex.
Only a successful empty exact-reference image probe proves absence. A timeout, daemon failure, or any
other error is indeterminate and fail-closed; перед удалением exact temporary tag его canonical ID
проверяется повторно. Rebound/mismatched tag не удаляется, а immutable image ID никогда не передаётся
в `docker image rm`. One shared ordered
finalizer owns image → reservations → workdir → transaction marker → operation-specific exact-state proof,
while deploy publication/backup and rollback target semantics remain separate.
Каждый путь темповой или финальной candidate-публикации удаляется независимо и только по
зафиксированной identity; любая недоказанная очистка оставляет fail-closed marker без сообщения об успехе.
Final archive/sidecar публикуются atomic no-replace hard link, поэтому concurrent foreign final path
не перезаписывается; cleanup сначала атомарно изолирует exact entry в private quarantine и никогда не
удаляет подмену по публичному path. Bounded output capture также живёт в unique private directory,
публикуется no-replace и сохраняет primary failure первым при ошибке cleanup.
Process supervisor различает absent/alive/unknown process-group probe; `EPERM` означает alive,
прочая probe/signal ошибка остаётся явной. После `SIGKILL` отдельный terminal deadline либо доказывает
group absence + leader close/reap, либо завершает helper явной fail-closed ошибкой без вечного ожидания.
First-deploy failure должен оставить проверенное пустое bootstrappable состояние. Store допускает
не более четырёх полных archive+sidecar пар и 1 GiB без auto-prune. Rollback возвращает только
code/image/tree/marker: PostgreSQL schema/data никогда автоматически не rollback/down-migrate, поэтому
миграции обязаны быть backward-compatible либо требуют отдельного verified DB restore с owner approval.
Archive-checksum tag выбирает проверенный source archive внутри транзакции, но не делает Docker image
побитно неизменяемым: base-image tags и registry state остаются внешними.

## Как открыть локальный результат

Из каталога `Приложение репетитор/server`:

```text
npm run build:frontend
npm start
```

Точный URL приложения: `http://127.0.0.1:3000/`

Точный readiness URL: `http://127.0.0.1:3000/health/ready`

Сервер предпочитает собранный `dist/public`. Открывать `index.html` напрямую с диска нельзя:
service worker, cookie session и API требуют HTTP origin. Без настроенного learner provider первый
запуск честно показывает недоступный вход; это не даёт локального demo-доступа к учебным данным.

## Конфигурационный inventory и VK callback

Документ фиксирует только имена переменных, без значений:

- `NODE_ENV`
- `PORT`
- `APP_URL`
- `DATABASE_PROVIDER`
- `DATABASE_URL`
- `JWT_SECRET`
- `VK_ID_MODE`
- `VK_ID_APP_ID`
- `VK_ID_REDIRECT_URI`
- `VK_ID_SCOPE`
- `VK_ID_FLOW_TTL_SECONDS`
- `VK_ID_AUTH_STARTS_PER_15_MINUTES`
- `VK_ID_AUTH_CALLBACKS_PER_15_MINUTES`
- `VK_ID_PROVIDER_TIMEOUT_MS`
- `VK_ID_LOCAL_SUBJECT` — только local development/test
- `VK_ID_LOCAL_DISPLAY_NAME` — только local development/test
- `TELEGRAM_BOT_TOKEN`
- `ADMIN_TELEGRAM_ID`
- `XAI_API_KEY`
- `GROQ_API_KEY`
- `VOICE_TUTOR_ENABLED`
- `AZURE_SPEECH_KEY`
- `AZURE_SPEECH_REGION`
- `SPEAKING_PRONUNCIATION_ENABLED`

`PLACEHOLDER — создать VK ID application`

В кабинете VK ID нужно зарегистрировать ровно один callback:
`https://<ваш-origin>/api/v1/auth/vk/callback`. Он обязан совпадать с configured application origin,
не иметь credentials, query или fragment; scope остаётся пустым. Reverse proxy/CDN logs для этого
пути должны писать нормализованный path без query. Live callback, cancel/replay/logout smoke и
provider console setup не выполнялись, потому что VK ID application ещё не создано.

## Исполняемые gate-команды

### Restart-safe Windows Job recovery

Если bounded build/release/database command вернул `WINDOWS_JOB_RECOVERY_REQUIRED`, deterministic
control namespace нельзя удалять вручную и нельзя обходить новым ключом. Оператор того же command
scope вызывает экспортированный
`recoverWindowsJobControl({ recoveryAuthority: error.recoveryAuthority })` из
`scripts/release-command-supervisor.js`. Прямой вариант
`recoverWindowsJobControl({ controlKey, temporaryDirectory })` допустим только с теми же
deterministic `controlKey` и абсолютным `temporaryDirectory`, с которыми создавался controller.
Операция адресует ровно один SHA-256-derived namespace и не сканирует `%TEMP%`.
Typed post-spawn authority protocol `easyboost-windows-job-recovery-v2` содержит private
`proofToken` поколения. Legacy v1 authority не доказывает поколение и остаётся fail-closed. Если при таком вызове исчез
весь recovery root или ровно этот namespace, отсутствие pathname не считается settlement proof:
recovery остаётся `WINDOWS_JOB_RECOVERY_REQUIRED`. Результат `absent` без receipt допустим только
для прямого pre-spawn discovery по deterministic key.

Recovery допускает retirement только когда canonical `control.json` path-bound к этому namespace,
а `job-empty.proof` имеет exact protocol и private token из этого control record. Перед cleanup
каталог атомарно переносится в deterministic retirement namespace; durable retirement proof
связывает его filesystem identity и exact per-file birthtime/volume/file-index/size/SHA-256 manifest.
Proof публикуется через
atomic no-replace hard link `pending → proof`; crash с одним pending или exact dual-link состоянием
возобновляется, а поздний/mismatched destination сохраняется fail-closed. На Windows pending не
снимается отдельным process launch: все exact content-пары и proof-пара передаются одному native helper
под общим 30-секундным cleanup deadline. Helper сначала открывает все handles с `READ|DELETE` share
без `WRITE`, затем сверяет volume/file-index/`nlink`/size/SHA-256. Нормализация pending и
снятие лишнего proof-link используют тот же identity-bound hard-link retirement; proof-only,
exact dual-link и sealed-delete-only crash states возобновляются без raw удаления непроверенного пути.
Успех допускается только после отсутствия active/quarantine namespace и сохранения одного canonical
retirement proof как durable completion receipt. Receipt включает тот же `proofToken`; повтор typed
recovery принимает только exact token match и не удаляет receipt. Прямой pre-spawn discovery может
identity-bound удалить exact receipt перед созданием следующего поколения. Поздний pending/proof снова
даёт typed fail-closed и сохраняется.
После частичного cleanup
допустим только неизменившийся поднабор sealed files. Каждый файл так же проходит atomic no-replace
hard-link handoff в свой sealed deletion name с identity/`nlink` проверками. Native batch снимает
content links, затем exact handle-bound retirement directory и только после него лишний proof link,
оставляя canonical receipt.
Новый sibling, replacement или изменённый байт поэтому сохраняется и
блокирует удаление даже на последней race-границе. Crash после move, proof/file link, частичный cleanup
или сбой удаления возобновляются тем же вызовом.
Release, production-build и database lifecycle ошибки сохраняют эту authority без сужения при
aggregation. Успех возвращает
`{ state: 'absent', retired: true|false, controlDirectory }`, после чего original control key можно
использовать снова.

Production import CLI не требует переносить raw Error между процессами. При unclosed Docker child он
публикует только sanitized JSON `PRODUCTION_IMPORT_LOCAL_CHILD_RECOVERY_REQUIRED`; exact controller authority
одновременно checksummed в retained host evidence и связан с exact DB local-child hold. Единственный operator
entrypoint — `node scripts/production-import-recovery.js`: сначала typed supervisor recovery, затем атомарный
local-child→retained DB transition и только после этого существующая remote import recovery. Повтор после crash
идемпотентен; исчезнувший Windows root/namespace и несовпадение host evidence, DB hold или supervisor authority
не выполняют DB transition и сохраняют app/start блокировку.

Missing/malformed/mismatched proof или control record, неизвестный sibling, path/identity drift,
unsafe retirement record и overlapping active/retirement namespaces всегда сохраняются и снова дают
typed `WINDOWS_JOB_RECOVERY_REQUIRED` с `childSettlementUnproven: true`. Raw `rm`, wildcard cleanup и
bulk-retirement исторических `%TEMP%`-каталогов не являются recovery procedure.

Единая обязательная цепочка:

```text
npm run test:release:aisy
```

Она выполняет lint → syntax/inline checks → unit → Docker-context + tracked/explicit candidate secret
guard → один **candidate production build** → 26 уникальных built-dist Chromium scenarios →
performance → history scan → `git diff --check`. Context/secret guard стоит непосредственно перед
build, поэтому unit не может оставить в recursive `COPY` root непроверенный файл. `aisy-pwa-release`
отдельно строит из локального Git во
временном каталоге exact predecessor fixture d367 с существующими dependencies; это доказательство
двух версий, не вторая сборка production candidate и не входящий в artefact старый `dist`. Unit EGE
контракт не запускает build и не читает `dist`; candidate build сам валидирует source-derived closure,
а post-build PWA E2E сверяет source → manifest → worker paths, waiting-cache keys и offline SHA bytes.
Финальный
запуск этой команды выполняется один раз только после двух независимых ZERO-аудитов frozen snapshot.

Cycle 8/10 browser, worker, artifact и performance observations сохранены только как historical/superseded.
Текущий финальный `npm run test:release:aisy` прошёл: artifact
`d518f4a54e7b03beb357a69f7dc6380cd31befc5a11634c1ddd0df216021e290`, `26` уникальных Chromium
сценариев, first-load JS `90.0 KB / 150 KB`, LCP `108 ms`, CLS `0.000`, INP `64 ms`.

## Ready/adverse evidence inventory

| Surface | Ready journey | Adverse/containment proof |
|---|---|---|
| Splash/onboarding/login/access | `aisy-first-launch`, `aisy-learner-release` | provider disabled, auth/session/access failure, reload/offline unknown |
| Сегодня | `aisy-today`, `aisy-learner-release` | empty/resume/offline plan states, network recovery |
| Практика/adaptive | `aisy-practice`, `adaptive-diagnostic` | locked/online-only rows, unavailable plan/session, owner-safe recovery |
| Слова | `vocabulary-library` | empty library, incorrect/review state, owner switch/offline queue |
| Грамматика | `grammar-2-release` | incomplete/incorrect review, lazy-load failure boundary, offline-first open |
| Reading/Listening | `reading-listening-paper` | blank submit, review, offline/network/audio limits; word dialog focus trap/Escape/restore |
| Writing | `aisy-writing-paper`, `aisy-writing-offline-cache` | invalid/blank, confirm, offline/provider retry, cached reopen without fabricated score |
| Speaking | `speaking-task4`, `speaking-full`, `speaking-pronunciation-status`, `aisy-speaking-paper` | permission/unsupported/provider unavailable, timer/review/retry |
| ЕГЭ | `aisy-ege-hub`, written/oral/result/release scenarios | empty/resume/completed hub, timer/asset/offline/update/result failure boundaries |
| Прогресс/Профиль | `aisy-progress-profile` | empty metrics, expired access, privacy/account dialogs and focus restore |
| Ася | `asya-assistant`, `aisy-asya-paper` | text-only fallback, unavailable voice/provider, dialog containment/restore |
| PWA | `aisy-pwa-release`, `aisy-accessibility` | persistent-profile installability errors = 0, exact d367 refresh→reload→real Apply, wait/quorum/offline upgrade, privacy cache-poison regression, exact responsive/theme/motion matrix |

Accessibility matrix is 320/375/768/1440 in both orientations × forced light/forced dark/system ×
normal/reduced motion. It asserts a centered canvas no wider than 390 px, no side rail or horizontal
overflow, 44×44 minimum targets, landmarks/names/live regions, visible focus, semantic progress,
contrast, dialog/dock containment and offline truth.

## Known limitations

- Automated install/splash/update evidence uses local desktop Chromium. Physical iPhone Safari and
  Android Chrome launcher masks, native splash and safe-area chrome remain manual pre-rollout checks.
- Live VK ID is unavailable until the placeholder application is created and its exact callback is
  registered. No live provider call was made.
- AI, voice, TTS/STT, subscription changes and server evaluation remain online-only and never receive
  stale Cache API/HTTP-cache answers.
- Compatibility package гарантирует lazy executable graph только для точного predecessor d367.
  Более старые уже исполняющиеся документы новый worker переписать не может; для них действует phased
  boundary из `docs/KNOWN_LIMITATIONS.md`.

## Deployment status

The single final wrapper passed. The verified local artifact is
`d518f4a54e7b03beb357a69f7dc6380cd31befc5a11634c1ddd0df216021e290`; `26` unique Chromium
scenarios and current performance budgets passed (first-load JS `90.0 KB / 150 KB`, LCP `108 ms`, CLS
`0.000`, INP `64 ms`). Push, merge, deploy, staging/production mutation, feature-flag rollout, live
VK/provider calls and secret handling were not performed and are not claimed. Deployment requires a separate
explicit owner decision and process.
