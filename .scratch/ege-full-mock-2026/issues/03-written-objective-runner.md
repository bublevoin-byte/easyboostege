# 03 — Письменный runner заданий 1–36

Status: done
Blocked by: 01, 02
Spec: .scratch/ege-full-mock-2026/spec.md#пользовательский-сценарий

## Что сделать

Собрать единый written runner для аудирования 1–9, чтения 10–18 и грамматики/лексики 19–36 с общим строгим deadline 190 минут. До старта скачать и проверить exact assets; внутри попытки разрешить навигацию, autosave, reload/offline continuation и обзор пропусков, но запретить подсказки/баллы/ключи.

## Границы

- Входит browser state machine, asset preflight, strict timer/auto-submit, durable offline queue, exact server submit и objective result envelope.
- Переиспользуются deep section modules; копирование их UI-state машин не допускается.
- Не входит writing, speaking и финальный breakdown screen.

## Файлы

- `public/modules/`, `public/screens/`, `public/service-worker.js` — runner/PWA.
- `test/`, `e2e/` — browser/reload/offline/timer/property seams.

## Definition of Done

- [x] RED доказывает отсутствие общего strict runner до реализации.
- [x] Все 36 objective positions отвечаются и восстанавливаются exact.
- [x] Таймер не ставится на паузу reload/offline и автосдаёт с blanks.
- [x] Аудио полностью доступно после preflight; failed preflight не запускает timer.
- [x] Offline completion replay-safe и не создаёт двойной submit/result.
- [x] Mobile/desktop keyboard, 44 px, reduced motion и no-overflow seams зелёные.
- [x] Full gates, fresh double ZERO review и один локальный commit.

## Implementation evidence

- Публичный TDD начался с отсутствующего browser runner; отдельные RED зафиксировали failed preflight,
  offline reload, ambiguous start/save, CAS, строгий deadline, partial omissions, позиции 1–36,
  предупреждения 30/10/5/1, отказ durable storage и невалидную server timing authority. Первый focused
  GREEN был `16/16`. Fresh review-remediation начался с публичного import/service-worker RED
  `4 total / 1 pass / 3 fail`; отдельный browser RED воспроизвёл неработающий shared audio-play contract
  как timeout. Следующая fresh double review нашла преждевременный whole-written submit, неограниченный
  durable state и cache-first terminal restore: точный публичный RED был `24 total / 17 pass / 7 fail`,
  ещё два follow-up seam дали RED `0/2`. Следующая canonical double review проверила exact applied-draft
  acknowledgement, client-early deadline, offline cache loss и long-offline exact-attempt restore: adversarial
  RED был `33 total / 29 pass / 4 fail`. Следующая frozen-index проверка воспроизвела ещё два публичных
  RED для повторного early-deadline cancellation и failed online re-preflight; monotonic cancellation
  watermark и fail-closed `asset_blocked` закрыли их. Последний Standards adversarial набор дал RED
  `31/36` для overlapping checkpoint/CAS, active controlling SW, concurrent same-cache preflight и newer
  terminal cross-tab envelope. Финальный affected GREEN — `42/42` плюс dedicated Chromium.
  Следующая свежая полная ревизия нашла adversarial cross-tab/CAS/cache/policy/watermark/audio/authority/UI
  контуры; единый публичный RED был `42 total / 31 pass / 11 fail`. После глубокой ремедиации focused
  контур вырос до GREEN `52/52`, а dedicated Chromium дополнительно доказал немедленный omission/save-status
  refresh и owner invalidation при смене cookie между двумя вкладками.
- Один deep browser state machine владеет exact owner/form continuation, навигацией, semantic omissions,
  server deadline, per-answer monotonic cross-tab merge, durable UUID/CAS draft+submit queue и
  objective-only envelope. Ручное завершение 1–36 создаёт только подтверждённый сервером objective
  draft-checkpoint и не сдаёт будущие 37–38; whole-written closure возможен только через authoritative
  deadline reconciliation. Definitive deadline closure очищает superseded queue, принимает server truth
  и явно сообщает о непринятых offline changes вместо блокировки submit. Очередь держит максимум один
  ambiguous attempted и один свежий compacted draft, а monotonic watermark предотвращает resurrection
  без неограниченного tombstone-журнала. Listening/reading unique
  selection и bounded audio-play переиспользуют существующие section modules; null-selection нормализуется
  публичным contract, а два воспроизведения сохраняются через reload/offline. Ключи, подсказки и score не
  входят в snapshot или UI.
- Exact preflight до server start проверяет все `20` письменных MP3 по status/MIME/bytes/SHA-256 и хранит
  их только в exact form+fingerprint cache под digest-bound playback URL. Service worker открывает только
  запрошенный exact cache, не делает network/generic-cache fallback и обслуживает offline Range; VM-тест
  различает два revision-cache с одним путём, а Chromium проверяет реальный `206` после reload без сети.
  Terminal server/local envelope восстанавливается до проверки audio cache; активная running-попытка
  онлайн безопасно повторяет preflight без второго server start. Потеря exact cache офлайн переводит runner
  в durable не редактируемый `asset_blocked`, а reconnect сверяет именно `/attempts/{attemptId}`, поэтому
  принимает также authoritative `expired` после oral window; локальный terminal онлайн тоже revalidate exact.
  Draft event снимается только после точных `expectedRevision + 1` и objective answers, а преждевременный
  client deadline-marker отменяется, если exact server attempt ещё активен. Checkpoint intent переживает
  overlapping autosave conflict, а terminal tab атомарно принимает более новую server revision другого tab.
  Preflight требует controlling SW с exact capability handshake и Web Lock; concurrent same-form tabs
  переиспользуют один полностью проверенный cache вместо destructive repopulation.
- Все durable read/merge/write мутации сериализованы owner+generation+form Web Lock: stale prepared tab принимает
  уже активную попытку, одновременные ответы сходятся без last-write loss, а CAS rebase оставляет серверу
  authority над локально не изменёнными позициями. `asset_blocked` и его успешное снятие имеют монотонные
  watermarks. Strict authority принимает только `ege-mock-attempt-policy-v1`, ровно `190` минут и неизменную
  пару start/deadline; deadline watermark переживает rollback часов/reload и не допускает пустой
  `submit_queued`. Form module хранится в отдельном fingerprint-cache через SW и переживает смену shell.
  Audio использует общий атомарный lease на весь playback sequence, поэтому navigation/rerender/вторая вкладка
  не запускают параллельную запись и не занижают durable play count.
- UI немедленно обновляет count/review/omissions/save status без потери focus, перерисовывает terminal envelope
  независимо от async-пути смены phase и повторяет transient deadline reconciliation с bounded delay, не
  блокируясь видимым alert. Все owner-bound ошибки централизованно вызывают learning-authority invalidation;
  browser E2E меняет cookie между двумя вкладками и доказывает, что ответы прежнего владельца скрыты.
- Dedicated Chromium GREEN покрывает 320/1440 px, keyboard, reduced motion, controls `>=44px`, отсутствие
  overflow, preflight-before-start, server timer, autosave/CAS, offline answer+reload, reconnect, durable
  offline objective checkpoint/reload/replay, shared two-play audio contract и закрытый answer-free result
  envelope. Реальный HTTP seam проверяет authoritative auto-submit после offline deadline. Полный и
  adaptive E2E также зелёные.
- Последний полный unit: `1645 total / 1601 pass / 44` штатных PostgreSQL skip / `0 fail`; focused —
  `52/52`. Lint, check (`399` JavaScript files; `211` handlers / `126`
  names), frontend build (`483` assets, `683.1 КБ` shell JS, `10` lazy chunks), tracked secrets (`1173`
  files), history (`310` commits), fresh
  authorized production audit (`0 vulnerabilities`) и diff-check зелёные. Один параллельный full-unit
  gate поймал известный несвязанный Speaking timing transient `service_hung`; изолированный полный rerun
  прошёл `1645/1645` с `44` штатными skips. Server/repository/validation/
  migration не менялись, поэтому новый PostgreSQL/Docker прогон не требуется; provider/install/push/deploy
  не выполнялись. Код готов к canonical freeze и двум свежим review.
- Возобновлённый consolidated review был закреплён новым публичным RED `52 total / 43 pass / 9 fail`.
  GREEN `52/52` добавил финальную readiness-проверку под тем же durable start-lock, fail-closed pending
  start, exact policy/start/deadline validation, pinned server offset + monotonic deadline watermark,
  version-aware overlapping autosave ACK, emitted build path exact form-модуля, cache fallback при `503`,
  focus-safe same-phase/cross-tab projection, немедленную очистку old-owner DOM и удаление EGE local/cache
  namespace через общий account-deletion seam. Общий deletion/offline contract — `60/60`.
- Актуальный полный unit — `1654 total / 1610 pass / 44` штатных PostgreSQL skip / `0 fail`; lint и
  check (`399` JavaScript files; `211` handlers / `126` names), frontend build (`483` assets,
  `688.1 КБ` shell JS, `10` lazy chunks), dedicated/full/adaptive Chromium, tracked secrets (`1173`
  files), history (`310` commits) и оба diff-check зелёные. Built manifest указывает на существующий
  `assets/ege-mock-form-1-v1-*.js`, и built service worker содержит ровно этот path. Ранее полученный
  fresh authorized audit `0 vulnerabilities` применим: manifests с тех пор не менялись. Изменений
  server/repository/validation/migration по-прежнему нет, поэтому новый PostgreSQL/Docker прогон не нужен;
  provider/install/push/deploy не выполнялись. Дерево готово к новой canonical freeze и двум review.
- Финальный performance/timer review-remediation начался с публичного RED: опережающие клиентские часы
  сокращали 190 минут, HTTP boundary не передавала server time, EGE ошибочно считался пятым eager-screen,
  а `writerId` не имел потребителя. GREEN использует подписанный offset по стандартному HTTP `Date`, затем
  monotonic elapsed/watermark offline; server sample остаётся non-enumerable transport metadata. EGE screen,
  runner и asset-preflight переведены в существующий lazy loader, а маленький continuation contract оставлен
  в shell только для exact owner/form offline discovery. Focused+security контур — `140/140`; полный unit —
  `1655 total / 1611 pass / 44` штатных PostgreSQL skip / `0 fail`; lint/check (`400` JavaScript files,
  `211` handlers / `126` names), build (`484` assets, `641.6 КБ` shell JS, `11` lazy chunks), dedicated/
  full/adaptive Chromium, secrets (`1173`) и history (`310`) зелёные. Performance first-load реально показал
  ровно четыре eager screen и отсутствие EGE при старте. Общий historical budget/harness debt воспроизводится
  без Ticket 03 на чистом `fc14cddd`: `178.8 КБ > 150 КБ` и тот же `EXPECTED_OWNER_REQUIRED`; текущий —
  `180.6 КБ`, бюджет не повышался и несвязанный harness/server не менялись. Fresh audit `0 vulnerabilities`
  применим, manifests неизменны. Server/repository/validation/migration не затрагивались; Docker/PostgreSQL,
  provider/install/push/deploy не выполнялись. Дерево готово к canonical freeze и двум свежим review.
- Последний frozen review выявил пять публичных navigation/authority seam: forward wall-clock jump после
  server anchor, позднее owner-deletion notification за CacheStorage purge, глобальный radio refresh,
  необработанный exact-form import failure и Back без route leave-hook. Они были зафиксированы общим RED
  `112 total / 108 pass / 4 fail` и закрыты GREEN `112/112`: живой timer использует только server anchor +
  monotonic elapsed, tombstone немедленно отзывает authority и уведомляет вкладки до best-effort purge,
  live projection ограничен EGE root, import failure показывает fail-closed retry без старта таймера, а
  общий Back запускает стандартные route hooks и останавливает скрытый EGE timer. Dedicated Chromium
  отдельно воспроизводит failed exact chunk → retry и проверяет collapse frame при Back. Финальный полный
  unit — `1657 total / 1613 pass / 44` штатных PostgreSQL skip / `0 fail`; lint/check (`400` JavaScript
  files, `211` handlers / `126` names), build (`484` assets, `641.6 КБ`, `11` lazy chunks), dedicated/full/
  adaptive Chromium, secrets (`1174`), history (`310`) и diff-check зелёные. Performance вновь подтвердил
  четыре eager screen без EGE; текущие `180.3 КБ > 150 КБ` и `EXPECTED_OWNER_REQUIRED` остаются теми же
  воспроизведёнными на base historical debt. Audit `0 vulnerabilities` применим, manifests после него не
  менялись. Server/repository/validation/migration не затрагивались; Docker/PostgreSQL/provider/install/
  push/deploy и Ticket 04 не выполнялись. Дерево готово к новой canonical freeze и fresh ZERO×2 review.
- Следующий fresh double review нашёл ещё две границы: activation новой service-worker версии удаляла
  runtime-кэш ленивого runner, а missing exact attempt/другая server `ownerGeneration` могла оставить на
  экране ответы старой инкарнации аккаунта. Публичный RED был `57 total / 53 pass / 4 fail`; GREEN `57/57`
  добавил отдельный versioned executable-cache. При обновлении он загружает новую хешированную ревизию
  runner до `skipWaiting` только если прежний EGE-экран уже открывался, поэтому чистая первая загрузка
  по-прежнему содержит ровно четыре eager screen. VM-регрессия исполняет install → activate → offline fetch.
  Клиент теперь требует, сохраняет и сверяет неизменную server `ownerGeneration` попытки; `404`, mismatch и
  legacy local envelope без этой identity немедленно удаляют exact local state, очищают private DOM и дают
  безопасный retry. Финальный полный unit — `1660 total / 1616 pass / 44` штатных PostgreSQL skip / `0 fail`;
  lint/check (`400` JS, `211` handlers / `126` names), build (`484` assets, `641.6 КБ`, `11` lazy chunks),
  dedicated/full/adaptive Chromium, secrets (`1174`), history (`310`) и diff-check зелёные. Performance
  подтверждает четыре eager screen без EGE; `180.5 КБ > 150 КБ` и `EXPECTED_OWNER_REQUIRED` остаются
  воспроизведённым на чистом base historical debt. Audit `0 vulnerabilities` применим, manifests не
  менялись. Server/repository/validation/migration не затрагивались; Docker/PostgreSQL/provider/install/
  push/deploy и Ticket 04 не выполнялись. Дерево готово к следующей canonical freeze и fresh ZERO×2.
- Последний pre-freeze review дал четыре точных публичных RED (`56/60`) для activation late-open race,
  retryable restore `503` с потерянным exact cache, пустого браузера при уже активной server attempt и
  owner-switch ABA во время lazy import/restore. GREEN `60/60` повторно проверяет runtime cache перед
  activation cleanup, всегда пропускает активный restore через exact readiness/fail-closed `asset_blocked`,
  сначала принимает authoritative `current` с exact owner generation/policy/190-minute timing и привязывает
  каждую async UI completion к immutable owner+epoch до любого commit/render/invalidation. Dedicated E2E
  подтверждает adoption текущей попытки новой вкладкой. Полный unit — `1663 total / 1619 pass / 44`
  штатных PostgreSQL skip / `0 fail`; lint/check (`400` JS, `211` handlers / `126` names), build (`484`
  assets, `641.6 КБ`, `11` lazy chunks), dedicated/full/adaptive Chromium, secrets (`1174`), history
  (`310`), diff-check и fresh authorized audit (`0 vulnerabilities`) зелёные. Performance по-прежнему
  держит четыре eager screen без EGE; `180.5 КБ > 150 КБ` и `EXPECTED_OWNER_REQUIRED` воспроизведены на
  изолированном base `fc14cddd` как прежний debt (`178.8 КБ > 150 КБ`). Server/repository/validation/
  migration не менялись; Docker/PostgreSQL/provider/install/push/deploy и Ticket 04 не выполнялись.
  Дерево готово к canonical freeze и fresh ZERO×2.
- Финальная authority/activation remediation закрыла status-less integrity retry, post-await deletion
  resurrection и оставшийся activation-open TOCTOU. Retry разрешён только для явного network/status-0,
  `429` и finite `>=500`; остальные malformed/owner ошибки fail-closed. Каждый durable EGE commit проходит
  через form-lock и общий durable owner-incarnation lock, заново проверяя текущий runner/owner, поэтому
  tombstone+purge не может быть отменён поздним restore или autosave; отдельные executable regressions
  покрывают обе гонки. Stable `easyboost-ege-mock-open-v1` marker фиксирует открытие, а новый worker при
  наличии active predecessor preloads exact emitted runner revision ещё на install, закрывая open прямо
  внутри activation cleanup и сохраняя чистую первую установку lazy. Review RED был `54/56`, финальный
  focused — `64/64`; полный unit — `1667 total / 1623 pass / 44` штатных PostgreSQL skip / `0 fail`.
  Lint/check (`400` JS, `211` handlers / `126` names), build (`484` assets, `642.4 КБ`, `11` lazy chunks),
  dedicated/full/adaptive Chromium, secrets (`1174`), history (`310`) и diff-check зелёные; свежий audit
  остаётся `0 vulnerabilities`, manifests не менялись. Performance сохраняет четыре eager screen без EGE;
  известные `180.5 КБ > 150 КБ` и `EXPECTED_OWNER_REQUIRED` относятся к воспроизведённому base debt.
  Server/repository/validation/migration не менялись; Docker/PostgreSQL/provider/install/push/deploy и
  Ticket 04 не выполнялись. Дерево готово к новой canonical freeze и fresh ZERO×2.
- Последняя публичная review-remediation закрыла три оставшиеся границы: неизвестный server `current`
  больше не оставляет пустой runner интерактивным, definitive invalidation атомарно публикует отдельный
  owner/form-locked watermark для всех вкладок, а service worker отличает настоящий update от clean
  activation по immutable predecessor bit и не повторяет уже полный executable preload без сети. Marker
  входит в account-deletion purge; storage event немедленно скрывает устаревшую вкладку, а любой её
  следующий durable commit или `refreshLocal` отклоняется до записи. Публичный RED был `61/66`, GREEN —
  `66/66`; отдельный Chromium доказывает `503 current` → noninteractive retry без кнопки старта и успешное
  восстановление после ответа сервера. Финальный полный unit — `1669 total / 1625 pass / 44` штатных
  PostgreSQL skip / `0 fail`; lint/check (`400` JS, `211` handlers / `126` names), build (`484` assets,
  `642.8 КБ`, `11` lazy chunks), dedicated/full/adaptive Chromium, secrets (`1174`), history (`310`) и
  diff-check зелёные. Performance сохраняет четыре eager screen без EGE: LCP `312 ms`, CLS `0`, INP
  `96 ms`; прежние `180.6 КБ > 150 КБ` и `EXPECTED_OWNER_REQUIRED` остаются воспроизведённым на base debt.
  Свежий authorized audit остаётся применимым (`0 vulnerabilities`), manifests не менялись. Server/
  repository/schema/migration не менялись; Docker/PostgreSQL/provider/install/push/deploy и Ticket 04
  не выполнялись. Дерево готово к новой canonical freeze и fresh ZERO×2.
- Следующий review-pass закрыл success-only invalidation и lifecycle teardown service worker. Delayed
  invalidator теперь под обоими locks сверяет captured watermark до удаления и не может стереть уже
  созданную replacement-попытку. Quota-safe порядок сначала освобождает большой envelope, затем пишет
  маленький tombstone; если marker/lock недоступен, exact envelope восстанавливается, а UI показывает
  только fail-closed unavailable retry, не сообщение об успешном discard. Clean/update install mode
  хранится в per-shell CacheStorage и переживает уничтожение worker global между install/activate.
  Публичный RED `63/67` закрыт GREEN `67/67`; полный unit — `1670 total / 1626 pass / 44` штатных
  PostgreSQL skip / `0 fail`. Lint/check (`400` JS, `211` handlers / `126` names), build (`484` assets,
  `642.8 КБ`, `11` lazy chunks), dedicated/full и standalone adaptive Chromium, secrets (`1174`), history
  (`310`) и diff-check зелёные. Один параллельный adaptive запуск поймал прежний timing timeout скрытого
  `#home_adaptive_plan`; немедленный standalone rerun прошёл и не касается Ticket 03. Performance сохранил
  четыре eager screen без EGE: LCP `308 ms`, CLS `0`, INP `96 ms`; `180.6 КБ > 150 КБ` и
  `EXPECTED_OWNER_REQUIRED` остаются подтверждённым base debt. Audit `0 vulnerabilities` применим,
  manifests неизменны. Server/repository/schema/migration не менялись; Docker/PostgreSQL/provider/install/
  push/deploy и Ticket 04 не выполнялись. Дерево готово к новой canonical freeze и fresh ZERO×2.
- Последний двойной review одной frozen identity независимо нашёл одну install-time гонку в обе стороны:
  сохранённый `clean` мог заставить update пропустить executable preload, а сохранённый `update` — заставить
  clean reinstall загрузить lazy EGE code. Service-worker RED был `8/10`; GREEN `11/11` дополнительно
  доказывает, что запоздалая запись более старого worker не заменяет более новую durable decision. Follow-up
  review запретил wall-clock revision: exact equal-timestamp/rollback RED `10/11` закрыт тем же GREEN `11/11`.
  Install теперь под origin-wide lock атомарно выделяет монотонное поколение mode в per-shell CacheStorage,
  ждёт его durable write и только затем использует captured predecessor bit для preservation; activation
  после teardown выбирает единственное последнее поколение и fail-closed отклоняет неоднозначность.
  Следующий Spec review нашёл stable-path source-mode cache: RED `11/12` доказал offline возврат старого
  runner после update; follow-up тем же RED доказал stale cache после clean re-registration с retained-open
  evidence. GREEN `12/12` заставляет любой install, которому действительно нужен preservation, атомарно
  refresh все executable paths, даже когда cache выглядит полным; genuine clean/no-open install выходит до
  fetch и остаётся lazy, а activation — строго cache-only. Общий focused runner/SW/UI
  контур — `71/71`; полный unit — `1674 total / 1630 pass / 44` штатных
  PostgreSQL skip / `0 fail`. Lint/check (`400` JS, `211` handlers / `126` names), build (`484` assets,
  `642.8 КБ`, `11` lazy chunks), dedicated/full/adaptive Chromium, secrets (`1174`), history (`310`) и
  diff-check зелёные. Первый full E2E rerun поймал timing-flake неизменённого Speaking task 3 TTS; точный
  Speaking rerun и следующий полный последовательный rerun зелёные. Performance снова подтверждает четыре
  eager screen без EGE: LCP `284 ms`, CLS `0`, INP `88 ms`; прежние `180.6 КБ > 150 КБ` и
  `EXPECTED_OWNER_REQUIRED` остаются воспроизведённым base debt.
  Authorized audit `0 vulnerabilities` применим, manifests неизменны. Server/repository/schema/migration
  не менялись; Docker/PostgreSQL/provider/install/push/deploy и Ticket 04 не выполнялись. Дерево готово к
  новой canonical freeze и fresh ZERO×2.
- Финальные независимые Standards и Spec review вернули буквальный `ZERO_FINDINGS` на одной frozen identity
  `b472186eaf1d0d206f97d50b56c5c6d2f2bb0cb3` при неизменном base/HEAD
  `fc14cddd2036d7d4fd17f01f44b141fb40202305`. После review меняются только status/evidence metadata;
  Ticket 03 завершён, Ticket 04 не начат.
