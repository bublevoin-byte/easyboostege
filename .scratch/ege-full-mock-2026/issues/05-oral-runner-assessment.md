# 05 — Устная часть 1–4

Status: done
Blocked by: 01, 02
Spec: .scratch/ege-full-mock-2026/spec.md#пользовательский-сценарий

## Что сделать

Интегрировать existing full Speaking flow как oral part одной попытки: mic/assets preflight до старта, отдельный строгий 17-минутный deadline, official preparation/recording stages, exact form binding, reload/recovery, replay-safe submit и предварительная evaluation. Пауза разрешена только между written submit и oral start.

## Границы

- Входит oral readiness, task 1–4 stage machine, owner-bound recordings/evaluation, technical failure states и part completion.
- Не входит генерация speaking prompts, изменение существующей pronunciation mastery и ручная экспертиза.
- Агент не запускает реальные provider/платные вызовы.

## Файлы

- `public/screens/speaking.js`, speaking modules — reusable deep seam/orchestration.
- `routes/`, `services/`, `validation/` — attempt/form/deadline binding.
- `test/`, `e2e/`, `docs/openapi.yaml` — timer/mic/replay/privacy parity.

## Definition of Done

- [x] RED фиксирует отсутствие exact attempt/oral deadline binding.
- [x] Timer запускается только после preflight и не ставится на паузу.
- [x] Каждая запись принадлежит exact owner/attempt/form/task/stage.
- [x] Reload/technical failure не создают вторую запись или evaluation.
- [x] Preliminary labels и provider-failure pending state честны.
- [x] Full gates, live PostgreSQL при server delta, fresh double ZERO и один commit.

## Evidence

- Public-seam TDD закрепил отдельный server-authoritative `17`-минутный oral deadline и официальный stage cursor
  заданий `39–42`: `1 + 4 + 5 + 1 = 11` записей. Подготовку и запись нельзя закончить досрочно или обойти через
  submit; запись запускается и останавливается автоматически на серверных границах. Exact replay использует
  неизменяемые idempotency/CAS bindings owner/attempt/form/task/response, а автоматическое истечение всего oral
  deadline запускает тот же replay-safe speaking bridge.
- Mic и immutable task-42 PNG проходят preflight до старта: браузер проверяет MIME, SHA-256 и декодирование exact
  manifest asset. WAV хранится только локально в owner-generation-bound IndexedDB, переживает разрешённый reload и
  удаляется вместе с exact account incarnation; legacy ownerless WAV удаляется fail-closed. Candidate submit содержит
  только `expectedRevision`: авторитетные `11` recording bindings берутся из server stage ledger.
- Задания `39–42` переиспользуют существующий full Speaking session, pronunciation и semantic-evaluation seams через
  `selection_reason = ege_mock`; raw audio не сохраняется в EGE attempt. Effective pronunciation locale честно
  фиксируется как `en-GB`, не подменяя отсутствующий calibration profile. Safe GET не создаёт claim/provider work;
  provider processing начинается только отдельным явным действием после submit. Неоднозначный возможный платный
  повтор требует отдельного acknowledgement, но `AI_NOT_CONFIGURED` без provider call восстанавливается без ложного
  предупреждения. Terminal settlement имеет canonical fingerprint и mutation-free replay.
- Public result и OpenAPI фиксируют exact позиции/максимумы `39 → 1`, `40 → 4`, `41 → 5`, `42 → 10`, canonical
  `experimental` / `approximate` warning и `null` для отсутствующего evidence вместо выдуманного нуля. Speaking-first
  и writing-first settlement сходятся в одном composite state; EGE attempt всегда assisted и не даёт mastery credit.
- Первый независимый frozen review нашёл восемь уникальных seams: ранние/поздние stage controls, submit bypass,
  automatic speaking start, settlement replay/order, account WAV privacy, accent mismatch, ambiguous paid retry,
  asset byte verification и exact OpenAPI caps. Они закрыты отдельными RED→GREEN циклами; дополнительный UI RED
  запретил отправлять устаревшее `recordings: {}` через реальный screen transport.
- Второй независимый frozen review нашёл десять новых seams: authoritative server clock, GET-reconcile bridge,
  final-stage overwrite/cross-tab identity, technical/skipped assessment evidence, asset TOCTOU, PostgreSQL lock
  inversion, paid-result settlement fall-through, invented EGE zero/`automatic_training`, oral a11y и duplicated oral
  contract. Public REDы закрыли каждый seam до production: deterministic UUID теперь exact replay-safe UUIDv4;
  final task может завершиться ровно на общем oral deadline; один immutable contract владеет `17` минутами,
  позициями, стадиями и максимумами; verified object URL декодирует и показывает те же bytes; успешный provider result
  с не подтверждённым durable settlement возвращает `SPEAKING_EVALUATION_SETTLEMENT_UNKNOWN`, сохраняет claim и не
  вызывает следующего провайдера. Focused remediated contour прошёл `83/83`, runner `11/11`, media/UI `13/13` и
  service-worker closure `12/12`.
- Третий review-remediation цикл закрыл девять оставшихся seams: разные UUID для ready/preparation advance, полную
  очистку stale offline journal после terminal reconcile, восстановление записи после reload, использование
  repository-owned PostgreSQL clock, exact result projection, ordered multi-command offline queue, canonical
  `11`-recording deadline evidence, acknowledgement для неоднозначного `AI_RESPONSE_INVALID` и exact-cache task-42
  PNG. Дополнительный браузерный RED обнаружил ложный `navigator.onLine` при offline reload: явный
  `NETWORK_ERROR` теперь сохраняет локальную queued projection без observational GET и без потери команды, тогда как
  authoritative conflict по-прежнему проходит reconciliation. Ошибка oral reopen больше не стирается молча.
- Четвёртый независимый review обнаружил четыре сквозные границы: кандидат мог прислать прошлый `observedAt`,
  локальный oral envelope не был обязан принадлежать exact attempt, final offline response не мог восстановить
  `ready_to_submit` вместе с последующим submit, а OpenAPI описывал EGE result как ordinary `automatic_training` и
  не знал canonical EGE technical codes. Public RED был `47 total / 41 pass / 6 intended fail`; после production
  сервер принимает stage-time только из repository clock, браузер привязывает/очищает cache по exact attempt,
  durable journal сохраняет и по порядку переигрывает final stage + submit, а executable OAS различает
  `automatic_training` и EGE `experimental` с `needs_retry`/`null`. Focused GREEN — `47/47`, `0 fail`.
- Пятый независимый frozen review нашёл девять новых границ: PostgreSQL терял EGE assistance provenance; legacy
  full Speaking endpoints могли обойти авторитетный oral ledger; stale cross-tab capture мог привязаться к другому
  ответу; runtime/OpenAPI расходились по technical codes; offline multi-stage replay падал на реальном server time;
  перевод wall clock вперёд создавал преждевременный submit; локальный journal был last-write-wins без rollback;
  speaking обещал несуществующий retry; subscription могла истечь между route-check и settlement. Public REDы были
  server/contracts `29 total / 24 pass / 5 fail`, runner `20/17/3`, media/UI `17/15/2`, post-submit provider claim
  `21/20/1` и PostgreSQL lock-order `3/2/1`. GREEN добавил exact technical-code owner, assisted provenance,
  owner→EGE→Speaking locks и subscription recheck, legacy lifecycle guard, post-submit-only provider claim,
  terminal `retryAllowed:false`, Web Locks/local revision/merge/atomic rollback, monotonic timer, ordered TOO_EARLY
  replay и cancel→restore→restart recorder binding. Full E2E затем поймал отдельную late written-refresh race,
  переписывавшую oral timer; RED `11/10/1`, GREEN oral/UI `31/31`, direct oral E2E дважды и fresh full Chromium.
- Shared file/PostgreSQL contracts покрывают stage CAS/replay/conflict, owner isolation, bridge sync, durable claim,
  result/export/delete/retention parity. После последней remediation fresh disposable project
  `easyboost-postgres-integration-30492` применил миграции `001–055` и прошёл `48/48`, `0 fail`, `12771.6974 ms`.
  Container/volume/network удалены; exact project-label filters для успешного проекта пусты. Docker остановлен и
  pipe отсутствует.
- Pre-documentation gates: full unit `1800 total / 1752 pass / 48` expected PostgreSQL skips / `0 fail` in
  `33857.6453 ms`; lint; executable/generated OpenAPI; check (`422` JS / `211`
  handlers / `126` names); build (`485` assets / `645.6 KB` shell JS / `12` lazy chunks); dedicated EGE, full и
  adaptive Chromium; secrets (`1193` tracked files), history (`312` commits), diff-check и fresh authorized production
  audit (`0 vulnerabilities`) зелёные. Performance operational metrics проходят: LCP `312 ms`, CLS `0`, INP `96 ms`,
  AI loading `38 ms`, adaptive overview `89 ms`, preview `33 ms`; единственный exit-1 — документированный baseline
  first-load budget `181.5 KB > 150 KB` (Ticket 04: `180.7 KB`), при этом EGE остаётся lazy.
- Реальных provider/платных вызовов, install, push, deploy и Ticket 06 не было. Локальный FIPI-контекст не является
  runtime/test/commit dependency. Ticket 99 остаётся обязательным напоминанием существенно расширить проверенный
  авторский банк.
- Final fifth-remediation pre-documentation rerun: full unit `1808 total / 1760 pass / 48` expected PostgreSQL skips /
  `0 fail` in `31976.457 ms`; lint, executable/generated OpenAPI, check (`422` JS / `211` handlers / `126` names), build
  (`485` assets / `645.6 KB` shell JS / `12` lazy chunks), fresh full and adaptive Chromium, secrets `1193`, history
  `312` and diff-check are green. Performance is LCP `300 ms`, CLS `0`, INP `96 ms`, AI loading `40 ms`, adaptive
  overview `89 ms`, preview `32 ms`; only the inherited first-load baseline remains `181.5 KB > 150 KB`. Fresh live
  PostgreSQL `48/48`, empty cleanup filters and authorized production audit `0 vulnerabilities` remain exact. Docker
  is stopped with its pipe absent.
- Final post-documentation runner audit caught one same-cursor cross-tab journal churn: exact UI RED `0/1` now
  cancels capture only before a known remote cursor adoption, or immediately after an otherwise discovered
  authoritative projection change. Same-cursor timer writes preserve the live recorder. GREEN is `1/1`; full unit
  is `1808/1808` with `48` expected PostgreSQL skips, and dedicated EGE, full and adaptive Chromium are green.
  Performance operational metrics remain within budget at LCP `372 ms`, CLS `0`, INP `112 ms`, AI `45 ms`, overview
  `107 ms` and preview `41 ms`; only inherited first-load `181.5 KB > 150 KB` remains.
- Sixth frozen review found seven final seams: cross-tab observational GET/write feedback, competing microphone
  capture, offline navigation resetting the monotonic epoch, missing EGE `methodicallyValidated:false`, a per-second
  live-region announcement, task-42's verified composite constrained to half a mobile grid, and incomplete oral
  browser acceptance. Public RED was runner/media/UI `42 total / 37 pass / 5 intended fail` plus executable
  assessment-contract `0/1`; GREEN is `42/42`, `1/1`, and combined focused `65/65`. Observing tabs now adopt through
  a non-writing local refresh and never own the microphone; one held owner/attempt Web Lock transfers capture only
  after release. Cross-navigation `performance.timeOrigin + performance.now()` advances the inherited server sample
  while closed/offline without trusting wall-clock correction. The canonical speaking warning includes
  `methodicallyValidated:false`, stage seconds are outside a live region, and the verified task-42 composite spans the
  full grid.
- Expanded Chromium completes all exact `11` responses across tasks `39–42`, including offline reload/reconnect,
  one cross-tab recorder owner and bounded GET traffic, 320/1440 layouts, reduced motion, keyboard, no overflow,
  44 px controls, submit and the explicit approximate-assessment boundary. Safe restore/GET/reconnect produce zero
  uploads/evaluations; only the explicit action uploads exactly `11` local WAVs and evaluates the four tasks. Latest
  full unit is `1813 total / 1765 pass / 48` expected PostgreSQL skips / `0 fail` in `37472.5589 ms`; lint, executable
  OpenAPI, check (`422` JS / `211` handlers / `126` names), build (`485` assets / `645.6 KB` shell JS / `12` lazy
  chunks), dedicated EGE/full/adaptive Chromium, secrets `1193`, history `312` and diff-check are green. Performance
  passes LCP `300 ms`, CLS `0`, INP `96 ms`, AI `42 ms`, overview `95 ms` and preview `34 ms`; only inherited
  first-load `181.6 KB > 150 KB` remains. This remediation changed no persistence, so fresh PostgreSQL migrations
  `001–055`, `48/48` and cleanup-empty evidence remain exact; Docker is stopped. Authorized audit remains `0` with
  unchanged manifests. No provider/paid call, install, push, deploy or Ticket 06 occurred; Ticket 99 remains intact.
- Final fourth-review remediation closed six independent release boundaries. Exact RED was oral/domain/UI
  `47 total / 43 pass / 4 intended fail`, malformed-EGE paid-call `0/1`, and executable oral-recording OAS `0/1`.
  A reopened prepared attempt now requires fresh mic/asset readiness; every asynchronous oral open is bound to its
  route epoch, owner, written runner and attempt and cancels a late recorder; owner deletion between IndexedDB put
  and local journal commit removes the exact WAV and cannot resurrect the journal. Server reads reconcile missed
  preparation and response boundaries into one deterministic `response_timeout` after the shared five-second grace,
  while an exact stage command inside the grace keeps mutation priority. Malformed EGE provider JSON performs one
  physical call and never an automatic paid format repair. OpenAPI now encodes exact position↔task↔response caps and
  completed/technical/skipped digest, duration and technical-code invariants. Focused file contour is `102/102`.
- Fresh non-PostgreSQL gates after that remediation: full unit `1818 total / 1770 pass / 48` expected PostgreSQL
  skips / `0 fail` in `34721.7847 ms`; lint; executable/generated OpenAPI; check (`422` JS / `211` handlers / `126`
  names); build (`485` assets / `645.6 KB` shell JS / `12` lazy chunks); dedicated EGE, full and adaptive Chromium;
  secrets `1193`; history `312`; and diff-check. Performance passes LCP `312 ms`, CLS `0`, INP `96 ms`, AI `39 ms`,
  overview `101 ms` and preview `37 ms`; only inherited first-load `181.6 KB > 150 KB` remains.
- The new shared real-clock repository assertion first produced live PostgreSQL RED `47/48`: PG named-attempt GET
  ignored its contract clock and left position 39 stale. PostgreSQL GET now shares the file clock seam for tests while
  production keeps its post-owner-lock database clock. A fresh disposable project
  `easyboost-postgres-integration-32420` applied migrations `001–055` and passed literal `48/48`, `0 fail`,
  `13414.0556 ms`; Compose removed its container/volume/network. Exact project-label filters are empty for the denied
  pre-escalation name `25548`, RED project `34240` and GREEN project `32420`. Docker is stopped with pipe absent.
- Post-documentation verification preserves full unit `1818 total / 1770 pass / 48` expected PostgreSQL skips /
  `0 fail` in `34683.5678 ms`; lint, executable/generated OpenAPI, check (`422` JS / `211` handlers / `126` names),
  build (`485` assets / `645.6 KB` shell JS / `12` lazy chunks), secrets `1193`, history `312`, diff-check, fresh full
  and adaptive Chromium are green. Performance operational metrics remain inside budget at LCP `332 ms`, CLS `0`,
  INP `104 ms`, AI `48 ms`, overview `99 ms` and preview `38 ms`; only the inherited first-load `181.6 KB > 150
  KB` baseline remains. Fresh live PostgreSQL `001–055`, `48/48` and cleanup-empty evidence remains exact.
- The fifth-final review remediation closed claim-time authorization, immutable pin/replay and exact-contract gaps.
  A provider-bound EGE pronunciation or semantic claim now rechecks the current Base subscription and the current
  version-bound voice consent inside the same owner serialization that creates or recovers paid work; an already
  frozen non-paying replay remains recoverable. The reusable Speaking projection keeps the accent locale/revision/
  effective-time pinned by its first EGE bridge sync even if the learner changes profile later. An immutable stage
  replay adopts a fresh authoritative attempt instead of regressing the oral cursor, and removes its local WAV only
  when the current server ledger no longer binds that exact recording. OpenAPI now describes the exact eleven-state
  cursor/ledger machine instead of accepting impossible position/response/duration combinations.
- Exact grouped RED was full unit `1822 total / 1768 pass / 48` expected PostgreSQL skips / `6 fail`: impossible OAS
  task-39 input, file and bridge accent drift, immutable replay regression, superseded WAV retention and a consent
  revocation race all failed before production. A second executable OAS RED proved that a nonterminal cursor still
  accepted a future ledger key. Focused GREEN is `6/6`; expanded oral/EGE/Speaking/HTTP is `106/106`; full unit is
  `1822 total / 1774 pass / 48` expected PostgreSQL skips / `0 fail` in `34746.758 ms`. Lint, generated/executable
  OpenAPI, check (`422` JS), build (`485` assets / `12` lazy chunks), lock/offline tests `66/66`, dedicated EGE, full
  and adaptive Chromium, secrets `1193`, history `312` and diff-check are green. Performance passes LCP `316 ms`,
  CLS `0`, INP `104 ms`, AI `54 ms`, overview `100 ms` and preview `36 ms`; only the inherited initial-JS baseline
  remains `181.5 KB > 150 KB`.
- The default-sandbox disposable PostgreSQL project `easyboost-postgres-integration-9360` was denied access to the
  Docker pipe/config before tests and left only its isolated volume; exact scoped Compose cleanup later removed that
  volume. Fresh authorized project `easyboost-postgres-integration-30608` applied migrations `001–055` and passed
  literal `48/48`, `0 fail`, in `13638.3602 ms`, including authorization-race and accent-pin parity. Its automatic
  cleanup completed, and exact project-label filters for containers, volumes and networks are empty for both project
  identities. Docker is stopped with pipe absent. No provider/paid call, install, push, deploy or Ticket 06 occurred;
  unchanged manifests preserve the authorized audit at `0 vulnerabilities`, and Ticket 99 remains intact.
- Post-documentation gates are full unit `1822 total / 1774 pass / 48` expected PostgreSQL skips / `0 fail` in
  `35079.8717 ms`; lint; executable/generated OpenAPI; check (`422` JS / `211` handlers / `126` names); build (`485`
  assets / `645.6 KB` shell JS / `12` lazy chunks); dedicated EGE, full and adaptive Chromium; secrets `1193`;
  history `312`; and diff-check. Performance operational metrics pass at LCP `300 ms`, CLS `0`, INP `96 ms`, AI
  `50 ms`, overview `107 ms` and preview `41 ms`; only the inherited initial-JS baseline remains `181.5 KB > 150
  KB`. The scoped candidate is ready for a new strict raw-byte allowlist freeze and two fresh independent reviews.
- The sixth-final review closed five remaining authority/retention/contract gaps. The first grouped RED was `121`
  total / `68` pass / `48` expected PostgreSQL skips / `5` fail across stale pre-lock claim time, impossible oral
  stage input, frozen semantic/pronunciation replay and terminal journal cleanup; one test-only runner fixture was
  corrected without production changes, after which the dedicated runner exposed the intended `26/25/1` WAV
  cleanup failure (`0` removed versus two queued). A later executable-OAS RED `0/1` proved a completed attempt could
  still contain a pending speaking assessment. Production now samples file time only inside the owner queue and
  PostgreSQL `clock_timestamp()` only after the owner lock; exact already-frozen semantic and pronunciation results
  replay without subscription/consent renewal or provider work, while every new/recoverable claim still crosses the
  current post-lock authorization boundary. Terminal reconciliation checks every queued completion and deletes each
  local WAV absent from the authoritative ledger. HTTP validation shares the exact task-specific response/duration
  contract, and OpenAPI discriminates speaking items, assessment/result state and terminal attempt/result shapes.
- Final focused GREEN is `142` total / `94` pass / `48` expected PostgreSQL skips / `0` fail. Full non-PostgreSQL
  verification is `1823 total / 1775 pass / 48` expected PostgreSQL skips / `0 fail` in `36102.6334 ms`; lint,
  generated/executable OpenAPI, check (`422` JS / `211` handlers / `126` names), build (`485` assets / `645.6 KB`
  shell JS / `12` lazy chunks), dedicated EGE, full sequential and adaptive Chromium, secrets `1193`, history `312`,
  diff-check and the freshly authorized production audit (`0 vulnerabilities`) are green. Performance passes LCP
  `316 ms`, CLS `0`, INP `96 ms`, AI `44 ms`, overview `100 ms` and preview `40 ms`; only the inherited initial-JS
  baseline remains `181.5 KB > 150 KB`. Fresh disposable project `easyboost-postgres-integration-24028` applied
  migrations `001–055` and passed literal `48/48` in `13548.6759 ms`; Compose removed its container, volume and
  network, and independent exact project-label filters are empty. Docker is stopped with pipe absent. No provider/
  paid call, install, push, deploy or Ticket 06 occurred; Ticket 99 remains the explicit verified-bank expansion
  reminder. Ticket 05 stays `in-progress` for post-documentation gates, strict freeze, fresh literal ZERO×2,
  metadata closeout and the sole coordinator-held commit.
- The final post-documentation rerun is full unit `1823 total / 1775 pass / 48` expected PostgreSQL skips / `0`
  fail in `34909.5975 ms`; lint; generated/executable OpenAPI; check (`422` JS / `211` handlers / `126` names);
  build (`485` assets / `645.6 KB` shell JS / `12` lazy chunks); dedicated EGE, full sequential and adaptive
  Chromium; secrets `1193`; history `312`; and diff-check. Performance operational metrics pass at LCP `320 ms`,
  CLS `0`, INP `104 ms`, AI `51 ms`, overview `117 ms` and preview `40 ms`; only the inherited first-load JS
  baseline remains `181.5 KB > 150 KB`. No service, Docker or provider process remains running; the candidate is
  ready for a new strict complete allowlist freeze and two fresh independent reviews.
- Final7 independent Standards and Spec reviews both returned literal `ZERO_FINDINGS` on the identical frozen
  `59`-path candidate. Each independently reproduced PRE=POST with `59` unique paths, `0` missing,
  `4,436,814` raw bytes and SHA-256 `d3bf82bddcd00a7288167eab8ea8865b1e13884c8d0d01bd8a462299aef07679`;
  HEAD/base/merge-base were all `cf6b15cc725ed4d580d5bba1aa0d96feedd7b9b4` and the candidate index was
  empty. Ticket 05 is complete; the single local commit remains coordinator-held, and Ticket 06 was not started.
