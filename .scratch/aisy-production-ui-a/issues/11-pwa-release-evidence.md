# 11 — Закрыть PWA, доступность и production release evidence

**What to build:** Собрать и проверить весь обновлённый learner-контур как installable PWA, обновить app-shell cache,
закрыть responsive/light-dark/reduced-motion/offline/performance/security матрицу и передать владельцу один
кликабельный production build с известными внешними placeholder.

**Blocked by:** 02–10 — первый запуск, auth, access и все learner surfaces.

**Status:** done

**Spec anchor:** User Stories 31–38, 42–50; Testing Decisions; Further Notes.

**Current checkpoint:** Ticket 11 закрыт на reviewed source freeze
`379956516483fb5d734a90a5b0e29e1f94e4988d1400b9bdf2f0087f88f4ce9c` (`175` файлов / `9 545 896`
байт). Два свежих whole-candidate аудита зелёные: Product/UI `160/160`, Engineering/Release `67/67`.
Единственный финальный `npm run test:release:aisy` завершён с code 0: `3130 total / 3055 pass / 0 fail / 75`
skip; digest-complete artifact —
`d518f4a54e7b03beb357a69f7dc6380cd31befc5a11634c1ddd0df216021e290`; `26` уникальных Chromium
сценариев зелёные. Performance: first-load JS `90.0 KB / 150 KB`, LCP `108 ms`, CLS `0.000`, INP `64 ms`.
Отдельный browser proof подтвердил phone `390×844` и центрированный portrait-frame `390 px` на
`1440×1000` без overflow, side rail и console errors. Локальный test server остановлен. Retained DB marker
сохранён byte-identical; Docker/DB/provider/network, deploy, staging/production mutation, push и live VK не
выполнялись.

## Release-safety scope amendment — 2026-08-29

Во время аудита release evidence обнаружилась узкая обязательная safety-граница: clean-checkout scan,
immutable helper archive, bounded child/process-group lifecycle и exact first-deploy recovery должны быть
проверены вместе, иначе production handoff нельзя считать честным. Ticket 11 поэтому включает только эти
release-safety seams и не открывает общий redesign staging/operator tooling.

Исходный `/autopilot` и повторённые пользователем команды `продолжай` разрешают автономное продолжение этой реализации. Они не являются отдельно высказанным visual/product решением, одобрением staging redesign или отдельным разрешением deployment.
В amendment не входят deploy или staging/production mutation, live provider/registry/network calls, secrets
и любые более широкие операторские изменения; они требуют отдельного явного разрешения владельца.

- [x] Service worker version и production app-shell включают новые runtime assets; prototypes не входят в cache.
- [x] Auth/callback/me/subscription/personal APIs имеют no-store semantics и не обслуживаются stale cache.
- [x] Manifest/icons/splash/install/update/offline upgrade проходят на собранном `dist/public`.
- [x] Chromium matrix 320/375/768/1440, portrait/landscape, light/dark/system и reduced motion не имеет rail/overflow/target failures.
- [x] Main journey и каждый активный deep screen проходят ready + неблагополучный smoke state.
- [x] Accessibility проверяет keyboard, visible focus, roles/names/live regions, contrast и dialog/dock focus containment.
- [x] JS/LCP/CLS/INP остаются в release budgets или документированное отклонение блокирует готовность.
- [x] Lint, syntax/inline checks, unit, relevant E2E, production build и secret scans зелёные.
- [x] Документация перечисляет только env names/callback setup и `PLACEHOLDER — создать VK ID application`, без secret values.
- [x] Release handoff содержит точный локальный URL, проверенные команды, известные ограничения и не заявляет deployment.

## Cycle 11 audit remediation — in-progress, clean audits pending

- Все семь уникальных audit findings закрыты в восьми bounded seams: clean prebuild source/context scan
  отделён от post-build artifact authority; CI/checklist вызывают один `test:release:aisy`; supervisor не
  отменяет TERM→KILL после close лидера, пока POSIX PGID жив; safe ancestors допускают только UID 0/current
  при exact-current protected leaves; fresh production/DR/rehearsal проверяют owner-approved exact
  `postgres:17-alpine` ID до `up --pull never` и у running container; first-deploy recovery удаляет и
  независимо проверяет app+postgres containers, exact volume и network; update notice находится внутри
  portrait frame; scope amendment выше не приписывает владельцу отдельное staging/deploy решение.
- Focused TDD: source/context release chain `2 total / 0 pass / 2 fail` → `2/2/0`; canonical wrapper
  `1/0/1` → `1/1/0`; root/current ancestor `1/0/1` → `1/1/0`; PostgreSQL docs contract `1/0/1` →
  `2/2/0` вместе с adjacent production contract; exact empty recovery `2/0/2` → `2/2/0`; portrait
  update `1/0/1` → `1/1/0`; truthful scope `1/0/1` → `1/1/0`. POSIX leader-close regression
  воспроизводит auditor Linux RED; на Windows suite честно даёт `4 total / 1 pass / 0 fail / 3 skip`.
- Affected suites: frontend release `7/7/0`; production image/docs `13/13/0`; candidate secret scan
  `5/5/0`; runtime authority `8/8/0`; helper bundle `4 total / 3 pass / 0 fail / 1` POSIX skip;
  staging deploy `39/39/0` и rollback `16/16/0` последовательно. Новый content-addressed v4 helper
  digest — `44067d09cbbc70338032168c92816c7affa72cbea0228ca0fa287c1f970f0970`; manifest строится из
  descriptor-captured bytes и повторно проверен install/tamper/mixed-generation tests.
- Static gates: `lint` green; `check` — 535 JS, 165 inline handlers / 106 names; source/context scan —
  1441 tracked + 59 explicit, 839 Docker `COPY`, 1500 unique reads; history — 345 commits; exact
  five-file Git Bash syntax и `git diff --check` green. Bare Windows `bash` однажды попал в недоступный
  WSL (`E_ACCESSDENIED`); canonical Git Bash gate завершился с code 0, это не test/code failure.
- Cycle 11 изменил `public/index.html` и `public/aisy-shell.css`, поэтому нижеследующий Cycle 10
  `dist/public` digest — только исторический baseline, не authority для текущего source freeze. По ограничению
  цикла frontend build, browser E2E, artifact verification, full `npm test` и release wrapper не запускались;
  Ticket остаётся `in-progress` до нового single-build contour и независимых clean audits.
- Docker daemon, deploy/staging/production mutation, network/provider/registry calls, secrets, stage и commit
  не выполнялись. Protected untracked paths не читались как candidate inputs и не изменялись.

## Cycle 12 audit remediation — in-progress, final wrapper pending

- Clean source/unit contour больше не читает ignored `dist/public`: fixture-only artifact tests остаются в
  обычном `npm test`, а exact `553 assets / 554 files / releaseVersion` проверяет только явный non-globbed
  `test:artifact:built` после единственной build и полного digest verification. Clean-directory RED был
  `8 total / 7 pass / 1 fail` (`ENOENT dist/public`), wrapper-order RED — `1/0/1`; оба focused seam после
  разделения — `1/1/0`.
- Production/DR authority теперь только exact detached clean Git checkout на полном lower-case owner-approved
  commit: wrapper до и после freeze сверяет repository root, HEAD, clean status и tracked candidate inventory;
  archive-only tree, tag/branch/short/mixed identity, wrong commit, dirty tree и untracked candidate отклоняются
  до runner. DR фиксирует exact built app image ID, запускает `--pull never --no-build` и сверяет running
  container `.Image`. Functional authority и docs/CLI contracts каждый дали RED `1/0/1` → GREEN `1/1/0`.
- Все прежние artifact/SW/browser/performance наблюдения Cycle 8/10 вынесены только в явно historical/
  superseded раздел ниже; consumer-документы сообщают, что current evidence отсутствует до финального wrapper.
  Focused historical-evidence contract дал RED `1/0/1` на оставшейся stale repetition в README → GREEN `1/1/0`.
- Update consent привязан к exact waiting worker generation. Если quorum-blocked B заменён C, B retry/consent
  сбрасываются, stale B message/controllerchange игнорируются, у C снова видимы canonical Apply/Later, и C не
  получает `SKIP_WAITING` до второго явного visible Apply. Исполняющий реальный `public/pwa.js` VM harness с
  nonconsenting peer дал RED `1/0/1` на живом B timer → GREEN `1/1/0`; adjacent brand/source contract — `1/1/0`.
- Exact predecessor fixture теперь удаляет partial root при любой ошибке после allocation. E2E владеет nullable
  fixture/server/browser/context/profile с самого раннего allocation, независимо settle-ит все cleanup одного
  phase через `Promise.allSettled`, всегда запускает вторую phase и не маскирует primary failure. Failure-injection
  contour дал RED `3/0/3` → GREEN `3/3/0`.
- Финальные affected suites этого цикла: artifact/release `16/16/0`; PWA/cleanup/brand/predecessor/version
  `19/19/0`; production/context/child lifecycle `24 total / 23 pass / 0 fail / 1` честный POSIX-only skip;
  candidate secret contracts `5/5/0`. Совокупно `64 total / 63 pass / 0 fail / 1 skip`. Во время первого
  production integration run обнаружен отдельный test-only RED: raw-build regex ошибочно принимал обязательный
  `--no-build` за raw build (`24 total / 22 pass / 1 fail / 1 skip`); явная regression добавлена, token match
  исправлен, exact seam и полный affected production suite повторены зелёными.
- Static gates: `lint` green; `check` — 538 JS, 165 inline handlers / 106 names; source/context scan —
  1441 tracked + 62 explicit, 839 Docker `COPY`, 1503 unique reads; history — 345 commits; семь изменённых
  JS-файлов проходят `node --check`; `git diff --check` green. Cycle 12 не менял ни один файл
  `HELPER_BUNDLE_FILES`, поэтому v4 helper digest повторно вычислен без изменения:
  `44067d09cbbc70338032168c92816c7affa72cbea0228ca0fa287c1f970f0970`.
- По ограничению цикла full `npm test`, frontend build, postbuild artifact test, browser E2E/performance,
  final release wrapper и независимые clean audits не запускались; поэтому status/checklist остаются
  `in-progress`, current artifact evidence не заявляется. Docker, network/provider/registry, deploy,
  staging/production mutation, stage и commit не выполнялись; protected untracked paths не изменялись.

## Cycle 13 audit remediation — in-progress, final wrapper pending

- Production image authority теперь отвергает symbolic attached HEAD внутри общей exact-checkout
  проверки и поэтому до, и после freeze. Attached-branch fixture дал RED `1/0/1` до Docker,
  после чего exact detached positive и полный production-image suite прошли `15/15/0`.
  README, release checklist, DR и rehearsal теперь явно доказывают detached HEAD перед wrapper;
  docs/CLI contract дал RED `1/0/1` → GREEN `1/1/0`.
- Staging release-pair publication теперь владеет четырьмя exact temp/final paths по pinned
  no-follow identity. Archive write/hash/mv и sidecar write/mv failures независимо удаляют только
  transaction-owned paths, а verified recovery требует exact prepublication-store authority и полную
  проверку после снятия reservations. Исходный boundary RED был `2/0/2`; финальные
  publication/cleanup/post-reservation/first-deploy/docs contours прошли `5/5/0`. Любая недоказанная
  очистка сохраняет честный recovery step/status 70 и не печатает success evidence.
- `RELEASE_CHECKLIST.md` больше не повторяет июльские performance-цифры как current evidence:
  он ссылается на historical/superseded baseline и явно ждёт единственный финальный wrapper.
  Централизованный historical-evidence contract дал RED `1/0/1` → GREEN `1/1/0`.
- Real-Linux flock integration владеет nullable resources с первого allocation. Cleanup сначала
  all-settled открывает три barrier, затем параллельно TERM→KILL и bounded-await все четыре
  child handle и только потом удаляет fixture root; cleanup errors не маскируют primary и идут
  после него в `AggregateError`. Failure-injection test дал RED `1/0/1` → GREEN `1/1/0`; на Windows
  полный файл честно дал `2 total / 1 pass / 0 fail / 1` Linux-only skip.
- Final affected suites: staging deploy `42/42/0`; rollback финально `16/16/0`; production image
  `15/15/0`; frontend release `9/9/0`; helper/archive/runtime/supervisor `24 total / 20 pass / 0 fail / 4`
  platform skips; production child/artifact/secret `21 total / 20 pass / 0 fail / 1` POSIX skip; flock file —
  `2/1/0/1`. Совокупно unique affected files: `129 total / 123 pass / 0 fail / 5 skip`. Первый rollback
  full run дал один неповторившийся tail RED (`16/15/1`): ожидаемый recovery-step был заменён
  поздней reservation-cleanup диагностикой. Exact case сразу прошёл `1/1/0`, а полный
  последовательный rerun — `16/16/0` без edit, поэтому deadline/authority не ослаблялись.
- Изменённый content-addressed v4 helper bundle имеет digest
  `c60caebc479ab57f9c31a3b1b1dc3a9908ebfb849af943b3b8edae9959a6c5e7`; install/pointer/tamper/mixed-generation
  проверки вошли в зелёный helper suite. Static gates: `lint` green; `check` — 538 JS,
  165 inline handlers / 106 names; source/context scan — 1441 tracked + 62 explicit, 839 Docker `COPY`,
  1503 unique reads; history — 345 commits; exact five-file Git Bash syntax и `git diff --check` green.
- Cycle 13 не менял `public/` runtime bytes, поэтому frontend build/Chromium не повторялись. Full
  `npm test`, postbuild artifact test, final wrapper и clean audits также остаются pending; status —
  `in-progress`, current artifact evidence не заявляется. Docker, network/provider/registry, deploy,
  staging/production mutation, stage и commit не выполнялись; protected paths не изменялись.

## Cycle 14 audit remediation — in-progress, final wrapper pending

- Rollback больше не заявляет normal success или `verified prior state restored` до точного удаления
  temporary image, всех identity-bound reservations, private workdir и transaction marker. Только после
  этого reservation-free whole-store validation и exact active image/tree/marker/running/readiness proof
  разрешают claim. Late image/reservation/workdir/marker failures, post-reservation debris и post-workdir
  running-image drift возвращают status 70 без success; первый recovery cause не перезаписывается поздней
  cleanup-ошибкой. Три focused RED были `1/0/1` каждый; после исправления — `1/1/0` каждый, полный
  последовательный rollback suite — `19/19/0`. Общий reservation removal теперь также доказывает exact
  отсутствие каждого файла, а side-effect+error transaction-marker removal перепривязывает только доказанное
  absent state, чтобы fail-closed marker можно было записать безопасно.
- Cycle 14 interim retirement plan (superseded by the strict Cycle 15 authority below) сохранял
  отсортированный exact retirement plan в release-qualified client-state cache. Delayed ready-prune
  удалял только имена из этого plan и никогда
  заново не классифицирует `caches.keys()`: устанавливающиеся C static/EGE install+executable/client-state
  namespaces и foreign/unknown caches сохраняются. EGE executable cache теперь включает current `CACHE_NAME`,
  поэтому одинаковый path graph разных releases не разделяет mutable cache. Behavioral и static seams дали
  RED `2/0/2` → GREEN `2/2/0`; первый affected aggregate выявил test-harness-adjacent missing-plan async
  rejection (`100 total / 99 pass / 1 fail`), после fail-safe `missing plan => no prune` финальный
  EGE/offline/frontend-release aggregate прошёл `99/99/0` без динамического rescan.
- Все executable Bash snippets production/DR/rehearsal теперь принимают `git symbolic-ref -q HEAD` только
  при exact status 1: attached status 0 и unreadable/error status 128 fail closed. Focused executable+docs
  RED был `3 total / 1 pass / 2 fail`, GREEN — `3/3/0`. Experimental operations checklist исправлен на
  фактический четырёхаргументный deploy helper contract
  `RELEASE_ARCHIVE EXPECTED_SHA256 immutable-archive-v4 BUNDLE_SHA256`.
- Final affected validation этого цикла: rollback `19/19/0`; shared-common deploy success/recovery/late-cleanup
  subset `6/6/0`; EGE/SW/offline/frontend release `99/99/0`; production image/docs `16/16/0`; helper bundle
  `4 total / 3 pass / 0 fail / 1` честный POSIX-only bootstrap skip; runtime authority `8/8/0`.
  Совокупно `152 total / 151 pass / 0 fail / 1 skip`. Новый content-addressed v4 helper digest:
  `97f3d308895df0badd4dc407606f2d973012a6ff288c7ab75645e30d69532fcd`.
- Static gates: `lint` green; `check` — 538 JS, 165 inline handlers / 106 names; source/context scan —
  1441 tracked + 62 explicit, 839 Docker `COPY`, 1503 unique reads; history — 345 commits; семь
  изменённых JS-файлов проходят `node --check`; exact five-file Git Bash syntax и `git diff --check` green.
- Cycle 14 меняет `public/service-worker.js`, поэтому frontend build, postbuild artifact verification,
  browser E2E/performance и final wrapper намеренно не запускались по ограничению цикла; full `npm test`
  также не запускался. Current artifact/SW/browser/performance evidence недоступен до единственного финального
  `npm run test:release:aisy`; Ticket остаётся `in-progress`. Docker, network/provider/registry, deploy,
  staging/production mutation, stage и commit не выполнялись; protected paths не изменялись.

## Cycle 15 audit remediation — in-progress, final wrapper pending

- Temporary staging image считается отсутствующим только когда bounded exact-reference probe успешно
  возвращает пустой результат. Timeout 124, daemon/error 128/1, ambiguous output и identity drift дают
  status 70, сохраняют первый causal marker и подавляют normal/recovery claim; foreign replacement не
  удаляется. Один common ordered finalizer владеет image → reservations → private workdir → transaction
  marker → operation-specific exact-state proof, не смешивая deploy publication/backup и rollback target
  semantics. Исходный focused RED был `3/0/3`; initial GREEN — `3/3/0`. Симметричные normal/recovery
  ambiguity matrices, три prebuild statuses и reservation-free store proof прошли `5/5/0`.
- Service worker больше не хранит broad Aisy-prefix snapshot. Activation атомарно записывает bounded
  `aisy-pwa-retirement-plan-v2` только из immutable predecessor compatibility identity (schema, full base
  commit, content SHA-256, exact cache name); 1024-byte/count/name/schema validation и missing/tampered
  record дают `no prune`. Restart regression удаляет exact A, но сохраняет уже существующий future C,
  colliding prefix, foreign, unknown и current B; EGE executable cache release-qualified. Behavioral/static
  RED `2/0/2` закрыт GREEN `2/2/0`.
- Production image dual-failure RED `1/0/1` теперь сохраняет context-generation failure первым и Docker
  exit вторым только после exact reap; GREEN `1/1/0`. Predecessor generation RED `1/0/1` теперь не печатает
  success до cleanup, а primary generation + cleanup failure возвращает primary-first `AggregateError`;
  GREEN `1/1/0`.
- Affected non-staging aggregate: `102 total / 101 pass / 0 fail / 1` честный POSIX-only parent-death skip.
  Первый полный последовательный deploy+rollback run: `69 total / 66 pass / 3 fail`; два causal archive
  mutation failure исправлены переносом capture exact built-image identity сразу после успешного build и
  до checksum/promotion, затем homologous targeted GREEN `2/2/0`. Редкий Windows-only reservation drift
  был доказан отдельным RED `0/1`: при неизменных dev/inode/mode/link/owner/size менялось только неавторитетное
  `blocks` (`8→16`). Windows authority теперь использует exact size и не сохраняет `blocks`; Linux по-прежнему
  доказывает `blocks × 512`. Runtime-authority GREEN `9/9`; final sequential deploy `47/47/0`, rollback
  `22/22/0`, вместе `69/69/0`. Current helper-bundle digest:
  `980ce1471c03ed4ee781af7b2690a00a65891ca29f553352d297a5208af1f279`.
- Final affected helper/runtime/release-static aggregate — `23 total / 22 pass / 0 fail / 1` честный
  POSIX-only bootstrap skip. `node --check` прошёл для всех `11/11` изменённых Cycle 15 JavaScript
  implementation/test files; exact five-file Git Bash syntax — `5/5`. `lint`, `check` (`538` JavaScript,
  `165` inline handlers / `106` names), source/context secrets (`1441` tracked + `62` explicit candidate,
  `839` Docker COPY inputs, `1503` unique reads), history (`345` commits) и `git diff --check` зелёные.
- Cycle 15 меняет `public/service-worker.js` и release scripts. Поэтому full `npm test`, final wrapper,
  frontend build, artifact verify, browser E2E/performance и clean audits намеренно не запускались по
  ограничению цикла; current artifact evidence недоступен. Docker, network/provider/registry, deploy,
  staging/production mutation, stage и commit не выполнялись; protected paths не изменялись.

## Cycle 16 audit remediation — in-progress, final wrapper pending

- Update/ready quorum теперь положительно включает только legacy learner shell `/`/`/index.html` и
  exact same-origin WindowClient, зарегистрированный learner-shell handshake. Health, API, internal,
  static и passive controlled windows не блокируют consent либо delayed prune; настоящий app deep link
  после handshake остаётся участником. Два focused behavioral seams дали RED `2 total / 0 pass / 2 fail`
  → GREEN `2/2/0`; полный affected offline/SW suite — `80/80/0`.
- Docker image identity принимается только как одна canonical строка `sha256:` + 64 lowercase hex.
  Exact temporary tag повторно сверяется непосредственно перед tag-only removal; rebound/mismatch
  сохраняется, immutable ID никогда не становится removal target. Malformed/rebound seams дали два
  независимых RED `1/0/1` → GREEN `1/1/0`; focused staging matrix с publication boundaries прошла
  `6/6/0`.
- Bounded output capture владеет unique private entry, публикует финальный путь atomic no-replace и
  никогда не удаляет замену по публичному path. Overflow остаётся primary перед cleanup failure.
  Replacement RED `1/0/1` закрыт GREEN `1/1/0`; полный файл — `3/3/0`.
- Retained archive/sidecar используют atomic no-replace hard-link publication. Cleanup сначала
  атомарно изолирует path в private quarantine, сверяет exact inode authority и не удаляет foreign
  replacement. Две faithful race-проверки дали RED `2/0/2` → GREEN `2/2/0`; затем все пять partial
  publication boundaries с immediate retry и обе race-проверки вошли в зелёный focused staging contour.
- Windows reservation authority теперь исключает неавторитетное поле `blocks` из каждого
  lstat/fstat/path comparison внутри одного capture, а не только из итоговой записи. Intra-capture RED
  `1/0/1` (`changed while opening`) закрыт GREEN `2/2/0`; отдельный Linux fixture сохраняет обязательное
  доказательство `blocks × 512 >= size`.
- Supervisor использует tri-state group probe: `ESRCH=absent`, `EPERM=alive`, прочая ошибка остаётся
  explicit unknown. После SIGKILL отдельный terminal deadline требует group absence и leader close/reap;
  builder имеет такую же bounded close/reap границу и очищает listeners/timers. Supervisor RED `3/0/3`
  → GREEN `3/3/0`; builder close-hang RED `1/0/1` → GREEN `1/1/0`; полный lifecycle aggregate —
  `18 total / 14 pass / 0 fail / 4` честных POSIX-only skip на Windows.
- Release artifact publication при одновременной candidate-verification и recovery ошибке сохраняет
  оба исходных Error в primary-first `AggregateError`, не склеивая их строки. Focused RED `1/0/1` →
  GREEN `1/1/0`; полный artifact suite — `8/8/0`. Соседние runtime/bounded/artifact suites прошли
  `22/22/0`, production authority/docs — `16/16/0`.
- Первый полный sequential deploy+rollback run дал `73 total / 72 pass / 1 fail`: единственный RED был
  не production regression, а устаревшая failure injection, которая всё ещё ждала cleanup по публичному
  final path. Новый cleanup сначала атомарно перемещает exact inode в private quarantine, поэтому fixture
  перестал достигать реальной removal boundary. Injection перенесён на первый exact quarantine
  `owned-entry`, а store-tamper — на тот же новый boundary; formerly failing case сразу прошёл `1/1/0`,
  полный последовательный rerun — `73/73/0` (`deploy 51/51`, `rollback 22/22`).
- Изменённый content-addressed v4 helper bundle имеет digest
  `a2179cbbaaf29242d10bc0695c11df3a39399a497e1a61227d905034f0dfe600`; helper install/pointer/tamper,
  archive, lock, runtime и PWA static aggregate прошёл `35 total / 33 pass / 0 fail / 2` честных
  platform skip. Первый aggregate дал один adjacent RED: multigeneration client fixture ожидал только
  `SKIP_WAITING`, хотя новый обязательный handshake правильно предшествует consent для B и C. Assertions
  теперь явно требуют registration-before-consent и C-registration-without-auto-apply; rerun зелёный.
- Unique affected contour за Cycle 16: `233 total / 227 pass / 0 fail / 6` честных Windows/POSIX skip.
  Static gates: `lint` green; `check` — 538 JavaScript, 165 inline handlers / 106 names;
  source/context scan — 1441 tracked + 62 explicit, 839 Docker `COPY`, 1503 unique reads; history —
  345 commits; семь implementation JS и exact пять Bash helper files проходят syntax; `git diff --check`
  green.
- Full `npm test`, final wrapper, frontend build, artifact postbuild,
  browser E2E/performance и clean audits не запускаются по ограничению цикла; current artifact evidence
  недоступен. Docker, network/provider/registry, deploy, staging/production mutation, stage и commit не
  выполнялись; protected paths не изменялись.

## Cycle 17 audit remediation — superseded freeze; wrapper attempt failed

- Исправлено устаревшее static PWA assertion: focused exact seam прошёл `1/1`, affected PWA/security
  contour — `109/109`. Тогдашний freeze содержал `133` файла / `6 384 983` байта / SHA-256 prefix
  `528eab8a…`.
- Первый wrapper attempt остановился на stale assertion. Он не является release evidence, а Cycle 17
  freeze superseded последующими изменениями.

## Cycle 18 browser remediation — diagnostic wrapper attempt only

- Built browser contour выявил реальный `#toast`, перекрывавший Speaking CTA. Удалён только дублирующий
  `offerUpdate` toast; in-frame live notice и snooze toast сохранены. Focused seam прошёл RED → GREEN
  `1/1`, affected contour — `17/17`.
- Второй wrapper дошёл через source/unit/build до `2315 total / 2258 pass / 57` ожидаемых skip /
  `0` unit fail и собрал artifact digest prefix `f460870d…`, но built E2E упал на toast. Поэтому весь attempt,
  включая artifact, является diagnostic и не считается current release evidence.

## Cycle 19 audit remediation — in-progress, final wrapper pending

- Bounded service-worker wait прошёл `18/18`; production image/docs first pass — `17/17`.
- Staging archive стал descriptor-bound/no-follow и preallocated до `256 MiB` с независимым
  `64 MiB` headroom. Bounded stream прошёл `10 pass / 1` Windows symlink skip; upload matrix —
  `4 pass / 1` Windows symlink skip; adjacent deploy — `4/4`; helper — `3 pass / 1` POSIX skip.
- Старый helper digest prefix `c72…` superseded и не является current authority.

## Cycle 20 audits — no ZERO certification

- Exact freeze inventory: `134` файла / `6 447 055` байт / SHA-256 prefix `1d4d2722…`.
- Аудиты нашли mutable production app image, public staging sentinels и stale evidence. Поэтому Cycle 20
  не получил `ZERO_FINDINGS`, его freeze не является accepted release authority, а final wrapper остаётся
  pending.

## Cycle 21 local remediation — complete; new freeze and release evidence pending

- Compose и каждый production/recovery/restore path теперь требуют canonical
  `EASYBOOST_PRODUCTION_APP_IMAGE_ID`, выполняют preflight, используют `--no-build` и stop/fail при
  несовпадении running `.Image`. Focused production suite прошёл `28/28`.
- Staging resolved Compose до Docker/state mutation отклоняет public JWT/DB/monitoring placeholders:
  focused seam RED `1` → GREEN `1`, adjacent contour — `2/2`, helper — `3 pass / 1` POSIX skip.
- Current content-addressed v4 helper digest:
  `303914b98e3666d152291cba6eb36b2fab46ff8e4844719143396de3004204da`.
- Pre-metadata candidate snapshot — только checkpoint, не accepted freeze: HEAD prefix `d367…`;
  `73` changed + `62` explicit = `135` union files; `6 468 956` байт; SHA-256
  `25d053e7e55001fa645b8868b8cecb5c3be3d94d5df51888ad958386c01ec4ac`; staged `0`.
- В Cycle 21 не запускались Docker, frontend/production build, browser E2E, full release wrapper,
  network/provider calls или deploy; staging/production mutation, stage и commit не выполнялись.
  Новый accepted freeze, два свежих независимых `ZERO_FINDINGS` и финальный
  `npm run test:release:aisy` остаются pending; current artifact/E2E/performance evidence недоступен,
  deployment не выполнялся и Ticket остаётся `in-progress`.

## Cycle 22 local remediation — complete; freeze and final reviews pending

- PWA update больше не зависит от отсутствующего `controllerchange`: только document, который дал consent
  точному waiting worker, один раз reload при его `activated`; passive/nonconsenting tab не получает
  `clients.claim()` и не reload. Exact RED был `2 pass / 1 fail`, обязательный PWA/brand/offline/HTTP/security
  affected-контур после исправления и обновления строгих static assertions прошёл `118/118`.
- Service worker выходит до `respondWith` для segment-bounded case-insensitive `/api`, `/internal`, `/health`
  и exact root `/?login_code=…`. Health middleware возвращает `no-store`, `Pragma: no-cache`, `Expires: 0`;
  built two-version E2E расширен poisoned-cache/online/offline regressions и ждёт единственный final wrapper.
- `db:backup` и `db:verify-backup` fail-closed требуют canonical app image ID; cron получает его из
  root-owned `/etc/easyboost/production-app-image-id`. Release gate до старта доказывает owner-approved
  PostgreSQL image и running `.Image`; legacy dry/live JSON import использует guarded exact-image one-off
  container. Focused production contour прошёл `39 total / 38 pass / 0 fail / 1` PostgreSQL-environment skip.
- Staging verifier сохраняет weak-pattern guard и дополнительно сверяет redacted SHA-256 inventory всех пяти
  опубликованных credential sentinel из `.env.staging.example` и `.env.example`. Integration RED подтвердил
  пропущенный production JWT; GREEN `1/1` отклоняет все пять до Docker/state mutation без вывода значений.
  Helper suite прошёл `3 pass / 1` POSIX skip; independent read-only review вернул `ZERO_FINDINGS`.
- Current content-addressed v4 helper digest:
  `b5517e4c72251c979d20d21a6c4ddb319f0e08eebc7eb07f306bbccdea6b414d`.
- В Cycle 22 не запускались Docker, frontend/production build, built browser E2E, full release wrapper,
  network/provider calls или deploy; staging/production mutation, stage и commit не выполнялись. Новый exact
  freeze, два свежих независимых whole-candidate `ZERO_FINDINGS` и финальный `npm run test:release:aisy`
  остаются pending; Ticket остаётся `in-progress`, checklist unchecked.

## Cycle 23 production-ops review remediation — complete; new freeze pending

- Independent production-ops review отклонил Cycle 22 freeze `480194ad…`: executable release block не был
  fail-fast, legacy import после create использовал mutable container name, а cron-authority persistence мог
  ложно завершиться успешно после `sudo install` failure. Этот freeze не является accepted authority.
- Release gate теперь начинается с `set -euo pipefail`. Исполняемый failure-injection seam был RED `0/1`
  и GREEN `1/1`: failures в `npm ci`, обоих test gates, audit, `docker pull` и guarded production build не
  достигают поздних image inspect/Compose start операций.
- Guarded legacy import принимает только canonical 64-hex ID, возвращённый `docker compose run --detach`,
  немедленно доказывает exact `.Id` и использует только этот immutable ID для `.Image`, running, copy, exec
  и cleanup. Name replacement не получает импорт и не удаляется; primary + cleanup errors сохраняются
  primary-first `AggregateError`. Exact race/error seam прошёл RED `0/3` → GREEN `3/3`.
- Cron authority сохраняется через fail-fast block и root-owned same-directory temporary file с atomic rename.
  Injected staged-install failure был RED `0/1`, GREEN `1/1`; предыдущий approved authority остаётся byte-identical.
- Final focused production contour: `42 total / 41 pass / 0 fail / 1` штатный `TEST_DATABASE_URL` skip;
  three syntax checks, focused ESLint и diff-check green. Docker, build, network/provider, deploy, production/
  staging mutation, stage и commit не выполнялись. Нужны новый exact freeze и fresh whole-candidate audits.

## Cycle 24 import-allocation lifecycle remediation — complete; new freeze pending

- Re-review подтвердил три Cycle 23 fix, но отклонил кандидат из-за post-create/no-ID boundary: Compose мог
  создать long-lived one-off и затем вернуть error или malformed stdout до записи owned immutable ID.
- Allocation теперь до внешнего вызова получает случайный 256-bit ownership label и доказывает пустой
  preflight inventory. После любого исхода — success, side-effect+error или malformed stdout — label-filtered
  inventory возвращает ноль либо ровно один canonical ID; exact label и `.Id` независимо доказываются до
  import/cleanup. Ambiguous/foreign inventory fail-closed ничего не удаляет, а orphan runtime дополнительно
  ограничен 3600 секундами.
- Обязательные lifecycle seams прошли RED `0/4` → GREEN `4/4`; existing replacement/dual-error — `3/3`,
  весь production-import focus — `8/8`, allocation-primary + recovery-failure ordering — `1/1`.
  Primary/recovery/cleanup причины сохраняются в primary-first `AggregateError`.
- Final focused production files: `47 total / 46 pass / 0 fail / 1` штатный `TEST_DATABASE_URL` skip;
  syntax `3/3`, focused ESLint и diff-check green. Docker, build, network/provider, deploy, production/staging
  mutation, stage и commit не выполнялись. Нужны новый exact freeze и fresh whole-candidate audits.

## Cycle 25 bounded one-off remediation — complete; new freeze pending

- Re-review заметил, что finite `sleep 3600` без `--rm` мог наследовать production `restart: unless-stopped`
  и поэтому не доказывал bounded orphan lifetime. Compose allocation теперь использует `run --rm --detach`;
  `--rm` находится до service name и отменяет restart policy, а finite sleep остаётся defense-in-depth.
- Exact argument seam прошёл RED `0/2` → GREEN `2/2`; final focused production files снова дали
  `47 total / 46 pass / 0 fail / 1` штатный `TEST_DATABASE_URL` skip. Syntax, focused ESLint и diff-check
  green. Docker, build, network/provider, deploy, production/staging mutation, stage и commit не выполнялись.

## Cycle 26 whole-candidate audit remediation — complete; new freeze pending

- Whole-candidate Cycle 25 freeze `14eb3e060d3f432fe19c898b6ce4997a22679d7cbdf6ac0a308080c6906f7f25`
  отклонён независимыми Standards/Spec аудитами и остаётся только исторической записью. Найдены три
  production lifecycle/error-ordering границы, fail-fast/DB-authority разрывы в runbook и второй solid
  coral control в update notice; ни один из них не переносится в новый freeze.
- Update notice теперь использует paper secondary, пока deep-task CTA остаётся единственной solid primary.
  Static/browser contracts проверяют класс, различимый фон и target не менее 44 px на 320/375/landscape/1440
  во Writing/Reading/Speaking. Focused brand/release/PWA contour прошёл `20/20`; независимый bounded
  re-review вернул `ZERO_FINDINGS`.
- JSON import сохраняет исходные объекты ошибок в точном порядке query/import → rollback → disconnect;
  `cause` остаётся первичной ошибкой, успешный commit с disconnect failure честно завершается ошибкой.
  Focused import suite прошёл `17 total / 16 pass / 0 fail / 1` штатный PostgreSQL-environment skip;
  независимый bounded re-review вернул `ZERO_FINDINGS`.
- Все полные production/DR/rehearsal Bash-процедуры имеют одну fail-fast границу. Первый запуск идёт
  PostgreSQL-only → exact approved running `.Image`/readiness → app `--no-deps`; update, rollback, secret
  rotation, DR, rehearsal и restore не могут неявно поднять непроверенную dependency. Failure-injection
  lifecycle TDD прошёл RED `0/5` → GREEN `5/5`; усиленный standalone restore PostgreSQL-authority seam —
  RED `0/2` → GREEN `2/2`; финальный production-image suite — `39/39`.
- Неуспешный nontransactional `pg_restore` оставляет приложение остановленным. Backup verify публикует
  success только после успешного удаления temporary database; cleanup failure пишет failed status, а
  двойные причины сохраняются primary-first. Syntax `3/3`, focused ESLint и diff-check green.
- Первый Cycle 26 candidate snapshot отклонён bounded re-review: staging `create-git` failure мог
  продолжить старый archive до deploy, потому
  что inventory не охватывал все operator fences. Расширенный TDD был RED `0/3` и GREEN `3/3`; полный
  production-image suite прошёл `41/41`. Инвентарь теперь доказывает `32/32` строгих Bash boundaries
  (README `19/19`, DR `6/6`, Experimental `7/7`), а injected exit 73 останавливается до inspect/hash/helper/
  sudo. Независимый re-review вернул `ZERO_FINDINGS`, PRE=POST scoped SHA-256
  `c20231c81f2e71e7b938db639aaea4d6cf1386042a3f6e9730ffb84e663d8f8a`.
- Новый exact whole-candidate freeze, два свежих независимых whole-candidate audits и единственный финальный
  wrapper остаются pending. Frontend/production build,
  browser E2E/performance, Docker, network/provider, deploy, production/staging mutation, stage и commit
  в Cycle 26 не выполнялись; checklist остаётся unchecked до текущего built evidence.

## Cycle 27 whole-candidate audits — rejected; Cycle 28 remediation complete

- Два независимых whole-candidate аудита точно сохранили PRE=POST freeze
  `ed02fc8ec9fd1bde263d18716979decd534861443f240e1e51f2c7b8ca2fe0a7`
  (`77` tracked changes + `62` explicit, `139/139` present, `0` missing, `6 608 009` bytes, staged `0`),
  но отклонили его с восемью уникальными findings: шесть P1 и два P2. Поэтому этот freeze не является
  accepted authority и финальный wrapper на нём не запускался.
- Release E2E больше не наследует live-looking xAI/Groq/Azure/provider configuration: все 26 inventory
  children и прямой EGE written server получают общий fail-closed environment до старта. TDD был RED
  `0/1` → GREEN `1/1`; focused source/EGE safety contour прошёл `31/31`.
- Guarded legacy import contract теперь требует ровно dry-run + live wrapper с absolute host path и запрещает
  raw Compose. Staging post-commit failure hook привязан к нужной phase и действительно достигает finalizer,
  сохраняя committed candidate при status 70. TDD оба раза `0/1` → `1/1`; predecessor suite `9/9`, exact
  post-commit integration `1/1` за `70.59 s`.
- Bootstrap/helper root-layout policy канонизирует пути до мутации, требует explicit approved prefix для
  custom roots и отклоняет filesystem root, `/tmp/..`, broad/reserved parents, prefix escape, symlink ancestor
  и любые overlaps. Helper suite прошёл `7 total / 5 pass / 0 fail / 2` POSIX-only Windows skips; Linux CI
  остаётся authority для двух executable bootstrap cases. Новый v4 helper digest:
  `be433b650a4b86003b7db117d184a82e21ddfde667e07b2816b1765a8768b5f2`.
- Release checklist после exact PostgreSQL proof стартует только app `--no-deps`. Backup/verify требуют
  canonical app + PostgreSQL IDs и exact running PostgreSQL `.Image`; verify до success доказывает полный
  local migration set/latest и critical tables `users`, `user_progress`, `module_attempts`, `word_progress`,
  `schema_migrations`, затем удаляет temporary DB. Publication failure добавляется после primary/cleanup.
- Standalone restore объединяет app up → container ID → exact image → bounded readiness в одну fail-closed
  границу; любой post-start failure останавливает app, а stop failure сохраняется после primary. PWA runbooks
  теперь описывают exact consented waiting-worker `statechange` → `activated` reload без `clients.claim()`;
  `controllerchange` — только idempotent fallback, а отсутствие activation квалифицировано incomplete quorum.
- Production-image suite после self-review remediation прошёл `52/52`. Совместный root focused contour
  frontend/release/predecessor/helper/production прошёл `80 total / 78 pass / 0 fail / 2` POSIX skips;
  отдельный post-commit staging case — `1/1`. Agent-local syntax, focused ESLint и root diff-check green.
- Один ранний import-safety RED только попытался разобрать отсутствующий local temporary Compose path и
  завершился до container/DB side effect; после import-safe refactor Docker не вызывался. Реальные provider,
  network, DB, Docker mutation, build/browser, deploy, stage и commit не выполнялись. Новый exact freeze,
  два свежих whole-candidate `ZERO_FINDINGS` и единственный финальный wrapper остаются pending.

## Cycle 29 whole-candidate audits — rejected; Cycle 30 remediation complete

- Fresh Standards/Spec audits сохранили PRE=POST freeze
  `22843e5bb23b09bc1e292a3ed14e02a409e240f3f4171d9e1968f0cb042d5ce0`
  (`78` tracked changes + `62` explicit, `140/140` present, `0` missing, `6 695 655` bytes, staged `0`),
  но отклонили его с тремя уникальными findings: два P1 и один P2. Freeze superseded; wrapper на нём
  не запускался.
- Import CLI теперь разбирает exact argv grammar до source/Docker/DB access: unknown/duplicate flags,
  extra/missing/blank source и invalid combinations получают usage exit 2; silent fallback удалён.
  Process sentinels доказывают, что typo `--dry-rnu` не достигает Docker или PostgreSQL, а valid dry/live
  grammar сохраняется. Import suite: `24 total / 23 pass / 0 fail / 1` PostgreSQL-environment skip.
- Отдельный performance server child теперь использует тот же `createReleaseServerEnvironment`, что и
  остальные canonical release children. Loopback/file fixture overrides сохраняются, а inherited monitoring,
  Telegram, xAI, Groq, Azure/voice flags, URLs и credentials fail-closed удаляются до spawn. RED `0/1` →
  GREEN `1/1`; focused release safety `12/12`.
- Семь app lifecycle procedures (release, first launch, update, rollback, DR, secret rotation, rehearsal) и
  оба guarded import fences после exact running PostgreSQL `.Image` выполняют до 30 bounded `pg_isready -t 2`
  probes; app стартует только затем. App readiness также bounded (`curl` connect/max 2 s); start/ID/image/
  readiness failures вызывают primary-preserving candidate stop. DB timeout не достигает app allocation.
- DR/rehearsal public readiness также bounded/fail-closed; expected-monitoring failure contract сохранён.
  Static readiness/import RED `0/2` → GREEN `2/2`; executable delayed/timeout matrix RED `0/1` → GREEN `1/1`;
  final production-image suite `56/56`.
- Совместный root contour import/release/production прошёл `92 total / 91 pass / 0 fail / 1` PostgreSQL skip.
  Agent/root syntax, focused ESLint, full syntax/inline checks и diff-check green. Build/browser, network/provider,
  DB/Docker mutation, deploy, stage и commit не выполнялись. Новый exact freeze, два fresh whole-candidate
  `ZERO_FINDINGS` и единственный финальный wrapper остаются pending.

## Cycle 31 whole-candidate audits — rejected; Cycle 32 remediation complete

- Fresh Standards/Spec audits сохранили PRE=POST freeze
  `c5d677e32ed6eb5bfcc58ae3a3f68d9c4e4165ed38a1192e061cdca8d8b55c8a`
  (`78` tracked + `62` explicit, `140/140` present, `0` missing, `6 741 702` bytes, staged `0`),
  но отклонили его с одним P1 и одним P2. Freeze superseded; wrapper на нём не запускался.
- Release child environment больше не строится как неполный denylist поверх owner shell. Явный allowlist
  переносит только cross-platform OS/tooling paths (PATH/SystemRoot/temp/home/local cache, Chrome/Playwright),
  fail-closed defaults и затем trusted fixture overrides. `NODE_OPTIONS`, VK/API/DB/auth/rate/AI/model/voice/
  timeout и любые другие app-owned значения не наследуются. Hostile real-config RED на VK redirect origin
  стал GREEN; frontend release suite `13/13`.
- Все семь app lifecycle fences перед `up` фиксируют и доказывают optional previous canonical Compose app ID.
  После success или partial failure они восстанавливают current allocation, сохраняют совпадающий previous ID
  и принимают cleanup только для distinct canonical ID с exact `.Id`, `service=app`, `oneoff=False` labels.
  Остановка идёт bounded `timeout … docker stop --time 10 <immutable-id>`; cleanup failure/timeout не маскирует
  primary status. Service-wide `docker compose stop app` в этих процедурах отсутствует.
- Static и executable old-container sentinel оба были RED `0/1` и стали GREEN; targeted lifecycle `4/4`,
  full production-image `57/57`. Совместный root import/release/production contour прошёл
  `94 total / 93 pass / 0 fail / 1` PostgreSQL skip. Syntax, focused ESLint и diff-check green.
- Build/browser, network/provider, DB/Docker mutation, deploy, stage и commit не выполнялись. Новый exact
  freeze, два fresh whole-candidate `ZERO_FINDINGS` и единственный финальный wrapper остаются pending.

## Cycle 33 whole-candidate audits — rejected; Cycle 34 remediation complete

- Fresh Standards/Spec audits сохранили PRE=POST freeze
  `eb3c391d60fbe8317813e6e75efb377fe729ca894eaa48b990e6744eaecdfaf6`
  (`79` tracked changes + `62` explicit, `141/141` present, `0` missing, `6 785 044` bytes, staged `0`),
  но отклонили его с семью уникальными findings: executable import не доказывал PostgreSQL authority;
  standalone restore использовал mutable service-wide lifecycle; Docker/pg children были unbounded; import
  source не имел end-to-end digest binding; `docker compose config` мог печатать resolved secrets; семь
  runbooks не восстанавливали previous stopped state; cleanup failure не давал verified/manual recovery.
  Freeze superseded; wrapper на нём не запускался.
- Import CLI теперь связывает exact dry-run `sourceSha256` с live import. Production path до app allocation
  доказывает canonical PostgreSQL ID/`.Id`/`.Image`/`service=postgres`/`oneoff=False` и bounded readiness;
  source freeze использует no-follow single-link bounded descriptor snapshot, а one-off повторно хэширует и
  парсит те же descriptor-stable bytes до DB. Каждый Docker child ограничен hard deadline, output cap,
  TERM→KILL и bounded reap; все stream/cleanup failures сохраняют primary-first порядок. Два последующих
  focused-review HIGH (stdout от `pg_isready` и post-`docker cp` digest gap) воспроизведены RED и закрыты.
  Import suite: `38 total / 37 pass / 0 fail / 1` PostgreSQL-environment skip.
- Canonical Compose validation использует `config --quiet`; hostile-secret harness не обнаружил утечек.
  Семь lifecycle procedures фиксируют previous `.State.Running`, очищают только proven immutable candidate ID,
  bounded проверяют stopped state и сохраняют прежний stopped/running результат. Standalone restore держит
  exclusive operation lock, проверяет exact ID/labels/image/state и больше не вызывает mutable Compose app
  stop/up. Backup/restore/verify children имеют stream abort, hard deadline, TERM→KILL и bounded reap.
  Production-image/runbook suite: `60/60`; независимый focused review этого блока — clean.
- Совместный root contour import/release/production/predecessor прошёл
  `120 total / 119 pass / 0 fail / 1` PostgreSQL skip. Syntax и scoped diff-check green; full lint/check будут
  повторены перед новым freeze. Build/browser, real Docker/DB, network/provider, deploy, stage и commit не
  выполнялись. Новый exact freeze, два fresh whole-candidate `ZERO_FINDINGS` и единственный финальный wrapper
  остаются pending.

## Cycle 35 whole-candidate audits — rejected; Cycle 36 remediation complete

- Fresh Standards/Spec audits сохранили PRE=POST freeze
  `e5c09b18610b1e0efebe579834a7f9f0d42437fb7083e6b270ddb8099d85d877`
  (`79` tracked changes + `62` explicit, `141/141` present, `0` missing, `6 895 942` bytes, staged `0`),
  но отклонили его с девятью уникальными findings. DB scripts теряли proven PostgreSQL ID через mutable
  Compose alias, не фиксировали exact archive bytes, не делили общий lock, допускали overwrite race,
  unbounded TOC capture и silent partial cleanup. Release E2E/predecessor children могли висеть; external
  Google Fonts были ошибочно разрешены; successful staging leader мог оставить same-group descendant.
  Freeze superseded; wrapper на нём не запускался.
- Backup/restore/verify теперь используют один shared bounded lock, доказывают exact canonical PostgreSQL
  ID/labels/image/running state и выполняют все команды только через `docker exec <immutable-id>`.
  Restore/verify no-follow/single-link/bounded фиксируют descriptor snapshot и SHA-256; validation и restore
  читают одни frozen bytes, verify публикует `backupSha256`. Backup публикуется atomic no-replace, TOC capture
  имеет 8 MiB cap, partial cleanup сохраняется secondary с exact recovery evidence. Дополнительный review
  закрыл short writes, final `nlink` race и partial lock-init cleanup. Production-image/runbook suite: `70/70`.
- Новый release command supervisor ограничивает E2E, `git archive`, `tar` и predecessor build hard deadline,
  output cap, stream abort, process-group TERM→KILL и bounded reap. External Google Fonts теперь abort,
  same-origin local Nunito/Manrope разрешены; новый dependency включён в hermetic Docker closure и explicit
  candidate inventory (`64` sorted entries). Release focused contour: `28/28`; lint/check на agent checkpoint
  green (`540` JS; `165` handlers / `106` names).
- Staging supervisor до success проверяет POSIX process group; живой descendant становится primary failure и
  проходит bounded TERM→KILL/group-absence cleanup. Suite: `9 total / 5 pass / 0 fail / 4` честных Windows
  POSIX skips. Новый current v4 helper digest:
  `12fcdd846ab64cb2cc974c9b240666793dd7776e7e9ab7b56fb1955c80944294`.
- Совместный root Cycle 36 contour прошёл `145 total / 140 pass / 0 fail / 5` environment/POSIX skips;
  документированный DB contract повторно прошёл production-image `70/70`. Build/browser, real Docker/DB,
  network/provider, deploy, stage и commit не выполнялись. Root lint/check/diff, новый exact freeze, два fresh
  whole-candidate `ZERO_FINDINGS` и единственный финальный wrapper остаются pending.

## Cycle 37 whole-candidate audits — rejected; Cycle 38 remediation complete

- Fresh Standards/Spec audits сохранили PRE=POST freeze
  `c621eb4a6499d97a8552b71a837100e401ce3f83515c9d367539f2b83decac08`
  (`79` tracked changes + `64` explicit, `143/143` present, `0` missing, `6 990 923` bytes, staged `0`),
  но отклонили его с шестью уникальными findings. Production import доказывал PostgreSQL, затем использовал
  mutable DNS endpoint и не входил в общий DB lock. Frozen backup stat не фиксировал полную identity;
  backup capture не имел hard output cap и stream-error boundary. Reading word dialog содержал inline light-only
  palette, а update notice ссылался на неопределённый `--aisy-shadow-3`. Freeze superseded; wrapper на нём не
  запускался.
- Backup/restore/verify теперь используют общий canonical database-operation lock, hard byte cap для каждого
  capture, stream-error propagation, bounded TERM→KILL/reap и primary-first cleanup. Frozen archive identity
  включает `dev`, `ino`, `mode`, `nlink`, `size`, nanosecond `mtime`/`ctime` до, во время каждого chunk и после
  копирования; same-size torn mutation отклоняется до `pg_restore`. DB core contour прошёл `74/74`.
- Guarded import берёт тот же lock до чтения source и любого Docker/DB действия и держит его до полного cleanup.
  Перед импортом повторно доказываются immutable PostgreSQL ID/image/labels/running state/readiness и единственный
  canonical network IPv4 endpoint; hostname strict `DATABASE_URL` переписывается только внутри one-off, без secret
  в host argv/output. ID/endpoint swap regression закрыты. Import suite: `44 total / 43 pass / 0 fail / 1`
  PostgreSQL-environment skip; shared-lock test `1/1`.
- Reading word popover переведён на semantic Paper tokens для light/dark/system без inline palette; forced-dark
  source/E2E contracts проверяют 10 computed colors, focus trap и targets `>=44px`. Update notice использует
  определённый surface-depth token. UI focused contours прошли `38/38`, `40/40` и `10/10`.
- Параллельный pre-freeze contour сначала воспроизвёл test-harness collision общего import lock
  (`170 pass / 1 fail / 5` skips). Обычные direct-import fixtures получили уникальные test-only lock paths,
  а явные cross-tool exclusion tests сохранили один shared path; тот же совместный root Cycle 38 contour затем
  прошёл `176 total / 171 pass / 0 fail / 5` environment/POSIX skips;
  production/predecessor closure после добавления lock helper — `82/82`. Candidate manifest содержит `66`
  sorted unique entries; current helper digest остаётся
  `12fcdd846ab64cb2cc974c9b240666793dd7776e7e9ab7b56fb1955c80944294`.
- Build/browser, real Docker/DB, network/provider, deploy, stage и commit не выполнялись. Root lint/check/diff,
  новый exact freeze, два fresh whole-candidate `ZERO_FINDINGS` и единственный финальный wrapper остаются pending.

## Cycle 39 whole-candidate audits — rejected; Cycle 40 remediation integrated

- Fresh Standards/Spec audits сохранили PRE=POST freeze
  `b583f8935dde2811d15e854214eb6dcd1dbc6709c3ae951f7c1b279e259184d3`
  (`82` tracked changes + `66` explicit, `148/148` present, `0` missing, `7 083 282` bytes, staged `0`),
  но отклонили его с шестью уникальными findings. Remote `pg_restore` мог продолжить mutation после host timeout;
  production/staging Compose опирались на mutable PostgreSQL tag; документация выдавала RPO/daily off-host и
  historical rehearsal за current evidence; update/translation copy нарушала 16 px floor; словарь показывал
  learner-у технический VPN/key текст. Freeze superseded; wrapper на нём не запускался.
- UI Cycle 40 использует 16 px production floor и typed learner-safe dictionary states без provider/VPN/key leakage;
  Reading сохраняет слово только после подтверждённого online/builtin результата. UI TDD contour — `95/95`,
  а объединённый release/UI/restore/predecessor contour — `153 total / 149 pass / 0 fail / 4` Windows/POSIX skips.
- Restore переведён в один deep supervisor: tokenized in-container watchdog/status и `PGAPPNAME`, bounded host
  deadline/capture, remote cancel/probe, exact-container stop proof и одновременное отсутствие process +
  `pg_stat_activity`. Неподтверждённый settlement либо post-mutation app isolation сохраняет fail-closed recovery
  marker и lock; fresh-host `--database-only` доказывает отсутствие app. Focused restore/lock/production contour —
  `90/90`; реальный test-only retained marker намеренно не удалялся.
- Staging Compose получает только захваченный exact `sha256` PostgreSQL image ID с `pull_policy: never`; helper
  снимает inherited authority, повторно передаёт тот же ID каждому config/up/down/exec/ps и fail-closed отклоняет
  retag. Отдельная post-deploy shell находит ровно один running canonical PostgreSQL container, перепроверяет
  immutable ID/Compose labels/state и только затем экспортирует exact image ID. Rollback — `22/22`; текущий
  полный deploy suite — `59 total / 58 pass / 0 fail / 1` Windows symlink skip. Current helper digest:
  `8aea12c08855032be4539f3c0f5bc81e353e8469c3e96aa923244072e65d8a8e`.
- Production Compose и runbooks также требуют exact PostgreSQL image ID. DR честно фиксирует RPO как цель,
  а не текущую гарантию; внешний storage/schedule/monitoring и свежий production-like rehearsal остаются unchecked
  owner-only prerequisites. Candidate manifest содержит `68` sorted unique entries, включая restore supervisor и тест.
  Import test isolation сохраняет реальный retained marker и проходит `44 total / 43 pass / 0 fail / 1`
  PostgreSQL skip; production/runbook — `81/81`. Совместно с UI/restore/predecessor это даёт Cycle40 integration
  contour `337 total / 331 pass / 0 fail / 6` environment/POSIX skips. Root `lint`, `check` (`544` JavaScript;
  `165` handlers / `106` names) и diff-check зелёные. Первый общий прогон честно поймал только потерянную
  progress-оговорку о superseded artifact evidence (`2475 total / 2413 pass / 1 fail / 61` skips); после
  metadata-contract RED→GREEN `0/1` → `1/1` точный полный rerun прошёл
  `2475 total / 2414 pass / 0 fail / 61` environment/POSIX skips.
- Build/browser, real Docker/DB, network/provider, deployment, stage и commit не выполнялись. Новый exact freeze,
  два fresh whole-candidate `ZERO_FINDINGS` и единственный финальный wrapper остаются pending.

## Cycle 41 whole-candidate audits — rejected; Cycle 42 remediation integrated

- Fresh whole-candidate audits отклонили Cycle 41 candidate с `16` уникальными findings. Этот freeze superseded;
  отдельный digest для него в checkpoint не заявляется, и он не используется как release authority. Wrapper, frontend/
  production build и browser E2E на нём не запускались.
- Cycle 42 ввёл один root-owned host-operation guard для production app lifecycle и guarded import. Import
  дополнительно удерживает database-operation lock, требует полного отсутствия app до DB mutation и до
  `docker cp` проверяет exact owner image, SHA-256 source binding и append-only protocol attestation. Live import
  либо атомарно добавляет неколлидирующие identities/progress, либо полностью откатывается; неоднозначное
  завершение подтверждается tagged `pg_stat_activity`, а недоказанный settlement сохраняет оба guard/lock и
  типизированное recovery evidence.
- Production app replacement больше не раскладывается на независимые stop/start окна: guarded atomic `replace`
  удерживает тот же host guard от проверки exact previous image до удаления старой allocation, запуска exact new
  image и bounded readiness/cleanup proof. Restore/lifecycle focused contour прошёл `20/20`; import+lock —
  `63 total / 62 pass / 0 fail / 1` PostgreSQL-environment skip.
- Production image требует immutable `node:22-bookworm-slim@sha256:<64hex>` для обоих Docker stages и не передаёт
  authority дальше как ambient env. Windows release child удерживается Job Object supervisor; staging app restart
  выполняется отдельным guarded helper. Production-image/runbook suite прошёл `81/81`; candidate manifest содержит
  `73` Node-order sorted unique entries.
- Независимый import review повторил объединённый no-Docker/no-DB contour: `77 total / 76 pass / 0 fail / 1`
  PostgreSQL-environment skip и вернул `ZERO_FINDINGS`. Это focused seam review, а не один из двух ещё требуемых
  whole-candidate release audits.
- Ticket остаётся `in-progress`: mandatory full local gates, новый exact freeze, два fresh whole-candidate
  `ZERO_FINDINGS` и единственный финальный wrapper остаются pending. Frontend/production build, browser E2E,
  real Docker/DB, network/provider/registry calls, deploy/staging/production mutation, stage и commit не выполнялись.

## Cycle 43 restart-safe recovery remediation — integrated; full gates pending

- Database-operation authority теперь использует checksummed ACTIVE/RETAINED v3 и public absence-lease
  protocols с exact path/inode/bytes ownership, durable temp/link/sync publication и bounded retirement
  namespace. Routine release/retain/absence cycles не накапливают tombstones; ambiguous evidence ограничено
  `128` artifacts и fail-closed. Частично записанный retention marker живого владельца не может быть изменён:
  recovery принимает exact ACTIVE identity и согласованный `ownerPid`, затем требует доказанного завершения PID.
- Host-operation guard предоставляет настоящий held absence lease, restartable completion и durable transient
  reproof. App lifecycle recovery использует записанные exact container IDs и bounded settlement discovery;
  import/restore recovery завершают DB authority, удерживают exact DB absence lease до завершения host authority
  и только после этого снимают lease. Все четыре ingress проверяют exact absence protocol и canonical lock path;
  typed host/DB evidence должно совпадать семантически. Raw ручное удаление guard/marker из runbook исключено.
- Добавлены конкретные CLI `production:app:recover`, `production:import:recover` и
  `production:restore:recover`; candidate manifest содержит `77` уникальных Node-order entries, включая оба
  recovery helper и их тесты. Production-image/runbook contour после синхронизации identity fixtures и
  fail-fast recovery blocks прошёл `82/82`.
- Независимые focused re-review вернули `ZERO_FINDINGS`: host/lifecycle `60/60`; import
  `86 total / 85 pass / 0 fail / 1` PostgreSQL skip; restore `32/32` и shared contour `137/137`; финальный
  database marker `68/68`. Root повторно прошёл import `86 total / 85 pass / 0 fail / 1` skip и объединённый
  restore contour `102/102`. Retained test marker сохранён побайтно: `66` bytes, SHA-256
  `268BFC2EFA802558DF608249EF4DF32483C894E19CEF877C3FB7EA747D9734D6`.
- Первый стабильный full-unit run выявил только пять stale test/evidence contracts: compact progress wording,
  два Windows child PID-oracle race после корректного pre-user-code reap, Docker allowlist assertion и прежний
  `npm run` matcher уже root-managed import runbook. После focused RED→GREEN исправлений combined regression
  прошёл `33 total / 32 pass / 0 fail / 1` POSIX skip; повторный mandatory gate: `lint` green, `check` —
  `551` JavaScript и `165` inline handlers / `106` names, `npm test` —
  `2690 total / 2629 pass / 0 fail / 61` platform/environment skips.
- Это ещё не финальный release verdict. Новый exact freeze, два fresh whole-candidate `ZERO_FINDINGS` и
  единственный final wrapper остаются pending. Frontend/production build, browser E2E, real Docker/DB,
  network/provider/registry calls, deploy/staging/production mutation, stage и commit не выполнялись.

## Cycle 65 pre-freeze release gate — complete; exact audits pending

- Consent-bound PWA remediation закрыла owner-incarnation race для deferred `401 SESSION_REVOKED`, а service
  worker публикует activation marker только последним durable commit. Focused offline/PWA contour прошёл
  `88/88`; независимый re-review вернул `ZERO_FINDINGS`.
- Staging deadline request и ACK теперь публикуются как durable record + exact zero-byte `.ready` seal;
  live readers не принимают незапечатанный record, typed recovery различает paired/unpaired authority и
  сохраняет fail-closed baton cap. Deadline-control — `51 total / 50 pass / 0 fail / 1` Windows skip;
  expanded staging contour — `293 total / 276 pass / 0 fail / 17` platform skips; independent protocol review —
  `ZERO_FINDINGS`. Полный mock rehearsal deploy+rollback прошёл
  `85 total / 84 pass / 0 fail / 1` Windows symlink skip за `1 765 227 ms`.
- Два первых full-unit прогона обнаружили только test-host races под 16-worker нагрузкой: Windows Git Bash
  завершал read-only restore probe кодом `2816` (`SIGSEGV`), а искусственные одно-секундные build fixtures не
  успевали стартовать. Retry ограничен четырьмя попытками и одним shared 15-second deadline только для
  observational Bash reads; stage/launch/cancel/cleanup не переигрываются. Build remediation меняет только
  test budgets, атомарную test PID publication и bounded fixture cleanup. Независимые re-review обоих блоков —
  `ZERO_FINDINGS`; restore-supervisor `31/31`, production child lifecycle `31 total / 30 pass / 1` POSIX skip.
- Fresh mandatory gates: `lint` green; `check` — `562` JavaScript files и `165` inline handlers / `106` names;
  `git diff --check` green; final full `npm test` —
  `2994 total / 2924 pass / 0 fail / 70` platform/environment skips за `1 828 281.5092 ms`.
- Candidate inventory до metadata freeze: `83` tracked changes + `88` sorted unique explicit entries =
  `171/171` union files; `0` missing, `0` staged, `0` protected prototype/render paths и `0` release-owned
  untracked files вне manifest. Exact byte total и SHA-256 фиксируются после этого checkpoint.
- Retained database marker сохранён без изменений: `66` bytes, mtime
  `2026-08-30T07:22:43.2895701Z`, SHA-256
  `268BFC2EFA802558DF608249EF4DF32483C894E19CEF877C3FB7EA747D9734D6`.
  Windows stress diagnostics сохранили fail-closed `%TEMP%` evidence: всего `49` Job control directories,
  включая два исторических; `9` имеют exact `job-empty.proof`, `40` остаются unproven, плюс четыре fixture-root
  после Windows `EBUSY`. Generic controller не имеет безопасной typed rehydration procedure, поэтому ничего
  не удалялось вручную; эти temp artifacts не входят в candidate и не содержат project/database bytes.
- Это не финальный verdict: exact freeze, два независимых whole-candidate `ZERO_FINDINGS`, sole wrapper,
  current built artifact/E2E/performance/browser evidence и единственный локальный commit ещё pending.
  Docker/DB/provider/network, deploy, staging/production mutation, push и live VK не выполнялись.

## Cycle 65 first-freeze audit remediation — integrated; repeat gates pending

- Exact freeze `6a57a9e6f375e520074f2aaeb3cef86fe83968272c7e0f0ee846cff01be1371f`
  (`171` files / `8 968 932` bytes / staged `0`) был сохранён PRE=POST обоими независимыми аудитами.
  Product/UI audit вернул `ZERO_FINDINGS`; engineering audit отклонил freeze четырьмя finding.
- CI job budget увеличен с `30` до `120` минут: измеренный unit-run уже занимал `1 828 281.5092 ms`, а
  canonical wrapper, PostgreSQL и cross-browser gates выполняются сверх него. Staging workflow теперь явно
  устанавливает Node `22` до запуска archive/helper scripts. Новые workflow contracts — `2/2`, adjacent — `3/3`.
- Все production-import Docker children переведены на общий bounded lifecycle с durable local-child hold,
  опубликованным до spawn. При недоказанном `close` не запускается quiet inventory, DB/host guards не
  финализируются и recovery authority сохраняется. `test/import-json.test.js` —
  `62 total / 61 pass / 0 fail / 1` PostgreSQL-environment skip; ESLint/check зелёные.
- Windows Job recovery принимает exact typed authority из error после JSON round-trip и разрешает retirement
  только для canonical `control.json` + token-bound `job-empty.proof`. Publication, quarantine и cleanup
  используют identity-bound no-replace hard-link protocol; malformed/mismatched/unknown/late residues
  сохраняются fail-closed, restart поддерживает каждый промежуточный durable state. Lifecycle —
  `47 total / 46 pass / 0 fail / 1` POSIX skip; Windows focus `18/18`; release authority `11/11`;
  generic propagation `2/2`; последний независимый recovery review — `ZERO remaining findings`.
- Import local-child authority теперь сериализуется как fixed sanitized CLI envelope без command/env/secret,
  persists в host marker и переводит exact DB ACTIVE+hold в checksummed v4 RETAINED только после supervisor
  proof; затем переиспользует существующий remote recovery. Реальный Windows producer→codec round-trip закрывает
  namespace drift. Import recovery — `29/29`; database-operation lock — `75/75`; import —
  `62 total / 61 pass / 0 fail / 1` PostgreSQL skip; независимый stable review — `ZERO_FINDINGS`.
- Windows retirement content/proof pairs удаляются одним native helper под одним shared 30-second deadline.
  Открытые handles запрещают writers и проверяют exact birthtime, volume serial, file index, nlink, size и SHA;
  sealed manifest хранит ту же per-file identity для crash-resume. Checkpoint удаляет только sealed pending,
  proof остаётся replayable, а любой поздний unsealed pending сохраняется и блокирует success. Actual-native
  Windows focus — `28/28`; совместный root recovery contour —
  `306 total / 302 pass / 0 fail / 4` platform skips; re-review — `ZERO_FINDINGS`.
- Первый RED-прогон import сохранил ещё один unproven authority
  `%TEMP%\\easyboost-windows-job-863005438765d5e6275aa4ca35b604c9c97bd23cd5ccb8c0f50c96cb9a4e61f8`:
  `control.json` SHA-256 `A9A39EC73F660B05DFE5865FA401047DCE91AE62EF5A8CF90665DCCF8F5E8E98`,
  `term.request` `770395D8F9DE23BB1575C5C5C0423AAFADED86ACF96907C2BF1B298826BE592E`,
  `kill.request` `F279FB1F162DEC262DB41FECEAA86689DEDF6B20FD83382EED9655B0577C17E9`, proof отсутствует.
  Итоговый inventory: `50` Job directories, `9` proven, `41` unproven. В `%TEMP%` также сохранены `5` sealed
  retirement root-файлов в трёх authority-группах: `5a341a…` (proof+pending), `924c18…` (proof) и
  `ac9135…` (proof+pending). Они появились в diagnostic RED runs и не удалялись; retained DB marker (`66` bytes,
  SHA-256 `268BFC2EFA802558DF608249EF4DF32483C894E19CEF877C3FB7EA747D9734D6`) и четыре исторических fixture-root
  не изменялись.
- Первый freeze superseded и не является release authority. Repeat lint/check/diff/full gate, новый
  exact freeze, два fresh whole-candidate audits, sole wrapper и current browser evidence остаются pending.
  Docker/DB/provider/network, deploy, staging/production mutation, push, live VK и commit не выполнялись.

## Cycle 66 POSIX release maintenance remediation — integrated; new freeze pending

- Production-native Linux release children now require an explicit per-session controller created from one
  protocol-v2 maintenance scope. The outer Aisy E2E lane and nested predecessor lane use separate nonblocking
  fd8 `flock` authorities, exact checkout/control-root dev+ino allowlists and canonical owner-only lock bytes;
  ordinary targets never inherit the capability environment.
- POSIX retirement replays its exact reserved slot instead of deleting it and allocating a successor. Missing
  reservation evidence fails closed while the source exists; quiescent startup sweeps claimless and exact
  source-bound retirement slots. Staging revalidates lock bytes on every use and accepts the generic scope only
  for its exact allowlisted root. The launcher verifies canonical identity, size and SHA before and after flock.
- Focused GREEN: release supervisor `118 total / 116 pass / 0 fail / 2` Linux skips; production recovery
  `397 total / 393 pass / 0 fail / 4` skips; staging `71 total / 70 pass / 0 fail / 1` skip; PWA/frontend
  `35 total / 34 pass / 0 fail / 1` skip. Fresh mandatory gates: lint green; check `565` JavaScript files and
  `165` inline handlers / `106` names; `git diff --check` green; full `npm test` —
  `3125 total / 3050 pass / 0 fail / 75` platform/environment skips in `1 950 123.725 ms`.
- Candidate manifest is `92` sorted unique present entries. Together with `83` tracked changes it forms a
  `175`-file union; `0` release-owned untracked files are outside the manifest and protected prototype/render
  paths remain excluded. The retained database marker is unchanged: `66` bytes, mtime
  `2026-08-30T07:22:43.2895701Z`, SHA-256
  `268BFC2EFA802558DF608249EF4DF32483C894E19CEF877C3FB7EA747D9734D6`.
- Full tests added no deletions. Current `%TEMP%` evidence is `51` Job directories (`10` proven / `41`
  unproven) plus `191` root retirement files (`189` proof / `2` pending); these contain no candidate/database
  bytes and remain untouched because raw cleanup is not an authenticated recovery procedure.
- Ticket remains `in-progress`: new exact freeze, two fresh whole-candidate `ZERO_FINDINGS`, the sole
  `npm run test:release:aisy`, current built artifact/E2E/performance/browser evidence and one local commit are
  still pending. Docker/DB/provider/network, deploy, staging/production mutation, push and live VK were not run.

## Final release closeout — complete, 2026-09-02

- The Cycle 66 paragraph above is retained as historical pre-closeout evidence. The accepted reviewed source
  freeze is `379956516483fb5d734a90a5b0e29e1f94e4988d1400b9bdf2f0087f88f4ce9c`: `175` files,
  `9 545 896` bytes, `0` missing, `0` staged at review time, `0` protected paths and `0` release-owned
  untracked files outside the manifest. Fresh whole-candidate Product/UI and Engineering/Release audits passed
  `160/160` and `67/67` respectively.
- The sole final `npm run test:release:aisy` passed with exit code `0`: lint/check, `3130` unit/integration tests
  (`3055` pass / `0` fail / `75` skip), candidate and 345-commit history secret scans, one production build,
  digest verification, postbuild, `26` unique Chromium scenarios, performance budgets and final diff-check.
- Current artifact SHA-256 is
  `d518f4a54e7b03beb357a69f7dc6380cd31befc5a11634c1ddd0df216021e290`; the build contains `553`
  verified assets and `27` lazy chunks. First-load JavaScript is `90.0 KB` of the `150 KB` budget; LCP is
  `108 ms`, CLS `0.000`, INP `64 ms`, AI indicator `95 ms`, plan render `138 ms`, preview `38 ms`.
- A local browser proof at `390×844` and `1440×1000` measured one centered `390 px` portrait frame, zero
  horizontal overflow and no desktop side rail. The canonical 58 px / 28 px-radius coral CTA rendered at
  `350 px` wide on the phone viewport. Console error log was empty; the temporary server was stopped.
- Two final regressions were closed before the wrapper: the vocabulary modal now waits for a truthful available
  dictionary result using a local E2E fixture, and the Reading native dialog has complete forward/reverse Tab
  boundary containment. Targeted regressions and the final full contour are green.
- The retained database marker remains `66` bytes with mtime `2026-08-30T07:22:43.2895701Z` and SHA-256
  `268BFC2EFA802558DF608249EF4DF32483C894E19CEF877C3FB7EA747D9734D6`. No temp evidence was raw-deleted.
  Docker/DB/provider/network, deploy, staging/production mutation, push, secret handling and live VK were not run.

## Historical Cycle 8/10 evidence — superseded; not current release evidence

Ни одно значение в этом разделе не является current release evidence после изменений source в
Cycle 11/12. Запись сохранена только как неизменяемая история; новый artifact/SW/E2E/performance
authority появится лишь после единственного финального `npm run test:release:aisy`.

- Base: `d36724181ee04230c1a9709a9213bcd269092282`; candidate worker:
  `sha256-fc7996d1f54f6da75614e67f51a4e890ca603ef2f0aed498dbb1c3d86cfdfc71`.
- Production manifest: 553 digest-verified asset entries, 50 install-shell paths, 27 lazy chunks,
  prototype paths — 0. Exact d367 compatibility: 26 файлов / 2 123 783 байта / digest
  `299ee5c9cbeb03279dfdc072a8b6f34b5ba3f0a06b28a111a4df61e06258a6ca`; полная candidate artifact
  historical digest — `06afd702b65849cf80ec940edb3e1b6ebad6ab8fd6570429ae8a004ded08f601`.
- Historical Cycle 10 staging sequential: `77 total / 73 pass / 0 fail / 4` честных Windows/POSIX skip;
  focused production/security/archive/installer/runtime: `67 total / 62 pass / 0 fail / 5` таких skip;
  финальный unit: `2265 total / 2209 pass / 0 fail / 56 skip`. Первый concurrent full выявил одну
  ложную event-loop-sensitive stdin-inactivity остановку production build child; детерминированный RED
  закрепил slow-start + post-upload seam, один hard deadline стал единственной границей lifecycle,
  affected-контур прошёл `21 total / 20 pass / 0 fail / 1` POSIX skip, после чего full повторён зелёным.
  Cycle 8 uninterrupted built-dist Chromium aggregate остаётся `26/26` после одного candidate build;
  Cycle 10 не менял public runtime или artifact bytes и не запускал новую build/E2E.
- Performance: initial JS 91 087 байт (89,0 КБ) gzip-request transfer из 150 КБ;
  LCP 136 мс, CLS 0,000, INP 72 мс, AI 26 мс, plan 144 мс, preview 39 мс.
- `lint`, `check` (535 JS; 165 handlers / 106 names), candidate secret/context scan
  (1441 tracked + 60 explicit; 839 reachable Docker `COPY` inputs; 1501 unique reads; 553 built digests),
  historical artifact verification, history scan (345 commits), exact five-file Git Bash syntax и
  `git diff --check` зелёные.
- Exact predecessor E2E сверяет все 26 executable paths/length/SHA/raw bytes и подтверждает consent
  через production-visible d367 refresh → ordinary online reload → real keyboard Apply; подтверждает
  quorum, genuine old Speaking bytes, сохранение Writing draft, A-consent/B-close automatic activation,
  offline current-cache boot, Aisy-only retirement и foreign-cache sentinel. Exact lower/mixed/upper
  private roots, sibling boundaries, marker без URL/query/fragment и privacy → offline-root зелёные.
- `.dockerignore` исключает именованные `.env*`/`.scratch`/prototypes/QA/workspace категории; после
  unit и непосредственно перед sole build generic guard обходит каждый non-stage Docker `COPY` input,
  включая gitignored files, и отклоняет путь вне tracked + explicit inventory. Final image использует
  explicit runtime allowlist без `COPY . .`, включает documented `scripts/import-json.js` + local/config
  closure; frontend stage получает `shared` и полный build-input closure.
- Production image разрешено строить только `npm run production:image:build`: wrapper создаёт свежий
  deterministic USTAR stream из дважды no-follow/identity/digest проверенных и all-byte scanned Buffer.
  Docker не читает writable temp; raw Compose build закрыт отсутствующим sentinel. Spawn, stdin, post-upload
  work и exit ограничивает один hard deadline без отдельного чувствительного к event-loop inactivity timer;
  exact EOF/full-byte/close/reap и TERM→KILL остаются обязательными. Real workspace proof не вызывал Docker,
  а injected runner полностью потребил stream.
- Staging deploy/rollback принимают только full-SHA checksum-verified exact gzip archive и exact
  v4 helper-bundle SHA. Общий nonblocking `flock` удерживается от чтения active marker/store до checked recovery; canonical v4
  validator до Docker применяет name/type/protected и compressed/member/file/aggregate/disk/time bounds.
  Build предшествует tree/tag mutation, frozen archive повторно хешируется, а recovery принимает только
  проверенные image/tree/marker/running identity/readiness. Failure оставляет fail-closed marker; first
  deploy восстанавливает пустое bootstrappable state. Store — максимум 4 пары/1 GiB, без auto-prune.
  Docker использовал mock; genuine Linux two-process `flock` test на Windows штатно пропущен, не заявлен
  как локально исполненный. PostgreSQL rollback/downmigration helper не выполняет.
- Source-only EGE unit не строит/не читает candidate dist; single build проверяет derived final assets,
  post-build E2E — exact worker paths, waiting-cache/offline SHA. Persistent controlled Chromium
  возвращает zero installability errors. Heartbeat на 55-й секунде ставит последовательный bounded
  recheck после исходного 60-секундного цикла.
- Обязательный `npm run test:release:aisy`, перевод checklist/status в done и единственный commit
  намеренно не выполнялись: сначала нужны два независимых `ZERO_FINDINGS` по этому freeze.
- Push, merge, deploy, staging/production mutation, live VK/provider calls и secrets не выполнялись.
